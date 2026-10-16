'use strict';
// Messages between Xbox friends, launcher to launcher: not the Xbox chat and
// no server of ours — the same public relays as parties and friend lobbies
// (friend-lobbies.js keeps the lines; this rides them).
//
// Every Xbox account has an inbox topic, a hash of its XUID; a launcher
// listens on the inbox of the account it's signed in with and writes into
// its friends'. Each account gets an X25519 key on this PC:
//   hi   "here I am, this is my key" — to every friend when the relays come
//        up or the friend comes online, and back to a friend who says it first
//   box  a message, a delivery note (ack) or a "read" — sealed with a key only
//        the two launchers can derive (ECDH of their keys)
// The first key a friend's launcher shows is trusted from then on. A
// different one later — another PC, a reinstall, or someone posing as them —
// is only noted in the chat: nothing goes out to it, and what comes from it is
// marked, until the user trusts it there.
// The relays keep nothing: a message to a friend whose launcher is closed
// waits on this PC and goes out when they say hi.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const friends = require('./friends');
const relay = require('./friend-lobbies');
const party = require('./party');
const paths = require('./paths');
const log = require('./log');

const FILE = path.join(paths.appDir, 'messages.json');
const XUID_RE = /^\d{1,20}$/;
const PUB_RE = /^[A-Za-z0-9+/]{43}=$/;
const ID_RE = /^[A-Za-z0-9_-]{6,24}$/;
const STICKER = /^[a-z0-9_]{1,24}$/;
const KEEP = 300; // messages per conversation
const TEXT_MAX = 1000;
const RETRY_MS = [4000, 15000, 60000];
const HI_GAP_MS = 20000;
const REPLY_GAP_MS = 3000;
const SEEN_KEEP = 600;
const RESEND_MAX = 50;
// DER header of an X25519 public key: the raw 32 bytes follow
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');

let data = { v: 1, ids: {}, chats: {} }; // ids: my XUID → key; chats: my XUID → friend XUID → chat
let loaded = false;
let saveTimer = null;
let me = null; // { xuid, pub, priv, inbox }
let openChat = ''; // the conversation on screen
let focused = false;
const lastHi = new Map(); // friend XUID → when we last said hi
const lastReply = new Map(); // friend XUID|their key → when we last answered (each PC of theirs gets one)
const seen = new Set(); // packets already handled: each comes through every relay
const retries = new Map(); // message id → timer
const pairKeys = new Map();
const inboxes = new Map();
let presence = new Map(); // friend XUID → their last Xbox state
const listeners = new Set();

function emit(type, payload) {
  for (const fn of listeners) {
    try {
      fn(type, payload);
    } catch {
      /* ignore */
    }
  }
}

const rnd = (n = 9) => crypto.randomBytes(n).toString('base64url');
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, n);

// ---- on disk ---------------------------------------------------------------------------------

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (d && d.v === 1) data = { v: 1, ids: d.ids || {}, chats: d.chats || {} };
  } catch {
    /* nothing yet */
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!loaded) return;
  try {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    log.warn(`Messages: not saved (${e.message})`);
  }
}

// the private key under Windows' own protection (DPAPI), as the accounts are
function sealSecret(buf) {
  if (safeStorage.isEncryptionAvailable()) return `v1:${safeStorage.encryptString(buf.toString('base64')).toString('base64')}`;
  return `v0:${buf.toString('base64')}`;
}

function openSecret(s) {
  if (s.startsWith('v1:')) return Buffer.from(safeStorage.decryptString(Buffer.from(s.slice(3), 'base64')), 'base64');
  if (s.startsWith('v0:')) return Buffer.from(s.slice(3), 'base64');
  throw new Error('unknown key format');
}

function identity(xuid) {
  const id = data.ids[xuid];
  if (id) {
    try {
      return { pub: id.pub, priv: crypto.createPrivateKey({ key: openSecret(id.priv), format: 'der', type: 'pkcs8' }) };
    } catch {
      /* unreadable (copied from another PC?): a new one, friends get asked to trust it */
    }
  }
  const kp = crypto.generateKeyPairSync('x25519');
  const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  data.ids[xuid] = { pub, priv: sealSecret(kp.privateKey.export({ format: 'der', type: 'pkcs8' })) };
  save();
  return { pub, priv: kp.privateKey };
}

// ---- keys and envelopes -------------------------------------------------------------------------

