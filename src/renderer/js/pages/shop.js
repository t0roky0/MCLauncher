// The shop: a showcase on top — what's chosen, in the colour of its pack: the
// player wearing it (a pet on its own), turning; its little story, what's in
// it, its price and "Buy" — and under it everything there is, by kind (all ·
// packs · on the head · on the back · pets), as tiles: a click puts one in the
// showcase. A hat or wings come in a pack: the pack is what's bought. Only
// what's sold is here (the event's things are on the Skins page, with their quests).
// Coins and purchases are our server's (src/main/shop.js): what it says is
// shown, a purchase goes through it; coins are paid for with YooKassa (the
// page opens in the browser, main.js says when it's done).
import { h, swap, bag } from '../dom.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { api, store, onEvent } from '../core.js';
import { button, toast, confirmDialog, spinner, modal } from '../ui.js';
import { SkinStage } from '../skin3d.js';
import { currentAppearance } from '../appearance.js';

const local = (o) => (o && typeof o === 'object' ? (getLang() === 'en' ? o.en : o.ru) || o.ru || '' : String(o || ''));
const named = (x) => (getLang() === 'en' ? x.nameEn || x.name : x.name);
const num = (n) => Math.floor(n).toLocaleString(getLang() === 'en' ? 'en-US' : 'ru-RU');
const iconUrl = (id) => `mcl://app/assets/cosmetics/${id}/icon.png`;
const TABS = ['all', 'packs', 'head', 'back', 'pets'];
const RANK = { legendary: 0, epic: 1, rare: 2, common: 3 };

// the coin (assets/images/coin.png, the user's 8×8 pixel art) at a whole multiple: 2 → 16 px, 3 → 24 px, 4 → 32 px
const coin = (times = 3) => h('img.coin', { src: 'mcl://app/assets/images/coin.png', alt: '', draggable: false, style: { width: `${times * 8}px`, height: `${times * 8}px` } });
const price = (n) => h('div.shop-price', coin(3), h('b', num(n)));

// closer than the Skins page: from the knees up, so the wings fill the block
// and what floats over the head (a halo, horns) still fits under its top
// aspect: the column's (where it's turned): framed to it, its picture drawn wider
function frame(v, bottom, top, aspect = v.camera.aspect) {
  // Leave room for the full wingspan, including its outline, in narrow cards.
  const half = Math.max((top - bottom) / 2, 22 / aspect);
  v.zoom = 16.5 / (half - 4.5 * Math.tan((v.fov * Math.PI) / 360));
  v.controls.maxDistance = Math.max(90, v.camera.position.length() * 1.5);
  v.playerWrapper.position.y = -(top + bottom) / 2;
}

