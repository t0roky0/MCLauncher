// Minecraft text formatting → DOM: chat components ({text, color, bold,
// extra}) and legacy "§a"-style strings, as a server's MOTD uses them.
import { h } from './dom.js';

const COLORS = {
  black: '#000000', dark_blue: '#0000aa', dark_green: '#00aa00', dark_aqua: '#00aaaa', dark_red: '#aa0000',
  dark_purple: '#aa00aa', gold: '#ffaa00', gray: '#aaaaaa', dark_gray: '#555555', blue: '#5555ff',
  green: '#55ff55', aqua: '#55ffff', red: '#ff5555', light_purple: '#ff55ff', yellow: '#ffff55', white: '#ffffff',
};
const CODE = {
  0: 'black', 1: 'dark_blue', 2: 'dark_green', 3: 'dark_aqua', 4: 'dark_red', 5: 'dark_purple', 6: 'gold', 7: 'gray',
  8: 'dark_gray', 9: 'blue', a: 'green', b: 'aqua', c: 'red', d: 'light_purple', e: 'yellow', f: 'white',
};

function span(text, style) {
  const s = {};
  if (style.color) s.color = COLORS[style.color] || (/^#[0-9a-f]{6}$/i.test(style.color) ? style.color : undefined);
  if (style.bold) s.fontWeight = '700';
  if (style.italic) s.fontStyle = 'italic';
  const deco = [style.underlined && 'underline', style.strikethrough && 'line-through'].filter(Boolean).join(' ');
  if (deco) s.textDecoration = deco;
  return h('span', { style: s }, text);
}

function legacy(text, base, out) {
  let style = { ...base };
  const parts = String(text).split(/(§[0-9a-fk-or])/i);
  for (const p of parts) {
    const m = /^§([0-9a-fk-or])$/i.exec(p);
    if (m) {
      const c = m[1].toLowerCase();
      if (CODE[c]) style = { ...base, color: CODE[c] };
      else if (c === 'l') style.bold = true;
      else if (c === 'o') style.italic = true;
      else if (c === 'n') style.underlined = true;
      else if (c === 'm') style.strikethrough = true;
      else if (c === 'r') style = { ...base };
      continue;
    }
    if (p) out.push(span(p.replace(/\n/g, ' '), style));
  }
}

function walk(node, parent, out) {
  if (node == null) return;
  if (typeof node === 'string') {
    legacy(node, parent, out);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, parent, out));
    return;
  }
  const style = { ...parent };
  for (const k of ['color', 'bold', 'italic', 'underlined', 'strikethrough']) if (node[k] !== undefined) style[k] = node[k];
  if (node.text !== undefined) legacy(node.text, style, out);
  if (node.translate && node.text === undefined) legacy(node.translate, style, out);
  if (node.extra) walk(node.extra, style, out);
}

export function renderMotd(motd) {
  const out = [];
  walk(motd, { color: 'gray' }, out);
  return h('span', out);
}
