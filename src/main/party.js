'use strict';
// Parties: friends' launchers in one room, so the leader's "Play" starts
// everyone on the same server, in the same version.
//
// No server of our own: launchers meet on a public MQTT relay. The party
// code is the only secret — the topic is a hash of it and every message is
// AES-256-GCM sealed with a key derived from it, so the relay only ever
// sees noise between strangers.

const crypto = require('crypto');
const { MqttClient } = require('./mqtt');
const config = require('./config');
const { textureUrl } = require('./texture-size');
const log = require('./log');

// Separate public relays: EMQX's worldwide cluster, its Chinese cluster (a
// different network path — reachable where the first one is filtered) and
// HiveMQ. Each is tried by its URLs in order; a party uses every one it gets.
// Every way in is tried at once (WebSocket, TLS, plain TCP); the first to
// answer is kept.
const RELAY_GROUPS = [
  // ours first (relay-server.js), the public ones behind it
  require('./relay-server').MQTT_URLS,
  ['wss://broker.emqx.io:8084/mqtt', 'ws://broker.emqx.io:8083/mqtt', 'mqtts://broker.emqx.io:8883', 'mqtt://broker.emqx.io:1883'],
  ['wss://broker-cn.emqx.io:8084/mqtt', 'ws://broker-cn.emqx.io:8083/mqtt', 'mqtts://broker-cn.emqx.io:8883', 'mqtt://broker-cn.emqx.io:1883'],
  ['wss://broker.hivemq.com:8884/mqtt', 'ws://broker.hivemq.com:8000/mqtt', 'mqtts://broker.hivemq.com:8883', 'mqtt://broker.hivemq.com:1883'],
  ['wss://test.mosquitto.org:8081/mqtt', 'mqtts://test.mosquitto.org:8886', 'mqtt://test.mosquitto.org:1883'],
  ['wss://public:public@public.cloud.shiftr.io', 'mqtts://public:public@public.cloud.shiftr.io:8883'],
];
const RELAY_TIMEOUT_MS = 20000;
const SEEN_KEEP = 4000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HEARTBEAT_MS = 8000;
const GONE_MS = 26000;
const CHAT_KEEP = 120;
const CAPACITY = 5;
const STICKER = /^[a-z0-9_]{1,24}$/;
// Waiting for the leader after joining: knock this often, give up after.
const KNOCK_MS = 2500;
const NOT_FOUND_MS = 45000;
// A skin goes out as a separate card, only when it changes or someone asks
// for it — never with every heartbeat (a heartbeat used to carry up to 40 KB,
// enough for filtered networks to freeze a relay connection within seconds).
const CARD_GAP_MS = 2500;
const ASK_GAP_MS = 5000;
const cardKey = (skin, cape, model) => crypto.createHash('sha256').update(`${skin || ''}|${cape || ''}|${model || ''}`).digest('hex').slice(0, 16);
const SK = /^[a-f0-9]{16}$/;
const cleanCos = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^[a-z0-9_]{1,32}$/.test(x)).slice(0, 4) : []);

let party = null;
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

function newCode() {
  const bytes = crypto.randomBytes(8);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

// "abcd-efgh", "ABCD EFGH" → "ABCDEFGH"; null if it can't be a code.
function normalize(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 && [...c].every((ch) => ALPHABET.includes(ch)) ? c : null;
}

const pretty = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

function secretsFor(code) {
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(code, 'utf8'), Buffer.from('mclauncher-party'), Buffer.from('key'), 32));
  const topic = `mcl/p/${crypto.createHash('sha256').update(`mclauncher-party-topic:${code}`).digest('hex').slice(0, 32)}`;
  return { key, topic };
}

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]);
}

function open(key, buf) {
  if (buf.length < 29) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8'));
  } catch {
    return null; // not ours, or tampered with
  }
}

// ---- state ------------------------------------------------------------------------------

function view() {
  if (!party) return { active: false };
  const now = Date.now();
  const members = [...party.members.values()]
    .filter((m) => (m.self || now - m.seen < GONE_MS) && (!party.approved || party.approved.has(m.id)))
    .map(({ id, name, skin, cape, model, edition, leader, self, voice, launchSync, cos }) => ({ id, name, skin, cape: cape || '', model, edition, leader, self, voice: voice || null, launchSync: !!launchSync, cos: cos || [] }));
  return {
    active: true,
    capacity: CAPACITY,
    code: pretty(party.code),
    leader: party.leader,
    connected: party.links.some((l) => l.up),
    reconnecting: !!party.connectionLost,
    reconnecting: !!party.connectionLost,
    relay: party.links.filter((l) => l.up).map((l) => l.url).join(', '),
    members,
    plan: party.plan,
    waiting: party.waiting,
    // the ready check: who has the game on their PC for the leader's plan
    prep: party.prep ? { round: party.prep.round, states: Object.fromEntries(party.prep.states) } : null,
    // the leader's world is open to the party (the tunnel can connect)
    lan: !!party.lan,
    destination: party.destination || null,
  };
}

