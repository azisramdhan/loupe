const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Farm } = require('../src/engine.cjs');
const { capture } = require('../src/runner.cjs');
const { buildAndRegister } = require('../src/build.cjs');
const { platformOf, devices } = require('../src/config.cjs');
const { projects, projectFor, parseCommand } = require('../src/catalog.cjs');
const { writeJSON } = require('../src/storage.cjs');

const IOS = projects.find(p => p.platform === 'ios');
const ANDROID = projects.find(p => p.platform === 'android');
const SIMULATOR = '17540010-6E73-45DC-B369-97C27E5DFB56';
const EMULATOR = 'emulator-5554';
const sha = 'a'.repeat(40);

const temporary = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const comment = (id, project) => ({
  id, body: '/farm main', user: { login: 'developer', type: 'User' }, author_association: 'MEMBER',
  issue_url: `https://api.github.com/repos/${project.repository}/issues/7`, created_at: new Date().toISOString()
});
const github = () => ({
  issue: async () => ({ state: 'open', pull_request: {} }),
  pull: async () => ({ base: { repo: { full_name: null } }, head: { sha } })
});
// The engine checks the PR's base repository against the run's, so each project needs its own.
const githubFor = project => ({
  issue: async () => ({ state: 'open', pull_request: {} }),
  pull: async () => ({ base: { repo: { full_name: project.repository } }, head: { sha } })
});

test('a UUID is a simulator and anything else is an Android serial', () => {
  assert.equal(platformOf(SIMULATOR), 'ios');
  assert.equal(platformOf('888FA158-5327-4176-A865-C091453DD497'), 'ios');
  assert.equal(platformOf(EMULATOR), 'android');
  assert.equal(platformOf('R5CT80ABCDE'), 'android');
  assert.deepEqual(devices({ devices: [SIMULATOR, EMULATOR] }).map(d => d.platform), ['ios', 'android']);
});

test('each repository resolves to its own project and app id', () => {
  assert.equal(projectFor('azisramdhan/WebViewDemo'), ANDROID);
  assert.equal(projectFor('AZISRAMDHAN/WEBKITDEMO'), IOS);
  assert.equal(projectFor('someone/else'), null);
  assert.equal(parseCommand('/farm main', ANDROID).appId, 'com.azisramdhan.webviewdemo');
  assert.equal(parseCommand('/farm main', ANDROID).platform, 'android');
});

test('both projects answer the same commands', () => {
  const names = project => project.screens.flatMap(s => s.aliases).sort();
  assert.deepEqual(names(ANDROID), names(IOS), 'a command means the same thing on either platform');
});

test('an Android command is rejected when only a simulator is configured', async t => {
  const farm = new Farm(temporary(t), githubFor(ANDROID), async () => '/fake.png', { devices: [SIMULATOR] });
  await farm.ingest(comment(1, ANDROID), ANDROID);
  assert.equal(farm.state.runs[0].status, 'rejected');
  assert.match(farm.state.runs[0].error, /needs Android/);
});

test('a capture only runs on a device of its own platform', async t => {
  const landed = [];
  const farm = new Farm(temporary(t), github(), async (run, config) => {
    landed.push(`${run.platform}:${config.udid}`);
    return '/fake.png';
  }, { devices: [SIMULATOR, EMULATOR] });
  farm.github = githubFor(IOS);
  await farm.ingest(comment(1, IOS), IOS);
  farm.github = githubFor(ANDROID);
  await farm.ingest(comment(2, ANDROID), ANDROID);
  farm.listening = true; await farm.drain(); farm.stop();
  assert.deepEqual(landed.sort(), [`android:${EMULATOR}`, `ios:${SIMULATOR}`]);
  assert.deepEqual(farm.state.runs.map(r => r.status), ['completed', 'completed']);
});

test('the two platforms number their helper ports separately', async t => {
  const ports = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const farm = new Farm(temporary(t), github(), async (run, config) => {
    ports.push(`${run.platform}:${config.helperPort}`);
    if (ports.length === 2) release();
    await gate;
    return '/fake.png';
  }, { devices: [SIMULATOR, EMULATOR] });
  farm.github = githubFor(IOS);
  await farm.ingest(comment(1, IOS), IOS);
  farm.github = githubFor(ANDROID);
  await farm.ingest(comment(2, ANDROID), ANDROID);
  farm.listening = true; await farm.drain(); farm.stop();
  assert.deepEqual(ports.sort(), ['android:8200', 'ios:8100'],
    'a WebDriverAgent port and a UiAutomator2 port are unrelated');
});

