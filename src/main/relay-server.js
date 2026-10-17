'use strict';
// MC Launcher's own relay server (server/setup.sh): MQTT for lobbies, nearby
// players and voice signalling, and TURN for the voice and world connections
// that can't go straight between two players (mobile internet, a phone's
// hotspot, a provider's shared address). It's tried first; the public relays
// stay behind it as a fallback.
//
// No domain: the server's certificate is our own and the launcher trusts
// exactly that one for this address.

const HOST = process.env.MCL_RELAY_HOST || 'relay.example.com'; // your own relay (Mosquitto + coturn)
const CERT = process.env.MCL_RELAY_CERT || ''; // the relay's self-signed certificate (PEM)
// MQTT: TLS on 443 (looks like any HTTPS site), the usual 8883, plain 1883.
const MQTT_URLS = [`mqtts://${HOST}:443`, `mqtts://${HOST}:8883`, `mqtt://${HOST}:1883`];
// What carries an account's session or this launcher's key (codes, the shop,
// the profile) and the server's answers to it: TLS only — on plain MQTT
// anyone on the way could read them, or answer for the server.
const SECURE_URLS = MQTT_URLS.filter((u) => u.startsWith('mqtts://'));

function trust(host) {
  return host === HOST ? CERT : null;
}

// STUN, and TURN with credentials our server makes (redeem.py, op turn; its
// secret stays there): asked for over TLS with the account's session or this
// launcher's key, kept till half an hour before they run out. No answer: STUN
// only for now, asked again in a few minutes.
let ice = null; // { servers, until }
let asking = null;

async function askTurn() {
  const { ask } = require('./redeem');
  let session = null;
  try {
    const sessions = require('./account-session');
    const acc = require('./auth').activeAccount();
    if (sessions.keyOf(acc)) session = ((await sessions.forAccount(acc)) || {}).session || null;
  } catch { /* this launcher's key then */ }
  const body = { op: 'turn', device: require('./cosmetics').deviceKey(), ...(session ? { session } : {}) };
  for (const url of SECURE_URLS) {
    try {
      return await ask(url, body, 9000);
    } catch { /* the next address */ }
  }
  return null;
}

async function fetchIce() {
  const stun = [{ urls: [`stun:${HOST}:3478`] }];
  const res = await askTurn().catch(() => null);
  if (res && res.ok && res.username && res.credential) {
    const servers = [
      ...stun,
      // UDP first; TCP 3478, TCP 80 and UDP 443 for networks that block the rest
      { urls: [`turn:${HOST}:3478?transport=udp`, `turn:${HOST}:443?transport=udp`, `turn:${HOST}:3478?transport=tcp`, `turn:${HOST}:80?transport=tcp`], username: String(res.username), credential: String(res.credential) },
    ];
    ice = { servers, until: Date.now() + Math.max(600, Number(res.ttl) - 1800) * 1000 };
    return servers;
  }
  ice = { servers: stun, until: Date.now() + 5 * 60000 };
  return stun;
}

function iceServers() {
  if (ice && Date.now() < ice.until) return Promise.resolve(ice.servers);
  if (!asking) asking = fetchIce().finally(() => { asking = null; });
  return asking;
}

module.exports = { HOST, MQTT_URLS, SECURE_URLS, trust, iceServers };
