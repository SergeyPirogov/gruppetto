import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNC_FIELDS, profileFields, accountData, mergeRecords, mergeProgress, mergeData, sameData, categoryOf, routeVersion,
  wkgCeiling, checkEffort, averages, rideItems, enqueue, oauthReturn, periodStart, boardFrom, withGaps, flagOf,
} from '../js/social-core.js';
import { routes, Route } from '../js/routes.js';

const SECRETS = { icuKey: 'icu-secret-key', icuAthlete: 'i123', devices: { trainer: 'abc' }, quality: 'high', camera: 'chase', sound: false };

test('social: only the white list of settings goes to the account, never keys or devices', () => {
  const settings = { name: 'Olena', weight: 61, ftp: 240, jersey: '#fff', ...SECRETS };
  const p = profileFields(settings, 'uk');
  assert.deepEqual(p, { name: 'Olena', weight: 61, ftp: 240, jersey: '#fff', lang: 'uk' });
  assert.ok(SYNC_FIELDS.includes('hrZones'));
  const data = accountData({ settings, lang: 'en', settingsUpdatedAt: 5, progress: { xp: 1 }, records: { lap: { a: 1 }, seg: {}, top: {}, segTrace: { a: [0, 1] } } });
  const json = JSON.stringify(data);
  for (const v of ['icu-secret-key', 'i123', 'abc', 'segTrace', 'quality', 'camera']) assert.ok(!json.includes(v), v);
  assert.deepEqual(data.records, { lap: { a: 1 }, seg: {}, top: {} });
});

test('social: records merge to the shorter time and the higher sprint speed', () => {
  const a = { lap: { rolling: 900, alps: 3000 }, seg: { 'rolling-c1': 120 }, top: { 'rolling-s1': 52.1 } };
  const b = { lap: { rolling: 880 }, seg: { 'rolling-c1': 130, 'rolling-c2': 60 }, top: { 'rolling-s1': 49, 'rolling-s2': 40 } };
  assert.deepEqual(mergeRecords(a, b), {
    lap: { rolling: 880, alps: 3000 }, seg: { 'rolling-c1': 120, 'rolling-c2': 60 }, top: { 'rolling-s1': 52.1, 'rolling-s2': 40 },
  });
  assert.deepEqual(mergeRecords(null, { lap: { x: 0, y: -1, z: 'a' } }), { lap: {}, seg: {}, top: {} }); // nonsense left out
});

test('social: levels merge to the bigger XP, badges to all of them on the earlier day', () => {
  const a = { xp: 1200, rides: 10, badges: { first: '2026-10-01', hour: '2026-10-20' } };
  const b = { xp: 800, rides: 6, badges: { first: '2026-09-15', ramp: '2026-10-02' } };
  const m = mergeProgress(a, b);
  assert.equal(m.xp, 1200);
  assert.equal(m.rides, 10);
  assert.deepEqual(m.badges, { first: '2026-09-15', hour: '2026-10-20', ramp: '2026-10-02' });
  assert.equal(mergeProgress(null, b).xp, 800);
  assert.equal(mergeProgress(a, null).xp, 1200);
});

test('social: the newer profile wins, the records and levels merge, a first sign-in loses nothing', () => {
  const local = { profile: { name: 'Me', ftp: 250 }, settingsUpdatedAt: 2000, records: { lap: { rolling: 900 }, seg: {}, top: {} }, progress: { xp: 50, badges: {} } };
  const remote = { profile: { name: 'Olena', ftp: 230 }, settingsUpdatedAt: 1000, records: { lap: { rolling: 950, alps: 3000 }, seg: {}, top: {} }, progress: { xp: 900, badges: { first: '2026-01-01' } } };
  const m = mergeData(local, remote);
  assert.deepEqual(m.profile, { name: 'Me', ftp: 250 }); // this device's is newer
  assert.equal(m.settingsUpdatedAt, 2000);
  assert.deepEqual(m.records.lap, { rolling: 900, alps: 3000 });
  assert.equal(m.progress.xp, 900);
  const m2 = mergeData({ ...local, settingsUpdatedAt: 500 }, remote);
  assert.deepEqual(m2.profile, { name: 'Olena', ftp: 230 }); // the account's is newer
  // a tie keeps this device's
  assert.deepEqual(mergeData({ ...local, settingsUpdatedAt: 1000 }, remote).profile, local.profile);
  // a new account (nothing there yet) takes this device's data as it is
  const m3 = mergeData(local, null);
  assert.deepEqual(m3.profile, local.profile);
  assert.deepEqual(m3.records.lap, { rolling: 900 });
  assert.ok(sameData({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }));
  assert.ok(!sameData({ a: 1 }, { a: 2 }));
});

