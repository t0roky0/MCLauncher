const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const events = new Map(), pcs = [], calls = [], errors = [];
  class Peer {
    constructor() { this.connectionState = 'new'; this.iceGatheringState = 'complete'; pcs.push(this); }
    createDataChannel(label) { return { label, readyState: 'connecting', close() {} }; }
    async createOffer() { return { type: 'offer', sdp: 'offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
    async setLocalDescription(sdp) { this.localDescription = sdp; }
    async setRemoteDescription() {}
    close() { this.connectionState = 'closed'; }
  }
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/tunnel.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export function initTunnel', 'function initTunnel');
  vm.runInNewContext(source + '\ninitTunnel();', {
    api: async (...args) => { calls.push(args); return true; },
    onEvent: (name, fn) => events.set(name, fn),
    store: { on() {}, get: () => ({ language: 'ru' }) },
    toast: message => errors.push(message), RTCPeerConnection: Peer, iceServers: () => [],
    window: { mcl: { send() {} } }, setTimeout, clearTimeout, Uint8Array,
  });
  return { events, pcs, calls, errors };
}

test('repeated LAN heartbeats preserve the connection being negotiated and the connected tunnel', async () => {
  const f = fixture();
  await f.events.get('tunnel:join')({ leaderId: 'host' });
  await f.events.get('tunnel:join')({ leaderId: 'host' });
  assert.equal(f.pcs.length, 1);
  f.pcs[0].connectionState = 'connected';
  await f.pcs[0].onconnectionstatechange();
  await f.events.get('tunnel:join')({ leaderId: 'host' });
  assert.equal(f.pcs.length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'tunnel:ready').length, 1);
  await f.events.get('tunnel:join')({ leaderId: '' });
  assert.equal(f.pcs[0].connectionState, 'closed');
});

test('control channel does not open an extra Minecraft connection; socket channels do', async () => {
  const f = fixture();
  f.events.get('tunnel:host')({ open: true });
  f.events.get('party:signal')({ from: '1234567890abcdef', kind: 'toffer', sdp: 'offer' });
  const pc = f.pcs[0];
  pc.ondatachannel({ channel: pc.createDataChannel('ctl') });
  assert.equal(f.calls.filter(c => c[0] === 'tunnel:connect').length, 0);
  pc.ondatachannel({ channel: pc.createDataChannel('c0123456789') });
  assert.equal(f.calls.filter(c => c[0] === 'tunnel:connect').length, 1);
});

test('failed direct connection uses the relay before starting Minecraft', async () => {
  const f = fixture();
  await f.events.get('tunnel:join')({ leaderId: 'host' });
  f.pcs[0].connectionState = 'failed';
  await f.pcs[0].onconnectionstatechange();
  assert.equal(f.errors.length, 0);
  assert.equal(f.calls.filter(c => c[0] === 'tunnel:relay').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'tunnel:ready').length, 1);
  await f.events.get('tunnel:join')({ leaderId: 'host' });
  assert.equal(f.pcs.length, 1);
});
