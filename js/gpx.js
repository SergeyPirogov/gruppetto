// Real roads from a GPX track (#25, step 1): the track is resampled every SEG metres into the same
// per-segment elevation and curvature a built-in route has, so the renderer and physics need no
// special case. GPX elevations are noisy, so they are smoothed before any grade is read from them.
import { SEG } from './routes.js';
import { landFromOsm } from './osm.js';

const TURN = 2.5;          // the 3D renderer multiplies curvature by this; divide it back out
const MAX_KM = 150;
const MIN_RADIUS = 12;     // m: tighter kinks in the track are GPS noise, not road

/** Track points [{lat, lon, ele|null}] and the track's name from GPX text. */
export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This file is not valid GPX');
  let pts = [...doc.getElementsByTagName('trkpt')];
  if (pts.length < 2) pts = [...doc.getElementsByTagName('rtept')];
  if (pts.length < 2) throw new Error('No track points in this GPX file');
  const name = doc.querySelector('trk > name, rte > name, metadata > name')?.textContent.trim() || '';
  return {
    name,
    points: pts.map((p) => {
      const e = p.getElementsByTagName('ele')[0];
      const ele = e ? parseFloat(e.textContent) : NaN;
      return { lat: parseFloat(p.getAttribute('lat')), lon: parseFloat(p.getAttribute('lon')), ele: Number.isFinite(ele) ? ele : null };
    }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)),
  };
}

/** Moving average with radius r (in samples), repeated `passes` times (≈ a Gaussian). */
function smooth(a, r, passes = 2) {
  let src = a;
  for (let p = 0; p < passes; p++) {
    const out = new Array(src.length), n = src.length;
    let sum = 0, cnt = 0;
    for (let i = -r; i <= r; i++) if (i >= 0 && i < n) { sum += src[i]; cnt++; }
    for (let i = 0; i < n; i++) {
      out[i] = sum / cnt;
      const add = i + r + 1, drop = i - r;
      if (add < n) { sum += src[add]; cnt++; }
      if (drop >= 0) { sum -= src[drop]; cnt--; }
    }
    src = out;
  }
  return src;
}

/**
 * A smooth curve through the points (centripetal Catmull-Rom, no loops or overshoot on uneven
 * spacing), sampled every ~2 m; elevations follow linearly along each span.
 */
function curveThrough(pts, ele) {
  const P = [], E = [];
  pts.forEach((p, i) => { // drop repeated points
    if (!P.length || Math.hypot(p[0] - P[P.length - 1][0], p[1] - P[P.length - 1][1]) > 0.5) { P.push(p); E.push(ele[i]); }
  });
  if (P.length < 3) return { xy: P, ele: E };
  const xy = [P[0]], out = [E[0]];
  const knot = (a, b) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])) || 1e-6;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    const t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), m = Math.max(1, Math.ceil(len / 2));
    for (let k = 1; k <= m; k++) {
      const t = t1 + ((t2 - t1) * k) / m;
      const lerp = (a, b, ta, tb) => [0, 1].map((c) => (tb === ta ? a[c] : ((tb - t) * a[c] + (t - ta) * b[c]) / (tb - ta)));
      const A1 = lerp(p0, p1, 0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, 0, t2), B2 = lerp(A2, A3, t1, t3);
      const C = lerp(B1, B2, t1, t2);
      xy.push(C);
      out.push(E[i] === null || E[i] === undefined ? null : E[i] + (E[i + 1] - E[i]) * (k / m));
    }
  }
  return { xy, ele: out };
}

/** Running median with radius r (in samples): removes dips and spikes narrower than ~2r, keeps slopes. */
function median(a, r) {
  const n = a.length, out = new Array(n), win = [];
  for (let i = 0; i < n; i++) {
    win.length = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) win.push(a[k]);
    win.sort((x, y) => x - y);
    out[i] = win[win.length >> 1];
  }
  return out;
}

/**
 * A route definition from track points: elevation (m) and curvature per SEG-metre segment.
 * `elevation(lat, lon)`, when given, is a terrain model sampled every SEG metres along the road
 * (null where it has no data); otherwise the track's own elevations are used. `osm`: Overpass JSON
 * of the area, turned into road-relative woods, water and buildings.
 * Throws when the track is too short or too long.
 */
