const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { WorldRelay } = require('../../src/main/world-relay');

test('world fallback carries TCP bytes exactly through loss, duplication and reordering', { timeout: 15000 }, async t => {
  const sockets = new Set();
  const hostServer = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  hostServer.listen(0, '127.0.0.1'); await once(hostServer, 'listening');
  let host, guest;
  const dropped = new Set();
  const deliver = (target, from, packet) => {
    const key = from + ':' + packet.kind;
    if (['open', 'data', 'ack', 'fin', 'probe', 'ready'].includes(packet.kind) && !dropped.has(key)) { dropped.add(key); return; }
    setTimeout(() => target.receive(from, packet), packet.seq % 3 === 0 ? 12 : 1);
    if (packet.kind === 'data') setTimeout(() => target.receive(from, packet), 20);
  };
  host = new WorldRelay({ hostPort: () => hostServer.address().port, allowed: id => id === 'guest', send: (_, p) => deliver(guest, 'host', p) });
  guest = new WorldRelay({ hostPort: () => 0, allowed: id => id === 'host', send: (_, p) => deliver(host, 'guest', p) });
  const proxy = net.createServer({ allowHalfOpen: true }, socket => { sockets.add(socket); guest.open('host', socket); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => { host.close(); guest.close(); for (const s of sockets) s.destroy(); hostServer.close(); proxy.close(); });
  await guest.probe('host');
  const client = net.connect(proxy.address().port, '127.0.0.1'); sockets.add(client);
  const received = []; client.on('data', chunk => received.push(chunk));
  const source = crypto.randomBytes(512 * 1024 + 137);
  client.end(source);
  await once(client, 'end');
  assert.deepEqual(Buffer.concat(received), source);
  assert.ok(dropped.has('guest:open') && dropped.has('guest:data') && dropped.has('host:ack'));
  assert.ok([...host.streams.values(), ...guest.streams.values()].every(s => s.pending.size <= 17 && s.incoming.size <= 16));
});

test('unapproved peers cannot probe or open sockets, stopped probes reject', async () => {
  const sent = [];
  const relay = new WorldRelay({ hostPort: () => 12345, allowed: () => false, send: (...args) => sent.push(args) });
  try {
    relay.receive('stranger', { kind: 'probe', id: 'a'.repeat(24) });
    relay.receive('stranger', { kind: 'open', seq: 0, id: 'a'.repeat(24) });
    assert.equal(sent.length, 0); assert.equal(relay.streams.size, 0);
    const pending = relay.probe('host');
    relay.stop();
    await assert.rejects(pending, /отменено/);
  } finally { relay.close(); }
});
