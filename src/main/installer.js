'use strict';
// Downloads whatever an installation is missing and produces a launch spec.
//
// Shared storage (versions/, libraries/, assets/, runtime/) under the game
// directory, private game folder per installation (instances/<id>) — same
// layout as v1 and compatible with the official launcher's files.
//
// The fast path matters: on every Launch this walks the whole version
// (~115 libraries, ~4600 asset objects) but only stat()s files; anything
// already present with the right size is trusted, anything downloaded is
// SHA-1-verified as it streams (net.download). A full hash pass over the
// existing files is the "Verify files" action (repair: true), done by the
// C++ module on all cores.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const net = require('./net');
const config = require('./config');
const versions = require('./versions');
const java = require('./java');
const native = require('./native');
const worlds = require('./worlds');
const log = require('./log');

const OS_NAME = 'windows';
const LIBRARIES_BASE = 'https://libraries.minecraft.net/';
const RESOURCES_BASE = 'https://resources.download.minecraft.net/';

class InstallError extends Error {}

// ---- progress ------------------------------------------------------------------
// Each stage owns a slice of the overall bar; inside a stage progress is by
// bytes when sizes are known and by file count otherwise.

const WEIGHTS = { meta: 2, loader: 6, java: 17, client: 5, libraries: 15, natives: 1, assets: 52, verify: 0, finish: 2 };
const ORDER = ['meta', 'loader', 'java', 'client', 'libraries', 'natives', 'assets', 'finish'];

class Progress {
  constructor(onProgress, signal) {
    this.cb = onProgress;
    this.signal = signal;
    this.stage = 'meta';
    this.done = 0;
    this.total = 0;
    this.bytesDone = 0;
    this.bytesTotal = 0;
    this.lastEmit = 0;
    this.samples = [];
    this.extra = {};
  }
  check() {
    if (this.signal && this.signal.aborted) throw net.abortError();
  }
  begin(stage, { total = 0, bytesTotal = 0, extra = {} } = {}) {
    this.check();
    this.stage = stage;
    this.done = 0;
    this.total = total;
    this.bytesDone = 0;
    this.bytesTotal = bytesTotal;
    this.extra = extra;
    this.emit(true);
  }
  file(n = 1) {
    this.done += n;
    this.emit();
  }
  bytes(n) {
    this.bytesDone += n;
    const now = Date.now();
    this.samples.push([now, n]);
    this.emit();
  }
  speed() {
    const now = Date.now();
    while (this.samples.length && now - this.samples[0][0] > 2500) this.samples.shift();
    if (!this.samples.length) return 0;
    const sum = this.samples.reduce((s, x) => s + x[1], 0);
    const span = Math.max(500, now - this.samples[0][0]);
    return Math.max(0, (sum * 1000) / span);
  }
  fraction() {
    let before = 0;
    let all = 0;
    for (const s of ORDER) all += WEIGHTS[s];
    for (const s of ORDER) {
      if (s === this.stage) break;
      before += WEIGHTS[s];
    }
    let within = 0;
    if (this.bytesTotal > 0) within = Math.min(1, this.bytesDone / this.bytesTotal);
    else if (this.total > 0) within = Math.min(1, this.done / this.total);
    return Math.min(1, (before + within * (WEIGHTS[this.stage] || 0)) / all);
  }
  emit(force = false) {
    if (!this.cb) return;
    const now = Date.now();
    if (!force && now - this.lastEmit < 90) return;
    this.lastEmit = now;
    this.cb({
      stage: this.stage,
      fraction: this.fraction(),
      done: this.done,
      total: this.total,
      bytesDone: this.bytesDone,
      bytesTotal: this.bytesTotal,
      speed: this.speed(),
      ...this.extra,
    });
  }
}

// ---- rules & arguments -----------------------------------------------------------

function ruleMatches(rule, features) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== OS_NAME) return false;
    // Only "x86" ever appears here; this launcher is x64-only.
    if (rule.os.arch && !/^(x64|x86_64|amd64)$/.test(rule.os.arch)) return false;
  }
  if (rule.features) {
    for (const [k, v] of Object.entries(rule.features)) if (!!features[k] !== !!v) return false;
  }
  return true;
}

function allowed(entry, features = {}) {
  const rules = entry && entry.rules;
  if (!rules || !rules.length) return true;
  let result = false;
  for (const r of rules) if (ruleMatches(r, features)) result = r.action === 'allow';
  return result;
}

