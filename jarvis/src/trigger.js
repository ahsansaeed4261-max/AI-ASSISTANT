/**
 * trigger.js
 * Platform-specific trigger abstraction.
 *
 * Windows  – starts uiohook-napi and listens for the configured
 *             Ctrl+Win push-to-talk hotkey.
 *
 * Linux    – does NOT touch uiohook. Instead, a second Electron
 *             process launched with --start / --stop / --toggle
 *             sends its argv to the already-running instance via
 *             app.requestSingleInstanceLock / 'second-instance'.
 *             main.js installs the 'second-instance' listener and
 *             calls handleArgv() exported from here.
 */

'use strict';

const { ipcMain } = require('electron');

const IS_LINUX = process.platform === 'linux';

// pipeline is required lazily (after app is ready) to avoid circular dep
let _pipeline = null;
function getPipeline() {
  if (!_pipeline) _pipeline = require('./pipeline');
  return _pipeline;
}

// ── Recording state (shared between Windows hotkey and Linux argv handler) ──

let _recording = false;
let _commandRecording = false;
let _recorderReady = false;
let _openSettings = null;  // set by init(), called on --settings
let _togglePanel = null;   // set by init(), called on --panel-toggle

function isRecording() { return _recording; }

function waitForRecorderReady(callback) {
  if (_recorderReady) {
    callback();
    return;
  }

  let settled = false;
  const onReady = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    callback();
  };
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    ipcMain.removeListener('recorder-ready', onReady);
    console.error('[trigger] recorder renderer was not ready within 5 seconds');
  }, 5_000);
  ipcMain.once('recorder-ready', onReady);
}

ipcMain.on('recorder-ready', () => {
  _recorderReady = true;
});

// ── Argv parser ──────────────────────────────────────────────────────────────

/**
 * Parse an argv array and execute:
 *   --start | --stop | --toggle | --settings
 *
 * Called from the first-instance's own process.argv (after app ready)
 * AND from the 'second-instance' event handler in main.js.
 *
 * @param {string[]} argv
 */
async function handleArgv(argv) {
  console.log('[trigger] received:', argv);

  const needsRecorder = argv.includes('--start') ||
    argv.includes('--toggle') || argv.includes('--command-toggle');
  if (needsRecorder && !_recorderReady) {
    console.log('[trigger] recorder renderer not ready; queueing trigger');
    waitForRecorderReady(() => {
      handleArgv(argv).catch((err) => console.error('[trigger] queued trigger error:', err.message));
    });
    return;
  }

  // ── command mode ─────────────────────────────────────────────────────────
  if (argv.includes('--command-confirm')) {
    await getPipeline().confirmCommand().catch((err) => console.error('[trigger] command confirm error:', err.message));
    return;
  }
  if (argv.includes('--command-cancel')) {
    getPipeline().cancelCommand();
    return;
  }
  if (argv.includes('--command-toggle')) {
    if (_recording) {
      console.log('[trigger] --command-toggle ignored, dictation recording is active');
      return;
    }
    if (_commandRecording) {
      _commandRecording = false;
      await getPipeline().stopCommandRecording().catch((err) => console.error('[trigger] command error:', err.message));
    } else {
      _commandRecording = true;
      await getPipeline().startCommandRecording().catch((err) => {
        console.error('[trigger] command start error:', err.message);
        _commandRecording = false;
      });
    }
    return;
  }

  // ── --panel-toggle ───────────────────────────────────────────────────────
  if (argv.includes('--panel-toggle')) {
    if (typeof _togglePanel === 'function') {
      _togglePanel();
    } else {
      console.warn('[trigger] --panel-toggle: panel callback not registered yet');
    }
    return;
  }

  // ── --settings ────────────────────────────────────────────────────────────
  if (argv.includes('--settings')) {
    console.log('[trigger] --settings: opening settings window');
    if (typeof _openSettings === 'function') {
      _openSettings();
    } else {
      console.warn('[trigger] --settings: openSettings callback not registered yet');
    }
    return;
  }

  // ── --start / --stop / --toggle ───────────────────────────────────────────
  if (argv.includes('--start')) {
    if (_commandRecording) { console.log('[trigger] --start ignored, command recording is active'); return; }
    if (_recording) { console.log('[trigger] --start ignored, already recording'); return; }
    await doStart();
  } else if (argv.includes('--stop')) {
    if (!_recording) { console.log('[trigger] --stop ignored, not recording'); return; }
    await doStop();
  } else if (argv.includes('--toggle')) {
    if (_commandRecording) { console.log('[trigger] --toggle ignored, command recording is active'); return; }
    if (_recording) { await doStop(); } else { await doStart(); }
  }
}

