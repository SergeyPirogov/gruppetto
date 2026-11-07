// Web Bluetooth: smart trainers (FTMS), power meters (Cycling Power) and heart-rate monitors.
import { parseObcButtons, obcAppInfo } from './controls.js';

const FTMS = 0x1826;
const INDOOR_BIKE_DATA = 0x2ad2;
const FTMS_CONTROL_POINT = 0x2ad9;
const CPS = 0x1818;
const CP_MEASUREMENT = 0x2a63;
const HRS = 0x180d;
const HR_MEASUREMENT = 0x2a37;
const CSC = 0x1816;
const CSC_MEASUREMENT = 0x2a5b;
// Wahoo legacy trainer control (KICKR v1/v2, SNAP, CORE before FTMS firmware), inside the Cycling Power service.
const WAHOO_CONTROL = 'a026e005-0a7d-4ab3-97fa-f1500f9feb8b';
// Zwift Ride / Play / Click controllers.
const ZWIFT_RIDE_SERVICE = 0xfc82;
const ZWIFT_SERVICE = '00000001-19ca-4651-86e5-fa29dcdd09d1';
const ZWIFT_ASYNC = '00000002-19ca-4651-86e5-fa29dcdd09d1';
const ZWIFT_SYNC_RX = '00000003-19ca-4651-86e5-fa29dcdd09d1';
const ZWIFT_SYNC_TX = '00000004-19ca-4651-86e5-fa29dcdd09d1';
// OpenBikeControl (open standard; also bridged by the BikeControl app for many controllers).
const OBC_SERVICE = 'd273f680-d548-419d-b9d1-fa0472345229';
const OBC_BUTTONS = 'd273f681-d548-419d-b9d1-fa0472345229';
const OBC_HAPTIC = 'd273f682-d548-419d-b9d1-fa0472345229';
const OBC_APP_INFO = 'd273f683-d548-419d-b9d1-fa0472345229';
export const APP_ID = 'power-up';
export const APP_VERSION = '0.3.0';

export const bluetoothAvailable = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

// Diagnostic mode: list every nearby Bluetooth device instead of filtering by service.
let showAllDevices = false;
export const setShowAllDevices = (on) => { showAllDevices = !!on; };

/** requestDevice with the service filters, or every device in diagnostic mode. */
function requestDevice({ filters, optionalServices = [] }) {
  if (!showAllDevices) return navigator.bluetooth.requestDevice({ filters, optionalServices });
  const services = [...new Set([...filters.flatMap((f) => f.services || []), ...optionalServices])];
  return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: services });
}

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

/** Cycling Speed & Cadence (0x2A5B): crank data only. */
export function parseCSC(dv) {
  const flags = dv.getUint8(0);
  let o = 1;
  if (flags & 0x01) o += 6; // wheel revolution data
  if (!(flags & 0x02)) return {};
  return { crankRevs: dv.getUint16(o, true), crankTime: dv.getUint16(o + 2, true) };
}

// Wahoo legacy control commands (as used by open-source KICKR drivers).
const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
export const wahoo = {
  unlock: () => [0x20, 0xee, 0xfc],
  erg: (watts) => [0x42, ...u16(Math.max(0, Math.min(2000, Math.round(watts))))],
  simMode: (weightKg, crr = 0.004, cw = 0.51) => [
    0x43, ...u16(Math.round(weightKg * 100)), ...u16(Math.round(crr * 1000)), ...u16(Math.round(cw * 1000)),
  ],
  wheelCircumference: (mm) => [0x48, ...u16(Math.round(mm * 10))],
  /** grade in percent; encoded as (fraction + 1) * 65535 / 2 */
  grade: (gradePercent) => {
    const f = Math.max(-1, Math.min(1, gradePercent / 100));
    return [0x46, ...u16(Math.floor((f + 1) * 65535 / 2))];
  },
};

// Zwift Ride keypad (opcode 0x23, protobuf). Bits are 0 while a button is pressed.
export const RIDE_BUTTONS = {
  left: 0x00001, up: 0x00002, right: 0x00004, down: 0x00008,
  a: 0x00010, b: 0x00020, y: 0x00040, z: 0x00080,
  shiftUpL: 0x00100, shiftDownL: 0x00200, powerUpL: 0x00400, onOffL: 0x00800,
  shiftUpR: 0x01000, shiftDownR: 0x02000, powerUpR: 0x04000, onOffR: 0x08000,
};
const PADDLE_THRESHOLD = 25;

function readVarint(b, i) {
  let v = 0, shift = 0, byte;
  do { byte = b[i++]; v += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80 && i < b.length);
  return [v, i];
}

