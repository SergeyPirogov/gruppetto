// Where a road comes back near itself (out and back along one street, a hairpin, a crossing), the land and the
// scenery built around one stretch must not cover another. This is the pure geometry for that, free of three.js:
// a grid of points along the road, and what it answers about the neighbours of a place.

const KEY = 65536;

/** Distance along the road between two places, going the short way round on a loop (loopLen > 0). */
export function roadGap(a, b, loopLen = 0) {
  let g = Math.abs(a - b);
  if (loopLen > 0) { g %= loopLen; g = Math.min(g, loopLen - g); }
  return g;
}

/**
 * Whether the road point at `s`, `away` m from a place whose own centre line point is at `sOwn`, is on the same
 * stretch of road rather than another one: another stretch is farther along the road than it is away (a
 * hairpin's other leg counts, the bend itself does not).
 */
export function isOwnStretch(sOwn, s, away, loopLen = 0) {
  return roadGap(sOwn, s, loopLen) < away * 1.2 + 20; // 1.2: a bend turning 115° has its far end as the "other" stretch, a road 200 m aside and 300 m on is another one too
}

export class RoadGrid {
  /** `cell`: the side of a grid cell in metres; points are kept by the cell they fall in. */
  constructor(cell = 10) { this.cell = cell; this.cells = new Map(); this.size = 0; }

  /** A point of the road centre line: world x, z, the road's height y and its distance along the road s. */
  add(x, z, y, s) {
    const key = Math.floor(x / this.cell) * KEY + Math.floor(z / this.cell);
    let list = this.cells.get(key);
    if (!list) this.cells.set(key, list = []);
    list.push([x, z, y, s]);
    this.size++;
  }

  /** Calls fn(x, z, y, s) for every road point in the box (x0, z0)-(x1, z1), whole cells at a time (a little more). */
  inBox(x0, z0, x1, z1, fn) {
    const c = this.cell;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++) {
      for (let j = Math.floor(z0 / c); j <= Math.floor(z1 / c); j++) for (const p of this.cells.get(i * KEY + j) || []) fn(p[0], p[1], p[2], p[3]);
    }
  }

  /**
   * The nearest road point within `max` m of (x, z) that `skip(s, dist, x, z)` does not rule out, as
   * { dist, y, s }, or null.
   */
  nearest(x, z, max, skip = null) {
    const c = this.cell, r = Math.ceil(max / c), kx = Math.floor(x / c), kz = Math.floor(z / c);
    let best = null;
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const list = this.cells.get((kx + i) * KEY + kz + j);
      if (!list) continue;
      for (const [px, pz, py, s] of list) {
        const dist = Math.hypot(px - x, pz - z);
        if (dist > max || (best && dist >= best.dist)) continue;
        if (skip && skip(s, dist, px, pz)) continue;
        best = { dist, y: py, s };
      }
    }
    return best;
  }
}

/**
 * How far the land beside the road may reach before it would meet another stretch of the same road. Walks out
 * from the road's centre line point (x, z) along the direction (dx, dz) and stops where another stretch is
 * nearer than this one: halfway between the two, the same rule seen from the other road, so the two lands meet
 * and leave no gap. Another stretch is looked for within `look` m of each step. Never less than `min`, the
 * road's own width. Returns { reach, y, s, to }: the offset, the other stretch's height there, its distance along the road, and how far out the other road's far side lies (null when nothing
 * is in the way, the reach is then `far`).
 */
export function lateralReach(grid, { x, z, dx, dz, s, far, min, loopLen = 0, look = 40 }) {
  for (let t = min; t <= far; t += Math.max(2, t / 12)) { // finer near the road, coarser far out
    const px = x + dx * t, pz = z + dz * t;
    // the places of the same stretch of road do not count: they are near the centre line, not "another" road
    const o = grid.nearest(px, pz, Math.min(t, look), (s2, d, qx, qz) => isOwnStretch(s, s2, Math.hypot(qx - x, qz - z), loopLen));
    if (o && o.dist < t) {
      const reach = Math.max(min, (t + o.dist) / 2);
      return { reach, y: o.y, s: o.s, to: Math.max(reach + 12, t + o.dist + 8) }; // `to`: a little past the other road
    }
  }
  return { reach: far, y: null };
}

/**
 * Whether a thing at (x, z) with a footprint radius `half` stands on the road corridor of another stretch:
 * `other` is that stretch's nearest point ({ dist }, or null), `roadHalf` the road's half width.
 */
export function onOtherRoad(other, half, roadHalf, margin = 0.6) {
  return !!other && other.dist < roadHalf + margin + half;
}
