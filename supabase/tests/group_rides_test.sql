-- Checks of 0004_group_rides.sql (tools/test_sql.sh), on a fresh database after 0001_social.sql. Each block raises
-- on a failure; psql stops at the first one (ON_ERROR_STOP).
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
-- c1 has no profile

-- ---------- hosting ----------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare gid uuid; n int; begin
  gid := public.create_group_ride('  Morning spin  ', 'rolling', now() + interval '1 day');
  if (select count(*) from public.group_ride_list() where id = gid and title = 'Morning spin' and riders = 1 and joined and mine and host_name = 'Olena') <> 1 then
    raise exception 'FAIL: the host is not in their own ride, or the title is not trimmed';
  end if;
  begin perform public.create_group_ride('x', 'rolling', now() - interval '1 hour'); raise exception 'FAIL: a ride in the past';
  exception when invalid_parameter_value then null; end;
  begin perform public.create_group_ride('x', 'rolling', now() + interval '90 days'); raise exception 'FAIL: too far ahead';
  exception when invalid_parameter_value then null; end;
  begin perform public.create_group_ride('x', 'Bad Route!', now() + interval '1 day'); raise exception 'FAIL: a bad route id';
  exception when check_violation then null; end;
  begin perform public.create_group_ride('   ', 'rolling', now() + interval '1 day'); raise exception 'FAIL: an empty title';
  exception when check_violation then null; end;
  for n in 1..9 loop perform public.create_group_ride('r' || n, 'flat', now() + make_interval(hours => n)); end loop;
  begin perform public.create_group_ride('eleventh', 'flat', now() + interval '2 days'); raise exception 'FAIL: more than 10 to come';
  exception when program_limit_exceeded then null; end;
end $$;
reset role;

-- no account, or no profile: may look, may not host or join
select set_config('request.jwt.claim.sub', '', false);
set role anon;
do $$ begin
  if (select count(*) from public.group_ride_list()) <> 10 then raise exception 'FAIL: anon does not see the calendar'; end if;
  if exists (select 1 from public.group_ride_list() where joined or mine) then raise exception 'FAIL: anon has joined'; end if;
  begin perform public.join_group_ride((select id from public.group_ride_list() limit 1)); raise exception 'FAIL: anon joined';
  exception when insufficient_privilege then null; end;
  begin perform * from public.group_rides; raise exception 'FAIL: anon reads the table';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin
  begin perform public.create_group_ride('x', 'flat', now() + interval '1 day'); raise exception 'FAIL: hosted without a profile';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------- joining and leaving ----------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare gid uuid := (select id from public.group_ride_list() where title = 'Morning spin'); begin
  perform public.join_group_ride(gid);
  perform public.join_group_ride(gid); -- twice: still once
  if (select riders from public.group_ride_list() where id = gid) <> 2 then raise exception 'FAIL: join counts'; end if;
  if (select host_name from public.group_ride_list() where id = gid) is distinct from 'Olena' then raise exception 'FAIL: host name'; end if;
  begin perform public.cancel_group_ride(gid); raise exception 'FAIL: a rider called off the host''s ride';
  exception when insufficient_privilege then null; end;
  perform public.join_group_ride(gid, false);
  if (select riders from public.group_ride_list() where id = gid) <> 1 then raise exception 'FAIL: leave'; end if;
end $$;
-- a hidden profile hosts: its name stays hidden
do $$ declare gid uuid; begin
  gid := public.create_group_ride('Hidden host', 'flat', now() + interval '3 hours');
  if (select host_name from public.group_ride_list() where id = gid) is not null then raise exception 'FAIL: a hidden host''s name shows'; end if;
end $$;
reset role;

-- ---------- calling off; an account deleted ----------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare gid uuid := (select id from public.group_ride_list() where title = 'Morning spin'); begin
  perform public.cancel_group_ride(gid);
  if exists (select 1 from public.group_ride_list() where id = gid) then raise exception 'FAIL: cancel'; end if;
end $$;
reset role;
delete from auth.users where id = '00000000-0000-0000-0000-0000000000a1';
do $$ begin
  if exists (select 1 from public.group_rides where host = '00000000-0000-0000-0000-0000000000a1') then raise exception 'FAIL: rides outlive the host''s account'; end if;
end $$;

select 'group rides: all checks passed' as result;
