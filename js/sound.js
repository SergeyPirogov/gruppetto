// Interval cues: short beeps (Web Audio) and spoken prompts (speech synthesis, Ukrainian when available).

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
  u.lang = 'uk-UA';
  const voice = speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith('uk'));
  if (voice) u.voice = voice;
  u.rate = 1.05;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/** "3 хвилини", "45 секунд", "1 хв 30 с" */
export function spokenDuration(sec) {
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
  if (!m) return `${s} ${plural(s, 'секунда', 'секунди', 'секунд')}`;
  if (!s) return `${m} ${plural(m, 'хвилина', 'хвилини', 'хвилин')}`;
  return `${m} хв ${s} с`;
}
