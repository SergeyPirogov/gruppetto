// Procedurally generated looped routes. Every wave period divides the loop
// length, so elevation and curves join seamlessly at the start/finish line.

export const SEG = 5; // metres per segment

const ROUTES = [
  {
    id: 'flat',
    name: 'Річкова набережна',
    description: 'Рівний маршрут уздовж ріки — для інтервалів і розминки.',
    length: 8000,
    hills: [[3, 8000, 0], [2, 2000, 1], [1, 1000, 2]],
    curves: [[0.006, 4000, 0], [0.004, 1000, 1.3]],
  },
  {
    id: 'rolling',
    name: 'Хвилясті пагорби',
    description: 'Короткі підйоми й спуски — гарно для темпу.',
    length: 12000,
    hills: [[20, 4000, 0], [10, 2000, 1], [4, 750, 2]],
    curves: [[0.008, 3000, 0.4], [0.005, 1200, 2]],
  },
  {
    id: 'mountain',
    name: 'Гірський перевал',
    description: 'Довгий підйом ~5–8% і швидкий спуск назад.',
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
        tree: hash(i) < 0.08 ? (hash(i * 7 + 3) < 0.5 ? -1 : 1) : 0,
        treeOffset: 1.6 + hash(i * 13 + 5) * 2.5,
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

function hash(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export const routes = ROUTES.map((r) => new Route(r));
