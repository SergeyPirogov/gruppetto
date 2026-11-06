// Real 3D renderer (three.js, WebGL) in a low-poly illustrated style.
// The world streams in 200 m chunks along the route: terrain with hills and valleys,
// road, scenery, fences, water, distant mountains and 3D riders. Same interface as the 2D Scene.
import * as THREE from '../vendor/three/three.module.min.js';
import { SEG } from './routes.js';
import { themeFor } from './themes.js';

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

const cyl = (rt, rb, h, s = 6) => new THREE.CylinderGeometry(rt, rb, h, s);
const cone = (r, h, s = 7) => new THREE.ConeGeometry(r, h, s);
const ico = (r, d = 0) => new THREE.IcosahedronGeometry(r, d);

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
    { geom: ico(2.6), color: p.oak.mid, pos: [0, 5.0, 0], jitter: 0.25 },
    { geom: ico(1.9), color: p.oak.dark, pos: [1.6, 4.3, 0.7], jitter: 0.25 },
    { geom: ico(2.0), color: p.oak.dark, pos: [-1.5, 4.5, -0.6], jitter: 0.25 },
    { geom: ico(1.6), color: p.oak.light, pos: [0.3, 6.6, 0.4], jitter: 0.25 },
  ]);
  M.birch = merge([
    { geom: cyl(0.14, 0.2, 7), color: '#efede6', pos: [0, 3.5, 0] },
    { geom: new THREE.BoxGeometry(0.42, 0.08, 0.42), color: '#2b2b2b', pos: [0, 2.0, 0] },
    { geom: new THREE.BoxGeometry(0.4, 0.07, 0.4), color: '#2b2b2b', pos: [0, 3.4, 0] },
    { geom: ico(1.5), color: p.birch.mid, pos: [0, 7.0, 0], jitter: 0.3 },
    { geom: ico(1.1), color: p.birch.dark, pos: [0.8, 6.0, 0.3], jitter: 0.3 },
    { geom: ico(1.0), color: p.birch.light, pos: [-0.6, 8.0, -0.2], jitter: 0.3 },
  ]);
  M.rock = merge([{ geom: new THREE.DodecahedronGeometry(1, 0), color: p.rock.base, pos: [0, 0.4, 0], scale: [1.4, 0.9, 1.1], jitter: 0.35 }]);
  M.bush = merge([
    { geom: ico(0.9), color: p.bush.mid, pos: [0, 0.6, 0], scale: [1.3, 0.8, 1.1], jitter: 0.3 },
    { geom: ico(0.7), color: p.bush.dark, pos: [0.7, 0.45, 0.2], jitter: 0.3 },
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
  M.tuft = merge([{ geom: cone(0.18, 0.5, 4), color: p.flowers.blades[0], pos: [0, 0.25, 0] }, { geom: cone(0.12, 0.4, 4), color: p.flowers.blades[1], pos: [0.12, 0.2, 0.05] }]);
  M.post = merge([{ geom: new THREE.BoxGeometry(0.13, 1.15, 0.13), color: '#ffffff', pos: [0, 0.575, 0] }]);
  M.rail = merge([{ geom: new THREE.BoxGeometry(1, 0.09, 0.06), color: '#ffffff' }]);
  return M;
}

// ---------- Rider ----------

const SKIN = '#e2a87a', SHORTS = '#202228', SOCK = '#f5f5f5', SHOE = '#1e1e22';

class Rider3D {
  constructor(jersey, stripe, label) {
    this.group = new THREE.Group();
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    this.mats = { frame: mat('#3a4a52'), tyre: mat('#1b1b1e'), jersey: mat(jersey), stripe: mat(stripe), skin: mat(SKIN), shorts: mat(SHORTS), sock: mat(SOCK), shoe: mat(SHOE), helmet: mat('#f4f4f4') };
    const add = (geom, m, pos, rot) => {
      const mesh = new THREE.Mesh(geom, m);
      if (pos) mesh.position.set(...pos);
      if (rot) mesh.rotation.set(...rot);
      mesh.castShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    for (const x of [-0.5, 0.5]) add(new THREE.TorusGeometry(0.33, 0.028, 6, 18), this.mats.tyre, [x, 0.34, 0]);
    const tube = (a, b, r, m) => this._link(add(cyl(r, r, 1, 5), m), new THREE.Vector3(...a), new THREE.Vector3(...b));
    tube([-0.5, 0.34, 0], [0, 0.3, 0], 0.02, this.mats.frame);
    tube([0, 0.3, 0], [-0.12, 0.95, 0], 0.025, this.mats.frame);
    tube([-0.5, 0.34, 0], [-0.12, 0.92, 0], 0.018, this.mats.frame);
    tube([0, 0.3, 0], [0.42, 0.9, 0], 0.028, this.mats.frame);
    tube([-0.12, 0.92, 0], [0.42, 0.92, 0], 0.024, this.mats.frame);
    tube([0.42, 0.9, 0], [0.5, 0.34, 0], 0.02, this.mats.frame);
    add(new THREE.BoxGeometry(0.26, 0.04, 0.1), this.mats.tyre, [-0.15, 1.0, 0]);
    add(cyl(0.018, 0.018, 0.44, 5), this.mats.tyre, [0.5, 1.0, 0], [Math.PI / 2, 0, 0]);
    // torso, stripe, head
    const torso = add(new THREE.BoxGeometry(0.62, 0.3, 0.36), this.mats.jersey);
    this._place(torso, new THREE.Vector3(-0.1, 1.06, 0), new THREE.Vector3(0.33, 1.42, 0), 'x');
    const band = add(new THREE.BoxGeometry(0.1, 0.31, 0.37), this.mats.stripe);
    this._place(band, new THREE.Vector3(0.06, 1.22, 0), new THREE.Vector3(0.14, 1.29, 0), 'x', true);
    add(new THREE.SphereGeometry(0.1, 8, 6), this.mats.skin, [0.45, 1.54, 0]);
    add(new THREE.SphereGeometry(0.13, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), this.mats.helmet, [0.44, 1.57, 0], [0, 0, -0.35]);
    add(new THREE.SphereGeometry(0.16, 8, 6), this.mats.shorts, [-0.13, 1.03, 0], null).scale.set(1, 0.7, 1.2);
    // arms
    for (const z of [-0.17, 0.17]) {
      tube([0.3, 1.4, z], [0.42, 1.18, z * 1.15], 0.045, this.mats.jersey);
      tube([0.42, 1.18, z * 1.15], [0.5, 1.0, z * 1.25], 0.038, this.mats.skin);
    }
    // legs (updated every frame)
    this.legs = [-1, 1].map((side) => ({
      side,
      thighS: add(cyl(0.07, 0.065, 1, 6), this.mats.shorts),
      thigh: add(cyl(0.062, 0.055, 1, 6), this.mats.skin),
      shin: add(cyl(0.05, 0.04, 1, 6), this.mats.skin),
      sock: add(cyl(0.042, 0.04, 1, 6), this.mats.sock),
      shoe: add(new THREE.BoxGeometry(0.22, 0.07, 0.08), this.mats.shoe),
    }));
    if (label) {
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
      sprite.position.set(0.2, 2.05, 0);
      this.group.add(sprite);
    }
    this.pose(0);
  }

  _link(mesh, a, b) {
    const d = new THREE.Vector3().subVectors(b, a);
    mesh.position.copy(a).addScaledVector(d, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    mesh.scale.set(1, d.length(), 1);
    return mesh;
  }

  _place(mesh, a, b, axis, keepLen) {
    const d = new THREE.Vector3().subVectors(b, a);
    mesh.position.copy(a).addScaledVector(d, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.clone().normalize());
    if (!keepLen) mesh.scale.set(d.length() / 0.62, 1, 1);
  }

  /** Pedalling pose: feet on the crank circle, knees by two-bone IK. */
  pose(angle) {
    const L1 = 0.45, L2 = 0.45;
    for (const leg of this.legs) {
      const a = angle + (leg.side > 0 ? 0 : Math.PI);
      const z = leg.side * 0.11;
      const hip = new THREE.Vector3(-0.13, 1.0, z);
      const foot = new THREE.Vector3(Math.cos(a) * 0.17, 0.3 + Math.sin(a) * 0.17, z);
      const d = Math.min(hip.distanceTo(foot), L1 + L2 - 0.001);
      const base = Math.atan2(foot.y - hip.y, foot.x - hip.x);
      const k = Math.acos((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d));
      const ka = base + k; // knee forward
      const knee = new THREE.Vector3(hip.x + Math.cos(ka) * L1, hip.y + Math.sin(ka) * L1, z);
      const mid = hip.clone().lerp(knee, 0.5);
      const sock = knee.clone().lerp(foot, 0.72);
      this._link(leg.thighS, hip, mid);
      this._link(leg.thigh, mid, knee);
      this._link(leg.shin, knee, sock);
      this._link(leg.sock, sock, foot);
      leg.shoe.position.set(foot.x + 0.04, foot.y - 0.02, z);
    }
  }
}

// ---------- Scene ----------

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.3, 4000);
    this.camPos = null;
    this.chunks = new Map();
    this.riders = new Map();
    this.routeId = null;
    this.clock = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  // ----- world setup per route -----

  _setup(route) {
    for (const c of this.chunks.values()) this._dispose(c);
    this.chunks.clear();
    for (const r of this.riders.values()) this.scene.remove(r.group);
    this.riders.clear();
    while (this.scene.children.length) this.scene.remove(this.scene.children[0]);

    this.route = route;
    this.routeId = route.id;
    this.t = themeFor(route.theme);
    this.t3 = T3[route.theme] || T3.meadow;
    this.models = buildModels(this.t);
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.path = { x: [], z: [], h: [] };
    this.minElev = route.minElev;

    const fogColor = rgb(this.t.fog);
    this.scene.fog = new THREE.Fog(fogColor, 150, 1500);
    this.scene.background = col(this.t.sky[1]);

    this.hemi = new THREE.HemisphereLight(col(this.t.sky[0]), rgb(this.t.grass[0]), 1.4);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(this.t.sun ? '#ffd8a8' : '#fff6e6', this.t.sun ? 1.6 : 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 400 });
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);

    this._sky();
    this._mountains();
    this._clouds();
    const sea = this.t.layers.find((l) => l.kind === 'sea');
    if (this.t3.dip) {
      this.water = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), new THREE.MeshPhongMaterial({ color: sea ? sea.color : '#3a8fc4', shininess: 80, specular: '#bfe8ff', transparent: true, opacity: 0.92 }));
      this.water.rotation.x = -Math.PI / 2;
      this.water.receiveShadow = true;
      this.scene.add(this.water);
    } else this.water = null;
    if (this.t.snowfall) this._snowfall(); else this.snow = null;
  }

  _sky() {
    const g = new THREE.SphereGeometry(3500, 24, 12);
    const top = col(this.t.sky[0]), bottom = col(this.t.sky[1]);
    const cs = [];
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = Math.max(0, Math.min(1, p.getY(i) / 1600));
      const c = bottom.clone().lerp(top, Math.pow(t, 0.7));
      cs.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3));
    this.sky = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
    if (this.t.sun) {
      const sunMesh = new THREE.Mesh(new THREE.CircleGeometry(110, 32), new THREE.MeshBasicMaterial({ color: this.t.sun.color, fog: false }));
      this.sunDisk = sunMesh;
      this.scene.add(sunMesh);
    } else this.sunDisk = null;
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
    const top = new THREE.MeshBasicMaterial({ color: '#ffffff', fog: false });
    const under = new THREE.MeshBasicMaterial({ color: '#d9e6f1', fog: false });
    const n = this.t.clouds * 3;
    for (let i = 0; i < n; i++) {
      const cl = new THREE.Group();
      const parts = 5 + Math.floor(hash(i * 2.2) * 4);
      for (let k = 0; k < parts; k++) {
        const r = 70 + Math.sin((k / (parts - 1)) * Math.PI) * 60 + hash(i * 7 + k) * 30;
        const x = (k - (parts - 1) / 2) * 85;
        const b = new THREE.Mesh(ico(r, 1), top);
        b.position.set(x, Math.sin((k / (parts - 1)) * Math.PI) * 45, (hash(i + k) - 0.5) * 60);
        b.scale.y = 0.65;
        const u = new THREE.Mesh(ico(r * 0.95, 1), under);
        u.position.set(x, b.position.y - r * 0.28, b.position.z);
        u.scale.set(1, 0.4, 1);
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
    tg = tg.toNonIndexed();
    tg.computeVertexNormals();
    const terrain = new THREE.Mesh(tg, this.mat);
    terrain.receiveShadow = true;
    group.add(terrain);

    // road ribbon + edge lines
    const ribbon = (o1, o2, lift, color) => {
      const p = [], cs = [];
      const cc = color instanceof THREE.Color ? color : col(color);
      for (let r = 0; r < rows - 1; r++) {
        const f1 = frames[r], f2 = frames[r + 1];
        const v = (f, o) => [f.x + f.rx * o, f.y + lift, f.z + f.rz * o];
        const A = v(f1, o1), B = v(f1, o2), C = v(f2, o1), D = v(f2, o2);
        p.push(...A, ...B, ...C, ...B, ...D, ...C);
        for (let k = 0; k < 6; k++) cs.push(cc.r, cc.g, cc.b);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, this.mat);
      m.receiveShadow = true;
      group.add(m);
    };
    ribbon(-ROAD_HALF - 0.6, ROAD_HALF + 0.6, 0.02, verge.clone().multiplyScalar(0.85));
    ribbon(-ROAD_HALF, ROAD_HALF, 0.05, rgb(T.road[0]));
    ribbon(-ROAD_HALF * 0.9 - 0.07, -ROAD_HALF * 0.9 + 0.07, 0.07, rgb(T.line));
    ribbon(ROAD_HALF * 0.9 - 0.07, ROAD_HALF * 0.9 + 0.07, 0.07, rgb(T.line));

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
        T.scenery.forEach((sc, j) => {
          const h = (k) => hash(idxN * 7.13 + side * 3.7 + (j * 4 + k) * 19.1);
          if (h(0) >= sc.prob) return;
          const o = side * (sc.off[0] + h(1) * (sc.off[1] - sc.off[0])) * ROAD_HALF;
          const along = h(3) * SEG;
          const ff = this.frame(a * SEG + along);
          const x = ff.x + ff.rx * o, z = ff.z + ff.rz * o, y = heightAt(r, o);
          if (sc.type === 'flowers') {
            for (let q = 0; q < 7; q++) flowers.push([x + (hash(a + q) - 0.5) * 2.5, y, z + (hash(a * 3 + q) - 0.5) * 2.5, flowerPalette[(q + j) % flowerPalette.length]]);
            put('tuft', mtx(x, y, z, h(2) * 6, 0.8 + h(2)));
          } else if (sc.type === 'sunflowers') {
            for (let q = 0; q < 5; q++) put('sunflowers', mtx(x + (hash(a * 5 + q) - 0.5) * 3, y, z + (hash(a * 7 + q) - 0.5) * 3, Math.PI + h(2) * 0.5, 0.9 + hash(q + a) * 0.25));
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
          put(tt, mtx(f.x + f.rx * o, y, f.z + f.rz * o, hq(4) * 6.28, 0.9 + hq(4) * 0.7));
        }
      }
    }
    for (const [type, list] of Object.entries(place)) {
      const geom = this.models[type];
      if (!geom || !list.length) continue;
      const im = new THREE.InstancedMesh(geom, this.mat, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = !['tuft', 'sunflowers'].includes(type);
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

  _dispose(group) {
    this.scene.remove(group);
    group.traverse((o) => { if (o.geometry && !Object.values(this.models || {}).includes(o.geometry)) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
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
    this.clock += 1 / 60;

    // riders
    const seen = new Set();
    let me = null;
    riders.forEach((r, i) => {
      const key = r.self ? 'me' : r.name || i;
      seen.add(key);
      let R = this.riders.get(key);
      if (!R) {
        R = new Rider3D(r.color, r.stripe || '#ff8a1f', r.self ? null : r.name);
        this.riders.set(key, R);
        this.scene.add(R.group);
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
      if (r.self) me = { f, lane };
    });
    for (const [k, R] of this.riders) if (!seen.has(k)) { this.scene.remove(R.group); this.riders.delete(k); }

    // chase camera
    if (me) {
      const back = this.frame(dist - 4.6);
      const target = new THREE.Vector3(back.x + back.rx * me.lane * 0.8, back.y + 1.95, back.z + back.rz * me.lane * 0.8);
      if (!this.camPos || target.distanceTo(this.camPos) > 30) this.camPos = target.clone();
      this.camPos.lerp(target, 0.12);
      this.camera.position.copy(this.camPos);
      const look = this.frame(dist + 8);
      this.camera.lookAt(look.x + look.rx * me.lane * 0.5, look.y + 1.05, look.z + look.rz * me.lane * 0.5);

      const cx = this.camera.position.x, cz = this.camera.position.z, cy = me.f.y;
      this.sky.position.set(cx, cy, cz);
      for (const ring of this.rings) ring.position.set(cx, cy - 40, cz);
      this.cloudGroup.position.set(cx, cy, cz);
      this.cloudGroup.rotation.y += 0.00002;
      this.sun.position.set(me.f.x - 70, me.f.y + 110, me.f.z + 50);
      this.sun.target.position.set(me.f.x, me.f.y, me.f.z);
      if (this.sunDisk) {
        const a = (this.t.sun.x - 0.5) * 2;
        this.sunDisk.position.set(cx + Math.cos(a) * 3000, cy + 260, cz + Math.sin(a) * 3000);
        this.sunDisk.lookAt(this.camera.position);
      }
      if (this.water) this.water.position.set(cx, me.f.y - 6, cz);
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
    this.renderer.render(this.scene, this.camera);
  }
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}
