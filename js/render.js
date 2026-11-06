// Pseudo-3D road renderer (segment projection, painter's algorithm).
import { SEG } from './routes.js';

const DRAW = 260;            // segments drawn ahead
const ROAD_W = 4;            // half road width, m
const CAM_H = 2.4;           // camera height above road, m
const CAM_BACK = 8;          // camera distance behind the rider, m
const V_EXAG = 2.2;          // vertical exaggeration so hills read on screen
const FOV = 95 * Math.PI / 180;
const DEPTH = 1 / Math.tan(FOV / 2);

const C = {
  skyTop: '#5aa7e6', skyBottom: '#cfe8f7', fog: [207, 232, 247],
  grass: [[92, 160, 72], [84, 150, 66]],
  road: [[96, 100, 108], [90, 94, 102]],
  rumble: [[235, 235, 235], [205, 60, 60]],
  lane: [245, 245, 245],
};

const mix = (c, f, t) => `rgb(${(c[0] + (f[0] - c[0]) * t) | 0},${(c[1] + (f[1] - c[1]) * t) | 0},${(c[2] + (f[2] - c[2]) * t) | 0})`;

export class Scene {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bgOffset = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
  }

  /**
   * @param route Route
   * @param dist rider position, m
   * @param riders [{dist, color, name, pedal, self}]
   */
  render(route, dist, riders, dtDist) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const segs = route.segments, n = segs.length;
    const camDist = dist - CAM_BACK;
    const base = Math.floor(route.wrap(camDist) / SEG);
    const frac = (route.wrap(camDist) % SEG) / SEG;

    this.bgOffset += segs[base].curve * (dtDist || 0) * 0.6;
    const camY = route.elevAt(dist) * V_EXAG + CAM_H;
    const horizon = H * 0.42;

    // project segment boundary points
    const pts = [];
    let x = 0, dx = -segs[base].curve * frac;
    for (let k = 0; k <= DRAW; k++) {
      const idx = (base + k) % n;
      const z = Math.max((k - frac) * SEG, 0.4);
      const s = DEPTH / z;
      pts.push({
        sx: W / 2 + s * x * W / 2,
        sy: horizon - s * (segs[idx].elev * V_EXAG - camY) * H / 2 * 1.0,
        sw: s * ROAD_W * W / 2,
        s, z, idx,
      });
      x += dx;
      dx += segs[idx].curve;
    }

    // sky + distant hills (parallax by curvature)
    const minSy = Math.min(horizon, ...pts.slice(-40).map((p) => p.sy));
    const g = ctx.createLinearGradient(0, 0, 0, H * 0.6);
    g.addColorStop(0, C.skyTop);
    g.addColorStop(1, C.skyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    this._mountains(W, minSy, '#a9c7d9', 0.25, 70, 0.3);
    this._mountains(W, minSy, '#8fb5a0', 0.5, 40, 0.6);
    ctx.fillStyle = mix(C.grass[0], C.fog, 0.85);
    ctx.fillRect(0, minSy, W, H - minSy);

    // sprites per segment index
    const spritesAt = new Map();
    for (const r of riders) {
      if (r.self) continue;
      let ahead = route.wrap(r.dist - camDist);
      if (ahead > DRAW * SEG - SEG) continue;
      const k = Math.floor(ahead / SEG);
      if (!spritesAt.has(k)) spritesAt.set(k, []);
      spritesAt.get(k).push({ type: 'rider', r, t: (ahead / SEG) - k });
    }

    // painter's algorithm: far to near
    for (let k = DRAW - 1; k >= 0; k--) {
      const p1 = pts[k], p2 = pts[k + 1];
      const seg = segs[p1.idx];
      const fog = Math.min(1, Math.pow(p1.z / (DRAW * SEG), 1.6));
      const band = Math.floor(p1.idx / 3) % 2;
      ctx.fillStyle = mix(C.grass[band], C.fog, fog);
      ctx.fillRect(0, Math.min(p2.sy, p1.sy), W, Math.abs(p1.sy - p2.sy) + 1);
      quad(ctx, p1.sx, p1.sy, p1.sw * 1.15, p2.sx, p2.sy, p2.sw * 1.15, mix(C.rumble[band], C.fog, fog));
      quad(ctx, p1.sx, p1.sy, p1.sw, p2.sx, p2.sy, p2.sw, mix(C.road[band], C.fog, fog));
      if (band === 0) quad(ctx, p1.sx, p1.sy, p1.sw * 0.025, p2.sx, p2.sy, p2.sw * 0.025, mix(C.lane, C.fog, fog));

      // scenery
      if (seg.tree) {
        const side = seg.tree;
        const tx = p1.sx + side * p1.sw * seg.treeOffset;
        this._tree(tx, p1.sy, p1.s * W / 2 * 7, fog);
      }
      const list = spritesAt.get(k);
      if (list) {
        for (const sp of list) {
          const sx = p1.sx + (p2.sx - p1.sx) * sp.t;
          const sy = p1.sy + (p2.sy - p1.sy) * sp.t;
          const sc = p1.s + (p2.s - p1.s) * sp.t;
          const lane = sp.r.lane ?? 0;
          drawCyclist(ctx, sx + lane * sc * W / 2, sy, sc * W / 2 * 1.8, sp.r.color, sp.r.pedal, fog, sp.r.name);
        }
      }
    }

    // own rider, just in front of the camera
    const me = riders.find((r) => r.self);
    if (me) {
      const k = Math.floor(CAM_BACK / SEG);
      const t = (CAM_BACK / SEG) - k + frac;
      const a = pts[Math.min(k + Math.floor(t), DRAW - 1)], b = pts[Math.min(k + Math.floor(t) + 1, DRAW)];
      const tt = t - Math.floor(t);
      const sy = a.sy + (b.sy - a.sy) * tt;
      const sx = a.sx + (b.sx - a.sx) * tt;
      const sc = a.s + (b.s - a.s) * tt;
      drawCyclist(ctx, sx + (me.lane ?? 0.9) * sc * W / 2, sy, sc * W / 2 * 1.8, me.color, me.pedal, 0, null);
    }
  }

  _mountains(W, y, color, parallax, height, seed) {
    const ctx = this.ctx;
    const off = this.bgOffset * parallax * W;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let px = 0; px <= W; px += 8) {
      const u = (px + off) / W;
      const h = (Math.sin(u * 6.1 + seed) * 0.5 + Math.sin(u * 13.7 + seed * 3) * 0.3 + Math.sin(u * 2.3) * 0.6 + 1.4) / 2.8;
      ctx.lineTo(px, y - h * height * (W / 1000));
    }
    ctx.lineTo(W, y);
    ctx.closePath();
    ctx.fill();
  }

  _tree(x, y, size, fog) {
    if (size < 1.5) return;
    const ctx = this.ctx;
    ctx.fillStyle = mix([110, 78, 50], C.fog, fog);
    ctx.fillRect(x - size * 0.05, y - size * 0.35, size * 0.1, size * 0.35);
    ctx.fillStyle = mix([46, 110, 58], C.fog, fog);
    ctx.beginPath();
    ctx.moveTo(x, y - size * 1.1);
    ctx.lineTo(x + size * 0.3, y - size * 0.3);
    ctx.lineTo(x - size * 0.3, y - size * 0.3);
    ctx.closePath();
    ctx.fill();
  }
}

