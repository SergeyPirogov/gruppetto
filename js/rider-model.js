// Optional custom rider: any rigged humanoid glTF placed at assets/rider.glb.
// The character is seated on the bike and posed every frame with inverse kinematics
// (feet on the pedals, hands on the bars, torso leaning forward). If the file carries a
// cycling animation clip, that clip is played instead, its speed following cadence.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from '../vendor/three/addons/loaders/FBXLoader.js';
import * as SkeletonUtils from '../vendor/three/addons/utils/SkeletonUtils.js';

const URL_CFG = 'assets/rider.json';
// glTF, or FBX straight from Mixamo (embedded textures included) — no conversion needed.
const CANDIDATES = [
  { url: 'assets/rider.glb', load: async (u) => new GLTFLoader().loadAsync(u) },
  { url: 'assets/rider.fbx', load: async (u) => { const g = await new FBXLoader().loadAsync(u); return { scene: g, animations: g.animations || [] }; } },
];

/** Loads the model once; resolves to null when there is no custom rider. */
export async function loadRiderModel() {
  for (const c of CANDIDATES) {
    try {
      const head = await fetch(c.url, { method: 'HEAD' });
      if (!head.ok) continue;
      let cfg = {};
      try { const r = await fetch(URL_CFG); if (r.ok) cfg = await r.json(); } catch { /* optional */ }
      const gltf = await c.load(c.url);
      return { gltf, cfg };
    } catch (e) {
      console.warn(`Custom rider model ${c.url} not loaded`, e);
    }
  }
  return null;
}

// ---------- bone lookup ----------

const norm = (n) => n.toLowerCase().replace(/^mixamorig\d*[:_]?/, '').replace(/[\s:_.\-]/g, '');

/** Splits a bone name into side ('l' | 'r' | null) and a side-free core name. */
function parseName(name) {
  const raw = name.toLowerCase();
  let core = norm(name);
  if (/left/.test(raw)) return { side: 'l', core: core.replace('left', '') };
  if (/right/.test(raw)) return { side: 'r', core: core.replace('right', '') };
  if (/[._\- ]l$/.test(raw)) return { side: 'l', core: core.slice(0, -1) };
  if (/[._\- ]r$/.test(raw)) return { side: 'r', core: core.slice(0, -1) };
  // GLTFLoader strips '.' from names, so 'upperleg.l' arrives as 'upperlegl'
  const last = core.slice(-1), stem = core.slice(0, -1);
  if ((last === 'l' || last === 'r') && Object.values(PARTS).some((test) => test(stem))) return { side: last, core: stem };
  return { side: null, core };
}

const PARTS = {
  upperLeg: (c) => /upleg|upperleg|thigh/.test(c),
  lowerLeg: (c) => /lowerleg|shin|calf/.test(c) || c === 'leg',
  foot: (c) => /foot|ankle/.test(c),
  toes: (c) => /toe/.test(c),
  upperArm: (c) => /upperarm|uparm/.test(c) || c === 'arm',
  lowerArm: (c) => /forearm|lowerarm/.test(c),
  wrist: (c) => /wrist/.test(c),
  hand: (c) => c === 'hand',
};

export function findBones(root) {
  const bones = [];
  root.traverse((o) => { if (o.isBone) bones.push(o); });
  const B = { l: {}, r: {}, spine: [], hips: null, neck: null, head: null };
  for (const b of bones) {
    const { side, core } = parseName(b.name);
    if (side) {
      for (const [part, test] of Object.entries(PARTS)) if (!B[side][part] && test(core)) B[side][part] = b;
    } else if (/hips|pelvis/.test(core) && !B.hips) B.hips = b;
    else if (/spine|chest/.test(core)) B.spine.push(b);
    else if (/neck/.test(core) && !B.neck) B.neck = b;
    else if (/^head$/.test(core) && !B.head) B.head = b;
  }
  for (const s of ['l', 'r']) B[s].handJoint = B[s].wrist || B[s].hand;
  return B;
}

// ---------- posing helpers ----------

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();

