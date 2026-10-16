// The launcher's own pixel icons.
//
// Drawn on a 9x9 grid and rendered at 2 screen pixels per art pixel — the
// same pixel size as the Minecraft font at 16px, so icons and labels read
// as one set. Window-control glyphs are 10x10 at 1x, like Windows' own.
// '#' is currentColor, '+' and ':' are lighter shades of it; letters map to
// fixed colours (the Microsoft mark).

const PALETTE = { R: '#f25022', G: '#7fba00', B: '#00a4ef', Y: '#ffb900', W: '#ffffff', K: '#000000', O: 'var(--acc)', '%': 'rgba(255, 255, 255, 0.65)' };

const ICONS = {
  // the status lamp: round, a glint top left, the far edge in shade
  // the status lamp: a plain round pixel dot (the shaded one was too busy)
  lamp: [
    '.###.',
    '#####',
    '#####',
    '#####',
    '.###.',
  ],
  play: [
    '..#......',
    '..##.....',
    '..###....',
    '..####...',
    '..#####..',
    '..####...',
    '..###....',
    '..##.....',
    '..#......',
  ],
  plus: [
    '.........',
    '....#....',
    '....#....',
    '....#....',
    '.#######.',
    '....#....',
    '....#....',
    '....#....',
    '.........',
  ],
  gear: [
    '...###...',
    '.#.###.#.',
    '..#####..',
    '###...###',
    '###...###',
    '###...###',
    '..#####..',
    '.#.###.#.',
    '...###...',
  ],
  console: [
    '#########',
    '#########',
    '#.......#',
    '#.#.....#',
    '#..#....#',
    '#.#..##.#',
    '#.......#',
    '#.......#',
    '#########',
  ],
  hanger: [
    '....##...',
    '...#..#..',
    '......#..',
    '.....#...',
    '....#....',
    '...#.#...',
    '..#...#..',
    '.#.....#.',
    '#########',
  ],
  friends: [
    '.........',
    '.##...##.',
    '.##...##.',
    '.........',
    '####.####',
    '####.####',
    '####.####',
    '####.####',
    '.........',
  ],
  user: [
    '.........',
    '...###...',
    '...###...',
    '...###...',
    '.........',
    '.#######.',
    '.#######.',
    '.#######.',
    '.........',
  ],
  folder: [
    '.........',
    '####.....',
    '#...#####',
    '#########',
    '#.......#',
    '#.......#',
    '#.......#',
    '#########',
    '.........',
  ],
  up: [
    '.........',
    '.........',
    '....#....',
    '...###...',
    '..##.##..',
    '.##...##.',
    '.#.....#.',
    '.........',
    '.........',
  ],
  down: [
    '.........',
    '.........',
    '.#.....#.',
    '.##...##.',
    '..##.##..',
    '...###...',
    '....#....',
    '.........',
    '.........',
  ],
  right: [
    '.........',
    '..#......',
    '..##.....',
    '...##....',
    '....##...',
    '...##....',
    '..##.....',
    '..#......',
    '.........',
  ],
  left: [
    '.........',
    '......#..',
    '.....##..',
    '....##...',
    '...##....',
    '....##...',
    '.....##..',
    '......#..',
    '.........',
  ],
  back: [
    '.........',
    '...#.....',
    '..##.....',
    '.########',
    '########.',
    '.########',
    '..##.....',
    '...#.....',
    '.........',
  ],
  // a round lens with a glint, a thin handle
  search: [
    '..###....',
    '.#...#...',
    '#.+...#..',
    '#.....#..',
    '#.....#..',
    '.#...#...',
    '..###.#..',
    '.......#.',
    '........#',
  ],
  refresh: [
    '..####.#.',
    '.#....##.',
    '#....###.',
    '#........',
    '.........',
    '........#',
    '.###....#',
    '.##....#.',
    '.#.####..',
  ],
  // five even points
  star: [
    '....#....',
    '...###...',
    '...###...',
    '#########',
    '.#######.',
    '..#####..',
    '..##.##..',
    '.##...##.',
    '.#.....#.',
  ],
  userPlus: [
    '.........',
    '.###...#.',
    '.###..###',
    '.###...#.',
    '.........',
    '#####....',
    '#####....',
    '#####....',
    '.........',
  ],
  userMinus: [
    '.........',
    '.###.....',
    '.###..###',
    '.###.....',
    '.........',
    '#####....',
    '#####....',
    '#####....',
    '.........',
  ],
  check: [
    '.........',
    '........#',
    '.......##',
    '#.....##.',
    '##...##..',
    '.##.##...',
    '..###....',
    '...#.....',
    '.........',
  ],
  x: [
    '.........',
    '.#.....#.',
    '..#...#..',
    '...#.#...',
    '....#....',
    '...#.#...',
    '..#...#..',
    '.#.....#.',
    '.........',
  ],
  trash: [
    '...###...',
    '#########',
    '.........',
    '.#######.',
    '.#.#.#.#.',
    '.#.#.#.#.',
    '.#.#.#.#.',
    '.#######.',
    '.........',
  ],
  edit: [
    '......##.',
    '.....#..#',
    '....#..#.',
    '...#..#..',
    '..#..#...',
    '.#..#....',
    '.###.....',
    '##.......',
    '.........',
  ],
  download: [
    '....#....',
    '....#....',
    '....#....',
    '.#..#..#.',
    '..#.#.#..',
    '...###...',
    '....#....',
    '.........',
    '#########',
  ],
  upload: [
    '....#....',
    '...###...',
    '..#.#.#..',
    '.#..#..#.',
    '....#....',
    '....#....',
    '....#....',
    '.........',
    '#########',
  ],
  stop: [
    '.........',
    '.#######.',
    '.#######.',
    '.#######.',
    '.#######.',
    '.#######.',
    '.#######.',
    '.#######.',
    '.........',
  ],
  pause: [
    '.........',
    '.##...##.',
    '.##...##.',
    '.##...##.',
    '.##...##.',
    '.##...##.',
    '.##...##.',
    '.##...##.',
    '.........',
  ],
  pc: [
    '#########',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#########',
    '...###...',
    '.#######.',
    '.........',
  ],
  gamepad: [
    '.........',
    '.#######.',
    '###.#####',
    '##...#.##',
    '###.###.#',
    '#########',
    '##.....##',
    '#.......#',
    '.........',
  ],
  phone: [
    '..#####..',
    '..#...#..',
    '..#...#..',
    '..#...#..',
    '..#...#..',
    '..#####..',
    '..##.##..',
    '..#####..',
    '.........',
  ],
  cape: [
    '.#######.',
    '.#######.',
    '.#######.',
    '.#######.',
    '.#######.',
    '.###.###.',
    '.##...##.',
    '.#.....#.',
    '.........',
  ],
  copy: [
    '...######',
    '...#....#',
    '######..#',
    '#....#..#',
    '#....#..#',
    '#....####',
    '#....#...',
    '######...',
    '.........',
  ],
  clock: [
    '..#####..',
    '.#.....#.',
    '#...#...#',
    '#...#...#',
    '#...###.#',
    '#.......#',
    '.#.....#.',
    '..#####..',
    '.........',
  ],
  signal: [
    '.......##',
    '.......##',
    '....##.##',
    '....##.##',
    '.##.##.##',
    '.##.##.##',
    '.##.##.##',
    '.........',
    '.........',
  ],
  swap: [
    '......#..',
    '.......#.',
    '.########',
    '.......#.',
    '..#...#..',
    '.#.......',
    '########.',
    '.#.......',
    '..#......',
  ],
  microsoft: [
    'RRRR.GGGG',
    'RRRR.GGGG',
    'RRRR.GGGG',
    'RRRR.GGGG',
    '.........',
    'BBBB.YYYY',
    'BBBB.YYYY',
    'BBBB.YYYY',
    'BBBB.YYYY',
  ],
  info: [
    '...###...',
    '.##...##.',
    '.#..#..#.',
    '#.......#',
    '#...#...#',
    '#...#...#',
    '.#..#..#.',
    '.##...##.',
    '...###...',
  ],
  warning: [
    '....#....',
    '...#.#...',
    '...#.#...',
    '..#.#.#..',
    '..#.#.#..',
    '.#..#..#.',
    '.#.....#.',
    '#...#...#',
    '#########',
  ],
  image: [
    '#########',
    '#.......#',
    '#.....#.#',
    '#..#....#',
    '#.###...#',
    '#######.#',
    '#########',
    '.........',
    '.........',
  ],
  java: [
    '...#.#...',
    '..#.#....',
    '.........',
    '#######..',
    '#.....###',
    '#.....#.#',
    '#.....###',
    '.#...#...',
    '..###....',
  ],
  cpu: [
    '.#.#.#.#.',
    '#########',
    '.#.....#.',
    '##.###.##',
    '.#.###.#.',
    '##.###.##',
    '.#.....#.',
    '#########',
    '.#.#.#.#.',
  ],
  ram: [
    '.........',
    '.........',
    '#########',
    '#.##.##.#',
    '#.##.##.#',
    '#########',
    '.#.#.#.#.',
    '.........',
    '.........',
  ],
  server: [
    '.........',
    '#########',
    '#.#.+++.#',
    '#########',
    '.........',
    '#########',
    '#.#.+++.#',
    '#########',
    '.........',
  ],
  globe: [
    '..#####..',
    '.#..#..#.',
    '#..#.#..#',
    '#..#.#..#',
    '#########',
    '#..#.#..#',
    '#..#.#..#',
    '.#..#..#.',
    '..#####..',
  ],
  heart: [
    '.........',
    '.##...##.',
    '####.####',
    '#########',
    '#########',
    '.#######.',
    '..#####..',
    '...###...',
    '....#....',
  ],
  sparkle: [
    '.......#.',
    '......###',
    '...#...#.',
    '...#.....',
    '..###....',
    '#######..',
    '..###....',
    '...#.....',
    '...#.....',
  ],
  // a house (the lobby, the launcher's main page)
  home: [
    '....#....',
    '...###...',
    '..#####..',
    '.#######.',
    '#########',
    '.#######.',
    '.###.###.',
    '.###.###.',
    '.###.###.',
  ],
  // a beetle (the fixer: what's broken in the game, put right)
  bug: [
    '.#.....#.',
    '..#.#.#..',
    '...###...',
    '#.##+##.#',
    '.###+###.',
    '#.##+##.#',
    '.###+###.',
    '#.##+##.#',
    '...###...',
  ],
  // a shopping bag (the shop)
  shop: [
    '...###...',
    '..#...#..',
    '..#...#..',
    '#########',
    '#########',
    '##+###+##',
    '#########',
    '#########',
    '.#######.',
  ],
  // a key (activation codes)
  key: [
    '.........',
    '.###.....',
    '#...#....',
    '#...#####',
    '#...#####',
    '.###..#.#',
    '......#.#',
    '.........',
    '.........',
  ],
  // a padlock (cosmetics not got yet)
  lock: [
    '..#####..',
    '.##...##.',
    '.#.....#.',
    '.#.....#.',
    '#########',
    '####.####',
    '####.####',
    '#########',
    '#########',
  ],
  // a solid block, its faces in three tones (Worlds)
  block: [
    '...###...',
    '.#######.',
    '#########',
    '++#####::',
    '++++#::::',
    '+++++::::',
    '+++++::::',
    '.++++:::.',
    '...++:...',
  ],
  // Emotes
  emote: [
    '..#####..',
    '.#.....#.',
    '#.......#',
    '#..#.#..#',
    '#.......#',
    '#.#...#.#',
    '#..###..#',
    '.#.....#.',
    '..#####..',
  ],
  // notifications on / off
  // an envelope: invitations (lobbies, parties)
  mail: [
    '.........',
    '#########',
    '##.....##',
    '#.#...#.#',
    '#..#.#..#',
    '#...#...#',
    '#.......#',
    '#########',
    '.........',
  ],
  bell: [
    '....#....',
    '...###...',
    '..#####..',
    '..#####..',
    '..#####..',
    '.#######.',
    '#########',
    '.........',
    '...###...',
  ],
  bellOff: [
    '#...+....',
    '.#.+++...',
    '..#++++..',
    '..+#+++..',
    '..++#++..',
    '.++++#++.',
    '++++++#++',
    '.......#.',
    '...+++..#',
  ],
  external: [
    '.....####',
    '.......##',
    '####..#.#',
    '#....#..#',
    '#...#....',
    '#.....#..',
    '#.....#..',
    '#.....#..',
    '#######..',
  ],
  dots: ['##..##..##', '##..##..##'],
  // Window controls: 10x10, 1 px per art pixel.
  // party voice and chat
  mic: [
    '...###...',
    '..#####..',
    '..##+##..',
    '..#####..',
    '..#####..',
    '#.#####.#',
    '.#.###.#.',
    '..#####..',
    '....#....',
  ],
  micOff: [
    '#..###...',
    '.#.####..',
    '..#.+##..',
    '..##.##..',
    '..###.#..',
    '#.####..#',
    '.#.###.#.',
    '..#####.#',
    '....#....',
  ],
  headset: [
    '..#####..',
    '.#.....#.',
    '#.......#',
    '#.......#',
    '##.....##',
    '###...###',
    '###...###',
    '###...###',
    '.##...##.',
  ],
  headsetOff: [
    '#.#####..',
    '.#.....#.',
    '#.#.....#',
    '#..#....#',
    '##..#..##',
    '###..#.##',
    '###...#.#',
    '###...##.',
    '.##...###',
  ],
  hangup: [
    '.........',
    '.........',
    '..#####..',
    '.#######.',
    '###...###',
    '###...###',
    '.##...##.',
    '.........',
    '.........',
  ],
  checks: [
    '.........',
    '.........',
    '......#..',
    '.....#..#',
    '#...#..#.',
    '.#.##.#..',
    '..#..#...',
    '.........',
    '.........',
  ],
  chat: [
    '.........',
    '.#######.',
    '#########',
    '##.#.#.##',
    '#########',
    '.#######.',
    '..##.....',
    '.#.......',
    '.........',
  ],
  smile: [
    '..#####..',
    '.#.....#.',
    '#..#.#..#',
    '#.......#',
    '#.#...#.#',
    '#..###..#',
    '.#.....#.',
    '..#####..',
    '.........',
  ],
  send: [
    '##.......',
    '####.....',
    '.#####...',
    '.#######.',
    '.########',
    '.#######.',
    '.#####...',
    '####.....',
    '##.......',
  ],
  volume: [
    '....#....',
    '...##..#.',
    '#####...#',
    '#####.#.#',
    '#####.#.#',
    '#####...#',
    '...##..#.',
    '....#....',
    '.........',
  ],
  winMin: ['..........', '..........', '..........', '..........', '..........', '##########', '..........', '..........', '..........', '..........'],
  winMax: ['##########', '#........#', '#........#', '#........#', '#........#', '#........#', '#........#', '#........#', '#........#', '##########'],
  winRestore: ['..########', '..#......#', '########.#', '#......#.#', '#......#.#', '#......#.#', '#......###', '#......#..', '#......#..', '########..'],
  winClose: ['#........#', '.#......#.', '..#....#..', '...#..#...', '....##....', '....##....', '...#..#...', '..#....#..', '.#......#.', '#........#'],
};

