// Colours for the grade of the road, shared by the minimap and the elevation profile: blue going down,
// green on the flat, then yellow, orange and red as it steepens, blended between the stops.

/** [grade %, r, g, b], in rising grade. */
const STOPS = [
  [-4, 59, 130, 246],  // #3b82f6
  [-1, 20, 184, 166],  // #14b8a6
  [0, 34, 197, 94],    // #22c55e
  [1, 34, 197, 94],
  [3, 234, 179, 8],    // #eab308
  [6, 249, 115, 22],   // #f97316
  [9, 220, 38, 38],    // #dc2626
];

/** The colour for a grade in percent, as 'rgb(r,g,b)'. */
export function gradeColor(gradePct) {
  const g = Math.max(STOPS[0][0], Math.min(STOPS[STOPS.length - 1][0], gradePct));
  let i = 0;
  while (i < STOPS.length - 2 && g > STOPS[i + 1][0]) i++;
  const [g0, ...a] = STOPS[i], [g1, ...b] = STOPS[i + 1];
  const t = g1 === g0 ? 0 : (g - g0) / (g1 - g0);
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(',')})`;
}

/**
 * Points every `step` m from `from` to `to` (both included), each with the colour of the grade there.
 * `window` (m) averages the grade over that much road round each point, so a long route squeezed into a few
 * hundred pixels shows its climbs as patches rather than flickering stripes; 0 uses the road's own grade.
 */
const cache = new WeakMap(); // route -> Map(key -> runs): the map and profile redraw every frame

export function gradeRuns(route, from, to, step = 25, window = 0) {
  window = window > 20 ? Math.round(window / 10) * 10 : 0;
  let byKey = cache.get(route);
  if (!byKey) cache.set(route, (byKey = new Map()));
  const key = `${from}|${to}|${step}|${window}`;
  if (byKey.has(key)) return byKey.get(key);
  if (byKey.size > 16) byKey.clear();
  const grade = (d) => (window > 20 ? (route.elevAt(d + window / 2) - route.elevAt(d - window / 2)) / window : route.gradeAt(d));
  const out = [];
  for (let d = from; d < to; d += step) out.push({ d, color: gradeColor(grade(d) * 100) });
  out.push({ d: to, color: gradeColor(grade(to) * 100) });
  byKey.set(key, out);
  return out;
}
