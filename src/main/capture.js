'use strict';
// Video of the game: a recording (start/stop) and an instant replay (the
// last N seconds kept all the time, saved on a key) — both by mcl-recorder
// (recorder-native: GPU capture of the game's part of the screen, hardware
// H.264, the computer's sound, our voice while we talk in voice chat).
//
// The overlay decides when; here: the recorder processes, their files and
// what they say back.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('./config');
const paths = require('./paths');
const log = require('./log');

const BITRATE = { normal: 8000000, high: 16000000, max: 30000000 };
const listeners = new Set();
let exe = '';
let recording = null; // { proc, pid, started, file }
let replay = null; // { proc, pid, started, ready }
let micOpen = false;

const settings = () => config.get().overlay || {};
const emit = (type, payload) => { for (const fn of listeners) { try { fn(type, payload); } catch { /* a listener's problem */ } } };

// The recorder can't run from inside app.asar: a copy next to the launcher's
// data, named by its content (a new build gets a new file).
function recorderExe() {
  if (exe && fs.existsSync(exe)) return exe;
  const bytes = fs.readFileSync(paths.asset('recorder', 'mcl-recorder.exe'));
  const sha = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const file = path.join(paths.appDir, 'recorder', `mcl-recorder-${sha}.exe`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  exe = file;
  return file;
}

function videosDir() {
  const dir = path.join(app.getPath('videos'), 'MC Launcher');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
};

function options() {
  const s = settings();
  return { fps: s.fps === 30 ? 30 : 60, bitrate: BITRATE[s.quality] || BITRATE.high, audio: s.recordAudio !== false, mic: !!s.recordMic };
}

function launch(command, onEvent) {
  const proc = spawn(recorderExe(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let rest = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line));
      } catch { /* not ours */ }
    }
  });
  proc.stdin.on('error', () => {});
  proc.send = (o) => {
    try {
      proc.stdin.write(`${JSON.stringify(o)}\n`);
    } catch { /* gone */ }
  };
  proc.send(command);
  if (micOpen) proc.send({ cmd: 'mic', open: true });
  return proc;
}

// ---- recording ---------------------------------------------------------------------------------

function startRecording(pid) {
  if (recording || !pid) return false;
  const file = path.join(videosDir(), `${stamp()}.mp4`);
  const r = { pid, file, started: Date.now(), proc: null };
  r.proc = launch({ cmd: 'start', mode: 'record', file, pid, ...options() }, (ev) => {
    if (ev.ev === 'started') {
      r.started = Date.now();
      emit('changed');
    } else if (ev.ev === 'error') {
      log.warn(`Recording: ${ev.msg}`);
      emit('error', { what: 'record', message: ev.msg });
    } else if (ev.ev === 'stopped') {
      log.info(`Video: ${file} (${Math.round(ev.seconds)} s)`);
      emit('saved', { what: 'record', file, seconds: ev.seconds });
    }
  });
  r.proc.on('exit', () => {
    if (recording === r) recording = null;
    emit('changed');
  });
  recording = r;
  emit('changed');
  return true;
}

function stopRecording() {
  if (!recording) return false;
  recording.proc.send({ cmd: 'stop' });
  return true;
}

// ---- instant replay: on while a game runs and it's switched on -----------------------------------

function startReplay(pid) {
  if (replay?.pid === pid) return;
  stopReplay();
  const dir = path.join(app.getPath('temp'), `mcl-replay-${process.pid}-${pid}`);
  const r = { pid, dir, started: Date.now(), ready: false, proc: null, seconds: settings().replaySeconds || 60 };
  r.proc = launch({ cmd: 'start', mode: 'replay', dir, pid, seconds: r.seconds, ...options() }, (ev) => {
    if (ev.ev === 'started') {
      r.ready = true;
      r.started = Date.now();
      log.info(`Instant replay on: last ${r.seconds} s, ${ev.width}x${ev.height}.`);
      emit('changed');
    } else if (ev.ev === 'saved') {
      emit('saved', { what: 'replay', file: r.saving, seconds: ev.seconds });
      log.info(`Replay: ${r.saving} (${Math.round(ev.seconds)} s)`);
      r.saving = '';
    } else if (ev.ev === 'error') {
      log.warn(`Instant replay: ${ev.msg}`);
      if (r.saving) emit('error', { what: 'replay', message: ev.msg });
      r.saving = '';
    }
  });
  r.proc.on('exit', () => {
    if (replay === r) replay = null;
    fs.rm(dir, { recursive: true, force: true }, () => {});
    emit('changed');
  });
  replay = r;
  emit('changed');
}

function stopReplay() {
  const r = replay;
  if (!r) return;
  replay = null;
  r.proc.send({ cmd: 'stop' });
  setTimeout(() => { try { r.proc.kill(); } catch { /* gone */ } }, 8000).unref();
  emit('changed');
}

function saveReplay() {
  if (!replay?.ready || replay.saving) return false;
  replay.saving = path.join(videosDir(), `Replay_${stamp()}.mp4`);
  replay.proc.send({ cmd: 'save', file: replay.saving, seconds: replay.seconds });
  return true;
}

// The game the replay follows: started when one is in front, stopped when
// that process is gone, the replay switched off or its settings changed.
let replayKey = '';
function watchGame(pid) {
  const s = settings();
  const want = s.enabled !== false && !!s.replay;
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  if (replay && (!want || !alive(replay.pid))) stopReplay();
  if (!want) return;
  const key = JSON.stringify([options(), s.replaySeconds]);
  if (replay && key !== replayKey) stopReplay(); // new quality / length: start over
  replayKey = key;
  if (!replay && pid) startReplay(pid);
}

// Our voice goes into videos while we talk (the voice chat's gate, not muted).
function setMic(open) {
  open = !!open;
  if (open === micOpen) return;
  micOpen = open;
  for (const r of [recording, replay]) r?.proc.send({ cmd: 'mic', open });
}

app.once('before-quit', () => {
  stopRecording();
  stopReplay();
});

module.exports = {
  startRecording,
  stopRecording,
  saveReplay,
  watchGame,
  setMic,
  videosDir,
  state: () => ({
    recording: recording ? { since: recording.started } : null,
    replay: replay ? { ready: replay.ready, seconds: replay.seconds, saving: !!replay.saving } : null,
  }),
  onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
