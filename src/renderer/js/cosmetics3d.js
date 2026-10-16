// Cosmetics on the 3D player (skinview3d): a model from assets/cosmetics
// (cubes in Blockbench's coordinates, made by scripts/cosmetics) becomes a
// group on the head or the body, so it moves with every pose and emote.
//
// Blockbench: the neck at y=24, the face on north (-Z). skinview3d: the head
// group's origin is the neck, the body group's the body's centre (y=18), the
// face towards +Z — so a model turns half round and moves down onto its bone.
import { BoxGeometry, DoubleSide, Euler, FrontSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, NearestFilter, TextureLoader } from 'three';

// a pet's bone, root: the player as a whole (skinview3d's skin group: its origin the neck)
const BONE_Y = { head: 24, body: 18, root: 24 };
// BoxGeometry's face order, as Blockbench names them (built in Blockbench's space)
const ORDER = ['east', 'west', 'up', 'down', 'south', 'north'];
// a flat part's two sides (no thickness along that axis: 0 x, 1 y, 2 z)
const SIDES = [['east', 'west'], ['up', 'down'], ['south', 'north']];
const loader = new TextureLoader();
const cache = new Map(); // url → Promise<{model, texture}>

function load(base) {
  if (!cache.has(base)) {
    cache.set(base, (async () => {
      const model = await (await fetch(`${base}/model.json`)).json();
      const texture = await loader.loadAsync(`${base}/texture.png`);
      texture.magFilter = NearestFilter;
      texture.minFilter = NearestFilter;
      // colours as the skins get them (skinview3d leaves its textures
      // unconverted): converting from sRGB here darkened every cosmetic and
      // turned its gold orange next to the skin
      return { model, texture };
    })().catch((e) => {
      cache.delete(base);
      throw e;
    }));
  }
  return cache.get(base);
}

// materials: [both sides, front only, an outline's: front only and unlit]
function cubeMesh(cube, [tw, th], materials) {
  const size = [0, 1, 2].map((i) => cube.to[i] - cube.from[i]);
  // A flat part drawn on both its sides (an axe's blade, a hat's tip): the
  // two faces lie in one plane, and drawn both ways each shows through the
  // other — the picture flickers. Each is drawn from its own side only; a
  // plane with one face keeps it on both sides. An outline's shell
  // (cube.cull) is seen from inside only, like in the game, and isn't lit:
  // one even colour (the game's glows the same way).
  const oneSided = new Set(cube.cull ? Object.keys(cube.faces) : []);
  SIDES.forEach((pair, i) => {
    if (Math.abs(size[i]) < 1e-6 && pair.every((n) => cube.faces[n])) pair.forEach((n) => oneSided.add(n));
  });
  const g = new BoxGeometry(...size);
  const uv = g.attributes.uv;
  const keep = [[], []];
  ORDER.forEach((name, f) => {
    const r = cube.faces[name];
    if (!r) return;
    const [x1, y1, x2, y2] = r;
    // vertices of a face: top-left, top-right, bottom-left, bottom-right
    [[x1, y1], [x2, y1], [x1, y2], [x2, y2]].forEach(([x, y], k) => uv.setXY(f * 4 + k, x / tw, 1 - y / th));
    keep[oneSided.has(name) ? 1 : 0].push(...g.index.array.slice(f * 6, f * 6 + 6));
  });
  uv.needsUpdate = true;
  g.setIndex([...keep[0], ...keep[1]]);
  g.clearGroups();
  g.addGroup(0, keep[0].length, 0);
  g.addGroup(keep[0].length, keep[1].length, cube.outline ? 2 : 1);
  const mesh = new Mesh(g, materials);
  // a cube turns about its origin (Blockbench's pivot), in Z-Y-X order
  const pivot = new Group();
  pivot.position.set(...cube.origin);
  pivot.rotation.copy(new Euler(...cube.rotation.map((d) => (d * Math.PI) / 180), 'ZYX'));
  mesh.position.set(...[0, 1, 2].map((i) => (cube.from[i] + cube.to[i]) / 2 - cube.origin[i]));
  pivot.add(mesh);
  return pivot;
}

const DEG = Math.PI / 180;

// A heartbeat's swell over one beat (0…1 of the period): a pulse, a smaller
// one just after, then rest.
const pulse = (t, at, width) => Math.exp(-(((t - at) / width) ** 2));
const heartbeat = (t) => pulse(t, 0.1, 0.05) + 0.6 * pulse(t, 0.3, 0.055);

// Now and then (import_bbmodel: burst, blink): how far into its burst a
// part is (seconds) and the burst's hump 0…1…0 over its length, else 0.
function burstAt(b, time) {
  const u = (((time + (b.offset || 0)) % b.every) + b.every) % b.every;
  return [u, u < b.dur ? Math.sin((Math.PI * u) / b.dur) : 0];
}

