// Where on Earth a ride was (#strava-map): latitude and longitude for every metre of a route, so the FIT and TCX
// carry a GPS track and Strava, intervals.icu and Garmin draw the ride on a map.
//  - A route imported from GPX is a real road: its own coordinates (the import keeps its shape in a flat
//    projection around the first point's latitude, which turns straight back into degrees).
//  - A built-in route is made up: its shape (the one on the minimap) is laid out in the open ocean, as Zwift
//    does with Watopia, each route in a place of its own so no two overlap and none lies over a real road.

import { SEG } from './routes.js';

const R = 6371000; // m, the projection the GPX import uses (gpx.js)
const DEG = 180 / Math.PI;

export const MAP_TURN = 2.5; // the 3D renderer's curvature factor: the map has the same bends as the road you see
const shapes = new WeakMap();

/**
 * The road from above: { pts (x east, y south, m), step (m between points) }. An imported route has its
 * real shape (north up, absolute metres of the GPX projection); a built-in one is drawn from the bends the
 * 3D world is built from, starting at 0, 0.
 */
export function routeShape(route) {
  if (shapes.has(route)) return shapes.get(route);
  if (route.map?.length >= 4) {
    const pts = [];
    for (let i = 0; i < route.map.length; i += 2) pts.push([route.map[i], route.map[i + 1]]);
    const shape = { pts, step: SEG * 10 };
    shapes.set(route, shape);
    return shape;
  }
  const n = route.segments.length, pts = [];
  let x = 0, y = 0, h = 0;
  for (let i = 0; i <= n; i++) {
    if (i % 4 === 0 || i === n) pts.push([x, y]);
    const seg = route.segAt(i);
    x += Math.cos(h) * SEG; y += Math.sin(h) * SEG;
    h += (seg.curve * MAP_TURN) / SEG;
  }
  if (route.startHeading !== undefined) { // the track began heading this way on the map
    const a = route.startHeading, c = Math.cos(a), s = Math.sin(a);
    for (const p of pts) { const [px, py] = p; p[0] = px * c + py * s; p[1] = -px * s + py * c; }
  }
  const shape = { pts, step: SEG * 4 };
  shapes.set(route, shape);
  return shape;
}

/**
 * The built-in routes' start lines, in the South Pacific between New Zealand and South America: open water
 * thousands of kilometres from any coast. One degree of longitude apart (≈ 92 km there), more than any route reaches.
 */
const OCEAN = { lat: -38, lon: -128 };
const BUILT_IN = ['level', 'flat', 'lakes', 'steppe', 'rolling', 'coast', 'autumn', 'sunset', 'winter', 'desert', 'carpathians', 'mountain', 'velodrome', 'dragobrat', 'dnipro', 'dnister'];

/** Where a built-in route starts: its own slot in the ocean (an unknown id gets one from its name). */
export function oceanAnchor(id) {
  let k = BUILT_IN.indexOf(id);
  if (k < 0) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; k = BUILT_IN.length + (h % 40); }
  return { lat: OCEAN.lat - Math.floor(k / 10) * 1.0, lon: OCEAN.lon + (k % 10) * 1.0 };
}

/**
 * Latitude and longitude along a route: a function of the distance ridden (m) → [lat, lon] in degrees, or
 * null when the route has no place on the map (none given, or an imported one too old to have kept its shape).
 */
export function positionFor(route) {
  if (!route?.length) return null;
  let shape;
  try { shape = routeShape(route); } catch { return null; }
  const { pts, step } = shape;
  if (pts.length < 2) return null;
  let toDeg;
  if (route.custom) {
    if (!(route.map?.length >= 4)) return null; // an old import: only its bends, not where it is
    const lat0 = -pts[0][1] / R; // the projection's own latitude (the track's first point)
    const k = R * Math.cos(lat0);
    toDeg = ([x, y]) => [(-y / R) * DEG, (x / k) * DEG];
  } else {
    const a = oceanAnchor(route.id), k = R * Math.cos(a.lat / DEG);
    toDeg = ([x, y]) => [a.lat - (y / R) * DEG, a.lon + (x / k) * DEG];
  }
  const L = route.length, last = pts.length - 1;
  // a loop whose shape does not close (a built-in road runs on and on in the 3D world): the next lap goes on from
  // where this one ended, so the map shows one road with no straight jump back to the start
  const gx = pts[last][0] - pts[0][0], gy = pts[last][1] - pts[0][1];
  const open = !route.oneWay && Math.hypot(gx, gy) > 50;
  return (dist) => {
    let d = Number(dist) || 0, lap = 0;
    if (route.oneWay) d = Math.max(0, Math.min(L, d));
    else { lap = Math.floor(d / L); d -= lap * L; } // lap after lap over the same road
    const f = Math.min(last, d / step), i = Math.min(last - 1, Math.floor(f)), t = f - i;
    const p = pts[i], q = pts[i + 1], k = open ? lap : 0;
    return toDeg([p[0] + (q[0] - p[0]) * t + gx * k, p[1] + (q[1] - p[1]) * t + gy * k]);
  };
}
