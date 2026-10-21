/**
 * main.js
 * Electron main process – creates tray, windows, and IPC handlers.
 */

// Load .env from the project root before anything else so DEEPGRAM_API_KEY,
// OPENAI_API_KEY and ANTHROPIC_API_KEY are available to getApiKeys().
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, session, desktopCapturer, shell, dialog } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const os = require('os');
const path = require('path');
const Store = require('electron-store');
const trigger = require('./trigger');
const controlsService = require('./services/controls');
const statsService = require('./services/stats');
const clipboardService = require('./services/clipboard');
const wallpaperService = require('./services/wallpaper');
const powerService = require('./services/power');

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
    saveHistory: true,
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
let wallpaperRevealWindow = null;
let wallpaperApplyInProgress = false;
let wallpaperFolderDialogOpen = false;
let captureWindows = [];
let capsuleConsoleOpen = false;
let overlayPointerInteractive = false;
let overlayHitTestTimer = null;
let capsulePeeked = false;
let overlayVisualState = 'idle';
let consoleOpenBeforeActivity = false;
let overlayContentHeight = 48;
let capsuleOutsideSince = 0;
let recorderWindow = null;
let panelWindow = null;
let panelHideTimer = null;
let panelClosing = false;
let panelDesiredOpen = false;
let appCache = [];
let appCacheAt = 0;
const panelTools = new Set();
const cpuState = { idle: 0, total: 0 };
const networkState = { rx: 0, tx: 0, time: 0, totalRx: 0, totalTx: 0, samples: [] };

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

// ── Island panel window ──────────────────────────────────────────────────────

function hidePanelWindow() {
  panelDesiredOpen = false;
  if (!panelWindow || panelClosing) return;
  panelClosing = true;
  panelWindow.webContents.send('panel-state', { open: false });
  clearTimeout(panelHideTimer);
  panelHideTimer = setTimeout(() => {
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.hide();
    panelClosing = false;
  }, 300);
}

function createPanelWindow() {
  if (panelWindow) return panelWindow;

  const { width } = screen.getPrimaryDisplay().workAreaSize;
  panelWindow = new BrowserWindow({
    title: 'JARVIS Panel',
    width: 820,
    height: 460,
    x: Math.round((width - 820) / 2),
    y: 0,
    frame: false,
    transparent: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    resizable: false,
    focusable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'panel-preload.js'),
    },
  });

  panelWindow.loadFile(path.join(__dirname, 'panel.html'));
  panelWindow.on('page-title-updated', (event) => event.preventDefault());
  panelWindow.webContents.on('did-fail-load', (event, code, description) => {
    console.error(`[JARVIS] Panel page failed to load (${code}): ${description}`);
  });
  panelWindow.webContents.on('did-finish-load', () => {
    if (panelDesiredOpen && panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.webContents.send('panel-state', { open: true });
    }
  });
  panelWindow.on('closed', () => {
    clearTimeout(panelHideTimer);
    panelWindow = null;
    panelClosing = false;
  });
  return panelWindow;
}

function togglePanelWindow() {
  capsuleConsoleOpen = !capsuleConsoleOpen;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  setCapsulePeeked(true);
  overlayWindow.showInactive();
  overlayWindow.webContents.send('capsule-console-state', { open: capsuleConsoleOpen });
  resizeOverlayWindow(capsuleConsoleOpen);
}

function openCapsuleConsole() {
  capsuleConsoleOpen = true;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  setCapsulePeeked(true);
  overlayWindow.showInactive();
  overlayWindow.webContents.send('capsule-console-state', { open: true });
  resizeOverlayWindow(true);
}

function closeCapsuleConsole() {
  if (!capsuleConsoleOpen || !overlayWindow || overlayWindow.isDestroyed()) return;
  capsuleConsoleOpen = false;
  capsuleOutsideSince = 0;
  overlayWindow.webContents.send('capsule-console-state', { open: false });
  resizeOverlayWindow(false);
  setCapsulePeeked(false);
}

function registerCapsuleOutsideDismissal() {
  if (process.platform !== 'win32') return;
  try {
    const { uIOhook } = require('uiohook-napi');
    uIOhook.on('mousedown', () => {
      if (!capsuleConsoleOpen || !overlayWindow || overlayWindow.isDestroyed()) return;
      const bounds = overlayWindow.getBounds();
      const point = screen.getCursorScreenPoint();
      const inside = point.x >= bounds.x && point.x <= bounds.x + bounds.width
        && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
      if (!inside) {
        console.log('[JARVIS] Dismissing island after outside click');
        closeCapsuleConsole();
      }
    });
  } catch (error) {
    console.warn('[JARVIS] Outside-click dismissal unavailable:', error.message);
  }
}

function setCapsulePeeked(peeked) {
  if (capsulePeeked === peeked) return;
  capsulePeeked = peeked;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('capsule-peek-state', { peeked });
  }
}

function resizeOverlayWindow(expanded = capsuleConsoleOpen) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const { width: workAreaWidth } = screen.getPrimaryDisplay().workAreaSize;
  const width = expanded ? 860 : 290;
  const height = expanded ? Math.max(190, overlayContentHeight + 2) : 68;
  overlayWindow.setBounds({
    x: Math.round((workAreaWidth - width) / 2),
    y: 0,
    width,
    height,
  }, false);
  updateOverlayHitTesting();
}

