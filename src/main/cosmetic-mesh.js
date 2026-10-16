'use strict';
// Cosmetics for the Java agent (CosmeticLayer): each item's cubes baked into
// quads in the game's model space, ready to draw on the head or body part.
//
// The catalogue (assets/cosmetics/<id>/model.json) is in Blockbench's space:
// Y up, the neck at y=24, the face to -Z. The game's model space has Y down
// and X mirrored (the renderer's scale(-1, -1, 1)), the part's pivot at the
// neck, and counts in blocks: (x, y, z) → (-x, 24 - y, z) / 16. A turn about
// X or Y changes sign there, about Z it doesn't.
//
// The file: "slot", "bone" (head, body, or root: a pet, by the player as a
// whole), "float" (a pet: bob up and down and its period, a turn this way and
// that and its period, about its middle), then parts (a wing: its pivot,
// rest turn and slow swing) and faces — part index, normal, 4 × (x y z u v), the corners
// in the order the launcher's 3D draws them (top-left, top-right,
// bottom-left, bottom-right of the texture rectangle) taken round as a quad.
// An outline's faces ("g" for "f"): drawn from their front only and at full
// light, all with the one normal (up) — an even line, no face shaded darker.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');

const DEG = Math.PI / 180;

// rotation Z·Y·X (Euler 'ZYX', as Blockbench and three.js here): x first
function turn([rx, ry, rz], [x, y, z]) {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx * DEG), Math.sin(rx * DEG), Math.cos(ry * DEG), Math.sin(ry * DEG), Math.cos(rz * DEG), Math.sin(rz * DEG)];
  [y, z] = [y * cx - z * sx, y * sx + z * cx];
  [x, z] = [x * cy + z * sy, -x * sy + z * cy];
  [x, y] = [x * cz - y * sz, x * sz + y * cz];
  return [x, y, z];
}

// Each face's corners as three.js's BoxGeometry builds them (k = 0…3:
// texture top-left, top-right, bottom-left, bottom-right), and its normal.
const FACES = {
  east: { n: [1, 0, 0], k: [[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1]] },
  west: { n: [-1, 0, 0], k: [[-1, 1, -1], [-1, 1, 1], [-1, -1, -1], [-1, -1, 1]] },
  up: { n: [0, 1, 0], k: [[-1, 1, -1], [1, 1, -1], [-1, 1, 1], [1, 1, 1]] },
  down: { n: [0, -1, 0], k: [[-1, -1, 1], [1, -1, 1], [-1, -1, -1], [1, -1, -1]] },
  south: { n: [0, 0, 1], k: [[-1, 1, 1], [1, 1, 1], [-1, -1, 1], [1, -1, 1]] },
  north: { n: [0, 0, -1], k: [[1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1]] },
};

const toGame = ([x, y, z]) => [-x / 16, (24 - y) / 16, z / 16];
const turnToGame = ([rx, ry, rz]) => [-rx, -ry, rz];
const num = (v) => (Math.abs(v) < 1e-7 ? '0' : String(+v.toFixed(5)));

function bake(model) {
  const [tw, th] = model.texture;
  const parts = model.bones || [];
  const index = new Map(parts.map((b, i) => [b.name, i]));
  const lines = ['mclmesh 1', `slot ${model.slot}`, `bone ${model.bone === 'body' || model.bone === 'root' ? model.bone : 'head'}`];
  if (model.float) {
    const f = model.float;
    const [cx, cy, cz] = toGame(f.centre);
    // in the game's units (Y down): the bob's sign turns over with it
    lines.push(['float', -f.bob / 16, f.period, -f.sway, f.swayPeriod, cx, cy, cz].map((v, i) => (i ? num(v) : v)).join(' '));
  }
  for (const b of parts) {
    const p = toGame(b.pivot);
    const r = turnToGame(b.rotation || [0, 0, 0]);
    // the game's parts swing (a heartbeat's swell stays in the launcher)
    const a = b.anim && b.anim.rot ? turnToGame(b.anim.rot) : [0, 0, 0];
    // its lean in the wind (a pet flying after the player), at full speed
    const w = b.anim && b.anim.wind ? turnToGame(b.anim.wind) : [0, 0, 0];
    // now and then: a quick motion (its turn, its period, every, how long, from when) and a blink (how much, every, how long, from when)
    const u = b.anim && b.anim.burst;
    const k = u ? [...turnToGame(u.rot), u.period, u.every, u.dur, u.offset || 0] : [0, 0, 0, 0, 0, 0, 0];
    const e = b.anim && b.anim.blink;
    const s = e ? [e.squash, e.every, e.dur, e.offset || 0] : [0, 0, 0, 0];
    lines.push(['part', ...p, ...r, ...a, b.anim ? b.anim.period || 0 : 0, b.anim ? b.anim.phase || 0 : 0, ...w, ...k, ...s].map((v, i) => (i ? num(v) : v)).join(' '));
  }
  for (const c of model.cubes) {
    const centre = [0, 1, 2].map((i) => (c.from[i] + c.to[i]) / 2);
    const half = [0, 1, 2].map((i) => (c.to[i] - c.from[i]) / 2);
    const part = c.bone && index.has(c.bone) ? index.get(c.bone) : -1;
    for (const [name, rect] of Object.entries(c.faces)) {
      const face = FACES[name];
      if (!face) continue;
      const [x1, y1, x2, y2] = rect;
      const uv = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]];
      const corner = (k) => {
        const local = face.k[k].map((s, i) => centre[i] + s * half[i] - c.origin[i]);
        const r = turn(c.rotation || [0, 0, 0], local);
        return toGame(r.map((v, i) => v + c.origin[i]));
      };
      const n = c.outline ? [0, 1, 0] : turn(c.rotation || [0, 0, 0], face.n);
      const nGame = [-n[0], -n[1], n[2]];
      // round the quad: top-left, bottom-left, bottom-right, top-right
      const order = [0, 2, 3, 1];
      const vals = [part, ...nGame];
      for (const k of order) vals.push(...corner(k), uv[k][0] / tw, uv[k][1] / th);
      lines.push(`${c.outline ? 'g' : 'f'} ${vals.map(num).join(' ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// The baked catalogue next to the launcher's data (Java can't read inside
// app.asar), in a folder named by its content: { dir, ids }.
function prepare(root) {
  const src = (...p) => paths.asset('cosmetics', ...p);
  const index = JSON.parse(fs.readFileSync(src('index.json'), 'utf8'));
  const files = {};
  for (const it of index) {
    const model = JSON.parse(fs.readFileSync(src(it.id, 'model.json'), 'utf8'));
    files[`${it.id}.mesh`] = Buffer.from(bake(model));
    files[`${it.id}.png`] = fs.readFileSync(src(it.id, 'texture.png'));
  }
  const hash = crypto.createHash('sha256');
  for (const k of Object.keys(files).sort()) hash.update(k).update(files[k]);
  const dir = path.join(root, `cosmetics-${hash.digest('hex').slice(0, 12)}`);
  if (!fs.existsSync(path.join(dir, 'done'))) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, k), v);
    fs.writeFileSync(path.join(dir, 'done'), '');
  }
  return { dir, ids: index.map((i) => i.id) };
}

module.exports = { bake, prepare, _test: { turn, toGame, FACES } };
