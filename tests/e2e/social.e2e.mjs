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
import { checkEffort, boardFrom, categoryOf, packRecord } from '../../js/social-core.js';

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
function mockSupabase({ profile = null, offline = false, regions = [] } = {}) {
  const db = { profile, efforts: [], requests: [], offline, regions };
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
      if (db.failProfile) return send(route, 500, { message: 'the account is down' });
      // like Postgres: an insert (an upsert too) needs the name, NOT NULL, even for a row already there
      if (req.method() === 'POST' && !row.display_name) return send(route, 400, { code: '23502', message: 'null value in column "display_name" of relation "profiles" violates not-null constraint' });
      if (req.method() === 'PATCH' && !db.profile) return send(route, 406, { code: 'PGRST116', message: 'no rows' });
      db.profile = { public: true, data: {}, ...db.profile, ...row, updated_at: new Date().toISOString() };
      return send(route, 201, one ? db.profile : [db.profile]);
    }
    if (p === '/rest/v1/activity_records') { // the rides' full records (0009)
      db.records ||= {};
      if (req.method() === 'GET') {
        const one = (req.headers().accept || '').includes('vnd.pgrst.object');
        const id = new URLSearchParams(url.search).get('id')?.replace(/^eq\./, '');
        if (id) return send(route, 200, one ? (db.records[id] ? { data: db.records[id] } : null) : (db.records[id] ? [{ data: db.records[id] }] : []));
        return send(route, 200, Object.keys(db.records).map((k) => ({ id: k })));
      }
      if (req.method() === 'DELETE') { for (const k of Object.keys(db.records)) if ((url.search || '').includes(k)) delete db.records[k]; return send(route, 204); }
      const rows = [].concat(JSON.parse(body)); for (const r of rows) db.records[r.id] = r.data;
      return send(route, 201, []);
    }
    if (p === '/rest/v1/activities') { // the full sync's rides: read them all, upsert by id
      db.activities ||= [];
      if (req.method() === 'GET') return send(route, 200, db.activities);
      for (const r of JSON.parse(body)) { const i = db.activities.findIndex((x) => x.id === r.id); if (i >= 0) db.activities[i] = r; else db.activities.push(r); }
      return send(route, 201, []);
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
    if (p === '/rest/v1/rpc/region_board') return send(route, 200, db.regions || []);
    if (p === '/rest/v1/rpc/leaderboard') {
      const q = JSON.parse(body);
      const b = boardFrom(db.efforts.filter((e) => e.segment_id === q.segment), { me: USER.id, period: q.period, gender: q.gender, category: q.category });
      return send(route, 200, b.rows.map((r) => ({ ...r, total: b.total, wkg: r.avg_power / r.weight_kg })));
    }
    // group rides and leagues (#84)
    if (p === '/rest/v1/rpc/group_ride_list') return send(route, 200, db.rides || []);
    if (p === '/rest/v1/rpc/group_race_results') return send(route, 200, db.raceResults || []);
    if (p === '/rest/v1/rpc/league_list') return send(route, 200, db.leagues || []);
    if (p === '/rest/v1/rpc/create_league') {
      const id = `00000000-0000-4000-8000-00000000000${(db.leagues || []).length + 1}`;
      (db.leagues ||= []).push({ id, title: JSON.parse(body).p_title, host_name: 'Olena', races: 0, next_at: null, mine: true });
      return send(route, 200, id);
    }
    if (p === '/rest/v1/rpc/create_group_ride') {
      const q = JSON.parse(body), l = (db.leagues || []).find((x) => x.id === q.p_league);
      const id = '11111111-0000-4000-8000-000000000001';
      (db.rides ||= []).push({ id, title: q.p_title, route_id: q.p_route, starts_at: q.p_held ? new Date(Date.now() + 7200e3).toISOString() : q.p_starts, host_name: 'Olena', mine: true, riders: 1, joined: true, kind: q.p_kind, laps: q.p_laps, league_id: l?.id || null, league_title: l?.title || null, held: !!q.p_held });
      if (l) l.races += 1;
      return send(route, 200, id);
    }
    if (p === '/rest/v1/rpc/join_group_ride') {
      const q = JSON.parse(body || '{}'), g = (db.rides || []).find((r) => r.id === q.p_id), on = q.p_on !== false;
      if (g && g.joined !== on) { g.joined = on; g.riders += on ? 1 : -1; }
      return send(route, 204);
    }
    if (p === '/rest/v1/rpc/start_group_ride') { // the host starts a held ride (0010)
      const q = JSON.parse(body), g = (db.rides || []).find((r) => r.id === q.p_id && r.mine && r.held);
      if (!g) return send(route, 403, { message: 'not a held ride of yours', code: '42501' });
      Object.assign(g, { held: false, starts_at: new Date(Date.now() + q.p_in * 1000).toISOString() });
      return send(route, 200, g.starts_at);
    }
    if (p === '/rest/v1/rpc/league_standings') return send(route, 200, [{ name: 'Taras', points: 45, races: 2, wins: 1, best: 1, me: false, form: [1, 2] }, { name: 'Olena', points: 20, races: 1, wins: 0, best: 2, me: true, form: [2, null] }]);
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
  assert.equal(await page.textContent('#gr-lg-rows tr.me .gr-form-row'), '2–'); // a place per race, a dash for the one missed
  // a race in the calendar, in the league
  await page.click('[data-gr-tab="cal"]');
  await page.evaluate(() => { document.getElementById('gr-new').open = true; }); // open already when the calendar is empty
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
  await page.evaluate(() => { document.getElementById('gr-new').open = true; }); // open already when the calendar is empty
  await page.fill('#gr-title', 'Spin');
  await page.selectOption('#gr-kind', 'ride');
  assert.equal(await page.isHidden('#gr-league-wrap'), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the Ukraine board: your region marked, its place and gap over the table, medals for the first three', async () => {
  const regions = [
    { place: 1, region: 'UA-30', distance_km: 72, climb_m: 58, riders: 1 },
    { place: 2, region: 'UA-71', distance_km: 7, climb_m: 112, riders: 1 },
  ];
  const mock = mockSupabase({ profile: { ...PROFILE(), region: 'UA-71' }, regions });
  const { page, context, errors } = await openApp({ mock, local: LOCAL, signedIn: true });
  await page.waitForSelector('#hdr-account.in');
  await page.evaluate(() => document.getElementById('hdr-ua').click());
  await page.waitForSelector('#ua-sum:not([hidden])');
  assert.equal(await page.$$eval('#ua-rows .ua-rank.m1, #ua-rows .ua-rank.m2', (l) => l.length), 2);
  assert.match(await page.textContent('#ua-rows tr.me'), /Cherkasy/);
  assert.match(await page.textContent('#ua-sum'), /#2/);
  assert.match(await page.textContent('#ua-sum'), /65 km behind #1/);
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
  assert.deepEqual(await page.$$eval('#hdr-menu [data-m]', (l) => l.map((x) => x.dataset.m)), ['profile', 'settings', 'boards', 'out']);
  assert.equal(await page.isHidden('#open-profile'), true); // the rail's Profile is a guest's way in
  await page.click('#hdr-menu [data-m="boards"]'); // your leaderboards: the account card in the profile
  await page.waitForFunction(() => !document.getElementById('drawer').hidden);
  assert.equal(await page.$('#hdr-menu'), null);
  await page.evaluate(() => document.querySelector('[data-close], .drawer-close')?.click());
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

test('a ride on intervals.icu can go up again (deleted there): once more, paired with the planned workout', async () => {
  const { page, context, errors } = await openApp({ config: false, local: LOCAL });
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  await page.evaluate((date) => {
    window.__planDemo([{ id: 'icu:77', eventId: 77, source: 'intervals', date, name: 'Plan Z2 for the test', description: 'plan', notes: '', steps: [{ dur: 600, free: true, hr: [120, 135] }] }]);
  }, today);
  await page.evaluate(() => {
    document.getElementById('drawer').hidden = true;
    [...document.querySelectorAll('button, li, [data-id]')].find((e) => e.textContent.includes('Plan Z2 for the test') && (e.onclick || e.tagName === 'BUTTON'))?.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('wkd-ride').click());
  await page.waitForFunction(() => window.__ride && !document.getElementById('ride').hidden);
  if (!(await page.evaluate(() => window.__ride.workout?.eventId))) { // the plan card did not open: pick it the way the lobby does
    await context.close(); assert.fail('the planned workout did not start');
  }
  await page.waitForFunction(() => window.__ride.elapsed >= 62, null, { timeout: 90000 });
  await page.evaluate(() => { const b = document.getElementById('btn-finish'); b.click(); b.click(); });
  await page.waitForFunction(() => (window.__icuUploads || []).length === 1, null, { timeout: 20000 }); // the upload after the finish
  assert.equal((await page.evaluate(() => window.__icuUploads))[0].eventId, 77);
  await page.waitForSelector('#icu-upload-status [data-again="icu"]');
  await page.evaluate(() => document.querySelector('#icu-upload-status [data-again="icu"]').click());
  await page.waitForFunction(() => window.__icuUploads.length === 2, null, { timeout: 10000 });
  assert.equal((await page.evaluate(() => window.__icuUploads))[1].eventId, 77);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the sync says how it went: synced with the rides in the account, or what failed, with Sync now', async () => {
  const mock = mockSupabase({ profile: { id: USER.id, display_name: 'Olena', public: true, data: {} } });
  const { page, context } = await openApp({ mock, local: LOCAL, signedIn: true });
  await page.waitForFunction(() => /synced/.test(document.getElementById('hdr-account').textContent), null, { timeout: 10000 });
  assert.match(await page.textContent('#social-sync-text'), /Synced just now/);
  // the account refuses the next write: the header and the card say so, and Sync now tries again
  mock.db.failProfile = true;
  await page.evaluate(() => { const f = document.getElementById('f-weight'); f.value = '61'; f.oninput(); });
  await page.waitForFunction(() => /not synced/.test(document.getElementById('hdr-account').textContent), null, { timeout: 10000 });
  assert.match(await page.textContent('#social-sync-text'), /Not synced:/);
  mock.db.failProfile = false;
  await page.evaluate(() => document.getElementById('btn-social-sync').click());
  await page.waitForFunction(() => /Synced just now/.test(document.getElementById('social-sync-text').textContent), null, { timeout: 10000 });
  await context.close();
});

test('a new group ride from the cards: the form open on an empty calendar, then the link to send', async () => {
  const mock = mockSupabase({ profile: PROFILE() });
  const { page, context, errors } = await openApp({ mock, local: LOCAL, signedIn: true });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForSelector('#hdr-account.in');
  await page.evaluate(() => document.getElementById('hdr-group').click());
  await page.waitForSelector('#gr-empty:not([hidden])');
  assert.equal(await page.evaluate(() => document.getElementById('gr-new').open), true);
  if (process.env.GR_SHOT) await page.screenshot({ path: `${process.env.GR_SHOT}-empty.png` });
  await page.fill('#gr-title', 'Evening spin');
  await page.click('.gr-choices[data-for="gr-kind"] [data-v="race"]');
  assert.equal(await page.inputValue('#gr-kind'), 'race');
  assert.equal(await page.isVisible('#gr-laps-wrap'), true);
  await page.click('.gr-choices[data-for="gr-kind"] [data-v="ride"]');
  await page.click('#gr-routes button:nth-child(2)');
  const picked = await page.getAttribute('#gr-routes button:nth-child(2)', 'data-v');
  assert.equal(await page.inputValue('#gr-route'), picked);
  await page.click('#gr-create');
  await page.waitForSelector('#gr-made:not([hidden])');
  assert.match(await page.inputValue('#gr-made-url'), /#group=/);
  assert.equal(JSON.parse(mock.db.requests.filter((r) => r.path === '/rest/v1/rpc/create_group_ride').at(-1).body).p_route, picked);
  if (process.env.GR_SHOT) await page.screenshot({ path: `${process.env.GR_SHOT}-made.png` });
  assert.deepEqual(errors, []);
  await context.close();
});

test('a race started when everyone is ready: set up held, its host starts it from the line in 2 min', async () => {
  const mock = mockSupabase({ profile: PROFILE() });
  const { page, context, errors } = await openApp({ mock, local: LOCAL, signedIn: true });
  await page.waitForSelector('#hdr-account.in');
  await page.evaluate(() => document.getElementById('hdr-group').click());
  await page.waitForSelector('#gr-view:not([hidden])');
  await page.evaluate(() => { document.getElementById('gr-new').open = true; }); // open already when the calendar is empty
  await page.fill('#gr-title', 'Crit now');
  await page.selectOption('#gr-kind', 'race');
  await page.selectOption('#gr-start', 'ready');
  assert.equal(await page.isHidden('#gr-date'), true); // no date and time for it
  await page.click('#gr-create');
  await page.waitForSelector('.gr-row [data-act="ride"]'); // open at once
  assert.equal(JSON.parse(mock.db.requests.filter((r) => r.path === '/rest/v1/rpc/create_group_ride').at(-1).body).p_held, true);
  assert.match(await page.textContent('.gr-row'), /when ready/);
  await page.evaluate(() => { window.__pretendTrainer = false; document.querySelector('.gr-row [data-act="ride"]').click(); });
  await page.waitForSelector('#gr-host:not([hidden])', { timeout: 20000 });
  assert.match(await page.textContent('#countdown'), /On the line/);
  assert.equal(await page.isVisible('#gr-startlist'), true);
  const before = await page.evaluate(() => window.__ride.elapsed);
  await page.click('#gr-host [data-in="120"]');
  await page.waitForSelector('#gr-host', { state: 'hidden' });
  await page.waitForFunction(() => /Group start in [12]:/.test(document.getElementById('countdown').textContent));
  const sent = JSON.parse(mock.db.requests.filter((r) => r.path === '/rest/v1/rpc/start_group_ride').at(-1).body);
  assert.equal(sent.p_in, 120);
  assert.ok(await page.evaluate(() => window.__ride.elapsed) - before < 1, 'the clock waits on the line');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a ride ridden on another device: its record comes from the account (FIT, uploads), and Back goes to History', async () => {
  const id = 'r1700000000000';
  const samples = Array.from({ length: 120 }, (_, i) => ({ power: 150, cadence: 88, heartRate: 130, speed: 8, distance: i * 8, altitude: 100, elevationGain: 0, target: null, step: null }));
  const entry = { id, date: new Date(Date.now() - 3600e3).toISOString(), routeId: 'rolling', routeName: 'Rolling Hills', workoutName: null, ftp: 200,
    summary: { duration: 120, distance: 960, avgPower: 150, normalizedPower: 150, maxPower: 150, avgHr: 130, maxHr: 130, avgCadence: 88, elevationGain: 0, kj: 18 },
    tss: 2, lapTimes: [], splits: [], efforts: [], chart: { every: 5, pw: Array(24).fill(150), hr: Array(24).fill(130), d: Array.from({ length: 24 }, (_, i) => i * 40), wb: Array(24).fill(20000) }, intervals: [], updatedAt: 5 };
  const mock = mockSupabase({ profile: { id: USER.id, display_name: 'Olena', public: true, data: {} } });
  mock.db.activities = [{ id, entry, deleted: false, changed_at: 5 }];
  mock.db.records = { [id]: await packRecord({ id, start: Date.now() - 3600e3, samples, lapStarts: [0] }) };
  const { page, context, errors } = await openApp({ mock, local: LOCAL, signedIn: true });
  await page.waitForFunction((id) => document.querySelector(`.hist-row[data-id="${id}"]`), id, { timeout: 15000 }); // the history came from the account
  await page.evaluate(() => document.querySelector('[data-open="history"]').click());
  await page.evaluate((id) => document.querySelector(`.hist-row[data-id="${id}"]`).click(), id);
  await page.waitForFunction(() => !document.getElementById('btn-download').hidden, null, { timeout: 10000 }); // .FIT: the record is here
  assert.match(await page.textContent('#btn-again'), /Back to history/);
  await page.evaluate(() => document.getElementById('btn-again').click());
  await page.waitForFunction(() => !document.getElementById('drawer').hidden && !document.querySelector('[data-panel="history"]').hidden);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the groups hub: a ride picked in the list shows its details beside it, on a wide screen only', async () => {
  const mock = mockSupabase({ profile: PROFILE() });
  const mk = (n, title, min, route) => ({ id: `22222222-0000-4000-8000-00000000000${n}`, title, route_id: route, starts_at: new Date(Date.now() + min * 60e3).toISOString(), host_name: 'Taras', mine: false, riders: 4 + n, joined: false, kind: 'ride', laps: 1, league_id: null, league_title: null, held: false });
  mock.db.rides = [mk(1, 'Tempo group', 180, 'rolling'), mk(2, 'Long Saturday', 400, 'rolling')];
  const { page, context, errors } = await openApp({ mock, local: LOCAL, signedIn: true });
  await page.waitForSelector('#hdr-account.in');
  await page.evaluate(() => document.getElementById('hdr-group').click());
  await page.waitForSelector('.gr-row');
  assert.match(await page.textContent('#gr-detail h3'), /Tempo group/); // the first one, until another is picked
  assert.match(await page.textContent('#gr-detail'), /Taras/);
  assert.match(await page.textContent('#gr-detail'), /\d+(\.\d)? km/); // distance and climb of its route
  await page.click('[data-row$="2"] .gr-what');
  assert.match(await page.textContent('#gr-detail h3'), /Long Saturday/);
  await page.click('#gr-detail [data-act="join"]'); // the pane's Join is the row's Join
  await page.waitForSelector('#gr-detail [data-act="leave"]');
  assert.ok(mock.db.requests.some((r) => r.path === '/rest/v1/rpc/join_group_ride'));
  await page.setViewportSize({ width: 420, height: 800 }); // a phone: no pane
  await page.click('[data-row$="1"] .gr-what');
  assert.equal(await page.isHidden('#gr-detail'), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a held ride, not yours: waiting for the host, then off once the database has its start', async () => {
  const mock = mockSupabase({ profile: PROFILE() });
  mock.db.rides = [{ id: '22222222-0000-4000-8000-000000000002', title: 'Their crit', route_id: 'rolling', starts_at: new Date(Date.now() + 7200e3).toISOString(), host_name: 'Taras', mine: false, riders: 3, joined: true, kind: 'race', laps: 1, league_id: null, league_title: null, held: true }];
  const { page, context, errors } = await openApp({ mock, local: LOCAL, signedIn: true });
  await page.waitForSelector('#hdr-account.in');
  await page.evaluate(() => document.getElementById('hdr-group').click());
  await page.waitForSelector('.gr-row [data-act="ride"]');
  assert.match(await page.textContent('.gr-row'), /starts when Taras starts it/);
  await page.evaluate(() => { window.__pretendTrainer = false; document.querySelector('.gr-row [data-act="ride"]').click(); });
  await page.waitForFunction(() => /Waiting for the host/.test(document.getElementById('countdown').textContent), null, { timeout: 20000 });
  assert.equal(await page.isHidden('#gr-host'), true); // no start buttons for a rider
  assert.match(await page.textContent('#gr-sl-ready'), /\d+ of \d+ on the line/); // the start line's progress
  assert.equal(await page.isVisible('#chat-box.lobby #chat-input'), true); // the chat beside the list, its field open
  Object.assign(mock.db.rides[0], { held: false, starts_at: new Date(Date.now() + 60e3).toISOString() });
  await page.waitForFunction(() => /Group start in/.test(document.getElementById('countdown').textContent), null, { timeout: 30000 }); // read within 20 s
  assert.deepEqual(errors, []);
  await context.close();
});

test('another account signs in on this device: the last account’s rides, links and profile are forgotten, not sent up', async () => {
  const id = 'r1700000088000';
  const mock = mockSupabase({ profile: { id: USER.id, display_name: 'Taras', public: true, data: {} } });
  const entry = { id, date: new Date().toISOString(), routeId: 'rolling', routeName: 'Rolling Hills', summary: { duration: 60, distance: 400 }, chart: { every: 5, pw: [], hr: [], d: [], wb: [] }, lapTimes: [], splits: [] };
  const { page, context, errors } = await openApp({ mock, local: { ...LOCAL, 'gruppetto.history': [entry], 'gruppetto.owner': 'someone-else', 'gruppetto-icu-stats': { fitness: [1] }, 'gruppetto.routes': [{ id: 'gpx-home' }] }, signedIn: true });
  await page.waitForFunction((uid) => localStorage.getItem('gruppetto.owner') === uid, USER.id);
  await page.waitForFunction(() => document.getElementById('btn-start')?.onclick && /Synced/.test(document.getElementById('social-sync-text')?.textContent || ''), null, { timeout: 15000 });
  const left = await page.evaluate(() => ({ h: JSON.parse(localStorage.getItem('gruppetto.history') || '[]').length, strava: localStorage.getItem('gruppetto.strava'), s: JSON.parse(localStorage.getItem('powerup.settings') || '{}') }));
  assert.equal(left.h, 0);
  assert.equal(left.strava, null);
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('gruppetto-icu-stats'), localStorage.getItem('gruppetto.routes')]), [null, null]);
  assert.ok(!left.s.icuKey && left.s.ftp !== 240, 'the old intervals.icu key and FTP are gone');
  assert.ok(!mock.db.requests.some((r) => r.path === '/rest/v1/activities' && r.method === 'POST' && r.body.includes(id)), 'the old ride did not go up');
  noSecrets(mock.db);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the same account again: nothing forgotten', async () => {
  const id = 'r1700000077000';
  const mock = mockSupabase({ profile: { id: USER.id, display_name: 'Olena', public: true, data: {} } });
  const entry = { id, date: new Date().toISOString(), routeId: 'rolling', routeName: 'Rolling Hills', summary: { duration: 60, distance: 400 }, chart: { every: 5, pw: [], hr: [], d: [], wb: [] }, lapTimes: [], splits: [] };
  const { page, context, errors } = await openApp({ mock, local: { ...LOCAL, 'gruppetto.history': [entry], 'gruppetto.owner': USER.id }, signedIn: true });
  await page.waitForFunction(() => /Synced/.test(document.getElementById('social-sync-text')?.textContent || ''), null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gruppetto.history') || '[]').length), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a ride kept on this device: its full record goes up to the account on sync', async () => {
  const id = 'r1700000099000';
  const mock = mockSupabase({ profile: { id: USER.id, display_name: 'Olena', public: true, data: {} } });
  const entry = { id, date: new Date().toISOString(), routeId: 'rolling', routeName: 'Rolling Hills', summary: { duration: 60, distance: 400 }, chart: { every: 5, pw: [], hr: [], d: [], wb: [] }, lapTimes: [], splits: [], efforts: [], updatedAt: 9 };
  const { page, context, errors } = await openApp({ mock, local: { ...LOCAL, 'gruppetto.history': [entry] }, signedIn: true });
  await page.evaluate(async (id) => {
    const { putRide } = await import('/js/ride-store.js');
    await putRide({ id, start: Date.now(), samples: Array.from({ length: 60 }, () => ({ power: 140 })), lapStarts: [0] });
  }, id);
  await page.evaluate(() => document.getElementById('btn-social-sync').click());
  await page.waitForFunction(() => /Synced/.test(document.getElementById('social-sync-text').textContent), null, { timeout: 10000 });
  await page.waitForTimeout(300);
  assert.ok(mock.db.records?.[id], 'the record went up');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a route of yours on Strava: listed, picked, and in My routes', async () => {
  const { page, context, errors } = await openApp({ config: false, local: { ...LOCAL, 'gruppetto.strava-on': '1' } });
  const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><name>Kyiv loop</name><trkseg>${Array.from({ length: 60 }, (_, i) => `<trkpt lat="${50.45 + i * 0.0009}" lon="${30.52 + Math.sin(i / 9) * 0.002}"><ele>${170 + i}</ele></trkpt>`).join('')}</trkseg></trk></gpx>`;
  const seen = [];
  await page.route('https://www.strava.com/api/v3/**', (route) => {
    const u = new URL(route.request().url()); seen.push(u.pathname);
    const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
    if (u.pathname === '/api/v3/athlete') return json({ id: 42 });
    if (u.pathname === '/api/v3/athletes/42/routes') return json([{ id: 1, id_str: '9001', name: 'Kyiv loop', distance: 5400, elevation_gain: 60, type: 1 }, { id: 2, id_str: '9002', name: 'Run', distance: 5000, type: 2 }]);
    if (u.pathname === '/api/v3/routes/9001/export_gpx') return route.fulfill({ status: 200, contentType: 'application/gpx+xml', headers: { 'access-control-allow-origin': '*' }, body: gpx });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.evaluate(() => { document.getElementById('drawer').hidden = true; document.querySelector('.rc-strava').click(); });
  await page.waitForSelector('#sr-list [data-id="9001"]');
  assert.equal(await page.locator('#sr-list [data-id]').count(), 1); // the run is left out
  await page.evaluate(() => document.querySelector('#sr-list [data-id="9001"]').click());
  await page.waitForFunction(() => [...document.querySelectorAll('#route-list .option[data-id]')].some((e) => e.textContent.includes('Kyiv loop')), null, { timeout: 60000 });
  assert.ok(seen.includes('/api/v3/routes/9001/export_gpx'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('race results by category: yours first, All a tap away, and a copy for the club', async () => {
  const id = 'r1700000055000';
  const entry = { id, date: new Date().toISOString(), routeId: 'rolling', routeName: 'Rolling Hills', groupRace: { id: '33333333-0000-4000-8000-000000000003', title: 'Club crit' },
    summary: { duration: 1460, distance: 12000, avgPower: 230 }, chart: { every: 5, pw: [], hr: [], d: [], wb: [] }, lapTimes: [], splits: [], efforts: [], updatedAt: 9 };
  const mock = mockSupabase({ profile: PROFILE() });
  mock.db.raceResults = [
    { name: 'Taras', time_s: 1450, avg_w: 300, wkg: 4.1, sim: false, me: false, cat: 'A' },
    { name: 'Olena', time_s: 1460, avg_w: 200, wkg: 3.3, sim: false, me: true, cat: 'B' },
    { name: 'Bo', time_s: 1500, avg_w: 210, wkg: 3.2, sim: false, me: false, cat: 'B' },
  ];
  const { page, context, errors } = await openApp({ mock, local: { ...LOCAL, 'gruppetto.history': [entry] }, signedIn: true });
  await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await page.waitForSelector('#hdr-account.in');
  await page.evaluate(() => document.querySelector('[data-open="history"]').click());
  await page.evaluate((id) => document.querySelector(`.hist-row[data-id="${id}"]`).click(), id);
  await page.waitForSelector('#sum-race:not([hidden]) #sum-race-cats:not([hidden])', { timeout: 15000 });
  assert.match(await page.textContent('#sum-race-place'), /B · 1 of 2/); // your category first
  assert.equal(await page.locator('#sum-race-rows tr').count(), 2);
  await page.click('#sum-race-cats [data-cat=""]');
  assert.equal(await page.locator('#sum-race-rows tr').count(), 3);
  assert.match(await page.textContent('#sum-race-place'), /2 of 3/);
  await page.click('#btn-race-copy');
  await page.waitForFunction(() => window.__copied);
  assert.match(await page.evaluate(() => window.__copied), /Club crit[\s\S]*\nA\n1\. Taras[\s\S]*\nB\n1\. Olena[\s\S]*2\. Bo .*\+0:40/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the lobby: the next group race as a big card with Join, the mode as segments; no social, no card', async () => {
  const mock = mockSupabase({ profile: PROFILE() });
  mock.db.rides = [{ id: '33333333-0000-4000-8000-000000000003', title: 'Winter crit', route_id: 'rolling', starts_at: new Date(Date.now() + 3 * 3600e3).toISOString(), host_name: 'Taras', mine: false, riders: 4, joined: false, kind: 'race', laps: 2, league_id: null, league_title: null, held: false }];
  const { page, context, errors } = await openApp({ mock, local: LOCAL, signedIn: true });
  await page.waitForSelector('#race-card:not([hidden]) [data-act="join"]');
  const card = await page.textContent('#race-card');
  assert.match(card, /Winter crit/);
  assert.match(card, /Rolling Hills/);
  assert.match(card, /4 going/);
  await page.evaluate(() => document.querySelector('#race-card [data-act="join"]').click()); // the Devices page may be open over the lobby
  await page.waitForFunction(() => document.querySelector('#race-card [data-act="leave"]')); // joined: the button says so
  assert.ok(mock.db.requests.some((r) => r.path === '/rest/v1/rpc/join_group_ride'));
  // the mode: three segments, the picked one's card under them
  assert.equal(await page.locator('.mode-select + .seg > button').count(), 3);
  await page.evaluate(() => document.querySelector('.mode-select + .seg > button[data-v="race"]').click());
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('powerup.settings')).mode), 'race');
  assert.equal(await page.locator('#mode-list .option.cur').count(), 1);
  assert.equal(await page.isVisible('#mode-list .race-pick'), true);
  assert.equal(await page.isVisible('#mode-list [data-id="free"]'), false);
  await page.evaluate(() => document.querySelector('.mode-select + .seg > button[data-v="free"]').click());
  assert.equal(await page.isVisible('#mode-list [data-id="free"]'), false); // a free ride: no card, the segment is enough
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('powerup.settings')).mode), 'free');
  assert.deepEqual(errors, []);
  await context.close();
  // no Supabase project: the card stays hidden
  const off = await openApp({ config: false, local: LOCAL });
  assert.equal(await off.page.isHidden('#race-card'), true);
  assert.deepEqual(off.errors, []);
  await off.context.close();
});
