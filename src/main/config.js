'use strict';
// config.json — the launcher's settings, installations and accounts.
//
// Same file and location as the Python launcher (v1). A v1 file is migrated
// in place on first start: installations, nickname history, window size,
// RAM, accent and the Microsoft account's name/UUID all carry
// over. The v1 Microsoft token can't (it was a 24-hour Minecraft token with
// no refresh token behind it), so that account comes over marked as needing
// one more sign-in.
//
// Secrets (refresh tokens, Minecraft/Xbox tokens) are kept per account in an
// encrypted "vault" string — Electron safeStorage, which on Windows is DPAPI
// bound to this Windows user. publicView() never includes them.

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');
const paths = require('./paths');
const log = require('./log');

const CONFIG_VERSION = 2;
const DEFAULT_CLIENT_ID = process.env.MCL_MS_CLIENT_ID || '00000000-0000-0000-0000-000000000000';
// The official launcher's own defaults for G1, minus -Xmx (that one comes
// from the memory slider).
const DEFAULT_JVM_ARGS =
  '-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M';
const NICKNAME_HISTORY_MAX = 5;
const NICKNAME_MAX_LENGTH = 16;
const DEFAULT_ENTRY_PREFIX = '__latest__';

let cfg = null;
const listeners = new Set();

function systemLanguage() {
  try {
    const langs = app.getPreferredSystemLanguages ? app.getPreferredSystemLanguages() : [app.getLocale()];
    const first = String(langs[0] || app.getLocale() || 'en').toLowerCase();
    return /^(ru|uk|be|kk)/.test(first) ? 'ru' : 'en';
  } catch {
    return 'ru';
  }
}

function defaultRamMb() {
  const totalGb = os.totalmem() / 1024 ** 3;
  if (totalGb >= 15) return 4096;
  if (totalGb >= 7.5) return 3072;
  return 2048;
}

// Party voice chat: how the mic opens (voice activity, push-to-talk, always),
// devices, the activity threshold, the push-to-talk key and each friend's
// volume (by name — party member ids change every time).
function defaultVoice() {
  return { channel: 'nearby', range: 32, noise: 'rnnoise', mode: 'vad', input: '', output: '', threshold: 18, ptt: [86], pttName: 'V', muteKey: [], muteName: '', micOff: false, deaf: false, volumes: {} };
}

// The in-game overlay: who's talking (always, only while talking, never),
// where each part stands over the game (dragged in the editor: x/y as a
// share of the game's width/height, measured from the side it's anchored
// to), how big, the plates' opacity, and launcher news shown over the game
// instead of Windows' pop-ups. editKey opens the editor in the game.
const OVERLAY_SPOT = { voice: { x: 0.012, y: 0.02, ax: 'l', ay: 't' }, toasts: { x: 0.012, y: 0.02, ax: 'r', ay: 't' } };
function defaultOverlay() {
  return { enabled: true, voice: 'always', size: 'm', opacity: 70, faces: true, self: true, notifications: true, toastSeconds: 6, recordAudio: true, recordMic: true, recordOverlay: true, fps: 60, quality: 'high', replay: false, replaySeconds: 60, layout: JSON.parse(JSON.stringify(OVERLAY_SPOT)), editKey: [118], editName: 'F7', shotKey: [], shotName: '', recKey: [], recName: '', replayKey: [], replayName: '' };
}

// The overlay's game settings (Java and Bedrock alike, src/main/game-comfort.js):
// full brightness, a zoom on a key (held; the wheel while held), VSync as the
// game has it or forced on/off, sprinting by itself, no fire over the screen.
// zoomKey: the key's KeyboardEvent.code (game-comfort.js knows each game's number for it).
function defaultGame() {
  return { fullbright: false, zoom: true, zoomKey: 'KeyC', zoomLevel: 4, zoomSmooth: true, vsync: 'game', autoSprint: false, noFire: false };
}

function sanitizeGame(v) {
  const o = v && typeof v === 'object' ? v : {};
  const d = defaultGame();
  return {
    fullbright: !!o.fullbright,
    zoom: o.zoom !== false,
    zoomKey: typeof o.zoomKey === 'string' && /^[A-Za-z0-9]{1,16}$/.test(o.zoomKey) ? o.zoomKey : d.zoomKey,
    zoomLevel: Number.isFinite(Number(o.zoomLevel)) ? Math.max(1.5, Math.min(10, Math.round(Number(o.zoomLevel) * 10) / 10)) : d.zoomLevel,
    zoomSmooth: o.zoomSmooth !== false,
    vsync: ['game', 'on', 'off'].includes(o.vsync) ? o.vsync : d.vsync,
    autoSprint: !!o.autoSprint,
    noFire: !!o.noFire,
  };
}

