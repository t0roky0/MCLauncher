'use strict';
// Java runtimes.
//
// Every version JSON names the runtime it was built for ("javaVersion":
// java-runtime-epsilon = Java 25 for 26.x, delta = 21, gamma = 17,
// jre-legacy = 8 for anything old). Mojang publishes those runtimes, and
// that's what "Auto" uses: the right Java per installation, downloaded once
// into <game dir>\runtime and shared with the official launcher's layout.
// v1 shipped a single JRE with the installer, which is why 26.x needed a
// manual Java swap there.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('./net');
const config = require('./config');
const paths = require('./paths');
const native = require('./native');
const log = require('./log');

const RUNTIME_INDEX =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const PLATFORM = 'windows-x64';
const STORE_RUNTIME = path.join(
  paths.LOCALAPPDATA, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime',
);
const COMPONENT_MAJOR = {
  'jre-legacy': 8,
  'java-runtime-alpha': 16,
  'java-runtime-beta': 17,
  'java-runtime-gamma': 17,
  'java-runtime-gamma-snapshot': 17,
  'java-runtime-delta': 21,
  'java-runtime-epsilon': 25,
};

let indexCache = null;

function majorOf(version) {
  const v = String(version || '').replace(/^"|"$/g, '');
  const m = /^1\.(\d+)/.exec(v) || /^(\d+)/.exec(v);
  return m ? Number(m[1]) : 0;
}

function readRelease(home) {
  try {
    const text = fs.readFileSync(path.join(home, 'release'), 'utf8');
    const m = /JAVA_VERSION="([^"]+)"/.exec(text);
    if (!m) return null;
    const vendor = (/IMPLEMENTOR="([^"]+)"/.exec(text) || [])[1] || '';
    return { version: m[1], major: majorOf(m[1]), vendor };
  } catch {
    return null;
  }
}

