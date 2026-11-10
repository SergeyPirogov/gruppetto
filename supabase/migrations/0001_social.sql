-- Social, phase 1 (docs/specs/social-phase1.md): profiles synced between devices, and results on climbs, sprints
-- and laps in public tables. For `supabase db push`, or to paste into the SQL Editor as it is.
--
-- The page holds only the anon key: Row Level Security and the functions below are what keep the data honest.
-- Nobody inserts a result directly; submit_efforts() checks it first, the same checks as js/social-core.js
-- (checkEffort), and the server has the last word.

-- ---------- Tables ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 24),
  country char(2) check (country ~ '^[A-Z]{2}$'),
  gender text check (gender in ('m', 'f')),          -- null: not given
  public boolean not null default true,              -- shown in the tables
  data jsonb not null default '{}' check (octet_length(data::text) <= 262144), -- synced settings, levels, records (owner only)
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.efforts (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  segment_id text not null,                          -- 'carpathians-c2', 'rolling-lap'
  kind text not null check (kind in ('climb', 'sprint', 'lap')),
  route_id text not null,
  route_version text not null,
  time_s numeric(8,1) not null,
  length_m integer not null,                         -- the segment's length, for the speed check
  avg_power smallint not null,
  avg_hr smallint,
  weight_kg numeric(5,1) not null,
  ftp smallint not null,
  wkg numeric(4,2) generated always as (avg_power / weight_kg) stored,
  category char(1) not null check (category in ('A', 'B', 'C', 'D')),
  top_speed_kmh numeric(5,1),
  flags text[] not null default '{}',
  ridden_at timestamptz not null,
  created_at timestamptz not null default now(),
  client text,
  unique (user_id, segment_id, ridden_at)            -- a result sent again (the offline queue) is the same result
);
create index if not exists efforts_board on public.efforts (segment_id, route_version, time_s);
create index if not exists efforts_user_day on public.efforts (user_id, created_at);

-- updated_at follows every change of a profile
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();

-- ---------- Who sees what ----------

alter table public.profiles enable row level security;
alter table public.efforts enable row level security;

-- a profile, data and all: only its owner reads and writes it (deleting is delete_me())
drop policy if exists profiles_own_read on public.profiles;
drop policy if exists profiles_own_insert on public.profiles;
drop policy if exists profiles_own_update on public.profiles;
create policy profiles_own_read on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_own_insert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_own_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
revoke all on public.profiles from anon, authenticated;
grant select, insert, update on public.profiles to authenticated;

-- the public part of public profiles, without data (the view runs as its owner, so it reads past RLS)
create or replace view public.public_profiles as
  select id, display_name, country, gender from public.profiles where public;
revoke all on public.public_profiles from anon, authenticated;
grant select on public.public_profiles to anon, authenticated;

create or replace function public.is_public(uid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select p.public from public.profiles p where p.id = uid), false)
$$;

-- results of public profiles: anyone reads them; nobody writes them but submit_efforts(). Weight, FTP and
-- power stay out of reach (W/kg is shown, the weight on its own is not).
drop policy if exists efforts_public_read on public.efforts;
create policy efforts_public_read on public.efforts for select to anon, authenticated using (public.is_public(user_id) or user_id = auth.uid());
revoke all on public.efforts from anon, authenticated;
grant select (id, user_id, segment_id, kind, route_id, route_version, time_s, length_m, avg_hr, wkg, category, top_speed_kmh, flags, ridden_at, created_at)
  on public.efforts to anon, authenticated;

-- ---------- Checks ----------

create or replace function public.wkg_ceiling(sec numeric) returns numeric
language sql immutable set search_path = public, pg_temp as $$
  select case when sec <= 60 then 13 when sec <= 300 then 8 when sec <= 1200 then 6.8 else 6.3 end::numeric
$$;

create or replace function public.category_of(ftp numeric, weight numeric) returns char(1)
language sql immutable set search_path = public, pg_temp as $$
  select case when weight is null or weight <= 0 or ftp is null or ftp <= 0 then 'D'
    when ftp / weight >= 4 then 'A' when ftp / weight >= 3.2 then 'B' when ftp / weight >= 2.5 then 'C' else 'D' end