function sanitizeSpot(v, d) {
  const o = v && typeof v === 'object' ? v : {};
  const share = (n, def) => (Number.isFinite(Number(n)) ? Math.max(0, Math.min(1, Number(n))) : def);
  return { x: share(o.x, d.x), y: share(o.y, d.y), ax: o.ax === 'r' ? 'r' : o.ax === 'l' ? 'l' : d.ax, ay: o.ay === 'b' ? 'b' : o.ay === 't' ? 't' : d.ay };
}

function sanitizeOverlay(v) {
  const o = v && typeof v === 'object' ? v : {};
  const d = defaultOverlay();
  // 2.1.20 betas kept a corner instead of a layout
  const corner = { tl: ['l', 't'], tr: ['r', 't'], bl: ['l', 'b'], br: ['r', 'b'] }[o.corner];
  const layout = o.layout && typeof o.layout === 'object' ? o.layout : corner ? { voice: { x: 0.012, y: 0.02, ax: corner[0], ay: corner[1] }, toasts: { x: 0.012, y: 0.02, ax: corner[0] === 'l' ? 'r' : 'l', ay: 't' } } : {};
  const n = (x, min, max, def) => (Number.isFinite(Number(x)) ? Math.max(min, Math.min(max, Math.round(Number(x)))) : def);
  const keys = (k) => (Array.isArray(k) ? k.map(Number).filter((x) => Number.isInteger(x) && x > 0 && x < 256).slice(0, 3) : []);
  return {
    enabled: o.enabled !== false,
    voice: ['always', 'speaking', 'off'].includes(o.voice) ? o.voice : d.voice,
    size: ['s', 'm', 'l', 'xl'].includes(o.size) ? o.size : d.size,
    opacity: n(o.opacity, 0, 100, d.opacity),
    faces: o.faces !== false,
    self: o.self !== false,
    notifications: o.notifications !== false,
    toastSeconds: [3, 6, 10].includes(Number(o.toastSeconds)) ? Number(o.toastSeconds) : d.toastSeconds,
    layout: { voice: sanitizeSpot(layout.voice, OVERLAY_SPOT.voice), toasts: sanitizeSpot(layout.toasts, OVERLAY_SPOT.toasts) },
    editKey: Array.isArray(o.editKey) ? o.editKey.map(Number).filter((k) => Number.isInteger(k) && k > 0 && k < 256).slice(0, 3) : d.editKey,
    editName: typeof o.editName === 'string' ? o.editName.slice(0, 24) : Array.isArray(o.editKey) ? '' : d.editName,
    recordAudio: o.recordAudio !== false,
    recordMic: o.recordMic !== false,
    recordOverlay: o.recordOverlay !== false,
    fps: Number(o.fps) === 30 ? 30 : 60,
    quality: ['normal', 'high', 'max'].includes(o.quality) ? o.quality : 'high',
    replay: !!o.replay,
    replaySeconds: [60, 120, 300, 600, 1800].includes(Number(o.replaySeconds)) ? Number(o.replaySeconds) : 60,
    replayKey: keys(o.replayKey),
    replayName: typeof o.replayName === 'string' ? o.replayName.slice(0, 24) : '',
    shotKey: keys(o.shotKey),
    shotName: typeof o.shotName === 'string' ? o.shotName.slice(0, 24) : '',
    recKey: keys(o.recKey),
    recName: typeof o.recName === 'string' ? o.recName.slice(0, 24) : '',
  };
}

