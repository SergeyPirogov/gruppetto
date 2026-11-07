// Real scenery along an imported road (#25, step 3): woods, water and buildings from OpenStreetMap
// (© OpenStreetMap contributors, ODbL), fetched once at import through the Overpass API.
// What is kept is relative to the road, so the renderer can lay it out beside its own road:
//   land: one character per OFFSETS cell every LAND_STEP metres ('.' open, 'f' wood, 'w' water)
//   buildings: [distance along the road, signed offset (+ right), size, angle to the road]

export const OFFSETS = [-250, -160, -100, -60, -35, -18, 18, 35, 60, 100, 160, 250];
export const LAND_STEP = 10; // m
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const TILE = 0.04; // degrees: map areas are queried in ~4 km boxes covering the track

/** The TILE boxes [s, w, n, e] the track passes through, with a margin for the land beside it. */
export function trackBoxes(line) {
  const set = new Set();
  for (const [lat, lon] of line) {
    const m = 0.004; // ~300-400 m
    for (const dy of [-m, 0, m]) for (const dx of [-m / Math.cos((lat * Math.PI) / 180), 0, m / Math.cos((lat * Math.PI) / 180)]) {
      set.add(`${Math.floor((lat + dy) / TILE)},${Math.floor((lon + dx) / TILE)}`);
    }
  }
  return [...set].map((k) => { const [i, j] = k.split(',').map(Number); return [i * TILE, j * TILE, (i + 1) * TILE, (j + 1) * TILE].map((v) => +v.toFixed(4)); });
}

/**
 * Overpass QL for a polyline [[lat, lon], ...]: woods and water in the boxes around the track (an
 * "around" filter would miss a wood the road runs through, whose edge is far away), buildings near it.
 */
export function overpassQuery(line) {
  const ll = line.map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(',');
  const boxes = trackBoxes(line).map((b) => `(${b.join(',')})`);
  const areas = ['way["natural"="wood"]', 'way["landuse"="forest"]', 'relation["landuse"="forest"]', 'relation["natural"="wood"]',
    'way["natural"="water"]', 'relation["natural"="water"]', 'way["waterway"="riverbank"]'];
  return `[out:json][timeout:90];(`
    + areas.map((a) => boxes.map((b) => `${a}${b};`).join('')).join('')
    + `way["building"](around:150,${ll});`
    + `);out geom;`;
}

/** The track thinned to a point every ~200 m (Overpass "around" takes a polyline). */
function thin(points, step = 200) {
  const out = [[points[0].lat, points[0].lon]];
  let last = points[0];
  for (const p of points) {
    const d = Math.hypot(p.lat - last.lat, (p.lon - last.lon) * Math.cos((p.lat * Math.PI) / 180)) * 111320;
    if (d >= step) { out.push([p.lat, p.lon]); last = p; }
  }
  const e = points[points.length - 1];
  out.push([e.lat, e.lon]);
  return out;
}

