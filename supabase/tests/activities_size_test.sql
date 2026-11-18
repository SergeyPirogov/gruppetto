-- Checks of 0007_activities_size.sql: a long ride's history entry (well past the old 64 KB) is saved; past 1 MB is not.
\set ON_ERROR_STOP on
set client_min_messages = warning;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'a@test');
create function pg_temp.as_user(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u, false); execute 'set role authenticated'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into public.activities (user_id, id, entry, changed_at)
  values (auth.uid(), 'r1', jsonb_build_object('chart', repeat('1,', 50000)), 1); -- about 100 KB
do $$ begin
  assert (select count(*) from public.activities) = 1, 'FAIL: a 100 KB ride was not saved';
  begin
    insert into public.activities (user_id, id, entry) values (auth.uid(), 'r2', jsonb_build_object('chart', repeat('1', 1100000)));
    raise exception 'FAIL: a ride past 1 MB was saved';
  exception when check_violation then null; end;
end $$;
reset role;
