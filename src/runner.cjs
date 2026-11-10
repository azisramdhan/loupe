const fs = require('node:fs/promises');
const zlib = require('node:zlib');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WEB_ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SAME_FRAME = 0.002;

function scanlines(png) {
  const parts = [];
  for (let pos = 8; pos + 12 <= png.length; ) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') parts.push(png.subarray(pos + 8, pos + 8 + length));
    if (type === 'IEND') break;
    pos += 12 + length;
  }
  if (!parts.length) throw new Error('no image data');
  return zlib.inflateSync(Buffer.concat(parts));
}

// Antialiasing and a blinking indicator differ by a handful of bytes; a real scroll
// shifts every row. Exact equality would keep capturing the same screen forever.
function changed(a, b) {
  if (a.equals(b)) return false;
  try {
    const [x, y] = [scanlines(a), scanlines(b)];
    if (x.length !== y.length) return true;
    let differing = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) differing++;
    return differing / x.length > SAME_FRAME;
  } catch { return true; }
}

async function capture(run, config, outputDir, update, fetcher = fetch) {
  if (!run.screen?.ready) throw new Error(`No capture recipe for "${run.parameter}". Use main, login, web, local-demo or legacy.`);
  const manifestFile = path.join(config.buildDirectory, `${run.sha}.json`);
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')); }
  catch { throw new Error(`Build missing for ${run.sha}. Turn on "Build the commit automatically", or run: npm run build-sha -- ${run.sha}`); }
  const platform = run.platform || 'ios';
  if (manifest.sha !== run.sha || manifest.repository !== run.repository || (manifest.appId ?? manifest.bundleId) !== run.appId || !path.isAbsolute(manifest.appPath)) {
    throw new Error('Build manifest does not match the pinned repository, SHA and app ID.');
  }
  await fs.access(manifest.appPath);
  const ALLOWED = { ios: /\.(app|ipa)$/, android: /\.apk$/ };
  if (!ALLOWED[platform]?.test(manifest.appPath)) {
    throw new Error(platform === 'android' ? 'Build must be a local .apk.' : 'Build must be a local .app or .ipa.');
  }
  const udid = (config.udid || '').trim();
  if (!udid) throw new Error('Set a simulator, emulator or device identifier first.');
  const base = new URL(config.appiumUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash) {
    throw new Error('Appium must be an HTTP loopback URL on this Mac.');
  }
  const server = base.href.replace(/\/$/, '');
  const request = async (endpoint, method = 'GET', body, timeout = 45000) => {
    let response;
    try {
      response = await fetcher(`${server}${endpoint}`, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout), redirect: 'error'
      });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error(`Appium did not respond within ${Math.round(timeout / 1000)}s at ${server}. Check its log, then retry.`);
      throw new Error(`Cannot reach Appium at ${server}. Start it with "appium --port ${base.port || 4723}", then retry. The simulator or emulator boots on its own.`);
    }
    const data = await response.json();
    if (!response.ok || data.value?.error) {
      const error = new Error(`Appium: ${data.value?.message || response.status}`);
      error.code = data.value?.error;
      throw error;
    }
    return data.value;
  };
  update('Installing the pinned build');
  let sessionId;
  try {
    const shared = {
      'appium:udid': udid, 'appium:app': manifest.appPath,
      'appium:noReset': false, 'appium:newCommandTimeout': 180,
      // Two commits of a PR carry the same version, and both drivers skip the
      // install when a matching version is already there — which would capture
      // whatever build happened to be on the device last.
      'appium:enforceAppInstall': true
    };
    // Parallel sessions each need their own helper port, or the second session
    // attaches to the first device's agent.
    const capabilities = platform === 'android'
      ? { platformName: 'Android', 'appium:automationName': 'UiAutomator2', ...shared,
          'appium:appPackage': run.appId, 'appium:autoGrantPermissions': true,
          'appium:disableWindowAnimation': true,
          ...(config.helperPort ? { 'appium:systemPort': config.helperPort } : {}) }
      : { platformName: 'iOS', 'appium:automationName': 'XCUITest', ...shared,
          'appium:bundleId': run.appId, 'appium:screenshotQuality': 0,
          ...(config.helperPort ? { 'appium:wdaLocalPort': config.helperPort } : {}) };
    const session = await request('/session', 'POST', { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, 300000);
    sessionId = session.sessionId;
    if (!sessionId) throw new Error('Appium did not return a session ID.');
    const prefix = `/session/${encodeURIComponent(sessionId)}`;

    const find = async (locator, label, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const elements = await request(`${prefix}/elements`, 'POST', { using: locator.using, value: locator.value });
        for (const element of elements) {
          const element_id = element[WEB_ELEMENT] || element.ELEMENT;
          if (element_id && await request(`${prefix}/element/${encodeURIComponent(element_id)}/displayed`)) return element_id;
        }
        if (Date.now() >= deadline) throw new Error(`${label} never appeared (${locator.using}: ${locator.value}). Check the build, the device identifier and the app's accessibility identifiers.`);
        await sleep(500);
      }
    };

    const steps = run.screen.steps;
    for (const [index, step] of steps.entries()) {
      update(`Navigating ${index + 1}/${steps.length}: ${step.action} ${step.value || ''}`.trim());
      if (step.action === 'dismissKeyboard') {
        try { await request(`${prefix}/execute/sync`, 'POST', { script: 'mobile: hideKeyboard', args: [] }, 15000); } catch {}
        continue;
      }
      const element = await find(step, `Step ${index + 1} target`, run.screen.stepTimeoutMs ?? 30000);
      if (step.action === 'wait') continue;
      await request(`${prefix}/element/${encodeURIComponent(element)}/click`, 'POST', {});
      if (step.action === 'type') await request(`${prefix}/element/${encodeURIComponent(element)}/value`, 'POST', { text: step.text });
    }

    update(`Waiting for ${run.screen.name}`);
    await find(run.screen.ready, `${run.screen.name} readiness`, run.screen.readyTimeoutMs ?? 45000);
    await sleep(run.screen.settleMs ?? 1000);

    const shoot = async () => {
      const encoded = await request(`${prefix}/screenshot`);
      const bytes = Buffer.from(encoded, 'base64');
      if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('Appium returned a non-PNG screenshot.');
      return bytes;
    };
    const flick = async () => {
      const rect = await request(`${prefix}/window/rect`);
      const x = Math.round(rect.width * 0.94);
      await request(`${prefix}/actions`, 'POST', { actions: [{
        type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: [
          { type: 'pointerMove', duration: 0, x, y: Math.round(rect.height * 0.75) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 220, x, y: Math.round(rect.height * 0.25) },
          { type: 'pointerUp', button: 0 }
        ]
      }] }, 20000);
    };
    await fs.mkdir(outputDir, { recursive: true });
    const limit = run.screen.scroll ? Math.min(run.screen.maxSegments ?? 4, 6) : 1;
    const files = [];
    let previous = null;
    for (;;) {
      update(files.length ? `Saving PNG ${files.length + 1}` : 'Saving PNG');
      const bytes = await shoot();
      if (previous && !changed(bytes, previous)) break;
      previous = bytes;
      const name = files.length ? `${run.screen.id}-${files.length + 1}.png` : `${run.screen.id}.png`;
      const file = path.join(outputDir, name);
      await fs.writeFile(file, bytes);
      files.push(file);
      if (files.length >= limit) break;
      update('Scrolling to the next part');
      try { await flick(); } catch { break; }
      await sleep(run.screen.scrollSettleMs ?? 900);
    }
    return files;
  } finally {
    if (sessionId) {
      try { await request(`/session/${encodeURIComponent(sessionId)}`, 'DELETE', undefined, 20000); }
      catch {
        const error = new Error('Session cleanup failed. Listener paused; check Appium before restarting. A PNG may already exist in the run folder.');
        error.code = 'DEVICE_CLEANUP_FAILED';
        throw error;
      }
    }
  }
}
module.exports = { capture, changed };
