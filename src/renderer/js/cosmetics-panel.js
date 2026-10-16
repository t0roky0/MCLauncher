// Skins → Cosmetics: the event running now (its quests, the time left, the
// rewards to claim) in its own colour, and below it the player's own things
// (worn or taken off with a click). Any item can be tried on the stage by
// pointing at it. Home gets the event small, in the lobby's corner.
import { h, swap } from './dom.js';
import { t, getLang } from './i18n.js';
import { icon } from './icons.js';
import { api, onEvent } from './core.js';
import { button, segmented, toast } from './ui.js';

const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary'];
const local = (o) => (o && typeof o === 'object' ? (getLang() === 'en' ? o.en : o.ru) || o.ru || '' : String(o || ''));
const itemName = (it) => (getLang() === 'en' ? it.nameEn || it.name : it.name);
const num = (n) => Math.floor(n).toLocaleString(getLang() === 'en' ? 'en-US' : 'ru-RU');
const iconUrl = (id) => `mcl://app/assets/cosmetics/${id}/icon.png`;
const byRarity = (a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity);
const stillMotion = () => document.documentElement.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;

function hours(min) {
  const m = Math.floor(min);
  if (m < 60) return t('cos.min', { n: m });
  return m % 60 ? t('cos.hmin', { h: Math.floor(m / 60), m: m % 60 }) : t('cos.h', { n: m / 60 });
}

// "34 / 100", "1 ч 20 мин / 3 ч"
function progressText(q) {
  if (q.kind === 'minutes' || q.kind === 'serverMinutes') return `${hours(q.progress)} / ${hours(q.goal)}`;
  return `${num(q.progress)} / ${num(q.goal)}`;
}

