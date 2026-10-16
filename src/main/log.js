'use strict';
// The launcher's log: one ring buffer that the console window reads from,
// mirrored to %APPDATA%\MCLauncher\logs\launcher.log.
//
// Game output goes through here too (source: 'game'), so the console shows
// one interleaved timeline: what the launcher did, then what the game said.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const MAX_LINES = 6000;

// Last line of defence: nothing that looks like a credential reaches the
// console or launcher.log, even if some code (or a mod) prints one — the
// launcher's own tokens by value, and anything shaped like a token.
const secrets = new Set();
const SHAPES = [
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<jwt>'],
  [/\b(access_?token|refresh_?token|accessToken|session|token)(["']?\s*[=:]\s*["']?|\s+)([\w.~+/!*$-]{20,}=*)/gi, '$1$2<token>'],
  [/\bM\.[A-Z0-9]{1,6}[_.$][\w!*$.-]{30,}/g, '<token>'],
  [/[A-Za-z0-9+/_-]{160,}={0,2}/g, '<redacted>'],
];
function scrub(text) {
  let s = String(text);
  for (const v of secrets) if (s.includes(v)) s = s.split(v).join('<token>');
  for (const [re, to] of SHAPES) s = s.replace(re, to);
  return s;
}
function secret(value) {
  if (typeof value === 'string' && value.length >= 16) secrets.add(value);
  if (secrets.size > 64) secrets.delete(secrets.values().next().value);
}
const buffer = [];
const listeners = new Set();
let stream = null;

function openFile() {
  try {
    fs.mkdirSync(paths.logsDir, { recursive: true });
    const file = path.join(paths.logsDir, 'launcher.log');
    // One previous session is kept, so a crash that closed the launcher
    // can still be read about after restarting it.
    if (fs.existsSync(file)) {
      try {
        fs.renameSync(file, path.join(paths.logsDir, 'launcher.prev.log'));
      } catch {
        /* file in use by an old instance — append instead */
      }
    }
    stream = fs.createWriteStream(file, { flags: 'a' });
  } catch {
    stream = null;
  }
}

function stamp(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function add(level, text, source = 'launcher') {
  if (text == null) return;
  const line = { t: Date.now(), level, text: scrub(text), source };
  buffer.push(line);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
  if (stream) stream.write(`[${stamp(line.t)}] [${source}/${level.toUpperCase()}] ${line.text}\n`);
  for (const fn of listeners) {
    try {
      fn(line);
    } catch {
      /* a broken listener must not break logging */
    }
  }
}

// Picks a level for a line of game output. Log4j's own pattern puts the
// level in brackets ("[Render thread/WARN]"), which is far more reliable than
// searching the whole line for "error".
function gameLevel(text, fromStderr) {
  const m = /\[[^\]]*\/(INFO|WARN|ERROR|FATAL|DEBUG)\]/.exec(text);
  if (m) return m[1] === 'FATAL' ? 'error' : m[1].toLowerCase();
  if (/^\s+at\s|Exception|^Caused by:/.test(text)) return 'error';
  return fromStderr ? 'warn' : 'info';
}

module.exports = {
  init: openFile,
  secret,
  scrub,
  info: (t) => add('info', t),
  warn: (t) => add('warn', t),
  error: (t) => add('error', t),
  game: (t, fromStderr) => add(gameLevel(t, fromStderr), t, 'game'),
  history: () => buffer.slice(),
  clear: () => {
    buffer.length = 0;
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
