// Skins in Java for players without one at Mojang (game-skins.js + the agent
// in assets/agent), the full game for every account (no --demo), and Xbox
// accounts without Java playing it offline under the gamertag.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SRC = path.join(__dirname, '../../src/main');
const offlineUuid = (name) => {
  const b = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

function run(file, deps, extra = {}) {
  const module = {exports: {}};
  const ctx = {module, exports: module.exports, require: (id) => deps[id] || require(id.startsWith('.') ? path.join(__dirname, '../../src/main', id) : id), process, Buffer, console, setTimeout, clearTimeout, URL, ...extra};
  vm.runInNewContext(fs.readFileSync(path.join(SRC, file), 'utf8'), ctx);
  return {exports: module.exports, ctx};
}

function loadSkins(t, {cfg = {}, partyState = {active: false}} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-skins-test-'));
  const partyListeners = [];
  const party = {state: () => partyState, onEvent: (fn) => partyListeners.push(fn)};
  const deps = {
    './config': {get: () => cfg, offlineUuid},
    './paths': {appDir: root, asset: (...p) => path.join(__dirname, '../../assets', ...p)},
    './party': party,
    './nearby': {state:()=>({members:[]}),onEvent(){}},
    './log': {info() {}, warn() {}},
  };
  const {exports} = run('game-skins.js', deps);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {gameSkins: exports, root, party, partyListeners, setParty: (s) => (partyState = s)};
}

const png = (seed) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(String(seed))]);
const dataUrl = (b) => `data:image/png;base64,${b.toString('base64')}`;

test('own skin and the party go to the agent; the PNG is served and cached', async (t) => {
  const pal = png('pal');
  const env = loadSkins(t, {partyState: {active: true, members: [{self: true, name: 'Me', skin: dataUrl(png('x'))}, {name: 'PartyPal', model: 'slim', skin: dataUrl(pal)}]}});
  const assets = path.join(env.root, 'assets');
  const me = png('me');
  const r = await env.gameSkins.prepare({self: {uuid: offlineUuid('Me'), name: 'Me', model: 'classic', png: me}, assetsRoot: assets});
  assert.ok(r, 'agent attached');
  const [arg] = r.jvmArgs;
  const m = /^-javaagent:(.+\.jar)=(.+\.txt)$/.exec(arg);
  assert.ok(m, arg);
  assert.ok(fs.existsSync(m[1]), 'agent jar copied out of the app');
  // (the overlay's game settings, "#comfort" lines, aside)
  const lines = fs.readFileSync(m[2], 'utf8').trim().split('\n').filter((l) => !l.startsWith('#comfort')).map((l) => l.split('\t'));
  assert.deepEqual(lines.map((l) => l.slice(0, 3)), [[offlineUuid('Me'), 'Me', 'classic'], [offlineUuid('PartyPal'), 'PartyPal', 'slim']]);

  // the URL serves the skin, and the game's own cache already has it
  const res = await fetch(lines[1][3]);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), pal);
  const sha = /\/skin\/([0-9a-f]{64})\.png$/.exec(lines[0][3])[1];
  assert.deepEqual(fs.readFileSync(env.gameSkins.cacheFile(assets, sha)), me);
  assert.equal((await fetch(lines[0][3].replace(sha, '0'.repeat(64)))).status, 404);

  // someone leaves the party: the file follows
  env.setParty({active: false});
  for (const fn of env.partyListeners) fn('changed');
  assert.equal(fs.readFileSync(m[2], 'utf8').trim().split('\n').filter((l) => !l.startsWith('#comfort')).length, 1);

  r.release();
  await new Promise((res2) => setTimeout(res2, 50));
  assert.equal(fs.existsSync(m[2]), false, 'file gone with the game');
});

test('nothing attached when switched off or with nothing to show', async (t) => {
  const off = loadSkins(t, {cfg: {gameSkins: false}});
  assert.equal(await off.gameSkins.prepare({self: {uuid: 'u', name: 'A', model: 'classic', png: png(1)}, assetsRoot: ''}), null);
  const empty = loadSkins(t);
  const discovery = await empty.gameSkins.prepare({self: null, assetsRoot: ''});
  assert.ok(discovery, 'agent discovers nearby launcher users even with default own skin');
  discovery.release();
});

