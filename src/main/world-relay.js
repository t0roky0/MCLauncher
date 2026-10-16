'use strict';
// Reliable, bounded TCP fallback over the party's encrypted messaging channel.
// MQTT QoS 0 can drop, duplicate and reorder packets across brokers. Sequence
// numbers, cumulative acknowledgements and retransmission preserve TCP bytes.
const net = require('net');
const crypto = require('crypto');
const CHUNK = 8192, WINDOW = 8, TIMEOUT = 45000;
const validId = id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id);

class WorldRelay {
  constructor({ send, hostPort, allowed, onError = () => {} }) {
    Object.assign(this, { send, hostPort, allowed, onError });
    this.streams = new Map();
    this.dead = new Map();
    this.probes = new Map();
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref?.();
  }

  probe(to) {
    const id = crypto.randomBytes(12).toString('hex');
    return new Promise((resolve, reject) => {
      const p = { to, id, resolve, reject, since: Date.now(), sent: 0 };
      this.probes.set(id, p);
      this.tick();
    });
  }

  attach(to, id, socket) {
    const key = `${to}:${id}`;
    const s = { to, id, key, socket, tx: 0, rx: 0, ack: 0, pending: new Map(), incoming: new Map(), writing: false, since: Date.now(), sentFin: false, gotFin: false };
    this.streams.set(key, s);
    socket.setNoDelay(true);
    socket.pause();
    socket.on('readable', () => this.pump(s));
    socket.on('end', () => { if (!s.sentFin) { s.sentFin = true; this.queue(s, { kind: 'fin' }); } });
    socket.on('error', () => this.drop(s, true));
    socket.on('close', () => { if (!s.sentFin || !s.gotFin) this.drop(s, true); });
    return s;
  }

  open(to, socket) {
    const id = crypto.randomBytes(12).toString('hex');
    const s = this.attach(to, id, socket);
    this.queue(s, { kind: 'open' });
    this.pump(s);
  }

  queue(s, frame) {
    if (!this.streams.has(s.key)) return;
    if (!s.pending.size) s.since = Date.now();
    const packet = { ...frame, id: s.id, seq: s.tx++ };
    s.pending.set(packet.seq, { packet, sent: Date.now(), retry: 3000 });
    this.send(s.to, packet);
  }

  pump(s) {
    while (this.streams.has(s.key) && s.pending.size < WINDOW && s.socket.readableLength) {
      const bytes = s.socket.read(Math.min(CHUNK, s.socket.readableLength));
      if (!bytes) break;
      this.queue(s, { kind: 'data', data: bytes.toString('base64') });
    }
    // Trigger the end event after draining the last byte.
    if (!s.socket.readableLength) s.socket.read(0);
  }

  receive(from, p) {
    if (!p || !validId(p.id) || !this.allowed(from)) return;
    if (p.kind === 'probe') {
      if (this.hostPort()) this.send(from, { kind: 'ready', id: p.id });
      return;
    }
    if (p.kind === 'ready') {
      const probe = this.probes.get(p.id);
      if (probe?.to === from) { this.probes.delete(p.id); probe.resolve(); }
      return;
    }
    const key = `${from}:${p.id}`;
    let s = this.streams.get(key);
    if (p.kind === 'reset') { if (s) this.drop(s, false); return; }
    if (this.dead.has(key)) {
      this.send(from, { kind: 'reset', id: p.id });
      return;
    }
    if (!s && p.kind === 'open' && p.seq === 0 && this.hostPort()) {
      if ([...this.streams.values()].filter(x => x.to === from).length >= 8) return;
      s = this.attach(from, p.id, net.connect({ host: '127.0.0.1', port: this.hostPort(), allowHalfOpen: true }));
    }
    if (!s) return;
    if (p.kind === 'ack') {
      if (!Number.isSafeInteger(p.next) || p.next <= s.ack || p.next > s.tx) return;
      s.ack = p.next;
      s.since = Date.now();
      for (const seq of s.pending.keys()) if (seq < p.next) s.pending.delete(seq);
      this.pump(s);
      if (s.sentFin && s.gotFin && !s.pending.size) this.drop(s, false);
      return;
    }
    if (!['open', 'data', 'fin'].includes(p.kind) || !Number.isSafeInteger(p.seq) || p.seq < 0) return;
    if (p.kind === 'open' && p.seq !== 0) return;
    if (p.kind === 'data' && (typeof p.data !== 'string' || p.data.length > 10924 || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.data))) return;
    if (p.seq < s.rx) { this.send(from, { kind: 'ack', id: p.id, next: s.rx }); return; }
    if (p.seq >= s.rx + WINDOW || s.incoming.has(p.seq)) return;
    s.incoming.set(p.seq, p);
    this.deliver(s);
  }

  deliver(s) {
    if (s.writing || !this.streams.has(s.key)) return;
    const p = s.incoming.get(s.rx);
    if (!p) return;
    s.writing = true;
    const done = error => {
      if (!this.streams.has(s.key)) return;
      if (error) return this.drop(s, true);
      s.incoming.delete(s.rx++);
      s.writing = false;
      this.send(s.to, { kind: 'ack', id: s.id, next: s.rx });
      if (s.sentFin && s.gotFin && !s.pending.size) { this.drop(s, false); return; }
      this.deliver(s);
    };
    if (p.kind === 'data') s.socket.write(Buffer.from(p.data, 'base64'), done);
    else if (p.kind === 'fin') { s.gotFin = true; s.socket.end(done); }
    else done();
  }

  drop(s, reset) {
    if (!this.streams.delete(s.key)) return;
    this.dead.set(s.key, Date.now());
    if (reset) this.send(s.to, { kind: 'reset', id: s.id });
    s.socket.destroy();
  }

  tick() {
    const now = Date.now();
    for (const [id, p] of this.probes) {
      if (now - p.since > TIMEOUT) {
        this.probes.delete(id);
        p.reject(new Error('Ретранслятор мира не ответил. Проверьте связь с лобби и обновите лаунчер у всех игроков.'));
      } else if (now - p.sent >= 1000) { p.sent = now; this.send(p.to, { kind: 'probe', id }); }
    }
    for (const s of this.streams.values()) {
      if (!this.allowed(s.to)) { this.drop(s, true); continue; }
      if (s.pending.size && now - s.since > TIMEOUT) { this.drop(s, true); this.onError(); continue; }
      if (!s.pending.size) s.since = now;
      for (const item of s.pending.values()) if (now - item.sent >= item.retry) {
        item.sent = now; item.retry = Math.min(12000, item.retry * 2);
        this.send(s.to, item.packet);
      }
    }
    for (const [key, at] of this.dead) if (now - at > 60000) this.dead.delete(key);
  }

  stop() {
    for (const s of this.streams.values()) this.drop(s, true);
    for (const p of this.probes.values()) p.reject(new Error('Подключение к миру отменено.'));
    this.probes.clear();
  }

  close() { this.stop(); clearInterval(this.timer); }
}

module.exports = { WorldRelay };
