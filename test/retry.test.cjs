const { test } = require('node:test');
const assert = require('node:assert/strict');
const { retryPublication } = require('../src/retry.cjs');
const { GitHub } = require('../src/github.cjs');
test('temporary failures back off, then succeed; permanent errors do not retry', async () => {
  let calls = 0; const delays = [];
  const value = await retryPublication(async () => {
    if (++calls < 3) throw new TypeError('fetch failed');
    return 'posted';
  }, () => {}, async ms => delays.push(ms));
  assert.equal(value, 'posted'); assert.deepEqual(delays, [1000, 2000]);
  for (const status of [401, 403, 404, 422]) {
    let attempts = 0;
    await assert.rejects(() => retryPublication(async () => { attempts++; throw Object.assign(new Error('denied'), { status }); }));
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  await assert.rejects(() => retryPublication(async () => { attempts++; throw Object.assign(new Error('unavailable'), { status: 503 }); }, () => {}, async () => {}));
  assert.equal(attempts, 3);
});
test('comment lookup reaches an existing result beyond page one', async () => {
  const api = new GitHub('test', async url => ({ ok: true, json: async () => url.endsWith('page=1') ? Array(100).fill({ body: 'human' }) : [{ body: '<!-- loupe:sha -->' }] }));
  assert.equal((await api.issueComments('owner/repo', 1)).length, 101);
});
