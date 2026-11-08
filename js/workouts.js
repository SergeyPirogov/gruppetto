// Structured workouts. Power is a fraction of FTP; `to` makes a ramp.

const m = (min) => min * 60;

export const workouts = [
  {
    id: 'endurance',
    name: 'Endurance Base',
    description: '45 min in zone 2.',
    steps: [
      { dur: m(5), power: 0.45, to: 0.65 },
      { dur: m(35), power: 0.68 },
      { dur: m(5), power: 0.6, to: 0.4 },
    ],
  },
  {
    id: 'sweetspot',
    name: 'Sweet Spot 3×10',
    description: 'Three 10-min efforts at 90% FTP.',
    steps: [
      { dur: m(8), power: 0.45, to: 0.7 },
      { dur: m(10), power: 0.9 }, { dur: m(4), power: 0.55 },
      { dur: m(10), power: 0.9 }, { dur: m(4), power: 0.55 },
      { dur: m(10), power: 0.9 },
      { dur: m(6), power: 0.6, to: 0.4 },
    ],
  },
  {
    id: 'vo2',
    name: 'VO₂max 5×3',
    description: 'Five 3-min efforts at 115% FTP.',
    steps: [
      { dur: m(10), power: 0.45, to: 0.75 },
      ...Array.from({ length: 5 }, () => [{ dur: m(3), power: 1.15 }, { dur: m(3), power: 0.5 }]).flat(),
      { dur: m(7), power: 0.55, to: 0.4 },
    ],
  },
  {
    id: 'ramp',
    name: 'FTP Ramp Test',
    description: '+20 W every minute to failure. FTP ≈ 75% of your best minute.',
    ramp: true,
    steps: [
      { dur: m(5), power: 0.4 },
      ...Array.from({ length: 30 }, (_, i) => ({ dur: 60, watts: 100 + i * 20 })),
    ],
  },
  {
    id: 'quick',
    name: 'Quick test (3 min)',
    description: 'A short practice run to check ERG.',
    steps: [{ dur: 60, power: 0.5 }, { dur: 60, power: 0.8 }, { dur: 60, power: 0.5, to: 0.3 }],
  },
];

export function totalDuration(w) {
  return w.steps.reduce((s, st) => s + st.dur, 0);
}

/** Target watts at time t (seconds) into the workout, or null when finished. */
export function targetAt(w, t, ftp) {
  let start = 0;
  for (let i = 0; i < w.steps.length; i++) {
    const st = w.steps[i];
    if (t < start + st.dur) {
      const into = t - start;
      return { watts: stepWatts(st, into / st.dur, ftp), index: i, remaining: st.dur - into, step: st };
    }
    start += st.dur;
  }
  return null;
}

/** Watts for a step at `frac` (0..1) of its duration; null for free-ride steps (no ERG target). */
export function stepWatts(st, frac, ftp) {
  if (st.free) return null;
  if (st.watts !== undefined) {
    return st.wattsTo !== undefined ? Math.round(st.watts + (st.wattsTo - st.watts) * frac) : st.watts;
  }
  const p = st.to !== undefined ? st.power + (st.to - st.power) * frac : st.power;
  return Math.round(p * ftp);
}

/** Average and normalized power, IF and TSS of a workout at `ftp` (free steps count as half FTP). */
export function workoutStats(w, ftp) {
  let sum = 0, sum4 = 0, n = 0, roll = [], acc = 0;
  for (const st of w.steps) {
    for (let i = 0; i < st.dur; i++) {
      const p = stepWatts(st, (i + 0.5) / st.dur, ftp) ?? ftp * 0.5;
      sum += p; n++;
      roll.push(p); acc += p;
      if (roll.length > 30) acc -= roll.shift();
      if (roll.length === 30) sum4 += (acc / 30) ** 4;
    }
  }
  if (!n) return { dur: 0, avg: 0, np: 0, if: 0, tss: 0 };
  const np = n >= 30 ? (sum4 / (n - 29)) ** 0.25 : sum / n;
  const IF = np / ftp;
  return { dur: n, avg: Math.round(sum / n), np: Math.round(np), if: IF, tss: Math.round((n / 3600) * IF * IF * 100) };
}

/** Power zones by fraction of FTP (Coggan's seven, as Zwift and TrainingPeaks use them). */
export const POWER_ZONES = [
  { z: 1, name: 'Recovery', upTo: 0.55, color: '#8a94a6' },
  { z: 2, name: 'Endurance', upTo: 0.75, color: '#3b82f6' },
  { z: 3, name: 'Tempo', upTo: 0.9, color: '#22c55e' },
  { z: 4, name: 'Threshold', upTo: 1.05, color: '#eab308' },
  { z: 5, name: 'VO2max', upTo: 1.2, color: '#f97316' },
  { z: 6, name: 'Anaerobic', upTo: 1.5, color: '#ef4444' },
  { z: 7, name: 'Neuromuscular', upTo: Infinity, color: '#a855f7' },
];

/** The zone for a power as a fraction of FTP. */
export function powerZone(frac) {
  return POWER_ZONES.find((z) => frac < z.upTo) || POWER_ZONES[POWER_ZONES.length - 1];
}

/** Zone colour by fraction of FTP. */
export function zoneColor(frac) {
  if (frac < 0.6) return '#8a94a6';
  if (frac < 0.76) return '#3b82f6';
  if (frac < 0.9) return '#22c55e';
  if (frac < 1.05) return '#eab308';
  if (frac < 1.19) return '#f97316';
  return '#ef4444';
}
