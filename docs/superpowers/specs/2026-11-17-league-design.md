# Leagues (#84, part 2)

**Why:** testers asked for a Gruppetto league: a series of races that counts. Group races (#101) already give finish times, and the league adds them up.

## What it does
- **A Leagues tab** in the group rides' window, beside the Calendar.
  - The list: each league with its host, how many races it has and when the next one is.
  - Tap a league to see its standings (place, rider, points, races, wins) and its races. Races ridden show how many finished; races to come link to the calendar.
  - **+ New league:** a title. Hosting needs a sign-in and a profile, at most 5 leagues per host.
- **A race in a league.** In the new group ride's form, when the kind is Race and you host a league, a League select appears (or No league). Only your own leagues show, and only races go in one. In the calendar the race shows `🏁 Race · 3 laps · 🏆 Winter Cup`.
- **Points.** Each race places its finishers by time: 25, 20, 16, 13, 11, then 10 down to 1 for 15th, nothing after. Equal times share a place. Rides in the simulator get no points. The standings add the points up, most first; ties go to more wins, then a better best place.
- **Anyone sees** the leagues and the standings. A name shows when its profile is public, and your own always shows.

## Server
`supabase/migrations/0006_leagues.sql`:
- the table `leagues` (RLS on, no direct access) and `group_rides.league_id` (on delete set null: a race outlives its league);
- `create_league` (signed in, with a profile), `league_list`, `league_standings` and `league_races` (anon too), `league_points(place)`;
- `create_group_ride` takes `p_league` (your own league, a race only). The client sends it only when set, so the call works before 0006 is applied too;
- `group_ride_list` returns `league_id` and `league_title`.

Tested in `supabase/tests/leagues_test.sql` (tools/test_sql.sh). The group race checks pass with 0006 on top.

## Not yet
- **Results cannot be trusted yet.** Each Gruppetto times its own finish, and the server checks only that the time is possible. A league with prizes needs results checked on a server.
- One global «Gruppetto league» run by us: any host can set up a league for now; an official one is a league set up by our account.
- Seasons, dropping the worst result, and points for primes on the way.
