# JARVIS Architecture

This document describes the current Electron application in this directory. It is a guide to the existing structure, not a target design; platform support and feature behavior vary by service.

## Runtime overview

JARVIS is an Electron desktop app with a long-lived main process and several renderer windows. The main process owns operating-system access, application state, window and tray lifecycle, and IPC handlers. Renderers display the UI and call narrowly scoped APIs exposed by preload scripts.

At startup, `src/main.js` loads environment variables, creates the persistent settings store, acquires a single-instance lock, and then initializes the tray, floating overlay, and hidden recorder window. The settings window and the legacy panel are created when requested. Closing the app's visible windows does not quit it; it remains available in the system tray until explicitly quit.

There is also a `--action` command-line path. It runs a registered action and exits before acquiring the normal single-instance lock or creating the regular windows.

```text
User input
    |
    +-- Global hotkey / forwarded command-line flags --> trigger.js
    |                                                       |
    |                                                       v
    |                                                   pipeline.js
    |                            recorder <--> main process --> transcription
    |                                                       --> transcript cleanup
    |                                                       --> paste into active app
    |
    +-- Overlay / panel / settings renderer
             |
             v
      preload API (contextBridge)
             |
             v
      main-process IPC handlers --> feature services --> OS / local store / APIs
```

## Main components

| Area | Files | Responsibility |
| --- | --- | --- |
| Electron lifecycle and IPC | `src/main.js` | App and window lifecycle, tray, persistent store, IPC routing, app discovery, and shared platform operations. |
| Dictation | `src/hotkey.js`, `src/trigger.js`, `src/pipeline.js`, `src/recorder.html`, `src/recorder-preload.js` | Receive hotkey or command triggers, record audio in the hidden renderer, and coordinate dictation and command flows. |
| Speech and text processing | `src/transcribe.js`, `src/cleanup.js`, `src/command.js`, `src/actions.js` | Send audio or text to configured providers, validate voice-command proposals, and run registered actions. |
| Text delivery | `src/paste.js` | Deliver cleaned text to the previously focused application using platform-specific input/clipboard behavior. |
| Primary interface | `src/overlay.html`, `src/overlay-preload.js` | Floating island, dictation/command feedback, controls, stats, apps, clipboard, wallpaper, and power pages. |
| Other renderers | `src/settings.html`, `src/settings-preload.js`, `src/panel.html`, `src/panel-preload.js`, `src/capture.html`, `src/capture-preload.js` | Settings, the legacy panel, and screen-selection UI. |
| Feature services | `src/services/` | Clipboard history and platform-selectable controls, stats, wallpaper, and power implementations. |

`src/main.js` is the integration point for windows and IPC. Some older panel and platform-specific operations still live there; newer feature modules generally live in `src/services/`.

## Process boundary and IPC

Renderer windows use `contextIsolation` and disable Node integration. A preload script exposes each window's API through `contextBridge`; renderer code should call that API rather than importing Electron or reaching into the main process.

The main process handles both request/response operations (`ipcMain.handle` / `ipcRenderer.invoke`) and event-style messages (`send` / `on`). The overlay, panel, recorder, settings, screen-capture, and wallpaper-reveal windows each have a purpose-specific preload bridge. Feature IPC handlers validate incoming values where the feature requires it, then call a service or main-process helper.

When adding an operation:

1. Put operating-system or persistent-data work in the main process or an appropriate service.
2. Register a narrowly scoped IPC handler in `src/main.js`.
3. Expose only the required operation through the relevant preload script.
4. Keep renderer inputs and returned data to the smallest useful shape.

## Dictation and voice-command flows

### Dictation

1. `src/hotkey.js` tracks modifier state with `uiohook-napi` on Windows. `src/trigger.js` also accepts command-line flags; on Linux, a second Electron invocation forwards arguments to the running instance using Electron's single-instance mechanism.
2. `src/pipeline.js` tells the hidden recorder renderer to start. `src/recorder.html` captures microphone input and returns encoded audio over IPC.
3. `src/transcribe.js` uses Deepgram when configured, otherwise OpenAI Whisper.
4. `src/cleanup.js` tries the configured/available cleanup provider chain (Groq, Claude, OpenAI, Gemini, and local Ollama in automatic mode).
5. `src/paste.js` delivers the result to the active application. Dictation history is stored when history saving is enabled.

The provider choices and saved API keys are managed in Settings. API keys may also be supplied with environment variables; `src/main.js` resolves saved values before environment values.

### Voice commands

The command path transcribes a command recording, asks an available command interpreter for a structured proposal, validates the action name and parameters against `src/actions.js`, and presents a confirmation state before execution. Only registered actions can be run. This is separate from the direct dictation cleanup-and-paste path.

## Feature services and platform selection

The controls, stats, wallpaper, and power services use an `index.js` entry point to select an implementation based on `process.platform`. Windows implementations are in `win32.js`; unsupported implementations return explicit unavailable results. Power also has a Linux implementation. Clipboard history is implemented in `src/services/clipboard.js` and uses Electron's clipboard API.

The service boundary is the preferred place for new platform-specific behavior. Keep command names and arguments fixed where possible; pass validated values as separate process arguments rather than constructing shell command strings.

## Persistent data and external services

`electron-store` persists settings and feature data in Electron's per-user application data directory. This includes provider keys and preferences, dictation history (when enabled), app usage metadata, and clipboard history. Clipboard history is local to the app; capture can be paused, and stored history is bounded by the clipboard service.

Audio transcription and transcript cleanup may send microphone audio or transcript text to the selected external provider. Ollama cleanup can run locally when configured and available. The Settings renderer reads and saves provider keys through its dedicated preload API; other renderer bridges do not expose a general credentials accessor.

## Development

From this directory:

```powershell
npm install
npm start
```

There is no test or lint script currently defined in `package.json`. For JavaScript syntax checks, use `node --check <file>`. Renderer scripts are embedded in HTML files, so extract or parse the relevant inline scripts when checking them with Node. `git diff --check` checks patch whitespace.
