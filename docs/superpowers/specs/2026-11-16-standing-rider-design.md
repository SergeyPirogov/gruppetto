# Standing out of the saddle

**Why.** The user saw riders stand on the pedals in ridewarp.cc and wants it in Gruppetto: today every rider sits through the whole ride, whatever the effort, which reads flat in a sprint and on a steep, slow grind.

## What it looks like

- A rider gets up out of the saddle when **power surges above ~120 % of their FTP** (the user's own "sprint") **or cadence drops to 70 rpm or lower** while still pedalling (a grind).
- Standing: hips up and forward off the saddle, torso lower and further forward, elbows bent, hands on the hoods; the bike rocks side to side under the rider in step with the pedal stroke (the bike leans away from the leg pushing down). Feet stay on the pedals the whole time.
- Getting up and sitting down blend over about half a second; no snap.
- Works the same for you, the bots, the pacer, ghosts and live riders: anything with power and cadence (ghost/live: whatever the app knows; without power, cadence alone).

## Rules (proposed thresholds — the builder may tune, keep the shape)

- Stand when, for at least 0.4 s: `power ≥ 1.20 × FTP`, or `cadence ≤ 70 rpm and cadence > 20 rpm and power ≥ 0.5 × FTP`.
  - The power floor on the cadence rule stops a rider standing while soft-pedalling slowly or rolling to a stop.
- Sit again when, for at least 0.8 s: `power < 1.05 × FTP` and `cadence > 76 rpm`, or the rider coasts (cadence < 20 rpm).
- Hysteresis (the gaps 1.20/1.05 and 70/76, the hold times) is required: a rider on the edge must not bob up and down.
- You: FTP from `settings.ftp`, power and cadence as the HUD shows them (smoothed ~1 s). Bots: their own base power stands in for FTP; their cadence is `liveCadence` (it already slows on climbs, so bots stand on steep grades on their own).
- No new setting; it is always on.

## How it is built (approach A, picked by the user)

The standing stroke is a **second baked clip from Blender**, next to today's seated `pedal_cycle`, and the game crossfades between them.

1. **Blender (`blender/rider_male.blend`, `rider_female.blend`).** A standing variant of the existing rig setup: hips raised and moved forward over the bottom bracket, spine and arms re-posed, the same IK + drivers that keep the feet on `PedalPt.L/R` and the hands on the bars. The bike rock is part of the clip (a roll of the bike about the line through the tyre contact points, ±6–8°, one cycle per crank turn), so the game does not compute it. Same crank phase and frame range as `pedal_cycle` (frames 1..17 = one turn), so both clips can play at the same time position.
2. **Exporter (`tools/export_rider_blend.py`).** Bakes both clips into the GLB: `pedal_cycle` (seated) and `stand_cycle` (standing), each with its own per-frame corrective shape keys (`pose_morphs` today keys one action). The rest shape and textures stay one set. The rider JSON gets the standing clip's `pedalTilt` too, and the bike rock if the bike is exported separately (see open questions).
3. **Game (`js/rider-model.js`, `js/render3d.js`, `js/app.js`).**
   - `RiderModel.pose(angle, dt, cadence)` gains a standing weight `stand ∈ [0,1]`; both actions sit at the same time from the crank angle, weights `1 − stand` and `stand`.
   - `render3d` reads `r.stand` (0/1 target) from each rider the app passes and eases the weight over ~0.5 s.
   - `app.js` decides the target per rider with the rules above.
   - A model without `stand_cycle` (an older GLB, the dummy rider) just stays seated.

## Goals / non-goals / anti-goals

- **Goals:** standing on surges and grinds, for every rider, feet locked to the pedals, smooth transitions, no visible pops in the kit.
- **Non-goals:** standing for the 2D view; a manual "stand" key; changes to physics (standing gives no power or aero change).
- **Anti-goals:** riders bobbing up and down at a threshold; feet sliding off the pedals during the blend; the GLB growing more than ~25 % or load time getting noticeably longer; frame rate dropping with a full bunch (6+ riders standing).

## Constraints

- Both clips must share the crank phase so the blend never moves the feet off the pedals; check at the blend's midpoint, worst case.
- Export runs headless (`blender -b … --python tools/export_rider_blend.py`, a few minutes per figure). The Blender MCP may be down.
- Rest-pose bone space for anchors (`rig.matrix_world @ bone.matrix_local`); the .blend is saved posed.

## Decisions after the builder check (my calls, open to correction)

1. **Bike rock lives in the game, sampled from the bake.** In Blender the standing clip is baked with the bike rolled (the rig follows the rolled frame, so hands stay on the hoods and feet on the pedals). The exporter samples that roll per baked frame into the rider JSON (`standRock`: roll angle, radians, per frame of the clip, plus the pivot height of the contact line). In the game `render3d` rolls **the whole rider group (bike + rider)** about the tyre contact line by `stand × rock(clip time)`. The clip itself is stored **in bike space** (the rig's bones relative to the rolled frame), so the rolled group plus the clip reproduce Blender exactly; the torso staying upright in the world is part of what the clip encodes.
2. **Who stands.** Only riders whose power and cadence the app knows: you, bots and the pacer. Ghosts use their recorded power (`entry.chart.pw`) with your FTP and their recorded cadence when there is one (`chart.cd`); without cadence, only the power rule applies. Live riders without power stay seated. One shared pure helper in `app.js`: `standStep(state, { power, ftp, cadence }, dt) -> boolean`, per-rider state kept on the rider object (it survives as long as the rider does).
3. **Cadence source.** The app's own figures: `live.cadence` (you, smoothed ~1 s), `liveCadence` (bots), the pacer's cadence. Never the render's pedal-angle derivative.
4. **Shape keys and size.** The standing clip gets its own corrective keys (`s02…s17`), solved against the same seated rest basis, keyed in `stand_cycle` only. Today's GLBs are 8.1–8.2 MB. Budget: +25 % (≤ ~10.2 MB). If the second key set goes over, use `MORPH_STEP = 4` for the standing clip first, then drop `MH_JerseyPockets` from its keys.
5. **Feet during the blend.** Check the worst case (stand = 0.5) in a Blender preview or a Node check on the exported GLB: feet within 10 mm of the pedal points. If the plain crossfade misses that, add a runtime two-bone IK fix-up on the legs while `0 < stand < 1` (the code already has `aim`/knee helpers in `rider-model.js`); do not fail the build.
6. **Clip path.** Both clips have the same frames (1..17) and duration; standing is only for `clipFollowsCrank` models (the baked riders). The timeScale path and the dummy rider stay seated.
7. **Saddle/pelvis offsets** are per figure in the .blend (the female rider sits on a 0.92 frame); the standing pose is made per figure, with the hands on the same hoods as seated.
