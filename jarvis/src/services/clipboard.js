'use strict';

const crypto = require('crypto');
const { clipboard, nativeImage } = require('electron');

const HISTORY_KEY = 'clipboardHistory';
const PAUSED_KEY = 'clipboardCapturePaused';
const MAX_ITEMS = 100;
const MAX_IMAGE_ITEMS = 18;
const MAX_TEXT_LENGTH = 20_000;
const MAX_IMAGE_SIZE = 320;
const MAX_IMAGE_DATA_URL_LENGTH = 180_000;
const OPT_OUT_FORMATS = new Set([
  'excludeclipboardcontentfrommonitorprocessing',
  'canincludeinclipboardhistory',
]);
let ignoreUntilClipboardChanges = null;

function getItems(store) {
  const value = store.get(HISTORY_KEY, []);
  return Array.isArray(value) ? value : [];
}

function safeFormats() {
  try { return clipboard.availableFormats().map((format) => format.toLowerCase()); }
  catch (_) { return []; }
}

function isCaptureExcluded(formats) {
  return formats.some((format) => OPT_OUT_FORMATS.has(format));
}

function getClipboardEntry() {
  const formats = safeFormats();
  if (!formats.length || isCaptureExcluded(formats)) return null;

  let text = '';
  try { text = clipboard.readText(); } catch (_) {}
  if (text.trim()) {
    const normalized = text.replace(/\r\n/g, '\n').slice(0, MAX_TEXT_LENGTH);
    return {
      id: crypto.createHash('sha256').update(`text\0${normalized}`).digest('hex'),
      type: 'text',
      text: normalized,
      preview: normalized.slice(0, 180),
      time: Date.now(),
      pinned: false,
    };
  }

  try {
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      const size = image.getSize();
      const scale = Math.min(1, MAX_IMAGE_SIZE / Math.max(size.width, size.height));
      let thumbnail = scale < 1
        ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' })
        : image;
      let dataUrl = thumbnail.toDataURL();
      if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
        thumbnail = image.resize({ width: 160, height: 160, quality: 'good' });
        dataUrl = thumbnail.toDataURL();
      }
      if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) return null;
      return {
        id: crypto.createHash('sha256').update(`image\0${dataUrl}`).digest('hex'),
        type: 'image',
        dataUrl,
        preview: `Image · ${size.width} × ${size.height}`,
        width: size.width,
        height: size.height,
        time: Date.now(),
        pinned: false,
      };
    }
  } catch (_) {}
  return null;
}

function captureCurrent(store) {
  if (store.get(PAUSED_KEY, false)) return { captured: false, item: null, paused: true };
  const entry = getClipboardEntry();
  if (!entry) return { captured: false, item: null, paused: false };
  if (entry.id === ignoreUntilClipboardChanges) return { captured: false, item: null, paused: false };
  ignoreUntilClipboardChanges = null;

  const items = getItems(store);
  const existingIndex = items.findIndex((item) => item.id === entry.id);
  if (existingIndex === 0) return { captured: false, item: null, paused: false };
  if (existingIndex >= 0) {
    entry.pinned = items[existingIndex].pinned === true;
    items.splice(existingIndex, 1);
  }
  items.unshift(entry);
  let imageCount = 0;
  const bounded = items.filter((item) => {
    if (item.type !== 'image') return true;
    imageCount += 1;
    return imageCount <= MAX_IMAGE_ITEMS;
  }).slice(0, MAX_ITEMS);
  store.set(HISTORY_KEY, bounded);
  return { captured: true, item: entry, paused: false };
}

function list(store, query = '') {
  const normalized = String(query || '').trim().toLowerCase();
  const items = getItems(store);
  const filtered = normalized ? items.filter((item) => item.type === 'image'
    ? String(item.preview || '').toLowerCase().includes(normalized)
    : String(item.text || '').toLowerCase().includes(normalized)) : items;
  return filtered.slice().sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.time - a.time);
}

function copy(store, id) {
  const item = getItems(store).find((entry) => entry.id === id);
  if (!item) return { ok: false, error: 'Clipboard item not found.' };
  try {
    if (item.type === 'image' && item.dataUrl) clipboard.writeImage(nativeImage.createFromDataURL(item.dataUrl));
    else clipboard.writeText(String(item.text || ''));
    return { ok: true };
  } catch (_) {
    return { ok: false, error: 'Could not copy this clipboard item.' };
  }
}

function updateItem(store, id, updates) {
  const items = getItems(store);
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return false;
  items[index] = { ...items[index], ...updates };
  store.set(HISTORY_KEY, items);
  return true;
}

function remove(store, id) {
  const items = getItems(store).filter((item) => item.id !== id);
  store.set(HISTORY_KEY, items);
  return true;
}

function clear(store) {
  store.set(HISTORY_KEY, []);
  ignoreUntilClipboardChanges = getClipboardEntry()?.id || null;
  return true;
}

function setPaused(store, paused) {
  store.set(PAUSED_KEY, Boolean(paused));
  return Boolean(paused);
}

function isPaused(store) {
  return store.get(PAUSED_KEY, false) === true;
}

module.exports = { captureCurrent, list, copy, updateItem, remove, clear, setPaused, isPaused };
