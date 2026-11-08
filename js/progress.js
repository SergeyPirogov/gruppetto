// Levels and achievements (#progress): reasons to come back. XP for every ride (10 a km, 1 a metre climbed, 1 a
// minute), levels that take a little longer each, and badges for firsts, totals and habits. Kept apart from the
// history, which keeps only the latest rides: the totals here never shrink.

/** XP of one ride. */
export function rideXp(e) {
  const s = e.summary || {};
  return Math.round((s.distance || 0) / 100 + (s.elevationGain || 0) + (s.duration || 0) / 60);
}

/** The XP a level starts at: 0, 500, 1500, 3000, 5000 … (each one 500 more than the one before). */
export const levelStart = (n) => 250 * n * (n - 1);

/** Level, and how far into it, for this much XP. */
export function levelOf(xp) {
  let n = 1;
  while (levelStart(n + 1) <= xp) n++;
  const from = levelStart(n), to = levelStart(n + 1);
  return { level: n, xp, from, to, frac: (xp - from) / (to - from) };
}

const day = (iso) => String(iso || '').slice(0, 10);
const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 864e5);

/** Days in a row with a ride, ending on the last of days (YYYY-MM-DD). */
function streak(days) {
  const nums = [...new Set(days)].map(dayNum).sort((a, b) => b - a);
  let n = nums.length ? 1 : 0;
  for (let i = 1; i < nums.length && nums[i - 1] - nums[i] === 1; i++) n++;
  return n;
}

/** Every badge: its icon, name, what earns it, and the test on the totals (p) after the ride (e). */
export const BADGES = [
  { id: 'first', icon: '🚴', name: 'First ride', how: 'Finish a ride', test: (p) => p.rides >= 1 },
  { id: 'rides10', icon: '🔟', name: 'Regular', how: '10 rides', test: (p) => p.rides >= 10 },
  { id: 'rides50', icon: '🏅', name: 'Devoted', how: '50 rides', test: (p) => p.rides >= 50 },
  { id: 'km100', icon: '💯', name: '100 km', how: '100 km in all', test: (p) => p.km >= 100 },
  { id: 'km1000', icon: '🌍', name: '1000 km', how: '1000 km in all', test: (p) => p.km >= 1000 },
  { id: 'everest', icon: '🏔️', name: 'Everest', how: '8848 m climbed in all', test: (p) => p.gain >= 8848 },
  { id: 'hour', icon: '⏱️', name: 'The hour', how: 'A ride of an hour or more', test: (p, e) => (e?.summary?.duration || 0) >= 3600 },
  { id: 'fifty', icon: '🛣️', name: 'Fifty', how: '50 km in one ride', test: (p, e) => (e?.summary?.distance || 0) >= 50000 },
  { id: 'climb1000', icon: '⛰️', name: 'Climber', how: '1000 m climbed in one ride', test: (p, e) => (e?.summary?.elevationGain || 0) >= 1000 },
  { id: 'streak3', icon: '🔥', name: 'On a roll', how: 'Ride 3 days in a row', test: (p) => streak(p.days) >= 3 },
  { id: 'week5', icon: '📅', name: 'Five a week', how: '5 rides within 7 days', test: (p, e) => e && p.days.filter((d) => dayNum(day(e.date)) - dayNum(d) < 7).length >= 5 },
  { id: 'ramp', icon: '📈', name: 'Tested', how: 'Do a ramp test', test: (p, e) => !!e?.ramp },
  { id: 'workout', icon: '🎯', name: 'Structured', how: 'Finish a workout', test: (p, e) => !!e?.workoutName && !e?.ramp },
  { id: 'race', icon: '🏁', name: 'Racer', how: 'Ride a race', test: (p, e) => !!e?.race },
  { id: 'podium', icon: '🥇', name: 'Winner', how: 'Win a race', test: (p, e) => e?.race?.[0]?.me === true },
  { id: 'ghost', icon: '👻', name: 'Ghostbuster', how: 'Beat a ghost', test: (p, e) => (e?.ghostGap ?? -1) > 0 },
];

/** Empty totals. */
export const newProgress = () => ({ xp: 0, rides: 0, km: 0, gain: 0, days: [], badges: {}, counted: [] });

/**
 * Adds a ride to the totals (once per ride id): the new totals, the badges it earned and whether the level went
 * up. days keeps the last 30 ride days (for streaks), counted the last 300 ride ids.
 */
export function addRide(p0, e) {
  const p = { ...newProgress(), ...p0, days: [...(p0?.days || [])], badges: { ...(p0?.badges || {}) }, counted: [...(p0?.counted || [])] };
  if (!e?.id || p.counted.includes(e.id)) return { progress: p, badges: [], levelUp: false };
  const before = levelOf(p.xp).level;
  p.xp += rideXp(e);
  p.rides += 1;
  p.km = Math.round((p.km + (e.summary?.distance || 0) / 1000) * 10) / 10;
  p.gain = Math.round(p.gain + (e.summary?.elevationGain || 0));
  p.days = [...p.days, day(e.date)].slice(-30);
  p.counted = [...p.counted, e.id].slice(-300);
  const earned = BADGES.filter((b) => !p.badges[b.id] && b.test(p, e));
  for (const b of earned) p.badges[b.id] = day(e.date);
  return { progress: p, badges: earned, levelUp: levelOf(p.xp).level > before };
}

/** Totals from a history kept before progress existed (oldest first), with what those rides earned. */
export function progressFrom(entries) {
  let p = newProgress();
  for (const e of [...entries].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))) p = addRide(p, e).progress;
  return p;
}
