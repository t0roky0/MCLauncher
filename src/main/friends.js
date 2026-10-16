'use strict';
// The Friends tab.
//
// No server of our own: a Minecraft account *is* a Microsoft account, and
// Microsoft accounts have an Xbox social graph. With the Xbox Live token the
// sign-in already produces (auth.xboxAuth) we read that graph directly:
//
//   peoplehub.xboxlive.com  friends, friend requests, search — each person
//                           decorated with presence: online/away/offline,
//                           what they're running (title + rich presence),
//                           on which device, when they were last seen.
//   social.xboxlive.com     send/accept a friend request, remove a friend.
//
// Presence is polled — every 45 s while the tab is open, less often in the
// background, where the poll exists to notify "X is playing Minecraft".

const { Notification } = require('electron');
const net = require('./net');
const auth = require('./auth');
const config = require('./config');
const log = require('./log');

const PEOPLEHUB = 'https://peoplehub.xboxlive.com';
const SOCIAL = 'https://social.xboxlive.com';
const PROFILE = 'https://profile.xboxlive.com';
const DECORATIONS = 'detail,preferredColor,presenceDetail,multiplayerSummary';
const MINECRAFT_RE = /minecraft|майнкрафт/i;
// Microsoft accounts, with Java or without ("xbox"), both carry Xbox tokens.
const hasXbox = (acc) => !!acc && (acc.type === 'msa' || acc.type === 'xbox');

const state = {
  status: 'idle', // idle | signedOut | needsLogin | loading | ok | error
  accountId: '',
  me: null,
  friends: [],
  received: [],
  sent: [],
  updatedAt: 0,
  error: '',
};
const listeners = new Set();
let timer = null;
let inflight = null;
let windowVisible = true;
let pageActive = false;
let known = new Map();
let firstLoad = true;
let onNotificationClick = () => {};
let lastSummary = '';

function emit() {
  const snap = getState();
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch {
      /* ignore */
    }
  }
}

function getState() {
  return {
    ...state,
    friends: state.friends.slice(),
    received: state.received.slice(),
    sent: state.sent.slice(),
    online: state.friends.filter((f) => f.state !== 'offline').length,
    playing: state.friends.filter((f) => f.minecraft).length,
  };
}

async function call(accountId, url, { method = 'GET', contract = '7', body } = {}) {
  const { header } = await auth.xboxAuth(accountId);
  const lang = config.get().language === 'en' ? 'en-US' : 'ru-RU';
  const headers = {
    Authorization: header,
    'x-xbl-contract-version': contract,
    'Accept-Language': lang,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return net.request(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    expect: method === 'GET' ? 'json' : 'text',
    retries: 1,
  });
}

function avatarUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (!u.searchParams.has('w')) u.searchParams.set('w', '128');
    if (!u.searchParams.has('h')) u.searchParams.set('h', '128');
    if (!u.searchParams.has('format')) u.searchParams.set('format', 'png');
    return u.toString();
  } catch {
    return raw;
  }
}

function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return undefined;
}

