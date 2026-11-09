// The mini window (picture-in-picture): the numbers in a small window that stays on top of other apps,
// so you can watch a film, the football or YouTube and still see your power, heart rate and the interval.
//
// Two ways, the best the browser has:
//  - Document Picture-in-Picture (Chrome / Edge 116+ on a computer): a real little page — sharp text, resizable,
//    the keyboard works in it, and its timer keeps the ride going while our tab is hidden.
//  - Video picture-in-picture (Safari, Chrome on Android, …): the board is drawn on a canvas and shown as a
//    video, which the system floats over other apps.

let mode = null;      // 'document' | 'video' while open
let win = null;       // the document PiP window
let video = null, canvas = null;
let els = null;       // the PiP window's elements
let last = null;      // the last state, to redraw after a resize
let onClosed = null;

export function pipSupport() {
  if (typeof window === 'undefined') return null;
  if ('documentPictureInPicture' in window) return 'document';
  const v = document.createElement('video');
  if (document.pictureInPictureEnabled && HTMLCanvasElement.prototype.captureStream && v.requestPictureInPicture) return 'video';
  if (typeof v.webkitSupportsPresentationMode === 'function' && v.webkitSupportsPresentationMode('picture-in-picture') && HTMLCanvasElement.prototype.captureStream) return 'video';
  return null;
}

export const pipOpen = () => mode !== null;

/**
 * Open the mini window (needs a click or a key press). `opts`: { onClose, onKey(e), onPause, heartbeat }
 * — `heartbeat` is called every 250 ms from the PiP window, whose timers are not slowed down like a hidden tab's.
 */
export async function openPip(opts = {}) {
  if (mode) return true;
  onClosed = opts.onClose || null;
  const how = pipSupport();
  if (how === 'document') {
    try {
      win = await window.documentPictureInPicture.requestWindow({ width: 340, height: 196 });
    } catch { win = null; }
    if (win) {
      mode = 'document';
      buildDocument(win, opts);
      if (last) updatePip(last);
      return true;
    }
  }
  if (how) return openVideo();
  return false;
}

export function closePip() {
  if (mode === 'document') win?.close();
  else if (mode === 'video') {
    if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
    else if (video?.webkitPresentationMode === 'picture-in-picture') video.webkitSetPresentationMode('inline');
  }
  closed();
}

function closed() {
  if (!mode) return;
  mode = null; win = null; els = null;
  if (video) { video.srcObject?.getTracks().forEach((t) => t.stop()); video.remove(); video = null; canvas = null; }
  const cb = onClosed; onClosed = null;
  cb?.();
}

// ---------- Document PiP ----------
const CSS = `
:root { color-scheme: dark; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; background: #0f1420; color: #e8edf5; overflow: hidden; user-select: none; }
body { display: flex; flex-direction: column; justify-content: center; padding: 2.2vh 3vw; gap: 2.4vh; }
.top { display: grid; grid-template-columns: 1.7fr 1fr 1fr; gap: 3vw; align-items: end; }
.cell { display: flex; flex-direction: column; min-width: 0; }
.cell label { font-size: clamp(9px, 5.4vh, 15px); color: #8d98ab; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; display: flex; gap: .4em; align-items: center; }
.cell b { font-variant-numeric: tabular-nums; line-height: 1; font-weight: 800; font-size: clamp(18px, min(20vh, 12vw), 120px); }
.cell.power b { font-size: clamp(26px, min(30vh, 19vw), 180px); }
.cell small { font-size: clamp(9px, 5.4vh, 15px); color: #8d98ab; white-space: nowrap; }
.unit { font-size: .38em; font-weight: 600; color: #8d98ab; margin-left: .15em; }
.tag { font-size: .85em; font-weight: 800; color: #0f1420; border-radius: 4px; padding: 0 .35em; }
.row { display: flex; justify-content: space-between; gap: 2vw; font-variant-numeric: tabular-nums; font-size: clamp(11px, 8vh, 26px); font-weight: 700; white-space: nowrap; }
.row span { color: #8d98ab; font-weight: 600; font-size: .7em; margin-left: .2em; }
.wk { display: flex; justify-content: space-between; gap: 2vw; background: #182030; border-radius: 8px; padding: 1.2vh 2.5vw; font-size: clamp(11px, 8vh, 26px); font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
.wk i { font-style: normal; color: #8d98ab; font-weight: 600; font-size: .62em; margin-right: .3em; text-transform: uppercase; }
.wbal { height: max(4px, 2.4vh); border-radius: 99px; background: #2a3448; overflow: hidden; flex: none; }
.wbal > div { height: 100%; width: 100%; background: #4ade80; transform-origin: left; transition: transform .4s; }
.paused { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(15,20,32,.7); font-size: clamp(16px, 16vh, 60px); font-weight: 800; letter-spacing: .1em; }
.pause-btn { position: fixed; top: 4px; right: 4px; width: 28px; height: 28px; padding: 0; border-radius: 8px; border: 1px solid #2a3448; background: #273249cc; color: #e8edf5; font-size: 14px; cursor: pointer; opacity: 0; transition: opacity .2s; z-index: 2; }
body:hover .pause-btn, .pause-btn:focus-visible { opacity: 1; }
.c-ok { color: #4ade80 !important; } .c-warn { color: #fbbf24 !important; } .c-bad { color: #f87171 !important; }
`;

