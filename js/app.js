import { bluetoothAvailable, setShowAllDevices, knownDevices, Trainer, HeartRateMonitor, CadenceSensor, ZwiftController, OpenBikeControlDevice } from './ble.js';
import { obcIntents, rideIntent, OBC_LABELS } from './controls.js';
import { IntervalsClient, activityUrl, localDate } from './intervals.js';
import { stepSpeed } from './physics.js';
import { routes } from './routes.js';
import { workouts, targetAt, totalDuration, stepWatts, zoneColor } from './workouts.js';
import { Recorder } from './recorder.js';
import { Sampler } from './sampler.js';
import { unlockAudio, beep, say, spokenDuration } from './sound.js';
import { Scene, drawProfile } from './render.js';
import { themeFor } from './themes.js';
import { GEARS, DEFAULT_GEAR, ratioOf, virtualWheelMm, gearGradeOffset, BASE_WHEEL_MM } from './gears.js';

const $ = (id) => document.getElementById(id);

// ---------- Settings ----------
const DEFAULT_SETTINGS = {
  name: 'Me', weight: 75, ftp: 200, difficulty: 50, routeId: 'rolling', mode: 'free',
  icuKey: '', icuAthlete: '', icuUpload: true,
  chainring: 34, shiftMode: 'wheel', graphics: '3d',
  jersey: '#16a0a8', stripe: '#ff8a1f',
  intensity: 100, sound: true, voice: true, style: 'cartoon', camera: 'chase',
};
let settings = { ...DEFAULT_SETTINGS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('powerup.settings') || '{}')); } catch { /* storage unavailable */ }
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

  const rl = $('route-list');
  for (const r of routes) {
    const b = document.createElement('button');
    b.className = 'option';
    b.dataset.id = r.id;
    b.innerHTML = `<b>${r.name}</b><small>${(r.length / 1000).toFixed(0)} km · ↗ ${Math.round(r.elevationGain)} m</small><small>${r.description}</small><canvas></canvas>`;
    b.onclick = () => { settings.routeId = r.id; saveSettings(); markSelected(rl, r.id); };
    rl.append(b);
    requestAnimationFrame(() => drawProfile(b.querySelector('canvas'), r, [], `${themeFor(r.theme).accent}99`));
  }
  markSelected(rl, settings.routeId);

  $('btn-start').onclick = startRide;
  updateDeviceUI();
  initIntervals();
}

function renderModes() {
  const ml = $('mode-list');
  ml.innerHTML = '';
  const add = (id, title, sub, w, tag) => {
    const b = document.createElement('button');
    b.className = 'option';
    b.dataset.id = id;
    b.innerHTML = `${tag ? `<span class="tag">intervals.icu · ${esc(tag)}</span>` : ''}<b>${esc(title)}</b><small>${esc(sub)}</small>${w ? '<canvas></canvas>' : ''}`;
    b.onclick = () => { settings.mode = id; saveSettings(); markSelected(ml, id); };
    ml.append(b);
    if (w) requestAnimationFrame(() => drawWorkoutChart(b.querySelector('canvas'), w, -1));
  };
  for (const w of icuWorkouts) add(w.id, w.name, `${Math.round(totalDuration(w) / 60)} min · ${w.description}`, w, dayLabel(w.date));
  add('free', 'Free ride', 'The trainer simulates the road grade.');
  for (const w of workouts) add(w.id, w.name, `${Math.round(totalDuration(w) / 60)} min · ${w.description}`, w);
  markSelected(ml, settings.mode);
}

function markSelected(list, id) {
  for (const el of list.children) el.classList.toggle('sel', el.dataset.id === id);
}

// ---------- Ride ----------
const BOTS = [
  { name: 'Olya', wkg: 2.2, color: '#e5484d', stripe: '#ffffff' },
  { name: 'Taras', wkg: 2.7, color: '#2563eb', stripe: '#facc15' },
  { name: 'Iryna', wkg: 3.1, color: '#8b5cf6', stripe: '#f0f0f0' },
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
    gain: 0, lastElev: route.elevAt(0), laps: 0,
    paused: false, pedal: 0, lastSim: performance.now(), moved: 0,
    powerHist: [], target: null, lastSentTarget: null, lastSentGrade: null, lastGradeSentAt: 0,
    gear: DEFAULT_GEAR, ergBias: 0, ergFactor: 1, lowFor: 0, lastSentWheel: null, shiftMode: settings.shiftMode, lane: START_LANE, laneTarget: START_LANE,
    bots: BOTS.map((b, i) => ({ ...b, dist: 15 + i * 12, v: 0, pedal: i, lane: i % 2 ? -1.6 : 1.6 })),
  };
  if (workout) ride.target = ergTarget(targetAt(workout, 0, settings.ftp));
  unlockAudio();
  $('wk-int').textContent = `${settings.intensity}%`;
  $('wk-sound').textContent = settings.sound ? 'Sound: on' : 'Sound: off';
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
    ride.v = stepSpeed(ride.v, power, grade, dt, settings.weight);
    const moved = ride.v * dt;
    ride.dist += moved;
    ride.moved += moved;
    // Pedal animation only: trainers like the KICKR CORE derive cadence from the flywheel and report
    // 0–1 rpm at low speed, so while there is power the legs keep turning at a plausible rate.
    const animCadence = cadence >= 20 ? cadence : power > 5 ? Math.max(cadence, 60) : cadence;
    ride.pedal += (animCadence / 60) * Math.PI * 2 * dt;
    ride.lane += (ride.laneTarget - ride.lane) * Math.min(1, dt * 4);
    for (const b of ride.bots) {
      const g = route.gradeAt(b.dist);
      const p = b.wkg * 75 * (1 + Math.max(-0.6, Math.min(0.35, g * 4)));
      b.v = stepSpeed(b.v, p, g, dt, 75);
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
  ];
  scene.render(ride.route, ride.dist, riders, ride.moved);
  ride.moved = 0;
  requestAnimationFrame(frame);
}