function inboxOf(xuid) {
  let b = inboxes.get(xuid);
  if (!b) {
    b = {
      topic: `mcl/dm/${crypto.createHash('sha256').update(`mclauncher-dm-inbox:${xuid}`).digest('hex').slice(0, 32)}`,
      key: Buffer.from(crypto.hkdfSync('sha256', Buffer.from(xuid, 'utf8'), Buffer.from('mclauncher-dm'), Buffer.from('inbox'), 32)),
    };
    inboxes.set(xuid, b);
  }
  return b;
}

function pairKey(xuid, pub) {
  const k = `${me.xuid}|${me.pub}|${xuid}|${pub}`;
  let key = pairKeys.get(k);
  if (!key) {
    const theirs = crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pub, 'base64')]), format: 'der', type: 'spki' });
    const shared = crypto.diffieHellman({ privateKey: me.priv, publicKey: theirs });
    const ends = [`${me.xuid}:${me.pub}`, `${xuid}:${pub}`].sort().join('|');
    key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(ends, 'utf8'), Buffer.from('mclauncher-dm-pair'), 32));
    pairKeys.set(k, key);
  }
  return key;
}

function post(xuid, body) {
  const b = inboxOf(xuid);
  return relay.post(b.topic, party.seal(b.key, { ...body, n: rnd(6) }));
}

// ---- conversations ---------------------------------------------------------------------------------

function friendOf(xuid) {
  return friends.getState().friends.find((f) => f.xuid === xuid) || null;
}

function chatOf(xuid, create = true) {
  if (!me) return null;
  const mine = data.chats[me.xuid] || (data.chats[me.xuid] = {});
  let c = mine[xuid];
  if (!c && create) c = mine[xuid] = { trusted: '', pending: '', msgs: [], unread: 0 };
  return c || null;
}

function push(c, m) {
  c.msgs.push(m);
  if (c.msgs.length > KEEP) c.msgs.splice(0, c.msgs.length - KEEP);
}

let changeTimer = null;
const dirty = new Set();
function changed(xuid) {
  save();
  dirty.add(xuid);
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    const list = [...dirty];
    dirty.clear();
    emit('changed', { summary: summary(), chats: list.map(conversation) });
  }, 30);
}

function summary() {
  if (!me) return { me: '', chats: {}, unread: 0 };
  const chats = {};
  let unread = 0;
  for (const [xuid, c] of Object.entries(data.chats[me.xuid] || {})) {
    let last = null;
    for (let i = c.msgs.length - 1; i >= 0 && !last; i--) if (!c.msgs[i].sys) last = c.msgs[i];
    chats[xuid] = {
      unread: c.unread || 0,
      launcher: !!c.trusted,
      pending: !!c.pending,
      last: last ? { at: last.at, self: !!last.self, text: last.text || '', sticker: last.sticker || '' } : null,
    };
    unread += c.unread || 0;
  }
  return { me: me.xuid, chats, unread };
}

function conversation(xuid) {
  const c = chatOf(xuid, false);
  return { xuid, launcher: !!(c && c.trusted), pending: !!(c && c.pending), msgs: c ? c.msgs : [] };
}

// ---- out ----------------------------------------------------------------------------------------------

// re: an answer to their hi, from the PC with that key
function hi(xuid, re = false, theirs = '') {
  if (!me || !relay.isUp()) return;
  const gaps = re ? lastReply : lastHi;
  const k = re ? `${xuid}|${theirs}` : xuid;
  if (Date.now() - (gaps.get(k) || 0) < (re ? REPLY_GAP_MS : HI_GAP_MS)) return;
  gaps.set(k, Date.now());
  post(xuid, { t: 'hi', from: me.xuid, pub: me.pub, re: re ? 1 : 0 });
}

// sealed for the friend's trusted key only
function box(xuid, inner) {
  const c = chatOf(xuid);
  if (!c || !c.trusted) return false;
  let key;
  try {
    key = pairKey(xuid, c.trusted);
  } catch {
    return false; // a key no exchange works with
  }
  const sealed = party.seal(key, { ...inner, from: me.xuid, to: xuid });
  return post(xuid, { t: 'box', from: me.xuid, pub: me.pub, to: c.trusted, box: sealed.toString('base64') });
}

