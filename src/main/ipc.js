'use strict';
// Every call the UI can make. Handlers return {ok, data} / {ok:false,
// error}, which the preload turns back into a resolved value or a thrown
// Error with a readable message (instead of Electron's "Error invoking
// remote method ..." wrapper).

const fs = require('fs');
const path = require('path');
const { ipcMain, BrowserWindow, app, shell, dialog } = require('electron');
const config = require('./config');
const paths = require('./paths');
const native = require('./native');
const auth = require('./auth');
const installs = require('./installs');
const versions = require('./versions');
const game = require('./game');
const worlds = require('./worlds');
const skins = require('./skins');
const bedrock = require('./bedrock');
const party = require('./party');
const friends = require('./friends');
const friendLobbies = require('./friend-lobbies');
const messenger = require('./messenger');
const java = require('./java');
const log = require('./log');

let systemCache = null;

function register(ctx) {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, data: await fn(event, ...args) };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e), code: (e && e.code) || '' };
      }
    });
  };
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
  const str = (v, max = 512) => {
    if (typeof v !== 'string' || v.length > max) throw new Error('bad argument');
    return v;
  };
  const xuid = (v) => {
    if (!/^\d{1,20}$/.test(String(v))) throw new Error('bad xuid');
    return String(v);
  };

  // ---- window -------------------------------------------------------------
  handle('win:minimize', (e) => winOf(e) && winOf(e).minimize());
  handle('win:toggleMaximize', (e) => {
    const w = winOf(e);
    if (!w || !w.isMaximizable()) return false;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return w.isMaximized();
  });
  handle('win:close', (e) => winOf(e) && winOf(e).close());
  handle('win:isMaximized', (e) => !!(winOf(e) && winOf(e).isMaximized()));

  // ---- app ------------------------------------------------------------------
  // the shop: coins and packs (shop.js); coins come from our server only
  handle('shop:state', () => require('./shop').state());
  handle('shop:refresh', () => require('./shop').refresh());
  handle('shop:buy', (e, id) => require('./shop').buy(String(id || '')));
  handle('shop:pay', (e, id) => require('./shop').pay(String(id || '')));
  // a downloaded, checked update: in now, and the launcher again after it
  handle('app:installUpdate', () => require('./updater').installNow());
  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    native: native.moduleInfo(),
    appDir: paths.appDir,
    gameDir: config.dirs.game(),
    discord: require('./discord').available(),
  }));
  handle('app:system', () => {
    // GPUs/CPU don't change while running; free memory does.
    if (!systemCache) systemCache = native.systemInfo();
    return { ...systemCache, freeMemMB: require('os').freemem() / 1048576 };
  });
  handle('app:openExternal', (e, url) => {
    if (!/^https?:\/\//i.test(str(url, 2048))) throw new Error('only http(s) links');
    return shell.openExternal(url);
  });
  handle('app:openFolder', async (e, kind, id, sub) => {
    if (kind === 'instance' && id === 'bedrock') {
      const err = await bedrock.openFolder();
      if (err) throw new Error(err);
      return;
    }
    let dir;
    if (kind === 'game') dir = config.dirs.game();
    else if (kind === 'app') dir = paths.appDir;
    else if (kind === 'logs') dir = paths.logsDir;
    else if (kind === 'videos') dir = require('./capture').videosDir();
    else if (kind === 'pictures') { dir = require('path').join(require('electron').app.getPath('pictures'), 'MC Launcher'); require('fs').mkdirSync(dir, { recursive: true }); }
    else if (kind === 'skins') dir = paths.skinsDir;
    else if (kind === 'instance') dir = installs.instanceFolder(str(id, 128), sub ? str(sub, 32) : '');
    else throw new Error('unknown folder');
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });
  handle('app:openCrashReport', async (e, file) => {
    const p = path.resolve(str(file, 1024));
    if (!p.startsWith(path.resolve(config.dirs.game()) + path.sep) || !/\.txt$/i.test(p)) throw new Error('not a crash report');
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  });
  handle('app:pickFile', async (e, opts = {}) => {
    const r = await dialog.showOpenDialog(winOf(e), {
      title: opts.title,
      properties: ['openFile'],
      filters: opts.filters || [{ name: 'PNG', extensions: ['png'] }],
      defaultPath: opts.defaultPath,
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('app:pickFolder', async (e, opts = {}) => {
    const r = await dialog.showOpenDialog(winOf(e), { title: opts.title, properties: ['openDirectory', 'createDirectory'], defaultPath: opts.defaultPath });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('app:quit', () => ctx.quit());
  handle('app:show', () => ctx.showMain());
  handle('console:open', () => ctx.openConsole());

  // ---- config ------------------------------------------------------------------
  handle('config:get', () => config.publicView());
  handle('config:set', (e, patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('bad settings');
    const before = config.get().autostart;
    const view = config.updateSettings(patch);
    if ('autostart' in patch && before !== view.autostart) ctx.applyAutostart();
    if ('language' in patch || 'notifyFriends' in patch || 'notifications' in patch) ctx.refreshTray();
    if ('discord' in patch || 'discordServer' in patch || 'discordJoin' in patch || 'language' in patch) require('./discord').refresh();
    return view;
  });

  // ---- accounts ----------------------------------------------------------------
  handle('accounts:signIn', async (e, opts = {}) => {
    const inApp = typeof opts.inApp === 'boolean' ? opts.inApp : config.get().inAppLogin;
    const acc = await auth.signInInteractive({ inApp, parent: ctx.getMain() });
    skins.followAccount();
    friends.refresh();
    return acc;
  });
  handle('accounts:cancelSignIn', () => auth.cancelSignIn());
  handle('accounts:select', (e, id) => {
    auth.selectAccount(str(id, 128));
    skins.followAccount(); // Bedrock wears this account's skin, not the last one's
    friends.refresh();
  });
  handle('accounts:remove', (e, id) => {
    auth.removeAccount(str(id, 128));
    skins.followAccount();
    friends.refresh();
  });
  handle('accounts:setNick', (e, id, nick) => config.setJavaNick(str(id, 128), str(nick, 16)));
  handle('accounts:addOffline', (e, name) => {
    const a = auth.addOffline(str(name, 64));
    skins.followAccount();
    friends.refresh();
    return a;
  });
  handle('accounts:forgetBrowser', () => auth.clearBrowserSession());
  handle('accounts:textures', (e, uuid) => skins.texturesByUuid(str(uuid, 64)));

  // ---- installations ---------------------------------------------------------------
  handle('installs:list', () => installs.listForUi());
  handle('installs:create', (e, data) => installs.create(data || {}));
  handle('installs:update', (e, id, patch) => installs.update(str(id, 128), patch || {}));
  handle('installs:move', (e, id, dir) => installs.move(str(id, 128), dir > 0 ? 1 : -1));
  handle('installs:remove', (e, id) => installs.remove(str(id, 128)));
  handle('installs:clearFiles', (e, id) => installs.clearFiles(str(id, 128)));
  handle('installs:start', (e, id, opts = {}) =>
    require('./party-game').startFromUi(str(id, 128), {
      world: opts.world ? str(opts.world, 256) : '',
      server: opts.server ? str(opts.server, 256) : '',
      repair: !!opts.repair,
      launch: opts.launch !== false,
    }),
  );
  handle('installs:cancel', () => installs.cancel());
  handle('installs:task', () => installs.taskView());

  // ---- versions ----------------------------------------------------------------------
  handle('versions:manifest', async (e, force) => {
    const m = await versions.fetchManifest(!!force);
    return { latest: m.latest, versions: m.versions.map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime })) };
  });
  handle('versions:loaders', (e, loader, mc) => versions.loaderVersions(str(loader, 16), str(mc, 64)));

  // ---- game ------------------------------------------------------------------------------
  handle('game:list', () => [...game.list(), ...bedrock.runningList()]);
  handle('game:kill', (e, pid) => game.kill(Number(pid)));

  // ---- worlds & servers --------------------------------------------------------------------
  handle('worlds:recent', () => worlds.recentWorlds(installs.allEntries(), 8));
  handle('worlds:list', (e, id) => {
    const entry = installs.entryById(str(id, 128));
    return entry ? worlds.recentWorlds([entry], 100) : [];
  });
  handle('servers:list', (e, id) => {
    if (id === 'bedrock') return bedrock.servers();
    const entry = installs.entryById(str(id, 128));
    return entry ? worlds.savedServers(entry) : [];
  });
  handle('servers:ping', (e, address, edition) => (edition === 'bedrock' ? bedrock.ping(str(address, 256)) : worlds.pingServer(str(address, 256))));
  handle('servers:icon', (e, address) => bedrock.javaIcon(str(address, 256)));

  // ---- party -------------------------------------------------------------------------------------
  const me = (m) => ({
    name: str(m && m.name, 32),
    skin: m && typeof m.skin === 'string' && m.skin.startsWith('data:image/png;base64,') && m.skin.length < 40000 ? m.skin : '',
    cape: m && typeof m.cape === 'string' && m.cape.startsWith('data:image/png;base64,') && m.cape.length < 40000 ? m.cape : '',
    model: m && m.model === 'slim' ? 'slim' : 'classic',
    edition: m && m.edition === 'bedrock' ? 'bedrock' : 'java',
    // what we wear, from our own list — not whatever the page says
    cos: require('./cosmetics').worn(),
    // ours, from the Xbox profile — not whatever the page says
    xuid: String((friends.getState().me || {}).xuid || (auth.activeAccount() || {}).xuid || ''),
  });
  handle('app:gameDirOffer', () => require('./gamedir').pending());
  handle('app:gameDirAnswer', (e, move) => require('./gamedir').answer(!!move));
  handle('party:state', () => party.state());
  handle('party:create', (e, m) => party.create(me(m)));
  handle('party:join', (e, code, m) => party.join(str(code, 32), me(m)));
  handle('party:leave', () => party.leave());
  handle('party:kick', (e, id) => party.kick(str(id, 64)));
  handle('party:joinFriend', (e, xuid, m) => friendLobbies.join(str(xuid, 20), me(m)));
  handle('friends:lobbies', () => friendLobbies.list());

  // ---- messages between friends' launchers ----
  handle('messages:summary', () => messenger.summary());
  const msgBody = (m) => ({ text: m && typeof m.text === 'string' ? str(m.text, 4000) : '', sticker: m && typeof m.sticker === 'string' ? str(m.sticker, 24) : '' });
  handle('messages:get', (e, id) => messenger.conversation(xuid(id)));
  handle('messages:send', (e, id, msg) => messenger.send(xuid(id), msgBody(msg)));
  handle('messages:open', (e, id) => messenger.setOpen(id ? xuid(id) : ''));
  handle('messages:trust', (e, id) => messenger.trust(xuid(id)));
  handle('messages:clear', (e, id) => messenger.clear(xuid(id)));
  handle('party:setPlan', (e, plan) => party.setPlan(plan || {}));
  handle('party:start', (e, plan) => party.start(plan || {}));
  // the leader's Play with friends: the ready check first (party-game.js)
  handle('party:play', (e, plan, entryId) => require('./party-game').play(plan || {}, str(entryId, 128)));
  handle('party:cancelPlay', () => party.cancelPrepare());

  // ---- the tunnel into the leader's world (tunnel.js; the page holds the WebRTC side) ----
  handle('tunnel:ready', () => require('./party-game').tunnelReady());
  handle('tunnel:relay', () => require('./tunnel').useRelay());
  handle('tunnel:retry', () => require('./party-game').retryTunnel());
  handle('tunnel:connect', (e, id) => require('./tunnel').connect(str(id, 64)));
  const tunnelId = (v) => typeof v === 'string' && v.length <= 64;
  ipcMain.on('tunnel:data', (e, id, bytes) => tunnelId(id) && bytes && require('./tunnel').data(id, bytes));
  ipcMain.on('tunnel:close', (e, id) => tunnelId(id) && require('./tunnel').close(id));
  ipcMain.on('tunnel:pause', (e, id, on) => tunnelId(id) && require('./tunnel').pause(id, !!on));
  handle('party:takeInvite', () => ctx.takeInvite());
  handle('cosmetics:takeRedeemLink', () => (ctx.takeRedeem ? ctx.takeRedeem() : ''));
  handle('party:discordAnswer', (e, id, accept) => require('./discord').answer(str(id, 32), !!accept));
  handle('party:say', (e, msg) => party.say({ text: typeof (msg && msg.text) === 'string' ? msg.text.slice(0, 2000) : '', sticker: typeof (msg && msg.sticker) === 'string' ? msg.sticker.slice(0, 32) : '' }));
  handle('party:chatLog', () => party.chatLog());
  handle('party:probe', () => party.probeRelays());
  // ICE for voice and the world tunnel: our relay's STUN/TURN, fresh credentials
  handle('net:ice', () => require('./relay-server').iceServers());
  handle('cosmetics:state', () => require('./cosmetics').view());
  // the week's quests (quests.js): what they are and how far they've got; the drop seen
  handle('quests:state', () => require('./quests').view());
  handle('quests:refresh', () => require('./quests').refresh());
  handle('quests:seen', (e, week) => require('./quests').seen(Number(week)));
  handle('quests:pick', (e, week, pick) => require('./quests').pickReward(Number(week), Number(pick)));
  handle('profile:get', () => require('./profiles').view());
  handle('profile:setAvatar', (e, data) => require('./profiles').setAvatar(data ? str(data, 12000) : ''));
  handle('profiles:of', (e, xuids, opts) => require('./profiles').of(Array.isArray(xuids) ? xuids.slice(0, 40).map((x) => str(x, 20)) : [], { force: !!(opts && opts.force) }));
  handle('cosmetics:wear', (e, slot, id) => require('./cosmetics').wear(str(slot, 16), id ? str(id, 64) : ''));
  handle('cosmetics:claim', (e, id) => require('./cosmetics').claim(str(id, 64)));
  handle('cosmetics:redeem', (e, code) => require('./redeem').redeem(str(code, 64)));
  handle('party:network', () => party.networkHints());
  handle('party:emote', (e, id) => party.emote(str(id, 24)));
  handle('party:audio', (e, pkt) => party.audio(pkt && typeof pkt === 'object' ? { s: Number(pkt.s), f: Array.isArray(pkt.f) ? pkt.f : [] } : null));
  handle('party:me', (e, m) => party.updateMe(me(m)));
  // the voice call keeps the page's timers running while the window is hidden
  handle('win:keepAlive', (e, on) => ctx.keepAlive(!!on));
  handle('party:voice', (e, v) => party.setVoice(v && typeof v === 'object' ? { on: !!v.on, mic: !!v.mic, deaf: !!v.deaf } : null));
  handle('party:signal', (e, to, kind, sdp) => party.signal(str(to, 64), str(kind, 16), /bye$/.test(String(kind)) ? '' : str(sdp, 24000)));
  // push-to-talk: the main process watches the key, whatever window has focus
  handle('nearby:state', () => require('./nearby').state());
  // the fixer (the bug by the console): scan an edition, put one thing right
  handle('fixer:scan', (e, edition, installId) => require('./fixer').scan(edition === 'bedrock' ? 'bedrock' : 'java', installId ? str(installId, 128) : ''));
  handle('fixer:fix', (e, f) => require('./fixer').fix(f && typeof f === 'object' ? f : null));
  handle('voice:hud', (e, value) => {
    if (e.sender !== ctx.getMain()?.webContents) return;
    require('./overlay').setVoice(value);
    // in voice: the window's timers at full pace even while it's hidden for
    // the game (Chromium wakes a hidden page's timers once a minute — the
    // voice's loop stood still and the overlay took the voice for gone)
    const awake = !!(value && value.on);
    if (e.sender.mclVoiceAwake !== awake) {
      e.sender.mclVoiceAwake = awake;
      e.sender.setBackgroundThrottling(!awake);
    }
  });
  handle('nearby:voice', (e, v) => require('./nearby').setVoice(v));
  handle('nearby:signal', (e, id, kind, sdp) => require('./nearby').signal(str(id, 32), str(kind, 8), sdp ? str(sdp, 24000) : ''));
  handle('voice:ptt', (e, vks) => ctx.watchPtt(Array.isArray(vks) ? vks.map(Number).filter((k) => Number.isInteger(k) && k > 0 && k < 256).slice(0, 3) : []));

  // ---- bedrock ----------------------------------------------------------------------------------
  handle('bedrock:info', () => ({ ...bedrock.info(), worn: skins.bedrockWorn() }));
  handle('bedrock:openFolder', () => bedrock.openFolder());
  handle('bedrock:switchAccount', () => bedrock.openXboxAccount());
  handle('bedrock:store', () => bedrock.openStore());
  handle('bedrock:setSkin', async (e, id) => {
    const skinId = id ? str(id, 64) : '';
    if (skinId && !skins.list().some((s) => s.id === skinId)) throw new Error('Скин не найден.');
    config.mutate((c) => (c.bedrockSkin = skinId));
    // closed game → on now; running → on the next start
    let r = { applied: false, reason: 'none' };
    if (skinId) r = await bedrock.applySkin(skins.list(), paths.skinsDir);
    return { ...bedrock.info(), result: r };
  });

  // ---- skins & capes ---------------------------------------------------------------------------
  handle('skins:appearance', (e, opts = {}) => skins.appearance({ edition: opts.edition === 'bedrock' ? 'bedrock' : 'java', accountId: opts.accountId ? str(opts.accountId, 128) : '' }));
  handle('skins:list', () => skins.list());
  handle('skins:add', (e, data) => skins.add(data || {}));
  handle('skins:update', (e, id, data) => skins.update(str(id, 64), data || {}));
  handle('skins:remove', (e, id) => skins.remove(str(id, 64)));
  handle('skins:apply', async (e, id, target = 'launcher') => {
    const skinId = str(id, 64);
    const r = await skins.apply(skinId, target);
    // one skin for both games: Bedrock gets it too
    if (!r.uploaded && bedrock.cached().installed) {
      config.mutate((c) => (c.bedrockSkin = skinId));
      r.bedrock = await bedrock.applySkin(skins.list(), paths.skinsDir).catch((err) => ({ applied: false, reason: 'error', message: err.message }));
    }
    return r;
  });
  handle('skins:import', (e, name) => skins.importFromPlayer(str(name, 32)));
  handle('skins:profile', () => skins.accountProfile());
  handle('skins:setCape', (e, id) => skins.setCape(id ? str(id, 128) : '', {
    // Mojang asked to wait: the window says so (the cape goes on by itself)
    onWait: () => { if (!e.sender.isDestroyed()) e.sender.send('toast', { kind: 'info', icon: 'cape', text: config.get().language === 'en' ? 'Mojang allows one cape change a minute — it goes on by itself in a minute.' : 'Mojang разрешает менять плащ раз в минуту — он поставится сам через минуту.' }); },
  }));
  // capes without a Java licence: the user's own PNGs
  handle('skins:capes', () => skins.capes());
  handle('skins:addCape', (e, data) => skins.addCape({ path: data && data.path ? str(data.path, 1024) : '', name: data && data.name ? str(data.name, 64) : '' }));
  handle('skins:wearCape', (e, id) => ({ capes: skins.wearCape(id ? str(id, 64) : '') }));
  handle('skins:renameCape', (e, id, name) => skins.renameCape(str(id, 64), str(name, 64)));
  handle('skins:removeCape', (e, id) => skins.removeCape(str(id, 64)));
  handle('skins:activeLocal', () => skins.activeLocalSkinUrl());
  handle('skins:export', async (e, id, name) => {
    const r = await dialog.showSaveDialog(winOf(e), {
      defaultPath: `${String(name || 'skin').replace(/[\\/:*?"<>|]/g, '_')}.png`,
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (r.canceled || !r.filePath) return false;
    await skins.exportSkin(str(id, 64), r.filePath);
    return true;
  });

  // ---- friends ----------------------------------------------------------------------------------
  handle('friends:get', () => friends.getState());
  handle('friends:refresh', () => friends.refresh());
  handle('friends:search', (e, q) => friends.search(str(q, 64)));
  handle('friends:add', (e, id) => friends.addFriend(xuid(id)));
  handle('friends:remove', (e, id) => friends.removeFriend(xuid(id)));
  handle('friends:page', (e, active) => friends.setVisibility({ page: !!active }));

  // ---- misc ----------------------------------------------------------------------------------------
  handle('log:history', () => log.history());
  handle('log:clear', () => log.clear());
  handle('java:detect', () => java.detectInstalled());
}

module.exports = { register };
