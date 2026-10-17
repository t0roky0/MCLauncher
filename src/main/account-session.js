'use strict';
// The account's session with our server (server/redeem.py, op login): the
// Xbox Live token of the account signed in goes to our server (over TLS
// only, never the plain port), which asks Xbox whose it is and answers with
// a session of its own (30 days, signed with its key). The shop and the
// codes send it along: coins, purchases and codes are that account's, on any
// PC. The first account signed in on a PC takes what the PC had bought before.

const relay = require('./relay-server');
const log = require('./log');

const SECURE = relay.SECURE_URLS;
const sessions = new Map(); // account id → { key: "x:<xuid>", session, gamertag }
const pending = new Map(); // account id → the login under way

const hasXbox = (acc) => !!acc && (acc.type === 'msa' || acc.type === 'xbox');

// "x:<xuid>" for an account with Xbox, null otherwise (known without asking anyone)
function keyOf(acc) {
  return hasXbox(acc) && /^\d{1,20}$/.test(String(acc.xuid || '')) ? `x:${acc.xuid}` : null;
}

async function login(acc) {
  const { header } = await require('./auth').xboxAuth(acc.id);
  const device = require('./cosmetics').deviceKey();
  const { ask } = require('./redeem');
  for (const url of SECURE) {
    let res;
    try {
      res = await ask(url, { op: 'login', xbl: header, device }, 20000);
    } catch (e) {
      log.info(`Account session: ${url}: ${e.message}`);
      continue;
    }
    if (!res || !res.ok) {
      log.info(`Account session: refused (${res ? res.error : 'no answer'}).`);
      return null;
    }
    const s = { key: `x:${res.xuid}`, session: res.session, gamertag: res.gamertag };
    sessions.set(acc.id, s);
    log.info(`Account session: ${res.gamertag}${res.moved ? ' — this PC\'s purchases are this account\'s now' : ''}.`);
    return s;
  }
  return null;
}

// The session for an account (cached; a fresh one when it's a day from its end)
async function forAccount(acc) {
  if (!hasXbox(acc)) return null;
  const s = sessions.get(acc.id);
  if (s && s.session && s.session.exp * 1000 > Date.now() + 86400000) return s;
  if (!pending.has(acc.id)) pending.set(acc.id, login(acc).catch((e) => { log.info(`Account session: ${e.message}`); return null; }).finally(() => pending.delete(acc.id)));
  return pending.get(acc.id);
}

const active = () => forAccount(require('./auth').activeAccount());

module.exports = { keyOf, forAccount, active, _test: { reset: () => { sessions.clear(); pending.clear(); } } };
