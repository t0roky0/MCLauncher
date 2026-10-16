// Builds the C++ addon (native/) with cmake-js + MSVC.
//
// Node-API mode (native/package.json declares napi_versions), so nothing is
// downloaded: headers and the node.lib .def come from node-api-headers, and
// the resulting mcnative.node loads in Electron as-is.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cmakeJs = join(root, 'node_modules', 'cmake-js', 'bin', 'cmake-js');
const out = join(root, 'native', 'build', 'Release', 'mcnative.node');

const args = [
  cmakeJs, 'compile',
  '--directory', join(root, 'native'),
  '--out', join(root, 'native', 'build'),
  '--config', 'Release',
  '--arch', 'x64',
  '--log-level', 'warn',
];

const res = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
if (res.status !== 0 || !existsSync(out)) {
  console.error('\n[build-native] failed — the launcher still runs, using its JS fallbacks.');
  process.exit(res.status || 1);
}
console.log(`[build-native] ${out} (${Math.round(statSync(out).size / 1024)} KB)`);
