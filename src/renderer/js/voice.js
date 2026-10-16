// Independent party and in-world voice sessions with shared settings.
//
// Peer-to-peer WebRTC between the launchers in the party — a mesh, which is
// right for a handful of friends — with offers and answers carried over the
// party's own encrypted channel (party:signal). The audio is DTLS-SRTP
// encrypted end to end; no server of ours ever hears it.
//
// It lives in the main window's page, which keeps running (hidden) while the
// game is up, so the call goes on in-game. The mic opens by voice activity,
// while a key is held (push-to-talk — the main process watches the key even
// with the game in front) or stays open; it can be muted, and "deafen" mutes
// everyone and the mic at once. Every friend has their own volume.

import { api, onEvent, store } from './core.js';
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import { RelaySender, RelayPlayer, relaySupported } from './voice-relay.js';
import { toast } from './ui.js';

import { iceServers, refreshIce } from './ice.js';
const HANG_MS = 350; // voice activity keeps the mic open this long after you stop
const SPEAK_LEVEL = 14; // a friend counts as speaking above this (0..100)
const CALL_TIMEOUT_MS = 20000;
const DEFAULTS = { channel: 'nearby', range: 32, noise: 'rnnoise', mode: 'vad', input: '', output: '', threshold: 18, ptt: [86], pttName: 'V', micOff: false, deaf: false, volumes: {} };

function createVoiceSession(channel) {
const listeners = new Set();
const peers = new Map(); // party member id → peer
// The relay fallback: our encoder, friends' players, and since when each
// friend in voice has been without a direct call.
const RELAY_AFTER_MS = 6000;
let relayOut = null;
const relayIn = new Map(); // member id → RelayPlayer
const voiceSince = new Map(); // member id → ms
const forcedRelay = () => !!window.__mclVoiceRelay; // tests: never call directly
let on = false;
let joining = false;
let ctx = null;
let mic = null;
let micSource = null;
let analyser = null;
let gate = null;
let out = null;
let level = 0;
let open = false;
let lastLoud = -Infinity;
let lastSpeech = -Infinity;
let speaking = false;
let denoiser = null;
let highpass = null;
let noiseMode = 'standard';
let generation = 0;
let inputGeneration = 0;
let noiseBinary = null;
let lastEmit = 0;
let pttDown = false;
let pttNative = true;
let timer = null;
let selfId = '';
const buf = new Float32Array(512);

function onVoice(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  publishHud();
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* a broken listener must not stop the call */
    }
  }
}

const cfg = () => ({ ...DEFAULTS, ...((store.get('config') || {}).voice || {}) });

async function saveCfg(patch) {
  store.set({ config: await api('config:set', { voice: { ...cfg(), ...patch } }) });
}

// 0..100: -60 dBFS and below is 0, full scale is 100.
function measure(an) {
  an.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9);
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

let nearbyState = { active: false, members: [] };
let nearbyAt = 0;
let autoAttempted = false;
const isNearby = () => channel === 'nearby';
const voiceApi = (action, ...args) => api((isNearby() ? 'nearby:' : 'party:') + action, ...args);
function party() {
  if (isNearby()) {
    const fresh = nearbyState.active && performance.now() - nearbyAt < 1800;
    return { ...nearbyState, active: !!fresh, members: fresh ? nearbyState.members : [] };
  }
  return store.get('party') || { active: false };
}
function distanceGain(id) {
  if (!isNearby()) return 1;
  const m = party().members?.find(m => m.id === id);
  if (!m || !Number.isFinite(m.distance)) return 0;
  return Math.max(0, 1 - m.distance / cfg().range) ** 2;
}

function autoJoinNearby() {
  if (!isNearby()) return;
  if (!party().active) { autoAttempted = false; if (on || joining) leave(); return; }
  if (on || joining || autoAttempted) return;
  autoAttempted = true;
  join().catch(error => {
    const ru = (store.get('config') || {}).language !== 'en';
    toast(ru ? `Не удалось включить голос в игре: ${error.message}` : `Could not start in-game voice: ${error.message}`, { kind: 'error' });
  });
}
async function setRange(range) { await saveCfg({range}); sync(); }


