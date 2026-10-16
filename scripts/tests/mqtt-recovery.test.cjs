const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');

function fixture() {
  let socket, tick, closes = 0;
  class WebSocket {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; socket = this; }
    send(bytes) { this.sent.push(bytes); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/main/mqtt.js'), 'utf8'), {
    module, exports: module.exports, require, URL, Buffer, WebSocket, setTimeout, clearTimeout,
    setInterval: fn => { tick = fn; return 1; }, clearInterval() {},
  });
  const client = new module.exports.MqttClient('wss://public:public@example.test', { onClose: () => closes++ });
  return { client, socket: () => socket, tick: () => tick(), closes: () => closes };
}

test('WSS credentials use MQTT CONNECT and missing PINGRESP closes a dead link', async () => {
  const f = fixture(), connected = f.client.connect();
  f.socket().onopen();
  assert.equal(f.socket().url, 'wss://example.test/');
  assert.ok(f.socket().sent[0].includes(Buffer.from('public')));
  f.socket().onmessage({ data: Buffer.from([0x20, 2, 0, 0]) }); await connected;
  f.tick(); assert.equal(f.closes(), 0);
  f.socket().onmessage({ data: Buffer.from([0xd0, 0]) });
  f.tick(); assert.equal(f.closes(), 0);
  f.tick(); assert.equal(f.closes(), 1);
  f.client.close();
});
