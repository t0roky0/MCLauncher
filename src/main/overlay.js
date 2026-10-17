'use strict';
// The in-game overlay: a transparent, click-through window laid over the
// game (Java or Bedrock) while it's in front — who's in voice and who's
// talking, our mic, and launcher news (a friend online, a lobby invite,
// someone came into the lobby, a message) in place of Windows' pop-ups.
//
// Like Discord's or Game Bar's, it draws over windowed and borderless games;
// exclusive fullscreen (Java's F11 on some drivers) can hide it. Nothing is
// injected into the game: the window only follows the game's client area.
//
// Its key (F7 by default) opens the menu over the game, Game Bar style: the
// voice (mic, sound, everyone's volume, how the mic opens), the lobby chat,
// capture (a screenshot, a video with the game's sound) and the layout
// editor. The window takes the mouse only while the menu is open.

const { BrowserWindow, screen, app, ipcMain, desktopCapturer, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const native = require('./native');
const config = require('./config');
const log = require('./log');
const { faceOf } = require('./notify-icons');
const capture = require('./capture');

const TICK_MS = 150;
const MIC_TOAST_MS = 1600;
const MAX_TOASTS = 4;
const DEFAULT_ACCENT = '#4caf50';
// the player's accent, else the default green
const accent = () => {
  const c = config.get().accentColor || '';
  return /^#[0-9a-f]{6}$/i.test(c) ? c : DEFAULT_ACCENT;
};

let win = null;
let ready = false;
let timer = null;
let voice = null; // the page's voice state, as the old voice HUD got it
let voiceAt = 0;
let toasts = [];
let seq = 0;
let lastSent = '';
let lastBounds = '';
let muteTimer = null;
let muteDown = false;
let mode = 'hud'; // 'hud' | 'menu' | 'edit'
let tab = 'voice';
let lastGame = null; // the game's window while the menu has the focus
let keyTimer = null;
const keyDown = { menu: false, shot: false, rec: false, replay: false };
let riding = 0; // the game's pid the window rides on (native WinEvent), 0: moved here

const settings = () => config.get().overlay || {};
const ru = () => config.get().language !== 'en';
const interactive = () => mode !== 'hud';

function isGame(fg) {
  if (!fg || fg.width < 300 || fg.height < 160) return false;
  if (/^Minecraft(?:\.Windows|\.WindowsBeta)?\.exe$/i.test(fg.exe)) return true;
  return require('./game').list().some((g) => g.pid === fg.pid);
}

let front = null; // dev: --overlay-demo stands a window in for the game

// The game window in front, or null.
function gameInFront() {
  if (front) return front();
  const fg = native.foregroundWindow();
  return isGame(fg) ? fg : null;
}

const voiceLive = () => !!(voice && voice.on && Date.now() - voiceAt < 3000);

function wanted() {
  const s = settings();
  if (!s.enabled) return false;
  return interactive() || !!capture.state().recording || (s.voice !== 'off' && voiceLive()) || toasts.length > 0;
}

// Steve's face for anyone without a skin of their own (a letter looked like a bug).
let steve = '';
function steveFace() {
  if (steve) return steve;
  try {
    steve = faceOf(`data:image/png;base64,${fs.readFileSync(require('./paths').asset('images', 'skins', 'steve.png')).toString('base64')}`) || '';
  } catch { /* the letter, then */ }
  return steve;
}

// Our own face: the launcher's skin for the active account.
let own = { key: '', face: '' };
function ownFace() {
  try {
    const id = config.get().activeAccount;
    const local = require('./skins').localSkinFor(id);
    const key = `${id}|${local?.png ? local.png.length : 0}`;
    if (key !== own.key) own = { key, face: local?.png ? faceOf(`data:image/png;base64,${local.png.toString('base64')}`) : '' };
  } catch { /* none */ }
  return own.face;
}

// Faces by member id and by name: party cards and players nearby.
function faces() {
  const out = new Map();
  const add = (m) => {
    const face = m && m.skin ? faceOf(m.skin) : '';
    if (!face) return;
    if (m.id) out.set(m.id, face);
    if (m.name) out.set(`n:${String(m.name).toLowerCase()}`, face);
  };
  try {
    for (const m of require('./party').state().members || []) add(m);
  } catch { /* no party */ }
  try {
    for (const m of require('./nearby').state().members || []) add(m);
  } catch { /* no world */ }
  return out;
}

function voiceView() {
  const s = settings();
  if (!voiceLive() || (s.voice === 'off' && !interactive())) return null;
  const f = faces();
  const face = (p) => f.get(p.id) || f.get(`n:${String(p.name || '').toLowerCase()}`) || steveFace();
  let self = null;
  try {
    const me = (require('./party').state().members || []).find((m) => m.self) || (require('./nearby').state().members || []).find((m) => m.self);
    if (me) self = { name: me.name, face: f.get(me.id) || ownFace() || steveFace() };
  } catch { /* nobody */ }
  if (!self) self = { name: '', face: ownFace() || steveFace() };
  const peers = (voice.peers || [])
    .filter((p) => p && p.state === 'connected')
    .map((p) => ({ id: String(p.id), name: String(p.name || '').slice(0, 32), speaking: !!p.speaking, relay: !!p.relay, volume: Number(p.volume ?? 100), face: face(p) }));
  return {
    self,
    micOff: !!voice.micOff,
    deaf: !!voice.deaf,
    speaking: !!voice.speaking,
    mode: voice.mode || 'vad',
    pttName: voice.pttName || '',
    nearby: voice.channel === 'nearby',
    waiting: voice.channel === 'nearby' && !voice.nearbyReady,
    peers,
  };
}

// The menu's extra: lobby, chat, whether lobby voice is on.
function menuView() {
  if (mode !== 'menu') return null;
  const v = config.get().voice || {};
  let lobby = { active: false };
  let chat = [];
  try {
    const p = require('./party').state();
    lobby = { active: !!p.active, code: p.code || '', members: (p.members || []).length };
    chat = require('./party').chatLog().slice(-40).map((m) => ({ id: m.id, name: m.name, text: m.text, sticker: !!m.sticker, self: !!m.self, at: m.at }));
  } catch { /* no lobby */ }
  return {
    tab,
    micOff: !!v.micOff,
    deaf: !!v.deaf,
    voiceMode: v.mode || 'vad',
    pttName: v.pttName || '',
    lobbyVoice: !!(voice && voice.on && voice.channel === 'party'),
    lobby,
    chat,
    audio: settings().recordAudio !== false,
    mic: !!settings().recordMic,
    overlayInVideo: settings().recordOverlay !== false,
    replay: capture.state().replay,
    replayOn: !!settings().replay,
    replayName: settings().replayName || '',
    // the game settings (both games): config.game, the zoom key's name, and what Bedrock's module says works
    game: { ...(config.get().game || {}), keyName: require('./game-comfort').keyName((config.get().game || {}).zoomKey || 'KeyC') },
    bedrock: require('./bedrock-bridge').comfort(),
    // the week's quests (quests.js): read in the menu only, never put over the game
    quests: require('./quests').view(),
  };
}

function ensureWindow() {
  if (win) return;
  ready = false;
  lastSent = '';
  lastBounds = '';
  win = new BrowserWindow({
    // resizable: Windows lets the C++ module size it to the game's window only
    // then (a fixed-size window only moves); a user's drag can't resize it
    width: 800, height: 450, show: false, frame: false, transparent: true, resizable: true, movable: false,
    minimizable: false, maximizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, '../preload/overlay.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.on('will-resize', (e) => e.preventDefault());
  protect();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.once('did-finish-load', () => {
    ready = true;
    applyMode();
    tick();
  });
  win.on('closed', () => {
    win = null;
    ready = false;
  });
  win.loadURL('mcl://app/overlay.html');
}

// The recording badge ("● REC 1:23") is a window of its own that Windows
// keeps out of every capture: with the overlay in the video, the timer isn't.
let badge = null;
let badgeReady = false;
let badgeSent = '';
let badgeBounds = '';
function updateBadge(fg) {
  const rec = capture.state().recording;
  if (!rec || !fg || settings().enabled === false) {
    if (badge && !badge.isDestroyed() && badge.isVisible()) badge.hide();
    if (!rec && badge) {
      if (!badge.isDestroyed()) badge.destroy();
      badge = null;
    }
    return;
  }
  if (!badge) {
    badgeReady = false;
    badgeSent = '';
    badgeBounds = '';
    badge = new BrowserWindow({
      width: 170, height: 36, show: false, frame: false, transparent: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, fullscreenable: false,
      backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, '../preload/overlay.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    badge.setIgnoreMouseEvents(true);
    badge.setAlwaysOnTop(true, 'screen-saver');
    badge.setContentProtection(true);
    badge.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    badge.webContents.on('will-navigate', (e) => e.preventDefault());
    badge.webContents.once('did-finish-load', () => { badgeReady = true; });
    badge.on('closed', () => { badge = null; });
    badge.loadURL('mcl://app/overlay.html#badge');
  }
  const r = front ? fg : screen.screenToDipRect(null, { x: fg.x, y: fg.y, width: fg.width, height: fg.height });
  const b = { x: Math.round(r.x + (r.width - 170) / 2), y: Math.round(r.y + 8), width: 170, height: 36 };
  const key = JSON.stringify(b);
  if (key !== badgeBounds) {
    badgeBounds = key;
    badge.setBounds(b);
  }
  if (!badgeReady) return;
  const state = { ru: ru(), accent: accent(), rec };
  const text = JSON.stringify(state);
  if (text !== badgeSent) {
    badgeSent = text;
    badge.webContents.send('overlay:state', state);
  }
  if (!badge.isVisible()) badge.showInactive();
}

function close() {
  clearInterval(timer);
  timer = null;
  if (badge && !badge.isDestroyed()) badge.destroy();
  badge = null;
  mode = 'hud';
  if (riding) native.followWindow(null);
  riding = 0;
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  ready = false;
}

// What the page draws: its settings and the live parts.
function pageState() {
  const s = settings();
  const now = Date.now();
  return {
    ru: ru(),
    accent: accent(),
    size: s.size || 'm',
    opacity: s.opacity ?? 70,
    faces: s.faces !== false,
    self: s.self !== false,
    notifications: s.notifications !== false,
    voiceMode: s.voice || 'always',
    layout: s.layout,
    mode,
    editing: mode === 'edit',
    editName: s.editName || '',
    voice: voiceView(),
    menu: menuView(),
    rec: capture.state().recording,
    toasts: toasts.map(({ id, title, text, kind, icon, face, avatar, thumb, at, ms }) => ({ id, title, text, kind, icon, face, avatar, thumb, left: Math.max(0, ms - (now - at)) })),
  };
}

function tick() {
  const now = Date.now();
  toasts = toasts.filter((t) => now - t.at < t.ms);
  if (!wanted()) {
    close();
    return;
  }
  let fg = gameInFront();
  if (interactive() && !front) {
    // the menu has the focus: it stays over the game it was opened on; any
    // other window in front (the game itself too) closes it
    // (a moment's grace while the focus is still coming over)
    const ours = (win && !win.isDestroyed() && win.isFocused()) || Date.now() - menuSince < 600;
    if (ours) fg = fg || lastGame;
    else if (win && ready) {
      mode = 'hud';
      lastSent = '';
      applyMode(false);
    }
  }
  updateBadge(fg && !interactive() ? fg : null);
  if (!fg) {
    if (win && win.isVisible()) win.hide();
    return;
  }
  lastGame = fg;
  ensureWindow();
  // the window rides on the game's own moves (smooth while it's dragged);
  // without the C++ module it follows here, a few times a second
  if (!front && fg.pid && riding !== fg.pid) riding = native.followWindow(win.getNativeWindowHandle(), fg.pid) ? fg.pid : 0;
  const r = front ? fg : screen.screenToDipRect(null, { x: fg.x, y: fg.y, width: fg.width, height: fg.height });
  const bounds = { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
  if (!riding) {
    const key = JSON.stringify(bounds);
    if (key !== lastBounds) {
      lastBounds = key;
      win.setBounds(bounds);
    }
  } else {
    // riding moves it; the size is checked here too (a resized game window)
    const now = win.getBounds();
    if (Math.abs(now.width - bounds.width) > 1 || Math.abs(now.height - bounds.height) > 1) win.setBounds(bounds);
  }
  if (!ready) return;
  const state = pageState();
  const text = JSON.stringify({ ...state, toasts: state.toasts.map((t) => t.id) });
  if (text !== lastSent) {
    lastSent = text;
    win.webContents.send('overlay:state', state);
  }
  if (!win.isVisible()) {
    if (interactive()) win.show();
    else win.showInactive();
  }
}

function run() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}

// ---- the menu and the layout editor ---------------------------------------------------------------

let menuSince = 0;
// giveBack: the keyboard goes back to the game (not when another app took it)
function applyMode(giveBack = true) {
  if (!win || win.isDestroyed()) return;
  protect();
  if (interactive()) {
    // the menu takes the keyboard and mouse: the game lets the cursor go
    win.setFocusable(true);
    win.setIgnoreMouseEvents(false);
    win.show();
    if (!native.focusWindow(win.getNativeWindowHandle())) win.focus();
  } else {
    win.setIgnoreMouseEvents(true);
    win.setFocusable(false);
    win.blur();
    // the keyboard and mouse go back to the game
    if (giveBack && lastGame?.pid) native.focusProcess?.(lastGame.pid);
  }
}

function setMode(next) {
  if (!['hud', 'menu', 'edit'].includes(next) || settings().enabled === false) return;
  if (next === mode) return;
  if (next !== 'hud' && mode === 'hud' && !gameInFront() && !front) return;
  if (next !== 'hud' && mode === 'hud') menuSince = Date.now();
  mode = next;
  lastSent = '';
  if (interactive()) {
    run();
    tick();
  }
  applyMode();
  tick();
}

// The page's layout changes: positions, size, opacity.
function saveFromPage(patch) {
  if (!patch || typeof patch !== 'object') return;
  const s = settings();
  const next = { ...s };
  if (patch.layout && typeof patch.layout === 'object') next.layout = { ...s.layout, ...patch.layout };
  if (['s', 'm', 'l', 'xl'].includes(patch.size)) next.size = patch.size;
  if (Number.isFinite(Number(patch.opacity))) next.opacity = Number(patch.opacity);
  for (const k of ['recordAudio', 'recordMic', 'recordOverlay', 'replay']) if (typeof patch[k] === 'boolean') next[k] = patch[k];
  if (patch.reset) next.layout = undefined;
  config.updateSettings({ overlay: next });
}

// What the menu's buttons do.
function action(name, value) {
  const v = config.get().voice || {};
  switch (name) {
    case 'tab':
      if (['voice', 'chat', 'capture', 'game', 'quests'].includes(value)) tab = value;
      break;
    case 'mic':
      config.updateSettings({ voice: { ...v, micOff: !v.micOff } });
      break;
    case 'deaf':
      config.updateSettings({ voice: { ...v, deaf: !v.deaf } });
      break;
    case 'volume': {
      const name = String(value?.name || '').slice(0, 32);
      const n = Math.max(0, Math.min(100, Math.round(Number(value?.volume))));
      if (name && Number.isFinite(n)) config.updateSettings({ voice: { ...v, volumes: { ...v.volumes, [name]: n } } });
      break;
    }
    case 'voiceMode':
    case 'joinVoice':
    case 'leaveVoice':
      toPage('voice:command', name === 'voiceMode' ? { mode: ['vad', 'ptt', 'open'].includes(value) ? value : 'vad' } : { [name === 'joinVoice' ? 'join' : 'leave']: true });
      break;
    case 'say':
      try {
        require('./party').say({ text: String(value || '').slice(0, 500) });
      } catch (e) {
        toast({ title: e.message, kind: 'warn', icon: 'chat', ms: 2500 });
      }
      break;
    case 'shot':
      screenshot();
      break;
    case 'rec':
      toggleRecording();
      break;
    case 'replaySave':
      saveReplay();
      break;
    case 'folder':
      shell.openPath(value === 'videos' ? capture.videosDir() : captureDir('pictures'));
      break;
    case 'game':
      // a change to the game settings (config sanitizes it: game-comfort.js takes it to both games)
      if (value && typeof value === 'object') config.updateSettings({ game: { ...(config.get().game || {}), ...value } });
      break;
    case 'menu':
    case 'edit':
    case 'hud':
      setMode(name);
      break;
  }
  lastSent = '';
  tick();
}

let toPage = () => {};

ipcMain.on('overlay:save', (e, patch) => {
  if (win && e.sender === win.webContents) saveFromPage(patch);
});
ipcMain.on('overlay:done', (e) => {
  if (win && e.sender === win.webContents) setMode(mode === 'edit' ? 'menu' : 'hud');
});
ipcMain.on('overlay:action', (e, name, value) => {
  if (win && e.sender === win.webContents && typeof name === 'string') action(name, value);
});
// ---- capture: the game's own window, without the overlay ---------------------------------------------

function captureDir(kind) {
  const dir = path.join(app.getPath(kind), 'MC Launcher');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
};

// The game's window among the capturable ones: Java says "Minecraft* 26.3 …", Bedrock "Minecraft".
async function gameSource(size) {
  const list = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: size || { width: 0, height: 0 }, fetchWindowIcons: false });
  const games = list.filter((s) => /^Minecraft(?![\s-]*Launcher)/i.test(s.name) && !/MC Launcher/i.test(s.name));
  return games.find((s) => /^Minecraft\*? \d/.test(s.name)) || games[0] || null;
}

async function screenshot() {
  const g = lastGame || gameInFront();
  try {
    const src = await gameSource(g ? { width: g.width, height: g.height } : { width: 1920, height: 1080 });
    if (!src || src.thumbnail.isEmpty()) throw new Error(ru() ? 'окно игры не найдено' : 'game window not found');
    const file = path.join(captureDir('pictures'), `${stamp()}.png`);
    fs.writeFileSync(file, src.thumbnail.toPNG());
    const thumb = src.thumbnail.resize({ width: 96, quality: 'good' }).toDataURL();
    log.info(`Screenshot: ${file}`);
    toast({ title: ru() ? 'Скриншот сохранён' : 'Screenshot saved', text: ru() ? 'Изображения → MC Launcher' : 'Pictures → MC Launcher', kind: 'info', icon: 'image', thumb, ms: 3500 });
  } catch (e) {
    toast({ title: ru() ? 'Скриншот не получился' : 'Screenshot failed', text: e.message, kind: 'error', icon: 'warning' });
  }
}

// Video: the recorder process (capture.js) films the game's part of the
// screen; the overlay is in it or not (Windows keeps a window out of
// captures on request) — the menu never is.
function gamePid() {
  return gameInFront()?.pid || lastGame?.pid || 0;
}

function toggleRecording() {
  if (capture.state().recording) capture.stopRecording();
  else if (!capture.startRecording(gamePid())) toast({ title: ru() ? 'Запись не началась' : 'Recording didn’t start', text: ru() ? 'Откройте игру' : 'Open the game first', kind: 'error', icon: 'warning' });
  lastSent = '';
}

function saveReplay() {
  if (capture.saveReplay()) return;
  const r = capture.state().replay;
  toast({ title: ru() ? 'Повтор не сохранён' : 'Replay not saved', text: !settings().replay ? (ru() ? 'Повтор выключен в настройках' : 'Instant replay is off in settings') : r && !r.ready ? (ru() ? 'Повтор ещё запускается' : 'The replay is still starting') : (ru() ? 'Повтор ещё не идёт — зайдите в игру' : 'The replay isn’t running yet — go into the game'), kind: 'warn', icon: 'warning', ms: 3000 });
}

const clock = (secs) => `${Math.floor(secs / 60)}:${String(Math.round(secs) % 60).padStart(2, '0')}`;
capture.onEvent((type, p) => {
  if (type === 'saved') {
    toast(p.what === 'replay'
      ? { title: ru() ? 'Повтор сохранён' : 'Replay saved', text: `${clock(p.seconds)} · ${ru() ? 'Видео → MC Launcher' : 'Videos → MC Launcher'}`, kind: 'party', icon: 'refresh', ms: 3500 }
      : { title: ru() ? 'Видео сохранено' : 'Video saved', text: `${clock(p.seconds)} · ${ru() ? 'Видео → MC Launcher' : 'Videos → MC Launcher'}`, kind: 'info', icon: 'download' });
  } else if (type === 'error') {
    toast({ title: p.what === 'replay' ? (ru() ? 'Повтор не сохранён' : 'Replay not saved') : (ru() ? 'Запись остановлена' : 'Recording stopped'), text: p.message, kind: 'error', icon: 'warning' });
  }
  lastSent = '';
  protect();
  if (wanted()) { run(); tick(); }
});

// The overlay in videos (the voice panel, the news) — never the menu.
function protect() {
  if (!win || win.isDestroyed()) return;
  const hide = settings().recordOverlay === false || interactive();
  if (win.mclProtected !== hide) {
    win.setContentProtection(hide);
    win.mclProtected = hide;
  }
}

// The replay follows the game in front (Java or Bedrock).
setInterval(() => capture.watchGame(gameInFront()?.pid || 0), 1500).unref();

// ---- the keys, watched while a game runs ------------------------------------------------------------

function watchKeys() {
  const s = settings();
  const binds = { menu: s.editKey || [], shot: s.shotKey || [], rec: s.recKey || [], replay: s.replayKey || [] };
  const any = Object.values(binds).some((k) => k.length);
  const on = s.enabled !== false && any && native.keysDown([1]) !== null;
  if (!on) {
    clearInterval(keyTimer);
    keyTimer = null;
    return;
  }
  if (keyTimer) return;
  keyTimer = setInterval(() => {
    const now = settings();
    const keys = { menu: now.editKey || [], shot: now.shotKey || [], rec: now.recKey || [], replay: now.replayKey || [] };
    for (const [what, ks] of Object.entries(keys)) {
      const down = ks.length ? !!native.keysDown(ks) : false;
      if (down === keyDown[what]) continue;
      keyDown[what] = down;
      if (!down) continue;
      const inGame = !!gameInFront() || (interactive() && win?.isFocused());
      if (!inGame) continue;
      if (what === 'menu') setMode(mode === 'hud' ? 'menu' : 'hud');
      else if (what === 'shot') screenshot();
      else if (what === 'replay') saveReplay();
      else toggleRecording();
    }
  }, 50);
  keyTimer.unref();
}

// ---- input from the rest of the launcher -----------------------------------------------------

// The page's voice state (what the old voice HUD showed), several times a second.
function setVoice(value) {
  if (!value || typeof value !== 'object') return;
  voice = value;
  voiceAt = Date.now();
  // our voice goes into videos while it goes to the others
  capture.setMic(!!settings().recordMic && !!value.on && !!value.open && !value.micOff && !value.deaf);
  watchMuteKey();
  if (wanted()) run();
}

// News over the game. true: shown there; false: the caller uses Windows'
// own notification (or its window) instead.
function toast({ title = '', text = '', kind = 'info', icon = '', face = '', avatar = '', thumb = '', ms = 0 } = {}) {
  const s = settings();
  if (!s.enabled || s.notifications === false || (!gameInFront() && !interactive())) return false;
  toasts.push({
    id: ++seq,
    at: Date.now(),
    ms: ms || (s.toastSeconds || 6) * 1000,
    title: String(title).slice(0, 80),
    text: String(text).slice(0, 200),
    kind: String(kind).slice(0, 16),
    icon: String(icon).slice(0, 24),
    face: typeof face === 'string' && face.startsWith('data:image/png;base64,') && face.length < 20000 ? face : '',
    avatar: typeof avatar === 'string' && /^https:\/\//.test(avatar) ? avatar : '',
    thumb: typeof thumb === 'string' && thumb.startsWith('data:image/png;base64,') && thumb.length < 80000 ? thumb : '',
  });
  if (toasts.length > MAX_TOASTS) toasts = toasts.slice(-MAX_TOASTS);
  run();
  tick();
  return true;
}

// ---- the mic key: on/off from inside the game ---------------------------------------------------

function watchMuteKey() {
  const keys = config.get().voice?.muteKey || [];
  const on = voiceLive() && keys.length > 0;
  if (!on) {
    clearInterval(muteTimer);
    muteTimer = null;
    muteDown = false;
    return;
  }
  if (muteTimer) return;
  if (native.keysDown(keys) === null) return; // without the C++ module the key isn't seen in the game
  muteTimer = setInterval(() => {
    const ks = config.get().voice?.muteKey || [];
    if (!voiceLive() || !ks.length) {
      clearInterval(muteTimer);
      muteTimer = null;
      return;
    }
    const down = !!native.keysDown(ks);
    if (down === muteDown) return;
    muteDown = down;
    if (!down) return;
    const v = config.get().voice;
    const micOff = !v.micOff;
    config.updateSettings({ voice: { ...v, micOff } });
    toast({ title: micOff ? (ru() ? 'Микрофон выключен' : 'Mic off') : (ru() ? 'Микрофон включён' : 'Mic on'), kind: micOff ? 'muted' : 'mic', icon: micOff ? 'micOff' : 'mic', ms: MIC_TOAST_MS });
  }, 40);
  muteTimer.unref();
}

config.onChange(() => {
  protect();
  watchMuteKey();
  watchKeys();
  if (!settings().enabled) close();
  else if (wanted()) {
    lastSent = '';
    run();
    tick();
  }
});
app.whenReady().then(watchKeys);
app.once('before-quit', () => {
  close();
});

// Dev aid: `--capture=x.png --overlay-demo=y.png` lays the overlay over the
// launcher's own window as if it were the game, with sample voice and news,
// and saves what the overlay window draws (`--overlay-edit` in the layout
// editor, `--overlay-menu=<tab>` with the menu open).
function demo(stand, file, { edit = false, menu = '' } = {}) {
  front = () => {
    if (!stand || stand.isDestroyed()) return null;
    const b = stand.getContentBounds();
    return { pid: 0, exe: 'demo', x: b.x, y: b.y, width: b.width, height: b.height };
  };
  setVoice({ on: true, channel: 'nearby', nearbyReady: true, speaking: true, micOff: false, deaf: false, mode: 'vad', peers: [
    { id: 'a', name: 'FriendOne', state: 'connected', speaking: true, volume: 100 },
    { id: 'b', name: 'Zobis_228', state: 'connected', speaking: false, volume: 60 },
  ] });
  setInterval(() => { voiceAt = Date.now(); }, 500).unref();
  toast({ title: 'FriendOne', text: ru() ? 'зашёл в лобби' : 'joined the lobby', kind: 'party', icon: 'userPlus', ms: 20000 });
  toast({ title: ru() ? 'Микрофон выключен' : 'Mic off', kind: 'muted', icon: 'micOff', ms: 20000 });
  if (edit) setTimeout(() => setMode('edit'), 800);
  if (menu) setTimeout(() => { tab = menu; setMode('menu'); }, 800);
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(file, img.toPNG());
      log.info(`Overlay demo: ${win.getBounds().width}x${win.getBounds().height}, mode ${mode} → ${file}`);
    } catch (e) {
      log.error(`Overlay demo: ${e.message}`);
    }
  }, 3000);
}

module.exports = {
  init(o) {
    toPage = o.toPage || toPage;
  },
  setVoice,
  toast,
  gameInFront,
  close,
  demo,
  setMode,
  recording: () => !!capture.state().recording,
  // the overlay's page may capture the game (permission checks)
  isOverlay: (wc) => !!(win && !win.isDestroyed() && wc === win.webContents),
};
