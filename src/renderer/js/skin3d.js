// 3D skins and capes (skinview3d on three.js), plus the 2D crops the rest
// of the UI uses: a player's face for avatars, a cape's outer side for the
// cape picker.
import * as skinview3d from 'skinview3d';
import { Box3, DoubleSide, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BendRig } from './bend-rig.js';
import { wearCosmetics, cosmeticBase } from './cosmetics3d.js';
import { EMOTES, envelope } from './emotes.js';
export { EMOTE_IDS } from './emotes.js';

export const STEVE = 'mcl://app/assets/images/skins/steve.png';
export const ALEX = 'mcl://app/assets/images/skins/alex.png';

// Room over the head for what the launcher's cosmetics put there (the axe's
// handle reaches about 12.7 units over it, the hat 11.6). Every figure is
// framed with it, wearing something or not, so a cosmetic never makes its
// wearer smaller than the others.
export const HEADROOM = 13;

// The camera for a figure: from `below` under the feet to `above` over the
// head room, the figure lowered so that span is centred.
function frameFigure(viewer, below, above) {
  const top = 16 + HEADROOM + above;
  const bottom = -16 - below;
  const half = (top - bottom) / 2;
  const tan = Math.tan((viewer.fov * Math.PI) / 360);
  // skinview3d: distance = 4.5 + 16.5 / tan / zoom, so this half-height shows
  viewer.zoom = 16.5 / (half - 4.5 * tan);
  viewer.playerWrapper.position.y = -(top + bottom) / 2;
}

// The launcher's cosmetics (ids from the catalogue) on a stage's player; the
// same list again does nothing.
async function putOn(stage, ids) {
  const list = (Array.isArray(ids) ? ids : []).filter((id) => /^[a-z0-9_]{1,32}$/.test(id));
  const key = list.join(',');
  if (key === (stage.cosKey || '')) return;
  stage.cosKey = key;
  const done = await wearCosmetics(stage.viewer.playerObject, list.map(cosmeticBase), () => stage.cosKey === key);
  if (!done) return;
  coverBack(stage);
  stage.dirty = true;
  if (stage.onPlaced) stage.onPlaced();
}

// Something worn on the back takes the place of the cape (and the elytra).
function coverBack(stage) {
  const p = stage.viewer.playerObject;
  const back = p.skin.body.children.some((c) => c.name.startsWith('cosmetic:') && c.userData.slot === 'back');
  p.backEquipment = back ? null : stage.backWanted || null;
  stage.dirty = true;
}

// The base layer must discard transparent texels too (otherwise they render
// black), and like the game both layers are drawn from both sides: through a
// see-through part of a skin you see the inside of the figure, not the
// background.
// Only the skin's own layers: cosmetics on the head or body keep their own
// sides (an outline's shell is drawn from inside only — both ways, it covers
// the halo it goes round). In one pass: three.js draws a transparent
// two-sided material twice, marking it changed before each — its shader
// looked up anew for every draw, every frame (most of the lobby's time).
function preserveSkinAlpha(viewer) {
  const skin = viewer.playerObject.skin;
  for (const part of [skin.head, skin.body, skin.rightArm, skin.leftArm, skin.rightLeg, skin.leftLeg]) {
    for (const layer of [part.innerLayer, part.outerLayer]) {
      for (const material of [layer && layer.material].flat().filter(Boolean)) {
        material.alphaTest = 0.01;
        material.side = DoubleSide;
        material.forceSinglePass = true;
        material.needsUpdate = true;
      }
    }
  }
}

const ANIMATIONS = {
  idle: () => new skinview3d.IdleAnimation(),
  walk: () => {
    const a = new skinview3d.WalkingAnimation();
    a.headBobbing = true;
    return a;
  },
  run: () => new skinview3d.RunningAnimation(),
  fly: () => new skinview3d.FlyingAnimation(),
  wave: () => new skinview3d.WaveAnimation('right'),
  crouch: () => new skinview3d.CrouchAnimation(),
};

