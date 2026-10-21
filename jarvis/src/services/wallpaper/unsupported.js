'use strict';

function unsupported() {
  throw new Error('Wallpaper controls are not supported on this platform yet.');
}

module.exports = {
  isAvailable: () => false,
  getDefaultFolder: unsupported,
  listDisplays: unsupported,
  listWallpapers: unsupported,
  getWallpaper: unsupported,
  getThumbnail: unsupported,
  applyWallpaper: unsupported,
};
