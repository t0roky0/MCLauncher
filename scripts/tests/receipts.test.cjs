// Shop receipts (src/main/receipts.js): what makes a shop item ours. A key of
// the test's own stands in for the server's.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { check, signedText } = require(path.join(__dirname, '../../src/main/receipts.js'));

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const device = 'ab'.repeat(32);
const make = (r, dev = device, key = privateKey) => ({ ...r, sig: crypto.sign(null, Buffer.from(signedText(dev, r)), key).toString('base64') });
const base = { pack: 'angel_pack', items: ['angel_wings', 'halo'], at: '2026-10-10T15:40:00Z' };

test('a receipt the server signed for this launcher gives its items', () => {
  assert.deepEqual(check(make(base), device, pub), ['angel_wings', 'halo']);
});

test('anything else gives nothing', () => {
  assert.equal(check(make(base, 'cd'.repeat(32)), device, pub), null); // another launcher's
  assert.equal(check(make(base, device, crypto.generateKeyPairSync('ed25519').privateKey), device, pub), null); // not the server's key
  assert.equal(check({ ...make(base), items: ['angel_wings', 'halo', 'witch_hat'] }, device, pub), null); // more items written in
  assert.equal(check({ ...make(base), pack: 'other' }, device, pub), null);
  assert.equal(check({ ...base, sig: '' }, device, pub), null);
  assert.equal(check(null, device, pub), null);
  assert.equal(check({ pack: 1 }, device, pub), null);
});

test('the server\'s real key is in place', () => {
  // a receipt from the live server (redeem.py, 10.10.2026), for a test device
  assert.equal(check({ pack: 'x', items: [], at: '', sig: 'AA==' }, device), null); // doesn't throw with the built-in key
});

