// The party panel in the lobby: the voice chat (join, mic, deafen, how the
// mic opens), who's in with their own volume, and the text chat with pixel
// stickers. Closing it doesn't end the call — that goes on, in-game too.
import { h, swap } from './dom.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { api, store } from './core.js';
import { button, toast, slider, segmented } from './ui.js';
import { skinFace, STEVE } from './skin3d.js';
import { STICKER_IDS, stickerUrl } from './stickers.js';
import * as voice from './voice.js';
import { memberVoice, paintVoice } from './voice-indicator.js';
import { kickMember } from './party-ui.js';
import { openVoiceSettings } from './voice-settings.js';

export { openVoiceSettings };

const faces = new Map();
function faceImg(m, size = 24) {
  const img = h('img.pp-face', { alt: '', width: size, height: size });
  const key = `${m.id}|${(m.skin || '').length}`;
  if (faces.has(key)) img.src = faces.get(key);
  else {
    skinFace(m.skin || STEVE, 32)
      .then((d) => {
        faces.set(key, d);
        img.src = d;
      })
      .catch(() => {});
  }
  return img;
}

const clock = (at) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const MODES = () => [
  { value: 'vad', label: t('voice.modeVad') },
  { value: 'ptt', label: t('voice.modePtt') },
  { value: 'open', label: t('voice.modeOpen') },
];

