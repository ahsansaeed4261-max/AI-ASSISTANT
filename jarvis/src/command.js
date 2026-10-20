/**
 * command.js
 * Interprets a transcribed voice command with Claude and manages an in-memory
 * pending command. Only locally validated actions can reach the action runner.
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const { getApiKeys, showOverlay } = require('./main');
const { getRisk, listActions, registry, runAction } = require('./actions');
const notify = require('./notify');

const TIMEOUT_MS = 30_000;
const PENDING_TTL_MS = 30_000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';

let pendingCommand = null;

function commandError(message) {
  const error = new Error(message);
  error.name = 'CommandError';
  return error;
}

function claudeRequest(body, apiKey) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        clearTimeout(timer);
        if (response.statusCode !== 200) {
          reject(commandError(`Claude HTTP ${response.statusCode}`));
          return;
        }
        resolve(data);
      });
    });

    const timer = setTimeout(() => {
      request.destroy(commandError('Claude command request timed out'));
    }, TIMEOUT_MS);

    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.write(body);
    request.end();
  });
}

function validateParams(actionName, params) {
  const action = registry.get(actionName);
  if (!action) throw commandError('Unknown command action');
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw commandError('Command parameters must be an object');
  }

  const schema = action.params || {};
  const keys = Object.keys(params);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      throw commandError(`Unexpected parameter '${key}'`);
    }
  }

  for (const [key, spec] of Object.entries(schema)) {
    const value = params[key];
    if (spec.required && (value === undefined || value === null || value === '')) {
      throw commandError(`Missing required parameter '${key}'`);
    }
    if (value !== undefined && value !== null && typeof value !== spec.type) {
      throw commandError(`Invalid type for parameter '${key}'`);
    }
  }

  return Object.fromEntries(keys.map((key) => [key, params[key]]));
}

function validateProposal(replyText) {
  const text = String(replyText || '').trim();
  if (!text || text.startsWith('```') || /```/.test(text)) {
    throw commandError('Claude did not return plain JSON');
  }

  let proposal;
  try {
    proposal = JSON.parse(text);
  } catch (_) {
    throw commandError('Claude returned invalid JSON');
  }

  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw commandError('Claude returned an invalid command object');
  }

  const allowedKeys = new Set(['action', 'params', 'summary']);
  for (const key of Object.keys(proposal)) {
    if (!allowedKeys.has(key)) throw commandError(`Unexpected command field '${key}'`);
  }
  if (typeof proposal.action !== 'string' || !registry.has(proposal.action)) {
    throw commandError('Claude selected an unknown action');
  }
  if (typeof proposal.summary !== 'string' || !proposal.summary.trim()) {
    throw commandError('Command summary is required');
  }

  return {
    action: proposal.action,
    params: validateParams(proposal.action, proposal.params),
    summary: proposal.summary.trim().slice(0, 240),
    risk: getRisk(proposal.action),
  };
}

async function interpret(transcript) {
  const claudeKey = getApiKeys().claude;
  if (!claudeKey) throw commandError('Claude API key is required for command mode');

  const actions = listActions();
  const system = [
    'Convert the voice transcript into exactly one allowed action.',
    'Return JSON only, with no Markdown or code fences.',
    'The JSON object must be exactly: {"action": string, "params": object, "summary": string}.',
    'Choose an action only from this registry and use only its declared parameters.',
    'Do not include risk, confirmation, shell commands, explanations, or extra fields.',
    `Allowed actions: ${JSON.stringify(actions)}`,
  ].join('\n');
  const body = JSON.stringify({
    model: CLAUDE_MODEL,
    max_tokens: 512,
    temperature: 0,
    system,
    messages: [{ role: 'user', content: transcript }],
  });

  console.log(`[command] requesting Claude proposal with model ${CLAUDE_MODEL}`);
  const raw = await claudeRequest(body, claudeKey);
  const response = JSON.parse(raw);
  if (response.error) throw commandError('Claude rejected the command request');
  return validateProposal(response?.content?.[0]?.text);
}

function clearPendingCommand() {
  pendingCommand = null;
}

function currentPendingCommand() {
  if (pendingCommand && pendingCommand.expiresAt <= Date.now()) {
    clearPendingCommand();
  }
  return pendingCommand;
}

async function execute(command) {
  const payload = JSON.stringify({ action: command.action, params: command.params });
  return runAction(payload);
}

async function processTranscript(transcript) {
  const proposal = await interpret(transcript);
  if (proposal.risk === 'safe') {
    showOverlay('thinking', 'Running command...');
    const result = await execute(proposal);
    showOverlay('done', proposal.summary);
    return { status: 'executed', proposal, result };
  }

  const id = crypto.randomUUID();
  pendingCommand = {
    id,
    action: proposal.action,
    params: proposal.params,
    summary: proposal.summary,
    risk: proposal.risk,
    expiresAt: Date.now() + PENDING_TTL_MS,
  };
  showOverlay('confirm', `${proposal.summary} — confirm or cancel`);
  return { status: 'pending', id, proposal };
}

async function confirmPendingCommand() {
  const command = currentPendingCommand();
  if (!command) throw commandError('No unexpired command is awaiting confirmation');

  clearPendingCommand();
  showOverlay('thinking', 'Running confirmed command...');
  const result = await execute(command);
  showOverlay('done', command.summary);
  return result;
}

function cancelPendingCommand() {
  const command = currentPendingCommand();
  if (!command) return false;

  clearPendingCommand();
  showOverlay('done', 'Command cancelled');
  notify('JARVIS', 'Command cancelled');
  return true;
}

module.exports = {
  processTranscript,
  confirmPendingCommand,
  cancelPendingCommand,
  currentPendingCommand,
};
