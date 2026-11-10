const { app, BrowserWindow, ipcMain, Menu, nativeTheme, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { GitHub } = require('./github.cjs');
const { Farm } = require('./engine.cjs');
const { capture } = require('./runner.cjs');
const { projects } = require('./catalog.cjs');
const { readJSON, writeJSON } = require('./storage.cjs');
const { checkoutRoot } = require('./build.cjs');
const { load: loadConfig } = require('./config.cjs');
const { migrate } = require('./migrate.cjs');

let window, settingsWindow, farm, config, directory, token = '';
const ui = pathToFileURL(path.join(__dirname, 'index.html')).href;
const settingsUi = pathToFileURL(path.join(__dirname, 'settings.html')).href;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
  app.whenReady().then(() => {
    directory = app.getPath('userData');
    const moved = migrate(directory, 'device-farm-desktop');
    config = loadConfig(directory);
    writeJSON(path.join(directory, 'config.json'), config);
    applyAppearance();
    const credentialFile = path.join(directory, 'credential.json');
    const encrypted = readJSON(credentialFile, null);
    let notice = moved ? 'Settings and run history moved over from Device Farm. Save your GitHub token again to reconnect.' : null;
    if (encrypted && safeStorage.isEncryptionAvailable()) {
      try { token = safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
      catch {
        // Unreadable here and forever: drop it rather than failing on every launch.
        fs.rmSync(credentialFile, { force: true });
        notice = 'The saved token was encrypted by a different build and cannot be read. Save your GitHub token again.';
      }
    }
    // Runs from every project live together; the old per-repository folder held
    // the only project there was.
    const runsDirectory = path.join(directory, 'runs');
    const legacy = path.join(directory, 'repositories', ...projects[0].repository.split('/'), 'runs.json');
    if (!fs.existsSync(path.join(runsDirectory, 'runs.json')) && fs.existsSync(legacy)) {
      fs.mkdirSync(runsDirectory, { recursive: true });
      fs.copyFileSync(legacy, path.join(runsDirectory, 'runs.json'));
    }
    farm = new Farm(runsDirectory, new GitHub(token), capture, config);

    farm.on('change', () => {
      for (const target of [window, settingsWindow]) {
        if (target && !target.isDestroyed()) target.webContents.send('farm:changed');
      }
    });
    function handle(name, fn) {
      ipcMain.handle(name, async (event, ...args) => {
        const trusted = (event.senderFrame === window?.webContents.mainFrame && event.senderFrame.url === ui)
          || (event.senderFrame === settingsWindow?.webContents.mainFrame && event.senderFrame.url === settingsUi);
        if (!trusted) throw new Error('Untrusted sender');
        return fn(...args);
      });
    }
    handle('farm:state', () => ({ ...farm.snapshot(), config, hasToken: !!token, notice: token ? null : notice, projects, directory }));
    handle('farm:save', input => {
      if (!input || typeof input.token !== 'string') throw new Error('Those settings could not be read.');
      const persist = () => { writeJSON(path.join(directory, 'config.json'), config); farm.config = config; };
      // Appearance changes nothing the farm is doing, so it never waits for the listener.
      if (['system', 'light', 'dark'].includes(input.appearance)) { config.appearance = input.appearance; applyAppearance(); persist(); }
      const farmKeys = ['devices', 'appiumUrl', 'buildDirectory', 'autoBuild', 'publishToPR'];
      if (!input.token.trim() && !farmKeys.some(key => input[key] !== undefined)) return;
      if (farm.listening || farm.running || farm.polling) throw new Error('Pause the listener and wait for the active run before changing this.');
      if (input.token.trim()) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('macOS credential encryption is unavailable.');
        const nextToken = input.token.trim();
        writeJSON(path.join(directory, 'credential.json'), safeStorage.encryptString(nextToken).toString('base64'));
        token = nextToken; farm.github = new GitHub(token); farm.lastError = null;
      }
      if (Array.isArray(input.devices)) {
        if (input.devices.length > 8) throw new Error('Loupe schedules across eight devices at most.');
        const seen = new Set();
        config.devices = input.devices.map(entry => {
          const udid = String(entry?.udid ?? entry ?? '').trim();
          // A simulator UDID and an Android serial look nothing alike, so accept both shapes.
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{3,63}$/.test(udid)) throw new Error(`"${udid}" is not a device identifier. Use a UDID from xcrun simctl list devices or a serial from adb devices.`);
          if (seen.has(udid)) throw new Error('That device is already in the list.');
          seen.add(udid);
          return udid;
        });
      }
      if (typeof input.appiumUrl === 'string' && input.appiumUrl.trim()) {
        const url = new URL(input.appiumUrl.trim());
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Appium must be an HTTP loopback URL on this Mac.');
        config.appiumUrl = url.href.replace(/\/$/, '');
      }
      if (typeof input.publishToPR === 'boolean') config.publishToPR = input.publishToPR;
      if (typeof input.autoBuild === 'boolean') config.autoBuild = input.autoBuild;
      if (!config.checkoutDirectory) config.checkoutDirectory = checkoutRoot();
      if (typeof input.buildDirectory === 'string' && input.buildDirectory.trim()) {
        if (!path.isAbsolute(input.buildDirectory.trim())) throw new Error('Build directory must be an absolute path.');
        config.buildDirectory = input.buildDirectory.trim();
      }
      persist();
    });
    handle('farm:resize', height => {
      if (!settingsWindow || settingsWindow.isDestroyed()) return;
      const wanted = Math.min(Math.max(Math.round(Number(height) || 0), 160), 900);
      const [width] = settingsWindow.getContentSize();
      settingsWindow.setContentSize(width, wanted, false);
    });
    handle('farm:sidebar-state', hidden => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('sidebar');
      if (item) item.label = hidden ? 'Show Sidebar' : 'Hide Sidebar';
    });
    handle('farm:title', title => {
      if (settingsWindow && !settingsWindow.isDestroyed() && typeof title === 'string') settingsWindow.setTitle(title);
    });
    handle('farm:start', async () => {
      if (!token) throw new Error('Save a GitHub token first.');
      await farm.start();
    });
    handle('farm:stop', () => farm.stop());
    handle('farm:poll', () => farm.pollNow());
    handle('farm:retry', id => farm.retry(id));
    handle('farm:reveal', id => {
      const run = farm.state.runs.find(r => r.id === id);
      if (run?.screenshot && fs.existsSync(run.screenshot)) shell.showItemInFolder(run.screenshot);
      else throw new Error('Screenshot not available.');
    });
    handle('farm:open', link => {
      const url = new URL(String(link));
      if (url.protocol !== 'https:' || !['github.com', 'raw.githubusercontent.com'].includes(url.hostname)) {
        throw new Error('Only GitHub links can be opened from here.');
      }
      return shell.openExternal(url.href);
    });
    handle('farm:image', id => {
      const run = farm.state.runs.find(r => r.id === id);
      const files = (run?.screenshots?.length ? run.screenshots : [run?.screenshot]).filter(f => f && fs.existsSync(f));
      return files.length ? files.map(f => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`) : null;
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu', submenu: [
        { role: 'about' },
        { type: 'separator' },
        { id: 'settings', label: 'Settings…', accelerator: 'Command+,', click: () => openSettings() },
        { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' }
      ] },
      { role: 'editMenu' },
      { label: 'Listener', submenu: [
        { id: 'listen', label: 'Start Listening', accelerator: 'Command+R', click: () => farm.listening ? farm.stop() : farm.start().catch(() => {}) },
        { id: 'poll', label: 'Check Now', accelerator: 'Command+Shift+R', click: () => farm.pollNow().catch(() => {}) }
      ] },
      { label: 'View', submenu: [
        { id: 'sidebar', label: 'Hide Sidebar', accelerator: 'Alt+Command+S', click: () => window?.webContents.send('farm:toggle-sidebar') }
      ] },
      { role: 'windowMenu' }
    ]));
    farm.on('change', () => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('listen');
      if (item) item.label = farm.listening ? 'Pause Listening' : 'Start Listening';
      const poll = Menu.getApplicationMenu()?.getMenuItemById('poll');
      if (poll) poll.enabled = farm.listening && !farm.polling;
    });
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(error => { console.error(error); app.quit(); });
}
function applyAppearance() {
  nativeTheme.themeSource = ['light', 'dark'].includes(config.appearance) ? config.appearance : 'system';
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 680, height: 320, resizable: false, minimizable: false, maximizable: false, useContentSize: true,
    title: 'Settings', parent: window, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202225' : '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
}

function createWindow() {
  window = new BrowserWindow({ width: 1020, height: 700, minWidth: 840, minHeight: 560, title: 'Loupe',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#2b2e31' : '#ececec',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.loadFile(path.join(__dirname, 'index.html'));
}
app.on('before-quit', () => farm?.stop());
app.on('window-all-closed', () => app.quit());
