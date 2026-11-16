# Group rides (#84, part 1)

**Why:** testers asked for club rides: people see a time and a route and come to ride together. A league needs this first.

## What it does
- **Calendar.** A 👥 Group rides button in the header opens the calendar of rides from 2 hours ago to 14 days ahead.
  - Each row: time, title, route, host, how many are going.
  - Buttons: Join or Going, Copy the link (`#group=<id>`), Call off (the host, before the start), and Ride once the ride is open.
- **Anyone sees the calendar.** Hosting, joining and riding need a sign-in and a profile, like the ratings (#87).
- **A new ride:** a title, a built-in route (a GPX of your own lives only on your device), a date and a time.
  - Allowed from now to 60 days ahead, at most 10 upcoming rides per host.
  - The link is copied at once to send to friends.
- **Riding.** The ride opens 10 minutes before the start and stays open for 2 hours after it.
  - You wait on the start line with a small «Group start in m:ss» clock. Your place on the line is picked from your account: four across, rows 1.9 m apart.
  - At the start everyone goes together with 3-2-1 GO.
  - It is a free ride: no bots, no pacer, no ghost, no attacks.
- **Live.**
  - Each rider sends `{id, name, dist, v, lane, W/kg, jersey, stripe, bike, figure}` once a second over Supabase Realtime broadcast, on channel `group:<id>`.
  - The others are drawn where their packet puts them, carried on at their speed, and eased toward each new packet. A far jump snaps.
  - A rider silent for 6 s goes.
  - Their shelter counts. You keep out of their line when passing. There is no collision with them (lag would make you stick).

## Server
`supabase/migrations/0004_group_rides.sql`:
- tables `group_rides` and `group_ride_riders`, RLS on, no direct access;
- functions `group_ride_list` (anon too), `create_group_ride`, `cancel_group_ride` and `join_group_ride` (signed in, with a profile);
- the host's name shows only when their profile is public;
- the rides go when the host's account is deleted.

## Approaches considered
1. **Realtime broadcast between clients (picked).** Nothing new to run. Supabase is already there and its broadcast works with the anon key (checked).
2. A game server of our own (WebSocket). Authoritative and cheat-proof, but a server to host and pay for. That is for when results count.
3. Postgres rows for positions. Too slow and too heavy at 1 Hz.

## Not yet (next parts)
- **The league:** a series of group rides with results and points. It needs finish results that cannot be forged, and broadcast can be.
- **Chat (#85) and spectator mode (#86):** both go over the same channel.
- A private channel (RLS on `realtime.messages`), so only those who joined hear the ride.