/** Returns the set of pressed button names, or null if not a keypad message. */
export function parseRideKeypad(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0x23) return null;
  const pressed = new Set();
  let i = 1, map = null;
  while (i < bytes.length) {
    const tag = bytes[i++], field = tag >> 3, wire = tag & 7;
    if (wire === 0) {
      let v; [v, i] = readVarint(bytes, i);
      if (field === 1) map = v;
    } else if (wire === 2) {
      let len; [len, i] = readVarint(bytes, i);
      if (field === 3) {
        let j = i, id = 0, val = 0;
        while (j < i + len) {
          const t = bytes[j++];
          let x; [x, j] = readVarint(bytes, j);
          if (t >> 3 === 1) id = x;
          else if (t >> 3 === 2) val = (x >>> 1) ^ -(x & 1); // zigzag sint32
        }
        if (Math.abs(val) >= PADDLE_THRESHOLD) pressed.add(id === 0 ? 'paddleL' : id === 1 ? 'paddleR' : `analog${id}`);
      }
      i += len;
    } else break;
  }
  if (map !== null) for (const [name, mask] of Object.entries(RIDE_BUTTONS)) if ((map & mask) === 0) pressed.add(name);
  return pressed;
}

// ---------- Devices ----------

const RECONNECT_ATTEMPTS = 20;