export function partyPanel({ onClose }) {
  const el = h('div.party-panel');
  const head = h('div.pp-head');
  const voiceBox = h('div.pp-voice');
  const membersBox = h('div.pp-members');
  const log = h('div.pp-log');
  const input = h('input.pp-text', { type: 'text', maxLength: 500, placeholder: t('chat.placeholder'), spellcheck: false });
  const stickers = h(
    'div.pp-stickers',
    { hidden: true },
    STICKER_IDS.map((id) => h('button.pp-sticker', { type: 'button', title: t(`sticker.${id}`), onclick: () => say({ sticker: id }) }, h('img', { src: stickerUrl(id, true), alt: '' }))),
  );
  const stickerBtn = button(null, { icon: 'smile', cls: 'btn-icon pp-stk-btn', title: t('chat.stickers'), onClick: () => toggleStickers() });
  const sendBtn = button(null, { icon: 'send', cls: 'btn-icon', title: t('chat.send'), onClick: () => sendText() });
  el.append(head, voiceBox, membersBox, h('div.pp-chat', log, stickers, h('div.pp-compose', stickerBtn, input, sendBtn)));

  function toggleStickers(force) {
    stickers.hidden = typeof force === 'boolean' ? !force : !stickers.hidden;
    stickerBtn.classList.toggle('active', !stickers.hidden);
  }

  async function say(msg) {
    try {
      await api('party:say', msg);
      toggleStickers(false);
    } catch (e) {
      toast(e.message, { kind: 'warn' });
    }
  }

  function sendText() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    say({ text });
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendText();
    } else if (e.key === 'Escape') toggleStickers(false);
  });

  // ---- head ------------------------------------------------------------------------
  function renderHead() {
    const p = store.get('party') || {};
    swap(
      head,
      icon('friends'),
      h('div.pp-title', t('party.short'), h('span.pp-code', p.code || '')),
      h('span.pp-count', `${(p.members || []).length}/5`),
      button(null, { icon: 'x', cls: 'btn-icon pp-close', title: t('chat.close'), onClick: () => onClose && onClose() }),
    );
  }

  // ---- voice -------------------------------------------------------------------------
  const meter = h('div.pp-meter', h('div.pp-meter-fill'), h('div.pp-meter-mark'));
  const talk = h('div.pp-talk');
  function renderVoice() {
    const v = voice.voiceState();
    if (!v.on) {
      swap(
        voiceBox,
        button(v.joining ? t('voice.joining') : t('voice.join'), {
          icon: 'mic',
          variant: 'primary',
          cls: 'pp-join',
          disabled: v.joining,
          onClick: () => voice.join().catch((e) => toast(e && e.name === 'NotAllowedError' ? t('voice.noMic') : `${t('voice.failed')}: ${e.message || e}`, { kind: 'error' })),
        }),
        h('div.hint', t('voice.hint')),
      );
      return;
    }
    const micBtn = button(null, { icon: v.micOff ? 'micOff' : 'mic', cls: `btn-icon pp-tgl pp-mic${v.micOff ? ' off' : ''}`, title: v.micOff ? t('voice.micOn') : t('voice.micOff'), onClick: () => voice.setMicOff(!v.micOff) });
    const deafBtn = button(null, { icon: v.deaf ? 'headsetOff' : 'headset', cls: `btn-icon pp-tgl${v.deaf ? ' off' : ''}`, title: v.deaf ? t('voice.undeafen') : t('voice.deafen'), onClick: () => voice.setDeaf(!v.deaf) });
    const mode = segmented(MODES(), v.mode, (m) => voice.setMode(m));
    mode.classList.add('pp-mode');
    swap(
      voiceBox,
      h(
        'div.pp-voice-row',
        micBtn,
        deafBtn,
        button(null, { icon: 'gear', cls: 'btn-icon', title: t('voice.settings'), onClick: () => openVoiceSettings() }),
        button(null, { icon: 'hangup', cls: 'btn-icon pp-hangup', title: t('voice.leave'), onClick: () => voice.leave() }),
      ),
      mode,
      v.mode === 'ptt' ? talk : meter,
      h('div.hint.pp-noise', t('voice.noise.' + v.noise)),
    );
    paintLive();
  }

  // the parts that change many times a second, without rebuilding the rest
  function paintLive() {
    const v = voice.voiceState();
    paintVoice(voiceBox.querySelector('.pp-mic'), memberVoice({self:true}, v));
    meter.firstChild.style.width = `${Math.round(v.level)}%`;
    meter.classList.toggle('open', v.open);
    meter.lastChild.style.left = `${v.threshold}%`;
    meter.lastChild.hidden = v.mode !== 'vad';
    talk.textContent = v.micOff || v.deaf ? t('voice.muted') : v.open ? t('voice.talking') : t('voice.holdKey', { key: v.pttName || '?' });
    talk.classList.toggle('open', v.open);
    for (const row of membersBox.children) {
      const id = row.dataset.id;
      const m = (store.get('party')?.members || []).find(m => (m.self ? 'self' : m.id) === id);
      const state = m ? memberVoice(m, v) : 'idle';
      paintVoice(row.querySelector('.pp-vs'), state);
      row.classList.toggle('speaking', state === 'speaking');
    }
  }

  // ---- members -------------------------------------------------------------------------
  let membersKey = '';
  function renderMembers() {
    const p = store.get('party') || {};
    const v = voice.voiceState();
    const key = JSON.stringify([!!p.leader, (p.members || []).map((m) => [m.id, m.name, m.voice, (m.skin || '').length]), v.on, v.peers.map((x) => [x.id, x.state, x.volume, !!x.relay])]);
    if (key === membersKey) return;
    membersKey = key;
    swap(
      membersBox,
      (p.members || []).map((m) => {
        const peer = v.peers.find((x) => x.id === m.id);
        const row = h(
          'div.pp-member',
          { 'data-id': m.self ? 'self' : m.id },
          faceImg(m),
          h('div.pp-name', m.name, m.leader ? h('span.pp-lead', icon('star')) : null),
          h('span.pp-vs.voice-indicator'),
          h(
            'span.pp-tail',
            peer && peer.state !== 'connected' ? h('span.pp-conn', t('voice.connecting')) : peer && peer.relay ? h('span.pp-conn', t('voice.viaRelay')) : null,
            p.leader && !m.self ? button(null, { icon: 'userMinus', variant: 'ghost', cls: 'btn-icon btn-sm pp-kick', title: t('party.kick'), onClick: () => kickMember(m) }) : null,
          ),
        );
        // a friend in the call: their own volume
        if (!m.self && peer && v.on) {
          const vol = slider({ min: 0, max: 100, step: 5, value: peer.volume, format: (n) => `${n}%`, onChange: (n) => voice.setVolume(m.name, n) });
          vol.classList.add('pp-vol');
          row.append(h('div.pp-vol-row', icon('volume'), vol));
        }
        return row;
      }),
    );
    paintLive();
  }

  // ---- chat ----------------------------------------------------------------------------------
  function renderLog() {
    const list = store.get('partyChat') || [];
    const p = store.get('party') || {};
    const byId = new Map((p.members || []).map((m) => [m.id, m]));
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (!list.length) {
      swap(log, h('div.pp-empty', icon('chat', { scale: 3 }), h('div', t('chat.empty'))));
      return;
    }
    let prev = null;
    swap(
      log,
      list.map((m) => {
        const grouped = prev && prev.from === m.from && m.at - prev.at < 120000;
        prev = m;
        const who = byId.get(m.from) || { id: m.from, name: m.name, skin: '' };
        const body = m.sticker ? h('img.pp-sticker-msg', { src: stickerUrl(m.sticker), alt: m.sticker }) : h('div.pp-msg-text', m.text);
        return h(
          `div.pp-msg${m.self ? '.self' : ''}${grouped ? '.grouped' : ''}`,
          grouped ? h('div.pp-face-gap') : faceImg(who),
          h('div.pp-bubble', grouped ? null : h('div.pp-who', h('span.pp-who-name', m.name), h('span.pp-time', clock(m.at))), body),
        );
      }),
    );
    if (atBottom || (list.length && list[list.length - 1].self)) log.scrollTop = log.scrollHeight;
  }

  // ---- wiring -------------------------------------------------------------------------------------
  const offs = [
    store.on('party', () => {
      renderHead();
      renderMembers();
    }),
    store.on('partyChat', renderLog),
    voice.onVoice(() => {
      const v = voice.voiceState();
      const shape = `${v.on}|${v.joining}|${v.mode}|${v.micOff}|${v.deaf}|${v.noise}`;
      if (shape !== el.dataset.shape) {
        el.dataset.shape = shape;
        renderVoice();
      }
      renderMembers();
      paintLive();
    }),
  ];
  renderHead();
  renderVoice();
  renderMembers();
  renderLog();
  setTimeout(() => {
    log.scrollTop = log.scrollHeight;
    input.focus();
  }, 30);
  return { el, dispose: () => offs.forEach((off) => off()) };
}
