'use strict';
// Skins and capes.
//
// Local library in %APPDATA%\MCLauncher\skins — same skins.json/png layout
// as v1. Unsupported texture sizes are rejected without resizing:
//
//   skins.json        [{id, name, model, file}]
//   <id>.png          64x64 or 128x128 RGBA (legacy skins converted on import)
//   active_skin.png   copy of the skin last applied (+ active_skin.json)
//
// Applying a library skin is local for every account, including Microsoft.
// The original Mojang profile is never uploaded or replaced by this action.
// PNG capes use the same local layer. Other MC Launcher clients discover it
// via nearby.js or the party. Bedrock retains its regular skin pack import;
// custom capes and the local Java rendering extension are not Bedrock features.
//
//   capes/capes.json  [{id, name, file, kind, owner (XUID), sha, width, height}]
//   capes/<id>.png    the texture

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { nativeImage } = require('electron');
const paths = require('./paths');
const net = require('./net');
const auth = require('./auth');
const config = require('./config');
const log = require('./log');
const bedrock = require('./bedrock');

const META = path.join(paths.skinsDir, 'skins.json');
const ACTIVE_PNG = path.join(paths.skinsDir, 'active_skin.png');
const ACTIVE_META = path.join(paths.skinsDir, 'active_skin.json');
const PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const SKIN_UPLOAD_URL = 'https://api.minecraftservices.com/minecraft/profile/skins';
const ACTIVE_CAPE_URL = 'https://api.minecraftservices.com/minecraft/profile/capes/active';
const SESSION_URL = 'https://sessionserver.mojang.com/session/minecraft/profile/';
const NAME_LOOKUP_URL = 'https://api.mojang.com/users/profiles/minecraft/';

// ---- local cape library ------------------------------------------------------

const CAPES_META = path.join(paths.capesDir, 'capes.json');
const kindOf = (c) => (c.kind === 'custom' ? 'custom' : 'bedrock');

function readCapes() {
  try {
    const l = JSON.parse(fs.readFileSync(CAPES_META, 'utf8'));
    return Array.isArray(l) ? l.filter((c) => c && c.id && c.file && (c.owner || c.kind === 'custom')) : [];
  } catch {
    return [];
  }
}

function writeCapes(l) {
  fs.mkdirSync(paths.capesDir, { recursive: true });
  fs.writeFileSync(CAPES_META, JSON.stringify(l, null, 2), 'utf8');
}

function capeUrl(c) {
  let v = 0;
  try {
    v = Math.round(fs.statSync(path.join(paths.capesDir, c.file)).mtimeMs);
  } catch {
    v = 0;
  }
  return `mcl://user/capes/${encodeURIComponent(c.file)}?v=${v}`;
}

// whose official capes (by 2.1.13): the account's XUID
const capeOwner = (acc) => (acc && acc.type === 'xbox' && /^\d{1,20}$/.test(String(acc.xuid || '')) ? String(acc.xuid) : '');
// Every account can use the launcher cape layer.
const wearsLibrary = (acc) => !!acc;

// every cape this account may wear: its official ones, the user's
// → [{id, name, kind, url, file (on disk), width, height}]
function capeLibrary(acc) {
  if (!wearsLibrary(acc)) return [];
  const owner = capeOwner(acc);
  const all = readCapes();
  const mine = all.filter((c) => kindOf(c) === 'bedrock' && owner && c.owner === owner);
  const custom = all.filter((c) => kindOf(c) === 'custom');
  return [
    ...mine.map((c) => ({ id: c.id, name: c.name, kind: 'bedrock', url: capeUrl(c), file: path.join(paths.capesDir, c.file), width: c.width || 64, height: c.height || 32 })),
    ...custom.map((c) => ({ id: c.id, name: c.name, kind: 'custom', url: capeUrl(c), file: path.join(paths.capesDir, c.file), width: c.width || 64, height: c.height || 32 })),
  ];
}