function updateOverlayHitTesting() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const bounds = overlayWindow.getBounds();
  const cursor = screen.getCursorScreenPoint();
  const capsuleWidth = capsuleConsoleOpen ? 840 : 260;
  const capsuleHeight = capsuleConsoleOpen ? overlayContentHeight : 56;
  const left = bounds.x + Math.round((bounds.width - capsuleWidth) / 2);
  const top = bounds.y + 5;
  const overCapsule = cursor.x >= left && cursor.x <= left + capsuleWidth
    && cursor.y >= top && cursor.y <= top + capsuleHeight;
  const overWindow = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width
    && cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height;
  if (capsuleConsoleOpen && !overWindow) {
    if (!capsuleOutsideSince) capsuleOutsideSince = Date.now();
    if (Date.now() - capsuleOutsideSince >= 450) {
      capsuleOutsideSince = 0;
      closeCapsuleConsole();
      return;
    }
  } else {
    capsuleOutsideSince = 0;
  }
  const hoverZone = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width
    && cursor.y >= bounds.y && cursor.y <= bounds.y + 12;
  const canPeek = !capsuleConsoleOpen && overlayVisualState === 'idle';
  if (canPeek && hoverZone) setCapsulePeeked(true);
  else if (canPeek && capsulePeeked && !overCapsule) setCapsulePeeked(false);
  else if (!canPeek) setCapsulePeeked(true);
  const shouldAcceptInput = capsuleConsoleOpen ? overCapsule : (capsulePeeked && overCapsule);
  if (overlayPointerInteractive !== shouldAcceptInput) {
    overlayPointerInteractive = shouldAcceptInput;
    overlayWindow.setIgnoreMouseEvents(!shouldAcceptInput, { forward: true });
  }
}

// ── Overlay window ────────────────────────────────────────────────────────────

function createOverlayWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  overlayWindow = new BrowserWindow({
    title: 'JARVIS Overlay',
    width: 290,
    height: 68,
    x: Math.round((width - 290) / 2),
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: true,
    hasShadow: false,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'overlay-preload.js'),
    },
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.on('page-title-updated', (e) => e.preventDefault());
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.webContents.on('did-fail-load', (event, code, description) => {
    console.error(`[JARVIS] Capsule UI failed to load (${code}): ${description}`);
  });
  overlayWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const prefix = ['log', 'warn', 'error', 'debug'][level] || 'console';
    if (level >= 2) console.error(`[capsule:${prefix}] ${message} (${sourceId}:${line})`);
  });
  overlayWindow.webContents.on('did-finish-load', () => {
    overlayWindow.webContents.send('capsule-console-state', { open: capsuleConsoleOpen });
    overlayWindow.webContents.send('capsule-peek-state', { peeked: capsulePeeked });
  });
  overlayHitTestTimer = setInterval(updateOverlayHitTesting, 60);
  overlayWindow.on('blur', () => {
    if (capsuleConsoleOpen && !wallpaperFolderDialogOpen) closeCapsuleConsole();
  });
  overlayWindow.on('closed', () => {
    if (overlayHitTestTimer) clearInterval(overlayHitTestTimer);
    overlayHitTestTimer = null;
    overlayPointerInteractive = false;
    overlayWindow = null;
  });
  console.log('[JARVIS] Overlay window created');
}

async function startScreenCapture() {
  if (process.platform !== 'win32') throw new Error('Screen selection is currently available on Windows only.');
  if (captureWindows.length) return;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayPointerInteractive = false;
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.hide();
  }
  const displays = screen.getAllDisplays();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 2560, height: 1440 },
    fetchWindowIcons: false,
  });
  if (!sources.length) {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.showInactive();
    throw new Error('Windows did not provide a screen capture source.');
  }

  captureWindows = displays.map((display, index) => {
    const source = sources.find((item) => item.display_id === String(display.id)) || sources[index] || sources[0];
    const { x, y, width, height } = display.bounds;
    const window = new BrowserWindow({
      title: 'JARVIS Screen Capture',
      x, y, width, height,
      frame: false,
      transparent: true,
      fullscreen: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'capture-preload.js'),
      },
    });
    window.loadFile(path.join(__dirname, 'capture.html'));
    window.webContents.once('did-finish-load', () => {
      if (!window.isDestroyed()) {
        window.webContents.send('capture-image', {
          image: source.thumbnail.toDataURL(),
          screenWidth: source.thumbnail.getSize().width,
          screenHeight: source.thumbnail.getSize().height,
        });
      }
    });
    window.on('closed', () => {
      captureWindows = captureWindows.filter((item) => item !== window);
    });
    return window;
  });
}

