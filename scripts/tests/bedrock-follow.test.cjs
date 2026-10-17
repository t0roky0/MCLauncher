// The pet's follow script for Bedrock (bedrock-cosmetics.js FOLLOW): Bedrock
// stops the whole expression at a read of a variable that doesn't exist yet,
// so every v.mcl_ variable it uses is made (?? default) before the rest — in
// 2.1.20–2.1.21 one wasn't (v.mcl_ky) and the pet never left the shoulder.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../../src/main/bedrock-cosmetics.js'), 'utf8');
const start = src.indexOf('const WRAP =');
const end = src.indexOf("].join(' ')];", start) + "].join(' ')];".length;
const FOLLOW = new Function(`${src.slice(start, end)}; return FOLLOW;`)()[0];

test('follow: every variable it keeps is made before anything reads it', () => {
  const body = FOLLOW.indexOf('(!q.is_in_ui');
  assert.ok(body > 0);
  const head = FOLLOW.slice(0, body);
  const made = new Set([...head.matchAll(/v\.mcl_([a-z]+) = v\.mcl_\1 \?\? -?[\d.]+;/g)].map((m) => m[1]));
  const used = new Set([...FOLLOW.matchAll(/v\.mcl_([a-z]+)/g)].map((m) => m[1]));
  assert.deepEqual([...used].filter((n) => !made.has(n)), []);
  // nothing else in the head: only the making
  assert.equal(head.replace(/v\.mcl_([a-z]+) = v\.mcl_\1 \?\? -?[\d.]+;/g, '').trim(), '');
});

test('follow: the model is turned back by the body turn the game draws it with', () => {
  assert.match(FOLLOW, /v\.mcl_rel = \(math\.mod\(math\.mod\(v\.mcl_dir - q\.body_y_rotation, 360\)/);
});