function capes(acc = auth.activeAccount()) {
  return capeLibrary(acc).map(({ id, name, kind, url }) => ({ id, name, kind, url, worn: acc.cape === id }));
}

function capeOf(acc) {
  if (!acc || !acc.cape) return null;
  const cape = capeLibrary(acc).find((c) => c.id === acc.cape);
  try { if (cape) normalizeCape(fs.readFileSync(cape.file)); } catch { return null; }
  return cape || null;
}

// A cape PNG: 64x32 (or 2:1 HD up to 128x64), or the old 22x17 one, which is
// moved onto a 64x32 sheet → {png, width, height}
function normalizeCape(buf) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) throw new Error('Файл не похож на изображение.');
  const { width, height } = img.getSize();
  const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  if (width === 64 && height === 32) return { png: isPng ? buf : img.toPNG(), width, height };
  if (width === height * 2 && width % 64 === 0 && width <= 128) return { png: isPng ? buf : img.toPNG(), width, height };
  if (width === 22 && height === 17) {
    const src = img.toBitmap();
    const out = Buffer.alloc(64 * 32 * 4);
    for (let y = 0; y < 17; y++) src.copy(out, y * 64 * 4, y * 22 * 4, (y + 1) * 22 * 4);
    return { png: nativeImage.createFromBitmap(out, { width: 64, height: 32 }).toPNG(), width: 64, height: 32 };
  }
  throw new Error(`Неподходящий размер плаща ${width}×${height} — нужен PNG 64×32 или 128×64 (максимум).`);
}

async function addCape({ name, path: file, dataUrl }) {
  const norm = normalizeCape(await readSource({ path: file, dataUrl }));
  const sha = crypto.createHash('sha256').update(norm.png).digest('hex');
  const all = readCapes();
  const same = all.find((c) => kindOf(c) === 'custom' && c.sha === sha);
  if (same) return { ...capes().find((c) => c.id === same.id), existed: true };
  const id = crypto.randomBytes(6).toString('hex');
  const c = { id, name: String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32) || 'Плащ', file: `${id}.png`, kind: 'custom', sha, width: norm.width, height: norm.height };
  await fsp.mkdir(paths.capesDir, { recursive: true });
  await fsp.writeFile(path.join(paths.capesDir, c.file), norm.png);
  all.push(c);
  writeCapes(all);
  log.info(`Cape added: ${c.name} (${norm.width}x${norm.height}).`);
  return capes().find((x) => x.id === id);
}

function wearCape(id) {
  const acc = auth.activeAccount();
  if (!wearsLibrary(acc)) throw new Error('Сначала выберите аккаунт.');
  const capeId = String(id || '');
  const c = capeId && capeLibrary(acc).find((x) => x.id === capeId);
  if (capeId && !c) throw new Error('Плащ не найден.');
  if (c) normalizeCape(fs.readFileSync(c.file));
  config.mutate((cfg) => {
    const a = cfg.accounts.find((x) => x.id === acc.id);
    if (a) a.cape = capeId;
  });
  log.info(c ? `Cape on: ${c.name} (${c.kind}).` : 'Cape off.');
  return capes();
}

function renameCape(id, name) {
  const all = readCapes();
  const c = all.find((x) => x.id === id);
  if (!c) throw new Error('Плащ не найден.');
  c.name = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32) || c.name;
  writeCapes(all);
  return capes();
}

async function removeCape(id) {
  const all = readCapes();
  const c = all.find((x) => x.id === id);
  if (!c) throw new Error('Плащ не найден.');
  writeCapes(all.filter((x) => x.id !== id));
  await fsp.rm(path.join(paths.capesDir, c.file), { force: true });
  config.mutate((cfg) => {
    for (const a of cfg.accounts) if (a.cape === id) a.cape = '';
  });
  return capes();
}

function readMeta() {
  try {
    const list = JSON.parse(fs.readFileSync(META, 'utf8'));
    return Array.isArray(list) ? list.filter((e) => e && e.id && e.file) : [];
  } catch {
    return [];
  }
}