// What the others see of us: in voice, mic on, deafened.
function publish() {
  const v = cfg();
  voiceApi('voice', on ? { on: true, mic: !v.micOff && !v.deaf, deaf: v.deaf } : null).catch(() => {});
}

// A short rising or falling blip: someone came or went (the lobby's voice;
// in the game people come and go as you walk — no sound for that).
function blip(up) {
  if (!ctx || isNearby()) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  const t = ctx.currentTime;
  o.type = 'square';
  o.frequency.setValueAtTime(up ? 520 : 700, t);
  o.frequency.linearRampToValueAtTime(up ? 760 : 460, t + 0.09);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.035, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + 0.13);
}

async function openMic(deviceId) {
  const base = { echoCancellation: true, noiseSuppression: cfg().noise === 'standard', autoGainControl: true, channelCount: 1 };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base });
  } catch (e) {
    if (!deviceId) throw e;
    return navigator.mediaDevices.getUserMedia({ audio: base }); // the saved device is gone
  }
}

async function prepareNoise(context) {
  if (cfg().noise !== 'rnnoise') return null;
  noiseBinary ||= loadRnnoise({url:'mcl://app/assets/audio/rnnoise.wasm', simdUrl:'mcl://app/assets/audio/rnnoise_simd.wasm'}).catch(e => {noiseBinary = null; throw e;});
  const [wasmBinary] = await Promise.all([noiseBinary, context.audioWorklet.addModule('mcl://app/assets/audio/rnnoise-worklet.js')]);
  return new RnnoiseWorkletNode(context, {maxChannels:1, wasmBinary});
}

async function join() {
  if (on || joining || !party().active) return;
  const token = ++generation;
  joining = true;
  emit();
  try {
    const v = cfg();
    const stream = await openMic(v.input);
    if (token !== generation || !party().active) { stream.getTracks().forEach(t => t.stop()); return; }
    mic = stream;
    const context = new AudioContext({ latencyHint: 'interactive', sampleRate:48000 });
    ctx = context;
    await context.resume();
    let node;
    try { node = await prepareNoise(context); }
    catch (e) {
      if (token !== generation) return;
      console.warn('RNNoise unavailable, using WebRTC suppression:', e);
      await Promise.all(stream.getAudioTracks().map(t => t.applyConstraints({noiseSuppression:true})));
    }
    if (token !== generation || !party().active) { node?.destroy(); node?.disconnect(); return; }
    denoiser = node || null;
    noiseMode = denoiser ? 'rnnoise' : v.noise === 'off' ? 'off' : 'standard';
    micSource = ctx.createMediaStreamSource(mic);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    gate = ctx.createGain();
    gate.gain.value = 0;
    out = ctx.createMediaStreamDestination();
    highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 80;
    micSource.connect(highpass);
    const processed = denoiser ? highpass.connect(denoiser) : highpass;
    processed.connect(analyser);
    processed.connect(gate);
    gate.connect(out);
    if (!isNearby() && relaySupported()) relayOut = new RelaySender(ctx, gate, (pkt) => api('party:audio', pkt).catch(() => {}));
    if (v.output && ctx.setSinkId) ctx.setSinkId(v.output).catch(() => {});
    on = true;
    refreshActivity();
    timer = setInterval(step, 20);
    await setupPtt();
    publish();
    blip(true);
    sync();
  } catch (e) {
    if (token === generation) { on = false; cleanup(); }
    if (token === generation) throw e;
  } finally {
    if (token === generation) joining = false;
    emit();
  }
}

function cleanup() {
  clearInterval(timer);
  timer = null;
  if (relayOut) relayOut.close();
  relayOut = null;
  for (const r of relayIn.values()) r.close();
  relayIn.clear();
  voiceSince.clear();
  if (mic) mic.getTracks().forEach((t) => t.stop());
  denoiser?.destroy();
  denoiser?.disconnect();
  denoiser = highpass = null;
  lastLoud = lastSpeech = -Infinity;
  speaking = false;
  if (ctx) ctx.close().catch(() => {});
  ctx = mic = micSource = analyser = gate = out = null;
  level = 0;
  open = false;
}

