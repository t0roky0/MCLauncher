const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function load(month) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-cos-'));
  const deps = {
    './paths': { appDir: dir, asset: (...p) => path.join(__dirname, '../../assets', ...p) },
    './log': { info() {}, warn() {} },
    // a receipt "signed" for a device: sig = 'ok:' + its device key (the real check: receipts.test.cjs)
    './receipts': { check: (r, device) => (r && r.sig === `ok:${device}` && Array.isArray(r.items) ? r.items.slice() : null) },
  };
  const module = { exports: {} };
  let clock = 1_000_000;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/main/cosmetics.js'), 'utf8'), {
    module, exports: module.exports, require: (id) => deps[id] || require(id), JSON, Math, Number, String, Array, Object, Map, Set, Error,
    Date: class extends Date { static now() { return clock; } }, setTimeout: () => 0, clearTimeout() {},
  });
  const c = module.exports;
  c._test.setNow(`2026-${String(month).padStart(2, '0')}-15T12:00:00`);
  const events = [];
  c.onEvent((type, p) => events.push([type, p]));
  return { c, events, dir, tick: (ms) => { clock += ms; } };
}

const item = (c, id) => c.view().items.find((i) => i.id === id);

test('October: the hockey mask for coming in — waits to be claimed, then worn; not in other months', () => {
  const oct = load(10);
  oct.c.init();
  assert.equal(item(oct.c, 'hockey_mask').ready, true);
  assert.equal(item(oct.c, 'hockey_mask').owned, false);
  assert.ok(oct.events.some(([t, p]) => t === 'granted' && p.item === 'hockey_mask'));
  assert.throws(() => oct.c.claim('witch_hat'), /нельзя забрать/);
  oct.c.claim('hockey_mask');
  assert.equal(item(oct.c, 'hockey_mask').owned, true);
  assert.equal(item(oct.c, 'hockey_mask').ready, false);
  assert.equal(oct.c.view().worn.head, 'hockey_mask');
  const ev = oct.c.view().events.find((e) => e.id === 'halloween');
  assert.equal(ev.active, true);
  assert.equal(new Date(ev.ends).getMonth(), 10); // the first moment of November
  const jun = load(6);
  jun.c.init();
  assert.equal(item(jun.c, 'hockey_mask').owned, false);
});

test('time in worlds, blocks walked, teleports and pauses not counted', () => {
  const { c, tick } = load(10);
  c.init();
  c.sample({ pid: 7, position: [0, 64, 0], server: '' });
  for (let k = 1; k <= 10; k++) {
    tick(1000);
    c.sample({ pid: 7, position: [k * 5, 64, 0], server: '' });
  }
  assert.equal(item(c, 'broom').quest.progress, 50);
  tick(1000);
  c.sample({ pid: 7, position: [5000, 64, 0], server: '' }); // a teleport
  assert.equal(item(c, 'broom').quest.progress, 50);
  tick(60_000); // the menu, alt-tab: not playing
  c.sample({ pid: 7, position: [5000, 64, 0], server: '' });
  // 11 seconds of play counted, the minute away not
  assert.equal(c.view().items.find((i) => i.id === 'witch_hat').quest.progress, 0); // floor of 11 s in minutes
  for (let k = 0; k < 200; k++) { tick(1000); c.sample({ pid: 7, position: [5000, 64, 0], server: '' }); }
  assert.equal(item(c, 'witch_hat').quest.progress, 3);
});

test('Hypixel / The Hive time and monsters beaten give their items', () => {
  const { c, tick, events } = load(10);
  c.init();
  c.sample({ pid: 9, position: [0, 64, 0], server: 'mc.hypixel.net:25565', kills: 0 });
  for (let k = 0; k < 3700; k++) { tick(1000); c.sample({ pid: 9, position: [0, 64, 0], server: 'mc.hypixel.net:25565', kills: Math.floor(k / 30) }); }
  assert.equal(item(c, 'bat_wings').ready, true);
  assert.equal(item(c, 'axe_in_head').ready, true);
  assert.ok(events.some(([t, p]) => t === 'granted' && p.item === 'bat_wings'));
  // a server that isn't one of those doesn't count
  const other = load(10);
  other.c.init();
  for (let k = 0; k < 100; k++) { other.tick(1000); other.c.sample({ pid: 1, position: [0, 64, 0], server: 'play.example.net' }); }
  assert.equal(item(other.c, 'bat_wings').quest.progress, 0);
});

test('only owned cosmetics can be worn, one per slot, and it is saved', () => {
  const { c, dir } = load(10);
  c.init();
  c.claim('hockey_mask');
  assert.throws(() => c.wear('head', 'witch_hat'), /ещё не получена/);
  c.wear('head', '');
  assert.equal(JSON.stringify(c.worn()), '[]');
  c.wear('head', 'hockey_mask');
  assert.equal(JSON.stringify(c.worn()), '["hockey_mask"]');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'cosmetics.json'), 'utf8'));
  assert.equal(saved.accounts.local.worn.head, 'hockey_mask');
});

test('the pumpkin someone already had is the hockey mask now, worn if it was', () => {
  const { c, dir } = load(10);
  fs.writeFileSync(path.join(dir, 'cosmetics.json'), JSON.stringify({
    owned: { pumpkin_head: { at: 1, quest: 'hw_pumpkin', event: 'halloween' } }, progress: {}, worn: { head: 'pumpkin_head' },
  }));
  assert.equal(item(c, 'hockey_mask').owned, true);
  assert.equal(c.view().worn.head, 'hockey_mask');
  assert.equal(JSON.stringify(c.worn()), '["hockey_mask"]');
  assert.equal(c.view().items.some((i) => i.id === 'pumpkin_head'), false);
});

