// Leagues (#84, part 2): a series of group races with points. The standings are worked out in the database
// (supabase/migrations/0006_leagues.sql); this is the pure part the page shows them with.

/** The points for each place, 1st to 15th; after that, none. The same as league_points() in the database. */
export const POINTS = [25, 20, 16, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

/** The points for a place in a race (1 is the winner). */
export const leaguePoints = (place) => (Number.isInteger(place) && place >= 1 && place <= POINTS.length ? POINTS[place - 1] : 0);

/** A league's races (each with starts_at) split at `now` (ms): those ridden or riding (started), and those to come. */
export function splitRaces(races, now) {
  const done = [], next = [];
  for (const r of races || []) (Date.parse(r.starts_at) <= now ? done : next).push(r);
  return { done, next };
}

/** The standings' rows, each with its place: equal points share a place (1, 2, 2, 4). */
export function placed(rows) {
  let last = null, place = 0;
  return (rows || []).map((r, i) => {
    if (r.points !== last) { place = i + 1; last = r.points; }
    return { ...r, place };
  });
}
