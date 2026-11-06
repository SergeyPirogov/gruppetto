// Optional custom rider: any rigged humanoid glTF placed at assets/rider.glb.
// The character is seated on the bike and posed every frame with inverse kinematics
// (feet on the pedals, hands on the bars, torso leaning forward). If the file carries a
// cycling animation clip, that clip is played instead, its speed following cadence.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from '../vendor/three/addons/loaders/FBXLoader.js';
import * as SkeletonUtils from '../vendor/three/addons/utils/SkeletonUtils.js';

const URL_CFG = 'assets/rider.json';
const TRANSPARENT_PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Default hero: Microsoft Rocketbox "Sports_Male_04" (MIT, see assets/default-rider/LICENSE.md).
// Its FBX points at .tga files on the author's disk; they are served as compact JPEGs next to it.
const DEFAULT_DIR = 'assets/default-rider/';
const DEFAULT_TEXTURES = { m026_body_color: 'body.jpg', m026_head_color: 'head.jpg' };
const DEFAULT_CFG = {
  height: 1.78,
  // Recolour the kit in the body texture atlas (UV rectangles, 0..1 from the top-left).
  kit: { jerseyHue: [195, 245], shorts: [[0, 0, 0.31, 0.185], [0.7, 0, 1, 0.185]], stripes: [[0.205, 0.255], [0.68, 0.73]], shirtX: [0.32, 0.69] },
};

function defaultManager() {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:') || url.endsWith('.fbx')) return url;
    const m = url.split(/[\\/]/).pop().match(/^([A-Za-z0-9_\-]+)\.(tga|png|jpe?g)/i);
    const file = m && DEFAULT_TEXTURES[m[1]];
    return file ? DEFAULT_DIR + file : TRANSPARENT_PX; // normal/specular maps are not shipped
  });
  // FBXLoader asks for a dedicated .tga handler; a plain texture loader goes through the URL map above
  manager.addHandler(/\.tga$/i, new THREE.TextureLoader(manager));
  return manager;
}

// Your own model wins: glTF, or FBX straight from Mixamo (embedded textures) — no conversion needed.
const CANDIDATES = [
  { url: 'assets/rider.glb', load: async (u) => new GLTFLoader().loadAsync(u) },
  { url: 'assets/rider.fbx', load: async (u) => { const g = await new FBXLoader().loadAsync(u); return { scene: g, animations: g.animations || [] }; } },
  {
    url: `${DEFAULT_DIR}Sports_Male_04.fbx`,
    builtin: true,
    load: async (u) => {
      const manager = defaultManager();
      const texturesDone = new Promise((resolve) => { manager.onLoad = resolve; manager.onError = () => {}; });
      const g = await new FBXLoader(manager).loadAsync(u);
      await Promise.race([texturesDone, new Promise((r) => setTimeout(r, 8000))]); // paint only once images exist
      g.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          m.normalMap = null; m.specularMap = null; m.bumpMap = null; m.vertexColors = false;
          m.shininess = 6; m.specular?.set('#111111'); m.color?.set('#ffffff');
          if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
          m.needsUpdate = true;
        }
      });
      return { scene: g, animations: g.animations || [] };
    },
  },
];

/** Loads the model once: your assets/rider.(glb|fbx) if present, otherwise the built-in hero. */
export async function loadRiderModel() {
  for (const c of CANDIDATES) {
    try {
      const head = await fetch(c.url, { method: 'HEAD' });
      if (!head.ok) continue;
      let cfg = c.builtin ? { ...DEFAULT_CFG } : {};
      if (!c.builtin) { try { const r = await fetch(URL_CFG); if (r.ok) cfg = await r.json(); } catch { /* optional */ } }
      const gltf = await c.load(c.url);
      return { gltf, cfg };
    } catch (e) {
      console.warn(`Rider model ${c.url} not loaded`, e);
    }
  }
  return null;
}

/**
 * Paint a cycling kit into a texture atlas: jersey pixels (by hue) take the jersey colour with
 * the original shading, a stripe band is added across the jersey, and the shorts turn black.
 */