function writeMeta(list) {
  fs.mkdirSync(paths.skinsDir, { recursive: true });
  fs.writeFileSync(META, JSON.stringify(list, null, 2), 'utf8');
}

function activeMeta() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVE_META, 'utf8'));
  } catch {
    return null;
  }
}

function skinUrl(entry) {
  let v = 0;
  try {
    v = Math.round(fs.statSync(path.join(paths.skinsDir, entry.file)).mtimeMs);
  } catch {
    v = 0;
  }
  return `mcl://user/skins/${encodeURIComponent(entry.file)}?v=${v}`;
}

function list() {
  const active = activeMeta();

  return readMeta().map((e) => ({
    id: e.id,
    name: e.name,
    model: e.model === 'slim' ? 'slim' : 'classic',
    file: e.file,
    ...skinInfo(e),
    url: skinUrl(e),
    active: !!active && active.id === e.id,
  }));
}

// ---- image handling ---------------------------------------------------------
function skinInfo(entry) {
  try {
    const bytes = fs.readFileSync(path.join(paths.skinsDir, entry.file));
    const size = nativeImage.createFromBuffer(bytes).getSize();
    try { normalizePng(bytes); return { ...size, valid: true }; }
    catch (e) { return { ...size, valid: false, error: e.message }; }
  } catch { return { width: 0, height: 0, valid: false, error: 'Не удалось прочитать скин.' }; }
}

function resizeSkin(norm, size) {
  size = size ? Number(size) : norm.width;
  if (![64, 128].includes(size)) throw new Error('Размер скина: 64×64 или 128×128 (32x). Максимум — 128×128 пикселей.');
  if (norm.width === size) return norm;
  const src = nativeImage.createFromBuffer(norm.png).toBitmap();
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const from = (Math.floor(y * norm.height / size) * norm.width + Math.floor(x * norm.width / size)) * 4;
    src.copy(out, (y * size + x) * 4, from, from + 4);
  }
  return { png: nativeImage.createFromBitmap(out, { width: size, height: size }).toPNG(), width: size, height: size };
}

// Vanilla's own legacy-skin conversion (64x32 → 64x64): every face of the
// right arm/leg is copied, mirrored, into the new left arm/leg slots — face
// by face, not as one flipped block, so the sides land on the right sides.
const LEGACY_COPIES = [
  [4, 16, 16, 32, 4, 4], [8, 16, 16, 32, 4, 4], [0, 20, 24, 32, 4, 12], [4, 20, 16, 32, 4, 12],
  [8, 20, 8, 32, 4, 12], [12, 20, 16, 32, 4, 12], [44, 16, -8, 32, 4, 4], [48, 16, -8, 32, 4, 4],
  [40, 20, 0, 32, 4, 12], [44, 20, -8, 32, 4, 12], [48, 20, -16, 32, 4, 12], [52, 20, -8, 32, 4, 12],
];

function convertLegacy(bitmap) {
  const out = Buffer.alloc(64 * 64 * 4);
  bitmap.copy(out, 0, 0, 64 * 32 * 4);
  for (const [x, y, dx, dy, w, h] of LEGACY_COPIES) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const src = ((y + j) * 64 + (x + i)) * 4;
        const dst = ((y + dy + j) * 64 + (x + dx + (w - 1 - i))) * 4;
        out[dst] = out[src];
        out[dst + 1] = out[src + 1];
        out[dst + 2] = out[src + 2];
        out[dst + 3] = out[src + 3];
      }
    }
  }
  return out;
}

