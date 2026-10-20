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

const IS_LINUX = process.platform === 'linux';

// pipeline is required lazily (after app is ready) to avoid circular dep
let _pipeline = null;
function getPipeline() {
  if (!_pipeline) _pipeline = require('./pipeline');
  return _pipeline;
}

// ── Recording state (shared between Windows hotkey and Linux argv handler) ──

let _recording = false;
let _openSettings = null;  // set by init(), called on --settings

function isRecording() { return _recording; }

// ── Argv parser ──────────────────────────────────────────────────────────────

/**
 * Parse an argv array and execute:
 *   --start | --stop | --toggle | --settings | --action '<json>'
 *
 * Called from the first-instance's own process.argv (after app ready)
 * AND from the 'second-instance' event handler in main.js.
 *
 * @param {string[]} argv
 */
async function handleArgv(argv) {
  console.log('[trigger] received:', argv);

  // ── --action <json> ───────────────────────────────────────────────────────
  const actionIdx = argv.indexOf('--action');
  if (actionIdx !== -1) {
    const jsonStr = argv[actionIdx + 1];
    if (!jsonStr) {
      console.error('[trigger] --action requires a JSON argument, e.g. --action \'{"name":"open_url","params":{"url":"https://example.com"}}\'');
      return;
    }
    const { runAction } = require('./actions');
    try {
      const result = await runAction(jsonStr);
      process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
    } catch (err) {
      process.stderr.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
      console.error('[trigger] --action failed:', err.message);
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
    if (_recording) { console.log('[trigger] --start ignored, already recording'); return; }
    await doStart();
  } else if (argv.includes('--stop')) {
    if (!_recording) { console.log('[trigger] --stop ignored, not recording'); return; }
    await doStop();
  } else if (argv.includes('--toggle')) {
    if (_recording) { await doStop(); } else { await doStart(); }
  }
}

async function doStart() {
  _recording = true;
  console.log('[trigger] recording started');
  await getPipeline().startRecording().catch((err) => {
    console.error('[trigger] startRecording error:', err);
    _recording = false;
  });
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
 */
function init(store, openSettings) {
  _openSettings = openSettings || null;

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
