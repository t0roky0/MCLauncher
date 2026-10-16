// Kicking from a party and friends' open lobbies, with several launchers in
// one process talking through an in-memory relay instead of a public one.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = (f) => fs.readFileSync(path.join(__dirname, '../../src/main', f), 'utf8');
const PARTY = SRC('party.js');
const LOBBIES = SRC('friend-lobbies.js');

// one relay, shared by everyone in a test
function relay() {
  const clients = new Set();
  class MqttClient {
    constructor(url, {onMessage} = {}) { this.onMessage = onMessage; this.subs = new Set(); }
    connect() { clients.add(this); return Promise.resolve(this); }
    subscribe(t) { this.subs.add(t); }
    unsubscribe(t) { this.subs.delete(t); }
    publish(topic, payload) {
      const buf = Buffer.from(payload);
      for (const c of clients) if (c.subs.has(topic)) setImmediate(() => c.onMessage(topic, buf));
    }
    close() { clients.delete(this); }
  }
  return {MqttClient};
}

// timers that don't keep the test process alive
const unref = (fn) => (...a) => { const t = fn(...a); if (t && t.unref) t.unref(); return t; };

function load(src, deps) {
  const module = {exports: {}};
  vm.runInNewContext(src, {
    module, exports: module.exports, require: (id) => deps[id] || require(id.startsWith('.') ? path.join(__dirname, '../../src/main', id) : id), Buffer, console, URL,
    setTimeout: unref(setTimeout), setInterval: unref(setInterval), clearTimeout, clearInterval,
  });
  return module.exports;
}

const log = {info() {}, warn() {}};

function launcher(net, {xuid = '', friends = [], partyFriends = true} = {}) {
  const cfg = {partyRelay: 'mem://relay', partyFriends};
  const cfgListeners = new Set();
  const config = {get: () => cfg, onChange(fn) { cfgListeners.add(fn); }};
  const party = load(PARTY, {'./mqtt': net, './config': config, './log': log});
  const friendState = {status: 'ok', me: xuid ? {xuid} : null, friends: friends.map(([x, gamertag]) => ({xuid: x, gamertag}))};
  const friendsMod = {getState: () => friendState, onChange() {}};
  const lobbies = load(LOBBIES, {'./mqtt': net, './config': config, './log': log, './party': party, './friends': friendsMod});
  const events = [];
  party.onEvent((type, p) => type === 'ended' && events.push(p.reason));
  const opened = [];
  lobbies.onEvent((type, p) => type === 'opened' && opened.push(p));
  return {
    party, lobbies, events, opened,
    setPartyFriends(v) { cfg.partyFriends = v; for (const fn of cfgListeners) fn(); },
  };
}

async function until(fn, what, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out: ${what}`);
}

// (arrays made in the modules' own context: copied over for deepEqual)
const names = (p) => Array.from(p.state().members, (m) => m.name).sort();

test('the leader kicks a member: gone for everyone, told why, turned away on return', async () => {
  const net = relay();
  const A = launcher(net), B = launcher(net), C = launcher(net);
  const {code} = await A.party.create({name: 'Leader', xuid: '100'});
  await B.party.join(code, {name: 'Bob', xuid: '200'});
  await C.party.join(code, {name: 'Cat', xuid: '300'});
  await until(() => A.party.state().members.length === 3 && C.party.state().members.length === 3 && B.party.state().members.length === 3, 'all three in');

  const bob = A.party.state().members.find((m) => m.name === 'Bob');
  assert.throws(() => C.party.kick(A.party.state().members[0].id), /лидер/);
  A.party.kick(bob.id);
  assert.deepEqual(names(A.party), ['Cat', 'Leader']);
  await until(() => B.events.includes('kicked') && !B.party.state().active, 'Bob told and out');
  await until(() => names(C.party).join() === 'Cat,Leader', 'Cat sees Bob gone');

  // back with the code (a new launcher id, the same Xbox id): turned away
  B.events.length = 0;
  await B.party.join(code, {name: 'Bob', xuid: '200'});
  await until(() => B.events.includes('kicked'), 'Bob turned away again');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(names(A.party), ['Cat', 'Leader']);
  assert.deepEqual(names(C.party), ['Cat', 'Leader']);
  for (const l of [A, B, C]) l.party.leave({quiet: true});
});

test("an Xbox friend sees the open lobby, joins it without a code, and sees it close", async () => {
  const net = relay();
  const A = launcher(net, {xuid: '100', friends: [['200', 'Bob']]});
  const B = launcher(net, {xuid: '200', friends: [['100', 'LeaderTag'], ['900', 'Stranger']]});
  A.lobbies.init();
  B.lobbies.init();
  await A.party.create({name: 'Leader'});
  await until(() => B.lobbies.list().length === 1, 'Bob sees the lobby');
  const seen = B.lobbies.list()[0];
  assert.equal(seen.xuid, '100');
  assert.equal(seen.gamertag, 'LeaderTag');
  assert.equal(seen.count, 1);
  assert.equal(seen.joined, false);
  assert.equal(B.opened.length, 1);
  assert.ok(!('code' in seen), 'the code stays in the main process');

  await B.lobbies.join('100', {name: 'Bob', xuid: '200'});
  await until(() => A.party.state().members.length === 2, 'Bob in the party');
  await until(() => B.lobbies.list()[0]?.joined && B.lobbies.list()[0].count === 2, 'Bob sees he is in it');
  assert.throws(() => B.lobbies.join('900', {name: 'Bob'}), /закрыто/);

  // a friend who starts listening later gets it at once (asks), not on the next beat
  const C = launcher(net, {xuid: '300', friends: [['100', 'LeaderTag']]});
  C.lobbies.init();
  await until(() => C.lobbies.list().length === 1, 'late friend sees it', 1500);

  A.party.leave();
  await until(() => B.lobbies.list().length === 0 && C.lobbies.list().length === 0, 'lobby closed for friends');
  B.party.leave({quiet: true});
});

test('with "friends see the lobby" off, nothing is announced', async () => {
  const net = relay();
  const A = launcher(net, {xuid: '100', friends: [['200', 'Bob']], partyFriends: false});
  const B = launcher(net, {xuid: '200', friends: [['100', 'LeaderTag']]});
  A.lobbies.init();
  B.lobbies.init();
  await A.party.create({name: 'Leader'});
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(B.lobbies.list().length, 0);
  // switched on mid-party: friends see it; off again: it closes
  A.setPartyFriends(true);
  await until(() => B.lobbies.list().length === 1, 'shown once switched on');
  A.setPartyFriends(false);
  await until(() => B.lobbies.list().length === 0, 'hidden once switched off');
  A.party.leave({quiet: true});
});
