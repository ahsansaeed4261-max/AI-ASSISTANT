/**
 * pipeline.js
 * Orchestrates the full flow: record → transcribe → clean → paste
 */

'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const { showOverlay, getApiKeys, store } = require('./main');
const transcribe = require('./transcribe');
const cleanup = require('./cleanup');
const paste = require('./paste');
const command = require('./command');

// ── Notification helper ───────────────────────────────────────────────────────

const notify = require('./notify');

// ── Feedback: overlay (Windows) + notify-send (Linux) ────────────────────────

function feedback(state, text) {
  try { showOverlay(state, text); } catch (e) { console.error('[overlay] failed:', e.message); }
  if (process.platform === 'linux') {
    if (state === 'recording') {
      console.log('[pipeline] feedback: Listening...');
    } else if (state === 'thinking') {
      console.log('[pipeline] feedback: Thinking...');
    } else if (state === 'done') {
      console.log('[pipeline] feedback: Done');
    }
    // 'hide' is a no-op on Linux
  } else {
    // overlay is driven at the top of feedback()
  }
}

// ── IPC: recorder renderer → main ────────────────────────────────────────────

let _resolveAudio = null;
let busy = false;

ipcMain.on('recorder-audio-ready', (event, base64audio) => {
  console.log(`[pipeline] recorder-audio-ready: ${base64audio ? base64audio.length : 0} base64 chars`);
  if (_resolveAudio) {
    _resolveAudio(base64audio);
    _resolveAudio = null;
  } else {
    console.warn('[pipeline] recorder-audio-ready received but no listener waiting');
  }
});

ipcMain.on('recorder-ready', () => {
  console.log('[pipeline] Recorder renderer ready');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getRecorderWindow() {
  return BrowserWindow.getAllWindows().find(
    (w) => w.webContents.getURL().includes('recorder.html')
  );
}

function waitForAudio(timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    if (_resolveAudio) {
      reject(new Error('Another recording is being processed'));
      return;
    }

    const timer = setTimeout(() => {
      _resolveAudio = null;
      reject(new Error(`Audio timeout – recorder did not respond within ${timeoutMs / 1000}s`));
    }, timeoutMs);

    _resolveAudio = (data) => {
      clearTimeout(timer);
      resolve(data);
    };
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function startRecording() {
  if (busy) {
    console.log('[pipeline] startRecording: recording is already being processed');
    return;
  }

  const win = getRecorderWindow();
  if (!win) {
    console.error('[pipeline] startRecording: recorder window not found');
    return;
  }
  console.log('[pipeline] startRecording: sending recorder-start');
  feedback('recording');
  win.webContents.send('recorder-start');
  console.log('[pipeline] recording started');
}

async function transcribeRecording() {
  const win = getRecorderWindow();
  if (!win) throw new Error('Recorder window not found');

  const audioPromise = waitForAudio(30_000);
  win.webContents.send('recorder-stop');
  const base64audio = await audioPromise;
  if (!base64audio) throw new Error('No audio captured. Check microphone permissions.');
  const transcript = await transcribe(base64audio, getApiKeys());
  if (!transcript || !transcript.trim()) throw new Error('Nothing transcribed – try speaking more clearly.');
  return transcript.trim();
}

async function stopRecording() {
  busy = true;
  try {
    const win = getRecorderWindow();
    if (!win) {
      console.error('[pipeline] stopRecording: recorder window not found');
      return;
    }

    console.log('[pipeline] stopRecording: sending recorder-stop');
    const audioPromise = waitForAudio(30_000);
    win.webContents.send('recorder-stop');
    console.log('[pipeline] recording stopped – waiting for audio data...');

    feedback('thinking');

    // ── Stage 1: get audio ──────────────────────────────────────────────────
    let base64audio;
    try {
      base64audio = await audioPromise;
    } catch (err) {
      console.error('[pipeline] Stage 1 FAILED (get audio):', err.message);
      notify('JARVIS – Error', err.message);
      feedback('error', String(err.message).slice(0, 60));
      return;
    }

    if (!base64audio || base64audio.length === 0) {
      console.error('[pipeline] Stage 1: empty audio received – nothing to transcribe');
      notify('JARVIS – Error', 'No audio captured. Check microphone permissions.');
      feedback('error', String('No audio captured. Check microphone permissions.').slice(0, 60));
      return;
    }
    console.log(`[pipeline] Stage 1 done – audio: ${base64audio.length} base64 chars`);

    // ── Stage 2: transcribe ─────────────────────────────────────────────────
    console.log('[pipeline] Stage 2: transcribing...');
    let transcript;
    try {
      transcript = await transcribe(base64audio, getApiKeys());
    } catch (err) {
      console.error('[pipeline] Stage 2 FAILED (transcribe):', err.message);
      notify('JARVIS – Transcription failed', err.message.slice(0, 100));
      feedback('error', String(err.message.slice(0, 100)).slice(0, 60));
      return;
    }

    if (!transcript || !transcript.trim()) {
      console.log('[pipeline] Stage 2: empty transcript – nothing to clean');
      notify('JARVIS', 'Nothing transcribed – try speaking more clearly.');
      feedback('error', String('Nothing transcribed – try speaking more clearly.').slice(0, 60));
      return;
    }
    console.log('[pipeline] Stage 2 done – transcript:', transcript);

    // ── Stage 3: cleanup ────────────────────────────────────────────────────
    console.log('[pipeline] Stage 3: cleanup...');
    let cleaned;
    try {
      cleaned = await cleanup(transcript, getApiKeys());
    } catch (err) {
      console.error('[pipeline] Stage 3 FAILED (cleanup):', err.message);
      notify('JARVIS – Cleanup failed', err.message.slice(0, 100));
      feedback('error', String(err.message.slice(0, 100)).slice(0, 60));
      return;
    }
    console.log('[pipeline] Stage 3 done – cleaned:', cleaned);

    // ── Stage 4: paste ──────────────────────────────────────────────────────
    console.log('[pipeline] Stage 4: pasting...');
    try {
      await paste(cleaned);
    } catch (err) {
      console.error('[pipeline] Stage 4 FAILED (paste):', err.message);
      notify('JARVIS – Paste failed', err.message.slice(0, 100));
      feedback('error', String(err.message.slice(0, 100)).slice(0, 60));
      return;
    }
    console.log('[pipeline] Stage 4 done – paste complete');

    if (store.get('saveHistory') !== false) {
      const history = store.get('history');
      const entries = Array.isArray(history) ? history : [];
      entries.unshift({
        time: new Date().toISOString(),
        raw: transcript,
        cleaned,
      });
      store.set('history', entries.slice(0, 50));
    }

    feedback('done');
    setTimeout(() => feedback('hide'), 1500);
  } finally {
    busy = false;
  }
}

async function startCommandRecording() {
  if (busy) {
    console.log('[pipeline] startCommandRecording: recording is already being processed');
    return;
  }
  return startRecording();
}

async function stopCommandRecording() {
  busy = true;
  try {
    feedback('thinking', 'Thinking...');
    const transcript = await transcribeRecording();
    return await command.processTranscript(transcript);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline] Command failed:', message);
    feedback('error', message.slice(0, 60));
    notify('JARVIS – Command failed', message);
    return;
  } finally {
    busy = false;
  }
}

async function confirmCommand() {
  return command.confirmPendingCommand();
}

function cancelCommand() {
  return command.cancelPendingCommand();
}

module.exports = {
  startRecording,
  stopRecording,
  startCommandRecording,
  stopCommandRecording,
  confirmCommand,
  cancelCommand,
};

