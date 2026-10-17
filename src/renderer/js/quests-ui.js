// The week's quests (src/main/quests.js) in the window: a small card in the
// lobby's corner (the three, how far they've got, the time left), the "drop"
// a new week's quests come in with, and the reward once all three are done —
// three cards face down, one picked: it comes to the middle, shakes, bursts
// and turns over (coins fly out; a rare pack shines gold), then the other two
// show what they held, as in a CS case.
import { h, swap } from './dom.js';
import { t, getLang } from './i18n.js';
import { icon } from './icons.js';
import { api, onEvent } from './core.js';
import { button, toast, modal } from './ui.js';
import { remaining } from './cosmetics-panel.js';

const COIN = 'mcl://app/assets/images/coin.png';
const LOGO = 'mcl://app/assets/icon/app.png';
const local = (o) => (o && typeof o === 'object' ? (getLang() === 'en' ? o.en : o.ru) || o.ru || '' : String(o || ''));
const num = (n) => Math.floor(n).toLocaleString(getLang() === 'en' ? 'en-US' : 'ru-RU');
const stillMotion = () => document.documentElement.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// each kind of quest: its sign and colour
const KIND = {
  minutes: { ic: 'clock', color: '#5fc35a' },
  serverMinutes: { ic: 'server', color: '#9a62ff' },
  blocks: { ic: 'block', color: '#4b8bff' },
  kills: { ic: 'gamepad', color: '#ef5a50' },
  days: { ic: 'refresh', color: '#e4ae39' },
};
const kindOf = (q) => KIND[q.kind] || KIND.minutes;

export function progressText(q) {
  if (q.kind === 'minutes' || q.kind === 'serverMinutes') return t('quests.min', { a: num(q.progress), b: num(q.goal) });
  if (q.kind === 'days') return t('quests.days', { a: num(q.progress), b: num(q.goal) });
  return `${num(q.progress)} / ${num(q.goal)}`;
}

export function leftText(ends) {
  const [d, hh, m] = remaining(ends);
  return d ? t('cos.leftDH', { d, h: hh }) : t('cos.leftHM', { h: hh, m });
}

function row(q, { big = false } = {}) {
  const k = kindOf(q);
  const share = Math.min(1, q.progress / Math.max(1, q.goal));
  return h(
    `div.q-row${big ? '.big' : ''}`,
    { class: q.claimed ? 'done' : '', style: { '--kc': k.color } },
    h('div.q-name', local(q.title), q.claimed ? h('span.q-check', icon('check')) : null),
    h('div.q-bar', h('i', { style: { width: `${Math.round((q.claimed ? 1 : share) * 100)}%` } })),
    h('div.q-row-foot', q.claimed ? t('quests.done') : progressText(q)),
  );
}

// The week's quests in a plain window: the three, how far, the time left, the reward's state
export function showList(view, { fresh = false } = {}) {
  if (!view || !view.quests.length || document.querySelector('.dialog.quests-list')) return;
  const n = view.quests.filter((q) => q.claimed).length;
  const r = view.reward || { state: 'locked' };
  let foot;
  if (view.rewardWeek != null) foot = h('div.ql-foot.ready', icon('sparkle'), h('span', t('quests.rewardReady')));
  else if (r.state === 'taken') foot = h('div.ql-foot', icon('check'), h('span', t('quests.got', { prize: prizeText(r.cards[r.pick]) })));
  else foot = h('div.ql-foot', h('div.q-dots', [0, 1, 2].map((i) => h('i', { class: i < n ? 'on' : '' }))), h('span', t('quests.dropHint')));
  const body = h('div.ql',
    h('div.ql-left', icon('clock'), h('span', t('quests.dropSub', { left: leftText(view.ends) }))),
    ...view.quests.map((q) => row(q, { big: true })),
    foot);
  const buttons = view.rewardWeek != null
    ? [{ label: t('common.close'), value: false }, { label: t('quests.pickNow'), variant: 'primary', onClick: (close) => { close(true); setTimeout(() => showReward(view), 200); } }]
    : [{ label: fresh ? t('quests.dropGo') : t('common.close'), variant: fresh ? 'primary' : 'secondary', value: false }];
  modal({
    title: fresh ? t('quests.newTitle') : t('quests.title'),
    body,
    buttons,
    width: 460,
    cls: 'quests-list',
    onClose: () => { if (fresh) api('quests:seen', view.week).catch(() => {}); },
  });
}

function prizeText(card) {
  return card.type === 'coins' ? `+${card.coins}` : t('quests.rareShort');
}