function collectArgs(list, features) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object' && allowed(item, features)) {
      if (Array.isArray(item.value)) out.push(...item.value);
      else if (typeof item.value === 'string') out.push(item.value);
    }
  }
  return out;
}

function supportsQuickPlay(merged) {
  for (const item of (merged.arguments && merged.arguments.game) || []) {
    if (item && typeof item === 'object') {
      for (const r of item.rules || []) if (r.features && 'is_quick_play_singleplayer' in r.features) return true;
    }
  }
  return false;
}

// ---- libraries ---------------------------------------------------------------------

function mavenPath(name) {
  let n = String(name);
  let ext = 'jar';
  const at = n.indexOf('@');
  if (at >= 0) {
    ext = n.slice(at + 1);
    n = n.slice(0, at);
  }
  const [group, artifact, version, classifier] = n.split(':');
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
}

function libKey(name) {
  const [g, a, , c] = String(name || '').split(':');
  return `${g}:${a}${c ? `:${c}` : ''}`;
}

function resolveArtifact(lib) {
  const libDir = config.dirs.libraries();
  const art = lib.downloads && lib.downloads.artifact;
  if (art) {
    const rel = art.path || (lib.name ? mavenPath(lib.name) : null);
    if (!rel) return null;
    return { file: path.join(libDir, rel), url: art.url || '', sha1: art.sha1 || '', size: art.size || 0 };
  }
  // A library that only carries legacy natives classifiers has no main jar.
  if (lib.downloads && lib.downloads.classifiers && !lib.name) return null;
  if (lib.natives && lib.downloads && lib.downloads.classifiers) return null;
  if (!lib.name) return null;
  const rel = mavenPath(lib.name);
  let base = lib.url || LIBRARIES_BASE;
  if (!base.endsWith('/')) base += '/';
  return { file: path.join(libDir, rel), url: base + rel, sha1: lib.sha1 || '', size: lib.size || 0 };
}

function resolveNative(lib) {
  if (!lib.natives || !lib.natives[OS_NAME]) return null;
  const classifier = lib.natives[OS_NAME].replace('${arch}', '64');
  const art = lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[classifier];
  const libDir = config.dirs.libraries();
  const exclude = (lib.extract && lib.extract.exclude) || ['META-INF/'];
  if (art) return { file: path.join(libDir, art.path), url: art.url, sha1: art.sha1, size: art.size, exclude };
  if (!lib.name) return null;
  const rel = mavenPath(`${lib.name}:${classifier}`);
  let base = lib.url || LIBRARIES_BASE;
  if (!base.endsWith('/')) base += '/';
  return { file: path.join(libDir, rel), url: base + rel, sha1: '', size: 0, exclude };
}

// ---- version JSONs ------------------------------------------------------------------

const versionJsonPath = (id) => path.join(config.dirs.versions(), id, `${id}.json`);

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

async function ensureVanillaJson(mc, signal) {
  const file = versionJsonPath(mc);
  try {
    return await readJson(file);
  } catch {
    /* not downloaded yet */
  }
  const manifest = await versions.fetchManifest();
  const v = manifest.versions.find((x) => x.id === mc);
  if (!v) throw new InstallError(`Версия ${mc} не найдена в списке Mojang.`);
  await net.download(v.url, file, { sha1: v.sha1, signal });
  return readJson(file);
}

function mergeVersions(parent, child) {
  const m = { ...parent, ...child };
  m.libraries = [...(child.libraries || []), ...(parent.libraries || [])];
  if (parent.arguments || child.arguments) {
    m.arguments = {
      game: [...((parent.arguments && parent.arguments.game) || []), ...((child.arguments && child.arguments.game) || [])],
      jvm: [...((parent.arguments && parent.arguments.jvm) || []), ...((child.arguments && child.arguments.jvm) || [])],
    };
  }
  m.minecraftArguments = child.minecraftArguments || parent.minecraftArguments;
  m.downloads = child.downloads || parent.downloads;
  m.assetIndex = child.assetIndex || parent.assetIndex;
  m.assets = child.assets || parent.assets;
  m.javaVersion = child.javaVersion || parent.javaVersion;
  m.logging = child.logging || parent.logging;
  delete m.inheritsFrom;
  return m;
}

