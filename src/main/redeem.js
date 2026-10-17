'use strict';
// Activation codes (Settings): "MCL-XXXX-XXXX-XXXX", checked and spent on our
// own server (server/redeem.py) over its MQTT — each code works once, ever,
// and a launcher takes one code per reward. What a code gives comes back from
// the server; cosmetics.js hands it out. A shop pack's code comes with the
// pack's receipt, the same as a purchase (a shop item is worn only with one).

const crypto = require('crypto');
const { MqttClient } = require('./mqtt');
const relay = require('./relay-server');
const cosmetics = require('./cosmetics');
const log = require('./log');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O, U: nothing to misread
const VERSION = 2; // what this launcher understands: 2 — packs' codes (receipts)

// However it was typed (lower case, spaces, dashes, O for 0, I or L for 1,
// with or without "MCL") → its 12 characters, or '' if it can't be a code.
function normalize(text) {
  let s = String(text || '').toUpperCase().replace(/[\s\-_.]/g, '');
  if (s.length === 15 && s.startsWith('MCL')) s = s.slice(3);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  return s.length === 12 && [...s].every((ch) => ALPHABET.includes(ch)) ? s : '';
}

// One question to the server through one of its addresses.
function ask(url, body, timeout = 9000) {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomBytes(8).toString('hex');
    let done = false;
    const client = new MqttClient(url, {
      clientId: `mclr-${crypto.randomBytes(6).toString('hex')}`,
      onMessage: (topic, payload) => {
        let res;
        try {
          res = JSON.parse(payload.toString('utf8'));
        } catch {
          return;
        }
        if (res && res.nonce === nonce) finish(null, res);
      },
    });
    const timer = setTimeout(() => finish(new Error('no answer')), timeout);
    function finish(err, res) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.close();
      if (err) reject(err);
      else resolve(res);
    }
    client.connect(Math.min(6000, timeout)).then(() => {
      // the broker takes them in order: subscribed before the answer can come
      client.subscribe(`rd/res/${client.clientId}`);
      client.publish('rd/req', JSON.stringify({ id: client.clientId, nonce, ...body }));
    }, (e) => finish(e));
  });
}

// → {ok: true, reward, title, items: [{id, name, nameEn}]} or {ok: false, error}
// (format, unknown, used, device, limit, update, offline).
async function redeem(text) {
  const code = normalize(text);
  if (!code) return { ok: false, error: 'format' };
  // the account's code (its session), else this launcher's
  const sessions = require('./account-session');
  const acc = require('./auth').activeAccount();
  let session = null;
  if (sessions.keyOf(acc)) {
    const s = await sessions.forAccount(acc);
    if (!s) return { ok: false, error: 'offline' };
    session = s.session;
  }
  const body = { code, device: cosmetics.deviceKey(), v: VERSION, ...(session ? { session } : {}) };
  for (const url of relay.SECURE_URLS) {
    let res;
    try {
      res = await ask(url, body);
    } catch (e) {
      log.info(`Codes: ${url}: ${e.message}`);
      continue; // a spent code asked again from here answers yes again
    }
    if (!res.ok) {
      log.info(`Codes: refused (${res.error}).`);
      return { ok: false, error: String(res.error || 'unknown') };
    }
    // a pack: its receipt first (on at once, the first time), then it's owned like any
    if (Array.isArray(res.receipts)) cosmetics.setReceipts(res.receipts, res.again ? [] : res.items || []);
    const items = cosmetics.grantSet({ event: res.event, items: res.items, reward: res.reward });
    log.info(`Codes: ${res.reward}${res.again ? ' (again)' : ''}, ${items.length} item(s).`);
    return { ok: true, reward: res.reward, title: res.title || null, items };
  }
  return { ok: false, error: 'offline' };
}

module.exports = { redeem, normalize, ask };
