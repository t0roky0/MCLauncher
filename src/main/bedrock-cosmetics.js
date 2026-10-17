'use strict';
// Cosmetics in Bedrock, drawn by the game itself and part of its own vanilla
// resources — no pack in the game's settings to switch off. The launcher's
// module in the game (bedrock-native/src/overlay.cpp) hands the game our
// copies of a few of its vanilla files (overlay.txt says which: the path
// under data\resource_packs → our file), and only for a game it got into
// before the game read its list of vanilla files (else nothing at all, the
// game as it is).
//
// What the game reads (tools/bedrock/pack-diagnostics, 10.10.2026): vanilla
// packs are .brarchive files, one per folder; the list of what's in a pack
// (contents.json) once at start — what isn't on it the game never looks for;
// the archives every time it loads resources: at start and on entering any
// world or server. So:
//   - all the catalogue's items, every time (the list can't grow later):
//     geometry, textures, render controllers, animations — the "static" part;
//   - who wears what: the player's client entity, in every vanilla pack that
//     has it — the "dynamic" part, picked up on the next world or server
//     joined (a change in the launcher shows there).
// The players are picked by name with Molang's query.is_name_any, the way
// the game dresses a rabbit called Toast: you, your party, launcher users
// nearby. Only this PC sees them; a server's own pack redefining the player
// wins over ours.
//
// Each cosmetic is its own geometry with the player's bones (root → waist →
// body → head) around it, so every player animation moves it like the head
// or the body it sits on.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const log = require('./log');
const png = require('./png-rgba');

const NAME_OK = /^[A-Za-z0-9 _\-.]{1,32}$/;
const ID_OK = /^[a-z0-9_]{1,32}$/;
const OVERLAY_DIR = 'bedrock-cosmetics';
// the global resource pack cosmetics used to be (2.1.20-beta): taken away
const OLD_PACK_UUID = '0e22a749-11b2-4255-91fd-3b45eac1e37e';
const OLD_PACK_DIR = 'MCLauncherCosmetics';

// ---- the game's archives ---------------------------------------------------------------------

// .brarchive: 16 bytes (magic, count, version 1), count entries of 256 bytes
// (name length, name padded to 247 bytes, offset, size), then the data —
// names sorted, data back to back in their order.
const MAGIC = Buffer.from('7d2725b1a0527026', 'hex');

function parseArchive(b, label = 'archive') {
  const count = b.length >= 16 ? b.readUInt32LE(8) : -1;
  if (!b.subarray(0, 8).equals(MAGIC) || count < 0 || count > 100000 || 16 + count * 256 > b.length) throw new Error(`${label}: not an archive`);
  const base = 16 + count * 256;
  const out = new Map();
  for (let k = 0; k < count; k++) {
    const e = 16 + k * 256;
    const name = b.toString('utf8', e + 1, e + 1 + b[e]);
    const off = b.readUInt32LE(e + 248);
    const size = b.readUInt32LE(e + 252);
    if (base + off + size <= b.length) out.set(name, b.subarray(base + off, base + off + size));
  }
  return out;
}

const readArchive = (file) => parseArchive(fs.readFileSync(file), path.basename(file));

function writeArchive(entries) {
  const names = [...entries.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const head = Buffer.alloc(16 + names.length * 256);
  MAGIC.copy(head, 0);
  head.writeUInt32LE(names.length, 8);
  head.writeUInt32LE(1, 12);
  let off = 0;
  const data = [];
  names.forEach((name, k) => {
    const n = Buffer.from(name);
    if (n.length > 246) throw new Error(`${name}: name too long for an archive`);
    const body = entries.get(name);
    const e = 16 + k * 256;
    head[e] = n.length;
    n.copy(head, e + 1);
    head.writeUInt32LE(off, e + 248);
    head.writeUInt32LE(body.length, e + 252);
    data.push(body);
    off += body.length;
  });
  return Buffer.concat([head, ...data]);
}

// vanilla, vanilla_1.14 … vanilla_1.26.52 (oldest first): the game stacks
// them up to the world's version, the newer over the older
function packVersion(name) {
  if (name === 'vanilla') return [0];
  const m = /^vanilla_(\d+(?:\.\d+)*)$/.exec(name);
  return m ? m[1].split('.').map(Number) : null;
}
const newer = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
};
const packsRoot = (install) => path.join(install, 'data', 'resource_packs');

function vanillaPacks(install) {
  return fs.readdirSync(packsRoot(install))
    .map((name) => ({ name, v: packVersion(name) }))
    .filter((p) => p.v)
    .sort((a, b) => (newer(a.v, b.v) ? 1 : newer(b.v, a.v) ? -1 : 0))
    .map((p) => p.name);
}

const archiveOf = (install, pack, archive) => path.join(packsRoot(install), pack, '__brarchive', `${archive}.brarchive`);

// every vanilla pack whose <archive> holds <file>, oldest first
function packsWith(install, archive, file) {
  const out = [];
  for (const pack of vanillaPacks(install)) {
    const f = archiveOf(install, pack, archive);
    if (!fs.existsSync(f)) continue;
    try {
      if (readArchive(f).has(file)) out.push(pack);
    } catch (e) {
      log.warn(`Bedrock cosmetics: ${e.message}`);
    }
  }
  return out;
}

