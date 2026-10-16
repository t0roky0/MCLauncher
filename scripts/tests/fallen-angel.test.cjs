const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const assets = path.join(__dirname, '../../assets/cosmetics');
const read = (file) => JSON.parse(fs.readFileSync(path.join(assets, file), 'utf8'));
const model = read('fallen_wings/model.json');
const geo = read('fallen_wings/fallen_wings.geo.json')['minecraft:geometry'][0];
const tga = fs.readFileSync(path.join(assets, 'fallen_wings/bedrock.tga'));
const width = tga.readUInt16LE(12), height = tga.readUInt16LE(14);
const pixel = (x, y) => {
  const row = tga[17] & 32 ? y : height - 1 - y;
  const at = 18 + (row * width + x) * 4;
  return [tga[at + 2], tga[at + 1], tga[at], tga[at + 3]];
};

test('Fallen Angel: white border follows the alpha silhouette, on both animated wings', () => {
  assert.equal(tga[2], 2);
  assert.equal(tga[16], 32);
  const wings = model.cubes.filter(c => !c.outline);
  assert.equal(wings.length, 2);
  const colors = new Set();
  for (const wing of wings) {
    const [x1, y1, x2, y2] = wing.faces.south;
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    const solid = new Set();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = pixel(Math.floor(x1 + (x + .5) * (x2 - x1) / w), Math.floor(y1 + (y + .5) * (y2 - y1) / h));
      if (!p[3]) continue;
      assert.equal(p[3], 255);
      assert.ok(p.slice(0, 3).every(v => v <= 18), 'feathers stay near-black');
      colors.add(p.join());
      solid.add(`${x},${y}`);
    }
    const expected = new Set();
    for (const cell of solid) {
      const [x, y] = cell.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const key = `${x + dx},${y + dy}`;
        if (!solid.has(key)) expected.add(key);
      }
    }
    const actual = new Set();
    const sx = (wing.to[0] - wing.from[0]) / w, sy = (wing.to[1] - wing.from[1]) / h;
    const strips = model.cubes.filter(c => c.outline && c.bone === wing.bone);
    assert.ok(strips.length);
    for (const strip of strips) {
      assert.equal(strip.cull, true);
      assert.deepEqual(strip.origin, wing.origin);
      assert.deepEqual(strip.rotation, wing.rotation);
      assert.deepEqual(Object.keys(strip.faces).sort(), ['north', 'south']);
      const [u, v] = strip.faces.south;
      assert.deepEqual(pixel(Math.floor(u), Math.floor(v)), [255, 255, 255, 255]);
      const start = Math.round((strip.from[0] - wing.from[0]) / sx);
      const end = Math.round((strip.to[0] - wing.from[0]) / sx);
      const y = Math.round((wing.to[1] - strip.to[1]) / sy);
      assert.ok(Math.abs(strip.to[1] - strip.from[1] - sy) < 1e-6);
      for (let x = start; x < end; x++) {
        const key = `${x},${y}`;
        assert.ok(!actual.has(key), 'no duplicate faces');
        actual.add(key);
      }
    }
    assert.deepEqual(actual, expected, 'one texel outside the feathers; no rectangular frame or overdraw');
    assert.ok(model.bones.find(b => b.name === wing.bone).anim.rot);
  }
  assert.ok(colors.size > 2, 'feather shading retained');
});

test('Fallen Angel: Bedrock border uses white emissive pixels and inherits the wing animation', () => {
  const outlines = geo.bones.filter(b => b.name.startsWith('outline_'));
  assert.equal(outlines.length, 2);
  const animation = read('fallen_wings/fallen_wings.animation.json').animations['animation.mcl.fallen_wings.idle'];
  for (const bone of outlines) {
    assert.ok(animation.bones[bone.parent].rotation);
    for (const cube of bone.cubes) for (const face of Object.values(cube.uv)) {
      const [u, v] = face.uv.map((n, i) => Math.floor(n + face.uv_size[i] / 2));
      assert.deepEqual(pixel(u, v), [255, 255, 255, 3]);
    }
  }
});

test('Fallen Angel: shop contains both wearable items and all runtime assets', () => {
  const pack = read('shop.json').find(p => p.id === 'fallen_pack');
  assert.deepEqual(pack.items, ['fallen_wings', 'horned_halo']);
  assert.equal(pack.price, 600);
  const catalog = read('index.json');
  for (const [i, id] of pack.items.entries()) {
    const item = catalog.find(c => c.id === id);
    assert.equal(item.shop, true);
    assert.equal(item.slot, i ? 'head' : 'back');
    for (const file of ['model.json', 'texture.png', 'bedrock.tga', `${id}.animation.json`, `${id}.geo.json`]) {
      assert.ok(fs.statSync(path.join(assets, id, file)).size > 0);
    }
  }
});
