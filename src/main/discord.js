'use strict';
// Discord Rich Presence: the profile shows "Playing MC Launcher" and what
// is going on — the launcher menu, the version being played (and the server,
// unless that's switched off), the party with its size.
//
// Joining through Discord: while we're in a party that isn't full, the
// activity carries a join secret (the party code). A friend presses "Ask to
// Join" → we get ACTIVITY_JOIN_REQUEST and the window (or a notification)
// asks whether to let them in → SEND_ACTIVITY_JOIN_INVITE. Their Discord then
// hands the secret to their MC Launcher (ACTIVITY_JOIN; Discord starts it
// through the discord-<id>:// protocol if it isn't running), which joins the
// party. Invites sent from a Discord chat land the same way.
//
// No library: the Discord app listens on \\?\pipe\discord-ipc-N, and the
// protocol is a handshake plus JSON frames (int32 op, int32 length, body).
// Discord not running is normal — we look again every half a minute.
// Settings: config.discord (all of it), config.discordServer (the address),
// config.discordJoin (the join secret).

const net = require('net');
const crypto = require('crypto');
const config = require('./config');
const log = require('./log');

const SECRET = 'mclp1:';

// The "MC Launcher" application at discord.com/developers: its name and icon
// are what Discord shows. Empty = the feature stays off.
const CLIENT_ID = process.env.MCL_DISCORD_ID || '';
const RETRY_MS = 30000;
// tests point this at a fake Discord
const PIPE = process.env.MCL_DISCORD_PIPE || '\\\\?\\pipe\\discord-ipc-';
const LOADERS = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', optifine: 'OptiFine' };

let sock = null;
let ready = false;
let buf = Buffer.alloc(0);
let retry = null;
let pending = null;
let sent = '';
let sources = null;
const openedAt = Date.now();
const listeners = new Set();

function emit(type, payload) {
  for (const fn of listeners) {
    try {
      fn(type, payload);
    } catch { /* ignore */ }
  }
}

function command(cmd, args, evt) {
  if (!sock) return;
  sock.write(frame(1, { cmd, args: args || {}, ...(evt ? { evt } : {}), nonce: crypto.randomUUID() }));
}

