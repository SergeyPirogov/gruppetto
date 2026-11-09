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
/** Video picture-in-picture is there (a canvas shown as a video): Safari, Chrome, Edge, Android. */
function videoPipOk() {
  const v = document.createElement('video');
  return !!HTMLCanvasElement.prototype.captureStream && (!!(document.pictureInPictureEnabled && v.requestPictureInPicture)
    || (typeof v.webkitSupportsPresentationMode === 'function' && v.webkitSupportsPresentationMode('picture-in-picture')));
}

/**
 * Open the mini window (needs a click or a key press). `opts`: { onClose, onKey(e), onPause, heartbeat }
 * — `heartbeat` is called every 250 ms from the PiP window, whose timers are not slowed down like a hidden tab's.
 */
export async function openPip(opts = {}) {
  if (mode) return true;
  onClosed = opts.onClose || null;
  const how = pipSupport();
  // «clean»: the board as a video, which Chrome floats without its address strip (where video PiP is there)
  if (opts.clean && videoPipOk()) return openVideo(opts);
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
  if (how) return openVideo(opts);
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
  beat?.terminate(); beat = null;
  if (video) { video.srcObject?.getTracks().forEach((t) => t.stop()); video.remove(); video = null; canvas = null; }
  const cb = onClosed; onClosed = null;
  cb?.();
}

// ---------- Document PiP ----------
const CSS = `
:root { color-scheme: dark; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --zc: #8a94a6; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; overflow: hidden; user-select: none; color: #e8edf5; }
/* the window tinted by the power zone you ride in: Z2 or Z4 is seen from the corner of an eye, over the football */
body { display: flex; flex-direction: column; justify-content: space-evenly; padding: 3vh 4vw; gap: 2vh;
  /* the top in the grey of Chrome's own strip over the window (the site's address), so the strip reads as part of
     the panel; the zone's glow from the bottom corner, away from it */
  background: radial-gradient(120% 90% at 0% 100%, color-mix(in srgb, var(--zc) 28%, transparent), transparent 65%), linear-gradient(180deg, #202124 0%, #161b26 38%, #0c111b 100%);
  transition: background .6s; }
.top { display: grid; grid-template-columns: 1.7fr 1fr 1fr; gap: 5vw; align-items: end; }
.cell { display: flex; flex-direction: column; justify-content: flex-end; min-width: 0; }
.cell.power { --c: var(--zc); } .cell.hr { --c: #ff4d5e; } .cell.cad { --c: #2fd4f0; }
.cell label { font-size: clamp(9px, min(5.4vh, 4.4vw), 15px); color: var(--c, #9fb0c6); font-weight: 700; text-transform: uppercase; letter-spacing: .06em; white-space: nowrap; display: flex; gap: .4em; align-items: center; }
.cell b { font-variant-numeric: tabular-nums; line-height: 1; font-weight: 800; font-size: clamp(18px, min(20vh, 11vw), 120px); }
.cell.power b { font-size: clamp(26px, min(30vh, 17vw), 180px); }
.cell small { font-size: clamp(9px, min(5vh, 4vw), 14px); color: #9fb0c6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.unit { font-size: .36em; font-weight: 600; color: #9fb0c6; margin-left: .15em; }
.tag { font-size: .85em; font-weight: 800; color: #0f1420; border-radius: 4px; padding: 0 .35em; }
.row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 2vw; font-variant-numeric: tabular-nums; font-size: clamp(11px, 7.5vh, 24px); font-weight: 700; white-space: nowrap; padding-top: 1.4vh; border-top: 1px solid rgba(255,255,255,.08); }
.row > div { overflow: hidden; text-overflow: ellipsis; }
.row > div:last-child { text-align: right; }
.row span { color: #9fb0c6; font-weight: 600; font-size: .66em; margin-left: .2em; }
/* the interval: target, time left and what comes next, over a bar of how far into it you are */
.wk { position: relative; display: flex; justify-content: space-between; gap: 2vw; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: 1.4vh 2.8vw 2.2vh; font-size: clamp(11px, 8vh, 26px); font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
.wk i { font-style: normal; color: #9fb0c6; font-weight: 600; font-size: .6em; margin-right: .3em; text-transform: uppercase; }
.wk .wk-bar { position: absolute; left: 0; bottom: 0; height: max(3px, 1.2vh); width: 100%; background: var(--zc); transform-origin: left; transition: transform .9s linear; opacity: .9; }
.wk.soon { animation: soon 1s ease-in-out infinite; }
@keyframes soon { 50% { border-color: #fbbf24; } }
.wbal { height: max(4px, 2.2vh); border-radius: 99px; background: rgba(255,255,255,.1); overflow: hidden; flex: none; }
.wbal > div { height: 100%; width: 100%; background: #a78bfa; transform-origin: left; transition: transform .4s; }
.paused { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(12,17,27,.75); font-size: clamp(16px, 16vh, 60px); font-weight: 800; letter-spacing: .1em; }
.pause-btn { position: fixed; top: 4px; right: 4px; width: 28px; height: 28px; padding: 0; border-radius: 8px; border: 1px solid #2a3448; background: #273249cc; color: #e8edf5; font-size: 14px; cursor: pointer; opacity: 0; transition: opacity .2s; z-index: 2; }
body:hover .pause-btn, .pause-btn:focus-visible { opacity: 1; }
.c-ok { color: #4ade80 !important; } .c-warn { color: #fbbf24 !important; } .c-bad { color: #f87171 !important; }
/* layouts by the window's size: small = power and heart rate only, big; narrow = in a column */
@media (max-height: 150px), (max-width: 240px) { .row, .wbal, .cell.cad, .cell small { display: none; } .top { grid-template-columns: 1.4fr 1fr; } .wk { padding-bottom: 1.8vh; } .wk > div:nth-child(3) { display: none; } }
@media (max-width: 240px) { .wk { flex-direction: column; gap: .8vh; font-size: clamp(11px, 9vw, 22px); } .wk > div:nth-child(3) { display: none; } }
@media (max-width: 300px) { .row > div:nth-child(4) { display: none; } .row { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-aspect-ratio: 3/4) and (min-height: 260px) { .top { grid-template-columns: 1fr; gap: 2vh; } .cell b { font-size: clamp(22px, 12vw, 110px); } .cell.power b { font-size: clamp(30px, 22vw, 160px); } .row { grid-template-columns: 1fr 1fr; row-gap: 1vh; } .row > div:last-child { text-align: left; } }
`;

