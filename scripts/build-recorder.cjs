'use strict';
// Builds the game recorder (recorder-native → assets/recorder/mcl-recorder.exe):
// GPU screen capture + hardware H.264 + system sound/microphone, see recorder.cpp.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..'), build = path.join(root, 'recorder-native', 'build');
// Windows environments can contain both PATH and Path. MSBuild rejects duplicates.
const env = {};
for (const [key, value] of Object.entries(process.env)) { const prior = Object.keys(env).find((k) => k.toLowerCase() === key.toLowerCase()); env[prior || key] = value; }
function run(args) { const r = spawnSync('cmake', args, { env, stdio: 'inherit', windowsHide: true }); if (r.error) throw r.error; if (r.status) process.exit(r.status); }
run(['-S', path.join(root, 'recorder-native'), '-B', build, '-G', 'Visual Studio 17 2022', '-A', 'x64']);
run(['--build', build, '--config', 'Release']);
const target = path.join(root, 'assets', 'recorder');
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(path.join(build, 'Release', 'mcl-recorder.exe'), path.join(target, 'mcl-recorder.exe'));
console.log(`[build-recorder] ${path.join(target, 'mcl-recorder.exe')} (${Math.round(fs.statSync(path.join(target, 'mcl-recorder.exe')).size / 1024)} KB)`);
