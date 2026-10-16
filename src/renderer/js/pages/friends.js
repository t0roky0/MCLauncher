// Friends: the Microsoft account's Xbox friends with live presence.
import { h, swap, bag, debounce } from '../dom.js';
import { t } from '../i18n.js';
import { icon, blockUrl } from '../icons.js';
import { api, store, remote, timeAgo } from '../core.js';
import { button, iconButton, input, searchBox, segmented, toast, spinner, emptyState, confirmDialog, modal } from '../ui.js';
import { joinFriendLobby, lobbyLine } from '../party-ui.js';
import { dmChat } from '../dm-chat.js';
import { statTiles, serverList, itemGrid, playingChip, profileView } from '../profile-card.js';

// a friend's open lobby, if their MC Launcher announces one
const lobbyOf = (f) => (store.get('friendLobbies') || []).find((l) => l.xuid === f.xuid) || null;
// messages from their launcher (main/messenger.js)
const dmOf = (f) => ((store.get('dm') || {}).chats || {})[f.xuid] || null;
const unreadOf = (f) => (dmOf(f) || {}).unread || 0;

const DEVICE_ICON = {
  PC: 'pc', WindowsOneCore: 'pc', Win32: 'pc', Windows: 'pc',
  Scarlett: 'gamepad', XboxOne: 'gamepad', Durango: 'gamepad', Xbox360: 'gamepad',
  iOS: 'phone', Android: 'phone', Web: 'globe', Nintendo: 'gamepad',
};

function deviceName(d) {
  const key = `device.${d}`;
  const s = t(key);
  return s === key ? d : s;
}

// No gamerpic: the first letter on a colour derived from the gamertag, so
// every friend still looks distinct.
function letterTile(f, size) {
  let hash = 0;
  for (const ch of f.gamertag || '?') hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return h('div.pic-fallback', { style: { width: `${size}px`, height: `${size}px`, background: f.color || `hsl(${hue} 38% 34%)` } }, (f.gamertag || '?').slice(0, 1).toUpperCase());
}

function avatar(f, size = 40) {
  const wrap = h('div.pic', { style: size !== 40 ? { width: `${size}px`, height: `${size}px` } : null });
  if (f.avatar) {
    const img = h('img', { src: remote(f.avatar), alt: '', loading: 'lazy', style: size !== 40 ? { width: `${size}px`, height: `${size}px` } : null });
    img.addEventListener('error', () => img.replaceWith(letterTile(f, size)));
    wrap.appendChild(img);
  } else {
    wrap.appendChild(letterTile(f, size));
  }
  wrap.appendChild(h('span.status', { class: f.minecraft ? 'mc' : f.state }));
  return wrap;
}

function presenceLine(f) {
  if (f.minecraft) return { text: t('friends.playing', { title: f.minecraft }), cls: 'mc' };
  if (f.state !== 'offline') {
    if (f.activity) return { text: f.activity, cls: 'on' };
    return { text: f.presenceText || t(`friends.state.${f.state}`), cls: 'on' };
  }
  if (f.lastSeen) {
    const ms = Date.parse(f.lastSeen);
    if (ms) return { text: t('friends.lastSeen', { when: timeAgo(ms) }), cls: '' };
  }
  return { text: f.presenceText || t('friends.state.offline'), cls: '' };
}

