// Icons for the server list. Bedrock servers never send one and Java
// servers may not: the partner servers get an emblem, every other server a
// tile with its initial. 20x20 pixels, shown at 2x like the rest of the
// pixel icons; a favicon the server sends replaces it.

// Emblems are 16x16 on a bevelled tile ([base, light, dark]); '.' is the tile.
const EMBLEMS = {
  // a lifebuoy
  lifeboat: {
    hosts: ['lbsg.net'],
    tile: ['#2f6f9e', '#4b8fc0', '#1f4d70'],
    colors: { K: '#1a2c3d', R: '#e2402f', L: '#f2604c', r: '#a92a1e', W: '#f5f1ea', w: '#c9c2b8' },
    rows: [
      '.......KK.......',
      '....KKKLLKKK....',
      '...KWWLLLLWWK...',
      '..KWWWLLLLWWWK..',
      '.KWWWWWLLWWWWWK.',
      '.KWWWWKKKKWWWwK.',
      '.KLLWK....KWrrK.',
      'KLLLLK....KrrrrK',
      'KLLLLK....KrrrrK',
      '.KLLWK....KwrrK.',
      '.KWWWWKKKKwwwwK.',
      '.KWWWWWrrwwwwwK.',
      '..KWWWrrrrwwwK..',
      '...KWwrrrrwwK...',
      '....KKKrrKKK....',
      '.......KK.......',
    ],
  },
  // a ringed planet
  galaxite: {
    hosts: ['galaxite.net'],
    tile: ['#2f3a9c', '#4a56c4', '#1f2666'],
    colors: { K: '#120f3a', P: '#ff9fd6', p: '#e0609f', q: '#a83a78', H: '#ffe3f2', C: '#a6f0ff', c: '#5aa6cf', S: '#fff6c8', s: '#9fb2ff' },
    rows: [
      '................',
      '.............s..',
      '.S..........sSs.',
      '.....KKKKKKKKKK.',
      '....KPHPPPpKccKK',
      '...KPHPPPpppKKCK',
      '...KPPPPpppqKCCK',
      '..KKPPPpppKKCCK.',
      '.KcKPPppKKCCCK..',
      'KKcKPKKKCCCKK...',
      'KCKKKCCCCKKqK...',
      'KCCCCCKKKqqK....',
      '.KKKKKKKKKK.....',
      '................',
      '..............s.',
      '................',
    ],
  },
  // a straw skep
  hive: {
    hosts: ['hivebedrock.network', 'playhive.com'],
    tile: ['#6e4214', '#8d5a22', '#4a2b0b'],
    colors: { K: '#3a2205', A: '#ffd863', B: '#f2b33c', C: '#c98622', c: '#a86a14', W: '#fff2b0', D: '#3a2208', E: '#8a5a2a', e: '#6b4320' },
    rows: [
      '......KKKK......',
      '....KKAAABKK....',
      '...KCCWCCcccK...',
      '..KAAWAAAABBBK..',
      '.KCCCCCCCCccccK.',
      '.KAAWAAAAABBBBK.',
      'KCCCCCCCCCcccccK',
      'KAAWAAAAAABBBBBK',
      'KCCCCCCCCCcccccK',
      'KAAAAAAAAABBBBBK',
      'KCCCCCCDDCcccccK',
      'KAAAAADDDDBBBBBK',
      'KCCCCCDDDDcccccK',
      'KEEEEEEEEEeeeeeK',
      '.KKKKKKKKKKKKKK.',
      '................',
    ],
  },
  // a diamond pickaxe
  megasmp: {
    hosts: ['megasmp.gg'],
    tile: ['#4f8a2e', '#6aa83f', '#356020'],
    colors: { K: '#16240f', D: '#7ff5e6', d: '#2fb5a8', H: '#a8743f', h: '#6b4523' },
    rows: [
      '................',
      '.....KK.........',
      '....KddKKK......',
      '.....KKddDK.....',
      '.......KddDK....',
      '........KddDK...',
      '........KHddDK..',
      '.......KHKKddDK.',
      '......KHK..KddK.',
      '.....KHK....KdK.',
      '....KHK......KdK',
      '...KHK.......KdK',
      '..KhK.........K.',
      '.KhK............',
      '..K.............',
      '................',
    ],
  },
  // a cube
  cubecraft: {
    hosts: ['cubecraft.net'],
    tile: ['#2b6fb3', '#4a8fd4', '#1d4c7d'],
    colors: { K: '#0f2238', W: '#ffffff', T: '#e6f3ff', t: '#c4def7', L: '#8ec3f5', l: '#a8d4fa', R: '#4f86c6' },
    rows: [
      '.......KK.......',
      '.....KKTTKK.....',
      '...KKWTTTTTKK...',
      '.KKWTTTTTTTTtKK.',
      'KWTTTTTTTTTTtttK',
      'KLlTTTTTTTTTtRRK',
      'KLLllTTTTTtRRRRK',
      'KLLLLllTTRRRRRRK',
      'KLLLLLLlRRRRRRRK',
      'KLLLLLLLRRRRRRRK',
      'KLLLLLLLRRRRRRRK',
      'KLLLLLLLRRRRRRRK',
      '.KKLLLLLRRRRRKK.',
      '...KKLLLRRRKK...',
      '.....KKLRKK.....',
      '.......KK.......',
    ],
  },
  // an enchantment sparkle
  enchanted: {
    hosts: ['enchanted.gg'],
    tile: ['#5b2d8c', '#7a45b0', '#3d1c61'],
    colors: { K: '#240b3a', S: '#fffbe6', s: '#ffe28a', g: '#f0a93a', m: '#f1a6ff' },
    rows: [
      '.......K........',
      '......KgK....m..',
      '......KgK...mSm.',
      '......KgK....m..',
      '.....KgsgK......',
      '....KKsssKK.....',
      '.KKKgssSssgKKK..',
      'KgggssSSSssgggK.',
      '.KKKgssSssgKKK..',
      '....KKsssKK.....',
      '.....KgsgK......',
      '......KgK....m..',
      '......KgK...mSm.',
      '......KgK....m..',
      '.......K........',
      '................',
    ],
  },
  // crossed swords
  zeqa: {
    hosts: ['inpvp.net', 'zeqa.net'],
    tile: ['#a3322b', '#c44a3f', '#6e1f1a'],
    colors: { K: '#2a0d0b', B: '#eef3f6', b: '#9fb0bc', G: '#f0c24f', H: '#7a4f2a', P: '#f0c24f' },
    rows: [
      '.K............K.',
      'KBK..........KBK',
      'KbBK........KBbK',
      '.KbBK......KBbK.',
      '..KbBK....KBbK..',
      '...KbBK..KBbK...',
      '....KbBKKBbK....',
      '.....KbBKbK.....',
      '..K...KbBK...K..',
      '.KGK.KBKbBK.KGK.',
      '..KGKBbKKbBKGK..',
      '...KGKK..KKGK...',
      '..KHKGK..KGKHK..',
      '.KPK.KGKKGK.KPK.',
      '..K...K..K...K..',
      '................',
    ],
  },
};

