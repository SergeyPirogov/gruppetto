// Fans for the tops of climbs (#45): the bundled human model (Quaternius Universal Base Characters, CC0),
// posed (arms up, waving, clapping over the head) and baked into plain meshes, so a crowd of them can be
// drawn as instances. Each vertex keeps what it is (shirt, skin, hair, trousers, shoes) so every fan can
// wear their own colours, and how much it belongs to a raised arm so the shader can wave it.
import * as THREE from '../vendor/three/three.module.min.js';
import { gltfLoader } from './gltf.js';

/** Vertex parts: 0 its own colour (trousers, shoes, eyes), 1 shirt, 2 skin, 3 hair. */
export const PART = { own: 0, shirt: 1, skin: 2, hair: 3 };

/** Pose per variant: how far each arm is raised (degrees above horizontal) and its elbow bend. */
const POSES = [
  { name: 'arms-up', l: 58, r: 58, el: 18, er: 18, wave: [1, 1] },
  { name: 'one-arm', l: 72, r: -78, el: 25, er: 4, wave: [1, 0] },
  { name: 'clap-overhead', l: 80, r: 80, el: 42, er: 42, wave: [0.5, 0.5] },
];

/** Trousers: jeans or shorts (legs below the knee then show skin). */
const OUTFITS = [
  { name: 'jeans', trousers: '#2f4766', shins: 'trousers', shoes: '#e8e6e1' },
  { name: 'shorts', trousers: '#3b3f46', shins: 'skin', shoes: '#25272b' },
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

/**
 * Bakes every pose × outfit into a BufferGeometry: position, normal, color, aPart (see PART) and aArm
 * (−1…1: how much the vertex follows the left (−) or right (+) raised arm). Facing +x, feet at y = 0,
 * about 1.8 m tall. Returns { variants: [geometry…], shoulder: { y, z } } or null without the model.
 */
export async function loadFanModels(url = 'assets/rider/rider.gltf') {
  const gltf = await gltfLoader().loadAsync(url);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  const body = meshes.find((m) => m.geometry.attributes.position.count > 3000);
  if (!body) return null;
  const bones = Object.fromEntries(body.skeleton.bones.map((b) => [b.name, b]));
  const rest = body.skeleton.bones.map((b) => b.quaternion.clone());
  const shoulder = new THREE.Vector3();
  bones.upperarm_l.getWorldPosition(shoulder);
  const head = new THREE.Vector3();
  bones.Head.getWorldPosition(head);
  const Z = new THREE.Vector3(0, 0, 1);
  const variants = [];
  for (const pose of POSES) {
    body.skeleton.bones.forEach((b, i) => b.quaternion.copy(rest[i]));
    root.updateMatrixWorld(true);
    // the model stands in a T: the left arm along +x, the right along −x; turning round z raises them
    turnWorld(bones.upperarm_l, Z, pose.l);
    turnWorld(bones.lowerarm_l, Z, pose.el);
    turnWorld(bones.upperarm_r, Z, -pose.r);
    turnWorld(bones.lowerarm_r, Z, -pose.er);
    for (const outfit of OUTFITS) {
      const pos = [], colr = [], part = [], arm = [];
      for (const mesh of meshes) {
        const isBody = mesh === body, isBrow = /brow/i.test(mesh.name), isEye = /eye/i.test(mesh.name) && !isBrow;
        const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
        const P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
        const v = new THREE.Vector3(), acc = new THREE.Vector3(), tmp = new THREE.Vector3(), m = new THREE.Matrix4();
        const sk = mesh.skeleton;
        for (let i = 0; i < P.count; i++) {
          // linear blend skinning by hand (the geometry is unindexed here, so its own skin attributes)
          v.fromBufferAttribute(P, i).applyMatrix4(mesh.bindMatrix);
          acc.set(0, 0, 0);
          for (let k = 0; k < 4; k++) {
            const w = SW.getComponent(i, k);
            if (!w) continue;
            const bi = SI.getComponent(i, k);
            m.multiplyMatrices(sk.bones[bi].matrixWorld, sk.boneInverses[bi]);
            acc.addScaledVector(tmp.copy(v).applyMatrix4(m), w);
          }
          v.copy(acc).applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld);
          // facing +z → facing +x (left arm to −z)
          pos.push(v.z, v.y, -v.x);
          // the part this vertex belongs to: its heaviest bone
          let best = 0, bw = -1, armW = 0;
          for (let k = 0; k < 4; k++) {
            const w = SW.getComponent(i, k), name = mesh.skeleton.bones[SI.getComponent(i, k)].name;
            if (w > bw) { bw = w; best = SI.getComponent(i, k); }
            const side = /_l$/.test(name) ? -1 : /_r$/.test(name) ? 1 : 0;
            if (/^(upperarm|lowerarm|hand|index|middle|ring|pinky|thumb)/.test(name)) armW += side * w * (side < 0 ? pose.wave[0] : pose.wave[1]);
          }
          let p = isBody ? partOf(mesh.skeleton.bones[best].name, outfit) : isBrow ? 'hair' : 'eye';
          // short hair: the skin of the head above the brow and behind the ears
          if (p === 'skin' && /^Head/.test(mesh.skeleton.bones[best].name) && (v.y > head.y + 0.11 || (v.y > head.y + 0.02 && v.z < head.z - 0.05))) p = 'hair';
          const own = { trousers: outfit.trousers, shoes: outfit.shoes, eye: '#1d1d1f' }[p];
          const c = new THREE.Color(own || '#ffffff');
          colr.push(c.r, c.g, c.b);
          part.push(own ? PART.own : PART[p]);
          arm.push(isBody ? armW : 0);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
      geo.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
      geo.setAttribute('aArm', new THREE.Float32BufferAttribute(arm, 1));
      geo.setAttribute('aCloth', new THREE.Float32BufferAttribute(new Float32Array(part.length), 1));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      variants.push(geo);
    }
  }
  return { variants, shoulder: { y: shoulder.y, z: shoulder.x } };
}