function closeCaptureWindows() {
  const windows = captureWindows;
  captureWindows = [];
  windows.forEach((window) => {
    if (!window.isDestroyed()) window.close();
  });
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayPointerInteractive = false;
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.showInactive();
  }
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
    if (overlayVisualState === 'idle') consoleOpenBeforeActivity = capsuleConsoleOpen;
    overlayVisualState = state;
    capsuleConsoleOpen = true;
    setCapsulePeeked(true);
    resizeOverlayWindow(true);
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
    overlayVisualState = 'idle';
    capsuleConsoleOpen = consoleOpenBeforeActivity;
    if (!capsuleConsoleOpen) setCapsulePeeked(false);
    resizeOverlayWindow(capsuleConsoleOpen);
    overlayWindow.webContents.send('update-state', { state: 'hide' });
    overlayWindow.webContents.send('capsule-console-state', { open: capsuleConsoleOpen });
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => {
  // Return saved settings; the UI only shows what was explicitly saved
  return store.store;
});

ipcMain.handle('overlay-provider-status', () => {
  const keys = getApiKeys();
  return [
    { id: 'claude', label: 'Claude', connected: Boolean(keys.claude), detail: keys.claude ? 'API key saved' : 'Key not set', color: '#f09564' },
    { id: 'ollama', label: 'Ollama', connected: false, detail: 'Local service status not checked', color: '#a98bff' },
    { id: 'deepgram', label: 'Deepgram', connected: Boolean(keys.deepgram), detail: keys.deepgram ? 'API key saved' : 'Key not set', color: '#44d39a' },
    { id: 'openai', label: 'Whisper', connected: Boolean(keys.openai), detail: keys.openai ? 'OpenAI key saved' : 'OpenAI key not set', color: '#ef5e70' },
  ];
});

ipcMain.on('close-panel', hidePanelWindow);

ipcMain.on('capsule-console-set', (event, open) => {
  capsuleConsoleOpen = Boolean(open);
  resizeOverlayWindow(capsuleConsoleOpen);
});

ipcMain.on('capsule-content-height', (event, height) => {
  if (!Number.isFinite(height)) return;
  overlayContentHeight = Math.max(48, Math.min(380, Math.round(height)));
  if (capsuleConsoleOpen && overlayWindow && !overlayWindow.isDestroyed()) {
    const bounds = overlayWindow.getBounds();
    overlayWindow.setBounds({ ...bounds, height: Math.max(190, overlayContentHeight + 2) }, false);
  }
});

ipcMain.on('capture-selection-complete', (event, selection) => {
  closeCaptureWindows();
  const width = Number(selection?.width) || 0;
  const height = Number(selection?.height) || 0;
  if (width > 1 && height > 1) showOverlay('done', `Region captured · ${Math.round(width)} × ${Math.round(height)}`);
});

ipcMain.on('capture-selection-cancel', closeCaptureWindows);

ipcMain.handle('overlay-get-tasks', () => {
  const tasks = store.get('panelTasks', []);
  return Array.isArray(tasks) ? tasks : [];
});

ipcMain.handle('overlay-save-tasks', (event, tasks) => {
  if (!Array.isArray(tasks)) return false;
  const safeTasks = tasks.slice(0, 50).map((task) => ({
    text: String(task?.text || '').trim().slice(0, 120),
    done: task?.done === true,
  })).filter((task) => task.text);
  store.set('panelTasks', safeTasks);
  return true;
});

ipcMain.handle('overlay-submit-prompt', async (event, text) => {
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
    throw new Error('Enter a prompt under 4,000 characters.');
  }
  const result = await require('./command').processTranscript(text.trim());
  return {
    reply: result.result?.reply || result.proposal?.summary || 'Action submitted for confirmation.',
    status: result.status,
  };
});

ipcMain.handle('overlay-start-dictation', async () => {
  return { ok: await require('./pipeline').startRecording() };
});

ipcMain.handle('overlay-stop-dictation', async () => {
  return { ok: await require('./pipeline').stopRecording() };
});

ipcMain.handle('overlay-open-settings', () => {
  createSettingsWindow();
  return true;
});

ipcMain.handle('overlay-open-sound-settings', async () => {
  if (process.platform === 'win32') await shell.openExternal('ms-settings:sound');
  return true;
});

ipcMain.handle('controls:get-state', () => controlsService.getControls());
ipcMain.handle('controls:set-volume', (event, value) => controlsService.setVolume(value));
ipcMain.handle('controls:toggle-mute', () => controlsService.toggleMute());
ipcMain.handle('controls:set-brightness', (event, value) => controlsService.setBrightness(value));
ipcMain.handle('controls:set-power-scheme', (event, id) => controlsService.setPowerScheme(id));
ipcMain.handle('controls:media', (event, action) => controlsService.media(action));
ipcMain.handle('controls:open-setting', async (event, key) => {
  const settingsUris = {
    wifi: 'ms-settings:network-wifi',
    bluetooth: 'ms-settings:bluetooth',
    airplane: 'ms-settings:network-airplanemode',
    hotspot: 'ms-settings:network-mobilehotspot',
    nearby: 'ms-settings:crossdevice',
    nightlight: 'ms-settings:nightlight',
    battery: 'ms-settings:batterysaver',
    sound: 'ms-settings:sound',
  };
  const uri = settingsUris[key];
  if (!uri || process.platform !== 'win32') return { ok: false, available: false };
  await shell.openExternal(uri);
  return { ok: true };
});

