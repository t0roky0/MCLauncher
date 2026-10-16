// The WebRTC middle of the tunnel into the leader's world (the TCP ends are
// the main process's tunnel.js).
//
// A friend calls the leader once the world is open (tunnel:join): one peer
// connection, a "ctl" channel to hold it, and then a channel per game
// connection ("c" + its id) as the main process accepts them. The leader
// answers every friend; a channel arriving from one becomes a socket to the
// world (tunnel:connect). Offers and answers go through the party's own
// encrypted channel (t-prefixed kinds, beside the voice call's).

import { api, onEvent, store } from './core.js';
import { toast } from './ui.js';

import { iceServers } from './ice.js';
const HIGH = 8 * 1024 * 1024; // a channel's backlog that pauses its socket
const LOW = 1024 * 1024;

const peers = new Map(); // member id → { pc, channels: Map(socket id → channel) }
let leaderPeer = null; // a friend's connection to the leader
let hosting = false;

function failed(error) {
  const ru = (store.get('config') || {}).language !== 'en';
  toast(error?.message || (ru
    ? 'Не удалось подключиться к миру лидера. Проверьте связь с лобби и обновите лаунчер у всех игроков. Подключение будет повторено автоматически.'
    : 'Could not connect to the leader’s world. Check the lobby connection and update every launcher. The connection will retry automatically.'), { kind: 'error', timeout: 12000 });
}

const send = (channel, ...args) => window.mcl.send(channel, ...args);

function gathered(pc, ms = 4500) {
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

// One game connection over one channel; bytes from the socket wait until
// the channel is open.
function bind(channels, id, dc) {
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW;
  const queue = [];
  let paused = false;
  const entry = {
    dc,
    write(bytes) {
      if (dc.readyState === 'open') {
        dc.send(bytes);
        if (!paused && dc.bufferedAmount > HIGH) {
          paused = true;
          send('tunnel:pause', id, true);
        }
      } else if (dc.readyState === 'connecting') queue.push(bytes);
    },
  };
  channels.set(id, entry);
  dc.onopen = () => {
    for (const b of queue.splice(0)) dc.send(b);
  };
  dc.onbufferedamountlow = () => {
    if (paused) {
      paused = false;
      send('tunnel:pause', id, false);
    }
  };
  dc.onmessage = (e) => send('tunnel:data', id, new Uint8Array(e.data));
  dc.onclose = () => {
    if (channels.get(id) !== entry) return;
    channels.delete(id);
    send('tunnel:close', id);
  };
  return entry;
}

function closePeer(peer) {
  if (!peer) return;
  clearTimeout(peer.fallbackTimer);
  clearTimeout(peer.retryTimer);
  for (const [id, c] of peer.channels) {
    try {
      c.dc.close();
    } catch { /* gone */ }
    send('tunnel:close', id);
  }
  peer.channels.clear();
  try {
    peer.pc.close();
  } catch { /* gone */ }
}

async function fallback(peer) {
  if (leaderPeer !== peer || peer.ready || peer.relayPending) return;
  peer.relayPending = true;
  clearTimeout(peer.fallbackTimer);
  // Once fallback starts, do not race a late direct connection against it.
  peer.pc.onconnectionstatechange = null;
  peer.pc.close();
  try {
    await api('tunnel:relay');
    if (leaderPeer !== peer) return;
    await api('tunnel:ready');
    if (leaderPeer !== peer) return;
    peer.ready = true;
    peer.relay = true;
  } catch (error) {
    if (leaderPeer !== peer) return;
    failed(error);
    peer.relayPending = false;
    peer.retryTimer = setTimeout(() => fallback(peer), 5000);
  }
}

async function reconnect(peer) {
  if (!peer || leaderPeer !== peer) return;
  closePeer(peer);
  leaderPeer = null;
  failed();
  try {
    const id = await api('tunnel:retry');
    if (id && !leaderPeer && store.get('party')?.active) await joinLeader(id);
  } catch (error) { failed(error); }
}

// ---- a friend's side -----------------------------------------------------------------------

async function joinLeader(leaderId) {
  // LAN availability is announced every heartbeat; keep the existing call.
  if (leaderId && leaderPeer?.leaderId === leaderId) return;
  closePeer(leaderPeer);
  leaderPeer = null;
  if (!leaderId) return;
  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  const peer = { pc, leaderId, channels: new Map(), ready: false };
  leaderPeer = peer;
  peer.fallbackTimer = setTimeout(() => fallback(peer), 8000);
  pc.createDataChannel('ctl');
  pc.onconnectionstatechange = async () => {
    if (leaderPeer !== peer) return;
    if (pc.connectionState === 'connected' && !peer.ready) {
      clearTimeout(peer.fallbackTimer);
      peer.ready = true;
      // the local end opens and the game goes in
      api('tunnel:ready').catch(failed);
    } else if (pc.connectionState === 'failed') {
      if (!peer.ready) await fallback(peer);
      else await reconnect(peer);
    } else if (pc.connectionState === 'disconnected') {
      clearTimeout(peer.retryTimer);
      peer.retryTimer = setTimeout(() => {
        if (pc.connectionState === 'disconnected') reconnect(peer);
      }, 8000);
    }
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    if (leaderPeer === peer) await api('party:signal', leaderId, 'toffer', pc.localDescription.sdp);
  } catch (error) {
    if (leaderPeer === peer) await fallback(peer);
  }
}

// ---- the leader's side ---------------------------------------------------------------------

async function answer(from, sdp) {
  closePeer(peers.get(from));
  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  const peer = { pc, channels: new Map() };
  peers.set(from, peer);
  pc.ondatachannel = (e) => {
    const dc = e.channel;
    if (!/^c[a-f0-9]{10}$/.test(dc.label)) return;
    const id = `${from.slice(0, 8)}${dc.label.slice(1)}`;
    bind(peer.channels, id, dc);
    api('tunnel:connect', id).then(ok => { if (!ok) dc.close(); }).catch(() => dc.close());
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      if (peers.get(from) === peer) peers.delete(from);
      closePeer(peer);
    }
  };
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    await api('party:signal', from, 'tanswer', pc.localDescription.sdp);
  } catch {
    closePeer(peer);
    peers.delete(from);
  }
}

