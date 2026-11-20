// When a rider gets out of the saddle: on a surge of power, or grinding a slow cadence with some force,
// and back down once it is easy again. The gaps between the "up" and "down" thresholds and the hold
// times keep a rider who hovers at a threshold from bobbing up and down.

const UP_POWER = 1.2;    // × FTP: a surge
const DOWN_POWER = 1.05; // × FTP
const GRIND_RPM = 60;    // at or under: a grind (70 had riders up at an ordinary climbing cadence)...
const GRIND_POWER = 0.5; // ...when pushing at least this × FTP
const EASY_RPM = 66;     // over: spinning again
const COAST_RPM = 20;    // under: not really pedalling (unless still pushing a surge: some trainers read 0 rpm when slow)
const SOFT_POWER = 0.4;  // × FTP: under it the rider sits whatever the cadence (soft-pedalling after a grind)
const UP_HOLD = 0.4;     // s the reason to stand has to last
const DOWN_HOLD = 0.8;   // s the reason to sit has to last

/**
 * One step of a rider's standing state. `state` keeps `up` (standing now) and `t` (seconds the opposite
 * has held) between calls. `power` null: unknown, the rider stays seated; `cadence` null: unknown,
 * only the power rule counts. Returns whether the rider stands.
 */
export function standStep(state, { power, ftp, cadence }, dt) {
  const known = cadence !== null && cadence !== undefined;
  let flip;
  if (power === null || power === undefined || !(ftp > 0)) flip = !!state.up; // no power: sit (and stay seated)
  else if (!state.up) {
    const surge = power >= UP_POWER * ftp;
    const grind = known && cadence > COAST_RPM && cadence <= GRIND_RPM && power >= GRIND_POWER * ftp;
    flip = surge || grind;
  } else {
    const coasting = known && cadence < COAST_RPM && power < DOWN_POWER * ftp;
    const easy = (power < DOWN_POWER * ftp && (!known || cadence > EASY_RPM)) || power < SOFT_POWER * ftp;
    flip = coasting || easy;
  }
  state.t = flip ? (state.t || 0) + dt : 0;
  if (flip && state.t >= (state.up ? DOWN_HOLD : UP_HOLD) - 1e-9) { state.up = !state.up; state.t = 0; }
  state.up = !!state.up;
  return state.up;
}
