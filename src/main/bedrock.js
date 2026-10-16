'use strict';
// Minecraft: Bedrock Edition for Windows.
//
// Bedrock is a Store/Xbox app: it updates itself and signs in with the Xbox
// account of Windows, so the launcher doesn't install or authenticate it —
// it finds it, starts it through its minecraft: protocol (straight onto a
// server when asked), lists and pings its servers, and dresses it.
//
// Skins: the library goes into a skin pack of ours (Shared → skin_packs,
// where imported .mcpack skin packs live), each skin with its own arm
// model, so it also shows up in the game's Dressing Room. The chosen skin
// is selected in the profile's options.txt (game_skintypefull =
// "<pack uuid>_<skin name>", the same form the game writes for its own
// packs) before every start — a skin the game dropped comes back. The
// persona file next to it is synced with Xbox and left alone.
//
// Data lives in %APPDATA%\Minecraft Bedrock\Users\<profile>\games\com.mojang
// since the game became a GDK title; one profile per Xbox user who played
// on this PC. The UWP layout (LocalState\games\com.mojang) is read too.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const { execFile } = require('child_process');
const { shell, nativeImage } = require('electron');
const config = require('./config');
const log = require('./log');

const PACKAGE = 'Microsoft.MinecraftUWP';
const EXE = 'Minecraft.Windows.exe';
const GDK_ROOT = path.join(process.env.APPDATA || '', 'Minecraft Bedrock');
const UWP_ROOT = path.join(process.env.LOCALAPPDATA || '', 'Packages', 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', 'LocalState', 'games', 'com.mojang');
const PACK_UUID = '22951263-eb9f-42f9-a39f-180ef1656a7a';
const MODULE_UUID = 'd6056d8c-5407-4a8c-b7f0-0213f14d6ebe';
const PACK_NAME = 'MCLauncher';
const DEFAULT_PORT = 19132;

let detected = null;
let detecting = null;
let runningSince = 0;
let watchTimer = null;
const listeners = new Set();

function emit(type, payload = {}) {
  for (const fn of listeners) {
    try {
      fn(type, payload);
    } catch {
      /* ignore */
    }
  }
}

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

// Store package → game version; the last two digits are the build. Since
// 2026 the game is numbered by year, like Java: 1.26.5203.0 → 26.52
// (1.21.12401.0 → 1.21.124 before that).
function displayVersion(v) {
  const [a, b, c] = String(v || '').split('.').map(Number);
  if (![a, b, c].every(Number.isFinite)) return String(v || '');
  return a === 1 && b >= 26 ? `${b}.${Math.floor(c / 100)}` : `${a}.${b}.${Math.floor(c / 100)}`;
}

function layout() {
  if (fs.existsSync(path.join(GDK_ROOT, 'Users'))) return 'gdk';
  if (fs.existsSync(UWP_ROOT)) return 'uwp';
  return '';
}

async function detect(force = false) {
  if (detected && !force) return detected;
  if (!detecting) {
    detecting = (async () => {
      const out = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-AppxPackage -Name ${PACKAGE} | Select-Object -First 1 -Property Version,InstallLocation | ConvertTo-Json -Compress`,
      ]);
      let pkg = null;
      try {
        pkg = JSON.parse(out.trim() || 'null');
      } catch {
        pkg = null;
      }
      detected = { installed: !!pkg, packageVersion: pkg ? String(pkg.Version) : '', version: pkg ? displayVersion(pkg.Version) : '', layout: layout(), install: pkg ? String(pkg.InstallLocation || '') : '' };
      if (detected.installed) log.info(`Bedrock found: ${detected.version} (package ${detected.packageVersion}, ${detected.layout || 'no data yet'}).`);
      return detected;
    })().finally(() => {
      detecting = null;
    });
  }
  return detecting;
}

function cached() {
  return detected || { installed: false, version: '', layout: '' };
}

// Installing and updating Bedrock is the Microsoft Store's job (it checks
// the account owns the game): the launcher opens the game's Store page —
// "Get"/"Install" when it's not on the PC, "Update" when there's a newer
// build — and watches for the package to appear or change version.
const STORE_ID = '9NBLGGH2JHXJ'; // Minecraft for Windows
let storeTimer = null;

async function openStore() {
  await shell.openExternal(`ms-windows-store://pdp/?ProductId=${STORE_ID}`);
  const before = cached().packageVersion || '';
  clearInterval(storeTimer);
  let rounds = 0;
  storeTimer = setInterval(async () => {
    if (++rounds > 180) clearInterval(storeTimer); // half an hour
    const d = await detect(true).catch(() => null);
    if (d && d.installed && d.packageVersion !== before) {
      clearInterval(storeTimer);
      log.info(before ? `Bedrock updated: ${d.version}.` : `Bedrock installed: ${d.version}.`);
      emit('installed', { version: d.version, updated: !!before });
    }
  }, 10000);
}

// ---- profiles ----------------------------------------------------------------------------

function profileDirs() {
  const l = layout();
  if (l === 'gdk') {
    const users = path.join(GDK_ROOT, 'Users');
    return fs
      .readdirSync(users, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'Shared')
      .map((d) => ({ id: d.name, dir: path.join(users, d.name, 'games', 'com.mojang') }));
  }
  if (l === 'uwp') return [{ id: 'uwp', dir: UWP_ROOT }];
  return [];
}

function optionsFile(p) {
  return path.join(p.dir, 'minecraftpe', 'options.txt');
}

function readOption(text, key) {
  const m = new RegExp(`^${key}:(.*)$`, 'm').exec(text);
  return m ? m[1].trim() : '';
}

// Newest first: the profile whose options were written last is the Xbox
// user who played last — almost always the one signed in now.
function profiles() {
  const out = [];
  for (const p of profileDirs()) {
    try {
      const file = optionsFile(p);
      const st = fs.statSync(file);
      const text = fs.readFileSync(file, 'utf8');
      out.push({ id: p.id, dir: p.dir, lastPlayed: st.mtimeMs, skin: readOption(text, 'game_skintypefull'), xuid: readOption(text, 'last_xuid') });
    } catch {
      /* a profile that never got as far as options.txt */
    }
  }
  return out.sort((a, b) => b.lastPlayed - a.lastPlayed);
}

// The profile picked in Skins, else the launcher account's own (Bedrock
// writes its XUID into options.txt), else whoever played last.
function currentProfile() {
  const list = profiles();
  const cfg = config.get();
  const acc = (cfg.accounts || []).find((a) => a.id === cfg.activeAccount);
  return list.find((p) => p.id === cfg.bedrockProfile) || (acc && acc.xuid && list.find((p) => p.xuid === acc.xuid)) || list[0] || null;
}

// The field of view the last player set (options.txt, degrees): the zoom finds
// the game's own getter by it (bedrock-native comfort.cpp).
function fieldOfView() {
  const last = profiles()[0];
  if (!last) return 0;
  try {
    const v = Number(readOption(fs.readFileSync(optionsFile(last), 'utf8'), 'gfx_field_of_view'));
    return Number.isFinite(v) && v > 0 && v < 180 ? v : 0;
  } catch {
    return 0;
  }
}

// An option of the game as options.txt has it, and its number in the game
// as a guess: the file lists them in the game's own order, and the gamma
// (gfx_gamma) is number 50 on 26.52 — the module only uses the guess to
// choose between options that hold the same value.
function optionHint(key) {
  const last = profiles()[0];
  if (!last) return { value: NaN, guess: 0 };
  try {
    const lines = fs.readFileSync(optionsFile(last), 'utf8').split(/\r?\n/);
    const at = (k) => lines.findIndex((l) => l.startsWith(`${k}:`));
    const i = at(key), g = at('gfx_gamma');
    return { value: Number(readOption(lines.join('\n'), key)), guess: i >= 0 && g >= 0 ? 50 + (i - g) : 0 };
  } catch {
    return { value: NaN, guess: 0 };
  }
}

// The Xbox account Bedrock signs in with: the one that played last.
function signedInXuid() {
  const last = profiles()[0];
  return last ? last.xuid : '';
}

// Bedrock keeps the look it wears in a synced profile (ud*.dat) and puts it
// back over options.txt at every start. A skin from our pack sits there as
// "<pack uuid>.<its index in skins.json>", so that index is where the chosen
// skin has to be. known: the profile could be read; index -1: the look isn't
// one of ours (a Character Creator persona or another pack).
function wornSlot(profile) {
  try {
    const files = fs.readdirSync(profile.dir).filter((f) => /^ud\d+\.dat$/i.test(f));
    if (!files.length) return { known: false, index: -1 };
    const newest = files.map((f) => ({ f, t: fs.statSync(path.join(profile.dir, f)).mtimeMs })).sort((x, y) => y.t - x.t)[0].f;
    const sync = JSON.parse(fs.readFileSync(path.join(profile.dir, newest), 'utf8')).Synchronized || {};
    const items = (key) => ((sync[key] || {}).personaCollection || {}).universalApp || [];
    const m = /persona(\d+)$/.exec(String((items('personaProfile')[0] || {}).lastUsedPersonaSlot || ''));
    if (!m) return { known: false, index: -1 };
    const slot = items(`personaProfile${m[1]}`);
    if (!slot.length || slot[0].skin !== true) return { known: true, index: -1 };
    const ref = slot.find((it) => typeof it.id === 'string' && it.id.startsWith(`${PACK_UUID}.`));
    const n = ref ? Number(ref.id.slice(PACK_UUID.length + 1)) : NaN;
    return { known: true, index: Number.isInteger(n) && n >= 0 && n < 100 ? n : -1 };
  } catch {
    return { known: false, index: -1 };
  }
}

function sharedDir() {
  return layout() === 'gdk' ? path.join(GDK_ROOT, 'Users', 'Shared', 'games', 'com.mojang') : UWP_ROOT;
}

// ---- running -------------------------------------------------------------------------------

async function isRunning() {
  const out = await run('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/FO', 'CSV', '/NH'], 8000);
  return out.toLowerCase().includes(EXE.toLowerCase());
}

// After a start: wait for the game's process to show up (Xbox sign-in and
// updates can take a while), then until it's gone.
function watch() {
  clearTimeout(watchTimer);
  const t0 = Date.now();
  const tick = async () => {
    const up = await isRunning();
    if (up && !runningSince) {
      runningSince = Date.now();
      emit('started', { installId: 'bedrock', installName: 'Minecraft Bedrock' });
    } else if (!up && runningSince) {
      const played = Date.now() - runningSince;
      runningSince = 0;
      config.mutate((c) => {
        c.bedrockStats = { lastPlayed: Date.now(), playTimeMs: ((c.bedrockStats || {}).playTimeMs || 0) + played };
      });
      emit('exited', { installId: 'bedrock', installName: 'Minecraft Bedrock', code: 0, crashed: false });
      if (lastLibrary && config.get().bedrockSkin && config.get().bedrockAutoSkin !== false) applyAfterExit(lastLibrary.library, lastLibrary.skinsDir);
      return;
    } else if (!up && Date.now() - t0 > 120000) {
      return; // never came up (closed at the sign-in screen, or the Store took over)
    }
    watchTimer = setTimeout(tick, runningSince ? 4000 : 2000);
  };
  watchTimer = setTimeout(tick, 1500);
}

function runningList() {
  return runningSince ? [{ pid: 0, installId: 'bedrock', installName: 'Minecraft Bedrock', startedAt: runningSince, bedrock: true }] : [];
}

// ---- servers ---------------------------------------------------------------------------------

function splitHostPort(s, fallback = DEFAULT_PORT) {
  const str = String(s || '').trim();
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(str) || /^([^:]+)(?::(\d+))?$/.exec(str);
  if (!m) return { host: str, port: fallback };
  return { host: m[1], port: Number(m[2]) || fallback };
}

// minecraftpe/external_servers.txt: "index:name:host:port:timestamp" per line.
function servers() {
  const p = currentProfile();
  let text = '';
  if (p) {
    try { text = fs.readFileSync(path.join(p.dir, 'minecraftpe', 'external_servers.txt'), 'utf8'); }
    catch { /* Partner servers are available without a saved server file. */ }
  }
  return require('./bedrock-servers').serverList(text);
}

// The pong carries no icon, but a crossplay server answers Java's status
// ping on the same host, favicon and all. CubeCraft keeps its Java side on
// another name. One try per host per run.
const JAVA_TWIN = { 'mco.cubecraft.net': 'play.cubecraft.net' };
const javaIcons = new Map();

function javaIcon(address) {
  const host = splitHostPort(address).host.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]{1,253}$/.test(host)) return Promise.resolve('');
  if (!javaIcons.has(host)) {
    const { pingServer } = require('./worlds');
    javaIcons.set(host, pingServer(JAVA_TWIN[host] || host, 3000).then((r) => (r.online && r.favicon) || '', () => ''));
  }
  return javaIcons.get(host);
}

// RakNet's unconnected ping — what the server list in the game sends.
const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');

function ping(address, timeout = 2500) {
  const { host, port } = splitHostPort(address);
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* closed */
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ online: false }), timeout);
    const t0 = Date.now();
    sock.on('error', () => finish({ online: false }));
    sock.on('message', (msg) => {
      if (msg[0] !== 0x1c || msg.length < 35) return;
      const len = msg.readUInt16BE(33);
      const f = msg.subarray(35, 35 + len).toString('utf8').split(';');
      finish({
        online: true,
        latency: Date.now() - t0,
        motd: f[1] || '',
        sub: f[7] || '',
        version: f[3] || '',
        players: { online: Number(f[4]) || 0, max: Number(f[5]) || 0, sample: [] },
      });
    });
    const buf = Buffer.alloc(33);
    buf[0] = 0x01;
    buf.writeBigInt64BE(BigInt(Date.now()), 1);
    MAGIC.copy(buf, 9);
    buf.writeBigInt64BE(BigInt.asIntN(64, BigInt(`0x${crypto.randomBytes(8).toString('hex')}`)), 25);
    sock.send(buf, port, host, (err) => err && finish({ online: false }));
  });
}

