'use strict';
// Translate the small reflection API used by PartyBridge for obfuscated clients.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const paths = require('./paths');
const net = require('./net');
const log = require('./log');

const CLASSES = {
  skinManager: 'net.minecraft.client.resources.SkinManager', connection: 'net.minecraft.client.multiplayer.ClientPacketListener', info: 'net.minecraft.client.multiplayer.PlayerInfo',
  skinDownloader: 'net.minecraft.client.renderer.texture.SkinTextureDownloader', image: 'com.mojang.blaze3d.platform.NativeImage',
  level: 'net.minecraft.client.multiplayer.ClientLevel', entity: 'net.minecraft.world.entity.Entity', player: 'net.minecraft.world.entity.player.Player',
  client: 'net.minecraft.client.Minecraft', server: 'net.minecraft.client.server.IntegratedServer',
  base: 'net.minecraft.server.MinecraftServer', data: 'net.minecraft.client.multiplayer.ServerData',
  address: 'net.minecraft.client.multiplayer.resolver.ServerAddress',
  connect: 'net.minecraft.client.gui.screens.ConnectScreen', title: 'net.minecraft.client.gui.screens.TitleScreen',
  // nearby voice's surroundings: blocks between players, a roof overhead
  blockPos: 'net.minecraft.core.BlockPos', blockGetter: 'net.minecraft.world.level.BlockGetter',
  tintGetter: 'net.minecraft.world.level.BlockAndTintGetter', blockState: 'net.minecraft.world.level.block.state.BlockBehaviour$BlockStateBase',
  // event quests: monsters beaten
  living: 'net.minecraft.world.entity.LivingEntity', enemy: 'net.minecraft.world.entity.monster.Enemy',
  damageSource: 'net.minecraft.world.damagesource.DamageSource',
  capeLayer: 'net.minecraft.client.renderer.entity.layers.CapeLayer',
  renderLayer: 'net.minecraft.client.renderer.entity.layers.RenderLayer',
  humanoidModel: 'net.minecraft.client.model.HumanoidModel', modelPart: 'net.minecraft.client.model.geom.ModelPart',
  playerState: ['net.minecraft.client.renderer.entity.state.PlayerRenderState', 'net.minecraft.client.renderer.entity.state.AvatarRenderState'],
  entityState: 'net.minecraft.client.renderer.entity.state.EntityRenderState',
  livingState: 'net.minecraft.client.renderer.entity.state.HumanoidRenderState',
  identifier: ['net.minecraft.resources.ResourceLocation', 'net.minecraft.resources.Identifier'], dynamicTexture: 'net.minecraft.client.renderer.texture.DynamicTexture',
  abstractTexture: 'net.minecraft.client.renderer.texture.AbstractTexture', textureManager: 'net.minecraft.client.renderer.texture.TextureManager',
  renderTypes: ['net.minecraft.client.renderer.RenderType', 'net.minecraft.client.renderer.rendertype.RenderTypes'], bufferSource: 'net.minecraft.client.renderer.MultiBufferSource',
  poseStack: 'com.mojang.blaze3d.vertex.PoseStack', pose: 'com.mojang.blaze3d.vertex.PoseStack$Pose',
  vertexConsumer: 'com.mojang.blaze3d.vertex.VertexConsumer', matrix4: 'com.mojang.math.Matrix4f', matrix3: 'com.mojang.math.Matrix3f',
  equipmentSlot: 'net.minecraft.world.entity.EquipmentSlot', itemStack: 'net.minecraft.world.item.ItemStack',
  collector: 'net.minecraft.client.renderer.SubmitNodeCollector', customGeometry: 'net.minecraft.client.renderer.SubmitNodeCollector$CustomGeometryRenderer',
};
const MEMBERS = {
  skinManager: ['skinCache'], connection: ['getOnlinePlayers'], info: ['getProfile'],
  skinDownloader: ['processLegacySkin'],
  image: ['getWidth', 'getHeight', 'read'],
  level: ['players', 'entitiesForRendering', 'getEntity'], entity: ['getX', 'getY', 'getZ', 'getUUID', 'getYRot', 'getEyeY', 'isUnderWater', 'getId', 'getScoreboardName', 'isInvisible'], player: ['getGameProfile'],
  living: ['isDeadOrDying', 'getLastDamageSource', 'isSwinging', 'swinging', 'getItemBySlot'], damageSource: ['getEntity'],
  blockGetter: ['getBlockState'], tintGetter: ['canSeeSky'], blockState: ['canOcclude'],
  client: ['getConnection', 'getSkinManager', 'getInstance', 'getSingleplayerServer', 'getCurrentServer', 'player', 'screen', 'level', 'crosshairPickEntity', 'getTextureManager'],
  server: ['isPublished', 'publishServer', 'getPort', 'unpublishServer'], base: ['getDefaultGameType'],
  data: ['ip'], address: ['parseString'], connect: ['startConnecting'],
  capeLayer: ['render', 'submit'], renderLayer: ['getParentModel'], humanoidModel: ['head', 'body'], modelPart: ['translateAndRotate', 'translateTo'],
  playerState: ['id', 'name'], entityState: ['isInvisible'], livingState: ['headEquipment', 'chestEquipment'],
  identifier: ['fromNamespaceAndPath'], textureManager: ['register'], renderTypes: ['entityCutout', 'entityCutoutNoCull', 'entityCutoutCull', 'eyes'],
  bufferSource: ['getBuffer'], poseStack: ['pushPose', 'popPose', 'last'], pose: ['pose', 'normal'],
  vertexConsumer: ['addVertex', 'vertex'], matrix4: ['store'], matrix3: ['store'], equipmentSlot: ['HEAD', 'CHEST'], itemStack: ['isEmpty'],
  collector: ['submitCustomGeometry'], customGeometry: ['render'],
};

