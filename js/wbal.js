// W′bal: what is left of the anaerobic work capacity (W′, joules) above critical power (CP; here the FTP).
// Above CP it drains joule for joule; below, it comes back the faster the further under CP you ride and the
// emptier it is (the differential model of Skiba, after Froncioni and Clarke). Empty means you cannot hold
// the power above CP any more.

/** W′ when nothing better is known: 20 kJ, a typical trained rider. */
export const DEFAULT_W_PRIME = 20000;

/** The balance after dt seconds at power, from bal; between 0 and wPrime. */
export function wbalStep(bal, power, cp, wPrime, dt = 1) {
  if (!(cp > 0) || !(wPrime > 0)) return bal;
  const p = Math.max(0, power || 0);
  const next = p > cp ? bal - (p - cp) * dt : bal + ((wPrime - bal) * (cp - p) / wPrime) * dt;
  return Math.max(0, Math.min(wPrime, next));
}

/** The balance after each value of powers, each held for every seconds, from a full W′. */
export function wbalSeries(powers, cp, wPrime, every = 1) {
  let bal = wPrime;
  return powers.map((p) => (bal = wbalStep(bal, p, cp, wPrime, every)));
}

/** Seconds until the balance is empty at this power; Infinity at or below CP. */
export function timeToEmpty(bal, power, cp) {
  return power > cp ? Math.max(0, bal) / (power - cp) : Infinity;
}

/** When to warn: the balance runs out within this many seconds at the present power. */
export const WARN_SECONDS = 60;
