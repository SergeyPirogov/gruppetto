// Fans for the tops of climbs (#45): Quaternius' Universal Base Characters (CC0), a man and a woman,
// posed (arms up, waving, clapping over the head, fists pumping) and baked into plain meshes, so a crowd
// of them can be drawn as instances. Their muscles are smoothed away under a T-shirt and trousers, and
// they get real hair. Each vertex keeps what it is (shirt, skin, hair, trousers, shoes) so every fan
// wears their own colours, and how much it follows a raised arm so the shader can wave it.
import * as THREE from '../vendor/three/three.module.min.js';
import { gltfLoader } from './gltf.js';

/** Vertex parts: 0 its own colour (trousers, shoes, eyes), 1 shirt, 2 skin, 3 hair. */
export const PART = { own: 0, shirt: 1, skin: 2, hair: 3 };

/** Pose per variant: each arm raised (degrees above horizontal) and its elbow bend; how much each arm waves. */
const POSES = [
  { l: 58, r: 58, el: 18, er: 18, wave: [1, 1] },          // both arms up
  { l: 72, r: -80, el: 25, er: 6, wave: [1, 0] },          // one arm waving, the other down
  { l: 82, r: 82, el: 44, er: 44, wave: [0.6, 0.6] },      // clapping over the head
  { l: 8, r: 8, el: 105, er: 105, wave: [0.8, 0.8] },      // fists up, elbows bent
];

const BODIES = [
  { url: 'assets/rider/rider.gltf', hair: [['hair_buzzed', 'brows_male'], ['hair_parted', 'beard', 'brows_male']] },
  { url: 'assets/fans/female.gltf', hair: [['hair_long', 'brows_female'], ['hair_buns', 'brows_female']] },
];

const OUTFITS = [
  { trousers: '#2f4766', shins: 'trousers', shoes: '#e8e6e1' }, // jeans, white trainers
  { trousers: '#3b3f46', shins: 'skin', shoes: '#25272b' },     // shorts
];

const q = new THREE.Quaternion(), wq = new THREE.Quaternion(), pq = new THREE.Quaternion();
/** Turn a bone (and everything below it) by `deg` round a world axis. */
function turnWorld(bone, axis, deg) {
  bone.updateWorldMatrix(true, false);
  bone.getWorldQuaternion(wq);
  bone.parent.getWorldQuaternion(pq);
  q.setFromAxisAngle(axis, THREE.MathUtils.degToRad(deg)).multiply(wq);
  bone.quaternion.copy(pq.invert().multiply(q));
  bone.updateMatrixWorld(true);
}

/** Which part a bone dresses, by its name. */
function partOf(name, outfit) {
  if (/^(spine|clavicle|upperarm)/.test(name)) return 'shirt';
  if (/^(neck|Head|lowerarm|hand|index|middle|ring|pinky|thumb)/.test(name)) return 'skin';
  if (/^(pelvis|thigh)/.test(name)) return 'trousers';
  if (/^calf/.test(name)) return outfit.shins;
  if (/^(foot|ball)/.test(name)) return 'shoes';
  return 'shirt';
}

/** Skinned positions of a mesh in the pose its skeleton has now (world space), one per vertex. */
function skinned(mesh) {
  const g = mesh.geometry, P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
  const out = new Float32Array(P.count * 3), v = new THREE.Vector3(), acc = new THREE.Vector3(), tmp = new THREE.Vector3(), m = new THREE.Matrix4();
  const sk = mesh.skeleton;
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i).applyMatrix4(mesh.bindMatrix);
    acc.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = SW.getComponent(i, k);
      if (!w) continue;
      const bi = SI.getComponent(i, k);
      m.multiplyMatrices(sk.bones[bi].matrixWorld, sk.boneInverses[bi]);
      acc.addScaledVector(tmp.copy(v).applyMatrix4(m), w);
    }
    acc.applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld);
    out.set([acc.x, acc.y, acc.z], i * 3);
  }
  return out;
}

