// The in-game overlay page (main process: overlay.js). A transparent page
// the size of the game's window that nobody can click: the voice panel —
// our mic, and everyone in voice with who's talking — and news as small
// Minecraft-style toasts, each where the player put it.
//
// The editor: the same page taking the mouse — drag the parts, change size
// and opacity on the bar at the top, Esc when done. Inside the launcher's
// settings it runs in a frame as a live preview (state by postMessage).
import { h, swap } from './dom.js';
import { icon } from './icons.js';

const voiceBox = document.getElementById('voice');
const toastBox = document.getElementById('toasts');
const bar = h('div.ov-bar');
document.body.append(bar);
const shown = new Map(); // toast id → element
const framed = !window.overlay; // the settings page's preview
const badgeOnly = location.hash === '#badge'; // the recording badge's own window
let state = null;
let lastVoice = '';
let lastBar = '';
let dragging = null;

const SIZES = ['s', 'm', 'l', 'xl'];

function send(type, payload) {
  if (!framed) {
    if (type === 'save') window.overlay.save(payload);
    else window.overlay.done();
  } else window.parent.postMessage({ source: 'mcl-overlay', type, payload }, location.origin);
}

// A face: the skin's 8x8 (or 16x16) front, drawn pixel for pixel; without
// one, a tile with the name's first letter.
function face(src, name, cls = '') {
  if (src && state.faces) return h(`img.ov-face${cls}`, { src, alt: '' });
  return h(`div.ov-face.ov-initial${cls}`, String(name || '?').slice(0, 1).toUpperCase());
}

function micIcon(v) {
  if (v.deaf) return icon('headsetOff');
  return icon(v.micOff ? 'micOff' : 'mic');
}

// What the editor shows when nobody's in voice: where the panel will be.
function sampleVoice(ru) {
  return { sample: true, self: { name: ru ? 'Вы' : 'You' }, micOff: false, deaf: false, speaking: true, mode: 'vad', peers: [
    { id: 's1', name: ru ? 'Друг' : 'Friend', speaking: true },
    { id: 's2', name: ru ? 'Ещё друг' : 'Another friend', speaking: false },
  ] };
}

function renderVoice(v, ru) {
  if (!v && state.editing && state.voiceMode !== 'off') v = sampleVoice(ru);
  const key = JSON.stringify([v, ru, state.voiceMode, state.faces, state.self, state.editing]);
  if (key === lastVoice) return;
  lastVoice = key;
  voiceBox.classList.toggle('sample', !!v?.sample);
  if (!v) {
    swap(voiceBox);
    return;
  }
  const rows = [];
  const muted = v.micOff || v.deaf;
  const selfState = v.deaf ? 'deaf' : v.micOff ? 'muted' : v.speaking ? 'speaking' : 'idle';
  const selfLabel = v.deaf ? (ru ? 'Звук выключен' : 'Deafened')
    : v.micOff ? (ru ? 'Микрофон выключен' : 'Mic off')
    : v.mode === 'ptt' && !v.speaking ? (ru ? `Рация: ${v.pttName || '?'}` : `Push to talk: ${v.pttName || '?'}`)
    : (v.self?.name || (ru ? 'Вы' : 'You'));
  const always = state.voiceMode !== 'speaking';
  // ourselves: muted is always worth showing; otherwise as set
  if (muted || (state.self && (always || v.speaking))) {
    rows.push(h(`div.ov-row.self.${selfState}`, face(v.self?.face, v.self?.name), h('span.ov-name', selfLabel), h('span.ov-mic', micIcon(v))));
  }
  for (const p of v.peers) {
    if (!always && !p.speaking) continue;
    rows.push(h(`div.ov-row${p.speaking ? '.speaking' : ''}`, face(p.face, p.name), h('span.ov-name', p.name), p.relay ? h('span.ov-tag', ru ? 'ретр.' : 'relay') : null));
  }
  // nobody to hear: nothing said about it (the user: it's just in the way)
  swap(voiceBox, rows);
}

