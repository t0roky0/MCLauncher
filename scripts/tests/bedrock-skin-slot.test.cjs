// Bedrock puts its synced look back over options.txt at every start; a skin
// from our pack is kept there by its index, so the chosen skin must land on it.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const PACK = '22951263-eb9f-42f9-a39f-180ef1656a7a';

function fixture(t, {slot, profiles}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-bedrock-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const users = path.join(root, 'Minecraft Bedrock', 'Users');
  fs.mkdirSync(path.join(users, 'Shared', 'games', 'com.mojang'), {recursive: true});
  let age = 0;
  for (const p of profiles) {
    const mojang = path.join(users, p.id, 'games', 'com.mojang');
    fs.mkdirSync(path.join(mojang, 'minecraftpe'), {recursive: true});
    const options = path.join(mojang, 'minecraftpe', 'options.txt');
    fs.writeFileSync(options, `gfx_fullscreen:0\ngame_skintypefull:c18e65aa-7b21-4637-9b63-8ad63622ef01_Steve\nlast_xuid:${p.xuid}\n`);
    const when = new Date(Date.now() - 60000 * age++);
    fs.utimesSync(options, when, when);
    if (p.ud) fs.writeFileSync(path.join(mojang, 'ud123.dat'), JSON.stringify(p.ud));
  }
  const skinsDir = path.join(root, 'skins');
  fs.mkdirSync(skinsDir);
  const library = ['aaa', 'bbb', 'ccc'].map((id) => ({id, name: id.toUpperCase(), file: `${id}.png`, model: 'classic'}));
  for (const s of library) fs.writeFileSync(path.join(skinsDir, s.file), '64x64 '+s.id);
  const cfg = {bedrockSkin: 'ccc', accounts: [{id: 'xbox:2', xuid: '2'}], activeAccount: 'xbox:2', bedrockPackRev: 0};
  const deps = {
    electron: {nativeImage: {createFromBuffer(b) { const m=/^(\d+)x(\d+)/.exec(b.toString()); return {isEmpty:()=>!m,getSize:()=>({width:+m?.[1]||0,height:+m?.[2]||0})}; }}, shell: {openExternal: async () => {}, openPath: async () => ''}},
    './config': {get: () => cfg, mutate: (fn) => fn(cfg)},
    './log': {info() {}, warn() {}},
    child_process: {execFile: (cmd, args, opts, cb) => cb(null, '')},
  };
  const module = {exports: {}};
  const proc = {env: {APPDATA: root, LOCALAPPDATA: root}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/main/bedrock.js'), 'utf8'), {module, exports: module.exports, require: (id) => deps[id] || require(id.startsWith('.') ? path.join(__dirname, '../../src/main', id) : id), process: proc, Buffer, console, setTimeout, clearTimeout});
  const pack = () => JSON.parse(fs.readFileSync(path.join(users, 'Shared', 'games', 'com.mojang', 'skin_packs', 'MCLauncher', 'skins.json'), 'utf8')).skins.map((s) => s.localization_name);
  const selected = (id) => /game_skintypefull:(.*)/.exec(fs.readFileSync(path.join(users, id, 'games', 'com.mojang', 'minecraftpe', 'options.txt'), 'utf8'))[1];
  const packDir = path.join(users, 'Shared', 'games', 'com.mojang', 'skin_packs', 'MCLauncher');
  return {api: module.exports, cfg, library, skinsDir, pack, selected, root, packDir};
}

const look = (slotItems, last = 'persona_profile_persona2') => ({
  ProfileVersion: 5,
  Synchronized: {
    personaProfile: {personaCollection: {universalApp: [{lastUsedPersonaSlot: last, typeId: 'skin'}]}},
    personaProfile2: {personaCollection: {universalApp: slotItems}},
  },
});

test('the chosen skin goes to the place the game look points at', async (t) => {
  const f = fixture(t, {profiles: [{id: '100', xuid: '2', ud: look([{skin: true, cs_arm: 'wide'}, {id: 'piece/d'}, {id: `${PACK}.1`}])}]});
  const r = await f.api.applySkin(f.library, f.skinsDir);
  assert.equal(r.applied, true);
  assert.equal(r.pickOnce, false);
  assert.deepEqual(f.pack(), ['mcl_aaa', 'mcl_ccc', 'mcl_bbb']);
  assert.equal(f.selected('100'), `${PACK}_mcl_ccc`);
});

test('a place past the library is filled with copies of the chosen skin', async (t) => {
  const f = fixture(t, {profiles: [{id: '100', xuid: '2', ud: look([{skin: true}, {id: `${PACK}.4`}])}]});
  await f.api.applySkin(f.library, f.skinsDir);
  const names = f.pack();
  assert.equal(names.length, 5);
  assert.equal(names[4], 'mcl_ccc');
  assert.ok(names.slice(2, 4).every((n) => n.startsWith('mcl_ccc')));
});

test('a persona look keeps the library order and asks for one pick in the game', async (t) => {
  const f = fixture(t, {profiles: [{id: '100', xuid: '2', ud: look([{skin: false}, {id: 'piece/d'}])}]});
  const r = await f.api.applySkin(f.library, f.skinsDir);
  assert.equal(r.pickOnce, true);
  assert.deepEqual(f.pack(), ['mcl_aaa', 'mcl_bbb', 'mcl_ccc']);
});

test('the skin goes to the launcher account profile, not just the last one played', async (t) => {
  const f = fixture(t, {profiles: [{id: '100', xuid: '1'}, {id: '200', xuid: '2'}]});
  const r = await f.api.applySkin(f.library, f.skinsDir);
  assert.equal(r.profile, '200');
  assert.equal(f.selected('200'), `${PACK}_mcl_ccc`);
  assert.match(f.selected('100'), /_Steve$/);
  assert.equal(f.api.signedInXuid(), '1');
});

test('Bedrock pack does not promise unsupported custom capes', async (t) => {
  const f = fixture(t, {profiles: [{id:'100', xuid:'2', ud:look([{skin:true,cs_arm:'wide'}, {id:PACK+'.1'}])}]});
  const r = await f.api.applySkin(f.library, f.skinsDir);
  assert.equal(r.applied, true);
  const skins = JSON.parse(fs.readFileSync(path.join(f.packDir, 'skins.json'), 'utf8')).skins;
  assert.ok(skins.every(s => !s.cape));
});

test('Bedrock revalidates disk pixels before writing its pack', async t=>{
 const f=fixture(t,{profiles:[{id:'100',xuid:'2'}]});
 await f.api.applySkin(f.library,f.skinsDir);
 const before=fs.readFileSync(path.join(f.packDir,'skins.json'));
 fs.writeFileSync(path.join(f.skinsDir,'ccc.png'),'256x256');
 await assert.rejects(f.api.applySkin(f.library,f.skinsDir),/256×256/);
 assert.deepEqual(fs.readFileSync(path.join(f.packDir,'skins.json')),before);
 fs.writeFileSync(path.join(f.skinsDir,'ccc.png'),'128x128');
 fs.writeFileSync(path.join(f.skinsDir,'aaa.png'),'129x128');
 await f.api.applySkin(f.library,f.skinsDir);
 assert.deepEqual(f.pack(),['mcl_bbb','mcl_ccc']);
});
