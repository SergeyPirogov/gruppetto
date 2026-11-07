// Optional bike model instead of the bike built in code (Rider3D in render3d.js). Two kinds:
//
// • Rigged, at assets/bike/bike.glb — e.g. "Canyon Aeroad | Road Bike" by hipoojan on Sketchfab
//   (Sketchfab Standard licence, not redistributed, see .gitignore). Its skeleton has bones for the
//   wheels, the chainring with the pedals and the handlebar, turned here every frame; the frame paint
//   baked into the vertex colours takes the rider's jersey colour.
// • Any static glTF at assets/bike.glb (e.g. a CC-BY model from Sketchfab): turned to face +x, scaled
//   to the built-in bike's size and set on the ground; a crank part, if it has one, spins with the
//   pedals. Fine-tune with assets/bike.json:
//     { "node": "Bike_02", "rotateY": 180, "length": 1.68, "offset": [0, 0, 0], "crankNode": "Cranks" }
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from '../vendor/three/addons/utils/SkeletonUtils.js';

const CANDIDATES = [
  { url: 'assets/bike/bike.glb', cfg: 'assets/bike/bike.json' },
  { url: 'assets/bike.glb', cfg: 'assets/bike.json' },
];
const DEFAULT_LENGTH = 1.68; // wheel to wheel, matches the built-in bike the rider is posed on
const BB = new THREE.Vector3(0, 0.29, 0); // bottom bracket in the rider group
const WHEEL_R = 0.36;                     // m, tyre radius of the rigged model

/** Loads the bike once: { gltf, cfg }, or null when there is no model file. */
export async function loadBikeModel() {
  for (const c of CANDIDATES) {
    try {
      const head = await fetch(c.url, { method: 'HEAD' });
      if (!head.ok) continue;
      let cfg = {};
      try { const r = await fetch(c.cfg); if (r.ok) cfg = await r.json(); } catch { /* optional */ }
      return { gltf: await new GLTFLoader().loadAsync(c.url), cfg };
    } catch (e) {
      console.warn(`Bike model ${c.url} not loaded`, e);
    }
  }
  return null;
}

const byName = (root, test) => {
  let found = null;
  root.traverse((o) => { if (!found && o.name && test(o.name)) found = o; });
  return found;
};
const bone = (root, re) => byName(root, (n) => re.test(n));

// The rigged model's greys, by lightness: white parts (bars, stem, seatpost, fork) become dark carbon,
// the mid grey of the wheels near-black rubber and carbon, the lighter grey metal stays a bit silvery.
const GREYS = [[0.9, 0.16], [0.55, 0.42], [0.35, 0.09], [0, 0.06]]; // [model lightness ≥, new lightness]

/** Paint colours are baked into the vertices: the saturated red is the frame paint, recoloured to `color`. */
function recolor(geometry, color) {
  const c = geometry.attributes.color;
  if (!c) return;
  const tgt = {}, hsl = {};
  new THREE.Color(color).getHSL(tgt);
  const v = new THREE.Color();
  for (let i = 0; i < c.count; i++) {
    v.setRGB(c.getX(i), c.getY(i), c.getZ(i));
    v.getHSL(hsl);
    if (hsl.s < 0.1) { // components
      const l = GREYS.find(([min]) => hsl.l >= min)[1];
      c.setXYZ(i, l, l, l * 1.04);
      continue;
    }
    if (hsl.s < 0.35 || (hsl.h > 0.06 && hsl.h < 0.94)) continue; // not the red paint
    // keep the model's light and shade: same lightness offset relative to its base red
    v.setHSL(tgt.h, tgt.s, Math.min(0.95, Math.max(0.05, tgt.l + (hsl.l - 0.575))));
    c.setXYZ(i, v.r, v.g, v.b);
  }
  c.needsUpdate = true;
}

export class ModelBike {
  /** `group` is the rider group (forward = +x, right = +z, road at y = 0). */
  constructor(model, group, { color } = {}) {
    const { gltf, cfg } = model;
    this.group = group;
    this._q = new THREE.Quaternion();
    const rigged = bone(gltf.scene, /back.?wheel/i) && bone(gltf.scene, /front.?wheel/i);
    if (rigged) this._rigged(gltf, group, color);
    else this._static(gltf, cfg, group);
    // where the rider sits and holds on (measured once per model, in the rider group's frame)
    this.fit = model.fit ||= this._measureFit(cfg);
  }

