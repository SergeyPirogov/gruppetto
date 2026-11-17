-- Leagues (#84, part 2): a series of group races with points. A host sets up a league and puts their own races in
-- it; each race gives points by place (the times in group_race_results, rides in the simulator left out), and the
-- standings are the points added up. Anyone sees the leagues and their standings. Safe to apply again.

create table if not exists public.leagues (
  id uuid primary key default gen_random_uuid(),
  host uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  created_at timestamptz not null default now()
);
alter table public.leagues enable row level security;
revoke all on public.leagues from anon, authenticated;

alter table public.group_rides add column if not exists league_id uuid references public.leagues (id) on delete set null;
create index if not exists group_rides_league on public.group_rides (league_id) where league_id is not null;

/** The points for a place in a race: 25, 20, 16, 13, 11, 10 … 1 for 15th, nothing after. */
create or replace function public.league_points(place int)
returns int language sql immutable as $$
  select case when place between 1 and 15 then (array[25, 20, 16, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])[place] else 0 end
$$;

/** A new league, hosted by you: at most 5 of your own. */
create or replace function public.create_league(p_title text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); lid uuid;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = uid) then raise exception 'set up your profile first' using errcode = '42501'; end if;
  if (select count(*) from public.leagues where host = uid) >= 5 then raise exception 'too many leagues' using errcode = '54000'; end if;
  insert into public.leagues (host, title) values (uid, btrim(p_title)) returning id into lid;
  return lid;
end $$;

/** The leagues: the host's name (when public), how many races, the next one to come, and whether it is yours. */
create or replace function public.league_list()
returns table (id uuid, title text, host_name text, races int, next_at timestamptz, mine boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select l.id, l.title,
    (select p.display_name from public.public_profiles p where p.id = l.host),
    (select count(*)::int from public.group_rides g where g.league_id = l.id),
    (select min(g.starts_at) from public.group_rides g where g.league_id = l.id and g.starts_at > now() - interval '2 hours'),
    coalesce(l.host = auth.uid(), false)
  from public.leagues l
  order by (select min(g.starts_at) from public.group_rides g where g.league_id = l.id and g.starts_at > now() - interval '2 hours') nulls last, l.created_at desc
  limit 200
$$;

/**
 * A league's standings: each race's finishers (not in the simulator) placed by time, the points for each place
 * added up per rider, most first. The name shows when the profile is public, and always yours.
 */
create or replace function public.league_standings(p_id uuid)
returns table (name text, points int, races int, wins int, best int, me boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  with placed as (
    select r.user_id, rank() over (partition by r.ride_id order by r.time_s)::int as place
    from public.group_race_results r join public.group_rides g on g.id = r.ride_id
    where g.league_id = p_id and g.kind = 'race' and not r.sim
  )
  select case when x.user_id = auth.uid() then (select p.display_name from public.profiles p where p.id = x.user_id)
    else (select p.display_name from public.public_profiles p where p.id = x.user_id) end,
    sum(public.league_points(x.place))::int, count(*)::int, count(*) filter (where x.place = 1)::int, min(x.place),
    coalesce(x.user_id = auth.uid(), false)
  from placed x
  group by x.user_id
  order by 2 desc, 4 desc, 5, 3 desc
  limit 500
$$;

-- the calendar, now with the league (a new return type: dropped first)
drop function if exists public.group_ride_list(int);
create function public.group_ride_list(days int default 14)
returns table (id uuid, title text, route_id text, starts_at timestamptz, host_name text, mine boolean, riders int, joined boolean, kind text, laps int, league_id uuid, league_title text)
language sql stable security definer set search_path = public, pg_temp as $$
  select g.id, g.title, g.route_id, g.starts_at,
    (select p.display_name from public.public_profiles p where p.id = g.host),
    coalesce(g.host = auth.uid(), false),
    (select count(*)::int from public.group_ride_riders r where r.ride_id = g.id),
    exists (select 1 from public.group_ride_riders r where r.ride_id = g.id and r.user_id = auth.uid()),
    g.kind, g.laps, g.league_id, (select l.title from public.leagues l where l.id = g.league_id)
  from public.group_rides g
  where g.starts_at > now() - interval '2 hours' and g.starts_at < now() + make_interval(days => least(greatest(days, 1), 60))
  order by g.starts_at
  limit 200
$$;

/** A league's races, newest last: for its page (the ones done, and those to come). */
create or replace function public.league_races(p_id uuid)
returns table (id uuid, title text, route_id text, starts_at timestamptz, laps int, finishers int)
language sql stable security definer set search_path = public, pg_temp as $$
  select g.id, g.title, g.route_id, g.starts_at, g.laps,
    (select count(*)::int from public.group_race_results r where r.ride_id = g.id and not r.sim)
  from public.group_rides g
  where g.league_id = p_id
  order by g.starts_at
  limit 200
$$;

-- a new ride, or a race over p_laps laps, in one of your leagues (p_league)
drop function if exists public.create_group_ride(text, text, timestamptz, text, int);
create or replace function public.create_group_ride(p_title text, p_route text, p_starts timestamptz, p_kind text default 'ride', p_laps int default null, p_league uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); gid uuid;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = uid) then raise exception 'set up your profile first' using errcode = '42501'; end if;
  if p_starts < now() - interval '5 minutes' or p_starts > now() + interval '60 days' then
    raise exception 'start time out of range' using errcode = '22023';
  end if;
  if (select count(*) from public.group_rides where host = uid and starts_at > now()) >= 10 then
    raise exception 'too many group rides to come' using errcode = '54000';
  end if;
  if p_league is not null then
    if coalesce(p_kind, 'ride') <> 'race' then raise exception 'only a race goes in a league' using errcode = '22023'; end if;
    if not exists (select 1 from public.leagues where id = p_league and host = uid) then raise exception 'not your league' using errcode = '42501'; end if;
  end if;
  insert into public.group_rides (host, title, route_id, starts_at, kind, laps, league_id)
    values (uid, btrim(p_title), p_route, p_starts, coalesce(p_kind, 'ride'), case when p_kind = 'race' then coalesce(p_laps, 1) end, p_league)
    returning id into gid;
  insert into public.group_ride_riders (ride_id, user_id) values (gid, uid);
  return gid;
end $$;

revoke all on function public.group_ride_list(int), public.create_group_ride(text, text, timestamptz, text, int, uuid),
  public.create_league(text), public.league_list(), public.league_standings(uuid), public.league_races(uuid)
  from public, anon, authenticated;
grant execute on function public.group_ride_list(int), public.league_list(), public.league_standings(uuid), public.league_races(uuid) to anon, authenticated;
grant execute on function public.create_group_ride(text, text, timestamptz, text, int, uuid), public.create_league(text) to authenticated;
