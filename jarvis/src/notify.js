'use strict';

const { execFileSync } = require('child_process');

function notify(title, body) {
  if (process.platform !== 'linux') return;
  try {
    execFileSync('notify-send', [String(title), String(body)], {
      timeout: 2000,
      stdio: 'ignore',
    });
  } catch (_) {}
}

module.exports = notify;