ipcMain.handle('stats:get', () => statsService.getStats());
ipcMain.handle('power:get-state', () => powerService.getState());
ipcMain.handle('power:perform', (event, id) => powerService.performAction(typeof id === 'string' ? id : ''));
ipcMain.handle('power:cancel', () => powerService.cancelScheduledAction());
ipcMain.handle('power:enable-hibernate', () => powerService.enableHibernate());

function closeWallpaperReveal() {
  if (wallpaperRevealWindow && !wallpaperRevealWindow.isDestroyed()) wallpaperRevealWindow.close();
  wallpaperRevealWindow = null;
}

async function showWallpaperReveal(image, display, sourceBounds, duration) {
  closeWallpaperReveal();
  const { x, y, width, height } = display.bounds;
  const originX = Math.max(0, Math.min(width, Math.round(sourceBounds.x + sourceBounds.width / 2 - x)));
  const originY = Math.max(0, Math.min(height, Math.round(sourceBounds.y + 24 - y)));
  const reveal = new BrowserWindow({
    title: 'JARVIS Wallpaper Transition',
    x,
    y,
    width,
    height,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
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
      sandbox: true,
      preload: path.join(__dirname, 'wallpaper-reveal-preload.js'),
    },
  });
  wallpaperRevealWindow = reveal;
  reveal.setIgnoreMouseEvents(true, { forward: true });
  reveal.setAlwaysOnTop(true, 'screen-saver');
  reveal.on('closed', () => {
    if (wallpaperRevealWindow === reveal) wallpaperRevealWindow = null;
  });
  await reveal.loadFile(path.join(__dirname, 'wallpaper-reveal.html'));
  if (reveal.isDestroyed()) throw new Error('Wallpaper transition window closed unexpectedly.');
  reveal.showInactive();
  reveal.webContents.send('wallpaper-reveal:start', { image, originX, originY, duration });
  return reveal;
}

ipcMain.handle('wallpapers:get-state', async () => {
  if (!wallpaperService.isAvailable()) {
    return { available: false, folder: '', items: [], displays: [], transitionEnabled: false, selectedId: '' };
  }
  const folder = store.get('wallpaperFolder', wallpaperService.getDefaultFolder());
  const [items, displays] = await Promise.all([
    Promise.resolve(wallpaperService.listWallpapers(folder)),
    wallpaperService.listDisplays(),
  ]);
  return {
    available: true,
    folder,
    items,
    displays,
    transitionEnabled: store.get('wallpaperTransitionEnabled', true) !== false,
    selectedId: store.get('wallpaperLastSelectedId', ''),
  };
});

ipcMain.handle('wallpapers:choose-folder', async () => {
  if (!wallpaperService.isAvailable()) return { ok: false, error: 'Wallpaper controls are not supported on this platform yet.' };
  const folder = store.get('wallpaperFolder', wallpaperService.getDefaultFolder());
  wallpaperFolderDialogOpen = true;
  let result;
  try {
    result = await dialog.showOpenDialog(overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : undefined, {
      title: 'Choose wallpaper folder',
      defaultPath: folder,
      properties: ['openDirectory'],
    });
  } finally {
    wallpaperFolderDialogOpen = false;
  }
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  store.set('wallpaperFolder', result.filePaths[0]);
  return { ok: true };
});

ipcMain.handle('wallpapers:thumbnail', (event, id) => {
  const folder = store.get('wallpaperFolder', wallpaperService.getDefaultFolder());
  return wallpaperService.getThumbnail(folder, typeof id === 'string' ? id : '');
});

ipcMain.handle('wallpapers:show-in-folder', (event, id) => {
  const folder = store.get('wallpaperFolder', wallpaperService.getDefaultFolder());
  const wallpaper = wallpaperService.getWallpaper(folder, typeof id === 'string' ? id : '');
  if (!wallpaper) return { ok: false, error: 'That wallpaper is no longer available.' };
  shell.showItemInFolder(wallpaper.filePath);
  return { ok: true };
});

ipcMain.handle('wallpapers:set-transition', (event, enabled) => {
  store.set('wallpaperTransitionEnabled', enabled === true);
  return enabled === true;
});