// ---- skins -----------------------------------------------------------------------------------

const skinKey = (id) => `mcl_${String(id).replace(/[^a-zA-Z0-9]/g, '')}`;

// The library as a skin pack. Version bumps on every write, so the game
// doesn't keep a cached copy of the old one.
async function writePack(library, skinsDir, { skin = null, at = -1 } = {}) {
  // Re-read at application time: an existing library file may have changed.
  const images = new Map();
  for (const entry of library) {
    try {
      const bytes = await fsp.readFile(path.join(skinsDir, entry.file));
      const img = nativeImage.createFromBuffer(bytes);
      const { width, height } = img.getSize();
      if (img.isEmpty() || !((width === 64 && (height === 64 || height === 32)) || (width === 128 && height === 128))) {
        throw new Error(`Неподходящий размер скина ${width}×${height}. Максимум — 128×128.`);
      }
      images.set(entry.file, bytes);
    } catch (e) {
      if (entry.id === skin?.id) throw e;
    }
  }
  library = library.filter(s => images.has(s.file));
  const dir = path.join(sharedDir(), 'skin_packs', PACK_NAME);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(path.join(dir, 'texts'), { recursive: true });
  const rev = ((config.get().bedrockPackRev || 0) + 1) % 100000;
  config.mutate((c) => (c.bedrockPackRev = rev), { silent: true });
  const manifest = {
    format_version: 1,
    header: { name: 'MC Launcher', uuid: PACK_UUID, version: [1, 0, rev] },
    modules: [{ type: 'skin_pack', uuid: MODULE_UUID, version: [1, 0, rev] }],
  };
  const skins = [];
  const lang = [`skinpack.${PACK_NAME}=MC Launcher`];
  // the chosen skin goes where the game's look points; should that be past
  // the end of the library, copies of it fill the gap
  let order = library;
  if (skin && at >= 0) {
    order = library.filter((s) => s.id !== skin.id);
    let fill = 0;
    while (order.length < at) order.push({ ...skin, id: `${skin.id}_${++fill}` });
    order.splice(at, 0, skin);
  }
  for (const s of order) {
    const key = skinKey(s.id);
    await fsp.writeFile(path.join(dir, `${key}.png`), images.get(s.file));
    // no "cape": Bedrock ignores it in a pack of one's own (checked on 26.52 —
    // the game joins a server with the skin and no cape)
    skins.push({ localization_name: key, geometry: s.model === 'slim' ? 'geometry.humanoid.customSlim' : 'geometry.humanoid.custom', texture: `${key}.png`, type: 'free' });
    lang.push(`skin.${PACK_NAME}.${key}=${String(s.name || key).replace(/[\r\n=]/g, ' ')}`);
  }
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fsp.writeFile(path.join(dir, 'skins.json'), JSON.stringify({ skins, serialize_name: PACK_NAME, localization_name: PACK_NAME }, null, 2));
  for (const code of ['en_US', 'ru_RU']) await fsp.writeFile(path.join(dir, 'texts', `${code}.lang`), `${lang.join('\n')}\n`);
  await fsp.writeFile(path.join(dir, 'texts', 'languages.json'), JSON.stringify(['en_US', 'ru_RU']));
  return dir;
}

