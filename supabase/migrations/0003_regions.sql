-- Ratings across Ukraine: oblast against oblast, and rider against rider, by the kilometres ridden and the metres
-- climbed in a week, a month or all time (docs/superpowers/specs/2026-11-16-regions-design.md). For
-- `supabase db push`, or to paste into the SQL Editor as it is; safe to apply again.
--
-- Each ride on a trainer sends its totals once (submit_rides), checked like the segment results; the simulator's
-- rides never come here. The oblast is the rider's, from the profile, as it is now.

-- ---------- The oblast in the profile ----------

-- ISO 3166-2:UA, 'UA-71' (Cherkasy). Only with the country UA; null: not given.
alter table public.profiles add column if not exists region text;
alter table public.profiles drop constraint if exists profiles_region_check;
alter table public.profiles add constraint profiles_region_check check (
  region is null or (country = 'UA' and region in (
    'UA-05', 'UA-07', 'UA-09', 'UA-12', 'UA-14', 'UA-18', 'UA-21', 'UA-23', 'UA-26', 'UA-30', 'UA-32', 'UA-35', 'UA-40',
    'UA-43', 'UA-46', 'UA-48', 'UA-51', 'UA-53', 'UA-56', 'UA-59', 'UA-61', 'UA-63', 'UA-65', 'UA-68', 'UA-71', 'UA-74', 'UA-77')));

create or replace view public.public_profiles as
  select id, display_name, country, gender, region from public.profiles where public;
revoke all on public.public_profiles from anon, authenticated;
grant select on public.public_profiles to anon, authenticated;

-- ---------- Rides ----------

create table if not exists public.ride_totals (
  user_id uuid not null references public.profiles on delete cascade,
  ride_id text not null check (char_length(ride_id) between 1 and 40), -- the app's ride id, 'r1794746...'
  ridden_at timestamptz not null,
  distance_m integer not null,
  climb_m integer not null,
  duration_s integer not null,
  created_at timestamptz not null default now(),
  client text,
  primary key (user_id, ride_id)                                       -- sent again (the queue): the same ride
);
create index if not exists ride_totals_when on public.ride_totals (ridden_at);

-- nobody reads or writes the rows themselves: submit_rides() writes, the boards below read sums
alter table public.ride_totals enable row level security;
revoke all on public.ride_totals from anon, authenticated;

-- Why a ride may not count (null when it may): believable distance, speed, climbing and power.
create or replace function public.ride_reject_reason(it jsonb, today integer) returns text
language plpgsql stable set search_path = public, pg_temp as $$
declare
  d numeric; c numeric; t numeric; p numeric; w numeric; rode timestamptz;
begin
  if jsonb_typeof(it) <> 'object' or coalesce(char_length(it->>'ride_id'), 0) not between 1 and 40 then return 'invalid'; end if;
  begin
    d := (it->>'distance_m')::numeric; c := (it->>'climb_m')::numeric; t := (it->>'duration_s')::numeric;
    p := (it->>'avg_power')::numeric; w := (it->>'weight_kg')::numeric; rode := (it->>'ridden_at')::timestamptz;
  exception when others then
    return 'invalid';
  end;
  if rode is null or rode > now() + interval '1 day' or rode < now() - interval '60 days' then return 'invalid'; end if;
  if today >= 20 then return 'limit'; end if;
  if t is null or t < 300 or t > 43200 then return 'time'; end if;              -- 5 minutes to 12 hours
  if d is null or d < 1000 or d > 400000 or d / t > 16.7 then return 'speed'; end if; -- at most 60 km/h on average
  if c is null or c < 0 or c > 10000 or c > d * 0.2 then return 'climb'; end if;
  if w is null or w < 30 or w > 200 then return 'weight'; end if;
  if p is null or p <= 0 or p / w > public.wkg_ceiling(t) then return 'power'; end if;
  return null;
end $$;

