# Standing Rider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Riders stand out of the saddle on power surges and slow grinds, with a second baked Blender clip crossfaded in the game and the bike rocking under them.

**Architecture:** A pure rule (`js/standing.js`) decides per rider whether to stand; `app.js` keeps its state on each rider and passes `stand` to the renderer. The standing pose and rock are data in each `.blend` (rig custom props), which the exporter bakes into a second action `stand_cycle` with its own corrective shape keys and writes the rock table into the rider JSON. `RiderModel` plays both actions at the crank's time with weights `1 − s` and `s`; `render3d` eases `s` and rolls the rider group by the rock.

**Tech Stack:** three.js AnimationMixer, Blender 4.x Python (headless), `node --test`, Playwright (`node_modules/playwright`) for live checks.

**Spec:** `docs/superpowers/specs/2026-11-16-standing-rider-design.md`

## Global Constraints

- Stand when held ≥ 0.4 s: `power ≥ 1.20 × FTP`, or `20 < cadence ≤ 70 and power ≥ 0.5 × FTP`.
- Sit when held ≥ 0.8 s: `power < 1.05 × FTP and cadence > 76`, or `cadence < 20`.
- Without cadence (ghost without `chart.cd`): power rule only. Without power: never stands.
- Blend time ≈ 0.5 s each way. No new setting; always on.
- Both clips: frames 1..17, same crank phase. Standing only for `clipFollowsCrank` models.
- GLB ≤ ~10.2 MB each (today 8.1–8.2 MB). Over: `MORPH_STEP = 4` for the standing keys, then drop `MH_JerseyPockets` from them.
- Feet within 10 mm of the pedal points at `stand = 0.5`, every clip frame; else runtime leg IK fix-up while `0 < s < 1`.
- Blender runs headless: `blender -b blender/rider_<figure>.blend --python <script>`; anchors in rest-pose bone space (`rig.matrix_world @ bone.matrix_local`).

## Review Focus

- A rider hovering at a threshold (power ≈ 1.1–1.2 × FTP, cadence 70–76) must not bob up and down: tested in Task 1 (`standing: no bobbing at the edge`).
- Feet at the blend's midpoint must stay on the pedals: measured in Task 5 Step 4.
- An old GLB or the dummy rider (no `stand_cycle`) must keep working seated, no errors: Task 5 Step 5.
- Stopping or coasting while standing must sit the rider down: tested in Task 1 (`standing: coasting sits down`).
- A full bunch (6 bots) standing on a climb must not drop the frame rate noticeably: Task 5 Step 6.

---

### Task 1: The standing rule

**Files:** Create `js/standing.js`; Test `tests/core.test.mjs` (append).

**Interfaces:**
- Produces: `standStep(state: { up?: boolean, t?: number }, { power, ftp, cadence }: { power: number|null, ftp: number, cadence: number|null }, dt: number) -> boolean` — mutates `state` (`up`, `t` = seconds the opposite condition has held), returns whether the rider stands now. `cadence == null` means unknown.

- [ ] **Step 1: Failing tests** (helper `run(state, input, seconds)` steps `standStep` at dt 0.1 and returns the last result)
  - `standing: a surge stands after 0.4 s` — `{power: 300, ftp: 250, cadence: 95}`: false at 0.3 s, true at 0.5 s.
  - `standing: a grind stands` — `{power: 200, ftp: 250, cadence: 65}` → true after 0.5 s; `{power: 100, ftp: 250, cadence: 65}` → false (under 0.5 × FTP).
  - `standing: sits after 0.8 s of easy riding` — from up, `{power: 200, ftp: 250, cadence: 90}`: still true at 0.7 s, false at 0.9 s.
  - `standing: no bobbing at the edge` — from up, alternate every 0.3 s between `{power: 290}` and `{power: 310}` (ftp 250, cadence 90) for 10 s: always true; from down, same input: always false.
  - `standing: coasting sits down` — from up, `{power: 0, ftp: 250, cadence: 0}` → false after 0.9 s.
  - `standing: no cadence uses power only` — `{power: 320, ftp: 250, cadence: null}` → true; `{power: 150, ftp: 250, cadence: null}` from up → false after 0.9 s.
  - `standing: no power never stands` — `{power: null, ftp: 250, cadence: 60}` → false.
