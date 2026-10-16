'use strict';
// Cosmetics: the catalogue (assets/cosmetics), what this launcher owns and
// wears, and the event quests that give them — Halloween is all of October:
// the hockey mask for coming in, the rest for playing (time in worlds, blocks
// walked, time on Hypixel or The Hive, monsters beaten — Java tells us that
// through the agent, Bedrock its position through the voice module). A
// finished quest's item waits in the event to be claimed (Skins); claimed, it
// is in the inventory.
//
// Each account has its own (the Xbox account's: "x:<xuid>"), like its
// skins: what one got, another doesn't see. Progress and ownership live on
// this PC (<appDir>/cosmetics.json, one set an account); the game samples
// come from nearby.js. The shop's items (shop.js) are the exception: ours
// only with a receipt our server signed for that account (receipts.js) —
// kept here too, checked every time they're read. What this PC had from
// before accounts goes to the first Xbox account that comes along.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const log = require('./log');
const receipts = require('./receipts');

const FILE = path.join(paths.appDir, 'cosmetics.json');
const SLOTS = ['head', 'back', 'pet'];
const RARITIES = ['common', 'rare', 'epic', 'legendary'];
const listeners = new Set();

// Every event, every year in its month (1–12).
const EVENTS = [
  {
    id: 'halloween', month: 10, name: { ru: 'Хэллоуин', en: 'Halloween' }, color: '#a45cff',
    quests: [
      { id: 'hw_mask', item: 'hockey_mask', kind: 'visit', goal: 1, title: { ru: 'Зайдите в MC Launcher в октябре', en: 'Open MC Launcher in October' } },
      { id: 'hw_hat', item: 'witch_hat', kind: 'minutes', goal: 180, title: { ru: 'Сыграйте 3 часа в мирах', en: 'Play 3 hours in worlds' } },
      { id: 'hw_broom', item: 'broom', kind: 'blocks', goal: 5000, title: { ru: 'Пройдите 5 000 блоков', en: 'Travel 5,000 blocks' } },
      { id: 'hw_wings', item: 'bat_wings', kind: 'serverMinutes', goal: 60, servers: ['hypixel.net', 'hivebedrock.network', 'playhive.com', 'hivemc.com'],
        title: { ru: 'Сыграйте час на Hypixel или The Hive', en: 'Play an hour on Hypixel or The Hive' } },
      { id: 'hw_axe', item: 'axe_in_head', kind: 'kills', goal: 100, title: { ru: 'Победите 100 монстров', en: 'Defeat 100 monsters' } },
    ],
  },
];

// { device, accounts: { key: { owned: {id: {at, quest}}, ready: {id: {at, quest}} (to claim),
//   progress: {"quest:year": n}, worn: {head, back}, receipts } } } — "local": the PC's, while no
//   Xbox account has come along (and what it had from before accounts)
let state = null;
let activeKey = 'local'; // whose: "x:<xuid>" (an Xbox account), "local" while none is
// Items that gave their place to others: whoever had the old one has the new.
const RENAMED = { pumpkin_head: 'hockey_mask' };
let catalog = null; // id → {id, name, nameEn, slot, rarity}
let dirty = false;
let saveTimer = null;
const sessions = new Map(); // game pid → {at, pos, dim, kills}
let fakeNow = null; // tests

const now = () => (fakeNow ? new Date(fakeNow) : new Date());
const emit = (type, payload) => { for (const fn of listeners) { try { fn(type, payload); } catch { /* a listener's problem */ } } };

