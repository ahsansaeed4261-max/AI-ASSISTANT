/**
 * main.js
 * Electron main process – creates tray, windows, and IPC handlers.
 */

// Load .env from the project root before anything else so DEEPGRAM_API_KEY,
// OPENAI_API_KEY and ANTHROPIC_API_KEY are available to getApiKeys().
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, session } = require('electron');
const path = require('path');
const Store = require('electron-store');
const trigger = require('./trigger');

// ── Fast exit for --action ────────────────────────────────────────────────────
// If this process was launched with --action, run it and quit immediately.
// This must happen before requestSingleInstanceLock so it never waits for
// a running instance and never creates any windows.
const _actionIdx = process.argv.indexOf('--action');
if (_actionIdx !== -1) {
  const _jsonStr = process.argv[_actionIdx + 1];
  const { runAction } = require('./actions');

  app.whenReady().then(async () => {
    if (!_jsonStr) {
      process.stderr.write(JSON.stringify({ ok: false, error: '--action requires a JSON argument' }) + '\n');
      app.exit(1);
      return;
    }
    try {
      const result = await runAction(_jsonStr);
      process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
      app.exit(0);
    } catch (err) {
      process.stderr.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
      app.exit(1);
    }
  });

  // Skip everything else in this file – no lock, no tray, no recorder
  return;
}

// ── Single-instance lock (must happen before app.whenReady) ──────────────────
// If another instance is already running, forward our argv to it and quit.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // This is the second instance – the 'second-instance' handler in the
  // running instance will receive our argv via the lock mechanism.
  app.quit();
  // Do NOT call process.exit() here; app.quit() is enough and lets Electron
  // clean up properly before exiting.
  return;
}

// Wire up the second-instance handler BEFORE app.whenReady so we don't
// miss signals that arrive during startup.
app.on('second-instance', (event, argv, workingDirectory) => {
  // argv from the second process is forwarded here
  trigger.handleArgv(argv);
});

// ── Store ────────────────────────────────────────────────────────────────────

const store = new Store({
  defaults: {
    apiKeys: {
      claude: '',
      openai: '',
      deepgram: '',
      groq: '',
      gemini: '',
    },
    cleanupProvider: 'auto',
    micDeviceId: '',
    history: [],
    hotkey: {
      ctrl: true,
      shift: false,
      alt: false,
      win: true,
    },
  },
});

// ── API key resolver ──────────────────────────────────────────────────────────
// Called fresh on every request so env-var changes and saved settings are
// always current.  Logs presence (true/false) only – never any key value.

function getApiKeys() {
  const saved = store.get('apiKeys') || {};

  const keys = {
    deepgram : saved.deepgram  || process.env.DEEPGRAM_API_KEY   || '',
    openai   : saved.openai    || process.env.OPENAI_API_KEY     || '',
    claude   : saved.claude    || process.env.ANTHROPIC_API_KEY  || '',
    groq     : saved.groq      || process.env.GROQ_API_KEY       || '',
    gemini   : saved.gemini    || process.env.GEMINI_API_KEY     || '',
  };

  return keys;
}

function logKeyPresence(label) {
  const k = getApiKeys();
  console.log(
    `[JARVIS] ${label} – keys present:`,
    `deepgram=${!!k.deepgram}`,
    `openai=${!!k.openai}`,
    `claude=${!!k.claude}`,
    `groq=${!!k.groq}`,
    `gemini=${!!k.gemini}`
  );
}

// ── Window references ────────────────────────────────────────────────────────

let tray = null;
let settingsWindow = null;
let overlayWindow = null;
let recorderWindow = null;

console.log('[JARVIS] Starting...');

// Global error guards
process.on('uncaughtException', (err) => console.error('[JARVIS] Uncaught:', err));
process.on('unhandledRejection', (r) => console.error('[JARVIS] Unhandled rejection:', r));

// ── Tray ─────────────────────────────────────────────────────────────────────

function createTray() {
  // Inline 16×16 tray icon (white microphone on transparent bg)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/' +
    '9hAAAA2UlEQVQ4T6WTMQrCQBBFZ72CpZfwAJ7EO3gEL+AtbMUTeAQPIFiKoI2g' +
    'hSCIhYiKoIggCOqfZSFkWTbJwoM/zLz5b2Z3doUxJlBKLYjoMSKqACillDHGbA' +
    'FYSikDQAghIqK11h4Ax0MIoZRSVkT0EEIopdQOwNkYswWw11rfAFhrfQVgrfUV' +
    'gDXGWADYG2MOADZKqScAO611DsBKa30GYK21fgOwMsYcAOzGcRwA7JxzOwCbvu8' +
    'BYOu9fwPYee8/AGzHcRwB7Ma2HQDshxA2AKy11g8AO+/9C8BijDkDsNZaXwCct' +
    'f4Dpz5a3L9ILYIAAAAASUVORK5CYII='
  );

  tray = new Tray(icon);
  tray.setToolTip('JARVIS – Voice Dictation');

  const menu = Menu.buildFromTemplate([
    { label: 'Settings', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
  tray.on('double-click', () => createSettingsWindow());

  console.log('[JARVIS] Tray ready');
}

// ── Settings window ───────────────────────────────────────────────────────────

function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.focus(); return; }

  settingsWindow = new BrowserWindow({
    width: 450,
    height: 700,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    title: 'JARVIS Settings',
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'settings-preload.js'),
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.setMenu(null);
  settingsWindow.on('closed', () => { settingsWindow = null; });
  console.log('[JARVIS] Settings window created');
}

// ── Overlay window ────────────────────────────────────────────────────────────

function createOverlayWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  overlayWindow = new BrowserWindow({
    title: 'JARVIS Overlay',
    width: 520,
    height: 220,
    x: Math.round((width - 520) / 2),
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'overlay-preload.js'),
    },
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.on('page-title-updated', (e) => e.preventDefault());
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  console.log('[JARVIS] Overlay window created');
}