/**
 * Smooths the clothed vertices (a few rounds of moving each towards its neighbours) and puffs them out a
 * little: the sculpted muscles go, a T-shirt and trousers stay. Vertices at the same place (UV seams) move
 * together, so no cracks open.
 */
function dress(pos, index, clothed, rounds = 8, puff = 0.012) {
  const n = pos.length / 3, key = new Map(), weld = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos[i * 3] * 2e3)},${Math.round(pos[i * 3 + 1] * 2e3)},${Math.round(pos[i * 3 + 2] * 2e3)}`;
    if (!key.has(k)) key.set(k, key.size);
    weld[i] = key.get(k);
  }
  const m = key.size, nb = Array.from({ length: m }, () => new Set());
  for (let t = 0; t < index.length; t += 3) {
    const a = weld[index[t]], b = weld[index[t + 1]], c = weld[index[t + 2]];
    nb[a].add(b).add(c); nb[b].add(a).add(c); nb[c].add(a).add(b);
  }
  const P = new Float32Array(m * 3), cl = new Uint8Array(m);
  for (let i = 0; i < n; i++) { P.set(pos.subarray(i * 3, i * 3 + 3), weld[i] * 3); if (clothed[i]) cl[weld[i]] = 1; }
  for (let r = 0; r < rounds; r++) {
    const next = P.slice();
    for (let w = 0; w < m; w++) {
      if (!cl[w] || !nb[w].size) continue;
      let x = 0, y = 0, z = 0;
      for (const o of nb[w]) { x += P[o * 3]; y += P[o * 3 + 1]; z += P[o * 3 + 2]; }
      const s = 1 / nb[w].size;
      next[w * 3] = P[w * 3] * 0.4 + x * s * 0.6; next[w * 3 + 1] = P[w * 3 + 1] * 0.4 + y * s * 0.6; next[w * 3 + 2] = P[w * 3 + 2] * 0.4 + z * s * 0.6;
    }
    P.set(next);
  }
  // puff out along the smoothed normals: loose cloth over the body
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  const wi = new Uint32Array(index.length);
  for (let t = 0; t < index.length; t++) wi[t] = weld[index[t]];
  geo.setIndex(new THREE.BufferAttribute(wi, 1));
  geo.computeVertexNormals();
  const N = geo.attributes.normal.array;
  for (let i = 0; i < n; i++) {
    const w = weld[i];
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = P[w * 3 + k] + (cl[w] ? N[w * 3 + k] * puff : 0);
  }
}

/**
 * Bakes every body × pose × outfit × hairstyle into an indexed BufferGeometry: position, normal, color,
 * aPart (see PART) and aArm (−1…1: how much the vertex follows the left (−) or right (+) arm). Facing +x,
 * feet at y = 0, about 1.8 m tall. Returns { variants: [geometry…], shoulder: { y, z } } or null.
 */
export async function loadFanModels() {
  const loader = gltfLoader();
  const hairNames = [...new Set(BODIES.flatMap((b) => b.hair.flat()))];
  const [bodies, hairs] = await Promise.all([
    Promise.all(BODIES.map((b) => loader.loadAsync(b.url))),
    Promise.all(hairNames.map((h) => loader.loadAsync(`assets/fans/${h}.gltf`).catch(() => null))),
  ]);
  const hairMesh = {};
  hairNames.forEach((h, i) => {
    const sc = hairs[i]?.scene;
    if (!sc) return;
    sc.updateMatrixWorld(true);
    const parts = [];
    sc.traverse((o) => { if (o.isMesh) parts.push(o); });
    hairMesh[h] = parts;
  });
  const variants = [];
  let shoulder = null;
  const Z = new THREE.Vector3(0, 0, 1);
  BODIES.forEach((B, bi) => {
    const root = bodies[bi].scene;
    root.updateMatrixWorld(true);
    const meshes = [];
    root.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
    const body = meshes.find((mm) => mm.geometry.attributes.position.count > 3000);
    if (!body) return;
    const extras = meshes.filter((mm) => mm !== body && /eye/i.test(mm.name) && !/brow/i.test(mm.name)); // the eyes; brows come with the hair
    const bones = Object.fromEntries(body.skeleton.bones.map((b) => [b.name, b]));
    const rest = body.skeleton.bones.map((b) => b.quaternion.clone());
    if (!shoulder) { const s = new THREE.Vector3(); bones.upperarm_l.getWorldPosition(s); shoulder = { y: s.y, z: s.x }; }
    for (const pose of POSES) {
      body.skeleton.bones.forEach((b, i) => b.quaternion.copy(rest[i]));
      root.updateMatrixWorld(true);
      // the model stands in a T: the left arm along +x, the right along −x; turning round z raises them
      turnWorld(bones.upperarm_l, Z, pose.l);
      turnWorld(bones.lowerarm_l, Z, pose.el);
      turnWorld(bones.upperarm_r, Z, -pose.r);
      turnWorld(bones.lowerarm_r, Z, -pose.er);
      const bodyPos = skinned(body);
      const eyePos = extras.map(skinned);
      for (const outfit of OUTFITS) {
        // body: parts and arm weights per vertex, then the clothes smoothed
        const g = body.geometry, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, n = g.attributes.position.count;
        const parts = new Array(n), arm = new Float32Array(n), clothed = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          let best = 0, bw = -1, a = 0;
          for (let k = 0; k < 4; k++) {
            const w = SW.getComponent(i, k), b = body.skeleton.bones[SI.getComponent(i, k)].name;
            if (w > bw) { bw = w; best = b; }
            const side = /_l$/.test(b) ? -1 : /_r$/.test(b) ? 1 : 0;
            if (/^(upperarm|lowerarm|hand|index|middle|ring|pinky|thumb)/.test(b)) a += side * w * (side < 0 ? pose.wave[0] : pose.wave[1]);
          }
          parts[i] = partOf(best, outfit);
          arm[i] = a;
          clothed[i] = parts[i] === 'shirt' || parts[i] === 'trousers' ? 1 : 0;
        }
        const pos = bodyPos.slice();
        dress(pos, g.index.array, clothed);
        for (const hair of B.hair) {
          const P = [], C = [], A = [], R = [], I = [];
          const add = (positions, index, partFn, armFn = () => 0) => {
            const base = P.length / 3;
            for (let i = 0; i < positions.length / 3; i++) {
              const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
              P.push(z, y, -x); // facing +z → facing +x (the left arm to −z)
              const p = partFn(i);
              const own = { trousers: outfit.trousers, shoes: outfit.shoes, eye: '#1d1d1f' }[p];
              const c = new THREE.Color(own || '#ffffff');
              C.push(c.r, c.g, c.b);
              R.push(own ? PART.own : PART[p]);
              A.push(armFn(i));
            }
            for (let t = 0; t < index.length; t++) I.push(base + index[t]);
          };
          add(pos, g.index.array, (i) => parts[i], (i) => arm[i]);
          extras.forEach((e, k) => add(eyePos[k], e.geometry.index.array, () => 'eye'));
          for (const h of hair) {
            for (const mesh of hairMesh[h] || []) {
              const hp = mesh.geometry.attributes.position, wp = new Float32Array(hp.count * 3), v = new THREE.Vector3();
              for (let i = 0; i < hp.count; i++) { v.fromBufferAttribute(hp, i).applyMatrix4(mesh.matrixWorld); wp.set([v.x, v.y, v.z], i * 3); }
              const idx = mesh.geometry.index ? mesh.geometry.index.array : Array.from({ length: hp.count }, (_, i) => i);
              add(wp, idx, () => 'hair');
            }
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
          geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
          geo.setAttribute('aPart', new THREE.Float32BufferAttribute(R, 1));
          geo.setAttribute('aArm', new THREE.Float32BufferAttribute(A, 1));
          geo.setIndex(I);
          geo.computeVertexNormals();
          geo.computeBoundingSphere();
          variants.push(geo);
        }
      }
    }
  });
  return variants.length ? { variants, shoulder } : null;
}
