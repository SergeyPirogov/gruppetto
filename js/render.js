// Pseudo-3D road renderer (segment projection, painter's algorithm) in a soft illustrated style.
// Each route has a visual theme (themes.js); its sprites and background layers are drawn
// procedurally once into offscreen canvases and cached.
import { SEG } from './routes.js';
import { themeFor } from './themes.js';

const DRAW = 240;            // segments drawn ahead
const ROAD_W = 3.6;          // half road width, m
const CAM_H = 2.3;           // camera height above road, m
const CAM_BACK = 6.5;        // camera distance behind the rider, m
const V_EXAG = 2.2;          // vertical exaggeration so hills read on screen
const FOV = 90 * Math.PI / 180;
const DEPTH = 1 / Math.tan(FOV / 2);

let FOG = [214, 234, 240];   // current theme fog colour (also used by drawCyclist)

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

function makeOak(seed, p) {
  const c = makeCanvas(256, 300), g = c.getContext('2d');
  g.fillStyle = p.trunk;
  g.beginPath(); g.moveTo(116, 300); g.lineTo(122, 150); g.lineTo(134, 150); g.lineTo(142, 300); g.fill();
  g.strokeStyle = p.trunk; g.lineWidth = 9; g.lineCap = 'round';
  g.beginPath(); g.moveTo(128, 190); g.lineTo(88, 140); g.moveTo(130, 180); g.lineTo(172, 128); g.stroke();
  const puffs = [];
  for (let i = 0; i < 22; i++) {
    const a = hash(seed * 31 + i) * Math.PI * 2, rr = hash(seed * 17 + i * 3) * 70;
    puffs.push([128 + Math.cos(a) * rr * 1.25, 105 + Math.sin(a) * rr * 0.85, 30 + hash(seed + i * 7) * 22]);
  }
  for (const [x, y, r] of puffs) blob(g, x, y + 6, r, p.dark);
  for (const [x, y, r] of puffs) blob(g, x - 4, y - 2, r * 0.86, p.mid);
  for (const [x, y, r] of puffs) if (y < 110) blob(g, x - 9, y - 9, r * 0.5, p.light);
  return c;
}

function makeBirch(seed, p) {
  const c = makeCanvas(180, 320), g = c.getContext('2d');
  g.fillStyle = '#f2f0ea';
  g.fillRect(84, 110, 12, 210);
  g.fillStyle = '#2b2b2b';
  for (let i = 0; i < 9; i++) g.fillRect(84 + (i % 2) * 5, 130 + i * 20 + hash(seed + i) * 8, 7, 3);
  const puffs = [];
  for (let i = 0; i < 16; i++) puffs.push([90 + (hash(seed * 5 + i) - 0.5) * 110, 60 + hash(seed * 9 + i) * 110, 16 + hash(seed + i * 3) * 16]);
  for (const [x, y, r] of puffs) blob(g, x, y + 4, r, p.dark);
  for (const [x, y, r] of puffs) blob(g, x - 3, y - 2, r * 0.8, p.mid);
  for (const [x, y, r] of puffs) if (y < 100) blob(g, x - 6, y - 6, r * 0.45, p.light);
  return c;
}

function makePine(seed, p) {
  const c = makeCanvas(160, 320), g = c.getContext('2d');
  g.fillStyle = p.trunk; g.fillRect(74, 260, 12, 60);
  const layers = 6;
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1);
    const y = 20 + t * 230, w = 18 + t * 60 + hash(seed + i) * 8;
    g.fillStyle = p.dark;
    g.beginPath(); g.moveTo(80, y - 30); g.lineTo(80 + w, y + 36); g.lineTo(80 - w, y + 36); g.fill();
    g.fillStyle = p.light;
    g.beginPath(); g.moveTo(80, y - 30); g.lineTo(80 + w * 0.15, y + 34); g.lineTo(80 - w * 0.95, y + 32); g.fill();
    if (p.snow) {
      g.fillStyle = p.snow;
      g.beginPath(); g.moveTo(80, y - 30); g.lineTo(80 + w * 0.45, y - 2); g.quadraticCurveTo(80, y + 6, 80 - w * 0.45, y - 2); g.fill();
      g.beginPath(); g.ellipse(80, y + 34, w * 0.9, 5, 0, 0, Math.PI * 2); g.fill();
    }
  }
  return c;
}