// skinview3d draws every frame the monitor shows (144, 240 Hz): no more than
// fps a second instead, the monitor's own rate while it's being turned. Its
// clock counts the time between the frames drawn, so motion keeps its speed.
function capFps(v, fps) {
  const draw = v.draw.bind(v);
  let last = performance.now();
  let acc = 0;
  v.draw = () => {
    const t = performance.now();
    acc += t - last;
    last = t;
    if (v._disposed) return;
    if (acc >= 1000 / fps - 4 || v.isUserRotating) {
      acc = 0;
      draw();
    } else if (!v.renderPaused && !v._disposed) {
      v.animationID = window.requestAnimationFrame(() => v.draw());
    }
  };
}

export class SkinStage {
  // hit: the element the mouse turns and zooms it from (else the canvas) —
  // the canvas then draws a larger picture round it, nothing cut at its
  // edges, and lets the mouse through to what's under it
  constructor(canvas, { width = 320, height = 420, interactive = true, hit = null } = {}) {
    this.viewer = new skinview3d.SkinViewer({
      canvas,
      width,
      height,
      pixelRatio: Math.max(2, window.devicePixelRatio || 1),
      fov: 38,
      zoom: 0.86,
      enableControls: interactive,
    });
    const v = this.viewer;
    v.globalLight.intensity = 2.7;
    v.cameraLight.intensity = 0.95;
    v.controls.enableZoom = interactive;
    v.controls.minDistance = 22;
    v.controls.maxDistance = 90;
    v.controls.rotateSpeed = 0.7;
    v.autoRotate = false;
    v.autoRotateSpeed = 0.9;
    v.playerWrapper.rotation.y = -0.42;
    frameFigure(v, 3.5, 1.5);
    capFps(v, 60);
    this.setAnimation('idle');
    this.skinUrl = '';
    this.capeUrl = '';
    this.backEquipment = 'cape';
    if (hit && interactive) this.bindControls(hit);
  }

  // the camera's controls on another element, as they were set
  bindControls(el) {
    const v = this.viewer;
    const old = v.controls;
    const c = new OrbitControls(v.camera, el);
    for (const k of ['enablePan', 'enableZoom', 'enableRotate', 'minDistance', 'maxDistance', 'rotateSpeed', 'enableDamping', 'dampingFactor', 'autoRotate', 'autoRotateSpeed']) c[k] = old[k];
    c.target.copy(old.target);
    old.dispose();
    v.controls = c;
    // skinview3d knows a drag from the canvas's own mouse events: from these now
    c.addEventListener('start', () => { v.isUserRotating = true; });
    c.addEventListener('end', () => { v.isUserRotating = false; });
    c.update();
  }

  async setSkin(url, model = 'classic') {
    this.skinUrl = url || STEVE;
    await this.viewer.loadSkin(this.skinUrl, { model: model === 'slim' ? 'slim' : 'default' });
    preserveSkinAlpha(this.viewer);
  }

  async setCape(url) {
    this.capeUrl = url || '';
    if (!url) {
      this.viewer.resetCape();
      this.backWanted = null;
      return;
    }
    await this.viewer.loadCape(url, { backEquipment: this.backEquipment });
    this.backWanted = this.backEquipment;
    coverBack(this);
  }

  setCosmetics(ids) {
    return putOn(this, ids);
  }

  // A pet on its own (the shop): the player out of sight, the camera going
  // slowly round the pet itself (the mouse turns and brings it closer).
  async showcase(ids) {
    await putOn(this, ids);
    const p = this.viewer.playerObject;
    const skin = p.skin;
    for (const part of [skin.head, skin.body, skin.leftArm, skin.rightArm, skin.leftLeg, skin.rightLeg]) {
      part.innerLayer.visible = false;
      part.outerLayer.visible = false;
    }
    if (p.cape) p.cape.visible = false;
    if (p.elytra) p.elytra.visible = false;
    this.setAutoRotate(false);
    this.showcased = skin.children.find((c) => c.name.startsWith('cosmetic:')) || null;
    this.frameShowcase();
  }