// Full-colour sprites on an 11x11 grid: the world-mode badges. Each has its
// own palette; '.' is transparent.
const HEART = { K: '#3a0d0b', L: '#ff7b6b', W: '#ffe3dd', R: '#e8392e', D: '#a8241c' };
const HARDCORE = { K: '#240605', E: '#240605', L: '#e0574b', W: '#ffc9c0', R: '#c42a21', D: '#7d140f' };
const GRASS = {
  H: '#8fd660', G: '#6cb33e', g: '#4e8f2b', A: '#5f9f35', B: '#447c26',
  D: '#8c5b3a', d: '#6c4327', S: '#8f8f8f', E: '#6a4228', e: '#4f311d', s: '#6b6b6b',
};
// the shop's coin: the user's own (assets/images/coin.png, scripts/shop/coin.py)
const COIN = { O: '#744500', P: '#533000', W: '#ffe7bf', A: '#ffcd76', S: '#ffc357', B: '#ffbf4c', D: '#ffad19', E: '#fca11b', C: '#ffa000' };
const SPRITES = {
  coin: {
    colors: COIN,
    rows: [
      '..OOOO..',
      '.OAABCP.',
      'OAWWBBCP',
      'OAWSBDEP',
      'OBBBDEEP',
      'OCBDEEEP',
      '.PCEEEP.',
      '..PPPP..',
    ],
  },
  survival: {
    colors: HEART,
    rows: [
      '.KKK...KKK.',
      'KLLLK.KRRRK',
      'KLWLLKRRRRK',
      'KLWLRRRRRRK',
      'KLLRRRRRRDK',
      'KRRRRRRRRDK',
      '.KRRRRRRDK.',
      '..KRRRRDK..',
      '...KRRDK...',
      '....KDK....',
      '.....K.....',
    ],
  },
  // the same heart, darker, with the hardcore heart's glare
  hardcore: {
    colors: HARDCORE,
    rows: [
      '.KKK...KKK.',
      'KRRRK.KRRRK',
      'KRWRRKRRRRK',
      'KREERRREERK',
      'KRRERRRERDK',
      'KRRRRRRRRDK',
      '.KRRRRRRDK.',
      '..KRRRRDK..',
      '...KRRDK...',
      '....KDK....',
      '.....K.....',
    ],
  },
  // a grass block, three-quarter view: lit top, grass hanging over the sides
  creative: {
    colors: GRASS,
    rows: [
      '....HGH....',
      '..GHGgGHG..',
      'GgHGGHGgGHG',
      'AAGHGgGHGBB',
      'ADAAGHGBBEB',
      'DdADAABEBEe',
      'DSdDDAEeEsE',
      'dDDSDDEEsEe',
      'DDdDDdEeEEE',
      '..DdDDEeE..',
      '....DdE....',
    ],
  },
};

