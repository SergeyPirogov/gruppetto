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

