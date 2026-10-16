'use strict';
// Friends' open lobbies: the leader's launcher lets its Xbox friends know the
// lobby is open, and a friend with MC Launcher joins with one click — no code
// to send around.
//
// The same public relays as parties (party.relayGroups). Every Xbox account
// has a lobby topic, a hash of its XUID; a launcher listens on the topics of
// everyone on its friends list, and — while it leads a party — on its own.
// What goes there is sealed with a key derived from that XUID:
//   open    the leader, every 20 s while the lobby is open: the party code,
//           who leads (name and the face of their skin), how many are in
//   closed  the leader, when the lobby ends
//   ask     a launcher that just started listening; the leader answers with
//           "open" right away instead of on its next beat
// Anyone who knows a XUID could read its beacon: the code is no more secret
// than an invite link, the leader can kick (party.kick), and the beacon can be
// switched off (config.partyFriends).
//
// Other friend-to-friend traffic rides the same lines (watch / post): the
// messenger's inboxes (messenger.js).

const crypto = require('crypto');
const { MqttClient } = require('./mqtt');
const party = require('./party');
const friends = require('./friends');
const config = require('./config');
const log = require('./log');

const BEACON_MS = 20000;
const STALE_MS = 50000;
const ASK_GAP_MS = 1000;
const RELAY_TIMEOUT_MS = 20000;
const XUID_RE = /^\d{1,20}$/;

let links = [];
let running = false;
let generation = 0;
let stopTimer = null;
let sweepTimer = null;
let beaconTimer = null;
let changeTimer = null;
const topics = new Map(); // friends' topics: topic → { xuid, key, topic }
const lobbies = new Map(); // xuid → { code, name, face, count, capacity, edition, installName, server, seen }
let mine = null; // our own topic, while we lead a party friends may see
let lastBeacon = '';
let lastAnswer = 0;
let answerTimer = null;
const listeners = new Set();
const extra = new Map(); // other topics on these lines: topic → handler(payload)

function emit(type, payload) {
  for (const fn of listeners) {
    try {
      fn(type, payload);
    } catch {
      /* ignore */
    }
  }
}

const secrets = new Map();
function secretsFor(xuid) {
  let s = secrets.get(xuid);
  if (!s) {
    s = {
      xuid,
      key: Buffer.from(crypto.hkdfSync('sha256', Buffer.from(xuid, 'utf8'), Buffer.from('mclauncher-friend-lobby'), Buffer.from('key'), 32)),
      topic: `mcl/fl/${crypto.createHash('sha256').update(`mclauncher-friend-lobby-topic:${xuid}`).digest('hex').slice(0, 32)}`,
    };
    secrets.set(xuid, s);
  }
  return s;
}

// ---- what the window sees ---------------------------------------------------------------

function list() {
  const p = party.state();
  const here = p.active ? party.normalize(p.code) : '';
  const people = friends.getState().friends;
  return [...lobbies.entries()].map(([xuid, l]) => {
    const f = people.find((x) => x.xuid === xuid);
    return {
      xuid,
      gamertag: f ? f.gamertag : l.name,
      avatar: f ? f.avatar || '' : '',
      face: l.face || '',
      name: l.name,
      count: l.count,
      capacity: l.capacity,
      edition: l.edition,
      installName: l.installName,
      server: l.server,
      joined: !!here && here === l.code,
    };
  });
}

// the party beats every few seconds: the window hears only real changes
let lastSent = '';
function changed() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    const now = list();
    const key = JSON.stringify(now);
    if (key === lastSent) return;
    lastSent = key;
    emit('changed', now);
  }, 50);
}

// ---- relays -------------------------------------------------------------------------------

function publish(target, msg) {
  const packet = party.seal(target.key, { ...msg, at: Date.now(), n: crypto.randomBytes(6).toString('base64') });
  for (const l of links) {
    if (!l.up) continue;
    try {
      l.client.publish(target.topic, packet);
    } catch {
      /* that line dropped; its reconnect is on the way */
    }
  }
}

function eachClient(fn) {
  for (const l of links) if (l.up) fn(l.client);
}

const num = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
const text = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n);

