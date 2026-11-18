-- Checks of 0012_race_categories.sql: the category is the stronger of the FTP's and the race's own W/kg.
\set ON_ERROR_STOP on
set client_min_messages = warning;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'a@test'), ('00000000-0000-0000-0000-0000000000b2', 'b@test'), ('00000000-0000-0000-0000-0000000000c3', 'c@test');
create function pg_temp.as_user(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u, false); execute 'set role authenticated'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
insert into public.profiles (id, display_name, country, gender) values (auth.uid(), 'Olena', 'UA', 'f');
select public.create_group_ride('Crit', 'rolling', now() + interval '1 hour', 'race', 1); -- 12 km
reset role;
update public.group_rides set starts_at = now() - interval '25 minutes';
create temp table t as select id from public.group_rides; grant select on t to authenticated;
do $$ declare u text; begin
  foreach u in array array['00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000c3'] loop
    insert into public.profiles (id, display_name, country, gender) values (u::uuid, 'R' || right(u, 2), 'UA', 'm');
    insert into public.group_ride_riders (ride_id, user_id) values ((select id from t), u::uuid);
  end loop;
end $$;
-- Olena: FTP 4.2 W/kg, rode 3.5 on average: A
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select public.finish_group_race((select id from t), 1450, 210, 3.5, false, 4.2);
reset role;
-- b2: says FTP 2.4 (D) but averaged 3.3 W/kg: B, the one ridden
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
select public.finish_group_race((select id from t), 1460, 230, 3.3, false, 2.4);
reset role;
-- c3: an old app sends no FTP: by the race, 2.0 W/kg is D
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select public.finish_group_race(p_id => (select id from t), p_time => 1470, p_avg_w => 150, p_wkg => 2.0, p_sim => false);
do $$ begin
  if (select string_agg(cat, '' order by time_s) from public.group_race_results((select id from t))) <> 'ABD' then
    raise exception 'FAIL: categories %', (select string_agg(cat, '' order by time_s) from public.group_race_results((select id from t)));
  end if;
end $$;
reset role;
