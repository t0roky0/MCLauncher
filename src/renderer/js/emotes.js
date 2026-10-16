// Lobby emotes. Each one is a pure function of time: it poses the player
// and returns the elbow bends, so the lobby, the blend in/out and the
// picker's still frames all run the same code.
//
// skinview3d axes: arm/leg rotation.x < 0 swings forward; arm rotation.z
// lifts sideways (left arm +, right arm −); head rotation.x > 0 nods down,
// .y turns; positions are in skin pixels. Elbow bends (bend-rig.js) are
// {x, z}: x < 0 folds the forearm forward, z swings it sideways — toward
// the head is + for the left arm and − for the right.

const PI = Math.PI;
const { sin, cos, abs, max, min } = Math;
const CAPE = PI * 0.06;

const bend = (lx = 0, lz = 0, rx = 0, rz = 0) => ({ left: { x: lx, z: lz }, right: { x: rx, z: rz } });
// …with knees too: x > 0 folds the shin back
const bend4 = (arms, lk = 0, rk = 0) => ({ ...arms, leftLeg: { x: lk, z: 0 }, rightLeg: { x: rk, z: 0 } });
// Sitting on the ground: the hips come down a leg's length (the feet stand
// at y = -24, the hips at -12).

export const EMOTES = {
  // Right arm up, the forearm waving from the elbow; the head tips toward it.
  wave: {
    duration: 2.8,
    still: 0.9,
    pose(p, t) {
      const s = p.skin;
      const k = sin(t * 10.5);
      s.rightArm.rotation.set(-0.12, 0, -1.95 + k * 0.06);
      s.leftArm.rotation.z = 0.08;
      s.head.rotation.set(-0.08, -0.12, -0.07);
      s.body.rotation.z = -0.03 + k * 0.012;
      p.cape.rotation.x = CAPE + 0.04;
      return bend(-0.15, 0, 0, -0.8 - k * 0.38);
    },
  },
  // Victory: two hops with both fists pumping above the head.
  cheer: {
    duration: 3.0,
    still: 0.42,
    pose(p, t) {
      const s = p.skin;
      const hop = abs(sin(t * PI * 1.6));
      const pump = 0.5 + 0.5 * cos(t * PI * 3.2);
      const lift = 2.35 - pump * 0.2;
      s.leftArm.rotation.set(-0.1, 0, lift);
      s.rightArm.rotation.set(-0.1, 0, -lift);
      s.leftLeg.rotation.z = 0.06 + hop * 0.08;
      s.rightLeg.rotation.z = -0.06 - hop * 0.08;
      s.head.rotation.x = -0.28;
      s.body.rotation.x = -0.04;
      p.position.y = hop * 2.6;
      p.cape.rotation.x = CAPE + 0.2 + hop * 0.35;
      return bend(0, 0.45 + pump * 0.35, 0, -0.45 - pump * 0.35);
    },
  },
  dance: {
    duration: 5.6,
    still: 0.2,
    pose(p, t) {
      const s = p.skin;
      const beat = t * PI * 3.2;
      const a = sin(beat);
      const b = cos(beat);
      s.leftArm.rotation.set(-0.45 + a * 0.55, 0, 0.7 + b * 0.38);
      s.rightArm.rotation.set(-0.45 - a * 0.55, 0, -0.7 + b * 0.38);
      s.body.rotation.set(0, a * 0.22, b * 0.05);
      s.leftLeg.rotation.x = a * 0.48;
      s.rightLeg.rotation.x = -a * 0.48;
      s.head.rotation.set(0, sin(beat * 0.5) * 0.35, -a * 0.12);
      p.position.y = abs(b) * 0.8;
      p.cape.rotation.x = 0.2 + abs(a) * 0.15;
      return bend(-1.1 - b * 0.55, 0, -1.1 + b * 0.55, 0);
    },
  },
  floss: {
    duration: 5.2,
    still: 0.3,
    pose(p, t) {
      const s = p.skin;
      const beat = t * PI * 3.2;
      const a = sin(beat);
      const b = sin(beat * 0.5);
      s.leftArm.rotation.set(b * 0.7, 0, -a * 0.95 + 0.15);
      s.rightArm.rotation.set(b * 0.7, 0, -a * 0.95 - 0.15);
      s.body.rotation.set(0, -b * 0.18, a * 0.13);
      s.leftLeg.rotation.z = 0.13 + a * 0.1;
      s.rightLeg.rotation.z = -0.13 + a * 0.1;
      s.head.rotation.z = -a * 0.09;
      p.cape.rotation.x = CAPE + abs(a) * 0.1;
      return bend(-0.18, 0, -0.18, 0);
    },
  },
  spin: {
    duration: 4.1,
    still: 1.6,
    pose(p, t) {
      const s = p.skin;
      const beat = t * PI * 3.2;
      const turn = max(0, min(1, (t - 0.45) / 2.6));
      p.rotation.y = 2 * PI * (turn * turn * (3 - 2 * turn));
      s.leftArm.rotation.z = 1.15;
      s.rightArm.rotation.z = -1.15;
      s.leftLeg.rotation.x = sin(beat) * 0.3;
      s.rightLeg.rotation.x = -sin(beat) * 0.3;
      p.position.y = sin(turn * PI) * 1.5;
      p.cape.rotation.x = CAPE + sin(turn * PI) * 0.6;
      return bend(-0.4, 0, -0.4, 0);
    },
  },
  hero: {
    duration: 2.8,
    still: 0.6,
    pose(p, t) {
      const s = p.skin;
      s.leftArm.rotation.set(0.28, 0, 0.5);
      s.rightArm.rotation.set(0.28, 0, -0.5);
      s.leftLeg.rotation.z = 0.1;
      s.rightLeg.rotation.z = -0.1;
      s.head.rotation.x = -0.12;
      p.cape.rotation.x = 0.35 + sin(t * 2.2) * 0.12;
      return bend(-0.8, 0, -0.8, 0);
    },
  },
  think: {
    duration: 3.4,
    still: 0.6,
    pose(p, t) {
      const s = p.skin;
      s.rightArm.rotation.set(-2.05, 0, 0.55);
      s.leftArm.rotation.set(-0.95, 0, -0.62);
      s.head.rotation.set(0.16 + sin(t * 1.3) * 0.03, -0.2, 0.12);
      p.cape.rotation.x = CAPE;
      return bend(-0.8, 0, -1.15, 0);
    },
  },
  zombie: {
    duration: 3.8,
    still: 0.25,
    pose(p, t) {
      const s = p.skin;
      const k = t * 3;
      s.leftArm.rotation.x = -PI / 2 + sin(k) * 0.08;
      s.rightArm.rotation.x = -PI / 2 - sin(k) * 0.08;
      s.leftLeg.rotation.x = sin(k) * 0.35;
      s.rightLeg.rotation.x = -sin(k) * 0.35;
      s.head.rotation.z = sin(k * 0.5) * 0.1;
      p.cape.rotation.x = CAPE;
      return bend();
    },
  },
  // Minecraft's sneak pose (the numbers are skinview3d's crouch at rest).
  crouch: {
    duration: 2.4,
    still: 1.2,
    pose(p) {
      const s = p.skin;
      s.body.rotation.x = 0.4538;
      s.body.position.set(0, -8.104, -2.124);
      s.head.position.y = -3.618;
      for (const arm of [s.leftArm, s.rightArm]) {
        arm.position.y = -4.539;
        arm.position.z = 0.168;
        arm.rotation.x = 0.4104;
      }
      s.leftArm.rotation.z = 0.1;
      s.rightArm.rotation.z = -0.1;
      s.leftLeg.position.z = -3.45;
      s.rightLeg.position.z = -3.45;
      p.cape.position.set(0, 6.149, -1.663);
      p.cape.rotation.x = CAPE + 0.2942;
      return bend();
    },
  },
  // Shy: hands behind the back, eyes down, a toe drawing on the ground.
  shy: {
    duration: 5.4,
    still: 0.6,
    pose(p, t) {
      const s = p.skin;
      const k = sin(t * 3.1);
      s.leftArm.rotation.set(0.22, 0, -0.12);
      s.rightArm.rotation.set(0.22, 0, 0.12);
      s.rightLeg.rotation.set(-0.16 - abs(k) * 0.08, k * 0.45, -0.05 + k * 0.08);
      s.leftLeg.rotation.z = 0.04;
      s.body.rotation.set(0.05, -k * 0.06, k * 0.02);
      s.head.rotation.set(0.5, 0.18 + k * 0.08, 0.1);
      p.rotation.y = k * 0.05;
      p.cape.rotation.x = CAPE;
      return bend4(bend(0.5, -0.75, 0.5, 0.75), 0, 0.25 + abs(k) * 0.15);
    },
  },
  walk: {
    duration: 3.2,
    still: 0.15,
    pose(p, t) {
      const s = p.skin;
      const k = t * 8;
      s.leftLeg.rotation.x = sin(k) * 0.5;
      s.rightLeg.rotation.x = -sin(k) * 0.5;
      s.leftArm.rotation.set(-sin(k) * 0.5, 0, cos(k) * 0.03 + PI * 0.02);
      s.rightArm.rotation.set(sin(k) * 0.5, 0, -cos(k) * 0.03 - PI * 0.02);
      s.head.rotation.set(sin(k / 5) * 0.1, sin(k / 4) * 0.2, 0);
      p.cape.rotation.x = sin(k / 1.5) * 0.06 + CAPE;
      return bend();
    },
  },
  run: {
    duration: 3.2,
    still: 0.1,
    pose(p, t) {
      const s = p.skin;
      const k = t * 15 + PI * 0.5;
      s.leftLeg.rotation.x = -cos(k) * 1.3;
      s.rightLeg.rotation.x = cos(k) * 1.3;
      s.leftArm.rotation.set(cos(k) * 1.5, 0, cos(k) * 0.1 + PI * 0.1);
      s.rightArm.rotation.set(-cos(k) * 1.5, 0, -cos(k) * 0.1 - PI * 0.1);
      p.position.y = cos(k * 2);
      p.cape.rotation.x = sin(k * 2) * 0.1 + PI * 0.3;
      return bend(-1.1, 0, -1.1, 0);
    },
  },
};

export const EMOTE_IDS = Object.keys(EMOTES);

// 0 → 1 → 0 over an emote's life: eased in, held, eased out.
export function envelope(t, duration) {
  const x = max(0, min(1, t / 0.28, (duration - t) / 0.4));
  return x * x * (3 - 2 * x);
}
