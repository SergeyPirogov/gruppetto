// After the ride (#9): each workout interval, target against what was ridden, and time in zones.
import { POWER_ZONES } from './workouts.js';

/** Heart rate zones as fractions of max heart rate (the common five). */
export const HR_ZONES = [
  { z: 1, name: 'Very light', upTo: 0.6, color: '#8a94a6' },
  { z: 2, name: 'Light', upTo: 0.7, color: '#3b82f6' },
  { z: 3, name: 'Moderate', upTo: 0.8, color: '#22c55e' },
  { z: 4, name: 'Hard', upTo: 0.9, color: '#f97316' },
  { z: 5, name: 'Maximum', upTo: Infinity, color: '#ef4444' },
];

const HR_COLORS = {
  5: ['#8a94a6', '#3b82f6', '#22c55e', '#f97316', '#ef4444'],
  6: ['#8a94a6', '#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444'],
  7: ['#8a94a6', '#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#a855f7'],
};
/** Coggan's heart rate zones as fractions of the threshold heart rate (LTHR). */
export const LTHR_ZONES = [
  { name: 'Active recovery', upTo: 0.69 },
  { name: 'Endurance', upTo: 0.84 },
  { name: 'Tempo', upTo: 0.95 },
  { name: 'Threshold', upTo: 1.06 },
  { name: 'VO2 max', upTo: Infinity },
];
/**
 * Heart rate zones in beats per minute (`upTo` is each zone's top in bpm, so use them with ref 1).
 * From intervals.icu when it gave them (`bpm`: each zone's top, the last one is max HR),
 * otherwise from the threshold heart rate. Null when there is neither.
 */
export function hrZonesBpm({ bpm, names = [], lthr = 0 } = {}) {
  if (Array.isArray(bpm) && bpm.length > 1) {
    const colors = HR_COLORS[bpm.length] || HR_COLORS[7];
    return bpm.map((top, i) => ({ z: i + 1, name: names[i] || `Zone ${i + 1}`, upTo: i === bpm.length - 1 ? Infinity : top, color: colors[Math.min(i, colors.length - 1)] }));
  }
  if (lthr > 0) return LTHR_ZONES.map((z, i) => ({ z: i + 1, name: z.name, upTo: z.upTo * lthr, color: HR_COLORS[5][i] }));
  return null;
}

/**
 * The workout's intervals as ridden: samples carry `step` (the interval index, null off the plan)
 * and `target` (watts). One row per run of the same step: duration, mean target, mean power,
 * heart rate and cadence (zeros left out), the target band and whether the power stayed in it.
 * `band(stepIndex)` gives [lo, hi] watts for a range step, or null (then ±5 % of the target).
 */
export function rideIntervals(samples, band = () => null) {
  const rows = [];
  let cur = null;
  const mean = (a) => { const v = a.filter((x) => x > 0); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : 0; };
  const close = () => {
    if (!cur) return;
    const target = mean(cur.tg);
    const power = Math.round(cur.pw.reduce((s, x) => s + x, 0) / cur.pw.length);
    const b = band(cur.step);
    const [lo, hi] = b || (target ? [target * 0.95, target * 1.05] : [0, Infinity]);
    rows.push({
      step: cur.step, start: cur.start, dur: cur.pw.length, target, power,
      hr: mean(cur.hr), cad: mean(cur.cad), lo: b ? b[0] : null, hi: b ? b[1] : null,
      diff: target ? power - target : null,
      ok: !target || (power >= lo && power <= hi),
    });
    cur = null;
  };
  samples.forEach((s, i) => {
    const step = s.step ?? null;
    if (!cur || cur.step !== step) {
      close();
      if (step === null) return;
      cur = { step, start: i, tg: [], pw: [], hr: [], cad: [] };
    }
    if (!cur) return;
    cur.tg.push(s.target || 0); cur.pw.push(s.power || 0); cur.hr.push(s.heartRate || 0); cur.cad.push(s.cadence || 0);
  });
  close();
  return rows;
}

/** Seconds in each zone: values sampled every `every` s, zones by fraction of `ref` (FTP or max HR). */
export function timeInZones(values, ref, zones = POWER_ZONES, every = 1, { skipZero = false } = {}) {
  const out = zones.map((z) => ({ ...z, sec: 0 }));
  if (!ref) return out;
  for (const v of values) {
    if (skipZero && !(v > 0)) continue;
    const f = (v || 0) / ref;
    const i = zones.findIndex((z) => f < z.upTo);
    out[i < 0 ? zones.length - 1 : i].sec += every;
  }
  return out;
}