const parseJson = (buf) => JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));

// "No fire" (the overlay's Game tab, config.game.noFire): the burning
// flames low. Their pictures (textures/flame_atlas.png, square frames one
// over another) moved down each in its frame, the top of it left empty — the
// game draws them over the screen while you burn (and round anything that
// burns): low, they leave the screen free. The game reads it with the rest
// of its textures on entering a world.
const FIRE_DROP = 10 / 16;
function lowFireFiles(install) {
  const out = {};
  for (const pack of packsWith(install, 'textures', 'flame_atlas.png')) {
    try {
      const entries = readArchive(archiveOf(install, pack, 'textures'));
      const img = png.decode(entries.get('flame_atlas.png'));
      if (!img || img.height % img.width) continue;
      const { width: w, height: h, data } = img;
      const drop = Math.round(w * FIRE_DROP);
      const low = Buffer.alloc(data.length);
      for (let y = 0; y < h; y++) if (y % w >= drop) data.copy(low, y * w * 4, (y - drop) * w * 4, (y - drop + 1) * w * 4);
      entries.set('flame_atlas.png', png.encode({ width: w, height: h, data: low }));
      out[`${pack}/__brarchive/textures.brarchive`] = writeArchive(entries);
    } catch (e) {
      log.warn(`Bedrock low fire (${pack}): ${e.message}`);
    }
  }
  return out;
}
const noFire = () => {
  try { return !!((require('./config').get() || {}).game || {}).noFire; } catch { return false; }
};

// the newest vanilla definition of a file (for the dev pack in tools/bedrock)
function vanillaFile(install, archive, file) {
  const packs = packsWith(install, archive, file);
  if (!packs.length) throw new Error(`${file} не найден в файлах игры`);
  return parseJson(readArchive(archiveOf(install, packs[packs.length - 1], archive)).get(file));
}

// ---- our files ---------------------------------------------------------------------------

const q = (names) => (names.length ? `query.is_name_any(${names.map((n) => `'${n}'`).join(', ')})` : 'false');

// A cosmetic's Bedrock geometry (scripts/cosmetics writes <id>.geo.json with
// its part as one bone named after the player's) inside the player's bones.
function geometry(id) {
  const src = JSON.parse(fs.readFileSync(paths.asset('cosmetics', id, `${id}.geo.json`), 'utf8'))['minecraft:geometry'][0];
  const own = (n) => `mcl_${id}_${n}`;
  const top = src.bones[0].name; // 'head', 'body' or 'root' (a pet: the player as a whole)
  const bones = [
    { name: 'root', pivot: [0, 0, 0] },
    { name: 'waist', parent: 'root', pivot: [0, 12, 0] },
    { name: 'body', parent: 'waist', pivot: [0, 24, 0] },
  ];
  if (top === 'head') bones.push({ name: 'head', parent: 'body', pivot: [0, 24, 0] });
  const pet = top === 'root';
  if (pet) {
    // A pet: free of the player's bones (sneaking tilts the player's root,
    // and the pet went down with it), placed in front of the player — its
    // middle on -Z, as far out as it rests by the shoulder — and from there
    // where it really is (FOLLOW, the follow animation): turned round the
    // player (orbit), out or in and up or down (reach), its face (face).
    const mid = src.bones[0].pivot;
    const out = Math.hypot(mid[0], mid[2]);
    const move = (v) => [round(v[0] - mid[0]), v[1], round(v[2] - mid[2] - out)];
    bones.push({ name: own('orbit'), pivot: [0, 0, 0] });
    bones.push({ name: own('reach'), parent: own('orbit'), pivot: [0, 0, 0] });
    bones.push({ name: own('face'), parent: own('reach'), pivot: [0, mid[1], round(-out)] });
    for (const b of src.bones) {
      bones.push({ ...b, name: own(b.name), parent: b.parent ? own(b.parent) : own('face'), pivot: move(b.pivot || [0, 0, 0]),
        ...(b.cubes ? { cubes: b.cubes.map((c) => ({ ...c, origin: move(c.origin), ...(c.pivot ? { pivot: move(c.pivot) } : {}) })) } : {}) });
    }
  } else {
    for (const b of src.bones) bones.push({ ...b, name: own(b.name), parent: b.parent ? own(b.parent) : top });
  }
  return {
    format_version: '1.12.0',
    // a pet may be a few blocks from its player: drawn while it's in sight
    'minecraft:geometry': [{ description: { ...src.description, identifier: `geometry.mcl.${id}`, visible_bounds_width: pet ? 8 : 3, visible_bounds_height: pet ? 5 : 3.5, visible_bounds_offset: [0, 1.5, 0] }, bones }],
  };
}
const round = (v) => Math.round(v * 10000) / 10000;