  // the camera on the pet: all of it in view, from in front and a little to the side, a little above
  frameShowcase() {
    const o = this.showcased;
    if (!o) return;
    const v = this.viewer;
    // the whole scene: before its first frame the player's wrapper (lowered,
    // turned) isn't in its children's places yet — the pet measured where it
    // isn't, the camera then going round a point beside it
    v.scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(o);
    const centre = box.getCenter(new Vector3());
    // its float up and down (model.float.bob) is in the room it's given
    const size = box.getSize(new Vector3()).length() + 2.5;
    // fitAspect: the shape it's to fit in (the shop: its column; the canvas may be wider)
    const fit = Math.min(1, this.fitAspect || v.camera.aspect || 1);
    const dist = (((size / 2) / Math.tan((v.camera.fov * Math.PI) / 360)) * 1.3) / fit;
    const a = -0.55;
    v.controls.target.copy(centre);
    v.camera.position.copy(centre).add(new Vector3(Math.sin(a), 0.32, Math.cos(a)).normalize().multiplyScalar(dist));
    v.camera.lookAt(centre);
    v.controls.minDistance = dist * 0.45;
    v.controls.maxDistance = dist * 2.4;
    v.controls.autoRotate = true;
    // as fast as the player turns in the shop (0.6 rad/s): OrbitControls turns 2π/60·speed a second at 60 frames
    v.controls.autoRotateSpeed = 5.7;
    v.controls.update();
  }

  setElytra(on) {
    this.backEquipment = on ? 'elytra' : 'cape';
    if (this.capeUrl) {
      this.backWanted = this.backEquipment;
      coverBack(this);
    }
  }

  setAnimation(name) {
    const make = ANIMATIONS[name] || ANIMATIONS.idle;
    this.viewer.animation = make();
    this.animationName = name;
  }

  setAutoRotate(on) {
    this.viewer.autoRotate = !!on;
  }

  setPaused(paused) {
    this.viewer.renderPaused = !!paused;
  }

  resize(w, h) {
    this.viewer.setSize(w, h);
  }

  dispose() {
    this.viewer.dispose();
    // the context itself now, not when the page is collected (the browser keeps only so many)
    try { this.viewer.renderer.forceContextLoss(); } catch { /* gone already */ }
  }
}

// ---- lobby ---------------------------------------------------------------------

const PI = Math.PI;

// Every frame starts from skinview3d's own rest pose (joints, cape, elytra)
// with the player itself back at the origin.
function resetPlayer(p) {
  p.resetJoints();
  p.position.set(0, 0, 0);
  p.rotation.set(0, 0, 0);
}

const JOINTS = (p) => [p, p.skin.head, p.skin.body, p.skin.leftArm, p.skin.rightArm, p.skin.leftLeg, p.skin.rightLeg, p.cape];
const lerp = (a, b, w) => a + (b - a) * w;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// The lobby's player: idles (skinview3d's breathing), plays one emote at a
// time — blended in from the idle pose and back out — and turns the head
// toward the cursor.
export class LobbyAnimation extends skinview3d.PlayerAnimation {
  constructor() {
    super();
    this.idle = new skinview3d.IdleAnimation();
    this.active = null;
    this.rig = null;
    this.look = { x: 0, y: 0, tx: 0, ty: 0 };
    this.hop = 0;
  }

  play(id) {
    if (!EMOTES[id]) return false;
    this.active = { id, time: 0 };
    return true;
  }

  stop() {
    this.active = null;
  }

