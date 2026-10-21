'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tif', '.tiff']);
const MAX_WALLPAPERS = 300;
const THUMBNAIL_SIZE = { width: 440, height: 260 };
const MONITOR_CACHE_MS = 30_000;
let monitorCache = [];
let monitorCacheAt = 0;
const wallpaperIndexes = new Map();

function getDefaultFolder() {
  return path.join(app.getPath('pictures'), 'Wallpapers');
}

function getWallpaperId(filePath, stat) {
  return crypto.createHash('sha256')
    .update(`${filePath}\0${stat.size}\0${stat.mtimeMs}`)
    .digest('hex');
}

function scanWallpapers(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) {
    throw new Error('Choose a valid wallpaper folder.');
  }
  let entries;
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') {
      wallpaperIndexes.set(folder, new Map());
      return [];
    }
    throw new Error(`Could not read the wallpaper folder: ${error.message}`);
  }
  const wallpapers = entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .slice(0, MAX_WALLPAPERS)
    .map((entry) => {
      const filePath = path.join(folder, entry.name);
      let stat;
      try { stat = fs.statSync(filePath); }
      catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error(`Could not inspect wallpaper "${entry.name}": ${error.message}`);
      }
      if (!stat.isFile()) return null;
      return {
        id: getWallpaperId(filePath, stat),
        filePath,
        name: entry.name,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      };
    })
    .filter(Boolean);
  wallpaperIndexes.set(folder, new Map(wallpapers.map((wallpaper) => [wallpaper.id, wallpaper])));
  return wallpapers.map(({ id, name, size, modifiedAt }) => ({ id, name, size, modifiedAt }));
}

function findWallpaper(folder, id) {
  if (typeof folder !== 'string' || typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return null;
  let index = wallpaperIndexes.get(folder);
  if (!index) {
    scanWallpapers(folder);
    index = wallpaperIndexes.get(folder);
  }
  const wallpaper = index.get(id);
  if (!wallpaper) return null;
  let stat;
  try { stat = fs.statSync(wallpaper.filePath); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Could not inspect wallpaper "${wallpaper.name}": ${error.message}`);
  }
  return stat.isFile() && getWallpaperId(wallpaper.filePath, stat) === id ? wallpaper : null;
}

async function runWallpaperScript(action, args = []) {
  const script = path.join(__dirname, 'wallpaper.ps1');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Action',
    action,
    ...args,
  ], {
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 256 * 1024,
    shell: false,
  });
  return stdout.trim();
}

async function listDisplays() {
  if (Date.now() - monitorCacheAt < MONITOR_CACHE_MS) return monitorCache;
  const output = await runWallpaperScript('list');
  const parsed = output ? JSON.parse(output) : [];
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  monitorCache = entries
    .filter((entry) => typeof entry?.id === 'string' && entry.id)
    .map((entry, index) => ({
      id: entry.id,
      name: `Display ${index + 1}`,
      bounds: entry.bounds,
    }));
  monitorCacheAt = Date.now();
  return monitorCache;
}

function listWallpapers(folder) {
  return scanWallpapers(folder);
}

function getWallpaper(folder, id) {
  return findWallpaper(folder, id);
}

function getThumbnail(folder, id) {
  const wallpaper = findWallpaper(folder, id);
  if (!wallpaper) throw new Error('That wallpaper is no longer available. Refresh the folder and try again.');
  const cacheDirectory = path.join(app.getPath('userData'), 'wallpaper-thumbnails');
  const cachePath = path.join(cacheDirectory, `${wallpaper.id}.png`);
  try {
    const cached = fs.readFileSync(cachePath);
    if (cached.length) return `data:image/png;base64,${cached.toString('base64')}`;
  } catch (_) {}
  const image = nativeImage.createFromPath(wallpaper.filePath);
  if (image.isEmpty()) throw new Error(`Could not read image "${wallpaper.name}".`);
  const thumbnail = image.resize({ ...THUMBNAIL_SIZE, quality: 'good' }).toPNG();
  fs.mkdirSync(cacheDirectory, { recursive: true });
  fs.writeFileSync(cachePath, thumbnail);
  return `data:image/png;base64,${thumbnail.toString('base64')}`;
}

async function applyWallpaper(folder, id, displayId) {
  const wallpaper = findWallpaper(folder, id);
  if (!wallpaper) throw new Error('That wallpaper is no longer available. Refresh the folder and try again.');
  const displays = await listDisplays();
  if (displayId !== null && !displays.some((display) => display.id === displayId)) {
    throw new Error('The selected display is no longer available. Refresh and try again.');
  }
  await runWallpaperScript('apply', [
    '-Path',
    wallpaper.filePath,
    '-MonitorId',
    displayId || '',
  ]);
  return { ok: true, name: wallpaper.name };
}

module.exports = {
  isAvailable: () => true,
  getDefaultFolder,
  listDisplays,
  listWallpapers,
  getWallpaper,
  getThumbnail,
  applyWallpaper,
};
