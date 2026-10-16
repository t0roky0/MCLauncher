const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = process.env.MCL_TEST_SOURCE || path.join(__dirname, '../../src/main');

function load(file, deps) {
  const module = { exports: {} };
  const timer = fn => (...args) => { const t = fn(...args); t.unref(); return t; };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    module, exports: module.exports, require: id => deps[id] || require(id.startsWith('.') ? path.join(__dirname, '../../src/main', id) : id), Buffer, URL, console,
    setTimeout: timer(setTimeout), clearTimeout, clearInterval,
    setInterval: (fn, ms) => timer(setInterval)(fn, ms === 8000 ? 80 : ms),
  });
  return module.exports;
}
async function until(fn, message) {
  const end = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > end) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function relay() {
  const clients = new Set();
  const net = { drop: () => false, key: null, decode: () => null };
  net.MqttClient = class {
    constructor(url, { onMessage }) { this.onMessage = onMessage; }
    connect() { clients.add(this); return Promise.resolve(); }
    subscribe(topic) { this.topic = topic; }
    publish(topic, payload) {
      const packet = net.key && net.decode(net.key, payload);
      if (packet && net.drop(packet)) return;
      for (const client of clients) if (client !== this && client.topic === topic)
        setImmediate(() => client.onMessage(topic, payload));
    }
    close() { clients.delete(this); }
  };
  return net;
}
function launcher(net, { ready = true } = {}) {
  const deps = { './config': { get: () => ({ partyRelay: 'mem://relay', language: 'ru' }) },
    './mqtt': net, './log': { info() {}, warn() {} } };
  const party = load('party.js', deps);
  const entry = { id: 'java', name: 'Minecraft', mcVersion: '26.3', loader: 'vanilla' };
  const calls = [], redirects = [], messages = [], listeners = [], gameListeners = [];
  let running = false;
  const installs = {
    listForUi: () => [entry], entryById: id => id === entry.id ? entry : null,
    isReady: () => ready, taskView: () => ({ busy: false }),
    start: (id, opts) => { calls.push({ id, opts }); if (opts.launch !== false) running = true; return true; },
    onEvent: fn => listeners.push(fn),
  };
  const tunnel = { listen: async () => 25570, stop() {}, setHostPort() {} };
  const game = { isRunning: () => running, connectToServer: (id, server) => redirects.push({ id, server }), onEvent: fn => gameListeners.push(fn) };
  const controller = load('party-game.js', { ...deps, './party': party, './installs': installs,
    './game': game, './tunnel': tunnel, './bedrock': { cached: () => ({ installed: true }) } });
  controller.init({ send: (type, payload) => messages.push({ type, payload }) });
  return { party, controller, calls, redirects, messages, installs, gameListeners,
    emit(type, data = {}) { for (const fn of gameListeners) fn(type, { pid: 123, installId: 'java', ...data }); },
    finish() { ready = true; for (const fn of listeners) fn('done', { id: 'java', action: 'verify' }); } };
}
async function pair(t, opts) {
  const net = relay(), host = launcher(net), guest = launcher(net, opts);
  t.after(() => { host.party.leave(); guest.party.leave(); });
  const { code } = await host.party.create({ name: 'Host' });
  net.key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(host.party.normalize(code)), Buffer.from('mclauncher-party'), Buffer.from('key'), 32));
  net.decode = host.party.open;
  await guest.party.join(code, { name: 'Guest' });
  await until(() => host.party.state().members.length === 2 && guest.party.state().members.length === 2, 'members joined');
  return { net, host, guest };
}

test('server tile launches both lobby members on the selected server', async t => {
  const { host, guest } = await pair(t);
  host.controller.startFromUi('java', { server: 'example.test:25580' });
  await until(() => host.calls.length === 1 && guest.calls.length === 1, 'both games launched with the leader');
  assert.equal(host.calls[0].opts.server, 'example.test:25580');
  assert.equal(guest.calls[0].opts.server, 'example.test:25580');
  host.emit('partyServer', { server: 'example.test:25580' });
  await until(() => guest.party.state().destination?.plan.server === 'example.test:25580', 'destination confirmed');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(guest.calls.length, 1, 'no second start');
  assert.equal(guest.redirects.length, 0, 'already on that server');
});

test('leader Play without a server starts the friend to the menu, then follows in-game choices', async t => {
  const { host, guest } = await pair(t);
  host.controller.startFromUi('java', {});
  await until(() => guest.calls.length === 1, 'friend game started with the leader');
  assert.equal(guest.calls[0].opts.server, '');
  host.emit('partyServer', { server: 'play.example.test' });
  await until(() => guest.redirects.length === 1, 'friend follows onto the server');
  assert.equal(guest.redirects[0].server, 'play.example.test');
  assert.equal(guest.calls.length, 1);
});

