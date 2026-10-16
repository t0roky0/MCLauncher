'use strict';
// MCP's published SRG names are stable on Forge, and map to each vanilla
// release's obfuscated names. No guessed class names across game versions.
const CLASSES = {
  capeLayer: 'net/minecraft/client/renderer/entity/layers/LayerCape',
  player: 'net/minecraft/entity/player/EntityPlayer', entity: 'net/minecraft/entity/Entity',
  equipmentSlot: 'net/minecraft/inventory/EntityEquipmentSlot', itemStack: 'net/minecraft/item/ItemStack',
};
const MEMBERS = {
  'capeLayer.render': ['net/minecraft/client/renderer/entity/layers/LayerCape/func_177166_a', 'AbstractClientPlayer'],
  'capeLayer.renderer': ['net/minecraft/client/renderer/entity/layers/LayerCape/field_177167_a'],
  'player.getGameProfile': ['net/minecraft/entity/player/EntityPlayer/func_146103_bH'],
  'player.getCurrentArmor': ['net/minecraft/entity/player/EntityPlayer/func_71124_b'],
  'entity.isInvisible': ['net/minecraft/entity/Entity/func_82150_aj'],
  'renderer.getModel': ['net/minecraft/client/renderer/entity/RenderPlayer/func_177087_b', 'ModelBase'],
  'modelPart.postRender': ['net/minecraft/client/model/ModelRenderer/func_78794_c'],
  'humanoidModel.head': ['net/minecraft/client/model/ModelBiped/field_78116_c'],
  'humanoidModel.body': ['net/minecraft/client/model/ModelBiped/field_78115_e'],
  'living.getItemBySlot': ['net/minecraft/entity/player/EntityPlayer/func_184582_a'],
  'itemStack.isEmpty': ['net/minecraft/item/ItemStack/func_190926_b'],
  'equipmentSlot.HEAD': ['net/minecraft/inventory/EntityEquipmentSlot/HEAD'],
  'equipmentSlot.CHEST': ['net/minecraft/inventory/EntityEquipmentSlot/CHEST'],
};
function parseSrg(text, forge = false) {
  const result = {'cosmetic.api':'legacy'};
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'CL:') {
      for (const [key, name] of Object.entries(CLASSES)) if (p[2] === name) result[`class.${key}`] = (forge ? p[2] : p[1]).replaceAll('/', '.');
    } else if (p[0] === 'MD:' || p[0] === 'FD:') {
      const method = p[0] === 'MD:', named = p[method ? 3 : 2];
      for (const [key, [name, signature]] of Object.entries(MEMBERS)) {
        if (named !== name || (signature && !p[4].includes(signature))) continue;
        result[key] = (forge ? named : p[1]).split('/').pop();
        if (key === 'capeLayer.render') result[`${key}Desc`] = p[forge ? 4 : 2];
      }
    }
  }
  if (!result['class.capeLayer'] || !result['capeLayer.renderDesc']) throw Error('MCP cape mapping missing');
  return result;
}
module.exports = {parseSrg};
