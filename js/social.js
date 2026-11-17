// Accounts and leaderboards (docs/specs/social-phase1.md): signing in with Google through Supabase, the profile
// in the account, results sent after a ride and the tables read back. Without a project in social-config.js every
// call here does nothing and nothing loads: the app is as it was. The Supabase library is only fetched (from
// vendor/) once there is a project to talk to.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './social-config.js';
import { oauthReturn, enqueue } from './social-core.js';

export const CLIENT = 'gruppetto-web/1';
const AUTH_KEY = 'gruppetto.social.auth';
const QUEUE_KEY = 'gruppetto.social.queue';
const RIDE_QUEUE_KEY = 'gruppetto.social.rides'; // rides for the ratings across Ukraine, waiting to go

/** Whether this copy of the app has a project to sign in to. */
export const socialOn = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY);

let sb = null;
let user = null;
const listeners = new Set();

async function client() {
  if (!sb) {
    const { createClient } = await import('../vendor/supabase/supabase.esm.js');
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      // the return from Google is read by hand (initSocial): Strava's return also brings a ?code=
      auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true, storageKey: AUTH_KEY },
    });
  }
  return sb;
}

/** Throws with Supabase's message; the data otherwise. */
const ok = ({ data, error }) => { if (error) throw Object.assign(new Error(error.message || 'Supabase'), { status: error.status, code: error.code }); return data; };

/**
 * Starts the account: the way back from Google first (its ?code= becomes a session, and leaves the address), then
 * the session kept in this browser. { user, returned, error }; null without a project.
 */
export async function initSocial({ stravaState } = {}) {
  if (!socialOn()) return null;
  const c = await client();
  const back = oauthReturn(location.search, stravaState);
  let error = null;
  if (back) {
    const url = new URL(location.href);
    for (const k of ['code', 'error', 'error_code', 'error_description']) url.searchParams.delete(k);
    window.history.replaceState(null, '', url);
    if (back.code) { const r = await c.auth.exchangeCodeForSession(back.code).catch((e) => ({ error: e })); if (r.error) error = r.error.message || 'sign-in failed'; } else error = back.error;
  }
  const { data } = await c.auth.getSession().catch(() => ({ data: {} }));
  user = data?.session?.user || null;
  c.auth.onAuthStateChange((_ev, session) => {
    const u = session?.user || null;
    if ((u?.id || null) !== (user?.id || null)) { user = u; for (const f of listeners) f(user); }
  });
  return { user, returned: !!back, error };
}

export const currentUser = () => user;
/** Called with the user (or null) whenever someone signs in or out. */
export const onUser = (f) => { listeners.add(f); };

/** Off to Google; back on this page (without its query) signed in. */
export async function signIn(redirectTo) {
  const c = await client();
  ok(await c.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } }));
}

export async function signOut() {
  if (!sb) return;
  await sb.auth.signOut({ scope: 'local' }).catch(() => {});
  user = null;
  for (const f of listeners) f(null);
}

const PROFILE_COLS = 'display_name,country,gender,region,public,updated_at', PROFILE_COLS_OLD = 'display_name,country,gender,public,updated_at';
const noRegion = (r) => !!r.error && /region/.test(r.error.message || '');

/** My profile in the account (name, country, gender, public and data), or null before the first save. */
export async function loadProfile() {
  if (!user) return null;
  const c = await client();
  const read = (cols) => c.from('profiles').select(cols).eq('id', user.id).maybeSingle();
  const r = await read(`${PROFILE_COLS},data`);
  // a project without 0003_regions.sql yet has no region column: the profile reads as before
  return ok(noRegion(r) ? await read(`${PROFILE_COLS_OLD},data`) : r);
}

/** Writes my profile (any of display_name, country, gender, region, public, data). */
export async function saveProfile(fields) {
  if (!user) return null;
  const c = await client();
  const write = (f, cols) => c.from('profiles').upsert({ id: user.id, ...f }).select(cols).single();
  const r = await write(fields, PROFILE_COLS);
  if (!noRegion(r)) return ok(r);
  const { region: _, ...rest } = fields; // not in the project yet: everything else is saved
  return ok(await write(rest, PROFILE_COLS_OLD));
}

