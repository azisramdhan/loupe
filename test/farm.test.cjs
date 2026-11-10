const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCommand, projects } = require('../src/catalog.cjs');
const project = projects[0];
const { GitHub } = require('../src/github.cjs');
const { Farm } = require('../src/engine.cjs');
const { capture, changed } = require('../src/runner.cjs');
const zlib = require('node:zlib');
const { writeJSON } = require('../src/storage.cjs');
const sha = 'a'.repeat(40);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1sAAAAASUVORK5CYII=', 'base64');
const comment = (overrides = {}) => ({ id: 42, body: '/farm main', user: { login: 'developer', type: 'User' }, author_association: 'MEMBER', issue_url: `https://api.github.com/repos/${project.repository}/issues/12`, created_at: new Date().toISOString(), ...overrides });
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const DEVICE = '17540010-6E73-45DC-B369-97C27E5DFB56';
const cfg = (extra = {}) => ({ devices: [DEVICE], ...extra });
function github(overrides = {}) { return { issue: async () => ({ state: 'open', pull_request: {} }), pull: async () => ({ base: { repo: { full_name: project.repository } }, head: { sha } }), ...overrides }; }
function build(dir) { const appPath = path.join(dir, 'WebKitDemo.app'); fs.mkdirSync(appPath, { recursive: true }); writeJSON(path.join(dir, `${sha}.json`), { sha, repository: project.repository, platform: project.platform, appId: project.appId, appPath }); return appPath; }

// Appium stand-in: every element query matches, so each screen walks its whole recipe.
function appium(calls, overrides = {}) {
  return async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method, body });
    if (overrides[url]) return overrides[url];
    let value = null;
    if (url.endsWith('/session') && options.method === 'POST') value = { sessionId: 'test-session' };
    else if (url.endsWith('/elements')) value = [{ 'element-6066-11e4-a52e-4f735466cecf': `el-${calls.length}` }];
    else if (url.endsWith('/displayed')) value = true;
    else if (url.endsWith('/screenshot')) value = png.toString('base64');
    return { ok: true, json: async () => ({ value }) };
  };
}

