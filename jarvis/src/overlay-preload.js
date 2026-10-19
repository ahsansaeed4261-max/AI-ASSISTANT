const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  onUpdateState: (callback) => {
    ipcRenderer.on('update-state', (event, data) => callback(data));
  }
});
