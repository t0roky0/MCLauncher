'use strict';
// An account's profile: its picture and what it has played — the hours in
// all, by server (singleplayer worlds as one), the last one — kept on this
// PC (<appDir>/profiles.json, one an account: "x:<xuid>") and on our server
// (server/redeem.py, op profile), where friends with the launcher see it:
// the name it plays under, its picture, items, hours and where it plays now.
// The time comes from the game's samples (nearby.js), about one a second.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const log = require('./log');
const relay = require('./relay-server');

const FILE = path.join(paths.appDir, 'profiles.json');
const AVATAR_MAX = 9000; // a picture's data URL, at most (the server takes no more)
const AVATAR = /^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/;
const listeners = new Set();
const sessions = new Map(); // game pid → { at, host }

let state = null; // { [key]: { avatar: '' | data URL, ms, servers: { host: ms }, last: { host, at } } }
let activeKey = 'local';
let dirty = false;
let saveTimer = null;
let pushTimer = null;
let playing = null; // the host played on now ('' a world of one's own), null when not in a game

const emit = (type, payload) => { for (const fn of listeners) { try { fn(type, payload); } catch { /* a listener's */ } } };

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
  } catch {
    state = {};
  }
  return state;
}

function bucket(key = activeKey) {
  const s = load();
  const b = s[key] && typeof s[key] === 'object' ? s[key] : (s[key] = {});
  if (typeof b.avatar !== 'string') b.avatar = '';
  if (!(b.ms >= 0)) b.ms = 0;
  if (!b.servers || typeof b.servers !== 'object') b.servers = {};
  if (b.last && typeof b.last !== 'object') b.last = null;
  return b;
}

function save(now = false) {
  dirty = true;
  if (now) return flush();
  if (!saveTimer) saveTimer = setTimeout(flush, 15000);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty || !state) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(state));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (e) {
    log.warn(`Profiles: ${e.message}`);
  }
}

// a server's address as one name for it: no port, no "play."/"mc." in front, lower case
function hostOf(server) {
  let h = String(server || '').trim().toLowerCase().replace(/:\d+$/, '');
  h = h.replace(/^(play|mc|join|connect|game)\./, '');
  return h.length <= 64 ? h : h.slice(0, 64);
}

function setAccount(key) {
  key = typeof key === 'string' && /^x:\d{1,20}$/.test(key) ? key : 'local';
  if (key === activeKey) return;
  activeKey = key;
  emit('changed', view());
  push();
}

// A sample from a running game: {pid, edition, server}
function sample(p) {
  if (!p || !p.pid) return;
  const t = Date.now();
  const host = hostOf(p.server);
  const prev = sessions.get(p.pid);
  sessions.set(p.pid, { at: t, host });
  if (playing !== host) {
    playing = host;
    push(true);
  }
  if (!prev) return;
  const dt = t - prev.at;
  if (dt <= 0 || dt > 5000) return; // a pause (menu, alt-tab): not counted
  const b = bucket();
  b.ms += dt;
  b.servers[host] = (b.servers[host] || 0) + dt;
  b.last = { host, at: t };
  save();
  // the hours on the page move on now and then, not every second
  if (!sample.shown || t - sample.shown > 60000) {
    sample.shown = t;
    emit('changed', view());
  }
}

function gameStopped(pid) {
  sessions.delete(pid);
  if (!sessions.size) {
    playing = null;
    flush();
    emit('changed', view());
    push(true);
  }
}

function setAvatar(data) {
  data = String(data || '');
  if (data && (data.length > AVATAR_MAX || !AVATAR.test(data))) throw new Error('Картинка не подходит — выберите другую.');
  bucket().avatar = data;
  save(true);
  emit('changed', view());
  push(true);
  return view();
}

// The active account's profile, as the window shows it.
function view(key = activeKey) {
  const b = bucket(key);
  const servers = Object.entries(b.servers).map(([host, ms]) => ({ host, ms })).sort((x, y) => y.ms - x.ms);
  return { key, avatar: b.avatar, ms: b.ms, servers, last: b.last || null, playing: key === activeKey ? playing : null };
}

const avatarOf = (key) => bucket(key).avatar;

// ---- on our server ----------------------------------------------------------------------------

// What friends see: sent a moment after anything changes, and while playing every few minutes.
function push(soon = false) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => send().catch((e) => log.info(`Profile: ${e.message}`)), soon ? 1500 : 8000);
}

async function send() {
  const acc = require('./auth').activeAccount();
  const sessions_ = require('./account-session');
  if (!sessions_.keyOf(acc) || sessions_.keyOf(acc) !== activeKey) return;
  const s = await sessions_.forAccount(acc);
  if (!s) return;
  const cos = require('./cosmetics');
  const v = view();
  const owned = cos.view().items.filter((i) => i.owned).map((i) => i.id);
  const profile = {
    name: String(acc.javaNick || acc.name || ''),
    avatar: v.avatar,
    items: owned,
    worn: cos.worn(),
    ms: Math.round(v.ms),
    servers: v.servers.slice(0, 6).map((x) => ({ host: x.host, ms: Math.round(x.ms) })),
    last: v.last ? { host: v.last.host, at: v.last.at } : null,
    playing,
  };
  const res = await ask({ op: 'profile', session: s.session, profile });
  if (!res || !res.ok) log.info(`Profile: not sent (${res ? res.error : 'offline'}).`);
  // still playing: again in a while (friends see "playing now" go stale otherwise)
  if (playing !== null) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => send().catch(() => {}), 4 * 60000);
  }
}

async function ask(body) {
  const { ask: one } = require('./redeem');
  for (const url of relay.MQTT_URLS) {
    try {
      return await one(url, body, 12000);
    } catch (e) {
      log.info(`Profile: ${url}: ${e.message}`);
    }
  }
  return null;
}

// Friends' profiles (those with the launcher): xuid → profile. force: not
// from the minute's cache. Our server not answering (a bad connection) is an
// error, so the window can say so and try again — not "no profile".
const cache = new Map(); // xuid → { at, profile }
async function of(xuids, { force = false } = {}) {
  const want = [...new Set((xuids || []).map(String).filter((x) => /^\d{1,20}$/.test(x)))].slice(0, 40);
  const fresh = want.filter((x) => force || !(cache.has(x) && Date.now() - cache.get(x).at < 60000));
  if (fresh.length) {
    const res = await ask({ op: 'profiles', xuids: fresh });
    if (res && res.ok) for (const x of fresh) cache.set(x, { at: Date.now(), profile: (res.profiles || {})[x] || null });
    else if (!want.some((x) => cache.has(x))) throw new Error(res ? String(res.error || 'server') : 'offline');
  }
  const out = {};
  for (const x of want) if (cache.has(x) && cache.get(x).profile) out[x] = cache.get(x).profile;
  return out;
}

module.exports = {
  setAccount,
  sample,
  gameStopped,
  setAvatar,
  view,
  avatarOf,
  of,
  push,
  flush,
  onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  _test: { reset: () => { state = null; activeKey = 'local'; playing = null; sessions.clear(); cache.clear(); }, hostOf, file: FILE },
};
