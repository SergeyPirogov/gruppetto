// Structured workouts. Power is a fraction of FTP; `to` makes a ramp.

const m = (min) => min * 60;

// The library (#library): workouts by what they are for, each with a `kind` for the filters in the Workouts menu.
const wu = (min = 10, to = 0.7) => ({ dur: m(min), power: 0.45, to, text: 'Warm up' });
const cd = (min = 8) => ({ dur: m(min), power: 0.6, to: 0.4, text: 'Cool down' });
const reps = (n, on, off) => Array.from({ length: n }, () => [on, off]).flat();
const LIBRARY = [
  // endurance
  { id: 'lib-z2-60', kind: 'endurance', name: 'Endurance 60', description: 'An hour of steady zone 2, the base of everything.', steps: [wu(8, 0.65), { dur: m(46), power: 0.68 }, cd(6)] },
  { id: 'lib-z2-90', kind: 'endurance', name: 'Endurance 90', description: '90 min of zone 2 with a few cadence drills to keep it lively.', steps: [wu(10, 0.65), { dur: m(25), power: 0.68 }, ...reps(3, { dur: 60, power: 0.68, cad: [100, 110], text: 'Spin it up' }, { dur: m(4), power: 0.68 }), { dur: m(32), power: 0.7 }, cd(8)] },
  { id: 'lib-z2-120', kind: 'endurance', name: 'Long ride 2 h', description: 'Two hours of easy aerobic riding for the long days.', steps: [wu(10, 0.65), { dur: m(100), power: 0.66 }, cd(10)] },
  { id: 'lib-tempo-3x15', kind: 'endurance', name: 'Tempo 3×15', description: 'Three 15-min blocks at 82% FTP: strong, sustainable.', steps: [wu(), ...reps(3, { dur: m(15), power: 0.82 }, { dur: m(4), power: 0.55 }).slice(0, -1), cd()] },
  { id: 'lib-recovery', kind: 'endurance', name: 'Recovery spin', description: '30 min very easy, high cadence: legs loose, nothing more.', steps: [{ dur: m(30), power: 0.48, cad: [90, 100] }] },
  // sweet spot and threshold
  { id: 'lib-ss-2x20', kind: 'threshold', name: 'Sweet Spot 2×20', description: 'Two 20-min efforts at 90% FTP: the classic engine builder.', steps: [wu(), { dur: m(20), power: 0.9 }, { dur: m(5), power: 0.55 }, { dur: m(20), power: 0.9 }, cd()] },
  { id: 'lib-ss-over-under', kind: 'threshold', name: 'Over-unders 3×9', description: 'Three 9-min blocks alternating 95% and 105% FTP: clearing lactate on the move.', steps: [wu(), ...reps(3, { dur: m(9), power: 0.95 }, { dur: m(5), power: 0.55 }).flatMap((st) => (st.power === 0.95 ? reps(3, { dur: 120, power: 0.95 }, { dur: 60, power: 1.05 }) : [st])).slice(0, -1), cd()] },
  { id: 'lib-ftp-2x20', kind: 'threshold', name: 'Threshold 2×20', description: 'Two 20-min efforts at 98% FTP: as close to your hour as it gets.', steps: [wu(12), { dur: m(20), power: 0.98 }, { dur: m(8), power: 0.55 }, { dur: m(20), power: 0.98 }, cd()] },
  { id: 'lib-ftp-4x8', kind: 'threshold', name: 'Threshold 4×8', description: 'Four 8-min efforts at 102% FTP with short recoveries.', steps: [wu(), ...reps(4, { dur: m(8), power: 1.02 }, { dur: m(3), power: 0.55 }).slice(0, -1), cd()] },
  { id: 'lib-ss-climb', kind: 'threshold', name: 'Sweet Spot climb 45', description: 'A 45-min "climb" building from 85% to 93% FTP.', steps: [wu(), { dur: m(15), power: 0.85 }, { dur: m(15), power: 0.89 }, { dur: m(15), power: 0.93 }, cd()] },
  // VO2max
  { id: 'lib-vo2-4x4', kind: 'vo2', name: 'VO₂max 4×4', description: 'Four 4-min efforts at 118% FTP: the Norwegian classic.', steps: [wu(12, 0.75), ...reps(4, { dur: m(4), power: 1.18 }, { dur: m(4), power: 0.5 }).slice(0, -1), cd()] },
  { id: 'lib-vo2-3020', kind: 'vo2', name: '30/30 × 2 sets', description: 'Two sets of ten 30 s on at 125%, 30 s off: VO₂max time without the long suffering.', steps: [wu(12, 0.75), ...reps(10, { dur: 30, power: 1.25 }, { dur: 30, power: 0.5 }), { dur: m(6), power: 0.5 }, ...reps(10, { dur: 30, power: 1.25 }, { dur: 30, power: 0.5 }), cd()] },
  { id: 'lib-vo2-4020', kind: 'vo2', name: '40/20 × 2 sets', description: 'Two sets of ten 40 s at 120%, 20 s easy: hard and short.', steps: [wu(12, 0.75), ...reps(10, { dur: 40, power: 1.2 }, { dur: 20, power: 0.5 }), { dur: m(6), power: 0.5 }, ...reps(10, { dur: 40, power: 1.2 }, { dur: 20, power: 0.5 }), cd()] },
  { id: 'lib-vo2-pyramid', kind: 'vo2', name: 'VO₂ pyramid', description: '1-2-3-4-3-2-1 min at 115% FTP, equal rest.', steps: [wu(12, 0.75), ...[1, 2, 3, 4, 3, 2, 1].flatMap((n, i, a) => [{ dur: m(n), power: 1.15 }, ...(i < a.length - 1 ? [{ dur: m(n), power: 0.5 }] : [])]), cd()] },
  // anaerobic and sprints
  { id: 'lib-sprints-8', kind: 'sprint', name: 'Sprints 8×15 s', description: 'Eight all-out 15-s sprints with full recovery. Big gear, ERG off is best.', steps: [wu(12, 0.7), ...reps(8, { dur: 15, power: 2.0, text: 'Sprint! All out' }, { dur: m(4), power: 0.5 }).slice(0, -1), cd()] },
  { id: 'lib-anaerobic-6x1', kind: 'sprint', name: 'Anaerobic 6×1', description: 'Six 1-min efforts at 140% FTP: for attacks and short climbs.', steps: [wu(12, 0.75), ...reps(6, { dur: 60, power: 1.4 }, { dur: m(4), power: 0.5 }).slice(0, -1), cd()] },
  { id: 'lib-race-sim', kind: 'sprint', name: 'Race simulation', description: 'Tempo with surges, a hard climb and a final sprint: a race in 60 min.', steps: [wu(10, 0.7), { dur: m(8), power: 0.8 }, ...reps(4, { dur: 30, power: 1.3, text: 'Surge' }, { dur: 90, power: 0.8 }), { dur: m(8), power: 1.0, text: 'The climb' }, { dur: m(4), power: 0.6 }, { dur: m(6), power: 0.85 }, { dur: 20, power: 1.8, text: 'Sprint for the line' }, cd(6)] },
  // cadence and technique
  { id: 'lib-cadence-pyramid', kind: 'technique', name: 'Cadence pyramid', description: 'Easy power, cadence stepping 85 → 115 rpm and back: a smoother pedal stroke.', steps: [wu(8, 0.6), ...[85, 95, 105, 115, 105, 95, 85].map((c) => ({ dur: m(3), power: 0.62, cad: [c - 3, c + 3], text: `${c} rpm` })), cd(6)] },
  { id: 'lib-low-cadence', kind: 'technique', name: 'Force 5×5 low cadence', description: 'Five 5-min efforts at 85% FTP at 55–65 rpm: muscle strength on the bike.', steps: [wu(), ...reps(5, { dur: m(5), power: 0.85, cad: [55, 65], text: 'Big gear, seated' }, { dur: m(3), power: 0.55, cad: [90, 100] }).slice(0, -1), cd()] },
  { id: 'lib-single-leg', kind: 'technique', name: 'Spin-ups', description: 'Short spin-ups to 120+ rpm without bouncing in the saddle.', steps: [wu(8, 0.6), ...reps(6, { dur: 30, power: 0.6, cad: [120, 130], text: 'Spin up, stay smooth' }, { dur: 90, power: 0.6 }), cd(6)] },
  // short ones
  { id: 'lib-quick-30', kind: 'short', name: '30 min hit', description: 'Half an hour: 5×1 min at 120% FTP for when time is short.', steps: [wu(8, 0.7), ...reps(5, { dur: 60, power: 1.2 }, { dur: 60, power: 0.5 }).slice(0, -1), { dur: m(5), power: 0.7 }, cd(8)] },
  { id: 'lib-quick-45-ss', kind: 'short', name: '45 min Sweet Spot', description: '3×8 min at 90% FTP: quality in 45 min.', steps: [wu(8), ...reps(3, { dur: m(8), power: 0.9 }, { dur: m(3), power: 0.55 }).slice(0, -1), cd(7)] },
  { id: 'lib-openers', kind: 'short', name: 'Race-day openers', description: '30 min with a few short efforts: the legs ready for tomorrow.', steps: [wu(10, 0.65), ...reps(3, { dur: 30, power: 1.2 }, { dur: 90, power: 0.55 }), { dur: m(3), power: 0.95 }, cd(8)] },
  { id: 'lib-movie', kind: 'short', name: 'Film night', description: 'An easy 90-min ride for a film in Watch & ride: steady zone 2, no intervals to watch out for.', steps: [{ dur: m(5), power: 0.5, to: 0.65 }, { dur: m(80), power: 0.66 }, { dur: m(5), power: 0.55, to: 0.45 }] },
];
/** What each kind is called, in the order of the filters. */
export const WORKOUT_KINDS = [['endurance', 'Endurance'], ['threshold', 'Sweet spot & threshold'], ['vo2', 'VO₂max'], ['sprint', 'Anaerobic & sprints'], ['technique', 'Cadence & technique'], ['short', 'Short'], ['test', 'Tests']];

