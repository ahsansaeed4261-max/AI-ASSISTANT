const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorderAPI', {
  signalReady: () => ipcRenderer.send('recorder-ready'),
  getMicDeviceId: () => ipcRenderer.invoke('get-mic-device-id'),
  onStart: (callback) => ipcRenderer.on('recorder-start', () => callback()),
  onStop: (callback) => ipcRenderer.on('recorder-stop', () => callback()),
  sendAudio: (base64) => ipcRenderer.send('recorder-audio-ready', base64),
});
