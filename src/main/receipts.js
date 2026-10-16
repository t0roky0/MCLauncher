'use strict';
// Shop receipts: what our server (server/redeem.py, the shop) signs when a
// launcher buys a pack — its device key, the pack, the items, when. A shop
// item is ours only with a receipt for this launcher that checks out against
// the server's key: editing cosmetics.json gives nothing.

const crypto = require('crypto');

// the server's receipts key (redeem.py receipt-key)
const SERVER_KEY = 'MCowBQYDK2VwAyEAneZ/PHDtk+bvtdi7s9M/GgBYs0flMF6XRe5QOba3/ko=';

const signedText = (device, r) => `mcl-receipt:1:${device}:${r.pack}:${r.items.join(',')}:${r.at}`;

const verify = (text, sig, key) => {
  try {
    const pub = crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(text), pub, Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
};

// → the items it gives, or null
function check(receipt, device, key = SERVER_KEY) {
  const r = receipt;
  if (!r || typeof r.pack !== 'string' || typeof r.at !== 'string' || typeof r.sig !== 'string' || !Array.isArray(r.items) || !r.items.every((i) => typeof i === 'string')) return null;
  return verify(signedText(device, r), r.sig, key) ? r.items.slice() : null;
}

module.exports = { check, signedText };