function onMessage(topic, payload) {
  const own = extra.get(topic);
  if (own) {
    own(payload);
    return;
  }
  if (mine && topic === mine.topic) {
    const m = party.open(mine.key, payload);
    // our own beacons come back too; only a question needs an answer
    if (m && m.t === 'ask') answer();
    return;
  }
  const target = topics.get(topic);
  if (!target) return;
  const m = party.open(target.key, payload);
  if (!m) return;
  if (m.t === 'open') {
    const code = party.normalize(m.code);
    if (!code) return;
    const prev = lobbies.get(target.xuid);
    lobbies.set(target.xuid, {
      code,
      name: text(m.name, 32) || 'Player',
      // the leader's face: a tiny PNG, or nothing
      face: typeof m.face === 'string' && m.face.length < 4000 && m.face.startsWith('data:image/png;base64,') ? m.face : '',
      count: num(m.count, 1, 5, 1),
      capacity: num(m.capacity, 1, 5, 5),
      edition: m.edition === 'bedrock' ? 'bedrock' : 'java',
      installName: text(m.installName, 60),
      server: text(m.server, 256),
      seen: Date.now(),
    });
    if (!prev || prev.code !== code) {
      const item = list().find((x) => x.xuid === target.xuid);
      if (item) emit('opened', item);
    }
    if (!prev || prev.code !== code || prev.count !== lobbies.get(target.xuid).count) changed();
  } else if (m.t === 'closed') {
    if (lobbies.delete(target.xuid)) changed();
  }
}

async function openLink(gen, link) {
  if (gen !== generation) return false;
  const clients = [];
  const winner = await new Promise((resolve) => {
    let left = link.urls.length;
    for (const url of link.urls) {
      const client = new MqttClient(url, {
        onMessage,
        onClose: () => {
          if (gen !== generation || link.client !== client) return;
          link.up = false;
          scheduleLink(gen, link);
        },
      });
      clients.push(client);
      client.connect(RELAY_TIMEOUT_MS).then(
        () => resolve(client),
        () => --left === 0 && resolve(null),
      );
    }
  });
  for (const c of clients) if (c !== winner) c.close();
  if (!winner) return false;
  if (gen !== generation) {
    winner.close();
    return false;
  }
  for (const s of topics.values()) winner.subscribe(s.topic);
  if (mine) winner.subscribe(mine.topic);
  for (const topic of extra.keys()) winner.subscribe(topic);
  link.client = winner;
  link.up = true;
  link.delay = 3000;
  // once the subscriptions settle: who's open, and that we are
  setTimeout(() => {
    if (gen !== generation) return;
    for (const s of topics.values()) publish(s, { t: 'ask' });
    if (mine) beacon(true);
    emit('relayUp');
  }, 600);
  return true;
}

function scheduleLink(gen, link) {
  clearTimeout(link.retry);
  link.retry = setTimeout(async () => {
    if (gen !== generation) return;
    if (!(await openLink(gen, link))) {
      link.delay = Math.min(60000, (link.delay || 3000) * 2);
      scheduleLink(gen, link);
    }
  }, link.delay || 3000);
}

function start() {
  clearTimeout(stopTimer);
  stopTimer = null;
  if (running) return;
  running = true;
  const gen = ++generation;
  links = party.relayGroups().map((urls) => ({ urls, up: false, client: null, delay: 3000 }));
  for (const l of links) openLink(gen, l).then((ok) => ok || scheduleLink(gen, l));
  sweepTimer = setInterval(sweep, 10000);
}

function stop() {
  if (!running) return;
  running = false;
  generation++;
  for (const l of links) {
    clearTimeout(l.retry);
    if (l.client) l.client.close();
  }
  links = [];
  clearInterval(sweepTimer);
  if (lobbies.size) {
    lobbies.clear();
    changed();
  }
}

// a lobby whose leader stopped beating (its launcher closed or lost the net)
function sweep() {
  let gone = false;
  for (const [xuid, l] of lobbies) {
    if (Date.now() - l.seen > STALE_MS) {
      lobbies.delete(xuid);
      gone = true;
    }
  }
  if (gone) changed();
}

// ---- our own lobby --------------------------------------------------------------------------

function beaconBody() {
  const p = party.state();
  const self = p.members.find((m) => m.self);
  const plan = p.plan || {};
  return {
    t: 'open',
    code: p.code,
    name: self ? self.name : '',
    face: self && self.skin ? require('./notify-icons').faceOf(self.skin) : '',
    count: p.members.length,
    capacity: p.capacity,
    edition: plan.edition || (self && self.edition) || 'java',
    installName: plan.installName || '',
    server: plan.server || '',
  };
}

