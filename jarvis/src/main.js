/**
 * main.js
 * Electron main process – creates tray, windows, and IPC handlers.
 */

// Load .env from the project root before anything else so DEEPGRAM_API_KEY,
// OPENAI_API_KEY and ANTHROPIC_API_KEY are available to getApiKeys().
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, session } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const os = require('os');
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
let recorderWindow = null;
let panelWindow = null;
let panelHideTimer = null;
let panelClosing = false;
let appCache = [];
let appCacheAt = 0;
let powerActionRunning = false;
const panelTools = new Set();
const cpuState = { idle: 0, total: 0 };
const networkState = { rx: 0, tx: 0, time: 0, totalRx: 0, totalTx: 0, samples: [] };

const POWER_ACTIONS = {
  lock: ['loginctl', ['lock-session']],
  sleep: ['systemctl', ['suspend']],
  restart: ['systemctl', ['reboot']],
  shutdown: ['systemctl', ['poweroff']],
};

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
  panelWindow.on('blur', hidePanelWindow);
  panelWindow.on('closed', () => {
    clearTimeout(panelHideTimer);
    panelWindow = null;
    panelClosing = false;
  });
  return panelWindow;
}

function togglePanelWindow() {
  const panel = createPanelWindow();
  if (panel.isVisible()) {
    hidePanelWindow();
    return;
  }

  getCachedApplications();
  clearTimeout(panelHideTimer);
  panelClosing = false;
  panel.show();
  panel.focus();
  const sendOpen = () => {
    if (panel && !panel.isDestroyed()) panel.webContents.send('panel-state', { open: true });
  };
  if (panel.webContents.isLoading()) {
    panel.webContents.once('did-finish-load', () => setTimeout(sendOpen, 60));
  } else {
    sendOpen();
  }
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

ipcMain.on('close-panel', hidePanelWindow);

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
  await Promise.all(['wpctl', 'nmcli', 'bluetoothctl', 'playerctl'].map(checkPanelTool));
}

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; } }
function commandAvailable(command) { return panelTools.has(command); }
function parseVolume(text) { const match = text.match(/Volume:\s*([0-9.]+)/); return match ? Math.round(Math.max(0, Math.min(1, Number(match[1]))) * 100) : 0; }
function parseBool(text, key) { const match = text.match(new RegExp(`${key}:\\s*(yes|no)`, 'i')); return match ? match[1].toLowerCase() === 'yes' : false; }

async function getControlsData() {
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
async function getStatsData() { const mem = readText('/proc/meminfo'); const total = Number((mem.match(/^MemTotal:\s+(\d+)/m) || [0, 0])[1]) * 1024; const available = Number((mem.match(/^MemAvailable:\s+(\d+)/m) || [0, 0])[1]) * 1024; let storage = { available: false }; try { const stat = fs.statfsSync('/'); storage = { available: true, used: stat.blocks * stat.bsize - stat.bavail * stat.bsize, total: stat.blocks * stat.bsize }; } catch (_) {} let battery = { available: false }; try { const batteryPath = fs.readdirSync('/sys/class/power_supply', { withFileTypes: true }).find((entry) => entry.name.startsWith('BAT')); if (batteryPath) { const base = path.join('/sys/class/power_supply', batteryPath.name); const capacity = Number(readText(path.join(base, 'capacity')).trim()); battery = { available: Number.isFinite(capacity), capacity, status: readText(path.join(base, 'status')).trim() }; } } catch (_) {} return { cpu: { ...readCpu(), model: (readText('/proc/cpuinfo').match(/^model name\s*:\s*(.+)$/m) || [0, 'CPU'])[1], temp: findCpuTemp() }, memory: { available: total > 0, used: total - available, total }, storage, network: readNetwork(), battery, gpu: await readGpu() }; }

function scanApplications() {
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

function getCachedApplications() {
  if (Date.now() - appCacheAt >= 30_000) {
    appCache = scanApplications();
    appCacheAt = Date.now();
  }
  return appCache;
}

ipcMain.handle('get-apps', () => getCachedApplications().map(({ id, name, icon }) => ({ id, name, icon })));
ipcMain.handle('launch-app', (event, id) => {
  const application = getCachedApplications().find((item) => item.id === id);
  if (!application) return { ok: false, error: 'Unknown application' };
  const desktopId = application.id.endsWith('.desktop') ? application.id.slice(0, -8) : application.id;
  execFile('gtk-launch', [desktopId], { shell: false, detached: true, stdio: 'ignore' }, (error) => {
    if (error) console.error(`[JARVIS] app launch failed code=${typeof error.code === 'number' ? error.code : 1}`);
  });
  hidePanelWindow();
  return { ok: true };
});

ipcMain.handle('power-action', async (event, id) => {
  if (powerActionRunning || !Object.prototype.hasOwnProperty.call(POWER_ACTIONS, id)) return { ok: false };
  powerActionRunning = true;
  const [commandName, args] = POWER_ACTIONS[id];
  const result = await runFixedCommand(commandName, args);
  powerActionRunning = false;
  if (result.code !== 0) console.error(`[JARVIS] power action ${id} failed code=${result.code}`);
  if (result.code === 0 && (id === 'lock' || id === 'sleep')) hidePanelWindow();
  return { ok: result.code === 0 };
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
  trigger.init(store, createSettingsWindow, togglePanelWindow);
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
