-- Group rides (#84): a ride at a set time on one of the built-in routes, which riders join and then ride together
-- live (the positions go between the riders over Supabase Realtime broadcast, not through these tables).
-- Anyone sees the calendar; only a signed-in rider with a profile hosts, joins or rides. Safe to apply again.

create table if not exists public.group_rides (
  id uuid primary key default gen_random_uuid(),
  host uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  route_id text not null check (route_id ~ '^[a-z0-9-]{1,40}$'),
  starts_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists group_rides_starts on public.group_rides (starts_at);

create table if not exists public.group_ride_riders (
  ride_id uuid not null references public.group_rides (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (ride_id, user_id)
);

-- the tables only through the functions below
alter table public.group_rides enable row level security;
alter table public.group_ride_riders enable row level security;
revoke all on public.group_rides, public.group_ride_riders from anon, authenticated;

/**
 * The calendar: rides starting from 2 hours ago (still going) up to `days` ahead, soonest first, with the host's
 * name (when the host's profile is public), how many have joined and whether you have.
 */
create or replace function public.group_ride_list(days int default 14)
returns table (id uuid, title text, route_id text, starts_at timestamptz, host_name text, mine boolean, riders int, joined boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select g.id, g.title, g.route_id, g.starts_at,
    (select p.display_name from public.public_profiles p where p.id = g.host),
    coalesce(g.host = auth.uid(), false),
    (select count(*)::int from public.group_ride_riders r where r.ride_id = g.id),
    exists (select 1 from public.group_ride_riders r where r.ride_id = g.id and r.user_id = auth.uid())
  from public.group_rides g
  where g.starts_at > now() - interval '2 hours' and g.starts_at < now() + make_interval(days => least(greatest(days, 1), 60))
  order by g.starts_at
  limit 200
$$;

/** A new group ride, hosted by you (who joins it at once): from now to 60 days ahead, at most 10 to come at a time. */
create or replace function public.create_group_ride(p_title text, p_route text, p_starts timestamptz)
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
  insert into public.group_rides (host, title, route_id, starts_at) values (uid, btrim(p_title), p_route, p_starts) returning id into gid;
  insert into public.group_ride_riders (ride_id, user_id) values (gid, uid);
  return gid;
end $$;

/** The host calls a ride off. */
create or replace function public.cancel_group_ride(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  delete from public.group_rides where id = p_id and host = auth.uid();
  if not found then raise exception 'not your group ride' using errcode = '42501'; end if;
end $$;

/** Join (on) or leave (off) a ride that has not been over for long. */
create or replace function public.join_group_ride(p_id uuid, p_on boolean default true)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = uid) then raise exception 'set up your profile first' using errcode = '42501'; end if;
  if not exists (select 1 from public.group_rides where id = p_id and starts_at > now() - interval '2 hours') then
    raise exception 'no such group ride' using errcode = '22023';
  end if;
  if p_on then insert into public.group_ride_riders (ride_id, user_id) values (p_id, uid) on conflict do nothing;
  else delete from public.group_ride_riders where ride_id = p_id and user_id = uid; end if;
end $$;

revoke all on function public.group_ride_list(int), public.create_group_ride(text, text, timestamptz),
  public.cancel_group_ride(uuid), public.join_group_ride(uuid, boolean) from public, anon, authenticated;
grant execute on function public.group_ride_list(int) to anon, authenticated;
grant execute on function public.create_group_ride(text, text, timestamptz), public.cancel_group_ride(uuid),
  public.join_group_ride(uuid, boolean) to authenticated;
