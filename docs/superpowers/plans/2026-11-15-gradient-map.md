# Gradient Minimap and Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-ride minimap and elevation profile coloured by grade, with segment ticks, a shaded ridden part, a Nearby/Route toggle and collapse buttons.

**Architecture:** A pure module `js/grade-color.js` maps grade to colour and splits a route into coloured runs; `drawProfile` (`js/render.js`) and `drawMinimap` (`js/app.js`) draw those runs on their canvases. Collapse/zoom state lives in `settings` like `bigMap` today.

**Tech Stack:** Plain ES modules, Canvas 2D, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-15-gradient-map-design.md`

## Global Constraints

- Colour stops (grade %, colour), linear blend between, clamped outside: −4 `#3b82f6`, −1 `#14b8a6`, 0 `#22c55e`, 1 `#22c55e`, 3 `#eab308`, 6 `#f97316`, 9 `#dc2626`.
- Grade from `route.gradeAt(d)` (fraction), sampled every 25 m.
- Segment ticks: thin start/finish ticks; ⛰ (climb) or ⚡ (sprint, `c.sprint`) at the start tick. No orange/green segment lines anymore.
- Phone layout (< 760 px) unchanged: map and profile stay hidden.
- UI strings go through `tr()` with Ukrainian in `js/i18n-uk.js`.

## Review Focus

- Loop route: colour runs and segment ticks crossing the start line (segment `start + length > L`) must wrap, not draw a line across the map.
- Point-to-point route (`route.oneWay`): no wrap; ridden shading stops at the finish.
- Lap 2+: ridden shading uses `route.wrap(ride.dist)`, so it resets each lap.
- Collapsed panel: `drawMinimap` already bails on `!offsetWidth`; the profile must not throw on a 0-width canvas.
- Lobby route cards call `drawProfile` with `scale` and no self rider: no shading there.

---

### Task 1: Grade colours

**Files:**
- Create: `js/grade-color.js`
- Test: `tests/core.test.mjs` (append)

**Interfaces:**
- Produces: `gradeColor(gradePct: number) -> string` (`'rgb(r,g,b)'`); `gradeRuns(route, from: number, to: number, step = 25) -> Array<{ d: number, color: string }>` — sample points from `from` to `to` inclusive with the colour at each.

- [ ] **Step 1: Failing tests**

```js
import { gradeColor, gradeRuns } from '../js/grade-color.js';
test('grade colours: stops, blend, clamp', () => {
  assert.equal(gradeColor(0), 'rgb(34,197,94)');
  assert.equal(gradeColor(9), 'rgb(220,38,38)');
  assert.equal(gradeColor(20), 'rgb(220,38,38)');
  assert.equal(gradeColor(-10), 'rgb(59,130,246)');
  assert.equal(gradeColor(4.5), 'rgb(240,152,19)'); // halfway 3 % -> 6 %, rounded
});
test('grade runs sample the route every 25 m', () => {
  const r = routes[0], runs = gradeRuns(r, 0, 100);
  assert.deepEqual(runs.map((x) => x.d), [0, 25, 50, 75, 100]);
  assert.equal(runs[1].color, gradeColor(r.gradeAt(25) * 100));
});
```

- [ ] **Step 2:** `npm test` — FAIL, module not found.
- [ ] **Step 3:** Implement both in `js/grade-color.js` (stops table from Global Constraints, `Math.round` per channel).
- [ ] **Step 4:** `npm test` — all pass.
- [ ] **Step 5:** Commit `Grade colours for the map and profile`.

### Task 2: Profile in grade colours

**Files:** Modify `js/render.js` (`drawProfile`, ~617–676).

**Interfaces:** Consumes `gradeRuns`, `gradeColor`. `drawProfile(canvas, route, riders, fill, scale)` signature unchanged; `fill` now only tints the area under the line (alpha), the line itself uses grade colours.

- [ ] **Step 1:** Area under the profile filled with a horizontal `createLinearGradient` whose stops are the runs' colours at `d / route.length` (alpha 0.55); line on top, 2 px × dpr, stroked piecewise per run in its colour.
- [ ] **Step 2:** Ridden part: when a rider has `self`, fill `rgba(0,0,0,.35)` over `x ∈ [0, xSelf]`; self marker a white-ringed dot with a 1 px vertical tick down to the base (as in the screenshot).
- [ ] **Step 3:** Replace the orange climb / green sprint lines with ticks: for each of `route.climbs` and `route.sprints`, 1 px white (alpha .8) vertical ticks at start and end from the line up 8 px, and `⛰`/`⚡` (10 px × dpr font) above the start tick. Wrap: tick positions use `route.wrap`.
- [ ] **Step 4:** Return early when `canvas.clientWidth === 0`.
- [ ] **Step 5:** `npm test` pass; open `http://localhost:8000/?debug`, start a Simulator ride on a hilly route, screenshot: line green→orange/red on climbs, blue on descents, ridden part darker, ticks on segments; lobby cards show colours, no shading.
- [ ] **Step 6:** Commit `Elevation profile coloured by grade`.

### Task 3: Minimap in grade colours, Nearby/Route, collapse

**Files:** Modify `js/app.js` (`drawMinimap` ~2079, `toggleMinimap` ~2071, ride start ~1312, profile draw ~1971), `index.html:544` and `.progress` block ~576, `css/style.css` (~186, ~761), `js/i18n-uk.js`.

**Interfaces:** Consumes `gradeRuns`. New settings: `hideMap: boolean`, `hideProfile: boolean` (default false), alongside existing `bigMap`.

- [ ] **Step 1:** Route line: keep the white halo, replace the 2.2/3.2 px white line with per-run strokes in grade colour (same widths). Loop wrap: draw `[0, L]` runs with `wrap = false` as today. Remove the orange climb overlay; draw ticks (short 6 px strokes across the line at start/end, normal to it) and `⛰`/`⚡` 11 px beside the start tick.
- [ ] **Step 2:** `#minimap-size` becomes a text button: label `tr('Nearby')` when small, `tr('Route')` when big (shows the current mode); title `Map zoom (M)`. Click on the button only toggles (stop propagation); keep click-on-map toggle.
- [ ] **Step 3:** Collapse: add `<button class="hud-hide" aria-label="Hide">−</button>` top-right in `#minimap-box` and in `.progress` over `#profile`. Click toggles `settings.hideMap` / `settings.hideProfile`, `saveSettings()`, toggles class `collapsed` on the box: collapsed box keeps only the button, showing `+`. Apply saved state at ride start next to `bigMap` (~1312).
- [ ] **Step 4:** CSS: both panels `background: rgba(20,22,28,.55); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; backdrop-filter: blur(6px)`; `.hud-hide` 22 px round button; `.collapsed` hides the canvas and shrinks to the button.
- [ ] **Step 5:** `i18n-uk.js`: `'Nearby': 'Поруч'`, `'Route': 'Маршрут'`, `'Hide': 'Сховати'`, `'Map zoom (M)': 'Масштаб мапи (M)'`.
- [ ] **Step 6:** `npm test` pass (includes `syntax.test.mjs`); live check at `?debug`: colours on the map match the profile at the same spot, M and the button switch Nearby/Route, both "−" collapse and survive a reload, one-way route and a loop crossing the start line draw cleanly.
- [ ] **Step 7:** Commit `Minimap in grade colours, Nearby/Route, collapsible panels`.