function leave() {
  if (!on && !joining) return;
  generation++;
  inputGeneration++;
  joining = false;
  on = false;
  for (const id of [...peers.keys()]) closePeer(id, true);
  watchKeys().catch(() => {});
  refreshActivity();
  cleanup();
  publish();
  emit();
}

function step() {
  if (!on || !analyser) return;
  const v = cfg();
  const now = performance.now();
  level = measure(analyser);
  if (level >= v.threshold) lastLoud = now;
  const want = !v.micOff && !v.deaf && (v.mode === 'open' || (v.mode === 'ptt' && pttDown) || (v.mode === 'vad' && now - lastLoud < HANG_MS));
  if (want !== open) {
    open = want;
    gate.gain.setTargetAtTime(open ? 1 : 0, ctx.currentTime, 0.012);
  }
  if (open && level >= Math.max(SPEAK_LEVEL, v.threshold)) lastSpeech = now;
  speaking = open && !v.micOff && !v.deaf && now - lastSpeech < 200;
  // anyone in voice still without a direct call after a few seconds hears us
  // through the relay
  let needRelay = false;
  for (const [id, since] of voiceSince) {
    const p = peers.get(id);
    if (forcedRelay() || (!(p && p.state === 'connected') && now - since > RELAY_AFTER_MS)) needRelay = true;
  }
  if (relayOut) {
    relayOut.setActive(needRelay);
    relayOut.setOpen(open);
  }
  for (const r of relayIn.values()) {
    r.level = measure(r.analyser);
    if (r.level > SPEAK_LEVEL) r.loud = now;
    r.speaking = now - (r.loud ?? -Infinity) < 200;
  }
  for (const p of peers.values()) {
    if (!p.analyser) continue;
    p.level = measure(p.analyser);
    if (p.level > SPEAK_LEVEL) p.loud = now;
    const remote = party().members?.find(m => m.id === p.id)?.voice;
    p.speaking = !!remote?.mic && !remote.deaf && now - (p.loud ?? -Infinity) < 200;
    // a call that never connected, or lost and didn't come back: start over
    if ((p.state === 'new' || p.state === 'connecting') && now - p.started > CALL_TIMEOUT_MS) retry(p);
    else if (p.state === 'disconnected' && now - p.changed > 8000) retry(p);
  }
  if (now - lastEmit > 120) {
    lastEmit = now;
    if (isNearby()) applyVolumes();
    emit();
  }
}

// ---- calls ------------------------------------------------------------------------------

function newPeer(id, name, initiator) {
  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  const peer = { id, name, initiator, pc, audio: null, analyser: null, level: 0, speaking: false, state: 'connecting', started: performance.now() };
  for (const t of out.stream.getAudioTracks()) pc.addTrack(t, out.stream);
  pc.ontrack = (e) => attach(peer, e.streams[0] || new MediaStream([e.track]));
  pc.onconnectionstatechange = () => {
    if (peers.get(id) !== peer) return;
    const was = peer.state;
    peer.state = pc.connectionState;
    peer.changed = performance.now();
    if (peer.state === 'connected' && was !== 'connected') blip(true);
    if (peer.state === 'failed') retry(peer);
    emit();
  };
  return peer;
}