// Home: the card in the lobby's corner (a click: the reward when it waits, else the week's quests)
export function questsPromo() {
  const el = h('button.lobby-event.lobby-quests', { type: 'button', hidden: true });
  let view = null;
  let clock = 0;
  el.addEventListener('click', () => {
    if (view && view.quests.length) showList(view);
  });

  function show(v) {
    view = v;
    clearInterval(clock);
    if (!v || !v.account || !v.quests.length) {
      el.hidden = true;
      return;
    }
    const left = h('span.q-left');
    const tick = () => { left.textContent = leftText(v.ends); };
    tick();
    clock = setInterval(tick, 30000);
    const n = v.quests.filter((q) => q.claimed).length;
    const r = v.reward || { state: 'locked' };
    let foot;
    if (v.rewardWeek != null) foot = h('div.q-claim', icon('sparkle'), h('span', t('quests.pickNow')));
    else if (r.state === 'taken') foot = h('div.q-got', t('quests.got', { prize: prizeText(r.cards[r.pick]) }));
    else foot = h('div.q-count', h('div.q-dots', [0, 1, 2].map((i) => h('i', { class: i < n ? 'on' : '' }))), h('span', t('quests.toReward', { n })));
    el.classList.toggle('ready', v.rewardWeek != null);
    swap(el, h('div.lobby-event-head', h('span', t('quests.title')), left), ...v.quests.map(row), foot);
    el.hidden = false;
  }

  api('quests:state').then(show).catch(() => {});
  const off = onEvent('quests:changed', show);
  return { el, dispose: () => { clearInterval(clock); off(); } };
}

// ---- the stage both use: a dark room, rays behind, a title ---------------------------------------
let open = null;
function stage(kicker, title, sub) {
  const el = h('div.qdrop', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.qd-rays'),
    h('div.qd-head', h('div.qd-kicker', kicker), h('div.qd-title', title), sub ? h('div.qd-sub', sub) : null));
  document.body.append(el);
  open = el;
  return el;
}
function closeStage(el, still) {
  el.classList.add('closing');
  setTimeout(() => el.remove(), still ? 0 : 220);
  if (open === el) open = null;
}

