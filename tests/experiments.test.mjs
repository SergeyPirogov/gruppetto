import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pick, variant } from '../js/experiments.js';

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
const exps = { hud: { variants: ['a', 'b'], weights: [1, 1] }, off: { variants: ['a', 'b'], weights: [1, 0] } };

test('pick: by weight, a zero weight never drawn', () => {
  assert.equal(pick(['a', 'b'], [1, 1], 0.2), 'a');
  assert.equal(pick(['a', 'b'], [1, 1], 0.7), 'b');
  assert.equal(pick(['a', 'b'], [1, 0], 0.99), 'a');
  assert.equal(pick(['a', 'b'], [0, 0], 0.5), 'a'); // no weights: the first
});

test('variant: drawn once and kept for this browser', () => {
  const storage = memory();
  assert.equal(variant('hud', { storage, rand: () => 0.9, experiments: exps }), 'b');
  assert.equal(variant('hud', { storage, rand: () => 0.1, experiments: exps }), 'b'); // the kept one, not a new draw
});

test('variant: the rider’s choice wins; an unknown choice falls back to the draw', () => {
  const storage = memory();
  assert.equal(variant('off', { chosen: 'b', storage, experiments: exps }), 'b');
  assert.equal(variant('off', { chosen: 'auto', storage, rand: () => 0.99, experiments: exps }), 'a');
  assert.equal(variant('nope', { storage, experiments: exps }), '');
});

test('variant: storage that throws still gives a variant', () => {
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(variant('hud', { storage, rand: () => 0.1, experiments: exps }), 'a');
});
