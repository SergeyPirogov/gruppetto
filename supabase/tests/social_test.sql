-- Checks of 0001_social.sql on a plain Postgres with auth_stub.sql (tools/test_sql.sh). Each block raises on a
-- failure; psql stops at the first one (ON_ERROR_STOP).
\set ON_ERROR_STOP on
set client_min_messages = warning;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test'), ('00000000-0000-0000-0000-00000000000b', 'b@test'),
  ('00000000-0000-0000-0000-00000000000c', 'c@test');

-- someone signed in as user :u
create function pg_temp.as_user(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u, false); execute 'set role authenticated'; end $$;

-- ---------- profiles: each their own ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into public.profiles (id, display_name, country, gender, data) values (auth.uid(), 'Olena', 'UA', 'f', '{"profile":{"ftp":250}}');
do $$ begin
  begin
    insert into public.profiles (id, display_name) values ('00000000-0000-0000-0000-00000000000b', 'Not me');
    raise exception 'FAIL: wrote someone else''s profile';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
insert into public.profiles (id, display_name, country, gender) values (auth.uid(), 'Bohdan', 'PL', 'm');
do $$ begin
  assert (select count(*) from public.profiles) = 1, 'FAIL: sees another profile';
  assert (select count(*) from public.public_profiles) = 2, 'FAIL: public_profiles';
  update public.profiles set display_name = 'Hacked' where id = '00000000-0000-0000-0000-00000000000a';
  assert (select display_name from public.public_profiles where id = '00000000-0000-0000-0000-00000000000a') = 'Olena', 'FAIL: updated another profile';
  begin
    update public.profiles set data = jsonb_build_object('x', repeat('a', 300000)) where id = auth.uid();
    raise exception 'FAIL: a huge profile';
  exception when check_violation then null; end;
end $$;
reset role;

-- ---------- no insert of results, but through the function ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin
  begin
    insert into public.efforts (user_id, segment_id, kind, route_id, route_version, time_s, length_m, avg_power, weight_kg, ftp, category, ridden_at)
    values (auth.uid(), 'rolling-c1', 'climb', 'rolling', 'v1', 10, 2000, 999, 60, 300, 'A', now());
    raise exception 'FAIL: inserted a result directly';
  exception when insufficient_privilege then null; end;
end $$;

-- a good one, a duplicate, and the refused ones, each for its reason
do $$
declare r jsonb; base jsonb := jsonb_build_object('segment_id', 'rolling-c1', 'kind', 'climb', 'route_id', 'rolling', 'route_version', 'v1',
  'time_s', 300, 'length_m', 2000, 'avg_power', 250, 'avg_hr', 160, 'weight_kg', 75, 'ftp', 260, 'ridden_at', now() - interval '1 hour', 'client', 'test');
begin
  r := public.submit_efforts(jsonb_build_array(
    base,
    base,                                                                    -- the same again: duplicate
    base || '{"weight_kg": 29}', base || '{"ftp": 601}', base || '{"time_s": 4}',
    base || '{"time_s": 70}',                                                -- 2000 m in 70 s: 28.6 m/s
    base || '{"avg_power": 0}', base || '{"avg_power": 700}',                -- 9.3 W/kg for 5 min
    base || '{"kind": "descent"}', base || '{"time_s": "fast"}', base || '{"segment_id": "alps-c1"}',
    base || jsonb_build_object('ridden_at', now() + interval '3 days'),
    base || '{"length_m": 1500, "ridden_at": "2026-01-01T00:00:00Z"}',
    base || jsonb_build_object('length_m', 1500, 'ridden_at', now() - interval '2 hours') -- another length for this segment
  ));
  assert r->0->>'status' = 'saved', 'FAIL: good result ' || r::text;
  assert (r->0->>'place')::int = 1 and (r->0->>'total')::int = 1 and (r->0->>'week_place')::int = 1, 'FAIL: place ' || (r->0)::text;
  assert r->1->>'status' = 'duplicate', 'FAIL: duplicate ' || (r->1)::text;
  assert r->2->>'reason' = 'weight' and r->3->>'reason' = 'ftp' and r->4->>'reason' = 'time' and r->5->>'reason' = 'speed', 'FAIL: reasons ' || r::text;
  assert r->6->>'reason' = 'power' and r->7->>'reason' = 'wkg' and r->8->>'reason' = 'invalid' and r->9->>'reason' = 'invalid', 'FAIL: reasons 2 ' || r::text;
  assert r->10->>'reason' = 'invalid' and r->11->>'reason' = 'invalid' and r->12->>'reason' = 'invalid', 'FAIL: reasons 3 ' || r::text;
  assert r->13->>'reason' = 'length', 'FAIL: length ' || (r->13)::text;
  assert (select count(*) from public.efforts) = 1, 'FAIL: count';
  -- the server works out the category and flags itself
  assert (select category from public.efforts) = 'B', 'FAIL: category'; -- FTP 260 at 75 kg: 3.47 W/kg
  assert (select flags from public.efforts) = '{}', 'FAIL: flags';
  -- no heart rate, and close to the ceiling: kept, flagged
  r := public.submit_efforts(jsonb_build_array(base || jsonb_build_object('avg_hr', null, 'avg_power', 570, 'ridden_at', now() - interval '3 hours')));
  assert r->0->>'status' = 'saved', 'FAIL: flagged one ' || r::text;
  assert (select flags from public.efforts where wkg > 7) = '{no-hr,high}', 'FAIL: flags 2';
