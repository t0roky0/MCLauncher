'use strict';
// Loads the C++ addon (native/src/mcnative.cc) and gives every export a
// pure-JS fallback, so the launcher works — slower, with less detail — even
// if the .node file is missing or fails to load.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const log = require('./log');

let mod = null;
let loadError = '';

function candidates() {
  const list = [paths.nativeModule];
  // Inside the packaged app the addon is unpacked next to app.asar.
  if (paths.nativeModule.includes('app.asar')) {
    list.unshift(paths.nativeModule.replace('app.asar', 'app.asar.unpacked'));
  }
  return list;
}

function load() {
  for (const file of candidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      mod = require(file);
      const info = mod.moduleInfo();
      log.info(`C++ module loaded (mcnative ${info.version}, ${info.compiler || 'MSVC'}).`);
      return true;
    } catch (e) {
      loadError = e.message;
    }
  }
  if (!loadError) loadError = 'mcnative.node not found';
  log.warn(`C++ module unavailable (${loadError}) — using JS fallbacks.`);
  return false;
}

function available() {
  return !!mod;
}

function moduleInfo() {
  return mod ? { loaded: true, ...mod.moduleInfo() } : { loaded: false, error: loadError };
}

function systemInfo() {
  if (mod) {
    try {
      return { native: true, ...mod.systemInfo() };
    } catch (e) {
      log.warn(`systemInfo failed: ${e.message}`);
    }
  }
  const cpus = os.cpus();
  return {
    native: false,
    totalMemMB: os.totalmem() / 1048576,
    freeMemMB: os.freemem() / 1048576,
    cpuName: cpus[0] ? cpus[0].model.trim() : '',
    cpuCores: 0,
    cpuThreads: cpus.length,
    gpus: [],
    osVersion: os.release(),
  };
}

function processStats(pid) {
  if (!mod || !pid) return null;
  try {
    return mod.processStats(pid);
  } catch {
    return null;
  }
}

function setPriority(pid, level) {
  if (!mod || !pid || !level || level === 'normal') return false;
  try {
    return mod.setPriority(pid, level);
  } catch {
    return false;
  }
}

function fileVersion(file) {
  if (!mod) return null;
  try {
    return mod.fileVersion(file);
  } catch {
    return null;
  }
}

function javaRegistryHomes() {
  if (!mod) return [];
  try {
    return mod.javaRegistryHomes();
  } catch {
    return [];
  }
}

async function sha1FileJs(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
}

async function sha1File(file) {
  if (mod) {
    try {
      return await mod.sha1File(file);
    } catch {
      /* fall through to JS */
    }
  }
  return sha1FileJs(file);
}

// items: [{path, sha1?, size?}] → [{index, reason}] for every bad file.
async function verifyFiles(items, onProgress) {
  if (mod && items.length) {
    try {
      return await mod.verifyFiles(items, onProgress || undefined);
    } catch (e) {
      log.warn(`native verifyFiles failed (${e.message}) — verifying in JS.`);
    }
  }
  const bad = [];
  let done = 0;
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const it = items[i];
      try {
        const st = await fs.promises.stat(it.path);
        if (it.size && st.size !== it.size) bad.push({ index: i, reason: 'size' });
        else if (it.sha1 && (await sha1FileJs(it.path)) !== it.sha1.toLowerCase()) bad.push({ index: i, reason: 'hash' });
      } catch {
        bad.push({ index: i, reason: 'missing' });
      }
      done++;
      if (onProgress && (done % 96 === 0 || done === items.length)) onProgress(done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));
  return bad.sort((a, b) => a.index - b.index);
}

// Push-to-talk: is any of these virtual keys held, in whatever window?
// Without the addon there's no way to see keys outside the launcher, so
// the renderer falls back to its own window's key events.
function keysDown(vks) {
  if (!mod || typeof mod.keysDown !== 'function') return null;
  try {
    return mod.keysDown(vks);
  } catch {
    return null;
  }
}

module.exports = {
  foregroundWindow() { try { return mod?.foregroundWindow?.() || null; } catch { return null; } },
  focusProcess(pid) { try { return !!mod?.focusProcess?.(pid); } catch { return false; } },
  // the overlay: to the front for its menu; riding on the game's window
  focusWindow(handle) { try { return !!mod?.focusWindow?.(handle); } catch { return false; } },
  followWindow(handle, pid) { try { return !!mod?.followWindow?.(handle, pid); } catch { return false; } },
  load,
  available,
  moduleInfo,
  systemInfo,
  processStats,
  setPriority,
  fileVersion,
  javaRegistryHomes,
  sha1File,
  verifyFiles,
  keysDown,
  _path: path,
};
