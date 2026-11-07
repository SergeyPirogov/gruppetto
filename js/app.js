import { WIND_CW, bluetoothAvailable, setShowAllDevices, knownDevices, Trainer, HeartRateMonitor, CadenceSensor, ZwiftController, OpenBikeControlDevice } from './ble.js';
import { obcIntents, rideIntent, OBC_LABELS } from './controls.js';
import { IntervalsClient, activityUrl, localDate } from './intervals.js';
import { stepSpeed, draftFactor, DEFAULTS, riderCdA } from './physics.js';
import { routes, Route, ROUTE_GROUPS } from './routes.js';
import { parseGpx, routeFromTrack } from './gpx.js';
import { workouts, targetAt, totalDuration, stepWatts, zoneColor, powerZone } from './workouts.js';
import { Recorder } from './recorder.js';
import { Sampler } from './sampler.js';
import { unlockAudio, beep, say, spokenDuration } from './sound.js';
import { Scene, drawProfile } from './render.js';
import { themeFor } from './themes.js';
import { GEARS, DEFAULT_GEAR, ratioOf, virtualWheelMm, gearGradeOffset, BASE_WHEEL_MM } from './gears.js';

const $ = (id) => document.getElementById(id);

// ---------- Settings ----------
const DEFAULT_SETTINGS = {
  name: 'Me', weight: 75, height: 178, ftp: 200, difficulty: 50, routeId: 'rolling', mode: 'free',
  icuKey: '', icuAthlete: '', icuUpload: true,
  chainring: 34, shiftMode: 'wheel', graphics: '3d',
  jersey: '#16a0a8', stripe: '#ff8a1f',
  intensity: 100, sound: true, voice: true, pacer: true, pacerName: 'Pacer', ghost: 'best', style: 'cartoon', camera: 'chase',
};
let settings = { ...DEFAULT_SETTINGS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('powerup.settings') || '{}')); } catch { /* storage unavailable */ }
// ?debug: reach the current ride from devtools (jump along the route when testing laps and climbs)
if (new URLSearchParams(location.search).has('debug')) Object.defineProperty(window, '__ride', { get: () => ride });

// personal bests on this device: { lap: {routeId: seconds}, seg: {climbId: seconds} }
const records = (() => { try { return JSON.parse(localStorage.getItem('gruppetto.records') || '{}'); } catch { return {}; } })();
records.lap ||= {}; records.seg ||= {};
// routes imported from GPX (#25), kept on this device as plain data
const ROUTES_KEY = 'gruppetto.routes';
const customDefs = (() => { try { return JSON.parse(localStorage.getItem(ROUTES_KEY) || '[]'); } catch { return []; } })();
for (const d of customDefs) { try { routes.push(new Route(d)); } catch { /* skip a broken entry */ } }
const saveCustomRoutes = () => {
  try { localStorage.setItem(ROUTES_KEY, JSON.stringify(customDefs)); return true; } catch { return false; }
};
const saveRecords = () => { try { localStorage.setItem('gruppetto.records', JSON.stringify(records)); } catch { /* ignore */ } };
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
  { dev: trainer, key: 'trainer', lost: 'Trainer disconnected' },
  { dev: hrm, key: 'hr', lost: 'Heart rate monitor disconnected' },
  { dev: cadenceSensor, key: 'cad', lost: 'Cadence sensor disconnected' },
  { dev: controller, key: 'ctl', lost: 'Controller disconnected' },
  { dev: obc, key: 'obc', lost: 'OpenBikeControl disconnected' },
];
const TRAINER_PROTOCOL = { ftms: 'FTMS', wahoo: 'Wahoo', power: 'power meter' };
let lastButtonLabel = '';
let lastObcLabel = '';

const reconnecting = new Map(); // key -> attempt number