test('social: categories A–D from FTP per kilo', () => {
  assert.equal(categoryOf(300, 75), 'A'); // 4.0
  assert.equal(categoryOf(299, 75), 'B');
  assert.equal(categoryOf(240, 75), 'B'); // 3.2
  assert.equal(categoryOf(239, 75), 'C');
  assert.equal(categoryOf(188, 75), 'C'); // 2.5
  assert.equal(categoryOf(187, 75), 'D');
  assert.equal(categoryOf(0, 75), 'D');
});

test('social: a route version is stable, short and changes with the route', () => {
  const r = routes[0];
  const v = routeVersion(r);
  assert.match(v, /^[0-9a-f]{8}$/);
  assert.equal(routeVersion(new Route({ ...ROUTE_DEF(r) })), v); // the same route built again
  const versions = new Set(routes.filter((x) => !x.custom).map(routeVersion));
  assert.equal(versions.size, routes.filter((x) => !x.custom).length); // every route its own
  const higher = { length: r.length, elevAt: (d) => r.elevAt(d) + (d > r.length / 2 ? 3 : 0) };
  assert.notEqual(routeVersion(higher), v);
  const longer = { length: r.length + 200, elevAt: (d) => r.elevAt(Math.min(d, r.length - 1)) };
  assert.notEqual(routeVersion(longer), v);
});
// the definition a built-in route was made from (its own fields, before the segments)
const ROUTE_DEF = (r) => ({ id: r.id, name: r.name, length: r.length, hills: r.hills, curves: r.curves, oneWay: r.oneWay });

const effort = (o = {}) => ({
  segment_id: 'rolling-c1', kind: 'climb', route_id: 'rolling', route_version: 'abcd1234',
  time_s: 300, length_m: 2000, avg_power: 250, avg_hr: 160, weight_kg: 75, ftp: 260, ridden_at: '2026-11-09T10:00:00Z', ...o,
});

test('social: plausibility — limits, speed, power and the W/kg ceilings by duration', () => {
  assert.deepEqual(checkEffort(effort()), { ok: true, flags: [] });
  assert.equal(checkEffort(effort({ weight_kg: 29 })).reason, 'weight');
  assert.equal(checkEffort(effort({ weight_kg: 201 })).reason, 'weight');
  assert.ok(checkEffort(effort({ weight_kg: 30 })).ok === false); // 250 W at 30 kg for 5 min is 8.3 W/kg: too much
  assert.equal(checkEffort(effort({ weight_kg: 30 })).reason, 'wkg');
  assert.equal(checkEffort(effort({ ftp: 49 })).reason, 'ftp');
  assert.equal(checkEffort(effort({ ftp: 601 })).reason, 'ftp');
  assert.equal(checkEffort(effort({ time_s: 4.9, length_m: 100 })).reason, 'time');
  assert.equal(checkEffort(effort({ time_s: 79, length_m: 2000 })).reason, 'speed'); // 25.3 m/s
  assert.ok(checkEffort(effort({ time_s: 80, length_m: 2000 })).ok); // 25 m/s exactly
  assert.equal(checkEffort(effort({ avg_power: 0 })).reason, 'power');
  assert.equal(checkEffort(effort({ avg_power: null })).reason, 'power');
  assert.equal(checkEffort(effort({ kind: 'descent' })).reason, 'invalid');
  assert.equal(checkEffort(effort(), { today: 200 }).reason, 'limit');
  assert.ok(checkEffort(effort(), { today: 199 }).ok);
  // the ceilings: 13 to a minute, 8 to 5, 6.8 to 20, 6.3 beyond
  assert.deepEqual([30, 60, 61, 300, 301, 1200, 1201, 7200].map(wkgCeiling), [13, 13, 8, 8, 6.8, 6.8, 6.3, 6.3]);
  const at = (sec, wkg) => checkEffort(effort({ time_s: sec, length_m: sec * 8, avg_power: wkg * 75 }));
  assert.ok(at(60, 13).ok); assert.equal(at(60, 13.1).reason, 'wkg');
  assert.ok(at(300, 8).ok); assert.equal(at(300, 8.1).reason, 'wkg');
  assert.ok(at(1200, 6.8).ok); assert.equal(at(1200, 6.9).reason, 'wkg');
  assert.ok(at(3600, 6.3).ok); assert.equal(at(3600, 6.4).reason, 'wkg');
  // shown, but flagged: no heart rate, and above 90 % of the ceiling
  assert.deepEqual(checkEffort(effort({ avg_hr: null })).flags, ['no-hr']);
  assert.deepEqual(at(300, 7.5).flags, ['high']);
  assert.deepEqual(at(300, 7).flags, []);
});

