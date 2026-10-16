// Discord Rich Presence against a fake Discord on its own pipe: the
// handshake, the activity (party size, the join secret only while there's
// room and joining is on), "Join" from a friend's activity, "Ask to Join"
// and the answer to it.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const crypto = require('node:crypto');

const PIPE = `\\\\?\\pipe\\mcl-test-discord-${process.pid}-`;

function frame(op, body) {
  const j = Buffer.from(JSON.stringify(body));
  const h = Buffer.alloc(8);
  h.writeInt32LE(op, 0);
  h.writeInt32LE(j.length, 4);
  return Buffer.concat([h, j]);
}

// A pretend Discord: READY on handshake, remembers every command.
function fakeDiscord() {
  const got = [];
  const waiters = [];
  let conn = null;
  const server = net.createServer((c) => {
    conn = c;
    let buf = Buffer.alloc(0);
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8 && buf.length >= 8 + buf.readInt32LE(4)) {
        const op = buf.readInt32LE(0);
        const msg = JSON.parse(buf.subarray(8, 8 + buf.readInt32LE(4)).toString());
        buf = buf.subarray(8 + buf.readInt32LE(4));
        if (op === 0) c.write(frame(1, {cmd: 'DISPATCH', evt: 'READY', data: {v: 1}}));
        else {
          got.push(msg);
          for (const w of waiters.splice(0)) w();
        }
      }
    });
    c.on('error', () => {});
  });
  server.listen(`${PIPE}0`);
  const until = async (fn) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => waiters.push(r) && setTimeout(r, 50));
    assert.ok(fn(), 'never happened');
  };
  return {got, until, send: (body) => conn.write(frame(1, body)), close: () => new Promise((r) => server.close(r))};
}

function load(cfg, partyState) {
  process.env.MCL_DISCORD_PIPE = PIPE;
  process.env.MCL_DISCORD_ID = '123456789012345678';
  const module = {exports: {}};
  const deps = {
    './config': {get: () => cfg},
    './log': {info() {}, warn() {}},
    electron: {app: {isPackaged: false}},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/main/discord.js'), 'utf8'), {module, exports: module.exports, require: (id) => deps[id] || require(id), process, Buffer, console, setTimeout, clearTimeout});
  const discord = module.exports;
  const party = {state: () => partyState(), onEvent() {}, normalize: (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null};
  const game = {list: () => [], onEvent() {}};
  const bedrock = {runningList: () => [], onEvent() {}};
  return {discord, start: () => discord.init({game, bedrock, party})};
}

test('the party shows with a join secret; Join and Ask to Join both work', async (t) => {
  const fake = fakeDiscord();
  const cfg = {discord: true, language: 'ru'};
  let p = {active: true, code: 'ABCD-EFGH', capacity: 5, members: [{}, {}]};
  const {discord, start} = load(cfg, () => p);
  t.after(async () => {
    discord.shutdown();
    await fake.close();
  });
  const events = [];
  discord.onEvent((type, payload) => events.push([type, payload]));
  start();

  const activities = () => fake.got.filter((m) => m.cmd === 'SET_ACTIVITY');
  await fake.until(() => activities().length > 0);
  const subs = fake.got.filter((m) => m.cmd === 'SUBSCRIBE').map((m) => m.evt).sort();
  assert.deepEqual(subs, ['ACTIVITY_JOIN', 'ACTIVITY_JOIN_REQUEST']);
  const act = activities().at(-1).args.activity;
  assert.deepEqual(Array.from(act.party.size), [2, 5]);
  assert.equal(act.secrets.join, 'mclp1:ABCDEFGH');
  assert.ok(!JSON.stringify(act.party).includes('ABCD'), 'the code stays out of the visible party id');

  // a friend pressed "Join" somewhere: our launcher gets the secret
  fake.send({cmd: 'DISPATCH', evt: 'ACTIVITY_JOIN', data: {secret: 'mclp1:WXYZ2345'}});
  // someone asks to join ours
  fake.send({cmd: 'DISPATCH', evt: 'ACTIVITY_JOIN_REQUEST', data: {user: {id: '80351110224678912', username: 'nelly', global_name: 'Nelly', avatar: 'a_8342729096ea3675442027381ff50dfe'}}});
  // not ours / malformed: ignored
  fake.send({cmd: 'DISPATCH', evt: 'ACTIVITY_JOIN', data: {secret: 'something-else'}});
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(events.map(([type]) => type), ['join', 'request']);
  assert.equal(events[0][1].code, 'WXYZ2345');
  assert.equal(events[1][1].name, 'Nelly');
  assert.match(events[1][1].avatar, /^https:\/\/cdn\.discordapp\.com\/avatars\/80351110224678912\//);

  assert.equal(discord.answer('80351110224678912', true), true);
  assert.equal(discord.answer('80351110224678912', false), true);
  assert.equal(discord.answer('not-an-id', true), false);
  await fake.until(() => fake.got.some((m) => m.cmd === 'CLOSE_ACTIVITY_REQUEST'));
  assert.deepEqual(fake.got.filter((m) => /ACTIVITY_(JOIN_INVITE|REQUEST)$/.test(m.cmd)).map((m) => [m.cmd, m.args.user_id]), [
    ['SEND_ACTIVITY_JOIN_INVITE', '80351110224678912'],
    ['CLOSE_ACTIVITY_REQUEST', '80351110224678912'],
  ]);

  // full party, or joining switched off: no secret
  p = {active: true, code: 'ABCD-EFGH', capacity: 5, members: [{}, {}, {}, {}, {}]};
  discord.refresh();
  await fake.until(() => activities().at(-1).args.activity.party.size[0] === 5);
  assert.equal(activities().at(-1).args.activity.secrets, undefined);
  p = {active: true, code: 'ABCD-EFGH', capacity: 5, members: [{}]};
  cfg.discordJoin = false;
  discord.refresh();
  await fake.until(() => activities().at(-1).args.activity.party.size[0] === 1);
  assert.equal(activities().at(-1).args.activity.secrets, undefined);

  // Discord switched off in the settings: the activity is cleared
  cfg.discord = false;
  discord.refresh();
  await fake.until(() => activities().at(-1).args.activity === null);
});
