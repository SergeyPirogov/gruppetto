// Real 3D renderer (three.js, WebGL) in a low-poly illustrated style.
// The world streams in 200 m chunks along the route: terrain with hills and valleys,
// road, scenery, fences, water, distant mountains and 3D riders. Same interface as the 2D Scene.
import * as THREE from '../vendor/three/three.module.min.js';
import { SEG } from './routes.js';
import { themeFor } from './themes.js';
import { loadRiderModel, ModelRider } from './rider-model.js';
import { loadDummyRider, DummyRider } from './dummy-rider.js';
import { loadNature, natureMaterials } from './nature.js';
import { loadBikeModel, ModelBike } from './bike-model.js';

const CHUNK = 40;              // segments per chunk (200 m)
const AHEAD = 7, BEHIND = 1;   // chunks kept around the rider
const ROAD_HALF = 3.6;         // m
const TURN = 2.5;              // curvature exaggeration relative to the 2D renderer
const V_EXAG = 1.5;            // vertical exaggeration
const A0 = -400;               // first segment index held in the path cache

// Terrain cross-section offsets (m from the road centre).
const COLS = [-300, -200, -130, -85, -55, -36, -24, -16, -10, -7, -4.3, 4.3, 7, 10, 16, 24, 36, 55, 85, 130, 200, 300];

// 3D-specific look per theme.
const T3 = {
  meadow: { amp: 18, far: 0.3 },
  river: { amp: 8, far: 0.25, dip: { side: -1, from: 22, to: 40, depth: 16 } },
  steppe: { amp: 4, far: 0.03 },
  coast: { amp: 10, far: 0.06, dip: { side: -1, from: 16, to: 55, depth: 34 }, beach: true },
  autumn: { amp: 20, far: 0.45 },
  sunset: { amp: 22, far: 0.3 },
  winter: { amp: 18, far: 0.45 },
  desert: { amp: 16, far: 0.12, wall: 45, rock: 10, rockColor: '#b65a3a' },
  carpathians: { amp: 30, far: 0.6, wall: 55, rock: 60 },
  alpine: { amp: 28, far: 0.45, wall: 75, rock: 50, snow: 85 },
};
const TREE_TYPES = ['pine', 'oak', 'birch', 'palm', 'cactus'];
const SHOW_RIDER = typeof location === 'undefined' || new URLSearchParams(location.search).get('rider') !== '0'; // ?rider=0: bike only
const SIZE = { oak: 1, birch: 1, pine: 1, rock: 1, bush: 1, cactus: 1, palm: 1, sunflowers: 1, flowers: 1 };

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hash = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const hash2 = (x, z) => { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); };
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, z) => vnoise(x / 190, z / 190) * 0.6 + vnoise(x / 70, z / 70) * 0.3 + vnoise(x / 24, z / 24) * 0.1;
/** Leaf colour of a scenery type on this route (the Quaternius textures keep their light and shade). */
function natureTint(theme, type) {
  const p = theme.palette;
  const hex = { oak: p.oak.mid, birch: p.birch?.mid || p.oak.light, pine: p.pine.light, bush: p.bush.mid }[type] || '#7dbb4a';
  const c = new THREE.Color(hex);
  if (type === 'pine') c.offsetHSL(0, 0, 0.08); // the palette's pine is meant for flat shading: lift it
  if (type === 'pine' && p.pine.snow) c.lerp(new THREE.Color(p.pine.snow), 0.35);
  return c;
}
const rgb = (c) => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
const col = (hex) => new THREE.Color(hex);

// ---------- Geometry helpers ----------

/** Merge parts [{geom, color, pos?, rot?, scale?}] into one non-indexed geometry with vertex colours. */
function merge(parts) {
  const pos = [], nor = [], colr = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  for (const p of parts) {
    let g = p.geom.index ? p.geom.toNonIndexed() : p.geom.clone();
    e.set(...(p.rot || [0, 0, 0]));
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(...(p.pos || [0, 0, 0])), q, new THREE.Vector3(...(p.scale || [1, 1, 1])));
    g.applyMatrix4(m);
    if (p.jitter) {
      const a = g.attributes.position;
      for (let i = 0; i < a.count; i++) {
        const k = Math.round(a.getX(i) * 31 + a.getY(i) * 17 + a.getZ(i) * 13);
        a.setXYZ(i, a.getX(i) * (1 + (hash(k) - 0.5) * p.jitter), a.getY(i) * (1 + (hash(k + 1) - 0.5) * p.jitter), a.getZ(i) * (1 + (hash(k + 2) - 0.5) * p.jitter));
      }
    }
    g.computeVertexNormals();
    if (!p.flat) smoothNormals(g);
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
    const c = p.color instanceof THREE.Color ? p.color : col(p.color);
    for (let i = 0; i < g.attributes.position.count; i++) colr.push(c.r, c.g, c.b);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  return out;
}

/** Average normals of coincident vertices so blobs look soft instead of faceted. */
function smoothNormals(g) {
  const p = g.attributes.position, nrm = g.attributes.normal, acc = new Map();
  const key = (i) => `${Math.round(p.getX(i) * 1000)},${Math.round(p.getY(i) * 1000)},${Math.round(p.getZ(i) * 1000)}`;
  for (let i = 0; i < p.count; i++) {
    const k = key(i), a = acc.get(k) || [0, 0, 0];
    a[0] += nrm.getX(i); a[1] += nrm.getY(i); a[2] += nrm.getZ(i);
    acc.set(k, a);
  }
  for (let i = 0; i < p.count; i++) {
    const a = acc.get(key(i)), l = Math.hypot(a[0], a[1], a[2]) || 1;
    nrm.setXYZ(i, a[0] / l, a[1] / l, a[2] / l);
  }
}

const cyl = (rt, rb, h, s = 6) => new THREE.CylinderGeometry(rt, rb, h, s);
const cone = (r, h, s = 7) => new THREE.ConeGeometry(r, h, s);
const ico = (r, d = 0) => new THREE.IcosahedronGeometry(r, d);

