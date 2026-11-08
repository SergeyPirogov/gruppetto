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
// Recorded, not made up (BigSoundBank, CC0): a crowd of 600 applauding, looped with cross-fades, and
// shouts of "Yeah!" now and then from either side. `level` 0…1: how close the crowd is.
let crowdBufs = null, crowdLoading = false, crowdBus = null, bedUntil = 0, lastShout = 0;
async function loadCrowd() {
  crowdLoading = true;
  const get = async (f) => ctx.decodeAudioData(await (await fetch(`assets/sounds/${f}`)).arrayBuffer());
  try {
    const [bed, y1, y2] = await Promise.all(['crowd-applause.mp3', 'crowd-yeah-1.mp3', 'crowd-yeah-2.mp3'].map(get));
    crowdBufs = { bed, shouts: [y1, y2] };
  } catch { crowdBufs = null; }
}
export function crowd(level) {
  if (!ctx) return;
  if (!crowdBufs) { if (level > 0 && !crowdLoading) loadCrowd(); return; }
  const t = ctx.currentTime;
  if (!crowdBus) { crowdBus = ctx.createGain(); crowdBus.gain.value = 0; crowdBus.connect(ctx.destination); }
  crowdBus.gain.setTargetAtTime(Math.min(1, level) * 0.55, t, 0.8);
  if (level <= 0.01) return;
  // the applause bed: 20 s pieces from the steady middle of the recording, each fading into the next
  if (t > bedUntil - 2.5) {
    const start = Math.max(t, bedUntil - 2), len = 20, src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = crowdBufs.bed;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(1, start + 2);
    g.gain.setValueAtTime(1, start + len - 2);
    g.gain.linearRampToValueAtTime(0.0001, start + len);
    src.connect(g).connect(crowdBus);
    src.start(start, 4 + Math.random() * 2, len);
    bedUntil = start + len;
  }
  // a shout now and then, more often close to the fans, left or right
  if (t - lastShout > 1.2 && Math.random() < level * 0.02) {
    lastShout = t;
    const src = ctx.createBufferSource(), g = ctx.createGain(), pan = ctx.createStereoPanner();
    src.buffer = crowdBufs.shouts[Math.floor(Math.random() * crowdBufs.shouts.length)];
    src.playbackRate.value = 0.92 + Math.random() * 0.16;
    g.gain.value = (0.35 + Math.random() * 0.4) * level;
    pan.pan.value = Math.random() * 1.6 - 0.8;
    src.connect(g).connect(pan).connect(crowdBus);
    src.start(t);
  }
}

/** The crowd goes quiet (end of the ride). */
export function crowdOff() {
  if (crowdBus && ctx) crowdBus.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
  bedUntil = 0;
}
