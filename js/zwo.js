// Zwift workout files (.zwo): read them into Gruppetto steps and write steps back out (#28).
// Power in a .zwo is a fraction of FTP, durations are seconds; text-based parsing so it runs anywhere.

const attrs = (tag) => {
  const out = {};
  for (const m of tag.matchAll(/([A-Za-z_]+)\s*=\s*"([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out;
};
const num = (v, d = 0) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const unxml = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
const cadOf = (a) => {
  const lo = num(a.cadencelow, 0), hi = num(a.cadencehigh, 0), c = num(a.cadence, 0);
  if (lo && hi) return [Math.round(lo), Math.round(hi)];
  if (c) return [Math.round(c) - 3, Math.round(c) + 3];
  return null;
};

/** A .zwo file as a workout: { name, description, steps }. Throws on something that is not a workout. */
export function parseZwo(text) {
  const body = /<workout>([\s\S]*?)<\/workout>/i.exec(text);
  if (!body) throw new Error('Not a Zwift workout (.zwo) file');
  const name = unxml(/<name>([\s\S]*?)<\/name>/i.exec(text)?.[1]) || 'Workout';
  const description = unxml(/<description>([\s\S]*?)<\/description>/i.exec(text)?.[1]);
  const steps = [];
  const step = (dur, a, b, cad, extra = {}) => {
    dur = Math.round(dur);
    if (dur <= 0) return;
    const s = { dur, ...extra };
    if (a !== null && !extra.free) { s.power = +a.toFixed(3); if (b !== null && Math.abs(b - a) > 1e-3) s.to = +b.toFixed(3); }
    if (cad) s.cad = cad;
    steps.push(s);
  };
  for (const m of body[1].matchAll(/<(\w+)([^>]*?)\/?>/g)) {
    const kind = m[1].toLowerCase(), a = attrs(m[2]);
    const dur = num(a.duration), cad = cadOf(a);
    if (kind === 'warmup' || kind === 'cooldown' || kind === 'ramp') {
      step(dur, num(a.powerlow, 0.5), num(a.powerhigh, num(a.powerlow, 0.5)), cad);
    } else if (kind === 'steadystate' || kind === 'solidstate') {
      step(dur, num(a.power, num(a.powerlow, 0.5)), null, cad);
    } else if (kind === 'intervalst') {
      const reps = Math.max(1, Math.round(num(a.repeat, 1)));
      const onCad = a.cadence ? cadOf({ cadence: a.cadence }) : null, offCad = a.cadenceresting ? cadOf({ cadence: a.cadenceresting }) : null;
      for (let i = 0; i < reps; i++) {
        step(num(a.onduration), num(a.onpower, 1), null, onCad);
        step(num(a.offduration), num(a.offpower, 0.5), null, offCad);
      }
    } else if (kind === 'freeride' || kind === 'maxeffort') {
      step(dur, null, null, cad, { free: true });
    }
  }
  if (!steps.length) throw new Error('This workout has no steps');
  return { name, description, steps };
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A workout as a .zwo file, to use in Zwift or anywhere else; back-to-back on/off repeats become IntervalsT. */
export function toZwo(w) {
  const S = w.steps, out = [];
  const pw = (p) => (+p).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  const cad = (s) => (s.cad ? ` Cadence="${Math.round((s.cad[0] + s.cad[1]) / 2)}"` : '');
  for (let i = 0; i < S.length;) {
    const s = S[i];
    // on/off pairs repeated
    if (i + 3 < S.length && !s.free && s.to === undefined) {
      const on = S[i], off = S[i + 1];
      let reps = 1;
      while (i + reps * 2 + 1 < S.length && ['dur', 'power', 'to', 'free'].every((k) => S[i + reps * 2][k] === on[k] && S[i + reps * 2 + 1][k] === off[k])) reps++;
      if (reps > 1 && !off.free && off.to === undefined) {
        out.push(`    <IntervalsT Repeat="${reps}" OnDuration="${on.dur}" OffDuration="${off.dur}" OnPower="${pw(on.power)}" OffPower="${pw(off.power)}"${cad(on)}/>`);
        i += reps * 2;
        continue;
      }
    }
    if (s.free) out.push(`    <FreeRide Duration="${s.dur}"${cad(s)}/>`);
    else if (s.to !== undefined) {
      const tag = i === 0 && s.to > s.power ? 'Warmup' : i === S.length - 1 && s.to < s.power ? 'Cooldown' : 'Ramp';
      out.push(`    <${tag} Duration="${s.dur}" PowerLow="${pw(s.power)}" PowerHigh="${pw(s.to)}"${cad(s)}/>`);
    } else out.push(`    <SteadyState Duration="${s.dur}" Power="${pw(s.power)}"${cad(s)}/>`);
    i++;
  }
  return `<workout_file>
  <author>Gruppetto</author>
  <name>${esc(w.name)}</name>
  <description>${esc(w.description)}</description>
  <sportType>bike</sportType>
  <workout>
${out.join('\n')}
  </workout>
</workout_file>
`;
}