function animation(id) {
  const file = paths.asset('cosmetics', id, `${id}.animation.json`);
  if (!fs.existsSync(file)) return null;
  const src = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = {};
  for (const [name, a] of Object.entries(src.animations || {})) {
    const bones = {};
    for (const [bone, v] of Object.entries(a.bones || {})) bones[`mcl_${id}_${bone}`] = v;
    out[name] = { ...a, bones };
  }
  // a pet where it is (dress()'s pre_animation, FOLLOW): round the player, how far out, how high, which way it looks
  if (isPet(id)) {
    const mid = JSON.parse(fs.readFileSync(paths.asset('cosmetics', id, `${id}.geo.json`), 'utf8'))['minecraft:geometry'][0].bones[0].pivot;
    const away = round(Math.hypot(mid[0], mid[2]));
    out[`animation.mcl.${id}.follow`] = { loop: true, bones: {
      [`mcl_${id}_orbit`]: { rotation: [0, 'v.mcl_rel', 0] },
      [`mcl_${id}_reach`]: { position: [0, 'v.mcl_rise', `${away} - v.mcl_r * 16`] },
      [`mcl_${id}_face`]: { rotation: [0, 'v.mcl_turn', 0] },
    } };
  }
  return out;
}

const isPet = (id) => {
  try { return JSON.parse(fs.readFileSync(paths.asset('cosmetics', id, `${id}.geo.json`), 'utf8'))['minecraft:geometry'][0].bones[0].name === 'root'; } catch { return false; }
};

