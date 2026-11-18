-- A group ride or race started when everyone is ready (tester: «create a race and start it on request, in 2
-- minutes or 10, once all have joined», as Zwift cannot). Set up «when ready», it is held: open to ride onto the
-- start line at once, for up to 2 hours, and its host starts it with a countdown of 10 s to 30 min. Then it is a
-- ride with a start time like any other (the race checks of 0008 run from that start). Safe to apply again.

alter table public.group_rides add column if not exists held boolean not null default false;

drop function if exists public.group_ride_list(int);
create function public.group_ride_list(days int default 14)
returns table (id uuid, title text, route_id text, starts_at timestamptz, host_name text, mine boolean, riders int, joined boolean, kind text, laps int, league_id uuid, league_title text, held boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select g.id, g.title, g.route_id, g.starts_at,
    (select p.display_name from public.public_profiles p where p.id = g.host),
    coalesce(g.host = auth.uid(), false),
    (select count(*)::int from public.group_ride_riders r where r.ride_id = g.id),
    exists (select 1 from public.group_ride_riders r where r.ride_id = g.id and r.user_id = auth.uid()),
    g.kind, g.laps, g.league_id, (select l.title from public.leagues l where l.id = g.league_id), g.held
  from public.group_rides g
  -- a held ride's starts_at is the latest it waits to (2 hours from set up); it is gone once that passes unstarted
  where (case when g.held then g.starts_at > now() else g.starts_at > now() - interval '2 hours' end)
    and g.starts_at < now() + make_interval(days => least(greatest(days, 1), 60))
  order by g.held desc, g.starts_at
  limit 200
$$;

-- set up a ride, held (p_held: p_starts is then ignored) or at a time
drop function if exists public.create_group_ride(text, text, timestamptz, text, int, uuid, boolean);
create function public.create_group_ride(p_title text, p_route text, p_starts timestamptz, p_kind text default 'ride', p_laps int default null, p_league uuid default null, p_held boolean default false)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); gid uuid; held boolean := coalesce(p_held, false);
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = uid) then raise exception 'set up your profile first' using errcode = '42501'; end if;
  if held then p_starts := now() + interval '2 hours';
  elsif p_starts < now() - interval '5 minutes' or p_starts > now() + interval '60 days' then
    raise exception 'start time out of range' using errcode = '22023';
  end if;
  if (select count(*) from public.group_rides where host = uid and starts_at > now()) >= 10 then
    raise exception 'too many group rides to come' using errcode = '54000';
  end if;
  if p_league is not null then
    if coalesce(p_kind, 'ride') <> 'race' then raise exception 'only a race goes in a league' using errcode = '22023'; end if;
    if not exists (select 1 from public.leagues where id = p_league and host = uid) then raise exception 'not your league' using errcode = '42501'; end if;
  end if;
  insert into public.group_rides (host, title, route_id, starts_at, kind, laps, league_id, held)
    values (uid, btrim(p_title), p_route, p_starts, coalesce(p_kind, 'ride'), case when p_kind = 'race' then coalesce(p_laps, 1) end, p_league, held)
    returning id into gid;
  insert into public.group_ride_riders (ride_id, user_id) values (gid, uid);
  return gid;
end $$;
-- the 6-argument one of 0006 would make a call with 6 named arguments ambiguous
drop function if exists public.create_group_ride(text, text, timestamptz, text, int, uuid);

-- the host starts a held ride: in p_in seconds (10 s to 30 min); the new start time
create or replace function public.start_group_ride(p_id uuid, p_in int)
returns timestamptz language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); t timestamptz;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if p_in is null or p_in < 10 or p_in > 1800 then raise exception 'start in 10 s to 30 min' using errcode = '22023'; end if;
  update public.group_rides set starts_at = now() + make_interval(secs => p_in), held = false
    where id = p_id and host = uid and held and starts_at > now()
    returning starts_at into t;
  if t is null then raise exception 'not a held ride of yours' using errcode = '42501'; end if;
  return t;
end $$;

revoke all on function public.group_ride_list(int), public.create_group_ride(text, text, timestamptz, text, int, uuid, boolean),
  public.start_group_ride(uuid, int) from public, anon, authenticated;
grant execute on function public.group_ride_list(int) to anon, authenticated;
grant execute on function public.create_group_ride(text, text, timestamptz, text, int, uuid, boolean), public.start_group_ride(uuid, int) to authenticated;
