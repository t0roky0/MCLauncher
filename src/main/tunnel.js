'use strict';
// The TCP ends of the party-world tunnel. The leader's game opens its world
// to LAN; friends' games connect to a port on their own PC (127.0.0.1); in
// between, the page carries every connection over a WebRTC data channel
// (renderer tunnel.js) — direct and encrypted, launcher to launcher.
//
// A friend's side: listen() opens the local port; each game connection gets
// an id and is announced to the page (tunnel:accept), which opens a channel
// for it. The leader's side: a channel arriving from a friend becomes
// connect(id) — a socket to the world's LAN port. Bytes go both ways through
// data(); a full channel pauses the socket until it drains.

const net = require('net');
const crypto = require('crypto');
const log = require('./log');

let toPage = () => {};
const sockets = new Map(); // id → socket
let server = null;
let localPort = 0;
let hostPort = 0;
let relay = null;
let relayLeader = '';
let listenPending = null;

function wire(id, sock) {
  sockets.set(id, sock);
  sock.setNoDelay(true);
  sock.on('data', (d) => toPage('tunnel:data', { id, data: d }));
  sock.on('close', () => {
    if (sockets.get(id) !== sock) return;
    sockets.delete(id);
    toPage('tunnel:closed', { id });
  });
  sock.on('error', () => {});
}

// A friend: the port their game connects to.
function listen() {
  if (server && localPort) return Promise.resolve(localPort);
  if (listenPending) return listenPending;
  listenPending = new Promise((resolve, reject) => {
    const s = net.createServer({ allowHalfOpen: true }, (sock) => {
      if (relayLeader) { relay.open(relayLeader, sock); return; }
      const id = crypto.randomBytes(5).toString('hex');
      wire(id, sock);
      toPage('tunnel:accept', { id });
    });
    server = s;
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      server = s;
      localPort = s.address().port;
      log.info(`Party world: the game connects to 127.0.0.1:${localPort}.`);
      resolve(localPort);
    });
  }).finally(() => { listenPending = null; });
  return listenPending;
}

// The leader: a friend's connection into the world.
function connect(id) {
  if (!hostPort) return false;
  wire(id, net.connect(hostPort, '127.0.0.1'));
  return true;
}

function data(id, bytes) {
  const sock = sockets.get(id);
  if (sock && !sock.destroyed) sock.write(Buffer.from(bytes));
}

function close(id) {
  const sock = sockets.get(id);
  if (sock) sock.destroy();
}

function pause(id, on) {
  const sock = sockets.get(id);
  if (!sock) return;
  if (on) sock.pause();
  else sock.resume();
}

function setHostPort(port) {
  hostPort = Number(port) || 0;
}

// The party world is over: every connection and the local port go.
function stop() {
  relayLeader = '';
  relay?.stop();
  for (const sock of sockets.values()) sock.destroy();
  sockets.clear();
  if (server) server.close();
  server = null;
  localPort = 0;
  hostPort = 0;
}

module.exports = {
  init(fn) {
    toPage = fn;
    if (relay) return;
    const party = require('./party');
    const { WorldRelay } = require('./world-relay');
    relay = new WorldRelay({
      send: (to, frame) => party.world(to, frame),
      hostPort: () => party.state().leader ? hostPort : 0,
      allowed: id => party.state().members?.some(m => m.id === id && !m.self) || false,
      onError: () => toPage('tunnel:lost', {}),
    });
    party.onEvent((type, payload) => {
      if (type === 'world') relay.receive(payload.from, payload.frame);
      if (type === 'changed' && !payload.active) stop();
    });
  },
  async useRelay() {
    const party = require('./party');
    const leader = party.leaderId();
    if (!relay || !leader || party.state().leader) throw new Error('Мир лидера недоступен.');
    await relay.probe(leader);
    if (!party.state().active || leader !== party.leaderId()) throw new Error('Лобби изменилось.');
    relayLeader = leader;
    return true;
  },
  listen,
  connect,
  data,
  close,
  pause,
  setHostPort,
  stop,
  hostPort: () => hostPort,
};
