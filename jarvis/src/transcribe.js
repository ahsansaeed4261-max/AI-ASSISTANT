/**
 * transcribe.js
 * Sends audio to a speech-to-text API and returns the transcript.
 * Priority: Deepgram > OpenAI Whisper
 */

'use strict';

const https = require('https');
const { execSync } = require('child_process');

const TIMEOUT_MS = 30_000;

// ── Notification helper (Linux) ───────────────────────────────────────────────

const notify = require('./notify');

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * @param {string} base64audio - Base64-encoded audio (webm/opus or wav)
 * @param {object} apiKeys     - { deepgram, openai, claude }
 * @returns {Promise<string>}  transcript text
 */
async function transcribe(base64audio, apiKeys) {
  if (apiKeys.deepgram && apiKeys.deepgram.trim()) {
    return transcribeDeepgram(base64audio, apiKeys.deepgram.trim());
  }
  if (apiKeys.openai && apiKeys.openai.trim()) {
    return transcribeWhisper(base64audio, apiKeys.openai.trim());
  }
  const msg = 'No transcription API key configured – add a Deepgram or OpenAI key in Settings.';
  console.error('[transcribe] ERROR:', msg);
  notify('JARVIS – No API key', msg);
  throw new Error(msg);
}

// ── Shared HTTPS helper with timeout ─────────────────────────────────────────

/**
 * Make an HTTPS request with a hard timeout.
 * Logs the provider, URL, HTTP status, and first 300 chars of the body.
 *
 * @param {string}  label    - display name for logs, e.g. "Deepgram"
 * @param {object}  options  - https.request options (no auth values logged)
 * @param {Buffer}  body     - request body
 * @returns {Promise<string>} raw response body
 */
function httpsRequest(label, options, body) {
  const url = `https://${options.hostname}${options.path}`;
  console.log(`[transcribe] ${label} → POST ${url} (${body.length} bytes)`);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy(new Error(`${label} transcription timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        clearTimeout(timer);
        const preview = data.slice(0, 300);
        console.log(`[transcribe] ${label} HTTP ${res.statusCode} – body preview: ${preview}`);
        if (res.statusCode !== 200) {
          reject(new Error(`${label} HTTP ${res.statusCode}: ${preview}`));
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', (e) => {
      clearTimeout(timer);
      if (e.message.includes('timed out')) {
        console.error(`[transcribe] ${label} timed out`);
        notify('JARVIS – Transcription timeout', `${label} did not respond in ${TIMEOUT_MS / 1000}s`);
      }
      reject(e);
    });

    req.write(body);
    req.end();
  });
}

// ── Deepgram ──────────────────────────────────────────────────────────────────

async function transcribeDeepgram(base64audio, apiKey) {
  const audioBuffer = Buffer.from(base64audio, 'base64');
  // Detect container: webm starts with 0x1a45dfa3, wav with RIFF
  const isWav = audioBuffer[0] === 0x52 && audioBuffer[1] === 0x49; // RI
  const contentType = isWav ? 'audio/wav' : 'audio/webm;codecs=opus';

  console.log(`[transcribe] Deepgram – model=nova-2, content-type=${contentType}, audio=${audioBuffer.length} bytes`);

  const options = {
    hostname: 'api.deepgram.com',
    path: '/v1/listen?model=nova-2&smart_format=true',
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': contentType,
      'Content-Length': audioBuffer.length,
    },
  };

  let raw;
  try {
    raw = await httpsRequest('Deepgram', options, audioBuffer);
  } catch (e) {
    console.error('[transcribe] Deepgram request failed:', e.message);
    notify('JARVIS – Transcription failed', `Deepgram: ${e.message.slice(0, 80)}`);
    throw e;
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    const msg = `Deepgram JSON parse error: ${e.message}`;
    console.error('[transcribe]', msg);
    notify('JARVIS – Transcription failed', msg);
    throw new Error(msg);
  }

  if (json.err_msg) {
    const msg = `Deepgram API error: ${json.err_msg}`;
    console.error('[transcribe]', msg);
    notify('JARVIS – Transcription failed', msg);
    throw new Error(msg);
  }

  const transcript =
    json?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
  console.log(`[transcribe] Deepgram done – transcript length: ${transcript.length} chars`);
  return transcript;
}

// ── OpenAI Whisper ────────────────────────────────────────────────────────────

async function transcribeWhisper(base64audio, apiKey) {
  const audioBuffer = Buffer.from(base64audio, 'base64');
  const isWav = audioBuffer[0] === 0x52 && audioBuffer[1] === 0x49;
  const filename = isWav ? 'audio.wav' : 'audio.webm';
  const fileContentType = isWav ? 'audio/wav' : 'audio/webm';

  console.log(`[transcribe] Whisper – model=whisper-1, file=${filename}, audio=${audioBuffer.length} bytes`);

  const boundary = '----JARVISBoundary' + Date.now().toString(16);

  const partHeader = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${fileContentType}\r\n\r\n`
  );
  const modelPart = Buffer.from(
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `whisper-1\r\n--${boundary}--\r\n`
  );

  const body = Buffer.concat([partHeader, audioBuffer, modelPart]);

  const options = {
    hostname: 'api.openai.com',
    path: '/v1/audio/transcriptions',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    },
  };

  let raw;
  try {
    raw = await httpsRequest('Whisper', options, body);
  } catch (e) {
    console.error('[transcribe] Whisper request failed:', e.message);
    notify('JARVIS – Transcription failed', `Whisper: ${e.message.slice(0, 80)}`);
    throw e;
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    const msg = `Whisper JSON parse error: ${e.message}`;
    console.error('[transcribe]', msg);
    notify('JARVIS – Transcription failed', msg);
    throw new Error(msg);
  }

  if (json.error) {
    const msg = `Whisper API error: ${json.error.message}`;
    console.error('[transcribe]', msg);
    notify('JARVIS – Transcription failed', msg);
    throw new Error(msg);
  }

  const transcript = json.text ?? '';
  console.log(`[transcribe] Whisper done – transcript length: ${transcript.length} chars`);
  return transcript;
}

module.exports = transcribe;
