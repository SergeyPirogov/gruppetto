import { WIND_CW, bluetoothAvailable, setShowAllDevices, knownDevices, Trainer, HeartRateMonitor, CadenceSensor, ZwiftController, OpenBikeControlDevice } from './ble.js';
import { obcIntents, rideIntent, OBC_LABELS } from './controls.js';
import { IntervalsClient, activityUrl, localDate } from './intervals.js';
import { stepSpeed, packDraft, DEFAULTS, riderCdA, windComponents, windGrade } from './physics.js';
import { routes, Route, ROUTE_GROUPS, SEG } from './routes.js';
import { parseGpx, routeFromTrack } from './gpx.js';
import { loadTerrain } from './dem.js';
import { fetchOsm } from './osm.js';
import { t as tr, lang, locale, plural, setLang, LANGS, translateDom } from './i18n.js';
import { workouts, targetAt, totalDuration, stepWatts, zoneColor, powerZone, workoutStats, POWER_ZONES } from './workouts.js';
import { rideIntervals, timeInZones, hrZonesBpm } from './analysis.js';
/** Heart rate zones in bpm: from intervals.icu when connected, otherwise from the threshold heart rate (Profile). */
const hrZones = (s = settings) => hrZonesBpm({ bpm: s.hrZones, names: s.hrZoneNames, lthr: s.lthr });
import { parseZwo, toZwo } from './zwo.js';
import { DURS, bestsFromSamples, stopsOf, powerCurve, ftpSuggestion, wPrimeSuggestion, rampFtp, fitnessSeries, formBand } from './power.js';
import { putRide, getRide, deleteRide, putDraft, getDraft, deleteDraft } from './ride-store.js';
import { Recorder } from './recorder.js';
import { placeFromZone, phasesOfDay, sunAt, phaseOf } from './sun.js';
import { initStats, stopStats, track, minutesBucket, rideMilestone } from './stats.js';
import { BADGES, addRide, progressFrom, levelOf } from './progress.js';
import { encodeChallenge, decodeChallenge, challengeIn } from './challenge.js';
import { DEFAULT_W_PRIME, wbalStep, wbalSeries, timeToEmpty, WARN_SECONDS } from './wbal.js';
import { Sampler } from './sampler.js';
import { unlockAudio, beep, say, spokenDuration, crowd, crowdOff, audioReady } from './sound.js';
import { Scene, drawProfile } from './render.js';
import { themeFor } from './themes.js';
import { pipSupport, pipOpen, openPip, closePip, updatePip, resetPip } from './pip.js';
import { GEARS, DEFAULT_GEAR, ratioOf, virtualWheelMm, gearGradeOffset, BASE_WHEEL_MM } from './gears.js';

const $ = (id) => document.getElementById(id);
// units in the interface language
const U = { km: tr('km'), m: tr('m'), W: tr('W'), bpm: tr('bpm'), rpm: tr('rpm'), min: tr('min'), wkg: tr('W/kg') };

// ---------- Settings ----------
const DEFAULT_SETTINGS = {
  name: 'Me', weight: 75, height: 178, ftp: 200, wPrimeKj: DEFAULT_W_PRIME / 1000, maxHr: 0, lthr: 0, difficulty: 50, routeId: 'rolling', mode: 'free',
  icuKey: '', icuAthlete: '', icuUpload: true, stats: true, quality: 'auto', pipClean: false,
  chainring: 34, cog: 14, shiftMode: 'wheel', graphics: '3d',
  jersey: '#16a0a8', stripe: '#ff8a1f', bikeColor: '',
  intensity: 100, sound: true, voice: true, pacer: false, pacerName: 'Pacer', freePacer: false, freePacerWkg: 2.5, bots: 5, ghost: 'off', style: 'cartoon', camera: 'chase', timeOfDay: 'midday', weather: 'clear', wind: 'light',
};
let settings = { ...DEFAULT_SETTINGS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('powerup.settings') || '{}')); } catch { /* storage unavailable */ }
initStats(settings.stats);
// what breaks in riders' browsers: the message only (no stack, no address)
window.addEventListener('error', (ev) => track('error', String(ev.message || 'unknown').replace(/https?:\/\/\S+/g, '').slice(0, 80)));
// the workout pacer used to start switched on: once, switch it off (P or the Pacer button brings him back)
if (!settings.pacerOffByDefault) {
  settings.pacer = false; settings.pacerOffByDefault = true;
  try { localStorage.setItem('powerup.settings', JSON.stringify(settings)); } catch { /* ignore */ }
}
// ?debug: reach the current ride from devtools (jump along the route when testing laps and climbs)
if (new URLSearchParams(location.search).has('debug')) {
  Object.defineProperty(window, '__ride', { get: () => ride });
  Object.defineProperty(window, '__scene', { get: () => scene });
  window.__planDemo = (list) => { icuWorkouts = list; icuClient = icuClient || { demo: true, uploadActivity: async () => null }; renderModes(); }; // try the plan box and uploads without an account
}

// personal bests on this device: { lap: {routeId: seconds}, seg: {climbId: seconds} }
const records = (() => { try { return JSON.parse(localStorage.getItem('gruppetto.records') || '{}'); } catch { return {}; } })();
records.lap ||= {}; records.seg ||= {}; records.segTrace ||= {}; records.top ||= {}; // top: best top speed per sprint, km/h
/** A lap or finish time is real only below 90 km/h on average (a debug jump or a broken import is not a record). */
const plausibleLap = (t, length) => t > 0 && t >= length / 25;
/** This route's best lap / finish time, ignoring an impossible one. */
const bestLap = (r) => { const t = records.lap[r.id]; return t && plausibleLap(t, r.length) ? t : undefined; }; // segTrace: seconds at every 10 m of the record climb
// routes imported from GPX (#25), kept on this device as plain data
const ROUTES_KEY = 'gruppetto.routes';
const customDefs = (() => { try { return JSON.parse(localStorage.getItem(ROUTES_KEY) || '[]'); } catch { return []; } })();
for (const d of customDefs) { try { routes.push(new Route(d)); } catch { /* skip a broken entry */ } }
const saveCustomRoutes = () => {
  try { localStorage.setItem(ROUTES_KEY, JSON.stringify(customDefs)); return true; } catch { return false; }
};
const saveRecords = () => { try { localStorage.setItem('gruppetto.records', JSON.stringify(records)); } catch { /* ignore */ } };
/** Seconds into a climb at `off` metres, from a record trace (every 10 m) or, without one, an even pace. */
function traceTime(trace, best, length, off) {
  if (trace?.length > 1) {
    const x = Math.max(0, off / TRACE_STEP), i = Math.min(trace.length - 2, Math.floor(x));
    return trace[i] + (trace[i + 1] - trace[i]) * (x - i);
  }
  return best * Math.max(0, Math.min(1, off / length));
}
/** Metres into a climb after `t` seconds at the record's pace (the inverse of traceTime). */
function traceDist(trace, best, length, t) {
  if (trace?.length > 1) {
    let i = 0;
    while (i < trace.length - 2 && trace[i + 1] <= t) i++;
    const f = trace[i + 1] > trace[i] ? (t - trace[i]) / (trace[i + 1] - trace[i]) : 1;
    return Math.min(length, (i + Math.max(0, Math.min(1, f))) * TRACE_STEP);
  }
  return length * Math.max(0, Math.min(1, t / best));
}
const TRACE_STEP = 10;
// the grade's colour, as climbing apps paint it: green to 2 %, yellow to 4, orange to 7, red to 10, then
// dark red; flat white, downhill blue
const gradeColor = (g) => g > 0.1 ? '#e11d48' : g > 0.07 ? '#ef4444' : g > 0.04 ? '#f97316' : g > 0.02 ? '#facc15' : g > 0.005 ? '#4ade80' : g < -0.02 ? '#60a5fa' : '#e8edf5';
const fmtDelta = (d) => `${d < 0 ? '−' : '+'}${fmtTime(Math.abs(d))}`;
const saveSettings = () => { try { localStorage.setItem('powerup.settings', JSON.stringify(settings)); } catch { /* ignore */ } };

// ---------- Devices & live data ----------
const trainer = new Trainer();
const hrm = new HeartRateMonitor();
const cadenceSensor = new CadenceSensor();
const controller = new ZwiftController();
const obc = new OpenBikeControlDevice();
const obcState = new Map();
let lastLobbyUpdate = 0;
const live = { power: 0, cadence: 0, hr: 0, powerAt: 0, cadAt: 0, hrAt: 0 };

const powerSamples = new Sampler(3000);
const cadenceSamples = new Sampler(3000);
const hrSamples = new Sampler(5000);

trainer.addEventListener('data', ({ detail: d }) => {
  const now = performance.now();
  if (d.power !== undefined) { live.power = Math.max(0, d.power); live.powerAt = now; powerSamples.add(now, live.power); }
  if (d.cadence !== undefined && !cadenceSensor.connected) { live.cadence = d.cadence; live.cadAt = now; cadenceSamples.add(now, d.cadence); }
  if (d.heartRate && !hrm.connected) { live.hr = d.heartRate; live.hrAt = now; hrSamples.add(now, d.heartRate); }
  if (d.cadence !== undefined) trainer.sendsCadence = true;
  if (!ride && now - lastLobbyUpdate > 500) { lastLobbyUpdate = now; updateDeviceUI(); } // live readings in the lobby
  advance(now); // keeps the ride clock running even when the tab is hidden and frames stop
});
hrm.addEventListener('data', ({ detail: d }) => { const now = performance.now(); live.hr = d.heartRate; live.hrAt = now; hrSamples.add(now, d.heartRate); if (!ride && now - lastLobbyUpdate > 500) { lastLobbyUpdate = now; updateDeviceUI(); } });
cadenceSensor.addEventListener('data', ({ detail: d }) => { const now = performance.now(); live.cadence = d.cadence; live.cadAt = now; cadenceSamples.add(now, d.cadence); if (!ride && now - lastLobbyUpdate > 500) { lastLobbyUpdate = now; updateDeviceUI(); } });
setInterval(() => { if (!ride) updateDeviceUI(); }, 1000); // stale readings fall to 0 / — in the lobby
controller.addEventListener('press', ({ detail: name }) => onControllerButton(name));
obc.addEventListener('buttons', ({ detail: changes }) => onObcButtons(changes));
obc.addEventListener('disconnect', () => obcState.clear());

const DEVICES = [
  { dev: trainer, key: 'trainer', lost: tr('Trainer disconnected') },
  { dev: hrm, key: 'hr', lost: tr('Heart rate monitor disconnected') },
  { dev: cadenceSensor, key: 'cad', lost: tr('Cadence sensor disconnected') },
  { dev: controller, key: 'ctl', lost: tr('Controller disconnected') },
  { dev: obc, key: 'obc', lost: tr('OpenBikeControl disconnected') },
];
const TRAINER_PROTOCOL = { ftms: 'FTMS', wahoo: 'Wahoo', power: tr('power meter') };
let lastButtonLabel = '';
let lastObcLabel = '';

const reconnecting = new Map(); // key -> attempt number

for (const d of DEVICES) {
  d.dev.addEventListener('disconnect', () => { track('device-drop', d.key); updateDeviceUI(); toast(tr('{what} — reconnecting…', { what: d.lost })); });
  d.dev.addEventListener('reconnecting', ({ detail: n }) => { reconnecting.set(d.key, n); updateDeviceUI(); });
  d.dev.addEventListener('reconnected', () => {
    reconnecting.delete(d.key);
    if (d.dev === trainer) resyncTrainer();
    updateDeviceUI();
    toast(tr('{name}: connection restored ✓', { name: d.dev.name }));
  });
  d.dev.addEventListener('reconnect-failed', () => {
    track('device-lost', d.key);
    reconnecting.delete(d.key);
    updateDeviceUI();
    toast(tr('{name}: could not reconnect — press “Connect” in Devices', { name: d.dev.name }));
  });
}

/** After the trainer comes back, send the current mode and target again. */
function resyncTrainer() {
  trainer.riderWeight = settings.weight + 8;
  trainer.resetMode();
  if (!ride) return;
  ride.lastSentTarget = null;
  ride.lastSentGrade = null;
  ride.lastSentWheel = null;
}

function deviceStatus(d) {
  if (reconnecting.has(d.key)) return `${d.dev.name} · ${tr('connection lost, reconnecting (attempt {n})…', { n: reconnecting.get(d.key) })}`;
  if (d.dev === cadenceSensor && !d.dev.connected && trainer.connected) {
    // no separate sensor: cadence comes from the trainer automatically
    if (trainer.sendsCadence) return `${tr('from trainer')} · ${Math.round(fresh(live.cadence, live.cadAt))} ${U.rpm}`;
    return tr('from trainer · start pedaling (if cadence stays at 0, connect a separate sensor)');
  }
  if (!d.dev.connected) return tr('not connected');
  if (d.dev === trainer) {
    const resistance = trainer.controllable ? tr('resistance: controlled by the app ✓') : tr('data only, no resistance control');
    return `${trainer.name} · ${TRAINER_PROTOCOL[trainer.protocol] || ''} · ${resistance} · ${Math.round(fresh(live.power, live.powerAt))} ${U.W}`;
  }
  if (d.dev === controller || d.dev === obc) {
    const label = d.dev === obc ? lastObcLabel : lastButtonLabel;
    const units = d.dev === controller && controller.count > 1 ? ` ×${controller.count}` : '';
    const hint = d.dev === controller && controller.count === 1 && /ride/i.test(controller.name)
      ? ` · ${tr('second controller: “+ controller”')}` : '';
    return `${d.dev.name}${units}${label ? ` · ${tr('pressed: {label}', { label })}` : ` · ${tr('press any button')}`}${hint}`;
  }
  if (d.dev === hrm) { const hr = fresh(live.hr, live.hrAt); return `${d.dev.name} · ${hr ? `❤ ${hr} ${U.bpm}` : tr('waiting for a reading…')}`; }
  if (d.dev === cadenceSensor) return `${d.dev.name} · ${Math.round(fresh(live.cadence, live.cadAt))} ${U.rpm}`;
  return d.dev.name;
}

/** A live reading, or 0 once it is older than 3 s (the trainer stops sending when you stop pedalling). */
const fresh = (v, at) => (performance.now() - at < 3000 ? v : 0);

function updateDeviceUI() {
  // mid-ride: a device the ride started with that dropped shows a button to its panel, so it can be reconnected without stopping
  const lost = ride ? DEVICES.filter((d) => ride.devs?.has(d.key) && !d.dev.connected) : [];
  const alert = $('btn-dev-lost');
  alert.hidden = !lost.length;
  if (lost.length) alert.textContent = `⚠ ${lost.map((d) => d.lost).join(' · ')}`;
  for (const d of DEVICES) {
    const btn = $(`btn-${d.key}`);
    $(`${d.key}-status`).textContent = deviceStatus(d);
    // cadence from the trainer counts as connected; the button then offers a separate sensor instead
    const viaTrainer = d.dev === cadenceSensor && !d.dev.connected && trainer.connected;
    btn.textContent = d.dev.connected ? tr('Disconnect') : viaTrainer ? tr('Change') : tr('Connect');
    btn.title = viaTrainer ? tr('Connect a separate cadence sensor instead of the trainer') : '';
    btn.classList.toggle('ok', !d.dev.connected && viaTrainer); // "Change": the cadence comes from the trainer
    btn.classList.toggle('danger', d.dev.connected); // "Disconnect" in red
  }
  // a Zwift Ride is two units: offer to add the other one while fewer than two are connected
  $('btn-ctl-add').hidden = !(controller.connected && controller.count < 2);
  // lobby top bar: a dot per device, lit when connected
  // with the live reading on the chip, so you see at a glance that each one is working
  const reading = { trainer: () => `${Math.round(fresh(live.power, live.powerAt))} ${U.W}`, hr: () => { const v = fresh(live.hr, live.hrAt); return v ? `❤ ${v}` : '—'; }, cad: () => `${Math.round(fresh(live.cadence, live.cadAt))} ${U.rpm}` };
  for (const d of DEVICES) {
    const chip = document.querySelector(`.dev-chip[data-key="${d.key}"]`);
    if (!chip) continue;
    const on = d.dev.connected || (d.dev === cadenceSensor && trainer.connected);
    chip.classList.toggle('on', on);
    let val = chip.querySelector('.chip-val');
    if (!val) { val = document.createElement('b'); val.className = 'chip-val'; chip.append(val); }
    val.textContent = on && reading[d.key] ? reading[d.key]() : '';
  }
  document.querySelector('.dev-chip[data-key="sim"]')?.classList.toggle('on', $('sim').checked);
  renderRailDots();
  // nothing to ride on: the trainer's chip asks to be connected
  document.querySelector('.dev-chip[data-key="trainer"]')?.classList.toggle('need', !trainer.connected && !$('sim').checked);
}

/** A setting changed during a ride: takes effect now, not at the next start. */
function applyLive(key) {
  if (!ride) return;
  if (key === 'weight' || key === 'height') {
    ride.cda = riderCdA(settings.height, settings.weight);
    trainer.riderWeight = settings.weight + 8;
    trainer.resetMode(); // the trainer's road model gets the new weight with the next grade
    ride.lastSentGrade = null;
  }
  if (key === 'ftp' && ride.workout && !ride.workoutDone) {
    const t = targetAt(ride.workout, Math.max(0, ride.workoutT - 1), settings.ftp);
    if (t) ride.target = ergTarget(t);
    ride.lastSentTarget = null;
  }
  if (key === 'difficulty') ride.lastSentGrade = null;
  if (key === 'shiftMode' || key === 'chainring' || key === 'cog') {
    ride.shiftMode = settings.shiftMode;
    ride.lastSentGrade = null; ride.lastSentWheel = null;
    updateGear();
  }
  if (key === 'style') scene?.setStyle?.(settings.style);
  if (key === 'camera') scene?.setCamera?.(settings.camera);
  if (key === 'timeOfDay' || key === 'weather') scene?.setAtmosphere?.(settings.timeOfDay, settings.weather);
}

/** Remembered device ids per slot (the browser decides whether it still allows them). */
const rememberDevice = (d) => { settings.devices = { ...(settings.devices || {}), [d.key]: d.dev.device?.id }; saveSettings(); };
const forgetDevice = (d) => { if (settings.devices) { delete settings.devices[d.key]; saveSettings(); } };

/** Try to connect a remembered device without the chooser. */
async function reopenRemembered(d) {
  const id = settings.devices?.[d.key];
  if (!id) return false;
  const known = (await knownDevices()).find((k) => k.id === id);
  if (!known) return false;
  try {
    if (d.dev === trainer) trainer.riderWeight = settings.weight + 8;
    await d.dev.reopen(known);
    return true;
  } catch { return false; }
}

/** On page load: quietly reconnect every remembered device that is in range. A device that is off or asleep
 *  then is picked up as soon as it wakes: its advertisements are watched where Chrome allows it, and every
 *  15 s it is tried again, in the lobby and mid-ride (after the trainer's own retries gave up). */
let autoBusy = false;
async function autoConnectRemembered({ quiet = false } = {}) {
  if (autoBusy) return;
  autoBusy = true;
  try {
    for (const d of DEVICES) {
      if (d.dev.connected || reconnecting.has(d.key) || !settings.devices?.[d.key] || (ride && !ride.devs?.has(d.key))) continue; // mid-ride: only what it started with
      if (!quiet) $(`${d.key}-status`).textContent = tr('connecting remembered device…');
      const ok = await reopenRemembered(d);
      if (ok && d.dev === trainer) { if (ride) resyncTrainer(); else $('sim').checked = false; } // mid-ride: the target and grade again
      if (!ok) watchRemembered(d);
      updateDeviceUI();
    }
  } finally { autoBusy = false; }
}
const watching = new Set();
async function watchRemembered(d) {
  const id = settings.devices?.[d.key];
  const known = id && (await knownDevices()).find((k) => k.id === id);
  if (!known?.watchAdvertisements || watching.has(id)) return;
  watching.add(id);
  known.addEventListener('advertisementreceived', () => { if (!d.dev.connected) autoConnectRemembered({ quiet: true }); });
  try { await known.watchAdvertisements(); } catch { watching.delete(id); }
}
setInterval(() => { if (bluetoothAvailable() && DEVICES.some((d) => !d.dev.connected && settings.devices?.[d.key] && (!ride || ride.devs?.has(d.key)))) autoConnectRemembered({ quiet: true }); }, 15000);

async function toggleDevice(d, { add = false } = {}) {
  const btn = add ? $('btn-ctl-add') : $(`btn-${d.key}`);
  if (!add && (d.dev.connected || reconnecting.has(d.key))) { d.dev.disconnect(); reconnecting.delete(d.key); forgetDevice(d); updateDeviceUI(); return; }
  btn.disabled = true;
  btn.textContent = tr('Searching…');
  let error = null;
  try {
    if (d.dev === trainer) trainer.riderWeight = settings.weight + 8;
    if (d.dev === trainer) trainer.sendsCadence = false;
    if (add || !(await reopenRemembered(d))) await d.dev.connect(); // a second Zwift Ride unit always goes through the chooser
    if (!add) rememberDevice(d);
    track('device-connect', d.key);
    if (ride) ride.devs?.add(d.key); // connected mid-ride: kept connected through it too
    if (d.dev === trainer) $('sim').checked = false;
  } catch (e) {
    if (!(e.name === 'NotFoundError' && /cancel/i.test(e.message))) error = e; // ignore only a cancelled chooser
  } finally {
    btn.disabled = false;
    if (add) btn.textContent = tr('+ controller');
    updateDeviceUI();
    if (error) {
      const noService = error.name === 'NotFoundError' || /service|characteristic/i.test(error.message);
      $(`${d.key}-status`).textContent = noService && $('show-all').checked
        ? tr('This device does not have the required service — choose another one')
        : tr('Could not connect: {error}', { error: error.message });
    }
  }
}

// ---------- Lobby ----------
function initLobby() {
  // Bluetooth works but Chrome can't reopen remembered sensors without its permissions flag
  if (bluetoothAvailable() && !navigator.bluetooth.getDevices) {
    $('autoconnect-hint').hidden = false;
    $('copy-flag').onclick = async () => {
      try { await navigator.clipboard.writeText('chrome://flags/#enable-web-bluetooth-new-permissions-backend'); $('copy-flag').textContent = tr('Copied — paste it in the address bar'); } catch { /* clipboard blocked */ }
    };
  }
  if (!bluetoothAvailable()) {
    $('bt-warning').hidden = false;
    for (const d of DEVICES) $(`btn-${d.key}`).disabled = true;
    $('sim').checked = true;
  }
  for (const d of DEVICES) $(`btn-${d.key}`).onclick = () => toggleDevice(d);
  $('btn-ctl-add').onclick = () => toggleDevice(DEVICES.find((d) => d.dev === controller), { add: true });
  $('show-all').onchange = () => setShowAllDevices($('show-all').checked);
  if (bluetoothAvailable()) autoConnectRemembered();

  const bind = (id, key, num = true) => {
    const el = $(id);
    el.value = settings[key];
    el.oninput = () => { settings[key] = num ? Number(el.value) : el.value; saveSettings(); refreshDiff(); applyLive(key); };
  };
  bind('f-name', 'name', false);
  bind('f-jersey', 'jersey', false);
  bind('f-stripe', 'stripe', false);
  bind('f-bike', 'bikeColor', false);
  $('f-bike').value = settings.bikeColor || settings.jersey; // until one is picked, the frame wears the jersey's colour
  bind('f-weight', 'weight');
  bind('f-height', 'height');
  bind('f-ftp', 'ftp');
  bind('f-wprime', 'wPrimeKj');
  bind('f-lthr', 'lthr');
  bind('f-diff', 'difficulty');
  bind('f-chainring', 'chainring');
  bind('f-cog', 'cog');
  bind('f-shift', 'shiftMode', false);
  bind('f-style', 'style', false);
  bind('f-camera', 'camera', false);
  bind('f-time', 'timeOfDay', false);
  bind('f-quality', 'quality', false);
  $('f-pip').value = settings.pipClean ? 'clean' : 'sharp';
  $('f-pip').onchange = () => { settings.pipClean = $('f-pip').value === 'clean'; saveSettings(); };
  $('f-quality').addEventListener('change', () => scene?.setQuality?.(settings.quality));
  $('f-time').addEventListener('change', renderTimeHint);
  renderTimeHint();
  bind('f-weather', 'weather', false);
  bind('f-wind', 'wind', false);
  $('f-wind').addEventListener('change', () => { if (ride?.wind) { ride.wind.base = windBase(); updateWindHud(); } }); // takes effect mid-ride too
  bind('f-bots', 'bots');
  // the pixel 3D style squares off the interface too (square corners, hard shadows)
  const pixelUi = () => document.body.classList.toggle('pixel-ui', settings.style === 'pixel');
  const refreshDiff = () => { $('diff-val').textContent = `${settings.difficulty}%`; renderModes(); pixelUi(); };
  refreshDiff();

  renderRouteList();
  $('gpx-file').addEventListener('change', importGpx);
  showRoute();
  initDrawer();
  renderHistory();
  $('sim').addEventListener('change', updateDeviceUI);

  $('btn-start').onclick = startRide;
  updateDeviceUI();
  initIntervals();
}

/** The route cards in groups: flat, hilly, mountain, and the routes you imported. */
function renderRouteList() {
  const rl = $('route-list');
  rl.innerHTML = '';
  // one height scale for the cards, so a flat route looks flat; at 40 % of the tallest route's rise,
  // so rolling hills still read as hills and only the passes fill the box
  const cardScale = 0.4 * Math.max(...routes.filter((r) => !r.custom).map((r) => r.maxElev - r.minElev));
  for (const g of ROUTE_GROUPS) {
    const list = routes.filter((r) => (r.custom ? 'mine' : r.group) === g.id);
    if (!list.length && g.id !== 'mine') continue;
    const sec = document.createElement('div');
    sec.className = 'route-group';
    sec.innerHTML = `<h3>${tr(g.name)}<small>${list.length || ''}</small></h3><div class="options route-cards"></div>`;
    const box = sec.querySelector('.route-cards');
    for (const r of list) {
      const b = document.createElement('button');
      b.className = 'option';
      b.dataset.id = r.id;
      b.innerHTML = `<b>${esc(r.name)}</b><small>${(r.length / 1000).toFixed(r.custom ? 1 : 0)} ${U.km} · ↗ ${Math.round(r.elevationGain)} ${U.m}${r.maxGrade >= 0.02 ? ` · ${tr('max {n}%', { n: Math.round(r.maxGrade * 100) })}` : ''}</small><small>${esc(r.description)}</small><canvas></canvas>`
        + (r.custom ? `<span class="rc-del" title="${tr('Delete this route')}" role="button">✕</span>` : '');
      b.onclick = (ev) => {
        if (ev.target.classList.contains('rc-del')) { deleteCustomRoute(r); return; }
        settings.routeId = r.id; saveSettings(); markRoute(); showRoute(); renderChallenge();
      };
      box.append(b);
      requestAnimationFrame(() => drawProfile(b.querySelector('canvas'), r, [], `${themeFor(r.theme).accent}99`, cardScale));
    }
    if (g.id === 'mine') {
      const add = document.createElement('label');
      add.className = 'option rc-import';
      add.innerHTML = `<b>＋ ${tr('Import GPX')}</b><small>${tr('A real road from Strava, Komoot or Garmin, up to 150 km')}</small>`;
      add.htmlFor = 'gpx-file';
      box.append(add);
    }
    rl.append(sec);
  }
  markRoute();
}

/** Climb names in the interface language ("Climb 2" -> "Підйом 2"), and an imported route's description. */
function localizeClimbs(r) {
  if (r.custom) {
    const src = r.elevSource || (/no elevation/.test(r.description) ? 'none' : 'gpx');
    const from = tr({ none: 'Imported from GPX (no elevation in the file: flat).', terrain: 'Imported from GPX (elevation from a terrain model).', gpx: 'Imported from GPX.' }[src]);
    const km = (r.length / 1000).toFixed(1);
    r.description = `${from} ${r.oneWay ? tr('Point to point, finish at {km} km.', { km }) : tr('A loop of {km} km: ride it lap after lap.', { km })}`;
  }
  for (const c of r.climbs) { const m = /^Climb (\d+)$/.exec(c.name); c.name = m ? tr('Climb {n}', { n: m[1] }) : tr(c.name); }
  for (const s of r.sprints || []) { const m = /^Sprint (\d+)$/.exec(s.name); if (m) s.name = tr('Sprint {n}', { n: m[1] }); }
}

function markRoute() {
  for (const el of $('route-list').querySelectorAll('.option[data-id]')) el.classList.toggle('sel', el.dataset.id === settings.routeId);
}

let restoreStart = null;
async function importGpx(ev) {
  restoreStart = null;
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const track = parseGpx(await file.text());
    // real elevations from a terrain model along the road (#25); without a network, the file's own
    // and the woods, water and buildings beside it from OpenStreetMap; each is optional
    // no riding off on the previously chosen route while this one is still being built
    const start = $('btn-start'), startText = start.textContent;
    start.disabled = true; start.textContent = tr('Importing GPX…');
    restoreStart = () => { start.disabled = false; start.textContent = startText; };
    let tiles = '…', map = '…';
    const show = () => infoBox(`${tr('Importing {name}', { name: track.name || file.name })}: ${tr('terrain')} ${tiles} · ${tr('map')} ${map}`);
    show();
    const [elevation, osm] = await Promise.all([
      loadTerrain(track.points, { onProgress: (done, total) => { tiles = `${done}/${total}`; show(); } })
        .catch((err) => { console.info('Terrain model unavailable, using the GPX elevations', err); return null; }),
      fetchOsm(track.points).then((d) => { map = '✓'; show(); return d; })
        .catch((err) => { console.info('Map data unavailable, generic scenery', err); map = '—'; show(); return null; }),
    ]);
    const def = routeFromTrack(track, file.name, { elevation, osm });
    $('lobby-msg').hidden = true;
    const route = new Route(def);
    localizeClimbs(route);
    customDefs.push(def);
    if (!saveCustomRoutes()) { customDefs.pop(); throw new Error(tr('Not enough browser storage for this route')); }
    routes.push(route);
    settings.routeId = route.id; saveSettings();
    renderRouteList(); showRoute();
    $('route-list').querySelector('.sel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (e) {
    alertBox(tr('Could not import {file}: {error}', { file: file.name, error: tr(e.message) }));
  } finally {
    restoreStart?.();
  }
}