// Shades of currentColor, for depth inside a one-colour icon.
const TONES = { '+': 0.55, ':': 0.28, f: 0.2 };
const SCALE_ONE = new Set(['winMin', 'winMax', 'winRestore', 'winClose']);
const cache = new Map();

function runs(rows) {
  const byChar = new Map();
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch === '.') {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end] === ch) end++;
      const d = byChar.get(ch) || [];
      d.push(`M${x} ${y}h${end - x}v1h${x - end}z`);
      byChar.set(ch, d);
      x = end;
    }
  });
  return { w: Math.max(...rows.map((r) => r.length)), h: rows.length, paths: [...byChar.entries()].map(([ch, d]) => ({ ch, d: d.join('') })) };
}

function pathsFor(name) {
  if (!cache.has(name)) cache.set(name, runs(SPRITES[name] ? SPRITES[name].rows : ICONS[name]));
  return cache.get(name);
}

function pixelSvg(w, h, s, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w * s));
  svg.setAttribute('height', String(h * s));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('px-icon');
  if (cls) svg.classList.add(cls);
  return svg;
}

function fillPath(svg, d, fill, opacity) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  el.setAttribute('d', d);
  el.setAttribute('fill', fill);
  if (opacity != null) el.setAttribute('fill-opacity', String(opacity));
  svg.appendChild(el);
  return el;
}

