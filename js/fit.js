// Minimal FIT (Garmin Flexible and Interoperable Data Transfer) activity encoder.
// Produces the same structure Zwift writes for a virtual ride: file_id, device_info, timer events,
// 1 Hz records, laps, session (sport=cycling, sub_sport=virtual_activity) and activity.
// Field numbers and scales follow the official Garmin FIT SDK profile.

const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z in Unix seconds
const T = { enum: [0x00, 1], uint8: [0x02, 1], uint16: [0x84, 2], uint32: [0x86, 4], uint32z: [0x8c, 4], string: [0x07, 0] };
const INVALID = { 0x00: 0xff, 0x02: 0xff, 0x84: 0xffff, 0x86: 0xffffffff, 0x8c: 0 };

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
function crc16(bytes, crc = 0) {
  for (const b of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[b & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc;
}

export const fitTime = (date) => Math.round(date.getTime() / 1000) - FIT_EPOCH;

class FitWriter {
  constructor() {
    this.bytes = [];
    this.defs = new Map(); // key -> local type
  }

  /** fields: [[fieldNum, type, value, size?]] ; value null/undefined => invalid */
  message(globalNum, fields) {
    const key = `${globalNum}:${fields.map((f) => `${f[0]}/${f[1]}/${f[3] || ''}`).join(',')}`;
    let local = this.defs.get(key);
    if (local === undefined) {
      local = this.defs.size % 16;
      this.defs.set(key, local);
      this.bytes.push(0x40 | local, 0, 0, globalNum & 0xff, globalNum >> 8, fields.length);
      for (const [num, type, , size] of fields) this.bytes.push(num, size || T[type][1], T[type][0]);
    }
    this.bytes.push(local);
    for (const [, type, value, size] of fields) this._value(type, value, size);
  }

  _value(type, value, size) {
    const [base, n] = T[type];
    if (type === 'string') {
      const enc = new TextEncoder().encode(value || '');
      for (let i = 0; i < size; i++) this.bytes.push(i < enc.length && i < size - 1 ? enc[i] : 0);
      return;
    }
    let v = value === null || value === undefined || Number.isNaN(value) ? INVALID[base] : Math.round(value);
    const max = 2 ** (8 * n) - 1;
    if (v !== INVALID[base]) v = Math.max(0, Math.min(max - 1, v));
    for (let i = 0; i < n; i++) this.bytes.push(Math.floor(v / 2 ** (8 * i)) & 0xff);
  }

  file() {
    const data = this.bytes;
    const header = [14, 0x20, 2132 & 0xff, 2132 >> 8, ...[0, 8, 16, 24].map((s) => (data.length >>> s) & 0xff), 0x2e, 0x46, 0x49, 0x54];
    const hcrc = crc16(header);
    header.push(hcrc & 0xff, hcrc >> 8);
    const all = [...header, ...data];
    const crc = crc16(all);
    all.push(crc & 0xff, crc >> 8);
    return new Uint8Array(all);
  }
}

function stats(samples) {
  const vals = (k) => samples.map((s) => s[k] || 0);
  const avgNZ = (k) => { const v = vals(k).filter((x) => x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const max = (k) => Math.max(0, ...vals(k));
  const power = vals('power');
  return {
    avgPower: power.length ? power.reduce((a, b) => a + b, 0) / power.length : 0,
    maxPower: max('power'),
    avgHr: avgNZ('heartRate'),
    maxHr: max('heartRate') || null,
    avgCadence: avgNZ('cadence'),
    work: power.reduce((a, b) => a + b, 0),
    maxSpeed: max('speed'),
  };
}

/**
 * @param samples  [{power, cadence, heartRate, speed, distance, altitude, elevationGain}] one per second
 * @param opts     {start: Date, lapStarts: number[] (sample indices), normalizedPower: fn}
 */
export function encodeActivity(samples, { start, lapStarts = [0], normalizedPower = () => 0, productName = 'Power Up' }) {
  const w = new FitWriter();
  const t0 = fitTime(start);
  const n = samples.length;
  const tEnd = t0 + Math.max(0, n - 1);
  const hasHr = samples.some((s) => s.heartRate > 0);
  const hasCad = samples.some((s) => s.cadence > 0);

  w.message(0, [[0, 'enum', 4], [1, 'uint16', 255], [2, 'uint16', 1], [3, 'uint32z', 20240001], [4, 'uint32', t0]]);
  w.message(23, [[253, 'uint32', t0], [0, 'uint8', 0], [2, 'uint16', 255], [4, 'uint16', 1], [27, 'string', productName, 16]]);
  w.message(21, [[253, 'uint32', t0], [0, 'enum', 0], [1, 'enum', 0]]);

  samples.forEach((s, i) => {
    const f = [
      [253, 'uint32', t0 + i],
      [5, 'uint32', s.distance * 100],
      [6, 'uint16', s.speed * 1000],
      [2, 'uint16', (s.altitude + 500) * 5],
      [7, 'uint16', s.power || 0],
    ];
    if (hasHr) f.push([3, 'uint8', s.heartRate > 0 ? s.heartRate : null]);
    if (hasCad) f.push([4, 'uint8', s.cadence || 0]);
    w.message(20, f);
  });

  const starts = [...new Set(lapStarts.filter((i) => i >= 0 && i < n))].sort((a, b) => a - b);
  if (!starts.length || starts[0] !== 0) starts.unshift(0);
  starts.forEach((s0, li) => {
    const s1 = li + 1 < starts.length ? starts[li + 1] : n;
    const part = samples.slice(s0, s1);
    if (!part.length) return;
    const st = stats(part);
    const dist = part[part.length - 1].distance - (s0 > 0 ? samples[s0 - 1].distance : 0);
    const ascent = part[part.length - 1].elevationGain - (s0 > 0 ? samples[s0 - 1].elevationGain : 0);
    const dur = part.length;
    w.message(19, [
      [254, 'uint16', li], [253, 'uint32', t0 + s1 - 1], [0, 'enum', 9], [1, 'enum', 1], [2, 'uint32', t0 + s0],
      [7, 'uint32', dur * 1000], [8, 'uint32', dur * 1000], [9, 'uint32', dist * 100],
      [19, 'uint16', st.avgPower], [20, 'uint16', st.maxPower], [33, 'uint16', normalizedPower(part.map((x) => x.power || 0)) || null],
      [15, 'uint8', st.avgHr], [16, 'uint8', st.maxHr], [17, 'uint8', st.avgCadence],
      [21, 'uint16', Math.max(0, ascent)], [24, 'enum', li + 1 < starts.length ? 0 : 7], [25, 'enum', 2], [39, 'enum', 58],
    ]);
  });

  w.message(21, [[253, 'uint32', tEnd], [0, 'enum', 0], [1, 'enum', 4]]);

  const st = stats(samples);
  const last = samples[n - 1] || { distance: 0, elevationGain: 0 };
  w.message(18, [
    [253, 'uint32', tEnd], [0, 'enum', 8], [1, 'enum', 1], [2, 'uint32', t0], [5, 'enum', 2], [6, 'enum', 58],
    [7, 'uint32', n * 1000], [8, 'uint32', n * 1000], [9, 'uint32', last.distance * 100],
    [11, 'uint16', st.work / 1000], [14, 'uint16', n ? (last.distance / n) * 1000 : 0], [15, 'uint16', st.maxSpeed * 1000],
    [16, 'uint8', st.avgHr], [17, 'uint8', st.maxHr], [18, 'uint8', st.avgCadence],
    [20, 'uint16', st.avgPower], [21, 'uint16', st.maxPower], [34, 'uint16', normalizedPower(samples.map((x) => x.power || 0)) || null],
    [22, 'uint16', last.elevationGain], [48, 'uint32', st.work], [25, 'uint16', 0], [26, 'uint16', starts.length], [28, 'enum', 0],
  ]);
  const tzOffset = -start.getTimezoneOffset() * 60;
  w.message(34, [[253, 'uint32', tEnd], [0, 'uint32', n * 1000], [1, 'uint16', 1], [2, 'enum', 0], [3, 'enum', 26], [4, 'enum', 1], [5, 'uint32', tEnd + tzOffset]]);
  return w.file();
}
