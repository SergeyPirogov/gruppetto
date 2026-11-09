// Villages along the made-up routes (graphics level 2): a cluster of houses on both sides every few kilometres,
// where the road is gentle, away from the start and the climbs (their crowds stand there), and not in the water.
// The same route always gets the same villages. Imported routes have their real buildings instead.

import { SEG } from './routes.js';

const rnd = (seed) => { const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const idSeed = (id) => [...String(id)].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) % 9973;

/**
 * Spans [d0, d1] of the villages and their houses as [d, offset, size, angle, floors, 'cottage'] (what render3d draws).
 * `shore`: the side where the land drops to water and how far from the road it starts ({ side, from } in m).
 */
export function villages(route, shore = null) {
  const L = route.length;
  if (!L || route.custom || route.buildings?.length || route.theme === 'desert' || L < 6000) return { spans: [], buildings: [] };
  const seed = idSeed(route.id);
  const busy = [...(route.climbs || []), ...(route.sprints || [])].map((c) => [c.start - 200, c.start + c.length + 200]);
  const elev = (d) => route.segAt(Math.floor(d / SEG)).elev;
  const spans = [], buildings = [];
  const every = 4500 + rnd(seed) * 2500; // one every 4.5–7 km
  for (let k = 0, c = 1800 + rnd(seed + 1) * 1200; c < L - 1200; k++, c += every * (0.8 + rnd(seed + k * 3.1) * 0.4)) {
    const len = 220 + rnd(seed + k * 5.3) * 220, d0 = c - len / 2, d1 = c + len / 2;
    if (busy.some(([a, b]) => d1 > a && d0 < b)) continue;
    if (Math.abs(elev(d1) - elev(d0)) / len > 0.04) continue; // a village sits on gentle ground
    spans.push([d0, d1]);
    for (const side of [-1, 1]) {
      const reach = side === shore?.side ? shore.from - 5 : Infinity; // houses stay up the bank
      if (reach < 12) continue;
      const n = 4 + Math.floor(rnd(seed + k * 7.7 + side) * 6);
      for (let q = 0; q < n; q++) {
        const h = (j) => rnd(seed + k * 13.1 + side * 5.3 + q * 2.7 + j * 0.91);
        const d = d0 + (q + 0.2 + h(0) * 0.6) / n * len;
        const o = side * Math.min(reach, 12 + h(1) * 16 + (h(2) < 0.3 ? 14 : 0)); // a front row by the road, a few further back
        buildings.push([d, o, 7 + h(3) * 3, (h(4) - 0.5) * 0.3, h(5) < 0.35 ? 2 : 1, 'cottage']);
      }
    }
  }
  return { spans, buildings };
}

/**
 * Where the road crosses a stream on a bridge (distances along the route): every 3–6 km on gentle ground, clear of
 * the start, the climbs, the sprints and the villages. None in the desert or on imported routes.
 */
export function crossings(route, spans = villages(route).spans) {
  const L = route.length;
  if (!L || route.custom || route.buildings?.length || route.theme === 'desert' || L < 5000) return [];
  const seed = idSeed(route.id) + 17;
  const busy = [...(route.climbs || []), ...(route.sprints || [])].map((c) => [c.start - 150, c.start + c.length + 150])
    .concat(spans.map(([a, b]) => [a - 150, b + 150]));
  const elev = (d) => route.segAt(Math.floor(d / SEG)).elev;
  const out = [];
  for (let k = 0, d = 1500 + rnd(seed) * 1500; d < L - 1000; k++, d += 3000 + rnd(seed + k * 4.3) * 3000) {
    if (busy.some(([a, b]) => d > a && d < b)) continue;
    if (Math.abs(elev(d + 40) - elev(d - 40)) / 80 > 0.03) continue; // a bridge lies level
    out.push(Math.round(d / SEG) * SEG);
  }
  return out;
}
