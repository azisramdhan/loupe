const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { writeJSON, readJSON } = require('./storage.cjs');

const TOOL_PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
const ANDROID_SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  || path.join(os.homedir(), 'Library', 'Android', 'sdk');
// The Android Gradle plugin refuses anything older than 17, and the JDK on PATH
// is whatever the Mac happens to have.
const JDK_17 = ['/opt/homebrew/opt/openjdk@17', '/usr/local/opt/openjdk@17'].find(p => fs.existsSync(p));

const checkoutRoot = () => path.join(os.homedir(), 'Library', 'Caches', 'Loupe');
const checkoutFor = (project, config) => path.join(config.checkoutDirectory || checkoutRoot(), project.name);

const MISSING_TOOL = {
  xcodegen: 'Install Xcode command line tools and "brew install xcodegen".',
  xcodebuild: 'Install Xcode command line tools and "brew install xcodegen".',
  git: 'Install the Xcode command line tools.'
};

function tail(text, lines = 3) {
  const kept = text.split('\n').map(line => line.trim()).filter(Boolean).slice(-lines).join(' / ');
  return kept.length > 400 ? `${kept.slice(0, 400)}...` : kept;
}

function execute(command, args, options = {}) {
  const { env: extra, ...rest } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...rest, env: { ...process.env, PATH: TOOL_PATH, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = chunk => { output = (output + chunk).slice(-8000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => reject(new Error(error.code === 'ENOENT'
      ? `${command} was not found. ${MISSING_TOOL[path.basename(command)] || 'Install it, then retry.'}`
      : `${command} could not start: ${error.message}`)));
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}. ${tail(output)}`)));
  });
}

async function checkout(project, config, sha, update, exec) {
  const directory = checkoutFor(project, config);
  if (!fs.existsSync(path.join(directory, '.git'))) {
    update(`Cloning ${project.name}`);
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    await exec('git', ['clone', `https://github.com/${project.repository}.git`, directory]);
  }
  update(`Fetching commit ${sha.slice(0, 7)}`);
  await exec('git', ['-C', directory, 'fetch', '--prune', 'origin',
    '+refs/heads/*:refs/remotes/origin/*', '+refs/pull/*/head:refs/remotes/origin/pr/*']);
  await exec('git', ['-C', directory, 'checkout', '--force', sha]);
  return directory;
}

async function buildIos(project, sha, config, update, exec) {
  const source = await checkout(project, config, sha, update, exec);
  const derived = `${source}-derived`;

  update('Generating the Xcode project');
  await exec('xcodegen', ['generate'], { cwd: source });

  update(`Building ${sha.slice(0, 7)} for the simulator. First run on a commit takes a few minutes.`);
  await exec('xcodebuild', ['-project', path.join(source, `${project.name}.xcodeproj`),
    '-scheme', project.name, '-configuration', 'Debug', '-sdk', 'iphonesimulator',
    '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derived,
    'CODE_SIGNING_ALLOWED=NO', 'build']);

  return path.join(derived, 'Build', 'Products', 'Debug-iphonesimulator', `${project.name}.app`);
}

async function buildAndroid(project, sha, config, update, exec) {
  const source = await checkout(project, config, sha, update, exec);
  if (!JDK_17) throw new Error('JDK 17 is missing. Install it with "brew install openjdk@17", then retry.');
  if (!fs.existsSync(ANDROID_SDK)) throw new Error(`Android SDK not found at ${ANDROID_SDK}. Install it through Android Studio, then retry.`);
  // The checkout has no local.properties, and Gradle will not look for the SDK without one.
  fs.writeFileSync(path.join(source, 'local.properties'), `sdk.dir=${ANDROID_SDK}\n`);

  update(`Building ${sha.slice(0, 7)} with Gradle. First run on a commit takes a few minutes.`);
  await exec(path.join(source, 'gradlew'), ['assembleDebug', '--console=plain'],
    { cwd: source, env: { JAVA_HOME: JDK_17, ANDROID_HOME: ANDROID_SDK, ANDROID_SDK_ROOT: ANDROID_SDK } });

  return path.join(source, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
}

const buildQueues = new Map();

const BUILDERS = { ios: buildIos, android: buildAndroid };

async function buildAndRegister(project, sha, config, update = () => {}, exec = execute) {
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Build needs a 40-character commit SHA.');
  if (!config.buildDirectory) throw new Error('Set a build directory first.');
  const builder = BUILDERS[project.platform];
  if (!builder) throw new Error(`No builder for ${project.platform}.`);

  // One checkout can only build one commit at a time. Capture uses a separate
  // snapshot, so the next build cannot replace an app already being installed.
  const key = path.resolve(checkoutFor(project, config));
  const previous = buildQueues.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const output = await builder(project, sha, config, update, exec);
    if (!fs.existsSync(output)) throw new Error(`Build finished but ${output} is missing.`);
    const directory = path.resolve(config.buildDirectory, project.name, sha);
    fs.mkdirSync(directory, { recursive: true });
    const appPath = path.join(directory, path.basename(output));
    fs.cpSync(output, appPath, { recursive: true });
    const manifest = { repository: project.repository, platform: project.platform, sha, appId: project.appId, appPath };
    writeJSON(path.join(config.buildDirectory, `${sha}.json`), manifest);
    return manifest;
  });
  buildQueues.set(key, pending);
  try { return await pending; }
  finally { if (buildQueues.get(key) === pending) buildQueues.delete(key); }
}

async function ensureBuild(project, sha, config, update = () => {}, exec = execute) {
  const manifest = readJSON(path.join(config.buildDirectory, `${sha}.json`), null);
  const source = path.resolve(checkoutFor(project, config));
  const artifact = manifest?.appPath && path.resolve(manifest.appPath);
  // Old automatic manifests pointed at mutable Gradle/Xcode outputs.
  const sharedOutput = artifact && (artifact.startsWith(source + path.sep) || artifact.startsWith(source + '-derived' + path.sep));
  if (manifest?.sha === sha && manifest.repository === project.repository && artifact && !sharedOutput && fs.existsSync(artifact)) return { manifest, built: false };
  return { manifest: await buildAndRegister(project, sha, config, update, exec), built: true };
}

module.exports = { ensureBuild, buildAndRegister, checkoutRoot, checkoutFor };
