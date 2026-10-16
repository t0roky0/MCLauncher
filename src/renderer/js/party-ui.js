// The party dialog: make a party or join one by its code; in a party — the
// code to send, who's in, and for the leader, the server everyone goes to.
import { h, swap, debounce } from './dom.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { api, store, remote } from './core.js';
import { button, input, modal, toast, spinner, field, showMenu, confirmDialog, toggleRow, segmented } from './ui.js';
import { skinFace, STEVE } from './skin3d.js';
import { currentAppearance } from './appearance.js';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image'));
    img.src = url;
  });
}

// Others can't load our files: the skin travels as a small PNG data URL.
async function skinDataUrl(url) {
  const img = await loadImage(url);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  const d = c.toDataURL('image/png');
  return d.length < 40000 ? d : '';
}

export function selectedEntry() {
  const cfg = store.get('config') || {};
  const all = store.get('installs') || [];
  return all.find((e) => e.id === cfg.selectedInstall) || all[0] || null;
}

// What a member's launcher needs to start the same thing: onto a server,
// or (world = {folder, name}) into the leader's own world.
export function planFor(entry, server, world) {
  if (!entry) return null;
  const own = !!(world && world.folder) && !entry.isBedrock;
  return {
    edition: entry.isBedrock ? 'bedrock' : 'java',
    installName: entry.name,
    mcVersion: entry.mcVersion,
    loader: entry.isBedrock ? 'bedrock' : entry.loader,
    loaderVersion: entry.loaderVersion || '',
    server: own ? '' : server || '',
    mode: own ? 'world' : '',
    world: own ? world.folder : '',
    worldName: own ? world.name || world.folder : '',
  };
}

// The world of a plan, when it's the leader's own.
export function planWorld(plan) {
  return plan && plan.mode === 'world' && plan.world ? { folder: plan.world, name: plan.worldName } : null;
}

// What friends see of us: the very skin our lobby shows (Microsoft profile,
// local skin, or what Bedrock wears for an Xbox account).
export async function partyMe() {
  const cfg = store.get('config') || {};
  const acc = (cfg.accounts || []).find((a) => a.id === cfg.activeAccount) || (cfg.accounts || [])[0];
  let url = STEVE;
  let model = 'classic';
  let cape = '';
  try {
    const look = await currentAppearance();
    if (look && look.url) {
      url = look.url;
      model = look.model;
    }
    cape = (look && look.cape) || '';
  } catch {
    /* Steve */
  }
  const entry = selectedEntry();
  return {
    name: acc ? acc.name : 'Player',
    skin: await skinDataUrl(url).catch(() => ''),
    cape: cape ? await skinDataUrl(cape).catch(() => '') : '',
    model,
    edition: entry && entry.isBedrock ? 'bedrock' : 'java',
  };
}

export function partyLink(code) {
  return `mclauncher://party/${code}`;
}

// The leader shows someone out (they can't come back until the party ends).
export async function kickMember(m) {
  if (!(await confirmDialog(t('party.kickTitle'), t('party.kickText', { name: m.name }), { ok: t('party.kick') }))) return;
  try {
    await api('party:kick', m.id);
    toast(t('party.kickedOk', { name: m.name }), { kind: 'ok', icon: 'userMinus' });
  } catch (e) {
    toast(e.message, { kind: 'error' });
  }
}

// An Xbox friend's open lobby (friend-lobbies.js): in, with a click — after
// asking, if that means leaving the party we're in.
// "Join" pressed in Discord: that press is the consent, so straight in —
// unless we'd be leaving a party of our own for it.
export async function joinByCode(code, { after } = {}) {
  const same = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const p = store.get('party') || {};
  if (p.active && same(p.code) === same(code)) {
    if (after) after();
    return;
  }
  if (p.active && !(await confirmDialog(t('party.switchTitle'), t(p.leader ? 'party.switchDiscordLeader' : 'party.switchDiscord'), { ok: t('party.switch'), danger: !!p.leader }))) return;
  try {
    await api('party:join', code, await partyMe());
    toast(t('party.joinedDiscord'), { kind: 'party', icon: 'friends' });
    if (after) after();
  } catch (e) {
    toast(e.message, { kind: 'error' });
  }
}

export async function joinFriendLobby(item, { after } = {}) {
  if (item.joined) {
    if (after) after();
    return;
  }
  const p = store.get('party') || {};
  if (p.active) {
    const text = t(p.leader ? 'party.switchTextLeader' : 'party.switchText', { name: item.gamertag });
    if (!(await confirmDialog(t('party.switchTitle'), text, { ok: t('party.switch'), danger: !!p.leader }))) return;
  }
  try {
    await api('party:joinFriend', item.xuid, await partyMe());
    if (after) after();
  } catch (e) {
    toast(e.message, { kind: 'error' });
  }
}

export function lobbyLine(item) {
  const full = item.count >= item.capacity;
  const parts = [t(full ? 'friends.lobbyFull' : 'friends.lobbyOpen', { n: item.count, cap: item.capacity })];
  if (item.installName) parts.push(item.installName);
  return parts.join(' · ');
}

