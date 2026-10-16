'use strict';
// Starting the game and watching it.
//
// The command line is built from the version's own argument templates with
// the launcher-side features filled in: custom resolution always, quick play
// when a world or a server was picked from the launch bar. Output is decoded
// as UTF-8 (the JVM is told to write UTF-8, so Cyrillic chat/log lines come
// through intact), streamed into the console, and the process is sampled by
// the C++ module for the "in game" read-out.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const config = require('./config');
const installer = require('./installer');
const native = require('./native');
const gameSkins = require('./game-skins');
const log = require('./log');

// Opened for every modern JVM, as v1 did: mods and Netty-based voice chat
// reach into these packages reflectively and die without them.
const JPMS_COMPAT = [
  '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
  '--add-opens', 'java.base/java.lang.reflect=ALL-UNNAMED',
  '--add-opens', 'java.base/java.io=ALL-UNNAMED',
  '--add-opens', 'java.base/java.nio=ALL-UNNAMED',
  '--add-opens', 'java.base/java.util=ALL-UNNAMED',
  '--add-opens', 'java.base/jdk.internal.misc=ALL-UNNAMED',
  '--add-opens', 'java.base/sun.nio.ch=ALL-UNNAMED',
];

const running = new Map(); // pid -> session
const listeners = new Set();

function emit(type, payload) {
  for (const fn of listeners) {
    try {
      fn(type, payload);
    } catch {
      /* ignore */
    }
  }
}

// Splits a user-typed JVM argument string, honouring "quoted parts".
function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function substitute(args, vars) {
  return args.map((a) => String(a).replace(/\$\{([^}]+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all)));
}

function buildCommand(entry, spec, session, opts) {
  const cfg = config.get();
  const width = Math.max(320, Number(cfg.windowWidth) || 854);
  const height = Math.max(240, Number(cfg.windowHeight) || 480);
  // Demo mode is only ever switched on by --demo, which the version JSON adds
  // for is_demo_user — never set here, so every account plays the full game,
  // in every version and with every loader (they inherit vanilla's arguments).
  const features = {
    is_demo_user: false,
    has_custom_resolution: true,
    is_quick_play_singleplayer: !!(opts.world && spec.supportsQuickPlay),
    is_quick_play_multiplayer: !!(opts.server && spec.supportsQuickPlay),
  };
  const vars = {
    natives_directory: spec.nativesDir,
    launcher_name: 'MCLauncher',
    launcher_version: app.getVersion(),
    classpath: spec.classpath.join(';'),
    classpath_separator: ';',
    library_directory: config.dirs.libraries(),
    auth_player_name: session.name,
    version_name: spec.versionName,
    game_directory: spec.gameDir,
    assets_root: spec.assetsRoot,
    game_assets: spec.gameAssets,
    assets_index_name: spec.assetsId,
    auth_uuid: String(session.uuid).replace(/-/g, ''),
    auth_access_token: session.accessToken,
    auth_session: `token:${session.accessToken}:${String(session.uuid).replace(/-/g, '')}`,
    user_type: session.userType,
    user_properties: '{}',
    version_type: entry.loader !== 'vanilla' ? entry.loader : spec.versionType,
    clientid: '',
    auth_xuid: session.xuid || '',
    resolution_width: width,
    resolution_height: height,
    quickPlaySingleplayer: opts.world || '',
    quickPlayMultiplayer: opts.server || '',
    quickPlayPath: '',
    quickPlayRealms: '',
  };

  const ram = Number(entry.ramMb) || Number(cfg.ramMb) || 2048;
  const userJvm = splitArgs(entry.jvmArgs || cfg.jvmArgs);
  const jvm = [];
  if (!userJvm.some((a) => a.startsWith('-Xmx'))) jvm.push(`-Xmx${ram}M`);
  jvm.push(...userJvm);
  if (spec.javaMajor >= 17) jvm.push(...JPMS_COMPAT);
  jvm.push(...(opts.extraJvm || []));
  jvm.push(
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    '-Dsun.stdout.encoding=UTF-8',
    '-Dsun.stderr.encoding=UTF-8',
    '-Dlog4j2.formatMsgNoLookups=true',
  );

  let versionJvm;
  let game;
  if (spec.jvmArgsTemplate) {
    versionJvm = substitute(installer.collectArgs(spec.jvmArgsTemplate, features), vars);
    game = substitute(installer.collectArgs(spec.gameArgsTemplate, features), vars);
  } else {
    versionJvm = substitute(['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'], vars);
    game = substitute(splitArgs(spec.minecraftArguments), vars);
    game.push('--width', String(width), '--height', String(height));
  }
  if (!versionJvm.some((a) => a.startsWith('-Djava.library.path'))) versionJvm.unshift(`-Djava.library.path=${spec.nativesDir}`);
  if (!versionJvm.includes('-cp') && !versionJvm.includes('-classpath')) versionJvm.push('-cp', vars.classpath);

  if (opts.server && !spec.supportsQuickPlay) {
    // Pre-1.20 versions understand --server/--port instead.
    const [host, port] = String(opts.server).split(':');
    game.push('--server', host, '--port', port || '25565');
  }
  if (cfg.fullscreen && !game.includes('--fullscreen')) game.push('--fullscreen');
  // …and a hand-made version JSON with a bare "--demo" doesn't sneak it in
  const demo = game.indexOf('--demo');
  if (demo >= 0) game.splice(demo, 1);

  return [...jvm, ...versionJvm, spec.mainClass, ...game];
}

