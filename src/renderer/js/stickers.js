// Party chat stickers: a pixel-art pack (assets/stickers, 64x64; small/ has
// the 32x32 versions for the picker), shown 1:1 with pixelated scaling.
//
// The first sixteen keep the ids of the launcher's earlier drawn stickers, so
// a friend on an older version sends and gets the same ones; "skull" (gone)
// shows as the cookie, anything unknown as the question mark.

export const STICKER_IDS = [
  'heart', 'gg', 'lol', 'cry', 'wow', 'zzz', 'thumb', 'party', 'creeper',
  'pig', 'diamond', 'sword', 'tnt', 'fire', 'cookie', 'cake', 'question',
  'warden', 'monkey', 'villager', 'emerald', 'grass', 'axolotl', 'enderman',
  'bee', 'pickaxe', 'golden_apple',
];

const RENAMED = { skull: 'cookie' };

// stickerUrl('heart') → the 64x64 PNG; small → the 32x32 one.
export function stickerUrl(id, small = false) {
  id = RENAMED[id] || id;
  if (!STICKER_IDS.includes(id)) id = 'question';
  return `mcl://app/assets/stickers/${small ? 'small/' : ''}${id}.png`;
}
