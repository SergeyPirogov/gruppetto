// Real roads from a GPX track (#25, step 1): the track is resampled every SEG metres into the same
// per-segment elevation and curvature a built-in route has, so the renderer and physics need no
// special case. GPX elevations are noisy, so they are smoothed before any grade is read from them.
import { SEG } from './routes.js';
import { landFromOsm } from './osm.js';
import { encodeRelief } from './relief.js';

const TURN = 2.5;          // the 3D renderer multiplies curvature by this; divide it back out
const MAX_KM = 150;
const MIN_RADIUS = 12;     // m: tighter kinks in the track are GPS noise, not road
const LOOP_GAP = 1000;     // m: a track ending this close to its start is ridden as a loop

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
  // a track that ends near where it began (within 1 km) becomes a loop: the road runs on from the end
  // back to the start, so you can ride it lap after lap
  const gap = Math.hypot(xy0[xy0.length - 1][0] - xy0[0][0], xy0[xy0.length - 1][1] - xy0[0][1]);
  const loop = gap < LOOP_GAP && xy0.length > 3;
  if (loop && gap > 1) { xy0.push(xy0[0].slice()); rawEle.push(rawEle[0]); }
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
  // a loop is smoothed round the start line too: its end runs on into its beginning
  const wrap = (a, fn) => {
    if (!loop || a.length < 400) return fn(a);
    const P = 200, ext = fn(a.slice(-P).concat(a, a.slice(0, P)));
    return ext.slice(P, P + a.length);
  };
  const elev = wrap(E, (a) => smooth(median(a, source === 'terrain' ? 20 : 6), 16, 3));
  // heading from positions smoothed over ~±20 m, then the change per segment
  const sx = wrap(X, (a) => smooth(a, 4)), sy = wrap(Y, (a) => smooth(a, 4));
  const head = [];
  for (let k = 0; k < n - 1; k++) head.push(Math.atan2(sy[k + 1] - sy[k], sx[k + 1] - sx[k]));
  head.push(head[head.length - 1]);
  // The renderer builds the road from the turn of each segment alone, adding them up from the start. Turns
  // read off the track drifted: a tenth of a degree too much here, a clamped corner there, and 1 km on the
  // road ran 160 m from where the track was, 5 km on, kilometres; it crossed itself where the track never
  // did, with the ground, the fences and the houses of one stretch standing on another. So the turns are
  // steered: each segment aims at the track 20 m ahead from where the road has got to (pure pursuit, the
  // same arcs the renderer draws), and the road stays within a metre or two of the track all the way.
  // The road is not the track: it cuts the corners, so it is shorter, and a lap of it is a few segments short
  // of the track's length (60 m on a 2 km block of four corners, 300 m on 5 km of town). Everything that sits
  // on the road is therefore laid out along the ROAD, not the track: the elevation (taken from the track point
  // the road is at), the scenery (from the road's own positions and headings), the minimap, the length.
  // Before, all of it was indexed by track distance while the renderer walked the road, so houses and woods
  // slid up to 300 m along it, and a loop did not close: the next lap began 50-100 m and 30-40 degrees off the
  // end of the last, and short routes ridden lap after lap drew over themselves.
  const maxTurn = SEG / MIN_RADIUS, LOOK = 4;
  const arcStep = (h0, h1) => {
    const a = h1 - h0;
    if (Math.abs(a) < 1e-6) return [Math.cos(h0) * SEG, Math.sin(h0) * SEG];
    const k = SEG / a;
    return [k * (Math.sin(h1) - Math.sin(h0)), -k * (Math.cos(h1) - Math.cos(h0))];
  };
  const idx = (i) => (loop ? ((i % n) + n) % n : Math.min(n - 1, i));
  /**
   * Drive the road from state s = [x, y, heading] over the track `laps` times (once for a one-way track).
   * States RX/RY/RH are those at the start of each segment, AT the track point (counted on round a loop) the
   * road is nearest to then; dh the turn of each segment.
   */
  const drive = (s, laps) => {
    let [px, py, H] = s, at = 0;
    const RX = [], RY = [], RH = [], AT = [], dh = [];
    for (let k = 0; k < 3 * n * laps; k++) {
      // the road cuts corners, so it runs ahead of the track's count: find where it is on the track, searching
      // only a step or two on from last time (a 5 m step of road can't be further on than that: out and back
      // along a street, the way back lies right beside you and must not be taken for where you are), then aim
      // 20 m on from there; at the end of a one-way track, ride straight on
      let bd = Infinity, bi = at;
      for (let i = at; i <= at + 3; i++) { const q = idx(i), d = (sx[q] - px) ** 2 + (sy[q] - py) ** 2; if (d < bd) { bd = d; bi = i; } }
      at = bi;
      RX.push(px); RY.push(py); RH.push(H); AT.push(at);
      // the whole track is behind the road (a one-way road goes on, straight, to the track's own length: the
      // rider was promised that many kilometres)
      if (at >= (loop ? n * laps : n - 1) && (loop || k >= n - 1)) break;
      const j = idx(at + LOOK), tx = sx[j] - px, ty = sy[j] - py, Ld = Math.hypot(tx, ty);
      let alpha = Ld > SEG && (loop || at + LOOK < n - 1) ? Math.atan2(ty, tx) - H : 0;
      while (alpha > Math.PI) alpha -= 2 * Math.PI;
      while (alpha < -Math.PI) alpha += 2 * Math.PI;
      // the arc through the target: curvature 2 sin(alpha) / Ld (pure pursuit); a target behind (the top of a
      // U-turn): as hard as allowed, its way
      const turn = Math.abs(alpha) > Math.PI / 2 ? Math.sign(alpha) * maxTurn : (2 * Math.sin(alpha) * SEG) / Math.max(Ld, SEG);
      const d = Math.max(-maxTurn, Math.min(maxTurn, turn));
      dh.push(d);
      const [ox, oy] = arcStep(H, H + d);
      px += ox; py += oy; H += d;
    }
    return { RX, RY, RH, AT, dh, m: dh.length };
  };
  let road;
  if (!loop) road = drive([X[0], Y[0], head[0]], 1); // a one-way road starts on the track's first point (the smoothed one is pulled inward at the ends)
  else {
    // A loop must close: the lap ends in the state it began in, or the next lap lies on another heading and
    // another place. So the road is driven three times round, the first two laps settling it onto the track
    // (it starts from the smoothed track, not from the road's own heading), and one lap is cut from the third.
    // It is cut on a straight, where a segment more or less along the road makes no difference to heading,
    // where it ends nearest to where it began; then bent a hair (a few numbers, spread over the whole lap) so
    // that it closes exactly; and turned round to begin at the start line.
    const run = drive([sx[0], sy[0], head[0]], 3);
    const bend = (i) => { let b = 0; for (let k = i - 6; k <= i + 6; k++) b += Math.abs(run.dh[Math.max(0, Math.min(run.m - 1, k))]); return b; };
    let ks = -1;
    for (let k = 0; k < run.m; k++) if (run.AT[k] >= n && run.AT[k] < n + n / 2 && (ks < 0 || bend(k) < bend(ks))) ks = k;
    const s = [run.RX[ks], run.RY[ks], run.RH[ks]];
    let ke = -1, best = Infinity;
    for (let k = ks + 1; k < run.m; k++) {
      if (run.AT[k] < run.AT[ks] + n - 4) continue;
      if (run.AT[k] > run.AT[ks] + n + 4) break;
      const dHd = Math.atan2(Math.sin(run.RH[k] - s[2]), Math.cos(run.RH[k] - s[2])) * 20;
      const e = Math.hypot(run.RX[k] - s[0], run.RY[k] - s[1], dHd);
      if (e < best) { best = e; ke = k; }
    }
    const m = ke - ks, dh = run.dh.slice(ks, ke), turns = Math.round((run.RH[ke] - s[2]) / (2 * Math.PI));
    const walk = (d, from = s) => { // the lap from a state: its end state, and every state on the way
      let [x, y, H] = from;
      const RX = [], RY = [], RH = [];
      for (let k = 0; k < m; k++) { RX.push(x); RY.push(y); RH.push(H); const [ox, oy] = arcStep(H, H + d[k]); x += ox; y += oy; H += d[k]; }
      return { RX, RY, RH, end: [x, y, H] };
    };
    const bent = (c) => dh.map((d, k) => d + c[0] + c[1] * Math.cos((2 * Math.PI * k) / m) + c[2] * Math.sin((2 * Math.PI * k) / m));
    const gap = (c) => { const e = walk(bent(c)).end; return [e[0] - s[0], e[1] - s[1], (e[2] - s[2] - turns * 2 * Math.PI) * 20]; };
    let c = [0, 0, 0];
    for (let it = 0; it < 8; it++) { // Newton on the three numbers: the end position and heading back to the start's
      const r = gap(c);
      if (Math.hypot(...r) < 0.02) break;
      const J = [0, 1, 2].map((q) => { const c2 = c.slice(); c2[q] += 1e-4; return gap(c2).map((v, i) => (v - r[i]) / 1e-4); }); // J[q][i]
      const A = [0, 1, 2].map((i) => [J[0][i], J[1][i], J[2][i]]);
      const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
      const D = det(A);
      if (Math.abs(D) < 1e-12) break;
      const dc = [0, 1, 2].map((q) => det(A.map((row, i) => row.map((v, j) => (j === q ? -r[i] : v)))) / D); // Cramer's rule
      // a step that does not shrink the gap is halved (a lap that crosses itself can send the full step far off)
      const norm = (v) => Math.hypot(...v);
      let f = 1;
      while (f > 0.02 && norm(gap(c.map((v, q) => v + f * dc[q]))) >= norm(r)) f /= 2;
      if (f <= 0.02) break;
      c = c.map((v, q) => v + f * dc[q]);
    }
    const closed = bent(c), lap = walk(closed);
    // begin at the start line: the segment whose track point is nearest the track's first
    const T = run.AT.slice(ks, ke);
    let r0 = 0, rd = Infinity;
    for (let j = 0; j < m; j++) { const t = T[j] % n, d = Math.min(t, n - t); if (d < rd) { rd = d; r0 = j; } }
    const turnTo = (a) => a.slice(r0).concat(a.slice(0, r0));
    const from = [lap.RX[r0], lap.RY[r0], lap.RH[r0]];
    road = { ...walk(turnTo(closed), from), dh: turnTo(closed), m, AT: T.slice(r0).concat(T.slice(0, r0).map((t) => t + n)).map((t) => t - T[r0]) };
  }
  const { RX, RY, RH, dh, m } = road;
  // the track point each road segment is at, smoothed (it advances in steps of one to three), unrolled round a loop
  const unroll = (a, off) => (loop ? a.slice(-30).map((v) => v - off).concat(a, a.slice(0, 30).map((v) => v + off)) : a);
  const ti = loop ? smooth(unroll(road.AT, n), 6).slice(30, 30 + m) : smooth(road.AT, 6);
  const at = (arr, t) => { // a per-track-segment array at fractional track index t
    if (loop) t = ((t % n) + n) % n;
    t = Math.max(0, Math.min(n - 1, t));
    const i = Math.floor(t), j = loop ? (i + 1) % n : Math.min(n - 1, i + 1);
    return arr[i] + (arr[j] - arr[i]) * (t - i);
  };
  const elevRoad = ti.map((t) => at(elev, t));
  // where the road comes back over itself (out and back along a street, a crossing) the two passes are one
  // place: one height. They were smoothed apart, a metre or two, and the two road surfaces cut through each
  // other. Each point takes the mean of the passes within 7 m of it (fully within 3 m, blending out to 7 m)
  const cell = (x, y) => `${Math.floor(x / 10)},${Math.floor(y / 10)}`, grid = new Map();
  for (let k = 0; k < m; k++) { const c = cell(RX[k], RY[k]); if (!grid.has(c)) grid.set(c, []); grid.get(c).push(k); }
  const along = (a, b) => { const d = Math.abs(a - b) * SEG; return loop ? Math.min(d, m * SEG - d) : d; };
  const flat = elevRoad.slice();
  for (let k = 0; k < m; k++) {
    let sum = 0, wsum = 0;
    const cx = Math.floor(RX[k] / 10), cy = Math.floor(RY[k] / 10);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of grid.get(`${cx + i},${cy + j}`) || []) {
      if (along(k, q) < 60) continue;
      const w = 1 - Math.min(1, Math.max(0, (Math.hypot(RX[q] - RX[k], RY[q] - RY[k]) - 3) / 4));
      if (w > 0) { sum += w * elevRoad[q]; wsum += w; }
    }
    if (wsum > 0) { const w = Math.min(1, wsum); flat[k] = elevRoad[k] + (sum / wsum - elevRoad[k]) * w * 0.5; }
  }
  // map north-up (x east, y north) onto the renderer's heading sense: it turns toward +right for +curve
  const curve = dh.map((a) => (-a * SEG) / TURN);

  const title = name || fileName.replace(/\.gpx$/i, '') || 'My route';
  const length = m * SEG;
  const scenery = osm ? landFromOsm(osm, (la, lo) => [lo * Math.PI / 180 * R * Math.cos(lat0), la * Math.PI / 180 * R], RX, RY, RH, SEG) : null;
  // The real relief beside the road, from the terrain model already loaded for the elevations: its height on a
  // corridor in the road's own frame, kept in the route so the ride needs no network. The frame is the one the
  // renderer replays from the curve: along the road from segment k's start, across it to the right of its
  // heading (map east/north: right of heading h is (sin h, -cos h)).
  const relief = elevation && source === 'terrain' ? encodeRelief(length, (s, o) => {
    const k = Math.min(m - 1, Math.round(s / SEG));
    const x = RX[k] + Math.sin(RH[k]) * o, y = RY[k] - Math.cos(RH[k]) * o;
    const h = elevation((y / R) * 180 / Math.PI, (x / (R * Math.cos(lat0))) * 180 / Math.PI);
    return h === null || !Number.isFinite(h) ? null : h - flat[k];
  }, { loop }) : null;
  return {
    ...(scenery || {}),
    ...(relief ? { relief } : {}),
    id: `gpx-${Date.now().toString(36)}`,
    name: title.slice(0, 40),
    description: `Imported from GPX${source === 'none' ? ' (no elevation data in the file, so flat)' : source === 'terrain' ? ' (elevation from a terrain model)' : ''}. ${loop ? `A loop of ${(length / 1000).toFixed(1)} km.` : `Point to point, finish at ${(length / 1000).toFixed(1)} km.`}`,
    elevSource: source,
    startHeading: Math.round(RH[0] * 1000) / 1000, // map radians (from east, anticlockwise)
    // the road's shape for the minimap, every 50 m, north up (x east, y south), in whole metres
    map: Array.from({ length: Math.ceil(m / 10) + 1 }, (_, i) => Math.min(m - 1, i * 10)).flatMap((k) => [Math.round(RX[k]), Math.round(-RY[k])]),
    theme: 'meadow',
    custom: true,
    oneWay: !loop,
    elev: flat.map((e) => Math.round(e * 100) / 100), // cm: at 0.1 m the 20 m grade could only move in 0.5 % steps
    curve: curve.map((c) => Math.round(c * 1e5) / 1e5),
  };
}
