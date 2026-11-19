-- A league's standings with each rider's place in every race of it (#84): `form`, in the races' start order, one
-- place per race that has results, null where the rider was not in it. Safe to paste again.
drop function if exists public.league_standings(uuid);
create function public.league_standings(p_id uuid)
returns table (name text, points int, races int, wins int, best int, me boolean, form int[])
language sql stable security definer set search_path = public, pg_temp as $$
  with placed as (
    select r.user_id, r.ride_id, rank() over (partition by r.ride_id order by r.time_s)::int as place
    from public.group_race_results r join public.group_rides g on g.id = r.ride_id
    where g.league_id = p_id and g.kind = 'race' and not r.sim
  ),
  raced as ( -- the league's races with results, in order
    select g.id, row_number() over (order by g.starts_at, g.id) as n
    from public.group_rides g where g.league_id = p_id and exists (select 1 from placed x where x.ride_id = g.id)
  )
  select case when x.user_id = auth.uid() then (select p.display_name from public.profiles p where p.id = x.user_id)
    else (select p.display_name from public.public_profiles p where p.id = x.user_id) end,
    sum(public.league_points(x.place))::int, count(*)::int, count(*) filter (where x.place = 1)::int, min(x.place),
    coalesce(x.user_id = auth.uid(), false),
    (select array_agg(y.place order by c.n) from raced c left join placed y on y.ride_id = c.id and y.user_id = x.user_id)
  from placed x
  group by x.user_id
  order by 2 desc, 4 desc, 5, 3 desc
  limit 500
$$;
revoke execute on function public.league_standings(uuid) from public;
grant execute on function public.league_standings(uuid) to anon, authenticated;
