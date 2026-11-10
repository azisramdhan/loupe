const GUIDANCE = {
  401: 'Token is invalid or expired. Save a replacement token.',
  403: 'Access denied or rate limited. Posting results also needs Contents and Pull requests write access. Check repository permissions, organization approval, SSO, and API limits.',
  404: 'Repository or endpoint is not accessible to this token. For a fine-grained token, select resource owner azisramdhan, repository WebKitDemo, and Issues + Pull requests read access. Check organization approval and SSO access.',
  422: 'GitHub rejected the request as invalid. The branch or file may have changed since it was read.'
};

class GitHub {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; }
  async request(method, path, body) {
    const headers = { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000), redirect: 'error'
    });
    if (!response.ok) {
      const error = new Error(`GitHub HTTP ${response.status}. ${GUIDANCE[response.status] || 'GitHub request failed. Try again shortly.'}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }
  get(path) { return this.request('GET', path); }
  async getOrNull(path) {
    try { return await this.get(path); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }
  async comments(repo, since) {
    const comments = [];
    for (let page = 1; ; page++) {
      const batch = await this.get(`/repos/${repo}/issues/comments?sort=created&direction=asc&since=${encodeURIComponent(since)}&per_page=100&page=${page}`);
      comments.push(...batch);
      if (batch.length < 100) return comments;
    }
  }
  issue(repo, number) { return this.get(`/repos/${repo}/issues/${number}`); }
  pull(repo, number) { return this.get(`/repos/${repo}/pulls/${number}`); }
  async issueComments(repo, number) {
    const comments = [];
    for (let page = 1; ; page++) {
      const batch = await this.get(`/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
      comments.push(...batch);
      if (batch.length < 100) return comments;
    }
  }
  createComment(repo, number, body) { return this.request('POST', `/repos/${repo}/issues/${number}/comments`, { body }); }
  updateComment(repo, id, body) { return this.request('PATCH', `/repos/${repo}/issues/comments/${id}`, { body }); }
  defaultBranchSha(repo, branch) { return this.get(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`); }
  createBranch(repo, branch, sha) { return this.request('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha }); }
  async deleteFile(repo, branch, filePath, message) {
    const encoded = filePath.split('/').map(encodeURIComponent).join('/');
    const existing = await this.getOrNull(`/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`);
    if (!existing?.sha) return false;
    await this.request('DELETE', `/repos/${repo}/contents/${encoded}`, { message, sha: existing.sha, branch });
    return true;
  }
  async putFile(repo, branch, filePath, base64, message) {
    const encoded = filePath.split('/').map(encodeURIComponent).join('/');
    const existing = await this.getOrNull(`/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`);
    const payload = { message, content: base64, branch };
    if (existing?.sha) payload.sha = existing.sha;
    return this.request('PUT', `/repos/${repo}/contents/${encoded}`, payload);
  }
}
module.exports = { GitHub };