const changed = () => {
  const state = view();
  if (party) {
    const reachable = state.connected && (party.leader || state.members.some(m => m.id === party.leaderId));
    if (reachable) {
      if (party.connectionLost) emit('connection', { connected: true });
      party.everConnected = true;
      party.connectionLost = false;
    } else if (party.everConnected && !party.connectionLost) {
      party.connectionLost = true;
      emit('connection', { connected: false });
    }
    state.reconnecting = !!party.connectionLost;
  }
  emit('changed', state);
};

// Sealed once, published on every relay we're on; `n` lets the others drop
// the copies that arrive through the other relays.
function send(msg) {
  if (!party) return;
  const up = party.links.filter((l) => l.up);
  if (!up.length) return;
  const packet = seal(party.key, { ...msg, id: party.selfId, at: Date.now(), n: crypto.randomBytes(6).toString('base64') });
  for (const l of up) {
    try {
      l.client.publish(party.topic, packet);
    } catch {
      /* that line dropped; its reconnect is on the way */
    }
  }
}

// Our card — skin, cape, model — at most once per CARD_GAP_MS.
function sendCard() {
  if (!party) return;
  const wait = (party.cardAt || 0) + CARD_GAP_MS - Date.now();
  if (wait > 0) {
    const mine = party;
    if (!party.cardTimer) party.cardTimer = setTimeout(() => { mine.cardTimer = null; if (party === mine) sendCard(); }, wait);
    return;
  }
  party.cardAt = Date.now();
  const me = party.members.get(party.selfId);
  send({ t: 'card', sk: me.sk, skin: me.skin, cape: me.cape || '', model: me.model });
}

// A member's card we don't have (or an old one): ask them for it.
function askCard(member) {
  if (!party || !member || member.self || !member.sk || member.cardSk === member.sk) return;
  if (Date.now() - (member.askedAt || 0) < ASK_GAP_MS) return;
  member.askedAt = Date.now();
  send({ t: 'card?', to: member.id });
}

function hello() {
  if (!party) return;
  const me = party.members.get(party.selfId);
  send({ t: 'hi', v: 2, name: me.name, sk: me.sk, model: me.model, edition: me.edition, leader: party.leader, voice: me.voice || null, xuid: me.xuid || '', launchSync: true, cos: me.cos || [] });
  if (!party.cardAt) sendCard();
  roster();
  if (party.leader && party.plan) send({ t: 'plan', plan: party.plan });
  if (party.leader && party.lan) send({ t: 'lan', open: true });
  if (party.leader && party.followRevision) send({ t: 'follow', revision: party.followRevision, destination: party.destination || null });
  if (party.leader && party.prep) {
    for (const member of view().members) {
      if (!member.self && member.launchSync && !party.prep.states.has(member.id))
        send({ t: 'prep', to: member.id, round: party.prep.round, plan: party.prep.plan });
    }
  }
  if (!party.leader && party.prep) {
    const ready = party.prep.states.get(party.selfId);
    if (ready) send({ t: 'ready', round: party.prep.round, ...ready });
  }
  if (party.leader && party.started) {
    for (const id of party.started.pending) {
      if (!party.members.has(id)) { party.started.pending.delete(id); continue; }
      send({ t: 'start', to: id, plan: party.started.plan, startId: party.started.id });
    }
  }
}

// The leader admits members serially. Its roster is authoritative even when
// several launchers join at once; peers never reserve independent slots.
// Cards (skins) stay out of the roster: members ask for the ones they lack.
function roster() {
  if (!party?.leader) return;
  for (const [id, m] of party.members) if (!m.self && Date.now() - m.seen >= GONE_MS) party.members.delete(id);
  send({ t: 'roster', members: view().members.map(({ skin, cape, ...m }) => ({ ...m, sk: party.members.get(m.id)?.sk || '' })) });
}

// Which relays we last heard each member on (link key → ms).
function heard(id, link) {
  if (!link) return;
  let on = party.via.get(id);
  if (!on) party.via.set(id, (on = new Map()));
  on.set(link.key, Date.now());
}

function heardOn(id) {
  const now = Date.now();
  const on = party.via.get(id);
  return on ? [...on].filter(([, at]) => now - at < GONE_MS).map(([key]) => key) : [];
}

