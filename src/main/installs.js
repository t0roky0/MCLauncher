'use strict';
// Installations and the one download/launch task that can run at a time.
//
// The list the UI shows = the generated "latest release" row (rebuilt from
// the manifest every start, never stored — it follows Mojang by itself) +
// the installations saved in config. Same model as v1.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const installer = require('./installer');
const versions = require('./versions');
const game = require('./game');
const auth = require('./auth');
const worlds = require('./worlds');
const bedrock = require('./bedrock');
const skins = require('./skins');
const paths = require('./paths');
const log = require('./log');

let defaultEntry = null;
let task = null;
const listeners = new Set();

function emit(type, payload) {
  for (const fn of listeners) {
    try {
      fn(type, payload);
    } catch {
      /* ignore */
    }
  }
}

function taskView() {
  if (!task) return { busy: false };
  return {
    busy: true,
    id: task.id,
    name: task.name,
    action: task.action,
    phase: task.phase,
    progress: task.progress,
    cancelling: task.controller.signal.aborted,
  };
}

function emitTask() {
  emit('task', taskView());
}

function stats(id) {
  const s = (config.get().latestStats || {})[id];
  return s || {};
}

function refreshDefaultEntry() {
  const v = versions.latestReleaseCached();
  if (!v) {
    defaultEntry = null;
    return;
  }
  defaultEntry = config.makeDefaultEntry(v);
  const prev = config.get().defaultVersion;
  if (prev && prev !== v) retireDefault(prev);
  if (prev !== v) config.mutate((c) => (c.defaultVersion = v), { silent: true });
}

// When Mojang ships a new release the old "latest" row disappears; its
// files go too — unless it has worlds in it, which are never deleted
// behind someone's back.
function retireDefault(oldVersion) {
  const old = config.makeDefaultEntry(oldVersion);
  if (worlds.hasWorlds(old)) {
    log.info(`Latest release moved on from ${oldVersion}; its instance has worlds, keeping it.`);
    return;
  }
  installer
    .uninstall(old, config.get().installs)
    .then(() => log.info(`Latest release moved on from ${oldVersion}; cleaned it up.`))
    .catch((e) => log.warn(`Couldn't clean up ${oldVersion}: ${e.message}`));
}

function allEntries() {
  const list = config.get().installs.map((e) => ({ ...e }));
  if (defaultEntry) list.unshift({ ...defaultEntry, ...stats(defaultEntry.id) });
  return list;
}

function entryById(id) {
  return allEntries().find((e) => e.id === id) || null;
}

function listForUi() {
  const list = allEntries().map((e) => ({
    ...e,
    isDefault: config.isDefaultEntry(e),
    installed: safe(() => installer.looksInstalled(e), false),
    running: game.isRunning(e.id),
    hasWorlds: worlds.hasWorlds(e),
  }));
  // Bedrock: right under the latest Java release — installed or not (then
  // "Download" opens its Microsoft Store page).
  const b = bedrock.cached();
  const at = list.length && list[0].isDefault ? 1 : 0;
  list.splice(at, 0, { id: 'bedrock', name: 'Minecraft Bedrock', mcVersion: b.version || '', loader: 'bedrock', loaderVersion: '', iconId: 'bedrock', isBedrock: true, installed: !!b.installed, running: !!bedrock.runningList().length, ...(config.get().bedrockStats || {}) });
  return list;
}

// Bedrock is the Store's to install and update: starting it is all there is;
// not on the PC yet, "Download" opens its Store page.
function startBedrock(server) {
  // the event quests count Bedrock's time on a server it was sent to from here
  require('./nearby').setBedrockServer(server || '');
  if (config.get().selectedInstall !== 'bedrock') config.mutate((c) => (c.selectedInstall = 'bedrock'));
  if (!bedrock.cached().installed) {
    return bedrock.openStore().then(() => {
      emit('done', { id: 'bedrock', name: 'Minecraft Bedrock', action: 'store' });
      return { store: true };
    });
  }
  return bedrock
    .launch({ server, library: skins.list(), skinsDir: paths.skinsDir })
    .then((r) => {
      emit('done', { id: 'bedrock', name: 'Minecraft Bedrock', action: 'launch', bedrockSkin: r.skin });
      return r;
    })
    .catch((e) => {
      log.warn(`Bedrock: ${e.message}`);
      throw e;
    });
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];

