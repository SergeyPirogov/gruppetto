-- Checks of 0011_private_channel.sql: anyone listens to a ride that is on; only its riders send; nothing else.
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
select public.create_group_ride('Crit', 'rolling', now() + interval '5 minutes', 'race', 1);
select public.create_group_ride('Later', 'rolling', now() + interval '3 hours', 'race', 1);
reset role;
create temp table t as select (select id from public.group_rides where title = 'Crit') crit, (select id from public.group_rides where title = 'Later') later;
grant select on t to anon, authenticated;
insert into realtime.messages (topic, extension, payload) select 'group:' || crit, 'broadcast', '{}' from t;
-- Olena rides Crit: sends on it; a ride 3 hours off has no channel yet
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  perform set_config('realtime.topic', 'group:' || (select crit from t), false);
  insert into realtime.messages (topic, extension, payload) values (realtime.topic(), 'broadcast', '{}');
  perform set_config('realtime.topic', 'group:' || (select later from t), false);
  begin insert into realtime.messages (topic, extension, payload) values (realtime.topic(), 'broadcast', '{}'); raise exception 'FAIL: a ride hours off';
  exception when insufficient_privilege then null; end;
  perform set_config('realtime.topic', 'fans:whatever', false);
  begin insert into realtime.messages (topic, extension, payload) values (realtime.topic(), 'broadcast', '{}'); raise exception 'FAIL: not a ride topic';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Bo has not joined: listens, cannot send; joined, sends
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
do $$ begin
  perform set_config('realtime.topic', 'group:' || (select crit from t), false);
  if (select count(*) from realtime.messages) = 0 then raise exception 'FAIL: a signed-in spectator hears nothing'; end if;
  begin insert into realtime.messages (topic, extension, payload) values (realtime.topic(), 'broadcast', '{}'); raise exception 'FAIL: sent without riding';
  exception when insufficient_privilege then null; end;
  perform public.join_group_ride((select crit from t));
  insert into realtime.messages (topic, extension, payload) values (realtime.topic(), 'broadcast', '{}');
end $$;
reset role;
-- a guest listens and cannot send
set role anon;
do $$ begin
  perform set_config('realtime.topic', 'group:' || (select crit from t), false);
  if (select count(*) from realtime.messages) = 0 then raise exception 'FAIL: a guest hears nothing'; end if;
  begin insert into realtime.messages (topic, extension, payload) values (realtime.topic(), 'broadcast', '{}'); raise exception 'FAIL: a guest sent';
  exception when insufficient_privilege then null; end;
  perform set_config('realtime.topic', 'group:' || (select later from t), false);
  if (select count(*) from realtime.messages) <> 0 then raise exception 'FAIL: hears a ride hours off'; end if;
end $$;
reset role;
