// Simple road-cycling physics: power in, speed out.

const G = 9.81;

export const DEFAULTS = { cda: 0.32, crr: 0.004, rho: 1.225, bikeMass: 8 };

/**
 * Advance speed by dt seconds.
 * @param {number} v current speed, m/s
 * @param {number} power watts
 * @param {number} grade fraction (0.05 = 5 %)
 * @param {number} riderMass kg
 */
export function stepSpeed(v, power, grade, dt, riderMass, opts = {}) {
  const { cda, crr, rho, bikeMass, wind = 0 } = { ...DEFAULTS, ...opts }; // wind: headwind, m/s (− tailwind)
  const m = riderMass + bikeMass;
  const theta = Math.atan(grade);
  const fGrav = m * G * Math.sin(theta);
  const fRoll = v > 0.05 || power > 0 ? m * G * Math.cos(theta) * crr : 0;
  const va = v + wind; // the air speed you ride through
  const fAir = 0.5 * rho * cda * va * Math.abs(va);
  // P = F·v, so the force grows as v → 0; the floor only keeps it finite. It must be low enough that
  // modest power still starts the bike on a climb (with 1.5 m/s, 30 W could not move 83 kg up 3%).
  const fProp = power / Math.max(v, 0.3);
  const a = (fProp - fGrav - fRoll - fAir) / (m + 1.5); // +1.5 kg for wheel inertia
  return Math.max(0, v + a * dt);
}

/** Steady-state speed for a given power (used for bots and tests). */
export function steadySpeed(power, grade, riderMass, opts) {
  let v = 5;
  for (let i = 0; i < 4000; i++) v = stepSpeed(v, power, grade, 0.05, riderMass, opts);
  return v;
}

/**
 * Wind along the road: the headwind (+) or tailwind (−) and the crosswind (+ from the left, blowing to
 * the right), in m/s. `speed` m/s blowing toward the angle `toward`; you ride toward `heading` (radians,
 * both measured the same way, x then y, with y to the right of x).
 */
export function windComponents(speed, toward, heading) {
  const d = toward - heading;
  return { head: -speed * Math.cos(d), cross: speed * Math.sin(d) };
}

/**
 * The wind felt on the trainer, as extra grade (a fraction): the change in air drag it makes at this
 * speed, as if it were a hill. Headwind adds, tailwind takes away.
 */
export function windGrade(v, head, cda, mass, { rho = DEFAULTS.rho, bikeMass = DEFAULTS.bikeMass } = {}) {
  const va = v + head;
  const extra = 0.5 * rho * cda * (va * Math.abs(va) - v * v);
  return extra / ((mass + bikeMass) * G);
}

/**
 * Drafting: the share of air drag saved riding behind someone, from the gap to the wheel ahead (m) and
 * the sideways offset (m). About a third right on the wheel, fading to nothing by 4 m back or once you
 * are half a bike width out of their line.
 */
export function draftFactor(gap, sideways, cross = 0) {
  if (gap <= 0.3 || gap >= 4) return 0;
  const along = gap <= 1 ? 1 : 1 - (gap - 1) / 3;
  // in a crosswind the shelter moves downwind of the wheel ahead: sit half a bike out to the lee side
  const lee = Math.max(-0.7, Math.min(0.7, cross * 0.1));
  const side = Math.max(0, 1 - Math.abs(sideways + lee) / 0.8);
  return 0.33 * along * side;
}

/**
 * The shelter a rider gets from everyone around (`others`: [{ gap, sideways }], gap > 0 ahead, < 0 behind):
 * - from the wheels ahead: the best single wheel (draftFactor), deeper inside a bunch — each more rider
 *   sheltering the wheel you follow adds a little (a line of 3 ahead about 40 %, a full bunch up to ~48 %);
 * - from a rider right behind: the one in front saves a little too (air pushed back on its back), up to ~4 %
 *   at 0.5 m, nothing past 2 m.
 * Returns the share of air drag saved (0 … 0.5).
 */
export function packDraft(others, cross = 0) {
  const ahead = others.filter((o) => o.gap > 0.3 && o.gap < 4);
  let best = 0;
  for (const o of ahead) best = Math.max(best, draftFactor(o.gap, o.sideways, cross));
  // a bunch: riders further up the same line (up to 12 m ahead, within a bike width) deepen the shelter
  const line = others.filter((o) => o.gap >= 4 && o.gap < 12 && Math.abs(o.sideways) < 1).length;
  const deep = best > 0 ? Math.min(0.15, line * 0.05) * (best / 0.33) : 0;
  // pushed from behind: someone close on your wheel
  let push = 0;
  for (const o of others) {
    if (o.gap < 0 && o.gap > -2 && Math.abs(o.sideways) < 0.8) push = Math.max(push, 0.04 * (1 - (-o.gap - 0.5) / 1.5) * (1 - Math.abs(o.sideways) / 0.8));
  }
  return Math.min(0.5, best + deep + Math.max(0, push));
}

/**
 * Air drag area (CdA, m²) for a rider of this height (cm) and weight (kg), riding on the hoods.
 * Frontal area from body size (Bassett et al. 1999: 0.0293·h^0.725·m^0.425 + 0.0604, with the bike),
 * times a drag coefficient that gives 0.32 m² for a 178 cm, 75 kg rider.
 */
export function riderCdA(heightCm = 178, weightKg = 75) {
  const h = Math.min(2.2, Math.max(1.4, heightCm / 100)), m = Math.min(150, Math.max(40, weightKg));
  const area = 0.0293 * h ** 0.725 * m ** 0.425 + 0.0604;
  return 0.944 * area;
}
