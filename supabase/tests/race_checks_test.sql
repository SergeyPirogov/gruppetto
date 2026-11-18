-- Checks of 0008_race_checks.sql (tools/test_sql.sh), after 0001, 0004, 0005 and 0008: the clock and the road.
\set ON_ERROR_STOP on
set client_min_messages = warning;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'a@test');
create function pg_temp.as_user(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u, false); execute 'set role authenticated'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
insert into public.profiles (id, display_name, country, gender) values (auth.uid(), 'Olena', 'UA', 'f');
do $$ begin
  perform public.create_group_ride('Crit', 'rolling', now() + interval '1 hour', 'race', 2);   -- 24 km
  perform public.create_group_ride('Late', 'rolling', now() + interval '1 hour', 'race', 1);   -- 12 km
  perform public.create_group_ride('Own', 'my-gpx', now() + interval '1 hour', 'race', 1);     -- a route not known here
end $$;
reset role;
update public.group_rides set starts_at = now() - interval '40 minutes' where title = 'Crit';
update public.group_rides set starts_at = now() - interval '90 minutes' where title = 'Late';
update public.group_rides set starts_at = now() - interval '5 minutes' where title = 'Own';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare c uuid := (select id from public.group_ride_list() where title = 'Crit');
  l uuid := (select id from public.group_ride_list() where title = 'Late');
  o uuid := (select id from public.group_ride_list() where title = 'Own'); begin
  perform public.join_group_ride(c); perform public.join_group_ride(l); perform public.join_group_ride(o);
  -- 24 km in 20 min is 72 km/h, and 20 min after a 40 min ago start was sent 20 min late
  begin perform public.finish_group_race(c, 1200); raise exception 'FAIL: 72 km/h, sent late';
  exception when invalid_parameter_value then null; end;
  -- 24 km in 38 min (38 km/h), sent 2 min after: it stands
  perform public.finish_group_race(c, 2280);
  if (select time_s from public.group_race_results(c) where me) <> 2280 then raise exception 'FAIL: a fair finish'; end if;
  -- 12 km in 30 min (24 km/h) is fair on the road, but the race started 90 min ago: sent an hour late
  begin perform public.finish_group_race(l, 1800); raise exception 'FAIL: a finish sent an hour after';
  exception when invalid_parameter_value then null; end;
  -- a route not known here: the clock only (4 min after a 5 min ago start)
  perform public.finish_group_race(o, 240);
  if (select count(*) from public.group_race_results(o)) <> 1 then raise exception 'FAIL: an unknown route, the clock only'; end if;
end $$;
reset role;
do $$ begin
  set local role anon;
  begin perform * from public.route_lengths; raise exception 'FAIL: anon reads route_lengths';
  exception when insufficient_privilege then null; end;
end $$;
