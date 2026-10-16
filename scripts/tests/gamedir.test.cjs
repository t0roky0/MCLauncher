// The game's files follow the launcher to the drive it was installed on.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function load(t, {installDir, gameDir, instances = []}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-gamedir-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const defaultGameDir = 'C:\\Users\\player\\AppData\\Roaming\\.minecraft';
  const existing = new Set(instances.map((id) => path.join(root, id)));
  const cfg = {gameDir: gameDir || defaultGameDir, installs: [{id: 'a'}, {id: 'b'}, {id: 'bedrock', isBedrock: true}]};
  const deps = {
    electron: {app: {isPackaged: true}},
    './config': {get: () => cfg, mutate: (fn) => fn(cfg), dirs: {instance: (id) => path.join(root, id)}},
    './paths': {defaultGameDir},
    './log': {info() {}, warn() {}},
    fs: {...fs, existsSync: (p) => existing.has(p) || fs.existsSync(p)},
  };
  const module = {exports: {}};
  const proc = {...process, execPath: path.join(installDir, 'MC Launcher.exe')};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/main/gamedir.js'), 'utf8'), {module, exports: module.exports, require: (id) => deps[id] || require(id), process: proc, console});
  return {api: module.exports, cfg, root};
}

test('installed on another drive with nothing downloaded: the game goes next to the launcher', (t) => {
  const {api, cfg} = load(t, {installDir: 'D:\\Games\\MC Launcher'});
  const r = api.check();
  assert.equal(r.switched, 'D:\\Games\\.minecraft');
  assert.equal(cfg.gameDir, 'D:\\Games\\.minecraft');
  assert.equal(api.check(), null); // asked once per install folder
});

test('installations on the old drive: the window is asked, and "leave it" sticks', async (t) => {
  const {api, cfg, root} = load(t, {installDir: 'E:\\MC Launcher', instances: []});
  fs.mkdirSync(path.join(root, 'a'));
  const r = api.check();
  assert.ok(r.offer);
  assert.deepEqual({...api.pending(), from: undefined}, {target: 'E:\\.minecraft', drive: 'E:', count: 1, from: undefined});
  assert.equal(cfg.gameDir, 'C:\\Users\\player\\AppData\\Roaming\\.minecraft');
  assert.deepEqual({...(await api.answer(false))}, {moved: false});
  assert.equal(cfg.gameDirCheckedFor, 'E:\\MC Launcher');
  assert.equal(api.check(), null);
});

test('same drive, or a folder chosen by hand: nothing changes', (t) => {
  const same = load(t, {installDir: 'C:\\Games\\MC Launcher'});
  assert.equal(same.api.check(), null);
  assert.equal(same.cfg.gameDir, 'C:\\Users\\player\\AppData\\Roaming\\.minecraft');
  const custom = load(t, {installDir: 'D:\\MC Launcher', gameDir: 'F:\\Minecraft'});
  assert.equal(custom.api.check(), null);
  assert.equal(custom.cfg.gameDir, 'F:\\Minecraft');
});
