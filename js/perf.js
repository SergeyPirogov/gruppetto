// How smooth the ride runs on this device, for finding lags a rider reports: every frame's interval and the
// time the 3D scene took, summed up in 10 s windows (fps, the slow frames, the worst one, the road built in
// that time). Pure: no DOM, no three.js; the app feeds it and keeps the result.

export const WINDOW_S = 10;
const MAX_WINDOWS = 6 * 60 * 6; // 6 h of 10 s windows; a longer ride keeps its last 6 h
const LONG_MS = 50;             // a frame this long is a visible stutter (under 20 fps for that moment)

/** The p-th fraction (0..1) of an array of numbers, by sorting a copy. */
export function quantile(a, p) {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

export class PerfLog {
  constructor() { this.windows = []; this._reset(0); this.frames = 0; this.longFrames = 0; }

  _reset(t) { this.w = { t0: t, gaps: [], scene: 0, build: 0, builds: 0, worst: 0, long: 0 }; }

  /**
   * One frame: `t` s into the ride (the clock the windows are cut on), `gapMs` since the frame before, `sceneMs`
   * the 3D scene's own time in it, `buildMs`/`builds` the road built in that frame, `extra` what to keep with
   * the window (pixel scale, distance) as of its last frame.
   */
  frame(t, gapMs, sceneMs = 0, buildMs = 0, builds = 0, extra = null) {
    const w = this.w;
    if (gapMs > 0 && gapMs < 5000) { // a longer gap is a tab in the background, not a frame
      w.gaps.push(gapMs);
      if (gapMs > w.worst) w.worst = gapMs;
      if (gapMs > LONG_MS) { w.long++; this.longFrames++; }
      this.frames++;
    }
    w.scene += sceneMs; w.build += buildMs; w.builds += builds;
    if (extra) w.extra = extra;
    if (t - w.t0 >= WINDOW_S) this._close(t);
  }

  _close(t) {
    const w = this.w, n = w.gaps.length;
    if (n) {
      const total = w.gaps.reduce((s, g) => s + g, 0);
      this.windows.push({
        t: Math.round(w.t0), fps: Math.round((n / total) * 10000) / 10, p95: Math.round(quantile(w.gaps, 0.95)),
        worst: Math.round(w.worst), long: w.long, scene: Math.round((w.scene / n) * 10) / 10,
        build: Math.round(w.build), builds: w.builds, ...(w.extra || {}),
      });
      if (this.windows.length > MAX_WINDOWS) this.windows.shift();
    }
    this._reset(t);
  }

  /** The whole ride in a line: median fps, the share of windows under 30 fps, the stutters, the worst frame. */
  summary() {
    const W = this.windows;
    if (!W.length) return null;
    return {
      windows: W.length, fps: quantile(W.map((w) => w.fps), 0.5), lowFps: quantile(W.map((w) => w.fps), 0.05),
      under30: Math.round((W.filter((w) => w.fps < 30).length / W.length) * 100), longFrames: this.longFrames,
      worst: W.reduce((m, w) => Math.max(m, w.worst), 0), scene: quantile(W.map((w) => w.scene), 0.5),
    };
  }

  /** What a rider sends: the device, the summary, then a row per window (compact text, fits in a chat message). */
  report(env = {}) {
    const s = this.summary();
    const head = Object.entries(env).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}: ${v}`);
    const sum = s ? [`fps median ${s.fps}, low 5% ${s.lowFps}, ${s.under30}% of the time under 30 fps, ${s.longFrames} frames over ${LONG_MS} ms, worst ${s.worst} ms, scene ${s.scene} ms/frame`] : ['no frames'];
    const cols = 't fps p95 worst long scene build builds q km';
    const rows = this.windows.map((w) => [w.t, w.fps, w.p95, w.worst, w.long, w.scene, w.build, w.builds, w.q ?? '', w.km ?? ''].join(' '));
    return [...head, ...sum, cols, ...rows].join('\n');
  }
}
