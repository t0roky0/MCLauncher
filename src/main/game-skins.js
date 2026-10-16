'use strict';
// Local Java cosmetics, shared with nearby launcher users and party members.
// The agent merges this layer over textures received from Mojang without
// changing the signed-in account. Content-addressed PNGs are served on loopback.
// Each row: UUID, name, model, skin URL, cape URL (tab-separated).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const config = require('./config');
const paths = require('./paths');
const party = require('./party');
const nearby = require('./nearby');
const log = require('./log');

const AGENT_SRC = paths.asset('agent', 'mcl-skins.jar');
const DATA_DIR = path.join(paths.appDir, 'game-skins');

const textures = new Map(); // sha256 hex -> png bytes
const launches = new Map(); // id -> { file, self, assetsRoot }
let server = null;
let port = 0;
let partyHooked = false;
let leaderLaunch = null;
let baked = null; // cosmetics baked for the agent (cosmetic-mesh.js)

function startServer() {
  if (server && port) return Promise.resolve(port);
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      const m = /^\/skin\/([0-9a-f]{64})\.png$/.exec(req.url || '');
      const png = m && textures.get(m[1]);
      if (req.method !== 'GET' || !png) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'max-age=86400' });
      res.end(png);
      log.info(`Skins in game: the game took skin ${m[1].slice(0, 8)}.`);
    });
    s.on('error', (e) => {
      server = null;
      port = 0;
      reject(e);
    });
    s.listen(0, '127.0.0.1', () => {
      server = s;
      port = s.address().port;
      s.unref();
      resolve(port);
    });
  });
}

// The game's own skin cache: assets/skins/<2>/<sha1 of the url's file name,
// taken as UTF-16LE — Guava's hashUnencodedChars>.
function cacheFile(assetsRoot, sha) {
  const h = crypto.createHash('sha1').update(Buffer.from(sha, 'utf16le')).digest('hex');
  return path.join(assetsRoot, 'skins', h.slice(0, 2), h);
}

// a texture served from here and put in the game's cache: its url
function served(png, assetsRoot) {
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  textures.set(sha, png);
  if (assetsRoot) {
    const file = cacheFile(assetsRoot, sha);
    if (!fs.existsSync(file)) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, png);
      } catch { /* the download from 127.0.0.1 covers it */ }
    }
  }
  return `http://127.0.0.1:${port}/skin/${sha}.png`;
}

function entry({ uuid, name, model, png, cape }, assetsRoot) {
  const clean = (v) => String(v || '').replace(/[\t\r\n]/g, '');
  return [clean(uuid), clean(name), model === 'slim' ? 'slim' : 'classic', png ? served(png, assetsRoot) : '', cape ? served(cape, assetsRoot) : ''].join('\t');
}

function pngOfDataUrl(url) {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(url || ''));
  return m ? Buffer.from(m[1], 'base64') : null;
}

function lines(l) {
  // the party world (see the agent): an offline player joins it without a
  // session, the leader's game lets offline names in
  const p = party.state();
  if (!p.active || !p.leader) leaderLaunch = null;
  else if (!leaderLaunch || leaderLaunch.code !== p.code || ![...launches.values()].includes(leaderLaunch.launch)) {
    leaderLaunch = { code: p.code, launch: [...launches.values()].find(x => x.installId === config.get().selectedInstall) || launches.values().next().value || l };
  }
  const primary = leaderLaunch?.launch;
  const role = p.active ? p.leader ? (primary === l ? 'leader' : '') : 'member' : '';
  if (role !== 'member' || l.joinCode !== p.code) { l.join = ''; l.joinCode = ''; }
  const out = [l.offline ? '#offline' : '', (l.partyBridge ? role === 'leader' : l.lan) ? '#lan' : ''].filter(Boolean);
  if (l.partyBridge) {
    out.push(`#party\trole\t${role}`);
    for (const [key, value] of Object.entries(l.mappings || {})) out.push(`#party\t${key}\t${value}`);
    if (role === 'member' && l.join) out.push(`#party\tjoin\t${l.join}`);
  }
  // the overlay's game settings (zoom, brightness…: agent Comfort.java)
  out.push(...require('./game-comfort').agentLines());
  if (!l.skins) return out;
  const taken = new Set();
  if (l.accountId && l.identity) {
    const own = require('./skins').localSkinFor(l.accountId);
    l.self = own ? { ...l.identity, ...own } : null;
  }
  if (l.self) {
    out.push(entry(l.self, l.assetsRoot));
    taken.add(l.self.name.toLowerCase());
  }
  const visible = nearby.state().members || [];
  for (const m of [...visible, ...((p.active && p.members) || [])]) {
    if (m.self || taken.has(String(m.name).toLowerCase())) continue;
    const png = pngOfDataUrl(m.skin);
    const cape = pngOfDataUrl(m.cape);
    if (!png && !cape) continue;
    taken.add(String(m.name).toLowerCase());
    out.push(entry({ uuid: m.id && /^[a-f0-9]{32}$/.test(m.id) ? m.id : config.offlineUuid(m.name), name: m.name, model: m.model, png, cape }, l.assetsRoot));
  }
  out.push(...cosmeticLines(l, [...visible, ...((p.active && p.members) || [])]));
  return out;
}