function toastEl(t) {
  const pic = t.thumb ? h('img.ov-thumb', { src: t.thumb, alt: '' })
    : t.face && state.faces ? face(t.face, t.title, '.big')
    : t.avatar && state.faces ? h('img.ov-face.big.avatar', { src: `mcl://remote/?u=${encodeURIComponent(t.avatar)}`, alt: '' })
    : h('div.ov-face.big.ov-tile', icon(t.icon || 'info'));
  const el = h(`div.ov-toast.${t.kind || 'info'}`,
    h('div.ov-pic', pic),
    h('div.ov-body', h('div.ov-title', t.title), t.text ? h('div.ov-text', t.text) : null),
    t.left ? h('div.ov-time', { style: { animationDuration: `${t.left}ms` } }) : null);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  return el;
}

function renderToasts(list, ru) {
  if (!list.length && state.editing && state.notifications !== false) {
    list = [{ id: 'sample', title: ru ? 'Уведомление' : 'Notification', text: ru ? 'друг зашёл в лобби' : 'a friend joined the lobby', kind: 'party', icon: 'userPlus', left: 0 }];
  }
  toastBox.classList.toggle('sample', list.length === 1 && list[0].id === 'sample');
  const ids = new Set(list.map((t) => t.id));
  for (const [id, el] of shown) {
    if (ids.has(id)) continue;
    shown.delete(id);
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }
  for (const t of list) {
    if (shown.has(t.id)) continue;
    const el = toastEl(t);
    shown.set(t.id, el);
    toastBox.append(el);
  }
}

// ---- where the parts stand ------------------------------------------------------------------

function place(el, spot) {
  if (!spot || dragging?.el === el) return;
  const pct = (n) => `${(n * 100).toFixed(2)}%`;
  el.style.left = spot.ax === 'l' ? pct(spot.x) : '';
  el.style.right = spot.ax === 'r' ? pct(spot.x) : '';
  el.style.top = spot.ay === 't' ? pct(spot.y) : '';
  el.style.bottom = spot.ay === 'b' ? pct(spot.y) : '';
  el.dataset.ax = spot.ax;
  el.dataset.ay = spot.ay;
}

// A part let go: anchored to the nearer side, so a list grows away from it.
function spotOf(el) {
  const r = el.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  const ax = r.left + r.width / 2 < W / 2 ? 'l' : 'r';
  const ay = r.top + r.height / 2 < H / 2 ? 't' : 'b';
  const share = (n, of) => Math.max(0, Math.min(1, Math.round((n / of) * 10000) / 10000));
  return { x: share(ax === 'l' ? r.left : W - r.right, W), y: share(ay === 't' ? r.top : H - r.bottom, H), ax, ay };
}

