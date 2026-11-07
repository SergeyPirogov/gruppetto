// Scenery models from Quaternius' Stylized Nature MegaKit (CC0), prepared by tools/prepare_nature.py
// into assets/nature/. Each scenery type (oak, pine, bush...) gets a few model variants; every
// variant is split into parts by material (bark, leaves...) so the scene can draw thousands of
// copies with one InstancedMesh per part. Without the files the scene keeps its built-in shapes.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';

const DIR = 'assets/nature/';

/** Scenery type -> model files and the height (m) the type should have at instance scale 1. */
export const NATURE_TYPES = {
  oak: { models: ['CommonTree_1', 'CommonTree_2', 'CommonTree_5'], height: 8.6 },
  birch: { models: ['CommonTree_3', 'CommonTree_4'], height: 9.5 },
  pine: { models: ['Pine_1', 'Pine_2', 'Pine_3', 'Pine_4', 'Pine_5'], height: 10 },
  bush: { models: ['Bush_Common', 'Bush_Common_Flowers'], height: 1.35 },
  rock: { models: ['Rock_Medium_1', 'Rock_Medium_2', 'Rock_Medium_3'], height: 1.1 },
  tuft: { models: ['Grass_Common_Short', 'Grass_Wispy_Short'], height: 0.6 },
  flower: { models: ['Flower_3_Single', 'Flower_4_Single'], height: 0.55 },
  fern: { models: ['Fern_1'], height: 1.0 },
  clover: { models: ['Clover_1'], height: 0.35 },
  mushroom: { models: ['Mushroom_Common'], height: 0.32 },
};

/**
 * Material name in the glTF -> texture file and how it is coloured:
 * 'leaf' keeps the texture's light and shade but takes its hue from the route palette,
 * 'plain' uses the texture as is (colour atlases: grass, flowers, fern).
 */
export const NATURE_MATERIALS = {
  Bark_NormalTree: { map: 'Bark_NormalTree.png', mode: 'plain' },
  Leaves_NormalTree: { map: 'Leaves_NormalTree_C.png', mode: 'leaf', alpha: true },
  Leaves_Pine: { map: 'Leaf_Pine_C.png', mode: 'leaf', alpha: true },
  Leaves_TwistedTree: { map: 'Leaves_TwistedTree_C.png', mode: 'leaf', alpha: true },
  Leaves: { map: 'Leaves.png', mode: 'plain', alpha: true },
  Flowers: { map: 'Flowers.png', mode: 'plain', alpha: true },
  Grass: { map: 'Grass.png', mode: 'plain', alpha: true },
  Rocks: { map: 'Rocks_Diffuse.png', mode: 'plain' },
  Mushrooms: { map: 'Mushrooms.png', mode: 'plain' },
};

/** Merges a loaded glTF scene into one geometry per material, in model space. */
function partsOf(scene) {
  scene.updateMatrixWorld(true);
  const byMat = new Map();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    const name = o.material?.name || 'default';
    (byMat.get(name) || byMat.set(name, []).get(name)).push(g.index ? g.toNonIndexed() : g);
  });
  const parts = [];
  for (const [material, geoms] of byMat) parts.push({ material, geometry: mergeGeometries(geoms) });
  return parts;
}

function mergeGeometries(geoms) {
  if (geoms.length === 1) return geoms[0];
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    if (!geoms.every((g) => g.attributes[name])) continue;
    const size = geoms[0].attributes[name].itemSize;
    const arr = new Float32Array(geoms.reduce((n, g) => n + g.attributes[name].count * size, 0));
    let o = 0;
    for (const g of geoms) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
}

/**
 * Loads every model once. Resolves to { types: {type: [variant: [{material, geometry}]]}, textures }
 * or null when the files are missing (the scene then keeps its built-in shapes).
 */
export async function loadNature() {
  try {
    const head = await fetch(`${DIR}${NATURE_TYPES.oak.models[0]}.gltf`, { method: 'HEAD' });
    if (!head.ok) return null;
  } catch { return null; }
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const textures = {};
  for (const [name, m] of Object.entries(NATURE_MATERIALS)) {
    const t = texLoader.load(`${DIR}textures/${m.map}`);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    textures[name] = t;
  }
  const types = {};
  await Promise.all(Object.entries(NATURE_TYPES).map(async ([type, def]) => {
    const variants = await Promise.all(def.models.map(async (file) => partsOf((await loader.loadAsync(`${DIR}${file}.gltf`)).scene)));
    // one scale for the whole type, so variants keep their relative sizes
    const heights = variants.map((parts) => {
      const box = new THREE.Box3();
      for (const p of parts) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); }
      return box.max.y - Math.max(0, box.min.y);
    });
    const s = def.height / (heights.reduce((a, b) => a + b, 0) / heights.length);
    for (const parts of variants) for (const p of parts) { p.geometry.scale(s, s, s); p.geometry.computeBoundingSphere(); }
    types[type] = variants;
  }));
  return { types, textures };
}

/**
 * Materials for one route. `tints` maps a material name to a colour: for 'leaf' materials the hue
 * of the texture is replaced by it (light and shade kept), for others it multiplies the texture.
 */
export function natureMaterials(nature, tints = {}) {
  const mats = {};
  for (const [name, def] of Object.entries(NATURE_MATERIALS)) {
    const m = new THREE.MeshLambertMaterial({
      map: nature.textures[name],
      color: tints[name] ? new THREE.Color(tints[name]) : new THREE.Color(1, 1, 1),
      alphaTest: def.alpha ? 0.5 : 0,
      side: def.alpha ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (def.mode === 'leaf') {
      // texture luminance (≈0.3 on average for the green maps) scales the tint colour, lifted a little
      // so dense crowns do not turn black in shade
      m.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `
          vec4 texel = texture2D( map, vMapUv );
          float lum = dot( texel.rgb, vec3( 0.299, 0.587, 0.114 ) );
          diffuseColor.rgb *= clamp( 0.35 + lum * 2.4, 0.0, 1.7 );
          diffuseColor.a *= texel.a;`);
      };
      m.customProgramCacheKey = () => 'nature-leaf';
    }
    mats[name] = m;
  }
  return mats;
}
