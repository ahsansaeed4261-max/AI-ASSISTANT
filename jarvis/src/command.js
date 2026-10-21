/**
 * command.js
 * Interprets a transcribed voice command with Ollama (or Claude as fallback)
 * and manages an in-memory pending command. Only locally validated actions can
 * reach the action runner.
 */

'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { getApiKeys, showOverlay } = require('./main');
const { getRisk, listActions, registry, runAction } = require('./actions');
const notify = require('./notify');

const TIMEOUT_MS = 30_000;
const OLLAMA_TIMEOUT_MS = 60_000;
const PENDING_TTL_MS = 30_000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

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

function buildProposalSchema(actions) {
  const properties = {};
  for (const action of actions) {
    for (const [name, spec] of Object.entries(action.params || {})) {
      const types = properties[name]?.type;
      const typeList = Array.isArray(types) ? types : types ? [types] : [];
      if (!typeList.includes(spec.type)) typeList.push(spec.type);
      properties[name] = { type: typeList.length === 1 ? typeList[0] : typeList };
    }
  }

  return {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'params', 'summary'],
    properties: {
      action: { type: 'string', enum: actions.map((action) => action.name) },
      params: { type: 'object', properties },
      summary: { type: 'string' },
    },
  };
}

function buildSystemPrompt(actions) {
  const actionList = actions.map((action) => {
    const params = Object.entries(action.params || {})
      .map(([name, spec]) => `${name}: ${spec.description}`)
      .join('; ') || 'none';
    return `- ${action.name}: ${action.description} Parameters: ${params}`;
  });

  return [
    'Convert the voice transcript into exactly one allowed action.',
    'Use this exact shape: {"action": NAME, "params": {...}, "summary": "short sentence"}.',
    'Choose an action only from the registry and use only its declared parameters.',
    'Do not include risk, confirmation, shell commands, explanations, or extra fields.',
    'Actions:',
    ...actionList,
    'Examples:',
    '"open spotify" -> {"action":"open_app","params":{"app":"spotify"},"summary":"Open Spotify"}',
    '"search google for linux wallpapers" -> {"action":"web_search","params":{"query":"linux wallpapers"},"summary":"Search for linux wallpapers"}',
    '"turn the volume up" -> {"action":"media_control","params":{"command":"volume_up"},"summary":"Volume up"}',
    '"what is two plus two" -> {"action":"reply","params":{"text":"Four"},"summary":"Answer"}',
    '"open https://example.com" -> {"action":"open_url","params":{"url":"https://example.com"},"summary":"Open example.com"}',
    'Reply with the JSON object only.',
  ].join('\n');
}

function ollamaRequest(body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        clearTimeout(timer);
        if (response.statusCode !== 200) {
          reject(commandError(`Ollama HTTP ${response.statusCode}: ${data}`));
          return;
        }
        resolve(data);
      });
    });

    const timer = setTimeout(() => {
      request.destroy(commandError('Ollama command request timed out'));
    }, OLLAMA_TIMEOUT_MS);

    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.write(body);
    request.end();
  });
}

function ollamaFailureMessage(error) {
  const message = error?.message || String(error);
  if (error?.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(message)) {
    return 'Ollama is not running. Start it with: ollama serve';
  }
  if (/model.*not found|not found.*model/i.test(message)) {
    return `Model not found. Run: ollama pull ${OLLAMA_MODEL}`;
  }
  return `Ollama command request failed: ${message}`;
}

async function interpret(transcript) {
  const actions = listActions();
  const system = buildSystemPrompt(actions);
  const body = JSON.stringify({
    model: OLLAMA_MODEL,
    stream: false,
    keep_alive: '10m',
    options: { temperature: 0 },
    format: buildProposalSchema(actions),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: transcript },
    ],
  });

  let replyText;
  try {
    console.log(`[command] requesting Ollama proposal with model ${OLLAMA_MODEL}`);
    const raw = await ollamaRequest(body);
    const response = JSON.parse(raw);
    if (response.error) throw commandError(`Ollama rejected the command request: ${response.error}`);
    replyText = response?.message?.content;
  } catch (ollamaError) {
    const claudeKey = getApiKeys().claude;
    if (!claudeKey) throw commandError(ollamaFailureMessage(ollamaError));

    console.warn(`[command] Ollama unavailable; falling back to Claude: ${ollamaFailureMessage(ollamaError)}`);
    const claudeBody = JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: transcript }],
    });
    try {
      const raw = await claudeRequest(claudeBody, claudeKey);
      const response = JSON.parse(raw);
      if (response.error) throw commandError('Claude rejected the command request');
      replyText = response?.content?.[0]?.text;
    } catch (claudeError) {
      throw commandError(`${ollamaFailureMessage(ollamaError)} Claude fallback failed: ${claudeError.message}`);
    }
  }

  return validateProposal(replyText);
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
  if (proposal.action === 'reply') {
    const text = proposal.params.text;
    showOverlay('done', text);
    notify('JARVIS', text);
    return { status: 'executed', proposal, result: { reply: text } };
  }
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
