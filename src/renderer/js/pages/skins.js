// Skins: live 3D model, the local library, the account's capes.
import { h, swap, bag } from '../dom.js';
import { t } from '../i18n.js';
import { icon, blockUrl } from '../icons.js';
import { bedrockMismatch, mismatchText, switchBedrockAccount } from '../bedrock-account.js';
import { api, onEvent, store, remote, dayAgo } from '../core.js';
import { button, iconButton, input, segmented, toggle, field, toast, spinner, showMenu, modal, confirmDialog, emptyState, dropdown } from '../ui.js';
import { SkinStage, skinThumbnail, capeFront, detectModel, STEVE } from '../skin3d.js';
import { currentAppearance } from '../appearance.js';
import { cosmeticsSection } from '../cosmetics-panel.js';

export function mount(root, params, { go }) {
  const life = bag();
  const cfg = store.get('config') || {};
  const account = cfg.accounts.find((a) => a.id === cfg.activeAccount) || cfg.accounts[0];
  const isMsa = account && account.type === 'msa' && !account.needsLogin;
  // without a Java licence capes are one's own PNGs, added like skins
  const usesLibrary = !!account;

  const state = {
    skins: [],
    profile: null,
    capes: [],
    officialCapes: [],
    target: 'launcher',
    previewId: null, // library skin on the stage (null = the account's current skin)
    previewData: null, // imported skin not saved yet: {name, model, dataUrl, capeUrl}
    currentUrl: '',
    currentModel: 'classic',
    capeUrl: '',
    busy: false,
    bedrock: null, // bedrock:info, when the game is on this PC
  };

  // ---- stage --------------------------------------------------------------------
  const canvas = h('canvas');
  const stageName = h('div.stage-name');
  const stageTop = h('div.stage-top', stageName, h('div', { style: { flex: '1' } }));
  const stageLoading = h('div.stage-loading', spinner('lg'));
  const stageEl = h('div.stage', canvas, stageTop, stageLoading, h('div.stage-hint', t('skins.dragHint')));
  // drawn every frame of the monitor: at 60 a second the walking figure stuttered on a 144/165 Hz screen
  const stage = new SkinStage(canvas, { width: 320, height: 420, fps: 0 });
  life.add(() => stage.dispose());

  const ro = new ResizeObserver(() => {
    const r = stageEl.getBoundingClientRect();
    if (r.width > 10 && r.height > 10) stage.resize(Math.round(r.width), Math.round(r.height));
  });
  ro.observe(stageEl);
  life.add(() => ro.disconnect());

  const animSeg = segmented(
    [
      { value: 'idle', label: t('skins.anim.idle') },
      { value: 'walk', label: t('skins.anim.walk') },
      { value: 'run', label: t('skins.anim.run') },
      { value: 'fly', label: t('skins.anim.fly') },
    ],
    'walk',
    (v) => stage.setAnimation(v),
  );
  stage.setAnimation('walk');
  const elytraToggle = toggle(false, (v) => stage.setElytra(v));
  const rotateToggle = toggle(false, (v) => stage.setAutoRotate(v));
  const applyBtn = button(t('skins.apply'), { variant: 'primary', icon: 'check', onClick: () => applyPreview() });
  const saveImportBtn = button(t('skins.saveToLibrary'), { icon: 'download', onClick: () => saveImported() });
  const stageControls = h(
    'div.stage-controls',
    animSeg,
    isMsa ? field(t('skins.applyTarget'), segmented([{value:'launcher',label:'MC Launcher'}, {value:'mojang',label:t('skins.officialSkin')}], state.target, v => { state.target=v; renderStageButtons(); }), t('skins.targetHint')) : null,
    h('div.row', h('label.row', { style: { gap: '8px', cursor: 'pointer' } }, elytraToggle, h('span.muted', t('skins.elytra'))), h('div.grow'), h('label.row', { style: { gap: '8px', cursor: 'pointer' } }, rotateToggle, h('span.muted', t('skins.rotate')))),
    h('div.row', h('div.grow', applyBtn), saveImportBtn),
  );
  const stageCard = h('div.card.stage-card', stageEl, stageControls);

  async function showOnStage(url, model, name) {
    stageLoading.style.display = '';
    try {
      await stage.setSkin(url, model);
      await stage.setCape(state.capeUrl);
    } catch (e) {
      console.warn(e);
    }
    stageLoading.style.display = 'none';
    stageName.textContent = name || '';
    renderStageButtons();
  }

  // One skin for Java and Bedrock: "Put on" dresses both. An Xbox account
  // dressed before that wears its Bedrock pick until it puts one on here.
  function worn(s) {
    const fresh = account && ((store.get('config') || {}).accounts || []).find((a) => a.id === account.id);
    const mine = (fresh || account || {}).skin;
    if (s.valid === false) return false;
    if (mine && state.skins.some((x) => x.id === mine)) return s.id === mine;
    if (isMsa) return false;
    if (state.skins.some((x) => x.active)) return !!s.active;
    return !!(account && account.type === 'xbox' && (store.get('config') || {}).bedrockSkin === s.id);
  }

  function renderStageButtons() {
    const lib = state.skins.find((s) => s.id === state.previewId);
    saveImportBtn.style.display = state.previewData ? '' : 'none';
    applyBtn.style.display = state.previewData ? 'none' : '';
    applyBtn.disabled = !lib || lib.valid === false || state.busy || (state.target === 'launcher' && worn(lib));
    const label = applyBtn.querySelector('.btn-label');
    if (label) label.textContent = lib && state.target === 'launcher' && worn(lib) ? t('skins.applied') : t('skins.apply');
    for (const c of grid.querySelectorAll('.skin-card')) c.classList.toggle('previewing', c.dataset.id === state.previewId);
  }

  // ---- right column ------------------------------------------------------------------
  const grid = h('div.skin-grid');
  const capeStrip = h('div.cape-strip');
  const officialCapeStrip = h('div.cape-strip');
  const importInput = input({ placeholder: t('skins.importPlaceholder'), maxLength: 16, onEnter: () => doImport() });
  const importBtn = button(t('skins.importGo'), { icon: 'search', onClick: () => doImport() });
  const toolbar = h(
    'div.skins-toolbar',
    h('div.section-title', { style: { margin: 0 } }, icon('hanger'), t('skins.library')),
    h('div.grow'),
    h('div.import-row', h('div', { style: { width: '170px' } }, importInput), importBtn),
    button(t('skins.add'), { variant: 'primary', icon: 'plus', onClick: () => addFromFile() }),
  );
  const capeHint = h('div.hint.cape-hint');
  const capesSection = h('div', h('div.section-title', icon('cape'), t('skins.capes')), capeStrip, capeHint, isMsa ? h('div', h('div.section-title', t('skins.microsoftCapes')), officialCapeStrip) : null);
  const bedrockSection = h('div.bedrock-skin');
  const needsLogin = account && account.type === 'msa' && account.needsLogin;
  const guestNote = needsLogin
    ? h('div.note', icon('warning'), h('div', { style: { flex: '1' } }, t('friends.needsLogin.title')), button(t('accounts.relogin'), { variant: 'primary', cls: 'btn-sm', onClick: () => go('accounts') }))
    : !isMsa
      ? h('div.note', icon('info'), account && account.type === 'xbox' ? t('skins.xboxNote', { name: account.name }) : t('skins.guestNote'))
      : null;
  const cosmetics = cosmeticsSection(stage, { focusEvent: !!(params && params.focus === 'event') });
  life.add(cosmetics.dispose);
  const main = h('div.skins-main', toolbar, h('div.note', t('skins.launcherNote')), guestNote, grid, cosmetics.el, capesSection, bedrockSection);
  const dropZone = h('div.drop-zone', t('skins.dropHint'));

  root.append(
    h('div.page-head', button(t('nav.back'), { icon: 'back', variant: 'ghost', onClick: () => go('home') }), h('div.page-title', t('skins.title')), h('div.grow')),
    h('div.page-body', stageCard, main),
    dropZone,
  );

  // ---- library ---------------------------------------------------------------------------
  function renderGrid() {
    const cards = state.skins.map((s) => {
      const img = h('img.thumb.loading', { alt: '' });
      skinThumbnail(s.url, s.model).then((d) => {
        img.src = d;
        img.classList.remove('loading');
      }).catch(() => {});
      const menuBtn = iconButton('dots', { cls: 'btn-sm sc-menu', variant: 'ghost' });
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cardMenu(menuBtn, s);
      });
      const card = h(
        'div.skin-card',
        { dataset: { id: s.id }, class: [worn(s) ? 'active' : '', s.id === state.previewId ? 'previewing' : ''].join(' ') },
        worn(s) ? h('span.chip.acc.sc-badge', t('skins.applied')) : null,
        menuBtn,
        img,
        h('div.sc-name', s.name),
        h('div.sc-model', `${s.model === 'slim' ? t('skins.slim') : t('skins.classic')} · ${s.width || 64}×${s.height || s.width || 64}`),
      );
      card.addEventListener('click', () => preview(s));
      card.addEventListener('dblclick', () => apply(s));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        cardMenu(null, s, e.clientX, e.clientY);
      });
      return card;
    });
    const add = h('button.skin-add', { type: 'button' }, icon('plus', { scale: 3 }), t('skins.add'));
    add.addEventListener('click', () => addFromFile());
    if (!state.skins.length) {
      swap(grid, h('div.skin-empty', icon('hanger', { scale: 2 }), h('div', t('skins.empty')), button(t('skins.add'), { icon: 'plus', onClick: () => addFromFile() })));
    } else {
      swap(grid, cards, add);
    }
  }

  function cardMenu(anchor, s, x, y) {
    showMenu(
      anchor,
      [
        { label: t('skins.apply'), icon: 'check', disabled: s.valid === false || (state.target === 'launcher' && worn(s)), onClick: () => apply(s) },
        { label: t('skins.edit'), icon: 'edit', onClick: () => editDialog(s) },
        { label: t('skins.export'), icon: 'download', onClick: () => api('skins:export', s.id, s.name) },
        { separator: true },
        { label: t('skins.delete'), icon: 'trash', danger: true, onClick: () => remove(s) },
      ],
      typeof x === 'number' ? { x, y } : {},
    );
  }

  function preview(s) {
    if (s.valid === false) { toast(s.error, { kind: 'error' }); return; }
    state.previewId = s.id;
    state.previewData = null;
    showOnStage(s.url, s.model, s.name);
  }

  async function apply(s) {
    if (state.busy) return;
    if (s.valid === false) { toast(s.error, { kind: 'error' }); return; }
    state.busy = true;
    renderStageButtons();
    try {
      const r = await api('skins:apply', s.id, state.target);
      const later = r.bedrock && r.bedrock.reason === 'running';
      toast(`${r.uploaded ? t('toast.skinApplied', { name: s.name }) : t('toast.skinLocal', { name: s.name })}${later ? ` ${t('skins.bedrockAfterExit')}` : ''}`, { kind: 'ok', icon: 'hanger' });
      if (r.bedrock && r.bedrock.pickOnce) toast(t('skins.bedrockPickOnce'), { kind: 'warn', timeout: 14000 });
      // the account now remembers this skin
      store.set({ config: await api('config:get') });
      if (r.bedrock) {
        state.bedrock = await api('bedrock:info').catch(() => state.bedrock);
        renderBedrock();
      }
      await reloadSkins();
      // the account badge face follows the new skin
      window.dispatchEvent(new Event('mcl:skin-changed'));
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
    state.busy = false;
    renderStageButtons();
  }

  function applyPreview() {
    const s = state.skins.find((x) => x.id === state.previewId);
    if (s) apply(s);
  }

  async function remove(s) {
    if (!(await confirmDialog(t('confirm.deleteSkin.title'), t('confirm.deleteSkin.text', { name: s.name })))) return;
    await api('skins:remove', s.id);
    window.dispatchEvent(new Event('mcl:skin-changed'));
    if (state.previewId === s.id) {
      state.previewId = null;
      showCurrent();
    }
    reloadSkins();
  }

  async function reloadSkins() {
    state.skins = await api('skins:list');
    renderGrid();
    renderStageButtons();
  }

  // ---- add / edit dialogs -------------------------------------------------------------------
  function skinDialog({ title, name, model, url, onSave }) {
    let m = model || 'classic';
    let size = 0;
    const format = dropdown([{value:0,label:t('skins.originalSize')}, ...[64,128].map(n=>({value:n,label:n === 128 ? '128×128 (32x)' : '64×64'}))], size, v => {size=v;});
    const nameInput = input({ value: name || '', maxLength: 32, placeholder: t('skins.untitled') });
    const preview = h('img', { style: { width: '110px', height: '140px', objectFit: 'contain' }, alt: '' });
    const refresh = () => skinThumbnail(url, m).then((d) => (preview.src = d)).catch(() => {});
    const seg = segmented([{ value: 'classic', label: t('skins.classic') }, { value: 'slim', label: t('skins.slim') }], m, (v) => {
      m = v;
      refresh();
    });
    refresh();
    const body = h('div', { style: { display: 'grid', gridTemplateColumns: '120px 1fr', gap: '18px', alignItems: 'center' } }, h('div', { style: { display: 'grid', placeItems: 'center', background: '#151413', border: '2px solid var(--line)', height: '160px' } }, preview), h('div', field(t('skins.name'), nameInput), field(t('skins.model'), seg), field(t('skins.pixelSize'), format, t('skins.resizeHint'))));
    const dlg = modal({
      title,
      body,
      width: 520,
      buttons: [
        { label: t('common.cancel') },
        { label: t('common.save'), variant: 'primary', onClick: async (close) => {
          try {
            await onSave({ name: nameInput.value.trim() || t('skins.untitled'), model: m, size });
            close(true);
          } catch (e) {
            toast(e.message, { kind: 'error' });
          }
        } },
      ],
    });
    setTimeout(() => nameInput.focus(), 50);
    return dlg;
  }

  async function addFromFile(path) {
    const file = path || (await api('app:pickFile', { title: t('skins.addFile'), filters: [{ name: 'PNG', extensions: ['png'] }] }));
    if (!file) return;
    // The renderer can't read local files; main adds the file, and the
    // name/model dialog then works on the stored copy.
    try {
      const added = await api('skins:add', { path: file, name: file.split(/[\\/]/).pop().replace(/\.png$/i, '').slice(0, 32) });
      await reloadSkins();
      const model = await detectModel(added.url);
      if (model !== added.model) await api('skins:update', added.id, { model });
      await reloadSkins();
      const s = state.skins.find((x) => x.id === added.id);
      preview(s);
      skinDialog({ title: t('skins.add'), name: s.name, model: s.model, url: s.url, onSave: async ({ name, model: mm, size }) => {
        await api('skins:update', s.id, { name, model: mm, size });
        await reloadSkins();
        preview(state.skins.find((x) => x.id === s.id));
      } });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  function editDialog(s) {
    skinDialog({ title: t('skins.edit'), name: s.name, model: s.model, url: s.url, onSave: async ({ name, model, size }) => {
      await api('skins:update', s.id, { name, model, size });
      window.dispatchEvent(new Event('mcl:skin-changed'));
      await reloadSkins();
      if (state.previewId === s.id) preview(state.skins.find((x) => x.id === s.id));
    } });
  }

  async function doImport() {
    const nick = importInput.value.trim();
    if (!nick) return;
    importBtn.disabled = true;
    try {
      const r = await api('skins:import', nick);
      state.previewId = null;
      state.previewData = r;
      await showOnStage(r.dataUrl, r.model, r.name);
      if (r.capeUrl) await stage.setCape(remote(r.capeUrl));
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
    importBtn.disabled = false;
  }

  function saveImported() {
    const d = state.previewData;
    if (!d) return;
    skinDialog({ title: t('skins.saveToLibrary'), name: d.name, model: d.model, url: d.dataUrl, onSave: async ({ name, model, size }) => {
      const added = await api('skins:add', { dataUrl: d.dataUrl, name, model, size });
      state.previewData = null;
      await reloadSkins();
      preview(state.skins.find((x) => x.id === added.id));
    } });
  }

  // ---- bedrock ----------------------------------------------------------------------------------
  // Library skins go into a skin pack of ours; "Put on" selects the skin in
  // Bedrock's options too (right away when it's closed, else after it). This
  // card only shows how that stands: what Bedrock wears, which Xbox account
  // and profile it plays as.
  function renderBedrock() {
    const b = state.bedrock;
    if (!b || !b.installed) {
      swap(bedrockSection);
      return;
    }
    const skin = state.skins.find((x) => x.id === b.skin);
    const thumb = h('img.bs-thumb', { alt: '' });
    // not set by the launcher: show what the game wears, if we can
    const shown = skin ? { url: skin.url, model: skin.model } : b.worn ? { url: b.worn.skinUrl, model: b.worn.model } : null;
    if (shown) skinThumbnail(shown.url, shown.model).then((d) => (thumb.src = d)).catch(() => {});
    else {
      thumb.classList.add('block');
      thumb.src = blockUrl('bedrock');
    }
    const current = h(
      'div.bs-current',
      thumb,
      h('div.bs-text', h('div.bs-name', skin ? skin.name : t('skins.bedrockNone')), h('div.hint', { style: { margin: 0 } }, skin ? t('skins.bedrockHint') : t('skins.bedrockPick'))),
    );
    const auto = toggle(b.autoSkin, async (v) => {
      store.set({ config: await api('config:set', { bedrockAutoSkin: v }) });
      b.autoSkin = v;
    });
    const rows = [current];
    // Bedrock plays as the Xbox app's account, which may not be this one
    const other = bedrockMismatch(b, store.get('config'));
    if (other) rows.push(h('div.bs-note.warn', icon('warning'), h('div.bs-note-text', mismatchText(other)), button(t('bedrock.switchAccount'), { cls: 'btn-sm', onClick: () => switchBedrockAccount(other.name) })));
    if (b.pickOnce) rows.push(h('div.bs-note', icon('info'), h('div.bs-note-text', t('skins.bedrockPickOnce'))));
    rows.push(h('label.toggle-row', h('div.toggle-text', h('div.toggle-title', t('skins.bedrockAuto')), h('div.hint', t('skins.bedrockAutoHint'))), auto));
    if (b.profiles.length > 1) {
      const opts = [{ value: '', label: t('skins.bedrockProfileAuto') }, ...b.profiles.map((p, i) => ({ value: p.id, label: t('skins.bedrockProfile', { n: i + 1, when: dayAgo(p.lastPlayed) }) }))];
      const dd = dropdown(opts, (store.get('config') || {}).bedrockProfile || '', async (v) => {
        store.set({ config: await api('config:set', { bedrockProfile: v }) });
        state.bedrock = await api('bedrock:info');
      });
      rows.push(field(t('skins.bedrockProfiles'), dd, t('skins.bedrockProfilesHint')));
    }
    rows.push(h('div.row', button(t('skins.bedrockFolder'), { icon: 'folder', cls: 'btn-sm', onClick: () => api('bedrock:openFolder') })));
    swap(bedrockSection, h('div.section-title', h('img.section-block', { src: blockUrl('bedrock'), alt: '' }), `Bedrock ${b.version}`), h('div.card.bs-card', rows));
  }

  // ---- capes ------------------------------------------------------------------------------------
  async function renderCapes() {
    if (usesLibrary) renderLibraryCapes();
    if (!isMsa) {
      swap(officialCapeStrip, h('div.muted', t('skins.capesGuest')));
      return;
    }
    if (!state.profile) {
      swap(officialCapeStrip, spinner());
      return;
    }
    if (!state.officialCapes.length) {
      swap(officialCapeStrip, h('div.muted', t('skins.noCapes')));
      return;
    }
    const wearingNone = !state.officialCapes.some((c) => c.active);
    const none = h('div.cape-card', { class: wearingNone ? 'active' : '' }, h('div.cape-none', icon('x')), h('div.cc-name', t('skins.noCape')));
    none.addEventListener('click', () => setCape(null));
    const cards = state.officialCapes.map((c) => {
      const img = h('img', { alt: '' });
      capeFront(remote(c.url), 4).then((d) => (img.src = d)).catch(() => {});
      const card = h('div.cape-card', { class: c.active ? 'active' : '', 'data-tip': c.alias }, img, h('div.cc-name', c.alias));
      card.addEventListener('click', () => setCape(c));
      card.addEventListener('mouseenter', () => {
        if (!c.active) stage.setCape(remote(c.url));
      });
      card.addEventListener('mouseleave', () => stage.setCape(state.capeUrl));
      return card;
    });
    swap(officialCapeStrip, none, cards);
  }

  let capeAsk = 0; // the last click's: only its answer is shown
  async function setCape(c) {
    const ask = ++capeAsk;
    const already = c ? c.active : !state.officialCapes.some((x) => x.active);
    if (already && !state.capes.some(x=>x.worn)) return;
    const prev = state.officialCapes.map((x) => ({ ...x }));
    state.officialCapes = state.officialCapes.map((x) => ({ ...x, active: c ? x.id === c.id : false }));
    state.capeUrl = c ? remote(c.url) : '';
    stage.setCape(state.capeUrl);
    renderCapes();
    try {
      await api('skins:setCape', c ? c.id : '');
      if (ask !== capeAsk) return;
      state.capes = await api('skins:capes');
      renderCapes();
      store.set({ config: await api('config:get') });
      window.dispatchEvent(new Event('mcl:skin-changed'));
      toast(c ? t('toast.capeApplied', { name: c.alias }) : t('toast.capeRemoved'), { kind: 'ok', icon: 'cape' });
    } catch (e) {
      if (ask !== capeAsk) return;
      state.officialCapes = prev;
      const active = prev.find((x) => x.active);
      state.capeUrl = active ? remote(active.url) : '';
      stage.setCape(state.capeUrl);
      renderCapes();
      toast(e.message, { kind: 'error' });
    }
  }

  // ---- one's own capes (guests, Xbox accounts) ----------------------------------------------------------
  function renderLibraryCapes() {
    const wearing = state.capes.find((c) => c.worn);
    const none = h('div.cape-card', { class: wearing ? '' : 'active' }, h('div.cape-none', icon('x')), h('div.cc-name', t('skins.noCape')));
    none.addEventListener('click', () => wearLibraryCape(null));
    const cards = state.capes.map((c) => {
      const img = h('img', { alt: '' });
      capeFront(c.url, 4).then((d) => (img.src = d)).catch(() => {});
      const tip = c.kind === 'bedrock' ? `${c.name} · ${t('skins.capeOfficial')}` : c.name;
      const card = h('div.cape-card', { class: [c.worn ? 'active' : '', c.kind].join(' '), 'data-tip': tip }, img, h('div.cc-name', c.name), c.kind === 'bedrock' ? h('span.cc-tag', 'Bedrock') : null);
      card.addEventListener('click', () => wearLibraryCape(c));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu(card, [
          { label: t('skins.capeRename'), icon: 'edit', onClick: () => renameCape(c) },
          { label: t('common.delete'), icon: 'trash', danger: true, onClick: () => removeCape(c) },
        ], { x: e.clientX, y: e.clientY });
      });
      card.addEventListener('mouseenter', () => {
        if (!c.worn) stage.setCape(c.url);
      });
      card.addEventListener('mouseleave', () => stage.setCape(state.capeUrl));
      return card;
    });
    const add = h('div.cape-card.cape-take', { 'data-tip': t('skins.capeAddTip') }, h('div.cape-none', icon('plus')), h('div.cc-name', t('skins.capeAdd')));
    add.addEventListener('click', () => addCapeFromFile());
    swap(capeStrip, none, add, cards);
    capeHint.textContent = t('skins.capesHint');
  }

  async function addCapeFromFile() {
    const file = await api('app:pickFile', { title: t('skins.capeAdd'), filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (!file) return;
    try {
      const added = await api('skins:addCape', { path: file, name: file.split(/[\\/]/).pop().replace(/\.png$/i, '').slice(0, 32) });
      if (added.existed) toast(t('skins.capeExists', { name: added.name }), { kind: 'info', icon: 'cape' });
      // a new cape goes on right away
      await wearLibraryCape({ ...added, worn: false }, { quiet: added.existed });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  async function capesChanged(list) {
    state.capes = list;
    const wearing = list.find((c) => c.worn);
    state.capeUrl = wearing ? wearing.url : remote((state.officialCapes.find(c=>c.active) || {}).url || '');
    stage.setCape(state.capeUrl);
    renderLibraryCapes();
    store.set({ config: await api('config:get') });
    window.dispatchEvent(new Event('mcl:skin-changed'));
  }

  async function wearLibraryCape(c, { quiet = false } = {}) {
    if (c ? c.worn : !state.capes.some((x) => x.worn)) return;
    try {
      const r = await api('skins:wearCape', c ? c.id : '');
      await capesChanged(r.capes);
      if (quiet) return;
      toast(c ? t('toast.capeApplied', { name: c.name }) : t('toast.capeRemoved'), { kind: 'ok', icon: 'cape' });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  function renameCape(c) {
    const inp = input({ value: c.name, maxLength: 32, onEnter: () => done() });
    const dlg = modal({
      title: t('skins.capeRename'),
      body: inp,
      buttons: [
        { label: t('common.cancel'), value: false },
        { label: t('common.save'), variant: 'primary', onClick: () => done() },
      ],
    });
    async function done() {
      const name = inp.value.trim();
      dlg.close(true);
      if (!name || name === c.name) return;
      try {
        state.capes = await api('skins:renameCape', c.id, name);
        renderLibraryCapes();
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
    }
    setTimeout(() => inp.select(), 30);
  }

  async function removeCape(c) {
    if (!(await confirmDialog(t('skins.capeRemoveTitle'), t('skins.capeRemoveText', { name: c.name })))) return;
    await capesChanged(await api('skins:removeCape', c.id)).catch((e) => toast(e.message, { kind: 'error' }));
  }

  // ---- initial state ----------------------------------------------------------------------------
  async function showCurrent() {
    state.previewData = null;
    if (state.currentUrl) await showOnStage(state.currentUrl, state.currentModel, account ? account.name : '');
    else await showOnStage(STEVE, 'classic', account ? account.name : 'Steve');
  }

  async function init() {
    await reloadSkins();
    api('bedrock:info')
      .then((b) => {
        state.bedrock = b;
        renderGrid();
        renderStageButtons();
        renderBedrock();
      })
      .catch(() => {});
    if (isMsa) {
      try {
        state.profile = await api('skins:profile');
        state.officialCapes = state.profile.capes;
      } catch (e) {
        state.profile = { capes: [] };
        toast(t('skins.loadError', { e: e.message }), { kind: 'error' });
      }
    }
    if (usesLibrary) state.capes = await api('skins:capes').catch(() => []);
    const wearing = state.capes.find(c=>c.worn);
    state.capeUrl = wearing ? wearing.url : remote((state.officialCapes.find(c=>c.active) || {}).url || '');
    renderCapes();
    const current = await currentAppearance(account);
    state.currentUrl = current.url;
    state.currentModel = current.model;
    const active = state.skins.find((s) => worn(s));
    if (active) preview(active);
    else await showCurrent();
  }
  stageLoading.style.display = '';
  init();

  // ---- drag & drop ------------------------------------------------------------------------------
  let dragDepth = 0;
  const onEnter = (e) => {
    if (![...(e.dataTransfer.items || [])].some((i) => i.kind === 'file')) return;
    dragDepth++;
    dropZone.classList.add('show');
  };
  const onLeave = () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropZone.classList.remove('show');
  };
  const onDrop = (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove('show');
    const f = [...e.dataTransfer.files].find((x) => /\.png$/i.test(x.name));
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const model = await detectModel(reader.result);
        const added = await api('skins:add', { dataUrl: reader.result, name: f.name.replace(/\.png$/i, '').slice(0, 32), model });
        await reloadSkins();
        preview(state.skins.find((x) => x.id === added.id));
      } catch (err) {
        toast(err.message, { kind: 'error' });
      }
    };
    reader.readAsDataURL(f);
  };
  root.addEventListener('dragenter', onEnter);
  root.addEventListener('dragleave', onLeave);
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', onDrop);

  return () => life.dispose();
}
