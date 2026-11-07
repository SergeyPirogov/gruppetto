// The rider character: a rigged humanoid file placed at assets/rider.glb or assets/rider.fbx
// (e.g. straight from Mixamo), or, when there is none, the rider built in code
// (rider-procedural.js). The character is seated on the bike and posed every frame with inverse
// kinematics (feet on the pedals, hands on the hoods, torso leaning forward). If a file carries a
// cycling animation clip, that clip is played instead, its speed following cadence.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from '../vendor/three/addons/loaders/FBXLoader.js';
import * as SkeletonUtils from '../vendor/three/addons/utils/SkeletonUtils.js';
import { buildProceduralRider } from './rider-procedural.js';

const URL_CFG = 'assets/rider.json';
// glTF, or FBX straight from Mixamo (embedded textures included) — no conversion needed.
const CANDIDATES = [
  { url: 'assets/rider.glb', load: async (u) => new GLTFLoader().loadAsync(u) },
  { url: 'assets/rider.fbx', load: async (u) => { const g = await new FBXLoader().loadAsync(u); return { scene: g, animations: g.animations || [] }; } },
  // bundled CC0 character (Quaternius Universal Base Characters, see tools/prepare_rider.py),
  // with its own settings next to it; assets/rider.json still overrides them
  { url: 'assets/rider/rider.gltf', cfg: 'assets/rider/rider.json', load: async (u) => new GLTFLoader().loadAsync(u) },
];

/**
 * Loads the rider once. A model file wins unless rider.json says "model": "procedural"; without a
 * file the rider built in code is used (its kit is already cycling kit, so no clothing edits).
 */
export async function loadRiderModel() {
  let cfg = {};
  try { const r = await fetch(URL_CFG); if (r.ok) cfg = await r.json(); } catch { /* optional */ }
  if (cfg.model !== 'procedural') {
    for (const c of CANDIDATES) {
      try {
        const head = await fetch(c.url, { method: 'HEAD' });
        if (!head.ok) continue;
        let own = {};
        if (c.cfg) try { const r = await fetch(c.cfg); if (r.ok) own = await r.json(); } catch { /* optional */ }
        return { gltf: await c.load(c.url), cfg: { ...own, ...cfg } };
      } catch (e) {
        console.warn(`Custom rider model ${c.url} not loaded`, e);
      }
    }
  }
  try {
    return { gltf: buildProceduralRider(cfg), cfg: { sockHeight: false, sleeve: false, armSlim: 1, height: 1.84, pelvisTilt: 62, hipsX: -0.25, hipsY: 1.075, ...cfg } };
  } catch (e) {
    console.warn('Procedural rider not built', e);
    return null;
  }
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
  toes: (c) => /toe|^ball$/.test(c), // Unreal-style skeletons call the toe joint 'ball'
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

/** Rotate `bone` by `angle` about a world-space `axis` (correct under rotated parents, unlike rotateOnWorldAxis). */
function rotateWorld(bone, axis, angle) {
  _q.setFromAxisAngle(axis, angle);
  bone.getWorldQuaternion(_q2);
  bone.parent.getWorldQuaternion(_q3);
  bone.quaternion.copy(_q3.invert().multiply(_q.multiply(_q2)));
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
 * The bone at the top of the skull (Mixamo: HeadTop_End). FBX rigs can also give the head a
 * zero-length child with the head's own name, so pick by name, else the farthest bone below the head.
 */
function findHeadTop(head, root) {
  if (!head) return null;
  const bones = [];
  head.traverse((o) => { if (o.isBone && o !== head) bones.push(o); });
  const named = bones.find((b) => /headtop|head_?end|top_?end/i.test(b.name));
  if (named) return named;
  const h = wp(head);
  let best = null, bestD = 1e-6;
  for (const b of bones) { const d = wp(b).distanceTo(h); if (d > bestD) { best = b; bestD = d; } }
  if (best || !root) return best;
  // Unreal-style skeletons end at the head bone: mark the crown at the highest vertex that follows it
  root.updateMatrixWorld(true);
  let top = null;
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isSkinnedMesh || /hair|eyelash|brow|eye/i.test(o.name)) return;
    const hi = o.skeleton.bones.indexOf(head);
    const { position, skinIndex, skinWeight } = o.geometry.attributes;
    if (hi < 0 || !skinIndex) return;
    for (let i = 0; i < position.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (skinIndex.getComponent(i, k) === hi) w += skinWeight.getComponent(i, k);
      if (w < 0.6) continue;
      o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld);
      if (!top || v.y > top.y) top = v.clone();
    }
  });
  if (!top) return null;
  const crown = new THREE.Object3D();
  crown.name = 'headTop';
  head.add(crown);
  crown.position.copy(head.worldToLocal(top));
  crown.updateMatrixWorld(true);
  return crown;
}

/**
 * Measures the skull from the skinned vertices that follow the head bone (hair excluded, it is hidden
 * under the helmet). Returns, in head-bone space: center, unit axes (forward, up, side) and the
 * half-extents of the skull along them. `forward`/`up` are world directions at rest pose.
 */
