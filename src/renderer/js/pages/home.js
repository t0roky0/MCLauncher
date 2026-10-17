// Home: the lobby (your skin on an accent-coloured stage with pixel
// particles) and, along its bottom edge, the launch bar — the installation
// picker, the big launch button, recent worlds and the folder.
import { h, swap, bag, debounce } from '../dom.js';
import { t } from '../i18n.js';
import { icon, blockUrl } from '../icons.js';
import { api, onEvent, store, timeAgo, dayAgo, formatBytes, formatDuration, formatMb, stageText, remote } from '../core.js';
import { button, iconButton, showMenu, confirmDialog, toast, spinner, setButtonLabel } from '../ui.js';
import { renderMotd } from '../motd.js';
import { serverIcon } from '../server-icons.js';
import { LobbyStage, PartyFigure, setLobbyFps, EMOTE_IDS, posePreview, STEVE } from '../skin3d.js';
import { currentAppearance, appearanceKey } from '../appearance.js';
import { openPartyDialog, planFor, planWorld, partyMe, kickMember } from '../party-ui.js';
import { partyPanel } from '../party-panel.js';
import * as voice from '../voice.js';
import { memberVoice, paintVoice } from '../voice-indicator.js';
import { eventPromo, shopPromo } from '../cosmetics-panel.js';
import { questsPromo } from '../quests-ui.js';
import { Particles, THEMES, autoTheme } from '../particles.js';