test('an Android session asks for UiAutomator2, its package and its own system port', async t => {
  const dir = temporary(t);
  const apk = path.join(dir, 'app-debug.apk');
  fs.writeFileSync(apk, 'not really an apk');
  writeJSON(path.join(dir, `${sha}.json`), { repository: ANDROID.repository, platform: 'android', sha, appId: ANDROID.appId, appPath: apk });
  let sent;
  const fetcher = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.endsWith('/session') && options.method === 'POST') {
      sent = body.capabilities.alwaysMatch;
      return { ok: true, json: async () => ({ value: { sessionId: 's1' } }) };
    }
    return { ok: true, json: async () => ({ value: [] }) };
  };
  const run = { sha, repository: ANDROID.repository, appId: ANDROID.appId, platform: 'android',
    parameter: 'main', screen: { id: 'login', name: 'Login', steps: [], ready: { using: 'accessibility id', value: 'Log In' }, readyTimeoutMs: 10 } };
  await assert.rejects(() => capture(run, { buildDirectory: dir, udid: EMULATOR, helperPort: 8200, appiumUrl: 'http://127.0.0.1:4723' },
    path.join(dir, 'out'), () => {}, fetcher), /never appeared/);
  assert.equal(sent.platformName, 'Android');
  assert.equal(sent['appium:automationName'], 'UiAutomator2');
  assert.equal(sent['appium:appPackage'], 'com.azisramdhan.webviewdemo');
  assert.equal(sent['appium:systemPort'], 8200);
  assert.equal(sent['appium:udid'], EMULATOR);
  assert.ok(!('appium:wdaLocalPort' in sent), 'a WebDriverAgent port means nothing to Android');
  assert.equal(sent['appium:enforceAppInstall'], true,
    'two commits of a PR share a version, so the driver must be told to replace the installed build');
});

test('an Android build must be an apk, not an app bundle', async t => {
  const dir = temporary(t);
  const appPath = path.join(dir, 'WebViewDemo.app');
  fs.mkdirSync(appPath);
  writeJSON(path.join(dir, `${sha}.json`), { repository: ANDROID.repository, platform: 'android', sha, appId: ANDROID.appId, appPath });
  const run = { sha, repository: ANDROID.repository, appId: ANDROID.appId, platform: 'android',
    parameter: 'main', screen: { id: 'login', name: 'Login', steps: [], ready: { using: 'accessibility id', value: 'Log In' } } };
  await assert.rejects(() => capture(run, { buildDirectory: dir, udid: EMULATOR, appiumUrl: 'http://127.0.0.1:4723' },
    path.join(dir, 'out'), () => {}, async () => { throw new Error('must not reach Appium'); }), /must be a local \.apk/);
});

test('the Android build clones, pins the commit and runs Gradle', async t => {
  const dir = temporary(t);
  const checkout = path.join(dir, 'checkout');
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push(path.basename(command));
    // A real clone leaves the working tree behind; the stub has to as well.
    if (command === 'git' && args[0] === 'clone') fs.mkdirSync(path.join(args[2], '.git'), { recursive: true });
    if (path.basename(command) === 'gradlew') {
      assert.deepEqual(args, ['assembleDebug', '--console=plain']);
      assert.ok(options.env.JAVA_HOME, 'Gradle needs a JDK that the Mac may not have on PATH');
      assert.ok(options.env.ANDROID_HOME);
      const out = path.join(options.cwd, 'app', 'build', 'outputs', 'apk', 'debug');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'app-debug.apk'), 'built');
    }
  };
  const manifest = await buildAndRegister(ANDROID, sha, { buildDirectory: dir, checkoutDirectory: checkout }, () => {}, exec);
  assert.deepEqual(calls, ['git', 'git', 'git', 'gradlew']);
  assert.equal(manifest.platform, 'android');
  assert.equal(manifest.appId, 'com.azisramdhan.webviewdemo');
  assert.match(manifest.appPath, /app-debug\.apk$/);
  assert.ok(fs.existsSync(path.join(checkout, 'WebViewDemo', 'local.properties')),
    'Gradle will not find the SDK without one');
});
