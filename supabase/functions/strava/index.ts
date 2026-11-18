// Strava's token exchange for Gruppetto (#32). Strava hands out tokens only to a caller holding the app's client
// secret, which a page cannot keep, so the code from Strava's return (and later the refresh token) comes here, goes
// on to Strava with the secret, and the tokens go back to the browser, where they live. Nothing is kept or logged.
//
// POST JSON:
//   { grant_type: 'authorization_code', code }          → { access_token, refresh_token, expires_at, athlete }
//   { grant_type: 'refresh_token', refresh_token }      → { access_token, refresh_token, expires_at }
// Errors: { error } with status 400 (bad input), 401 (Strava said the code or token is no good), 502, 503.
//
// Secrets: supabase secrets set STRAVA_CLIENT_ID=… STRAVA_CLIENT_SECRET=…
// Deploy:  supabase functions deploy strava --no-verify-jwt   (the page sends no Supabase session for this)

const TOKEN = 'https://www.strava.com/oauth/token';
const ORIGINS = [/^https?:\/\/automation-remarks\.com$/, /^https?:\/\/sergeypirogov\.github\.io$/, /^https:\/\/(www\.)?gruppetto\.cc$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin') || '';
  const cors: Record<string, string> = ORIGINS.some((re) => re.test(origin))
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info', Vary: 'Origin' }
    : {};
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: cors['Access-Control-Allow-Origin'] ? 204 : 403, headers: cors });
  if (!cors['Access-Control-Allow-Origin']) return json({ error: 'origin not allowed' }, 403);
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const id = Deno.env.get('STRAVA_CLIENT_ID'), secret = Deno.env.get('STRAVA_CLIENT_SECRET');
  if (!id || !secret) return json({ error: 'Strava is not set up on the server' }, 503);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: 'JSON body' }, 400); }
  const form = new URLSearchParams({ client_id: id, client_secret: secret });
  if (b.grant_type === 'authorization_code' && typeof b.code === 'string' && /^[\w-]{10,100}$/.test(b.code)) {
    form.set('grant_type', 'authorization_code'); form.set('code', b.code);
  } else if (b.grant_type === 'refresh_token' && typeof b.refresh_token === 'string' && /^[\w-]{10,200}$/.test(b.refresh_token)) {
    form.set('grant_type', 'refresh_token'); form.set('refresh_token', b.refresh_token);
  } else return json({ error: 'grant_type with its code or refresh_token' }, 400);
  let r: Response;
  try { r = await fetch(TOKEN, { method: 'POST', body: form }); } catch { return json({ error: 'Strava: no connection' }, 502); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) return json({ error: j.message || `Strava ${r.status}` }, r.status === 400 || r.status === 401 ? 401 : 502);
  // only what the page uses: the tokens, and who connected (for «Connected as …»)
  const a = j.athlete;
  return json({
    access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at,
    ...(a ? { athlete: { id: a.id, firstname: a.firstname, lastname: a.lastname } } : {}),
  });
});