function measureHead(root, head, headTop, forward) {
  const headBones = new Set();
  head.traverse((o) => { if (o.isBone) headBones.add(o); });
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(head.matrixWorld).invert();
  const pts = [], v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isSkinnedMesh || /hair|eyelash|brow/i.test(o.name)) return;
    const idx = o.skeleton.bones.map((b) => headBones.has(b));
    const { position, skinIndex, skinWeight } = o.geometry.attributes;
    if (!skinIndex || !skinWeight) return;
    for (let i = 0; i < position.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (idx[skinIndex.getComponent(i, k)]) w += skinWeight.getComponent(i, k);
      if (w < 0.6) continue;
      o.getVertexPosition(i, v);
      pts.push(v.applyMatrix4(o.matrixWorld).applyMatrix4(inv).clone());
    }
  });
  if (pts.length < 50) return null;
  // axes in head-bone space: up toward the top of the skull, forward = the character's facing
  const qInv = head.getWorldQuaternion(new THREE.Quaternion()).invert();
  const up = wp(headTop).applyMatrix4(inv).normalize();
  const fwd = forward.clone().applyQuaternion(qInv);
  fwd.addScaledVector(up, -fwd.dot(up)).normalize();
  const side = new THREE.Vector3().crossVectors(fwd, up).normalize();
  const axes = [fwd, up, side];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) axes.forEach((ax, k) => { const d = p.dot(ax); lo[k] = Math.min(lo[k], d); hi[k] = Math.max(hi[k], d); });
  // ellipsoid of the cranium: front/back and sides from the full head, height from the brow up
  const center = new THREE.Vector3();
  axes.forEach((ax, k) => center.addScaledVector(ax, k === 1 ? hi[1] - (hi[1] - lo[1]) * 0.42 : (lo[k] + hi[k]) / 2));
  const half = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) * 0.42, (hi[2] - lo[2]) / 2];
  return { center, axes, half, height: hi[1] - lo[1] };
}

/**
 * Splits a skinned mesh's triangles exactly along boundary surfaces, then groups them by material.
 * `cuts` are signed-distance functions of a rest-pose world position (the boundary is where they
 * are 0); every triangle crossing one is cut in two along it, with new vertices interpolated on the
 * edges, so clothing edges are straight and leave no gaps. `classify(centroid, tri)` then picks each
 * triangle's material: 0 = the mesh's own, i > 0 = mats[i - 1]. Used to turn parts of clothing into
 * skin or trim where the model has no geometry of its own.
 */
function regroup(o, cuts, classify, mats) {
  if (Array.isArray(o.material)) return false;
  const src = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
  o.geometry = src; // getVertexPosition() below reads o.geometry by vertex number (glTF meshes are indexed)
  const names = Object.keys(src.attributes);
  const n = src.attributes.position.count;
  // per-vertex attribute tuples, plus the rest-pose world position used for cutting
  const verts = [];
  const tmp = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const v = { w: o.getVertexPosition(i, tmp).applyMatrix4(o.matrixWorld).clone(), a: {} };
    for (const nm of names) { const at = src.attributes[nm]; v.a[nm] = Array.from({ length: at.itemSize }, (_, k) => at.getComponent(i, k)); }
    verts.push(v);
  }
  const lerpV = (p, q, t) => {
    const v = { w: p.w.clone().lerp(q.w, t), a: {} };
    for (const nm of names) {
      v.a[nm] = /skin/i.test(nm) ? (t < 0.5 ? p.a[nm] : q.a[nm]).slice() // bone indices/weights can't be blended
        : p.a[nm].map((x, k) => x + (q.a[nm][k] - x) * t);
    }
    return v;
  };
  let tris = [];
  for (let i = 0; i < n; i += 3) tris.push([verts[i], verts[i + 1], verts[i + 2]]);
  for (const f of cuts) {
    const next = [];
    for (const tri of tris) {
      const d = tri.map((v) => f(v.w));
      const pos = d.map((x) => x > 0);
      if (pos[0] === pos[1] && pos[1] === pos[2]) { next.push(tri); continue; }
      // the vertex alone on its side, and the two others in winding order
      const lone = pos.filter(Boolean).length === 1 ? pos.indexOf(true) : pos.indexOf(false);
      const A = tri[lone], B = tri[(lone + 1) % 3], C = tri[(lone + 2) % 3];
      const dA = d[lone], dB = d[(lone + 1) % 3], dC = d[(lone + 2) % 3];
      const AB = lerpV(A, B, dA / (dA - dB)), AC = lerpV(A, C, dA / (dA - dC));
      next.push([A, AB, AC], [AB, B, C], [AB, C, AC]);
    }
    tris = next;
  }
  const buckets = mats.map(() => []).concat([[]]);
  for (const tri of tris) buckets[classify(tri[0].w.clone().add(tri[1].w).add(tri[2].w).divideScalar(3), tri)].push(tri);
  if (buckets.slice(1).every((x) => !x.length)) return false;
  const out = new THREE.BufferGeometry();
  const ordered = buckets.flat();
  for (const nm of names) {
    const at = src.attributes[nm], data = new at.array.constructor(ordered.length * 3 * at.itemSize);
    let k = 0;
    for (const tri of ordered) for (const v of tri) for (const x of v.a[nm]) data[k++] = x;
    out.setAttribute(nm, new THREE.BufferAttribute(data, at.itemSize, at.normalized));
  }
  let start = 0;
  buckets.forEach((list, i) => { if (list.length) out.addGroup(start, list.length * 3, i); start += list.length * 3; });
  o.geometry = out;
  o.material = [o.material, ...mats];
  return true;
}

/**
 * Cycling kit painted onto a bare base body: a jersey with short sleeves and an accent cuff, bib
 * shorts to above the knee, white socks and dark shoes. The body mesh is cut along planes across
 * the bones (sleeve ends, waist, short legs, sock tops, ankles), so the edges are clean, and each
 * part gets a plain material; the skin keeps the model's own textured material.
 * `sleeve`, `shorts` and `sock` are fractions along the upper arm, thigh and shin.
 */
