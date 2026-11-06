import { bluetoothAvailable, Trainer, HeartRateMonitor } from './ble.js';
import { stepSpeed } from './physics.js';
import { routes } from './routes.js';
import { workouts, targetAt, totalDuration, stepWatts, zoneColor } from './workouts.js';
import { Recorder } from './recorder.js';
import { Scene, drawProfile } from './render.js';

const $ = (id) => document.getElementById(id);

// ---------- Settings ----------
const DEFAULT_SETTINGS = { name: 'Я', weight: 75, ftp: 200, difficulty: 50, routeId: 'rolling', mode: 'free' };
let settings = { ...DEFAULT_SETTINGS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('powerup.settings') || '{}')); } catch { /* storage unavailable */ }
const saveSettings = () => { try { localStorage.setItem('powerup.settings', JSON.stringify(settings)); } catch { /* ignore */ } };

// ---------- Devices & live data ----------
const trainer = new Trainer();
const hrm = new HeartRateMonitor();
const live = { power: 0, cadence: 0, hr: 0, powerAt: 0, cadAt: 0, hrAt: 0 };

trainer.addEventListener('data', ({ detail: d }) => {
  const now = performance.now();
  if (d.power !== undefined) { live.power = Math.max(0, d.power); live.powerAt = now; }
  if (d.cadence !== undefined) { live.cadence = d.cadence; live.cadAt = now; }
  if (d.heartRate && !hrm.connected) { live.hr = d.heartRate; live.hrAt = now; }
});
hrm.addEventListener('data', ({ detail: d }) => { live.hr = d.heartRate; live.hrAt = performance.now(); });
trainer.addEventListener('disconnect', () => { updateDeviceUI(); toast('Тренажер відключився'); });
hrm.addEventListener('disconnect', () => { updateDeviceUI(); toast('Пульсометр відключився'); });

function updateDeviceUI() {
  $('trainer-status').textContent = trainer.connected
    ? `${trainer.name} · ${trainer.controllable ? 'керування ERG/нахил ✓' : 'лише дані'}`
    : 'не підключено';
  $('btn-trainer').textContent = trainer.connected ? 'Відключити' : 'Підключити';
  $('btn-trainer').classList.toggle('ok', trainer.connected);
  $('hr-status').textContent = hrm.connected ? hrm.name : 'не підключено';
  $('btn-hr').textContent = hrm.connected ? 'Відключити' : 'Підключити';
  $('btn-hr').classList.toggle('ok', hrm.connected);
}

async function toggleDevice(dev, btn) {
  if (dev.connected) { dev.disconnect(); updateDeviceUI(); return; }
  btn.disabled = true;
  btn.textContent = 'Пошук…';
  try {
    await dev.connect();
    if (dev === trainer) $('sim').checked = false;
  } catch (e) {
    if (e.name !== 'NotFoundError') {
      const status = dev === trainer ? $('trainer-status') : $('hr-status');
      setTimeout(() => { status.textContent = `Не вдалося підключитися: ${e.message}`; }, 0);
    }
  } finally {
    btn.disabled = false;
    updateDeviceUI();
  }
}

// ---------- Lobby ----------
function initLobby() {
  if (!bluetoothAvailable()) {
    $('bt-warning').hidden = false;
    $('btn-trainer').disabled = true;
    $('btn-hr').disabled = true;
    $('sim').checked = true;
  }
  $('btn-trainer').onclick = () => toggleDevice(trainer, $('btn-trainer'));
  $('btn-hr').onclick = () => toggleDevice(hrm, $('btn-hr'));

  const bind = (id, key, num = true) => {
    const el = $(id);
    el.value = settings[key];
    el.oninput = () => { settings[key] = num ? Number(el.value) : el.value; saveSettings(); refreshDiff(); };
  };
  bind('f-name', 'name', false);
  bind('f-weight', 'weight');
  bind('f-ftp', 'ftp');
  bind('f-diff', 'difficulty');
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
    requestAnimationFrame(() => drawProfile(b.querySelector('canvas'), r, []));
  }
  markSelected(rl, settings.routeId);

  $('btn-start').onclick = startRide;
  updateDeviceUI();
}

