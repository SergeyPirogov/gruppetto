// A modern road helmet in the low-poly style of the scenery: an elongated, rounded shell whose rim
// sits above the brow and drops to the nape, long vent channels over the top, intakes at the front,
// exhaust ports at the back and a stripe in the rider's colour along each side. Matte and faceted.
//
// Built on a unit sphere (x forward, y up, z right), parametrised by a lateral angle u (0 over the
// middle of the head, ±π/2 at the ears) and a longitudinal angle v (0 at the crown, + toward the
// brow, − toward the nape), then shaped and scaled to the skull.
import * as THREE from 'three';

const onSphere = (u, v, r) => new THREE.Vector3(Math.sin(v) * Math.cos(u) * r, Math.cos(v) * Math.cos(u) * r, Math.sin(u) * r);

/** Lower edge of the shell (unit-sphere y) at forward position x: above the brow, low at the nape. */
const rimY = (x) => -0.27 + 0.3 * x;

/** Helmet shape: a longer, lower tail, a slightly squared front, a flatter crown. */
function shape(p) {
  let { x, y, z } = p;
  if (x < 0) {
    const t = -x;              // 0 at the middle .. 1 at the back
    x *= 1.14;
    z *= 1 - 0.16 * t * t;     // narrows toward the tail
    y -= 0.12 * t * t;         // and drops a little
  } else {
    x *= 1.04;
    z *= 1 + 0.04 * x;         // broad brow
  }
  y *= 0.9;                    // flatter crown
  return new THREE.Vector3(x, y, z);
}

/** A faceted strip of the shell between u0..u1 and v0..v1, cut at the rim and shaped. */
function patch(u0, u1, v0, v1, nu, nv, r) {
  const pos = [];
  const raw = (i, j) => onSphere(u0 + (u1 - u0) * (i / nu), v0 + (v1 - v0) * (j / nv), r);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = raw(i, j), b = raw(i + 1, j), c = raw(i + 1, j + 1), d = raw(i, j + 1);
      for (const tri of [[a, b, c], [a, c, d]]) {
        if (tri.every((p) => p.y < rimY(p.x))) continue; // below the rim: open
        for (const p of tri) {
          const q = p.y < rimY(p.x) ? new THREE.Vector3(p.x, rimY(p.x), p.z) : p; // edge on the rim
          const s = shape(q);
          pos.push(s.x, s.y, s.z);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * `fit`: { center, half: [front-back, up, side] half-extents of the skull, axes: [forward, up, side] }
 * in the head's frame (as measured for the old helmet). `colors`: { shell, accent }.
 */
export function buildModernHelmet(fit, colors = {}, scale = 1) {
  const mat = (color, roughness = 0.55) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, flatShading: true, side: THREE.DoubleSide });
  const shellMat = mat(colors.shell || '#f4f5f7');
  const accentMat = mat(colors.accent || '#16a0a8', 0.5);
  const ventMat = mat('#16181c', 0.8);
  const unit = new THREE.Group();
  const add = (g, m) => unit.add(new THREE.Mesh(g, m));
  const H = Math.PI / 2;

  add(patch(-H, H, -Math.PI, Math.PI, 14, 30, 1), shellMat);
  // long vent channels over the top, shorter toward the sides
  for (const [u, back, front] of [[0, -0.85, 0.95], [0.3, -0.75, 0.9], [-0.3, -0.75, 0.9], [0.6, -0.5, 0.75], [-0.6, -0.5, 0.75]]) {
    add(patch(u - 0.07, u + 0.07, back, front, 1, 8, 1.012), ventMat);
  }
  // intakes over the brow
  for (const u of [-0.62, -0.31, 0, 0.31, 0.62]) add(patch(u - 0.1, u + 0.1, 1.08, 1.26, 2, 2, 1.012), ventMat);
  // exhaust ports at the back
  for (const u of [-0.42, 0, 0.42]) add(patch(u - 0.12, u + 0.12, -1.62, -1.3, 2, 3, 1.012), ventMat);
  // side stripes in the rider's colour
  for (const sd of [1, -1]) add(patch(sd * 0.98, sd * 1.06, -1.35, 0.95, 1, 12, 1.008), accentMat);

  const [a, b, c] = fit.half;
  unit.scale.set(a * 1.1 * scale, b * 1.12 * scale, c * 1.14 * scale);
  const helmet = new THREE.Group();
  helmet.add(unit);
  const [fx, uy, sz] = fit.axes;
  helmet.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(fx, uy, sz));
  helmet.position.copy(fit.center);
  helmet.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return helmet;
}