function paintKit(root, bones, { jersey, stripe, sleeve, shorts, sock }) {
  const B = bones;
  const legs = ['l', 'r'].map((s) => B[s]).filter((L) => L.upperLeg && L.lowerLeg && L.foot);
  const arms = ['l', 'r'].map((s) => B[s]).filter((A) => A.upperArm && A.lowerArm);
  if (!B.hips || !B.neck || legs.length < 2) return false;
  root.updateMatrixWorld(true);
  const seg = (a, b) => { const S = wp(a), d = wp(b).sub(S); const len = d.length(); return { S, dir: d.divideScalar(len), len }; };
  const along = (g, p) => p.clone().sub(g.S).dot(g.dir);
  const off = (g, p) => { const t = along(g, p); return p.clone().sub(g.S).addScaledVector(g.dir, -t).length(); };
  const hem = 0.025;
  const A = arms.map((a) => seg(a.upperArm, a.lowerArm));
  const L = legs.map((l) => ({ thigh: seg(l.upperLeg, l.lowerLeg), shin: seg(l.lowerLeg, l.foot), ankleY: wp(l.foot).y + 0.015 }));
  const neckY = wp(B.neck).y + 0.035; // a round collar at the base of the neck, not a V down to the chest
  const waistY = wp(B.hips).y + 0.06; // the jersey overlaps the top of the bib shorts
  const cuts = [
    (p) => p.y - neckY,
    (p) => p.y - waistY,
    ...A.flatMap((g) => [(p) => along(g, p) - g.len * sleeve, (p) => along(g, p) - (g.len * sleeve - hem)]),
    ...L.flatMap((l) => [
      (p) => along(l.thigh, p) - l.thigh.len * shorts,
      (p) => along(l.shin, p) - l.shin.len * sock,
      (p) => p.y - l.ankleY,
    ]),
  ];
  const mat = (color, roughness = 0.6) => new THREE.MeshStandardMaterial({ color, roughness });
  const mats = [mat(jersey), mat(stripe || '#ff8a1f'), mat('#1d1f26', 0.7), mat('#f5f5f5', 0.8), mat('#22242a', 0.5)];
  const SKIN = 0, JERSEY = 1, CUFF = 2, SHORTS = 3, SOCK = 4, SHOE = 5;
  // Which limb a triangle belongs to comes from its skin weights (robust in any rest pose); where on
  // the limb, from its position along the bones.
  const subtree = (b) => { const set = new Set(); b?.traverse((x) => { if (x.isBone) set.add(x); }); return set; };
  const upper = arms.map((a) => { const all = subtree(a.upperArm), fore = subtree(a.lowerArm); return new Set([...all].filter((x) => !fore.has(x))); });
  const fore = arms.map((a) => subtree(a.lowerArm));
  const classifier = (o) => {
    const bones = o.skeleton.bones;
    const weightIn = (tri, set) => {
      let w = 0;
      for (const v of tri) for (let k = 0; k < 4; k++) if (v.a.skinWeight[k] > 0 && set.has(bones[v.a.skinIndex[k]])) w += v.a.skinWeight[k];
      return w / 3;
    };
    return (c, tri) => {
      if (c.y > neckY) return SKIN; // head and neck
      for (let i = 0; i < arms.length; i++) {
        if (weightIn(tri, fore[i]) > 0.5) return SKIN; // forearms, hands, fingers
        if (weightIn(tri, upper[i]) > 0.5) {
          const g = A[i], t = along(g, c);
          return t > g.len * sleeve ? SKIN : t > g.len * sleeve - hem ? CUFF : JERSEY;
        }
      }
      if (c.y > waistY) return JERSEY;
      // legs: the nearest one by distance to its thigh and shin axes
      const l = L.reduce((best, x) => (Math.min(off(x.thigh, c), off(x.shin, c)) < Math.min(off(best.thigh, c), off(best.shin, c)) ? x : best));
      if (along(l.thigh, c) < l.thigh.len * shorts) return SHORTS;
      if (c.y < l.ankleY) return SHOE;
      return along(l.shin, c) > l.shin.len * sock ? SOCK : SKIN;
    };
  };
  let done = false;
  root.traverse((o) => { if (o.isSkinnedMesh && !/eye|brow|hair|lash/i.test(o.name)) done = regroup(o, cuts, classifier(o), mats) || done; });
  return done;
}

/**
 * Cycling socks: knee-high sock meshes are cut down to `height` (0 = ankle, 1 = knee). The model has
 * no skin modelled under its socks, so the part above the cut is drawn with `skinMat` instead.
 */
function shortenSocks(root, bones, height, skinMat) {
  const foot = bones.l.foot, knee = bones.l.lowerLeg;
  if (!foot || !knee) return false;
  root.updateMatrixWorld(true);
  const footY = wp(foot).y, cutY = footY + (wp(knee).y - footY) * height;
  let done = false;
  root.traverse((o) => { if (o.isSkinnedMesh && /sock/i.test(o.name)) done = regroup(o, [(p) => p.y - cutY], (c) => (c.y > cutY ? 1 : 0), [skinMat]) || done; });
  return done;
}

/**
 * Cycling jersey from a long-sleeved top: short sleeves (the sleeve past `sleeve` of the upper arm
 * becomes skin — no arm is modelled under Mixamo sleeves) with an accent-coloured cuff.
 * Works in the rest (T-) pose, where each arm runs straight out from its shoulder.
 */
