// The challenge of the day (#55): one small goal a day, the same for everyone, picked from the date, and a streak
// of days in a row. It works offline and in the simulator: a reason to finish today's ride and come back tomorrow.
// Three kinds in turn: the top of a climb on a Gruppetto route, a distance, a time on the bike.

/** YYYY-MM-DD of a date in local time: a day starts at the rider's midnight, not at UTC's. */
export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const dayNum = (day) => Math.round(Date.parse(`${day}T00:00:00Z`) / 864e5);

/** A number from the day, the same on every device: picks the goal, so a day's goal never changes. */
function seed(n) {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
  return x >>> 0;
}

// short enough for a first ride in the simulator: most of those end within 5 minutes (GoatCounter, November 2026)
const KM = [3, 5, 8, 10];
const MIN = [10, 15, 20, 30];

/**
 * The goal of `day` (YYYY-MM-DD). `routes`: the Gruppetto routes ({ id, name, custom, climbs: [{ id, name, sprint }] }).
 * { day, kind: 'climb', routeId, climbId, climb, route } | { day, kind: 'km', km } | { day, kind: 'min', min }.
 */
export function dailyGoal(day, routes = []) {
  const n = dayNum(day), r = seed(n);
  const climbs = routes.filter((x) => !x.custom).flatMap((x) => (x.climbs || []).filter((c) => !c.sprint).map((c) => ({ route: x, c })));
  const kinds = climbs.length ? ['climb', 'km', 'min'] : ['km', 'min'];
  const kind = kinds[((n % kinds.length) + kinds.length) % kinds.length];
  if (kind === 'climb') {
    const { route, c } = climbs[r % climbs.length];
    return { day, kind, routeId: route.id, climbId: c.id, climb: c.name, route: route.name };
  }
  if (kind === 'km') return { day, kind, km: KM[r % KM.length] };
  return { day, kind, min: MIN[r % MIN.length] };
}

/** How far into the goal a ride is, 0…1: { dist } in metres, { elapsed } in seconds, { efforts } climbs done. */
export function goalProgress(goal, { dist = 0, elapsed = 0, efforts = [], routeId } = {}) {
  if (!goal) return 0;
  if (goal.kind === 'km') return Math.min(1, dist / (goal.km * 1000));
  if (goal.kind === 'min') return Math.min(1, elapsed / (goal.min * 60));
  if (goal.kind === 'climb') return routeId === goal.routeId && efforts.some((e) => e.segId === goal.climbId) ? 1 : 0;
  return 0;
}

/**
 * The streak: days in a row with the goal done, up to today. A streak is alive until a day goes by without it:
 * done yesterday and not yet today still counts (there is the rest of today to keep it).
 */
export function streakOf(doneDays = [], today = localDay()) {
  const set = new Set(doneDays.map(dayNum));
  let d = dayNum(today);
  if (!set.has(d)) d -= 1;
  let n = 0;
  while (set.has(d)) { n++; d--; }
  return n;
}

/** The days done, with `day` added once; the last 60 kept. */
export function markDone(doneDays = [], day) {
  return doneDays.includes(day) ? doneDays : [...doneDays, day].slice(-60);
}
