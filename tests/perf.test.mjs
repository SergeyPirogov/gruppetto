import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerfLog, quantile } from '../js/perf.js';

test('a steady 60 fps ride: 10 s windows, no stutters', () => {
  const L = new PerfLog();
  for (let i = 1; i <= 60 * 25; i++) L.frame(i / 60, 1000 / 60, 4, 0, 0, { km: 1 });
  assert.equal(L.windows.length, 2);
  assert.equal(Math.round(L.windows[0].fps), 60);
  assert.equal(L.windows[0].long, 0);
  assert.equal(L.summary().under30, 0);
});

test('stutters and the road built in a window are counted', () => {
  const L = new PerfLog();
  let t = 0;
  for (let i = 0; i < 600; i++) { const gap = i % 100 === 50 ? 120 : 16; t += gap / 1000; L.frame(t, gap, 3, i % 100 === 50 ? 90 : 0, i % 100 === 50 ? 1 : 0); }
  const w = L.windows[0];
  assert.equal(w.worst, 120);
  assert.ok(w.long >= 5);
  assert.ok(w.builds >= 5 && w.build >= 450);
  assert.match(L.report({ gpu: 'Test GPU' }), /^gpu: Test GPU\nfps median/);
});

test('a tab in the background is not a frame', () => {
  const L = new PerfLog();
  L.frame(0.016, 16); L.frame(30, 29000);
  assert.equal(L.frames, 1);
});

test('quantile', () => { assert.equal(quantile([5, 1, 3], 0.5), 3); assert.equal(quantile([], 0.5), 0); });
