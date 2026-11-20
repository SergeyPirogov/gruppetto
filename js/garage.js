/**
 * The garage: your rider on your bike on a turntable, lit like a showroom, so the colours you pick show at once
 * and from every side (in the ride you see the kit mostly from behind, and only while riding).
 * It has its own canvas and WebGL renderer, and it reuses the ride's models (preloadModels) and the same
 * ModelRider / ModelBike classes, so what you see here is what rides.
 */
import * as THREE from 'three';
import { preloadModels } from './render3d.js';
import { ModelRider } from './rider-model.js';
import { DummyRider } from './dummy-rider.js';
import { ModelBike, makeBikeEnvironment } from './bike-model.js';

/** Camera views: azimuth (0 = from the drive side, +z), elevation, distance, and the point looked at. */
const VIEWS = {
  side: { az: 0, el: 0.12, dist: 3.9, at: [0, 0.82, 0] },
  front: { az: 0.9, el: 0.18, dist: 3.6, at: [0, 0.9, 0] },
  back: { az: Math.PI - 0.7, el: 0.22, dist: 3.6, at: [0, 0.9, 0] },
  head: { az: 0.55, el: 0.1, dist: 1.35, at: [0.32, 1.42, 0] },
};
const SPIN = 0.22; // rad/s: the turntable when you leave it alone
const IDLE = 4; // s after a drag before it turns again
const RPM = 42; // the rider spins the cranks slowly, as on a trainer

export class Garage {
  constructor(canvas) {
    this.canvas = canvas;
    if (typeof window !== 'undefined' && new URLSearchParams(location.search).has('debug')) window.__garage = this; // for inspecting in devtools
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.env = makeBikeEnvironment(this.renderer);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 60);

