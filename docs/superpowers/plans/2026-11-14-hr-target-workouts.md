# Heart rate range in intervals.icu workouts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the heart rate range of intervals.icu heart-rate steps while riding; never touch ERG or the trainer.

**Architecture:** `js/intervals.js` resolves a step's `hr` target to `step.hr = [lo, hi]` bpm using the athlete's
LTHR / max HR / HR zones; the step stays `free`. `js/app.js` shows the range in the workout panel and step list.

**Tech Stack:** plain ES modules, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-14-hr-target-workouts-design.md`

## Global Constraints
- Heart rate never drives the trainer: an HR step keeps `free: true`, `stepWatts` returns `null` for it as today.
- No guessed numbers: a percent / zone target without LTHR / max HR / zones gives no `hr` field.

## Review Focus
- A step with both power and HR targets: power still drives ERG, the HR range is shown as well.
- `hr` given as start/end (range), min/max, or a single value (shown as value ±3 bpm, like cadence).
- No heart rate monitor: the panel shows the range and `—` for the live value, no colour.
- Workouts without any HR step: no heart rate cell in the panel (like the cadence column).

---

### Task 1: Resolve HR targets in step conversion

**Files:**
- Modify: `js/intervals.js` (`athlete`, `plannedWorkouts`, `eventToWorkout`, `convertSteps`, new `convertHr`)
- Modify: `js/app.js:3300` (pass the athlete's heart rate settings to `plannedWorkouts`)
- Test: `tests/core.test.mjs`

**Interfaces:**
- Produces: `convertSteps(steps, out = [], ath = {})`, `eventToWorkout(e, ath = {})`,
  `client.plannedWorkouts(oldest, newest, ath = {})`, where `ath = { lthr, maxHr, hrZones }` (hrZones: each zone's
  top in bpm, as `athlete()` returns). Steps gain `hr: [lo, hi]` (integers, bpm).

- [ ] **Step 1: Write the failing test** `intervals.icu heart rate ranges` in `tests/core.test.mjs`:

```js
const ath = { lthr: 162, maxHr: 190, hrZones: [130, 146, 156, 165, 175, 190] };
const s = convertSteps([
  { duration: 3600, hr: { start: 78, end: 83, units: '%lthr' }, cadence: { min: 85, max: 90, units: 'rpm' } },
  { duration: 600, hr: { value: 70, units: '%hr' } },
  { duration: 600, hr: { value: 2, units: 'hr_zone' } },
  { duration: 600, hr: { min: 120, max: 130, units: 'bpm' } },
  { duration: 600, power: { value: 60, units: '%ftp' }, hr: { start: 78, end: 83, units: '%lthr' } },
], [], ath);
assert.deepEqual(s[0].hr, [126, 134]);           // 78–83 % of 162
assert.equal(s[0].free, true);                   // shown only: no ERG
assert.deepEqual(s[0].cad, [85, 90]);
assert.deepEqual(s[1].hr, [130, 136]);           // 70 % of 190 = 133 ± 3
assert.deepEqual(s[2].hr, [131, 146]);           // Z2: above Z1's top up to its own
assert.deepEqual(s[3].hr, [120, 130]);
assert.equal(stepWatts(s[4], 0, 200), 120);      // power still drives ERG
assert.deepEqual(s[4].hr, [126, 134]);
assert.equal(convertSteps([{ duration: 60, hr: { value: 80, units: '%lthr' } }])[0].hr, undefined); // no LTHR
```

- [ ] **Step 2:** `npm test` → the new test FAILS (`hr` undefined).
- [ ] **Step 3: Implement** `convertHr(h, ath) -> [lo, hi] | null` in `js/intervals.js`; units `%lthr` (× lthr/100),
  `%hr` (× maxHr/100), `hr_zone` (zone n: `[zones[n-2] + 1 or 0, zones[n-1]]`), `bpm`; value → ±3; round to integers.
  `convertSteps` sets `step.hr` when non-null and threads `ath` through repeats; `eventToWorkout` / `plannedWorkouts`
  pass `ath` on. In `connectIntervals` pass `{ lthr: athlete.lthr, maxHr: athlete.maxHr, hrZones: athlete.hrZones }`.
- [ ] **Step 4:** `npm test` → all PASS.
- [ ] **Step 5: Commit** `Heart rate range from intervals.icu workout steps`.

### Task 2: Show the range while riding and in the step list

**Files:**
- Modify: `index.html` (a heart rate cell next to `wk-cad` in the workout panel: `id="wk-hr"`)
- Modify: `js/app.js:1922-1928` (workout panel), `js/app.js:910` (step list row), `js/i18n-uk.js` (label)

**Interfaces:**
- Consumes: `step.hr` from Task 1.

- [ ] **Step 1:** Panel: `wk-hr` shows `126–134`; class `c-ok` when live `hr` within the range, `c-warn` outside,
  none with no heart rate; hidden when no step of the workout has `hr`. Also colour `m-hr` the same way.
- [ ] **Step 2:** Step list row: `· 126–134 bpm` before the cadence.
- [ ] **Step 3:** Verify live in Chrome (`?debug`, simulator): a workout injected with an HR step shows the range;
  the trainer target stays `free`. `npm test` passes.
- [ ] **Step 4: Commit** `Heart rate range in the workout panel and step list`.