// A pet's motion, each frame, for every player wearing one (Molang: the
// player's own variables; one expression, so its temps hold throughout) — the
// same as in Java (CosmeticLayer.follow). The pet is a point in the world of
// its own, anywhere by the player — no spot of its own to go back to: while
// the player is close it stays wherever it is; once the player is more than
// FAR off it flies after them, looking at them, and stops KEEP away on the
// side it's on, a little off straight behind (clear of a camera behind the
// player); walked into (nearer than NEAR) it moves aside, out to the player's
// side it's on. First placed by the left shoulder. A jump of more than 8
// blocks (a teleport): there at once.
// Kept as the pet's place FROM the player (v.mcl_ox/oy/oz, world axes,
// blocks), moved back by the player's own motion — never as a place in the
// world set against the player's: the game draws the player between two
// ticks in a way Molang doesn't see (taking query.position back by
// query.position_delta, or by the measured step times 1 − query.frame_alpha,
// each left the pet shaking 20 times a second in the game: measured on the
// screen at 126 fps). Along the ground the player's speed — each step of
// query.position over the time since the step before, smoothed — moves it
// back as evenly as the player is drawn; up and down each step is laid out
// over the time it takes (a tick at most), all of it, so a jump is followed
// exactly. Its height doesn't follow a jump or a crouch (query.position is
// the player's eyes in Bedrock: a crouch moves it too): the pet keeps to its
// own until it's off by more than a jump would take it (1.4 blocks) or by
// more than 0.6 for a while (stairs, a ledge), then floats to the player's.
// Angles are the game's yaw (0: +Z, clockwise from above); a bone turned by
// +a turns clockwise (as the head by query.target_y_rotation, and as the
// sleeping player's root is turned back by -query.body_y_rotation).
// In a screen (the inventory's figure, the paper doll) the pet rests by the
// shoulder and its state is left alone (that figure is drawn in the same frame).
// Out: v.mcl_rel (where the pet is, round the player, from its facing),
// v.mcl_r (how far, blocks), v.mcl_rise (how high, px), v.mcl_turn (its face,
// from facing away from the player), v.mcl_wind (0…1, how fast it flies).
const WRAP = (e) => `(math.mod(math.mod(${e}, 360) + 540, 360) - 180)`;
const SPOT_TURN = 105.4; // where it's first put: by the left shoulder, a little behind it (pets_pack.py SPOT)
const SPOT_OUT = 0.94; // …this far out, blocks
const FAR = 2.2; // the player further off than this (blocks): it flies after them
const KEEP = 1.1; // …and stops this far from them
const NEAR = 0.6; // nearer than this: it moves aside
const ASIDE = 1.2; // how far off straight behind it keeps when following (to the side: 1.2 ≈ 50°)
const FOLLOW = [[
  'v.mcl_on = v.mcl_on ?? 0;',
  '(!q.is_in_ui && !v.is_paperdoll) ? {',
  // worked out once a frame (a second look in the same frame — another pass of the picture — moves nothing)
  't.same = v.mcl_on && q.frame_alpha == v.mcl_fa && q.life_time == v.mcl_lt; v.mcl_fa = q.frame_alpha; v.mcl_lt = q.life_time;',
  't.dt = t.same ? 0 : math.clamp(q.delta_time, 0, 0.1);',
  't.x = q.position(0); t.y = q.position(1); t.z = q.position(2);',
  // the player's step since the last frame: none, or now and then a tick's
  't.sx = v.mcl_on ? t.x - v.mcl_qx : 0; t.sy = v.mcl_on ? t.y - v.mcl_qy : 0; t.sz = v.mcl_on ? t.z - v.mcl_qz : 0;',
  'v.mcl_qx = t.x; v.mcl_qy = t.y; v.mcl_qz = t.z;',
  't.step = math.abs(t.sx) + math.abs(t.sy) + math.abs(t.sz);',
  't.reset = !v.mcl_on || t.step > 8;',
  // how long since the step before (no step for a while: standing)
  'v.mcl_wait = (v.mcl_wait ?? 0) + t.dt;',
  't.moved = !t.reset && t.step > 0.000001;',
  't.k = math.clamp(v.mcl_wait, math.max(t.dt, 0.001), 0.1); t.kp = math.clamp(v.mcl_wait, math.max(t.dt, 0.001), 0.05);',
  // along the ground: the speed, smoothed
  'v.mcl_ux = t.moved ? t.sx / t.k : (v.mcl_wait > 0.15 ? 0 : (v.mcl_ux ?? 0));',
  'v.mcl_uz = t.moved ? t.sz / t.k : (v.mcl_wait > 0.15 ? 0 : (v.mcl_uz ?? 0));',
  't.e = 1 - math.exp(-t.dt * 12);',
  'v.mcl_vx = t.reset ? 0 : v.mcl_vx + (v.mcl_ux - v.mcl_vx) * t.e;',
  'v.mcl_vz = t.reset ? 0 : v.mcl_vz + (v.mcl_uz - v.mcl_vz) * t.e;',
  // up and down: each step laid out, all of it, over the time it takes to draw (a tick at most)
  'v.mcl_ly = t.reset ? 0 : v.mcl_ly + t.sy;',
  'v.mcl_ky = t.moved ? math.abs(v.mcl_ly) / t.kp : v.mcl_ky;',
  't.gy = math.clamp(v.mcl_ly, -v.mcl_ky * t.dt, v.mcl_ky * t.dt); v.mcl_ly = v.mcl_ly - t.gy;',
  'v.mcl_wait = t.moved ? 0 : v.mcl_wait;',
  // the body's turn, smoothed
  `v.mcl_yaw = t.reset ? q.body_y_rotation : v.mcl_yaw + ${WRAP('q.body_y_rotation - v.mcl_yaw')} * (1 - math.exp(-t.dt * 20));`,
  't.yaw = v.mcl_yaw;',
  // first put by the left shoulder; then moved back as the player moves
  `v.mcl_ox = t.reset ? -math.sin(t.yaw - ${SPOT_TURN}) * ${SPOT_OUT} : v.mcl_ox - v.mcl_vx * t.dt;`,
  `v.mcl_oz = t.reset ? math.cos(t.yaw - ${SPOT_TURN}) * ${SPOT_OUT} : v.mcl_oz - v.mcl_vz * t.dt;`,
  'v.mcl_oy = t.reset ? 0 : v.mcl_oy - t.gy;',
  'v.mcl_go = t.reset ? 0 : v.mcl_go; v.mcl_face = t.reset ? t.yaw : v.mcl_face;',
  't.d = math.sqrt(v.mcl_ox * v.mcl_ox + v.mcl_oz * v.mcl_oz);',
  `v.mcl_go = (t.d > ${FAR} || t.d < ${NEAR}) ? 1 : (math.abs(t.d - ${KEEP}) < 0.12 ? 0 : v.mcl_go);`,
  // where it goes: KEEP from the player on the side it's on, a little to the side of straight behind
  // (walked into: out to the player's left or right)
  't.lx = math.cos(t.yaw); t.lz = math.sin(t.yaw); t.side = v.mcl_ox * t.lx + v.mcl_oz * t.lz < 0 ? -1 : 1;',
  `t.ux = t.d < ${NEAR} ? t.lx * t.side : v.mcl_ox / math.max(t.d, 0.0001) + t.lx * t.side * ${ASIDE};`,
  `t.uz = t.d < ${NEAR} ? t.lz * t.side : v.mcl_oz / math.max(t.d, 0.0001) + t.lz * t.side * ${ASIDE};`,
  't.un = math.max(math.sqrt(t.ux * t.ux + t.uz * t.uz), 0.0001);',
  `t.mx = t.ux / t.un * ${KEEP} - v.mcl_ox; t.mz = t.uz / t.un * ${KEEP} - v.mcl_oz; t.away = math.sqrt(t.mx * t.mx + t.mz * t.mz);`,
  // easing into it (no jolt from standing still to full speed)
  'v.mcl_pace = t.reset ? 0 : (v.mcl_pace ?? 0) + (v.mcl_go - (v.mcl_pace ?? 0)) * (1 - math.exp(-t.dt * 6));',
  't.f = v.mcl_go ? (1 - math.exp(-t.dt * 3.8)) * v.mcl_pace : 0;',
  'v.mcl_ox = v.mcl_ox + t.mx * t.f; v.mcl_oz = v.mcl_oz + t.mz * t.f;',
  // its height: its own through a jump or a crouch, the player's once it's well off
  't.h = math.abs(v.mcl_oy); v.mcl_hold = t.h > 0.6 ? (v.mcl_hold ?? 0) + t.dt : 0;',
  'v.mcl_up = (t.h > 1.4 || v.mcl_hold > 0.8) ? 1 : (t.h < 0.05 ? 0 : (v.mcl_up ?? 0));',
  'v.mcl_oy = v.mcl_up ? v.mcl_oy * math.exp(-t.dt * 4) : v.mcl_oy;',
  'v.mcl_wind = math.lerp(v.mcl_wind ?? 0, math.clamp(t.away * t.f / math.max(t.dt, 0.001) / 4, 0, 1), 1 - math.exp(-t.dt * 4));',
  'v.mcl_r = math.sqrt(v.mcl_ox * v.mcl_ox + v.mcl_oz * v.mcl_oz);',
  'v.mcl_dir = math.atan2(-v.mcl_ox, v.mcl_oz);',
  `v.mcl_rel = ${WRAP('v.mcl_dir - t.yaw')};`,
  // flying after the player: its face to the player
  't.look = math.atan2(v.mcl_ox, -v.mcl_oz);',
  `v.mcl_face = v.mcl_go ? v.mcl_face + ${WRAP('t.look - v.mcl_face')} * (1 - math.exp(-t.dt * 4)) : v.mcl_face;`,
  `v.mcl_turn = ${WRAP('v.mcl_face - v.mcl_dir')};`,
  'v.mcl_rise = v.mcl_oy * 16;',
  'v.mcl_on = 1;',
  '};',
  // a screen's figure: at rest by the shoulder, looking where the player does
  `(q.is_in_ui || v.is_paperdoll) ? { v.mcl_rel = -${SPOT_TURN}; v.mcl_r = ${SPOT_OUT}; v.mcl_rise = 0; v.mcl_turn = ${SPOT_TURN}; v.mcl_wind = 0; };`,
].join(' ')];

