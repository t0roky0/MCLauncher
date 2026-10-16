const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('shop preview: dragging stops auto rotation, refresh preserves the canvas, resize preserves user zoom', async () => {
  const nodes = [], stages = [], observers = [], requests = [];
  const h = (tag, ...args) => {
    const node = { tag, children: [], swaps: 0, style: { setProperty() {} }, classList: { add() {}, toggle() {} },
      append(...els) { this.children.push(...els.flat().filter(x => x && x.tag)); },
      getBoundingClientRect: () => ({ width: 210, height: 380 }) };
    node.append(...args); nodes.push(node); return node;
  };
  class SkinStage {
    constructor() {
      const listeners = new Map();
      const controls = { listeners, addEventListener: (k, f) => listeners.set(k, f), removeEventListener: k => listeners.delete(k) };
      const camera = { aspect: 260 / 340, position: { length: () => 4.5 + 16.5 / Math.tan(38 * Math.PI / 360) / this.viewer.zoom } };
      this.viewer = { controls, camera, fov: 38, playerWrapper: { position: {} } }; stages.push(this);
    }
    setAutoRotate(v) { this.viewer.autoRotate = v; }
    setAnimation() {}
    setSkin() { return Promise.resolve(); }
    setCosmetics() { return Promise.resolve(); }
    resize(w, h) { this.viewer.camera.aspect = w / h; }
    dispose() { this.disposed = true; }
  }
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/pages/shop.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export function mount', 'function mount');
  const ctx = { h, SkinStage, Map, Math, Promise, t: s => s, getLang: () => 'en',
    swap: (node, ...els) => { node.children = els.flat().filter(x => x && x.tag); node.swaps++; },
    bag: () => { const callbacks = []; return { add: f => callbacks.push(f), dispose: () => callbacks.forEach(f => f()) }; },
    icon: () => h('svg'), button: () => h('button'), spinner: () => h('span'),
    onEvent: () => () => {}, store: { get: () => ({}) }, currentAppearance: () => Promise.resolve({url:'skin',model:'classic'}),
    api: () => new Promise(resolve => requests.push(resolve)),
    ResizeObserver: class { constructor(f) { this.callback = f; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
  };
  vm.createContext(ctx); vm.runInContext(source + '\nthis.mount = mount;', ctx);
  const cleanup = ctx.mount(h('root'));
  const state = { online: true, coins: 600, packs: [{id:'fallen_pack',name:'Fallen Angel',items:[{id:'fallen_wings'},{id:'horned_halo'}],price:600}] };
  requests[0](state); await new Promise(setImmediate);
  assert.equal(stages.length, 1);
  const stage = stages[0], list = nodes.find(n => n.tag === 'div.shop-list');
  observers[0].callback();
  assert.ok(stage.viewer.controls.maxDistance >= stage.viewer.camera.position.length(), 'fit is not clamped by OrbitControls');
  assert.equal(stage.viewer.autoRotate, true);
  stage.viewer.controls.listeners.get('start')();
  assert.equal(stage.viewer.autoRotate, false);
  stage.viewer.zoom = 1.25;
  requests[1]({...state, coins: 700}); await new Promise(setImmediate);
  assert.equal(list.swaps, 1, 'wallet response must not detach a captured canvas');
  assert.equal(stages.length, 1);
  assert.equal(stage.viewer.autoRotate, false);
  observers[0].callback();
  assert.equal(stage.viewer.zoom, 1.25);
  cleanup();
  assert.equal(stage.disposed, true);
  assert.equal(observers[0].disconnected, true);
  assert.equal(stage.viewer.controls.listeners.size, 0);
});
