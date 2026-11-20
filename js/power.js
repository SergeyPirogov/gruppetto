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
 * W′ from your rides: the critical power model through your best 5 and 20 minutes (work = CP·t + W′), over the
 * last `days`. Suggested when it is plausible (5–60 kJ) and at least 1 kJ off the W′ you have now (kJ).
 */
export function wPrimeSuggestion(entries, wPrimeKj, { days = 90, now = Date.now() } = {}) {
  const c = powerCurve(entries.filter((e) => now - Date.parse(e.date) <= days * 864e5), { now });
  const p5 = c[300]?.w, p20 = c[1200]?.w;
  if (!p5 || !p20 || p5 <= p20) return null;
  const wPrime = ((p5 - p20) * 300 * 1200) / (1200 - 300), cp = (p20 * 1200 - p5 * 300) / (1200 - 300);
  const kj = Math.round(wPrime / 100) / 10;
  if (kj < 5 || kj > 60 || Math.abs(kj - wPrimeKj) < 1) return null;
  return { kj, cp: Math.round(cp), p5, p20 };
}

/** A ramp test's result: FTP = 75 % of the best minute. */
export const rampFtp = (best1min) => Math.round(best1min * 0.75);

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

/** Pauses in pedalling: runs of 3 s and more without power, { n, sec } (the first and last seconds count too). */
export function stopsOf(powers, every = 1) {
  let n = 0, sec = 0, run = 0;
  const end = () => { if (run * every >= 3) { n++; sec += run * every; } run = 0; };
  for (const p of powers) { if (p > 0) end(); else run++; }
  end();
  return { n, sec };
}
