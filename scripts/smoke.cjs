// Launch the real app against isolated local state, exercise IPC, save a window capture.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-smoke-'));
app.setPath('userData', directory);
const timeout = setTimeout(() => { console.error('Smoke test timed out'); app.exit(1); }, 20000);
let main;
app.on('browser-window-created', (_event, window) => {
  if (main) return;
  main = window;
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const state = await window.farm.state();
        await new Promise(resolve => setTimeout(resolve, 300));
        const examples = [...document.querySelectorAll('#screenExamples button')];
        if (examples.length !== 4) throw new Error('Screen filters missing');
        examples.find(button => button.textContent.startsWith('local-demo')).click();
        await new Promise(resolve => setTimeout(resolve, 400));
        const active = document.querySelector('#screenExamples button.selected');
        if (!active || !active.textContent.startsWith('local-demo')) throw new Error('Screen filter did not activate');
        if (document.getElementById('navRuns').classList.contains('selected')) throw new Error('All Runs must deselect while a screen filter is on');
        document.getElementById('navRuns').click();
        await new Promise(resolve => setTimeout(resolve, 400));
        if (document.querySelector('#screenExamples button.selected')) throw new Error('All Runs did not clear the filter');
        return { repository: state.projects.map(p => p.repository).join(' '), hasToken: state.hasToken,
          screens: [...new Set(state.projects.flatMap(p => p.screens).map(s => s.id))].join(',') };
      })()`);
      assert.equal(result.repository, 'azisramdhan/WebKitDemo azisramdhan/WebViewDemo');
      assert.equal(result.hasToken, false);
      assert.equal(result.screens, 'login,web,local-demo,legacy');

      assert.match(window.getTitle(), /^Loupe$/, 'the window names the app');
      const { Menu } = require('electron');
      const settings = Menu.getApplicationMenu().getMenuItemById('settings');
      assert.ok(settings, 'Settings must live in the application menu');
      assert.equal(settings.accelerator, 'Command+,');
      settings.click();
      await new Promise(resolve => setTimeout(resolve, 900));
      const { BrowserWindow } = require('electron');
      const panel = BrowserWindow.getAllWindows().find(w => w !== main);
      assert.ok(panel, 'Settings… must open its own window');
      assert.equal(panel.getTitle(), 'General', 'the window title names the selected tab');
      assert.equal(panel.isResizable(), false, 'a settings panel is fixed size');
      const saved = await panel.webContents.executeJavaScript(`(async () => {
        const tabs = [...document.querySelectorAll('.tab')].map(t => t.dataset.pane);
        if (document.querySelector('button[type="submit"]')) throw new Error('Settings must apply as they change, with no Save button');
        document.querySelector('.tab[data-pane="devices"]').click();
        await new Promise(resolve => setTimeout(resolve, 200));
        const paneShown = !document.getElementById('pane-devices').hidden && document.getElementById('pane-general').hidden;
        const set = (field, value) => { field.value = value; field.dispatchEvent(new Event('change')); };
        document.getElementById('addDevice').click();
        await new Promise(resolve => setTimeout(resolve, 150));
        const row = document.querySelector('#deviceList .device');
        set(row.querySelector('.udid'), '17540010-6E73-45DC-B369-97C27E5DFB56');
        await new Promise(resolve => setTimeout(resolve, 400));
        document.getElementById('addDevice').click();
        await new Promise(resolve => setTimeout(resolve, 150));
        const rows = [...document.querySelectorAll('#deviceList .device')];
        set(rows[rows.length - 1].querySelector('.udid'), 'emulator-5554');
        await new Promise(resolve => setTimeout(resolve, 400));

        document.querySelector('.tab[data-pane="builds"]').click();
        await new Promise(resolve => setTimeout(resolve, 200));
        set(document.getElementById('buildDirectory'), '/tmp/loupe-smoke-builds');
        await new Promise(resolve => setTimeout(resolve, 400));
        const state = await window.farm.state();
        // Saving re-renders the list, so the labels have to come from the live rows.
        const platforms = [...document.querySelectorAll('#deviceList .device .platform')]
          .map(p => p.querySelector('svg')?.getAttribute('aria-label') || '');
        return { tabs, paneShown, platforms, devices: state.config.devices, buildDirectory: state.config.buildDirectory };
      })()`);
      assert.deepEqual(saved.tabs, ['general', 'github', 'builds', 'devices']);
      assert.ok(saved.paneShown, 'clicking a tab must swap the visible pane');
      assert.deepEqual(saved.devices, ['17540010-6E73-45DC-B369-97C27E5DFB56', 'emulator-5554'],
        'a simulator UDID and an Android serial are both device identifiers');
      assert.deepEqual(saved.platforms, ['iOS', 'Android'],
        'each row names the platform it reads the identifier as, icon or not');
      assert.equal(saved.buildDirectory, '/tmp/loupe-smoke-builds');
      assert.equal(panel.getTitle(), 'Builds', 'the window title follows the selected tab');
      const columns = await window.webContents.executeJavaScript(`(() => {
        const handle = document.querySelector('.c-device .col-resize-handle');
        const th = handle.closest('th');
        const before = th.offsetWidth;
        handle.focus();
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        return { before, after: th.offsetWidth, stored: localStorage.getItem('columnWidths'),
          focusable: handle.tabIndex === 0, hidden: handle.getAttribute('aria-hidden') };
      })()`);
      assert.ok(columns.focusable, 'a resize handle must be reachable without a mouse');
      assert.equal(columns.hidden, null, 'a focusable control must not be hidden from assistive technology');
      assert.ok(columns.after > columns.before, 'an arrow key widens the column');
      assert.match(columns.stored || '', /c-device/, 'the width outlives the session');

      const sidebar = Menu.getApplicationMenu().getMenuItemById('sidebar');
      assert.equal(sidebar.label, 'Hide Sidebar', 'the menu item names what the click will do');
      sidebar.click();
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(sidebar.label, 'Show Sidebar', 'hiding the sidebar flips the menu item');
      sidebar.click();
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(sidebar.label, 'Hide Sidebar', 'showing it again flips the menu item back');

      await new Promise(resolve => setTimeout(resolve, 500));
      const image = await window.webContents.capturePage();
      const output = path.join(directory, 'desktop.png'); fs.writeFileSync(output, image.toPNG());
      console.log(`Desktop smoke passed. Screenshot: ${output}`);
      clearTimeout(timeout); app.exit(0);
    } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
  });
});
require('../src/main.cjs');
