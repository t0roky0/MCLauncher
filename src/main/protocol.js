'use strict';
// mcl:// — the only way files reach the UI.
//
//   mcl://app/...                 the renderer bundle (dist/) and assets/
//   mcl://user/skins/<file>       skin library
//   mcl://world/<install>/<dir>   a world's icon.png
//   mcl://remote/?u=<https url>   Mojang/Xbox images (skins, capes, gamer
//                                 pics), proxied through a disk cache
//
// One privileged scheme instead of file:// means every image the 3D skin
// viewer touches is a normal CORS-enabled resource (WebGL refuses tainted
// textures), and the renderer never gets to name an arbitrary path: each
// host maps to one fixed root and traversal out of it is refused.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { protocol } = require('electron');
const paths = require('./paths');
const net = require('./net');
const worlds = require('./worlds');

const MIME = {
  '.wasm': 'application/wasm',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const REMOTE_HOSTS = [/(^|\.)textures\.minecraft\.net$/i, /(^|\.)xboxlive\.com$/i, /(^|\.)minecraft\.net$/i, /(^|\.)mojang\.com$/i, /(^|\.)minecraftservices\.com$/i, /^cdn\.discordapp\.com$/i];

function registerPrivileges() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'mcl', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
  ]);
}

function headers(type, extra = {}) {
  return { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', ...extra };
}

function notFound() {
  return new Response('not found', { status: 404, headers: headers('text/plain') });
}

function inside(root, rel) {
  const full = path.resolve(root, rel);
  const base = path.resolve(root);
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

async function serveFile(file, cache = false) {
  if (!file) return notFound();
  try {
    const data = await fsp.readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return new Response(data, { headers: headers(type, cache ? { 'Cache-Control': 'max-age=31536000, immutable' } : {}) });
  } catch {
    return notFound();
  }
}

function sniff(buf) {
  if (buf.length > 4 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 4 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length > 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

const inflight = new Map();

async function serveRemote(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return notFound();
  }
  if (!/^https?:$/.test(url.protocol) || !REMOTE_HOSTS.some((r) => r.test(url.hostname))) {
    return new Response('forbidden', { status: 403, headers: headers('text/plain') });
  }
  try {
    const data = await remoteImage(url.href);
    return new Response(data, { headers: headers(sniff(data), { 'Cache-Control': 'max-age=86400' }) });
  } catch (e) {
    return new Response(String(e.message), { status: 502, headers: headers('text/plain') });
  }
}

// A Mojang/Xbox image through the disk cache (also used for the pictures of
// Windows notifications). Throws when it's neither cached nor reachable.
async function remoteImage(href) {
  const url = new URL(href);
  if (!REMOTE_HOSTS.some((r) => r.test(url.hostname))) throw new Error('forbidden');
  if (url.protocol === 'http:') url.protocol = 'https:';
  const key = crypto.createHash('sha1').update(url.href).digest('hex');
  const file = path.join(paths.imageCacheDir, key);
  // Texture URLs are content-addressed (never change); gamer pics can, so
  // those are refreshed after a day.
  const maxAge = /textures\.minecraft\.net/i.test(url.hostname) ? Infinity : 24 * 3600 * 1000;
  try {
    const st = await fsp.stat(file);
    if (Date.now() - st.mtimeMs < maxAge) return await fsp.readFile(file);
  } catch {
    /* not cached */
  }
  try {
    if (!inflight.has(key)) {
      inflight.set(
        key,
        net.getBuffer(url.href, { timeout: 15000, retries: 1 }).finally(() => inflight.delete(key)),
      );
    }
    const data = await inflight.get(key);
    await fsp.mkdir(paths.imageCacheDir, { recursive: true });
    await fsp.writeFile(file, data);
    return data;
  } catch (e) {
    try {
      return await fsp.readFile(file); // stale beats nothing
    } catch {
      throw e;
    }
  }
}

function register() {
  protocol.handle('mcl', async (request) => {
    const u = new URL(request.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    switch (u.hostname) {
      case 'app': {
        if (rel.startsWith('assets/')) return serveFile(inside(path.join(paths.appRoot, 'assets'), rel.slice(7)), true);
        return serveFile(inside(paths.dist(), rel || 'index.html'));
      }
      case 'user': {
        if (rel.startsWith('skins/')) return serveFile(inside(paths.skinsDir, rel.slice(6)));
        if (rel.startsWith('capes/')) return serveFile(inside(paths.capesDir, rel.slice(6)));
        return notFound();
      }
      case 'world': {
        const [installId, folder] = rel.split('/');
        if (!installId || !folder) return notFound();
        return serveFile(worlds.worldIconPath(installId, folder));
      }
      case 'remote':
        return serveRemote(u.searchParams.get('u') || '');
      default:
        return notFound();
    }
  });
}

module.exports = { registerPrivileges, register, remoteImage };