// A card's tilt after the mouse, and the light on it
function tilt(card) {
  const move = (e) => {
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    card.style.setProperty('--rx', `${(0.5 - y) * 16}deg`);
    card.style.setProperty('--ry', `${(x - 0.5) * 18}deg`);
    card.style.setProperty('--mx', `${x * 100}%`);
    card.style.setProperty('--my', `${y * 100}%`);
  };
  const leave = () => { card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg'); };
  card.addEventListener('pointermove', move);
  card.addEventListener('pointerleave', leave);
}

// ---- the drop: a new week's quests -------------------------------------------------------------
export function showDrop(view, { replay = false } = {}) {
  if (open || !view || !view.quests.length) return;
  const still = stillMotion();
  const cards = view.quests.map((q, i) => {
    const k = kindOf(q);
    const face = h('div.qd-face',
      h('div.qd-face-top', h('span.qd-kind-ic', icon(k.ic)), h('span.qd-num', `#${i + 1}`)),
      h('div.qd-name', local(q.title)),
      h('div.qd-progress', h('div.qd-pbar', h('i', { style: { width: `${Math.round(Math.min(1, q.claimed ? 1 : q.progress / Math.max(1, q.goal)) * 100)}%` } })),
        h('span', q.claimed ? t('quests.done') : progressText(q))));
    const back = h('div.qd-back', h('img', { src: LOGO, alt: '', draggable: false }), h('div.qd-back-q', '?'));
    const card = h('div.qd-card', { class: still ? 'shown' : '', style: { '--i': String(i), '--kc': k.color } }, h('div.qd-inner', back, face));
    tilt(card);
    return card;
  });
  const go = button(t('quests.dropGo'), { variant: 'primary', cls: 'qd-go' });
  const el = stage(t('quests.dropKicker'), t('quests.dropTitle'), t('quests.dropSub', { left: leftText(view.ends) }));
  el.append(h('div.qd-cards', cards), h('div.qd-hint', icon('sparkle'), h('span', t('quests.dropHint'))), go);
  const timers = [];
  if (!still) {
    cards.forEach((c, i) => timers.push(setTimeout(() => c.classList.add('shown'), 900 + i * 600)));
    timers.push(setTimeout(() => go.classList.add('ready'), 900 + cards.length * 600));
  } else go.classList.add('ready');
  const close = () => {
    timers.forEach(clearTimeout);
    document.removeEventListener('keydown', onKey, true);
    closeStage(el, still);
    if (!replay) api('quests:seen', view.week).catch(() => {});
  };
  const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  go.addEventListener('click', close);
  requestAnimationFrame(() => go.focus());
}

// ---- the reward: three cards, one picked -------------------------------------------------------
function prizeFace(card, { missed = false } = {}) {
  if (card.type === 'item') {
    const id = (card.items || [])[0] || '';
    return h('div.qr-face.rare', missed ? h('div.qr-missed', t('quests.missed')) : null,
      h('div.qr-tag', t('quests.rare')),
      h('div.qr-item', h('img', { src: `mcl://app/assets/cosmetics/${id}/icon.png`, alt: '', draggable: false })),
      h('div.qr-label', t('quests.rareItem')));
  }
  const n = h('b', missed ? `+${card.coins}` : '+0');
  return h('div.qr-face.coins', missed ? h('div.qr-missed', t('quests.missed')) : null,
    h('div.qr-coin', h('img', { src: COIN, alt: '', draggable: false })),
    h('div.qr-amount', n),
    h('div.qr-label', t('quests.coins')));
}

function countUp(el, to, ms = 900) {
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    el.textContent = `+${Math.round(to * (1 - (1 - k) ** 3))}`;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// coins (or stars) flying out of a point of the stage
function burst(stageEl, x, y, { rare = false, count = 22 } = {}) {
  for (let i = 0; i < count; i++) {
    const a = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const d = 140 + Math.random() * 220;
    const p = h(rare && i % 2 ? 'div.qr-spark' : 'img.qr-bit', rare && i % 2 ? {} : { src: COIN, alt: '', draggable: false });
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.setProperty('--dx', `${Math.cos(a) * d}px`);
    p.style.setProperty('--dy', `${Math.sin(a) * d - 80}px`);
    p.style.setProperty('--rot', `${(Math.random() - 0.5) * 720}deg`);
    p.style.animationDelay = `${Math.random() * 120}ms`;
    stageEl.append(p);
    setTimeout(() => p.remove(), 1700);
  }
}

export function showReward(view) {
  if (open || !view || view.rewardWeek == null) return;
  const week = view.rewardWeek;
  const still = stillMotion();
  const el = stage(t('quests.rewardKicker'), t('quests.rewardTitle'), t('quests.rewardSub'));
  const row_ = h('div.qd-cards.qr-cards');
  const cards = [0, 1, 2].map((i) => {
    const back = h('div.qd-back.qr-back', h('img', { src: LOGO, alt: '', draggable: false }), h('div.qd-back-q', '?'));
    const card = h('button.qd-card.qr-card', { type: 'button', style: { '--i': String(i) }, 'aria-label': t('quests.pickCard', { n: i + 1 }) }, h('div.qd-inner', back));
    tilt(card);
    return card;
  });
  row_.append(...cards);
  const note = h('div.qd-hint', icon('sparkle'), h('span', t('quests.rewardHint')));
  const done = button(t('quests.collect'), { variant: 'primary', cls: 'qd-go' });
  el.append(row_, note, done);
  let busy = false;
  let closable = false;
  const close = () => {
    if (!closable) return;
    document.removeEventListener('keydown', onKey, true);
    closeStage(el, still);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !busy) { e.preventDefault(); closable = true; close(); }
    if (e.key === 'Enter' && closable) { e.preventDefault(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  done.addEventListener('click', close);

  cards.forEach((card, i) => card.addEventListener('click', async () => {
    if (busy || el.classList.contains('picked')) return;
    busy = true;
    el.classList.add('picking');
    card.classList.add('chosen');
    // to the middle of the row
    const rr = row_.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    card.style.setProperty('--tx', `${rr.left + rr.width / 2 - (cr.left + cr.width / 2)}px`);
    const res = await Promise.all([api('quests:pick', week, i).catch((e) => ({ ok: false, error: e.message })), wait(still ? 0 : 1300)]).then(([r]) => r);
    if (!res || !res.ok) {
      busy = false;
      el.classList.remove('picking');
      card.classList.remove('chosen');
      toast(t(res && res.error === 'offline' ? 'quests.offline' : 'quests.pickError'), { kind: 'error' });
      return;
    }
    const got = res.cards[res.pick];
    const inner = card.querySelector('.qd-inner');
    const face = prizeFace(got);
    inner.append(face);
    card.classList.add(got.type === 'item' ? 'is-rare' : 'is-coins');
    el.classList.add('picked', got.type === 'item' ? 'got-rare' : 'got-coins');
    card.classList.add('shown');
    if (!still) {
      await wait(380);
      const sr = el.getBoundingClientRect();
      const fr = card.getBoundingClientRect();
      burst(el, fr.left - sr.left + fr.width / 2, fr.top - sr.top + fr.height / 2, { rare: got.type === 'item', count: got.type === 'item' ? 34 : 22 });
    }
    if (got.type === 'coins') countUp(face.querySelector('.qr-amount b'), got.coins, still ? 1 : 900);
    // the other two: what they held
    await wait(still ? 0 : 1500);
    card.classList.add('settle');
    cards.forEach((c, k) => {
      if (k === res.pick) return;
      c.querySelector('.qd-inner').append(prizeFace(res.cards[k], { missed: true }));
      c.classList.add('shown', 'other', res.cards[k].type === 'item' ? 'is-rare' : 'is-coins');
    });
    note.querySelector('span').textContent = got.type === 'item' ? t('quests.gotRare') : t('quests.gotCoins', { n: got.coins });
    busy = false;
    closable = true;
    done.classList.add('ready');
    done.focus();
  }));
  requestAnimationFrame(() => cards[1].focus());
}

// A new week's quests: the drop, once; all three done: the reward, once a session
export function watchDrop() {
  let offered = null;
  const maybe = (v) => {
    if (!v || !v.account || !v.quests.length || document.hidden) return;
    if (v.fresh) showList(v, { fresh: true });
    else if (v.rewardWeek != null && offered !== v.rewardWeek) {
      offered = v.rewardWeek;
      showReward(v);
    }
  };
  api('quests:state').then(maybe).catch(() => {});
  onEvent('quests:changed', maybe);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) api('quests:state').then(maybe).catch(() => {}); });
}