// Wait for the ICE candidates to be gathered (no trickle: one message each way).
function gathered(pc, ms = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const t = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

async function call(id, name) {
  await refreshIce();
  const peer = newPeer(id, name, true);
  peers.set(id, peer);
  try {
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    await gathered(peer.pc);
    if (peers.get(id) === peer) await voiceApi('signal', id, 'offer', peer.pc.localDescription.sdp);
  } catch {
    retry(peer);
  }
}

function retry(peer) {
  if (peers.get(peer.id) !== peer) return;
  closePeer(peer.id, false);
  // the one who calls tries again; the other waits for the call
  if (peer.initiator) setTimeout(() => on && !peers.has(peer.id) && sync(), 3000);
}

function attach(peer, stream) {
  if (peer.audio) return;
  const v = cfg();
  peer.audio = new Audio();
  peer.audio.srcObject = stream;
  peer.audio.autoplay = true;
  if (v.output && peer.audio.setSinkId) peer.audio.setSinkId(v.output).catch(() => {});
  if (ctx) {
    const src = ctx.createMediaStreamSource(stream);
    peer.analyser = ctx.createAnalyser();
    peer.analyser.fftSize = 512;
    src.connect(peer.analyser);
    // In a world the voice comes from where they stand: Web Audio plays it,
    // the element only keeps the call's audio flowing (Chromium needs one).
    if (isNearby()) {
      peer.audio.muted = true;
      peer.space = spatialVoice(src);
    }
  }
  peer.audio.play().catch(() => {});
  applyVolumes();
}

// ---- 3D voice ---------------------------------------------------------------------------
// Each nearby voice: volume by distance → muffling (walls, water) → direction
// (HRTF: left/right, up/down, ahead/behind) → us; and a share of it into an
// echo when we stand under a roof (a cave, a house).
let echo = null;

function echoOf(context) {
  if (echo && echo.ctx === context) return echo.input;
  const seconds = 1.6, rate = context.sampleRate, len = Math.floor(seconds * rate);
  const ir = context.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const data = ir.getChannelData(c);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  const conv = context.createConvolver();
  conv.buffer = ir;
  const input = context.createGain();
  input.connect(conv).connect(context.destination);
  echo = { ctx: context, input };
  return input;
}

function spatialVoice(src) {
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 20000;
  filter.Q.value = 0.5;
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'linear';
  panner.rolloffFactor = 0; // distance is ours (gain), the panner only gives direction
  panner.positionZ.value = -1;
  const wet = ctx.createGain();
  wet.gain.value = 0;
  src.connect(gain).connect(filter).connect(panner).connect(ctx.destination);
  filter.connect(wet).connect(echoOf(ctx));
  return { src, gain, filter, panner, wet };
}

// Where a nearby player is and what's around: {rel, blocks, wet} of theirs, our env.
function placeVoice(p, m, volume) {
  const sp = p.space;
  const t = ctx.currentTime;
  const me = party().members?.find((x) => x.self)?.env || {};
  const blocks = m?.blocks || 0;
  const water = !!(me.water || m?.wet);
  const muffle = [1, 0.75, 0.6, 0.5][Math.min(3, blocks)] * (water ? 0.8 : 1);
  sp.gain.gain.setTargetAtTime(volume * distanceGain(p.id) * muffle, t, 0.06);
  const cutoff = Math.min([20000, 2600, 1500, 950][Math.min(3, blocks)], water ? 650 : 20000);
  sp.filter.frequency.setTargetAtTime(cutoff, t, 0.08);
  // Web Audio: right +X, up +Y, ahead -Z; a unit vector — the gain does distance
  let [x, y, z] = m?.rel ? [m.rel[0], m.rel[1], -m.rel[2]] : [Number(m?.pan) || 0, 0, -Math.sqrt(Math.max(0, 1 - (Number(m?.pan) || 0) ** 2))];
  const len = Math.hypot(x, y, z);
  if (len < 0.6) [x, y, z] = [0, 0, -1];
  else [x, y, z] = [x / len, y / len, z / len];
  sp.panner.positionX.setTargetAtTime(x, t, 0.05);
  sp.panner.positionY.setTargetAtTime(y, t, 0.05);
  sp.panner.positionZ.setTargetAtTime(z, t, 0.05);
  const far = Math.min(1, (Number(m?.distance) || 0) / Math.max(8, cfg().range));
  sp.wet.gain.setTargetAtTime(me.enclosed ? 0.1 + 0.25 * far : water ? 0.05 : 0, t, 0.2);
}

function closePeer(id, bye) {
  const p = peers.get(id);
  if (!p) return;
  peers.delete(id);
  try {
    p.pc.close();
  } catch {
    /* closed */
  }
  if (p.audio) {
    p.audio.pause();
    p.audio.srcObject = null;
  }
  if (p.space) {
    for (const node of Object.values(p.space)) {
      try {
        node.disconnect();
      } catch { /* gone */ }
    }
    p.space = null;
  }
  if (bye) voiceApi('signal', id, 'bye').catch(() => {});
  if (on && p.state === 'connected') blip(false);
  emit();
}

function applyVolumes() {
  const v = cfg();
  for (const [id, r] of relayIn) {
    const m = (party().members || []).find((x) => x.id === id);
    if (m) r.name = m.name;
    r.setVolume(v.deaf ? 0 : (v.volumes[r.name] ?? 100) / 100);
  }
  for (const p of peers.values()) {
    if (!p.audio) continue;
    const vol = v.volumes[p.name] ?? 100;
    const volume = v.deaf ? 0 : Math.max(0, Math.min(1, vol / 100));
    if (p.space && ctx) {
      placeVoice(p, party().members?.find((m) => m.id === p.id), volume);
      continue;
    }
    p.audio.volume = volume * distanceGain(p.id);
    p.audio.muted = v.deaf || vol === 0;
  }
}

// Who should we be talking to? Everyone in the party who's in voice. Of two,
// the one with the smaller id calls; the other answers.
function sync() {
  const p = party();
  if (!p.active) {
    leave();
    return;
  }
  const me = (p.members || []).find((m) => m.self);
  selfId = me ? me.id : '';
  if (!on) return;
  // In the game: a call to everyone in voice the game has loaded (nearest
  // first), made before they come close — by the time they are in range the
  // call is up; their volume follows the distance (silent beyond the range).
  const near = (p.members || []).filter((m) => !m.self && m.voice && m.voice.on);
  if (isNearby()) near.sort((a, b) => (Number(a.distance) || 1e9) - (Number(b.distance) || 1e9));
  const want = new Map(near.slice(0, 12).map((m) => [m.id, m]));
  for (const id of [...peers.keys()]) if (!want.has(id)) closePeer(id, false);
  for (const id of [...voiceSince.keys()]) if (!want.has(id)) voiceSince.delete(id);
  for (const [id, r] of relayIn) {
    if (want.has(id)) continue;
    r.close();
    relayIn.delete(id);
  }
  for (const [id, m] of want) {
    if (!voiceSince.has(id)) voiceSince.set(id, performance.now());
    const peer = peers.get(id);
    if (peer) peer.name = m.name;
    else if (selfId && selfId < id && !forcedRelay()) call(id, m.name);
  }
  applyVolumes();
  emit();
}

async function onSignal({ from, kind, sdp }) {
  if (isNearby() && !party().members?.some(m => m.id === from && m.voice?.on)) return;
  if (kind === 'bye') {
    closePeer(from, false);
    return;
  }
  if (!on || forcedRelay()) {
    if (kind === 'offer') voiceApi('signal', from, 'bye').catch(() => {});
    return;
  }
  if (kind === 'offer') {
    closePeer(from, false);
    const m = (party().members || []).find((x) => x.id === from);
    const peer = newPeer(from, m ? m.name : '', false);
    peers.set(from, peer);
    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp });
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      await gathered(peer.pc);
      if (peers.get(from) === peer) await voiceApi('signal', from, 'answer', peer.pc.localDescription.sdp);
    } catch {
      closePeer(from, false);
    }
  } else if (kind === 'answer') {
    const peer = peers.get(from);
    if (peer && peer.initiator && peer.pc.signalingState === 'have-local-offer') {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp }).catch(() => retry(peer));
    }
  }
}

