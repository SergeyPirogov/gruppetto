-- Group races: a group ride can be a race over a number of laps. Each rider's Gruppetto times its own finish
-- (the line crossed, worked out between frames) and sends it here; the results are those times, fastest first.
-- Safe to apply again.

alter table public.group_rides add column if not exists kind text not null default 'ride';
alter table public.group_rides add column if not exists laps int;
do $$ begin
  alter table public.group_rides add constraint group_rides_kind check (kind in ('ride', 'race'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.group_rides add constraint group_rides_laps check (laps is null or laps between 1 and 10);
exception when duplicate_object then null; end $$;

create table if not exists public.group_race_results (
  ride_id uuid not null references public.group_rides (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  time_s real not null check (time_s > 0),
  avg_w int check (avg_w between 0 and 3000),
  wkg real check (wkg between 0 and 20),
  sim boolean not null default false,
  finished_at timestamptz not null default now(),
  primary key (ride_id, user_id)
);
alter table public.group_race_results enable row level security;
revoke all on public.group_race_results from anon, authenticated;

-- the calendar, now with the kind and the laps (a new return type: dropped first)
drop function if exists public.group_ride_list(int);
create function public.group_ride_list(days int default 14)
returns table (id uuid, title text, route_id text, starts_at timestamptz, host_name text, mine boolean, riders int, joined boolean, kind text, laps int)
language sql stable security definer set search_path = public, pg_temp as $$
  select g.id, g.title, g.route_id, g.starts_at,
    (select p.display_name from public.public_profiles p where p.id = g.host),
    coalesce(g.host = auth.uid(), false),
    (select count(*)::int from public.group_ride_riders r where r.ride_id = g.id),
    exists (select 1 from public.group_ride_riders r where r.ride_id = g.id and r.user_id = auth.uid()),
    g.kind, g.laps
  from public.group_rides g
  where g.starts_at > now() - interval '2 hours' and g.starts_at < now() + make_interval(days => least(greatest(days, 1), 60))
  order by g.starts_at
  limit 200
$$;

-- a new ride, or a race over p_laps laps
drop function if exists public.create_group_ride(text, text, timestamptz);
create or replace function public.create_group_ride(p_title text, p_route text, p_starts timestamptz, p_kind text default 'ride', p_laps int default null)
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
  insert into public.group_rides (host, title, route_id, starts_at, kind, laps)
    values (uid, btrim(p_title), p_route, p_starts, coalesce(p_kind, 'ride'), case when p_kind = 'race' then coalesce(p_laps, 1) end)
    returning id into gid;
  insert into public.group_ride_riders (ride_id, user_id) values (gid, uid);
  return gid;
end $$;

/**
 * Your finish in a race you have joined: once (the first time stands), after the start and while the ride is open,
 * and no faster than the time since the start allows.
 */
create or replace function public.finish_group_race(p_id uuid, p_time real, p_avg_w int default null, p_wkg real default null, p_sim boolean default false)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); g public.group_rides;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into g from public.group_rides where id = p_id;
  if g.id is null or g.kind <> 'race' then raise exception 'no such group race' using errcode = '22023'; end if;
  if not exists (select 1 from public.group_ride_riders where ride_id = p_id and user_id = uid) then
    raise exception 'join the race first' using errcode = '42501';
  end if;
  if now() < g.starts_at or now() > g.starts_at + interval '4 hours' then raise exception 'the race is not on' using errcode = '22023'; end if;
  if p_time is null or p_time < 10 or p_time > extract(epoch from now() - g.starts_at) + 30 then
    raise exception 'finish time out of range' using errcode = '22023';
  end if;
  insert into public.group_race_results (ride_id, user_id, time_s, avg_w, wkg, sim)
    values (p_id, uid, p_time, p_avg_w, p_wkg, coalesce(p_sim, false))
    on conflict do nothing;
end $$;

/** A race's results, fastest first: the name (when the profile is public, and always yours), the time and the watts. */
create or replace function public.group_race_results(p_id uuid)
returns table (name text, time_s real, avg_w int, wkg real, sim boolean, me boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select case when r.user_id = auth.uid() then (select p.display_name from public.profiles p where p.id = r.user_id)
    else (select p.display_name from public.public_profiles p where p.id = r.user_id) end,
    r.time_s, r.avg_w, r.wkg, r.sim, coalesce(r.user_id = auth.uid(), false)
  from public.group_race_results r
  where r.ride_id = p_id
  order by r.time_s
  limit 500
$$;

revoke all on function public.group_ride_list(int), public.create_group_ride(text, text, timestamptz, text, int),
  public.finish_group_race(uuid, real, int, real, boolean), public.group_race_results(uuid) from public, anon, authenticated;
grant execute on function public.group_ride_list(int), public.group_race_results(uuid) to anon, authenticated;
grant execute on function public.create_group_ride(text, text, timestamptz, text, int), public.finish_group_race(uuid, real, int, real, boolean) to authenticated;