// Accepts 64x64 / 128x128 skins and converts legacy 64x32. A file that's
// already a 64x64 PNG is kept byte-for-byte — re-encoding would only risk
// shifting semi-transparent overlay pixels.
function normalizePng(buf) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) throw new Error('Файл не похож на изображение.');
  const { width, height } = img.getSize();
  const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  if (width === 64 && height === 64) return { png: isPng ? buf : img.toPNG(), width, height };
  if (width === 64 && height === 32) {
    const converted = nativeImage.createFromBitmap(convertLegacy(img.toBitmap()), { width: 64, height: 64 });
    return { png: converted.toPNG(), width: 64, height: 64, converted: true };
  }
  if (width === height && width === 128) {
    // HD skins are kept as they are for local use; Mojang won't take them.
    return { png: isPng ? buf : img.toPNG(), width, height, hd: true };
  }
  throw new Error(`Неподходящий размер скина ${width}×${height}. Нужен PNG 64×64 или 128×128 (32x). Максимум — 128×128. Файлы другого размера не принимаются.`);
}

// Slim (Alex) skins leave the outer columns of the arm area unused.
function detectModel(pngBuf) {
  try {
    const img = nativeImage.createFromBuffer(pngBuf);
    const { width, height } = img.getSize();
    if (width < 64 || width !== height || width % 64) return 'classic';
    const scale = width / 64;
    const bmp = img.toBitmap();
    const alpha = (x, y) => bmp[((y * scale) * width + x * scale) * 4 + 3];
    return alpha(54, 20) === 0 && alpha(55, 20) === 0 && alpha(54, 25) === 0 ? 'slim' : 'classic';
  } catch {
    return 'classic';
  }
}

async function readSource({ path: file, dataUrl }) {
  if (file) return fsp.readFile(file);
  if (dataUrl) {
    const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(dataUrl);
    if (!m) throw new Error('Неверные данные изображения.');
    return Buffer.from(m[1], 'base64');
  }
  throw new Error('Не выбран файл скина.');
}

async function add({ name, model, path: file, dataUrl, size }) {
  const buf = await readSource({ path: file, dataUrl });
  const norm = resizeSkin(normalizePng(buf), size);
  const id = crypto.randomBytes(6).toString('hex');
  const fileName = `${id}.png`;
  await fsp.mkdir(paths.skinsDir, { recursive: true });
  await fsp.writeFile(path.join(paths.skinsDir, fileName), norm.png);
  const entry = {
    id,
    name: String(name || '').trim().slice(0, 32) || 'Скин',
    model: model === 'slim' || model === 'classic' ? model : detectModel(norm.png),
    file: fileName,
    width: norm.width,
    height: norm.height,
  };
  const all = readMeta();
  all.push(entry);
  writeMeta(all);
  log.info(`Skin added: ${entry.name} (${entry.model}${norm.converted ? ', converted from 64x32' : ''}).`);
  return list().find((e) => e.id === id);
}

async function update(id, { name, model, path: file, dataUrl, size }) {
  const all = readMeta();
  const e = all.find((x) => x.id === id);
  if (!e) throw new Error('Скин не найден.');
  if (typeof name === 'string' && name.trim()) e.name = name.trim().slice(0, 32);
  if (model === 'slim' || model === 'classic') e.model = model;
  if (file || dataUrl || size) {
    const norm = resizeSkin(normalizePng(await readSource({ path: file || (!dataUrl ? path.join(paths.skinsDir, e.file) : ''), dataUrl })), size);
    await fsp.writeFile(path.join(paths.skinsDir, e.file), norm.png);
    e.width = norm.width; e.height = norm.height;
  }
  writeMeta(all);
  const active = activeMeta();
  if (active && active.id === id) setActiveLocal(e, active.accountId || '');
  config.mutate(() => {}); // Refresh running games when the selected PNG changed.
  return list().find((x) => x.id === id);
}

async function remove(id) {
  const all = readMeta();
  const e = all.find((x) => x.id === id);
  writeMeta(all.filter((x) => x.id !== id));
  if (e) {
    await fsp.rm(path.join(paths.skinsDir, e.file), { force: true });
    for (const f of await fsp.readdir(paths.skinsDir).catch(() => [])) {
      if (f.startsWith(`${id}_thumb`)) await fsp.rm(path.join(paths.skinsDir, f), { force: true });
    }
  }
  const active = activeMeta();
  if (active && active.id === id) {
    await fsp.rm(ACTIVE_META, { force: true });
    await fsp.rm(ACTIVE_PNG, { force: true });
  }
}

