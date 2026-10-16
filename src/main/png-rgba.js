'use strict';
// A PNG's pixels and back — 8-bit RGBA, not interlaced (the game's own
// textures are), enough to change one of them (bedrock-cosmetics.js: the
// low fire). Anything else: null, and the caller leaves the file as it is.
const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// → { width, height, data: RGBA rows top to bottom } or null
function decode(png) {
  if (!Buffer.isBuffer(png) || png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) return null;
  let width = 0, height = 0, ok = false;
  const idat = [];
  for (let p = 8; p + 12 <= png.length;) {
    const len = png.readUInt32BE(p), type = png.toString('latin1', p + 4, p + 8), body = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      // depth 8, colour type 6 (RGBA), deflate, adaptive filters, no interlace
      ok = body[8] === 8 && body[9] === 6 && body[10] === 0 && body[11] === 0 && body[12] === 0;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ok || !width || !height || width * height > 16 * 1024 * 1024) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = width * 4;
  if (raw.length < (stride + 1) * height) return null;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? data[row + x - 4] : 0, b = y ? data[up + x] : 0, c = x >= 4 && y ? data[up + x - 4] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) return null;
      data[row + x] = v & 255;
    }
  }
  return { width, height, data };
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

function encode({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { decode, encode };
