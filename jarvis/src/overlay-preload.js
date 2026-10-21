const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  onUpdateState: (callback) => {
    ipcRenderer.on('update-state', (event, data) => callback(data));
  },
  onConsoleState: (callback) => {
    ipcRenderer.on('capsule-console-state', (event, data) => callback(data));
  },
  onPeekState: (callback) => {
    ipcRenderer.on('capsule-peek-state', (event, data) => callback(data));
  },
  setConsoleOpen: (open) => ipcRenderer.send('capsule-console-set', Boolean(open)),
  reportContentHeight: (height) => ipcRenderer.send('capsule-content-height', Number(height)),
  getTasks: () => ipcRenderer.invoke('overlay-get-tasks'),
  saveTasks: (tasks) => ipcRenderer.invoke('overlay-save-tasks', tasks),
  submitPrompt: (text) => ipcRenderer.invoke('overlay-submit-prompt', text),
  startDictation: () => ipcRenderer.invoke('overlay-start-dictation'),
  stopDictation: () => ipcRenderer.invoke('overlay-stop-dictation'),
  openSettings: () => ipcRenderer.invoke('overlay-open-settings'),
  openSoundSettings: () => ipcRenderer.invoke('overlay-open-sound-settings'),
  getProviderStatus: () => ipcRenderer.invoke('overlay-provider-status'),
  getControlsState: () => ipcRenderer.invoke('controls:get-state'),
  setVolume: (value) => ipcRenderer.invoke('controls:set-volume', Number(value)),
  toggleMute: () => ipcRenderer.invoke('controls:toggle-mute'),
  setBrightness: (value) => ipcRenderer.invoke('controls:set-brightness', Number(value)),
  setPowerScheme: (id) => ipcRenderer.invoke('controls:set-power-scheme', String(id)),
  media: (action) => ipcRenderer.invoke('controls:media', String(action)),
  openSystemSetting: (key) => ipcRenderer.invoke('controls:open-setting', String(key)),
  getStats: () => ipcRenderer.invoke('stats:get'),
  openPanel: (section) => ipcRenderer.invoke('overlay-open-panel', section),
  confirmCommand: () => ipcRenderer.invoke('overlay-confirm-command'),
  cancelCommand: () => ipcRenderer.invoke('overlay-cancel-command'),
});
