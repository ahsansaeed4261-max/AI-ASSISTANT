'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureAPI', {
  onImage: (callback) => ipcRenderer.on('capture-image', (event, image) => callback(image)),
  completeSelection: (selection) => ipcRenderer.send('capture-selection-complete', selection),
  cancel: () => ipcRenderer.send('capture-selection-cancel'),
});
