// Bedrock cosmetics in the game's own vanilla files (src/main/bedrock-cosmetics.js,
// bedrock-native/src/overlay.cpp). The archive format against the installed
// game's own archives; the files we hand the game, built from them; the
// module's redirection outside the game.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-overlay-'));
// the module with a scratch data folder and quiet logs
const stub = (rel, exports) => { const f = require.resolve(path.join(root, 'src/main', rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
stub('paths', { appDir: scratch, asset: (...p) => path.join(root, 'assets', ...p) });
stub('log', { info() {}, warn() {} });
const cos = require(path.join(root, 'src/main/bedrock-cosmetics.js'))._test;

const INSTALL = 'C:\\XboxGames\\Minecraft for Windows\\Content';
const game = fs.existsSync(path.join(INSTALL, 'data', 'resource_packs', 'vanilla', 'contents.json'));
const catalogue = new Map(JSON.parse(fs.readFileSync(path.join(root, 'assets/cosmetics/index.json'), 'utf8')).map((it) => [it.id, it]));

test('archive: what we write reads back the same, names in order', () => {
  const entries = new Map([['b.json', Buffer.from('{"b":1}')], ['a_b.png', Buffer.from([1, 2, 3])], ['a.v1.json', Buffer.alloc(0)]]);
  const bytes = cos.writeArchive(entries);
  assert.equal(bytes.readUInt32LE(8), 3);
  assert.equal(bytes.readUInt32LE(12), 1);
  const back = cos.parseArchive(bytes);
  assert.deepEqual([...back.keys()], ['a.v1.json', 'a_b.png', 'b.json']);
  for (const [k, v] of entries) assert.deepEqual(back.get(k), v);
  assert.throws(() => cos.parseArchive(Buffer.from('not an archive at all, really')), /not an archive/);
});

// (a few of the game's keep their data in another order than the names —
// editor textures, languages — the same archive for the game)
test('archive: the game\'s own archives, read and written again, are the same', { skip: !game && 'Bedrock not installed' }, () => {
  let checked = 0;
  let identical = 0;
  for (const pack of ['vanilla', 'vanilla_1.21.90', 'vanilla_1.26.50', 'editor']) {
    const dir = path.join(INSTALL, 'data', 'resource_packs', pack, '__brarchive');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.brarchive') ? [path.join(d, e.name)] : []));
    for (const f of walk(dir)) {
      const orig = fs.readFileSync(f);
      const written = cos.writeArchive(cos.parseArchive(orig));
      const label = path.relative(INSTALL, f);
      assert.equal(written.length, orig.length, label);
      assert.ok(written.subarray(0, 16).equals(orig.subarray(0, 16)), label);
      for (let k = 0; k < orig.readUInt32LE(8); k++) {
        const e = 16 + k * 256;
        assert.ok(written.subarray(e, e + 248).equals(orig.subarray(e, e + 248)), `${label}: entry ${k}`);
        assert.equal(written.readUInt32LE(e + 252), orig.readUInt32LE(e + 252), `${label}: entry ${k} size`);
      }
      assert.deepEqual(cos.parseArchive(written), cos.parseArchive(orig), label);
      if (written.equals(orig)) identical++;
      checked++;
    }
  }
  assert.ok(checked > 100 && identical > checked * 0.9, `${identical} of ${checked} archives byte for byte`);
});

test('plan: names checked, unknown items left out, by item', () => {
  const items = cos.plan([{ name: 'T0roky0', cos: ['witch_hat', 'bat_wings', 'nope'] }, { name: 'bad\'name', cos: ['witch_hat'] }, { name: 'Friend', cos: ['witch_hat'] }], catalogue);
  assert.deepEqual(items, [{ id: 'bat_wings', slot: 'back', names: ['T0roky0'] }, { id: 'witch_hat', slot: 'head', names: ['Friend', 'T0roky0'] }]);
});

test('static part: every catalogue item in the vanilla pack, on its list', { skip: !game && 'Bedrock not installed' }, () => {
  const files = cos.staticFiles(INSTALL, catalogue);
  const ids = [...catalogue.keys()];
  const models = cos.parseArchive(files['vanilla/__brarchive/models/entity.brarchive']);
  const orig = cos.readArchive(path.join(INSTALL, 'data/resource_packs/vanilla/__brarchive/models/entity.brarchive'));
  for (const [k, v] of orig) assert.deepEqual(models.get(k), v, `vanilla ${k} untouched`);
  for (const id of ids) {
    const geo = JSON.parse(models.get(`mcl_${id}.geo.json`));
    assert.equal(geo['minecraft:geometry'][0].description.identifier, `geometry.mcl.${id}`);
  }
  const textures = cos.parseArchive(files['vanilla/__brarchive/textures/entity/mcl.brarchive']);
  // the game gets each item's TGA (an outline's glowing pixel kept exactly): uncompressed, 32-bit;
  // with its texture set for shaders (the outline the only glowing part of its MER map)
  assert.deepEqual([...textures.keys()].sort(), ids.flatMap((id) => [`${id}.tga`, `${id}_mer.tga`, `${id}.texture_set.json`]).sort());
  for (const [name, t] of textures) if (name.endsWith('.tga')) assert.deepEqual([t[2], t[16]], [2, 32]);
  const rc = JSON.parse(cos.parseArchive(files['vanilla/__brarchive/render_controllers.brarchive']).get('mcl_cosmetics.render_controllers.json'));
  for (const id of ids) assert.ok(rc.render_controllers[`controller.render.mcl.${id}`]);
  // the cape makes room for something of ours on the back, in every pack that defines it
  const capes = cos.packsWith(INSTALL, 'render_controllers', 'cape.render_controllers.json');
  assert.ok(capes.length >= 1);
  for (const pack of capes) {
    const cape = JSON.parse(cos.parseArchive(files[`${pack}/__brarchive/render_controllers.brarchive`]).get('cape.render_controllers.json'));
    assert.match(JSON.stringify(cape.render_controllers['controller.render.player.cape'].part_visibility), /!variable\.mcl_back/, pack);
  }
  assert.ok(cos.parseArchive(files['vanilla/__brarchive/animations.brarchive']).has('mcl_cosmetics.animation.json'));
  const list = JSON.parse(files['vanilla/contents.json']).content.map((c) => c.path);
  const origList = JSON.parse(fs.readFileSync(path.join(INSTALL, 'data/resource_packs/vanilla/contents.json'), 'utf8')).content.map((c) => c.path);
  assert.deepEqual(list.slice(0, origList.length), origList);
  for (const id of ids) {
    assert.ok(list.includes(`models/entity/mcl_${id}.geo.json`));
    assert.ok(list.includes(`textures/entity/mcl/${id}.tga`));
  }
  assert.ok(list.includes('render_controllers/mcl_cosmetics.render_controllers.json'));
});

test('dynamic part: the player in every vanilla pack that has one, dressed by name', { skip: !game && 'Bedrock not installed' }, () => {
  const items = cos.plan([{ name: 'T0roky0', cos: ['witch_hat', 'bat_wings'] }, { name: 'Friend', cos: ['broom'] }], catalogue);
  const files = cos.dynamicFiles(INSTALL, items);
  const packs = cos.packsWith(INSTALL, 'entity', 'player.entity.json');
  assert.deepEqual(Object.keys(files).sort(), packs.map((p) => `${p}/__brarchive/entity.brarchive`).sort());
  for (const pack of packs) {
    const arch = cos.parseArchive(files[`${pack}/__brarchive/entity.brarchive`]);
    const orig = cos.readArchive(path.join(INSTALL, 'data/resource_packs', pack, '__brarchive/entity.brarchive'));
    assert.deepEqual([...arch.keys()], [...orig.keys()], `${pack}: same files`);
    const desc = JSON.parse(arch.get('player.entity.json'))['minecraft:client_entity'].description;
    const rc = JSON.stringify(desc.render_controllers);
    assert.match(rc, /controller\.render\.mcl\.witch_hat.*query\.is_name_any\('T0roky0'\)/, pack);
    assert.match(rc, /controller\.render\.mcl\.broom.*query\.is_name_any\('Friend'\)/, pack);
    assert.equal(desc.geometry.mcl_bat_wings, 'geometry.mcl.bat_wings');
    assert.equal(desc.textures.mcl_witch_hat, 'textures/entity/mcl/witch_hat');
    assert.ok(desc.scripts.pre_animation.includes("variable.mcl_back = query.is_name_any('Friend', 'T0roky0');"), pack);
    assert.ok(desc.scripts.animate.some((a) => a.startsWith('mcl_bat_wings')), pack);
    // the game's own player untouched otherwise
    const vanilla = JSON.parse(orig.get('player.entity.json'))['minecraft:client_entity'].description;
    for (const k of Object.keys(vanilla.geometry)) assert.equal(desc.geometry[k], vanilla.geometry[k]);
    assert.deepEqual(desc.render_controllers.slice(0, vanilla.render_controllers.length), vanilla.render_controllers);
  }
  // nobody wears anything: the player as it is, plus a variable at 0
  const none = cos.dynamicFiles(INSTALL, []);
  const desc = JSON.parse(cos.parseArchive(none[`${packs[0]}/__brarchive/entity.brarchive`]).get('player.entity.json'))['minecraft:client_entity'].description;
  assert.ok(desc.scripts.pre_animation.includes('variable.mcl_back = false;'));
  assert.ok(!JSON.stringify(desc.render_controllers).includes('mcl'));
});

test('module: hands the game our files only when it got in before the game read its list', { skip: !fs.existsSync(path.join(root, 'bedrock-native/build/Release/mcl-overlay-test.exe')) && 'mcl-overlay-test not built (npm run build:bedrock)' }, () => {
  for (const mode of ['armed', 'late', 'nolist']) {
    const r = spawnSync(path.join(root, 'bedrock-native/build/Release/mcl-overlay-test.exe'), [path.join(scratch, `exe-${mode}`), mode], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${mode}:\n${r.stdout}${r.stderr}`);
  }
});

test('an outline glows in the game: one-sided emissive material, its UVs on a near-transparent pixel of its colour', () => {
  const dressed = cos.dress({ 'minecraft:client_entity': { description: { materials: { default: 'entity_alphatest' } } } }, [{ id: 'halo', slot: 'head', names: ['T0roky0'] }]);
  assert.equal(dressed['minecraft:client_entity'].description.materials.mcl_outline, 'entity_emissive_alpha_one_sided');
  const dir = path.join(root, 'assets/cosmetics/halo');
  const geo = JSON.parse(fs.readFileSync(path.join(dir, 'halo.geo.json'), 'utf8'))['minecraft:geometry'][0];
  const shells = geo.bones.filter((b) => b.name.startsWith('outline_')).flatMap((b) => b.cubes);
  assert.ok(shells.length > 0);
  // the TGA: 18-byte header, 32-bit BGRA rows from the bottom up
  const tga = fs.readFileSync(path.join(dir, 'bedrock.tga'));
  const w = tga.readUInt16LE(12), h = tga.readUInt16LE(14);
  const at = (x, y) => { const o = 18 + ((h - 1 - y) * w + x) * 4; return [tga[o + 2], tga[o + 1], tga[o], tga[o + 3]]; };
  for (const c of shells) {
    for (const f of Object.values(c.uv)) {
      const [r, g, b, a] = at(Math.floor(f.uv[0] + f.uv_size[0] / 2), Math.floor(f.uv[1] + f.uv_size[1] / 2));
      assert.equal(a, 3);
      assert.deepEqual([r, g, b], [255, 255, 255]); // the halo's line is white
    }
  }
  // the launcher and Java keep the solid one
  const model = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
  const solid = model.cubes.find((c) => c.outline);
  assert.notDeepEqual(Object.values(solid.faces)[0], Object.values(shells[0].uv)[0].uv);
});

test('a resource pack the player turned on that brings its own player: theirs dressed too, by its whole path', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-packs-'));
  const shared = path.join(base, 'Shared', 'games', 'com.mojang');
  const profile = path.join(base, '123', 'games', 'com.mojang');
  const pack = path.join(shared, 'resource_packs', 'Actions');
  const uuid = '2cf066eb-1254-4b7d-affb-80fe3216b18c';
  const player = { format_version: '1.10.0', 'minecraft:client_entity': { description: { identifier: 'minecraft:player', materials: { default: 'entity_alphatest' }, geometry: { default: 'geometry.humanoid.custom' }, textures: {}, render_controllers: ['controller.render.player.first_person'], scripts: { animate: [] }, animations: {} } } };
  fs.mkdirSync(path.join(pack, 'subpacks', 'SP0', '__brarchive'), { recursive: true });
  fs.mkdirSync(path.join(pack, 'subpacks', 'SP2', '__brarchive'), { recursive: true });
  fs.writeFileSync(path.join(pack, 'manifest.json'), JSON.stringify({ header: { uuid: uuid.toUpperCase() } }));
  fs.writeFileSync(path.join(pack, 'subpacks', 'SP0', '__brarchive', 'entity.brarchive'), cos.writeArchive(new Map([['drw.json', Buffer.from(JSON.stringify(player))], ['zombie.entity.json', Buffer.from('{}')]])));  // a made-up name, as Actions & Stuff has
  fs.writeFileSync(path.join(pack, 'subpacks', 'SP2', '__brarchive', 'entity.brarchive'), cos.writeArchive(new Map([['zombie.entity.json', Buffer.from('{}')]])));
  // a pack that isn't turned on is left alone
  fs.mkdirSync(path.join(shared, 'resource_packs', 'Off', 'entity'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'resource_packs', 'Off', 'manifest.json'), JSON.stringify({ header: { uuid: '00000000-0000-0000-0000-000000000000' } }));
  fs.writeFileSync(path.join(shared, 'resource_packs', 'Off', 'entity', 'player.entity.json'), JSON.stringify(player));
  fs.mkdirSync(path.join(profile, 'minecraftpe'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'minecraftpe', 'global_resource_packs.json'), JSON.stringify([{ pack_id: uuid, subpack: 'SP0', version: [1, 11, 0] }]));

  const packs = cos.packPlayers({ shared, profiles: [profile] });
  assert.deepEqual(packs.map((p) => [p.key, p.kind]), [[path.join(pack, 'subpacks', 'SP0', '__brarchive', 'entity.brarchive'), 'brarchive']]);
  const { files, keys } = cos.packFiles(packs, [{ id: 'halo', slot: 'head', names: ['T0roky0'] }]);
  assert.deepEqual(Object.values(keys), [packs[0].key]);
  const arch = cos.parseArchive(files[Object.keys(files)[0]]);
  const dressed = JSON.parse(arch.get('drw.json'))['minecraft:client_entity'].description;
  assert.equal(dressed.geometry.mcl_halo, 'geometry.mcl.halo');
  assert.ok(dressed.render_controllers.some((c) => typeof c === 'object' && c['controller.render.mcl.halo']));
  assert.equal(arch.get('zombie.entity.json').toString(), '{}'); // the rest of theirs as it was
});

test('a crash in the game leaves its place and calls in logs\bedrock-crash.log', { skip: !fs.existsSync(path.join(root, 'bedrock-native/build/Release/mcl-crashlog-test.exe')) && 'mcl-crashlog-test not built (npm run build:bedrock)' }, () => {
  const r = spawnSync(path.join(root, 'bedrock-native/build/Release/mcl-crashlog-test.exe'), [path.join(scratch, 'crash.log')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
