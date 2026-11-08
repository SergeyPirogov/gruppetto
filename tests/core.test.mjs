import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIndoorBikeData, parseCyclingPower, parseHeartRate, cadenceFromCrank, parseCSC, wahoo, parseRideKeypad } from '../js/ble.js';
import { steadySpeed, stepSpeed } from '../js/physics.js';
import { rideIntent } from '../js/controls.js';
import { routes } from '../js/routes.js';
import { workouts, targetAt, totalDuration } from '../js/workouts.js';
import { Recorder, normalizedPower, bestAverage } from '../js/recorder.js';
import { encodeChallenge, decodeChallenge, challengeIn } from '../js/challenge.js';
import { wPrimeSuggestion, rampFtp } from '../js/power.js';
import { addRide, progressFrom, levelOf, rideXp } from '../js/progress.js';
import { wbalStep, wbalSeries, timeToEmpty } from '../js/wbal.js';

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
      { duration: 300, power: { value: 95, units: '%ftp' }, text: 'Hold it!' },
      { duration: 120, power: { value: 150, units: 'w' } },
    ] },
    { duration: 240, power: { min: 88, max: 94, units: '%ftp' } },
    { duration: 300, power: { value: 2, units: 'power_zone' } },
    { duration: 180, hr: { value: 80, units: '%lthr' } },
    { duration: 60, power: { start: 100, end: 200, units: 'w' }, ramp: true },
    { duration: 1800, power: { start: 150, end: 158, units: 'w' } },
    { duration: 600, power: { start: 62, end: 65, units: '%ftp' } },
    { duration: 0, power: { value: 50 } },
  ];
  const s = convertSteps(doc);
  assert.equal(s.length, 1 + 6 + 6);
  assert.deepEqual(s[0], { dur: 600, power: 0.5, to: 0.75, text: '' });
  assert.equal(s[1].text, 'Hold it!');
  assert.equal(stepWatts(s[1], 0, 200), 190);
  assert.equal(stepWatts(s[2], 0.5, 200), 150);
  assert.equal(stepWatts(s[7], 0, 200), 182);       // midpoint of 88–94 %
  assert.equal(stepWatts(s[8], 0, 200), 130);       // Z2 ≈ 65 %
  assert.equal(stepWatts(s[9], 0, 200), null);      // HR target → free ride
  assert.equal(stepWatts(s[10], 0.5, 200), 150);    // watts ramp
  // a range (no ramp mark) is ridden at its middle, flat, and keeps its band for the chart
  assert.equal(stepWatts(s[11], 0, 200), 154);
  assert.equal(stepWatts(s[11], 1, 200), 154);
  assert.deepEqual(s[11].rangeW, [150, 158]);
  assert.equal(stepWatts(s[12], 0.9, 200), 127);   // 63.5 % of 200
  assert.deepEqual(s[12].range.map((x) => +x.toFixed(2)), [0.62, 0.65]);
  const w = eventToWorkout({ id: 42, name: 'Sweet spot', start_date_local: '2026-11-06T00:00:00', workout_doc: { steps: doc } });
  assert.equal(w.id, 'icu:42');
  assert.equal(w.eventId, 42);
  assert.equal(w.date, '2026-11-06');
});

import { THEMES } from '../js/themes.js';

test('12 routes, each with an existing theme and distinct name', () => {
  assert.equal(routes.length, 12);
  assert.equal(new Set(routes.map((r) => r.name)).size, 12);
  for (const r of routes) assert.ok(THEMES[r.theme], `${r.id} theme ${r.theme}`);
});

import { GEAR_RATIOS, virtualWheelMm, gearGradeOffset, ratioOf } from '../js/gears.js';

test('Virtual gears for Zwift Cog', () => {
  assert.equal(GEAR_RATIOS.length, 24);
  for (let i = 1; i < 24; i++) assert.ok(GEAR_RATIOS[i] > GEAR_RATIOS[i - 1]);
  // gear whose ratio equals the physical 34/14 gives the real wheel size
  assert.equal(virtualWheelMm(12, 34), Math.round(2096 * 2.40 / (34 / 14)));
  // harder gear => bigger virtual wheel => more speed and resistance at the same cadence
  assert.ok(virtualWheelMm(20, 34) > virtualWheelMm(12, 34));
  assert.ok(virtualWheelMm(1, 50) >= 300 && virtualWheelMm(24, 34) <= 6500);
  assert.equal(gearGradeOffset(12), 0);
  assert.ok(gearGradeOffset(24) > 0 && gearGradeOffset(1) < 0);
  assert.equal(ratioOf(99), 5.49);
  assert.deepEqual(wahoo.wheelCircumference(2096), [0x48, 0xe0, 0x51]); // 20960
});

import { Sampler } from '../js/sampler.js';

test('Per-second averaging of sensor samples', () => {
  const s = new Sampler(3000);
  s.add(100, 200); s.add(350, 300); s.add(600, 250); s.add(850, 250);
  assert.equal(s.mean(0, 1000), 250);          // average, not the last snapshot
  assert.equal(s.mean(1000, 2000), 250);       // no new samples: fresh latest value
  assert.equal(s.mean(4000, 5000), 0);         // stale after 3 s without data
  s.add(5200, 400);
  assert.equal(s.mean(5000, 6000), 400);
  assert.ok(s.has(5000, 6000) && !s.has(2000, 4000));
});

import { Decoder, Stream } from '@garmin/fitsdk';