async function resolveChain(id, signal, depth = 0) {
  if (depth > 6) throw new InstallError('Слишком длинная цепочка inheritsFrom.');
  let data;
  try {
    data = await readJson(versionJsonPath(id));
  } catch {
    data = await ensureVanillaJson(id, signal);
  }
  if (!data.inheritsFrom) return data;
  const parent = await resolveChain(data.inheritsFrom, signal, depth + 1);
  return mergeVersions(parent, data);
}

// ---- loaders ----------------------------------------------------------------------------

const cleanLoaderVersion = (v) => String(v || '').split(' ')[0];

function fabricLikeId(entry) {
  const lv = cleanLoaderVersion(entry.loaderVersion);
  return `${entry.loader}-loader-${lv}-${entry.mcVersion}`;
}

async function ensureFabricLike(entry, signal) {
  const id = fabricLikeId(entry);
  if (fs.existsSync(versionJsonPath(id))) return id;
  const base = entry.loader === 'fabric' ? versions.FABRIC_META : versions.QUILT_META;
  const lv = cleanLoaderVersion(entry.loaderVersion);
  const profile = await net.getJson(
    `${base}/versions/loader/${encodeURIComponent(entry.mcVersion)}/${encodeURIComponent(lv)}/profile/json`,
    { retries: 2, signal },
  );
  profile.id = id;
  profile.inheritsFrom = profile.inheritsFrom || entry.mcVersion;
  await fsp.mkdir(path.dirname(versionJsonPath(id)), { recursive: true });
  await fsp.writeFile(versionJsonPath(id), JSON.stringify(profile, null, 2));
  return id;
}

function forgeInstallerInfo(entry) {
  const lv = cleanLoaderVersion(entry.loaderVersion);
  const mc = entry.mcVersion;
  if (entry.loader === 'neoforge') {
    return {
      url: `${versions.NEOFORGE_MAVEN}/${lv}/neoforge-${lv}-installer.jar`,
      file: path.join(config.dirs.versions(), `neoforge-${lv}-installer.jar`),
    };
  }
  return {
    url: `${versions.FORGE_MAVEN}/${mc}-${lv}/forge-${mc}-${lv}-installer.jar`,
    file: path.join(config.dirs.versions(), `forge-${mc}-${lv}-installer.jar`),
  };
}

function readInstallProfile(installerFile) {
  const zip = new AdmZip(installerFile);
  const entry = zip.getEntry('install_profile.json');
  if (!entry) throw new InstallError('В установщике нет install_profile.json.');
  const profile = JSON.parse(zip.readAsText(entry));
  const target = profile.version || (profile.install && profile.install.target);
  return { zip, profile, target };
}

function forgeTargetId(entry) {
  const info = forgeInstallerInfo(entry);
  if (!fs.existsSync(info.file)) return '';
  try {
    return readInstallProfile(info.file).target || '';
  } catch {
    return '';
  }
}

function runProcess(exe, args, { cwd, signal, prefix }) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (d) => {
      const text = d.toString('utf8');
      tail = (tail + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) log.info(`${prefix} ${line}`);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const onAbort = () => child.kill();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) reject(net.abortError());
      else resolve({ code, tail });
    });
  });
}

async function ensureForgeLike(entry, P, signal) {
  const info = forgeInstallerInfo(entry);
  const name = entry.loader === 'neoforge' ? 'NeoForge' : 'Forge';
  P.begin('loader', { extra: { loader: name } });
  if (!fs.existsSync(info.file)) await net.download(info.url, info.file, { signal });
  const { zip, profile, target } = readInstallProfile(info.file);
  if (!target) throw new InstallError(`Не удалось определить версию ${name} из установщика.`);
  if (fs.existsSync(versionJsonPath(target))) return target;

  if (profile.versionInfo) {
    // Pre-1.13 Forge: no headless installer. Its version JSON is inside the
    // profile and the universal jar is a file in the installer zip.
    const vi = profile.versionInfo;
    vi.id = target;
    vi.inheritsFrom = vi.inheritsFrom || entry.mcVersion;
    vi.libraries = (vi.libraries || []).filter((l) => l.clientreq !== false);
    await fsp.mkdir(path.dirname(versionJsonPath(target)), { recursive: true });
    await fsp.writeFile(versionJsonPath(target), JSON.stringify(vi, null, 2));
    if (profile.install && profile.install.filePath && profile.install.path) {
      const jarEntry = zip.getEntry(profile.install.filePath);
      if (jarEntry) {
        const dest = path.join(config.dirs.libraries(), mavenPath(profile.install.path));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, jarEntry.getData());
      }
    }
    return target;
  }

  // 1.13+: run the installer itself. It needs a Java and insists on a
  // launcher_profiles.json existing in the target folder.
  const vanilla = await ensureVanillaJson(entry.mcVersion, signal);
  const runtime = await resolveJava(entry, vanilla, P, signal);
  const profiles = path.join(config.dirs.game(), 'launcher_profiles.json');
  if (!fs.existsSync(profiles)) await fsp.writeFile(profiles, JSON.stringify({ profiles: {}, selectedProfile: '' }, null, 2));
  P.begin('loader', { extra: { loader: name } });
  const javaExe = runtime.exe.replace(/javaw\.exe$/i, 'java.exe');
  const res = await runProcess(fs.existsSync(javaExe) ? javaExe : runtime.exe, ['-jar', info.file, '--installClient', config.dirs.game()], {
    cwd: config.dirs.versions(),
    signal,
    prefix: `[${name}]`,
  });
  if (res.code !== 0 || !fs.existsSync(versionJsonPath(target))) {
    throw new InstallError(`Установщик ${name} завершился с ошибкой (код ${res.code}).\n${res.tail.slice(-800)}`);
  }
  return target;
}

