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
// Applause, whistles and whoops, no steady noise (that read as wind). `level` 0…1: how close the crowd is.
let clapBuf = null, lastCrowd = 0;
export function crowd(level) {
  if (!ctx || level <= 0) return;
  const now = ctx.currentTime, dt = Math.min(0.1, now - lastCrowd);
  lastCrowd = now;
  if (!clapBuf) {
    const n = Math.round(ctx.sampleRate * 0.03);
    clapBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = clapBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (n * 0.18)); // a sharp slap that dies fast
  }
  // claps: dozens of hands, each its own time and pitch
  const claps = level * 26 * dt + Math.random();
  for (let k = 1; k <= claps; k++) {
    const src = ctx.createBufferSource(), band = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = clapBuf;
    band.type = 'bandpass'; band.frequency.value = 900 + Math.random() * 1600; band.Q.value = 1.2;
    g.gain.value = (0.05 + Math.random() * 0.07) * level;
    src.connect(band).connect(g).connect(ctx.destination);
    src.start(now + Math.random() * dt);
  }
  if (Math.random() < level * dt * 0.9) whoop(level, now);
}

function whoop(level, t) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  const whistle = Math.random() < 0.55;
  o.type = whistle ? 'sine' : 'triangle';
  const f0 = whistle ? 1900 + Math.random() * 600 : 330 + Math.random() * 180;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.linearRampToValueAtTime(f0 * (whistle ? 1.35 : 1.7), t + 0.22);
  if (whistle) o.frequency.linearRampToValueAtTime(f0 * 0.9, t + 0.5);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.035 * level, t + 0.04);
  g.gain.exponentialRampToValueAtTime(0.0001, t + (whistle ? 0.55 : 0.32));
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + 0.6);
}