function makeRock(seed, p) {
  const c = makeCanvas(200, 130), g = c.getContext('2d');
  const pts = [];
  for (let i = 0; i < 9; i++) {
    const a = Math.PI + (i / 8) * Math.PI;
    const r = 0.75 + hash(seed * 5 + i) * 0.25;
    pts.push([100 + Math.cos(a) * 95 * r, 125 + Math.sin(a) * 115 * r]);
  }
  g.fillStyle = 'rgba(40,40,30,0.3)';
  g.beginPath(); g.ellipse(100, 124, 98, 10, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = p.base;
  g.beginPath(); g.moveTo(...pts[0]); for (const q of pts) g.lineTo(...q); g.closePath(); g.fill();
  g.fillStyle = p.light;
  g.beginPath(); g.moveTo(pts[1][0] + 10, pts[1][1]); for (const q of pts.slice(2, 6)) g.lineTo(q[0] - 4, q[1] + 10); g.lineTo(100, 90); g.closePath(); g.fill();
  g.strokeStyle = p.crack; g.lineWidth = 3;
  g.beginPath(); g.moveTo(80, 60); g.lineTo(95, 95); g.lineTo(88, 120); g.stroke();
  return c;
}

function makeFlowers(seed, p) {
  const c = makeCanvas(220, 120), g = c.getContext('2d');
  for (let i = 0; i < 46; i++) {
    const x = 10 + hash(seed * 3 + i) * 200, h = 30 + hash(seed * 7 + i) * 60;
    g.strokeStyle = p.blades[i % 2]; g.lineWidth = 3;
    g.beginPath(); g.moveTo(x, 120); g.quadraticCurveTo(x + 6, 120 - h / 2, x + (hash(i + seed) - 0.5) * 20, 120 - h); g.stroke();
  }
  for (let i = 0; i < 16; i++) {
    const x = 18 + hash(seed * 11 + i) * 184, y = 40 + hash(seed * 13 + i) * 60;
    const col = p.colors[Math.floor(hash(seed + i * 5) * p.colors.length)];
    if (col === 'lupine') {
      for (let k = 0; k < 6; k++) blob(g, x, y - k * 7, 5 - k * 0.5, k % 2 ? '#8a6cc4' : '#a68ae0');
    } else {
      for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2; blob(g, x + Math.cos(a) * 5, y + Math.sin(a) * 5, 4, col); }
      blob(g, x, y, 3, '#e8a21a');
    }
  }
  return c;
}

function makeBush(seed, p) {
  const c = makeCanvas(200, 140), g = c.getContext('2d');
  const puffs = [];
  for (let i = 0; i < 9; i++) puffs.push([40 + hash(seed + i) * 120, 70 + hash(seed * 2 + i) * 40, 26 + hash(seed * 3 + i) * 18]);
  for (const [x, y, r] of puffs) blob(g, x, y + 4, r, p.dark);
  for (const [x, y, r] of puffs) blob(g, x - 4, y - 3, r * 0.8, p.mid);
  return c;
}

function makeCactus(seed) {
  const c = makeCanvas(160, 300), g = c.getContext('2d');
  const limb = (x1, y1, x2, y2, w) => {
    g.strokeStyle = '#3f7a3a'; g.lineWidth = w; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    g.strokeStyle = '#5c9a4a'; g.lineWidth = w * 0.4;
    g.beginPath(); g.moveTo(x1 - w * 0.15, y1); g.lineTo(x2 - w * 0.15, y2); g.stroke();
  };
  limb(80, 296, 80, 30, 34);
  const lh = 150 + hash(seed) * 50, rh = 120 + hash(seed + 1) * 60;
  limb(80, lh, 38, lh); limb(38, lh, 38, lh - 70, 24);
  limb(80, rh, 122, rh); limb(122, rh, 122, rh - 60, 24);
  return c;
}