test('every item has a rarity and a class (head, back or a pet)', () => {
  const { c } = load(10);
  c.init();
  const items = c.view().items;
  assert.equal(items.filter((i) => !i.shop).length, 5); // the event's
  assert.equal(items.filter((i) => i.shop).map((i) => i.id).sort().join(), 'angel_wings,balaboom,capybara,devil_horns,devil_wings,fallen_wings,halo,horned_halo,warden'); // the shop's
  for (const it of items) {
    assert.ok(['common', 'rare', 'epic', 'legendary'].includes(it.rarity), it.id);
    assert.ok(['head', 'back', 'pet'].includes(it.slot), it.id);
    assert.ok(it.nameEn, it.id);
  }
  assert.equal(item(c, 'hockey_mask').rarity, 'common');
  assert.equal(item(c, 'witch_hat').rarity, 'legendary');
  assert.equal(item(c, 'bat_wings').slot, 'back');
});

test('the same quests count in Bedrock: time, blocks and monsters beaten', () => {
  const { c, tick } = load(10);
  c.init();
  c.sample({ pid: 3, edition: 'bedrock', position: [0, 64, 0], dimension: 'Overworld', kills: 4 });
  for (let k = 1; k <= 20; k++) {
    tick(1000);
    c.sample({ pid: 3, edition: 'bedrock', position: [k * 4, 64, 0], dimension: 'Overworld', kills: 4 + k });
  }
  assert.equal(item(c, 'broom').quest.progress, 80);
  assert.equal(item(c, 'axe_in_head').quest.progress, 20);
});

test('an activation code: the whole event set owned, empty slots filled, the device key kept', () => {
  const { c, dir } = load(6);
  const key = c.deviceKey();
  assert.equal(key.length, 64);
  assert.equal(c.deviceKey(), key);
  const got = c.grantSet({ event: 'halloween', reward: 'halloween' });
  assert.equal(got.length, 5);
  for (const it of c.view().items.filter((i) => !i.shop)) assert.equal(it.owned, true, it.id);
  assert.ok(c.view().worn.head && c.view().worn.back);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'cosmetics.json'), 'utf8'));
  assert.equal(saved.accounts.local.owned.witch_hat.code, 'halloween');
  assert.ok(saved.device);
});

test('shop items: owned only with a receipt for this launcher, put on when bought', () => {
  const { c, dir } = load(6);
  const key = c.deviceKey();
  const wings = () => c.view().items.find((i) => i.id === 'angel_wings');
  assert.equal(wings().owned, false);
  assert.equal(wings().shop, true);
  assert.throws(() => c.wear('back', 'angel_wings'));
  // someone else's receipt, or a forged one: nothing
  c.setReceipts([{ pack: 'angel_pack', items: ['angel_wings', 'halo'], at: 'x', sig: 'ok:someone-else' }]);
  assert.equal(wings().owned, false);
  // ours: owned, and on (bought just now)
  c.setReceipts([{ pack: 'angel_pack', items: ['angel_wings', 'halo'], at: 'x', sig: `ok:${key}` }], ['angel_wings', 'halo']);
  assert.equal(wings().owned, true);
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(c.view().worn), { head: 'halo', back: 'angel_wings' });
  assert.deepEqual(plain(c.worn()).sort(), ['angel_wings', 'halo']);
  c.flush();
  // owning it by editing the file: taken away (and off) when it's read
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'cosmetics.json'), 'utf8'));
  saved.accounts.local.receipts = [];
  fs.writeFileSync(path.join(dir, 'cosmetics.json'), JSON.stringify(saved));
  c._test.reset();
  assert.equal(wings().owned, false);
  assert.equal(c.worn().length, 0);
});

test('each Xbox account its own: what the PC had goes to the first one, the next starts empty, receipts for the account', () => {
  const { c, dir } = load(6);
  // from before accounts: the PC's mask
  fs.writeFileSync(path.join(dir, 'cosmetics.json'), JSON.stringify({ owned: { hockey_mask: { at: 1, quest: 'hw_mask' } }, progress: {}, worn: { head: 'hockey_mask' } }));
  assert.equal(item(c, 'hockey_mask').owned, true); // seen before any account
  c.setAccount('x:2535400000000001');
  assert.equal(item(c, 'hockey_mask').owned, true);
  assert.deepEqual(JSON.parse(JSON.stringify(c.worn())), ['hockey_mask']);
  // another account: nothing of the first's
  c.setAccount('x:2535400000000002');
  assert.equal(item(c, 'hockey_mask').owned, false);
  assert.equal(c.worn().length, 0);
  // a receipt for this account (not for the launcher) owns its items
  c.setReceipts([{ pack: 'angel_pack', items: ['angel_wings', 'halo'], at: 'x', sig: 'ok:x:2535400000000002' }], ['halo']);
  assert.equal(item(c, 'halo').owned, true);
  // back to the first: its own again, still not the second's
  c.setAccount('x:2535400000000001');
  assert.equal(item(c, 'halo').owned, false);
  assert.deepEqual(JSON.parse(JSON.stringify(c.worn('x:2535400000000002'))), ['halo']);
  c.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'cosmetics.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.accounts).sort(), ['x:2535400000000001', 'x:2535400000000002']);
});