// Rewrites one line of options.txt and nothing else; the first edit
// leaves a copy of the original next to it.
async function selectInOptions(profile, value) {
  const file = optionsFile(profile);
  const text = await fsp.readFile(file, 'utf8');
  const backup = `${file}.mclauncher-backup`;
  if (!fs.existsSync(backup)) await fsp.writeFile(backup, text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith('game_skintypefull:'));
  const line = `game_skintypefull:${value}`;
  if (at >= 0) {
    if (lines[at] === line) return false;
    lines[at] = line;
  } else {
    lines.splice(lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, 0, line);
  }
  const tmp = `${file}.mcl-tmp`;
  const st = await fsp.stat(file);
  await fsp.writeFile(tmp, lines.join(eol));
  await fsp.rename(tmp, file);
  // keep the file's time: it's how we tell which account played last
  await fsp.utimes(file, st.atime, st.mtime);
  return true;
}

// Puts the chosen library skin on Bedrock. Needs the game closed — it
// writes its options back when it exits — so with the game open it waits
// and does it the moment the game is gone.
let pending = null;
async function applySkin(library, skinsDir) {
  const id = config.get().bedrockSkin;
  const skin = id && library.find((s) => s.id === id);
  if (!skin) return { applied: false, reason: 'none' };
  if (!layout()) return { applied: false, reason: 'nodata' };
  const profile = currentProfile();
  if (!profile) return { applied: false, reason: 'noprofile' };
  if (await isRunning()) {
    applyAfterExit(library, skinsDir);
    return { applied: false, reason: 'running' };
  }
  const slot = wornSlot(profile);
  await writePack(library, skinsDir, { skin, at: slot.index });
  const changed = await selectInOptions(profile, `${PACK_UUID}_${skinKey(skin.id)}`);
  log.info(`Bedrock skin: ${skin.name} → profile ${profile.id}${slot.index >= 0 ? `, place ${slot.index}` : slot.known ? ', the game wears its own look' : ''}${changed ? '' : ' (already selected)'}.`);
  // a persona or another pack's skin: the game keeps that until one of ours
  // is picked in its Dressing Room once
  return { applied: true, profile: profile.id, pickOnce: slot.known && slot.index < 0 };
}