// Tiles for everything else, picked by the server's name.
const TILES = [
  ['#3f6fb5', '#5a8bd1', '#2a4d80'],
  ['#2f8a86', '#47a6a1', '#1f5f5c'],
  ['#5d8f3a', '#77ab4f', '#3f6427'],
  ['#c08a2e', '#d9a548', '#86601d'],
  ['#b4513f', '#cf6b58', '#7e372b'],
  ['#b5527f', '#cd6c98', '#7f3858'],
  ['#7a55b5', '#9370cf', '#543a80'],
  ['#5a6470', '#76808c', '#3d444d'],
];

const N = 20;
const cache = new Map();

function hostOf(host) {
  return String(host || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

function emblemFor(host) {
  const h = hostOf(host);
  return Object.values(EMBLEMS).find((e) => e.hosts.some((d) => h === d || h.endsWith(`.${d}`)));
}

function hash(text) {
  let x = 2166136261;
  for (const ch of text) x = Math.imul(x ^ ch.codePointAt(0), 16777619) >>> 0;
  return x;
}

// A bevelled tile: light top and left edges, dark bottom and right.
function tile(g, [base, light, dark]) {
  g.fillStyle = base;
  g.fillRect(0, 0, N, N);
  g.fillStyle = light;
  g.fillRect(0, 0, N, 1);
  g.fillRect(0, 0, 1, N);
  g.fillStyle = dark;
  g.fillRect(0, N - 1, N, 1);
  g.fillRect(N - 1, 0, 1, N);
}

// Paints a mask (rows of booleans) at (ox, oy) with a one-pixel drop shadow
// toward the bottom right.
function stamp(g, mask, ox, oy, colorAt, shadow, drop = 1) {
  const on = (x, y) => y >= 0 && y < mask.length && x >= 0 && x < mask[y].length && mask[y][x];
  g.fillStyle = shadow;
  for (let y = 0; y < mask.length + drop; y++) {
    for (let x = 0; x < mask[0].length + drop; x++) if (on(x - drop, y - drop) && !on(x, y)) g.fillRect(ox + x, oy + y, 1, 1);
  }
  for (let y = 0; y < mask.length; y++) {
    for (let x = 0; x < mask[y].length; x++) {
      if (!on(x, y)) continue;
      g.fillStyle = colorAt(x, y);
      g.fillRect(ox + x, oy + y, 1, 1);
    }
  }
}

// The initial in the launcher's pixel font: drawn big, then read back one
// font pixel at a time so no smoothing gets in.
async function glyph(ch) {
  try {
    await document.fonts.load('32px MC', ch);
  } catch {
    /* the fallback font still draws something */
  }
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.font = '32px MC';
  g.fillStyle = '#fff';
  g.textBaseline = 'alphabetic';
  g.fillText(ch, 16, 44);
  const data = g.getImageData(0, 0, 64, 64).data;
  const alpha = (x, y) => (x < 64 && y < 64 ? data[(y * 64 + x) * 4 + 3] : 0);
  // the glyph's pixel grid may sit off ours: take the offset whose samples
  // land clearest of any edge
  let best = null;
  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 4; px++) {
      let blur = 0;
      for (let y = py; y < 64; y += 4) for (let x = px; x < 64; x += 4) blur += Math.min(alpha(x, y), 255 - alpha(x, y));
      if (!best || blur < best.blur) best = { px, py, blur };
    }
  }
  const cells = [];
  for (let y = 0; y < 16; y++) {
    const row = [];
    for (let x = 0; x < 16; x++) row.push(alpha(x * 4 + best.px, y * 4 + best.py) > 127);
    cells.push(row);
  }
  const ys = cells.map((r, y) => (r.some(Boolean) ? y : -1)).filter((y) => y >= 0);
  const xs = [...Array(16).keys()].filter((x) => cells.some((r) => r[x]));
  if (!ys.length) return null;
  return cells.slice(ys[0], ys[ys.length - 1] + 1).map((r) => r.slice(xs[0], xs[xs.length - 1] + 1));
}