function controller(id) {
  return {
    geometry: `Geometry.mcl_${id}`,
    // an outline's shells (import_bbmodel: outline_… bones) drawn from inside only, glowing
    materials: [{ '*': 'Material.mcl' }, { [`mcl_${id}_outline*`]: 'Material.mcl_outline' }],
    textures: [`Texture.mcl_${id}`],
    // its own bones, posed by the player's animations
    rebuild_animation_matrices: true,
  };
}

// wearers: [{ name, cos: [ids] }] — you and the party; the catalogue says
// where each item goes.
function plan(wearers, catalogue) {
  const by = new Map(); // id → names
  for (const w of wearers || []) {
    if (!w || !NAME_OK.test(String(w.name || ''))) continue;
    for (const id of w.cos || []) {
      if (!ID_OK.test(id) || !catalogue.has(id)) continue;
      if (!by.has(id)) by.set(id, new Set());
      by.get(id).add(w.name);
    }
  }
  return [...by].map(([id, names]) => ({ id, slot: catalogue.get(id).slot, names: [...names].sort() })).sort((a, b) => a.id.localeCompare(b.id));
}

// The player's client entity (the game's own, as it is in that pack) with our
// items on the end: their geometry, texture, animations and a render
// controller each, drawn on whoever wears them. variable.mcl_back: something
// of ours on the back — the cape makes room for it.
function dress(entity, items) {
  const out = JSON.parse(JSON.stringify(entity));
  const desc = out['minecraft:client_entity'].description;
  desc.geometry = { ...desc.geometry };
  desc.textures = { ...desc.textures };
  // the outline: one-sided (its shell is seen from inside) and glowing — its
  // pixel all but transparent lights it fully (the ender dragon's eyes'
  // material), so it's one even colour, not shaded face by face
  desc.materials = { ...desc.materials, mcl: 'entity_alphatest', mcl_outline: 'entity_emissive_alpha_one_sided' };
  desc.animations = { ...desc.animations };
  desc.scripts = { ...desc.scripts };
  desc.scripts.animate = [...(desc.scripts.animate || [])];
  const backs = [...new Set(items.filter((i) => i.slot === 'back').flatMap((i) => i.names))].sort();
  desc.scripts.pre_animation = [...(desc.scripts.pre_animation || []), `variable.mcl_back = ${q(backs)};`, ...(items.some((i) => i.slot === 'pet') ? FOLLOW : [])];
  desc.render_controllers = [...(desc.render_controllers || [])];
  for (const it of items) {
    desc.geometry[`mcl_${it.id}`] = `geometry.mcl.${it.id}`;
    desc.textures[`mcl_${it.id}`] = `textures/entity/mcl/${it.id}`;
    // not in first person (the game draws the player there in the hand's own
    // layer, over the world — a pet in it looked pasted on the screen), nor
    // over a helmet / an elytra (like the cape); a pet whatever is worn
    const own = it.slot === 'back' ? 'query.armor_texture_slot(1) != 5' : it.slot === 'pet' ? '1' : '!query.has_head_gear';
    desc.render_controllers.push({ [`controller.render.mcl.${it.id}`]: `!variable.is_first_person && !variable.map_face_icon && !query.is_spectator && ${own} && ${q(it.names)}` });
    for (const name of Object.keys(animation(it.id) || {})) {
      const key = `mcl_${it.id}_${name.split('.').pop()}`;
      desc.animations[key] = name;
      desc.scripts.animate.push(key);
    }
  }
  return out;
}

// the cape's controller: hidden while something of ours is on the back
function capeAside(controllers) {
  const out = JSON.parse(JSON.stringify(controllers));
  const c = out.render_controllers && out.render_controllers['controller.render.player.cape'];
  if (c) c.part_visibility = (c.part_visibility || []).map((p) => (p.cape ? { cape: `(${p.cape}) && !variable.mcl_back` } : p));
  return out;
}

const json = (v) => Buffer.from(JSON.stringify(v));

// An item's texture for the game: its TGA (the outline's glowing pixel kept
// exactly; scripts/cosmetics writes bedrock.tga), else the PNG.
function texture(id) {
  const tga = paths.asset('cosmetics', id, 'bedrock.tga');
  if (fs.existsSync(tga)) return { name: `${id}.tga`, bytes: fs.readFileSync(tga) };
  return { name: `${id}.png`, bytes: fs.readFileSync(paths.asset('cosmetics', id, 'texture.png')) };
}

