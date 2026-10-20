/**
 * cleanup.js
 * Cleans raw speech-to-text transcripts with an LLM.
 *
 * Providers are tried in order: Groq, Claude, OpenAI, Gemini (only those with a
 * key), then Ollama (local, no key). If one fails, the next is tried. If all
 * fail, the original transcript is returned so dictation never breaks.
 *
 * Env: LLM_PROVIDER=groq|claude|openai|gemini|ollama forces one provider.
 *      GROQ_MODEL, CLAUDE_MODEL, OPENAI_MODEL, GEMINI_MODEL, OLLAMA_MODEL,
 *      OLLAMA_PORT override defaults.
 */

'use strict';

const https  = require('https');
const http   = require('http');
const notify = require('./notify');

const TIMEOUT_MS        = 30_000;
const OLLAMA_TIMEOUT_MS = 60_000; // first request loads the model

// Model names change often. Override them in .env if one is retired.
const MODELS = {
  groq:   process.env.GROQ_MODEL   || 'llama-3.3-70b-versatile',
  claude: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
  openai: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  gemini: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  ollama: process.env.OLLAMA_MODEL || 'qwen2.5:3b',
};

const SYSTEM_PROMPT =
  'You are a transcript cleaner. The user will give you raw speech-to-text output.\n' +
  'Your job:\n' +
  '- Remove filler words (uh, um, like, you know, basically, literally, etc.)\n' +
  '- Resolve self-corrections: use the intended version ("meet at nine... no, ten" -> "meet at ten")\n' +
  '- Fix capitalization and punctuation naturally\n' +
  '- Keep the speaker\'s wording and voice - do NOT rephrase or summarize\n' +
  '- Return ONLY the cleaned text, nothing else - no explanations, no quotes, no commentary';

// ── Provider chain ────────────────────────────────────────────────────────────

async function cleanup(transcript, apiKeys = {}) {
  const has = (k) => typeof apiKeys[k] === 'string' && apiKeys[k].trim() !== '';

  const all = [
    { name: 'groq',   enabled: has('groq'),   run: () => cleanupGroq(transcript, apiKeys.groq.trim()) },
    { name: 'claude', enabled: has('claude'), run: () => cleanupClaude(transcript, apiKeys.claude.trim()) },
    { name: 'openai', enabled: has('openai'), run: () => cleanupGPT(transcript, apiKeys.openai.trim()) },
    { name: 'gemini', enabled: has('gemini'), run: () => cleanupGemini(transcript, apiKeys.gemini.trim()) },
    { name: 'ollama', enabled: true,          run: () => cleanupOllama(transcript) },
  ];

  let forced = '';
  try {
    const { store } = require('./main');
    const hasSavedProvider = typeof store.has === 'function' && store.has('cleanupProvider');
    const savedProvider = hasSavedProvider
      ? String(store.get('cleanupProvider') || '').trim().toLowerCase()
      : '';

    // An explicitly saved "auto" selection uses the normal chain. Older
    // stores without this setting may still use the environment override.
    if (savedProvider && savedProvider !== 'auto') forced = savedProvider;
    if (!savedProvider) forced = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  } catch (error) {
    console.warn('[cleanup] Unable to read saved cleanup provider; using environment setting');
    forced = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  }

  let chain = all.filter((p) => p.enabled);
  if (forced && forced !== 'auto') {
    const only = all.filter((p) => p.name === forced && p.enabled);
    if (only.length) chain = only;
    else console.warn(`[cleanup] cleanup provider '${forced}' is unknown or has no key – using default order`);
  }

  const errors = [];
  for (const provider of chain) {
    try {
      const text = await provider.run();
      if (text && text.trim()) return text.trim();
      throw new Error('empty response');
    } catch (err) {
      console.error(`[cleanup] ${provider.name} failed: ${err.message}`);
      errors.push(`${provider.name}: ${err.message}`);
    }
  }

  console.error('[cleanup] All providers failed – returning the original transcript.');
  notify('JARVIS – Cleanup failed', 'Pasting the raw transcript. ' + (errors[errors.length - 1] || '').slice(0, 80));
  return transcript;
}

// ── Shared request helper (never logs query strings or keys) ─────────────────