async function doStart() {
  try {
    await getPipeline().startRecording();
    _recording = true;
    console.log('[trigger] recording started');
  } catch (err) {
    console.error('[trigger] startRecording error:', err);
  }
}

async function doStop() {
  _recording = false;
  console.log('[trigger] recording stopped');
  await getPipeline().stopRecording().catch((err) => {
    console.error('[trigger] stopRecording error:', err);
  });
}

// ── Windows: uiohook push-to-talk ────────────────────────────────────────────

function startWindowsHotkey(store) {
  const { uIOhook, UiohookKey } = require('uiohook-napi');

  const KEY_MAP = {
    ctrl:  [UiohookKey.Ctrl,  UiohookKey.CtrlRight],
    shift: [UiohookKey.Shift, UiohookKey.ShiftRight],
    alt:   [UiohookKey.Alt,   UiohookKey.AltRight],
    win:   [UiohookKey.Meta,  UiohookKey.MetaRight],
  };

  const held = new Set();
  let hotkeyActive = false;

  function classifyKey(keycode) {
    for (const [name, codes] of Object.entries(KEY_MAP)) {
      if (codes.includes(keycode)) return name;
    }
    return null;
  }

  function isHotkeyPressed() {
    const hk = store.get('hotkey');
    if (hk.ctrl  && !held.has('ctrl'))  return false;
    if (hk.shift && !held.has('shift')) return false;
    if (hk.alt   && !held.has('alt'))   return false;
    if (hk.win   && !held.has('win'))   return false;
    return true;
  }

  uIOhook.on('keydown', (e) => {
    const mod = classifyKey(e.keycode);
    if (mod) held.add(mod);

    if (!hotkeyActive && isHotkeyPressed()) {
      hotkeyActive = true;
      doStart().catch((err) => console.error('[trigger] doStart error:', err));
    }
  });

  uIOhook.on('keyup', (e) => {
    const mod = classifyKey(e.keycode);
    if (mod) held.delete(mod);

    if (hotkeyActive && !isHotkeyPressed()) {
      hotkeyActive = false;
      doStop().catch((err) => console.error('[trigger] doStop error:', err));
    }
  });

  uIOhook.start();
  console.log('[trigger] uiohook hotkey listener started (Windows)');
}

// ── Public init ───────────────────────────────────────────────────────────────

/**
 * Called from main.js after app is ready.
 * On Windows: starts the uiohook listener.
 * On Linux:   just logs – the real trigger comes via second-instance / argv.
 *
 * @param {Store}    store        electron-store instance
 * @param {Function} openSettings callback that opens the settings window
 * @param {Function} togglePanel  callback that toggles the island panel
 */
function init(store, openSettings, togglePanel) {
  _openSettings = openSettings || null;
  _togglePanel = togglePanel || null;

  if (IS_LINUX) {
    console.log('[trigger] Linux mode – use `electron . --start/--stop/--toggle/--settings`');
    setImmediate(() => handleArgv(process.argv));
  } else {
    startWindowsHotkey(store);
  }
}

/**
 * Stop the uiohook listener on Windows (called from before-quit).
 */
function stop() {
  if (!IS_LINUX) {
    try { require('uiohook-napi').uIOhook.stop(); } catch (_) {}
  }
}

module.exports = { init, stop, handleArgv, isRecording };
