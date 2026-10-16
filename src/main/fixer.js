'use strict';
// The fixer (the bug by the console): what keeps the game from starting,
// found and — where we can — put right with one click.
//
// Java (an installation): its last crash — the crash report, else the end of
// latest.log — and what it points at: Fabric's "Suspected Mods", the mod of a
// mixin that failed, a mod set Fabric/Quilt won't load (a mod missing what it
// needs, two that can't go together), out of memory, a broken file; and, crash
// or not, its mods folder: mods made for another Minecraft version or another
// loader, the same mod twice. A mod is turned off by renaming name.jar →
// name.jar.disabled (shown again, to turn back on).
//
// Bedrock: a game stuck without a window, its last crashes (Windows' own
// log, our module's bedrock-crash.log) and whose they were — the launcher's
// module gets turned off for the next starts (config.bedrockSafe), a graphics
// driver gets named — Gaming Services, the game itself installed.
//
// A problem: { id, title, detail, fix: { kind, … } | null, fixLabel }.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');
const config = require('./config');
const paths = require('./paths');
const log = require('./log');

const run = (file, args, timeout = 15000) => new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (e, out) => resolve(String(out || ''))));
const tail = (file, bytes) => {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const n = Math.min(bytes, st.size);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, st.size - n);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
};
const newest = (dir, re) => {
  try {
    return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0] || null;
  } catch {
    return null;
  }
};
const when = (ms) => new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// ---- Java: the mods folder -----------------------------------------------------------------------

// What a jar says it is: its mod ids, name, version, the Minecraft it wants, its loader, its mixin configs.
function modInfo(file) {
  const out = { file, ids: [], name: path.basename(file), version: '', minecraft: null, loader: '', mixins: [] };
  let zip;
  try {
    zip = new AdmZip(file);
  } catch {
    out.broken = true;
    return out;
  }
  const text = (n) => {
    const e = zip.getEntry(n);
    return e ? e.getData().toString('utf8').replace(/^﻿/, '') : null;
  };
  try {
    const fabric = text('fabric.mod.json');
    const quilt = text('quilt.mod.json');
    if (fabric) {
      const j = JSON.parse(fabric.replace(/[\u0000-\u001f]+/g, ' '));
      out.loader = 'fabric';
      out.ids.push(String(j.id || ''));
      for (const p of j.provides || []) out.ids.push(String(typeof p === 'string' ? p : p.id || ''));
      out.name = j.name || j.id || out.name;
      out.version = String(j.version || '');
      out.minecraft = j.depends && j.depends.minecraft !== undefined ? j.depends.minecraft : null;
      out.mixins = (j.mixins || []).map((m) => (typeof m === 'string' ? m : m && m.config) || '').filter(Boolean);
    } else if (quilt) {
      const j = JSON.parse(quilt.replace(/[\u0000-\u001f]+/g, ' '));
      const q = j.quilt_loader || {};
      out.loader = 'quilt';
      out.ids.push(String(q.id || ''));
      out.name = (q.metadata && q.metadata.name) || q.id || out.name;
      out.version = String(q.version || '');
      const mc = (q.depends || []).find((d) => d && (d === 'minecraft' || d.id === 'minecraft'));
      out.minecraft = mc && mc.versions !== undefined ? mc.versions : null;
      out.mixins = [].concat(j.mixin || []).filter(Boolean);
    } else {
      const toml = text('META-INF/neoforge.mods.toml') || text('META-INF/mods.toml');
      if (toml) {
        out.loader = text('META-INF/neoforge.mods.toml') ? 'neoforge' : 'forge';
        for (const m of toml.matchAll(/modId\s*=\s*"([^"]+)"/g)) out.ids.push(m[1]);
        const dn = /displayName\s*=\s*"([^"]+)"/.exec(toml);
        if (dn) out.name = dn[1];
      }
    }
  } catch {
    /* a jar without readable metadata: a library, most likely */
  }
  out.ids = out.ids.filter((x) => /^[a-z0-9_\-.]{2,64}$/i.test(x));
  return out;
}

