// Garmin Connect for Gruppetto: sign in once, then finished rides go up as FIT files. Garmin has no public upload
// API for apps like this one, so this does what the Garmin Connect mobile app does (the same flow as the garth
// library): the SSO sign-in page, a ticket, an OAuth1 token for about a year, OAuth2 tokens for a day each, and
// the upload service. A page cannot do it itself (CORS, and the OAuth1 signature), hence this small function.
//
// It keeps nothing: the password goes to Garmin and is forgotten, the tokens go back to the browser and live
// there (like Strava's). Nothing is logged.
//
// POST JSON:
//   { action: 'login', email, password }        → { oauth1, oauth2, name } | { mfa: true, state }
//   { action: 'mfa', state, code }              → { oauth1, oauth2, name }
//   { action: 'upload', oauth1, oauth2?, fit (base64), filename }
//                                               → { activityId?, duplicate?, oauth2 }
// Errors: { error } with status 400 (bad input), 401 (wrong password or token gone), 502 (Garmin said no).
//
// Deploy: supabase functions deploy garmin --no-verify-jwt   (the page sends no Supabase session for this)

const SSO = 'https://sso.garmin.com/sso';
const SSO_EMBED = `${SSO}/embed`;
const API = 'https://connectapi.garmin.com';
const CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json';
const SSO_UA = 'GCM-iOS-5.7.2.1';
const API_UA = 'com.garmin.android.apps.connectmobile';
const ORIGINS = [/^https?:\/\/automation-remarks\.com$/, /^https?:\/\/sergeypirogov\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

const EMBED_PARAMS = { id: 'gauth-widget', embedWidget: 'true', gauthHost: SSO };
const SIGNIN_PARAMS = {
  ...EMBED_PARAMS, gauthHost: SSO_EMBED, service: SSO_EMBED, source: SSO_EMBED,
  redirectAfterAccountLoginUrl: SSO_EMBED, redirectAfterAccountCreationUrl: SSO_EMBED,
};

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---------- A cookie jar for the SSO pages ----------

type Jar = Record<string, string>;
const cookieHeader = (jar: Jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
function keepCookies(jar: Jar, res: Response) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
async function ssoFetch(jar: Jar, url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: { 'User-Agent': SSO_UA, Cookie: cookieHeader(jar), ...(init.headers || {}) },
  });
  keepCookies(jar, res);
  return res;
}
const qs = (p: Record<string, string>) => new URLSearchParams(p).toString();
const csrfOf = (html: string) => /name="_csrf"\s+value="(.+?)"/.exec(html)?.[1];
const titleOf = (html: string) => /<title>(.+?)<\/title>/.exec(html)?.[1] || '';
const ticketOf = (html: string) => /embed\?ticket=([^"]+)"/.exec(html)?.[1];

// ---------- OAuth1 (HMAC-SHA1), as the mobile app signs ----------

let consumer: { consumer_key: string; consumer_secret: string } | null = null;
async function getConsumer() {
  if (!consumer) {
    const r = await fetch(CONSUMER_URL);
    if (!r.ok) throw new HttpError(502, 'Garmin: could not get the app key');
    consumer = await r.json();
  }
  return consumer!;
}
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
async function hmacSha1(key: string, text: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...sig));
}
async function oauth1Header(method: string, url: string, token?: { token: string; secret: string }, body?: Record<string, string>) {
  const c = await getConsumer();
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: c.consumer_key,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...(token ? { oauth_token: token.token } : {}),
  };
  const all: [string, string][] = [...Object.entries(oauth), ...u.searchParams.entries(), ...Object.entries(body || {})];
  const params = all.map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(params.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  oauth.oauth_signature = await hmacSha1(`${enc(c.consumer_secret)}&${enc(token?.secret || '')}`, base);
  return 'OAuth ' + Object.entries(oauth).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(', ');
}

type OAuth1 = { token: string; secret: string; mfa_token?: string };
type OAuth2 = { access_token: string; refresh_token?: string; expires_at: number };

async function oauth1FromTicket(ticket: string): Promise<OAuth1> {
  const url = `${API}/oauth-service/oauth/preauthorized?${qs({ ticket, 'login-url': SSO_EMBED, 'accepts-mfa-tokens': 'true' })}`;
  const r = await fetch(url, { headers: { 'User-Agent': API_UA, Authorization: await oauth1Header('GET', url) } });
  if (!r.ok) throw new HttpError(502, `Garmin: token ${r.status}`);
  const p = new URLSearchParams(await r.text());
  const t = { token: p.get('oauth_token') || '', secret: p.get('oauth_token_secret') || '', mfa_token: p.get('mfa_token') || undefined };
  if (!t.token || !t.secret) throw new HttpError(502, 'Garmin: no token');
  return t;
}

async function oauth2From(o1: OAuth1): Promise<OAuth2> {
  const url = `${API}/oauth-service/oauth/exchange/user/2.0`;
  const body: Record<string, string> = o1.mfa_token ? { mfa_token: o1.mfa_token } : {};
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': API_UA, 'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: await oauth1Header('POST', url, { token: o1.token, secret: o1.secret }, body),
    },
    body: qs(body),
  });
  if (r.status === 401) throw new HttpError(401, 'Garmin: signed out, connect again');
  if (!r.ok) throw new HttpError(502, `Garmin: exchange ${r.status}`);
  const j = await r.json();
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600) };
}