test('world tile starts host and friend together, friend joins through the tunnel', async t => {
  const { host, guest } = await pair(t);
  host.controller.startFromUi('java', { world: 'My World' });
  await until(() => host.calls.length === 1 && guest.calls.length === 1, 'both launched');
  assert.equal(host.calls[0].opts.world, 'My World');
  assert.equal(host.calls[0].opts.partyHost, true);
  assert.equal(guest.calls[0].opts.server, '', 'friend waits in the menu');
  host.emit('partyWorld', { port: 40000 });
  await until(() => guest.messages.some(m => m.type === 'tunnel:join' && m.payload.leaderId), 'friend connects to tunnel');
  await guest.controller.tunnelReady();
  await guest.controller.tunnelReady();
  assert.equal(guest.calls.length, 1);
  assert.equal(guest.redirects.length, 1);
  assert.equal(guest.redirects[0].server, '127.0.0.1:25570');
});

test('lost preparation, ready, start and acknowledgement packets recover without duplicate launch', async t => {
  const { net, host, guest } = await pair(t);
  const dropped = new Set();
  net.drop = m => {
    if (['prep', 'ready', 'start', 'started', 'follow'].includes(m.t) && !dropped.has(m.t)) {
      dropped.add(m.t); return true;
    }
    return false;
  };
  host.controller.startFromUi('java', { server: 'example.test' });
  await until(() => host.calls.length === 1, 'leader launched');
  host.emit('partyServer', { server: 'example.test' });
  await until(() => guest.calls.length === 1, 'lost launch recovered');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(host.calls.length, 1);
  assert.equal(guest.calls.length, 1);
  assert.equal(dropped.size, 5);
});

test('download finishes before launch and plan changes do not alter an active ready check', async t => {
  const { host, guest } = await pair(t, { ready: false });
  host.controller.startFromUi('java', { server: 'original.test' });
  await until(() => guest.calls.length === 1, 'guest download started');
  assert.equal(guest.calls[0].opts.launch, false);
  host.party.setPlan({ ...host.party.state().plan, server: 'changed.test' });
  guest.finish();
  await until(() => host.calls.length === 1, 'leader launched');
  host.emit('partyServer', { server: 'original.test' });
  await until(() => guest.calls.length === 2 && host.calls.length === 1, 'download then launch');
  assert.equal(host.calls[0].opts.server, 'original.test');
  assert.equal(guest.calls[1].opts.server, 'original.test');
});

test('members cannot bypass the leader through a tile, solo launches and verification still work', async t => {
  const { host, guest } = await pair(t);
  assert.throws(() => guest.controller.startFromUi('java', { server: 'example.test' }), /лидер/);
  guest.controller.startFromUi('java', { launch: false });
  assert.equal(guest.calls[0].opts.launch, false);
  host.party.leave();
  host.controller.startFromUi('java', { world: 'Solo World' });
  assert.equal(host.calls[0].opts.world, 'Solo World');
});

test('opening a world inside Minecraft connects friends without a launcher world selection', async t => {
  const { host, guest } = await pair(t);
  host.emit('partyWorld', { port: 40001 });
  await until(() => guest.messages.some(m => m.type === 'tunnel:join' && m.payload.leaderId), 'tunnel requested');
  await guest.controller.tunnelReady();
  assert.equal(guest.calls.length, 1);
  assert.equal(guest.calls[0].opts.server, '127.0.0.1:25570');
  host.emit('partyIdle');
  await until(() => guest.party.state().destination === null, 'old world closed');
  host.emit('partyWorld', { port: 40002 });
  await until(() => guest.party.state().destination?.id === '3', 'next world received');
  await guest.controller.tunnelReady();
  assert.equal(guest.calls.length, 1, 'no second Minecraft process');
  assert.equal(guest.redirects.length, 1, 'running game redirected');
});

test('server changes redirect a running member once, including after lost announcement', async t => {
  const { host, guest, net } = await pair(t);
  host.emit('partyServer', { server: 'first.test' });
  await until(() => guest.calls.length === 1, 'first server');
  let dropped = false;
  net.drop = m => m.t === 'follow' && !dropped && (dropped = true);
  host.emit('partyServer', { server: 'second.test:25566' });
  await until(() => guest.redirects.length === 1, 'second server');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(guest.redirects.length, 1);
  assert.equal(guest.redirects[0].server, 'second.test:25566');
});

test('a member joining an existing world receives the current destination', async t => {
  const { host, net } = await pair(t);
  host.emit('partyWorld', { port: 40001 });
  const late = launcher(net);
  t.after(() => late.party.leave());
  await late.party.join(host.party.state().code, { name: 'Late' });
  await until(() => late.messages.some(m => m.type === 'tunnel:join' && m.payload.leaderId), 'late member tunnels');
  await late.controller.tunnelReady();
  assert.equal(late.calls.length, 1);
});

test('leaving while a world download runs cancels pending automatic entry', async t => {
  const { host, guest } = await pair(t, { ready: false });
  host.emit('partyWorld', { port: 40001 });
  await until(() => guest.calls.length === 1, 'download started');
  guest.party.leave();
  guest.finish();
  await guest.controller.tunnelReady();
  assert.equal(guest.calls.length, 1);
});