end $$;
reset role;

-- ---------- the table ----------
-- 25 more riders on rolling-c1, 251..275 s (all faster than Olena's 300); rider 1's ride is 40 days old, rider 25 is private
do $$ declare i int; u uuid; begin
  for i in 1..25 loop
    u := ('00000000-0000-0000-0000-1000000000' || lpad(i::text, 2, '0'))::uuid;
    insert into auth.users (id) values (u);
    insert into public.profiles (id, display_name, gender, public) values (u, 'Rider ' || i, case when i % 2 = 0 then 'f' else 'm' end, i <> 25);
    insert into public.efforts (user_id, segment_id, kind, route_id, route_version, time_s, length_m, avg_power, avg_hr, weight_kg, ftp, category, ridden_at)
    values (u, 'rolling-c1', 'climb', 'rolling', 'v1', 250 + i, 2000, 250, 150, 75, case when i <= 5 then 320 else 200 end,
      case when i <= 5 then 'A' else 'C' end, case when i = 1 then now() - interval '40 days' else now() - interval '2 hours' end);
  end loop;
end $$;

-- not signed in: anyone reads a table; private profiles and other route versions stay out
set role anon;
select set_config('request.jwt.claim.sub', '', false);
do $$ declare n int; begin
  assert (select count(*) from public.leaderboard('rolling-c1', 'v1')) = 10, 'FAIL: top 10';
  assert (select total from public.leaderboard('rolling-c1', 'v1') limit 1) = 25, 'FAIL: total (24 public riders + Olena)';
  assert (select display_name from public.leaderboard('rolling-c1', 'v1') where place = 1) = 'Rider 1', 'FAIL: leader';
  assert not exists (select 1 from public.leaderboard('rolling-c1', 'v1') where display_name = 'Rider 25'), 'FAIL: a private profile shows';
  assert (select count(*) from public.leaderboard('rolling-c1', 'v2')) = 0, 'FAIL: another version';
  assert (select total from public.leaderboard('rolling-c1', 'v1', 'week') limit 1) = 24, 'FAIL: this week (the old ride is out)';
  assert (select total from public.leaderboard('rolling-c1', 'v1', 'all', 'f') limit 1) = 13, 'FAIL: women (12 riders + Olena)';
  assert (select count(*) from public.leaderboard('rolling-c1', 'v1', 'all', null, 'A')) = 5, 'FAIL: category A';
  assert not exists (select 1 from public.leaderboard('rolling-c1', 'v1') where me), 'FAIL: me when signed out';
  -- results are public, but not the weight, FTP and power
  assert (select count(*) from public.efforts) = 26, 'FAIL: public results (Olena''s 2 and 24 riders; the private one is out)';
  begin perform weight_kg from public.efforts limit 1; raise exception 'FAIL: weight readable';
  exception when insufficient_privilege then null; end;
  begin perform avg_power from public.efforts limit 1; raise exception 'FAIL: power readable';
  exception when insufficient_privilege then null; end;
  begin perform data from public.profiles limit 1; raise exception 'FAIL: profile data readable';
  exception when insufficient_privilege then null; end;
  begin perform public.submit_efforts('[]'); raise exception 'FAIL: anon submits';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- signed in as rider 20 (place 20 of 25): the top 10, a gap, then 17..23 with me among them
select pg_temp.as_user('00000000-0000-0000-0000-100000000020');
do $$ begin
  assert (select array_agg(place order by place) from public.leaderboard('rolling-c1', 'v1'))
    = '{1,2,3,4,5,6,7,8,9,10,17,18,19,20,21,22,23}'::bigint[], 'FAIL: window ' || (select array_agg(place order by place) from public.leaderboard('rolling-c1', 'v1'))::text;
  assert (select place from public.leaderboard('rolling-c1', 'v1') where me) = 20, 'FAIL: my place';
  assert (select count(*) from public.leaderboard('rolling-c1', 'v1', 'all', null, null, false)) = 10, 'FAIL: no window when not asked';
end $$;
reset role;

-- ---------- the daily limit ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ declare r jsonb; items jsonb := '[]'; i int; begin
  for i in 1..4 loop
    items := '[]';
    for j in 1..50 loop
      items := items || jsonb_build_object('segment_id', 'rolling-s1', 'kind', 'sprint', 'route_id', 'rolling', 'route_version', 'v1',
        'time_s', 20, 'length_m', 250, 'avg_power', 600, 'avg_hr', 170, 'weight_kg', 75, 'ftp', 260, 'ridden_at', now() - make_interval(secs => i * 100 + j));
    end loop;
    r := public.submit_efforts(items);
  end loop;
  assert (select count(*) from public.efforts where user_id = auth.uid()) = 200, 'FAIL: 200 a day';
  r := public.submit_efforts(jsonb_build_array(items->0 || jsonb_build_object('ridden_at', now() - interval '20 hours')));
  assert r->0->>'reason' = 'limit', 'FAIL: limit ' || r::text;
end $$;
reset role;

-- ---------- delete the account: everything goes ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select public.delete_me();
reset role;
do $$ begin
  assert not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-00000000000a'), 'FAIL: user stays';
  assert not exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-00000000000a'), 'FAIL: profile stays';
  assert not exists (select 1 from public.efforts where user_id = '00000000-0000-0000-0000-00000000000a'), 'FAIL: results stay';
  assert exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-00000000000b'), 'FAIL: deleted someone else';
end $$;

select 'social SQL: all checks passed' as result;
