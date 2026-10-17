'use strict';
// The renderer's only door to the main process: a whitelisted invoke() and
// on() under window.mcl. No Node, no ipcRenderer, no arbitrary channels.

const { contextBridge, ipcRenderer } = require('electron');

const CALLS = /^(win|app|console|config|accounts|installs|versions|game|worlds|servers|skins|friends|log|java|bedrock|party|tunnel|messages|nearby|voice|cosmetics|shop|net|profile|profiles|fixer|quests):[A-Za-z]+$/;
// fire-and-forget messages: the tunnel's bytes, too many for invoke round trips
const SENDS = new Set(['tunnel:data', 'tunnel:close', 'tunnel:pause']);
const EVENTS = new Set([
  'win:maximized',
  'config:changed',
  'installs:changed',
  'task',
  'task:done',
  'task:error',
  'task:cancelled',
  'game',
  'friends:changed',
  'friends:lobbies',
  'friends:lobbyOpened',
  'messages:changed',
  'messages:incoming',
  'notice',
  'party:discordJoin',
  'discord:request',
  'tunnel:accept',
  'tunnel:data',
  'tunnel:closed',
  'tunnel:host',
  'tunnel:join',
  'tunnel:lost',
  'party:changed',
  'party:start',
  'party:invite',
  'cosmetics:redeemLink',
  'quests:changed',
  'quests:claimed',
  'party:chat',
  'party:signal',
  'party:emote',
  'party:audio',
  'win:visible',
  'voice:ptt',
  'voice:command',
  'cosmetics:changed',
  'nearby:changed',
  'nearby:signal',
  'log:lines',
  'nav',
  'toast',
  'update:ready',
  'shop:paid',
  'shop:changed',
  'profile:changed',
]);

async function invoke(channel, ...args) {
  if (!CALLS.test(channel)) throw new Error(`blocked channel ${channel}`);
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r && r.ok) return r.data;
  const err = new Error((r && r.error) || 'IPC error');
  err.code = (r && r.code) || '';
  throw err;
}

function on(event, fn) {
  if (!EVENTS.has(event)) throw new Error(`blocked event ${event}`);
  const listener = (_e, payload) => fn(payload);
  ipcRenderer.on(event, listener);
  return () => ipcRenderer.removeListener(event, listener);
}

function send(channel, ...args) {
  if (!SENDS.has(channel)) throw new Error(`blocked channel ${channel}`);
  ipcRenderer.send(channel, ...args);
}

contextBridge.exposeInMainWorld('mcl', { invoke, on, send, platform: process.platform });
