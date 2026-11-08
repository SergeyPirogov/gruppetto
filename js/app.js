import { WIND_CW, bluetoothAvailable, setShowAllDevices, knownDevices, Trainer, HeartRateMonitor, CadenceSensor, ZwiftController, OpenBikeControlDevice } from './ble.js';
import { obcIntents, rideIntent, OBC_LABELS } from './controls.js';
import { IntervalsClient, activityUrl, localDate } from './intervals.js';
import { stepSpeed, draftFactor, DEFAULTS, riderCdA } from './physics.js';
import { routes, Route, ROUTE_GROUPS, SEG } from './routes.js';
import { parseGpx, routeFromTrack } from './gpx.js';
import { loadTerrain } from './dem.js';
import { fetchOsm } from './osm.js';
import { t as tr, lang, locale, plural, setLang, LANGS, translateDom } from './i18n.js';
import { workouts, targetAt, totalDuration, stepWatts, zoneColor, powerZone } from './workouts.js';
import { Recorder } from './recorder.js';
import { Sampler } from './sampler.js';
import { unlockAudio, beep, say, spokenDuration } from './sound.js';
import { Scene, drawProfile } from './render.js';
import { themeFor } from './themes.js';
import { GEARS, DEFAULT_GEAR, ratioOf, virtualWheelMm, gearGradeOffset, BASE_WHEEL_MM } from './gears.js';

const $ = (id) => document.getElementById(id);
// units in the interface language
const U = { km: tr('km'), m: tr('m'), W: tr('W'), bpm: tr('bpm'), rpm: tr('rpm'), min: tr('min'), wkg: tr('W/kg') };

// ---------- Settings ----------
const DEFAULT_SETTINGS = {
  name: 'Me', weight: 75, height: 178, ftp: 200, difficulty: 50, routeId: 'rolling', mode: 'free',
  icuKey: '', icuAthlete: '', icuUpload: true,
  chainring: 34, shiftMode: 'wheel', graphics: '3d',
  jersey: '#16a0a8', stripe: '#ff8a1f',
  intensity: 100, sound: true, voice: true, pacer: true, pacerName: 'Pacer', freePacer: false, freePacerWkg: 2.5, bots: 5, ghost: 'best', style: 'cartoon', camera: 'chase',
};
let settings = { ...DEFAULT_SETTINGS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('powerup.settings') || '{}')); } catch { /* storage unavailable */ }
// ?debug: reach the current ride from devtools (jump along the route when testing laps and climbs)
if (new URLSearchParams(location.search).has('debug')) {
  Object.defineProperty(window, '__ride', { get: () => ride });
  window.__planDemo = (list) => { icuWorkouts = list; icuClient = icuClient || { demo: true, uploadActivity: async () => null }; renderModes(); }; // try the plan box and uploads without an account
}

