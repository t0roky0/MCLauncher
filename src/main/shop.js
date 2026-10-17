'use strict';
// The shop: packs of cosmetics for coins (assets/cosmetics/shop.json). Coins
// and purchases are our server's (server/redeem.py, op wallet / buy over the
// same MQTT as the activation codes): it says how many coins this launcher
// has, takes them for a pack and signs a receipt (receipts.js), and
// cosmetics.js owns the pack's items with it. Coins come only from there.
//
// Money: YooKassa, through our server (it alone has the shop's keys). pay()
// asks it for a payment, the payment page opens in the browser, and the
// server is asked how it went until it's paid (the coins are there then) or
// given up — 'paid' for the window either way. No keys on the server yet:
// no coin packs offered, and the window says payments aren't set up.

const fs = require('fs');
const { shell } = require('electron');
const paths = require('./paths');
const log = require('./log');
const relay = require('./relay-server');
const cosmetics = require('./cosmetics');
const { ask } = require('./redeem');

let coins = null; // the server's last word (null: not heard yet)
let online = false;
let products = []; // what's sold for money: [{id, rub, coins}] (none: payments not set up)
const paidListeners = new Set();

function catalogue() {
  try {
    return JSON.parse(fs.readFileSync(paths.asset('cosmetics', 'shop.json'), 'utf8'));
  } catch (e) {
    log.warn(`Shop: ${e.message}`);
    return [];
  }
}

function state() {
  const items = new Map(cosmetics.view().items.map((i) => [i.id, i]));
  const packs = catalogue().map((p) => ({
    ...p,
    owned: p.items.every((id) => items.get(id) && items.get(id).owned),
    items: p.items.map((id) => items.get(id)).filter(Boolean).map((i) => ({ id: i.id, name: i.name, nameEn: i.nameEn, slot: i.slot, rarity: i.rarity })),
  }));
  return { coins, online, packs, products: products.filter((p) => p.coins > 0) };
}

// One request, through whichever of the server's addresses answers — the
// account's: with its session (account-session.js); none to be had: offline.
async function call(body) {
  const sessions = require('./account-session');
  const acc = require('./auth').activeAccount();
  let session = null;
  if (sessions.keyOf(acc)) {
    const s = await sessions.forAccount(acc);
    if (!s) return null;
    session = s.session;
  }
  for (const url of relay.SECURE_URLS) {
    try {
      return await ask(url, { ...body, device: cosmetics.deviceKey(), ...(session ? { session } : {}) });
    } catch (e) {
      log.info(`Shop: ${url}: ${e.message}`);
    }
  }
  return null;
}

// what the server says about this launcher, kept
function apply(res) {
  coins = res.coins;
  products = Array.isArray(res.products) ? res.products : [];
  cosmetics.setReceipts(res.receipts);
}

// The coins and what's bought, from the server (the shop page opening).
async function refresh() {
  const res = await call({ op: 'wallet' });
  online = !!(res && res.ok);
  if (online) apply(res);
  return state();
}

// → {ok: true, state} or {ok: false, error: funds | owned | unknown | offline, state}
async function buy(packId) {
  const pack = catalogue().find((p) => p.id === packId);
  if (!pack) return { ok: false, error: 'unknown', state: state() };
  const res = await call({ op: 'buy', pack: packId });
  if (!res) {
    online = false;
    return { ok: false, error: 'offline', state: state() };
  }
  online = true;
  if (!res.ok) {
    if (Number.isFinite(res.coins)) coins = res.coins;
    log.info(`Shop: ${packId} refused (${res.error}).`);
    return { ok: false, error: String(res.error || 'unknown'), state: state() };
  }
  coins = res.coins;
  // just bought: on at once
  cosmetics.setReceipts(res.receipts, res.again ? [] : pack.items);
  log.info(`Shop: ${packId} bought${res.again ? ' (again)' : ''}, ${coins} coins left.`);
  return { ok: true, again: !!res.again, state: state() };
}

// → {ok: true} (the payment page is open in the browser) or {ok: false,
// error: unavailable (no keys on the server yet) | unknown | provider | offline}
async function pay(productId) {
  const res = await call({ op: 'pay', product: productId });
  if (!res) return { ok: false, error: 'offline' };
  if (!res.ok) {
    log.info(`Shop: payment for ${productId} refused (${res.error}).`);
    return { ok: false, error: String(res.error || 'provider') };
  }
  // only a payment page on the web (YooKassa's): nothing else is opened, whatever came back
  let page;
  try {
    page = new URL(String(res.url || ''));
  } catch {
    page = null;
  }
  if (!page || page.protocol !== 'https:' || !/(^|\.)(yookassa\.ru|yoomoney\.ru)$/i.test(page.hostname)) {
    log.warn('Shop: the payment page is not on YooKassa — not opened.');
    return { ok: false, error: 'provider' };
  }
  log.info(`Shop: payment ${res.payment} for ${productId} — its page opened.`);
  await shell.openExternal(page.href);
  watchPayment(res.payment, productId);
  return { ok: true };
}

// How a payment went, asked every few seconds for half an hour.
function watchPayment(id, productId) {
  const started = Date.now();
  const tell = (p) => {
    for (const fn of paidListeners) {
      try {
        fn(p);
      } catch {
        /* a listener's problem */
      }
    }
  };
  const tick = async () => {
    const res = await call({ op: 'payment', payment: id }).catch(() => null);
    if (res && res.ok) {
      if (res.status === 'succeeded') {
        apply(res);
        log.info(`Shop: payment ${id} paid (${productId}).`);
        tell({ ok: true, product: productId, coins, state: state() });
        return;
      }
      if (res.status === 'canceled' || res.status === 'expired') {
        log.info(`Shop: payment ${id} ${res.status}.`);
        tell({ ok: false, product: productId, status: res.status });
        return;
      }
    }
    if (Date.now() - started < 30 * 60 * 1000) setTimeout(tick, 5000);
  };
  setTimeout(tick, 5000);
}

// At the launcher's start and every few hours: what's bought and the coins fresh.
let timer = null;
function start() {
  if (timer) return;
  refresh().catch(() => {});
  timer = setInterval(() => refresh().catch(() => {}), 3 * 60 * 60 * 1000);
  timer.unref();
}

module.exports = {
  state,
  refresh,
  buy,
  pay,
  start,
  // fn({ok, product, coins, state} | {ok: false, product, status}) when a payment ends
  onPaid(fn) {
    paidListeners.add(fn);
    return () => paidListeners.delete(fn);
  },
};
