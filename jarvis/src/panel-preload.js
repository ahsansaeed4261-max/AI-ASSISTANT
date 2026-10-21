const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panelAPI', {
  onState: (callback) => ipcRenderer.on('panel-state', (event, data) => callback(data)),
  closePanel: () => ipcRenderer.send('close-panel'),
});