  animate(player, delta) {
    resetPlayer(player);
    this.idle.update(player, delta);
    let bends = { left: 0, right: 0, leftLeg: 0, rightLeg: 0 };
    const e = this.active;
    if (e) {
      const def = EMOTES[e.id];
      e.time += delta;
      if (e.time >= def.duration) {
        this.active = null;
      } else {
        const w = envelope(e.time, def.duration);
        const parts = JOINTS(player);
        const from = parts.map((o) => [o.position.clone(), o.rotation.clone()]);
        resetPlayer(player);
        const b = def.pose(player, e.time);
        parts.forEach((o, i) => {
          const [fp, fr] = from[i];
          o.position.set(lerp(fp.x, o.position.x, w), lerp(fp.y, o.position.y, w), lerp(fp.z, o.position.z, w));
          // a spin ends a full turn round: blend toward the nearest equal angle
          const ry = o === player ? wrapAngle(o.rotation.y) : o.rotation.y;
          o.rotation.set(lerp(fr.x, o.rotation.x, w), lerp(fr.y, ry, w), lerp(fr.z, o.rotation.z, w));
        });
        const scale = (v) => ({ x: (v.x || 0) * w, z: (v.z || 0) * w });
        bends = { left: scale(b.left), right: scale(b.right), leftLeg: scale(b.leftLeg || {}), rightLeg: scale(b.rightLeg || {}) };
      }
    }
    if (this.rig) this.rig.apply(bends.left, bends.right, bends.leftLeg, bends.rightLeg);
    const l = this.look;
    const k = Math.min(1, delta * 6);
    const tracking = this.active ? 0.25 : 1;
    l.x += (l.tx - l.x) * k;
    l.y += (l.ty - l.y) * k;
    player.skin.head.rotation.y += l.x * 0.7 * tracking;
    player.skin.head.rotation.x += l.y * 0.45 * tracking;
    player.skin.body.rotation.y += l.x * 0.08 * tracking;
    if (this.hop > 0) {
      this.hop = Math.max(0, this.hop - delta * 2.4);
      player.position.y += Math.sin(this.hop * PI) * 4;
    }
  }
}

// ---- one clock for every lobby figure -------------------------------------------
// skinview3d gives every viewer its own loop. The lobby's figures share one
// instead: 60 frames a second (a 144 or 240 Hz monitor's every frame kept a
// whole core busy for a figure that sways), the monitor's own rate while a
// figure is dragged, none while the window is hidden (setLobbyFps(0)).
const figures = new Set();
let lobbyFps = 60;
const dragging = () => [...figures].some((f) => f.dragging);
let clockId = 0;
let clockLast = 0;
let clockAcc = 0;

function clockTick(t) {
  clockId = requestAnimationFrame(clockTick);
  const dt = Math.min(0.25, Math.max(0, (t - clockLast) / 1000));
  clockLast = t;
  clockAcc += dt;
  if (!dragging() && clockAcc < 1 / lobbyFps - 0.004) return;
  const step = Math.min(0.1, clockAcc);
  clockAcc = 0;
  for (const f of figures) f.frame(step);
}

function clockStart() {
  if (clockId || !lobbyFps || !figures.size) return;
  clockLast = performance.now();
  clockAcc = 0;
  clockId = requestAnimationFrame(clockTick);
}

function clockStop() {
  cancelAnimationFrame(clockId);
  clockId = 0;
}

export function setLobbyFps(n) {
  lobbyFps = n;
  if (n) clockStart();
  else clockStop();
}

function addFigure(f) {
  figures.add(f);
  clockStart();
}

function removeFigure(f) {
  figures.delete(f);
  if (!figures.size) clockStop();
}

// Rendered at twice the screen's resolution: pixel-art skins stay sharp
// (anything less looks soft).
const lobbyPixelRatio = () => Math.min(2.5, (window.devicePixelRatio || 1) * 2);

