'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
let pendingShutdownAction = '';
let pendingSignOutTimer = null;

async function runPowerScript(action) {
  const script = require('path').join(__dirname, 'power.ps1');
  try {
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
    ], {
      windowsHide: true,
      timeout: action === 'enable-hibernate' ? 120_000 : 15_000,
      maxBuffer: 256 * 1024,
      shell: false,
    });
    return stdout.trim();
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim();
    if (action === 'enable-hibernate' && /cancel|denied|canceled|cancelled/i.test(detail)) {
      throw new Error('Administrator approval was declined. Hibernate was not enabled.');
    }
    throw new Error(detail || `Windows could not ${action === 'sleep' ? 'enter sleep' : 'complete the power action'}.`);
  }
}

async function runCommand(command, args, failureMessage) {
  try {
    await execFileAsync(command, args, {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
      shell: false,
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim();
    throw new Error(detail || failureMessage);
  }
}

async function getState() {
  const output = await runPowerScript('state');
  const state = JSON.parse(output);
  if (typeof state.hibernationEnabled !== 'boolean' || typeof state.hibernationSupported !== 'boolean') {
    throw new Error('Windows returned an invalid hibernation state.');
  }
  return {
    available: true,
    hibernationEnabled: state.hibernationEnabled,
    hibernationSupported: state.hibernationSupported,
    reason: String(state.reason || ''),
  };
}

async function scheduleSignOut() {
  if (pendingSignOutTimer || pendingShutdownAction) {
    return { ok: false, error: 'A power action is already counting down.' };
  }
  pendingSignOutTimer = setTimeout(async () => {
    pendingSignOutTimer = null;
    try {
      await runCommand('shutdown.exe', ['/l'], 'Windows could not sign out.');
    } catch (error) {
      console.error('[JARVIS] Scheduled sign-out failed:', error.message);
    }
  }, 5000);
  return { ok: true, scheduled: true, seconds: 5 };
}

async function performAction(action) {
  if (typeof action !== 'string') return { ok: false, error: 'Invalid power action.' };
  if (pendingSignOutTimer || pendingShutdownAction) {
    return { ok: false, error: 'A power action is already counting down.' };
  }

  if (action === 'lock') {
    await runCommand('rundll32.exe', ['user32.dll,LockWorkStation'], 'Windows could not lock the session.');
    return { ok: true };
  }
  if (action === 'sleep') {
    await runPowerScript('sleep');
    return { ok: true };
  }
  if (action === 'hibernate') {
    const state = await getState();
    if (!state.hibernationSupported) {
      return { ok: false, error: state.reason || 'Hibernate is not supported on this device.' };
    }
    if (!state.hibernationEnabled) {
      return { ok: false, error: 'Hibernate is turned off. Enable it in Power settings first.', enableHibernate: true };
    }
    await runCommand('shutdown.exe', ['/h'], 'Windows could not hibernate.');
    return { ok: true };
  }
  if (action === 'restart' || action === 'shutdown') {
    const args = action === 'restart'
      ? ['/r', '/t', '5', '/c', 'JARVIS requested a restart.']
      : ['/s', '/t', '5', '/c', 'JARVIS requested a shutdown.'];
    await runCommand('shutdown.exe', args, `Windows could not schedule ${action}.`);
    pendingShutdownAction = action;
    return { ok: true, scheduled: true, seconds: 5 };
  }
  if (action === 'signout') return scheduleSignOut();
  return { ok: false, error: 'Unknown power action.' };
}

async function cancelScheduledAction() {
  if (pendingShutdownAction) {
    await runCommand('shutdown.exe', ['/a'], 'Windows could not cancel the scheduled power action.');
    pendingShutdownAction = '';
    return { ok: true, canceled: true };
  }
  if (pendingSignOutTimer) {
    clearTimeout(pendingSignOutTimer);
    pendingSignOutTimer = null;
    return { ok: true, canceled: true };
  }
  return { ok: false, error: 'There is no pending power action to cancel.' };
}

async function enableHibernate() {
  const state = await getState();
  if (!state.hibernationSupported) {
    return { ok: false, error: state.reason || 'Hibernate is not supported on this device.' };
  }
  if (state.hibernationEnabled) return { ok: true, enabled: true };
  await runPowerScript('enable-hibernate');
  return { ok: true, enabled: true };
}

module.exports = {
  getState,
  performAction,
  cancelScheduledAction,
  enableHibernate,
};
