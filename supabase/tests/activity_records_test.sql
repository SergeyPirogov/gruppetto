-- Checks of 0009_activity_records.sql: each their own records; anon none; past 4 MB refused.
\set ON_ERROR_STOP on
set client_min_messages = warning;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'a@test'), ('00000000-0000-0000-0000-00000000000b', 'b@test');
create function pg_temp.as_user(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u, false); execute 'set role authenticated'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into public.activity_records (user_id, id, data) values (auth.uid(), 'r1', repeat('A', 300000));
do $$ begin
  begin insert into public.activity_records (user_id, id, data) values (auth.uid(), 'r2', repeat('A', 4194305)); raise exception 'FAIL: past 4 MB';
  exception when check_violation then null; end;
  begin insert into public.activity_records (user_id, id, data) values ('00000000-0000-0000-0000-00000000000b', 'r3', 'x'); raise exception 'FAIL: wrote another''s';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  if (select count(*) from public.activity_records) <> 0 then raise exception 'FAIL: sees another''s record'; end if;
end $$;
reset role;
do $$ begin
  set local role anon;
  begin perform * from public.activity_records; raise exception 'FAIL: anon reads';
  exception when insufficient_privilege then null; end;
end $$;