-- Rides after riding: [{ ride_id, ridden_at, distance_m, climb_m, duration_s, avg_power, weight_kg, client }].
-- For each, in order: { status: 'saved' | 'duplicate' | 'rejected', reason? }.
create or replace function public.submit_rides(items jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  it jsonb;
  today integer;
  reason text;
  n integer;
  res jsonb := '[]'::jsonb;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = uid) then raise exception 'no profile yet' using errcode = '42501'; end if;
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) > 50 then raise exception 'items: an array of up to 50' using errcode = '22023'; end if;
  select count(*) into today from public.ride_totals where user_id = uid and created_at > now() - interval '1 day';
  for it in select value from jsonb_array_elements(items) loop
    reason := public.ride_reject_reason(it, today);
    if reason is not null then
      res := res || jsonb_build_object('status', 'rejected', 'reason', reason);
      continue;
    end if;
    insert into public.ride_totals (user_id, ride_id, ridden_at, distance_m, climb_m, duration_s, client)
    values (uid, it->>'ride_id', (it->>'ridden_at')::timestamptz, round((it->>'distance_m')::numeric), round((it->>'climb_m')::numeric),
      round((it->>'duration_s')::numeric), left(it->>'client', 40))
    on conflict (user_id, ride_id) do nothing;
    get diagnostics n = row_count;
    today := today + n;
    res := res || jsonb_build_object('status', case when n = 0 then 'duplicate' else 'saved' end);
  end loop;
  return res;
end $$;

-- ---------- Ratings ----------

create or replace function public.period_start(period text) returns timestamptz
language sql stable set search_path = public, pg_temp as $$
  select case period
    when 'week' then date_trunc('week', now() at time zone 'Europe/Kyiv') at time zone 'Europe/Kyiv'
    when 'month' then date_trunc('month', now() at time zone 'Europe/Kyiv') at time zone 'Europe/Kyiv'
    else null end
$$;

-- Oblast against oblast: every oblast with a ride in the period, the public riders' sums. metric: 'km' | 'climb'.
create or replace function public.region_board(period text default 'week', metric text default 'km')
returns table (place bigint, region text, riders bigint, rides bigint, distance_km numeric, climb_m bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  with s as (
    select p.region, count(distinct r.user_id) riders, count(*) rides, round(sum(r.distance_m) / 1000.0, 1) distance_km, sum(r.climb_m)::bigint climb_m
    from public.ride_totals r join public.profiles p on p.id = r.user_id
    where p.public and p.region is not null and (public.period_start(period) is null or r.ridden_at >= public.period_start(period))
    group by p.region
  )
  select row_number() over (order by case when metric = 'climb' then s.climb_m else s.distance_km end desc, s.region), s.*
  from s order by 1
$$;

-- Rider against rider across Ukraine (or one oblast): the top 10 and, when I am lower, three either side of me.
create or replace function public.rider_board(period text default 'week', metric text default 'km', region text default null,
  gender text default null, around_me boolean default true)
returns table (place bigint, total bigint, display_name text, region text, rides bigint, distance_km numeric, climb_m bigint, me boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  with s as (
    select r.user_id, p.display_name, p.region, count(*) rides, round(sum(r.distance_m) / 1000.0, 1) distance_km, sum(r.climb_m)::bigint climb_m
    from public.ride_totals r join public.profiles p on p.id = r.user_id
    where p.public and p.country = 'UA' and (public.period_start(period) is null or r.ridden_at >= public.period_start(period))
      and (nullif(rider_board.region, '') is null or p.region = rider_board.region)
      and (nullif(rider_board.gender, '') is null or p.gender = rider_board.gender)
    group by r.user_id, p.display_name, p.region
  ), ranked as (
    select row_number() over (order by case when metric = 'climb' then s.climb_m else s.distance_km end desc, s.user_id) place, count(*) over () total, s.*
    from s
  ), mine as (
    select ranked.place from ranked where ranked.user_id = auth.uid()
  )
  select k.place, k.total, k.display_name, k.region, k.rides, k.distance_km, k.climb_m, k.user_id = auth.uid()
  from ranked k left join mine on true
  where k.place <= 10 or (around_me and mine.place is not null and abs(k.place - mine.place) <= 3)
  order by k.place
$$;

-- ---------- Who may call what ----------

revoke all on function public.ride_reject_reason(jsonb, integer) from public, anon, authenticated;
revoke all on function public.submit_rides(jsonb) from public, anon;
revoke all on function public.region_board(text, text) from public;
revoke all on function public.rider_board(text, text, text, text, boolean) from public;
grant execute on function public.submit_rides(jsonb) to authenticated;
grant execute on function public.region_board(text, text) to anon, authenticated;
grant execute on function public.rider_board(text, text, text, text, boolean) to anon, authenticated;
