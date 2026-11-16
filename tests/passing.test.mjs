import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLane, PASS_AFTER } from '../js/passing.js';

// The race bunch rides two abreast (lines 0.3 and 1.5). You sit on a wheel in the right-hand line, held back
// long past PASS_AFTER, with a rider of the other line right beside you and the left of the road clear
// (a race on Riverside at 300 W, measured: stuck there 32 s).
const bunch = () => {
  const me = { me: true, dist: 373.7, lane: 0.3, laneTarget: 0.3, v: 9.8, vFree: 10.2, heldFor: PASS_AFTER + 9 };
  const others = [
    me,
    { name: 'wheel', dist: 375.9, lane: 0.3, laneTarget: 0.3, v: 9.75 },
    { name: 'beside', dist: 374.5, lane: 1.5, laneTarget: 1.5, v: 9.76 },
    { name: 'beside ahead', dist: 376.7, lane: 1.5, laneTarget: 1.5, v: 9.72 },
    { name: 'behind', dist: 371.6, lane: 0.3, laneTarget: 0.3, v: 9.76 },
  ];
  return { me, others };
};

test('passing: held on a wheel with a rider beside you, you pull out to the clear side', () => {
  const { me, others } = bunch();
  assert.equal(pickLane(me, others, 0.8), 0.3 - 0.95);
});

test('passing: both sides taken, you stay on the wheel', () => {
  const { me, others } = bunch();
  // the clear side taken too: someone alongside on the left as well
  others.push({ name: 'beside left', dist: 373.9, lane: -0.9, laneTarget: -0.9, v: 9.8 });
  assert.equal(pickLane(me, others, 0.8), 0.3);
});

test('passing: alongside the wheel you are passing, you finish the pass instead of tucking back in', () => {
  const { me, others } = bunch();
  me.lane = me.laneTarget = 0.3 - 0.95;
  me.dist = 375.4; // half a wheel behind the one being passed
  assert.equal(pickLane(me, others, 0.8), 0.3 - 0.95);
});

// Free riding on a road where you keep right (home lane +1.2): on a wheel, held back, a centimetre to its right
// (measured: 1.61 behind 1.60, and every pass went out to the verge at 2.55).
const onWheel = (meLane, wheelLane, extra = {}) => {
  const me = { me: true, dist: 100, lane: meLane, laneTarget: meLane, v: 8, vFree: 8.4, heldFor: PASS_AFTER + 1, ...extra };
  return { me, others: [me, { name: 'wheel', dist: 102.1, lane: wheelLane, laneTarget: wheelLane, v: 8 }] };
};

test('passing: a centimetre off the wheel does not pick the side; the pass goes out toward the road\'s centre', () => {
  const { me, others } = onWheel(1.61, 1.6);
  assert.equal(pickLane(me, others, 1.2), 1.6 - 0.95);
});

test('passing: on the left half of the road the centre is to the right', () => {
  const { me, others } = onWheel(-1.61, -1.6);
  assert.equal(pickLane(me, others, -1.2), -1.6 + 0.95);
});

test('passing: already well out to one side, you pass on that side', () => {
  const { me, others } = onWheel(2.0, 1.6);
  assert.equal(pickLane(me, others, 1.2), 1.6 + 0.95);
});

test('passing: coming up much faster, you swing out early instead of sitting in first', () => {
  const me = { me: true, dist: 100, lane: 1.2, laneTarget: 1.2, v: 10, vFree: 10, heldFor: 0 };
  const others = [me, { name: 'slow', dist: 114, lane: 1.2, laneTarget: 1.2, v: 7.5 }];
  assert.equal(pickLane(me, others, 1.2), 1.2 - 0.95);
});

test('passing: coming up only a little faster, you tuck in behind first', () => {
  const me = { me: true, dist: 100, lane: 1.0, laneTarget: 1.0, v: 8.3, vFree: 8.3, heldFor: 0 };
  const others = [me, { name: 'wheel', dist: 106, lane: 1.2, laneTarget: 1.2, v: 8 }];
  assert.equal(pickLane(me, others, 1.0), 1.2);
});

test('passing: each rider has its own patience on a wheel', () => {
  const quick = onWheel(1.6, 1.6, { heldFor: 2.2, passAfter: 2 });
  assert.equal(pickLane(quick.me, quick.others, 1.2), 1.6 - 0.95);
  const patient = onWheel(1.6, 1.6, { heldFor: 2.2 });
  assert.equal(pickLane(patient.me, patient.others, 1.2), 1.6);
});
