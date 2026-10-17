// Settings — every change saves immediately.
import { h, swap, bag, debounce } from '../dom.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { api, store, formatMb, PALETTE, DEFAULT_ACCENT, applyAccent } from '../core.js';
import { button, input, segmented, toggleRow, field, slider, toast, spinner } from '../ui.js';
import { voiceSettingsView, overlaySettingsView } from '../voice-settings.js';
import { openColorPicker, closeColorPicker } from '../color-picker.js';

export function mount(root, params, { go }) {
  const life = bag();
  const cfg = () => store.get('config') || {};
  const save = async (patch) => {
    try {
      store.set({ config: await api('config:set', patch) });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  };
  const saveLater = debounce(save, 350);

  const sections = [];
  const section = (id, ic, title, ...content) => {
    const el = h('div.card', { id: `set-${id}` }, h('div.section-title', icon(ic), title), ...content);
    sections.push({ id, ic, title, el });
    return el;
  };

  // ---- game ----------------------------------------------------------------------
  const c = cfg();
  const ru = c.language !== 'en';
  // voice: the same tabs as the lobby's dialog, right on the page
  const voiceView = voiceSettingsView();
  life.add(() => voiceView.dispose());
  section('voice', 'mic', t('voice.settings'), voiceView.el);
  // the overlay over the game, its news, videos and the instant replay
  const overlayView = overlaySettingsView();
  life.add(() => overlayView.dispose());
  section('overlay', 'image', ru ? 'Оверлей и запись' : 'Overlay and capture', overlayView.el);

  // the lobby's connection: which relays this network reaches, and why not
  const relay = input({ value: c.partyRelay || '', placeholder: ru ? 'Автоматически' : 'Automatic' });
  const probeBox = h('div.net-probe');
  const hintBox = h('div.net-hints');
  api('party:network').then((n) => {
    swap(hintBox,
      n.vpn ? h('div.net-hint.warn', icon('warning'), h('div', h('b', ru ? 'Включён VPN' : 'VPN is on'), h('div', ru ? 'Через VPN часто проходят не все ретрансляторы, а прямое подключение к миру и голос — не проходят. Добавьте «MC Launcher.exe» и «javaw.exe» в исключения VPN (раздельное туннелирование / «в обход»).' : 'A VPN often passes only some relays and blocks direct world and voice connections. Exclude "MC Launcher.exe" and "javaw.exe" from the VPN (split tunnelling).'))) : null,
      n.hotspot ? h('div.net-hint', icon('phone'), h('div', h('b', ru ? 'Интернет с телефона' : 'Phone hotspot'), h('div', ru ? 'У мобильного оператора к вам нельзя подключиться напрямую. Пусть хостом мира будет тот, у кого домашний интернет.' : 'Nobody can connect to you directly on mobile data. Let someone on home internet host the world.'))) : null);
  }).catch(() => {});
  async function runProbe(btn) {
    btn.disabled = true;
    swap(probeBox, h('div.hint', ru ? 'Проверяем ретрансляторы…' : 'Checking relays…'));
    try {
      const list = await api('party:probe');
      const ok = list.filter((r) => r.ok).length;
      swap(probeBox,
        list.map((r) => h(`div.net-relay${r.ok ? '.ok' : '.bad'}`, icon(r.ok ? 'check' : 'x'), h('span.grow', r.key), h('span.muted', r.ok ? `${r.ms} ${ru ? 'мс' : 'ms'}` : ru ? 'нет связи' : 'no answer'))),
        h('div.hint', !ok ? (ru ? 'Ни один ретранслятор не отвечает — лобби не заработает. Проверьте интернет или VPN.' : 'No relay answers — lobbies won’t work. Check the internet or VPN.')
          : ru ? `Доступно ${ok} из ${list.length}. Лобби соединяет тех, у кого есть хотя бы один общий ретранслятор, или через лидера, который видит оба.` : `${ok} of ${list.length} reachable. Players meet through a relay both reach, or through a leader that reaches both.`));
    } catch (e) {
      swap(probeBox, h('div.hint', e.message));
    }
    btn.disabled = false;
  }
  const probeBtn = button(ru ? 'Проверить' : 'Check', { icon: 'signal', cls: 'btn-sm', onClick: () => runProbe(probeBtn) });
  section('network', 'globe', ru ? 'Соединение с лобби' : 'Lobby connection',
    hintBox,
    h('div.row.net-probe-head', h('div.grow', h('div.toggle-title', ru ? 'Ретрансляторы лобби' : 'Lobby relays'), h('div.hint', ru ? 'Через них лаунчеры находят друг друга. Сама игра идёт напрямую между компьютерами.' : 'Launchers find each other through them. The game itself goes directly between computers.')), probeBtn),
    probeBox,
    field(ru ? 'Свой ретранслятор (необязательно)' : 'Custom relay (optional)', relay,
      ru ? 'Оставьте пустым для автоматического выбора. Для своего сервера укажите одинаковый адрес у всех игроков. Изменение применяется после повторного входа в лобби.' : 'Leave empty for automatic selection. Use the same custom address on every launcher. Rejoin the lobby to apply.'),
    button(t('common.save'), { onClick: () => save({ partyRelay: relay.value.trim() }) }));
  const dirInput = input({ value: c.gameDir, onInput: (v) => saveLater({ gameDir: v.trim() || c.defaultGameDir }) });
  const dirBrowse = button(t('common.browse'), { onClick: async () => {
    const p = await api('app:pickFolder', { defaultPath: dirInput.value });
    if (p) {
      dirInput.value = p;
      save({ gameDir: p });
    }
  } });
  const memHint = h('div.hint');
  const memSlider = slider({
    min: 1024,
    max: 16384,
    step: 512,
    value: c.ramMb,
    format: formatMb,
    onChange: (v) => save({ ramMb: v }),
  });
  api('app:system').then((s) => {
    const total = Math.round(s.totalMemMB || 8192);
    const max = Math.max(2048, Math.floor((total - 1536) / 512) * 512);
    const rec = total >= 12000 ? 4096 : total >= 7500 ? 3072 : 2048;
    memSlider.range.max = String(max);
    memSlider.range.dispatchEvent(new Event('input'));
    memHint.textContent = t('settings.memoryHint', { total: formatMb(total), rec: formatMb(rec) });
    const marks = h('div.slider-marks', h('span.mark.rec', { style: { left: `${((rec - 1024) / (max - 1024)) * 100}%` } }, '▲'));
    memSlider.appendChild(marks);
  }).catch(() => {});

  const wInput = input({ type: 'number', value: c.windowWidth, min: 320, max: 7680, onInput: (v) => saveLater({ windowWidth: Number(v) || 854 }) });
  const hInput = input({ type: 'number', value: c.windowHeight, min: 240, max: 4320, onInput: (v) => saveLater({ windowHeight: Number(v) || 480 }) });
  const jvm = h('textarea.input', { spellcheck: false }, c.jvmArgs || '');
  jvm.addEventListener('input', () => saveLater({ jvmArgs: jvm.value }));
  const jvmReset = button(t('common.reset'), { cls: 'btn-sm', onClick: () => {
    jvm.value = cfg().defaultJvmArgs;
    save({ jvmArgs: jvm.value });
  } });

  const game = section(
    'game', 'play', t('settings.game'),
    field(t('settings.gameDir'), h('div.row', h('div.grow', dirInput), dirBrowse), t('settings.gameDirHint')),
    field(t('settings.memory'), h('div', memSlider, memHint)),
    field(t('settings.resolution'), h('div.res-row', wInput, h('span.x', '×'), hInput)),
    toggleRow(t('settings.fullscreen'), null, c.fullscreen, (v) => save({ fullscreen: v })),
    toggleRow(t('settings.gameSkins'), t('settings.gameSkinsHint'), c.gameSkins !== false, (v) => save({ gameSkins: v })),
    field(t('settings.priority'), segmented(
      [
        { value: 'normal', label: t('settings.priority.normal') },
        { value: 'above', label: t('settings.priority.above') },
        { value: 'high', label: t('settings.priority.high') },
      ],
      c.gamePriority || 'normal',
      (v) => save({ gamePriority: v }),
    )),
    field(h('div.row', h('span.grow', t('settings.jvm')), jvmReset), jvm, t('settings.jvmHint')),
  );
  void game;

  // ---- java ---------------------------------------------------------------------------
  const javaPath = input({ value: c.javaPath, placeholder: 'C:\\Program Files\\Java\\…\\bin\\javaw.exe', onInput: (v) => saveLater({ javaPath: v.trim() }) });
  const javaBrowse = button(t('common.browse'), { onClick: async () => {
    const p = await api('app:pickFile', { title: 'java.exe', filters: [{ name: 'Java', extensions: ['exe'] }] });
    if (p) {
      javaPath.value = p;
      save({ javaPath: p, javaMode: 'custom' });
      renderJava();
    }
  } });
  const javaFound = h('div.java-list', spinner());
  const customBox = h('div', field(t('settings.javaCustom'), h('div.row', h('div.grow', javaPath), javaBrowse)), h('div.label', t('settings.javaFound')), javaFound);
  const autoHint = h('div.hint', t('settings.javaAutoHint'));
  const modeSeg = segmented([{ value: 'auto', label: t('settings.javaAuto') }, { value: 'custom', label: t('settings.javaCustom') }], c.javaMode || 'auto', (v) => {
    save({ javaMode: v });
    renderJava(v);
  });
  function renderJava(mode = cfg().javaMode) {
    customBox.style.display = mode === 'custom' ? '' : 'none';
    autoHint.style.display = mode === 'custom' ? 'none' : '';
  }
  let javas = null;
  async function loadJavas() {
    try {
      javas = await api('java:detect');
    } catch {
      javas = [];
    }
    if (!javas.length) {
      swap(javaFound, h('div.hint', t('settings.javaNone')));
      return;
    }
    swap(
      javaFound,
      javas.map((j) => {
        const row = h('div.java-item', { class: cfg().javaPath && cfg().javaPath.toLowerCase() === j.exe.toLowerCase() ? 'active' : '' }, h('span.jv', `Java ${j.major || '?'}`), h('span.jp', j.exe), h('span.muted', j.vendor || ''));
        row.addEventListener('click', () => {
          javaPath.value = j.exe;
          save({ javaPath: j.exe, javaMode: 'custom' });
          for (const r of javaFound.querySelectorAll('.java-item')) r.classList.remove('active');
          row.classList.add('active');
        });
        return row;
      }),
    );
  }
  section('java', 'java', t('settings.java'), field(t('settings.javaMode'), modeSeg), autoHint, customBox);
  renderJava();
  loadJavas();

  // ---- launcher --------------------------------------------------------------------------
  // Friends' notifications only make sense while notifications are on.
  const friendsRow = toggleRow(t('settings.notifyFriends'), null, c.notifyFriends, (v) => save({ notifyFriends: v }), { disabled: c.notifications === false });
  const messagesRow = toggleRow(t('settings.notifyMessages'), null, c.notifyMessages !== false, (v) => save({ notifyMessages: v }), { disabled: c.notifications === false });
  const notifyRow = toggleRow(t('settings.notifications'), t('settings.notificationsHint'), c.notifications !== false, (v) => {
    friendsRow.toggle.disabled = !v;
    messagesRow.toggle.disabled = !v;
    save({ notifications: v });
  });
  // Discord: the whole activity; within it the server's address and joining
  const discordServerRow = toggleRow(t('settings.discordServer'), null, c.discordServer !== false, (v) => save({ discordServer: v }), { disabled: c.discord === false });
  const discordJoinRow = toggleRow(t('settings.discordJoin'), t('settings.discordJoinHint'), c.discordJoin !== false, (v) => save({ discordJoin: v }), { disabled: c.discord === false });
  const discordRow = toggleRow(t('settings.discord'), t('settings.discordHint'), c.discord !== false, (v) => {
    discordServerRow.toggle.disabled = !v;
    discordJoinRow.toggle.disabled = !v;
    save({ discord: v });
  });
  api('app:info').then((info) => {
    if (info.discord) return;
    const hint = discordRow.querySelector('.hint');
    if (hint) hint.textContent = t('settings.discordNoId');
  }).catch(() => {});
  life.add(store.on('config', (cfg) => {
    notifyRow.toggle.setValue(cfg.notifications !== false);
    friendsRow.toggle.setValue(!!cfg.notifyFriends);
    friendsRow.toggle.disabled = cfg.notifications === false;
    messagesRow.toggle.setValue(cfg.notifyMessages !== false);
    messagesRow.toggle.disabled = cfg.notifications === false;
    discordRow.toggle.setValue(cfg.discord !== false);
    discordServerRow.toggle.setValue(cfg.discordServer !== false);
    discordServerRow.toggle.disabled = cfg.discord === false;
    discordJoinRow.toggle.setValue(cfg.discordJoin !== false);
    discordJoinRow.toggle.disabled = cfg.discord === false;
  }));
  section(
    'launcher', 'gear', t('settings.launcher'),
    toggleRow(t('settings.closeToTray'), t('settings.closeToTrayHint'), c.closeToTray, (v) => save({ closeToTray: v })),
    toggleRow(t('settings.hideOnLaunch'), t('settings.hideOnLaunchHint'), c.hideOnLaunch, (v) => save({ hideOnLaunch: v })),
    toggleRow(t('settings.showConsole'), t('settings.showConsoleHint'), c.showConsole, (v) => save({ showConsole: v })),
    toggleRow(t('settings.autostart'), t('settings.autostartHint'), c.autostart, (v) => save({ autostart: v })),
    notifyRow,
    friendsRow,
    messagesRow,
    discordRow,
    discordServerRow,
    discordJoinRow,
    h('div', { style: { padding: '12px 0 16px', borderTop: '1px solid var(--line)' } },
      field(t('settings.language'), segmented([{ value: 'ru', label: 'Русский' }, { value: 'en', label: 'English' }], c.language, (v) => save({ language: v })))),
  );

  // ---- appearance ---------------------------------------------------------------------------
  // One row: the presets, then a custom colour picked from a palette.
  const swatches = h('div.swatches');
  let pickerOpen = false;
  function renderSwatches() {
    const current = (cfg().accentColor || DEFAULT_ACCENT).toLowerCase();
    const isPreset = PALETTE.some((p) => p.hex.toLowerCase() === current);
    const items = PALETTE.map((p) => {
      const sw = h('button.swatch', { type: 'button', 'data-tip': p.name, class: p.hex.toLowerCase() === current ? 'active' : '', style: { background: p.hex } });
      sw.addEventListener('click', () => {
        applyAccent(p.hex);
        save({ accentColor: p.hex === DEFAULT_ACCENT ? '' : p.hex });
        setTimeout(renderSwatches, 0);
      });
      return sw;
    });
    const custom = h('button.swatch.custom', { type: 'button', 'data-tip': t('settings.accentCustom'), class: isPreset ? '' : 'active set', style: isPreset ? null : { '--sw': current } }, icon(isPreset ? 'plus' : 'edit'));
    custom.addEventListener('click', () => {
      if (pickerOpen) {
        closeColorPicker();
        return;
      }
      pickerOpen = true;
      openColorPicker(custom, current, {
        onInput: (hex) => {
          applyAccent(hex);
          custom.classList.add('set');
          custom.style.setProperty('--sw', hex);
        },
        onClose: (hex) => {
          pickerOpen = false;
          if (hex.toLowerCase() === current) {
            applyAccent(current);
            renderSwatches();
            return;
          }
          save({ accentColor: hex }).then(renderSwatches);
        },
      });
    });
    swap(swatches, items, custom);
  }
  renderSwatches();
  life.add(() => closeColorPicker());

  const particleGrid = h('div.choice-grid');
  function renderParticles() {
    const current = cfg().lobbyParticles || 'auto';
    swap(
      particleGrid,
      ['auto', 'bubbles', 'embers', 'fireflies', 'stars', 'snow', 'hearts', 'petals', 'leaves', 'halloween', 'confetti', 'none'].map((id) => {
        const el = h('div.choice', { class: id === current ? 'active' : '' }, t(`particles.${id}`));
        el.addEventListener('click', () => save({ lobbyParticles: id }).then(renderParticles));
        return el;
      }),
    );
  }
  renderParticles();

  section(
    'look', 'sparkle', t('settings.appearance'),
    field(t('settings.accent'), swatches),
    toggleRow(t('settings.sheen'), t('settings.sheenHint'), c.sheen !== false, (v) => save({ sheen: v })),
    toggleRow(t('settings.reduceMotion'), null, !!c.reduceMotion, (v) => save({ reduceMotion: v })),
    h('div', { style: { paddingTop: '12px', borderTop: '2px solid var(--line)' } },
      field(t('settings.lobbyParticles'), particleGrid, t('settings.lobbyHint'))),
    h('div.about-row', button(t('settings.resetLook'), { icon: 'refresh', cls: 'btn-sm', onClick: async () => {
      applyAccent(DEFAULT_ACCENT);
      await save({ accentColor: '', sheen: true, reduceMotion: false });
      go('settings', { t: Date.now() });
    } })),
  );

  // ---- activation codes -------------------------------------------------------------------
  const codeInput = input({ placeholder: 'MCL-XXXX-XXXX-XXXX', maxLength: 24 });
  codeInput.classList.add('code-input');
  const codeResult = h('div.code-result');
  const codeErrors = {
    format: ru ? 'Код выглядит так: MCL-XXXX-XXXX-XXXX.' : 'A code looks like MCL-XXXX-XXXX-XXXX.',
    unknown: ru ? 'Такого кода нет. Проверьте, что он введён без ошибок.' : 'No such code. Check it was typed correctly.',
    used: ru ? 'Этот код уже активирован.' : 'This code has already been used.',
    device: ru ? 'Этот набор уже активирован в вашем лаунчере. Код не потрачен — можно отдать его другу.' : 'This set is already activated in your launcher. The code is not spent — give it to a friend.',
    limit: ru ? 'Слишком много неверных кодов. Попробуйте через 10 минут.' : 'Too many wrong codes. Try again in 10 minutes.',
    update: ru ? 'Этот код для новой версии лаунчера. Обновите лаунчер — код не потрачен.' : 'This code needs a newer launcher. Update it — the code is not spent.',
    offline: ru ? 'Нет связи с сервером активации. Проверьте интернет и попробуйте ещё раз.' : 'Can’t reach the activation server. Check the internet and try again.',
  };
  async function redeemCode() {
    const code = codeInput.value.trim();
    if (!code) return codeInput.focus();
    codeBtn.disabled = true;
    swap(codeResult, h('div.hint', ru ? 'Проверяем код…' : 'Checking the code…'));
    try {
      const r = await api('cosmetics:redeem', code);
      if (r.ok) {
        const title = r.title ? (ru ? r.title.ru : r.title.en) : ru ? 'Награда' : 'Reward';
        const names = r.items.map((it) => (ru ? it.name : it.nameEn)).join(', ');
        // coins: on the balance (the shop), nothing to put on
        if (r.added) swap(codeResult, h('div.code-ok', icon('check'), h('div', h('b', `${ru ? 'Активировано' : 'Activated'}: +${r.added} ${ru ? 'монет' : 'coins'}`), h('div.hint', ru ? 'Монеты уже на счёте — их видно в «Магазине».' : 'The coins are on your balance — see the Shop.'))),
          button(ru ? 'Открыть «Магазин»' : 'Open the Shop', { icon: 'shop', cls: 'btn-sm', onClick: () => go('shop') }));
        else swap(codeResult, h('div.code-ok', icon('check'), h('div', h('b', `${ru ? 'Активировано' : 'Activated'}: ${title}`), names ? h('div.hint', names) : null)),
          button(ru ? 'Открыть в «Скинах»' : 'Open in Skins', { icon: 'hanger', cls: 'btn-sm', onClick: () => go('skins') }));
        codeInput.value = '';
        toast(`${ru ? 'Активировано' : 'Activated'}: ${title}`, { kind: 'ok' });
      } else {
        swap(codeResult, h('div.code-bad', icon('warning'), h('div', codeErrors[r.error] || codeErrors.unknown)));
      }
    } catch (e) {
      swap(codeResult, h('div.code-bad', icon('warning'), h('div', e.message)));
    }
    codeBtn.disabled = false;
  }
  const codeBtn = button(ru ? 'Активировать' : 'Activate', { icon: 'key', onClick: redeemCode });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') redeemCode(); });
  // a code from the site's link: filled in and in view, activated by the player's own click
  if (params && params.redeem && /^[A-Z0-9-]{4,32}$/.test(params.redeem)) {
    codeInput.value = params.redeem;
    setTimeout(() => { codeInput.scrollIntoView({ block: 'center', behavior: 'smooth' }); codeBtn.focus(); }, 300);
    swap(codeResult, h('div.hint', ru ? 'Код с сайта. Нажмите «Активировать».' : 'A code from the site. Press “Activate”.'));
  }
  section('codes', 'key', ru ? 'Код активации' : 'Activation code',
    h('div.hint', { style: { marginBottom: '10px' } }, ru ? 'Код даёт косметику или другие награды. Каждый код срабатывает только один раз.' : 'A code gives cosmetics or other rewards. Each code works only once.'),
    h('div.row.code-row', codeInput, codeBtn),
    codeResult);

  // ---- account ------------------------------------------------------------------------------
  section(
    'account', 'microsoft', t('settings.account'),
    toggleRow(t('settings.inAppLogin'), t('settings.inAppLoginHint'), c.inAppLogin, (v) => save({ inAppLogin: v })),
    h('div', { style: { padding: '8px 0 16px', borderTop: '1px solid var(--line)' } },
      h('div.row', h('div.grow', h('div.toggle-title', t('settings.forget')), h('div.hint', t('settings.forgetHint'))),
        button(t('settings.forget'), { cls: 'btn-sm', onClick: async () => {
          await api('accounts:forgetBrowser');
          toast(t('settings.forgot'), { kind: 'ok' });
        } }))),
  );

  // ---- about ----------------------------------------------------------------------------------
  const sysGrid = h('div.sys-grid', spinner());
  const info = store.get('info') || {};
  const sysItem = (ic, k, v) => h('div.sys-item', icon(ic), h('div', h('div.k', k), h('div.v', { 'data-tip': v }, v)));
  api('app:system').then((s) => {
    const gpus = (s.gpus || []).map((g) => `${g.name}${g.vramMB ? ` (${formatMb(g.vramMB)})` : ''}`).join(', ') || '—';
    swap(
      sysGrid,
      sysItem('cpu', 'CPU', `${s.cpuName || '—'}${s.cpuCores ? ` · ${s.cpuCores}C/${s.cpuThreads}T` : ''}`),
      sysItem('image', 'GPU', gpus),
      sysItem('ram', t('settings.memory'), `${formatMb(s.totalMemMB)} · ${formatMb(s.freeMemMB)} free`),
      sysItem('pc', 'Windows', s.osVersion || '—'),
    );
  }).catch(() => swap(sysGrid, '—'));
  const native = info.native || {};
  section(
    'about', 'info', t('settings.about'),
    h('div.row', { style: { marginBottom: '14px', gap: '14px' } }, h('img', { src: 'mcl://app/assets/icon/app.png', style: { width: '56px', height: '56px' }, alt: '' }),
      h('div', h('div.me-name', `MC Launcher ${info.version || ''}`), h('div.hint', `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}`),
        h('div.hint', `${t('settings.native')}: `, h('span', { style: { color: native.loaded ? 'var(--good)' : 'var(--away)' } }, native.loaded ? t('settings.nativeOk', { v: `mcnative ${native.version}, ${native.compiler || ''}` }) : t('settings.nativeOff'))))),
    sysGrid,
    h('div.about-row',
      button(t('settings.openData'), { icon: 'folder', cls: 'btn-sm', onClick: () => api('app:openFolder', 'app') }),
      button(t('settings.openGame'), { icon: 'folder', cls: 'btn-sm', onClick: () => api('app:openFolder', 'game') }),
      button(t('settings.openLogs'), { icon: 'console', cls: 'btn-sm', onClick: () => api('app:openFolder', 'logs') })),
    h('div.hint', { style: { marginBottom: '14px' } }, t('settings.disclaimer')),
  );

  // ---- layout + nav ---------------------------------------------------------------------------
  const col = h('div.settings-col', sections.map((s) => s.el));
  const nav = h(
    'div.settings-nav',
    sections.map((s) => {
      const b = h('button', { type: 'button', dataset: { id: s.id } }, icon(s.ic), s.title);
      b.addEventListener('click', () => s.el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return b;
    }),
  );
  const body = h('div.page-body', h('div.settings-wrap', nav, col));
  root.append(h('div.page-head', button(t('nav.back'), { icon: 'back', variant: 'ghost', onClick: () => go('home') }), h('div.page-title', t('settings.title')), h('div.grow')), body);

  const markActive = () => {
    const top = body.getBoundingClientRect().top + 40;
    let current = sections[0].id;
    for (const s of sections) if (s.el.getBoundingClientRect().top <= top) current = s.id;
    for (const b of nav.children) b.classList.toggle('active', b.dataset.id === current);
  };
  body.addEventListener('scroll', markActive);
  markActive();

  return () => life.dispose();
}