function parseMappings(text, tiny = '') {
  const names = new Map(), members = [];
  let owner = '', group = '';
  for (const line of text.split(/\r?\n/)) {
    const cls = /^(\S+) -> (\S+):$/.exec(line);
    if (cls) {
      owner = cls[2]; names.set(cls[1], owner);
      group = Object.keys(CLASSES).find(k => [CLASSES[k]].flat().includes(cls[1])) || '';
      continue;
    }
    if (!group) continue;
    const m = /^\s+(?:\d+:\d+:)?([\w.$\[\]]+) (\w+)(?:\(([^)]*)\))?(?::\d+(?::\d+)?)? -> (\S+)$/.exec(line);
    if (m && (group !== 'entity' || m[3] === '') && MEMBERS[group]?.includes(m[2])) {
      // Hook only the typed cape method; the compiler's Entity bridge calls it.
      if (group === 'capeLayer' && !/AbstractClientPlayer|PlayerRenderState|AvatarRenderState/.test(m[3] || '')) continue;
      members.push({ owner, group, type: m[1], name: m[2], args: m[3], target: m[4] });
    }
  }
  const primitive = { void: 'V', boolean: 'Z', byte: 'B', char: 'C', short: 'S', int: 'I', long: 'J', float: 'F', double: 'D' };
  const descriptor = name => name.endsWith('[]') ? '[' + descriptor(name.slice(0, -2)) : primitive[name] || `L${(names.get(name) || name).replaceAll('.', '/')};`;
  const remapClasses = new Map(), remapMembers = new Map();
  if (tiny) {
    if (!tiny.startsWith('v1\tofficial\tintermediary')) throw new Error('Unsupported intermediary mapping format');
    for (const line of tiny.split(/\r?\n/)) {
      const p = line.split('\t');
      if (p[0] === 'CLASS') remapClasses.set(p[1], p[2]);
      else if (p[0] === 'METHOD' || p[0] === 'FIELD') remapMembers.set(`${p[1]} ${p[3]} ${p[2]}`, p[4]);
    }
  }
  const result = {};
  for (const [key, name] of Object.entries(CLASSES)) {
    const obf = [name].flat().map(n => names.get(n)).find(Boolean);
    if (obf) result[`class.${key}`] = tiny ? (remapClasses.get(obf.replaceAll('.', '/')) || obf).replaceAll('/', '.') : obf;
  }
  for (const m of members) {
    const desc = m.args === undefined ? descriptor(m.type) : `(${m.args ? m.args.split(',').map(descriptor).join('') : ''})${descriptor(m.type)}`;
    const key = `${m.group === 'base' ? 'server' : m.group}.${m.name}`;
    result[key] = tiny ? remapMembers.get(`${m.owner.replaceAll('.', '/')} ${m.target} ${desc}`) || m.target : m.target;
    if (m.group === 'capeLayer') result[`${key}Desc`] = tiny ? desc.replace(/L([^;]+);/g, (_, n) => `L${remapClasses.get(n) || n};`) : desc;
  }
  if (result['capeLayer.submitDesc']) result['cosmetic.api'] = 'submit';
  else if (result['capeLayer.renderDesc']) result['cosmetic.api'] = /;FFFFFFF\)V$/.test(result['capeLayer.renderDesc']) ? 'legacy' : 'buffer';
  if (result['modelPart.translateTo']) result['modelPart.postRender'] = result['modelPart.translateTo'];
  return result;
}

async function forEntry(entry) {
  if (!entry || !['vanilla', 'fabric', 'quilt'].includes(entry.loader)) return {};
  try {
    const meta = JSON.parse(await fs.promises.readFile(path.join(config.dirs.versions(), entry.mcVersion, `${entry.mcVersion}.json`), 'utf8'));
    const mapping = meta.downloads?.client_mappings;
    if (!mapping) return {}; // 26.x ships readable class and method names
    const file = path.join(paths.appDir, 'agent', `mappings-${mapping.sha1}.txt`);
    let text;
    try { text = await fs.promises.readFile(file, 'utf8'); } catch { /* download once */ }
    if (!text || crypto.createHash('sha1').update(text).digest('hex') !== mapping.sha1) {
      text = await net.getText(mapping.url, { timeout: 20000, retries: 0 });
      if (crypto.createHash('sha1').update(text).digest('hex') !== mapping.sha1) throw new Error('Minecraft mappings checksum mismatch');
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, text, 'utf8');
    }
    let tiny = '';
    if (entry.loader === 'fabric' || entry.loader === 'quilt') {
      const jar = path.join(config.dirs.libraries(), 'net/fabricmc/intermediary', entry.mcVersion, `intermediary-${entry.mcVersion}.jar`);
      tiny = new (require('adm-zip'))(jar).readAsText('mappings/mappings.tiny');
      if (!tiny) throw new Error('Intermediary mappings missing');
    }
    return parseMappings(text, tiny);
  } catch (e) {
    log.warn(`Party automation mappings: ${e.message}`);
    return {};
  }
}
module.exports = { forEntry, parseMappings };