export function paintKit(image, kit, jerseyHex, stripeHex) {
  const w = image.width, h = image.height;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  g.drawImage(image, 0, 0);
  const img = g.getImageData(0, 0, w, h), d = img.data;
  const jc = new THREE.Color(jerseyHex), sc = new THREE.Color(stripeHex || '#ff8a1f');
  const toByte = (c) => { const x = c.getHex(); return [(x >> 16) & 255, (x >> 8) & 255, x & 255]; }; // sRGB bytes
  const J = toByte(jc), S = toByte(sc);
  const inRect = (x, y, r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      const u = x / w, i = (y * w + x) * 4;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const max = Math.max(r, gg, b), min = Math.min(r, gg, b), l = (max + min) / 510, sat = max ? (max - min) / max : 0;
      let hue = 0;
      if (max !== min) {
        if (max === r) hue = 60 * (((gg - b) / (max - min)) % 6);
        else if (max === gg) hue = 60 * ((b - r) / (max - min) + 2);
        else hue = 60 * ((r - gg) / (max - min) + 4);
        if (hue < 0) hue += 360;
      }
      if (sat > 0.35 && hue >= kit.jerseyHue[0] && hue <= kit.jerseyHue[1]) {
        const stripe = u >= kit.shirtX[0] && u <= kit.shirtX[1] && kit.stripes.some(([a, bb]) => v >= a && v <= bb);
        const C = stripe ? S : J;
        const shade = Math.min(1.25, 0.45 + l * 1.6);
        d[i] = Math.min(255, C[0] * shade); d[i + 1] = Math.min(255, C[1] * shade); d[i + 2] = Math.min(255, C[2] * shade);
      } else if (kit.shorts.some((rc) => inRect(u, v, rc)) && sat < 0.25 && l > 0.45) {
        const k = 0.12 + (l - 0.45) * 0.25; // keep the folds visible
        d[i] = d[i + 1] = d[i + 2] = Math.round(255 * k);
        d[i + 2] = Math.round(255 * (k + 0.02));
      }
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = true;
  return tex;
}

// ---------- bone lookup ----------

const norm = (n) => n.toLowerCase().replace(/^mixamorig\d*[:_]?/, '').replace(/[\s:_.\-]/g, '');

/** Splits a bone name into side ('l' | 'r' | null) and a side-free core name. */
function parseName(name) {
  const raw = name.toLowerCase();
  let core = norm(name);
  // 3ds Max Biped (e.g. Microsoft Rocketbox): 'Bip01 L Thigh'
  const biped = raw.match(/(^|[\s_])(l|r)([\s_])/);
  if (biped && /bip/.test(raw)) return { side: biped[2], core: norm(name.replace(/(^|[\s_])(l|r)([\s_])/i, ' ')) };
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
  hand: (c) => /hand$/.test(c) && !/finger/.test(c),
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
    else if (/head$/.test(core) && !B.head) B.head = b;
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
 * The bone at the top of the skull (Mixamo: HeadTop_End). FBX rigs can also give the head a
 * zero-length child with the head's own name, so pick by name, else the farthest bone below the head.
 */
function findHeadTop(head) {
  if (!head) return null;
  const bones = [];
  head.traverse((o) => { if (o.isBone && o !== head) bones.push(o); });
  const named = bones.find((b) => /headtop|head_?end|top_?end/i.test(b.name));
  if (named) return named;
  const h = wp(head);
  let best = null, bestD = 1e-6;
  for (const b of bones) { const d = wp(b).distanceTo(h); if (d > bestD) { best = b; bestD = d; } }
  return best;
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
  return { center, axes, half };
}

/**
 * Road helmet as a child of the head bone, sized to the measured skull: an elongated shell that
 * covers the forehead and dips lower at the back, dark vent channels running front to back and
 * a dark rim. Built on a unit sphere (+x forward, +y up, +z side) and scaled to the skull.
 */
function buildHelmet(fit, scale = 1) {
  const shellMat = new THREE.MeshStandardMaterial({ color: '#f4f5f7', roughness: 0.38, metalness: 0.05, side: THREE.DoubleSide });
  const darkMat = new THREE.MeshStandardMaterial({ color: '#1f2228', roughness: 0.6, side: THREE.DoubleSide });
  const cut = Math.PI * 0.6; // how far down the shell reaches (from the crown)
  const unit = new THREE.Group();
  unit.add(new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, cut), shellMat));
  unit.add(new THREE.Mesh(new THREE.SphereGeometry(1.012, 40, 2, 0, Math.PI * 2, cut - 0.07, 0.07), darkMat)); // rim
  for (const t of [-0.42, -0.14, 0.14, 0.42]) { // vent channels over the top, front to back
    const g = new THREE.SphereGeometry(1.01, 28, 1, Math.PI + 0.55, Math.PI - 1.1, Math.PI / 2 + t - 0.045, 0.09);
    g.rotateX(Math.PI / 2);
    unit.add(new THREE.Mesh(g, darkMat));
  }
  // longer, slightly drawn-out tail like a road helmet
  unit.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) if (pos.getX(i) < 0) pos.setX(i, pos.getX(i) * 1.14);
    o.geometry.computeVertexNormals();
  });
  // unit sphere -> skull ellipsoid with a little padding; tilt so the back sits lower than the brow
  const [a, b, c] = fit.half;
  unit.scale.set(a * 1.12 * scale, b * 1.12 * scale, c * 1.14 * scale);
  unit.rotation.z = 0.66;
  unit.position.set(-a * 0.08, -b * 0.02, 0);
  const helmet = new THREE.Group();
  helmet.add(unit);
  const [fx, uy, sz] = fit.axes;
  helmet.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(fx, uy, sz));
  helmet.position.copy(fit.center);
  helmet.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return helmet;
}

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
      // Clothing is found by material name or by mesh name: Mixamo characters often share
      // one texture atlas between all clothes, but keep separate meshes (Ch08_Hoodie, Ch08_Pants).
      const meshName = (o.name || '').toLowerCase();
      const recolor = (m) => {
        if (cfg.kit && m.map?.image?.width && /body/.test(m.map.image.src || '')) {
          const c = m.clone();
          c.map = paintKit(m.map.image, cfg.kit, jersey, stripe);
          c.map.flipY = m.map.flipY;
          return c;
        }
        const names = [(m.name || '').toLowerCase(), meshName];
        const listed = (list) => (list || []).some((n) => names.includes(n.toLowerCase()));
        const isJersey = listed(cfg.jerseyMaterials) || (!cfg.jerseyMaterials && names.some((n) => /shirt|jersey|hood|top|torso|upper|cloth/.test(n)));
        const isShorts = listed(cfg.shortsMaterials) || (!cfg.shortsMaterials && names.some((n) => /pant|short|bottom|lower|trouser/.test(n)));
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
    // helmet: built to the measured skull and parented to the head bone, so it follows every pose;
    // the model's own hair is hidden so it can't poke through
    this.headTop = findHeadTop(this.bones.head);
    if (this.bones.head && this.headTop && cfg.helmet !== false) {
      const fwdWorld = new THREE.Vector3(1, 0, 0).applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion()));
      const fit = measureHead(this.root, this.bones.head, this.headTop, fwdWorld);
      if (fit) {
        this.bones.head.add(buildHelmet(fit, cfg.helmetScale || 1));
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
    this.root.position.add(new THREE.Vector3(-0.22 - hips.x, 0.97 - hips.y, -hips.z));
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
      const lean = THREE.MathUtils.degToRad(34); // torso angle above horizontal: low, flat road-bike back
      aim(spine, top, base.clone().addScaledVector(fwd, Math.cos(lean) * torsoLen).addScaledVector(up, Math.sin(lean) * torsoLen));
    }
    // neck and head: aim them in world space (rotateOnWorldAxis is wrong here, it assumes an
    // unrotated parent and would roll the head sideways). The neck rises more steeply than the
    // torso, and the top of the head points up and slightly forward, so the face looks up the road.
    const dirAt = (deg) => fwd.clone().multiplyScalar(Math.cos(THREE.MathUtils.degToRad(deg)))
      .addScaledVector(up, Math.sin(THREE.MathUtils.degToRad(deg)));
    if (B.neck && B.head) {
      const base = wp(B.neck);
      aim(B.neck, B.head, base.clone().addScaledVector(dirAt(55), base.distanceTo(wp(B.head))));
    }
    const headTop = this.headTop;
    if (B.head && headTop) {
      const base = wp(B.head);
      aim(B.head, headTop, base.clone().addScaledVector(dirAt(72), base.distanceTo(wp(headTop))));
    }
    // legs: feet on the pedals, knees forward
    const sideOfBone = (b) => Math.sign(G.worldToLocal(wp(b)).z) || 1;
    for (const s of ['l', 'r']) {
      const side = sideOfBone(B[s].upperLeg);
      // forward = +x, so the crank turns clockwise seen from the +z side: the top foot moves forward
      const a = -angle + (side > 0 ? Math.PI : 0);
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