function normalize(p) {
  const details = (p.presenceDetails || []).map((d) => ({
    title: pick(d, 'PresenceText', 'presenceText') || '',
    rich: pick(d, 'RichPresenceText', 'richPresenceText') || '',
    device: pick(d, 'Device', 'device') || '',
    state: pick(d, 'State', 'state') || '',
    isGame: !!pick(d, 'IsGame', 'isGame'),
    primary: !!pick(d, 'IsPrimary', 'isPrimary'),
    titleId: String(pick(d, 'TitleId', 'titleId') || ''),
  }));
  const presence = String(p.presenceState || 'Offline').toLowerCase();
  // An offline friend still carries their last title, as a "LastSeen"
  // detail ("Last seen 96d ago: Minecraft"); only live details count.
  const live = presence === 'offline' ? [] : details.filter((d) => !/^lastseen$/i.test(d.state));
  const mc = live.find((d) => MINECRAFT_RE.test(d.title) || MINECRAFT_RE.test(d.rich));
  const game = live.find((d) => d.isGame && d.primary) || live.find((d) => d.isGame) || live.find((d) => d.primary);
  const modern = p.modernGamertag
    ? `${p.modernGamertag}${p.modernGamertagSuffix ? `#${p.modernGamertagSuffix}` : ''}`
    : '';
  const gamertag = modern || p.gamertag || p.displayName || p.xuid;
  const detail = p.detail || {};
  const color = p.preferredColor && p.preferredColor.primaryColor ? `#${p.preferredColor.primaryColor}` : '';
  return {
    xuid: String(p.xuid || ''),
    gamertag,
    displayName: p.displayName || gamertag,
    realName: p.realName || '',
    avatar: avatarUrl(p.displayPicRaw),
    color,
    state: presence === 'online' ? 'online' : presence === 'away' ? 'away' : 'offline',
    presenceText: p.presenceText || '',
    details,
    minecraft: mc ? mc.rich || mc.title : '',
    minecraftTitle: mc ? mc.title : '',
    activity: game ? (game.rich && game.rich !== game.title ? `${game.title} — ${game.rich}` : game.title) : '',
    devices: [...new Set(details.map((d) => d.device).filter(Boolean))],
    lastSeen: p.lastSeenDateTimeUtc || '',
    gamerscore: Number(p.gamerScore) || 0,
    isFavorite: !!p.isFavorite,
    isFriend: p.isFriend !== false,
    requestReceived: !!p.isFriendRequestReceived,
    requestSent: !!p.isFriendRequestSent,
    followers: detail.followerCount != null ? Number(detail.followerCount) : null,
    friendCount: detail.friendCount != null ? Number(detail.friendCount) : null,
    bio: detail.bio || '',
    tier: detail.accountTier || '',
    gamePass: !!detail.hasGamePass,
  };
}

const RANK = { online: 0, away: 1, offline: 2 };

function sortPeople(list) {
  return list.sort((a, b) => {
    if (!!b.minecraft - !!a.minecraft) return !!b.minecraft - !!a.minecraft;
    if (RANK[a.state] !== RANK[b.state]) return RANK[a.state] - RANK[b.state];
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    return a.gamertag.localeCompare(b.gamertag, undefined, { sensitivity: 'base' });
  });
}

async function loadList(accountId, selector) {
  const r = await call(accountId, `${PEOPLEHUB}/users/me/people/${selector}/decoration/${DECORATIONS}`);
  return (r.people || []).map(normalize);
}

async function loadMe(acc) {
  try {
    const r = await call(
      acc.id,
      `${PROFILE}/users/me/profile/settings?settings=GameDisplayPicRaw,Gamertag,Gamerscore,ModernGamertag,ModernGamertagSuffix`,
      { contract: '3' },
    );
    const u = (r.profileUsers || [])[0];
    if (!u) return null;
    const s = Object.fromEntries((u.settings || []).map((x) => [x.id, x.value]));
    return {
      xuid: String(u.id || acc.xuid || ''),
      gamertag: s.ModernGamertag
        ? `${s.ModernGamertag}${s.ModernGamertagSuffix ? `#${s.ModernGamertagSuffix}` : ''}`
        : s.Gamertag || acc.gamertag,
      avatar: avatarUrl(s.GameDisplayPicRaw),
      gamerscore: Number(s.Gamerscore) || 0,
    };
  } catch (e) {
    log.warn(`Xbox profile: ${e.message}`);
    return { xuid: acc.xuid || '', gamertag: acc.gamertag || '', avatar: '', gamerscore: 0 };
  }
}

// Windows notification by default; index.js routes them into the window
// instead while it's in front (setNotifier). look: {avatar, icon, kind}.
let notifier = null;

