// A rider built entirely in code: a smooth, skinned humanoid in cycling kit (jersey with short
// sleeves, bib shorts, short socks, shoes) with its own skeleton. The bones carry Mixamo-style
// names, so ModelRider poses it exactly like a downloaded character (feet on the pedals, hands on
// the hoods, helmet and glasses fitted to the head). No files to download, no licence to track.
//
// Built in a T-pose: Y up, facing +Z, the rider's left side on +X, palms down; metres, ~1.78 m tall.
import * as THREE from 'three';

const SKIN = '#d9a27c', SHORTS = '#1d1f26', SOCKS = '#f4f4f2', SHOES = '#23252b', SOLE = '#e9e9e6', HAIR = '#3b2a20';

/**
 * Skeleton in the T-pose. Each entry: [name, parent, x, y, z] in world space; mirrored for the right.
 * Finger chains end in a "4" bone that only marks the fingertip.
 */
function skeletonSpec() {
  const centre = [
    ['Hips', null, 0, 0.98, 0],
    ['Spine', 'Hips', 0, 1.08, -0.005],
    ['Spine1', 'Spine', 0, 1.2, -0.01],
    ['Spine2', 'Spine1', 0, 1.32, -0.01],
    ['Neck', 'Spine2', 0, 1.49, -0.015],
    ['Head', 'Neck', 0, 1.58, 0],
    ['HeadTop_End', 'Head', 0, 1.79, 0.01],
  ];
  const side = (S, sx) => {
    const x = (v) => v * sx;
    const hand = [x(0.73), 1.45, 0];
    const fingers = [];
    // index, middle, ring, pinky: knuckles across the hand (thumb side = +Z with the palm down)
    [['Index', 0.026, 1], ['Middle', 0.008, 1.06], ['Ring', -0.01, 1], ['Pinky', -0.026, 0.82]].forEach(([n, z, len]) => {
      const k = [x(0.818), 1.448, z];
      const segs = [0.044, 0.028, 0.022, 0.018].map((l) => l * len);
      let px = 0.818;
      fingers.push([`${S}Hand${n}1`, `${S}Hand`, k[0], k[1], k[2]]);
      for (let i = 2; i <= 4; i++) { px += segs[i - 2]; fingers.push([`${S}Hand${n}${i}`, `${S}Hand${n}${i - 1}`, x(px), 1.448, z]); }
    });
    return [
      [`${S}Shoulder`, 'Spine2', x(0.035), 1.44, -0.01],
      [`${S}Arm`, `${S}Shoulder`, x(0.185), 1.45, -0.01],
      [`${S}ForeArm`, `${S}Arm`, x(0.465), 1.45, -0.01],
      [`${S}Hand`, `${S}ForeArm`, ...hand],
      ...fingers,
      [`${S}HandThumb1`, `${S}Hand`, x(0.75), 1.44, 0.03],
      [`${S}HandThumb2`, `${S}HandThumb1`, x(0.785), 1.437, 0.052],
      [`${S}HandThumb3`, `${S}HandThumb2`, x(0.81), 1.435, 0.066],
      [`${S}HandThumb4`, `${S}HandThumb3`, x(0.83), 1.434, 0.076],
      [`${S}UpLeg`, 'Hips', x(0.095), 0.93, 0],
      [`${S}Leg`, `${S}UpLeg`, x(0.095), 0.51, 0.01],
      [`${S}Foot`, `${S}Leg`, x(0.095), 0.085, -0.01],
      [`${S}ToeBase`, `${S}Foot`, x(0.095), 0.02, 0.125],
      [`${S}Toe_End`, `${S}ToeBase`, x(0.095), 0.02, 0.2],
    ];
  };
  return [...centre, ...side('Left', 1), ...side('Right', -1)];
}

function buildSkeleton() {
  const spec = skeletonSpec();
  const bones = {}, world = {};
  for (const [name, parent, x, y, z] of spec) {
    const b = new THREE.Bone();
    b.name = name;
    world[name] = new THREE.Vector3(x, y, z);
    if (parent) {
      b.position.copy(world[name]).sub(world[parent]);
      bones[parent].add(b);
    } else {
      b.position.copy(world[name]);
    }
    bones[name] = b;
  }
  const list = spec.map(([name]) => bones[name]);
  return { root: bones.Hips, bones, list, world };
}

