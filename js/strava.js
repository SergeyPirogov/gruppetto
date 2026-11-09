// Strava (#32): connect once, then a finished ride goes up as a virtual ride (the FIT says cycling /
// virtual_activity, which Strava files as a Virtual Ride). Strava will not hand out tokens to a page holding
// no secret, so the code and the refresh go through a small token function on Vercel that keeps it
// (Slipstream's, the same Strava app). Tokens live only in this browser.

export const STRAVA_CLIENT_ID = '167103';
const TOKEN_URL = 'https://slipstream-bice.vercel.app/api/strava-token';
const API = 'https://www.strava.com/api/v3';
const KEY = 'gruppetto.strava';
export const STRAVA_STATE = 'gruppetto-strava';

/** Where Strava sends you back: this page, without its query. */
export const stravaRedirect = (loc = location) => `${loc.origin}${loc.pathname}`;

/** Strava's page asking you to let Gruppetto upload rides. */
export function stravaAuthorizeUrl(redirect) {
  const q = new URLSearchParams({
    client_id: STRAVA_CLIENT_ID, redirect_uri: redirect, response_type: 'code',
    approval_prompt: 'auto', scope: 'read,activity:write', state: STRAVA_STATE,
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
  static saved() { const t = load(); return t?.refresh ? new StravaClient(t) : null; }

  /** Trades the code from Strava's return for tokens, and keeps them. */
  static async connect(code) {
    const j = await tokenRequest({ grant_type: 'authorization_code', code });
    const a = j.athlete || {};
    const t = { access: j.access_token, refresh: j.refresh_token, expires: j.expires_at, name: [a.firstname, a.lastname].filter(Boolean).join(' '), athleteId: a.id };
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

  /**
   * Uploads a FIT and waits for Strava to make it an activity (a few seconds, up to a minute).
   * Returns { activityId, duplicate? }; throws with Strava's reason when it refuses the file.
   */
  async upload(fit, { name, description, externalId, filename = 'gruppetto.fit' }) {
    const form = new FormData();
    form.append('file', new Blob([fit], { type: 'application/vnd.ant.fit' }), filename);
    form.append('data_type', 'fit');
    form.append('trainer', '1');
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
