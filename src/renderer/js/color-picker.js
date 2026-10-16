// The custom accent colour: a popover under its swatch with a
// saturation/value square, a hue strip and a hex field. Changes apply live
// (onInput) and are committed when it closes (onClose).
import { h } from './dom.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function hexToHsv(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let hue = 0;
  if (d) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
  }
  return [(hue * 60 + 360) % 360, max ? d / max : 0, max];
}

export function hsvToHex(hue, s, v) {
  const f = (n) => {
    const k = (n + hue / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

let openPop = null;

export function closeColorPicker() {
  if (openPop) openPop();
}

export function openColorPicker(anchor, hex, { onInput, onClose } = {}) {
  closeColorPicker();
  let [hue, sat, val] = hexToHsv(hex) || [28, 0.55, 0.75];
  let value = hsvToHex(hue, sat, val);

  const sv = h('canvas');
  const strip = h('canvas');
  const svKnob = h('div.cp-knob');
  const hueKnob = h('div.cp-knob');
  const svBox = h('div.cp-sv', sv, svKnob);
  const hueBox = h('div.cp-hue', strip, hueKnob);
  const preview = h('div.cp-preview');
  const hexInput = h('input.input', { value, maxLength: 7, spellcheck: false });
  const pop = h('div.color-pop', svBox, hueBox, h('div.cp-row', preview, hexInput));
  document.body.appendChild(pop);

  function paintSquare() {
    const g = sv.getContext('2d');
    const { width: w, height: hh } = sv;
    g.fillStyle = hsvToHex(hue, 1, 1);
    g.fillRect(0, 0, w, hh);
    const white = g.createLinearGradient(0, 0, w, 0);
    white.addColorStop(0, '#fff');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = white;
    g.fillRect(0, 0, w, hh);
    const black = g.createLinearGradient(0, 0, 0, hh);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, '#000');
    g.fillStyle = black;
    g.fillRect(0, 0, w, hh);
  }

  function paintStrip() {
    const g = strip.getContext('2d');
    const grad = g.createLinearGradient(0, 0, strip.width, 0);
    for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, hsvToHex(i * 60, 1, 1));
    g.fillStyle = grad;
    g.fillRect(0, 0, strip.width, strip.height);
  }

  function show({ fromInput = false, repaint = false, silent = false } = {}) {
    value = hsvToHex(hue, sat, val);
    if (repaint) paintSquare();
    svKnob.style.left = `${sat * 100}%`;
    svKnob.style.top = `${(1 - val) * 100}%`;
    hueKnob.style.left = `${(hue / 360) * 100}%`;
    preview.style.background = value;
    if (!fromInput) hexInput.value = value;
    if (!silent && onInput) onInput(value);
  }

  function drag(box, fn) {
    const move = (e) => {
      const r = box.getBoundingClientRect();
      fn(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
    };
    box.addEventListener('pointerdown', (e) => {
      box.setPointerCapture(e.pointerId);
      move(e);
      const up = () => {
        box.removeEventListener('pointermove', move);
        box.removeEventListener('pointerup', up);
      };
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', up);
    });
  }
  drag(svBox, (x, y) => {
    sat = x;
    val = 1 - y;
    show();
  });
  drag(hueBox, (x) => {
    hue = x * 359.9;
    show({ repaint: true });
  });
  hexInput.addEventListener('input', () => {
    const v = hexInput.value.trim();
    const hsv = hexToHsv(v.startsWith('#') ? v : `#${v}`);
    if (!hsv) return;
    [hue, sat, val] = hsv;
    show({ fromInput: true, repaint: true });
  });

  // size the canvases to their boxes, then place the popover under the swatch
  sv.width = svBox.clientWidth;
  sv.height = svBox.clientHeight;
  strip.width = hueBox.clientWidth;
  strip.height = hueBox.clientHeight;
  paintStrip();
  show({ repaint: true, silent: true });
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = r.left + r.width / 2 - pr.width / 2;
  let top = r.bottom + 8;
  if (top + pr.height > window.innerHeight - 8) top = r.top - pr.height - 8;
  left = clamp(left, 8, window.innerWidth - pr.width - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(8, top)}px`;
  requestAnimationFrame(() => pop.classList.add('open'));

  const outside = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.stopPropagation();
      close();
    }
  };
  function close() {
    openPop = null;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    pop.remove();
    onClose && onClose(value);
  }
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
  openPop = close;
  hexInput.focus();
  hexInput.select();
}
