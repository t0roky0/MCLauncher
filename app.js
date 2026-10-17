// MC Launcher site: the launcher's pixel icons, the hero's screenshot as a 3D
// card, and the activation form (a code handed to the launcher:
// mclauncher://redeem/<code> — it opens with the code filled in, the player
// activates it there). The page's colour is theme.js; the hero's particles are
// assets/js/sky.js.
'use strict';

// 9x9 pixel art from the launcher (icons.js): '#' the colour, '+' lighter, ':' darker
const ICONS = {
  friends: '........./.##...##./.##...##./........./####.####/####.####/####.####/####.####/.........',
  headset: '..#####../.#.....#./#.......#/#.......#/##.....##/###...###/###...###/###...###/.##...##.',
  block: '...###.../.#######./#########/++#####::/++++#::::/+++++::::/+++++::::/.++++:::./...++:...',
  download: '....#..../....#..../....#..../.#..#..#./..#.#.#../...###.../....#..../........./#########',
  star: '....#..../...###.../...###.../#########/.#######./..#####../..##.##../.##...##./.#.....#.',
  signal: '.......##/.......##/....##.##/....##.##/.##.##.##/.##.##.##/.##.##.##/........./.........',
  java: '...#.#.../..#.#..../........./#######../#.....###/#.....#.#/#.....###/.#...#.../..###....',
  left: '........./......#../.....##../....##.../...##..../....##.../.....##../......#../.........',
  wings: '........./#.......#/##.....##/###...###/####.####/#########/.###.###./..#...#../.........',
  key: '........./.###...../#...#..../#...#####/#...#####/.###..#.#/......#.#/........./.........',
  image: '#########/#.......#/#.....#.#/#..#....#/#.###...#/#######.#/#########/........./.........',
  search: '..###..../.#...#.../#.+...#../#.....#../#.....#../.#...#.../..###.#../.......#./........#',
  bug: '.#.....#./..#.#.#../...###.../#.##+##.#/.###+###./#.##+##.#/.###+###./#.##+##.#/...###...',
  check: '........./........#/.......##/#.....##./##...##../.##.##.../..###..../...#...../.........',
  drag: '........./........./..#...#../.##...##./#########/.##...##./..#...#../........./.........',
};
const TONE = { '#': 1, '+': 0.55, ':': 0.28 };

