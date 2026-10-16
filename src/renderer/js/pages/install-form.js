// New installation / edit installation.
import { h, swap, bag, debounce } from '../dom.js';
import { t, getLang } from '../i18n.js';
import { icon, blockUrl, BLOCK_IDS } from '../icons.js';
import { api, store, formatMb } from '../core.js';
import { button, input, searchBox, segmented, dropdown, field, slider, toast, spinner } from '../ui.js';

const LOADERS = [
  { value: 'vanilla', label: 'Vanilla' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
];
const LOADER_NAME = Object.fromEntries(LOADERS.map((l) => [l.value, l.label]));

export function mount(root, params, { go }) {
  const life = bag();
  const editing = params && params.id ? (store.get('installs') || []).find((e) => e.id === params.id) : null;
  if (params && params.id && !editing) {
    go('home');
    return () => {};
  }
  root.classList.add('form-page');

  const state = {
    name: editing ? editing.name : '',
    iconId: editing && BLOCK_IDS.includes(editing.iconId) ? editing.iconId : 'grass',
    loader: editing ? editing.loader : 'vanilla',
    mcVersion: editing ? editing.mcVersion : '',
    loaderVersion: editing ? editing.loaderVersion : '',
    ramMb: editing ? editing.ramMb || 0 : 0,
    jvmArgs: editing ? editing.jvmArgs || '' : '',
    javaPath: editing ? editing.javaPath || '' : '',
    filters: { release: true, snapshot: false, old: false },
    query: '',
    versions: [],
    nameTouched: !!editing,
  };

  // ---- icon -----------------------------------------------------------------------
  const iconImg = h('img', { src: blockUrl(state.iconId), alt: '' });
  const iconPick = h('button.icon-pick', { type: 'button' }, iconImg, h('div', h('div.label', { style: { margin: 0 } }, t('install.icon')), h('div.hint', t('install.iconHint'))));
  const setIcon = (id) => {
    state.iconId = id;
    iconImg.src = blockUrl(id);
  };
  const cycle = (step) => {
    const i = BLOCK_IDS.indexOf(state.iconId);
    setIcon(BLOCK_IDS[(i + step + BLOCK_IDS.length) % BLOCK_IDS.length]);
  };
  // Click → next block, right click → previous, the wheel scrolls through.
  iconPick.addEventListener('click', () => cycle(1));
  iconPick.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cycle(-1);
  });
  iconPick.addEventListener('wheel', (e) => {
    e.preventDefault();
    cycle(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  // ---- name, loader -----------------------------------------------------------------
  const nameInput = input({ value: state.name, placeholder: t('install.namePlaceholder'), maxLength: 40, onInput: (v) => {
    state.name = v;
    state.nameTouched = true;
  } });

  const loaderSeg = segmented(LOADERS, state.loader, (v) => {
    state.loader = v;
    state.loaderVersion = '';
    autoName();
    refreshLoaderVersions();
  });
  const loaderVerDrop = dropdown([], '', (v) => (state.loaderVersion = v), { placeholder: t('install.loaderLoading') });
  const loaderVerLabel = h('div.label');
  const loaderVerField = h('div.field', loaderVerLabel, loaderVerDrop);

  function autoName() {
    if (state.nameTouched || editing) return;
    const v = state.mcVersion;
    const name = v ? (state.loader === 'vanilla' ? v : `${LOADER_NAME[state.loader]} ${v}`) : '';
    nameInput.value = name;
    state.name = name;
  }

  let loaderReq = 0;
  async function refreshLoaderVersions() {
    const needs = state.loader !== 'vanilla';
    loaderVerField.style.display = needs ? '' : 'none';
    if (!needs) return;
    loaderVerLabel.textContent = t('install.loaderVersion', { loader: LOADER_NAME[state.loader] });
    if (!state.mcVersion) {
      loaderVerDrop.setOptions([], '');
      loaderVerDrop.disabled = true;
      return;
    }
    const req = ++loaderReq;
    loaderVerDrop.disabled = true;
    loaderVerDrop.setOptions([{ value: '', label: t('install.loaderLoading') }], '');
    try {
      const list = await api('versions:loaders', state.loader, state.mcVersion);
      if (req !== loaderReq) return;
      if (!list.length) {
        loaderVerDrop.setOptions([{ value: '', label: t('install.loaderUnavailable', { loader: LOADER_NAME[state.loader] }) }], '');
        state.loaderVersion = '';
        return;
      }
      const opts = list.slice(0, 200).map((v) => ({
        value: v.id,
        label: v.id,
        hint: v.tag === 'recommended' ? t('install.recommended') : v.tag === 'latest' ? t('install.latestTag') : v.stable && state.loader === 'fabric' ? t('install.stable') : '',
      }));
      const pick = list.find((v) => v.stable) || list[0];
      state.loaderVersion = pick.id;
      loaderVerDrop.setOptions(opts, pick.id);
      loaderVerDrop.disabled = false;
    } catch (e) {
      if (req !== loaderReq) return;
      loaderVerDrop.setOptions([{ value: '', label: t('install.loaderError') }], '');
    }
  }

  // ---- versions -------------------------------------------------------------------------
  const versionList = h('div.version-list', h('div.list-empty', spinner()));
  const chip = (key, label) => {
    const el = h('button.check-chip', { type: 'button', class: state.filters[key] ? 'on' : '' }, h('span.box'), label);
    el.addEventListener('click', () => {
      state.filters[key] = !state.filters[key];
      el.classList.toggle('on', state.filters[key]);
      renderVersions();
    });
    return el;
  };
  const versionSearch = searchBox({ placeholder: t('install.searchVersion'), onInput: debounce((v) => {
    state.query = v.trim().toLowerCase();
    renderVersions();
  }, 60) });

  function typeVisible(type) {
    if (type === 'release') return state.filters.release;
    if (type === 'snapshot') return state.filters.snapshot;
    return state.filters.old;
  }

  function renderVersions() {
    const shown = state.versions.filter((v) => typeVisible(v.type) && (!state.query || v.id.toLowerCase().includes(state.query)));
    if (!shown.length) {
      swap(versionList, h('div.list-empty', '—'));
      return;
    }
    const locale = getLang() === 'en' ? 'en-GB' : 'ru-RU';
    swap(
      versionList,
      shown.map((v) => {
        const row = h(
          'div.version-item',
          { class: v.id === state.mcVersion ? 'active' : '', dataset: { id: v.id } },
          h('span.v-id', v.id),
          h(`span.v-type.${v.type}`, t(`vtype.${v.type}`)),
          h('span.v-date', new Date(v.releaseTime).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })),
        );
        row.addEventListener('click', () => {
          state.mcVersion = v.id;
          for (const r of versionList.querySelectorAll('.version-item.active')) r.classList.remove('active');
          row.classList.add('active');
          autoName();
          refreshLoaderVersions();
        });
        return row;
      }),
    );
    // Scroll only the list (scrollIntoView would also move the page).
    const active = versionList.querySelector('.version-item.active');
    versionList.scrollTop = active ? Math.max(0, active.offsetTop - versionList.clientHeight / 2 + active.offsetHeight / 2) : 0;
  }

  async function loadVersions() {
    try {
      const m = await api('versions:manifest');
      state.versions = m.versions;
      if (!state.mcVersion && m.latest) {
        state.mcVersion = m.latest.release;
        autoName();
        refreshLoaderVersions();
      }
      renderVersions();
    } catch (e) {
      swap(versionList, h('div.list-empty', e.message));
    }
  }

  // ---- advanced ------------------------------------------------------------------------------
  const cfg = store.get('config') || {};
  const sys = { total: 8192 };
  const ramLabel = (v) => (v ? formatMb(v) : t('common.auto'));
  const ramSlider = slider({ min: 0, max: 16384, step: 512, value: state.ramMb, format: ramLabel, onInput: (v) => (state.ramMb = v) });
  api('app:system').then((s) => {
    sys.total = Math.round(s.totalMemMB || 8192);
    const max = Math.max(2048, Math.floor((sys.total - 1536) / 512) * 512);
    ramSlider.range.max = String(max);
    ramSlider.range.dispatchEvent(new Event('input'));
  }).catch(() => {});
  const jvmInput = input({ value: state.jvmArgs, placeholder: t('install.jvmPlaceholder'), onInput: (v) => (state.jvmArgs = v) });
  const javaInput = input({ value: state.javaPath, placeholder: t('install.javaAuto'), onInput: (v) => (state.javaPath = v) });
  const javaBrowse = button(t('common.browse'), { onClick: async () => {
    const p = await api('app:pickFile', { title: 'java.exe', filters: [{ name: 'Java', extensions: ['exe'] }] });
    if (p) {
      javaInput.value = p;
      state.javaPath = p;
    }
  } });
  const advanced = h(
    'div.collapsible',
    { class: state.ramMb || state.jvmArgs || state.javaPath ? 'open' : '' },
    h('div.collapsible-head', icon('right'), t('install.advanced')),
    h(
      'div.collapsible-body',
      field(t('install.ram'), ramSlider, t('install.ramDefault', { v: formatMb(cfg.ramMb || 2048) })),
      field(t('install.jvm'), jvmInput),
      field(t('install.java'), h('div.row', h('div.grow', javaInput), javaBrowse)),
    ),
  );
  advanced.firstChild.addEventListener('click', () => advanced.classList.toggle('open'));

  // ---- layout ----------------------------------------------------------------------------------
  const side = h(
    'div.form-side',
    iconPick,
    field(t('install.name'), nameInput),
    editing
      ? field(t('install.version'), h('div.input', { style: { display: 'flex', alignItems: 'center', color: 'var(--dim)' } }, `${editing.mcVersion}${editing.loader !== 'vanilla' ? ` · ${LOADER_NAME[editing.loader]} ${editing.loaderVersion}` : ''}`))
      : field(t('install.loader'), loaderSeg),
    editing ? null : loaderVerField,
    advanced,
  );

  const versionBox = editing
    ? null
    : h(
        'div.version-box',
        h('div.label', t('install.version')),
        versionSearch,
        h('div.version-filters', chip('release', t('install.releases')), chip('snapshot', t('install.snapshots')), chip('old', t('install.old'))),
        versionList,
      );

  const submit = button(editing ? t('common.save') : t('common.create'), { variant: 'primary', icon: editing ? 'check' : 'plus', onClick: save });
  root.append(
    h('div.page-head', button(t('nav.back'), { icon: 'back', variant: 'ghost', onClick: () => go('home') }), h('div.page-title', editing ? t('install.editTitle') : t('install.newTitle')), h('div.grow')),
    h('div.page-body', h('div.form-wrap', { style: editing ? { gridTemplateColumns: '1fr', maxWidth: '520px' } : null }, side, versionBox)),
    h('div.form-actions', button(t('common.cancel'), { onClick: () => go('home') }), submit),
  );

  async function save() {
    const name = nameInput.value.trim();
    if (!name) {
      toast(t('install.needName'), { kind: 'warn' });
      nameInput.focus();
      return;
    }
    try {
      if (editing) {
        await api('installs:update', editing.id, { name, iconId: state.iconId, ramMb: state.ramMb, jvmArgs: state.jvmArgs, javaPath: state.javaPath });
      } else {
        if (!state.mcVersion) {
          toast(t('install.needVersion'), { kind: 'warn' });
          return;
        }
        if (state.loader !== 'vanilla' && !state.loaderVersion) {
          toast(t('install.needLoader'), { kind: 'warn' });
          return;
        }
        await api('installs:create', {
          name,
          iconId: state.iconId,
          mcVersion: state.mcVersion,
          loader: state.loader,
          loaderVersion: state.loaderVersion,
          ramMb: state.ramMb,
          jvmArgs: state.jvmArgs,
          javaPath: state.javaPath,
        });
      }
      store.set({ installs: await api('installs:list'), config: await api('config:get') });
      go('home');
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && save());
  if (!editing) {
    loaderVerField.style.display = 'none';
    loadVersions();
  }
  setTimeout(() => nameInput.focus(), 50);
  return () => life.dispose();
}
