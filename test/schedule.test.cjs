const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Farm } = require('../src/engine.cjs');
const { projects } = require('../src/catalog.cjs');
const { slug } = require('../src/config.cjs');
const project = projects[0];

const sha = 'a'.repeat(40);
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
const comment = (id, overrides = {}) => ({
  id, body: '/farm main', user: { login: 'developer', type: 'User' }, author_association: 'MEMBER',
  issue_url: `https://api.github.com/repos/${project.repository}/issues/7`, created_at: new Date().toISOString(), ...overrides
});
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function github(head = sha) {
  return { issue: async () => ({ state: 'open', pull_request: {} }),
    pull: async () => ({ base: { repo: { full_name: project.repository } }, head: { sha: head } }) };
}
const TWO = ['17540010-6E73-45DC-B369-97C27E5DFB56', '888FA158-5327-4176-A865-C091453DD497'];

test('two devices work two commands at the same time', async t => {
  let peak = 0, live = 0;
  const farm = new Farm(temporary(t), github(), async () => {
    live++; peak = Math.max(peak, live);
    await tick(20); live--; return '/fake.png';
  }, { devices: TWO });
  await farm.ingest(comment(1), project); await farm.ingest(comment(2), project);
  farm.listening = true; await farm.drain(); farm.stop();
  assert.equal(peak, 2, 'both devices run together rather than one after the other');
  assert.deepEqual(farm.state.runs.map(r => r.status), ['completed', 'completed']);
});

test('each run lands on exactly one device', async t => {
  const farm = new Farm(temporary(t), github(), async run => { await tick(10); return `/${run.id}.png`; }, { devices: TWO });
  for (const id of [1, 2, 3, 4]) await farm.ingest(comment(id), project);
  farm.listening = true; await farm.drain(); farm.stop();
  const assigned = farm.state.runs.map(r => r.device);
  assert.equal(assigned.filter(Boolean).length, 4);
  assert.deepEqual([...new Set(assigned)].sort(), [TWO[0], TWO[1]]);
  assert.equal(new Set(farm.state.runs.map(r => r.id)).size, 4, 'no run is served twice');
});

test('one device still works through its queue in order', async t => {
  const order = [];
  let busy = false;
  const farm = new Farm(temporary(t), github(), async run => {
    assert.equal(busy, false, 'a single device never overlaps itself');
    busy = true; order.push(run.id); await tick(5); busy = false; return '/fake.png';
  }, { devices: [TWO[0]] });
  for (const id of [1, 2, 3]) await farm.ingest(comment(id), project);
  farm.listening = true; await farm.drain(); farm.stop();
  assert.deepEqual(order, ['1', '2', '3']);
});

test('the same commit is built once, however many devices want it', async t => {
  let builds = 0;
  const farm = new Farm(temporary(t), github(), async () => { await tick(15); return '/fake.png'; }, { devices: TWO, autoBuild: true });
  farm.builder = async () => { builds++; await tick(25); return { built: true }; };
  await farm.ingest(comment(1), project); await farm.ingest(comment(2), project);
  farm.listening = true; await farm.drain(); farm.stop();
  assert.equal(builds, 1, 'the second device waits for the build instead of starting its own');
  assert.deepEqual(farm.state.runs.map(r => r.status), ['completed', 'completed']);
});

test('different commits are built separately', async t => {
  const built = [];
  const farm = new Farm(temporary(t), github(), async () => '/fake.png', { devices: TWO, autoBuild: true });
  farm.builder = async (_project, commit) => { built.push(commit); return { built: true }; };
  await farm.ingest(comment(1), project);
  farm.github = github('b'.repeat(40));
  await farm.ingest(comment(2), project);
  farm.listening = true; await farm.drain(); farm.stop();
  assert.deepEqual(built.sort(), [sha, 'b'.repeat(40)].sort());
});

test('a command with no device configured is rejected, not left waiting', async t => {
  const farm = new Farm(temporary(t), github(), async () => assert.fail('must not capture'), { devices: [] });
  await farm.ingest(comment(1), project);
  assert.equal(farm.state.runs[0].status, 'rejected');
  assert.match(farm.state.runs[0].error, /No device is configured/);
});

test('pausing lets busy devices finish and leaves the rest queued', async t => {
  // Hold both devices inside the runner, then pause: nothing new may be claimed.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  let farm;
  farm = new Farm(temporary(t), github(), async run => {
    started.push(run.id);
    if (started.length === 2) { farm.stop(); release(); }
    await gate;
    return '/fake.png';
  }, { devices: TWO });
  for (const id of [1, 2, 3, 4]) await farm.ingest(comment(id), project);
  farm.listening = true; await farm.drain();
  const statuses = farm.state.runs.map(r => r.status);
  assert.equal(started.length, 2, 'exactly the two in flight');
  assert.equal(statuses.filter(s => s === 'completed').length, 2);
  assert.equal(statuses.filter(s => s === 'queued').length, 2, 'the rest wait for the listener');
});

