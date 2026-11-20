// Attacks and breakaways in a free ride (#48): now and then a rider from the bunch around you goes,
// most often on a climb, and sometimes another jumps across to him. They hold the break for a few minutes, then
// tire and come back to the road. You chase them down, or sit in and let them go.

/** When the first attack may come, and how long between them (s). */
export const ATTACK_TIMING = { first: [180, 300], between: [240, 480], waitForClimb: 60 };
/** Power over a rider's own pace while attacking, holding the break, and paying for it after. */
export const ATTACK_POWER = { surge: 1.45, surgeClimb: 1.55, hold: 1.12, fade: 0.85 };

const span = (rnd, [a, b]) => a + rnd() * (b - a);

/** A ride's attack clock. */
export function attackState(rnd = Math.random) {
  return { nextAt: span(rnd, ATTACK_TIMING.first), dueSince: null };
}

/** How hard rider `b` rides at ride time `t` against his own pace: 1 outside an attack. */
export function attackFactor(b, t) {
  const a = b.attack;
  if (!a || t < a.start || t >= a.fadeEnd) return 1;
  if (t < a.surgeEnd) return a.surge;
  if (t < a.holdEnd) return ATTACK_POWER.hold;
  return ATTACK_POWER.fade;
}

/** In an attack now (going, or holding the break), not yet paying for it. */
export const attacking = (b, t) => !!b.attack && t >= b.attack.start && t < b.attack.holdEnd;

function plan(t, climb, rnd, { delay = 0, short = false } = {}) {
  const start = t + delay;
  const surgeEnd = start + (short ? 10 : 15) + rnd() * 15;
  const holdEnd = surgeEnd + 90 + rnd() * 150;
  return { start, surgeEnd, holdEnd, fadeEnd: holdEnd + 40 + rnd() * 20, surge: climb ? ATTACK_POWER.surgeClimb : ATTACK_POWER.surge };
}

/**
 * The attack due at ride time `t`, if any: { attacker, bridge } with their plans set on them (`b.attack`). It waits
 * up to a minute for a climb, and needs at least two riders in the bunch round you (40 m behind to 60 m ahead), so
 * there is a bunch to get away from and you are there to see it. `grade` is the road under you.
 */
export function nextAttack(state, { t, bots, meDist, grade, rnd = Math.random }) {
  if (t < state.nextAt) return null;
  const climb = grade > 0.025;
  state.dueSince ??= t;
  if (!climb && t - state.dueSince < ATTACK_TIMING.waitForClimb) return null;
  const free = bots.filter((b) => (!b.attack || t >= b.attack.fadeEnd) && b.dist - meDist > -40 && b.dist - meDist < 60);
  if (free.length < 2) { state.nextAt = t + 30; state.dueSince = null; return null; } // the bunch is gone: look again soon
  // the stronger half goes; on a climb the light ones
  const score = (b) => b.wkg * (climb ? 70 / (b.weight || 70) : 1);
  const ranked = free.slice().sort((a, b) => score(b) - score(a));
  const top = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2)));
  const attacker = top[Math.floor(rnd() * top.length)];
  attacker.attack = plan(t, climb, rnd);
  let bridge = null;
  const rest = ranked.filter((b) => b !== attacker);
  if (rest.length >= 2 && rnd() < 0.45) { // someone goes with him, leaving at least one in the bunch with you
    bridge = rest[Math.floor(rnd() * Math.min(rest.length, 3))];
    bridge.attack = plan(t, climb, rnd, { delay: 3 + rnd() * 5, short: true });
  }
  state.nextAt = t + span(rnd, ATTACK_TIMING.between);
  state.dueSince = null;
  return { attacker, bridge };
}
