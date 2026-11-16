# Minimap and elevation profile coloured by gradient

**Why.** The user wants the in-ride map and profile to read like the screenshot they shared: you see at a glance where the road climbs, how steep, and where it drops, without reading numbers.

**Goals**
- Route line on the minimap and the fill/line of the elevation profile coloured by the grade at each point: blue on descents, green on the flat, then yellow, orange, red as it steepens; colours blend smoothly along the road.
- Profile: the part already ridden is shaded darker; your position is a marker on the line.
- Both panels translucent with rounded corners, each with a "−" button that collapses it (remembered between rides).
- Minimap: a labelled "Nearby" / "Route" toggle replaces the ⤢ icon (same two zooms as today: ~1.2 km around you, or the whole route; M still toggles).

**Timed segments (user picked option A).** Orange/green no longer mean "climb"/"sprint", so segments are shown as thin start and finish ticks above the line (⛰ for a climb, ⚡ for a sprint at the start tick), on both the map and the profile.

**Non-goals.** No change to the 3D scene, the lobby layout, the phone layout (map and profile stay hidden under 760 px), or to how climbs are detected.

**Approaches.** One sensible way: extend the existing canvas drawing (`drawMinimap` in `js/app.js`, `drawProfile` in `js/render.js`). A WebGL or SVG rewrite would cost more and gain nothing at this size.

**Builder's calls (proposed, open to correction)**
- Colour scale by grade, smooth between stops: ≤ −4 % blue `#3b82f6`, −1 % teal, 0–1 % green `#22c55e`, 3 % yellow `#eab308`, 6 % orange `#f97316`, ≥ 9 % red `#dc2626`. Grade from `route.gradeAt(d)`, sampled every 25 m.
- The route cards in the lobby use the same `drawProfile`, so they get the gradient colours too (no shading of ridden part there).
- Collapsed state in `settings.hideMap` / `settings.hideProfile`; collapsed panel shrinks to its "+" button.