// The player in the middle of the lobby: no orbit controls — dragging spins
// the model (it eases back to face you), a click is reported to the page.
export class LobbyStage {
  // hit: the element the figure is turned and clicked from (else the canvas):
  // the canvas draws round it, wider (wings, a pet), and lets the mouse through
  constructor(canvas, { width = 280, height = 320, onClick, hit = null } = {}) {
    this.viewer = new skinview3d.SkinViewer({
      canvas,
      width,
      height,
      pixelRatio: lobbyPixelRatio(),
      fov: 32,
      zoom: 0.95,
      enableControls: false,
      renderPaused: true,
    });
    const v = this.viewer;
    // drawn at twice the screen's resolution already: FXAA on top was a
    // second full-size pass every frame for no visible gain
    v.fxaaPass.enabled = false;
    // …and the picture went straight to the screen in linear colour, as
    // through the old pass (an sRGB conversion here washed the skins out)
    v.renderer.outputColorSpace = 'srgb-linear';
    v.globalLight.intensity = 2.6;
    v.cameraLight.intensity = 1.05;
    this.anim = new LobbyAnimation();
    v.animation = this.anim;
    this.restAngle = -0.22;
    this.angle = this.restAngle;
    this.spin = 0;
    this.dragging = false;
    v.playerWrapper.rotation.y = this.angle;
    v.playerObject.position.y = 0;
    frameFigure(v, 3, 0);
    this.onPlaced = null; // the page moves the name over the figure's top
    this.poseId = 'idle';
    this.onClick = onClick;

    let downX = 0;
    let lastX = 0;
    let moved = 0;
    const target = hit || canvas;
    this.onDown = (e) => {
      this.dragging = true;
      downX = lastX = e.clientX;
      moved = 0;
      target.setPointerCapture(e.pointerId);
    };
    this.onMove = (e) => {
      if (this.dragging) {
        const dx = e.clientX - lastX;
        lastX = e.clientX;
        moved = Math.max(moved, Math.abs(e.clientX - downX));
        this.angle += dx * 0.012;
        this.spin = dx * 0.012;
      }
      const r = canvas.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height * 0.22;
      this.anim.look.tx = Math.max(-1, Math.min(1, (e.clientX - cx) / (window.innerWidth * 0.45)));
      this.anim.look.ty = Math.max(-1, Math.min(1, (e.clientY - cy) / (window.innerHeight * 0.6)));
    };
    this.onUp = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      if (moved < 5 && this.onClick) this.onClick(e);
    };
    this.onLeave = () => {
      this.anim.look.tx = 0;
      this.anim.look.ty = 0;
    };
    target.addEventListener('pointerdown', this.onDown);
    this.target = target;
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    document.addEventListener('mouseleave', this.onLeave);
    this.canvas = canvas;

