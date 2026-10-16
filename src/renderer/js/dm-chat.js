// A conversation with an Xbox friend, launcher to launcher (main/messenger.js):
// sealed between the two launchers; while the friend's launcher is closed a
// message waits on this PC. Lives in the friend card on the Friends page.
import { h, swap } from './dom.js';
import { t, getLang } from './i18n.js';
import { icon } from './icons.js';
import { api, store } from './core.js';
import { button, toast, confirmDialog } from './ui.js';
import { STICKER_IDS, stickerUrl } from './stickers.js';

const clock = (ms) => new Date(ms).toLocaleTimeString(getLang() === 'en' ? 'en-GB' : 'ru-RU', { hour: '2-digit', minute: '2-digit' });

function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return t('dm.today');
  if (d.toDateString() === yesterday.toDateString()) return t('dm.yesterday');
  return d.toLocaleDateString(getLang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

const STATE_ICON = { waiting: 'clock', sent: 'check', delivered: 'checks', read: 'checks' };

// f: the friend (friends store), picture(f, size): their gamer pic
export function dmChat(f, { picture, onBack }) {
  let friend = f;
  let conv = { xuid: f.xuid, launcher: false, pending: false, msgs: [] };
  const el = h('div.dm');
  const status = h('div.dm-status');
  const pic = h('div.dm-pic');
  const nameEl = h('div.dm-name');
  const banner = h('div.dm-banners');
  const log = h('div.dm-log');
  const input = h('textarea.dm-text', { rows: 1, maxLength: 1000, spellcheck: false });
  const stickers = h(
    'div.pp-stickers',
    { hidden: true },
    STICKER_IDS.map((id) => h('button.pp-sticker', { type: 'button', title: t(`sticker.${id}`), onclick: () => say({ sticker: id }) }, h('img', { src: stickerUrl(id, true), alt: '' }))),
  );
  const stickerBtn = button(null, { icon: 'smile', cls: 'btn-icon pp-stk-btn', title: t('chat.stickers'), onClick: () => toggleStickers() });
  const sendBtn = button(null, { icon: 'send', cls: 'btn-icon', title: t('chat.send'), onClick: () => sendText() });
  const head = h(
    'div.dm-head',
    button(null, { icon: 'back', cls: 'btn-sm btn-icon', title: t('dm.profile'), onClick: () => onBack && onBack() }),
    pic,
    h('div.dm-who', nameEl, status),
    button(null, { icon: 'trash', cls: 'btn-sm btn-icon', title: t('dm.clear'), onClick: () => clearChat() }),
  );
  el.append(head, banner, log, stickers, h('div.dm-compose', stickerBtn, input, sendBtn));

  function toggleStickers(force) {
    stickers.hidden = typeof force === 'boolean' ? !force : !stickers.hidden;
    stickerBtn.classList.toggle('active', !stickers.hidden);
  }

  async function say(msg) {
    try {
      await api('messages:send', friend.xuid, msg);
      toggleStickers(false);
    } catch (e) {
      toast(e.message, { kind: 'warn' });
    }
  }

  function sendText() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    grow();
    say({ text });
  }

  // Enter sends, Shift+Enter starts a new line; the box grows to four lines
  function grow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight + 4, 96)}px`;
  }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    } else if (e.key === 'Escape') toggleStickers(false);
  });

  async function clearChat() {
    if (!conv.msgs.length) return;
    if (!(await confirmDialog(t('dm.clearTitle'), t('dm.clearText', { name: friend.gamertag })))) return;
    conv = await api('messages:clear', friend.xuid).catch(() => conv);
    renderLog();
  }

  async function trust() {
    conv = await api('messages:trust', friend.xuid).catch(() => conv);
    renderBanner();
    renderLog();
  }

  function renderHead() {
    swap(pic, picture(friend, 32));
    nameEl.textContent = friend.gamertag;
    const online = friend.minecraft || friend.state !== 'offline';
    swap(
      status,
      h('span', { class: online ? 'on' : '' }, friend.minecraft ? t('friends.minecraft') : t(`friends.state.${friend.state}`)),
      conv.launcher ? h('span.mcl', { 'data-tip': t('dm.hasLauncherTip') }, '· MC Launcher') : null,
    );
    input.placeholder = t('dm.placeholder', { name: friend.gamertag });
  }

  function renderBanner() {
    if (conv.pending) {
      swap(banner, h('div.dm-banner.warn', h('div.dm-banner-ic', icon('warning')), h('div.dm-banner-title', t('dm.newKeyTitle')), h('div.dm-banner-text', t('dm.newKey', { name: friend.gamertag })), h('div.dm-banner-act', button(t('dm.trust'), { variant: 'primary', cls: 'btn-sm', icon: 'check', onClick: () => trust() }))));
    } else if (!conv.launcher) {
      swap(banner, h('div.dm-banner', h('div.dm-banner-ic', icon('info')), h('div.dm-banner-title', t('dm.noLauncherTitle')), h('div.dm-banner-text', t('dm.noLauncher', { name: friend.gamertag }))));
    } else swap(banner);
  }

  function stateMark(m) {
    if (!m.self || !STATE_ICON[m.state]) return null;
    return h(`span.dm-state.${m.state}`, { 'data-tip': t(`dm.state.${m.state}`) }, icon(STATE_ICON[m.state], { scale: 1 }));
  }

  function renderLog() {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (!conv.msgs.length) {
      swap(log, h('div.dm-empty', icon('chat', { scale: 3 }), h('div', t('dm.empty', { name: friend.gamertag }))));
      return;
    }
    const rows = [];
    let day = '';
    let prev = null;
    for (const m of conv.msgs) {
      const d = new Date(m.at).toDateString();
      if (d !== day) {
        day = d;
        prev = null;
        rows.push(h('div.dm-day', dayLabel(m.at)));
      }
      if (m.sys) {
        rows.push(h(`div.dm-sys.${m.sys === 'newKey' ? 'warn' : 'good'}`, h('span.dm-sys-ic', icon(m.sys === 'newKey' ? 'warning' : 'check', { scale: 1 })), t(m.sys === 'newKey' ? 'dm.sysNewKey' : 'dm.sysTrusted', { name: friend.gamertag })));
        prev = null;
        continue;
      }
      const grouped = prev && !!prev.self === !!m.self && m.at - prev.at < 120000;
      prev = m;
      const body = m.sticker ? h('img.dm-sticker', { src: stickerUrl(m.sticker), alt: t(`sticker.${m.sticker}`) }) : h('div.dm-msg-text', m.text);
      const meta = h('div.dm-meta', clock(m.at), stateMark(m));
      const badge = m.unverified ? h('span.dm-unv', { 'data-tip': t('dm.unverified') }, icon('warning', { scale: 1 })) : null;
      rows.push(h(`div.dm-msg${m.self ? '.self' : ''}${grouped ? '.grouped' : ''}${m.sticker ? '.stk' : ''}${m.unverified ? '.unv' : ''}`, h('div.dm-bubble', badge, body, meta)));
    }
    swap(log, rows);
    const last = conv.msgs[conv.msgs.length - 1];
    if (atBottom || (last && last.self && Date.now() - last.at < 3000)) log.scrollTop = log.scrollHeight;
  }

  function show(c) {
    const first = !conv.msgs.length && c.msgs.length;
    conv = c;
    renderHead();
    renderBanner();
    renderLog();
    if (first) log.scrollTop = log.scrollHeight;
  }

  const off = store.on('dmChats', (list) => {
    const c = (list || []).find((x) => x.xuid === friend.xuid);
    if (c) show(c);
  });
  renderHead();
  renderBanner();
  renderLog();
  api('messages:get', friend.xuid).then(show).catch(() => {});
  api('messages:open', friend.xuid).catch(() => {});
  setTimeout(() => {
    log.scrollTop = log.scrollHeight;
    input.focus();
  }, 30);

  return {
    el,
    xuid: f.xuid,
    // fresh presence for the head; the conversation itself stays as it is
    update(next) {
      friend = next;
      renderHead();
    },
    dispose() {
      off();
      api('messages:open', '').catch(() => {});
    },
  };
}
