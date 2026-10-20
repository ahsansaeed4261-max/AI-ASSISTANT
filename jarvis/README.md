# JARVIS – Voice Dictation for Windows

A lightweight desktop app that lets you dictate text anywhere using a global push-to-talk hotkey.

## What It Does

1. **Press and hold** your hotkey (default: `Ctrl + Win`)
2. **Speak** – a small "Listening..." pill appears at the bottom of your screen
3. **Release** – the audio goes to speech-to-text, gets cleaned up by an LLM, then pastes into your active window

The cleanup step removes filler words ("uh", "um"), resolves self-corrections, and fixes punctuation while keeping your natural wording.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Add API Keys

Launch the app and click the tray icon → **Settings**. You'll need at least:

- **Claude API key** (for text cleanup): Get at [console.anthropic.com](https://console.anthropic.com)
- **Deepgram API key** (for transcription): Get at [console.deepgram.com](https://console.deepgram.com)  
  *or*  
  **OpenAI API key** (Whisper for transcription, GPT for cleanup fallback): Get at [platform.openai.com](https://platform.openai.com)

The app picks the best provider based on which keys you've entered:
- **Transcription**: Deepgram → OpenAI Whisper
- **Cleanup**: Claude → OpenAI GPT-4o-mini

### 3. Run

```bash
npm start
```

The app launches into your system tray. Right-click the tray icon for Settings or Quit.

## Usage

- **Default hotkey**: `Ctrl + Win` (hold to record, release to process)
- **Change hotkey**: Open Settings and check/uncheck modifier keys
- **Recording indicator**: A bottom-center overlay shows "Listening..." while recording and "Thinking..." while processing
- **Pasting**: After processing, the cleaned text is automatically pasted into your focused application

## How It Works

```
Press hotkey → Record audio → Release hotkey →
Transcribe (Deepgram/Whisper) → Clean (Claude/GPT) →
Paste into active window → Restore previous clipboard
```

**Modules:**
- `hotkey.js` – Listens for global push-to-talk via uiohook-napi
- `pipeline.js` – Orchestrates the full flow
- `recorder.js` / `recorder.html` – Captures microphone audio using MediaRecorder API
- `transcribe.js` – Sends audio to Deepgram or OpenAI Whisper
- `cleanup.js` – Sends transcript to Claude or GPT for cleanup
- `paste.js` – Puts text on clipboard, simulates Ctrl+V, restores clipboard
- `overlay.html` – Shows the floating "Listening..." / "Thinking..." pill
- `settings.html` – UI for API keys and hotkey configuration

## Platform Notes

### Windows
- Paste simulation uses PowerShell's `SendKeys` – works reliably without extra dependencies

### Linux (if running on Linux via Wine or native Electron)
- Requires `xdotool` or `xte` for paste simulation:
  ```bash
  sudo apt install xdotool
  # or
  sudo apt install xautomation
  ```

### macOS (if adapted)
- Uses `osascript` for paste simulation (built-in)

## Requirements

- **Node.js** 18+
- **Electron** 30+
- **Microphone** access (browser will prompt on first run)
- **API keys** for transcription and cleanup services

## Troubleshooting

**"No transcription API key configured"**  
→ Add a Deepgram or OpenAI key in Settings

**"No LLM API key configured"**  
→ Add a Claude or OpenAI key in Settings

**Nothing pastes**  
→ Check console logs. On Linux, install `xdotool` or `xautomation`

**Hotkey doesn't trigger**  
→ Some apps block global hotkeys. Try in a basic text editor first

**Audio is silent**  
→ Check microphone permissions. The recorder window needs getUserMedia access

## License

MIT – Build what you want with it.
# AI-ASSISTANT
