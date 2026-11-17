import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rideWindow, packet, Mates, OPENS_BEFORE, LIVE_FOR, STALE } from '../js/group.js';

const T = Date.UTC(2026, 10, 20, 17, 0); // a group ride at 19:00 Kyiv time

test('group ride: shut until 10 minutes before, open at the line, live for two hours, then over', () => {
  assert.equal(rideWindow(T, T - OPENS_BEFORE * 1000 - 1).state, 'later');
  assert.equal(rideWindow(T, T - 60e3).state, 'open');
  assert.equal(rideWindow(T, T - 60e3).in, 60);
  assert.equal(rideWindow(T, T).state, 'live');
  assert.equal(rideWindow(T, T + 90e3).since, 90);
  assert.equal(rideWindow(T, T + LIVE_FOR * 1000).state, 'over');
});

test('group ride: a packet carries who and where in a few rounded numbers', () => {
  const p = packet({ id: 'u1', name: 'Olena', dist: 1234.567, v: 9.8765, lane: 1.234, wkg: 3.14159, look: { jersey: '#ff0000', stripe: '#00ff00', bike: null, figure: 'female' } }, 5000);
  assert.deepEqual(p, { u: 'u1', n: 'Olena', d: 1234.6, v: 9.88, l: 1.23, w: 3.1, j: '#ff0000', s: '#00ff00', b: null, f: 'female', t: 5000 });
});

test('group ride: a rider heard from rides on at their speed between packets, smoothly', () => {
  const m = new Mates('me');
  m.receive({ u: 'u1', n: 'Olena', d: 100, v: 10, l: 1, w: 3, j: '#f00', s: '#0f0', b: null, f: 'female', t: 0 }, 0);
  const [a] = m.list(0);
  assert.equal(a.dist, 100);
  assert.equal(a.name, 'Olena');
  assert.equal(a.figure, 'female');
  assert.equal(a.color, '#f00');
  const [b] = m.list(1000); // 1 s on, at 10 m/s
  assert.ok(Math.abs(b.dist - 110) < 1e-6, String(b.dist));
  // the next packet a little behind where it was guessed: no jump back, eased toward it
  m.receive({ u: 'u1', n: 'Olena', d: 108, v: 10, l: 1, w: 3, j: '#f00', s: '#0f0', b: null, f: 'female', t: 1000 }, 1000);
  const [c] = m.list(1100);
  assert.ok(c.dist > 108 && c.dist < 111, String(c.dist));
});

test('group ride: yourself is not a mate; a silent rider goes; a far jump snaps', () => {
  const m = new Mates('me');
  m.receive({ u: 'me', n: 'Me', d: 0, v: 0, l: 0, t: 0 }, 0);
  assert.equal(m.list(0).length, 0);
  m.receive({ u: 'u2', n: 'Taras', d: 50, v: 8, l: 0, t: 0 }, 0);
  assert.equal(m.list(STALE * 1000 - 1).length, 1);
  assert.equal(m.list(STALE * 1000 + 1).length, 0);
  m.receive({ u: 'u2', n: 'Taras', d: 50, v: 8, l: 0, t: 0 }, 10000);
  m.list(10000);
  m.receive({ u: 'u2', n: 'Taras', d: 900, v: 8, l: 0, t: 0 }, 10500); // rode on alone while the tab slept
  assert.equal(m.list(10500)[0].dist, 900);
});

test('group ride: a packet that is not one is dropped', () => {
  const m = new Mates('me');
  for (const p of [null, {}, { u: 'x' }, { u: 'x', d: 'far' }, { u: 'x', d: 1e9, v: 1 }, { u: 'x', d: 10, v: -3 }, { u: 'x'.repeat(80), d: 1, v: 1 }]) m.receive(p, 0);
  assert.equal(m.list(0).length, 0);
});

test('a race: the finish time goes in the packet and stays after the rider has gone', () => {
  assert.equal(packet({ id: 'a', name: 'A', dist: 1, v: 1, lane: 0 }, 0).x, undefined);
  assert.equal(packet({ id: 'a', name: 'A', dist: 1, v: 1, lane: 0, finish: 1234.56 }, 0).x, 1234.6);
  const m = new Mates('me');
  m.receive({ u: 'b', n: 'Bo', d: 10, v: 9, l: 0, j: '#ff0000' }, 0);
  assert.deepEqual(m.finished(), []);
  m.receive({ u: 'b', n: 'Bo', d: 12000, v: 9, l: 0, j: '#ff0000', x: 1500 }, 1000);
  m.receive({ u: 'b', n: 'Bo', d: 12009, v: 9, l: 0, j: '#ff0000', x: 1400 }, 2000); // the first one stands
  m.receive({ u: 'c', n: 'Cy', d: 0, v: 0, l: 0, x: 'soon' }, 2000); // not a time
  m.list(60000); // long gone from the road
  assert.deepEqual(m.finished(), [{ id: 'b', name: 'Bo', color: '#ff0000', stripe: '#e2e8f0', wkg: 0, finish: 1500 }]);
});