function sanitizeVoice(v) {
  const d = defaultVoice();
  const o = v && typeof v === 'object' ? v : {};
  const volumes = {};
  for (const [name, n] of Object.entries(o.volumes && typeof o.volumes === 'object' ? o.volumes : {}).slice(0, 200)) {
    const x = Number(n);
    if (Number.isFinite(x)) volumes[String(name).slice(0, 32)] = Math.max(0, Math.min(100, Math.round(x)));
  }
  return {
    channel: o.channel === 'party' ? 'party' : 'nearby',
    range: [16, 32, 64].includes(o.range) ? o.range : 32,
    noise: ['rnnoise', 'standard', 'off'].includes(o.noise) ? o.noise : d.noise,
    mode: ['vad', 'ptt', 'open'].includes(o.mode) ? o.mode : d.mode,
    input: typeof o.input === 'string' ? o.input.slice(0, 200) : '',
    output: typeof o.output === 'string' ? o.output.slice(0, 200) : '',
    threshold: Number.isFinite(Number(o.threshold)) ? Math.max(0, Math.min(100, Math.round(Number(o.threshold)))) : d.threshold,
    ptt: Array.isArray(o.ptt) ? o.ptt.map(Number).filter((k) => Number.isInteger(k) && k > 0 && k < 256).slice(0, 3) : d.ptt,
    pttName: typeof o.pttName === 'string' ? o.pttName.slice(0, 24) : d.pttName,
    muteKey: Array.isArray(o.muteKey) ? o.muteKey.map(Number).filter((k) => Number.isInteger(k) && k > 0 && k < 256).slice(0, 3) : [],
    muteName: typeof o.muteName === 'string' ? o.muteName.slice(0, 24) : '',
    micOff: !!o.micOff,
    deaf: !!o.deaf,
    volumes,
  };
}

function defaults() {
  return {
    configVersion: CONFIG_VERSION,
    language: systemLanguage(),
    voice: defaultVoice(),
    overlay: defaultOverlay(),
    game: defaultGame(),
    gameDir: paths.defaultGameDir,
    javaMode: 'auto',
    javaPath: '',
    ramMb: defaultRamMb(),
    jvmArgs: DEFAULT_JVM_ARGS,
    windowWidth: 854,
    windowHeight: 480,
    fullscreen: false,
    gamePriority: 'normal',
    closeToTray: true,
    hideOnLaunch: true,
    showConsole: false,
    autostart: false,
    // Windows notifications at all (friends, failed downloads, crashes);
    // notifyFriends narrows it to the friends ones.
    notifications: true,
    notifyFriends: true,
    notifyMessages: true,
    inAppLogin: true,
    accentColor: '',
    sheen: true,
    reduceMotion: false,
    // The home screen "lobby": the player's skin on an accent-coloured
    // stage with pixel particles behind it.
    lobbyParticles: 'auto',
    // Bedrock: the library skin it wears ('' = leave the game's own), put
    // back on at every start; the Bedrock profile ('' = the latest one).
    bedrockSkin: '',
    bedrockAutoSkin: true,
    bedrockProfile: '',
    // cosmetics in Bedrock through our global resource pack (bedrock-cosmetics.js),
    // and our name there as the game last showed it
    bedrockCosmetics: false,
    bedrockName: '',
    // the skin agent: our skin and the party's in Java (game-skins.js)
    gameSkins: true,
    // Discord shows "Playing MC Launcher" and what's running (discord.js);
    // the server's address only with discordServer
    discord: true,
    discordServer: true,
    // friends on Discord can ask to join our party (the join secret)
    discordJoin: true,
    bedrockStats: null,
    bedrockPackRev: 0,
    // party relay (MQTT over WebSocket); '' = the built-in public ones
    partyRelay: '',
    // Xbox friends with MC Launcher see our open lobby and join without a code
    partyFriends: true,
    msClientId: DEFAULT_CLIENT_ID,
    accounts: [],
    activeAccount: '',
    nicknameHistory: [],
    installs: [],
    selectedInstall: '',
    defaultVersion: '',
    windowState: null,
    consoleWindowState: null,
    trayHintShown: false,
  };
}