// ---- java --------------------------------------------------------------------------------

function customJavaPath(entry) {
  const cfg = config.get();
  if (entry.javaPath) return entry.javaPath;
  if (cfg.javaMode === 'custom' && cfg.javaPath) return cfg.javaPath;
  return '';
}

async function resolveJava(entry, merged, P, signal) {
  const custom = customJavaPath(entry);
  if (custom) {
    const d = java.describeExe(custom);
    if (!d) throw new InstallError(`Java не найдена: ${custom}`);
    if (!java.bootable(d.home)) throw new InstallError(`Java в «${d.home}» неполная (нет lib\\jvm.cfg или jvm.dll) — выберите другую в настройках или включите «Автоматически».`);
    return d;
  }
  const component = (merged.javaVersion && merged.javaVersion.component) || 'jre-legacy';
  P.begin('java', { extra: { major: (merged.javaVersion && merged.javaVersion.majorVersion) || java.COMPONENT_MAJOR[component] || 8 } });
  let lastDone = 0;
  return java.ensureRuntime(component, {
    signal,
    onProgress: ({ done, total }) => {
      P.bytesTotal = total;
      P.bytes(done - lastDone);
      lastDone = done;
    },
  });
}

// ---- main ---------------------------------------------------------------------------------

async function downloadMany(items, P, signal, limit) {
  let missingBytes = 0;
  const todo = [];
  await net.pool(
    items,
    32,
    async (it) => {
      if (await net.fileMatches(it.file, it.size)) return;
      todo.push(it);
      missingBytes += it.size || 0;
    },
    signal,
  );
  P.total = todo.length;
  P.bytesTotal = missingBytes;
  P.done = 0;
  P.emit(true);
  await net.pool(
    todo,
    limit,
    async (it) => {
      if (!it.url) throw new InstallError(`Нет ссылки для ${path.basename(it.file)} — переустановите загрузчик.`);
      await net.download(it.url, it.file, { sha1: it.sha1, size: it.size, signal, onBytes: (n) => P.bytes(n) });
      P.file();
    },
    signal,
  );
  return todo.length;
}

async function extractNatives(nat, nativesDir) {
  const zip = new AdmZip(nat.file);
  const root = path.resolve(nativesDir);
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    if (nat.exclude.some((x) => e.entryName.startsWith(x))) continue;
    const dest = path.resolve(nativesDir, e.entryName);
    if (!dest.startsWith(root + path.sep)) continue; // zip-slip guard
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, e.getData());
  }
}