/**
 * Geometry accumulator: adds skinned surfaces (vertex positions in T-pose world space, up to four
 * bone influences each) and builds one indexed BufferGeometry with smooth normals.
 */
class SkinBuilder {
  constructor(boneIndex) { this.idx = boneIndex; this.pos = []; this.si = []; this.sw = []; this.tri = []; }

  _vert(p, influences) {
    const inf = influences.filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = inf.reduce((s, [, w]) => s + w, 0) || 1;
    while (inf.length < 4) inf.push([inf[0][0], 0]);
    this.pos.push(p.x, p.y, p.z);
    for (const [bone, w] of inf) { this.si.push(this.idx[bone]); this.sw.push(w / sum); }
    return this.pos.length / 3 - 1;
  }

  /**
   * A closed tube along a polyline of joints. `radius(t)` -> [r1, r2] gives the elliptical
   * cross-section (r1 along `side`, r2 across) at t ∈ [0, 1] of the total length; the ends are
   * rounded. `bones[k]` drives segment k; weights blend across each joint over `blend` metres.
   */
  tube(points, bones, radius, { rings = 24, around = 20, side = null, blend = 0.04, capStart = true, capEnd = true, weightFn = null, bulge = null } = {}) {
    const P = points.map((p) => new THREE.Vector3(...p));
    const segLen = P.slice(1).map((p, i) => p.distanceTo(P[i]));
    const total = segLen.reduce((a, b) => a + b, 0);
    const at = (s) => { // position, direction, segment index and local distance at arc length s
      let k = 0;
      while (k < segLen.length - 1 && s > segLen[k]) { s -= segLen[k]; k++; }
      const d = P[k + 1].clone().sub(P[k]).normalize();
      return { p: P[k].clone().addScaledVector(d, Math.min(s, segLen[k])), d, k, s };
    };
    const weightsAt = (k, s) => {
      const w = [[bones[k], 1]];
      if (k > 0 && s < blend) { const u = 0.5 - 0.5 * (s / blend); w.push([bones[k - 1], u]); w[0][1] = 1 - u; }
      if (k < segLen.length - 1 && segLen[k] - s < blend) { const u = 0.5 - 0.5 * ((segLen[k] - s) / blend); w.push([bones[k + 1], u]); w[0][1] -= u; }
      return w;
    };
    const capLen = Math.min(0.5 * total, Math.max(...[0, 0.5].map((t) => Math.max(...radius(t)))) * 1.0);
    const base = this.pos.length / 3;
    const ringIdx = [];
    for (let i = 0; i <= rings; i++) {
      const t = i / rings, s = t * total, { p, d, k, s: ls } = at(s);
      let [r1, r2] = radius(t);
      // rounded ends
      const fromStart = s, fromEnd = total - s;
      let shrink = 1;
      if (capStart && fromStart < capLen) shrink = Math.min(shrink, Math.sqrt(Math.max(0, 1 - ((capLen - fromStart) / capLen) ** 2)));
      if (capEnd && fromEnd < capLen) shrink = Math.min(shrink, Math.sqrt(Math.max(0, 1 - ((capLen - fromEnd) / capLen) ** 2)));
      r1 *= Math.max(shrink, 0.02); r2 *= Math.max(shrink, 0.02);
      const ref = side ? new THREE.Vector3(...side) : Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const e1 = ref.clone().addScaledVector(d, -ref.dot(d)).normalize();
      const e2 = new THREE.Vector3().crossVectors(d, e1).normalize();
      const w = weightsAt(k, ls);
      const row = [];
      for (let j = 0; j < around; j++) {
        const a = (j / around) * Math.PI * 2;
        const g = bulge ? bulge(t, a) : 1; // optional per-angle swelling (e.g. glutes on the back of the pelvis)
        const q = p.clone().addScaledVector(e1, Math.cos(a) * r1 * g).addScaledVector(e2, Math.sin(a) * r2 * g);
        row.push(this._vert(q, weightFn ? weightFn(q) : w));
      }
      ringIdx.push(row);
    }
    for (let i = 0; i < rings; i++) for (let j = 0; j < around; j++) {
      const a = ringIdx[i][j], b = ringIdx[i][(j + 1) % around], c = ringIdx[i + 1][j], d = ringIdx[i + 1][(j + 1) % around];
      this.tri.push(a, c, b, b, c, d);
    }
    return base;
  }