/** Rotate `bone` so that `child` points at `target` (world space). */
function aim(bone, child, target) {
  if (!bone || !child) return;
  bone.getWorldPosition(_a);
  child.getWorldPosition(_b);
  const cur = _b.sub(_a).normalize();
  const want = target.clone().sub(_a).normalize();
  if (cur.lengthSq() < 1e-8 || want.lengthSq() < 1e-8) return;
  _q.setFromUnitVectors(cur, want);
  bone.getWorldQuaternion(_q2);
  const world = _q.multiply(_q2);
  bone.parent.getWorldQuaternion(_q3);
  bone.quaternion.copy(_q3.invert().multiply(world));
  bone.updateMatrixWorld(true);
}

/** Knee/elbow position for a two-bone chain, bending toward `bendDir`. */
function solveJoint(root, target, l1, l2, bendDir) {
  const d = Math.min(root.distanceTo(target), l1 + l2 - 1e-4);
  const dir = target.clone().sub(root).normalize();
  const a = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
  const perp = bendDir.clone().sub(dir.clone().multiplyScalar(bendDir.dot(dir))).normalize();
  return root.clone().addScaledVector(dir, Math.cos(a) * l1).addScaledVector(perp, Math.sin(a) * l1);
}

const wp = (o) => o.getWorldPosition(new THREE.Vector3());

/**
 * A custom character attached to a rider group (bike in local space, forward = +x, up = +y).
 * `group` must already be in the scene graph when pose() is called.
 */
export class ModelRider {
  constructor(model, group, { jersey, stripe }) {
    const { gltf, cfg } = model;
    this.group = group;
    this.root = SkeletonUtils.clone(gltf.scene);
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.frustumCulled = false; // skinned bounds don't follow IK poses
      const recolor = (m) => {
        const name = (m.name || '').toLowerCase();
        const isJersey = (cfg.jerseyMaterials || []).some((n) => n.toLowerCase() === name) || (!cfg.jerseyMaterials && /shirt|jersey|top|torso|upper|cloth/.test(name));
        const isShorts = (cfg.shortsMaterials || []).some((n) => n.toLowerCase() === name) || (!cfg.shortsMaterials && /pant|short|bottom|lower|trouser/.test(name));
        if (!isJersey && !isShorts) return m;
        const c = m.clone();
        c.color = new THREE.Color(isJersey ? jersey : '#1d1f26');
        if (isJersey && c.map) c.map = null;
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(recolor) : recolor(o.material);
    });