// Vibrant Visuals reads entity emission from the green channel of a MER
// texture. The legacy emissive material alone does not supply PBR emission.
// Keep its near-transparent swatches intact for the classic renderer.
function textureFiles(id) {
  const t = texture(id);
  const files = new Map([[t.name, t.bytes]]);
  const b = t.bytes;
  if (t.name.endsWith('.tga') && b[1] === 0 && b[2] === 2 && b[16] === 32) {
    const start = 18 + b[0], pixels = b.readUInt16LE(12) * b.readUInt16LE(14);
    if (b.length < start + pixels * 4) throw new Error(`Invalid cosmetic texture: ${id}`);
    const mer = Buffer.from(b);
    for (let i = start; i < start + pixels * 4; i += 4) {
      // BGRA: roughness 1, emission only on the outline swatch, metalness 0.
      mer[i] = 255;
      mer[i + 1] = b[i + 3] === 3 ? 255 : 0;
      mer[i + 2] = 0;
      mer[i + 3] = 255;
    }
    files.set(`${id}_mer.tga`, mer);
    files.set(`${id}.texture_set.json`, json({ format_version: '1.16.100', 'minecraft:texture_set': {
      color: id, metalness_emissive_roughness: `${id}_mer`,
    } }));
  }
  return files;
}

// The catalogue's part: the same all session (the game's list of files is
// read once). rel (under data\resource_packs) → bytes.
function staticFiles(install, catalogue) {
  const ids = [...catalogue.keys()].sort();
  const files = {};
  const rel = (pack, archive) => `${pack}/__brarchive/${archive}.brarchive`;
  const added = [];

  const models = readArchive(archiveOf(install, 'vanilla', 'models/entity'));
  for (const id of ids) {
    models.set(`mcl_${id}.geo.json`, json(geometry(id)));
    added.push(`models/entity/mcl_${id}.geo.json`);
  }
  files[rel('vanilla', 'models/entity')] = writeArchive(models);

  const textures = new Map();
  for (const id of ids) {
    for (const [name, bytes] of textureFiles(id)) {
      textures.set(name, bytes);
      added.push(`textures/entity/mcl/${name}`);
    }
  }
  files[rel('vanilla', 'textures/entity/mcl')] = writeArchive(textures);
  const manifest = parseJson(fs.readFileSync(path.join(packsRoot(install), 'vanilla', 'manifest.json')));
  manifest.capabilities = [...new Set([...(manifest.capabilities || []), 'pbr'])];
  files['vanilla/manifest.json'] = json(manifest);

  // ours next to the game's controllers; the cape's in every pack that has it
  const controllers = {};
  for (const id of ids) controllers[`controller.render.mcl.${id}`] = controller(id);
  const capes = new Set(packsWith(install, 'render_controllers', 'cape.render_controllers.json'));
  for (const pack of new Set(['vanilla', ...capes])) {
    const arch = readArchive(archiveOf(install, pack, 'render_controllers'));
    if (capes.has(pack)) arch.set('cape.render_controllers.json', json(capeAside(parseJson(arch.get('cape.render_controllers.json')))));
    if (pack === 'vanilla') arch.set('mcl_cosmetics.render_controllers.json', json({ format_version: '1.8.0', render_controllers: controllers }));
    files[rel(pack, 'render_controllers')] = writeArchive(arch);
  }
  added.push('render_controllers/mcl_cosmetics.render_controllers.json');

  const animations = {};
  for (const id of ids) Object.assign(animations, animation(id) || {});
  if (Object.keys(animations).length) {
    const arch = readArchive(archiveOf(install, 'vanilla', 'animations'));
    arch.set('mcl_cosmetics.animation.json', json({ format_version: '1.8.0', animations }));
    files[rel('vanilla', 'animations')] = writeArchive(arch);
    added.push('animations/mcl_cosmetics.animation.json');
  }

  const contents = parseJson(fs.readFileSync(path.join(packsRoot(install), 'vanilla', 'contents.json')));
  const listed = new Set((contents.content || []).map((c) => c && c.path));
  contents.content = [...(contents.content || []), ...added.filter((p) => !listed.has(p)).map((p) => ({ path: p }))];
  files['vanilla/contents.json'] = Buffer.from(JSON.stringify(contents, null, 4));
  return files;
}

// Who wears what: the player's client entity in every vanilla pack that has it.
function dynamicFiles(install, items) {
  const files = {};
  for (const pack of packsWith(install, 'entity', 'player.entity.json')) {
    const arch = readArchive(archiveOf(install, pack, 'entity'));
    arch.set('player.entity.json', json(dress(parseJson(arch.get('player.entity.json')), items)));
    files[`${pack}/__brarchive/entity.brarchive`] = writeArchive(arch);
  }
  return files;
}

