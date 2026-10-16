'use strict';
// The game's files go to the drive the launcher was installed on.
//
// The installer lets you pick any folder on any drive; the game's files used
// to stay in %APPDATA%\.minecraft whatever you picked. Now, installed on
// another drive, the launcher keeps them next to itself — in
// <install folder's parent>\.minecraft, not inside the install folder (an
// uninstall clears that one). With nothing downloaded yet it just switches;
// with installations already there, the window asks first (and can copy
// their worlds, mods and settings across — the originals stay put).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');
const config = require('./config');
const paths = require('./paths');
const log = require('./log');

const drive = (p) => path.parse(path.resolve(p)).root.toUpperCase();
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

let offer = null;

// Run once at start: nothing, a quiet switch ({switched}), or an offer kept
// for the window to ask about.
function check() {
  if (!app.isPackaged) return null;
  const installDir = path.dirname(process.execPath);
  const cfg = config.get();
  if (cfg.gameDirCheckedFor === installDir) return null;
  const mark = () => config.mutate((c) => (c.gameDirCheckedFor = installDir), { silent: true });
  // a folder chosen by hand, or the launcher on the same drive: leave it
  if (!same(cfg.gameDir || paths.defaultGameDir, paths.defaultGameDir) || drive(installDir) === drive(paths.defaultGameDir)) {
    mark();
    return null;
  }
  const target = path.join(path.dirname(installDir), '.minecraft');
  const instances = (cfg.installs || []).filter((e) => !e.isBedrock && fs.existsSync(config.dirs.instance(e.id))).map((e) => e.id);
  if (!instances.length) {
    config.mutate((c) => {
      c.gameDir = target;
      c.gameDirCheckedFor = installDir;
    });
    log.info(`Game files on the launcher's drive: ${target}.`);
    return { switched: target };
  }
  offer = { target, drive: drive(installDir).replace(/\\$/, ''), from: paths.defaultGameDir, instances, installDir };
  return { offer };
}

function pending() {
  return offer ? { target: offer.target, drive: offer.drive, from: offer.from, count: offer.instances.length } : null;
}

// The answer: move (and copy the installations' own folders) or stay.
async function answer(move) {
  if (!offer) return { moved: false };
  const o = offer;
  offer = null;
  if (!move) {
    config.mutate((c) => (c.gameDirCheckedFor = o.installDir), { silent: true });
    return { moved: false };
  }
  let copied = 0;
  for (const id of o.instances) {
    const from = path.join(o.from, 'instances', id);
    const to = path.join(o.target, 'instances', id);
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: false });
      copied++;
    } catch (e) {
      log.warn(`Couldn't copy ${from}: ${e.message}`);
    }
  }
  config.mutate((c) => {
    c.gameDir = o.target;
    c.gameDirCheckedFor = o.installDir;
  });
  log.info(`Game files moved to ${o.target} (${copied} installation folder(s) copied).`);
  return { moved: true, target: o.target, copied };
}

module.exports = { check, pending, answer };