// ---------- Rides (full sync) ----------

/** My rides in the account: [{ id, entry, deleted, changed_at }], deletions included. Null when the table is not there yet. */
export async function loadActivities() {
  if (!user) return [];
  const c = await client();
  const out = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await c.from('activities').select('id,entry,deleted,changed_at').order('id').range(from, from + 499);
    if (error) { if (/activities/.test(error.message) && /(exist|schema cache)/.test(error.message)) return null; throw new Error(error.message); }
    out.push(...(data || []));
    if (!data || data.length < 500) return out;
  }
}

/** Writes rides (rows from activityRows), mine. */
export async function saveActivities(rows) {
  if (!user || !rows.length) return;
  const c = await client();
  for (let i = 0; i < rows.length; i += 100) {
    ok(await c.from('activities').upsert(rows.slice(i, i + 100).map((r) => ({ user_id: user.id, ...r })), { onConflict: 'user_id,id' }));
  }
}

// ---------- Results ----------

const readQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } };
const writeQueue = (q) => { try { if (q.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); else localStorage.removeItem(QUEUE_KEY); } catch { /* private mode */ } };

/** Results waiting to be sent (no network, or not signed in yet). */
export const queued = () => readQueue();
export function queueAdd(items) { if (items.length) writeQueue(enqueue(readQueue(), items)); }

/** Sends results: one answer each ({ status, reason?, place?, total?, week_place?, week_total? }). Throws offline. */
export async function submitEfforts(items) {
  if (!user || !items.length) return [];
  const c = await client();
  return ok(await c.rpc('submit_efforts', { items }));
}

/**
 * Sends what waits in the queue, with `items` from the ride just finished, and keeps whatever the server did not
 * answer (no network) for the next time. [{ item, result }] for the ones answered.
 */
export async function sendResults(items = []) {
  queueAdd(items);
  const q = readQueue();
  if (!user || !q.length) return [];
  const answers = [];
  for (let i = 0; i < q.length; i += 50) {
    const part = q.slice(i, i + 50);
    let res;
    try { res = await submitEfforts(part); } catch { break; } // offline, or the server is away: all of it stays
    part.forEach((item, k) => answers.push({ item, result: res?.[k] || null }));
  }
  const done = new Set(answers.map((a) => a.item));
  writeQueue(q.filter((x) => !done.has(x)));
  return answers;
}

/** A table: { total, rows: [{ place, display_name, country, time_s, wkg, avg_hr, ridden_at, flags, me }] }. */
export async function leaderboard({ segment, version, period = 'all', gender = null, category = null, aroundMe = true }) {
  const c = await client();
  const rows = ok(await c.rpc('leaderboard', { segment, version, period, gender, category, around_me: aroundMe })) || [];
  return { total: rows[0]?.total ?? 0, rows };
}

// ---------- Ratings across Ukraine (0003_regions.sql) ----------

const readRides = () => { try { return JSON.parse(localStorage.getItem(RIDE_QUEUE_KEY) || '[]'); } catch { return []; } };
const writeRides = (q) => { try { if (q.length) localStorage.setItem(RIDE_QUEUE_KEY, JSON.stringify(q)); else localStorage.removeItem(RIDE_QUEUE_KEY); } catch { /* private mode */ } };

/**
 * Sends a ride's totals (from rideTotal) with the ones still waiting; whatever the server did not answer stays for
 * next time (offline, or a project without 0003_regions.sql yet). The answers, [{ status, reason? }].
 */
export async function sendRides(ride = null) {
  const q = readRides().filter((x) => x.ride_id !== ride?.ride_id);
  if (ride) q.push(ride);
  writeRides(q.slice(-100));
  if (!user || !q.length) return [];
  let res;
  try {
    const c = await client();
    res = ok(await c.rpc('submit_rides', { items: q.slice(0, 50) }));
  } catch { return []; }
  writeRides(q.slice(50));
  return res || [];
}

