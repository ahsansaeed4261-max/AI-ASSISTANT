'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
let pendingActionTimer = null;

const ACTIONS = {
  lock: ['loginctl', ['lock-session']],
  sleep: ['systemctl', ['suspend']],
  hibernate: ['systemctl', ['hibernate']],
  restart: ['systemctl', ['reboot']],
  shutdown: ['systemctl', ['poweroff']],
  signout: ['loginctl', ['terminate-session', 'self']],
};

async function runAction(action) {
  const command = ACTIONS[action];
  if (!command) throw new Error('Unknown power action.');
  try {
    await execFileAsync(command[0], command[1], { windowsHide: true, timeout: 15_000, shell: false });
    return { ok: true };
  } catch (error) {
    throw new Error(error.stderr || error.message || `Could not ${action}.`);
  }
}

async function getState() {
  return {
    available: true,
    hibernationEnabled: true,
    hibernationSupported: true,
    reason: 'Hibernate support depends on the system power manager.',
  };
}

async function performAction(action) {
  if (pendingActionTimer) return { ok: false, error: 'A power action is already counting down.' };
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) return { ok: false, error: 'Unknown power action.' };
  if (action !== 'restart' && action !== 'shutdown' && action !== 'signout') return runAction(action);
  pendingActionTimer = setTimeout(async () => {
    pendingActionTimer = null;
    try { await runAction(action); }
    catch (error) { console.error(`[JARVIS] Scheduled ${action} failed:`, error.message); }
  }, 5000);
  return { ok: true, scheduled: true, seconds: 5 };
}

async function cancelScheduledAction() {
  if (!pendingActionTimer) return { ok: false, error: 'There is no pending power action to cancel.' };
  clearTimeout(pendingActionTimer);
  pendingActionTimer = null;
  return { ok: true, canceled: true };
}

async function enableHibernate() {
  return { ok: false, error: 'Enable hibernation using your system power settings.' };
}

module.exports = { getState, performAction, cancelScheduledAction, enableHibernate };