// The leader is the lobby's hub: two members whose networks reach no common
// relay still hear each other — a packet goes on, unchanged (still sealed),
// to every relay where someone it's for is and its sender isn't.
function bridge(payload, m, from) {
  const senderOn = new Set(heardOn(m.id));
  const targets = m.to ? [m.to] : [...party.members.keys()].filter((id) => id !== m.id && id !== party.selfId);
  const reach = targets.map(heardOn);
  for (const l of party.links) {
    if (!l.up || l === from || senderOn.has(l.key) || !reach.some((on) => on.includes(l.key))) continue;
    try {
      l.client.publish(party.topic, payload);
    } catch {
      /* that line dropped; its reconnect is on the way */
    }
  }
}

function onMessage(topic, payload, link) {
  if (!party || topic !== party.topic) return;
  const m = open(party.key, payload);
  if (!m || !m.id || m.id === party.selfId) return;
  heard(m.id, link);
  // the same message through another relay
  if (m.n) {
    const key = `${m.id}:${m.n}`;
    if (party.seen.has(key)) return;
    party.seen.add(key);
    if (party.seen.size > SEEN_KEEP) party.seen.delete(party.seen.values().next().value);
  }
  if (party.leader && link && m.to !== party.selfId) bridge(payload, m, link);
  if (m.to && m.to !== party.selfId) return;
  const known = party.members.get(m.id);
  if (m.t === 'full' && m.to === party.selfId && m.id === party.leaderId) {
    emit('ended', {reason:'full'});
    leave({quiet:true});
    return;
  }
  if (m.t === 'kick' && m.to === party.selfId && m.id === party.leaderId) {
    emit('ended', { reason: 'kicked' });
    leave({ quiet: true });
    return;
  }
  if (m.t === 'roster' && !party.leader && m.id === party.leaderId && Array.isArray(m.members)) {
    const cards = m.members.filter(x => x && typeof x.id === 'string').slice(0, CAPACITY);
    if (new Set(cards.map(x => x.id)).size !== cards.length || !cards.some(x => x.id === party.leaderId)) return;
    party.approved = new Set(cards.map(x => x.id));
    if (!party.approved.has(party.selfId)) return;
    const self = party.members.get(party.selfId);
    const before = party.members;
    party.members = new Map(cards.filter(x => typeof x.id === 'string').map(x => {
      if (x.id === party.selfId) return [x.id, self];
      const prev = before.get(x.id);
      // an older leader still sends the skins; a current one only their keys
      const legacy = typeof x.skin === 'string';
      const sk = SK.test(x.sk || '') ? x.sk : '';
      return [x.id, {
        id:x.id, name:String(x.name || 'Player').slice(0,32),
        skin:legacy ? textureUrl(x.skin, 'skin', 40000) : prev?.skin || '',
        cape:legacy ? textureUrl(x.cape, 'cape', 40000) : prev?.cape || '',
        model:x.model === 'slim' ? 'slim' : 'classic', edition:x.edition === 'bedrock' ? 'bedrock' : 'java',
        leader:x.id === party.leaderId, self:false, voice:cleanVoice(x.voice), seen:Date.now(),
        launchSync: !!x.launchSync,
        sk: legacy ? '' : sk, cardSk: legacy ? '' : prev?.cardSk || '', askedAt: prev?.askedAt || 0, cos: cleanCos(x.cos),
        xuid: prev?.xuid || '',
        chatTimes:prev?.chatTimes || []
      }];
    }));
    for (const member of party.members.values()) askCard(member);
    if (party.waiting) {
      party.waiting = false;
      clearInterval(party.knock);
      sendCard(); // the others learn our skin without asking
    }
    changed();
    return;
  }
  if (m.t === 'card' && known) {
    const sk = SK.test(m.sk || '') ? m.sk : '';
    known.skin = textureUrl(m.skin, 'skin', 40000);
    known.cape = textureUrl(m.cape, 'cape', 40000);
    if (m.model === 'slim' || m.model === 'classic') known.model = m.model;
    known.sk = known.cardSk = sk;
    known.seen = Date.now();
    changed();
    return;
  }
  if (m.t === 'card?' && m.to === party.selfId && known) {
    sendCard();
    return;
  }
  if (m.t === 'hi') {
    if (party.leader) {
      const xuid = typeof m.xuid === 'string' && /^\d{1,20}$/.test(m.xuid) ? m.xuid : '';
      if (party.kicked.ids.has(m.id) || (xuid && party.kicked.xuids.has(xuid))) {
        party.kicked.ids.add(m.id);
        hello(); // a newcomer only takes a kick from the leader it knows
        send({ t: 'kick', to: m.id });
        return;
      }
      for (const [id, member] of party.members) if (!member.self && Date.now() - member.seen >= GONE_MS) party.members.delete(id);
      if (!party.members.has(m.id) && party.members.size >= CAPACITY) {
        hello(); // identifies the leader before the targeted rejection
        send({t:'full', to:m.id});
        return;
      }
    } else {
      if (m.leader && (!party.leaderId || party.leaderId === m.id)) party.leaderId = m.id;
      if (m.id !== party.leaderId && !party.approved?.has(m.id)) return;
    }
    const fresh = !known;
    // older launchers put the skin in every hello; current ones send its key
    const legacy = typeof m.skin === 'string';
    const sk = SK.test(m.sk || '') ? m.sk : '';
    const member = {
      id: m.id,
      name: String(m.name || 'Player').slice(0, 32),
      skin: legacy ? textureUrl(m.skin, 'skin', 40000) : known?.skin || '',
      cape: legacy ? textureUrl(m.cape, 'cape', 40000) : known?.cape || '',
      model: m.model === 'slim' ? 'slim' : 'classic',
      edition: m.edition === 'bedrock' ? 'bedrock' : 'java',
      leader: !!m.leader,
      launchSync: !!m.launchSync,
      xuid: typeof m.xuid === 'string' && /^\d{1,20}$/.test(m.xuid) ? m.xuid : '',
      voice: cleanVoice(m.voice),
      sk: legacy ? '' : sk,
      cos: cleanCos(m.cos),
      cardSk: legacy ? '' : known?.cardSk || '',
      askedAt: known?.askedAt || 0,
      chatTimes: known?.chatTimes || [],
      seen: Date.now(),
    };
    party.members.set(m.id, member);
    askCard(member);
    if (party.leader) hello();
    // a newcomer gets our hello and card straight away instead of on the next beat
    if (fresh) setTimeout(() => {
      hello();
      if (party) party.cardAt = 0;
      sendCard();
    }, 300);
    changed();
  } else if (m.t === 'bye') {
    if (known && known.leader && !party.leader) {
      emit('ended', { reason: 'leader' });
      leave({ quiet: true });
      return;
    }
    party.members.delete(m.id);
    party.via.delete(m.id);
    roster();
    changed();
  } else if (m.t === 'chat' && known) {
    if (!allow(known)) return;
    const entry = chatEntry(known, m.text, m.sticker, false);
    if (entry) {
      party.chat.push(entry);
      if (party.chat.length > CHAT_KEEP) party.chat.splice(0, party.chat.length - CHAT_KEEP);
      emit('chat', entry);
    }
  } else if (m.t === 'au' && known && known.voice && known.voice.on) {
    // relayed voice: Opus frames, base64; a burst limit per member
    const now = Date.now();
    known.auTimes = (known.auTimes || []).filter((t) => now - t < 2000);
    if (known.auTimes.length >= 60) return;
    known.auTimes.push(now);
    const f = Array.isArray(m.f) ? m.f.filter((x) => typeof x === 'string' && x.length <= 800).slice(0, 10) : [];
    if (f.length && Number.isFinite(m.s)) emit('audio', { from: m.id, s: m.s, f });
  } else if (m.t === 'emote' && known && typeof m.e === 'string' && /^[a-z0-9_]{1,24}$/.test(m.e)) {
    if (!allow(known)) return;
    emit('emote', { from: m.id, id: m.e });
  } else if (m.t === 'vs' && known) {
    known.voice = cleanVoice(m.voice);
    known.seen = Date.now();
    changed();
  } else if (m.t === 'world' && known && m.to === party.selfId &&
      (party.leader || m.id === party.leaderId) && (!party.approved || party.approved.has(m.id))) {
    if (validWorldFrame(m.frame)) emit('world', { from: m.id, frame: m.frame });
  } else if (m.t === 'rtc' && known && m.to === party.selfId && SIGNALS.includes(m.kind)) {
    // WebRTC offers/answers for the renderer: the voice call, and t* for the
    // tunnel into the leader's world
    const sdp = typeof m.sdp === 'string' && m.sdp.length < 24000 ? m.sdp : '';
    if (!/bye$/.test(m.kind) && !sdp) return;
    emit('signal', { from: m.id, kind: m.kind, sdp });
  } else if (m.t === 'follow' && known && m.id === party.leaderId && !party.leader) {
    const revision = Number(m.revision);
    if (!Number.isSafeInteger(revision) || revision <= (party.followRevision || 0)) return;
    const plan = m.destination ? sanitizePlan(m.destination.plan) : null;
    if (m.destination && (!plan || !['world', 'server'].includes(plan.mode))) return;
    party.followRevision = revision;
    party.destination = plan ? { id: String(revision), plan } : null;
    changed();
    emit('follow', party.destination);
  } else if (m.t === 'started' && known && party.leader && party.started && m.startId === party.started.id) {
    party.started.pending.delete(m.id);
  } else if ((m.t === 'plan' || m.t === 'start') && known && known.leader && !party.leader) {
    if (m.t === 'start' && m.startId) {
      send({ t: 'started', to: m.id, startId: m.startId });
      if (party.lastStart === m.startId) return;
      party.lastStart = m.startId;
    }
    party.plan = sanitizePlan(m.plan);
    if (m.t === 'start') party.prep = null;
    changed();
    if (m.t === 'start' && party.plan) emit('start', { plan: party.plan, leader: known.name });
  } else if (m.t === 'prep' && known && known.leader && !party.leader) {
    // the leader pressed Play: get the game ready, say how it's going
    if (m.cancel) {
      party.prep = null;
      changed();
      emit('prepCancel', {});
      return;
    }
    party.plan = sanitizePlan(m.plan);
    const round = Number(m.round) || 0;
    if (round <= (party.lastPrepRound || 0)) return;
    party.lastPrepRound = round;
    party.prep = { round, states: new Map(), since: Date.now() };
    changed();
    if (party.plan) emit('prep', { plan: party.plan, round, leader: known.name });
  } else if (m.t === 'ready' && known && party.prep && Number(m.round) === party.prep.round) {
    const state = ['ready', 'busy', 'error'].includes(m.state) ? m.state : 'busy';
    party.prep.states.set(m.id, { state, progress: Math.max(0, Math.min(1, Number(m.progress) || 0)) });
    changed();
    checkReady();
  } else if (m.t === 'lan' && known && known.leader && !party.leader) {
    party.lan = !!m.open;
    changed();
    emit('lan', { open: party.lan, leaderId: m.id });
  }
}

