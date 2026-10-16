const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse } = require('../../src/main/party-bridge-protocol');

test('agent events accept raw stdout and Minecraft stdout logging but reject server chat', () => {
  const event = '[MC Launcher] party\tserver\t' + Buffer.from('example.test:25566').toString('base64');
  assert.deepEqual(parse(event), { type: 'partyServer', server: 'example.test:25566' });
  assert.deepEqual(parse('[12:00:01] [Render thread/INFO]: [STDOUT]: ' + event), parse(event));
  assert.equal(parse('[12:00:01] [Render thread/INFO]: [CHAT] ' + event), null);
  assert.deepEqual(parse('[MC Launcher] party\tworld\t' + Buffer.from('25566').toString('base64')), { type: 'partyWorld', port: 25566 });
  assert.equal(parse('[MC Launcher] party\tworld\t' + Buffer.from('0').toString('base64')), null);
  assert.equal(parse('[MC Launcher] party\tserver\t' + Buffer.from('bad host').toString('base64')), null);
});

function mappings() {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/main/party-mappings.js'), 'utf8'), {
    module, exports: module.exports, require: id => ['./config', './paths', './net', './log'].includes(id) ? {} : require(id),
  });
  return module.exports.parseMappings;
}
const official = `net.minecraft.client.Minecraft -> abc:
    net.minecraft.client.player.LocalPlayer player -> p
    net.minecraft.client.gui.screens.Screen screen -> s
    1:2:net.minecraft.client.Minecraft getInstance():3:4 -> A
    3:4:net.minecraft.client.server.IntegratedServer getSingleplayerServer() -> B
net.minecraft.client.server.IntegratedServer -> def:
    3:4:boolean publishServer(net.minecraft.world.level.GameType,boolean,int) -> a
    5:6:boolean isPublished() -> b
    7:8:int getPort() -> c
net.minecraft.world.level.GameType -> ghi:
net.minecraft.client.player.LocalPlayer -> jkl:
net.minecraft.client.gui.screens.Screen -> mno:
`;

test('official mappings resolve obfuscated client API and preserve line-numbered method names', () => {
  const map = mappings()(official);
  assert.equal(map['class.client'], 'abc');
  assert.equal(map['client.getInstance'], 'A');
  assert.equal(map['client.player'], 'p');
  assert.equal(map['server.publishServer'], 'a');
});

test('Fabric intermediary resolves the same methods using their descriptors', () => {
  const tiny = 'v1\tofficial\tintermediary\nCLASS\tabc\tnet/minecraft/class_310\nCLASS\tdef\tnet/minecraft/class_1132\n' +
    'METHOD\tabc\t()Labc;\tA\tmethod_1551\nFIELD\tabc\tLjkl;\tp\tfield_1724\n' +
    'METHOD\tdef\t(Lghi;ZI)Z\ta\tmethod_4811\n';
  const map = mappings()(official, tiny);
  assert.equal(map['class.client'], 'net.minecraft.class_310');
  assert.equal(map['client.getInstance'], 'method_1551');
  assert.equal(map['client.player'], 'field_1724');
  assert.equal(map['server.publishServer'], 'method_4811');
});