test('a device that fails does not take the other one down', async t => {
  const farm = new Farm(temporary(t), github(), async run => {
    await tick(5);
    if (run.device === TWO[0]) throw new Error('this device is unhappy');
    return '/fake.png';
  }, { devices: TWO });
  for (const id of [1, 2, 3, 4]) await farm.ingest(comment(id), project);
  farm.listening = true; await farm.drain(); farm.stop();
  const byStatus = farm.state.runs.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  assert.ok(byStatus.completed >= 1, 'the healthy device keeps serving');
  assert.ok(byStatus.failed >= 1, 'the unhappy one records its failures');
  assert.equal(byStatus.queued, undefined, 'nothing is stranded');
});

test('the snapshot says which devices are busy', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let inFlight = 0;
  const seen = [];
  const farm = new Farm(temporary(t), github(), async () => {
    if (++inFlight === 2) { seen.push(...farm.snapshot().devices.map(d => `${d.slug}:${d.busy}`)); release(); }
    await gate;
    return '/fake.png';
  }, { devices: TWO });
  await farm.ingest(comment(1), project); await farm.ingest(comment(2), project);
  farm.listening = true; await farm.drain(); farm.stop();
  assert.deepEqual(seen, TWO.map(udid => `${slug(udid)}:true`));
  assert.deepEqual(farm.snapshot().devices.map(d => d.busy), [false, false], 'and idle again when done');
});

test('each device gets its own helper port', async t => {
  const ports = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const farm = new Farm(temporary(t), github(), async (run, config) => {
    ports.push(config.helperPort);
    if (ports.length === 2) release();
    await gate;
    return '/fake.png';
  }, { devices: TWO });
  await farm.ingest(comment(1), project); await farm.ingest(comment(2), project);
  farm.listening = true; await farm.drain(); farm.stop();
  assert.deepEqual(ports.sort(), [8100, 8101], 'two sessions never share one agent port');
});

test('the device udid reaches the runner, not the one in config', async t => {
  const seen = [];
  const farm = new Farm(temporary(t), github(), async (run, config) => { seen.push(config.udid); return '/fake.png'; },
    { devices: TWO, udid: 'STALE-SINGLE-DEVICE' });
  await farm.ingest(comment(1), project); await farm.ingest(comment(2), project);
  farm.listening = true; await farm.drain(); farm.stop();
  assert.deepEqual(seen.sort(), [TWO[0], TWO[1]]);
});

test('--all targets each online configured device once, shares build and serializes publication', async t => {
  let builds = 0, publishing = 0, peak = 0;
  const farm = new Farm(temporary(t), github(), async run => { await tick(10); return `/${run.id}.png`; },
    { devices: [...TWO, 'emulator-5554'], autoBuild: true, publishToPR: true });
  farm.available = async () => TWO;
  farm.builder = async () => { builds++; await tick(10); return { built: true }; };
  farm.publisher = async () => { publishing++; peak = Math.max(peak, publishing); await tick(10); publishing--; };
  await farm.ingest(comment(99, { body: '/farm local-demo --all' }), project);
  await farm.ingest(comment(99, { body: '/farm local-demo --all' }), project);
  assert.equal(farm.state.runs.length, 2);
  farm.listening = true; await farm.drain(); farm.stop();
  assert.deepEqual(farm.state.runs.map(r => r.device), TWO);
  assert.ok(farm.state.runs.every(r => r.status === 'completed'));
  assert.equal(builds, 1);
  assert.equal(peak, 1);
});

test('--all skips unreachable devices and rejects an empty selection', async t => {
  const farm = new Farm(temporary(t), github(), async () => '/fake.png', { devices: TWO });
  farm.available = async () => [TWO[1]];
  await farm.ingest(comment(100, { body: '/farm login --all' }), project);
  assert.equal(farm.state.runs.length, 1);
  assert.equal(farm.state.runs[0].targetDevice, TWO[1]);
  assert.equal(farm.state.runs[0].screen.id, 'login');
  farm.available = async () => [];
  await farm.ingest(comment(101, { body: '/farm login --all' }), project);
  assert.equal(farm.state.runs[1].status, 'rejected');
  assert.match(farm.state.runs[1].error, /simulators exist/);
});

test('history recorded under a truncated identifier is re-keyed on load', async t => {
  const dir = temporary(t);
  fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify({ since: null, startedAt: null, runs: [
    { id: '1', status: 'completed', device: 'emulator-5554', deviceSlug: 'emulator' },
    { id: '2', status: 'completed', device: 'emulator-5556', deviceSlug: 'emulator' }
  ] }));
  const farm = new Farm(dir, github(), async () => '/fake.png', { devices: [] });
  assert.deepEqual(farm.state.runs.map(r => r.deviceSlug), ['emulator-5554', 'emulator-5556'],
    'two devices that once shared a folder must not share a gallery entry');
});

test('a device identifier keys an artifact folder, so none of them may collide', () => {
  const identifiers = ['emulator-5554', 'emulator-5556', 'R5CT80ABCDE1', 'R5CT80ABCDE2', ...TWO];
  assert.equal(new Set(identifiers.map(slug)).size, identifiers.length);
});