function setActiveLocal(e, accountId = (auth.activeAccount() || {}).id || '') {
  normalizePng(fs.readFileSync(path.join(paths.skinsDir, e.file))); 
  fs.mkdirSync(paths.skinsDir, { recursive: true });
  fs.copyFileSync(path.join(paths.skinsDir, e.file), ACTIVE_PNG);
  fs.writeFileSync(ACTIVE_META, JSON.stringify({ id: e.id, name: e.name, model: e.model, accountId }), 'utf8');
}

async function uploadToMojang(token, pngBuf, model) {
  const form = new FormData();
  form.append('variant', model === 'slim' ? 'slim' : 'classic');
  form.append('file', new Blob([pngBuf], { type: 'image/png' }), 'skin.png');
  try {
    return await net.request(SKIN_UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      body: form,
      timeout: 30000,
      retries: 0,
    });
  } catch (e) {
    if (e.status === 400) throw new Error('Mojang не принял скин — нужен PNG 64×64 или 64×32.');
    if (e.status === 401) throw new Error('Сессия истекла — войдите в аккаунт снова.');
    if (e.status === 429) throw new Error('Слишком часто — Mojang разрешает менять скин не чаще раза в минуту.');
    throw new Error(net.describe(e));
  }
}

// Each account remembers the library skin put on with it (acc.skin): the
// guest's skin in Java, the Bedrock skin while that account is active.
function remember(accId, skinId) {
  if (!accId) return;
  config.mutate((c) => {
    const a = c.accounts.find((x) => x.id === accId);
    if (a) a.skin = skinId;
  });
}

async function apply(id, target = 'launcher') {
  const e = readMeta().find((x) => x.id === id);
  if (!e) throw new Error('Скин не найден.');
  const acc = auth.activeAccount();
  if (target !== 'launcher' && target !== 'mojang') throw new Error('Неизвестный способ применения скина.');
  if (target === 'mojang') {
    if (!acc || acc.type !== 'msa') throw new Error('Для официального скина нужен аккаунт Microsoft с Java Edition.');
    const png = await fsp.readFile(path.join(paths.skinsDir, e.file));
    const norm = normalizePng(png);
    if (norm.width !== 64) throw new Error('Официальный скин должен быть 64×64. Выберите этот размер в редакторе скина.');
    await uploadToMojang(await auth.minecraftToken(acc.id), norm.png, e.model);
    remember(acc.id, '');
    profileCache.delete(String(acc.uuid).replace(/-/g, ''));
    return { uploaded: true };
  }
  setActiveLocal(e);
  remember(acc && acc.id, e.id);
  return { uploaded: false };
}

// The account changed: Bedrock wears that account's own pick, or the
// launcher leaves Bedrock alone (its profile keeps its own skin) — never the
// previous account's skin. Returns what applySkin said, or null.
async function followAccount() {
  const acc = auth.activeAccount();
  const library = readMeta();
  const pick = acc && acc.skin && library.some((x) => x.id === acc.skin) ? acc.skin : '';
  if (config.get().bedrockSkin === pick) return null;
  config.mutate((c) => (c.bedrockSkin = pick));
  if (!pick || !bedrock.cached().installed) return null;
  return bedrock.applySkin(list(), paths.skinsDir).catch((e) => {
    log.warn(`Bedrock skin for the account: ${e.message}`);
    return null;
  });
}

// ---- profiles (current skin/cape of an account) ------------------------------

const profileCache = new Map();

function decodeTextures(profile) {
  const prop = (profile.properties || []).find((p) => p.name === 'textures');
  if (!prop) return {};
  try {
    return JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')).textures || {};
  } catch {
    return {};
  }
}