// ---- push-to-talk ------------------------------------------------------------------------

async function setupPtt() {
  const v = cfg();
  pttDown = false;
  if (on && v.mode === 'ptt' && v.ptt.length) {
    const r = await watchKeys().catch(() => null);
    pttNative = !!(r && r.native);
  } else {
    pttNative = true;
    await watchKeys().catch(() => {});
  }
}

// keyCode is Windows' virtual-key code; mouse side buttons are VK 5 and 6
function vkOf(e) {
  if (e.type === 'mousedown' || e.type === 'mouseup') return { 1: 4, 3: 5, 4: 6 }[e.button] || 0;
  return e.keyCode || 0;
}

// ---- settings ----------------------------------------------------------------------------

async function setMicOff(off) {
  await saveCfg({ micOff: !!off });
  publish();
  emit();
}

async function setDeaf(deaf) {
  await saveCfg({ deaf: !!deaf });
  applyVolumes();
  publish();
  emit();
}

async function setMode(mode) {
  await saveCfg({ mode });
  await setupPtt();
  emit();
}

async function setThreshold(n) {
  await saveCfg({ threshold: n });
  emit();
}

async function setVolume(name, n) {
  await saveCfg({ volumes: { ...cfg().volumes, [name]: n } });
  applyVolumes();
  emit();
}

