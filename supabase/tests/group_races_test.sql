-- Checks of 0005_group_races.sql (tools/test_sql.sh), on a fresh database after 0001, 0004 and 0005. Each block
-- raises on a failure; psql stops at the first one (ON_ERROR_STOP).
\set ON_ERROR_STOP on
set client_min_messages = warning;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@test'), ('00000000-0000-0000-0000-0000000000b1', 'b@test'),
  ('00000000-0000-0000-0000-0000000000c1', 'c@test');

create function pg_temp.as_user(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u, false); execute 'set role authenticated'; end $$;

select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
insert into public.profiles (id, display_name, country, gender) values (auth.uid(), 'Olena', 'UA', 'f');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
insert into public.profiles (id, display_name, country, gender, public) values (auth.uid(), 'Hidden', 'UA', 'm', false);
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
insert into public.profiles (id, display_name, country, gender) values (auth.uid(), 'Taras', 'UA', 'm');
reset role;

-- ---------- a race in the calendar ----------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare r uuid; g uuid; begin
  r := public.create_group_ride('Crit', 'rolling', now() + interval '1 hour', 'race', 3);
  g := public.create_group_ride('Spin', 'rolling', now() + interval '2 hours');
  if (select count(*) from public.group_ride_list() where id = r and kind = 'race' and laps = 3) <> 1 then raise exception 'FAIL: a race and its laps'; end if;
  if (select count(*) from public.group_ride_list() where id = g and kind = 'ride' and laps is null) <> 1 then raise exception 'FAIL: a plain ride'; end if;
  begin perform public.create_group_ride('x', 'rolling', now() + interval '1 hour', 'race', 20); raise exception 'FAIL: 20 laps';
  exception when check_violation then null; end;
  begin perform public.create_group_ride('x', 'rolling', now() + interval '1 hour', 'crit', 2); raise exception 'FAIL: a bad kind';
  exception when check_violation then null; end;
  begin perform public.finish_group_race(r, 600); raise exception 'FAIL: a finish before the start';
  exception when invalid_parameter_value then null; end;
end $$;
reset role;

-- the race has started 20 minutes ago (moved by hand); b1 joins, c1 does not
update public.group_rides set starts_at = now() - interval '20 minutes' where title in ('Crit', 'Spin');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ begin perform public.join_group_ride((select id from public.group_ride_list() where title = 'Crit')); end $$;
reset role;

-- ---------- finishing ----------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare r uuid := (select id from public.group_ride_list() where title = 'Crit'); begin
  begin perform public.finish_group_race(r, 3600); raise exception 'FAIL: faster than the clock allows';
  exception when invalid_parameter_value then null; end;
  begin perform public.finish_group_race((select id from public.group_ride_list() where title = 'Spin'), 600); raise exception 'FAIL: a finish in a plain ride';
  exception when invalid_parameter_value then null; end;
  perform public.finish_group_race(r, 1150.5, 245, 4.1);
  perform public.finish_group_race(r, 900); -- a second finish: the first stands
  if (select time_s from public.group_race_results(r) where me) <> 1150.5 then raise exception 'FAIL: the first finish does not stand'; end if;
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin
  begin perform public.finish_group_race((select id from public.group_ride_list() where title = 'Crit'), 1000); raise exception 'FAIL: finished without joining';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare r uuid := (select id from public.group_ride_list() where title = 'Crit'); begin
  perform public.finish_group_race(r, 1100, 260, 3.5, true);
  if (select name from public.group_race_results(r) where me) is distinct from 'Hidden' then raise exception 'FAIL: your own name, hidden profile'; end if;
end $$;
reset role;

-- ---------- the results, as anyone sees them ----------
select set_config('request.jwt.claim.sub', '', false);
set role anon;
do $$ declare r uuid := (select id from public.group_ride_list() where title = 'Crit'); begin
  if (select string_agg(coalesce(name, '?') || ':' || time_s || ':' || sim, ',') from public.group_race_results(r)) <> '?:1100:true,Olena:1150.5:false' then
    raise exception 'FAIL: the results: %', (select string_agg(coalesce(name, '?') || ':' || time_s || ':' || sim, ',') from public.group_race_results(r));
  end if;
  if exists (select 1 from public.group_race_results(r) where me) then raise exception 'FAIL: anon is in the results'; end if;
  begin perform * from public.group_race_results; raise exception 'FAIL: anon reads the table';
  exception when insufficient_privilege then null; end;
  begin perform public.finish_group_race(r, 1000); raise exception 'FAIL: anon finished';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select 'group races: all checks passed' as result;