ipcMain.handle('wallpapers:apply', async (event, id, displayId, animate) => {
  if (!wallpaperService.isAvailable()) return { ok: false, error: 'Wallpaper controls are not supported on this platform yet.' };
  if (wallpaperApplyInProgress) return { ok: false, error: 'A wallpaper change is already in progress.' };
  if (typeof id !== 'string' || typeof displayId !== 'string' || typeof animate !== 'boolean') {
    return { ok: false, error: 'Invalid wallpaper selection.' };
  }
  wallpaperApplyInProgress = true;
  let reveal = null;
  let transitionError = '';
  try {
    const folder = store.get('wallpaperFolder', wallpaperService.getDefaultFolder());
    const wallpaper = wallpaperService.getWallpaper(folder, id);
    if (!wallpaper) return { ok: false, error: 'That wallpaper is no longer available. Refresh the folder and try again.' };
    const displays = await wallpaperService.listDisplays();
    const chosenDisplay = displayId === 'all'
      ? null
      : displays.find((display) => display.id === displayId);
    if (displayId !== 'all' && !chosenDisplay) return { ok: false, error: 'The selected display is no longer available. Refresh and try again.' };
    const useTransition = animate && store.get('wallpaperTransitionEnabled', true) !== false
      && !event.sender.isDestroyed();
    const duration = 960;
    const transitionStartedAt = Date.now();
    if (useTransition) {
      try {
        const image = wallpaperService.getThumbnail(folder, id);
        const electronDisplays = screen.getAllDisplays();
        const islandBounds = overlayWindow && !overlayWindow.isDestroyed()
          ? overlayWindow.getBounds()
          : { x: 0, y: 0, width: 1, height: 1 };
        const islandDisplay = screen.getDisplayMatching(islandBounds);
        const targetDisplay = chosenDisplay
          ? electronDisplays[displays.findIndex((display) => display.id === chosenDisplay.id)] || islandDisplay
          : islandDisplay;
        reveal = await showWallpaperReveal(image, targetDisplay, islandBounds, duration);
        await new Promise((resolve) => setTimeout(resolve, 470));
      } catch (error) {
        transitionError = error.message || 'The wallpaper transition could not be shown.';
        console.warn('[JARVIS] Wallpaper transition unavailable:', transitionError);
        closeWallpaperReveal();
        reveal = null;
      }
    }
    const result = await wallpaperService.applyWallpaper(folder, id, displayId === 'all' ? null : displayId);
    store.set('wallpaperLastSelectedId', id);
    if (reveal) {
      const remaining = Math.max(0, duration - (Date.now() - transitionStartedAt));
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    closeWallpaperReveal();
    return { ...result, transitionError };
  } catch (error) {
    closeWallpaperReveal();
    console.error('[JARVIS] Could not set wallpaper:', error);
    return { ok: false, error: error.message || 'Could not set the wallpaper.' };
  } finally {
    wallpaperApplyInProgress = false;
  }
});

ipcMain.handle('overlay-open-panel', () => {
  openCapsuleConsole();
  return true;
});

ipcMain.handle('overlay-confirm-command', async () => {
  await require('./pipeline').confirmCommand();
  return { message: 'Action completed.' };
});

ipcMain.handle('overlay-cancel-command', () => ({
  ok: require('./pipeline').cancelCommand(),
}));

function runFixedCommand(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { shell: false, timeout: 3000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function checkPanelTool(command) {
  try { await execFileAsync(command, ['--version'], { shell: false, timeout: 3000 }); panelTools.add(command); }
  catch (_) { panelTools.delete(command); }
}

async function initializePanelTools() {
  if (process.platform === 'win32') return;
  await Promise.all(['wpctl', 'nmcli', 'bluetoothctl', 'playerctl'].map(checkPanelTool));
}

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; } }
function commandAvailable(command) { return panelTools.has(command); }
function parseVolume(text) { const match = text.match(/Volume:\s*([0-9.]+)/); return match ? Math.round(Math.max(0, Math.min(1, Number(match[1]))) * 100) : 0; }
function parseBool(text, key) { const match = text.match(new RegExp(`${key}:\\s*(yes|no)`, 'i')); return match ? match[1].toLowerCase() === 'yes' : false; }

async function getControlsData() {
  if (process.platform === 'win32') {
    return {
      volume: { available: false, value: 0, muted: false },
      wifi: { available: false, enabled: false, ssid: '' },
      bluetooth: { available: false, enabled: false },
      audio: { available: false, name: '' },
      media: { available: false, playing: false, title: '', artist: '', position: 0, length: 0 },
    };
  }
  const result = { volume: { available: commandAvailable('wpctl'), value: 0, muted: false }, wifi: { available: commandAvailable('nmcli'), enabled: false, ssid: '' }, bluetooth: { available: commandAvailable('bluetoothctl'), enabled: false }, audio: { available: commandAvailable('wpctl'), name: '' }, media: { available: commandAvailable('playerctl'), playing: false, title: '', artist: '', position: 0, length: 0 } };
  if (result.volume.available) { const volume = await runFixedCommand('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']); result.volume.value = parseVolume(volume.stdout); result.volume.muted = /\[MUTED\]/i.test(volume.stdout); const sink = await runFixedCommand('wpctl', ['inspect', '@DEFAULT_AUDIO_SINK@']); const match = sink.stdout.match(/node.description\s*=\s*"([^"]+)/); result.audio.name = match ? match[1] : ''; }
  if (result.wifi.available) { const radio = await runFixedCommand('nmcli', ['radio', 'wifi']); result.wifi.enabled = radio.stdout.trim() === 'enabled'; const ssid = await runFixedCommand('nmcli', ['-t', '-f', 'ACTIVE,SSID', 'dev', 'wifi']); const line = ssid.stdout.split(/\r?\n/).find((item) => item.startsWith('yes:')); result.wifi.ssid = line ? line.slice(4) : ''; }
  if (result.bluetooth.available) { const bluetooth = await runFixedCommand('bluetoothctl', ['show']); result.bluetooth.enabled = parseBool(bluetooth.stdout, 'Powered'); }
  if (result.media.available) { const media = await runFixedCommand('playerctl', ['metadata', '--format', '{{status}}\t{{title}}\t{{artist}}\t{{position}}\t{{mpris:length}}']); const parts = media.stdout.trim().split('\t'); if (parts.length >= 5 && parts[0]) { result.media.playing = parts[0].toLowerCase() === 'playing'; result.media.title = parts[1] || ''; result.media.artist = parts[2] || ''; result.media.position = Number(parts[3]) || 0; result.media.length = Number(parts[4]) || 0; } }
  return result;
}