// Public textures of any player by UUID — no token needed (session server).
async function texturesByUuid(uuid) {
  const key = String(uuid || '').replace(/-/g, '');
  if (!key) return null;
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.t < 5 * 60000) return hit.v;
  const profile = await net.getJson(SESSION_URL + key, { retries: 1, timeout: 10000 });
  const t = decodeTextures(profile);
  const v = {
    name: profile.name,
    skinUrl: t.SKIN ? t.SKIN.url.replace(/^http:/, 'https:') : '',
    model: t.SKIN && t.SKIN.metadata && t.SKIN.metadata.model === 'slim' ? 'slim' : 'classic',
    capeUrl: t.CAPE ? t.CAPE.url.replace(/^http:/, 'https:') : '',
  };
  profileCache.set(key, { t: Date.now(), v });
  return v;
}

// The signed-in account's own profile: active skin, every cape it owns.
async function accountProfile(acc = auth.activeAccount()) {
  if (!acc || acc.type !== 'msa') return null;
  const token = await auth.minecraftToken(acc.id);
  const p = await net.getJson(PROFILE_URL, { headers: { Authorization: `Bearer ${token}` }, retries: 1 });
  const skin = (p.skins || []).find((s) => s.state === 'ACTIVE') || (p.skins || [])[0];
  return {
    name: p.name,
    uuid: config.dashUuid(p.id),
    skinUrl: skin ? skin.url.replace(/^http:/, 'https:') : '',
    model: skin && String(skin.variant).toLowerCase() === 'slim' ? 'slim' : 'classic',
    capes: (p.capes || []).map((c) => ({
      id: c.id,
      alias: c.alias || 'Cape',
      url: String(c.url || '').replace(/^http:/, 'https:'),
      active: String(c.state).toUpperCase() === 'ACTIVE',
    })),
  };
}

// Mojang lets a profile's cape change about once a minute (more: HTTP 429).
// The cape asked for last is the one put on: a click while one is on its way
// only changes which (one request at a time); a 429 waits a minute and tries
// again, onWait telling the window why it takes a while.
let capeWanted = '';
let capeJob = null;
function setCape(capeId, { onWait } = {}) {
  capeWanted = capeId || '';
  if (!capeJob) capeJob = applyCape(onWait).finally(() => { capeJob = null; });
  return capeJob;
}

async function applyCape(onWait) {
  const acc = auth.activeAccount();
  if (!acc || acc.type !== 'msa') throw new Error('Плащи есть только у аккаунтов Microsoft.');
  for (let tries = 0; ; tries++) {
    const want = capeWanted;
    const token = await auth.minecraftToken(acc.id);
    try {
      if (want) {
        await net.request(ACTIVE_CAPE_URL, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ capeId: want }),
          expect: 'none',
          retries: 0,
        });
      } else {
        await net.request(ACTIVE_CAPE_URL, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, expect: 'none', retries: 0 });
      }
    } catch (e) {
      if (e.status === 429 && tries < 3) {
        log.info('Cape: Mojang asks to wait — trying again in a minute.');
        if (onWait) onWait(60000);
        await new Promise((r) => setTimeout(r, 60000));
        continue;
      }
      throw new Error(e.status === 401 ? 'Сессия истекла — войдите снова.' : e.status === 429 ? 'Mojang разрешает менять плащ не чаще раза в минуту — попробуйте чуть позже.' : net.describe(e));
    }
    if (capeWanted === want) break; // nothing else asked for meanwhile
  }
  profileCache.delete(String(acc.uuid).replace(/-/g, ''));
  wearCape('');
  log.info(capeWanted ? `Cape changed (${capeWanted}).` : 'Cape hidden.');
}

