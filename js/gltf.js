// One glTF loader setup for every model: meshopt-compressed files (tools: gltf-transform meshopt) decode here.
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/three/addons/libs/meshopt_decoder.module.js';
import './asset-url.js'; // versioned model URLs for every loader

/** Anisotropic filtering for every texture (set from the graphics card by the renderer): sharp at a slant. */
export const ANISO = { value: 4 };

/** Every texture of a model filtered with ANISO (glTF's come with none: blurry on a jersey or a tyre seen aslant). */
export function sharpen(root) {
  root.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      for (const v of Object.values(m)) if (v?.isTexture && v.anisotropy < ANISO.value) { v.anisotropy = ANISO.value; v.needsUpdate = true; }
    }
  });
}

export function gltfLoader(manager) {
  const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
  const load = loader.loadAsync.bind(loader);
  loader.loadAsync = async (...args) => { const gltf = await load(...args); sharpen(gltf.scene); return gltf; };
  return loader;
}
