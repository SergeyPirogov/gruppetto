// Strava (#32): connect once, then a finished ride goes up as a virtual ride (the FIT says cycling /
// virtual_activity, which Strava files as a Virtual Ride). Strava will not hand out tokens to a page holding
// no secret, so the code and the refresh go through a small token function that keeps it (see TOKEN_URL).
// Tokens live only in this browser.

import { SUPABASE_URL } from './social-config.js';

// Gruppetto's own Strava app, once registered: its client id here, the id and secret in the `strava` function's
// secrets (supabase/functions/strava). Till then the shared Slipstream app and its token function on Vercel.
const OWN_APP_ID = '';
const SHARED_APP_ID = '167103';
export const STRAVA_CLIENT_ID = OWN_APP_ID || SHARED_APP_ID;
const TOKEN_URL = OWN_APP_ID && SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/strava` : 'https://slipstream-bice.vercel.app/api/strava-token';
const API = 'https://www.strava.com/api/v3';
const KEY = 'gruppetto.strava';
export const STRAVA_STATE = 'gruppetto-strava';

/** Where Strava sends you back: this page, without its query. */
export const stravaRedirect = (loc = location) => `${loc.origin}${loc.pathname}`;

/** Strava's page asking you to let Gruppetto upload rides. */
export function stravaAuthorizeUrl(redirect) {
  const q = new URLSearchParams({
    client_id: STRAVA_CLIENT_ID, redirect_uri: redirect, response_type: 'code',
    approval_prompt: 'auto', scope: 'read,read_all,activity:write', state: STRAVA_STATE, // read_all: your private routes too
  });
  return `https://www.strava.com/oauth/authorize?${q}`;
}

/**
 * What Strava's return to this page says: { code } when you allowed uploads, { error } when you did not
 * (declined, or unticked «Upload your activities»), or null when the page was not opened by Strava.
 */
export function stravaReturn(search) {
  const q = new URLSearchParams(search);
  if (q.get('state') !== STRAVA_STATE) return null;
  if (q.get('error')) return { error: 'denied' };
  const code = q.get('code');
  if (!code) return null;
  const scope = (q.get('scope') || '').split(',');
  return scope.includes('activity:write') ? { code } : { error: 'no-write' };
}

/**
 * Your Strava routes that are rides, newest first, as the route list shows them. A route's id is past what a JS
 * number holds exactly, so it is read as the text Strava also sends (id_str).
 */
export function rideRoutes(list) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && (r.type === 1 || r.type === undefined) && (r.id_str || r.id))
    .map((r) => ({ id: String(r.id_str || r.id), name: String(r.name || 'Strava route').slice(0, 80), distance: Number(r.distance) || 0, gain: Number(r.elevation_gain) || 0, starred: !!r.starred, private: !!r.private }));
}

/** The upload's activity on Strava, also when Strava calls it a duplicate of one already there. */
export function uploadOutcome(u) {
  if (u?.activity_id) return { activityId: u.activity_id };
  const err = u?.error || '';
  if (err) {
    const dup = /duplicate of .*?activities\/(\d+)/i.exec(err) || /duplicate of activity (\d+)/i.exec(err);
    if (dup) return { activityId: Number(dup[1]), duplicate: true };
    return { error: err.replace(/<[^>]+>/g, '').trim() };
  }
  return null; // still being processed
}

/**
 * Saved tokens that still work here: a refresh token from the Strava app in use (one linked before the move to
 * Gruppetto's own app, saved with no app, was the shared one's; another app's tokens do not refresh with this one).
 */
export const savedFor = (t, appId) => !!t?.refresh && (t.app || SHARED_APP_ID) === appId;

export const stravaActivityUrl = (id) => `https://www.strava.com/activities/${id}`;

const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
const save = (t) => { try { if (t) localStorage.setItem(KEY, JSON.stringify(t)); else localStorage.removeItem(KEY); } catch { /* private mode */ } };

async function tokenRequest(body) {
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.message || j.error || `token ${r.status}`);
  return j;
}

export class StravaClient {
  constructor(tokens) { this.t = tokens; }

  /** The account linked in this browser, or null. */
  static saved() { return savedFor(load(), STRAVA_CLIENT_ID) ? new StravaClient(load()) : null; }

  /** Trades the code from Strava's return for tokens, and keeps them. */
  static async connect(code) {
    const j = await tokenRequest({ grant_type: 'authorization_code', code });
    const a = j.athlete || {};
    const t = { access: j.access_token, refresh: j.refresh_token, expires: j.expires_at, name: [a.firstname, a.lastname].filter(Boolean).join(' '), athleteId: a.id, app: STRAVA_CLIENT_ID };
    save(t);
    return new StravaClient(t);
  }

  get name() { return this.t.name || ''; }

  forget() { save(null); }

  /** A live access token: refreshed through the token function a minute before it runs out. */
  async token() {
    if (this.t.expires > Date.now() / 1000 + 60) return this.t.access;
    const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: this.t.refresh });
    this.t = { ...this.t, access: j.access_token, refresh: j.refresh_token || this.t.refresh, expires: j.expires_at };
    save(this.t);
    return this.t.access;
  }

  /** A GET to Strava's API with a live token: the JSON, or the text for a file. */
  async get(path, { text = false } = {}) {
    const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${await this.token()}` } });
    if (r.status === 401) throw new Error('Strava: access revoked, connect again');
    if (!r.ok) throw Object.assign(new Error(`Strava ${r.status}`), { status: r.status });
    return text ? r.text() : r.json();
  }

  /** Your routes on Strava that are rides (the first 100). */
  async routes() {
    let id = this.t.athleteId;
    if (!id) { id = (await this.get('/athlete')).id; this.t = { ...this.t, athleteId: id }; save(this.t); }
    return rideRoutes(await this.get(`/athletes/${id}/routes?per_page=100`));
  }

  /** One route as a GPX file, with its heights. */
  routeGpx(id) { return this.get(`/routes/${encodeURIComponent(id)}/export_gpx`, { text: true }); }

  /**
   * Uploads a FIT and waits for Strava to make it an activity (a few seconds, up to a minute).
   * Returns { activityId, duplicate? }; throws with Strava's reason when it refuses the file.
   */
  async upload(fit, { name, description, externalId, filename = 'gruppetto.fit', gps = false }) {
    const form = new FormData();
    form.append('file', new Blob([fit], { type: 'application/vnd.ant.fit' }), filename);
    form.append('data_type', 'fit');
    // a ride with a GPS track goes up as a Virtual Ride with its map (the FIT's sub_sport says it was virtual);
    // without one it is a trainer ride
    if (!gps) form.append('trainer', '1');
    if (name) form.append('name', name);
    if (description) form.append('description', description);
    if (externalId) form.append('external_id', externalId);
    const auth = async () => ({ Authorization: `Bearer ${await this.token()}` });
    const r = await fetch(`${API}/uploads`, { method: 'POST', headers: await auth(), body: form });
    let u = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error('Strava: access revoked, connect again');
    if (!r.ok && !u.error) throw new Error(`Strava ${r.status}`);
    for (let i = 0; i < 30; i++) {
      const out = uploadOutcome(u);
      if (out?.error) throw new Error(out.error);
      if (out) return out;
      await new Promise((res) => setTimeout(res, 2000));
      const p = await fetch(`${API}/uploads/${u.id_str || u.id}`, { headers: await auth() });
      u = await p.json().catch(() => ({}));
    }
    throw new Error('Strava is still processing the ride; it will show up there soon');
  }
}
