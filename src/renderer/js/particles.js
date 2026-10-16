// Pixel particles for the lobby background.
//
// Drawn on a canvas at a third of the screen resolution and scaled up with
// image-rendering: pixelated, so every particle is made of the same chunky
// pixels as the rest of the UI. Themes cover the generic moods (bubbles,
// embers, fireflies, stars) and the holidays; "auto" picks by date.
// Bubbles and hearts pop — on their own, or when clicked — into shards.

const PX = 3;

// Sprites: '#' main colour, 'h' highlight, 'd' dark, 'g' green, '.' empty.
const SPRITES = {
  bubble3: ['.#.', '#.#', '.#.'],
  bubble5: ['.###.', '#...#', '#..h#', '#...#', '.###.'],
  bubble7: ['..###..', '.#...#.', '#....h#', '#.....#', '#.....#', '.#...#.', '..###..'],
  heart5: ['.#.#.', '#####', '##h##', '.###.', '..#..'],
  heart7: ['.##.##.', '###h###', '#######', '#######', '.#####.', '..###..', '...#...'],
  snow3: ['.#.', '###', '.#.'],
  snow5: ['..#..', '#.#.#', '.###.', '#.#.#', '..#..'],
  star3: ['.#.', '#h#', '.#.'],
  star5: ['..#..', '..#..', '##h##', '..#..', '..#..'],
  petal: ['.##', '##.'],
  petal2: ['##', '.#'],
  leafA: ['.##.', '####', '.##d', '..d.'],
  leafB: ['.d..', 'd##.', '####', '.##.'],
  pumpkin: ['..g..', '.###.', '#####', '##h##', '.###.'],
  batUp: ['#.....#', '##...##', '.#####.', '...#...'],
  batDown: ['.......', '.#####.', '#..#..#', '.......'],
  confettiH: ['##'],
  confettiV: ['#', '#'],
  ember: ['#'],
  ember2: ['##'],
  firefly: ['#'],
};