  /**
   * Saddle (middle of its top) and the wrist target behind the brake hoods, from the geometry:
   * the saddle is the highest part behind the bottom bracket, the hoods the highest parts out at the
   * bar ends. assets/bike(.json) "saddle": [x, y] / "hand": [x, y, z] override them.
   */
  _measureFit(cfg) {
    const g = this.group;
    g.updateMatrixWorld(true);
    const pts = [], v = new THREE.Vector3();
    (this.root || this.holder).traverse((o) => { // the bike only, not the rider in the same group
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i += 2) {
        if (o.isSkinnedMesh) o.getVertexPosition(i, v); else v.fromBufferAttribute(p, i);
        pts.push(g.worldToLocal(v.applyMatrix4(o.matrixWorld)).clone());
      }
    });
    const rear = pts.filter((p) => p.x < BB.x + 0.05 && p.y > 0.6);
    const top = rear.reduce((a, b) => (b.y > a.y ? b : a), rear[0] || new THREE.Vector3(-0.15, 1.03, 0));
    const seat = rear.filter((p) => p.y > top.y - 0.02);
    const sx = seat.length ? (Math.min(...seat.map((p) => p.x)) + Math.max(...seat.map((p) => p.x))) / 2 : -0.15;
    const bars = pts.filter((p) => p.x > 0.3 && p.y > 0.7 && Math.abs(p.z) > 0.14);
    const hoodTop = bars.reduce((a, b) => (b.y > a.y ? b : a), bars[0] || new THREE.Vector3(0.625, 0.95, 0.2));
    const hood = bars.filter((p) => p.y > hoodTop.y - 0.04);
    const hx = hood.length ? (Math.min(...hood.map((p) => p.x)) + Math.max(...hood.map((p) => p.x))) / 2 : 0.625;
    const hz = hood.length ? hood.reduce((n, p) => n + Math.abs(p.z), 0) / hood.length : 0.21;
    const fit = {
      saddle: new THREE.Vector2(sx, top.y),
      hand: new THREE.Vector3(hx - 0.08, hoodTop.y - 0.015, hz + 0.01),
    };
    if (cfg.saddle) fit.saddle.set(...cfg.saddle);
    if (cfg.hand) fit.hand.set(...cfg.hand);
    return fit;
  }

  // ----- rigged model: bones for the wheels, chainring + pedals, handlebar -----

  _rigged(gltf, group, color) {
    this.root = SkeletonUtils.clone(gltf.scene);
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
      o.geometry = o.geometry.clone(); // own vertex colours per rider
      if (color) recolor(o.geometry, color);
      o.material = o.material.clone();
      o.material.vertexColors = true;
      o.material.metalness = 0.1;
      o.material.roughness = 0.55;
    });
    group.add(this.root);
    this.bones = {
      back: bone(this.root, /back.?wheel/i),
      front: bone(this.root, /front.?wheel/i),
      ring: bone(this.root, /chain.?ring|crank/i),
      pedals: [bone(this.root, /right.?ped/i), bone(this.root, /left.?ped/i)].filter(Boolean),
    };
    // bottom bracket over ours, so the riders' pedalling and saddle positions still match
    group.updateMatrixWorld(true);
    if (this.bones.ring) {
      const bb = group.worldToLocal(this.bones.ring.getWorldPosition(new THREE.Vector3()));
      this.root.position.x += BB.x - bb.x;
      this.root.position.y += BB.y - bb.y;
    }
    group.updateMatrixWorld(true);
    // each spinning bone: its rest rotation and the bike's axle axis (group +z) in its own space
    const gq = group.getWorldQuaternion(new THREE.Quaternion()).invert();
    this.spin = new Map();
    for (const b of [this.bones.back, this.bones.front, this.bones.ring, ...this.bones.pedals]) {
      if (!b) continue;
      const rel = gq.clone().multiply(b.getWorldQuaternion(new THREE.Quaternion()));
      this.spin.set(b, { rest: b.quaternion.clone(), axis: new THREE.Vector3(0, 0, 1).applyQuaternion(rel.invert()).normalize() });
    }
  }

  _turn(b, angle) {
    const s = this.spin?.get(b);
    if (s) b.quaternion.copy(s.rest).multiply(this._q.setFromAxisAngle(s.axis, angle));
  }

  // ----- static model: scaled to the built-in bike, an optional crank part spins -----

  _static(gltf, cfg, group) {
    let src = gltf.scene;
    if (cfg.node) src = byName(gltf.scene, (n) => n === cfg.node) || src;
    const body = SkeletonUtils.clone(src);
    body.position.set(0, 0, 0);
    body.rotation.set(0, 0, 0);
    body.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

    // the bike's long horizontal axis becomes +x
    const holder = new THREE.Group();
    holder.add(body);
    body.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(body);
    const size = box.getSize(new THREE.Vector3());
    const alongZ = size.z > size.x;
    holder.rotation.y = THREE.MathUtils.degToRad(cfg.rotateY ?? (alongZ ? 90 : 0));
    const length = alongZ ? size.z : size.x;
    holder.scale.setScalar((cfg.length || DEFAULT_LENGTH) / (length || 1));
    holder.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(holder);
    const c = box.getCenter(new THREE.Vector3());
    const off = cfg.offset || [0, 0, 0];
    holder.position.set(-c.x + off[0], -box.min.y + off[1], -c.z + off[2]);
    group.add(holder);
    group.updateMatrixWorld(true);
    this.holder = holder;

    // spin the crank part around its own centre, about the bike's lateral axis
    const crank = byName(body, (n) => (cfg.crankNode ? n === cfg.crankNode : /crank|pedal/i.test(n)));
    if (crank && crank.parent) {
      crank.updateMatrixWorld(true);
      const parent = crank.parent;
      const centreWorld = new THREE.Box3().setFromObject(crank).getCenter(new THREE.Vector3());
      const centre = parent.worldToLocal(centreWorld.clone());
      const pivot = new THREE.Group();
      pivot.position.copy(centre);
      parent.add(pivot);
      pivot.attach(crank); // keeps the crank where it is, now hinged at its centre
      // lateral axis of the bike expressed in the pivot's parent space
      const lateralWorld = new THREE.Vector3(0, 0, 1).transformDirection(group.matrixWorld);
      const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
      this.axis = lateralWorld.transformDirection(inv).normalize();
      this.pivot = pivot;
    }
  }

  // ----- per frame -----

  /** Crank angle (radians, same convention as Rider3D.pose): forward pedalling turns clockwise seen from +z. */
  pose(angle) {
    if (this.pivot) { this.pivot.quaternion.setFromAxisAngle(this.axis, -angle); return; } // top pedal moves forward
    if (!this.bones) return;
    const a = -angle;
    this._turn(this.bones.ring, a);
    for (const p of this.bones.pedals) this._turn(p, -a); // pedals stay level while the cranks turn
  }

  /** Distance ridden (m): the wheels of a rigged model roll forward. */
  roll(dist) {
    if (!this.bones) return;
    const a = -dist / WHEEL_R;
    this._turn(this.bones.back, a);
    this._turn(this.bones.front, a);
  }
}