/** Small repeatable surface maps; no downloads or canvas readback required. */
function surfaceTexture(water = false) {
  const size = 128, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size * Math.PI * 2, v = y / size * Math.PI * 2;
    const value = water
      ? 128 + Math.sin(u * 3 + Math.sin(v * 2)) * 42 + Math.sin(v * 5 + u * 2) * 22
      : 224 + hash2(x, y) * 31;
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function sunGlowTexture() {
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
    const i = (y * size + x) * 4;
    data[i] = 255; data[i + 1] = 214; data[i + 2] = 154;
    data[i + 3] = Math.pow(Math.max(0, 1 - r), 3) * 150;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function buildModels(theme) {
  const p = theme.palette;
  const M = {};
  M.pine = merge([
    { geom: cyl(0.22, 0.32, 2.4), color: p.pine.trunk, pos: [0, 1.2, 0] },
    { geom: cone(2.7, 4.2), color: p.pine.dark, pos: [0, 4.0, 0] },
    { geom: cone(2.1, 3.6), color: p.pine.light, pos: [0, 6.2, 0] },
    { geom: cone(1.4, 3.0), color: p.pine.dark, pos: [0, 8.2, 0] },
    ...(p.pine.snow ? [
      { geom: cone(1.5, 1.6), color: p.pine.snow, pos: [0, 5.4, 0] },
      { geom: cone(1.1, 1.4), color: p.pine.snow, pos: [0, 7.4, 0] },
      { geom: cone(0.7, 1.2), color: p.pine.snow, pos: [0, 9.2, 0] },
    ] : []),
  ]);
  M.oak = merge([
    { geom: cyl(0.3, 0.45, 3.4), color: p.oak.trunk, pos: [0, 1.7, 0] },
    { geom: ico(2.6, 1), color: p.oak.mid, pos: [0, 5.0, 0], jitter: 0.18 },
    { geom: ico(1.9, 1), color: p.oak.dark, pos: [1.7, 4.3, 0.7], jitter: 0.18 },
    { geom: ico(2.0, 1), color: p.oak.dark, pos: [-1.6, 4.5, -0.6], jitter: 0.18 },
    { geom: ico(1.7, 1), color: p.oak.light, pos: [0.3, 6.6, 0.4], jitter: 0.18 },
    { geom: ico(1.4, 1), color: p.oak.light, pos: [-0.9, 6.0, 1.1], jitter: 0.18 },
    { geom: ico(1.5, 1), color: p.oak.mid, pos: [1.0, 5.6, -1.2], jitter: 0.18 },
  ]);
  M.birch = merge([
    { geom: cyl(0.14, 0.2, 7), color: '#efede6', pos: [0, 3.5, 0] },
    { geom: new THREE.BoxGeometry(0.42, 0.08, 0.42), color: '#2b2b2b', pos: [0, 2.0, 0] },
    { geom: new THREE.BoxGeometry(0.4, 0.07, 0.4), color: '#2b2b2b', pos: [0, 3.4, 0] },
    { geom: ico(1.5, 1), color: p.birch.mid, pos: [0, 7.0, 0], jitter: 0.3 },
    { geom: ico(1.1, 1), color: p.birch.dark, pos: [0.8, 6.0, 0.3], jitter: 0.3 },
    { geom: ico(1.0, 1), color: p.birch.light, pos: [-0.6, 8.0, -0.2], jitter: 0.3 },
  ]);
  M.rock = merge([{ geom: new THREE.DodecahedronGeometry(1, 1), color: p.rock.base, pos: [0, 0.35, 0], scale: [1.5, 0.85, 1.15], jitter: 0.22 }]);
  M.bush = merge([
    { geom: ico(0.9, 1), color: p.bush.mid, pos: [0, 0.6, 0], scale: [1.3, 0.8, 1.1], jitter: 0.2 },
    { geom: ico(0.7, 1), color: p.bush.dark, pos: [0.75, 0.45, 0.2], jitter: 0.2 },
    { geom: ico(0.6, 1), color: p.bush.mid, pos: [-0.7, 0.4, -0.2], jitter: 0.2 },
  ]);
  M.cactus = merge([
    { geom: cyl(0.32, 0.36, 4.2, 8), color: '#3f7a3a', pos: [0, 2.1, 0] },
    { geom: ico(0.34, 1), color: '#4f8a44', pos: [0, 4.2, 0] },
    { geom: cyl(0.2, 0.2, 0.9, 7), color: '#3f7a3a', pos: [-0.55, 2.0, 0], rot: [0, 0, Math.PI / 2] },
    { geom: cyl(0.2, 0.22, 1.5, 7), color: '#4f8a44', pos: [-0.95, 2.7, 0] },
    { geom: cyl(0.2, 0.2, 0.8, 7), color: '#3f7a3a', pos: [0.5, 1.6, 0], rot: [0, 0, Math.PI / 2] },
    { geom: cyl(0.2, 0.22, 1.2, 7), color: '#4f8a44', pos: [0.85, 2.15, 0] },
  ]);
  const palm = [];
  for (let i = 0; i < 7; i++) {
    const t = i / 7;
    palm.push({ geom: cyl(0.2 - t * 0.06, 0.24 - t * 0.06, 1.25, 7), color: i % 2 ? '#8a6a44' : '#9e7c50', pos: [t * t * 1.4, 0.6 + i * 1.2, 0], rot: [0, 0, -t * 0.25] });
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    palm.push({ geom: new THREE.BoxGeometry(3.4, 0.06, 0.55), color: i % 2 ? '#2f7a3a' : '#43964a', pos: [1.4 + Math.cos(a) * 1.5, 8.5, Math.sin(a) * 1.5], rot: [0, -a, -0.45] });
  }
  M.palm = merge(palm);
  M.sunflowers = merge([
    { geom: cyl(0.03, 0.04, 1.7, 4), color: '#4f7f2e', pos: [0, 0.85, 0] },
    { geom: new THREE.BoxGeometry(0.35, 0.02, 0.12), color: '#5f9436', pos: [0.15, 0.8, 0], rot: [0, 0, 0.4] },
    { geom: cyl(0.2, 0.2, 0.05, 10), color: '#f5c02a', pos: [0.05, 1.72, 0], rot: [0, 0, Math.PI / 2 - 0.3] },
    { geom: cyl(0.09, 0.09, 0.07, 8), color: '#6b4423', pos: [0.08, 1.73, 0], rot: [0, 0, Math.PI / 2 - 0.3] },
  ]);
  M.flower = merge([{ geom: ico(0.11), color: '#ffffff', pos: [0, 0.35, 0] }, { geom: cyl(0.01, 0.015, 0.35, 3), color: '#5c9a3a', pos: [0, 0.17, 0] }]);
  M.tuft = merge(Array.from({ length: 7 }, (_, i) => {
    const h = 0.22 + hash(i + 4) * 0.32, a = i * 2.4;
    return { geom: cone(0.035, h, 3), color: p.flowers.blades[i % 2],
      pos: [Math.cos(a) * 0.15, h * 0.44, Math.sin(a) * 0.15],
      rot: [Math.sin(a) * 0.3, a, Math.cos(a) * 0.3] };
  }));
  M.delineator = merge([
    { geom: new THREE.BoxGeometry(0.12, 0.9, 0.16), color: '#eeeade', pos: [0, 0.45, 0], flat: true },
    { geom: new THREE.BoxGeometry(0.135, 0.19, 0.175), color: '#29333c', pos: [0, 0.68, 0], flat: true },
    { geom: new THREE.BoxGeometry(0.145, 0.075, 0.1), color: '#ffc06b', pos: [0, 0.69, 0], flat: true },
  ]);
  M.post = merge([{ geom: new THREE.BoxGeometry(0.16, 1.15, 0.16), color: '#ffffff', pos: [0, 0.575, 0], flat: true }]);
  M.rail = merge([{ geom: new THREE.BoxGeometry(1, 0.13, 0.07), color: '#ffffff', flat: true }]);
  M.lupine = merge([
    { geom: cyl(0.012, 0.016, 0.7, 4), color: '#5c9a3a', pos: [0, 0.35, 0] },
    ...Array.from({ length: 7 }, (_, k) => ({ geom: ico(0.055 - k * 0.004, 0), color: k % 2 ? '#8a6cc4' : '#a68ae0', pos: [0, 0.42 + k * 0.06, 0] })),
  ]);
  return M;
}

// ---------- Rider ----------

const SKIN = '#e0a47a', SHORTS = '#1d1f26', SOCK = '#f5f5f5', SHOE = '#22242a';

/** Three-tone ramp for the illustrated (toon) look. */
let TOON_RAMP = null;
function toonRamp() {
  if (TOON_RAMP) return TOON_RAMP;
  const data = new Uint8Array([110, 110, 110, 255, 185, 185, 185, 255, 255, 255, 255, 255]);
  TOON_RAMP = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  TOON_RAMP.minFilter = TOON_RAMP.magFilter = THREE.NearestFilter;
  TOON_RAMP.needsUpdate = true;
  return TOON_RAMP;
}

/** Scale a y-aligned geometry's cross-section along its length: f(t) -> [sx, sz], t = 0 (bottom) .. 1 (top). */
function shape(geom, f) {
  geom.computeBoundingBox();
  const { min, max } = geom.boundingBox, p = geom.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - min.y) / (max.y - min.y || 1);
    const [sx, sz] = f(t);
    p.setX(i, p.getX(i) * sx);
    p.setZ(i, p.getZ(i) * sz);
  }
  geom.computeVertexNormals();
  return geom;
}
const lerp = (a, b, t) => a + (b - a) * t;

