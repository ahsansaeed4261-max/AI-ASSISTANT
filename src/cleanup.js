/**
 * cleanup.js
 * Cleans raw STT transcripts using an LLM.
 *
 * Provider priority (first key present wins):
 *   1. Groq       – free tier, fast Llama 3.3-70b  (GROQ_API_KEY)
 *   2. Claude     – Anthropic Haiku                (ANTHROPIC_API_KEY)
 *   3. OpenAI     – GPT-4o-mini                    (OPENAI_API_KEY)
 *   4. Gemini     – Google Gemini Flash             (GEMINI_API_KEY)
 *   5. Ollama     – local, no key needed            (always available if running)
 */

'use strict';

const https = require('https');
const http  = require('http');

const TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
  'You are a transcript cleaner. The user will give you raw speech-to-text output.\n' +
  'Your job:\n' +
  '- Remove filler words (uh, um, like, you know, basically, literally, etc.)\n' +
  '- Resolve self-corrections: use the intended version ("meet at nine... no, ten" → "meet at ten")\n' +
  '- Fix capitalization and punctuation naturally\n' +
  '- Keep the speaker\'s wording and voice — do NOT rephrase or summarize\n' +
  '- Return ONLY the cleaned text, nothing else — no explanations, no quotes, no commentary';

// ── Provider selector ─────────────────────────────────────────────────────────

async function cleanup(transcript, apiKeys) {
  if (apiKeys.groq    && apiKeys.groq.trim())    return cleanupGroq   (transcript, apiKeys.groq.trim());
  if (apiKeys.claude  && apiKeys.claude.trim())  return cleanupClaude (transcript, apiKeys.claude.trim());
  if (apiKeys.openai  && apiKeys.openai.trim())  return cleanupGPT    (transcript, apiKeys.openai.trim());
  if (apiKeys.gemini  && apiKeys.gemini.trim())  return cleanupGemini (transcript, apiKeys.gemini.trim());

  // Ollama: always try if no cloud key is present
  console.log('[cleanup] No cloud LLM key found – trying Ollama (local)');
  return cleanupOllama(transcript);
}

// ── Shared request helper ─────────────────────────────────────────────────────

function request(label, options, body, isHttp = false) {
  const url = `${isHttp ? 'http' : 'https'}://${options.hostname}${options.path}`;
  console.log(`[cleanup] ${label} → POST ${url}`);

  return new Promise((resolve, reject) => {
    const lib = isHttp ? http : https;

    const timer = setTimeout(() => {
      req.destroy(new Error(`${label} cleanup timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        clearTimeout(timer);
        console.log(`[cleanup] ${label} HTTP ${res.statusCode} – preview: ${data.slice(0, 200)}`);
        if (res.statusCode !== 200) {
          reject(new Error(`${label} HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(body);
    req.end();
  });
}

// ── OpenAI-compatible chat helper (used by Groq + OpenAI) ────────────────────

async function openAIChat(label, hostname, path, model, apiKey, transcript) {
  const body = JSON.stringify({
    model,
    max_tokens: 1024,
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
      Authorization:  `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  const json = JSON.parse(raw);
  if (json.error) throw new Error(`${label} error: ${json.error.message}`);
  const text = json?.choices?.[0]?.message?.content ?? '';
  console.log(`[cleanup] ${label} done – ${text.length} chars`);
  return text.trim();
}

// ── 1. Groq (free, fast) ──────────────────────────────────────────────────────

function cleanupGroq(transcript, apiKey) {
  console.log('[cleanup] provider: Groq (llama-3.3-70b-versatile)');
  return openAIChat(
    'Groq',
    'api.groq.com',
    '/openai/v1/chat/completions',
    'llama-3.3-70b-versatile',
    apiKey,
    transcript
  );
}

// ── 2. Anthropic Claude ───────────────────────────────────────────────────────

async function cleanupClaude(transcript, apiKey) {
  console.log('[cleanup] provider: Claude (claude-3-5-haiku-20241022)');
  const body = JSON.stringify({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: transcript }],
  });

  const raw = await request('Claude', {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'x-api-key':          apiKey,
      'anthropic-version':  '2023-06-01',
      'Content-Type':       'application/json',
      'Content-Length':     Buffer.byteLength(body),
    },
  }, body);

  const json = JSON.parse(raw);
  if (json.error) throw new Error(`Claude error: ${json.error.message}`);
  const text = json?.content?.[0]?.text ?? '';
  console.log(`[cleanup] Claude done – ${text.length} chars`);
  return text.trim();
}

// ── 3. OpenAI GPT-4o-mini ─────────────────────────────────────────────────────

function cleanupGPT(transcript, apiKey) {
  console.log('[cleanup] provider: OpenAI (gpt-4o-mini)');
  return openAIChat(
    'OpenAI',
    'api.openai.com',
    '/v1/chat/completions',
    'gpt-4o-mini',
    apiKey,
    transcript
  );
}

// ── 4. Google Gemini Flash ────────────────────────────────────────────────────

async function cleanupGemini(transcript, apiKey) {
  console.log('[cleanup] provider: Gemini (gemini-1.5-flash)');
  const body = JSON.stringify({
    contents: [{
      parts: [{ text: `${SYSTEM_PROMPT}\n\n${transcript}` }],
    }],
    generationConfig: { maxOutputTokens: 1024 },
  });

  const raw = await request('Gemini', {
    hostname: 'generativelanguage.googleapis.com',
    path:     `/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  const json = JSON.parse(raw);
  if (json.error) throw new Error(`Gemini error: ${json.error.message}`);
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  console.log(`[cleanup] Gemini done – ${text.length} chars`);
  return text.trim();
}

// ── 5. Ollama (local, no key) ─────────────────────────────────────────────────

async function cleanupOllama(transcript) {
  // Default model; user can override with OLLAMA_MODEL env var
  const model = process.env.OLLAMA_MODEL || 'llama3.2';
  const port  = parseInt(process.env.OLLAMA_PORT || '11434', 10);
  console.log(`[cleanup] provider: Ollama (${model}) on port ${port}`);

  const body = JSON.stringify({
    model,
    stream: false,
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
    }, body, /* isHttp */ true);
  } catch (e) {
    throw new Error(
      `Ollama not reachable (${e.message}). ` +
      'Either install Ollama (https://ollama.com) or add a cloud API key to .env'
    );
  }

  const json = JSON.parse(raw);
  const text = json?.message?.content ?? '';
  console.log(`[cleanup] Ollama done – ${text.length} chars`);
  return text.trim();
}

module.exports = cleanup;


// ── Anthropic Claude ─────────────────────────────────────────────────────────

async function cleanupClaude(transcript, apiKey) {
  const body = JSON.stringify({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: transcript }],
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(`Claude error: ${json.error.message}`));
            return;
          }
          const text = json?.content?.[0]?.text ?? '';
          resolve(text.trim());
        } catch (e) {
          reject(new Error(`Claude parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── OpenAI GPT-4o-mini ────────────────────────────────────────────────────────

async function cleanupGPT(transcript, apiKey) {
  const body = JSON.stringify({
    model: 'gpt-4o-mini',
    max_tokens: 1024,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: transcript },
    ],
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(`GPT error: ${json.error.message}`));
            return;
          }
          const text = json?.choices?.[0]?.message?.content ?? '';
          resolve(text.trim());
        } catch (e) {
          reject(new Error(`GPT parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = cleanup;