async function letterTile(g, name, host) {
  const colors = TILES[hash(hostOf(host) || name) % TILES.length];
  tile(g, colors);
  const ch = ((String(name).replace(/§./g, '').match(/[\p{L}\p{N}]/u) || [hostOf(host)[0] || '?'])[0] || '?').toLocaleUpperCase();
  const small = await glyph(ch);
  if (!small) return;
  // two tile pixels per font pixel
  const mask = [];
  for (const r of small) {
    const wide = r.flatMap((v) => [v, v]);
    mask.push(wide, wide);
  }
  const ox = Math.floor((N - mask[0].length - 2) / 2) + 1;
  const oy = Math.floor((N - mask.length - 2) / 2) + 1;
  stamp(g, mask, ox, oy, () => '#f4f1ec', colors[2], 2);
}

// serverIcon({ name, host }) → a PNG data URL.
export function serverIcon({ name = '', host = '' } = {}) {
  const key = `${hostOf(host)}|${name}`;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const c = document.createElement('canvas');
      c.width = c.height = N;
      const g = c.getContext('2d');
      const e = emblemFor(host);
      if (e) {
        tile(g, e.tile);
        stamp(g, e.rows.map((r) => [...r].map((ch) => ch !== '.')), 2, 2, (x, y) => e.colors[e.rows[y][x]], e.tile[2]);
      } else {
        await letterTile(g, name, host);
      }
      return c.toDataURL('image/png');
    })());
  }
  return cache.get(key);
}
