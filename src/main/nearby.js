'use strict';
// Nearby clients discover one another by the UUIDs actually loaded in the game.
// MQTT carries presence/cosmetics/SDP only. Audio uses encrypted WebRTC.
const crypto = require('crypto');
const { MqttClient } = require('./mqtt');
const config = require('./config');
const { textureUrl } = require('./texture-size');
const bedrock = require('./bedrock-telemetry');
const ID = /^[a-f0-9]{32}$/;
const PREFIX = 'mcl/nearby/v1/';
// ours first (TLS on 443 and plain; each link is a connection of its own), then the public ones
const BROKERS = [require('./relay-server').MQTT_URLS[0], require('./relay-server').MQTT_URLS[2], 'wss://public:public@public.cloud.shiftr.io', 'wss://broker.emqx.io:8084/mqtt', 'mqtts://broker.emqx.io:8883', 'mqtt://broker.emqx.io:1883', 'wss://broker.hivemq.com:8884/mqtt'];
const topic = id => PREFIX + crypto.createHash('sha256').update(id).digest('hex');
const listeners = new Set(), peers = new Map(), links = new Map();
let snapshot = null, sampledAt = 0, pid = 0, generation = 0, timer = null;
let voice = null, ownLook = {}, lastLook = 0, lastHello = 0;
// The skin rides along only when it changed, someone new appeared, or every
// 30 s — not with every 4-second hello (it can be hundreds of KB).
let lookKey = '', lookSentAt = 0, needLook = false;
let bridge = {status:'idle'};
let bedrockServer = ''; // Bedrock doesn't say where it is: the server the launcher started it on