// Someone else's skin by nickname — "import from player".
async function importFromPlayer(name) {
  const nick = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{2,16}$/.test(nick)) throw new Error('Ник должен быть 2–16 символов: латиница, цифры, _.');
  let lookup;
  try {
    lookup = await net.getJson(NAME_LOOKUP_URL + encodeURIComponent(nick), { retries: 1 });
  } catch (e) {
    if (e.status === 404 || e.status === 204) throw new Error(`Игрок «${nick}» не найден.`);
    throw new Error(net.describe(e));
  }
  if (!lookup || !lookup.id) throw new Error(`Игрок «${nick}» не найден.`);
  const t = await texturesByUuid(lookup.id);
  if (!t || !t.skinUrl) throw new Error(`У игрока «${lookup.name}» стандартный скин.`);
  const png = await net.getBuffer(t.skinUrl, { retries: 1 });
  return {
    name: lookup.name,
    uuid: config.dashUuid(lookup.id),
    model: t.model,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    capeUrl: t.capeUrl,
  };
}

// What a guest or an Xbox account wears in Java: the skin put on here, or —
// for an Xbox account dressed before skins were one for both games — the
// one it wears in Bedrock. {png, model} or null.
function localSkinFor(accountId) {
  const acc = config.get().accounts.find((a) => a.id === accountId);
  if (!acc) return null;
  let cape = null;
  try {
    const c = capeOf(acc);
    if (c) cape = normalizeCape(fs.readFileSync(c.file)).png;
  } catch { /* no cape then */ }
  const skin = localSkinPng(acc);
  if (!skin && !cape) return null;
  return { png: skin ? skin.png : null, model: skin ? skin.model : 'classic', cape };
}

function localSkinPng(acc) {
  const meta = activeMeta();
  try {
    const own = acc.skin && readMeta().find((x) => x.id === acc.skin);
    if (own) normalizePng(fs.readFileSync(path.join(paths.skinsDir, own.file))); 
    if (own) return { png: fs.readFileSync(path.join(paths.skinsDir, own.file)), model: own.model === 'slim' ? 'slim' : 'classic' };
    if (acc.type !== 'msa' && meta && (!meta.accountId || meta.accountId === acc.id) && fs.existsSync(ACTIVE_PNG)) {
      normalizePng(fs.readFileSync(ACTIVE_PNG));
      return { png: fs.readFileSync(ACTIVE_PNG), model: meta.model === 'slim' ? 'slim' : 'classic' };
    }
    const worn = acc.type === 'xbox' && readMeta().find((x) => x.id === config.get().bedrockSkin);
    if (worn) normalizePng(fs.readFileSync(path.join(paths.skinsDir, worn.file))); 
    if (worn) return { png: fs.readFileSync(path.join(paths.skinsDir, worn.file)), model: worn.model === 'slim' ? 'slim' : 'classic' };
  } catch { /* no skin then */ }
  return null;
}

function activeLocalSkinUrl() {
  const m = activeMeta();
  if (!m || !fs.existsSync(ACTIVE_PNG)) return null;
  try { normalizePng(fs.readFileSync(ACTIVE_PNG)); } catch { return null; }
  const v = Math.round(fs.statSync(ACTIVE_PNG).mtimeMs);
  return { url: `mcl://user/skins/active_skin.png?v=${v}`, model: m.model === 'slim' ? 'slim' : 'classic', name: m.name };
}

async function exportSkin(id, dest) {
  const e = readMeta().find((x) => x.id === id);
  if (!e) throw new Error('Скин не найден.');
  normalizePng(fs.readFileSync(path.join(paths.skinsDir, e.file))); 
  await fsp.copyFile(path.join(paths.skinsDir, e.file), dest);
}

// One source for the lobby and account faces. Bedrock never borrows the
// previous Java/guest skin from active_skin.png.
// The skin Bedrock has on right now, when it's one we can show: a library
// skin from our pack, an imported PNG, or the standard Alex.
function bedrockWorn(library = list().filter(s => s.valid)) {
  const worn = bedrock.currentSkin();
  if (worn && worn.kind === 'library') {
    const s = library.find((x) => x.id === worn.id);
    return s ? { skinUrl: s.url, model: s.model } : null;
  }
  if (worn && worn.kind === 'custom') {
    try {
      const png = normalizePng(fs.readFileSync(worn.file)).png;
      return { skinUrl: `data:image/png;base64,${png.toString('base64')}`, model: detectModel(png) };
    } catch {
      return null;
    }
  }
  if (worn && worn.kind === 'standard' && /alex/i.test(worn.name)) return { skinUrl: 'mcl://app/assets/images/skins/alex.png', model: 'slim' };
  return null;
}

