// Social, phase 1 (docs/specs/social-phase1.md): the parts with no network and no page, so they run in the tests
// and, for the checks, the same way as the database's own (supabase/migrations/0001_social.sql, the server has the
// last word). Categories, route versions and the plausibility checks are shared with the live rides of phase 2.

// ---------- What goes to the account ----------

/** The settings that follow you to another device: who you are and how you look, nothing about this computer. */
export const SYNC_FIELDS = ['name', 'weight', 'height', 'ftp', 'wPrimeKj', 'maxHr', 'lthr', 'hrZones', 'hrZoneNames', 'jersey', 'stripe', 'bikeColor', 'lang'];

/** The synced settings out of all of them (lang lives apart from the settings, so it comes in on its own). */
export function profileFields(settings, lang) {
  const out = {};
  for (const k of SYNC_FIELDS) {
    const v = k === 'lang' ? lang : settings?.[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Records without the climb ghosts' traces (large, and only for this device). */
export function syncRecords(r) {
  return { lap: { ...(r?.lap || {}) }, seg: { ...(r?.seg || {}) }, top: { ...(r?.top || {}) } };
}

/** What a profile keeps in the account: the synced settings (with when they changed), levels and records. */
export function accountData({ settings, lang, settingsUpdatedAt, progress, records }) {
  return { profile: profileFields(settings, lang), settingsUpdatedAt: settingsUpdatedAt || 0, progress: progress || null, records: syncRecords(records) };
}

const num = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** Two sets of records as one: the shorter lap and segment time, the higher sprint speed. */
export function mergeRecords(a, b) {
  const out = { lap: {}, seg: {}, top: {} };
  for (const k of ['lap', 'seg']) {
    for (const src of [a?.[k], b?.[k]]) {
      for (const [id, t] of Object.entries(src || {})) if (num(t) && !(out[k][id] <= t)) out[k][id] = t;
    }
  }
  for (const src of [a?.top, b?.top]) {
    for (const [id, v] of Object.entries(src || {})) if (num(v) && !(out.top[id] >= v)) out.top[id] = v;
  }
  return out;
}

/** Two sets of levels as one: the one with more XP, with every badge either earned, on the earlier day. */
export function mergeProgress(a, b) {
  if (!a) return b ? { ...b, badges: { ...(b.badges || {}) } } : null;
  if (!b) return { ...a, badges: { ...(a.badges || {}) } };
  const main = (b.xp || 0) > (a.xp || 0) ? b : a;
  const badges = { ...(main.badges || {}) };
  for (const src of [a.badges, b.badges]) {
    for (const [id, d] of Object.entries(src || {})) if (!badges[id] || (d && d < badges[id])) badges[id] = d;
  }
  return { ...main, badges };
}

/**
 * This device's data and the account's as one: the newer profile (by settingsUpdatedAt; this device's on a tie),
 * the best records and the bigger levels. Never just one side over the other, so a first sign-in on a device with
 * rides of its own loses nothing.
 */
export function mergeData(local, remote) {
  if (!remote || !remote.profile) return { ...local, records: mergeRecords(local?.records, null), progress: mergeProgress(local?.progress, null) };
  const remoteNewer = (remote.settingsUpdatedAt || 0) > (local?.settingsUpdatedAt || 0);
  return {
    profile: { ...(remoteNewer ? remote.profile : local?.profile) },
    settingsUpdatedAt: Math.max(remote.settingsUpdatedAt || 0, local?.settingsUpdatedAt || 0),
    records: mergeRecords(local?.records, remote.records),
    progress: mergeProgress(local?.progress, remote.progress),
  };
}

/** The same data, compared as JSON with its keys in order (so nothing is sent when nothing changed). */
export function sameData(a, b) {
  const norm = (x) => (Array.isArray(x) ? x.map(norm) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm(x[k])])) : x);
  return JSON.stringify(norm(a ?? null)) === JSON.stringify(norm(b ?? null));
}

// ---------- Categories and route versions ----------

/** A, B, C or D from FTP per kilo on the day: A from 4.0, B from 3.2, C from 2.5 W/kg. */
export function categoryOf(ftp, weight) {
  const w = ftp / weight;
  if (!(w > 0)) return 'D';
  return w >= 4 ? 'A' : w >= 3.2 ? 'B' : w >= 2.5 ? 'C' : 'D';
}

/** FNV-1a, 32 bits, as 8 hex digits. */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/**
 * A short hash of a route's shape (its length and its height every 100 m, to the metre): the same in every
 * browser, and a new one when the route changes in the code, so old times and new ones never share a table.
 */
export function routeVersion(route) {
  const L = Math.round(route.length);
  const parts = [L];
  for (let d = 0; d <= L; d += 100) parts.push(Math.round(route.elevAt(Math.min(d, L - 0.01))));
  return fnv(parts.join(','));
}

// ---------- Plausibility ----------

/** The highest believable average W/kg for an effort this long: a little above the world's best. */
export const WKG_CEILING = [[60, 13], [300, 8], [1200, 6.8], [Infinity, 6.3]];
export const wkgCeiling = (sec) => WKG_CEILING.find(([d]) => sec <= d)[1];
export const MAX_SPEED = 25; // m/s on average: 90 km/h, as plausibleLap
export const DAILY_LIMIT = 200;

/**
 * Whether a result may go in a table, as the server checks it: { ok, reason } when it may not
 * ('weight' | 'ftp' | 'time' | 'speed' | 'power' | 'wkg' | 'limit' | 'invalid'), { ok, flags } when it may
 * ('no-hr': no heart rate, 'high': above 90 % of the ceiling; shown with a quiet «?»).
 */
