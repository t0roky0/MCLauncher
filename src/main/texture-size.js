'use strict';
// Dimension check for textures received from other launchers. Local imports
// additionally pass through nativeImage's full image decoder.
function textureUrl(value, kind = 'skin', maxLength = 350000) {
  if (typeof value !== 'string' || value.length > maxLength || !value.startsWith('data:image/png;base64,')) return '';
  const bytes = Buffer.from(value.slice(22), 'base64');
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') return '';
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  const valid = kind === 'cape'
    ? (width === 64 && height === 32) || (width === 128 && height === 64)
    : (width === 64 && (height === 64 || height === 32)) || (width === 128 && height === 128);
  return valid ? value : '';
}
module.exports = { textureUrl };

