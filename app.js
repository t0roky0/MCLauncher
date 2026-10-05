// MC Launcher site: the launcher's pixel icons, drifting dust in the hero,
// the latest version from GitHub Releases, and a screenshot viewer.
'use strict';

const REPO = document.documentElement.dataset.repo;

// 9x9 pixel art from the launcher (icons.js): '#' the colour, '+' lighter, ':' darker
const ICONS = {
  friends: '........./.##...##./.##...##./........./####.####/####.####/####.####/####.####/.........',
  headset: '..#####../.#.....#./#.......#/#.......#/##.....##/###...###/###...###/###...###/.##...##.',
  hanger: '....##.../...#..#../......#../.....#.../....#..../...#.#.../..#...#../.#.....#./#########',
  play: '..#....../..##...../..###..../..####.../..#####../..####.../..###..../..##...../..#......',
  block: '...###.../.#######./#########/++#####::/++++#::::/+++++::::/+++++::::/.++++:::./...++:...',
  gamepad: '........./.#######./###.#####/##...#.##/###.###.#/#########/##.....##/#.......#/.........',
  mail: '........./#########/##.....##/#.#...#.#/#..#.#..#/#...#...#/#.......#/#########/.........',
  sparkle: '.......#./......###/...#...#./...#...../..###..../#######../..###..../...#...../...#.....',
  download: '....#..../....#..../....#..../.#..#..#./..#.#.#../...###.../....#..../........./#########',
  star: '....#..../...###.../...###.../#########/.#######./..#####../..##.##../.##...##./.#.....#.',
  signal: '.......##/.......##/....##.##/....##.##/.##.##.##/.##.##.##/.##.##.##/........./.........',
  chat: '........./.#######./#########/##.#.#.##/#########/.#######./..##...../.#......./.........',
  java: '...#.#.../..#.#..../........./#######../#.....###/#.....#.#/#.....###/.#...#.../..###....',
  left: '........./......#../.....##../....##.../...##..../....##.../.....##../......#../.........',
  right: '........./..#....../..##...../...##..../....##.../...##..../..##...../..#....../.........',
  close: '........./.#.....#./..#...#../...#.#.../....#..../...#.#.../..#...#../.#.....#./.........',
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

// pixel dust rising through the hero, like the lobby's particles
const dust = document.querySelector('.dust');
if (dust && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  for (let i = 0; i < 26; i++) {
    const d = document.createElement('i');
    const size = [4, 6, 6, 8][i % 4];
    d.style.cssText = `left:${Math.random() * 100}%;width:${size}px;height:${size}px;animation-duration:${14 + Math.random() * 16}s;animation-delay:${-Math.random() * 30}s;opacity:${0.25 + Math.random() * 0.45}`;
    dust.appendChild(d);
  }
}

// the newest release: its version and size next to the buttons, and the
// installer's own link (the fixed-name link works without this too)
const i18n = window.MCL_I18N;
let release = null;
function showVersion() {
  if (!release) return;
  const text = i18n.t('version', { v: release.version }) + (release.size ? ` · ${i18n.t('mb', { n: Math.round(release.size / 1048576) })}` : '');
  for (const el of document.querySelectorAll('.ver')) el.textContent = text;
}
i18n.onChange(showVersion);
if (REPO && !REPO.startsWith('__')) {
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => {
      if (!rel) return;
      const exe = (rel.assets || []).find((a) => /\.exe$/i.test(a.name));
      release = { version: String(rel.tag_name || '').replace(/^v/, ''), size: exe ? exe.size : 0 };
      showVersion();
      if (exe) for (const a of document.querySelectorAll('.dl-link')) a.href = exe.browser_download_url;
    })
    .catch(() => {});
}

// screenshots open full size
const viewer = document.querySelector('.viewer');
const viewerImg = viewer.querySelector('img');
function closeViewer() {
  viewer.hidden = true;
  viewerImg.removeAttribute('src');
}
viewer.addEventListener('click', closeViewer);
document.addEventListener('keydown', (e) => e.key === 'Escape' && !viewer.hidden && closeViewer());

// the screenshot slider: one at a time; the bar along the bottom runs out
// and the next one slides in (paused under the mouse); arrows, dots, swipes
const slider = document.querySelector('.slider');
if (slider) {
  const track = slider.querySelector('.slides');
  const slides = [...track.children];
  const dots = [...slider.querySelectorAll('.dots button')];
  const bar = slider.querySelector('.slide-bar i');
  let at = 0;

  const go = (i) => {
    at = (i + slides.length) % slides.length;
    track.style.transform = `translateX(${-at * 100}%)`;
    slides.forEach((s, k) => {
      s.classList.toggle('on', k === at);
      s.setAttribute('aria-hidden', String(k !== at));
    });
    dots.forEach((d, k) => d.classList.toggle('on', k === at));
    // the countdown starts over
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = '';
  };
  bar.addEventListener('animationend', () => go(at + 1));
  slider.querySelector('.prev').addEventListener('click', () => go(at - 1));
  slider.querySelector('.next').addEventListener('click', () => go(at + 1));
  dots.forEach((d, k) => d.addEventListener('click', () => go(k)));
  slider.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') go(at - 1);
    else if (e.key === 'ArrowRight') go(at + 1);
  });

  // a swipe flips; a plain click opens the picture full size
  let down = null;
  track.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
  track.addEventListener('pointerup', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    down = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(at + (dx < 0 ? 1 : -1));
    else if (Math.abs(dx) < 6 && e.target.tagName === 'IMG') {
      viewerImg.src = slides[at].dataset.full;
      viewerImg.alt = e.target.alt;
      viewer.hidden = false;
    }
  });
  go(0);
}
