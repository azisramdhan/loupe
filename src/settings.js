const $ = id => document.getElementById(id);
const TABS = ['general', 'github', 'builds', 'devices'];
const TITLES = { general: 'General', github: 'GitHub', builds: 'Builds', devices: 'Devices' };
let applying = false;

const plain = text => String(text).replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '');

function message(text, error = false) {
  text = plain(text);
  $('message').hidden = !text;
  $('message').textContent = text;
  $('message').className = error ? 'error' : '';
  fit();
}

function fit() {
  // Measure after layout settles, or the last help line lands below the window edge.
  requestAnimationFrame(() => {
    const panes = [...document.querySelectorAll('.pane')].filter(pane => !pane.hidden);
    const bottom = panes.length ? panes[0].getBoundingClientRect().bottom : document.body.scrollHeight;
    window.farm.resizeSettings(Math.ceil(bottom) + 18);
  });
}

function showPane(name) {
  for (const tab of TABS) {
    $(`pane-${tab}`).hidden = tab !== name;
    document.querySelector(`.tab[data-pane="${tab}"]`).classList.toggle('selected', tab === name);
  }
  window.farm.titleSettings(TITLES[name]);
  fit();
}

async function load() {
  const state = await window.farm.state();
  applying = true;
  try {
    renderDevices(state.config.devices || []);
    for (const [field, value] of [['appiumUrl', state.config.appiumUrl], ['buildDirectory', state.config.buildDirectory]]) {
      if (document.activeElement !== $(field)) $(field).value = value || '';
    }
    if (document.activeElement !== $('appearance')) $('appearance').value = state.config.appearance || 'system';
    for (const flag of ['autoBuild', 'publishToPR']) {
      if (document.activeElement !== $(flag)) $(flag).checked = !!state.config[flag];
    }
    $('tokenHint').textContent = state.hasToken
      ? 'Token saved with macOS encryption. Leave blank to keep it.'
      : 'Read access to Issues and Pull requests. Stored encrypted on this Mac.';
  } finally { applying = false; }
}

function readDevices() {
  return [...document.querySelectorAll('#deviceList .device')]
    .map(row => row.querySelector('.udid').value.trim())
    .filter(Boolean);
}

function saveDevices() { apply({ token: '', devices: readDevices() }); }

function renderDevices(devices) {
  const list = $('deviceList');
  if (document.activeElement && list.contains(document.activeElement)) return;
  list.replaceChildren(...devices.map(device => deviceRow(device?.udid ?? device)));
}

// A UUID is a simulator and anything else is an Android serial, so a mistyped
// identifier would silently change platform. Say which one it reads as.
const PLATFORM_ICONS = {
  // Official brand shapes from Simple Icons (simpleicons.org), CC0
  ios: `<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-label="Apple"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>`,
  android: `<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-label="Android"><path d="M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 0 0-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 0 0-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0079-1.1191a1.1001 1.1001 0 0 0-.8515-.5332c-.5225-.0536-.9392.3128-1.0488.5449zm-.0391 8.461c.3944.5926.324 1.3306-.1563 1.6503-.4799.3197-1.188.0985-1.582-.4941-.3944-.5927-.324-1.3307.1563-1.6504.4727-.315 1.1812-.1086 1.582.4941zM7.207 13.5273c.4803.3197.5506 1.0577.1563 1.6504-.394.5926-1.1038.8138-1.584.4941-.48-.3197-.5503-1.0577-.1563-1.6504.4008-.6021 1.1087-.8106 1.584-.4941z"/></svg>`,
};
const platformOf = udid =>
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(udid.trim()) ? 'ios' : 'android';

function deviceRow(udid = '') {
  const row = document.createElement('div');
  row.className = 'device';
  const field = document.createElement('input');
  field.className = 'udid mono'; field.value = udid; field.placeholder = 'UDID or serial'; field.spellcheck = false;
  const platform = document.createElement('span');
  platform.className = 'platform';
  const showPlatform = () => {
    const p = field.value.trim() ? platformOf(field.value) : null;
    platform.innerHTML = p ? PLATFORM_ICONS[p] : '';
    platform.title = p === 'ios' ? 'iOS Simulator' : p === 'android' ? 'Android Emulator' : '';
  };
  showPlatform();
  field.oninput = showPlatform;
  field.onchange = () => { showPlatform(); saveDevices(); };
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'remove'; remove.title = 'Remove device';
  remove.textContent = '−';
  remove.onclick = () => { row.remove(); saveDevices(); };
  row.append(field, platform, remove);
  return row;
}

$('addDevice').onclick = () => {
  const row = deviceRow();
  $('deviceList').append(row);
  row.querySelector('.udid').focus();
  fit();
};

// macOS settings take effect as you set them; there is no Save button to forget.
async function apply(changes, done = '') {
  if (applying) return;
  try {
    await window.farm.save(changes);
    message(done);
    await load();
  } catch (error) { message(error.message, true); }
}

for (const tab of TABS) {
  document.querySelector(`.tab[data-pane="${tab}"]`).onclick = () => showPane(tab);
}
$('appearance').onchange = () => apply({ token: '', appearance: $('appearance').value });
$('autoBuild').onchange = () => apply({ token: '', autoBuild: $('autoBuild').checked });
$('publishToPR').onchange = () => apply({ token: '', publishToPR: $('publishToPR').checked });
$('appiumUrl').onchange = () => apply({ token: '', appiumUrl: $('appiumUrl').value });
$('buildDirectory').onchange = () => apply({ token: '', buildDirectory: $('buildDirectory').value });
$('token').onchange = () => {
  if (!$('token').value.trim()) return;
  apply({ token: $('token').value }, 'Token saved.').then(() => { $('token').value = ''; });
};

document.onkeydown = event => { if (event.key === 'Escape') window.close(); };
window.farm.onChange(() => load().catch(error => message(error.message, true)));
load().then(() => showPane('general')).catch(error => message(error.message, true));
