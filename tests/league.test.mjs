import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POINTS, leaguePoints, splitRaces, placed } from '../js/league.js';

test('league points: 25 for the winner, down to 1 for 15th, nothing after or for nonsense', () => {
  assert.equal(leaguePoints(1), 25);
  assert.equal(leaguePoints(2), 20);
  assert.equal(leaguePoints(15), 1);
  assert.equal(leaguePoints(16), 0);
  assert.equal(leaguePoints(0), 0);
  assert.equal(leaguePoints(1.5), 0);
  assert.equal(POINTS.length, 15);
  for (let i = 1; i < POINTS.length; i++) assert.ok(POINTS[i] < POINTS[i - 1]);
});

test('league races: split at now into ridden and to come', () => {
  const now = Date.UTC(2026, 10, 20, 17);
  const races = [
    { id: 'a', starts_at: new Date(now - 3600e3).toISOString() },
    { id: 'b', starts_at: new Date(now).toISOString() },
    { id: 'c', starts_at: new Date(now + 60e3).toISOString() },
  ];
  const { done, next } = splitRaces(races, now);
  assert.deepEqual(done.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(next.map((r) => r.id), ['c']);
  assert.deepEqual(splitRaces(null, now), { done: [], next: [] });
});

test('league standings: equal points share a place', () => {
  const rows = placed([{ points: 45 }, { points: 25 }, { points: 25 }, { points: 20 }]);
  assert.deepEqual(rows.map((r) => r.place), [1, 2, 2, 4]);
});
