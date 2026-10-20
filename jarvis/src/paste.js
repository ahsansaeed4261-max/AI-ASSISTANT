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
const { spawn, spawnSync, execSync } = require('child_process');

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

function setClipboard(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('wl-copy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => reject(new Error('wl-copy timed out')), 3000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('wl-copy exited with code ' + code));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}

async function pasteLinux(text) {
  if (!commandExists('wl-copy') || !commandExists('wtype')) {
    console.error('[paste] ERROR: wl-clipboard and wtype are both required');
    return;
  }

  try {
    await setClipboard(text);
    console.log('[paste] wl-copy: clipboard set');
  } catch (e) {
    console.error('[paste] wl-copy failed:', e.message);
    return;
  }

  // Give the compositor a moment to register the new clipboard owner
  await sleep(150);

  // Ctrl+V by default. Terminals need Ctrl+Shift+V: set JARVIS_PASTE_SHIFT=1 in .env
  const useShift = process.env.JARVIS_PASTE_SHIFT === '1';
  const args = useShift
    ? ['-M', 'ctrl', '-M', 'shift', '-k', 'v', '-m', 'shift', '-m', 'ctrl']
    : ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'];

  const wt = spawnSync('wtype', args, { timeout: 3000 });
  if (wt.error) {
    console.error('[paste] wtype failed:', wt.error.message);
  } else if (wt.status !== 0) {
    console.error('[paste] wtype exited with code', wt.status, wt.stderr ? wt.stderr.toString().trim() : '');
  } else {
    console.log('[paste] sent paste shortcut');
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
