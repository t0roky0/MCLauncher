// Bundles the renderer (src/renderer) into dist/ with esbuild.
//   node scripts/build-ui.mjs           dev build (sourcemaps)
//   node scripts/build-ui.mjs --prod    minified, no maps
//   node scripts/build-ui.mjs --watch   rebuild on change
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'renderer');
const out = join(root, 'dist');
// Keep the offline audio processor in sync with the pinned dependency.
const audio = join(root, 'assets', 'audio');
mkdirSync(audio, { recursive: true });
const noise = join(root, 'node_modules', '@sapphi-red', 'web-noise-suppressor');
for (const [from, to] of [['dist/rnnoise/workletProcessor.js', 'rnnoise-worklet.js'], ['dist/rnnoise.wasm', 'rnnoise.wasm'], ['dist/rnnoise_simd.wasm', 'rnnoise_simd.wasm'], ['LICENSE', 'LICENSE-web-noise-suppressor']]) cpSync(join(noise, from), join(audio, to));
const prod = process.argv.includes('--prod');
const watch = process.argv.includes('--watch');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'console.html', 'overlay.html']) cpSync(join(src, f), join(out, f));

const options = {
  entryPoints: {
    app: join(src, 'js', 'main.js'),
    console: join(src, 'js', 'console.js'),
    overlay: join(src, 'js', 'overlay.js'),
    'app-style': join(src, 'css', 'app.css'),
    'console-style': join(src, 'css', 'console.css'),
    'overlay-style': join(src, 'css', 'overlay.css'),
  },
  bundle: true,
  outdir: out,
  format: 'iife',
  target: ['chrome140'],
  minify: prod,
  sourcemap: prod ? false : 'linked',
  legalComments: 'none',
  external: ['mcl://*'],
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': prod ? '"production"' : '"development"' },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[build-ui] watching…');
} else {
  await esbuild.build(options);
}
