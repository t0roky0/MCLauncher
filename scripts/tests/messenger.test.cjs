'use strict';
// Messages between friends' launchers (src/main/messenger.js): two launchers
// on an in-memory relay that, like the real four, hands every packet over
// twice.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../src/main/messenger.js'), 'utf8');

// party.seal / party.open, as they are
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
    return null;
  }
}

function bus() {
  const watchers = new Map(); // topic → Set of fn
  return {
    watchers,
    post(topic, packet) {
      for (let copy = 0; copy < 2; copy++) {
        for (const fn of [...(watchers.get(topic) || [])]) setImmediate(() => fn(Buffer.from(packet)));
      }
      return true;
    },
  };
}

// one launcher signed in as `xuid`, with `friendList` on its Xbox list
function launcher(t, net, xuid, friendList) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-dm-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const relayFns = new Set();
  const mine = new Map();
  const relay = {
    watch(topic, fn) {
      mine.set(topic, fn);
      if (!net.watchers.has(topic)) net.watchers.set(topic, new Set());
      net.watchers.get(topic).add(fn);
    },
    unwatch(topic) {
      const fn = mine.get(topic);
      mine.delete(topic);
      if (fn && net.watchers.has(topic)) net.watchers.get(topic).delete(fn);
    },
    post: (topic, packet) => net.post(topic, packet),
    isUp: () => true,
    onEvent: (fn) => relayFns.add(fn),
  };
  const state = { me: { xuid }, friends: friendList.map((x) => ({ xuid: x, gamertag: `P${x}`, avatar: '', state: 'online' })) };
  const friends = { getState: () => state, onChange() {} };
  const timers = {
    setTimeout: (fn, ms) => {
      const h = setTimeout(fn, ms);
      h.unref();
      return h;
    },
    clearTimeout,
  };
  const deps = {
    electron: { safeStorage: { isEncryptionAvailable: () => false } },
    './friends': friends,
    './friend-lobbies': relay,
    './party': { seal, open },
    './paths': { appDir: dir },
    './log': { info() {}, warn() {} },
  };
  const module = { exports: {} };
  vm.runInNewContext(SOURCE, { module, exports: module.exports, require: (id) => deps[id] || require(id), Buffer, console, ...timers });
  const api = module.exports;
  const events = [];
  api.onEvent((type, payload) => events.push({ type, payload }));
  return {
    api,
    events,
    xuid,
    dir,
    start() {
      api.init();
      for (const fn of relayFns) fn('relayUp');
    },
    stop() {
      for (const topic of [...mine.keys()]) relay.unwatch(topic);
    },
    msgs: (other) => api.conversation(other).msgs,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 120));

test('two launchers meet, a message is delivered once and then read', async (t) => {
  const net = bus();
  const a = launcher(t, net, '1001', ['2002']);
  const b = launcher(t, net, '2002', ['1001']);
  a.start();
  b.start();
  await settle();
  assert.equal(a.api.conversation('2002').launcher, true);
  assert.equal(b.api.conversation('1001').launcher, true);

  a.api.send('2002', { text: 'привет' });
  await settle();
  const got = b.msgs('1001');
  assert.equal(got.length, 1, 'every packet came twice, one message is kept');
  assert.equal(got[0].text, 'привет');
  assert.equal(b.events.filter((e) => e.type === 'message').length, 1);
  assert.equal(b.api.summary().unread, 1);
  assert.equal(a.msgs('2002')[0].state, 'delivered');

  b.api.setFocus(true);
  b.api.setOpen('1001');
  await settle();
  assert.equal(b.api.summary().unread, 0);
  assert.equal(a.msgs('2002')[0].state, 'read');

  // stickers travel too; nonsense ones don't
  b.api.send('1001', { sticker: 'creeper' });
  await settle();
  assert.equal(a.msgs('2002').at(-1).sticker, 'creeper');
  assert.throws(() => b.api.send('1001', { text: '   ' }));
});

test('a message to a closed launcher waits and goes out when it opens', async (t) => {
  const net = bus();
  const a = launcher(t, net, '1001', ['2002']);
  a.start();
  await settle();
  a.api.send('2002', { text: 'ты где?' });
  await settle();
  assert.equal(a.msgs('2002')[0].state, 'waiting');

  const b = launcher(t, net, '2002', ['1001']);
  b.start();
  await settle();
  assert.equal(b.msgs('1001').length, 1);
  assert.equal(b.msgs('1001')[0].text, 'ты где?');
  assert.equal(a.msgs('2002')[0].state, 'delivered');
});

test('a new key is noted, gets nothing and is marked until trusted', async (t) => {
  const net = bus();
  const a = launcher(t, net, '1001', ['2002']);
  const b = launcher(t, net, '2002', ['1001']);
  a.start();
  b.start();
  await settle();
  b.stop();

  // the friend's launcher reinstalled (or someone posing as them): another key
  const b2 = launcher(t, net, '2002', ['1001']);
  b2.start();
  await settle();
  const conv = a.api.conversation('2002');
  assert.equal(conv.pending, true);
  assert.equal(conv.msgs.filter((m) => m.sys === 'newKey').length, 1);

  a.api.send('2002', { text: 'секрет' });
  await settle();
  assert.equal(b2.msgs('1001').length, 0, 'nothing goes out to a key not trusted');

  b2.api.send('1001', { text: 'это я, новый ПК' });
  await settle();
  const fromB2 = a.msgs('2002').find((m) => m.text === 'это я, новый ПК');
  assert.ok(fromB2 && fromB2.unverified, 'what the new key says is marked');

  a.api.trust('2002');
  await settle();
  assert.equal(a.api.conversation('2002').pending, false);
  assert.ok(!a.msgs('2002').some((m) => m.unverified));
  assert.ok(b2.msgs('1001').some((m) => m.text === 'секрет'), 'the waiting message goes out once trusted');
});

test('someone off the friends list is not heard', async (t) => {
  const net = bus();
  const a = launcher(t, net, '1001', ['2002']);
  const stranger = launcher(t, net, '3003', ['1001']);
  a.start();
  stranger.start();
  await settle();
  assert.throws(() => a.api.send('3003', { text: 'hi' }));
  stranger.api.send('1001', { text: 'кликни сюда' });
  await settle();
  assert.equal(a.msgs('3003').length, 0);
  assert.equal(a.events.filter((e) => e.type === 'message').length, 0);
});

test('history and keys survive a restart', async (t) => {
  const net = bus();
  const a = launcher(t, net, '1001', ['2002']);
  const b = launcher(t, net, '2002', ['1001']);
  a.start();
  b.start();
  await settle();
  a.api.send('2002', { text: 'запомни' });
  await settle();
  a.api.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(a.dir, 'messages.json'), 'utf8'));
  assert.ok(saved.ids['1001'].pub);
  assert.equal(saved.chats['1001']['2002'].msgs[0].text, 'запомни');
  assert.ok(!JSON.stringify(saved).includes('PRIVATE'), 'no PEM lying around');
});
