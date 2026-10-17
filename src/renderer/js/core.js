// IPC bridge, shared state, formatting.
import { t, getLang } from './i18n.js';

export const api = (channel, ...args) => window.mcl.invoke(channel, ...args);
export const onEvent = (event, fn) => window.mcl.on(event, fn);

// ---- store ---------------------------------------------------------------
const state = {};
const subs = new Map();

export const store = {
  get: (k) => state[k],
  set(patch) {
    const keys = Object.keys(patch);
    for (const k of keys) state[k] = patch[k];
    for (const k of keys) for (const fn of [...(subs.get(k) || [])]) fn(state[k]);
  },
  on(keys, fn) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      if (!subs.has(k)) subs.set(k, new Set());
      subs.get(k).add(fn);
    }
    return () => list.forEach((k) => subs.get(k).delete(fn));
  },
};

// ---- formatting ------------------------------------------------------------
export function timeAgo(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('time.justNow');
  if (min < 60) return t('time.min', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('time.hour', { n: hr });
  const days = Math.floor(hr / 24);
  if (days < 30) return t('time.day', { n: days });
  return new Date(ms).toLocaleDateString(getLang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dayAgo(ms) {
  if (!ms) return '';
  const d0 = new Date();
  d0.setHours(0, 0, 0, 0);
  const days = Math.floor((d0.getTime() - ms) / 86400000) + 1;
  if (ms >= d0.getTime()) return t('worlds.today');
  if (days <= 1) return t('worlds.yesterday');
  if (days < 30) return t('worlds.daysAgo', { n: days });
  return new Date(ms).toLocaleDateString(getLang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'short' });
}

export function formatBytes(n) {
  const ru = getLang() !== 'en';
  const units = ru ? ['Б', 'КБ', 'МБ', 'ГБ'] : ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = Math.max(0, n || 0);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatMb(mb) {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} ${getLang() === 'en' ? 'GB' : 'ГБ'}`;
  }
  return `${Math.round(mb)} ${getLang() === 'en' ? 'MB' : 'МБ'}`;
}

export function formatDuration(ms) {
  const totalMin = Math.round((ms || 0) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h) return m ? `${t('time.h', { n: h })} ${t('time.m', { n: m })}` : t('time.h', { n: h });
  return t('time.m', { n: m });
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(getLang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const remote = (url) => (url ? `mcl://remote/?u=${encodeURIComponent(url)}` : '');

// One line describing what a download/launch task is doing right now.
export function stageText(task) {
  if (!task || !task.busy) return '';
  if (task.phase === 'auth') return t('launch.stage.auth');
  if (task.phase === 'launching') return t('launch.stage.launching');
  const p = task.progress;
  if (!p) return t('launch.stage.prepare');
  const base = t(`launch.stage.${p.stage}`, { loader: p.loader || '', major: p.major || '' });
  if ((p.stage === 'libraries' || p.stage === 'assets' || p.stage === 'verify') && p.total) return `${base} ${p.done}/${p.total}`;
  return base;
}

// ---- accent colour -------------------------------------------------------
// The palette is Minecraft's dye colours pulled onto one calm tone (v1's
// "_mute"): saturation capped, lightness clamped, so no swatch glares when
// it drives every button.

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}

function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(Math.max(0, Math.min(1, c)) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function hsvSaturation([r, g, b]) {
  const max = Math.max(r, g, b);
  return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
}

function mute(hex) {
  const rgb = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(rgb);
  if (hsvSaturation(rgb) <= 0.2) return hslToHex(h, Math.min(s, 0.12), Math.min(Math.max(l, 0.3), 0.7));
  return hslToHex(h, Math.min(s, 0.5), Math.min(Math.max(l, 0.36), 0.56));
}

// One row in Settings; anything else is the custom colour's job.
const DYES = [
  ['Orange', '#f9801d'],
  ['Red', '#b02e26'],
  ['Pink', '#f38baa'],
  ['Magenta', '#c74ebd'],
  ['Purple', '#8932b8'],
  ['Blue', '#3c44aa'],
  ['Light Blue', '#3ab3da'],
  ['Cyan', '#169c9c'],
  ['Emerald', '#4caf50'],
  ['Lime', '#80c71f'],
  ['Yellow', '#fed83d'],
  ['Brown', '#835432'],
  ['Gray', '#474f52'],
];
export const PALETTE = DYES.map(([name, hex]) => ({ name, hex: mute(hex) }));
// the default look: emerald green
export const DEFAULT_ACCENT = PALETTE.find((p) => p.name === 'Emerald').hex;

export function applyAccent(hex) {
  const base = hexToRgb(hex) ? hex : DEFAULT_ACCENT;
  const [h, s, l] = rgbToHsl(hexToRgb(base));
  const lum = (() => {
    const [r, g, b] = hexToRgb(base).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  })();
  const sat = Math.min(1, s * 1.12);
  const vars = {
    '--acc': base,
    '--acc-hi': hslToHex(h, sat, Math.min(0.82, l + 0.13)),
    '--acc-lo': hslToHex(h, sat, Math.max(0.14, l - 0.1)),
    '--acc-line': hslToHex(h, Math.min(1, sat * 1.05), Math.min(0.78, l + 0.07)),
    '--acc-deep': hslToHex(h, sat, Math.max(0.1, l - 0.22)),
    '--acc-text': hslToHex(h, Math.min(1, sat * 1.1), Math.max(0.66, Math.min(0.76, l + 0.18))),
    '--acc-tint': hslToHex(h, Math.min(0.32, sat), 0.13),
    '--acc-tint-2': hslToHex(h, Math.min(0.3, sat), 0.17),
    '--acc-glow': `rgba(${hexToRgb(base).join(',')}, 0.32)`,
    '--acc-soft': `rgba(${hexToRgb(base).join(',')}, 0.14)`,
    '--on-acc': lum > 0.42 ? '#1c1a18' : '#ffffff',
    '--on-acc-shadow': lum > 0.42 ? 'rgba(255,255,255,.25)' : 'rgba(0,0,0,.28)',
  };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}

// ---- the sheen -------------------------------------------------------------
// The Onyx launcher's metallic glint (Style.sheenPaint), rebuilt for CSS: one
// broad light band shared by every metal surface in the window, moving
// diagonally across over ten seconds on a smootherstep curve.
//
// Each surface clips its own strip of that band (a child i.sheen) and the
// strip slides by a transform animation: the compositor runs those at whatever rate
// the monitor refreshes, and the page itself does no work per frame. (Moving
// one background position from script, as before, restyled and repainted
// every button on every frame.) All strips share one timeline — start time 0
// — and each is placed by where its surface sits, re-measured only when the
// layout changes, so the band lines up across buttons the way one light
// source would.

const SHEEN_MS = 10000;
const SLOPE = 0.65; // the band leans: 0.65 px to the left for every px down
const SKEW = (-Math.atan(SLOPE) * 180) / Math.PI;
const SURFACES = '.metal, .logo-shine';
let sheenOn = false;
let sheenHalf = 0;
let sheenExtent = 0;
let sheenFrames = null;
let sheenObserver = null;
let sheenTimer = 0;
let sheenRaf = 0;
const sheenAnims = new Map(); // surface → its strip's Animation

const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function rebuildSheen() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const extent = W + SLOPE * H;
  // A broad soft glow (Onyx's band) plus a narrow bright core — the core is
  // what makes it read as light on metal rather than a haze.
  const hw = (0.23 * extent) / Math.hypot(1, SLOPE);
  sheenHalf = Math.ceil(hw * 1.1);
  const glow = (d) => 0.34 * Math.exp(-5 * d * d) + 0.3 * Math.exp(-90 * d * d);
  const ds = [1, 0.7, 0.45, 0.28, 0.16, 0.09, 0.045, 0];
  const samples = [...ds, ...ds.slice(0, -1).reverse().map((d) => -d)];
  const stops = samples.map((d) => `rgba(255,255,255,${(Math.abs(d) === 1 ? 0 : glow(d)).toFixed(4)}) ${(sheenHalf - d * hw).toFixed(1)}px`);
  const root = document.documentElement.style;
  root.setProperty('--sheen-band', `linear-gradient(90deg, ${stops.join(', ')})`);
  root.setProperty('--sheen-w', `${sheenHalf * 2}px`);
  sheenExtent = extent;
  sheenFrames = true;
  for (const [el, anim] of sheenAnims) {
    anim.cancel();
    delete el.dataset.sheenKey;
  }
  sheenAnims.clear();
  placeSheen();
}

// Where the band's middle crosses the top of the window at time t (0..1).
const sweepX = (t) => (-0.35 + 1.7 * smootherstep(t)) * sheenExtent;

// The time the band reaches x (the sweep only ever moves right).
function sweepAt(x) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (sweepX(mid) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// One surface's keyframes: the strip follows the band while the band is over
// the surface and waits just outside it before and after — a layer that
// doesn't change costs the compositor nothing.
function stripFrames(left, width, height) {
  const w = sheenHalf * 2;
  const margin = SLOPE * height * 0.5 + 2;
  const from = -left - w - margin; // the strip's right edge at the surface's left
  const to = -left + width + margin; // its left edge past the surface's right
  const at = (t) => {
    const x = Math.max(from, Math.min(to, sweepX(t)));
    return { offset: t, transform: `translateX(${x.toFixed(1)}px) skewX(${SKEW.toFixed(3)}deg)` };
  };
  const t0 = sweepAt(from);
  const t1 = sweepAt(to);
  const times = new Set([0, 1, t0, t1]);
  for (let i = 1; i < 32; i++) times.add(t0 + ((t1 - t0) * i) / 32);
  return [...times].filter((t) => t >= 0 && t <= 1).sort((a, b) => a - b).map(at);
}

// Each strip starts where the band would be at its surface: its left edge
// set so the band's middle meets the surface's own middle line.
function placeSheen() {
  if (!sheenOn || !sheenFrames) return;
  const live = new Set();
  for (const el of document.querySelectorAll(SURFACES)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    live.add(el);
    const ex = r.left + el.clientLeft;
    const ey = r.top + el.clientTop;
    const left = Math.round(-SLOPE * (ey + el.clientHeight / 2) - ex - sheenHalf);
    // the strip: a child of its own (re-added if the surface's content was
    // replaced)
    let strip = el.querySelector(':scope > i.sheen');
    if (!strip) {
      strip = document.createElement('i');
      strip.className = 'sheen';
      el.prepend(strip);
      const old = sheenAnims.get(el);
      if (old) old.cancel();
      sheenAnims.delete(el);
    }
    const key = `${left}|${el.clientWidth}|${el.clientHeight}`;
    let anim = sheenAnims.get(el);
    if (anim && el.dataset.sheenKey === key) continue;
    el.dataset.sheenKey = key;
    el.style.setProperty('--sheen-x', `${left}px`);
    const frames = stripFrames(left, el.clientWidth, el.clientHeight);
    if (anim) anim.effect.setKeyframes(frames);
    else {
      anim = strip.animate(frames, { duration: SHEEN_MS, iterations: Infinity });
      anim.startTime = 0; // the shared timeline: every strip in step
      sheenAnims.set(el, anim);
    }
  }
  for (const [el, anim] of sheenAnims) {
    if (live.has(el)) continue;
    if (!el.isConnected) {
      anim.cancel();
      sheenAnims.delete(el);
    }
  }
}

// Layout changed (new page, dialog, list): re-measure once things settle.
function queueSheen() {
  if (sheenTimer) return;
  sheenTimer = setTimeout(() => {
    sheenTimer = 0;
    placeSheen();
  }, 100);
}

// Scrolling moves surfaces every frame: follow them while it lasts.
function scrollSheen() {
  if (sheenRaf) return;
  sheenRaf = requestAnimationFrame(() => {
    sheenRaf = 0;
    placeSheen();
  });
}

export function setSheen(enabled) {
  const root = document.documentElement;
  root.classList.toggle('no-sheen', !enabled);
  if (enabled && !sheenOn) {
    sheenOn = true;
    rebuildSheen();
    window.addEventListener('resize', rebuildSheen);
    document.addEventListener('scroll', scrollSheen, { capture: true, passive: true });
    document.addEventListener('transitionend', queueSheen, true);
    document.addEventListener('animationend', queueSheen, true);
    sheenObserver = new MutationObserver(queueSheen);
    sheenObserver.observe(document.body, { childList: true, subtree: true });
  } else if (!enabled && sheenOn) {
    sheenOn = false;
    window.removeEventListener('resize', rebuildSheen);
    document.removeEventListener('scroll', scrollSheen, { capture: true });
    document.removeEventListener('transitionend', queueSheen, true);
    document.removeEventListener('animationend', queueSheen, true);
    if (sheenObserver) sheenObserver.disconnect();
    sheenObserver = null;
    for (const [el, anim] of sheenAnims) {
      anim.cancel();
      delete el.dataset.sheenKey;
    }
    sheenAnims.clear();
  }
}

// Coins at a glance: as they are under 1000, then 1.2k, 25k, 1.5m (the full number in a tip)
export function shortCoins(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  const cut = (x, unit) => `${x >= 100 ? Math.floor(x) : Math.floor(x * 10) / 10}${unit}`;
  if (v < 1000) return String(v);
  if (v < 1e6) return cut(v / 1e3, 'k');
  return cut(v / 1e6, 'm');
}