function buildDocument(w, opts) {
  const d = w.document;
  d.title = 'Gruppetto';
  // some Chrome versions paint the window's strip in the page's theme colour: the same grey as the top of the panel
  const theme = d.createElement('meta');
  theme.name = 'theme-color'; theme.content = '#202124';
  d.head.append(theme);
  const style = d.createElement('style');
  style.textContent = CSS;
  d.head.append(style);
  d.body.innerHTML = `
    <div class="top">
      <div class="cell power"><label><span data-l="power"></span><span class="tag" data-v="zone"></span></label><b><span data-v="power">0</span><span class="unit" data-l="W"></span></b><small data-v="wkg"></small></div>
      <div class="cell hr"><label><span data-l="hr"></span><span class="tag" data-v="hrZone" hidden></span></label><b data-v="hr">—</b><small data-v="hrAvg"></small></div>
      <div class="cell cad"><label data-l="cad"></label><b data-v="cad">0</b><small data-v="cadTarget"></small></div>
    </div>
    <div class="wk" data-v="wk" hidden><div><i data-l="target"></i><span data-v="target"></span></div><div><i data-l="interval"></i><span data-v="left"></span></div><div><i data-l="next"></i><span data-v="next"></span></div><i class="wk-bar" data-v="wkBar"></i></div>
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
  E.zone.ownerDocument.documentElement.style.setProperty('--zc', s.power > 0 ? s.zoneColor : '#8a94a6');
  setText(E.wkg, s.wkg);
  setText(E.hr, s.hr); setText(E.hrAvg, s.hrAvg);
  E.hrZone.hidden = !s.hrZone;
  if (s.hrZone) { setText(E.hrZone, s.hrZone); E.hrZone.style.background = s.hrZoneColor; }
  setText(E.cad, s.cad); E.cad.className = s.cadCls || ''; setText(E.cadTarget, s.cadTarget || s.cadAvg || '');
  E.wk.hidden = !s.workout;
  if (s.workout) {
    setText(E.target, s.target); E.target.className = s.powerCls || ''; setText(E.left, s.left); setText(E.next, s.next);
    E.wkBar.style.transform = `scaleX(${(s.stepF ?? 0).toFixed(3)})`;
    E.wk.classList.toggle('soon', (s.stepLeft ?? 99) <= 10); // the last 10 s before the change
  }
  setText(E.time, s.time); setText(E.speed, s.speed); setText(E.dist, s.dist);
  setText(E.grade, s.grade); E.grade.style.color = s.gradeColor;
  E.wbal.style.transform = `scaleX(${s.wbalF.toFixed(3)})`;
  E.wbal.style.background = s.wbalLevel === 'ok' ? '#a78bfa' : WBAL[s.wbalLevel];
  E.wbalBox.title = s.wbalTxt;
  E.paused.hidden = !s.paused; setText(E.paused, s.labels?.paused ?? '');
  setText(E.pauseBtn, s.paused ? '▶' : '⏸');
}
const WBAL = { ok: '#4ade80', mid: '#fbbf24', low: '#fb923c', empty: '#f87171' };
const CLS = { 'c-ok': '#4ade80', 'c-warn': '#fbbf24', 'c-bad': '#f87171' };

// ---------- Video PiP ----------
let beat = null; // the heartbeat worker while the board is a video
/**
 * A hidden tab's timers slow down to once a minute; a worker's do not: it keeps the ride going (and the board
 * drawn) while you watch something in another tab.
 */
function startBeat(fn) {
  if (!fn || typeof Worker === 'undefined') return;
  try {
    const url = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 250);'], { type: 'text/javascript' }));
    beat = new Worker(url);
    beat.onmessage = () => fn();
    URL.revokeObjectURL(url);
  } catch { beat = null; }
}
async function openVideo(opts = {}) {
  canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720; // drawn big: the system scales it down, the text stays sharp
  video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.autoplay = true;
  // in the page but out of sight: Safari will not float a video that is not in the document
  video.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(video);
  video.srcObject = canvas.captureStream();
  startBeat(opts.heartbeat);
  // a name for the video: some Chrome versions show it over the window on hover instead of the site's address
  try { if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: 'Gruppetto', artist: 'Ride', artwork: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }] }); } catch { /* not there */ }
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
  const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height, k = W / 640; // drawn at 640×360, scaled up
  g.setTransform(k, 0, 0, k, 0, 0);
  const w = 640, h = 360, zc = s && s.power > 0 ? s.zoneColor : '#8a94a6';
  // the panel, as the sharp window: dark, the zone's glow from the bottom corner
  const bg = g.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#161b26'); bg.addColorStop(1, '#0c111b');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  const glow = g.createRadialGradient(0, h, 10, 0, h, 520); glow.addColorStop(0, hexA(zc, 0.32)); glow.addColorStop(1, hexA(zc, 0));
  g.fillStyle = glow; g.fillRect(0, 0, w, h);
  if (!s) return;
  const font = (px, wt = 800) => `${wt} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const muted = '#9fb0c6';
  const tag = (txt, color, x, y) => {
    g.font = font(17); const tw = g.measureText(txt).width + 12;
    g.fillStyle = color; g.beginPath(); g.roundRect?.(x, y - 17, tw, 23, 5); g.fill();
    g.fillStyle = '#0f1420'; g.fillText(txt, x + 6, y);
  };
  const L = s.labels || {};
  const wk = !!s.workout;
  // three columns, each with its colour bar, as on the ride board
  // the whole height used: without a workout the numbers are bigger and the bottom row lower (it left a third empty)
  const top = 24, vy = wk ? 124 : 186, subY = vy + 30;
  const col = (x, bar, name, val, unit, sub, color, z, zc2, big) => {
    // the number's colour in its name (no bar beside it), the name just over its number
    const px = big ? (wk ? 96 : 150) : (wk ? 58 : 70), ly = big ? top + 18 : vy - px * 0.78 - 10;
    g.font = font(17, 700); g.fillStyle = bar; g.fillText(name.toUpperCase(), x + 16, ly);
    if (z) tag(z, zc2, x + 22 + g.measureText(name.toUpperCase()).width, ly);
    g.font = font(px); g.fillStyle = color || '#e8edf5';
    g.fillText(val, x + 14, vy);
    if (unit) { const vw = g.measureText(val).width; g.font = font(28, 600); g.fillStyle = muted; g.fillText(unit, x + 20 + vw, vy); }
    if (sub) { g.font = font(17, 600); g.fillStyle = muted; g.fillText(sub, x + 16, subY); }
  };
  col(18, zc, L.power || 'Power', String(s.power), L.W || 'W', s.wkg, CLS[s.powerCls] || s.powerColor || '#e8edf5', s.zone, s.zoneColor, true);
  col(352, '#ff4d5e', L.hr || 'HR', s.hr, '', s.hrAvg, null, s.hrZone, s.hrZoneColor);
  col(512, '#2fd4f0', L.cad || 'Cadence', s.cad, '', s.cadTarget || s.cadAvg, CLS[s.cadCls]);
  // the interval: target, time left, next, over a bar of how far into it you are
  let y = subY + 22;
  if (wk) {
    const soon = (s.stepLeft ?? 99) <= 10 && Math.floor(Date.now() / 500) % 2 === 0;
    g.fillStyle = 'rgba(255,255,255,.06)'; g.beginPath(); g.roundRect?.(16, y, w - 32, 64, 10); g.fill();
    g.strokeStyle = soon ? '#fbbf24' : 'rgba(255,255,255,.1)'; g.lineWidth = 2; g.stroke();
    const cells = [[L.target, s.target, CLS[s.powerCls]], [L.interval, s.left], [L.next, s.next]];
    cells.forEach(([lab, v, c], i) => {
      const x = 32 + i * ((w - 64) / 3);
      g.font = font(15, 600); g.fillStyle = muted; g.fillText(String(lab || '').toUpperCase(), x, y + 24);
      g.font = font(28); g.fillStyle = c || '#e8edf5'; g.fillText(String(v), x, y + 54);
    });
    g.fillStyle = zc; g.fillRect(16, y + 60, (w - 32) * Math.max(0, Math.min(1, s.stepF ?? 0)), 4);
    y += 80;
  }
  // time, speed, distance, grade, under a thin line
  if (!wk) y += 6;
  g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(18, y, w - 36, 1);
  y += wk ? 38 : 46;
  const bits = [[s.time, ''], [s.speed, L.kmh], [s.dist, L.km], [s.grade, '', s.gradeColor]];
  bits.forEach(([v, u, c], i) => {
    const x = 22 + i * 152;
    g.font = font(wk ? 30 : 36); g.fillStyle = c || '#e8edf5'; g.fillText(v, x, y);
    if (u) { const vw = g.measureText(v).width; g.font = font(17, 600); g.fillStyle = muted; g.fillText(u, x + vw + 5, y); }
  });
  // W′bal: violet, amber to red as it runs low
  // W′bal right under the bottom row (the very edge of the video can be cut by the window)
  const by = Math.min(h - 26, y + 18);
  g.fillStyle = 'rgba(255,255,255,.1)'; g.beginPath(); g.roundRect?.(22, by, w - 44, 9, 5); g.fill();
  g.fillStyle = s.wbalLevel === 'ok' ? '#a78bfa' : WBAL[s.wbalLevel]; g.beginPath(); g.roundRect?.(22, by, (w - 44) * s.wbalF, 9, 5); g.fill();
  if (s.paused) {
    g.fillStyle = 'rgba(12,17,27,.75)'; g.fillRect(0, 0, w, h);
    g.font = font(64); g.fillStyle = '#e8edf5'; g.textAlign = 'center'; g.fillText(L.paused || 'PAUSED', w / 2, h / 2 + 22); g.textAlign = 'left';
  }
}
/** A colour (#rrggbb) with an alpha, for gradients. */
function hexA(hex, a) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : `rgba(138,148,166,${a})`;
}

/** The numbers, once a second (and on pause). */
export function updatePip(s) {
  last = s;
  if (mode === 'document' && els) updateDocument(s);
  else if (mode === 'video') drawCanvas(s);
}

/** Forget the last numbers (a new ride starts from scratch). */
export function resetPip() { last = null; }
