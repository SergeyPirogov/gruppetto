// Colour mixing for the sky and the light, and the blend from one time of day to the next during a ride.
// Apart from render3d so it can be tested without three.js.

export const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
export const mixHex = (a, b, t) => '#' + mixRgb(hexRgb(a), hexRgb(b), t).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/**
 * Part way from one atmosphere to another (k 0…1): colours and numbers blend, switches (night, rain, the sun shown)
 * flip at the middle. For the time of day changing during a ride without a jump.
 */
export function blendAtmosphere(a, b, k) {
  const num = (x, y) => (x ?? y) + ((y ?? x) - (x ?? y)) * k;
  const hex = (x, y) => (x && y ? mixHex(x, y, k) : k < 0.5 ? x : y);
  const late = k >= 0.5 ? b : a;
  const t = { ...late.t, sky: a.t.sky.map((c, i) => mixHex(c, b.t.sky[i], k)), fog: mixRgb(a.t.fog, b.t.fog, k) };
  return { ...late, t, sunY: num(a.sunY, b.sunY), light: hex(a.light, b.light), lightI: num(a.lightI, b.lightI), hemi: num(a.hemi, b.hemi),
    hemiColor: hex(a.hemiColor || a.t.sky[1], b.hemiColor || b.t.sky[1]), exposure: num(a.exposure, b.exposure), glow: hex(a.glow, b.glow),
    disk: hex(a.disk, b.disk), diskSize: a.diskSize && b.diskSize ? num(a.diskSize, b.diskSize) : late.diskSize, dim: num(a.dim, b.dim),
    fogNear: num(a.fogNear, b.fogNear), fogFar: num(a.fogFar, b.fogFar) };
}

/**
 * «Changeable» weather during a ride: what comes after `now`, and for how long (s). A dry spell of 6–12 min, then
 * rain (three times in four) or fog for 4–8 min, then dry again. `r1`, `r2`: random numbers 0…1.
 */
export function nextWeather(now, r1 = Math.random(), r2 = Math.random()) {
  if (now === 'clear') return { sky: r1 < 0.75 ? 'rain' : 'fog', for: 240 + r2 * 240 };
  return { sky: 'clear', for: 360 + r2 * 360 };
}
