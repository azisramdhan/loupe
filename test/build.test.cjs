const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureBuild, buildAndRegister, checkoutFor } = require('../src/build.cjs');
const { writeJSON } = require('../src/storage.cjs');
const { projects } = require('../src/catalog.cjs');
const project = projects[0];

const sha = 'a'.repeat(40);
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

// Stands in for git/xcodegen/xcodebuild; the last step materialises the .app the real build would.
function recorder(dir, { fail } = {}) {
  const calls = [];
  return { calls, exec: async (command, args) => {
    calls.push(command === 'git' ? `git ${args.includes('-C') ? args[2] : args[0]}` : command);
    if (fail === command) throw new Error(`${command} exited 65. the real failure line`);
    if (command === 'xcodebuild') {
      const derived = args[args.indexOf('-derivedDataPath') + 1];
      fs.mkdirSync(path.join(derived, 'Build', 'Products', 'Debug-iphonesimulator', 'WebKitDemo.app'), { recursive: true });
    }
  } };
}

test('a registered build with its app still present is reused without touching any tool', async t => {
  const dir = temporary(t);
  const appPath = path.join(dir, 'WebKitDemo.app');
  fs.mkdirSync(appPath);
  writeJSON(path.join(dir, `${sha}.json`), { repository: project.repository, sha, appId: project.appId, appPath });
  const { calls, exec } = recorder(dir);
  const result = await ensureBuild(project, sha, { buildDirectory: dir }, () => {}, exec);
  assert.equal(result.built, false);
  assert.equal(result.manifest.appPath, appPath);
  assert.deepEqual(calls, [], 'nothing is built when the app is already there');
});

test('a manifest whose app was deleted rebuilds instead of failing at the device', async t => {
  const dir = temporary(t);
  const checkout = path.join(dir, 'checkout');
  fs.mkdirSync(path.join(checkoutFor(project, { checkoutDirectory: checkout }), '.git'), { recursive: true });
  writeJSON(path.join(dir, `${sha}.json`), { repository: project.repository, sha, appId: project.appId, appPath: path.join(dir, 'gone.app') });
  const { calls, exec } = recorder(dir);
  const result = await ensureBuild(project, sha, { buildDirectory: dir, checkoutDirectory: checkout }, () => {}, exec);
  assert.equal(result.built, true);
  assert.ok(fs.existsSync(result.manifest.appPath));
  assert.ok(calls.includes('xcodebuild'));
});

test('a missing build clones, pins the commit, generates and builds, then registers the manifest', async t => {
  const dir = temporary(t);
  const checkout = path.join(dir, 'checkout');
  const steps = [];
  const { calls, exec } = recorder(dir);
  const manifest = await buildAndRegister(project, sha, { buildDirectory: dir, checkoutDirectory: checkout }, s => steps.push(s), exec);
  assert.deepEqual(calls, ['git clone', 'git fetch', 'git checkout', 'xcodegen', 'xcodebuild']);
  assert.equal(manifest.sha, sha);
  assert.equal(manifest.repository, project.repository);
  assert.equal(manifest.appId, 'com.azisramdhan.WebKitDemo');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${sha}.json`), 'utf8')), manifest);
  assert.ok(steps.some(s => /Cloning/.test(s)));
  assert.ok(steps.some(s => /takes a few minutes/.test(s)), 'the long step warns about its length');
});

test('an existing checkout is reused rather than cloned again', async t => {
  const dir = temporary(t);
  const checkout = path.join(dir, 'checkout');
  fs.mkdirSync(path.join(checkoutFor(project, { checkoutDirectory: checkout }), '.git'), { recursive: true });
  const { calls, exec } = recorder(dir);
  await buildAndRegister(project, sha, { buildDirectory: dir, checkoutDirectory: checkout }, () => {}, exec);
  assert.ok(!calls.includes('git clone'));
});

test('a compile failure surfaces the real tool output and registers nothing', async t => {
  const dir = temporary(t);
  const checkout = path.join(dir, 'checkout');
  fs.mkdirSync(path.join(checkoutFor(project, { checkoutDirectory: checkout }), '.git'), { recursive: true });
  const { exec } = recorder(dir, { fail: 'xcodebuild' });
  await assert.rejects(() => buildAndRegister(project, sha, { buildDirectory: dir, checkoutDirectory: checkout }, () => {}, exec),
    /xcodebuild exited 65.*the real failure line/);
  assert.equal(fs.existsSync(path.join(dir, `${sha}.json`)), false);
});

test('a malformed SHA never reaches git', async t => {
  const dir = temporary(t);
  const { exec } = recorder(dir);
  for (const bad of ['', 'main', '../escape', 'a'.repeat(39)]) {
    await assert.rejects(() => buildAndRegister(project, bad, { buildDirectory: dir }, () => {}, exec), /40-character commit SHA/);
  }
});

test('parallel commits keep their own app contents and an older commit can be reused', async t => {
  const dir = temporary(t);
  const config = { buildDirectory: dir, checkoutDirectory: path.join(dir, 'checkout') };
  let checkedOut;
  const exec = async (command, args) => {
    if (command === 'git' && args[2] === 'checkout') checkedOut = args.at(-1);
    if (command === 'xcodebuild') {
      await new Promise(resolve => setTimeout(resolve, 15));
      const output = path.join(args[args.indexOf('-derivedDataPath') + 1], 'Build/Products/Debug-iphonesimulator/WebKitDemo.app');
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, 'commit'), checkedOut);
    }
  };
  const second = 'b'.repeat(40);
  const manifests = await Promise.all([sha, second].map(commit => buildAndRegister(project, commit, config, () => {}, exec)));
  assert.notEqual(manifests[0].appPath, manifests[1].appPath);
  for (const manifest of manifests) assert.equal(fs.readFileSync(path.join(manifest.appPath, 'commit'), 'utf8'), manifest.sha);
  const reused = await ensureBuild(project, sha, config, () => {}, async () => assert.fail('must reuse the snapshot'));
  assert.equal(reused.built, false);
  assert.equal(fs.readFileSync(path.join(reused.manifest.appPath, 'commit'), 'utf8'), sha);
});

test('legacy manifests pointing at shared build output are rebuilt', async t => {
  const dir = temporary(t);
  const config = { buildDirectory: dir, checkoutDirectory: path.join(dir, 'checkout') };
  const appPath = path.join(`${checkoutFor(project, config)}-derived`, 'Build/Products/Debug-iphonesimulator/WebKitDemo.app');
  fs.mkdirSync(appPath, { recursive: true });
  writeJSON(path.join(dir, `${sha}.json`), { repository: project.repository, sha, appPath });
  const { exec } = recorder(dir);
  const result = await ensureBuild(project, sha, config, () => {}, exec);
  assert.equal(result.built, true);
  assert.notEqual(result.manifest.appPath, appPath);
});