// world mode → badge sprite (icons.js)
const MODE_SPRITE = { survival: 'survival', hardcore: 'hardcore', creative: 'creative', adventure: 'survival', spectator: 'creative' };
const LOADER_NAME = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', vanilla: 'Vanilla' };
const CROWN = '<svg viewBox="0 0 9 7" width="18" height="14" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="M0 0h1v1h1v1h1V1h1V0h1v1h1v1h1V1h1V0h1v5H0zm0 6h9v1H0z"/></svg>';

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function mount(root, params, { go }) {
  root.classList.add('home');
  const life = bag();
  const cfg0 = store.get('config') || {};

  // ---- lobby ---------------------------------------------------------------------
  const pcanvas = h('canvas.lobby-particles');
  const skinCanvas = h('canvas.lobby-skin');
  // where the figure is turned and clicked: the canvas draws round it, wider
  // (wings, a pet by the shoulder, turning with it), and lets the mouse through
  const skinHit = h('div.lobby-hit');
  const nameTag = h('div.lobby-name');
  const slots = h('div.lobby-slots');
  const frame = h('div.hero-frame', h('div.lobby-bg'), h('div.lobby-rays'), pcanvas, h('div.lobby-pedestal'), skinCanvas, skinHit, nameTag, slots);
  const heroInfo = h('div.hero-info');
  const picker = h('div.pose-picker');

  // Party slots either side of the player: empty ones invite (the party
  // dialog), taken ones show who's in — in 3D, in their own skin, playing
  // the emotes they play.
  const slotEls = [0, 1, 2, 3].map(() => h('button.lobby-slot', { type: 'button', onclick: () => openPartyDialog(), oncontextmenu: (e) => slotMenu(e, e.currentTarget.dataset.member) }));
  slots.append(...slotEls);
  const figures = new Map(); // member id → { figure, canvas, slot }
  // near pair beside you, a smaller far pair further out (see the CSS)
  // (taller by as much as your own figure, see layoutLobby)
  let grow = 1;
  const figureSize = (i) => {
    const H = frame.clientHeight || 600;
    const height = Math.round(H * (i < 2 ? 0.68 : 0.52) * grow);
    return { width: Math.round(height * 0.72), height };
  };
  function dropFigure(id) {
    const f = figures.get(id);
    if (!f) return;
    f.figure.dispose();
    figures.delete(id);
  }
  life.add(() => [...figures.keys()].forEach(dropFigure));
  life.add(onEvent('party:emote', ({ from, id }) => {
    const f = figures.get(from);
    if (f) f.figure.playEmote(id);
  }));
  // the leader right-clicks a friend's figure (or name) to show them out
  function slotMenu(ev, id) {
    const p = store.get('party') || {};
    const m = (p.members || []).find((x) => x.id === id);
    if (!p.leader || !m || m.self) return;
    ev.preventDefault();
    ev.stopPropagation();
    showMenu(null, [{ label: t('party.kick'), icon: 'userMinus', danger: true, onClick: () => kickMember(m) }], { x: ev.clientX, y: ev.clientY });
  }
  function renderSlots() {
    const p = store.get('party') || {};
    const others = p.active ? p.members.filter((m) => !m.self) : [];
    slotEls.forEach((el, i) => {
      const m = others[i];
      // The back row only with someone standing there: an empty far "Invite"
      // isn't shown (the shop's ad is in that corner; invite from the lobby's window).
      // Update visibility even when the cached contents are still "empty".
      el.hidden = i >= 2 && !m;
      const key = m ? `${m.id}|${m.name}|${m.leader}|${m.model}|${(m.skin || '').length}|${(m.cape || '').length}` : 'empty';
      if (el.dataset.key === key) return;
      el.dataset.key = key;
      el.dataset.member = m?.id || "";
      el.classList.toggle('filled', !!m);
      if (!m) {
        el.setAttribute('aria-label', t('lobby.invite'));
        swap(el, icon('plus'), h('span', t('lobby.inviteShort')));
        return;
      }
      el.setAttribute('aria-label', m.name);
      // the same member in the same place keeps their figure (and emote)
      let f = figures.get(m.id);
      if (f && f.slot !== i) {
        dropFigure(m.id);
        f = null;
      }
      if (!f) {
        const { width, height } = figureSize(i);
        const canvas = h('canvas.slot-skin');
        // a click opens the party; a drag only spins them (the slot button
        // under it mustn't take that click too)
        canvas.addEventListener('click', (e) => e.stopPropagation());
        canvas.addEventListener('contextmenu', (e) => slotMenu(e, m.id));
        const figure = new PartyFigure(canvas, { width, height, onClick: () => openPartyDialog() });
        figure.setPaused(!!(store.get('config') || {}).reduceMotion);
        figure.onPlaced = () => placeNames();
        f = { figure, canvas, slot: i };
        figures.set(m.id, f);
      }
      f.figure.setSkin(m.skin || STEVE, m.model).catch(() => f.figure.setSkin(STEVE, 'classic'));
      // their cape too (an Xbox friend's Bedrock one comes with the card)
      f.figure.setCape(m.cape || '').catch(() => {});
      // and what they wear from the launcher's cosmetics
      f.figure.setCosmetics(m.cos || []).catch(() => {});
      swap(el, h('span.slot-name', m.leader ? h('span.leader-crown', { html: CROWN }) : null, h('span', m.name), h('span.voice-indicator')), f.canvas);
    });
    placeNames();
    // members who left take their figures with them
    const present = new Set(others.slice(0, 4).map((m) => m.id));
    for (const id of [...figures.keys()]) if (!present.has(id)) dropFigure(id);
    paintLobbyVoice();
  }

  function paintLobbyVoice() {
    const members = (store.get('party') || {}).members || [];
    const call = voice.voiceState();
    paintVoice(nameTag.querySelector('.voice-indicator'), memberVoice({self:true}, call));
    for (const el of slotEls) {
      const m = members.find(m => m.id === el.dataset.member);
      if (m) paintVoice(el.querySelector('.voice-indicator'), memberVoice(m, call));
    }
  }
  life.add(voice.onVoice(paintLobbyVoice));

  const stage = new LobbyStage(skinCanvas, { width: 260, height: 320, onClick: () => togglePicker(), hit: skinHit });
  life.add(() => stage.dispose());
  stage.setPose('idle');
  stage.onPlaced = () => placeNames();
  let stageHeight = 0;
  // Names just over each figure's top — its head, or the hat on it — not over
  // the empty room every canvas keeps up there for cosmetics.
  function placeNames() {
    const H = frame.clientHeight;
    if (H < 50 || !stageHeight) return;
    const top = H - 40 - stageHeight + stage.topGap();
    nameTag.style.top = `${Math.max(4, top - (nameTag.offsetHeight || 26) - 6)}px`;
    for (const f of figures.values()) {
      const name = slotEls[f.slot] && slotEls[f.slot].querySelector('.slot-name');
      if (name) name.style.marginBottom = `${-(f.figure.topGap() + 2)}px`;
    }
  }
  // the cosmetics we wear (Skins → Cosmetics)
  const wearOwn = (v) => stage.setCosmetics(Object.values((v && v.worn) || {}).filter(Boolean)).catch(() => {});
  api('cosmetics:state').then(wearOwn).catch(() => {});
  life.add(onEvent('cosmetics:changed', wearOwn));
  setTimeout(renderChatBtn, 0);

  const particles = new Particles(pcanvas);
  life.add(() => particles.dispose());
  const paletteFromAccent = () => ({ base: cssVar('--acc') || '#c88a5a', light: cssVar('--acc-hi') || '#f0c39a', dark: cssVar('--acc-deep') || '#6b4428' });
  particles.setPalette(paletteFromAccent());
  particles.setTheme(cfg0.lobbyParticles || 'auto');

  const poseBtn = button(t('lobby.pose'), { icon: 'emote', cls: 'lobby-tool', onClick: () => togglePicker() });
  const fxBtn = button(t('lobby.particles'), { icon: 'sparkle', cls: 'lobby-tool', onClick: (e, el) => particlesMenu(el) });
  const side = h('div.lobby-side', poseBtn, fxBtn);

  // In a party: the chat and voice dock, from a button on the right.
  const chatBadge = h('span.chat-badge', { hidden: true });
  const chatBtn = button(t('chat.open'), { icon: 'chat', cls: 'lobby-tool', onClick: () => toggleChat() });
  chatBtn.append(chatBadge);
  const sideRight = h('div.lobby-side.right', { hidden: true }, chatBtn);
  // the running event, small, under the corner's tags: a click opens it in Skins
  const promo = eventPromo(go);
  life.add(promo.dispose);
  // …and under it the shop's packs (an ad of our own)
  const shopAd = shopPromo(go);
  life.add(shopAd.dispose);
  // …and the week's quests (quests-ui.js)
  const quests = questsPromo();
  life.add(quests.dispose);
  // the event, the shop's ad under it, the week's quests at the bottom (the event gone: they move up)
  const rightTools = h('div.lobby-right-tools', heroInfo, sideRight, promo.el, shopAd.el, quests.el);
  let dock = null;
  function toggleChat(force) {
    const open = typeof force === 'boolean' ? force : !dock;
    if (open && !dock) {
      togglePicker(false);
      dock = partyPanel({ onClose: () => toggleChat(false) });
      dock.el.classList.add('party-dock');
      hero.appendChild(dock.el);
      store.set({ partyUnread: 0, partyPanelOpen: true });
    } else if (!open && dock) {
      dock.dispose();
      dock.el.remove();
      dock = null;
      store.set({ partyPanelOpen: false });
    }
    rightTools.hidden = !!dock;
    chatBtn.classList.toggle('active', !!dock);
    renderChatBtn();
  }
  function renderChatBtn() {
    const p = store.get('party') || {};
    sideRight.hidden = !p.active;
    if (!p.active && dock) toggleChat(false);
    const n = store.get('partyUnread') || 0;
    chatBadge.textContent = n > 9 ? '9+' : String(n);
    chatBadge.hidden = !n || !!dock;
  }
  life.add(store.on(['party', 'partyUnread'], renderChatBtn));
  life.add(() => toggleChat(false));

  function layoutLobby() {
    const H = frame.clientHeight;
    if (H < 50) return;
    frame.style.setProperty('--lobby-height', `${H}px`);
    // As tall as the stage allows: from the top edge to just above the
    // launch bar, the room over the head (for cosmetics) included. Friends'
    // figures grow by as much, so everyone keeps their height to each other.
    const ch = Math.max(110, H - 44);
    grow = ch / Math.max(110, H - 76);
    frame.style.setProperty('--lobby-grow', grow.toFixed(4));
    const cw = Math.round(ch * 0.72);
    stage.resize(Math.round(ch * 1.05), ch);
    skinHit.style.width = `${cw}px`;
    skinHit.style.height = `${ch}px`;
    stageHeight = ch;
    for (const f of figures.values()) {
      const { width, height } = figureSize(f.slot);
      f.figure.resize(width, height);
    }
    placeNames();
  }
  const ro = new ResizeObserver(layoutLobby);
  ro.observe(frame);
  life.add(() => ro.disconnect());

  let skinInfo = { url: STEVE, model: 'classic' };
  let skinToken = 0;
  life.add(() => { skinToken++; });
  const onSkinChanged = () => loadLobbySkin();
  window.addEventListener('mcl:skin-changed', onSkinChanged);
  life.add(() => window.removeEventListener('mcl:skin-changed', onSkinChanged));
  async function loadLobbySkin() {
    const cfg = store.get('config') || {};
    const acc = cfg.accounts && (cfg.accounts.find((a) => a.id === cfg.activeAccount) || cfg.accounts[0]);
    nameTag.dataset.name = acc ? acc.name : 'Player';
    renderNameTag();
    const token = ++skinToken;
    const next = await currentAppearance();
    if (token !== skinToken) return;
    skinInfo = next;
    try {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.src = next.url;
      await image.decode();
      if (token !== skinToken) return;
      await stage.setSkin(image, next.model);
      if (token !== skinToken) return;
      await stage.setCape(next.cape).catch(() => stage.setCape(''));
    } catch (error) {
      if (token !== skinToken) return;
      console.warn('Lobby skin could not be loaded:', error.message);
      await stage.setSkin(STEVE, 'classic');
    }
    if (picker.classList.contains('open')) renderPicker();
  }

  function renderNameTag() {
    const p = store.get('party') || {};
    const crown = !p.active || p.leader;
    swap(nameTag, crown ? h('span.leader-crown', { 'data-tip': t('lobby.leader'), html: CROWN }) : null, h('span', nameTag.dataset.name || 'Player'), p.active ? h('span.voice-indicator') : null);
    paintLobbyVoice();
  }

  function renderPicker() {
    const grid = h('div.pose-grid');
    for (const id of EMOTE_IDS) {
      const img = h('img.loading', { alt: '' });
      posePreview(skinInfo.url, skinInfo.model, id).then((d) => {
        img.src = d;
        img.classList.remove('loading');
      }).catch(() => {});
      const card = h('button.pose-card', { type: 'button', 'aria-label': t(`pose.${id}`) }, img, h('span', t(`pose.${id}`)));
      card.addEventListener('click', () => {
        stage.playEmote(id);
        togglePicker(false);
        // friends in the party see it on your figure in their lobby
        if ((store.get('party') || {}).active) api('party:emote', id).catch(() => {});
      });
      grid.appendChild(card);
    }
    swap(picker, h('div.pose-head', icon('emote'), t('lobby.poseTitle'), h('div', { style: { flex: '1' } }), iconButton('x', { cls: 'btn-sm', variant: 'ghost', onClick: () => togglePicker(false) })), grid);
  }

  function togglePicker(force) {
    const open = typeof force === 'boolean' ? force : !picker.classList.contains('open');
    if (open) {
      renderPicker();
      toggleFlyout(false);
      togglePanel(false);
      toggleChat(false);
    }
    picker.classList.toggle('open', open);
    poseBtn.classList.toggle('active', open);
  }

  function particlesMenu(anchor) {
    const current = (store.get('config') || {}).lobbyParticles || 'auto';
    showMenu(
      anchor,
      THEMES.map((id) => ({
        label: id === 'auto' ? t('lobby.autoNow', { name: t(`particles.${autoTheme()}`) }) : t(`particles.${id}`),
        checked: id === current,
        onClick: () => {
          particles.setTheme(id);
          const cfg = store.get('config');
          store.set({ config: { ...cfg, lobbyParticles: id } });
          api('config:set', { lobbyParticles: id }).catch(() => {});
        },
      })),
      { align: 'left' },
    );
  }

  // The lobby keeps moving while a game runs; it stops only while the window
  // is hidden or minimised. "Fewer animations" stills the figure and the
  // particles (the figure stays, drawn when it changes).
  let windowVisible = true;
  function syncActivity() {
    const cfg = store.get('config') || {};
    const busy = (store.get('running') || []).length > 0;
    const still = !!cfg.reduceMotion;
    stage.setPaused(still);
    for (const f of figures.values()) f.figure.setPaused(still);
    // 60 while anyone can see it (the monitor's every frame, 144 or 240,
    // kept a core busy); with a game running, 30 — the game keeps its frames
    setLobbyFps(!windowVisible ? 0 : busy ? 30 : 60);
    particles.fps = busy ? 30 : 60;
    if (still || !windowVisible) particles.stop();
    else particles.start();
  }
  life.add(onEvent('win:visible', (v) => {
    windowVisible = !!v;
    syncActivity();
  }));
  // a new skin: friends in the party get it too
  const shareSkin = async () => {
    if ((store.get('party') || {}).active) api('party:me', await partyMe()).catch(() => {});
  };
  window.addEventListener('mcl:skin-changed', shareSkin);
  life.add(() => window.removeEventListener('mcl:skin-changed', shareSkin));

  // ---- launch bar -------------------------------------------------------------------
  // [installation ▴] [  Launch  ] [Worlds ▴] [folder] — the picker on the
  // left works like a game-mode button: the selected installation, and a
  // click opens the list above it.
  const instImg = h('img', { alt: '' });
  const instName = h('div.is-name');
  const instSub = h('div.is-sub');
  const instBtn = button(null, { cls: 'inst-select', title: t('home.chooseInstall'), onClick: () => togglePanel() });
  instBtn.append(instImg, h('div.is-text', instName, instSub), icon('up', { cls: 'caret' }));
  const progress = h('div.launch-progress');
  const launchBtn = button(t('launch.play'), { variant: 'primary', cls: 'launch-btn', onClick: onLaunch });
  // while a download/launch runs: the fill behind, the loading arc in front
  launchBtn.prepend(progress, h('div.launch-spin', spinner('md')));
  const worldsBtn = button(t('launch.worldsShort'), { cls: 'launch-side worlds-btn', title: t('launch.worlds'), onClick: () => toggleFlyout() });
  // its icon is held by reference: the button's first child is the sheen strip
  let worldsIcon = icon('block');
  worldsBtn.prepend(worldsIcon);
  worldsBtn.appendChild(icon('up', { cls: 'caret' }));
  const folderBtn = button(null, { icon: 'folder', cls: 'launch-side folder-btn', title: t('launch.mods'), onClick: openFolder });
  const caption = h('div.launch-caption');
  const flyout = h('div.flyout');
  const panel = h('div.inst-panel');
  const launchbar = h('div.launchbar', instBtn, launchBtn, worldsBtn, folderBtn);
  const hero = h('div.hero', frame, side, rightTools, picker, launchbar, caption, flyout, panel);
  root.append(hero);
  // The corner's cards above the launch bar: when the event, the quests and the
  // shop's ad don't all fit, the ad goes (the shop has its own tab)
  function fitCorner() {
    const steps = [() => shopAd.el.classList.add('compact'), () => shopAd.el.classList.add('squeezed'), () => promo.el.classList.add('compact')];
    shopAd.el.classList.remove('compact', 'squeezed');
    promo.el.classList.remove('compact');
    if (rightTools.hidden || !launchbar.offsetHeight) return;
    const over = () => rightTools.getBoundingClientRect().bottom > launchbar.getBoundingClientRect().top - 10;
    for (const step of steps) {
      if (!over()) return;
      step();
    }
  }
  const cornerRo = new ResizeObserver(fitCorner);
  cornerRo.observe(rightTools);
  cornerRo.observe(hero);
  life.add(() => cornerRo.disconnect());

  function entries() {
    return store.get('installs') || [];
  }

  function selectedId() {
    const cfg = store.get('config') || {};
    const all = entries();
    if (all.some((e) => e.id === cfg.selectedInstall)) return cfg.selectedInstall;
    return all[0] ? all[0].id : '';
  }

  function selected() {
    return entries().find((e) => e.id === selectedId()) || null;
  }

  function select(id) {
    const cfg = store.get('config');
    if (cfg && cfg.selectedInstall === id) return;
    store.set({ config: { ...cfg, selectedInstall: id } });
    api('config:set', { selectedInstall: id }).catch(() => {});
  }

  function subtitle(e) {
    if (e.isBedrock) return e.mcVersion ? `Bedrock ${e.mcVersion}  ·  Microsoft Store` : 'Bedrock  ·  Microsoft Store';
    if (e.isDefault) return `${t('home.latest')}  ·  ${t('home.alwaysAvailable')}`;
    let s = e.mcVersion;
    if (e.loader !== 'vanilla') s += `  ·  ${LOADER_NAME[e.loader]} ${String(e.loaderVersion).split(' ')[0]}`;
    return s;
  }

  function shortSub(e) {
    if (e.isBedrock) return e.mcVersion ? `Bedrock · ${e.mcVersion}` : 'Bedrock · Microsoft Store';
    if (e.isDefault) return t('home.latest');
    return `${e.mcVersion}${e.loader !== 'vanilla' ? ` · ${LOADER_NAME[e.loader]}` : ''}`;
  }

  function runningFor(id) {
    return (store.get('running') || []).find((r) => r.installId === id);
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderLaunch() {
    const task = store.get('task') || {};
    const e = selected();
    const run = e ? runningFor(e.id) : null;

    if (e) {
      if (instImg.dataset.icon !== e.iconId) {
        instImg.dataset.icon = e.iconId;
        instImg.src = blockUrl(e.iconId);
      }
      instName.textContent = e.name;
      instSub.textContent = shortSub(e);
      instBtn.classList.toggle('latest', !!e.isDefault);
    } else {
      instImg.removeAttribute('src');
      instName.textContent = t('home.noInstalls');
      instSub.textContent = '';
    }

    launchBtn.classList.remove('busy', 'running');
    launchBtn.disabled = false;
    progress.style.width = '0';
    if (task.busy) {
      launchBtn.classList.add('busy');
      setButtonLabel(launchBtn, task.cancelling ? t('launch.cancelling') : task.phase === 'launching' ? t('launch.launching') : t('launch.cancel'));
      launchBtn.disabled = !!task.cancelling || task.phase === 'launching';
      const f = task.progress ? task.progress.fraction || 0 : 0;
      progress.style.width = `${Math.round(f * 1000) / 10}%`;
      const p = task.progress;
      const bits = [`<b>${esc(task.name)}</b>`, esc(stageText(task))];
      if (p && p.speed > 1024 && (p.bytesTotal > 0 || p.stage === 'assets' || p.stage === 'java')) bits.push(`${formatBytes(p.speed)}${t('unit.perSec')}`);
      if (p && p.bytesTotal > 0) bits.push(`${formatBytes(p.bytesDone)} / ${formatBytes(p.bytesTotal)}`);
      caption.innerHTML = bits.join('  ·  ');
    } else if (partyState().text) {
      const ps = partyState();
      setButtonLabel(launchBtn, ps.label);
      launchBtn.disabled = !!ps.disabled;
      progress.style.width = `${Math.round((ps.fraction || 0) * 1000) / 10}%`;
      caption.innerHTML = ps.text;
    } else if (run) {
      launchBtn.classList.add('running');
      setButtonLabel(launchBtn, t('launch.running'));
      const st = run.stats;
      caption.innerHTML = `<b>${esc(run.installName)}</b>  ·  ${t('home.inGame')}${st && st.memMB ? `  ·  ${t('status.mem', { mb: formatMb(st.memMB) })}` : ''}`;
    } else if (e) {
      setButtonLabel(launchBtn, e.installed ? t('launch.play') : t('launch.download'));
      const parts = [];
      if (!e.isDefault && e.loader !== 'vanilla') parts.push(esc(subtitle(e)));
      parts.push(e.lastPlayed ? t('home.lastPlayed', { when: timeAgo(e.lastPlayed) }) : e.installed ? t('home.never') : t('home.notInstalledLong'));
      if (e.playTimeMs > 60000) parts.push(t('home.playTime', { t: formatDuration(e.playTimeMs) }));
      caption.innerHTML = parts.join('  ·  ');
    } else {
      setButtonLabel(launchBtn, t('launch.play'));
      launchBtn.disabled = true;
      caption.textContent = '';
    }
    folderBtn.dataset.tip = e && e.isBedrock ? t('launch.bedrockFolder') : e && e.loader !== 'vanilla' ? t('launch.mods') : t('launch.folder');
    folderBtn.disabled = !e;
    worldsBtn.disabled = !e;
    // Bedrock worlds only open from inside the game; its servers we can do
    const bedrockSel = !!(e && e.isBedrock);
    if (worldsBtn.dataset.mode !== String(bedrockSel)) {
      worldsBtn.dataset.mode = String(bedrockSel);
      const next = icon(bedrockSel ? 'server' : 'block');
      worldsIcon.replaceWith(next);
      worldsIcon = next;
      setButtonLabel(worldsBtn, bedrockSel ? t('worlds.servers') : t('launch.worldsShort'));
      worldsBtn.dataset.tip = bedrockSel ? t('launch.bedrockServers') : t('launch.worlds');
    }

    const runs = store.get('running') || [];
    const p = store.get('party') || {};
    const partyTag = p.active
      ? h('button.hero-tag.party-tag', { type: 'button', 'data-tip': t('party.open'), onclick: () => openPartyDialog() }, icon('friends'), h('span', `${t('party.short')} ${p.code}`), h('span.party-count', String(p.members.length)), p.connected ? null : h('span.party-off', '…'))
      : null;
    swap(heroInfo, partyTag, runs.map((r) => h('div.hero-tag', h('span.live'), `${r.installName}${r.stats && r.stats.memMB ? ` · ${formatMb(r.stats.memMB)}` : ''}`)));
  }

  // A party game in the making: the ready check (whose game is on disk, who's
  // still downloading) and, for a member, waiting on the leader.
  function partyState() {
    const p = store.get('party') || {};
    if (!p.active || p.members.length < 2 || runningFor((selected() || {}).id)) return {};
    const names = Object.fromEntries(p.members.map((m) => [m.id, m.name]));
    if (p.prep) {
      const states = p.prep.states || {};
      const ready = p.members.filter((m) => states[m.id] && states[m.id].state === 'ready').length;
      const busy = p.members.filter((m) => states[m.id] && states[m.id].state === 'busy').map((m) => `${esc(names[m.id])} ${Math.round((states[m.id].progress || 0) * 100)}%`);
      const failed = p.members.filter((m) => states[m.id] && states[m.id].state === 'error').map((m) => esc(names[m.id]));
      const bits = [`<b>${t('party.readyCount', { n: ready, of: p.members.length })}</b>`];
      if (busy.length) bits.push(t('party.downloading', { who: busy.join(', ') }));
      if (failed.length) bits.push(`<span class="accent">${t('party.prepFailed', { who: failed.join(', ') })}</span>`);
      const all = p.members.map((m) => (states[m.id] && states[m.id].progress) || 0);
      return {
        text: bits.join('  ·  '),
        label: p.leader ? t('party.waitingFriends') : t('party.gettingReady'),
        fraction: all.reduce((a, b) => a + b, 0) / all.length,
        disabled: !p.leader,
      };
    }
    if (!p.leader) {
      const plan = p.destination?.plan || p.plan || {};
      const where = plan.mode === 'world' ? t('party.planWorld', { world: esc(plan.worldName || plan.world) }) : plan.server ? t('party.planServer', { server: esc(plan.server) }) : t('party.planNoServer');
      return { text: `${t('party.leaderStarts')}  ·  ${where}`, label: t('party.waitLeader'), disabled: true };
    }
    return {};
  }

  async function onLaunch() {
    const task = store.get('task') || {};
    if (task.busy) {
      api('installs:cancel');
      return;
    }
    const e = selected();
    if (!e || runningFor(e.id)) return;
    const p = store.get('party') || {};
    if (p.active && p.members.length > 1 && !p.leader) return; // the leader starts a party game
    if (p.active && p.leader && p.members.length > 1) {
      // a second press while friends get ready: call it off
      if (p.prep) {
        api('party:cancelPlay').catch(() => {});
        return;
      }
      // everyone gets the version ready first; the game starts for all when
      // they are — onto the server, into the leader's world, or just the version
      const server = ((p.plan && p.plan.server) || '').trim();
      try {
        await api('party:play', planFor(e, server, planWorld(p.plan)), e.id);
      } catch (err) {
        toast(err.message, { kind: 'error' });
      }
      return;
    }
    start(e.id, {});
  }

  async function start(id, opts) {
    try {
      await api('installs:start', id, opts);
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  function openFolder() {
    const e = selected();
    if (!e) return;
    api('app:openFolder', 'instance', e.id, e.loader !== 'vanilla' ? 'mods' : '').catch((err) => toast(err.message, { kind: 'error' }));
  }

  // ---- installations panel ---------------------------------------------------------
  let query = '';
  const searchInput = h('input.input.ip-search', { placeholder: t('home.search'), spellcheck: false });
  searchInput.addEventListener('input', debounce(() => {
    query = searchInput.value.trim().toLowerCase();
    renderPanel();
  }, 80));
  const panelList = h('div.ip-list');

  function togglePanel(force) {
    const open = typeof force === 'boolean' ? force : !panel.classList.contains('open');
    if (open === panel.classList.contains('open')) return;
    if (open) {
      togglePicker(false);
      toggleFlyout(false);
      // line the panel up with the picker button
      panel.style.left = `${instBtn.getBoundingClientRect().left - hero.getBoundingClientRect().left}px`;
      query = '';
      searchInput.value = '';
      renderPanel(true);
    }
    panel.classList.toggle('open', open);
    instBtn.classList.toggle('open', open);
  }

  function renderPanel(scrollToSelected) {
    const all = entries();
    const sel = selectedId();
    const task = store.get('task') || {};
    const shown = query ? all.filter((e) => e.name.toLowerCase().includes(query) || e.mcVersion.toLowerCase().includes(query)) : all;
    const movable = all.filter((e) => !e.isDefault);
    const rows = shown.map((e) => {
      const running = runningFor(e.id);
      const state = running
        ? h('span.ip-state.on', t('home.inGame'))
        : task.busy && task.id === e.id
          ? h('span.ip-state.busy', task.progress && task.progress.fraction ? `${Math.round(task.progress.fraction * 100)}%` : '…')
          : !e.installed
            ? h('span.ip-state', t('home.notInstalled'))
            : e.lastPlayed
              ? h('span.ip-state', timeAgo(e.lastPlayed))
              : null;
      const menuBtn = iconButton('dots', { cls: 'btn-sm ip-menu', variant: 'ghost' });
      menuBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openRowMenu(menuBtn, e, movable);
      });
      const row = h(
        'div.ip-row',
        { class: [e.id === sel ? 'selected' : '', e.isDefault ? 'latest' : ''].join(' '), dataset: { id: e.id }, 'data-tip': `${e.name}\n${subtitle(e)}` },
        h('img', { src: blockUrl(e.iconId), alt: '' }),
        h('div.ip-text', h('div.ip-name', e.name), h('div.ip-sub', shortSub(e))),
        state,
        menuBtn,
      );
      row.addEventListener('click', () => {
        select(e.id);
        togglePanel(false);
      });
      row.addEventListener('dblclick', () => {
        select(e.id);
        togglePanel(false);
        if (!(store.get('task') || {}).busy && !running) start(e.id, {});
      });
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        openRowMenu(null, e, movable, ev.clientX, ev.clientY);
      });
      return row;
    });
    swap(panelList, rows.length ? rows : h('div.list-empty', all.length ? t('home.noMatch', { q: query }) : t('home.empty')));
    const add = h('button.ip-add', { type: 'button', onclick: () => go('newInstall') }, icon('plus'), t('home.newInstall'));
    if (!panel.firstChild) {
      swap(panel, h('div.ip-head', h('div.ip-title', t('home.installs')), h('span.ip-count'), searchInput), panelList, add);
    } else {
      panel.lastChild.replaceWith(add);
    }
    panel.querySelector('.ip-count').textContent = String(all.length);
    searchInput.style.display = all.length > 5 ? '' : 'none';
    if (scrollToSelected) {
      const el = panelList.querySelector('.ip-row.selected');
      if (el) panelList.scrollTop = Math.max(0, el.offsetTop - panelList.clientHeight / 2 + el.offsetHeight / 2);
    }
  }

  // Up/Down walk the list while it's open, Enter closes it.
  function stepSelection(dir) {
    const all = entries();
    const i = all.findIndex((e) => e.id === selectedId());
    const next = all[Math.max(0, Math.min(all.length - 1, i + dir))];
    if (next) select(next.id);
  }

  function openRowMenu(anchor, e, movable, x, y) {
    const task = store.get('task') || {};
    const running = runningFor(e.id);
    if (e.isBedrock) {
      showMenu(anchor, [
        { label: t('menu.play'), icon: 'play', disabled: !!running, onClick: () => { select(e.id); togglePanel(false); start(e.id, {}); } },
        { separator: true },
        { label: t(e.installed ? 'menu.bedrockUpdate' : 'menu.bedrockInstall'), icon: 'download', onClick: () => api('bedrock:store').catch((err) => toast(err.message, { kind: 'error' })) },
        { label: t('menu.openFolder'), icon: 'folder', disabled: !e.installed, onClick: () => api('app:openFolder', 'instance', e.id, '') },
        { label: t('menu.bedrockSkin'), icon: 'hanger', onClick: () => go('skins') },
      ], typeof x === 'number' ? { x, y } : {});
      return;
    }
    const idx = movable.findIndex((m) => m.id === e.id);
    const items = [
      { label: t('menu.play'), icon: 'play', disabled: task.busy || !!running, onClick: () => { select(e.id); togglePanel(false); start(e.id, {}); } },
      running ? { label: t('menu.kill'), icon: 'stop', danger: true, onClick: () => kill(running) } : null,
      { separator: true },
      { label: t('menu.openFolder'), icon: 'folder', onClick: () => api('app:openFolder', 'instance', e.id, '') },
      e.loader !== 'vanilla' ? { label: t('menu.openMods'), icon: 'folder', onClick: () => api('app:openFolder', 'instance', e.id, 'mods') } : null,
      { label: t('menu.openScreenshots'), icon: 'image', onClick: () => api('app:openFolder', 'instance', e.id, 'screenshots') },
      { separator: true },
      !e.isDefault ? { label: t('menu.edit'), icon: 'edit', onClick: () => go('editInstall', { id: e.id }) } : null,
      { label: t('menu.verify'), icon: 'check', disabled: task.busy || !!running, onClick: () => start(e.id, { repair: true, launch: false }) },
      !e.isDefault ? { label: t('menu.moveUp'), icon: 'up', disabled: idx <= 0, onClick: () => api('installs:move', e.id, -1) } : null,
      !e.isDefault ? { label: t('menu.moveDown'), icon: 'down', disabled: idx < 0 || idx >= movable.length - 1, onClick: () => api('installs:move', e.id, 1) } : null,
      { separator: true },
      e.isDefault
        ? { label: t('menu.deleteFiles'), icon: 'trash', danger: true, disabled: task.busy || !!running || !e.installed, onClick: () => clearFiles(e) }
        : { label: t('menu.delete'), icon: 'trash', danger: true, disabled: !!running || (task.busy && task.id === e.id), onClick: () => remove(e) },
    ];
    showMenu(anchor, items, typeof x === 'number' ? { x, y } : {});
  }

  async function kill(run) {
    if (await confirmDialog(t('confirm.kill.title'), t('confirm.kill.text', { name: run.installName }), { ok: t('menu.kill') })) {
      api('game:kill', run.pid);
    }
  }

  async function remove(e) {
    if (!(await confirmDialog(t('confirm.deleteInstall.title'), t('confirm.deleteInstall.text', { name: e.name })))) return;
    try {
      const r = await api('installs:remove', e.id);
      if (r && r.warning) toast(r.warning, { kind: 'warn' });
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  async function clearFiles(e) {
    if (!(await confirmDialog(t('confirm.deleteFiles.title'), t('confirm.deleteFiles.text', { name: e.name })))) return;
    try {
      await api('installs:clearFiles', e.id);
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  // ---- worlds & servers flyout ------------------------------------------------------------
  let flyoutTab = 'worlds';
  function toggleFlyout(force) {
    const open = typeof force === 'boolean' ? force : !flyout.classList.contains('open');
    flyout.classList.toggle('open', open);
    worldsBtn.classList.toggle('open', open);
    if (open) {
      togglePicker(false);
      togglePanel(false);
      renderFlyout();
    }
  }

  function renderFlyout() {
    const bedrockSel = !!(selected() || {}).isBedrock;
    if (bedrockSel) flyoutTab = 'servers';
    const tabs = h(
      'div.flyout-tabs',
      (bedrockSel ? ['servers'] : ['worlds', 'servers']).map((k) =>
        h('button.flyout-tab', { type: 'button', class: flyoutTab === k ? 'active' : '', onclick: () => { flyoutTab = k; renderFlyout(); } }, icon(k === 'worlds' ? 'block' : 'server'), t(k === 'worlds' ? 'worlds.title' : 'worlds.servers')),
      ),
    );
    const body = h('div.flyout-body', h('div.flyout-empty', spinner()));
    swap(flyout, tabs, body);
    if (flyoutTab === 'worlds') loadWorlds(body);
    else loadServers(body);
  }

  async function loadWorlds(body) {
    let worlds = [];
    try {
      worlds = await api('worlds:recent');
    } catch {
      worlds = [];
    }
    if (!worlds.length) {
      swap(body, h('div.flyout-empty', t('worlds.empty')));
      return;
    }
    swap(
      body,
      h(
        'div.world-grid',
        worlds.map((w) => {
          const thumb = h(
            'div.world-thumb',
            { class: w.hasIcon ? '' : 'no-icon', style: { backgroundImage: w.hasIcon ? `url("mcl://world/${encodeURIComponent(w.installId)}/${encodeURIComponent(w.folder)}")` : null } },
            w.hasIcon ? null : icon('creative', { scale: 4, cls: 'world-fallback' }),
            h('span.mode', { 'data-tip': t(`mode.${w.mode}`) }, icon(MODE_SPRITE[w.mode] || 'survival')),
          );
          const card = h(
            'div.world-card',
            { 'data-tip': `${w.name}\n${t(`mode.${w.mode}`)} · ${w.installName}` },
            thumb,
            h('div.world-meta', h('div.world-name', w.name), h('div.world-sub', `${t(`mode.${w.mode}`)} · ${dayAgo(w.lastPlayed)}`)),
            h('div.play-overlay', icon('play', { scale: 3 })),
          );
          card.addEventListener('click', () => {
            toggleFlyout(false);
            if ((store.get('task') || {}).busy) return;
            select(w.installId);
            start(w.installId, { world: w.folder });
          });
          return card;
        }),
      ),
    );
  }

  async function loadServers(body) {
    const e = selected();
    let servers = [];
    try {
      servers = e ? await api('servers:list', e.id) : [];
    } catch {
      servers = [];
    }
    if (!servers.length) {
      swap(body, h('div.flyout-empty', t('worlds.serversEmpty')));
      return;
    }
    const listEl = h('div.server-list');
    swap(body, listEl);
    for (const s of servers) {
      const iconEl = h('img.server-icon', { src: s.icon || '', alt: '' });
      const realIcon = (url) => {
        iconEl.dataset.real = '1';
        iconEl.src = url;
      };
      if (!s.icon) {
        // drawn at once; the server's own icon replaces it if one turns up
        serverIcon({ name: s.name, host: s.host || s.ip }).then((url) => {
          if (!iconEl.dataset.real) iconEl.src = url;
        });
        if (e.isBedrock) api('servers:icon', s.ip).then((url) => url && realIcon(url)).catch(() => {});
      }
      const motd = h('div.server-motd', '…');
      const who = h('div.server-who');
      const stat = h('div.server-stat', spinner('sm'));
      const row = h('div.server-row', iconEl, h('div.server-text', h('div.server-name', s.name), motd, who), stat);
      row.addEventListener('click', () => {
        toggleFlyout(false);
        if ((store.get('task') || {}).busy || !e) return;
        start(e.id, { server: s.ip });
      });
      listEl.appendChild(row);
      api('servers:ping', s.ip, e.isBedrock ? 'bedrock' : 'java')
        .then((r) => {
          if (!r.online) {
            swap(motd, h('span', { style: { color: 'var(--bad)' } }, t('servers.offline')));
            swap(stat, h('div.ping.bad', icon('signal')));
            return;
          }
          if (r.favicon) realIcon(r.favicon);
          swap(motd, renderMotd(r.motd));
          if (r.players.sample.length) who.textContent = r.players.sample.join(', ');
          else if (r.version && e.isBedrock) who.textContent = `Bedrock ${r.version}`;
          const cls = r.latency < 90 ? '' : r.latency < 200 ? 'mid' : 'bad';
          swap(stat, h('div', t('servers.players', { online: r.players.online, max: r.players.max })), h(`div.ping${cls ? `.${cls}` : ''}`, t('servers.ping', { ms: r.latency }), icon('signal')));
        })
        .catch(() => swap(stat, '—'));
    }
  }

  // ---- popovers: outside click and keys close them ------------------------------------
  const closeOnOutside = (ev) => {
    if (document.querySelector('.menu') && document.querySelector('.menu').contains(ev.target)) return;
    if (flyout.classList.contains('open') && !flyout.contains(ev.target) && !worldsBtn.contains(ev.target)) toggleFlyout(false);
    if (panel.classList.contains('open') && !panel.contains(ev.target) && !instBtn.contains(ev.target)) togglePanel(false);
    if (picker.classList.contains('open') && !picker.contains(ev.target) && !poseBtn.contains(ev.target) && ev.target !== skinHit) togglePicker(false);
  };
  document.addEventListener('mousedown', closeOnOutside);
  life.add(() => document.removeEventListener('mousedown', closeOnOutside));
  const onKey = (e) => {
    if (document.querySelector('.overlay')) return;
    const open = [[picker, togglePicker], [panel, togglePanel], [flyout, toggleFlyout]].find(([el]) => el.classList.contains('open'));
    if (e.key === 'Escape' && open && !document.querySelector('.menu')) {
      e.stopPropagation();
      open[1](false);
      return;
    }
    if (panel.classList.contains('open') && e.target !== searchInput) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        stepSelection(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter') {
        togglePanel(false);
      }
    }
  };
  document.addEventListener('keydown', onKey, true);
  life.add(() => document.removeEventListener('keydown', onKey, true));

  // ---- wiring ---------------------------------------------------------------------------
  let lastAccent = cfg0.accentColor;
  life.add(store.on('config', (cfg) => {
    if (cfg.accentColor !== lastAccent) {
      lastAccent = cfg.accentColor;
      // the CSS variables update first; read them on the next frame
      requestAnimationFrame(() => particles.setPalette(paletteFromAccent()));
    }
    syncActivity();
  }));
  const refresh = () => {
    renderLaunch();
    if (panel.classList.contains('open')) renderPanel();
  };
  life.add(store.on(['installs', 'config', 'running', 'task', 'party'], refresh));
  let planFor_ = '';
  life.add(store.on(['party', 'config', 'installs'], () => {
    renderSlots();
    renderNameTag();
    const p = store.get('party') || {};
    const e = selected();
    if (!p.active || !p.leader || !e) return;
    // the world belongs to the installation it was picked in
    const keep = p.plan && p.plan.mode === 'world' && p.plan.installName === e.name ? planWorld(p.plan) : null;
    const plan = planFor(e, (p.plan && p.plan.server) || '', keep);
    const key = JSON.stringify(plan);
    if (key === planFor_ || (p.plan && JSON.stringify(p.plan) === key)) return;
    planFor_ = key;
    api('party:setPlan', plan).catch(() => {});
  }));
  renderSlots();
  life.add(store.on('running', syncActivity));

  let lastAppearance = appearanceKey();
  life.add(store.on(['config', 'installs'], () => {
    const key = appearanceKey();
    if (key !== lastAppearance) { lastAppearance = key; loadLobbySkin(); }
  }));
  loadLobbySkin();
  renderLaunch();
  syncActivity();
  requestAnimationFrame(layoutLobby);
  api('installs:list').then((l) => store.set({ installs: l })).catch(() => {});

  return () => life.dispose();
}
