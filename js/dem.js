// Elevation from a terrain model (#25, step 2): the free AWS Terrain Tiles (Terrarium PNG, SRTM and
// other surveys, about 30 m), read straight from the browser. Tiles along the track are loaded once,
// then any point is sampled with bilinear interpolation.

const ZOOM = 13;                       // ~3 km tiles, ~13 m per pixel at 50° N
const SIZE = 256;
const URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/** Fractional tile coordinates of a point at zoom z (Web Mercator). */
export function tileXY(lat, lon, z = ZOOM) {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
}

/** Terrarium encoding: metres = R·256 + G + B/256 − 32768. */
export function decodeTerrarium(rgba) {
  const out = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  return out;
}

/** Browser tile loader: PNG -> elevations (Float32Array, 256×256). */
async function fetchTile(z, x, y) {
  const res = await fetch(URL(z, x, y), { mode: 'cors' });
  if (!res.ok) throw new Error(`terrain tile ${z}/${x}/${y}: HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(SIZE, SIZE) : Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return decodeTerrarium(ctx.getImageData(0, 0, SIZE, SIZE).data);
}

/**
 * Load the terrain under a track ([{lat, lon}]) and return a sampler (lat, lon) -> metres.
 * `loader(z, x, y)` resolves a tile's elevations (injectable for tests); `onProgress(done, total)`.
 */
export async function loadTerrain(points, { loader = fetchTile, onProgress, z = ZOOM } = {}) {
  // every tile the track passes through, plus the neighbour when a point sits near a tile edge
  const need = new Set();
  const add = (lat, lon) => {
    const { x, y } = tileXY(lat, lon, z);
    const tx = Math.floor(x), ty = Math.floor(y), fx = x - tx, fy = y - ty;
    for (const dx of [0, fx > 0.98 ? 1 : 0, fx < 0.02 ? -1 : 0]) for (const dy of [0, fy > 0.98 ? 1 : 0, fy < 0.02 ? -1 : 0]) need.add(`${tx + dx}/${ty + dy}`);
  };
  for (let i = 0; i < points.length; i++) {
    add(points[i].lat, points[i].lon);
    if (i) { // long straight stretches between sparse points: walk them too
      const a = points[i - 1], b = points[i], steps = Math.ceil(Math.hypot(b.lat - a.lat, (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180)) * 111320 / 500);
      for (let s = 1; s < steps; s++) add(a.lat + ((b.lat - a.lat) * s) / steps, a.lon + ((b.lon - a.lon) * s) / steps);
    }
  }
  if (need.size > 400) throw new Error('Too much terrain to load for this track');
  const tiles = new Map(), keys = [...need];
  let done = 0;
  const queue = keys.slice();
  const worker = async () => {
    while (queue.length) {
      const k = queue.shift(), [x, y] = k.split('/').map(Number);
      tiles.set(k, await loader(z, x, y));
      onProgress?.(++done, keys.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker)); // six downloads at a time

  const px = (gx, gy) => { // elevation at a global pixel
    const tx = Math.floor(gx / SIZE), ty = Math.floor(gy / SIZE), t = tiles.get(`${tx}/${ty}`);
    if (!t) return null;
    const lx = Math.min(SIZE - 1, Math.max(0, gx - tx * SIZE)), ly = Math.min(SIZE - 1, Math.max(0, gy - ty * SIZE));
    return t[ly * SIZE + lx];
  };
  return (lat, lon) => {
    const { x, y } = tileXY(lat, lon, z);
    const gx = x * SIZE - 0.5, gy = y * SIZE - 0.5, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    const a = px(ix, iy), b = px(ix + 1, iy), c = px(ix, iy + 1), d = px(ix + 1, iy + 1);
    if ([a, b, c, d].some((v) => v === null)) return null;
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}
