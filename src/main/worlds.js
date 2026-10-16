'use strict';
// Singleplayer worlds and saved servers, per installation.
//
// Every installation has its own game directory (instances/<id>), so a
// world or a servers.dat always belongs to one installation — which is why
// each entry carries installId, and why opening one means launching that
// installation.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('net');
const dns = require('dns').promises;
const nbt = require('./nbt');
const config = require('./config');
const log = require('./log');

const GAME_TYPES = { 0: 'survival', 1: 'creative', 2: 'adventure', 3: 'spectator' };

const DEFAULT_SERVERS = [
  { name: 'Hypixel', ip: 'mc.hypixel.net' },
  { name: 'Hoplite Network', ip: 'hoplite.gg' },
  { name: 'Complex Gaming [EU]', ip: 'hub.eu.mc-complex.com' },
  { name: 'Wynncraft', ip: 'play.wynncraft.com' },
  { name: 'CubeCraft Games', ip: 'play.cubecraft.net' },
  { name: 'MCC Island', ip: 'play.mccisland.net' },
];

async function readWorld(saveDir, install) {
  const levelDat = path.join(saveDir, 'level.dat');
  let root;
  try {
    root = nbt.parse(await fsp.readFile(levelDat));
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn(`Couldn't read ${levelDat}: ${e.message}`);
    return null;
  }
  const data = root.Data || root;
  let mode = GAME_TYPES[data.GameType] || 'survival';
  if (data.hardcore) mode = 'hardcore';
  let hasIcon = false;
  try {
    hasIcon = (await fsp.stat(path.join(saveDir, 'icon.png'))).isFile();
  } catch {
    hasIcon = false;
  }
  const version = (data.Version && data.Version.Name) || '';
  return {
    name: String(data.LevelName || path.basename(saveDir)),
    folder: path.basename(saveDir),
    mode,
    lastPlayed: Number(data.LastPlayed) || 0,
    version,
    hasIcon,
    installId: install.id,
    installName: install.name,
  };
}

async function recentWorlds(installs, limit = 6) {
  const found = [];
  for (const install of installs) {
    const saves = path.join(config.dirs.instance(install.id), 'saves');
    let dirs = [];
    try {
      dirs = (await fsp.readdir(saves, { withFileTypes: true })).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    const worlds = await Promise.all(dirs.map((d) => readWorld(path.join(saves, d.name), install)));
    for (const w of worlds) if (w) found.push(w);
  }
  found.sort((a, b) => b.lastPlayed - a.lastPlayed);
  return found.slice(0, limit);
}

function hasWorlds(install) {
  const saves = path.join(config.dirs.instance(install.id), 'saves');
  try {
    return fs.readdirSync(saves, { withFileTypes: true }).some((d) => d.isDirectory() && fs.existsSync(path.join(saves, d.name, 'level.dat')));
  } catch {
    return false;
  }
}

function worldIconPath(installId, folder) {
  const safe = path.basename(folder);
  return path.join(config.dirs.instance(path.basename(installId)), 'saves', safe, 'icon.png');
}

// ---- servers.dat ---------------------------------------------------------------

function writeDefaultServers(gameDir) {
  const dest = path.join(gameDir, 'servers.dat');
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(dest, nbt.writeServersDat(DEFAULT_SERVERS));
}

async function savedServers(install) {
  try {
    const root = nbt.parse(await fsp.readFile(path.join(config.dirs.instance(install.id), 'servers.dat')));
    return (root.servers || [])
      .filter((s) => s && s.ip && !s.hidden)
      .map((s) => ({ name: String(s.name || s.ip), ip: String(s.ip), icon: s.icon ? `data:image/png;base64,${s.icon}` : '' }));
  } catch {
    return [];
  }
}

// ---- server list ping ------------------------------------------------------------
// The status request every Minecraft client sends from the Multiplayer
// screen: handshake (next state = status), status request, read the JSON.
// Gives MOTD, version, online/max players, a sample of who's on, the icon.

function varint(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function packet(id, ...parts) {
  const body = Buffer.concat([varint(id), ...parts]);
  return Buffer.concat([varint(body.length), body]);
}

function mcString(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varint(b.length), b]);
}

function readVarint(buf, off) {
  let num = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    if (off + i >= buf.length) return null;
    const b = buf[off + i];
    num |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: num, size: i + 1 };
    shift += 7;
  }
  throw new Error('varint too long');
}

async function resolveAddress(address) {
  let [host, portStr] = String(address).trim().split(/:(?=\d+$)/);
  let port = Number(portStr) || 25565;
  if (!portStr && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    try {
      const srv = await dns.resolveSrv(`_minecraft._tcp.${host}`);
      if (srv && srv[0]) {
        return { host: srv[0].name, port: srv[0].port, handshakeHost: host };
      }
    } catch {
      /* no SRV record — use the plain host */
    }
  }
  return { host, port, handshakeHost: host };
}

function pingServer(address, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done({ online: false, error: 'timeout' }), timeoutMs);
    resolveAddress(address)
      .then(({ host, port, handshakeHost }) => {
        const started = Date.now();
        let connectMs = 0;
        let chunks = Buffer.alloc(0);
        let status = null;
        let pingSent = 0;
        socket = net.connect({ host, port });
        socket.setNoDelay(true);
        socket.on('error', (e) => (status ? done({ ...status, latency: connectMs }) : done({ online: false, error: e.code || e.message })));
        socket.on('close', () => status && done({ ...status, latency: connectMs }));
        socket.on('connect', () => {
          connectMs = Date.now() - started;
          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(port);
          socket.write(packet(0x00, varint(767), mcString(handshakeHost), portBuf, varint(1)));
          socket.write(packet(0x00));
        });
        socket.on('data', (d) => {
          chunks = Buffer.concat([chunks, d]);
          try {
            for (;;) {
              const len = readVarint(chunks, 0);
              if (!len || chunks.length < len.size + len.value) return;
              const frame = chunks.subarray(len.size, len.size + len.value);
              chunks = chunks.subarray(len.size + len.value);
              const id = readVarint(frame, 0);
              if (!status && id.value === 0x00) {
                const strLen = readVarint(frame, id.size);
                const off = id.size + strLen.size;
                const json = JSON.parse(frame.toString('utf8', off, off + strLen.value));
                const players = json.players || {};
                status = {
                  online: true,
                  version: json.version ? String(json.version.name || '') : '',
                  protocol: json.version ? json.version.protocol : 0,
                  players: { online: Number(players.online) || 0, max: Number(players.max) || 0, sample: (players.sample || []).map((p) => String(p.name || '')).filter((n) => n && !/§/.test(n)).slice(0, 12) },
                  motd: json.description || '',
                  favicon: typeof json.favicon === 'string' && json.favicon.startsWith('data:image/') ? json.favicon : '',
                };
                // Then the real round trip: ping (0x01) → pong, which is
                // what the game's own server list shows.
                const payload = Buffer.alloc(8);
                payload.writeBigInt64BE(BigInt(Date.now()));
                pingSent = Date.now();
                socket.write(packet(0x01, payload));
                setTimeout(() => done({ ...status, latency: connectMs }), 1500);
              } else if (status && id.value === 0x01) {
                done({ ...status, latency: Date.now() - pingSent });
              }
            }
          } catch (e) {
            done(status ? { ...status, latency: connectMs } : { online: false, error: e.message });
          }
        });
      })
      .catch((e) => done({ online: false, error: e.message }));
  });
}

module.exports = { recentWorlds, hasWorlds, worldIconPath, writeDefaultServers, savedServers, pingServer, DEFAULT_SERVERS };