    this.paused = false;
    this.dirty = true;
    addFigure(this);
  }

  // One frame from the shared clock: ease the spin back toward the resting
  // three-quarter view (rates per 60 fps frame, scaled to the real step),
  // move the animation on, draw. With "fewer animations" the figure holds
  // still (an emote you ask for still plays) and is drawn only when
  // something changes: a drag, a new skin, a resize.
  frame(dt) {
    const v = this.viewer;
    let turning = this.dragging;
    if (!this.dragging) {
      const before = this.angle;
      const n = dt * 60;
      this.spin *= 0.92 ** n;
      this.angle += this.spin * n;
      const diff = this.restAngle - this.angle;
      const wrapped = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.angle += wrapped * (1 - 0.955 ** n);
      turning = Math.abs(this.angle - before) > 1e-4;
    }
    v.playerWrapper.rotation.y = this.angle;
    const moving = !this.paused || !!this.anim.active;
    if (!moving && !turning && !this.dirty) return;
    this.dirty = !!this.anim.active; // one more still frame after an emote ends
    if (moving) v.animation.update(v.playerObject, dt);
    v.render();
  }

  async setSkin(url, model = 'classic') {
    if (this.anim.rig) { this.anim.rig.dispose(); this.anim.rig=null; }
    await this.viewer.loadSkin(url || STEVE, { model: model === 'slim' ? 'slim' : 'default' });
    preserveSkinAlpha(this.viewer);
    this.anim.rig=new BendRig(this.viewer.playerObject.skin);
    this.dirty = true;
  }

  async setCape(url) {
    this.viewer.resetCape();
    this.backWanted = null;
    if (url) {
      await this.viewer.loadCape(url, { backEquipment: 'cape' });
      this.backWanted = 'cape';
    }
    coverBack(this);
  }

  // How far under the canvas's top edge the figure's highest point is (its
  // head, or what it wears there), in CSS pixels: the name goes just over it.
  topGap() {
    const v = this.viewer;
    v.playerWrapper.updateMatrixWorld(true);
    v.camera.updateMatrixWorld();
    const box = new Box3().setFromObject(v.playerObject.skin.head);
    if (box.isEmpty()) return 0;
    const p = new Vector3(0, box.max.y, 0).project(v.camera);
    return Math.max(0, Math.round(((1 - p.y) / 2) * v.height));
  }

  setCosmetics(ids) {
    return putOn(this, ids);
  }

  setPose(id) { if(id==='idle')this.anim.stop();else this.playEmote(id); }
  playEmote(id) { return this.anim.play(id); }
  stopEmote() { this.anim.stop(); }

  hop() {
    this.anim.hop = 1;
  }

  setPaused(paused) {
    this.paused = !!paused;
    this.dirty = true;
  }

  resize(w, h) {
    this.viewer.setSize(w, h);
    this.dirty = true;
  }

  dispose() {
    removeFigure(this);
    if(this.anim.rig)this.anim.rig.dispose();
    this.target.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    document.removeEventListener('mouseleave', this.onLeave);
    this.viewer.dispose();
    try { this.viewer.renderer.forceContextLoss(); } catch { /* gone already */ }
  }
}

// A friend in the party, beside your player: the same figure as yours —
// standing the same way, spun by dragging, looking at the cursor — in their
// skin, playing their emotes.
export class PartyFigure extends LobbyStage {
  constructor(canvas, { width = 160, height = 260, onClick } = {}) {
    super(canvas, { width, height, onClick });
    this.skinKey = '';
  }

  async setSkin(url, model = 'classic') {
    const key = `${(url || '').length}|${(url || '').slice(-32)}|${model}`;
    if (key === this.skinKey) return;
    this.skinKey = key;
    await super.setSkin(url, model);
  }
}

// ---- thumbnails: one offscreen viewer renders every card -------------------
let thumbViewer = null;
const thumbCache = new Map();
let queue = Promise.resolve();

function thumbStage() {
  if (thumbViewer) return thumbViewer;
  const canvas = document.createElement('canvas');
  thumbViewer = new skinview3d.SkinViewer({
    canvas,
    width: 180,
    height: 230,
    pixelRatio: 2,
    preserveDrawingBuffer: true,
    renderPaused: true,
    enableControls: false,
    fov: 34,
    zoom: 0.92,
  });
  thumbViewer.globalLight.intensity = 2.8;
  thumbViewer.cameraLight.intensity = 0.9;
  thumbViewer.animation = null;
  return thumbViewer;
}

// The library cards' fixed three-quarter pose.
function cardPose(v) {
  const p = v.playerObject;
  resetPlayer(p);
  v.playerWrapper.rotation.y = -0.5;
  p.skin.leftArm.rotation.x = 0.18;
  p.skin.rightArm.rotation.x = -0.18;
  p.skin.leftLeg.rotation.x = -0.14;
  p.skin.rightLeg.rotation.x = 0.14;
  p.skin.head.rotation.y = 0.25;
}