test('FIT export decodes with the official Garmin SDK as a virtual ride', () => {
  const rec = new Recorder();
  for (let i = 0; i < 600; i++) {
    if (i === 300) rec.markLap();
    rec.add({
      power: i < 300 ? 200 : 300, cadence: 90, heartRate: 130 + (i % 10), speed: 9 + (i % 3),
      distance: i * 9.5, altitude: 100 + i * 0.05, elevationGain: i * 0.05,
    });
  }
  rec.startTime = new Date('2026-11-06T10:00:00Z');
  const bytes = rec.toFIT();
  const stream = Stream.fromByteArray(Array.from(bytes));
  assert.ok(Decoder.isFIT(stream));
  const decoder = new Decoder(stream);
  assert.ok(decoder.checkIntegrity(), 'CRC and header are valid');
  const { messages, errors } = decoder.read();
  assert.deepEqual(errors, []);
  assert.equal(messages.fileIdMesgs[0].type, 'activity');
  assert.equal(messages.recordMesgs.length, 600);
  const r = messages.recordMesgs[450];
  assert.equal(r.power, 300);
  assert.equal(r.cadence, 90);
  assert.equal(r.heartRate, 130);
  assert.equal(Math.round(r.distance * 10) / 10, 4275);
  assert.equal(r.timestamp.toISOString(), '2026-11-06T10:07:30.000Z');
  const s = messages.sessionMesgs[0];
  assert.equal(s.sport, 'cycling');
  assert.equal(s.subSport, 'virtualActivity');
  assert.equal(s.avgPower, 250);
  assert.equal(s.maxPower, 300);
  assert.equal(s.totalTimerTime, 600);
  assert.equal(s.numLaps, 2);
  assert.ok(s.normalizedPower >= 260 && s.normalizedPower <= 268, `NP ${s.normalizedPower}`); // (0.5·200⁴ + 0.5·300⁴)^¼ ≈ 264
  assert.equal(s.totalWork, 150000);
  assert.equal(messages.lapMesgs.length, 2);
  assert.equal(messages.lapMesgs[0].avgPower, 200);
  assert.equal(messages.lapMesgs[1].avgPower, 300);
  assert.equal(messages.lapMesgs[1].totalTimerTime, 300);
  assert.equal(messages.activityMesgs[0].numSessions, 1);
});

test('FIT export omits HR and cadence when no sensor provided them', () => {
  const rec = new Recorder();
  for (let i = 0; i < 60; i++) rec.add({ power: 150, cadence: 0, heartRate: 0, speed: 8, distance: i * 8, altitude: 100, elevationGain: 0 });
  const { messages, errors } = new Decoder(Stream.fromByteArray(Array.from(rec.toFIT()))).read();
  assert.deepEqual(errors, []);
  assert.equal(messages.recordMesgs[10].heartRate, undefined);
  assert.equal(messages.recordMesgs[10].cadence, undefined);
  assert.equal(messages.sessionMesgs[0].avgPower, 150);
});

import { IntervalsClient } from '../js/intervals.js';

test('intervals.icu planned workouts: filters other sports, keeps unstructured rides as free rides', async () => {
  const client = new IntervalsClient({ apiKey: 'k' });
  client.request = async () => [
    { id: 1, type: 'Ride', name: 'SS', start_date_local: '2026-11-08T00:00:00', workout_doc: { steps: [{ duration: 600, power: { value: 90, units: '%ftp' } }] } },
    { id: 2, type: 'Run', name: 'Run', start_date_local: '2026-11-07T00:00:00', workout_doc: { steps: [{ duration: 600 }] } },
    { id: 3, type: 'VirtualRide', name: 'Z2 1h', start_date_local: '2026-11-07T00:00:00', moving_time: 3600 },
  ];
  const list = await client.plannedWorkouts('2026-11-06', '2026-11-12');
  assert.deepEqual(list.map((w) => w.eventId), [3, 1]); // sorted by date
  assert.deepEqual(list.stats, { total: 3, otherSport: 1, unstructured: 1 });
  assert.deepEqual(list[0].steps, [{ dur: 3600, free: true, text: 'Z2 1h' }]);
});

test('low power starts the bike from standstill on a climb', () => {
  // KICKR CORE at an easy spin: ~30 W on a 3 % grade used to leave the rider stuck at 0 km/h
  let v = 0;
  for (let i = 0; i < 100; i++) v = stepSpeed(v, 31, 0.032, 0.1, 75);
  assert.ok(v * 3.6 > 2, `expected the rider to move, got ${(v * 3.6).toFixed(1)} km/h`);
});

test('Zwift Ride: shift buttons by direction, paddles change lane', async () => {
  for (const b of ['shiftUpR', 'shiftUpL', 'up']) assert.equal(rideIntent(b), 'harder');
  for (const b of ['shiftDownR', 'shiftDownL', 'down']) assert.equal(rideIntent(b), 'easier');
  assert.equal(rideIntent('paddleL'), 'left');
  assert.equal(rideIntent('paddleR'), 'right');
  assert.equal(rideIntent('left'), 'bigEasier');
  assert.equal(rideIntent('right'), 'bigHarder');
  assert.equal(rideIntent('a'), 'toggleErg');
  assert.equal(rideIntent('b'), 'togglePause');
  assert.equal(rideIntent('z'), 'skip');
  assert.equal(rideIntent('y'), 'camera');
  assert.equal(rideIntent('powerUpL'), 'pacer');
  assert.equal(rideIntent('powerUpR'), 'hud');
  assert.equal(rideIntent('onOffL'), null); // the controller's own power button
});

import { spokenDuration } from '../js/sound.js';

test('Spoken durations in English', () => {
  assert.equal(spokenDuration(180), '3 minutes');
  assert.equal(spokenDuration(300), '5 minutes');
  assert.equal(spokenDuration(60), '1 minute');
  assert.equal(spokenDuration(45), '45 seconds');
  assert.equal(spokenDuration(21), '21 seconds');
  assert.equal(spokenDuration(90), '1 minute 30 seconds');
});

test('intervals.icu cadence targets', () => {
  const s = convertSteps([
    { duration: 60, power: { value: 90, units: '%ftp' }, cadence: { value: 95, units: 'rpm' } },
    { duration: 60, power: { value: 60, units: '%ftp' }, cadence: { min: 85, max: 90, units: 'rpm' } },
    { duration: 60, power: { value: 60, units: '%ftp' } },
  ]);
  assert.deepEqual(s[0].cad, [92, 98]);
  assert.deepEqual(s[1].cad, [85, 90]);
  assert.equal(s[2].cad, undefined);
});

