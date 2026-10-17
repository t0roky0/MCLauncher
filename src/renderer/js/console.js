// Console window: the launcher's and the game's log, live.
import { h, swap } from './dom.js';
import { t, setLang } from './i18n.js';
import { icon } from './icons.js';
import { api, onEvent, applyAccent } from './core.js';
import { button, toggle, toast } from './ui.js';

const MAX_DOM_LINES = 4000;
let filter = '';
let levels = { info: true, warn: true, error: true, debug: true };
let autoscroll = true;
let lines = [];
let logEl;
let countEl;
let killBtn;

function stamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function visible(l) {
  if (!levels[l.level]) return false;
  return !filter || l.text.toLowerCase().includes(filter);
}

function lineEl(l) {
  return h(`div.line.${l.level}.${l.source}`, h('span.ts', stamp(l.t)), h('span.src', l.source === 'game' ? 'GAME' : 'MCL'), h('span.msg', l.text));
}

function renderAll() {
  const shown = lines.filter(visible).slice(-MAX_DOM_LINES);
  swap(logEl, shown.length ? shown.map(lineEl) : h('div.empty-log', t('console.empty')));
  countEl.textContent = String(lines.length);
  if (autoscroll) logEl.scrollTop = logEl.scrollHeight;
}

function addLines(batch) {
  lines.push(...batch);
  if (lines.length > 12000) lines = lines.slice(-10000);
  const empty = logEl.querySelector('.empty-log');
  if (empty) empty.remove();
  const frag = document.createDocumentFragment();
  for (const l of batch) if (visible(l)) frag.appendChild(lineEl(l));
  logEl.appendChild(frag);
  while (logEl.childElementCount > MAX_DOM_LINES) logEl.firstElementChild.remove();
  countEl.textContent = String(lines.length);
  if (autoscroll) logEl.scrollTop = logEl.scrollHeight;
}

async function refreshKill() {
  const running = await api('game:list').catch(() => []);
  killBtn.style.display = running.length ? '' : 'none';
  killBtn.onclick = () => running.forEach((r) => api('game:kill', r.pid));
}

async function boot() {
  const cfg = await api('config:get');
  setLang(cfg.language);
  applyAccent(cfg.accentColor);
  document.title = `MC Launcher — ${t('console.title')}`;

  const maxBtn = h('button.win-btn', { type: 'button', onclick: () => api('win:toggleMaximize') }, icon('winMax'));
  const title = h(
    'div.titlebar',
    h('img.tb-icon', { src: 'mcl://app/assets/icon/titlebar.png', alt: '' }),
    h('div.tb-title', `MC Launcher — ${t('console.title')}`),
    h('div.tb-spacer'),
    h('div.win-btns', h('button.win-btn', { type: 'button', onclick: () => api('win:minimize') }, icon('winMin')), maxBtn, h('button.win-btn.close', { type: 'button', onclick: () => api('win:close') }, icon('winClose'))),
  );
  onEvent('win:maximized', (m) => maxBtn.replaceChildren(icon(m ? 'winRestore' : 'winMax')));

  const filterInput = h('input.input', { placeholder: t('console.filter'), spellcheck: false });
  filterInput.addEventListener('input', () => {
    filter = filterInput.value.trim().toLowerCase();
    renderAll();
  });
  const levelBtn = (lv, label) => {
    const b = h('button.lv', { type: 'button', class: `on ${lv}` }, label);
    b.addEventListener('click', () => {
      levels[lv] = !levels[lv];
      b.classList.toggle('on', levels[lv]);
      renderAll();
    });
    return b;
  };
  killBtn = button(t('console.kill'), { variant: 'danger', icon: 'stop', cls: 'btn-sm' });
  countEl = h('span.count', '0');
  const auto = toggle(true, (v) => {
    autoscroll = v;
    if (v) logEl.scrollTop = logEl.scrollHeight;
  });
  const bar = h(
    'div.toolbar',
    h('div.filter', icon('search'), filterInput),
    levelBtn('info', 'INFO'),
    levelBtn('warn', 'WARN'),
    levelBtn('error', 'ERROR'),
    // to the right, and onto the next row together when the window's narrow
    h(
      'div.tb-right',
      h('label.auto', auto, t('console.autoscroll')),
      killBtn,
      button(null, { icon: 'copy', cls: 'btn-sm btn-icon', title: t('console.copy'), onClick: copyVisible }),
      button(null, { icon: 'folder', cls: 'btn-sm btn-icon', title: t('console.logs'), onClick: () => api('app:openFolder', 'logs') }),
      button(null, { icon: 'trash', cls: 'btn-sm btn-icon', title: t('console.clear'), onClick: async () => {
        await api('log:clear');
        lines = [];
        renderAll();
      } }),
    ),
  );
  logEl = h('div.log');
  logEl.addEventListener('scroll', () => {
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
    if (autoscroll !== atBottom) {
      autoscroll = atBottom;
      auto.setValue(atBottom);
    }
  });
  const foot = h('div.foot', h('span', 'Lines: '), countEl);
  swap(document.getElementById('console'), title, bar, logEl, foot);

  lines = await api('log:history');
  renderAll();
  onEvent('log:lines', addLines);
  onEvent('game', refreshKill);
  refreshKill();
}

async function copyVisible() {
  const text = lines.filter(visible).map((l) => `[${stamp(l.t)}] [${l.source}/${l.level.toUpperCase()}] ${l.text}`).join('\n');
  await navigator.clipboard.writeText(text);
  toast(t('toast.copied'), { kind: 'ok', icon: 'copy', timeout: 1800 });
}

boot().catch((e) => {
  document.getElementById('console').textContent = `Console failed: ${e.message}`;
});
