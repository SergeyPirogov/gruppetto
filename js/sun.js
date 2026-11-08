// The sun where you are (#time-of-day): how high it stands now, so «By the clock» follows the real day, not fixed
// hours (in November 17:30 in Kyiv is night; in June, broad day). The place is told by the browser's time zone,
// without asking for your location.

const RAD = Math.PI / 180;

/** The sun's elevation (degrees) at date and place, and whether it is rising (morning) or setting. */
export function sunAt(date, { lat, lon }) {
  const d = date.getTime() / 864e5 - 10957.5; // days since J2000 (2000-01-01 12:00 UTC)
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  let ha = (gmst * 15 + lon) * RAD - ra;
  ha = ((ha + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; // -π…π, negative before noon
  const el = Math.asin(Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha));
  return { elevation: el / RAD, rising: ha < 0 };
}

/** The look for the sun's height: night under −6° (past dusk), morning while it rises under 15°, evening (the
 *  golden hour) while it sets under 10°, midday between. */
export function phaseOf({ elevation, rising }) {
  if (elevation < -6) return 'night';
  if (rising && elevation < 15) return 'morning';
  if (!rising && elevation < 10) return 'evening';
  return 'midday';
}

// a city in each common time zone; elsewhere the zone's own meridian at a mid latitude
const ZONES = {
  'Europe/Kyiv': [50.45, 30.52], 'Europe/Kiev': [50.45, 30.52], 'Europe/Uzhgorod': [48.62, 22.29], 'Europe/Zaporozhye': [47.84, 35.14], 'Europe/Simferopol': [44.95, 34.1],
  'Europe/Warsaw': [52.23, 21.01], 'Europe/Berlin': [52.52, 13.4], 'Europe/Vienna': [48.21, 16.37], 'Europe/Prague': [50.08, 14.44], 'Europe/Budapest': [47.5, 19.04],
  'Europe/Bucharest': [44.43, 26.1], 'Europe/Chisinau': [47.01, 28.86], 'Europe/Vilnius': [54.69, 25.28], 'Europe/Riga': [56.95, 24.11], 'Europe/Tallinn': [59.44, 24.75],
  'Europe/Helsinki': [60.17, 24.94], 'Europe/Stockholm': [59.33, 18.07], 'Europe/Oslo': [59.91, 10.75], 'Europe/Copenhagen': [55.68, 12.57], 'Europe/Amsterdam': [52.37, 4.9],
  'Europe/Brussels': [50.85, 4.35], 'Europe/Paris': [48.86, 2.35], 'Europe/Zurich': [47.38, 8.54], 'Europe/Rome': [41.9, 12.5], 'Europe/Madrid': [40.42, -3.7],
  'Europe/Lisbon': [38.72, -9.14], 'Europe/London': [51.51, -0.13], 'Europe/Dublin': [53.35, -6.26], 'Europe/Athens': [37.98, 23.73], 'Europe/Istanbul': [41.01, 28.98],
  'America/New_York': [40.71, -74.01], 'America/Chicago': [41.88, -87.63], 'America/Denver': [39.74, -104.99], 'America/Los_Angeles': [34.05, -118.24], 'America/Toronto': [43.65, -79.38],
  'Australia/Sydney': [-33.87, 151.21], 'Asia/Tokyo': [35.68, 139.69], 'Asia/Dubai': [25.2, 55.27],
};

/** Where you probably are, from the browser's time zone. */
export function placeFromZone(zone = Intl.DateTimeFormat().resolvedOptions().timeZone, date = new Date()) {
  const z = ZONES[zone];
  if (z) return { lat: z[0], lon: z[1], zone };
  // the zone's standard meridian (its offset in winter) at 45° north, or south for southern zones
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset(), jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  const std = Math.max(jan, jul);
  return { lat: /^(Australia|Antarctica|Pacific\/Auckland|America\/(Santiago|Argentina|Sao_Paulo))/.test(zone || '') ? -35 : 45, lon: -std / 4, zone };
}

/** When each look begins today at the place: { morning, midday, evening, night } as Dates (null when it does not come). */
export function phasesOfDay(date, place) {
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  const out = { morning: null, midday: null, evening: null, night: null };
  let prev = phaseOf(sunAt(start, place));
  for (let m = 5; m < 24 * 60; m += 5) {
    const t = new Date(start.getTime() + m * 60000), p = phaseOf(sunAt(t, place));
    if (p !== prev && !out[p]) out[p] = t;
    prev = p;
  }
  return out;
}
