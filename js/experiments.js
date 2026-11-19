// A/B tests: every visitor gets one variant of an experiment, kept in this browser, so the app looks the
// same to them from one visit to the next. A rider's own choice (a setting) always wins over the draw.
//
// To test a variant on real riders, give it a weight above 0 below; the stats then count rides by
// variant (track('exp', 'hud-b')), so the two can be compared. A weight of 0 keeps a variant to the
// riders who pick it themselves.

export const EXPERIMENTS = {
  // the ride's dashboard: a = boards in the corners, b = every number in one strip at the bottom
  hud: { variants: ['a', 'b'], weights: [1, 0] },
  // the ride summary: a = the cards in a column, b = the story of the ride first: place, time, gap, records
  summary: { variants: ['a', 'b'], weights: [1, 0] },
};

const KEY = 'gruppetto.exp';

/** Picks a variant by weight; `r` is a number in [0, 1). */
export function pick(variants, weights, r) {
  const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (!(total > 0)) return variants[0];
  let x = r * total;
  for (let i = 0; i < variants.length; i++) {
    x -= Math.max(0, weights[i] || 0);
    if (x < 0) return variants[i];
  }
  return variants[variants.length - 1];
}

function load(storage) {
  try { return JSON.parse(storage?.getItem(KEY) || '{}') || {}; } catch { return {}; }
}

/**
 * The variant of `name` for this visitor: `chosen` (the rider's setting) when it is one of the
 * variants, else the one drawn before, else a new draw that is kept.
 */
export function variant(name, { chosen = '', storage = globalThis.localStorage, rand = Math.random, experiments = EXPERIMENTS } = {}) {
  const exp = experiments[name];
  if (!exp) return '';
  if (exp.variants.includes(chosen)) return chosen;
  const kept = load(storage);
  if (exp.variants.includes(kept[name])) return kept[name];
  const v = pick(exp.variants, exp.weights, rand());
  kept[name] = v;
  try { storage?.setItem(KEY, JSON.stringify(kept)); } catch { /* private mode: drawn again next visit */ }
  return v;
}