async function appearance({ edition = 'java', accountId } = {}) {
  const acc = accountId ? config.get().accounts.find((a) => a.id === accountId) : auth.activeAccount();
  if (edition === 'bedrock' || (acc && acc.type === 'xbox')) {
    const library = list().filter(s => s.valid);
    // the account's own pick ("Put on" dresses Java and Bedrock alike — and
    // still counts on a PC without Bedrock)
    const cape = capeOf(acc);
    const capeUrlOf = cape ? cape.url : '';
    const mine = acc && acc.skin && library.find((s) => s.id === acc.skin);
    if (mine) return { skinUrl: mine.url, model: mine.model, capeUrl: capeUrlOf };
    const meta = acc && acc.type === 'xbox' ? activeMeta() : null;
    const own = meta && meta.accountId === acc.id && library.find((s) => s.id === meta.id);
    if (own) return { skinUrl: own.url, model: own.model, capeUrl: capeUrlOf };
    const chosen = library.find((s) => s.id === config.get().bedrockSkin);
    if (chosen) return { skinUrl: chosen.url, model: chosen.model, capeUrl: capeUrlOf };
    // nothing picked in the launcher: show what Bedrock itself wears
    const worn = bedrockWorn(library);
    if (worn) return { skinUrl: worn.skinUrl, model: worn.model, capeUrl: capeUrlOf };
    return capeUrlOf ? { skinUrl: '', model: 'classic', capeUrl: capeUrlOf } : null;
  }
  if (acc && acc.type === 'msa') {
    const own = acc.skin && list().find(s => s.valid && s.id === acc.skin);
    const localCape = capeOf(acc);
    // The authenticated profile reflects uploads immediately; the session
    // server can keep returning the old skin for several minutes.
    try {
      const profile = await accountProfile(acc);
      if (profile && (profile.skinUrl || own)) return { ...profile, skinUrl: own ? own.url : profile.skinUrl, model: own ? own.model : profile.model, capeUrl: localCape ? localCape.url : (profile.capes.find((c) => c.active) || {}).url || '' };
    } catch { /* public textures still work when the session has expired */ }
    const publicProfile = await texturesByUuid(acc.uuid).catch(() => null);
    return { ...publicProfile, ...(own ? { skinUrl: own.url, model: own.model } : {}), capeUrl: localCape ? localCape.url : publicProfile?.capeUrl || '' };
  }
  // a guest: the library skin and cape it wears
  const cape = capeOf(acc);
  const capeUrlOf = cape ? cape.url : '';
  const mine = acc && acc.skin && list().find((s) => s.valid && s.id === acc.skin);
  if (mine) return { skinUrl: mine.url, model: mine.model, capeUrl: capeUrlOf };
  const local = activeLocalSkinUrl();
  const meta = activeMeta();
  if (local && (!meta.accountId || meta.accountId === (acc && acc.id))) {
    return { skinUrl: local.url, model: local.model, capeUrl: capeUrlOf };
  }
  return capeUrlOf ? { skinUrl: '', model: 'classic', capeUrl: capeUrlOf } : null;
}

module.exports = {
  appearance,
  followAccount,
  bedrockWorn,
  list,
  add,
  update,
  remove,
  apply,
  detectModel,
  texturesByUuid,
  accountProfile,
  setCape,
  capes,
  addCape,
  wearCape,
  renameCape,
  removeCape,
  importFromPlayer,
  activeLocalSkinUrl,
  localSkinFor,
  exportSkin,
};
