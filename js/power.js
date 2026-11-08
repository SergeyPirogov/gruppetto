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
