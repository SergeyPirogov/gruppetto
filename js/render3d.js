// Real 3D renderer (three.js, WebGL) in a low-poly illustrated style.
// The world streams in 200 m chunks along the route: terrain with hills and valleys,
// road, scenery, fences, water, distant mountains and 3D riders. Same interface as the 2D Scene.
import * as THREE from '../vendor/three/three.module.min.js';
import { SEG } from './routes.js';
import { themeFor } from './themes.js';
import { sunAt, phaseOf, placeFromZone } from './sun.js';
import { loadRiderModel, ModelRider } from './rider-model.js';
import { loadDummyRider, DummyRider } from './dummy-rider.js';
import { loadNature, natureMaterials } from './nature.js';
import { loadBikeModel, ModelBike } from './bike-model.js';
import { t, lang } from './i18n.js';
import { CSM } from '../vendor/three/addons/csm/CSM.js';
import { villages, crossings, tunnels } from './villages.js';
import { OFFSETS as LAND_OFFSETS, LAND_STEP } from './osm.js';
import { loadFanModels } from './fans.js';

const CHUNK = 40;              // segments per chunk (200 m)
// phones and small touch screens: a lighter world (?quality=low / high to force either)
const Q_PARAM = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('quality');
const LOW = Q_PARAM === 'low' || (Q_PARAM !== 'high' && typeof matchMedia !== 'undefined'
  && matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820);
const AHEAD = LOW ? 4 : 7, BEHIND = 1;   // chunks kept around the rider (200 m each)
const ROAD_HALF = 3.6;         // m
const TURN = 2.5;              // curvature exaggeration relative to the 2D renderer
const V_EXAG = 1.5;            // vertical exaggeration
/** Offset along a SEG-long arc whose heading turns from h0 to h1, at fraction t of it. */
function arc(h0, h1, t) {
  const dh = h1 - h0;
  if (Math.abs(dh) < 1e-6) return [Math.cos(h0) * SEG * t, Math.sin(h0) * SEG * t];
  const k = SEG / dh;
  return [k * (Math.sin(h0 + dh * t) - Math.sin(h0)), -k * (Math.cos(h0 + dh * t) - Math.cos(h0))];
}
const LEAN_SIGN = 1;            // which way rotation.x leans the rider for a positive turn
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
const GULLY = 17, GULLY_DEPTH = 6;
const TUNNEL_R = 4.6, TUNNEL_WALL = 3.2, TUNNEL_HILL = 11; // a tunnel: half its width, its straight walls' height, the hill over it (m) // a stream under a bridge: half its width along the road and its depth (m)
// house walls in a village are not all one white: cream, a cool white, peach, pale green (the roof takes a hint of it)
const HOUSE_TINTS = ['#ffffff', '#fff0d6', '#e6eeff', '#ffe0d0', '#eaf5df', '#fff7c8'].map((c) => new THREE.Color(c));
const CSM_CASCADES = Number(new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('csm')) || (LOW ? 1 : 2); // ?csm=3 to compare
const CSM_FAR = LOW ? 120 : 240;
const LABEL_RANGE = 60; // m: riders farther than this away show no name tag
let preloaded = null;
/** Starts the bike, rider and scenery downloads once, from the lobby, so the ride starts with them ready. */
export function preloadModels() {
  return preloaded ||= {
    bike: loadBikeModel(),
    rider: SHOW_RIDER ? loadDummyRider().then((d) => d || loadRiderModel()) : Promise.resolve(null),
    nature: loadNature().catch((e) => { console.warn('Nature models unavailable, using built-in shapes', e); return null; }),
    // fans: people posed from the rider model (phones keep the simple figures: a crowd of them is heavy)
    fans: LOW ? Promise.resolve(null) : loadFanModels().catch((e) => { console.warn('Fan models unavailable, using simple figures', e); return null; }),
  };
}

const SHOW_RIDER = typeof location === 'undefined' || new URLSearchParams(location.search).get('rider') !== '0'; // ?rider=0: bike only
const SIZE = { oak: 1, birch: 1, pine: 1, rock: 1, bush: 1, cactus: 1, palm: 1, sunflowers: 1, flowers: 1 };

/**
 * Add a vertex-shader tweak to a material, keeping any it already has (and a program per variant).
 */
function patchShader(mat, key, fn) {
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.onBeforeCompile = function (sh, r) { if (prev) prev.call(this, sh, r); fn(sh); };
  mat.customProgramCacheKey = () => `${prevKey}|${key}`;
  mat.needsUpdate = true;
  return mat;
}

/**
 * Wind: plants sway, more the higher the vertex (displacement ∝ height²), each at its own phase from
 * where it stands. `amp` is metres of sway per metre² of height; `time` a shared uniform.
 */
