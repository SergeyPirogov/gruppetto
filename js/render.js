// Pseudo-3D road renderer (segment projection, painter's algorithm) in a soft illustrated style.
// Scenery sprites and background layers are drawn procedurally once into offscreen canvases.
import { SEG } from './routes.js';

const DRAW = 240;            // segments drawn ahead
const ROAD_W = 3.6;          // half road width, m
const CAM_H = 2.3;           // camera height above road, m
const CAM_BACK = 6.5;        // camera distance behind the rider, m
const V_EXAG = 2.2;          // vertical exaggeration so hills read on screen
const FOV = 90 * Math.PI / 180;
const DEPTH = 1 / Math.tan(FOV / 2);

const C = {
  skyTop: '#3f93dc', skyBottom: '#d6ecf8', fog: [214, 234, 240],
  grass: [[150, 196, 82], [143, 190, 78]],
  verge: [[126, 176, 70], [120, 170, 66]],
  road: [[74, 78, 86], [70, 74, 82]],
  line: [244, 244, 240],
};

const mix = (c, f, t) => `rgb(${(c[0] + (f[0] - c[0]) * t) | 0},${(c[1] + (f[1] - c[1]) * t) | 0},${(c[2] + (f[2] - c[2]) * t) | 0})`;
const hash = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

// ---------- Sprite factory ----------

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function blob(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

function makeOak(seed) {
  const c = makeCanvas(256, 300), g = c.getContext('2d');
  g.fillStyle = '#6b4a2f';
  g.beginPath(); g.moveTo(116, 300); g.lineTo(122, 150); g.lineTo(134, 150); g.lineTo(142, 300); g.fill();
  g.strokeStyle = '#6b4a2f'; g.lineWidth = 9; g.lineCap = 'round';
  g.beginPath(); g.moveTo(128, 190); g.lineTo(88, 140); g.moveTo(130, 180); g.lineTo(172, 128); g.stroke();
  const puffs = [];
  for (let i = 0; i < 22; i++) {
    const a = hash(seed * 31 + i) * Math.PI * 2, rr = hash(seed * 17 + i * 3) * 70;
    puffs.push([128 + Math.cos(a) * rr * 1.25, 105 + Math.sin(a) * rr * 0.85, 30 + hash(seed + i * 7) * 22]);
  }
  for (const [x, y, r] of puffs) blob(g, x, y + 6, r, '#3d7a35');
  for (const [x, y, r] of puffs) blob(g, x - 4, y - 2, r * 0.86, '#58a03f');
  for (const [x, y, r] of puffs) if (y < 110) blob(g, x - 9, y - 9, r * 0.5, '#7dc04f');
  return c;
}

function makePine(seed) {
  const c = makeCanvas(160, 320), g = c.getContext('2d');
  g.fillStyle = '#5b3f28'; g.fillRect(74, 260, 12, 60);
  const layers = 6;
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1);
    const y = 20 + t * 230, w = 18 + t * 60 + hash(seed + i) * 8;
    g.fillStyle = '#2b5e34';
    g.beginPath(); g.moveTo(80, y - 30); g.lineTo(80 + w, y + 36); g.lineTo(80 - w, y + 36); g.fill();
    g.fillStyle = '#3c7a40';
    g.beginPath(); g.moveTo(80, y - 30); g.lineTo(80 + w * 0.15, y + 34); g.lineTo(80 - w * 0.95, y + 32); g.fill();
  }
  return c;
}