// Java 9+ reads arguments from a file ("@file"), which sidesteps Windows'
// 32k command-line limit that a big modpack classpath can hit. Only the JVM
// side goes in (the classpath is what's long); the main class and the game's
// own arguments — the account token among them — stay off the disk.
async function maybeArgFile(args, spec) {
  const length = args.reduce((n, a) => n + a.length + 3, 0);
  if (length < 28000 || spec.javaMajor < 9) return args;
  const at = args.indexOf(spec.mainClass);
  if (at <= 0) return args;
  const quoted = args.slice(0, at).map((a) => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join('\n');
  const file = path.join(spec.gameDir, '.mclauncher-args.txt');
  await fsp.writeFile(file, quoted, 'utf8');
  return [`@${file}`, ...args.slice(at)];
}

const JAVA_BOOT = /jvm.cfg|could not find java.dll|Error occurred during initialization of VM|Could not create the Java Virtual Machine|UnsupportedClassVersionError|has been compiled by a more recent version/i;

function redact(args, token) {
  return args.map((a) => (token && token.length > 8 && a.includes(token) ? a.split(token).join('<token>') : a));
}

async function findCrashReport(gameDir, since) {
  const dir = path.join(gameDir, 'crash-reports');
  try {
    const files = await fsp.readdir(dir);
    let best = null;
    for (const f of files) {
      const p = path.join(dir, f);
      const st = await fsp.stat(p);
      if (st.mtimeMs >= since - 2000 && (!best || st.mtimeMs > best.t)) best = { p, t: st.mtimeMs };
    }
    return best ? best.p : '';
  } catch {
    return '';
  }
}

async function launch(entry, spec, session, opts = {}) {
  log.secret(session.accessToken);
  const mappings = await require('./party-mappings').forEntry(entry);
  const skins = await gameSkins.prepare({ accountId: session.accountId, identity: { uuid: session.uuid, name: session.name }, self: session.skin || null, assetsRoot: spec.assetsRoot, offline: !!session.offline, lan: !!opts.partyHost, installId: entry.id, mappings, partyBridge: true });
  const args = buildCommand(entry, spec, session, { ...opts, extraJvm: skins ? skins.jvmArgs : [] });
  log.info(`Java ${spec.javaVersion || spec.javaMajor}: ${spec.javaExe}`);
  log.info(`Command: ${redact(args, session.accessToken).join(' ')}`);
  const finalArgs = await maybeArgFile(args, spec);
  await fsp.mkdir(spec.gameDir, { recursive: true });

  // java.exe without a console window: a JVM that fails to start writes the
  // reason to stderr (our console) instead of a javaw message box
  const consoleJava = spec.javaExe.replace(/javaw\.exe$/i, 'java.exe');
  const child = spawn(fs.existsSync(consoleJava) ? consoleJava : spec.javaExe, finalArgs, {
    cwd: spec.gameDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, _JAVA_OPTIONS: undefined },
  });
  const startedAt = Date.now();

  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (e) => {
      if (skins) skins.release();
      reject(e);
    });
  });

  const s = {
    pid: child.pid,
    installId: entry.id,
    installName: entry.name,
    mcVersion: entry.mcVersion,
    loader: entry.loader,
    server: opts.server || '',
    startedAt,
    child,
    partyControl: skins,
    killed: false,
    stats: null,
    lastCpu: null,
    ready: false,
  };
  running.set(child.pid, s);
  log.info(`Game started: ${entry.name} (pid ${child.pid}).`);
  emit('started', publicSession(s));

  const cfg = config.get();
  if (cfg.gamePriority && cfg.gamePriority !== 'normal') {
    if (native.setPriority(child.pid, cfg.gamePriority)) log.info(`Process priority: ${cfg.gamePriority}.`);
  }

  const pipe = (stream, isErr) => {
    let rest = '';
    const decoder = new TextDecoder('utf-8');
    stream.on('data', (chunk) => {
      const text = rest + decoder.decode(chunk, { stream: true });
      const lines = text.split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        if (require('./nearby').accept(line, child.pid)) continue;
        log.game(line, isErr);
        if (isErr) s.lastErr = [...(s.lastErr || []).slice(-29), line];
        // The window exists once the sound engine/atlas lines appear; used
        // to tell the UI the game has actually finished loading.
        if (!s.ready && /Sound engine started|Created: \d+x\d+x\d+ minecraft:textures\/atlas|Backend library: LWJGL/.test(line)) {
          s.ready = true;
          emit('ready', publicSession(s));
        }
        // "Open to LAN": the world's port, for the party tunnel
        const lan = /Started serving on (\d{2,5})/.exec(line);
        if (lan) {
          s.lanPort = Number(lan[1]);
          emit('lan', { ...publicSession(s), port: s.lanPort });
        }
        const bridge = require('./party-bridge-protocol').parse(line);
        if (bridge) emit(bridge.type, { ...publicSession(s), ...bridge });
      }
    });
    stream.on('end', () => {
      if (rest) log.game(rest, isErr);
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);

  const statsTimer = setInterval(() => sample(s), 2000);
  child.on('close', async (code) => {
    clearInterval(statsTimer);
    running.delete(child.pid);
    require('./nearby').stop(child.pid);
    if (skins) skins.release();
    const playedMs = Date.now() - startedAt;
    const crashed = code !== 0 && !s.killed;
    const crashReport = crashed ? await findCrashReport(spec.gameDir, startedAt) : '';
    // the JVM itself didn't start: a damaged Java (checked and repaired on
    // the next start) or one too old for this version
    const jvmLine = crashed && playedMs < 15000 ? (s.lastErr || []).find((l) => JAVA_BOOT.test(l)) : '';
    if (jvmLine) log.error(`Java didn't start: ${jvmLine.trim()}`);
    log[crashed ? 'error' : 'info'](
      `Game exited with code ${code} after ${Math.round(playedMs / 1000)} s${crashed ? ' — crash' : ''}${crashReport ? ` (${crashReport})` : ''}.`,
    );
    emit('exited', { ...publicSession(s), code, crashed, crashReport, playedMs, javaFailed: !!jvmLine });
  });
  return publicSession(s);
}

