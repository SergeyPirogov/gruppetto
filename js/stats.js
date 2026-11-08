// Anonymous usage stats (GoatCounter, no cookies): which features are used and where riders drop off, to decide
// what to build. Only the name of what happened and a coarse bucket (a ride's length, a device's kind) are
// sent: never a name, a key, a place or a number that tells one rider from another. Off in Profile, or when
// the browser asks not to be tracked; GoatCounter itself does not count localhost.

const ENDPOINT = 'https://serhii.goatcounter.com/count';
const SCRIPT = 'https://gc.zgo.at/count.js';

let on = false;
const queue = [];

/** Starts the stats when allowed: the page view, then the events. */
export function initStats(enabled) {
  on = !!enabled && navigator.doNotTrack !== '1' && window.doNotTrack !== '1';
  if (!on || document.querySelector('script[data-goatcounter]')) return;
  const s = document.createElement('script');
  s.async = true;
  s.src = SCRIPT;
  s.dataset.goatcounter = ENDPOINT;
  s.onload = () => { while (queue.length) send(queue.shift()); };
  document.head.appendChild(s);
}

/** Turns the stats off for this page (the setting keeps them off from then on). */
export function stopStats() { on = false; queue.length = 0; }

function send(e) {
  try { window.goatcounter?.count?.(e); } catch { /* stats never break the app */ }
}

/** An event: what happened (ride-finish), and a coarse detail (30-60 min). */
export function track(name, detail = '') {
  if (!on) return;
  const e = { path: detail ? `${name}/${detail}` : name, title: name, event: true };
  if (window.goatcounter?.count) send(e); else if (queue.length < 50) queue.push(e);
}

/** A ride's length as a bucket. */
export function minutesBucket(sec) {
  const m = sec / 60;
  return m < 5 ? '0-5 min' : m < 30 ? '5-30 min' : m < 60 ? '30-60 min' : m < 120 ? '60-120 min' : '120+ min';
}

/** The how-many-th ride, as a milestone (1, 2, 3, 5, 10, 20, 50, 100), '' between them: who comes back. */
export function rideMilestone(n) {
  return [1, 2, 3, 5, 10, 20, 50, 100].includes(n) ? String(n) : '';
}