function applyAfterExit(library, skinsDir) {
  const first = !pending;
  pending = { library, skinsDir };
  if (!first) return;
  const tick = async () => {
    if (await isRunning()) {
      setTimeout(tick, 4000);
      return;
    }
    const p = pending;
    pending = null;
    // the game writes its options as it closes; let it finish
    setTimeout(() => applySkin(p.library, p.skinsDir).catch((e) => log.warn(`Bedrock skin not applied: ${e.message}`)), 2500);
  };
  setTimeout(tick, 4000);
}

// What Bedrock wears right now, from the profile's options: one of our
// library skins, a skin imported in the game (custom_skins/<id>.png),
// a built-in one (Steve, Alex, …) or a Character Creator persona, which
// isn't a picture we can draw.
const CUSTOM_PACK = 'aaaaaaaa-7b21-4637-9b63-8ad63622ef01';
const STANDARD_PACK = 'c18e65aa-7b21-4637-9b63-8ad63622ef01';
function currentSkin() {
  const p = currentProfile();
  if (!p || !p.skin) return null;
  const at = p.skin.indexOf('_');
  const pack = p.skin.slice(0, at);
  const name = p.skin.slice(at + 1);
  if (pack === PACK_UUID) return { kind: 'library', id: name.replace(/^mcl_/, '') };
  if (pack === CUSTOM_PACK) {
    for (const dir of [p.dir, sharedDir()]) {
      const file = path.join(dir, 'custom_skins', `${name}.png`);
      if (fs.existsSync(file)) return { kind: 'custom', file };
    }
    return null;
  }
  if (pack === STANDARD_PACK) return { kind: 'standard', name };
  return { kind: 'persona' };
}

