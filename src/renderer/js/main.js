// Main window: shell (title bar, logo, nav, account, status bar) + router.
import { h, swap } from './dom.js';
import { t, setLang } from './i18n.js';
import { icon } from './icons.js';
import { api, onEvent, store, applyAccent, setSheen, remote, formatMb, stageText } from './core.js';
import { button, iconButton, toast, closeMenu, modal } from './ui.js';
import { skinFace, STEVE } from './skin3d.js';
import { currentAppearance, appearanceKey } from './appearance.js';
import * as Home from './pages/home.js';
import * as InstallForm from './pages/install-form.js';
import * as Skins from './pages/skins.js';
import * as Friends from './pages/friends.js';
import * as Settings from './pages/settings.js';
import * as Accounts from './pages/accounts.js';
import * as Shop from './pages/shop.js';
import { openPartyDialog, joinFriendLobby, joinByCode } from './party-ui.js';
import { bedrockMismatch, mismatchText, switchBedrockAccount } from './bedrock-account.js';
import { initVoice } from './voice.js';
import { initTunnel } from './tunnel.js';
import { openFixer } from './fixer.js';

const PAGES = { home: Home, newInstall: InstallForm, editInstall: InstallForm, skins: Skins, shop: Shop, friends: Friends, settings: Settings, accounts: Accounts };

let view;
let current = null;
let navButtons = {};
let accountEl;
let statusText;
let statusDot;
let statusRight;

export function go(page, params = {}) {
  if (!PAGES[page]) page = 'home';
  closeMenu();
  const prev = current;
  if (prev && prev.name === page && JSON.stringify(prev.params) === JSON.stringify(params)) return;
  if (prev) {
    try {
      prev.unmount && prev.unmount();
    } catch (e) {
      console.error(e);
    }
    const old = prev.el;
    old.classList.add('leave');
    setTimeout(() => old.remove(), 170);
  }
  // A page left over from before (one that failed to mount, a quick click
  // between two pages) goes now: one page on screen at a time.
  for (const stray of view.querySelectorAll(':scope > .page:not(.leave)')) stray.remove();
  const el = h(`div.page.enter.${page}-page`);
  view.appendChild(el);
  // The page is current even if its mount fails half way, so the next go()
  // takes it off the screen instead of drawing the next one over it.
  current = { name: page, params, el, unmount: null };
  try {
    current.unmount = PAGES[page].mount(el, params, { go });
  } catch (e) {
    console.error(`Page ${page}:`, e);
  }
  store.set({ page });
  api('friends:page', page === 'friends').catch(() => {});
  setTimeout(() => el.classList.remove('enter'), 400);
}

function titlebar() {
  const bar = h(
    'div.titlebar',
    h('img.tb-icon', { src: 'mcl://app/assets/icon/titlebar.png', alt: '' }),
    h('div.tb-title', 'MC Launcher'),
    h('div.tb-spacer'),
    h(
      'div.win-btns',
      h('button.win-btn', { type: 'button', onclick: () => api('win:minimize') }, icon('winMin')),
      h('button.win-btn.close', { type: 'button', onclick: () => api('win:close') }, icon('winClose')),
    ),
  );
  return bar;
}