- [ ] **Step 2:** `npm test` — FAIL (module not found).
- [ ] **Step 3:** Implement `standStep` with the thresholds in Global Constraints.
- [ ] **Step 4:** `npm test` — all pass.
- [ ] **Step 5:** Commit `Standing: when a rider gets out of the saddle`.

### Task 2: Who stands, in the ride

**Files:** Modify `js/app.js` (bots loop ~1440–1490, the riders list passed to the scene ~1556, ghost update ~1416, pacer update), Test: Playwright script in the plan workspace (`stand.mjs`).

**Interfaces:**
- Consumes: `standStep` (Task 1).
- Produces: every rider object passed to `scene.update` has `stand: boolean`; `window.__ride.stand` for you (debug).

- [ ] **Step 1:** Write `stand.mjs` (pattern: `tests/e2e/social.e2e.mjs` setup; start with `?debug`, simulator): set simulator power to 1.5 × FTP via `#sim-power` (value + `input` event), wait 1.5 s, assert `__ride.stand === true`; set 0.6 × FTP, wait 1.5 s, assert false. Run against `http://localhost:8000` — FAIL (`stand` undefined).
- [ ] **Step 2:** You: `ride.standState`, inputs = displayed power (~1 s smoothed, the HUD's value), `settings.ftp`, `live.cadence` (`null` if no fresh cadence). Bots: `b.standState`, power `b.power`, ftp = the bot's base power before race surges, cadence = the value `liveCadence` returned. Pacer: its power and cadence the same way. Ghost: `G.power`, `settings.ftp`, `chart.cd` sample or `null`.
- [ ] **Step 3:** Run `stand.mjs` — PASS. `npm test` — pass.
- [ ] **Step 4:** Commit `Standing: every rider with power decides when to stand`.

### Task 3: The standing pose in Blender

**Files:** Create `tools/stand_pose.py` (applies and stores the pose; preview mode renders); Modify `blender/rider_male.blend`, `blender/rider_female.blend`.

**Interfaces:**
- Produces, on the `MH_Rig` object of each .blend: custom props `standPose` (JSON string: `{bone: {loc: [x,y,z], rot: [w,x,y,z]}}` for `Root`, `pelvis`, `spine_01..03`, `neck_01`, `head`, `clavicle_l/r`) and `standRock` (JSON: `{amp: radians, phase: radians}`, roll = `amp × sin(crankAngle + phase)` about the bike's contact line, +roll = bike leans right). `tools/stand_pose.py --apply on|off` sets the bones to standPose / back to the seated values (seated values stored once as `seatPose` the same way).

- [ ] **Step 1:** Write `tools/stand_pose.py`: `--measure` prints, over frames 1..17 with the pose applied: max foot-to-pedal distance (foot bone tail vs `BallT`), max hand-to-`HandT` distance, hip height above the seated hip height. Run it on the male .blend with the seated pose — prints the baseline (feet ≤ 5 mm, hands ≤ 5 mm, hip lift 0).
- [ ] **Step 2:** Author the standing pose for the male rider: `Root` up 0.10–0.14 m and forward 0.08–0.12 m in bike space, pelvis and spine rolled further forward, head up to look down the road; hands stay on the hoods via the existing IK. Rock: a driver on `Root` (built by `stand_pose.py` from `standRock`, start `amp = 0.12`, phase so the bike leans away from the leg pushing down) rolling the rider about the contact line by `−roll` in bike space (the game rolls the group by `+roll`, Task 5), so the body stays near upright in the world.
- [ ] **Step 3:** `--measure` on the standing pose: feet ≤ 5 mm, hands ≤ 10 mm, hip lift ≥ 0.08 m, every frame. Workbench renders (side, front, rear) at frames 1, 5, 9, 13 in the plan workspace; compare by eye with a rider sprinting on the hoods; adjust and re-measure until both pass.
- [ ] **Step 4:** Same for the female rider (her own offsets; she sits on a 0.92 frame).
- [ ] **Step 5:** Commit `Standing pose and rock in both riders` (the .blend files and the script).

### Task 4: Exporter bakes both clips

**Files:** Modify `tools/export_rider_blend.py` (`pose_morphs`, `pedal_tilt`, `run`); Test: `tests/core.test.mjs` (append, reads the exported files).

**Interfaces:**
- Consumes: `standPose`, `standRock`, `stand_pose.py`'s apply/driver helpers (import it from the exporter).
- Produces: GLB animations `pedal_cycle` and `stand_cycle` (same duration); shape keys `fNN` keyed only in `pedal_cycle`, `sNN` only in `stand_cycle`; rider JSON gains `standPedalTilt: [l, r, ?]` (as `pedalTilt`), `standRock: number[17]` (roll in radians at frames 1..17), `standRockPivot: number` (contact-line height in the game's rider group, m).

- [ ] **Step 1: Failing test** `rider assets: both clips and the rock` — for `male` and `female`: parse the GLB JSON chunk (first chunk after the 12-byte header) and assert animation names include `pedal_cycle` and `stand_cycle`; JSON has `standRock.length === 17`, every value finite and `|v| ≤ 0.2`, `standPedalTilt.length === 3`; `fs.statSync(glb).size ≤ 10.2e6`.
- [ ] **Step 2:** `npm test` — FAIL.
- [ ] **Step 3:** In `run()`: after baking `pedal_cycle`, apply the standing pose + rock driver, bake again into a new action `stand_cycle`, then restore the seated pose. `pose_morphs(copies, rig, act, prefix, step)` keys each clip's corrections into its own action with its own prefix (`f`/`s`) against the same seated basis; standing keys use `MORPH_STEP` unless the size check fails (then 4). `pedal_tilt()` measured for each clip. Write `standRock` from the driver's value at frames 1..17 and `standRockPivot` from the tyre contact height.
- [ ] **Step 4:** Export both figures in the background (`blender -b blender/rider_<f>.blend --python tools/export_rider_blend.py`, minutes each); `npm test` — PASS. If over 10.2 MB: standing `MORPH_STEP = 4`, re-export; still over: drop `MH_JerseyPockets` from the standing keys.
- [ ] **Step 5:** Commit `Exporter: a standing clip next to the seated one` with the regenerated GLB/JSON.

### Task 5: Crossfade and rock in the game

**Files:** Modify `js/rider-model.js` (clip setup ~911, `pose` ~957), `js/render3d.js` (rider loop ~2740–2795), `js/bike-model.js` if the pedals' tilt is set there; Test: `stand.mjs` (extend).

**Interfaces:**
- Consumes: `r.stand` (Task 2), `stand_cycle`, `standRock`, `standRockPivot`, `standPedalTilt` (Task 4).
- Produces: `RiderModel.pose(angle, dt, cadence, stand = 0)`; `RiderModel.canStand: boolean`; `RiderModel.rockAt(angle) -> number` (radians, linear between the 17 samples).

- [ ] **Step 1:** Extend `stand.mjs`: at 1.5 × FTP for 2 s, read `__scene3d.riders` self entry: `R.standW > 0.95` and the group's roll differs from the seated value by `|R.model.rockAt(angle)| ± 0.01` — FAIL.
- [ ] **Step 2:** `rider-model.js`: find `stand_cycle` next to the seated clip; both actions play, `time` from the crank angle as today, weights `1 − s` and `s`; `canStand = !!standAction && cfg.clipFollowsCrank`. Pedal tilt lerps `pedalTilt → standPedalTilt` by `s`.
- [ ] **Step 3:** `render3d.js`: `R.standW` eases toward `r.stand ? 1 : 0` at rate 1 / 0.5 s; pass it to `pose`; roll the rider group about the contact line (`standRockPivot`) by `standW × rockAt(pedal)` after the bend lean.
- [ ] **Step 4:** Feet at the midpoint: force `standW = 0.5` (debug hook), sample 17 crank angles, measure foot bone world position vs the bike's pedal spindle: max ≤ 10 mm → done; over → add the two-bone leg IK fix-up while `0 < standW < 1` (helpers `aim`/knee in `rider-model.js`) and re-measure ≤ 10 mm. Ledger the numbers.
- [ ] **Step 5:** Old model: load with `stand_cycle` stripped (stub `canStand = false` path via `?debug` flag `nostand`), ride at 1.5 × FTP: no errors, rider seated.
- [ ] **Step 6:** Bunch: 6 bots on a climb (`rolling`, jump to the first climb), compare mean frame time over 5 s with `standW` forced 0 vs 1: increase ≤ 10 %.
- [ ] **Step 7:** `npm test` pass; `stand.mjs` PASS; screenshots at 1.5 × FTP from `chase` and `side` cameras for the user. Commit `Riders stand out of the saddle: crossfade and rock`.