// ── Hidden recorder window ────────────────────────────────────────────────────

function createRecorderWindow() {
  recorderWindow = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,   // prevent hidden-window throttling
      preload: path.join(__dirname, 'recorder-preload.js'),
    },
  });

  // Forward renderer console.log / console.error to the terminal
  recorderWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const prefix = ['[recorder:log]', '[recorder:warn]', '[recorder:error]', '[recorder:debug]'][level] ?? '[recorder]';
    console.log(`${prefix} ${message}  (${sourceId}:${line})`);
  });

  recorderWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[recorder] render-process-gone:', details.reason, details.exitCode);
  });

  recorderWindow.webContents.on('did-fail-load', (event, code, desc, url) => {
    console.error('[recorder] did-fail-load:', code, desc, url);
  });

  recorderWindow.loadFile(path.join(__dirname, 'recorder.html'));
  console.log('[JARVIS] Recorder window created');
}

// ── Overlay helper (called by pipeline.js) ───────────────────────────────────

let overlayTimer = null;

function showOverlay(state, text) {
  console.log('[overlay] showOverlay:', state, overlayWindow ? 'window ok' : 'NO WINDOW');
  if (!overlayWindow) return;
  clearTimeout(overlayTimer);
  if (state === 'recording' || state === 'thinking' || state === 'done' || state === 'error' || state === 'confirm') {
    const payload = { state, text };
    const pending = state === 'confirm' ? require('./command').currentPendingCommand() : null;
    if (pending) {
      payload.summary = pending.summary;
      payload.action = pending.action;
      payload.params = pending.params;
    }
    overlayWindow.webContents.send('update-state', payload);
    overlayWindow.showInactive();
    if (state === 'done' || state === 'error') {
      overlayTimer = setTimeout(() => showOverlay('hide'), state === 'error' ? 3500 : 1200);
    }
  } else {
    overlayWindow.webContents.send('update-state', { state: 'hide' });
    overlayTimer = setTimeout(() => { if (overlayWindow) overlayWindow.hide(); }, 600);
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => {
  // Return saved settings; the UI only shows what was explicitly saved
  return store.store;
});

ipcMain.handle('get-mic-device-id', () => store.get('micDeviceId') || '');

ipcMain.handle('get-history', () => {
  const history = store.get('history');
  return Array.isArray(history) ? history : [];
});

ipcMain.handle('clear-history', () => {
  store.set('history', []);
  return true;
});

ipcMain.handle('save-settings', (event, settings) => {
  // Ensure field names match exactly what getApiKeys() reads.
  store.set('apiKeys', {
    claude:   (settings.apiKeys?.claude   || '').trim(),
    openai:   (settings.apiKeys?.openai   || '').trim(),
    deepgram: (settings.apiKeys?.deepgram || '').trim(),
    groq:     (settings.apiKeys?.groq     || '').trim(),
    gemini:   (settings.apiKeys?.gemini   || '').trim(),
  });

  const cleanupProviders = new Set(['auto', 'ollama', 'groq', 'claude', 'openai', 'gemini']);
  const cleanupProvider = String(settings.cleanupProvider || 'auto').trim().toLowerCase();
  store.set('cleanupProvider', cleanupProviders.has(cleanupProvider) ? cleanupProvider : 'auto');
  store.set('micDeviceId', typeof settings.micDeviceId === 'string' ? settings.micDeviceId : '');
  store.set('hotkey', settings.hotkey);
  logKeyPresence('after save');
  return true;
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  console.log('[JARVIS] App ready');
  logKeyPresence('startup');

  // Allow microphone access for this app's own renderer windows
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      console.log('[JARVIS] Granting media permission request');
      callback(true);
    } else {
      callback(false);
    }
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media') return true;
    return false;
  });

  createTray();

  // Overlay pill is created on every platform
  createOverlayWindow();

  createRecorderWindow();

  // Pipeline registers its IPC listeners (recorder-ready, recorder-audio-ready)
  require('./pipeline');

  // trigger.js: starts uiohook on Windows, handles argv on Linux.
  // Pass createSettingsWindow so --settings can open it from any instance.
  trigger.init(store, createSettingsWindow);
});

app.on('window-all-closed', () => {
  // Stay alive in the system tray – never quit just because windows closed
});

app.on('before-quit', () => {
  console.log('[JARVIS] Quitting');
  trigger.stop();          // shuts down uiohook on Windows, no-op on Linux
  if (tray) tray.destroy();
});

// ── Exports for sibling modules ───────────────────────────────────────────────

module.exports = { store, showOverlay, getApiKeys };