const WIND_AMP = { value: 1 }; // how hard the wind blows: scales every sway (setWind)
function windify(mat, amp, time) {
  return patchShader(mat, `wind${amp}`, (sh) => {
    sh.uniforms.uWindTime = time;
    sh.uniforms.uWindAmp = WIND_AMP;
    sh.vertexShader = `uniform float uWindTime;\nuniform float uWindAmp;\n${sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 wRoot = instanceMatrix[3].xyz;
      #else
        vec3 wRoot = vec3(0.0);
      #endif
      float wH = max(transformed.y, 0.0);
      float wS = sin(uWindTime * 1.3 + wRoot.x * 0.21 + wRoot.z * 0.17) * 0.7
        + sin(uWindTime * 2.9 + wRoot.x * 0.53 - wRoot.z * 0.41) * 0.3
        + 0.35; // leaning a little with the wind, swaying around that
      transformed.xz += vec2(0.8, 0.6) * wS * uWindAmp * ${amp.toFixed(4)} * wH * wH;`)}`;
  });
}

/** A soft elongated shadow (shared): dark patches under both wheels inside a faint oval. */
let _contactTex = null;
function contactShadowTexture() {
  if (_contactTex) return _contactTex;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 76;
  const g = c.getContext('2d');
  // the oval fades out exactly at the texture's edges (a squashed circle of radius 124)
  const oval = g.createRadialGradient(0, 0, 4, 0, 0, 124);
  oval.addColorStop(0, 'rgba(0,0,0,0.38)'); oval.addColorStop(0.55, 'rgba(0,0,0,0.18)'); oval.addColorStop(1, 'rgba(0,0,0,0)');
  g.save(); g.translate(128, 38); g.scale(1, 0.3); g.fillStyle = oval; g.fillRect(-128, -130, 256, 260); g.restore();
  for (const x of [128 - 0.53 / 2.1 * 256, 128 + 0.53 / 2.1 * 256]) { // the tyres, 1.06 m apart (wheelbase)
    const w = g.createRadialGradient(x, 38, 1, x, 38, 26);
    w.addColorStop(0, 'rgba(0,0,0,0.85)'); w.addColorStop(0.4, 'rgba(0,0,0,0.45)'); w.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = w; g.fillRect(x - 30, 0, 60, 76);
  }
  _contactTex = new THREE.CanvasTexture(c);
  _contactTex.colorSpace = THREE.SRGBColorSpace;
  return _contactTex;
}

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
  const size = water ? 128 : 256, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size * Math.PI * 2, v = y / size * Math.PI * 2;
    let value;
    if (water) value = 128 + Math.sin(u * 3 + Math.sin(v * 2)) * 42 + Math.sin(v * 5 + u * 2) * 22;
    else {
      // asphalt: fine grain, a light or dark stone of the aggregate here and there, and soft worn blotches
      const stone = hash2(x * 1.7 + 3.1, y * 2.3 + 5.7);
      value = 214 + hash2(x, y) * 30 + (Math.sin(u * 2 + Math.sin(v * 3) * 1.3) + Math.sin(v * 3 + Math.cos(u * 2))) * 5;
      if (stone > 0.975) value = 255; else if (stone < 0.03) value = 160;
      value = Math.max(0, Math.min(255, value));
    }
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
  // a clump of grass blades: dark at the root, light at the tip, normals up so it shades like the ground
  {
    const base = rgb(theme.grass[0]).multiplyScalar(0.55), tip = rgb(theme.grass[1]).lerp(col('#e9e27a'), 0.18).multiplyScalar(1.12);
    const pos = [], colr = [], nor = [];
    for (let b = 0; b < 14; b++) {
      const a = hash(b * 3.7) * Math.PI * 2, rr = Math.sqrt(hash(b * 5.1)) * 0.32, h = 0.28 + hash(b * 7.3) * 0.32, w = 0.04 + hash(b * 1.9) * 0.025;
      const cx = Math.cos(a) * rr, cz = Math.sin(a) * rr, lean = 0.08 + hash(b * 2.3) * 0.12;
      const fa = a + Math.PI / 2, fx = Math.cos(fa), fz = Math.sin(fa); // the blade's flat side
      const at = (t, side) => {
        const ww = w * (1 - t) * side, bend = lean * t * t;
        return [cx + fx * ww + Math.cos(a) * bend, h * t, cz + fz * ww + Math.sin(a) * bend];
      };
      const ts = [0, 0.45, 0.8];
      const tri = (p1, p2, p3, t1, t2, t3) => {
        for (const [p, t] of [[p1, t1], [p2, t2], [p3, t3]]) {
          pos.push(...p); nor.push(0, 1, 0);
          const c = base.clone().lerp(tip, t); colr.push(c.r, c.g, c.b);
        }
      };
      for (let k = 0; k < 2; k++) {
        const a0 = at(ts[k], -1), a1 = at(ts[k], 1), b0 = at(ts[k + 1], -1), b1 = at(ts[k + 1], 1);
        tri(a0, a1, b1, ts[k], ts[k], ts[k + 1]); tri(a0, b1, b0, ts[k], ts[k + 1], ts[k + 1]);
      }
      tri(at(0.8, -1), at(0.8, 1), at(1, 0), 0.8, 0.8, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
    M.grassClump = g;
  }
  // a block of flats for buildings of four floors and more: 8 × 6 m, 3 m a floor (scaled by floors)
  M.block = merge([
    { geom: new THREE.BoxGeometry(8, 3, 6), color: '#d9d2c5', pos: [0, 1.5, 0], flat: true },
    { geom: new THREE.BoxGeometry(8.3, 0.25, 6.3), color: '#8b8f96', pos: [0, 3.05, 0], flat: true },
    ...[-2.6, 0, 2.6].map((x) => ({ geom: new THREE.BoxGeometry(1.3, 1.1, 0.08), color: '#9cc3d8', pos: [x, 1.6, 3.02], flat: true })),
    ...[-2.6, 0, 2.6].map((x) => ({ geom: new THREE.BoxGeometry(1.3, 1.1, 0.08), color: '#9cc3d8', pos: [x, 1.6, -3.02], flat: true })),
  ]);
  // a house for imported routes' buildings: 8 m wide, 6 m deep, walls and a pitched roof
  M.house = merge([
    { geom: new THREE.BoxGeometry(8, 4.6, 6), color: '#ece3d2', pos: [0, 2.3, 0], flat: true },
    { geom: new THREE.CylinderGeometry(4.6, 4.6, 8.6, 3), color: '#b5543a', pos: [0, 4.6, 0], rot: [0, 0, Math.PI / 2], scale: [1, 1, 0.78], flat: true },
    { geom: new THREE.BoxGeometry(1.0, 1.7, 0.08), color: '#6b4a32', pos: [1.6, 0.85, 3.02], flat: true },
    { geom: new THREE.BoxGeometry(1.2, 1.0, 0.08), color: '#9cc3d8', pos: [-1.8, 2.4, 3.02], flat: true },
  ]);
  // a village cottage (made-up routes): low walls under a gable roof with eaves, a chimney, windows all round
  const winX = [-2.4, 2.4], winZ = [-1.4, 1.4];
  M.cottage = merge([
    { geom: new THREE.BoxGeometry(8.2, 0.5, 6.2), color: '#8d8a84', pos: [0, 0.1, 0], flat: true },
    { geom: new THREE.BoxGeometry(8, 3.1, 6), color: '#efe6d6', pos: [0, 1.75, 0], flat: true },
    { geom: gable(9, 7.2, 2.5), color: '#a9472f', pos: [0, 3.3, 0], flat: true },
    { geom: new THREE.BoxGeometry(0.7, 1.6, 0.7), color: '#7c5a48', pos: [2.3, 4.6, -1.1], flat: true },
    { geom: new THREE.BoxGeometry(1.0, 1.9, 0.08), color: '#6b4a32', pos: [0, 0.95 + 0.2, 3.02], flat: true },
    ...winX.flatMap((x) => [3.02, -3.02].map((z) => ({ geom: new THREE.BoxGeometry(1.1, 1.0, 0.08), color: '#9cc3d8', pos: [x, 1.9, z], flat: true }))),
    ...winZ.flatMap((z) => [4.02, -4.02].map((x) => ({ geom: new THREE.BoxGeometry(0.08, 1.0, 1.0), color: '#9cc3d8', pos: [x, 1.9, z], flat: true }))),
  ]);
  return M;
}

/** A gable roof: ridge along x (`len`), eaves `width` apart across z, `h` from eaves to ridge; sits on y = 0. */
function gable(len, width, h) {
  const x = len / 2, z = width / 2;
  const v = [
    [-x, 0, z], [x, 0, z], [x, h, 0], [-x, 0, z], [x, h, 0], [-x, h, 0], // front slope
    [x, 0, -z], [-x, 0, -z], [-x, h, 0], [x, 0, -z], [-x, h, 0], [x, h, 0], // back slope
    [-x, 0, -z], [-x, 0, z], [-x, h, 0], [x, 0, z], [x, 0, -z], [x, h, 0], // gable ends
    [-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, -z], [x, 0, z], [-x, 0, z], // the underside of the eaves
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v.flat(), 3));
  return g;
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
    if (label) this._label(label, jersey, stripe);
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

  /** Name tag over the rider: a dark pill with a dot in the rider's colours and a small pointer down. */
  _label(label, jersey = '#ffffff', stripe = '#ff8a1f') {
    const c = document.createElement('canvas');
    const W = 512, H = 136, g = c.getContext('2d');
    c.width = W; c.height = H;
    g.font = '700 46px system-ui, -apple-system, "Segoe UI", sans-serif';
    const tw = Math.min(W - 120, g.measureText(label).width);
    const pw = tw + 104, ph = 76, x0 = (W - pw) / 2, y0 = 6, r = ph / 2;
    // pill with a soft shadow
    g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 10; g.shadowOffsetY = 3;
    g.fillStyle = 'rgba(15, 20, 32, 0.86)';
    g.beginPath(); g.roundRect(x0, y0, pw, ph, r); g.fill();
    g.shadowColor = 'transparent';
    // pointer under the pill, toward the rider
    g.beginPath(); g.moveTo(W / 2 - 14, y0 + ph - 1); g.lineTo(W / 2 + 14, y0 + ph - 1); g.lineTo(W / 2, y0 + ph + 18); g.closePath(); g.fill();
    // rim in the accent colour
    g.lineWidth = 3; g.strokeStyle = stripe; g.globalAlpha = 0.85;
    g.beginPath(); g.roundRect(x0 + 1.5, y0 + 1.5, pw - 3, ph - 3, r - 1.5); g.stroke();
    g.globalAlpha = 1;
    // jersey dot with the accent ring
    const cx = x0 + 40, cy = y0 + ph / 2;
    g.fillStyle = jersey; g.beginPath(); g.arc(cx, cy, 15, 0, Math.PI * 2); g.fill();
    g.lineWidth = 4; g.strokeStyle = stripe; g.stroke();
    // name
    g.fillStyle = '#ffffff'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(label, x0 + 70, cy + 2, tw);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    // the same size on screen near or far (readable for riders up the road), centred over the head
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, depthTest: false, transparent: true, sizeAttenuation: false }));
    sprite.center.set(0.5, 0);
    sprite.scale.set(0.15, 0.15 * H / W, 1);
    sprite.position.set(0.45, 1.72, 0); // over the head, which leans forward over the bars
    sprite.renderOrder = 10; // over the scenery, never hidden behind a fence or a rider
    this.group.add(sprite);
    this.labelSprite = sprite;
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

// ---------- Time of day and weather (#41) ----------
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const mixHex = (a, b, t) => '#' + mixRgb(hexRgb(a), hexRgb(b), t).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const TIMES = {
  // midday is each route's own look; the others recolour the sky, the fog and the sun
  morning: { sky: ['#78a9de', '#ffd8b0'], fog: '#f0dcc6', fogMix: 0.55, sunY: 0.3, light: '#ffd09a', lightI: 2.4, hemi: 0.75, exposure: 1.02, glow: '#ffc890', disk: '#fff0d0', diskSize: 90, dim: 0.95 },
  // golden hour: a low sun of warm gold (not red), the sky's cool fill in the shadows, a peach horizon
  evening: { sky: ['#5a7cb6', '#ffcf9e'], fog: '#f1cfae', fogMix: 0.5, sunY: 0.18, light: '#ffd29a', lightI: 2.5, hemi: 0.62, hemiColor: '#b9c8ec', exposure: 1.03, glow: '#ffbe7a', disk: '#ffe2a6', diskSize: 120, dim: 0.85 },
  night: { sky: ['#03050c', '#131c35'], fog: '#0e1526', fogMix: 0.92, sunY: 0.55, light: '#9fb6ff', lightI: 0.7, hemi: 0.2, exposure: 1.25, glow: '#6f86c8', disk: '#e8eefc', diskSize: 34, dim: 0.22, night: true, fogNear: 60, fogFar: 700 },
};
/** The hour's look: 'auto' picks it from the sun where you are (sun.js), not from fixed hours. */
export function timeOfDay(time, date = new Date(), place = placeFromZone()) {
  if (time !== 'auto') return TIMES[time] || time === 'midday' ? time : 'midday';
  return phaseOf(sunAt(date, place));
}
/** A route's theme under the chosen time of day and weather: sky, fog, sun and how dim the distance is. */
export function atmosphereFor(base, time = 'midday', weather = 'clear') {
  const T = TIMES[timeOfDay(time)];
  const t = { ...base, sky: [...base.sky], fog: [...base.fog] };
  const a = { t, sunY: 0.48, light: base.sun ? '#ffc48f' : '#fff2dc', lightI: base.sun ? 2.3 : 3.0, hemi: 0.8, exposure: 1.05,
    glow: null, disk: null, diskSize: null, dim: 1, night: false, rain: false, fogNear: LOW ? 120 : 150, fogFar: LOW ? 850 : 1500, showSun: true };
  if (T) {
    t.sky = [...T.sky];
    t.fog = mixRgb(base.fog, hexRgb(T.fog), T.fogMix);
    Object.assign(a, { sunY: T.sunY, light: T.light, lightI: T.lightI, hemi: T.hemi, hemiColor: T.hemiColor || null, exposure: T.exposure, glow: T.glow, disk: T.disk, diskSize: T.diskSize, dim: T.dim, night: !!T.night });
    if (T.fogNear) { a.fogNear = T.fogNear; a.fogFar = Math.min(a.fogFar, T.fogFar); }
  }
  if (weather === 'fog' || weather === 'rain') {
    const grey = a.night ? '#1a2232' : weather === 'fog' ? '#bcc4cd' : '#8e99a6';
    t.sky = t.sky.map((c) => mixHex(c, grey, weather === 'fog' ? 0.8 : 0.82));
    t.fog = mixRgb(t.fog, hexRgb(grey), 0.7);
    t.clouds = (base.clouds || 3) + (weather === 'rain' ? 8 : 4);
    a.lightI *= weather === 'fog' ? 0.5 : 0.4;
    a.exposure *= weather === 'rain' ? 0.88 : 1;
    a.hemi *= 1.15;
    a.showSun = false;
    a.fogNear = weather === 'fog' ? 12 : 40;
    a.fogFar = weather === 'fog' ? 220 : 520;
    a.rain = weather === 'rain' && !base.snowfall;
    a.dim *= weather === 'rain' ? 0.8 : 0.9;
  }
  return a;
}

// ---------- Scene ----------

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this._orbitControls(canvas);
    if (typeof window !== 'undefined' && new URLSearchParams(location.search).has('debug')) window.__scene3d = this; // for inspecting in devtools
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !LOW, powerPreference: 'high-performance' });
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
    this.windTime = { value: 0 }; // shared by every swaying material
    this.riderModel = null;
    this.nature = null;
    this.bikeModel = null;
    // A loading screen covers the ride until the bike, rider and scenery models have loaded (or failed)
    // and the visible stretch of road is fully built, then fades out: no empty road, no rider or trees
    // popping in, no built-in shapes swapped for the models a moment later.
    this.modelsReady = false;
    this.loader = this._makeLoader(canvas.parentElement);
    const models = preloadModels();
    const bikeLoad = models.bike.then((m) => {
      if (!m) return;
      this.bikeModel = m;
      for (const R of this.riders.values()) this.scene.remove(R.group);
      this.riders.clear(); // rebuilt with the bike model on the next frame
    });
    const natureLoad = models.nature.then((n) => {
      if (!n) return;
      this.nature = n;
      this.natureKeep = new Set([...Object.values(n.textures), ...Object.values(n.types).flat(2).map((p) => p.geometry)]);
      this.routeId = null; // rebuild the world with the models on the next frame
    }).catch((e) => console.warn('Nature models unavailable, using built-in shapes', e));
    const riderLoad = models.rider.then((m) => {
      if (!m) return;
      this.riderModel = m;
      for (const R of this.riders.values()) this.scene.remove(R.group);
      this.riders.clear(); // rebuilt with the custom character on the next frame
    });
    const fanLoad = models.fans.then((m) => { if (m) this.fanModels = m; });
    const ready = () => { this.modelsReady = true; };
    Promise.allSettled([bikeLoad, riderLoad, natureLoad, fanLoad]).then(ready);
    setTimeout(ready, 30000); // a stalled download must not hide the riders for good
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Camera you can turn a little: drag (mouse or one finger) to orbit around your rider, wheel or
   * pinch to zoom, double-click or double-tap to go back to the chase view.
   */
  _orbitControls(canvas) {
    // default view: straight behind, at the chase position
    const HOME = { yaw: 0, pitch: 0, zoom: 1.0 };
    this.orbit = { ...HOME };
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
        if (performance.now() - lastTap < 300) Object.assign(O, HOME);
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
    canvas.addEventListener('dblclick', () => Object.assign(O, HOME));
  }

  /** A new ride: the world is rebuilt behind the loading screen on the next frame. */
  restart() {
    this.routeId = null;
    this.warmStart = 0;
  }

  /** Full-screen loading overlay over the ride view (above the HUD). */
  _makeLoader(parent) {
    const el = document.createElement('div');
    el.className = 'ride-loader';
    el.innerHTML = `<div class="ride-loader-wheel"></div><div class="ride-loader-text">${t('Preparing the route…')}</div>`;
    parent?.appendChild(el);
    return el;
  }

  /** Covers the scene (a new route is being built). */
  _showLoader() {
    this.warming = true;
    this.warmFrames = 0;
    if (!this.loader) return;
    clearTimeout(this._loaderHide);
    this.loader.style.display = '';
    this.loader.classList.remove('done');
  }

  /** Called every frame while warming: reveals the scene once it is complete. */
  _checkWarm(dist, me) {
    const c = Math.floor(dist / SEG / CHUNK);
    let built = true;
    for (let k = c - BEHIND; k <= c + AHEAD; k++) if (!this.chunks.has(k)) built = false;
    const timedOut = performance.now() - this.warmStart > 15000; // never hold the ride back for good
    if (!timedOut && (!built || !this.modelsReady || !me)) { this.warmFrames = 0; return; }
    // let a couple of complete frames render (shaders compiled, textures uploaded) before revealing
    if (this.warmFrames++ === 0) { try { this.renderer.compile(this.scene, this.camera); } catch { /* optional */ } }
    if (this.warmFrames < 3 && !timedOut) return;
    this.warming = false;
    if (!this.loader) return;
    this.loader.classList.add('done');
    this._loaderHide = setTimeout(() => { this.loader.style.display = 'none'; }, 600);
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.renderer.setPixelRatio(this._pixelRatio());
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.csm?.updateFrustums();
    if (this.pixel) this._setupPixel();
    if (this.post) this._setupPost();
  }

  /** Device pixels per CSS pixel: the screen's, up to 2, times the adaptive quality scale. */
  _pixelRatio() {
    return Math.max(LOW ? 0.6 : 0.6, Math.min(window.devicePixelRatio || 1, LOW ? 1.25 : 2) * (this.quality ?? 1) * (this.qualityCap ?? 1));
  }

  /**
   * Adaptive quality: when frames keep taking over ~20 ms, render fewer pixels (down to 60 %), and
   * back up when there is room again; checked every 2 s so it never flickers.
   */
  _adaptQuality(dt) {
    if (!dt || this.warming) return;
    this.qAcc = (this.qAcc || 0) + dt; this.qN = (this.qN || 0) + 1;
    if (this.qAcc < 2) return;
    const avg = this.qAcc / this.qN; this.qAcc = 0; this.qN = 0;
    const q = this.quality ?? 1;
    const next = avg > 0.021 ? Math.max(LOW ? 0.5 : 0.6, q - 0.1) : avg < 0.0135 ? Math.min(1, q + 0.1) : q;
    if (Math.abs(next - q) > 1e-3) { this.quality = next; this.resize(); }
  }

  /**
   * 'chase' (behind the rider, default), 'eyes' (the rider's own view), 'iso' (high, behind and to the side),
   * 'side' (over the shoulder: behind and to the left) or 'front' (ahead of the rider, looking back, like a TV motorbike).
   */
  setCamera(mode) {
    this.camMode = ['eyes', 'iso', 'side', 'front'].includes(mode) ? mode : 'chase';
    this.camera.fov = { chase: 62, eyes: 72, iso: 30, side: 58, front: 48 }[this.camMode];
    this.camera.updateProjectionMatrix();
    this.csm?.updateFrustums();
    this._isoHeading = undefined;
  }

  /** The wind, m/s: grass, plants and trees sway harder and faster with it. */
  setWind(speed = 0) {
    this.windSpeed = speed;
    WIND_AMP.value = 0.6 + speed * 0.17;
  }

  /**
   * Graphics quality: 'low' (fewer pixels, shorter view, no finish), 'medium' (as before) or 'high' (a soft glow
   * round the sun and bright surfaces, a gentle colour grade and vignette). 'auto' picks by the device.
   */
  setQuality(q = 'auto') {
    const want = q === 'auto' ? (LOW ? 'low' : 'medium') : q;
    this.qualityLevel = want;
    const post = want === 'high';
    if (post && !this.post) this._setupPost();
    if (!post && this.post) { for (const t of this.post.targets) t.dispose(); this.post.quad.material.dispose(); this.post = null; }
    this.qualityCap = want === 'low' ? 0.75 : 1;
    this.resize();
  }

  /** The finish for 'high': the scene in a buffer, its bright parts blurred twice, then glow, grade and vignette over it. */
  _setupPost() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const opts = { type: THREE.HalfFloatType };
    const P = this.post = this.post || {};
    P.targets?.forEach((t) => t.dispose());
    const w = Math.max(1, size.x), h = Math.max(1, size.y), q = 4; // the glow at a quarter size: soft and cheap
    P.scene0 = new THREE.WebGLRenderTarget(w, h, { ...opts, samples: 4 });
    P.blurA = new THREE.WebGLRenderTarget(Math.ceil(w / q), Math.ceil(h / q), opts);
    P.blurB = new THREE.WebGLRenderTarget(Math.ceil(w / q), Math.ceil(h / q), opts);
    P.targets = [P.scene0, P.blurA, P.blurB];
    if (P.quad) return;
    P.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    P.scene = new THREE.Scene();
    const vert = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    // bright parts, blurred along one direction (run twice, across and down)
    P.blur = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, dir: { value: new THREE.Vector2() }, pick: { value: 0 } },
      vertexShader: vert, depthTest: false, depthWrite: false,
      fragmentShader: `uniform sampler2D tSrc; uniform vec2 dir; uniform float pick; varying vec2 vUv;
        vec3 at(vec2 uv) { vec3 c = texture2D(tSrc, uv).rgb; if (pick > 0.5) { float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c *= smoothstep(0.85, 1.9, l); } return c; } // the scene is linear HDR here: the bright is over 1
        void main() {
          vec3 s = at(vUv) * 0.227;
          s += (at(vUv + dir * 1.385) + at(vUv - dir * 1.385)) * 0.316;
          s += (at(vUv + dir * 3.231) + at(vUv - dir * 3.231)) * 0.070;
          gl_FragColor = vec4(s, 1.0);
        }`,
    });
    // the final picture: the scene, its glow, a gentle colour grade (a touch more contrast and warmth) and a vignette
    P.final = new THREE.ShaderMaterial({
      uniforms: { tScene: { value: null }, tGlow: { value: null }, glow: { value: 0.55 } },
      vertexShader: vert, depthTest: false, depthWrite: false, toneMapped: true,
      // a render target holds the scene linear and not tone-mapped (three.js maps only on the way to the screen):
      // glow is added there, then the renderer's own tone mapping and sRGB, then the grade
      fragmentShader: `uniform sampler2D tScene; uniform sampler2D tGlow; uniform float glow; varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(texture2D(tScene, vUv).rgb + texture2D(tGlow, vUv).rgb * glow, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          vec3 c = gl_FragColor.rgb;
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          c = mix(vec3(l), c, 1.08);                                  // a little more colour
          c = (c - 0.5) * 1.05 + 0.5;                                 // a little more contrast
          c *= vec3(1.015, 1.0, 0.985);                               // a touch warmer
          vec2 d = vUv - 0.5; c *= 1.0 - dot(d, d) * 0.55;            // a soft vignette
          gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
        }`,
    });
    P.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), P.blur);
    P.quad.frustumCulled = false;
    P.scene.add(P.quad);
  }

  _renderPost() {
    const P = this.post, r = this.renderer;
    r.setRenderTarget(P.scene0); r.render(this.scene, this.camera);
    const pass = (mat, target) => { P.quad.material = mat; r.setRenderTarget(target); r.render(P.scene, P.cam); };
    const px = (t) => new THREE.Vector2(1 / t.width, 1 / t.height);
    P.blur.uniforms.tSrc.value = P.scene0.texture; P.blur.uniforms.pick.value = 1; P.blur.uniforms.dir.value.copy(px(P.blurA)).multiply(new THREE.Vector2(1, 0)); pass(P.blur, P.blurA);
    P.blur.uniforms.tSrc.value = P.blurA.texture; P.blur.uniforms.pick.value = 0; P.blur.uniforms.dir.value.copy(px(P.blurB)).multiply(new THREE.Vector2(0, 1)); pass(P.blur, P.blurB);
    P.final.uniforms.tScene.value = P.scene0.texture; P.final.uniforms.tGlow.value = P.blurB.texture;
    pass(P.final, null);
  }

  /**
   * The feeling of speed: the view widens as you go faster (up to +9° at 55 km/h, like a camera that can't keep up).
   * No tremble: on a screen it read as the picture jumping. The isometric view is left as it is.
   */
  _speedFeel(dt, dist) {
    if (!dt || this.camMode === 'iso') return;
    // the speed from the distance and the real time between frames (the frame's dt is capped, the distance is not)
    const now = performance.now(), last = this._feelAt;
    this._feelAt = { t: now, d: dist };
    if (!last || now <= last.t) return;
    const v = Math.max(0, Math.min(30, (dist - last.d) / ((now - last.t) / 1000))); // m/s
    this.vSmooth = (this.vSmooth ?? v) + (v - (this.vSmooth ?? v)) * Math.min(1, dt * 1.5);
    const k = Math.min(1, Math.max(0, (this.vSmooth - 4) / 11)); // from 15 to 55 km/h
    const base = { chase: 62, eyes: 72, side: 58, front: 48 }[this.camMode] ?? 62;
    const fov = base + k * k * 9;
    if (Math.abs(this.camera.fov - fov) > 0.02) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
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
    const VIRTUAL_W = 1600; // width of the pixel grid (height follows the aspect ratio); fewer = chunkier
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
            if (z < 900.0 && e > 0.06 * z + 0.4) c *= vec3(0.62, 0.58, 0.66);   // soft, cool-dark outline
            // painterly golden-hour grade (like hand-made pixel art): muted, earthy colours, warm light,
            // lilac shadows, and a fine speckle that gives large flat areas (road, grass) a texture
            float l = dot(c, vec3(0.299, 0.587, 0.114));
            c = mix(vec3(l), c, 0.82);                                   // less saturated
            c = mix(c, c * vec3(0.92, 0.88, 1.08), (1.0 - l) * 0.45);    // lilac shadows
            c = mix(c, c * vec3(1.12, 1.0, 0.8), l * 0.45);              // golden light
            c *= 1.0 + (fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.02; // speckle
            // painterly bands: quantise brightness, keep the hue; dither only near band edges
            l = dot(c, vec3(0.299, 0.587, 0.114));
            vec3 chroma = c - l;
            float bands = 28.0, t = l * bands, f = fract(t);
            float edge = clamp((f - 0.5) / 0.35 + 0.5, 0.0, 1.0);   // solid inside a band, ramp near its edge
            float lq = (floor(t) + step(bayer4(cell) + 0.5, edge)) / bands;
            chroma = floor(chroma * 64.0 + 0.5) / 64.0;
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
    if (!this.warmStart || !this.warming) this.warmStart = performance.now();
    this._showLoader();
    this.tBase = themeFor(route.theme);
    this.t = atmosphereFor(this.tBase, this.atmTime, this.atmWeather).t;
    this.t3 = T3[route.theme] || T3.meadow;
    // a real road bends and doubles back: gentle side hills, and the land never reaches over another stretch
    if (route.custom) this.t3 = { ...this.t3, amp: 6, far: 0.2, wall: 0, rock: 0, snow: 0, dip: null, beach: false };
    // a route may bring its own water: a lake or a river beside the road (Alpine Valley's lake under the slopes)
    else if (route.water) this.t3 = { ...this.t3, dip: route.water };
    this.reach = null;
    this.archList = null; this.bannerCache = null; this.lineTexCache = null; // arches are per route
    // imported routes with OpenStreetMap data: woods, water and buildings where they really are
    this.land = route.land || null;
    this.buildings = route.buildings || [];
    // the made-up routes get villages every few kilometres; trees keep out of them
    this.villageSpans = [];
    if (!this.buildings.length) ({ buildings: this.buildings, spans: this.villageSpans } = villages(route, this.t3.dip));
    this.crossings = crossings(route, this.villageSpans); // streams the road bridges
    this.tunnels = tunnels(route, this.villageSpans, this.crossings); // and mountains it goes through
    this.streamMat = null; this.wallMat = null; this.tunnelMat = null; this.portalMat = null;
    this.models = buildModels(this.t);
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    // road markings: flush with the asphalt (raised, they swallowed the bottom of the tyres), pulled
    // forward in depth instead so they never flicker through it
    this.lineMat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.natureMats = this.nature ? natureMaterials(this.nature) : null;
    // wind: metres of sway per metre² of height, so a 9 m tree's crown moves ~15-20 cm, grass ~7 cm
    const WIND = { Bark_NormalTree: 0.0022, Leaves_NormalTree: 0.0022, Leaves_Pine: 0.0018, Leaves_TwistedTree: 0.03, Leaves: 0.12, Flowers: 0.15, Grass: 0.16 };
    if (this.natureMats) for (const [name, m] of Object.entries(this.natureMats)) if (WIND[name]) windify(m, WIND[name], this.windTime);
    this.matTree = windify(this.mat.clone(), 0.0022, this.windTime);
    this.matPlant = windify(this.mat.clone(), 0.15, this.windTime);
    this.matTall = windify(this.mat.clone(), 0.03, this.windTime);
    this.matGrass = windify(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 0.35, this.windTime);
    const asphalt = surfaceTexture();
    asphalt.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.roadMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: asphalt,
      bumpMap: asphalt, bumpScale: 0.035, roughness: 0.96, metalness: 0 });
    this.path = { x: [], z: [], h: [] };
    this.minElev = route.minElev;

    const fogColor = rgb(this.t.fog);
    this.scene.fog = new THREE.Fog(fogColor, LOW ? 120 : 150, LOW ? 850 : 1500); // phones build less ahead: the fog closes in before it ends
    this.scene.background = col(this.t.sky[1]);

    this.hemi = new THREE.HemisphereLight(col(this.t.sky[1]), rgb(this.t.grass[0]).multiplyScalar(0.65), 0.8); // softer fill so the sun's shading reads on the rider
    this.scene.add(this.hemi);
    this.sunDirection = this.t.sun
      ? new THREE.Vector3(Math.cos((this.t.sun.x - 0.5) * 2), 0.16, Math.sin((this.t.sun.x - 0.5) * 2)).normalize()
      : new THREE.Vector3(-0.6, 0.5, 0.62).normalize(); // low raking sun: long shadows, readable volume on the rider
    // the sun with cascaded shadow maps: crisp shadows by the rider, softer ones out to 300 m
    // (one shadow map covered only 45 m around the rider, so distant trees stood flat)
    if (this.csm) { this.csm.remove(); this.csm.dispose(); }
    this.csmDone = new WeakSet();
    this.csm = new CSM({
      camera: this.camera, parent: this.scene, cascades: CSM_CASCADES, maxFar: CSM_FAR, mode: 'practical',
      shadowMapSize: LOW ? 1024 : 2048, lightDirection: this.sunDirection.clone().negate(), lightIntensity: this.t.sun ? 2.3 : 3.0,
      lightNear: 1, lightFar: 1500, lightMargin: 150, shadowBias: -0.0004,
    });
    this.csm.fade = true;
    for (const l of this.csm.lights) { l.shadow.normalBias = 0.03; l.shadow.autoUpdate = false; }

    this._applyAtmosphere();
    this._tintWater?.();
    const sea = this.t.layers.find((l) => l.kind === 'sea');
    if (this.t3.dip) {
      const ripples = surfaceTexture(true);
      ripples.repeat.set(700, 700);
      this.waterBase = sea ? sea.color : '#3a8fc4';
      this.water = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), new THREE.MeshPhongMaterial({ color: this.waterBase, shininess: 140, specular: '#fff4e0', bumpMap: ripples, bumpScale: 0.12, transparent: true, opacity: 0.94 }));
      this._tintWater();
      this.water.rotation.x = -Math.PI / 2;
      this.water.receiveShadow = true;
      this.scene.add(this.water);
    } else this.water = null;
    if (this.t.snowfall) this._snowfall(); else this.snow = null;
    this._csmMaterials(this.scene);
  }

  /**
   * Water takes the sky: its own colour mixed with the horizon's (peach at the golden hour, deep blue at night), and
   * the sun's glint in the light's colour.
   */
  _tintWater() {
    if (!this.water || !this.t) return;
    const m = this.water.material, sky = col(this.t.sky[1]), deep = col(this.t.sky[0]);
    m.color.copy(col(this.waterBase)).lerp(deep, 0.25).lerp(sky, 0.28).multiplyScalar(this.atm?.night ? 0.45 : 1);
    m.specular.set(this.atm?.light || '#fff4e0');
    m.needsUpdate = true;
  }

  /** Time of day ('auto', 'morning', 'midday', 'evening', 'night') and weather ('clear', 'fog', 'rain'). */
  setAtmosphere(time = 'midday', weather = 'clear') {
    this.atmTime = time; this.atmWeather = weather;
    if (this.tBase) { this._applyAtmosphere(); this._tintWater(); }
  }

  /** Sky, fog, lights, sun, distant mountains, clouds and rain for the chosen hour and weather (the land stays). */
  _applyAtmosphere() {
    const a = this.atm = atmosphereFor(this.tBase, this.atmTime, this.atmWeather);
    this.t = a.t;
    const fogC = rgb(this.t.fog);
    this.scene.fog.color.copy(fogC); this.scene.fog.near = a.fogNear; this.scene.fog.far = a.fogFar;
    this.scene.background = col(this.t.sky[1]);
    this.hemi.color.copy(col(a.hemiColor || this.t.sky[1])); this.hemi.intensity = a.hemi; // the sky's fill: its own colour when the horizon would tint it
    this.hemi.groundColor.copy(rgb(this.t.grass[0]).multiplyScalar(0.65 * (a.night ? 0.3 : 1)));
    for (const l of this.csm.lights) { l.color.set(a.light); l.intensity = a.lightI; }
    this.renderer.toneMappingExposure = a.exposure;
    for (const o of [this.sky, this.sunDisk, this.sunGlow, this.cloudGroup, this.rain, ...(this.rings || [])]) if (o) { this.scene.remove(o); o.geometry?.dispose(); }
    this._sky();
    this.sunDisk.visible = this.sunGlow.visible = a.showSun;
    this._mountains();
    this._clouds();
    this.rain = null;
    if (a.rain) this._rainfall();
    // a wet road: darker and glossy, the sky shining in it
    if (this.roadMat) { this.roadMat.roughness = a.rain ? 0.62 : 0.96; this.roadMat.metalness = 0; this.roadMat.color.setScalar(a.rain ? 0.7 : 1); }
  }

  /** Rain: thin streaks of mixed length and speed, densest near the camera, slanting back as you ride
   *  through them and fading into the fog; the road turns dark and glossy. */
  _rainfall() {
    const n = LOW ? 1100 : 3000, pos = new Float32Array(n * 6), cols = new Float32Array(n * 6);
    const drops = this.rainDrops = { speed: new Float32Array(n), len: new Float32Array(n), x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      const r = 2 + Math.pow(hash(i * 1.7), 1.6) * 34, a = hash(i * 2.3) * Math.PI * 2; // more drops close by
      drops.x[i] = Math.cos(a) * r; drops.z[i] = Math.sin(a) * r; drops.y[i] = hash(i * 3.1) * 18;
      drops.speed[i] = 7.5 + hash(i * 4.3) * 4;
      drops.len[i] = 0.25 + hash(i * 5.9) * 0.55;
      // the top of each streak fades out: a falling drop is a soft line, not a stick
      const b = 0.75 + hash(i * 6.7) * 0.25;
      cols.set([b, b, b, 0, 0, 0], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#c5d0dc', vertexColors: true, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }));
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  _sky() {
    const g = new THREE.SphereGeometry(3500, 48, 32);
    const top = col(this.t.sky[0]), bottom = col(this.t.sky[1]);
    const cs = [];
    const p = g.attributes.position;
    const A = this.atm || {};
    const glow = col(A.glow || (this.t.sun ? '#ffb36b' : '#fff4dc')), haze = bottom.clone().lerp(col(A.night ? '#2a3654' : '#ffffff'), 0.35);
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      const t = Math.max(0, Math.min(1, p.getY(i) / 1600));
      const c = bottom.clone().lerp(top, Math.pow(t, 0.7));
      v.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
      // a pale band just over the horizon, and the sky brighter and warmer on the sun's side
      const e = Math.max(0, v.y);
      c.lerp(haze, Math.max(0, 1 - e / 0.12) * 0.55);
      const toSun = Math.max(0, v.x * 0.88 + v.y * 0.47); // the sun sits ~28° up on +x
      c.lerp(glow, Math.pow(toSun, 6) * (this.t.sun ? 0.55 : 0.35));
      cs.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3));
    this.sky = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: false }));
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
    this.sunDisk = new THREE.Mesh(new THREE.CircleGeometry(A.diskSize || (this.t.sun ? 110 : 38), 48),
      new THREE.MeshBasicMaterial({ color: A.disk || this.t.sun?.color || '#fff5db', fog: false, toneMapped: false, depthWrite: false }));
    this.sunDisk.renderOrder = -8;
    this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunGlowTexture(),
      transparent: true, fog: false, depthWrite: false, toneMapped: false }));
    this.sunGlow.scale.setScalar(A.night ? 380 : this.t.sun ? 1100 : 650);
    this.sunGlow.renderOrder = -9;
    this.scene.add(this.sunGlow, this.sunDisk);
  }

  _mountains() {
    this.rings = [];
    const fog = rgb(this.t.fog);
    const near = this.t.layers.filter((l) => l.kind !== 'sea').slice(0, 2);
    // a third ridge, farthest and palest, behind the first: the haze between ridges gives the distance its depth
    const layers = near.length ? [{ ...near[0], far: true }, ...near] : near;
    layers.forEach((L, li) => {
      const far = !!L.far, idx = far ? 0 : li - 1;
      const R = far ? 3150 : idx === 0 ? 2600 : 1900, N = far ? 160 : 220;
      const amp = L.amp * (far ? 4600 : idx === 0 ? 3900 : 2100);
      const freq = far ? L.freq * 0.7 + 0.5 : L.freq;
      const pos = [], cs = [];
      const dim = (this.atm?.dim ?? 1) ** 2.2; // dusk and night darken the far hills (vertex colours are linear: dim as perceived)
      const veil = this.atmWeather === 'fog' ? 0.6 : this.atmWeather === 'rain' ? 0.35 : 0; // fog and rain swallow the far hills
      const haze = far ? 0.55 : idx === 0 ? 0.3 : 0.18, hazeTop = far ? 0.5 : idx === 0 ? 0.25 : 0.12;
      const base = col(L.base).lerp(fog, Math.min(0.9, haze + veil)).multiplyScalar(dim), top = col(L.top).lerp(fog, Math.min(0.9, hazeTop + veil)).multiplyScalar(dim);
      const snow = col('#f6f9fc').lerp(fog, far ? 0.4 : 0.12).multiplyScalar(dim);
      const seed = far ? 7 : idx;
      const hgt = (i) => {
        const u = (i / N) * Math.PI * 2;
        let r = 0.55 + 0.25 * Math.sin(u * freq * 2 + seed) + 0.15 * Math.sin(u * freq * 5.3 + seed * 2) + 0.08 * Math.sin(u * 23 + seed);
        if (L.flat) r = Math.min(r, L.flat);
        return r * amp;
      };
      const H = [];
      for (let i = 0; i <= N; i++) H.push(hgt(i % N) + (hash((i % N) + seed * 99) - 0.5) * amp * 0.12);
      // the snow line wanders a little from column to column, as it does on real slopes
      const snowY = (i) => amp * (0.58 + (hash((i % N) * 3.7 + seed * 17) - 0.5) * 0.12);
      // colours per corner: [bottom left, bottom right, top left, top right]
      const quad = (a0, a1, y00, y01, y10, y11, [c00, c10, c01, c11]) => {
        const v = (a, y) => [Math.cos(a) * R, y, Math.sin(a) * R];
        const P = [v(a0, y00), v(a1, y10), v(a0, y01), v(a1, y10), v(a1, y11), v(a0, y01)];
        const C = [c00, c10, c01, c10, c11, c01];
        P.forEach((q, k) => { pos.push(...q); cs.push(C[k].r, C[k].g, C[k].b); });
      };
      // baked relief: a slope rising along the ridge catches the light, a falling one is in shade. Shaded at the
      // column edges from the slope across both neighbours, so it blends across a face (by face it striped the range)
      const shadeAt = (i) => {
        const d = (H[(i + 1) % N] - H[(i - 1 + N) % N]) / 2;
        return 1 + Math.max(-1, Math.min(1, d / (amp * 0.1))) * (far ? 0.07 : 0.13);
      };
      const snowCol = (sh) => sh >= 1 ? snow.clone().multiplyScalar(Math.min(1.04, sh)) // snow in the shade goes a cool blue
        : snow.clone().lerp(col('#b9c9e4').multiplyScalar(dim), (1 - sh) * 4).multiplyScalar(0.96);
      for (let i = 0; i < N; i++) {
        const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
        const h0 = H[i], h1 = H[i + 1], sh0 = shadeAt(i), sh1 = shadeAt(i + 1);
        const s0 = snowY(i), s1 = snowY(i + 1);
        const m0 = L.snow ? Math.min(h0, s0) : h0, m1 = L.snow ? Math.min(h1, s1) : h1;
        const topAt = (m, sh) => base.clone().lerp(top, Math.min(1, m / amp)).multiplyScalar(sh);
        const foot = (sh) => base.clone().multiplyScalar(0.96 + (sh - 1) * 0.4);
        quad(a0, a1, -250, m0, -250, m1, [foot(sh0), foot(sh1), topAt(m0, sh0), topAt(m1, sh1)]);
        if (L.snow && (h0 > s0 || h1 > s1)) { const c0 = snowCol(sh0), c1 = snowCol(sh1); quad(a0, a1, m0, h0, m1, h1, [c0, c1, c0, c1]); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
      mesh.renderOrder = far ? -6 : -5;
      this.rings.push(mesh);
      this.scene.add(mesh);
    });
  }

  _clouds() {
    this.cloudGroup = new THREE.Group();
    const dim = (this.atm?.dim ?? 1) ** 2.2, rainy = this.atmWeather === 'rain' || this.atmWeather === 'fog';
    const top = new THREE.MeshBasicMaterial({ color: col(rainy ? '#d7dde4' : '#ffffff').lerp(rgb(this.t.fog), 0.25).multiplyScalar(dim), fog: false });
    const under = new THREE.MeshBasicMaterial({ color: col(rainy ? '#9aa4b0' : '#c4d3e3').lerp(rgb(this.t.fog), 0.5).multiplyScalar(dim), fog: false });
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

  /** Hook every lit material under `root` into the cascaded shadows (keeping its own shader tweaks). */
  _csmMaterials(root) {
    if (!this.csm) return;
    root.traverse((o) => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (this.csmDone.has(m) || !(m.isMeshLambertMaterial || m.isMeshStandardMaterial || m.isMeshPhongMaterial)) continue;
        this.csmDone.add(m);
        const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey ? m.customProgramCacheKey() : '';
        this.csm.setupMaterial(m);
        const hook = m.onBeforeCompile;
        m.onBeforeCompile = function (sh, r) { if (prev) prev.call(this, sh, r); hook.call(this, sh, r); };
        m.customProgramCacheKey = () => `${prevKey}|csm`;
        m.needsUpdate = true;
      }
    });
  }

  // ----- path -----

  _ensurePath(a) {
    const P = this.path;
    while (A0 + P.h.length <= a + 1) {
      const i = P.h.length;
      if (i === 0) { P.x.push(0); P.z.push(0); P.h.push(0); continue; }
      const prev = A0 + i - 1;
      const h = P.h[i - 1] + (this.route.segAt(prev).curve * TURN) / SEG;
      P.h.push(h);
      // each segment is a circular arc with its heading turning evenly from one end to the other
      const [ox, oz] = arc(P.h[i - 1], h, 1);
      P.x.push(P.x[i - 1] + ox);
      P.z.push(P.z[i - 1] + oz);
    }
  }

  _roadY(d) { return (this.route.elevAt(d) - this.minElev) * V_EXAG; }

  /** World frame at absolute distance d: position on the centre line, heading, right vector. */
  frame(d) {
    const a = Math.floor(d / SEG), t = d / SEG - a;
    this._ensurePath(a + 1);
    const P = this.path, i = a - A0;
    const h = P.h[i] + (P.h[i + 1] - P.h[i]) * t;
    const [ox, oz] = arc(P.h[i], P.h[i + 1], t); // along the arc, not the chord: bends without corners
    const x = P.x[i] + ox, z = P.z[i] + oz;
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

  /**
   * How far the land may reach to each side of the road at segment a, so it never covers another
   * stretch of the same road (hairpins, a track that comes back past itself). Imported routes only.
   */
  _reachAt(a, f) {
    if (!this.route.custom) return null;
    if (!this.reach) { // spatial grid of the whole road, 50 m cells
      const cells = new Map(), n = this.route.segments.length;
      for (let b = -20; b < n + 20; b += 2) {
        const g = this.frame(b * SEG), key = `${Math.floor(g.x / 50)},${Math.floor(g.z / 50)}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push([b, g.x, g.z]);
      }
      this.reach = cells;
    }
    const far = COLS[COLS.length - 1];
    const lim = [far, far], other = [null, null]; // per side: reach, and the other road's height there
    const cx = Math.floor(f.x / 50), cz = Math.floor(f.z / 50);
    for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) {
      for (const [b, x, z] of this.reach.get(`${cx + i},${cz + j}`) || []) {
        const vx = x - f.x, vz = z - f.z, dist = Math.hypot(vx, vz);
        if (dist > 300 || Math.abs(b - a) * SEG < dist * 1.4 + 20) continue; // the same stretch of road
        const along = vx * f.rx + vz * f.rz; // + right, - left
        const across = Math.abs(vx * Math.cos(f.h) + vz * Math.sin(f.h));
        if (across > Math.abs(along) * 1.2) continue;
        const k = along >= 0 ? 1 : 0, m = Math.max(ROAD_HALF + 2, dist * 0.5);
        if (m < lim[k]) { lim[k] = m; other[k] = this._roadY(b * SEG); }
      }
    }
    // inside a tight bend the land would fold over itself: keep it within the bend's radius
    const k = (this.frame(a * SEG + 10).h - this.frame(a * SEG - 10).h) / 20;
    if (Math.abs(k) > 1e-4) {
      const inner = k > 0 ? 1 : 0, m = Math.max(ROAD_HALF + 1, 0.9 / Math.abs(k));
      if (m < lim[inner]) { lim[inner] = m; other[inner] = null; }
    }
    return { lim, other }; // [left, right]
  }

  /** The real land beside an imported road at segment a and offset o: '.' open, 'f' wood, 'w' water. */
  _landAt(a, o) {
    if (!this.land || Math.abs(o) < 11) return '.';
    const n = LAND_OFFSETS.length, rows = this.land.length / n;
    const row = Math.max(0, Math.min(rows - 1, Math.round((a * SEG) / LAND_STEP)));
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(LAND_OFFSETS[i] - o); if (d < bd) { bd = d; best = i; } }
    return Math.sign(LAND_OFFSETS[best]) === Math.sign(o) ? this.land[row * n + best] : '.';
  }

  // ----- chunks -----

  _buildChunk(c) {
    const group = new THREE.Group();
    const a0 = c * CHUNK, rows = CHUNK + 1, nc = COLS.length;
    const n = this.route.segments.length;
    const T = this.t, T3c = this.t3;
    const grassA = rgb(T.grass[0]), grassB = rgb(T.grass[1]), verge = rgb(T.verge[0]);
    const waterC = col('#4f93c4');
    // in a village (a loop's later laps pass the same ones): no woods within 50 m of the road
    const L = this.route.length, loop = !this.route.oneWay;
    const inVillage = (d) => { const w = loop ? ((d % L) + L) % L : d; return this.villageSpans.some(([s0, s1]) => w > s0 - 20 && w < s1 + 20); };
    // a stream under a bridge: the land dips into a gully across the whole view, deepest under the road
    const gully = (d) => {
      const w = loop ? ((d % L) + L) % L : d;
      for (const c of this.crossings) { const dd = Math.abs(w - c); if (dd < GULLY) return 1 - (dd / GULLY) ** 2; }
      return 0;
    };
    // a tunnel: the mountain closes over the road between the portals ([start, end] along the route)
    const inTunnel = (d, pad = 0) => {
      const w = loop ? ((d % L) + L) % L : d;
      return this.tunnels.some(([t0, t1]) => w >= t0 - pad && w <= t1 + pad);
    };
    const onBridge = (a) => gully(a * SEG + SEG / 2) > 0 || gully(a * SEG) > 0 || gully(a * SEG + SEG) > 0
      || inTunnel(a * SEG, SEG) || inTunnel(a * SEG + SEG, SEG); // nor in a tunnel
    const sand = col('#e2cc96'), rockC = col(T3c.rockColor || '#8d8f8c'), snowC = col('#f2f6f9');
    const frames = [];
    for (let r = 0; r < rows; r++) frames.push(this.frame((a0 + r) * SEG));

    // terrain grid
    const pos = new Float32Array(rows * nc * 3), colors = new Float32Array(rows * nc * 3);
    const heights = [];
    const reach = frames.map((f, r) => this._reachAt(a0 + r, f));
    for (let r = 0; r < rows; r++) {
      const f = frames[r];
      heights.push([]);
      for (let k = 0; k < nc; k++) {
        const sd = COLS[k] > 0 ? 1 : 0, lim = reach[r] ? reach[r].lim[sd] : Infinity;
        const o = Math.sign(COLS[k]) * Math.min(Math.abs(COLS[k]), lim);
        const x = f.x + f.rx * o, z = f.z + f.rz * o;
        let y = this._terrainY(f.y, o, x, z);
        const g = gully((a0 + r) * SEG);
        y -= g * GULLY_DEPTH;
        // over a tunnel the hill rises 11 m above the road and slopes away beyond 12 m out
        if (inTunnel((a0 + r) * SEG)) y = Math.max(y, f.y + TUNNEL_HILL - Math.max(0, Math.abs(o) - 12) * 0.28);
        const lc = this.land ? this._landAt(a0 + r, o) : '.';
        if (lc === 'w') y = Math.min(y, f.y - 1.3); // a lake or a wide river: flat, a little below the road
        // between two stretches of the same road the land slopes to meet halfway, at the mean height
        const oy = reach[r]?.other[sd];
        if (oy !== null && oy !== undefined) {
          const mid = (f.y + oy) / 2, t = smooth(ROAD_HALF + 1, lim, Math.abs(o));
          y = this._terrainY(f.y + (mid - f.y) * t, o, x, z);
        }
        heights[r].push(y);
        const i = (r * nc + k) * 3;
        pos[i] = x; pos[i + 1] = y; pos[i + 2] = z;
        let cc = grassA.clone().lerp(grassB, vnoise(x / 30, z / 30));
        cc.multiplyScalar(0.92 + vnoise(x / 9, z / 9) * 0.16);
        if (Math.abs(o) < 8) cc = verge.clone();
        if (g > 0.6) cc = cc.lerp(col('#6f6551'), (g - 0.6) * 2.2); // the stream's muddy banks
        if (lc === 'f') cc.multiplyScalar(0.72);
        if (lc === 'w') cc = waterC.clone().lerp(cc, vnoise(x / 40, z / 40) * 0.08);
        const rel = y - f.y;
        if (T3c.rock && rel > T3c.rock) cc = rockC.clone().lerp(cc, 0.3);
        if (T3c.snow && rel > T3c.snow) cc = snowC.clone();
        if (T3c.dip && rel < -T3c.dip.depth * 0.25 && Math.sign(o) === T3c.dip.side) cc = sand.clone();
        if (T3c.beach && Math.sign(o) === T3c.dip.side && Math.abs(o) > 10) cc = sand.clone();
        colors[i] = cc.r; colors[i + 1] = cc.g; colors[i + 2] = cc.b;
      }
    }
    const idx = [];
    const roadK = COLS.findIndex((o) => o > 0) - 1; // the cell under the road
    for (let r = 0; r < rows - 1; r++) {
      // through a tunnel's mouth and inside, no land across the road: the hill would close the way
      const open = inTunnel((a0 + r) * SEG, SEG) || inTunnel((a0 + r + 1) * SEG, SEG);
      for (let k = 0; k < nc - 1; k++) {
        if (open && k === roadK) continue;
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
    this._bridges(group, a0, rows);
    this._tunnels(group, a0, rows);

    // road ribbon + edge lines
    // the road is drawn every 1.25 m (the land every 5 m), so bends stay round on a wide road
    const SUB = 4, fine = [];
    for (let q = 0; q <= CHUNK * SUB; q++) fine.push(q % SUB ? this.frame((a0 + q / SUB) * SEG) : frames[q / SUB]);
    const ribbon = (o1, o2, lift, color, material = this.mat, dashed = false, shade = null) => {
      const p = [], cs = [], uv = [];
      const cc = color instanceof THREE.Color ? color : col(color);
      for (let q = 0; q < fine.length - 1; q++) {
        if (dashed && ((a0 + Math.floor(q / SUB)) % 3 + 3) % 3 !== 0) continue;
        const f1 = fine[q], f2 = fine[q + 1];
        const v = (f, o) => [f.x + f.rx * o, f.y + lift, f.z + f.rz * o];
        const A = v(f1, o1), B = v(f1, o2), C = v(f2, o1), D = v(f2, o2);
        p.push(...A, ...B, ...C, ...B, ...D, ...C);
        // World-space coordinates keep the asphalt continuous across chunks.
        for (const v of [A, B, C, B, D, C]) {
          uv.push(v[0] / 4, v[2] / 4);
          // the asphalt is not one grey: older stretches and repair patches, darker where it was mended
          const k = (material === this.roadMat ? (0.9 + vnoise(v[0] / 9, v[2] / 9) * 0.14) * (vnoise(v[0] / 23 + 50, v[2] / 23) > 0.68 ? 0.8 : 1) : 1)
            * (shade ? shade((a0 + q / SUB) * SEG) : 1);
          cs.push(cc.r * k, cc.g * k, cc.b * k);
        }
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
    ribbon(-ROAD_HALF - 0.6, ROAD_HALF + 0.6, 0.02, verge.clone().multiplyScalar(0.85), this.mat, false,
      (d) => (inTunnel(d, 2) ? 0.18 : 1)); // the verge in a tunnel is in the dark
    ribbon(-ROAD_HALF, ROAD_HALF, 0.05, rgb(T.road[0]), this.roadMat);
    ribbon(-ROAD_HALF * 0.9 - 0.07, -ROAD_HALF * 0.9 + 0.07, 0.052, rgb(T.line), this.lineMat);
    ribbon(ROAD_HALF * 0.9 - 0.07, ROAD_HALF * 0.9 + 0.07, 0.052, rgb(T.line), this.lineMat);
    ribbon(-0.055, 0.055, 0.052, rgb(T.line), this.lineMat, true);

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
      if (onBridge(a)) continue; // nothing stands in the gully or on the bridge
      for (const side of [-1, 1]) {
        if (((a % 5) + 5) % 5 === 0) {
          const o = side * (ROAD_HALF + 0.45);
          put('delineator', mtx(f.x + f.rx * o, heightAt(r, o), f.z + f.rz * o, -f.h, 1));
        }
        // small stones on the verge, a few per stretch, half of them on phones
        for (let q = 0; q < (LOW ? 1 : 2); q++) {
          const seed = a * 7.9 + side * 17.3 + q * 5.1;
          if (hash(seed) > 0.45 || T.snowfall) continue;
          const o = side * (ROAD_HALF + 0.85 + hash(seed + 1) ** 2 * 4);
          const ff = this.frame(a * SEG + hash(seed + 2) * SEG), s = 0.1 + hash(seed + 3) * 0.16;
          put('rock@verge', mtx(ff.x + ff.rx * o, heightAt(r, o) - s * 0.2, ff.z + ff.rz * o, hash(seed + 4) * 6.28, s));
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
          if (this.land && TREE_TYPES.includes(sc.type)) return; // trees stand where the map has woods
          if (TREE_TYPES.includes(sc.type) && inVillage(a * SEG)) return;
          const h = (k) => hash(idxN * 7.13 + side * 3.7 + (j * 4 + k) * 19.1);
          if (h(0) >= sc.prob) return;
          const o = side * (sc.off[0] + h(1) * (sc.off[1] - sc.off[0])) * ROAD_HALF;
          if (reach[r] && Math.abs(o) > reach[r].lim[side > 0 ? 1 : 0] - 2) return; // would stand on another stretch of road
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
              for (let q = 0; q < (LOW ? 3 : 7); q++) put('flower', mtx(...spot(q, 3.2), hash(a * 5 + q) * 6.28, 0.8 + hash(a * 7 + q) * 0.6));
              for (let q = 7; q < (LOW ? 8 : 10); q++) put('clover', mtx(...spot(q, 2.6), hash(a + q * 9) * 6.28, 0.8 + hash(a + q) * 0.5));
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
      if (treeTypes.length && !this.land) {
        for (let q = 0; q < 3; q++) {
          const hq = (k) => hash(idxN * 3.31 + q * 51.7 + k * 7.9);
          if (hq(0) > T3c.far) continue;
          const side = hq(1) < 0.5 ? -1 : 1, o = side * (30 + hq(2) * 230);
          if (reach[r] && Math.abs(o) > reach[r].lim[side > 0 ? 1 : 0] - 4) continue;
          if (Math.abs(o) < 55 && inVillage(a * SEG)) continue;
          const y = heightAt(r, o);
          if (this.water && y < f.y - (T3c.dip?.depth || 0) * 0.3) continue;
          const tt = treeTypes[Math.floor(hq(3) * treeTypes.length)].type;
          put(`${tt}@far`, mtx(f.x + f.rx * o, y, f.z + f.rz * o, hq(4) * 6.28, 0.9 + hq(4) * 0.7));
        }
      }
    }
    // a lawn of grass clumps along both verges, thickest by the road, swaying in the wind
    const grass = [];
    if (!T.snowfall && this.route.theme !== 'desert') {
      for (let r = 0; r < rows - 1; r++) {
        const a = a0 + r;
        if (onBridge(a)) continue;
        for (const side of [-1, 1]) {
          const lim = reach[r] ? reach[r].lim[side > 0 ? 1 : 0] : Infinity;
          for (let q = 0; q < (LOW ? 12 : 40); q++) { // a third of the grass on phones
            const hq = (k) => hash(a * 11.3 + side * 5.7 + q * 2.9 + k * 7.1);
            const o = side * (ROAD_HALF + 0.75 + hq(0) ** 2.4 * 30);
            if (Math.abs(o) > lim - 1 || (T3c.beach && side === T3c.dip.side && Math.abs(o) > 9)) continue;
            if (this.land && this._landAt(a, o) === 'w') continue;
            const ff = this.frame(a * SEG + hq(1) * SEG);
            const x = ff.x + ff.rx * o, z = ff.z + ff.rz * o;
            grass.push([mtx(x, heightAt(r, o) - 0.02, z, hq(2) * 6.28, 0.75 + hq(3) * 0.7), 0.82 + hq(4) * 0.3]);
            // now and then a wild flower in the grass near the road
            if (hq(5) < 0.07 && Math.abs(o) < 14) flowers.push([x + 0.3, heightAt(r, o), z, flowerPalette[Math.floor(hq(6) * flowerPalette.length)]]);
          }
        }
      }
    }
    if (grass.length) {
      const im = new THREE.InstancedMesh(this.models.grassClump, this.matGrass, grass.length);
      const c = new THREE.Color();
      grass.forEach(([m, k], i) => { im.setMatrixAt(i, m); im.setColorAt(i, c.setScalar(k)); });
      im.receiveShadow = true;
      group.add(im);
    }

    // imported routes: woods and buildings from the map
    if (this.land) {
      const types = treeTypes.length ? treeTypes.map((x) => x.type) : ['pine', 'oak', 'birch'];
      const sides = [-1, 1].map((sd) => LAND_OFFSETS.map((o, i) => [o, i]).filter(([o]) => Math.sign(o) === sd).sort((p, q) => Math.abs(p[0]) - Math.abs(q[0])));
      for (let r = 0; r < rows - 1; r++) {
        const a = a0 + r;
        for (const list of sides) {
          list.forEach(([o], i) => {
            if (this._landAt(a, o) !== 'f') return;
            // the band this cell stands for: halfway to its neighbours across the road
            const ao = Math.abs(o), sd = Math.sign(o);
            const inner = i ? (Math.abs(list[i - 1][0]) + ao) / 2 : Math.max(ROAD_HALF + 4, ao - 8);
            const outer = i < list.length - 1 ? (Math.abs(list[i + 1][0]) + ao) / 2 : ao + 40;
            const spacing = ao < 70 ? 7 : 13, n = ((outer - inner) * SEG) / (spacing * spacing);
            const lim = reach[r] ? reach[r].lim[sd > 0 ? 1 : 0] : Infinity;
            for (let q = 0; q < Math.ceil(n); q++) {
              const hq = (k) => hash(a * 7.31 + o * 1.13 + q * 13.7 + k * 3.1);
              if (hq(0) > n - q) continue; // the fractional last tree
              const oo = sd * (inner + hq(1) * (outer - inner));
              if (Math.abs(oo) > lim - 3) continue;
              const ff = this.frame(a * SEG + hq(2) * SEG);
              const tt = types[Math.floor(hq(3) * types.length)];
              put(Math.abs(oo) < 60 ? tt : `${tt}@far`, mtx(ff.x + ff.rx * oo, heightAt(r, oo), ff.z + ff.rz * oo, hq(4) * 6.28, 0.8 + hq(5) * 0.6));
            }
          });
        }
      }
    }
    // buildings: an imported route's from the map, a made-up route's villages
    if (this.buildings.length) {
      const d0 = a0 * SEG, d1 = (a0 + rows - 1) * SEG;
      const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      const lap = loop && !this.land ? Math.floor(d0 / L) * L : 0;
      for (const [d00, o, size, ang, floors = 1, kind = 'house'] of this.buildings) {
        const d = [d00 + lap, d00 + lap + L].find((x) => x >= d0 && x < d1) ?? (lap ? NaN : d00); // a loop's villages on every lap
        if (!(d >= d0 && d < d1)) continue;
        const r = Math.floor(d / SEG) - a0, lim = reach[r] ? reach[r].lim[o > 0 ? 1 : 0] : Infinity;
        if (Math.abs(o) > lim - size / 2) continue;
        const f = this.frame(d), s = size / 8;
        // the footprint from the map, the height from the floors: a house up to three, flats above
        const tall = floors >= 4, sy = tall ? floors : Math.min(1.3, 0.75 + floors * 0.25);
        const m = new THREE.Matrix4().compose(new THREE.Vector3(f.x + f.rx * o, heightAt(r, o) - 0.2, f.z + f.rz * o),
          q.setFromAxisAngle(up, -f.h - ang), new THREE.Vector3(s, sy, s));
        put(tall ? 'block' : kind, m);
      }
    }

    for (const [key, list] of Object.entries(place)) {
      const [type, far] = key.split('@');
      if (!list.length) continue;
      const castShadow = !far && !['tuft', 'sunflowers', 'lupine'].includes(type);
      if (this.nature?.types[type]) { this._addNature(group, type, list, castShadow); continue; }
      const geom = this.models[type];
      if (!geom) continue;
      const mat = ['oak', 'pine', 'birch', 'palm'].includes(type) ? this.matTree
        : ['tuft', 'flower', 'lupine'].includes(type) ? this.matPlant
          : ['sunflowers', 'bush'].includes(type) ? this.matTall : this.mat;
      const im = new THREE.InstancedMesh(geom, mat, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      if (type === 'house' || type === 'cottage') list.forEach((m, i) => im.setColorAt(i, HOUSE_TINTS[Math.floor(hash2(m.elements[12] * 0.13, m.elements[14] * 0.17) * HOUSE_TINTS.length)]));
      im.castShadow = castShadow;
      im.receiveShadow = true;
      group.add(im);
    }
    if (flowers.length) {
      const im = new THREE.InstancedMesh(this.models.flower, this.matPlant, flowers.length);
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
    this._crowd(group, a0, rows, frames, heightAt);
    // arches over the road: start / finish, and the foot and the top of every climb
    for (const A of this._arches()) {
      const n = this.route.oneWay ? 0 : Math.floor((a0 * SEG - A.d) / this.route.length);
      for (let k = n; k <= n + 1; k++) {
        const d = A.d + (this.route.oneWay ? 0 : k * this.route.length);
        if (d >= a0 * SEG && d < (a0 + rows - 1) * SEG) group.add(this._arch(A, d));
        if (this.route.oneWay) break;
      }
    }
    this.scene.add(group);
    return group;
  }

  // ----- fans at the tops of climbs (#45) -----

  /**
   * The crowd's three meshes, built once: the body (shirt takes the instance colour; legs, head and
   * hands their own colours), and a flag on a pole (Ukrainian, or the instance colour). Arms are up,
   * marked with aArm so the shader waves them; the cloth is marked with aCloth so it flutters.
   */
  /** Over every stream in this chunk: the water in the gully and the bridge's stone walls along both edges. */
  _bridges(group, a0, rows) {
    const L = this.route.length, loop = !this.route.oneWay;
    const d0 = a0 * SEG, d1 = (a0 + rows - 1) * SEG, lap = loop ? Math.floor(d0 / L) * L : 0;
    const at = this.crossings.map((c) => [c + lap - L, c + lap, c + lap + L]).flat().filter((d) => d > d0 - GULLY && d < d1 + GULLY);
    if (!at.length) return;
    this.streamMat ||= new THREE.MeshPhongMaterial({ side: THREE.DoubleSide, color: '#4f8fb8', shininess: 120, specular: '#fff4e0', bumpMap: surfaceTexture(true), bumpScale: 0.1 });
    const stone = col('#9a958c'), walls = [];
    for (const dc of at) {
      // the water: a strip across the land, following its rise and fall, a metre above the bottom of the gully
      const p = [], idx = [];
      for (const [j, dd] of [[0, -4.5], [1, 4.5]]) {
        const f = this.frame(dc + dd);
        for (const o of COLS) {
          const x = f.x + f.rx * o, z = f.z + f.rz * o;
          p.push(x, this._terrainY(f.y, o, x, z) - GULLY_DEPTH * (1 - (dd / GULLY) ** 2) + 1.3, z);
        }
        if (j) for (let k = 0; k < COLS.length - 1; k++) idx.push(k, k + 1, k + COLS.length, k + 1, k + 1 + COLS.length, k + COLS.length); // facing up
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const water = new THREE.Mesh(g, this.streamMat);
      water.receiveShadow = true;
      group.add(water);
      // the walls: a low parapet that runs down to the stone deck, in 2.5 m blocks
      for (let d = dc - GULLY - 1; d < dc + GULLY + 1; d += 2.5) {
        if (d < d0 || d >= d1) continue; // each chunk builds its own blocks
        const f = this.frame(d + 1.25);
        for (const side of [-1, 1]) {
          const o = side * (ROAD_HALF + 0.75);
          walls.push(new THREE.Matrix4().compose(new THREE.Vector3(f.x + f.rx * o, f.y - 0.3, f.z + f.rz * o),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(f.rx, f.rz)), new THREE.Vector3(2.55, 1.9, 0.45)));
        }
      }
    }
    if (!walls.length) return;
    this.wallGeom ||= new THREE.BoxGeometry(1, 1, 1);
    this.wallMat ||= new THREE.MeshLambertMaterial({ color: stone });
    const im = new THREE.InstancedMesh(this.wallGeom, this.wallMat, walls.length);
    walls.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = im.receiveShadow = true;
    group.add(im);
  }

  /** The tunnels in this chunk: a vault over the road with lamps along its crown, a stone portal at each mouth. */
  _tunnels(group, a0, rows) {
    const L = this.route.length, loop = !this.route.oneWay;
    const d0 = a0 * SEG, d1 = (a0 + rows - 1) * SEG, lap = loop ? Math.floor(d0 / L) * L : 0;
    const spans = this.tunnels.flatMap(([s, e]) => [-L, 0, L].map((k) => [s + lap + k, e + lap + k])).filter(([s, e]) => e > d0 && s < d1);
    if (!spans.length) return;
    this.tunnelMat ||= new THREE.MeshBasicMaterial({ color: '#2f2d2a', side: THREE.DoubleSide }); // unlit: no daylight in there
    this.lampMat ||= new THREE.MeshBasicMaterial({ color: '#ffd58a' });
    const lamps = [];
    for (const [s, e] of spans) {
      // the vault: half rings every 2.5 m, from the first mouth to the second, clipped to this chunk
      const from = Math.max(s - SEG, d0), to = Math.min(e + SEG, d1);
      if (to > from) {
        // the profile: straight walls, then a half circle over them
        const prof = [[TUNNEL_R, -0.3], ...Array.from({ length: 13 }, (_, k) => { const t = (k / 12) * Math.PI; return [Math.cos(t) * TUNNEL_R, TUNNEL_WALL + Math.sin(t) * TUNNEL_R]; }), [-TUNNEL_R, -0.3]];
        const ARC = prof.length - 1, ringsN = Math.ceil((to - from) / 2.5) + 1, p = [], idx = [];
        for (let i = 0; i < ringsN; i++) {
          const f = this.frame(Math.min(to, from + i * 2.5));
          for (const [o, y] of prof) p.push(f.x + f.rx * o, f.y + y, f.z + f.rz * o);
          if (i) for (let k = 0; k < ARC; k++) { const a = (i - 1) * (ARC + 1) + k, b = a + ARC + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
        g.setIndex(idx);
        g.computeVertexNormals();
        const vault = new THREE.Mesh(g, this.tunnelMat);
        vault.castShadow = vault.receiveShadow = true;
        group.add(vault);
        for (let d = Math.ceil(from / 12) * 12; d < to; d += 12) {
          const f = this.frame(d);
          lamps.push(new THREE.Matrix4().compose(new THREE.Vector3(f.x, f.y + TUNNEL_WALL + TUNNEL_R - 0.25, f.z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(f.rx, f.rz)), new THREE.Vector3(1.6, 0.12, 0.35)));
        }
      }
      // the portals: a stone face with the arch cut out, set across the road at each mouth
      for (const [dm, dir] of [[s - SEG, -1], [e + SEG, 1]]) {
        if (dm < d0 || dm >= d1) continue;
        this.portalGeom ||= (() => {
          // a stone face a little narrower than the hill and below its top, so the hill shows around it
          const W = TUNNEL_R + 3.4, H = TUNNEL_WALL + TUNNEL_R + 1.6, sh = new THREE.Shape();
          sh.moveTo(-W, -1); sh.lineTo(W, -1); sh.lineTo(W, H); sh.lineTo(-W, H); sh.closePath();
          const hole = new THREE.Path();
          hole.moveTo(TUNNEL_R, -1); hole.lineTo(TUNNEL_R, TUNNEL_WALL);
          hole.absarc(0, TUNNEL_WALL, TUNNEL_R, 0, Math.PI, false);
          hole.lineTo(-TUNNEL_R, -1); hole.closePath();
          sh.holes.push(hole);
          return new THREE.ExtrudeGeometry(sh, { depth: 1.4, bevelEnabled: false, curveSegments: 16 });
        })();
        this.portalMat ||= new THREE.MeshLambertMaterial({ color: '#b9b2a4', emissive: '#2e2b25' }); // stone, never black even against the sun
        const f = this.frame(dm), m = new THREE.Mesh(this.portalGeom, this.portalMat);
        m.position.set(f.x, f.y, f.z);
        m.rotation.y = Math.atan2(f.rx, f.rz) - Math.PI / 2; // its face across the road
        m.translateZ(dir > 0 ? 0 : -1.4);
        m.castShadow = m.receiveShadow = true;
        group.add(m);
      }
    }
    if (lamps.length) {
      this.lampGeom ||= new THREE.BoxGeometry(1, 1, 1);
      const im = new THREE.InstancedMesh(this.lampGeom, this.lampMat, lamps.length);
      lamps.forEach((m, i) => im.setMatrixAt(i, m));
      group.add(im);
    }
  }

  _crowdModels() {
    if (this.crowdModels) return this.crowdModels;
    const parts = (list) => {
      const pos = [], colr = [], arm = [], cloth = [];
      for (const { g, c, a = 0, k = null } of list) {
        const ng = g.index ? g.toNonIndexed() : g;
        const P = ng.attributes.position;
        const cc = col(c);
        for (let i = 0; i < P.count; i++) {
          pos.push(P.getX(i), P.getY(i), P.getZ(i));
          colr.push(cc.r, cc.g, cc.b);
          arm.push(a);
          cloth.push(k ? Math.max(0, (P.getZ(i) - k) / 0.9) : 0);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
      geo.setAttribute('aArm', new THREE.Float32BufferAttribute(arm, 1));
      geo.setAttribute('aCloth', new THREE.Float32BufferAttribute(cloth, 1));
      geo.computeVertexNormals();
      return geo;
    };
    const at = (g, x, y, z, rx = 0, rz = 0) => { g.rotateX(rx); g.rotateZ(rz); g.translate(x, y, z); return g; };
    // facing +x (the road), about 1.7 m tall
    const shirt = (geo) => ({ g: geo, c: '#ffffff' });
    const cap = (r, len, sx = 1, sz = 1) => new THREE.CapsuleGeometry(r, len, 3, 10).scale(sx, 1, sz);
    const body = parts([
      { g: at(cap(0.075, 0.68), 0, 0.42, -0.09), c: '#2b3445' },                          // legs
      { g: at(cap(0.075, 0.68), 0, 0.42, 0.09), c: '#2b3445' },
      shirt(at(cap(0.19, 0.36, 0.72, 1.12), 0, 1.13, 0)),                                // torso
      { g: at(new THREE.SphereGeometry(0.125, 12, 9), 0, 1.6, 0), c: '#e0ae8a' },       // head
      { g: at(new THREE.SphereGeometry(0.13, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), -0.01, 1.62, 0), c: '#4a3426' }, // hair
      // arms raised in a V (waved by the shader round the shoulders)
      { g: at(cap(0.052, 0.5), 0, 1.66, -0.37, -0.5), c: '#ffffff', a: -1 },
      { g: at(cap(0.052, 0.5), 0, 1.66, 0.37, 0.5), c: '#ffffff', a: 1 },
      { g: at(new THREE.SphereGeometry(0.06, 8, 6), 0, 1.93, -0.52), c: '#e0ae8a', a: -1 },
      { g: at(new THREE.SphereGeometry(0.06, 8, 6), 0, 1.93, 0.52), c: '#e0ae8a', a: 1 },
    ]);
    // a flag on a pole, held up beside the fan; the cloth flutters from the pole outward (+z)
    const cloth = (y0, h, c) => ({ g: at(new THREE.PlaneGeometry(0.9, h, 6, 1).rotateY(Math.PI / 2), 0, y0, 0.47), c, k: 0.02 });
    const flagUA = parts([
      { g: at(new THREE.CylinderGeometry(0.018, 0.018, 1.9, 5), 0.05, 1.55, 0), c: '#d9d4c7' },
      cloth(2.34, 0.3, '#0057b7'), cloth(2.04, 0.3, '#ffd700'),
    ]);
    const flagTeam = parts([
      { g: at(new THREE.CylinderGeometry(0.018, 0.018, 1.9, 5), 0.05, 1.55, 0), c: '#d9d4c7' },
      cloth(2.19, 0.6, '#ffffff'),
    ]);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.crowdTime = { value: 0 };
    this.crowdNear = { value: new THREE.Vector3(1e9, 0, 1e9) };
    patchShader(mat, 'crowd', (sh) => {
      sh.uniforms.uCrowdTime = this.crowdTime;
      sh.uniforms.uCrowdNear = this.crowdNear;
      sh.vertexShader = `uniform float uCrowdTime;\nuniform vec3 uCrowdNear;\nattribute float aArm;\nattribute float aCloth;\n${sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 cRoot = instanceMatrix[3].xyz;
        float cPh = fract(sin(dot(cRoot.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
        // wilder when you come by: jumping, waving fast; calm further off
        float cEx = 1.0 - smoothstep(12.0, 45.0, distance(cRoot.xz, uCrowdNear.xz));
        float cSpd = 5.0;
        // arms: round the shoulder, in the plane across the road
        if (aArm != 0.0) {
          vec2 sh0 = vec2(1.38, 0.2 * aArm);
          float ang = aArm * (0.15 + mix(0.12, 0.5, cEx) * sin(uCrowdTime * cSpd + cPh));
          vec2 p = transformed.yz - sh0;
          transformed.yz = sh0 + vec2(p.x * cos(ang) - p.y * sin(ang), p.x * sin(ang) + p.y * cos(ang));
        }
        // the flag: a wave running out along the cloth
        transformed.x += aCloth * sin(uCrowdTime * 8.0 - aCloth * 5.0 + cPh) * 0.1;
        // jumps
        transformed.y += pow(max(0.0, sin(uCrowdTime * cSpd * 0.9 + cPh)), 3.0) * mix(0.02, 0.22, cEx);`)}`;
    });
    this.crowdModels = { body, flagUA, flagTeam, mat };
    return this.crowdModels;
  }

  /** The material for the posed people: each instance's shirt, skin and hair colours, arms waving round the shoulders. */
  _fanMaterial() {
    if (this.fanMat) return this.fanMat;
    this._crowdModels(); // the shared time and "where you are" uniforms
    const S = this.fanModels.shoulder;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchShader(mat, 'fan', (sh) => {
      sh.uniforms.uCrowdTime = this.crowdTime;
      sh.uniforms.uCrowdNear = this.crowdNear;
      sh.vertexShader = `uniform float uCrowdTime;\nuniform vec3 uCrowdNear;\nattribute float aPart;\nattribute float aArm;\nattribute float aCloth;\nattribute vec3 aSkin;\nattribute vec3 aHair;\n${sh.vertexShader
        .replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          vColor.xyz = aPart < 0.5 ? color : (aPart < 1.5 ? instanceColor : (aPart < 2.5 ? aSkin : aHair));
        #endif`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 cRoot = instanceMatrix[3].xyz;
        float cH = fract(sin(dot(cRoot.xz, vec2(12.9898, 78.233))) * 43758.5453);
        float cPh = cH * 6.2831;
        float cType = floor(fract(cH * 7.13) * 4.0); // 0 waves in turn, 1 pumps both arms, 2 sways, 3 jumps
        float cEx = 1.0 - smoothstep(10.0, 60.0, distance(cRoot.xz, uCrowdNear.xz)); // wilder as you come by
        // each fan's own steady tempo: tying it to how close you are made the phase leap as you came near (twitching)
        float cSpd = 4.2 * (0.8 + fract(cH * 3.7) * 0.4);
        transformed.x += aCloth * sin(uCrowdTime * 9.0 - aCloth * 5.0 + cPh) * 0.09; // a flag in the hand flutters
        if (abs(aArm) > 0.001) {
          float sd = sign(aArm);
          vec2 sh0 = vec2(${S.y.toFixed(3)}, ${S.z.toFixed(3)} * sd);
          float wv = cType < 0.5 ? sin(uCrowdTime * cSpd + cPh + sd * 1.6)
                   : cType < 1.5 ? sin(uCrowdTime * cSpd * 1.6 + cPh)
                   : sin(uCrowdTime * cSpd * 0.6 + cPh + sd);
          float ang = aArm * mix(0.08, 0.42, cEx) * wv;
          vec2 p = transformed.yz - sh0;
          transformed.yz = sh0 + vec2(p.x * cos(ang) - p.y * sin(ang), p.x * sin(ang) + p.y * cos(ang));
        }
        if (cType > 1.5 && cType < 2.5) { // leaning side to side from the feet
          float sw = sin(uCrowdTime * cSpd * 0.5 + cPh) * mix(0.03, 0.1, cEx);
          transformed.yz = vec2(transformed.y * cos(sw) - transformed.z * sin(sw), transformed.y * sin(sw) + transformed.z * cos(sw));
        }
        transformed.y += pow(max(0.0, sin(uCrowdTime * cSpd * 0.9 + cPh)), 3.0) * (cType > 2.5 ? mix(0.02, 0.26, cEx) : mix(0.0, 0.05, cEx));
        // turning to watch you go by
        vec3 toYou = inverse(mat3(instanceMatrix)) * (uCrowdNear - cRoot);
        float look = clamp(atan(toYou.z, toYou.x), -1.1, 1.1) * cEx;
        float cl = cos(look), sl = sin(look);
        transformed.xz = vec2(transformed.x * cl - transformed.z * sl, transformed.x * sl + transformed.z * cl);`)}`;
    });
    this.fanMat = mat;
    return mat;
  }

  /** Fans along both sides of the road over the last ~180 m of each climb, and cheers painted on the road. */
  _crowd(group, a0, rows, frames, heightAt) {
    const R = this.route, L = R.length, tops = [];
    for (const c of R.climbs || []) {
      if (R.oneWay) tops.push(c.end);
      else { const n = Math.floor((a0 * SEG - c.end) / L); tops.push(c.end + n * L, c.end + (n + 1) * L); }
    }
    if (!tops.length) return;
    const SHIRTS = ['#e11d48', '#2563eb', '#f59e0b', '#16a34a', '#f97316', '#7c3aed', '#facc15', '#0ea5e9', '#ffffff', '#111827', '#dc2626'];
    const SKIN = ['#f1c9a5', '#e0ae8a', '#c68c63', '#8d5a3b'];
    const fans = [], flagsUA = [], flagsTeam = [];
    const D0 = a0 * SEG, D1 = (a0 + rows - 1) * SEG;
    for (let r = 0; r < rows - 1; r++) {
      const d = (a0 + r) * SEG, f = frames[r];
      let p = 0;
      for (const top of tops) {
        const x = top - d; // metres before the top
        if (x > -20 && x < 190) p = Math.max(p, x < 0 ? 0.55 + x / 45 : 1 - x / 210);
      }
      if (p <= 0) continue;
      for (const side of [-1, 1]) {
        const seed = (a0 + r) * 7.13 + side * 3.1;
        const count = Math.floor(p * (LOW ? 2 : this.fanModels ? 3 : 4) + hash(seed));
        for (let i = 0; i < count; i++) {
          const along = hash(seed + i * 1.7) * SEG;
          const row = hash(seed + i * 2.9) < 0.6 ? 0 : 1; // in front of the fence, or behind it
          const o = side * (row ? ROAD_HALF * 1.18 + 0.5 + hash(seed + i * 4.1) * 1.4 : ROAD_HALF + 0.35 + hash(seed + i * 4.1) * 0.25);
          const x = f.x + Math.cos(f.h) * along + f.rx * o, z = f.z + Math.sin(f.h) * along + f.rz * o;
          const y = heightAt(r, o) - 0.02;
          const face = Math.atan2(side * f.rz, -side * f.rx) + (hash(seed + i * 6.3) - 0.5) * 0.7; // toward the road
          const s = 0.92 + hash(seed + i * 5.3) * 0.16;
          const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), face), new THREE.Vector3(s, s, s));
          fans.push([m, SHIRTS[Math.floor(hash(seed + i * 7.7) * SHIRTS.length)], seed + i * 11.3]);
          const fl = hash(seed + i * 8.9);
          if (!this.fanModels) { if (fl < 0.16) flagsUA.push(m); else if (fl < 0.24) flagsTeam.push([m, SHIRTS[Math.floor(hash(seed + i * 9.1) * SHIRTS.length)]]); }
          else if (fl < 0.05) flagsUA.push(m); // the people carry their own; a few flags on poles stand among them
        }
      }
    }
    const M = this._crowdModels();
    if (fans.length && this.fanModels) {
      // people: a pose and outfit each, their own shirt, skin and hair
      const V = this.fanModels.variants, byV = V.map(() => []);
      const HAIR = ['#2a1d15', '#4a3426', '#7a5232', '#b88a52', '#d8c08c', '#1a1a1a', '#8a8a8a'];
      fans.forEach((f, i) => byV[Math.floor(hash(i * 3.3 + a0 * 0.71) * V.length)].push(f));
      byV.forEach((list, vi) => {
        if (!list.length) return;
        const src = V[vi], geo = new THREE.BufferGeometry();
        for (const [k, attr] of Object.entries(src.attributes)) geo.setAttribute(k, attr);
        geo.setIndex(src.index);
        geo.boundingSphere = src.boundingSphere;
        geo.userData.borrowed = true;
        const skin = new Float32Array(list.length * 3), hair = new Float32Array(list.length * 3);
        list.forEach(([, , seed], i) => {
          const sc = col(SKIN[Math.floor(hash(seed * 1.9) * SKIN.length)]), hc = col(HAIR[Math.floor(hash(seed * 2.7) * HAIR.length)]);
          skin.set([sc.r, sc.g, sc.b], i * 3); hair.set([hc.r, hc.g, hc.b], i * 3);
        });
        geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skin, 3));
        geo.setAttribute('aHair', new THREE.InstancedBufferAttribute(hair, 3));
        const im = new THREE.InstancedMesh(geo, this._fanMaterial(), list.length);
        list.forEach(([m, c], i) => { im.setMatrixAt(i, m); im.setColorAt(i, col(c)); });
        im.castShadow = true; im.frustumCulled = false;
        group.add(im);
      });
    } else if (fans.length) {
      const im = new THREE.InstancedMesh(M.body, M.mat, fans.length);
      fans.forEach(([m, c], i) => { im.setMatrixAt(i, m); im.setColorAt(i, col(c)); });
      im.castShadow = true; im.frustumCulled = false;
      group.add(im);
    }
    if (flagsUA.length) {
      const im = new THREE.InstancedMesh(M.flagUA, M.mat, flagsUA.length);
      flagsUA.forEach((m, i) => { im.setMatrixAt(i, m); im.setColorAt(i, col('#ffffff')); });
      im.frustumCulled = false;
      group.add(im);
    }
    if (flagsTeam.length) {
      const im = new THREE.InstancedMesh(M.flagTeam, M.mat, flagsTeam.length);
      flagsTeam.forEach(([m, c], i) => { im.setMatrixAt(i, m); im.setColorAt(i, col(c)); });
      im.frustumCulled = false;
      group.add(im);
    }
    // cheers painted on the asphalt on the way up
    // in the language of the interface (ALLEZ! is what every cycling fan shouts, in any language)
    const WORDS = lang === 'uk' ? ['ДАВАЙ!', 'ВПЕРЕД!', 'ТИСНИ!', 'ЖМИ!', 'ALLEZ!', 'ДО ВЕРШИНИ!'] : ['GO GO GO', 'COME ON!', 'PUSH!', 'ALLEZ!', 'HUP HUP', 'TO THE TOP!'];
    for (const top of tops) {
      for (const [k, back] of [[0, 25], [1, 60], [2, 100], [3, 145]].values()) {
        const d = top - back;
        if (d < D0 || d >= D1) continue;
        const word = WORDS[Math.floor(hash(top * 0.37 + k * 5.1) * WORDS.length)];
        group.add(this._roadWord(word, d, (k % 2 ? -1 : 1) * 1.7));
      }
    }
  }

  /** A word painted on the road at distance d, `lane` metres right of the centre, read as you ride up to it. */
  _roadWord(word, d, lane) {
    this.wordTex ||= new Map();
    let tex = this.wordTex.get(word);
    if (!tex) {
      const c = document.createElement('canvas'); c.width = 512; c.height = 160;
      const g = c.getContext('2d');
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.font = '900 118px system-ui, -apple-system, "Segoe UI", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(word, 256, 86, 490);
      tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      this.wordTex.set(word, tex);
    }
    // letters stretched along the road, as road paint is, so they read in perspective
    const geo = new THREE.PlaneGeometry(2.6, 2.2).rotateX(-Math.PI / 2).rotateY(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    const f = this.frame(d);
    mesh.position.set(f.x + f.rx * lane, this._roadY(d) + 0.055, f.z + f.rz * lane);
    mesh.rotation.y = -f.h;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Where the arches stand on this route, with their text and colour. */
  _arches() {
    if (this.archList?.route === this.route) return this.archList.list;
    const R = this.route, list = [];
    if (R.oneWay) { list.push({ d: 0, text: t('START'), color: '#f97316' }, { d: R.length, text: t('FINISH'), color: '#f97316', checker: true }); }
    else list.push({ d: 0, text: t('START · FINISH'), color: '#f97316', checker: true });
    for (const c of R.climbs || []) {
      list.push({ d: c.start, text: `⛰ ${c.name}`, color: '#dc2626' });
      list.push({ d: c.end, text: `${t('TOP')} · ${c.name}`, color: '#dc2626', checker: true });
    }
    for (const s of R.sprints || []) { // green, as in Zwift
      list.push({ d: s.start, text: `⚡ ${s.name}`, color: '#16a34a' });
      list.push({ d: s.start + s.length, text: `${t('SPRINT')} · ${t('LINE')}`, color: '#16a34a', checker: true });
    }
    this.archList = { route: R, list };
    return list;
  }

  /** An inflatable-style arch across the road at distance d, its banner facing the rider. */
  _arch(A, d) {
    const f = this.frame(d), g = new THREE.Group();
    const span = ROAD_HALF + 1.1, H = 5.6, color = col(A.color);
    const tube = new THREE.MeshLambertMaterial({ color });
    for (const z of [-span, span]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, H, 12), tube);
      post.position.set(0, H / 2, z);
      post.castShadow = true;
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.5, span * 2 + 1), tube);
    beam.position.set(0, H - 0.2, 0);
    beam.castShadow = true;
    g.add(beam);
    // the banner: both faces, each readable from its side
    const tex = this._bannerTexture(A.text, A.color, A.checker);
    for (const side of [-1, 1]) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(span * 2 + 0.6, 1.3), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      plane.position.set(side * 0.36, H - 0.2, 0);
      plane.rotation.y = side < 0 ? -Math.PI / 2 : Math.PI / 2;
      g.add(plane);
    }
    // a line painted across the asphalt under the arch: chequered at a finish or a top, the arch's colour at a start
    const line = new THREE.Mesh(new THREE.PlaneGeometry(A.checker ? 0.9 : 0.5, ROAD_HALF * 2 - 0.1), new THREE.MeshLambertMaterial({
      map: this._lineTexture(A.color, A.checker), polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.105, 0); // just over the asphalt (the road sits 5 cm above its centre line, the group 5 cm below)
    line.receiveShadow = true;
    g.add(line);
    g.position.set(f.x, this._roadY(d) - 0.05, f.z);
    g.rotation.y = -f.h;
    return g;
  }

  _lineTexture(color, checker) {
    this.lineTexCache ||= new Map();
    const key = `${color}|${checker}`;
    if (this.lineTexCache.has(key)) return this.lineTexCache.get(key);
    const c = document.createElement('canvas');
    c.width = 64; c.height = 512;
    const g = c.getContext('2d');
    if (checker) { // two rows of squares across the road
      const n = 16, sz = c.height / n;
      for (let i = 0; i < n; i++) for (let j = 0; j < 2; j++) { g.fillStyle = (i + j) % 2 ? '#15171c' : '#f4f4f2'; g.fillRect(j * 32, i * sz, 32, sz); }
    } else {
      g.fillStyle = color; g.fillRect(0, 0, 64, 512);
      g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(0, 0, 8, 512); g.fillRect(56, 0, 8, 512); // white edges
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.lineTexCache.set(key, tex);
    return tex;
  }

  /** "GRUPPETTO" along the down tube, on both sides (shared by every bike). */
  _frameDecal() {
    if (!this.decalMat) {
      const c = document.createElement('canvas');
      c.width = 1024; c.height = 128;
      const g = c.getContext('2d');
      g.font = 'italic 900 104px system-ui, -apple-system, "Segoe UI", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      // silver: a metallic gradient with a thin dark edge, readable on any frame colour
      const silver = g.createLinearGradient(0, 14, 0, c.height - 14);
      silver.addColorStop(0, '#f4f6f9'); silver.addColorStop(0.45, '#c3c9d1'); silver.addColorStop(0.55, '#9ea6b1'); silver.addColorStop(1, '#e1e5ea');
      g.lineWidth = 5; g.strokeStyle = 'rgba(20, 24, 30, 0.55)'; g.lineJoin = 'round';
      g.strokeText('GRUPPETTO', c.width / 2, c.height / 2 + 4, c.width - 40);
      g.fillStyle = silver;
      g.fillText('GRUPPETTO', c.width / 2, c.height / 2 + 4, c.width - 40);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      this.decalMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, toneMapped: false, side: THREE.DoubleSide });
      this.decalGeo = new THREE.PlaneGeometry(0.36, 0.048);
    }
    // the down tube's axis in the bike model (measured by rays, rider group): from (0.12, 0.448) to
    // (0.36, 0.722); its flat sides at z ≈ ±0.011
    const g = new THREE.Group();
    const a = new THREE.Vector2(0.12, 0.448), b = new THREE.Vector2(0.36, 0.722), mid = a.clone().add(b).multiplyScalar(0.5);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(this.decalGeo, this.decalMat);
      m.position.set(mid.x, mid.y, side * 0.016);
      m.rotation.set(0, side < 0 ? Math.PI : 0, side < 0 ? -ang : ang); // readable from each side, rising toward the front
      m.renderOrder = 3;
      g.add(m);
    }
    return g;
  }

  _bannerTexture(text, color, checker) {
    this.bannerCache ||= new Map();
    const key = `${text}|${color}|${checker}`;
    if (this.bannerCache.has(key)) return this.bannerCache.get(key);
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
    if (checker) { // a chequered strip at both ends, like a finish banner
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        g.fillStyle = (i + j) % 2 ? '#111' : '#fff';
        g.fillRect(i * 32, j * 32, 32, 32); g.fillRect(c.width - 128 + i * 32, j * 32, 32, 32);
      }
    }
    g.fillStyle = '#ffffff';
    g.font = '800 64px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text.toUpperCase(), c.width / 2, c.height / 2 + 3, c.width - (checker ? 300 : 60));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.bannerCache.set(key, tex);
    return tex;
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
    // the crowd's meshes are shared by every chunk (fans: each chunk's geometry borrows the baked attributes)
    if (this.crowdModels) for (const k of ['body', 'flagUA', 'flagTeam']) shared.add(this.crowdModels[k]);
    for (const k of ['wallGeom', 'portalGeom', 'lampGeom']) if (this[k]) shared.add(this[k]); // bridges' and tunnels' shared shapes
    group.traverse((o) => {
      if (o.geometry?.userData.borrowed) return; // its tiny per-fan colours go with the garbage collector
      if (o.geometry && !shared.has(o.geometry) && !this.natureKeep?.has(o.geometry)) o.geometry.dispose();
      if (o.isInstancedMesh) o.dispose();
    });
  }

  _updateChunks(dist) {
    const c = Math.floor(dist / SEG / CHUNK);
    for (const [k, g] of this.chunks) if (k < c - BEHIND || k > c + AHEAD) { this._dispose(g); this.chunks.delete(k); }
    // build the nearest missing chunk first, at most two per frame while riding
    let built = 0;
    const budget = this.warming ? Infinity : 2; // behind the loading screen: the whole stretch at once
    for (let k = c - BEHIND; k <= c + AHEAD && built < budget; k++) {
      if (!this.chunks.has(k)) { const g = this._buildChunk(k); this._csmMaterials(g); this.chunks.set(k, g); built++; }
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
    this.windTime.value += dt * (0.8 + (this.windSpeed || 0) * 0.06); // a stronger wind sways faster too
    if (this.crowdTime) this.crowdTime.value = this.clock;
    this._adaptQuality(dt);

    // riders
    const seen = new Set();
    let me = null;
    riders.forEach((r, i) => {
      const key = r.self ? `me:${r.color}:${r.stripe}:${r.bike || ''}` : r.name || i; // new colours -> new rider
      seen.add(key);
      let R = this.riders.get(key);
      if (!R) {
        const BIKE_COLORS = ['#2a2f3a', '#e8e8e8', '#1f5fd0', '#f0c020', '#2f8f4e'];
        const bikeColor = r.bike || (r.self ? '#c9302c' : BIKE_COLORS[(String(r.name || i).length + i) % BIKE_COLORS.length]);
        // no name tag for you, nor for your ghost (its gap rides over your head)
        R = new Rider3D(r.color, r.stripe || '#ff8a1f', r.self || (r.ghost && !r.climb) ? null : r.name, SHOW_RIDER && !this.riderModel, !this.bikeModel, bikeColor);
        this.riders.set(key, R);
        // contact shadow: a soft dark patch on the road under the bike, darkest under the tyres, so
        // the wheels sit on the asphalt instead of seeming to hover over it (the sun's shadow falls aside)
        const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 0.62), new THREE.MeshBasicMaterial({
          map: contactShadowTexture(), transparent: true, depthWrite: false, opacity: r.ghost ? 0.25 : 1, toneMapped: false, fog: true,
        }));
        blob.rotation.x = -Math.PI / 2;
        blob.position.set(0.08, 0.018, 0);
        blob.renderOrder = 1;
        R.group.add(blob);
        this.scene.add(R.group);
        if (this.riderModel) {
          const Model = this.riderModel.dummy ? DummyRider : ModelRider;
          R.model = new Model(this.riderModel, R.group, { jersey: r.color, stripe: r.stripe });
        }
        // the frame its own colour, or the jersey's
        if (this.bikeModel) { R.bike = new ModelBike(this.bikeModel, R.group, { color: r.bike || r.color }); R.group.add(this._frameDecal()); }
        // a ghost (your own earlier ride): see-through, and drawn after the solid scene
        if (r.ghost) {
          R.group.traverse((o) => {
            if (!o.material) return;
            o.material = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => {
              const c = m.clone(); c.transparent = true; c.opacity = Math.min(c.opacity ?? 1, 0.3); c.depthWrite = false; return c;
            });
            if (o.material.length === 1) o.material = o.material[0];
            o.castShadow = false;
            o.renderOrder = 2;
          });
        }
        if (R.model && R.bike) { R.model.bikeFit = R.bike.fit; R.model.bike = R.bike; } // saddle, hoods and pedals of this bike
        this._csmMaterials(R.group);
      }
      const d = r.dist;
      // phones draw riders within 150 m only: further up the road they are a few pixels, and each is ~110k triangles
      const visible = Math.abs(d - dist) < (LOW && !r.self ? 150 : CHUNK * SEG * AHEAD);
      // a ghost just behind you rides through the chase camera: hidden there (its gap is shown over your head)
      const inCamera = (r.ghost && this.camMode === 'chase' && d < dist - 0.8 && d > dist - 7) || (r.self && this.camMode === 'eyes'); // your own eyes: no you
      R.group.visible = visible && this.modelsReady && !inCamera;
      // name tags only for riders near you: far up the road they pile up into an unreadable stack
      if (R.labelSprite) R.labelSprite.visible = Math.abs(d - dist) < LABEL_RANGE;
      if (!visible) return;
      const f = this.frame(d);
      const lane = r.lane ?? 0;
      const slope = Math.atan((this._roadY(d + 2) - this._roadY(d - 2)) / 4);
      R.group.position.set(f.x + f.rx * lane, f.y + 0.035, f.z + f.rz * lane); // tyres pressed 1.5 cm into the road
      // face along the road as a chord over a few metres (no wobble from small kinks in a real track),
      // turned slightly toward a lane change in progress
      const fa = this.frame(d - 2.5), fb = this.frame(d + 2.5);
      const head = Math.atan2(fb.z - fa.z, fb.x - fa.x);
      // (a frame in which the ride did not step keeps the last turn instead of snapping straight)
      if (R.lastD !== undefined && d !== R.lastD) {
        const span = (now - R.lastMoveT) / 1000;
        const ds = (d - R.lastD) / span, dl = (lane - R.lastLane) / span;
        const yaw = Math.abs(ds) < 0.5 || Math.abs(ds) > 40 ? 0 : Math.atan2(dl, Math.max(2, ds));
        R.yaw = (R.yaw || 0) + (yaw - (R.yaw || 0)) * Math.min(1, span * 5);
        R.speed = Math.abs(ds) > 40 ? 0 : ds; // a jump along the road is not speed
      }
      // lean into a bend as a real rider does: tan(lean) = v² · curvature / g, eased, at most 20°
      const curv = (this.frame(d + 3).h - this.frame(d - 3).h) / 6;
      const leanTo = Math.max(-0.35, Math.min(0.35, Math.atan(((R.speed || 0) ** 2 * curv) / 9.81)));
      R.lean = (R.lean || 0) + (leanTo - (R.lean || 0)) * Math.min(1, dt * 4);
      if (R.lastD === undefined || d !== R.lastD) { R.lastD = d; R.lastLane = lane; R.lastMoveT = now; }
      R.group.rotation.set(LEAN_SIGN * R.lean, -(head + (R.yaw || 0)), slope, 'YXZ');
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
      if (r.self) me = { f, lane, R, head: head + (R.yaw || 0) };
    });
    for (const [k, R] of this.riders) if (!seen.has(k)) { this.scene.remove(R.group); this.riders.delete(k); }

    // chase camera
    if (me && this.camMode === 'iso') {
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
    } else if (me && (this.camMode === 'eyes' || this.camMode === 'front' || this.camMode === 'side')) {
      const ch = this._chaseH = this._chaseH === undefined || Math.abs(me.head - this._chaseH) > 1.5 ? me.head : this._chaseH + (me.head - this._chaseH) * Math.min(1, dt * 3.5);
      const px = me.f.x + me.f.rx * me.lane, pz = me.f.z + me.f.rz * me.lane, cx = Math.cos(ch), cz = Math.sin(ch);
      if (this.camMode === 'eyes') {
        // the rider's own eyes: just above the bars, looking down the road
        const ahead = this.frame(dist + 25);
        this.camera.position.set(px + cx * 0.25, me.f.y + 1.62, pz + cz * 0.25);
        this.camera.lookAt(px + cx * 25, ahead.y + 1.2, pz + cz * 25);
      } else if (this.camMode === 'side') {
        // over the shoulder: behind and to the left, the rider in the right of the picture, looking down the road
        const BACK = 5, LEFT = 1.9, ahead = this.frame(dist + 30);
        const lx = -me.f.rx * LEFT, lz = -me.f.rz * LEFT; // left of the rider (rx/rz points right)
        this.camera.position.set(px - cx * BACK + lx, this._roadY(dist - BACK) + 2.5, pz - cz * BACK + lz);
        this.camera.lookAt(px + cx * 30 + lx, ahead.y - 0.4, pz + cz * 30 + lz);
      } else {
        // a camera bike 6 m ahead, a little to the side, looking back at the rider
        const AHEAD = 6.5, front = this.frame(dist + AHEAD);
        this.camera.position.set(px + cx * AHEAD - me.f.rx * 1.2, front.y + 1.5, pz + cz * AHEAD - me.f.rz * 1.2);
        this.camera.lookAt(px, me.f.y + 1.0, pz);
      }
      this.camPos = this.camera.position.clone();
    } else if (me) {
      // behind the rider along the way it faces, a little late into a bend (as a following motorbike
      // would be), so the rider stays in the middle of the picture instead of sliding to the side
      const ch = this._chaseH = this._chaseH === undefined || Math.abs(me.head - this._chaseH) > 1.5 ? me.head : this._chaseH + (me.head - this._chaseH) * Math.min(1, dt * 3.5);
      const px = me.f.x + me.f.rx * me.lane, pz = me.f.z + me.f.rz * me.lane;
      const ahead = this.frame(dist + 9);
      const BACK = 3.3, UP = 1.85; // close behind, a little above the head
      const target = new THREE.Vector3(px - Math.cos(ch) * BACK - me.f.rx * me.lane * 0.2, this._roadY(dist - BACK) + UP, pz - Math.sin(ch) * BACK - me.f.rz * me.lane * 0.2);
      const look = new THREE.Vector3(px + Math.cos(ch) * 9 - me.f.rx * me.lane * 0.5, ahead.y + 0.75, pz + Math.sin(ch) * 9 - me.f.rz * me.lane * 0.5);
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
    if (me) this._speedFeel(dt, dist);
    if (me) {

      this.crowdNear?.value.set(me.f.x, me.f.y, me.f.z); // the fans go wild as you come by
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
      this.sunDirection.set(fx * 0.55 + fz * 0.62, this.atm?.sunY ?? 0.48, fz * 0.55 - fx * 0.62).normalize();
      this.csm.lightDirection.copy(this.sunDirection).negate();
      this.camera.updateMatrixWorld();
      this.csm.update();
      // the near cascade every frame, the middle one every 2nd, the far one every 4th: far shadows
      // change slowly, and each map is read with the matrix it was drawn with, so nothing slides
      const f = (this.shadowFrame = (this.shadowFrame || 0) + 1);
      this.csm.lights.forEach((l, i) => { if (f % [1, 2, 4][i] === 0) l.shadow.needsUpdate = true; });
      // the sky's glow sits on the sun's side
      this.sky.rotation.y = Math.atan2(-this.sunDirection.z, this.sunDirection.x);
      if ((this.csmTick = (this.csmTick || 0) + 1) % 20 === 0) this._csmMaterials(this.scene); // anything added since
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
      if (this.rain) {
        this.rain.position.set(cx, cy - 4, cz);
        const D = this.rainDrops, p = this.rain.geometry.attributes.position.array;
        // riding forward the rain seems to come at you: each streak leans back along the way you go
        const ride = Math.min(1.2, (dtDist && dt ? dtDist / dt : 0) / 9);
        for (let i = 0; i < D.y.length; i++) {
          let y = D.y[i] - D.speed[i] * dt;
          if (y < 0) y += 18;
          D.y[i] = y;
          const L = D.len[i], k = i * 6;
          p[k] = D.x[i]; p[k + 1] = y; p[k + 2] = D.z[i];
          p[k + 3] = D.x[i] + fx * L * ride; p[k + 4] = y + L; p[k + 5] = D.z[i] + fz * L * ride;
        }
        this.rain.geometry.attributes.position.needsUpdate = true;
      }
      // at night a lamp on your bars lights the road ahead
      if (this.atm?.night) {
        if (!this.headlight) {
          this.headlight = new THREE.SpotLight('#fff1d6', 60, 50, 0.42, 0.55, 1.4);
          this.headlight.position.set(0.75, 1.0, 0);
          this.headlight.target.position.set(14, 0, 0);
          this.headlight.add(new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: '#fffbe8', toneMapped: false })));
        }
        if (this.headlight.parent !== me.R.group) { me.R.group.add(this.headlight, this.headlight.target); }
      } else if (this.headlight?.parent) { this.headlight.parent.remove(this.headlight, this.headlight.target); }
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
    } else if (this.post) {
      this._renderPost();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    // where your rider's head is on screen (CSS px), for a tag over it: you have no name tag of your own
    if (me?.R) {
      const p = _headPt.set(0.45, 1.85, 0);
      me.R.group.localToWorld(p).project(this.camera);
      const el = this.renderer.domElement;
      this.selfScreen = { x: (p.x + 1) / 2 * el.clientWidth, y: (1 - p.y) / 2 * el.clientHeight, on: p.z < 1 && me.R.group.visible };
    } else this.selfScreen = null;
    if (this.warming) this._checkWarm(dist, me);
  }
}
const _headPt = new THREE.Vector3();

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}