const SIGNALS = ['offer', 'answer', 'bye', 'toffer', 'tanswer', 'tbye'];
// A member that never answers the ready check runs an older launcher: it
// still follows the start, so after a while it counts as ready.
const LEGACY_MS = 10000;

function checkReady() {
  if (!party || !party.leader || !party.prep || party.prep.done) return;
  const members = view().members;
  const old = Date.now() - party.prep.since > LEGACY_MS;
  const all = members.every((mb) => {
    const st = party.prep.states.get(mb.id);
    return (st && st.state === 'ready') || (!st && old);
  });
  if (all) {
    party.prep.done = true;
    emit('allReady', { round: party.prep.round, plan: party.prep.plan });
  }
}

// ---- the ready check ----

// The leader: everyone (the leader too) gets the plan's game ready; the
// start goes out once all say "ready" (allReady).
function prepare(plan) {
  if (!party || !party.leader) throw new Error('Запускать пати может только лидер.');
  party.plan = sanitizePlan(plan);
  const round = (party.round = (party.round || 0) + 1);
  party.started = null;
  party.prep = { round, plan: party.plan, states: new Map(), since: Date.now() };
  send({ t: 'prep', plan: party.plan, round });
  changed();
  clearInterval(party.prepTimer);
  const mine = party;
  party.prepTimer = setInterval(() => {
    if (party !== mine || !party.prep || party.prep.done) return clearInterval(mine.prepTimer);
    checkReady();
  }, 1000);
  return { round, plan: party.plan };
}