// What's left until `ends`: [days, hours, minutes, seconds].
export function remaining(ends, now = Date.now()) {
  let s = Math.max(0, Math.floor((ends - now) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const hh = Math.floor(s / 3600);
  s -= hh * 3600;
  const m = Math.floor(s / 60);
  return [d, hh, m, s - m * 60];
}
const pad = (n) => String(n).padStart(2, '0');

// The countdown: days, hours, minutes, seconds in cells, ticking.
function countdown(ends) {
  const cells = ['d', 'h', 'm', 's'].map((u) => {
    const v = h('b');
    return { v, el: h('div.cos-tm-cell', v, h('span', t(`cos.unit.${u}`))) };
  });
  const el = h('div.cos-timer', h('div.cos-tm-label', t('cos.endsIn')), h('div.cos-tm-cells', cells.map((c) => c.el)));
  const tick = () => {
    const r = remaining(ends);
    cells.forEach((c, i) => {
      const text = i ? pad(r[i]) : String(r[i]);
      if (c.v.textContent !== text) c.v.textContent = text;
    });
  };
  tick();
  const timer = setInterval(tick, 1000);
  return { el, stop: () => clearInterval(timer) };
}

// stage: a SkinStage (or anything with setCosmetics(ids)); focusEvent: open
// scrolled to the event (from the lobby's corner).
export function cosmeticsSection(stage, { focusEvent = false } = {}) {
  let view = null;
  let filter = 'all';
  let clock = null;
  let scrolled = !focusEvent;
  const wornIds = () => Object.values((view && view.worn) || {}).filter(Boolean);

  // pointing at an item tries it on in its slot; away, back to what is worn
  // (a moment later: moving across the cards doesn't bounce in between)
  let back = 0;
  const tryOn = (it) => {
    clearTimeout(back);
    const worn = { ...((view && view.worn) || {}) };
    worn[it.slot] = it.id;
    stage.setCosmetics(Object.values(worn).filter(Boolean)).catch(() => {});
  };
  const restore = () => {
    clearTimeout(back);
    stage.setCosmetics(wornIds()).catch(() => {});
  };
  const restoreSoon = () => {
    clearTimeout(back);
    back = setTimeout(restore, 160);
  };

  const eventBox = h('div.cos-event-block', { hidden: true });
  const mine = h('div.cos-grid');
  const filterSeg = segmented(
    [
      { value: 'all', label: t('cos.all') },
      { value: 'head', label: t('cos.slot.head') },
      { value: 'back', label: t('cos.slot.back') },
      { value: 'pet', label: t('cos.pets') },
    ],
    filter,
    (v) => {
      filter = v;
      render();
    },
  );
  const el = h(
    'div.cos-section',
    eventBox,
    h('div.cos-head', h('div.section-title', { style: { margin: 0 } }, icon('sparkle'), t('cos.mine')), h('div.grow'), filterSeg),
    mine,
  );

  async function wear(it, on) {
    try {
      view = await api('cosmetics:wear', it.slot, on ? it.id : '');
      render();
      restore();
      toast(on ? t('cos.wornToast', { name: itemName(it) }) : t('cos.offToast', { name: itemName(it) }), { kind: 'ok', icon: 'sparkle' });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  async function claim(it, btn) {
    btn.disabled = true;
    try {
      view = await api('cosmetics:claim', it.id);
      render();
      restore();
      toast(t('cos.claimedToast', { name: itemName(it) }), { kind: 'ok', icon: 'sparkle' });
    } catch (e) {
      btn.disabled = false;
      toast(e.message, { kind: 'error' });
    }
  }

  const art = (it, locked) => h('div.cos-art', h('img', { src: iconUrl(it.id), alt: '', draggable: false }), locked ? h('span.cos-lock', icon('lock')) : null);
  const tags = (it) => h('div.cos-tags', h('span.cos-rarity', t(`cos.rarity.${it.rarity}`)), h('span.cos-dot', '·'), h('span.cos-slot', t(`cos.slot.${it.slot}`)));
  const hover = (c, it) => {
    c.addEventListener('mouseenter', () => tryOn(it));
    c.addEventListener('mouseleave', restoreSoon);
    return c;
  };

  // In the event: the quest and how far along, the reward to claim, or got.
  function eventCard(it) {
    const q = it.quest;
    const pct = Math.max(0, Math.min(1, q.goal ? q.progress / q.goal : 0));
    let foot;
    if (it.owned) foot = h('div.cos-got', icon('check'), t('cos.claimed'));
    else if (it.ready) {
      foot = button(t('cos.claim'), { variant: 'primary', icon: 'download', cls: 'btn-sm cos-btn cos-claim', onClick: (e, b) => { e.stopPropagation(); claim(it, b || e.currentTarget); } });
    } else {
      foot = h(
        'div.cos-quest',
        h('div.cos-goal', local(q.title)),
        q.kind === 'visit' ? null : h('div.cos-bar', h('i', { style: { width: `${(pct * 100).toFixed(1)}%` } })),
        q.kind === 'visit' ? null : h('div.cos-count', progressText(q)),
      );
    }
    return hover(h(
      'div.cos-card',
      { class: [`r-${it.rarity}`, it.owned ? 'got' : it.ready ? 'ready' : 'locked'].join(' '), dataset: { id: it.id } },
      it.ready ? h('span.chip.cos-new', t('cos.readyChip')) : null,
      art(it, !it.owned && !it.ready),
      h('div.cos-name', { title: itemName(it) }, itemName(it)),
      tags(it),
      h('div.cos-foot', foot),
    ), it);
  }

  // Ours: on or off with a click.
  function mineCard(it) {
    const c = h(
      'div.cos-card.owned',
      { class: [`r-${it.rarity}`, it.worn ? 'worn' : ''].join(' '), dataset: { id: it.id } },
      it.worn ? h('span.chip.acc.cos-worn', t('cos.worn')) : null,
      art(it, false),
      h('div.cos-name', { title: itemName(it) }, itemName(it)),
      tags(it),
      h('div.cos-foot', button(it.worn ? t('cos.takeOff') : t('cos.wear'), {
        variant: it.worn ? 'secondary' : 'primary',
        icon: it.worn ? 'x' : 'check',
        cls: 'btn-sm cos-btn',
        onClick: (e) => {
          e.stopPropagation();
          wear(it, !it.worn);
        },
      })),
    );
    c.addEventListener('click', () => wear(it, !it.worn));
    return hover(c, it);
  }

  function renderEvent() {
    if (clock) clock.stop();
    clock = null;
    const ev = (view.events || []).find((e) => e.active);
    if (!ev) {
      eventBox.hidden = true;
      return;
    }
    const items = view.items.filter((i) => i.event.id === ev.id).sort(byRarity);
    const got = items.filter((i) => i.owned).length;
    const ready = items.filter((i) => i.ready).length;
    clock = countdown(ev.ends);
    if (ev.color) eventBox.style.setProperty('--ev', ev.color);
    swap(
      eventBox,
      h(
        'div.cos-ev-head',
        h('div.cos-ev-badge', icon('star')),
        h('div.cos-ev-text', h('div.cos-ev-kicker', t('cos.event')), h('div.cos-ev-title', local(ev.name)), h('div.cos-ev-sub', t('cos.eventSub'))),
        clock.el,
      ),
      h(
        'div.cos-ev-progress',
        h('span', t('cos.collected', { n: got, total: items.length })),
        ready ? h('span.cos-ev-ready', t('cos.readyCount', { n: ready })) : null,
        h('div.cos-bar', h('i', { style: { width: `${items.length ? (got / items.length) * 100 : 0}%` } })),
      ),
      h('div.cos-grid', items.map(eventCard)),
    );
    eventBox.hidden = false;
    if (!scrolled) {
      scrolled = true;
      requestAnimationFrame(() => eventBox.scrollIntoView({ behavior: stillMotion() ? 'auto' : 'smooth', block: 'start' }));
    }
  }

  function renderMine() {
    const items = view.items.filter((i) => i.owned && (filter === 'all' || i.slot === filter)).sort((a, b) => byRarity(b, a));
    swap(mine, items.length ? items.map(mineCard) : h('div.cos-empty', icon('sparkle'), h('div', t('cos.mineEmpty'))));
  }

  function render() {
    if (!view) return;
    renderEvent();
    renderMine();
  }

  async function load() {
    try {
      view = await api('cosmetics:state');
      render();
      restore();
    } catch (e) {
      swap(mine, h('div.muted', e.message));
    }
  }
  load();
  const off = onEvent('cosmetics:changed', (v) => {
    view = v;
    render();
    restore();
  });

  return {
    el,
    dispose: () => {
      clearTimeout(back);
      if (clock) clock.stop();
      off();
    },
  };
}

// Home, under the event: the shop's packs one after another — the ones not
// bought yet first (its colour, its items' pictures in turn, its price in
// coins; one you have: "yours") — a click opens the shop.
export function shopPromo(go) {
  const el = h('button.lobby-event.lobby-shop', { type: 'button', hidden: true, onclick: () => go('shop') });
  let turn = 0;
  let pics = 0;

  function show(state) {
    clearInterval(turn);
    clearInterval(pics);
    const packs = ((state && state.packs) || []).filter((p) => (p.items || []).length);
    packs.sort((a, b) => Number(!!a.owned) - Number(!!b.owned) || Number(!!b.featured) - Number(!!a.featured));
    if (!packs.length) {
      el.hidden = true;
      return;
    }
    let k = 0;
    const one = () => {
      clearInterval(pics);
      const p = packs[k];
      const imgs = p.items.map((it, n) => h('img', { src: iconUrl(it.id), alt: '', draggable: false, class: n ? '' : 'on' }));
      if (p.color) el.style.setProperty('--ev', p.color);
      swap(
        el,
        h('div.lobby-event-head', h('span', t('nav.shop')), p.featured ? h('span.lobby-event-new', t('shop.featured')) : null),
        h('div.lobby-event-title', getLang() === 'en' ? p.nameEn || p.name : p.name),
        h('div.lobby-event-show', imgs),
        p.owned
          ? h('div.lobby-event-foot', icon('check'), h('span', t('shop.owned')))
          : h('div.lobby-event-foot', h('img.coin', { src: 'mcl://app/assets/images/coin.png', alt: '', draggable: false }), h('b', String(p.price)), h('span.grow'), h('span', t('shop.buy'))),
      );
      el.setAttribute('aria-label', `${t('nav.shop')}: ${p.name}`);
      let n = 0;
      if (imgs.length > 1 && !stillMotion()) {
        pics = setInterval(() => {
          imgs[n].classList.remove('on');
          n = (n + 1) % imgs.length;
          imgs[n].classList.add('on');
        }, 2600);
      }
    };
    one();
    // the next pack every few seconds (a change of picture, not a motion: with fewer animations too)
    if (packs.length > 1) {
      turn = setInterval(() => {
        k = (k + 1) % packs.length;
        one();
      }, 5000);
    }
    el.hidden = false;
  }

  api('shop:state').then(show).catch(() => {});
  const off = onEvent('shop:changed', show);
  return {
    el,
    dispose: () => {
      clearInterval(turn);
      clearInterval(pics);
      off();
    },
  };
}

// Home: the running event, small, in the lobby's corner — its items in turn
// (pictures, no 3D: nothing to slow the lobby), the time left, and whether a
// reward waits; a click opens it in Skins.
export function eventPromo(go) {
  const el = h('button.lobby-event', { type: 'button', hidden: true, onclick: () => go('skins', { focus: 'event' }) });
  let turn = 0;
  let clock = 0;

  function show(view) {
    clearInterval(turn);
    clearInterval(clock);
    const ev = view && (view.events || []).find((e) => e.active);
    if (!ev) {
      el.hidden = true;
      return;
    }
    const items = view.items.filter((i) => i.event.id === ev.id).sort(byRarity);
    const got = items.filter((i) => i.owned).length;
    const ready = items.filter((i) => i.ready).length;
    const pics = items.map((it, k) => h('img', { src: iconUrl(it.id), alt: '', draggable: false, class: k ? '' : 'on' }));
    const left = h('span');
    const tick = () => {
      const [d, hh, m] = remaining(ev.ends);
      left.textContent = d ? t('cos.leftDH', { d, h: hh }) : t('cos.leftHM', { h: hh, m });
    };
    if (ev.color) el.style.setProperty('--ev', ev.color);
    swap(
      el,
      h('div.lobby-event-head', h('span', t('cos.event')), ready ? h('span.lobby-event-ready', t('cos.readyChip')) : null),
      h('div.lobby-event-title', local(ev.name)),
      h('div.lobby-event-show', pics),
      h('div.lobby-event-foot', icon('clock'), left, h('span.grow'), h('b', `${got}/${items.length}`)),
    );
    el.setAttribute('aria-label', `${t('cos.event')} ${local(ev.name)}`);
    tick();
    clock = setInterval(tick, 30000);
    let k = 0;
    if (pics.length > 1 && !stillMotion()) {
      turn = setInterval(() => {
        pics[k].classList.remove('on');
        k = (k + 1) % pics.length;
        pics[k].classList.add('on');
      }, 2600);
    }
    el.hidden = false;
  }

  api('cosmetics:state').then(show).catch(() => {});
  const off = onEvent('cosmetics:changed', show);
  return {
    el,
    dispose: () => {
      clearInterval(turn);
      clearInterval(clock);
      off();
    },
  };
}