class Rider3D {
  constructor(jersey, stripe, label, withBody = true, withBike = true, bikeColor = '#c9302c') {
    this.group = new THREE.Group();
    const mat = (c) => new THREE.MeshToonMaterial({ color: c, gradientMap: toonRamp() });
    this.mats = {
      frame: mat(bikeColor), tyre: mat('#1a1a1d'), rim: mat('#33363d'), jersey: mat(jersey), stripe: mat(stripe),
      skin: mat(SKIN), shorts: mat(SHORTS), sock: mat(SOCK), shoe: mat(SHOE), helmet: mat('#f7f7f7'), dark: mat('#26282d'),
      decal: mat(stripe), bottle: mat('#f2f2f2'),
    };
    const M = this.mats;
    const add = (geom, m, pos, rot) => {
      const mesh = new THREE.Mesh(geom, m);
      if (pos) mesh.position.set(...pos);
      if (rot) mesh.rotation.set(...rot);
      mesh.castShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    const capsule = (r, len, m, f) => add(f ? shape(new THREE.CapsuleGeometry(r, len, 8, 16), f) : new THREE.CapsuleGeometry(r, len, 8, 16), m);

    // bike (skipped when a custom assets/bike.glb is used)
    if (withBike) this._bike(add, M);
    this.cranks = withBike ? [-1, 1].map((side) => ({ side, mesh: add(new THREE.BoxGeometry(0.032, 0.17, 0.016), M.dark) })) : [];
    this.legs = [];
    if (withBody) this._body(add, capsule, M);
    if (label) this._label(label);
    this.pose(0);
  }

  _bike(add, M) {
    for (const x of [-0.5, 0.5]) {
      add(new THREE.TorusGeometry(0.335, 0.03, 12, 48), M.tyre, [x, 0.34, 0]);
      add(new THREE.TorusGeometry(0.295, 0.024, 8, 48), M.rim, [x, 0.34, 0]).scale.set(1, 1, 0.55);
      add(cyl(0.028, 0.028, 0.1, 12), M.dark, [x, 0.34, 0], [Math.PI / 2, 0, 0]);
    }
    // frame tubes drawn a little thicker than real so the bike still reads at pixel-art resolution
    const tube = (a, b, r, m) => { const rr = m === M.frame ? r * 1.6 : r; return this._orient(add(cyl(rr, rr, new THREE.Vector3(...a).distanceTo(new THREE.Vector3(...b)), 12), m), new THREE.Vector3(...a), new THREE.Vector3(...b)); };
    tube([-0.5, 0.34, 0.035], [0, 0.29, 0.02], 0.016, M.frame);
    tube([-0.5, 0.34, -0.035], [0, 0.29, -0.02], 0.016, M.frame);
    tube([0, 0.29, 0], [-0.13, 0.9, 0], 0.028, M.frame);
    tube([-0.5, 0.34, 0], [-0.12, 0.86, 0], 0.015, M.frame);
    tube([0, 0.29, 0], [0.4, 0.84, 0], 0.035, M.frame);
    tube([-0.13, 0.86, 0], [0.4, 0.88, 0], 0.026, M.frame);
    tube([0.4, 0.84, 0], [0.43, 0.95, 0], 0.028, M.frame);
    tube([0.43, 0.95, 0], [0.5, 0.34, 0], 0.018, M.frame);
    tube([-0.13, 0.9, 0], [-0.15, 0.99, 0], 0.015, M.dark);
    add(new THREE.CapsuleGeometry(0.035, 0.18, 4, 10), M.dark, [-0.16, 1.0, 0], [0, 0, Math.PI / 2]).scale.set(1, 1, 1.6);
    add(cyl(0.016, 0.016, 0.42, 10), M.dark, [0.5, 0.97, 0], [Math.PI / 2, 0, 0]);
    tube([0.43, 0.95, 0], [0.5, 0.97, 0], 0.018, M.dark);
    for (const z of [-0.2, 0.2]) tube([0.5, 0.97, z], [0.55, 0.9, z], 0.015, M.dark);
  }

  _body(add, capsule, M) {
    // torso: narrow waist, broad shoulders, flatter back
    const hip = new THREE.Vector3(-0.15, 1.04, 0), shoulder = new THREE.Vector3(0.31, 1.36, 0);
    const tl = hip.distanceTo(shoulder) - 0.16;
    const torsoShape = (t) => [lerp(0.95, 0.78, t), lerp(1.05, 1.55, Math.pow(t, 1.4))];
    this._orient(capsule(0.16, tl, M.jersey, torsoShape), hip, shoulder);
    // stripe band across the middle of the back (same profile, slightly larger)
    const bandGeom = shape(new THREE.CylinderGeometry(0.163, 0.163, 0.11, 24, 4, true), (t) => torsoShape(0.42 + t * 0.2));
    const band = add(bandGeom, M.stripe);
    this._orient(band, hip.clone().lerp(shoulder, 0.46), hip.clone().lerp(shoulder, 0.66));
    band.material.side = THREE.DoubleSide;
    // glutes / shorts
    add(new THREE.SphereGeometry(0.15, 20, 14), M.shorts, [-0.17, 1.02, 0]).scale.set(1.05, 0.85, 1.32);
    // neck, head, helmet with vents and straps
    this._orient(capsule(0.045, 0.06, M.skin), new THREE.Vector3(0.35, 1.4, 0), new THREE.Vector3(0.41, 1.47, 0));
    add(new THREE.SphereGeometry(0.098, 20, 14), M.skin, [0.45, 1.49, 0]).scale.set(1.05, 1, 0.92);
    const helmet = add(new THREE.SphereGeometry(0.13, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.64), M.helmet, [0.425, 1.495, 0], [0, 0, -0.42]);
    helmet.scale.set(1.34, 0.95, 1.05);
    for (const z of [-0.05, 0, 0.05]) add(new THREE.BoxGeometry(0.17, 0.015, 0.018), M.dark, [0.41, 1.615, z], [0, 0, -0.32]);
    for (const z of [-0.085, 0.085]) add(new THREE.BoxGeometry(0.012, 0.11, 0.01), M.dark, [0.47, 1.45, z * 1.08], [0, 0, 0.2]);
    // arms: short jersey sleeve, bare forearm, black glove
    for (const z of [-0.17, 0.17]) {
      const sh = new THREE.Vector3(0.29, 1.35, z * 1.05), el = new THREE.Vector3(0.41, 1.15, z * 1.22), hand = new THREE.Vector3(0.5, 0.99, z * 1.2);
      add(new THREE.SphereGeometry(0.066, 16, 12), M.jersey, [sh.x, sh.y, sh.z]);
      this._orient(capsule(0.06, 0.08, M.jersey), sh, sh.clone().lerp(el, 0.5));
      this._orient(capsule(0.047, sh.distanceTo(el) * 0.5, M.skin, (t) => [lerp(0.95, 1.1, t), lerp(0.95, 1.1, t)]), sh.clone().lerp(el, 0.45), el);
      this._orient(capsule(0.04, el.distanceTo(hand) - 0.05, M.skin, (t) => [lerp(0.8, 1.1, t), lerp(0.8, 1.1, t)]), el, hand);
      add(new THREE.SphereGeometry(0.044, 12, 10), M.dark, [hand.x, hand.y, hand.z]);
    }
    // legs: muscular thigh, calf bulge, sock, shoe
    this.L1 = 0.45; this.L2 = 0.45;
    const thighShape = (t) => [lerp(0.82, 1.12, t), lerp(0.85, 1.08, t)];
    const calfShape = (t) => { const b = Math.exp(-((t - 0.72) ** 2) / 0.04); return [0.72 + b * 0.42, 0.72 + b * 0.3]; };
    this.legs = [-1, 1].map((side) => ({
      side,
      shorts: capsule(0.083, 0.21, M.shorts, thighShape),
      thigh: capsule(0.066, 0.15, M.skin, thighShape),
      shin: capsule(0.056, 0.27, M.skin, calfShape),
      sock: add(cyl(0.044, 0.04, 0.1, 12), M.sock),
      shoe: add(shape(new THREE.CapsuleGeometry(0.042, 0.17, 6, 12), (t) => [1, lerp(1.05, 0.85, t)]), M.shoe),
    }));
  }

  _label(label) {
    {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 64;
      const g = c.getContext('2d');
      g.font = '600 34px system-ui, sans-serif'; g.textAlign = 'center';
      g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.strokeText(label, 128, 44);
      g.fillStyle = '#fff'; g.fillText(label, 128, 44);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
      sprite.scale.set(1.6, 0.4, 1);
      sprite.position.set(0.2, 2.0, 0);
      this.group.add(sprite);
    }
  }

  /** Place a y-aligned mesh between a and b (no scaling). */
  _orient(mesh, a, b) {
    const d = new THREE.Vector3().subVectors(b, a);
    mesh.position.copy(a).addScaledVector(d, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    return mesh;
  }


  /** Pedalling pose: feet on the crank circle, knees by two-bone IK. */
  pose(angle) {
    const { L1, L2 } = this;
    const bb = new THREE.Vector3(0, 0.29, 0);
    angle = -angle; // forward = +x: the top pedal must move forward, i.e. clockwise seen from +z
    for (const c of this.cranks) {
      const a = angle + (c.side > 0 ? 0 : Math.PI);
      c.mesh.position.set(Math.cos(a) * 0.085, bb.y + Math.sin(a) * 0.085, c.side * 0.11);
      c.mesh.rotation.set(0, 0, a - Math.PI / 2);
    }
    for (const leg of this.legs) {
      const a = angle + (leg.side > 0 ? 0 : Math.PI);
      const z = leg.side * 0.1;
      const hip = new THREE.Vector3(-0.15, 1.0, z);
      const pedal = new THREE.Vector3(Math.cos(a) * 0.17, bb.y + Math.sin(a) * 0.17, leg.side * 0.13);
      const foot = new THREE.Vector3(pedal.x - 0.02, pedal.y + 0.07, z);
      const d = Math.min(hip.distanceTo(foot), L1 + L2 - 0.002);
      const base = Math.atan2(foot.y - hip.y, foot.x - hip.x);
      const k = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))));
      const ka = base + k; // knee in front
      const knee = new THREE.Vector3(hip.x + Math.cos(ka) * L1, hip.y + Math.sin(ka) * L1, z);
      const ankle = knee.clone().add(new THREE.Vector3().subVectors(foot, knee).setLength(L2));
      this._orient(leg.shorts, hip, hip.clone().lerp(knee, 0.62));
      this._orient(leg.thigh, hip.clone().lerp(knee, 0.5), knee);
      this._orient(leg.shin, ankle.clone().lerp(knee, 0.0).lerp(knee, 0.2), knee); // calf bulge near the knee end
      this._orient(leg.sock, knee.clone().lerp(ankle, 0.8), ankle);
      leg.shoe.position.set(ankle.x + 0.05, ankle.y - 0.04, z);
      leg.shoe.rotation.set(0, 0, -Math.PI / 2 - 0.15);
    }
  }
}