// icon('gear') → <svg> at 2x; icon('winClose') → 1x; icon('creative') → the
// colour sprite.
export function icon(name, { scale, cls } = {}) {
  if (!ICONS[name] && !SPRITES[name]) name = 'info';
  const { w, h, paths } = pathsFor(name);
  const svg = pixelSvg(w, h, scale || (SCALE_ONE.has(name) ? 1 : 2), cls);
  const colors = SPRITES[name] ? SPRITES[name].colors : PALETTE;
  for (const p of paths) {
    if (colors[p.ch]) fillPath(svg, p.d, colors[p.ch]);
    else fillPath(svg, p.d, 'currentColor', TONES[p.ch]);
  }
  return svg;
}

export const ICON_NAMES = Object.keys(ICONS);

// ---- the loading spinner ------------------------------------------------------------
// Minecraft's loading arc: nine pixels of a 7x7 ring, stepping round it one
// pixel at a time. All sixteen positions are drawn once into a strip that
// the CSS (.px-spinner) uses as a mask and steps through — so it follows
// currentColor and never scales a pixel.
const RING = [[3, 0], [4, 0], [5, 1], [6, 2], [6, 3], [6, 4], [5, 5], [4, 6], [3, 6], [2, 6], [1, 5], [0, 4], [0, 3], [0, 2], [1, 1], [2, 0]];
const ARC = 9;
let spinnerStrip = '';