function header() {
  // the logo's own strip of the sheen, cut to the logo's shape
  const logo = h('div.logo', { 'data-tip': null, onclick: () => go('home') }, h('div.logo-shine'));
  syncLogo(logo, true);
  store.on(['page', 'config', 'installs'], () => syncLogo(logo));
  const friendsBadge = h('span.badge.hidden', '0');
  const unreadBadge = h('span.badge.msg.hidden', '0');
  navButtons = {
    // the lobby (a new installation: from the installation picker by "Play")
    home: button(t('nav.home'), { icon: 'home', onClick: () => go('home') }),
    skins: button(t('nav.skins'), { icon: 'hanger', onClick: () => toggleTo('skins') }),
    shop: button(t('nav.shop'), { icon: 'shop', onClick: () => toggleTo('shop') }),
    friends: button(t('nav.friends'), { icon: 'friends', onClick: () => toggleTo('friends') }),
    settings: button(t('nav.settings'), { icon: 'gear', onClick: () => toggleTo('settings') }),
    // the console only as its icon (a window of its own, rarely needed): room for the shop
    console: iconButton('console', { title: t('nav.console'), onClick: () => api('console:open') }),
    // the fixer: what keeps the game from starting (a mod crashing Java, Bedrock that won't start), found and put right
    fixer: iconButton('bug', { title: t('nav.fixer'), onClick: () => openFixer() }),
  };
  navButtons.friends.append(friendsBadge, unreadBadge);
  store.on('dm', (d) => {
    const n = (d && d.unread) || 0;
    unreadBadge.textContent = n > 99 ? '99+' : String(n);
    unreadBadge.classList.toggle('hidden', !n);
    unreadBadge.dataset.tip = n ? t('dm.unreadNav', { n }) : '';
  });
  store.on('friends', (f) => {
    const n = f && f.status === 'ok' ? f.online : 0;
    friendsBadge.textContent = String(n);
    friendsBadge.classList.toggle('hidden', !n);
    navButtons.friends.dataset.tip = f && f.status === 'ok' ? `${t('friends.onlineCount', { n: f.online })} · ${t('friends.playingCount', { n: f.playing })}` : '';
  });
  store.on('page', (p) => {
    for (const [k, b] of Object.entries(navButtons)) b.classList.toggle('active', k === p);
  });

  accountEl = h('div.account');
  renderAccount(true);
  store.on(['config', 'installs'], renderAccount);
  // a new launcher account: say so if Bedrock still plays as another one
  let lastActive = (store.get('config') || {}).activeAccount;
  store.on('config', async (cfg) => {
    if (!cfg || cfg.activeAccount === lastActive) return;
    const first = lastActive === undefined;
    lastActive = cfg.activeAccount;
    if (first) return;
    const other = bedrockMismatch(await api('bedrock:info').catch(() => null), cfg);
    if (other) toast(mismatchText(other), { kind: 'warn', timeout: 14000, action: { label: t('bedrock.switchAccount'), onClick: () => switchBedrockAccount(other.name) } });
  });
  window.addEventListener('mcl:skin-changed', () => renderAccount(true));

  return h(
    'div.header',
    h('div.logo-row', logo),
    h('div.nav', navButtons.home, navButtons.skins, navButtons.shop, navButtons.friends, navButtons.settings, navButtons.console, navButtons.fixer, h('div.grow'), accountEl),
  );
}

// The logo names the edition of the selected installation on every page
// (the installation form makes Java installations).
function logoVariant() {
  const cfg = store.get('config') || {};
  const installs = store.get('installs') || [];
  const page = store.get('page') || 'home';
  if (page === 'newInstall' || page === 'editInstall') return 'java';
  const sel = installs.find((e) => e.id === cfg.selectedInstall) || installs[0];
  return sel && sel.isBedrock ? 'bedrock' : 'java';
}

let shownLogo = '';
let logoTimer = 0;
function syncLogo(logo, now) {
  const v = logoVariant();
  if (v === shownLogo) return;
  shownLogo = v;
  const set = () => {
    logo.classList.toggle('bedrock', v === 'bedrock');
    logo.classList.remove('swap');
  };
  clearTimeout(logoTimer);
  if (now) return set();
  logo.classList.add('swap');
  logoTimer = setTimeout(set, 170);
}
// no flash on the first switch
new Image().src = 'mcl://app/assets/images/minecraft_logo_bedrock.png';

function toggleTo(page) {
  go(store.get('page') === page ? 'home' : page);
}