$$;

-- Why a result may not go in a table (null when it may): the same reasons as checkEffort() in social-core.js.
create or replace function public.effort_reject_reason(it jsonb, today integer) returns text
language plpgsql stable set search_path = public, pg_temp as $$
declare
  w numeric; f numeric; t numeric; len numeric; p numeric; rode timestamptz;
begin
  if jsonb_typeof(it) <> 'object'
    or coalesce(it->>'kind', '') not in ('climb', 'sprint', 'lap')
    or coalesce(char_length(it->>'segment_id'), 0) not between 1 and 80
    or coalesce(char_length(it->>'route_id'), 0) not between 1 and 60
    or coalesce(char_length(it->>'route_version'), 0) not between 1 and 16
    or left(it->>'segment_id', char_length(it->>'route_id')) <> it->>'route_id' then
    return 'invalid';
  end if;
  begin
    w := (it->>'weight_kg')::numeric; f := (it->>'ftp')::numeric; t := (it->>'time_s')::numeric;
    len := (it->>'length_m')::numeric; p := (it->>'avg_power')::numeric; rode := (it->>'ridden_at')::timestamptz;
    perform (it->>'avg_hr')::numeric, (it->>'top_speed_kmh')::numeric;
  exception when others then
    return 'invalid';
  end;
  if rode is null or rode > now() + interval '1 day' or rode < now() - interval '60 days' then return 'invalid'; end if;
  if today >= 200 then return 'limit'; end if;
  if w is null or w < 30 or w > 200 then return 'weight'; end if;
  if f is null or f < 50 or f > 600 then return 'ftp'; end if;
  if t is null or t < 5 or t > 86400 then return 'time'; end if;
  if len is null or len < 50 or len > 300000 or len / t > 25 then return 'speed'; end if;
  if p is null or p <= 0 or p > 3000 then return 'power'; end if;
  if p / w > public.wkg_ceiling(t) then return 'wkg'; end if;
  return null;
end $$;

-- ---------- Tables ----------

-- Each person's best in the filter, ranked: place, and how many there are.
create or replace function public.board_ranked(segment text, version text, period text, g text, cat text)
returns table (place bigint, total bigint, user_id uuid, display_name text, country char(2), time_s numeric, wkg numeric, avg_hr smallint, ridden_at timestamptz, flags text[], category char(1))
language sql stable security definer set search_path = public, pg_temp as $$
  with since as (
    select case period
      when 'week' then date_trunc('week', now() at time zone 'utc') at time zone 'utc'
      when 'month' then date_trunc('month', now() at time zone 'utc') at time zone 'utc'
      else null end as t
  ), best as (
    select distinct on (e.user_id) e.user_id, p.display_name, p.country, e.time_s, e.wkg, e.avg_hr, e.ridden_at, e.flags, e.category
    from public.efforts e join public.profiles p on p.id = e.user_id, since
    where e.segment_id = segment and e.route_version = version and p.public
      and (since.t is null or e.ridden_at >= since.t)
      and (g is null or p.gender = g)
      and (cat is null or e.category = cat)
    order by e.user_id, e.time_s, e.ridden_at
  )
  select row_number() over (order by time_s, ridden_at, user_id), count(*) over (), user_id, display_name, country, time_s, wkg, avg_hr, ridden_at, flags, category
  from best
$$;