// ---------- Scene ----------

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this._orbitControls(canvas);
    if (typeof window !== 'undefined' && new URLSearchParams(location.search).has('debug')) window.__scene3d = this; // for inspecting in devtools
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.3, 4000);
    this.camPos = null;
    this.chunks = new Map();
    this.riders = new Map();
    this.routeId = null;
    this.clock = 0;
    this.riderModel = null;
    this.nature = null;
    this.bikeModel = null;
    loadBikeModel().then((m) => {
      if (!m) return;
      this.bikeModel = m;
      for (const R of this.riders.values()) this.scene.remove(R.group);
      this.riders.clear(); // rebuilt with the bike model on the next frame
    });
    loadNature().then((n) => {
      if (!n) return;
      this.nature = n;
      this.natureKeep = new Set([...Object.values(n.textures), ...Object.values(n.types).flat(2).map((p) => p.geometry)]);
      this.routeId = null; // rebuild the world with the models on the next frame
    }).catch((e) => console.warn('Nature models unavailable, using built-in shapes', e));
    (SHOW_RIDER ? loadDummyRider().then((d) => d || loadRiderModel()) : Promise.resolve(null)).then((m) => {
      if (!m) return;
      this.riderModel = m;
      for (const R of this.riders.values()) this.scene.remove(R.group);
      this.riders.clear(); // rebuilt with the custom character on the next frame
    });
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Camera you can turn a little: drag (mouse or one finger) to orbit around your rider, wheel or
   * pinch to zoom, double-click or double-tap to go back to the chase view.
   */
  _orbitControls(canvas) {
    this.orbit = { yaw: 0, pitch: 0, zoom: 1 };
    const O = this.orbit;
    const pts = new Map();
    let pinch = 0, lastTap = 0;
    // kept near the chase view: up to ~30° round to either side, higher up or a little lower, a little
    // closer or farther — enough to see the rider from behind and three-quarters, never from in front
    const clampZoom = (z) => Math.max(0.6, Math.min(1.3, z));
    const clampYaw = (y) => Math.max(-0.5, Math.min(0.5, y));
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.style.cursor = 'grabbing';
      if (e.pointerType === 'touch' && pts.size === 1) {
        if (performance.now() - lastTap < 300) Object.assign(O, { yaw: 0, pitch: 0, zoom: 1 });
        lastTap = performance.now();
      }
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pts.size === 1) {
        O.yaw = clampYaw(O.yaw - dx * 0.006);
        O.pitch = Math.max(-0.1, Math.min(0.25, O.pitch + dy * 0.004));
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) O.zoom = clampZoom(O.zoom * pinch / d);
        pinch = d;
      }
    });
    const up = (e) => { pts.delete(e.pointerId); pinch = 0; if (!pts.size) canvas.style.cursor = 'grab'; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); O.zoom = clampZoom(O.zoom * Math.exp(e.deltaY * 0.0012)); }, { passive: false });
    canvas.addEventListener('dblclick', () => Object.assign(O, { yaw: 0, pitch: 0, zoom: 1 }));
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    if (this.pixel) this._setupPixel();
  }

  /** 'chase' (behind the rider, default), 'iso' (high, behind and to the side) or 'side' (high, from the side). */
  setCamera(mode) {
    this.camMode = ['iso', 'side'].includes(mode) ? mode : 'chase';
    this.camera.fov = this.camMode === 'chase' ? 62 : this.camMode === 'side' ? 34 : 30;
    this.camera.updateProjectionMatrix();
    this._isoHeading = undefined;
  }

  /** 'cartoon' (default) or 'pixel': low-res render, limited palette with dithering and outlines. */
  setStyle(style) {
    const want = style === 'pixel';
    if (want === !!this.pixel) return;
    if (this.pixel) { this.pixel.target.dispose(); this.pixel.quad.material.dispose(); }
    this.pixel = want ? {} : null;
    if (want) this._setupPixel();
  }

  _setupPixel() {
    const P = this.pixel;
    P.target?.dispose();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const VIRTUAL_W = 480; // width of the pixel grid (height follows the aspect ratio)
    const w = VIRTUAL_W, h = Math.max(1, Math.round((size.y / Math.max(1, size.x)) * VIRTUAL_W));
    P.target = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.HalfFloatType });
    P.target.depthTexture = new THREE.DepthTexture(w, h);
    if (!P.quad) {
      P.scene = new THREE.Scene();
      P.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      P.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        toneMapped: false,
        depthTest: false,
        depthWrite: false,
        uniforms: { tColor: { value: null }, tDepth: { value: null }, res: { value: new THREE.Vector2() }, near: { value: 0.3 }, far: { value: 4000 }, exposure: { value: 1.05 } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `
          uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 res; uniform float near; uniform float far; uniform float exposure;
          varying vec2 vUv;
          float viewZ(vec2 uv) { float d = texture2D(tDepth, uv).x; return (near * far) / ((far - near) * d - far); }
          vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
          float bayer4(vec2 p) {
            int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0)); int i = x + y * 4;
            float m[16]; m[0]=0.;m[1]=8.;m[2]=2.;m[3]=10.;m[4]=12.;m[5]=4.;m[6]=14.;m[7]=6.;m[8]=3.;m[9]=11.;m[10]=1.;m[11]=9.;m[12]=15.;m[13]=7.;m[14]=13.;m[15]=5.;
            for (int k = 0; k < 16; k++) if (k == i) return m[k] / 16.0 - 0.5;
            return 0.0;
          }
          void main() {
            vec2 cell = floor(vUv * res);
            vec2 uv = (cell + 0.5) / res;                       // one colour per pixel cell
            vec3 c = texture2D(tColor, uv).rgb;
            c = pow(aces(c * exposure), vec3(1.0 / 2.2));       // tone map + sRGB
            // outlines where depth jumps between neighbouring cells
            float z = -viewZ(uv);
            vec2 px = 1.0 / res;
            float e = 0.0;
            e = max(e, abs(z + viewZ(uv + vec2(px.x, 0.0))));
            e = max(e, abs(z + viewZ(uv + vec2(0.0, px.y))));
            e = max(e, abs(z + viewZ(uv - vec2(px.x, 0.0))));
            e = max(e, abs(z + viewZ(uv - vec2(0.0, px.y))));
            if (z < 900.0 && e > 0.06 * z + 0.4) c *= 0.38;
            // warm grade: cooler shadows, golden highlights, a touch more saturation
            float l = dot(c, vec3(0.299, 0.587, 0.114));
            c = mix(c, c * vec3(0.9, 0.9, 1.1), (1.0 - l) * 0.4);
            c = mix(c, c * vec3(1.08, 1.0, 0.84), l * 0.3);
            c = mix(vec3(l), c, 1.12);
            // painterly bands: quantise brightness, keep the hue; dither only near band edges
            l = dot(c, vec3(0.299, 0.587, 0.114));
            vec3 chroma = c - l;
            float bands = 12.0, t = l * bands, f = fract(t);
            float edge = clamp((f - 0.5) / 0.28 + 0.5, 0.0, 1.0);   // solid inside a band, ramp near its edge
            float lq = (floor(t) + step(bayer4(cell) + 0.5, edge)) / bands;
            chroma = floor(chroma * 28.0 + 0.5) / 28.0;
            c = lq + chroma;
            gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
          }`,
      }));
      P.scene.add(P.quad);
    }
    const u = P.quad.material.uniforms;
    u.tColor.value = P.target.texture;
    u.tDepth.value = P.target.depthTexture;
    u.res.value.set(w, h);
    u.near.value = this.camera.near;
    u.far.value = this.camera.far;
    u.exposure.value = this.renderer.toneMappingExposure;
  }

  // ----- world setup per route -----

  _setup(route) {
    for (const c of this.chunks.values()) this._dispose(c);
    this.chunks.clear();
    for (const r of this.riders.values()) this.scene.remove(r.group);
    this.riders.clear();
    // Release route-specific GPU resources when changing scenery. Shared rider
    // model resources are already detached above and remain available for reuse.
    const geometries = new Set(Object.values(this.models || {}));
    const materials = new Set([this.mat, this.roadMat].filter(Boolean));
    const textures = new Set();
    this.scene.traverse((o) => {
      if (o.geometry) geometries.add(o.geometry);
      if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
      o.shadow?.dispose();
    });
    const keep = this.natureKeep || new Set();
    for (const g of geometries) if (!keep.has(g)) g.dispose();
    for (const m of materials) {
      for (const value of Object.values(m)) if (value?.isTexture) textures.add(value);
      m.dispose();
    }
    for (const texture of textures) if (!keep.has(texture)) texture.dispose();
    this.scene.clear();

    this.route = route;
    this.routeId = route.id;
    this.t = themeFor(route.theme);
    this.t3 = T3[route.theme] || T3.meadow;
    this.models = buildModels(this.t);
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.natureMats = this.nature ? natureMaterials(this.nature) : null;
    const asphalt = surfaceTexture();
    asphalt.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.roadMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: asphalt,
      bumpMap: asphalt, bumpScale: 0.025, roughness: 0.96, metalness: 0 });
    this.path = { x: [], z: [], h: [] };
    this.minElev = route.minElev;

    const fogColor = rgb(this.t.fog);
    this.scene.fog = new THREE.Fog(fogColor, 150, 1500);
    this.scene.background = col(this.t.sky[1]);

    this.hemi = new THREE.HemisphereLight(col(this.t.sky[1]), rgb(this.t.grass[0]).multiplyScalar(0.65), 0.8); // softer fill so the sun's shading reads on the rider
    this.scene.add(this.hemi);
    this.sunDirection = this.t.sun
      ? new THREE.Vector3(Math.cos((this.t.sun.x - 0.5) * 2), 0.16, Math.sin((this.t.sun.x - 0.5) * 2)).normalize()
      : new THREE.Vector3(-0.6, 0.5, 0.62).normalize(); // low raking sun: long shadows, readable volume on the rider
    this.sun = new THREE.DirectionalLight(this.t.sun ? '#ffc48f' : '#fff2dc', this.t.sun ? 2.3 : 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 400 });
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.025;
    this.scene.add(this.sun, this.sun.target);

    this._sky();
    this._mountains();
    this._clouds();
    const sea = this.t.layers.find((l) => l.kind === 'sea');
    if (this.t3.dip) {
      const ripples = surfaceTexture(true);
      ripples.repeat.set(700, 700);
      this.water = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), new THREE.MeshPhongMaterial({ color: sea ? sea.color : '#3a8fc4', shininess: 100, specular: '#bfe8ff', bumpMap: ripples, bumpScale: 0.1, transparent: true, opacity: 0.96 }));
      this.water.rotation.x = -Math.PI / 2;
      this.water.receiveShadow = true;
      this.scene.add(this.water);
    } else this.water = null;
    if (this.t.snowfall) this._snowfall(); else this.snow = null;
  }

  _sky() {
    const g = new THREE.SphereGeometry(3500, 48, 32);
    const top = col(this.t.sky[0]), bottom = col(this.t.sky[1]);
    const cs = [];
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = Math.max(0, Math.min(1, p.getY(i) / 1600));
      const c = bottom.clone().lerp(top, Math.pow(t, 0.7));
      cs.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3));
    this.sky = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: false }));
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
    this.sunDisk = new THREE.Mesh(new THREE.CircleGeometry(this.t.sun ? 110 : 38, 48),
      new THREE.MeshBasicMaterial({ color: this.t.sun?.color || '#fff5db', fog: false, toneMapped: false, depthWrite: false }));
    this.sunDisk.renderOrder = -8;
    this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunGlowTexture(),
      transparent: true, fog: false, depthWrite: false, toneMapped: false }));
    this.sunGlow.scale.setScalar(this.t.sun ? 1100 : 650);
    this.sunGlow.renderOrder = -9;
    this.scene.add(this.sunGlow, this.sunDisk);
  }

  _mountains() {
    this.rings = [];
    const fog = rgb(this.t.fog);
    const layers = this.t.layers.filter((l) => l.kind !== 'sea').slice(0, 2);
    layers.forEach((L, li) => {
      const R = li === 0 ? 2600 : 1900, N = 220;
      const amp = L.amp * (li === 0 ? 3900 : 2100);
      const pos = [], cs = [];
      const base = col(L.base).lerp(fog, li === 0 ? 0.3 : 0.18), top = col(L.top).lerp(fog, li === 0 ? 0.25 : 0.12);
      const snow = col('#f6f9fc').lerp(fog, 0.12);
      const hgt = (i) => {
        const u = (i / N) * Math.PI * 2;
        let r = 0.55 + 0.25 * Math.sin(u * L.freq * 2 + li) + 0.15 * Math.sin(u * L.freq * 5.3 + li * 2) + 0.08 * Math.sin(u * 23);
        if (L.flat) r = Math.min(r, L.flat);
        return r * amp;
      };
      // two bands per column (rock below the snow line, snow above) so colours never smear
      const snowY = amp * 0.62;
      const H = [];
      for (let i = 0; i <= N; i++) H.push(hgt(i % N) + (hash((i % N) + li * 99) - 0.5) * amp * 0.12);
      const quad = (a0, a1, y00, y01, y10, y11, c0, c1) => {
        const v = (a, y) => [Math.cos(a) * R, y, Math.sin(a) * R];
        const P = [v(a0, y00), v(a1, y10), v(a0, y01), v(a1, y10), v(a1, y11), v(a0, y01)];
        const C = [c0, c0, c1, c0, c1, c1];
        P.forEach((q, k) => { pos.push(...q); cs.push(C[k].r, C[k].g, C[k].b); });
      };
      for (let i = 0; i < N; i++) {
        const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
        const h0 = H[i], h1 = H[i + 1];
        const m0 = L.snow ? Math.min(h0, snowY) : h0, m1 = L.snow ? Math.min(h1, snowY) : h1;
        const topC = base.clone().lerp(top, Math.min(1, Math.max(m0, m1) / amp));
        quad(a0, a1, -250, m0, -250, m1, base, topC);
        if (L.snow && (h0 > snowY || h1 > snowY)) quad(a0, a1, m0, h0, m1, h1, snow, snow);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
      mesh.renderOrder = -5;
      this.rings.push(mesh);
      this.scene.add(mesh);
    });
  }

  _clouds() {
    this.cloudGroup = new THREE.Group();
    const top = new THREE.MeshBasicMaterial({ color: col('#ffffff').lerp(rgb(this.t.fog), 0.25), fog: false });
    const under = new THREE.MeshBasicMaterial({ color: col('#c4d3e3').lerp(rgb(this.t.fog), 0.5), fog: false });
    const puff = new THREE.SphereGeometry(1, 12, 8);
    const n = this.t.clouds * 3;
    for (let i = 0; i < n; i++) {
      const cl = new THREE.Group();
      const parts = 5 + Math.floor(hash(i * 2.2) * 4);
      for (let k = 0; k < parts; k++) {
        const r = 70 + Math.sin((k / (parts - 1)) * Math.PI) * 60 + hash(i * 7 + k) * 30;
        const x = (k - (parts - 1) / 2) * 85;
        const b = new THREE.Mesh(puff, top);
        b.position.set(x, Math.sin((k / (parts - 1)) * Math.PI) * 45, (hash(i + k) - 0.5) * 60);
        b.scale.set(r, r * 0.65, r);
        const u = new THREE.Mesh(puff, under);
        u.position.set(x, b.position.y - r * 0.28, b.position.z);
        u.scale.set(r * 0.95, r * 0.38, r * 0.95);
        cl.add(u, b);
      }
      const a = hash(i * 3.7) * Math.PI * 2, rr = 1600 + hash(i * 5.1) * 1000;
      cl.position.set(Math.cos(a) * rr, 420 + hash(i * 9.3) * 380, Math.sin(a) * rr);
      cl.rotation.y = -a + Math.PI / 2;
      this.cloudGroup.add(cl);
    }
    this.scene.add(this.cloudGroup);
  }

  _snowfall() {
    const n = 2500, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = (hash(i) - 0.5) * 120; pos[i * 3 + 1] = hash(i * 2) * 40; pos[i * 3 + 2] = (hash(i * 3) - 0.5) * 120; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.snow = new THREE.Points(g, new THREE.PointsMaterial({ color: '#ffffff', size: 0.18, transparent: true, opacity: 0.9 }));
    this.scene.add(this.snow);
  }

  // ----- path -----

  _ensurePath(a) {
    const P = this.path, n = this.route.segments.length;
    while (A0 + P.h.length <= a + 1) {
      const i = P.h.length;
      if (i === 0) { P.x.push(0); P.z.push(0); P.h.push(0); continue; }
      const prev = A0 + i - 1;
      const h = P.h[i - 1] + (this.route.segments[((prev % n) + n) % n].curve * TURN) / SEG;
      P.h.push(h);
      P.x.push(P.x[i - 1] + Math.cos(P.h[i - 1]) * SEG);
      P.z.push(P.z[i - 1] + Math.sin(P.h[i - 1]) * SEG);
    }
  }

  _roadY(d) { return (this.route.elevAt(d) - this.minElev) * V_EXAG; }

  /** World frame at absolute distance d: position on the centre line, heading, right vector. */
  frame(d) {
    const a = Math.floor(d / SEG), t = d / SEG - a;
    this._ensurePath(a + 1);
    const P = this.path, i = a - A0;
    const h = P.h[i] + (P.h[i + 1] - P.h[i]) * t;
    const x = P.x[i] + (P.x[i + 1] - P.x[i]) * t, z = P.z[i] + (P.z[i + 1] - P.z[i]) * t;
    return { x, z, y: this._roadY(d), h, rx: -Math.sin(h), rz: Math.cos(h) };
  }

  _terrainY(roadY, o, x, z) {
    const T = this.t3, ao = Math.abs(o);
    const w = smooth(8, 60, ao);
    let y = roadY - 0.05 + w * (fbm(x, z) - 0.42) * 2 * T.amp;
    if (T.wall) y += smooth(10, 160, ao) * T.wall * (o < 0 ? 1 : -0.6);
    if (T.dip && Math.sign(o) === T.dip.side) y -= smooth(T.dip.from, T.dip.to, ao) * T.dip.depth;
    return y;
  }

  // ----- chunks -----

  _buildChunk(c) {
    const group = new THREE.Group();
    const a0 = c * CHUNK, rows = CHUNK + 1, nc = COLS.length;
    const n = this.route.segments.length;
    const T = this.t, T3c = this.t3;
    const grassA = rgb(T.grass[0]), grassB = rgb(T.grass[1]), verge = rgb(T.verge[0]);
    const sand = col('#e2cc96'), rockC = col(T3c.rockColor || '#8d8f8c'), snowC = col('#f2f6f9');
    const frames = [];
    for (let r = 0; r < rows; r++) frames.push(this.frame((a0 + r) * SEG));

    // terrain grid
    const pos = new Float32Array(rows * nc * 3), colors = new Float32Array(rows * nc * 3);
    const heights = [];
    for (let r = 0; r < rows; r++) {
      const f = frames[r];
      heights.push([]);
      for (let k = 0; k < nc; k++) {
        const o = COLS[k];
        const x = f.x + f.rx * o, z = f.z + f.rz * o;
        const y = this._terrainY(f.y, o, x, z);
        heights[r].push(y);
        const i = (r * nc + k) * 3;
        pos[i] = x; pos[i + 1] = y; pos[i + 2] = z;
        let cc = grassA.clone().lerp(grassB, vnoise(x / 30, z / 30));
        cc.multiplyScalar(0.92 + vnoise(x / 9, z / 9) * 0.16);
        if (Math.abs(o) < 8) cc = verge.clone();
        const rel = y - f.y;
        if (T3c.rock && rel > T3c.rock) cc = rockC.clone().lerp(cc, 0.3);
        if (T3c.snow && rel > T3c.snow) cc = snowC.clone();
        if (T3c.dip && rel < -T3c.dip.depth * 0.25 && Math.sign(o) === T3c.dip.side) cc = sand.clone();
        if (T3c.beach && Math.sign(o) === T3c.dip.side && Math.abs(o) > 10) cc = sand.clone();
        colors[i] = cc.r; colors[i + 1] = cc.g; colors[i + 2] = cc.b;
      }
    }
    const idx = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let k = 0; k < nc - 1; k++) {
        const a = r * nc + k, b = a + 1, d = a + nc, e = d + 1;
        idx.push(a, b, d, b, e, d);
      }
    }
    let tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    tg.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    tg.setIndex(idx);
    tg.computeVertexNormals(); // smooth rolling hills
    const terrain = new THREE.Mesh(tg, this.mat);
    terrain.receiveShadow = true;
    group.add(terrain);

    // road ribbon + edge lines
    const ribbon = (o1, o2, lift, color, material = this.mat, dashed = false) => {
      const p = [], cs = [], uv = [];
      const cc = color instanceof THREE.Color ? color : col(color);
      for (let r = 0; r < rows - 1; r++) {
        if (dashed && ((a0 + r) % 3 + 3) % 3 !== 0) continue;
        const f1 = frames[r], f2 = frames[r + 1];
        const v = (f, o) => [f.x + f.rx * o, f.y + lift, f.z + f.rz * o];
        const A = v(f1, o1), B = v(f1, o2), C = v(f2, o1), D = v(f2, o2);
        p.push(...A, ...B, ...C, ...B, ...D, ...C);
        // World-space coordinates keep the asphalt continuous across chunks.
        for (const v of [A, B, C, B, D, C]) uv.push(v[0] / 4, v[2] / 4);
        for (let k = 0; k < 6; k++) cs.push(cc.r, cc.g, cc.b);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, material);
      m.receiveShadow = true;
      group.add(m);
    };
    ribbon(-ROAD_HALF - 0.6, ROAD_HALF + 0.6, 0.02, verge.clone().multiplyScalar(0.85));
    ribbon(-ROAD_HALF, ROAD_HALF, 0.05, rgb(T.road[0]), this.roadMat);
    ribbon(-ROAD_HALF * 0.9 - 0.07, -ROAD_HALF * 0.9 + 0.07, 0.07, rgb(T.line));
    ribbon(ROAD_HALF * 0.9 - 0.07, ROAD_HALF * 0.9 + 0.07, 0.07, rgb(T.line));
    ribbon(-0.055, 0.055, 0.075, rgb(T.line), this.mat, true);

    // scenery placements
    const place = {};
    const put = (type, m) => (place[type] ||= []).push(m);
    const mtx = (x, y, z, rotY, s) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), new THREE.Vector3(s, s, s));
    const heightAt = (r, o) => {
      // interpolate terrain across COLS for row r
      let k = 0;
      while (k < nc - 2 && COLS[k + 1] < o) k++;
      const t = Math.max(0, Math.min(1, (o - COLS[k]) / (COLS[k + 1] - COLS[k])));
      return heights[r][k] + (heights[r][k + 1] - heights[r][k]) * t;
    };
    const treeTypes = T.scenery.filter((s) => TREE_TYPES.includes(s.type));
    const flowerPalette = T.palette.flowers.colors.map((c) => (c === 'lupine' ? '#9b7fd1' : c));
    const flowers = [], fenceSides = [];
    for (let r = 0; r < rows - 1; r++) {
      const a = a0 + r, idxN = ((a % n) + n) % n, f = frames[r];
      for (const side of [-1, 1]) {
        if (((a % 5) + 5) % 5 === 0) {
          const o = side * (ROAD_HALF + 0.45);
          put('delineator', mtx(f.x + f.rx * o, heightAt(r, o), f.z + f.rz * o, -f.h, 1));
        }
        if (!T.snowfall && !T3c.beach && this.route.theme !== 'desert') {
          for (let q = 0; q < 3; q++) {
            const seed = a * 13.7 + side * 31 + q * 7.3;
            const o = side * (4.6 + hash(seed) * 5.0);
            const ff = this.frame(a * SEG + hash(seed + 1) * SEG);
            put('tuft', mtx(ff.x + ff.rx * o, heightAt(r, o), ff.z + ff.rz * o, hash(seed + 2) * 6.28, 0.65 + hash(seed + 3) * 0.7));
          }
        }
        T.scenery.forEach((sc, j) => {
          const h = (k) => hash(idxN * 7.13 + side * 3.7 + (j * 4 + k) * 19.1);
          if (h(0) >= sc.prob) return;
          const o = side * (sc.off[0] + h(1) * (sc.off[1] - sc.off[0])) * ROAD_HALF;
          const along = h(3) * SEG;
          const ff = this.frame(a * SEG + along);
          const x = ff.x + ff.rx * o, z = ff.z + ff.rz * o, y = heightAt(r, o);
          // a patch scattered along and across the road, never closer than 0.8 m to the asphalt
          const spot = (q, spread) => {
            const oo = side * Math.max(ROAD_HALF + 0.8, Math.abs(o) + (hash(a * 3 + q * 1.7 + j) - 0.5) * spread);
            const fq = this.frame(a * SEG + along + (hash(a + q * 2.3 + j) - 0.5) * spread);
            return [fq.x + fq.rx * oo, heightAt(r, oo), fq.z + fq.rz * oo];
          };
          if (sc.type === 'flowers') {
            if (this.nature) {
              for (let q = 0; q < 7; q++) put('flower', mtx(...spot(q, 3.2), hash(a * 5 + q) * 6.28, 0.8 + hash(a * 7 + q) * 0.6));
              for (let q = 7; q < 10; q++) put('clover', mtx(...spot(q, 2.6), hash(a + q * 9) * 6.28, 0.8 + hash(a + q) * 0.5));
            } else {
              for (let q = 0; q < 14; q++) flowers.push([...spot(q, 3.2), flowerPalette[(q + j) % flowerPalette.length]]);
            }
            put('tuft', mtx(x, y, z, h(2) * 6, 0.8 + h(2)));
            put('tuft', mtx(...spot(20, 1.6), h(4) * 6, 0.7 + h(4)));
            if (flowerPalette.includes('#9b7fd1')) for (let q = 0; q < 3; q++) put('lupine', mtx(...spot(30 + q, 2), 0, 0.8 + hash(a + q * 3) * 0.6));
          } else if (sc.type === 'sunflowers') {
            for (let q = 0; q < 5; q++) put('sunflowers', mtx(...spot(40 + q, 3), Math.PI + h(2) * 0.5, 0.9 + hash(q + a) * 0.25));
          } else {
            put(sc.type, mtx(x, y, z, h(2) * 6.28, 0.75 + h(4) * 0.6));
          }
        });
        if (T.fence && hash(Math.floor(idxN / 50) * 3.1 + side * 11.7) < T.fence.prob) fenceSides.push([r, side]);
      }
      // far forest
      if (treeTypes.length) {
        for (let q = 0; q < 3; q++) {
          const hq = (k) => hash(idxN * 3.31 + q * 51.7 + k * 7.9);
          if (hq(0) > T3c.far) continue;
          const side = hq(1) < 0.5 ? -1 : 1, o = side * (30 + hq(2) * 230);
          const y = heightAt(r, o);
          if (this.water && y < f.y - (T3c.dip?.depth || 0) * 0.3) continue;
          const tt = treeTypes[Math.floor(hq(3) * treeTypes.length)].type;
          put(`${tt}@far`, mtx(f.x + f.rx * o, y, f.z + f.rz * o, hq(4) * 6.28, 0.9 + hq(4) * 0.7));
        }
      }
    }
    for (const [key, list] of Object.entries(place)) {
      const [type, far] = key.split('@');
      if (!list.length) continue;
      const castShadow = !far && !['tuft', 'sunflowers', 'lupine'].includes(type);
      if (this.nature?.types[type]) { this._addNature(group, type, list, castShadow); continue; }
      const geom = this.models[type];
      if (!geom) continue;
      const im = new THREE.InstancedMesh(geom, this.mat, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = castShadow;
      im.receiveShadow = true;
      group.add(im);
    }
    if (flowers.length) {
      const im = new THREE.InstancedMesh(this.models.flower, this.mat, flowers.length);
      flowers.forEach(([x, y, z, c], i) => { im.setMatrixAt(i, mtx(x, y, z, 0, 1)); im.setColorAt(i, col(c)); });
      group.add(im);
    }
    if (fenceSides.length) {
      const wood = rgb(T.fence.wood);
      const posts = new THREE.InstancedMesh(this.models.post, this.mat, fenceSides.length);
      const rails = new THREE.InstancedMesh(this.models.rail, this.mat, fenceSides.length * 2);
      const off = ROAD_HALF * 1.18;
      fenceSides.forEach(([r, side], i) => {
        const f1 = frames[r], f2 = frames[r + 1];
        const p1 = new THREE.Vector3(f1.x + f1.rx * off * side, f1.y, f1.z + f1.rz * off * side);
        const p2 = new THREE.Vector3(f2.x + f2.rx * off * side, f2.y, f2.z + f2.rz * off * side);
        posts.setMatrixAt(i, mtx(p1.x, p1.y, p1.z, -f1.h, 1));
        posts.setColorAt(i, wood.clone().multiplyScalar(0.75));
        const d = new THREE.Vector3().subVectors(p2, p1);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.clone().normalize());
        for (const [k, hgt] of [[0, 0.45], [1, 0.9]]) {
          const mid = p1.clone().addScaledVector(d, 0.5);
          mid.y += hgt;
          rails.setMatrixAt(i * 2 + k, new THREE.Matrix4().compose(mid, q, new THREE.Vector3(d.length(), 1, 1)));
          rails.setColorAt(i * 2 + k, wood);
        }
      });
      posts.castShadow = rails.castShadow = true;
      group.add(posts, rails);
    }
    this.scene.add(group);
    return group;
  }

  /** Quaternius models: one InstancedMesh per variant part, leaves tinted from the route palette. */
  _addNature(group, type, list, castShadow) {
    const variants = this.nature.types[type];
    const tint = natureTint(this.t, type);
    const byVariant = variants.map(() => []);
    const p = new THREE.Vector3();
    for (const m of list) {
      p.setFromMatrixPosition(m);
      byVariant[Math.floor(hash2(p.x * 0.37, p.z * 0.53) * variants.length) % variants.length].push(m);
    }
    variants.forEach((parts, v) => {
      const mats = byVariant[v];
      if (!mats.length) return;
      for (const part of parts) {
        const material = this.natureMats[part.material];
        if (!material) continue;
        const im = new THREE.InstancedMesh(part.geometry, material, mats.length);
        const leaf = /^Leaves/.test(part.material);
        const c = new THREE.Color();
        mats.forEach((m, i) => {
          im.setMatrixAt(i, m);
          p.setFromMatrixPosition(m);
          const k = hash2(p.z * 0.71, p.x * 0.29); // per-plant variation: lighter/darker, warmer/cooler
          if (leaf) c.copy(tint).offsetHSL((k - 0.5) * 0.05, (k - 0.5) * 0.12, (k - 0.5) * 0.12);
          else c.setScalar(0.88 + k * 0.24);
          im.setColorAt(i, c);
        });
        im.castShadow = castShadow && part.material !== 'Grass';
        im.receiveShadow = true;
        group.add(im);
      }
    });
  }

  _dispose(group) {
    this.scene.remove(group);
    const shared = new Set(Object.values(this.models || {}));
    group.traverse((o) => {
      if (o.geometry && !shared.has(o.geometry) && !this.natureKeep?.has(o.geometry)) o.geometry.dispose();
      if (o.isInstancedMesh) o.dispose();
    });
  }

  _updateChunks(dist) {
    const c = Math.floor(dist / SEG / CHUNK);
    for (const [k, g] of this.chunks) if (k < c - BEHIND || k > c + AHEAD) { this._dispose(g); this.chunks.delete(k); }
    // build the nearest missing chunk first, at most two per frame
    let built = 0;
    for (let k = c - BEHIND; k <= c + AHEAD && built < 2; k++) {
      if (!this.chunks.has(k)) { this.chunks.set(k, this._buildChunk(k)); built++; }
    }
  }

  // ----- per frame -----

  render(route, dist, riders, dtDist) {
    if (route.id !== this.routeId) this._setup(route);
    this._updateChunks(dist);
    const now = performance.now();
    const dt = this.lastFrameTime === undefined ? 0 : Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.clock += dt;

    // riders
    const seen = new Set();
    let me = null;
    riders.forEach((r, i) => {
      const key = r.self ? `me:${r.color}:${r.stripe}` : r.name || i; // new colours -> new rider
      seen.add(key);
      let R = this.riders.get(key);
      if (!R) {
        const BIKE_COLORS = ['#2a2f3a', '#e8e8e8', '#1f5fd0', '#f0c020', '#2f8f4e'];
        const bikeColor = r.self ? '#c9302c' : BIKE_COLORS[(String(r.name || i).length + i) % BIKE_COLORS.length];
        R = new Rider3D(r.color, r.stripe || '#ff8a1f', r.self ? null : r.name, SHOW_RIDER && !this.riderModel, !this.bikeModel, bikeColor);
        this.riders.set(key, R);
        this.scene.add(R.group);
        if (this.riderModel) {
          const Model = this.riderModel.dummy ? DummyRider : ModelRider;
          R.model = new Model(this.riderModel, R.group, { jersey: r.color, stripe: r.stripe });
        }
        if (this.bikeModel) R.bike = new ModelBike(this.bikeModel, R.group, { color: r.color });
        if (R.model && R.bike) { R.model.bikeFit = R.bike.fit; R.model.bike = R.bike; } // saddle, hoods and pedals of this bike
      }
      const d = r.dist;
      const visible = Math.abs(d - dist) < CHUNK * SEG * AHEAD;
      R.group.visible = visible;
      if (!visible) return;
      const f = this.frame(d);
      const lane = r.lane ?? 0;
      const slope = Math.atan((this._roadY(d + 2) - this._roadY(d - 2)) / 4);
      R.group.position.set(f.x + f.rx * lane, f.y + 0.05, f.z + f.rz * lane);
      R.group.rotation.set(0, -f.h, slope, 'YXZ');
      R.pose(r.pedal || 0);
      R.roll?.(d);
      R.bike?.pose(r.pedal || 0);
      R.bike?.roll(d);
      if (R.model) {
        const now = performance.now(), dt = R.lastT ? (now - R.lastT) / 1000 : 0;
        const cadence = dt > 0 ? (((r.pedal || 0) - (R.lastPedal || 0)) / dt) * 60 / (Math.PI * 2) : 0;
        R.lastT = now; R.lastPedal = r.pedal || 0;
        R.model.pose(r.pedal || 0, dt, cadence);
      }
      if (r.self) me = { f, lane };
    });
    for (const [k, R] of this.riders) if (!seen.has(k)) { this.scene.remove(R.group); this.riders.delete(k); }

    // chase camera
    if (me && (this.camMode === 'iso' || this.camMode === 'side')) {
      // isometric-style view: high, from behind and to the side, narrow field of view (model-like look)
      const target = this.frame(dist + (this.camMode === 'side' ? 4 : 3));
      const h = this._isoHeading = this._isoHeading === undefined ? target.h : this._isoHeading + (target.h - this._isoHeading) * 0.04;
      const fx = Math.cos(h), fz = Math.sin(h), rx = -Math.sin(h), rz = Math.cos(h);
      // iso: behind-and-side; side: almost square to the road, rider crosses the screen left to right
      const side = this.camMode === 'side';
      const yaw = THREE.MathUtils.degToRad(side ? 78 : 35), pitch = THREE.MathUtils.degToRad(side ? 30 : 40), D = side ? 22 : 27;
      const flat = Math.cos(pitch) * D;
      const tx = target.x + target.rx * me.lane, tz = target.z + target.rz * me.lane, ty = target.y + 0.8;
      this.camera.position.set(tx - fx * flat * Math.cos(yaw) + rx * flat * Math.sin(yaw), ty + Math.sin(pitch) * D, tz - fz * flat * Math.cos(yaw) + rz * flat * Math.sin(yaw));
      this.camera.lookAt(tx, ty, tz);
    } else if (me) {
      const back = this.frame(dist - 4.3);
      const target = new THREE.Vector3(back.x + back.rx * me.lane * 0.8, back.y + 2.25, back.z + back.rz * me.lane * 0.8);
      const ahead = this.frame(dist + 9);
      const look = new THREE.Vector3(ahead.x + ahead.rx * me.lane * 0.5, ahead.y + 0.75, ahead.z + ahead.rz * me.lane * 0.5);
      const O = this.orbit;
      if (O.yaw || O.pitch || O.zoom !== 1) {
        // orbit around the rider: the default chase offset turned by yaw/pitch and scaled by zoom
        const pivot = new THREE.Vector3(me.f.x + me.f.rx * me.lane, me.f.y + 1.05, me.f.z + me.f.rz * me.lane);
        const off = target.clone().sub(pivot);
        const r = off.length() * O.zoom;
        const az = Math.atan2(off.x, off.z) + O.yaw;
        const el = Math.max(-0.05, Math.min(1.45, Math.asin(off.y / off.length()) + O.pitch));
        target.copy(pivot).add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(r));
        target.y = Math.max(target.y, this._roadY(dist) + 0.25);
        // turn the view from down the road toward the rider as the orbit grows (no jump on the first drag)
        const s = Math.min(1, Math.max(Math.abs(O.yaw) / 0.5, Math.abs(O.pitch) / 0.3, Math.abs(1 - O.zoom) / 0.4));
        look.lerp(pivot, s);
      }
      // follow the rider rigidly along the road (lane changes are already eased by the app)
      this.camPos = target;
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(look);
    }
    if (me) {

      const cx = this.camera.position.x, cz = this.camera.position.z, cy = me.f.y;
      this.sky.position.set(cx, cy, cz);
      for (const ring of this.rings) ring.position.set(cx, cy - 40, cz);
      this.cloudGroup.position.set(cx, cy, cz);
      this.cloudGroup.rotation.y += dt * 0.0012;
      // Key light follows the heading: low, ahead and to the left, so the rider is lit from the side
      // and their shadow falls back towards the camera, like the late-afternoon look of pixel games.
      const ahead = this.frame(dist + 6);
      const hx = ahead.x - me.f.x, hz = ahead.z - me.f.z, hl = Math.hypot(hx, hz) || 1;
      const fx = hx / hl, fz = hz / hl; // forward on the ground plane; left is (fz, -fx)
      this.sunDirection.set(fx * 0.55 + fz * 0.62, 0.48, fz * 0.55 - fx * 0.62).normalize();
      this.sun.position.copy(this.sunDirection).multiplyScalar(140).add(new THREE.Vector3(me.f.x, me.f.y, me.f.z));
      this.sun.target.position.set(me.f.x, me.f.y, me.f.z);
      if (this.sunDisk) {
        this.sunDisk.position.copy(this.sunDirection).multiplyScalar(3000).add(new THREE.Vector3(cx, cy, cz));
        this.sunGlow.position.copy(this.sunDisk.position);
        this.sunDisk.lookAt(this.camera.position);
      }
      if (this.water) {
        this.water.position.set(cx, me.f.y - 6, cz);
        // Compensate for the moving water plane so the pattern stays in world
        // space, then add a gentle time-based drift independent of frame rate.
        this.water.material.bumpMap.offset.set(cx / 5000 * 700 + this.clock * 0.012,
          -cz / 5000 * 700 + this.clock * 0.006);
      }
      if (this.snow) {
        this.snow.position.set(cx, cy - 5, cz);
        const p = this.snow.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) {
          let y = p.getY(i) - 0.05 - (dtDist || 0) * 0.02;
          if (y < 0) y += 40;
          p.setY(i, y);
        }
        p.needsUpdate = true;
      }
    }
    if (this.pixel) {
      this.renderer.setRenderTarget(this.pixel.target);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.pixel.scene, this.pixel.cam);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}
