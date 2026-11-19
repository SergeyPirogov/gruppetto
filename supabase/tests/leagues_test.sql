-- Checks of 0006_leagues.sql and 0013_league_form.sql (tools/test_sql.sh), on a fresh database after 0001, 0004, 0005 and 0006. Each block
-- raises on a failure; psql stops at the first one (ON_ERROR_STOP).
\set ON_ERROR_STOP on
set client_min_messages = warning;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@test'), ('00000000-0000-0000-0000-0000000000b1', 'b@test'),
  ('00000000-0000-0000-0000-0000000000c1', 'c@test'), ('00000000-0000-0000-0000-0000000000d1', 'd@test');

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

-- ---------- points ----------
do $$ begin
  if public.league_points(1) <> 25 or public.league_points(2) <> 20 or public.league_points(15) <> 1 or public.league_points(16) <> 0
    or public.league_points(0) <> 0 then raise exception 'FAIL: the points for a place'; end if;
end $$;

-- ---------- a league and its races ----------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare l uuid; r1 uuid; r2 uuid; begin
  l := public.create_league('  Winter Cup ');
  if (select title from public.league_list() where id = l and mine) <> 'Winter Cup' then raise exception 'FAIL: the league in the list'; end if;
  r1 := public.create_group_ride('Round 1', 'rolling', now() + interval '1 hour', 'race', 2, l);
  r2 := public.create_group_ride('Round 2', 'rolling', now() + interval '2 hours', 'race', 2, l);
  if (select league_title from public.group_ride_list() where id = r1) <> 'Winter Cup' then raise exception 'FAIL: the league on the race'; end if;
  if (select races from public.league_list() where id = l) <> 2 then raise exception 'FAIL: the races counted'; end if;
  if (select count(*) from public.league_races(l)) <> 2 then raise exception 'FAIL: the league''s races'; end if;
  begin perform public.create_group_ride('Spin', 'rolling', now() + interval '1 hour', 'ride', null, l); raise exception 'FAIL: a plain ride in a league';
  exception when invalid_parameter_value then null; end;
  begin perform public.create_league(''); raise exception 'FAIL: an empty title';
  exception when check_violation then null; end;
  perform public.create_league('2'); perform public.create_league('3'); perform public.create_league('4'); perform public.create_league('5');
  begin perform public.create_league('6'); raise exception 'FAIL: a sixth league';
  exception when program_limit_exceeded then null; end;
  -- the old call still works (no league)
  perform public.create_group_ride('Crit', 'rolling', now() + interval '3 hours', 'race', 1);
end $$;
reset role;

-- someone else cannot put a race in your league; a guest cannot set one up
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin
  begin perform public.create_group_ride('Mine', 'rolling', now() + interval '1 hour', 'race', 1, (select id from public.league_list() where title = 'Winter Cup'));
    raise exception 'FAIL: a race in someone else''s league';
  exception when insufficient_privilege then null; end;
  if exists (select 1 from public.league_list() where mine) then raise exception 'FAIL: mine for another rider'; end if;
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
do $$ begin
  begin perform public.create_league('No profile'); raise exception 'FAIL: a league without a profile';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set role anon;
do $$ begin
  begin perform public.create_league('Guest'); raise exception 'FAIL: a guest sets up a league';
  exception when insufficient_privilege then null; end;
  if (select count(*) from public.league_list() where title = 'Winter Cup') <> 1 then raise exception 'FAIL: a guest sees the leagues'; end if;
  begin perform * from public.leagues; raise exception 'FAIL: the table open to a guest';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------- the races are ridden ----------
update public.group_rides set starts_at = now() - interval '40 minutes' where title = 'Round 1';
update public.group_rides set starts_at = now() - interval '20 minutes' where title = 'Round 2';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ begin
  perform public.join_group_ride((select id from public.group_ride_list() where title = 'Round 1'));
  perform public.join_group_ride((select id from public.group_ride_list() where title = 'Round 2'));
  perform public.finish_group_race((select id from public.group_ride_list() where title = 'Round 1'), 1000);
  perform public.finish_group_race((select id from public.group_ride_list() where title = 'Round 2'), 1100);
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin
  perform public.join_group_ride((select id from public.group_ride_list() where title = 'Round 1'));
  perform public.join_group_ride((select id from public.group_ride_list() where title = 'Round 2'));
  perform public.finish_group_race((select id from public.group_ride_list() where title = 'Round 1'), 900, null, null, true); -- the simulator: no points
  perform public.finish_group_race((select id from public.group_ride_list() where title = 'Round 2'), 1000);
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare l uuid := (select id from public.league_list() where title = 'Winter Cup'); begin
  perform public.finish_group_race((select id from public.group_ride_list() where title = 'Round 1'), 1200);
  -- Round 1: Hidden 1st (25), Olena 2nd (20), Taras in the simulator left out; Round 2: Taras 1st (25), Hidden 2nd (20)
  if (select points from public.league_standings(l) where me) <> 20 then raise exception 'FAIL: my points'; end if;
  if (select name from public.league_standings(l) where me) <> 'Olena' then raise exception 'FAIL: my name'; end if;
  if (select points from public.league_standings(l) where name is null) <> 45 then raise exception 'FAIL: the hidden rider''s points'; end if;
  if (select races || '/' || wins || '/' || best from public.league_standings(l) where name is null) <> '2/1/1' then raise exception 'FAIL: races, wins, best'; end if;
  if (select points from public.league_standings(l) where name = 'Taras') <> 25 then raise exception 'FAIL: a simulator ride counted'; end if;
  if (select name from public.league_standings(l) limit 1) is not null then raise exception 'FAIL: the order (most points first)'; end if;
  -- each rider's place in every race (0013): Round 1, then Round 2, null where not in it
  if (select form from public.league_standings(l) where name is null) is distinct from array[1, 2] then raise exception 'FAIL: the hidden rider''s form'; end if;
  if (select form from public.league_standings(l) where me) is distinct from array[2, null]::int[] then raise exception 'FAIL: my form (no Round 2)'; end if;
  if (select form from public.league_standings(l) where name = 'Taras') is distinct from array[null, 1]::int[] then raise exception 'FAIL: a simulator ride in the form'; end if;
  if (select finishers from public.league_races(l) where title = 'Round 1') <> 2 then raise exception 'FAIL: the finishers'; end if;
end $$;
reset role;

-- ---------- the league goes, the races stay ----------
delete from public.leagues where title = 'Winter Cup';
do $$ begin
  if (select count(*) from public.group_rides where title like 'Round %' and league_id is null) <> 2 then raise exception 'FAIL: the races after the league'; end if;
end $$;

select 'leagues: all checks passed' as result;
