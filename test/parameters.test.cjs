const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCommand, projects } = require('../src/catalog.cjs');
const project = projects[0];
const { Farm } = require('../src/engine.cjs');

test('WebKitDemo names resolve to source-backed screens; main aliases the initial login', () => {
  for (const [parameter, id] of [['main', 'login'], ['login', 'login'], ['web', 'web'], ['local-demo', 'local-demo'], ['legacy', 'legacy']]) {
    const parsed = parseCommand(`/farm ${parameter}`, project);
    assert.equal(parsed.parameter, parameter);
    assert.equal(parsed.screen.id, id);
    assert.equal(parsed.repository, 'azisramdhan/WebKitDemo');
    assert.equal(parsed.appId, 'com.azisramdhan.WebKitDemo');
    assert.ok(parsed.screen.ready.using && parsed.screen.ready.value);
  }
  assert.equal(parseCommand('/farm MAIN', project).parameter, 'MAIN');
  assert.equal(parseCommand('/farm MAIN', project).screen.id, 'login');
  assert.equal(parseCommand('/farm another_screen', project).screen, null);
  assert.equal(parseCommand('/farm another_screen', project).mapping, 'unmapped');
  for (const body of ['/farm main extra', '/farm main;whoami', '/farm ../main', '/farm main\nextra', '/farm https://alfagift.id/main', '/farm ' + 'a'.repeat(65)]) assert.throws(() => parseCommand(body));
  for (const body of ['> /farm main', '```\n/farm main\n```', 'hello /farm main']) assert.equal(parseCommand(body), null);
});

test('every screen navigates from the launch screen with locators the app actually sets', () => {
  const identifiers = ['Username', 'Password', 'Log In', 'Skip to Local HTML Demo', 'Legacy'];
  for (const screen of project.screens) {
    for (const step of screen.steps) {
      assert.ok(['tap', 'type', 'wait', 'dismissKeyboard'].includes(step.action));
      if (step.using === 'accessibility id') assert.ok(identifiers.includes(step.value), `${step.value} is not set in WebKitDemo`);
      if (step.action === 'type') assert.equal(typeof step.text, 'string');
    }
  }
  assert.deepEqual(project.screens.find(s => s.id === 'login').steps, []);
  assert.equal(project.screens.find(s => s.id === 'web').steps.filter(s => s.action === 'type').length, 2);
});

test('received parameters survive persistence and duplicate delivery', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-parameters-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const github = { issue: async () => ({ state: 'open', pull_request: {} }), pull: async () => ({ base: { repo: { full_name: project.repository } }, head: { sha: 'b'.repeat(40) } }) };
  const runner = async () => '/fake.png';
  const farm = new Farm(dir, github, runner, { devices: ['17540010-6E73-45DC-B369-97C27E5DFB56'] });
  const comment = { id: 1, body: '/farm main', author_association: 'OWNER', user: { login: 'azisramdhan', type: 'User' }, issue_url: `https://api.github.com/repos/${project.repository}/issues/1` };
  await farm.ingest(comment, project);
  await farm.ingest({ ...comment, id: 2, body: '/farm custom_screen' }, project);
  const restored = new Farm(dir, github, runner, { devices: ['17540010-6E73-45DC-B369-97C27E5DFB56'] });
  await restored.ingest(comment, project);
  assert.equal(restored.state.runs.length, 2);
  assert.equal(restored.state.runs[0].parameter, 'main');
  assert.equal(restored.state.runs[0].status, 'queued');
  assert.equal(restored.state.runs[1].parameter, 'custom_screen');
  assert.equal(restored.state.runs[1].status, 'rejected');
  assert.match(restored.state.runs[1].error, /not a known command/);
});

test('a screen name is always required, and --all is explicit', () => {
  for (const project of projects) {
    // A bare command used to capture login. Naming the screens teaches more
    // than quietly picking one of them.
    assert.throws(() => parseCommand('/farm', project), /one screen name/);
    assert.throws(() => parseCommand('/farm --all', project), /one screen name/);
    assert.equal(parseCommand('/farm local-demo --all', project).screen.id, 'local-demo');
    assert.equal(parseCommand('/farm local-demo --all', project).allDevices, true);
    assert.equal(parseCommand('/farm login', project).allDevices, false);
    assert.throws(() => parseCommand('/farm login --all --all', project));
  }
});