function create(data) {
  const name = String(data.name || '').trim().slice(0, 40);
  if (!name) throw new Error('Введите название установки.');
  if (!data.mcVersion) throw new Error('Выберите версию Minecraft.');
  const loader = LOADERS.includes(data.loader) ? data.loader : 'vanilla';
  if (loader !== 'vanilla' && !data.loaderVersion) throw new Error('Выберите версию загрузчика.');
  const entry = config.normalizeInstall({
    id: config.makeInstallId(name),
    name,
    mcVersion: data.mcVersion,
    loader,
    loaderVersion: loader === 'vanilla' ? '' : data.loaderVersion,
    iconId: data.iconId || 'grass',
    created: Date.now(),
    ramMb: data.ramMb,
    jvmArgs: data.jvmArgs,
    javaPath: data.javaPath,
  });
  config.mutate((c) => {
    c.installs.push(entry);
    c.selectedInstall = entry.id;
  });
  emit('changed');
  log.info(`Installation created: ${entry.name} (${entry.mcVersion} ${entry.loader} ${entry.loaderVersion}).`);
  return entry;
}

function update(id, patch) {
  config.mutate((c) => {
    const e = c.installs.find((x) => x.id === id);
    if (!e) throw new Error('Установка не найдена.');
    if (typeof patch.name === 'string' && patch.name.trim()) e.name = patch.name.trim().slice(0, 40);
    if (typeof patch.iconId === 'string') e.iconId = patch.iconId;
    if (patch.ramMb !== undefined) e.ramMb = Math.max(0, Number(patch.ramMb) || 0);
    if (typeof patch.jvmArgs === 'string') e.jvmArgs = patch.jvmArgs;
    if (typeof patch.javaPath === 'string') e.javaPath = patch.javaPath;
  });
  emit('changed');
}

function move(id, dir) {
  config.mutate((c) => {
    const i = c.installs.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= c.installs.length) return;
    [c.installs[i], c.installs[j]] = [c.installs[j], c.installs[i]];
  });
  emit('changed');
}

async function remove(id) {
  const entry = config.get().installs.find((x) => x.id === id);
  if (!entry) return;
  if (game.isRunning(id)) throw new Error(`«${entry.name}» сейчас запущена — сначала закройте игру.`);
  if (task && task.id === id) throw new Error('Дождитесь окончания загрузки.');
  const remaining = config.get().installs.filter((x) => x.id !== id);
  // Off the list first, so the window updates right away; the files go
  // after (a big modpack takes a while).
  config.mutate((c) => {
    c.installs = c.installs.filter((x) => x.id !== id);
    if (c.selectedInstall === id) c.selectedInstall = '';
  });
  emit('changed');
  log.info(`Installation deleted: ${entry.name}.`);
  let warning = '';
  try {
    await installer.uninstall(entry, remaining);
  } catch (e) {
    warning = e.message;
    log.warn(`${entry.name}: some files could not be deleted — ${e.message}`);
  }
  return { warning };
}

async function clearFiles(id) {
  const entry = entryById(id);
  if (!entry) return;
  if (task) throw new Error('Сейчас идёт загрузка — дождитесь её окончания.');
  if (game.isRunning(id)) throw new Error('Сначала закройте игру.');
  await installer.uninstall(entry, config.get().installs);
  log.info(`${entry.name}: downloaded files deleted.`);
  emit('changed');
}

function recordPlay(id, playedMs) {
  config.mutate((c) => {
    const e = c.installs.find((x) => x.id === id);
    if (e) {
      e.lastPlayed = Date.now();
      e.playTimeMs = (e.playTimeMs || 0) + playedMs;
    } else if (config.isDefaultEntry({ id })) {
      c.latestStats = c.latestStats || {};
      const s = c.latestStats[id] || {};
      c.latestStats[id] = { lastPlayed: Date.now(), playTimeMs: (s.playTimeMs || 0) + playedMs };
    }
  });
}

