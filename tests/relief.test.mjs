import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeProfile, gradeShape, mountainSide, shapeOffset, arrayAt, reliefStep, encodeRelief, decodeRelief, reliefAt } from '../js/relief.js';
import { routeFromTrack } from '../js/gpx.js';

test('grade shape: flat is meadow, a climb raises one side and drops the other, steeper is taller and rockier', () => {
  const flat = gradeShape(0.01);
  assert.deepEqual([flat.rise, flat.drop, flat.lower, flat.rocky], [0, 0, 0, 0]);
  assert.equal(flat.ampK, 1);
  const a = gradeShape(0.05), b = gradeShape(0.08), c = gradeShape(0.12);
  assert.ok(a.rise > 0 && b.rise > a.rise && c.rise > b.rise);
  assert.ok(b.drop > a.drop && b.rocky > a.rocky && c.rocky >= b.rocky);
  assert.ok(c.rocky <= 1);
  const down = gradeShape(-0.06);
  assert.equal(down.rise, 0);
  assert.ok(down.lower > 0 && down.ampK < 1 && down.rocky === 0);
});

test('shapeOffset: the mountain side rises, the other falls, nothing on the road bed, less where another road limits it', () => {
  const sh = gradeShape(0.08);
  assert.ok(Math.abs(shapeOffset(4, 1, sh)) < 0.01);
  assert.ok(shapeOffset(150, 1, sh) > 20);        // right is the mountain
  assert.ok(shapeOffset(-150, 1, sh) < -10);      // the left falls away
  assert.ok(shapeOffset(-150, -1, sh) > 20);      // the other way round
  assert.equal(shapeOffset(150, 0, sh), 0);       // no side chosen: nothing
  assert.ok(shapeOffset(150, 1, sh, 0.25) < shapeOffset(150, 1, sh) / 3);
});

test('grade profile averages over ~200 m, so one 5 m step does not move it', () => {
  const elev = Array.from({ length: 400 }, (_, i) => 100 + i * 0.25 + (i === 200 ? 3 : 0)); // 5 % with a 3 m spike
  const g = gradeProfile(elev);
  assert.ok(Math.abs(g[100] - 0.05) < 0.002);
  assert.ok(Math.abs(g[200] - 0.05) < 0.02); // the spike is smeared, not a 60 % grade
  const ramp = gradeProfile(Array.from({ length: 200 }, (_, i) => (i < 100 ? 100 : 100 + (i - 100) * 0.4))); // flat then 8 %
  assert.ok(ramp[40] < 0.001 && ramp[160] > 0.07 && ramp[100] > 0.01 && ramp[100] < 0.07); // changes over a stretch
  const loop = gradeProfile(Array.from({ length: 300 }, (_, i) => 100 + Math.sin((i / 300) * 2 * Math.PI) * 10), { loop: true });
  assert.ok(Math.abs(loop[0] - loop[299]) < 0.002); // a loop wraps round the start line
});

test('mountain side: the inside of a bend, smooth, in range and the same every time', () => {
  const right = Array(300).fill(0.06), left = Array(300).fill(-0.06); // a long bend
  const r = mountainSide(right), l = mountainSide(left);
  assert.ok(r[150] > 0.9 && l[150] < -0.9);
  assert.deepEqual([...mountainSide(right)], [...r]);
  const straight = mountainSide(Array(1200).fill(0));
  let max = 0;
  for (let i = 1; i < straight.length; i++) { max = Math.max(max, Math.abs(straight[i] - straight[i - 1])); assert.ok(Math.abs(straight[i]) <= 1); }
  assert.ok(max < 0.15, `side changes gradually (${max})`);
  assert.ok(Math.abs(arrayAt(straight, 7.5, false) - (straight[1] + straight[2]) / 2) < 1e-6);
});

// a surface that rises 0.2 m per m to the north and 0.05 m per m to the east, to see how it is read in the road's own frame
const lat0 = 48.45, lon0 = 24.55, mLat = 1 / 111320, mLon = 1 / (111320 * Math.cos(lat0 * Math.PI / 180));
const surface = (lat, lon) => 100 + ((lat - lat0) / mLat) * 0.2 + ((lon - lon0) / mLon) * 0.05;
const eastTrack = (km) => Array.from({ length: km * 100 + 1 }, (_, i) => ({ lat: lat0, lon: lon0 + i * 10 * mLon, ele: 100 }));

