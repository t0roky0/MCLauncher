const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// redeem.js with a pretend broker: `answer(url, request)` → the server's
// reply (or null: that address doesn't connect).
function load(answer, account = null) {
  const granted = [];
  const sent = [];
  class MqttClient {
    constructor(url, { clientId, onMessage }) {
      Object.assign(this, { url, clientId, onMessage, subs: [] });
    }
    async connect() {
      if (answer(this.url, null) === null) throw new Error('connection failed');
      return this;
    }
    subscribe(t) { this.subs.push(t); }
    publish(topic, payload) {
      const req = JSON.parse(payload);
      sent.push({ url: this.url, topic, req });
      const res = answer(this.url, req);
      if (res && this.subs.includes(`rd/res/${req.id}`)) setImmediate(() => this.onMessage(`rd/res/${req.id}`, Buffer.from(JSON.stringify({ ...res, nonce: req.nonce }))));
    }
    close() {}
  }
  const deps = {
    './mqtt': { MqttClient },
    './relay-server': { MQTT_URLS: ['mqtts://relay:443', 'mqtts://relay:8883', 'mqtt://relay:1883'], SECURE_URLS: ['mqtts://relay:443', 'mqtts://relay:8883'] },
    './cosmetics': { deviceKey: () => 'd'.repeat(64), grantSet: (r) => { granted.push(r); return [{ id: 'witch_hat', name: 'Шляпа ведьмы', nameEn: 'Witch hat' }]; } },
    './log': { info() {}, warn() {} },
    // the account signed in: none (the launcher's own key), or one with its session
    './auth': { activeAccount: () => account },
    './account-session': { keyOf: (acc) => (acc ? `x:${acc.xuid}` : null), forAccount: async (acc) => (acc && acc.session ? { session: acc.session } : null) },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/main/redeem.js'), 'utf8'), {
    module, exports: module.exports, require: (id) => deps[id] || require(id), JSON, Buffer, Promise, setTimeout, clearTimeout, setImmediate, String, Math, Array, Error,
  });
  return { r: module.exports, granted, sent };
}

test('a code typed any way is read the same; anything else is not a code', () => {
  const { r } = load(() => null);
  assert.equal(r.normalize('MCL-AB12-CD34-EF56'), 'AB12CD34EF56');
  assert.equal(r.normalize(' mcl ab12 cd34 ef56 '), 'AB12CD34EF56');
  assert.equal(r.normalize('AB12CD34EF56'), 'AB12CD34EF56');
  assert.equal(r.normalize('ABl2CD34EFO6'), 'AB12CD34EF06'); // l → 1, O → 0
  assert.equal(r.normalize('MCL-AB12-CD34'), '');
  assert.equal(r.normalize('MCL-AB12-CD34-EFU6'), ''); // U is never in a code
});

test('a good code: the reward goes to cosmetics, the device key goes along', async () => {
  const { r, granted, sent } = load((url, req) => (req ? { ok: true, reward: 'halloween', event: 'halloween', title: { ru: 'Хэллоуинский набор', en: 'Halloween set' } } : {}));
  const res = await r.redeem('mcl-ab12-cd34-ef56');
  assert.equal(res.ok, true);
  assert.equal(res.title.en, 'Halloween set');
  assert.equal(granted[0].event, 'halloween');
  assert.equal(sent[0].topic, 'rd/req');
  assert.equal(sent[0].req.code, 'AB12CD34EF56');
  assert.equal(sent[0].req.device.length, 64);
});

test('the server says no: its reason, nothing granted, no other address tried', async () => {
  const { r, granted, sent } = load((url, req) => (req ? { ok: false, error: 'used' } : {}));
  assert.equal(JSON.stringify(await r.redeem('AB12CD34EF56')), '{"ok":false,"error":"used"}');
  assert.equal(granted.length, 0);
  assert.equal(sent.length, 1);
});

test('an address that does not connect: the next one; none at all: offline', async () => {
  const one = load((url, req) => (url.endsWith(':443') ? null : req ? { ok: true, reward: 'halloween', event: 'halloween' } : {}));
  assert.equal((await one.r.redeem('AB12CD34EF56')).ok, true);
  assert.equal(one.sent[0].url, 'mqtts://relay:8883');
  const none = load(() => null);
  assert.equal(JSON.stringify(await none.r.redeem('AB12CD34EF56')), '{"ok":false,"error":"offline"}');
  assert.equal(JSON.stringify(await none.r.redeem('nonsense')), '{"ok":false,"error":"format"}');
});

test("an account's code goes with its session; no session to be had: offline, nothing sent", async () => {
  const session = { xuid: '2535400000000001', exp: 9999999999, sig: 'x' };
  const { r, sent } = load((url, req) => (req ? { ok: true, reward: 'halloween', event: 'halloween' } : {}), { id: 'xbox:1', xuid: '2535400000000001', session });
  const res = await r.redeem('MCL-AB12-CD34-EF56');
  assert.equal(res.ok, true);
  assert.deepEqual(sent[0].req.session, session);
  const none = load(() => ({}), { id: 'xbox:2', xuid: '2535400000000002' });
  assert.deepEqual(JSON.parse(JSON.stringify(await none.r.redeem('MCL-AB12-CD34-EF56'))), { ok: false, error: 'offline' });
  assert.equal(none.sent.length, 0);
});
