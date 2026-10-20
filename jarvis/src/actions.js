/**
 * actions.js
 * Registry of runnable actions for --action '{"name":"...","params":{...}}'.
 *
 * Each action has:
 *   name        {string}   machine-readable identifier
 *   description {string}   human-readable summary
 *   params      {object}   JSON-schema-style parameter spec { key: { type, description, required } }
 *   run         {function} async (params) => any  — throws on error
 *
 * All handlers are written for Linux/Wayland (Hyprland).
 * Windows stubs can be added per-action when needed.
 */

'use strict';

const { execFileSync, execFile } = require('child_process');
const { spawnSync }               = require('child_process');

const IS_LINUX = process.platform === 'linux';

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd, args = [], opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, ...opts });
}

function requireTool(name) {
  const r = run('which', [name]);
  if (r.status !== 0) {
    throw new Error(
      `'${name}' not found on PATH. ` +
      `Install it (e.g. sudo pacman -S ${name} or sudo apt install ${name})`
    );
  }
}

// ── Action definitions ────────────────────────────────────────────────────────

const ACTIONS = [
  // ── open_app ──────────────────────────────────────────────────────────────
  {
    name: 'open_app',
    risk: 'safe',
    description: 'Launch an application by its executable name or .desktop name.',
    params: {
      app: { type: 'string', description: 'Executable name or .desktop app ID (e.g. "firefox", "org.gnome.Nautilus")', required: true },
    },
    async run({ app: appName }) {
      if (!appName) throw new Error('app param is required');

      // Try gtk-launch (handles .desktop IDs), fall back to direct exec
      const gtk = run('gtk-launch', [appName]);
      if (gtk.status === 0) return { launched: appName, method: 'gtk-launch' };

      const direct = spawnSync(appName, [], {
        detached: true,
        stdio:    'ignore',
        timeout:  3000,
      });
      if (direct.error) throw new Error(`Cannot launch '${appName}': ${direct.error.message}`);
      return { launched: appName, method: 'exec' };
    },
  },

  // ── open_url ──────────────────────────────────────────────────────────────
  {
    name: 'open_url',
    risk: 'safe',
    description: 'Open a URL in the default browser.',
    params: {
      url: { type: 'string', description: 'Full URL including scheme', required: true },
    },
    async run({ url }) {
      if (!url) throw new Error('url param is required');
      if (!/^https?:\/\//i.test(url)) throw new Error(`URL must start with http:// or https://. Got: ${url}`);

      const opener = IS_LINUX ? 'xdg-open' : 'start';
      const r = IS_LINUX
        ? run('xdg-open', [url])
        : run('cmd', ['/c', 'start', '', url]);
      if (r.error) throw new Error(`xdg-open failed: ${r.error.message}`);
      return { opened: url };
    },
  },

  // ── web_search ────────────────────────────────────────────────────────────
  {
    name: 'web_search',
    risk: 'safe',
    description: 'Open a web search in the default browser.',
    params: {
      query:  { type: 'string', description: 'Search query',                    required: true  },
      engine: { type: 'string', description: '"google" | "ddg" | "brave"',      required: false },
    },
    async run({ query, engine = 'google' }) {
      if (!query) throw new Error('query param is required');

      const engines = {
        google: 'https://www.google.com/search?q=',
        ddg:    'https://duckduckgo.com/?q=',
        brave:  'https://search.brave.com/search?q=',
      };
      const base = engines[engine] ?? engines.google;
      const url  = base + encodeURIComponent(query);

      const r = IS_LINUX ? run('xdg-open', [url]) : run('cmd', ['/c', 'start', '', url]);
      if (r.error) throw new Error(`Could not open browser: ${r.error.message}`);
      return { searched: query, engine, url };
    },
  },

  // ── media_control ─────────────────────────────────────────────────────────
  {
    name: 'media_control',
    risk: 'interactive',
    description: 'Control media playback (play/pause, next, previous, volume up/down).',
    params: {
      command: {
        type:        'string',
        description: '"play_pause" | "next" | "previous" | "volume_up" | "volume_down" | "mute"',
        required:    true,
      },
    },
    async run({ command }) {
      if (!command) throw new Error('command param is required');

      // playerctl covers most Linux media players (Spotify, VLC, browsers, etc.)
      const playerctlMap = {
        play_pause: ['play-pause'],
        next:       ['next'],
        previous:   ['previous'],
      };

      // wpctl / pactl for volume (works on PipeWire & PulseAudio)
      const volumeMap = {
        volume_up:   ['set-volume', '@DEFAULT_AUDIO_SINK@', '5%+'],
        volume_down: ['set-volume', '@DEFAULT_AUDIO_SINK@', '5%-'],
        mute:        ['set-mute',   '@DEFAULT_AUDIO_SINK@', 'toggle'],
      };

      if (playerctlMap[command]) {
        requireTool('playerctl');
        const r = run('playerctl', playerctlMap[command]);
        if (r.status !== 0) throw new Error(`playerctl failed: ${r.stderr}`);
        return { command };
      }

      if (volumeMap[command]) {
        // Prefer wpctl (PipeWire), fall back to pactl
        const tool = run('which', ['wpctl']).status === 0 ? 'wpctl' : 'pactl';
        const r = run(tool, volumeMap[command]);
        if (r.status !== 0) throw new Error(`${tool} failed: ${r.stderr}`);
        return { command };
      }

      throw new Error(`Unknown media command '${command}'. Use: play_pause, next, previous, volume_up, volume_down, mute`);
    },
  },

  // ── type_text ─────────────────────────────────────────────────────────────
  {
    name: 'type_text',
    risk: 'interactive',
    description: 'Type text into the currently focused window using wtype (Wayland).',
    params: {
      text:  { type: 'string', description: 'Text to type',              required: true  },
      delay: { type: 'number', description: 'Delay between keys in ms',  required: false },
    },
    async run({ text, delay }) {
      if (!text) throw new Error('text param is required');

      if (IS_LINUX) {
        requireTool('wtype');
        const args = ['--', text];
        if (delay) args.unshift('-d', String(delay));
        const r = run('wtype', args);
        if (r.status !== 0) throw new Error(`wtype failed: ${r.stderr}`);
      } else {
        // Windows fallback: PowerShell SendKeys
        const escaped = text.replace(/'/g, "''");
        const script  = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`;
        const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
        if (r.status !== 0) throw new Error(`SendKeys failed: ${r.stderr}`);
      }

      return { typed: text.length + ' chars' };
    },
  },
];

// ── Registry API ──────────────────────────────────────────────────────────────

const registry = new Map(ACTIONS.map((a) => [a.name, a]));

/**
 * Run an action from a JSON string.
 *
 * Accepted shapes:
 *   {"action":"open_app","name":"firefox"}         ← flat, action key names the handler
 *   {"action":"open_url","url":"https://..."}       ← flat params
 *   {"name":"open_app","params":{"app":"firefox"}}  ← legacy nested params shape
 *
 * The handler is always chosen from `payload.action` (preferred) or
 * `payload.name` (legacy fallback). Everything else in the payload is
 * passed to the handler as parameters.
 *
 * Prints result JSON to stdout, error JSON to stderr. Throws on error.
 *
 * @param {string} jsonStr  raw string from --action argv
 * @returns {Promise<object>} result object
 */
async function runAction(jsonStr) {
  let payload;
  try {
    payload = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`--action value is not valid JSON: ${e.message}`);
  }

  // Resolve action name: prefer `action` key, fall back to `name` key
  const actionName = payload.action || payload.name;
  if (!actionName) {
    throw new Error('--action JSON must have an "action" field.');
  }

  const action = registry.get(actionName);
  if (!action) {
    const available = ACTIONS.map((a) => a.name).join(', ');
    throw new Error(
      `Unknown action '${actionName}'.\n` +
      `  Available: ${available}`
    );
  }

  // Build params: use nested `params` object if present, otherwise use
  // the whole payload minus the `action`/`name` dispatcher keys.
  let params;
  if (payload.params && typeof payload.params === 'object') {
    params = payload.params;
  } else {
    params = Object.assign({}, payload);
    delete params.action;
    delete params.name;
  }

  console.log(`[actions] running '${actionName}'`);
  const result = await action.run(params);
  console.log(`[actions] '${actionName}' done`);
  return result;
}

/**
 * Return the full list of actions with name, description and params.
 */
function getRisk(name) {
  return registry.get(name)?.risk || 'destructive';
}

function listActions() {
  return ACTIONS.map(({ name, description, params }) => ({ name, description, params }));
}

module.exports = { runAction, listActions, getRisk, registry };