function pixelSvg(name) {
  const rows = (ICONS[name] || ICONS.star).split('/');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${rows[0].length} ${rows.length}`);
  svg.setAttribute('class', 'px');
  svg.setAttribute('aria-hidden', 'true');
  const paths = {};
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (TONE[ch]) paths[ch] = (paths[ch] || '') + `M${x} ${y}h1v1h-1z`;
  }));
  for (const [ch, d] of Object.entries(paths)) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'currentColor');
    if (TONE[ch] < 1) p.setAttribute('opacity', TONE[ch]);
    svg.appendChild(p);
  }
  return svg;
}

for (const el of document.querySelectorAll('i[data-i]')) el.replaceWith(pixelSvg(el.dataset.i));

// ---- the hero's screenshot: a card in 3D ---------------------------------------------------------
// It leans after the mouse and drifts a little on its own; grabbed, it can be
// pulled a little way (a rubber band: the further, the harder — never round);
// let go, it springs back to upright with a little wobble. The pets and the coin
// in front of it sit at their own depths, so they move against the window.
const shot = document.querySelector('.shot');
if (shot) {
  const card = shot.querySelector('.shot-card');
  const hint = document.querySelector('.shot-hint');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // the rubber band: follows the pull at first, then gives less and less
  const band = (v, max) => max * Math.tanh(v / max);
  const PER_PX = 0.1; // degrees per pixel dragged, before the rubber band
  const MAX_X = 12; // it tilts up and down no further than this…
  const MAX_Y = 18; // …and turns side to side no further than this
  const K = 60; // the spring back: its stiffness…
  const C = 8; // …and damping (under 2·√K, so it wobbles a little)
  const STEP = 1 / 240; // the spring runs in small fixed steps: steady at any frame rate
  let rx = 0;
  let ry = 0;
  let vx = 0;
  let vy = 0;
  let lean = null; // { x, y } while the mouse is over it
  let drag = null; // { x, y, rx, ry } while it is held
  let time = 0;
  let last = 0;
  let raf = 0;
  let seen = true;

  const glareAt = (e) => {
    const r = shot.getBoundingClientRect();
    shot.style.setProperty('--gx', `${((e.clientX - r.left) / r.width) * 100}%`);
    shot.style.setProperty('--gy', `${((e.clientY - r.top) / r.height) * 100}%`);
  };

  shot.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.pointerType === 'mouse') e.preventDefault();
    drag = { x: e.clientX, y: e.clientY, rx, ry };
    vx = 0;
    vy = 0;
    shot.setPointerCapture(e.pointerId);
    shot.classList.add('grabbing', 'lit');
    glareAt(e);
    if (hint) hint.classList.add('done');
    wake();
  });
  shot.addEventListener('pointermove', (e) => {
    if (drag) {
      ry = band(drag.ry + (e.clientX - drag.x) * PER_PX, MAX_Y);
      rx = band(drag.rx - (e.clientY - drag.y) * PER_PX, MAX_X);
    } else if (e.pointerType === 'mouse') {
      const r = shot.getBoundingClientRect();
      const u = (e.clientX - r.left) / r.width - 0.5;
      const v = (e.clientY - r.top) / r.height - 0.5;
      lean = { x: -v * 16, y: u * 22 };
      shot.classList.add('lit');
    } else {
      return;
    }
    glareAt(e);
    wake();
  });
  const letGo = () => {
    if (!drag) return;
    drag = null;
    shot.classList.remove('grabbing');
    wake();
  };
  shot.addEventListener('pointerup', letGo);
  shot.addEventListener('pointercancel', letGo);
  shot.addEventListener('lostpointercapture', letGo);
  shot.addEventListener('pointerleave', () => {
    if (drag) return;
    lean = null;
    shot.classList.remove('lit');
    wake();
  });

  const step = (dt) => {
    time += dt;
    if (drag) return;
    const drift = still ? 0 : 1;
    const tx = lean ? lean.x : Math.sin(time * 0.7) * 2.5 * drift;
    const ty = lean ? lean.y : Math.sin(time * 0.5) * 4 * drift;
    vx += ((tx - rx) * K - vx * C) * dt;
    vy += ((ty - ry) * K - vy * C) * dt;
    rx += vx * dt;
    ry += vy * dt;
  };
  const settled = () => !drag && !lean && still && Math.abs(vx) + Math.abs(vy) < 0.05 && Math.abs(rx) + Math.abs(ry) < 0.05;
  const frame = (t) => {
    raf = 0;
    const dt = clamp((t - last) / 1000, 0, 0.05);
    last = t;
    for (let left = dt; left > 1e-6; left -= STEP) step(Math.min(left, STEP));
    card.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
    if (seen && !document.hidden && !settled()) raf = requestAnimationFrame(frame);
  };
  // the loop runs only while the card is on screen (and, with reduced motion, only while it moves)
  function wake() {
    if (raf || !seen || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  new IntersectionObserver(([entry]) => {
    seen = entry.isIntersecting;
    wake();
  }).observe(shot);
  document.addEventListener('visibilitychange', wake);
  wake();
}

// ---- the activation form ----------------------------------------------------------------------
const t = (key) => (window.MCL_I18N ? window.MCL_I18N.t(key) : key);
const form = document.querySelector('.redeem-form');
if (form) {
  const input = form.querySelector('.redeem-input');
  const note = document.querySelector('.redeem-note');
  // MCL-XXXX-XXXX-XXXX: letters and digits, the dashes put in while typing
  const clean = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^MCL/, '').slice(0, 12);
  const pretty = (raw) => (raw ? `MCL-${raw.match(/.{1,4}/g).join('-')}` : '');
  input.addEventListener('input', () => {
    const raw = clean(input.value);
    const next = pretty(raw);
    if (next !== input.value) input.value = next;
    input.classList.remove('bad');
    note.textContent = '';
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = clean(input.value);
    if (raw.length !== 12) {
      input.classList.add('bad');
      note.className = 'redeem-note bad';
      note.textContent = t('codeBad');
      input.focus();
      return;
    }
    const code = pretty(raw);
    input.value = code;
    note.className = 'redeem-note ok';
    note.textContent = `${t('codeOpening')} `;
    const link = document.createElement('a');
    link.href = 'https://github.com/t0roky0/MCLauncher/releases/latest/download/MCLauncher-Setup.exe';
    link.textContent = t('downloadApp') || 'MC Launcher';
    note.appendChild(link);
    // the launcher's own link: it opens with the code (nothing is sent anywhere from this page)
    window.location.href = `mclauncher://redeem/${code}`;
  });
}
