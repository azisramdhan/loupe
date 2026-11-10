const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('farm', {
  state: () => ipcRenderer.invoke('farm:state'),
  save: value => ipcRenderer.invoke('farm:save', value),
  start: () => ipcRenderer.invoke('farm:start'), stop: () => ipcRenderer.invoke('farm:stop'),
  poll: () => ipcRenderer.invoke('farm:poll'),
  retry: id => ipcRenderer.invoke('farm:retry', id),
  reveal: id => ipcRenderer.invoke('farm:reveal', id), image: id => ipcRenderer.invoke('farm:image', id),
  open: url => ipcRenderer.invoke('farm:open', url),
  resizeSettings: height => ipcRenderer.invoke('farm:resize', height),
  titleSettings: title => ipcRenderer.invoke('farm:title', title),
  reportSidebar: hidden => ipcRenderer.invoke('farm:sidebar-state', hidden),
  onChange: callback => ipcRenderer.on('farm:changed', () => callback()),
  onToggleSidebar: callback => ipcRenderer.on('farm:toggle-sidebar', () => callback())
});
