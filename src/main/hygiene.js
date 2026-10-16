'use strict';
// Startup clean-up of anything that ever held a credential in the clear:
//
//   • chromium/Partitions/msauth — the sign-in window's cookies from before
//     2.2.0, when they were kept on disk (unencrypted: a copy of the folder
//     was a signed-in Microsoft account). The window keeps them in memory now.
//   • browser/ — the Python launcher's (v1) web profile, Microsoft cookies.
//   • config.v1.json — the v1 settings copy, with its old token in it.
//   • .mclauncher-args.txt — game arguments, once with the Minecraft token
//     inside; the file has no token any more.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const log = require('./log');

function removeDir(dir, what) {
  try {
    if (!fs.existsSync(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
    log.info(`Security: removed ${what}.`);
  } catch (e) {
    log.warn(`Security: couldn't remove ${what} (${e.code || e.message}).`);
  }
}

// Every value under a key that names a credential goes, the rest stays.
function stripSecrets(obj) {
  let n = 0;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (/token|refresh|secret|password|vault|cookie/i.test(k) && typeof o[k] !== 'object') {
        delete o[k];
        n++;
      } else walk(o[k]);
    }
  };
  walk(obj);
  return n;
}

function scrubV1Config() {
  const file = path.join(paths.appDir, 'config.v1.json');
  try {
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const n = stripSecrets(raw);
    if (!n) return;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    log.info(`Security: removed ${n} saved token(s) from config.v1.json.`);
  } catch (e) {
    log.warn(`Security: config.v1.json not checked (${e.message}).`);
  }
}

function removeArgFiles(config) {
  const dirs = new Set([config.dirs.game()]);
  for (const e of config.get().installs || []) if (e && e.id && !e.isBedrock) dirs.add(config.dirs.instance(e.id));
  try {
    for (const d of fs.readdirSync(config.dirs.instances(), { withFileTypes: true })) if (d.isDirectory()) dirs.add(path.join(config.dirs.instances(), d.name));
  } catch {
    /* no instances yet */
  }
  let n = 0;
  for (const dir of dirs) {
    const file = path.join(dir, '.mclauncher-args.txt');
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        n++;
      }
    } catch {
      /* in use by a running game; next time */
    }
  }
  if (n) log.info(`Security: removed ${n} old argument file(s).`);
}

function cleanup(config) {
  removeDir(path.join(paths.chromiumDir, 'Partitions', 'msauth'), 'the sign-in cookies kept on disk');
  if (fs.existsSync(path.join(paths.appDir, 'browser', 'Cookies'))) removeDir(path.join(paths.appDir, 'browser'), 'the v1 web profile');
  scrubV1Config();
  removeArgFiles(config);
}

module.exports = { cleanup, stripSecrets };
