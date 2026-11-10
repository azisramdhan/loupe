const path = require('node:path');
const { EventEmitter } = require('node:events');
const { parseCommand, projects, projectFor, commandNames, PLATFORM_NAMES } = require('./catalog.cjs');
const { devices: deviceList, slug } = require('./config.cjs');
const { publish } = require('./publish.cjs');
const { retryPublication } = require('./retry.cjs');
const { available } = require('./available.cjs');
const { ensureBuild } = require('./build.cjs');
const { writeJSON, readJSON } = require('./storage.cjs');

class Farm extends EventEmitter {
  constructor(directory, github, runner, config) {
    super();
    this.directory = directory; this.github = github; this.runner = runner; this.config = config;
    this.publisher = publish;
    this.available = available;
    this.publications = new Map();
    this.builder = ensureBuild;
    this.file = path.join(directory, 'runs.json');
    this.state = readJSON(this.file, { since: null, startedAt: null, runs: [] });
    this.listening = false; this.polling = false; this.lastError = null;
    this.busy = new Set();
    this.builds = new Map();
    for (const run of this.state.runs) {
      // A run recorded under an older, truncated identifier would key the gallery
      // differently from a new one on the same device, and the pull request would
      // show the screen twice.
      if (run.device) run.deviceSlug = slug(run.device);
      if (run.status === 'running') { run.status = 'failed'; run.error = 'App stopped during capture. Check Appium and retry.'; }
      if (run.status === 'publishing') { run.status = 'completed'; run.publishError = 'App stopped before the screenshot reached the pull request. The PNG is still here; post the command again to publish it.'; }
    }
    this.save();
  }
  save() { writeJSON(this.file, this.state); this.emit('change'); }
  get running() { return this.busy.size > 0; }
  devices() { return deviceList(this.config); }
  snapshot() {
    return { ...this.state, listening: this.listening, polling: this.polling, running: this.running,
      lastError: this.lastError, devices: this.devices().map(d => ({ ...d, busy: this.busy.has(d.udid) })) };
  }
  async start() {
    if (this.listening) return;
    if (!this.state.since) {
      this.state.since = new Date().toISOString();
      this.state.startedAt = this.state.since;
      this.save();
    }
    this.listening = true; this.emit('change');
    await this.tick();
  }
  stop() { this.listening = false; clearTimeout(this.timer); this.emit('change'); }
  async pollNow() {
    if (!this.listening) throw new Error('Start listening first.');
    if (this.polling) return;
    clearTimeout(this.timer);
    await this.tick();
  }
  async tick() {
    if (!this.listening || this.polling) return;
    this.polling = true; this.emit('change');
    const until = new Date(Date.now() - 2000).toISOString();
    try {
      for (const project of projects) {
        if (!this.listening) break;
        const comments = await this.github.comments(project.repository, this.state.since);
        for (const comment of comments) {
          if (!this.listening) break;
          if (comment.created_at < this.state.startedAt || comment.created_at > until) continue;
          await this.ingest(comment, project);
        }
      }
      if (this.listening) this.state.since = until;
      this.lastError = null; this.state.lastPollAt = new Date().toISOString(); this.save();
    } catch (error) {
      this.lastError = error.message;
      // Stop repeated access failures and allow token replacement immediately.
      if ([401, 403, 404].includes(error.status)) this.stop();
      this.emit('change');
    }
    finally {
      this.polling = false; this.emit('change');
      if (this.listening) { this.drain(); this.timer = setTimeout(() => this.tick(), 60000); }
    }
  }
  async ingest(comment, project) {
    if (!Number.isSafeInteger(comment.id) || this.state.runs.some(r => r.commentId === comment.id)) return;
    if (typeof comment.body !== 'string' || !/^\/farm(?:\s|$)/.test(comment.body.trim())) return;
    const run = { id: String(comment.id), commentId: comment.id, createdAt: new Date().toISOString(),
      author: comment.user?.login, repository: project.repository, status: 'rejected' };
    try {
      if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association) || comment.user?.type === 'Bot') throw new Error('Only repository owners, members and collaborators may run captures.');
      const prefix = `https://api.github.com/repos/${project.repository}/issues/`;
      if (!comment.issue_url?.startsWith(prefix) || !/^\d+$/.test(comment.issue_url.slice(prefix.length))) throw new Error('Comment is not from the configured repository.');
      run.pr = Number(comment.issue_url.slice(prefix.length));
      Object.assign(run, parseCommand(comment.body, project));
    } catch (error) { run.error = error.message; this.state.runs.push(run); this.save(); return; }
    // Network failures must not consume the comment: the next poll retries it.
    const issue = await this.github.issue(run.repository, run.pr);
    if (!issue.pull_request || issue.state !== 'open') run.error = 'Command must be on an open pull request.';
    else {
      const pull = await this.github.pull(run.repository, run.pr);
      if (pull.base?.repo?.full_name?.toLowerCase() !== run.repository.toLowerCase() || !/^[a-f0-9]{40}$/.test(pull.head?.sha || '')) run.error = 'GitHub returned an invalid target repository or commit.';
      else {
        run.sha = pull.head.sha;
        run.commentUrl = `https://github.com/${run.repository}/pull/${run.pr}#issuecomment-${run.commentId}`;
        if (!run.screen) { run.error = `Received parameter "${run.parameter}" is not a known command. Use ${commandNames(project)}.`; }
        else if (!this.devices().length) { run.error = 'No device is configured. Add one in Settings, then post the command again.'; }
        else if (!this.devices().some(device => device.platform === project.platform)) {
          run.error = `${project.repository} needs ${PLATFORM_NAMES[project.platform]}, and no ${PLATFORM_NAMES[project.platform]} device is configured. Add one in Settings, then post the command again.`;
        }
        else { run.status = 'queued'; run.step = `Queued for ${run.screen.name}`; }
      }
    }
    if (run.status === 'queued' && run.allDevices) {
      const online = new Set(await this.available(project.platform));
      const targets = this.devices().filter(d => d.platform === project.platform && online.has(d.udid));
      if (targets.length) {
        for (const device of targets) this.state.runs.push({ ...run,
          id: `${run.id}-${device.udid}`, targetDevice: device.udid });
        this.save(); return;
      }
      run.status = 'rejected';
      run.error = project.platform === 'ios'
        ? 'None of the configured simulators exist on this Mac. Check the UDIDs in Settings, then post the command again.'
        : 'No configured emulator is running. Start one, then post the command again.';
    }
    this.state.runs.push(run); this.save();
  }
  // Serialize uploads for a repository: concurrent captures must not create two
  // result comments or race while creating the shared artifact branch.
  async post(run) {
    const key = run.repository;
    const previous = this.publications.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => retryPublication(
      () => this.publisher(this.github, run, this.state.runs),
      attempt => { run.step = `Retrying publication (${attempt}/2)`; this.save(); }
    ));
    this.publications.set(key, pending);
    try { return await pending; }
    finally { if (this.publications.get(key) === pending) this.publications.delete(key); }
  }
  // One session per device, devices in parallel. A run is claimed before any await,
  // so two devices can never pick up the same one.
  async drain() {
    if (!this.listening) return;
    const taken = { ios: 0, android: 0 };
    await Promise.all(this.devices()
      // A WebDriverAgent port and a UiAutomator2 port are unrelated, so each
      // platform counts its own devices off its own base.
      .map(device => ({ ...device, helperPort: (device.platform === 'android' ? 8200 : 8100) + taken[device.platform]++ }))
      .filter(device => !this.busy.has(device.udid))
      .map(device => this.serve(device)));
  }

  // Two devices asking for the same commit must not build it twice.
  build(project, sha, onStep) {
    const key = `${project.repository}@${sha}`;
    if (!this.builds.has(key)) {
      this.builds.set(key, this.builder(project, sha, this.config, onStep).finally(() => this.builds.delete(key)));
    }
    return this.builds.get(key);
  }

  async serve(device) {
    this.busy.add(device.udid);
    this.emit('change');
    try {
      while (this.listening) {
        // A capture only runs on a device of its own platform.
        const run = this.state.runs.find(r => r.status === 'queued' && (r.platform || 'ios') === device.platform && (!r.targetDevice || r.targetDevice === device.udid));
        if (!run) break;
        run.status = 'running';
        run.device = device.udid;
        run.deviceSlug = device.slug;
        run.startedAt = new Date().toISOString();
        this.save();
        const output = path.join(this.directory, 'artifacts', run.sha, run.id);
        try {
          if (this.config.autoBuild) {
            const { built } = await this.build(projectFor(run.repository), run.sha, step => { run.step = step; this.save(); });
            run.built = built;
          }
          const shots = await this.runner(run, { ...this.config, udid: device.udid, helperPort: device.helperPort }, output, step => { run.step = step; this.save(); });
          run.screenshots = Array.isArray(shots) ? shots : [shots];
          run.screenshot = run.screenshots[0];
          run.step = run.screenshots.length > 1 ? `Screenshot saved in ${run.screenshots.length} parts` : 'Screenshot saved';
          delete run.error;
          if (this.config.publishToPR) {
            run.status = 'publishing'; run.step = 'Posting the screenshot to the pull request'; this.save();
            try { await this.post(run); run.step = 'Screenshot saved and posted'; delete run.publishError; }
            catch (error) { run.publishError = `Screenshot saved locally, but posting to the PR failed. ${error.message}`; run.step = 'Screenshot saved'; }
          }
          run.status = 'completed';
        } catch (error) {
          run.status = 'failed'; run.error = error.message;
          if (error.code === 'DEVICE_CLEANUP_FAILED') this.stop();
        }
        run.finishedAt = new Date().toISOString();
        writeJSON(path.join(output, 'run.json'), run); this.save();
      }
    } finally { this.busy.delete(device.udid); this.emit('change'); }
  }
  retry(id) {
    const run = this.state.runs.find(r => r.id === id);
    if (!run || run.status !== 'failed' || !run.screen) throw new Error('Only a failed run with a known command can be retried.');
    if (!this.listening) throw new Error('Start listening first. A retry only runs while the listener is active.');
    run.status = 'queued'; run.step = 'Retry queued for the same commit'; delete run.error;
    this.save(); this.drain();
  }
}
module.exports = { Farm };