function makePalm(seed) {
  const c = makeCanvas(260, 340), g = c.getContext('2d');
  const lean = (hash(seed) - 0.5) * 60;
  const top = [130 + lean, 70];
  for (let i = 0; i < 14; i++) {
    const t = i / 14;
    const x = 130 + lean * t * t, y = 336 - t * 266;
    g.fillStyle = i % 2 ? '#8a6a44' : '#9e7c50';
    g.beginPath(); g.ellipse(x, y, 11 - t * 3, 12, 0, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI + (i / 7) * Math.PI + (hash(seed + i) - 0.5) * 0.3;
    const len = 100 + hash(seed * 3 + i) * 30;
    const ex = top[0] + Math.cos(a) * len, ey = top[1] + Math.sin(a) * len * 0.45 + 50;
    g.strokeStyle = i % 2 ? '#2f7a3a' : '#43964a'; g.lineWidth = 14; g.lineCap = 'round';
    g.beginPath(); g.moveTo(...top); g.quadraticCurveTo((top[0] + ex) / 2, top[1] - 30, ex, ey); g.stroke();
  }
  blob(g, top[0], top[1] + 6, 10, '#6b4a2f');
  return c;
}

function makeSunflowers(seed) {
  const c = makeCanvas(240, 200), g = c.getContext('2d');
  const items = [];
  for (let i = 0; i < 12; i++) items.push([14 + hash(seed * 7 + i) * 212, 30 + hash(seed * 3 + i) * 70]);
  items.sort((a, b) => a[1] - b[1]);
  for (const [x, y] of items) {
    g.strokeStyle = '#4f7f2e'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(x, 200); g.lineTo(x, y); g.stroke();
    g.fillStyle = '#5f9436';
    g.beginPath(); g.ellipse(x - 12, y + 60, 14, 6, -0.5, 0, Math.PI * 2); g.ellipse(x + 12, y + 90, 14, 6, 0.5, 0, Math.PI * 2); g.fill();
    for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; blob(g, x + Math.cos(a) * 12, y + Math.sin(a) * 12, 6, k % 2 ? '#f7c62f' : '#f2b21f'); }
    blob(g, x, y, 9, '#6b4423');
  }
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
function makeRidge(w, h, L, H) {
  const c = makeCanvas(w, h), g = c.getContext('2d');
  if (L.kind === 'sea') {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, L.light); grad.addColorStop(1, L.color);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = 0; i < w / 6; i++) {
      const x = hash(i * 1.7) * w, y = Math.pow(hash(i * 2.3), 1.5) * h;
      g.fillRect(x, y, 6 + hash(i) * 18 * (y / h + 0.3), 1 + (y / h) * 1.5);
    }
    return c;
  }
  const amp = L.amp * H, seed = L.freq * 1.37;
  const ridge = (x) => {
    const u = (x / w) * Math.PI * 2;
    let r = 0.55 + 0.25 * Math.sin(u * L.freq + seed) + 0.15 * Math.sin(u * L.freq * 2.3 + seed * 2) + 0.05 * Math.sin(u * 11);
    if (L.flat) r = Math.min(r, L.flat);
    return h - amp * r;
  };
  const grad = g.createLinearGradient(0, h - amp, 0, h);
  grad.addColorStop(0, L.top); grad.addColorStop(1, L.base);
  g.fillStyle = grad;
  g.beginPath(); g.moveTo(0, h);
  for (let x = 0; x <= w; x += 4) g.lineTo(x, ridge(x));
  g.lineTo(w, h); g.fill();
  if (L.snow) {
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = '#f4f8fb';
    g.beginPath(); g.moveTo(0, 0);
    for (let x = 0; x <= w; x += 8) g.lineTo(x, h - amp * (0.66 + 0.04 * Math.sin(x * 0.05)));
    g.lineTo(w, 0); g.fill();
    g.globalCompositeOperation = 'source-over';
  }
  if (L.flat) { // cliff bands on mesas
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(255,255,255,0.12)';
    for (let k = 1; k < 4; k++) g.fillRect(0, h - amp * L.flat * (k / 4), w, amp * 0.04);
    g.globalCompositeOperation = 'source-over';
  }
  if (L.trees) {
    const step = Math.max(3, w / 600), size = L.trees.size * H;
    g.fillStyle = L.trees.color;
    for (let x = 0; x < w; x += step) {
      if (hash(x * 0.37 + seed * 100) > L.trees.density) continue;
      const th = size * (0.6 + hash(x + seed) * 0.7), tw = th * 0.32;
      const y = ridge(x) + th * 0.25 + hash(x * 3) * size * 0.6;
      for (const ox of [0, w, -w]) {
        if (ox && (x + ox < -tw || x + ox > w + tw)) continue;
        g.beginPath(); g.moveTo(x + ox, y - th); g.lineTo(x + ox + tw, y); g.lineTo(x + ox - tw, y); g.fill();
      }
    }
  }
  return c;
}