test('social: a segment\'s average power counts coasting, heart rate leaves out the zeros', () => {
  const s = [{ power: 200, heartRate: 0 }, { power: 0, heartRate: 150 }, { power: 400, heartRate: 160 }, { power: 999, heartRate: 190 }];
  assert.deepEqual(averages(s, 0, 3), { power: 200, hr: 155 });
  assert.deepEqual(averages(s, 3, 3), { power: 0, hr: null });
  assert.deepEqual(averages([{ power: 100 }], 0, 1), { power: 100, hr: null });
});

test('social: a ride sends its laps and segments on a built-in route only, never from the simulator', () => {
  const route = routes[0];
  const base = {
    route, version: 'v1', weight: 75, ftp: 250, client: 'test',
    laps: [{ segId: `${route.id}-lap`, kind: 'lap', time: 1500.04, length: 20000, power: 220, hr: 150, at: Date.UTC(2026, 10, 9) }],
    efforts: [
      { segId: `${route.id}-c1`, kind: 'climb', time: 300, length: 2000, power: 260, hr: 165, at: Date.UTC(2026, 10, 9) },
      { segId: `${route.id}-s1`, kind: 'sprint', time: 2, length: 250, power: 900, hr: 170, top: 60, at: Date.UTC(2026, 10, 9) }, // impossible: stays here
    ],
  };
  const items = rideItems(base);
  assert.deepEqual(items.map((x) => x.segment_id), [`${route.id}-lap`, `${route.id}-c1`]);
  assert.equal(items[0].time_s, 1500);
  assert.equal(items[0].route_version, 'v1');
  assert.equal(items[0].ridden_at, '2026-11-09T00:00:00.000Z');
  assert.deepEqual(rideItems({ ...base, simulated: true }), []);
  assert.deepEqual(rideItems({ ...base, route: { ...route, custom: true } }), []);
});

test('social: the offline queue keeps each result once and at most 500', () => {
  const a = effort(), b = effort({ segment_id: 'rolling-c2' });
  assert.equal(enqueue([a], [a, b]).length, 2);
  const many = Array.from({ length: 600 }, (_, i) => effort({ ridden_at: new Date(i * 1000).toISOString() }));
  const q = enqueue([], many);
  assert.equal(q.length, 500);
  assert.equal(q[0].ridden_at, new Date(100 * 1000).toISOString()); // the oldest went first
});

test('social: Google\'s return is told apart from Strava\'s', () => {
  assert.deepEqual(oauthReturn('?code=abc', 'gruppetto-strava'), { code: 'abc' });
  assert.equal(oauthReturn('?code=abc&state=gruppetto-strava&scope=read,activity:write', 'gruppetto-strava'), null);
  assert.equal(oauthReturn('?state=gruppetto-strava&error=access_denied', 'gruppetto-strava'), null);
  assert.deepEqual(oauthReturn('?error=access_denied&error_description=Denied', 'gruppetto-strava'), { error: 'Denied' });
  assert.equal(oauthReturn('', 'gruppetto-strava'), null);
  assert.equal(oauthReturn('?debug', 'gruppetto-strava'), null);
});

