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

// ---------- The crowd at the top of a climb (#45) ----------
let crowdNodes = null;
/**
 * Crowd noise, 0 (silent) to 1 (right among them): a murmur that swells in waves, and whistles and
 * whoops now and then. Call it often; it eases to each new level.
 */
export function crowd(level) {
  if (!ctx) return;
  if (!crowdNodes) {
    if (level <= 0) return;
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 6; } // soft, voice-like noise
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.frequency.value = 700; band.Q.value = 0.6;
    const wave = ctx.createGain(); wave.gain.value = 0.7;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.35;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.3;
    lfo.connect(lfoAmt).connect(wave.gain);
    const out = ctx.createGain(); out.gain.value = 0;
    src.connect(band).connect(wave).connect(out).connect(ctx.destination);
    src.start(); lfo.start();
    crowdNodes = { src, lfo, out, level: 0 };
  }
  const t = ctx.currentTime;
  crowdNodes.out.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * 0.16, t, 0.6);
  crowdNodes.level = level;
  // whistles and whoops, more of them the closer you are
  if (level > 0.25 && Math.random() < level * 0.04) cheer(level);
  if (level <= 0 && crowdNodes.out.gain.value < 0.002) {
    crowdNodes.src.stop(); crowdNodes.lfo.stop(); crowdNodes = null;
  }
}

function cheer(level) {
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  const whistle = Math.random() < 0.5;
  o.type = whistle ? 'sine' : 'triangle';
  const f0 = whistle ? 1900 + Math.random() * 600 : 380 + Math.random() * 200;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.linearRampToValueAtTime(f0 * (whistle ? 1.35 : 1.6), t + 0.25);
  if (whistle) o.frequency.linearRampToValueAtTime(f0 * 0.9, t + 0.55);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.03 * level, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + (whistle ? 0.6 : 0.35));
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + 0.7);
}