function buildDocument(w, opts) {
  const d = w.document;
  d.title = 'Gruppetto';
  const style = d.createElement('style');
  style.textContent = CSS;
  d.head.append(style);
  d.body.innerHTML = `
    <div class="top">
      <div class="cell power"><label><span data-l="power"></span><span class="tag" data-v="zone"></span></label><b><span data-v="power">0</span><span class="unit" data-l="W"></span></b><small data-v="wkg"></small></div>
      <div class="cell"><label><span data-l="hr"></span><span class="tag" data-v="hrZone" hidden></span></label><b data-v="hr">—</b><small data-v="hrAvg"></small></div>
      <div class="cell"><label data-l="cad"></label><b data-v="cad">0</b><small data-v="cadTarget"></small></div>
    </div>
    <div class="wk" data-v="wk" hidden><div><i data-l="target"></i><span data-v="target"></span></div><div><i data-l="interval"></i><span data-v="left"></span></div><div><i data-l="next"></i><span data-v="next"></span></div></div>
    <div class="row"><div data-v="time">0:00</div><div><b data-v="speed">0.0</b><span data-l="kmh"></span></div><div><b data-v="dist">0.00</b><span data-l="km"></span></div><div data-v="grade">0.0%</div></div>
    <div class="wbal" data-v="wbalBox" title="W′bal"><div data-v="wbal"></div></div>
    <button class="pause-btn" data-v="pauseBtn">⏸</button>
    <div class="paused" data-v="paused" hidden></div>`;
  els = {};
  for (const el of d.querySelectorAll('[data-v]')) els[el.dataset.v] = el;
  els.labels = [...d.querySelectorAll('[data-l]')];
  els.pauseBtn.onclick = () => opts.onPause?.();
  if (opts.onKey) d.addEventListener('keydown', (e) => opts.onKey(e));
  if (opts.heartbeat) w.setInterval(opts.heartbeat, 250);
  w.addEventListener('pagehide', closed, { once: true });
}

const setText = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };

function updateDocument(s) {
  const E = els;
  for (const el of E.labels) setText(el, s.labels?.[el.dataset.l] ?? '');
  setText(E.power, String(s.power));
  E.power.className = s.powerCls || '';
  E.power.style.color = s.powerCls ? '' : s.powerColor || '';
  setText(E.zone, s.zone); E.zone.style.background = s.zoneColor;
  setText(E.wkg, s.wkg);
  setText(E.hr, s.hr); setText(E.hrAvg, s.hrAvg);
  E.hrZone.hidden = !s.hrZone;
  if (s.hrZone) { setText(E.hrZone, s.hrZone); E.hrZone.style.background = s.hrZoneColor; }
  setText(E.cad, s.cad); E.cad.className = s.cadCls || ''; setText(E.cadTarget, s.cadTarget || s.cadAvg || '');
  E.wk.hidden = !s.workout;
  if (s.workout) { setText(E.target, s.target); E.target.className = s.powerCls || ''; setText(E.left, s.left); setText(E.next, s.next); }
  setText(E.time, s.time); setText(E.speed, s.speed); setText(E.dist, s.dist);
  setText(E.grade, s.grade); E.grade.style.color = s.gradeColor;
  E.wbal.style.transform = `scaleX(${s.wbalF.toFixed(3)})`;
  E.wbal.style.background = WBAL[s.wbalLevel] || WBAL.ok;
  E.wbalBox.title = s.wbalTxt;
  E.paused.hidden = !s.paused; setText(E.paused, s.labels?.paused ?? '');
  setText(E.pauseBtn, s.paused ? '▶' : '⏸');
}
const WBAL = { ok: '#4ade80', mid: '#fbbf24', low: '#fb923c', empty: '#f87171' };
const CLS = { 'c-ok': '#4ade80', 'c-warn': '#fbbf24', 'c-bad': '#f87171' };

// ---------- Video PiP ----------
async function openVideo() {
  canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 360;
  video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.autoplay = true;
  // in the page but out of sight: Safari will not float a video that is not in the document
  video.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(video);
  video.srcObject = canvas.captureStream();
  drawCanvas(last); // a stream has no frame until the canvas is drawn after it was made
  video.addEventListener('leavepictureinpicture', closed, { once: true });
  video.addEventListener('webkitpresentationmodechanged', () => { if (video && video.webkitPresentationMode !== 'picture-in-picture') closed(); });
  mode = 'video';
  try {
    if (video.readyState < 1) await new Promise((res) => { video.addEventListener('loadedmetadata', res, { once: true }); setTimeout(res, 1500); });
    await video.play().catch(() => {});
    if (video.requestPictureInPicture) await video.requestPictureInPicture();
    else video.webkitSetPresentationMode('picture-in-picture');
    return true;
  } catch {
    closed();
    return false;
  }
}

