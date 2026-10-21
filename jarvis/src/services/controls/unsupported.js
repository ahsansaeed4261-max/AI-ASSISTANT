'use strict';

const unavailable = async () => ({ available: false, reason: 'Windows controls are not supported on this platform.' });

module.exports = {
  getControls: unavailable,
  setBrightness: unavailable,
  setVolume: unavailable,
  toggleMute: unavailable,
  media: unavailable,
  getPowerSchemes: unavailable,
  setPowerScheme: unavailable,
  openSetting: unavailable,
};
