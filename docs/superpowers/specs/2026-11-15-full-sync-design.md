# Full sync of the profile and rides (signed in with Google)

## Why
Signed in, a rider expects the same Gruppetto on every device: the profile, how they like to ride, their own
workouts and their ride history. Until now only the core profile, levels and records followed them.

## What syncs
- **Settings**: the profile as before, plus the kit and figure and the riding preferences (difficulty, gears,
  pacer, bots, attacks, ghost, scene, upload switches). Not synced: intervals.icu key and athlete, graphics,
  quality, camera, sound, picture-in-picture, overlay, analytics consent, the current mode. Newer whole set wins
  (settingsUpdatedAt), as before.
- **Your own workouts**: in `profiles.data.workouts` as `{ list, deleted }`. Item by item: the copy with the later
  `updatedAt` wins; a deletion (`deleted[id] = ms`) wins over copies older than it.
- **Ride history**: a new table `activities` (0002_activities.sql), one row per ride with the history entry as
  the app keeps it, or a deletion row. Same rule by `changed_at`. Each device keeps its latest 100.
- Not yet: the second-by-second records (IndexedDB). A ride from another device shows its summary, but its
  .FIT/.TCX download and intervals.icu upload stay on the device that recorded it.

## Approaches considered
1. Everything in `profiles.data` (one JSON): simplest, but the 256 KB cap and rewriting all of it on every ride.
2. **A table for rides, workouts in data** (picked): rides grow without bound and change one at a time; workouts
   are few and small.
3. A table per kind, with server-side merge functions: more SQL to keep in step for no gain at this size.

## Mechanics
- `stampChanged(list, seen)` gives an item a new `updatedAt` when its content changed since the last save.
- `mergeById(local, remote, { deleted })` → `{ items, push, removed }`.
- `sync()` (sign-in, page load, 3 s after any change) merges settings/records/levels, then workouts, then rides.
- Deleting a ride or workout here records a tombstone so the other devices drop it too.

## Setup
Paste `supabase/migrations/0002_activities.sql` into the Supabase SQL Editor (or `supabase db push`). Until then
the ride part is skipped quietly; the rest works.