function loadCatalog() {
  if (catalog) return catalog;
  catalog = new Map();
  try {
    for (const it of JSON.parse(fs.readFileSync(paths.asset('cosmetics', 'index.json'), 'utf8'))) catalog.set(it.id, it);
  } catch (e) {
    log.warn(`Cosmetics: ${e.message}`);
  }
  return catalog;
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
function set(raw) {
  const b = { owned: obj(raw && raw.owned), progress: obj(raw && raw.progress), worn: obj(raw && raw.worn), ready: obj(raw && raw.ready), receipts: raw && Array.isArray(raw.receipts) ? raw.receipts : [] };
  for (const [old, now_] of Object.entries(RENAMED)) {
    if (b.owned[old]) {
      if (!b.owned[now_]) b.owned[now_] = b.owned[old];
      delete b.owned[old];
      dirty = true;
    }
    for (const slot of SLOTS) if (b.worn[slot] === old) { b.worn[slot] = now_; dirty = true; }
  }
  return b;
}

function load() {
  if (state) return state;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    /* none yet */
  }
  state = { accounts: {}, ...(typeof raw.device === 'string' ? { device: raw.device } : {}) };
  for (const [k, v] of Object.entries(obj(raw.accounts))) state.accounts[k] = set(v);
  // from before accounts: the PC's one set, "local" till the first Xbox account takes it
  if (!raw.accounts && (raw.owned || raw.ready || raw.progress || raw.worn)) state.accounts.local = set(raw);
  for (const k of Object.keys(state.accounts)) enforceShop(k);
  return state;
}

const empty = (b) => !b || !(Object.keys(b.owned).length || Object.keys(b.ready).length || Object.keys(b.progress).length);

// Whose cosmetics the launcher shows and the game wears from now on: an
// Xbox account's key ("x:<xuid>"); the first one takes what the PC had.
function setAccount(key) {
  const s = load();
  key = typeof key === 'string' && /^x:\d{1,20}$/.test(key) ? key : 'local';
  if (key !== 'local' && !empty(s.accounts.local)) {
    // the PC's (its shop receipts were this launcher's: the server moves the purchases themselves)
    const b = bucket(key);
    const old = s.accounts.local;
    for (const [id, v] of Object.entries(old.owned)) if (!b.owned[id] && !v.shop) b.owned[id] = v;
    for (const [id, v] of Object.entries(old.ready)) if (!b.owned[id] && !b.ready[id]) b.ready[id] = v;
    for (const [q, n] of Object.entries(old.progress)) b.progress[q] = Math.max(b.progress[q] || 0, n);
    for (const slot of SLOTS) if (!b.worn[slot] && old.worn[slot]) b.worn[slot] = old.worn[slot];
    delete s.accounts.local;
    log.info(`Cosmetics: what this PC had goes to ${key}.`);
    save(true);
  }
  if (key === activeKey) return;
  activeKey = key;
  enforceShop(key);
  emit('changed', view());
}

function bucket(key = activeKey) {
  const s = load();
  if (!s.accounts[key]) s.accounts[key] = set({});
  return s.accounts[key];
}

// whom a set's receipts were signed for: the account, or (no account) this launcher
function identity(key) {
  if (key !== 'local') return key;
  const s = load();
  return typeof s.device === 'string' && s.device.length >= 32 ? crypto.createHash('sha256').update(s.device).digest('hex') : '';
}

// The shop's items an account has receipts for: id → pack.
function shopOwned(key) {
  const b = bucket(key);
  const who = identity(key);
  const out = new Map();
  if (!who) return out;
  for (const r of b.receipts || []) {
    const items = receipts.check(r, who);
    if (items) for (const id of items) out.set(id, r.pack);
  }
  return out;
}

// A shop item owned (or worn) without its receipt goes; one with it is owned.
function enforceShop(key = activeKey) {
  const b = bucket(key);
  const cat = loadCatalog();
  const have = shopOwned(key);
  for (const id of Object.keys(b.owned)) {
    const it = cat.get(id);
    if (it && it.shop && !have.has(id)) { delete b.owned[id]; dirty = true; }
  }
  for (const [id, pack] of have) if (cat.has(id) && !b.owned[id]) { b.owned[id] = { at: Date.now(), shop: pack }; dirty = true; }
  for (const slot of SLOTS) {
    const it = cat.get(b.worn[slot]);
    if (it && it.shop && !b.owned[it.id]) { b.worn[slot] = ''; dirty = true; }
  }
}