let faceToken = 0;
let accountKey = '';
async function renderAccount(force) {
  const cfg = store.get('config');
  if (!cfg || !accountEl) return;
  // Refresh for account, edition and selected skin changes, not unrelated settings.
  const key = `${appearanceKey()}|${cfg.accounts.map((a) => `${a.id}:${a.name}:${a.needsLogin}`).join(',')}`;
  if (key === accountKey && force !== true && accountEl.firstChild) return;
  accountKey = key;
  const acc = cfg.accounts.find((a) => a.id === cfg.activeAccount) || cfg.accounts[0];
  const face = h('img.account-face', { alt: '' });
  const kind = h('div.account-kind', acc ? (acc.needsLogin ? t('account.relogin') : acc.type === 'msa' ? 'Microsoft' : acc.type === 'xbox' ? t('account.xbox') : t('account.guest')) : '');
  if (acc && acc.needsLogin) kind.classList.add('warn');
  const badge = h(
    'div.account-badge',
    // the badge opens the profile (picture, name, hours, items, the accounts)
    { 'data-tip': t('account.profile'), onclick: () => go('accounts') },
    face,
    h('div.account-text', h('div.account-name', acc ? acc.name : 'Player'), kind),
  );
  swap(accountEl, badge, button(null, { icon: 'swap', cls: 'btn-icon', variant: acc && acc.needsLogin ? 'primary' : 'secondary', title: t('account.switch'), onClick: () => go('accounts') }));
  const token = ++faceToken;
  try {
    const appearance = await currentAppearance();
    const data = await skinFace(appearance.url, 64);
    if (token === faceToken) face.src = data;
  } catch {
    if (token === faceToken) skinFace(STEVE).then((d) => (face.src = d)).catch(() => {});
  }
}

function statusbar() {
  statusDot = h('span.dot', icon('lamp'));
  statusText = h('span', t('status.ready'));
  statusRight = h('span');
  const bar = h('div.statusbar', h('div.st-left', statusDot, statusText), statusRight);
  const render = () => {
    const task = store.get('task') || {};
    const running = store.get('running') || [];
    statusDot.className = 'dot';
    if (task.busy) {
      statusDot.classList.add('busy');
      const p = task.progress;
      statusText.textContent = `${task.name}: ${stageText(task)}${p && p.fraction ? ` — ${Math.round(p.fraction * 100)}%` : ''}`;
    } else if (running.length) {
      const r = running[0];
      statusText.textContent = t('status.inGame', { name: running.map((x) => x.installName).join(', ') });
      statusRight.textContent = r.stats && r.stats.memMB ? `${t('status.mem', { mb: formatMb(r.stats.memMB) })}${r.stats.cpu != null ? ` · CPU ${r.stats.cpu}%` : ''}` : '';
      return;
    } else {
      statusText.textContent = store.get('offline') ? t('status.offline') : t('status.ready');
      if (store.get('offline')) statusDot.classList.add('idle');
    }
    statusRight.textContent = '';
  };
  store.on(['task', 'running', 'offline'], render);
  render();
  return bar;
}

async function refreshInstalls() {
  try {
    store.set({ installs: await api('installs:list') });
  } catch (e) {
    console.error(e);
  }
}