// Cosmetics: where the agent finds the baked items, and who wears what — us,
// the party, launcher users playing nearby (one line a player).
function cosmeticLines(l, others) {
  try {
    if (!baked) baked = require('./cosmetic-mesh').prepare(path.join(paths.appDir, 'agent'));
  } catch (e) {
    log.warn(`Cosmetics in game: ${e.message}`);
    return [];
  }
  const known = new Set(baked.ids);
  const out = [];
  const seen = new Set();
  const add = (name, ids) => {
    const key = String(name || '').toLowerCase();
    const list = (Array.isArray(ids) ? ids : []).filter((id) => known.has(id));
    if (!key || seen.has(key) || /[\t\r\n]/.test(name) || !list.length) return;
    seen.add(key);
    out.push(`#cos\t${name}\t${list.join(',')}`);
  };
  add(l.identity && l.identity.name, require('./cosmetics').worn());
  for (const m of others) if (!m.self) add(m.name, m.cos);
  return out.length ? [`#cosdir\t${baked.dir}`, ...out] : [];
}

// Something changed in what's worn: every running game's file again.
function refresh() {
  for (const l of launches.values()) {
    try { write(l); } catch (e) { log.warn(`Game skins: ${e.message}`); }
  }
}

function write(l) {
  const text = `${lines(l).join('\n')}\n`;
  if (text === l.written) return;
  const tmp = `${l.file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, l.file);
  l.written = text;
}

function hookParty() {
  if (partyHooked) return;
  partyHooked = true;
  config.onChange?.(() => { for (const l of launches.values()) { try { write(l); } catch (e) { log.warn(e.message); } } });
  nearby.onEvent(type => { if (type === 'cosmetics') for (const l of launches.values()) { try { write(l); } catch (e) { log.warn(e.message); } } });
  party.onEvent((type) => {
    if (type !== 'changed' && type !== 'ended') return;
    for (const l of launches.values()) {
      try {
        write(l);
      } catch (e) {
        log.warn(`Game skins: ${e.message}`);
      }
    }
  });
}

// The agent jar can't be read from inside app.asar by Java: a copy goes
// next to the launcher's data, named by its content.
async function agentJar() {
  const bytes = await fsp.readFile(AGENT_SRC);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const dest = path.join(paths.appDir, 'agent', `mcl-skins-${sha}.jar`);
  if (!fs.existsSync(dest)) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, bytes);
  }
  return dest;
}

// Called right before a Java start. `self` — our skin when the account has
// none at Mojang ({uuid, name, model, png}), else null. Returns the JVM
// arguments to add and a release() for when the game exits; nothing when
// it's switched off or there's nothing to show.
async function prepare({ self, accountId = '', identity = null, assetsRoot, offline = false, lan = false, installId = '', mappings = {}, partyBridge = false }) {
  const skins = config.get().gameSkins !== false;
  // the overlay's game settings work through it too (zoom, brightness…)
  const g = config.get().game || {};
  const comfort = !!(g.zoom || g.fullbright || g.autoSprint || g.noFire || (g.vsync && g.vsync !== 'game'));
  // offline accounts always get it: a party world may need the join step
  if (!skins && !offline && !lan && !partyBridge && !comfort) return null;
  try {
    await startServer();
    const jar = await agentJar();
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const id = crypto.randomBytes(6).toString('hex');
    const l = { accountId, identity, file: path.join(DATA_DIR, `${id}.txt`), self: skins ? self : null, skins, offline, lan, assetsRoot, installId, mappings, partyBridge, written: '' };
    launches.set(id, l);
    if (partyBridge && party.state().active && party.state().leader) leaderLaunch = { code: party.state().code, launch: l };
    for (const session of launches.values()) write(session);
    hookParty();
    if (skins) log.info(`Skins in game: ${self ? `own ${[self.png ? `skin (${self.model})` : '', self.cape ? 'cape' : ''].filter(Boolean).join(' and ')}` : 'party skins'} via 127.0.0.1:${port}.`);
    if (lan) log.info('Party world: this game hosts it.');
    return {
      jvmArgs: [`-javaagent:${jar}=${l.file}`],
      connect(server) {
        if (!party.state().active || party.state().leader) return false;
        l.join = `${crypto.randomBytes(8).toString('hex')} ${Buffer.from(server, 'utf8').toString('base64')}`;
        l.joinCode = party.state().code;
        write(l);
        return true;
      },
      release() {
        launches.delete(id);
        for (const session of launches.values()) {
          try { write(session); } catch (e) { log.warn(`Game party: ${e.message}`); }
        }
        fs.rm(l.file, { force: true }, () => {});
      },
    };
  } catch (e) {
    log.warn(`Skins in game unavailable: ${e.message}`);
    return null;
  }
}

// Leftovers of games that ran while the launcher was killed (a game still
// running from back then keeps its file for a while).
function cleanup() {
  fs.readdir(DATA_DIR, (err, names) => {
    for (const n of err ? [] : names) {
      const p = path.join(DATA_DIR, n);
      fs.stat(p, (e, st) => {
        if (!e && Date.now() - st.mtimeMs > 12 * 3600e3) fs.rm(p, { force: true }, () => {});
      });
    }
  });
}

module.exports = { prepare, cleanup, cacheFile, refresh };