async function notify(title, body, look = {}) {
  if (config.get().notifications === false) return;
  if (notifier && notifier({ title, body, look })) return;
  if (!Notification.isSupported()) return;
  const icon = await require('./notify-icons').picture(look);
  const n = new Notification({ title, body, icon, silent: false });
  n.on('click', () => onNotificationClick());
  n.show();
}

function announceChanges() {
  const cfg = config.get();
  const ru = cfg.language !== 'en';
  const shown = [];
  if (!firstLoad && cfg.notifyFriends) {
    for (const f of state.friends) {
      const prev = known.get(f.xuid);
      if (!prev) continue;
      if (f.minecraft && !prev.minecraft) {
        shown.push([ru ? `${f.gamertag} играет в Minecraft` : `${f.gamertag} is playing Minecraft`, f.minecraft, { avatar: f.avatar, icon: 'gamepad', kind: 'online' }]);
      } else if (prev.state === 'offline' && f.state !== 'offline') {
        shown.push([ru ? `${f.gamertag} в сети` : `${f.gamertag} is online`, f.activity || f.presenceText, { avatar: f.avatar, icon: 'lamp', kind: 'online' }]);
      }
    }
    for (const r of state.received) {
      if (!known.has(`req:${r.xuid}`)) {
        shown.push([ru ? 'Заявка в друзья' : 'Friend request', ru ? `${r.gamertag} хочет добавить вас в друзья` : `${r.gamertag} wants to be friends`, { avatar: r.avatar, icon: 'userPlus', kind: 'request' }]);
      }
    }
    // A burst (e.g. the PC waking from sleep) collapses into one toast.
    if (shown.length > 3) {
      notify(ru ? 'Друзья в сети' : 'Friends online', shown.map((s) => s[0]).join(', '), { icon: 'friends', kind: 'online' });
    } else {
      for (const [t, b, look] of shown) notify(t, b || '', look);
    }
  }
  known = new Map(state.friends.map((f) => [f.xuid, { state: f.state, minecraft: f.minecraft }]));
  for (const r of state.received) known.set(`req:${r.xuid}`, true);
  firstLoad = false;
}

function schedule() {
  clearTimeout(timer);
  const acc = auth.activeAccount();
  if (!acc || !hasXbox(acc) || state.status === 'needsLogin') return;
  const ms = pageActive && windowVisible ? 45000 : windowVisible ? 90000 : 180000;
  timer = setTimeout(() => refresh({ quiet: true }), ms);
}

// MCL_MOCK_FRIENDS=1: a made-up friends list, for working on the tab's
// layout without a signed-in account.
function mockState() {
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const p = (gamertag, state, extra = {}) => ({
    xuid: String(2535400000000000 + gamertag.length * 977 + gamertag.charCodeAt(0)),
    gamertag, displayName: gamertag, realName: '', avatar: '', color: '', state, presenceText: '', details: [],
    minecraft: '', minecraftTitle: '', activity: '', devices: [], lastSeen: '', gamerscore: 1000 + gamertag.length * 731,
    isFavorite: false, isFriend: true, requestReceived: false, requestSent: false, followers: 12, friendCount: 30, bio: '', tier: 'Gold', gamePass: false,
    ...extra,
  });
  const friends = sortPeople([
    p('FriendOne', 'online', { minecraft: 'Minecraft: Java Edition', minecraftTitle: 'Minecraft Launcher', activity: 'Minecraft Launcher', devices: ['WindowsOneCore'], isFavorite: true }),
    p('NotchFan2009', 'online', { minecraft: 'Survival, Overworld', minecraftTitle: 'Minecraft', activity: 'Minecraft — Survival, Overworld', devices: ['Scarlett'] }),
    p('CreeperQueen', 'online', { activity: 'Forza Horizon 5', devices: ['WindowsOneCore'], realName: 'Аня' }),
    p('BlockBuilder', 'away', { activity: 'Xbox App', devices: ['WindowsOneCore'] }),
    p('Steve_RU', 'offline', { lastSeen: ago(42), presenceText: 'Last seen 42m ago: Minecraft Launcher' }),
    // Offline, last seen in Minecraft: must not count as playing.
    normalize({ xuid: '2535400000099001', gamertag: 'OldMiner', presenceState: 'Offline', presenceText: 'Last seen 96d ago: Minecraft', gamerScore: 535,
      presenceDetails: [{ Device: 'PC', PresenceText: 'Last seen 96d ago: Minecraft', State: 'LastSeen', IsGame: true, IsPrimary: true, TitleId: '1828326430' }] }),
    p('EnderPearl', 'offline', { lastSeen: ago(60 * 26) }),
    p('Redstoner', 'offline', { lastSeen: ago(60 * 24 * 9) }),
  ]);
  return {
    status: 'ok', accountId: 'mock', me: { xuid: '1', gamertag: 'PlohayaTyan', avatar: '', gamerscore: 4210 }, friends,
    received: [p('NewGuy777', 'online', { requestReceived: true })], sent: [p('Pro100Mine', 'offline', { requestSent: true })],
    updatedAt: Date.now(), error: '',
  };
}