export function checkEffort(e, { today = 0 } = {}) {
  if (!e || !['climb', 'sprint', 'lap'].includes(e.kind) || !e.segment_id || !e.route_id || !e.route_version) return { ok: false, reason: 'invalid' };
  if (today >= DAILY_LIMIT) return { ok: false, reason: 'limit' };
  const w = Number(e.weight_kg), ftp = Number(e.ftp), t = Number(e.time_s), len = Number(e.length_m), p = Number(e.avg_power);
  if (!(w >= 30 && w <= 200)) return { ok: false, reason: 'weight' };
  if (!(ftp >= 50 && ftp <= 600)) return { ok: false, reason: 'ftp' };
  if (!(t >= 5 && t <= 86400)) return { ok: false, reason: 'time' };
  if (!(len >= 50 && len <= 300000) || len / t > MAX_SPEED) return { ok: false, reason: 'speed' };
  if (!(p > 0)) return { ok: false, reason: 'power' };
  const wkg = p / w, cap = wkgCeiling(t);
  if (wkg > cap) return { ok: false, reason: 'wkg' };
  const flags = [];
  if (!(Number(e.avg_hr) > 0)) flags.push('no-hr');
  if (wkg > cap * 0.9) flags.push('high');
  return { ok: true, flags };
}

// ---------- A ride's results ----------

/** Average power (zeros in: coasting counts) and heart rate (zeros out) of samples [from, to). */
export function averages(samples, from, to) {
  const s = samples.slice(Math.max(0, from), Math.max(0, to));
  if (!s.length) return { power: 0, hr: null };
  const p = s.reduce((a, x) => a + (x.power || 0), 0) / s.length;
  const hrs = s.map((x) => x.heartRate).filter((h) => h > 0);
  return { power: Math.round(p), hr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null };
}

/**
 * What a ride sends to the tables: its laps (or the finish) and its climbs and sprints, on a built-in route,
 * never from the simulator. `efforts` and `laps` come from the ride as { segId, kind, time, length, power, hr,
 * top?, at }. The ones the server would refuse stay here.
 */
export function rideItems({ route, version, simulated, efforts = [], laps = [], weight, ftp, client }) {
  if (simulated || !route || route.custom) return [];
  const out = [];
  for (const x of [...laps, ...efforts]) {
    if (!x?.segId) continue;
    const item = {
      segment_id: x.segId, kind: x.kind, route_id: route.id, route_version: version,
      time_s: Math.round(x.time * 10) / 10, length_m: Math.round(x.length), avg_power: x.power || 0, avg_hr: x.hr || null,
      weight_kg: Math.round(weight * 10) / 10, ftp: Math.round(ftp), top_speed_kmh: x.top ?? null,
      ridden_at: new Date(x.at).toISOString(), client: client || null,
    };
    if (checkEffort(item).ok) out.push(item);
  }
  return out;
}

/** One result, the same wherever it comes from (for the queue: never sent twice). */
export const itemKey = (x) => `${x.segment_id}|${x.ridden_at}`;

/** The queue with new results added: no doubles, at most 500 (the oldest go first). */
export function enqueue(queue, items) {
  const seen = new Set((queue || []).map(itemKey));
  const out = [...(queue || [])];
  for (const x of items) if (!seen.has(itemKey(x))) { seen.add(itemKey(x)); out.push(x); }
  return out.slice(-500);
}

// ---------- Coming back from Google ----------

/**
 * What the address says when Supabase's sign-in sends you back: { code } or { error }, or null when it was not
 * Supabase (nothing there, or Strava's return, which carries our own state).
 */
export function oauthReturn(search, stravaState) {
  const q = new URLSearchParams(search);
  if (q.get('state') === stravaState) return null;
  if (q.get('error') || q.get('error_description')) return q.get('state') ? null : { error: q.get('error_description') || q.get('error') };
  const code = q.get('code');
  return code && !q.get('state') ? { code } : null;
}

// ---------- Tables ----------

/** When a period starts (UTC; a week from Monday), or null for all time. */
export function periodStart(period, now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'week') { d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d; }
  if (period === 'month') { d.setUTCDate(1); return d; }
  return null;
}

/**
 * A table as the database's leaderboard() makes it, from rows of results: the best time of each person in the
 * filter (public profiles only), the top 10 and, when I am lower, three either side of me. Here for the tests
 * and the mock server; the real one is SQL.
 */
export function boardFrom(rows, { me = null, period = 'all', gender = null, category = null, aroundMe = true, now = new Date() } = {}) {
  const since = periodStart(period, now);
  const best = new Map();
  for (const r of rows) {
    if (r.public === false) continue;
    if (since && new Date(r.ridden_at) < since) continue;
    if (gender && r.gender !== gender) continue;
    if (category && r.category !== category) continue;
    const b = best.get(r.user_id);
    if (!b || r.time_s < b.time_s || (r.time_s === b.time_s && r.ridden_at < b.ridden_at)) best.set(r.user_id, r);
  }
  const ranked = [...best.values()].sort((a, b) => a.time_s - b.time_s || String(a.ridden_at).localeCompare(String(b.ridden_at)))
    .map((r, i) => ({ ...r, place: i + 1, me: r.user_id === me }));
  const mine = ranked.find((r) => r.me);
  const rowsOut = ranked.filter((r) => r.place <= 10 || (aroundMe && mine && Math.abs(r.place - mine.place) <= 3));
  return { total: ranked.length, rows: rowsOut, mine: mine || null };
}

/** The rows of a table with a gap marked where they jump (11th, then 147th). */
export function withGaps(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (i && rows[i].place > rows[i - 1].place + 1) out.push({ gap: true });
    out.push(rows[i]);
  }
  return out;
}

/** 🇺🇦 from UA. */
export const flagOf = (cc) => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '');