function exeIn(home) {
  for (const name of ['javaw.exe', 'java.exe']) {
    const p = path.join(home, 'bin', name);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function homeOfExe(exe) {
  return path.dirname(path.dirname(exe));
}

// Describes the Java at `exe`: from its release file, or the exe's version
// resource (C++), so no JVM has to be started just to ask.
function describeExe(exe) {
  if (!exe || !fs.existsSync(exe)) return null;
  const home = homeOfExe(exe);
  const rel = readRelease(home);
  if (rel) return { exe, home, version: rel.version, major: rel.major, vendor: rel.vendor };
  const fv = native.fileVersion(exe);
  if (fv && fv.major) {
    return { exe, home, version: fv.productVersion || fv.fileVersion, major: fv.major, vendor: fv.company || '' };
  }
  return { exe, home, version: '', major: 0, vendor: '' };
}

async function runtimeIndex() {
  if (indexCache) return indexCache;
  const file = path.join(config.dirs.runtime(), 'mclauncher-index.json');
  try {
    indexCache = await net.getJson(RUNTIME_INDEX, { retries: 2 });
    await fsp.mkdir(config.dirs.runtime(), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(indexCache));
  } catch (e) {
    try {
      indexCache = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      throw new Error(`список Java недоступен: ${net.describe(e)}`);
    }
  }
  return indexCache;
}

// The JVM opens these before anything else; without them javaw.exe only
// shows "could not open jvm.cfg" / "could not find java.dll". A download
// cut short (the launcher closed, an antivirus) leaves exactly that.
function bootable(home) {
  const has = (...alts) => alts.some((p) => fs.existsSync(path.join(home, p)));
  return has('lib/jvm.cfg', 'lib/amd64/jvm.cfg') && has('bin/server/jvm.dll', 'bin/client/jvm.dll') && has('bin/java.dll') && has('lib/modules', 'lib/rt.jar');
}

function candidateHomes(component) {
  const rt = config.dirs.runtime();
  return [
    path.join(rt, component, PLATFORM, component), // official launcher layout
    path.join(rt, component, PLATFORM), // flat layout some launchers use
    path.join(STORE_RUNTIME, component, PLATFORM, component), // Microsoft Store launcher
  ];
}

function findInstalledRuntime(component, expectedMajor) {
  for (const home of candidateHomes(component)) {
    const exe = exeIn(home);
    if (!exe) continue;
    if (!bootable(home)) {
      log.warn(`Java ${component} at ${home} is incomplete — skipped.`);
      continue;
    }
    const rel = readRelease(home);
    if (rel && expectedMajor && rel.major !== expectedMajor) continue;
    return { exe, home, version: rel ? rel.version : '', major: rel ? rel.major : expectedMajor, vendor: 'Mojang' };
  }
  return null;
}

// Returns {exe, home, version, major}, downloading the runtime if needed.
// onProgress({done, total}) is in bytes.
async function ensureRuntime(component, { signal, onProgress } = {}) {
  component = component || 'jre-legacy';
  let index = null;
  try {
    index = await runtimeIndex();
  } catch (e) {
    const local = findInstalledRuntime(component, COMPONENT_MAJOR[component]);
    if (local) return local;
    throw new Error(`Не удалось получить Java (${component}): ${e.message}`);
  }
  const entry = index[PLATFORM] && index[PLATFORM][component] && index[PLATFORM][component][0];
  const expectedMajor = entry ? majorOf(entry.version.name) : COMPONENT_MAJOR[component];
  const home = candidateHomes(component)[0];
  // Ours (or the official launcher's) in the game folder: every file of
  // Mojang's list must be there at its size — a stat each, so it's quick —
  // and whatever's missing is fetched again.
  if (entry && exeIn(home)) {
    try {
      const man = await runtimeManifest(component, entry, signal);
      const broken = await missingFiles(home, man);
      if (!broken.length && bootable(home)) {
        const rel = readRelease(home);
        return { exe: exeIn(home), home, version: rel ? rel.version : entry.version.name, major: rel ? rel.major : expectedMajor, vendor: 'Mojang' };
      }
      log.warn(`Java ${component}: ${broken.length} file(s) missing or damaged — repairing.`);
    } catch (e) {
      if (signal && signal.aborted) throw e;
      log.warn(`Java ${component}: couldn't check against Mojang's list (${e.message}).`);
    }
  }
  const local = findInstalledRuntime(component, expectedMajor);
  if (local && (!entry || local.home !== home)) return local;
  if (!entry) throw new Error(`Mojang не публикует Java «${component}» для Windows x64.`);

  log.info(`Downloading Java ${entry.version.name} (${component})...`);
  const man = await runtimeManifest(component, entry, signal);
  const files = [];
  for (const [rel, f] of Object.entries(man.files || {})) {
    if (f.type === 'directory') await fsp.mkdir(path.join(home, rel), { recursive: true });
    else if (f.type === 'file' && f.downloads && f.downloads.raw) files.push([rel, f.downloads.raw]);
  }
  const total = files.reduce((s, [, r]) => s + (r.size || 0), 0);
  let done = 0;
  const bump = (n) => {
    done += n;
    if (onProgress) onProgress({ done, total });
  };
  await net.pool(
    files,
    8,
    async ([rel, raw]) => {
      const dest = path.join(home, rel);
      if (await net.fileMatches(dest, raw.size)) {
        bump(raw.size || 0);
        return;
      }
      await net.download(raw.url, dest, { sha1: raw.sha1, size: raw.size, signal, onBytes: bump });
    },
    signal,
  );
  await fsp.writeFile(path.join(config.dirs.runtime(), component, PLATFORM, `${component}.version`), entry.version.name);
  const exe = exeIn(home);
  if (!exe || !bootable(home)) throw new Error(`Java ${component} скачана не полностью — попробуйте ещё раз.`);
  log.info(`Java ${entry.version.name} ready at ${home}.`);
  return { exe, home, version: entry.version.name, major: expectedMajor, vendor: 'Mojang' };
}

// Mojang's file list for a runtime, kept next to it per version so the check
// before each start needs no network.
async function runtimeManifest(component, entry, signal) {
  const file = path.join(config.dirs.runtime(), component, PLATFORM, 'mclauncher-manifest.json');
  try {
    const cached = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (cached.version === entry.version.name && cached.files) return cached;
  } catch {
    /* not cached yet */
  }
  const man = await net.getJson(entry.manifest.url, { retries: 2, signal });
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ version: entry.version.name, files: man.files }));
  } catch {
    /* only a cache */
  }
  return man;
}

async function missingFiles(home, man) {
  const out = [];
  for (const [rel, f] of Object.entries(man.files || {})) {
    if (f.type !== 'file' || !f.downloads || !f.downloads.raw) continue;
    if (!(await net.fileMatches(path.join(home, rel), f.downloads.raw.size))) out.push(rel);
  }
  return out;
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

// Every Java on this PC we can find without running anything: registry
// (C++), the usual install folders, JAVA_HOME, and Mojang runtimes.
function detectInstalled() {
  const homes = new Set(native.javaRegistryHomes());
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean);
  for (const root of pf) {
    for (const vendor of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'AdoptOpenJDK']) {
      for (const d of listDirs(path.join(root, vendor))) homes.add(d);
    }
  }
  for (const d of listDirs(path.join(require('os').homedir(), '.jdks'))) homes.add(d);
  if (process.env.JAVA_HOME) homes.add(process.env.JAVA_HOME);
  for (const root of [config.dirs.runtime(), STORE_RUNTIME]) {
    for (const comp of listDirs(root)) {
      homes.add(path.join(comp, PLATFORM));
      homes.add(path.join(comp, PLATFORM, path.basename(comp)));
    }
  }
  const out = [];
  const seen = new Set();
  for (const home of homes) {
    const exe = exeIn(home);
    if (!exe) continue;
    const key = exe.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const d = describeExe(exe);
    if (d) out.push(d);
  }
  return out.sort((a, b) => b.major - a.major || a.exe.localeCompare(b.exe));
}

module.exports = { ensureRuntime, detectInstalled, describeExe, majorOf, bootable, COMPONENT_MAJOR };