-- A table: the top 10 and, when I am lower, three either side of me. Anyone may read it, signed in or not.
create or replace function public.leaderboard(segment text, version text, period text default 'all', gender text default null, category text default null, around_me boolean default true)
returns table (place bigint, total bigint, display_name text, country char(2), time_s numeric, wkg numeric, avg_hr smallint, ridden_at timestamptz, flags text[], category char(1), me boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  with r as (
    select * from public.board_ranked(segment, version, coalesce(period, 'all'), nullif(gender, ''), nullif(category, ''))
  ), mine as (
    select r.place from r where r.user_id = auth.uid()
  )
  select r.place, r.total, r.display_name, r.country, r.time_s, r.wkg, r.avg_hr, r.ridden_at, r.flags, r.category, r.user_id = auth.uid()
  from r left join mine on true
  where r.place <= 10 or (around_me and mine.place is not null and abs(r.place - mine.place) <= 3)
  order by r.place
$$;

-- ---------- Writing ----------

-- Results after a ride: each one checked, its category and flags worked out here, then saved. For each item, in
-- order: { status: 'saved' | 'duplicate' | 'rejected', reason?, place?, total?, week_place?, week_total? }.
create or replace function public.submit_efforts(items jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  it jsonb;
  today integer;
  reason text;
  fl text[];
  w numeric; t numeric; p numeric; hr numeric;
  new_id bigint;
  res jsonb := '[]'::jsonb;
  pl record; wk record;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = uid) then raise exception 'no profile yet' using errcode = '42501'; end if;
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) > 50 then raise exception 'items: an array of up to 50' using errcode = '22023'; end if;
  select count(*) into today from public.efforts where user_id = uid and created_at > now() - interval '1 day';
  for it in select value from jsonb_array_elements(items) loop
    reason := public.effort_reject_reason(it, today);
    -- one segment, one length: a result claiming another length than the ones already in its table is not believed
    if reason is null and exists (
      select 1 from public.efforts e where e.segment_id = it->>'segment_id' and e.route_version = it->>'route_version'
        and abs(e.length_m - (it->>'length_m')::numeric) > 5) then
      reason := 'length';
    end if;
    if reason is not null then
      res := res || jsonb_build_object('status', 'rejected', 'reason', reason);
      continue;
    end if;
    w := (it->>'weight_kg')::numeric; t := (it->>'time_s')::numeric; p := (it->>'avg_power')::numeric; hr := nullif((it->>'avg_hr')::numeric, 0);
    fl := '{}';
    if hr is null then fl := fl || 'no-hr'::text; end if;
    if p / w > 0.9 * public.wkg_ceiling(t) then fl := fl || 'high'::text; end if;
    insert into public.efforts (user_id, segment_id, kind, route_id, route_version, time_s, length_m, avg_power, avg_hr, weight_kg, ftp, category, top_speed_kmh, flags, ridden_at, client)
    values (uid, it->>'segment_id', it->>'kind', it->>'route_id', it->>'route_version', round(t, 1), round((it->>'length_m')::numeric),
      round(p), round(hr), round(w, 1), round((it->>'ftp')::numeric), public.category_of((it->>'ftp')::numeric, w),
      round((it->>'top_speed_kmh')::numeric, 1), fl, (it->>'ridden_at')::timestamptz, left(it->>'client', 40))
    on conflict (user_id, segment_id, ridden_at) do nothing
    returning id into new_id;
    if new_id is not null then today := today + 1; end if;
    select b.place, b.total into pl from public.board_ranked(it->>'segment_id', it->>'route_version', 'all', null, null) b where b.user_id = uid;
    select b.place, b.total into wk from public.board_ranked(it->>'segment_id', it->>'route_version', 'week', null, null) b where b.user_id = uid;
    res := res || jsonb_strip_nulls(jsonb_build_object('status', case when new_id is null then 'duplicate' else 'saved' end,
      'place', pl.place, 'total', pl.total, 'week_place', wk.place, 'week_total', wk.total));
    new_id := null; pl := null; wk := null;
  end loop;
  return res;
end $$;

-- The account and everything in it, at once (the profile and the results go with it, by cascade).
create or replace function public.delete_me() returns void
language plpgsql volatile security definer set search_path = public, auth, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  delete from auth.users where id = auth.uid();
end $$;

-- ---------- Who may call what ----------

revoke all on function public.is_public(uuid) from public, anon, authenticated;
revoke all on function public.effort_reject_reason(jsonb, integer) from public, anon, authenticated;
revoke all on function public.board_ranked(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.submit_efforts(jsonb) from public, anon;
revoke all on function public.delete_me() from public, anon;
revoke all on function public.leaderboard(text, text, text, text, text, boolean) from public;
grant execute on function public.is_public(uuid) to anon, authenticated; -- the read policy on efforts calls it
grant execute on function public.submit_efforts(jsonb) to authenticated;
grant execute on function public.delete_me() to authenticated;
grant execute on function public.leaderboard(text, text, text, text, text, boolean) to anon, authenticated;
