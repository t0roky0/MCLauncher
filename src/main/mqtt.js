'use strict';
// Just enough MQTT 3.1.1 for parties: connect, subscribe, publish at QoS 0,
// keep-alive pings. Over WebSocket (ws://, wss:// — Node's built-in) or a
// plain socket (mqtt:// over TCP, mqtts:// over TLS): networks that filter
// one often let the other through.

const net = require('net');
const tls = require('tls');

const KEEPALIVE = 30;
// Our own pings come much more often than the broker needs: a filtered
// network often freezes a connection without closing it, and the sooner a
// missing PINGRESP shows it, the sooner the line comes back.
const PING_MS = 10000;

// mqtt:// and mqtts:// behind the WebSocket-shaped surface the client uses.
class SocketTransport {
  constructor(url) {
    const u = new URL(url);
    const secure = u.protocol === 'mqtts:';
    const port = Number(u.port) || (secure ? 8883 : 1883);
    this.readyState = 0;
    // our own relay: its own certificate, by address (no name to send)
    const own = require('./relay-server').trust(u.hostname);
    const options = { host: u.hostname, port, ...(net.isIP(u.hostname) ? {} : { servername: u.hostname }), ...(own ? { ca: own } : {}) };
    const s = secure ? tls.connect(options) : net.connect({ host: u.hostname, port });
    this.s = s;
    s.setNoDelay(true);
    s.on(secure ? 'secureConnect' : 'connect', () => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    });
    s.on('data', (d) => this.onmessage && this.onmessage({ data: d }));
    s.on('error', () => this.onerror && this.onerror());
    s.on('close', () => {
      this.readyState = 3;
      if (this.onclose) this.onclose();
    });
  }

  send(buf) {
    this.s.write(buf);
  }

  close() {
    this.s.destroy();
  }
}

function varint(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

const str = (s) => {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};

function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), varint(body.length), body]);
}

class MqttClient {
  constructor(url, { clientId, onMessage, onClose } = {}) {
    const endpoint = new URL(url);
    this.username = decodeURIComponent(endpoint.username);
    this.password = decodeURIComponent(endpoint.password);
    endpoint.username = endpoint.password = '';
    this.url = endpoint.href;
    this.clientId = clientId || `mcl-${Math.random().toString(36).slice(2, 12)}`;
    this.onMessage = onMessage || (() => {});
    this.onClose = onClose || (() => {});
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.closed = false;
  }

  // Resolves once the broker accepted the connection.
  connect(timeout = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          this.ws.close();
        } catch {
          /* closed */
        }
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error(`${this.url}: no answer`)), timeout);
      let ws;
      try {
        ws = /^mqtts?:/i.test(this.url) ? new SocketTransport(this.url) : new WebSocket(this.url, ['mqtt']);
      } catch (e) {
        fail(e);
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        const credentials = this.username ? [str(this.username), str(this.password)] : [];
        const body = Buffer.concat([str('MQTT'), Buffer.from([4, this.username ? 0xc2 : 0x02, KEEPALIVE >> 8, KEEPALIVE & 0xff]), str(this.clientId), ...credentials]);
        ws.send(packet(1, 0, body));
      };
      ws.onerror = () => {
        if (!settled) fail(new Error(`${this.url}: connection failed`));
        else ws.close();
      };
      ws.onclose = () => {
        clearInterval(this.pinger);
        if (!settled) fail(new Error(`${this.url}: closed`));
        else if (!this.closed) this.onClose();
      };
      ws.onmessage = (ev) => {
        this.buf = Buffer.concat([this.buf, Buffer.from(ev.data)]);
        this.drain((type, flags, body) => {
          if (type === 2) {
            // CONNACK
            if (body[1] !== 0) return fail(new Error(`${this.url}: refused (${body[1]})`));
            settled = true;
            clearTimeout(timer);
            this.awaitingPing = false;
            this.pinger = setInterval(() => {
              // A blackholed TCP connection need not emit close. Require PINGRESP.
              if (this.awaitingPing) { ws.close(); return; }
              this.awaitingPing = true;
              this.send(packet(12, 0, Buffer.alloc(0)));
            }, PING_MS);
            resolve(this);
          } else if (type === 13) {
            this.awaitingPing = false;
          } else if (type === 3) {
            // PUBLISH (QoS 0 — we never ask for more)
            if (body.length < 2) return;
            const tlen = body.readUInt16BE(0);
            if (body.length < 2 + tlen) return;
            const topic = body.subarray(2, 2 + tlen).toString('utf8');
            const qos = (flags >> 1) & 3;
            const payload = body.subarray(2 + tlen + (qos ? 2 : 0));
            this.onMessage(topic, payload);
          }
        });
      };
    });
  }

  drain(fn) {
    for (;;) {
      if (this.buf.length < 2) return;
      let mult = 1;
      let len = 0;
      let i = 1;
      let byte;
      do {
        if (i >= this.buf.length) return;
        byte = this.buf[i++];
        len += (byte & 0x7f) * mult;
        mult *= 128;
      } while (byte & 0x80);
      if (this.buf.length < i + len) return;
      const type = this.buf[0] >> 4;
      const flags = this.buf[0] & 0x0f;
      const body = this.buf.subarray(i, i + len);
      this.buf = this.buf.subarray(i + len);
      fn(type, flags, body);
    }
  }

  send(buf) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(buf);
  }

  subscribe(topic) {
    const id = Buffer.alloc(2);
    id.writeUInt16BE(this.nextId++ & 0xffff || 1);
    this.send(packet(8, 2, Buffer.concat([id, str(topic), Buffer.from([0])])));
  }

  unsubscribe(topic) {
    const id = Buffer.alloc(2);
    id.writeUInt16BE(this.nextId++ & 0xffff || 1);
    this.send(packet(10, 2, Buffer.concat([id, str(topic)])));
  }

  publish(topic, payload) {
    this.send(packet(3, 0, Buffer.concat([str(topic), Buffer.from(payload)])));
  }

  close() {
    this.closed = true;
    clearInterval(this.pinger);
    try {
      this.send(packet(14, 0, Buffer.alloc(0)));
      this.ws.close();
    } catch {
      /* closed */
    }
  }
}

module.exports = { MqttClient };
