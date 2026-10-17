// The week's quests (quests.js): the server's three for the account, the
// progress counted from game samples (minutes also mark the day), a quest
// done reported at once, all three → the reward's pick (coins or a pack,
// once), none without an Xbox account, a new week from nothing, the drop
// seen once.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function load({ account = { id: 'a1', type: 'msa', xuid: '42' }, week = 100, claimed = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-quests-'));
  const asked = [];
  const coins = [];
  const receipts = [];
  const server = {
    week,
    claimed: [...claimed],
    quests: [
      { id: `w${week}q0`, kind: 'minutes', goal: 60, title: { ru: 'Сыграй 60 мин в мирах', en: 'Play 60 min in worlds' } },
      { id: `w${week}q1`, kind: 'blocks', goal: 100, title: { ru: 'Пройди 100 блоков', en: 'Travel 100 blocks' } },
      { id: `w${week}q2`, kind: 'days', goal: 2, title: { ru: 'Заходи 2 дня', en: 'Play on 2 days' } },
    ],
  };
  const deps = {
    './paths': { appDir: dir },
    './log': { info() {}, warn() {} },
    './auth': { activeAccount: () => account },
    './account-session': {
      keyOf: (acc) => (acc && (acc.type === 'msa' || acc.type === 'xbox') ? `x:${acc.xuid}` : null),
      forAccount: async (acc) => (acc && acc.xuid ? { session: { xuid: acc.xuid } } : null),
    },
    './relay-server': { SECURE_URLS: ['mqtts://relay:443'] },
    './redeem': {
      ask: async (url, body) => {
        asked.push(body);
        const reward = () => (server.taken ? { state: 'taken', ...server.taken } : { state: server.claimed.length >= 3 ? 'ready' : 'locked' });
        if (body.op === 'quests') return { ok: true, week: server.week, starts: 0, ends: Date.now() / 1000 + 86400, quests: server.quests, claimed: server.claimed, reward: reward(), coins: 10 };
        if (body.op === 'quest_claim') {
          assert.equal(body.id, undefined, 'the quest never as id: that is the MQTT client own');
          const q = server.quests.find((x) => x.id === body.quest);
          if (!q || body.progress < q.goal) return { ok: false, error: 'progress' };
          const again = server.claimed.includes(q.id);
          if (!again) server.claimed.push(q.id);
          return { ok: true, again, claimed: [...server.claimed], reward: reward() };
        }
        if (body.op === 'quest_reward') {
          if (server.claimed.length < 3) return { ok: false, error: 'locked' };
          if (!server.taken) server.taken = { pick: body.pick, cards: [{ type: 'coins', coins: 22 }, { type: 'item', pack: 'warden_pet', items: ['warden'] }, { type: 'coins', coins: 30 }] };
          return { ok: true, pick: server.taken.pick, cards: server.taken.cards, coins: 10 + (server.taken.cards[server.taken.pick].coins || 0), receipts: ['r1'] };
        }
        return null;
      },
    },
    './shop': { setCoins: (n) => coins.push(n) },
    './cosmetics': { setReceipts: (list, wear) => receipts.push([list, wear]) },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/main/quests.js'), 'utf8'), {
    module, exports: module.exports, require: (id) => deps[id] || require(id), JSON, Math, Number, String, Array, Object, Map, Set, Error, Date, Promise,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console,
  });
  const q = module.exports;
  const events = [];
  q.onEvent((t, p) => events.push([t, p]));
  return { q, asked, coins, receipts, events, server, dir, setAccount: (a) => { account = a; } };
}

const settle = () => new Promise((r) => setImmediate(r));

test('quests: the account\'s three, progress from samples, reported when done (no coins for one)', async () => {
  const { q, asked, coins, events } = load();
  const v0 = await q.refresh();
  assert.equal(v0.quests.length, 3);
  assert.equal(v0.fresh, true);
  q.add('blocks', 60);
  q.add('blocks', 30);
  assert.equal(q.view().quests[1].progress, 90);
  q.add('blocks', 30); // over the goal: kept at it, claimed
  await settle();
  const claim = asked.find((b) => b.op === 'quest_claim');
  assert.equal(claim.quest, 'w100q1');
  assert.equal(claim.progress, 100);
  assert.equal(q.view().quests[1].claimed, true);
  assert.ok(events.some(([t, p]) => t === 'claimed' && p.count === 1 && p.ready === false));
  assert.equal(q.view().reward.state, 'locked');
  assert.equal(q.view().rewardWeek, null);
  assert.equal(coins.length, 1); // only what the refresh said
  // done once: more doesn't claim again
  q.add('blocks', 50);
  await settle();
  assert.equal(asked.filter((b) => b.op === 'quest_claim').length, 1);
});

test('quests: minutes mark the day; nothing from other kinds', async () => {
  const { q } = load();
  await q.refresh();
  q.add('minutes', 1.5);
  q.add('kills', 10); // no kills quest this week
  const v = q.view();
  assert.equal(v.quests[0].progress, 1);
  assert.equal(v.quests[2].progress, 1); // today
  q.add('minutes', 2);
  assert.equal(q.view().quests[2].progress, 1); // still one day
});

test('quests: none without an Xbox account', async () => {
  const { q, asked } = load({ account: { id: 'g', type: 'offline' } });
  const v = await q.refresh();
  assert.equal(v.account, false);
  assert.equal(v.quests.length, 0);
  q.add('minutes', 100);
  assert.equal(asked.length, 0);
});

test('quests: claimed ones come back claimed; the drop is seen once; a new week starts from nothing', async () => {
  const { q, server } = load({ claimed: ['w100q0'] });
  await q.refresh();
  assert.equal(q.view().quests[0].claimed, true);
  q.add('blocks', 40);
  assert.equal(q.seen(100).fresh, false);
  assert.equal(q.view().fresh, false);
  server.week = 101;
  server.claimed = [];
  server.quests = server.quests.map((x) => ({ ...x, id: x.id.replace('w100', 'w101') }));
  await q.refresh();
  const v = q.view();
  assert.equal(v.week, 101);
  assert.equal(v.fresh, true);
  assert.equal(v.quests[1].progress, 0);
});

test('quests: all three done → the reward: one card, once; a pack comes with its receipt', async () => {
  const { q, coins, receipts, events, server } = load();
  await q.refresh();
  assert.equal((await q.pickReward(100, 0)).error, 'locked');
  q.add('minutes', 60);
  q.add('blocks', 100);
  await settle();
  // the second day: as if played yesterday too
  server.claimed.push('w100q2');
  await q.refresh();
  const v = q.view();
  assert.equal(v.reward.state, 'ready');
  assert.equal(v.rewardWeek, 100);
  const got = await q.pickReward(100, 1);
  assert.equal(got.ok, true);
  assert.equal(got.pick, 1);
  assert.equal(got.cards[1].type, 'item');
  assert.deepEqual(receipts.at(-1), [['r1'], ['warden']]);
  assert.equal(q.view().reward.state, 'taken');
  assert.equal(q.view().rewardWeek, null);
  // again: the same card, nothing new to wear
  const again = await q.pickReward(100, 2);
  assert.equal(again.pick, 1);
  assert.ok(events.some(([t, p]) => t === 'claimed' && p.count === 2 && p.ready === false));
  assert.ok(coins.length >= 1);
});