function makeJersey(root, bones, sleeve, skinMat, accentMat) {
  if (!bones.hips || !(bones.neck || bones.head)) return false;
  root.updateMatrixWorld(true);
  const arms = ['l', 'r'].map((sd) => bones[sd]).filter((A) => A.upperArm && A.lowerArm).map((A) => {
    const S = wp(A.upperArm), E = wp(A.lowerArm), dir = E.clone().sub(S);
    const len = dir.length();
    return { S, dir: dir.divideScalar(len), cut: len * sleeve };
  });
  let done = false;
  root.traverse((o) => {
    if (!o.isSkinnedMesh || !/shirt|jersey|sweater|hood|top|torso/i.test(o.name)) return;
    const hem = 0.022; // accent cuff at the end of each sleeve (m)
    const cuts = arms.flatMap((A) => [(p) => p.clone().sub(A.S).dot(A.dir) - A.cut, (p) => p.clone().sub(A.S).dot(A.dir) - (A.cut - hem)]);
    done = regroup(o, cuts, (c) => {
      for (const A of arms) {
        const along = c.clone().sub(A.S).dot(A.dir);
        if (along > A.cut) return 1;              // past the sleeve: bare arm
        if (along > A.cut - hem) return 2;        // sleeve cuff
      }
      return 0;
    }, [skinMat, accentMat]) || done;
  });
  return done;
}

/**
 * Slimmer arms: pulls the vertices that follow the upper-arm and forearm bones toward the bone
 * axis by `k` (1 = unchanged), on every skinned mesh alike so skin and sleeves stay matched.
 * Bulky Mixamo sleeves (sweaters, hoodies) otherwise look puffy with the arms forward.
 * Works in the rendered (skinned) rest pose and maps the shift back through each vertex's own
 * skinning transform: FBX parts carry their own skeletons with duplicate bones, so raw bind
 * matrices are not reliable. Bones are matched by name for the same reason. Clones share
 * geometry, so each geometry is changed only once.
 */
function slimArms(root, bones, k) {
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3(), p = new THREE.Vector3(), t = new THREE.Vector3(), sh = new THREE.Vector3();
  const S = new THREE.Matrix3(), Mk = new THREE.Matrix3();
  root.traverse((o) => {
    if (!o.isSkinnedMesh || o.geometry.userData.slimmedArms) return;
    const { position, skinIndex, skinWeight } = o.geometry.attributes;
    if (!skinIndex || !skinWeight) return;
    const sk = o.skeleton;
    // per-bone skinning matrix in mesh space, as the renderer applies it
    const M = sk.bones.map((bone, i) => new THREE.Matrix4().multiplyMatrices(o.bindMatrixInverse,
      new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, sk.boneInverses[i])).multiply(o.bindMatrix));
    // arm axes (mesh space) for every bone carrying an arm bone's name, duplicates included
    const seg = new Map();
    for (const sd of ['l', 'r']) {
      const B = bones[sd];
      for (const [from, to] of [[B.upperArm, B.lowerArm], [B.lowerArm, B.handJoint]]) {
        if (!from || !to) continue;
        const ax = { a: o.worldToLocal(wp(from)), b: o.worldToLocal(wp(to)) };
        sk.bones.forEach((bone, i) => { if (bone.name === from.name) seg.set(i, ax); });
      }
    }
    if (!seg.size) return;
    let moved = 0;
    for (let vi = 0; vi < position.count; vi++) {
      let wArm = 0;
      for (let c = 0; c < 4; c++) if (seg.has(skinIndex.getComponent(vi, c))) wArm += skinWeight.getComponent(vi, c);
      if (wArm <= 0) continue;
      v.fromBufferAttribute(position, vi);
      // skinned position and the blended linear part of the skinning transform
      p.set(0, 0, 0);
      S.set(0, 0, 0, 0, 0, 0, 0, 0, 0);
      for (let c = 0; c < 4; c++) {
        const w = skinWeight.getComponent(vi, c);
        if (!w) continue;
        const m4 = M[skinIndex.getComponent(vi, c)];
        p.addScaledVector(t.copy(v).applyMatrix4(m4), w);
        Mk.setFromMatrix4(m4);
        for (let e = 0; e < 9; e++) S.elements[e] += Mk.elements[e] * w;
      }
      sh.set(0, 0, 0);
      for (let c = 0; c < 4; c++) {
        const ax = seg.get(skinIndex.getComponent(vi, c));
        if (!ax) continue;
        const w = skinWeight.getComponent(vi, c), ab = t.copy(ax.b).sub(ax.a);
        const u = Math.max(0, Math.min(1, p.clone().sub(ax.a).dot(ab) / ab.lengthSq()));
        sh.add(ax.a.clone().addScaledVector(ab, u).sub(p).multiplyScalar((1 - k) * w));
      }
      if (sh.lengthSq() === 0 || Math.abs(S.determinant()) < 1e-12) continue;
      sh.applyMatrix3(S.clone().invert()); // back into geometry (bind) space
      position.setXYZ(vi, v.x + sh.x, v.y + sh.y, v.z + sh.z);
      moved++;
    }
    if (moved) position.needsUpdate = true; // keep the original (smooth) normals: the shift is small
    o.geometry.userData.slimmedArms = true;
  });
}