function request(label, options, body, { useHttp = false, timeoutMs = TIMEOUT_MS } = {}) {
  console.log(`[cleanup] ${label} -> POST ${options.hostname}${String(options.path).split('?')[0]}`);

  return new Promise((resolve, reject) => {
    const lib = useHttp ? http : https;

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        clearTimeout(timer);
        console.log(`[cleanup] ${label} HTTP ${res.statusCode}`);
        if (res.statusCode !== 200) {
          reject(new Error(`${label} HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        } else {
          resolve(data);
        }
      });
    });

    const timer = setTimeout(() => {
      req.destroy(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(body);
    req.end();
  });
}

// ── OpenAI-compatible helper (Groq + OpenAI) ─────────────────────────────────

async function openAIChat(label, hostname, path, model, apiKey, transcript) {
  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: transcript },
    ],
  });

  const raw = await request(label, {
    hostname,
    path,
    method: 'POST',
    headers: {
      Authorization:    `Bearer ${apiKey}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  const json = JSON.parse(raw);
  if (json.error) throw new Error(`${label} error: ${json.error.message}`);
  return (json?.choices?.[0]?.message?.content ?? '').trim();
}

// ── Providers ─────────────────────────────────────────────────────────────────

function cleanupGroq(transcript, apiKey) {
  console.log(`[cleanup] provider: Groq (${MODELS.groq})`);
  return openAIChat('Groq', 'api.groq.com', '/openai/v1/chat/completions', MODELS.groq, apiKey, transcript);
}

function cleanupGPT(transcript, apiKey) {
  console.log(`[cleanup] provider: OpenAI (${MODELS.openai})`);
  return openAIChat('OpenAI', 'api.openai.com', '/v1/chat/completions', MODELS.openai, apiKey, transcript);
}

async function cleanupClaude(transcript, apiKey) {
  console.log(`[cleanup] provider: Claude (${MODELS.claude})`);
  const body = JSON.stringify({
    model: MODELS.claude,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: transcript }],
  });

  const raw = await request('Claude', {
    hostname: 'api.anthropic.com',
    path:     '/v1/messages',
    method:   'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
      'Content-Length':    Buffer.byteLength(body),
    },
  }, body);

  const json = JSON.parse(raw);
  if (json.error) throw new Error(`Claude error: ${json.error.message}`);
  return (json?.content?.[0]?.text ?? '').trim();
}

async function cleanupGemini(transcript, apiKey) {
  console.log(`[cleanup] provider: Gemini (${MODELS.gemini})`);
  const body = JSON.stringify({
    contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\n${transcript}` }] }],
    generationConfig: { maxOutputTokens: 1024, temperature: 0 },
  });

  const raw = await request('Gemini', {
    hostname: 'generativelanguage.googleapis.com',
    path:     `/v1beta/models/${MODELS.gemini}:generateContent`,
    method:   'POST',
    headers: {
      'x-goog-api-key': apiKey, // header, so the key never appears in a URL or log
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  const json = JSON.parse(raw);
  if (json.error) throw new Error(`Gemini error: ${json.error.message}`);
  return (json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
}

async function cleanupOllama(transcript) {
  const model = MODELS.ollama;
  const port  = parseInt(process.env.OLLAMA_PORT || '11434', 10);
  console.log(`[cleanup] provider: Ollama (${model}) on port ${port}`);

  const body = JSON.stringify({
    model,
    stream: false,
    keep_alive: '10m',
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: transcript },
    ],
  });

  let raw;
  try {
    raw = await request('Ollama', {
      hostname: '127.0.0.1',
      port,
      path:   '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, body, { useHttp: true, timeoutMs: OLLAMA_TIMEOUT_MS });
  } catch (e) {
    if (/ECONNREFUSED/.test(e.message)) {
      throw new Error('Ollama is not running. Start it with: ollama serve');
    }
    if (/HTTP 404/.test(e.message)) {
      throw new Error(`Ollama model '${model}' not found. Run: ollama pull ${model}`);
    }
    throw e;
  }

  const json = JSON.parse(raw);
  return (json?.message?.content ?? '').trim();
}

module.exports = cleanup;