async function setPttKey(vks, name) {
  await saveCfg({ ptt: vks, pttName: name });
  await setupPtt();
  emit();
}

// A new mic mid-call: only the source changes, the calls keep their track.
async function setInput(deviceId) {
  await saveCfg({ input: deviceId });
  if (!on) return;
  const token = ++inputGeneration;
  const context = ctx;
  const next = await openMic(deviceId);
  if (!on || ctx !== context || token !== inputGeneration) { next.getTracks().forEach(t => t.stop()); return; }
  const src = ctx.createMediaStreamSource(next);
  src.connect(highpass);
  micSource.disconnect();
  mic.getTracks().forEach((t) => t.stop());
  mic = next;
  micSource = src;
}

async function setNoise(noise) {
  await saveCfg({noise});
  // Rebuild processing once; peers renegotiate with the new processed track.
  if (on || joining) { leave(); await join(); }
  emit();
}

async function setOutput(deviceId) {
  await saveCfg({ output: deviceId });
  if (ctx?.setSinkId) await ctx.setSinkId(deviceId).catch(() => {});
  for (const p of peers.values()) if (p.audio && p.audio.setSinkId) p.audio.setSinkId(deviceId).catch(() => {});
}

async function devices() {
  const list = await navigator.mediaDevices.enumerateDevices();
  return { inputs: list.filter((d) => d.kind === 'audioinput'), outputs: list.filter((d) => d.kind === 'audiooutput') };
}

function voiceState() {
  const v = cfg();
  return {
    on,
    channel,
    range: v.range,
    nearbyReady: nearbyState.active && performance.now() - nearbyAt < 1800,
    nearbyConnected: nearbyState.connected,
    bedrockBridge: nearbyState.bridge,
    joining,
    speaking: speaking && on && !v.micOff && !v.deaf,
    noise: on ? noiseMode : v.noise,
    level,
    open,
    mode: v.mode,
    micOff: v.micOff,
    deaf: v.deaf,
    threshold: v.threshold,
    pttName: v.pttName,
    pttNative,
    // in the game only the ones in earshot show (the calls to the rest wait quietly)
    peers: [
      ...[...peers.values()].filter((p) => p.state === 'connected' || !(relayIn.get(p.id) || { active: () => false }).active()).map((p) => ({ id: p.id, name: p.name, state: p.state, speaking: p.speaking, volume: v.volumes[p.name] ?? 100 })),
      // friends heard through the relay count as connected
      ...[...relayIn.entries()].filter(([id, r]) => r.active() && !(peers.get(id) && peers.get(id).state === 'connected')).map(([id, r]) => ({ id, name: r.name, state: 'connected', relay: true, speaking: r.speaking, volume: v.volumes[r.name] ?? 100 })),
    ].filter((p) => !isNearby() || distanceGain(p.id) > 0),
  };
}

// ---- wiring ---------------------------------------------------------------------------------

