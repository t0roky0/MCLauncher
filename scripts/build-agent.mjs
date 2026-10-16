// Builds the skin agent (agent/src → assets/agent/mcl-skins.jar).
//
// Java 8 bytecode, so the same jar loads into every game version's JVM
// (1.8 on Java 8 … 26.x on Java 25). Needs a JDK 9+ for --release 8:
// JAVA_HOME, javac on PATH, or the usual install folders. The built jar is
// kept in the repo, so the launcher builds without a JDK too.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'agent', 'src');
const classes = join(root, 'agent', 'build');
const out = join(root, 'assets', 'agent', 'mcl-skins.jar');

function findJdk() {
  const homes = [process.env.JAVA_HOME, process.env.JDK_HOME].filter(Boolean);
  for (const base of ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft']) {
    try {
      for (const d of readdirSync(base)) if (/^jdk/i.test(d)) homes.push(join(base, d));
    } catch { /* not there */ }
  }
  for (const h of homes) if (existsSync(join(h, 'bin', 'javac.exe'))) return join(h, 'bin');
  return '';
}

const bin = findJdk();
const tool = (name) => (bin ? join(bin, `${name}.exe`) : name);
const sources = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.java')) sources.push(p);
  }
})(src);

rmSync(classes, { recursive: true, force: true });
mkdirSync(classes, { recursive: true });
mkdirSync(dirname(out), { recursive: true });

let r = spawnSync(tool('javac'), ['--release', '8', '-encoding', 'UTF-8', '-Xlint:-options', '-d', classes, ...sources], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('[build-agent] javac failed');
  process.exit(1);
}
const manifest = join(classes, 'MANIFEST.MF');
const { writeFileSync } = await import('node:fs');
writeFileSync(manifest, 'Manifest-Version: 1.0\r\nPremain-Class: mclauncher.agent.SkinAgent\r\nCreated-By: MC Launcher\r\n\r\n');
rmSync(out, { force: true });
r = spawnSync(tool('jar'), ['--create', '--file', out, '--manifest', manifest, '-C', classes, 'mclauncher'], { stdio: 'inherit' });
if (r.status !== 0 || !existsSync(out)) {
  console.error('[build-agent] jar failed');
  process.exit(1);
}
rmSync(classes, { recursive: true, force: true });
console.log(`[build-agent] ${out} (${Math.round(statSync(out).size / 1024)} KB)`);