test('polling detects a /farm comment, pins the head SHA and queues the named screen', async t => {
  const dir = temporary(t);
  writeJSON(path.join(dir, 'runs.json'), { since: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:00Z', runs: [] });
  const farm = new Farm(dir, github({ comments: async () => [comment({ created_at: '2026-01-02T00:00:00Z' })] }), async () => '/fake.png', cfg());
  t.after(() => farm.stop());
  await farm.start();
  const run = farm.state.runs[0];
  assert.equal(run.parameter, 'main');
  assert.equal(run.screen.id, 'login');
  assert.equal(run.sha, sha);
  assert.match(run.commentUrl, /pull\/12#issuecomment-42$/);
  await farm.pollNow(); assert.equal(farm.state.runs.length, 1);
  assert.ok(farm.state.lastPollAt);
});

test('GitHub fetch paginates and keeps credentials in headers', async () => {
  const urls = [];
  const api = new GitHub('secret', async (url, options) => {
    urls.push(url); assert.equal(options.headers.Authorization, 'Bearer secret');
    assert.ok(!url.includes('secret'));
    return { ok: true, json: async () => urls.length === 1 ? Array(100).fill({ id: 1 }) : [{ id: 101 }] };
  });
  assert.equal((await api.comments(project.repository, '2026-11-03T00:00:00Z')).length, 101);
  assert.match(urls[1], /page=2/);
});

test('rejects unauthorized users, bots, wrong repositories, malformed commands and ordinary issues', async t => {
  const farm = new Farm(temporary(t), github({ issue: async () => ({ state: 'open' }) }), async () => assert.fail('must not capture'), cfg());
  for (const c of [comment({ id: 1, author_association: 'NONE' }), comment({ id: 2, user: { type: 'Bot' } }), comment({ id: 3, issue_url: 'https://api.github.com/repos/other/repo/issues/1' }), comment({ id: 4, body: '/farm main extra' }), comment({ id: 5 })]) await farm.ingest(c, project);
  assert.equal(farm.state.runs.length, 5);
  assert.ok(farm.state.runs.every(r => r.status === 'rejected'));
});

test('deduplicates comment IDs across restart and allows another comment at the same SHA', async t => {
  const dir = temporary(t); const farm = new Farm(dir, github(), async () => '/fake.png', cfg());
  await farm.ingest(comment(), project); await farm.ingest(comment(), project);
  assert.equal(farm.state.runs.length, 1);
  const restored = new Farm(dir, github(), async () => '/fake.png', cfg());
  await restored.ingest(comment(), project); await restored.ingest(comment({ id: 43 }), project);
  assert.equal(restored.state.runs.length, 2);
});

test('transient GitHub failures leave a comment eligible for retry', async t => {
  const farm = new Farm(temporary(t), github({ pull: async () => { throw new Error('offline'); } }), async () => '/fake.png', cfg());
  await assert.rejects(() => farm.ingest(comment(), project), /offline/);
  assert.equal(farm.state.runs.length, 0);
  farm.github = github(); await farm.ingest(comment(), project); assert.equal(farm.state.runs[0].status, 'queued');
});

test('serial device queue, failure isolation and explicit retry preserve the SHA', async t => {
  let busy = false; let first = true; const order = [];
  const farm = new Farm(temporary(t), github(), async run => {
    assert.equal(busy, false); busy = true; order.push(run.id);
    await new Promise(resolve => setTimeout(resolve, 5)); busy = false;
    if (first) { first = false; throw new Error('No build'); }
    return '/fake.png';
  }, cfg());
  await farm.ingest(comment(), project); await farm.ingest(comment({ id: 43 }), project);
  farm.listening = true; await Promise.all([farm.drain(), farm.drain()]);
  assert.deepEqual(order, ['42', '43']); assert.equal(farm.state.runs[0].status, 'failed');
  farm.retry('42'); assert.equal(farm.state.runs[0].sha, sha);
  for (let i = 0; i < 200 && farm.state.runs[0].status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(farm.state.runs[0].status, 'completed'); assert.equal(farm.state.runs[0].sha, sha); farm.stop();
});

test('retry while paused is refused instead of queueing a run nothing will drain', async t => {
  const farm = new Farm(temporary(t), github(), async () => { throw new Error('No build'); }, cfg());
  await farm.ingest(comment(), project);
  farm.listening = true; await farm.drain(); farm.stop();
  assert.equal(farm.state.runs[0].status, 'failed');
  assert.throws(() => farm.retry('42'), /Start listening first/);
  assert.equal(farm.state.runs[0].status, 'failed', 'a refused retry must not change the run');
});

test('starting the listener drains a run queued earlier', async t => {
  const dir = temporary(t);
  writeJSON(path.join(dir, 'runs.json'), { since: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:00Z',
    runs: [{ id: '42', status: 'queued', sha, screen: { id: 'login', name: 'Login' } }] });
  const farm = new Farm(dir, github({ comments: async () => [] }), async () => '/fake.png', cfg());
  t.after(() => farm.stop());
  await farm.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(farm.state.runs[0].status, 'completed');
});

test('first activation ignores historical comments and starts a persistent cursor', async t => {
  const farm = new Farm(temporary(t), github({ comments: async () => [comment({ created_at: '2020-01-01T00:00:00Z' })] }), async () => '/fake.png', cfg());
  await farm.start(); farm.stop(); assert.ok(farm.state.since); assert.equal(farm.state.runs.length, 0);
});

test('interrupted captures become failed instead of silently running twice', t => {
  const dir = temporary(t); writeJSON(path.join(dir, 'runs.json'), { since: null, runs: [{ id: '42', status: 'running' }] });
  const farm = new Farm(dir, github(), async () => '/fake.png', cfg()); assert.equal(farm.state.runs[0].status, 'failed');
});

test('PR comment to PNG: login needs no navigation and the session is always deleted', async t => {
  const dir = temporary(t); const appPath = build(dir);
  const calls = [];
  const config = cfg({ buildDirectory: dir, appiumUrl: 'http://127.0.0.1:4723' });
  const farm = new Farm(dir, github(), (...args) => capture(...args, appium(calls)), config);
  await farm.ingest(comment(), project); farm.listening = true; await farm.drain(); farm.stop();
  const run = farm.state.runs[0];
  assert.equal(run.status, 'completed');
  assert.deepEqual(fs.readFileSync(run.screenshot), png);
  assert.equal(path.basename(run.screenshot), 'login.png');
  const caps = calls[0].body.capabilities.alwaysMatch;
  assert.equal(caps['appium:app'], appPath);
  assert.equal(caps['appium:bundleId'], 'com.azisramdhan.WebKitDemo');
  assert.equal(caps['appium:udid'], DEVICE);
  assert.equal(caps['appium:screenshotQuality'], 0);
  assert.equal(caps['appium:automationName'], 'XCUITest');
  assert.deepEqual(calls.find(c => c.url.endsWith('/elements')).body, { using: 'accessibility id', value: 'Log In' });
  assert.ok(!calls.some(c => c.url.endsWith('/click')));
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('web screen types the demo credentials, taps Log In, then waits for the web view', async t => {
  const dir = temporary(t); build(dir);
  const calls = [];
  const run = { ...parseCommand('/farm web', project), sha, screen: { ...parseCommand('/farm web', project).screen, settleMs: 0 } };
  const config = { buildDirectory: dir, udid: DEVICE, appiumUrl: 'http://127.0.0.1:4723' };
  const files = await capture(run, config, path.join(dir, 'out'), () => {}, appium(calls));
  assert.deepEqual(files.map(f => path.basename(f)), ['web.png'], 'a screen that fits yields one part');
  const queries = calls.filter(c => c.url.endsWith('/elements')).map(c => c.body.value);
  assert.deepEqual(queries.slice(0, 3), ['Username', 'Password', 'Log In']);
  assert.match(queries.at(-1), /XCUIElementTypeWebView/);
  assert.deepEqual(calls.filter(c => c.url.endsWith('/value') && c.method === 'POST').map(c => c.body.text), ['admin', 'password']);
  assert.equal(calls.filter(c => c.url.endsWith('/click')).length, 3);
  assert.match(calls.find(c => c.url.endsWith('/execute/sync')).body.script, /hideKeyboard/);
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('legacy screen walks through the local demo before tapping Legacy', async t => {
  const dir = temporary(t); build(dir);
  const calls = [];
  const parsed = parseCommand('/farm legacy', project);
  const run = { ...parsed, sha, screen: { ...parsed.screen, settleMs: 0 } };
  const files = await capture(run, { buildDirectory: dir, udid: DEVICE, appiumUrl: 'http://127.0.0.1:4723' }, path.join(dir, 'out'), () => {}, appium(calls));
  assert.deepEqual(files.map(f => path.basename(f)), ['legacy.png']);
  const queries = calls.filter(c => c.url.endsWith('/elements')).map(c => c.body.value);
  assert.equal(queries[0], 'Skip to Local HTML Demo');
  assert.match(queries[1], /XCUIElementTypeWebView/);
  assert.equal(queries[2], 'Legacy');
  assert.match(queries[3], /Legacy UIWebView Info/);
  assert.equal(calls.filter(c => c.url.endsWith('/click')).length, 2);
});

// A PNG the capture loop can inflate; CRCs are not checked when comparing frames.
function frame(rows) {
  const raw = Buffer.concat(rows.map(row => Buffer.concat([Buffer.from([0]), Buffer.from(row)])));
  const chunk = (type, body) => Buffer.concat([
    Buffer.from([body.length >>> 24 & 255, body.length >>> 16 & 255, body.length >>> 8 & 255, body.length & 255]),
    Buffer.from(type, 'ascii'), body, Buffer.alloc(4)
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(rows[0].length, 0); ihdr.writeUInt32BE(rows.length, 4);
  ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const rows = (width, height, value) => Array.from({ length: height }, () => new Array(width).fill(value));

test('a frame differing only by antialiasing counts as the same screen', () => {
  const base = rows(200, 200, 120);
  const a = frame(base);
  const nudged = base.map(row => [...row]);
  for (let i = 0; i < 12; i++) nudged[i][i] = 121;
  assert.equal(changed(a, frame(nudged)), false, '12 bytes out of 40000 is noise, not a scroll');
  assert.equal(changed(a, a), false);
});

test('a frame whose content moved counts as a new part', () => {
  const a = frame(rows(200, 200, 120));
  const scrolled = rows(200, 200, 120).map((row, y) => y < 100 ? row.map(() => 200) : row);
  assert.equal(changed(a, frame(scrolled)), true);
  assert.equal(changed(a, Buffer.from('not a png at all')), true, 'an unreadable frame is never treated as identical');
});

test('a screen taller than the display is captured in parts until it stops changing', async t => {
  const dir = temporary(t); build(dir);
  const frames = ['atas', 'tengah', 'bawah'].map(part => {
    const body = Buffer.from(part.padEnd(40, '.'));
    return Buffer.concat([png.subarray(0, 8), body]);
  });
  const calls = [];
  let index = 0;
  const fetcher = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method, body });
    let value = null;
    if (url.endsWith('/session') && options.method === 'POST') value = { sessionId: 's' };
    else if (url.endsWith('/elements')) value = [{ 'element-6066-11e4-a52e-4f735466cecf': 'el' }];
    else if (url.endsWith('/displayed')) value = true;
    else if (url.endsWith('/window/rect')) value = { width: 393, height: 852 };
    else if (url.endsWith('/screenshot')) value = frames[Math.min(index++, frames.length - 1)].toString('base64');
    return { ok: true, json: async () => ({ value }) };
  };
  const parsed = parseCommand('/farm local-demo', project);
  const run = { ...parsed, sha, screen: { ...parsed.screen, settleMs: 0, scrollSettleMs: 0 } };
  const files = await capture(run, { buildDirectory: dir, udid: DEVICE, appiumUrl: 'http://127.0.0.1:4723' }, path.join(dir, 'out'), () => {}, fetcher);
  assert.deepEqual(files.map(f => path.basename(f)), ['local-demo.png', 'local-demo-2.png', 'local-demo-3.png']);
  assert.deepEqual(fs.readFileSync(files[0]), frames[0]);
  assert.deepEqual(fs.readFileSync(files[2]), frames[2]);
  const scrolls = calls.filter(c => c.url.endsWith('/actions'));
  assert.equal(scrolls.length, 3, 'it scrolls between parts and once more to discover the end');
  const gesture = scrolls[0].body.actions[0].actions;
  assert.equal(gesture.filter(a => a.type === 'pointerMove').length, 2);
  const [start, end] = gesture.filter(a => a.type === 'pointerMove');
  assert.ok(end.y < start.y, 'the flick travels upward, scrolling content down');
  assert.ok(end.duration > 0 && end.duration < 400, 'a fast flick, not a long press that selects text');
  assert.ok(start.x > 393 * 0.9, 'it stays on the edge, away from text and buttons');
  assert.equal(fs.existsSync(path.join(dir, 'out', 'local-demo-4.png')), false, 'the repeated frame is not saved');
});

test('a screen that cannot scroll still yields its one visible part', async t => {
  const dir = temporary(t); build(dir);
  const calls = [];
  const base = appium(calls);
  const fetcher = async (url, options) => url.endsWith('/actions')
    ? { ok: false, json: async () => ({ value: { error: 'unsupported', message: 'nothing scrollable' } }) }
    : base(url, options);
  const parsed = parseCommand('/farm local-demo', project);
  const run = { ...parsed, sha, screen: { ...parsed.screen, settleMs: 0, scrollSettleMs: 0 } };
  const files = await capture(run, { buildDirectory: dir, udid: DEVICE, appiumUrl: 'http://127.0.0.1:4723' }, path.join(dir, 'out'), () => {}, fetcher);
  assert.deepEqual(files.map(f => path.basename(f)), ['local-demo.png'], 'a failed scroll ends the capture, it does not fail the run');
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('capture refuses a mismatched manifest, a missing build, a blank UDID and a remote Appium', async t => {
  const dir = temporary(t);
  const run = { ...parseCommand('/farm main', project), sha };
  const never = () => { assert.fail('must not contact device'); };
  await assert.rejects(() => capture(run, { buildDirectory: dir }, dir, () => {}, never), /Build missing/);
  writeJSON(path.join(dir, `${sha}.json`), { sha: 'b'.repeat(40) });
  await assert.rejects(() => capture(run, { buildDirectory: dir }, dir, () => {}, never), /does not match/);
  build(dir);
  await assert.rejects(() => capture(run, { buildDirectory: dir, udid: '  ' }, dir, () => {}, never), /device identifier/);
  await assert.rejects(() => capture(run, { buildDirectory: dir, udid: 'X', appiumUrl: 'http://farm.internal:4723' }, dir, () => {}, never), /loopback/);
  await assert.rejects(() => capture({ ...run, screen: null, parameter: 'unknown' }, { buildDirectory: dir }, dir, () => {}, never), /No capture recipe/);
});

test('a readiness timeout fails the run with the locator that never appeared', async t => {
  const dir = temporary(t); build(dir);
  const calls = [];
  const empty = appium(calls, cfg());
  const fetcher = async (url, options) => url.endsWith('/elements')
    ? (calls.push({ url, method: options.method, body: JSON.parse(options.body) }), { ok: true, json: async () => ({ value: [] }) })
    : empty(url, options);
  const parsed = parseCommand('/farm main', project);
  const run = { ...parsed, sha, screen: { ...parsed.screen, settleMs: 0, readyTimeoutMs: 1200 } };
  const config = { buildDirectory: dir, udid: DEVICE, appiumUrl: 'http://127.0.0.1:4723' };
  const started = Date.now();
  await assert.rejects(() => capture(run, config, path.join(dir, 'out'), () => {}, fetcher), /never appeared.*Log In/s);
  assert.ok(Date.now() - started >= 1200, 'readiness must poll until its deadline');
  assert.ok(calls.filter(c => c.url.endsWith('/elements')).length > 1, 'readiness must retry, not check once');
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('an unreachable or silent Appium produces an actionable message, not "fetch failed"', async t => {
  const dir = temporary(t); build(dir);
  const run = { ...parseCommand('/farm main', project), sha };
  const config = { buildDirectory: dir, udid: DEVICE, appiumUrl: 'http://127.0.0.1:4723' };
  const refused = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(() => capture(run, config, path.join(dir, 'out'), () => {}, refused),
    /Cannot reach Appium at http:\/\/127\.0\.0\.1:4723.*appium --port 4723/s);
  const stalled = async () => { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error; };
  await assert.rejects(() => capture(run, config, path.join(dir, 'out'), () => {}, stalled), /did not respond within \d+s/);
});

test('a non-PNG payload is rejected instead of being saved as a screenshot', async t => {
  const dir = temporary(t); build(dir);
  const calls = [];
  const base = appium(calls);
  const fetcher = async (url, options) => url.endsWith('/screenshot')
    ? { ok: true, json: async () => ({ value: Buffer.from('<html>not a png</html>').toString('base64') }) }
    : base(url, options);
  const parsed = parseCommand('/farm main', project);
  await assert.rejects(() => capture({ ...parsed, sha, screen: { ...parsed.screen, settleMs: 0 } },
    { buildDirectory: dir, udid: DEVICE, appiumUrl: 'http://127.0.0.1:4723' }, path.join(dir, 'out'), () => {}, fetcher), /non-PNG/);
});

test('auto-build runs before capture, and a build failure never reaches the device', async t => {
  const order = [];
  const farm = new Farm(temporary(t), github(), async () => { order.push('capture'); return '/fake.png'; }, cfg({ autoBuild: true }));
  farm.builder = async (_project, s) => { order.push(`build:${s.slice(0, 7)}`); return { built: true }; };
  await farm.ingest(comment(), project); farm.listening = true; await farm.drain(); farm.stop();
  assert.deepEqual(order, [`build:${sha.slice(0, 7)}`, 'capture'], 'the commit is built first');
  assert.equal(farm.state.runs[0].status, 'completed');
  assert.equal(farm.state.runs[0].built, true);

  const broken = new Farm(temporary(t), github(), async () => assert.fail('must not reach the device'), cfg({ autoBuild: true }));
  broken.builder = async () => { throw new Error('xcodebuild exited 65. Swift compile error'); };
  await broken.ingest(comment(), project); broken.listening = true; await broken.drain(); broken.stop();
  assert.equal(broken.state.runs[0].status, 'failed');
  assert.match(broken.state.runs[0].error, /xcodebuild exited 65.*Swift compile error/);
});

test('a commit already built is not rebuilt, and auto-build can be turned off', async t => {
  const reused = new Farm(temporary(t), github(), async () => '/fake.png', cfg({ autoBuild: true }));
  reused.builder = async () => ({ built: false });
  await reused.ingest(comment(), project); reused.listening = true; await reused.drain(); reused.stop();
  assert.equal(reused.state.runs[0].built, false, 'the card shows the build was reused');

  const off = new Farm(temporary(t), github(), async () => '/fake.png', cfg({ autoBuild: false }));
  off.builder = async () => assert.fail('must not build while auto-build is off');
  await off.ingest(comment(), project); off.listening = true; await off.drain(); off.stop();
  assert.equal(off.state.runs[0].status, 'completed');
});

test('publishing is opt-in, and a posting failure never loses the local screenshot', async t => {
  const quiet = new Farm(temporary(t), github(), async () => '/fake.png', cfg());
  quiet.publisher = async () => assert.fail('must not post while publishToPR is off');
  await quiet.ingest(comment(), project); quiet.listening = true; await quiet.drain(); quiet.stop();
  assert.equal(quiet.state.runs[0].status, 'completed');

  const broken = new Farm(temporary(t), github(), async () => '/fake.png', cfg({ publishToPR: true }));
  broken.publisher = async () => { throw new Error('GitHub HTTP 403.'); };
  await broken.ingest(comment(), project); broken.listening = true; await broken.drain(); broken.stop();
  const run = broken.state.runs[0];
  assert.equal(run.status, 'completed', 'the capture still counts as done');
  assert.equal(run.screenshot, '/fake.png');
  assert.match(run.publishError, /saved locally, but posting to the PR failed.*403/);
});

test('a successful publish records the posted comment on the run', async t => {
  const farm = new Farm(temporary(t), github(), async () => '/fake.png', cfg({ publishToPR: true }));
  farm.publisher = async (api, run) => { run.resultCommentUrl = 'https://github.com/x#issuecomment-9'; return run; };
  await farm.ingest(comment(), project); farm.listening = true; await farm.drain(); farm.stop();
  assert.equal(farm.state.runs[0].resultCommentUrl, 'https://github.com/x#issuecomment-9');
  assert.equal(farm.state.runs[0].step, 'Screenshot saved and posted');
  assert.equal(farm.state.runs[0].publishError, undefined);
});

test('a run stays out of completed until publishing settles', async t => {
  const seen = [];
  const farm = new Farm(temporary(t), github(), async () => '/fake.png', cfg({ publishToPR: true }));
  farm.publisher = async () => { seen.push(farm.state.runs[0].status); };
  await farm.ingest(comment(), project); farm.listening = true; await farm.drain(); farm.stop();
  assert.deepEqual(seen, ['publishing'], 'status must not read completed while the post is in flight');
  assert.equal(farm.state.runs[0].status, 'completed');
});

test('a publish interrupted by quitting is reported, not silently counted as posted', t => {
  const dir = temporary(t);
  writeJSON(path.join(dir, 'runs.json'), { since: null, runs: [{ id: '42', status: 'publishing', screenshot: '/fake.png' }] });
  const farm = new Farm(dir, github(), async () => '/fake.png', cfg());
  assert.equal(farm.state.runs[0].status, 'completed');
  assert.match(farm.state.runs[0].publishError, /App stopped before the screenshot reached the pull request/);
  assert.equal(farm.state.runs[0].screenshot, '/fake.png', 'the local PNG is kept');
});

test('pausing the farm finishes one active capture and leaves the next queued', async t => {
  let farm;
  farm = new Farm(temporary(t), github(), async () => { farm.stop(); return '/fake.png'; }, cfg());
  await farm.ingest(comment(), project); await farm.ingest(comment({ id: 43 }), project);
  farm.listening = true; await farm.drain();
  assert.equal(farm.state.runs[0].status, 'completed'); assert.equal(farm.state.runs[1].status, 'queued');
});

test('cleanup failure pauses the listener before a second device session', async t => {
  const farm = new Farm(temporary(t), github(), async () => { const error = new Error('cleanup'); error.code = 'DEVICE_CLEANUP_FAILED'; throw error; }, cfg());
  await farm.ingest(comment(), project); await farm.ingest(comment({ id: 43 }), project);
  farm.listening = true; await farm.drain();
  assert.equal(farm.listening, false); assert.equal(farm.state.runs[0].status, 'failed'); assert.equal(farm.state.runs[1].status, 'queued');
});