test('relief corridor: encode and decode round trip, to the decimetre', () => {
  const rel = encodeRelief(2000, (s, o) => Math.sin(s / 300) * 40 + o * 0.1);
  const R = decodeRelief(rel);
  assert.equal(R.step, 25);
  assert.equal(R.rows, Math.floor(2000 / 25) + 2);
  for (const [s, o] of [[0, -300], [500, 20], [1000, 300], [1975, -75]]) {
    const want = Math.sin(s / 300) * 40 + o * 0.1;
    assert.ok(Math.abs(reliefAt(R, s, o) - want) < 0.5, `${s},${o}: ${reliefAt(R, s, o)} vs ${want}`);
  }
  assert.equal(decodeRelief(null), null);
  assert.equal(decodeRelief({ v: 9, step: 25, data: '' }), null);
  assert.equal(decodeRelief({ v: 1, step: 25, data: 'AAA=' }), null); // not a whole number of rows
});

test('relief corridor: 50 km stays under 150 KB and a longer route is coarser, not bigger', () => {
  const size = (km) => JSON.stringify(encodeRelief(km * 1000, () => 12.3)).length;
  assert.ok(size(50) < 150000, `50 km: ${size(50)}`);
  assert.ok(size(150) < 155000, `150 km: ${size(150)}`);
  assert.equal(reliefStep(50000), 25);
  assert.ok(reliefStep(150000) > 25 && reliefStep(150000) % 5 === 0);
  assert.ok(size(10) / 10 < 2000, 'about 1.5 KB per km');
});

test('relief sampling: zero on the road, linear across the corridor, held beyond it, a loop wraps', () => {
  const R = decodeRelief(encodeRelief(1000, (s, o) => o * 0.2));
  assert.equal(reliefAt(R, 100, 0), 0);
  assert.ok(Math.abs(reliefAt(R, 100, 10) - 2) < 0.2); // between the road's centre (0) and the column at 20
  assert.ok(Math.abs(reliefAt(R, 333, 90) - 18) < 0.1);
  assert.ok(Math.abs(reliefAt(R, 333, -500) - -60) < 0.1); // beyond 300 m the last column holds
  const loop = decodeRelief(encodeRelief(1000, (s) => Math.sin((s / 1000) * 2 * Math.PI) * 5, { loop: true }));
  const want = (s) => Math.sin((s / 1000) * 2 * Math.PI) * 5;
  assert.ok(Math.abs(reliefAt(loop, 250, 300, 1000) - want(250)) < 0.1);
  assert.ok(Math.abs(reliefAt(loop, 1250, 300, 1000) - want(250)) < 0.1); // the second lap
  assert.ok(Math.abs(reliefAt(loop, 990, 300, 1000) - want(990)) < 0.1); // runs on into the first row
});

test('GPX import with a terrain model keeps the real relief in the road frame (right of the road is +o)', () => {
  const def = routeFromTrack({ name: 'East', points: eastTrack(3) }, '', { elevation: surface });
  assert.equal(def.elevSource, 'terrain');
  assert.equal(def.relief.v, 1);
  const R = decodeRelief(def.relief);
  // heading east: right is south, where the surface falls 0.2 m per m; left (north) it rises
  assert.ok(Math.abs(reliefAt(R, 1000, 110) - -22) < 1.5, `right ${reliefAt(R, 1000, 110)}`);
  assert.ok(Math.abs(reliefAt(R, 1000, -160) - 32) < 1.5, `left ${reliefAt(R, 1000, -160)}`);
  assert.equal(reliefAt(R, 1000, 0), 0);
});

test('GPX import without a terrain model has no relief (it uses the grade, like a route from before)', () => {
  const def = routeFromTrack({ name: 'East', points: eastTrack(2) });
  assert.equal(def.relief, undefined);
});

test('relief of a turning road follows the road, not the compass (a track that turns south)', () => {
  const pts = eastTrack(1);
  for (let i = 1; i <= 100; i++) pts.push({ lat: lat0 - i * 10 * mLat, lon: pts[100].lon, ele: 100 }); // then 1 km south
  const def = routeFromTrack({ name: 'L', points: pts }, '', { elevation: surface });
  const R = decodeRelief(def.relief);
  // heading south, right is west; the surface falls 0.05 m per m going west, so right is lower
  const s = def.curve.length * 5 - 500;
  assert.ok(Math.abs(reliefAt(R, s, 110) - -5.5) < 1, `${reliefAt(R, s, 110)}`);
  assert.ok(Math.abs(reliefAt(R, s, -110) - 5.5) < 1, `${reliefAt(R, s, -110)}`);
});
