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
  const fProp = power / Math.max(v, 1.5);
  const a = (fProp - fGrav - fRoll - fAir) / (m + 1.5); // +1.5 kg for wheel inertia
  return Math.max(0, v + a * dt);
}

/** Steady-state speed for a given power (used for bots and tests). */
export function steadySpeed(power, grade, riderMass, opts) {
  let v = 5;
  for (let i = 0; i < 4000; i++) v = stepSpeed(v, power, grade, 0.05, riderMass, opts);
  return v;
}