// personal bests on this device: { lap: {routeId: seconds}, seg: {climbId: seconds} }
const records = (() => { try { return JSON.parse(localStorage.getItem('gruppetto.records') || '{}'); } catch { return {}; } })();
records.lap ||= {}; records.seg ||= {}; records.segTrace ||= {}; // segTrace: seconds at every 10 m of the record climb
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
const gradeColor = (g) => g > 0.06 ? '#ef4444' : g > 0.03 ? '#f97316' : g < -0.02 ? '#60a5fa' : '#e8edf5';
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
hrm.addEventListener('data', ({ detail: d }) => { const now = performance.now(); live.hr = d.heartRate; live.hrAt = now; hrSamples.add(now, d.heartRate); });
cadenceSensor.addEventListener('data', ({ detail: d }) => { const now = performance.now(); live.cadence = d.cadence; live.cadAt = now; cadenceSamples.add(now, d.cadence); });
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
  d.dev.addEventListener('disconnect', () => { updateDeviceUI(); toast(tr('{what} — reconnecting…', { what: d.lost })); });
  d.dev.addEventListener('reconnecting', ({ detail: n }) => { reconnecting.set(d.key, n); updateDeviceUI(); });
  d.dev.addEventListener('reconnected', () => {
    reconnecting.delete(d.key);
    if (d.dev === trainer) resyncTrainer();
    updateDeviceUI();
    toast(tr('{name}: connection restored ✓', { name: d.dev.name }));
  });
  d.dev.addEventListener('reconnect-failed', () => {
    reconnecting.delete(d.key);
    updateDeviceUI();
    toast(tr('{name}: could not reconnect — press “Connect” in the lobby', { name: d.dev.name }));
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
  return d.dev.name;
}

/** A live reading, or 0 once it is older than 3 s (the trainer stops sending when you stop pedalling). */
const fresh = (v, at) => (performance.now() - at < 3000 ? v : 0);

function updateDeviceUI() {
  for (const d of DEVICES) {
    const btn = $(`btn-${d.key}`);
    $(`${d.key}-status`).textContent = deviceStatus(d);
    // cadence from the trainer counts as connected; the button then offers a separate sensor instead
    const viaTrainer = d.dev === cadenceSensor && !d.dev.connected && trainer.connected;
    btn.textContent = d.dev.connected ? tr('Disconnect') : viaTrainer ? tr('Change') : tr('Connect');
    btn.title = viaTrainer ? tr('Connect a separate cadence sensor instead of the trainer') : '';
    btn.classList.toggle('ok', d.dev.connected || viaTrainer);
  }
  // a Zwift Ride is two units: offer to add the other one while fewer than two are connected
  $('btn-ctl-add').hidden = !(controller.connected && controller.count < 2);
  // lobby top bar: a dot per device, lit when connected
  for (const d of DEVICES) {
    const chip = document.querySelector(`.dev-chip[data-key="${d.key}"]`);
    if (chip) chip.classList.toggle('on', d.dev.connected || (d.dev === cadenceSensor && trainer.connected));
  }
  document.querySelector('.dev-chip[data-key="sim"]')?.classList.toggle('on', $('sim').checked);
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
  if (key === 'shiftMode' || key === 'chainring') {
    ride.shiftMode = settings.shiftMode;
    ride.lastSentGrade = null; ride.lastSentWheel = null;
    updateGear();
  }
  if (key === 'style') scene?.setStyle?.(settings.style);
  if (key === 'camera') scene?.setCamera?.(settings.camera);
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

/** On page load: quietly reconnect every remembered device that is in range. */
async function autoConnectRemembered() {
  for (const d of DEVICES) {
    if (d.dev.connected || !settings.devices?.[d.key]) continue;
    $(`${d.key}-status`).textContent = tr('connecting remembered device…');
    const ok = await reopenRemembered(d);
    if (ok && d.dev === trainer) $('sim').checked = false;
    updateDeviceUI();
  }
}

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
  bind('f-weight', 'weight');
  bind('f-height', 'height');
  bind('f-ftp', 'ftp');
  bind('f-diff', 'difficulty');
  bind('f-chainring', 'chainring');
  bind('f-shift', 'shiftMode', false);
  bind('f-style', 'style', false);
  bind('f-camera', 'camera', false);
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
      b.innerHTML = `<b>${esc(r.name)}</b><small>${(r.length / 1000).toFixed(r.custom ? 1 : 0)} ${U.km} · ↗ ${Math.round(r.elevationGain)} ${U.m}</small><small>${esc(r.description)}</small><canvas></canvas>`
        + (r.custom ? `<span class="rc-del" title="${tr('Delete this route')}" role="button">✕</span>` : '');
      b.onclick = (ev) => {
        if (ev.target.classList.contains('rc-del')) { deleteCustomRoute(r); return; }
        settings.routeId = r.id; saveSettings(); markRoute(); showRoute();
      };
      box.append(b);
      requestAnimationFrame(() => drawProfile(b.querySelector('canvas'), r, [], `${themeFor(r.theme).accent}99`));
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
    r.description = tr({
      none: 'Imported from GPX (no elevation in the file: flat). Point to point, finish at {km} km.',
      terrain: 'Imported from GPX (elevation from a terrain model). Point to point, finish at {km} km.',
      gpx: 'Imported from GPX. Point to point, finish at {km} km.',
    }[src], { km: (r.length / 1000).toFixed(1) });
  }
  for (const c of r.climbs) { const m = /^Climb (\d+)$/.exec(c.name); c.name = m ? tr('Climb {n}', { n: m[1] }) : tr(c.name); }
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

const allWorkouts = () => [...icuWorkouts, ...workouts];

/** Today's and tomorrow's workouts from the intervals.icu calendar, right in the lobby. */
function renderPlan() {
  const box = $('plan-box'), list = $('plan-list');
  if (!box) return;
  box.hidden = !icuClient;
  if (!icuClient) return;
  const planned = icuWorkouts.filter((w) => ['today', 'tomorrow'].includes(dayLabel(w.date)));
  list.innerHTML = planned.length ? '' : `<p class="muted plan-empty">${tr('Nothing planned for today or tomorrow')}</p>`;
  for (const w of planned) {
    const b = document.createElement('button');
    b.className = 'option';
    b.dataset.id = w.id;
    const day = dayLabel(w.date);
    b.innerHTML = `<span class="tag plan-day ${day}">${tr(day === 'today' ? 'Today' : 'Tomorrow')}</span><b>${esc(w.name)}</b><small>${Math.round(totalDuration(w) / 60)} ${U.min}${w.description ? ` · ${esc(w.description)}` : ''}</small><canvas></canvas>`;
    b.onclick = () => { settings.mode = w.id; settings.lastWorkout = w.id; saveSettings(); renderModes(); };
    b.classList.toggle('sel', settings.mode === w.id);
    list.append(b);
    requestAnimationFrame(() => drawWorkoutChart(b.querySelector('canvas'), w, -1));
  }
}

/** Mode: free ride, or a workout picked in its own menu. */
function renderModes() {
  renderPlan();
  const ml = $('mode-list');
  ml.innerHTML = '';
  const w = allWorkouts().find((x) => x.id === settings.mode)
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
    ? `<span class="wk-pick-head"><b>${esc(w.name)}</b><span class="wk-change">${tr('Workouts')} ›</span></span><small>${Math.round(totalDuration(w) / 60)} ${U.min} · ${esc(w.description)}</small><canvas></canvas>`
    : `<span class="wk-pick-head"><b>${tr('Workout')}</b><span class="wk-change">${tr('Choose')} ›</span></span><small>${tr('Structured intervals in ERG: the trainer holds the target power.')}</small>`;
  wb.onclick = (ev) => {
    if (w && settings.mode !== w.id && !ev.target.closest('.wk-change')) { settings.mode = w.id; saveSettings(); renderModes(); return; }
    openWorkoutMenu();
  };
  ml.append(free, wb);
  free.classList.toggle('sel', settings.mode === 'free');
  wb.classList.toggle('sel', settings.mode !== 'free' && !!w && w.id === settings.mode);
  if (w) requestAnimationFrame(() => drawWorkoutChart(wb.querySelector('canvas'), w, -1));
  updateSummary();
}

/** The workout menu: planned intervals.icu workouts first, then the built-in ones. */
function openWorkoutMenu() {
  const menu = $('wk-menu'), list = $('wk-menu-list');
  list.innerHTML = '';
  const add = (w, tag) => {
    const b = document.createElement('button');
    b.className = 'option';
    b.dataset.id = w.id;
    b.innerHTML = `${tag ? `<span class="tag">intervals.icu · ${esc(tag)}</span>` : ''}<b>${esc(w.name)}</b><small>${Math.round(totalDuration(w) / 60)} ${U.min} · ${esc(w.description)}</small><canvas></canvas>`;
    b.onclick = () => { settings.mode = w.id; settings.lastWorkout = w.id; saveSettings(); closeWorkoutMenu(); renderModes(); };
    b.classList.toggle('sel', w.id === settings.mode);
    list.append(b);
    requestAnimationFrame(() => drawWorkoutChart(b.querySelector('canvas'), w, -1));
  };
  for (const w of icuWorkouts) add(w, dayLabel(w.date));
  for (const w of workouts) add(w);
  menu.hidden = false;
}
function closeWorkoutMenu() { $('wk-menu').hidden = true; }

/** The selected route, large, at the top of the lobby. */
function showRoute() {
  const r = routes.find((x) => x.id === settings.routeId) || routes[0];
  if (!r) return;
  $('rh-name').textContent = r.name;
  $('rh-meta').textContent = `${(r.length / 1000).toFixed(r.custom ? 1 : 0)} ${U.km} · ↗ ${Math.round(r.elevationGain)} ${U.m}`;
  $('rh-desc').textContent = r.description;
  // OpenStreetMap's licence (ODbL) asks for the attribution wherever its data shows
  if (r.land) $('rh-desc').insertAdjacentHTML('beforeend', ` <small class="osm-attr">${tr('Map data')} © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> ${tr('contributors')}</small>`);
  renderGhostPicker();
  // the timed climbs, with this device's record on each
  $('rh-climbs').innerHTML = r.climbs.map((c) => `<li><b>⛰ ${esc(c.name)}</b> ${(c.length / 1000).toFixed(1)} ${U.km} · ${(c.grade * 100).toFixed(1)}%${records.seg[c.id] ? ` · <span class="pb">🏆 ${fmtTime(records.seg[c.id])}</span>` : ''}</li>`).join('')
    + (records.lap[r.id] ? `<li><b>⏱ ${r.oneWay ? tr('Best time') : tr('Best lap')}</b> <span class="pb">${fmtTime(records.lap[r.id])}</span></li>` : '');
  requestAnimationFrame(() => drawProfile($('rh-profile'), r, [], `${themeFor(r.theme).accent}cc`));
  updateSummary();
}

/** "Rolling Hills · Sweet Spot 3×10" above the Ride button. */
function updateSummary() {
  const el = $('ride-summary');
  if (!el) return;
  const r = routes.find((x) => x.id === settings.routeId);
  const sel = document.querySelector('#mode-list .sel b');
  const g = r && pickGhost(r.id);
  const free = settings.mode === 'free';
  const pacer = free && settings.freePacer ? `🚴 ${settings.pacerName?.trim() || tr('Pacer')} ${settings.freePacerWkg} ${U.wkg}` : null;
  el.textContent = [r?.name, sel?.textContent, g ? `👻 ${settings.ghost === 'last' ? tr('last ride') : tr('your best')}` : null, pacer].filter(Boolean).join(' · ');
}

/** Side drawer with Devices, Profile and intervals.icu, opened from the top bar. */
function openDrawer(panel) {
  const drawer = $('drawer');
  drawer.hidden = false;
  drawer.classList.toggle('in-ride', !!ride);
  for (const c of drawer.querySelectorAll('[data-panel]')) c.hidden = c.dataset.panel !== panel;
  for (const t of drawer.querySelectorAll('.drawer-tabs [data-open]')) t.classList.toggle('sel', t.dataset.open === panel);
}

function initDrawer() {
  const drawer = $('drawer');
  const open = openDrawer;
  for (const el of document.querySelectorAll('#lobby [data-open], #drawer [data-open]')) el.addEventListener('click', () => open(el.dataset.open));
  for (const el of drawer.querySelectorAll('[data-close]')) el.addEventListener('click', () => { drawer.hidden = true; });
  window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && !drawer.hidden) drawer.hidden = true; });
  window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && !$('wk-menu').hidden) closeWorkoutMenu(); });
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
function makeBots(n) {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr.splice(Math.floor(Math.random() * arr.length), 1)[0];
  const names = BOT_NAMES.slice(), kits = BOT_KITS.filter(([c]) => c.toLowerCase() !== String(settings.jersey).toLowerCase());
  const ftpWkg = Math.max(1.5, settings.ftp / Math.max(40, settings.weight));
  return Array.from({ length: n }, (_, i) => {
    const [en, uk] = pick(names), [color, stripe] = pick(kits.length ? kits : BOT_KITS.slice());
    const weight = Math.round(rnd(60, 88)), height = Math.round(165 + (weight - 60) * 0.9 + rnd(-6, 6));
    // spread evenly across the range, then shuffled by the random start order
    const level = 0.55 + (n > 1 ? i / (n - 1) : 0.5) * 0.4 + rnd(-0.04, 0.04);
    return {
      name: lang === 'uk' ? uk : en, color, stripe, weight, cda: riderCdA(height, weight),
      wkg: Math.round(ftpWkg * level * 10) / 10, rpm: Math.round(rnd(82, 98)), phase: rnd(0, 6.28),
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

async function startRide() {
  const route = routes.find((r) => r.id === settings.routeId) || routes[0];
  const workout = [...icuWorkouts, ...workouts].find((w) => w.id === settings.mode) || null;
  const simulated = $('sim').checked || !trainer.connected;
  ride = {
    route, workout, simulated,
    dist: 0, v: 0, elapsed: 0, secAcc: 0, workoutT: 0, workoutDone: false,
    gain: 0, lastElev: route.elevAt(0), laps: 0, lapStartT: 0, lapTimes: [], efforts: [], seg: null, prevDist: 0,
    paused: false, pedal: 0, lastSim: performance.now(), moved: 0,
    powerHist: [], target: null, lastSentTarget: null, lastSentGrade: null, lastGradeSentAt: 0,
    cda: riderCdA(settings.height, settings.weight), // air drag from your height and weight
    gear: DEFAULT_GEAR, ergBias: 0, ergFactor: 1, lowFor: 0, lastSentWheel: null, shiftMode: settings.shiftMode, lane: START_LANE, laneTarget: START_LANE,
    bots: makeBots(settings.bots ?? 5).map((b, i) => ({ ...b, dist: 15 + i * 12, v: 0, pedal: i, lane: i % 2 ? -1.6 : 1.6, home: i % 2 ? -1.6 : 1.6, laneTarget: i % 2 ? -1.6 : 1.6 })),
    // workout pacer: a virtual training partner riding the target power exactly, at your weight
    ghost: (() => { const g = pickGhost(route.id); return g ? { entry: g, name: settings.ghost === 'last' ? tr('Last ride') : tr('Your best'), color: settings.jersey, stripe: settings.stripe, dist: 0, pedal: 0.3, lane: START_LANE - 1.3, ghost: true } : null; })(),
    // free-ride pacer (#27): steady at the W/kg you set, waiting at the foot of each climb
    pacer: { name: settings.pacerName?.trim() || tr('Pacer'), color: '#facc15', stripe: '#111827', dist: 0, v: 0, pedal: 0.5, lane: -0.5, pacer: true, free: !workout },
  };
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
  $('wk-pacer-btn').classList.toggle('on', settings.pacer !== false);
  $('wk-erg-btn').classList.add('on'); // every workout starts in ERG
  $('paused').hidden = true;
  $('btn-pause').textContent = tr('Pause');
  $('ride').classList.remove('show-controls');
  await ensureScene();
  scene.setStyle?.(settings.style);
  scene.setCamera?.(settings.camera);
  ride.lastSim = performance.now();
  clearInterval(rideTimer);
  rideTimer = setInterval(() => advance(), 250);
  keepAwake(true);
  if (simulated) toast(tr('Simulator mode: set power with the slider or ↑/↓'));
  if (scene.orbit) setTimeout(() => toast(tr('Camera: drag to orbit, scroll to zoom, double-click to reset')), simulated ? 3500 : 0);
  requestAnimationFrame(frame);
}

/** Power (W) for physics at time t: the trainer's reading averaged over the last second. */
function powerAt(t) {
  if (ride.simulated) {
    if (ride.workout && ride.target !== null) return ride.target;
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
  while (left > 1e-6) {
    const dt = Math.min(0.1, left, 1 - ride.secAcc);
    t += dt * 1000;
    const power = powerAt(t);
    const cadence = cadenceAt(t, power);
    const grade = route.gradeAt(ride.dist);
    // drafting: the best wheel to sit on among the riders just ahead
    const pack = [...ride.bots, ...(pacerOn() ? [ride.pacer] : [])];
    ride.draft = Math.max(0, ...pack.map((o) => draftFactor(o.dist - ride.dist, o.lane - ride.lane)));
    ride.v = stepSpeed(ride.v, power, grade, dt, settings.weight, { cda: ride.cda * (1 - ride.draft) });
    // your speed on your own, out of the wind shadow: faster than the wheel ahead -> you come past it,
    // otherwise you sit in and draft
    ride.vFree = stepSpeed(ride.vFree ?? ride.v, power, grade, dt, settings.weight, { cda: ride.cda });
    // on a wheel: no riding into the back of the rider ahead (the overtake logic swings you out instead)
    for (const o of pack) if (Math.abs(o.lane - ride.lane) < 0.8) ride.v = Math.min(ride.v, wheelCap(o.dist - ride.dist, o.v ?? ride.v));
    const moved = ride.v * dt;
    ride.dist += moved;
    ride.moved += moved;
    // Pedal animation only: trainers like the KICKR CORE derive cadence from the flywheel and report
    // 0–1 rpm at low speed, so while there is power the legs keep turning at a plausible rate.
    const animCadence = cadence >= 20 ? cadence : power > 5 ? Math.max(cadence, 60) : cadence;
    ride.pedal = animCadence < 5 ? levelPedals(ride.pedal, dt) : ride.pedal + (animCadence / 60) * Math.PI * 2 * dt;
    ride.lane = ride.autoLane ? easeLane(ride.lane, ride.laneTarget, dt, ride) : ride.lane + (ride.laneTarget - ride.lane) * Math.min(1, dt * 4);
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
      P.v = stepSpeed(P.v, pw, route.gradeAt(P.dist), dt, settings.weight, { cda: ride.cda }); // your size, your drag
      P.power = pw;
      if (P.free && pacerOn()) pacerRegroup(P, dt);
      P.dist += P.v * dt;
      const pc = liveCadence(P, 90, route.gradeAt(P.dist), ride.elapsed, dt, 5);
      P.pedal = pc < 5 ? levelPedals(P.pedal, dt) : P.pedal + (pc / 60) * Math.PI * 2 * dt;
      // rides beside you, on the side with more room; switches sides only well past the centre line
      P.side = ride.lane > 0.6 ? -1 : ride.lane < -0.6 ? 1 : (P.side || (ride.lane > 0 ? -1 : 1));
      P.lane = easeLane(P.lane, ride.lane + 1.4 * P.side, dt, P);
    }
    // overtaking: a rider closing on someone in the same lane swings out to a free one, then back
    if ((ride.laneCheck = (ride.laneCheck || 0) + dt) > 0.25) {
      ride.laneCheck = 0;
      const solid = [{ dist: ride.dist, lane: ride.lane, laneTarget: ride.laneTarget, v: ride.v, vFree: ride.vFree, me: true }, ...ride.bots, ...(pacerOn() ? [ride.pacer] : [])];
      for (const b of ride.bots) b.laneTarget = pickLane(b, solid, b.home);
      if (!ride.steeredAt || ride.elapsed - ride.steeredAt > 4) { // unless you steered yourself just now
        const me = solid[0], t = pickLane(me, solid, ride.laneHome ?? START_LANE);
        if (t !== ride.laneTarget) { ride.laneTarget = t; ride.autoLane = true; }
      }
    }
    for (const b of ride.bots) b.lane = easeLane(b.lane, b.laneTarget, dt, b);
    for (const b of ride.bots) {
      const g = route.gradeAt(b.dist);
      // his steady pace, harder up the climbs and easier down, and never perfectly even
      const swing = 1 + Math.sin(ride.elapsed * 0.05 + b.phase) * 0.05 + Math.sin(ride.elapsed * 0.17 + b.phase * 2) * 0.03;
      const p = b.wkg * b.weight * swing * (1 + Math.max(-0.6, Math.min(0.35, g * 4)));
      b.power = p;
      const wheels = [{ dist: ride.dist, lane: ride.lane }, ...ride.bots.filter((o) => o !== b)];
      const bd = Math.max(0, ...wheels.map((o) => draftFactor(o.dist - b.dist, o.lane - b.lane)));
      b.v = stepSpeed(b.v, p, g, dt, b.weight, { cda: b.cda * (1 - bd) });
      b.vFree = stepSpeed(b.vFree ?? b.v, p, g, dt, b.weight, { cda: b.cda });
      for (const o of wheels) if (Math.abs(o.lane - b.lane) < 0.8) b.v = Math.min(b.v, wheelCap(o.dist - b.dist, o === wheels[0] ? ride.v : o.v));
      b.dist += b.v * dt;
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

function frame(now) {
  if (!ride) return;
  advance(now);
  const riders = [
    { dist: ride.dist, color: settings.jersey, stripe: settings.stripe, pedal: ride.pedal, self: true, name: settings.name, lane: ride.lane },
    ...ride.bots,
    ...(pacerOn() ? [ride.pacer] : []),
    ...(ride.ghost ? [ride.ghost] : []),
    ...(ride.climbGhost ? [ride.climbGhost] : []),
  ];
  scene.render(ride.route, ride.dist, riders, ride.moved);
  ride.moved = 0;
  requestAnimationFrame(frame);
}

/** Riders ahead you could reach within 10 s at your speed: name, gap in seconds and metres, their W/kg. */
function updateAhead() {
  const v = Math.max(ride.v, 2), all = [...ride.bots, ...(pacerOn() ? [ride.pacer] : []), ...(ride.ghost ? [ride.ghost] : []), ...(ride.climbGhost ? [ride.climbGhost] : [])];
  const ahead = all
    .map((r) => ({ r, gap: r.dist - ride.dist }))
    .filter(({ gap }) => gap > 0.5 && gap / v <= 10)
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 4);
  $('ahead').hidden = !ahead.length;
  $('ahead-rows').innerHTML = ahead.map(({ r, gap }) => {
    const wkg = r.wkg ?? (r.power ? r.power / settings.weight : 0);
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
/** Top speed behind a wheel `gap` m ahead: eases down to its speed instead of braking at the last moment. */
function wheelCap(gap, v) {
  return gap > 0 && gap < 2.5 ? v + Math.max(0, gap - 0.9) * 1.5 : Infinity;
}
function pickLane(r, others, home) {
  const near = (lane, from, to, closing = false) => others.some((o) => o !== r
    && (Math.abs((o.laneTarget ?? o.lane) - lane) < 0.9 || Math.abs(o.lane - lane) < 0.9)
    && o.dist - r.dist > from && o.dist - r.dist < to
    // only someone you are faster than on your own: on a wheel at the same power you sit in and draft
    && (!closing || (r.vFree ?? r.v ?? 0) > (o.vFree ?? o.v ?? 0) + 0.3));
  const cur = r.laneTarget ?? r.lane;
  // never change course while alongside someone: finish the pass in the lane you chose
  if (others.some((o) => o !== r && Math.abs(o.dist - r.dist) < 3.5 && Math.abs(o.lane - r.lane) >= 0.9 && Math.abs(o.lane - r.lane) < 2)) return cur;
  if (!near(cur, -0.5, 15, true)) return near(home, -6, 10) ? cur : home; // nobody just ahead: drift back home when it is clear
  const free = LANES.filter((l) => !near(l, -3, 15)).sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
  return free.length ? free[0] : cur;
}

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
      const t = ride.elapsed, best = records.lap[route.id];
      ride.lapTimes.push(t);
      if (!best || t < best) { records.lap[route.id] = t; saveRecords(); }
      toast(!best ? tr('Finish! {time} 🏁', { time: fmtTime(t) }) : t < best ? tr('Finish! {time} — new record! ({delta}) 🏆', { time: fmtTime(t), delta: fmtDelta(t - best) }) : tr('Finish! {time} ({delta} vs best)', { time: fmtTime(t), delta: fmtDelta(t - best) }));
      cueBeep(1180, 0.3);
      setTimeout(() => { if (ride?.finished) finishRide(); }, 2500);
    }
  } else if (Math.floor(ride.dist / route.length) > ride.laps) {
    const laps = Math.floor(ride.dist / route.length);
    ride.laps = laps;
    // lap time against this route's best on this device
    const t = ride.elapsed - ride.lapStartT, best = records.lap[route.id];
    ride.lapStartT = ride.elapsed;
    ride.lapTimes.push(t);
    if (!best || t < best) {
      records.lap[route.id] = t; saveRecords();
      toast(best ? tr('Lap {n}: {time} — new best lap! ({delta}) 🏆', { n: laps, time: fmtTime(t), delta: fmtDelta(t - best) }) : tr('Lap {n}: {time} — first lap on this route 🎉', { n: laps, time: fmtTime(t) }));
    } else toast(tr('Lap {n}: {time} ({delta} vs best)', { n: laps, time: fmtTime(t), delta: fmtDelta(t - best) }));
    if (!ride.workout || ride.workoutDone) recorder.markLap();
  }
  updateSegments();

  // workout / trainer control
  const grade = route.gradeAt(ride.dist);
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
    if (inErgStep()) {
      const sendW = effectiveTarget();
      if (sendW !== ride.lastSentTarget) { trainer.setTargetPower(sendW); ride.lastSentTarget = sendW; }
      ride.lastSentGrade = null;
    } else {
      ride.lastSentTarget = null;
      if (ride.shiftMode === 'wheel') sendVirtualGear();
      const offset = ride.shiftMode === 'wheel' ? 0 : gearGradeOffset(ride.gear);
      const g = Math.round((grade * 100 * (settings.difficulty / 100) + offset) * 10) / 10;
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

  recorder.add({
    power, cadence, heartRate: hr, speed: ride.v, distance: ride.dist,
    altitude: elev, elevationGain: ride.gain,
  });

  ride.powerHist.push(power);
  if (ride.powerHist.length > 3) ride.powerHist.shift();
  // running averages for the board (zeros left out, as in the ride summary)
  const A = ride.avg ||= { hr: 0, hrN: 0, cad: 0, cadN: 0 };
  if (hr > 0) { A.hr += hr; A.hrN++; }
  if (cadence > 0) { A.cad += cadence; A.cadN++; }
  updateHud(cadence, hr, grade);
}

function updateHud(cadence, hr, grade) {
  const p3 = Math.round(ride.powerHist.reduce((a, b) => a + b, 0) / ride.powerHist.length);
  $('m-power').textContent = p3;
  $('m-wkg').textContent = `${(p3 / settings.weight).toFixed(1)} ${U.wkg}`;
  // power zone: the board's bar and a Z1–Z7 tag take the zone's colour (in a workout the number itself
  // shows how close you are to the target, below)
  const zone = powerZone(p3 / Math.max(1, settings.ftp));
  const powerRow = document.querySelector('.stat.power');
  powerRow.style.setProperty('--c', zone.color);
  $('m-zone').textContent = `Z${zone.z}`;
  $('m-zone').style.background = zone.color;
  $('m-zone').title = tr(zone.name);
  if (!ride.workout || ride.workoutDone) $('m-power').style.color = p3 > 0 ? zone.color : '';
  else $('m-power').style.color = '';
  $('m-cad').textContent = Math.round(cadence);
  $('m-hr').textContent = hr ? Math.round(hr) : '—';
  const A = ride.avg;
  $('m-hr-avg').textContent = A?.hrN ? `${tr('avg')} ${Math.round(A.hr / A.hrN)}` : '';
  $('m-cad-avg').textContent = A?.cadN ? `${tr('avg')} ${Math.round(A.cad / A.cadN)}` : '';
  $('m-speed').textContent = (ride.v * 3.6).toFixed(1);
  updateAhead();
  const df = ride.draft || 0;
  $('draft-tag').hidden = df < 0.03;
  if (df >= 0.03) {
    $('draft-tag').textContent = `🌀 ${tr('Drafting · −{n}% drag', { n: Math.round(df * 100) })}`;
    $('draft-tag').style.setProperty('--d', df / 0.33);
  }
  if (ride.ghost) {
    const G = ride.ghost, gap = ride.dist - G.dist, tg = ghostTimeAt(G.entry, ride.dist);
    const secs = tg === null ? null : Math.round(tg - ride.elapsed); // + = you got here sooner
    $('ghost-tag').hidden = false;
    $('ghost-tag').className = `ghost-tag ${gap >= 0 ? 'c-ok' : 'c-bad'}`;
    $('ghost-tag').textContent = `👻 ${G.name}: ${Math.abs(gap) < 2 ? tr('level') : (gap > 0 ? tr('{n} m ahead', { n: Math.round(Math.abs(gap)) }) : tr('{n} m behind', { n: Math.round(Math.abs(gap)) }))}${secs !== null && Math.abs(gap) >= 2 ? ` · ${secs >= 0 ? '−' : '+'}${fmtTime(Math.abs(secs))}` : ''}`;
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
    const P = ride.pacer;
    $('wk-pacer').hidden = !pacerOn();
    if (pacerOn()) {
      const gap = Math.round(ride.dist - P.dist);
      $('wk-pacer').textContent = Math.abs(gap) < 3 ? tr('With {name}', { name: P.name }) : gap > 0 ? `${P.name} ${tr('{n} m behind', { n: gap })}` : `${P.name} ${tr('{n} m ahead', { n: -gap })}`;
      $('wk-pacer').className = `pacer-tag ${gap >= -3 ? 'c-ok' : gap >= -25 ? 'c-warn' : 'c-bad'}`;
    }
    $('wk-diff').textContent = target ? `${p3 - target >= 0 ? '+' : '−'}${Math.abs(Math.round(p3 - target))}` : '';
    $('wk-diff').className = cls;
    if (ride.ergFactor < 1 && target) $('wk-diff').textContent = `ERG ${Math.round(ride.ergFactor * 100)}%`;
    $('wk-left').textContent = t ? fmtTime(ride.workoutDone ? 0 : t.remaining - 1) : '0:00';
    const cad = t?.step?.cad;
    const cadEl = $('wk-cad');
    cadEl.textContent = cad ? `${cad[0]}–${cad[1]}` : '—';
    cadEl.className = cad && cadence > 0 ? (cadence >= cad[0] - 2 && cadence <= cad[1] + 2 ? 'c-ok' : 'c-warn') : '';
    $('m-cad').className = cadEl.className;
    const next = t && ride.workout.steps[t.index + 1];
    const nextW = next ? scaleW(stepWatts(next, 0, settings.ftp)) : null;
    $('wk-next').textContent = next ? (nextW === null ? tr('free') : `${nextW} ${U.W}`) : '—';
    drawWorkoutChart($('wk-chart'), ride.workout, ride.workoutT);
  }

  drawProfile($('profile'), ride.route, [...ride.bots, ...(ride.ghost ? [{ dist: ride.ghost.dist, color: 'rgba(255,255,255,.6)' }] : []), { dist: ride.dist, color: settings.jersey, self: true }]);
}

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

function drawMinimap() {
  const canvas = $('minimap');
  if (!canvas || !ride || $('minimap-box').offsetParent === null) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  const g = canvas.getContext('2d'), route = ride.route, { pts, step } = routeShape(route);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const pad = 12, k = Math.min((W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0));
  const ox = (W - (x1 - x0) * k) / 2 - x0 * k, oy = (H - (y1 - y0) * k) / 2 - y0 * k;
  const L = route.length;
  const at = (d, wrap = true) => { // map point at distance d along the route (riders wrap round a loop)
    const dd = route.oneWay || !wrap ? Math.max(0, Math.min(L, d)) : ((d % L) + L) % L;
    const f = dd / step, i = Math.min(pts.length - 2, Math.floor(f)), t = f - i;
    return [ox + (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t) * k, oy + (pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t) * k];
  };
  const line = (from, to, color, width) => {
    g.beginPath();
    for (let d = from; d <= to; d += step) { const [px, py] = at(Math.min(d, to), false); d === from ? g.moveTo(px, py) : g.lineTo(px, py); }
    const [ex, ey] = at(to, false); g.lineTo(ex, ey);
    g.strokeStyle = color; g.lineWidth = width; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke();
  };
  line(0, L, 'rgba(255,255,255,.18)', 6);
  line(0, L, 'rgba(232,237,245,.75)', 2.2);
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
  dot(ride.dist, settings.jersey, 5, '#fff');
}

/** Climb segments: start the timer at the foot, stop it at the top, compare with the best. */
function updateSegments() {
  const { route } = ride, L = route.length, prev = ride.prevDist, cur = ride.dist;
  ride.prevDist = cur;
  const crossed = (at) => Math.floor((prev - at) / L) < Math.floor((cur - at) / L);
  if (ride.seg) {
    const S = ride.seg, done = cur - S.d0;
    if (done >= S.climb.length) {
      const t = ride.elapsed - S.t0, best = records.seg[S.climb.id];
      ride.efforts.push({ name: S.climb.name, time: t, best, pb: !best || t < best });
      if (!best || t < best) {
        records.seg[S.climb.id] = t;
        S.trace.push(Math.round(t * 10) / 10);
        records.segTrace[S.climb.id] = S.trace; // the record attempt, for the climb ghost next time
        saveRecords();
      }
      ride.climbGhost = null;
      toast(!best ? tr('{name}: {time} — first time up 🎉', { name: S.climb.name, time: fmtTime(t) }) : t < best ? tr('{name}: {time} — new record! ({delta}) 🏆', { name: S.climb.name, time: fmtTime(t), delta: fmtDelta(t - best) }) : tr('{name}: {time} ({delta} vs best)', { name: S.climb.name, time: fmtTime(t), delta: fmtDelta(t - best) }));
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
    }
  }
  if (!ride.seg) {
    const c = route.climbs.find((cl) => crossed(cl.start));
    if (c) {
      ride.seg = { climb: c, t0: ride.elapsed, d0: cur - (((cur - c.start) % L) + L) % L, trace: [0], lastT: 0, lastOff: 0 };
      // your record on this climb starts beside you and rides it at its own pace (#26)
      const best = records.seg[c.id];
      ride.climbGhost = best ? { name: tr('Climb record'), ghost: true, climb: true, color: settings.jersey, stripe: settings.stripe, dist: ride.seg.d0, pedal: 0.6, lane: START_LANE + 1.1, trace: records.segTrace[c.id] || null, best, length: c.length } : null;
      toast(tr('{name} — {km} km at {grade}%. Go! ⛰️', { name: c.name, km: (c.length / 1000).toFixed(1), grade: (c.grade * 100).toFixed(1) }));
    }
  }
  const panel = $('seg-panel');
  panel.hidden = !ride.seg;
  if (ride.seg) {
    const S = ride.seg, t = ride.elapsed - S.t0, best = records.seg[S.climb.id];
    const frac = Math.min(1, (cur - S.d0) / S.climb.length);
    $('seg-name').textContent = S.climb.name;
    $('seg-time').textContent = fmtTime(t);
    $('seg-left').textContent = tr('{n} m to the top', { n: Math.max(0, Math.round((S.climb.length - (cur - S.d0)))) });
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
  const best = records.lap[ride.route.id];
  if (ride.route.oneWay) $('progress-label').textContent = `${(Math.min(ride.dist, L) / 1000).toFixed(1)} / ${(L / 1000).toFixed(1)} ${U.km} · ${fmtTime(ride.elapsed)}${best ? ` (${tr('best {time}', { time: fmtTime(best) })})` : ''}`;
  else $('progress-label').textContent = `${tr('Lap {n}', { n: Math.floor(ride.dist / L) + 1 })} · ${((ride.dist % L) / 1000).toFixed(1)} / ${(L / 1000).toFixed(0)} ${U.km} · ${fmtTime(ride.elapsed - ride.lapStartT)}${best ? ` (${tr('best {time}', { time: fmtTime(best) })})` : ''}`;
  if (ride.workout) {
    const done = Math.min(1, ride.workoutT / totalDuration(ride.workout));
    $('wk-name').textContent = ride.workout.name;
    $('wk-pct').textContent = ride.workoutDone ? tr('done') : `${Math.round(done * 100)}%`;
  }
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
  const maxW = Math.max(...w.steps.map((s) => Math.max(wattsOf(s, 0), wattsOf(s, 1)))) * 1.05;
  let x0 = 0;
  for (const s of w.steps) {
    const x1 = x0 + s.dur;
    const a = wattsOf(s, 0), b = wattsOf(s, 1);
    ctx.fillStyle = s.free ? '#64748b' : zoneColor(((a + b) / 2) / ftp);
    ctx.globalAlpha = t >= 0 && x1 <= t ? 0.45 : 1;
    ctx.beginPath();
    ctx.moveTo((x0 / total) * W, H);
    ctx.lineTo((x0 / total) * W, H - (a / maxW) * H);
    ctx.lineTo((x1 / total) * W, H - (b / maxW) * H);
    ctx.lineTo((x1 / total) * W, H);
    ctx.closePath();
    ctx.fill();
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
}

function finishRide() {
  if (!ride) return;
  advance();
  clearInterval(rideTimer);
  keepAwake(false);
  const sum = recorder.summary();
  const ghostGap = ride.ghost ? Math.round(ride.dist - ride.ghost.dist) : null;
  lastRide = { workout: ride.workout, route: ride.route, summary: sum, uploadedId: null, lapTimes: ride.lapTimes, efforts: ride.efforts, ramp: !!ride.workout?.ramp, ghostGap, ghostName: ride.ghost?.name };
  ride = null;
  if (trainer.connected && trainer.controllable) {
    trainer.setSimulation(0);
    if (settings.shiftMode === 'wheel') trainer.setWheelCircumference(BASE_WHEEL_MM);
  }
  const entry = sum && sum.duration >= 30 ? saveToHistory(lastRide, recorder.samples) : null;
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
  const every = 5, pw = [], hr = [], d = [];
  for (let i = 0; i < samples.length; i += every) {
    const chunk = samples.slice(i, i + every);
    const avg = (k) => { const v = chunk.map((x) => x[k] || 0).filter((x) => x > 0); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0; };
    pw.push(avg('power')); hr.push(avg('heartRate'));
    d.push(Math.round((chunk[chunk.length - 1].distance || 0) * 10) / 10); // distance at the end of each 5 s, for ghosts
  }
  return {
    id: `r${Date.now()}`, date: new Date().toISOString(), routeId: r.route?.id, routeName: r.route?.name,
    workoutName: r.workout?.name || null, ramp: r.ramp, ftp: settings.ftp, summary: r.summary,
    tss: r.summary ? tss(r.summary, settings.ftp) : 0, ghostGap: r.ghostGap ?? null, ghostName: r.ghostName || null, lapTimes: r.lapTimes || [], efforts: r.efforts || [], chart: { every, pw, hr, d },
  };
}

function saveToHistory(r, samples) {
  const e = historyEntry(r, samples);
  history.unshift(e);
  history = history.slice(0, 100);
  saveHistory();
  renderHistory();
  return e;
}

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
  for (const b of document.querySelectorAll('#ghost-box [data-ghost]')) {
    b.classList.toggle('sel', b.dataset.ghost === settings.ghost);
    b.onclick = () => { settings.ghost = b.dataset.ghost; saveSettings(); renderGhostPicker(); updateSummary(); };
  }
}

/** The ride summary screen, for the ride just finished (live: downloads available) or one from history. */
function showSummary(e, { live = false } = {}) {
  const sum = e.summary;
  $('lobby').hidden = true;
  $('summary').hidden = false;
  $('sum-kicker').textContent = live ? tr('Ride complete') : new Date(e.date).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  $('sum-name').textContent = [e.routeName, e.workoutName || tr('Free ride')].filter(Boolean).join(' · ');
  const hero = sum ? [
    [tr('Time'), fmtTime(sum.duration), ''],
    [tr('Distance'), (sum.distance / 1000).toFixed(2), U.km],
    [tr('Avg power'), sum.avgPower, U.W],
    [tr('Avg heart rate'), sum.avgHr || '—', sum.avgHr ? U.bpm : ''],
  ] : [[tr('Time'), '0:00', '']];
  $('sum-hero').innerHTML = hero.map(([k, v, u]) => `<div><label>${k}</label><b>${v}</b><span>${u}</span></div>`).join('');
  const chartSamples = e.chart.pw.map((p, i) => ({ power: p, heartRate: e.chart.hr[i] }));
  requestAnimationFrame(() => drawSummaryChart($('sum-chart'), chartSamples, 2, e.ftp || settings.ftp));
  const stats = sum ? [
    [tr('Elevation gain'), `${Math.round(sum.elevationGain)} ${U.m}`],
    ['NP', sum.normalizedPower ? `${sum.normalizedPower} ${U.W}` : '—'],
    ['TSS', e.tss || '—'],
    [tr('Max power'), `${sum.maxPower} ${U.W}`],
    [tr('Max heart rate'), sum.maxHr ? `${sum.maxHr} ${U.bpm}` : '—'],
    [tr('Avg cadence'), `${sum.avgCadence} ${U.rpm}`],
    [tr('Work'), `${sum.kj} ${tr('kJ')}`],
  ] : [];
  if (sum && e.ramp && sum.best1min) stats.push([tr('Estimated FTP'), `${Math.round(sum.best1min * 0.75)} ${U.W}`]);
  if (e.ghostGap !== null && e.ghostGap !== undefined) stats.push([tr('vs {name}', { name: e.ghostName || tr('ghost') }), `${e.ghostGap >= 0 ? '+' : '−'}${Math.abs(e.ghostGap)} ${U.m} ${e.ghostGap >= 0 ? '🏆' : ''}`]);
  $('sum-stats').innerHTML = stats.map(([k, v]) => `<div><label>${k}</label><b>${v}</b></div>`).join('');
  // laps and climbs of this ride, with personal bests
  const rows = [
    ...e.lapTimes.map((t, i) => [routes.find((x) => x.id === e.routeId)?.oneWay ? tr('Finish') : tr('Lap {n}', { n: i + 1 }), t, null]),
    ...e.efforts.map((x) => [x.name, x.time, x]),
  ];
  $('sum-segments').hidden = !rows.length;
  $('sum-seg-rows').innerHTML = rows.map(([name, t, x]) => {
    const pb = x ? x.pb : t <= (records.lap[e.routeId] ?? Infinity);
    const vs = x && x.best ? fmtDelta(t - x.best) : '';
    return `<tr><td>${esc(name)}</td><td>${fmtTime(t)}</td><td>${pb ? `<span class="pb">🏆 ${tr('best')}</span>` : vs}</td></tr>`;
  }).join('');
  // files and intervals.icu only for the ride just finished (older rides keep a summary, not the full record)
  for (const id of ['btn-download', 'btn-download-tcx']) { $(id).hidden = !live; $(id).disabled = !sum; }
  document.querySelector('#summary .hint:last-of-type').hidden = !live;
  const canUpload = !!(live && icuClient && sum && sum.duration >= 60);
  $('btn-icu-upload').hidden = !canUpload;
  $('btn-icu-upload').disabled = false;
  $('btn-icu-upload').textContent = tr('Upload to intervals.icu');
  $('icu-upload-status').hidden = true;
  $('btn-delete-ride').hidden = live;
  $('btn-delete-ride').dataset.id = e.id;
  $('btn-delete-ride').textContent = tr('Delete ride');
  scheduleUpload(canUpload);
}

/** Recent rides in the lobby (latest five) and the full list in the drawer. */
function renderHistory() {
  const row = (e) => {
    const s = e.summary || {};
    const day = new Date(e.date).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
    return `<button class="hist-row" data-id="${e.id}"><span class="hist-date">${day}</span><span class="hist-name"><b>${esc(e.routeName || '')}</b><small>${esc(e.workoutName || tr('Free ride'))}</small></span><span class="hist-nums"><b>${fmtTime(s.duration || 0)}</b><small>${((s.distance || 0) / 1000).toFixed(1)} ${U.km}</small></span><span class="hist-nums"><b>${s.normalizedPower || s.avgPower || 0} ${U.W}</b><small>TSS ${e.tss || 0}</small></span></button>`;
  };
  $('history-recent').innerHTML = history.slice(0, 5).map(row).join('');
  $('history-box').hidden = !history.length;
  $('history-all').innerHTML = history.length ? history.map(row).join('') : `<p class="muted">${tr('No rides yet. Finished rides show up here.')}</p>`;
  const week = history.filter((e) => Date.now() - Date.parse(e.date) < 7 * 864e5);
  $('history-week').textContent = week.length ? `${tr('This week')}: ${week.length} ${lang === 'uk' ? plural(week.length, ['заїзд', 'заїзди', 'заїздів']) : `ride${week.length > 1 ? 's' : ''}`} · ${fmtTime(week.reduce((a, e) => a + (e.summary?.duration || 0), 0))} · TSS ${week.reduce((a, e) => a + (e.tss || 0), 0)}` : '';
  for (const b of document.querySelectorAll('.hist-row')) {
    b.onclick = () => { $('drawer').hidden = true; const e = history.find((x) => x.id === b.dataset.id); if (e) showSummary(e); };
  }
}

/** Power (filled, smoothed over 10 s) and heart rate (line) over the whole ride. */
function drawSummaryChart(canvas, samples, smoothN = 10, ftp = settings.ftp) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  if (!samples.length) return;
  const smooth = (k, n) => samples.map((_, i) => {
    let a = 0, c = 0;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) { const v = samples[j][k] || 0; if (v > 0) { a += v; c++; } }
    return c ? a / c : 0;
  });
  const pw = smooth('power', smoothN), hr = smooth('heartRate', Math.max(1, Math.round(smoothN / 2)));
  const pMax = Math.max(ftp * 1.3, ...pw), hMax = Math.max(190, ...hr);
  const x = (i) => (i / Math.max(1, samples.length - 1)) * w;
  // FTP reference line
  const yF = h - (ftp / pMax) * (h - 8);
  g.strokeStyle = 'rgba(255,255,255,.18)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(0, yF); g.lineTo(w, yF); g.stroke(); g.setLineDash([]);
  g.fillStyle = 'rgba(255,255,255,.4)'; g.font = '11px system-ui'; g.fillText(`FTP ${ftp} W`, 6, yF - 4);
  g.beginPath(); g.moveTo(0, h);
  pw.forEach((v, i) => g.lineTo(x(i), h - (v / pMax) * (h - 8)));
  g.lineTo(w, h); g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(255,194,26,.85)'); grad.addColorStop(1, 'rgba(255,194,26,.15)');
  g.fillStyle = grad; g.fill();
  if (hr.some((v) => v > 0)) {
    g.strokeStyle = '#ff4d5e'; g.lineWidth = 2; g.beginPath();
    let started = false;
    hr.forEach((v, i) => { if (!v) return; const y = h - (v / hMax) * (h - 8); started ? g.lineTo(x(i), y) : g.moveTo(x(i), y); started = true; });
    g.stroke();
  }
}

function download(kind) {
  const d = recorder.startTime || new Date();
  const fit = kind === 'fit';
  const blob = fit ? new Blob([recorder.toFIT()], { type: 'application/vnd.ant.fit' }) : new Blob([recorder.toTCX()], { type: 'application/vnd.garmin.tcx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `powerup-${d.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${fit ? 'fit' : 'tcx'}`;
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
    icuClient = client;
    settings.icuKey = key;
    settings.icuAthlete = $('f-icu-athlete').value.trim();
    if (athlete.ftp) { settings.ftp = athlete.ftp; $('f-ftp').value = athlete.ftp; }
    if (athlete.weight) { settings.weight = Math.round(athlete.weight); $('f-weight').value = settings.weight; }
    if (!quiet && icuWorkouts.length) settings.mode = icuWorkouts[0].id;
    saveSettings();
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

function forgetIntervals() {
  icuClient = null;
  icuWorkouts = [];
  settings.icuKey = '';
  settings.icuAthlete = '';
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
  const start = () => { if (lastRide?.uploadedId || uploadTimer) return; left = 10; uploadTimer = setInterval(tick, 1000); tick(); };
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
  if (!icuClient || !lastRide?.summary || lastRide.uploadedId) return;
  const status = $('icu-upload-status');
  const btn = $('btn-icu-upload');
  status.hidden = false;
  status.textContent = tr('Uploading to intervals.icu…');
  btn.disabled = true;
  const { workout, route, summary: sum } = lastRide;
  const fromIcu = workout?.source === 'intervals';
  const name = workout ? `Gruppetto: ${workout.name}` : `Gruppetto: ${route.name}`;
  const description = `${route.name} · ${(sum.distance / 1000).toFixed(1)} km · avg ${sum.avgPower} W · NP ${sum.normalizedPower || '—'} W`;
  try {
    const id = await icuClient.uploadActivity(recorder.toFIT(), {
      name, description, eventId: fromIcu ? workout.eventId : undefined, filename: `powerup-${Date.now()}.fit`,
    });
    lastRide.uploadedId = id || true;
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
$('f-pacer').checked = settings.pacer !== false;
$('f-pacer-name').value = settings.pacerName || '';
$('f-pacer-name').oninput = () => {
  settings.pacerName = $('f-pacer-name').value; saveSettings();
  if (ride?.pacer) ride.pacer.name = settings.pacerName.trim() || tr('Pacer');
};
$('btn-settings').onclick = () => openDrawer('profile');
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
  if (!ride?.workout || ride.workoutDone) return;
  ride.ergOff = !ride.ergOff;
  ride.lastSentTarget = null; ride.lastSentGrade = null; ride.lastSentWheel = null;
  ride.ergFactor = 1; ride.lowFor = 0;
  $('wk-erg-btn').classList.toggle('on', !ride.ergOff);
  updateGear();
  toast(ride.ergOff ? tr('ERG off: the trainer simulates the road, ride to the target by feel') : tr('ERG on: the trainer holds the target power'));
}
function togglePacer() {
  // in a workout the workout pacer, on a free ride the free-ride pacer
  const key = ride && !ride.workout ? 'freePacer' : 'pacer';
  settings[key] = !(key === 'pacer' ? settings.pacer !== false : settings.freePacer);
  saveSettings();
  $('f-pacer').checked = settings.pacer !== false;
  $('f-free-pacer').checked = !!settings.freePacer;
  $('wk-pacer-btn').classList.toggle('on', settings.pacer !== false);
  const on = settings[key];
  if (ride?.pacer && on) { ride.pacer.dist = ride.dist; ride.pacer.v = ride.v; ride.pacer.waitAt = null; } // rejoin beside you
  const who = settings.pacerName?.trim() || tr('Pacer');
  toast(on ? tr('{name} is riding with you', { name: who }) : tr('{name} dropped back', { name: who }));
  updateSummary();
}

/** The pacer is out on the road: the workout pacer in a workout, the free-ride pacer otherwise. */
function pacerOn() {
  if (!ride?.pacer) return false;
  return ride.pacer.free ? !!settings.freePacer : settings.pacer !== false;
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
$('f-sound').checked = !!settings.sound;
$('f-sound').onchange = () => {
  settings.sound = settings.voice = $('f-sound').checked;
  saveSettings();
  if (settings.sound) { unlockAudio(); beep(880, 0.1); }
};
$('btn-download-tcx').onclick = () => download('tcx');
$('btn-again').onclick = () => { flushUpload(); $('summary').hidden = true; $('lobby').hidden = false; renderHistory(); showRoute(); };
$('btn-delete-ride').onclick = () => {
  const b = $('btn-delete-ride');
  if (b.textContent !== tr('Tap again to delete')) { b.textContent = tr('Tap again to delete'); return; }
  history = history.filter((e) => e.id !== b.dataset.id);
  saveHistory();
  renderHistory();
  $('summary').hidden = true; $('lobby').hidden = false;
};
$('sim-power').oninput = () => { $('sim-val').textContent = $('sim-power').value; };
// ---------- Virtual gears & controller actions ----------

const BUTTON_LABELS = {
  shiftUpL: 'left shift up (gear +)', shiftDownL: 'left shift down (gear −)', shiftUpR: 'right shift up (gear +)', shiftDownR: 'right shift down (gear −)',
  paddleL: 'left paddle', paddleR: 'right paddle',
  up: '▲', down: '▼', left: '◀', right: '▶', a: 'A (ERG on/off)', b: 'B (pause)', y: 'Y (camera)', z: 'Z (skip interval)',
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

/** Chase → isometric → side view (C, or Z on the Zwift Ride). */
function nextCamera() {
  if (!scene?.setCamera) return;
  const order = ['chase', 'iso', 'side'];
  settings.camera = order[(order.indexOf(settings.camera) + 1) % order.length];
  saveSettings();
  scene.setCamera(settings.camera);
  $('f-camera').value = settings.camera;
  toast(tr({ chase: 'Camera: chase', iso: 'Camera: isometric', side: 'Camera: side view' }[settings.camera]));
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
    case 'hud': $('ride').classList.toggle('hud-hidden'); break;
    default: break;
  }
}

/** Sends the virtual gear as a wheel circumference; falls back to grade offsets if the trainer refuses. */
function sendVirtualGear() {
  if (ride.gear === ride.lastSentWheel || ride.wheelPending) return;
  const gear = ride.gear;
  ride.wheelPending = true;
  trainer.setWheelCircumference(virtualWheelMm(gear, settings.chainring)).then((ok) => {
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

function setGear(gear) {
  if (!ride || inErgStep()) return;
  const g = Math.max(1, Math.min(GEARS, Math.round(gear)));
  if (g !== ride.gear) shift(g - ride.gear);
}

function shift(dir) {
  if (!ride || ride.paused) return;
  if (inErgStep()) {
    // in ERG the shifters move the workout's intensity, 1 % a click (the on-screen − / + do 5 %)
    changeIntensity(Math.sign(dir));
    toast(`${tr('Intensity')} ${settings.intensity}% · ${effectiveTarget()} ${U.W}`);
  } else {
    const next = Math.max(1, Math.min(GEARS, ride.gear + dir));
    if (next === ride.gear) return;
    ride.gear = next;
    ride.lastSentGrade = null; // send the new resistance on the next tick
    if (ride.simulated) {
      const s = $('sim-power');
      s.value = Number(s.value) + dir * 10;
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
  if (!ride?.workout || ride.workoutDone) return;
  const t = targetAt(ride.workout, Math.max(0, ride.workoutT - 1), settings.ftp);
  if (!t) return;
  ride.workoutT = Math.max(0, ride.workoutT - 1) + t.remaining;
  toast(tr('Interval skipped ⏭'));
}

function updateGear() {
  if (!ride) return;
  const inErg = inErgStep();
  $('m-gear-label').textContent = inErg ? 'ERG' : tr('Gear');
  $('m-gear').textContent = inErg ? settings.intensity : ride.gear; // in ERG: the intensity the shifters move
  $('m-gear-unit').textContent = inErg ? '%' : `/${GEARS} · ${ratioOf(ride.gear).toFixed(2)}`;
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
}

window.addEventListener('keydown', (e) => {
  if (!ride) return;
  // settings open, or typing in a field: the keys belong to them, not to the ride
  if (!$('drawer').hidden || e.target.closest?.('input, select, textarea')) return;
  if (e.code === 'Escape') {
    if ($('ride').classList.contains('show-controls')) hideControls();
    else { showControls(0); $('btn-pause').focus(); }
  }
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  if (e.code === 'BracketRight') shift(+1);
  if (e.code === 'BracketLeft') shift(-1);
  if (e.code === 'ArrowLeft') { e.preventDefault(); steer(-1); }
  if (e.code === 'ArrowRight') { e.preventDefault(); steer(+1); }
  if (e.code === 'KeyN') skipInterval();
  if (e.code === 'KeyP' && ride.pacer) togglePacer();
  if (e.code === 'KeyE') toggleErg();
  if (e.code === 'KeyC') nextCamera();
  if (ride.simulated && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
    e.preventDefault();
    const s = $('sim-power');
    s.value = Number(s.value) + (e.code === 'ArrowUp' ? 10 : -10);
    s.oninput();
  }
});

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
