const { test } = require('node:test');
const assert = require('node:assert/strict');
const { available } = require('../src/available.cjs');
test('a simulator counts when it exists; an emulator only when it is running', async () => {
  const ios = await available('ios', async () => ({ stdout: JSON.stringify({ devices: { runtime: [
    { udid: 'ready', state: 'Booted', isAvailable: true },
    { udid: 'off', state: 'Shutdown', isAvailable: true },
    { udid: 'missing', state: 'Booted', isAvailable: false }
  ] } }) }));
  assert.deepEqual(ios, ['ready', 'off'], 'a shut-down simulator is booted by the run, as it is without --all');
  const android = await available('android', async () => ({ stdout: 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nphysical\tdevice\n' }));
  assert.deepEqual(android, ['emulator-5554']);
});