// The pose picker shows the player's own skin in every pose.
export function posePreview(url, model, poseId) {
  const key = `pose|${url}|${model}|${poseId}`;
  if (thumbCache.has(key)) return Promise.resolve(thumbCache.get(key));
  const job = queue.then(async () => {
    const v = thumbStage();
    await v.loadSkin(url || STEVE, { model: model === 'slim' ? 'slim' : 'default' });
    preserveSkinAlpha(v);
    v.resetCape();
    const p = v.playerObject;
    resetPlayer(p);
    v.playerWrapper.rotation.y = -0.3;
    const def = EMOTES[poseId];
    const bend = def ? def.pose(p, def.still) : { left: 0, right: 0 };
    const rig = new BendRig(p.skin);
    rig.apply(bend.left, bend.right, bend.leftLeg, bend.rightLeg);
    v.render();
    rig.dispose();
    resetPlayer(p);
    const data = v.canvas.toDataURL('image/png');
    thumbCache.set(key, data);
    return data;
  });
  queue = job.catch(() => null);
  return job;
}

// Renders `url` posed three-quarter on a transparent background; cached
// per URL (the URLs carry the file's mtime, so an edited skin re-renders).
export function skinThumbnail(url, model = 'classic', capeUrl = '', tight = false) {
  const key = `${url}|${model}|${capeUrl}|${tight}`;
  if (thumbCache.has(key)) return Promise.resolve(thumbCache.get(key));
  const job = queue.then(async () => {
    const v = thumbStage();
    await v.loadSkin(url, { model: model === 'slim' ? 'slim' : 'default' });
    preserveSkinAlpha(v);
    if (capeUrl) await v.loadCape(capeUrl);
    else v.resetCape();
    cardPose(v);
    v.render();
    // Lobby figures need their feet and nameplates aligned to the visible body,
    // not the transparent margins used by skin-library cards.
    let canvas = v.canvas;
    if (tight) {
      const crop = document.createElement('canvas');
      const w = canvas.width, h = canvas.height;
      crop.width = w; crop.height = h;
      const g = crop.getContext('2d');
      g.drawImage(canvas, 0, 0);
      const pixels = g.getImageData(0, 0, w, h).data;
      let left = w, top = h, right = -1, bottom = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (pixels[(y * w + x) * 4 + 3] > 0) {
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
      }
      if (right >= left) {
        crop.width = right - left + 1; crop.height = bottom - top + 1;
        g.drawImage(canvas, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
        canvas = crop;
      }
    }
    const data = canvas.toDataURL('image/png');
    thumbCache.set(key, data);
    return data;
  });
  queue = job.catch(() => null);
  return job;
}

// ---- 2D crops -----------------------------------------------------------------
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image failed: ${url}`));
    img.src = url;
  });
}

const faceCache = new Map();

// Face (base + hat layer) at 8 px per skin pixel, as a data URL.
export async function skinFace(url, size = 64) {
  const key = `${url}|${size}`;
  if (faceCache.has(key)) return faceCache.get(key);
  const img = await loadImage(url || STEVE);
  const unit = img.width / 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 8 * unit, 8 * unit, 8 * unit, 8 * unit, 0, 0, size, size);
  // A 64x32 legacy skin has the hat layer at the same place; a skin with
  // an opaque hat layer still composites correctly on top.
  g.drawImage(img, 40 * unit, 8 * unit, 8 * unit, 8 * unit, 0, 0, size, size);
  const data = c.toDataURL('image/png');
  faceCache.set(key, data);
  return data;
}

// The outer side of a cape (the part seen from behind), pixel-exact.
export async function capeFront(url, scale = 5) {
  const img = await loadImage(url);
  const unit = Math.max(1, Math.round(img.width / 64));
  const c = document.createElement('canvas');
  c.width = 10 * scale;
  c.height = 16 * scale;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, unit, unit, 10 * unit, 16 * unit, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

// Classic vs slim from the pixels: slim skins leave the arm's outer
// columns empty.
export async function detectModel(url) {
  try {
    const img = await loadImage(url);
    if (img.width < 64 || img.width !== img.height || img.width % 64) return 'classic';
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, 64, 64);
    const a = (x, y) => g.getImageData(x, y, 1, 1).data[3];
    return a(54, 20) === 0 && a(55, 20) === 0 && a(54, 25) === 0 ? 'slim' : 'classic';
  } catch {
    return 'classic';
  }
}
