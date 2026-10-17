// ICE servers for voice and the world tunnel: our relay's STUN and TURN (its
// credentials come from the main process — our server makes them, valid a few
// hours — fetched again every hour, in a few minutes while there's no TURN)
// and public STUN. TURN carries the calls two players can't make
// straight to each other — mobile internet, a phone's hotspot, a provider's
// shared address.
import { api } from './core.js';

const PUBLIC = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, { urls: ['stun:stun.cloudflare.com:3478'] }];
let servers = PUBLIC;
let fetchedAt = 0;
let pending = null;

export function refreshIce() {
  if (Date.now() - fetchedAt < 3600e3) return Promise.resolve(servers);
  if (!pending) {
    pending = api('net:ice')
      .then((own) => {
        if (Array.isArray(own) && own.length) servers = [...own, ...PUBLIC];
        // without TURN (our server didn't answer): again in five minutes
        fetchedAt = Date.now() - (Array.isArray(own) && own.some((s) => s.username) ? 0 : 3300e3);
        return servers;
      })
      .catch(() => servers)
      .finally(() => { pending = null; });
  }
  return pending;
}

// What a new connection gets right now.
export function iceServers() {
  refreshIce();
  return servers;
}

refreshIce();