function renderModes() {
  const ml = $('mode-list');
  ml.innerHTML = '';
  const add = (id, title, sub, w) => {
    const b = document.createElement('button');
    b.className = 'option';
    b.dataset.id = id;
    b.innerHTML = `<b>${title}</b><small>${sub}</small>${w ? '<canvas></canvas>' : ''}`;
    b.onclick = () => { settings.mode = id; saveSettings(); markSelected(ml, id); };
    ml.append(b);
    if (w) requestAnimationFrame(() => drawWorkoutChart(b.querySelector('canvas'), w, -1));
  };
  add('free', 'Вільна їзда', 'Тренажер імітує нахил дороги.');
  for (const w of workouts) add(w.id, w.name, `${Math.round(totalDuration(w) / 60)} хв · ${w.description}`, w);
  markSelected(ml, settings.mode);
}

function markSelected(list, id) {
  for (const el of list.children) el.classList.toggle('sel', el.dataset.id === id);
}

// ---------- Ride ----------
const BOTS = [
  { name: 'Оля', wkg: 2.2, color: '#22c55e' },
  { name: 'Тарас', wkg: 2.7, color: '#3b82f6' },
  { name: 'Ірина', wkg: 3.1, color: '#a855f7' },
  { name: 'Богдан', wkg: 3.6, color: '#ef4444' },
];
const ME_COLOR = '#ff7a1a';

let ride = null;
let scene = null;
const recorder = new Recorder();

function startRide() {
  const route = routes.find((r) => r.id === settings.routeId) || routes[0];
  const workout = workouts.find((w) => w.id === settings.mode) || null;
  const simulated = $('sim').checked || !trainer.connected;
  ride = {
    route, workout, simulated,
    dist: 0, v: 0, elapsed: 0, secAcc: 0, workoutT: 0, workoutDone: false,
    gain: 0, lastElev: route.elevAt(0), laps: 0,
    paused: false, pedal: 0, lastFrame: performance.now(),
    powerHist: [], target: workout ? targetAt(workout, 0, settings.ftp).watts : null, lastSentTarget: null, lastSentGrade: null, lastGradeSentAt: 0,
    bots: BOTS.map((b, i) => ({ ...b, dist: 15 + i * 12, v: 0, pedal: i, lane: i % 2 ? -1.6 : 1.6 })),
  };
  recorder.reset();
  $('lobby').hidden = true;
  $('summary').hidden = true;
  $('ride').hidden = false;
  $('sim-ctl').hidden = !simulated;
  $('workout-panel').hidden = !workout;
  $('paused').hidden = true;
  $('btn-pause').textContent = 'Пауза';
  if (!scene) scene = new Scene($('scene'));
  else scene.resize();
  if (simulated) toast('Режим симулятора: потужність — повзунок або ↑/↓');
  requestAnimationFrame(frame);
}

function currentPower() {
  const now = performance.now();
  if (ride.simulated) {
    if (ride.workout && ride.target !== null) return ride.target;
    return Number($('sim-power').value);
  }
  return now - live.powerAt < 3000 ? live.power : 0;
}

function currentCadence(power) {
  if (ride.simulated) return power > 0 ? 88 + Math.sin(ride.elapsed / 7) * 4 : 0;
  return performance.now() - live.cadAt < 3000 ? live.cadence : 0;
}

function currentHr() {
  return performance.now() - live.hrAt < 5000 ? live.hr : 0;
}

function frame(now) {
  if (!ride) return;
  const dt = Math.min(0.1, (now - ride.lastFrame) / 1000);
  ride.lastFrame = now;
  const { route } = ride;
  let moved = 0;

  const power = currentPower();
  const cadence = currentCadence(power);

  if (!ride.paused) {
    const grade = route.gradeAt(ride.dist);
    ride.v = stepSpeed(ride.v, power, grade, dt, settings.weight);
    moved = ride.v * dt;
    ride.dist += moved;
    ride.pedal += (cadence / 60) * Math.PI * 2 * dt;

    for (const b of ride.bots) {
      const g = route.gradeAt(b.dist);
      const p = b.wkg * 75 * (1 + Math.max(-0.6, Math.min(0.35, g * 4)));
      b.v = stepSpeed(b.v, p, g, dt, 75);
      b.dist += b.v * dt;
      b.pedal += (90 / 60) * Math.PI * 2 * dt;
    }

    ride.elapsed += dt;
    ride.secAcc += dt;
    while (ride.secAcc >= 1) { ride.secAcc -= 1; tick(power, cadence); }
  }

  const riders = [
    { dist: ride.dist, color: ME_COLOR, pedal: ride.pedal, self: true, name: settings.name },
    ...ride.bots,
  ];
  scene.render(route, ride.dist, riders, moved);
  requestAnimationFrame(frame);
}