function readCpu() { const line = readText('/proc/stat').split('\n').find((item) => /^cpu\s/.test(item)); if (!line) return { usage: 0 }; const values = line.trim().split(/\s+/).slice(1).map(Number); const idle = values[3] + (values[4] || 0); const total = values.reduce((sum, value) => sum + value, 0); const deltaTotal = total - cpuState.total; const deltaIdle = idle - cpuState.idle; cpuState.total = total; cpuState.idle = idle; return { usage: deltaTotal > 0 ? Math.round((1 - deltaIdle / deltaTotal) * 100) : 0 }; }
function readNetwork() { let rx = 0; let tx = 0; for (const line of readText('/proc/net/dev').split('\n').slice(2)) { const match = line.trim().match(/^([^:]+):\s*(.*)$/); if (!match || match[1].trim() === 'lo') continue; const fields = match[2].trim().split(/\s+/).map(Number); rx += fields[0] || 0; tx += fields[8] || 0; } const now = Date.now(); const seconds = networkState.time ? Math.max((now - networkState.time) / 1000, .001) : 0; const rxRate = networkState.rx ? Math.max(0, rx - networkState.rx) / seconds : 0; const txRate = networkState.tx ? Math.max(0, tx - networkState.tx) / seconds : 0; if (networkState.time) { networkState.totalRx += Math.max(0, rx - networkState.rx); networkState.totalTx += Math.max(0, tx - networkState.tx); } networkState.rx = rx; networkState.tx = tx; networkState.time = now; networkState.samples.push({ rx: rxRate, tx: txRate }); if (networkState.samples.length > 40) networkState.samples.shift(); return { rxRate, txRate, totalRx: networkState.totalRx, totalTx: networkState.totalTx, samples: networkState.samples }; }
function findCpuTemp() { try { for (const hwmon of fs.readdirSync('/sys/class/hwmon')) { const base = path.join('/sys/class/hwmon', hwmon); if (!/k10temp|coretemp/i.test(readText(path.join(base, 'name')))) continue; const input = fs.readdirSync(base).find((file) => /^temp\d+_input$/.test(file)); if (input) return Number(readText(path.join(base, input)).trim()) / 1000; } } catch (_) {} return null; }
function findGpuTemp(base) { try { const hwmonPath = path.join(base, 'hwmon'); for (const hwmon of fs.readdirSync(hwmonPath)) { const value = readText(path.join(hwmonPath, hwmon, 'temp1_input')).trim(); const temp = Number(value); if (value && Number.isFinite(temp)) return temp / 1000; } } catch (_) {} return null; }
async function readGpu() { const drm = '/sys/class/drm'; try { for (const card of fs.readdirSync(drm).filter((name) => /^card\d+$/.test(name))) { const base = path.join(drm, card, 'device'); const busy = Number(readText(path.join(base, 'gpu_busy_percent')).trim()); if (Number.isFinite(busy)) return { available: true, usage: busy, model: 'AMD GPU', temp: findGpuTemp(base) }; } } catch (_) {} try { const output = await runFixedCommand('nvidia-smi', ['--query-gpu=utilization.gpu,temperature.gpu,name', '--format=csv,noheader,nounits']); if (output.code === 0) { const [usage, temp, ...name] = output.stdout.trim().split(',').map((part) => part.trim()); return { available: true, usage: Number(usage) || 0, temp: Number(temp) || null, model: name.join(', ') || 'NVIDIA GPU' }; } } catch (_) {} return { available: false }; }
async function getStatsData() {
  if (process.platform === 'win32') return statsService.getStats();
  const mem = readText('/proc/meminfo'); const total = Number((mem.match(/^MemTotal:\s+(\d+)/m) || [0, 0])[1]) * 1024; const available = Number((mem.match(/^MemAvailable:\s+(\d+)/m) || [0, 0])[1]) * 1024; let storage = { available: false }; try { const stat = fs.statfsSync('/'); storage = { available: true, used: stat.blocks * stat.bsize - stat.bavail * stat.bsize, total: stat.blocks * stat.bsize }; } catch (_) {} let battery = { available: false }; try { const batteryPath = fs.readdirSync('/sys/class/power_supply', { withFileTypes: true }).find((entry) => entry.name.startsWith('BAT')); if (batteryPath) { const base = path.join('/sys/class/power_supply', batteryPath.name); const capacity = Number(readText(path.join(base, 'capacity')).trim()); battery = { available: Number.isFinite(capacity), capacity, status: readText(path.join(base, 'status')).trim() }; } } catch (_) {} return { cpu: { ...readCpu(), model: (readText('/proc/cpuinfo').match(/^model name\s*:\s*(.+)$/m) || [0, 'CPU'])[1], temp: findCpuTemp() }, memory: { available: total > 0, used: total - available, total }, storage, network: readNetwork(), battery, gpu: await readGpu() };
}

