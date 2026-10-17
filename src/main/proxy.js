'use strict';
// The system proxy (Windows' Internet settings, as Chromium reads them — a
// VPN app's "system proxy" mode, Happ / v2rayN / Clash): the launcher's own
// requests go through it like its window's do, and so does the game, which
// only understands a SOCKS proxy — a SOCKS5 one here on loopback hands each
// connection on the way the system says (an HTTP proxy's CONNECT, a SOCKS5
// proxy, or straight). Without a system proxy nothing of this is used.

const net = require('net');
const crypto = require('crypto');
const log = require('./log');

// "PROXY h:p; DIRECT" → the first we can use: {type: 'http' | 'socks5', host, port}, null for straight
function parse(rule) {
  for (const part of String(rule || '').split(';')) {
    const m = /^\s*(PROXY|HTTP|SOCKS5|SOCKS)\s+\[?([^\]\s]+?)\]?:(\d{1,5})\s*$/i.exec(part);
    if (m) return { type: /^SOCKS/i.test(m[1]) ? 'socks5' : 'http', host: m[2], port: Number(m[3]) };
    if (/^\s*DIRECT\s*$/i.test(part)) return null;
  }
  return null;
}

const cache = new Map(); // origin → { t, via }
async function forUrl(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.t < 30000) return hit.via;
  let via = null;
  try {
    const { session, app } = require('electron');
    if (app.isReady()) via = parse(await session.defaultSession.resolveProxy(url));
  } catch { /* straight then */ }
  if (cache.size > 200) cache.clear();
  cache.set(origin, { t: Date.now(), via });
  return via;
}

// loopback and the home network: always straight (the game's own skin server on 127.0.0.1, a LAN world)
const LOCAL = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|localhost$|fe80:)/i;

// ---- the game's SOCKS5 bridge --------------------------------------------------------

// What's come from a socket, read in pieces while a handshake goes on; the
// rest (and the socket, paused) handed over when it's done.
function reader(sock) {
  let buf = Buffer.alloc(0);
  let waiter = null; // { test, resolve, reject }
  let ended = false;
  const pump = () => {
    if (!waiter) return;
    const n = waiter.test(buf);
    if (n >= 0) {
      const w = waiter;
      waiter = null;
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      w.resolve(out);
    } else if (ended || buf.length > 16384) {
      const w = waiter;
      waiter = null;
      w.reject(new Error('closed'));
    }
  };
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    pump();
  };
  const onEnd = () => {
    ended = true;
    pump();
  };
  sock.on('data', onData);
  sock.on('end', onEnd);
  sock.on('close', onEnd);
  sock.on('error', onEnd);
  const wait = (test) => new Promise((resolve, reject) => {
    waiter = { test, resolve, reject };
    pump();
  });
  return {
    read: (n) => wait((b) => (b.length >= n ? n : -1)),
    // up to and with the separator
    until: (sep) => wait((b) => {
      const i = b.indexOf(sep);
      return i < 0 ? -1 : i + sep.length;
    }),
    release() {
      sock.off('data', onData);
      sock.off('end', onEnd);
      sock.off('close', onEnd);
      sock.off('error', onEnd);
      sock.pause();
      const rest = buf;
      buf = Buffer.alloc(0);
      return rest;
    },
  };
}

function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.setTimeout(15000, () => s.destroy(new Error('timeout')));
    s.once('connect', () => {
      s.setTimeout(0);
      resolve(s);
    });
    s.once('error', reject);
  });
}

// through the system's HTTP proxy: CONNECT host:port; what comes after its answer is the far end's
async function viaHttp(via, host, port) {
  const s = await connectTcp(via.host, via.port);
  const r = reader(s);
  const target = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  try {
    const head = await r.until(Buffer.from('\r\n\r\n'));
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'));
    if (!status || status[1] !== '200') throw new Error(`proxy: ${status ? status[1] : 'bad answer'}`);
  } catch (e) {
    s.destroy();
    throw e;
  }
  return { sock: s, rest: r.release() };
}

