'use strict';
// Weekly quests (server/redeem.py, op quests / quest_claim / quest_reward):
// three a week for the account signed in to Xbox, made by our server — each a
// kind the game samples count here (minutes in worlds, minutes on servers,
// blocks travelled, mobs beaten, different days played) and a goal. The
// progress is counted here, per account and week (quests.json); a quest done
// is reported at once (again later if we were offline). All three done: the
// reward — three cards face down, one picked in the window, what's in them
// drawn by the server then (mostly 20–30 coins, now and then a pack). A new
// week's quests are a "drop" the window shows once.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const log = require('./log');

const FILE = path.join(paths.appDir, 'quests.json');
const KINDS = new Set(['minutes', 'serverMinutes', 'blocks', 'kills', 'days']);
const listeners = new Set();
// { accounts: { "x:<xuid>": { week, starts, ends, quests: [...], claimed: [ids], progress: {id: n}, days: ["YYYY-MM-DD"],
//   reward: {state: locked|ready|taken, pick, cards}, lastWeek: {week} (its reward still to be picked), seen } } }
let state = null;
let saveTimer = null;
let refreshing = null;
let timer = null;
const claiming = new Set();

const emit = (type, payload) => { for (const fn of listeners) { try { fn(type, payload); } catch { /* a listener's */ } } };
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function load() {
  if (state) return state;
  try {
    state = { accounts: obj(JSON.parse(fs.readFileSync(FILE, 'utf8')).accounts) };
  } catch {
    state = { accounts: {} };
  }
  return state;
}

function save(now = false) {
  clearTimeout(saveTimer);
  const write = () => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(load(), null, 1));
      fs.renameSync(`${FILE}.tmp`, FILE);
    } catch (e) {
      log.warn(`Quests: ${e.message}`);
    }
  };
  if (now) write();
  else saveTimer = setTimeout(write, 15000);
}

function account() {
  const acc = require('./auth').activeAccount();
  return { acc, key: require('./account-session').keyOf(acc) };
}

// the account's week as we have it (null: none yet, or it's over)
function current(key) {
  const b = key && load().accounts[key];
  return b && Array.isArray(b.quests) && b.ends * 1000 > Date.now() ? b : null;
}

async function ask(body) {
  const relay = require('./relay-server');
  const { ask: one } = require('./redeem');
  for (const url of relay.SECURE_URLS) {
    try {
      return await one(url, body, 12000);
    } catch { /* the next address */ }
  }
  return null;
}

async function session(acc) {
  const s = await require('./account-session').forAccount(acc);
  return s && s.session;
}

const rewardOf = (r) => (r && ['locked', 'ready', 'taken'].includes(r.state) ? r : { state: 'locked' });

