'use strict';
// Minimal NBT (Minecraft's binary tag format): read any tree into plain JS
// values, and write the small fixed shape servers.dat needs.
//
// level.dat is gzipped, servers.dat is not; both are big-endian with an
// unnamed root compound.

const zlib = require('zlib');

const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  need(n) {
    if (this.pos + n > this.buf.length) throw new Error('NBT ended mid-tag');
  }
  u8() {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }
  i8() {
    this.need(1);
    return this.buf.readInt8(this.pos++);
  }
  i16() {
    this.need(2);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u16() {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  i64() {
    this.need(8);
    const v = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    // Timestamps (LastPlayed) fit comfortably in a double.
    return Number(v);
  }
  f32() {
    this.need(4);
    const v = this.buf.readFloatBE(this.pos);
    this.pos += 4;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.buf.readDoubleBE(this.pos);
    this.pos += 8;
    return v;
  }
  str() {
    const len = this.u16();
    this.need(len);
    // Strictly "modified UTF-8"; identical to UTF-8 for anything but NUL
    // and astral characters, which world names don't realistically use.
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
  payload(type) {
    switch (type) {
      case T.BYTE: return this.i8();
      case T.SHORT: return this.i16();
      case T.INT: return this.i32();
      case T.LONG: return this.i64();
      case T.FLOAT: return this.f32();
      case T.DOUBLE: return this.f64();
      case T.STRING: return this.str();
      case T.BYTE_ARRAY: {
        const n = this.i32();
        this.need(n);
        const out = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return out;
      }
      case T.INT_ARRAY: {
        const n = this.i32();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.i32();
        return out;
      }
      case T.LONG_ARRAY: {
        const n = this.i32();
        // Skipped rather than converted: nothing here reads them, and a
        // chunk-sized long array would be a lot of BigInt work for nothing.
        this.need(n * 8);
        this.pos += n * 8;
        return [];
      }
      case T.LIST: {
        const itemType = this.u8();
        const n = this.i32();
        if (itemType === T.END || n <= 0) return [];
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.payload(itemType);
        return out;
      }
      case T.COMPOUND: {
        const out = {};
        for (;;) {
          const t = this.u8();
          if (t === T.END) return out;
          const name = this.str();
          out[name] = this.payload(t);
        }
      }
      default:
        throw new Error(`unknown NBT tag ${type}`);
    }
  }
}

function parse(buf) {
  let data = buf;
  if (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
  const r = new Reader(data);
  const rootType = r.u8();
  if (rootType !== T.COMPOUND) throw new Error('NBT root is not a compound');
  r.str();
  return r.payload(T.COMPOUND);
}

// --- writing (servers.dat only needs compound/list/string/byte) -------------

function strBytes(s) {
  const b = Buffer.from(String(s), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function named(type, name, payloadBuf) {
  return Buffer.concat([Buffer.from([type]), strBytes(name), payloadBuf]);
}

function writeServersDat(servers) {
  const entries = servers.map((s) => {
    const parts = [named(T.STRING, 'name', strBytes(s.name || 'Minecraft Server')), named(T.STRING, 'ip', strBytes(s.ip))];
    if (s.icon) parts.push(named(T.STRING, 'icon', strBytes(s.icon)));
    if (typeof s.acceptTextures === 'number') parts.push(named(T.BYTE, 'acceptTextures', Buffer.from([s.acceptTextures & 0xff])));
    if (s.hidden) parts.push(named(T.BYTE, 'hidden', Buffer.from([1])));
    parts.push(Buffer.from([T.END]));
    return Buffer.concat(parts);
  });
  const count = Buffer.alloc(4);
  count.writeInt32BE(servers.length);
  const list = Buffer.concat([Buffer.from([T.COMPOUND]), count, ...entries]);
  const root = Buffer.concat([named(T.LIST, 'servers', list), Buffer.from([T.END])]);
  return Buffer.concat([Buffer.from([T.COMPOUND]), strBytes(''), root]);
}

module.exports = { parse, writeServersDat, T };