    // scale to a rider height
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.root);
    const h = box.max.y - box.min.y || 1;
    this.root.scale.setScalar((cfg.height || 1.75) / h);
    this.bones = findBones(this.root);
    // face +x: work out where the character looks from its hips (forward = up × (right − left))
    let rotY = Math.PI / 2;
    if (this.bones.l.upperLeg && this.bones.r.upperLeg) {
      this.root.updateMatrixWorld(true);
      const lr = wp(this.bones.r.upperLeg).sub(wp(this.bones.l.upperLeg));
      const f = new THREE.Vector3(0, 1, 0).cross(lr);
      if (f.lengthSq() > 1e-10) rotY = Math.atan2(f.z, f.x);
    }
    this.root.rotation.y = cfg.rotateY !== undefined ? THREE.MathUtils.degToRad(cfg.rotateY) : rotY;
    group.add(this.root);

    const clip = gltf.animations.find((a) => /cycl|bike|pedal|ride/i.test(a.name));
    if (clip) {
      this.mixer = new THREE.AnimationMixer(this.root);
      this.action = this.mixer.clipAction(clip);
      this.action.play();
      this.clipCadence = cfg.clipCadence || 90;
    }
    this.rest = new Map();
    this.root.traverse((o) => { if (o.isBone) this.rest.set(o, o.quaternion.clone()); });
    this.ok = !!(this.bones.hips && this.bones.l.upperLeg && this.bones.l.lowerLeg && this.bones.l.foot && this.bones.r.upperLeg);
    this._placed = false;
    if (typeof window !== 'undefined' && window.__debugRiders) window.__debugRiders.push(this);
  }

  _place() {
    // put the hips on the saddle
    this.group.updateMatrixWorld(true);
    const hips = this.group.worldToLocal(wp(this.bones.hips));
    this.root.position.add(new THREE.Vector3(-0.2 - hips.x, 1.04 - hips.y, -hips.z));
    this.group.updateMatrixWorld(true);
    const len = (a, b) => (a && b ? wp(a).distanceTo(wp(b)) : 0);
    this.len = {};
    for (const s of ['l', 'r']) {
      const B = this.bones[s];
      this.len[s] = { leg1: len(B.upperLeg, B.lowerLeg), leg2: len(B.lowerLeg, B.foot), arm1: len(B.upperArm, B.lowerArm), arm2: len(B.lowerArm, B.handJoint) };
    }
    this._placed = true;
  }

  pose(angle, dtSeconds = 0, cadence = 90) {
    this.group.updateMatrixWorld(true);
    if (this.mixer) {
      this.action.timeScale = cadence > 1 ? cadence / this.clipCadence : 0;
      this.mixer.update(dtSeconds);
      return;
    }
    if (!this.ok) return;
    for (const [bone, q] of this.rest) bone.quaternion.copy(q);
    this.root.updateMatrixWorld(true);
    if (!this._placed) this._place();
    const G = this.group;
    const L = (x, y, z) => G.localToWorld(new THREE.Vector3(x, y, z));
    const fwd = L(1, 0, 0).sub(L(0, 0, 0)).normalize();
    const up = L(0, 1, 0).sub(L(0, 0, 0)).normalize();
    const B = this.bones;

    // torso: lean toward the bars
    const spine = B.spine[0];
    const top = B.neck || B.head;
    if (spine && top) {
      const base = wp(spine);
      const torsoLen = base.distanceTo(wp(top));
      const lean = THREE.MathUtils.degToRad(42);
      aim(spine, top, base.clone().addScaledVector(fwd, Math.cos(lean) * torsoLen).addScaledVector(up, Math.sin(lean) * torsoLen));
    }
    // head: look up the road
    if (B.head) {
      B.head.rotateOnWorldAxis(L(0, 0, 1).sub(L(0, 0, 0)).normalize(), THREE.MathUtils.degToRad(32));
      B.head.updateMatrixWorld(true);
    }
    // legs: feet on the pedals, knees forward
    const sideOfBone = (b) => Math.sign(G.worldToLocal(wp(b)).z) || 1;
    for (const s of ['l', 'r']) {
      const side = sideOfBone(B[s].upperLeg);
      const a = angle + (side > 0 ? Math.PI : 0);
      const foot = L(Math.cos(a) * 0.17 - 0.02, 0.29 + Math.sin(a) * 0.17 + 0.08, side * 0.11);
      const hip = wp(B[s].upperLeg);
      const { leg1, leg2 } = this.len[s];
      const knee = solveJoint(hip, foot, leg1, leg2, fwd);
      aim(B[s].upperLeg, B[s].lowerLeg, knee);
      aim(B[s].lowerLeg, B[s].foot, foot);
      if (B[s].toes) aim(B[s].foot, B[s].toes, foot.clone().addScaledVector(fwd, 0.2).addScaledVector(up, -0.03));
    }
    // arms: hands on the hoods
    for (const s of ['l', 'r']) {
      const A = B[s];
      const side = A.upperArm ? sideOfBone(A.upperArm) : (s === 'l' ? -1 : 1);
      if (!A.upperArm || !A.lowerArm || !A.handJoint) continue;
      const hand = L(0.5, 0.99, side * 0.2);
      const sh = wp(A.upperArm);
      const { arm1, arm2 } = this.len[s];
      const out = L(0, 0, side).sub(L(0, 0, 0)).normalize();
      const elbow = solveJoint(sh, hand, arm1, arm2, out.multiplyScalar(0.6).addScaledVector(up, -0.8));
      aim(A.upperArm, A.lowerArm, elbow);
      aim(A.lowerArm, A.handJoint, hand);
    }
  }
}
