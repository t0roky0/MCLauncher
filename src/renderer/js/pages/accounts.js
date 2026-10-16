// Profile: the account's card the way a friend sees it — its picture (the
// skin's face, or a picture of one's own), the name it plays Java under
// (changed right there), the hours and where, its items — and the accounts on
// this PC: switch, sign in another (Microsoft / Xbox only: an account keeps
// its cosmetics and coins), sign out.
import { h, swap, bag } from '../dom.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { api, store, onEvent } from '../core.js';
import { button, toast, spinner, confirmDialog, showMenu } from '../ui.js';
import { currentAppearance } from '../appearance.js';
import { skinFace, STEVE } from '../skin3d.js';
import { statTiles, serverList, itemGrid, playingChip } from '../profile-card.js';

const NICK = /^[A-Za-z0-9_]{3,16}$/;
const ru = () => getLang() !== 'en';

// A picture file → a small square one (cut to the middle), as a data URL the server takes
async function squarePicture(file, size = 96) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    // pixel art stays sharp; a photo is smoothed
    g.imageSmoothingEnabled = side > size * 2;
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    for (const q of [0.86, 0.72, 0.55]) {
      const d = c.toDataURL('image/webp', q);
      if (d.length <= 9000) return d;
    }
    throw new Error(ru() ? 'Картинка слишком сложная — выберите попроще.' : 'That picture is too detailed — pick a simpler one.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function mount(root, params, { go }) {
  const life = bag();
  let signingIn = false;
  let profile = null;
  let cosmetics = null;
  let editing = false;

  const hero = h('div.pf-hero');
  const statsBox = h('div');
  const serversCard = h('div.card.pf-card');
  const itemsCard = h('div.card.pf-card');
  const accountsCard = h('div.card.pf-card.pf-accounts');
  root.append(
    h('div.page-head', button(t('nav.back'), { icon: 'back', variant: 'ghost', onClick: () => go('home') }), h('div.page-title', ru() ? 'Профиль' : 'Profile'), h('div.grow')),
    h('div.page-body', h('div.pf-wrap', hero, statsBox, h('div.pf-cols', serversCard, itemsCard), accountsCard)),
  );

  const active = () => {
    const cfg = store.get('config') || {};
    return (cfg.accounts || []).find((a) => a.id === cfg.activeAccount) || null;
  };

  // ---- the picture ----------------------------------------------------------------------------
  async function face(a, size) {
    if (a && a.id === (active() || {}).id && profile && profile.avatar) return profile.avatar;
    const { url } = await currentAppearance(a);
    return skinFace(url, size).catch(() => skinFace(STEVE, size));
  }

  const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
  picker.addEventListener('change', async () => {
    const file = picker.files && picker.files[0];
    picker.value = '';
    if (!file) return;
    try {
      profile = await api('profile:setAvatar', await squarePicture(file));
      render();
      window.dispatchEvent(new Event('mcl:skin-changed'));
      toast(ru() ? 'Аватар сохранён' : 'Picture saved', { kind: 'ok', icon: 'user' });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  });
  root.append(picker);

  function avatarMenu(anchor) {
    showMenu(anchor, [
      { label: ru() ? 'Загрузить картинку…' : 'Upload a picture…', icon: 'image', onClick: () => picker.click() },
      { label: ru() ? 'Лицо скина' : 'The skin’s face', icon: 'user', onClick: async () => {
        profile = await api('profile:setAvatar', '');
        render();
        window.dispatchEvent(new Event('mcl:skin-changed'));
      } },
    ], { align: 'left' });
  }

  // ---- the name -------------------------------------------------------------------------------
  async function saveNick(a, value) {
    const n = String(value || '').trim();
    if (n && !NICK.test(n)) {
      toast(t('accounts.nickInvalid'), { kind: 'warn' });
      return false;
    }
    try {
      await api('accounts:setNick', a.id, n === a.name ? '' : n);
      store.set({ config: await api('config:get') });
      toast(t('accounts.javaNickSaved', { name: n || a.name }), { kind: 'ok', icon: 'user' });
      return true;
    } catch (e) {
      toast(e.message, { kind: 'error' });
      return false;
    }
  }

  function nameBlock(a) {
    const shown = a.javaNick || a.name;
    if (!editing) {
      return h('div.pf-name-row',
        h('div.pf-name', shown),
        h('button.pf-edit', { type: 'button', 'data-tip': t('accounts.javaNickEdit'), onclick: () => { editing = true; renderHero(); } }, icon('edit')));
    }
    const box = h('input.pf-name-input', { value: shown, maxLength: 16, spellcheck: false });
    const finish = async (save) => {
      if (save && box.value.trim() !== shown && !(await saveNick(a, box.value))) return;
      editing = false;
      renderHero();
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    box.addEventListener('input', () => box.classList.toggle('bad', !!box.value.trim() && !NICK.test(box.value.trim())));
    setTimeout(() => { box.focus(); box.select(); }, 20);
    return h('div.pf-name-edit',
      h('div.pf-name-row',
        box,
        button(null, { icon: 'check', cls: 'btn-sm btn-icon', variant: 'primary', title: t('common.save'), onClick: () => finish(true) }),
        button(null, { icon: 'x', cls: 'btn-sm btn-icon', title: t('common.cancel'), onClick: () => finish(false) })),
      h('div.pf-name-hint', t('accounts.javaNickHint')));
  }

  // ---- drawing ----------------------------------------------------------------------------------
  let faceToken = 0;
  function renderHero() {
    const a = active();
    if (!a) {
      swap(hero, h('div.pf-hero-in', h('div.pf-pic.empty', icon('user', { scale: 3 })), h('div.pf-id', h('div.pf-name', ru() ? 'Войдите в аккаунт' : 'Sign in'),
        h('div.pf-sub', t('accounts.xboxOnly')), h('div.pf-chips', signInButtons()))));
      return;
    }
    const img = h('img', { alt: '' });
    const token = ++faceToken;
    face(a, 112).then((d) => { if (token === faceToken) img.src = d; }).catch(() => {});
    const pic = h('button.pf-pic', { type: 'button', 'data-tip': ru() ? 'Сменить аватар' : 'Change picture', class: profile && profile.avatar ? 'own' : '' }, img, h('span.pf-pic-edit', icon('image')));
    pic.addEventListener('click', () => avatarMenu(pic));
    const licence = a.type === 'msa' ? (a.javaNick ? (ru() ? 'Java без лицензии — свой ник' : 'Java offline — own name') : (ru() ? 'Лицензия Java' : 'Java licence')) : (ru() ? 'Java без лицензии' : 'Java offline');
    swap(hero, h('div.pf-hero-in',
      pic,
      h('div.pf-id',
        nameBlock(a),
        h('div.pf-sub', a.gamertag ? h('span', `Xbox: ${a.gamertag}`) : null, a.gamertag ? h('span.dot', '·') : null, h('span', licence)),
        h('div.pf-chips', playingChip(profile && profile.playing), a.needsLogin ? h('span.chip.warn', t('accounts.needsLogin')) : null),
      ),
      h('div.pf-hero-side',
        button(ru() ? 'Скины и плащи' : 'Skins & capes', { icon: 'hanger', cls: 'btn-sm', onClick: () => go('skins') }),
        a.needsLogin ? button(t('accounts.relogin'), { variant: 'primary', cls: 'btn-sm', onClick: () => signIn() }) : null),
    ));
  }

  function render() {
    renderHero();
    if (!active() || !profile) {
      swap(statsBox);
      swap(serversCard, h('div.section-title', icon('globe'), ru() ? 'Где играю' : 'Where I play'), active() ? spinner() : null);
      swap(itemsCard, h('div.section-title', icon('sparkle'), ru() ? 'Предметы' : 'Items'), active() ? spinner() : null);
    } else {
      const all = cosmetics ? cosmetics.items : [];
      const owned = all.filter((i) => i.owned).map((i) => i.id);
      swap(statsBox, statTiles(profile, owned.length, all.length));
      swap(serversCard, h('div.section-title', icon('globe'), ru() ? 'Где играю' : 'Where I play'), serverList(profile.servers));
      swap(itemsCard, h('div.section-title', icon('sparkle'), ru() ? 'Предметы' : 'Items', h('div.grow'), button(ru() ? 'Все' : 'All', { cls: 'btn-sm', variant: 'ghost', onClick: () => go('skins') })), itemGrid(owned, all));
    }
    renderAccounts();
  }

  // ---- the accounts on this PC -------------------------------------------------------------------
  async function signIn(inApp) {
    if (signingIn) return;
    signingIn = true;
    render();
    try {
      const acc = await api('accounts:signIn', typeof inApp === 'boolean' ? { inApp } : {});
      if (acc.noJava) toast(t('accounts.noJavaSignedIn', { tag: acc.gamertag, name: acc.name }), { kind: 'info', icon: 'user', timeout: 14000 });
      else toast(t('toast.signedIn', { name: acc.name }), { kind: 'ok', icon: 'user' });
      store.set({ config: await api('config:get') });
    } catch (e) {
      if (e.code !== 'cancelled') toast(e.message, { kind: 'error' });
    }
    signingIn = false;
    render();
  }

  function signInButtons() {
    if (signingIn) return [h('div.signing-in', spinner(), h('div', { style: { flex: 1 } }, t('accounts.signingIn')), button(t('accounts.cancelSignIn'), { cls: 'btn-sm', onClick: () => api('accounts:cancelSignIn') }))];
    return [
      button(ru() ? 'Добавить аккаунт' : 'Add account', { variant: 'primary', icon: 'microsoft', cls: 'btn-sm', onClick: () => signIn() }),
      button(t('accounts.signInBrowser'), { variant: 'ghost', cls: 'btn-sm', icon: 'globe', onClick: () => signIn(false) }),
    ];
  }

  let listToken = 0;
  function renderAccounts() {
    const cfg = store.get('config') || {};
    const token = ++listToken;
    const rows = (cfg.accounts || []).map((a) => {
      const img = h('img', { alt: '' });
      face(a, 32).then((d) => { if (token === listToken) img.src = d; }).catch(() => {});
      const isActive = a.id === cfg.activeAccount;
      return h('div.pf-acc', { class: isActive ? 'active' : '' },
        img,
        h('div.pf-acc-text', h('div.pf-acc-name', a.javaNick || a.name), h('div.pf-acc-sub', [a.gamertag ? `Xbox: ${a.gamertag}` : '', a.type === 'msa' ? t('accounts.typeMs') : t('accounts.typeXbox')].filter(Boolean).join(' · '))),
        a.needsLogin ? button(t('accounts.relogin'), { cls: 'btn-sm', variant: 'primary', onClick: () => signIn() })
          : isActive ? h('span.chip.good', t('accounts.active'))
            : button(t('accounts.use'), { cls: 'btn-sm', onClick: async () => {
              await api('accounts:select', a.id);
              store.set({ config: await api('config:get') });
            } }),
        button(null, { cls: 'btn-sm btn-icon', icon: 'trash', variant: 'ghost', title: t('accounts.remove'), onClick: async () => {
          if (!(await confirmDialog(t('confirm.removeAccount.title'), t('confirm.removeAccount.text', { name: a.name })))) return;
          await api('accounts:remove', a.id);
          store.set({ config: await api('config:get') });
        } }));
    });
    swap(accountsCard,
      h('div.section-title', icon('user'), ru() ? 'Аккаунты на этом компьютере' : 'Accounts on this PC'),
      rows.length ? h('div.pf-acc-list', rows) : null,
      h('div.pf-acc-add', signInButtons()),
      h('div.hint', t('accounts.xboxOnly')));
  }

  async function load() {
    try {
      [profile, cosmetics] = await Promise.all([api('profile:get'), api('cosmetics:state')]);
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
    if (!editing) render();
  }

  life.add(store.on('config', () => load()));
  life.add(onEvent('profile:changed', (p) => {
    if (!p) return;
    profile = p;
    if (!editing) render();
  }));
  life.add(onEvent('cosmetics:changed', (v) => {
    cosmetics = v;
    if (!editing) render();
  }));
  render();
  load();
  return () => life.dispose();
}