function makeRock(seed) {
  const c = makeCanvas(200, 130), g = c.getContext('2d');
  const pts = [];
  for (let i = 0; i < 9; i++) {
    const a = Math.PI + (i / 8) * Math.PI;
    const r = 0.75 + hash(seed * 5 + i) * 0.25;
    pts.push([100 + Math.cos(a) * 95 * r, 125 + Math.sin(a) * 115 * r]);
  }
  g.fillStyle = 'rgba(40,60,30,0.35)';
  g.beginPath(); g.ellipse(100, 124, 98, 10, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#9aa0a3';
  g.beginPath(); g.moveTo(...pts[0]); for (const p of pts) g.lineTo(...p); g.closePath(); g.fill();
  g.fillStyle = '#b9bec0';
  g.beginPath(); g.moveTo(pts[1][0] + 10, pts[1][1]); for (const p of pts.slice(2, 6)) g.lineTo(p[0] - 4, p[1] + 10); g.lineTo(100, 90); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(80,86,90,0.6)'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(80, 60); g.lineTo(95, 95); g.lineTo(88, 120); g.stroke();
  return c;
}

function makeFlowers(seed) {
  const c = makeCanvas(220, 120), g = c.getContext('2d');
  for (let i = 0; i < 46; i++) {
    const x = 10 + hash(seed * 3 + i) * 200, h = 30 + hash(seed * 7 + i) * 60;
    g.strokeStyle = i % 2 ? '#5c9a3a' : '#79b445'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(x, 120); g.quadraticCurveTo(x + 6, 120 - h / 2, x + (hash(i + seed) - 0.5) * 20, 120 - h); g.stroke();
  }
  const palette = ['#f5f5f0', '#f7c62f', '#9b7fd1', '#f5f5f0', '#f0a83a'];
  for (let i = 0; i < 16; i++) {
    const x = 18 + hash(seed * 11 + i) * 184, y = 40 + hash(seed * 13 + i) * 60;
    const col = palette[Math.floor(hash(seed + i * 5) * palette.length)];
    if (col === '#9b7fd1') { // lupine spike
      for (let k = 0; k < 6; k++) blob(g, x, y - k * 7, 5 - k * 0.5, k % 2 ? '#8a6cc4' : '#a68ae0');
    } else {
      for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2; blob(g, x + Math.cos(a) * 5, y + Math.sin(a) * 5, 4, col); }
      blob(g, x, y, 3, '#e8a21a');
    }
  }
  return c;
}

function makeBush(seed) {
  const c = makeCanvas(200, 140), g = c.getContext('2d');
  const puffs = [];
  for (let i = 0; i < 9; i++) puffs.push([40 + hash(seed + i) * 120, 70 + hash(seed * 2 + i) * 40, 26 + hash(seed * 3 + i) * 18]);
  for (const [x, y, r] of puffs) blob(g, x, y + 4, r, '#3f7d36');
  for (const [x, y, r] of puffs) blob(g, x - 4, y - 3, r * 0.8, '#5ea343');
  return c;
}

function makeCloud(seed) {
  const c = makeCanvas(440, 200), g = c.getContext('2d');
  const puffs = [];
  for (let i = 0; i < 9; i++) {
    const k = Math.sin((i / 8) * Math.PI);
    puffs.push([80 + i * 35 + hash(seed + i) * 14, 150 - k * 38 - hash(seed * 3 + i) * 14, 24 + k * 26]);
  }
  for (const [x, y, r] of puffs) blob(g, x, y + 7, r, '#c9dbea');
  for (const [x, y, r] of puffs) blob(g, x - 3, y, r * 0.95, '#ffffff');
  return c;
}