const MAKERS = {
  oak: (s, p) => makeOak(s, p.oak), birch: (s, p) => makeBirch(s, p.birch), pine: (s, p) => makePine(s, p.pine),
  rock: (s, p) => makeRock(s, p.rock), flowers: (s, p) => makeFlowers(s, p.flowers), bush: (s, p) => makeBush(s, p.bush),
  cactus: (s) => makeCactus(s), palm: (s) => makePalm(s), sunflowers: (s) => makeSunflowers(s),
};
const VARIANTS = { oak: 3, birch: 2, pine: 2, rock: 3, flowers: 4, bush: 2, cactus: 2, palm: 3, sunflowers: 3 };
// World heights (m) per sprite type.
const SIZE = { oak: 10, birch: 11, pine: 13, rock: 1.3, flowers: 0.7, bush: 1.6, cactus: 5, palm: 10, sunflowers: 1.9 };

const spriteCache = new Map();
function spritesFor(themeId, theme) {
  if (spriteCache.has(themeId)) return spriteCache.get(themeId);
  const set = { cloud: [makeCloud(1), makeCloud(2), makeCloud(3)] };
  for (const { type } of theme.scenery) {
    if (!set[type]) set[type] = Array.from({ length: VARIANTS[type] }, (_, i) => MAKERS[type](i + 1, theme.palette));
  }
  spriteCache.set(themeId, set);
  return set;
}

/** Deterministic roadside scenery for a segment index. */
function sceneryFor(idx, theme) {
  const items = [];
  for (const side of [-1, 1]) {
    theme.scenery.forEach((sc, j) => {
      const h = (k) => hash(idx * 7.13 + side * 3.7 + (j * 4 + k) * 19.1);
      if (h(0) < sc.prob) {
        items.push({ type: sc.type, side, off: sc.off[0] + h(1) * (sc.off[1] - sc.off[0]), v: Math.floor(h(2) * VARIANTS[sc.type]) });
      }
    });
  }
  return items.sort((a, b) => b.off - a.off); // outer items first
}

/** Fences run in long stretches, independently on each side. */
const fenceOn = (idx, side, theme) => !!theme.fence && hash(Math.floor(idx / 50) * 3.1 + side * 11.7) < theme.fence.prob;
const FENCE_OFF = 1.18;