/** Fetch the map data near a track; tries the next server when one is busy. */
export async function fetchOsm(points, { fetcher = fetch, timeoutMs = 60000 } = {}) {
  const line = thin(points);
  if (line.length > 900 || trackBoxes(line).length > 120) throw new Error('track too long for a map query');
  const body = new URLSearchParams({ data: overpassQuery(line) });
  let lastErr;
  for (const url of ENDPOINTS) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetcher(url, { method: 'POST', body, signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { lastErr = e; } finally { clearTimeout(timer); }
  }
  throw lastErr || new Error('no map server answered');
}

/** Join open ways into closed rings by matching end points. */
function joinRings(lines) {
  const rings = [], open = lines.filter((l) => l.length > 1).map((l) => l.slice());
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
  while (open.length) {
    let ring = open.shift();
    for (let guard = 0; !same(ring[0], ring[ring.length - 1]) && guard < 1000; guard++) {
      const i = open.findIndex((l) => same(l[0], ring[ring.length - 1]) || same(l[l.length - 1], ring[ring.length - 1]));
      if (i < 0) break;
      const l = open.splice(i, 1)[0];
      ring = ring.concat(same(l[0], ring[ring.length - 1]) ? l.slice(1) : l.slice(0, -1).reverse());
    }
    if (ring.length > 3) rings.push(ring);
  }
  return rings;
}

const kindOf = (tags = {}) => tags.building ? 'b'
  : tags.natural === 'water' || tags.waterway === 'riverbank' ? 'w'
    : tags.natural === 'wood' || tags.landuse === 'forest' ? 'f' : null;

/**
 * Road-relative land and buildings from Overpass JSON. `toXY(lat, lon)` is the route's own local
 * projection (metres, x east, y north); road samples every SEG m: X, Y and heading H (map radians).
 */
export function landFromOsm(osm, toXY, X, Y, H, SEG) {
  // polygons in local metres: { kind, outer: [[x, y]...], holes: [...], box }
  const polys = [], buildings = [];
  const ringXY = (g) => g.map((p) => toXY(p.lat, p.lon));
  for (const e of osm.elements || []) {
    const kind = kindOf(e.tags);
    if (!kind) continue;
    if (e.type === 'way' && e.geometry?.length > 3) {
      const ring = ringXY(e.geometry);
      if (kind === 'b') buildings.push(ring); else polys.push({ kind, outer: [ring], holes: [] });
    } else if (e.type === 'relation' && kind !== 'b') {
      const ways = (role) => (e.members || []).filter((m) => m.type === 'way' && m.role === role && m.geometry).map((m) => ringXY(m.geometry));
      const outer = joinRings(ways('outer'));
      if (outer.length) polys.push({ kind, outer, holes: joinRings(ways('inner')) });
    }
  }
  // spatial index of polygons (250 m cells)
  const C = 250, grid = new Map();
  for (const p of polys) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of p.outer) for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    p.box = [x0, y0, x1, y1];
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) for (let j = Math.floor(y0 / C); j <= Math.floor(y1 / C); j++) {
      const k = `${i},${j}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(p);
    }
  }
  const inRing = (x, y, r) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i][1] > y) !== (r[j][1] > y) && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
    }
    return inside;
  };
  const landAt = (x, y) => {
    let best = '.';
    for (const p of grid.get(`${Math.floor(x / C)},${Math.floor(y / C)}`) || []) {
      const [x0, y0, x1, y1] = p.box;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (!p.outer.some((r) => inRing(x, y, r)) || p.holes.some((r) => inRing(x, y, r))) continue;
      if (p.kind === 'w') return 'w'; // water wins over wood
      best = 'f';
    }
    return best;
  };

  // the land strip: right of travel is (sin h, −cos h) in map coordinates
  const every = Math.round(LAND_STEP / SEG);
  let land = '';
  for (let k = 0; k < X.length; k += every) {
    const s = Math.sin(H[k]), c = Math.cos(H[k]);
    for (const o of OFFSETS) land += landAt(X[k] + s * o, Y[k] - c * o);
  }

  // buildings: nearest road sample, signed offset, size and angle to the road
  const near = new Map(), NC = 50;
  for (let k = 0; k < X.length; k += 2) {
    const key = `${Math.floor(X[k] / NC)},${Math.floor(Y[k] / NC)}`;
    if (!near.has(key)) near.set(key, []);
    near.get(key).push(k);
  }
  const out = [];
  for (const ring of buildings) {
    let cx = 0, cy = 0, area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      area += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
    }
    if (Math.abs(area) < 1) continue;
    cx /= 3 * area; cy /= 3 * area;
    let bk = -1, bd = Infinity;
    const gi = Math.floor(cx / NC), gj = Math.floor(cy / NC);
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
      for (const k of near.get(`${gi + i},${gj + j}`) || []) {
        const d = (X[k] - cx) ** 2 + (Y[k] - cy) ** 2;
        if (d < bd) { bd = d; bk = k; }
      }
    }
    if (bk < 0) continue;
    const s = Math.sin(H[bk]), c = Math.cos(H[bk]), off = (cx - X[bk]) * s - (cy - Y[bk]) * c;
    if (Math.abs(off) < 7 || Math.abs(off) > 150) continue; // not on the road, not beyond the view
    // longest edge -> the building's orientation
    let la = 0, ll = 0;
    for (let i = 1; i < ring.length; i++) {
      const dx = ring[i][0] - ring[i - 1][0], dy = ring[i][1] - ring[i - 1][1], l = Math.hypot(dx, dy);
      if (l > ll) { ll = l; la = Math.atan2(dy, dx); }
    }
    const size = Math.max(5, Math.min(30, Math.sqrt(Math.abs(area) / 2)));
    out.push([bk * SEG, Math.round(off * 10) / 10, Math.round(size * 10) / 10, Math.round((la - H[bk]) * 100) / 100]);
    if (out.length >= 4000) break;
  }
  out.sort((a, b) => a[0] - b[0]);
  return { land, buildings: out };
}