function initVoice() {
  store.on('party', sync);
  onEvent('party:signal', (s) => { if (!isNearby()) onSignal(s); });
  const updateNearby = s => { nearbyState = s; nearbyAt = performance.now(); if (isNearby()) { sync(); autoJoinNearby(); } };
  store.on('config', () => { autoJoinNearby(); if (on) {publish();applyVolumes();} emit(); });
  onEvent('nearby:changed', updateNearby);
  onEvent('nearby:signal', s => { if (isNearby()) onSignal(s); });
  api('nearby:state').then(updateNearby).catch(() => {});
  // a friend's voice through the relay — unless we already have them directly
  onEvent('party:audio', ({ from, s, f }) => {
    if (!on || !ctx || isNearby()) return;
    const p = peers.get(from);
    if (p && p.state === 'connected' && !forcedRelay()) return;
    let r = relayIn.get(from);
    if (!r) {
      const m = (party().members || []).find((x) => x.id === from);
      if (!m || !m.voice || !m.voice.on) return;
      r = new RelayPlayer(ctx, m.name);
      relayIn.set(from, r);
      applyVolumes();
    }
    r.push({ s, f });
  });
  onEvent('voice:ptt', ({ down }) => {
    pttDown = !!down;
  });
  // without the C++ module the key is only seen while the launcher has focus
  const local = (down) => (e) => {
    if (!pttNative && on && cfg().mode === 'ptt' && cfg().ptt.includes(vkOf(e))) pttDown = down;
  };
  window.addEventListener('keydown', local(true));
  window.addEventListener('keyup', local(false));
  window.addEventListener('mousedown', local(true));
  window.addEventListener('mouseup', local(false));
}

return { initVoice, join, leave, voiceState, onVoice, devices, vkOf, setRange, setMicOff, setDeaf, setMode, setThreshold, setVolume, setPttKey, setInput, setNoise, setOutput };
}

const partySession = createVoiceSession('party');
const nearbySession = createVoiceSession('nearby');
const sessions = [partySession, nearbySession];
function refreshActivity() { api('win:keepAlive', sessions.some(s => s.voiceState().on)).catch(() => {}); }
function watchKeys() {
  const v = { ...DEFAULTS, ...store.get('config')?.voice };
  return api('voice:ptt', sessions.some(s => s.voiceState().on) && v.mode === 'ptt' ? v.ptt : []);
}
function publishHud() { api('voice:hud', settingsState()).catch(() => {}); }
export function settingsState() {
  const party = partySession.voiceState(), nearby = nearbySession.voiceState();
  const active = nearby.on ? nearby : party;
  return { ...active, on: party.on || nearby.on, joining: party.joining || nearby.joining,
    level: Math.max(party.level, nearby.level), speaking: party.speaking || nearby.speaking,
    peers: [...party.peers, ...nearby.peers] };
}
export const voiceState = () => partySession.voiceState();
export const nearbyVoiceState = () => nearbySession.voiceState();
export const join = () => partySession.join();
export const leave = () => partySession.leave();
export function onVoice(fn) { const offs = sessions.map(s => s.onVoice(fn)); return () => offs.forEach(off => off()); }
export function initVoice() {
  for (const session of sessions) session.initVoice();
  // the in-game menu: how the mic opens, lobby voice in or out
  onEvent('voice:command', (c) => {
    if (c?.mode) setMode(c.mode).catch(() => {});
    if (c?.join) partySession.join().catch((e) => toast(e.message, { kind: 'error' }));
    if (c?.leave) partySession.leave();
  });
}
export const devices = () => partySession.devices();
export const vkOf = e => partySession.vkOf(e);
export const setRange = range => nearbySession.setRange(range);
export async function setMicOff(...args) { for (const session of sessions) await session.setMicOff(...args); }
export async function setDeaf(...args) { for (const session of sessions) await session.setDeaf(...args); }
export async function setMode(...args) { for (const session of sessions) await session.setMode(...args); }
export async function setThreshold(...args) { for (const session of sessions) await session.setThreshold(...args); }
export async function setVolume(...args) { for (const session of sessions) await session.setVolume(...args); }
export async function setPttKey(...args) { for (const session of sessions) await session.setPttKey(...args); }
export async function setInput(...args) { for (const session of sessions) await session.setInput(...args); }
export async function setNoise(...args) { for (const session of sessions) await session.setNoise(...args); }
export async function setOutput(...args) { for (const session of sessions) await session.setOutput(...args); }