function refresh({ quiet = false } = {}) {
  if (process.env.MCL_MOCK_FRIENDS) {
    Object.assign(state, mockState());
    emit();
    return Promise.resolve(getState());
  }
  const acc = auth.activeAccount();
  if (!acc || !hasXbox(acc)) {
    Object.assign(state, { status: 'signedOut', accountId: acc ? acc.id : '', me: null, friends: [], received: [], sent: [], error: '' });
    known.clear();
    firstLoad = true;
    clearTimeout(timer);
    emit();
    return Promise.resolve(getState());
  }
  if (inflight) return inflight;
  inflight = (async () => {
    if (state.accountId !== acc.id) {
      Object.assign(state, { me: null, friends: [], received: [], sent: [], updatedAt: 0 });
      known.clear();
      firstLoad = true;
    }
    state.accountId = acc.id;
    if (acc.needsLogin || !config.getSecrets(acc.id)) {
      state.status = 'needsLogin';
      emit();
      return getState();
    }
    if (!quiet || !state.updatedAt) {
      state.status = state.updatedAt ? state.status : 'loading';
      emit();
    }
    try {
      const friendsP = loadList(acc.id, 'friends').catch((e) => {
        if (e.status === 400 || e.status === 404) return loadList(acc.id, 'social');
        throw e;
      });
      const [friends, received, sent, me] = await Promise.all([
        friendsP,
        loadList(acc.id, 'friendRequests(received)').catch(() => []),
        loadList(acc.id, 'friendRequests(sent)').catch(() => []),
        state.me && state.me.xuid ? Promise.resolve(state.me) : loadMe(acc),
      ]);
      state.friends = sortPeople(friends);
      state.received = received;
      state.sent = sent;
      state.me = me;
      state.status = 'ok';
      state.error = '';
      state.updatedAt = Date.now();
      // one line when the picture changes: lets a "nobody's online" be told
      // apart from a presence that doesn't come through
      const online = state.friends.filter((f) => f.state !== 'offline').length;
      const playing = state.friends.filter((f) => f.minecraft).length;
      const summary = `${state.friends.length}/${online}/${playing}`;
      if (summary !== lastSummary) {
        lastSummary = summary;
        log.info(`Friends: ${state.friends.length}, online ${online}, in Minecraft ${playing}.`);
      }
      announceChanges();
    } catch (e) {
      const expired = e.code === 'expired';
      state.status = expired ? 'needsLogin' : state.updatedAt ? 'ok' : 'error';
      state.error = expired ? '' : net.describe(e);
      if (!expired) log.warn(`Friends: ${state.error}`);
    } finally {
      inflight = null;
      emit();
      schedule();
    }
    return getState();
  })();
  return inflight;
}