function startDrag(e, el, part) {
  if (!state?.editing || e.button !== 0) return;
  e.preventDefault();
  const r = el.getBoundingClientRect();
  dragging = { el, part, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
  el.classList.add('dragging');
  try {
    el.setPointerCapture(e.pointerId);
  } catch { /* a pointer that isn't down any more */ }
}

function moveDrag(e) {
  const d = dragging;
  if (!d) return;
  const W = window.innerWidth, H = window.innerHeight, pad = 4;
  let x = Math.max(pad, Math.min(W - d.w - pad, e.clientX - d.dx));
  let y = Math.max(pad, Math.min(H - d.h - pad, e.clientY - d.dy));
  // the middle of the screen pulls a little
  if (Math.abs(x + d.w / 2 - W / 2) < 10) x = W / 2 - d.w / 2;
  Object.assign(d.el.style, { left: `${x}px`, top: `${y}px`, right: '', bottom: '' });
}

function endDrag() {
  const d = dragging;
  if (!d) return;
  dragging = null;
  d.el.classList.remove('dragging');
  const spot = spotOf(d.el);
  state.layout = { ...state.layout, [d.part]: spot };
  place(d.el, spot);
  send('save', { layout: { [d.part]: spot } });
}

for (const [el, part] of [[voiceBox, 'voice'], [toastBox, 'toasts']]) {
  el.addEventListener('pointerdown', (e) => startDrag(e, el, part));
  el.addEventListener('pointermove', moveDrag);
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
}

// ---- the editor's bar ----------------------------------------------------------------------------

function renderBar(ru) {
  const key = JSON.stringify([state.editing && !framed, state.size, state.opacity, ru, state.editName]);
  if (key === lastBar) return;
  lastBar = key;
  if (!state.editing || framed) {
    swap(bar);
    return;
  }
  const names = ru ? { s: 'Компактный', m: 'Обычный', l: 'Крупный', xl: 'Огромный' } : { s: 'Compact', m: 'Normal', l: 'Large', xl: 'Huge' };
  const sizeBtns = SIZES.map((s) => {
    const b = h(`button.ov-btn${state.size === s ? '.on' : ''}`, { type: 'button' }, names[s]);
    b.addEventListener('click', () => send('save', { size: s }));
    return b;
  });
  const range = h('input.ov-range', { type: 'range', min: 0, max: 100, step: 5, value: state.opacity });
  const out = h('span.ov-val', `${state.opacity}%`);
  range.addEventListener('input', () => {
    out.textContent = `${range.value}%`;
    document.documentElement.style.setProperty('--alpha', String(range.value / 100));
  });
  range.addEventListener('change', () => send('save', { opacity: Number(range.value) }));
  const reset = h('button.ov-btn', { type: 'button' }, ru ? 'Сброс' : 'Reset');
  reset.addEventListener('click', () => send('save', { reset: true }));
  const done = h('button.ov-btn.primary', { type: 'button' }, ru ? 'Готово' : 'Done');
  done.addEventListener('click', () => send('done'));
  swap(bar,
    h('div.ov-bar-title', ru ? 'Настройка оверлея' : 'Overlay layout'),
    h('div.ov-bar-hint', ru ? `Перетащите панели мышью · Esc${state.editName ? ` или ${state.editName}` : ''} — готово` : `Drag the panels · Esc${state.editName ? ` or ${state.editName}` : ''} when done`),
    h('div.ov-bar-row', h('span.ov-lbl', ru ? 'Размер' : 'Size'), ...sizeBtns),
    h('div.ov-bar-row', h('span.ov-lbl', ru ? 'Фон' : 'Background'), range, out),
    h('div.ov-bar-row', reset, done));
}

// ---- the menu over the game: voice, lobby chat, capture, layout ---------------------------------

const menu = h('div.ov-menu');
const recBadge = h('div.ov-rec', { hidden: true });
document.body.append(menu, recBadge);
const chatInput = h('input.ov-input', { type: 'text', maxLength: 500, spellcheck: false });
const chatLog = h('div.ov-chat-log');
let lastMenu = '';
let lastChat = '';
const act = (name, value) => window.overlay?.action(name, value);

function btn(label, onClick, { cls = '', ic = '', on = false, title = '' } = {}) {
  const b = h(`button.ov-btn${cls}${on ? '.on' : ''}`, { type: 'button', title: title || null, 'aria-label': title || null }, ic ? icon(ic) : null, label ? h('span', label) : null);
  b.addEventListener('click', onClick);
  return b;
}

function slider(value, onChange) {
  const range = h('input.ov-range', { type: 'range', min: 0, max: 100, step: 5, value });
  const out = h('span.ov-val', `${value}%`);
  range.addEventListener('input', () => { out.textContent = `${range.value}%`; });
  range.addEventListener('change', () => onChange(Number(range.value)));
  return [range, out];
}

function voicePanel(m, ru) {
  const v = state.voice;
  const modes = [['vad', ru ? 'Голосом' : 'By voice'], ['ptt', ru ? 'По кнопке' : 'Push to talk'], ['open', ru ? 'Всегда' : 'Always']];
  const people = (v?.peers || []).map((p) => h('div.ov-person', { dataset: { id: p.id } },
    face(p.face, p.name), h('span.ov-person-name', p.name), ...slider(p.volume, (n) => act('volume', { name: p.name, volume: n }))));
  return [
    h('div.ov-menu-row',
      btn(m.micOff ? (ru ? 'Микрофон выкл.' : 'Mic off') : (ru ? 'Микрофон вкл.' : 'Mic on'), () => act('mic'), { cls: m.micOff ? '.big.bad' : '.big.good', ic: m.micOff ? 'micOff' : 'mic' }),
      btn(m.deaf ? (ru ? 'Звук выкл.' : 'Sound off') : (ru ? 'Звук вкл.' : 'Sound on'), () => act('deaf'), { cls: m.deaf ? '.big.bad' : '.big.good', ic: m.deaf ? 'headsetOff' : 'headset' })),
    h('div.ov-menu-label', ru ? 'Когда вас слышно' : 'When you are heard'),
    h('div.ov-menu-row', ...modes.map(([value, label]) => btn(label, () => act('voiceMode', value), { on: m.voiceMode === value }))),
    m.voiceMode === 'ptt' ? h('div.ov-hint', ru ? `Говорите, удерживая ${m.pttName || '?'}` : `Hold ${m.pttName || '?'} to talk`) : null,
    h('div.ov-menu-label', ru ? 'Громкость' : 'Volume'),
    people.length ? h('div.ov-people', people) : h('div.ov-hint', ru ? 'В голосовом пока никого — громкость появится, когда кто-то подключится.' : 'Nobody in voice yet — volumes appear when someone connects.'),
    m.lobby.active ? h('div.ov-menu-row.ov-gap',
      btn(m.lobbyVoice ? (ru ? 'Выйти из голоса лобби' : 'Leave lobby voice') : (ru ? 'Войти в голос лобби' : 'Join lobby voice'), () => act(m.lobbyVoice ? 'leaveVoice' : 'joinVoice'), { ic: m.lobbyVoice ? 'hangup' : 'friends', cls: m.lobbyVoice ? '' : '.accent' })) : null,
  ];
}

function renderChat(m, ru) {
  const key = JSON.stringify(m.chat.map((c) => c.id));
  if (key === lastChat) return;
  lastChat = key;
  const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 30;
  swap(chatLog, m.chat.length ? m.chat.map((c) => h(`div.ov-msg${c.self ? '.self' : ''}`, h('span.ov-msg-name', `${c.name}:`), ' ', h('span.ov-msg-text', c.sticker ? (ru ? '[стикер]' : '[sticker]') : c.text)))
    : h('div.ov-hint', ru ? 'Сообщений пока нет.' : 'No messages yet.'));
  if (atBottom || m.chat[m.chat.length - 1]?.self) chatLog.scrollTop = chatLog.scrollHeight;
}

function chatPanel(m, ru) {
  if (!m.lobby.active) return [h('div.ov-hint', ru ? 'Вы не в лобби. Создайте его или войдите в лаунчере — здесь появится чат.' : 'You are not in a lobby. Create or join one in the launcher.')];
  chatInput.placeholder = ru ? 'Сообщение лобби… (Enter)' : 'Message the lobby… (Enter)';
  lastChat = '';
  renderChat(m, ru);
  setTimeout(() => chatInput.focus(), 30);
  return [chatLog, h('div.ov-menu-row', chatInput, btn('', () => sendChat(), { ic: 'send', cls: '.accent' }))];
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  act('say', text);
}
chatInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') sendChat();
  else if (e.key === 'Escape') send('done');
});