/** Average skin colour of the body texture around the calves; null until the texture has loaded. */
function sampleSkin(root, bones) {
  const knee = bones.l.lowerLeg, hip = bones.l.upperLeg;
  if (!knee || !hip) return null;
  root.updateMatrixWorld(true);
  const kneeY = wp(knee).y, hipY = wp(hip).y;
  let result = null;
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (result || !o.isSkinnedMesh || !/body/i.test(o.name)) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const img = mat?.map?.image;
    if (!img || !(img.width > 0) || (img.complete === false)) return;
    const uv = o.geometry.attributes.uv;
    if (!uv) return;
    const S = 256, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, S, S);
    const px = ctx.getImageData(0, 0, S, S).data;
    let r = 0, gg = 0, bb = 0, n = 0;
    // calf and lower-thigh skin: between the knee and a little above it
    const step = Math.max(1, Math.floor(uv.count / 20000));
    for (let i = 0; i < uv.count; i += step) {
      o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld);
      if (v.y > kneeY + (hipY - kneeY) * 0.25) continue;
      const x = Math.min(S - 1, Math.max(0, Math.floor(uv.getX(i) * S)));
      const y = Math.min(S - 1, Math.max(0, Math.floor((mat.map.flipY === false ? uv.getY(i) : 1 - uv.getY(i)) * S)));
      const k = (y * S + x) * 4;
      r += px[k]; gg += px[k + 1]; bb += px[k + 2]; n++;
    }
    if (n > 20) result = new THREE.Color().setRGB(r / n / 255, gg / n / 255, bb / n / 255, THREE.SRGBColorSpace).multiply(mat.color);
  });
  return result;
}

/**
 * Road helmet as a child of the head bone, sized to the measured skull: an elongated shell that
 * covers the forehead and dips lower at the back, dark vent channels running front to back and
 * a dark rim. Built on a unit sphere (+x forward, +y up, +z side) and scaled to the skull.
 */
function buildHelmet(fit, scale = 1, colors = {}) {
  // aero road helmet: smooth closed shell, a few wide intakes over the brow, a long tail that
  // tapers and drops toward the nape, exhaust ports at the back and a thin coloured side stripe
  const shellMat = new THREE.MeshStandardMaterial({ color: colors.shell || '#f2f3f5', roughness: 0.22, metalness: 0.15, side: THREE.DoubleSide });
  const accentMat = new THREE.MeshStandardMaterial({ color: colors.accent || '#16a0a8', roughness: 0.3, side: THREE.DoubleSide });
  const darkMat = new THREE.MeshStandardMaterial({ color: '#121418', roughness: 0.7, side: THREE.DoubleSide });
  const cut = Math.PI * 0.62; // how far down the shell reaches (from the crown)
  const unit = new THREE.Group();
  // sphere patch on the shell: phi around the vertical axis (phi = PI faces forward), theta down from the crown
  const patch = (r, phi0, phiLen, th0, thLen, mat) => unit.add(new THREE.Mesh(
    new THREE.SphereGeometry(r, Math.max(6, Math.ceil(phiLen * 16)), Math.max(3, Math.ceil(thLen * 12)), phi0, phiLen, th0, thLen), mat));
  unit.add(new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32, 0, Math.PI * 2, 0, cut), shellMat));
  patch(1.012, 0, Math.PI * 2, cut - 0.06, 0.06, darkMat); // rim
  for (const k of [-1.5, -0.5, 0.5, 1.5]) patch(1.008, Math.PI + k * 0.24 - 0.08, 0.16, cut - 0.62, 0.14, darkMat); // brow intakes, at the very front
  for (const k of [-1, 1]) patch(1.008, Math.PI + k * 0.3 - 0.06, 0.12, 0.3, 0.55, darkMat); // top channels
  for (const k of [-1, 0, 1]) patch(1.008, k * 0.42 - 0.1, 0.2, cut - 0.42, 0.1, darkMat); // rear exhaust ports
  for (const sd of [1, -1]) patch(1.006, Math.PI / 2 * sd - 0.9 + (sd < 0 ? Math.PI : 0), 1.8, cut - 0.62, 0.05, accentMat); // side stripes
  // aero shape: stretch the back into a tail that narrows and drops toward the nape, flatten the crown a little
  unit.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x < 0) {
        const t = -x; // 0 at the middle .. 1 at the back
        x *= 1.16;
        z *= 1 - 0.24 * t * t;
        y -= 0.34 * t * t;
      } else {
        x *= 0.97;
      }
      pos.setXYZ(i, x, y, z);
    }
    o.geometry.computeVertexNormals();
  });
  // unit sphere -> skull ellipsoid with a little padding; tilt so the back sits lower than the brow
  const [a, b, c] = fit.half;
  unit.scale.set(a * 1.12 * scale, b * 1.1 * scale, c * 1.12 * scale);
  unit.rotation.z = 0.42;
  unit.position.set(-a * 0.08, b * 0.14, 0); // front edge sits above the brows
  const helmet = new THREE.Group();
  helmet.add(unit);
  const [fx, uy, sz] = fit.axes;
  helmet.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(fx, uy, sz));
  helmet.position.copy(fit.center);
  helmet.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return helmet;
}

/**
 * Wraparound sport sunglasses for the measured head, in the same head-bone frame as the helmet:
 * one curved mirrored lens across the eyes, a thin top frame and temple arms back to the ears.
 */