// Resource packs turned on in the game's settings (global) that bring their
// own player (Actions & Stuff: in its archives, under a made-up file name) —
// the game takes theirs over the vanilla one, so theirs is dressed too,
// handed over by its whole path. The player is found by what it is
// (identifier minecraft:player), not by its file's name.
// → [{ key: that file's path, kind: 'brarchive' | 'json', entry (in an archive), at: its mtime }]
const isPlayer = (buf) => {
  try {
    const d = parseJson(buf)['minecraft:client_entity'].description;
    return d.identifier === 'minecraft:player';
  } catch {
    return false;
  }
};
function packPlayers(bedrock) {
  const out = [];
  const ids = new Set();
  for (const dir of bedrock.profiles || []) {
    try {
      for (const p of parseJson(fs.readFileSync(path.join(dir, 'minecraftpe', 'global_resource_packs.json')))) if (p && p.pack_id) ids.add(String(p.pack_id).toLowerCase());
    } catch {
      /* no list there */
    }
  }
  if (!ids.size) return out;
  const roots = [bedrock.shared, ...(bedrock.profiles || [])].filter(Boolean).flatMap((d) => [path.join(d, 'resource_packs'), path.join(d, 'development_resource_packs')]);
  for (const root of [...new Set(roots)]) {
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names) {
      const pack = path.join(root, n);
      let uuid = '';
      try {
        uuid = String(parseJson(fs.readFileSync(path.join(pack, 'manifest.json'))).header.uuid).toLowerCase();
      } catch {
        continue;
      }
      if (!ids.has(uuid)) continue;
      const bases = [pack];
      try {
        for (const sp of fs.readdirSync(path.join(pack, 'subpacks'))) bases.push(path.join(pack, 'subpacks', sp));
      } catch {
        /* no subpacks */
      }
      for (const b of bases) {
        const arch = path.join(b, '__brarchive', 'entity.brarchive');
        try {
          for (const [entry, buf] of readArchive(arch)) if (isPlayer(buf)) out.push({ key: arch, kind: 'brarchive', entry, at: fs.statSync(arch).mtimeMs });
        } catch {
          /* none, or not one we can read */
        }
        let plain = [];
        try {
          plain = fs.readdirSync(path.join(b, 'entity')).filter((f) => f.endsWith('.json'));
        } catch {
          /* no folder of them */
        }
        for (const f of plain) {
          const file = path.join(b, 'entity', f);
          try {
            if (isPlayer(fs.readFileSync(file))) out.push({ key: file, kind: 'json', at: fs.statSync(file).mtimeMs });
          } catch {
            /* not one we can read */
          }
        }
      }
    }
  }
  return out;
}

// those packs' players dressed: files (packs/<n>.<ext>) and the paths they stand for
function packFiles(packs, items) {
  const files = {};
  const keys = {};
  packs.forEach((p, n) => {
    try {
      let bytes;
      if (p.kind === 'brarchive') {
        const arch = readArchive(p.key);
        arch.set(p.entry, json(dress(parseJson(arch.get(p.entry)), items)));
        bytes = writeArchive(arch);
      } else {
        bytes = json(dress(parseJson(fs.readFileSync(p.key)), items));
      }
      const rel = `packs/${n}.${p.kind === 'brarchive' ? 'brarchive' : 'json'}`;
      files[rel] = bytes;
      keys[rel] = p.key;
    } catch (e) {
      log.info(`Bedrock cosmetics: ${p.key}: ${e.message}`);
    }
  });
  return { files, keys };
}

// A pack of our own with the same files (tools/bedrock/dev_pack.cjs: to
// compare with the overlay). entity: the game's player definition.
function build(items, { entity }) {
  const files = {};
  const controllers = {};
  const animations = {};
  for (const it of items) {
    files[`models/entity/mcl_${it.id}.geo.json`] = geometry(it.id);
    for (const [name, bytes] of textureFiles(it.id)) files[`textures/entity/mcl/${name}`] = bytes;
    controllers[`controller.render.mcl.${it.id}`] = controller(it.id);
    Object.assign(animations, animation(it.id) || {});
  }
  files['entity/player.entity.json'] = dress(entity, items);
  files['render_controllers/mcl_cosmetics.render_controllers.json'] = { format_version: '1.8.0', render_controllers: controllers };
  if (Object.keys(animations).length) files['animations/mcl_cosmetics.animation.json'] = { format_version: '1.8.0', animations };
  return files;
}

// ---- writing it where the module looks -------------------------------------------------------------

function catalogue() {
  const out = new Map();
  for (const it of JSON.parse(fs.readFileSync(paths.asset('cosmetics', 'index.json'), 'utf8'))) out.set(it.id, it);
  return out;
}

const overlayRoot = () => path.join(paths.appDir, OVERLAY_DIR);
const overlayList = () => path.join(overlayRoot(), 'overlay.txt');

// what the static part is made of: the game and our items' files
function staticKey(bedrock, cat) {
  const h = crypto.createHash('sha256').update(`pbr-entity-v1\n${bedrock.packageVersion}\n${bedrock.install}\n`);
  for (const id of [...cat.keys()].sort()) {
    h.update(`${id}:${cat.get(id).slot}\n`);
    for (const f of [`${id}.geo.json`, 'texture.png', 'bedrock.tga', `${id}.animation.json`]) {
      const p = paths.asset('cosmetics', id, f);
      if (fs.existsSync(p)) h.update(fs.readFileSync(p));
    }
  }
  return h.digest('hex').slice(0, 16);
}

