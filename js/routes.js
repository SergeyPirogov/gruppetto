// Procedurally generated looped routes. Every wave period divides the loop
// length, so elevation and curves join seamlessly at the start/finish line.

export const SEG = 5; // metres per segment

// theme: visual world (see themes.js). Grades stay under ~10 %.
const ROUTES = [
  {
    id: 'flat', theme: 'river',
    name: 'Riverside',
    description: 'Flat along the river and birch groves. Good for intervals and warm-ups.',
    length: 8000,
    hills: [[3, 8000, 0], [2, 2000, 1], [1, 1000, 2]],
    curves: [[0.006, 4000, 0], [0.004, 1000, 1.3]],
  },
  {
    id: 'lakes', theme: 'river',
    name: 'Polissia Lakes',
    description: 'A long, almost flat loop past lakes and pine woods. Steady endurance miles.',
    length: 20000,
    hills: [[7.4, 20000, 0.6], [2.8, 5000, 1.2], [0.9, 2000, 2.1]],
    curves: [[0.005, 10000, 0.8], [0.004, 2500, 0.2], [0.002, 1000, 1.7]],
  },
  {
    id: 'steppe', theme: 'steppe',
    name: 'Sunflower Steppe',
    description: 'Long straights through sunflower fields. Fast and flat, ideal for ERG.',
    length: 25000,
    hills: [[6, 12500, 0], [4, 5000, 1], [2, 2500, 2]],
    curves: [[0.003, 12500, 0], [0.002, 2500, 1]],
  },
  {
    id: 'rolling', theme: 'meadow',
    name: 'Rolling Hills',
    description: 'Short climbs and descents through meadows. Great for tempo.',
    length: 12000,
    hills: [[20, 4000, 0], [10, 2000, 1], [4, 750, 2]],
    curves: [[0.008, 3000, 0.4], [0.005, 1200, 2]],
  },
  {
    id: 'coast', theme: 'coast',
    name: 'Seaside Coast',
    description: 'Palms, sand and the sea on the horizon. Gentle rollers.',
    length: 15000,
    hills: [[8, 7500, 0], [5, 2500, 1], [2, 1250, 2]],
    curves: [[0.01, 3000, 0.5], [0.004, 1500, 1]],
  },
  {
    id: 'autumn', theme: 'autumn',
    name: 'Autumn Forest',
    description: 'Golden oaks, moderate hills, a winding road.',
    length: 10000,
    hills: [[12, 5000, 0], [8, 2000, 1], [3, 1000, 2]],
    curves: [[0.012, 2500, 0], [0.006, 1000, 1]],
  },
  {
    id: 'sunset', theme: 'sunset',
    name: 'Sunset Hills',
    description: 'Looping “walls” up to 8% at sunset. For strength.',
    length: 20000,
    hills: [[25, 5000, 0], [12, 2000, 1], [3, 1000, 2]],
    curves: [[0.008, 4000, 1], [0.005, 1000, 0]],
  },
  {
    id: 'winter', theme: 'winter',
    name: 'Winter Forest',
    description: 'Snowy firs and silence. Small climbs.',
    length: 9000,
    hills: [[15, 4500, 0], [6, 1500, 1], [2, 750, 2]],
    curves: [[0.01, 2250, 0.3], [0.005, 900, 1]],
  },
  {
    id: 'desert', theme: 'desert',
    name: 'Red Canyon',
    description: 'Cacti, red rocks and one long climb.',
    length: 12000,
    hills: [[40, 12000, 0], [10, 3000, 1], [3, 1000, 2]],
    curves: [[0.009, 3000, 0], [0.006, 1200, 2]],
  },
  {
    id: 'carpathians', theme: 'carpathians',
    name: 'Carpathian Switchbacks',
    description: 'Spruce slopes, steep switchbacks and a ~4–8% climb.',
    length: 14000,
    hills: [[90, 14000, -Math.PI / 2], [15, 3500, 0.4], [4, 1000, 1]],
    curves: [[0.016, 1750, 0], [0.008, 700, 1]],
  },
  {
    id: 'mountain', theme: 'alpine',
    name: 'Mountain Pass',
    description: 'A long ~5–8% climb to snowy peaks and a fast descent.',
    length: 16000,
    hills: [[130, 16000, -Math.PI / 2], [6, 2000, 0.5], [2.5, 800, 1.5]],
    curves: [[0.012, 2000, 0], [0.006, 800, 1]],
  },
];

