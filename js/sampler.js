// Time-stamped sensor samples, averaged per recording second (like a bike computer's 1 s recording).

export class Sampler {
  constructor(staleMs = 3000) {
    this.staleMs = staleMs;
    this.items = []; // [{t, v}], t in ms (performance.now clock)
  }

  add(t, v) {
    this.items.push({ t, v });
    if (this.items.length > 400) this.items.splice(0, this.items.length - 300);
  }

  clear() { this.items = []; }

  /** Last value if it is fresh at time t, otherwise 0. */
  latest(t) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const s = this.items[i];
      if (s.t <= t) return t - s.t <= this.staleMs ? s.v : 0;
    }
    return 0;
  }

  /** Mean of samples in (t0, t1]; when there are none, the fresh latest value before t1. */
  mean(t0, t1) {
    let sum = 0, n = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const s = this.items[i];
      if (s.t <= t0) break;
      if (s.t <= t1) { sum += s.v; n++; }
    }
    return n ? sum / n : this.latest(t1);
  }

  /** True if at least one sample falls in (t0, t1]. */
  has(t0, t1) {
    return this.items.some((s) => s.t > t0 && s.t <= t1);
  }
}
