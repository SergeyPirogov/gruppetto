-- Only for the tests on a plain Postgres (tools/test_sql.sh): what Supabase itself provides — the anon and
-- authenticated roles, auth.users and auth.uid() from the request's JWT. Never apply this to a Supabase project.
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
-- as on Supabase: new tables in public are open to the API roles, and RLS decides
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