function scanApplications() {
  if (process.platform === 'win32') {
    const startMenuRoots = [
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    ];
    const applications = [];
    const seen = new Set();
    const visit = (directory, depth = 0) => {
      if (depth > 5) return;
      let entries;
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath, depth + 1);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk') && !seen.has(fullPath.toLowerCase())) {
          seen.add(fullPath.toLowerCase());
          let shortcut = {};
          try { shortcut = shell.readShortcutLink(fullPath); } catch (_) {}
          applications.push({
            id: fullPath,
            name: path.basename(entry.name, path.extname(entry.name)),
            icon: shortcut.icon || '',
            resolvedPath: shortcut.target || fullPath,
            kind: 'Desktop app',
          });
        }
      }
    };
    startMenuRoots.forEach((root) => visit(root));
    return applications.sort((a, b) => a.name.localeCompare(b.name));
  }

  const directories = [
    '/usr/share/applications',
    path.join(os.homedir(), '.local/share/applications'),
    '/var/lib/flatpak/exports/share/applications',
    path.join(os.homedir(), '.local/share/flatpak/exports/share/applications'),
  ];
  const applications = [];
  const seen = new Set();

  for (const directory of directories) {
    let files;
    try { files = fs.readdirSync(directory); } catch (_) { continue; }
    for (const file of files) {
      if (!file.endsWith('.desktop') || seen.has(file)) continue;
      let content;
      try { content = fs.readFileSync(path.join(directory, file), 'utf8'); } catch (_) { continue; }
      const values = {};
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z][A-Za-z0-9-]*)=(.*)$/);
        if (match && values[match[1]] === undefined) values[match[1]] = match[2];
      }
      if (!values.Name || !values.Exec || values.NoDisplay === 'true' || values.Hidden === 'true' || values.Terminal === 'true') continue;
      seen.add(file);
      applications.push({ id: file, name: values.Name, icon: values.Icon || '' });
    }
  }
  return applications.sort((a, b) => a.name.localeCompare(b.name));
}

function getCachedApplications(refresh = false) {
  if (refresh || Date.now() - appCacheAt >= 30_000) {
    appCache = scanApplications();
    appCacheAt = Date.now();
  }
  return appCache;
}

let startAppsCache = [];
let startAppsCacheAt = 0;

async function getWindowsStoreApps() {
  if (process.platform !== 'win32') return [];
  if (Date.now() - startAppsCacheAt < 60_000) return startAppsCache;
  const script = String.raw`$ErrorActionPreference='SilentlyContinue'; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress`;
  try {
    const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout.trim());
    const entries = Array.isArray(result) ? result : (result ? [result] : []);
    startAppsCache = entries.filter((entry) => entry?.Name && entry?.AppID).map((entry) => ({
      id: `uwp:${entry.AppID}`,
      name: entry.Name,
      icon: '',
      resolvedPath: '',
      kind: 'Store app',
    }));
    startAppsCacheAt = Date.now();
  } catch (error) {
    console.warn('[JARVIS] Store app indexing unavailable:', error.message);
    startAppsCache = [];
    startAppsCacheAt = Date.now();
  }
  return startAppsCache;
}