// Questions come in bursts (each through every relay, several friends at
// once): one answer covers them all, none is dropped.
function answer() {
  if (answerTimer) return;
  answerTimer = setTimeout(() => {
    answerTimer = null;
    lastAnswer = Date.now();
    beacon(true);
  }, Math.max(0, lastAnswer + ASK_GAP_MS - Date.now()));
}

function beacon(force) {
  if (!mine) return;
  const body = beaconBody();
  const key = JSON.stringify(body);
  if (!force && key === lastBeacon) return;
  lastBeacon = key;
  publish(mine, body);
}

// ---- keeping up with friends, the party and the setting ---------------------------------------

function sync() {
  const fs = friends.getState();
  const myXuid = fs.me && XUID_RE.test(String(fs.me.xuid || '')) ? String(fs.me.xuid) : '';
  const p = party.state();
  const lead = !!(myXuid && p.active && p.leader && config.get().partyFriends !== false);

  // our beacon: on while we lead, "closed" once when that ends
  const nextMine = lead ? secretsFor(myXuid) : null;
  if (mine && (!nextMine || nextMine.topic !== mine.topic)) {
    publish(mine, { t: 'closed' });
    const old = mine.topic;
    eachClient((c) => c.unsubscribe(old));
    mine = null;
    lastBeacon = '';
    clearInterval(beaconTimer);
    log.info('Friend lobby: closed to friends.');
  }
  if (nextMine && !mine) {
    mine = nextMine;
    eachClient((c) => c.subscribe(mine.topic));
    clearInterval(beaconTimer);
    beaconTimer = setInterval(() => beacon(true), BEACON_MS);
    log.info('Friend lobby: open to Xbox friends.');
  }
  if (mine) beacon(false);

  // friends' topics
  const want = new Map();
  for (const f of fs.friends) {
    const x = String(f.xuid || '');
    if (XUID_RE.test(x) && x !== myXuid) {
      const s = secretsFor(x);
      want.set(s.topic, s);
    }
  }
  for (const [topic, s] of topics) {
    if (want.has(topic)) continue;
    topics.delete(topic);
    eachClient((c) => c.unsubscribe(topic));
    if (lobbies.delete(s.xuid)) changed();
  }
  const added = [];
  for (const [topic, s] of want) {
    if (topics.has(topic)) continue;
    topics.set(topic, s);
    added.push(s);
  }
  if (added.length) {
    eachClient((c) => added.forEach((s) => c.subscribe(s.topic)));
    setTimeout(() => added.forEach((s) => topics.has(s.topic) && publish(s, { t: 'ask' })), 600);
  }

  need();
  changed();
}

// the relays: only while there's someone to listen to, a lobby to show or an
// inbox to keep; a moment's grace so a last "closed" gets out
function need() {
  if (topics.size || mine || extra.size) start();
  else if (running && !stopTimer) stopTimer = setTimeout(stop, 3000);
}

function watch(topic, fn) {
  const fresh = !extra.has(topic);
  extra.set(topic, fn);
  if (fresh) eachClient((c) => c.subscribe(topic));
  need();
}

function unwatch(topic) {
  if (!extra.delete(topic)) return;
  eachClient((c) => c.unsubscribe(topic));
  need();
}

// a ready packet onto every line that's up; false when none is
function post(topic, packet) {
  let sent = false;
  for (const l of links) {
    if (!l.up) continue;
    try {
      l.client.publish(topic, packet);
      sent = true;
    } catch {
      /* that line dropped; its reconnect is on the way */
    }
  }
  return sent;
}

function join(xuid, me) {
  const l = lobbies.get(String(xuid || ''));
  if (!l) throw new Error('Лобби друга уже закрыто.');
  return party.join(l.code, me);
}

let started = false;
function init() {
  if (started) return;
  started = true;
  friends.onChange(sync);
  party.onEvent((type) => type === 'changed' && sync());
  config.onChange(sync);
  sync();
}

module.exports = {
  init,
  list,
  join,
  watch,
  unwatch,
  post,
  isUp: () => links.some((l) => l.up),
  onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
