const fs = require('node:fs/promises');
const path = require('node:path');

const BRANCH = 'loupe-artifacts';
const MAX_PARTS = 6;
const marker = sha => `<!-- loupe:${sha} -->`;
const folder = run => run.deviceSlug || 'device';
const label = run => (run.deviceSlug || '').trim();

function buildBody(sha, runs) {
  const short = sha.slice(0, 7);
  const lines = [marker(sha), '', `**Loupe** — screenshots for commit \`${short}\``, ''];
  for (const run of runs) {
    const urls = run.artifactUrls?.length ? run.artifactUrls : [run.artifactUrl];
    const parts = urls.length > 1 ? ` — ${urls.length} parts` : '';
    const on = label(run) ? ` · ${label(run)}` : '';
    lines.push(`<details open><summary><code>/farm ${run.parameter}</code> → ${run.screen.name}${on}${parts}</summary>`, '',
      urls.map((url, i) => `<img src="${url}" width="280" alt="${run.screen.name}${urls.length > 1 ? ` part ${i + 1}` : ''}">`).join(' '),
      '', '</details>', '');
  }
  lines.push('<sub>One comment per commit, updated in place. Captured locally through Appium.</sub>');
  return lines.join('\n');
}

async function ensureBranch(github, repository, defaultBranch) {
  if (await github.getOrNull(`/repos/${repository}/git/ref/heads/${encodeURIComponent(BRANCH)}`)) return;
  const base = await github.defaultBranchSha(repository, defaultBranch);
  await github.createBranch(repository, BRANCH, base.object.sha);
}

async function publish(github, run, siblings) {
  const local = run.screenshots?.length ? run.screenshots : [run.screenshot];
  await ensureBranch(github, run.repository, 'main');
  run.artifactUrls = [];
  for (const file of local) {
    const bytes = await fs.readFile(file);
    const filePath = `${run.sha}/${folder(run)}/${path.basename(file)}`;
    await github.putFile(run.repository, BRANCH, filePath, bytes.toString('base64'),
      `Loupe: ${path.basename(file)} at ${run.sha.slice(0, 7)}`);
    run.artifactUrls.push(`https://raw.githubusercontent.com/${run.repository}/${BRANCH}/${filePath}`);
  }
  run.artifactUrl = run.artifactUrls[0];

  for (let part = local.length + 1; part <= MAX_PARTS; part++) {
    const stale = `${run.sha}/${folder(run)}/${run.screen.id}-${part}.png`;
    if (!await github.deleteFile(run.repository, BRANCH, stale, `Loupe: drop stale ${path.basename(stale)}`)) break;
  }

  const stamp = r => r.finishedAt || r.startedAt || r.createdAt || '';
  const newest = new Map();
  const key = r => `${r.screen.id}@${folder(r)}`;
  for (const r of siblings.filter(r => r.sha === run.sha && r.pr === run.pr && r.artifactUrl && r.screen)) {
    const held = newest.get(key(r));
    if (!held || stamp(r) >= stamp(held)) newest.set(key(r), r);
  }
  newest.set(key(run), run);
  const gallery = [...newest.values()].sort((a, b) => key(a).localeCompare(key(b)));
  const body = buildBody(run.sha, gallery);

  const existing = (await github.issueComments(run.repository, run.pr)).find(c => c.body?.includes(marker(run.sha)));
  const result = existing
    ? await github.updateComment(run.repository, existing.id, body)
    : await github.createComment(run.repository, run.pr, body);
  run.resultCommentId = result.id;
  run.resultCommentUrl = result.html_url;
  return run;
}

module.exports = { publish, buildBody, BRANCH, marker };
