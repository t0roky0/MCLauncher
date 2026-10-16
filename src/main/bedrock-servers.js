'use strict';

// Minecraft's partner servers (October 2026). Keep saved external servers too.
// Operators: lifeboat.com, galaxite.net, playhive.com, cubecraft.net,
// enchanted.gg and inpvp.net (Mineville Zeqa / MegaSMP).
const FEATURED = [
  { name: 'Lifeboat', host: 'mco.lbsg.net' },
  { name: 'Galaxite', host: 'play.galaxite.net' },
  { name: 'The Hive', host: 'geo.hivebedrock.network' },
  { name: 'MegaSMP', host: 'play.megasmp.gg' },
  { name: 'CubeCraft', host: 'mco.cubecraft.net' },
  { name: 'Enchanted', host: 'play.enchanted.gg' },
  { name: 'Mineville Zeqa', host: 'play.inpvp.net' },
];

function serverList(text = '') {
  const saved = text.split(/\r?\n/).flatMap((line) => {
    // Split the trailing port/time first; names may contain colons.
    const match = /^\d+:(.+):([^:]+):(\d+):[^:]*$/.exec(line.trim());
    if (!match) return [];
    const port = Number(match[3]);
    if (port < 1 || port > 65535) return [];
    return [{ name: match[1], host: match[2].trim(), port }];
  });
  const seen = new Set();
  return [...FEATURED.map((s) => ({ ...s, port: 19132, featured: true })), ...saved].flatMap((s) => {
    const key = `${s.host.toLowerCase().replace(/\.$/, '')}:${s.port}`;
    if (!s.host || seen.has(key)) return [];
    seen.add(key);
    return [{ ...s, ip: s.port === 19132 ? s.host : `${s.host}:${s.port}` }];
  });
}

module.exports = { serverList };
