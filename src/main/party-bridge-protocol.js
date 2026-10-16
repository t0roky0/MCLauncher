'use strict';
function parse(line) {
  const m = /^(?:\[[^\]]+\] \[[^\]]+\/INFO\]: \[STDOUT\]: )?\[MC Launcher\] party\t(world|server|idle|ready|error|command)\t([A-Za-z0-9+/=]*)$/.exec(line);
  if (!m || m[2].length > 4096) return null;
  const value = Buffer.from(m[2], 'base64').toString('utf8');
  if (m[1] === 'world') {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? { type: 'partyWorld', port } : null;
  }
  if (m[1] === 'server') return value && value.length <= 256 && !/[\s\x00-\x1f]/.test(value) ? { type: 'partyServer', server: value } : null;
  return { type: { idle: 'partyIdle', ready: 'partyReady', error: 'partyError', command: 'partyCommand' }[m[1]], message: value };
}
module.exports = { parse };
