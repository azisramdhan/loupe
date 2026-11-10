const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { publish, marker, BRANCH } = require('../src/publish.cjs');
const { GitHub } = require('../src/github.cjs');

const repository = 'azisramdhan/WebKitDemo';
const run_entries = body => [...body.matchAll(/<code>(\/farm [a-z-]+)<\/code>/g)].map(m => m[1]);
const sha = 'a'.repeat(40);
const DEV = { deviceSlug: 'iphone-a' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1sAAAAASUVORK5CYII=', 'base64');

function screenshot(t, name = 'login.png') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, png);
  return file;
}

// Minimal GitHub stand-in holding branch refs, blobs and PR comments.
function server({ branchExists = true, comments = [], files = {} } = {}) {
  const state = { comments: [...comments], files: { ...files }, deleted: [], created: 0, updated: 0, branches: branchExists ? [BRANCH] : [], calls: [] };
  let nextId = 900;
  const api = new GitHub('token', async (url, options) => {
    const route = url.replace('https://api.github.com', '');
    const body = options.body ? JSON.parse(options.body) : null;
    state.calls.push(`${options.method} ${route.split('?')[0]}`);
    const json = value => ({ ok: true, status: 200, json: async () => value });
    const missing = { ok: false, status: 404, json: async () => ({}) };

    if (route.startsWith('/repos/' + repository + '/git/ref/heads/')) {
      const name = decodeURIComponent(route.split('/heads/')[1]);
      return state.branches.includes(name) || name === 'main' ? json({ object: { sha: 'base' } }) : missing;
    }
    if (route === `/repos/${repository}/git/refs` && options.method === 'POST') {
      state.branches.push(body.ref.replace('refs/heads/', '')); return json({});
    }
    if (route.startsWith(`/repos/${repository}/contents/`)) {
      const file = decodeURIComponent(route.split('/contents/')[1].split('?')[0]);
      if (options.method === 'GET') return state.files[file] ? json({ sha: state.files[file].sha }) : missing;
      if (options.method === 'DELETE') {
        if (!body.sha) throw new Error('delete without blob sha would 409');
        state.deleted.push(file); delete state.files[file]; return json({});
      }
      const existed = !!state.files[file];
      if (existed && !body.sha) throw new Error('update without blob sha would 409');
      state.files[file] = { sha: `blob-${Object.keys(state.files).length}`, content: body.content };
      state.files[file].overwritten = existed;
      return json({});
    }
    if (route.startsWith(`/repos/${repository}/issues/`) && route.includes('/comments') && options.method === 'GET') {
      return json(state.comments);
    }
    if (route.endsWith('/comments') && options.method === 'POST') {
      state.created++;
      const comment = { id: ++nextId, body: body.body, html_url: `https://github.com/${repository}/pull/1#issuecomment-${nextId}` };
      state.comments.push(comment); return json(comment);
    }
    if (route.includes('/issues/comments/') && options.method === 'PATCH') {
      state.updated++;
      const id = Number(route.split('/issues/comments/')[1]);
      const comment = state.comments.find(c => c.id === id);
      comment.body = body.body; return json(comment);
    }
    return missing;
  });
  return { api, state };
}

test('the first capture for a commit creates one comment and one image', async t => {
  const { api, state } = server({ branchExists: false });
  const run = { ...DEV, id: '1', repository, sha, pr: 1, parameter: 'main', screen: { id: 'login', name: 'Login' }, screenshot: screenshot(t) };
  await publish(api, run, []);
  assert.equal(state.created, 1);
  assert.equal(state.updated, 0);
  assert.ok(state.branches.includes(BRANCH), 'artifact branch is created on demand');
  assert.deepEqual(Object.keys(state.files), [`${sha}/iphone-a/login.png`]);
  assert.equal(run.artifactUrl, `https://raw.githubusercontent.com/${repository}/${BRANCH}/${sha}/iphone-a/login.png`);
  assert.match(state.comments[0].body, new RegExp(marker(sha)));
  assert.match(state.comments[0].body, /\/farm main/);
});

test('re-running the same screen updates the comment and overwrites the image, never duplicating', async t => {
  const { api, state } = server();
  // A repeat always arrives as a NEW comment, so the retry carries a different run id.
  const first = { ...DEV, id: '1', createdAt: '2026-11-03T10:00:00Z', repository, sha, pr: 1, parameter: 'main', screen: { id: 'login', name: 'Login' }, screenshot: screenshot(t) };
  await publish(api, first, []);
  const retry = { ...DEV, id: '2', createdAt: '2026-11-03T10:05:00Z', repository, sha, pr: 1, parameter: 'main', screen: { id: 'login', name: 'Login' }, screenshot: screenshot(t) };
  await publish(api, retry, [first, retry]);
  assert.equal(state.created, 1, 'a retry must not create a second comment');
  assert.equal(state.updated, 1, 'it edits the existing one instead');
  assert.equal(state.comments.length, 1);
  assert.deepEqual(Object.keys(state.files), [`${sha}/iphone-a/login.png`], 'one path per screen per commit');
  assert.equal(state.files[`${sha}/iphone-a/login.png`].overwritten, true);
  assert.equal((state.comments[0].body.match(/<details/g) || []).length, 1, 'one entry, not two');
  assert.equal(run_entries(state.comments[0].body).filter(e => e.includes('main')).length, 1);
});

