// Real roads from a GPX track (#25, step 1): the track is resampled every SEG metres into the same
// per-segment elevation and curvature a built-in route has, so the renderer and physics need no
// special case. GPX elevations are noisy, so they are smoothed before any grade is read from them.
import { SEG } from './routes.js';

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
 * A route definition from track points: elevation (m) and curvature per SEG-metre segment.
 * Throws when the track is too short or too long.
 */
export function routeFromTrack({ name, points }, fileName = '') {
  // local flat projection in metres (fine for a ride-sized area)
  const lat0 = points[0].lat * Math.PI / 180, R = 6371000;
  const xy = points.map((p) => [p.lon * Math.PI / 180 * R * Math.cos(lat0), p.lat * Math.PI / 180 * R]);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const total = cum[cum.length - 1];
  if (total < 1000) throw new Error('The track is shorter than 1 km');
  if (total > MAX_KM * 1000) throw new Error(`The track is longer than ${MAX_KM} km`);

  // resample positions and elevations every SEG metres
  const n = Math.floor(total / SEG) + 1;
  const hasEle = points.filter((p) => p.ele !== null).length > points.length / 2;
  const ele = points.map((p) => p.ele);
  if (hasEle) { // fill gaps with the previous known value
    let last = ele.find((e) => e !== null);
    for (let i = 0; i < ele.length; i++) { if (ele[i] === null) ele[i] = last; else last = ele[i]; }
  }
  const X = [], Y = [], E = [];
  for (let k = 0, j = 0; k < n; k++) {
    const d = k * SEG;
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const t = cum[j + 1] > cum[j] ? Math.min(1, (d - cum[j]) / (cum[j + 1] - cum[j])) : 0;
    X.push(xy[j][0] + (xy[j + 1][0] - xy[j][0]) * t);
    Y.push(xy[j][1] + (xy[j + 1][1] - xy[j][1]) * t);
    E.push(hasEle ? ele[j] + (ele[j + 1] - ele[j]) * t : 100);
  }

  // elevation: smooth over ~±60 m so grades read like a road, not like GPS jitter
  const elev = smooth(E, 8, 3);
  // heading from positions smoothed over ~±15 m, then the change per segment
  const sx = smooth(X, 3), sy = smooth(Y, 3);
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
  dh = smooth(dh, 1, 1);
  // map north-up (x east, y north) onto the renderer's heading sense: it turns toward +right for +curve
  const curve = dh.map((a) => (-a * SEG) / TURN);

  const title = name || fileName.replace(/\.gpx$/i, '') || 'My route';
  return {
    id: `gpx-${Date.now().toString(36)}`,
    name: title.slice(0, 40),
    description: `Imported from GPX${hasEle ? '' : ' (no elevation in the file: flat)'}. Point to point, finish at ${(total / 1000).toFixed(1)} km.`,
    theme: 'meadow',
    custom: true,
    oneWay: true,
    elev: elev.map((e) => Math.round(e * 10) / 10),
    curve: curve.map((c) => Math.round(c * 1e5) / 1e5),
  };
}
