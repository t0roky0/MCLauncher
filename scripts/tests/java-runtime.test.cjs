// A Java runtime with javaw.exe but without the files the JVM boots from (a
// download cut short) must not be used: that's "could not open jvm.cfg".
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function load(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-java-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const warnings = [];
  const deps = {
    './net': {},
    './config': {dirs: {runtime: () => path.join(root, 'runtime')}},
    './paths': {LOCALAPPDATA: path.join(root, 'local')},
    './native': {fileVersion: () => null, javaRegistryHomes: () => []},
    './log': {info() {}, warn: (m) => warnings.push(m)},
  };
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/main/java.js'), 'utf8'), {module, exports: module.exports, require: (id) => deps[id] || require(id), process, Buffer, console});
  return {java: module.exports, root, warnings};
}

function runtime(home, files) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(home, f)), {recursive: true});
    fs.writeFileSync(path.join(home, f), f === 'release' ? 'JAVA_VERSION="21.0.7"\n' : 'x');
  }
}

const FULL = ['bin/javaw.exe', 'bin/java.exe', 'bin/java.dll', 'bin/server/jvm.dll', 'lib/jvm.cfg', 'lib/modules', 'release'];

test('a complete runtime boots, a half-downloaded one does not', (t) => {
  const {java, root} = load(t);
  const home = path.join(root, 'rt');
  runtime(home, ['bin/javaw.exe', 'release']);
  assert.equal(java.bootable(home), false);
  runtime(home, FULL);
  assert.equal(java.bootable(home), true);
});

test('Java 8 layout counts as complete', (t) => {
  const {java, root} = load(t);
  const home = path.join(root, 'jre8');
  runtime(home, ['bin/javaw.exe', 'bin/java.dll', 'bin/client/jvm.dll', 'lib/amd64/jvm.cfg', 'lib/rt.jar']);
  assert.equal(java.bootable(home), true);
});

test('offline, an incomplete runtime in the game folder is skipped for a complete one', async (t) => {
  const {java, root, warnings} = load(t);
  const comp = 'java-runtime-delta';
  runtime(path.join(root, 'runtime', comp, 'windows-x64', comp), ['bin/javaw.exe', 'release']);
  const store = path.join(root, 'local', 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime', comp, 'windows-x64', comp);
  runtime(store, FULL);
  // no network: the runtime index can't be fetched and isn't cached
  const deps = await java.ensureRuntime(comp).catch((e) => e);
  assert.ok(!(deps instanceof Error), String(deps && deps.message));
  assert.equal(path.normalize(deps.home), path.normalize(store));
  assert.ok(warnings.some((w) => /incomplete/.test(w)));
});
