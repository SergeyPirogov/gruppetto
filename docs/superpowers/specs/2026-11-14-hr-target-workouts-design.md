# Heart rate range in intervals.icu workouts — design

## Intent
Workouts planned in intervals.icu by heart rate (e.g. `60m 78-83% LTHR (126-134bpm) 85-90rpm`) should show the
heart rate range while riding, so the rider holds it themselves. Today such steps become a plain free ride and the
range is lost.

## Goals
- A step with a heart rate target carries its range in bpm (`step.hr = [lo, hi]`).
- During the ride the workout panel shows the range; the current heart rate is green inside it, amber outside.
- The step list / workout page shows the range next to duration and cadence.

## Non-goals / anti-goals
- Heart rate never drives the trainer: no ERG change, no power adjustment, no grade change. The step stays `free`
  exactly as today.
- No "easier / harder" hints, no voice cues about heart rate.

## Approach (picked)
Considered: (1) trainer holds the heart rate (closed loop on ERG), (2) rider holds it with guidance, (3) display only.
The user picked display only.

## Details
- `convertSteps` / `convertTarget` in `js/intervals.js`: read `s.hr` (units `%lthr`, `%hr` = % of max HR, `bpm`,
  `hr_zone`; value / min-max / start-end). Percent units need LTHR / max HR / HR zones, passed in from the athlete
  profile; without them the range is left out (builder's call: no guessed numbers).
- Ride panel (`js/app.js`, workout block): a heart rate cell shown only when the workout has HR ranges, like the
  cadence column; colour classes `c-ok` / `c-warn` on the live heart rate.
- Step list (`js/app.js` step rows): `126–134 bpm` beside the cadence.
- Tests in `tests/core.test.mjs` for the conversion.
