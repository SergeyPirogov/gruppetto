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
  const { cda, crr, rho, bikeMass } = { ...DEFAULTS, ...opts };
  const m = riderMass + bikeMass;
  const theta = Math.atan(grade);
  const fGrav = m * G * Math.sin(theta);
  const fRoll = v > 0.05 || power > 0 ? m * G * Math.cos(theta) * crr : 0;
  const fAir = 0.5 * rho * cda * v * v;
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
 * Drafting: the share of air drag saved riding behind someone, from the gap to the wheel ahead (m) and
 * the sideways offset (m). About a third right on the wheel, fading to nothing by 4 m back or once you
 * are half a bike width out of their line.
 */
export function draftFactor(gap, sideways) {
  if (gap <= 0.3 || gap >= 4) return 0;
  const along = gap <= 1 ? 1 : 1 - (gap - 1) / 3;
  const side = Math.max(0, 1 - Math.abs(sideways) / 0.8);
  return 0.33 * along * side;
}
