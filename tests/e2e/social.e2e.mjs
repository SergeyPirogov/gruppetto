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
const PORT = Number(process.env.E2E_PORT) || 8765; // E2E_PORT when something else listens on 8765
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
  // without WebGL the app draws the road in 2D: headless Chromium renders the 3D world in software, a frame every
  // 1–3 s, and the rides here (about the tables, not the graphics) ran out of time. Since 3D became the only
  // choice, a «graphics: '2d'» setting no longer does this
  browser = await chromium.launch({ args: ['--disable-webgl', '--disable-webgl2'] });
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
      // like Postgres: an insert (an upsert too) needs the name, NOT NULL, even for a row already there
      if (req.method() === 'POST' && !row.display_name) return send(route, 400, { code: '23502', message: 'null value in column "display_name" of relation "profiles" violates not-null constraint' });
      if (req.method() === 'PATCH' && !db.profile) return send(route, 406, { code: 'PGRST116', message: 'no rows' });
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
    // group rides and leagues (#84)
    if (p === '/rest/v1/rpc/group_ride_list') return send(route, 200, db.rides || []);
    if (p === '/rest/v1/rpc/league_list') return send(route, 200, db.leagues || []);
    if (p === '/rest/v1/rpc/create_league') {
      const id = `00000000-0000-4000-8000-00000000000${(db.leagues || []).length + 1}`;
      (db.leagues ||= []).push({ id, title: JSON.parse(body).p_title, host_name: 'Olena', races: 0, next_at: null, mine: true });
      return send(route, 200, id);
    }
    if (p === '/rest/v1/rpc/create_group_ride') {
      const q = JSON.parse(body), l = (db.leagues || []).find((x) => x.id === q.p_league);
      const id = '11111111-0000-4000-8000-000000000001';
      (db.rides ||= []).push({ id, title: q.p_title, route_id: q.p_route, starts_at: q.p_starts, host_name: 'Olena', mine: true, riders: 1, joined: true, kind: q.p_kind, laps: q.p_laps, league_id: l?.id || null, league_title: l?.title || null });
      if (l) l.races += 1;
      return send(route, 200, id);
    }
    if (p === '/rest/v1/rpc/league_standings') return send(route, 200, [{ name: 'Taras', points: 45, races: 2, wins: 1, best: 1, me: false }, { name: 'Olena', points: 20, races: 1, wins: 0, best: 2, me: true }]);
    if (p === '/rest/v1/rpc/league_races') return send(route, 200, (db.rides || []).filter((r) => r.league_id === JSON.parse(body).p_id).map((r) => ({ ...r, finishers: 0 })));
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
    if (u.startsWith(`${APP}js/social-config.js`)) { // the mock project, or none (never the real one in the repo)
      const [url, key] = config ? [SB, 'anon-key'] : ['', ''];
      return route.fulfill({ contentType: 'text/javascript', body: `export const SUPABASE_URL = '${url}';\nexport const SUPABASE_ANON_KEY = '${key}';\n` });
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

const SETTINGS = { name: 'Olena', weight: 60, ftp: 240, icuKey: ICU_SECRET, icuAthlete: 'i42', bots: 0, stats: false, settingsUpdatedAt: 1000 };
const LOCAL = { 'gruppetto.welcomed': 'guest', 'powerup.settings': SETTINGS, 'gruppetto.strava': { access: STRAVA_SECRET, refresh: STRAVA_SECRET, expires: 9e9, name: 'R' } };
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
  assert.equal(await page.isHidden('#hdr-account'), true);
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
  await page.waitForFunction(() => document.getElementById('f-ftp').value === '255');
  assert.match(await page.textContent('#hdr-account'), /Olena R|Olena/); // the lobby shows who you are // the account's profile is newer
  assert.equal(new URL(page.url()).search, ''); // the code left the address
  assert.equal(await page.evaluate(() => document.getElementById('drawer').hidden || document.getElementById('social-card').hidden), true); // not sent to Profile (a first visit may open Devices)
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
  const up = mock.db.requests.filter((r) => r.path === '/rest/v1/profiles' && ['POST', 'PATCH'].includes(r.method)).at(-1);
  assert.ok(up, 'the merged profile went up');
  assert.equal(JSON.parse(up.body).data.records.lap.coast, 1200);
  assert.equal(JSON.parse(up.body).data.records.top['rolling-s1'], 50);
  assert.ok(!up.body.includes('segTrace'));
  // a change to the profile goes up 3 s later
  await page.evaluate(() => { const f = document.getElementById('f-weight'); f.value = '58'; f.oninput(); });
  await page.waitForTimeout(3600);
  const last = mock.db.requests.filter((r) => r.path === '/rest/v1/profiles' && ['POST', 'PATCH'].includes(r.method)).at(-1);
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
  assert.match(await page.textContent('#sum-social-text'), /Simulator ride/); // said why, rather than nothing
  assert.equal(await page.isHidden('#btn-social-cta'), true);
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

test('a league: set up from the Leagues tab, a race put in it, its standings', async () => {
  const mock = mockSupabase({ profile: PROFILE() });
  const { page, context, errors } = await openApp({ mock, local: LOCAL, signedIn: true });
  await page.waitForSelector('#hdr-account.in');
  await page.evaluate(() => document.getElementById('hdr-group').click());
  await page.waitForSelector('#gr-view:not([hidden])');
  await page.click('[data-gr-tab="lg"]');
  await page.waitForSelector('#gr-lg-empty:not([hidden])');
  await page.click('#gr-lg-new summary');
  await page.fill('#gr-lg-title', 'Winter Cup');
  await page.click('#gr-lg-create');
  await page.waitForSelector('#gr-lg-one:not([hidden]) #gr-lg-rows tr.me');
  assert.match(await page.textContent('#gr-lg-name'), /Winter Cup/);
  assert.match(await page.textContent('#gr-lg-rows tr:first-child'), /Taras\s*45/);
  // a race in the calendar, in the league
  await page.click('[data-gr-tab="cal"]');
  await page.click('#gr-new summary');
  await page.fill('#gr-title', 'Round 1');
  await page.selectOption('#gr-kind', 'race');
  await page.waitForSelector('#gr-league-wrap:not([hidden])');
  await page.selectOption('#gr-league', { label: '🏆 Winter Cup' });
  await page.click('#gr-create');
  await page.waitForSelector('.gr-race');
  assert.match(await page.textContent('.gr-race'), /Winter Cup/);
  const made = mock.db.requests.filter((r) => r.path === '/rest/v1/rpc/create_group_ride').at(-1);
  assert.equal(JSON.parse(made.body).p_league, mock.db.leagues[0].id);
  // a plain ride sends no league at all (a database without leagues takes it)
  await page.click('#gr-new summary');
  await page.fill('#gr-title', 'Spin');
  await page.selectOption('#gr-kind', 'ride');
  assert.equal(await page.isHidden('#gr-league-wrap'), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test('signing out from the header: a tap on your name, then Sign out', async () => {
  const mock = mockSupabase({ profile: PROFILE() });
  const { page, context, errors } = await openApp({ mock, local: LOCAL, signedIn: true });
  await page.waitForSelector('#hdr-account.in');
  const tap = () => page.evaluate(() => document.getElementById('hdr-account').click()); // the Devices page may be open over the lobby on a first visit
  await tap();
  await page.waitForSelector('#hdr-menu');
  await page.keyboard.press('Escape'); // closes without doing anything
  assert.equal(await page.$('#hdr-menu'), null);
  await tap();
  await page.click('#hdr-menu [data-m="out"]');
  await page.waitForFunction(() => !document.getElementById('hdr-account').classList.contains('in'));
  assert.equal(await page.$('#hdr-menu'), null);
  assert.equal(await page.isVisible('#hdr-guest'), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('gruppetto.social.auth')), null);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a ride cut off by a reload goes on from where it was: time, distance and the seconds ridden', async () => {
  const { page, context, errors } = await openApp({ config: false, local: LOCAL });
  await page.evaluate(() => document.getElementById('btn-start').click());
  await page.waitForFunction(() => window.__ride && !document.getElementById('ride').hidden);
  await page.waitForFunction(() => window.__ride.elapsed >= 32, null, { timeout: 60000 }); // the draft is kept every 30 s
  const before = await page.evaluate(() => ({ elapsed: window.__ride.elapsed, dist: window.__ride.dist }));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('btn-start')?.onclick);
  await page.waitForFunction(() => !document.getElementById('draft-box').hidden, null, { timeout: 10000 });
  await page.evaluate(() => document.getElementById('draft-continue').click());
  await page.waitForFunction(() => window.__ride && !document.getElementById('ride').hidden);
  const after = await page.evaluate(() => ({ elapsed: window.__ride.elapsed, dist: window.__ride.dist, route: window.__ride.route.id }));
  assert.ok(after.elapsed >= 30 && after.elapsed <= before.elapsed + 2, `elapsed ${after.elapsed}, was ${before.elapsed}`);
  assert.ok(after.dist > 0 && after.dist <= before.dist + 30, `dist ${after.dist}, was ${before.dist}`);
  assert.deepEqual(errors, []);
  await context.close();
});