    // showroom light: a warm key from the front left, a cool rim from behind, soft fill from the sky
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2f3a, 1.1));
    const key = new THREE.DirectionalLight(0xfff1e0, 2.4);
    key.position.set(2.5, 5, 3.5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 1, far: 15 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbcd4ff, 1.3);
    rim.position.set(-3, 2.5, -3.5);
    this.scene.add(rim);

    // the turntable: a dark disc with a lit edge, the shadow falls on it
    this.table = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.55, 0.06, 96), new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.55, metalness: 0.2 }));
    disc.position.y = -0.03;
    disc.receiveShadow = true;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.53, 0.012, 8, 128), new THREE.MeshBasicMaterial({ color: 0xff7a1a, toneMapped: false }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.001;
    this.table.add(disc, ring);
    this.scene.add(this.table);

    this.view = { ...VIEWS.side, at: VIEWS.side.at.slice() };
    this.goal = null; // the view the camera eases toward
    this.spin = 0; // the turntable's angle
    this.idle = IDLE;
    this.spinning = true; // the turntable turns on its own and the rider pedals; setSpin(false) holds both
    this.pedal = 0;
    this.dist = 0;
    this.look = null;
    this.builtKey = '';
    this.models = null;
    const m = preloadModels();
    Promise.allSettled([m.bike, m.rider, m.riderFemale]).then(([b, r, f]) => {
      this.models = { bike: b.value || null, rider: r.value || null, riderF: f.value || null };
      this.builtKey = ''; // build with the models on the next frame
    });
    this._drag(canvas);
    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
  }

  /** The colours and figure to show: { jersey, stripe, bike, tape, decal, helmet, lens, figure }. */
  setLook(look) { this.look = look; }

  /** All in motion (the turntable turns while you leave it, the rider pedals) or held still, for a close look. */
  setSpin(on) { this.spinning = !!on; this.idle = IDLE; }

  /** Ease the camera to a named view ('side', 'front', 'back', 'head'). */
  setView(name) {
    const v = VIEWS[name];
    if (!v) return;
    // the turntable stops where it is and the camera goes round to the view's side of the bike
    this.goal = { ...v, az: v.az + this.spin, at: v.at.slice() };
    this.idle = IDLE * 2;
  }

  start() {
    if (this.raf) return;
    this.resize();
    let last = performance.now();
    const tick = (now) => {
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this._frame(dt);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _drag(el) {
    let from = null;
    el.addEventListener('pointerdown', (e) => { from = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); this.goal = null; });
    el.addEventListener('pointermove', (e) => {
      if (!from) return;
      const k = 4 / Math.max(300, el.clientWidth);
      this.view.az -= (e.clientX - from.x) * k;
      this.view.el = Math.max(-0.05, Math.min(0.9, this.view.el + (e.clientY - from.y) * k * 0.6));
      from = { x: e.clientX, y: e.clientY };
      this.idle = 0;
    });
    const end = () => { from = null; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.goal = null;
      this.view.dist = Math.max(1.2, Math.min(6, this.view.dist * Math.exp(e.deltaY * 0.001)));
      this.idle = 0;
    }, { passive: false });
  }

  _key(L) { return L ? [L.jersey, L.stripe, L.bike, L.tape, L.decal, L.helmet, L.lens, L.figure, L.kit ? Object.values(L.kit).join('/') : ''].join(':') : ''; }

  /** A new rider and bike in the current colours (colour pickers fire many times a second: once a frame at most). */
  _build() {
    const L = this.look, M = this.models;
    if (!L || !M) return;
    const key = this._key(L);
    if (key === this.builtKey) return;
    this.builtKey = key;
    if (this.rider) { this.table.remove(this.rider.group); this._dispose(this.rider.group); }
    const group = new THREE.Group();
    const R = { group };
    const riderModel = (L.figure === 'female' && M.riderF) || M.rider;
    if (riderModel) R.model = new (riderModel.dummy ? DummyRider : ModelRider)(riderModel, group, { jersey: L.jersey, stripe: L.stripe, helmet: L.helmet, lens: L.lens, kit: L.kit });
    if (M.bike) R.bike = new ModelBike(M.bike, group, { color: L.bike || L.jersey, tape: L.tape || null, accent: L.decal || L.stripe || null });
    const fit = R.model?.cfg;
    if (fit && (fit.bikeScale || fit.saddleDrop)) {
      const k = fit.bikeScale || 1;
      R.bike?.fitRider(k, fit.saddleDrop || 0, M.bike?.cfg);
      if (k !== 1) { R.model.root.position.multiplyScalar(k); R.model.root.scale.multiplyScalar(k); }
    }
    if (R.model && R.bike) { R.model.bikeFit = R.bike.fit; R.model.bike = R.bike; R.bike.pedalTilt = R.model.cfg?.pedalTilt; }
    // the bike's gloss reflects this renderer's sky (the ride's belongs to the other canvas); its own copies of
    // the materials, so the ride's bikes keep theirs
    group.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      const own = (m) => {
        if (!m.envMap) return m;
        const c = m.clone();
        c.envMap = this.env;
        c.userData.garage = true;
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material);
    });
    // a pose first, then centre the bike on the turntable (its middle between the wheels)
    R.bike?.pose(this.pedal);
    R.model?.pose(this.pedal, 0, RPM, 0);
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(R.bike?.root || group);
    group.position.x = -(box.min.x + box.max.x) / 2;
    const holder = new THREE.Group();
    holder.add(group);
    R.group = holder;
    this.table.add(holder);
    this.rider = R;
    this.onReady?.();
  }

  /** Frees what this rider made for itself (cloned materials, painted kit textures), not the shared model. */
  _dispose(root) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.userData.garage) m.dispose();
        if (m.map?.isCanvasTexture) m.map.dispose();
      }
    });
  }

  _frame(dt) {
    this._build();
    // the turntable turns while you leave it alone
    this.idle += dt;
    if (this.spinning && this.idle > IDLE && !this.goal) this.spin += SPIN * dt * Math.min(1, (this.idle - IDLE) / 1.5);
    this.table.rotation.y = this.spin;
    if (this.goal) {
      const k = Math.min(1, dt * 4), V = this.view, G = this.goal;
      let d = G.az - V.az;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      V.az += d * k; V.el += (G.el - V.el) * k; V.dist += (G.dist - V.dist) * k;
      for (let i = 0; i < 3; i++) V.at[i] += (G.at[i] - V.at[i]) * k;
      if (Math.abs(d) < 0.002 && Math.abs(G.dist - V.dist) < 0.002) this.goal = null;
    }
    // the cranks turn and the wheels roll, slowly
    const R = this.rider;
    if (R) {
      const w = this.spinning ? (RPM / 60) * Math.PI * 2 : 0; // held still: the cranks and wheels stop too
      this.pedal += w * dt;
      this.dist += w * dt * 0.75;
      R.bike?.pose(this.pedal);
      R.bike?.roll(this.dist);
      if (R.model) {
        R.model.pose(this.pedal, dt, RPM, 0);
        if (R.bike && R.model.cfg?.standPedalTilt) R.bike.pedalTilt = R.model.pedalTiltAt(0);
      }
    }
    // the camera on a sphere round the point looked at; the turntable's turn is in its own rotation
    const V = this.view, at = new THREE.Vector3(...V.at).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.spin);
    const c = Math.cos(V.el);
    this.camera.position.set(at.x + Math.sin(V.az) * c * V.dist, at.y + Math.sin(V.el) * V.dist, at.z + Math.cos(V.az) * c * V.dist);
    this.camera.lookAt(at);
    this.renderer.render(this.scene, this.camera);
  }
}
