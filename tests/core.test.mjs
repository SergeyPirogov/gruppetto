import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIndoorBikeData, parseCyclingPower, parseHeartRate, cadenceFromCrank, parseCSC, wahoo, parseRideKeypad } from '../js/ble.js';
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

test('Wahoo legacy control encoding', () => {
  assert.deepEqual(wahoo.unlock(), [0x20, 0xee, 0xfc]);
  assert.deepEqual(wahoo.erg(250), [0x42, 0xfa, 0x00]);
  assert.deepEqual(wahoo.simMode(83, 0.004, 0.51), [0x43, 0x6c, 0x20, 0x04, 0x00, 0xfe, 0x01]); // 8300, 4, 510
  assert.deepEqual(wahoo.grade(0), [0x46, 0xff, 0x7f]);   // 32767
  assert.deepEqual(wahoo.grade(5), [0x46, 0x65, 0x86]);   // floor(1.05 * 32767.5) = 34405
  assert.deepEqual(wahoo.grade(-100), [0x46, 0x00, 0x00]);
});

test('CSC crank cadence', () => {
  const m = parseCSC(dv([0x02, 0x0a, 0x00, 0x00, 0x04]));
  assert.deepEqual(m, { crankRevs: 10, crankTime: 1024 });
  assert.deepEqual(parseCSC(dv([0x01, 1, 0, 0, 0, 0, 0])), {});
});

test('Zwift Ride keypad: inverted bits and analog paddles', () => {
  const varint = (v) => { const out = []; while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; } out.push(v); return out; };
  const idle = 0xffff;
  assert.equal(parseRideKeypad([0x23, 0x08, ...varint(idle)]).size, 0);
  const shiftUpR = idle & ~0x1000;
  assert.deepEqual([...parseRideKeypad([0x23, 0x08, ...varint(shiftUpR)])], ['shiftUpR']);
  // right paddle pulled to -60 (zigzag 119)
  const withPaddle = parseRideKeypad([0x23, 0x08, ...varint(idle), 0x1a, 0x04, 0x08, 0x01, 0x10, 119]);
  assert.deepEqual([...withPaddle], ['paddleR']);
  // small paddle drift is ignored
  assert.equal(parseRideKeypad([0x23, 0x08, ...varint(idle), 0x1a, 0x04, 0x08, 0x00, 0x10, 20]).size, 0);
  assert.equal(parseRideKeypad([0x19, 0x08, 0x50]), null);
});

import { parseObcButtons, obcIntents, obcAppInfo, OBC } from '../js/controls.js';

test('OpenBikeControl: parse, de-duplicate multi-action presses, press edges', () => {
  const prev = new Map();
  // "Plus" button sending Shift Up + Increase Difficulty + Select in one message
  const press = obcIntents(parseObcButtons([0x01, 0x01, 0x01, 0x30, 0x01, 0x14, 0x01]), prev);
  assert.deepEqual([...press], [['harder', true]]);
  // repeated "pressed" without release does not fire again
  assert.equal(obcIntents(parseObcButtons([0x01, 0x01, 0x01]), prev).size, 0);
  obcIntents(parseObcButtons([0x01, 0x01, 0x00, 0x30, 0x00, 0x14, 0x00]), prev);
  assert.deepEqual([...obcIntents(parseObcButtons([0x01, 0x01, 0x01]), prev)], [['harder', true]]);
  // direct gear selection: 0x02 = gear 1, 0x01 is a no-op
  assert.deepEqual([...obcIntents([{ id: OBC.GEAR_SET, value: 0x0c }], prev)], [['gear', 11]]);
  assert.equal(obcIntents([{ id: OBC.GEAR_SET, value: 0x01 }], prev).size, 0);
  // steering angle: 0x94 = +10°, 0x00 = unavailable
  assert.deepEqual([...obcIntents([{ id: OBC.STEERING_ANGLE, value: 0x94 }], prev)], [['steer', 10]]);
  assert.equal(obcIntents([{ id: OBC.STEERING_ANGLE, value: 0x00 }], prev).size, 0);
  assert.deepEqual(parseObcButtons([0x02, 0x01]), []);
});

test('OpenBikeControl app information message', () => {
  const msg = [...obcAppInfo('zwift', '1.52.0', [0x01, 0x02, 0x10, 0x14])];
  assert.deepEqual(msg, [0x04, 0x01, 0x05, ...Buffer.from('zwift'), 0x06, ...Buffer.from('1.52.0'), 0x04, 0x01, 0x02, 0x10, 0x14]);
});

import { convertSteps, eventToWorkout } from '../js/intervals.js';
import { stepWatts } from '../js/workouts.js';

test('intervals.icu workout_doc conversion', () => {
  const doc = [
    { duration: 600, power: { start: 50, end: 75, units: '%ftp' }, ramp: true, warmup: true },
    { reps: 3, text: '3x', steps: [
      { duration: 300, power: { value: 95, units: '%ftp' }, text: 'Тримай!' },
      { duration: 120, power: { value: 150, units: 'w' } },
    ] },
    { duration: 240, power: { min: 88, max: 94, units: '%ftp' } },
    { duration: 300, power: { value: 2, units: 'power_zone' } },
    { duration: 180, hr: { value: 80, units: '%lthr' } },
    { duration: 60, power: { start: 100, end: 200, units: 'w' } },
    { duration: 0, power: { value: 50 } },
  ];
  const s = convertSteps(doc);
  assert.equal(s.length, 1 + 6 + 4);
  assert.deepEqual(s[0], { dur: 600, power: 0.5, to: 0.75, text: '' });
  assert.equal(s[1].text, 'Тримай!');
  assert.equal(stepWatts(s[1], 0, 200), 190);
  assert.equal(stepWatts(s[2], 0.5, 200), 150);
  assert.equal(stepWatts(s[7], 0, 200), 182);       // midpoint of 88–94 %
  assert.equal(stepWatts(s[8], 0, 200), 130);       // Z2 ≈ 65 %
  assert.equal(stepWatts(s[9], 0, 200), null);      // HR target → free ride
  assert.equal(stepWatts(s[10], 0.5, 200), 150);    // watts ramp
  const w = eventToWorkout({ id: 42, name: 'Sweet spot', start_date_local: '2026-11-06T00:00:00', workout_doc: { steps: doc } });
  assert.equal(w.id, 'icu:42');
  assert.equal(w.eventId, 42);
  assert.equal(w.date, '2026-11-06');
});

import { THEMES } from '../js/themes.js';

test('10 routes, each with an existing theme and distinct name', () => {
  assert.equal(routes.length, 10);
  assert.equal(new Set(routes.map((r) => r.name)).size, 10);
  for (const r of routes) assert.ok(THEMES[r.theme], `${r.id} theme ${r.theme}`);
});