export const workouts = [
  {
    id: 'endurance', kind: 'endurance',
    name: 'Endurance Base',
    description: '45 min in zone 2.',
    steps: [
      { dur: m(5), power: 0.45, to: 0.65 },
      { dur: m(35), power: 0.68 },
      { dur: m(5), power: 0.6, to: 0.4 },
    ],
  },
  {
    id: 'sweetspot', kind: 'threshold',
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
    id: 'vo2', kind: 'vo2',
    name: 'VO₂max 5×3',
    description: 'Five 3-min efforts at 115% FTP.',
    steps: [
      { dur: m(10), power: 0.45, to: 0.75 },
      ...Array.from({ length: 5 }, () => [{ dur: m(3), power: 1.15 }, { dur: m(3), power: 0.5 }]).flat(),
      { dur: m(7), power: 0.55, to: 0.4 },
    ],
  },
  {
    id: 'ramp', kind: 'test',
    name: 'FTP Ramp Test',
    description: '+20 W every minute to failure. FTP ≈ 75% of your best minute.',
    ramp: true,
    steps: [
      { dur: m(5), power: 0.4 },
      ...Array.from({ length: 30 }, (_, i) => ({ dur: 60, watts: 100 + i * 20 })),
    ],
  },
  {
    id: 'quick', kind: 'test',
    name: 'Quick test (3 min)',
    description: 'A short practice run to check ERG.',
    steps: [{ dur: 60, power: 0.5 }, { dur: 60, power: 0.8 }, { dur: 60, power: 0.5, to: 0.3 }],
  },
  ...LIBRARY,
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
  return powerZone(frac).color; // one table for the zone tag, the bars, the workout chart and the summary
}