function drawCanvas(s) {
  if (!canvas) return;
  const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  g.fillStyle = '#0f1420'; g.fillRect(0, 0, W, H);
  if (!s) return;
  const font = (px, w = 800) => `${w} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const label = (txt, x, y) => { g.font = font(20, 600); g.fillStyle = '#8d98ab'; g.fillText(txt.toUpperCase(), x, y); };
  const tag = (txt, color, x, y) => {
    g.font = font(18); const w = g.measureText(txt).width + 12;
    g.fillStyle = color; g.beginPath(); g.roundRect?.(x, y - 18, w, 24, 5); g.fill();
    g.fillStyle = '#0f1420'; g.fillText(txt, x + 6, y);
    return w;
  };
  const L = s.labels || {};
  g.textBaseline = 'alphabetic';
  // power
  label(L.power || 'Power', 24, 40);
  tag(s.zone, s.zoneColor, 24 + g.measureText((L.power || 'Power').toUpperCase()).width + 10, 40);
  g.font = font(s.workout ? 110 : 140); g.fillStyle = CLS[s.powerCls] || s.powerColor || '#e8edf5';
  const pw = String(s.power);
  g.fillText(pw, 20, s.workout ? 150 : 175);
  const pwW = g.measureText(pw).width;
  g.font = font(30, 600); g.fillStyle = '#8d98ab'; g.fillText(L.W || 'W', 28 + pwW, s.workout ? 150 : 175);
  g.font = font(20, 600); g.fillText(s.wkg, 24, s.workout ? 180 : 208);
  // heart rate and cadence
  const col = (x, name, val, sub, color, z, zc) => {
    label(name, x, 40);
    if (z) tag(z, zc, x + g.measureText(name.toUpperCase()).width + 10, 40);
    g.font = font(s.workout ? 72 : 88); g.fillStyle = color || '#e8edf5'; g.fillText(val, x, s.workout ? 125 : 150);
    if (sub) { g.font = font(20, 600); g.fillStyle = '#8d98ab'; g.fillText(sub, x, s.workout ? 155 : 182); }
  };
  col(330, L.hr || 'HR', s.hr, s.hrAvg, null, s.hrZone, s.hrZoneColor);
  col(490, L.cad || 'Cadence', s.cad, s.cadTarget || s.cadAvg, CLS[s.cadCls]);
  // the interval
  if (s.workout) {
    g.fillStyle = '#182030'; g.beginPath(); g.roundRect?.(16, 200, W - 32, 62, 10); g.fill();
    const cells = [[L.target, s.target, CLS[s.powerCls]], [L.interval, s.left], [L.next, s.next]];
    cells.forEach(([k, v, c], i) => {
      const x = 32 + i * ((W - 64) / 3);
      g.font = font(16, 600); g.fillStyle = '#8d98ab'; g.fillText(String(k || '').toUpperCase(), x, 224);
      g.font = font(30); g.fillStyle = c || '#e8edf5'; g.fillText(String(v), x, 254);
    });
  }
  // time, speed, distance, grade
  const y = s.workout ? 308 : 290;
  g.font = font(34);
  const bits = [[s.time, ''], [s.speed, L.kmh], [s.dist, L.km], [s.grade, '', s.gradeColor]];
  bits.forEach(([v, u, c], i) => {
    const x = 24 + i * 152;
    g.font = font(34); g.fillStyle = c || '#e8edf5'; g.fillText(v, x, y);
    if (u) { const w = g.measureText(v).width; g.font = font(18, 600); g.fillStyle = '#8d98ab'; g.fillText(u, x + w + 5, y); }
  });
  // W′bal
  g.fillStyle = '#2a3448'; g.fillRect(24, H - 30, W - 48, 10);
  g.fillStyle = WBAL[s.wbalLevel] || WBAL.ok; g.fillRect(24, H - 30, (W - 48) * s.wbalF, 10);
  if (s.paused) {
    g.fillStyle = 'rgba(15,20,32,.75)'; g.fillRect(0, 0, W, H);
    g.font = font(64); g.fillStyle = '#e8edf5'; g.textAlign = 'center'; g.fillText(L.paused || 'PAUSED', W / 2, H / 2 + 22); g.textAlign = 'left';
  }
}

/** The numbers, once a second (and on pause). */
export function updatePip(s) {
  last = s;
  if (mode === 'document' && els) updateDocument(s);
  else if (mode === 'video') drawCanvas(s);
}

/** Forget the last numbers (a new ride starts from scratch). */
export function resetPip() { last = null; }
