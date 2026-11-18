-- Group races: a finish the server can believe. 0005 already takes one finish per rider who joined, after the
-- start, never faster than the time since the start. Two more checks, so a made-up time does not win league points:
--   * the clock: the time is sent when it was ridden, so start + time is within 10 minutes of now (the lobby, a
--     slow network); a fast time sent an hour later does not count;
--   * the road: no faster than 65 km/h on average over the race's distance, for the built-in routes known here.
-- Safe to apply again.

create table if not exists public.route_lengths (
  id text primary key check (id ~ '^[a-z0-9-]{1,40}$'),
  length_m int not null check (length_m > 0),
  one_way boolean not null default false
);
alter table public.route_lengths enable row level security;
revoke all on public.route_lengths from anon, authenticated;

-- the built-in routes (js/routes.js); one that is not here gets the clock check only
insert into public.route_lengths (id, length_m, one_way) values
  ('level', 45000, false), ('flat', 8000, false), ('velodrome', 500, false), ('lakes', 20000, false),
  ('steppe', 25000, false), ('rolling', 12000, false), ('coast', 15000, false), ('autumn', 10000, false),
  ('sunset', 20000, false), ('winter', 9000, false), ('desert', 12000, false), ('carpathians', 14000, false),
  ('mountain', 16000, false)
on conflict (id) do update set length_m = excluded.length_m, one_way = excluded.one_way;

/**
 * Your finish in a race you have joined: once (the first time stands), after the start and while the ride is open,
 * no faster than the time since the start allows, sent within 10 minutes of riding it, and at 65 km/h at most.
 */
create or replace function public.finish_group_race(p_id uuid, p_time real, p_avg_w int default null, p_wkg real default null, p_sim boolean default false)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); g public.group_rides; since real; r public.route_lengths; dist real;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into g from public.group_rides where id = p_id;
  if g.id is null or g.kind <> 'race' then raise exception 'no such group race' using errcode = '22023'; end if;
  if not exists (select 1 from public.group_ride_riders where ride_id = p_id and user_id = uid) then
    raise exception 'join the race first' using errcode = '42501';
  end if;
  if now() < g.starts_at or now() > g.starts_at + interval '4 hours' then raise exception 'the race is not on' using errcode = '22023'; end if;
  since := extract(epoch from now() - g.starts_at);
  if p_time is null or p_time < 10 or p_time > since + 30 then
    raise exception 'finish time out of range' using errcode = '22023';
  end if;
  if p_time < since - 600 then raise exception 'finish sent too long after it was ridden' using errcode = '22023'; end if;
  select * into r from public.route_lengths where id = g.route_id;
  if r.id is not null then
    dist := r.length_m * (case when r.one_way then 1 else greatest(coalesce(g.laps, 1), 1) end);
    if dist / p_time > 65 / 3.6 then raise exception 'faster than a bike goes' using errcode = '22023'; end if;
  end if;
  insert into public.group_race_results (ride_id, user_id, time_s, avg_w, wkg, sim)
    values (p_id, uid, p_time, p_avg_w, p_wkg, coalesce(p_sim, false))
    on conflict do nothing;
end $$;

revoke all on function public.finish_group_race(uuid, real, int, real, boolean) from public, anon, authenticated;
grant execute on function public.finish_group_race(uuid, real, int, real, boolean) to authenticated;
