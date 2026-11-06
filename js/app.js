import { bluetoothAvailable, Trainer, HeartRateMonitor, CadenceSensor, ZwiftController, OpenBikeControlDevice } from './ble.js';
import { obcIntents, rideIntent, OBC_LABELS } from './controls.js';
import { IntervalsClient, activityUrl, localDate } from './intervals.js';
import { stepSpeed } from './physics.js';
import { routes } from './routes.js';
import { workouts, targetAt, totalDuration, stepWatts, zoneColor } from './workouts.js';
import { Recorder } from './recorder.js';
import { Sampler } from './sampler.js';
import { Scene, drawProfile } from './render.js';
import { themeFor } from './themes.js';
import { GEARS, DEFAULT_GEAR, ratioOf, virtualWheelMm, gearGradeOffset, BASE_WHEEL_MM } from './gears.js';

const $ = (id) => document.getElementById(id);

// ---------- Settings ----------
const DEFAULT_SETTINGS = {
  name: 'Я', weight: 75, ftp: 200, difficulty: 50, routeId: 'rolling', mode: 'free',
  icuKey: '', icuAthlete: '', icuUpload: true,
  chainring: 34, shiftMode: 'wheel', graphics: '3d',
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
const live = { power: 0, cadence: 0, hr: 0, powerAt: 0, cadAt: 0, hrAt: 0 };

const powerSamples = new Sampler(3000);
const cadenceSamples = new Sampler(3000);
const hrSamples = new Sampler(5000);

trainer.addEventListener('data', ({ detail: d }) => {
  const now = performance.now();
  if (d.power !== undefined) { live.power = Math.max(0, d.power); live.powerAt = now; powerSamples.add(now, live.power); }
  if (d.cadence !== undefined && !cadenceSensor.connected) { live.cadence = d.cadence; live.cadAt = now; cadenceSamples.add(now, d.cadence); }
  if (d.heartRate && !hrm.connected) { live.hr = d.heartRate; live.hrAt = now; hrSamples.add(now, d.heartRate); }
  advance(now); // keeps the ride clock running even when the tab is hidden and frames stop
});
hrm.addEventListener('data', ({ detail: d }) => { const now = performance.now(); live.hr = d.heartRate; live.hrAt = now; hrSamples.add(now, d.heartRate); });
cadenceSensor.addEventListener('data', ({ detail: d }) => { const now = performance.now(); live.cadence = d.cadence; live.cadAt = now; cadenceSamples.add(now, d.cadence); });
controller.addEventListener('press', ({ detail: name }) => onControllerButton(name));
obc.addEventListener('buttons', ({ detail: changes }) => onObcButtons(changes));
obc.addEventListener('disconnect', () => obcState.clear());

const DEVICES = [
  { dev: trainer, key: 'trainer', lost: 'Тренажер відключився' },
  { dev: hrm, key: 'hr', lost: 'Пульсометр відключився' },
  { dev: cadenceSensor, key: 'cad', lost: 'Датчик каденсу відключився' },
  { dev: controller, key: 'ctl', lost: 'Контролер відключився' },
  { dev: obc, key: 'obc', lost: 'OpenBikeControl відключився' },
];
const TRAINER_PROTOCOL = { ftms: 'FTMS', wahoo: 'Wahoo', power: 'вимірювач потужності' };
let lastButtonLabel = '';
let lastObcLabel = '';

for (const d of DEVICES) d.dev.addEventListener('disconnect', () => { updateDeviceUI(); toast(d.lost); });

function deviceStatus(d) {
  if (!d.dev.connected) return 'не підключено';
  if (d.dev === trainer) {
    return `${trainer.name} · ${TRAINER_PROTOCOL[trainer.protocol] || ''} · ${trainer.controllable ? 'керування ERG/нахил ✓' : 'лише дані'}`;
  }
  if (d.dev === controller || d.dev === obc) {
    const label = d.dev === obc ? lastObcLabel : lastButtonLabel;
    return `${d.dev.name}${label ? ` · натиснуто: ${label}` : ' · натисніть будь-яку кнопку'}`;
  }
  return d.dev.name;
}

function updateDeviceUI() {
  for (const d of DEVICES) {
    const btn = $(`btn-${d.key}`);
    $(`${d.key}-status`).textContent = deviceStatus(d);
    btn.textContent = d.dev.connected ? 'Відключити' : 'Підключити';
    btn.classList.toggle('ok', d.dev.connected);
  }
}

async function toggleDevice(d) {
  const btn = $(`btn-${d.key}`);
  if (d.dev.connected) { d.dev.disconnect(); updateDeviceUI(); return; }
  btn.disabled = true;
  btn.textContent = 'Пошук…';
  let error = null;
  try {
    if (d.dev === trainer) trainer.riderWeight = settings.weight + 8;
    await d.dev.connect();
    if (d.dev === trainer) $('sim').checked = false;
  } catch (e) {
    if (e.name !== 'NotFoundError') error = e;
  } finally {
    btn.disabled = false;
    updateDeviceUI();
    if (error) $(`${d.key}-status`).textContent = `Не вдалося підключитися: ${error.message}`;
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

  const bind = (id, key, num = true) => {
    const el = $(id);
    el.value = settings[key];
    el.oninput = () => { settings[key] = num ? Number(el.value) : el.value; saveSettings(); refreshDiff(); };
  };
  bind('f-name', 'name', false);
  bind('f-weight', 'weight');
  bind('f-ftp', 'ftp');
  bind('f-diff', 'difficulty');
  bind('f-chainring', 'chainring');
  bind('f-shift', 'shiftMode', false);
  bind('f-graphics', 'graphics', false);
  const refreshDiff = () => { $('diff-val').textContent = `${settings.difficulty}%`; renderModes(); };
  refreshDiff();

  const rl = $('route-list');
  for (const r of routes) {
    const b = document.createElement('button');
    b.className = 'option';
    b.dataset.id = r.id;
    b.innerHTML = `<b>${r.name}</b><small>${(r.length / 1000).toFixed(0)} км · ↗ ${Math.round(r.elevationGain)} м</small><small>${r.description}</small><canvas></canvas>`;
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
  for (const w of icuWorkouts) add(w.id, w.name, `${Math.round(totalDuration(w) / 60)} хв · ${w.description}`, w, dayLabel(w.date));
  add('free', 'Вільна їзда', 'Тренажер імітує нахил дороги.');
  for (const w of workouts) add(w.id, w.name, `${Math.round(totalDuration(w) / 60)} хв · ${w.description}`, w);
  markSelected(ml, settings.mode);
}

function markSelected(list, id) {
  for (const el of list.children) el.classList.toggle('sel', el.dataset.id === id);
}

// ---------- Ride ----------
const BOTS = [
  { name: 'Оля', wkg: 2.2, color: '#e5484d', stripe: '#ffffff' },
  { name: 'Тарас', wkg: 2.7, color: '#2563eb', stripe: '#facc15' },
  { name: 'Ірина', wkg: 3.1, color: '#8b5cf6', stripe: '#f0f0f0' },
  { name: 'Богдан', wkg: 3.6, color: '#f5f5f5', stripe: '#16a34a' },
];
const ME_COLOR = '#16a0a8';
const ME_STRIPE = '#ff8a1f';

let ride = null;
let rideTimer = null;
let scene = null;
let sceneKind = null;

/** Creates the 3D or 2D renderer (a canvas can hold only one kind of context). */
async function ensureScene() {
  let want = settings.graphics === '2d' ? '2d' : '3d';
  if (want === sceneKind) { scene.resize(); return; }
  const old = $('scene');
  const canvas = old.cloneNode(false);
  old.replaceWith(canvas);
  if (want === '3d') {
    try {
      const { Scene3D, webglAvailable } = await import('./render3d.js');
      if (!webglAvailable()) throw new Error('WebGL недоступний');
      scene = new Scene3D(canvas);
    } catch (e) {
      console.warn('3D unavailable, falling back to 2D', e);
      toast('3D-графіка недоступна в цьому браузері — використовую 2D');
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
    powerHist: [], target: workout ? targetAt(workout, 0, settings.ftp).watts : null, lastSentTarget: null, lastSentGrade: null, lastGradeSentAt: 0,
    gear: DEFAULT_GEAR, ergBias: 0, lastSentWheel: null, shiftMode: settings.shiftMode, lane: 0, laneTarget: 0,
    bots: BOTS.map((b, i) => ({ ...b, dist: 15 + i * 12, v: 0, pedal: i, lane: i % 2 ? -1.6 : 1.6 })),
  };
  trainer.riderWeight = settings.weight + 8;
  trainer.resetMode();
  recorder.reset();
  updateGear();
  $('lobby').hidden = true;
  $('summary').hidden = true;
  $('ride').hidden = false;
  $('sim-ctl').hidden = !simulated;
  $('workout-panel').hidden = !workout;
  $('paused').hidden = true;
  $('btn-pause').textContent = 'Пауза';
  await ensureScene();
  ride.lastSim = performance.now();
  clearInterval(rideTimer);
  rideTimer = setInterval(() => advance(), 250);
  keepAwake(true);
  if (simulated) toast('Режим симулятора: потужність — повзунок або ↑/↓');
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
    toast(`Немає даних від тренажера ${Math.round(left)} с — цей проміжок пропущено`);
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
    ride.pedal += (cadence / 60) * Math.PI * 2 * dt;
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
    { dist: ride.dist, color: ME_COLOR, stripe: ME_STRIPE, pedal: ride.pedal, self: true, name: settings.name, lane: ride.lane },
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
  if (laps > ride.laps) { ride.laps = laps; toast(`Коло ${laps} пройдено! 🎉`); }

  // workout / trainer control
  const grade = route.gradeAt(ride.dist);
  if (ride.workout && !ride.workoutDone) {
    const t = targetAt(ride.workout, ride.workoutT, settings.ftp);
    ride.workoutT += 1;
    if (t) {
      ride.target = t.watts === null ? null : Math.max(0, t.watts + ride.ergBias);
      if (t.index !== ride.stepIndex) {
        ride.stepIndex = t.index;
        if (t.step.text) toast(t.step.text);
        else if (t.watts === null) toast('Вільний відрізок — їдьте за відчуттям');
        updateGear();
      }
      if (t.remaining <= 5 && t.remaining > 4) toast('Через 5 с — наступний інтервал');
    } else {
      ride.workoutDone = true;
      ride.target = null;
      toast('Тренування виконано! Далі — вільна їзда 🏁');
      updateGear();
      if (ride.simulated) $('sim-power').value = Math.round(settings.ftp * 0.5);
    }
  }
  if (!ride.simulated && trainer.controllable) {
    if (ride.target !== null && ride.workout && !ride.workoutDone) {
      if (ride.target !== ride.lastSentTarget) { trainer.setTargetPower(ride.target); ride.lastSentTarget = ride.target; }
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
  updateHud(cadence, hr, grade);
}

function updateHud(cadence, hr, grade) {
  const p3 = Math.round(ride.powerHist.reduce((a, b) => a + b, 0) / ride.powerHist.length);
  $('m-power').textContent = p3;
  $('m-wkg').textContent = `${(p3 / settings.weight).toFixed(1)} Вт/кг`;
  $('m-cad').textContent = Math.round(cadence);
  $('m-hr').textContent = hr ? Math.round(hr) : '—';
  $('m-speed').textContent = (ride.v * 3.6).toFixed(1);
  $('m-dist').textContent = (ride.dist / 1000).toFixed(2);
  $('m-time').textContent = fmtTime(ride.elapsed);
  $('m-gain').textContent = Math.round(ride.gain);
  updateProgress();
  const gEl = $('grade');
  gEl.textContent = `${grade >= 0 ? '' : '−'}${Math.abs(grade * 100).toFixed(1)}%`;
  gEl.style.color = grade > 0.06 ? '#ef4444' : grade > 0.03 ? '#f97316' : grade < -0.02 ? '#60a5fa' : '#e8edf5';

  if (ride.workout) {
    const t = targetAt(ride.workout, ride.workoutT, settings.ftp);
    $('wk-target').textContent = ride.workoutDone ? '—' : ride.target ?? 'вільно';
    $('wk-left').textContent = t ? fmtTime(t.remaining) : '0:00';
    const next = t && ride.workout.steps[t.index + 1];
    const nextW = next ? stepWatts(next, 0, settings.ftp) : null;
    $('wk-next').textContent = next ? (nextW === null ? 'вільно' : `${nextW} Вт`) : '—';
    drawWorkoutChart($('wk-chart'), ride.workout, ride.workoutT);
  }

  const L = ride.route.length;
  const list = [{ name: settings.name, color: ME_COLOR, dist: ride.dist, me: true }, ...ride.bots]
    .map((r) => ({ ...r, gap: ((((r.dist - ride.dist) % L) + L * 1.5) % L) - L / 2 }))
    .sort((a, b) => b.gap - a.gap);
  $('riders').innerHTML = list.map((r) => `<li class="${r.me ? 'me' : ''}"><i style="background:${r.color}"></i><span>${esc(r.name)}</span><em>${r.me ? '' : fmtGap(r.gap, ride.v)}</em></li>`).join('');

  drawProfile($('profile'), ride.route, [...ride.bots, { dist: ride.dist, color: ME_COLOR, self: true }]);
}

function updateProgress() {
  let frac, label;
  if (ride.workout && !ride.workoutDone) {
    const total = totalDuration(ride.workout);
    frac = Math.min(1, ride.workoutT / total);
    label = `${ride.workout.name} · ${Math.round(frac * 100)}%`;
  } else {
    const L = ride.route.length;
    frac = (ride.dist % L) / L;
    label = `Коло ${Math.floor(ride.dist / L) + 1} · ${((ride.dist % L) / 1000).toFixed(1)} / ${(L / 1000).toFixed(0)} км`;
  }
  $('progress-fill').style.width = `${(frac * 100).toFixed(1)}%`;
  $('progress-label').textContent = label;
}

function drawWorkoutChart(canvas, w, t) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const total = totalDuration(w);
  const ftp = settings.ftp;
  const wattsOf = (s, f) => stepWatts(s, f, ftp) ?? ftp * 0.5;
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
  $('btn-pause').textContent = ride.paused ? 'Продовжити' : 'Пауза';
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
    ['Час', fmtTime(sum.duration)],
    ['Дистанція', `${(sum.distance / 1000).toFixed(2)} км`],
    ['Набір висоти', `${Math.round(sum.elevationGain)} м`],
    ['Сер. потужність', `${sum.avgPower} Вт`],
    ['NP', sum.normalizedPower ? `${sum.normalizedPower} Вт` : '—'],
    ['Макс. потужність', `${sum.maxPower} Вт`],
    ['Сер. пульс', sum.avgHr ? `${sum.avgHr} уд/хв` : '—'],
    ['Сер. каденс', `${sum.avgCadence} об/хв`],
    ['Робота', `${sum.kj} кДж`],
  ] : [['Час', '0:00']];
  if (sum && wasRamp && sum.best1min) stats.push(['Оцінка FTP', `${Math.round(sum.best1min * 0.75)} Вт`]);
  $('sum-stats').innerHTML = stats.map(([k, v]) => `<div><label>${k}</label><b>${v}</b></div>`).join('');
  $('btn-download').disabled = !sum;
  const canUpload = !!(icuClient && sum && sum.duration >= 60);
  $('btn-icu-upload').hidden = !canUpload;
  $('btn-icu-upload').disabled = false;
  $('btn-icu-upload').textContent = 'Надіслати в intervals.icu';
  $('icu-upload-status').hidden = true;
  if (canUpload && settings.icuUpload) uploadToIntervals();
}

function downloadTCX() {
  const blob = new Blob([recorder.toTCX()], { type: 'application/vnd.garmin.tcx+xml' });
  const a = document.createElement('a');
  const d = recorder.startTime || new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `powerup-${d.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.tcx`;
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
  if (!key) { $('icu-status').textContent = 'Вставте API-ключ з intervals.icu.'; return; }
  const client = new IntervalsClient({ apiKey: key, athleteId: $('f-icu-athlete').value });
  $('btn-icu').disabled = true;
  $('icu-status').textContent = 'Підключення…';
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
    const n = icuWorkouts.length;
    $('icu-status').textContent = `${athlete.name ? `${athlete.name} · ` : ''}FTP ${settings.ftp} Вт · ${n ? `заплановано тренувань на тиждень: ${n}` : 'на тиждень тренувань не заплановано'}`;
    $('btn-icu').textContent = 'Оновити';
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
  $('icu-status').textContent = 'Ключ видалено з цього браузера.';
  $('btn-icu').textContent = 'Підключити';
  $('btn-icu-forget').hidden = true;
  renderModes();
}

async function uploadToIntervals() {
  if (!icuClient || !lastRide?.summary || lastRide.uploadedId) return;
  const status = $('icu-upload-status');
  const btn = $('btn-icu-upload');
  status.hidden = false;
  status.textContent = 'Надсилаю в intervals.icu…';
  btn.disabled = true;
  const { workout, route, summary: sum } = lastRide;
  const fromIcu = workout?.source === 'intervals';
  const name = workout ? `Power Up: ${workout.name}` : `Power Up: ${route.name}`;
  const description = `${route.name} · ${(sum.distance / 1000).toFixed(1)} км · сер. ${sum.avgPower} Вт · NP ${sum.normalizedPower || '—'} Вт`;
  try {
    const id = await icuClient.uploadActivity(recorder.toTCX(), {
      name, description, eventId: fromIcu ? workout.eventId : undefined, filename: `powerup-${Date.now()}.tcx`,
    });
    lastRide.uploadedId = id || true;
    status.innerHTML = id
      ? `Завантажено в intervals.icu ✓${fromIcu ? ' · позначено як виконане' : ''} · <a href="${activityUrl(id)}" target="_blank" rel="noopener">відкрити заїзд</a>`
      : 'Завантажено в intervals.icu ✓';
    btn.hidden = true;
  } catch (e) {
    status.textContent = `Не вдалося надіслати: ${e.message}`;
    btn.disabled = false;
    btn.textContent = 'Спробувати ще раз';
  }
}

function dayLabel(date) {
  const today = localDate();
  const tomorrow = localDate(new Date(Date.now() + 86400000));
  if (date === today) return 'сьогодні';
  if (date === tomorrow) return 'завтра';
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'numeric' });
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

function fmtGap(gap, v) {
  const sign = gap > 0 ? '+' : '−';
  if (v > 1) return `${sign}${Math.round(Math.abs(gap) / v)} с`;
  return `${sign}${Math.round(Math.abs(gap))} м`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Wire up ----------
$('btn-pause').onclick = togglePause;
let finishArmed = null;
$('btn-finish').onclick = () => {
  const btn = $('btn-finish');
  if (finishArmed) { clearTimeout(finishArmed); finishArmed = null; btn.textContent = 'Завершити'; finishRide(); return; }
  btn.textContent = 'Точно? Ще раз';
  finishArmed = setTimeout(() => { finishArmed = null; btn.textContent = 'Завершити'; }, 3000);
};
$('btn-download').onclick = downloadTCX;
$('btn-again').onclick = () => { $('summary').hidden = true; $('lobby').hidden = false; };
$('sim-power').oninput = () => { $('sim-val').textContent = $('sim-power').value; };
// ---------- Virtual gears & controller actions ----------

const BUTTON_LABELS = {
  shiftUpL: 'перемикач ліво +', shiftDownL: 'перемикач ліво −', shiftUpR: 'перемикач право +', shiftDownR: 'перемикач право −',
  paddleL: 'лівий підрульовий', paddleR: 'правий підрульовий',
  up: '▲', down: '▼', left: '◀', right: '▶', a: 'A', b: 'B', y: 'Y', z: 'Z',
  powerUpL: 'Power-up ліво', powerUpR: 'Power-up право', onOffL: 'вкл. ліво', onOffR: 'вкл. право',
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
    toast('Тренажер не приймає окружність колеса — передачі через нахил');
  });
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
    if (t && t.watts !== null) ride.target = Math.max(0, t.watts + ride.ergBias);
    toast(`ERG ${ride.ergBias >= 0 ? '+' : ''}${ride.ergBias} Вт`);
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
  toast('Інтервал пропущено ⏭');
}

function updateGear() {
  if (!ride) return;
  const inErg = inErgStep();
  $('m-gear-label').textContent = inErg ? 'ERG' : 'Передача';
  $('m-gear').textContent = inErg ? `${ride.ergBias >= 0 ? '+' : ''}${ride.ergBias}` : ride.gear;
  $('m-gear-unit').textContent = inErg ? 'Вт' : `/${GEARS} · ${ratioOf(ride.gear).toFixed(2)}`;
}

window.addEventListener('keydown', (e) => {
  if (!ride) return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  if (e.code === 'BracketRight') shift(+1);
  if (e.code === 'BracketLeft') shift(-1);
  if (e.code === 'ArrowLeft') { e.preventDefault(); steer(-1); }
  if (e.code === 'ArrowRight') { e.preventDefault(); steer(+1); }
  if (e.code === 'KeyN') skipInterval();
  if (ride.simulated && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
    e.preventDefault();
    const s = $('sim-power');
    s.value = Number(s.value) + (e.code === 'ArrowUp' ? 10 : -10);
    s.oninput();
  }
});

initLobby();