function frame(op, body) {
  const json = Buffer.from(JSON.stringify(body), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

function enabled() {
  return !!CLIENT_ID && config.get().discord !== false;
}

function drop() {
  ready = false;
  sent = '';
  buf = Buffer.alloc(0);
  if (sock) {
    sock.removeAllListeners();
    sock.on('error', () => {});
    sock.destroy();
  }
  sock = null;
}

function later() {
  clearTimeout(retry);
  if (enabled()) retry = setTimeout(connect, RETRY_MS);
}

function tryPipe(n) {
  if (n > 9) {
    later();
    return;
  }
  const s = net.connect(`${PIPE}${n}`);
  s.once('error', () => {
    s.destroy();
    if (sock === s) sock = null;
    tryPipe(n + 1);
  });
  s.once('connect', () => {
    s.removeAllListeners('error');
    sock = s;
    s.on('data', onData);
    s.on('error', () => {});
    s.on('close', () => {
      if (sock !== s) return;
      drop();
      later();
    });
    s.write(frame(0, { v: 1, client_id: CLIENT_ID }));
  });
}

function connect() {
  clearTimeout(retry);
  if (!enabled() || sock) return;
  tryPipe(0);
}

function onData(chunk) {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 8) {
    const op = buf.readInt32LE(0);
    const len = buf.readInt32LE(4);
    if (buf.length < 8 + len) break;
    let msg = null;
    try {
      msg = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
    } catch { /* skip it */ }
    buf = buf.subarray(8 + len);
    if (op === 3 && sock) sock.write(frame(4, msg)); // ping → pong
    else if (op === 2) {
      // Discord closed it: a wrong id, or it's quitting
      log.warn(`Discord: ${(msg && msg.message) || 'closed'}`);
      drop();
      later();
      return;
    } else if (msg && msg.evt === 'READY') {
      ready = true;
      log.info('Discord: connected.');
      command('SUBSCRIBE', {}, 'ACTIVITY_JOIN');
      command('SUBSCRIBE', {}, 'ACTIVITY_JOIN_REQUEST');
      push();
    } else if (msg && msg.cmd === 'DISPATCH' && msg.evt === 'ACTIVITY_JOIN') {
      const secret = String((msg.data && msg.data.secret) || '');
      const code = secret.startsWith(SECRET) ? sources.party.normalize(secret.slice(SECRET.length)) : null;
      if (code) {
        log.info('Discord: joining a party from Discord.');
        emit('join', { code });
      }
    } else if (msg && msg.cmd === 'DISPATCH' && msg.evt === 'ACTIVITY_JOIN_REQUEST') {
      const u = (msg.data && msg.data.user) || {};
      if (/^\d{5,25}$/.test(String(u.id || ''))) {
        emit('request', {
          id: String(u.id),
          name: String(u.global_name || u.username || 'Discord').slice(0, 40),
          avatar: u.avatar && /^[a-z0-9_]{6,64}$/i.test(u.avatar) ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : '',
        });
      }
    } else if (msg && msg.evt === 'ERROR') {
      log.warn(`Discord: ${msg.data && msg.data.message}`);
    }
  }
}

// ---- what to show ---------------------------------------------------------------------

function activity() {
  const cfg = config.get();
  const ru = cfg.language !== 'en';
  const { game, bedrock, party } = sources;
  const java = game.list()[0];
  const br = !java && bedrock.runningList()[0];
  const p = party.state();
  const a = { type: 0, instance: false };
  if (java) {
    const loader = LOADERS[java.loader] || '';
    a.details = `Minecraft ${java.mcVersion || ''}${loader ? ` · ${loader}` : ''}`.trim();
    a.state = java.server && cfg.discordServer !== false ? (ru ? `Сервер ${java.server}` : `On ${java.server}`) : ru ? 'В игре' : 'In game';
    a.timestamps = { start: java.startedAt };
  } else if (br) {
    a.details = 'Minecraft Bedrock Edition';
    a.state = ru ? 'В игре' : 'In game';
    a.timestamps = { start: br.startedAt || openedAt };
  } else {
    a.details = ru ? 'В меню лаунчера' : 'In the launcher';
    a.state = p.active ? (ru ? 'Собирает пати' : 'Gathering a party') : ru ? 'Выбирает, во что играть' : 'Picking what to play';
    a.timestamps = { start: openedAt };
  }
  if (p.active && p.members) {
    // a stable id for "N of M"; the code itself only as the join secret,
    // which Discord gives to those it lets in, never shows
    const size = [Math.max(1, p.members.length), p.capacity || 5];
    a.party = { id: crypto.createHash('sha256').update(`mcl-party:${p.code}`).digest('hex').slice(0, 32), size };
    const code = sources.party.normalize(p.code);
    if (code && size[0] < size[1] && cfg.discordJoin !== false) a.secrets = { join: SECRET + code };
  }
  return a;
}

function push() {
  if (!ready || !sock) return;
  const act = enabled() ? activity() : null;
  const key = JSON.stringify(act);
  if (key === sent) return;
  sent = key;
  sock.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: act }, nonce: crypto.randomUUID() }));
}

// Something changed: settle for a moment, then show it (or switch off).
function refresh() {
  clearTimeout(pending);
  pending = setTimeout(() => {
    if (!sources) return;
    if (!enabled()) {
      if (ready && sock) {
        sock.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: crypto.randomUUID() }));
      }
      setTimeout(drop, 300);
      clearTimeout(retry);
      return;
    }
    if (!sock) connect();
    else push();
  }, 400);
}

// Someone asked to join through Discord: let them in, or not.
function answer(userId, accept) {
  if (!ready || !/^\d{5,25}$/.test(String(userId))) return false;
  command(accept ? 'SEND_ACTIVITY_JOIN_INVITE' : 'CLOSE_ACTIVITY_REQUEST', { user_id: String(userId) });
  return true;
}

function init({ game, bedrock, party }) {
  sources = { game, bedrock, party };
  if (!CLIENT_ID) return;
  // Discord starts the launcher for a join when it isn't running
  try {
    const { app } = require('electron');
    if (app.isPackaged) app.setAsDefaultProtocolClient(`discord-${CLIENT_ID}`);
  } catch { /* not in Electron (tests) */ }
  game.onEvent((type) => (type === 'started' || type === 'exited') && refresh());
  bedrock.onEvent(() => refresh());
  party.onEvent((type) => (type === 'changed' || type === 'ended') && refresh());
  refresh();
}

function shutdown() {
  clearTimeout(retry);
  clearTimeout(pending);
  drop();
}

module.exports = {
  init,
  refresh,
  shutdown,
  answer,
  available: () => !!CLIENT_ID,
  onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