const rand = (a, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export const THEMES = [
  'auto', 'bubbles', 'embers', 'fireflies', 'stars', 'snow', 'hearts', 'petals', 'leaves', 'halloween', 'confetti', 'none',
];

export function autoTheme(d = new Date()) {
  const m = d.getMonth() + 1;
  const md = m * 100 + d.getDate();
  if (md >= 1220 || md <= 110) return 'snow';
  if (md >= 207 && md <= 215) return 'hearts';
  if (md >= 301 && md <= 310) return 'petals';
  if (md >= 1025 && md <= 1102) return 'halloween';
  if (m === 12 || m <= 2) return 'snow';
  if (m <= 5) return 'petals';
  if (m <= 8) return 'fireflies';
  return 'leaves';
}

// A little more of everything than the rules say.
const DENSITY = 1.35;

// Things blown to the right come from the top or in from the left edge.
const drift = (q, h) => (Math.random() < 0.3 ? { ...q, x: -8, y: rand(h * 0.75) } : q);

// Per-theme spawn rules. Each returns a particle; `p` is the palette.
const RULES = {
  bubbles: {
    rate: 2.4,
    max: 36,
    prefill: true,
    make: (w, h, p) => {
      const s = pick(['bubble3', 'bubble5', 'bubble5', 'bubble7']);
      return { sprite: s, x: rand(w), y: h + 8, vx: 0, vy: -rand(5, 11), sway: rand(4, 9), freq: rand(0.6, 1.4), phase: rand(6.28), life: rand(3, 9), color: pick([p.light, p.light, '#ffffff']), alpha: rand(0.55, 0.9), pops: true };
    },
  },
  embers: {
    rate: 9,
    max: 70,
    prefill: true,
    make: (w, h, p) => ({ sprite: pick(['ember', 'ember', 'ember2']), x: rand(w), y: h + 2, vx: rand(-2, 2), vy: -rand(10, 26), sway: rand(2, 6), freq: rand(1, 3), phase: rand(6.28), life: rand(2, 5), color: pick([p.light, '#ffd27a', '#ffb347', p.base]), alpha: 1, flicker: true, fade: true }),
  },
  fireflies: {
    rate: 2,
    max: 26,
    prefill: true,
    make: (w, h) => ({ sprite: 'firefly', x: rand(w), y: rand(h * 0.15, h * 0.95), vx: rand(-3, 3), vy: rand(-3, 3), wander: true, life: rand(5, 11), color: pick(['#e8ff8a', '#c8f56a', '#fff3a0']), alpha: 1, glow: true, blink: rand(6.28), fade: true }),
  },
  stars: {
    rate: 3,
    max: 40,
    prefill: true,
    make: (w, h, p) => ({ sprite: pick(['star3', 'star3', 'star5']), x: rand(w), y: rand(h * 0.9), vx: 0, vy: 0, life: rand(2, 5), color: pick(['#ffffff', '#fff6c4', p.light]), alpha: 0, twinkle: true, fade: true }),
  },
  snow: {
    rate: 7,
    max: 90,
    prefill: true,
    make: (w) => ({ sprite: pick(['ember', 'ember', 'ember2', 'snow3', 'snow3', 'snow5']), x: rand(-10, w + 10), y: -6, vx: rand(-2, 2), vy: rand(5, 13), sway: rand(3, 8), freq: rand(0.4, 1.1), phase: rand(6.28), life: 60, color: pick(['#ffffff', '#eaf6ff', '#d6ecff']), alpha: rand(0.7, 1) }),
  },
  hearts: {
    rate: 2,
    max: 30,
    prefill: true,
    make: (w, h) => ({ sprite: pick(['heart5', 'heart5', 'heart7']), x: rand(w), y: h + 8, vx: 0, vy: -rand(6, 12), sway: rand(3, 8), freq: rand(0.6, 1.3), phase: rand(6.28), life: rand(3, 8), color: pick(['#ff5c8a', '#ff7aa2', '#e8456f', '#ffa3c0']), alpha: 0.95, pops: true }),
  },
  petals: {
    rate: 4,
    max: 50,
    prefill: true,
    make: (w, h) => drift({ sprite: pick(['petal', 'petal2']), flip: ['petal', 'petal2'], x: rand(-10, w + 10), y: -4, vx: rand(2, 7), vy: rand(4, 9), sway: rand(4, 10), freq: rand(0.5, 1.2), phase: rand(6.28), life: 60, color: pick(['#ffc2d9', '#ffd8e6', '#ffffff', '#f7a8c6']), alpha: 0.95, flipRate: rand(2, 5) }, h),
  },
  leaves: {
    rate: 3,
    max: 40,
    prefill: true,
    make: (w, h) => drift({ sprite: 'leafA', flip: ['leafA', 'leafB'], x: rand(-10, w + 10), y: -6, vx: rand(1, 6), vy: rand(5, 10), sway: rand(6, 12), freq: rand(0.4, 1), phase: rand(6.28), life: 60, color: pick(['#e0782f', '#c9452d', '#e8b53a', '#a8582a', '#d9632b']), dark: '#6b2f16', alpha: 1, flipRate: rand(1.5, 3.5) }, h),
  },
  halloween: {
    rate: 3.2,
    max: 40,
    prefill: true,
    make: (w, h) => {
      const r = Math.random();
      if (r < 0.35) {
        const dir = Math.random() < 0.5 ? 1 : -1;
        return { sprite: 'batUp', flip: ['batUp', 'batDown'], x: dir > 0 ? -8 : w + 8, y: rand(h * 0.1, h * 0.6), vx: dir * rand(14, 26), vy: rand(-2, 2), sway: rand(3, 6), freq: rand(1.5, 3), phase: rand(6.28), life: 30, color: '#1a1020', alpha: 1, flipRate: 9 };
      }
      if (r < 0.5) return { sprite: 'pumpkin', x: rand(w), y: h + 6, vx: 0, vy: -rand(4, 7), sway: rand(2, 4), freq: rand(0.5, 1), phase: rand(6.28), life: rand(4, 9), color: '#f28a1e', light: '#ffd06b', green: '#5c9a3a', alpha: 1, pops: true };
      return { sprite: 'ember', x: rand(w), y: h + 2, vx: rand(-2, 2), vy: -rand(8, 18), sway: rand(2, 5), freq: rand(1, 2.5), phase: rand(6.28), life: rand(2, 5), color: pick(['#a35cff', '#ff8a1e', '#7a3cff']), alpha: 1, flicker: true, fade: true };
    },
  },
  confetti: {
    rate: 10,
    max: 110,
    prefill: true,
    make: (w) => ({ sprite: 'confettiH', flip: ['confettiH', 'confettiV'], x: rand(w), y: -4, vx: rand(-4, 4), vy: rand(10, 20), sway: rand(4, 9), freq: rand(1, 3), phase: rand(6.28), life: 60, color: pick(['#ff5c5c', '#ffd23f', '#3ec9ff', '#7bff6b', '#ff7ae0', '#ffffff', '#ff9f3f']), alpha: 1, flipRate: rand(4, 9) }),
  },
};

export class Particles {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.items = [];
    this.shards = [];
    this.rule = null;
    this.raf = 0;
    this.last = 0;
    this.acc = 0;
    this.time = 0;
    this.palette = { base: '#c88a5a', light: '#f0c39a', dark: '#6b4428' };
    this.w = 1;
    this.h = 1;
    this.onDown = (e) => this.popAt(e);
    canvas.addEventListener('pointerdown', this.onDown);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
  }

  setPalette(p) {
    this.palette = { ...this.palette, ...p };
  }

  setTheme(id) {
    const name = id === 'auto' ? autoTheme() : id;
    this.themeName = name;
    this.rule = RULES[name] || null;
    this.items = [];
    this.shards = [];
    // the canvas may not be laid out yet; then the sky fills once it is
    this.prefilled = false;
    this.prefill();
    this.draw();
    return name;
  }

  // Start mid-flight rather than with an empty sky — spread over the whole
  // canvas, which needs its real size.
  prefill() {
    if (this.prefilled || !this.rule || this.w < 40 || this.h < 40) return;
    this.prefilled = true;
    if (!this.rule.prefill) return;
    for (let i = 0; i < this.rule.max * DENSITY * 0.6; i++) {
      const p = this.rule.make(this.w, this.h, this.palette);
      p.max = p.life;
      p.x = rand(this.w);
      p.y = rand(this.h);
      if (p.life < 50) p.life *= Math.random();
      this.items.push(p);
    }
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(r.width / PX));
    const h = Math.max(1, Math.ceil(r.height / PX));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.prefill();
    this.draw();
  }

  // `fps` caps the frame rate if set; by default every frame the monitor
  // shows.
  start() {
    if (this.raf) return;
    this.last = performance.now();
    let acc = 0;
    const loop = (t) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (t - this.last) / 1000);
      this.last = t;
      acc += dt;
      if (acc < 1 / (this.fps || Infinity) - 0.004) return;
      this.step(Math.min(0.1, acc));
      acc = 0;
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose() {
    this.stop();
    this.ro.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
  }

  burst(p) {
    const sprite = SPRITES[p.sprite] || ['#'];
    const cx = p.x + sprite[0].length / 2;
    const cy = p.y + sprite.length / 2;
    const n = 6 + Math.floor(Math.random() * 6);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(0.4);
      const sp = rand(14, 34);
      this.shards.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 6, life: rand(0.35, 0.8), max: 0.8, color: i % 3 === 0 ? '#ffffff' : p.color });
    }
  }

  // A block breaking: a spray of its own colours, like the game's break
  // particles. x/y are client (screen) coordinates.
  burstAt(clientX, clientY, colors, count = 22) {
    const r = this.canvas.getBoundingClientRect();
    const cx = (clientX - r.left) / PX;
    const cy = (clientY - r.top) / PX;
    for (let i = 0; i < count; i++) {
      const a = rand(Math.PI * 2);
      const sp = rand(10, 42);
      this.shards.push({
        x: cx + rand(-5, 5),
        y: cy + rand(-5, 5),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - rand(10, 26),
        life: rand(0.55, 1.15),
        max: 1.15,
        size: Math.random() < 0.35 ? 2 : 1,
        color: pick(colors && colors.length ? colors : ['#ffffff']),
      });
    }
    if (!this.raf) this.draw();
  }

  popAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / PX;
    const y = (e.clientY - r.top) / PX;
    let best = -1;
    let bestD = 7;
    this.items.forEach((p, i) => {
      if (!p.pops) return;
      const s = SPRITES[p.sprite];
      const d = Math.hypot(p.x + s[0].length / 2 - x, p.y + s.length / 2 - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) {
      this.burst(this.items[best]);
      this.items.splice(best, 1);
    }
  }

  step(dt) {
    this.time += dt;
    const rule = this.rule;
    if (rule) {
      this.acc += dt * rule.rate * DENSITY;
      while (this.acc >= 1) {
        this.acc -= 1;
        if (this.items.length < rule.max * DENSITY) {
          const p = rule.make(this.w, this.h, this.palette);
          p.max = p.life;
          this.items.push(p);
        }
      }
    }
    const keep = [];
    for (const p of this.items) {
      p.life -= dt;
      if (p.wander) {
        p.vx += rand(-14, 14) * dt;
        p.vy += rand(-14, 14) * dt;
        p.vx = Math.max(-6, Math.min(6, p.vx));
        p.vy = Math.max(-5, Math.min(5, p.vy));
      }
      p.x += p.vx * dt + (p.sway ? Math.sin(this.time * p.freq + p.phase) * p.sway * dt : 0);
      p.y += p.vy * dt;
      if (p.flip) p.sprite = p.flip[Math.floor(this.time * p.flipRate + p.phase) % p.flip.length];
      if (p.life <= 0) {
        if (p.pops) this.burst(p);
        continue;
      }
      if (p.y < -12 || p.y > this.h + 12 || p.x < -16 || p.x > this.w + 16) continue;
      keep.push(p);
    }
    this.items = keep;
    for (const s of this.shards) {
      s.life -= dt;
      s.vy += 40 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    this.shards = this.shards.filter((s) => s.life > 0);
  }

  // Particles sit on whole pixels, so on a fast monitor most frames would
  // repaint exactly the picture already there: those are skipped (a cheap
  // fingerprint of every particle's pixel, sprite and alpha step).
  draw() {
    const g = this.ctx;
    const alphaOf = (p) => {
      let a = p.alpha;
      if (p.flicker) a *= 0.55 + 0.45 * Math.sin(this.time * 18 + p.phase * 7);
      if (p.twinkle) a = Math.max(0, Math.sin((1 - p.life / (p.max || 5)) * Math.PI));
      if (p.fade && p.life < 1) a *= Math.max(0, p.life);
      if (p.glow) a *= 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.time * 3 + p.blink));
      return a;
    };
    let sig = this.items.length * 7919 + this.shards.length * 104729 + this.w * 31 + this.h;
    for (const p of this.items) {
      p.drawAlpha = alphaOf(p);
      sig = (sig * 31 + Math.round(p.x) * 977 + Math.round(p.y) * 131 + Math.round(p.drawAlpha * 48) + (p.sprite ? p.sprite.length * 131 + p.sprite.charCodeAt(p.sprite.length - 1) : 0)) | 0;
    }
    for (const s of this.shards) sig = (sig * 31 + Math.round(s.x) * 977 + Math.round(s.y) * 131 + Math.round((s.life / s.max) * 48)) | 0;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    g.clearRect(0, 0, this.w, this.h);
    for (const p of this.items) {
      const a = p.drawAlpha;
      if (p.glow) {
        g.globalAlpha = a * 0.08;
        g.fillStyle = '#ffffff';
        g.fillRect(Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3);
      }
      g.globalAlpha = Math.max(0, Math.min(1, a)) * 0.38;
      this.blit(p);
    }
    for (const s of this.shards) {
      g.globalAlpha = Math.max(0, Math.min(1, (s.life / s.max) * 1.6)) * 0.38;
      g.fillStyle = '#ffffff';
      const n = s.size || 1;
      g.fillRect(Math.round(s.x), Math.round(s.y), n, n);
    }
    g.globalAlpha = 1;
  }

  blit(p) {
    const rows = SPRITES[p.sprite];
    if (!rows) return;
    const g = this.ctx;
    const x0 = Math.round(p.x);
    const y0 = Math.round(p.y);
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === '.') continue;
        g.fillStyle = ch === 'd' ? 'rgba(255,255,255,0.5)' : '#ffffff';
        g.fillRect(x0 + x, y0 + y, 1, 1);
      }
    }
  }
}
