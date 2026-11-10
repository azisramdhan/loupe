const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const os = require('node:os');
const execute = promisify(execFile);

// Which devices a capture can reach. A simulator is reachable whenever it
// exists, because a run boots it the same way a single-device run does. An
// Android serial only exists while its emulator is running, so there is
// nothing to reach when it is absent.
async function available(platform, exec = execute) {
  if (platform === 'ios') {
    const { stdout } = await exec('/usr/bin/xcrun', ['simctl', 'list', 'devices', '--json'], { timeout: 15000 });
    return Object.values(JSON.parse(stdout).devices).flat()
      .filter(d => d.isAvailable).map(d => d.udid);
  }
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk');
  const { stdout } = await exec(path.join(sdk, 'platform-tools/adb'), ['devices'], { timeout: 15000 });
  return stdout.split('\n').map(line => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial.startsWith('emulator-') && state === 'device').map(([serial]) => serial);
}
module.exports = { available };
