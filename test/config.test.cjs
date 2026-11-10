const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, defaults, RETIRED } = require('../src/config.cjs');

const stored = value => () => value;

test('a one-device install becomes a device list', () => {
  const config = load('/data', stored({ udid: 'OLD-UDID', buildDirectory: '/b' }));
  assert.deepEqual(config.devices, ['OLD-UDID']);
  assert.ok(!('udid' in config), 'the single-device key does not linger beside the list');
});

test('a device list written as objects is reduced to plain identifiers', () => {
  const config = load('/data', stored({ devices: [{ udid: 'A-1', name: 'old name' }, { udid: 'B-2' }] }));
  assert.deepEqual(config.devices, ['A-1', 'B-2'], 'a name the model no longer has does not linger');
});

test('an install with no device at all starts with an empty list', () => {
  assert.deepEqual(load('/data', stored({})).devices, []);
});

test('a config written before a feature existed still gains that feature', () => {
  // The exact shape on disk after the publish release, with no autoBuild key.
  const old = { appiumUrl: 'http://127.0.0.1:4723', udid: 'SOME-UDID', buildDirectory: '/builds', publishToPR: true };
  const config = load('/data', stored(old));
  assert.equal(config.autoBuild, true, 'a new default must reach an existing installation');
  assert.ok(config.checkoutDirectory, 'and so must a new path');
});

test('values the user set are never overwritten by defaults', () => {
  const chosen = { devices: ['MINE'], appiumUrl: 'http://localhost:9999', buildDirectory: '/my/builds', autoBuild: false, publishToPR: true };
  const config = load('/data', stored(chosen));
  assert.deepEqual(config.devices, chosen.devices);
  for (const [key, value] of Object.entries(chosen)) {
    if (key !== 'devices') assert.equal(config[key], value, key);
  }
});

test('a false value survives the merge instead of falling back to the default', () => {
  assert.equal(load('/data', stored({ autoBuild: false })).autoBuild, false);
  assert.equal(load('/data', stored({ publishToPR: false })).publishToPR, false);
});

test('paths that still name the old app are pointed back at the defaults', () => {
  const stale = {
    devices: ['KEEP'],
    buildDirectory: '/Users/me/Library/Application Support/device-farm-desktop/builds',
    checkoutDirectory: '/Users/me/Library/Caches/device-farm-desktop/WebKitDemo'
  };
  const config = load('/data', stored(stale));
  assert.equal(config.buildDirectory, defaults('/data').buildDirectory);
  assert.equal(config.checkoutDirectory, defaults('/data').checkoutDirectory);
  assert.deepEqual(config.devices, ['KEEP'], 'only the stale paths are touched');
});

test('a path the user chose elsewhere is left alone', () => {
  const chosen = { buildDirectory: '/Volumes/Builds/loupe', checkoutDirectory: '/Users/me/src/WebKitDemo' };
  const config = load('/data', stored(chosen));
  assert.equal(config.buildDirectory, '/Volumes/Builds/loupe');
  assert.equal(config.checkoutDirectory, '/Users/me/src/WebKitDemo');
});

test('retired keys are dropped rather than carried forever', () => {
  const config = load('/data', stored({ triggerOnly: true, devices: ['X'] }));
  for (const key of RETIRED) assert.ok(!(key in config), `${key} must not survive`);
  assert.deepEqual(config.devices, ['X']);
});

test('appearance defaults to following the system and survives a save', () => {
  assert.equal(defaults('/data').appearance, 'system', 'macOS appearance is a system setting until told otherwise');
  assert.equal(load('/data', stored({ appearance: 'dark' })).appearance, 'dark');
  assert.equal(load('/data', stored({ devices: [] })).appearance, 'system', 'an older config gains the key');
});

test('a first run with no file on disk gets the full default set', () => {
  assert.deepEqual(load('/data', (_file, fallback) => fallback), defaults('/data'));
  assert.equal(defaults('/data').autoBuild, true);
  assert.equal(defaults('/data').publishToPR, false, 'posting to GitHub stays opt-in');
});
