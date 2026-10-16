// No credential on disk or in the log: the log scrubber, the v1 clean-up and
// the game's argument file.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function load(file, deps, extra = {}) {
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/main', file), 'utf8'), {module, exports: module.exports, require: (id) => deps[id] || require(id), process, Buffer, console, setTimeout, clearTimeout, TextDecoder, ...extra});
  return module.exports;
}

function logger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-log-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return load('log.js', {'./paths': {logsDir: dir}});
}

test('known tokens never reach the log, even inside game output', (t) => {
  const log = logger(t);
  const token = 'abcDEF0123456789.secret-token_value';
  log.secret(token);
  log.info(`launching with ${token}`);
  log.game(`[main/INFO]: arg ${token}`);
  const lines = log.history().map((l) => l.text);
  assert.ok(lines.every((l) => !l.includes(token)));
  assert.ok(lines.every((l) => l.includes('<token>')));
});

test('anything shaped like a credential is scrubbed', (t) => {
  const log = logger(t);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const refresh = `M.C540_BAY.0.U.-${'Cp!8*z$Q'.repeat(10)}`;
  log.info(`token ${jwt}`);
  log.info(`refresh_token=${'x'.repeat(40)} next`);
  log.warn(`stored ${refresh}`);
  log.info(`blob ${'A'.repeat(200)}`);
  const text = log.history().map((l) => l.text).join('\n');
  assert.ok(!text.includes(jwt.split('.')[1]));
  assert.ok(!text.includes('x'.repeat(40)));
  assert.ok(!text.includes('Cp!8*z$Q'));
  assert.ok(!text.includes('A'.repeat(200)));
  assert.match(text, /refresh_token=<token> next/);
});

test('ordinary lines stay as they are', (t) => {
  const log = logger(t);
  const line = 'Game started: Fabric 1.21.11 (pid 4242), -Xmx4096M -cp C:\\games\\lib\\a.jar;C:\\games\\lib\\b.jar net.minecraft.client.main.Main';
  log.info(line);
  assert.equal(log.history()[0].text, line);
});

test('the v1 copy loses its tokens and keeps the rest', () => {
  const {stripSecrets} = load('hygiene.js', {'./paths': {}, './log': {info() {}, warn() {}}});
  const v1 = {msAccessToken: 'secret', ramMb: 4096, account: {name: 'Player', refreshToken: 'r'}, accentColor: '#fff'};
  assert.equal(stripSecrets(v1), 2);
  assert.deepEqual(v1, {ramMb: 4096, account: {name: 'Player'}, accentColor: '#fff'});
});

test('a long command line puts only the JVM side in the argument file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-args-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const deps = {electron: {app: {}}, './config': {get: () => ({})}, './installer': {}, './native': {}, './game-skins': {}, './log': {info() {}, warn() {}, error() {}, secret() {}, game() {}}};
  const game = load('game.js', deps);
  const token = 'TOKEN-0123456789abcdef';
  const args = ['-Xmx2G', '-cp', 'x'.repeat(30000), 'net.minecraft.client.main.Main', '--username', 'Player', '--accessToken', token];
  const out = await game.maybeArgFile(args, {javaMajor: 21, gameDir: dir, mainClass: 'net.minecraft.client.main.Main'});
  assert.ok(out[0].startsWith('@'));
  assert.deepEqual(Array.from(out.slice(1)), args.slice(3)); // the module runs in its own realm
  const file = fs.readFileSync(out[0].slice(1), 'utf8');
  assert.ok(!file.includes(token));
  assert.ok(!file.includes('net.minecraft.client.main.Main'));
});
