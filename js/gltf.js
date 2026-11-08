// One glTF loader setup for every model: meshopt-compressed files (tools: gltf-transform meshopt) decode here.
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/three/addons/libs/meshopt_decoder.module.js';

export function gltfLoader(manager) {
  return new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
}
