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