function emit(type, payload) { for (const fn of listeners) fn(type, payload); }
function parse(line) {
  const m = /^(?:\[[^\]]+\] \[[^\]]+\/INFO\]: \[STDOUT\]: )?\[MC Launcher\] nearby\t([A-Za-z0-9+/=]*)$/.exec(line);
  if (!m || m[1].length > 24000) return undefined;
  const rows = Buffer.from(m[1], 'base64').toString('utf8').split('\n').map(s => s.split('\t'));
  const [id, name, water, enclosed, sx, sy, sz, server, kills] = rows.shift();
  if (!ID.test(id || '') || !/^[A-Za-z0-9_]{1,16}$/.test(name || '')) return null;
  const players = rows.slice(0, 64).filter(r => ID.test(r[0]) && r[0] !== id && /^[A-Za-z0-9_]{1,16}$/.test(r[1]) && r[2] !== '' && Number.isFinite(+r[2]) && +r[2] >= 0 && +r[2] <= 128 && Number.isFinite(+r[3]));
  // Newer agents add the place relative to our view (right, up, ahead), the
  // solid blocks between us, whether they're in water; and for us: water, a roof.
  const place = (r) => r.length >= 7 && r.slice(4, 7).every(v => v !== '' && Number.isFinite(+v) && Math.abs(+v) <= 130) ? r.slice(4, 7).map(Number) : null;
  // and, for the event quests: where we are, on which server, monsters beaten (-1: can't tell)
  const here = [sx, sy, sz].every(v => v !== undefined && v !== '' && Number.isFinite(+v) && Math.abs(+v) < 3e7) ? [+sx, +sy, +sz] : null;
  const quest = { position: here, server: typeof server === 'string' && server.length <= 256 ? server : '', kills: Number.isInteger(+kills) && +kills >= 0 ? +kills : null };
  return { id, name, quest, env: { water: water === '1', enclosed: enclosed === '1' }, players: players.map((r) => ({ id: r[0], name: r[1], distance: +r[2], pan: Math.max(-1, Math.min(1, +r[3])), rel: place(r), blocks: Math.max(0, Math.min(9, Math.floor(+r[7]) || 0)), wet: r[8] === '1' })) };
}
function enabled() { return true; } // In-game voice is independent of manual party voice.
function current() { return snapshot && Date.now() - sampledAt < 1800 ? snapshot : null; }
function nearby(id) { return current()?.players.find(p => p.id === id); }
function located(p) { if (!p) return null; return snapshot?.edition === 'bedrock' ? (() => { const v=bedrock.spatial(snapshot,peers.get(p.id),Date.now()); return v ? {...p,...v} : null; })() : p; }
function inRange(id) { const p = located(nearby(id)); return p && p.distance < (config.get().voice?.range || 32); }
function state() {
  const s = current();
  if (!s) return { active: false, connected: false, bridge, members: [] };
  return { active: true, connected: [...links.values()].some(l => l.up), bridge, members: [
    { id: s.id, name: s.name, self: true, voice, env: s.env || { water: false, enclosed: false } },
    ...s.players.map(located).filter(p => p && peers.has(p.id) && Date.now() - peers.get(p.id).seen < 12000).map(p => ({ ...peers.get(p.id), ...p, self: false })),
  ] };
}
function send(message, destination = snapshot?.id) {
  if (!snapshot || !ID.test(destination || '')) return;
  const payload = Buffer.from(JSON.stringify({ ...message, from: snapshot.id, nonce: crypto.randomBytes(8).toString('hex'), at: Date.now() }));
  for (const link of links.values()) if (link.up) link.client.publish(topic(destination), payload);
}
function look() {
  if (!snapshot || Date.now() - lastLook < 5000) return;
  lastLook = Date.now(); ownLook = {};
  if (config.get().gameSkins === false) return;
  const acc = config.get().accounts.find(a => a.id === config.get().activeAccount);
  const local = acc && require('./skins').localSkinFor(acc.id);
  if (local) {
    const url = png => png && png.length <= 256 * 1024 ? 'data:image/png;base64,' + png.toString('base64') : '';
    ownLook = { skin: url(local.png), cape: url(local.cape), model: local.model };
  }
}
function location() { return snapshot?.edition === 'bedrock' ? { bedrock: { position: snapshot.position, dimension: snapshot.dimension, players: [snapshot.id,...snapshot.players.map(p=>p.id)] } } : {}; }
let lastMove = 0;
function hello() {
  if (!snapshot) return;
  lastHello = Date.now(); lastMove = lastHello; look();
  const key = crypto.createHash('sha256').update(`${ownLook.skin || ''}|${ownLook.cape || ''}|${ownLook.model || ''}`).digest('hex');
  const withLook = needLook || key !== lookKey || lastHello - lookSentAt > 30000;
  if (withLook) { lookKey = key; lookSentAt = lastHello; needLook = false; }
  send({ type: 'hi', name: snapshot.name, voice, cos: require('./cosmetics').worn(), ...(withLook ? { ...ownLook, look: true } : {}), ...location() });
}
const seenMessages = new Map();
function receive(channel, bytes) {
  if (!current() || bytes.length > 750000) return;
  let m; try { m = JSON.parse(bytes.toString('utf8')); } catch { return; }
  if (!ID.test(m.from || '') || m.from === snapshot.id || !nearby(m.from) || !Number.isFinite(m.at) || Math.abs(Date.now() - m.at) > 15000 || !/^[a-f0-9]{16}$/.test(m.nonce || '')) return;
  if (seenMessages.has(m.nonce)) return;
  seenMessages.set(m.nonce, Date.now());
  while (seenMessages.size > 512) seenMessages.delete(seenMessages.keys().next().value);
  const old = peers.get(m.from);
  if ((m.type === 'hi' || m.type === 'move') && channel === topic(m.from)) {
    if (m.type === 'move' && (!old || snapshot.edition !== 'bedrock')) return;
    const position = snapshot.edition === 'bedrock' ? bedrock.presence(m.bedrock) : null;
    if (snapshot.edition === 'bedrock' && !position) return;
    // a hello without the look keeps the one we have (older launchers always send it)
    const keep = m.type === 'hi' && old && !m.look && m.skin === undefined && m.cape === undefined;
    const p = m.type === 'move' ? { ...old, bedrock: position, movedAt: Date.now(), seen: Date.now() } : { id: m.from, name: nearby(m.from).name, skin: keep ? old.skin : textureUrl(m.skin), cape: keep ? old.cape : textureUrl(m.cape, 'cape'), model: keep ? old.model : m.model === 'slim' ? 'slim' : 'classic', voice: m.voice?.on ? { on: true, mic: !!m.voice.mic, deaf: !!m.voice.deaf } : null, seen: Date.now(), bedrock: position, movedAt: Date.now() };
    if (m.type === 'hi') p.cos = Array.isArray(m.cos) ? m.cos.filter((x) => typeof x === 'string' && /^[a-z0-9_]{1,32}$/.test(x)).slice(0, 4) : (old && old.cos) || [];
    peers.set(m.from, p);
    // someone new: they get our look straight away
    if (!old && m.type === 'hi') { needLook = true; hello(); }
    emit('changed', state());
    if (!old || old.skin !== p.skin || old.cape !== p.cape || old.model !== p.model || JSON.stringify(old.cos || []) !== JSON.stringify(p.cos || [])) emit('cosmetics');
  } else if (m.type === 'signal' && channel === topic(snapshot.id) && inRange(m.from) && voice?.on && old?.voice?.on) {
    if (!['offer', 'answer', 'bye'].includes(m.kind) || typeof m.sdp !== 'string' || m.sdp.length > 24000) return;
    if (old.lastSignal && Date.now() - old.lastSignal < 200) return;
    old.lastSignal = Date.now();
    emit('signal', { from: m.from, kind: m.kind, sdp: m.sdp });
  }
}
function subscribe(link) {
  if (!snapshot || !link.up) return;
  const desired = new Set([snapshot.id, ...snapshot.players.map(p => p.id)].map(topic));
  // MQTT reconnect bounds subscriptions when the loaded player set changes.
  for (const t of link.topics) if (!desired.has(t)) { link.client.unsubscribe(t); link.topics.delete(t); }
  for (const t of desired) if (!link.topics.has(t)) { link.topics.add(t); link.client.subscribe(t); }
}
function connect() {
  if (!snapshot || !enabled()) return;
  const token = generation;
  for (const url of BROKERS) {
    if (links.has(url)) continue;
    const link = { url, up: false, topics: new Set() };
    const client = new MqttClient(url, { onMessage: receive, onClose: () => { if (links.get(url) === link) { links.delete(url); emit('changed', state()); } } });
    link.client = client; links.set(url, link);
    client.connect(8000).then(() => {
      if (token !== generation || links.get(url) !== link) { client.close(); return; }
      link.up = true; subscribe(link); hello(); emit('changed', state());
    }).catch(() => { if (links.get(url) === link) links.delete(url); });
  }
}
function stop(processId) {
  if (processId && processId !== pid) return;
  generation++; snapshot = null; sampledAt = 0; pid = 0;
  for (const l of links.values()) l.client.close();
  links.clear(); peers.clear(); seenMessages.clear();
  clearInterval(timer); timer = null; emit('changed', state()); emit('cosmetics');
}
function accept(line, processId) {
  const data = parse(line);
  if (data === undefined) return false;
  return acceptSample(data,processId);
}
function acceptBedrock(frame,processId) { return acceptSample(bedrock.sample(frame),processId); }
function acceptSample(data,processId) {
  // the event quests count what the game reports, whoever is around
  if (data) emit('sample', { pid: processId, edition: data.edition || 'java', name: data.edition === 'bedrock' ? data.name || '' : '', position: data.quest ? data.quest.position : data.position || null,
    dimension: data.dimension || '', server: data.quest ? data.quest.server : (bedrockServer || ''), kills: data.quest ? data.quest.kills : Number.isInteger(data.kills) ? data.kills : null });
  if (pid && pid !== processId && current()) return true; // one active voice world
  if (!data || !enabled()) { stop(processId); return true; }
  if (snapshot && snapshot.id !== data.id) stop();
  snapshot = data; sampledAt = Date.now(); pid = processId;
  if (data.edition === 'bedrock' && Date.now()-lastMove>=500) { lastMove=Date.now(); send({type:'move',...location()}); }
  for (const [id, peer] of peers) if (!nearby(id)) peers.delete(id);
  for (const l of links.values()) subscribe(l);
  if (!timer) {
    connect();
    timer = setInterval(() => {
      if (!current()) { stop(); return; }
      connect(); if (Date.now() - lastHello >= 4000) hello(); emit('changed', state());
    }, 1000);
    timer.unref();
  }
  emit('changed', state());
  return true;
}
function setVoice(v) { voice = v?.on ? { on: true, mic: !!v.mic, deaf: !!v.deaf } : null; hello(); emit('changed', state()); }
function signal(id, kind, sdp = '') {
  // anyone the game has loaded (not only those in earshot): calls are ready before they come close
  if (!located(nearby(id)) || !voice?.on || !['offer', 'answer', 'bye'].includes(kind) || typeof sdp !== 'string' || sdp.length > 24000) return;
  send({ type: 'signal', kind, sdp }, id);
}
module.exports = { parse, accept, acceptBedrock, stop, state, setVoice, signal, setBedrockServer: (s) => { bedrockServer = String(s || ''); }, setBridgeState: value => {bridge=value;emit('changed',state());}, onEvent: fn => listeners.add(fn) };