test('party control works without skins, follows lobby membership, and is revoked on leaving', async t => {
  const env = loadSkins(t, { cfg: { gameSkins: false }, partyState: { active: false } });
  const control = await env.gameSkins.prepare({ self: null, assetsRoot: '', installId: 'java', partyBridge: true });
  assert.ok(control);
  const file = /^-javaagent:.+\.jar=(.+\.txt)$/.exec(control.jvmArgs[0])[1];
  const read = () => fs.readFileSync(file, 'utf8');
  assert.match(read(), /#party\trole\t\n/);
  env.setParty({ active: true, leader: true, code: 'test', members: [] });
  for (const fn of env.partyListeners) fn('changed');
  assert.match(read(), /#party\trole\tleader/);
  assert.match(read(), /#lan/);
  assert.equal(control.connect('example.test'), false, 'leader is not redirected');
  env.setParty({ active: true, leader: false, code: 'test', members: [] });
  for (const fn of env.partyListeners) fn('changed');
  assert.equal(control.connect('example.test:25566'), true);
  assert.match(read(), /#party\tjoin\t[0-9a-f]+ /);
  assert.doesNotMatch(read(), /#lan/);
  env.setParty({ active: false });
  for (const fn of env.partyListeners) fn('changed');
  assert.doesNotMatch(read(), /#party\tjoin/);
  control.release();
});

test('the game never gets --demo, and gets the agent', () => {
  const deps = {
    './config': {get: () => ({windowWidth: 854, windowHeight: 480}), dirs: {libraries: () => 'L'}},
    './installer': {collectArgs: (list, features) => list.flatMap((x) => (typeof x === 'string' ? [x] : Object.entries(x.rules[0].features).every(([k, v]) => !!features[k] === v) ? [x.value] : []))},
    './native': {},
    './game-skins': {},
    './log': {info() {}},
    electron: {app: {getVersion: () => '0'}},
  };
  const {ctx} = run('game.js', deps);
  const spec = {
    nativesDir: 'N', classpath: ['a.jar'], versionName: '1.21', gameDir: 'G', assetsRoot: 'A', gameAssets: 'A', assetsId: '1', versionType: 'release', javaMajor: 21, mainClass: 'net.minecraft.client.main.Main',
    jvmArgsTemplate: ['-cp', '${classpath}'],
    gameArgsTemplate: ['--username', '${auth_player_name}', {rules: [{features: {is_demo_user: true}}], value: '--demo'}, '--demo'],
  };
  const args = ctx.buildCommand({loader: 'vanilla'}, spec, {name: 'Guest', uuid: offlineUuid('Guest'), accessToken: '0', userType: 'legacy'}, {extraJvm: ['-javaagent:x.jar=y.txt']});
  assert.equal(args.includes('--demo'), false);
  assert.ok(args.indexOf('-javaagent:x.jar=y.txt') < args.indexOf(spec.mainClass));
  assert.deepEqual(Array.from(args.slice(args.indexOf(spec.mainClass) + 1, args.indexOf(spec.mainClass) + 3)), ['--username', 'Guest']);
});

test('an Xbox account without Java plays Java offline under its Java name', async () => {
  const xbox = {id: 'xbox:1', type: 'xbox', name: 'T0roky0', gamertag: 'T0roky0', xuid: '1'};
  const deps = {
    electron: {BrowserWindow: class {}, shell: {}, session: {}},
    './net': {},
    './config': {get: () => ({accounts: [xbox], activeAccount: 'xbox:1'}), offlineUuid},
    './log': {info() {}, warn() {}},
  };
  const {exports: auth} = run('auth.js', deps);
  const s = await auth.sessionForLaunch();
  assert.equal(s.name, 'T0roky0');
  assert.equal(s.uuid, offlineUuid('T0roky0'));
  assert.equal(s.offline, true);
  assert.equal(s.accountId, 'xbox:1');
});