function capturePanel(m, ru) {
  const recording = !!state.rec;
  const replay = m.replay;
  const toggle = (on, label, key, ic) => btn(label, () => send('save', { [key]: !on }), { ic: on ? ic : 'x', on });
  const replayLine = !m.replayOn ? (ru ? 'Повтор выключен — включается в настройках лаунчера.' : 'Instant replay is off — turn it on in the launcher’s settings.')
    : !replay ? (ru ? 'Повтор запустится, как только окно игры будет впереди.' : 'The replay starts once the game’s window is in front.')
    : !replay.ready ? (ru ? 'Повтор запускается…' : 'The replay is starting…')
    : (ru ? `Повтор пишет последние ${replay.seconds} с${m.replayName ? ` · сохранить: ${m.replayName}` : ''}` : `Replay keeps the last ${replay.seconds} s${m.replayName ? ` · save: ${m.replayName}` : ''}`);
  return [
    h('div.ov-menu-row',
      btn(ru ? 'Скриншот' : 'Screenshot', () => act('shot'), { cls: '.big', ic: 'image' }),
      btn(recording ? (ru ? 'Остановить запись' : 'Stop recording') : (ru ? 'Начать запись' : 'Start recording'), () => act('rec'), { cls: recording ? '.big.bad' : '.big.accent', ic: recording ? 'stop' : 'play' })),
    h('div.ov-menu-row',
      btn(ru ? 'Сохранить повтор' : 'Save replay', () => act('replaySave'), { cls: replay?.ready ? '.big.good' : '.big', ic: 'refresh' })),
    h('div.ov-hint', replayLine),
    h('div.ov-menu-label', ru ? 'На видео' : 'In videos'),
    h('div.ov-menu-row',
      toggle(m.audio, ru ? 'Звук игры' : 'Game sound', 'recordAudio', 'volume'),
      toggle(m.mic, ru ? 'Мой голос' : 'My voice', 'recordMic', 'mic'),
      toggle(m.overlayInVideo, ru ? 'Оверлей' : 'Overlay', 'recordOverlay', 'image')),
    h('div.ov-hint', ru ? 'Звук игры — вместе с голосами друзей. Ваш голос попадает в видео, только когда вас слышно в голосовом. Меню оверлея и таймер записи на видео не попадают.' : 'Game sound includes friends’ voices. Your voice gets into videos only while you’re heard in voice chat. The overlay menu and the recording timer never do.'),
    h('div.ov-menu-row.ov-gap',
      btn(ru ? 'Папка скриншотов' : 'Screenshots folder', () => act('folder', 'pictures'), { ic: 'folder' }),
      btn(ru ? 'Папка видео' : 'Videos folder', () => act('folder', 'videos'), { ic: 'folder' })),
  ];
}