// Does a version fit a Fabric/Quilt range ("1.21.4", ">=1.21 <1.22", "~1.21.4", "1.21.x", ["…", "…"])?
// Unknown forms: yes (we don't turn a mod off on a guess).
function fits(version, range) {
  if (range == null || range === '*' || range === '') return true;
  if (Array.isArray(range)) return range.length === 0 || range.some((r) => fits(version, r));
  if (typeof range !== 'string') return true;
  const num = (v) => String(v).split('-')[0].split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
  const v = num(version);
  if (v.some(Number.isNaN)) return true;
  const cmp = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return Math.sign(d);
    }
    return 0;
  };
  return range.split(/\|\|/).some((alt) => alt.trim().split(/\s+/).every((part) => {
    const m = /^(>=|<=|>|<|=|~|\^)?\s*([0-9][0-9a-z.\-+]*|\*)$/i.exec(part.trim());
    if (!m) return true;
    const [, op = '=', raw] = m;
    if (raw === '*') return true;
    if (/\.[x*](\.|$)/i.test(raw)) {
      const fixed = raw.split('.').filter((x) => !/^[x*]$/i.test(x));
      return cmp(v.slice(0, fixed.length), num(fixed.join('.'))) === 0;
    }
    const r = num(raw);
    if (r.some(Number.isNaN)) return true;
    const c = cmp(v, r);
    if (op === '>=') return c >= 0;
    if (op === '<=') return c <= 0;
    if (op === '>') return c > 0;
    if (op === '<') return c < 0;
    if (op === '~') return c >= 0 && cmp(v.slice(0, 2), r.slice(0, 2)) === 0;
    if (op === '^') return c >= 0 && v[0] === r[0];
    // an exact version: a short one ("1.21") means that line, a full one that release
    return r.length < v.length && r.length <= 2 ? cmp(v.slice(0, r.length), r) === 0 : c === 0;
  }));
}

function modsOf(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /\.jar$/i.test(f)).map((f) => modInfo(path.join(dir, f)));
  } catch {
    return [];
  }
}
function disabledOf(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /\.jar\.disabled$/i.test(f));
  } catch {
    return [];
  }
}

// ---- Java: the last crash ---------------------------------------------------------------------

// From a crash's text: the mod ids it points at, and why.
function suspects(text) {
  const out = new Map(); // id → why
  const add = (id, why) => { if (id && !out.has(id.toLowerCase())) out.set(id.toLowerCase(), why); };
  // Fabric's crash report: "Suspected Mod(s):" then "\tName (modid), Version: …"
  const sus = /Suspected Mods?:\s*\n([\s\S]*?)(?:\n\s*\n|\nStacktrace|\n--)/i.exec(text);
  if (sus) for (const m of sus[1].matchAll(/\(([a-z0-9_\-.]+)\)/gi)) add(m[1], 'crash');
  for (const m of text.matchAll(/Mixin apply for mod ([a-z0-9_\-.]+) failed/gi)) add(m[1], 'mixin');
  for (const m of text.matchAll(/from mod ([a-z0-9_\-.]+)\]/gi)) add(m[1], 'mixin');
  for (const m of text.matchAll(/Mod '([^']+)' \(([a-z0-9_\-.]+)\)[^\n]*?(?:requires|depends on|is incompatible|breaks)/gi)) add(m[2], 'set');
  return out;
}

const MIXIN_CONFIG = /([A-Za-z0-9_\-.]+)\.mixins?\.json/g;

