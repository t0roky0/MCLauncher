'use strict';
// The overlay's game settings (config.game) for both games:
// - Java: "#comfort" lines in the agent's data file (game-skins.js writes it;
//   the agent reads it every quarter second — agent Comfort.java);
// - Bedrock: comfort.ini next to the module's bridge (bedrock-native
//   comfort.cpp reads it every half second).
// The zoom key is kept as the browser's KeyboardEvent.code; each game wants
// its own number for it: Java's GLFW key (1.21 and older), its SDL scancode
// (26.x: the game's input is SDL's), Windows' virtual key (Bedrock).

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const config = require('./config');
const log = require('./log');

// code → [GLFW, SDL scancode, Windows VK]
const KEYS = { Space: [32, 44, 0x20], Tab: [258, 43, 0x09], CapsLock: [280, 57, 0x14], Backquote: [96, 53, 0xc0],
  ShiftLeft: [340, 225, 0xa0], ControlLeft: [341, 224, 0xa2], AltLeft: [342, 226, 0xa4], ShiftRight: [344, 229, 0xa1], ControlRight: [345, 228, 0xa3], AltRight: [346, 230, 0xa5],
  Minus: [45, 45, 0xbd], Equal: [61, 46, 0xbb], BracketLeft: [91, 47, 0xdb], BracketRight: [93, 48, 0xdd], Backslash: [92, 49, 0xdc], Semicolon: [59, 51, 0xba],
  Quote: [39, 52, 0xde], Comma: [44, 54, 0xbc], Period: [46, 55, 0xbe], Slash: [47, 56, 0xbf] };
for (let i = 0; i < 26; i++) KEYS[`Key${String.fromCharCode(65 + i)}`] = [65 + i, 4 + i, 0x41 + i];
for (let i = 1; i <= 9; i++) KEYS[`Digit${i}`] = [48 + i, 29 + i, 0x30 + i];
KEYS.Digit0 = [48, 39, 0x30];
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = [289 + i, 57 + i, 0x6f + i];
// the mouse's side buttons (Bedrock: Windows' XBUTTON keys; Java: not a key — the default C then)
KEYS.Mouse4 = [-1, -1, 0x05];
KEYS.Mouse5 = [-1, -1, 0x06];

const keyOf = (code) => KEYS[code] || KEYS.KeyC;

// a key's name for the window: "C", "F6", "Left Alt"…
function keyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  return { Space: 'Space', Tab: 'Tab', CapsLock: 'Caps Lock', Backquote: '`', ShiftLeft: 'Left Shift', ControlLeft: 'Left Ctrl', AltLeft: 'Left Alt',
    ShiftRight: 'Right Shift', ControlRight: 'Right Ctrl', AltRight: 'Right Alt', Mouse4: 'Mouse 4', Mouse5: 'Mouse 5' }[code] || code;
}

// Java's lines (the agent's data file)
function agentLines() {
  const g = (config.get() || {}).game || {};
  const [glfw, sdl] = keyOf(g.zoomKey);
  const bool = (v) => (v ? '1' : '0');
  return [
    `#comfort\tfullbright\t${bool(g.fullbright)}`,
    `#comfort\tzoom\t${bool(g.zoom && glfw > 0)}`,
    `#comfort\tzoomKey\t${glfw > 0 ? glfw : 67}`,
    `#comfort\tzoomScancode\t${sdl > 0 ? sdl : 6}`,
    `#comfort\tzoomLevel\t${g.zoomLevel || 4}`,
    `#comfort\tzoomSmooth\t${bool(g.zoomSmooth !== false)}`,
    `#comfort\tvsync\t${g.vsync || 'game'}`,
    `#comfort\tautoSprint\t${bool(g.autoSprint)}`,
    `#comfort\tnoFire\t${bool(g.noFire)}`,
  ];
}

const iniFile = () => path.join(paths.appDir, 'bedrock-bridge', 'comfort.ini');

// Bedrock's comfort.ini: all of it, whole (a temporary file put in its place);
// the module's own F8 panel writes the same keys, so what's there is kept.
let lastIni = '';
function writeBedrock() {
  const g = (config.get() || {}).game || {};
  const vk = keyOf(g.zoomKey)[2];
  let fov = 0;
  let sens = { value: NaN, guess: 0 };
  try { fov = require('./bedrock').fieldOfView(); } catch { /* no Bedrock */ }
  // the mouse's sensitivity (slower while zoomed, as in OptiFine): its value and number, to find it in the game
  try { sens = require('./bedrock').optionHint('ctrl_sensitivity2_mouse'); } catch { /* no Bedrock */ }
  const values = {
    autoSprint: g.autoSprint ? 1 : 0,
    fullbright: g.fullbright ? 1 : 0,
    zoom: g.zoom ? 1 : 0,
    zoomKey: vk,
    zoomLevel: g.zoomLevel || 4,
    zoomSmooth: g.zoomSmooth === false ? 0 : 1,
    fovHint: fov,
    sensHint: Number.isFinite(sens.value) ? sens.value : 0,
    sensGuess: sens.guess || 0,
    vsync: { game: 0, on: 1, off: 2 }[g.vsync] || 0,
  };
  const text = `﻿[comfort]\r\n${Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\r\n')}\r\n`;
  if (text === lastIni && fs.existsSync(iniFile())) return;
  try {
    fs.mkdirSync(path.dirname(iniFile()), { recursive: true });
    fs.writeFileSync(`${iniFile()}.tmp`, text, 'utf16le');
    fs.renameSync(`${iniFile()}.tmp`, iniFile());
    lastIni = text;
  } catch (e) {
    // the module is reading it this very moment: again on the next change (or in a second)
    if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) setTimeout(writeBedrock, 1000);
    else log.warn(`Game settings (Bedrock): ${e.message}`);
  }
}

// Both games: after any change of config.game
let lastGame = '';
let lastFire = null;
function apply(force = false) {
  const now = JSON.stringify((config.get() || {}).game || {});
  if (!force && now === lastGame) return;
  lastGame = now;
  writeBedrock();
  // Bedrock's low fire is a file the game gets from us (bedrock-cosmetics.js): in line on the next world
  const fire = !!((config.get() || {}).game || {}).noFire;
  if (lastFire !== null && fire !== lastFire) require('./bedrock-cosmetics').sync().catch((e) => log.warn(`Bedrock low fire: ${e.message}`));
  lastFire = fire;
  try { require('./game-skins').refresh(); } catch (e) { log.warn(`Game settings (Java): ${e.message}`); }
}

module.exports = { agentLines, writeBedrock, apply, keyName, KEYS };
