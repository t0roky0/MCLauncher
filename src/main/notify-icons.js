'use strict';
// Pictures for Windows notifications, so each kind reads at a glance instead
// of every one carrying the app icon: a pixel icon on a dark tile in the
// kind's colour (invite, friend online, friend request, party, error…), or a
// friend's gamer pic with a small badge of the same kind.
//
// The pixel art is the launcher's (renderer icons.js, 9x9; '#' = the colour,
// '+' = a lighter shade) — copied here because the renderer's sources aren't
// shipped to the main process.

const { nativeImage } = require('electron');
const paths = require('./paths');

const ART = {
  mail: ['.........', '#########', '##.....##', '#.#...#.#', '#..#.#..#', '#...#...#', '#.......#', '#########', '.........'],
  user: ['.........', '...###...', '...###...', '...###...', '.........', '.#######.', '.#######.', '.#######.', '.........'],
  userPlus: ['.........', '.###...#.', '.###..###', '.###...#.', '.........', '#####....', '#####....', '#####....', '.........'],
  userMinus: ['.........', '.###.....', '.###..###', '.###.....', '.........', '#####....', '#####....', '#####....', '.........'],
  friends: ['.........', '.##...##.', '.##...##.', '.........', '####.####', '####.####', '####.####', '####.####', '.........'],
  play: ['..#......', '..##.....', '..###....', '..####...', '..#####..', '..####...', '..###....', '..##.....', '..#......'],
  gamepad: ['.........', '.#######.', '###.#####', '##...#.##', '###.###.#', '#########', '##.....##', '#.......#', '.........'],
  warning: ['....#....', '...#.#...', '...#.#...', '..#.#.#..', '..#.#.#..', '.#..#..#.', '.#.....#.', '#...#...#', '#########'],
  download: ['....#....', '....#....', '....#....', '.#..#..#.', '..#.#.#..', '...###...', '....#....', '.........', '#########'],
  chat: ['.........', '.#######.', '#########', '##.#.#.##', '#########', '.#######.', '..##.....', '.#.......', '.........'],
  lamp: ['..###..', '.#++##.', '#++####', '#+#####', '######:', '.####:.', '..:::..'],
};

const COLOR = {
  invite: '#e0a065',
  message: '#b48cf0',
  online: '#73d06c',
  request: '#6cb6ef',
  party: '#73d06c',
  warn: '#ecb84f',
  error: '#ef6f63',
  info: '#d9cfc6',
};

const BG = [0x24, 0x21, 0x1f];

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));

// BGRA, the platform order nativeImage bitmaps use on Windows
function put(buf, size, x, y, c, a = 255) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const o = (y * size + x) * 4;
  buf[o] = c[2];
  buf[o + 1] = c[1];
  buf[o + 2] = c[0];
  buf[o + 3] = a;
}

function rect(buf, size, x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(buf, size, x, y, c);
}

function drawArt(buf, size, rows, x0, y0, scale, c) {
  const light = mix(c, [255, 255, 255], 0.45);
  const dark = mix(c, BG, 0.45);
  rows.forEach((row, j) => {
    [...row].forEach((ch, i) => {
      if (ch === '.') return;
      rect(buf, size, x0 + i * scale, y0 + j * scale, scale, scale, ch === '+' ? light : ch === ':' ? dark : c);
    });
  });
}

// A tile: dark square, a frame in the kind's colour, the icon in the middle.
function tileBitmap(name, kind, size = 96) {
  const c = rgb(COLOR[kind] || COLOR.info);
  const buf = Buffer.alloc(size * size * 4);
  rect(buf, size, 0, 0, size, size, BG);
  const frame = mix(c, BG, 0.5);
  const b = Math.round(size / 16);
  rect(buf, size, 0, 0, size, b, frame);
  rect(buf, size, 0, size - b, size, b, frame);
  rect(buf, size, 0, 0, b, size, frame);
  rect(buf, size, size - b, 0, b, size, frame);
  const rows = ART[name] || ART.user;
  const scale = Math.floor((size * 0.62) / rows.length);
  const w = rows[0].length * scale;
  const h = rows.length * scale;
  drawArt(buf, size, rows, Math.round((size - w) / 2), Math.round((size - h) / 2), scale, c);
  return buf;
}

