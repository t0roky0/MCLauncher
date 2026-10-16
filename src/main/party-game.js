'use strict';
// Playing together: the leader's Play, the ready check, the start, and the
// leader's own world.
//
//   1. The leader presses Play: party.prepare(plan) — everyone's launcher
//      (the leader's too) gets that version on disk, downloading it if need
//      be, and says how it's going (party.reportReady). Only the leader can
//      start a party game.
//   2. All ready (or an older launcher that never answers, after a while):
//      the start goes out and every game starts — onto the plan's server, or
//      just the same version.
//   3. The leader's own world (plan.mode 'world'): the leader's game opens
//      the world; once the leader opens it to LAN ("Started serving on N"),
//      the friends' launchers tunnel to it (tunnel.js + the page) and their
//      games join 127.0.0.1:<local port>. Offline accounts get in through
//      the agent's "#offline"/"#lan" (game-skins.js).

const config = require('./config');
const installs = require('./installs');
const game = require('./game');
const party = require('./party');
const bedrock = require('./bedrock');
const tunnel = require('./tunnel');
const log = require('./log');

let send = () => {};
let notify = () => {};
let ru = () => true;
let current = null; // { round, plan, entryId }
let leaderEntry = ''; // the leader's own installation for this round
let partyPid = 0; // our game started for the party
let waitingWorld = null; // a member: the plan whose world we're waiting for
let following = null;
let observed = '';
let openingTunnel = false;
// A member: the game started (or sent) for the party — {entryId, server} —
// and a start still waiting for a download to finish.
let memberAt = null;
let pendingStart = null;

const sameServer = (a, b) => {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/:25565$/, '');
  return !!norm(a) && norm(a) === norm(b);
};

// The installation for a plan: the leader's own, or one with the same
// version and loader, made when there's none.
function entryFor(plan) {
  if (party.state().leader && leaderEntry) return installs.entryById(leaderEntry);
  const first = (v) => String(v || '').split(' ')[0];
  let entry = installs.listForUi().find((e) => !e.isBedrock && e.mcVersion === plan.mcVersion && e.loader === plan.loader && (plan.loader === 'vanilla' || first(e.loaderVersion) === first(plan.loaderVersion)));
  if (!entry) {
    entry = installs.create({ name: `${ru() ? 'Пати' : 'Party'} · ${plan.installName || plan.mcVersion}`.slice(0, 40), mcVersion: plan.mcVersion, loader: plan.loader, loaderVersion: plan.loaderVersion, iconId: 'cake' });
  }
  return entry;
}

// ---- the ready check -------------------------------------------------------------------------

function prepare(plan, round) {
  if (plan.edition === 'bedrock') {
    party.reportReady(round, bedrock.cached().installed ? 'ready' : 'error', 1);
    return;
  }
  let entry;
  try {
    entry = entryFor(plan);
  } catch (e) {
    log.warn(`Party: ${e.message}`);
    party.reportReady(round, 'error');
    return;
  }
  current = { round, plan, entryId: entry.id };
  if (installs.isReady(entry.id)) {
    party.reportReady(round, 'ready', 1);
    return;
  }
  party.reportReady(round, 'busy', 0);
  try {
    installs.start(entry.id, { launch: false });
  } catch (e) {
    log.warn(`Party: ${e.message}`);
    party.reportReady(round, 'error');
  }
}

let lastReport = 0;
installs.onEvent((type, p) => {
  if (following && (type === 'done' || type === 'cancelled' || type === 'error')) {
    if (type === 'error' && p.id === following.entryId) {
      send('toast', { kind: 'error', text: p.message || (ru() ? 'Не удалось подготовить игру для лобби.' : 'Could not prepare the party game.') });
      following = null;
    } else if (type === 'done') resumeFollow();
  }
  if (pendingStart && !following && (type === 'done' || type === 'cancelled' || type === 'error')) {
    const start = pendingStart;
    pendingStart = null;
    if (type === 'done' && party.state().active && !party.state().leader) startMember(start.plan);
  }
  const c = current;
  if (!c) return;
  if (type === 'task' && p.busy && p.id === c.entryId && p.progress) {
    if (Date.now() - lastReport < 1000) return;
    lastReport = Date.now();
    party.reportReady(c.round, 'busy', p.progress.fraction || 0);
  } else if (type === 'done' && p.id === c.entryId && p.action === 'verify') {
    party.reportReady(c.round, 'ready', 1);
  } else if ((type === 'error' || type === 'cancelled') && p.id === c.entryId) {
    party.reportReady(c.round, 'error');
  }
});

// ---- starting ---------------------------------------------------------------------------------

function launch(entryId, opts) {
  if (entryId === 'bedrock') return installs.start('bedrock', { server: opts.server || '' });
  if (game.isRunning(entryId)) return opts.server ? game.connectToServer(entryId, opts.server) : null;
  return installs.start(entryId, opts);
}