const hasXbox = () => {
  const cfg = store.get('config') || {};
  const acc = (cfg.accounts || []).find((a) => a.id === cfg.activeAccount);
  return !!acc && (acc.type === 'msa' || acc.type === 'xbox');
};

let openDialog = null;

export function openPartyDialog({ code = '', focusServer = false } = {}) {
  if (openDialog) openDialog.close();
  const body = h('div.party-dialog');
  let busy = false;
  let serverInput = null;

  async function create() {
    if (busy) return;
    busy = true;
    render();
    try {
      await api('party:create', await partyMe());
      const entry = selectedEntry();
      api('party:setPlan', planFor(entry, '')).catch(() => {});
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
    busy = false;
    render();
  }

  async function join(c) {
    if (busy) return;
    busy = true;
    render();
    try {
      await api('party:join', c, await partyMe());
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
    busy = false;
    render();
  }

  function copy(text, what) {
    navigator.clipboard.writeText(text).then(() => toast(what, { kind: 'ok', icon: 'copy' })).catch(() => {});
  }

  function memberRow(m, p) {
    const face = h('img.pm-face', { alt: '' });
    skinFace(m.skin || STEVE, 32).then((d) => (face.src = d)).catch(() => skinFace(STEVE, 32).then((d) => (face.src = d)));
    return h(
      'div.pm-row',
      face,
      h('div.pm-name', m.name),
      m.leader ? h('span.chip.acc', icon('star'), t('party.leader')) : null,
      m.self ? h('span.chip', t('party.you')) : null,
      h('span.pm-ed', m.edition === 'bedrock' ? 'Bedrock' : 'Java'),
      p.leader && !m.self ? button(null, { icon: 'userMinus', variant: 'ghost', cls: 'btn-icon btn-sm pm-kick', title: t('party.kick'), onClick: () => kickMember(m) }) : null,
    );
  }

  function render() {
    const p = store.get('party') || { active: false };
    if (!p.active) {
      const codeInput = input({ value: code, placeholder: 'ABCD-EF23', maxLength: 12, onEnter: () => join(codeInput.value) });
      codeInput.classList.add('party-code-input');
      const open = (store.get('friendLobbies') || []).filter((l) => !l.joined);
      swap(
        body,
        open.length
          ? h(
              'div.party-friends',
              h('div.label', t('party.friendLobbies')),
              open.map((l) =>
                h(
                  'div.pf-row',
                  icon('friends'),
                  h('div.pf-text', h('div.pf-name', l.gamertag), h('div.pf-sub', lobbyLine(l))),
                  button(t('friends.join'), { variant: 'primary', icon: 'right', cls: 'btn-sm', disabled: busy || l.count >= l.capacity, onClick: () => joinFriendLobby(l) }),
                ),
              ),
            )
          : h('div.party-hero', icon('friends', { scale: 4 }), h('div.hint', t('party.about'))),
        button(t('party.create'), { variant: 'primary', icon: 'plus', cls: 'party-create', disabled: busy, onClick: create }),
        h('div.or', t('party.or')),
        field(t('party.joinCode'), h('div.row', h('div.grow', codeInput), button(t('party.join'), { icon: 'right', disabled: busy, onClick: () => join(codeInput.value) }))),
        busy ? h('div.party-busy', spinner('sm'), t('party.connecting')) : null,
        h('div.hint.party-relay', t('party.relayNote')),
      );
      if (code) setTimeout(() => codeInput.focus(), 50);
      return;
    }
    const entry = selectedEntry();
    const plan = p.plan || {};
    const rows = [
      h(
        'div.party-code-row',
        h('div', h('div.label', { style: { margin: 0 } }, t('party.code')), h('div.party-code', p.code)),
        h('div.grow'),
        button(t('party.copyCode'), { icon: 'copy', cls: 'btn-sm', onClick: () => copy(p.code, t('party.copied')) }),
        button(t('party.copyLink'), { icon: 'external', cls: 'btn-sm', onClick: () => copy(partyLink(p.code), t('party.linkCopied')) }),
      ),
      h('div.hint', { style: { marginTop: '-4px' } }, t('party.share')),
      h('div.label', t('party.members', { n: p.members.length })),
      h('div.pm-list', p.members.map((m) => memberRow(m, p))),
    ];
    if (p.waiting) rows.push(h('div.party-busy', spinner('sm'), t('party.waitingLeader')));
    if (p.leader) {
      // where: a server (empty = everyone just starts the version), or the
      // leader's own world (Java), which friends come into through the launcher
      const own = !!(entry && !entry.isBedrock && plan.mode === 'world');
      if (entry && !entry.isBedrock) {
        rows.push(field(t('party.where'), segmented([{ value: 'server', label: t('party.whereServer') }, { value: 'world', label: t('party.whereWorld') }], own ? 'world' : 'server', async (v) => {
          if (v === 'server') {
            api('party:setPlan', planFor(selectedEntry(), '')).catch(() => {});
            return;
          }
          const list = await api('worlds:list', entry.id).catch(() => []);
          if (!list.length) {
            toast(t('party.noWorlds'), { kind: 'warn', icon: 'block', timeout: 9000 });
            render();
            return;
          }
          api('party:setPlan', planFor(selectedEntry(), '', { folder: list[0].folder, name: list[0].name })).catch(() => {});
        })));
      }
      if (own) {
        const pickWorld = button(plan.worldName || plan.world, { icon: 'down', iconRight: true, cls: 'party-world-pick', onClick: async (e, el) => {
          const list = await api('worlds:list', entry.id).catch(() => []);
          showMenu(el, list.map((w) => ({ label: w.name, hint: w.folder !== w.name ? w.folder : '', onClick: () => api('party:setPlan', planFor(selectedEntry(), '', { folder: w.folder, name: w.name })).catch(() => {}) })));
        } });
        rows.push(field(t('party.world'), pickWorld, t('party.worldHint')), h('div.party-plan', icon('play'), t('party.version', { name: entry.name })));
        if (hasXbox()) {
          const cfg = store.get('config') || {};
          rows.push(toggleRow(t('party.friendsVisible'), t('party.friendsVisibleHint'), cfg.partyFriends !== false, (on) => {
            api('config:set', { partyFriends: on }).then((c) => store.set({ config: c })).catch(() => {});
          }));
        }
      }
    }
    if (p.leader && !(entry && !entry.isBedrock && plan.mode === 'world')) {
      serverInput = input({ value: plan.server || '', placeholder: entry && entry.isBedrock ? 'play.example.net:19132' : 'mc.example.net', maxLength: 200 });
      const pushPlan = debounce(() => api('party:setPlan', planFor(selectedEntry(), serverInput.value.trim())).catch(() => {}), 300);
      serverInput.addEventListener('input', pushPlan);
      const pick = button(null, { icon: 'down', cls: 'btn-icon', title: t('party.savedServers'), onClick: async (e, el) => {
        const list = entry ? await api('servers:list', entry.id).catch(() => []) : [];
        if (!list.length) {
          toast(t('party.noSaved'), { kind: 'warn' });
          return;
        }
        showMenu(el, list.map((s) => ({ label: s.name || s.ip, hint: s.ip, onClick: () => {
          serverInput.value = s.ip;
          pushPlan();
        } })));
      } });
      rows.push(
        field(t('party.server'), h('div.row', h('div.grow', serverInput), pick), t('party.serverHint')),
        h('div.party-plan', icon(entry && entry.isBedrock ? 'block' : 'play'), t('party.version', { name: entry ? entry.name : '—' })),
      );
      if (hasXbox()) {
        const cfg = store.get('config') || {};
        rows.push(toggleRow(t('party.friendsVisible'), t('party.friendsVisibleHint'), cfg.partyFriends !== false, (on) => {
          api('config:set', { partyFriends: on }).then((c) => store.set({ config: c })).catch(() => {});
        }));
      }
    } else if (!p.leader) {
      rows.push(plan.mode === 'world'
        ? h('div.party-plan', icon('block'), t('party.planWorld', { world: plan.worldName || plan.world }))
        : h('div.party-plan', icon('server'), plan.server ? t('party.planServer', { server: plan.server }) : t('party.planNoServer')));
      if (plan.installName) rows.push(h('div.party-plan', icon(plan.edition === 'bedrock' ? 'block' : 'play'), t('party.planVersion', { name: plan.installName })));
      rows.push(h('div.hint', t('party.memberHint')));
    }
    rows.push(
      h('div.party-status', h(`span.dot${p.connected && !p.reconnecting ? '' : '.idle'}`, icon('lamp')), p.connected && !p.reconnecting ? t('party.online') : t('party.reconnecting')),
      h('div.row', { style: { justifyContent: 'flex-end', marginTop: '6px' } }, button(p.leader ? t('party.disband') : t('party.leave'), { variant: 'ghost', icon: 'x', onClick: () => api('party:leave') })),
    );
    // keep what's being typed when members come and go
    const typing = document.activeElement && body.contains(document.activeElement) ? document.activeElement : null;
    const keep = typing && typing.tagName === 'INPUT' ? { value: typing.value, start: typing.selectionStart } : null;
    swap(body, rows);
    if (keep && serverInput) {
      serverInput.value = keep.value;
      serverInput.focus();
      serverInput.setSelectionRange(keep.start, keep.start);
    }
    if (focusServer && serverInput) {
      focusServer = false;
      setTimeout(() => serverInput.focus(), 50);
    }
  }

  const off = store.on(['party', 'friendLobbies'], render);
  render();
  const dlg = modal({ title: t('party.title'), body, width: 500, onClose: () => {
    off();
    openDialog = null;
  } });
  openDialog = dlg;
  return dlg;
}