async function search(query) {
  const acc = auth.activeAccount();
  const q = String(query || '').trim();
  if (!acc || !hasXbox(acc) || !q) return [];
  try {
    const r = await call(
      acc.id,
      `${PEOPLEHUB}/users/me/people/search/decoration/detail,preferredColor,presenceDetail?q=${encodeURIComponent(q)}&maxItems=25`,
    );
    return (r.people || []).map(normalize);
  } catch (e) {
    log.warn(`Xbox search failed (${e.message}) — trying an exact gamertag lookup.`);
    try {
      const r = await call(
        acc.id,
        `${PROFILE}/users/gt(${encodeURIComponent(q)})/profile/settings?settings=GameDisplayPicRaw,Gamertag,Gamerscore,ModernGamertag,ModernGamertagSuffix`,
        { contract: '3' },
      );
      return (r.profileUsers || []).map((u) => {
        const s = Object.fromEntries((u.settings || []).map((x) => [x.id, x.value]));
        return normalize({
          xuid: u.id,
          gamertag: s.Gamertag,
          modernGamertag: s.ModernGamertag,
          modernGamertagSuffix: s.ModernGamertagSuffix,
          displayPicRaw: s.GameDisplayPicRaw,
          gamerScore: s.Gamerscore,
          isFriend: state.friends.some((f) => f.xuid === String(u.id)),
        });
      });
    } catch (e2) {
      if (e2.status === 404) return [];
      throw new Error(net.describe(e2));
    }
  }
}

async function addFriend(xuid) {
  const acc = auth.activeAccount();
  if (!acc || !hasXbox(acc)) throw new Error('Нужен аккаунт Microsoft.');
  try {
    await call(acc.id, `${SOCIAL}/users/me/people/friends/v2/xuid(${xuid})`, { method: 'PUT', contract: '3' });
  } catch (e) {
    if (e.status !== 400 && e.status !== 404) throw new Error(net.describe(e));
    // Accounts still on the old one-way "follow" model.
    await call(acc.id, `${SOCIAL}/users/me/people/xuids?method=add`, { method: 'POST', contract: '2', body: { xuids: [xuid] } });
  }
  log.info(`Friend request sent/accepted: ${xuid}`);
  await refresh({ quiet: true });
}

async function removeFriend(xuid) {
  const acc = auth.activeAccount();
  if (!acc || !hasXbox(acc)) throw new Error('Нужен аккаунт Microsoft.');
  try {
    await call(acc.id, `${SOCIAL}/users/me/people/friends/v2/xuid(${xuid})?deleteRelationships=friends`, {
      method: 'DELETE',
      contract: '3',
    });
  } catch (e) {
    if (e.status !== 400 && e.status !== 404) throw new Error(net.describe(e));
    await call(acc.id, `${SOCIAL}/users/me/people/xuids?method=remove`, { method: 'POST', contract: '2', body: { xuids: [xuid] } });
  }
  log.info(`Friend removed / request withdrawn: ${xuid}`);
  await refresh({ quiet: true });
}

function setVisibility({ visible, page } = {}) {
  const wasActive = pageActive && windowVisible;
  if (typeof visible === 'boolean') windowVisible = visible;
  if (typeof page === 'boolean') pageActive = page;
  const nowActive = pageActive && windowVisible;
  // Opening the tab after a while away refreshes right away rather than
  // showing presence that may be minutes old.
  if (nowActive && !wasActive && Date.now() - state.updatedAt > 20000) refresh({ quiet: true });
  else schedule();
}

module.exports = {
  getState,
  refresh,
  search,
  addFriend,
  removeFriend,
  setVisibility,
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  setNotifier(fn) {
    notifier = fn;
  },
  setNotificationHandler(fn) {
    onNotificationClick = fn;
  },
  start() {
    refresh({ quiet: true });
  },
};
