// The shop: packs of cosmetics for coins, each a block of its own side by
// side (in the event's style: the pack's colour round it, the player wearing
// it, turning slowly; what's in the pack, as cards; its price and "Buy").
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

// the coin (assets/images/coin.png, the user's 8×8 pixel art) at a whole multiple: 3 → 24 px, 4 → 32 px
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
  let state = null;
  let busy = false;

  const balance = h('b.shop-coins', '—');
  const wallet = h(
    'div.shop-wallet',
    { 'data-tip': t('shop.balanceTip') },
    coin(3),
    balance,
    button(t('shop.topUp'), { icon: 'plus', cls: 'btn-sm shop-topup', onClick: topUp }),
  );
  const list = h('div.shop-list');
  const body = h('div.page-body', list);
  root.append(h('div.page-head', h('div.page-title', t('shop.title')), h('div.grow'), wallet), body);

  // a payment done (main.js tells about it): the page as it is now
  // another account signed in: its coins and purchases
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

  // ---- a pack's block: made once (its figure keeps turning), filled on every render ----
  const blocks = new Map(); // pack id → { el, text, stage }
  let look = null; // the player's skin, asked for once
  function block(pack) {
    let b = blocks.get(pack.id);
    if (b) return b;
    // the picture (shop-view) twice as wide as its column, under the text,
    // the mouse through it — wings, a pet turning round, aren't cut off at
    // the column's edges; the column (shop-stage) is where it's turned
    const canvas = h('canvas');
    const view = h('div.shop-view', canvas);
    const stageBox = h('div.shop-stage', h('div.shop-stage-wait', spinner('lg')));
    const stage = new SkinStage(canvas, { width: 260, height: 340, hit: stageBox });
    // a pet's pack: the pet alone, to look at from every side
    const pet = (pack.items || []).length > 0 && pack.items.every((i) => i.slot === 'pet');
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
    stage.setAnimation('idle');
    // the column's shape: the figure as big as it fits there (the picture round it only adds room)
    const columnAspect = () => {
      const c = stageBox.getBoundingClientRect();
      return c.width > 10 && c.height > 10 ? c.width / c.height : 0.75;
    };
    if (!pet) frame(stage.viewer, -11, 27, columnAspect());
    const ro = new ResizeObserver(() => {
      const r = view.getBoundingClientRect();
      if (r.width > 10 && r.height > 10) {
        stage.resize(Math.round(r.width), Math.round(r.height));
        // Fit once when laid out; preserve the user's zoom on later updates.
        if (!b.fitted) {
          stage.fitAspect = columnAspect();
          if (pet) stage.frameShowcase(); else frame(stage.viewer, -11, 27, stage.fitAspect);
          b.fitted = true;
        }
      }
    });
    ro.observe(view);
    const text = h('div.shop-feature-text');
    b = { el: h('div.shop-feature', view, text, stageBox), text, stage, ro, takeControl, giveBack, fitted: false };
    blocks.set(pack.id, b);
    if (!look) {
      const cfg = store.get('config') || {};
      const account = (cfg.accounts || []).find((a) => a.id === cfg.activeAccount) || (cfg.accounts || [])[0];
      look = currentAppearance(account);
    }
    look
      .then((l) => stage.setSkin(l.url, l.model))
      .then(() => (pet ? stage.showcase(pack.items.map((i) => i.id)) : stage.setCosmetics(pack.items.map((i) => i.id))))
      .then(() => stageBox.classList.add('ready'))
      .catch(() => {});
    return b;
  }
  function drop(id) {
    const b = blocks.get(id);
    b.ro.disconnect();
    b.stage.viewer.controls.removeEventListener('start', b.takeControl);
    b.stage.viewer.controls.removeEventListener('end', b.giveBack);
    b.stage.dispose();
    blocks.delete(id);
  }
  life.add(() => [...blocks.keys()].forEach(drop));

  // ---- what's drawn ------------------------------------------------------------
  function render() {
    balance.textContent = state && state.coins != null ? num(state.coins) : '—';
    wallet.classList.toggle('offline', !!state && !state.online);
    const packs = (state && state.packs) || [];
    for (const id of [...blocks.keys()]) if (!packs.some((p) => p.id === id)) drop(id);
    if (!packs.length) {
      swap(list, h('div.shop-empty', icon('shop'), t('shop.empty')));
      return;
    }
    const elements = packs.map((pack) => {
      const b = block(pack);
      // the pack's own colour round its block (the button stays the launcher's)
      if (pack.color) b.el.style.setProperty('--ev', pack.color);
      const buy = pack.owned
        ? h('div.shop-owned', icon('check'), t('shop.owned'))
        : button(t('shop.buy'), { variant: 'primary', icon: 'shop', cls: 'shop-buy', disabled: busy, onClick: () => purchase(pack) });
      swap(
        b.text,
        h('div.cos-ev-kicker', pack.featured ? t('shop.featured') : t('shop.pack')),
        h('div.shop-feature-title', named(pack)),
        h('div.shop-feature-sub', local(pack.tagline)),
        // what's in the pack: the Skins page's cards, in the block itself
        h('div.shop-feature-items', pack.items.map((i) => h(
          'div.cos-card.shop-card',
          { class: `r-${i.rarity}` },
          h('div.cos-art', h('img', { src: iconUrl(i.id), alt: '', draggable: false })),
          h('div.cos-name', { title: named(i) }, named(i)),
          h('div.cos-tags', h('span.cos-rarity', t(`cos.rarity.${i.rarity}`)), h('span.cos-dot', '·'), h('span.cos-slot', t(`cos.slot.${i.slot}`))),
        ))),
        h('div.shop-feature-buy', pack.owned ? null : price(pack.price), buy),
      );
      return b.el;
    });
    // Wallet refreshes must not detach a canvas during a captured drag.
    if (elements.length !== list.children.length || elements.some((el, i) => list.children[i] !== el)) swap(list, elements);
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