function deliver(xuid, m, round = 0) {
  clearTimeout(retries.get(m.id));
  retries.delete(m.id);
  const c = chatOf(xuid);
  if (!c || !c.trusted || !relay.isUp()) {
    hi(xuid); // it goes out when they answer
    return;
  }
  if (!box(xuid, { k: 'msg', id: m.id, at: m.at, text: m.text, sticker: m.sticker })) return;
  if (m.state === 'waiting') {
    m.state = 'sent';
    changed(xuid);
  }
  if (round < RETRY_MS.length) {
    retries.set(m.id, setTimeout(() => {
      retries.delete(m.id);
      if (m.state === 'sent' && chatOf(xuid, false) === c) deliver(xuid, m, round + 1);
    }, RETRY_MS[round]));
  }
}

// what hasn't reached them yet, once they're around
function resend(xuid) {
  const c = chatOf(xuid, false);
  if (!c || !c.trusted) return;
  const due = c.msgs.filter((m) => m.self && (m.state === 'waiting' || m.state === 'sent')).slice(-RESEND_MAX);
  for (const m of due) deliver(xuid, m);
}

function send(xuid, msg) {
  if (!me) throw new Error('Войдите в аккаунт Microsoft или Xbox, чтобы писать друзьям.');
  xuid = String(xuid || '');
  if (!XUID_RE.test(xuid) || !friendOf(xuid)) throw new Error('Писать можно только друзьям из Xbox.');
  const m = { id: rnd(), at: Date.now(), self: true, state: 'waiting' };
  if (msg && typeof msg.sticker === 'string' && STICKER.test(msg.sticker)) m.sticker = msg.sticker;
  else {
    const text = clean(msg && msg.text, TEXT_MAX).trim();
    if (!text) throw new Error('Пустое сообщение.');
    m.text = text;
  }
  push(chatOf(xuid), m);
  changed(xuid);
  deliver(xuid, m);
  return m;
}

// ---- in --------------------------------------------------------------------------------------------------

// a key a friend's launcher shows: the first is trusted, a different one waits
function meet(xuid, pub) {
  const c = chatOf(xuid);
  if (!c.trusted) {
    c.trusted = pub;
    changed(xuid);
    return true;
  }
  if (c.trusted === pub) return true;
  if (c.pending !== pub) {
    if (!c.pending) push(c, { id: rnd(), at: Date.now(), sys: 'newKey' });
    c.pending = pub;
    changed(xuid);
  }
  return false;
}

function onPacket(payload) {
  if (!me) return;
  const m = party.open(me.inbox.key, payload);
  if (!m || typeof m !== 'object' || typeof m.n !== 'string' || seen.has(m.n)) return;
  seen.add(m.n);
  if (seen.size > SEEN_KEEP) seen.delete(seen.values().next().value);
  const from = String(m.from || '');
  if (!XUID_RE.test(from) || from === me.xuid || !friendOf(from)) return;
  const pub = typeof m.pub === 'string' && PUB_RE.test(m.pub) ? m.pub : '';
  if (!pub) return;
  if (m.t === 'hi') onHi(from, pub, !!m.re);
  else if (m.t === 'box' && m.to === me.pub) onBox(from, pub, m);
}

function onHi(from, pub, re) {
  const trusted = meet(from, pub);
  if (!re) hi(from, true, pub);
  if (trusted) resend(from);
}

function onBox(from, pub, m) {
  let inner = null;
  try {
    inner = party.open(pairKey(from, pub), Buffer.from(String(m.box || ''), 'base64'));
  } catch {
    return;
  }
  if (!inner || inner.from !== from || inner.to !== me.xuid) return;
  const trusted = meet(from, pub);
  const c = chatOf(from);
  if (inner.k === 'msg') {
    const id = String(inner.id || '');
    if (!ID_RE.test(id)) return;
    if (trusted) box(from, { k: 'ack', ids: [id] });
    if (c.msgs.some((x) => x.id === id && !x.self)) return; // a resend we already have
    const msg = { id, at: Math.min(Date.now(), Number(inner.at) || Date.now()), self: false };
    if (typeof inner.sticker === 'string' && STICKER.test(inner.sticker)) msg.sticker = inner.sticker;
    else {
      const text = clean(inner.text, TEXT_MAX).trim();
      if (!text) return;
      msg.text = text;
    }
    if (!trusted) msg.unverified = true;
    push(c, msg);
    const looking = openChat === from && focused;
    if (looking) {
      if (trusted) box(from, { k: 'read', ids: [id] });
    } else c.unread = (c.unread || 0) + 1;
    changed(from);
    const f = friendOf(from) || {};
    emit('message', { xuid: from, gamertag: f.gamertag || from, avatar: f.avatar || '', text: msg.text || '', sticker: msg.sticker || '', looking });
    return;
  }
  if (!trusted || (inner.k !== 'ack' && inner.k !== 'read') || !Array.isArray(inner.ids)) return;
  const ids = new Set(inner.ids.slice(0, 100).map(String));
  let any = false;
  for (const x of c.msgs) {
    if (!x.self || !ids.has(x.id)) continue;
    const next = inner.k === 'read' ? 'read' : x.state === 'read' ? 'read' : 'delivered';
    if (x.state !== next) {
      x.state = next;
      any = true;
    }
    clearTimeout(retries.get(x.id));
    retries.delete(x.id);
  }
  if (any) changed(from);
}

