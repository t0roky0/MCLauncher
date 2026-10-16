// A launcher profile as the window shows it — yours on the Profile page, a
// friend's in their card: the hours played, where (servers, worlds of one's
// own), the last time, playing now, and the items (the catalogue's names,
// rarities and icons).
import { h } from './dom.js';
import { t, getLang } from './i18n.js';
import { icon } from './icons.js';

const ru = () => getLang() !== 'en';
export const itemIcon = (id) => `mcl://app/assets/cosmetics/${id}/icon.png`;
const RARITY = { common: '#a9a49e', rare: '#6cb6ef', epic: '#b48cf0', legendary: '#ecb84f' };

// 12 ч 30 мин / 45 мин / 0 мин
export function hours(ms) {
  const m = Math.floor((ms || 0) / 60000);
  const hh = Math.floor(m / 60);
  if (ru()) return hh ? `${hh} ч${m % 60 ? ` ${m % 60} мин` : ''}` : `${m} мин`;
  return hh ? `${hh} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
}

export const serverName = (host) => host || (ru() ? 'Одиночная игра' : 'Singleplayer');

// "только что", "5 мин назад", "вчера", "12 окт."
export function ago(at) {
  if (!at) return '—';
  const d = Date.now() - at;
  const m = Math.round(d / 60000);
  if (m < 2) return ru() ? 'только что' : 'just now';
  if (m < 60) return ru() ? `${m} мин назад` : `${m} min ago`;
  const hh = Math.round(m / 60);
  if (hh < 24) return ru() ? `${hh} ч назад` : `${hh} h ago`;
  if (hh < 48) return ru() ? 'вчера' : 'yesterday';
  return new Date(at).toLocaleDateString(ru() ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short' });
}

// a server's tile: its first letter on a colour of its own
function serverTile(host) {
  if (!host) return h('div.pf-srv-ic.world', icon('globe'));
  let x = 0;
  for (const ch of host) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return h('div.pf-srv-ic', { style: { '--hue': String(x % 360) } }, host.replace(/^www\./, '')[0].toUpperCase());
}

// "playing now" — a server, a world of one's own
export function playingChip(playing) {
  if (playing === null || playing === undefined) return null;
  return h('span.pf-playing', h('i'), `${ru() ? 'Играет' : 'Playing'}: ${serverName(playing)}`);
}

// The four numbers: hours, favourite server, last time, items.
export function statTiles(p, owned, total) {
  const fav = (p.servers || [])[0];
  const tile = (ic, value, label, tip) => h('div.pf-stat', tip ? { 'data-tip': tip } : null, h('div.pf-stat-ic', icon(ic)), h('div.pf-stat-v', value), h('div.pf-stat-k', label));
  return h(
    'div.pf-stats',
    tile('clock', hours(p.ms), ru() ? 'Наиграно' : 'Played'),
    tile('star', fav ? serverName(fav.host) : '—', ru() ? 'Любимое место' : 'Favourite', fav ? hours(fav.ms) : null),
    tile('play', p.last ? ago(p.last.at) : '—', ru() ? 'Последняя игра' : 'Last played', p.last ? serverName(p.last.host) : null),
    tile('sparkle', total ? `${owned} / ${total}` : String(owned), ru() ? 'Предметов' : 'Items'),
  );
}

// Where one plays: the servers by hours, bars against the first.
export function serverList(servers, { limit = 6 } = {}) {
  const list = (servers || []).filter((s) => s.ms >= 60000).slice(0, limit);
  if (!list.length) return h('div.pf-empty', icon('globe', { scale: 2 }), h('div', ru() ? 'Пока ни одного часа — зайди в игру через лаунчер, и здесь появятся сервера и миры.' : 'No hours yet — play through the launcher and your servers and worlds show up here.'));
  const top = list[0].ms;
  return h('div.pf-servers', list.map((s) => h(
    'div.pf-srv',
    serverTile(s.host),
    h('div.pf-srv-text', h('div.pf-srv-name', { 'data-tip': serverName(s.host) }, serverName(s.host)), h('div.pf-bar', h('i', { style: { width: `${Math.max(4, Math.round((s.ms / top) * 100))}%` } }))),
    h('div.pf-srv-h', hours(s.ms)),
  )));
}

// The items one has, from the catalogue (cosmetics:state's items). What's
// worn isn't shown: that's the player's own business.
export function itemGrid(ids, catalogue) {
  const cat = new Map((catalogue || []).map((i) => [i.id, i]));
  const list = (ids || []).map((id) => cat.get(id)).filter(Boolean);
  if (!list.length) return h('div.pf-empty', icon('sparkle', { scale: 2 }), h('div', ru() ? 'Предметов пока нет — их дают события, коды и магазин.' : 'No items yet — events, codes and the shop give them.'));
  const order = { legendary: 0, epic: 1, rare: 2, common: 3 };
  list.sort((a, b) => (order[a.rarity] ?? 4) - (order[b.rarity] ?? 4));
  return h('div.pf-items', list.map((it) => h(
    'div.pf-item',
    { style: { '--r': RARITY[it.rarity] || RARITY.common }, 'data-tip': `${ru() ? it.name : it.nameEn || it.name} · ${t(`cos.rarity.${it.rarity}`)}` },
    h('img', { src: itemIcon(it.id), alt: '', draggable: false }),
  )));
}

// A friend's whole launcher profile (their card's "Profile"): the picture and
// name, playing now, the four numbers, where they play, their items.
// who: { gamertag, picture (the Xbox one, when they have no picture of their own) }
export function profileView(p, who, catalogue) {
  const pic = p.avatar || who.picture;
  const name = p.name || who.gamertag;
  return h('div.pf-wrap.pf-friend',
    h('div.pf-hero', h('div.pf-hero-in',
      h('div.pf-pic', { class: p.avatar ? 'own' : '' }, pic ? h('img', { src: pic, alt: '' }) : h('span.pf-letter', (name || '?').slice(0, 1).toUpperCase())),
      h('div.pf-id',
        h('div.pf-name-row', h('div.pf-name', name)),
        h('div.pf-sub', h('span', `Xbox: ${who.gamertag}`), p.last ? h('span.dot', '·') : null, p.last ? h('span', `${ru() ? 'Был в игре' : 'Last played'} ${ago(p.last.at)}`) : null),
        h('div.pf-chips', playingChip(p.playing))))),
    statTiles(p, (p.items || []).length, (catalogue || []).length),
    h('div.pf-cols',
      h('div.card.pf-card', h('div.section-title', icon('globe'), ru() ? 'Где играет' : 'Where they play'), serverList(p.servers)),
      h('div.card.pf-card', h('div.section-title', icon('sparkle'), ru() ? 'Предметы' : 'Items'), itemGrid(p.items, catalogue))));
}