// Background ridge layers, seamless over their width.
function makeRidge(w, h, { base, top, trees, amp, freq, seed, treeColor }) {
  const c = makeCanvas(w, h), g = c.getContext('2d');
  const ridge = (x) => {
    const u = (x / w) * Math.PI * 2;
    return h - amp * (0.55 + 0.25 * Math.sin(u * freq + seed) + 0.15 * Math.sin(u * freq * 2.3 + seed * 2) + 0.05 * Math.sin(u * 11));
  };
  const grad = g.createLinearGradient(0, h - amp, 0, h);
  grad.addColorStop(0, top); grad.addColorStop(1, base);
  g.fillStyle = grad;
  g.beginPath(); g.moveTo(0, h);
  for (let x = 0; x <= w; x += 4) g.lineTo(x, ridge(x));
  g.lineTo(w, h); g.fill();
  if (trees) {
    g.fillStyle = treeColor;
    for (let x = 0; x < w; x += trees.step) {
      const r = hash(x * 0.37 + seed * 100);
      if (r > trees.density) continue;
      const th = trees.size * (0.6 + hash(x + seed) * 0.7), tw = th * 0.32;
      const y = ridge(x) + th * 0.25 + hash(x * 3) * trees.scatter;
      g.beginPath(); g.moveTo(x, y - th); g.lineTo(x + tw, y); g.lineTo(x - tw, y); g.fill();
      if (x < tw) { g.beginPath(); g.moveTo(x + w, y - th); g.lineTo(x + w + tw, y); g.lineTo(x + w - tw, y); g.fill(); }
      if (x > w - tw) { g.beginPath(); g.moveTo(x - w, y - th); g.lineTo(x - w + tw, y); g.lineTo(x - w - tw, y); g.fill(); }
    }
  }
  return c;
}

const SPRITES = {};
function sprites() {
  if (SPRITES.ready) return SPRITES;
  SPRITES.oak = [makeOak(1), makeOak(2), makeOak(3)];
  SPRITES.pine = [makePine(1), makePine(2)];
  SPRITES.rock = [makeRock(1), makeRock(2), makeRock(3)];
  SPRITES.flowers = [makeFlowers(1), makeFlowers(2), makeFlowers(3), makeFlowers(4)];
  SPRITES.bush = [makeBush(1), makeBush(2)];
  SPRITES.cloud = [makeCloud(1), makeCloud(2), makeCloud(3)];
  SPRITES.ready = true;
  return SPRITES;
}

// World heights (m) per sprite type.
const SIZE = { oak: 10, pine: 13, rock: 1.3, flowers: 0.7, bush: 1.6 };

/** Deterministic roadside scenery for a segment index. */
function sceneryFor(idx) {
  const items = [];
  for (const side of [-1, 1]) {
    const h = (k) => hash(idx * 7.13 + side * 3.7 + k * 19.1);
    if (h(1) < 0.45) items.push({ type: 'flowers', side, off: 1.12 + h(2) * 0.5, v: Math.floor(h(3) * 4) });
    if (h(4) < 0.05) items.push({ type: 'rock', side, off: 1.4 + h(5) * 1.4, v: Math.floor(h(6) * 3) });
    if (h(7) < 0.06) items.push({ type: 'bush', side, off: 1.6 + h(8) * 2, v: Math.floor(h(9) * 2) });
    if (h(10) < 0.12) {
      const pine = h(11) < 0.45;
      items.push({ type: pine ? 'pine' : 'oak', side, off: 1.9 + h(12) * 5, v: Math.floor(h(13) * (pine ? 2 : 3)) });
    }
  }
  // far side first so nearer-to-road items overlap correctly
  return items.sort((a, b) => b.off - a.off);
}

/** Fences run in long stretches, independently on each side. */
const fenceOn = (idx, side) => hash(Math.floor(idx / 50) * 3.1 + side * 11.7) < 0.7;
const FENCE_OFF = 1.18;

