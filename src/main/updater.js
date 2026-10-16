'use strict';
// The launcher updates itself from our own server (server/setup-updates.sh):
// electron-updater reads latest.yml there and fetches the new installer in
// the background (after the first update, only the parts that changed — by
// the installers' blockmaps); it goes in when the launcher is closed, or now,
// from the toast's button (and the launcher starts again).
//
// Nothing is installed without our own signature: scripts/release.cjs signs
// each installer (its version and SHA-512) with a key that stays on the
// release PC. The server could be someone else's after a break-in and the
// connection is plain HTTP — a file that isn't ours, or an older one passed
// off as new, is thrown away.

const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const log = require('./log');

// MCL_UPDATE_FEED: a test's own server instead (and allowed with a test data folder)
const FEED = process.env.MCL_UPDATE_FEED || 'http://relay.example.com:8080/';
// the release key's public half (the private one: %USERPROFILE%\.mclauncher-release)
const PUBLIC_KEY = 'MCowBQYDK2VwAyEAkWbxViS9V7w2J1LgvJrzJ7VDjVpgXcjzsmkXvX/Rwqs=';
const FIRST_CHECK = 20 * 1000;
const EVERY = 4 * 60 * 60 * 1000;

// what the release script signs
const signedText = (version, sha512) => `mclauncher-update:1:${version}:${sha512}`;

// x.y.z or x.y.z-tag.n, as semver orders them
function newer(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v));
    return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i];
  if (!x.pre.length || !y.pre.length) return !x.pre.length && !!y.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return false;
    if (y.pre[i] === undefined) return true;
    if (x.pre[i] === y.pre[i]) continue;
    const nx = /^\d+$/.test(x.pre[i]);
    const ny = /^\d+$/.test(y.pre[i]);
    if (nx && ny) return +x.pre[i] > +y.pre[i];
    if (nx !== ny) return ny;
    return x.pre[i] > y.pre[i];
  }
  return false;
}

function sha512(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('base64')));
  });
}

// sig: { version, sha512, signature } from <installer>.sig. Throws why not.
async function verify(file, version, sig, current = app.getVersion(), key = PUBLIC_KEY) {
  if (!sig || typeof sig.signature !== 'string' || typeof sig.sha512 !== 'string') throw new Error('no signature');
  if (sig.version !== version) throw new Error(`signed for ${sig.version}, offered as ${version}`);
  if (!newer(version, current)) throw new Error(`${version} is not newer than ${current}`);
  const pub = crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
  if (!crypto.verify(null, Buffer.from(signedText(sig.version, sig.sha512)), pub, Buffer.from(sig.signature, 'base64'))) throw new Error('bad signature');
  const actual = await sha512(file);
  if (actual !== sig.sha512) throw new Error('the file is not the signed one');
}

let updater = null;
let ready = null; // { version } once a downloaded update has passed the check
let notify = () => {};

async function check() {
  try {
    await updater.checkForUpdates();
  } catch (e) {
    log.warn(`Update check: ${e.message}`);
  }
}

// notify(event, payload): 'update:ready' { version } for the window
function start(opts = {}) {
  if (updater || !app.isPackaged || (process.env.MCL_DATA_DIR && !process.env.MCL_UPDATE_FEED) || process.env.MCL_NO_UPDATE) return;
  notify = opts.notify || notify;
  updater = require('electron-updater').autoUpdater;
  updater.logger = { info: (m) => log.info(`Update: ${m}`), warn: (m) => log.warn(`Update: ${m}`), error: (m) => log.warn(`Update: ${m}`), debug() {} };
  updater.setFeedURL({ provider: 'generic', url: FEED });
  updater.autoDownload = true;
  updater.allowPrerelease = true;
  updater.allowDowngrade = false;
  // installed by us on quit, and only once the signature is checked
  updater.autoInstallOnAppQuit = false;
  // where electron-updater asks for the publisher's signature (only if the
  // build names a publisher): ours instead of Windows' (our exe's certificate
  // is our own, not a CA's)
  updater.verifyUpdateCodeSignature = async () => null;
  updater.on('update-available', (info) => log.info(`Update: ${info.version} available, downloading.`));
  updater.on('update-downloaded', async (info) => {
    const file = info.downloadedFile;
    try {
      const { net } = require('electron');
      const name = (info.files && info.files[0] && info.files[0].url) || info.path;
      const res = await net.fetch(new URL(`${encodeURI(name)}.sig`, FEED).href, { cache: 'no-store' });
      if (!res.ok) throw new Error(`signature: HTTP ${res.status}`);
      await verify(file, info.version, await res.json());
      ready = { version: info.version };
      log.info(`Update: ${info.version} downloaded and checked — goes in when the launcher closes.`);
      notify('update:ready', ready);
    } catch (e) {
      ready = null;
      log.warn(`Update: ${info.version} rejected (${e.message}).`);
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* electron-updater's cache: next time */
      }
    }
  });
  updater.on('error', (e) => log.warn(`Update: ${e && e.message}`));
  setTimeout(check, FIRST_CHECK).unref();
  setInterval(check, EVERY).unref();
}

// the launcher is closing for good: the checked update goes in (silently)
function onQuit() {
  if (!ready || !updater) return;
  log.info(`Update: installing ${ready.version} on the way out.`);
  updater.quitAndInstall(true, false);
  ready = null;
}

// the toast's button: install now and start the launcher again
function installNow() {
  if (!ready || !updater) return false;
  log.info(`Update: installing ${ready.version} now.`);
  updater.quitAndInstall(true, true);
  ready = null;
  return true;
}

module.exports = { start, onQuit, installNow, state: () => ready, _test: { verify, newer, signedText } };
