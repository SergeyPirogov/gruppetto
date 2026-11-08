// The rider as a jointed mannequin: rigid parts (torso, head, upper arms, forearms, hands, thighs,
// shins, feet) turned around ball joints, like a wooden artist's model. Nothing bends or stretches,
// so shoulders, elbows and knees keep their shape in any pose. The parts come from
// assets/rider/dummy.gltf (made by tools/prepare_dummy.py), already split into kit materials and
// seated in a riding position; here the mannequin is scaled to the bike, its hips put on the saddle,
// the torso tilted, the hands brought to the hoods and the feet kept on the turning pedals.
import * as THREE from 'three';
import { gltfLoader } from './gltf.js';
import { mergeVertices } from '../vendor/three/addons/utils/BufferGeometryUtils.js';
import { buildModernHelmet } from './helmet.js';

const URL = 'assets/rider/dummy.gltf';
const CFG_URL = 'assets/rider/dummy.json'; // optional fine-tuning, see assets/README.md
const HEAD_URL = 'assets/rider/head.glb';   // optional head with face, helmet and glasses (tools/prepare_head.py)
const SADDLE0 = new THREE.Vector2(-0.15, 1.03);           // built-in bike, when there is no bike model
const HAND0 = new THREE.Vector3(0.545, 0.97, 0.225);
const BB = new THREE.Vector2(0, 0.29);                     // bottom bracket in the rider group
const CRANK = 0.17;
const KIT = { glove: '#1b1d22', cuff: '#2b2f36', skin: '#d49a72', shorts: '#1d1f24', sock: '#f2f2f2', shoe: '#f3f4f6', sole: '#dfe2e6', hair: '#2a2018' };

/** Loads assets/rider/dummy.gltf once: { dummy: gltf, cfg }, or null when it is missing. */
export async function loadDummyRider() {
  try {
    const head = await fetch(URL, { method: 'HEAD' });
    if (!head.ok) return null;
    let cfg = {};
    try { const r = await fetch(CFG_URL); if (r.ok) cfg = await r.json(); } catch { /* optional */ }
    let headModel = null;
    try { if ((await fetch(HEAD_URL, { method: 'HEAD' })).ok) headModel = await gltfLoader().loadAsync(HEAD_URL); } catch (e) { console.warn('Rider head not loaded', e); }
    return { dummy: await gltfLoader().loadAsync(URL), head: headModel, cfg };
  } catch (e) {
    console.warn('Dummy rider not loaded', e);
    return null;
  }
}

const v3 = (a) => new THREE.Vector3(...a);
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _v = new THREE.Vector3();

/** Rotation taking the frame (d0 along, n0 across) onto (d, n). */
function frameRotation(d0, n0, d, n, out = new THREE.Quaternion()) {
  const basis = (m, a, b) => {
    const x = a.clone().normalize();
    const y = b.clone().addScaledVector(x, -b.dot(x)).normalize();
    return m.makeBasis(x, y, new THREE.Vector3().crossVectors(x, y));
  };
  basis(_m1, d0, n0);
  basis(_m2, d, n);
  return out.setFromRotationMatrix(_m2.multiply(_m1.transpose()));
}