/** Called once per second of riding. */
function tick(power, cadence) {
  const { route } = ride;
  const hr = currentHr();

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
      ride.target = t.watts;
      if (t.remaining <= 5 && t.remaining > 4) toast('Через 5 с — наступний інтервал');
    } else {
      ride.workoutDone = true;
      ride.target = null;
      toast('Тренування виконано! Далі — вільна їзда 🏁');
      if (ride.simulated) $('sim-power').value = Math.round(settings.ftp * 0.5);
    }
  }
  if (!ride.simulated && trainer.controllable) {
    if (ride.target !== null && ride.workout && !ride.workoutDone) {
      if (ride.target !== ride.lastSentTarget) { trainer.setTargetPower(ride.target); ride.lastSentTarget = ride.target; }
    } else {
      const g = Math.round(grade * 100 * (settings.difficulty / 100) * 10) / 10;
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
  const gEl = $('grade');
  gEl.textContent = `${grade >= 0 ? '' : '−'}${Math.abs(grade * 100).toFixed(1)}%`;
  gEl.style.color = grade > 0.06 ? '#ef4444' : grade > 0.03 ? '#f97316' : grade < -0.02 ? '#60a5fa' : '#e8edf5';

  if (ride.workout) {
    const t = targetAt(ride.workout, ride.workoutT, settings.ftp);
    $('wk-target').textContent = ride.workoutDone ? '—' : ride.target ?? '—';
    $('wk-left').textContent = t ? fmtTime(t.remaining) : '0:00';
    const next = t && ride.workout.steps[t.index + 1];
    $('wk-next').textContent = next ? `${stepWatts(next, 0, settings.ftp)} Вт` : '—';
    drawWorkoutChart($('wk-chart'), ride.workout, ride.workoutT);
  }

  const L = ride.route.length;
  const list = [{ name: settings.name, color: ME_COLOR, dist: ride.dist, me: true }, ...ride.bots]
    .map((r) => ({ ...r, gap: ((((r.dist - ride.dist) % L) + L * 1.5) % L) - L / 2 }))
    .sort((a, b) => b.gap - a.gap);
  $('riders').innerHTML = list.map((r) => `<li class="${r.me ? 'me' : ''}"><i style="background:${r.color}"></i><span>${esc(r.name)}</span><em>${r.me ? '' : fmtGap(r.gap, ride.v)}</em></li>`).join('');

  drawProfile($('profile'), ride.route, [...ride.bots, { dist: ride.dist, color: ME_COLOR, self: true }]);
}

function drawWorkoutChart(canvas, w, t) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const total = totalDuration(w);
  const ftp = settings.ftp;
  const maxW = Math.max(...w.steps.map((s) => Math.max(stepWatts(s, 0, ftp), stepWatts(s, 1, ftp)))) * 1.05;
  let x0 = 0;
  for (const s of w.steps) {
    const x1 = x0 + s.dur;
    const a = stepWatts(s, 0, ftp), b = stepWatts(s, 1, ftp);
    ctx.fillStyle = zoneColor(((a + b) / 2) / ftp);
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
  ride.paused = !ride.paused;
  $('paused').hidden = !ride.paused;
  $('btn-pause').textContent = ride.paused ? 'Продовжити' : 'Пауза';
}

function finishRide() {
  if (!ride) return;
  const sum = recorder.summary();
  const wasRamp = ride.workout?.ramp;
  ride = null;
  if (trainer.connected && trainer.controllable) trainer.setSimulation(0);
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
window.addEventListener('keydown', (e) => {
  if (!ride) return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  if (ride.simulated && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
    e.preventDefault();
    const s = $('sim-power');
    s.value = Number(s.value) + (e.code === 'ArrowUp' ? 10 : -10);
    s.oninput();
  }
});

initLobby();
