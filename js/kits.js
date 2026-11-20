// Jersey patterns (#33, #46): drawn over the jersey in the accent colour by the kit shader (rider-model.js),
// and the leader's jerseys in their own colours. A few are open to everyone; the rest are earned by riding:
// a level, or winning the jersey in a race against the bots. Colours stay free for everyone.

/**
 * id, the shader's number, the name, and how it is earned:
 * - free: open to all;  - level: from that level;  - jersey: won in a race ('yellow' | 'green' | 'polka').
 * fixed: colours of its own, whatever the rider picked ({ main, pattern, accent }).
 */
export const PATTERNS = [
  { id: 'plain', n: 0, name: 'Plain', free: true },
  { id: 'band', n: 1, name: 'Chest band', free: true },
  { id: 'ukraine', n: 8, name: 'Blue and yellow', free: true, fixed: { main: '#0057b7', pattern: '#ffd500', accent: '#0057b7' } },
  { id: 'hoops', n: 2, name: 'Hoops', level: 2 },
  { id: 'pinstripes', n: 3, name: 'Pinstripes', level: 3 },
  { id: 'sash', n: 4, name: 'Sash', level: 4 },
  { id: 'chevron', n: 5, name: 'Chevron', level: 5 },
  { id: 'split', n: 6, name: 'Two halves', level: 6 },
  { id: 'fade', n: 7, name: 'Fade', level: 8 },
  { id: 'yellow', n: 10, name: 'Yellow jersey', jersey: 'yellow', fixed: { main: '#ffd400', pattern: '#ffd400', accent: '#1a1a1a' } },
  { id: 'green', n: 10, name: 'Green jersey', jersey: 'green', fixed: { main: '#17a34a', pattern: '#17a34a', accent: '#f5f5f5' } },
  { id: 'polka', n: 9, name: 'Polka-dot jersey', jersey: 'polka', fixed: { main: '#f7f7f7', pattern: '#d7192a', accent: '#d7192a' } },
];

export const patternOf = (id) => PATTERNS.find((p) => p.id === id) || PATTERNS[0];

/** Is the pattern open to this rider: level (from the progress' XP) and the jerseys won (progress.jerseys). */
export function patternOpen(p, { level = 1, jerseys = {} } = {}) {
  if (p.free) return true;
  if (p.level) return level >= p.level;
  if (p.jersey) return !!jerseys[p.jersey];
  return false;
}

/** How a locked pattern is earned, in English (the app translates it). */
export function patternHow(p) {
  if (p.level) return { text: 'From level {n}', n: p.level };
  if (p.jersey === 'yellow') return { text: 'Win a race against the bots' };
  if (p.jersey === 'green') return { text: 'Win the sprints in a race' };
  if (p.jersey === 'polka') return { text: 'Win the climbs in a race' };
  return { text: '' };
}

/**
 * What the kit shader takes for a rider: the pattern's number, and the colours (the rider's own, unless the
 * pattern has its own). A pattern not open to the rider is drawn plain: a setting from another device or an
 * account with more rides never shows a locked pattern here.
 */
export function kitLook(id, { jersey, stripe }, open = () => true) {
  const p = patternOf(id);
  if (!open(p)) return { n: 0, main: jersey, pattern: stripe, accent: stripe };
  const f = p.fixed;
  return { n: p.n, main: f?.main || jersey, pattern: f?.pattern || stripe, accent: f?.accent || stripe };
}

/** A pattern for a bot, from its seat in the bunch: most plain, some a free or level pattern, never a leader's. */
export function botPattern(i) {
  const pool = ['plain', 'plain', 'band', 'hoops', 'plain', 'pinstripes', 'sash', 'plain', 'chevron', 'split', 'fade'];
  return pool[((i * 7) + 3) % pool.length];
}

/**
 * The leader's jerseys a race gave you: yellow for the win, green for the most sprints won, polka dots for the
 * most climbs won (first over the top, at least one, and more than any one bot). `place` 1-based;
 * `tops`: { [climb or sprint id + lap]: { kind: 'climb' | 'sprint', me: bool, who: rider key } }.
 */
export function jerseysWon(place, tops = {}) {
  const won = [];
  if (place === 1) won.push('yellow');
  for (const [kind, id] of [['sprint', 'green'], ['climb', 'polka']]) {
    const count = new Map();
    for (const t of Object.values(tops)) if (t.kind === kind) count.set(t.who, (count.get(t.who) || 0) + 1);
    const mine = count.get('me') || 0;
    if (mine > 0 && [...count].every(([who, n]) => who === 'me' || n < mine)) won.push(id);
  }
  return won;
}