function buildGlasses(fit, colors = {}) {
  const [a, , c] = fit.half, H = fit.height;
  const lensMat = new THREE.MeshStandardMaterial({ color: colors.lens || '#2b3a55', metalness: 0.85, roughness: 0.1, side: THREE.DoubleSide });
  const frameMat = new THREE.MeshStandardMaterial({ color: colors.frame || '#f2f3f5', roughness: 0.35 });
  const g = new THREE.Group();
  const r = c * 1.06;                    // wrap radius: a little wider than the face
  const cx = a - 0.02 * H - r;           // lens front just behind the tip of the nose
  const ey = -0.04 * H;                  // eye line relative to the skull centre
  const lensH = 0.14 * H, wrap = 1.1;    // lens height, half-angle of the wrap (rad)
  // CylinderGeometry: x = r·sinθ, z = r·cosθ, so θ = π/2 faces forward (+x)
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.97, lensH, 32, 1, true, Math.PI / 2 - wrap, wrap * 2), lensMat);
  lens.position.set(cx, ey, 0);
  g.add(lens);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.006, r * 1.006, lensH * 0.18, 32, 1, true, Math.PI / 2 - wrap, wrap * 2), frameMat);
  top.position.set(cx, ey + lensH * 0.41, 0); // along the top edge of the lens
  g.add(top);
  for (const sd of [-1, 1]) { // temple arms from the lens edge back toward the ears
    const ex = cx + r * Math.sin(Math.PI / 2 - wrap), ez = sd * r * Math.cos(Math.PI / 2 - wrap);
    const back = [-a * 0.15, ey + lensH * 0.3, sd * c * 1.02];
    const start = new THREE.Vector3(ex, ey + lensH * 0.4, ez), end = new THREE.Vector3(...back);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(start.distanceTo(end), lensH * 0.12, lensH * 0.05), frameMat);
    arm.position.copy(start).lerp(end, 0.5);
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), end.clone().sub(start).normalize());
    g.add(arm);
  }
  const [fx, uy, sz] = fit.axes;
  g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(fx, uy, sz));
  g.position.copy(fit.center);
  return g;
}

/**
 * A custom character attached to a rider group (bike in local space, forward = +x, up = +y).
 * `group` must already be in the scene graph when pose() is called.
 */
