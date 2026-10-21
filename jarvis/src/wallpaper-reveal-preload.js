'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wallpaperReveal', {
  onStart: (callback) => ipcRenderer.once('wallpaper-reveal:start', (event, data) => callback(data)),
});
