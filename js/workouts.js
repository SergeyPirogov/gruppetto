// Structured workouts. Power is a fraction of FTP; `to` makes a ramp.

const m = (min) => min * 60;

export const workouts = [
  {
    id: 'endurance',
    name: 'Базова витривалість',
    description: '45 хв у 2-й зоні.',
    steps: [
      { dur: m(5), power: 0.45, to: 0.65 },
      { dur: m(35), power: 0.68 },
      { dur: m(5), power: 0.6, to: 0.4 },
    ],
  },
  {
    id: 'sweetspot',
    name: 'Світ-спот 3×10',
    description: 'Три відрізки по 10 хв на 90% FTP.',
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
    description: 'П’ять відрізків по 3 хв на 115% FTP.',
    steps: [
      { dur: m(10), power: 0.45, to: 0.75 },
      ...Array.from({ length: 5 }, () => [{ dur: m(3), power: 1.15 }, { dur: m(3), power: 0.5 }]).flat(),
      { dur: m(7), power: 0.55, to: 0.4 },
    ],
  },
  {
    id: 'ramp',
    name: 'Рамп-тест FTP',
    description: '+20 Вт щохвилини до відмови. FTP ≈ 75% від найкращої хвилини.',
    ramp: true,
    steps: [
      { dur: m(5), power: 0.4 },
      ...Array.from({ length: 30 }, (_, i) => ({ dur: 60, watts: 100 + i * 20 })),
    ],
  },
  {
    id: 'quick',
    name: 'Швидкий тест (3 хв)',
    description: 'Короткий тренувальний прогін для перевірки ERG.',
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

export function stepWatts(st, frac, ftp) {
  if (st.watts !== undefined) return st.watts;
  const p = st.to !== undefined ? st.power + (st.to - st.power) * frac : st.power;
  return Math.round(p * ftp);
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
