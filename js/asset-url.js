// The URL of a file under assets/ with its version (?v=<hash>, see asset-versions.js), so the saved copy
// of an older version is never used. Files without a version (local runs, untracked models) keep their URL.
import * as THREE from 'three';
import VERSIONS from './asset-versions.js';

export function assetUrl(url) {
  if (typeof document === 'undefined' || !Object.keys(VERSIONS).length) return url;
  const base = new URL('./', document.baseURI).href;
  const abs = new URL(url, document.baseURI).href;
  if (!abs.startsWith(base)) return url;
  const v = VERSIONS[abs.slice(base.length).split(/[?#]/)[0]];
  return v ? `${url}${url.includes('?') ? '&' : '?'}v=${v}` : url;
}

// every three.js loader (glTF and the files it pulls in, textures) goes through the default manager
THREE.DefaultLoadingManager.setURLModifier(assetUrl);