for (const d of DEVICES) {
  d.dev.addEventListener('disconnect', () => { updateDeviceUI(); toast(`${d.lost} — reconnecting…`); });
  d.dev.addEventListener('reconnecting', ({ detail: n }) => { reconnecting.set(d.key, n); updateDeviceUI(); });
  d.dev.addEventListener('reconnected', () => {
    reconnecting.delete(d.key);
    if (d.dev === trainer) resyncTrainer();
    updateDeviceUI();
    toast(`${d.dev.name}: connection restored ✓`);
  });
  d.dev.addEventListener('reconnect-failed', () => {
    reconnecting.delete(d.key);
    updateDeviceUI();
    toast(`${d.dev.name}: could not reconnect — press “Connect” in the lobby`);
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
  if (reconnecting.has(d.key)) return `${d.dev.name} · connection lost, reconnecting (attempt ${reconnecting.get(d.key)})…`;
  if (d.dev === cadenceSensor && !d.dev.connected && trainer.connected) {
    // no separate sensor: cadence comes from the trainer automatically
    if (trainer.sendsCadence) return `from trainer · ${Math.round(fresh(live.cadence, live.cadAt))} rpm`;
    return 'from trainer · start pedaling (if cadence stays at 0, connect a separate sensor)';
  }
  if (!d.dev.connected) return 'not connected';
  if (d.dev === trainer) {
    const resistance = trainer.controllable ? 'resistance: controlled by the app ✓' : 'data only, no resistance control';
    return `${trainer.name} · ${TRAINER_PROTOCOL[trainer.protocol] || ''} · ${resistance} · ${Math.round(fresh(live.power, live.powerAt))} W`;
  }
  if (d.dev === controller || d.dev === obc) {
    const label = d.dev === obc ? lastObcLabel : lastButtonLabel;
    const units = d.dev === controller && controller.count > 1 ? ` ×${controller.count}` : '';
    const hint = d.dev === controller && controller.count === 1 && /ride/i.test(controller.name)
      ? ' · second controller: “+ controller”' : '';
    return `${d.dev.name}${units}${label ? ` · pressed: ${label}` : ' · press any button'}${hint}`;
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
    btn.textContent = d.dev.connected ? 'Disconnect' : viaTrainer ? 'Change' : 'Connect';
    btn.title = viaTrainer ? 'Connect a separate cadence sensor instead of the trainer' : '';
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
    $(`${d.key}-status`).textContent = 'connecting remembered device…';
    const ok = await reopenRemembered(d);
    if (ok && d.dev === trainer) $('sim').checked = false;
    updateDeviceUI();
  }
}

async function toggleDevice(d, { add = false } = {}) {
  const btn = add ? $('btn-ctl-add') : $(`btn-${d.key}`);
  if (!add && (d.dev.connected || reconnecting.has(d.key))) { d.dev.disconnect(); reconnecting.delete(d.key); forgetDevice(d); updateDeviceUI(); return; }
  btn.disabled = true;
  btn.textContent = 'Searching…';
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
    if (add) btn.textContent = '+ controller';
    updateDeviceUI();
    if (error) {
      const noService = error.name === 'NotFoundError' || /service|characteristic/i.test(error.message);
      $(`${d.key}-status`).textContent = noService && $('show-all').checked
        ? 'This device does not have the required service — choose another one'
        : `Could not connect: ${error.message}`;
    }
  }
}

// ---------- Lobby ----------
function initLobby() {
  // Bluetooth works but Chrome can't reopen remembered sensors without its permissions flag
  if (bluetoothAvailable() && !navigator.bluetooth.getDevices) {
    $('autoconnect-hint').hidden = false;
    $('copy-flag').onclick = async () => {
      try { await navigator.clipboard.writeText('chrome://flags/#enable-web-bluetooth-new-permissions-backend'); $('copy-flag').textContent = 'Copied — paste it in the address bar'; } catch { /* clipboard blocked */ }
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
    el.oninput = () => { settings[key] = num ? Number(el.value) : el.value; saveSettings(); refreshDiff(); };
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
    sec.innerHTML = `<h3>${g.name}<small>${list.length || ''}</small></h3><div class="options route-cards"></div>`;
    const box = sec.querySelector('.route-cards');
    for (const r of list) {
      const b = document.createElement('button');
      b.className = 'option';
      b.dataset.id = r.id;
      b.innerHTML = `<b>${esc(r.name)}</b><small>${(r.length / 1000).toFixed(r.custom ? 1 : 0)} km · ↗ ${Math.round(r.elevationGain)} m</small><small>${esc(r.description)}</small><canvas></canvas>`
        + (r.custom ? `<span class="rc-del" title="Delete this route" role="button">✕</span>` : '');
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
      add.innerHTML = '<b>＋ Import GPX</b><small>A real road from Strava, Komoot or Garmin, up to 150 km</small>';
      add.htmlFor = 'gpx-file';
      box.append(add);
    }
    rl.append(sec);
  }
  markRoute();
}

function markRoute() {
  for (const el of $('route-list').querySelectorAll('.option[data-id]')) el.classList.toggle('sel', el.dataset.id === settings.routeId);
}

async function importGpx(ev) {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const def = routeFromTrack(parseGpx(await file.text()), file.name);
    const route = new Route(def);
    customDefs.push(def);
    if (!saveCustomRoutes()) { customDefs.pop(); throw new Error('Not enough browser storage for this route'); }
    routes.push(route);
    settings.routeId = route.id; saveSettings();
    renderRouteList(); showRoute();
    $('route-list').querySelector('.sel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (e) {
    alertBox(`Could not import ${file.name}: ${e.message}`);
  }
}

function deleteCustomRoute(r) {
  if (!confirm(`Delete “${r.name}”? Its records stay in your ride history.`)) return;
  const i = customDefs.findIndex((d) => d.id === r.id);
  if (i >= 0) customDefs.splice(i, 1);
  saveCustomRoutes();
  routes.splice(routes.indexOf(r), 1);
  if (settings.routeId === r.id) { settings.routeId = routes[0].id; saveSettings(); }
  renderRouteList(); showRoute();
}

function alertBox(msg) {
  const el = $('lobby-msg');
  el.textContent = msg; el.hidden = false;
  clearTimeout(alertBox.t); alertBox.t = setTimeout(() => { el.hidden = true; }, 6000);
}

const allWorkouts = () => [...icuWorkouts, ...workouts];

/** Mode: free ride, or a workout picked in its own menu. */
function renderModes() {
  const ml = $('mode-list');
  ml.innerHTML = '';
  const w = allWorkouts().find((x) => x.id === settings.mode)
    || allWorkouts().find((x) => x.id === settings.lastWorkout) || null;
  const free = document.createElement('button');
  free.className = 'option';
  free.dataset.id = 'free';
  free.innerHTML = '<b>Free ride</b><small>The trainer simulates the road grade.</small>';
  free.onclick = () => { settings.mode = 'free'; saveSettings(); renderModes(); };
  const wb = document.createElement('button');
  wb.className = 'option wk-pick';
  wb.dataset.id = 'workout';
  wb.innerHTML = w
    ? `<span class="wk-pick-head"><b>${esc(w.name)}</b><span class="wk-change">Workouts ›</span></span><small>${Math.round(totalDuration(w) / 60)} min · ${esc(w.description)}</small><canvas></canvas>`
    : '<span class="wk-pick-head"><b>Workout</b><span class="wk-change">Choose ›</span></span><small>Structured intervals in ERG: the trainer holds the target power.</small>';
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
    b.innerHTML = `${tag ? `<span class="tag">intervals.icu · ${esc(tag)}</span>` : ''}<b>${esc(w.name)}</b><small>${Math.round(totalDuration(w) / 60)} min · ${esc(w.description)}</small><canvas></canvas>`;
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
  $('rh-meta').textContent = `${(r.length / 1000).toFixed(r.custom ? 1 : 0)} km · ↗ ${Math.round(r.elevationGain)} m`;
  $('rh-desc').textContent = r.description;
  renderGhostPicker();
  // the timed climbs, with this device's record on each
  $('rh-climbs').innerHTML = r.climbs.map((c) => `<li><b>⛰ ${esc(c.name)}</b> ${(c.length / 1000).toFixed(1)} km · ${(c.grade * 100).toFixed(1)}%${records.seg[c.id] ? ` · <span class="pb">🏆 ${fmtTime(records.seg[c.id])}</span>` : ''}</li>`).join('')
    + (records.lap[r.id] ? `<li><b>⏱ ${r.oneWay ? 'Best time' : 'Best lap'}</b> <span class="pb">${fmtTime(records.lap[r.id])}</span></li>` : '');
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
  el.textContent = [r?.name, sel?.textContent, g ? `👻 ${settings.ghost === 'last' ? 'last ride' : 'your best'}` : null].filter(Boolean).join(' · ');
}

/** Side drawer with Devices, Profile and intervals.icu, opened from the top bar. */
function initDrawer() {
  const drawer = $('drawer');
  const open = (panel) => {
    drawer.hidden = false;
    for (const c of drawer.querySelectorAll('[data-panel]')) c.hidden = c.dataset.panel !== panel;
    for (const t of drawer.querySelectorAll('.drawer-tabs [data-open]')) t.classList.toggle('sel', t.dataset.open === panel);
  };
  for (const el of document.querySelectorAll('#lobby [data-open]')) el.addEventListener('click', () => open(el.dataset.open));
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
const BOTS = [
  { name: 'Andriy', wkg: 2.2, color: '#e5484d', stripe: '#ffffff' },
  { name: 'Taras', wkg: 2.7, color: '#2563eb', stripe: '#facc15' },
  { name: 'Dmytro', wkg: 3.1, color: '#8b5cf6', stripe: '#f0f0f0' },
  { name: 'Bohdan', wkg: 3.6, color: '#f5f5f5', stripe: '#16a34a' },
];
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
      toast('3D graphics are not available in this browser — using 2D');
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
    bots: BOTS.map((b, i) => ({ ...b, dist: 15 + i * 12, v: 0, pedal: i, lane: i % 2 ? -1.6 : 1.6, home: i % 2 ? -1.6 : 1.6, laneTarget: i % 2 ? -1.6 : 1.6 })),
    // workout pacer: a virtual training partner riding the target power exactly, at your weight
    ghost: (() => { const g = pickGhost(route.id); return g ? { entry: g, name: settings.ghost === 'last' ? 'Last ride' : 'Your best', color: settings.jersey, stripe: settings.stripe, dist: 0, pedal: 0.3, lane: START_LANE - 1.3, ghost: true } : null; })(),
    pacer: workout ? { name: settings.pacerName?.trim() || 'Pacer', color: '#facc15', stripe: '#111827', dist: 0, v: 0, pedal: 0.5, lane: -0.5, pacer: true } : null,
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
  $('paused').hidden = true;
  $('btn-pause').textContent = 'Pause';
  $('ride').classList.remove('show-controls');
  await ensureScene();
  scene.setStyle?.(settings.style);
  scene.setCamera?.(settings.camera);
  ride.lastSim = performance.now();
  clearInterval(rideTimer);
  rideTimer = setInterval(() => advance(), 250);
  keepAwake(true);
  if (simulated) toast('Simulator mode: set power with the slider or ↑/↓');
  if (scene.orbit) setTimeout(() => toast('Camera: drag to orbit, scroll to zoom, double-click to reset'), simulated ? 3500 : 0);
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
    toast(`No data from the trainer for ${Math.round(left)} s — this gap was skipped`);
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
    const pack = [...ride.bots, ...(ride.pacer && settings.pacer ? [ride.pacer] : [])];
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
    ride.pedal += (animCadence / 60) * Math.PI * 2 * dt;
    ride.lane = ride.autoLane ? easeLane(ride.lane, ride.laneTarget, dt, ride) : ride.lane + (ride.laneTarget - ride.lane) * Math.min(1, dt * 4);
    if (ride.ghost) {
      const G = ride.ghost, before = G.dist;
      G.dist = ghostDistAt(G.entry, ride.elapsed + dt);
      G.power = G.entry.chart.pw[Math.min(G.entry.chart.pw.length - 1, Math.floor((ride.elapsed + dt) / G.entry.chart.every))] || 0;
      G.pedal += ((G.dist > before ? 88 : 0) / 60) * Math.PI * 2 * dt;
    }
    if (ride.pacer) {
      const P = ride.pacer, target = ride.workoutDone ? null : effectiveTarget();
      const pw = target ?? Math.round(settings.ftp * 0.55); // easy spin once the workout is over
      P.v = stepSpeed(P.v, pw, route.gradeAt(P.dist), dt, settings.weight, { cda: ride.cda }); // your size, your drag
      P.power = pw;
      P.dist += P.v * dt;
      P.pedal += (90 / 60) * Math.PI * 2 * dt;
      // rides beside you, on the side with more room; switches sides only well past the centre line
      P.side = ride.lane > 0.6 ? -1 : ride.lane < -0.6 ? 1 : (P.side || (ride.lane > 0 ? -1 : 1));
      P.lane = easeLane(P.lane, ride.lane + 1.4 * P.side, dt, P);
    }
    // overtaking: a rider closing on someone in the same lane swings out to a free one, then back
    if ((ride.laneCheck = (ride.laneCheck || 0) + dt) > 0.25) {
      ride.laneCheck = 0;
      const solid = [{ dist: ride.dist, lane: ride.lane, laneTarget: ride.laneTarget, v: ride.v, vFree: ride.vFree, me: true }, ...ride.bots, ...(ride.pacer && settings.pacer ? [ride.pacer] : [])];
      for (const b of ride.bots) b.laneTarget = pickLane(b, solid, b.home);
      if (!ride.steeredAt || ride.elapsed - ride.steeredAt > 4) { // unless you steered yourself just now
        const me = solid[0], t = pickLane(me, solid, ride.laneHome ?? START_LANE);
        if (t !== ride.laneTarget) { ride.laneTarget = t; ride.autoLane = true; }
      }
    }
    for (const b of ride.bots) b.lane = easeLane(b.lane, b.laneTarget, dt, b);
    for (const b of ride.bots) {
      const g = route.gradeAt(b.dist);
      const p = b.wkg * 75 * (1 + Math.max(-0.6, Math.min(0.35, g * 4)));
      b.power = p;
      const wheels = [{ dist: ride.dist, lane: ride.lane }, ...ride.bots.filter((o) => o !== b)];
      const bd = Math.max(0, ...wheels.map((o) => draftFactor(o.dist - b.dist, o.lane - b.lane)));
      b.v = stepSpeed(b.v, p, g, dt, 75, { cda: DEFAULTS.cda * (1 - bd) });
      b.vFree = stepSpeed(b.vFree ?? b.v, p, g, dt, 75, { cda: DEFAULTS.cda });
      for (const o of wheels) if (Math.abs(o.lane - b.lane) < 0.8) b.v = Math.min(b.v, wheelCap(o.dist - b.dist, o === wheels[0] ? ride.v : o.v));
      b.dist += b.v * dt;
      b.pedal += (90 / 60) * Math.PI * 2 * dt;
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
    ...(ride.pacer && settings.pacer ? [ride.pacer] : []),
    ...(ride.ghost ? [ride.ghost] : []),
  ];
  scene.render(ride.route, ride.dist, riders, ride.moved);
  ride.moved = 0;
  requestAnimationFrame(frame);
}

/** Riders ahead you could reach within 10 s at your speed: name, gap in seconds and metres, their W/kg. */
function updateAhead() {
  const v = Math.max(ride.v, 2), all = [...ride.bots, ...(ride.pacer && settings.pacer ? [ride.pacer] : []), ...(ride.ghost ? [ride.ghost] : [])];
  const ahead = all
    .map((r) => ({ r, gap: r.dist - ride.dist }))
    .filter(({ gap }) => gap > 0.5 && gap / v <= 10)
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 4);
  $('ahead').hidden = !ahead.length;
  $('ahead-rows').innerHTML = ahead.map(({ r, gap }) => {
    const wkg = r.wkg ?? (r.power ? r.power / settings.weight : 0);
    return `<div class="ahead-row"><i style="background:${esc(r.color)};box-shadow:0 0 0 2px ${esc(r.stripe || '#fff')}"></i><b>${esc(r.ghost ? `👻 ${r.name}` : r.name)}</b><span>+${(gap / v).toFixed(1)}s</span><small>${Math.round(gap)} m${wkg ? ` · ${wkg.toFixed(1)} W/kg` : ''}</small></div>`;
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
      toast(!best ? `Finish! ${fmtTime(t)} 🏁` : t < best ? `Finish! ${fmtTime(t)} — new record! (${fmtDelta(t - best)}) 🏆` : `Finish! ${fmtTime(t)} (${fmtDelta(t - best)} vs best)`);
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
      toast(best ? `Lap ${laps}: ${fmtTime(t)} — new best lap! (${fmtDelta(t - best)}) 🏆` : `Lap ${laps}: ${fmtTime(t)} — first lap on this route 🎉`);
    } else toast(`Lap ${laps}: ${fmtTime(t)} (${fmtDelta(t - best)} vs best)`);
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
        else if (t.watts === null) toast('Free segment — ride by feel');
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
      toast('Workout complete! Free ride from here 🏁');
      updateGear();
      if (ride.simulated) $('sim-power').value = Math.round(settings.ftp * 0.5);
    }
  }
  updateSpiralGuard(power, cadence);
  if (!ride.simulated && trainer.controllable) {
    if (ride.target !== null && ride.workout && !ride.workoutDone) {
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
  $('m-wkg').textContent = `${(p3 / settings.weight).toFixed(1)} W/kg`;
  // power zone: the board's bar and a Z1–Z7 tag take the zone's colour (in a workout the number itself
  // shows how close you are to the target, below)
  const zone = powerZone(p3 / Math.max(1, settings.ftp));
  const powerRow = document.querySelector('.stat.power');
  powerRow.style.setProperty('--c', zone.color);
  $('m-zone').textContent = `Z${zone.z}`;
  $('m-zone').style.background = zone.color;
  $('m-zone').title = zone.name;
  if (!ride.workout || ride.workoutDone) $('m-power').style.color = p3 > 0 ? zone.color : '';
  else $('m-power').style.color = '';
  $('m-cad').textContent = Math.round(cadence);
  $('m-hr').textContent = hr ? Math.round(hr) : '—';
  const A = ride.avg;
  $('m-hr-avg').textContent = A?.hrN ? `avg ${Math.round(A.hr / A.hrN)}` : '';
  $('m-cad-avg').textContent = A?.cadN ? `avg ${Math.round(A.cad / A.cadN)}` : '';
  $('m-speed').textContent = (ride.v * 3.6).toFixed(1);
  updateAhead();
  const df = ride.draft || 0;
  $('draft-tag').hidden = df < 0.03;
  if (df >= 0.03) {
    $('draft-tag').textContent = `🌀 Drafting · −${Math.round(df * 100)}% drag`;
    $('draft-tag').style.setProperty('--d', df / 0.33);
  }
  if (ride.ghost) {
    const G = ride.ghost, gap = ride.dist - G.dist, tg = ghostTimeAt(G.entry, ride.dist);
    const secs = tg === null ? null : Math.round(tg - ride.elapsed); // + = you got here sooner
    $('ghost-tag').hidden = false;
    $('ghost-tag').className = `ghost-tag ${gap >= 0 ? 'c-ok' : 'c-bad'}`;
    $('ghost-tag').textContent = `👻 ${G.name}: ${Math.abs(gap) < 2 ? 'level' : `${Math.round(Math.abs(gap))} m ${gap > 0 ? 'ahead' : 'behind'}`}${secs !== null && Math.abs(gap) >= 2 ? ` · ${secs >= 0 ? '−' : '+'}${fmtTime(Math.abs(secs))}` : ''}`;
  } else $('ghost-tag').hidden = true;
  $('m-dist').textContent = (ride.dist / 1000).toFixed(2);
  $('m-time').textContent = fmtTime(ride.elapsed);
  $('m-gain').textContent = Math.round(ride.gain);
  updateProgress();
  const gEl = $('grade');
  gEl.textContent = `${grade >= 0 ? '' : '−'}${Math.abs(grade * 100).toFixed(1)}%`;
  gEl.style.color = grade > 0.06 ? '#ef4444' : grade > 0.03 ? '#f97316' : grade < -0.02 ? '#60a5fa' : '#e8edf5';

  if (ride.workout) {
    const t = targetAt(ride.workout, Math.max(0, ride.workoutT - 1), settings.ftp);
    const target = ride.workoutDone ? null : ride.target;
    const tEl = $('wk-target');
    tEl.textContent = ride.workoutDone ? '—' : target ?? 'free';
    // compliance: green within ±5 %, amber within ±10 %, red beyond
    const dev = target ? (p3 - target) / target : 0;
    const cls = !target ? '' : Math.abs(dev) <= 0.05 ? 'c-ok' : Math.abs(dev) <= 0.1 ? 'c-warn' : 'c-bad';
    tEl.className = cls;
    $('m-power').className = cls;
    const P = ride.pacer;
    $('wk-pacer').hidden = !(P && settings.pacer);
    if (P && settings.pacer) {
      const gap = Math.round(ride.dist - P.dist);
      $('wk-pacer').textContent = Math.abs(gap) < 3 ? `With ${P.name}` : gap > 0 ? `${P.name} ${gap} m behind` : `${P.name} ${-gap} m ahead`;
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
    $('wk-next').textContent = next ? (nextW === null ? 'free' : `${nextW} W`) : '—';
    drawWorkoutChart($('wk-chart'), ride.workout, ride.workoutT);
  }

  drawProfile($('profile'), ride.route, [...ride.bots, ...(ride.ghost ? [{ dist: ride.ghost.dist, color: 'rgba(255,255,255,.6)' }] : []), { dist: ride.dist, color: settings.jersey, self: true }]);
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
      if (!best || t < best) { records.seg[S.climb.id] = t; saveRecords(); }
      toast(!best ? `${S.climb.name}: ${fmtTime(t)} — first time up 🎉` : t < best ? `${S.climb.name}: ${fmtTime(t)} — new record! (${fmtDelta(t - best)}) 🏆` : `${S.climb.name}: ${fmtTime(t)} (${fmtDelta(t - best)} vs best)`);
      cueBeep(t < (best || Infinity) ? 1180 : 760, 0.25);
      ride.seg = null;
    } else if (done < -5) ride.seg = null; // rolled back past the start
  }
  if (!ride.seg) {
    const c = route.climbs.find((cl) => crossed(cl.start));
    if (c) {
      ride.seg = { climb: c, t0: ride.elapsed, d0: cur - (((cur - c.start) % L) + L) % L };
      toast(`${c.name} — ${(c.length / 1000).toFixed(1)} km at ${(c.grade * 100).toFixed(1)}%. Go! ⛰️`);
    }
  }
  const panel = $('seg-panel');
  panel.hidden = !ride.seg;
  if (ride.seg) {
    const S = ride.seg, t = ride.elapsed - S.t0, best = records.seg[S.climb.id];
    const frac = Math.min(1, (cur - S.d0) / S.climb.length);
    $('seg-name').textContent = S.climb.name;
    $('seg-time').textContent = fmtTime(t);
    $('seg-left').textContent = `${Math.max(0, Math.round((S.climb.length - (cur - S.d0))))} m to the top`;
    $('seg-best').textContent = best ? `best ${fmtTime(best)}` : 'no record yet';
    // on pace: compare with the best time scaled to the distance done so far
    const pace = best ? t - best * frac : 0;
    $('seg-pace').textContent = best && frac > 0.05 ? fmtDelta(pace) : '';
    $('seg-pace').className = pace <= 0 ? 'c-ok' : 'c-bad';
    $('seg-fill').style.width = `${(frac * 100).toFixed(1)}%`;
  }
}

function updateProgress() {
  // the bottom-right bar always tracks the lap; the workout's name and progress head its own panel
  const L = ride.route.length, frac = ride.route.oneWay ? Math.min(1, ride.dist / L) : (ride.dist % L) / L;
  $('progress-fill').style.width = `${(frac * 100).toFixed(1)}%`;
  const best = records.lap[ride.route.id];
  if (ride.route.oneWay) $('progress-label').textContent = `${(Math.min(ride.dist, L) / 1000).toFixed(1)} / ${(L / 1000).toFixed(1)} km · ${fmtTime(ride.elapsed)}${best ? ` (best ${fmtTime(best)})` : ''}`;
  else $('progress-label').textContent = `Lap ${Math.floor(ride.dist / L) + 1} · ${((ride.dist % L) / 1000).toFixed(1)} / ${(L / 1000).toFixed(0)} km · ${fmtTime(ride.elapsed - ride.lapStartT)}${best ? ` (best ${fmtTime(best)})` : ''}`;
  if (ride.workout) {
    const done = Math.min(1, ride.workoutT / totalDuration(ride.workout));
    $('wk-name').textContent = ride.workout.name;
    $('wk-pct').textContent = ride.workoutDone ? 'done' : `${Math.round(done * 100)}%`;
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
  $('btn-pause').textContent = ride.paused ? 'Resume' : 'Pause';
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
  $('sum-kicker').textContent = live ? 'Ride complete' : new Date(e.date).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  $('sum-name').textContent = [e.routeName, e.workoutName || 'Free ride'].filter(Boolean).join(' · ');
  const hero = sum ? [
    ['Time', fmtTime(sum.duration), ''],
    ['Distance', (sum.distance / 1000).toFixed(2), 'km'],
    ['Avg power', sum.avgPower, 'W'],
    ['Avg heart rate', sum.avgHr || '—', sum.avgHr ? 'bpm' : ''],
  ] : [['Time', '0:00', '']];
  $('sum-hero').innerHTML = hero.map(([k, v, u]) => `<div><label>${k}</label><b>${v}</b><span>${u}</span></div>`).join('');
  const chartSamples = e.chart.pw.map((p, i) => ({ power: p, heartRate: e.chart.hr[i] }));
  requestAnimationFrame(() => drawSummaryChart($('sum-chart'), chartSamples, 2, e.ftp || settings.ftp));
  const stats = sum ? [
    ['Elevation gain', `${Math.round(sum.elevationGain)} m`],
    ['NP', sum.normalizedPower ? `${sum.normalizedPower} W` : '—'],
    ['TSS', e.tss || '—'],
    ['Max power', `${sum.maxPower} W`],
    ['Max heart rate', sum.maxHr ? `${sum.maxHr} bpm` : '—'],
    ['Avg cadence', `${sum.avgCadence} rpm`],
    ['Work', `${sum.kj} kJ`],
  ] : [];
  if (sum && e.ramp && sum.best1min) stats.push(['Estimated FTP', `${Math.round(sum.best1min * 0.75)} W`]);
  if (e.ghostGap !== null && e.ghostGap !== undefined) stats.push([`vs ${e.ghostName || 'ghost'}`, `${e.ghostGap >= 0 ? '+' : '−'}${Math.abs(e.ghostGap)} m ${e.ghostGap >= 0 ? '🏆' : ''}`]);
  $('sum-stats').innerHTML = stats.map(([k, v]) => `<div><label>${k}</label><b>${v}</b></div>`).join('');
  // laps and climbs of this ride, with personal bests
  const rows = [
    ...e.lapTimes.map((t, i) => [routes.find((x) => x.id === e.routeId)?.oneWay ? 'Finish' : `Lap ${i + 1}`, t, null]),
    ...e.efforts.map((x) => [x.name, x.time, x]),
  ];
  $('sum-segments').hidden = !rows.length;
  $('sum-seg-rows').innerHTML = rows.map(([name, t, x]) => {
    const pb = x ? x.pb : t <= (records.lap[e.routeId] ?? Infinity);
    const vs = x && x.best ? fmtDelta(t - x.best) : '';
    return `<tr><td>${esc(name)}</td><td>${fmtTime(t)}</td><td>${pb ? '<span class="pb">🏆 best</span>' : vs}</td></tr>`;
  }).join('');
  // files and intervals.icu only for the ride just finished (older rides keep a summary, not the full record)
  for (const id of ['btn-download', 'btn-download-tcx']) { $(id).hidden = !live; $(id).disabled = !sum; }
  document.querySelector('#summary .hint:last-of-type').hidden = !live;
  const canUpload = !!(live && icuClient && sum && sum.duration >= 60);
  $('btn-icu-upload').hidden = !canUpload;
  $('btn-icu-upload').disabled = false;
  $('btn-icu-upload').textContent = 'Upload to intervals.icu';
  $('icu-upload-status').hidden = true;
  $('btn-delete-ride').hidden = live;
  $('btn-delete-ride').dataset.id = e.id;
  $('btn-delete-ride').textContent = 'Delete ride';
  if (canUpload && settings.icuUpload) uploadToIntervals();
}

/** Recent rides in the lobby (latest five) and the full list in the drawer. */
function renderHistory() {
  const row = (e) => {
    const s = e.summary || {};
    const day = new Date(e.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `<button class="hist-row" data-id="${e.id}"><span class="hist-date">${day}</span><span class="hist-name"><b>${esc(e.routeName || '')}</b><small>${esc(e.workoutName || 'Free ride')}</small></span><span class="hist-nums"><b>${fmtTime(s.duration || 0)}</b><small>${((s.distance || 0) / 1000).toFixed(1)} km</small></span><span class="hist-nums"><b>${s.normalizedPower || s.avgPower || 0} W</b><small>TSS ${e.tss || 0}</small></span></button>`;
  };
  $('history-recent').innerHTML = history.slice(0, 5).map(row).join('');
  $('history-box').hidden = !history.length;
  $('history-all').innerHTML = history.length ? history.map(row).join('') : '<p class="muted">No rides yet. Finished rides show up here.</p>';
  const week = history.filter((e) => Date.now() - Date.parse(e.date) < 7 * 864e5);
  $('history-week').textContent = week.length ? `This week: ${week.length} ride${week.length > 1 ? 's' : ''} · ${fmtTime(week.reduce((a, e) => a + (e.summary?.duration || 0), 0))} · TSS ${week.reduce((a, e) => a + (e.tss || 0), 0)}` : '';
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
  if (!key) { $('icu-status').textContent = 'Paste your intervals.icu API key.'; return; }
  const client = new IntervalsClient({ apiKey: key, athleteId: $('f-icu-athlete').value });
  $('btn-icu').disabled = true;
  $('icu-status').textContent = 'Connecting…';
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
    if (st.otherSport) notes.push(`other sports skipped: ${st.otherSport}`);
    if (st.unstructured) notes.push(`without intervals (free ride): ${st.unstructured}`);
    const found = n ? `cycling workouts in the next 7 days: ${n} — listed first under “Mode”` : 'no cycling workouts in your calendar for the next 7 days';
    $('icu-status').textContent = `${athlete.name ? `${athlete.name} · ` : ''}FTP ${settings.ftp} W · ${found}${notes.length ? ` (${notes.join(', ')})` : ''}`;
    $('btn-icu').textContent = 'Refresh';
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
  $('icu-status').textContent = 'Key removed from this browser.';
  $('btn-icu').textContent = 'Connect';
  $('btn-icu-forget').hidden = true;
  renderModes();
}

async function uploadToIntervals() {
  if (!icuClient || !lastRide?.summary || lastRide.uploadedId) return;
  const status = $('icu-upload-status');
  const btn = $('btn-icu-upload');
  status.hidden = false;
  status.textContent = 'Uploading to intervals.icu…';
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
      ? `Uploaded to intervals.icu ✓${fromIcu ? ' · marked as completed' : ''} · <a href="${activityUrl(id)}" target="_blank" rel="noopener">open ride</a>`
      : 'Uploaded to intervals.icu ✓';
    btn.hidden = true;
  } catch (e) {
    status.textContent = `Upload failed: ${e.message}`;
    btn.disabled = false;
    btn.textContent = 'Try again';
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
  if (finishArmed) { clearTimeout(finishArmed); finishArmed = null; btn.textContent = 'Finish'; finishRide(); return; }
  btn.textContent = 'Sure? Tap again';
  finishArmed = setTimeout(() => { finishArmed = null; btn.textContent = 'Finish'; }, 3000);
};
$('btn-download').onclick = () => download('fit');
$('wk-int-down').onclick = () => changeIntensity(-5);
$('wk-int-up').onclick = () => changeIntensity(+5);
$('f-pacer').checked = settings.pacer !== false;
$('f-pacer-name').value = settings.pacerName || '';
$('f-pacer-name').oninput = () => { settings.pacerName = $('f-pacer-name').value; saveSettings(); };
$('f-pacer').onchange = () => { settings.pacer = $('f-pacer').checked; saveSettings(); };
$('wk-pacer-btn').onclick = () => togglePacer();
function togglePacer() {
  settings.pacer = !settings.pacer;
  saveSettings();
  $('f-pacer').checked = settings.pacer;
  $('wk-pacer-btn').classList.toggle('on', settings.pacer);
  if (ride?.pacer && settings.pacer) { ride.pacer.dist = ride.dist; ride.pacer.v = ride.v; } // rejoin beside you
  const who = settings.pacerName?.trim() || 'Pacer';
  toast(settings.pacer ? `${who} is riding with you` : `${who} dropped back`);
}
$('f-sound').checked = !!settings.sound;
$('f-sound').onchange = () => {
  settings.sound = settings.voice = $('f-sound').checked;
  saveSettings();
  if (settings.sound) { unlockAudio(); beep(880, 0.1); }
};
$('btn-download-tcx').onclick = () => download('tcx');
$('btn-again').onclick = () => { $('summary').hidden = true; $('lobby').hidden = false; renderHistory(); showRoute(); };
$('btn-delete-ride').onclick = () => {
  const b = $('btn-delete-ride');
  if (b.textContent !== 'Tap again to delete') { b.textContent = 'Tap again to delete'; return; }
  history = history.filter((e) => e.id !== b.dataset.id);
  saveHistory();
  renderHistory();
  $('summary').hidden = true; $('lobby').hidden = false;
};
$('sim-power').oninput = () => { $('sim-val').textContent = $('sim-power').value; };
// ---------- Virtual gears & controller actions ----------

const BUTTON_LABELS = {
  shiftUpL: 'left lever (gear −)', shiftDownL: 'left lever (gear −)', shiftUpR: 'right lever (gear +)', shiftDownR: 'right lever (gear +)',
  paddleL: 'left paddle', paddleR: 'right paddle',
  up: '▲', down: '▼', left: '◀', right: '▶', a: 'A', b: 'B', y: 'Y', z: 'Z',
  powerUpL: 'Power-up left', powerUpR: 'Power-up right', onOffL: 'on/off left', onOffR: 'on/off right',
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
    toast('The trainer does not accept wheel circumference — using grade-based gears');
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
    toast(hasCadence ? 'Low cadence — ERG temporarily reduced' : 'Power dropped — ERG temporarily reduced');
    cueSay('Spin up your cadence');
  } else if (ride.ergFactor < 1) {
    // restore only once the rider has clearly recovered (hysteresis avoids bouncing)
    const recovered = hasCadence ? cadence >= 70 : power >= eff * 0.85;
    if (recovered) ride.ergFactor = Math.min(1, Math.round((ride.ergFactor + 0.1) * 10) / 10);
  }
}

function describeStep(step, watts) {
  const what = watts === null || watts === undefined ? 'free ride' : `${watts} watts`;
  const cad = step.cad ? `, cadence ${step.cad[0]} to ${step.cad[1]}` : '';
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
}

const inErgStep = () => !!(ride?.workout && !ride.workoutDone && ride.target !== null);

function setGear(gear) {
  if (!ride || inErgStep()) return;
  const g = Math.max(1, Math.min(GEARS, Math.round(gear)));
  if (g !== ride.gear) shift(g - ride.gear);
}

function shift(dir) {
  if (!ride || ride.paused) return;
  if (inErgStep()) {
    ride.ergBias += Math.sign(dir) * 5;
    const t = targetAt(ride.workout, Math.max(0, ride.workoutT - 1), settings.ftp);
    if (t && t.watts !== null) ride.target = ergTarget(t);
    toast(`ERG ${ride.ergBias >= 0 ? '+' : ''}${ride.ergBias} W`);
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
  toast('Interval skipped ⏭');
}

function updateGear() {
  if (!ride) return;
  const inErg = inErgStep();
  $('m-gear-label').textContent = inErg ? 'ERG' : 'Gear';
  $('m-gear').textContent = inErg ? `${ride.ergBias >= 0 ? '+' : ''}${ride.ergBias}` : ride.gear;
  $('m-gear-unit').textContent = inErg ? 'W' : `/${GEARS} · ${ratioOf(ride.gear).toFixed(2)}`;
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
  if (e.code === 'KeyC' && scene?.setCamera) {
    const order = ['chase', 'iso', 'side'];
    settings.camera = order[(order.indexOf(settings.camera) + 1) % order.length];
    saveSettings();
    scene.setCamera(settings.camera);
    toast({ chase: 'Camera: chase', iso: 'Camera: isometric', side: 'Camera: side view' }[settings.camera]);
  }
  if (ride.simulated && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
    e.preventDefault();
    const s = $('sim-power');
    s.value = Number(s.value) + (e.code === 'ArrowUp' ? 10 : -10);
    s.oninput();
  }
});

initLobby();