// The game settings (both games), as the launcher's own settings: a line a
// setting — its name, a word on it, a switch on the right; under the zoom its
// key and how close (a slider that moves smoothly); VSync's three ways.
let catching = false; // the zoom key: waiting for the one pressed
let menuRu = true;
// the launcher's switch (app.css .toggle): a square knob sliding across
function gameToggle(on) {
  return h(`span.ov-toggle${on ? '.on' : ''}`, h('span.ov-toggle-knob'));
}
function gameRow(title, sub, ...right) {
  return h('div.ov-set-row', h('div.ov-set-text', h('div.ov-set-title', title), sub ? h('div.ov-set-sub', sub) : null), ...right);
}
// a line with a switch: a click anywhere on it switches; the knob moves at once
function switchRow(g, key, title, sub, set) {
  const sw = gameToggle(!!g[key]);
  const row = gameRow(title, sub, sw);
  row.classList.add('click');
  row.addEventListener('click', () => {
    sw.classList.toggle('on', !g[key]);
    set({ [key]: !g[key] });
  });
  return row;
}
function gamePanel(m, ru) {
  menuRu = ru;
  const g = m.game || {};
  const set = (patch) => act('game', patch);
  const b = m.bedrock;
  const notes = [];
  if (b && b.zoom && !['on', 'off'].includes(b.zoom) && g.zoom) notes.push(ru ? 'Bedrock: зум для этой версии игры пока не найден — в Java работает.' : 'Bedrock: the zoom isn’t found for this game version yet — it works in Java.');
  if (b && b.fullbright === false && g.fullbright) notes.push(ru ? 'Bedrock: яркость для этой версии игры недоступна.' : 'Bedrock: brightness isn’t available for this game version.');
  if (b && g.vsync !== 'game' && b.vsync && !['on', 'off'].includes(b.vsync)) notes.push(ru ? 'Bedrock: VSync не удалось переключить.' : 'Bedrock: VSync couldn’t be switched.');

  // the zoom: its switch; under it its key (press to change) and how close
  const level = Math.max(1.5, Math.min(10, Number(g.zoomLevel) || 4));
  const range = h('input.ov-slider', { type: 'range', min: 1.5, max: 10, step: 0.1, value: level });
  const shown = h('span.ov-slider-val');
  const fill = () => {
    range.style.setProperty('--p', `${((Number(range.value) - 1.5) / 8.5) * 100}%`);
    shown.textContent = `${Number(range.value).toFixed(1)}×`;
  };
  fill();
  range.addEventListener('input', fill);
  range.addEventListener('change', () => set({ zoomLevel: Math.round(Number(range.value) * 10) / 10 }));
  const keycap = h(`button.ov-keycap${catching ? '.wait' : ''}`, { type: 'button' }, catching ? '…' : g.keyName || 'C');
  keycap.addEventListener('click', () => { catching = !catching; lastMenu = ''; renderMenu(ru); });
  const zoomRow = switchRow(g, 'zoom', ru ? 'Зум' : 'Zoom',
    catching ? (ru ? 'Нажмите клавишу или боковую кнопку мыши… (Esc — отмена)' : 'Press a key or a side mouse button… (Esc to cancel)')
      : (ru ? 'Держите клавишу — приближает; колесо мыши, пока держите, — ближе или дальше' : 'Hold the key to zoom in; the wheel while holding it goes closer or farther'), set);
  const smooth = gameToggle(g.zoomSmooth !== false);
  const smoothRow = gameRow(ru ? 'Плавный зум' : 'Smooth zoom', ru ? 'Приближение и отдаление плавно; выключите — сразу' : 'Zooms in and out smoothly; off — at once', smooth);
  smoothRow.classList.add('click', 'ov-set-more');
  if (!g.zoom) smoothRow.classList.add('off');
  smoothRow.addEventListener('click', () => {
    smooth.classList.toggle('on', g.zoomSmooth === false);
    set({ zoomSmooth: g.zoomSmooth === false });
  });
  const zoomMore = h(`div.ov-set-row.ov-set-more${g.zoom ? '' : '.off'}`,
    h('span.ov-set-label', ru ? 'Клавиша' : 'Key'), keycap,
    h('span.ov-set-label.gap', ru ? 'Приближение' : 'Zoom level'), range, shown);

  // VSync: three ways
  const ways = [['game', ru ? 'Как в игре' : 'As in game'], ['on', ru ? 'Включён' : 'On'], ['off', ru ? 'Выключен' : 'Off']];
  const seg = h('div.ov-seg', ...ways.map(([v, label]) => {
    const btnEl = h(`button${(g.vsync || 'game') === v ? '.on' : ''}`, { type: 'button' }, label);
    btnEl.addEventListener('click', () => set({ vsync: v }));
    return btnEl;
  }));

  return [
    h('div.ov-set',
      switchRow(g, 'fullbright', ru ? 'Яркость' : 'Fullbright', ru ? 'Светло в пещерах и ночью' : 'Bright in caves and at night', set),
      switchRow(g, 'autoSprint', ru ? 'Автоспринт' : 'Auto sprint', ru ? 'Бег без Ctrl, когда идёте вперёд' : 'Run without Ctrl when going forward', set),
      switchRow(g, 'noFire', ru ? 'Без огня' : 'No fire', ru ? 'Огонь не закрывает экран (в Bedrock — со следующего входа в мир)' : 'Fire doesn’t cover the screen (Bedrock: from the next world you join)', set),
      zoomRow,
      zoomMore,
      smoothRow,
      gameRow('VSync', ru ? 'Без VSync — больше кадров, с ним — без разрывов картинки' : 'Off — more frames; on — no tearing', seg)),
    ...notes.map((n) => h('div.ov-note', icon('warning'), h('span', n))),
  ];
}
// the zoom key: the next key (or a side mouse button) pressed while waiting
function catchKey(code) {
  catching = false;
  lastMenu = '';
  if (code && code !== 'Escape') act('game', { zoomKey: code });
  else renderMenu(menuRu);
}
document.addEventListener('keydown', (e) => {
  if (!catching) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  catchKey(e.code);
}, true);
document.addEventListener('mousedown', (e) => {
  if (!catching || (e.button !== 3 && e.button !== 4)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  catchKey(e.button === 3 ? 'Mouse4' : 'Mouse5');
}, true);

// The week's quests (quests.js): read here, in the menu, only — nothing of
// them is put over the game (a quest done: one short notice in the corner).
function questsPanel(m, ru) {
  const v = m.quests || {};
  if (!v.account) return [h('div.ov-hint', ru ? 'Задания недели появятся, когда войдёте через Xbox в лаунчере.' : 'Weekly quests show up once you sign in with Xbox in the launcher.')];
  if (!(v.quests || []).length) return [h('div.ov-hint', ru ? 'Задания загружаются…' : 'Loading quests…')];
  const left = Math.max(0, v.ends - Date.now());
  const d = Math.floor(left / 86400000);
  const hh = Math.floor((left % 86400000) / 3600000);
  const mm = Math.floor((left % 3600000) / 60000);
  const leftText = d ? (ru ? `${d} д ${hh} ч` : `${d}d ${hh}h`) : (ru ? `${hh} ч ${mm} мин` : `${hh}h ${mm}m`);
  const COLOR = { minutes: '#5fc35a', serverMinutes: '#9a62ff', blocks: '#4b8bff', kills: '#ef5a50', days: '#e4ae39' };
  const amount = (q) => (q.kind === 'minutes' || q.kind === 'serverMinutes'
    ? `${Math.floor(q.progress)} / ${q.goal} ${ru ? 'мин' : 'min'}`
    : q.kind === 'days' ? `${q.progress} / ${q.goal} ${ru ? 'дн.' : 'days'}` : `${Math.floor(q.progress).toLocaleString(ru ? 'ru-RU' : 'en-US')} / ${q.goal.toLocaleString(ru ? 'ru-RU' : 'en-US')}`);
  const n = v.quests.filter((q) => q.claimed).length;
  const r = v.reward || {};
  const status = v.rewardWeek != null
    ? (ru ? 'Все три выполнены — выбери награду в лаунчере: одна из трёх карт' : 'All three done — pick your reward in the launcher: one of three cards')
    : r.state === 'taken'
      ? (ru ? 'Награда недели получена' : 'This week\'s reward is taken')
      : (ru ? `Выполнено ${n} из 3 — за все три выбор из трёх карт: монеты или редкая косметика` : `${n} of 3 done — all three: pick one of three cards, coins or a rare cosmetic`);
  return [
    h('div.ov-menu-label', ru ? `Обновятся через ${leftText}` : `New ones in ${leftText}`),
    ...v.quests.map((q) => h(`div.ov-quest${q.claimed ? '.done' : ''}`, { style: { '--tc': COLOR[q.kind] || '#e4ae39' } },
      h('div.ov-quest-top',
        h('span.ov-quest-name', (ru ? q.title.ru : q.title.en) || q.title.ru),
        q.claimed ? h('span.ov-quest-ok', icon('check')) : null),
      h('div.ov-quest-bar', h('i', { style: { width: `${Math.round(Math.min(1, q.claimed ? 1 : q.progress / Math.max(1, q.goal)) * 100)}%` } })),
      h('div.ov-quest-foot', q.claimed ? (ru ? 'Выполнено' : 'Done') : amount(q)))),
    h(`div.ov-quest-status${v.rewardWeek != null ? '.ready' : ''}`, status),
  ];
}

function renderMenu(ru) {
  const m = state.menu;
  const open = state.mode === 'menu' && m && !framed;
  document.body.classList.toggle('menu', !!open);
  if (!open) {
    if (lastMenu) swap(menu);
    lastMenu = '';
    return;
  }
  const key = JSON.stringify([m.tab, m.micOff, m.deaf, m.voiceMode, m.pttName, m.lobbyVoice, m.lobby, m.audio, m.mic, m.overlayInVideo, m.replay, m.replayOn, m.replayName, !!state.rec, ru, m.game, m.bedrock, m.quests, catching,
    (state.voice?.peers || []).map((p) => [p.id, p.name, p.volume, p.face ? 1 : 0])]);
  if (key !== lastMenu) {
    lastMenu = key;
    const tabs = [['voice', 'mic', ru ? 'Голос' : 'Voice'], ['chat', 'chat', ru ? 'Чат' : 'Chat'], ['capture', 'image', ru ? 'Захват' : 'Capture'], ['game', 'gamepad', ru ? 'Игра' : 'Game'], ['quests', 'star', ru ? 'Задания' : 'Quests']];
    const body = m.tab === 'chat' ? chatPanel(m, ru) : m.tab === 'capture' ? capturePanel(m, ru) : m.tab === 'game' ? gamePanel(m, ru) : m.tab === 'quests' ? questsPanel(m, ru) : voicePanel(m, ru);
    swap(menu,
      h('div.ov-dock',
        h('img.ov-dock-logo', { src: 'mcl://app/assets/icon/app.png', alt: '' }),
        ...tabs.map(([id, ic, label]) => btn(label, () => act('tab', id), { ic, on: m.tab === id, cls: '.tab' })),
        btn('', () => act('edit'), { ic: 'edit', cls: '.tab.icon-only', title: ru ? 'Расположение панелей' : 'Panel layout' }),
        btn('', () => send('done'), { ic: 'x', cls: '.tab.close' })),
      h(`div.ov-panel.${m.tab}`, ...body),
      h('div.ov-menu-foot', ru ? `Esc${state.editName ? ` или ${state.editName}` : ''} — вернуться в игру` : `Esc${state.editName ? ` or ${state.editName}` : ''} — back to the game`));
  } else if (m.tab === 'chat') renderChat(m, ru);
  // who's talking, without rebuilding the sliders being dragged
  const talking = new Set((state.voice?.peers || []).filter((p) => p.speaking).map((p) => p.id));
  for (const el of menu.querySelectorAll('.ov-person')) el.classList.toggle('speaking', talking.has(el.dataset.id));
}

function renderRec(ru) {
  if (!state.rec || !badgeOnly) {
    recBadge.hidden = true;
    return;
  }
  recBadge.hidden = false;
  const secs = Math.max(0, Math.floor((Date.now() - state.rec.since) / 1000));
  recBadge.textContent = `● ${ru ? 'ЗАПИСЬ' : 'REC'} ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}
setInterval(() => state && renderRec(state.ru), 500);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state && state.mode !== 'hud' && !framed) send('done');
});

// The menu, the editor's bar and the recording badge stand in the middle at
// a whole pixel (CSS centring lands on .5 px with an odd width — blurred text).
function centre() {
  if (badgeOnly) return;
  for (const el of [menu, bar, recBadge]) {
    if (!el.offsetWidth) continue;
    el.style.left = `${Math.floor((window.innerWidth - el.offsetWidth) / 2)}px`;
  }
}
window.addEventListener('resize', centre);
new ResizeObserver(centre).observe(document.body);
for (const el of [menu, bar, recBadge]) new ResizeObserver(centre).observe(el);

// ---- state ------------------------------------------------------------------------------------------

function apply(s) {
  state = s;
  const root = document.documentElement;
  if (badgeOnly) {
    document.body.classList.add('badge');
    if (s.accent) root.style.setProperty('--acc', s.accent);
    renderRec(s.ru);
    return;
  }
  document.body.dataset.size = s.size;
  document.body.classList.toggle('editing', !!s.editing);
  document.body.classList.toggle('framed', framed);
  root.style.setProperty('--alpha', String((s.opacity ?? 70) / 100));
  if (s.accent) root.style.setProperty('--acc', s.accent);
  place(voiceBox, s.layout?.voice);
  place(toastBox, s.layout?.toasts);
  voiceBox.dataset.label = s.ru ? 'Голосовой чат' : 'Voice chat';
  toastBox.dataset.label = s.ru ? 'Уведомления' : 'Notifications';
  renderVoice(s.voice, s.ru);
  renderToasts(s.toasts || [], s.ru);
  renderBar(s.ru);
  renderMenu(s.ru);
  renderRec(s.ru);
  centre();
}

if (framed) {
  window.addEventListener('message', (e) => {
    if (e.origin === location.origin && e.data?.source === 'mcl-settings' && e.data.state) apply(e.data.state);
  });
  window.parent.postMessage({ source: 'mcl-overlay', type: 'ready' }, location.origin);
} else window.overlay.listen(apply);
