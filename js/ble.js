// Web Bluetooth: smart trainers (FTMS), power meters (Cycling Power) and heart-rate monitors.

const FTMS = 0x1826;
const INDOOR_BIKE_DATA = 0x2ad2;
const FTMS_CONTROL_POINT = 0x2ad9;
const CPS = 0x1818;
const CP_MEASUREMENT = 0x2a63;
const HRS = 0x180d;
const HR_MEASUREMENT = 0x2a37;

export const bluetoothAvailable = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

// ---------- Pure parsers (unit-tested) ----------

/** FTMS Indoor Bike Data (0x2AD2). */
export function parseIndoorBikeData(dv) {
  const flags = dv.getUint16(0, true);
  let o = 2;
  const out = {};
  if (!(flags & 0x0001)) { out.speed = dv.getUint16(o, true) / 100; o += 2; } // km/h
  if (flags & 0x0002) o += 2; // average speed
  if (flags & 0x0004) { out.cadence = dv.getUint16(o, true) / 2; o += 2; }
  if (flags & 0x0008) o += 2; // average cadence
  if (flags & 0x0010) o += 3; // total distance
  if (flags & 0x0020) o += 2; // resistance level
  if (flags & 0x0040) { out.power = dv.getInt16(o, true); o += 2; }
  if (flags & 0x0080) o += 2; // average power
  if (flags & 0x0100) o += 5; // expended energy
  if (flags & 0x0200) { out.heartRate = dv.getUint8(o); o += 1; }
  return out;
}

/** Cycling Power Measurement (0x2A63). Returns power and raw crank data. */
export function parseCyclingPower(dv) {
  const flags = dv.getUint16(0, true);
  let o = 2;
  const out = { power: dv.getInt16(o, true) };
  o += 2;
  if (flags & 0x0001) o += 1; // pedal power balance
  if (flags & 0x0004) o += 2; // accumulated torque
  if (flags & 0x0010) o += 6; // wheel revolution data
  if (flags & 0x0020) {
    out.crankRevs = dv.getUint16(o, true);
    out.crankTime = dv.getUint16(o + 2, true); // 1/1024 s
  }
  return out;
}

/** Heart Rate Measurement (0x2A37). */
export function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
  return flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
}

/** Cadence from two successive crank events, handling 16-bit rollover. */
export function cadenceFromCrank(prev, cur) {
  if (!prev) return null;
  const revs = (cur.crankRevs - prev.crankRevs + 0x10000) & 0xffff;
  const ticks = (cur.crankTime - prev.crankTime + 0x10000) & 0xffff;
  if (revs === 0 || ticks === 0) return null;
  return (revs / (ticks / 1024)) * 60;
}

// ---------- Devices ----------

class Device extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.name = '';
  }
  get connected() { return !!this.device?.gatt?.connected; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _watch(device) {
    this.device = device;
    this.name = device.name || 'Пристрій';
    device.addEventListener('gattserverdisconnected', () => this.emit('disconnect'));
  }
  disconnect() { if (this.connected) this.device.gatt.disconnect(); }
}

export class Trainer extends Device {
  constructor() {
    super();
    this.controllable = false;
    this._cp = null;
    this._queue = Promise.resolve();
    this._pending = null;
    this._lastCrank = null;
    this._lastCrankAt = 0;
  }

  async connect() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS] }, { services: [CPS] }],
      optionalServices: [FTMS, CPS],
    });
    this._watch(device);
    const server = await device.gatt.connect();

    let ftms = null;
    try { ftms = await server.getPrimaryService(FTMS); } catch { /* not FTMS */ }

    if (ftms) {
      const data = await ftms.getCharacteristic(INDOOR_BIKE_DATA);
      data.addEventListener('characteristicvaluechanged', (e) => this.emit('data', parseIndoorBikeData(e.target.value)));
      await data.startNotifications();
      try {
        this._cp = await ftms.getCharacteristic(FTMS_CONTROL_POINT);
        this._cp.addEventListener('characteristicvaluechanged', (e) => this._onResponse(e.target.value));
        await this._cp.startNotifications();
        await this._command([0x00]); // request control
        await this._command([0x07]); // start / resume
        this.controllable = true;
      } catch (err) {
        console.warn('FTMS control unavailable', err);
        this.controllable = false;
      }
    } else {
      const cps = await server.getPrimaryService(CPS);
      const meas = await cps.getCharacteristic(CP_MEASUREMENT);
      meas.addEventListener('characteristicvaluechanged', (e) => this._onPower(parseCyclingPower(e.target.value)));
      await meas.startNotifications();
    }
    return this;
  }

  _onPower(m) {
    const out = { power: m.power };
    if (m.crankRevs !== undefined) {
      const now = performance.now();
      const cad = cadenceFromCrank(this._lastCrank, m);
      if (cad !== null) { out.cadence = cad; this._lastCrankAt = now; }
      else if (now - this._lastCrankAt > 2500) out.cadence = 0;
      this._lastCrank = m;
    }
    this.emit('data', out);
  }

  _onResponse(dv) {
    if (dv.getUint8(0) !== 0x80 || !this._pending) return;
    const ok = dv.getUint8(2) === 0x01;
    const { resolve, timer } = this._pending;
    clearTimeout(timer);
    this._pending = null;
    resolve(ok);
  }

  _command(bytes) {
    const run = () => new Promise((resolve, reject) => {
      if (!this._cp) return reject(new Error('no control point'));
      const timer = setTimeout(() => { this._pending = null; resolve(false); }, 2000);
      this._pending = { resolve, timer };
      const buf = new Uint8Array(bytes);
      const write = this._cp.writeValueWithResponse ? this._cp.writeValueWithResponse(buf) : this._cp.writeValue(buf);
      write.catch((e) => { clearTimeout(timer); this._pending = null; reject(e); });
    });
    this._queue = this._queue.then(run, run);
    return this._queue;
  }

  /** ERG mode: hold target power in watts. */
  setTargetPower(watts) {
    if (!this.controllable) return Promise.resolve(false);
    const w = Math.max(0, Math.min(2000, Math.round(watts)));
    return this._command([0x05, w & 0xff, (w >> 8) & 0xff]).catch(() => false);
  }

  /** Simulation mode: grade in percent. */
  setSimulation(gradePercent, { crr = 0.004, cw = 0.51 } = {}) {
    if (!this.controllable) return Promise.resolve(false);
    const g = Math.round(Math.max(-40, Math.min(40, gradePercent)) * 100);
    const gu = g & 0xffff;
    return this._command([
      0x11,
      0x00, 0x00, // wind speed
      gu & 0xff, (gu >> 8) & 0xff,
      Math.round(crr * 10000) & 0xff,
      Math.round(cw * 100) & 0xff,
    ]).catch(() => false);
  }
}

export class HeartRateMonitor extends Device {
  async connect() {
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [HRS] }] });
    this._watch(device);
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(HRS);
    const ch = await svc.getCharacteristic(HR_MEASUREMENT);
    ch.addEventListener('characteristicvaluechanged', (e) => this.emit('data', { heartRate: parseHeartRate(e.target.value) }));
    await ch.startNotifications();
    return this;
  }
}
