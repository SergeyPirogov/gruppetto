import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadGrid, lateralReach, onOtherRoad, roadGap, isOwnStretch } from '../js/road-grid.js';

const HALF = 3.6, FAR = 300;

/** A route out along z = 0 and back along z = gap (the same street twice), a point every 2.5 m. */
function outAndBack(gap, len = 1000, rise = 0) {
  const grid = new RoadGrid(20), pts = [];
  for (let s = 0; s <= len; s += 2.5) { pts.push({ x: s, z: 0, y: 10, s, dx: 0, dz: 1 }); }
  for (let s = 0; s <= len; s += 2.5) { pts.push({ x: len - s, z: gap, y: 10 + rise, s: len + 40 + s, dx: 0, dz: -1 }); }
  for (const p of pts) grid.add(p.x, p.z, p.y, p.s);
  return { grid, pts };
}

test('roadGap goes the short way round a loop', () => {
  assert.equal(roadGap(10, 990, 1000), 20);
  assert.equal(roadGap(10, 990), 980);
});

test('a place on the same stretch is not another stretch, the far leg of a hairpin is', () => {
  assert.equal(isOwnStretch(100, 130, 30), true);
  assert.equal(isOwnStretch(100, 700, 12), false);
});

const reach = (grid, p, dz) => lateralReach(grid, { x: p.x, z: p.z, dx: 0, dz, s: p.s, far: FAR, min: HALF + 2 });

test('out and back 4 m apart: the land of one pass never reaches past the road width towards the other', () => {
  const { grid, pts } = outAndBack(4);
  let checked = 0;
  for (const p of pts.filter((q) => q.x > 100 && q.x < 900 && q.dz === 1)) {
    const r = reach(grid, p, 1); // the side that faces the other pass (+z)
    assert.equal(r.reach, HALF + 2, 'held at the road width: the other road is right there');
    assert.equal(r.y, 10);
    assert.equal(reach(grid, p, -1).reach, FAR); // the side facing away is free
    checked++;
  }
  assert.ok(checked > 100);
});

test('out and back 30 m apart: each pass meets the other halfway, so the two lands leave no gap', () => {
  const { grid, pts } = outAndBack(30);
  const p = pts.find((q) => q.x === 500 && q.dz === 1), q = pts.find((u) => u.x === 500 && u.dz === -1);
  const there = reach(grid, p, 1), back = reach(grid, q, -1);
  assert.ok(Math.abs(there.reach - 15) < 3 && Math.abs(back.reach - 15) < 3, `${there.reach} ${back.reach}`);
});

test('the other road is 6 m higher: the land learns its height', () => {
  const { grid, pts } = outAndBack(20, 1000, 6);
  assert.equal(reach(grid, pts.find((q) => q.x === 500 && q.dz === 1), 1).y, 16);
});

test('no prop of one pass stands in the road corridor of the other', () => {
  const { grid, pts } = outAndBack(4);
  const skipOwn = (sOwn, at) => (s, d, qx, qz) => isOwnStretch(sOwn, s, Math.hypot(qx - at.x, qz - at.z));
  // what the renderer places beside the first pass (fence posts at 4.25 m, grass at 6 m, a tree at 9 m), every 10 m;
  // those standing on the other pass's asphalt (z = 4, half width 3.6, plus the prop's own half size) must be found
  let onRoad = 0, found = 0;
  for (const p of pts.filter((q) => q.dz === 1 && q.x > 100 && q.x < 900 && q.x % 10 === 0)) {
    for (const [o, half] of [[4.25, 0.1], [6, 0.3], [9, 4]]) {
      const x = p.x, z = p.z + o;
      const truly = Math.abs(z - 4) < HALF + 0.6 + half;
      const hit = onOtherRoad(grid.nearest(x, z, 14, skipOwn(p.s, p)), half, HALF);
      if (truly) { onRoad++; if (hit) found++; }
      assert.equal(hit, truly, `prop at offset ${o} x=${x}`);
    }
  }
  assert.ok(onRoad > 100 && found === onRoad);
});