async function boot() {
  const [config, installs, task, friends, running, info, party, friendLobbies] = await Promise.all([
    api('config:get'),
    api('installs:list'),
    api('installs:task'),
    api('friends:get'),
    api('game:list'),
    api('app:info'),
    api('party:state'),
    api('friends:lobbies').catch(() => []),
  ]);
  setLang(config.language);
  applyAccent(config.accentColor);
  setSheen(config.sheen !== false);
  document.documentElement.classList.toggle('reduce-motion', !!config.reduceMotion);
  store.set({ config, installs, task, friends, running, info, party, friendLobbies });

  const app = document.getElementById('app');
  view = h('div.view');
  swap(app, titlebar(), header(), view, statusbar());
  go('home');

  onEvent('config:changed', (cfg) => {
    const prev = store.get('config');
    if (prev && prev.language !== cfg.language) {
      setLang(cfg.language);
      store.set({ config: cfg });
      // Labels are built once per page; a language switch rebuilds the UI.
      const page = store.get('page');
      swap(app, titlebar(), header(), (view = h('div.view')), statusbar());
      current = null;
      go(page || 'settings');
      return;
    }
    if (!prev || prev.accentColor !== cfg.accentColor) applyAccent(cfg.accentColor);
    if (!prev || prev.sheen !== cfg.sheen) setSheen(cfg.sheen !== false);
    document.documentElement.classList.toggle('reduce-motion', !!cfg.reduceMotion);
    store.set({ config: cfg });
  });
  onEvent('installs:changed', refreshInstalls);
  onEvent('task', (tk) => store.set({ task: tk }));
  onEvent('task:done', (d) => {
    if (d.bedrockSkin && d.bedrockSkin.reason === 'running') toast(t('bedrock.skinRunning'), { kind: 'warn' });
    if (d.action === 'verify') toast(t('toast.verified', { name: d.name }), { kind: 'ok', icon: 'download' });
    else if (d.action === 'store') toast(t('toast.bedrockStore'), { kind: 'info', icon: 'block', timeout: 9000 });
    else if (d.quickPlayIgnored) toast(t('toast.quickPlayOld', { name: d.name }), { kind: 'warn' });
  });
  onEvent('task:error', (d) => {
    const needLogin = d.code === 'expired';
    toast(`${d.name}: ${d.message}`, {
      kind: 'error',
      action: needLogin ? { label: t('accounts.relogin'), onClick: () => go('accounts') } : null,
    });
  });
  onEvent('task:cancelled', (d) => toast(t('toast.cancelled', { name: d.name })));
  onEvent('game', (ev) => {
    api('game:list').then((r) => store.set({ running: r })).catch(() => {});
    if (ev.type === 'stats') {
      const list = (store.get('running') || []).map((r) => (r.pid === ev.pid ? { ...r, stats: { memMB: ev.memMB, cpu: ev.cpu } } : r));
      store.set({ running: list });
    }
    if (ev.type === 'exited' && ev.crashed) {
      toast(ev.javaFailed ? t('toast.javaFailed', { name: ev.installName }) : t('toast.crashed', { name: ev.installName, code: ev.code }), {
        kind: 'error',
        action: ev.crashReport ? { label: t('toast.openCrash'), onClick: () => api('app:openCrashReport', ev.crashReport) } : { label: t('nav.console'), onClick: () => api('console:open') },
      });
    }
    if (ev.type === 'exited' || ev.type === 'started') refreshInstalls();
  });
  onEvent('friends:changed', (f) => store.set({ friends: f }));
  onEvent('friends:lobbies', (list) => store.set({ friendLobbies: list || [] }));
  onEvent('friends:lobbyOpened', (item) => {
    if ((store.get('party') || {}).active) return;
    toast(t('lobby.friendOpenedText'), { kind: 'invite', title: item.gamertag, avatar: item.face || item.avatar, pixel: !!item.face, icon: 'mail', timeout: 12000, action: { label: t('friends.join'), onClick: () => joinFriendLobby(item, { after: () => go('home') }) } });
  });
  // Discord: "Join" pressed on someone's activity → into their party; someone
  // asked to join ours → let them in or not
  onEvent('party:discordJoin', (d) => d && d.code && joinByCode(d.code, { after: () => go('home') }));
  onEvent('discord:request', (r) => r && r.id && toast(t('discord.requestText'), {
    kind: 'invite',
    title: r.name,
    avatar: r.avatar,
    icon: 'mail',
    timeout: 30000,
    actions: [
      { label: t('discord.accept'), onClick: () => api('party:discordAnswer', r.id, true).catch(() => {}) },
      { label: t('discord.decline'), onClick: () => api('party:discordAnswer', r.id, false).catch(() => {}) },
    ],
  }));
  // friends' news (online, playing, requests) while the window is in front
  onEvent('notice', (n) => n && toast(n.text || '', { kind: n.kind || 'online', title: n.title, avatar: n.avatar, icon: n.icon, timeout: 7000, action: { label: t('nav.friends'), onClick: () => go('friends') } }));
  onEvent('nav', (p) => (p && typeof p === 'object' ? go(p.page, p.params || {}) : go(p)));
  // messages from friends' launchers: the list for the Friends page, a toast
  // when one comes in while its conversation isn't open
  api('messages:summary').then((s) => store.set({ dm: s })).catch(() => {});
  onEvent('messages:changed', (d) => store.set({ dm: d.summary, dmChats: d.chats }));
  onEvent('messages:incoming', (m) => {
    toast(m.body, { kind: 'message', title: m.gamertag, avatar: m.avatar || '', icon: 'chat', timeout: 7000, action: { label: t('dm.reply'), onClick: () => go('friends', { xuid: m.xuid, chat: true }) } });
  });
  onEvent('toast', (d) => d && d.text && toast(d.text, { kind: d.kind || 'info', icon: d.icon, title: d.title }));
  // a payment done (shop.js): what came, or that it didn't
  onEvent('shop:paid', (p) => {
    if (!p) return;
    if (p.ok) toast(t('shop.paidCoins', { n: p.coins }), { kind: 'ok', icon: 'coin', timeout: 10000 });
    else toast(t('shop.payCanceled'), { kind: 'warn', timeout: 8000 });
  });
  // a new version downloaded: it goes in when the launcher closes, or now
  onEvent('update:ready', (u) => u && toast(t('update.ready', { version: u.version }), { kind: 'ok', icon: 'download', title: t('update.title'), timeout: 20000, action: { label: t('update.restart'), onClick: () => api('app:installUpdate').catch(() => {}) } }));
  // ---- party ----
  onEvent('party:changed', (p) => {
    store.set({ party: p });
    if (p.ended === 'leader') toast(t('party.endedLeader'), { kind: 'warn', icon: 'friends' });
    else if (p.ended === 'full') toast(t('party.full'), { kind: 'warn', icon: 'friends', timeout: 9000 });
    else if (p.ended === 'notfound') toast(t('party.notFound'), { kind: 'error', icon: 'search', timeout: 9000 });
    else if (p.ended === 'kicked') toast(t('party.kicked'), { kind: 'warn', icon: 'userMinus', timeout: 9000 });
  });
  onEvent('party:start', (d) => toast(t(d.plan?.follow ? 'party.following' : 'party.starting', { name: d.leader, server: (d.plan && d.plan.server) || '—' }), { kind: 'party', icon: 'play' }));
  // party chat: the history comes on joining, new lines as they arrive; the
  // lobby's Chat button counts the unread ones
  let inParty = false;
  store.on('party', (p) => {
    const active = !!(p && p.active);
    if (active && !inParty) api('party:chatLog').then((list) => store.set({ partyChat: list || [] })).catch(() => {});
    if (!active && inParty) store.set({ partyChat: [], partyUnread: 0 });
    inParty = active;
  });
  onEvent('party:chat', (msg) => {
    const unread = store.get('partyUnread') || 0;
    store.set({ partyChat: [...(store.get('partyChat') || []), msg].slice(-120), partyUnread: msg.self || store.get('partyPanelOpen') ? unread : unread + 1 });
  });
  initVoice();
  initTunnel();
  const invite = (code) => {
    if (!code) return;
    go('home');
    setTimeout(() => openPartyDialog({ code }), 350);
  };
  onEvent('party:invite', invite);
  api('party:takeInvite').then(invite).catch(() => {});
  // a code from the site (mclauncher://redeem/…): Settings, the code filled in
  const redeemLink = (code) => { if (code) go('settings', { redeem: code }); };
  onEvent('cosmetics:redeemLink', redeemLink);
  api('cosmetics:takeRedeemLink').then(redeemLink).catch(() => {});
  // installed on another drive, with installations on the old one: ask
  api('app:gameDirOffer').then((o) => {
    if (!o) return;
    modal({
      title: t('gamedir.title'),
      body: h('p.dialog-text', t('gamedir.text', { drive: o.drive, target: o.target, from: o.from, count: o.count })),
      buttons: [
        { label: t('gamedir.stay'), value: false },
        { label: t('gamedir.move', { drive: o.drive }), value: true, variant: 'primary' },
      ],
      onClose: async (move) => {
        if (move) toast(t('gamedir.copying', { drive: o.drive }), { kind: 'info', icon: 'folder' });
        const r = await api('app:gameDirAnswer', !!move).catch((e) => ({ error: e.message }));
        if (r && r.error) toast(r.error, { kind: 'error' });
        else if (r && r.moved) toast(t('gamedir.moved', { target: r.target }), { kind: 'ok', icon: 'folder' });
      },
    });
  }).catch(() => {});

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('.overlay') && !document.querySelector('.menu') && store.get('page') !== 'home') go('home');
    if (e.key === 'F5' && store.get('page') === 'friends') api('friends:refresh');
  });
  // Files dropped anywhere outside a drop zone must not navigate the window.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  api('versions:manifest').catch(() => store.set({ offline: true }));
}

boot().catch((e) => {
  document.getElementById('app').textContent = `Startup failed: ${e.message}`;
  console.error(e);
});