function tile(name, kind) {
  return nativeImage.createFromBitmap(tileBitmap(name, kind), { width: 96, height: 96 });
}

// The kind's badge in the bottom-right corner of a 96x96 picture.
function withBadge(buf, badge, kind) {
  const small = tileBitmap(badge, kind, 40);
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const s = (y * 40 + x) * 4;
      const d = ((56 + y) * 96 + 56 + x) * 4;
      buf[d] = small[s];
      buf[d + 1] = small[s + 1];
      buf[d + 2] = small[s + 2];
      buf[d + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: 96, height: 96 });
}

// A gamer pic, 96x96, with the badge.
async function avatar(url, badge, kind) {
  const { remoteImage } = require('./protocol');
  const img = nativeImage.createFromBuffer(await remoteImage(url));
  if (img.isEmpty()) throw new Error('not an image');
  return withBadge(Buffer.from(img.resize({ width: 96, height: 96, quality: 'best' }).toBitmap()), badge, kind);
}

// A skin's face (faceOf), blown up pixel for pixel to 96x96, with the badge.
function facePicture(dataUrl, badge, kind) {
  const img = nativeImage.createFromDataURL(dataUrl);
  const { width: n, height } = img.getSize();
  if (!n || n !== height || 96 % n) throw new Error('not a face');
  const src = img.toBitmap();
  const k = 96 / n;
  const buf = Buffer.alloc(96 * 96 * 4);
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < 96; x++) {
      const s = (Math.floor(y / k) * n + Math.floor(x / k)) * 4;
      const d = (y * 96 + x) * 4;
      buf[d] = src[s];
      buf[d + 1] = src[s + 1];
      buf[d + 2] = src[s + 2];
      buf[d + 3] = 255;
    }
  }
  return withBadge(buf, badge, kind);
}

// The front of a skin's head with its hat layer, 8x8 (×n for HD skins), as
// a PNG data URL — the face of whoever invites (friend lobbies' beacon).
const faces = new Map();
function faceOf(skin) {
  if (typeof skin !== 'string' || !skin.startsWith('data:image/png;base64,')) return '';
  if (faces.has(skin)) return faces.get(skin);
  let out = '';
  try {
    const img = nativeImage.createFromDataURL(skin);
    const { width, height } = img.getSize();
    const s = Math.floor(width / 64);
    if (s >= 1 && width === 64 * s && (height === 64 * s || height === 32 * s)) {
      const bmp = img.toBitmap();
      const n = 8 * s;
      const face = Buffer.alloc(n * n * 4);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const base = ((n + y) * width + n + x) * 4;
          const hat = ((n + y) * width + 5 * n + x) * 4;
          const a = bmp[hat + 3] / 255;
          const d = (y * n + x) * 4;
          for (let c = 0; c < 3; c++) face[d + c] = Math.round(bmp[base + c] * (1 - a) + bmp[hat + c] * a);
          face[d + 3] = 255;
        }
      }
      out = nativeImage.createFromBitmap(face, { width: n, height: n }).toDataURL();
    }
  } catch {
    out = '';
  }
  if (faces.size > 50) faces.clear();
  faces.set(skin, out);
  return out;
}

// {icon, kind}, {avatar, icon, kind} or {face, icon, kind} → the
// notification's picture; the app icon when anything goes wrong.
async function picture(look = {}) {
  try {
    if (look.face) return facePicture(look.face, look.icon || 'user', look.kind || 'info');
  } catch { /* the gamer pic, then */ }
  try {
    if (look.avatar) return await avatar(look.avatar, look.icon || 'user', look.kind || 'info');
  } catch { /* fall back to the tile */ }
  try {
    if (look.icon) return tile(look.icon, look.kind || 'info');
  } catch { /* fall back to the app icon */ }
  return paths.asset('icon', 'app.png');
}

module.exports = { picture, tileBitmap, faceOf };