test('drafting saves most drag right on the wheel and none far back or off to the side', async () => {
  const { draftFactor } = await import('../js/physics.js');
  assert.ok(draftFactor(2.0, 0) > 0.3);                                  // on the wheel (centres 2 m apart)
  assert.ok(draftFactor(4, 0) > 0 && draftFactor(4, 0) < draftFactor(2, 0));
  assert.equal(draftFactor(6, 0), 0);
  assert.equal(draftFactor(2, 1.2), 0);
  assert.equal(draftFactor(0.8, 0), 0);                                   // overlapping wheels: no such thing
  assert.equal(draftFactor(-1, 0), 0);
});

test('Polissia Lakes: 20 km with about 30 m of climbing and nothing steep', () => {
  const r = routes.find((x) => x.id === 'lakes');
  assert.equal(r.length, 20000);
  assert.ok(Math.abs(r.elevationGain - 30) < 3, `gain ${r.elevationGain}`);
  for (let d = 0; d < r.length; d += 50) assert.ok(Math.abs(r.gradeAt(d)) < 0.012);
});

test('air drag grows with height and weight; 178 cm 75 kg is the reference 0.32 m²', async () => {
  const { riderCdA } = await import('../js/physics.js');
  assert.ok(Math.abs(riderCdA(178, 75) - 0.32) < 0.002);
  assert.ok(riderCdA(190, 90) > riderCdA(178, 75));
  assert.ok(riderCdA(165, 58) < riderCdA(178, 75));
});

test('GPX track: point-to-point route with smoothed elevation, bends and a finish', async () => {
  const { routeFromTrack } = await import('../js/gpx.js');
  const { Route } = await import('../js/routes.js');
  // 3 km due north climbing 90 m with GPS jitter, then a 90° right turn and 1 km flat
  const pts = [];
  const lat0 = 48.45, lon0 = 24.55, m = 1 / 111320;
  for (let d = 0; d <= 3000; d += 10) pts.push({ lat: lat0 + d * m, lon: lon0, ele: 500 + d * 0.03 + (d % 20 ? 1.5 : -1.5) });
  for (let d = 10; d <= 1000; d += 10) pts.push({ lat: lat0 + 3000 * m, lon: lon0 + d / 73900, ele: 590 });
  const def = routeFromTrack({ name: 'Test', points: pts });
  const r = new Route(JSON.parse(JSON.stringify(def))); // as stored on the device
  assert.ok(r.oneWay && r.custom);
  assert.ok(Math.abs(r.length - 4000) < 30, `length ${r.length}`);
  assert.ok(Math.abs(r.gradeAt(1500) - 0.03) < 0.004, `grade ${r.gradeAt(1500)}`); // jitter smoothed away
  assert.ok(Math.abs(r.elevationGain - 90) < 6, `gain ${r.elevationGain}`);
  // a right turn of about 90° in total, turning the same way as the renderer's +curve (TURN = 2.5)
  const turn = r.segments.reduce((s, x) => s + (x.curve * 2.5) / 5, 0);
  assert.ok(Math.abs(turn - Math.PI / 2) < 0.15, `turn ${turn}`);
  // past either end the road runs on, flat
  assert.equal(r.elevAt(-100), r.elevAt(0));
  assert.equal(r.elevAt(r.length + 500), r.segments[r.segments.length - 1].elev);
  assert.equal(r.climbs.length, 1);
  assert.throws(() => routeFromTrack({ name: '', points: pts.slice(0, 50) }), /shorter than 1 km/);
});

test('route groups: flat, hilly and mountain', () => {
  const g = Object.fromEntries(routes.map((r) => [r.id, r.group]));
  assert.equal(g.lakes, 'flat');
  assert.equal(g.rolling, 'hilly');
  assert.equal(g.mountain, 'mountain');
});

test('drafting reaches the trainer: a lower wind coefficient in road simulation (FTMS and Wahoo)', async () => {
  const { Trainer, WIND_CW } = await import('../js/ble.js');
  const ftms = new Trainer();
  const sent = [];
  Object.assign(ftms, { controllable: true, protocol: 'ftms', _command: (b) => { sent.push(b); return Promise.resolve(true); } });
  await ftms.setSimulation(3.5);
  await ftms.setSimulation(3.5, { cw: Math.round(WIND_CW * (1 - 0.33) * 100) / 100 });
  assert.equal(sent[0][6], 51); // cw in 0.01 kg/m
  assert.equal(sent[1][6], 34); // a third less wind on a wheel
  assert.equal(sent[1][3] | (sent[1][4] << 8), 350); // the grade is untouched

  const w = new Trainer();
  const writes = [];
  Object.assign(w, { controllable: true, protocol: 'wahoo', riderWeight: 83, _write: (b) => { writes.push(b); return Promise.resolve(); } });
  await w.setSimulation(2);            // sim mode set up once, then the grade
  await w.setSimulation(2.5);          // same wind: only the grade
  await w.setSimulation(2.5, { cw: 0.34 }); // drafting: sim mode again with the new wind, then the grade
  const ops = writes.map((b) => b[0].toString(16));
  assert.deepEqual(ops, ['43', '46', '46', '43', '46']);
  assert.equal(writes[3][5] | (writes[3][6] << 8), 340); // cw in 0.001 kg/m
});

