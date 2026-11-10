// Accounts and leaderboards in a real browser, against a mock Supabase (docs/specs/social-phase1.md, «Тести»):
// no project, no social; signing in merges this device's profile; the simulator sends nothing; a real ride
// sends its results and shows the place; offline they wait in the queue. And never an intervals.icu key or a
// Strava token in a request to Supabase. Run: npm run test:e2e (Chromium from Playwright's cache).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { chromium } from 'playwright';
import { checkEffort, boardFrom, categoryOf } from '../../js/social-core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8765;
const APP = `http://localhost:${PORT}/`;
const SB = 'https://mock-project.supabase.co';
const ICU_SECRET = 'ICU-SECRET-KEY-123';
const STRAVA_SECRET = 'STRAVA-SECRET-TOKEN-456';
const USER = { id: '11111111-1111-1111-1111-111111111111', aud: 'authenticated', role: 'authenticated', email: 'rider@example.com', user_metadata: { full_name: 'Test Rider' }, app_metadata: { provider: 'google' } };
const session = () => ({ access_token: 'access-1', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-1', user: USER });

let server, browser;
before(async () => {
  server = spawn('python3', [join(root, 'tools/serve.py'), String(PORT)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(APP); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.kill(); });

/** A mock Supabase: the state, and every request it saw. */
function mockSupabase({ profile = null, offline = false } = {}) {
  const db = { profile, efforts: [], requests: [], offline };
  const send = (route, status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', ...headers }, body: body === undefined ? '' : JSON.stringify(body) });
  const handler = async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() === 'OPTIONS') return send(route, 204);
    const body = req.postData() || '';
    db.requests.push({ method: req.method(), path: url.pathname, search: url.search, body, headers: req.headers() });
    const p = url.pathname;
    if (p === '/auth/v1/token') return send(route, 200, session());
    if (p === '/auth/v1/user') return send(route, 200, USER);
    if (p === '/auth/v1/logout') return send(route, 204);
    if (p === '/rest/v1/profiles') {
      const one = (req.headers().accept || '').includes('vnd.pgrst.object');
      if (req.method() === 'GET') return send(route, 200, one ? db.profile : (db.profile ? [db.profile] : []));
      const row = JSON.parse(body);
      db.profile = { public: true, data: {}, ...db.profile, ...row, updated_at: new Date().toISOString() };
      return send(route, 201, one ? db.profile : [db.profile]);
    }
    if (p === '/rest/v1/rpc/submit_efforts') {
      if (db.offline) return route.abort('internetdisconnected');
      const { items } = JSON.parse(body);
      const out = items.map((it) => {
        const c = checkEffort(it);
        if (!c.ok) return { status: 'rejected', reason: c.reason };
        db.efforts.push({ ...it, user_id: USER.id, category: categoryOf(it.ftp, it.weight_kg), flags: c.flags, display_name: db.profile?.display_name });
        // a few riders already there, faster and slower
        const rows = [...db.efforts.filter((e) => e.segment_id === it.segment_id), ...['a', 'b'].map((u, k) => ({ user_id: u, time_s: it.time_s + (k ? 30 : -5), ridden_at: it.ridden_at }))];
        const all = boardFrom(rows, { me: USER.id });
        return { status: 'saved', place: all.mine.place, total: all.total, week_place: all.mine.place, week_total: all.total };
      });
      return send(route, 200, out);
    }
    if (p === '/rest/v1/rpc/leaderboard') {
      const q = JSON.parse(body);
      const b = boardFrom(db.efforts.filter((e) => e.segment_id === q.segment), { me: USER.id, period: q.period, gender: q.gender, category: q.category });
      return send(route, 200, b.rows.map((r) => ({ ...r, total: b.total, wkg: r.avg_power / r.weight_kg })));
    }
    if (p === '/rest/v1/rpc/delete_me') { db.profile = null; db.efforts = []; return send(route, 204); }
    return send(route, 404, { message: `mock: no ${p}` });
  };
  return { db, handler };
}

/** A page with this device's data in localStorage (and, configured, the mock project). */
async function openApp({ config = true, signedIn = false, verifier = false, local = {}, mock, query = '?debug' }) {
  const context = await browser.newContext({ serviceWorkers: 'block' }); // its fetches would pass by page.route (the mock config)
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const outside = [];
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(SB)) return mock ? mock.handler(route) : route.abort();
    if (!u.startsWith(APP)) { outside.push(u); return route.abort(); } // nothing else leaves the test
    if (config && u.startsWith(`${APP}js/social-config.js`)) {
      return route.fulfill({ contentType: 'text/javascript', body: `export const SUPABASE_URL = '${SB}';\nexport const SUPABASE_ANON_KEY = 'anon-key';\n` });
    }
    return route.continue();
  });
  await page.addInitScript(({ local, signedIn, verifier, sess }) => {
    if (sessionStorage.getItem('seeded')) return; // only before the first load, not after a reload
    sessionStorage.setItem('seeded', '1');
    localStorage.clear();
    for (const [k, v] of Object.entries(local)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    if (signedIn) localStorage.setItem('gruppetto.social.auth', JSON.stringify(sess));
    if (verifier) localStorage.setItem('gruppetto.social.auth-code-verifier', JSON.stringify('verifier-123'));
  }, { local, signedIn, verifier, sess: session() });
  await page.goto(APP + query);
  await page.waitForFunction(() => document.getElementById('btn-start')?.onclick);
  return { page, context, errors, outside };
}

const SETTINGS = { name: 'Olena', weight: 60, ftp: 240, icuKey: ICU_SECRET, icuAthlete: 'i42', graphics: '2d', bots: 0, stats: false, settingsUpdatedAt: 1000 };
const LOCAL = { 'powerup.settings': SETTINGS, 'gruppetto.strava': { access: STRAVA_SECRET, refresh: STRAVA_SECRET, expires: 9e9, name: 'R' } };
const PROFILE = (data = {}) => ({ display_name: 'Olena', country: 'UA', gender: 'f', public: true, data: { profile: { name: 'Olena' }, settingsUpdatedAt: 1, records: { lap: {}, seg: {}, top: {} }, ...data } });

/** No secret went to Supabase, in an address, a header or a body. */
function noSecrets(db) {
  for (const r of db.requests) {
    const all = `${r.path}${r.search} ${JSON.stringify(r.headers)} ${r.body}`;
    assert.ok(!all.includes(ICU_SECRET) && !all.includes('i42') && !all.includes(STRAVA_SECRET), `a secret in ${r.method} ${r.path}`);
  }
}

/** Rides through the first sprint of the route (11 s for 250 m) and finishes. */
async function rideSprint(page, { real }) {
  await page.evaluate((real) => { window.__pretendTrainer = real; }, real);
  await page.evaluate(() => document.getElementById('btn-start').click()); // the Devices page may be open over the lobby on a first visit
  await page.waitForFunction(() => window.__ride && !document.getElementById('ride').hidden);
  const sprint = await page.evaluate(() => {
    const s = window.__ride.route.sprints[0];
    const p = document.getElementById('sim-power'); p.value = 300; p.oninput?.();
    window.__ride.dist = window.__ride.prevDist = s.start - 0.5; // to the line, without crossing the climbs before it
    return s;
  });
  await page.waitForFunction((id) => window.__ride.seg?.climb.id === id, sprint.id, { timeout: 10000 });
  // 11 s of the ride's own time (it runs on its own clock): 250 m in 11 s is believable
  await page.waitForFunction(() => window.__ride.elapsed - window.__ride.seg.t0 >= 11, null, { timeout: 30000 });
  await page.evaluate((end) => { window.__ride.dist = end + 1; }, sprint.start + sprint.length);
  await page.waitForFunction(() => window.__ride.efforts.length > 0, null, { timeout: 10000 });
  await page.evaluate(() => { const f = document.getElementById('btn-finish'); f.click(); f.click(); }); // Finish asks to be tapped twice
  await page.waitForSelector('#summary:not([hidden])');
  return sprint;
}

test('without a project nothing social shows, and nothing goes to Supabase', async () => {
  const mock = mockSupabase();
  const { page, context, errors } = await openApp({ config: false, mock, local: LOCAL });
  assert.equal(await page.isHidden('#social-card'), true);
  assert.equal(await page.isHidden('#route-board'), true);
  await page.waitForTimeout(500);
  assert.equal(mock.db.requests.length, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('signing in: back from Google, this device\'s profile and the account\'s merge; no secrets sent', async () => {
  const mock = mockSupabase({
    profile: PROFILE({ profile: { name: 'Olena R', weight: 59, ftp: 255, jersey: '#123456' }, settingsUpdatedAt: 5000, records: { lap: { rolling: 880, alps: 3000 }, seg: { 'rolling-c1': 200 }, top: {} } }),
  });
  const local = { ...LOCAL, 'gruppetto.records': { lap: { rolling: 900, coast: 1200 }, seg: { 'rolling-c1': 190 }, segTrace: { 'rolling-c1': [0, 10] }, top: { 'rolling-s1': 50 } } };
  const { page, context, errors } = await openApp({ mock, local, verifier: true, query: '?code=google-code' });
  await page.waitForFunction(() => !document.getElementById('social-in').hidden);
  await page.waitForFunction(() => document.getElementById('f-ftp').value === '255'); // the account's profile is newer
  assert.equal(new URL(page.url()).search, ''); // the code left the address
  const exchange = mock.db.requests.find((r) => r.path === '/auth/v1/token');
  assert.match(exchange.search, /grant_type=pkce/);
  assert.match(exchange.body, /verifier-123/);
  const records = await page.evaluate(() => JSON.parse(localStorage.getItem('gruppetto.records')));
  assert.deepEqual(records.lap, { rolling: 880, coast: 1200, alps: 3000 }); // the best of both: nothing lost
  assert.equal(records.seg['rolling-c1'], 190);
  assert.deepEqual(records.segTrace['rolling-c1'], [0, 10]); // this device's record: its ghost stays
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('powerup.settings')));
  assert.equal(settings.name, 'Olena R');
  assert.equal(settings.icuKey, ICU_SECRET); // the key stays here
  // the merge went back up: this device's coast lap and sprint speed are in the account now
  await page.waitForFunction(() => true);
  const up = mock.db.requests.filter((r) => r.path === '/rest/v1/profiles' && r.method === 'POST').at(-1);
  assert.ok(up, 'the merged profile went up');
  assert.equal(JSON.parse(up.body).data.records.lap.coast, 1200);
  assert.equal(JSON.parse(up.body).data.records.top['rolling-s1'], 50);
  assert.ok(!up.body.includes('segTrace'));
  // a change to the profile goes up 3 s later
  await page.evaluate(() => { const f = document.getElementById('f-weight'); f.value = '58'; f.oninput(); });
  await page.waitForTimeout(3600);
  const last = mock.db.requests.filter((r) => r.path === '/rest/v1/profiles' && r.method === 'POST').at(-1);
  assert.equal(JSON.parse(last.body).data.profile.weight, 58);
  noSecrets(mock.db);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a new account: the window asks for the name, and this device\'s data becomes the account\'s', async () => {
  const mock = mockSupabase({ profile: null });
  const { page, context } = await openApp({ mock, local: { ...LOCAL, 'gruppetto.records': { lap: { rolling: 900 }, seg: {}, top: {} } }, signedIn: true });
  await page.waitForSelector('#social-setup:not([hidden])');
  assert.equal(await page.inputValue('#ss-name'), 'Olena');
  await page.selectOption('#ss-country', 'UA');
  await page.selectOption('#ss-gender', 'f');
  await page.click('#ss-save');
  await page.waitForSelector('#social-setup', { state: 'hidden' });
  assert.equal(mock.db.profile.display_name, 'Olena');
  assert.equal(mock.db.profile.country, 'UA');
  assert.equal(mock.db.profile.data.records.lap.rolling, 900);
  assert.equal(mock.db.profile.data.profile.ftp, 240);
  noSecrets(mock.db);
  await context.close();
});

test('a ride in the simulator sends nothing to the tables', async () => {
  const mock = mockSupabase({ profile: PROFILE() });
  const { page, context, errors } = await openApp({ mock, local: LOCAL, signedIn: true });
  await page.waitForFunction(() => !document.getElementById('social-in').hidden);
  await rideSprint(page, { real: false });
  await page.waitForTimeout(800);
  assert.equal(mock.db.requests.filter((r) => r.path.endsWith('/submit_efforts')).length, 0);
  assert.equal(await page.isHidden('#sum-social'), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a ride with power: its sprint goes to the table and the finish screen shows the place', async () => {
  const mock = mockSupabase({ profile: PROFILE() });
  const { page, context, errors } = await openApp({ mock, local: LOCAL, signedIn: true });
  await page.waitForFunction(() => !document.getElementById('social-in').hidden);
  const sprint = await rideSprint(page, { real: true });
  await page.waitForSelector('#sum-seg-rows .lb-place');
  assert.match(await page.textContent('#sum-seg-rows .lb-place'), /#2 of 3 · week #2/);
  const sent = mock.db.requests.filter((r) => r.path.endsWith('/submit_efforts'));
  assert.equal(sent.length, 1);
  const [item] = JSON.parse(sent[0].body).items;
  assert.equal(item.segment_id, sprint.id);
  assert.equal(item.kind, 'sprint');
  assert.equal(item.avg_power, 300);
  assert.equal(item.weight_kg, 60);
  assert.ok(item.time_s >= 11 && item.time_s < 40, `time ${item.time_s}`);
  assert.match(item.route_version, /^[0-9a-f]{8}$/);
  // the table opens from the place, with me in it
  await page.click('#sum-seg-rows .lb-place');
  await page.waitForSelector('#lb-rows tr.me');
  assert.match(await page.textContent('#lb-rows tr.me'), /Olena/);
  noSecrets(mock.db);
  assert.deepEqual(errors, []);
  await context.close();
});

test('offline: the results wait in the queue and go at the next opening', async () => {
  const mock = mockSupabase({ profile: PROFILE(), offline: true });
  const { page, context } = await openApp({ mock, local: LOCAL, signedIn: true });
  await page.waitForFunction(() => !document.getElementById('social-in').hidden);
  await rideSprint(page, { real: true });
  await page.waitForSelector('#sum-social:not([hidden])');
  assert.match(await page.textContent('#sum-social-text'), /next time/);
  const queue = await page.evaluate(() => JSON.parse(localStorage.getItem('gruppetto.social.queue') || '[]'));
  assert.equal(queue.length, 1);
  mock.db.offline = false;
  await page.reload();
  await page.waitForFunction(() => !localStorage.getItem('gruppetto.social.queue'), null, { timeout: 10000 });
  assert.equal(mock.db.efforts.length, 1);
  assert.equal(mock.db.efforts[0].segment_id, queue[0].segment_id);
  await context.close();
});

test('Strava\'s return still goes to Strava, not to the sign-in', async () => {
  const mock = mockSupabase({ profile: PROFILE() });
  const { page, context, outside } = await openApp({ mock, local: { 'powerup.settings': SETTINGS, 'gruppetto.strava-on': '1' }, verifier: true, query: '?state=gruppetto-strava&code=strava-code&scope=read,activity:write' });
  await page.waitForFunction(() => !document.getElementById('social-out').hidden || !document.getElementById('social-in').hidden);
  await page.waitForTimeout(800);
  assert.equal(mock.db.requests.filter((r) => r.path === '/auth/v1/token').length, 0); // Supabase never saw Strava's code
  assert.ok(outside.some((u) => u.includes('strava-token')), 'the code went to the Strava token function');
  await context.close();
});

test('deleting the account: everything goes from the server, nothing from this device', async () => {
  const mock = mockSupabase({ profile: PROFILE() });
  const local = { ...LOCAL, 'gruppetto.records': { lap: { rolling: 900 }, seg: {}, top: {} } };
  const { page, context, errors } = await openApp({ mock, local, signedIn: true });
  await page.waitForFunction(() => !document.getElementById('social-in').hidden);
  await page.evaluate(() => { const b = document.getElementById('btn-social-delete'); b.click(); });
  assert.equal(mock.db.requests.filter((r) => r.path.endsWith('/delete_me')).length, 0); // the first tap only asks
  await page.evaluate(() => document.getElementById('btn-social-delete').click());
  await page.waitForFunction(() => !document.getElementById('social-out').hidden);
  assert.equal(mock.db.requests.filter((r) => r.path.endsWith('/delete_me')).length, 1);
  assert.equal(mock.db.profile, null);
  const left = await page.evaluate(() => ({ records: JSON.parse(localStorage.getItem('gruppetto.records')), auth: localStorage.getItem('gruppetto.social.auth') }));
  assert.equal(left.records.lap.rolling, 900);
  assert.equal(left.auth, null);
  assert.deepEqual(errors, []);
  await context.close();
});