function cancelPrepare() {
  if (!party || !party.leader || !party.prep) return view();
  party.prep = null;
  clearInterval(party.prepTimer);
  send({ t: 'prep', cancel: true });
  changed();
  return view();
}

// Anyone: how our side of the ready check is going.
function reportReady(round, state, progress = 0) {
  if (!party || !party.prep || party.prep.round !== round) return;
  party.prep.states.set(party.selfId, { state, progress });
  send({ t: 'ready', round, state, progress: Math.round(progress * 100) / 100 });
  changed();
  checkReady();
}

// The leader's world opened to the party (or closed).
function setLan(open) {
  if (!party || !party.leader) return;
  if (!!party.lan === !!open) return;
  party.lan = !!open;
  send({ t: 'lan', open: !!open });
  changed();
}

function cleanVoice(v) {
  if (!v || typeof v !== 'object' || !v.on) return null;
  return { on: true, mic: !!v.mic, deaf: !!v.deaf };
}

// Text without control characters, at most 500 of them; or a sticker id.
function chatEntry(member, text, sticker, self) {
  const t = String(text == null ? '' : text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 500);
  const s = typeof sticker === 'string' && STICKER.test(sticker) ? sticker : '';
  if (!t && !s) return null;
  return { id: crypto.randomBytes(6).toString('hex'), from: member.id, name: member.name, text: t, sticker: s, at: Date.now(), self };
}

// No more than 6 messages per 5 seconds from one member.
function allow(member) {
  const now = Date.now();
  member.chatTimes = (member.chatTimes || []).filter((t) => now - t < 5000);
  if (member.chatTimes.length >= 6) return false;
  member.chatTimes.push(now);
  return true;
}