  /** An ellipsoid (centre, radii) on one bone, optionally cut below `minY` (relative, -1..1). */
  blob(centre, radii, bone, { w = 20, h = 14, thetaMax = Math.PI } = {}) {
    const inf = Array.isArray(bone) ? bone : [[bone, 1]];
    const rows = [];
    for (let i = 0; i <= h; i++) {
      const th = (i / h) * thetaMax, row = [];
      for (let j = 0; j < w; j++) {
        const ph = (j / w) * Math.PI * 2;
        row.push(this._vert(new THREE.Vector3(
          centre[0] + radii[0] * Math.sin(th) * Math.cos(ph),
          centre[1] + radii[1] * Math.cos(th),
          centre[2] + radii[2] * Math.sin(th) * Math.sin(ph)), inf));
      }
      rows.push(row);
    }
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
      const a = rows[i][j], b = rows[i][(j + 1) % w], c = rows[i + 1][j], d = rows[i + 1][(j + 1) % w];
      this.tri.push(a, b, c, b, d, c);
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.tri);
    g.computeVertexNormals();
    return g;
  }
}

const smooth = (a, b, t) => { const u = Math.min(1, Math.max(0, (t - a) / (b - a))); return u * u * (3 - 2 * u); };
const mix = (a, b, t) => a + (b - a) * t;
/** Round cross-section from a scalar radius profile. */
const round = (f) => (t) => { const r = f(t); return [r, r]; };
/** Piecewise-smooth profile through [t, value] keys. */
const profile = (keys) => (t) => {
  for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) return mix(keys[i - 1][1], keys[i][1], smooth(keys[i - 1][0], keys[i][0], t));
  return keys[keys.length - 1][1];
};

/**
 * Builds the rider as a scene object in the same shape GLTFLoader/FBXLoader return:
 * { scene, animations }. Mesh names follow the clothing conventions ModelRider recolours
 * ("Jersey" -> jersey colour, "Shorts" -> dark), "Hair" is hidden under the helmet.
 */