function save(now_ = false) {
  dirty = true;
  if (now_) return flush();
  if (!saveTimer) saveTimer = setTimeout(flush, 10000);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty || !state) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(state, null, 1));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (e) {
    log.warn(`Cosmetics: ${e.message}`);
  }
}

const activeEvents = () => EVENTS.filter((e) => now().getMonth() + 1 === e.month);
// when this year's run of an event ends (local time): its month's last moment
const endsAt = (e) => new Date(now().getFullYear(), e.month, 1).getTime();
const progressKey = (q) => `${q.id}:${now().getFullYear()}`;

// A finished quest: its item waits in the event to be claimed; a notice once.
function grant(q, ev) {
  const s = bucket();
  if (s.owned[q.item] || s.ready[q.item]) return;
  s.ready[q.item] = { at: Date.now(), quest: q.id, event: ev.id };
  const item = loadCatalog().get(q.item);
  save(true);
  log.info(`Cosmetics: ${q.item} for ${q.id}.`);
  emit('granted', { item: q.item, name: item ? item.name : q.item, nameEn: (item && (item.nameEn || item.name)) || q.item, quest: q.id, title: q.title, event: ev.name });
  emit('changed', view());
}

function add(kind, amount, filter) {
  if (!(amount > 0)) return;
  const s = bucket();
  for (const ev of activeEvents()) {
    for (const q of ev.quests) {
      if (q.kind !== kind || s.owned[q.item] || s.ready[q.item] || (filter && !filter(q))) continue;
      const key = progressKey(q);
      s.progress[key] = Math.min(q.goal, (s.progress[key] || 0) + amount);
      if (s.progress[key] >= q.goal) grant(q, ev);
    }
  }
  save();
}

// A sample from a running game (nearby.js): {pid, edition, position, dimension, server, kills}.
function sample(p) {
  if (!p || !p.pid) return;
  const t = Date.now();
  const prev = sessions.get(p.pid);
  sessions.set(p.pid, { at: t, pos: p.position, dim: p.dimension, kills: p.kills });
  if (!prev) return;
  const dt = t - prev.at;
  if (dt <= 0 || dt > 5000) return; // a pause (menu, alt-tab): not counted
  add('minutes', dt / 60000);
  const host = String(p.server || '').toLowerCase().replace(/:\d+$/, '');
  if (host) add('serverMinutes', dt / 60000, (q) => (q.servers || []).some((sv) => host === sv || host.endsWith(`.${sv}`)));
  if (Array.isArray(p.position) && Array.isArray(prev.pos) && p.dimension === prev.dim) {
    const d = Math.hypot(p.position[0] - prev.pos[0], p.position[2] - prev.pos[2]);
    if (d < 30) add('blocks', d); // more is a teleport, not a walk
  }
  if (Number.isFinite(p.kills) && Number.isFinite(prev.kills) && p.kills > prev.kills && p.kills - prev.kills < 20) add('kills', p.kills - prev.kills);
}

function gameStopped(pid) {
  sessions.delete(pid);
}

function view() {
  const s = bucket();
  const cat = loadCatalog();
  const items = [];
  for (const ev of EVENTS) {
    const active = activeEvents().includes(ev);
    for (const q of ev.quests) {
      const it = cat.get(q.item);
      if (!it) continue;
      items.push({
        id: it.id, name: it.name, nameEn: it.nameEn || it.name, slot: it.slot, rarity: RARITIES.includes(it.rarity) ? it.rarity : 'common',
        owned: !!s.owned[it.id], ready: !s.owned[it.id] && !!s.ready[it.id], worn: s.worn[it.slot] === it.id,
        event: { id: ev.id, name: ev.name, active },
        quest: { id: q.id, title: q.title, kind: q.kind, goal: q.goal, progress: Math.floor(s.progress[progressKey(q)] || 0) },
      });
    }
  }
  // the shop's: in the inventory once bought
  for (const it of cat.values()) {
    if (!it.shop) continue;
    items.push({
      id: it.id, name: it.name, nameEn: it.nameEn || it.name, slot: it.slot, rarity: RARITIES.includes(it.rarity) ? it.rarity : 'common',
      owned: !!s.owned[it.id], ready: false, worn: s.worn[it.slot] === it.id, shop: true,
      event: { id: 'shop', name: { ru: 'Магазин', en: 'Shop' }, active: false }, quest: null,
    });
  }
  return { items, worn: { ...s.worn }, now: now().getTime(),
    events: EVENTS.map((e) => ({ id: e.id, name: e.name, month: e.month, color: e.color || '', active: activeEvents().includes(e), ends: endsAt(e) })) };
}