// ---- launching -----------------------------------------------------------------------------

function connectUrl(address) {
  const { host, port } = splitHostPort(address);
  return `minecraft://connect/?serverUrl=${encodeURIComponent(host)}&serverPort=${port}`;
}

let lastLibrary = null;
async function launch({ server = '', library = [], skinsDir = '' } = {}) {
  lastLibrary = { library, skinsDir };
  const d = await detect();
  if (!d.installed) throw new Error('Minecraft Bedrock не установлен.');
  let skin = { applied: false, reason: 'none' };
  if (config.get().bedrockAutoSkin !== false) {
    try {
      skin = await applySkin(library, skinsDir);
    } catch (e) {
      log.warn(`Bedrock skin not applied: ${e.message}`);
      skin = { applied: false, reason: 'error', message: e.message };
    }
  }
  // the cosmetics' files ready before the game reads its own (at its start)
  if (!process.env.MCL_DATA_DIR) {
    try {
      await require('./bedrock-cosmetics').sync();
    } catch (e) {
      log.warn(`Bedrock cosmetics: ${e.message}`);
    }
  }
  // the overlay's game settings, with the field of view as the game has it now (the zoom finds its getter by it)
  try { require('./game-comfort').writeBedrock(); } catch { /* the defaults then */ }
  await shell.openExternal(server ? connectUrl(server) : 'minecraft:');
  // our module in early: the cosmetics need it there before the game loads its resources
  require('./bedrock-bridge').soon({ install: d.install, packageVersion: d.packageVersion });
  log.info(`Bedrock started${server ? ` → ${server}` : ''}.`);
  watch();
  return { skin };
}

