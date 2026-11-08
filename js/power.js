// Power curve and FTP suggestion (#34, #35): your best average power for 5 s ... 60 min, per ride and over time.

export const DURS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];

/** Best average power for each duration in a 1-sample-per-second series. */
export function bestsFromSamples(powers) {
  const out = {};
  for (const d of DURS) {
    if (powers.length < d) continue;
    let sum = 0, best = 0;
    for (let i = 0; i < powers.length; i++) {
      sum += powers[i] || 0;
      if (i >= d) sum -= powers[i - d] || 0;
      if (i >= d - 1) best = Math.max(best, sum / d);
    }
    if (best > 0) out[d] = Math.round(best);
  }
  return out;
}

/** The same from a ride's chart (`every` seconds per point, already averaged): a little low for the shortest ones. */
export function bestsFromChart(pw, every = 5) {
  const out = {};
  for (const d of DURS) {
    const k = Math.max(1, Math.round(d / every));
    if (pw.length < k) continue;
    let sum = 0, best = 0;
    for (let i = 0; i < pw.length; i++) {
      sum += pw[i] || 0;
      if (i >= k) sum -= pw[i - k] || 0;
      if (i >= k - 1) best = Math.max(best, sum / k);
    }
    if (best > 0) out[d] = Math.round(best);
  }
  return out;
}

/** Your curve: for each duration the best over the rides (those within `days`, if given), with the ride it came from. */
export function powerCurve(entries, { days = null, now = Date.now() } = {}) {
  const curve = {};
  for (const e of entries) {
    if (days && now - Date.parse(e.date) > days * 864e5) continue;
    const b = e.bests || (e.chart?.pw ? bestsFromChart(e.chart.pw, e.chart.every) : {});
    for (const [d, w] of Object.entries(b)) if (!curve[d] || w > curve[d].w) curve[d] = { w, id: e.id, date: e.date };
  }
  return curve;
}

/**
 * FTP from your rides: 95 % of the best 20 minutes, or failing that 75 % of the best 1 minute of a ramp test
 * ('ramp' entries). Suggested only when it is at least 2 % and 3 W above the FTP you have now.
 */
export function ftpSuggestion(entries, ftp, { days = 90, now = Date.now() } = {}) {
  const recent = entries.filter((e) => now - Date.parse(e.date) <= days * 864e5);
  const c = powerCurve(recent, { now });
  let est = null, why = null;
  if (c[1200]) { est = Math.round(c[1200].w * 0.95); why = { dur: 1200, w: c[1200].w, date: c[1200].date }; }
  for (const e of recent) {
    if (!e.ramp) continue;
    const b1 = e.bests?.[60] || e.summary?.best1min;
    if (b1 && Math.round(b1 * 0.75) > (est || 0)) { est = Math.round(b1 * 0.75); why = { dur: 60, w: b1, date: e.date, ramp: true }; }
  }
  if (!est || est < ftp * 1.02 || est - ftp < 3) return null;
  return { ftp: est, ...why };
}

/**
 * Fitness, fatigue and form (#54), as TrainingPeaks and intervals.icu draw them: daily TSS smoothed over
 * 42 days (fitness, CTL) and over 7 days (fatigue, ATL); form (TSB) = yesterday's fitness − fatigue.
 * Returns one point per day from the first ride (or `days` back) to `now`.
 */
export function fitnessSeries(entries, { days = 90, now = Date.now() } = {}) {
  const day = (t) => Math.floor((t - new Date(t).getTimezoneOffset() * 60000) / 864e5); // local calendar day
  const tssByDay = new Map();
  for (const e of entries) {
    if (!e.tss) continue;
    const d = day(Date.parse(e.date));
    tssByDay.set(d, (tssByDay.get(d) || 0) + e.tss);
  }
  if (!tssByDay.size) return [];
  const today = day(now), first = Math.min(...tssByDay.keys());
  const kC = 1 - Math.exp(-1 / 42), kA = 1 - Math.exp(-1 / 7);
  let ctl = 0, atl = 0;
  const out = [];
  for (let d = first; d <= today; d++) {
    const form = ctl - atl; // the morning's form: before today's ride
    const t = tssByDay.get(d) || 0;
    ctl += (t - ctl) * kC;
    atl += (t - atl) * kA;
    if (d > today - days) out.push({ day: d, date: new Date(d * 864e5).toISOString().slice(0, 10), tss: t, ctl, atl, form });
  }
  return out;
}

/** A word for a form value, the usual bands. */
export function formBand(tsb) {
  if (tsb > 25) return 'transition';   // fresh, losing fitness
  if (tsb > 5) return 'fresh';
  if (tsb > -10) return 'neutral';
  if (tsb > -30) return 'optimal';     // productive training load
  return 'overload';
}

// ---------- W′bal: what is left of your anaerobic work capacity ----------
// Critical power (CP, here your FTP) is what you can hold for a long time; above it you spend W′, a store of
// work in joules (about 10–30 kJ), and below it the store refills, faster the further below CP you ride.
// The differential model of Skiba and Clarke (2015), as intervals.icu and Golden Cheetah draw it:
//   above CP: W′bal −= (P − CP)·dt;   below CP: W′bal += (W′ − W′bal)·(CP − P)/W′·dt.

export const W_PRIME_DEFAULT = 20000; // J

/** W′bal after `dt` seconds at `power`, from `bal` (J). Never below 0 or above W′. */
export function wbalStep(bal, power, cp, wPrime, dt = 1) {
  if (!(cp > 0) || !(wPrime > 0)) return bal;
  const p = Math.max(0, power || 0);
  if (p > cp) return Math.max(0, bal - (p - cp) * dt);
  // the exact solution over dt, so a 5 s step refills the same as five 1 s steps
  return wPrime - (wPrime - bal) * Math.exp(-((cp - p) / wPrime) * dt);
}

/** W′bal after each sample of a power series (`every` seconds per sample), starting full. */
export function wbalSeries(powers, cp, wPrime, every = 1) {
  let bal = wPrime;
  return powers.map((p) => (bal = wbalStep(bal, p, cp, wPrime, every)));
}

/** Seconds until W′ runs out at this power, or null when you are not spending it. */
export function timeToEmpty(bal, power, cp) {
  return power > cp ? bal / (power - cp) : null;
}