/** Two-bone IK: the middle joint for root a, end target t, bone lengths l1, l2, bending toward pole. */
function middleJoint(a, t, l1, l2, pole) {
  const at = t.clone().sub(a);
  const d = THREE.MathUtils.clamp(at.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const u = at.normalize();
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const p = pole.clone().addScaledVector(u, -pole.dot(u)).normalize();
  return a.clone().addScaledVector(u, x).addScaledVector(p, h);
}

/**
 * The downloaded mannequin has small holes (a missing triangle shows the inside of the limb as a pale
 * sliver) and doubled faces (dark slits): drop the duplicates and patch every hole of up to 6 edges,
 * facing the same way as the skin around it. The big openings where parts meet stay open.
 */
function repairMesh(g) {
  const idx = Array.from(g.index.array), tris = [], seen = new Set();
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue; // collapsed by the merge
    const key = [...tri].sort((a, b) => a - b).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    tris.push(tri);
  }
  // one winding for all: flip any triangle that runs a shared edge the same way as its neighbour
  // (a flipped face lights up from inside: the pale slivers), then turn each piece to face outward
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const byEdge = new Map();
  tris.forEach(([a, b, c], f) => { for (const [u, v] of [[a, b], [b, c], [c, a]]) (byEdge.get(key(u, v)) || byEdge.set(key(u, v), []).get(key(u, v))).push(f); });
  const runs = (f, u, v) => { const t = tris[f]; return (t[0] === u && t[1] === v) || (t[1] === u && t[2] === v) || (t[2] === u && t[0] === v); };
  const done = new Uint8Array(tris.length), P = g.attributes.position, pieces = [];
  for (let f0 = 0; f0 < tris.length; f0++) {
    if (done[f0]) continue;
    const piece = [f0]; done[f0] = 1;
    for (let q = 0; q < piece.length; q++) {
      const f = piece[q], [a, b, c] = tris[f];
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const fs = byEdge.get(key(u, v));
        if (fs.length !== 2) continue; // only clean two-face edges say how a neighbour should run
        const n = fs[0] === f ? fs[1] : fs[0];
        if (done[n]) continue;
        if (runs(n, u, v)) { const t = tris[n]; [t[1], t[2]] = [t[2], t[1]]; } // same way as us: flip it
        done[n] = 1; piece.push(n);
      }
    }
    pieces.push(piece);
  }
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3();
  const faceNormal = (f, out) => { const [a, b, c] = tris[f]; A.fromBufferAttribute(P, a); B.fromBufferAttribute(P, b).sub(A); C.fromBufferAttribute(P, c).sub(A); return out.crossVectors(B, C); };
  const flip = (piece) => { for (const f of piece) { const t = tris[f]; [t[1], t[2]] = [t[2], t[1]]; } };
  // the main surface faces outward: positive volume about its centre
  pieces.sort((x, y) => y.length - x.length);
  const main = pieces[0], o = new THREE.Vector3();
  let nv = 0;
  for (const f of main) for (const i of tris[f]) { o.add(A.fromBufferAttribute(P, i)); nv++; }
  o.divideScalar(nv);
  let vol = 0;
  for (const f of main) { const [a, b, c] = tris[f]; A.fromBufferAttribute(P, a).sub(o); B.fromBufferAttribute(P, b).sub(o); C.fromBufferAttribute(P, c).sub(o); vol += A.dot(B.cross(C)); }
  if (vol < 0) flip(main);
  // scraps cut off by the fins face the same way as the main surface where they touch it
  const vn = Array.from({ length: P.count }, () => new THREE.Vector3());
  for (const f of main) { faceNormal(f, N); for (const i of tris[f]) vn[i].add(N); }
  for (const piece of pieces.slice(1)) {
    let agree = 0;
    for (const f of piece) { faceNormal(f, N); for (const i of tris[f]) agree += N.dot(vn[i]); }
    if (agree < 0) flip(piece);
  }
  // folds: a triangle lying across the skin but facing into the limb (it fights the faces under it
  // and lights up from inside: the pale triangles). Dropped; the faces under it cover the spot.
  {
    const area = tris.map((t, f) => faceNormal(f, new THREE.Vector3()));
    const around = Array.from({ length: P.count }, () => new THREE.Vector3());
    tris.forEach((t, f) => { for (const i of t) around[i].add(area[f]); });
    const keep = [];
    tris.forEach((t, f) => {
      const n = area[f].clone().normalize(), m = new THREE.Vector3();
      for (const i of t) m.add(around[i]).sub(area[f]); // the surface round its corners, without itself
      if (m.lengthSq() > 0 && n.dot(m.normalize()) < -0.2) return;
      keep.push(t);
    });
    tris.length = 0; tris.push(...keep);
  }
  // holes: loops of edges with one face only; each up to 6 edges gets a fan, facing like the skin around it
  const count = new Map(), nbr = new Map();
  for (const [a, b, c] of tris) for (const [u, v] of [[a, b], [b, c], [c, a]]) count.set(key(u, v), (count.get(key(u, v)) || 0) + 1);
  for (const [k, n] of count) if (n === 1) { const [u, v] = k.split(',').map(Number); (nbr.get(u) || nbr.set(u, []).get(u)).push(v); (nbr.get(v) || nbr.set(v, []).get(v)).push(u); }
  const vnAll = Array.from({ length: P.count }, () => new THREE.Vector3());
  tris.forEach((t, f) => { faceNormal(f, N); for (const i of t) vnAll[i].add(N); });
  const used = new Set();
  for (const start of nbr.keys()) {
    if (used.has(start) || nbr.get(start).length !== 2) continue;
    const loop = [start];
    let prev = start, v = nbr.get(start)[0];
    while (v !== start && loop.length <= 7 && nbr.get(v)?.length === 2) { loop.push(v); const [p, q] = nbr.get(v); [prev, v] = [v, p === prev ? q : p]; }
    if (v !== start || loop.length < 3 || loop.length > 6) continue; // an open end of the part, or tangled
    for (const x of loop) used.add(x);
    const fan = [];
    for (let i = 1; i < loop.length - 1; i++) fan.push([loop[0], loop[i], loop[i + 1]]);
    // face the way the surrounding skin does
    let agree = 0;
    for (const t of fan) { A.fromBufferAttribute(P, t[0]); B.fromBufferAttribute(P, t[1]).sub(A); C.fromBufferAttribute(P, t[2]).sub(A); N.crossVectors(B, C); for (const i of t) agree += N.dot(vnAll[i]); }
    for (const t of fan) { if (agree < 0) [t[1], t[2]] = [t[2], t[1]]; tris.push(t); }
  }
  g.setIndex(tris.flat());
  return g;
}