async function scanJava(installId) {
  const installs = require('./installs');
  // the one asked for, else the one picked by "Play", else the Java one played last
  let id = installId || config.get().selectedInstall;
  if (!id || id === 'bedrock' || !installs.entryById(id)) {
    const last = installs.allEntries().filter((e) => e.id !== 'bedrock').sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))[0];
    id = last ? last.id : '';
  }
  const entry = installs.entryById(id);
  if (!entry || id === 'bedrock') return { edition: 'java', install: null, problems: [], note: 'noinstall' };
  const dir = config.dirs.instance(id);
  const modsDir = path.join(dir, 'mods');
  const problems = [];
  const mods = modsOf(modsDir);
  const byId = new Map();
  for (const m of mods) for (const mid of m.ids) if (!byId.has(mid.toLowerCase())) byId.set(mid.toLowerCase(), m);
  const off = (m, why) => ({ kind: 'disableMod', install: id, file: path.basename(m.file), why });

  // the last crash
  const report = newest(path.join(dir, 'crash-reports'), /^crash-.*\.txt$/i);
  const latest = path.join(dir, 'logs', 'latest.log');
  let latestAt = 0;
  try { latestAt = fs.statSync(latest).mtimeMs; } catch { /* never started */ }
  const crashText = report ? tail(report.f, 400000) : '';
  const logText = tail(latest, 600000);
  const text = `${crashText}\n${logText}`;
  const crashAt = report ? report.t : 0;
  if (report) problems.push({ id: 'crash', title: `Последний вылет: ${when(crashAt)}`, detail: path.basename(report.f), fix: { kind: 'open', file: report.f }, fixLabel: 'Открыть отчёт' });

  // the mods it names
  const named = suspects(text);
  for (const m of text.matchAll(MIXIN_CONFIG)) {
    const cfgName = `${m[1]}.mixins.json`;
    if (!/(failed|error|exception|crash)/i.test(text.slice(Math.max(0, m.index - 300), m.index + 300))) continue;
    const owner = mods.find((x) => x.mixins.some((c) => c.toLowerCase() === cfgName.toLowerCase() || c.toLowerCase() === `${m[1]}.mixin.json`.toLowerCase()));
    if (owner && owner.ids[0]) if (!named.has(owner.ids[0].toLowerCase())) named.set(owner.ids[0].toLowerCase(), 'mixin');
  }
  const seen = new Set();
  for (const [mid, why] of named) {
    const m = byId.get(mid);
    if (!m || ['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'forge', 'neoforge'].includes(mid) || seen.has(m.file)) continue;
    seen.add(m.file);
    problems.push({
      id: `mod:${path.basename(m.file)}`,
      title: `Мод «${m.name}» ломает запуск`,
      detail: why === 'set' ? 'Fabric не может загрузить набор модов: этому моду чего-то не хватает или он конфликтует с другим.'
        : why === 'mixin' ? 'Его изменения кода игры не встали (mixin) — обычно мод не для этой версии или конфликтует с другим.'
        : 'Отчёт о вылете называет его подозреваемым.',
      fix: off(m, why), fixLabel: 'Выключить мод',
    });
  }
  // a mod the set needs and nobody has: what to get
  for (const m of text.matchAll(/requires (?:version [^\n]*? of|any version of) (?:mod )?'([^']+)' \(([a-z0-9_\-.]+)\)[^\n]*?(?:which is missing|is missing)/gi)) {
    if (byId.has(m[2].toLowerCase())) continue;
    problems.push({ id: `need:${m[2]}`, title: `Не хватает мода «${m[1]}»`, detail: 'Его требует другой мод. Скачайте его для этой версии или выключите мод, которому он нужен.', fix: { kind: 'url', url: `https://modrinth.com/mods?q=${encodeURIComponent(m[1])}` }, fixLabel: 'Найти на Modrinth' });
  }
  if (/java\.lang\.OutOfMemoryError|Could not reserve enough space for object heap/i.test(text)) {
    const ram = Number(entry.ramMb) || Number(config.get().ramMb) || 2048;
    problems.push({ id: 'ram', title: 'Игре не хватило памяти', detail: `Сейчас ей дано ${Math.round(ram / 1024 * 10) / 10} ГБ.`, fix: { kind: 'ram', install: id, mb: Math.min(16384, ram + 2048) }, fixLabel: `Дать ${Math.round((ram + 2048) / 1024)} ГБ` });
  }
  if (/ZipException|invalid LOC header|error in opening zip file|zip END header not found|Invalid or corrupt jarfile|Failed to download|checksum/i.test(text)) {
    problems.push({ id: 'files', title: 'Повреждены файлы игры', detail: 'Лаунчер перепроверит библиотеки, ресурсы и версию и скачает заново испорченное.', fix: { kind: 'verify', install: id }, fixLabel: 'Проверить файлы' });
  }
  if (/UnsupportedClassVersionError|has been compiled by a more recent version of the Java Runtime/i.test(text)) {
    problems.push({ id: 'javaver', title: 'Мод или игра под другую версию Java', detail: 'Лаунчер подбирает Java сам: проверка файлов поставит нужную. Если не поможет — один из модов собран под более новую Java (для другой версии игры).', fix: { kind: 'verify', install: id }, fixLabel: 'Проверить файлы' });
  }
  // a crash in a graphics driver (the JVM's own crash log)
  const hs = newest(dir, /^hs_err_pid\d+\.log$/i);
  if (hs && hs.t > Date.now() - 7 * 864e5) {
    const h = tail(hs.f, 200000);
    const frame = /# C\s+\[([^\]+]+)/.exec(h) || /Problematic frame:\s*\n#\s*C\s+\[([^\]+]+)/.exec(h);
    const lib = frame ? frame[1] : '';
    const driver = /nvoglv|atio6|atioglxx|ig[0-9a-z]*icd|amdxx|nvwgf/i.test(lib);
    problems.push({ id: 'native', title: driver ? 'Вылет в драйвере видеокарты' : 'Вылет внутри Java', detail: driver ? `${lib}: обновите драйвер видеокарты с сайта NVIDIA / AMD / Intel; если вылет с шейдерами — попробуйте без них.` : `${lib || 'см. отчёт'} (${when(hs.t)}).`, fix: { kind: 'open', file: hs.f }, fixLabel: 'Открыть отчёт' });
  }

  // the mods folder, crash or not
  if (entry.loader && entry.loader !== 'vanilla') {
    const want = String(entry.loader).toLowerCase();
    const groups = new Map();
    for (const m of mods) {
      if (m.broken) {
        problems.push({ id: `broken:${path.basename(m.file)}`, title: `Файл мода повреждён: ${path.basename(m.file)}`, detail: 'Его не открыть как архив — скачайте мод заново.', fix: off(m, 'broken'), fixLabel: 'Выключить мод' });
        continue;
      }
      if (!m.loader) continue;
      const okLoader = m.loader === want || (want === 'quilt' && m.loader === 'fabric');
      if (!okLoader) {
        problems.push({ id: `loader:${path.basename(m.file)}`, title: `«${m.name}» — мод для ${m.loader === 'neoforge' ? 'NeoForge' : m.loader === 'forge' ? 'Forge' : m.loader === 'quilt' ? 'Quilt' : 'Fabric'}`, detail: `А установка — на ${entry.loader}. Такой мод здесь не запустится.`, fix: off(m, 'loader'), fixLabel: 'Выключить мод' });
        continue;
      }
      if (m.minecraft != null && !fits(entry.mcVersion, m.minecraft)) {
        problems.push({ id: `version:${path.basename(m.file)}`, title: `«${m.name}» не для ${entry.mcVersion}`, detail: `Мод просит Minecraft ${Array.isArray(m.minecraft) ? m.minecraft.join(' или ') : m.minecraft}.`, fix: off(m, 'version'), fixLabel: 'Выключить мод' });
      }
      const key = (m.ids[0] || '').toLowerCase();
      if (key) groups.set(key, [...(groups.get(key) || []), m]);
    }
    for (const [, list] of groups) {
      if (list.length < 2) continue;
      // the same mod twice: the older file off
      const sorted = list.map((m) => ({ m, t: fs.statSync(m.file).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const { m } of sorted.slice(1)) problems.push({ id: `dup:${path.basename(m.file)}`, title: `«${m.name}» лежит дважды`, detail: `Оставим новый файл ${path.basename(sorted[0].m.file)}, этот выключим.`, fix: off(m, 'duplicate'), fixLabel: 'Выключить старый' });
    }
  }
  const disabled = disabledOf(modsDir).map((f) => ({ file: f, name: f.replace(/\.disabled$/i, '') }));
  return { edition: 'java', install: { id, name: entry.name, mcVersion: entry.mcVersion, loader: entry.loader }, problems, disabled, lastRun: latestAt || 0 };
}

// ---- Bedrock ----------------------------------------------------------------------------------

async function scanBedrock() {
  const bedrock = require('./bedrock');
  const problems = [];
  let info = null;
  try { info = await bedrock.detect(true); } catch { /* none */ }
  if (!info || !info.installed) {
    problems.push({ id: 'missing', title: 'Minecraft Bedrock не установлен', detail: 'Установите «Minecraft for Windows» из Microsoft Store или приложения Xbox.', fix: { kind: 'url', url: 'ms-windows-store://pdp/?productid=9NBLGGH2JHXJ' }, fixLabel: 'Открыть Store' });
  }
  // a game that's there but has no window: stuck
  const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-Process Minecraft.Windows -ErrorAction SilentlyContinue | ForEach-Object { '{0}|{1}|{2}' -f $_.Id, $_.MainWindowHandle, [int]((Get-Date) - $_.StartTime).TotalSeconds }"]);
  for (const line of ps.split(/\r?\n/).filter(Boolean)) {
    const [pid, hwnd, age] = line.trim().split('|').map(Number);
    if (pid > 0 && !hwnd && age > 45) problems.push({ id: `stuck:${pid}`, title: 'Игра зависла без окна', detail: `Minecraft.Windows.exe (PID ${pid}) работает уже ${age} с, но окна нет — новый запуск из-за неё не начнётся.`, fix: { kind: 'kill', pid }, fixLabel: 'Закрыть зависшую' });
  }
  // its crashes, Windows' own log (the last 3 days)
  const ev = await run('wevtutil.exe', ['qe', 'Application', '/q:*[System[Provider[@Name="Application Error"] and (EventID=1000) and TimeCreated[timediff(@SystemTime) <= 259200000]]]', '/c:30', '/rd:true', '/f:text']);
  const crashes = ev.split(/Event\[\d+\]/).filter((e) => /Minecraft\.Windows\.exe/i.test(e));
  const ourCrash = crashes.some((e) => /mcl-bedrock\.dll/i.test(e));
  const ourLog = tail(path.join(paths.appDir, 'logs', 'bedrock-crash.log'), 20000);
  const ours = ourCrash || /mcl-bedrock/i.test(ourLog.split(/\r?\n/).slice(-15).join('\n'));
  if (crashes.length) {
    const first = crashes[0];
    const mod = (/(?:Faulting module name|Имя сбойного модуля|модуля с ошибкой):\s*([^\s,]+)/i.exec(first) || [])[1] || '';
    const at = (/Date:\s*(\S+)/.exec(first) || [])[1] || '';
    const driver = /nvwgf2um|nvd3dum|atiumd|amdxc|igd|aticfx/i.test(mod);
    problems.push({ id: 'crashes', title: `Bedrock вылетал: ${crashes.length} раз за 3 дня`, detail: `Последний ${at ? at.replace('T', ' ').slice(0, 16) : ''}${mod ? ` — в ${mod}` : ''}.${driver ? ' Это драйвер видеокарты: обновите его с сайта производителя.' : ''}`, fix: null });
  }
  const safe = !!config.get().bedrockSafe;
  if (ours && !safe) {
    problems.push({ id: 'module', title: 'Вылет связан с модулем лаунчера', detail: 'Выключим модуль лаунчера в Bedrock на следующих запусках: игра пойдёт как есть, без зума, косметики, голоса по расстоянию и настроек оверлея. Включить обратно — здесь же.', fix: { kind: 'bedrockSafe', on: true }, fixLabel: 'Выключить модуль' });
  }
  if (safe) problems.push({ id: 'safe', title: 'Модуль лаунчера в Bedrock выключен', detail: 'Bedrock запускается без зума, косметики и голоса по расстоянию.', fix: { kind: 'bedrockSafe', on: false }, fixLabel: 'Включить обратно' });
  // Gaming Services: the Store version of the game won't start without it
  const sc = await run('sc.exe', ['query', 'GamingServices']);
  if (/FAILED 1060|1060/.test(sc) || !sc.trim()) {
    problems.push({ id: 'gs', title: 'Нет службы Gaming Services', detail: 'Без неё игры из Store и Xbox не запускаются. Установите её из Microsoft Store (бесплатно).', fix: { kind: 'url', url: 'ms-windows-store://pdp/?productid=9MWPM2CQNLHN' }, fixLabel: 'Открыть Store' });
  } else if (!/RUNNING/i.test(sc)) {
    problems.push({ id: 'gs-stopped', title: 'Служба Gaming Services остановлена', detail: 'Обычно она запускается сама с игрой. Если Bedrock не стартует — переустановите Gaming Services из Store или перезагрузите ПК.', fix: { kind: 'url', url: 'ms-windows-store://pdp/?productid=9MWPM2CQNLHN' }, fixLabel: 'Открыть Store' });
  }
  return { edition: 'bedrock', problems, version: info && info.version ? info.version : '' };
}

// ---- fixes --------------------------------------------------------------------------------------

async function fix(f) {
  if (!f || typeof f !== 'object') throw new Error('Нечего чинить.');
  const { shell } = require('electron');
  switch (f.kind) {
    case 'disableMod':
    case 'enableMod': {
      const installs = require('./installs');
      if (!installs.entryById(f.install)) throw new Error('Установка не найдена.');
      const dir = path.join(config.dirs.instance(f.install), 'mods');
      const name = path.basename(String(f.file || ''));
      const from = path.join(dir, name);
      const enable = f.kind === 'enableMod';
      if (enable ? !/\.jar\.disabled$/i.test(name) : !/\.jar$/i.test(name)) throw new Error('Это не мод.');
      const to = enable ? from.replace(/\.disabled$/i, '') : `${from}.disabled`;
      fs.renameSync(from, to);
      log.info(`Fixer: ${enable ? 'turned on' : 'turned off'} ${name} (${f.why || 'by hand'}).`);
      return { done: enable ? 'Мод снова включён.' : 'Мод выключен. Запустите игру ещё раз.' };
    }
    case 'ram': {
      require('./installs').update(f.install, { ramMb: Math.max(1024, Math.min(16384, Number(f.mb) || 4096)) });
      return { done: 'Памяти дано больше. Запустите игру ещё раз.' };
    }
    case 'verify': {
      require('./installs').start(f.install, { repair: true, launch: false });
      return { done: 'Проверка файлов началась — ход на главной.' };
    }
    case 'kill': {
      const pid = Number(f.pid);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Нет такой игры.');
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'Minecraft.Windows') { Stop-Process -Id ${pid} -Force; 'ok' }`]);
      if (!/ok/.test(out)) throw new Error('Не получилось закрыть игру.');
      return { done: 'Зависшая игра закрыта. Запускайте.' };
    }
    case 'bedrockSafe': {
      config.mutate((c) => { c.bedrockSafe = !!f.on; });
      const bridge = require('./bedrock-bridge');
      if (f.on) bridge.stop(); else bridge.start();
      return { done: f.on ? 'Модуль выключен: Bedrock запускается как есть.' : 'Модуль снова включён (со следующего запуска игры).' };
    }
    case 'open': {
      const file = String(f.file || '');
      if (!fs.existsSync(file)) throw new Error('Файла уже нет.');
      shell.showItemInFolder(file);
      return { done: '' };
    }
    case 'url': {
      const url = String(f.url || '');
      if (!/^(https:\/\/modrinth\.com\/|ms-windows-store:\/\/pdp\/\?productid=[0-9A-Z]+$)/.test(url)) throw new Error('Ссылка не наша.');
      await shell.openExternal(url);
      return { done: '' };
    }
    default:
      throw new Error('Так чинить не умеем.');
  }
}

async function scan(edition, installId) {
  return edition === 'bedrock' ? scanBedrock() : scanJava(installId);
}

module.exports = { scan, fix, _test: { fits, suspects, modInfo } };