/** Called once per second of riding. */
function tick(power, cadence, hr) {
  const { route } = ride;

  // elevation & laps
  const elev = route.elevAt(ride.dist);
  if (elev > ride.lastElev) ride.gain += elev - ride.lastElev;
  ride.lastElev = elev;
  const laps = Math.floor(ride.dist / route.length);
  if (laps > ride.laps) {
    ride.laps = laps;
    toast(`Lap ${laps} complete! 🎉`);
    if (!ride.workout || ride.workoutDone) recorder.markLap();
  }

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
      const now = performance.now();
      if (g !== ride.lastSentGrade || now - ride.lastGradeSentAt > 10000) {
        trainer.setSimulation(g);
        ride.lastSentGrade = g;
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
  $('m-cad').textContent = Math.round(cadence);
  $('m-hr').textContent = hr ? Math.round(hr) : '—';
  const A = ride.avg;
  $('m-hr-avg').textContent = A?.hrN ? `avg ${Math.round(A.hr / A.hrN)}` : '';
  $('m-cad-avg').textContent = A?.cadN ? `avg ${Math.round(A.cad / A.cadN)}` : '';
  $('m-speed').textContent = (ride.v * 3.6).toFixed(1);
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

  drawProfile($('profile'), ride.route, [...ride.bots, { dist: ride.dist, color: settings.jersey, self: true }]);
}

function updateProgress() {
  // the bottom-right bar always tracks the lap; the workout's name and progress head its own panel
  const L = ride.route.length, frac = (ride.dist % L) / L;
  $('progress-fill').style.width = `${(frac * 100).toFixed(1)}%`;
  $('progress-label').textContent = `Lap ${Math.floor(ride.dist / L) + 1} · ${((ride.dist % L) / 1000).toFixed(1)} / ${(L / 1000).toFixed(0)} km`;
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
  const wasRamp = ride.workout?.ramp;
  lastRide = { workout: ride.workout, route: ride.route, summary: sum, uploadedId: null };
  ride = null;
  if (trainer.connected && trainer.controllable) {
    trainer.setSimulation(0);
    if (settings.shiftMode === 'wheel') trainer.setWheelCircumference(BASE_WHEEL_MM);
  }
  $('ride').hidden = true;
  $('summary').hidden = false;
  const stats = sum ? [
    ['Time', fmtTime(sum.duration)],
    ['Distance', `${(sum.distance / 1000).toFixed(2)} km`],
    ['Elevation gain', `${Math.round(sum.elevationGain)} m`],
    ['Avg power', `${sum.avgPower} W`],
    ['NP', sum.normalizedPower ? `${sum.normalizedPower} W` : '—'],
    ['Max power', `${sum.maxPower} W`],
    ['Avg heart rate', sum.avgHr ? `${sum.avgHr} bpm` : '—'],
    ['Avg cadence', `${sum.avgCadence} rpm`],
    ['Work', `${sum.kj} kJ`],
  ] : [['Time', '0:00']];
  if (sum && wasRamp && sum.best1min) stats.push(['Estimated FTP', `${Math.round(sum.best1min * 0.75)} W`]);
  $('sum-stats').innerHTML = stats.map(([k, v]) => `<div><label>${k}</label><b>${v}</b></div>`).join('');
  $('btn-download').disabled = !sum;
  $('btn-download-tcx').disabled = !sum;
  const canUpload = !!(icuClient && sum && sum.duration >= 60);
  $('btn-icu-upload').hidden = !canUpload;
  $('btn-icu-upload').disabled = false;
  $('btn-icu-upload').textContent = 'Upload to intervals.icu';
  $('icu-upload-status').hidden = true;
  if (canUpload && settings.icuUpload) uploadToIntervals();
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
  const name = workout ? `Power Up: ${workout.name}` : `Power Up: ${route.name}`;
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
$('wk-sound').onclick = () => {
  settings.sound = settings.voice = !settings.sound;
  saveSettings();
  $('wk-sound').textContent = settings.sound ? 'Sound: on' : 'Sound: off';
  if (settings.sound) { unlockAudio(); beep(880, 0.1); }
};
$('btn-download-tcx').onclick = () => download('tcx');
$('btn-again').onclick = () => { $('summary').hidden = true; $('lobby').hidden = false; };
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

// Pause / Finish stay hidden while riding: they show when the mouse moves (for a few seconds, or as
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
document.querySelector('#ride .controls').addEventListener('mouseenter', () => { controlsPinned = true; showControls(0); });
document.querySelector('#ride .controls').addEventListener('mouseleave', () => { controlsPinned = false; showControls(); });

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