// A part's turn now: its rest pose plus its slow motion (degrees, a sine),
// a quick motion now and then (an ear's flick), its float up and down (a
// halo), its beat (a size that swells and settles), or a blink.
function pose(group, time) {
  const { base, anim, pivot } = group.userData;
  const k = anim && (anim.rot || anim.bob) ? Math.sin((2 * Math.PI * time) / anim.period + (anim.phase || 0)) : 0;
  let kick = 0;
  if (anim && anim.burst) {
    const [u, hump] = burstAt(anim.burst, time);
    kick = Math.sin((2 * Math.PI * u) / anim.burst.period) * hump;
  }
  group.rotation.set(...base.map((b, i) => (b + (anim && anim.rot ? anim.rot[i] * k : 0) + (kick ? anim.burst.rot[i] * kick : 0)) * DEG), 'ZYX');
  if (anim && anim.bob) group.position.y = pivot[1] + anim.bob * k;
  if (anim && anim.beat) {
    const t = ((time / anim.period + (anim.phase || 0)) % 1 + 1) % 1;
    group.scale.setScalar(1 + anim.beat * heartbeat(t));
  }
  if (anim && anim.blink) group.scale.y = 1 - anim.blink.squash * burstAt(anim.blink, time)[1];
}

// The cosmetic's own group, in skinview3d's space for its bone.
export async function cosmeticObject(base) {
  const { model, texture } = await load(base);
  // one pass each (a transparent two-sided material is otherwise drawn twice, its shader looked up anew each time)
  const materials = [DoubleSide, FrontSide].map((side) => new MeshStandardMaterial({ map: texture, transparent: true, alphaTest: 0.01, side, forceSinglePass: true }));
  const line = new MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.5, side: FrontSide });
  // a pet's line a little farther from the eye than it is (as in the game): where its own body
  // is, the body wins — no strip of it over the body where one part hangs over another
  if (model.float) {
    line.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        mvPosition.xyz *= 1.0 + 4.0 / max(length(mvPosition.xyz), 0.001);
        gl_Position = projectionMatrix * mvPosition;`);
    };
    line.customProgramCacheKey = () => 'mcl-pet-line';
  }
  materials.push(line);
  const inner = new Group();
  // parts (wings…): a group at the part's pivot, turned as a whole
  const parts = new Map();
  const moving = [];
  for (const b of model.bones || []) {
    const g = new Group();
    g.position.set(...b.pivot);
    g.userData = { pivot: b.pivot, base: b.rotation || [0, 0, 0], anim: b.anim || null };
    pose(g, 0);
    inner.add(g);
    parts.set(b.name, g);
    if (b.anim) moving.push(g);
  }
  for (const c of model.cubes) {
    const piece = cubeMesh(c, model.texture, materials);
    const part = c.bone && parts.get(c.bone);
    if (!part) {
      inner.add(piece);
      continue;
    }
    piece.position.set(...c.origin.map((v, i) => v - part.userData.pivot[i]));
    part.add(piece);
  }
  // a pet floats as a whole: up and down, turning a little about its middle
  const f = model.float;
  let hover = inner;
  if (f) {
    hover = new Group();
    hover.position.set(...f.centre);
    inner.position.set(...f.centre.map((v) => -v));
    hover.add(inner);
  }
  const float = (t) => {
    hover.position.y = f.centre[1] + f.bob * Math.sin((2 * Math.PI * t) / f.period);
    hover.rotation.y = f.sway * DEG * Math.sin((2 * Math.PI * t) / f.swayPeriod);
  };
  // the motion follows the clock whenever the cosmetic is drawn
  const first = (moving.length || f) && inner.getObjectByProperty('isMesh', true);
  if (first) first.onBeforeRender = () => { const t = performance.now() / 1000; for (const g of moving) pose(g, t); if (f) float(t); };
  const outer = new Group();
  outer.name = `cosmetic:${model.id}`;
  outer.userData = { id: model.id, bone: model.bone, slot: model.slot, hides: model.hides || [] };
  outer.rotation.y = Math.PI; // the face: Blockbench's north → skinview3d's +Z
  outer.position.y = -(BONE_Y[model.bone] ?? 24);
  outer.add(hover);
  return outer;
}

// Puts cosmetics on a skinview3d player, one per slot; [] takes them all off.
// Loaded first and swapped in at once; `current()` false by then (a newer
// call) leaves the player as it is.
export async function wearCosmetics(playerObject, bases, current = () => true) {
  const objects = await Promise.all(bases.map((b) => cosmeticObject(b).catch(() => null)));
  if (!current()) return false;
  const skin = playerObject.skin;
  for (const part of [skin.head, skin.body, skin]) {
    for (const child of [...part.children]) if (child.name.startsWith('cosmetic:')) part.remove(child);
  }
  const taken = new Set();
  const hidden = new Set();
  for (const o of objects) {
    if (!o || taken.has(o.userData.slot)) continue;
    taken.add(o.userData.slot);
    for (const part of o.userData.hides) hidden.add(part);
    (o.userData.bone === 'body' ? skin.body : o.userData.bone === 'root' ? skin : skin.head).add(o);
  }
  // a cosmetic worn instead of a part (a pumpkin for the head): that part goes
  for (const [name, part] of [['head', skin.head], ['body', skin.body]]) {
    for (const layer of [part.innerLayer, part.outerLayer]) if (layer) layer.visible = !hidden.has(name);
  }
  return true;
}

export const cosmeticBase = (id) => `mcl://app/assets/cosmetics/${id}`;
