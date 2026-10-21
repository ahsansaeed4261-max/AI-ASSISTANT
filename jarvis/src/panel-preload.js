const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panelAPI', {
  onState: (callback) => ipcRenderer.on('panel-state', (event, data) => callback(data)),
  closePanel: () => ipcRenderer.send('close-panel'),
  getApps: () => ipcRenderer.invoke('get-apps'),
  launchApp: (id) => ipcRenderer.invoke('launch-app', id),
  powerAction: (id) => ipcRenderer.invoke('power-action', id),
  cancelPowerAction: () => ipcRenderer.invoke('power:cancel'),
  getControls: () => ipcRenderer.invoke('get-controls'),
  setVolume: (value) => ipcRenderer.invoke('set-volume', Math.max(0, Math.min(100, Number(value)))),
  toggleMute: () => ipcRenderer.invoke('toggle-mute'),
  setWifi: (enabled) => ipcRenderer.invoke('set-wifi', Boolean(enabled)),
  setBluetooth: (enabled) => ipcRenderer.invoke('set-bluetooth', Boolean(enabled)),
  media: (action) => ipcRenderer.invoke('media', action),
  getStats: () => ipcRenderer.invoke('get-stats'),
});