export class Scene {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bgOffset = 0;
    this.cloudDrift = 0;
    this.themeId = null;
    this.flakes = Array.from({ length: 140 }, (_, i) => ({ x: hash(i * 3.3), y: hash(i * 5.1), s: 0.4 + hash(i * 7.7) * 0.6 }));
    window.addEventListener('resize', () => this.resize());
  }

  setTheme(id) {
    if (id === this.themeId) return;
    this.themeId = id;
    this.t = themeFor(id);
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    if (!this.t) return;
    const W = this.canvas.width, H = this.canvas.height;
    this.layers = this.t.layers.map((L, i) => {
      const h = Math.round(L.kind === 'sea' ? H * L.height : H * (L.amp + 0.03));
      return { img: makeRidge(Math.round(W * 2), h, L, H), parallax: L.kind === 'sea' ? 0 : [0.15, 0.3, 0.5][i] ?? 0.5, color: L.base || L.color };
    });
  }

  /**
   * @param route Route
   * @param dist rider position, m
   * @param riders [{dist, color, stripe, name, pedal, self, lane}]
   */
  render(route, dist, riders, dtDist) {
    this.setTheme(route.theme || 'meadow');
    const T = this.t;
    FOG = T.fog;
    const S = spritesFor(this.themeId, T);
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

    // sky, sun, clouds, background layers
    const minSy = Math.min(horizon, ...pts.slice(-40).map((p) => p.sy));
    const g = ctx.createLinearGradient(0, 0, 0, minSy);
    g.addColorStop(0, T.sky[0]);
    g.addColorStop(1, T.sky[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (T.sun) {
      const sx = ((T.sun.x - this.bgOffset * 0.05) % 1 + 1) % 1 * W, sy = minSy - H * 0.12, r = T.sun.r * H;
      const glow = ctx.createRadialGradient(sx, sy, r * 0.5, sx, sy, r * 5);
      glow.addColorStop(0, T.sun.glow); glow.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = glow; ctx.fillRect(0, 0, W, minSy);
      blob(ctx, sx, sy, r, T.sun.color);
    }
    for (let i = 0; i < T.clouds; i++) {
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
    ctx.fillStyle = T.ground || this.layers[this.layers.length - 1].color;
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
      ctx.fillStyle = mix(T.grass[band], FOG, fog);
      ctx.fillRect(0, Math.min(p2.sy, p1.sy), W, Math.abs(p1.sy - p2.sy) + 1);
      quad(ctx, p1.sx, p1.sy, p1.sw * 1.12, p2.sx, p2.sy, p2.sw * 1.12, mix(T.verge[band], FOG, fog));
      quad(ctx, p1.sx, p1.sy, p1.sw, p2.sx, p2.sy, p2.sw, mix(T.road[band], FOG, fog));
      const lineCol = mix(T.line, FOG, fog);
      for (const side of [-1, 1]) {
        quad(ctx, p1.sx + side * p1.sw * 0.9, p1.sy, p1.sw * 0.022, p2.sx + side * p2.sw * 0.9, p2.sy, p2.sw * 0.022, lineCol);
      }

      if (p1.z > 2.5) {
        const items = sceneryFor(p1.idx, T);
        const alpha = 1 - fog * 0.85;
        const fenced = { [-1]: fenceOn(p1.idx, -1, T), [1]: fenceOn(p1.idx, 1, T) };
        for (const it of items) {
          if (it.off < FENCE_OFF + 0.05 && fenced[it.side]) continue;
          if (it.off > FENCE_OFF) this._sprite(S[it.type][it.v], p1, it, alpha, half);
        }
        for (const side of [-1, 1]) if (fenced[side]) this._fence(p1, p2, side, fog, half);
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

    if (T.snowfall) this._snow(W, H, dtDist || 0);
  }

  _snow(W, H, moved) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const f of this.flakes) {
      f.y += 0.0012 * f.s + moved * 0.0006 * f.s;
      f.x += Math.sin(f.y * 12 + f.s * 9) * 0.0006;
      if (f.y > 1) { f.y -= 1; f.x = Math.random(); }
      blob(ctx, ((f.x % 1) + 1) % 1 * W, f.y * H, (1 + f.s * 2.2) * (W / 1280), 'rgba(255,255,255,0.85)');
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
    const F = this.t.fence;
    const x1 = p1.sx + side * p1.sw * FENCE_OFF, x2 = p2.sx + side * p2.sw * FENCE_OFF;
    const h1 = p1.s * half, h2 = p2.s * half; // pixels per metre
    const wood = mix(F.wood, FOG, fog), dark = mix(F.dark, FOG, fog);
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
  const f = (rgb) => mix(rgb, FOG, fog);
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
export function drawProfile(canvas, route, riders, fill = 'rgba(255,255,255,0.22)') {
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
  ctx.fillStyle = fill;
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
