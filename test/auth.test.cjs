const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitHub } = require('../src/github.cjs');
const { Farm } = require('../src/engine.cjs');

test('GitHub access errors have actionable guidance without exposing the token', async () => {
  for (const status of [401, 403, 404]) {
    const api = new GitHub('private-secret', async () => ({ ok: false, status }));
    await assert.rejects(() => api.comments('azisramdhan/WebKitDemo', '2026-01-01'), error => {
      assert.equal(error.status, status);
      assert.ok(!error.message.includes('private-secret'));
      if (status === 404) assert.match(error.message, /resource owner azisramdhan/);
      return true;
    });
  }
});

test('access failure pauses polling without consuming the cursor; replacement can resume', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-auth-'));
  const api = new GitHub('private-secret', async () => ({ ok: false, status: 404 }));
  const farm = new Farm(dir, api, async () => assert.fail('no capture'), { triggerOnly: true });
  t.after(() => { farm.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await farm.start();
  assert.equal(farm.listening, false);
  assert.equal(farm.polling, false);
  assert.match(farm.lastError, /GitHub HTTP 404/);
  assert.equal(farm.state.since, farm.state.startedAt);
  farm.github = { comments: async () => [] };
  await farm.start();
  assert.equal(farm.listening, true);
  assert.equal(farm.lastError, null);
});