test('terrain model: Terrarium tiles sampled along a track, bridge dips removed (#25 step 2)', async () => {
  const { loadTerrain, tileXY, decodeTerrarium } = await import('../js/dem.js');
  const { routeFromTrack } = await import('../js/gpx.js');
  const { Route } = await import('../js/routes.js');
  // Terrarium: 500 m -> R·256 + G + B/256 - 32768
  const v = 500 + 32768, px = new Uint8ClampedArray(256 * 256 * 4);
  for (let i = 0; i < 256 * 256; i++) { px[i * 4] = Math.floor(v / 256); px[i * 4 + 1] = v % 256; px[i * 4 + 2] = 128; }
  assert.ok(Math.abs(decodeTerrarium(px)[0] - 500.5) < 1e-6);

  // synthetic terrain: rises 30 m per km northward, with a 25 m deep, 60 m wide valley under a bridge at 2 km
  const m = 1 / 111320, lat0 = 48.45, lon0 = 24.55;
  const truth = (lat) => { const d = (lat - lat0) / m; return 400 + d * 0.03 - (Math.abs(d - 2000) < 30 ? 25 : 0); };
  const loader = async (z, x, y) => {
    const t = new Float32Array(256 * 256);
    for (let j = 0; j < 256; j++) {
      const n = 2 ** z, lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (j + 0.5) / 256)) / n))) * 180 / Math.PI;
      t.fill(truth(lat), j * 256, j * 256 + 256);
    }
    return t;
  };
  const pts = [];
  for (let d = 0; d <= 4000; d += 400) pts.push({ lat: lat0 + d * m, lon: lon0, ele: null }); // a sparse planner track, no elevation
  let calls = 0;
  const dem = await loadTerrain(pts, { loader: (...a) => { calls++; return loader(...a); } });
  assert.ok(calls >= 1 && calls < 10, `tiles ${calls}`);
  assert.ok(Math.abs(dem(lat0 + 1000 * m, lon0) - truth(lat0 + 1000 * m)) < 0.5);
  assert.ok(tileXY(lat0, lon0).x > 0);

  const def = routeFromTrack({ name: 'Climb', points: pts }, '', { elevation: dem });
  assert.equal(def.elevSource, 'terrain');
  const r = new Route(def);
  assert.ok(Math.abs(r.gradeAt(1000) - 0.03) < 0.003, `grade ${r.gradeAt(1000)}`); // between the sparse points too
  const dip = (r.elevAt(1700) + r.elevAt(2300)) / 2 - r.elevAt(2000);
  assert.ok(Math.abs(dip) < 2, `dip at the bridge ${dip}`); // not the valley's 25 m
  assert.ok(Math.abs(r.gradeAt(2000)) < 0.06, `bridge grade ${r.gradeAt(2000)}`);
  assert.ok(r.elevationGain < 130, `gain ${r.elevationGain}`); // ~120 m, not 120 + 2×25
});

test('OSM scenery: woods, water and buildings laid out relative to the road (#25 step 3)', async () => {
  const { routeFromTrack } = await import('../js/gpx.js');
  const { OFFSETS, LAND_STEP, overpassQuery } = await import('../js/osm.js');
  const m = 1 / 111320, lat0 = 48.45, lon0 = 24.55, mx = 1 / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const at = (north, east) => ({ lat: lat0 + north * m, lon: lon0 + east * mx });
  const box = (n0, n1, e0, e1) => [at(n0, e0), at(n0, e1), at(n1, e1), at(n1, e0), at(n0, e0)];
  const pts = [];
  for (let d = 0; d <= 3000; d += 50) pts.push({ ...at(d, 0), ele: 300 });
  const osm = { elements: [
    { type: 'way', tags: { landuse: 'forest' }, geometry: box(500, 2500, 10, 400) },          // right of the road (east)
    { type: 'relation', tags: { natural: 'water' }, members: [                               // left: a lake in two pieces
      { type: 'way', role: 'outer', geometry: [at(500, -10), at(500, -400), at(2500, -400)] },
      { type: 'way', role: 'outer', geometry: [at(2500, -400), at(2500, -10), at(500, -10)] },
    ] },
    { type: 'way', tags: { building: 'house' }, geometry: box(1495, 1505, 35, 47) },           // a house 41 m to the right
  ] };
  const def = routeFromTrack({ name: 't', points: pts }, '', { osm });
  const row = (d) => def.land.slice(Math.round(d / LAND_STEP) * OFFSETS.length, Math.round(d / LAND_STEP + 1) * OFFSETS.length);
  const at1500 = row(1500);
  OFFSETS.forEach((o, i) => assert.equal(at1500[i], o > 0 ? 'f' : 'w', `offset ${o}: ${at1500}`));
  assert.equal(row(100), '.'.repeat(OFFSETS.length)); // open land before the wood and the lake
  assert.equal(def.buildings.length, 1);
  const [d, off] = def.buildings[0];
  assert.ok(Math.abs(d - 1500) < 15 && Math.abs(off - 41) < 3, `building at ${d} m, ${off} m`);
  const q = overpassQuery([[48.45, 24.55], [48.46, 24.56]]);
  assert.match(q, /way\["landuse"="forest"\]\(48\.44,24\.52,48\.48,24\.56\)/); // the box the road runs through
  assert.match(q, /way\["building"\]\(around:150,48\.45000,24\.55000\);way\["building"\]\(around:150,48\.46000,24\.56000\);/);
});

test('a GPX track that ends where it began becomes a loop, closed smoothly', async () => {
  const { routeFromTrack } = await import('../js/gpx.js');
  const { Route } = await import('../js/routes.js');
  const m = 1 / 111320, lat0 = 50.36, lon0 = 30.46, mx = 1 / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const at = (n, e, ele) => ({ lat: lat0 + n * m, lon: lon0 + e * mx, ele });
  const pts = [];
  // a 1 km square, climbing 20 m on the way out and back down, ending 120 m short of the start
  for (let d = 0; d <= 1000; d += 50) pts.push(at(d, 0, 150 + d * 0.02));
  for (let d = 50; d <= 1000; d += 50) pts.push(at(1000, d, 170));
  for (let d = 950; d >= 0; d -= 50) pts.push(at(d, 1000, 150 + d * 0.02));
  for (let d = 950; d >= 120; d -= 50) pts.push(at(0, d, 150));
  const r = new Route(JSON.parse(JSON.stringify(routeFromTrack({ name: 'Square', points: pts }))));
  assert.equal(r.oneWay, false);
  assert.ok(Math.abs(r.length - 4000) < 120, `length ${r.length}`);
  assert.ok(Math.abs(r.elevAt(r.length - 5) - r.elevAt(0)) < 0.5, `seam ${r.elevAt(r.length - 5)} vs ${r.elevAt(0)}`);
  assert.ok(Math.abs(r.gradeAt(r.length)) < 0.02, `grade across the start line ${r.gradeAt(r.length)}`);
  // and a track that ends far from its start stays point to point
  const out = new Route(routeFromTrack({ name: 'Out', points: pts.slice(0, 40) }));
  assert.equal(out.oneWay, true);
});

