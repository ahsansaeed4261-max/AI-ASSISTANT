/**
 * paste.js
 * Platform-specific text delivery.
 *
 * Linux (Wayland/Hyprland):
 *   1. Write text to the Wayland clipboard via wl-copy (spawned with an
 *      argument array – never a shell string so the text can't be
 *      interpreted as shell commands).
 *   2. Type the text directly into the focused window with wtype.
 *      wtype is preferred over clipboard paste because some Wayland
 *      compositors don't forward Ctrl+V from external processes.
 *
 * Windows:
 *   Save clipboard → write text → PowerShell SendKeys Ctrl+V → restore.
 */

'use strict';

const { clipboard } = require('electron');
const { spawnSync, execSync } = require('child_process');

const IS_LINUX = process.platform === 'linux';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check whether a CLI tool exists on PATH.
 * Returns true/false without throwing.
 */
function commandExists(cmd) {
  try {
    // 'which' on Linux, 'where' on Windows
    execSync(
      process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`,
      { stdio: 'ignore', timeout: 2000 }
    );
    return true;
  } catch (_) {
    return false;
  }
}

// ── Linux (Wayland) ───────────────────────────────────────────────────────────

async function pasteLinux(text) {
  // ── 1. wl-copy: put text on the Wayland clipboard ──────────────────────────
  if (!commandExists('wl-copy')) {
    console.error(
      '[paste] ERROR: wl-copy not found. Install wl-clipboard:\n' +
      '  sudo pacman -S wl-clipboard   # Arch / Hyprland\n' +
      '  sudo apt install wl-clipboard # Debian/Ubuntu'
    );
  } else {
    // Spawn with an argv array – text is never interpreted as shell syntax
    const cp = spawnSync('wl-copy', ['--', text], { timeout: 3000 });
    if (cp.error) {
      console.error('[paste] wl-copy failed:', cp.error.message);
    } else {
      console.log('[paste] wl-copy: clipboard set');
    }
  }

  // ── 2. wtype: type the text into the focused window ────────────────────────
  if (!commandExists('wtype')) {
    console.error(
      '[paste] ERROR: wtype not found. Install wtype:\n' +
      '  sudo pacman -S wtype          # Arch / Hyprland\n' +
      '  # or build from: https://github.com/atx/wtype'
    );
    console.log('[paste] Fallback: text is on clipboard – paste manually with Ctrl+V');
    return;
  }

  // Small delay so the focused window is ready
  await sleep(80);

  // argv array: wtype -- "<text>"
  // '--' tells wtype to treat everything after as literal text
  const wt = spawnSync('wtype', ['--', text], { timeout: 5000 });
  if (wt.error) {
    console.error('[paste] wtype failed:', wt.error.message);
  } else if (wt.status !== 0) {
    console.error('[paste] wtype exited with code', wt.status,
      wt.stderr ? wt.stderr.toString().trim() : '');
  } else {
    console.log('[paste] wtype: text typed successfully');
  }
}

// ── Windows ───────────────────────────────────────────────────────────────────

async function pasteWindows(text) {
  const previous = clipboard.readText();

  try {
    clipboard.writeText(text);
    await sleep(80);

    const script =
      'Add-Type -AssemblyName System.Windows.Forms; ' +
      '[System.Windows.Forms.SendKeys]::SendWait(\'^\' + \'v\')';

    try {
      execSync(
        `powershell -NoProfile -NonInteractive -Command "${script}"`,
        { timeout: 3000, windowsHide: true }
      );
    } catch (e) {
      console.error('[paste] PowerShell SendKeys failed:', e.message);
    }

    await sleep(150);
  } finally {
    clipboard.writeText(previous);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function paste(text) {
  if (!text || !text.trim()) return;

  if (IS_LINUX) {
    await pasteLinux(text);
  } else {
    await pasteWindows(text);
  }
}

module.exports = paste;