const cpuThreads = require('os').availableParallelism ? require('os').availableParallelism() : require('os').cpus().length;

function sample(s) {
  const st = native.processStats(s.pid);
  if (!st) return;
  const now = Date.now();
  let cpu = null;
  if (s.lastCpu && st.cpuMs != null) {
    const threads = cpuThreads || 1;
    cpu = Math.max(0, Math.min(100, ((st.cpuMs - s.lastCpu.ms) / (now - s.lastCpu.t) / threads) * 100));
  }
  if (st.cpuMs != null) s.lastCpu = { ms: st.cpuMs, t: now };
  s.stats = { memMB: Math.round(st.workingSetMB || 0), privateMB: Math.round(st.privateMB || 0), cpu: cpu == null ? null : Math.round(cpu * 10) / 10 };
  emit('stats', { pid: s.pid, installId: s.installId, ...s.stats });
}

function publicSession(s) {
  return { pid: s.pid, installId: s.installId, installName: s.installName, startedAt: s.startedAt, ready: s.ready, stats: s.stats, mcVersion: s.mcVersion, loader: s.loader, server: s.server };
}

function kill(pid) {
  const s = running.get(pid);
  if (!s) return false;
  s.killed = true;
  s.child.kill();
  log.warn(`Game process ${pid} terminated from the launcher.`);
  return true;
}

module.exports = {
  connectToServer(installId, server) {
    const s = [...running.values()].find(s => s.installId === installId);
    if (!s?.partyControl?.connect(server)) throw new Error('Для автоматического входа перезапустите Minecraft через обновлённый лаунчер.');
    return true;
  },
  launch,
  kill,
  maybeArgFile, // for the tests
  list: () => [...running.values()].map(publicSession),
  isRunning: (installId) => [...running.values()].some((s) => s.installId === installId),
  onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