test('after the ride: intervals as ridden and time in zones (#9)', async () => {
  const { rideIntervals, timeInZones, HR_ZONES } = await import('../js/analysis.js');
  const s = [];
  for (let i = 0; i < 10; i++) s.push({ step: 0, target: 100, power: 100, heartRate: 120, cadence: 90 });
  for (let i = 0; i < 10; i++) s.push({ step: 1, target: 200, power: 170, heartRate: 150, cadence: 0 });
  for (let i = 0; i < 5; i++) s.push({ step: null, target: null, power: 150 });
  const rows = rideIntervals(s, (i) => (i === 1 ? [190, 210] : null));
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].dur, rows[0].power, rows[0].ok, rows[0].cad], [10, 100, true, 90]);
  assert.deepEqual([rows[1].power, rows[1].diff, rows[1].ok, rows[1].lo, rows[1].cad], [170, -30, false, 190, 0]);
  const z = timeInZones([100, 160, 260, 0], 200, undefined, 5);
  assert.deepEqual(z.slice(0, 5).map((x) => x.sec), [10, 0, 5, 0, 0]); // 0 W and 100 W in Z1, 160 W (80 %) in Z3
  assert.equal(z[5].sec, 5); // 260 W = 130 % of FTP: Z6, anaerobic
});

test('sprint segments: flat, straight, clear of climbs and of each other (#38)', async () => {
  const { routes } = await import('../js/routes.js');
  for (const r of routes) {
    const L = r.length;
    if (L < 3000) { assert.equal(r.sprints.length, 0); continue; }
    assert.ok(r.sprints.length >= 1 && r.sprints.length <= 4, `${r.id}: ${r.sprints.length} sprints`);
    for (const s of r.sprints) {
      assert.equal(s.length, 250);
      assert.ok(Math.abs(r.elevAt(s.start + 250) - r.elevAt(s.start)) / 250 <= 0.015, `${r.id} ${s.name} is not flat`);
      for (const c of r.climbs) assert.ok(s.start + 250 <= c.start - 150 || s.start >= c.start + c.length + 150 || c.start + c.length > L, `${r.id} ${s.name} touches ${c.name}`);
    }
    for (let i = 1; i < r.sprints.length; i++) assert.ok(r.sprints[i].start - r.sprints[i - 1].start >= 1500);
  }
});

test('intervals.icu upload: a planned workout that cannot be paired (422) still uploads the ride, unpaired', async () => {
  const { IntervalsClient } = await import('../js/intervals.js');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.searchParams.get('paired_event_id'));
    if (u.searchParams.get('paired_event_id')) return new Response('{"error":"Event not found"}', { status: 422 });
    return new Response(JSON.stringify({ id: 'i77', activities: [{ id: 'i77' }] }), { status: 200 });
  };
  try {
    const c = new IntervalsClient({ apiKey: 'test', athleteId: 'i1' });
    const id = await c.uploadActivity(new Uint8Array([1, 2, 3]), { name: 'x', description: 'y', eventId: 99 });
    assert.equal(id, 'i77');
    assert.deepEqual(calls, ['99', null]);
    // any other error is not retried, and says what the server said
    globalThis.fetch = async () => new Response('Bad file', { status: 400 });
    await assert.rejects(c.uploadActivity(new Uint8Array([1]), { name: 'x', eventId: 5 }), /error 400: Bad file/);
  } finally { globalThis.fetch = realFetch; }
});

test('.zwo workouts: read Zwift files and write them back (#28)', async () => {
  const { parseZwo, toZwo } = await import('../js/zwo.js');
  const zwo = `<workout_file><author>X</author><name>Over &amp; Under</name><description>Hard one</description><sportType>bike</sportType>
  <workout>
    <Warmup Duration="600" PowerLow="0.40" PowerHigh="0.75"/>
    <SteadyState Duration="300" Power="0.88" Cadence="95">
      <textevent timeoffset="10" message="settle in"/>
    </SteadyState>
    <IntervalsT Repeat="3" OnDuration="60" OffDuration="120" OnPower="1.2" OffPower="0.55" Cadence="100" CadenceResting="85"/>
    <FreeRide Duration="180"/>
    <Cooldown Duration="300" PowerLow="0.65" PowerHigh="0.4"/>
  </workout></workout_file>`;
  const w = parseZwo(zwo);
  assert.equal(w.name, 'Over & Under');
  assert.equal(w.steps.length, 1 + 1 + 6 + 1 + 1);
  assert.deepEqual(w.steps[0], { dur: 600, power: 0.4, to: 0.75 });
  assert.deepEqual(w.steps[1], { dur: 300, power: 0.88, cad: [92, 98] });
  assert.deepEqual(w.steps[2], { dur: 60, power: 1.2, cad: [97, 103] });
  assert.deepEqual(w.steps[3], { dur: 120, power: 0.55, cad: [82, 88] });
  assert.equal(w.steps[8].free, true);
  assert.deepEqual(w.steps[9], { dur: 300, power: 0.65, to: 0.4 });
  // back out and in again: the same steps
  const again = parseZwo(toZwo(w));
  assert.deepEqual(again.steps.map((s) => [s.dur, s.power, s.to, !!s.free]), w.steps.map((s) => [s.dur, s.power, s.to, !!s.free]));
  assert.match(toZwo(w), /<IntervalsT Repeat="3" OnDuration="60" OffDuration="120" OnPower="1.2" OffPower="0.55"/);
  assert.throws(() => parseZwo('<html></html>'), /Not a Zwift workout/);
});

