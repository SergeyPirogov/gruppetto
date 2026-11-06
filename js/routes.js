// Procedurally generated looped routes. Every wave period divides the loop
// length, so elevation and curves join seamlessly at the start/finish line.

export const SEG = 5; // metres per segment

// theme: visual world (see themes.js). Grades stay under ~10 %.
const ROUTES = [
  {
    id: 'flat', theme: 'river',
    name: 'Річкова набережна',
    description: 'Рівно вздовж ріки й березових гаїв. Для інтервалів і розминки.',
    length: 8000,
    hills: [[3, 8000, 0], [2, 2000, 1], [1, 1000, 2]],
    curves: [[0.006, 4000, 0], [0.004, 1000, 1.3]],
  },
  {
    id: 'steppe', theme: 'steppe',
    name: 'Соняшниковий степ',
    description: 'Довгі прямі серед соняшників. Швидко й рівно, ідеально для ERG.',
    length: 25000,
    hills: [[6, 12500, 0], [4, 5000, 1], [2, 2500, 2]],
    curves: [[0.003, 12500, 0], [0.002, 2500, 1]],
  },
  {
    id: 'rolling', theme: 'meadow',
    name: 'Хвилясті пагорби',
    description: 'Короткі підйоми й спуски серед лук. Гарно для темпу.',
    length: 12000,
    hills: [[20, 4000, 0], [10, 2000, 1], [4, 750, 2]],
    curves: [[0.008, 3000, 0.4], [0.005, 1200, 2]],
  },
  {
    id: 'coast', theme: 'coast',
    name: 'Морське узбережжя',
    description: 'Пальми, пісок і море на горизонті. Легкі хвилі рельєфу.',
    length: 15000,
    hills: [[8, 7500, 0], [5, 2500, 1], [2, 1250, 2]],
    curves: [[0.01, 3000, 0.5], [0.004, 1500, 1]],
  },
  {
    id: 'autumn', theme: 'autumn',
    name: 'Осінній ліс',
    description: 'Золоті дуби, помірні пагорби, звивиста дорога.',
    length: 10000,
    hills: [[12, 5000, 0], [8, 2000, 1], [3, 1000, 2]],
    curves: [[0.012, 2500, 0], [0.006, 1000, 1]],
  },
  {
    id: 'sunset', theme: 'sunset',
    name: 'Вечірні пагорби',
    description: 'Кругові «стіни» до 8% на заході сонця. Для сили.',
    length: 20000,
    hills: [[25, 5000, 0], [12, 2000, 1], [3, 1000, 2]],
    curves: [[0.008, 4000, 1], [0.005, 1000, 0]],
  },
  {
    id: 'winter', theme: 'winter',
    name: 'Зимовий ліс',
    description: 'Засніжені ялини й тиша. Невеликі підйоми.',
    length: 9000,
    hills: [[15, 4500, 0], [6, 1500, 1], [2, 750, 2]],
    curves: [[0.01, 2250, 0.3], [0.005, 900, 1]],
  },
  {
    id: 'desert', theme: 'desert',
    name: 'Червоний каньйон',
    description: 'Кактуси, червоні скелі й один затяжний підйом.',
    length: 12000,
    hills: [[40, 12000, 0], [10, 3000, 1], [3, 1000, 2]],
    curves: [[0.009, 3000, 0], [0.006, 1200, 2]],
  },
  {
    id: 'carpathians', theme: 'carpathians',
    name: 'Карпатський серпантин',
    description: 'Смерекові схили, крутий серпантин і підйом ~4–8%.',
    length: 14000,
    hills: [[90, 14000, -Math.PI / 2], [15, 3500, 0.4], [4, 1000, 1]],
    curves: [[0.016, 1750, 0], [0.008, 700, 1]],
  },
  {
    id: 'mountain', theme: 'alpine',
    name: 'Гірський перевал',
    description: 'Довгий підйом ~5–8% до засніжених вершин і швидкий спуск.',
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

export const routes = ROUTES.map((r) => new Route(r));
