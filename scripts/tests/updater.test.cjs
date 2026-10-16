// The launcher's updates (src/main/updater.js): what gets installed and what
// gets thrown away. A key of the test's own stands in for the release key.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const stub = (rel, exports) => { const f = require.resolve(path.join(root, 'src/main', rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
stub('log', { info() {}, warn() {} });
const { verify, newer, signedText } = require(path.join(root, 'src/main/updater.js'))._test;

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-update-'));
const installer = path.join(dir, 'setup.exe');
fs.writeFileSync(installer, crypto.randomBytes(200000));
const hash = crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64');
const sign = (version, sha = hash, key = privateKey) => ({ version, sha512: sha, signature: crypto.sign(null, Buffer.from(signedText(version, sha)), key).toString('base64') });

test('versions: in semver order, betas before the release', () => {
  assert.ok(newer('2.1.20-beta.15', '2.1.20-beta.14'));
  assert.ok(newer('2.1.20-beta.10', '2.1.20-beta.9'));
  assert.ok(newer('2.1.20', '2.1.20-beta.14'));
  assert.ok(newer('2.1.21-beta.1', '2.1.20'));
  assert.ok(newer('2.2.0', '2.1.99'));
  assert.ok(!newer('2.1.20-beta.14', '2.1.20-beta.14'));
  assert.ok(!newer('2.1.20-beta.14', '2.1.20'));
  assert.ok(!newer('2.1.19', '2.1.20-beta.1'));
  assert.ok(!newer('nonsense', '2.1.20'));
});

test('a signed newer installer goes in', async () => {
  await verify(installer, '2.1.20-beta.15', sign('2.1.20-beta.15'), '2.1.20-beta.14', pub);
});

test('anything else is thrown away', async () => {
  const no = (sig, version = '2.1.20-beta.15', current = '2.1.20-beta.14') => assert.rejects(verify(installer, version, sig, current, pub));
  await no(null); // no signature
  await no({ ...sign('2.1.20-beta.15'), signature: sign('2.1.20-beta.16').signature }); // signature of something else
  await no(sign('2.1.20-beta.15', hash, crypto.generateKeyPairSync('ed25519').privateKey)); // someone else's key
  await no(sign('2.1.20-beta.15', crypto.createHash('sha512').update('other').digest('base64'))); // another file
  await no(sign('2.1.20-beta.12'), '2.1.20-beta.15'); // an old signed one passed off as new
  await no(sign('2.1.20-beta.12'), '2.1.20-beta.12'); // an old one as itself: not newer
  fs.appendFileSync(installer, 'x');
  await no(sign('2.1.20-beta.15')); // changed after signing
});

test('the release key matches the one the launcher trusts', { skip: !fs.existsSync(path.join(os.homedir(), '.mclauncher-release', 'update-signing-key.pem')) && 'not the release PC' }, () => {
  const key = crypto.createPrivateKey(fs.readFileSync(path.join(os.homedir(), '.mclauncher-release', 'update-signing-key.pem')));
  const trusted = /PUBLIC_KEY = '([^']+)'/.exec(fs.readFileSync(path.join(root, 'src/main/updater.js'), 'utf8'))[1];
  assert.equal(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64'), trusted);
});