test('power curve and FTP suggestion (#34, #35)', async () => {
  const { bestsFromSamples, bestsFromChart, powerCurve, ftpSuggestion } = await import('../js/power.js');
  // 30 min: 200 W with 5 min at 300 W and a 10 s burst at 600 W
  const p = Array(1800).fill(200);
  for (let i = 600; i < 900; i++) p[i] = 300;
  for (let i = 100; i < 110; i++) p[i] = 600;
  const b = bestsFromSamples(p);
  assert.equal(b[5], 600);
  assert.equal(b[300], 300);
  assert.equal(b[1200], Math.round((300 * 300 + 600 * 10 + 200 * 890) / 1200)); // 20 min from 0:01:40: the burst and the 5 min
  assert.equal(b[3600], undefined);
  const chart = []; for (let i = 0; i < p.length; i += 5) chart.push(p.slice(i, i + 5).reduce((a, x) => a + x, 0) / 5);
  assert.equal(bestsFromChart(chart, 5)[300], 300);
  const now = Date.parse('2026-11-08T12:00:00Z');
  const rides = [
    { id: 'a', date: '2026-11-01T10:00:00Z', bests: b },
    { id: 'b', date: '2026-05-01T10:00:00Z', bests: { 1200: 260 } }, // half a year ago
  ];
  assert.equal(powerCurve(rides, { now })[1200].w, 260);
  assert.equal(powerCurve(rides, { days: 42, now })[1200].w, b[1200]);
  const s = ftpSuggestion(rides, 200, { now });
  assert.equal(s.ftp, Math.round(b[1200] * 0.95)); // only the recent ride counts
  assert.equal(ftpSuggestion(rides, 230, { now }), null); // already above
});

test('fitness, fatigue and form (#54)', async () => {
  const { fitnessSeries, formBand } = await import('../js/power.js');
  const now = Date.parse('2026-11-08T20:00:00');
  // 4 weeks of 60 TSS a day, then 10 rest days
  const rides = [];
  for (let i = 37; i >= 10; i--) rides.push({ date: new Date(now - i * 864e5).toISOString(), tss: 60 });
  const s = fitnessSeries(rides, { now });
  const last = s[s.length - 1];
  assert.ok(last.ctl > 18 && last.ctl < 28, `ctl ${last.ctl}`);    // 28 days at 60: ≈ 29, then 10 days of rest
  assert.ok(last.atl < last.ctl, 'fatigue drops faster than fitness after rest');
  assert.ok(last.form > 0, 'rested: positive form');
  const busy = s.find((p) => p.date === new Date(now - 15 * 864e5).toISOString().slice(0, 10));
  assert.ok(busy.form < 0, 'in the middle of the block: negative form');
  assert.equal(formBand(-20), 'optimal');
  assert.equal(formBand(10), 'fresh');
  assert.deepEqual(fitnessSeries([], { now }), []);
});

test('heart rate zones: from intervals.icu in bpm, else from LTHR', async () => {
  const { hrZonesBpm, timeInZones } = await import('../js/analysis.js');
  assert.equal(hrZonesBpm({}), null);
  const icu = hrZonesBpm({ bpm: [137, 151, 158, 169, 174, 179, 186], names: ['Recovery'] });
  assert.equal(icu.length, 7);
  assert.equal(icu[0].name, 'Recovery');
  assert.equal(icu[6].upTo, Infinity);
  assert.deepEqual(timeInZones([130, 150, 160, 190], 1, icu).map((z) => z.sec), [1, 1, 0, 1, 0, 0, 1]);
  const l = hrZonesBpm({ lthr: 170 });
  assert.equal(l.length, 5);
  assert.deepEqual(timeInZones([100, 150, 165, 175, 185], 1, l).map((z) => z.sec), [1, 0, 1, 2, 1]); // tops 117 / 143 / 161.5 / 180.2 bpm
});

test('wind: headwind slows you, tailwind speeds you up, the trainer feels it as grade (#50)', async () => {
  const { steadySpeed, windComponents, windGrade, draftFactor } = await import('../js/physics.js');
  const still = steadySpeed(200, 0, 75), head = steadySpeed(200, 0, 75, { wind: 6 }), tail = steadySpeed(200, 0, 75, { wind: -6 });
  assert.ok(head < still - 1.5 && tail > still + 1.5, `${head} ${still} ${tail}`);
  // blowing the way you ride is a tailwind; from straight ahead a headwind; from the side all cross
  const w = (toward) => windComponents(5, toward, 0);
  assert.ok(Math.abs(w(0).head + 5) < 1e-9 && Math.abs(w(Math.PI).head - 5) < 1e-9);
  assert.ok(Math.abs(w(Math.PI / 2).cross - 5) < 1e-9 && Math.abs(w(Math.PI / 2).head) < 1e-9);
  // 6 m/s in your face at 30 km/h on 0.32 m²: about +3.3 % of grade (27 N more drag)
  const g = windGrade(8.33, 6, 0.32, 75);
  assert.ok(g > 0.028 && g < 0.038, String(g));
  assert.ok(windGrade(8.33, -6, 0.32, 75) < 0);
  // crosswind: the shelter moves to the lee side of the wheel
  assert.ok(draftFactor(2, -0.6, 6) > draftFactor(2, 0, 6));
});

import { encodeActivity } from '../js/fit.js';
test('FIT: a last lap under a minute joins the lap before', () => {
  const samples = Array.from({ length: 200 }, () => ({ power: 150, cadence: 90, heartRate: 130, speed: 8, distance: 0, altitude: 100 }));
  // count lap messages (global 19) by walking the records
  const laps = (lapStarts) => {
    const d = new Uint8Array(encodeActivity(samples, { start: new Date(0), lapStarts })), dv = new DataView(d.buffer);
    let p = d[0], end = d[0] + dv.getUint32(4, true), count = 0; const defs = {};
    while (p < end) {
      const h = d[p++], lt = h & 15;
      if (h & 0x40) { const g = dv.getUint16(p + 2, d[p + 1] === 0), nf = d[p + 4]; let size = 0; for (let i = 0; i < nf; i++) size += d[p + 5 + i * 3 + 1]; defs[lt] = { g, size }; p += 5 + nf * 3; }
      else { if (defs[lt].g === 19) count++; p += defs[lt].size; }
    }
    return count;
  };
  assert.equal(laps([0, 100, 170]), 2); // 30 s tail: merged
  assert.equal(laps([0, 100]), 2);
  assert.equal(laps([0, 100, 130]), 3); // 70 s: a lap of its own
});