export class Scene {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bgOffset = 0;
    this.cloudDrift = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    const W = this.canvas.width, H = this.canvas.height;
    const lw = Math.round(W * 2);
    this.layers = [
      { img: makeRidge(lw, Math.round(H * 0.22), { base: '#9fc0cf', top: '#8fb3c8', amp: H * 0.2, freq: 3, seed: 1 }), parallax: 0.15, color: '#9fc0cf' },
      { img: makeRidge(lw, Math.round(H * 0.17), { base: '#5f9a63', top: '#5b8f6c', amp: H * 0.12, freq: 5, seed: 2, treeColor: '#3f7450', trees: { step: Math.max(3, W / 300), density: 0.85, size: H * 0.035, scatter: H * 0.02 } }), parallax: 0.3, color: '#5f9a63' },
      { img: makeRidge(lw, Math.round(H * 0.12), { base: '#93c25a', top: '#86b85a', amp: H * 0.07, freq: 4, seed: 3, treeColor: '#2f6a3a', trees: { step: Math.max(4, W / 200), density: 0.45, size: H * 0.05, scatter: H * 0.03 } }), parallax: 0.5, color: '#93c25a' },
    ];
  }

  /**
   * @param route Route
   * @param dist rider position, m
   * @param riders [{dist, color, name, pedal, self, lane}]
   */
  render(route, dist, riders, dtDist) {
    const S = sprites();
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const segs = route.segments, n = segs.length;
    const camDist = dist - CAM_BACK;
    const base = Math.floor(route.wrap(camDist) / SEG);
    const frac = (route.wrap(camDist) % SEG) / SEG;

    this.bgOffset += segs[base].curve * (dtDist || 0) * 0.6;
    this.cloudDrift += 0.00004;
    const camY = route.elevAt(dist) * V_EXAG + CAM_H;
    const horizon = H * 0.44;

    // project segment boundary points
    const pts = [];
    let x = 0, dx = -segs[base].curve * frac;
    for (let k = 0; k <= DRAW; k++) {
      const idx = (base + k) % n;
      const z = Math.max((k - frac) * SEG, 0.4);
      const s = DEPTH / z;
      pts.push({
        sx: W / 2 + s * x * W / 2,
        sy: horizon - s * (segs[idx].elev * V_EXAG - camY) * H / 2,
        sw: s * ROAD_W * W / 2,
        s, z, idx,
      });
      x += dx;
      dx += segs[idx].curve;
    }

    // sky, clouds, background ridges
    const minSy = Math.min(horizon, ...pts.slice(-40).map((p) => p.sy));
    const g = ctx.createLinearGradient(0, 0, 0, minSy);
    g.addColorStop(0, C.skyTop);
    g.addColorStop(1, C.skyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 5; i++) {
      const img = S.cloud[i % 3];
      const cw = W * (0.22 + hash(i) * 0.12), ch = cw * img.height / img.width;
      const span = W * 1.6;
      const cx = ((hash(i * 9) * span - (this.bgOffset * 0.08 + this.cloudDrift) * W * (1 + i * 0.2)) % span + span) % span - W * 0.3;
      ctx.drawImage(img, cx, H * (0.04 + hash(i * 5) * 0.16), cw, ch);
    }
    for (const L of this.layers) {
      const lw = L.img.width;
      const off = ((this.bgOffset * L.parallax * W) % lw + lw) % lw;
      const y = minSy - L.img.height + 2;
      ctx.drawImage(L.img, -off, y);
      ctx.drawImage(L.img, lw - off, y);
    }
    ctx.fillStyle = this.layers[this.layers.length - 1].color;
    ctx.fillRect(0, minSy, W, H - minSy);

    // riders per segment
    const ridersAt = new Map();
    for (const r of riders) {
      if (r.self) continue;
      const ahead = route.wrap(r.dist - camDist);
      if (ahead > DRAW * SEG - SEG) continue;
      const k = Math.floor(ahead / SEG);
      if (!ridersAt.has(k)) ridersAt.set(k, []);
      ridersAt.get(k).push({ r, t: (ahead / SEG) - k });
    }

    const half = W / 2;
    // painter's algorithm: far to near
    for (let k = DRAW - 1; k >= 0; k--) {
      const p1 = pts[k], p2 = pts[k + 1]; // p1 near, p2 far
      const fog = Math.min(1, Math.pow(p1.z / (DRAW * SEG), 1.5));
      const band = Math.floor(p1.idx / 2) % 2;
      ctx.fillStyle = mix(C.grass[band], C.fog, fog);
      ctx.fillRect(0, Math.min(p2.sy, p1.sy), W, Math.abs(p1.sy - p2.sy) + 1);
      quad(ctx, p1.sx, p1.sy, p1.sw * 1.12, p2.sx, p2.sy, p2.sw * 1.12, mix(C.verge[band], C.fog, fog));
      quad(ctx, p1.sx, p1.sy, p1.sw, p2.sx, p2.sy, p2.sw, mix(C.road[band], C.fog, fog));
      const lineCol = mix(C.line, C.fog, fog);
      for (const side of [-1, 1]) {
        quad(ctx, p1.sx + side * p1.sw * 0.9, p1.sy, p1.sw * 0.022, p2.sx + side * p2.sw * 0.9, p2.sy, p2.sw * 0.022, lineCol);
      }

      if (p1.z > 2.5) {
        // scenery & fences on each side, outer items first
        const items = sceneryFor(p1.idx);
        const alpha = 1 - fog * 0.85;
        for (const it of items) {
          if (it.off < FENCE_OFF + 0.05 && fenceOn(p1.idx, it.side)) continue;
          if (it.off > FENCE_OFF) this._sprite(S[it.type][it.v], p1, it, alpha, half);
        }
        for (const side of [-1, 1]) if (fenceOn(p1.idx, side)) this._fence(p1, p2, side, fog, half);
        for (const it of items) if (it.off <= FENCE_OFF) this._sprite(S[it.type][it.v], p1, it, alpha, half);
      }

      const list = ridersAt.get(k);
      if (list) {
        for (const sp of list) {
          const sx = p1.sx + (p2.sx - p1.sx) * sp.t;
          const sy = p1.sy + (p2.sy - p1.sy) * sp.t;
          const sc = p1.s + (p2.s - p1.s) * sp.t;
          drawCyclist(ctx, sx + (sp.r.lane ?? 0) * sc * half, sy, sc * half * 1.75, sp.r, fog, sp.r.name);
        }
      }
    }

    // own rider, just in front of the camera
    const me = riders.find((r) => r.self);
    if (me) {
      const t = CAM_BACK / SEG + frac;
      const i = Math.floor(t), tt = t - i;
      const a = pts[Math.min(i, DRAW - 1)], b = pts[Math.min(i + 1, DRAW)];
      const sy = a.sy + (b.sy - a.sy) * tt;
      const sx = a.sx + (b.sx - a.sx) * tt;
      const sc = a.s + (b.s - a.s) * tt;
      drawCyclist(ctx, sx + (me.lane ?? 0.9) * sc * half, sy, sc * half * 1.75, me, 0, null);
    }
  }

  _sprite(img, p, it, alpha, half) {
    const h = p.s * SIZE[it.type] * half;
    if (h < 2) return;
    const w = h * img.width / img.height;
    const x = p.sx + it.side * p.sw * it.off;
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, x - w / 2, p.sy - h, w, h);
    ctx.globalAlpha = 1;
  }

  _fence(p1, p2, side, fog, half) {
    const ctx = this.ctx;
    const x1 = p1.sx + side * p1.sw * FENCE_OFF, x2 = p2.sx + side * p2.sw * FENCE_OFF;
    const h1 = p1.s * half, h2 = p2.s * half; // pixels per metre
    const wood = mix([138, 98, 62], C.fog, fog), dark = mix([96, 66, 40], C.fog, fog);
    ctx.strokeStyle = wood;
    for (const rail of [0.45, 0.9]) {
      ctx.lineWidth = Math.max(1, h1 * 0.09);
      ctx.beginPath(); ctx.moveTo(x1, p1.sy - rail * h1); ctx.lineTo(x2, p2.sy - rail * h2); ctx.stroke();
    }
    const pw = Math.max(1, h1 * 0.14), ph = h1 * 1.1;
    ctx.fillStyle = dark;
    ctx.fillRect(x1 - pw / 2, p1.sy - ph, pw, ph);
    ctx.fillStyle = wood;
    ctx.fillRect(x1 - pw / 2, p1.sy - ph, pw * 0.55, ph);
  }
}