/** Oblast against oblast: [{ place, region, riders, rides, distance_km, climb_m }]. metric: 'km' | 'climb'. */
export async function regionBoard({ period = 'week', metric = 'km' } = {}) {
  const c = await client();
  return ok(await c.rpc('region_board', { period, metric })) || [];
}

/** Rider against rider across Ukraine (or one oblast): { total, rows: [{ place, display_name, region, rides, distance_km, climb_m, me }] }. */
export async function riderBoard({ period = 'week', metric = 'km', region = null, gender = null, aroundMe = true } = {}) {
  const c = await client();
  const rows = ok(await c.rpc('rider_board', { period, metric, region, gender, around_me: aroundMe })) || [];
  return { total: rows[0]?.total ?? 0, rows };
}

/** The group rides' calendar (#84): [{ id, title, route_id, starts_at, host_name, mine, riders, joined, kind, laps }], soonest first. */
export async function groupRides(days = 14) {
  const c = await client();
  return ok(await c.rpc('group_ride_list', { days })) || [];
}
/** A new group ride you host (and have joined), or a race over `laps` laps (kind 'race'): its id. */
export async function createGroupRide({ title, routeId, startsAt, kind = 'ride', laps = null, league = null }) {
  const c = await client();
  const args = { p_title: title, p_route: routeId, p_starts: new Date(startsAt).toISOString(), p_kind: kind, p_laps: kind === 'race' ? laps : null };
  if (league && kind === 'race') args.p_league = league; // only when set: the call works on a database without leagues too
  return ok(await c.rpc('create_group_ride', args));
}

/** Leagues (#84, part 2): [{ id, title, host_name, races, next_at, mine }], the soonest next race first. */
export async function leagues() { return ok(await (await client()).rpc('league_list')) || []; }
/** A new league you host: its id. */
export async function createLeague(title) { return ok(await (await client()).rpc('create_league', { p_title: title })); }
/** A league's standings, most points first: [{ name, points, races, wins, best, me }]. */
export async function leagueStandings(id) { return ok(await (await client()).rpc('league_standings', { p_id: id })) || []; }
/** A league's races, in order: [{ id, title, route_id, starts_at, laps, finishers }]. */
export async function leagueRaces(id) { return ok(await (await client()).rpc('league_races', { p_id: id })) || []; }
/** Your finish in a group race (s), with your average watts and W/kg; the first one sent stands. */
export async function finishGroupRace(id, { time, avgW = null, wkg = null, sim = false }) {
  ok(await (await client()).rpc('finish_group_race', { p_id: id, p_time: time, p_avg_w: avgW, p_wkg: wkg, p_sim: sim }));
}
/** A group race's results, fastest first: [{ name, time_s, avg_w, wkg, sim, me }]. */
export async function groupRaceResults(id) {
  return ok(await (await client()).rpc('group_race_results', { p_id: id })) || [];
}
export async function cancelGroupRide(id) { ok(await (await client()).rpc('cancel_group_ride', { p_id: id })); }
export async function joinGroupRide(id, on = true) { ok(await (await client()).rpc('join_group_ride', { p_id: id, p_on: on })); }

/**
 * Riding a group ride together: a Realtime broadcast channel of its own, where each rider's packet (group.js)
 * goes to the others. { send(packet), leave() }; onPacket gets the others' packets (never your own).
 */
export async function groupLive(id, onPacket) {
  const c = await client();
  const ch = c.channel(`group:${id}`, { config: { broadcast: { self: false } } });
  ch.on('broadcast', { event: 'pos' }, (m) => onPacket(m.payload));
  let joined = false;
  ch.subscribe((s) => { joined = s === 'SUBSCRIBED'; });
  return {
    get joined() { return joined; },
    send: (p) => { if (joined) ch.send({ type: 'broadcast', event: 'pos', payload: p }).catch(() => {}); },
    leave: () => { joined = false; c.removeChannel(ch).catch(() => {}); },
  };
}

/** The account and every result in it, gone; signed out here. What is on this device stays. */
export async function deleteAccount() {
  const c = await client();
  ok(await c.rpc('delete_me'));
  writeQueue([]);
  writeRides([]);
  await signOut();
}
