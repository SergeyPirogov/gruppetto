// Accounts and leaderboards (docs/specs/social-phase1.md): signing in with Google through Supabase, the profile
// in the account, results sent after a ride and the tables read back. Without a project in social-config.js every
// call here does nothing and nothing loads: the app is as it was. The Supabase library is only fetched (from
// vendor/) once there is a project to talk to.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './social-config.js';
import { oauthReturn, enqueue } from './social-core.js';

export const CLIENT = 'gruppetto-web/1';
const AUTH_KEY = 'gruppetto.social.auth';
const QUEUE_KEY = 'gruppetto.social.queue';

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

/** My profile in the account (name, country, gender, public and data), or null before the first save. */
export async function loadProfile() {
  if (!user) return null;
  const c = await client();
  return ok(await c.from('profiles').select('display_name,country,gender,public,data,updated_at').eq('id', user.id).maybeSingle());
}

/** Writes my profile (any of display_name, country, gender, public, data). */
export async function saveProfile(fields) {
  if (!user) return null;
  const c = await client();
  return ok(await c.from('profiles').upsert({ id: user.id, ...fields }).select('display_name,country,gender,public,updated_at').single());
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

/** The account and every result in it, gone; signed out here. What is on this device stays. */
export async function deleteAccount() {
  const c = await client();
  ok(await c.rpc('delete_me'));
  writeQueue([]);
  await signOut();
}
