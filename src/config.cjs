const path = require('node:path');
const { readJSON } = require('./storage.cjs');
const { checkoutRoot } = require('./build.cjs');

const RETIRED = ['triggerOnly', 'udid'];

// This names an artifact folder and keys the gallery, so two devices must never
// share one. Truncating collided: every emulator-NNNN began with the same eight
// characters. Keeping the whole identifier cannot collide at all.
const slug = udid => udid.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// An iOS simulator is identified by a UUID; an Android device by a serial such as
// emulator-5554. Nothing else about the two is shaped alike, so the text decides.
const platformOf = udid => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(udid) ? 'ios' : 'android';

function devices(config) {
  return (Array.isArray(config.devices) ? config.devices : [])
    .map(entry => String(entry?.udid ?? entry ?? '').trim())
    .filter(Boolean)
    .map(udid => ({ udid, slug: slug(udid), platform: platformOf(udid) }));
}

function defaults(directory) {
  return {
    appiumUrl: 'http://127.0.0.1:4723',
    buildDirectory: path.join(directory, 'builds'),
    devices: [],
    checkoutDirectory: checkoutRoot(),
    autoBuild: true,
    publishToPR: false,
    appearance: 'system'
  };
}

// A config carried over from the previous app name keeps paths that embed it,
// and those folders no longer exist. Point them back at the current defaults.
function load(directory, read = readJSON) {
  const stored = read(path.join(directory, 'config.json'), {}) || {};
  const config = { ...defaults(directory), ...stored };
  for (const key of RETIRED) delete config[key];
  // A single-device install predates the farm; carry its device into the list.
  if (!Array.isArray(config.devices) || !config.devices.length) {
    config.devices = stored.udid ? [String(stored.udid).trim()] : [];
  }
  config.devices = devices(config).map(device => device.udid);
  const fallback = defaults(directory);
  for (const key of ['buildDirectory', 'checkoutDirectory']) {
    if (typeof config[key] === 'string' && config[key].includes(`${path.sep}device-farm-desktop${path.sep}`)) {
      config[key] = fallback[key];
    }
  }
  // Checkouts used to be one folder for the only project there was. Each project
  // now gets its own folder underneath, so the stored path moves up one level.
  if (config.checkoutDirectory === path.join(fallback.checkoutDirectory, 'WebKitDemo')) {
    config.checkoutDirectory = fallback.checkoutDirectory;
  }
  return config;
}

module.exports = { load, defaults, devices, slug, platformOf, RETIRED };
