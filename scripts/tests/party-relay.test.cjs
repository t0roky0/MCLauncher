const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// 64x64 PNG header is all textureUrl checks; the rest only has to be base64.
function skinUrl(seed) {
  const png = Buffer.alloc(64);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(png);
  png.writeUInt32BE(64, 16);
  png.writeUInt32BE(64, 20);
  png.write(seed, 33);
  return `data:image/png;base64,${png.toString('base64')}`;
}

// Public relays by host name; each launcher reaches only some of them.
function relays() {
  const brokers = new Map();
  const published = [];
  function mqttFor(reach) {
    return {
      MqttClient: class {
        constructor(url, { onMessage }) { this.host = new URL(url).hostname; this.onMessage = onMessage; }
        connect() {
          if (!reach.includes(this.host)) return Promise.reject(new Error('unreachable'));
          if (!brokers.has(this.host)) brokers.set(this.host, new Set());
          brokers.get(this.host).add(this);
          return Promise.resolve(this);
        }
        subscribe(topic) { this.topic = topic; }
        publish(topic, payload) {
          published.push(Buffer.from(payload));
          for (const c of brokers.get(this.host) || []) if (c !== this && c.topic === topic) setImmediate(() => c.onMessage(topic, payload));
        }
        close() { brokers.get(this.host)?.delete(this); }
      },
    };
  }
  return { mqttFor, published };
}

function launcher(mqtt) {
  const module = { exports: {} };
  const timer = fn => (...args) => { const t = fn(...args); t.unref?.(); return t; };
  const deps = { './config': { get: () => ({ partyRelay: '', language: 'ru' }) }, './mqtt': mqtt, './log': { info() {}, warn() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/main/party.js'), 'utf8'), {
    module, exports: module.exports, Buffer, URL, console,
    require: id => deps[id] || require(id.startsWith('.') ? path.join(__dirname, '../../src/main', id) : id),
    setTimeout: timer(setTimeout), clearTimeout, clearInterval,
    setInterval: (fn, ms) => timer(setInterval)(fn, ms === 8000 ? 80 : ms),
  });
  const party = module.exports;
  const chat = [];
  party.onEvent((type, p) => { if (type === 'chat') chat.push(p); });
  return { party, chat };
}

async function until(fn, message, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('members on relays with nothing in common meet through the leader', async t => {
  const net = relays();
  const host = launcher(net.mqttFor(['broker.emqx.io', 'public.cloud.shiftr.io']));
  const a = launcher(net.mqttFor(['broker.emqx.io']));
  const b = launcher(net.mqttFor(['public.cloud.shiftr.io']));
  t.after(() => { a.party.leave(); b.party.leave(); host.party.leave(); });
  const { code } = await host.party.create({ name: 'Host' });
  await a.party.join(code, { name: 'Alex', skin: skinUrl('alex') });
  await b.party.join(code, { name: 'Bea', skin: skinUrl('bea'), model: 'slim' });
  await until(() => [host, a, b].every(x => x.party.state().members.length === 3), 'everyone sees three members');
  // a skin crosses from one relay to the other through the leader
  await until(() => b.party.state().members.find(m => m.name === 'Alex')?.skin === skinUrl('alex'), 'Bea gets Alex\'s skin');
  await until(() => a.party.state().members.find(m => m.name === 'Bea')?.skin === skinUrl('bea'), 'Alex gets Bea\'s skin');
  assert.equal(a.party.state().members.find(m => m.name === 'Bea').model, 'slim');
  a.party.say({ text: 'привет' });
  await until(() => b.chat.some(m => m.text === 'привет'), 'chat crosses relays');
});

test('heartbeats carry no skins; a changed skin goes out once as a card', async t => {
  const net = relays();
  const host = launcher(net.mqttFor(['broker.emqx.io']));
  const guest = launcher(net.mqttFor(['broker.emqx.io']));
  t.after(() => { guest.party.leave(); host.party.leave(); });
  const { code } = await host.party.create({ name: 'Host', skin: skinUrl('host') });
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(host.party.normalize(code)), Buffer.from('mclauncher-party'), Buffer.from('key'), 32));
  await guest.party.join(code, { name: 'Guest', skin: skinUrl('guest') });
  await until(() => host.party.state().members.find(m => m.name === 'Guest')?.skin === skinUrl('guest'), 'card arrived');
  await new Promise(resolve => setTimeout(resolve, 300)); // several heartbeats
  const packets = () => net.published.map(p => host.party.open(key, p)).filter(Boolean);
  for (const p of packets()) {
    if (p.t === 'hi') assert.equal(p.skin, undefined, 'hello without a skin');
    if (p.t === 'roster') for (const m of p.members) assert.equal(m.skin, undefined, 'roster without skins');
  }
  const before = packets().filter(p => p.t === 'card' && p.id === guest.party.selfId()).length;
  guest.party.updateMe({ skin: skinUrl('new') });
  await until(() => host.party.state().members.find(m => m.name === 'Guest')?.skin === skinUrl('new'), 'new skin arrived');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(packets().filter(p => p.t === 'card' && p.id === guest.party.selfId()).length - before, 1);
});