function wave(d, parts) {
  let s = 0;
  for (const [amp, period, phase] of parts) s += amp * Math.sin((2 * Math.PI * d) / period + phase);
  return s;
}

export class Route {
  constructor(def) {
    Object.assign(this, def);
    const n = Math.round(def.length / SEG);
    this.segments = [];
    const base = wave(0, def.hills);
    for (let i = 0; i < n; i++) {
      const d = i * SEG;
      this.segments.push({
        elev: wave(d, def.hills) - base + 100,
        curve: wave(d, def.curves),
      });
    }
    let gain = 0;
    for (let i = 0; i < n; i++) {
      const diff = this.segments[(i + 1) % n].elev - this.segments[i].elev;
      if (diff > 0) gain += diff;
    }
    this.elevationGain = gain;
    this.minElev = Math.min(...this.segments.map((s) => s.elev));
    this.maxElev = Math.max(...this.segments.map((s) => s.elev));
    this.climbs = findClimbs(this);
  }

  wrap(d) { return ((d % this.length) + this.length) % this.length; }

  elevAt(d) {
    const x = this.wrap(d) / SEG;
    const i = Math.floor(x);
    const n = this.segments.length;
    const a = this.segments[i % n].elev;
    const b = this.segments[(i + 1) % n].elev;
    return a + (b - a) * (x - i);
  }

  /** Grade as a fraction, smoothed over ±10 m. */
  gradeAt(d) {
    return (this.elevAt(d + 10) - this.elevAt(d - 10)) / 20;
  }
}

/** Made-up names for each route's climbs, in route order (more than needed is fine). */
const CLIMB_NAMES = {
  rolling: ['Shepherd\'s Rise', 'Windmill Hill', 'The Long Meadow'],
  autumn: ['Acorn Bank', 'Owl\'s Brow'],
  sunset: ['Red Sky Ramp', 'The Big Wall', 'Golden Hour Climb', 'Lantern Kick', 'The Wall Again', 'Last Light'],
  desert: ['Mesa Grade'],
  carpathians: ['Hutsul Serpentine', 'Smereka Pass'],
  mountain: ['Col du Pas'],
  coast: ['Lighthouse Bump'],
  winter: ['Snowdrift Rise'],
  steppe: ['Sunflower Kurgan'],
  flat: ['Bridge Ramp'],
};

/**
 * Timed segments: every climb that gains at least 12 m at an average of at least 2.5 %, from the
 * bottom of the rise to its top. A climb may run over the start/finish line (start > end then).
 * Each gets a name ("Climb 1", in route order), start and end distance, length, gain and grade.
 */
export function findClimbs(route, minGain = 12, minGrade = 0.025) {
  const n = route.segments.length, el = (i) => route.segments[((i % n) + n) % n].elev;
  // start the scan at the route's lowest point so no climb is split by the loop's seam
  let low = 0;
  for (let i = 1; i < n; i++) if (el(i) < el(low)) low = i;
  const found = [];
  let i = 0;
  while (i < n) {
    // walk to a local minimum, then up to the next local maximum (ignoring dips under 2 m)
    while (i < n && el(low + i + 1) <= el(low + i)) i++;
    const a = i;
    let top = i, j = i;
    while (j < n && el(low + j) >= el(low + top) - 2) { if (el(low + j) > el(low + top)) top = j; j++; }
    const gain = el(low + top) - el(low + a), len = (top - a) * SEG;
    if (len > 0 && gain >= minGain && gain / len >= minGrade) {
      found.push({ start: ((low + a) % n) * SEG, end: ((low + top) % n) * SEG, length: len, gain, grade: gain / len });
    }
    i = Math.max(top, a + 1);
  }
  found.sort((x, y) => x.start - y.start);
  const names = CLIMB_NAMES[route.id] || [];
  return found.map((c, k) => ({ ...c, id: `${route.id}-c${k + 1}`, name: names[k] || `Climb ${k + 1}` }));
}

export const routes = ROUTES.map((r) => new Route(r));