function start(id, { world = '', server = '', repair = false, launch = true, partyHost = false } = {}) {
  if (id === 'bedrock') return startBedrock(server);
  if (task) throw new Error('Уже идёт загрузка — дождитесь её или отмените.');
  const entry = entryById(id);
  if (!entry) throw new Error('Установка не найдена.');
  if (launch && game.isRunning(id)) throw new Error(`«${entry.name}» уже запущена.`);
  const controller = new AbortController();
  task = { id, name: entry.name, action: launch ? 'launch' : 'verify', phase: 'prepare', progress: null, controller };
  emitTask();
  // Started from the tray or a world tile: the list follows.
  if (config.get().selectedInstall !== id) config.mutate((c) => (c.selectedInstall = id));
  log.info(`${entry.name}: ${launch ? 'preparing' : 'verifying'} (${entry.mcVersion}${entry.loader !== 'vanilla' ? ` ${entry.loader} ${entry.loaderVersion}` : ''})...`);

  (async () => {
    try {
      let session = null;
      if (launch) {
        task.phase = 'auth';
        emitTask();
        session = await auth.sessionForLaunch();
        // no skin at Mojang: the one picked in the launcher goes in through the agent
        const own = skins.localSkinFor(session.accountId);
        if (own) session.skin = { uuid: session.uuid, name: session.name, ...own };
      }
      task.phase = 'install';
      emitTask();
      const spec = await installer.install(entry, {
        signal: controller.signal,
        repair,
        onProgress: (p) => {
          if (!task) return;
          task.progress = p;
          emitTask();
        },
      });
      if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
      if (!launch) {
        task = null;
        emitTask();
        emit('done', { id, name: entry.name, action: 'verify' });
        emit('changed');
        return;
      }
      task.phase = 'launching';
      task.progress = null;
      emitTask();
      const s = await game.launch(entry, spec, session, { world, server, partyHost });
      task = null;
      emitTask();
      emit('done', {
        id,
        name: entry.name,
        action: 'launch',
        pid: s.pid,
        quickPlayIgnored: !!(world || server) && !spec.supportsQuickPlay && !server,
      });
      emit('changed');
    } catch (e) {
      const cancelled = !!(e.cancelled || controller.signal.aborted);
      task = null;
      emitTask();
      if (cancelled) {
        log.info(`${entry.name}: cancelled.`);
        emit('cancelled', { id, name: entry.name });
      } else {
        log.error(`${entry.name}: ${e.message}`);
        emit('error', { id, name: entry.name, message: e.message, code: e.code || '' });
      }
      emit('changed');
    }
  })();
  return true;
}

function cancel() {
  if (task && !task.controller.signal.aborted) {
    task.controller.abort();
    emitTask();
  }
}

game.onEvent((type, payload) => {
  if (type === 'exited') {
    recordPlay(payload.installId, payload.playedMs || 0);
    emit('changed');
  }
  if (type === 'started') emit('changed');
});

function instanceFolder(id, sub) {
  const allowed = ['', 'mods', 'saves', 'resourcepacks', 'shaderpacks', 'screenshots', 'logs', 'crash-reports', 'config'];
  if (!allowed.includes(sub || '')) throw new Error('bad folder');
  const dir = path.join(config.dirs.instance(id), sub || '');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Everything on disk for this installation (a quick look, no hashing).
function isReady(id) {
  const e = entryById(id);
  try {
    return !!e && installer.looksInstalled(e);
  } catch {
    return false;
  }
}

module.exports = {
  isReady,
  refreshDefaultEntry,
  allEntries,
  entryById,
  listForUi,
  create,
  update,
  move,
  remove,
  clearFiles,
  start,
  cancel,
  taskView,
  instanceFolder,
  onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
