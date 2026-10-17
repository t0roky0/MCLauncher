'use strict';
// MC Launcher — main process entry.
//
// Owns the windows (frameless main window + console window), the tray, and
// the wiring between the services (installs, game, friends, …) and the UI.
// Closing the window keeps the launcher in the tray (Settings → "Сворачивать
// в трей"); launching the game hides it there and the game exiting brings it
// back, as v1 did.

const { app, BrowserWindow, nativeTheme, screen, shell, Menu, Notification, session } = require('electron');
const path = require('path');
const fs = require('fs');
const paths = require('./paths');
const { fitBounds } = require('./window-bounds');
const protocol = require('./protocol');

app.setPath('userData', paths.chromiumDir);
app.setAppUserModelId('com.mclauncher.app');
protocol.registerPrivileges();
Menu.setApplicationMenu(null);
// Screenshot runs put the window off-screen; without this Chromium treats
// it as occluded and stops painting new frames.
if (process.argv.some((a) => a.startsWith('--capture=') || a.startsWith('--snap='))) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

// Dev aid: a synthetic microphone for testing the party voice chat.
if (process.env.MCL_FAKE_MEDIA) app.commandLine.appendSwitch('use-fake-device-for-media-stream');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  const log = require('./log');
  log.init();
  const config = require('./config');
  const native = require('./native');
  const installs = require('./installs');
  const versions = require('./versions');
  const game = require('./game');
  const friends = require('./friends');
  const bedrock = require('./bedrock');
  const party = require('./party');
  const tray = require('./tray');
  const ipc = require('./ipc');

  const argv = process.argv.slice(1);
  const arg = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const startHidden = argv.includes('--hidden');
  const testLaunch = arg('test-launch');
  const capturePath = arg('capture') || (testLaunch ? arg('snap') : null);
  const capturePage = arg('page');
  const devTools = argv.includes('--devtools');

  let mainWin = null;
  let consoleWin = null;
  let quitting = false;
  let hiddenForGame = false;
  let saveTimer = null;
  let logQueue = [];
  let logTimer = null;

  const preload = path.join(__dirname, '..', 'preload', 'preload.js');
  const appIcon = paths.asset('icon', 'app.ico');

  // Push-to-talk for the party voice chat: the key is watched here (the C++
  // module reads it whatever window has focus — usually the game) and the
  // renderer hears only when it goes down or up.
  let pttTimer = null;
  let pttDown = false;
  function watchPtt(vks) {
    clearInterval(pttTimer);
    pttTimer = null;
    pttDown = false;
    if (!vks.length) return { native: true };
    if (native.keysDown(vks) === null) return { native: false };
    pttTimer = setInterval(() => {
      const down = !!native.keysDown(vks);
      if (down === pttDown) return;
      pttDown = down;
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('voice:ptt', { down });
    }, 20);
    return { native: true };
  }

  // mclauncher://party/ABCD-EF23 — an invitation, from a link or a shortcut.
  let pendingInvite = '';
  function inviteFrom(argv) {
    const link = (argv || []).find((a) => /^mclauncher:\/\//i.test(String(a)));
    const m = link && /party\/([A-Za-z0-9-]+)/i.exec(link);
    return m ? party.normalize(m[1]) || '' : '';
  }
  pendingInvite = inviteFrom(process.argv);
  // mclauncher://redeem/MCL-XXXX-XXXX-XXXX — a code from the site: Settings →
  // Activation code, filled in (activated there, by the player's own click)
  let pendingRedeem = '';
  function redeemFrom(argv) {
    const link = (argv || []).find((a) => /^mclauncher:\/\//i.test(String(a)));
    const m = link && /redeem\/([A-Za-z0-9-]{4,32})/i.exec(link);
    return m ? m[1].toUpperCase() : '';
  }
  pendingRedeem = redeemFrom(process.argv);
  if (app.isPackaged) app.setAsDefaultProtocolClient('mclauncher');

  function send(channel, payload) {
    for (const w of [mainWin, consoleWin]) {
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    }
  }

  function fitOnScreen(state, defW, defH) {
    const s = state || {};
    const display = Number.isFinite(s.x) && Number.isFinite(s.y)
      ? screen.getDisplayMatching({x:s.x,y:s.y,width:Math.max(1,s.width||defW),height:Math.max(1,s.height||defH)})
      : screen.getPrimaryDisplay();
    return fitBounds(s,display.workArea,defW,defH);
  }

  function secureContents(win) {
    // Renderer errors end up in the launcher log (and the console window),
    // so a broken page is diagnosable without DevTools.
    win.webContents.on('console-message', (e) => {
      const level = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : null;
      if (level || capturePath) log[level || 'info'](`[ui] ${e.message}${e.sourceId ? ` (${String(e.sourceId).split('/').pop()}:${e.lineNumber})` : ''}`);
    });
    win.webContents.on('render-process-gone', (e, d) => log.error(`[ui] renderer gone: ${d.reason}`));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('mcl://app/')) {
        e.preventDefault();
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      }
    });
  }

  function createMain() {
    const cfg = config.get();
    // Screenshot runs open off-screen so they don't get in the way (or
    // under the mouse) of whoever is using the PC.
    const [cw, chh] = (arg('size') || '1140x800').split('x').map(Number);
    const initialBounds = fitOnScreen(cfg.windowState, 1261, 860);
    const bounds = capturePath ? { x: -4000, y: 40, width: cw || 1261, height: chh || 860 } : require('./window-bounds').fixedMainBounds(cfg.windowState, screen.getDisplayMatching(initialBounds).workArea);
    mainWin = new BrowserWindow({
      ...bounds,
      skipTaskbar: !!capturePath,
      minWidth: bounds.width,
      minHeight: bounds.height,
      maxWidth: bounds.width,
      maxHeight: bounds.height,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      show: false,
      title: 'MC Launcher',
      icon: appIcon,
      backgroundColor: '#141313',
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    secureContents(mainWin);
    mainWin.loadURL('mcl://app/index.html');
    mainWin.once('ready-to-show', () => {
      if (!startHidden || capturePath) mainWin.show();
      if (devTools) mainWin.webContents.openDevTools({ mode: 'detach' });
      if (capturePath && capturePage === 'console') openConsole();
      else if (capturePath) runCapture();
    });
    const persist = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!mainWin || mainWin.isDestroyed() || mainWin.isMinimized()) return;
        const maximized = mainWin.isMaximized();
        const b = maximized ? (config.get().windowState || {}) : mainWin.getBounds();
        config.mutate((c) => (c.windowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized }), { silent: true });
      }, 400);
    };
    // the lobby stops drawing while nobody can see it
    const visible = (v) => () => !mainWin.isDestroyed() && mainWin.webContents.send('win:visible', v);
    mainWin.on('hide', visible(false));
    mainWin.on('minimize', visible(false));
    mainWin.on('show', visible(true));
    mainWin.on('restore', visible(true));
    // a message counts as read only while its chat is really in front
    const messenger = require('./messenger');
    mainWin.on('focus', () => messenger.setFocus(true));
    mainWin.on('blur', () => messenger.setFocus(false));
    mainWin.on('hide', () => messenger.setFocus(false));
    mainWin.on('minimize', () => messenger.setFocus(false));
    mainWin.on('resize', persist);
    mainWin.on('move', persist);
    mainWin.on('maximize', () => {
      persist();
      send('win:maximized', true);
    });
    mainWin.on('unmaximize', () => {
      persist();
      send('win:maximized', false);
    });
    const vis = () => friends.setVisibility({ visible: mainWin && mainWin.isVisible() && !mainWin.isMinimized() });
    for (const ev of ['show', 'hide', 'minimize', 'restore']) mainWin.on(ev, vis);
    mainWin.on('close', (e) => {
      if (quitting || capturePath) return;
      if (config.get().closeToTray) {
        e.preventDefault();
        mainWin.hide();
        hintTrayOnce();
      } else if (game.list().length) {
        // A game still running keeps the launcher alive in the tray, so
        // its log and exit are still seen.
        e.preventDefault();
        mainWin.hide();
      }
    });
    mainWin.on('closed', () => {
      mainWin = null;
      if (!quitting && !config.get().closeToTray && !game.list().length) quit();
    });
  }

  function hintTrayOnce() {
    if (config.get().trayHintShown || config.get().notifications === false) return;
    config.mutate((c) => (c.trayHintShown = true), { silent: true });
    const ru = config.get().language !== 'en';
    tray.balloon('MC Launcher', ru ? 'Лаунчер продолжает работать в трее. Нажмите на иконку, чтобы открыть.' : 'The launcher keeps running in the tray. Click the icon to open it.');
  }

  function showMain() {
    if (!mainWin || mainWin.isDestroyed()) createMain();
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }

  function openConsole({ background = false } = {}) {
    if (consoleWin && !consoleWin.isDestroyed()) {
      if (!background) {
        if (consoleWin.isMinimized()) consoleWin.restore();
        consoleWin.show();
        consoleWin.focus();
      }
      return;
    }
    const cfg = config.get();
    const st = cfg.consoleWindowState || {};
    consoleWin = new BrowserWindow({
      width: st.width || 900,
      height: st.height || 560,
      x: capturePath ? -4000 : st.x,
      y: capturePath ? 900 : st.y,
      skipTaskbar: !!capturePath,
      minWidth: 560,
      minHeight: 320,
      frame: false,
      show: false,
      title: 'MC Launcher — Консоль',
      icon: appIcon,
      backgroundColor: '#100f0f',
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    secureContents(consoleWin);
    consoleWin.loadURL('mcl://app/console.html');
    consoleWin.once('ready-to-show', () => {
      if (background) consoleWin.showInactive();
      else consoleWin.show();
      if (capturePath && capturePage === 'console') runCapture(consoleWin);
    });
    const persist = () => {
      if (!consoleWin || consoleWin.isDestroyed() || consoleWin.isMinimized() || consoleWin.isMaximized()) return;
      const b = consoleWin.getBounds();
      config.mutate((c) => (c.consoleWindowState = b), { silent: true });
    };
    consoleWin.on('resize', persist);
    consoleWin.on('move', persist);
    consoleWin.on('closed', () => {
      consoleWin = null;
    });
  }

  function quit() {
    quitting = true;
    tray.destroy();
    app.quit();
  }

  function applyAutostart() {
    try {
      app.setLoginItemSettings({ openAtLogin: !!config.get().autostart, args: ['--hidden'] });
    } catch (e) {
      log.warn(`Autostart: ${e.message}`);
    }
  }

  function trayState() {
    const f = friends.getState();
    return {
      installs: installs.allEntries(),
      selectedId: config.get().selectedInstall,
      running: game.list(),
      task: installs.taskView(),
      friends: {
        online: f.status === 'ok' ? f.online : 0,
        playing: f.friends.filter((p) => p.minecraft || (p.state !== 'offline' && p.activity)).slice(0, 8),
      },
    };
  }

  function refreshTray() {
    tray.update(trayState());
  }

  function navigate(page, params) {
    showMain();
    send('nav', params ? { page, params } : page);
  }

  // look: {icon, kind} or {avatar, icon, kind} — a picture per kind of news
  // (notify-icons.js) instead of the app icon on every one
  // With the game in front, the in-game overlay shows it instead (look.overlay:
  // false keeps a pop-up for news that needs a click; look.overlayText: the
  // wording for the overlay, where nothing can be clicked).
  async function notify(title, body, onClick, look) {
    if (config.get().notifications === false) return;
    if (look?.overlay !== false && require('./overlay').toast({ title, text: look?.overlayText || body, ...look })) return;
    if (!Notification.isSupported()) return;
    const icon = await require('./notify-icons').picture(look);
    const n = new Notification({ title, body, icon });
    if (onClick) n.on('click', onClick);
    n.show();
  }

  // Dev aid: `electron . --capture=out.png --page=friends` renders a page
  // and writes a screenshot, which is how the UI was checked during work.
  // --emit='[["notice",{…}],…]' sends those events to the page first (toasts).
  function runCapture(win = mainWin) {
    const delay = Number(arg('delay')) || 2200;
    if (arg('overlay-demo') && win === mainWin) require('./overlay').demo(mainWin, arg('overlay-demo'), { edit: argv.includes('--overlay-edit'), menu: arg('overlay-menu') || '' });
    // --params='{…}': the page's own parameters (e.g. a friend's conversation)
    const pageParams = arg('params');
    if (capturePage && capturePage !== 'console' && win === mainWin) setTimeout(() => send('nav', pageParams ? { page: capturePage, params: JSON.parse(pageParams) } : capturePage), 600);
    if (arg('emit')) {
      setTimeout(() => {
        try {
          for (const [channel, payload] of JSON.parse(arg('emit'))) send(channel, payload);
        } catch (e) {
          log.error(`emit: ${e.message}`);
        }
      }, Math.max(800, delay - 900));
    }
    setTimeout(async () => {
      try {
        const evalJs = arg('eval');
        if (evalJs) {
          log.info(`eval: ${JSON.stringify(await win.webContents.executeJavaScript(evalJs))}`);
          await new Promise((r) => setTimeout(r, 700));
        }
        win.webContents.invalidate();
        await new Promise((r) => setTimeout(r, 120));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(capturePath, img.toPNG());
        log.info(`Captured ${capturePath}`);
        for (const m of app.getAppMetrics()) {
          log.info(`metrics ${m.type}${m.name ? `/${m.name}` : ''}: cpu ${m.cpu.percentCPUUsage.toFixed(1)}%, mem ${Math.round(m.memory.workingSetSize / 1024)} MB`);
        }
      } catch (e) {
        log.error(`Capture failed: ${e.message}`);
      }
      if (!testLaunch) quit();
    }, delay);
  }

  // Dev aid: `--test-launch=<installId> [--snap=out.png --delay=ms]` installs
  // and starts that installation with the active account, logs everything,
  // and closes the game a few seconds after it reaches the main menu
  // (--hold=ms: that long instead; --server=host:port: straight onto it).
  function runTestLaunch() {
    log.info(`test-launch: ${testLaunch}`);
    setTimeout(() => {
      try {
        installs.start(testLaunch, { server: arg('server') || '' });
      } catch (e) {
        log.error(`test-launch: ${e.message}`);
        quit();
      }
    }, 1500);
    let lastStage = '';
    installs.onEvent((type, p) => {
      if (type === 'task' && p.busy) {
        const s = `${p.phase}/${p.progress ? p.progress.stage : ''}`;
        if (s !== lastStage) {
          lastStage = s;
          log.info(`test-launch stage: ${s}`);
        }
      }
      if (type === 'error' || type === 'cancelled') {
        log.error(`test-launch ${type}: ${p.message || ''}`);
        setTimeout(quit, 800);
      }
    });
    game.onEvent((type, p) => {
      if (type === 'ready') {
        log.info('test-launch: game reached the main menu');
        setTimeout(() => game.kill(p.pid), Number(arg('hold')) || 4000);
      } else if (type === 'stats') {
        log.info(`test-launch stats: ${p.memMB} MB, cpu ${p.cpu}%`);
      } else if (type === 'exited') {
        log.info(`test-launch: exited code=${p.code} crashed=${p.crashed}`);
        setTimeout(quit, 1000);
      }
    });
    setTimeout(() => {
      log.warn('test-launch: timeout');
      for (const g of game.list()) game.kill(g.pid);
      setTimeout(quit, 1500);
    }, 300000);
  }

  app.on('second-instance', (e, argv) => {
    showMain();
    const code = inviteFrom(argv);
    if (code) send('party:invite', code);
    const redeem = redeemFrom(argv);
    if (redeem) send('cosmetics:redeemLink', redeem);
  });
  app.on('before-quit', () => {
    quitting = true;
    require('./updater').onQuit();
    require('./bedrock-bridge').stop();
    party.leave(); // friends see us go now, not when we stop beating
    require('./messenger').flush();
    require('./cosmetics').flush();
    require('./quests').flush();
    require('./profiles').flush();
    require('./discord').shutdown();
  });
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });

  // Permissions: the launcher's own pages get the microphone (party voice
  // chat — audio only), output-device choice and the clipboard; everything
  // else, and every other page (the Microsoft sign-in window), gets nothing.
  function lockPermissions(ses) {
    const ours = (url) => String(url || '').startsWith('mcl://app/');
    const ALLOWED = new Set(['media', 'speaker-selection', 'clipboard-sanitized-write']);
    ses.setPermissionRequestHandler((wc, permission, done, details) => {
      const audioOnly = permission !== 'media' || !(details.mediaTypes || []).includes('video');
      done(ALLOWED.has(permission) && audioOnly && ours(details.requestingUrl || (wc && wc.getURL())));
    });
    ses.setPermissionCheckHandler((wc, permission, origin) => ALLOWED.has(permission) && ours(`${origin}/`.replace(/\/\/$/, '/')));
  }

  app.whenReady().then(() => {
    lockPermissions(session.defaultSession);
    lockPermissions(session.fromPartition('msauth'));
    nativeTheme.themeSource = 'dark';
    config.load();
    require('./hygiene').cleanup(config);
    // installed on another drive: the game's files go there too
    const gameDirStart = require('./gamedir').check();
    native.load();
    protocol.register();
    installs.refreshDefaultEntry();
    log.info(`MC Launcher v${app.getVersion()} (Electron ${process.versions.electron}) started.`);

    ipc.register({
      getMain: () => mainWin,
      showMain,
      openConsole,
      quit,
      applyAutostart,
      refreshTray,
      // an invitation that started the app, picked up once the window is up
      watchPtt,
      keepAlive: (on) => {
        if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.setBackgroundThrottling(!on && !party.state().active);
        return true;
      },
      takeInvite: () => {
        const c = pendingInvite;
        pendingInvite = '';
        return c;
      },
      takeRedeem: () => {
        const c = pendingRedeem;
        pendingRedeem = '';
        return c;
      },
    });
    require('./nearby').onEvent((type, payload) => {
      if (type === 'changed' || type === 'signal') send('nearby:' + type, payload);
      else if (type === 'sample') {
        require('./cosmetics').sample(payload);
        require('./profiles').sample(payload);
        // Bedrock tells us our in-game name: the cosmetics pack puts ours on it
        if (payload.edition === 'bedrock' && payload.name && payload.name !== config.get().bedrockName) {
          config.mutate((c) => { c.bedrockName = payload.name; }, { silent: true });
          syncBedrockCosmetics();
        }
      }
    });
    // Bedrock: the cosmetics (in the game's own files, through the module)
    // follow who wears what (you, the party, launcher users nearby) — a
    // moment after the last change; the game shows it on the next world joined
    let bedrockCosTimer = null;
    const cosmeticWearers = () => {
      const cfg = config.get();
      const cos = require('./cosmetics');
      const { keyOf } = require('./account-session');
      const xuid = require('./bedrock').signedInXuid() || '';
      // our names in Bedrock: the Xbox accounts' gamertags, each with what that account wears,
      // and the one the game itself showed last, with what the account signed in there wears
      const out = (cfg.accounts || []).filter((a) => a.type === 'xbox' || a.id === cfg.activeAccount || (xuid && a.xuid === xuid)).map((a) => ({ name: a.gamertag || a.name, cos: cos.worn(keyOf(a) || cos.account()) }));
      const signed = (cfg.accounts || []).find((a) => xuid && a.xuid === xuid);
      if (cfg.bedrockName) out.push({ name: cfg.bedrockName, cos: cos.worn((signed && keyOf(signed)) || cos.account()) });
      const p = party.state();
      for (const m of [...((p.active && p.members) || []), ...(require('./nearby').state().members || [])]) if (!m.self) out.push({ name: m.name, cos: m.cos || [] });
      return out;
    };
    require('./bedrock-cosmetics').setWearers(cosmeticWearers);
    function syncBedrockCosmetics() {
      // a test run (MCL_DATA_DIR) leaves the real game alone
      if (process.env.MCL_DATA_DIR) return;
      clearTimeout(bedrockCosTimer);
      bedrockCosTimer = setTimeout(async () => {
        try {
          await require('./bedrock-cosmetics').sync(cosmeticWearers());
        } catch (e) {
          log.warn(`Bedrock cosmetics: ${e.message}`);
        }
      }, 1500);
    }
    party.onEvent((type) => { if (type === 'changed' || type === 'ended') syncBedrockCosmetics(); });
    require('./nearby').onEvent((type) => { if (type === 'cosmetics') syncBedrockCosmetics(); });
    // cosmetics: event quests — a new item is news, in the window, over the game or from Windows
    const cosmetics = require('./cosmetics');
    cosmetics.onEvent((type, payload) => {
      if (type === 'changed') {
        send('cosmetics:changed', payload);
        if (party.state().active) party.updateMe({ cos: cosmetics.worn() });
        require('./game-skins').refresh();
        syncBedrockCosmetics();
      } else if (type === 'granted') {
        const ru = config.get().language !== 'en';
        const title = ru ? 'Задание выполнено — забери награду' : 'Quest done — claim your reward';
        const text = `${ru ? payload.name : payload.nameEn || payload.name} — ${(payload.title && (ru ? payload.title.ru : payload.title.en)) || ''}`;
        if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && mainWin.isFocused()) send('toast', { kind: 'party', icon: 'sparkle', text: `${title} ${text}`, timeout: 9000 });
        else notify(title, text, () => navigate('skins'), { icon: 'sparkle', kind: 'party' });
      }
    });
    // each Xbox account its own cosmetics and coins: the active one's, and again when it changes
    const accountKey = () => require('./account-session').keyOf(require('./auth').activeAccount()) || 'local';
    let cosmeticsAccount = accountKey();
    const profiles = require('./profiles');
    cosmetics.setAccount(cosmeticsAccount);
    profiles.setAccount(cosmeticsAccount);
    cosmetics.init();
    // the week's quests: to the window; a quest done — its coins, a short word (over the game: small, it goes by itself)
    const quests = require('./quests');
    quests.onEvent((type, payload) => {
      if (type === 'changed') {
        send('quests:changed', payload);
        send('shop:changed', require('./shop').state());
      }
      if (type !== 'claimed') return;
      send('quests:claimed', payload);
      const ru = config.get().language !== 'en';
      const title = payload.ready
        ? (ru ? 'Все задания недели выполнены!' : 'All weekly quests done!')
        : (ru ? `Задание недели выполнено · ${payload.count}/3` : `Weekly quest done · ${payload.count}/3`);
      const text = payload.ready
        ? (ru ? 'Выбери награду в лаунчере — одна из трёх карт' : 'Pick your reward in the launcher — one of three cards')
        : (payload.title && (ru ? payload.title.ru : payload.title.en)) || '';
      if (require('./overlay').toast({ title, text, icon: 'star', kind: 'quest', ms: payload.ready ? 6000 : 3500 })) return;
      if (!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible())) notify(title, text, () => navigate('home'), { icon: 'star', kind: 'quest', overlay: false });
    });
    quests.start();
    // the profile: to the window when it changes; to our server (friends) when what it shows does
    profiles.onEvent((type, payload) => { if (type === 'changed') send('profile:changed', payload); });
    cosmetics.onEvent((type) => { if (type === 'changed') profiles.push(); });
    let profileName = '';
    config.onChange(() => {
      const acc = require('./auth').activeAccount();
      const name = acc ? `${acc.id}|${acc.javaNick || acc.name}` : '';
      if (name !== profileName) {
        profileName = name;
        profiles.push(true);
      }
      const key = accountKey();
      if (key === cosmeticsAccount) return;
      cosmeticsAccount = key;
      cosmetics.setAccount(key);
      profiles.setAccount(key);
      require('./quests').refresh();
      require('./shop').refresh().then((state) => send('shop:changed', state)).catch(() => {});
    });
    profiles.push();
    syncBedrockCosmetics();
    // the in-game menu's voice buttons go to the page that runs the voice
    require('./overlay').init({ toPage: (channel, payload) => mainWin && !mainWin.isDestroyed() && mainWin.webContents.send(channel, payload) });
    createMain();
    if (!capturePath) require('./bedrock-bridge').start();
    // the shop: what's bought and the coins, fresh from our server; a payment's end for the window
    const shop = require('./shop');
    shop.onPaid((p) => send('shop:paid', p));
    if (!capturePath || process.env.MCL_DATA_DIR) shop.start();
    // new versions from our server: fetched in the background, put in on the way out
    if (!capturePath) require('./updater').start({ notify: (event, payload) => send(event, payload) });
    if (gameDirStart && gameDirStart.switched) {
      const ru = config.get().language !== 'en';
      setTimeout(() => send('toast', { kind: 'info', text: ru ? `Игра будет скачиваться на диск лаунчера: ${gameDirStart.switched}` : `Game files go to the launcher's drive: ${gameDirStart.switched}` }), 2500);
    }

    if (!capturePath) tray.create({
      show: showMain,
      launch: (id) => {
        Promise.resolve()
          .then(() => installs.start(id, {}))
          .catch((e) => notify('MC Launcher', e.message, null, { icon: 'warning', kind: 'error' }));
      },
      kill: (pid) => game.kill(pid),
      navigate,
      console: () => openConsole(),
      toggleNotifications: () => config.updateSettings({ notifications: config.get().notifications === false }),
      quit,
    });

    config.onChange((view) => {
      send('config:changed', view);
      refreshTray();
      // the overlay's game settings: into both games (Java through its data file, Bedrock comfort.ini)
      require('./game-comfort').apply();
    });
    // Bedrock reads its settings at its start: there before it, with the field of view it was last left at
    if (!capturePath && !process.env.MCL_DATA_DIR) require('./game-comfort').apply(true);

    installs.onEvent((type, payload) => {
      if (type === 'task') {
        send('task', payload);
        if (mainWin && !mainWin.isDestroyed()) {
          const f = payload.busy && payload.progress ? payload.progress.fraction : payload.busy ? 2 : -1;
          mainWin.setProgressBar(f, { mode: payload.cancelling ? 'paused' : 'normal' });
        }
        refreshTray();
      } else if (type === 'changed') {
        send('installs:changed');
        refreshTray();
      } else if (type === 'done') {
        send('task:done', payload);
      } else if (type === 'error') {
        send('task:error', payload);
        if (!mainWin || !mainWin.isVisible()) notify('MC Launcher', payload.message, showMain, { icon: 'warning', kind: 'error' });
      } else if (type === 'cancelled') {
        send('task:cancelled', payload);
      }
    });

    game.onEvent((type, payload) => {
      send('game', { type, ...payload });
      const cfg = config.get();
      if (type === 'started') {
        if (cfg.showConsole) openConsole({ background: true });
        if (cfg.hideOnLaunch && mainWin && mainWin.isVisible()) {
          hiddenForGame = true;
          mainWin.hide();
        }
        refreshTray();
      } else if (type === 'exited') {
        refreshTray();
        require('./cosmetics').gameStopped(payload.pid);
        require('./profiles').gameStopped(payload.pid);
        const ru = cfg.language !== 'en';
        if (payload.crashed) {
          openConsole();
          notify(ru ? 'Minecraft вылетел' : 'Minecraft crashed', ru ? `${payload.installName}: код выхода ${payload.code}. Подробности — в консоли.` : `${payload.installName}: exit code ${payload.code}. See the console.`, () => openConsole(), { icon: 'warning', kind: 'error' });
        }
        if (hiddenForGame && !game.list().length) {
          hiddenForGame = false;
          showMain();
        }
      }
    });

    // Bedrock runs outside the launcher; its watcher reports start and exit
    // the same way a Java game does.
    bedrock.onEvent((type, payload) => {
      send('game', { type, ...payload });
      send('installs:changed');
      if (type === 'installed') {
        const ru = config.get().language !== 'en';
        send('toast', { kind: 'ok', icon: 'block', text: ru ? `Minecraft Bedrock ${payload.version} ${payload.updated ? 'обновлён' : 'установлен'}.` : `Minecraft Bedrock ${payload.version} ${payload.updated ? 'updated' : 'installed'}.` });
      }
      const cfg = config.get();
      if (type === 'started' && cfg.hideOnLaunch && mainWin && mainWin.isVisible()) {
        hiddenForGame = true;
        mainWin.hide();
      } else if (type === 'exited' && hiddenForGame && !game.list().length) {
        hiddenForGame = false;
        showMain();
      }
      refreshTray();
    });

    // Playing together: the ready check, the start and the leader's world
    // (party-game.js); the tunnel's TCP ends talk to the main window's page.
    require('./party-game').init({ send, notify });
    require('./tunnel').init((channel, payload) => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
    });
    let lobbyMembers = new Map(); // id → name, for "came into / left the lobby" over the game
    let lobbyCode = ''; // the lobby those are of: the ones already there when we come in aren't news
    party.onEvent((type, payload) => {
      if (type === 'changed') {
        const now = new Map((payload.members || []).filter((m) => !m.self).map((m) => [m.id, m]));
        const known = payload.active && !payload.waiting && lobbyCode === payload.code;
        if (payload.active && !payload.waiting) lobbyCode = payload.code;
        else if (!payload.active) lobbyCode = '';
        if (known) {
          const ru = config.get().language !== 'en';
          const { faceOf } = require('./notify-icons');
          for (const [id, m] of now) if (!lobbyMembers.has(id)) require('./overlay').toast({ title: m.name, text: ru ? 'зашёл в лобби' : 'joined the lobby', kind: 'party', icon: 'userPlus', face: faceOf(m.skin) });
          for (const [id, name] of lobbyMembers) if (!now.has(id)) require('./overlay').toast({ title: name, text: ru ? 'вышел из лобби' : 'left the lobby', kind: 'left', icon: 'userMinus' });
        }
        lobbyMembers = payload.active ? new Map([...now].map(([id, m]) => [id, m.name])) : new Map();
        send('party:changed', payload);
        if (payload.active && mainWin && !mainWin.isDestroyed()) mainWin.webContents.setBackgroundThrottling(false);
      }
      else if (type === 'connection') {
        const ru = config.get().language !== 'en';
        const text = payload.connected
          ? (ru ? 'Соединение с лобби восстановлено.' : 'Lobby connection restored.')
          : (ru ? 'Потеряно соединение с лобби. Переподключаемся автоматически…' : 'Lobby connection lost. Reconnecting automatically…');
        send('toast', { kind: payload.connected ? 'party' : 'error', text });
        if (!mainWin || !mainWin.isVisible()) notify('MC Launcher', text, showMain, { icon: 'play', kind: 'party' });
      }
      else if (type === 'chat') {
        send('party:chat', payload);
        // a message from the lobby while playing: over the game
        if (!payload.self) require('./overlay').toast({ title: payload.name, text: payload.sticker ? (config.get().language !== 'en' ? 'стикер' : 'sticker') : payload.text, kind: 'message', icon: 'chat', face: require('./notify-icons').faceOf((party.state().members || []).find((m) => m.id === payload.from)?.skin) });
      }
      else if (type === 'emote' && mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('party:emote', payload);
      else if (type === 'audio' && mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('party:audio', payload);
      else if (type === 'signal' && mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('party:signal', payload);
      else if (type === 'ended') send('party:changed', { ...party.state(), ended: payload.reason });
      else if (type === 'start') {
        // the game itself starts in party-game.js
        send('party:start', payload);
        const ru = config.get().language !== 'en';
        if (!mainWin || !mainWin.isVisible()) notify('MC Launcher', ru ? `${payload.leader} запускает игру — подключаемся` : `${payload.leader} is starting the game — joining`, showMain, { icon: 'play', kind: 'party' });
      }
    });

    friends.onChange((state) => {
      send('friends:changed', state);
      refreshTray();
    });
    // a friend's lobby opened: the window shows a "Join"; hidden, a pop-up
    const friendLobbies = require('./friend-lobbies');
    friendLobbies.onEvent((type, payload) => {
      if (type === 'changed') send('friends:lobbies', payload);
      else if (type === 'opened') {
        if (party.state().active) return;
        send('friends:lobbyOpened', payload);
        const cfg = config.get();
        const ru = cfg.language !== 'en';
        if ((!mainWin || !mainWin.isVisible()) && cfg.notifyFriends !== false) notify(ru ? 'Приглашение в лобби' : 'Lobby invite', ru ? `У ${payload.gamertag} открыто лобби — нажмите, чтобы войти` : `${payload.gamertag} opened a lobby — click to join`, () => navigate('friends'), { face: payload.face, avatar: payload.avatar, icon: 'mail', kind: 'invite', overlayText: ru ? `${payload.gamertag} открыл лобби — войти можно в лаунчере` : `${payload.gamertag} opened a lobby — join from the launcher` });
      }
    });
    friendLobbies.init();
    // messages from friends' launchers: the window keeps the list; when the
    // chat isn't in front, a toast or Windows' pop-up with their picture
    const messenger = require('./messenger');
    messenger.onEvent((type, payload) => {
      if (type === 'changed') send('messages:changed', payload);
      else if (type === 'message' && !payload.looking) {
        const cfg = config.get();
        const ru = cfg.language !== 'en';
        const body = payload.sticker ? (ru ? 'Стикер' : 'Sticker') : payload.text.length > 140 ? `${payload.text.slice(0, 139)}…` : payload.text;
        if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && mainWin.isFocused()) send('messages:incoming', { ...payload, body });
        else if (cfg.notifyMessages !== false) notify(payload.gamertag, body, () => navigate('friends', { xuid: payload.xuid, chat: true }), { avatar: payload.avatar, icon: 'chat', kind: 'message' });
      }
    });
    messenger.init();
    friends.setNotificationHandler(() => navigate('friends'));
    // friends' news: a toast in the window while it's in front, Windows' own otherwise
    friends.setNotifier((n) => {
      if (!mainWin || mainWin.isDestroyed() || !mainWin.isVisible() || !mainWin.isFocused()) return require('./overlay').toast({ title: n.title, text: n.body, ...n.look });
      send('notice', { title: n.title, text: n.body, ...n.look });
      return true;
    });
    // Discord: "Ask to Join" from a friend → asked here; their launcher joins
    const discord = require('./discord');
    discord.onEvent((type, p) => {
      if (type === 'join') {
        showMain();
        send('party:discordJoin', p);
      } else if (type === 'request') {
        if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && mainWin.isFocused()) send('discord:request', p);
        else {
          const ru = config.get().language !== 'en';
          notify(ru ? 'Просятся в лобби' : 'Asking to join', ru ? `${p.name} из Discord хочет в ваше лобби — нажмите, чтобы впустить` : `${p.name} on Discord wants to join your lobby — click to let them in`, () => discord.answer(p.id, true), { avatar: p.avatar, icon: 'mail', kind: 'invite', overlayText: ru ? `${p.name} из Discord хочет в ваше лобби — ответьте в лаунчере` : `${p.name} on Discord wants to join — answer in the launcher` });
        }
      }
    });
    if (!capturePath && !testLaunch) discord.init({ game, bedrock, party });
    require('./game-skins').cleanup();

    log.subscribe((line) => {
      logQueue.push(line);
      if (!logTimer) {
        logTimer = setTimeout(() => {
          const batch = logQueue;
          logQueue = [];
          logTimer = null;
          if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send('log:lines', batch);
        }, 80);
      }
    });

    refreshTray();
    if (!capturePath && !testLaunch) applyAutostart();
    if (config.get().showConsole && !startHidden && !capturePath && !testLaunch) openConsole({ background: true });
    if (testLaunch) runTestLaunch();
    // Dev aid: `--test-signin=out.png` opens the Microsoft sign-in window,
    // photographs it (to check the client id / redirect are accepted) and
    // cancels — no credentials involved.
    const signinShot = arg('test-signin');
    if (signinShot) {
      const auth = require('./auth');
      auth.signInInteractive({ inApp: true, parent: null }).catch((e) => log.info(`test-signin ended: ${e.message}`));
      setTimeout(() => {
        const w = BrowserWindow.getAllWindows().find((x) => x !== mainWin && x !== consoleWin);
        if (w) w.setPosition(-4000, 60);
      }, 300);
      setTimeout(async () => {
        const w = BrowserWindow.getAllWindows().find((x) => x !== mainWin && x !== consoleWin);
        if (w) {
          log.info(`test-signin url: ${w.webContents.getURL().slice(0, 120)}`);
          w.webContents.invalidate();
          await new Promise((r) => setTimeout(r, 200));
          fs.writeFileSync(signinShot, (await w.webContents.capturePage()).toPNG());
        } else {
          log.warn('test-signin: no sign-in window');
        }
        auth.cancelSignIn();
        setTimeout(quit, 600);
      }, 9000);
    }

    // Background refreshes; the UI is already up with cached data.
    versions
      .fetchManifest()
      .then(() => {
        installs.refreshDefaultEntry();
        send('installs:changed');
        refreshTray();
      })
      .catch((e) => log.warn(e.message));
    friends.start();
    bedrock
      .detect()
      .then((d) => {
        if (!d.installed) return;
        send('installs:changed');
        refreshTray();
      })
      .catch((e) => log.warn(`Bedrock check failed: ${e.message}`));
    // 2.0.0 cached the official key art for the home screen; that's gone now.
    fs.rm(paths.wallpaperDir, { recursive: true, force: true }, () => {});
  });
}
