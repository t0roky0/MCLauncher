'use strict';
// Version lists: Mojang's manifest and the mod loaders' own metadata.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('./net');
const config = require('./config');
const log = require('./log');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const NEOFORGE_VERSIONS = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

let manifest = null;
let fetchedAt = 0;

const cachePath = () => path.join(config.dirs.game(), 'version_manifest_v2.json');

function cachedManifest() {
  if (manifest) return manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  } catch {
    manifest = null;
  }
  return manifest;
}

async function fetchManifest(force = false) {
  if (manifest && fetchedAt && !force && Date.now() - fetchedAt < 10 * 60 * 1000) return manifest;
  try {
    const data = await net.getJson(MANIFEST_URL, { retries: 2 });
    manifest = data;
    fetchedAt = Date.now();
    await fsp.mkdir(config.dirs.game(), { recursive: true });
    await fsp.writeFile(cachePath(), JSON.stringify(data));
  } catch (e) {
    if (!cachedManifest()) throw new Error(`Не удалось загрузить список версий: ${net.describe(e)}`);
    log.warn(`Version manifest: using the cached copy (${net.describe(e)}).`);
  }
  return manifest;
}

function latestReleaseCached() {
  const m = cachedManifest();
  return (m && m.latest && m.latest.release) || '';
}

// Numeric-aware comparison for loader version strings ("47.2.10" > "47.2.9").
function cmpVersion(a, b) {
  const pa = String(a).split(/[.\-+_]/);
  const pb = String(b).split(/[.\-+_]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (x !== y) {
      if (!x) return 1;
      if (!y) return -1;
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// NeoForge numbers its releases after the Minecraft version they target:
// 1.21.1 → 21.1.x, 1.20.4 → 20.4.x; year-based releases (26.3) keep their
// own number as the prefix.
function neoForgePrefix(mc) {
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(mc);
  if (m) return `${m[1]}.${m[2] || '0'}.`;
  if (/^\d{2}\.\d+(\.\d+)?$/.test(mc)) return `${mc}.`;
  return '';
}

async function loaderVersions(loader, mc) {
  if (!mc) return [];
  if (loader === 'fabric' || loader === 'quilt') {
    const base = loader === 'fabric' ? FABRIC_META : QUILT_META;
    let r;
    try {
      r = await net.getJson(`${base}/versions/loader/${encodeURIComponent(mc)}`, { retries: 1 });
    } catch (e) {
      if (e.status === 400 || e.status === 404) return [];
      throw e;
    }
    return (Array.isArray(r) ? r : []).map((e) => ({
      id: e.loader.version,
      stable: loader === 'fabric' ? !!e.loader.stable : !/beta|pre|rc/i.test(e.loader.version),
    }));
  }
  if (loader === 'forge') {
    const [promos, meta] = await Promise.all([
      net.getJson(FORGE_PROMOS, { retries: 1 }).catch(() => ({ promos: {} })),
      net.getText(`${FORGE_MAVEN}/maven-metadata.xml`, { retries: 1 }).catch(() => ''),
    ]);
    const rec = promos.promos && promos.promos[`${mc}-recommended`];
    const lat = promos.promos && promos.promos[`${mc}-latest`];
    const all = [...meta.matchAll(/<version>([^<]+)<\/version>/g)]
      .map((m) => m[1])
      .filter((v) => v.startsWith(`${mc}-`))
      .map((v) => v.slice(mc.length + 1))
      // 1.7.10-era builds repeat the MC version as a suffix.
      .map((v) => v.replace(new RegExp(`-${mc.replace(/\./g, '\\.')}$`), ''))
      .sort((a, b) => cmpVersion(b, a));
    const ordered = [...new Set([rec, lat, ...all].filter(Boolean))];
    return ordered.map((v) => ({ id: v, stable: v === rec, tag: v === rec ? 'recommended' : v === lat ? 'latest' : '' }));
  }
  if (loader === 'neoforge') {
    const prefix = neoForgePrefix(mc);
    if (!prefix) return [];
    const r = await net.getJson(NEOFORGE_VERSIONS, { retries: 1 });
    return (r.versions || [])
      .filter((v) => v.startsWith(prefix))
      .sort((a, b) => cmpVersion(b, a))
      .map((v) => ({ id: v, stable: !/beta|alpha/i.test(v) }));
  }
  return [];
}

module.exports = {
  MANIFEST_URL,
  FABRIC_META,
  QUILT_META,
  FORGE_MAVEN,
  NEOFORGE_MAVEN,
  fetchManifest,
  cachedManifest,
  latestReleaseCached,
  loaderVersions,
  cmpVersion,
};