export class ModelRider {
  constructor(model, group, { jersey, stripe }) {
    const { gltf, cfg } = model;
    this.cfg = cfg;
    this.group = group;
    this.root = SkeletonUtils.clone(gltf.scene);
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.frustumCulled = false; // skinned bounds don't follow IK poses
      // Clothing is found by material name or by mesh name: Mixamo characters often share
      // one texture atlas between all clothes, but keep separate meshes (Ch08_Hoodie, Ch08_Pants).
      const meshName = (o.name || '').toLowerCase();
      const recolor = (m) => {
        const names = [(m.name || '').toLowerCase(), meshName];
        const listed = (list) => (list || []).some((n) => names.includes(n.toLowerCase()));
        const isJersey = listed(cfg.jerseyMaterials) || (!cfg.jerseyMaterials && names.some((n) => /shirt|jersey|hood|sweater|collar|top|torso|upper|cloth/.test(n)));
        const isShorts = listed(cfg.shortsMaterials) || (!cfg.shortsMaterials && names.some((n) => /pant|short|bottom|lower|trouser/.test(n)));
        if (!isJersey && !isShorts) return m;
        const c = m.clone();
        c.color = new THREE.Color(isJersey ? jersey : '#1d1f26');
        if (isJersey && c.map) c.map = null;
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(recolor) : recolor(o.material);
      // rider.json "vertexColors": false — some models keep shader masks in COLOR_0 (Quaternius),
      // which three.js would multiply into the texture and turn the skin black
      if (cfg.vertexColors === false) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.vertexColors = false;
        o.geometry.deleteAttribute('color');
      }
    });

    // scale to a rider height
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.root);
    const h = box.max.y - box.min.y || 1;
    this.root.scale.setScalar((cfg.height || 1.75) / h);
    this.bones = findBones(this.root);
    // longer arms ("armLength": 1 = as modelled): the elbow and wrist joints are moved out along the
    // bones and the skin stretches with them, so a short-armed character can reach the bars lower down
    if (cfg.armLength && cfg.armLength !== 1) {
      for (const sd of ['l', 'r']) for (const b of [this.bones[sd].lowerArm, this.bones[sd].handJoint]) b?.position.multiplyScalar(cfg.armLength);
      this.root.updateMatrixWorld(true);
    }
    // finger chains (index..pinky, not the thumb), each listed root-first, to curl around the hoods
    this.fingers = {};
    for (const sd of ['l', 'r']) {
      const hand = this.bones[sd].handJoint, list = [];
      hand?.traverse((o) => { if (o.isBone && o !== hand && /index|middle|ring|pinky/i.test(o.name) && o.position.lengthSq() > 1e-8) list.push(o); });
      this.fingers[sd] = list;
    }
    // each hand's rest frame in its own bone space: direction to the middle knuckle, and the palm
    // normal (Mixamo T-pose has the palms facing down)
    this.root.updateMatrixWorld(true);
    this.handRest = {};
    for (const sd of ['l', 'r']) {
      const hand = this.bones[sd].handJoint, mid = this.fingers[sd].find((b) => /middle0?1$/.test(parseName(b.name).core));
      if (!hand || !mid) continue;
      const qInv = hand.getWorldQuaternion(new THREE.Quaternion()).invert();
      const fL = wp(mid).sub(wp(hand)).applyQuaternion(qInv).normalize();
      const nL = new THREE.Vector3(0, -1, 0).applyQuaternion(qInv);
      nL.addScaledVector(fL, -nL.dot(fL)).normalize();
      this.handRest[sd] = { f: fL, n: nL };
    }
    // slimmer arms for bulky sleeves (rider.json "armSlim": 1 = unchanged, smaller = thinner)
    if ((cfg.armSlim ?? 0.8) < 1) slimArms(this.root, this.bones, cfg.armSlim ?? 0.8);
    // short cycling socks (rider.json: "sockHeight", 0 = ankle .. 1 = knee; false keeps the model's socks)
    // bare skin where clothing is cut down (colour sampled from the body texture once it loads)
    this.skinMat = new THREE.MeshStandardMaterial({ color: '#c08a68', roughness: 0.7 });
    let usesSkin = false;
    if (cfg.sockHeight !== false) usesSkin = shortenSocks(this.root, this.bones, cfg.sockHeight ?? 0.42, this.skinMat) || usesSkin;
    // cycling jersey: short sleeves with an accent cuff ("sleeve": 0..1 of the upper arm, false = keep)
    if (cfg.sleeve !== false) {
      const accent = new THREE.MeshStandardMaterial({ color: stripe || '#ff8a1f', roughness: 0.6 });
      usesSkin = makeJersey(this.root, this.bones, cfg.sleeve ?? 0.6, this.skinMat, accent) || usesSkin;
    }
    // a bare base body (no clothing meshes): paint the cycling kit onto it ("bodyKit": true)
    if (cfg.bodyKit) paintKit(this.root, this.bones, { jersey, stripe, sleeve: cfg.kitSleeve ?? 0.55, shorts: cfg.kitShorts ?? 0.78, sock: cfg.kitSock ?? 0.55 });
    if (!usesSkin) this.skinMat = null;
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

    // a cycling clip, but not exercise clips such as Mixamo's "Bicycle Crunch" (a floor exercise)
    const clip = gltf.animations.find((a) => /cycl|bike|pedal|ride/i.test(a.name) && !/crunch|sit.?up|exercise|kick/i.test(a.name));
    if (clip) {
      this.mixer = new THREE.AnimationMixer(this.root);
      this.action = this.mixer.clipAction(clip);
      this.action.play();
      this.clipCadence = cfg.clipCadence || 90;
    }
    // helmet: built to the measured skull and parented to the head bone, so it follows every pose;
    // the model's own hair is hidden so it can't poke through
    this.headTop = findHeadTop(this.bones.head, this.root);
    if (this.bones.head && this.headTop && cfg.helmet !== false) {
      const fwdWorld = new THREE.Vector3(1, 0, 0).applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion()));
      const fit = measureHead(this.root, this.bones.head, this.headTop, fwdWorld);
      if (fit) {
        this.bones.head.add(buildHelmet(fit, cfg.helmetScale || 1, { shell: cfg.helmetColor, accent: jersey }));
        if (cfg.glasses !== false) this.bones.head.add(buildGlasses(fit));
        this.root.traverse((o) => { if (o.isMesh && /hair/i.test(o.name)) o.visible = false; });
      }
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
    // The hips bone sits above the sit bones, so it goes a little below the saddle height
    // (saddle top ≈ 1.03) to seat the rider instead of leaving him standing on straight legs.
    this.root.position.add(new THREE.Vector3((this.cfg.hipsX ?? -0.2) - hips.x, (this.cfg.hipsY ?? 0.97) - hips.y, -hips.z)); // seated on the saddle, over the bottom bracket
    this.group.updateMatrixWorld(true);
    const len = (a, b) => (a && b ? wp(a).distanceTo(wp(b)) : 0);
    this.len = {};
    for (const s of ['l', 'r']) {
      const B = this.bones[s];
      this.len[s] = { leg1: len(B.upperLeg, B.lowerLeg), leg2: len(B.lowerLeg, B.foot), arm1: len(B.upperArm, B.lowerArm), arm2: len(B.lowerArm, B.handJoint), foot: len(B.foot, B.toes) || 0.14 };
    }
    this._placed = true;
  }

  pose(angle, dtSeconds = 0, cadence = 90) {
    if (this.skinMat && !this._skinDone && (this._skinTries = (this._skinTries || 0) + 1) % 30 === 1) {
      try {
        const c = sampleSkin(this.root, this.bones);
        if (c) { this.skinMat.color.copy(c); this._skinDone = true; }
      } catch { this._skinDone = true; } // e.g. a tainted canvas: keep the default skin tone
      if (this._skinTries > 600) this._skinDone = true;
    }
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

    const dirAt = (deg) => fwd.clone().multiplyScalar(Math.cos(THREE.MathUtils.degToRad(deg)))
      .addScaledVector(up, Math.sin(THREE.MathUtils.degToRad(deg)));
    // pelvis: rolled forward so the lower back leans too (otherwise it stays vertical and the
    // rider looks upright however low the upper back goes)
    const spine = B.spine[0];
    if (spine) {
      const base = wp(B.hips);
      aim(B.hips, spine, base.clone().addScaledVector(dirAt(this.cfg.pelvisTilt ?? 48), base.distanceTo(wp(spine))));
    }
    // torso: lean toward the bars
    const top = B.neck || B.head;
    if (spine && top) {
      const base = wp(spine);
      const torsoLen = base.distanceTo(wp(top));
      const lean = THREE.MathUtils.degToRad(this.cfg.torsoLean ?? 28); // spine-to-neck angle above horizontal: race position on the hoods
      aim(spine, top, base.clone().addScaledVector(fwd, Math.cos(lean) * torsoLen).addScaledVector(up, Math.sin(lean) * torsoLen));
    }
    // neck and head: aim them in world space (rotateOnWorldAxis is wrong here, it assumes an
    // unrotated parent and would roll the head sideways). The neck rises more steeply than the
    // torso, and the top of the head points up and slightly forward, so the face looks up the road.
    if (B.neck && B.head) {
      const base = wp(B.neck);
      aim(B.neck, B.head, base.clone().addScaledVector(dirAt(this.cfg.neckAngle ?? 52), base.distanceTo(wp(B.head))));
    }
    const headTop = this.headTop;
    if (B.head && headTop) {
      const base = wp(B.head);
      aim(B.head, headTop, base.clone().addScaledVector(dirAt(this.cfg.headAngle ?? 70), base.distanceTo(wp(headTop))));
    }
    // legs: feet on the pedals, knees forward
    const sideOfBone = (b) => Math.sign(G.worldToLocal(wp(b)).z) || 1;
    for (const s of ['l', 'r']) {
      const side = sideOfBone(B[s].upperLeg);
      // forward = +x, so the crank turns clockwise seen from the +z side: the top foot moves forward
      const a = -angle + (side > 0 ? 0 : Math.PI); // same phase as the bike's cranks in render3d
      // the ball of the foot (toe-base joint) sits over the pedal spindle, the sole on the pedal;
      // the ankle is a foot length behind it, the foot pointing slightly down toward the toes
      const pedal = L(Math.cos(a) * 0.17, 0.29 + Math.sin(a) * 0.17, side * 0.105); // feet over the pedals, hip-width apart
      const toeDir = fwd.clone().multiplyScalar(0.2).addScaledVector(up, -0.035).normalize();
      const ball = pedal.clone().addScaledVector(up, 0.035);
      const { leg1, leg2, foot: footLen } = this.len[s];
      const foot = ball.clone().addScaledVector(toeDir, -footLen);
      const hip = wp(B[s].upperLeg);
      const knee = solveJoint(hip, foot, leg1, leg2, fwd);
      aim(B[s].upperLeg, B[s].lowerLeg, knee);
      aim(B[s].lowerLeg, B[s].foot, foot);
      if (B[s].toes) aim(B[s].foot, B[s].toes, ball);
    }
    // arms: hands on the hoods
    for (const s of ['l', 'r']) {
      const A = B[s];
      const side = A.upperArm ? sideOfBone(A.upperArm) : (s === 'l' ? -1 : 1);
      if (!A.upperArm || !A.lowerArm || !A.handJoint) continue;
      // shoulders rolled forward and in, as on a road bike: aim the collarbone so the shoulder
      // joint moves toward the bars, which also narrows the silhouette seen from behind
      const clav = A.upperArm.parent;
      if (clav?.isBone && clav !== B.neck && !B.spine.includes(clav)) {
        const c0 = wp(clav), cl = c0.distanceTo(wp(A.upperArm));
        const outDir = L(0, 0, side).sub(L(0, 0, 0)).normalize();
        const C = this.cfg.clavicle || {}; // rider.json "clavicle": {"out", "fwd", "up"} — where the shoulders go
        aim(clav, A.upperArm, c0.clone().addScaledVector(outDir.multiplyScalar(C.out ?? 0.72).addScaledVector(fwd, C.fwd ?? 0.5).addScaledVector(up, C.up ?? -0.1).normalize(), cl));
      }
      // wrist behind the hoods so the palm rests on them and the knuckles sit at their front (render3d: hoods x ≈ 0.61)
      const hand = L(0.545, 0.97, side * 0.225); // palm faces in, so the hand sits just outside the hood
      const sh = wp(A.upperArm);
      const { arm1, arm2 } = this.len[s];
      const out = L(0, 0, side).sub(L(0, 0, 0)).normalize();
      // elbows point back and down, only slightly out: relaxed, close to the body
      const elbow = solveJoint(sh, hand, arm1, arm2, out.multiplyScalar(-0.08).addScaledVector(up, -0.6).addScaledVector(fwd, -0.55));
      aim(A.upperArm, A.lowerArm, elbow);
      aim(A.lowerArm, A.handJoint, hand);
      // hand on the hood: set the whole hand orientation, not just its direction — knuckles forward and a
      // little down and in, palm facing inward and down (a hoods grip) — then curl the fingers toward the palm
      const R = this.handRest?.[s];
      if (R) {
        const out2 = L(0, 0, side).sub(L(0, 0, 0)).normalize();
        const f = fwd.clone().addScaledVector(up, -0.25).addScaledVector(out2, -0.1).normalize();
        const n = up.clone().multiplyScalar(-0.5).addScaledVector(out2, -0.85);
        n.addScaledVector(f, -n.dot(f)).normalize();
        const world = new THREE.Matrix4().makeBasis(f, n, new THREE.Vector3().crossVectors(f, n));
        const local = new THREE.Matrix4().makeBasis(R.f, R.n, new THREE.Vector3().crossVectors(R.f, R.n));
        const qWorld = new THREE.Quaternion().setFromRotationMatrix(world).multiply(new THREE.Quaternion().setFromRotationMatrix(local).invert());
        A.handJoint.parent.getWorldQuaternion(_q3);
        A.handJoint.quaternion.copy(_q3.invert().multiply(qWorld));
        A.handJoint.updateMatrixWorld(true);
        const axis = new THREE.Vector3().crossVectors(f, n).normalize(); // rotating about f×n turns f toward n
        for (const b of this.fingers[s]) {
          const k = parseName(b.name).core; // 'index2' (Mixamo) or 'index02' (Unreal-style)
          const joint = /1$/.test(k) ? 0.85 : /2$/.test(k) ? 1.0 : /3$/.test(k) ? 0.6 : 0;
          if (joint) rotateWorld(b, axis, joint);
        }
      }
    }
  }
}