function spinnerMask() {
  if (spinnerStrip) return spinnerStrip;
  let rects = '';
  RING.forEach((_, f) => {
    for (let i = 0; i < ARC; i++) {
      const [x, y] = RING[(f + i) % RING.length];
      rects += `<rect x="${f * 7 + x}" y="${y}" width="1" height="1"/>`;
    }
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${RING.length * 7} 7" shape-rendering="crispEdges">${rects}</svg>`;
  spinnerStrip = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return spinnerStrip;
}

export function pixelSpinner(size = 'md') {
  const el = document.createElement('div');
  el.className = `px-spinner ${size}`;
  el.setAttribute('role', 'progressbar');
  el.style.setProperty('--strip', spinnerMask());
  return el;
}

// Isometric blocks drawn pixel for pixel at 32x36 (scripts/blocks, "px"), shown at 1x or 2x.
export const BLOCK_IDS = [
  'grass', 'barrel', 'shulker_box', 'crafting_table', 'furnace', 'blast_furnace',
  'anvil', 'sticky_piston', 'slime_block', 'hay_bale', 'tnt', 'cake',
  'diamond_ore', 'emerald_ore', 'bee_nest', 'sculk', 'melon', 'amethyst_block',
  'bedrock',
];
export function blockUrl(id) {
  const safe = BLOCK_IDS.includes(id) ? id : 'grass';
  return `mcl://app/assets/blocks/${safe}.png?v=5`;
}