// UUID the vanilla game itself derives for an offline player:
// UUID.nameUUIDFromBytes("OfflinePlayer:" + name), i.e. a version-3 UUID of
// the raw MD5 with no namespace. (v1 used Python's uuid3 with a namespace,
// which is a different UUID — harmless, but this one matches the game.)
function offlineUuid(name) {
  const b = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function dashUuid(id) {
  const h = String(id || '').replace(/-/g, '').toLowerCase();
  if (h.length !== 32) return String(id || '');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function normalizeInstall(e) {
  return {
    id: String(e.id || ''),
    name: String(e.name || 'Installation'),
    mcVersion: String(e.mcVersion || ''),
    loader: ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(e.loader) ? e.loader : 'vanilla',
    loaderVersion: String(e.loaderVersion || ''),
    iconId: String(e.iconId || 'grass'),
    created: Number(e.created) || Date.now(),
    lastPlayed: Number(e.lastPlayed) || 0,
    playTimeMs: Number(e.playTimeMs) || 0,
    ramMb: Number(e.ramMb) || 0,
    jvmArgs: typeof e.jvmArgs === 'string' ? e.jvmArgs : '',
    javaPath: typeof e.javaPath === 'string' ? e.javaPath : '',
  };
}

function offlineAccount(name) {
  const clean = String(name || 'Player').trim().slice(0, NICKNAME_MAX_LENGTH) || 'Player';
  return { id: `offline:${clean.toLowerCase()}`, type: 'offline', name: clean, uuid: offlineUuid(clean) };
}

function migrateV1(raw) {
  const c = defaults();
  c.language = systemLanguage();
  if (raw.gameDir) c.gameDir = raw.gameDir;
  const jp = String(raw.javaPath || '');
  // The v1 default was its own bundled JRE (pyapp\jre) or plain "java";
  // both mean "let the launcher pick", which is now the Mojang runtime that
  // each version asks for.
  if (jp && jp !== 'java' && !/[\\/]jre[\\/]bin[\\/]java(w)?\.exe$/i.test(jp)) {
    c.javaMode = 'custom';
    c.javaPath = jp;
  }
  if (Number(raw.ramMb) >= 512) c.ramMb = Number(raw.ramMb);
  if (Number(raw.windowWidth) >= 320) c.windowWidth = Number(raw.windowWidth);
  if (Number(raw.windowHeight) >= 240) c.windowHeight = Number(raw.windowHeight);
  if (raw.msClientId) c.msClientId = raw.msClientId;
  if (typeof raw.accentColor === 'string') c.accentColor = raw.accentColor;
  if (typeof raw.showConsole === 'boolean') c.showConsole = raw.showConsole;
  if (typeof raw.inAppLogin === 'boolean') c.inAppLogin = raw.inAppLogin;
  if (raw.defaultVersion) c.defaultVersion = raw.defaultVersion;
  c.installs = (Array.isArray(raw.installs) ? raw.installs : []).map(normalizeInstall).filter((e) => e.id);
  c.nicknameHistory = (Array.isArray(raw.nicknameHistory) ? raw.nicknameHistory : [])
    .filter((n) => typeof n === 'string' && n.trim())
    .slice(-NICKNAME_HISTORY_MAX);

  const offline = offlineAccount(raw.nickname || 'Player');
  c.accounts.push(offline);
  if (raw.msNickname && raw.msUuid) {
    const uuid = dashUuid(raw.msUuid);
    c.accounts.unshift({
      id: `msa:${uuid.replace(/-/g, '')}`,
      type: 'msa',
      name: raw.msNickname,
      uuid,
      needsLogin: true,
    });
  }
  const msa = c.accounts.find((a) => a.type === 'msa');
  c.activeAccount = raw.accountType === 'microsoft' && msa ? msa.id : offline.id;
  log.info(`Migrated v1 config: ${c.installs.length} installation(s), ${c.accounts.length} account(s).`);
  return c;
}

function sanitize(raw) {
  const c = Object.assign(defaults(), raw);
  c.configVersion = CONFIG_VERSION;
  c.installs = (Array.isArray(c.installs) ? c.installs : []).map(normalizeInstall).filter((e) => e.id);
  // signing in is through Xbox (Microsoft) only: the old guest names go — an
  // account's own Java nick (javaNick) does what they did
  c.accounts = (Array.isArray(c.accounts) ? c.accounts : []).filter((a) => a && a.id && a.type && a.type !== 'offline' && a.type !== 'guest');
  for (const a of c.accounts) if (a.javaNick !== undefined && !NICK.test(String(a.javaNick))) delete a.javaNick;
  if (!c.accounts.some((a) => a.id === c.activeAccount)) c.activeAccount = c.accounts[0] ? c.accounts[0].id : '';
  c.ramMb = Math.max(512, Math.min(65536, Number(c.ramMb) || defaultRamMb()));
  c.voice = sanitizeVoice(c.voice);
  c.overlay = sanitizeOverlay(c.overlay);
  c.game = sanitizeGame(c.game);
  c.partyFriends = c.partyFriends !== false;
  if (!c.msClientId) c.msClientId = DEFAULT_CLIENT_ID;
  if (!/^(#[0-9a-f]{6})?$/i.test(String(c.accentColor || ''))) c.accentColor = '';
  for (const k of ['gameSkins', 'discord', 'discordServer', 'discordJoin']) c[k] = c[k] !== false;
  // skins became per account: the one Bedrock wore belongs to whoever was active
  const active = c.accounts.find((a) => a.id === c.activeAccount);
  if (active && c.bedrockSkin && !active.skin) active.skin = c.bedrockSkin;
  // settings of features that are gone (home-screen key art, saved pose;
  // skins are one for Java and Bedrock now)
  for (const k of ['customWallpaper', 'lobbyBackground', 'lobbyPose', 'bedrockSync']) delete c[k];
  return c;
}

function load() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(paths.configPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn(`config.json unreadable (${e.message}) — starting from defaults.`);
  }
  if (raw && !raw.configVersion) {
    // Keep the v1 file next to the new one, once, in case anything needs
    // to be looked up from it later.
    try {
      // without its token: that one stays out of every file
      const copy = JSON.parse(JSON.stringify(raw));
      require('./hygiene').stripSecrets(copy);
      fs.writeFileSync(paths.configPath.replace(/\.json$/, '.v1.json'), JSON.stringify(copy, null, 2));
    } catch {
      /* best effort */
    }
    cfg = sanitize(migrateV1(raw));
    save();
  } else {
    cfg = sanitize(raw || {});
    if (!raw) save();
  }
  return cfg;
}

function save() {
  if (!cfg) return;
  fs.mkdirSync(paths.appDir, { recursive: true });
  const tmp = `${paths.configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, paths.configPath);
}

function emit() {
  const view = publicView();
  for (const fn of listeners) {
    try {
      fn(view);
    } catch {
      /* ignore */
    }
  }
}

function get() {
  return cfg;
}

const EDITABLE = new Set([
  'language', 'gameDir', 'javaMode', 'javaPath', 'ramMb', 'jvmArgs', 'windowWidth', 'windowHeight',
  'fullscreen', 'gamePriority', 'closeToTray', 'hideOnLaunch', 'showConsole', 'autostart', 'notifications', 'notifyFriends', 'notifyMessages',
  'inAppLogin', 'accentColor', 'sheen', 'reduceMotion', 'selectedInstall', 'lobbyParticles',
  'bedrockAutoSkin', 'bedrockProfile', 'bedrockCosmetics', 'voice', 'overlay', 'game', 'partyFriends', 'partyRelay', 'gameSkins', 'discord', 'discordServer', 'discordJoin',
]);

// Settings coming from the renderer: only whitelisted keys, so a page can
// never write accounts/installs/secrets through this door.
function updateSettings(patch) {
  if (patch && 'partyRelay' in patch) {
    const value = String(patch.partyRelay || '').trim();
    if (value) {
      let u;
      try { u = new URL(value); } catch { throw new Error('Неверный адрес ретранслятора.'); }
      if (!['wss:', 'ws:', 'mqtts:', 'mqtt:'].includes(u.protocol) || !u.hostname || u.username || u.password || value.length > 512)
        throw new Error('Укажите адрес wss://, ws://, mqtts:// или mqtt:// без логина и пароля.');
    }
    patch = { ...patch, partyRelay: value };
  }
  for (const [k, v] of Object.entries(patch || {})) {
    if (EDITABLE.has(k)) cfg[k] = v;
  }
  cfg = sanitize(cfg);
  save();
  emit();
  return publicView();
}

// Internal updates (installs, accounts, window state…).
function mutate(fn, { silent = false } = {}) {
  fn(cfg);
  save();
  if (!silent) emit();
}

function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const NICK = /^[A-Za-z0-9_]{3,16}$/;

// The name an account plays Java under, its own choice: '' — its own name back
// (a licence's; without one, the gamertag's). With a nick of its own a
// licence plays offline too (servers that check licences won't let it in).
function setJavaNick(id, nick) {
  nick = String(nick || '').trim();
  if (nick && !NICK.test(nick)) throw new Error('Ник: 3–16 латинских букв, цифр или _.');
  const a = cfg.accounts.find((x) => x.id === id);
  if (!a) throw new Error('Нет такого аккаунта.');
  if (nick) a.javaNick = nick;
  else delete a.javaNick;
  save();
  emit();
  return publicAccount(a);
}

function publicAccount(a) {
  return {
    id: a.id,
    type: a.type,
    name: a.name,
    uuid: a.uuid,
    xuid: a.xuid || '',
    gamertag: a.gamertag || '',
    bedrock: !!a.bedrock,
    skin: a.skin || '',
    cape: a.cape || '',
    needsLogin: (a.type === 'msa' || a.type === 'xbox') && (!!a.needsLogin || !a.vault),
    javaNick: a.javaNick || '',
  };
}

function publicView() {
  const c = cfg;
  const out = {};
  for (const k of EDITABLE) out[k] = c[k];
  out.accounts = c.accounts.map(publicAccount);
  out.activeAccount = c.activeAccount;
  out.nicknameHistory = c.nicknameHistory.slice();
  out.installs = c.installs.map((e) => ({ ...e }));
  out.defaultGameDir = paths.defaultGameDir;
  out.defaultJvmArgs = DEFAULT_JVM_ARGS;
  return out;
}

// ---- secrets ------------------------------------------------------------

function encrypt(obj) {
  const text = JSON.stringify(obj);
  if (safeStorage.isEncryptionAvailable()) {
    return `v1:${safeStorage.encryptString(text).toString('base64')}`;
  }
  // No DPAPI (shouldn't happen on Windows): refuse to persist secrets in
  // the clear — the session then simply lasts until the launcher closes.
  return '';
}

function decrypt(blob) {
  if (!blob || !blob.startsWith('v1:')) return null;
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(blob.slice(3), 'base64')));
  } catch {
    return null;
  }
}

const memorySecrets = new Map();

function getSecrets(accountId) {
  if (memorySecrets.has(accountId)) return memorySecrets.get(accountId);
  const a = cfg.accounts.find((x) => x.id === accountId);
  const s = a && a.vault ? decrypt(a.vault) : null;
  if (s) {
    memorySecrets.set(accountId, s);
    for (const v of Object.values(s)) log.secret(v);
  }
  return s;
}

function setSecrets(accountId, secrets) {
  memorySecrets.set(accountId, secrets);
  for (const v of Object.values(secrets || {})) log.secret(v);
  const a = cfg.accounts.find((x) => x.id === accountId);
  if (!a) return;
  a.vault = secrets ? encrypt(secrets) : undefined;
  if (!a.vault) delete a.vault;
  save();
}

// ---- game paths ----------------------------------------------------------

const path = require('path');
const gameDir = () => (cfg && cfg.gameDir) || paths.defaultGameDir;
const dirs = {
  game: gameDir,
  versions: () => path.join(gameDir(), 'versions'),
  libraries: () => path.join(gameDir(), 'libraries'),
  assets: () => path.join(gameDir(), 'assets'),
  runtime: () => path.join(gameDir(), 'runtime'),
  instances: () => path.join(gameDir(), 'instances'),
  instance: (id) => path.join(gameDir(), 'instances', id),
};

function ensureGameDirs() {
  for (const d of [paths.appDir, dirs.game(), dirs.versions(), dirs.libraries(), dirs.assets(), dirs.instances()]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function makeInstallId(name) {
  const base =
    String(name)
      .toLowerCase()
      .replace(/[\s_-]+/g, '_')
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 32) || 'install';
  return `${base}_${crypto.randomBytes(2).toString('hex')}`;
}

function rememberNickname(name) {
  const n = String(name || '').trim();
  if (!n) return;
  cfg.nicknameHistory = cfg.nicknameHistory.filter((x) => x !== n);
  cfg.nicknameHistory.push(n);
  if (cfg.nicknameHistory.length > NICKNAME_HISTORY_MAX) {
    cfg.nicknameHistory = cfg.nicknameHistory.slice(-NICKNAME_HISTORY_MAX);
  }
}

module.exports = {
  CONFIG_VERSION,
  DEFAULT_CLIENT_ID,
  DEFAULT_JVM_ARGS,
  DEFAULT_ENTRY_PREFIX,
  NICKNAME_MAX_LENGTH,
  load,
  save,
  get,
  mutate,
  updateSettings,
  onChange,
  publicView,
  publicAccount,
  setJavaNick,
  getSecrets,
  setSecrets,
  offlineUuid,
  offlineAccount,
  dashUuid,
  normalizeInstall,
  makeInstallId,
  rememberNickname,
  dirs,
  ensureGameDirs,
  isDefaultEntry: (e) => !!e && String(e.id || '').startsWith(DEFAULT_ENTRY_PREFIX),
  makeDefaultEntry: (version) =>
    normalizeInstall({
      id: DEFAULT_ENTRY_PREFIX + version,
      name: version,
      mcVersion: version,
      loader: 'vanilla',
      iconId: 'grass',
    }),
};