async function install(entry, { signal, onProgress, repair = false } = {}) {
  const P = new Progress(onProgress, signal);
  config.ensureGameDirs();
  const mc = entry.mcVersion;

  P.begin('meta');
  const vanilla = await ensureVanillaJson(mc, signal);

  let leafId = mc;
  if (entry.loader === 'fabric' || entry.loader === 'quilt') {
    P.begin('loader', { extra: { loader: entry.loader === 'fabric' ? 'Fabric' : 'Quilt' } });
    leafId = await ensureFabricLike(entry, signal);
  } else if (entry.loader === 'forge' || entry.loader === 'neoforge') {
    leafId = await ensureForgeLike(entry, P, signal);
  }
  const merged = await resolveChain(leafId, signal);
  const runtime = await resolveJava(entry, merged, P, signal);

  // Client jar — always the vanilla one; loaders layer on top of it.
  const clientDl = (vanilla.downloads && vanilla.downloads.client) || (merged.downloads && merged.downloads.client);
  const clientJar = path.join(config.dirs.versions(), mc, `${mc}.jar`);
  P.begin('client', { total: 1, bytesTotal: clientDl ? clientDl.size : 0 });
  if (clientDl && !(await net.fileMatches(clientJar, clientDl.size))) {
    await net.download(clientDl.url, clientJar, { sha1: clientDl.sha1, size: clientDl.size, signal, onBytes: (n) => P.bytes(n) });
  } else if (!clientDl && !fs.existsSync(clientJar)) {
    throw new InstallError(`Нет client.jar для ${mc}.`);
  }
  P.file();

  // Libraries. Child (loader) entries come first in merged.libraries, so
  // de-duplicating by group:artifact:classifier keeps the loader's version
  // of anything both declare — what the official launcher does too.
  const classpath = [];
  const seenKeys = new Set();
  const libItems = [];
  const nativeItems = [];
  for (const lib of merged.libraries || []) {
    if (!allowed(lib)) continue;
    const key = lib.name ? libKey(lib.name) : null;
    const art = resolveArtifact(lib);
    if (art && !(key && seenKeys.has(key))) {
      if (key) seenKeys.add(key);
      if (!classpath.includes(art.file)) classpath.push(art.file);
      if (art.url) libItems.push(art);
    }
    const nat = resolveNative(lib);
    if (nat) nativeItems.push(nat);
  }
  classpath.push(clientJar);

  P.begin('libraries', { total: libItems.length + nativeItems.length });
  await downloadMany([...libItems, ...nativeItems], P, signal, 8);

  const nativesDir = path.join(config.dirs.versions(), mc, 'natives');
  await fsp.mkdir(nativesDir, { recursive: true });
  if (nativeItems.length) {
    P.begin('natives', { total: nativeItems.length });
    const marker = path.join(nativesDir, '.extracted');
    let stamp = '';
    try {
      stamp = await fsp.readFile(marker, 'utf8');
    } catch {
      stamp = '';
    }
    const want = nativeItems.map((n) => path.basename(n.file)).sort().join('\n');
    if (stamp !== want || repair) {
      for (const nat of nativeItems) {
        try {
          await extractNatives(nat, nativesDir);
        } catch (e) {
          await fsp.rm(nat.file, { force: true });
          throw new InstallError(`Повреждён архив нативных библиотек ${path.basename(nat.file)} — запустите ещё раз.`);
        }
        P.file();
      }
      await fsp.writeFile(marker, want);
    }
  }

  // Assets.
  const assetIndex = merged.assetIndex;
  const assetsDir = config.dirs.assets();
  let assetsRoot = assetsDir;
  let gameAssets = path.join(assetsDir, 'virtual', 'legacy');
  const assetItems = [];
  let indexData = { objects: {} };
  if (assetIndex) {
    const indexFile = path.join(assetsDir, 'indexes', `${assetIndex.id}.json`);
    if (!(await net.fileMatches(indexFile, assetIndex.size)) || repair) {
      await net.download(assetIndex.url, indexFile, { sha1: assetIndex.sha1, size: assetIndex.size, signal });
    }
    indexData = await readJson(indexFile);
    for (const obj of Object.values(indexData.objects || {})) {
      const h = obj.hash;
      assetItems.push({
        file: path.join(assetsDir, 'objects', h.slice(0, 2), h),
        url: `${RESOURCES_BASE}${h.slice(0, 2)}/${h}`,
        sha1: h,
        size: obj.size,
      });
    }
  }
  P.begin('assets', { total: assetItems.length });
  await downloadMany(assetItems, P, signal, 16);

  if (repair) {
    // Full SHA-1 pass over everything that's already on disk (C++, all
    // cores), then re-download whatever failed.
    const all = [
      ...libItems.filter((i) => i.sha1),
      ...assetItems,
      ...(clientDl ? [{ file: clientJar, url: clientDl.url, sha1: clientDl.sha1, size: clientDl.size }] : []),
    ];
    P.begin('verify', { total: all.length });
    const bad = await native.verifyFiles(
      all.map((i) => ({ path: i.file, sha1: i.sha1, size: i.size })),
      (d) => {
        P.done = d;
        P.emit();
      },
    );
    if (bad.length) {
      log.warn(`Verify: ${bad.length} file(s) damaged or missing — downloading them again.`);
      const broken = bad.map((b) => all[b.index]);
      for (const b of broken) await fsp.rm(b.file, { force: true });
      P.begin('assets', { total: broken.length });
      await downloadMany(broken, P, signal, 8);
    } else {
      log.info(`Verify: all ${all.length} files are intact.`);
    }
  }

  // Pre-1.7 asset layouts: copy the objects out under their real names.
  if (indexData.virtual || indexData.map_to_resources) {
    const instanceDir = config.dirs.instance(entry.id);
    const target = indexData.map_to_resources
      ? path.join(instanceDir, 'resources')
      : path.join(assetsDir, 'virtual', assetIndex.id);
    for (const [name, obj] of Object.entries(indexData.objects || {})) {
      const dest = path.join(target, name);
      if (await net.fileMatches(dest, obj.size)) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(path.join(assetsDir, 'objects', obj.hash.slice(0, 2), obj.hash), dest);
    }
    gameAssets = target;
    if (indexData.virtual) assetsRoot = target;
  }

  P.begin('finish');
  const gameDir = config.dirs.instance(entry.id);
  await fsp.mkdir(gameDir, { recursive: true });
  if (entry.loader !== 'vanilla') await fsp.mkdir(path.join(gameDir, 'mods'), { recursive: true });
  worlds.writeDefaultServers(gameDir);
  P.emit(true);

  return {
    mainClass: merged.mainClass,
    classpath,
    nativesDir,
    jvmArgsTemplate: merged.arguments ? merged.arguments.jvm || [] : null,
    gameArgsTemplate: merged.arguments ? merged.arguments.game || [] : null,
    minecraftArguments: merged.minecraftArguments || '',
    assetsId: assetIndex ? assetIndex.id : 'legacy',
    assetsRoot,
    gameAssets,
    gameDir,
    versionName: leafId,
    versionType: merged.type || 'release',
    javaExe: runtime.exe,
    javaMajor: runtime.major || 0,
    javaVersion: runtime.version || '',
    supportsQuickPlay: supportsQuickPlay(merged),
  };
}

