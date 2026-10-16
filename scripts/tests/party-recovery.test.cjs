const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

test('one lost redundant relay stays quiet; total loss and recovery notify once', async () => {
  const clients = [], timers = new Map(), events = [];
  let timerId = 0;
  class MqttClient {
    constructor(url, options) { this.options = options; clients.push(this); }
    async connect() {} subscribe() { this.subscribed = true; }
    publish() {} close() {}
  }
  const deps = { './mqtt': { MqttClient }, './config': { get: () => ({}) }, './log': { info() {}, warn() {} } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/main/party.js'), 'utf8'), {
    module, exports: module.exports, require: id => deps[id] || require(id.startsWith('.') ? path.join(__dirname, '../../src/main', id) : id), Buffer, URL,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 1, clearInterval() {},
  });
  const party = module.exports;
  party.onEvent((type, payload) => { if (type === 'connection') events.push(payload.connected); });
  try {
    await party.create({ name: 'Host' });
    const winners = clients.filter(c => c.subscribed);
    assert.ok(winners.length > 1);
    winners[0].options.onClose();
    assert.deepEqual(events, []);
    for (const c of winners.slice(1)) c.options.onClose();
    assert.deepEqual(events, [false]);
    assert.equal(party.state().reconnecting, true);
    const retries = [...timers.values()].filter(t => t.ms === 3000);
    for (const retry of retries) await retry.fn();
    assert.deepEqual(events, [false, true]);
    assert.equal(party.state().connected, true);
    assert.equal(party.state().reconnecting, false);
  } finally { party.leave(); }
});
