'use strict';
// MC Launcher's own relay server (server/setup.sh): MQTT for lobbies, nearby
// players and voice signalling, and TURN for the voice and world connections
// that can't go straight between two players (mobile internet, a phone's
// hotspot, a provider's shared address). It's tried first; the public relays
// stay behind it as a fallback.
//
// No domain: the server's certificate is our own and the launcher trusts
// exactly that one for this address.

const crypto = require('crypto');

const HOST = process.env.MCL_RELAY_HOST || 'relay.example.com'; // your own relay (Mosquitto + coturn)
const CERT = process.env.MCL_RELAY_CERT || ''; // the relay's self-signed certificate (PEM)
// TURN credentials are made here from the server's secret, valid a day
// (coturn's use-auth-secret): nothing lasting to steal from a session.
const TURN_SECRET = process.env.MCL_TURN_SECRET || ''; // coturn's static-auth-secret

// MQTT: TLS on 443 (looks like any HTTPS site), the usual 8883, plain 1883.
const MQTT_URLS = [`mqtts://${HOST}:443`, `mqtts://${HOST}:8883`, `mqtt://${HOST}:1883`];

function trust(host) {
  return host === HOST ? CERT : null;
}

function iceServers() {
  const username = `${Math.floor(Date.now() / 1000) + 24 * 3600}:mcl`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return [
    { urls: [`stun:${HOST}:3478`] },
    // UDP first; TCP 3478, TCP 80 and UDP 443 for networks that block the rest
    { urls: [`turn:${HOST}:3478?transport=udp`, `turn:${HOST}:443?transport=udp`, `turn:${HOST}:3478?transport=tcp`, `turn:${HOST}:80?transport=tcp`], username, credential },
  ];
}

module.exports = { HOST, MQTT_URLS, trust, iceServers };
