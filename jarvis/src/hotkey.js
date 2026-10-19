/**
 * hotkey.js
 * Listens for the global push-to-talk hotkey using uiohook-napi.
 * Default: Ctrl + Meta (Win key). Configurable via settings.
 */

const { uIOhook, UiohookKey } = require('uiohook-napi');
const { store, showOverlay } = require('./main');
const pipeline = require('./pipeline');

// Track which modifier keys are currently held
const held = new Set();

let hotkeyActive = false;

// Map readable key names to uiohook keycodes
const KEY_MAP = {
  ctrl: [UiohookKey.Ctrl, UiohookKey.CtrlRight],
  shift: [UiohookKey.Shift, UiohookKey.ShiftRight],
  alt: [UiohookKey.Alt, UiohookKey.AltRight],
  win: [UiohookKey.Meta, UiohookKey.MetaRight],
};

function isHotkeyPressed() {
  const hotkey = store.get('hotkey');
  if (hotkey.ctrl && !held.has('ctrl')) return false;
  if (hotkey.shift && !held.has('shift')) return false;
  if (hotkey.alt && !held.has('alt')) return false;
  if (hotkey.win && !held.has('win')) return false;
  return true;
}

function classifyKey(keycode) {
  for (const [name, codes] of Object.entries(KEY_MAP)) {
    if (codes.includes(keycode)) return name;
  }
  return null;
}

uIOhook.on('keydown', (e) => {
  const mod = classifyKey(e.keycode);
  if (mod) held.add(mod);

  if (!hotkeyActive && isHotkeyPressed()) {
    hotkeyActive = true;
    console.log('[hotkey] Push-to-talk START');
    pipeline.startRecording().catch((err) =>
      console.error('[hotkey] startRecording error:', err)
    );
  }
});

uIOhook.on('keyup', (e) => {
  const mod = classifyKey(e.keycode);
  if (mod) held.delete(mod);

  if (hotkeyActive && !isHotkeyPressed()) {
    hotkeyActive = false;
    console.log('[hotkey] Push-to-talk END');
    pipeline.stopRecording().catch((err) =>
      console.error('[hotkey] stopRecording error:', err)
    );
  }
});

uIOhook.start();
console.log('[hotkey] uiohook listener started');