// What this player wears, for the party card and the game (key: another of
// this PC's accounts — Bedrock dresses each of them by its own gamertag).
function worn(key = activeKey) {
  const s = bucket(key);
  return SLOTS.map((slot) => s.worn[slot]).filter((id) => id && s.owned[id] && loadCatalog().has(id));
}

// A finished quest's item into the inventory (it goes on if its slot is empty).
function claim(id) {
  const s = bucket();
  const it = loadCatalog().get(id);
  if (!it || !s.ready[id]) throw new Error('Эту награду ещё нельзя забрать.');
  if (!s.owned[id]) s.owned[id] = s.ready[id];
  delete s.ready[id];
  if (!s.worn[it.slot]) s.worn[it.slot] = id;
  save(true);
  emit('changed', view());
  return view();
}

function wear(slot, id) {
  const s = bucket();
  if (!SLOTS.includes(slot)) throw new Error('Нет такого места.');
  if (id) {
    const it = loadCatalog().get(id);
    if (!it || it.slot !== slot || !s.owned[id]) throw new Error('Эта косметика ещё не получена.');
  }
  s.worn[slot] = id || '';
  save(true);
  emit('changed', view());
  return view();
}

// This launcher's key for the activation server (one code per reward per
// launcher): a random id kept with the cosmetics, sent only as its hash.
function deviceKey() {
  const s = load();
  if (typeof s.device !== 'string' || s.device.length < 32) {
    s.device = crypto.randomBytes(16).toString('hex');
    save(true);
  }
  return crypto.createHash('sha256').update(s.device).digest('hex');
}

// What an activation code gave: an event's whole set, or named items.
// Everything not owned yet is owned now (empty slots get something on).
function grantSet({ event, items, reward } = {}) {
  const s = bucket();
  const cat = loadCatalog();
  const ev = EVENTS.find((e) => e.id === event);
  const ids = ev ? ev.quests.map((q) => q.item) : Array.isArray(items) ? items.map(String) : [];
  const got = [];
  for (const id of ids) {
    const it = cat.get(id);
    if (!it) continue;
    if (!s.owned[id]) s.owned[id] = { at: Date.now(), code: String(reward || ''), event: ev ? ev.id : undefined };
    delete s.ready[id];
    if (!s.worn[it.slot]) s.worn[it.slot] = id;
    got.push({ id, name: it.name, nameEn: it.nameEn || it.name });
  }
  save(true);
  emit('changed', view());
  return got;
}

// The server's word on what this account bought (shop.js): its receipts,
// those that check out kept; wear: put these on (just bought).
function setReceipts(list, wear = []) {
  deviceKey();
  const s = bucket();
  const who = identity(activeKey);
  s.receipts = (Array.isArray(list) ? list : []).filter((r) => receipts.check(r, who));
  enforceShop();
  const cat = loadCatalog();
  for (const id of wear) {
    const it = cat.get(id);
    if (it && s.owned[id]) s.worn[it.slot] = id;
  }
  save(true);
  emit('changed', view());
  return view();
}

function init() {
  load();
  loadCatalog();
  // coming in during an event: its "visit" quest
  add('visit', 1);
  flush();
}

module.exports = {
  init,
  setAccount,
  account: () => activeKey,
  view,
  worn,
  wear,
  claim,
  deviceKey,
  grantSet,
  setReceipts,
  sample,
  gameStopped,
  flush,
  onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  _test: { setNow: (d) => { fakeNow = d; }, reset: () => { state = null; catalog = null; activeKey = 'local'; sessions.clear(); }, file: FILE },
};