// ---- wiring --------------------------------------------------------------------------------

function channelsFor(id) {
  if (leaderPeer && leaderPeer.channels.has(id)) return leaderPeer.channels;
  for (const p of peers.values()) if (p.channels.has(id)) return p.channels;
  return null;
}

export function initTunnel() {
  onEvent('tunnel:lost', () => reconnect(leaderPeer));
  onEvent('party:signal', (s) => {
    if (!s || !String(s.kind).startsWith('t')) return;
    if (s.kind === 'toffer') {
      if (hosting) answer(s.from, s.sdp);
      else api('party:signal', s.from, 'tbye').catch(() => {});
    } else if (s.kind === 'tanswer' && leaderPeer && leaderPeer.leaderId === s.from && leaderPeer.pc.signalingState === 'have-local-offer') {
      leaderPeer.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp }).catch(() => {});
    } else if (s.kind === 'tbye') {
      if (leaderPeer && leaderPeer.leaderId === s.from) {
        closePeer(leaderPeer);
        leaderPeer = null;
      }
      closePeer(peers.get(s.from));
      peers.delete(s.from);
    }
  });
  // a friend: the leader's world opened (or closed)
  onEvent('tunnel:join', (d) => joinLeader(d && d.leaderId));
  // the leader: our world is open to friends (or not any more)
  onEvent('tunnel:host', (d) => {
    hosting = !!(d && d.open);
    if (!hosting) {
      for (const p of peers.values()) closePeer(p);
      peers.clear();
    }
  });
  // a friend's game connected locally: a channel for it
  onEvent('tunnel:accept', ({ id }) => {
    if (!leaderPeer || leaderPeer.pc.connectionState !== 'connected') {
      send('tunnel:close', id);
      return;
    }
    bind(leaderPeer.channels, id, leaderPeer.pc.createDataChannel(`c${id}`, { ordered: true }));
  });
  onEvent('tunnel:data', ({ id, data }) => {
    const channels = channelsFor(id);
    const c = channels && channels.get(id);
    if (c) c.write(data);
  });
  onEvent('tunnel:closed', ({ id }) => {
    const channels = channelsFor(id);
    const c = channels && channels.get(id);
    if (!c) return;
    channels.delete(id);
    try {
      c.dc.close();
    } catch { /* gone */ }
  });
  // leaving the party ends it all
  store.on('party', (p) => {
    if (p && p.active) return;
    closePeer(leaderPeer);
    leaderPeer = null;
    for (const peer of peers.values()) closePeer(peer);
    peers.clear();
    hosting = false;
  });
}