// The leader pressed Play with friends in the party.
function play(plan, entryId) {
  if (!party.state().leader) throw new Error('Запускать пати может только лидер.');
  if (party.state().prep) throw new Error('Уже идёт подготовка игры для лобби.');
  if (installs.taskView().busy) throw new Error('Уже идёт загрузка — дождитесь её или отмените.');
  if (game.isRunning(entryId)) throw new Error('Игра уже запущена. Закройте её перед общим запуском.');
  leaderEntry = entryId;
  const { round, plan: clean } = party.prepare({ ...plan, follow: plan.edition !== 'bedrock' });
  prepare(clean, round);
  return party.state();
}

// World/server tiles use the same party launch as the main Play button.
function startFromUi(entryId, opts = {}) {
  const s = party.state();
  if (!s.active || s.members.length < 2 || opts.launch === false || opts.repair) return installs.start(entryId, opts);
  if (!s.leader) throw new Error('Запускать пати может только лидер.');
  const entry = installs.listForUi().find(e => e.id === entryId);
  if (!entry) throw new Error('Установка не найдена.');
  const world = !entry.isBedrock && opts.world || '';
  return play({
    edition: entry.isBedrock ? 'bedrock' : 'java', installName: entry.name,
    mcVersion: entry.mcVersion, loader: entry.loader, loaderVersion: entry.loaderVersion || '',
    mode: world ? 'world' : opts.server ? 'server' : 'none',
    world, worldName: world, server: world ? '' : opts.server || '',
  }, entryId);
}

// Everyone's ready: off we go.
function goLeader(plan) {
  party.start(plan);
  const entryId = plan.edition === 'bedrock' ? 'bedrock' : leaderEntry;
  if (plan.mode === 'world') {
    send('toast', { kind: 'party', icon: 'block', text: ru() ? 'Мир откроется для лобби автоматически. Друзья подключатся после загрузки мира.' : 'Your world opens to the party automatically. Friends join when it finishes loading.' });
    return launch(entryId, { world: plan.world, partyHost: true });
  }
  return launch(entryId, { server: plan.server });
}

function goMember(plan) {
  if (plan.edition === 'bedrock') return launch('bedrock', { server: plan.server });
  if (!plan.follow && plan.mode === 'world') {
    // an older leader: in once its world is open
    waitingWorld = plan;
    if (party.state().lan) send('tunnel:join', { leaderId: party.leaderId() });
  }
  // The leader's confirmed destination is already known: that start wins.
  if (following) {
    resumeFollow();
    return null;
  }
  return startMember(plan);
}

// Java starts together with the leader's: straight onto the plan's server
// when there is one, otherwise to the main menu. Where the leader actually
// goes (a server, their own world) follows into the running game.
function startMember(plan) {
  const entry = entryFor(plan);
  if (game.isRunning(entry.id)) return null;
  if (installs.taskView().busy) {
    pendingStart = { plan };
    return null;
  }
  const server = plan.mode === 'server' ? plan.server : '';
  memberAt = { entryId: entry.id, server };
  return launch(entry.id, { server });
}

function receiveFollow(destination) {
  following = null;
  waitingWorld = null;
  send('tunnel:join', { leaderId: '' });
  tunnel.stop();
  if (!destination || !party.state().active || party.state().leader) return;
  try {
    const entry = entryFor(destination.plan);
    following = { ...destination, entryId: entry.id, dispatched: false };
    resumeFollow();
  } catch (e) { send('toast', { kind: 'error', text: e.message }); }
}

function resumeFollow() {
  const f = following;
  if (!f || f.dispatched || !party.state().active || party.state().leader) return;
  try {
    const task = installs.taskView();
    if (task.busy) return; // an existing download/start finishes before we redirect it
    if (!installs.isReady(f.entryId)) {
      installs.start(f.entryId, { launch: false });
      return;
    }
    f.dispatched = true;
    pendingStart = null;
    if (f.plan.mode === 'world') {
      waitingWorld = f.plan;
      send('tunnel:join', { leaderId: party.leaderId() });
    } else if (memberAt && memberAt.entryId === f.entryId && sameServer(memberAt.server, f.plan.server) && game.isRunning(f.entryId)) {
      // already started onto that server with the leader
    } else {
      memberAt = { entryId: f.entryId, server: f.plan.server };
      launch(f.entryId, { server: f.plan.server });
    }
  } catch (e) {
    if (following === f) following = null;
    send('toast', { kind: 'error', text: e.message });
  }
}