function deleteCustomRoute(r) {
  if (!confirm(tr('Delete “{name}”? Its records stay in your ride history.', { name: r.name }))) return;
  const i = customDefs.findIndex((d) => d.id === r.id);
  if (i >= 0) customDefs.splice(i, 1);
  saveCustomRoutes();
  routes.splice(routes.indexOf(r), 1);
  if (settings.routeId === r.id) { settings.routeId = routes[0].id; saveSettings(); }
  renderRouteList(); showRoute();
}

function infoBox(msg) {
  const el = $('lobby-msg');
  el.textContent = msg; el.hidden = false; el.classList.add('info');
  clearTimeout(alertBox.t);
}
function alertBox(msg) {
  const el = $('lobby-msg');
  el.textContent = msg; el.hidden = false; el.classList.remove('info');
  clearTimeout(alertBox.t); alertBox.t = setTimeout(() => { el.hidden = true; }, 6000);
}

// your own workouts: imported from .zwo files or made in the builder (#28, #36)
const MY_KEY = 'gruppetto.workouts';
let myWorkouts = (() => { try { return JSON.parse(localStorage.getItem(MY_KEY) || '[]'); } catch { return []; } })();
const saveMyWorkouts = () => { try { localStorage.setItem(MY_KEY, JSON.stringify(myWorkouts)); } catch { /* storage full or blocked */ } };
const allWorkouts = () => [...icuWorkouts, ...myWorkouts, ...workouts];

/** Today's and tomorrow's workouts from the intervals.icu calendar, right in the lobby. */
function renderPlan() {
  // today's planned workout is the Workout card among the modes; the rest of the plan is in the Workouts menu
  if ($('plan-box')) $('plan-box').hidden = true;
}

/** Mode: free ride, or a workout picked in its own menu. */
function renderModes() {
  renderPlan();
  const ml = $('mode-list');
  ml.innerHTML = '';
  // the workout card: the one picked, else today's from the intervals.icu plan, else the last one ridden
  // ... and not one already ridden today here (when intervals.icu has not heard of the ride yet)
  const riddenToday = new Set(history.filter((e) => e.eventId && localDate(new Date(e.date)) === localDate(new Date())).map((e) => String(e.eventId)));
  const todayPlan = icuWorkouts.find((x) => dayLabel(x.date) === 'today' && !riddenToday.has(String(x.eventId))) || null;
  const w = allWorkouts().find((x) => x.id === settings.mode) || todayPlan
    || allWorkouts().find((x) => x.id === settings.lastWorkout) || null;
  const free = document.createElement('button');
  free.className = 'option';
  free.dataset.id = 'free';
  free.innerHTML = `<b>${tr('Free ride')}</b><small>${tr('The trainer simulates the road grade.')}</small>`;
  free.onclick = () => { settings.mode = 'free'; saveSettings(); renderModes(); };
  const wb = document.createElement('button');
  wb.className = 'option wk-pick';
  wb.dataset.id = 'workout';
  wb.innerHTML = w
    ? `${w.source === 'intervals' && dayLabel(w.date) === 'today' ? `<span class="tag plan-day today">${tr('Today · intervals.icu')}</span>` : ''}<span class="wk-pick-head"><b>${esc(w.name)}</b><span class="wk-change">${tr('Workouts')} ›</span></span><small>${Math.round(totalDuration(w) / 60)} ${U.min} · ${esc(w.description)}</small><canvas></canvas>`
    : `<span class="wk-pick-head"><b>${tr('Workout')}</b><span class="wk-change">${tr('Choose')} ›</span></span><small>${tr('Structured intervals in ERG: the trainer holds the target power.')}</small>`;
  wb.onclick = (ev) => {
    if (w && !ev.target.closest('.wk-change')) { openWorkoutDetail(w); return; }
    openWorkoutMenu();
  };
  // race against the bots (#39): from the line, N laps or to the finish of a point-to-point route
  const r = routes.find((x) => x.id === settings.routeId) || routes[0];
  const race = document.createElement('button');
  race.className = 'option race-pick';
  race.dataset.id = 'race';
  const laps = settings.raceLaps || 1;
  race.innerHTML = `<span class="wk-pick-head"><b>🏁 ${tr('Race')}</b>${r?.oneWay ? '' : `<span class="race-laps">${[1, 2, 3, 5].map((n) => `<i data-laps="${n}" class="${n === laps ? 'on' : ''}">${n}</i>`).join('')} ${tr('laps')}</span>`}</span><small>${r?.oneWay ? tr('To the finish line against the bunch.') : tr('{km} km against the bunch, from a standing start.', { km: ((r?.length || 0) * laps / 1000).toFixed(1) })}</small>`;
  race.onclick = (ev) => {
    const l = ev.target.closest('[data-laps]');
    if (l) settings.raceLaps = Number(l.dataset.laps);
    settings.mode = 'race'; saveSettings(); renderModes();
  };
  // Watch & ride: a switch on top of the mode — the ride in a mini window over a film or the match, no 3D world
  const wr = document.createElement('button');
  wr.className = `option watch-pick${settings.watchRide ? ' sel' : ''}`;
  wr.dataset.id = 'watch';
  wr.hidden = !pipSupport();
  wr.innerHTML = `<span class="wk-pick-head"><b>📺 ${tr('Watch & ride')}</b><span class="watch-sw${settings.watchRide ? ' on' : ''}"><i></i></span></span><small>${tr('In a mini window over a film or the match; the 3D road is not loaded. Works with a workout too.')}</small>`;
  wr.onclick = () => { settings.watchRide = !settings.watchRide; saveSettings(); renderModes(); };
  ml.append(free, wb, race, wr);
  free.classList.toggle('sel', settings.mode === 'free');
  race.classList.toggle('sel', settings.mode === 'race');
  wb.classList.toggle('sel', !['free', 'race'].includes(settings.mode) && !!w && w.id === settings.mode);
  if (w) requestAnimationFrame(() => drawWorkoutChart(wb.querySelector('canvas'), w, -1));
  updateSummary();
}

/** The zone a workout spends most of its work in (past Z1, when it has more than recovery). */
function mainZone(w) {
  const t = new Map();
  for (const st of w.steps) {
    const p = stepWatts(st, 0.5, settings.ftp);
    if (p === null) continue;
    const z = powerZone(p / settings.ftp);
    t.set(z, (t.get(z) || 0) + st.dur);
  }
  // what the workout is for: the hardest zone it spends at least 15 % of its time in (a 40/20 is VO2max, not the
  // endurance of its warm-up); failing that, where most of the time goes
  const total = [...t.values()].reduce((a, b) => a + b, 0) || 1;
  const hard = [...t.entries()].filter(([z, d]) => z.z > 1 && d / total >= 0.15).sort((a, b) => b[0].z - a[0].z)[0]?.[0];
  return hard || [...t.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || powerZone(0.6);
}

/** A workout's card: where it comes from, its name, its numbers (time, TSS, IF, main zone), a line of description, its shape. */
function workoutCardHTML(w, tag) {
  const st = w.steps.length ? workoutStats(w, settings.ftp) : null, z = mainZone(w);
  const chip = (t, cls = '') => `<span class="wk-chip ${cls}">${t}</span>`;
  // a ramp test runs to failure: its full length (and so its TSS) is never ridden
  const chips = w.ramp ? [chip(tr('to failure')), chip(tr('sets your FTP'), 'wk-zone')].join('')
    : [chip(`⏱ ${Math.round(totalDuration(w) / 60)} ${U.min}`), st?.tss ? chip(`TSS ${st.tss}`) : '', st?.if ? chip(`IF ${st.if.toFixed(2)}`) : '', chip(`Z${z.z} ${tr(z.name)}`, 'wk-zone')].join('');
  const from = tag ? `<span class="tag${tag === 'mine' ? ' mine' : ''}">${tag === 'mine' ? tr('Mine') : `intervals.icu · ${esc(tag)}`}</span>` : '';
  return `${from}<b class="wk-name">${esc(w.name)}</b><span class="wk-chips">${chips}</span>${w.description ? `<small class="wk-desc">${esc(w.description)}</small>` : ''}<canvas class="wk-chart"></canvas>`;
}

/** The workout menu: planned intervals.icu workouts first, then the built-in ones. */
function openWorkoutMenu() {
  const menu = $('wk-menu'), list = $('wk-menu-list');
  // a page beside the rail, like the other sections
  menu.classList.add('as-page');
  $('drawer').hidden = true;
  markRail('workouts');
  menu.querySelector('.wk-menu-panel').scrollTop = 0;
  list.innerHTML = '';
  const add = (w, tag) => {
    const b = document.createElement('button');
    b.className = 'option';
    b.dataset.id = w.id;
    b.classList.add('wk-card');
    b.innerHTML = workoutCardHTML(w, tag);
    b.style.setProperty('--zc', mainZone(w).color);
    b.onclick = () => openWorkoutDetail(w);
    b.classList.toggle('sel', w.id === settings.mode);
    list.append(b);
    requestAnimationFrame(() => drawWorkoutChart(b.querySelector('canvas'), w, -1));
  };
  // three groups, each under its heading: your plan in intervals.icu, your own, and Gruppetto's (the FTP test first)
  const head = (text, note = '') => {
    const h = document.createElement('h3');
    h.className = 'wk-group-head';
    h.innerHTML = `${esc(text)}${note ? ` <small>${esc(note)}</small>` : ''}`;
    list.append(h);
  };
  if (icuWorkouts.length) { head(tr('Your plan'), 'intervals.icu'); for (const w of icuWorkouts) add(w, dayLabel(w.date)); }
  if (myWorkouts.length) { head(tr('Your workouts'), tr('imported and built')); for (const w of myWorkouts) add(w, 'mine'); }
  head(tr('Gruppetto workouts'));
  for (const w of [...workouts.filter((x) => x.ramp), ...workouts.filter((x) => !x.ramp)]) add(w);
  menu.hidden = false;
}
function closeWorkoutMenu() { $('wk-menu').hidden = true; }

/** Adds a workout of your own (or replaces the one with its id), and selects it. */
function addMyWorkout(w) {
  const i = myWorkouts.findIndex((x) => x.id === w.id);
  if (i >= 0) myWorkouts[i] = w; else myWorkouts.unshift(w);
  saveMyWorkouts();
  settings.mode = w.id; settings.lastWorkout = w.id; saveSettings();
  renderModes();
}

$('wk-import').onclick = () => $('wk-import-file').click();
$('wk-import-file').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  let n = 0, last = null;
  for (const f of files) {
    try {
      const w = parseZwo(await f.text());
      last = { id: `my:${Date.now()}-${n}`, source: 'mine', ...w, description: w.description || tr('Imported from {file}', { file: f.name }) };
      myWorkouts.unshift(last); n++;
    } catch (err) { toast(`${f.name}: ${tr(err.message)}`); }
  }
  if (!n) return;
  saveMyWorkouts();
  toast(n === 1 ? tr('Workout imported: {name}', { name: last.name }) : tr('{n} workouts imported', { n }));
  track('zwo-import');
  openWorkoutMenu();
  if (n === 1) openWorkoutDetail(last);
};
$('wk-new').onclick = () => { closeWorkoutMenu(); openBuilder(null); };

// ---------- Why Gruppetto: for a new rider ----------
const WHY_KEY = 'gruppetto-why-closed';
function renderWhy() {
  let closed = false;
  try { closed = !!localStorage.getItem(WHY_KEY); } catch { /* private mode */ }
  $('why-box').hidden = closed || history.length > 0;
}
$('why-close').onclick = () => { track('why', 'close'); try { localStorage.setItem(WHY_KEY, '1'); } catch { /* private mode */ } renderWhy(); };
$('why-zwo').onclick = () => { track('why', 'zwo'); $('wk-import-file').click(); };
$('why-icu').addEventListener('click', () => track('why', 'icu'));

// ---------- Workout builder (#36) ----------
// Blocks you can stack; each turns into steps. Percentages are of FTP, durations in minutes (intervals in seconds).
const BLOCKS = {
  warmup: { label: 'Warm-up', make: () => ({ min: 10, from: 45, to: 70 }) },
  steady: { label: 'Steady', make: () => ({ min: 10, pct: 75 }) },
  intervals: { label: 'Intervals', make: () => ({ reps: 5, onSec: 60, onPct: 120, offSec: 60, offPct: 55 }) },
  ramp: { label: 'Ramp', make: () => ({ min: 5, from: 60, to: 100 }) },
  free: { label: 'Free ride', make: () => ({ min: 5 }) },
  cooldown: { label: 'Cool-down', make: () => ({ min: 8, from: 65, to: 40 }) },
};
function blocksToSteps(blocks) {
  const steps = [];
  for (const b of blocks) {
    if (b.type === 'intervals') for (let i = 0; i < b.reps; i++) { steps.push({ dur: Math.round(b.onSec), power: b.onPct / 100 }, { dur: Math.round(b.offSec), power: b.offPct / 100 }); }
    else if (b.type === 'steady') steps.push({ dur: Math.round(b.min * 60), power: b.pct / 100 });
    else if (b.type === 'free') steps.push({ dur: Math.round(b.min * 60), free: true });
    else steps.push({ dur: Math.round(b.min * 60), power: b.from / 100, ...(b.to !== b.from ? { to: b.to / 100 } : {}) });
  }
  return steps.filter((s) => s.dur > 0);
}
/** Steps of an imported workout as blocks you can edit (on/off pairs back to back become Intervals). */
function stepsToBlocks(steps) {
  const out = [];
  for (let i = 0; i < steps.length;) {
    const s = steps[i];
    if (!s.free && s.to === undefined && i + 3 < steps.length) {
      const on = s, off = steps[i + 1];
      let reps = 1;
      while (i + reps * 2 + 1 < steps.length && [0, 1].every((k) => { const a = steps[i + reps * 2 + k], b = [on, off][k]; return a.dur === b.dur && a.power === b.power && a.to === undefined && !a.free; })) reps++;
      if (reps > 1 && !off.free && off.to === undefined) {
        out.push({ type: 'intervals', reps, onSec: on.dur, onPct: Math.round(on.power * 100), offSec: off.dur, offPct: Math.round(off.power * 100) });
        i += reps * 2; continue;
      }
    }
    if (s.free) out.push({ type: 'free', min: +(s.dur / 60).toFixed(2) });
    else if (s.to !== undefined) out.push({ type: i === 0 && s.to > s.power ? 'warmup' : i === steps.length - 1 && s.to < s.power ? 'cooldown' : 'ramp', min: +(s.dur / 60).toFixed(2), from: Math.round(s.power * 100), to: Math.round(s.to * 100) });
    else out.push({ type: 'steady', min: +(s.dur / 60).toFixed(2), pct: Math.round(s.power * 100) });
    i++;
  }
  return out;
}
let building = null;
function openBuilder(w) {
  building = w
    ? { id: w.id, name: w.name, description: w.description || '', blocks: w.blocks ? structuredClone(w.blocks) : stepsToBlocks(w.steps) }
    : { id: null, name: tr('My workout'), description: '', blocks: [{ type: 'warmup', ...BLOCKS.warmup.make() }, { type: 'intervals', ...BLOCKS.intervals.make() }, { type: 'cooldown', ...BLOCKS.cooldown.make() }] };
  $('wb-name').value = building.name;
  $('wb-desc').value = building.description;
  $('wb-add').innerHTML = Object.entries(BLOCKS).map(([k, v]) => `<button class="pill-btn" data-add="${k}">+ ${esc(tr(v.label))}</button>`).join('');
  renderBuilder();
  $('wk-builder').hidden = false;
}
function renderBuilder() {
  const B = building;
  const field = (i, key, label, unit, step = 1) => `<label>${label}<span><input type="number" step="${step}" min="0" data-i="${i}" data-k="${key}" value="${B.blocks[i][key]}">${unit}</span></label>`;
  $('wb-blocks').innerHTML = B.blocks.map((b, i) => {
    const f = b.type === 'intervals'
      ? field(i, 'reps', '×', '') + field(i, 'onSec', tr('on'), tr('s')) + field(i, 'onPct', '', '%') + field(i, 'offSec', tr('off'), tr('s')) + field(i, 'offPct', '', '%')
      : b.type === 'steady' ? field(i, 'min', '', U.min, 0.5) + field(i, 'pct', '', '%')
        : b.type === 'free' ? field(i, 'min', '', U.min, 0.5)
          : field(i, 'min', '', U.min, 0.5) + field(i, 'from', '', '%') + field(i, 'to', '→', '%');
    return `<li><b>${esc(tr(BLOCKS[b.type].label))}</b><div class="wb-fields">${f}</div><span class="wb-move"><button data-up="${i}" aria-label="Up">↑</button><button data-down="${i}" aria-label="Down">↓</button><button data-del="${i}" aria-label="Remove">✕</button></span></li>`;
  }).join('');
  const w = { name: B.name, steps: blocksToSteps(B.blocks) };
  const st = w.steps.length ? workoutStats(w, settings.ftp) : null;
  $('wb-stats').textContent = st ? `${fmtTime(st.dur)} · TSS ${st.tss} · IF ${st.if.toFixed(2)} · NP ${st.np} ${U.W}` : '';
  $('wb-save').disabled = !w.steps.length;
  requestAnimationFrame(() => { if (w.steps.length) drawWorkoutChart($('wb-chart'), w, -1); else $('wb-chart').getContext('2d').clearRect(0, 0, 9999, 9999); });
}
$('wb-blocks').addEventListener('input', (e) => {
  const el = e.target.closest('input[data-i]');
  if (!el) return;
  building.blocks[+el.dataset.i][el.dataset.k] = Math.max(0, Number(el.value) || 0);
  const w = { steps: blocksToSteps(building.blocks) };
  const st = w.steps.length ? workoutStats(w, settings.ftp) : null;
  $('wb-stats').textContent = st ? `${fmtTime(st.dur)} · TSS ${st.tss} · IF ${st.if.toFixed(2)} · NP ${st.np} ${U.W}` : '';
  if (w.steps.length) drawWorkoutChart($('wb-chart'), w, -1);
});
$('wb-blocks').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const B = building.blocks;
  if (t.dataset.del !== undefined) B.splice(+t.dataset.del, 1);
  else if (t.dataset.up !== undefined && +t.dataset.up > 0) { const i = +t.dataset.up; [B[i - 1], B[i]] = [B[i], B[i - 1]]; }
  else if (t.dataset.down !== undefined && +t.dataset.down < B.length - 1) { const i = +t.dataset.down; [B[i + 1], B[i]] = [B[i], B[i + 1]]; }
  else return;
  renderBuilder();
});
$('wb-add').addEventListener('click', (e) => {
  const k = e.target.closest('[data-add]')?.dataset.add;
  if (!k) return;
  const B = building.blocks, at = k === 'warmup' ? 0 : B.length && B[B.length - 1].type === 'cooldown' && k !== 'cooldown' ? B.length - 1 : B.length;
  B.splice(at, 0, { type: k, ...BLOCKS[k].make() });
  renderBuilder();
});
$('wb-save').onclick = () => {
  const B = building, steps = blocksToSteps(B.blocks);
  if (!steps.length) return;
  const w = { id: B.id || `my:${Date.now()}`, source: 'mine', name: $('wb-name').value.trim() || tr('My workout'), description: $('wb-desc').value.trim(), blocks: B.blocks, steps };
  addMyWorkout(w);
  $('wk-builder').hidden = true;
  toast(tr('Saved: {name}', { name: w.name }));
  openWorkoutDetail(w);
};
$('wk-builder').addEventListener('click', (e) => { if (e.target.closest('[data-wb-close]')) $('wk-builder').hidden = true; });

function chooseWorkout(w) {
  settings.mode = w.id; settings.lastWorkout = w.id; saveSettings();
  closeWorkoutDetail(); closeWorkoutMenu(); renderModes();
}

/** [lo, hi] watts of a range step at this intensity, or null. */
function stepBand(s, intensity = settings.intensity) {
  const r = s && (s.rangeW || (s.range && s.range.map((f) => f * settings.ftp)));
  return r ? r.map((v) => Math.round((v * intensity) / 100)) : null;
}

/** "62–65 % · 150–158 W", "40 → 62 %", "Free" for one step. */
function stepTarget(s) {
  const ftp = settings.ftp, pct = (x) => Math.round((x / ftp) * 100);
  if (s.free) return tr('Free ride');
  const range = s.rangeW || (s.range && s.range.map((f) => f * ftp));
  if (range) { const [lo, hi] = range.map((v) => scaleW(Math.round(v))); return `${lo}–${hi} ${U.W} <small>${pct(lo)}–${pct(hi)} %</small>`; }
  const a = scaleW(stepWatts(s, 0, ftp)), b = scaleW(stepWatts(s, 1, ftp));
  return a === b ? `${a} ${U.W} <small>${pct(a)} %</small>` : `${a} → ${b} ${U.W} <small>${pct(a)} → ${pct(b)} %</small>`;
}

const fmtDur = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}` : sec % 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec / 60} ${U.min}`);

