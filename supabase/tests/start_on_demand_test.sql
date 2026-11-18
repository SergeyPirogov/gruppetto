-- Checks of 0010_start_on_demand.sql: a held ride is listed and waits; only its host starts it, once, in 10 s..30 min.
\set ON_ERROR_STOP on
set client_min_messages = warning;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'a@test'), ('00000000-0000-0000-0000-0000000000b2', 'b@test');
create function pg_temp.as_user(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u, false); execute 'set role authenticated'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
insert into public.profiles (id, display_name, country, gender) values (auth.uid(), 'Bo', 'UA', 'm');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
insert into public.profiles (id, display_name, country, gender) values (auth.uid(), 'Olena', 'UA', 'f');
do $$ declare h uuid; t timestamptz; begin
  h := public.create_group_ride('Crit now', 'rolling', null, 'race', 2, null, true);
  perform public.create_group_ride('Old way', 'rolling', now() + interval '1 hour', 'race', 1); -- 6 named args: not ambiguous
  if not (select held from public.group_ride_list() where id = h) then raise exception 'FAIL: not held'; end if;
  if (select starts_at from public.group_ride_list() where id = h) < now() + interval '119 minutes' then raise exception 'FAIL: waits 2 h'; end if;
  begin perform public.start_group_ride(h, 5); raise exception 'FAIL: 5 s';
  exception when invalid_parameter_value then null; end;
  begin perform public.start_group_ride(h, 3600); raise exception 'FAIL: an hour';
  exception when invalid_parameter_value then null; end;
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
do $$ declare h uuid := (select id from public.group_ride_list() where title = 'Crit now'); begin
  begin perform public.start_group_ride(h, 120); raise exception 'FAIL: not the host started it';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare h uuid := (select id from public.group_ride_list() where title = 'Crit now'); t timestamptz; begin
  t := public.start_group_ride(h, 120);
  if abs(extract(epoch from t - now()) - 120) > 2 then raise exception 'FAIL: starts in 2 min'; end if;
  if (select held from public.group_ride_list() where id = h) then raise exception 'FAIL: still held'; end if;
  begin perform public.start_group_ride(h, 60); raise exception 'FAIL: started twice';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
-- a held ride that waited its 2 hours unstarted is gone from the list
update public.group_rides set held = true, starts_at = now() - interval '1 minute' where title = 'Crit now';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  if exists (select 1 from public.group_ride_list() where title = 'Crit now') then raise exception 'FAIL: a stale held ride listed'; end if;
end $$;