// This week's quests from the server (a new week: progress from nothing)
function refresh() {
  if (!refreshing) refreshing = (async () => {
    const { acc, key } = account();
    if (!key) return view();
    const sess = await session(acc);
    if (!sess) return view();
    const res = await ask({ op: 'quests', session: sess });
    if (!res || !res.ok || !Array.isArray(res.quests)) return view();
    const s = load();
    const old = s.accounts[key] || {};
    const sameWeek = old.week === res.week;
    s.accounts[key] = {
      week: res.week,
      starts: res.starts,
      ends: res.ends,
      quests: res.quests.filter((q) => q && KINDS.has(q.kind)).slice(0, 3),
      claimed: Array.isArray(res.claimed) ? res.claimed : [],
      progress: sameWeek ? obj(old.progress) : {},
      days: sameWeek && Array.isArray(old.days) ? old.days : [],
      reward: rewardOf(res.reward),
      lastWeek: res.lastWeek && res.lastWeek.week ? { week: res.lastWeek.week } : null,
      seen: old.seen,
    };
    save(true);
    if (!sameWeek) log.info(`Quests: week ${res.week} — ${res.quests.map((q) => `${q.kind} ${q.goal}`).join(', ')}.`);
    if (Number.isFinite(res.coins)) require('./shop').setCoins(res.coins);
    emit('changed', view());
    // done while we couldn't say so: reported now
    for (const q of s.accounts[key].quests) if (done(s.accounts[key], q)) claim(key, q);
    return view();
  })().catch((e) => {
    log.warn(`Quests: ${e.message}`);
    return view();
  }).finally(() => { refreshing = null; });
  return refreshing;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const progressOf = (b, q) => (q.kind === 'days' ? (b.days || []).length : Math.floor(obj(b.progress)[q.id] || 0));
const done = (b, q) => !b.claimed.includes(q.id) && progressOf(b, q) >= q.goal;

// What a game sample counted (cosmetics.sample): kind, how much.
function add(kind, amount) {
  if (!(amount > 0) || !KINDS.has(kind)) return;
  const { key } = account();
  const b = current(key);
  if (!b) return;
  let changed = false;
  if (kind === 'minutes' && !b.days.includes(today())) {
    b.days = [...b.days, today()].slice(-7);
    changed = true;
  }
  for (const q of b.quests) {
    if (b.claimed.includes(q.id)) continue;
    if (q.kind === kind) {
      const was = b.progress[q.id] || 0;
      b.progress[q.id] = Math.min(q.goal, was + amount);
      if (Math.floor(was) !== Math.floor(b.progress[q.id])) changed = true;
    }
    if (done(b, q)) claim(key, q);
  }
  save();
  if (changed) emit('changed', view());
}

// A quest done: told to the server (once; offline: at the next refresh)
async function claim(key, q) {
  if (claiming.has(q.id)) return;
  claiming.add(q.id);
  try {
    const { acc, key: now } = account();
    if (now !== key) return;
    const b = current(key);
    const sess = b && await session(acc);
    if (!sess) return;
    // the quest goes as 'quest': 'id' is the MQTT client's own (where the answer goes)
    const res = await ask({ op: 'quest_claim', session: sess, week: b.week, quest: q.id, progress: progressOf(b, q) });
    if (!res) return;
    if (!res.ok) {
      log.info(`Quests: ${q.id} not taken (${res.error}).`);
      return;
    }
    if (Array.isArray(res.claimed)) b.claimed = res.claimed;
    else if (!b.claimed.includes(q.id)) b.claimed.push(q.id);
    b.reward = rewardOf(res.reward);
    save(true);
    log.info(`Quests: ${q.id} done (${b.claimed.length}/3)${res.again ? ' (again)' : ''}.`);
    if (!res.again) emit('claimed', { id: q.id, title: q.title, count: b.claimed.length, ready: b.reward.state === 'ready' });
    emit('changed', view());
  } catch (e) {
    log.warn(`Quests: ${e.message}`);
  } finally {
    claiming.delete(q.id);
  }
}

// The reward: card `pick` (0–2) of the week's three → {ok, pick, cards, coins} or {ok: false, error}
async function pickReward(week, pick) {
  const { acc, key } = account();
  const b = current(key);
  if (!b) return { ok: false, error: 'offline' };
  const which = Number(week);
  const mine = which === b.week ? b.reward.state === 'ready' || b.reward.state === 'taken' : b.lastWeek && b.lastWeek.week === which;
  if (!mine || ![0, 1, 2].includes(Number(pick))) return { ok: false, error: 'locked' };
  const sess = await session(acc);
  if (!sess) return { ok: false, error: 'offline' };
  const res = await ask({ op: 'quest_reward', session: sess, week: which, pick: Number(pick) });
  if (!res) return { ok: false, error: 'offline' };
  if (!res.ok) return { ok: false, error: String(res.error || 'unknown') };
  const got = res.cards[res.pick];
  if (which === b.week) b.reward = { state: 'taken', pick: res.pick, cards: res.cards };
  else b.lastWeek = null;
  save(true);
  if (Number.isFinite(res.coins)) require('./shop').setCoins(res.coins);
  // a pack: its receipt, the account's from now on (and on at once)
  if (Array.isArray(res.receipts)) require('./cosmetics').setReceipts(res.receipts, got && got.type === 'item' && !res.again ? got.items : []);
  log.info(`Quests: week ${which} reward — card ${res.pick}: ${got ? (got.type === 'coins' ? `${got.coins} coins` : got.pack) : '?'}${res.again ? ' (again)' : ''}.`);
  emit('changed', view());
  return { ok: true, pick: res.pick, cards: res.cards, coins: res.coins, again: !!res.again };
}

// For the window and the overlay: the week, its quests, how far they've got, the reward.
function view() {
  const { key } = account();
  if (!key) return { account: false, quests: [] };
  const b = current(key);
  if (!b) return { account: true, quests: [] };
  const reward = rewardOf(b.reward);
  return {
    account: true,
    week: b.week,
    ends: b.ends * 1000,
    fresh: b.seen !== b.week,
    quests: b.quests.map((q) => ({ id: q.id, kind: q.kind, goal: q.goal, title: q.title, progress: Math.min(q.goal, progressOf(b, q)), claimed: b.claimed.includes(q.id) })),
    reward,
    // the week whose cards wait to be picked: this one's, or last week's still
    rewardWeek: reward.state === 'ready' ? b.week : b.lastWeek ? b.lastWeek.week : null,
  };
}

// the drop shown: not again this week
function seen(week) {
  const { key } = account();
  const b = current(key);
  if (!b || b.week !== Number(week)) return view();
  b.seen = b.week;
  save(true);
  emit('changed', view());
  return view();
}

// Asked at the start, every hour, when the week turns over, and for another account
function start() {
  refresh();
  clearInterval(timer);
  timer = setInterval(() => {
    const { key } = account();
    if (!current(key) || Date.now() % 3600000 < 60000) refresh();
  }, 60000);
}

module.exports = {
  start,
  refresh,
  add,
  view,
  seen,
  pickReward,
  flush: () => save(true),
  onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  _test: { reset: () => { state = null; claiming.clear(); }, today },
};
