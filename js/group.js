// Group rides (#84): a ride at a set time on a built-in route, ridden together live. The calendar is in the
// database (supabase/migrations/0004_group_rides.sql); while riding, each rider sends where they are once a second
// over Supabase Realtime broadcast, and the others are drawn there, carried on at their speed between packets.
// This file is the pure part: when a ride is open, what a packet holds, and the riders heard from.

/** The ride opens this long before the start (s): you wait on the line with a countdown. */
export const OPENS_BEFORE = 10 * 60;
/** After the start it stays open to ride for this long (s). */
export const LIVE_FOR = 2 * 3600;
/** A rider not heard from for this long (s) has gone. */
export const STALE = 6;
const LOOK = /^#[0-9a-f]{3,8}$/i;

/** Where a ride starting at `startsAt` (ms) stands at `now` (ms): later, open (in s to the start), live (since s), over. */
export function rideWindow(startsAt, now) {
  const t = (now - startsAt) / 1000;
  if (t < -OPENS_BEFORE) return { state: 'later', in: -t };
  if (t < 0) return { state: 'open', in: -t };
  if (t < LIVE_FOR) return { state: 'live', since: t };
  return { state: 'over' };
}

const round = (x, k) => Math.round(x * k) / k;

/** Your position as sent: who (account id and name), where, how fast, which lane, watts and W/kg, the look, and in a race your finish time (s). */
export function packet(me, now) {
  const L = me.look || {};
  return {
    u: me.id, n: String(me.name || '').slice(0, 40), d: round(me.dist, 10), v: round(me.v, 100), l: round(me.lane, 100), p: Math.max(0, Math.min(3000, Math.round(me.power || 0))), w: round(me.wkg || 0, 10),
    j: L.jersey || null, s: L.stripe || null, b: L.bike || null, f: L.figure === 'female' ? 'female' : 'male', t: now,
    ...(me.finish > 0 ? { x: round(me.finish, 10) } : {}),
  };
}

/**
 * The riders heard from: each drawn where its last packet put it, carried on at its speed (up to 3 s), and eased
 * toward each new packet instead of jumping (a far jump, from a tab that slept, snaps).
 */
export class Mates {
  constructor(selfId) { this.self = selfId; this.by = new Map(); this.done = new Map(); }

  receive(p, now) {
    if (!p || typeof p.u !== 'string' || p.u.length > 64 || p.u === this.self) return;
    const d = Number(p.d), v = Number(p.v);
    if (!Number.isFinite(d) || !Number.isFinite(v) || v < 0 || v > 30 || Math.abs(d) > 1e6) return;
    const was = this.by.get(p.u);
    const look = (x) => (typeof x === 'string' && LOOK.test(x) ? x : null);
    this.by.set(p.u, {
      id: p.u, name: String(p.n || '').slice(0, 40), d, v, lane: Math.max(-2.6, Math.min(2.6, Number(p.l) || 0)), wkg: Number(p.w) || 0, power: Math.max(0, Math.min(3000, Number(p.p) || 0)),
      color: look(p.j) || '#64748b', stripe: look(p.s) || '#e2e8f0', bike: look(p.b), figure: p.f === 'female' ? 'female' : 'male',
      at: now, shown: was && Math.abs(was.shown - d) < 30 ? was.shown : d, seen: was?.seen ?? now,
    });
    // a race: the finish time, kept after the rider has gone (the first one heard stands)
    const x = Number(p.x);
    if (Number.isFinite(x) && x > 0 && x < 86400 && !this.done.has(p.u)) {
      const m = this.by.get(p.u);
      this.done.set(p.u, { id: p.u, name: m.name, color: m.color, stripe: m.stripe, wkg: m.wkg, power: m.power, finish: x });
    }
  }

  /** The riders who have finished the race: [{ id, name, color, stripe, wkg, finish }], in the order heard. */
  finished() { return [...this.done.values()]; }

  /** The riders to draw at `now` (ms), for the renderer and the shelter. */
  list(now) {
    const out = [];
    for (const [id, m] of this.by) {
      if (now - m.at > STALE * 1000) { this.by.delete(id); continue; }
      const guess = m.d + m.v * Math.min(3, Math.max(0, now - m.at) / 1000);
      const dt = Math.max(0, Math.min(0.5, (now - m.seen) / 1000));
      m.shown = Math.abs(guess - m.shown) > 30 ? guess : m.shown + m.v * dt + (guess - (m.shown + m.v * dt)) * Math.min(1, dt * 3);
      if (now === m.at && m.seen === now) m.shown = guess;
      m.seen = now;
      out.push({
        key: `mate:${id}:${m.color}:${m.stripe}:${m.bike || ''}:${m.figure}`, mate: true, id, name: m.name, color: m.color, stripe: m.stripe, bike: m.bike,
        figure: m.figure, dist: m.shown, v: m.v, lane: m.lane, wkg: m.wkg, power: m.power, pedal: m.shown * 1.05,
      });
    }
    return out;
  }
}

/**
 * The race as a spectator sees it (#86): everyone heard from, those finished first by their time, then the rest by
 * how far they have got; with the lap (on a loop of `length` m) and the gap to the one in front in seconds.
 * [{ id, name, color, stripe, dist, v, power, wkg, lap, finish, place, gap }]
 */
export function spectate(mates, now, { length = 0, laps = 1, oneWay = false } = {}) {
  const done = mates.finished(), live = mates.list(now).filter((m) => !done.some((d) => d.id === m.id));
  const total = length * (oneWay ? 1 : Math.max(1, laps));
  const rows = [
    ...[...done].sort((a, b) => a.finish - b.finish).map((d) => ({ ...live.find((m) => m.id === d.id), ...d, dist: total || d.dist || 0, v: 0, finished: true })),
    ...live.sort((a, b) => b.dist - a.dist).map((m) => ({ ...m, finish: null, finished: false })),
  ];
  return rows.map((r, i) => {
    const ahead = rows[i - 1];
    const gap = !ahead ? null : r.finished ? r.finish - ahead.finish : ahead.finished ? null : (ahead.dist - r.dist) / Math.max(3, r.v || 0);
    const lap = length > 0 && !oneWay ? Math.min(Math.max(1, laps), Math.floor(Math.max(0, r.dist) / length) + 1) : 1;
    return { id: r.id, name: r.name, color: r.color, stripe: r.stripe, dist: r.dist, v: r.v || 0, power: r.power || 0, wkg: r.wkg || 0, lap, finish: r.finish ?? null, place: i + 1, gap };
  });
}
