// Slipstream and overtaking: how long a rider has been held back on a wheel, and the lane it picks (to sit in,
// to pull out and pass, or to go back home). Pure functions of the riders around, shared by you and the bots.

/**
 * Slipstream first, then the pass: a faster rider comes up onto the wheel ahead and sits in its shelter; only once
 * it has been held back there (could go faster, kept to the wheel's speed) for 3 s does it pull out and pass, as in
 * a real bunch. Steering yourself overrides it.
 */
export const PASS_AFTER = 3;
/** How long `r` has been held back by a wheel right ahead (within 3 m, in line) that is slower than r would go alone. */
export function heldBy(r, others, dt) {
  const wheel = others.find((o) => o !== r && o.dist - r.dist > 0 && o.dist - r.dist < 4 && Math.abs(o.lane - r.lane) < 0.8);
  // any real edge counts: 0.1 m/s (0.4 km/h) — 3.1 W/kg behind 2.9 is ~0.6 km/h, which 0.3 m/s took for a draw
  const held = wheel && (r.vFree ?? r.v) > (wheel.v ?? 0) + 0.1;
  return held ? (r.heldFor || 0) + dt : Math.max(0, (r.heldFor || 0) - dt * 2);
}
/**
 * Lane for rider `r` among `others` (each {dist, lane, laneTarget}): keep `home` when nobody is close
 * ahead in it; when catching someone up to 15 m ahead in the current lane (the overtaker moves, not the
 * one overtaken), take the nearest lane clear from 3 m behind to 15 m ahead, and keep it while alongside. Lanes are 1.2 m apart across the road.
 */
export function pickLane(r, others, home) {
  const near = (lane, from, to, closing = false) => others.some((o) => {
    if (o === r || !(Math.abs((o.laneTarget ?? o.lane) - lane) < 0.9 || Math.abs(o.lane - lane) < 0.9)) return false;
    const gap = o.dist - r.dist;
    if (!closing) return gap > from && gap < to;
    // a pass: on this rider's wheel (within 4 m) and held back by it long enough
    return gap > from && gap < 4 && (r.heldFor || 0) >= PASS_AFTER;
  });
  const cur = r.laneTarget ?? r.lane;
  const passing = near(cur, -0.5, 15, true);
  // never change course while alongside someone: finish the pass in the lane you chose. Held on a wheel long enough
  // you may still pull out (to a side that is clear, below): in a bunch two abreast someone is always beside you,
  // and the pass never came (32 s on a wheel at 300 W, measured)
  if (!passing && others.some((o) => o !== r && Math.abs(o.dist - r.dist) < 3.5 && Math.abs(o.lane - r.lane) >= 0.9 && Math.abs(o.lane - r.lane) < 2)) return cur;
  // not passing: on a wheel just ahead (within 8 m, nearly in line), tuck into its line for the full shelter
  if (!passing) {
    // (in line with where it is heading, not where it is now: a pass already begun is not pulled back onto the wheel)
    const wheel = others.filter((o) => o !== r && o.dist - r.dist > 0.3 && o.dist - r.dist < 8 && Math.abs(o.lane - cur) < 0.9 && Math.abs(o.lane - r.lane) < 0.9).sort((a, b) => a.dist - b.dist)[0];
    if (wheel) return wheel.lane;
    // otherwise back home, only when it is clear well ahead (10 m), so a pass is not cut short across the wheel
    return near(home, -6, 10) ? cur : home;
  }
  // the pass: just wide enough, as in a bunch: a line 0.95 m beside the wheel being passed (shoulders ~15 cm
  // apart), the side that is clear and the nearer one; only when both are taken, a whole lane further out
  const wheel = others.filter((o) => o !== r && o.dist - r.dist > 0 && o.dist - r.dist < 4 && Math.abs(o.lane - r.lane) < 0.9).sort((a, b) => a.dist - b.dist)[0];
  const base = wheel ? wheel.lane : cur;
  const lines = [base - PASS_SIDE, base + PASS_SIDE, base - 2 * PASS_SIDE, base + 2 * PASS_SIDE].filter((l) => l >= -2.6 && l <= 2.6);
  const free = lines.filter((l) => !near(l, -3, 15)).sort((a, b) => Math.abs(a - r.lane) - Math.abs(b - r.lane) || Math.abs(a) - Math.abs(b));
  return free.length ? free[0] : cur;
}
const PASS_SIDE = 0.95;