test('social: periods start on Monday and on the 1st (UTC)', () => {
  const wed = new Date('2026-11-11T15:00:00Z');
  assert.equal(periodStart('week', wed).toISOString(), '2026-11-09T00:00:00.000Z');
  assert.equal(periodStart('week', new Date('2026-11-09T00:30:00Z')).toISOString(), '2026-11-09T00:00:00.000Z');
  assert.equal(periodStart('week', new Date('2026-11-15T23:00:00Z')).toISOString(), '2026-11-09T00:00:00.000Z'); // Sunday
  assert.equal(periodStart('month', wed).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(periodStart('all', wed), null);
});

test('social: a table has one row a person, the top 10 and my window, filtered', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  const rows = [];
  for (let i = 1; i <= 30; i++) {
    rows.push({ user_id: `u${i}`, time_s: 100 + i, ridden_at: '2026-11-10T10:00:00Z', gender: i % 2 ? 'm' : 'f', category: i <= 5 ? 'A' : 'C' });
    rows.push({ user_id: `u${i}`, time_s: 200 + i, ridden_at: '2026-11-10T11:00:00Z', gender: i % 2 ? 'm' : 'f', category: 'C' }); // a slower one
  }
  rows.push({ user_id: 'old', time_s: 50, ridden_at: '2026-10-01T10:00:00Z', gender: 'm', category: 'A' });
  rows.push({ user_id: 'hidden', time_s: 10, ridden_at: '2026-11-10T10:00:00Z', public: false, category: 'A' });
  const all = boardFrom(rows, { me: 'u25', now });
  assert.equal(all.total, 31);
  assert.equal(all.rows[0].user_id, 'old');
  assert.deepEqual(all.rows.map((r) => r.place), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 23, 24, 25, 26, 27, 28, 29]);
  assert.equal(all.mine.place, 26);
  assert.equal(all.rows.find((r) => r.me).time_s, 125); // the best of mine
  const gaps = withGaps(all.rows);
  assert.equal(gaps.filter((r) => r.gap).length, 1);
  assert.ok(gaps[10].gap);
  const week = boardFrom(rows, { me: 'u25', period: 'week', now });
  assert.equal(week.total, 30); // the October ride is out
  assert.equal(boardFrom(rows, { period: 'week', gender: 'f', now }).total, 15);
  const a = boardFrom(rows, { period: 'week', category: 'A', now });
  assert.deepEqual(a.rows.map((r) => r.user_id), ['u1', 'u2', 'u3', 'u4', 'u5']);
  const c = boardFrom(rows, { me: 'u2', period: 'week', category: 'C', now });
  assert.equal(c.mine.time_s, 202); // in C only the slower ride counts
  assert.equal(boardFrom(rows, { me: 'u3', now }).rows.length, 10); // in the top 10: no window
  assert.equal(flagOf('UA'), '🇺🇦');
  assert.equal(flagOf(''), '');
});

test('social: a ride sends one result a segment, its fastest', () => {
  const route = routes.find((r) => r.id === 'velodrome');
  const lap = (time, k) => ({ segId: 'velodrome-lap', kind: 'lap', time, length: 500, power: 250, hr: 150, at: Date.UTC(2026, 10, 9, 10, k) });
  const items = rideItems({ route, version: 'v', weight: 75, ftp: 250, laps: [lap(48, 1), lap(44.2, 2), lap(46, 3)], efforts: [] });
  assert.equal(items.length, 1);
  assert.equal(items[0].time_s, 44.2);
});

test('velodrome: a closed 500 m flat oval with a flying 250 m', () => {
  const r = routes.find((x) => x.id === 'velodrome');
  assert.equal(r.length, 500);
  assert.equal(r.elevationGain, 0);
  assert.equal(r.climbs.length, 0);
  assert.deepEqual(r.sprints.map((s) => [s.id, s.start, s.length]), [['velodrome-s1', 250, 250]]);
  let h = 0, x = 0, y = 0; // the road as render3d lays it: it comes back to the line, facing the same way
  for (const s of r.segments) { h += (s.curve * 2.5) / 5; x += 5 * Math.cos(h); y += 5 * Math.sin(h); }
  assert.ok(Math.abs(h - 2 * Math.PI) < 1e-9);
  assert.ok(Math.hypot(x, y) < 0.5);
});