export class DummyRider {
  /** `group` is the rider group (forward = +x, up = +y, right = +z, road at y = 0). */
  constructor(model, group, { jersey, stripe } = {}) {
    const { dummy, cfg = {} } = model;
    this.cfg = cfg;
    this.group = group;
    const ex = dummy.scene.userData || {};
    const J = this.J = Object.fromEntries(Object.entries(ex.joints).map(([k, v]) => [k, v3(v)]));
    this.saddle0 = new THREE.Vector2(...ex.saddle);
    this.bb0 = v3(ex.bb);
    J.hips = J.hipL.clone().add(J.hipR).multiplyScalar(0.5);
    J.shoulders = J.shoulderL.clone().add(J.shoulderR).multiplyScalar(0.5);

    const colors = { ...KIT, ...(cfg.colors || {}), jersey: jersey || '#15808a', stripe: stripe || '#ff8a1f' };
    // the "gloves" are the colour of the skin: bare hands, the wrist joint smoothed over by the cuff
    colors.glove = cfg.colors?.glove || colors.skin;
    colors.cuff = cfg.colors?.cuff || colors.skin;
    const mats = {};
    const mat = (name) => (mats[name] ||= new THREE.MeshStandardMaterial({
      color: colors[name] || '#cccccc', flatShading: false, roughness: 0.85, metalness: 0, side: THREE.DoubleSide, // smooth skin and kit
    }));
    this.mats = mats;

    // every part hangs from a pivot at its joint
    const PIVOT = { torso: 'hips', head: 'neck' };
    for (const s of 'LR') {
      Object.assign(PIVOT, { [`upperArm${s}`]: `shoulder${s}`, [`lowerArm${s}`]: `elbow${s}`, [`hand${s}`]: `wrist${s}`,
        [`upperLeg${s}`]: `hip${s}`, [`lowerLeg${s}`]: `knee${s}`, [`foot${s}`]: `ankle${s}` });
    }
    this.root = new THREE.Group();
    this.parts = {};
    dummy.scene.updateMatrixWorld(true);
    for (const node of [...dummy.scene.children]) {
      const joint = J[PIVOT[node.name]];
      if (!joint) continue;
      const pivot = new THREE.Group();
      pivot.position.copy(joint);
      node.traverse((o) => {
        if (!o.isMesh) return;
        const m = o.clone();
        m.geometry = o.geometry.clone().applyMatrix4(o.matrixWorld).translate(-joint.x, -joint.y, -joint.z);
        // shared corners, so the normals average across faces: a smooth body instead of facets
        m.geometry.deleteAttribute('normal');
        m.geometry = repairMesh(mergeVertices(m.geometry, 1e-4));
        m.geometry.computeVertexNormals();
        m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.set(1, 1, 1);
        m.material = mat(o.material.name);
        m.castShadow = true;
        m.receiveShadow = true;
        pivot.add(m);
      });
      this.root.add(pivot);
      this.parts[node.name] = pivot;
    }
    group.add(this.root);
    // cycling gloves: the hand in the glove colour and a cuff round the end of the forearm, which also
    // covers where the forearm and the hand meet ("gloves": false in dummy.json for bare hands)
    if (cfg.gloves !== false) {
      for (const s of 'LR') {
        this.parts[`hand${s}`].traverse((o) => { if (o.isMesh) o.material = mat('glove'); });
        const arm = this.parts[`lowerArm${s}`];
        const wrist = J[`wrist${s}`].clone().sub(J[`elbow${s}`]); // the wrist in the forearm's frame
        const axis = wrist.clone().normalize();
        // the forearm's radius just before the wrist, from its own vertices
        let r = 0;
        arm.traverse((o) => {
          if (!o.isMesh) return;
          const p = o.geometry.attributes.position, v = new THREE.Vector3();
          for (let i = 0; i < p.count; i++) {
            v.fromBufferAttribute(p, i);
            const along = v.dot(axis);
            if (along > wrist.length() - 0.035) r = Math.max(r, v.clone().sub(axis.clone().multiplyScalar(along)).length());
          }
        });
        const cuff = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.92, r * 1.04, 0.05, 20, 1, true), mat('cuff')); // narrower toward the hand: its inside never shows
        cuff.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
        cuff.position.copy(axis).multiplyScalar(wrist.length() - 0.012);
        cuff.castShadow = true;
        arm.add(cuff);
      }
    }
    if (model.head && cfg.head !== false) this._modelHead(model.head);
    else if (cfg.helmet !== false) this.parts.head.add(this._helmet(jersey));

    // rest lengths and bending planes
    this.rest = {};
    for (const s of 'LR') {
      const leg = [J[`hip${s}`], J[`knee${s}`], J[`ankle${s}`]];
      const arm = [J[`shoulder${s}`], J[`elbow${s}`], J[`wrist${s}`]];
      const chain = ([a, b, c]) => ({
        l1: a.distanceTo(b), l2: b.distanceTo(c),
        d1: b.clone().sub(a), d2: c.clone().sub(b),
        n: new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(b)).normalize(),
      });
      this.rest[s] = { leg: chain(leg), arm: chain(arm) };
    }
    // where the ankle sits relative to the pedal spindle in the source pose (both feet agree:
    // ~7 cm behind and ~16 cm above it, the foot angled down toward the toes)
    this.ankleOffset = new THREE.Vector2(...(cfg.ankleOffset || [-0.075, 0.153]));
    // a dial (BOA-style closure) on each shoe's instep, in the accent colour with a cap like the sole
    for (const [s, d] of Object.entries(ex.dials || {})) {
      const foot = this.parts[`foot${s}`];
      if (!foot) continue;
      const dial = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.0135, 0.015, 0.009, 14), mat('stripe'));
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.009, 0.004, 12), mat('shoe'));
      cap.position.y = 0.0055;
      dial.add(ring, cap);
      dial.position.copy(v3(d.at).sub(J[`ankle${s}`])).addScaledVector(v3(d.up), 0.002);
      dial.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v3(d.up).normalize());
      dial.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      foot.add(dial);
    }
    // Thicker thighs (dummy.json "thigh": 1 = as modelled): widened across the hip→knee line in the
    // middle only — 1 at the hip (the seat stays as modelled) and at the knee (the joint still matches)
    const thigh = cfg.thigh ?? 1.08;
    if (thigh !== 1) {
      for (const s of 'LR') {
        const axis = J[`knee${s}`].clone().sub(J[`hip${s}`]), n2 = axis.lengthSq();
        const v = new THREE.Vector3(), along = new THREE.Vector3();
        this.parts[`upperLeg${s}`].traverse((o) => {
          if (!o.isMesh) return;
          const pos = o.geometry.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i);
            const t = v.dot(axis) / n2;
            const k = 1 + (thigh - 1) * THREE.MathUtils.smoothstep(t, 0.15, 0.45) * (1 - THREE.MathUtils.smoothstep(t, 0.65, 1));
            along.copy(axis).multiplyScalar(t);
            v.sub(along).multiplyScalar(k).add(along);
            pos.setXYZ(i, v.x, v.y, v.z);
          }
          o.geometry.computeVertexNormals();
        });
      }
    }
    // Fists: past the knuckles the fingers wrap around a cylinder below them (the hood), a true bend
    // that keeps their thickness: a point d along the fingers and h above the knuckle line goes to
    // angle d / R round the cylinder, radius R + h. dummy.json "fist": [wrap radians, knuckle x, y].
    const [curl, kx, ky] = cfg.fist || [2.3, 0.06, -0.07]; // radius stays above the fingers' depth: no fold-over
    // The thumb (the inner edge of the hand, toward the stem) keeps its modelled shape along the inside
    // of the hood: curled with the fingers it hooked out sideways. "thumbZ": where it starts across
    // the hand (metres from the wrist, inward), blended over 2 cm so the skin does not tear.
    const thumbZ = cfg.thumbZ ?? -1; // off: in this model the inner edge past the knuckles is the curled fingertips, not the thumb
    // ... and turns down round the hand's length, so it wraps the inside of the hood ("thumbDown", degrees)
    const thumbDown = THREE.MathUtils.degToRad(cfg.thumbDown ?? 85), ty0 = cfg.thumbPivotY ?? -0.035, tu0 = cfg.thumbPivotU ?? -0.02;
    for (const s of 'LR') {
      const inward = s === 'R' ? 1 : -1; // the right hand's inner edge is at -z, the left hand's at +z
      this.parts[`hand${s}`].traverse((o) => {
        if (!o.isMesh || !curl) return;
        const pos = o.geometry.attributes.position;
        // shorter fingers ("fingerLength" of the modelled length): tucked under the hood, not sticking out
        const len = cfg.fingerLength ?? 0.15;
        let tip = kx;
        for (let i = 0; i < pos.count; i++) {
          const dx = pos.getX(i) - kx, u = inward * pos.getZ(i);
          const onThumb = THREE.MathUtils.smoothstep(-u, -(thumbZ + 0.01), -(thumbZ - 0.01));
          if (dx > 0) pos.setX(i, kx + dx * (len + (1 - len) * onThumb)); // the thumb keeps its length
          tip = Math.max(tip, pos.getX(i));
        }
        const R = (tip - kx) / curl; // the finger length goes exactly round `curl` radians
        for (let i = 0; i < pos.count; i++) {
          const u = inward * pos.getZ(i); // across the hand, negative toward the thumb side
          const keep = THREE.MathUtils.smoothstep(-u, -(thumbZ + 0.01), -(thumbZ - 0.01)); // 1 on the thumb
          let x0 = pos.getX(i), y0 = pos.getY(i), z0 = pos.getZ(i);
          if (keep > 0 && x0 > 0) { // the thumb turns down round an axis along the hand at its root
            const th = thumbDown * keep, du = u - tu0, dv = y0 - ty0;
            const u2 = du * Math.cos(th) - dv * Math.sin(th), v2 = du * Math.sin(th) + dv * Math.cos(th);
            z0 = inward * (tu0 + u2); y0 = ty0 + v2;
          }
          const d = x0 - kx;
          if (d > 0 && keep < 1) { // the fingers wrap round the hood
            const t = d / R, r = R + (y0 - ky);
            const x = kx + r * Math.sin(t), y = ky - R + r * Math.cos(t);
            x0 = x + (x0 - x) * keep; y0 = y + (y0 - y) * keep;
          }
          pos.setXYZ(i, x0, y0, z0);
        }
        o.geometry.computeVertexNormals();
      });
    }
    // middle of each hand relative to its wrist (hand pivot space), where it should rest on the hood
    this.handMid = {};
    for (const s of 'LR') {
      const box = new THREE.Box3();
      this.parts[`hand${s}`].traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox); } });
      this.handMid[s] = box.getCenter(new THREE.Vector3());
    }
    this._q = new THREE.Quaternion();
  }

  /**
   * Swaps the mannequin's bare head for a modelled one (face, helmet, glasses and straps in one
   * mesh, facing +z, y up, neck at the bottom) and joins its neck to the jersey collar:
   *  - the mannequin's neck stub is cut off flat at the collar ("collarCut", along hips→neck),
   *    leaving the collar ring open;
   *  - the model's neck flares toward its root to the size of that ring, as the neck widens into
   *    the shoulders, and bends so its root runs along the ring's axis while the head stays bowed
   *    toward the road ("headPitch", degrees from upright);
   *  - the root goes into the middle of the ring. The head hangs from the torso, so the join holds.
   * Model-space settings: "headNeck": [x, z] of the neck's middle, "headNeckHalf": its half width and
   * depth, "headNeckCut": height of its root, "headScale": model units → mannequin units.
   */
  _modelHead(gltf) {
    const c = this.cfg, J = this.J, Z = new THREE.Vector3(0, 0, 1);
    for (const o of [...this.parts.head.children]) o.visible = false;

    // 1. collar: cut the torso flat across its neck, and measure the opening (torso pivot space)
    // the cut plane crosses the hips→neck line at "collarCut" (0..1) and is tipped up by "collarTilt"
    // degrees, so the neck leaves the jersey rising rather than straight ahead
    const axis = J.neck.clone().sub(J.hips);
    const N = axis.clone().normalize().applyAxisAngle(Z, THREE.MathUtils.degToRad(c.collarTilt ?? 0));
    const P = axis.clone().multiplyScalar(c.collarCut ?? 0.95); // torso pivot space: origin at the hips
    const dist = (p) => p.clone().sub(P).dot(N);
    const ring = [], v = new THREE.Vector3();
    this.parts.torso.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position, ix = o.geometry.index, keep = [];
      for (let i = 0; i < pos.count; i++) if (Math.abs(dist(v.fromBufferAttribute(pos, i))) < 0.006) ring.push(v.clone());
      for (let t = 0; t < ix.count; t += 3) {
        const tri = [ix.getX(t), ix.getX(t + 1), ix.getX(t + 2)];
        if (Math.max(...tri.map((k) => dist(v.fromBufferAttribute(pos, k)))) < 0) keep.push(...tri);
      }
      o.geometry.setIndex(keep);
    });
    const C = ring.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, ring.length));
    const W = new THREE.Vector3().crossVectors(Z, N); // across the ring, "up" side
    const half = (dir) => (ring.length ? (Math.max(...ring.map((p) => p.dot(dir))) - Math.min(...ring.map((p) => p.dot(dir)))) / 2 : 0.06);
    const ringSide = half(Z), ringUp = half(W);
    // close the opening just inside the collar with skin, so no gap shows the jersey's inner wall
    const cap = new THREE.Mesh(new THREE.CircleGeometry(1, 20), this.mats.skin || new THREE.MeshStandardMaterial({ color: KIT.skin, flatShading: true }));
    cap.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(W, Z, N));
    cap.scale.set(ringUp, ringSide, 1);
    cap.position.copy(C).addScaledVector(N, -0.004);
    this.parts.torso.add(cap);

    // 2. the model, in its own units
    gltf.scene.updateMatrixWorld(true);
    const group = new THREE.Group();
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const m = new THREE.Mesh(o.geometry.clone().applyMatrix4(o.matrixWorld), o.material); // the node carries a Z-up turn
      m.castShadow = true;
      group.add(m);
    });
    const k = c.headScale ?? 0.29;
    const [nx, nz] = c.headNeck || [0, -0.15];
    const [hx, hz] = c.headNeckHalf || [0.2, 0.2];
    const cutY = c.headNeckCut ?? 0.08, flareTop = c.headFlareTop ?? 0.22;
    const flareX = (ringSide * 0.96) / (hx * k), flareZ = (ringUp * 0.96) / (hz * k);
    // head orientation in the torso's rest frame (the torso is tilted up by `lean` when posed)
    const restBack = Math.atan2(J.shoulders.y - J.hips.y, J.shoulders.x - J.hips.x);
    const lean = THREE.MathUtils.degToRad(c.back ?? 33) - restBack;
    const U = new THREE.Vector3(0, 1, 0).applyAxisAngle(Z, -THREE.MathUtils.degToRad(c.headPitch ?? 18) - lean);
    const F = new THREE.Vector3().crossVectors(U, Z).normalize();
    // the bend that turns the neck root from the head's "up" to the ring's axis
    const bend = Math.atan2(U.y, U.x) - Math.atan2(N.y, N.x), by = flareTop;
    const shape = (x, y, z) => {
      if (y >= by) return [x, y, z];
      const f = THREE.MathUtils.smoothstep(by - y, 0, by - cutY); // 0 at the jaw .. 1 at the root
      x = nx + (x - nx) * (1 + (flareX - 1) * f);
      z = nz + (z - nz) * (1 + (flareZ - 1) * f);
      const a = bend * Math.min(1, (by - y) / (by - cutY)), dy = y - by, dz = z - nz;
      return [x, by + dy * Math.cos(a) - dz * Math.sin(a), nz + dy * Math.sin(a) + dz * Math.cos(a)];
    };
    const root = shape(nx, cutY, nz);

    // 3. the model's neck fades to grey toward its cut: below the jaw it takes the body's skin colour
    const [fadeTop, fadeBottom] = c.headNeckFade || [0.27, 0.17];
    const skin = this.mats.skin?.color || new THREE.Color(KIT.skin);
    for (const m of group.children) {
      const pos = m.geometry.attributes.position;
      const mix = new Float32Array(pos.count), orig = new Float32Array(pos.count); // orig: model-space y
      for (let i = 0; i < pos.count; i++) {
        orig[i] = pos.getY(i);
        // the nape runs higher than the throat: the fade reaches further up at the back (−z)
        const top = fadeTop + Math.min(0.1, Math.max(0, (-0.05 - pos.getZ(i)) * 0.5));
        mix[i] = THREE.MathUtils.smoothstep(top - pos.getY(i), 0, fadeTop - fadeBottom);
        const [x, y, z] = shape(pos.getX(i), pos.getY(i), pos.getZ(i));
        pos.setXYZ(i, x - root[0], y - root[1], z - root[2]);
      }
      const ix = m.geometry.index; // below the root: inside the jersey
      if (ix) {
        const keep = [];
        for (let t = 0; t < ix.count; t += 3) {
          const a = ix.getX(t), b = ix.getX(t + 1), d = ix.getX(t + 2);
          if (Math.max(orig[a], orig[b], orig[d]) >= cutY) keep.push(a, b, d);
        }
        m.geometry.setIndex(keep);
      }
      m.geometry.setAttribute('skinMix', new THREE.BufferAttribute(mix, 1));
      m.geometry.computeVertexNormals();
      m.material = m.material.clone();
      m.material.onBeforeCompile = (sh) => {
        sh.uniforms.skinColor = { value: skin };
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float skinMix;\nvarying float vSkinMix;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkinMix = skinMix;');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 skinColor;\nvarying float vSkinMix;')
          // skin only where the texture is skin: the dark straps and buckles stay dark (and go black)
          .replace('#include <map_fragment>', `#include <map_fragment>
            float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            float strap = 1.0 - smoothstep(0.06, 0.14, lum);
            diffuseColor.rgb = mix(diffuseColor.rgb, skinColor, vSkinMix * (1.0 - strap));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025), strap * 0.8);`);
      };
      m.material.customProgramCacheKey = () => 'rider-head-neck';
    }

    // 4. root in the middle of the ring, a little inside the jersey
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(Z.clone().negate(), U, F));
    group.scale.setScalar(k);
    group.position.copy(C).addScaledVector(N, -(c.headInset ?? 0.02));
    this.parts.torso.add(group);
  }

  /** Road helmet sized to the head part (head pivot space: x forward, y up, z right). */
  _helmet(jersey) {
    const c = this.cfg;
    // the skull's own axes: the riding mannequin's head is pitched well forward, so "up" runs from
    // the neck joint through the middle of the head (dummy.json "helmetPitch": degrees, + tips it back)
    const up = this.J.headCentre ? this.J.headCentre.clone().sub(this.J.neck) : new THREE.Vector3(0, 1, 0);
    up.applyAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(c.helmetPitch ?? 0)).normalize();
    const side = new THREE.Vector3(0, 0, 1);
    const fwd = new THREE.Vector3().crossVectors(up, side).normalize();
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], v = new THREE.Vector3();
    const axes = [fwd, up, side];
    this.parts.head.traverse((o) => {
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        axes.forEach((ax, k) => { const d = v.dot(ax); lo[k] = Math.min(lo[k], d); hi[k] = Math.max(hi[k], d); });
      }
    });
    // cranium: front/back and sides from the whole head, height from the brow up (as measureHead in rider-model.js)
    const H = hi[1] - lo[1];
    const half = [(hi[0] - lo[0]) / 2, H * 0.42, (hi[2] - lo[2]) / 2];
    const center = new THREE.Vector3()
      .addScaledVector(fwd, (lo[0] + hi[0]) / 2).addScaledVector(up, hi[1] - half[1]).addScaledVector(side, (lo[2] + hi[2]) / 2);
    // a little roomier than the skull, so the crown cannot poke through, and 1 cm back off the brow
    const helmet = buildModernHelmet({ center: center.addScaledVector(fwd, -0.01), half, height: H, axes },
      { shell: c.helmetColor, accent: jersey }, c.helmetScale ?? 1.08);
    if (c.helmetOffset) helmet.position.add(new THREE.Vector3(...c.helmetOffset)); // dummy.json, m
    return helmet;
  }

  /** Scale and hip position for the current bike (bikeFit from ModelBike, else the built-in bike). */
  _place() {
    const F = this.bikeFit;
    const saddle = F ? F.saddle : SADDLE0;
    const s = this.cfg.scale ?? (saddle.y - BB.y) / (this.saddle0.y - this.bb0.y);
    this.s = s;
    // hips above the saddle as in the source pose, moved with cfg "hips": [dx, dy] (m)
    const off = this.cfg.hips || [0, -0.03]; // sit bones down on the saddle
    const hips = new THREE.Vector3(
      saddle.x + (this.J.hips.x - this.saddle0.x) * s + off[0],
      saddle.y + (this.J.hips.y - this.saddle0.y) * s + off[1], 0);
    this.root.scale.setScalar(s);
    this.root.position.copy(hips).addScaledVector(this.J.hips, -s); // rest hips land on `hips`
    this._placed = true;
  }

  /** Group point -> mannequin space (unscaled source metres). */
  _local(x, y, z) {
    return new THREE.Vector3(x, y, z).sub(this.root.position).divideScalar(this.s);
  }

  pose(angle /* crank, radians */) {
    if (!this._placed) this._place();
    const J = this.J, P = this.parts, cfg = this.cfg;
    const Z = new THREE.Vector3(0, 0, 1);

    // torso: tilted about the hips so the hip→shoulder line is `back` degrees above horizontal
    const restBack = Math.atan2(J.shoulders.y - J.hips.y, J.shoulders.x - J.hips.x);
    const qTorso = new THREE.Quaternion().setFromAxisAngle(Z, THREE.MathUtils.degToRad(cfg.back ?? 33) - restBack);
    const onTorso = (p) => p.clone().sub(J.hips).applyQuaternion(qTorso).add(J.hips);
    P.torso.position.copy(J.hips);
    P.torso.quaternion.copy(qTorso);
    // head: on the neck, still looking up the road (it keeps its rest orientation, plus a tilt)
    P.head.position.copy(onTorso(J.neck));
    P.head.quaternion.setFromAxisAngle(Z, THREE.MathUtils.degToRad(cfg.headTilt ?? 0));

    const F = this.bikeFit;
    for (const s of 'LR') {
      const side = s === 'L' ? -1 : 1;
      const R = this.rest[s];

      // legs: ankle at its place over the pedal, knee bending straight forward over the foot
      // (the source mannequin has a wide stance, which splays the knees: the feet come in to the pedals)
      const a = -angle + (side > 0 ? 0 : Math.PI); // same phase as the bike's cranks
      // the pedal: read from the bike model's pedal bone when there is one (its crank length and
      // phase are the bike's own), else on our idea of the crank
      const bone = this.bike?.bones?.pedals?.find((b) => (side > 0 ? /right/i : /left/i).test(b.name));
      const at = bone ? this.group.worldToLocal(bone.getWorldPosition(_v)) : _v.set(BB.x + Math.cos(a) * CRANK, BB.y + Math.sin(a) * CRANK, 0);
      const pedal = this._local(at.x, at.y, side * (cfg.footZ ?? 0.115));
      const ankle = new THREE.Vector3(pedal.x + this.ankleOffset.x, pedal.y + this.ankleOffset.y, pedal.z);
      const hip = onTorso(J[`hip${s}`]);
      const knee = middleJoint(hip, ankle, R.leg.l1, R.leg.l2, new THREE.Vector3(1, 0, side * (cfg.kneeOut ?? -0.02)));
      this._limb(P[`upperLeg${s}`], P[`lowerLeg${s}`], hip, knee, ankle, R.leg);
      P[`foot${s}`].position.copy(ankle);
      P[`foot${s}`].quaternion.identity(); // pedals stay level, so the foot keeps its angle

      // arms: wrists at the hoods, elbows bent back, down and slightly out
      // Hands on the hoods: the mannequin's hand keeps the grip it was modelled with (palm down,
      // fingers curled forward), turned by "handTurn" [x, y, z] degrees (mirrored for the left
      // hand), and is placed so its middle sits on top of the hood; the wrist follows from that.
      // The hood comes from the bike's fit: its wrist point is ~8 cm behind the hood's middle.
      const H = F?.hand || HAND0;
      // the palm on the hood (not hovering in front of it), the thumb against its inner side
      const [gx, gy, gz] = cfg.grip || [-0.075, -0.07, 0.01];
      const grip = this._local(H.x + 0.08 + gx, H.y + 0.015 + gy, side * (H.z - 0.01 + gz));
      const [tx, ty, tz] = (cfg.handTurn || [0, 0, 0]).map((d) => THREE.MathUtils.degToRad(d));
      const hand = P[`hand${s}`];
      // the hand turns with the forearm (as modelled: a straight wrist, no seam), then by "handTurn"
      const qTurn = this._qTurn ||= new THREE.Quaternion();
      qTurn.setFromEuler(new THREE.Euler(side * tx, side * ty, tz, 'XYZ'));
      const follow = cfg.wristFollow ?? 0; // 1: the wrist straight as modelled; 0: the hand keeps its modelled grip angle
      const qa = this._qa ||= new THREE.Quaternion();
      const handRot = () => { qa.copy(P[`lowerArm${s}`].quaternion).multiply(qTurn); hand.quaternion.copy(qTurn).slerp(qa, follow); };
      handRot(); // from the forearm's last pose: it moves little from one frame to the next
      hand.scale.setScalar(cfg.handScale ?? 0.85);
      const wrist = grip.sub(this.handMid[s].clone().multiplyScalar(cfg.handScale ?? 0.85).applyQuaternion(hand.quaternion));
      const sh = onTorso(J[`shoulder${s}`]);
      const elbow = middleJoint(sh, wrist, R.arm.l1, R.arm.l2,
        new THREE.Vector3(-0.5, -(cfg.elbowDown ?? 0.7), side * (cfg.elbowOut ?? 0.25)));
      this._limb(P[`upperArm${s}`], P[`lowerArm${s}`], sh, elbow, wrist, R.arm);
      handRot();
      hand.position.copy(wrist);
    }
  }

  /** Puts a two-part limb on root a, middle joint b, end c, keeping the parts' twist via the bending plane. */
  _limb(p1, p2, a, b, c, rest) {
    const ab = b.clone().sub(a), bc = c.clone().sub(b);
    let n = new THREE.Vector3().crossVectors(ab, bc);
    if (n.lengthSq() < 1e-10) n = rest.n.clone(); // straight: keep the rest plane
    n.normalize();
    p1.position.copy(a);
    frameRotation(rest.d1, rest.n, ab, n, p1.quaternion);
    p2.position.copy(b);
    frameRotation(rest.d2, rest.n, bc, n, p2.quaternion);
  }
}