export function routeFromTrack({ name, points }, fileName = '', { elevation, osm } = {}) {
  // local flat projection in metres (fine for a ride-sized area)
  const lat0 = points[0].lat * Math.PI / 180, R = 6371000;
  const xy0 = points.map((p) => [p.lon * Math.PI / 180 * R * Math.cos(lat0), p.lat * Math.PI / 180 * R]);
  const hasEle = points.filter((p) => p.ele !== null).length > points.length / 2;
  const rawEle = points.map((p) => p.ele);
  if (hasEle) { // fill gaps with the previous known value
    let last = rawEle.find((e) => e !== null);
    for (let i = 0; i < rawEle.length; i++) { if (rawEle[i] === null) rawEle[i] = last; else last = rawEle[i]; }
  }
  // the road between the track's points: a smooth curve through them (centripetal Catmull-Rom),
  // not straight lines with a kink at every point; planner tracks have points tens of metres apart
  const { xy, ele } = curveThrough(xy0, rawEle);

  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const total = cum[cum.length - 1];
  if (total < 1000) throw new Error('The track is shorter than 1 km');
  if (total > MAX_KM * 1000) throw new Error(`The track is longer than ${MAX_KM} km`);

  // resample positions and elevations every SEG metres
  const n = Math.floor(total / SEG) + 1;
  const X = [], Y = [], E = [];
  let fromTerrain = 0;
  for (let k = 0, j = 0; k < n; k++) {
    const d = k * SEG;
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const t = cum[j + 1] > cum[j] ? Math.min(1, (d - cum[j]) / (cum[j + 1] - cum[j])) : 0;
    X.push(xy[j][0] + (xy[j + 1][0] - xy[j][0]) * t);
    Y.push(xy[j][1] + (xy[j + 1][1] - xy[j][1]) * t);
    const own = hasEle ? ele[j] + (ele[j + 1] - ele[j]) * t : null;
    // the terrain model at this point of the road (back from the local projection to lat/lon)
    const dem = elevation ? elevation((Y[k] / R) * 180 / Math.PI, (X[k] / (R * Math.cos(lat0))) * 180 / Math.PI) : null;
    if (dem !== null && Number.isFinite(dem)) fromTerrain++;
    E.push(dem !== null && Number.isFinite(dem) ? dem : own ?? (E.length ? E[E.length - 1] : 100));
  }
  const source = fromTerrain > n * 0.9 ? 'terrain' : hasEle ? 'gpx' : 'none';

  // elevation: a terrain model sees the valley under a bridge and the hill over a tunnel, so a
  // running median (±100 m) first drops dips and humps narrower than that; then smooth over ~±60 m
  // so the grade changes over a hundred metres or so, like a road's, not with every 1 m step of the
  // survey or every GPS wobble
  const elev = smooth(median(E, source === 'terrain' ? 20 : 6), 16, 3);
  // heading from positions smoothed over ~±20 m, then the change per segment
  const sx = smooth(X, 4), sy = smooth(Y, 4);
  const head = [];
  for (let k = 0; k < n - 1; k++) head.push(Math.atan2(sy[k + 1] - sy[k], sx[k + 1] - sx[k]));
  head.push(head[head.length - 1]);
  const maxTurn = SEG / MIN_RADIUS;
  let dh = [];
  for (let k = 0; k < n; k++) {
    let a = k + 1 < n ? head[k + 1] - head[k] : 0;
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    dh.push(Math.max(-maxTurn, Math.min(maxTurn, a)));
  }
  dh = smooth(dh, 3, 2); // bends come in and out gradually
  // map north-up (x east, y north) onto the renderer's heading sense: it turns toward +right for +curve
  const curve = dh.map((a) => (-a * SEG) / TURN);

  const title = name || fileName.replace(/\.gpx$/i, '') || 'My route';
  const scenery = osm ? landFromOsm(osm, (la, lo) => [lo * Math.PI / 180 * R * Math.cos(lat0), la * Math.PI / 180 * R], sx, sy, head, SEG) : null;
  return {
    ...(scenery || {}),
    id: `gpx-${Date.now().toString(36)}`,
    name: title.slice(0, 40),
    description: `Imported from GPX${source === 'none' ? ' (no elevation in the file: flat)' : source === 'terrain' ? ' (elevation from a terrain model)' : ''}. Point to point, finish at ${(total / 1000).toFixed(1)} km.`,
    elevSource: source,
    startHeading: Math.round(head[0] * 1000) / 1000, // map radians (from east, anticlockwise)
    // the real shape for the minimap, every 50 m, north up (x east, y south), in whole metres
    map: Array.from({ length: Math.ceil(n / 10) + 1 }, (_, i) => Math.min(n - 1, i * 10)).flatMap((k) => [Math.round(sx[k]), Math.round(-sy[k])]),
    theme: 'meadow',
    custom: true,
    oneWay: true,
    elev: elev.map((e) => Math.round(e * 100) / 100), // cm: at 0.1 m the 20 m grade could only move in 0.5 % steps
    curve: curve.map((c) => Math.round(c * 1e5) / 1e5),
  };
}