test('the newest run wins per screen when several runs captured the same screen', async t => {
  const { api, state } = server();
  const older = { ...DEV, id: '1', createdAt: '2026-11-03T10:00:00Z', finishedAt: '2026-11-03T10:00:30Z', repository, sha, pr: 1,
    parameter: 'local-demo', screen: { id: 'local-demo', name: 'Local HTML demo' }, screenshot: screenshot(t), artifactUrl: 'https://old/local-demo.png' };
  const legacy = { ...DEV, id: '2', createdAt: '2026-11-03T10:02:00Z', finishedAt: '2026-11-03T10:02:30Z', repository, sha, pr: 1,
    parameter: 'legacy', screen: { id: 'legacy', name: 'Legacy info' }, screenshot: screenshot(t, 'legacy.png'), artifactUrl: 'https://old/legacy.png' };
  const newer = { ...DEV, id: '3', createdAt: '2026-11-03T10:09:00Z', repository, sha, pr: 1,
    parameter: 'local-demo', screen: { id: 'local-demo', name: 'Local HTML demo' }, screenshot: screenshot(t, 'local-demo.png') };
  await publish(api, newer, [older, legacy, newer]);
  const entries = run_entries(state.comments[0].body);
  assert.equal(entries.length, 2, 'two screens, not three entries');
  assert.deepEqual(entries.sort(), ['/farm legacy', '/farm local-demo']);
  assert.match(state.comments[0].body, new RegExp(`${BRANCH}/${sha}/iphone-a/local-demo.png`), 'the fresh upload replaces the stale URL');
  assert.ok(!state.comments[0].body.includes('https://old/local-demo.png'));
  assert.match(state.comments[0].body, /https:\/\/old\/legacy\.png/, 'an untouched screen keeps its existing image');
});

test('a second screen on the same commit joins the same comment as a gallery', async t => {
  const { api, state } = server();
  const login = { ...DEV, id: '1', repository, sha, pr: 1, parameter: 'main', screen: { id: 'login', name: 'Login' }, screenshot: screenshot(t) };
  await publish(api, login, []);
  const legacy = { ...DEV, id: '2', repository, sha, pr: 1, parameter: 'legacy', screen: { id: 'legacy', name: 'Legacy info' }, screenshot: screenshot(t, 'legacy.png') };
  await publish(api, legacy, [login]);
  assert.equal(state.created, 1);
  assert.equal(state.updated, 1);
  assert.equal((state.comments[0].body.match(/<details/g) || []).length, 2);
  assert.match(state.comments[0].body, /\/farm main/);
  assert.match(state.comments[0].body, /\/farm legacy/);
  assert.deepEqual(Object.keys(state.files).sort(), [`${sha}/iphone-a/legacy.png`, `${sha}/iphone-a/login.png`]);
});

test('a screen captured in parts uploads every part and shows them in one entry', async t => {
  const { api, state } = server();
  const dir = path.dirname(screenshot(t));
  for (const name of ['local-demo.png', 'local-demo-2.png', 'local-demo-3.png']) fs.writeFileSync(path.join(dir, name), png);
  const run = { ...DEV, id: '1', repository, sha, pr: 1, parameter: 'local-demo', screen: { id: 'local-demo', name: 'Local HTML demo' },
    screenshots: ['local-demo.png', 'local-demo-2.png', 'local-demo-3.png'].map(n => path.join(dir, n)) };
  run.screenshot = run.screenshots[0];
  await publish(api, run, []);
  assert.deepEqual(Object.keys(state.files).sort(), [`${sha}/iphone-a/local-demo-2.png`, `${sha}/iphone-a/local-demo-3.png`, `${sha}/iphone-a/local-demo.png`]);
  assert.equal(run.artifactUrls.length, 3);
  assert.equal(run.artifactUrl, run.artifactUrls[0], 'the first part stays the headline image');
  assert.equal(state.created, 1, 'parts share one comment entry, not one comment each');
  assert.equal((state.comments[0].body.match(/<details/g) || []).length, 1);
  assert.equal((state.comments[0].body.match(/<img /g) || []).length, 3);
  assert.match(state.comments[0].body, /3 parts/);
});

