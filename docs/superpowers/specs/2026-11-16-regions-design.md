# Ratings across Ukraine: oblast against oblast

The first testers asked for something that makes the app interesting for Ukrainian riders. They suggested a rating by region (oblasts, not cities: there are too many cities), with kilometres ridden and metres climbed. Cherkasy against Kyiv, for example.

## What it is

- **Profile:** the rider's oblast (ISO 3166-2:UA, `UA-71`) goes in the account profile, next to the country. The field shows only when the country is Ukraine.
- **Rides:** each ride on a trainer sends its totals once: distance, climbing and duration. The server checks them like the segment results. The simulator never sends.
- **Two boards:** they open from "🇺🇦 Ratings of Ukraine" in the lobby.
  - Oblasts: the summed kilometres or climbing of the public riders in each oblast, and how many riders. A bar shows each oblast's share of the leader.
  - Riders: rider against rider across Ukraine, or within one oblast. Women, men or everyone. The top 10, plus three places either side of you.
- **Periods:** this week, this month and all time. The week and month follow Kyiv time.

## Decisions

- **The rides have their own table (`ride_totals`), not the synced history (`activities`).** History entries carry no simulator flag. Older entries could not be told apart, and the history is private to its owner.
- **A ride counts for the rider's oblast as it is now, not as it was when ridden.** This keeps it simple, and moving oblast is rare.
- **The checks are a plausibility floor, not proof.**
  - 5 min to 12 h.
  - 1 to 400 km.
  - At most 60 km/h on average.
  - Climbing at most 20 % of the distance and 10 km.
  - Average power under the W/kg ceiling.
  - At most 20 rides a day.
  - Not older than 60 days.
- **A ride ridden before signing in waits in a local queue (up to 100).** It is sent after sign-in and still counts if it is under 60 days old.
- **The men/women tables already existed** in the segment boards (gender in the profile). The rider board gets the same filter.

## Not in this

The tester also asked for these. They are in the backlog:

- a club ride calendar and a league (#84);
- chat (#85);
- a race spectator mode (#86);
- sign-up for the ratings (#87).

## Rollout

`supabase/migrations/0003_regions.sql` must be applied to the project. The page works without it: it falls back to the old profile columns, and the board says it cannot connect. `npm run test:sql` checks the SQL (Docker).