function sanitizePlan(p) {
  if (!p || typeof p !== 'object') return null;
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  return {
    edition: p.edition === 'bedrock' ? 'bedrock' : 'java',
    installName: s(p.installName, 60),
    mcVersion: s(p.mcVersion, 64),
    loader: ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'bedrock'].includes(p.loader) ? p.loader : 'vanilla',
    loaderVersion: s(p.loaderVersion, 64),
    server: s(p.server, 256).trim(),
    // 'world': the leader plays a world of their own, the others come in
    // through the launcher's tunnel; 'server': everyone onto that address
    mode: p.mode === 'world' ? 'world' : s(p.server, 256).trim() ? 'server' : 'none',
    world: p.mode === 'world' ? s(p.world, 128) : '',
    worldName: p.mode === 'world' ? s(p.worldName, 60) : '',
    follow: !!p.follow,
  };
}

// ---- connection -------------------------------------------------------------------------

function relayGroups() {
  const custom = String(config.get().partyRelay || '').trim();
  return custom ? [[custom]] : RELAY_GROUPS;
}

// Settings → "Check": which relays this network reaches, and how fast.
// Two launchers find each other only through a relay both of them reach
// (or through a leader that reaches both).
async function probeRelays(timeout = 9000) {
  const groups = relayGroups();
  return Promise.all(groups.map(async (urls) => {
    const started = Date.now();
    const clients = urls.map((url) => new MqttClient(url, {}));
    try {
      const url = await Promise.any(clients.map((c, i) => c.connect(timeout).then(() => urls[i])));
      return { key: linkKey(urls), ok: true, url: url.replace(/\/\/[^@/]*@/, '//'), ms: Date.now() - started };
    } catch {
      return { key: linkKey(urls), ok: false, url: '', ms: Date.now() - started };
    } finally {
      for (const c of clients) c.close();
    }
  }));
}

// What about this network makes direct connections unlikely: a VPN in TUN
// mode (routes everything, often TCP 443 only) or a phone's hotspot (the
// operator's NAT — nobody can connect in). Only yes/no, no names.
function networkHints() {
  const hints = { vpn: false, hotspot: false };
  for (const [name, addrs] of Object.entries(require('os').networkInterfaces())) {
    const live = (addrs || []).some((a) => !a.internal);
    if (live && /tun|wintun|wireguard|happ|amnezia|outline|clash|sing-?box|v2ray|xray|hiddify|nekobox|openvpn|tap-windows/i.test(name)) hints.vpn = true;
    if ((addrs || []).some((a) => a.family === 'IPv4' && /^172\.20\.10\.\d+$/.test(a.address))) hints.hotspot = true;
  }
  return hints;
}

function linkKey(urls) {
  try {
    return new URL(urls[0]).hostname;
  } catch {
    return String(urls[0]);
  }
}

// One line to one relay: all its ways in race, the first to answer stays
// (the rest are closed); when it drops, it comes back on its own with a
// growing pause.
async function openLink(mine, link) {
  if (party !== mine || link.closed) return false;
  const clients = [];
  const winner = await new Promise((resolve) => {
    let left = link.urls.length;
    for (const url of link.urls) {
      const client = new MqttClient(url, {
        onMessage: (topic, payload) => onMessage(topic, payload, link),
        onClose: () => {
          if (party !== mine || link.client !== client || link.closed) return;
          link.up = false;
          changed();
          log.warn(`Party: relay ${url} lost, reconnecting…`);
          scheduleLink(mine, link);
        },
      });
      clients.push(client);
      client.connect(RELAY_TIMEOUT_MS).then(
        () => resolve({ client, url }),
        () => --left === 0 && resolve(null),
      );
    }
  });
  for (const c of clients) if (!winner || c !== winner.client) c.close();
  if (!winner) {
    log.warn(`Party relay ${new URL(link.urls[0]).hostname}: no answer`);
    return false;
  }
  if (party !== mine || link.closed) {
    winner.client.close();
    return false;
  }
  winner.client.subscribe(party.topic);
  link.client = winner.client;
  link.url = winner.url;
  link.up = true;
  link.delay = 3000;
  changed();
  return true;
}

function scheduleLink(mine, link) {
  clearTimeout(link.retry);
  link.retry = setTimeout(async () => {
    if (party !== mine || link.closed) return;
    if (await openLink(mine, link)) setTimeout(hello, 400);
    else {
      link.delay = Math.min(30000, (link.delay || 3000) * 2);
      scheduleLink(mine, link);
    }
  }, link.delay || 3000);
}