// GDK games on Windows sign in with the account of the Xbox app; that's
// where it's switched.
async function openXboxAccount() {
  for (const url of ['xbox-settings:', 'msxbox:', 'xbox:']) {
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      /* the next app that might be there */
    }
  }
  return false;
}

function openFolder() {
  const p = currentProfile();
  return shell.openPath(p ? p.dir : sharedDir());
}

function info() {
  const d = cached();
  const list = d.installed ? profiles() : [];
  const cur = currentProfile();
  return {
    ...d,
    running: !!runningSince,
    profiles: list.map(({ id, lastPlayed }) => ({ id, lastPlayed })),
    profile: cur ? cur.id : '',
    signedIn: list[0] ? list[0].xuid : '',
    pickOnce: cur ? (() => { const s = wornSlot(cur); return s.known && s.index < 0 && !!config.get().bedrockSkin; })() : false,
    skin: config.get().bedrockSkin || '',
    autoSkin: config.get().bedrockAutoSkin !== false,
  };
}

// Where cosmetics (bedrock-cosmetics.js) put their pack and switch it on.
async function packTarget() {
  const d = await detect();
  if (!d.installed || !d.install || !layout()) return null;
  let profiles = [];
  try { profiles = profileDirs().map((p) => p.dir); } catch { /* no profile yet */ }
  return { install: d.install, packageVersion: d.packageVersion, shared: sharedDir(), profiles };
}

module.exports = {
  detect,
  cached,
  packTarget,
  openStore,
  info,
  launch,
  applySkin,
  currentSkin,
  servers,
  ping,
  javaIcon,
  signedInXuid,
  fieldOfView,
  optionHint,
  openXboxAccount,
  openFolder,
  runningList,
  isRunning,
  onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
