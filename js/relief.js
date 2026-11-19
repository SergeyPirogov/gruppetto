// The land beside the road reads the road. Two pure parts, free of three.js:
//  1. grade shaping (every route): the road's grade averaged over a couple of hundred metres decides whether the
//     land beside it rises as a mountainside on one side and falls away on the other (a climb), opens up (a
//     descent) or stays meadow (flat), and how rocky it is;
//  2. real relief (imported GPX): the terrain model's heights on a corridor around the road, stored in the
//     route's own frame (distance along it, offset across it) so the world builds from them with no network.

import { SEG } from './routes.js';

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hash = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

// ---------- grade shaping ----------

/**
 * The road's grade (a fraction, + up) at each segment, averaged over `window` metres around it, so a land that
 * follows it changes over a long stretch of road and not with every 5 m step. A loop wraps round the start line,
 * a one-way road holds its ends.
 */
export function gradeProfile(elev, { loop = false, window = 200 } = {}) {
  const n = elev.length, h = Math.max(1, Math.round(window / SEG / 2));
  const at = (i) => (loop ? elev[((i % n) + n) % n] : elev[Math.max(0, Math.min(n - 1, i))]);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = (at(i + h) - at(i - h)) / (2 * h * SEG);
  // a second pass of a box average rounds off the corners of the central difference
  const out = new Float32Array(n), r = Math.max(1, h >> 1);
  const get = (i) => (loop ? raw[((i % n) + n) % n] : raw[Math.max(0, Math.min(n - 1, i))]);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = -r; k <= r; k++) s += get(i + k); out[i] = s / (2 * r + 1); }
  return out;
}

/**
 * What a grade does to the land beside the road. Metres are of the 3D world (already exaggerated):
 *  rise   how far the land climbs on the mountain side, far from the road
 *  drop   how far it falls on the other side
 *  lower  how far both sides sit lower on a descent (the view opens)
 *  ampK   the factor on the random hills' height (a descent has gentler ones)
 *  rocky  0..1: bare rock instead of meadow, flowers and fields
 * Under 3 % nothing changes: the flat is meadow as it always was.
 */
export function gradeShape(g) {
  const climb = smooth(0.03, 0.10, g), down = smooth(0.03, 0.08, -g);
  return { rise: 60 * climb, drop: 34 * climb, lower: 24 * down, ampK: 1 - 0.45 * down, rocky: smooth(0.04, 0.11, g) };
}

/** A smooth noise along the road, -1..1, one new value every `period` metres. */
function noise1(s, period) {
  const x = s / period, i = Math.floor(x), t = x - i, u = t * t * (3 - 2 * t);
  return (hash(i * 3.17) * (1 - u) + hash((i + 1) * 3.17) * u) * 2 - 1;
}

/**
 * Which side the mountain is on, along the road: -1 .. 1, + for the right. On a bend it is the inside (the
 * road winds round the hill); on a straight, a side that holds for a few hundred metres and changes slowly.
 * It is smooth, so the hill passes from one side to the other through a stretch where it is on neither.
 * `curve`: the route's per-segment curvature, `turn`: the factor the renderer turns it by.
 */
export function mountainSide(curve, { turn = 2.5, loop = false } = {}) {
  const n = curve.length, h = 60; // heading change over ±300 m
  const at = (i) => (loop ? curve[((i % n) + n) % n] : curve[Math.max(0, Math.min(n - 1, i))] || 0);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let dh = 0;
    for (let k = -h; k <= h; k += 2) dh += at(i + k) * 2;
    dh = (dh * turn) / SEG; // radians
    const x = dh / 0.5 + 1.2 * noise1(loop ? ((i % n) + n) % n * SEG : i * SEG, 1100);
    out[i] = Math.max(-1, Math.min(1, x * 4)); // quickly through the middle, where the hill is on neither side
  }
  return out;
}

/** A value of per-segment array `a` at distance d along the road (linear between segments). */
export function arrayAt(a, d, loop) {
  const n = a.length, x = d / SEG, i = Math.floor(x), t = x - i;
  const get = (k) => (loop ? a[((k % n) + n) % n] : a[Math.max(0, Math.min(n - 1, k))]);
  return get(i) + (get(i + 1) - get(i)) * t;
}

/**
 * The land's height beside the road from the grade shaping: metres added to the road's height at `o` m from its
 * centre (+ right), where `bias` is mountainSide at that place, `shape` its gradeShape, `gk` (0..1) how much of
 * it is allowed (less where another stretch of the road is close and the land must meet it).
 */