async function getApplicationList(refresh = false) {
  if (refresh) startAppsCacheAt = 0;
  const shortcutApps = getCachedApplications(refresh).map((application) => ({ ...application, kind: 'Desktop app' }));
  const storeApps = await getWindowsStoreApps();
  const seen = new Set();
  return [...shortcutApps, ...storeApps].filter((application) => {
    const key = `${application.name.toLowerCase()}|${application.id.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((application) => {
    const usage = store.get('appUsage', {})[application.id] || {};
    return { ...application, launchCount: usage.count || 0, lastUsed: usage.lastUsed || 0 };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function recordAppLaunch(id) {
  const usage = store.get('appUsage', {});
  const current = usage[id] || { count: 0, lastUsed: 0 };
  usage[id] = { count: current.count + 1, lastUsed: Date.now() };
  store.set('appUsage', usage);
}

async function launchApplication(id) {
  const application = (await getApplicationList()).find((item) => item.id === id);
  if (!application) return { ok: false, error: 'Unknown application.' };
  if (process.platform === 'win32') {
    const args = application.id.startsWith('uwp:')
      ? [`shell:AppsFolder\\${application.id.slice(4)}`]
      : [application.id];
    await new Promise((resolve, reject) => {
      execFile('explorer.exe', args, { shell: false, detached: true, stdio: 'ignore', windowsHide: true }, (error) => {
        if (error) reject(error); else resolve();
      });
    }).catch((error) => {
      console.error(`[JARVIS] app launch failed: ${error.message}`);
      throw new Error('Windows could not open that app.');
    });
    recordAppLaunch(id);
    return { ok: true };
  }
  const desktopId = application.id.endsWith('.desktop') ? application.id.slice(0, -8) : application.id;
  await new Promise((resolve, reject) => execFile('gtk-launch', [desktopId], { shell: false, detached: true, stdio: 'ignore' }, (error) => error ? reject(error) : resolve()));
  recordAppLaunch(id);
  return { ok: true };
}

async function getApplicationIcon(id) {
  const application = (await getApplicationList()).find((item) => item.id === id);
  if (!application) return '';
  const cacheDirectory = path.join(app.getPath('userData'), 'app-icons');
  const cachePath = path.join(cacheDirectory, `${crypto.createHash('sha256').update(application.id).digest('hex')}-large.png`);
  try {
    const cachedIcon = fs.readFileSync(cachePath);
    if (cachedIcon.length) return `data:image/png;base64,${cachedIcon.toString('base64')}`;
  } catch (_) {}
  const target = application.icon || application.resolvedPath || application.id;
  try {
    const image = await app.getFileIcon(target, { size: 'large' });
    if (image.isEmpty()) return '';
    const png = image.toPNG();
    fs.mkdirSync(cacheDirectory, { recursive: true });
    fs.writeFileSync(cachePath, png);
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (_) { return ''; }
}

ipcMain.handle('get-apps', async () => (await getApplicationList()).map(({ id, name, icon }) => ({ id, name, icon })));
ipcMain.handle('launch-app', (event, id) => {
  return launchApplication(id).then((result) => {
    if (result.ok) hidePanelWindow();
    return result;
  });
});

ipcMain.handle('apps:list', (event, refresh) => getApplicationList(refresh === true));
ipcMain.handle('apps:launch', async (event, id) => {
  if (typeof id !== 'string') return { ok: false, error: 'Invalid app selection.' };
  const result = await launchApplication(id);
  if (result.ok) closeCapsuleConsole();
  return result;
});
ipcMain.handle('apps:icon', (event, id) => typeof id === 'string' ? getApplicationIcon(id) : '');

ipcMain.handle('clipboard:list', (event, query) => clipboardService.list(store, typeof query === 'string' ? query.slice(0, 500) : ''));
ipcMain.handle('clipboard:sync', () => clipboardService.captureCurrent(store));
ipcMain.handle('clipboard:copy', (event, id) => typeof id === 'string' ? clipboardService.copy(store, id) : { ok: false, error: 'Invalid clipboard item.' });
ipcMain.handle('clipboard:pin', (event, id, pinned) => typeof id === 'string' && clipboardService.updateItem(store, id, { pinned: pinned === true }));
ipcMain.handle('clipboard:delete', (event, id) => typeof id === 'string' && clipboardService.remove(store, id));
ipcMain.handle('clipboard:clear', () => clipboardService.clear(store));
ipcMain.handle('clipboard:is-paused', () => clipboardService.isPaused(store));
ipcMain.handle('clipboard:set-paused', (event, paused) => clipboardService.setPaused(store, paused === true));

ipcMain.handle('power-action', async (event, id) => {
  const result = await powerService.performAction(typeof id === 'string' ? id : '');
  if (result.ok && !result.scheduled) hidePanelWindow();
  return result;
});

ipcMain.handle('get-controls', getControlsData);
ipcMain.handle('set-volume', async (event, value) => {
  if (!commandAvailable('wpctl') || !Number.isFinite(value)) return { ok: false, available: false };
  const result = await runFixedCommand('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', `${Math.round(Math.max(0, Math.min(100, value)))}%`]);
  return { ok: result.code === 0, available: true };
});
ipcMain.handle('toggle-mute', async () => {
  if (!commandAvailable('wpctl')) return { ok: false, available: false };
  const result = await runFixedCommand('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']);
  return { ok: result.code === 0, available: true };
});
ipcMain.handle('set-wifi', async (event, enabled) => {
  if (!commandAvailable('nmcli') || typeof enabled !== 'boolean') return { ok: false, available: false };
  const result = await runFixedCommand('nmcli', ['radio', 'wifi', enabled ? 'on' : 'off']);
  return { ok: result.code === 0, available: true };
});
ipcMain.handle('set-bluetooth', async (event, enabled) => {
  if (!commandAvailable('bluetoothctl') || typeof enabled !== 'boolean') return { ok: false, available: false };
  const result = await runFixedCommand('bluetoothctl', ['power', enabled ? 'on' : 'off']);
  return { ok: result.code === 0, available: true };
});
ipcMain.handle('media', async (event, action) => {
  if (!commandAvailable('playerctl') || !['play-pause', 'next', 'previous'].includes(action)) return { ok: false, available: false };
  const result = await runFixedCommand('playerctl', [action]);
  return { ok: result.code === 0, available: true };
});
ipcMain.handle('get-stats', getStatsData);

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
  store.set('saveHistory', settings.saveHistory !== false);
  store.set('hotkey', settings.hotkey);
  logKeyPresence('after save');
  return true;
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  console.log('[JARVIS] App ready');
  logKeyPresence('startup');
  await initializePanelTools();

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
  // Pass window creators so argv flags can open their matching surfaces.
  trigger.init(store, createSettingsWindow, togglePanelWindow, startScreenCapture);
  registerCapsuleOutsideDismissal();
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
