// The system proxy (proxy.js): its rule parsed, and the game's SOCKS5 bridge —
// a connection with the right password goes through an HTTP proxy's CONNECT
// (a VPN app's system proxy) to the far end and back, the wrong one doesn't.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');

function load(rule) {
  const module = { exports: {} };
  const logs = [];
  const electron = { app: { isReady: () => true }, session: { defaultSession: { resolveProxy: async () => rule } } };
  const deps = { electron, './log': { info: (m) => logs.push(m), warn: (m) => logs.push(m), secret() {} } };
  const ctx = { module, exports: module.exports, require: (id) => deps[id] || require(id), Buffer, URL, setTimeout, clearTimeout, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/main/proxy.js'), 'utf8'), ctx);
  return { proxy: module.exports, logs };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

test('proxy: the system rule', () => {
  const { proxy } = load('');
  assert.deepEqual({ ...proxy.parse('PROXY 127.0.0.1:10809') }, { type: 'http', host: '127.0.0.1', port: 10809 });
  assert.deepEqual({ ...proxy.parse('SOCKS5 10.0.0.2:1080; DIRECT') }, { type: 'socks5', host: '10.0.0.2', port: 1080 });
  assert.equal(proxy.parse('DIRECT'), null);
  assert.equal(proxy.parse(''), null);
});

test('proxy: no system proxy, no bridge for the game', async () => {
  const { proxy } = load('DIRECT');
  assert.equal(await proxy.forGame(), null);
});

// a SOCKS5 client as Java's: offers no password and user/password, gives them, CONNECTs by name
function socksClient(port, user, pass, host, targetPort) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let step = 0;
    s.on('error', reject);
    s.on('close', () => resolve({ ok: false, step }));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (step === 0 && buf.length >= 2) {
        assert.deepEqual([...buf.subarray(0, 2)], [5, 2]);
        buf = buf.subarray(2);
        step = 1;
        s.write(Buffer.concat([Buffer.from([1, user.length]), Buffer.from(user), Buffer.from([pass.length]), Buffer.from(pass)]));
      }
      if (step === 1 && buf.length >= 2) {
        const okAuth = buf[1] === 0;
        buf = buf.subarray(2);
        if (!okAuth) return;
        step = 2;
        const p = Buffer.alloc(2);
        p.writeUInt16BE(targetPort);
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host), p]));
      }
      if (step === 2 && buf.length >= 10) {
        assert.equal(buf[1], 0, 'CONNECT granted');
        buf = buf.subarray(10);
        step = 3;
        s.write('ping');
      }
      if (step === 3 && buf.length >= 9) {
        resolve({ ok: true, echo: buf.toString() });
        s.destroy();
      }
    });
    s.write(Buffer.from([5, 2, 0, 2]));
  });
}

test('proxy: the game bridge goes through the system HTTP proxy', async (t) => {
  // the far end: echoes back with "pong:"
  const echo = net.createServer((c) => c.on('data', (d) => c.write(`pong:${d}`)));
  const echoPort = await listen(echo);
  // the system's HTTP proxy: CONNECT to the name asked for (here always the echo), "200" first
  const asked = [];
  const http = net.createServer((c) => {
    let head = '';
    const onData = (d) => {
      head += d.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      c.off('data', onData);
      asked.push(head.split('\r\n')[0]);
      const up = net.connect(echoPort, '127.0.0.1', () => {
        c.write('HTTP/1.1 200 Connection established\r\n\r\n');
        c.pipe(up);
        up.pipe(c);
      });
    };
    c.on('data', onData);
  });
  const httpPort = await listen(http);
  t.after(() => { echo.close(); http.close(); });

  const { proxy, logs } = load(`PROXY 127.0.0.1:${httpPort}`);
  const g = await proxy.forGame();
  assert.ok(g && g.port > 0 && g.user && g.pass);
  assert.match(logs.join('\n'), /through the system's HTTP proxy 127\.0\.0\.1:/);

  const good = await socksClient(g.port, g.user, g.pass, 'textures.minecraft.net', 443);
  assert.equal(good.ok, true);
  assert.equal(good.echo, 'pong:ping');
  assert.deepEqual(asked, ['CONNECT textures.minecraft.net:443 HTTP/1.1']);

  const bad = await socksClient(g.port, g.user, 'wrong-password-wrong-password-xx', 'textures.minecraft.net', 443);
  assert.equal(bad.ok, false, 'a wrong password goes nowhere');
  assert.equal(asked.length, 1);
  (await proxy.startBridge()).server.close();
});