export function shapeOffset(o, bias, shape, gk = 1) {
  const ao = Math.abs(o);
  // steep near the road and then a plateau that keeps climbing a little: it reads as a mountainside, not a ramp
  const reach = smooth(10, 110, ao) + 0.5 * smooth(110, 300, ao);
  const s = o > 0 ? bias : -bias; // + : this side is the mountain
  const side = s > 0 ? s * shape.rise : s * shape.drop;
  return (side * reach - shape.lower * smooth(10, 160, ao)) * gk;
}

// ---------- real relief ----------

// Offsets across the road (m, + right), sparse near it where the road bed stays flat anyway, wide apart far out.
// The road itself (0) is the reference: its height is the road's own.
export const RELIEF_OFFS = [-300, -220, -160, -110, -75, -45, -20, 20, 45, 75, 110, 160, 220, 300];
const MIN_STEP = 25;          // m along the road
const MAX_BYTES = 150000;     // of base64 in the route definition: kept small, localStorage is shared by all routes
const MAX_REL = 3000;         // decimetres either way is the Int16's room: ±3276 m

/** Metres between rows for a route of this length: 25 m, wider when 150 KB would not hold the whole route. */
export function reliefStep(length) {
  const perRow = RELIEF_OFFS.length * 2 * (4 / 3);
  const rows = MAX_BYTES / perRow;
  return Math.max(MIN_STEP, Math.ceil(length / rows / SEG) * SEG);
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(str) {
  const s = atob(str), b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

/**
 * The corridor as stored in the route definition: { v, step, data }. `sample(s, o)` gives the terrain's height
 * above the road's own at `s` m along the road and `o` m across (null where the model has none: flat there).
 * Whole decimetres in an Int16, little-endian, base64: about 1.5 KB per km at 25 m.
 */
export function encodeRelief(length, sample, { loop = false } = {}) {
  const step = reliefStep(length), n = RELIEF_OFFS.length;
  const rows = loop ? Math.ceil(length / step) : Math.floor(length / step) + 2; // a loop's last row runs on into its first
  const bytes = new Uint8Array(rows * n * 2), view = new DataView(bytes.buffer);
  for (let r = 0; r < rows; r++) {
    for (let j = 0; j < n; j++) {
      const v = sample(Math.min(length, r * step), RELIEF_OFFS[j]);
      const dm = v === null || !Number.isFinite(v) ? 0 : Math.max(-MAX_REL, Math.min(MAX_REL, Math.round(v * 10)));
      view.setInt16((r * n + j) * 2, dm, true);
    }
  }
  return { v: 1, step, data: toBase64(bytes) };
}

/** Back from the stored form: { step, rows, values (decimetres) }, or null when it is not one. */
export function decodeRelief(rel) {
  if (!rel || rel.v !== 1 || !rel.data || !(rel.step > 0)) return null;
  const bytes = fromBase64(rel.data), n = RELIEF_OFFS.length;
  if (bytes.length % (n * 2)) return null;
  const view = new DataView(bytes.buffer), values = new Int16Array(bytes.length / 2);
  for (let i = 0; i < values.length; i++) values[i] = view.getInt16(i * 2, true);
  return { step: rel.step, rows: values.length / n, values };
}

/**
 * The land's height above the road's own at `s` m along it and `o` m across, in metres: bilinear between the
 * stored rows and columns, 0 on the road's centre line. A loop wraps round `loopLen`; beyond the corridor the
 * last column holds.
 */
export function reliefAt(R, s, o, loopLen = 0) {
  const n = RELIEF_OFFS.length;
  let x = s / R.step;
  if (loopLen > 0) { const per = loopLen / R.step; x = ((x % per) + per) % per; }
  const i = Math.max(0, Math.min(R.rows - 1, Math.floor(x)));
  const t = Math.max(0, Math.min(1, x - i));
  const i2 = loopLen > 0 ? (i + 1) % R.rows : Math.min(R.rows - 1, i + 1);
  // the column pair around o; the road's own centre line (0) sits between the two nearest the road
  const col = (row, j) => R.values[row * n + j] / 10;
  const at = (row) => {
    if (o <= RELIEF_OFFS[0]) return col(row, 0);
    if (o >= RELIEF_OFFS[n - 1]) return col(row, n - 1);
    let j = 0;
    while (j < n - 1 && RELIEF_OFFS[j + 1] < o) j++;
    const left = RELIEF_OFFS[j], right = RELIEF_OFFS[j + 1];
    if (left < 0 && right > 0) return o < 0 ? col(row, j) * (o / left) : col(row, j + 1) * (o / right); // across the road, through its centre line (0)
    return col(row, j) + (col(row, j + 1) - col(row, j)) * ((o - left) / (right - left));
  };
  return at(i) + (at(i2) - at(i)) * t;
}
