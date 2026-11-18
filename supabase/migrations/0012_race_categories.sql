-- Race categories, as clubs race them (tester: Veloplaneta): one start, results by category. A rider's category is
-- the stronger of their FTP's (A from 4.0 W/kg, B from 3.2, C from 2.5, D below) and the race's own average W/kg on
-- the same scale: who rode above their category is raced in the one they rode. Set by the database, from what the
-- finish sends. Safe to apply again.

alter table public.group_race_results add column if not exists cat text check (cat in ('A', 'B', 'C', 'D'));

create or replace function public.race_cat(p_wkg real) returns int language sql immutable as $$
  select case when p_wkg is null then 0 when p_wkg >= 4.0 then 4 when p_wkg >= 3.2 then 3 when p_wkg >= 2.5 then 2 else 1 end
$$;

-- the finish of 0008, now with your FTP in W/kg (the 5-argument one goes: a call by name would be ambiguous)
drop function if exists public.finish_group_race(uuid, real, int, real, boolean, real);
create function public.finish_group_race(p_id uuid, p_time real, p_avg_w int default null, p_wkg real default null, p_sim boolean default false, p_ftp_wkg real default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); g public.group_rides; since real; r public.route_lengths; dist real; c int;
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
  c := greatest(public.race_cat(case when p_ftp_wkg between 0.5 and 10 then p_ftp_wkg end), public.race_cat(case when p_wkg between 0 and 20 then p_wkg end));
  insert into public.group_race_results (ride_id, user_id, time_s, avg_w, wkg, sim, cat)
    values (p_id, uid, p_time, p_avg_w, p_wkg, coalesce(p_sim, false), case c when 4 then 'A' when 3 then 'B' when 2 then 'C' when 1 then 'D' end)
    on conflict do nothing;
end $$;
drop function if exists public.finish_group_race(uuid, real, int, real, boolean);

drop function if exists public.group_race_results(uuid);
create function public.group_race_results(p_id uuid)
returns table (name text, time_s real, avg_w int, wkg real, sim boolean, me boolean, cat text)
language sql stable security definer set search_path = public, pg_temp as $$
  select case when r.user_id = auth.uid() then (select p.display_name from public.profiles p where p.id = r.user_id)
    else (select p.display_name from public.public_profiles p where p.id = r.user_id) end,
    r.time_s, r.avg_w, r.wkg, r.sim, coalesce(r.user_id = auth.uid(), false), r.cat
  from public.group_race_results r
  where r.ride_id = p_id
  order by r.time_s
  limit 500
$$;

revoke all on function public.finish_group_race(uuid, real, int, real, boolean, real), public.group_race_results(uuid), public.race_cat(real) from public, anon, authenticated;
grant execute on function public.group_race_results(uuid) to anon, authenticated;
grant execute on function public.finish_group_race(uuid, real, int, real, boolean, real) to authenticated;
