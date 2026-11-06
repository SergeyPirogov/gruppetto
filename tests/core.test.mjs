import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIndoorBikeData, parseCyclingPower, parseHeartRate, cadenceFromCrank } from '../js/ble.js';
import { steadySpeed } from '../js/physics.js';
import { routes } from '../js/routes.js';
import { workouts, targetAt, totalDuration } from '../js/workouts.js';
import { Recorder, normalizedPower, bestAverage } from '../js/recorder.js';

const dv = (bytes) => new DataView(new Uint8Array(bytes).buffer);

test('FTMS indoor bike data: speed, cadence, power, HR', () => {
  // flags: speed present (bit0=0), cadence (bit2), power (bit6), HR (bit9)
  const flags = 0x0004 | 0x0040 | 0x0200;
  const r = parseIndoorBikeData(dv([flags & 0xff, flags >> 8, 0xc4, 0x09, 0xb4, 0x00, 0xfa, 0x00, 0x8c]));
  assert.equal(r.speed, 25);     // 2500 * 0.01
  assert.equal(r.cadence, 90);   // 180 * 0.5
  assert.equal(r.power, 250);
  assert.equal(r.heartRate, 140);
});

test('Cycling power with crank data and cadence rollover', () => {
  const r = parseCyclingPower(dv([0x20, 0x00, 0x2c, 0x01, 0xff, 0xff, 0x00, 0xfc]));
  assert.equal(r.power, 300);
  assert.equal(r.crankRevs, 0xffff);
  const next = { crankRevs: 0x0001, crankTime: (0xfc00 + 1365) & 0xffff }; // 2 revs in 1.333 s
  assert.equal(Math.round(cadenceFromCrank(r, next)), 90);
});

test('Heart rate uint8 and uint16', () => {
  assert.equal(parseHeartRate(dv([0x00, 72])), 72);
  assert.equal(parseHeartRate(dv([0x01, 0x2c, 0x01])), 300);
});

test('Physics: realistic speeds', () => {
  const flat = steadySpeed(200, 0, 75) * 3.6;
  assert.ok(flat > 30 && flat < 38, `flat ${flat}`);
  const climb = steadySpeed(250, 0.06, 75) * 3.6;
  assert.ok(climb > 12 && climb < 18, `climb ${climb}`);
});

test('Routes loop seamlessly with sane grades', () => {
  for (const r of routes) {
    assert.ok(Math.abs(r.elevAt(0) - r.elevAt(r.length)) < 1e-6);
    let max = 0;
    for (let d = 0; d < r.length; d += 10) max = Math.max(max, Math.abs(r.gradeAt(d)));
    assert.ok(max < 0.12, `${r.id} max grade ${max}`);
  }
});

test('Workout targets and ramps', () => {
  const w = workouts.find((x) => x.id === 'quick');
  assert.equal(totalDuration(w), 180);
  assert.equal(targetAt(w, 0, 200).watts, 100);
  assert.equal(targetAt(w, 90, 200).watts, 160);
  assert.equal(targetAt(w, 150, 200).watts, 80); // halfway down 0.5→0.3
  assert.equal(targetAt(w, 180, 200), null);
});

test('Recorder: NP, best average, TCX', () => {
  assert.equal(normalizedPower(Array(60).fill(200)), 200);
  assert.equal(bestAverage([100, 100, 300, 300, 100], 2), 300);
  const rec = new Recorder();
  for (let i = 0; i < 5; i++) rec.add({ power: 200, cadence: 90, heartRate: 130, speed: 9, distance: i * 9, altitude: 100, elevationGain: 0 });
  const xml = rec.toTCX();
  assert.match(xml, /<ns3:Watts>200<\/ns3:Watts>/);
  assert.equal((xml.match(/<Trackpoint>/g) || []).length, 5);
});