export function mount(root, params, { go }) {
  const life = bag();
  let filter = 'all';
  let query = '';
  let selectedXuid = params.xuid || '';
  // the friend card: their profile, or the conversation with them
  let mode = params.chat ? 'chat' : 'profile';
  let chat = null;
  // friends' launcher profiles (our server): xuid → { state: loading|ok|none|error, p, at };
  // the catalogue for their items
  const launcherProfiles = new Map();
  let catalogue = null;
  let profileDialog = null; // { xuid, refresh } while a friend's profile is open
  const ruUi = () => store.get('config')?.language !== 'en';
  async function launcherProfile(xuid, force = false) {
    const had = launcherProfiles.get(xuid);
    if (had && (had.state === 'loading' || (!force && had.state !== 'error' && Date.now() - had.at < 60000))) return;
    launcherProfiles.set(xuid, { state: 'loading', p: had && had.p, at: Date.now() });
    if (selectedXuid === xuid && mode === 'profile' && had) renderDetail();
    let next;
    try {
      if (!catalogue) catalogue = (await api('cosmetics:state')).items;
      const got = await api('profiles:of', [xuid], { force });
      next = got[xuid] ? { state: 'ok', p: got[xuid], at: Date.now() } : { state: 'none', p: null, at: Date.now() };
    } catch {
      // our server didn't answer (a bad connection): said so, and tried again on the next look
      next = { state: 'error', p: had && had.p, at: Date.now() };
    }
    launcherProfiles.set(xuid, next);
    if (selectedXuid === xuid && mode === 'profile') renderDetail();
    if (profileDialog && profileDialog.xuid === xuid) profileDialog.refresh();
  }
  // what a friend's launcher says about them: the name they play under, hours, where, items
  function launcherBlock(f) {
    const r = launcherProfiles.get(f.xuid) || { state: 'loading' };
    const ru = ruUi();
    const head = (extra) => h('div.fd-pf-head',
      r.p && r.p.avatar ? h('img', { src: r.p.avatar, alt: '' }) : null,
      h('div.fa-title', ru ? 'Профиль MC Launcher' : 'MC Launcher profile', r.p && r.p.name && r.p.name !== f.gamertag ? h('div.fa-sub', `${t('accounts.javaNick')}: ${r.p.name}`) : null),
      extra);
    if (r.state === 'loading' && !r.p) return h('div.fd-pf', head(spinner()));
    if (r.state === 'none') return h('div.fd-pf.muted', head(null), h('div.hint', ru ? `${f.gamertag} ещё не заходил в MC Launcher через Xbox — профиль появится, когда зайдёт.` : `${f.gamertag} hasn't signed in to MC Launcher with Xbox yet — the profile shows up once they do.`));
    if (!r.p) return h('div.fd-pf.muted', head(button(ru ? 'Повторить' : 'Retry', { icon: 'refresh', cls: 'btn-sm', onClick: () => launcherProfile(f.xuid, true) })), h('div.hint', ru ? 'Нет связи с сервером MC Launcher — проверьте интернет или VPN.' : 'No connection to the MC Launcher server — check the internet or VPN.'));
    const p = r.p;
    return h('div.fd-pf',
      head(h('div.fd-pf-side', playingChip(p.playing), button(ru ? 'Открыть' : 'Open', { icon: 'user', cls: 'btn-sm', onClick: () => openProfile(f) }))),
      statTiles(p, (p.items || []).length, (catalogue || []).length),
      serverList(p.servers, { limit: 3 }));
  }
  // a friend's whole profile, over the page
  function openProfile(f) {
    const body = h('div.pf-dialog-body');
    const refresh = () => {
      const r = launcherProfiles.get(f.xuid) || { state: 'loading' };
      const ru = ruUi();
      if (r.p) swap(body, profileView(r.p, { gamertag: f.gamertag, picture: f.avatar ? remote(f.avatar) : '' }, catalogue));
      else if (r.state === 'loading') swap(body, h('div.pf-empty', spinner(), h('div', ru ? 'Загружаем профиль…' : 'Loading the profile…')));
      else if (r.state === 'none') swap(body, h('div.pf-empty', icon('user', { scale: 2 }), h('div', ru ? `${f.gamertag} ещё не заходил в MC Launcher через Xbox.` : `${f.gamertag} hasn't signed in to MC Launcher with Xbox yet.`)));
      else swap(body, h('div.pf-empty', icon('globe', { scale: 2 }), h('div', ru ? 'Нет связи с сервером MC Launcher.' : 'No connection to the MC Launcher server.'), button(ru ? 'Повторить' : 'Retry', { icon: 'refresh', onClick: () => launcherProfile(f.xuid, true) })));
    };
    profileDialog = { xuid: f.xuid, refresh };
    refresh();
    modal({ body, width: 900, cls: 'pf-dialog', buttons: [{ label: 'Xbox', variant: 'ghost', onClick: () => api('app:openExternal', `https://www.xbox.com/play/user/${encodeURIComponent(f.gamertag.replace(/#.*$/, ''))}`) }, { label: t('common.close'), value: null }], onClose: () => { if (profileDialog && profileDialog.xuid === f.xuid) profileDialog = null; } });
    launcherProfile(f.xuid, true);
  }

  const summary = h('div.card.friends-summary');
  const filterSeg = segmented(
    [
      { value: 'all', label: t('friends.all') },
      { value: 'online', label: t('friends.online') },
      { value: 'mc', label: t('friends.minecraft') },
      { value: 'requests', label: t('friends.requests') },
    ],
    filter,
    (v) => {
      filter = v;
      renderList();
    },
  );
  const search = searchBox({ placeholder: t('friends.search'), onInput: debounce((v) => {
    query = v.trim().toLowerCase();
    renderList();
  }, 60) });
  const listEl = h('div.friend-list');
  const leftCol = h('div.friends-col', summary, h('div.friends-filters', filterSeg, search), listEl);
  const detail = h('div.card.friend-detail');
  const body = h('div.page-body');

  const refreshBtn = button(null, { icon: 'refresh', cls: 'btn-icon', title: t('common.retry'), onClick: () => api('friends:refresh') });
  const addBtn = button(t('friends.add'), { icon: 'userPlus', onClick: () => showAdd() });
  // "X is playing Minecraft" pop-ups, on or off right where they're about
  const bellBtn = button(null, { cls: 'btn-icon', onClick: () => {
    const cfg = store.get('config') || {};
    const on = !(cfg.notifications !== false && cfg.notifyFriends);
    // turning them on also turns Windows notifications back on
    api('config:set', on ? { notifications: true, notifyFriends: true } : { notifyFriends: false }).then((c) => store.set({ config: c })).catch(() => {});
  } });
  function renderBell() {
    const cfg = store.get('config') || {};
    const on = cfg.notifications !== false && !!cfg.notifyFriends;
    swap(bellBtn, icon(on ? 'bell' : 'bellOff'));
    bellBtn.dataset.tip = on ? t('friends.notifyOn') : t('friends.notifyOff');
    bellBtn.classList.toggle('muted', !on);
  }
  renderBell();
  life.add(store.on('config', renderBell));
  root.append(h('div.page-head', button(t('nav.back'), { icon: 'back', variant: 'ghost', onClick: () => go('home') }), h('div.page-title', t('friends.title')), h('div.grow'), addBtn, bellBtn, refreshBtn), body);

  let autoPicked = !!selectedXuid;
  function showAdd() {
    selectedXuid = '';
    mode = 'profile';
    autoPicked = true;
    for (const r of listEl.querySelectorAll('.friend-row.selected')) r.classList.remove('selected');
    renderDetail();
  }

  function state() {
    return store.get('friends') || { status: 'idle', friends: [], received: [], sent: [] };
  }

  function render() {
    const s = state();
    if (s.status === 'signedOut') {
      swap(body, h('div', { style: { gridColumn: '1 / -1' } }, emptyState('friends', t('friends.signedOut.title'), t('friends.signedOut.text'), button(t('friends.signIn'), { variant: 'primary', icon: 'microsoft', onClick: () => go('accounts') }))));
      body.style.display = 'block';
      refreshBtn.style.display = 'none';
      addBtn.style.display = 'none';
      bellBtn.style.display = 'none';
      return;
    }
    if (s.status === 'needsLogin') {
      swap(body, emptyState('warning', t('friends.needsLogin.title'), t('friends.needsLogin.text'), button(t('accounts.relogin'), { variant: 'primary', icon: 'microsoft', onClick: () => go('accounts') })));
      body.style.display = 'block';
      refreshBtn.style.display = 'none';
      addBtn.style.display = 'none';
      bellBtn.style.display = 'none';
      return;
    }
    if ((s.status === 'loading' || s.status === 'idle') && !s.updatedAt) {
      swap(body, h('div.empty', spinner('lg')));
      body.style.display = 'block';
      return;
    }
    if (s.status === 'error' && !s.updatedAt) {
      swap(body, emptyState('warning', null, t('friends.error', { e: s.error }), button(t('common.retry'), { icon: 'refresh', onClick: () => api('friends:refresh') })));
      body.style.display = 'block';
      return;
    }
    body.style.display = '';
    refreshBtn.style.display = '';
    addBtn.style.display = '';
    bellBtn.style.display = '';
    // Open on whoever is most interesting right now: in Minecraft, then online.
    if (!autoPicked && s.friends.length) {
      autoPicked = true;
      const pick = s.friends.find((f) => f.minecraft) || s.friends.find((f) => f.state !== 'offline');
      if (pick) selectedXuid = pick.xuid;
    }
    if (!body.contains(leftCol)) swap(body, leftCol, detail);
    renderSummary();
    renderList();
    renderDetail();
  }

  function renderSummary() {
    const s = state();
    const me = s.me || {};
    const pic = me.avatar ? h('div.me-pic', { style: { backgroundImage: `url("${remote(me.avatar)}")` } }) : h('div.pic', { style: { width: '44px', height: '44px' } }, letterTile({ gamertag: me.gamertag || '?' }, 44));
    swap(
      summary,
      pic,
      h(
        'div.me-text',
        h('div.me-name', t('friends.me', { tag: me.gamertag || '—' })),
        h(
          'div.me-sub',
          h('span', t('friends.count', { n: s.friends.length })),
          h('span.on', t('friends.onlineCount', { n: s.online || 0 })),
          h('span.mc', t('friends.playingCount', { n: s.playing || 0 })),
          s.updatedAt ? h('span', t('friends.updated', { when: timeAgo(s.updatedAt) })) : null,
        ),
      ),
      s.error ? h('span.chip', { 'data-tip': s.error, style: { color: 'var(--bad)' } }, icon('warning')) : null,
    );
  }

  function matches(f) {
    return !query || f.gamertag.toLowerCase().includes(query) || (f.realName || '').toLowerCase().includes(query);
  }

  function joinButton(lobby, { big = false } = {}) {
    if (lobby.joined) return h('span.chip.good', t('friends.inLobby'));
    return button(t('friends.join'), {
      variant: 'primary',
      icon: 'right',
      cls: big ? 'btn-sm fd-join' : 'btn-sm fr-join',
      disabled: lobby.count >= lobby.capacity,
      onClick: (e) => {
        e.stopPropagation();
        joinFriendLobby(lobby, { after: () => go('home') });
      },
    });
  }

  function friendRow(f) {
    const p = presenceLine(f);
    const lobby = lobbyOf(f);
    const row = h(
      'div.friend-row',
      { class: [f.state === 'offline' && !f.minecraft && !lobby ? 'offline' : '', f.xuid === selectedXuid ? 'selected' : ''].join(' ') },
      avatar(f),
      h('div.fr-text', h('div.fr-name', f.gamertag, f.isFavorite ? h('span.star', { 'data-tip': t('friends.favorite') }, icon('star')) : null, unreadOf(f) ? h('span.fr-unread', { 'data-tip': t('dm.unreadTip') }, String(unreadOf(f))) : null), lobby ? h('div.fr-sub.lobby', lobbyLine(lobby)) : h('div.fr-sub', { class: p.cls }, p.text)),
      lobby ? joinButton(lobby) : h('div.fr-dev', f.devices.slice(0, 2).map((d) => h('span', { 'data-tip': deviceName(d) }, icon(DEVICE_ICON[d] || 'pc')))),
    );
    row.addEventListener('click', () => {
      // someone who wrote: straight into the conversation
      if (f.xuid !== selectedXuid) mode = unreadOf(f) ? 'chat' : 'profile';
      selectedXuid = f.xuid;
      for (const r of listEl.querySelectorAll('.friend-row.selected')) r.classList.remove('selected');
      row.classList.add('selected');
      renderDetail();
    });
    return row;
  }

  function group(title, ic, people) {
    if (!people.length) return [];
    return [h('div.friend-group', icon(ic), `${title} · ${people.length}`), ...people.map(friendRow)];
  }

  function renderList() {
    const s = state();
    if (filter === 'requests') {
      const rows = [];
      if (s.received.length) {
        rows.push(h('div.friend-group', icon('userPlus'), t('friends.received')));
        for (const r of s.received.filter(matches)) {
          rows.push(h('div.request-row', avatar(r), h('div.fr-text', h('div.fr-name', r.gamertag), h('div.fr-sub', r.realName || '')),
            button(t('friends.accept'), { variant: 'primary', cls: 'btn-sm', icon: 'check', onClick: () => act(() => api('friends:add', r.xuid)) }),
            button(null, { cls: 'btn-sm btn-icon', icon: 'x', title: t('friends.decline'), onClick: () => act(() => api('friends:remove', r.xuid)) })));
        }
      }
      if (s.sent.length) {
        rows.push(h('div.friend-group', icon('upload'), t('friends.sent')));
        for (const r of s.sent.filter(matches)) {
          rows.push(h('div.request-row', avatar(r), h('div.fr-text', h('div.fr-name', r.gamertag), h('div.fr-sub', t('friends.requestSent'))),
            button(t('friends.cancelRequest'), { cls: 'btn-sm', onClick: () => act(() => api('friends:remove', r.xuid)) })));
        }
      }
      swap(listEl, rows.length ? rows : h('div.list-empty', t('friends.emptyFilter')));
      return;
    }
    const people = s.friends.filter(matches);
    if (!s.friends.length) {
      swap(listEl, emptyState('friends', null, t('friends.empty')));
      return;
    }
    // open lobbies first, whatever the filter: that's where you can go now
    const open = people.filter((f) => lobbyOf(f));
    const rest = people.filter((f) => !lobbyOf(f));
    const mc = rest.filter((f) => f.minecraft);
    const online = rest.filter((f) => !f.minecraft && f.state !== 'offline');
    const offline = rest.filter((f) => !f.minecraft && f.state === 'offline');
    const lobbies = group(t('party.friendLobbies'), 'friends', open);
    let rows;
    if (filter === 'mc') rows = [...lobbies, ...group(t('friends.minecraft'), 'play', mc)];
    else if (filter === 'online') rows = [...lobbies, ...group(t('friends.minecraft'), 'play', mc), ...group(t('friends.online'), 'signal', online)];
    else rows = [...lobbies, ...group(t('friends.minecraft'), 'play', mc), ...group(t('friends.online'), 'signal', online), ...group(t('friends.state.offline'), 'clock', offline)];
    swap(listEl, rows.length ? rows : h('div.list-empty', t('friends.emptyFilter')));
  }

  async function act(fn, okText, ic) {
    try {
      await fn();
      if (okText) toast(okText, { kind: 'ok', icon: ic });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  function closeChat() {
    if (!chat) return;
    chat.dispose();
    chat = null;
  }

  function renderDetail() {
    const s = state();
    const f = s.friends.find((x) => x.xuid === selectedXuid);
    if (!f || mode !== 'chat' || (chat && chat.xuid !== f.xuid)) closeChat();
    detail.classList.toggle('chatting', !!f && mode === 'chat');
    if (!f) {
      swap(detail, addPanel());
      return;
    }
    if (mode === 'chat') {
      // the open conversation stays as it is (what's typed, where it's scrolled)
      if (chat) chat.update(f);
      else {
        chat = dmChat(f, { picture: avatar, onBack: () => {
          mode = 'profile';
          renderDetail();
        } });
      }
      if (!detail.contains(chat.el)) swap(detail, chat.el);
      return;
    }
    const pic = h('div.fd-pic', f.avatar ? h('img', { src: remote(f.avatar), alt: '' }) : letterTile(f, 96), h('span.status', { class: f.minecraft ? 'mc' : f.state }));
    const stateChip = f.minecraft
      ? h('span.chip.acc', icon('play'), t('friends.minecraft'))
      : f.state === 'offline'
        ? h('span.chip', t('friends.state.offline'))
        : h('span.chip.good', t(`friends.state.${f.state}`));
    const hero = h('div.fd-hero', { style: f.color ? { '--fd-color': `${f.color}66` } : null }, pic, h('div.fd-name', f.gamertag), f.realName ? h('div.fd-real', f.realName) : null, h('div.fd-state', stateChip));

    const p = presenceLine(f);
    const activity = h(
      'div.fd-activity',
      { class: f.minecraft ? 'mc' : '' },
      f.minecraft ? h('img.fa-icon', { src: blockUrl('grass'), alt: '' }) : h('div', { style: { color: 'var(--dim)' } }, icon(DEVICE_ICON[f.devices[0]] || 'clock', { scale: 3 })),
      h('div', h('div.fa-title', f.minecraft ? f.minecraftTitle || 'Minecraft' : f.state === 'offline' ? t('friends.state.offline') : f.activity || t(`friends.state.${f.state}`)), h('div.fa-sub', p.text)),
    );

    const lobby = lobbyOf(f);
    const lobbyCard = lobby
      ? h('div.fd-lobby', h('div.fl-ic', icon('friends')), h('div.fl-text', h('div.fa-title', t('friends.lobbyTitle')), h('div.fa-sub', [t('friends.lobbyPlayers', { n: lobby.count, cap: lobby.capacity }), lobby.installName].filter(Boolean).join(' · '))), joinButton(lobby, { big: true }))
      : null;

    const stats = h(
      'div.fd-stats',
      h('div.fd-stat', h('div.k', t('friends.gamerscore')), h('div.v', String(f.gamerscore || 0))),
      h('div.fd-stat', h('div.k', t('friends.devices')), h('div.v', f.devices.length ? f.devices.map(deviceName).join(', ') : '—')),
      f.followers != null ? h('div.fd-stat', h('div.k', t('friends.followers')), h('div.v', String(f.followers))) : null,
      f.tier ? h('div.fd-stat', h('div.k', 'Xbox'), h('div.v', f.tier)) : null,
    );
    const unread = unreadOf(f);
    const writeBtn = button(unread ? t('dm.writeUnread', { n: unread }) : t('dm.write'), { icon: 'chat', variant: unread ? 'primary' : 'secondary', onClick: () => {
      mode = 'chat';
      renderDetail();
    } });
    const actions = h(
      'div.fd-actions',
      writeBtn,
      button(t('friends.profile'), { icon: 'user', onClick: () => openProfile(f) }),
      button(t('friends.remove'), { icon: 'userMinus', variant: 'ghost', onClick: async () => {
        if (!(await confirmDialog(t('confirm.removeFriend.title'), t('confirm.removeFriend.text', { name: f.gamertag })))) return;
        selectedXuid = '';
        act(() => api('friends:remove', f.xuid), t('toast.friendRemoved', { name: f.gamertag }), 'userMinus');
      } }),
    );
    const dm = dmOf(f);
    const launcher = dm && dm.launcher ? h('div.fd-mcl', icon('chat'), t('dm.hasLauncher')) : null;
    launcherProfile(f.xuid);
    swap(detail, hero, h('div.fd-body', lobbyCard, activity, launcherBlock(f), stats, launcher, f.bio ? h('div.hint', f.bio) : null, actions));
  }

  let lastResults = null;
  let lastQuery = '';
  function addPanel() {
    const s = state();
    const results = h('div.add-results');
    const inp = input({ placeholder: t('friends.addPlaceholder'), maxLength: 32, value: lastQuery, onEnter: () => find() });
    const findBtn = button(t('friends.find'), { variant: 'primary', icon: 'search', onClick: () => find() });
    const known = new Set(s.friends.map((f) => f.xuid));
    const sent = new Set(s.sent.map((f) => f.xuid));

    function renderResults(list) {
      if (!list) return;
      if (!list.length) {
        swap(results, h('div.muted', t('friends.noResults')));
        return;
      }
      swap(
        results,
        list.map((p) => {
          const btn = known.has(p.xuid)
            ? h('span.chip.good', t('friends.alreadyFriend'))
            : sent.has(p.xuid)
              ? h('span.chip', t('friends.requestSent'))
              : button(t('friends.sendRequest'), { variant: 'primary', cls: 'btn-sm', icon: 'userPlus', onClick: () => act(async () => {
                await api('friends:add', p.xuid);
                sent.add(p.xuid);
                renderResults(lastResults);
              }, t('toast.friendRequestSent', { name: p.gamertag }), 'userPlus') });
          return h('div.add-result', avatar(p, 36), h('div.fr-text', h('div.fr-name', p.gamertag), h('div.fr-sub', p.realName || (p.gamerscore ? `G ${p.gamerscore}` : ''))), btn);
        }),
      );
    }

    async function find() {
      const q = inp.value.trim();
      if (!q) return;
      lastQuery = q;
      findBtn.disabled = true;
      swap(results, spinner());
      try {
        lastResults = await api('friends:search', q);
        renderResults(lastResults);
      } catch (e) {
        swap(results, h('div.muted', e.message));
      }
      findBtn.disabled = false;
    }
    renderResults(lastResults);

    const req = s.received.length
      ? h('div.note', { style: { cursor: 'pointer' }, onclick: () => {
        filter = 'requests';
        filterSeg.setValue('requests');
        renderList();
      } }, icon('userPlus'), `${t('friends.received')}: ${s.received.length}`)
      : null;
    return h(
      'div.fd-body',
      h('div.section-title', icon('userPlus'), t('friends.add')),
      h('div.row', h('div.grow', inp), findBtn),
      results,
      req,
      h('div.hint', t('friends.pick')),
    );
  }

  life.add(store.on(['friends', 'friendLobbies'], render));
  // unread counts and who has MC Launcher; an open conversation keeps itself
  life.add(store.on('dm', () => {
    if (!body.contains(leftCol)) return;
    renderList();
    if (mode !== 'chat') renderDetail();
  }));
  life.add(closeChat);
  render();
  // Opening the tab is a good moment for fresh presence.
  const s = state();
  if (s.status !== 'signedOut' && Date.now() - (s.updatedAt || 0) > 20000) api('friends:refresh').catch(() => {});
  const timer = setInterval(() => renderSummary(), 30000);
  life.add(() => clearInterval(timer));
  return () => life.dispose();
}