async function begin(code, me, leader) {
  leave({ quiet: true });
  const { key, topic } = secretsFor(code);
  const selfId = crypto.randomBytes(8).toString('hex');
  party = {
    code,
    key,
    topic,
    selfId,
    leader,
    connected: false,
    waiting: !leader,
    leaderId: leader ? selfId : null,
    approved: leader ? null : new Set([selfId]),
    kicked: { ids: new Set(), xuids: new Set() },
    plan: null,
    chat: [],
    links: [],
    seen: new Set(),
    via: new Map(),
    cardAt: 0,
    members: new Map([[selfId, { id: selfId, name: String(me.name || 'Player').slice(0, 32), skin: me.skin || '', cape: me.cape || '', cos: cleanCos(me.cos), model: me.model === 'slim' ? 'slim' : 'classic', edition: me.edition === 'bedrock' ? 'bedrock' : 'java', xuid: /^\d{1,20}$/.test(String(me.xuid || '')) ? String(me.xuid) : '', leader, self: true, seen: Date.now() }]]),
  };
  const self = party.members.get(selfId);
  self.sk = cardKey(self.skin, self.cape, self.model);
  changed();
  const mine = party;
  // every relay at once; the party is on as soon as one answers, the rest
  // join in (or keep trying) in the background
  party.links = relayGroups().map((urls) => ({ urls, key: linkKey(urls), up: false, client: null, url: '' }));
  const tries = party.links.map((link) => openLink(mine, link).then((ok) => {
    if (!ok) scheduleLink(mine, link);
    // a relay that answers late: the others there learn about us now
    else if (mine.beat) setTimeout(hello, 400);
    return ok;
  }));
  const first = await new Promise((resolve) => {
    let left = tries.length;
    for (const t of tries) t.then((ok) => (ok ? resolve(true) : --left === 0 && resolve(false)));
  });
  if (party !== mine) return view();
  if (!first) {
    for (const l of mine.links) {
      l.closed = true;
      clearTimeout(l.retry);
    }
    party = null;
    changed();
    throw new Error('Не удалось подключиться к ретрансляторам лобби. Проверьте интернет и адрес ретранслятора в настройках.');
  }
  // the subscription settles before the first hello goes out
  setTimeout(hello, 500);
  party.beat = setInterval(() => {
    hello();
    changed(); // drops members who stopped beating
  }, HEARTBEAT_MS);
  log.info(`Party ${leader ? 'created' : 'joined'} (${party.links.filter((l) => l.up).map((l) => l.url).join(', ')}).`);
  changed();
  return view();
}

function create(me) {
  return begin(newCode(), me || {}, true);
}

async function join(code, me) {
  const c = normalize(code);
  if (!c) throw new Error('Код пати — 8 букв и цифр, например ABCD-EF23.');
  const v = await begin(c, me || {}, false);
  // Knock until the leader answers: hellos are fire-and-forget, and the
  // leader's launcher may still be connecting to the relays we reached.
  const mine = party;
  mine.knock = setInterval(() => {
    if (party !== mine || !mine.waiting) return clearInterval(mine.knock);
    hello();
  }, KNOCK_MS);
  setTimeout(() => {
    if (party === mine && party.waiting) {
      emit('ended', { reason: 'notfound', relays: mine.links.filter((l) => l.up).map((l) => l.key) });
      leave({ quiet: true });
    }
  }, NOT_FOUND_MS);
  return v;
}

function leave({ quiet = false } = {}) {
  if (!party) return view();
  const p = party;
  if (!quiet || p.links.some((l) => l.up)) {
    try {
      send({ t: 'bye' });
    } catch {
      /* gone */
    }
  }
  clearInterval(p.beat);
  clearInterval(p.prepTimer);
  clearInterval(p.knock);
  clearTimeout(p.cardTimer);
  party = null;
  for (const l of p.links) {
    l.closed = true;
    clearTimeout(l.retry);
    setTimeout(() => l.client && l.client.close(), 300);
  }
  changed();
  return view();
}

function setPlan(plan) {
  if (!party || !party.leader) return view();
  party.plan = sanitizePlan(plan);
  send({ t: 'plan', plan: party.plan });
  changed();
  return view();
}

function start(plan) {
  if (!party || !party.leader) throw new Error('Запускать пати может только лидер.');
  party.plan = sanitizePlan(plan);
  party.prep = null;
  clearInterval(party.prepTimer);
  party.started = {
    id: crypto.randomBytes(8).toString('hex'), plan: party.plan,
    pending: new Set(view().members.filter(m => !m.self && m.launchSync).map(m => m.id)),
  };
  send({ t: 'start', plan: party.plan, startId: party.started.id });
  log.info(`Party start → ${party.plan.server || '(no server)'}.`);
  changed();
  return view();
}

