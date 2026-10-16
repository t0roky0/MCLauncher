'use strict';
// The tray icon — where the launcher lives while the window is closed or
// the game is running. Its menu is a small launcher of its own: open, play
// the selected installation, jump to any installation, see who's online.

const { Tray, Menu, nativeImage } = require('electron');
const paths = require('./paths');
const config = require('./config');

let tray = null;
let handlers = {};
let lastState = {};

const T = {
  ru: {
    open: 'Открыть MC Launcher',
    play: (n) => `Играть: ${n}`,
    installs: 'Установки',
    friends: (n) => (n ? `Друзья в сети: ${n}` : 'Друзья'),
    playing: (n, m) => `${n} — ${m}`,
    console: 'Консоль',
    notifications: 'Уведомления',
    quit: 'Выход',
    inGame: (n) => `В игре: ${n}`,
    busy: (p) => `Загрузка… ${p}%`,
    tip: 'MC Launcher',
    stop: 'Закрыть игру',
  },
  en: {
    open: 'Open MC Launcher',
    play: (n) => `Play: ${n}`,
    installs: 'Installations',
    friends: (n) => (n ? `Friends online: ${n}` : 'Friends'),
    playing: (n, m) => `${n} — ${m}`,
    console: 'Console',
    notifications: 'Notifications',
    quit: 'Quit',
    inGame: (n) => `In game: ${n}`,
    busy: (p) => `Downloading… ${p}%`,
    tip: 'MC Launcher',
    stop: 'Close the game',
  },
};

function strings() {
  return T[config.get().language === 'en' ? 'en' : 'ru'];
}

function icon() {
  const img = nativeImage.createFromPath(paths.asset('icon', 'app.ico'));
  return img.isEmpty() ? nativeImage.createFromPath(paths.asset('icon', 'app.png')).resize({ width: 16, height: 16 }) : img;
}

function create(h) {
  handlers = h;
  tray = new Tray(icon());
  tray.setToolTip('MC Launcher');
  tray.on('click', () => handlers.show());
  tray.on('double-click', () => handlers.show());
  update({});
}

// state: {installs, selectedId, running:[{pid, installName}], task, friends:{online, playing:[{gamertag, minecraft}]}}
function update(state) {
  if (!tray) return;
  lastState = { ...lastState, ...state };
  const s = lastState;
  const t = strings();
  const installs = s.installs || [];
  const selected = installs.find((e) => e.id === s.selectedId) || installs[0];
  const running = s.running || [];
  const friends = s.friends || { online: 0, playing: [] };

  const items = [{ label: t.open, click: () => handlers.show(), type: 'normal' }, { type: 'separator' }];
  if (selected) {
    items.push({
      label: t.play(selected.name),
      enabled: !(s.task && s.task.busy) && !running.some((r) => r.installId === selected.id),
      click: () => handlers.launch(selected.id),
    });
  }
  if (installs.length > 1) {
    items.push({
      label: t.installs,
      submenu: installs.slice(0, 20).map((e) => ({
        label: e.name,
        type: 'radio',
        checked: selected && e.id === selected.id,
        click: () => handlers.launch(e.id),
      })),
    });
  }
  for (const r of running) {
    items.push({ label: `${t.stop}: ${r.installName}`, click: () => handlers.kill(r.pid) });
  }
  items.push({ type: 'separator' });
  const playing = (friends.playing || []).slice(0, 8);
  items.push({
    label: t.friends(friends.online || 0),
    click: () => handlers.navigate('friends'),
    ...(playing.length
      ? { submenu: [{ label: t.friends(friends.online || 0), click: () => handlers.navigate('friends') }, { type: 'separator' }, ...playing.map((p) => ({ label: t.playing(p.gamertag, p.minecraft || p.activity), click: () => handlers.navigate('friends') }))] }
      : {}),
  });
  items.push({ label: t.console, click: () => handlers.console() });
  items.push({ label: t.notifications, type: 'checkbox', checked: config.get().notifications !== false, click: () => handlers.toggleNotifications() });
  items.push({ type: 'separator' }, { label: t.quit, click: () => handlers.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));

  let tip = t.tip;
  if (s.task && s.task.busy) tip += `\n${t.busy(Math.round(((s.task.progress && s.task.progress.fraction) || 0) * 100))}`;
  else if (running.length) tip += `\n${t.inGame(running.map((r) => r.installName).join(', '))}`;
  if (friends.online) tip += `\n${t.friends(friends.online)}`;
  tray.setToolTip(tip);
}

function balloon(title, content) {
  if (!tray || !tray.displayBalloon) return;
  tray.displayBalloon({ iconType: 'none', icon: nativeImage.createFromPath(paths.asset('icon', 'app.png')), title, content });
}

function destroy() {
  if (tray) tray.destroy();
  tray = null;
}

module.exports = { create, update, balloon, destroy };