test('W′bal: drains joule for joule above FTP, refills below it, warns how long is left', () => {
  const cp = 250, wp = 20000;
  // 60 s at 350 W: 100 W over, 6 kJ gone
  const bal = wbalSeries(Array(60).fill(350), cp, wp).at(-1);
  assert.equal(bal, 14000);
  // at 450 W the 14 kJ left last 70 s
  assert.equal(timeToEmpty(bal, 450, cp), 70);
  assert.equal(timeToEmpty(bal, 200, cp), Infinity);
  // below FTP it comes back, faster when emptier and further below; never above full nor below empty
  const back = wbalStep(bal, 150, cp, wp);
  assert.ok(back > bal && back - bal === (wp - bal) * (100 / wp));
  assert.ok(wbalStep(wbalStep(1000, 0, cp, wp), 0, cp, wp) - wbalStep(1000, 0, cp, wp) < wbalStep(1000, 0, cp, wp) - 1000);
  assert.equal(wbalStep(wp, 100, cp, wp), wp);
  assert.equal(wbalStep(500, 900, cp, wp), 0);
  // 5 s chunks of a history chart: the same drain
  assert.equal(wbalSeries([350, 350], cp, wp, 5).at(-1), 19000);
});

test('Challenge link: a ride packs into the address and comes back as a ghost', async () => {
  const d = Array.from({ length: 720 }, (_, i) => (i + 1) * 41.3), pw = d.map((_, i) => 180 + (i % 50));
  const e = { routeId: 'rolling', date: '2026-11-08T10:00:00Z', summary: { duration: 3600, distance: 29736 }, chart: { every: 5, d, pw } };
  const code = await encodeChallenge(e, 'Serhii');
  assert.match(code, /^[\w-]+$/);
  assert.ok(code.length < 4000, `an hour's ride fits a link: ${code.length}`);
  assert.equal(challengeIn(`#challenge=${code}`), code);
  assert.equal(challengeIn('#other'), '');
  const g = await decodeChallenge(code);
  assert.equal(g.friend, true); assert.equal(g.name, 'Serhii'); assert.equal(g.routeId, 'rolling');
  assert.deepEqual(g.chart.pw, pw);
  assert.ok(g.chart.d.every((x, i) => Math.abs(x - d[i]) <= 1), 'distance within a metre');
  assert.equal(await decodeChallenge('not-a-ride'), null);
});

test('FTP test and W′ from rides: 75 % of the ramp minute; W′ through the best 5 and 20 minutes', () => {
  assert.equal(rampFtp(320), 240);
  const now = Date.parse('2026-11-08T12:00:00Z');
  const ride = (b) => ({ date: '2026-11-01T10:00:00Z', bests: b });
  // 300 W for 5 min, 250 W for 20: W′ = (300 − 250) · 400 = 20 kJ, CP 233 W
  const s = wPrimeSuggestion([ride({ 300: 300, 1200: 250 })], 15, { now });
  assert.deepEqual(s, { kj: 20, cp: 233, p5: 300, p20: 250 });
  assert.equal(wPrimeSuggestion([ride({ 300: 300, 1200: 250 })], 20, { now }), null, 'the same as now');
  assert.equal(wPrimeSuggestion([ride({ 300: 260, 1200: 258 })], 20, { now }), null, 'implausibly small');
  assert.equal(wPrimeSuggestion([ride({ 300: 300 })], 20, { now }), null, 'no 20 minutes');
  assert.equal(wPrimeSuggestion([{ ...ride({ 300: 300, 1200: 250 }), date: '2026-01-01T10:00:00Z' }], 15, { now }), null, 'too old');
});

test('Levels and badges: XP for every ride once, levels a little longer each, badges for firsts, totals and habits', () => {
  const r = (id, date, km, gain, min, extra = {}) => ({ id, date, summary: { distance: km * 1000, elevationGain: gain, duration: min * 60 }, ...extra });
  assert.equal(rideXp(r('a', '2026-11-01', 30, 300, 60)), 300 + 300 + 60);
  assert.deepEqual([levelOf(0).level, levelOf(499).level, levelOf(500).level, levelOf(1500).level], [1, 1, 2, 3]);
  let { progress: p, badges, levelUp } = addRide(undefined, r('a', '2026-11-01T10:00:00Z', 30, 300, 60));
  assert.deepEqual(badges.map((b) => b.id), ['first', 'hour']);
  assert.equal(levelUp, true);
  assert.equal(addRide(p, r('a', '2026-11-01T10:00:00Z', 30, 300, 60)).progress.rides, 1, 'a ride counts once');
  ({ progress: p } = addRide(p, r('b', '2026-11-02T10:00:00Z', 40, 100, 70)));
  const third = addRide(p, r('c', '2026-11-03T10:00:00Z', 40, 100, 70, { ramp: true }));
  assert.deepEqual(third.badges.map((b) => b.id), ['km100', 'streak3', 'ramp']);
  // from a history kept before: the same totals, oldest first
  const h = progressFrom([r('c', '2026-11-03T10:00:00Z', 40, 100, 70, { ramp: true }), r('b', '2026-11-02T10:00:00Z', 40, 100, 70), r('a', '2026-11-01T10:00:00Z', 30, 300, 60)]);
  assert.equal(h.km, 110); assert.equal(h.rides, 3); assert.ok(h.badges.streak3 && h.badges.ramp);
});

test('intervals.icu history: the power curve at our durations, all time and 42 days; form by day', async () => {
  const { IntervalsClient } = await import('../js/intervals.js');
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = String(url).includes('/power-curves')
      ? { list: [{ id: 'all', secs: [1, 5, 60, 1200], values: [900, 850, 420, 265] }, { id: '42d', secs: [5, 60, 1200], values: [800, 400, 250] }] }
      : [{ id: '2026-11-07', ctl: 52.4, atl: 60.1 }, { id: '2026-11-06', ctl: 52, atl: 58 }, { id: 'bad', ctl: 1, atl: 1 }];
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const c = new IntervalsClient({ apiKey: 'k' });
  assert.deepEqual(await c.powerCurves([5, 60, 300, 1200]), { all: { 5: 850, 60: 420, 1200: 265 }, recent: { 5: 800, 60: 400, 1200: 250 } });
  assert.match(calls[0], /\/power-curves\?type=Ride&curves=all%2C42d/);
  assert.deepEqual(await c.fitness('2026-08-09', '2026-11-07'), [{ date: '2026-11-06', ctl: 52, atl: 58 }, { date: '2026-11-07', ctl: 52.4, atl: 60.1 }]);
  assert.match(calls[1], /\/wellness\?oldest=2026-08-09&newest=2026-11-07/);
});