function destinationFromGame(p, mode) {
  const s = party.state();
  if (!s.active || !s.leader) return;
  const entry = installs.entryById(p.installId);
  if (!entry) return;
  const key = `${p.pid}:${mode}:${mode === 'world' ? p.port : p.server}`;
  if (key === observed) return;
  observed = key;
  leaderEntry = entry.id;
  partyPid = p.pid;
  if (mode === 'world') {
    tunnel.setHostPort(p.port);
    send('tunnel:host', { open: true });
    party.setLan(true);
  } else {
    party.setLan(false);
    send('tunnel:host', { open: false });
    tunnel.stop();
  }
  party.follow({ edition: 'java', installName: entry.name, mcVersion: entry.mcVersion,
    loader: entry.loader, loaderVersion: entry.loaderVersion || '', mode, follow: true,
    server: mode === 'server' ? p.server : '', worldName: mode === 'world' ? (ru() ? 'Мир лидера' : 'Leader’s world') : '',
  });
  log.info(`Party follows leader: ${mode === 'world' ? `world on port ${p.port}` : p.server}.`);
}

function clearDestination() {
  observed = '';
  if (party.state().leader) { party.setLan(false); party.follow(null); }
  send('tunnel:host', { open: false });
  tunnel.stop();
}

// ---- the leader's world ----------------------------------------------------------------------------

// A member's tunnel is through: the game goes to the local end of it.
async function tunnelReady() {
  const state = party.state();
  const plan = waitingWorld;
  if (!plan || !state.active || state.leader || plan.mode !== 'world' || openingTunnel) return null;
  openingTunnel = true;
  try {
  const port = await tunnel.listen();
  if (waitingWorld !== plan || !party.state().active) return null;
  const entry = following ? installs.entryById(following.entryId) : entryFor(plan);
  memberAt = { entryId: entry.id, server: `127.0.0.1:${port}` };
  launch(entry.id, { server: `127.0.0.1:${port}` });
  waitingWorld = null;
  return port;
  } finally { openingTunnel = false; }
}

game.onEvent((type, p) => {
  if (type === 'partyWorld') destinationFromGame(p, 'world');
  if (type === 'partyServer') destinationFromGame(p, 'server');
  if (type === 'partyIdle' && p.pid === partyPid && party.state().leader) clearDestination();
  if (type === 'partyError' && party.state().active) {
    log.warn(`Party automation: ${p.message}`);
    send('toast', { kind: 'error', text: ru() ? `Не удалось выполнить автоматическое подключение: ${p.message}` : `Automatic party connection failed: ${p.message}` });
  }
  if (type === 'started' && current && p.installId === (party.state().leader ? leaderEntry : current.entryId)) partyPid = p.pid;
  if (type === 'lan') {
    const s = party.state();
    if (s.active && s.leader && s.plan && s.plan.mode === 'world' && (!partyPid || p.pid === partyPid)) {
      tunnel.setHostPort(p.port);
      send('tunnel:host', { open: true });
      party.setLan(true);
      log.info(`Party world open on port ${p.port}.`);
    }
  }
  if (type === 'exited' && p.pid === partyPid) {
    partyPid = 0;
    clearDestination();
  }
  if (type === 'exited' && memberAt && memberAt.entryId === p.installId && !game.isRunning(p.installId)) memberAt = null;
});

party.onEvent((type, p) => {
  if (type === 'follow') {
    receiveFollow(p);
  } else if (type === 'prep') {
    // the leader's plan arrived with the ready check
    prepare(p.plan, p.round);
  } else if (type === 'prepCancel') {
    const t = installs.taskView();
    if (current && t && t.busy && t.id === current.entryId) installs.cancel();
    current = null;
  } else if (type === 'allReady') {
    const s = party.state();
    if (!s.leader) return;
    try {
      goLeader(p.plan);
    } catch (e) {
      log.warn(`Party start: ${e.message}`);
      send('toast', { kind: 'error', text: e.message });
    }
  } else if (type === 'start') {
    try {
      goMember(p.plan);
    } catch (e) {
      log.warn(`Party start: ${e.message}`);
      send('toast', { kind: 'error', text: e.message });
    }
  } else if (type === 'lan') {
    if (following) return; // modern destinations carry their own ordered availability
    if (p.open && waitingWorld) send('tunnel:join', { leaderId: p.leaderId });
    if (!p.open) {
      send('tunnel:join', { leaderId: '' });
      tunnel.stop();
    }
  } else if (type === 'changed' && !p.active) {
    current = null;
    waitingWorld = null;
    following = null;
    observed = '';
    leaderEntry = '';
    partyPid = 0;
    memberAt = null;
    pendingStart = null;
    tunnel.stop();
  }
});

module.exports = {
  init(o) {
    send = o.send;
    notify = o.notify || notify;
    ru = () => config.get().language !== 'en';
  },
  play,
  startFromUi,
  tunnelReady,
  retryTunnel() {
    const state = party.state();
    const plan = following?.plan || waitingWorld;
    if (!state.active || state.leader || !plan || plan.mode !== 'world') return null;
    waitingWorld = plan;
    tunnel.stop();
    return party.leaderId();
  },
};