test('a rerun with fewer parts clears the parts it no longer produces', async t => {
  const dir = path.dirname(screenshot(t));
  for (const name of ['local-demo.png', 'local-demo-2.png', 'local-demo-3.png']) fs.writeFileSync(path.join(dir, name), png);
  const { api, state } = server();
  const screen = { id: 'local-demo', name: 'Local HTML demo' };
  const tall = { ...DEV, id: '1', repository, sha, pr: 1, parameter: 'local-demo', screen,
    screenshots: ['local-demo.png', 'local-demo-2.png', 'local-demo-3.png'].map(n => path.join(dir, n)) };
  tall.screenshot = tall.screenshots[0];
  await publish(api, tall, []);
  assert.equal(Object.keys(state.files).length, 3);

  const short = { ...DEV, id: '2', repository, sha, pr: 1, parameter: 'local-demo', screen,
    screenshots: [path.join(dir, 'local-demo.png')], screenshot: path.join(dir, 'local-demo.png') };
  await publish(api, short, [tall, short]);
  assert.deepEqual(Object.keys(state.files), [`${sha}/iphone-a/local-demo.png`], 'the extra parts are gone from the branch');
  assert.deepEqual(state.deleted, [`${sha}/iphone-a/local-demo-2.png`, `${sha}/iphone-a/local-demo-3.png`]);
  assert.equal((state.comments[0].body.match(/<img /g) || []).length, 1);
  assert.equal(state.created, 1);
});

test('another screen on the same commit is never swept away', async t => {
  const dir = path.dirname(screenshot(t));
  fs.writeFileSync(path.join(dir, 'legacy-2.png'), png);
  fs.writeFileSync(path.join(dir, 'local-demo.png'), png);
  const { api, state } = server({ files: { [`${sha}/iphone-a/legacy-2.png`]: { sha: 'kept' } } });
  const run = { ...DEV, id: '1', repository, sha, pr: 1, parameter: 'local-demo', screen: { id: 'local-demo', name: 'Local HTML demo' },
    screenshots: [path.join(dir, 'local-demo.png')], screenshot: path.join(dir, 'local-demo.png') };
  await publish(api, run, []);
  assert.ok(state.files[`${sha}/iphone-a/legacy-2.png`], 'the sweep is scoped to this run screen');
  assert.deepEqual(state.deleted, []);
});

test('the same screen on two devices is two entries, not one replacing the other', async t => {
  const { api, state } = server();
  const screen = { id: 'login', name: 'Login' };
  const onA = { id: '1', deviceSlug: 'iphone-a', repository, sha, pr: 1, parameter: 'main', screen, screenshot: screenshot(t) };
  await publish(api, onA, []);
  const onB = { id: '2', deviceSlug: 'iphone-b', repository, sha, pr: 1, parameter: 'main', screen, screenshot: screenshot(t) };
  await publish(api, onB, [onA, onB]);
  assert.equal(state.created, 1, 'still one comment for the commit');
  assert.equal((state.comments[0].body.match(/<details/g) || []).length, 2, 'one entry per device');
  assert.match(state.comments[0].body, /iphone-a/);
  assert.match(state.comments[0].body, /iphone-b/);
  assert.deepEqual(Object.keys(state.files).sort(),
    [`${sha}/iphone-a/login.png`, `${sha}/iphone-b/login.png`],
    'each device writes into its own folder');
});

test('a different commit gets its own comment instead of overwriting the first', async t => {
  const { api, state } = server();
  const other = 'b'.repeat(40);
  await publish(api, { ...DEV, id: '1', repository, sha, pr: 1, parameter: 'main', screen: { id: 'login', name: 'Login' }, screenshot: screenshot(t) }, []);
  await publish(api, { ...DEV, id: '2', repository, sha: other, pr: 1, parameter: 'main', screen: { id: 'login', name: 'Login' }, screenshot: screenshot(t) }, []);
  assert.equal(state.created, 2);
  assert.equal(state.comments.length, 2);
  assert.match(state.comments[0].body, new RegExp(marker(sha)));
  assert.match(state.comments[1].body, new RegExp(marker(other)));
});

test('unrelated human comments on the PR are never edited', async t => {
  const human = { id: 5, body: 'Looks good, but please check /farm main again', html_url: 'x' };
  const { api, state } = server({ comments: [human] });
  await publish(api, { ...DEV, id: '1', repository, sha, pr: 1, parameter: 'main', screen: { id: 'login', name: 'Login' }, screenshot: screenshot(t) }, []);
  assert.equal(state.updated, 0);
  assert.equal(state.created, 1);
  assert.equal(state.comments[0].body, 'Looks good, but please check /farm main again');
});

test('a lost comment-create response is reconciled without a second comment', async t => {
  const { retryPublication } = require('../src/retry.cjs');
  const { api, state } = server();
  const create = api.createComment.bind(api);
  api.createComment = async (...args) => { await create(...args); throw new TypeError('fetch failed'); };
  const run = { ...DEV, id: 'retry', repository, sha, pr: 1, parameter: 'main', screen: { id: 'login', name: 'Login' }, screenshot: screenshot(t) };
  await retryPublication(() => publish(api, run, []), () => {}, async () => {});
  assert.equal(state.created, 1);
  assert.equal(state.updated, 1);
  assert.equal(state.comments.length, 1);
  assert.ok(run.resultCommentUrl);
});
