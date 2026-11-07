// Optional custom bicycle: any glTF placed at assets/bike.glb (e.g. a CC-BY model from Sketchfab).
// It is turned to face +x, scaled to the built-in bike's size and set on the ground; a crank part,
// if the model has one, spins with the pedals. Fine-tune with assets/bike.json:
//   { "node": "Bike_02", "rotateY": 180, "length": 1.68, "offset": [0, 0, 0], "crankNode": "Cranks" }
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from '../vendor/three/addons/utils/SkeletonUtils.js';

const URL_GLB = 'assets/bike.glb';
const URL_CFG = 'assets/bike.json';
const DEFAULT_LENGTH = 1.68; // wheel to wheel, matches the built-in bike the rider is posed on

export async function loadBikeModel() {
  try {
    const head = await fetch(URL_GLB, { method: 'HEAD' });
    if (!head.ok) return null;
    let cfg = {};
    try { const r = await fetch(URL_CFG); if (r.ok) cfg = await r.json(); } catch { /* optional */ }
    const gltf = await new GLTFLoader().loadAsync(URL_GLB);
    return { gltf, cfg };
  } catch (e) {
    console.warn('Custom bike not loaded', e);
    return null;
  }
}

const byName = (root, test) => {
  let found = null;
  root.traverse((o) => { if (!found && o.name && test(o.name)) found = o; });
  return found;
};

export class ModelBike {
  constructor(model, group) {
    const { gltf, cfg } = model;
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

  pose(angle) {
    if (this.pivot) this.pivot.quaternion.setFromAxisAngle(this.axis, -angle); // top pedal moves forward
  }
}