// Fast, local-only: is this installation already downloaded? Decides
// "Играть" vs "Скачать" on the big button. The Java runtime is not part of
// it — that's fetched at launch if missing.
function looksInstalled(entry) {
  const mc = entry.mcVersion;
  const dir = path.join(config.dirs.versions(), mc);
  if (!fs.existsSync(path.join(dir, `${mc}.jar`)) || !fs.existsSync(path.join(dir, `${mc}.json`))) return false;
  if (entry.loader === 'fabric' || entry.loader === 'quilt') return fs.existsSync(versionJsonPath(fabricLikeId(entry)));
  if (entry.loader === 'forge' || entry.loader === 'neoforge') {
    const target = forgeTargetId(entry);
    return !!target && fs.existsSync(versionJsonPath(target));
  }
  return true;
}

function versionIdsFor(entry) {
  const ids = new Set([entry.mcVersion]);
  if (entry.loader === 'fabric' || entry.loader === 'quilt') ids.add(fabricLikeId(entry));
  else if (entry.loader === 'forge' || entry.loader === 'neoforge') {
    const t = forgeTargetId(entry);
    if (t) ids.add(t);
  }
  return ids;
}

// Removes an installation's private folder and the downloaded version data
// no other remaining installation still needs (same rule as v1).
async function uninstall(entry, remaining, { keepInstance = false } = {}) {
  if (!keepInstance) await fsp.rm(config.dirs.instance(entry.id), { recursive: true, force: true });
  const mine = versionIdsFor(entry);
  const needed = new Set();
  for (const other of remaining) if (other.id !== entry.id) for (const id of versionIdsFor(other)) needed.add(id);
  for (const id of mine) {
    if (!needed.has(id)) await fsp.rm(path.join(config.dirs.versions(), id), { recursive: true, force: true });
  }
  if (entry.loader === 'forge' || entry.loader === 'neoforge') {
    const stillUsed = remaining.some(
      (o) => o.id !== entry.id && o.loader === entry.loader && cleanLoaderVersion(o.loaderVersion) === cleanLoaderVersion(entry.loaderVersion),
    );
    if (!stillUsed) await fsp.rm(forgeInstallerInfo(entry).file, { force: true });
  }
}

module.exports = { install, looksInstalled, uninstall, collectArgs, allowed, InstallError };