export function buildProceduralRider(opts = {}) {
  const skin = opts.skin || SKIN;
  const { root, list } = buildSkeleton();
  const index = Object.fromEntries(list.map((b, i) => [b.name, i]));
  const scene = new THREE.Group();
  scene.name = 'ProceduralRider';
  scene.add(root);
  scene.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list);
  const parts = [];
  const part = (name, color, build, matOpts = {}) => {
    const sb = new SkinBuilder(index);
    build(sb);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...matOpts });
    mat.name = name;
    const mesh = new THREE.SkinnedMesh(sb.geometry(), mat);
    mesh.name = name;
    mesh.castShadow = true;
    scene.add(mesh);
    parts.push(mesh);
  };
  const sides = [['Left', 1], ['Right', -1]];
  // lower pelvis: shared between the hips and the thigh on that side, so it moves with the legs
  // glutes: the back of the pelvis swells around y ≈ 0.86, two rounded lobes with a soft cleft between
  // (e2 of a vertical tube with side +X points to -Z, the back, so sin(a) > 0 is the rear half)
  const gluteAt = profile([[0, 0.5], [0.22, 1], [0.5, 0.35], [0.8, 0]]);
  const glutes = (t, a) => {
    const back = Math.max(0, Math.sin(a)), lobes = 1 - 0.55 * Math.exp(-((Math.cos(a) / 0.12) ** 2));
    return 1 + 0.42 * gluteAt(t) * back ** 1.5 * lobes;
  };
  const pelvisWeights = (q) => {
    const a = 0.4 * smooth(0.93, 0.83, q.y) * Math.min(1, Math.abs(q.x) / 0.07);
    return a > 0 ? [['Hips', 1 - a], [q.x > 0 ? 'LeftUpLeg' : 'RightUpLeg', a]] : [['Hips', 1]];
  };

  // --- skin: head, neck, forearms + hands, lower legs (only where the kit doesn't cover) ---
  part('Body', skin, (sb) => {
    // head: cranium, jaw, nose, ears
    sb.blob([0, 1.685, 0.005], [0.076, 0.105, 0.094], 'Head');
    sb.blob([0, 1.618, 0.032], [0.06, 0.058, 0.066], 'Head');
    sb.tube([[0, 1.665, 0.088], [0, 1.638, 0.112]], ['Head'], (t) => [0.013 * (1 - 0.5 * t), 0.016 * (1 - 0.4 * t)], { rings: 6, around: 10 });
    for (const [, sx] of sides) sb.blob([0.078 * sx, 1.67, -0.005], [0.012, 0.03, 0.02], 'Head', { w: 10, h: 8 });
    // neck
    sb.tube([[0, 1.44, -0.02], [0, 1.52, -0.012], [0, 1.61, 0.005]], ['Neck', 'Head'], (t) => [mix(0.064, 0.056, t), mix(0.06, 0.054, t)], { rings: 10, capStart: false });
    for (const [S, sx] of sides) {
      // arm from inside the sleeve to the wrist
      sb.tube([[0.31 * sx, 1.45, -0.01], [0.465 * sx, 1.45, -0.01], [0.735 * sx, 1.45, 0]], [`${S}Arm`, `${S}ForeArm`],
        round(profile([[0, 0.044], [0.35, 0.04], [0.5, 0.042], [0.75, 0.034], [1, 0.026]])), { side: [0, 1, 0], capStart: false });
      // hand: palm and fingers (palm down: thickness along Y)
      sb.tube([[0.725 * sx, 1.45, 0], [0.82 * sx, 1.449, 0]], [`${S}Hand`], (t) => [0.016 - 0.002 * t, 0.042 - 0.004 * t], { rings: 8, side: [0, 1, 0] });
      for (const [n, z, len] of [['Index', 0.026, 1], ['Middle', 0.008, 1.06], ['Ring', -0.01, 1], ['Pinky', -0.026, 0.82]]) {
        const L = [0.044, 0.028, 0.022].map((l) => l * len);
        const xs = [0.812, 0.818 + L[0], 0.818 + L[0] + L[1], 0.818 + L[0] + L[1] + L[2]];
        sb.tube(xs.map((x) => [x * sx, 1.448, z]), [`${S}Hand${n}1`, `${S}Hand${n}2`, `${S}Hand${n}3`],
          (t) => { const r = (n === 'Pinky' ? 0.0078 : 0.0092) * (1 - 0.25 * t); return [r, r]; }, { rings: 9, around: 8, blend: 0.008 });
      }
      sb.tube([[0.738 * sx, 1.443, 0.018], [0.785 * sx, 1.437, 0.052], [0.81 * sx, 1.435, 0.066], [0.83 * sx, 1.434, 0.076]],
        [`${S}HandThumb1`, `${S}HandThumb2`, `${S}HandThumb3`], (t) => { const r = 0.011 * (1 - 0.3 * t); return [r, r]; }, { rings: 9, around: 8, blend: 0.01 });
      // leg from inside the shorts to inside the sock
      sb.tube([[0.095 * sx, 0.64, 0.004], [0.095 * sx, 0.51, 0.01], [0.095 * sx, 0.15, 0.0]], [`${S}UpLeg`, `${S}Leg`],
        round(profile([[0, 0.058], [0.3, 0.05], [0.42, 0.054], [0.62, 0.052], [1, 0.034]])), { side: [1, 0, 0], capStart: false, capEnd: false, blend: 0.06 });
    }
  }, { roughness: 0.62 });

  // --- jersey: torso and short sleeves ---
  part('Jersey', '#16a0a8', (sb) => {
    // torso from the hips to the collar: [width/2, depth/2] by height
    const width = profile([[0, 0.172], [0.18, 0.152], [0.45, 0.16], [0.7, 0.182], [0.86, 0.178], [0.95, 0.12], [1, 0.072]]);
    const depth = profile([[0, 0.118], [0.2, 0.102], [0.5, 0.112], [0.72, 0.118], [0.88, 0.098], [1, 0.066]]);
    sb.tube([[0, 0.9, 0], [0, 1.08, -0.005], [0, 1.2, -0.01], [0, 1.32, -0.01], [0, 1.495, -0.02]],
      ['Hips', 'Spine', 'Spine1', 'Spine2'], (t) => [width(t), depth(t)], { side: [1, 0, 0], capStart: false, rings: 30, around: 28, blend: 0.06 });
    for (const [S, sx] of sides) {
      // shoulder cap + short sleeve, slightly larger than the arm under it
      sb.tube([[0.1 * sx, 1.45, -0.012], [0.185 * sx, 1.45, -0.01], [0.33 * sx, 1.45, -0.01]], [`${S}Shoulder`, `${S}Arm`],
        round(profile([[0, 0.062], [0.4, 0.058], [1, 0.05]])), { side: [0, 1, 0], capEnd: false, blend: 0.05 });
    }
  }, { roughness: 0.55 });

  // --- bib shorts: pelvis and thighs to just above the knee ---
  part('Shorts', SHORTS, (sb) => {
    // pelvis: stays inside the jersey above y ≈ 0.9
    sb.tube([[0, 0.845, 0.005], [0, 0.98, 0], [0, 1.02, -0.004]], ['Hips', 'Hips'], (t) => { const r = profile([[0, 0.15], [0.4, 0.162], [0.5, 0.15], [0.7, 0.132], [1, 0.12]])(t); return [r, r * 0.66]; },
      { side: [1, 0, 0], capEnd: false, weightFn: pelvisWeights, rings: 30, around: 36, bulge: glutes });
    for (const [S, sx] of sides) {
      sb.tube([[0.095 * sx, 0.95, 0], [0.095 * sx, 0.6, 0.006]], [`${S}UpLeg`], (t) => [mix(0.088, 0.064, t), mix(0.088, 0.064, t)],
        { side: [1, 0, 0], capEnd: false });
    }
  }, { roughness: 0.78 });

  // --- socks and shoes ---
  part('Socks', SOCKS, (sb) => {
    for (const [S, sx] of sides) sb.tube([[0.095 * sx, 0.22, 0], [0.095 * sx, 0.085, -0.01], [0.095 * sx, 0.06, 0.02]], [`${S}Leg`, `${S}Foot`],
      (t) => [mix(0.038, 0.034, t), mix(0.038, 0.036, t)], { side: [1, 0, 0], capStart: false, blend: 0.03 });
  }, { roughness: 0.85 });
  part('Shoes', SHOES, (sb) => {
    for (const [S, sx] of sides) {
      sb.tube([[0.095 * sx, 0.05, -0.065], [0.095 * sx, 0.045, 0.06], [0.095 * sx, 0.032, 0.125], [0.095 * sx, 0.026, 0.205]],
        [`${S}Foot`, `${S}Foot`, `${S}ToeBase`], (t) => { const r = profile([[0, 0.034], [0.3, 0.04], [0.75, 0.04], [1, 0.03]])(t); return [r, r * 0.85]; },
        { side: [1, 0, 0], rings: 18, blend: 0.03 });
    }
  }, { roughness: 0.4 });
  part('ShoeSoles', SOLE, (sb) => {
    for (const [S, sx] of sides) sb.tube([[0.095 * sx, 0.016, -0.06], [0.095 * sx, 0.012, 0.21]], [`${S}Foot`],
      () => [0.036, 0.009], { side: [1, 0, 0], rings: 8, around: 16 });
  }, { roughness: 0.6 });

  // --- short hair (hidden under the helmet, shows when helmet: false) ---
  part('Hair', HAIR, (sb) => sb.blob([0, 1.695, -0.004], [0.08, 0.103, 0.098], 'Head', { thetaMax: Math.PI * 0.55 }), { roughness: 0.9 });

  for (const m of parts) m.bind(skeleton, new THREE.Matrix4());
  return { scene, animations: [] };
}