function quad(ctx, x1, y1, w1, x2, y2, w2, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1 - w1, y1);
  ctx.lineTo(x2 - w2, y2);
  ctx.lineTo(x2 + w2, y2);
  ctx.lineTo(x1 + w1, y1);
  ctx.closePath();
  ctx.fill();
}

/** Rear view of a cyclist. `size` ≈ rider height in px. */
export function drawCyclist(ctx, x, y, size, color, pedal, fog = 0, label = null) {
  if (size < 3) return;
  const u = size / 10;
  const f = (rgb) => mix(rgb, C.fog, fog);
  const jersey = hexToRgb(color);
  ctx.save();
  ctx.lineCap = 'round';
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(x, y, u * 1.6, u * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  // rear wheel
  ctx.strokeStyle = f([25, 25, 25]);
  ctx.lineWidth = u * 0.45;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - u * 3.2); ctx.stroke();
  // legs (alternate with pedal angle)
  const l = Math.sin(pedal) * u * 0.9;
  ctx.strokeStyle = f([30, 30, 40]);
  ctx.lineWidth = u * 0.7;
  ctx.beginPath(); ctx.moveTo(x - u * 0.55, y - u * 5); ctx.lineTo(x - u * 0.75, y - u * 3.2 + l); ctx.lineTo(x - u * 0.5, y - u * 1.6 + l); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + u * 0.55, y - u * 5); ctx.lineTo(x + u * 0.75, y - u * 3.2 - l); ctx.lineTo(x + u * 0.5, y - u * 1.6 - l); ctx.stroke();
  // torso
  ctx.fillStyle = f(jersey);
  ctx.beginPath();
  ctx.moveTo(x - u * 1.0, y - u * 5.2);
  ctx.lineTo(x + u * 1.0, y - u * 5.2);
  ctx.lineTo(x + u * 1.3, y - u * 7.6);
  ctx.lineTo(x - u * 1.3, y - u * 7.6);
  ctx.closePath();
  ctx.fill();
  // arms
  ctx.strokeStyle = f(jersey);
  ctx.lineWidth = u * 0.55;
  ctx.beginPath(); ctx.moveTo(x - u * 1.2, y - u * 7.4); ctx.lineTo(x - u * 1.5, y - u * 5.6); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + u * 1.2, y - u * 7.4); ctx.lineTo(x + u * 1.5, y - u * 5.6); ctx.stroke();
  // helmet
  ctx.fillStyle = f([240, 240, 240]);
  ctx.beginPath(); ctx.ellipse(x, y - u * 8.4, u * 0.85, u * 0.75, 0, 0, Math.PI * 2); ctx.fill();
  if (label && size > 18 && fog < 0.7) {
    ctx.font = `600 ${Math.max(11, u * 1.3)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(255,255,255,${1 - fog})`;
    ctx.strokeStyle = `rgba(0,0,0,${0.6 * (1 - fog)})`;
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
    const px = (d / route.length) * W;
    ctx.fillStyle = r.color;
    ctx.beginPath();
    ctx.arc(px, yOf(route.elevAt(d)), (r.self ? 5 : 3.5) * dpr, 0, Math.PI * 2);
    ctx.fill();
    if (r.self) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.stroke(); }
  }
}
