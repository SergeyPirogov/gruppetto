// intervals.icu integration: planned workouts in, completed rides out.
// Auth: HTTP Basic, user "API_KEY", password = the athlete's API key (intervals.icu → Settings → Developer Settings).
// Athlete id "0" means "the athlete who owns the key". The API allows browser (CORS) requests.

const BASE = 'https://intervals.icu/api/v1/athlete/';
const RIDE_TYPES = new Set(['Ride', 'VirtualRide', 'GravelRide', 'MountainBikeRide']);

// Midpoints of the 7 Coggan power zones, as a fraction of FTP.
const ZONE_FTP = [0, 0.5, 0.65, 0.83, 0.98, 1.13, 1.35, 1.6];

export class IntervalsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class IntervalsClient {
  constructor({ apiKey, athleteId = '0' }) {
    this.apiKey = (apiKey || '').trim();
    this.athleteId = (athleteId || '').trim() || '0';
  }

  async request(path, { method = 'GET', params = {}, body } = {}) {
    const url = new URL(BASE + encodeURIComponent(this.athleteId) + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(url, { method, body, headers: { Authorization: `Basic ${btoa(`API_KEY:${this.apiKey}`)}` } });
    } catch {
      throw new IntervalsError(0, 'Cannot reach intervals.icu. Check your internet connection.');
    }
    if (res.status === 401 || res.status === 403) throw new IntervalsError(res.status, 'intervals.icu rejected the API key. Check the key and athlete ID.');
    if (res.status === 404) throw new IntervalsError(404, 'Athlete not found. Check the ID (e.g. i123456) or leave the field empty.');
    if (!res.ok) {
      let why = '';
      try { why = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 160); } catch { /* no body */ }
      throw new IntervalsError(res.status, `intervals.icu returned error ${res.status}${why ? `: ${why}` : '.'}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** Profile with cycling FTP and weight. */
  async athlete() {
    const a = await this.request('');
    const ride = (a.sportSettings || []).find((s) => (s.types || []).some((t) => RIDE_TYPES.has(t)));
    return {
      name: a.firstname || a.name || '',
      ftp: ride?.ftp || null,
      weight: a.icu_weight || a.weight || null,
      maxHr: ride?.max_hr || null,
      lthr: ride?.lthr || null,
      wPrime: ride?.w_prime || null, // W′, joules
      hrZones: Array.isArray(ride?.hr_zones) && ride.hr_zones.length > 1 ? ride.hr_zones : null, // each zone's top, bpm
      hrZoneNames: Array.isArray(ride?.hr_zone_names) ? ride.hr_zone_names : [],
    };
  }

  /**
   * Your cycling power curve from all your rides there (Zwift's too, when they reach intervals.icu): the best
   * watts for each of durs (seconds), all time and over the last 42 days, { all: {secs: w}, recent: {secs: w} }.
   */
  async powerCurves(durs) {
    const res = await this.request('/power-curves', { params: { type: 'Ride', curves: 'all,42d' } });
    const list = Array.isArray(res?.list) ? res.list : Array.isArray(res) ? res : [];
    const pick = (c) => {
      const out = {}, secs = c?.secs || [], w = c?.values || c?.watts || [];
      for (const d of durs) { const i = secs.indexOf(d); if (i >= 0 && w[i] > 0) out[d] = Math.round(w[i]); }
      return out;
    };
    return { all: pick(list[0]), recent: pick(list[1]) };
  }

  /** Fitness and fatigue by day (CTL, ATL) between two local dates (YYYY-MM-DD), as intervals.icu counts them. */
  async fitness(oldest, newest) {
    const res = await this.request('/wellness', { params: { oldest, newest } });
    return (Array.isArray(res) ? res : [])
      .filter((w) => /^\d{4}-\d{2}-\d{2}$/.test(w?.id || '') && Number.isFinite(w.ctl) && Number.isFinite(w.atl))
      .map((w) => ({ date: w.id, ctl: w.ctl, atl: w.atl }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Planned cycling workouts between two local dates (YYYY-MM-DD), converted to Gruppetto workouts.
   * The returned array carries `stats` explaining what was found and skipped.
   */
  async plannedWorkouts(oldest, newest) {
    const events = (await this.request('/events', { params: { oldest, newest, category: 'WORKOUT' } })) || [];
    const stats = { total: events.length, otherSport: 0, unstructured: 0 };
    const out = [];
    for (const e of events) {
      if (e.type && !RIDE_TYPES.has(e.type)) { stats.otherSport++; continue; }
      const w = eventToWorkout(e);
      if (!w.steps.length) {
        // no structured steps (e.g. "1 h Z2" or text only): ride it as a free ride of the planned length
        const dur = Math.round(e.moving_time || e.time_target || 3600);
        w.steps = [{ dur, free: true, text: e.name || '' }];
        w.description = `No intervals — free ride, ${Math.round(dur / 60)} min`;
        stats.unstructured++;
      }
      out.push(w);
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    out.stats = stats;
    return out;
  }

  /** Upload a FIT (or TCX) file; pairs it with the planned workout when eventId is given. Returns the new activity id. */
  async uploadActivity(data, { name, description, eventId, filename = 'gruppetto.fit' }) {
    const type = filename.endsWith('.tcx') ? 'application/vnd.garmin.tcx+xml' : 'application/vnd.ant.fit';
    const send = (pair) => {
      const form = new FormData();
      form.append('file', new Blob([data], { type }), filename);
      return this.request('/activities', { method: 'POST', body: form, params: { name, description, paired_event_id: pair || undefined } });
    };
    let res;
    try {
      res = await send(eventId);
    } catch (e) {
      // the planned workout could not be paired (moved or deleted meanwhile): keep the ride, unpaired
      if (!eventId || e.status !== 422) throw e;
      res = await send(null);
    }
    const list = Array.isArray(res) ? res : res?.activities || (res ? [res] : []);
    return list[0]?.id || null;
  }
}

export const activityUrl = (id) => `https://intervals.icu/activities/${id}`;

export function eventToWorkout(e) {
  const steps = convertSteps(e.workout_doc?.steps || []);
  const date = (e.start_date_local || '').slice(0, 10);
  return {
    id: `icu:${e.id}`,
    eventId: e.id,
    source: 'intervals',
    date,
    name: e.name || 'Workout from intervals.icu',
    description: e.description ? e.description.split('\n')[0].slice(0, 90) : 'From the intervals.icu calendar',
    notes: (e.description || '').trim(), // the whole text, for the workout page
    steps,
  };
}

/** Flatten intervals.icu workout_doc steps (with repeats) into Gruppetto steps. */
export function convertSteps(steps, out = []) {
  for (const s of steps || []) {
    if (Array.isArray(s.steps) && s.steps.length) {
      const reps = Math.max(1, Math.round(s.reps || 1));
      for (let i = 0; i < reps; i++) convertSteps(s.steps, out);
      continue;
    }
    let dur = Math.round(s.duration || 0);
    if (!dur && s.distance) dur = Math.round((distanceMetres(s.distance) / 1000) / 30 * 3600); // ~30 km/h
    if (dur <= 0) continue;
    const step = { dur, ...convertTarget(s), text: s.text || s.description || '' };
    const cad = convertCadence(s.cadence);
    if (cad) step.cad = cad;
    out.push(step);
  }
  return out;
}

/** Cadence target as [low, high] rpm, or null. */
function convertCadence(c) {
  if (!c) return null;
  if (c.min !== undefined && c.max !== undefined) return [Math.round(c.min), Math.round(c.max)];
  if (c.start !== undefined && c.end !== undefined) return [Math.round(Math.min(c.start, c.end)), Math.round(Math.max(c.start, c.end))];
  if (c.value !== undefined) return [Math.round(c.value) - 3, Math.round(c.value) + 3];
  return null;
}

function distanceMetres(d) {
  if (typeof d === 'number') return d;
  const v = Number(d.value) || 0;
  return d.unit === 'km' ? v * 1000 : d.unit === 'mi' ? v * 1609.34 : v;
}

function convertTarget(s) {
  const p = s.power;
  if (!p || s.freeride) return { free: true };
  const units = String(p.units || '%ftp').toLowerCase();
  // a ramp is marked `ramp`; otherwise start/end (or min/max) is a range: ride its middle, show the band
  let a, b, lo = null, hi = null;
  if (p.start !== undefined && p.end !== undefined && s.ramp) { a = p.start; b = p.end; }
  else if (p.start !== undefined && p.end !== undefined) { lo = Math.min(p.start, p.end); hi = Math.max(p.start, p.end); a = b = (lo + hi) / 2; }
  else if (p.min !== undefined && p.max !== undefined) { lo = p.min; hi = p.max; a = b = (p.min + p.max) / 2; }
  else if (p.value !== undefined) { a = b = p.value; }
  else return { free: true };
  const band = (k) => (lo !== null && hi > lo ? { range: [lo * k, hi * k] } : {});

  if (units === 'w' || units === 'watts') {
    return a === b ? { watts: Math.round(a), ...(lo !== null && hi > lo ? { rangeW: [Math.round(lo), Math.round(hi)] } : {}) } : { watts: Math.round(a), wattsTo: Math.round(b) };
  }
  if (units.includes('zone')) {
    a = ZONE_FTP[Math.max(1, Math.min(7, Math.round(a)))] ?? 0.6;
    b = ZONE_FTP[Math.max(1, Math.min(7, Math.round(b)))] ?? a;
    return a === b ? { power: a } : { power: a, to: b };
  }
  if (units.includes('ftp')) {
    return a === b ? { power: a / 100, ...band(1 / 100) } : { power: a / 100, to: b / 100 };
  }
  return { free: true }; // %MMP, HR or pace targets: ride by feel, no ERG
}

export const localDate = (d = new Date()) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
};
