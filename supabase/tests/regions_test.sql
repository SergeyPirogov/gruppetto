-- Checks of 0003_regions.sql (tools/test_sql.sh), on a fresh database after 0001_social.sql. Each block raises
-- on a failure; psql stops at the first one (ON_ERROR_STOP).
\set ON_ERROR_STOP on
set client_min_messages = warning;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@test'), ('00000000-0000-0000-0000-0000000000b1', 'b@test'),
  ('00000000-0000-0000-0000-0000000000c1', 'c@test'), ('00000000-0000-0000-0000-0000000000d1', 'd@test');

create function pg_temp.as_user(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u, false); execute 'set role authenticated'; end $$;
create function pg_temp.ride(id text, km numeric, climb numeric, hours numeric default 1, ago interval default '1 hour') returns jsonb language sql as $$
  select jsonb_build_object('ride_id', id, 'ridden_at', now() - ago, 'distance_m', km * 1000, 'climb_m', climb, 'duration_s', hours * 3600,
    'avg_power', 200, 'weight_kg', 70, 'client', 'test')
$$;

-- ---------- the oblast: only in Ukraine, only a real one ----------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
insert into public.profiles (id, display_name, country, gender, region) values (auth.uid(), 'Olena', 'UA', 'f', 'UA-71');
do $$ begin
  begin update public.profiles set region = 'UA-99' where id = auth.uid(); raise exception 'FAIL: made-up oblast';
  exception when check_violation then null; end;
  begin update public.profiles set country = 'PL' where id = auth.uid(); raise exception 'FAIL: an oblast outside Ukraine';
  exception when check_violation then null; end;
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
insert into public.profiles (id, display_name, country, gender, region) values (auth.uid(), 'Bohdan', 'UA', 'm', 'UA-30');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
insert into public.profiles (id, display_name, country, gender, region) values (auth.uid(), 'Taras', 'UA', 'm', 'UA-71');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
insert into public.profiles (id, display_name, country, gender, region, public) values (auth.uid(), 'Hidden', 'UA', 'm', 'UA-30', false);
reset role;

-- ---------- submitting rides ----------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare r jsonb; begin
  r := public.submit_rides(jsonb_build_array(pg_temp.ride('r1', 30, 300), pg_temp.ride('r2', 40, 100, 1.5, '2 hours'),
    pg_temp.ride('r1', 30, 300),                       -- the same ride again (the queue)
    pg_temp.ride('r3', 90, 0, 1),                      -- 90 km/h
    pg_temp.ride('r4', 20, 5000, 1),                   -- a wall
    pg_temp.ride('r5', 2, 0, 0.05),                    -- 3 minutes
    pg_temp.ride('r6', 30, 100, 1, '90 days')));       -- long ago
  assert r->0->>'status' = 'saved' and r->1->>'status' = 'saved', 'FAIL: saved ' || r::text;
  assert r->2->>'status' = 'duplicate', 'FAIL: duplicate ' || r::text;
  assert r->3->>'reason' = 'speed' and r->4->>'reason' = 'climb' and r->5->>'reason' = 'time' and r->6->>'reason' = 'invalid', 'FAIL: rejections ' || r::text;
  r := public.submit_rides(jsonb_build_array(pg_temp.ride('r7', 30, 100) || '{"avg_power": 900}'));
  assert r->0->>'reason' = 'power', 'FAIL: power ' || r::text;
  begin perform count(*) from public.ride_totals; raise exception 'FAIL: rows readable';
  exception when insufficient_privilege then null; end;
  begin insert into public.ride_totals (user_id, ride_id, ridden_at, distance_m, climb_m, duration_s) values (auth.uid(), 'x', now(), 1, 1, 1);
    raise exception 'FAIL: wrote a row past submit_rides';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select public.submit_rides(jsonb_build_array(pg_temp.ride('r1', 100, 50, 3), pg_temp.ride('r2', 25, 900, 1, '40 days')));
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select public.submit_rides(jsonb_build_array(pg_temp.ride('r1', 20, 400)));
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
select public.submit_rides(jsonb_build_array(pg_temp.ride('r1', 500, 0, 11)));
reset role;
do $$ begin
  begin set role anon; perform public.submit_rides('[]'); raise exception 'FAIL: anon submitted';
  exception when insufficient_privilege then null; end;
  reset role;
end $$;

-- ---------- the boards (read by anyone) ----------
set role anon;
do $$ begin
  -- all time, km: Kyiv city 125 km (Bohdan; the hidden rider is not counted), Cherkasy 90 km (Olena 70 + Taras 20)
  assert (select array_agg(region || ':' || distance_km order by place) from public.region_board('all', 'km')) = '{UA-30:125.0,UA-71:90.0}', 'FAIL: oblasts by km ' || (select array_agg(region || ':' || distance_km order by place) from public.region_board('all', 'km'))::text;
  assert (select riders from public.region_board('all', 'km') where region = 'UA-71') = 2, 'FAIL: riders';
  -- climbing: Kyiv city 950 m, Cherkasy 800 m; this month Bohdan's ride 40 days ago is out: Cherkasy first
  assert (select region from public.region_board('all', 'climb') where place = 1) = 'UA-30', 'FAIL: climb all';
  assert (select array_agg(region order by place) from public.region_board('month', 'climb')) = '{UA-71,UA-30}', 'FAIL: climb this month';
  -- riders: Bohdan, Olena, Taras by km; Olena alone among the women
  assert (select array_agg(display_name order by place) from public.rider_board('all', 'km')) = '{Bohdan,Olena,Taras}', 'FAIL: riders by km';
  assert (select array_agg(display_name order by place) from public.rider_board('all', 'km', 'UA-71')) = '{Olena,Taras}', 'FAIL: one oblast';
  assert (select array_agg(display_name order by place) from public.rider_board('all', 'km', null, 'f')) = '{Olena}', 'FAIL: women';
  assert (select total from public.rider_board('all', 'km') limit 1) = 3, 'FAIL: total';
  assert not exists (select 1 from public.rider_board('all', 'km') where me), 'FAIL: anon is someone';
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin
  assert (select place from public.rider_board('all', 'km') where me) = 3, 'FAIL: my place';
end $$;
reset role;

-- ---------- the account deleted: its rides go ----------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select public.delete_me();
reset role;
do $$ begin
  assert not exists (select 1 from public.ride_totals where user_id = '00000000-0000-0000-0000-0000000000b1'), 'FAIL: rides stay';
end $$;

select 'regions SQL: all checks passed' as result;