// through the system's SOCKS5 proxy (no password)
async function viaSocks(via, host, port) {
  const s = await connectTcp(via.host, via.port);
  const r = reader(s);
  try {
    s.write(Buffer.from([5, 1, 0]));
    const hello = await r.read(2);
    if (hello[0] !== 5 || hello[1] !== 0) throw new Error('proxy: SOCKS needs a password');
    const name = Buffer.from(host, 'utf8');
    const p = Buffer.alloc(2);
    p.writeUInt16BE(port);
    s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, p]));
    const head = await r.read(4);
    if (head[1] !== 0) throw new Error(`proxy: SOCKS ${head[1]}`);
    const skip = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await r.read(1))[0];
    await r.read(skip + 2);
  } catch (e) {
    s.destroy();
    throw e;
  }
  return { sock: s, rest: r.release() };
}

async function upstream(host, port) {
  if (LOCAL.test(host)) return { sock: await connectTcp(host, port), rest: Buffer.alloc(0) };
  const via = await forUrl(`https://${host.includes(':') ? `[${host}]` : host}:${port}/`);
  if (!via) return { sock: await connectTcp(host, port), rest: Buffer.alloc(0) };
  return via.type === 'socks5' ? viaSocks(via, host, port) : viaHttp(via, host, port);
}

const same = (got, want) => {
  const w = Buffer.from(want);
  return got.length === w.length && crypto.timingSafeEqual(got, w);
};

// one game connection: SOCKS5 with our name and password, CONNECT only
async function serve(client, b) {
  const r = reader(client);
  client.setTimeout(20000, () => client.destroy());
  const [ver, n] = await r.read(2);
  const methods = await r.read(n);
  if (ver !== 5 || !methods.includes(2)) {
    client.end(Buffer.from([5, 0xff]));
    return;
  }
  client.write(Buffer.from([5, 2]));
  const [, ulen] = await r.read(2);
  const user = await r.read(ulen);
  const [plen] = await r.read(1);
  const pass = await r.read(plen);
  if (!same(user, b.user) || !same(pass, b.pass)) {
    client.end(Buffer.from([1, 1]));
    return;
  }
  client.write(Buffer.from([1, 0]));
  const [v, cmd, , atyp] = await r.read(4);
  let host = '';
  if (atyp === 1) host = [...(await r.read(4))].join('.');
  else if (atyp === 3) host = (await r.read((await r.read(1))[0])).toString('utf8');
  else if (atyp === 4) host = (await r.read(16)).toString('hex').match(/.{4}/g).join(':');
  const port = (await r.read(2)).readUInt16BE(0);
  const fail = (code) => client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
  if (v !== 5 || cmd !== 1 || !host || !port) {
    fail(7);
    return;
  }
  let up;
  try {
    up = await upstream(host, port);
  } catch (e) {
    log.warn(`Game proxy: ${host}:${port} — ${e.message}`);
    fail(5);
    return;
  }
  if (client.destroyed) {
    up.sock.destroy();
    return;
  }
  client.setTimeout(0);
  client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
  const early = r.release();
  if (early.length) up.sock.write(early);
  if (up.rest.length) client.write(up.rest);
  const close = () => {
    client.destroy();
    up.sock.destroy();
  };
  client.on('error', close);
  up.sock.on('error', close);
  client.once('close', close);
  up.sock.once('close', close);
  client.pipe(up.sock);
  up.sock.pipe(client);
}

let bridge = null; // { server, port, user, pass }

function startBridge() {
  if (bridge) return Promise.resolve(bridge);
  return new Promise((resolve, reject) => {
    const b = { user: crypto.randomBytes(8).toString('hex'), pass: crypto.randomBytes(18).toString('hex') };
    const server = net.createServer((client) => {
      client.on('error', () => {});
      serve(client, b).catch(() => client.destroy());
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      log.secret(b.pass);
      bridge = { ...b, server, port: server.address().port };
      resolve(bridge);
    });
  });
}

// For a game start: the SOCKS proxy it's to use ({host, port, user, pass}),
// or null when Mojang's servers are reached straight.
async function forGame() {
  const via = await forUrl('https://sessionserver.mojang.com/');
  if (!via) return null;
  const b = await startBridge();
  log.info(`Game proxy: through the system's ${via.type === 'socks5' ? 'SOCKS' : 'HTTP'} proxy ${via.host}:${via.port}.`);
  return { host: '127.0.0.1', port: b.port, user: b.user, pass: b.pass };
}

module.exports = { parse, forUrl, forGame, startBridge };