/** A workout on its own page: chart, numbers, the coach's notes and every interval, then Ride. */
function openWorkoutDetail(w) {
  const ftp = settings.ftp;
  const st = workoutStats(w, ftp);
  const k = settings.intensity / 100;
  const day = w.date ? dayLabel(w.date) : null;
  $('wkd-tag').innerHTML = w.source === 'intervals' ? `<span class="tag">intervals.icu${day ? ` · ${esc(day === 'today' ? tr('Today') : day === 'tomorrow' ? tr('Tomorrow') : day)}` : ''}</span>` : '';
  $('wkd-name').textContent = w.name;
  const stat = (label, v) => `<div><label>${label}</label><b>${v}</b></div>`;
  $('wkd-stats').innerHTML = stat(tr('Time'), fmtTime(st.dur))
    + stat('TSS', Math.round(st.tss * k * k))
    + stat('IF', (st.if * k).toFixed(2))
    + stat(tr('Avg'), `${Math.round(st.avg * k)} ${U.W}`)
    + stat('NP', `${Math.round(st.np * k)} ${U.W}`)
    + (settings.intensity !== 100 ? stat(tr('Intensity'), `${settings.intensity}%`) : '');
  $('wkd-notes').textContent = w.notes || w.description || '';
  // every interval, repeats folded: "4 ×" over the steps that repeat back to back
  const key = (s) => JSON.stringify([s.dur, s.power, s.to, s.watts, s.wattsTo, s.range, s.rangeW, s.free, s.text]);
  const rows = [];
  let t0 = 0;
  for (let i = 0; i < w.steps.length;) {
    let folded = false;
    for (let len = 1; len <= 4 && !folded; len++) {
      let reps = 1;
      while (i + (reps + 1) * len <= w.steps.length && w.steps.slice(i + reps * len, i + (reps + 1) * len).every((s, j) => key(s) === key(w.steps[i + j]))) reps++;
      if (reps > 1) {
        rows.push({ reps, t: t0, steps: w.steps.slice(i, i + len) });
        t0 += reps * w.steps.slice(i, i + len).reduce((a, s) => a + s.dur, 0);
        i += reps * len; folded = true;
      }
    }
    if (!folded) { rows.push({ reps: 1, t: t0, steps: [w.steps[i]] }); t0 += w.steps[i].dur; i++; }
  }
  const li = (s, t) => {
    const mid = scaleW(stepWatts(s, 0.5, ftp));
    const col = s.free || mid === null ? '#64748b' : zoneColor(mid / ftp);
    return `<li><i style="background:${col}"></i><span class="t">${t === null ? '' : fmtTime(t)}</span><span class="d">${fmtDur(s.dur)}</span><span>${stepTarget(s)}${s.cad ? ` <small>· ${Array.isArray(s.cad) ? s.cad.join('–') : s.cad} ${U.rpm}</small>` : ''}${s.text ? ` <small>· ${esc(s.text)}</small>` : ''}</span></li>`;
  };
  // a plan from intervals.icu spells its steps out in its description: the list would only say it again
  const spelled = w.source === 'intervals' && !!w.description;
  $('wkd-steps').hidden = $('wkd-steps-h').hidden = spelled;
  $('wkd-steps').innerHTML = rows.map((r) => (r.reps > 1
    ? `<li class="x"><span></span><span class="t">${fmtTime(r.t)}</span><span>${r.reps} ×</span><span></span></li>${r.steps.map((s) => li(s, null)).join('')}`
    : li(r.steps[0], r.t))).join('');
  const total = totalDuration(w);
  $('wkd-axis').innerHTML = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span>${fmtTime(Math.round(total * f))}</span>`).join('');
  $('wkd-select').onclick = () => chooseWorkout(w);
  const mine = myWorkouts.includes(w);
  $('wkd-edit').hidden = !mine;
  $('wkd-delete').hidden = !mine;
  $('wkd-delete').textContent = tr('Delete');
  $('wkd-edit').onclick = () => { closeWorkoutDetail(); openBuilder(w); };
  $('wkd-delete').onclick = () => {
    const b = $('wkd-delete');
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = tr('Tap again to delete'); return; }
    b.dataset.armed = '';
    myWorkouts = myWorkouts.filter((x) => x !== w); saveMyWorkouts();
    if (settings.mode === w.id) { settings.mode = 'free'; saveSettings(); }
    closeWorkoutDetail(); openWorkoutMenu(); renderModes();
  };
  $('wkd-zwo').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toZwo(w)], { type: 'application/xml' }));
    a.download = `${(w.name || 'workout').replace(/[^\w\- ]+/g, '').trim() || 'workout'}.zwo`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('wkd-ride').onclick = () => { chooseWorkout(w); startRide(); };
  $('wkd-select').textContent = settings.mode === w.id ? tr('Selected ✓') : tr('Select');
  $('wk-detail').hidden = false;
  requestAnimationFrame(() => drawWorkoutChart($('wkd-chart'), w, -1));
}
function closeWorkoutDetail() { $('wk-detail').hidden = true; }

/** The selected route, large, at the top of the lobby. */
function showRoute() {
  // OpenStreetMap's licence (ODbL) asks for the attribution wherever its data shows: a route built with its map
  const r = routes.find((x) => x.id === settings.routeId) || routes[0];
  $('osm-attr').hidden = !r?.land;
  renderGhostPicker();
  updateSummary();
}

/** "Rolling Hills · Sweet Spot 3×10" above the Ride button. */
function updateSummary() {
  const el = $('ride-summary');
  if (!el) return;
  renderGreeting(); renderAvatar();
  const r = routes.find((x) => x.id === settings.routeId);
  const sel = document.querySelector('#mode-list .sel b');
  const raceLaps = settings.mode === 'race' && r && !r.oneWay ? ((settings.raceLaps || 1) === 1 ? tr('1 lap') : tr('{n} laps', { n: settings.raceLaps })) : null;
  const g = r && rideGhost(r.id);
  const free = settings.mode === 'free';
  const pacer = free && settings.freePacer ? `🚴 ${settings.pacerName?.trim() || tr('Pacer')} ${settings.freePacerWkg} ${U.wkg}` : null;
  el.textContent = [r?.name, sel?.textContent, raceLaps, settings.mode !== 'race' && g ? (g.friend ? tr('against {name}', { name: g.name || tr('a friend') }) : settings.ghost === 'last' ? tr('against your last ride') : tr('against your best ride')) : null, pacer].filter(Boolean).join(' · ');
}

/** Side drawer with Devices, Profile and intervals.icu, opened from the top bar. */
function openDrawer(panel) {
  // intervals.icu lives on the Profile page now: asked for, the page opens at it
  const atIcu = panel === 'icu';
  if (atIcu) panel = 'profile';
  const drawer = $('drawer');
  drawer.hidden = false;
  drawer.classList.toggle('in-ride', !!ride);
  // in the lobby a section is a page beside the rail; mid-ride it slides over the road
  drawer.classList.toggle('as-page', !ride);
  if (!ride) { $('wk-menu').hidden = true; drawer.querySelector('.drawer-panel').scrollTop = 0; }
  for (const c of drawer.querySelectorAll('[data-panel]')) c.hidden = c.dataset.panel !== panel;
  if (panel === 'progress') { renderPowerCurve(); renderFitness(); } // their charts need the panel on screen to size themselves
  for (const t of drawer.querySelectorAll('.drawer-tabs [data-open]')) t.classList.toggle('sel', t.dataset.open === panel);
  markRail(panel);
  if (atIcu) requestAnimationFrame(() => $('icu-card').scrollIntoView({ block: 'start' }));
}
/** The rail lights the section open in the drawer, and Ride again once it closes. */
function markRail(panel) {
  for (const b of document.querySelectorAll('.rail .rail-btn')) b.classList.toggle('on', panel ? (b.dataset.open || b.dataset.page) === panel : b.hasAttribute('data-home'));
}
// a page closes by Escape, Ride in the rail, or another page: the rail follows
const railFollow = new MutationObserver(() => { if ($('drawer').hidden && $('wk-menu').hidden) markRail(null); });
for (const id of ['drawer', 'wk-menu']) railFollow.observe($(id), { attributes: true, attributeFilter: ['hidden'] });

function initDrawer() {
  const drawer = $('drawer');
  const open = openDrawer;
  for (const el of document.querySelectorAll('#lobby [data-open], #drawer [data-open]')) el.addEventListener('click', () => open(el.dataset.open));
  for (const el of drawer.querySelectorAll('[data-close]')) el.addEventListener('click', () => { drawer.hidden = true; });
  window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && !drawer.hidden) drawer.hidden = true; });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape') return;
    if (!$('wk-detail').hidden) closeWorkoutDetail(); else if (!$('wk-menu').hidden) closeWorkoutMenu();
  });
  $('wk-detail').addEventListener('click', (e) => { if (e.target.closest('[data-wkd-close]')) closeWorkoutDetail(); });
  $('wk-menu').addEventListener('click', (e) => { if (e.target.closest('[data-wk-close]')) closeWorkoutMenu(); });
  // first visit with nothing to ride on: show the devices
  if (!trainer.connected && !$('sim').checked && !localStorage.getItem('powerup-seen-drawer')) {
    try { localStorage.setItem('powerup-seen-drawer', '1'); } catch { /* private mode */ }
    open('devices');
  }
}

function markSelected(list, id) {
  for (const el of list.children) el.classList.toggle('sel', el.dataset.id === id);
}

// ---------- Ride ----------
// The bunch: a new one every ride, drawn from these names and kits (English spelling, Ukrainian)
const BOT_NAMES = [
  ['Andriy', 'Андрій'], ['Taras', 'Тарас'], ['Dmytro', 'Дмитро'], ['Bohdan', 'Богдан'], ['Oleh', 'Олег'], ['Mykola', 'Микола'],
  ['Serhiy', 'Сергій'], ['Yaroslav', 'Ярослав'], ['Ivan', 'Іван'], ['Ostap', 'Остап'], ['Roman', 'Роман'], ['Vitaliy', 'Віталій'],
  ['Yuriy', 'Юрій'], ['Maksym', 'Максим'], ['Artem', 'Артем'], ['Nazar', 'Назар'], ['Pavlo', 'Павло'], ['Ihor', 'Ігор'],
  ['Denys', 'Денис'], ['Volodymyr', 'Володимир'], ['Mykhailo', 'Михайло'], ['Danylo', 'Данило'], ['Stepan', 'Степан'], ['Kyrylo', 'Кирило'],
];
const BOT_KITS = [
  ['#e5484d', '#ffffff'], ['#2563eb', '#facc15'], ['#8b5cf6', '#f0f0f0'], ['#f5f5f5', '#16a34a'], ['#111827', '#f97316'],
  ['#0ea5e9', '#0f172a'], ['#f59e0b', '#1f2937'], ['#14b8a6', '#ffffff'], ['#db2777', '#fde68a'], ['#65a30d', '#f8fafc'],
  ['#7c2d12', '#fbbf24'], ['#1e3a8a', '#ef4444'],
];
/**
 * A bunch of `n` riders around your level: their steady pace is 55-95 % of your FTP in W/kg (so on
 * a free ride some are a little slower than you, some a little faster), each with his own weight,
 * build (air drag from height and weight), cadence and kit; names and kits never repeat in a ride.
 */
function makeBots(n, { race = false } = {}) {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr.splice(Math.floor(Math.random() * arr.length), 1)[0];
  const names = BOT_NAMES.slice(), kits = BOT_KITS.filter(([c]) => c.toLowerCase() !== String(settings.jersey).toLowerCase());
  const ftpWkg = Math.max(1.5, settings.ftp / Math.max(40, settings.weight));
  return Array.from({ length: n }, (_, i) => {
    const [en, uk] = pick(names), [color, stripe] = pick(kits.length ? kits : BOT_KITS.slice());
    const weight = Math.round(rnd(60, 88)), height = Math.round(165 + (weight - 60) * 0.9 + rnd(-6, 6));
    // spread evenly across the range, then shuffled by the random start order
    // a ride: 55–95 % of your FTP in W/kg; a race: 82–108 %, so some of them are stronger than you
    const level = (race ? 0.82 : 0.55) + (n > 1 ? i / (n - 1) : 0.5) * (race ? 0.26 : 0.4) + rnd(-0.04, 0.04);
    return {
      name: lang === 'uk' ? uk : en, color, stripe, weight, cda: riderCdA(height, weight),
      wkg: Math.round(ftpWkg * level * 10) / 10, rpm: Math.round(rnd(82, 98)), phase: rnd(0, 6.28),
      climber: race && Math.random() < 0.4, // attacks on the climbs
    };
  }).sort(() => Math.random() - 0.5);
}
/**
 * A rider's cadence, like a person's: their own rpm on the flat, slower as the road tilts up (about
 * 2.5 rpm per % up to 8 %+), a little faster on a gentle descent, freewheeling now and then on a
 * steep one, and never quite steady. `r` keeps the eased value between frames.
 */
/** Coasting: the cranks settle level (crank angle a multiple of π), as a rider rests on the pedals. */
function levelPedals(pedal, dt) {
  const target = Math.round(pedal / Math.PI) * Math.PI;
  return pedal + (target - pedal) * Math.min(1, dt * 3);
}
function liveCadence(r, base, grade, t, dt, seed = 0) {
  let target = base - Math.max(0, Math.min(0.1, grade)) * 250 + (grade < 0 && grade > -0.03 ? -grade * 150 : 0);
  target += Math.sin(t * 0.37 + seed * 1.7) * 2.5 + Math.sin(t * 1.3 + seed) * 1.2;
  if (grade <= -0.035 && Math.sin(t * 0.21 + seed) > -0.2) target = 0; // coasting most of a steep descent
  const cur = r.cad ?? target;
  r.cad = cur + (target - cur) * Math.min(1, dt * (target === 0 || cur < 5 ? 2.5 : 0.7));
  return Math.max(0, r.cad < 3 ? 0 : r.cad);
}
// Riders keep right: start in the right half of the road (positive lane = right of travel).
const START_LANE = 1.2;

let ride = null;
let rideTimer = null;
let scene = null;
let sceneKind = null;

/** Creates the 3D or 2D renderer (a canvas can hold only one kind of context). */
function applySceneSettings() {
  scene.setStyle?.(settings.style);
  scene.setQuality?.(settings.quality);
  scene.setAtmosphere?.(settings.timeOfDay, settings.weather);
  scene.setCamera?.(settings.camera);
}
async function ensureScene() {
  let want = '3d'; // 2D only as a fallback when the browser has no WebGL
  if (want === sceneKind) { scene.resize(); scene.restart?.(); return; }
  const old = $('scene');
  const canvas = old.cloneNode(false);
  old.replaceWith(canvas);
  if (want === '3d') {
    try {
      const { Scene3D, webglAvailable } = await import('./render3d.js');
      if (!webglAvailable()) throw new Error('WebGL is not available');
      scene = new Scene3D(canvas);
    } catch (e) {
      console.warn('3D unavailable, falling back to 2D', e);
      toast(tr('3D graphics are not available in this browser — using 2D'));
      want = '2d';
      const fresh = canvas.cloneNode(false);
      canvas.replaceWith(fresh);
      scene = new Scene(fresh);
    }
  } else {
    scene = new Scene(canvas);
  }
  sceneKind = want;
}
const recorder = new Recorder();

// ---------- Wind (#50) ----------
const WIND_SPEED = { off: 0, light: 3, moderate: 6, strong: 9 }; // m/s: 11, 22, 32 km/h
/** The way the road runs at distance d, as an angle on the map (the minimap's coordinates). */
function routeHeading(route, d) {
  const { pts, step } = routeShape(route), L = route.length;
  const at = (x) => {
    const dd = route.oneWay ? Math.max(0, Math.min(L, x)) : ((x % L) + L) % L;
    const f = dd / step, i = Math.min(pts.length - 2, Math.floor(f)), t = f - i;
    return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
  };
  const [ax, ay] = at(d + 15), [bx, by] = at(d - 15);
  return Math.atan2(ay - by, ax - bx);
}
/** This moment's wind for you: gusts round the set strength, split into head- and crosswind as the road turns. */
/** The wind's strength for this ride, m/s: none in a workout. */
function windBase() {
  // only in a race: there the wind is tactics (shelter in the bunch, attack into a headwind); in a free ride or a
  // workout it only slows you down
  return ride?.race ? WIND_SPEED[settings.wind] ?? 0 : 0;
}
function updateWind() {
  const W = ride.wind;
  if (!W) return;
  const t = ride.elapsed;
  W.speed = W.base * (1 + 0.18 * Math.sin(t / 7.3) + 0.08 * Math.sin(t / 2.1 + 1.3));
  const h = routeHeading(ride.route, ride.dist);
  const c = windComponents(W.speed, W.toward, h);
  W.head = c.head; W.cross = c.cross;
  W.rel = W.toward - h; // where it blows, relative to the way you ride (0 = straight ahead with you)
}
/** The wind in the top bar: an arrow the way it blows (up = with you) and its speed. */
function updateWindHud() {
  const W = ride.wind, cell = $('wind-cell');
  cell.hidden = !W?.base;
  if (cell.hidden) { scene?.setWind?.(0); return; }
  $('wind-arrow').style.transform = `rotate(${W.rel}rad)`;
  $('m-wind').textContent = Math.round(W.speed * 3.6);
  const kind = W.head > W.speed * 0.5 ? 'head' : W.head < -W.speed * 0.5 ? 'tail' : 'cross';
  cell.dataset.kind = kind;
  cell.title = tr({ head: 'Headwind', tail: 'Tailwind', cross: 'Crosswind' }[kind]);
  scene?.setWind?.(W.speed);
}

// ---------- Before the start: are the sensors in? ----------
const DEVICE_LABEL = { trainer: 'Trainer', hr: 'Heart rate', cad: 'Cadence', ctl: 'Controllers', obc: 'OpenBikeControl' };
/**
 * The sensors you use (connected now, or remembered from an earlier ride), each ready or not:
 * [{ name, ok, note }]. A trainer you are not using (simulator ticked) is left out.
 */
function preflightChecklist() {
  const out = [];
  for (const d of DEVICES) {
    if (d.key === 'trainer' && $('sim').checked) continue;
    if (!d.dev.connected && !settings.devices?.[d.key]) continue;
    const name = tr(DEVICE_LABEL[d.key]);
    if (!d.dev.connected) { out.push({ name, ok: false, note: reconnecting.has(d.key) ? tr('reconnecting…') : tr('not connected yet') }); continue; }
    if (d.dev === hrm && !fresh(live.hr, live.hrAt)) { out.push({ name, ok: false, note: tr('connected, waiting for a reading…') }); continue; }
    out.push({ name, ok: true, note: d.dev === hrm ? `❤ ${fresh(live.hr, live.hrAt)} ${U.bpm}` : d.dev === trainer ? `${Math.round(fresh(live.power, live.powerAt))} ${U.W}` : tr('connected') });
  }
  return out;
}
/** Resolves true to ride (all ready, or "Ride anyway"), false to stay in the lobby. */
function preflight() {
  if (preflightChecklist().every((c) => c.ok)) return Promise.resolve(true);
  if (bluetoothAvailable()) autoConnectRemembered({ quiet: true }).catch(() => {});
  return new Promise((resolve) => {
    const box = $('preflight');
    const done = (go) => { clearInterval(timer); box.hidden = true; resolve(go); };
    const draw = () => {
      const list = preflightChecklist();
      $('preflight-list').innerHTML = list.map((c) => `<li class="${c.ok ? 'ok' : 'wait'}"><i></i><b>${esc(c.name)}</b><span>${esc(c.note)}</span></li>`).join('');
      if (list.every((c) => c.ok)) { clearInterval(timer); setTimeout(() => { toast(tr('All sensors ready')); done(true); }, 700); } // a moment to see the last tick
    };
    const timer = setInterval(draw, 500);
    draw();
    box.hidden = false;
    $('preflight-go').onclick = () => done(true);
    $('preflight-cancel').onclick = () => { done(false); openDrawer('devices'); };
  });
}

/** Opened as an installed app (its own window), not in a browser tab. */
const installedApp = () => matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: fullscreen)').matches;

async function startRide() {
  // Watch & ride (#watch): the mini window opens now, while the click counts, and the 3D world is not even loaded
  const watching = settings.watchRide && pipSupport();
  const pipAsk = watching && !pipOpen() ? openMini() : null;
  // the installed app rides full screen: no title bar over the road (asked now, while the click counts)
  const wentFull = watching ? false : installedApp() && !document.fullscreenElement && document.documentElement.requestFullscreen?.().then(() => true, () => false);
  if (!(await preflight())) { if (await wentFull) document.exitFullscreen?.().catch(() => {}); if (pipAsk) closePip(); return; }
  if (await wentFull) rideFullscreen = true;
  const route = routes.find((r) => r.id === settings.routeId) || routes[0];
  const workout = allWorkouts().find((w) => w.id === settings.mode) || null;
  const simulated = $('sim').checked || !trainer.connected;
  const racing = settings.mode === 'race';
  const laps = route.oneWay ? 1 : Math.max(1, settings.raceLaps || 1);
  ride = {
    route, workout, simulated,
    dist: 0, v: 0, elapsed: 0, secAcc: 0, workoutT: 0, workoutDone: false,
    gain: 0, lastElev: route.elevAt(0), laps: 0, lapStartT: 0, lapTimes: [], efforts: [], seg: null, prevDist: 0,
    hold: null, splits: [], splitFrom: { t: 0, d: 0, i: 0 }, // free ride: power held in ERG, manual laps
    paused: false, pedal: 0, lastSim: performance.now(), moved: 0,
    powerHist: [], wbal: wPrimeJ(), wbalMin: wPrimeJ(), target: null, lastSentTarget: null, lastSentGrade: null, lastGradeSentAt: 0,
    cda: riderCdA(settings.height, settings.weight), // air drag from your height and weight
    gear: DEFAULT_GEAR, ergBias: 0, ergFactor: 1, lowFor: 0, lastSentWheel: null, shiftMode: settings.shiftMode, lane: START_LANE, laneTarget: START_LANE,
    bots: racing
      // on the start line: a grid of rows of three across the road, just behind you
      ? makeBots(Math.max(5, settings.bots || 5), { race: true }).map((b, i) => {
        const lane = [-2.0, -0.4, 2.0][i % 3], home = lane;
        return { ...b, dist: -1.6 - Math.floor(i / 3) * 1.9, v: 0, pedal: i, lane, home, laneTarget: lane };
      })
      : makeBots(settings.bots ?? 5).map((b, i) => ({ ...b, dist: 15 + i * 12, v: 0, pedal: i, lane: i % 2 ? -1.6 : 1.6, home: i % 2 ? -1.6 : 1.6, laneTarget: i % 2 ? -1.6 : 1.6 })),
    race: racing ? { laps, distance: route.length * laps, countdown: 5, go: false, finish: new Map(), done: false } : null,
    // workout pacer: a virtual training partner riding the target power exactly, at your weight
    ghost: racing ? null : (() => { const g = rideGhost(route.id); return g ? { entry: g, name: ghostLabel(g), color: settings.jersey, stripe: settings.stripe, bike: settings.bikeColor || null, dist: 0, pedal: 0.3, lane: START_LANE - 1.3, ghost: true } : null; })(),
    // free-ride pacer (#27): steady at the W/kg you set, waiting at the foot of each climb
    pacer: racing ? null : { name: settings.pacerName?.trim() || tr('Pacer'), color: '#facc15', stripe: '#111827', dist: 0, v: 0, pedal: 0.5, lane: -0.5, pacer: true, free: !workout },
  };
  if (workout?.ramp) { toast(tr('Ramp test: hold each step as long as you can. Gruppetto sees when you stop and gives your FTP')); cueSay('Ramp test. Hold each step as long as you can.'); }
  track('ride-start', [racing ? 'race' : workout?.ramp ? 'ramp' : workout ? 'workout' : 'free', ride.ghost?.entry?.friend ? 'challenge' : '', simulated ? 'sim' : 'trainer'].filter(Boolean).join('-'));
  ride.devs = new Set(DEVICES.filter((d) => d.dev.connected).map((d) => d.key)); // what to keep connected through the ride
  // on the grid in the first row with the bunch, the front wheel just behind the line (the bike is ~1.7 m long)
  if (racing) { ride.lane = ride.laneTarget = 0.8; ride.laneHome = 0.8; ride.dist = -1.6; }
  // the wind (#50): a strength from Settings, a direction picked for this ride, gusting a little; races only
  ride.wind = { base: windBase(), toward: Math.random() * Math.PI * 2, speed: 0, head: 0, cross: 0, rel: 0 };
  if (workout) ride.target = ergTarget(targetAt(workout, 0, settings.ftp));
  unlockAudio();
  $('wk-int').textContent = `${settings.intensity}%`;
  trainer.riderWeight = settings.weight + 8;
  trainer.resetMode();
  recorder.reset();
  updateGear();
  $('lobby').hidden = true;
  $('summary').hidden = true;
  $('ride').hidden = false;
  $('sim-ctl').hidden = !simulated;
  $('workout-panel').hidden = !workout;
  $('wk-intensity').hidden = !workout;
  $('wk-steps').hidden = !workout;
  $('race-board').hidden = !racing;
  $('countdown').hidden = !racing;
  $('minimap-box').classList.toggle('big', !!settings.bigMap); $('minimap-size').textContent = settings.bigMap ? '⤡' : '⤢'; // as you left it
  ride.stepStats = [];
  $('wk-pacer-btn').classList.toggle('on', settings.pacer === true);
  $('wk-erg-btn').classList.add('on'); // every workout starts in ERG
  $('paused').hidden = true;
  $('btn-pause').textContent = tr('Pause');
  $('ride').classList.remove('show-controls');
  if (watching && (await pipAsk) !== false) {
    ride.noScene = true; // the road is not built; «Show the road» builds it
    track('watch-ride');
  } else {
    await ensureScene();
    applySceneSettings();
  }
  ride.lastSim = performance.now();
  clearInterval(rideTimer);
  rideTimer = setInterval(() => advance(), 250);
  resetPip();
  keepAwake(true);
  if (simulated) toast(tr('Simulator mode: set power with the slider or ↑/↓'));
  const touch = matchMedia('(pointer: coarse)').matches;
  if (scene?.orbit && !ride.noScene) setTimeout(() => toast(touch ? tr('Camera: drag to turn, pinch to zoom, double-tap to reset') : tr('Camera: drag to orbit, scroll to zoom, double-click to reset')), simulated ? 3500 : 0);
  requestAnimationFrame(frame);
}

/** Power (W) for physics at time t: the trainer's reading averaged over the last second. */
function powerAt(t) {
  if (ride.simulated) {
    if (inErgStep()) return ride.target; // ERG holds the target; with ERG off the slider is your legs
    return Number($('sim-power').value);
  }
  return powerSamples.mean(t - 1000, t);
}

function cadenceAt(t, power) {
  if (ride.simulated) return power > 0 ? 88 + Math.sin(ride.elapsed / 7) * 4 : 0;
  return cadenceSamples.mean(t - 1000, t);
}

const hrAt = (t) => hrSamples.latest(t);

const MAX_GAP_S = 15;

/**
 * Advances the ride to wall-clock time `now`: physics in small steps and one recorded sample per
 * elapsed second. Driven by animation frames, a timer and incoming trainer data, so a hidden tab or
 * a stalled frame never loses time. A long gap with no trainer data (laptop asleep, sensor lost)
 * is skipped instead of being recorded as zeros.
 */
function advance(now = performance.now()) {
  if (!ride) return;
  const from = ride.lastSim;
  let left = (now - from) / 1000;
  ride.lastSim = now;
  if (left <= 0 || ride.paused) return;
  if (left > MAX_GAP_S && !ride.simulated && !powerSamples.has(from, now)) {
    toast(tr('No data from the trainer for {s} s — this gap was skipped', { s: Math.round(left) }));
    return;
  }
  const { route } = ride;
  let t = from;
  if (ride.race && !ride.race.go) { // on the line: the clock waits for the start
    if (!scene?.warming) ride.race.countdown -= left; // not while the world is still loading behind the loader
    t += left * 1000;
    if (ride.race.countdown <= 0) { ride.race.go = true; ride.race.t0 = ride.elapsed; cueBeep(1320, 0.45); }
    left = 0;
  }
  updateWind();
  const W = ride.wind || { head: 0, cross: 0 };
  while (left > 1e-6) {
    const dt = Math.min(0.1, left, 1 - ride.secAcc);
    t += dt * 1000;
    const power = powerAt(t);
    const cadence = cadenceAt(t, power);
    const grade = route.gradeAt(ride.dist);
    // drafting: the shelter of the riders ahead (deeper in a bunch), and a little from one close behind
    const pack = [...ride.bots, ...(pacerOn() ? [ride.pacer] : [])];
    ride.draft = packDraft(pack.map((o) => ({ gap: o.dist - ride.dist, sideways: o.lane - ride.lane })), W.cross);
    ride.v = stepSpeed(ride.v, power, grade, dt, settings.weight, { cda: ride.cda * (1 - ride.draft), wind: W.head });
    // your speed on your own, out of the wind shadow: faster than the wheel ahead -> you come past it,
    // otherwise you sit in and draft
    ride.vFree = stepSpeed(ride.vFree ?? ride.v, power, grade, dt, settings.weight, { cda: ride.cda, wind: W.head });
    // on a wheel: no riding into the back of the rider ahead (the overtake logic swings you out instead)
    for (const o of pack) if (Math.abs(o.lane - ride.lane) < 0.8) ride.v = Math.min(ride.v, wheelCap(o.dist - ride.dist, o.v ?? ride.v));
    ride.heldFor = heldBy(ride, pack, dt);
    const moved = ride.v * dt;
    if (ride.race && !ride.race.done && ride.dist < ride.race.distance && ride.dist + moved >= ride.race.distance) {
      ride.race.myTime = ride.elapsed - ride.race.t0 + dt * (ride.race.distance - ride.dist) / Math.max(1e-6, moved);
      ride.race.done = true;
      raceFinished();
    }
    ride.dist += moved;
    ride.moved += moved;
    // never into the back of a wheel in your line: at most up to it (a bike's length), at its speed
    ride.dist = behindWheels(ride, ride.dist, pack);
    // Pedal animation only: trainers like the KICKR CORE derive cadence from the flywheel and report
    // 0–1 rpm at low speed, so while there is power the legs keep turning at a plausible rate.
    const animCadence = cadence >= 20 ? cadence : power > 5 ? Math.max(cadence, 60) : cadence;
    ride.pedal = animCadence < 5 ? levelPedals(ride.pedal, dt) : ride.pedal + (animCadence / 60) * Math.PI * 2 * dt;
    ride.lane = ride.autoLane ? easeLane(ride.lane, ride.laneTarget, dt, ride) : ride.lane + (ride.laneTarget - ride.lane) * Math.min(1, dt * 4);
    ride.lane = keepApart(ride, ride.lane, [...ride.bots, ...(pacerOn() ? [ride.pacer] : [])]);
    if (ride.ghost) {
      const G = ride.ghost, before = G.dist;
      G.dist = ghostDistAt(G.entry, ride.elapsed + dt);
      G.power = G.entry.chart.pw[Math.min(G.entry.chart.pw.length - 1, Math.floor((ride.elapsed + dt) / G.entry.chart.every))] || 0;
      G.pedal += ((G.dist > before ? 88 : 0) / 60) * Math.PI * 2 * dt;
    }
    if (ride.climbGhost && ride.seg) {
      const G = ride.climbGhost, before = G.dist;
      G.dist = ride.seg.d0 + traceDist(G.trace, G.best, G.length, ride.elapsed + dt - ride.seg.t0);
      G.pedal += ((G.dist > before ? 86 : 0) / 60) * Math.PI * 2 * dt;
    }
    if (ride.pacer) {
      const P = ride.pacer, target = ride.workoutDone || P.free ? null : effectiveTarget();
      const pw = P.free ? Math.round((settings.freePacerWkg || 2.5) * settings.weight)
        : target ?? Math.round(settings.ftp * 0.55); // easy spin once the workout is over
      P.v = stepSpeed(P.v, pw, route.gradeAt(P.dist), dt, settings.weight, { cda: ride.cda, wind: W.head }); // your size, your drag
      P.power = pw;
      if (P.free && pacerOn()) pacerRegroup(P, dt);
      P.dist += P.v * dt;
      // workout pacer: on target you are riding his ride, so a gap opened by ERG lag at step changes,
      // a pause or a dropout of the power reading closes again (about 20 s) instead of only growing
      if (!P.free && target && Math.abs(power - target) <= target * 0.05) P.dist += (ride.dist - P.dist) * Math.min(1, dt / 20);
      const pc = liveCadence(P, 90, route.gradeAt(P.dist), ride.elapsed, dt, 5);
      P.pedal = pc < 5 ? levelPedals(P.pedal, dt) : P.pedal + (pc / 60) * Math.PI * 2 * dt;
      // rides beside you, on the side with more room; switches sides only well past the centre line
      P.side = ride.lane > 0.6 ? -1 : ride.lane < -0.6 ? 1 : (P.side || (ride.lane > 0 ? -1 : 1));
      P.lane = easeLane(P.lane, ride.lane + 1.4 * P.side, dt, P);
    }
    // overtaking: a rider closing on someone in the same lane swings out to a free one, then back
    if ((ride.laneCheck = (ride.laneCheck || 0) + dt) > 0.25) {
      ride.laneCheck = 0;
      const solid = [{ dist: ride.dist, lane: ride.lane, laneTarget: ride.laneTarget, v: ride.v, vFree: ride.vFree, heldFor: ride.heldFor, me: true }, ...ride.bots, ...(pacerOn() ? [ride.pacer] : [])];
      for (const b of ride.bots) b.laneTarget = pickLane(b, solid, b.home);
      if (!ride.steeredAt || ride.elapsed - ride.steeredAt > 4) { // unless you steered yourself just now
        const me = solid[0], t = pickLane(me, solid, ride.laneHome ?? START_LANE);
        if (t !== ride.laneTarget) { ride.laneTarget = t; ride.autoLane = true; }
      }
    }
    for (const b of ride.bots) b.lane = keepApart(b, easeLane(b.lane, b.laneTarget, dt, b), [{ dist: ride.dist, lane: ride.lane }, ...ride.bots.filter((o) => o !== b), ...(pacerOn() ? [ride.pacer] : [])]);
    for (const b of ride.bots) {
      const g = route.gradeAt(b.dist);
      // his steady pace, harder up the climbs and easier down, and never perfectly even
      const swing = 1 + Math.sin(ride.elapsed * 0.05 + b.phase) * 0.05 + Math.sin(ride.elapsed * 0.17 + b.phase * 2) * 0.03;
      let p = b.wkg * b.weight * swing * (1 + Math.max(-0.6, Math.min(0.35, g * 4)));
      if (ride.race) {
        const R = ride.race, toGo = R.distance - b.dist;
        if (b.climber && g > 0.035) p *= 1.12;                 // climbers attack on the hills
        if (toGo < 300 && toGo > 0) p *= 1.3;                  // everyone sprints for the line
        if (toGo <= 0) p *= 0.5;                               // over the line: soft-pedalling
        if (ride.elapsed - (R.t0 ?? 0) < 8) p *= 1.15;         // the start: out of the saddle
      }
      b.power = p;
      const wheels = [{ dist: ride.dist, lane: ride.lane }, ...ride.bots.filter((o) => o !== b)];
      const bd = packDraft(wheels.map((o) => ({ gap: o.dist - b.dist, sideways: o.lane - b.lane })), W.cross);
      b.v = stepSpeed(b.v, p, g, dt, b.weight, { cda: b.cda * (1 - bd), wind: W.head });
      b.vFree = stepSpeed(b.vFree ?? b.v, p, g, dt, b.weight, { cda: b.cda, wind: W.head });
      for (const o of wheels) if (Math.abs(o.lane - b.lane) < 0.8) b.v = Math.min(b.v, wheelCap(o.dist - b.dist, o === wheels[0] ? ride.v : o.v));
      b.heldFor = heldBy(b, wheels.map((o, k) => (k === 0 ? { ...o, v: ride.v } : o)), dt);
      const before = b.dist;
      b.dist += b.v * dt;
      b.dist = behindWheels(b, b.dist, wheels.map((o, k) => (k === 0 ? { ...o, v: ride.v } : o)));
      if (ride.race && before < ride.race.distance && b.dist >= ride.race.distance && !ride.race.finish.has(b)) {
        ride.race.finish.set(b, ride.elapsed - ride.race.t0 + dt * (ride.race.distance - before) / Math.max(1e-6, b.dist - before));
      }
      const bc = liveCadence(b, b.rpm || 90, g, ride.elapsed, dt, b.phase * 3);
      b.pedal = bc < 5 ? levelPedals(b.pedal, dt) : b.pedal + (bc / 60) * Math.PI * 2 * dt;
    }
    ride.elapsed += dt;
    ride.secAcc += dt;
    left -= dt;
    if (ride.secAcc >= 1 - 1e-9) {
      ride.secAcc = 0;
      const p1 = powerAt(t);
      tick(p1, cadenceAt(t, p1), hrAt(t));
    }
  }
}

/** How close the fans are: 1 at the top of a climb, fading over the last ~190 m below it and 25 m past it. */
function crowdLevel() {
  const R = ride.route, L = R.length;
  let best = 0;
  for (const c of R.climbs || []) {
    let x = c.end - ride.dist; // metres to the top
    if (!R.oneWay) { x = ((x % L) + L) % L; if (x > L - 25) x -= L; }
    if (x > -25 && x < 190) best = Math.max(best, x < 0 ? 1 + x / 25 : 1 - x / 210);
  }
  return best;
}

function frame(now) {
  if (!ride) return;
  advance(now);
  if (settings.sound) { if (ride.paused) crowdOff(); else crowd(crowdLevel()); }
  if (ride.race) {
    const c = ride.race.countdown, el = $('countdown');
    const txt = ride.race.go ? (ride.elapsed - ride.race.t0 < 1.2 ? tr('GO!') : '') : c > 3 ? tr('Get ready') : String(Math.ceil(c));
    if (el.textContent !== txt) {
      el.textContent = txt; el.hidden = !txt;
      el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
      if (/^[123]$/.test(txt)) cueBeep(880, 0.15);
    }
  }
  const riders = [
    { dist: ride.dist, color: settings.jersey, stripe: settings.stripe, bike: settings.bikeColor || null, pedal: ride.pedal, self: true, name: settings.name, lane: ride.lane },
    ...ride.bots,
    ...(pacerOn() ? [ride.pacer] : []),
    ...(ride.ghost ? [ride.ghost] : []),
    ...(ride.climbGhost ? [ride.climbGhost] : []),
  ];
  // the mini window is open: the 3D road is not drawn (nobody looks at it, and the video you watch keeps the
  // graphics card); the ride goes on, and the road comes back the moment the mini window closes
  const inPip = ride.noScene || (pipOpen() && !ride.showRoadInPip);
  $('pip-rest').hidden = !inPip;
  if (inPip) { ride.moved = 0; requestAnimationFrame(frame); return; }
  scene.render(ride.route, ride.dist, riders, ride.moved);
  ride.moved = 0;
  // the ghost's gap rides over your head, where the bots carry their names
  const tag = $('ghost-tag'), at = scene.selfScreen;
  if (at?.on) { tag.style.left = `${at.x}px`; tag.style.top = `${at.y}px`; tag.classList.add('over-me'); } else { tag.classList.remove('over-me'); tag.style.left = tag.style.top = ''; } // not in the picture (own eyes): back to its own place
  requestAnimationFrame(frame);
}

/** Riders ahead you could reach within 10 s at your speed: name, gap in seconds and metres, their W/kg. */
// ---------- Race against the bots (#39) ----------
/** Everyone's place: finishers by their time, the rest by how far they have got. */
function raceStandings() {
  const R = ride.race, me = { me: true, name: settings.name || tr('You'), color: settings.jersey, stripe: settings.stripe, dist: ride.dist, v: ride.v };
  const all = [me, ...ride.bots];
  const time = (r) => (r.me ? (R.done ? R.myTime : null) : R.finish.get(r) ?? null);
  return all.map((r) => ({ r, t: time(r) })).sort((a, b) => (a.t !== null && b.t !== null ? a.t - b.t : a.t !== null ? -1 : b.t !== null ? 1 : b.r.dist - a.r.dist));
}
/** The board while racing: your place, laps and distance to go, and the riders round you with gaps in seconds. */
/** W/kg right now: a bot's power this moment over its weight, yours from the last 3 s. */
function wkgNow(r) {
  if (r.me) return ride.powerHist.length ? ride.powerHist.reduce((a, b) => a + b, 0) / ride.powerHist.length / Math.max(30, settings.weight) : 0;
  return (r.power ?? 0) / Math.max(30, r.weight || 70);
}
function updateRaceBoard() {
  const R = ride.race, list = raceStandings(), i = list.findIndex((x) => x.r.me);
  const L = ride.route.length, toGo = Math.max(0, R.distance - ride.dist);
  const lap = Math.min(R.laps, Math.floor(Math.max(0, ride.dist) / L) + 1);
  $('race-pos').textContent = `${i + 1}/${list.length}`;
  $('race-info').textContent = R.done ? tr('Finished') : `${R.laps > 1 ? `${tr('Lap {n}', { n: lap })}/${R.laps} · ` : ''}${toGo >= 1000 ? `${(toGo / 1000).toFixed(1)} ${U.km}` : `${Math.round(toGo)} ${U.m}`} ${tr('to go')}`;
  const v = Math.max(ride.v, 3);
  const from = Math.max(0, Math.min(i - 2, list.length - 5)), rows = list.slice(from, from + 5);
  $('race-rows').innerHTML = rows.map(({ r, t }, k) => {
    const gap = r.me ? '' : t !== null && R.done ? fmtDelta(t - R.myTime) : `${r.dist >= ride.dist ? '+' : '−'}${(Math.abs(r.dist - ride.dist) / v).toFixed(1)}${tr('s')}`;
    return `<div class="race-row${r.me ? ' me' : ''}"><span class="rp">${from + k + 1}</span><i style="background:${esc(r.color)};box-shadow:0 0 0 2px ${esc(r.stripe || '#fff')}"></i><b>${esc(r.me ? tr('You') : r.name)}</b><span class="rw">${wkgNow(r).toFixed(1)}</span><span class="rg">${t !== null ? '🏁 ' : ''}${gap}</span></div>`;
  }).join('');
}
/** You crossed the line: your place, a cheer, and the summary a few seconds later. */
function raceFinished() {
  const list = raceStandings(), place = list.findIndex((x) => x.r.me) + 1;
  ride.race.place = place;
  toast(place === 1 ? tr('🏆 You win! {time}', { time: fmtTime(ride.race.myTime) }) : tr('🏁 {n} of {m} · {time}', { n: place, m: list.length, time: fmtTime(ride.race.myTime) }));
  cueBeep(place === 1 ? 1320 : 1040, 0.5);
  cueSay(place === 1 ? 'You win!' : `You finished in position ${place}`);
  setTimeout(() => { if (ride?.race?.done) finishRide(); }, 4000);
}
/** Results for the summary: those still riding are given the time they would take at their speed now. */
function raceResults() {
  const R = ride.race;
  if (!R?.go) return null;
  const now = ride.elapsed - R.t0;
  return raceStandings().map(({ r, t }) => ({
    name: r.me ? (settings.name || tr('You')) : r.name, me: !!r.me, color: r.color,
    time: Math.round((t ?? now + Math.max(0, R.distance - r.dist) / Math.max(1, r.v || 1)) * 10) / 10, est: t === null,
  })).sort((a, b) => a.time - b.time);
}

function updateAhead() {
  const v = Math.max(ride.v, 2), all = [...ride.bots, ...(pacerOn() ? [ride.pacer] : []), ...(ride.ghost ? [ride.ghost] : []), ...(ride.climbGhost ? [ride.climbGhost] : [])];
  const ahead = all
    .map((r) => ({ r, gap: r.dist - ride.dist }))
    .filter(({ gap }) => gap > 0.5 && gap / v <= 10)
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 3);
  $('ahead').hidden = !ahead.length;
  $('ahead-rows').innerHTML = ahead.map(({ r, gap }) => {
    const wkg = r.weight ? wkgNow(r) : r.wkg ?? (r.power ? r.power / settings.weight : 0); // a bot's W/kg right now
    return `<div class="ahead-row"><i style="background:${esc(r.color)};box-shadow:0 0 0 2px ${esc(r.stripe || '#fff')}"></i><b>${esc(r.ghost ? `👻 ${r.name}` : r.name)}</b><span>+${(gap / v).toFixed(1)}${tr('s')}</span><small>${Math.round(gap)} ${U.m}${wkg ? ` · ${wkg.toFixed(1)} ${U.wkg}` : ''}</small></div>`;
  }).join('');
}

/**
 * Lane for rider `r` among `others` (each {dist, lane, laneTarget}): keep `home` when nobody is close
 * ahead in it; when catching someone up to 15 m ahead in the current lane (the overtaker moves, not the
 * one overtaken), take the nearest lane clear from 3 m behind to 15 m ahead, and keep it while alongside. Lanes are 1.2 m apart across the road.
 */
const LANES = [-2.4, -1.2, 0, 1.2, 2.4];
/**
 * A gentle lane change: the sideways speed builds up and fades out (at most 1 m/s² and 0.8 m/s), so a
 * rider never jerks across the road; `s` keeps that rider's sideways speed between frames.
 */
function easeLane(lane, target, dt, s) {
  const d = target - lane, lv = s.lv || 0;
  const want = Math.sign(d) * Math.min(0.8, Math.sqrt(2 * Math.abs(d)) * 0.9, Math.abs(d) * 2); // can still stop in time
  const a = 1.0 * dt;
  s.lv = lv + Math.max(-a, Math.min(a, want - lv));
  const next = lane + s.lv * dt;
  if (Math.abs(d) < 0.005 || (target - next) * d < 0) { s.lv = 0; return target; }
  return next;
}
/**
 * No riding through each other: alongside someone (overlapping wheels, within a bike's length) a rider keeps at
 * least a shoulder's width (0.8 m) to the side, on the side it is on; its sideways speed stops there.
 */
const SIDE_GAP = 0.8, BIKE_LEN = 1.9;
function keepApart(r, lane, others) {
  for (const o of others) {
    if (!o || o === r || Math.abs(o.dist - r.dist) >= BIKE_LEN) continue;
    // never pushed aside, only stopped: not closer sideways than a shoulder's width, or than it already is
    const now = Math.abs(r.lane - o.lane), next = Math.abs(lane - o.lane), floor = Math.min(SIDE_GAP, now);
    if (next < floor) { const side = Math.sign(r.lane - o.lane) || 1; lane = o.lane + side * floor; r.lv = 0; }
  }
  return Math.max(-2.6, Math.min(2.6, lane));
}
/**
 * No overlapping wheels: a rider in the line of someone ahead (less than a shoulder's width aside) stays at least a
 * bike's length behind it, whatever the speeds did this frame (the wheel ahead may have eased off); held there it
 * takes that rider's speed.
 */
function behindWheels(r, dist, others) {
  for (const o of others) {
    if (!o || o === r || Math.abs(o.lane - r.lane) >= SIDE_GAP) continue;
    const gap = o.dist - dist;
    if (gap > 0 && gap < BIKE_LEN) { dist = o.dist - BIKE_LEN; r.v = Math.min(r.v, o.v ?? r.v); }
  }
  return dist;
}
/**
 * Top speed behind a wheel `gap` m ahead (centre to centre): coming up on it, a rider eases off at no more than
 * 1.5 m/s² so as to settle on the wheel (2 m) at its speed; before, the brake came in at 3.6 m and the picture
 * jumped (up to 19 m/s², measured).
 */
const EASE_OFF = 1.5;
function wheelCap(gap, v) {
  return gap > 0 && gap < 14 ? v + Math.sqrt(2 * EASE_OFF * Math.max(0, gap - 2.0)) : Infinity;
}
/**
 * Slipstream first, then the pass: a faster rider comes up onto the wheel ahead and sits in its shelter; only once
 * it has been held back there (could go faster, kept to the wheel's speed) for 3 s does it pull out and pass, as in
 * a real bunch. Steering yourself overrides it.
 */
const PASS_AFTER = 3;
/** How long `r` has been held back by a wheel right ahead (within 3 m, in line) that is slower than r would go alone. */
function heldBy(r, others, dt) {
  const wheel = others.find((o) => o !== r && o.dist - r.dist > 0 && o.dist - r.dist < 4 && Math.abs(o.lane - r.lane) < 0.8);
  // any real edge counts: 0.1 m/s (0.4 km/h) — 3.1 W/kg behind 2.9 is ~0.6 km/h, which 0.3 m/s took for a draw
  const held = wheel && (r.vFree ?? r.v) > (wheel.v ?? 0) + 0.1;
  return held ? (r.heldFor || 0) + dt : Math.max(0, (r.heldFor || 0) - dt * 2);
}
function pickLane(r, others, home) {
  const near = (lane, from, to, closing = false) => others.some((o) => {
    if (o === r || !(Math.abs((o.laneTarget ?? o.lane) - lane) < 0.9 || Math.abs(o.lane - lane) < 0.9)) return false;
    const gap = o.dist - r.dist;
    if (!closing) return gap > from && gap < to;
    // a pass: on this rider's wheel (within 4 m) and held back by it long enough
    return gap > from && gap < 4 && (r.heldFor || 0) >= PASS_AFTER;
  });
  const cur = r.laneTarget ?? r.lane;
  // never change course while alongside someone: finish the pass in the lane you chose
  if (others.some((o) => o !== r && Math.abs(o.dist - r.dist) < 3.5 && Math.abs(o.lane - r.lane) >= 0.9 && Math.abs(o.lane - r.lane) < 2)) return cur;
  // not passing: on a wheel just ahead (within 8 m, nearly in line), tuck into its line for the full shelter
  if (!near(cur, -0.5, 15, true)) {
    // (in line with where it is heading, not where it is now: a pass already begun is not pulled back onto the wheel)
    const wheel = others.filter((o) => o !== r && o.dist - r.dist > 0.3 && o.dist - r.dist < 8 && Math.abs(o.lane - cur) < 0.9 && Math.abs(o.lane - r.lane) < 0.9).sort((a, b) => a.dist - b.dist)[0];
    if (wheel) return wheel.lane;
    // otherwise back home, only when it is clear well ahead (10 m), so a pass is not cut short across the wheel
    return near(home, -6, 10) ? cur : home;
  }
  // the pass: just wide enough, as in a bunch: a line 0.95 m beside the wheel being passed (shoulders ~15 cm
  // apart), the side that is clear and the nearer one; only when both are taken, a whole lane further out
  const wheel = others.filter((o) => o !== r && o.dist - r.dist > 0 && o.dist - r.dist < 4 && Math.abs(o.lane - r.lane) < 0.9).sort((a, b) => a.dist - b.dist)[0];
  const base = wheel ? wheel.lane : cur;
  const lines = [base - PASS_SIDE, base + PASS_SIDE, base - 2 * PASS_SIDE, base + 2 * PASS_SIDE].filter((l) => l >= -2.6 && l <= 2.6);
  const free = lines.filter((l) => !near(l, -3, 15)).sort((a, b) => Math.abs(a - r.lane) - Math.abs(b - r.lane) || Math.abs(a) - Math.abs(b));
  return free.length ? free[0] : cur;
}
const PASS_SIDE = 0.95;

/** Called once per second of riding. */
function tick(power, cadence, hr) {
  const { route } = ride;
  // simulator without a heart rate monitor: a plausible heart rate that follows power with a lag —
  // from ~62 bpm at rest towards ~170 bpm at FTP, rising in about 30 s and drifting up with time
  if (ride.simulated && !hr) {
    const effort = Math.max(0, power) / Math.max(50, settings.ftp);
    const target = 62 + 108 * Math.min(1.25, effort) + Math.min(8, ride.elapsed / 600);
    ride.simHr = ride.simHr ? ride.simHr + (target - ride.simHr) * 0.035 : 75;
    hr = Math.round(ride.simHr + Math.sin(ride.elapsed / 7) * 1.2);
  }

  // elevation & laps
  const elev = route.elevAt(ride.dist);
  if (elev > ride.lastElev) ride.gain += elev - ride.lastElev;
  ride.lastElev = elev;
  if (route.oneWay) {
    // point to point: the finish line ends the ride, with the time against this route's best
    if (ride.dist >= route.length && !ride.finished) {
      ride.finished = true;
      const t = ride.elapsed, best = bestLap(route);
      ride.lapTimes.push(t);
      if ((!best || t < best) && plausibleLap(t, route.length)) { records.lap[route.id] = t; saveRecords(); }
      if (!ride.race) toast(!best ? tr('Finish! {time} 🏁', { time: fmtTime(t) }) : t < best ? tr('Finish! {time} — new record! ({delta}) 🏆', { time: fmtTime(t), delta: fmtDelta(t - best) }) : tr('Finish! {time} ({delta} vs best)', { time: fmtTime(t), delta: fmtDelta(t - best) }));
      if (!ride.race) { cueBeep(1180, 0.3); setTimeout(() => { if (ride?.finished) finishRide(); }, 2500); } // a race ends from raceFinished()
    }
  } else if (Math.floor(ride.dist / route.length) > ride.laps) {
    const laps = Math.floor(ride.dist / route.length);
    ride.laps = laps;
    // lap time against this route's best on this device
    const t = ride.elapsed - ride.lapStartT, best = bestLap(route);
    ride.lapStartT = ride.elapsed;
    ride.lapTimes.push(t);
    if (ride.race) { if ((!best || t < best) && plausibleLap(t, route.length)) { records.lap[route.id] = t; saveRecords(); } } // the race board says it all
    else if ((!best || t < best) && plausibleLap(t, route.length)) {
      records.lap[route.id] = t; saveRecords();
      toast(best ? tr('Lap {n}: {time} — new best lap! ({delta}) 🏆', { n: laps, time: fmtTime(t), delta: fmtDelta(t - best) }) : tr('Lap {n}: {time} — first lap on this route 🎉', { n: laps, time: fmtTime(t) }));
    } else toast(tr('Lap {n}: {time} ({delta} vs best)', { n: laps, time: fmtTime(t), delta: fmtDelta(t - best) }));
    if (!ride.workout || ride.workoutDone) recorder.markLap();
  }
  updateSegments();

  // workout / trainer control
  const grade = route.gradeAt(ride.dist);
  if (ride.workout?.ramp && !ride.workoutDone) rampWatch(power, cadence);
  if (ride.workout && !ride.workoutDone) {
    const t = targetAt(ride.workout, ride.workoutT, settings.ftp);
    ride.workoutT += 1;
    if (t) {
      ride.target = ergTarget(t);
      if (t.index !== ride.stepIndex) {
        if (ride.stepIndex !== undefined) { recorder.markLap(); cueBeep(1040, 0.35); }
        ride.stepIndex = t.index;
        if (t.step.text) toast(t.step.text);
        else if (t.watts === null) toast(tr('Free segment — ride by feel'));
        if (t.step.dur >= 20) cueSay(describeStep(t.step, ride.target));
        updateGear();
      }
      if (t.remaining <= 3 && t.remaining >= 1) cueBeep(660, 0.12);
      const next = ride.workout.steps[t.index + 1];
      if (next && t.remaining === 10 && t.step.dur >= 30) cueSay(`In 10 seconds: ${describeStep(next, ergTarget({ watts: stepWatts(next, 0, settings.ftp) }))}`);
    } else {
      ride.workoutDone = true;
      ride.target = null;
      recorder.markLap();
      cueBeep(1040, 0.5);
      cueSay('Workout complete. Great job!');
      toast(tr('Workout complete! Free ride from here 🏁'));
      updateGear();
      if (ride.simulated) $('sim-power').value = Math.round(settings.ftp * 0.5);
    }
  }
  updateSpiralGuard(power, cadence);
  if (!ride.simulated && trainer.controllable) {
    if (inErgStep() || inHold()) {
      const sendW = inHold() ? ride.hold : effectiveTarget();
      if (sendW !== ride.lastSentTarget) { trainer.setTargetPower(sendW); ride.lastSentTarget = sendW; }
      ride.lastSentGrade = null;
    } else {
      ride.lastSentTarget = null;
      if (ride.shiftMode === 'wheel') sendVirtualGear();
      const offset = ride.shiftMode === 'wheel' ? 0 : gearGradeOffset(ride.gear);
      // the wind as extra grade: a headwind is a gentle hill, a tailwind a gentle descent (±5 % at most)
      const wg = ride.wind?.head ? Math.max(-5, Math.min(5, windGrade(ride.v, ride.wind.head, ride.cda * (1 - (ride.draft || 0)), settings.weight) * 100)) : 0;
      const g = Math.round(((grade * 100 + wg) * (settings.difficulty / 100) + offset) * 10) / 10;
      // on a wheel the trainer gets less wind, so the shelter is felt in the legs, not only seen
      const cw = Math.round(WIND_CW * (1 - (ride.draft || 0)) * 100) / 100;
      const now = performance.now();
      if (g !== ride.lastSentGrade || Math.abs(cw - (ride.lastSentCw ?? cw)) >= 0.02 || now - ride.lastGradeSentAt > 10000) {
        trainer.setSimulation(g, { cw });
        ride.lastSentGrade = g;
        ride.lastSentCw = cw;
        ride.lastGradeSentAt = now;
      }
    }
  }

  const onPlan = ride.workout && !ride.workoutDone;
  if (onPlan && ride.stepIndex !== undefined) {
    const st = (ride.stepStats[ride.stepIndex] ||= { p: 0, t: 0, n: 0 });
    st.p += power; st.t += ride.target || 0; st.n++;
  }
  recorder.add({
    power, cadence, heartRate: hr, speed: ride.v, distance: ride.dist,
    altitude: elev, elevationGain: ride.gain,
    target: onPlan ? ride.target : null, step: onPlan ? ride.stepIndex ?? null : null, // the plan, for the summary
  });

  ride.powerHist.push(power);
  if (ride.powerHist.length > 3) ride.powerHist.shift();
  // W′bal: the anaerobic reserve above FTP, drained and refilled second by second
  ride.wbal = wbalStep(ride.wbal ?? wPrimeJ(), power, settings.ftp, wPrimeJ(), 1);
  ride.wbalMin = Math.min(ride.wbalMin ?? wPrimeJ(), ride.wbal);
  // running averages for the board (zeros left out, as in the ride summary)
  const A = ride.avg ||= { hr: 0, hrN: 0, cad: 0, cadN: 0 };
  if (hr > 0) { A.hr += hr; A.hrN++; }
  if (cadence > 0) { A.cad += cadence; A.cadN++; }
  updateHud(cadence, hr, grade);
  if (ride.elapsed - (ride.draftAt || 0) >= 30) saveDraft();
  drawTrace();
  renderStepList();
}

/** W′ in joules, from the profile (kJ). */
function wPrimeJ() { return Math.max(1, (settings.wPrimeKj || DEFAULT_W_PRIME / 1000) * 1000); }

/** W′bal on the board: what is left in kJ and a bar; above FTP with less than a minute to go, how long. */
function updateWbalHud(p3) {
  const full = wPrimeJ(), bal = ride.wbal ?? full, frac = bal / full;
  $('m-wbal').textContent = (bal / 1000).toFixed(1);
  const row = document.querySelector('.stat.wbal');
  row.style.setProperty('--fill', `${Math.round(frac * 100)}%`);
  const left = timeToEmpty(bal, p3, settings.ftp);
  const warn = left < WARN_SECONDS;
  row.classList.toggle('warn', warn);
  $('m-wbal-warn').textContent = warn ? tr('~{s} s to empty', { s: Math.max(5, Math.round(left / 5) * 5) }) : `${Math.round(frac * 100)}%`;
}

function updateHud(cadence, hr, grade) {
  ride.lastHud = [cadence, hr, grade];
  const p3 = Math.round(ride.powerHist.reduce((a, b) => a + b, 0) / ride.powerHist.length);
  $('m-power').textContent = p3;
  $('m-wkg').textContent = `${(p3 / settings.weight).toFixed(1)} ${U.wkg}`;
  $('m-ftp-pct').textContent = `${Math.round((p3 / settings.ftp) * 100)}% FTP`;
  updateWbalHud(p3);
  updateWindHud();
  // power zone: the board's bar and a Z1–Z7 tag take the zone's colour (in a workout the number itself
  // shows how close you are to the target, below)
  const zone = powerZone(p3 / Math.max(1, settings.ftp));
  const powerRow = document.querySelector('.stat.power');
  powerRow.style.setProperty('--c', zone.color);
  $('m-zone').textContent = `Z${zone.z}`;
  $('m-zone').style.background = zone.color;
  $('m-zone').title = tr(zone.name);
  // heart rate zone, from intervals.icu or your threshold heart rate (Profile); neither → no tag
  const hrz = $('m-hr-zone'), hrNow = Math.round(hr || 0), zs = hrZones();
  hrz.hidden = !(zs && hrNow > 0);
  if (!hrz.hidden) {
    const z = zs.find((x) => hrNow < x.upTo) || zs[zs.length - 1];
    hrz.textContent = `Z${z.z}`; hrz.style.background = z.color; hrz.title = tr(z.name);
    document.querySelector('.stat.hr').style.setProperty('--c', z.color);
  }
  if (!ride.workout || ride.workoutDone) $('m-power').style.color = p3 > 0 ? zone.color : '';
  else $('m-power').style.color = '';
  $('m-cad').textContent = Math.round(cadence);
  $('m-hr').textContent = hr ? Math.round(hr) : '—';
  const A = ride.avg;
  $('m-hr-avg').textContent = A?.hrN ? `${tr('avg')} ${Math.round(A.hr / A.hrN)}` : '';
  $('m-cad-avg').textContent = A?.cadN ? `${tr('avg')} ${Math.round(A.cad / A.cadN)}` : '';
  $('m-speed').textContent = (ride.v * 3.6).toFixed(1);
  if (ride.race) updateRaceBoard(); else updateAhead();
  // the slipstream in words: the watts it saves you now (the air's share of your effort at this speed), how deep it
  // is as a bar (full = right on the wheel), and when you are about to pull out and pass
  const df = ride.draft || 0;
  $('draft-tag').hidden = df < 0.03;
  if (df >= 0.03) {
    const air = 0.5 * DEFAULTS.rho * ride.cda * Math.max(0, ride.v) ** 3; // W pushing the air at this speed
    const saved = Math.round((air * df) / 5) * 5;
    const passing = (ride.heldFor || 0) > PASS_AFTER - 1.5;
    $('draft-tag').innerHTML = `<b>${tr('Slipstream')}</b><span>${passing ? tr('pulling out to pass…') : saved >= 5 ? tr('saving ~{w} W', { w: saved }) : tr('a little shelter')}</span><i class="dt-bar"><i style="width:${Math.round(Math.min(1, df / 0.33) * 100)}%"></i></i>`;
    $('draft-tag').title = tr('{n}% less air drag behind the wheel', { n: Math.round(df * 100) });
  }
  if (ride.ghost) {
    const G = ride.ghost, gap = ride.dist - G.dist, tg = ghostTimeAt(G.entry, ride.dist);
    const secs = tg === null ? null : Math.round(tg - ride.elapsed); // + = you got here sooner
    $('ghost-tag').hidden = false;
    $('ghost-tag').className = `ghost-mini ${gap >= 0 ? 'c-ok' : 'c-bad'}`;
    $('ghost-tag').title = G.name;
    $('ghost-tag').textContent = `👻 ${G.name} ${Math.abs(gap) < 2 ? tr('level') : `${gap > 0 ? '+' : '−'}${Math.round(Math.abs(gap))} ${U.m}`}${secs !== null && Math.abs(gap) >= 2 ? ` · ${secs >= 0 ? '−' : '+'}${fmtTime(Math.abs(secs))}` : ''}`;
  } else $('ghost-tag').hidden = true;
  $('m-dist').textContent = (ride.dist / 1000).toFixed(2);
  $('m-time').textContent = fmtTime(ride.elapsed);
  $('m-gain').textContent = Math.round(ride.gain);
  updateProgress();
  const gEl = $('grade');
  gEl.textContent = `${grade >= 0 ? '' : '−'}${Math.abs(grade * 100).toFixed(1)}%`;
  gEl.style.color = gradeColor(grade);
  // what is coming: the average grade over the next 200 m and the next kilometre (#29)
  const ahead = (m, min) => { // null near the finish of a point-to-point route
    const d0 = ride.dist, span = ride.route.oneWay ? Math.min(m, ride.route.length - d0) : m;
    return span < min ? null : (ride.route.elevAt(d0 + span) - ride.route.elevAt(d0)) / span;
  };
  const fmtG = (g) => g === null ? '' : `<b style="color:${gradeColor(g)}">${g < 0 ? '−' : ''}${Math.abs(g * 100).toFixed(1)}%</b>`;
  const g2 = ahead(200, 50), g10 = ahead(1000, 1000);
  $('grade-next').innerHTML = (g2 === null ? '' : `<span>200 ${U.m} ${fmtG(g2)}</span>`) + (g10 === null ? '' : `<span>1 ${U.km} ${fmtG(g10)}</span>`);

  if (ride.workout) {
    const t = targetAt(ride.workout, Math.max(0, ride.workoutT - 1), settings.ftp);
    const target = ride.workoutDone ? null : ride.target;
    const tEl = $('wk-target');
    tEl.textContent = ride.workoutDone ? '—' : target ?? tr('free');
    // compliance: green within ±5 %, amber within ±10 %, red beyond
    const dev = target ? (p3 - target) / target : 0;
    const cls = !target ? '' : Math.abs(dev) <= 0.05 ? 'c-ok' : Math.abs(dev) <= 0.1 ? 'c-warn' : 'c-bad';
    tEl.className = cls;
    $('m-power').className = cls;
    // ERG off: you hold the target yourself, so your power stands beside it ("152 / 155")
    const byFeel = ride.ergOff && target && !ride.workoutDone;
    if (byFeel) tEl.innerHTML = `${Math.round(p3)}<span class="wk-of"> / ${target}</span>`;
    $('wk-target-label').textContent = byFeel ? tr('Power / target, W') : tr('Target, W');
    const P = ride.pacer;
    $('wk-pacer').hidden = !pacerOn();
    if (pacerOn()) {
      const gap = Math.round(ride.dist - P.dist);
      $('wk-pacer').textContent = Math.abs(gap) < 3 ? tr('With {name}', { name: P.name }) : gap > 0 ? `${P.name} ${tr('{n} m behind', { n: gap })}` : `${P.name} ${tr('{n} m ahead', { n: -gap })}`;
      const behindS = -gap / Math.max(ride.v, 3); // seconds behind him: 25 m is 2 s at 45 km/h but 5 s at 18
      $('wk-pacer').className = `pacer-tag ${behindS <= 3 ? 'c-ok' : behindS <= 10 ? 'c-warn' : 'c-bad'}`;
    }
    $('wk-diff').textContent = target ? `${p3 - target >= 0 ? '+' : '−'}${Math.abs(Math.round(p3 - target))}` : '';
    $('wk-diff').className = cls;
    if (byFeel) $('wk-diff').textContent = ''; // the two numbers already say it
    else if (ride.ergFactor < 1 && target) $('wk-diff').textContent = `ERG ${Math.round(ride.ergFactor * 100)}%`;
    $('wk-left').textContent = t ? fmtTime(ride.workoutDone ? 0 : t.remaining - 1) : '0:00';
    const cad = t?.step?.cad;
    const cadEl = $('wk-cad');
    cadEl.textContent = cad ? `${cad[0]}–${cad[1]}` : '—';
    cadEl.className = cad && cadence > 0 ? (cadence >= cad[0] - 2 && cadence <= cad[1] + 2 ? 'c-ok' : 'c-warn') : '';
    $('m-cad').className = cadEl.className;
    cadEl.parentElement.hidden = !cad && !ride.workout.steps.some((s) => s.cad); // no cadence targets in this workout: no column
    const next = t && ride.workout.steps[t.index + 1];
    const nextW = next ? scaleW(stepWatts(next, 0, settings.ftp)) : null;
    $('wk-next').textContent = next ? (nextW === null ? tr('free') : `${nextW} ${U.W}`) : '—';
    drawWorkoutChart($('wk-chart'), ride.workout, ride.workoutT);
  }

  drawProfile($('profile'), ride.route, [...ride.bots, ...(ride.ghost ? [{ dist: ride.ghost.dist, color: 'rgba(255,255,255,.6)' }] : []), { dist: ride.dist, color: settings.jersey, self: true }]);
  if (pipOpen()) updatePip(pipState(p3, zone, hrNow, zs));
}

// ---------- The mini window over other apps (picture-in-picture) ----------
/** What the mini window shows: the same numbers as the board, already formatted. */
function pipState(p3, zone, hrNow, zs) {
  const hz = zs && hrNow > 0 ? (zs.find((x) => hrNow < x.upTo) || zs[zs.length - 1]) : null;
  const wp = wPrimeJ(), f = Math.max(0, Math.min(1, (ride.wbal ?? wp) / wp));
  const wk = !!ride.workout && !ride.workoutDone;
  return {
    labels: { power: tr('Power'), hr: tr('HR'), cad: tr('Cadence'), W: U.W, kmh: tr('km/h'), km: U.km, kj: tr('kJ'), time: tr('Time'), speed: tr('Speed'), distance: tr('Distance'), target: tr('Target'), interval: tr('Interval'), next: tr('Next'), paused: tr('PAUSED') },
    power: p3, powerCls: $('m-power').className, powerColor: p3 > 0 ? zone.color : '',
    zone: `Z${zone.z}`, zoneColor: zone.color, wkg: `${(p3 / settings.weight).toFixed(1)} ${U.wkg} · ${$('m-ftp-pct').textContent}`,
    hr: $('m-hr').textContent, hrAvg: $('m-hr-avg').textContent, hrZone: hz ? `Z${hz.z}` : '', hrZoneColor: hz?.color,
    cad: $('m-cad').textContent, cadCls: $('m-cad').className, cadAvg: $('m-cad-avg').textContent,
    cadTarget: wk && $('wk-cad').textContent !== '—' ? `→ ${$('wk-cad').textContent}` : '',
    workout: wk, target: $('wk-target').textContent, left: $('wk-left').textContent, next: $('wk-next').textContent,
    ...(() => { const t = wk ? targetAt(ride.workout, ride.workoutT, settings.ftp) : null; return t ? { stepF: 1 - t.remaining / Math.max(1, t.step.dur), stepLeft: t.remaining } : {}; })(),
    time: $('m-time').textContent, speed: $('m-speed').textContent, dist: $('m-dist').textContent,
    grade: $('grade').textContent, gradeColor: $('grade').style.color,
    wbalF: f, wbalKj: ((ride.wbal ?? wp) / 1000).toFixed(1), wbalLevel: f <= 0.1 ? 'empty' : f <= 0.25 ? 'low' : f <= 0.5 ? 'mid' : 'ok', wbalTxt: `W′bal ${$('m-wbal').textContent} ${tr('kJ')} · ${$('m-wbal-warn').textContent}`,
    paused: !!ride.paused,
  };
}

/** Open or close the mini window; it has to come from a click or a key press. */
async function togglePip() {
  if (!ride) return;
  if (pipOpen()) { closePip(); return; }
  if (!(await openMini())) { toast(tr('This browser cannot show a mini window over other apps')); return; }
  if (ride.lastHud) updateHud(...ride.lastHud); // straight away, not in a second
}
/** Opens the mini window (a click or key press must lead here): true when it is open. */
async function openMini() {
  const ok = await openPip({
    clean: !!settings.pipClean,
    onKey: onRideKey,
    onPause: () => togglePause(),
    heartbeat: () => { if (ride) advance(); }, // the hidden tab's timers slow down, the mini window's do not
    onClose: () => { $('btn-pip')?.classList.remove('on'); $('pip-rest').hidden = true; if (ride) ride.showRoadInPip = false; },
  });
  if (ok) $('btn-pip').classList.add('on');
  return ok;
}
$('btn-pip').hidden = !pipSupport();
$('btn-pip').onclick = () => togglePip();
$('pip-show-road').onclick = async () => {
  if (!ride) return;
  // Watch & ride starts without the 3D world: it is built now
  if (!scene || ride.noScene) { await ensureScene(); applySceneSettings(); ride.noScene = false; }
  ride.showRoadInPip = true; $('pip-rest').hidden = true;
};

// ---------- Minimap ----------
const MAP_TURN = 2.5; // the 3D renderer's curvature factor: the map has the same bends as the road you see
const shapes = new WeakMap();
/**
 * The road from above: { pts (x right, y down), step (m between points) }. An imported route has its
 * real shape (north up); a built-in one is drawn from the bends the 3D world is built from.
 */
function routeShape(route) {
  if (shapes.has(route)) return shapes.get(route);
  if (route.map?.length >= 4) {
    const pts = [];
    for (let i = 0; i < route.map.length; i += 2) pts.push([route.map[i], route.map[i + 1]]);
    const shape = { pts, step: SEG * 10 };
    shapes.set(route, shape);
    return shape;
  }
  const n = route.segments.length, pts = [];
  let x = 0, y = 0, h = 0;
  for (let i = 0; i <= n; i++) {
    if (i % 4 === 0 || i === n) pts.push([x, y]);
    const seg = route.segAt(i);
    x += Math.cos(h) * SEG; y += Math.sin(h) * SEG;
    h += (seg.curve * MAP_TURN) / SEG;
  }
  if (route.startHeading !== undefined) { // the track began heading this way on the map
    const a = route.startHeading, c = Math.cos(a), s = Math.sin(a);
    for (const p of pts) { const [px, py] = p; p[0] = px * c + py * s; p[1] = -px * s + py * c; }
  }
  const shape = { pts, step: SEG * 4 };
  shapes.set(route, shape);
  return shape;
}

/** The minimap grows into a big map and back (click it, or M). */
function toggleMinimap(big = !$('minimap-box').classList.contains('big')) {
  $('minimap-box').classList.toggle('big', big);
  $('minimap-size').textContent = big ? '⤡' : '⤢';
  settings.bigMap = big; saveSettings();
  if (ride) drawMinimap();
}
$('minimap-box').addEventListener('click', () => toggleMinimap());

function drawMinimap() {
  const canvas = $('minimap');
  if (!canvas || !ride || !$('minimap-box').offsetWidth) return; // hidden (phones); offsetParent is null when it is fixed (big)
  const dpr = Math.min(window.devicePixelRatio || 1, 2), W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  const g = canvas.getContext('2d'), route = ride.route, { pts, step } = routeShape(route);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const big = $('minimap-box').classList.contains('big');
  const L = route.length;
  const raw = (d, wrap = true) => { // route point (metres) at distance d (riders wrap round a loop)
    const dd = route.oneWay || !wrap ? Math.max(0, Math.min(L, d)) : ((d % L) + L) % L;
    const f = dd / step, i = Math.min(pts.length - 2, Math.floor(f)), t = f - i;
    return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
  };
  // heading up: the map turns so that you always ride toward the top, eased so it does not twitch
  const [mx, my] = raw(ride.dist);
  // the way the road runs here: from 20 m back to 60 m ahead, kept inside this lap (round the start
  // line the end of a loop need not meet its beginning on the map, so the map spun after 20 m)
  const here = route.oneWay ? ride.dist : ((ride.dist % L) + L) % L;
  const back = Math.max(0, Math.min(L - 80, here - 20));
  const [ax, ay] = raw(back + 80, false), [bx, by] = raw(back, false);
  const want = -Math.PI / 2 - Math.atan2(ay - by, ax - bx);
  if (ride.mapRot === undefined) ride.mapRot = want;
  ride.mapRot += Math.atan2(Math.sin(want - ride.mapRot), Math.cos(want - ride.mapRot)) * 0.6;
  const c = Math.cos(ride.mapRot), sn = Math.sin(ride.mapRot);
  const rot = ([x, y]) => [c * (x - mx) - sn * (y - my), sn * (x - mx) + c * (y - my)];
  // big: the whole route fitted; small: about 1.2 km round you, you a little below the middle to see ahead
  const pad = big ? 24 : 12;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { const [x, y] = rot(p); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  let k = Math.min((W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0));
  let ox = (W - (x1 - x0) * k) / 2 - x0 * k, oy = (H - (y1 - y0) * k) / 2 - y0 * k;
  if (!big) {
    const kLocal = Math.min(W, H) / 1200;
    if (kLocal > k) { k = kLocal; ox = W / 2; oy = H * 0.62; }
  }
  const at = (d, wrap = true) => { const [x, y] = rot(raw(d, wrap)); return [ox + x * k, oy + y * k]; };
  const line = (from, to, color, width) => {
    g.beginPath();
    for (let d = from; d <= to; d += step) { const [px, py] = at(Math.min(d, to), false); d === from ? g.moveTo(px, py) : g.lineTo(px, py); }
    const [ex, ey] = at(to, false); g.lineTo(ex, ey);
    g.strokeStyle = color; g.lineWidth = width; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke();
  };
  line(0, L, 'rgba(255,255,255,.18)', big ? 9 : 6);
  line(0, L, 'rgba(232,237,245,.75)', big ? 3.2 : 2.2);
  for (const c of route.climbs) {
    if (c.start + c.length <= L) line(c.start, c.start + c.length, '#f97316', 3);
    else { line(c.start, L, '#f97316', 3); line(0, c.start + c.length - L, '#f97316', 3); } // over the start line
  }
  // start (and finish of a point-to-point route)
  const flag = (d, color) => { const [px, py] = at(d); g.fillStyle = color; g.fillRect(px - 3, py - 3, 6, 6); g.strokeStyle = '#111'; g.lineWidth = 1; g.strokeRect(px - 3, py - 3, 6, 6); };
  flag(0, '#fff');
  if (route.oneWay) flag(L, '#22c55e');
  const dot = (d, color, r, ring) => {
    const [px, py] = at(d);
    g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fillStyle = color; g.fill();
    if (ring) { g.lineWidth = 2; g.strokeStyle = ring; g.stroke(); }
  };
  for (const b of ride.bots) dot(b.dist, b.color, 3);
  if (pacerOn()) dot(ride.pacer.dist, ride.pacer.color, 3);
  if (ride.ghost) dot(ride.ghost.dist, 'rgba(255,255,255,.55)', 3);
  // you: an arrow pointing the way you ride
  const [px, py] = at(ride.dist), [qx, qy] = at(ride.dist + 25), [rx, ry] = at(ride.dist - 10);
  const ang = Math.atan2(qy - ry, qx - rx), sz = big ? 11 : 9;
  g.save(); g.translate(px, py); g.rotate(ang);
  g.beginPath(); g.moveTo(sz, 0); g.lineTo(-sz * 0.75, sz * 0.7); g.lineTo(-sz * 0.35, 0); g.lineTo(-sz * 0.75, -sz * 0.7); g.closePath();
  g.fillStyle = settings.jersey; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.lineJoin = 'round'; g.stroke();
  g.restore();
}

/** Climb segments: start the timer at the foot, stop it at the top, compare with the best. */
function updateSegments() {
  const { route } = ride, L = route.length, prev = ride.prevDist, cur = ride.dist;
  ride.prevDist = cur;
  const crossed = (at) => Math.floor((prev - at) / L) < Math.floor((cur - at) / L);
  if (ride.seg) {
    const S = ride.seg, done = cur - S.d0;
    if (done >= S.climb.length) {
      const t = Math.round((ride.elapsed - S.t0) * 10) / 10, best = records.seg[S.climb.id];
      const top = S.climb.sprint ? Math.round(S.vmax * 3.6 * 10) / 10 : null;
      ride.efforts.push({ name: `${S.climb.sprint ? '⚡' : '⛰'} ${S.climb.name}`, time: t, best, pb: !best || t < best, ...(top ? { top } : {}) });
      if (top && top > (records.top[S.climb.id] || 0)) { records.top[S.climb.id] = top; saveRecords(); }
      if (!best || t < best) {
        records.seg[S.climb.id] = t;
        S.trace.push(Math.round(t * 10) / 10);
        records.segTrace[S.climb.id] = S.trace; // the record attempt, for the climb ghost next time
        saveRecords();
      }
      ride.climbGhost = null;
      if (S.climb.sprint) toast(`⚡ ${!best ? tr('{name}: {time} 🏁', { name: S.climb.name, time: fmtTime(t) }) : t < best ? tr('{name}: {time} — new record! ({delta}) 🏆', { name: S.climb.name, time: fmtTime(t), delta: fmtDelta(t - best) }) : tr('{name}: {time} ({delta} vs best)', { name: S.climb.name, time: fmtTime(t), delta: fmtDelta(t - best) })} · ${tr('top speed')} ${top} ${tr('km/h')}`);
      else toast(!best ? tr('{name}: {time} — first time up 🎉', { name: S.climb.name, time: fmtTime(t) }) : t < best ? tr('{name}: {time} — new record! ({delta}) 🏆', { name: S.climb.name, time: fmtTime(t), delta: fmtDelta(t - best) }) : tr('{name}: {time} ({delta} vs best)', { name: S.climb.name, time: fmtTime(t), delta: fmtDelta(t - best) }));
      cueBeep(t < (best || Infinity) ? 1180 : 760, 0.25);
      ride.seg = null;
    } else if (done < -5) { ride.seg = null; ride.climbGhost = null; } // rolled back past the start
    else {
      // note the time at every 10 m, interpolated between updates
      const t = ride.elapsed - S.t0;
      while (S.trace.length * TRACE_STEP <= done) {
        const at = S.trace.length * TRACE_STEP, f = done > S.lastOff ? (at - S.lastOff) / (done - S.lastOff) : 1;
        S.trace.push(Math.round((S.lastT + (t - S.lastT) * Math.max(0, Math.min(1, f))) * 10) / 10);
      }
      S.lastT = t; S.lastOff = done;
      S.vmax = Math.max(S.vmax || 0, ride.v);
    }
  }
  if (!ride.seg) {
    const c = [...route.climbs, ...(route.sprints || [])].find((cl) => crossed(cl.start));
    if (c) {
      ride.seg = { climb: c, t0: ride.elapsed, d0: cur - (((cur - c.start) % L) + L) % L, trace: [0], lastT: 0, lastOff: 0, vmax: ride.v };
      // your record on this climb starts beside you and rides it at its own pace (#26)
      const best = records.seg[c.id];
      ride.climbGhost = best ? { name: c.sprint ? tr('Sprint record') : tr('Climb record'), ghost: true, climb: true, color: settings.jersey, stripe: settings.stripe, dist: ride.seg.d0, pedal: 0.6, lane: START_LANE + 1.1, trace: records.segTrace[c.id] || null, best, length: c.length } : null;
      if (c.sprint) { toast(tr('⚡ {name}: {m} m — sprint!', { name: c.name, m: c.length })); cueBeep(1320, 0.18); }
      else toast(tr('{name} — {km} km at {grade}%. Go! ⛰️', { name: c.name, km: (c.length / 1000).toFixed(1), grade: (c.grade * 100).toFixed(1) }));
    }
  }
  const panel = $('seg-panel');
  panel.hidden = !ride.seg;
  if (ride.seg) {
    const S = ride.seg, t = ride.elapsed - S.t0, best = records.seg[S.climb.id];
    const frac = Math.min(1, (cur - S.d0) / S.climb.length);
    const left = Math.max(0, Math.round((S.climb.length - (cur - S.d0))));
    $('seg-name').textContent = `${S.climb.sprint ? '⚡' : '⛰'} ${S.climb.name}`;
    panel.classList.toggle('sprint', !!S.climb.sprint);
    $('seg-time').textContent = S.climb.sprint && t < 60 ? `${t.toFixed(1)} ${tr('s')}` : fmtTime(t);
    $('seg-left').textContent = S.climb.sprint ? `${tr('{n} m to the line', { n: left })} · ${Math.round((S.vmax || ride.v) * 3.6)} ${tr('km/h')} ${tr('max')}` : tr('{n} m to the top', { n: left });
    $('seg-best').textContent = best ? tr('best {time}', { time: fmtTime(best) }) : tr('no record yet');
    // on pace: compare with the best time scaled to the distance done so far
    const pace = best ? t - traceTime(records.segTrace[S.climb.id], best, S.climb.length, cur - S.d0) : 0;
    $('seg-pace').textContent = best && frac > 0.05 ? fmtDelta(pace) : '';
    $('seg-pace').className = pace <= 0 ? 'c-ok' : 'c-bad';
    $('seg-fill').style.width = `${(frac * 100).toFixed(1)}%`;
  }
}

function updateProgress() {
  drawMinimap();
  // the bottom-right bar always tracks the lap; the workout's name and progress head its own panel
  const L = ride.route.length, frac = ride.route.oneWay ? Math.min(1, ride.dist / L) : (ride.dist % L) / L;
  $('progress-fill').style.width = `${(frac * 100).toFixed(1)}%`;
  const best = bestLap(ride.route);
  if (ride.route.oneWay) $('progress-label').textContent = `${(Math.min(ride.dist, L) / 1000).toFixed(1)} / ${(L / 1000).toFixed(1)} ${U.km} · ${fmtTime(ride.elapsed)}${best ? ` (${tr('best {time}', { time: fmtTime(best) })})` : ''}`;
  else $('progress-label').textContent = `${tr('Lap {n}', { n: Math.floor(ride.dist / L) + 1 })} · ${((ride.dist % L) / 1000).toFixed(1)} / ${(L / 1000).toFixed(0)} ${U.km} · ${fmtTime(ride.elapsed - ride.lapStartT)}${best ? ` (${tr('best {time}', { time: fmtTime(best) })})` : ''}`;
  if (ride.workout) {
    const done = Math.min(1, ride.workoutT / totalDuration(ride.workout));
    $('wk-name').textContent = ride.workout.name;
    $('wk-name').title = ride.workout.name;
    $('wk-pct').textContent = ride.workoutDone ? tr('done') : `${Math.round(done * 100)}%`;
  }
}

/** "10 min", "30 s", "1:30" */
const stepDur = (sec) => (sec >= 60 && sec % 60 === 0 ? `${sec / 60} ${U.min}` : sec < 60 ? `${sec} ${tr('s')}` : fmtTime(sec));
/** "10 min @ 270 W", "5 min 97→151 W", "30 min 151–158 W", "5 min free" for the list. */
function stepLabel(s) {
  if (s.free) return `${stepDur(s.dur)} ${tr('free')}`;
  const band = stepBand(s);
  if (band) return `${stepDur(s.dur)} ${band[0]}–${band[1]} ${U.W}`;
  const a = scaleW(stepWatts(s, 0, settings.ftp)), b = scaleW(stepWatts(s, 1, settings.ftp));
  return a === b ? `${stepDur(s.dur)} @ ${a} ${U.W}` : `${stepDur(s.dur)} ${a}→${b} ${U.W}`;
}
/** Whether a finished interval was ridden on target: inside its range, or within ±5 % of its mean target. */
function stepOnTarget(s, st) {
  if (!st || !st.n || s.free) return false;
  const p = st.p / st.n, band = stepBand(s);
  if (band) return p >= band[0] * 0.98 && p <= band[1] * 1.02;
  const t = st.t / st.n;
  return t > 0 && Math.abs(p - t) <= t * 0.05;
}

/** The workout's intervals on the left, as in Zwift: two done, the current one filling up, the next ones. */
function renderStepList() {
  const box = $('wk-steps');
  if (!ride?.workout || box.hidden) return;
  const steps = ride.workout.steps, cur = ride.workoutDone ? steps.length : (ride.stepIndex ?? 0);
  const total = totalDuration(ride.workout);
  $('ws-finish').innerHTML = ride.workoutDone ? `<b>${tr('Workout complete')}</b>` : `${tr('Finish in')} <b>${fmtTime(Math.max(0, total - ride.workoutT))}</b>`;
  const stars = steps.slice(0, cur).filter((s, i) => stepOnTarget(s, ride.stepStats[i])).length;
  $('ws-stars').textContent = `★ ${stars}/${steps.length}`;
  const from = Math.max(0, cur - 1), to = Math.min(steps.length, from + 6); // one done, the current one, what's next
  let start = 0;
  for (let i = 0; i < cur && i < steps.length; i++) start += steps[i].dur;
  const html = [];
  if (from > 0) html.push(`<li class="more">⋯ ${from}</li>`);
  for (let i = from; i < to; i++) {
    const s = steps[i], mid = scaleW(stepWatts(s, 0.5, settings.ftp));
    const zc = s.free || mid === null ? '#64748b' : zoneColor(mid / settings.ftp);
    if (i < cur) html.push(`<li class="done" style="--zc:${zc}"><span class="st">${stepOnTarget(s, ride.stepStats[i]) ? '★' : ''}</span><span>${esc(stepLabel(s))}</span></li>`);
    else if (i === cur) {
      const done = Math.min(1, Math.max(0, (ride.workoutT - start) / s.dur));
      html.push(`<li class="cur" style="--zc:${zc}"><i class="fill" style="width:${(done * 100).toFixed(1)}%"></i><span class="st">▶</span><span>${esc(stepLabel(s))}</span></li>`);
    } else html.push(`<li style="--zc:${zc}"><span class="st"></span><span>${esc(stepLabel(s))}</span></li>`);
  }
  if (to < steps.length) html.push(`<li class="more">+ ${steps.length - to}</li>`);
  $('ws-list').innerHTML = html.join('');
}

/**
 * The strip along the bottom of the ride (as in Zwift): the ride so far, power as bars coloured by zone
 * and heart rate as a line. At least ten minutes wide, squeezed as the ride gets longer.
 */
/** A small dark tag with the FTP value, just above the dashed FTP line (below it when there is no room). */
function ftpTag(g, x, yF, ftp, align = 'left') {
  const t = `FTP ${ftp} W`;
  g.font = '600 11px system-ui, -apple-system, sans-serif';
  const tw = g.measureText(t).width, bw = tw + 10, bh = 16;
  const bx = align === 'right' ? x - bw : x, by = yF - bh - 3 < 0 ? yF + 3 : yF - bh - 3;
  g.fillStyle = 'rgba(10,15,25,.72)';
  g.beginPath(); g.roundRect(bx, by, bw, bh, 4); g.fill();
  g.fillStyle = 'rgba(255,255,255,.9)'; g.textBaseline = 'middle';
  g.fillText(t, bx + 5, by + bh / 2 + 0.5);
  g.textBaseline = 'alphabetic';
}

function drawTrace() {
  const c = $('trace');
  if (!c || !c.clientWidth) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const s = recorder.samples, n = s.length;
  if (!n) return;
  const ftp = settings.ftp, BAR = 3;
  const cols = Math.floor(w / BAR);
  const span = Math.max(600, n);              // seconds across the strip
  const per = span / cols;                     // seconds per bar
  const pMax = Math.max(ftp * 1.6, 1), top = 6, base = h, H = base - top; // as the profile beside it: flush with the bottom, 6 px clear at the top
  const hrLo = 60, hrHi = Math.max(190, settings.maxHr || 0);
  const hrPts = [];
  for (let i = 0; i * per < n; i++) {
    const a = Math.floor(i * per), b = Math.min(n, Math.max(a + 1, Math.floor((i + 1) * per)));
    let p = 0, hr = 0, hn = 0;
    for (let k = a; k < b; k++) { p += s[k].power || 0; if (s[k].heartRate > 0) { hr += s[k].heartRate; hn++; } }
    p /= b - a;
    const x = i * BAR;
    const bh = Math.max(1, Math.min(1, p / pMax) * H);
    g.fillStyle = zoneColor(p / ftp);
    g.fillRect(x, base - bh, BAR - 1, bh);
    if (hn) hrPts.push([x + BAR / 2, base - Math.min(1, Math.max(0, (hr / hn - hrLo) / (hrHi - hrLo))) * H]);
    else hrPts.push(null);
  }
  // FTP line
  const yF = base - (ftp / pMax) * H;
  g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 1; g.setLineDash([3, 4]);
  g.beginPath(); g.moveTo(0, yF); g.lineTo(w, yF); g.stroke(); g.setLineDash([]);
  g.strokeStyle = '#ff4d5e'; g.lineWidth = 1.6; g.beginPath();
  let on = false;
  for (const p of hrPts) { if (!p) { on = false; continue; } on ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); on = true; }
  g.stroke();
  ftpTag(g, w - 4, yF, ftp, 'right');
}

function drawWorkoutChart(canvas, w, t) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const total = totalDuration(w);
  const ftp = settings.ftp;
  const wattsOf = (s, f) => scaleW(stepWatts(s, f, ftp)) ?? ftp * 0.5;
  const topOf = (s) => (s.rangeW ? scaleW(s.rangeW[1]) : s.range ? scaleW(Math.round(s.range[1] * ftp)) : 0);
  const maxW = Math.max(...w.steps.map((s) => Math.max(wattsOf(s, 0), wattsOf(s, 1), topOf(s)))) * 1.05;
  let x0 = 0;
  for (const s of w.steps) {
    const x1 = x0 + s.dur;
    // a range target (like intervals.icu): solid up to its low end, a lighter band up to the high end
    const range = (s.rangeW || (s.range && s.range.map((f) => f * ftp)))?.map((v) => scaleW(Math.round(v)));
    const a = range ? range[0] : wattsOf(s, 0), b = range ? range[0] : wattsOf(s, 1);
    ctx.fillStyle = s.free ? '#64748b' : zoneColor((range ? (range[0] + range[1]) / 2 : (a + b) / 2) / ftp);
    ctx.globalAlpha = t >= 0 && x1 <= t ? 0.45 : 1;
    ctx.beginPath();
    ctx.moveTo((x0 / total) * W, H);
    ctx.lineTo((x0 / total) * W, H - (a / maxW) * H);
    ctx.lineTo((x1 / total) * W, H - (b / maxW) * H);
    ctx.lineTo((x1 / total) * W, H);
    ctx.closePath();
    ctx.fill();
    if (range) {
      const [lo, hi] = range;
      ctx.globalAlpha *= 0.5;
      ctx.fillRect((x0 / total) * W, H - (hi / maxW) * H, ((x1 - x0) / total) * W, ((hi - lo) / maxW) * H);
    }
    x0 = x1;
  }
  ctx.globalAlpha = 1;
  if (t >= 0) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(Math.min(W - 2 * dpr, (t / total) * W), 0, 2 * dpr, H);
  }
}

function togglePause() {
  if (!ride) return;
  advance();
  ride.paused = !ride.paused;
  ride.lastSim = performance.now();
  $('paused').hidden = !ride.paused;
  $('btn-pause').textContent = ride.paused ? tr('Resume') : tr('Pause');
  if (ride.paused) showControls(0); else showControls();
  if (pipOpen() && ride.lastHud) updateHud(...ride.lastHud);
}

/** The ride so far, kept in case the page closes before Finish (#: crash safety). */
function saveDraft() {
  if (!ride || recorder.samples.length < 10) return;
  ride.draftAt = ride.elapsed;
  const w = ride.workout;
  putDraft({
    start: (recorder.startTime || new Date()).getTime(), savedAt: Date.now(),
    samples: recorder.samples, lapStarts: recorder.lapStarts,
    meta: {
      routeId: ride.route.id, routeName: ride.route.name, intensity: settings.intensity,
      workout: w ? { id: w.id, name: w.name, source: w.source || null, eventId: w.eventId || null } : null,
      lapTimes: ride.lapTimes, splits: ride.splits, efforts: ride.efforts,
    },
  });
}

/** An unfinished ride found on opening the page: save it to history (then upload or download it) or discard it. */
async function offerDraft() {
  const d = await getDraft();
  const box = $('draft-box');
  if (!d || !d.samples?.length || ride) { box.hidden = true; return; }
  if (d.samples.length < 30) { deleteDraft(); box.hidden = true; return; }
  const when = new Date(d.start).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  $('draft-text').textContent = tr('Unfinished ride: {route}{workout} · {time} · {when}', {
    route: d.meta.routeName || '', workout: d.meta.workout ? ` · ${d.meta.workout.name}` : '', time: fmtTime(d.samples.length), when,
  });
  box.hidden = false;
  $('draft-save').onclick = async () => {
    const rec = new Recorder();
    rec.samples = d.samples; rec.startTime = new Date(d.start); rec.lapStarts = d.lapStarts || [0];
    const m = d.meta, full = allWorkouts().find((x) => x.id === m.workout?.id);
    const r = {
      workout: full || m.workout, intensity: m.intensity, route: routes.find((x) => x.id === m.routeId) || { id: m.routeId, name: m.routeName },
      summary: rec.summary(), uploadedId: null, lapTimes: m.lapTimes || [], splits: m.splits || [], efforts: m.efforts || [], ramp: false, ghostGap: null,
    };
    const entry = saveToHistory(r, rec.samples);
    await putRide({ id: entry.id, start: d.start, samples: rec.samples, lapStarts: rec.lapStarts });
    await deleteDraft();
    box.hidden = true;
    showSummary(entry); // from history: .FIT / .TCX and Send to intervals.icu
  };
  $('draft-drop').onclick = async () => {
    if ($('draft-drop').dataset.armed !== '1') { $('draft-drop').dataset.armed = '1'; $('draft-drop').textContent = tr('Tap again to discard'); return; }
    await deleteDraft();
    box.hidden = true;
  };
}

let rideFullscreen = false; // full screen was ours (installed app): leave it with the ride
function finishRide() {
  if (!ride) return;
  if (rideFullscreen && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  rideFullscreen = false;
  advance();
  clearInterval(rideTimer);
  closePip();
  keepAwake(false);
  crowdOff();
  const sum = recorder.summary();
  const ghostGap = ride.ghost ? Math.round(ride.dist - ride.ghost.dist) : null;
  lastRide = { race: raceResults(), raceLaps: ride.race?.laps, workout: ride.workout, intensity: settings.intensity, route: ride.route, summary: sum, uploadedId: null, lapTimes: ride.lapTimes, splits: ride.splits, efforts: ride.efforts, ramp: !!ride.workout?.ramp, ghostGap, ghostName: ride.ghost?.name };
  ride = null;
  if (trainer.connected && trainer.controllable) {
    trainer.setSimulation(0);
    if (settings.shiftMode === 'wheel') trainer.setWheelCircumference(BASE_WHEEL_MM);
  }
  const entry = sum && sum.duration >= 30 ? saveToHistory(lastRide, recorder.samples) : null;
  if (entry) putRide({ id: entry.id, start: (recorder.startTime || new Date()).getTime(), samples: recorder.samples, lapStarts: recorder.lapStarts });
  deleteDraft();
  $('ride').hidden = true;
  showSummary(entry || historyEntry(lastRide, recorder.samples), { live: true });
}

// ---------- Ride history (#19) ----------
// The last 100 rides, kept on this device: the summary, laps and climbs, and power / heart rate every
// 5 s for the chart (the full second-by-second record is only kept until the next ride).
const HISTORY_KEY = 'gruppetto.history';
let history = (() => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } })();
const saveHistory = () => {
  for (;;) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); return; } catch { if (history.length <= 1) return; history.pop(); } // full: drop the oldest
  }
};

/** Training stress: hours × intensity factor² × 100, with NP (or average power) against FTP. */
function tss(sum, ftp) {
  const np = sum.normalizedPower || sum.avgPower;
  if (!np || !ftp) return 0;
  return Math.round((sum.duration * np * (np / ftp)) / (ftp * 3600) * 100);
}

function historyEntry(r, samples) {
  const every = 5, pw = [], hr = [], d = [], tg = [], cd = [], wb = [];
  const wPrime = wPrimeJ(), wbal = wbalSeries(samples.map((x) => x.power || 0), settings.ftp, wPrime);
  for (let i = 0; i < samples.length; i += every) {
    const chunk = samples.slice(i, i + every);
    wb.push(Math.round(wbal[Math.min(samples.length, i + every) - 1]));
    // power and cadence: a plain mean, pauses (zeros) included, so a stop shows as one; heart rate and the target
    // leave their zeros out (a strap that lost contact, a step without a target)
    const avg = (k, zeros = false) => { const v = chunk.map((x) => x[k] || 0).filter((x) => zeros || x > 0); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0; };
    pw.push(avg('power', true)); hr.push(avg('heartRate')); tg.push(avg('target')); cd.push(avg('cadence', true));
    d.push(Math.round((chunk[chunk.length - 1].distance || 0) * 10) / 10); // distance at the end of each 5 s, for ghosts
  }
  return {
    id: `r${Date.now()}`, date: new Date().toISOString(), routeId: r.route?.id, routeName: r.route?.name,
    workoutName: r.workout?.name || null, ramp: r.ramp, ftp: settings.ftp, wPrime, wbalMin: wbal.length ? Math.round(Math.min(...wbal)) : wPrime, summary: r.summary,
    tss: r.summary ? tss(r.summary, settings.ftp) : 0, ghostGap: r.ghostGap ?? null, ghostName: r.ghostName || null, lapTimes: r.lapTimes || [], splits: r.splits || [], efforts: r.efforts || [],
    race: r.race || null, raceLaps: r.raceLaps || null,
    maxHr: settings.maxHr || 0, lthr: settings.lthr || 0, hrZones: settings.hrZones || null, hrZoneNames: settings.hrZoneNames || [], eventId: r.workout?.source === 'intervals' ? r.workout.eventId : null, uploadedId: null,
    bests: bestsFromSamples(samples.map((x) => x.power || 0)), // best 5 s ... 60 min, for the power curve
    stops: stopsOf(samples.map((x) => x.power || 0)), // short pauses: how many and how long in all
    chart: { every, pw, hr, d, wb, ...(tg.some((x) => x > 0) ? { tg } : {}), ...(cd.some((x) => x > 0) ? { cd } : {}) },
    intervals: r.workout?.steps ? rideIntervals(samples, (i) => stepBand(r.workout.steps[i], r.intensity ?? 100)).map((x) => {
      // a ramp shows where it starts and ends
      const st = r.workout.steps[x.step], k = (r.intensity ?? 100) / 100;
      const a = stepWatts(st, 0, settings.ftp), b = stepWatts(st, 1, settings.ftp);
      return a !== null && b !== null && a !== b ? { ...x, ramp: [Math.round(a * k), Math.round(b * k)] } : x;
    }) : [],
  };
}

function saveToHistory(r, samples) {
  const e = historyEntry(r, samples);
  // XP, level and badges: what this ride earned shows in its summary
  const got = addRide(progress, e);
  progress = got.progress; saveProgress();
  // a planned workout just ridden is done: off the list, and the next ride is a free one unless another is picked
  if (e.eventId) {
    const stats = icuWorkouts.stats;
    icuWorkouts = icuWorkouts.filter((w) => String(w.eventId) !== String(e.eventId));
    icuWorkouts.stats = stats;
    if (!allWorkouts().some((w) => w.id === settings.mode) && !['free', 'race'].includes(settings.mode)) { settings.mode = 'free'; saveSettings(); }
  }
  track('ride-finish', minutesBucket(e.summary?.duration || 0));
  if (rideMilestone(progress.rides)) track('ride-count', rideMilestone(progress.rides));
  for (const b of got.badges) track('badge', b.id);
  e.earned = { xp: got.progress.xp, badges: got.badges.map((b) => b.id), levelUp: got.levelUp ? levelOf(got.progress.xp).level : 0 };
  history.unshift(e);
  history = history.slice(0, 100);
  saveHistory();
  renderHistory();
  return e;
}

// ---------- Levels and achievements (#progress) ----------
const PROGRESS_KEY = 'gruppetto-progress';
let progress = (() => { try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null'); } catch { return null; } })() || progressFrom(history);
function saveProgress() { try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); } catch { /* private mode */ } }
const badgeName = (b) => `${b.icon} ${tr(b.name)}`;

/** The level chip in the lobby and the progress card in History: level, XP to the next, totals, every badge. */
function renderProgress() {
  const L = levelOf(progress.xp), pct = Math.round(L.frac * 100);
  renderAvatar();
  const box = $('progress-box');
  box.hidden = !progress.rides;
  $('progress-empty').hidden = !!progress.rides;
  if (box.hidden) return;
  const n = Object.keys(progress.badges).length;
  box.innerHTML = `<div class="sum-chart-head"><h2>${tr('Level {n}', { n: L.level })}</h2><span class="muted">${tr('{xp} XP · {left} to level {n}', { xp: L.xp, left: L.to - L.xp, n: L.level + 1 })}</span></div>
    <div class="lvl-bar"><i style="width:${pct}%"></i></div>
    <div class="lvl-totals"><span><b>${progress.rides}</b> ${tr('rides')}</span><span><b>${Math.round(progress.km)}</b> ${U.km}</span><span><b>${progress.gain}</b> ${tr('m climbed')}</span><span><b>${n}/${BADGES.length}</b> ${tr('badges')}</span></div>
    <div class="badges">${BADGES.map((b) => { const at = progress.badges[b.id]; return `<div class="badge${at ? ' got' : ''}" title="${esc(tr(b.how))}"><span>${b.icon}</span><b>${esc(tr(b.name))}</b><small>${at ? new Date(at).toLocaleDateString(locale, { day: 'numeric', month: 'short' }) : esc(tr(b.how))}</small></div>`; }).join('')}</div>`;
}

/** What a ride earned, on its summary: a new level and new badges. */
function renderEarned(e) {
  const box = $('sum-earned'), got = e.earned;
  const items = got ? [...(got.levelUp ? [`<span class="earn-lvl">⬆ ${tr('Level {n}!', { n: got.levelUp })}</span>`] : []),
    ...got.badges.map((id) => BADGES.find((b) => b.id === id)).filter(Boolean).map((b) => `<span class="earn-badge" title="${esc(tr(b.how))}">${badgeName(b)}</span>`)] : [];
  box.hidden = !items.length;
  box.innerHTML = items.length ? `<span class="pr-head">${tr('Earned on this ride')}</span>${items.join('')}` : '';
}

// ---------- A friend's ride from a link (#challenge) ----------
// The last challenge opened stays until another one comes: on its route its ghost rides instead of yours.
const CHALLENGE_KEY = 'gruppetto-challenge';
let challenge = (() => { try { return JSON.parse(localStorage.getItem(CHALLENGE_KEY) || 'null'); } catch { return null; } })();
function saveChallenge() { try { localStorage.setItem(CHALLENGE_KEY, JSON.stringify(challenge)); } catch { /* private mode */ } }
/** The ghost to ride with on this route: a friend's challenge first, then your own best or last ride. */
function rideGhost(routeId) {
  if (settings.ghost !== 'off' && challenge?.routeId === routeId) return challenge;
  return pickGhost(routeId);
}
const ghostLabel = (g) => (g.friend ? g.name || tr('Friend') : settings.ghost === 'last' ? tr('Last ride') : tr('Your best'));

/** The link to race this ride's ghost: shared where the device can, copied otherwise. */
async function challengeFriend(e) {
  const route = routes.find((r) => r.id === e.routeId);
  // the default name says nothing to a friend: «A friend» then, and a hint to set yours
  const named = settings.name?.trim() && settings.name.trim() !== DEFAULT_SETTINGS.name;
  if (!named) toast(tr('Set your name in Profile, so friends see who challenges them'));
  const url = `${location.origin}${location.pathname}#challenge=${await encodeChallenge(e, named ? settings.name.trim() : '')}`;
  const text = tr('Race my ghost on {route} in Gruppetto: {km} km in {time}', { route: route?.name || '', km: (e.summary.distance / 1000).toFixed(1), time: fmtTime(e.summary.duration) });
  track('challenge-send');
  if (navigator.share) { try { await navigator.share({ title: 'Gruppetto', text, url }); return; } catch (err) { if (err.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast(tr('Link copied: send it to a friend')); } catch { prompt(tr('Copy the link'), url); }
}

/** A page opened from a challenge link: the friend's ride becomes the ghost of its route, which is picked. */
async function openChallenge() {
  const code = challengeIn(location.hash);
  if (!code) return;
  window.history.replaceState(null, '', location.pathname + location.search); // not «history»: that is the rides
  const c = await decodeChallenge(code);
  const route = c && routes.find((r) => r.id === c.routeId && !r.custom);
  if (!route) { alertBox(tr('This challenge link is broken or from a newer Gruppetto: ask for a new one.')); return; }
  challenge = c; saveChallenge();
  track('challenge-open');
  settings.routeId = route.id;
  if (settings.ghost === 'off') settings.ghost = 'best';
  saveSettings(); markRoute(); showRoute(); updateSummary(); renderChallenge();
  $('challenge-box').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** The challenge card in the lobby, while the route picked is the challenge's. */
function renderChallenge() {
  const route = challenge && routes.find((r) => r.id === challenge.routeId);
  $('challenge-box').hidden = !route || settings.routeId !== route.id || settings.ghost === 'off';
  if ($('challenge-box').hidden) return;
  const who = challenge.name && challenge.name !== DEFAULT_SETTINGS.name ? challenge.name : tr('A friend'); // links made before names were checked say «Me»
  $('ch-title').textContent = tr('{name} challenges you on {route}', { name: who, route: route.name });
  $('ch-goal').textContent = tr('To beat: {km} km in {time}', { km: (challenge.summary.distance / 1000).toFixed(1), time: fmtTime(challenge.summary.duration) });
  $('ch-how').textContent = tr('Their ghost rides beside you exactly as they rode. Be ahead of it at the end, and the summary says by how much.');
}
$('ch-ride').onclick = () => { settings.mode = 'free'; saveSettings(); renderModes(); updateSummary(); startRide(); };
$('ch-drop').onclick = () => { track('challenge-dismiss'); challenge = null; saveChallenge(); renderChallenge(); updateSummary(); };

// ---------- Shadow ride (#24) ----------
// Race a ghost of an earlier ride on the same route: it rides where you were at the same moment.
/** Rides on this route that can ride as a ghost (they carry a distance trace). */
const ghostRides = (routeId) => history.filter((e) => e.routeId === routeId && e.chart?.d?.length > 1 && e.summary?.distance > 300);
/** The ride to chase: your fastest on this route (average speed), or the latest one. */
function pickGhost(routeId, mode = settings.ghost) {
  const list = ghostRides(routeId);
  if (!list.length || mode === 'off') return null;
  if (mode === 'last') return list[0];
  return list.reduce((a, b) => (b.summary.distance / b.summary.duration > a.summary.distance / a.summary.duration ? b : a));
}
/** Where the ghost is at time t (s), between the 5 s points of its trace. */
function ghostDistAt(e, t) {
  const d = e.chart.d, k = t / e.chart.every - 1; // d[i] is the distance at the end of second (i+1)·every
  if (k <= 0) return Math.max(0, d[0] * (t / e.chart.every));
  if (k >= d.length - 1) return d[d.length - 1];
  const i = Math.floor(k);
  return d[i] + (d[i + 1] - d[i]) * (k - i);
}
/** When the ghost passed distance x (s), or null if it never got that far. */
function ghostTimeAt(e, x) {
  const d = e.chart.d, n = d.length;
  if (x > d[n - 1]) return null;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (d[m] < x) lo = m + 1; else hi = m; }
  const prev = lo ? d[lo - 1] : 0, t0 = lo * e.chart.every;
  return t0 + e.chart.every * (d[lo] > prev ? (x - prev) / (d[lo] - prev) : 0);
}
/** The ghost picker in the lobby: shown when the selected route has rides to chase. */
function renderGhostPicker() {
  const r = routes.find((x) => x.id === settings.routeId);
  const list = r ? ghostRides(r.id) : [];
  $('ghost-box').hidden = !list.length;
  if (!list.length) return;
  const best = pickGhost(r.id, 'best'), last = list[0];
  const desc = (e) => `${new Date(e.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${(e.summary.distance / 1000).toFixed(1)} km in ${fmtTime(e.summary.duration)}`;
  $('ghost-best').textContent = desc(best);
  $('ghost-last').textContent = desc(last);
  // in the bottom bar the times are the buttons' hover text
  document.querySelector('#ghost-box [data-ghost="best"]').title = desc(best);
  document.querySelector('#ghost-box [data-ghost="last"]').title = desc(last);
  for (const b of document.querySelectorAll('#ghost-box [data-ghost]')) {
    b.classList.toggle('sel', b.dataset.ghost === settings.ghost);
    b.onclick = () => { settings.ghost = b.dataset.ghost; saveSettings(); renderGhostPicker(); updateSummary(); renderChallenge(); };
  }
}

/** The ride summary screen, for the ride just finished (live: downloads available) or one from history. */
function showSummary(e, { live = false } = {}) {
  // a lobby page (Devices, Profile…) belongs to the lobby, not over the summary
  if (!$('drawer').classList.contains('in-ride')) $('drawer').hidden = true;
  $('wk-menu').hidden = true;
  const sum = e.summary;
  $('lobby').hidden = true;
  $('summary').hidden = false;
  $('sum-kicker').textContent = live ? tr('Ride complete') : new Date(e.date).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  $('sum-name').textContent = [e.routeName, e.race ? `🏁 ${tr('Race')}` : e.workoutName || tr('Free ride')].filter(Boolean).join(' · ');
  // new power records: this ride against every ride before it
  const before = powerCurve(history.filter((x) => x !== e && Date.parse(x.date) < Date.parse(e.date)));
  const recs = Object.entries(e.bests || {}).filter(([d, w]) => before[d] && w > before[d].w).map(([d, w]) => `<span class="pr-chip">${durLabel(+d)} <b>${w} ${U.W}</b> 🏆</span>`);
  $('sum-prs').hidden = !recs.length;
  $('sum-prs').innerHTML = recs.length ? `<span class="pr-head">${tr('New power records')}</span>${recs.join('')}` : '';
  renderFtpTip($('sum-ftp'), e);
  // race results
  $('sum-race').hidden = !e.race;
  if (e.race) {
    const mine = e.race.find((x) => x.me), winner = e.race[0];
    $('sum-race-place').textContent = mine ? tr('{n} of {m}', { n: e.race.indexOf(mine) + 1, m: e.race.length }) : '';
    $('sum-race-rows').innerHTML = e.race.map((x, i) => `<tr class="${x.me ? 'me' : ''}"><td>${i + 1}</td><td><i style="background:${esc(x.color || '#888')}"></i>${esc(x.name)}</td><td>${fmtTime(Math.round(x.time))}${x.est ? ' *' : ''}</td><td>${i ? `+${fmtTime(Math.round(x.time - winner.time))}` : ''}</td></tr>`).join('');
  }
  const hero = sum ? [
    [tr('Time'), fmtTime(sum.duration), ''],
    [tr('Distance'), (sum.distance / 1000).toFixed(2), U.km],
    [tr('Avg power'), sum.avgPower, U.W],
    [tr('Avg heart rate'), sum.avgHr || '—', sum.avgHr ? U.bpm : ''],
  ] : [[tr('Time'), '0:00', '']];
  $('sum-hero').innerHTML = hero.map(([k, v, u]) => `<div><label>${k}</label><b>${v}</b><span>${u}</span></div>`).join('');
  // W′bal: saved second by second since it was added, worked out from the 5 s power of older rides
  const wPrime = e.wPrime || wPrimeJ(), wb = e.chart.wb || wbalSeries(e.chart.pw, e.ftp || settings.ftp, wPrime, e.chart.every);
  const chartSamples = e.chart.pw.map((p, i) => ({ power: p, heartRate: e.chart.hr[i], target: e.chart.tg?.[i] || 0, cadence: e.chart.cd?.[i] || 0, wbal: wb[i] ?? wPrime }));
  $('lg-plan').hidden = !e.chart.tg; $('lg-cad').hidden = !e.chart.cd;
  renderZones(e);
  renderIntervals(e);
  requestAnimationFrame(() => drawSummaryChart($('sum-chart'), chartSamples, 2, e.ftp || settings.ftp, wPrime));
  hoverSummaryChart(chartSamples, e.chart.every, wPrime);
  const stats = sum ? [
    [tr('Elevation gain'), `${Math.round(sum.elevationGain)} ${U.m}`],
    ['NP', sum.normalizedPower ? `${sum.normalizedPower} ${U.W}` : '—'],
    ['TSS', e.tss || '—'],
    [tr('Max power'), `${sum.maxPower} ${U.W}`],
    [tr('Max heart rate'), sum.maxHr ? `${sum.maxHr} ${U.bpm}` : '—'],
    [tr('Avg cadence'), `${sum.avgCadence} ${U.rpm}`],
    [tr('Work'), `${sum.kj} ${tr('kJ')}`],
  ] : [];
  // short pauses: how many, how long; older rides from their 5 s chart
  const stops = e.stops || stopsOf(e.chart.pw, e.chart.every);
  if (sum && stops.sec) stats.push([tr('Not pedalling'), `${fmtTime(stops.sec)} · ${stops.n} ${lang === 'uk' ? plural(stops.n, ['зупинка', 'зупинки', 'зупинок']) : stops.n === 1 ? 'stop' : 'stops'}`]);
  if (sum) { const low = e.wbalMin ?? Math.min(...wb); stats.push([tr('Lowest W′bal'), `${(low / 1000).toFixed(1)} ${tr('kJ')} · ${Math.round((low / wPrime) * 100)}%`]); }
  if (sum && e.ramp && sum.best1min) stats.push([tr('Estimated FTP'), `${Math.round(sum.best1min * 0.75)} ${U.W}`]);
  if (e.ghostGap !== null && e.ghostGap !== undefined) stats.push([tr('vs {name}', { name: e.ghostName || tr('ghost') }), `${e.ghostGap >= 0 ? '+' : '−'}${Math.abs(e.ghostGap)} ${U.m} ${e.ghostGap >= 0 ? '🏆' : ''}`]);
  $('sum-stats').innerHTML = stats.map(([k, v]) => `<div><label>${k}</label><b>${v}</b></div>`).join('');
  // laps and climbs of this ride, with personal bests
  const rows = [
    ...e.lapTimes.map((t, i) => [routes.find((x) => x.id === e.routeId)?.oneWay ? tr('Finish') : tr('Lap {n}', { n: i + 1 }), t, null]),
    ...e.efforts.map((x) => [x.name, x.time, x]),
    ...(e.splits || []).map((x, i) => [tr('Split {n}', { n: i + 1 }), x.time, { note: `${(x.dist / 1000).toFixed(2)} ${U.km} · ${x.power} ${U.W}` }]),
  ];
  $('sum-segments').hidden = !rows.length;
  $('sum-seg-rows').innerHTML = rows.map(([name, t, x]) => {
    const lapRoute = routes.find((r) => r.id === e.routeId);
    const pb = x ? x.pb : t <= ((lapRoute && bestLap(lapRoute)) ?? Infinity);
    const vs = (x?.note ? esc(x.note) : x && x.best ? fmtDelta(t - x.best) : '') + (x?.top ? ` · ${x.top} ${tr('km/h')}` : '');
    return `<tr><td>${esc(name)}</td><td>${fmtTime(t)}</td><td>${pb ? `<span class="pb">🏆 ${tr('best')}</span>${x?.top ? ` · ${x.top} ${tr('km/h')}` : ''}` : vs}</td></tr>`;
  }).join('');
  // files and intervals.icu: the ride just finished, or an older one whose full record is still kept
  shown = { entry: e, rec: live ? recorder : null };
  renderEarned(e);
  $('btn-challenge').hidden = !(e.chart?.d?.length > 1 && !e.race && routes.some((r) => r.id === e.routeId && !r.custom));
  const files = (on) => {
    for (const id of ['btn-download', 'btn-download-tcx']) { $(id).hidden = !on; $(id).disabled = !sum; }
    document.querySelector('#summary .hint:last-of-type').hidden = !on;
  };
  const uploadUi = (can) => {
    $('btn-icu-upload').hidden = !can;
    $('btn-icu-upload').disabled = false;
    $('btn-icu-upload').textContent = live ? tr('Upload to intervals.icu') : tr('Send to intervals.icu');
    const st = $('icu-upload-status');
    st.hidden = !e.uploadedId;
    if (e.uploadedId) st.innerHTML = e.uploadedId === true ? tr('Uploaded to intervals.icu ✓') : `${tr('Uploaded to intervals.icu ✓')} · <a href="${activityUrl(e.uploadedId)}" target="_blank" rel="noopener">${tr('open ride')}</a>`;
  };
  const canUpload = (rec) => !!(rec && icuClient && sum && sum.duration >= 60);
  files(live);
  uploadUi(live && canUpload(recorder));
  $('btn-delete-ride').hidden = live;
  $('btn-delete-ride').dataset.id = e.id;
  $('btn-delete-ride').textContent = tr('Delete ride');
  if (live) { scheduleUpload(canUpload(recorder)); return; }
  scheduleUpload(false);
  getRide(e.id).then((r) => {
    if (!r || shown.entry !== e) return;
    const rec = new Recorder();
    rec.samples = r.samples; rec.startTime = new Date(r.start); rec.lapStarts = r.lapStarts || [0];
    shown.rec = rec;
    files(true);
    uploadUi(canUpload(rec) && !e.uploadedId);
  });
}
/** The ride on the summary screen: its history entry and, when kept, its full record. */
let shown = { entry: null, rec: null };

/** Time in power zones (and heart rate zones when there are any), as bars. */
function renderZones(e) {
  const ftp = e.ftp || settings.ftp, every = e.chart.every;
  const total = e.chart.pw.length * every;
  const bars = (zones) => zones.map((z) => {
    const pct = total ? (z.sec / total) * 100 : 0;
    return `<div class="zb"><span class="zn">Z${z.z}</span><span class="zt">${esc(tr(z.name))}</span><span class="zbar"><i style="width:${pct.toFixed(1)}%;background:${z.color}"></i></span><span class="zs">${z.sec ? fmtTime(z.sec) : '—'}</span><span class="zp">${pct >= 0.5 ? Math.round(pct) : 0}%</span></div>`;
  }).join('');
  $('sum-zones-power').innerHTML = bars(timeInZones(e.chart.pw, ftp, POWER_ZONES, every));
  const hz = (e.hrZones || e.lthr ? hrZones(e) : null) || hrZones(); // the zones as they were on the day, else today's
  const hasHr = e.chart.hr.some((x) => x > 0);
  $('sum-zones-hr-box').hidden = !hasHr;
  $('sum-zones-hr').innerHTML = hz ? bars(timeInZones(e.chart.hr, 1, hz, every, { skipZero: true })) : `<p class="muted">${tr('Set your threshold heart rate (LTHR) in Profile, or connect intervals.icu, to see heart rate zones.')}</p>`;
  $('sum-zones').hidden = !total;
}

/** The workout's intervals: target against what you rode, in the band or not. */
function renderIntervals(e) {
  const rows = e.intervals || [];
  $('sum-intervals').hidden = !rows.length;
  if (!rows.length) return;
  const inBand = rows.filter((r) => r.target && r.ok).length, withT = rows.filter((r) => r.target).length;
  $('sum-int-score').textContent = withT ? tr('{n} of {m} on target', { n: inBand, m: withT }) : '';
  $('sum-int-rows').innerHTML = rows.map((r, i) => {
    const tgt = r.ramp ? `${r.ramp[0]} → ${r.ramp[1]}` : r.lo !== null ? `${r.lo}–${r.hi}` : r.target || '—';
    const d = r.diff === null ? '' : `${r.diff >= 0 ? '+' : '−'}${Math.abs(r.diff)}`;
    const pct = r.target ? Math.round((r.power / r.target) * 100) : null;
    return `<tr class="${r.target ? (r.ok ? 'ok' : r.diff > 0 ? 'over' : 'under') : ''}"><td>${i + 1}</td><td>${fmtTime(r.dur)}</td><td>${tgt}</td><td><b>${r.power}</b></td><td class="dv">${d}${pct !== null ? ` <small>${pct}%</small>` : ''}</td><td>${r.hr || '—'}</td><td>${r.cad || '—'}</td></tr>`;
  }).join('');
}

/** Recent rides in the lobby (latest five) and the full list in the drawer. */
/** "5 s", "1 min", "20 min", "1 h" */
const durLabel = (d) => (d < 60 ? `${d} ${tr('s')}` : d < 3600 ? `${d / 60} ${U.min}` : `${d / 3600} ${tr('h')}`);

/**
 * "Your rides suggest FTP 226 W" with a button that sets it, in `el` (hidden when there is nothing to suggest);
 * after a ramp test (`e`), its own result even when lower; and W′ from your best 5 and 20 minutes.
 */
function renderFtpTip(el, e = null) {
  const rows = [];
  const b1 = e?.ramp && (e.bests?.[60] || e.summary?.best1min);
  if (b1 && rampFtp(b1) !== settings.ftp) {
    rows.push({ title: tr('Ramp test: your FTP is {w} W', { w: rampFtp(b1) }), why: `${tr('75 % of your best minute in a ramp test ({w} W)', { w: Math.round(b1) })} · ${tr('now {w} W', { w: settings.ftp })}`,
      button: tr('Set FTP to {w} W', { w: rampFtp(b1) }), set: () => { settings.ftp = rampFtp(b1); $('f-ftp').value = settings.ftp; return tr('FTP set to {w} W', { w: settings.ftp }); } });
  } else if (!e?.ramp) {
    const s = ftpSuggestion(curveEntries(), settings.ftp);
    if (s) {
      const from = s.ramp ? tr('75 % of your best minute in a ramp test ({w} W)', { w: s.w }) : tr('95 % of your best 20 minutes ({w} W, {date})', { w: s.w, date: new Date(s.date).toLocaleDateString(locale, { day: 'numeric', month: 'short' }) });
      rows.push({ title: tr('Your rides suggest FTP {w} W', { w: s.ftp }), why: `${from} · ${tr('now {w} W', { w: settings.ftp })}`,
        button: tr('Set FTP to {w} W', { w: s.ftp }), set: () => { settings.ftp = s.ftp; $('f-ftp').value = s.ftp; return tr('FTP set to {w} W', { w: s.ftp }); } });
    }
  }
  const wp = wPrimeSuggestion(curveEntries(), settings.wPrimeKj || DEFAULT_W_PRIME / 1000);
  if (wp) {
    rows.push({ title: tr('Your rides suggest W′ {kj} kJ', { kj: wp.kj }), why: `${tr('from your best 5 and 20 minutes ({a} W, {b} W)', { a: wp.p5, b: wp.p20 })} · ${tr('now {kj} kJ', { kj: settings.wPrimeKj || DEFAULT_W_PRIME / 1000 })}`,
      button: tr('Set W′ to {kj} kJ', { kj: wp.kj }), set: () => { settings.wPrimeKj = wp.kj; $('f-wprime').value = wp.kj; return tr('W′ set to {kj} kJ', { kj: wp.kj }); } });
  }
  el.hidden = !rows.length;
  el.innerHTML = rows.map((r, i) => `<div class="ftp-row"><div><b>${esc(r.title)}</b><small>${esc(r.why)}</small></div><button class="primary" data-i="${i}">${esc(r.button)}</button></div>`).join('');
  for (const b of el.querySelectorAll('button')) b.onclick = () => {
    const msg = rows[+b.dataset.i].set(); saveSettings(); toast(msg);
    renderFtpTip(el, e); renderPowerCurve();
  };
}

/** Power curve in History: best power for each duration, all time and the last 6 weeks. */
function renderPowerCurve() {
  const all = powerCurve(curveEntries()), recent = powerCurve(curveEntries(), { days: 42 });
  const box = $('power-curve-box');
  box.hidden = !Object.keys(all).length;
  if (box.hidden) return;
  renderFtpTip($('pc-ftp'));
  $('pc-table').innerHTML = DURS.filter((d) => all[d]).map((d) => `<div><label>${durLabel(d)}</label><b>${all[d].w}</b><small>${recent[d] ? `${recent[d].w} · 6 ${tr('wk')}` : '—'}</small></div>`).join('');
  requestAnimationFrame(() => {
    const c = $('pc-chart'), dpr = Math.min(window.devicePixelRatio || 1, 2), W = c.clientWidth, H = c.clientHeight;
    if (!W) return;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ds = DURS.filter((d) => all[d]), max = Math.max(...ds.map((d) => all[d].w)) * 1.08, padL = 34, padB = 18;
    const x = (d) => padL + (Math.log(d / 5) / Math.log(3600 / 5)) * (W - padL - 8), y = (w) => (H - padB) - (w / max) * (H - padB - 6);
    g.font = '11px system-ui'; g.fillStyle = 'rgba(255,255,255,.45)'; g.strokeStyle = 'rgba(255,255,255,.08)';
    for (const d of [5, 60, 300, 1200, 3600]) { g.beginPath(); g.moveTo(x(d), 4); g.lineTo(x(d), H - padB); g.stroke(); g.fillText(durLabel(d), x(d) - 10, H - 4); }
    for (const w of [Math.round(max / 3), Math.round(max * 2 / 3)]) { g.fillText(w, 2, y(w) + 4); g.beginPath(); g.moveTo(padL, y(w)); g.lineTo(W - 8, y(w)); g.stroke(); }
    g.setLineDash([4, 4]); g.strokeStyle = 'rgba(255,255,255,.3)'; g.beginPath(); g.moveTo(padL, y(settings.ftp)); g.lineTo(W - 8, y(settings.ftp)); g.stroke(); g.setLineDash([]);
    g.fillText(`FTP ${settings.ftp}`, W - 62, y(settings.ftp) - 4);
    const line = (curve, color, width) => {
      const pts = ds.filter((d) => curve[d]);
      if (!pts.length) return;
      g.beginPath(); pts.forEach((d, i) => (i ? g.lineTo(x(d), y(curve[d].w)) : g.moveTo(x(d), y(curve[d].w))));
      g.strokeStyle = color; g.lineWidth = width; g.stroke();
      for (const d of pts) { g.beginPath(); g.arc(x(d), y(curve[d].w), 2.5, 0, Math.PI * 2); g.fillStyle = color; g.fill(); }
    };
    line(all, 'rgba(255,194,26,.95)', 2.5);
    line(recent, 'rgba(56,214,232,.9)', 1.6);
  });
}

/** Fitness, fatigue and form over the last 90 days (#54). */
function renderFitness() {
  // intervals.icu's own when connected (it has every ride, Zwift's and these too), otherwise from the rides here
  const icu = settings.icuKey && icuStats?.fitness?.length > 1 ? icuStats.fitness : null;
  const s = icu ? icu.map((p, i) => ({ date: p.date, ctl: p.ctl, atl: p.atl, form: i ? icu[i - 1].ctl - icu[i - 1].atl : p.ctl - p.atl })) : fitnessSeries(history, { days: 90 });
  $('fit-src').hidden = !icu;
  const box = $('fitness-box');
  box.hidden = s.length < 2;
  if (box.hidden) return;
  const now = s[s.length - 1], band = formBand(now.form);
  const BAND = { transition: tr('very fresh: losing fitness'), fresh: tr('fresh: ready to race'), neutral: tr('neutral'), optimal: tr('productive load'), overload: tr('overreaching: rest') };
  $('fit-nums').innerHTML = `<div><label>${tr('Fitness')}</label><b class="c-fit">${Math.round(now.ctl)}</b></div><div><label>${tr('Fatigue')}</label><b class="c-fat">${Math.round(now.atl)}</b></div><div><label>${tr('Form')}</label><b class="c-form">${now.form >= 0 ? '+' : ''}${Math.round(now.form)}</b><small>${esc(BAND[band])}</small></div>`;
  requestAnimationFrame(() => {
    const c = $('fit-chart'), dpr = Math.min(window.devicePixelRatio || 1, 2), W = c.clientWidth, H = c.clientHeight;
    if (!W) return;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const top = Math.max(10, ...s.map((p) => Math.max(p.ctl, p.atl))) * 1.1, lo = Math.min(0, ...s.map((p) => p.form)) * 1.1;
    const span = top - lo, x = (i) => (i / (s.length - 1)) * W, y = (v) => H - 14 - ((v - lo) / span) * (H - 20);
    // form as bars round zero: green fresh, grey neutral, orange productive, red overreaching
    const bw = Math.max(1, W / s.length - 1);
    s.forEach((p, i) => {
      const b = formBand(p.form);
      g.fillStyle = { transition: '#94a3b8', fresh: '#22c55e', neutral: '#64748b', optimal: '#f59e0b', overload: '#ef4444' }[b];
      g.globalAlpha = 0.55;
      g.fillRect(x(i) - bw / 2, Math.min(y(0), y(p.form)), bw, Math.abs(y(p.form) - y(0)));
    });
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(255,255,255,.15)'; g.beginPath(); g.moveTo(0, y(0)); g.lineTo(W, y(0)); g.stroke();
    const line = (k, color, w) => { g.beginPath(); s.forEach((p, i) => (i ? g.lineTo(x(i), y(p[k])) : g.moveTo(x(i), y(p[k])))); g.strokeStyle = color; g.lineWidth = w; g.stroke(); };
    line('atl', '#f472b6', 1.5);
    line('ctl', '#38bdf8', 2.5);
    g.fillStyle = 'rgba(255,255,255,.45)'; g.font = '11px system-ui';
    const fmt = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
    g.fillText(fmt(s[0].date), 2, H - 2);
    g.fillText(fmt(now.date), W - 44, H - 2);
  });
}

function renderHistory() {
  renderWhy();
  renderProgress();
  renderChallenge();
  renderPowerCurve();
  renderFitness();
  const row = (e) => {
    const s = e.summary || {};
    const day = new Date(e.date).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
    return `<button class="hist-row" data-id="${e.id}"><span class="hist-date">${day}</span><span class="hist-name"><b>${esc(e.routeName || '')}</b><small>${e.race ? `🏁 ${tr('Race')}${e.race.findIndex((x) => x.me) >= 0 ? ` · ${e.race.findIndex((x) => x.me) + 1}/${e.race.length}` : ''}` : esc(e.workoutName || tr('Free ride'))}</small></span><span class="hist-nums"><b>${fmtTime(s.duration || 0)}</b><small>${((s.distance || 0) / 1000).toFixed(1)} ${U.km}</small></span><span class="hist-nums"><b>${s.normalizedPower || s.avgPower || 0} ${U.W}</b><small>TSS ${e.tss || 0}</small></span></button>`;
  };
  // the lobby has no list of rides: they are in History
  renderWeek();
  $('history-all').innerHTML = history.length ? history.map(row).join('') : `<p class="muted">${tr('No rides yet. Finished rides show up here.')}</p>`;
  // (the week's numbers are on the lobby's tiles)
  for (const b of document.querySelectorAll('.hist-row')) {
    b.onclick = () => { $('drawer').hidden = true; const e = history.find((x) => x.id === b.dataset.id); if (e) showSummary(e); };
  }
}

/** The lobby's card for the rider: level and how far to the next, this week's rides, time, distance and TSS, form. */
function renderWeek() {
  const box = $('week-box');
  box.hidden = !history.length;
  if (box.hidden) return;
  const L = levelOf(progress.xp);
  const week = history.filter((e) => Date.now() - Date.parse(e.date) < 7 * 864e5);
  const sum = (k) => week.reduce((a, e) => a + (k(e) || 0), 0);
  const icu = settings.icuKey && icuStats?.fitness?.length > 1 ? icuStats.fitness : null;
  const f = icu ? { ctl: icu.at(-1).ctl, form: icu.at(-2).ctl - icu.at(-2).atl } : fitnessSeries(history, { days: 90 }).at(-1);
  const BAND = { transition: tr('very fresh: losing fitness'), fresh: tr('fresh: ready to race'), neutral: tr('neutral'), optimal: tr('productive load'), overload: tr('overreaching: rest') };
  const tile = (label, big, small, extra = '') => `<span class="wb-tile"><small class="wb-label">${label}</small><b>${big}</b><small>${small}</small>${extra}</span>`;
  box.innerHTML = [
    f ? tile(tr('Form'), `<span class="c-form">${f.form >= 0 ? '+' : ''}${Math.round(f.form)}</span>`, `${esc(BAND[formBand(f.form)])} · ${tr('Fitness')} ${Math.round(f.ctl)}`) : '',
    tile(tr('This week'), `${week.length} · ${fmtTime(sum((e) => e.summary?.duration))}`, `${Math.round(sum((e) => e.summary?.distance) / 1000)} ${U.km} · TSS ${sum((e) => e.tss)}`),
    tile(tr('Level {n}', { n: L.level }), `${L.xp} XP`, tr('{left} to level {n}', { left: L.to - L.xp, n: L.level + 1 }), `<span class="lvl-bar"><i style="width:${Math.round(L.frac * 100)}%"></i></span>`),
  ].join('');
  box.lastElementChild?.classList.add('wb-level');
}
// the tiles: the level opens Progress, the form and the week too (the form is there); History is only the rides
$('week-box').addEventListener('click', () => openDrawer('progress'));

/** Under «Time of day» with «By the sun»: when each look begins today here. */
function renderTimeHint() {
  const el = $('f-time-hint');
  el.hidden = settings.timeOfDay !== 'auto';
  if (el.hidden) return;
  const p = phasesOfDay(new Date(), placeFromZone());
  const hm = (d) => d ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '—';
  el.textContent = tr('Today here: morning {a} · day {b} · golden hour {c} · night {d}', { a: hm(p.morning), b: hm(p.midday), c: hm(p.evening), d: hm(p.night) });
}
// «By the sun»: mid-ride the look follows the sun as it moves (checked each minute, changed only when the look does)
setInterval(() => {
  if (!ride || settings.timeOfDay !== 'auto' || !scene) return;
  const look = phaseOf(sunAt(new Date(), placeFromZone()));
  if (ride.look && look !== ride.look) scene.setAtmosphere?.('auto', settings.weather);
  ride.look = look;
}, 60000);

/** The rail's profile button: your initial on your jersey's colour. */
function renderAvatar() {
  const named = settings.name?.trim() && settings.name.trim() !== DEFAULT_SETTINGS.name;
  const a = $('avatar');
  // your initial; before a name is set, a plain head-and-shoulders outline
  if (named) a.textContent = settings.name.trim()[0].toUpperCase();
  else a.innerHTML = '<svg viewBox="0 0 24 24" class="ic stroke"><circle cx="12" cy="9" r="3.6"/><path d="M5.5 19.5c1.2-3.3 3.6-5 6.5-5s5.3 1.7 6.5 5"/></svg>';
  a.style.background = settings.jersey;
  $('open-profile').title = named ? settings.name.trim() : tr('Profile');
}

/** «Good evening, Serhii» and the date over the lobby. */
function renderGreeting() {
  const h = new Date().getHours();
  const hello = h < 5 ? tr('Good night') : h < 12 ? tr('Good morning') : h < 18 ? tr('Good afternoon') : tr('Good evening');
  const named = settings.name?.trim() && settings.name.trim() !== DEFAULT_SETTINGS.name;
  $('greet').textContent = named ? `${hello}, ${settings.name.trim()}` : hello;
  $('greet-date').textContent = new Date().toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** The rail's dots: devices (green: ready to ride, amber: nothing to ride on) and intervals.icu (green: linked). */
function renderRailDots() {
  const dev = $('rail-dev-dot'), icu = $('rail-icu-dot');
  if (dev) { dev.className = `rail-dot ${trainer.connected ? 'ok' : $('sim')?.checked ? '' : 'need'}`; }
  if (icu) icu.className = `rail-dot ${icuClient ? 'ok' : ''}`;
}

/** Power (filled, smoothed over 10 s) and heart rate (line) over the whole ride. */
/**
 * The ride chart under the pointer (or a finger): a line at that moment and a card with the time, power, the
 * plan, heart rate, cadence and W′bal there (each value the 5 s it was kept as).
 */
function hoverSummaryChart(samples, every, wPrime) {
  const c = $('sum-chart'), line = $('sum-hover-line'), tip = $('sum-hover');
  const hide = () => { line.hidden = tip.hidden = true; };
  hide();
  c.onpointerleave = hide;
  const hasCad = samples.some((x) => x.cadence > 0); // a ride with cadence shows 0 in a pause, one without shows none
  c.onpointermove = (ev) => {
    if (!samples.length) return;
    const r = c.getBoundingClientRect(), x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
    const i = Math.round((x / r.width) * (samples.length - 1)), s = samples[i];
    const row = (dot, label, v) => (v !== '' ? `<span><i style="background:${dot}"></i>${label}<b>${v}</b></span>` : '');
    tip.innerHTML = `<b class="tip-time">${fmtTime(i * every)}${s.power > 0 ? '' : ` · ${tr('paused')}`}</b>`
      + row('#ffc21a', tr('Power'), `${Math.round(s.power || 0)} ${U.W}`)
      + row('#ffffff', tr('Plan'), s.target ? `${Math.round(s.target)} ${U.W}` : '')
      + row('#ff4d5e', tr('Heart rate'), s.heartRate ? `${Math.round(s.heartRate)} ${U.bpm}` : '')
      + row('#38d6e8', tr('Cadence'), hasCad ? `${Math.round(s.cadence || 0)} ${U.rpm}` : '')
      + row('#a78bfa', 'W′bal', s.wbal !== undefined && s.wbal < wPrime ? `${(s.wbal / 1000).toFixed(1)} ${tr('kJ')}` : '');
    line.hidden = tip.hidden = false;
    line.style.left = `${x}px`;
    // the card on the side away from the edge
    const right = x > r.width / 2;
    tip.style.left = right ? '' : `${x + 12}px`;
    tip.style.right = right ? `${r.width - x + 12}px` : '';
  };
}

function drawSummaryChart(canvas, samples, smoothN = 10, ftp = settings.ftp, wPrime = wPrimeJ()) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  if (!samples.length) return;
  // power and cadence keep their zeros (a pause drops to 0); heart rate skips them (a strap's dropout)
  const smooth = (k, n, zeros = false) => samples.map((_, i) => {
    let a = 0, c = 0;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) { const v = samples[j][k] || 0; if (zeros || v > 0) { a += v; c++; } }
    return c ? a / c : 0;
  });
  const pw = smooth('power', smoothN, true), hr = smooth('heartRate', Math.max(1, Math.round(smoothN / 2)));
  const pMax = Math.max(ftp * 1.3, ...pw), hMax = Math.max(190, ...hr);
  const x = (i) => (i / Math.max(1, samples.length - 1)) * w;
  // FTP reference line
  const yF = h - (ftp / pMax) * (h - 8);
  g.strokeStyle = 'rgba(255,255,255,.18)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(0, yF); g.lineTo(w, yF); g.stroke(); g.setLineDash([]);
  g.beginPath(); g.moveTo(0, h);
  pw.forEach((v, i) => g.lineTo(x(i), h - (v / pMax) * (h - 8)));
  g.lineTo(w, h); g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(255,194,26,.85)'); grad.addColorStop(1, 'rgba(255,194,26,.15)');
  g.fillStyle = grad; g.fill();
  // cadence: thin, on its own scale (0–150 rpm)
  const cad = smooth('cadence', Math.max(1, Math.round(smoothN / 2)), true);
  if (cad.some((v) => v > 0)) {
    g.strokeStyle = 'rgba(56,214,232,.55)'; g.lineWidth = 1; g.beginPath();
    let started = false;
    cad.forEach((v, i) => { const y = h - (v / 150) * (h - 8); started ? g.lineTo(x(i), y) : g.moveTo(x(i), y); started = true; });
    g.stroke();
  }
  // the plan: the workout's target as a white step line
  if (samples.some((s) => s.target > 0)) {
    g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 1.5; g.beginPath();
    let started = false;
    let py = 0;
    samples.forEach((s, i) => { if (!(s.target > 0)) { started = false; return; } const y = h - (s.target / pMax) * (h - 8); if (started) { g.lineTo(x(i), py); g.lineTo(x(i), y); } else g.moveTo(x(i), y); py = y; started = true; });
    g.stroke();
  }
  if (hr.some((v) => v > 0)) {
    g.strokeStyle = '#ff4d5e'; g.lineWidth = 2; g.beginPath();
    let started = false;
    hr.forEach((v, i) => { if (!v) return; const y = h - (v / hMax) * (h - 8); started ? g.lineTo(x(i), y) : g.moveTo(x(i), y); started = true; });
    g.stroke();
  }
  // pauses: faint bands where there was no power at all
  g.fillStyle = 'rgba(148,163,184,.12)';
  samples.forEach((s, i) => { if (!(s.power > 0)) g.fillRect(x(i) - w / samples.length / 2, 0, Math.max(1, w / samples.length), h); });
  // W′bal: violet, from full at the top to empty at the bottom
  if (samples.some((s) => s.wbal < wPrime)) {
    g.strokeStyle = '#a78bfa'; g.lineWidth = 2; g.beginPath();
    samples.forEach((s, i) => { const y = 4 + (1 - (s.wbal ?? wPrime) / wPrime) * (h - 8); i ? g.lineTo(x(i), y) : g.moveTo(x(i), y); });
    g.stroke();
  }
  // the FTP line again on top of the fill, with its value
  g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 1; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(0, yF); g.lineTo(w, yF); g.stroke(); g.setLineDash([]);
  ftpTag(g, 6, yF, ftp);
}

// ---------- A ride card to share (#52) ----------
/** Draws the ride on a 1080×1350 canvas: title, route shape, big numbers, the power trace, records. */
async function drawRideCard(e, c, format = 'story') {
  // story: 9:16 with Instagram's top bar and reply field left clear; post: 4:5 for a feed
  const story = format === 'story';
  c.width = 1080; c.height = story ? 1920 : 1350;
  const g = c.getContext('2d'), W = c.width, H = c.height, P = 72;
  const sum = e.summary || {}, route = routes.find((r) => r.id === e.routeId);
  const accent = '#ff7a1a';
  // background: deep blue with a warm glow
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0d1626'); bg.addColorStop(1, '#1a1f33');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W * 0.85, H * 0.12, 20, W * 0.85, H * 0.12, 800);
  glow.addColorStop(0, 'rgba(255,122,26,.28)'); glow.addColorStop(1, 'rgba(255,122,26,0)');
  g.fillStyle = glow; g.fillRect(0, 0, W, H);
  const font = (w, s) => `${w} ${s}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const maxW = W - P * 2;
  /** Words of text in lines no wider than maxW, at most n; the last one ends in … when cut. */
  const wrap = (text, n) => {
    const lines = [];
    let line = '';
    for (const w of String(text).split(/\s+/)) {
      const t = line ? `${line} ${w}` : w;
      if (g.measureText(t).width <= maxW || !line) line = t; else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    if (lines.length > n) { lines.length = n; lines[n - 1] += '…'; }
    return lines.map((l) => { while (g.measureText(l).width > maxW && l.length > 2) l = `${l.slice(0, -2)}…`; return l; });
  };
  let y = story ? 250 : P; // the top of the content
  // brand, and the date under it (on the left: Instagram's buttons sit at the top right)
  try {
    const img = new Image(); img.src = 'logo.svg'; await img.decode();
    g.drawImage(img, P, y - 6, 64, 56);
  } catch { /* no logo */ }
  g.fillStyle = '#fff'; g.font = font(800, 44); g.fillText('Gruppetto', P + 92, y + 38);
  g.fillStyle = 'rgba(255,255,255,.55)'; g.font = font(500, 30);
  g.fillText(new Date(e.date).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' }), P, y + 100);
  y += 100;
  // title: route and what it was, the size fitted to the width and the rest wrapped, never cut at the edge
  const kind = e.race ? `🏁 ${tr('Race')}${e.race.findIndex((x) => x.me) >= 0 ? ` · ${tr('{n} of {m}', { n: e.race.findIndex((x) => x.me) + 1, m: e.race.length })}` : ''}` : e.workoutName || tr('Free ride');
  let size = 84;
  g.font = font(800, size);
  while (size > 56 && g.measureText(e.routeName || '').width > maxW) g.font = font(800, (size -= 4));
  g.fillStyle = '#fff';
  for (const l of wrap(e.routeName || '', 2)) { y += size * 1.15; g.fillText(l, P, y); }
  g.fillStyle = accent; g.font = font(700, 40);
  y += 12;
  for (const l of wrap(kind, 2)) { y += 52; g.fillText(l, P, y); }
  // the numbers, the trace and the records from the bottom up; the route's shape fills what is between
  const bottom = story ? H - 330 : H - 50;
  const statsY = bottom - 520;
  if (route) {
    const { pts } = routeShape(route);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, yy] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, yy); x1 = Math.max(x1, x); y1 = Math.max(y1, yy); }
    const bx = P, by = y + 50, bw = maxW, bh = Math.max(200, statsY - 90 - by), k = Math.min(bw / Math.max(1, x1 - x0), bh / Math.max(1, y1 - y0)) * 0.9;
    const ox = bx + (bw - (x1 - x0) * k) / 2 - x0 * k, oy = by + (bh - (y1 - y0) * k) / 2 - y0 * k;
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const [w, col] of [[22, 'rgba(255,122,26,.18)'], [8, accent]]) {
      g.beginPath(); pts.forEach(([x, yy], i) => (i ? g.lineTo(ox + x * k, oy + yy * k) : g.moveTo(ox + x * k, oy + yy * k)));
      g.strokeStyle = col; g.lineWidth = w; g.stroke();
    }
    g.fillStyle = '#fff'; g.beginPath(); g.arc(ox + pts[0][0] * k, oy + pts[0][1] * k, 12, 0, Math.PI * 2); g.fill();
  }
  const stats = [
    [tr('Time'), fmtTime(sum.duration || 0)],
    [tr('Distance'), `${((sum.distance || 0) / 1000).toFixed(1)} ${U.km}`],
    [tr('Avg power'), `${sum.avgPower || 0} ${U.W}`],
    ['NP', `${sum.normalizedPower || sum.avgPower || 0} ${U.W}`],
    [tr('Elevation gain'), `${Math.round(sum.elevationGain || 0)} ${U.m}`],
    ['TSS', `${e.tss || 0}`],
  ];
  const cw = maxW / 3;
  stats.forEach(([label, v], i) => {
    const x = P + (i % 3) * cw, sy = statsY + Math.floor(i / 3) * 150;
    g.fillStyle = 'rgba(255,255,255,.55)'; g.font = font(600, 26); g.fillText(label.toUpperCase(), x, sy, cw - 16);
    g.fillStyle = '#fff'; g.font = font(800, 62); g.fillText(v, x, sy + 66, cw - 16);
  });
  // power trace, coloured by zone
  const pw = e.chart?.pw || [], ftp = e.ftp || settings.ftp;
  if (pw.length) {
    const ty = bottom - 190, th = 110, n = Math.min(pw.length, 270), per = pw.length / n, bwid = maxW / n;
    const max = Math.max(ftp * 1.5, ...pw);
    for (let i = 0; i < n; i++) {
      let s2 = 0, c2 = 0;
      for (let j = Math.floor(i * per); j < Math.floor((i + 1) * per); j++) { s2 += pw[j] || 0; c2++; }
      const p = c2 ? s2 / c2 : 0, h = (p / max) * th;
      g.fillStyle = zoneColor(p / ftp);
      g.fillRect(P + i * bwid, ty + th - h, Math.max(1, bwid - 1), h);
    }
  }
  // records, or the address
  const before = powerCurve(history.filter((x) => x !== e && Date.parse(x.date) < Date.parse(e.date)));
  const recs = Object.entries(e.bests || {}).filter(([d, w]) => before[d] && w > before[d].w).slice(0, 3);
  g.font = font(700, 28);
  let rx = P;
  for (const [d, w] of recs) {
    const t = `🏆 ${durLabel(+d)} ${w} ${U.W}`, tw = g.measureText(t).width + 36;
    g.fillStyle = 'rgba(255,122,26,.18)'; g.strokeStyle = accent; g.lineWidth = 2;
    g.beginPath(); g.roundRect(rx, bottom - 42, tw, 44, 22); g.fill(); g.stroke();
    g.fillStyle = '#fff'; g.fillText(t, rx + 18, bottom - 10);
    rx += tw + 12;
  }
  if (!recs.length) { g.fillStyle = 'rgba(255,255,255,.4)'; g.font = font(500, 26); g.fillText('automation-remarks.com/gruppetto', P, bottom - 10); }
}
async function openRideCard() {
  const e = shown.entry;
  if (!e) return;
  const c = $('card-canvas');
  let format = 'story';
  try { format = localStorage.getItem('gruppetto-card-format') || 'story'; } catch { /* private mode */ }
  for (const b of document.querySelectorAll('[data-card-format]')) {
    b.classList.toggle('sel', b.dataset.cardFormat === format);
    b.onclick = () => { try { localStorage.setItem('gruppetto-card-format', b.dataset.cardFormat); } catch { /* private mode */ } openRideCard(); };
  }
  await drawRideCard(e, c, format);
  $('card-view').hidden = false;
  const blob = () => new Promise((res) => c.toBlob(res, 'image/png'));
  const name = `gruppetto-${(e.date || '').slice(0, 10)}.png`;
  $('card-download').onclick = async () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await blob()); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const b = await blob(), file = new File([b], name, { type: 'image/png' });
  const canShare = !!navigator.canShare?.({ files: [file] });
  $('card-share').hidden = !canShare;
  $('card-share').onclick = () => { track('card-share', format); navigator.share({ files: [file], title: 'Gruppetto' }).catch(() => {}); };
}
$('btn-card').onclick = openRideCard;
$('card-view').addEventListener('click', (ev) => { if (ev.target.closest('[data-card-close]')) $('card-view').hidden = true; });

/** A ride's file name: gruppetto-2026-11-08-1432 (your local start time). */
function rideFileName(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `gruppetto-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function download(kind) {
  const rec = shown.rec || recorder;
  const d = rec.startTime || new Date();
  const fit = kind === 'fit';
  const blob = fit ? new Blob([rec.toFIT()], { type: 'application/vnd.ant.fit' }) : new Blob([rec.toTCX()], { type: 'application/vnd.garmin.tcx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${rideFileName(d)}.${fit ? 'fit' : 'tcx'}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- intervals.icu ----------
let icuClient = null;
let icuWorkouts = [];
let lastRide = null;

function initIntervals() {
  $('f-icu-key').value = settings.icuKey;
  $('f-icu-athlete').value = settings.icuAthlete;
  $('f-icu-upload').checked = settings.icuUpload;
  $('f-icu-upload').onchange = () => { settings.icuUpload = $('f-icu-upload').checked; saveSettings(); };
  $('btn-icu').onclick = () => connectIntervals();
  $('btn-icu-forget').onclick = forgetIntervals;
  $('btn-icu-upload').onclick = uploadToIntervals;
  if (settings.icuKey) connectIntervals({ quiet: true });
}

async function connectIntervals({ quiet = false } = {}) {
  const key = $('f-icu-key').value.trim();
  if (!key) { $('icu-status').textContent = tr('Paste your intervals.icu API key.'); return; }
  const client = new IntervalsClient({ apiKey: key, athleteId: $('f-icu-athlete').value });
  $('btn-icu').disabled = true;
  $('icu-status').textContent = tr('Connecting…');
  try {
    const athlete = await client.athlete();
    const today = new Date();
    const week = new Date(today.getTime() + 6 * 86400000);
    icuWorkouts = await client.plannedWorkouts(localDate(today), localDate(week));
    // a workout already ridden today (here, in Zwift, on a Garmin: any activity paired with it) is not offered again
    const done = await client.doneEventIds(localDate(today), localDate(today)).catch(() => new Set());
    const stats = icuWorkouts.stats;
    icuWorkouts = icuWorkouts.filter((w) => !done.has(String(w.eventId)));
    icuWorkouts.stats = stats;
    icuClient = client;
    settings.icuKey = key;
    settings.icuAthlete = $('f-icu-athlete').value.trim();
    if (athlete.ftp) { settings.ftp = athlete.ftp; $('f-ftp').value = athlete.ftp; }
    if (athlete.weight) { settings.weight = Math.round(athlete.weight); $('f-weight').value = settings.weight; }
    // heart rate zones and max HR as set in intervals.icu
    if (athlete.hrZones) { settings.hrZones = athlete.hrZones; settings.hrZoneNames = athlete.hrZoneNames; }
    const maxHr = athlete.maxHr || athlete.hrZones?.at(-1);
    if (maxHr) settings.maxHr = maxHr;
    if (athlete.lthr) { settings.lthr = athlete.lthr; $('f-lthr').value = athlete.lthr; }
    if (athlete.wPrime) { settings.wPrimeKj = Math.round(athlete.wPrime / 100) / 10; $('f-wprime').value = settings.wPrimeKj; }
    if (!quiet && icuWorkouts.length) settings.mode = icuWorkouts[0].id;
    saveSettings();
    if (!quiet) track('icu-connect');
    renderRailDots();
    loadIcuHistory(client); // your power curve and form there, Zwift's rides included: not waited for
    const n = icuWorkouts.length, st = icuWorkouts.stats || {};
    const notes = [];
    if (st.otherSport) notes.push(tr('other sports skipped: {n}', { n: st.otherSport }));
    if (st.unstructured) notes.push(tr('without intervals (free ride): {n}', { n: st.unstructured }));
    const found = n ? tr('cycling workouts in the next 7 days: {n} — listed first in “Workouts”', { n }) : tr('no cycling workouts in your calendar for the next 7 days');
    $('icu-status').textContent = `${athlete.name ? `${athlete.name} · ` : ''}FTP ${settings.ftp} ${U.W} · ${found}${notes.length ? ` (${notes.join(', ')})` : ''}`;
    $('btn-icu').textContent = tr('Refresh');
    $('btn-icu-forget').hidden = false;
    renderModes();
  } catch (e) {
    icuClient = null;
    $('icu-status').textContent = e.message;
  } finally {
    $('btn-icu').disabled = false;
  }
}

// ---------- Your history in intervals.icu (Zwift's rides there too) ----------
// The power curve and the form come from intervals.icu when it is connected: someone coming from Zwift has
// their records and fitness from the first day, not from zero. Kept on this device for when it is offline.
const ICU_STATS_KEY = 'gruppetto-icu-stats';
let icuStats = (() => { try { return JSON.parse(localStorage.getItem(ICU_STATS_KEY) || 'null'); } catch { return null; } })();
async function loadIcuHistory(client) {
  const today = new Date();
  const [curves, fitness] = await Promise.all([
    client.powerCurves(DURS).catch(() => null),
    client.fitness(localDate(new Date(today.getTime() - 90 * 864e5)), localDate(today)).catch(() => null),
  ]);
  if (!curves && !fitness) return;
  icuStats = { at: Date.now(), curves: curves || icuStats?.curves || null, fitness: fitness?.length ? fitness : icuStats?.fitness || null };
  try { localStorage.setItem(ICU_STATS_KEY, JSON.stringify(icuStats)); } catch { /* private mode */ }
  renderPowerCurve(); renderFitness();
}
/**
 * Your rides with intervals.icu's curve as two more «rides»: its all-time bests dated long ago (so they count
 * for all time only) and its last 42 days dated today; for the power curve and the FTP and W′ suggestions.
 */
function curveEntries() {
  const c = icuStats?.curves;
  if (!c || !settings.icuKey) return history;
  return [...history,
    ...(Object.keys(c.all || {}).length ? [{ id: 'icu-all', date: '2000-01-01T00:00:00Z', bests: c.all, icu: true }] : []),
    ...(Object.keys(c.recent || {}).length ? [{ id: 'icu-42d', date: new Date(icuStats.at).toISOString(), bests: c.recent, icu: true }] : [])];
}

function forgetIntervals() {
  icuClient = null;
  icuWorkouts = [];
  settings.icuKey = '';
  settings.icuAthlete = '';
  icuStats = null;
  try { localStorage.removeItem(ICU_STATS_KEY); } catch { /* private mode */ }
  renderRailDots();
  if (settings.mode.startsWith('icu:')) settings.mode = 'free';
  saveSettings();
  $('f-icu-key').value = '';
  $('f-icu-athlete').value = '';
  $('icu-status').textContent = tr('Key removed from this browser.');
  $('btn-icu').textContent = tr('Connect');
  $('btn-icu-forget').hidden = true;
  renderModes();
}

/**
 * The finish screen's "Upload to intervals.icu" switch (remembered for next time): when on, the ride
 * goes up after a 10 s countdown, or at once on leaving the screen; switched off, nothing is sent.
 */
let uploadTimer = null;
function scheduleUpload(can) {
  clearInterval(uploadTimer); uploadTimer = null;
  const box = $('sum-icu-auto'), count = $('sum-icu-count');
  $('sum-icu').hidden = !can;
  count.textContent = '';
  if (!can) return;
  box.checked = !!settings.icuUpload;
  let left = 10;
  const tick = () => {
    if (left <= 0) { clearInterval(uploadTimer); uploadTimer = null; count.textContent = ''; uploadToIntervals(); return; }
    count.textContent = tr('in {s} s', { s: left }); left--;
  };
  const start = () => { if (shown.entry?.uploadedId || lastRide?.uploadedId || uploadTimer) return; left = 10; uploadTimer = setInterval(tick, 1000); tick(); };
  box.onchange = () => {
    settings.icuUpload = box.checked; saveSettings(); $('f-icu-upload').checked = box.checked;
    if (box.checked) start(); else { clearInterval(uploadTimer); uploadTimer = null; count.textContent = ''; }
  };
  if (box.checked) start();
}
/** Leaving the finish screen: a pending upload goes now. */
function flushUpload() {
  if (!uploadTimer) return;
  clearInterval(uploadTimer); uploadTimer = null;
  uploadToIntervals();
}

async function uploadToIntervals() {
  clearInterval(uploadTimer); uploadTimer = null; $('sum-icu-count').textContent = '';
  const e = shown.entry, rec = shown.rec;
  if (!icuClient || !e?.summary || !rec || e.uploadedId) return;
  const status = $('icu-upload-status');
  const btn = $('btn-icu-upload');
  status.hidden = false;
  status.textContent = tr('Uploading to intervals.icu…');
  btn.disabled = true;
  const sum = e.summary;
  const fromIcu = !!e.eventId;
  const name = `Gruppetto: ${e.workoutName || e.routeName}`;
  const description = `${e.routeName} · ${(sum.distance / 1000).toFixed(1)} km · avg ${sum.avgPower} W · NP ${sum.normalizedPower || '—'} W`;
  try {
    const id = await icuClient.uploadActivity(rec.toFIT(), {
      name, description, eventId: fromIcu ? e.eventId : undefined, filename: `${rideFileName(rec.startTime || new Date())}.fit`,
    });
    e.uploadedId = id || true;
    if (lastRide && rec === recorder) lastRide.uploadedId = e.uploadedId;
    if (history.includes(e)) saveHistory();
    status.innerHTML = id
      ? `${tr('Uploaded to intervals.icu ✓')}${fromIcu ? ` · ${tr('marked as completed')}` : ''} · <a href="${activityUrl(id)}" target="_blank" rel="noopener">${tr('open ride')}</a>`
      : tr('Uploaded to intervals.icu ✓');
    btn.hidden = true;
    $('sum-icu').hidden = true;
  } catch (e) {
    status.textContent = tr('Upload failed: {error}', { error: e.message });
    btn.disabled = false;
    btn.textContent = tr('Try again');
  }
}

function dayLabel(date) {
  const today = localDate();
  const tomorrow = localDate(new Date(Date.now() + 86400000));
  if (date === today) return 'today';
  if (date === tomorrow) return 'tomorrow';
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'numeric' });
}

// ---------- Screen wake lock ----------
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not supported or refused: the ride still works */ }
}
document.addEventListener('visibilitychange', () => {
  if (ride && document.visibilityState === 'visible') { advance(); keepAwake(true); }
});

// ---------- Helpers ----------
let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Wire up ----------
$('btn-pause').onclick = togglePause;
let finishArmed = null;
$('btn-finish').onclick = () => {
  const btn = $('btn-finish');
  if (finishArmed) { clearTimeout(finishArmed); finishArmed = null; btn.textContent = tr('Finish'); finishRide(); return; }
  btn.textContent = tr('Sure? Tap again');
  finishArmed = setTimeout(() => { finishArmed = null; btn.textContent = tr('Finish'); }, 3000);
};
$('btn-download').onclick = () => download('fit');
$('wk-int-down').onclick = () => changeIntensity(-5);
$('wk-int-up').onclick = () => changeIntensity(+5);
$('f-pacer').checked = settings.pacer === true;
$('f-pacer-name').value = settings.pacerName || '';
$('f-pacer-name').oninput = () => {
  settings.pacerName = $('f-pacer-name').value; saveSettings();
  if (ride?.pacer) ride.pacer.name = settings.pacerName.trim() || tr('Pacer');
};
$('btn-settings').onclick = () => openDrawer('profile');
$('rail-workouts').onclick = () => openWorkoutMenu();
for (const id of ['f-name', 'f-jersey']) $(id).addEventListener('input', () => { renderAvatar(); renderGreeting(); });
$('btn-challenge').onclick = () => challengeFriend(shown.entry);
$('btn-dev-lost').onclick = () => openDrawer('devices');
$('f-pacer').onchange = () => { settings.pacer = $('f-pacer').checked; saveSettings(); };
$('f-free-pacer').checked = !!settings.freePacer;
$('f-free-pacer').onchange = () => { settings.freePacer = $('f-free-pacer').checked; saveSettings(); updateSummary(); if (ride && !ride.workout && settings.freePacer) { ride.pacer.dist = ride.dist; ride.pacer.v = ride.v; } };
$('f-free-wkg').value = settings.freePacerWkg;
$('f-free-wkg').oninput = () => { const v = Number($('f-free-wkg').value); if (v >= 0.5 && v <= 7) { settings.freePacerWkg = v; saveSettings(); updateSummary(); } };
$('wk-pacer-btn').onclick = () => togglePacer();
$('wk-erg-btn').onclick = () => toggleErg();
/**
 * ERG on or off during a workout: on, the trainer holds the target power; off, it simulates the road
 * like a free ride (gears work again) while the targets stay on screen to ride to by feel.
 */
function toggleErg() {
  if (!ride) return;
  if (!ride.workout || ride.workoutDone) { toggleHold(); return; }
  ride.ergOff = !ride.ergOff;
  ride.lastSentTarget = null; ride.lastSentGrade = null; ride.lastSentWheel = null;
  ride.ergFactor = 1; ride.lowFor = 0;
  $('wk-erg-btn').classList.toggle('on', !ride.ergOff);
  if (ride.simulated && ride.ergOff && ride.target) { const sp = $('sim-power'); sp.value = ride.target; sp.oninput?.(); } // the slider takes over from the target
  updateGear();
  toast(ride.ergOff ? tr('ERG off: the trainer simulates the road, ride to the target by feel') : tr('ERG on: the trainer holds the target power'));
}
function togglePacer() {
  // in a workout the workout pacer, on a free ride the free-ride pacer
  const key = ride && !ride.workout ? 'freePacer' : 'pacer';
  settings[key] = !(key === 'pacer' ? settings.pacer === true : settings.freePacer);
  saveSettings();
  $('f-pacer').checked = settings.pacer === true;
  $('f-free-pacer').checked = !!settings.freePacer;
  $('wk-pacer-btn').classList.toggle('on', settings.pacer === true);
  const on = settings[key];
  if (ride?.pacer && on) { ride.pacer.dist = ride.dist; ride.pacer.v = ride.v; ride.pacer.waitAt = null; } // rejoin beside you
  const who = settings.pacerName?.trim() || tr('Pacer');
  toast(on ? tr('{name} is riding with you', { name: who }) : tr('{name} dropped back', { name: who }));
  updateSummary();
}

/** The pacer is out on the road: the workout pacer in a workout, the free-ride pacer otherwise. */
function pacerOn() {
  if (!ride?.pacer) return false;
  return ride.pacer.free ? !!settings.freePacer : settings.pacer === true;
}

/**
 * Free-ride pacer: at the foot of a climb, when you are more than 40 m back, he stops and waits
 * until you are there, so you go up together.
 */
function pacerRegroup(P, dt) {
  const R = ride.route, L = R.length;
  if (P.waitAt != null) {
    // you are coming: set off as you arrive, at your speed, so you go up side by side
    if (ride.dist >= P.waitAt - 2) { P.waitAt = null; P.v = Math.max(P.v, ride.v); return; }
    P.v = 0;
    return;
  }
  for (const c of R.climbs) {
    const foot = R.oneWay ? c.start : c.start + Math.ceil((P.dist - c.start) / L) * L; // the next foot ahead
    if (foot >= P.dist && foot <= P.dist + P.v * dt + 0.01 && ride.dist < foot - 40) {
      P.dist = foot; P.v = 0; P.waitAt = foot;
      toast(tr('{name} waits for you at the foot of {climb}', { name: P.name, climb: c.name }));
      return;
    }
  }
}
$('f-stats').checked = settings.stats !== false;
$('f-stats').onchange = () => {
  settings.stats = $('f-stats').checked; saveSettings();
  if (settings.stats) initStats(true); else stopStats();
};
$('f-sound').checked = !!settings.sound;
$('f-sound').onchange = () => {
  settings.sound = settings.voice = $('f-sound').checked;
  saveSettings();
  if (settings.sound) { unlockAudio(); beep(880, 0.1); }
};
$('btn-download-tcx').onclick = () => download('tcx');
$('btn-again').onclick = () => { flushUpload(); $('summary').hidden = true; $('lobby').hidden = false; renderHistory(); showRoute(); };
// The Gruppetto mark goes home: from the summary to the lobby (as «Ride again»), on the lobby it closes what is open
// over it and scrolls up. No reload: an upload in flight and the state stay.
for (const a of document.querySelectorAll('[data-home]')) a.addEventListener('click', (e) => {
  e.preventDefault();
  if (!$('summary').hidden) $('btn-again').onclick();
  for (const id of ['drawer', 'wk-menu', 'wk-detail', 'wk-builder']) if ($(id)) $(id).hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
$('btn-delete-ride').onclick = () => {
  const b = $('btn-delete-ride');
  if (b.textContent !== tr('Tap again to delete')) { b.textContent = tr('Tap again to delete'); return; }
  history = history.filter((e) => e.id !== b.dataset.id);
  deleteRide(b.dataset.id);
  saveHistory();
  renderHistory();
  $('summary').hidden = true; $('lobby').hidden = false;
};
$('sim-power').oninput = () => { $('sim-val').textContent = $('sim-power').value; };
// ---------- Virtual gears & controller actions ----------

const BUTTON_LABELS = {
  shiftUpL: 'left shift up (gear +)', shiftDownL: 'left shift down (gear −)', shiftUpR: 'right shift up (gear +)', shiftDownR: 'right shift down (gear −)',
  paddleL: 'left paddle (lane ◀)', paddleR: 'right paddle (lane ▶)',
  up: '▲', down: '▼', left: '◀ (easier: −5 % / −10 %)', right: '▶ (harder: +5 % / +10 %)', a: 'A (ERG / hold power)', b: 'B (pause)', y: 'Y (camera)', z: 'Z (skip interval / new lap)',
  powerUpL: 'Power-up left (pacer)', powerUpR: 'Power-up right (HUD)', onOffL: 'on/off left', onOffR: 'on/off right',
};

function onControllerButton(name) {
  lastButtonLabel = BUTTON_LABELS[name] || name;
  updateDeviceUI();
  const intent = rideIntent(name);
  if (intent) runIntent(intent);
}

function onObcButtons(changes) {
  const pressed = changes.filter((c) => c.value !== 0);
  if (pressed.length) {
    lastObcLabel = pressed.map((c) => OBC_LABELS[c.id] || `0x${c.id.toString(16).padStart(2, '0')}`).join(' / ');
    updateDeviceUI();
  }
  const intents = obcIntents(changes, obcState);
  for (const [intent, value] of intents) runIntent(intent, value);
  if (intents.has('harder') || intents.has('easier') || intents.has('gear')) obc.haptic(1);
}

/**
 * The big step (◀ / ▶ on the Zwift Ride): in a workout the intensity by 5 %, on a free ride the
 * climb difficulty by 10 %, which the trainer feels on the next grade it is sent.
 */
function bigStep(dir) {
  if (ride.workout && !ride.workoutDone) {
    changeIntensity(dir * 5);
    toast(`${tr('Intensity')} ${settings.intensity}%`);
    return;
  }
  if (inHold()) { setHold(ride.hold + dir * 20); toast(`ERG ${ride.hold} ${U.W}`); updateGear(); return; }
  settings.difficulty = Math.max(0, Math.min(100, settings.difficulty + dir * 10));
  saveSettings();
  $('f-diff').value = settings.difficulty;
  $('diff-val').textContent = `${settings.difficulty}%`;
  ride.lastSentGrade = null;
  toast(`${tr('Climb difficulty')} ${settings.difficulty}%`);
}

/**
 * Free ride: hold the power you are riding at (rounded to 5 W) in ERG, whatever the road does, or
 * let the trainer simulate the road again. The shifters then move the held power by 5 W, ◀ ▶ by 20 W.
 */
function toggleHold() {
  if (ride.hold) {
    ride.hold = null;
    ride.lastSentTarget = null; ride.lastSentGrade = null; ride.lastSentWheel = null;
    toast(tr('ERG off: the trainer simulates the road again'));
  } else {
    const h = ride.powerHist || [], now = h.length ? Math.round(h.reduce((x, y) => x + y, 0) / h.length / 5) * 5 : 0; // the 3 s power
    setHold(now >= 50 ? now : Math.round((settings.ftp * 0.6) / 5) * 5);
    toast(tr('ERG: holding {w} W', { w: ride.hold }));
  }
  updateGear();
}
function setHold(w) {
  ride.hold = Math.max(50, Math.min(1500, w));
  if (ride.simulated) { const s = $('sim-power'); s.value = ride.hold; s.oninput?.(); }
}

/** Free ride: a lap by hand (Z on the Zwift Ride, or N): a lap in the FIT/TCX file and a split in the summary. */
function manualLap() {
  const F = ride.splitFrom, samples = recorder.samples.slice(F.i);
  const t = ride.elapsed - F.t, d = ride.dist - F.d;
  if (t < 5) return;
  const avg = samples.length ? Math.round(samples.reduce((a, x) => a + (x.power || 0), 0) / samples.length) : 0;
  ride.splits.push({ time: t, dist: d, power: avg });
  recorder.markLap();
  ride.splitFrom = { t: ride.elapsed, d: ride.dist, i: recorder.samples.length };
  cueBeep(1040, 0.2);
  toast(tr('Split {n}: {time} · {km} km · {w} W', { n: ride.splits.length, time: fmtTime(t), km: (d / 1000).toFixed(2), w: avg }));
}

/** The camera views, in the order of keys 1–5. */
const CAMERAS = ['chase', 'eyes', 'iso', 'side', 'front'];
const CAMERA_NAMES = { chase: 'Camera: chase', eyes: 'Camera: rider\'s eyes', iso: 'Camera: isometric', side: 'Camera: over the shoulder', front: 'Camera: from the front' };
function setCameraView(mode) {
  if (!scene?.setCamera || !CAMERAS.includes(mode)) return;
  settings.camera = mode;
  saveSettings();
  scene?.setCamera?.(mode);
  $('f-camera').value = mode;
  toast(`${CAMERAS.indexOf(mode) + 1} · ${tr(CAMERA_NAMES[mode])}`);
}
/** The next camera view (C, or Y on the Zwift Ride). */
function nextCamera() {
  setCameraView(CAMERAS[(CAMERAS.indexOf(settings.camera) + 1) % CAMERAS.length]);
}

function runIntent(intent, value) {
  if (!ride) return;
  switch (intent) {
    case 'harder': shift(+1); break;
    case 'easier': shift(-1); break;
    case 'gear': setGear(value); break;
    case 'left': steer(-1); break;
    case 'right': steer(+1); break;
    case 'steer': ride.laneTarget = Math.max(-2.4, Math.min(2.4, (value / 25) * 2.4)); break;
    case 'togglePause': togglePause(); break;
    case 'pause': if (!ride.paused) togglePause(); break;
    case 'resume': if (ride.paused) togglePause(); break;
    case 'skip': skipInterval(); break;
    case 'toggleErg': toggleErg(); break;
    case 'camera': nextCamera(); break;
    case 'pacer': if (ride.pacer) togglePacer(); break;
    case 'bigEasier': bigStep(-1); break;
    case 'bigHarder': bigStep(+1); break;
    case 'hud': $('ride').classList.toggle('hud-hidden'); break;
    default: break;
  }
}

/** Sends the virtual gear as a wheel circumference; falls back to grade offsets if the trainer refuses. */
function sendVirtualGear() {
  if (ride.gear === ride.lastSentWheel || ride.wheelPending) return;
  const gear = ride.gear;
  ride.wheelPending = true;
  trainer.setWheelCircumference(virtualWheelMm(gear, settings.chainring, settings.cog || 14)).then((ok) => {
    if (!ride) return;
    ride.wheelPending = false;
    if (ok) { ride.lastSentWheel = gear; return; }
    ride.shiftMode = 'grade';
    ride.lastSentGrade = null;
    toast(tr('The trainer does not accept wheel circumference — using grade-based gears'));
  });
}

// ---------- ERG helpers ----------
const scaleW = (w) => (w === null || w === undefined ? null : Math.round((w * settings.intensity) / 100));

/** ERG target for a workout position: plan × intensity + manual bias; null for free-ride steps. */
function ergTarget(t) {
  const w = scaleW(t.watts);
  return w === null ? null : Math.max(0, w + (ride?.ergBias || 0));
}

/** Target actually sent to the trainer (reduced while the spiral guard is active). */
const effectiveTarget = () => (ride.target === null ? null : Math.round(ride.target * ride.ergFactor));

/**
 * "Spiral of death" guard: when cadence (or, without a cadence source, power) collapses in ERG,
 * halve the target so the legs can spin up again, then restore it over ~5 s.
 */
/**
 * The ramp test (#ftp-test): its best minute so far, and its end. Past the warm-up, 10 s in a row under 80 % of
 * the step (or under 50 rpm) is the failure the test rides to: the workout ends there, ERG lets go, and the
 * result is said aloud and shown.
 */
function rampWatch(power, cadence) {
  const w = (ride.rampWin ||= []);
  w.push(power); if (w.length > 60) w.shift();
  if (w.length === 60) ride.rampBest = Math.max(ride.rampBest || 0, w.reduce((a, b) => a + b, 0) / 60);
  const warm = ride.workout.steps[0].dur;
  if (ride.workoutT < warm + 60 || !ride.target) { ride.rampLow = 0; return; }
  const failing = power < ride.target * 0.8 || (cadence > 0 && cadence < 50);
  ride.rampLow = failing ? (ride.rampLow || 0) + 1 : 0;
  if (ride.rampLow < 10) return;
  ride.workoutDone = true;
  ride.target = null;
  recorder.markLap();
  const ftp = ride.rampBest ? rampFtp(ride.rampBest) : null;
  track('ramp-done');
  cueBeep(1040, 0.5);
  cueSay(ftp ? `Test over. Your F T P is about ${ftp} watts. Spin easy now.` : 'Test over. Spin easy now.');
  toast(ftp ? tr('Ramp test over: FTP ≈ {w} W. Spin easy to cool down, then finish', { w: ftp }) : tr('Ramp test over. Spin easy to cool down'));
  updateGear();
  if (ride.simulated) $('sim-power').value = Math.round(settings.ftp * 0.5);
}

function updateSpiralGuard(power, cadence) {
  if (!inErgStep() || ride.simulated) { ride.ergFactor = 1; ride.lowFor = 0; return; }
  const eff = effectiveTarget();
  const hasCadence = live.cadAt > 0 && performance.now() - live.cadAt < 5000; // a cadence source is actually reporting
  const low = hasCadence ? cadence < 55 : eff > 60 && power < eff * 0.6;
  ride.lowFor = low ? ride.lowFor + 1 : 0;
  if (ride.lowFor >= 3 && ride.ergFactor > 0.5) {
    ride.ergFactor = 0.5;
    toast(hasCadence ? tr('Low cadence — ERG temporarily reduced') : tr('Power dropped — ERG temporarily reduced'));
    cueSay(tr('Spin up your cadence'));
  } else if (ride.ergFactor < 1) {
    // restore only once the rider has clearly recovered (hysteresis avoids bouncing)
    const recovered = hasCadence ? cadence >= 70 : power >= eff * 0.85;
    if (recovered) ride.ergFactor = Math.min(1, Math.round((ride.ergFactor + 0.1) * 10) / 10);
  }
}

function describeStep(step, watts) {
  const what = watts === null || watts === undefined ? tr('free ride') : tr('{n} watts', { n: watts });
  const cad = step.cad ? `, ${tr('cadence {a} to {b}', { a: step.cad[0], b: step.cad[1] })}` : '';
  return `${what}, ${spokenDuration(step.dur)}${cad}${step.text ? `. ${step.text}` : ''}`;
}

const cueBeep = (f, d) => { if (settings.sound) beep(f, d); };
const cueSay = (text) => { if (settings.voice) say(text); };

function changeIntensity(delta) {
  settings.intensity = Math.max(50, Math.min(150, settings.intensity + delta));
  saveSettings();
  if (ride?.workout && !ride.workoutDone) {
    const t = targetAt(ride.workout, Math.max(0, ride.workoutT - 1), settings.ftp);
    if (t) ride.target = ergTarget(t);
  }
  $('wk-int').textContent = `${settings.intensity}%`;
  if (ride?.workout) drawWorkoutChart($('wk-chart'), ride.workout, ride.workoutT);
  updateGear();
}

const inErgStep = () => !!(ride?.workout && !ride.workoutDone && ride.target !== null && !ride.ergOff);
/** Free ride with the power held in ERG (A on the Zwift Ride, or E). */
const inHold = () => !!(ride?.hold && !(ride.workout && !ride.workoutDone));

function setGear(gear) {
  if (!ride || inErgStep() || inHold()) return;
  const g = Math.max(1, Math.min(GEARS, Math.round(gear)));
  if (g !== ride.gear) shift(g - ride.gear);
}

function shift(dir) {
  if (!ride || ride.paused) return;
  if (inErgStep()) {
    // in ERG the shifters move the workout's intensity, 1 % a click (the on-screen − / + do 5 %)
    changeIntensity(Math.sign(dir));
    toast(`${tr('Intensity')} ${settings.intensity}% · ${effectiveTarget()} ${U.W}`);
  } else if (inHold()) {
    setHold(ride.hold + Math.sign(dir) * 5);
    toast(`ERG ${ride.hold} ${U.W}`);
    updateGear();
  } else {
    const next = Math.max(1, Math.min(GEARS, ride.gear + dir));
    if (next === ride.gear) return;
    ride.gear = next;
    ride.lastSentGrade = null; // send the new resistance on the next tick
    if (ride.simulated) {
      const s = $('sim-power');
      s.value = Number(s.value) + dir * 5;
      s.oninput();
    }
  }
  updateGear();
}

function steer(dir) {
  if (!ride) return;
  ride.laneTarget = Math.max(-2.4, Math.min(2.4, ride.laneTarget + dir * 1.2));
  ride.laneHome = ride.laneTarget; ride.steeredAt = ride.elapsed; ride.autoLane = false;
}

function skipInterval() {
  if (!ride) return;
  if (!ride.workout || ride.workoutDone) { manualLap(); return; }
  const t = targetAt(ride.workout, Math.max(0, ride.workoutT - 1), settings.ftp);
  if (!t) return;
  ride.workoutT = Math.max(0, ride.workoutT - 1) + t.remaining;
  toast(tr('Interval skipped ⏭'));
}

function updateGear() {
  if (!ride) return;
  const inErg = inErgStep(), hold = inHold();
  $('m-gear-label').textContent = inErg || hold ? 'ERG' : tr('Gear');
  $('m-gear').textContent = hold ? ride.hold : inErg ? settings.intensity : ride.gear; // what the shifters move
  $('m-gear-unit').textContent = hold ? U.W : inErg ? '%' : `/${GEARS} · ${ratioOf(ride.gear).toFixed(2)}`;
}

// Pause / Finish and the simulator slider stay hidden while riding: they show when the mouse moves (for a few seconds, or as
// long as it rests on them), on a tap, while paused, and Esc toggles them.
let controlsTimer = 0, controlsPinned = false;
function showControls(ms = 3000) {
  $('ride').classList.add('show-controls');
  clearTimeout(controlsTimer);
  if (ms) controlsTimer = setTimeout(() => { if (!controlsPinned && !ride?.paused) $('ride').classList.remove('show-controls'); }, ms);
}
function hideControls() {
  clearTimeout(controlsTimer);
  controlsPinned = false;
  if (!ride?.paused) $('ride').classList.remove('show-controls');
}
$('ride').addEventListener('mousemove', () => showControls());
$('ride').addEventListener('touchstart', () => showControls(4000), { passive: true });
for (const el of [document.querySelector('#ride .controls'), $('sim-ctl')]) {
  el.addEventListener('mouseenter', () => { controlsPinned = true; showControls(0); });
  el.addEventListener('mouseleave', () => { controlsPinned = false; showControls(); });
  // touch: kept out while a finger is on them (dragging the slider), then a few seconds more
  el.addEventListener('touchstart', () => { controlsPinned = true; showControls(0); }, { passive: true });
  const release = () => { controlsPinned = false; showControls(4000); };
  el.addEventListener('touchend', release, { passive: true });
  el.addEventListener('touchcancel', release, { passive: true });
}
$('ride').addEventListener('touchmove', () => { if (!controlsPinned) showControls(4000); }, { passive: true });

/** Everything from the keyboard, for riders without a controller. */
const KEYS = [
  [['Space'], 'Pause / resume'],
  [['↑', 'W'], 'Harder: next gear (in ERG +1 % intensity)'],
  [['↓', 'S'], 'Easier: previous gear (in ERG −1 % intensity)'],
  [['⇧ ↑', 'PgUp'], 'Big step harder: workout +5 %, free ride climbs +10 %, hold +20 W'],
  [['⇧ ↓', 'PgDn'], 'Big step easier'],
  [['←', 'A'], 'Lane left'],
  [['→', 'D'], 'Lane right'],
  [['E'], 'ERG on / off (free ride: hold this power)'],
  [['N'], 'Skip the interval (free ride: new lap)'],
  [['P'], 'Pacer on / off'],
  [['1', '–', '5'], 'Camera: chase · rider\'s eyes · isometric · over the shoulder · front'],
  [['C'], 'Next camera'],
  [['H'], 'Hide / show the dashboard'],
  [['F'], 'Full screen'],
  [['M'], 'Bigger map'],
  [['I'], 'Mini window over other apps (film, football, YouTube)'],
  [['+', '−'], 'Simulator: power ±10 W'],
  [['Esc'], 'Menu: Finish and Settings'],
  [['?'], 'This list'],
];
function toggleKeysHelp(show = $('keys-help').hidden) {
  $('keys-list').innerHTML = KEYS.map(([k, what]) => `<dt>${k.map((x) => `<kbd>${x}</kbd>`).join(' ')}</dt><dd>${esc(tr(what))}</dd>`).join('');
  $('keys-help').hidden = !show;
}
$('btn-keys').onclick = () => toggleKeysHelp();
$('keys-help').addEventListener('click', (e) => { if (e.target === $('keys-help') || e.target.closest('[data-keys-close]')) toggleKeysHelp(false); });
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

window.addEventListener('keydown', onRideKey);
function onRideKey(e) {
  // the workout page in the lobby: Enter rides it
  if (!ride && !$('wk-detail').hidden && e.code === 'Enter' && !e.target.closest?.('button')) { e.preventDefault(); $('wkd-ride').click(); return; }
  if (!ride) return;
  // settings open, or typing in a field: the keys belong to them, not to the ride
  if (!$('drawer').hidden || e.target.closest?.('input, select, textarea')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const c = e.code;
  if (c === 'Escape') {
    if (!$('keys-help').hidden) toggleKeysHelp(false);
    else if ($('ride').classList.contains('show-controls')) hideControls();
    else { showControls(0); $('btn-pause').focus(); }
    return;
  }
  if (c === 'Slash' || c === 'KeyK') { toggleKeysHelp(); return; }
  if (e.repeat && !['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'BracketLeft', 'BracketRight'].includes(c)) return;
  const up = c === 'ArrowUp' || c === 'KeyW', down = c === 'ArrowDown' || c === 'KeyS';
  if (c === 'Space') { e.preventDefault(); togglePause(); }
  else if (c === 'PageUp' || (up && e.shiftKey)) { e.preventDefault(); bigStep(+1); }
  else if (c === 'PageDown' || (down && e.shiftKey)) { e.preventDefault(); bigStep(-1); }
  else if (up || c === 'BracketRight') { e.preventDefault(); shift(+1); }
  else if (down || c === 'BracketLeft') { e.preventDefault(); shift(-1); }
  else if (c === 'ArrowLeft' || c === 'KeyA') { e.preventDefault(); steer(-1); }
  else if (c === 'ArrowRight' || c === 'KeyD') { e.preventDefault(); steer(+1); }
  else if (c === 'KeyN') skipInterval();
  else if (c === 'KeyP') { if (ride.pacer) togglePacer(); }
  else if (c === 'KeyE') toggleErg();
  else if (c === 'KeyC') nextCamera();
  else if (/^(Digit|Numpad)[1-5]$/.test(c)) setCameraView(CAMERAS[Number(c.slice(-1)) - 1]);
  else if (c === 'KeyH') runIntent('hud');
  else if (c === 'KeyF') toggleFullscreen();
  else if (c === 'KeyM') toggleMinimap();
  else if (c === 'KeyI') togglePip();
  else if (ride.simulated && ['Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract'].includes(c)) {
    const s = $('sim-power');
    s.value = Number(s.value) + (c === 'Equal' || c === 'NumpadAdd' ? 5 : -5);
    s.oninput();
  }
}

// interface language (#31): the static page, the built-in routes, climbs and workouts, power zones
translateDom();
for (const r of routes) {
  if (!r.custom) { r.name = tr(r.name); r.description = tr(r.description); }
  localizeClimbs(r);
}
for (const w of workouts) { w.name = tr(w.name); w.description = tr(w.description); }
$('f-lang').innerHTML = LANGS.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
$('f-lang').value = lang;
$('f-lang').onchange = () => setLang($('f-lang').value);
initLobby();
offerDraft();
// leaving in the middle of a ride: keep what is there and ask first
window.addEventListener('beforeunload', (e) => {
  if (!ride || ride.elapsed < 10) return;
  saveDraft();
  e.preventDefault();
  e.returnValue = '';
});
document.addEventListener('visibilitychange', () => { if (document.hidden && ride) saveDraft(); });
// the 3D models download while you pick a route, so the ride opens with the real rider and bike
(window.requestIdleCallback || ((f) => setTimeout(f, 800)))(() => {
  import('./render3d.js').then((m) => m.webglAvailable() && m.preloadModels()).catch(() => {});
});

// ---------- Install as an app (#30) ----------
// the service worker keeps the app usable offline; Chrome then offers to install it, and so do we
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* no offline, the app still works */ });
}
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('btn-install').hidden = false; });
window.addEventListener('appinstalled', () => { track('install'); installPrompt = null; $('btn-install').hidden = true; toast(tr('Gruppetto is installed')); });
$('btn-install').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  $('btn-install').hidden = true;
};

// ---------- ?demo: a ride a little below the first climb's crowd, started with a click ----------
// (the click lets the browser play sound: a ride started on its own stayed silent)
if (new URLSearchParams(location.search).has('demo')) {
  const go = document.createElement('button');
  go.className = 'demo-start primary';
  go.textContent = tr('▶ Start the demo');
  document.body.appendChild(go);
  go.onclick = async () => {
    go.remove();
    unlockAudio();
    const route = routes.find((r) => r.climbs?.length) || routes[0];
    settings.routeId = route.id;
    settings.mode = 'free';
    settings.camera = 'chase'; // seen from behind the rider
    $('sim').checked = true;
    await startRide();
    if (!ride) return;
    ride.dist = Math.max(0, (route.climbs[0]?.end ?? 0) - 230);
    const s = $('sim-power');
    s.value = 260; s.oninput?.();
  };
}

// a challenge link: when the page opens with one, and when one is opened in the app already open
openChallenge();
window.addEventListener('hashchange', openChallenge);
