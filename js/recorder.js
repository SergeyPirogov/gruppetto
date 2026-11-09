// Records one sample per second and exports FIT (virtual ride, like Zwift) or TCX.
import { encodeActivity } from './fit.js';

export class Recorder {
  constructor() { this.reset(); }

  reset() {
    this.samples = [];
    this.startTime = null;
    this.lapStarts = [0];
  }

  /** Start a new lap at the next sample (workout interval or route lap). */
  markLap() {
    const i = this.samples.length;
    if (i > 0 && this.lapStarts[this.lapStarts.length - 1] !== i) this.lapStarts.push(i);
  }

  toFIT() {
    return encodeActivity(this.samples, { start: this.startTime || new Date(), lapStarts: this.lapStarts, normalizedPower });
  }

  add(sample) {
    if (!this.startTime) this.startTime = new Date(Date.now() - 1000);
    this.samples.push(sample);
  }

  summary() {
    const s = this.samples;
    if (!s.length) return null;
    const avg = (k) => {
      const v = s.map((x) => x[k]).filter((x) => x > 0);
      return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0;
    };
    const max = (k) => Math.max(0, ...s.map((x) => x[k] || 0));
    const last = s[s.length - 1];
    return {
      duration: s.length,
      distance: last.distance,
      elevationGain: last.elevationGain,
      avgPower: avg('power'),
      maxPower: max('power'),
      normalizedPower: normalizedPower(s.map((x) => x.power || 0)),
      avgHr: avg('heartRate'),
      maxHr: max('heartRate'),
      avgCadence: avg('cadence'),
      kj: Math.round(s.reduce((a, x) => a + (x.power || 0), 0) / 1000),
      best1min: bestAverage(s.map((x) => x.power || 0), 60),
    };
  }

  toTCX() {
    const start = this.startTime || new Date();
    const sum = this.summary();
    const iso = (sec) => new Date(start.getTime() + sec * 1000).toISOString();
    const pts = this.samples.map((x, i) => `
          <Trackpoint>
            <Time>${iso(i)}</Time>
            <AltitudeMeters>${x.altitude.toFixed(1)}</AltitudeMeters>
            <DistanceMeters>${x.distance.toFixed(1)}</DistanceMeters>${x.heartRate ? `
            <HeartRateBpm><Value>${Math.round(x.heartRate)}</Value></HeartRateBpm>` : ''}
            <Cadence>${Math.round(x.cadence || 0)}</Cadence>
            <Extensions><ns3:TPX><ns3:Speed>${x.speed.toFixed(2)}</ns3:Speed><ns3:Watts>${Math.round(x.power || 0)}</ns3:Watts></ns3:TPX></Extensions>
          </Trackpoint>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>${start.toISOString()}</Id>
      <Lap StartTime="${start.toISOString()}">
        <TotalTimeSeconds>${sum ? sum.duration : 0}</TotalTimeSeconds>
        <DistanceMeters>${sum ? sum.distance.toFixed(1) : 0}</DistanceMeters>
        <Calories>${sum ? sum.kj : 0}</Calories>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>${pts}
        </Track>
      </Lap>
      <Creator><Name>Gruppetto</Name></Creator>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
  }
}

export function normalizedPower(powers) {
  if (powers.length < 30) return 0;
  const rolling = [];
  let sum = 0;
  for (let i = 0; i < powers.length; i++) {
    sum += powers[i];
    if (i >= 30) sum -= powers[i - 30];
    if (i >= 29) rolling.push(sum / 30);
  }
  const mean4 = rolling.reduce((a, p) => a + p ** 4, 0) / rolling.length;
  return Math.round(mean4 ** 0.25);
}

export function bestAverage(powers, window) {
  if (powers.length < window) return 0;
  let sum = 0;
  let best = 0;
  for (let i = 0; i < powers.length; i++) {
    sum += powers[i];
    if (i >= window) sum -= powers[i - window];
    if (i >= window - 1) best = Math.max(best, sum / window);
  }
  return Math.round(best);
}

/**
 * A ride's file name: gruppetto-2026-11-08-1432-rolling-hills (your local start time, then the workout or route,
 * so a folder of rides says what each was). Letters of any script stay, the rest becomes dashes.
 */
export function rideFileName(d, title = '') {
  const p = (n) => String(n).padStart(2, '0');
  const slug = String(title || '').toLowerCase().normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40).replace(/^-+|-+$/g, '');
  return `gruppetto-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${slug ? `-${slug}` : ''}`;
}