// ---- the window ------------------------------------------------------------------------------------

function markRead(xuid) {
  const c = chatOf(xuid, false);
  if (!c || !c.unread) return;
  const ids = c.msgs.filter((m) => !m.self && !m.sys).slice(-Math.min(c.unread, 100)).map((m) => m.id);
  c.unread = 0;
  if (c.trusted && ids.length) box(xuid, { k: 'read', ids });
  changed(xuid);
}

function setOpen(xuid) {
  openChat = XUID_RE.test(String(xuid || '')) ? String(xuid) : '';
  if (openChat && focused) markRead(openChat);
  // opening a chat is a good moment to make sure they know we're here
  if (openChat) hi(openChat);
}

function setFocus(on) {
  focused = !!on;
  if (focused && openChat) markRead(openChat);
}

function trust(xuid) {
  const c = chatOf(String(xuid || ''), false);
  if (!c || !c.pending) return conversation(xuid);
  c.trusted = c.pending;
  c.pending = '';
  for (const m of c.msgs) {
    if (m.unverified) delete m.unverified;
    if (m.sys === 'newKey') m.sys = 'trusted';
  }
  changed(xuid);
  lastHi.delete(xuid);
  hi(xuid);
  resend(xuid);
  return conversation(xuid);
}

function clear(xuid) {
  const c = chatOf(String(xuid || ''), false);
  if (!c) return conversation(xuid);
  for (const m of c.msgs) {
    clearTimeout(retries.get(m.id));
    retries.delete(m.id);
  }
  c.msgs = [];
  c.unread = 0;
  changed(xuid);
  return conversation(xuid);
}

// ---- keeping up with the account and friends ------------------------------------------------------------

function sync() {
  const st = friends.getState();
  const xuid = st.me && XUID_RE.test(String(st.me.xuid || '')) ? String(st.me.xuid) : '';
  if ((me ? me.xuid : '') !== xuid) {
    if (me) relay.unwatch(me.inbox.topic);
    for (const t of retries.values()) clearTimeout(t);
    retries.clear();
    lastHi.clear();
    lastReply.clear();
    pairKeys.clear();
    presence = new Map();
    me = null;
    if (xuid) {
      load();
      const id = identity(xuid);
      me = { xuid, pub: id.pub, priv: id.priv, inbox: inboxOf(xuid) };
      relay.watch(me.inbox.topic, onPacket);
      log.info('Messages: inbox open.');
    }
    emit('changed', { summary: summary(), chats: [] });
  }
  if (!me) return;
  // a friend who just came online (or was just added) hears we're here
  const next = new Map();
  for (const f of st.friends) {
    if (!XUID_RE.test(String(f.xuid || ''))) continue;
    next.set(f.xuid, f.state);
    const before = presence.get(f.xuid);
    if (before === undefined ? presence.size > 0 : before === 'offline' && f.state !== 'offline') hi(f.xuid);
  }
  presence = next;
}

function helloAll() {
  if (!me) return;
  for (const f of friends.getState().friends) if (XUID_RE.test(String(f.xuid || ''))) hi(f.xuid);
}

let started = false;
function init() {
  if (started) return;
  started = true;
  friends.onChange(sync);
  relay.onEvent((type) => type === 'relayUp' && helloAll());
  sync();
}

module.exports = {
  init,
  summary,
  conversation: (xuid) => (me ? conversation(String(xuid || '')) : { xuid, launcher: false, pending: false, msgs: [] }),
  send,
  setOpen,
  setFocus,
  trust,
  clear,
  flush,
  onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
