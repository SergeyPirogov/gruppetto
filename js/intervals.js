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
      throw new IntervalsError(0, 'Немає зв’язку з intervals.icu. Перевірте інтернет.');
    }
    if (res.status === 401 || res.status === 403) throw new IntervalsError(res.status, 'intervals.icu не прийняв API-ключ. Перевірте ключ і ID атлета.');
    if (res.status === 404) throw new IntervalsError(404, 'Атлета не знайдено. Перевірте ID (наприклад, i123456) або залиште поле порожнім.');
    if (!res.ok) throw new IntervalsError(res.status, `intervals.icu відповів помилкою ${res.status}.`);
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
    };
  }

  /**
   * Planned cycling workouts between two local dates (YYYY-MM-DD), converted to Power Up workouts.
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
        w.description = `Без інтервалів — вільна їзда ${Math.round(dur / 60)} хв`;
        stats.unstructured++;
      }
      out.push(w);
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    out.stats = stats;
    return out;
  }

  /** Upload a FIT (or TCX) file; pairs it with the planned workout when eventId is given. Returns the new activity id. */
  async uploadActivity(data, { name, description, eventId, filename = 'powerup.fit' }) {
    const form = new FormData();
    const type = filename.endsWith('.tcx') ? 'application/vnd.garmin.tcx+xml' : 'application/vnd.ant.fit';
    form.append('file', new Blob([data], { type }), filename);
    const res = await this.request('/activities', {
      method: 'POST',
      body: form,
      params: { name, description, paired_event_id: eventId || undefined },
    });
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
    name: e.name || 'Тренування з intervals.icu',
    description: e.description ? e.description.split('\n')[0].slice(0, 90) : 'З календаря intervals.icu',
    steps,
  };
}

/** Flatten intervals.icu workout_doc steps (with repeats) into Power Up steps. */
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
    out.push({ dur, ...convertTarget(s), text: s.text || s.description || '' });
  }
  return out;
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
  let a, b;
  if (p.start !== undefined && p.end !== undefined) { a = p.start; b = p.end; }
  else if (p.min !== undefined && p.max !== undefined) { a = b = (p.min + p.max) / 2; }
  else if (p.value !== undefined) { a = b = p.value; }
  else return { free: true };

  if (units === 'w' || units === 'watts') {
    return a === b ? { watts: Math.round(a) } : { watts: Math.round(a), wattsTo: Math.round(b) };
  }
  if (units.includes('zone')) {
    a = ZONE_FTP[Math.max(1, Math.min(7, Math.round(a)))] ?? 0.6;
    b = ZONE_FTP[Math.max(1, Math.min(7, Math.round(b)))] ?? a;
    return a === b ? { power: a } : { power: a, to: b };
  }
  if (units.includes('ftp')) {
    return a === b ? { power: a / 100 } : { power: a / 100, to: b / 100 };
  }
  return { free: true }; // %MMP, HR or pace targets: ride by feel, no ERG
}

export const localDate = (d = new Date()) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
};
