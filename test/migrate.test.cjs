const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrate } = require('../src/migrate.cjs');

function support(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function legacyInstall(root, name = 'device-farm-desktop') {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'repositories', 'azisramdhan', 'WebKitDemo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{"udid":"KEEP"}');
  fs.writeFileSync(path.join(dir, 'credential.json'), '"encrypted"');
  fs.writeFileSync(path.join(dir, 'repositories', 'azisramdhan', 'WebKitDemo', 'runs.json'), '{"runs":[1,2,3]}');
  return dir;
}

test('renaming the app carries settings and run history across', t => {
  const root = support(t);
  legacyInstall(root);
  const fresh = path.join(root, 'Loupe');
  const result = migrate(fresh, 'device-farm-desktop');
  assert.deepEqual(result.carried.sort(), ['config.json', 'repositories']);
  assert.equal(fs.readFileSync(path.join(fresh, 'config.json'), 'utf8'), '{"udid":"KEEP"}');
  assert.equal(fs.readFileSync(path.join(fresh, 'repositories', 'azisramdhan', 'WebKitDemo', 'runs.json'), 'utf8'), '{"runs":[1,2,3]}');
});

test('the credential is left behind, because safeStorage keys it to the app name', t => {
  const root = support(t);
  legacyInstall(root);
  const fresh = path.join(root, 'Loupe');
  migrate(fresh, 'device-farm-desktop');
  assert.equal(fs.existsSync(path.join(fresh, 'credential.json')), false,
    'copying it would only produce a file that can never be decrypted');
});

test('the old folder is copied, not emptied, so a downgrade still works', t => {
  const root = support(t);
  const legacy = legacyInstall(root);
  migrate(path.join(root, 'Loupe'), 'device-farm-desktop');
  assert.ok(fs.existsSync(path.join(legacy, 'config.json')));
  assert.ok(fs.existsSync(path.join(legacy, 'credential.json')));
});

test('an install that already has settings is never overwritten', t => {
  const root = support(t);
  legacyInstall(root);
  const fresh = path.join(root, 'Loupe');
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(fresh, 'config.json'), '{"udid":"MINE"}');
  assert.equal(migrate(fresh, 'device-farm-desktop'), null);
  assert.equal(fs.readFileSync(path.join(fresh, 'config.json'), 'utf8'), '{"udid":"MINE"}');
});

test('a first install with nothing to carry does nothing', t => {
  const root = support(t);
  const fresh = path.join(root, 'Loupe');
  assert.equal(migrate(fresh, 'device-farm-desktop'), null);
  assert.equal(fs.existsSync(fresh), false, 'no empty folder is created for nothing');
});

test('a legacy name equal to the current one is not copied onto itself', t => {
  const root = support(t);
  legacyInstall(root, 'Loupe');
  assert.equal(migrate(path.join(root, 'Loupe'), 'Loupe'), null);
});