// A confirmed in-game destination, replayed for late joins and after reconnects.
function follow(plan) {
  if (!party?.leader) return;
  const clean = plan ? sanitizePlan(plan) : null;
  if (clean && !['world', 'server'].includes(clean.mode)) return;
  party.followRevision = (party.followRevision || 0) + 1;
  party.destination = clean ? { id: String(party.followRevision), plan: clean } : null;
  send({ t: 'follow', revision: party.followRevision, destination: party.destination });
  changed();
}

// The leader shows a member out: gone from the roster at once (the others
// drop them with it), told to leave, and turned away if they come back.
function kick(id) {
  if (!party || !party.leader) throw new Error('Исключать может только лидер.');
  const m = party.members.get(id);
  if (!m || m.self) return view();
  party.kicked.ids.add(id);
  if (m.xuid) party.kicked.xuids.add(m.xuid);
  party.members.delete(id);
  party.via.delete(id);
  send({ t: 'kick', to: id });
  roster();
  log.info(`Party: ${m.name} kicked.`);
  changed();
  return view();
}

function say({ text = '', sticker = '' } = {}) {
  if (!party) throw new Error('Вы не в пати.');
  const me = party.members.get(party.selfId);
  if (!allow(me)) throw new Error('Не так быстро.');
  const entry = chatEntry(me, text, sticker, true);
  if (!entry) return null;
  send({ t: 'chat', text: entry.text, sticker: entry.sticker });
  party.chat.push(entry);
  if (party.chat.length > CHAT_KEEP) party.chat.splice(0, party.chat.length - CHAT_KEEP);
  emit('chat', entry);
  return entry;
}

function chatLog() {
  return party ? party.chat.slice() : [];
}

function audio(pkt) {
  if (!party || !pkt || !Array.isArray(pkt.f) || !Number.isFinite(pkt.s)) return false;
  const f = pkt.f.filter((x) => typeof x === 'string' && x.length <= 800).slice(0, 10);
  if (f.length) send({ t: 'au', s: pkt.s, f });
  return true;
}

function emote(id) {
  if (!party || !/^[a-z0-9_]{1,24}$/.test(String(id))) return false;
  send({ t: 'emote', e: id });
  return true;
}

// A new skin (or name) for ourselves: everyone gets the new card.
function updateMe(me) {
  if (!party) return view();
  const self = party.members.get(party.selfId);
  if (me && typeof me.skin === 'string' && (me.skin === '' || (me.skin.startsWith('data:image/png;base64,') && me.skin.length < 40000))) self.skin = me.skin;
  if (me && typeof me.cape === 'string' && (me.cape === '' || (me.cape.startsWith('data:image/png;base64,') && me.cape.length < 40000))) self.cape = me.cape;
  if (me && (me.model === 'slim' || me.model === 'classic')) self.model = me.model;
  if (me && Array.isArray(me.cos)) self.cos = cleanCos(me.cos);
  const sk = cardKey(self.skin, self.cape, self.model);
  if (sk !== self.sk) {
    self.sk = sk;
    party.cardAt = 0;
    sendCard();
  }
  hello();
  changed();
  return view();
}

function setVoice(v) {
  if (!party) return view();
  const me = party.members.get(party.selfId);
  me.voice = cleanVoice(v);
  send({ t: 'vs', voice: me.voice });
  changed();
  return view();
}

function signal(to, kind, sdp) {
  if (!party || !party.members.has(to) || !SIGNALS.includes(kind)) return false;
  send({ t: 'rtc', to, kind, sdp: /bye$/.test(kind) ? '' : String(sdp || '').slice(0, 24000) });
  return true;
}

function validWorldFrame(p) {
  return p && typeof p === 'object' && /^[a-f0-9]{24}$/.test(p.id || '') &&
    ['probe', 'ready', 'open', 'data', 'ack', 'fin', 'reset'].includes(p.kind) &&
    (p.data === undefined || (typeof p.data === 'string' && p.data.length <= 10924));
}

function world(to, frame) {
  if (!party || !party.members.has(to) || (party.approved && !party.approved.has(to)) ||
      (!party.leader && to !== party.leaderId) || !validWorldFrame(frame)) return false;
  send({ t: 'world', to, frame });
  return true;
}

module.exports = {
  create,
  prepare,
  cancelPrepare,
  reportReady,
  setLan,
  leaderId: () => (party ? party.leaderId : null),
  selfId: () => (party ? party.selfId : null),
  kick,
  seal,
  open,
  relayGroups,
  probeRelays,
  networkHints,
  say,
  chatLog,
  setVoice,
  signal,
  world,
  emote,
  updateMe,
  audio,
  join,
  leave,
  setPlan,
  start,
  follow,
  state: view,
  normalize,
  onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
