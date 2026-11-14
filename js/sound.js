// Interval cues: short beeps (Web Audio) and spoken prompts (speech synthesis, in the interface language).
import { lang, plural } from './i18n.js';

let ctx = null;

/** Must be called from a user gesture (e.g. the start button) before sounds can play. */
export function unlockAudio() {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { ctx = null; }
}

/** Sound can play: the browser lets a page start audio only after a click or a key press on it. */
export const audioReady = () => !!ctx && ctx.state === 'running';
// the first click or key anywhere opens the sound (a ride started without one, like the demo, was silent)
if (typeof window !== 'undefined') {
  const wake = () => { unlockAudio(); if (audioReady()) { window.removeEventListener('pointerdown', wake, true); window.removeEventListener('keydown', wake, true); } };
  window.addEventListener('pointerdown', wake, true);
  window.addEventListener('keydown', wake, true);
}

export function beep(freq = 880, dur = 0.12, vol = 0.18) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export function say(text) {
  if (!text || typeof speechSynthesis === 'undefined') return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === 'uk' ? 'uk-UA' : 'en-US';
  const voice = speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith(lang));
  if (voice) u.voice = voice;
  u.rate = 1.05;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/** "3 minutes", "45 seconds", "1 minute 30 seconds" */
export function spokenDuration(sec) {
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  const words = lang === 'uk'
    ? { minute: ['хвилина', 'хвилини', 'хвилин'], second: ['секунда', 'секунди', 'секунд'] }
    : { minute: ['minute', 'minutes', 'minutes'], second: ['second', 'seconds', 'seconds'] };
  const say = (n, w) => `${n} ${lang === 'uk' ? plural(n, words[w]) : words[w][n === 1 ? 0 : 1]}`;
  if (!m) return say(s, 'second');
  if (!s) return say(m, 'minute');
  return `${say(m, 'minute')} ${say(s, 'second')}`;
}


// ---------- The fans at the top of a climb (#45) ----------
// Recorded, not made up (BigSoundBank, CC0): the murmur of an outdoor crowd, shouts of "Yeah!" from
// either side, and a horn, an air horn or a rattle now and then (no applause: it sounded like creaking). `level` 0…1: how close the crowd is.
let crowdBufs = null, crowdLoading = false, crowdBus = null, bedUntil = 0, lastShout = 0, lastNoise = 0, busLevel = -1, busAt = 0;
async function loadCrowd() {
  crowdLoading = true;
  const get = async (f) => ctx.decodeAudioData(await (await fetch(`assets/sounds/${f}`)).arrayBuffer());
  try {
    const [murmur, y1, y2, horn, air, rattle] = await Promise.all(['crowd-murmur.m4a', 'crowd-yeah-1.mp3', 'crowd-yeah-2.mp3', 'crowd-horn.mp3', 'crowd-airhorn.mp3', 'crowd-rattle.mp3'].map(get));
    crowdBufs = { murmur, shouts: [y1, y2], noise: [horn, air, rattle] };
  } catch { crowdBufs = null; }
}
export function crowd(level) {
  if (!ctx) return;
  if (!crowdBufs) { if (level > 0 && !crowdLoading) loadCrowd(); return; }
  const t = ctx.currentTime;
  if (!crowdBus) {
    // a gentle low-pass takes the hiss off the top of the recording
    const soft = ctx.createBiquadFilter(); soft.type = 'lowpass'; soft.frequency.value = 5500; soft.Q.value = 0.5;
    crowdBus = ctx.createGain(); crowdBus.gain.value = 0;
    crowdBus.connect(soft).connect(ctx.destination);
  }
  // the volume follows you a few times a second, in smooth ramps: re-aiming it every frame crackled
  const want = Math.min(1, level) * 0.9;
  if (t - busAt > 0.25 && Math.abs(want - busLevel) > 0.01) {
    crowdBus.gain.cancelScheduledValues(t);
    crowdBus.gain.setValueAtTime(crowdBus.gain.value, t);
    crowdBus.gain.linearRampToValueAtTime(want, t + 0.4);
    busLevel = want; busAt = t;
  }
  if (level <= 0.01) return;
  // the murmur of the crowd: 25 s pieces from anywhere in the 80 s recording, each fading into the next
  if (t > bedUntil - 3) {
    const B = crowdBufs.murmur, len = 25, start = Math.max(t, bedUntil - 3), src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = B;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(0.75, start + 3);
    g.gain.setValueAtTime(0.75, start + len - 3);
    g.gain.linearRampToValueAtTime(0.0001, start + len);
    src.connect(g).connect(crowdBus);
    src.start(start, Math.random() * Math.max(0, B.duration - len - 1), len);
    bedUntil = start + len;
  }
  // a horn, an air horn or a rattle now and then
  if (t - lastNoise > 2.5 && Math.random() < level * 0.006) {
    lastNoise = t;
    const src = ctx.createBufferSource(), g = ctx.createGain(), pan = ctx.createStereoPanner();
    src.buffer = crowdBufs.noise[Math.floor(Math.random() * crowdBufs.noise.length)];
    src.playbackRate.value = 0.95 + Math.random() * 0.1;
    g.gain.value = 0.25 + Math.random() * 0.2;
    pan.pan.value = Math.random() * 1.6 - 0.8;
    src.connect(g).connect(pan).connect(crowdBus);
    src.start(t);
  }
  // a shout now and then, more often close to the fans, left or right
  if (t - lastShout > 1.0 && Math.random() < level * 0.03) {
    lastShout = t;
    const src = ctx.createBufferSource(), g = ctx.createGain(), pan = ctx.createStereoPanner();
    src.buffer = crowdBufs.shouts[Math.floor(Math.random() * crowdBufs.shouts.length)];
    src.playbackRate.value = 0.92 + Math.random() * 0.16;
    g.gain.value = (0.6 + Math.random() * 0.5) * Math.max(0.4, level);
    pan.pan.value = Math.random() * 1.6 - 0.8;
    src.connect(g).connect(pan).connect(crowdBus);
    src.start(t);
  }
}

/** The crowd goes quiet (end of the ride). */
export function crowdOff() {
  if (crowdBus && ctx && busLevel !== 0) {
    const t = ctx.currentTime;
    crowdBus.gain.cancelScheduledValues(t);
    crowdBus.gain.setValueAtTime(crowdBus.gain.value, t);
    crowdBus.gain.linearRampToValueAtTime(0, t + 0.4);
    busLevel = 0;
  }
  bedUntil = 0;
}
