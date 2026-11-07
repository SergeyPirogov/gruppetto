// The bike: a rigged model file at assets/bike/bike.glb (e.g. "Canyon Aeroad | Road Bike" by hipoojan
// on Sketchfab, Sketchfab Standard licence — not redistributed, see .gitignore), or, without it, the
// bike built in code (Rider3D in render3d.js). The model's skeleton has bones for the wheels, the
// chainring with the pedals and the handlebar; they are turned here every frame.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from '../vendor/three/addons/utils/SkeletonUtils.js';

const URL = 'assets/bike/bike.glb';
const BB = new THREE.Vector3(0, 0.29, 0); // bottom bracket in the rider group (render3d.js)
const WHEEL_R = 0.36;                     // m, tyre radius of the model

/** Loads the bike once; null when the file is missing. */
export async function loadBikeModel() {
  try {
    const head = await fetch(URL, { method: 'HEAD' });
    if (!head.ok) return null;
    return await new GLTFLoader().loadAsync(URL);
  } catch (e) {
    console.warn('Bike model not loaded, using the built-in bike', e);
    return null;
  }
}

const find = (root, re) => { let b = null; root.traverse((o) => { if (!b && o.isBone && re.test(o.name)) b = o; }); return b; };

// The model's greys, by lightness: white parts (bars, stem, seatpost, fork) become dark carbon, the
// mid grey of the wheels near-black rubber and carbon, the lighter grey metal stays a bit silvery.
const GREYS = [[0.9, 0.16], [0.55, 0.42], [0.35, 0.09], [0, 0.06]]; // [model lightness ≥, new lightness]

/** Paint colours are baked into the vertices: the saturated red is the frame paint, recoloured to `color`. */
function recolor(geometry, color) {
  const c = geometry.attributes.color;
  if (!c) return;
  const target = new THREE.Color(color), hsl = {}, tgt = {};
  target.getHSL(tgt);
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
  constructor(gltf, group, { color }) {
    this.group = group;
    this.root = SkeletonUtils.clone(gltf.scene);
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
      o.geometry = o.geometry.clone(); // own vertex colours per rider
      recolor(o.geometry, color);
      o.material = o.material.clone();
      o.material.vertexColors = true;
      o.material.metalness = 0.1;
      o.material.roughness = 0.55;
    });
    group.add(this.root);
    this.bones = {
      back: find(this.root, /back.?wheel/i),
      front: find(this.root, /front.?wheel/i),
      ring: find(this.root, /chain.?ring|crank/i),
      pedals: [find(this.root, /right.?ped/i), find(this.root, /left.?ped/i)].filter(Boolean),
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
    this._q = new THREE.Quaternion();
  }

  _turn(bone, angle) {
    const s = this.spin.get(bone);
    if (s) bone.quaternion.copy(s.rest).multiply(this._q.setFromAxisAngle(s.axis, angle));
  }

  /** Crank angle (radians, same convention as Rider3D.pose): forward pedalling turns clockwise seen from +z. */
  pose(angle) {
    const a = -angle;
    this._turn(this.bones.ring, a);
    for (const p of this.bones.pedals) this._turn(p, -a); // pedals stay level while the cranks turn
  }

  /** Distance ridden (m): the wheels roll forward. */
  roll(dist) {
    const a = -dist / WHEEL_R;
    this._turn(this.bones.back, a);
    this._turn(this.bones.front, a);
  }
}
