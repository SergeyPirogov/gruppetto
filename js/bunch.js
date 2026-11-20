// A race bunch: the bots ride together as in a real race instead of each at its own pace. Each one rides the
// wheel ahead (within 60 m), two abreast, a wheel behind in its own line or half a wheel behind the one beside it;
// the one at the front sets the pace and after a pull swings off to the other line to rest. Riding a wheel is
// cheap on the flat, so the bunch holds together; up a climb the shelter is gone, and a weaker rider spends his
// reserve to stay with it and, once it is gone, is dropped.

import { DEFAULTS } from './physics.js';

const G = 9.81;
export const BUNCH = {
  reach: 60,          // m: a wheel this far ahead is followed (chased); further, the rider is on his own
  gapInLine: 2.2,     // m, centre to centre: on the wheel in your own line (the best shelter is at 2 m)
  gapBeside: 0.9,     // m: half a wheel behind the rider in the other line
  pull: [25, 50],     // s at the front before swinging off
  ease: 8,            // s of soft-pedalling after a pull
  reserve: 8000,      // J above his own pace a 70 kg rider can spend, refilled below it
  frontPace: 0.8,     // of his own pace, pulling the bunch on the flat (alone, all of it)
  frontPaceUp: 0.95,  // pulling it up a climb, where it splits
  lines: [0.3, 1.5],  // the two lines of the bunch across the road (keeping right)
};

/** Power to ride at speed `v` (m/s) up `grade` with air drag area `cda` (a sheltered one is smaller). */
export function powerFor(v, grade, mass, { cda = DEFAULTS.cda, crr = DEFAULTS.crr, rho = DEFAULTS.rho, bikeMass = DEFAULTS.bikeMass, wind = 0 } = {}) {
  const m = mass + bikeMass, th = Math.atan(grade), va = v + wind;
  return Math.max(0, v * (m * G * Math.sin(th) + m * G * Math.cos(th) * crr + 0.5 * rho * cda * va * Math.abs(va)));
}

const nearestLine = (lane) => BUNCH.lines.reduce((a, b) => (Math.abs(b - lane) < Math.abs(a - lane) ? b : a));

/**
 * Bot `b`'s power this step in the bunch. `base` is its own pace (W) here, `cda` its drag in the shelter it has
 * now, `others` everyone else ({ dist, v, lane }). Keeps on `b`: its line (`b.line`), time at the front, the
 * pull it is on, and its reserve.
 */
export function bunchPower(b, { t, dt, base, grade, cda, wind = 0, others, rnd = Math.random }) {
  b.line ??= nearestLine(b.lane ?? BUNCH.lines[0]);
  b.pullFor ??= BUNCH.pull[0] + rnd() * (BUNCH.pull[1] - BUNCH.pull[0]);
  const max = BUNCH.reserve * ((b.weight || 70) / 70);
  b.reserve ??= max;
  // nobody rides the wheel of one swinging off after his pull: they go by
  const ahead = others.filter((o) => o.dist - b.dist > 0.2 && o.dist - b.dist < BUNCH.reach && !(o.easeUntil > t));
  const inLine = (o) => Math.abs(o.lane - b.line) < 0.7;
  const near = (list) => list.sort((x, y) => x.dist - y.dist)[0];
  const wheel = near(ahead.filter(inLine)) || near(ahead.slice());
  let p;
  if (wheel && !(b.easeUntil > t)) {
    // on a wheel: the speed that closes the gap to where it should be, then the power for that speed in the shelter
    const want = inLine(wheel) ? BUNCH.gapInLine : BUNCH.gapBeside;
    const err = wheel.dist - b.dist - want;
    const vt = Math.max(0, (wheel.v ?? 0) + Math.max(-1, Math.min(2.5, err * 0.3)));
    const m = (b.weight || 70) + DEFAULTS.bikeMass;
    p = powerFor(vt, grade, b.weight || 70, { cda, wind }) + m * (vt - (b.v ?? 0)) * 0.4 * Math.max(b.v ?? 0, 3);
    b.frontFor = 0;
  } else {
    // at the front: his own pace, and after a pull a few seconds soft, over in the other line
    const easing = b.easeUntil > t;
    const followed = others.some((o) => b.dist - o.dist > 0 && b.dist - o.dist < 8);
    p = base * (easing ? 0.7 : followed ? (grade > 0.02 ? BUNCH.frontPaceUp : BUNCH.frontPace) : 1);
    // up a climb nobody swings off: whoever is at the front keeps the tempo, and the bunch splits behind him
    if (!easing && followed && grade < 0.02 && (b.frontFor = (b.frontFor || 0) + dt) > b.pullFor) {
      b.easeUntil = t + BUNCH.ease;
      b.frontFor = 0;
      b.pullFor = BUNCH.pull[0] + rnd() * (BUNCH.pull[1] - BUNCH.pull[0]);
      b.line = BUNCH.lines.find((l) => l !== b.line) ?? b.line;
    }
  }
  // what it can give: well over his pace while the reserve lasts, his pace once it is spent
  const cap = base * (b.reserve > 0 ? 1.7 : 1.02);
  p = Math.max(0, Math.min(cap, p));
  b.reserve = Math.min(max, Math.max(0, b.reserve - Math.max(0, p - base) * dt + Math.max(0, base - p) * 0.5 * dt));
  return p;
}