export function mount(root) {
  const life = bag();
  let state = null; // the shop's: coins, packs
  let busy = false;
  let tab = 'all';
  let chosen = ''; // the showcase's entry (its key)

  const balance = h('b.shop-coins', '—');
  const wallet = h(
    'div.shop-wallet',
    { 'data-tip': t('shop.balanceTip') },
    coin(3),
    balance,
    button(t('shop.topUp'), { icon: 'plus', cls: 'btn-sm shop-topup', onClick: topUp }),
  );
  const heroText = h('div.shop-feature-text');
  const hero = h('div.shop-feature.shop-hero', heroText);
  const tabs = h('div.shop-tabs', { role: 'tablist' });
  const grid = h('div.shop-grid');
  const body = h('div.page-body.shop-body', hero, tabs, grid);
  root.append(h('div.page-head', h('div.page-title', t('shop.title')), h('div.grow'), wallet), body);

  // a payment done (main.js tells about it), another account signed in: as it is now
  life.add(onEvent('shop:changed', (st) => {
    if (st) {
      state = st;
      render();
    }
  }));
  life.add(onEvent('shop:paid', (p) => {
    if (p && p.state) {
      state = p.state;
      render();
    }
  }));

  // ---- what there is: the packs (a pet's pack is the pet), and the packs' things by themselves ----
  function entries() {
    const out = [];
    for (const p of (state && state.packs) || []) {
      const items = p.items || [];
      // a pack of one thing (a pet, a hat) is that thing: its own kind, shown once
      const one = items.length === 1;
      out.push({ key: `pack:${p.id}`, kind: one ? items[0].slot : 'pack', pack: p, items, owned: !!p.owned, color: p.color, featured: !!p.featured });
      if (!one) for (const i of items) out.push({ key: `item:${i.id}`, kind: i.slot, item: i, pack: p, items: [i], owned: !!p.owned, color: p.color, part: true });
    }
    return out;
  }
  // a tab's: "all" is what's to be had (a pack, not its things again)
  const inTab = (e, which) => (which === 'all' ? !e.part : which === 'packs' ? e.kind === 'pack' : which === 'pets' ? e.kind === 'pet' : e.kind === which);
  // the new first, then what's to be bought, what's got; the rarer first
  const order = (e) => (e.featured ? 0 : 10) + (e.owned ? 40 : 0) + (RANK[(e.item || e.items[0] || {}).rarity] ?? 3);
  const rarity = (e) => (e.item || e.items[0] || {}).rarity || 'common';
  const title = (e) => (e.part ? named(e.item) : named(e.pack));
  const kind = (e) => (e.kind === 'pack' ? t('shop.pack') : t(`cos.slot.${e.kind}`));

  // ---- the showcase's figure: one at a time, made again for what's chosen ----
  let shown = null; // { stage, ro, sig, ... }
  let look = null; // the player's skin, asked for once
  function figure(e) {
    const pet = e.kind === 'pet';
    const ids = e.items.map((i) => i.id);
    const sig = `${pet ? 'pet' : 'wear'}:${ids.join(',')}`;
    if (shown && shown.sig === sig) return;
    dropFigure();
    // the picture (shop-view) twice as wide as its column, under the text,
    // the mouse through it — wings, a pet turning round, aren't cut off at
    // the column's edges; the column (shop-stage) is where it's turned
    const canvas = h('canvas');
    const view = h('div.shop-view', canvas);
    const stageBox = h('div.shop-stage', h('div.shop-stage-wait', spinner('lg')));
    const stage = new SkinStage(canvas, { width: 260, height: 340, hit: stageBox });
    stage.setAutoRotate(!pet);
    stage.viewer.autoRotateSpeed = 0.6;
    // Held by the mouse: it stands still (turning it by itself while the
    // camera is dragged makes it drift); let go: it turns again — the player
    // about itself, a pet (the camera round it) as fast as the player.
    const takeControl = () => { stage.setAutoRotate(false); stage.viewer.controls.autoRotate = false; };
    const giveBack = () => { if (pet) stage.viewer.controls.autoRotate = true; else stage.setAutoRotate(true); };
    stage.viewer.controls.addEventListener('start', takeControl);
    stage.viewer.controls.addEventListener('end', giveBack);
    stage.viewer.controls.enableDamping = true;
    stage.viewer.controls.dampingFactor = 0.1;
    // the wheel scrolls the shop (over the showcase it brought a pet so close it filled the block)
    stage.viewer.controls.enableZoom = false;
    stage.setAnimation('idle');
    // the column's shape: the figure as big as it fits there (the picture round it only adds room)
    const columnAspect = () => {
      const c = stageBox.getBoundingClientRect();
      return c.width > 10 && c.height > 10 ? c.width / c.height : 0.75;
    };
    const me = { stage, sig, takeControl, giveBack, fitted: false, ro: null };
    me.ro = new ResizeObserver(() => {
      const r = view.getBoundingClientRect();
      if (r.width > 10 && r.height > 10) {
        stage.resize(Math.round(r.width), Math.round(r.height));
        // Fit once when laid out; the player's own zoom is kept after that.
        if (!me.fitted) {
          stage.fitAspect = columnAspect();
          if (pet) stage.frameShowcase(); else frame(stage.viewer, -11, 27, stage.fitAspect);
          me.fitted = true;
        }
      }
    });
    me.ro.observe(view);
    hero.replaceChildren(view, heroText, stageBox);
    shown = me;
    if (!look) {
      const cfg = store.get('config') || {};
      const account = (cfg.accounts || []).find((a) => a.id === cfg.activeAccount) || (cfg.accounts || [])[0];
      look = currentAppearance(account);
    }
    look
      .then((l) => (shown === me ? stage.setSkin(l.url, l.model) : null))
      .then(() => (shown === me ? (pet ? stage.showcase(ids) : stage.setCosmetics(ids)) : null))
      .then(() => stageBox.classList.add('ready'))
      .catch(() => {});
  }
  function dropFigure() {
    if (!shown) return;
    shown.ro.disconnect();
    shown.stage.viewer.controls.removeEventListener('start', shown.takeControl);
    shown.stage.viewer.controls.removeEventListener('end', shown.giveBack);
    shown.stage.dispose();
    shown = null;
  }
  life.add(dropFigure);

  // ---- the showcase's words: what it is, its story, what's in it, its price ----
  function showcase(e) {
    hero.style.setProperty('--ev', e.color || 'var(--acc)');
    const kicker = [e.featured ? t('shop.featured') : null, kind(e)].filter(Boolean).join(' · ');
    const story = local(e.pack.tagline);
    // a pack's things (a thing of a pack: the pack's, this one marked)
    const set = e.pack && e.pack.items.length > 1
      ? h('div.shop-feature-items', e.pack.items.map((i) => h(
        'div.cos-card.shop-card',
        { class: `r-${i.rarity}${e.part && i.id === e.item.id ? ' worn' : ''}` },
        h('div.cos-art', h('img', { src: iconUrl(i.id), alt: '', draggable: false })),
        h('div.cos-name', { title: named(i) }, named(i)),
        h('div.cos-tags', h('span.cos-rarity', t(`cos.rarity.${i.rarity}`)), h('span.cos-dot', '·'), h('span.cos-slot', t(`cos.slot.${i.slot}`))),
      )))
      : null;
    const how = e.owned
      ? h('div.shop-owned', icon('check'), t('shop.owned'))
      : [price(e.pack.price), button(e.part ? t('shop.buyPack') : t('shop.buy'), { variant: 'primary', icon: 'shop', cls: 'shop-buy', disabled: busy, onClick: () => purchase(e.pack) })];
    swap(
      heroText,
      h('div.cos-ev-kicker', kicker),
      h('div.shop-feature-title', title(e)),
      e.part ? h('div.shop-hero-from', t('shop.inPack', { name: named(e.pack) })) : null,
      h('div.shop-feature-sub', story),
      set,
      h('div.shop-feature-buy', how),
    );
    figure(e);
  }

  // ---- a tile: its picture on its colour, its name, its price ----
  function tile(e) {
    const art = h('div.shop-tile-art', { class: e.items.length > 1 ? 'two' : '' }, e.items.slice(0, 2).map((i) => h('img', { src: iconUrl(i.id), alt: '', draggable: false })));
    const foot = e.owned
      ? h('div.shop-tile-owned', icon('check'), t('shop.owned'))
      : h('div.shop-tile-price', coin(2), h('b', num(e.pack.price)));
    const el = h(
      'button.shop-tile',
      { type: 'button', class: `r-${rarity(e)}${e.owned ? ' owned' : ''}${e.key === chosen ? ' on' : ''}`, dataset: { key: e.key }, onclick: () => choose(e.key, true) },
      e.featured && !e.owned ? h('span.shop-tile-new', t('shop.featured')) : null,
      art,
      h('div.shop-tile-kicker', kind(e)),
      h('div.shop-tile-name', { title: title(e) }, title(e)),
      e.part ? h('div.shop-tile-from', t('shop.inPack', { name: named(e.pack) })) : h('div.shop-tile-from', t(`cos.rarity.${rarity(e)}`)),
      foot,
    );
    el.style.setProperty('--ev', e.color || 'var(--acc)');
    return el;
  }

  function choose(key, scroll) {
    const e = entries().find((x) => x.key === key);
    if (!e) return;
    chosen = key;
    showcase(e);
    for (const el of grid.children) el.classList.toggle('on', el.dataset && el.dataset.key === key);
    if (scroll) body.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---- what's drawn ------------------------------------------------------------
  function render() {
    balance.textContent = state && state.coins != null ? num(state.coins) : '—';
    wallet.classList.toggle('offline', !!state && !state.online);
    const all = entries();
    if (!all.length) {
      dropFigure();
      hero.hidden = true;
      swap(tabs);
      swap(grid, h('div.shop-empty', icon('shop'), t('shop.empty')));
      return;
    }
    hero.hidden = false;
    // the tabs, each with how many things it has
    swap(tabs, TABS.map((k) => {
      const n = all.filter((e) => inTab(e, k)).length;
      const pick = () => {
        if (tab === k) return;
        tab = k;
        render();
        // the tab's first in the showcase, unless what's there is in it already
        const here = all.filter((e) => inTab(e, k)).sort((a, b) => order(a) - order(b));
        if (here.length && !here.some((e) => e.key === chosen)) choose(here[0].key, false);
      };
      return h('button.shop-tab', { type: 'button', role: 'tab', class: k === tab ? 'active' : '', 'aria-selected': k === tab ? 'true' : 'false', disabled: !n, onclick: pick },
        h('span', t(`shop.tab.${k}`)), h('span.shop-tab-n', String(n)));
    }));
    const shownHere = all.filter((e) => inTab(e, tab)).sort((a, b) => order(a) - order(b));
    if (!all.some((e) => e.key === chosen)) chosen = (all.filter((e) => inTab(e, 'all')).sort((a, b) => order(a) - order(b))[0] || all[0]).key;
    swap(grid, shownHere.map(tile));
    showcase(all.find((e) => e.key === chosen));
  }

  async function load(fromServer) {
    try {
      state = await api(fromServer ? 'shop:refresh' : 'shop:state');
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
    render();
  }

  // ---- money: YooKassa through our server ---------------------------------------------
  const coinPacks = () => ((state && state.products) || []).filter((p) => p.coins > 0);
  const rub = (v) => `${num(Math.round(Number(v)))} ₽`;

  async function startPay(product) {
    if (!product) {
      toast(t('shop.payUnavailable'), { kind: 'warn', timeout: 7000 });
      return;
    }
    let res = null;
    try {
      res = await api('shop:pay', product.id);
    } catch (e) {
      toast(e.message, { kind: 'error' });
      return;
    }
    if (res.ok) toast(t('shop.payOpened'), { kind: 'info', icon: 'coin', timeout: 10000 });
    else if (res.error === 'unavailable') toast(t('shop.payUnavailable'), { kind: 'warn', timeout: 7000 });
    else if (res.error === 'offline') toast(t('shop.offline'), { kind: 'error' });
    else toast(t('shop.payFailed'), { kind: 'error' });
  }

  // "Top up": the coin packs, the biggest the best deal
  function topUp() {
    const packs = coinPacks();
    if (!packs.length) {
      toast(t(state && state.online ? 'shop.payUnavailable' : 'shop.offline'), { kind: 'warn', timeout: 7000 });
      return;
    }
    const best = packs.reduce((a, b) => (b.coins / Number(b.rub) > a.coins / Number(a.rub) ? b : a));
    let dialog = null;
    const cards = packs.map((p) => {
      const el = h('button.shop-pack', { type: 'button' },
        p === best && packs.length > 1 ? h('span.shop-pack-best', t('shop.best')) : null,
        coin(4), h('b', num(p.coins)), h('span.shop-pack-label', t('shop.coinsWord')), h('div.shop-pack-rub', rub(p.rub)));
      el.addEventListener('click', () => {
        dialog.close();
        startPay(p);
      });
      return el;
    });
    dialog = modal({ title: t('shop.topUpTitle'), width: 520, body: [h('div.shop-packs', cards), h('div.shop-pay-note', t('shop.payNote'))], buttons: [{ label: t('common.cancel'), value: false }] });
  }

  async function purchase(pack) {
    if (busy) return;
    if (state.coins != null && state.coins < pack.price) {
      toast(t('shop.noFunds', { price: num(pack.price), coins: num(state.coins) }), { kind: 'warn', icon: 'coin', timeout: 8000, action: { label: t('shop.topUp'), onClick: topUp } });
      return;
    }
    if (!(await confirmDialog(t('shop.confirmTitle'), t('shop.confirm', { name: named(pack), price: num(pack.price) }), { ok: t('shop.buy'), danger: false }))) return;
    busy = true;
    render();
    let res = null;
    try {
      res = await api('shop:buy', pack.id);
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
    busy = false;
    if (res) {
      state = res.state;
      if (res.ok) toast(t('shop.bought', { name: named(pack) }), { kind: 'ok', icon: 'sparkle', timeout: 8000 });
      else if (res.error === 'funds') toast(t('shop.noFunds', { price: num(pack.price), coins: num(state.coins || 0) }), { kind: 'warn', icon: 'coin', timeout: 8000, action: { label: t('shop.topUp'), onClick: topUp } });
      else if (res.error === 'offline') toast(t('shop.offline'), { kind: 'error' });
      else toast(t('shop.failed'), { kind: 'error' });
    }
    render();
  }

  load(false);
  load(true);
  return () => life.dispose();
}