test('Usage stats: nothing without consent or with Do Not Track; events only as a name and a coarse bucket', async () => {
  const added = [], sent = [];
  globalThis.window = {}; globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild: (s) => added.push(s) } };
  Object.defineProperty(globalThis, 'navigator', { value: { doNotTrack: '0' }, configurable: true });
  const { initStats, track, minutesBucket, rideMilestone, stopStats } = await import('../js/stats.js');
  initStats(false); track('ride-finish');
  assert.equal(added.length, 0, 'off: no script');
  navigator.doNotTrack = '1'; initStats(true);
  assert.equal(added.length, 0, 'Do Not Track: no script');
  navigator.doNotTrack = '0'; initStats(true);
  assert.equal(added[0].dataset.goatcounter, 'https://grupetto.goatcounter.com/count');
  track('ride-finish', minutesBucket(2700)); // queued until the script is in
  window.goatcounter = { count: (e) => sent.push(e) }; added[0].onload();
  track('ride-count', rideMilestone(3));
  assert.deepEqual(sent.map((e) => e.path), ['ride-finish/30-60 min', 'ride-count/3']);
  assert.ok(sent.every((e) => e.event === true));
  stopStats(); track('x'); assert.equal(sent.length, 2, 'stopped');
  assert.equal(rideMilestone(4), '');
  delete globalThis.window; delete globalThis.document;
});

test('intervals.icu: the planned workouts already ridden are the events the day\'s activities are paired with', async () => {
  const { IntervalsClient } = await import('../js/intervals.js');
  let asked = '';
  globalThis.fetch = async (url) => { asked = String(url); return new Response(JSON.stringify([{ id: 'i1', paired_event_id: 4242 }, { id: 'i2', paired_event_id: null }, { id: 'i3' }]), { status: 200 }); };
  const done = await new IntervalsClient({ apiKey: 'k' }).doneEventIds('2026-11-08', '2026-11-08');
  assert.deepEqual([...done], ['4242']);
  assert.match(asked, /\/activities\?oldest=2026-11-08&newest=2026-11-08/);
});

test('Time of day by the sun where you are: Kyiv in November is night at 17:30, in June broad day; the phases follow', async () => {
  const { sunAt, phaseOf, placeFromZone, phasesOfDay } = await import('../js/sun.js');
  const kyiv = placeFromZone('Europe/Kyiv');
  assert.equal(phaseOf(sunAt(new Date('2026-11-08T10:30:00Z'), kyiv)), 'midday');  // 12:30
  assert.equal(phaseOf(sunAt(new Date('2026-11-08T15:30:00Z'), kyiv)), 'night');   // 17:30
  assert.equal(phaseOf(sunAt(new Date('2026-06-21T14:30:00Z'), kyiv)), 'midday');  // 17:30 in summer
  assert.equal(phaseOf(sunAt(new Date('2026-06-21T17:00:00Z'), kyiv)), 'evening'); // 20:00, the golden hour
  assert.equal(phaseOf(sunAt(new Date('2026-06-21T02:30:00Z'), kyiv)), 'morning'); // 5:30
  // sunset in Kyiv on 8 November is about 16:20 local (14:20 UTC): the sun near the horizon then
  assert.ok(Math.abs(sunAt(new Date('2026-11-08T14:20:00Z'), kyiv).elevation) < 2);
  const p = phasesOfDay(new Date('2026-11-08T12:00:00Z'), kyiv);
  assert.ok(p.morning && p.midday && p.evening && p.night && p.morning < p.midday && p.midday < p.evening && p.evening < p.night);
  assert.equal(placeFromZone('Mars/Base', new Date('2026-01-15')).lat, 45);
});

test('Short pauses: runs of 3 s and more without power, how many and how long', async () => {
  const { stopsOf } = await import('../js/power.js');
  const p = [200, 200, 0, 0, 200, 0, 0, 0, 0, 210, 220, 0, 0, 0];
  assert.deepEqual(stopsOf(p), { n: 2, sec: 7 }); // the 2 s gap is no pause; 4 s and the last 3 s are
  assert.deepEqual(stopsOf([180, 0, 190, 0], 5), { n: 2, sec: 10 }); // a 5 s chart: each empty point is 5 s
  assert.deepEqual(stopsOf([150, 160]), { n: 0, sec: 0 });
});

test('Shelter in a bunch: deeper behind a line of riders, a little for the one in front, never more than half', async () => {
  const { packDraft, draftFactor } = await import('../js/physics.js');
  const one = packDraft([{ gap: 2, sideways: 0 }]);
  assert.equal(one, draftFactor(2, 0));                                           // a single wheel: as before
  const line = packDraft([{ gap: 2, sideways: 0 }, { gap: 6, sideways: 0 }, { gap: 10, sideways: 0.3 }]);
  assert.ok(line > one + 0.08 && line <= 0.5, `a line of three: ${line}`);
  assert.equal(packDraft([{ gap: 6, sideways: 0 }, { gap: 10, sideways: 0 }]), 0); // no wheel close: no bunch shelter
  const pushed = packDraft([{ gap: -2.1, sideways: 0 }]);
  assert.ok(pushed > 0.03 && pushed <= 0.04, `the one in front: ${pushed}`);
  assert.equal(packDraft([{ gap: -4, sideways: 0 }]), 0);                         // too far behind
  assert.ok(packDraft(Array.from({ length: 12 }, (_, i) => ({ gap: 2 + i * 2, sideways: 0 }))) <= 0.5);
});
