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

/** Your position as sent: who (account id and name), where, how fast, which lane, W/kg, and the look. */
export function packet(me, now) {
  const L = me.look || {};
  return {
    u: me.id, n: String(me.name || '').slice(0, 40), d: round(me.dist, 10), v: round(me.v, 100), l: round(me.lane, 100), w: round(me.wkg || 0, 10),
    j: L.jersey || null, s: L.stripe || null, b: L.bike || null, f: L.figure === 'female' ? 'female' : 'male', t: now,
  };
}

/**
 * The riders heard from: each drawn where its last packet put it, carried on at its speed (up to 3 s), and eased
 * toward each new packet instead of jumping (a far jump, from a tab that slept, snaps).
 */
export class Mates {
  constructor(selfId) { this.self = selfId; this.by = new Map(); }

  receive(p, now) {
    if (!p || typeof p.u !== 'string' || p.u.length > 64 || p.u === this.self) return;
    const d = Number(p.d), v = Number(p.v);
    if (!Number.isFinite(d) || !Number.isFinite(v) || v < 0 || v > 30 || Math.abs(d) > 1e6) return;
    const was = this.by.get(p.u);
    const look = (x) => (typeof x === 'string' && LOOK.test(x) ? x : null);
    this.by.set(p.u, {
      id: p.u, name: String(p.n || '').slice(0, 40), d, v, lane: Math.max(-2.6, Math.min(2.6, Number(p.l) || 0)), wkg: Number(p.w) || 0,
      color: look(p.j) || '#64748b', stripe: look(p.s) || '#e2e8f0', bike: look(p.b), figure: p.f === 'female' ? 'female' : 'male',
      at: now, shown: was && Math.abs(was.shown - d) < 30 ? was.shown : d, seen: was?.seen ?? now,
    });
  }

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
        figure: m.figure, dist: m.shown, v: m.v, lane: m.lane, wkg: m.wkg, pedal: m.shown * 1.05,
      });
    }
    return out;
  }
}
