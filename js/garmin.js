// Garmin Connect: sign in once with your Garmin email and password (and the code, when Garmin asks for one), then
// a finished ride goes up as a FIT, like Strava's. Garmin offers apps like this no upload API, so a small function
// next to the accounts (supabase/functions/garmin) does what Garmin's own mobile app does. It keeps nothing: the
// password goes on to Garmin and is forgotten, the tokens come back and live only in this browser.
import { SUPABASE_URL } from './social-config.js';

const FN = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/garmin` : '';
const KEY = 'gruppetto.garmin';

export const garminOn = () => !!FN;

/** Whether the Garmin function is deployed and answers this page (a preflight-style OPTIONS call). */
export async function garminAvailable() {
  if (!FN) return false;
  try { const r = await fetch(FN, { method: 'OPTIONS' }); return r.ok; } catch { return false; }
}
export const garminActivityUrl = (id) => `https://connect.garmin.com/modern/activity/${id}`;

const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
const save = (t) => { try { if (t) localStorage.setItem(KEY, JSON.stringify(t)); else localStorage.removeItem(KEY); } catch { /* private mode */ } };

async function call(body) {
  let r;
  try {
    r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new Error('Garmin: no connection'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw Object.assign(new Error(j.error || `Garmin ${r.status}`), { status: r.status });
  return j;
}

/** FIT bytes as base64, in pieces (a long ride is too big for one String.fromCharCode call). */
export function toBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export class GarminClient {
  constructor(t) { this.t = t; }

  /** The account linked in this browser, or null. */
  static saved() { const t = load(); return t?.oauth1?.token ? new GarminClient(t) : null; }

  /**
   * Signs in: a client, or { mfa: state } when Garmin wants the code it just sent (then `verify`).
   * Throws with Garmin's reason (wrong password, locked account, the page blocked).
   */
  static async connect(email, password) {
    const j = await call({ action: 'login', email, password });
    if (j.mfa) return { mfa: j.state };
    return GarminClient.#keep(j);
  }

  static async verify(state, code) { return GarminClient.#keep(await call({ action: 'mfa', state, code })); }

  static #keep(j) {
    const t = { oauth1: j.oauth1, oauth2: j.oauth2, name: j.name || '' };
    save(t);
    return new GarminClient(t);
  }

  get name() { return this.t.name || ''; }

  forget() { save(null); }

  /** Uploads a FIT. { activityId, duplicate? } (activityId null while Garmin is still processing it). */
  async upload(fit, { filename = 'gruppetto.fit' } = {}) {
    try {
      const j = await call({ action: 'upload', oauth1: this.t.oauth1, oauth2: this.t.oauth2, fit: toBase64(fit), filename });
      if (j.oauth2) { this.t = { ...this.t, oauth2: j.oauth2 }; save(this.t); }
      return { activityId: j.activityId ?? null, duplicate: !!j.duplicate };
    } catch (e) {
      if (e.status === 401) throw new Error('Garmin: signed out, connect again');
      throw e;
    }
  }
}