class Device extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.name = '';
    this._manual = false;
    this._listeners = [];
  }
  get connected() { return !!this.device?.gatt?.connected; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _watch(device) {
    if (this.device !== device) {
      this.device = device;
      this.name = device.name || 'Пристрій';
      device.addEventListener('gattserverdisconnected', () => this._onDrop());
    }
    this._manual = false;
    this._unlistenAll();
  }

  /** Subscribe to a characteristic; listeners are dropped on reconnect so events never double up. */
  _listen(ch, fn) {
    ch.addEventListener('characteristicvaluechanged', fn);
    this._listeners.push([ch, fn]);
  }
  _unlistenAll() {
    for (const [ch, fn] of this._listeners) ch.removeEventListener('characteristicvaluechanged', fn);
    this._listeners = [];
  }

  _onDrop() {
    this.emit('disconnect');
    if (!this._manual && this.device) this._reconnect(0);
  }

  /** Reconnect to the same device with backoff (1 s, 2 s, 4 s … max 10 s). */
  async _reconnect(attempt) {
    if (this._manual || this.connected) return;
    this.emit('reconnecting', attempt + 1);
    try {
      await withTimeout(this.connect(this.device), 15000);
      this.emit('reconnected');
    } catch {
      if (attempt + 1 < RECONNECT_ATTEMPTS && !this._manual) {
        setTimeout(() => this._reconnect(attempt + 1), Math.min(10000, 1000 * 2 ** attempt));
      } else {
        this.emit('reconnect-failed');
      }
    }
  }

  /** Connect a device the browser already allowed (no chooser). */
  async reopen(device, timeoutMs = 8000) {
    return withTimeout(this.connect(device), timeoutMs);
  }

  disconnect() {
    this._manual = true;
    if (this.connected) this.device.gatt.disconnect();
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Devices this site may use without the chooser (Chrome's getDevices; empty where unsupported). */
export async function knownDevices() {
  try { return (await navigator.bluetooth?.getDevices?.()) || []; } catch { return []; }
}

export class Trainer extends Device {
  constructor() {
    super();
    this.controllable = false;
    this.protocol = null; // 'ftms' | 'wahoo' | 'power'
    this.riderWeight = 83;
    this._cp = null;
    this._wahoo = null;
    this._wahooMode = null;
    this._queue = Promise.resolve();
    this._pending = null;
    this._lastCrank = null;
    this._lastCrankAt = 0;
  }

  async connect(known) {
    this._queue = Promise.resolve();
    this._pending = null;
    this._lastCrank = null;
    const device = known || await requestDevice({
      filters: [{ services: [FTMS] }, { services: [CPS] }],
      optionalServices: [FTMS, CPS],
    });
    this._watch(device);
    const server = await device.gatt.connect();

    let ftms = null;
    try { ftms = await server.getPrimaryService(FTMS); } catch { /* not FTMS */ }

    if (ftms) {
      const data = await ftms.getCharacteristic(INDOOR_BIKE_DATA);
      this._listen(data, (e) => this.emit('data', parseIndoorBikeData(e.target.value)));
      await data.startNotifications();
      try {
        this._cp = await ftms.getCharacteristic(FTMS_CONTROL_POINT);
        this._listen(this._cp, (e) => this._onResponse(e.target.value));
        await this._cp.startNotifications();
        await this._command([0x00]); // request control
        await this._command([0x07]); // start / resume
        this.controllable = true;
      } catch (err) {
        console.warn('FTMS control unavailable', err);
        this.controllable = false;
      }
      this.protocol = 'ftms';
    } else {
      const cps = await server.getPrimaryService(CPS);
      const meas = await cps.getCharacteristic(CP_MEASUREMENT);
      this._listen(meas, (e) => this._onPower(parseCyclingPower(e.target.value)));
      await meas.startNotifications();
      this.protocol = 'power';
      try {
        this._wahoo = await cps.getCharacteristic(WAHOO_CONTROL);
        try { await this._wahoo.startNotifications(); } catch { /* responses are optional */ }
        await this._write(wahoo.unlock());
        await this._write(wahoo.simMode(this.riderWeight));
        this._wahooMode = 'sim';
        this.protocol = 'wahoo';
        this.controllable = true;
      } catch (err) {
        console.info('No Wahoo control characteristic: power-only device', err);
        this._wahoo = null;
      }
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

  /**
   * Wheel circumference in mm (used for virtual gears). Resolves true if the trainer accepted it.
   * FTMS opcode 0x12, Wahoo legacy opcode 0x48.
   */
  setWheelCircumference(mm) {
    if (!this.controllable) return Promise.resolve(false);
    if (this.protocol === 'wahoo') return this._write(wahoo.wheelCircumference(mm)).then(() => true, () => false);
    const v = Math.round(mm * 10);
    return this._command([0x12, v & 0xff, (v >> 8) & 0xff]).catch(() => false);
  }

  /** Forces the trainer mode (and rider weight) to be re-sent with the next command. */
  resetMode() { this._wahooMode = null; }

  _write(bytes) {
    const run = () => {
      const buf = new Uint8Array(bytes);
      const ch = this._wahoo;
      return ch.writeValueWithResponse ? ch.writeValueWithResponse(buf) : ch.writeValue(buf);
    };
    this._queue = this._queue.then(run, run);
    return this._queue;
  }

  /** ERG mode: hold target power in watts. */
  setTargetPower(watts) {
    if (!this.controllable) return Promise.resolve(false);
    if (this.protocol === 'wahoo') {
      this._wahooMode = 'erg';
      return this._write(wahoo.erg(watts)).then(() => true, () => false);
    }
    const w = Math.max(0, Math.min(2000, Math.round(watts)));
    return this._command([0x05, w & 0xff, (w >> 8) & 0xff]).catch(() => false);
  }

  /** Simulation mode: grade in percent. */
  setSimulation(gradePercent, { crr = 0.004, cw = 0.51 } = {}) {
    if (!this.controllable) return Promise.resolve(false);
    if (this.protocol === 'wahoo') {
      const steps = [];
      if (this._wahooMode !== 'sim') { steps.push(this._write(wahoo.simMode(this.riderWeight, crr, cw))); this._wahooMode = 'sim'; }
      steps.push(this._write(wahoo.grade(gradePercent)));
      return Promise.all(steps).then(() => true, () => false);
    }
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
  async connect(known) {
    const device = known || await requestDevice({ filters: [{ services: [HRS] }] });
    this._watch(device);
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(HRS);
    const ch = await svc.getCharacteristic(HR_MEASUREMENT);
    this._listen(ch, (e) => this.emit('data', { heartRate: parseHeartRate(e.target.value) }));
    await ch.startNotifications();
    return this;
  }
}

export class CadenceSensor extends Device {
  async connect(known) {
    const device = known || await requestDevice({ filters: [{ services: [CSC] }] });
    this._watch(device);
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(CSC);
    const ch = await svc.getCharacteristic(CSC_MEASUREMENT);
    let last = null, lastAt = 0;
    this._listen(ch, (e) => {
      const m = parseCSC(e.target.value);
      if (m.crankRevs === undefined) return;
      const now = performance.now();
      const cad = cadenceFromCrank(last, m);
      if (cad !== null && cad < 250) { lastAt = now; this.emit('data', { cadence: cad }); }
      else if (now - lastAt > 2500) this.emit('data', { cadence: 0 });
      last = m;
    });
    await ch.startNotifications();
    return this;
  }
}

/** Zwift Ride (also Play / Click v2 on unencrypted firmware). Emits 'press' with button name. */
/**
 * Zwift Ride / Play / Click. A Zwift Ride is two handlebar units (left and right), each its own BLE
 * device, so this holds several connections: every connect() adds one more unit. A unit that drops
 * is reconnected on its own with backoff, like the other devices.
 */
export class ZwiftController extends Device {
  constructor() {
    super();
    this.units = []; // [{device, pressed, listeners}]
    this._lastPress = new Map(); // name -> {unit, t}
  }

  get connected() { return this.units.some((u) => u.device.gatt?.connected); }
  get count() { return this.units.filter((u) => u.device.gatt?.connected).length; }

  async connect(known) {
    const device = known || await requestDevice({
      filters: [{ services: [ZWIFT_RIDE_SERVICE] }, { services: [ZWIFT_SERVICE] }, { namePrefix: 'Zwift' }],
      optionalServices: [ZWIFT_RIDE_SERVICE, ZWIFT_SERVICE],
    });
    let unit = this.units.find((u) => u.device.id === device.id);
    if (unit && unit.device.gatt?.connected) return this; // already have this unit
    if (!unit) {
      unit = { device, pressed: new Set(), listeners: [] };
      device.addEventListener('gattserverdisconnected', () => this._unitDropped(unit));
      this.units.push(unit);
    }
    this._manual = false;
    for (const [ch, fn] of unit.listeners) ch.removeEventListener('characteristicvaluechanged', fn);
    unit.listeners = [];
    const server = await device.gatt.connect();
    let svc;
    try { svc = await server.getPrimaryService(ZWIFT_RIDE_SERVICE); } catch { svc = await server.getPrimaryService(ZWIFT_SERVICE); }
    const async = await svc.getCharacteristic(ZWIFT_ASYNC);
    const syncRx = await svc.getCharacteristic(ZWIFT_SYNC_RX);
    const onData = (e) => this._onData(unit, new Uint8Array(e.target.value.buffer));
    async.addEventListener('characteristicvaluechanged', onData);
    unit.listeners.push([async, onData]);
    await async.startNotifications();
    try {
      const syncTx = await svc.getCharacteristic(ZWIFT_SYNC_TX);
      await syncTx.startNotifications();
    } catch { /* optional */ }
    const rideOn = new TextEncoder().encode('RideOn');
    await (syncRx.writeValueWithoutResponse ? syncRx.writeValueWithoutResponse(rideOn) : syncRx.writeValue(rideOn));
    this.device = device;
    this.name = device.name || 'Контролер';
    return this;
  }

  _unitDropped(unit) {
    this.emit('disconnect');
    if (this._manual) { this.units = this.units.filter((u) => u !== unit); return; }
    this._reconnectUnit(unit, 0);
  }

  async _reconnectUnit(unit, attempt) {
    if (this._manual || unit.device.gatt?.connected) return;
    this.emit('reconnecting', attempt + 1);
    try {
      await withTimeout(this.connect(unit.device), 15000);
      this.emit('reconnected');
    } catch {
      if (attempt + 1 < RECONNECT_ATTEMPTS && !this._manual) {
        setTimeout(() => this._reconnectUnit(unit, attempt + 1), Math.min(10000, 1000 * 2 ** attempt));
      } else {
        this.units = this.units.filter((u) => u !== unit);
        this.emit('reconnect-failed');
      }
    }
  }

  disconnect() {
    this._manual = true;
    for (const u of this.units) if (u.device.gatt?.connected) u.device.gatt.disconnect();
  }

  _onData(unit, bytes) {
    const now = parseRideKeypad(bytes);
    if (!now) return;
    const t = performance.now();
    for (const name of now) {
      if (unit.pressed.has(name)) continue;
      // The right unit of a Zwift Ride also relays its buttons through the left one, so with both
      // connected one press arrives twice within ~100 ms, once per unit: count it only once.
      const last = this._lastPress.get(name);
      this._lastPress.set(name, { unit, t });
      if (last && last.unit !== unit && t - last.t < 250) continue;
      this.emit('press', name);
    }
    unit.pressed = now; // per unit
  }
}

/** OpenBikeControl controller (BLE transport). Emits 'buttons' with [{id, value}] changes. */
export class OpenBikeControlDevice extends Device {
  constructor() {
    super();
    this._haptic = null;
  }

  async connect(known) {
    const device = known || await requestDevice({ filters: [{ services: [OBC_SERVICE] }] });
    this._watch(device);
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(OBC_SERVICE);
    const buttons = await svc.getCharacteristic(OBC_BUTTONS);
    this._listen(buttons, (e) => {
      const changes = parseObcButtons(new Uint8Array(e.target.value.buffer));
      if (changes.length) this.emit('buttons', changes);
    });
    await buttons.startNotifications();
    try { this._haptic = await svc.getCharacteristic(OBC_HAPTIC); } catch { this._haptic = null; }
    try {
      const info = await svc.getCharacteristic(OBC_APP_INFO);
      const msg = obcAppInfo(APP_ID, APP_VERSION);
      await (info.writeValueWithoutResponse ? info.writeValueWithoutResponse(msg) : info.writeValue(msg));
    } catch { /* optional characteristic */ }
    return this;
  }

  /** pattern: 1 short, 2 double, 5 success, 6 warning, 7 error */
  haptic(pattern = 1) {
    if (!this._haptic || !this.connected) return;
    const msg = new Uint8Array([0x03, pattern, 0x00, 0x00]);
    const w = this._haptic.writeValueWithoutResponse ? this._haptic.writeValueWithoutResponse(msg) : this._haptic.writeValue(msg);
    w.catch(() => {});
  }
}