function quad(ctx, x1, y1, w1, x2, y2, w2, color) {
  y2 -= 0.75; // overlap the next (farther) strip to hide anti-aliasing seams
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1 - w1, y1);
  ctx.lineTo(x2 - w2, y2);
  ctx.lineTo(x2 + w2, y2);
  ctx.lineTo(x1 + w1, y1);
  ctx.closePath();
  ctx.fill();
}

const SKIN = [226, 168, 122], SHORTS = [32, 34, 40], SOCK = [245, 245, 245], SHOE = [30, 30, 34];

/** Rear view of a cyclist. `size` ≈ rider height in px; rider = {color, stripe, pedal}. */
export function drawCyclist(ctx, x, y, size, rider, fog = 0, label = null) {
  if (size < 3) return;
  const u = size / 10;
  const f = (rgb) => mix(rgb, C.fog, fog);
  const jersey = hexToRgb(rider.color), stripe = hexToRgb(rider.stripe || '#ff8a1f');
  const pedal = rider.pedal || 0;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // shadow, cast slightly to the right
  ctx.fillStyle = `rgba(30,40,30,${0.28 * (1 - fog)})`;
  ctx.beginPath(); ctx.ellipse(x + u * 0.6, y, u * 1.5, u * 0.32, 0, 0, Math.PI * 2); ctx.fill();

  // rear wheel and frame
  ctx.strokeStyle = f([28, 30, 34]);
  ctx.lineWidth = u * 0.42;
  ctx.beginPath(); ctx.moveTo(x, y - u * 0.15); ctx.lineTo(x, y - u * 3.3); ctx.stroke();
  ctx.strokeStyle = f([70, 90, 96]);
  ctx.lineWidth = u * 0.22;
  ctx.beginPath(); ctx.moveTo(x, y - u * 1.8); ctx.lineTo(x, y - u * 4.9); ctx.stroke();

  // legs
  const leg = (sideX, phase) => {
    const lift = Math.sin(pedal + phase) * u * 0.85;
    const hip = [x + sideX * 0.5 * u, y - u * 5.0];
    const knee = [x + sideX * 0.78 * u, y - u * 3.45 + lift * 0.6];
    const ankle = [x + sideX * 0.52 * u, y - u * 1.55 + lift];
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const seg = (a, b, col, w) => { ctx.strokeStyle = f(col); ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); };
    const mid = lerp(hip, knee, 0.55), sock = lerp(knee, ankle, 0.72);
    seg(mid, knee, SKIN, u * 0.62);
    seg(knee, sock, SKIN, u * 0.52);
    seg(sock, ankle, SOCK, u * 0.48);
    seg(hip, mid, SHORTS, u * 0.78);
    ctx.fillStyle = f(SHOE);
    ctx.beginPath(); ctx.ellipse(ankle[0], ankle[1] + u * 0.2, u * 0.3, u * 0.22, 0, 0, Math.PI * 2); ctx.fill();
  };
  leg(-1, 0);
  leg(1, Math.PI);

  // shorts seat
  ctx.fillStyle = f(SHORTS);
  ctx.beginPath(); ctx.ellipse(x, y - u * 5.2, u * 1.0, u * 0.55, 0, 0, Math.PI * 2); ctx.fill();

  // handlebar and arms
  ctx.strokeStyle = f([25, 25, 28]);
  ctx.lineWidth = u * 0.22;
  ctx.beginPath(); ctx.moveTo(x - u * 1.55, y - u * 5.75); ctx.lineTo(x + u * 1.55, y - u * 5.75); ctx.stroke();
  for (const side of [-1, 1]) {
    ctx.strokeStyle = f(jersey); ctx.lineWidth = u * 0.6;
    ctx.beginPath(); ctx.moveTo(x + side * u * 1.15, y - u * 7.5); ctx.lineTo(x + side * u * 1.42, y - u * 6.8); ctx.stroke();
    ctx.strokeStyle = f(SKIN); ctx.lineWidth = u * 0.48;
    ctx.beginPath(); ctx.moveTo(x + side * u * 1.42, y - u * 6.8); ctx.lineTo(x + side * u * 1.5, y - u * 5.9); ctx.stroke();
    ctx.fillStyle = f(SHOE);
    ctx.beginPath(); ctx.arc(x + side * u * 1.5, y - u * 5.8, u * 0.24, 0, Math.PI * 2); ctx.fill();
  }

  // torso with stripe
  const torso = () => {
    ctx.beginPath();
    ctx.moveTo(x - u * 0.95, y - u * 5.3);
    ctx.quadraticCurveTo(x - u * 1.05, y - u * 6.6, x - u * 1.3, y - u * 7.65);
    ctx.quadraticCurveTo(x, y - u * 8.05, x + u * 1.3, y - u * 7.65);
    ctx.quadraticCurveTo(x + u * 1.05, y - u * 6.6, x + u * 0.95, y - u * 5.3);
    ctx.quadraticCurveTo(x, y - u * 5.05, x - u * 0.95, y - u * 5.3);
    ctx.closePath();
  };
  ctx.fillStyle = f(jersey);
  torso(); ctx.fill();
  ctx.save();
  torso(); ctx.clip();
  ctx.fillStyle = f(stripe);
  ctx.fillRect(x - u * 1.5, y - u * 6.95, u * 3, u * 0.55);
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.fillRect(x + u * 0.35, y - u * 8.2, u * 1.2, u * 3.2);
  ctx.restore();

  // neck and helmet
  ctx.fillStyle = f(SKIN);
  ctx.fillRect(x - u * 0.28, y - u * 8.25, u * 0.56, u * 0.45);
  ctx.fillStyle = f([246, 246, 246]);
  ctx.beginPath(); ctx.ellipse(x, y - u * 8.6, u * 0.82, u * 0.68, 0, Math.PI, 0); ctx.lineTo(x + u * 0.82, y - u * 8.4); ctx.lineTo(x - u * 0.82, y - u * 8.4); ctx.fill();
  ctx.strokeStyle = f([60, 64, 70]); ctx.lineWidth = u * 0.1;
  ctx.beginPath(); ctx.moveTo(x - u * 0.3, y - u * 9.15); ctx.lineTo(x - u * 0.3, y - u * 8.6); ctx.moveTo(x + u * 0.3, y - u * 9.15); ctx.lineTo(x + u * 0.3, y - u * 8.6); ctx.stroke();

  if (label && size > 18 && fog < 0.7) {
    ctx.font = `600 ${Math.max(11, u * 1.2)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(255,255,255,${1 - fog})`;
    ctx.strokeStyle = `rgba(0,0,0,${0.55 * (1 - fog)})`;
    ctx.lineWidth = 3;
    ctx.strokeText(label, x, y - u * 10);
    ctx.fillText(label, x, y - u * 10);
  }
  ctx.restore();
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Elevation profile with rider markers. */
export function drawProfile(canvas, route, riders) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const pad = 6 * dpr;
  const range = Math.max(30, route.maxElev - route.minElev);
  const yOf = (e) => H - pad - ((e - route.minElev) / range) * (H - pad * 2);
  const n = route.segments.length;
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let i = 0; i <= n; i += 2) ctx.lineTo((i / n) * W, yOf(route.segments[i % n].elev));
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fill();
  for (const r of riders) {
    const d = route.wrap(r.dist);
    const px = pad + (d / route.length) * (W - pad * 2);
    ctx.fillStyle = r.color;
    ctx.beginPath();
    ctx.arc(px, yOf(route.elevAt(d)), (r.self ? 5 : 3.5) * dpr, 0, Math.PI * 2);
    ctx.fill();
    if (r.self) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.stroke(); }
  }
}