async function displayName(o2: OAuth2) {
  const r = await fetch(`${API}/userprofile-service/socialProfile`, { headers: { 'User-Agent': API_UA, Authorization: `Bearer ${o2.access_token}` } }).catch(() => null);
  if (!r?.ok) return '';
  const j = await r.json().catch(() => ({}));
  return j.fullName || j.displayName || '';
}

// ---------- Sign in ----------

async function finish(html: string) {
  if (titleOf(html) !== 'Success') throw new HttpError(401, 'Garmin: sign-in did not succeed');
  const ticket = ticketOf(html);
  if (!ticket) throw new HttpError(502, 'Garmin: no ticket');
  const oauth1 = await oauth1FromTicket(ticket);
  const oauth2 = await oauth2From(oauth1);
  return { oauth1, oauth2, name: await displayName(oauth2) };
}

async function login(email: string, password: string) {
  const jar: Jar = {};
  await ssoFetch(jar, `${SSO_EMBED}?${qs(EMBED_PARAMS)}`);
  const page = await ssoFetch(jar, `${SSO}/signin?${qs(SIGNIN_PARAMS)}`, { headers: { Referer: `${SSO_EMBED}?${qs(EMBED_PARAMS)}` } });
  const csrf = csrfOf(await page.text());
  if (!csrf) throw new HttpError(502, 'Garmin: the sign-in page changed or is blocked');
  const res = await ssoFetch(jar, `${SSO}/signin?${qs(SIGNIN_PARAMS)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${SSO}/signin?${qs(SIGNIN_PARAMS)}` },
    body: qs({ username: email, password, embed: 'true', _csrf: csrf }),
  });
  const html = await res.text();
  const title = titleOf(html);
  if (/MFA/i.test(title)) {
    const c = csrfOf(html);
    if (!c) throw new HttpError(502, 'Garmin: no code form');
    return { mfa: true, state: btoa(JSON.stringify({ jar, csrf: c })) };
  }
  if (/locked/i.test(title)) throw new HttpError(401, 'Garmin: the account is locked, sign in on garmin.com first');
  if (title !== 'Success') throw new HttpError(401, 'Garmin: wrong email or password');
  return finish(html);
}

async function mfa(state: string, code: string) {
  let s: { jar: Jar; csrf: string };
  try { s = JSON.parse(atob(state)); } catch { throw new HttpError(400, 'Garmin: start again'); }
  const res = await ssoFetch(s.jar, `${SSO}/verifyMFA/loginEnterMfaCode?${qs(SIGNIN_PARAMS)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${SSO}/signin?${qs(SIGNIN_PARAMS)}` },
    body: qs({ 'mfa-verification-code': code, embed: 'true', _csrf: s.csrf, fromPage: 'setupEnterMfaCode' }),
  });
  const html = await res.text();
  if (titleOf(html) !== 'Success') throw new HttpError(401, 'Garmin: the code did not work');
  return finish(html);
}

// ---------- Upload ----------

async function upload(o1: OAuth1, o2: OAuth2 | undefined, fitB64: string, filename: string) {
  if (!o2 || o2.expires_at < Date.now() / 1000 + 60) o2 = await oauth2From(o1);
  const bytes = Uint8Array.from(atob(fitB64), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), filename.replace(/[^\w.\- ]/g, '_') || 'gruppetto.fit');
  const r = await fetch(`${API}/upload-service/upload`, {
    method: 'POST',
    headers: { 'User-Agent': API_UA, Authorization: `Bearer ${o2.access_token}`, NK: 'NT' },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  const res = j?.detailedImportResult || {};
  const ok = res.successes?.[0];
  const fail = res.failures?.[0];
  if (r.status === 401) throw new HttpError(401, 'Garmin: signed out, connect again');
  if (ok?.internalId) return { activityId: ok.internalId, oauth2: o2 };
  if (r.status === 409 || fail?.messages?.some((m: { code?: number }) => m.code === 202)) {
    return { activityId: fail?.internalId || null, duplicate: true, oauth2: o2 };
  }
  if (r.ok || r.status === 202) return { activityId: null, oauth2: o2 }; // accepted, still processing
  throw new HttpError(502, `Garmin: ${fail?.messages?.[0]?.content || `upload ${r.status}`}`);
}

// ---------- The function ----------

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin') || '';
  const cors: Record<string, string> = ORIGINS.some((re) => re.test(origin))
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info', Vary: 'Origin' }
    : {};
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: cors['Access-Control-Allow-Origin'] ? 204 : 403, headers: cors });
  if (!cors['Access-Control-Allow-Origin']) return json({ error: 'origin not allowed' }, 403);
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const b = await req.json();
    if (b.action === 'login') {
      if (!b.email || !b.password) throw new HttpError(400, 'email and password');
      return json(await login(String(b.email), String(b.password)));
    }
    if (b.action === 'mfa') {
      if (!b.state || !b.code) throw new HttpError(400, 'state and code');
      return json(await mfa(String(b.state), String(b.code).trim()));
    }
    if (b.action === 'upload') {
      if (!b.oauth1?.token || !b.oauth1?.secret || !b.fit) throw new HttpError(400, 'oauth1 and fit');
      return json(await upload(b.oauth1, b.oauth2, String(b.fit), String(b.filename || 'gruppetto.fit')));
    }
    throw new HttpError(400, 'unknown action');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 502;
    return json({ error: e instanceof Error ? e.message : 'Garmin: failed' }, status);
  }
});