// a folder of files, all or nothing (written aside, then renamed in place)
async function writeSet(dir, files) {
  if (fs.existsSync(path.join(dir, '.done'))) return;
  const tmp = `${dir}.tmp`;
  await fsp.rm(tmp, { recursive: true, force: true });
  for (const [rel, data] of Object.entries(files)) {
    const f = path.join(tmp, ...rel.split('/'));
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, data);
  }
  await fsp.writeFile(path.join(tmp, '.done'), '');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rename(tmp, dir);
}

// The module's list: one line per file, "<path under resource_packs>\t<our file>".
async function writeList(sets) {
  const lines = ['# MC Launcher: vanilla files the game gets from us (bedrock-native/src/overlay.cpp)'];
  for (const { dir, files, keys } of sets) for (const rel of Object.keys(files).sort()) lines.push(`${(keys && keys[rel]) || rel.split('/').join('\\')}\t${path.join(dir, ...rel.split('/'))}`);
  const tmp = `${overlayList()}.tmp`;
  await fsp.writeFile(tmp, lines.join('\r\n') + '\r\n', 'utf8');
  await fsp.rename(tmp, overlayList());
}

// older sets: away (one the game still has open stays till next time)
async function prune(keep) {
  let names = [];
  try {
    names = await fsp.readdir(overlayRoot());
  } catch {
    return;
  }
  for (const n of names) {
    if (keep.has(n) || n === 'overlay.txt') continue;
    await fsp.rm(path.join(overlayRoot(), n), { recursive: true, force: true }).catch(() => {});
  }
}

// the global resource pack of earlier versions, and its place in the lists
async function removeOldPack(bedrock) {
  for (const dir of bedrock.profiles || []) {
    const file = path.join(dir, 'minecraftpe', 'global_resource_packs.json');
    try {
      const list = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!Array.isArray(list) || !list.some((p) => p && p.pack_id === OLD_PACK_UUID)) continue;
      await fsp.writeFile(`${file}.mcl-tmp`, JSON.stringify(list.filter((p) => !p || p.pack_id !== OLD_PACK_UUID)));
      await fsp.rename(`${file}.mcl-tmp`, file);
    } catch {
      /* no list there */
    }
  }
  if (bedrock.shared) await fsp.rm(path.join(bedrock.shared, 'resource_packs', OLD_PACK_DIR), { recursive: true, force: true }).catch(() => {});
}

let last = '';
let wearersOf = () => [];
let running = Promise.resolve();
let oldPackGone = false;

// Brings the overlay in line with who wears what. bedrock: { install,
// packageVersion, shared, profiles } from bedrock.js (found here if not given).
function sync(wearers, bedrock) {
  const job = running.then(() => syncNow(wearers, bedrock));
  running = job.catch(() => {});
  return job;
}

async function syncNow(wearers, bedrock) {
  if (!bedrock) bedrock = await require('./bedrock').packTarget();
  if (!bedrock || !bedrock.install) return { written: false, reason: 'no-game' };
  if (!oldPackGone) {
    oldPackGone = true;
    await removeOldPack(bedrock);
  }
  const cat = catalogue();
  const items = plan(wearers || wearersOf(), cat);
  const sKey = staticKey(bedrock, cat);
  const packs = packPlayers(bedrock);
  const fire = noFire();
  const dKey = crypto.createHash('sha256').update(JSON.stringify([sKey, items, packs, fire ? 'low-fire-1' : ''])).digest('hex').slice(0, 16);
  const key = `${sKey}/${dKey}`;
  if (key === last && fs.existsSync(overlayList())) return { written: false, reason: 'same' };
  const sDir = path.join(overlayRoot(), `s-${sKey}`);
  const dDir = path.join(overlayRoot(), `d-${dKey}`);
  const sFiles = fs.existsSync(path.join(sDir, '.done')) ? listed(sDir) : staticFiles(bedrock.install, cat);
  await writeSet(sDir, sFiles);
  const theirs = packFiles(packs, items);
  const dFiles = { ...dynamicFiles(bedrock.install, items), ...theirs.files, ...(fire ? lowFireFiles(bedrock.install) : {}) };
  await writeSet(dDir, dFiles);
  await writeList([{ dir: sDir, files: sFiles }, { dir: dDir, files: dFiles, keys: theirs.keys }]);
  await prune(new Set([path.basename(sDir), path.basename(dDir), last ? `d-${last.split('/')[1]}` : '']));
  last = key;
  log.info(`Bedrock cosmetics: ${items.length ? items.map((i) => `${i.id} (${i.names.length})`).join(', ') : 'nobody wears anything'}.`);
  return { written: true, items };
}

// the files of a set already written: rel → (unused) — for the list
function listed(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.name !== '.done') out[r] = null;
    }
  };
  walk(dir, '');
  return out;
}

module.exports = {
  sync,
  // who wears what, for a sync with no list of its own (before the game starts)
  setWearers(fn) {
    wearersOf = fn;
  },
  // the module reads this (bridge.ini: overlay=)
  overlayList,
  _test: { parseArchive, readArchive, writeArchive, plan, dress, capeAside, build, staticFiles, dynamicFiles, packPlayers, packFiles, vanillaFile, vanillaPacks, packsWith, lowFireFiles, reset: () => { last = ''; oldPackGone = false; } },
};
