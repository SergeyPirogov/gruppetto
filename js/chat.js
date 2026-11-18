// Chat (#85) and reactions (#86) in a group ride, over the ride's live channel (social.js groupLive). Nothing is
// stored: a message lives on the screens of those riding or watching at the time. This file is the pure part: what a
// message may say, how often anyone may send one, and the log on screen. The moderation is here too, on each screen:
// rude words masked, links dropped, a flood cut off, and anyone muted by a tap.

/** Phrases for a rider on the trainer, who cannot type: sent as an id, each screen shows it in its own language. */
export const QUICK = [
  { id: 'ok', text: '👍' },
  { id: 'wheel', text: 'On your wheel' },
  { id: 'wait', text: 'Wait for me' },
  { id: 'easy', text: 'Easy, let\'s regroup' },
  { id: 'go', text: 'Attack! 🚀' },
  { id: 'gg', text: 'Good ride! 🙌' },
];
/** The reactions a spectator sends to a rider. */
export const REACTS = ['👍', '🔥', '👏', '💪', '⚡'];
export const MAX_LEN = 140;

// the roots of the worst words (Ukrainian, Russian, English); a word with one in it shows as its first letter and ***
const RUDE = ['хуй', 'хуя', 'хує', 'хуе', 'хуї', 'хуи', 'пизд', 'пізд', 'бля', 'єба', 'еба', 'ёба', 'їба', 'ебл', 'ебу', 'єбу', 'їбу', 'ебан', 'сука', 'суки', 'сучк', 'мудак', 'мудил', 'підор', 'підар', 'пидор', 'пидар', 'гандон', 'залуп', 'шлюх', 'дроч',
  'fuck', 'shit', 'cunt', 'bitch', 'dick', 'pussy', 'whore', 'slut', 'nigg', 'fagg', 'asshole', 'bastard'];
// a letter written as a look-alike: Latin in a Cyrillic word, digits for letters
const LOOK = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', i: 'і', k: 'к', 3: 'з', 0: 'о', 6: 'б', '@': 'а' };
const fold = (w) => w.toLowerCase().replace(/[aeopcxyik306@]/g, (ch) => LOOK[ch] || ch);
const rude = (w) => { const a = w.toLowerCase(), b = fold(w); return RUDE.some((r) => a.includes(r) || b.includes(r)); };

/** A message as shown: one line, no control characters, links out, rude words masked, at most MAX_LEN. */
export function clean(text) {
  let s = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ');
  s = s.replace(/\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|ru|ua|io|me|ly|gg|xyz|site|link|top)(?:\/\S*)?/gi, '…');
  s = s.replace(/[\p{L}\p{N}@]+/gu, (w) => (w.length > 2 && rude(w) ? `${w[0]}***` : w));
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
}

/** Your side: at most one message a second and five in 15 s (the others' screens drop the rest anyway). */
export class SendGate {
  constructor() { this.at = []; }
  ok(now) {
    this.at = this.at.filter((t) => now - t < 15000);
    if (this.at.length >= 5 || (this.at.length && now - this.at.at(-1) < 1000)) return false;
    this.at.push(now);
    return true;
  }
}

const ID = /^[\w-]{1,64}$/;

/**
 * The messages on screen, newest last: [{ id, from, name, text, quick, at, me }]. Each sender is held to the same
 * pace as SendGate (a flood beyond it is dropped), and a muted sender is not shown.
 */
export class ChatLog {
  constructor(selfId, { keep = 40 } = {}) { this.self = selfId; this.keep = keep; this.items = []; this.pace = new Map(); this.muted = new Set(); this.n = 0; }

  /** A message heard on the channel ({ u, n, m } or { u, n, q }), or your own sent one: the entry shown, or null. */
  receive(p, now, { mine = false } = {}) {
    if (!p || typeof p.u !== 'string' || !ID.test(p.u)) return null;
    if (!mine && (p.u === this.self || this.muted.has(p.u))) return null;
    const quick = typeof p.q === 'string' ? QUICK.find((x) => x.id === p.q) : null;
    const text = quick ? quick.text : clean(p.m);
    if (!text) return null;
    if (!mine) {
      const g = this.pace.get(p.u) || new SendGate();
      this.pace.set(p.u, g);
      if (!g.ok(now)) return null;
    }
    // from the fans' channel (social.js groupLive): a spectator, shown as one, so no one there passes for a rider
    const e = { id: ++this.n, from: p.u, name: `${p.fan ? '👀 ' : ''}${clean(p.n).slice(0, 40) || '?'}`, fan: !!p.fan, text, quick: quick?.id || null, at: now, me: mine };
    this.items.push(e);
    if (this.items.length > this.keep) this.items.splice(0, this.items.length - this.keep);
    return e;
  }

  /** Hide a sender's messages, those shown and those to come (for this ride). */
  mute(id) { this.muted.add(id); this.items = this.items.filter((e) => e.from !== id); }

  /** The last `n` messages, those younger than `ms` (all of them with no `ms`). */
  recent(now, n = 5, ms = 0) { return this.items.filter((e) => !ms || now - e.at < ms).slice(-n); }
}

/** A reaction heard: { from, name, to, emoji } when it is fine (a known emoji, at most one a second per sender), else null. */
export class Reactions {
  constructor() { this.last = new Map(); }
  receive(p, now) {
    if (!p || typeof p.u !== 'string' || !ID.test(p.u) || typeof p.to !== 'string' || !ID.test(p.to)) return null;
    const emoji = REACTS[Number(p.e)];
    if (!emoji) return null;
    if (now - (this.last.get(p.u) ?? -Infinity) < 1000) return null;
    this.last.set(p.u, now);
    return { from: p.u, name: clean(p.n).slice(0, 40) || null, to: p.to, emoji };
  }
}

/** Who is watching: spectators say they are there every 10 s, and count for 25 s after. */
export class Watchers {
  constructor() { this.by = new Map(); }
  receive(p, now) { if (p && typeof p.u === 'string' && ID.test(p.u)) this.by.set(p.u, now); }
  count(now) { for (const [k, t] of this.by) if (now - t > 25000) this.by.delete(k); return this.by.size; }
}

/** A spectator without an account still needs an id on the channel: random, kept for the tab. */
export function guestId(store = globalThis.sessionStorage) {
  try {
    let id = store?.getItem('gruppetto.watchId');
    if (!id) { id = `g-${Math.random().toString(36).slice(2, 12)}`; store?.setItem('gruppetto.watchId', id); }
    return id;
  } catch { return `g-${Math.random().toString(36).slice(2, 12)}`; }
}
