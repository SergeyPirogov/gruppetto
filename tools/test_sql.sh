#!/bin/sh
# The SQL of the social tables (supabase/migrations) on a throwaway Postgres in Docker, with a stand-in for
# Supabase's auth schema: RLS, the checks, the tables and deleting an account. Needs Docker.
set -e
cd "$(dirname "$0")/.."
name=gruppetto-sql-test
docker rm -f $name >/dev/null 2>&1 || true
docker run -d --rm --name $name -e POSTGRES_PASSWORD=test postgres:17-alpine >/dev/null
trap 'docker rm -f $name >/dev/null 2>&1' EXIT
until docker exec $name pg_isready -U postgres -q 2>/dev/null; do sleep 0.5; done
sleep 1
run() { docker exec -i $name psql -U postgres -q -v ON_ERROR_STOP=1 -X; }
run < supabase/tests/auth_stub.sql
run < supabase/migrations/0001_social.sql
run < supabase/migrations/0001_social.sql # applies twice: safe to paste again
run < supabase/tests/social_test.sql
# the ratings across Ukraine, on a fresh database
run <<'SQL'
drop schema public cascade; drop schema auth cascade; drop role anon; drop role authenticated; create schema public;
SQL
run < supabase/tests/auth_stub.sql
run < supabase/migrations/0001_social.sql
run < supabase/migrations/0003_regions.sql
run < supabase/migrations/0003_regions.sql # applies twice: safe to paste again
run < supabase/tests/regions_test.sql
# group rides (#84), on a fresh database
run <<'SQL'
drop schema public cascade; drop schema auth cascade; drop role anon; drop role authenticated; create schema public;
SQL
run < supabase/tests/auth_stub.sql
run < supabase/migrations/0001_social.sql
run < supabase/migrations/0004_group_rides.sql
run < supabase/migrations/0004_group_rides.sql # applies twice: safe to paste again
run < supabase/tests/group_rides_test.sql
# group rides again with 0005 on top (the old calls still work), then the races, each on a fresh database
run <<'SQL'
drop schema public cascade; drop schema auth cascade; drop role anon; drop role authenticated; create schema public;
SQL
run < supabase/tests/auth_stub.sql
run < supabase/migrations/0001_social.sql
run < supabase/migrations/0004_group_rides.sql
run < supabase/migrations/0005_group_races.sql
run < supabase/migrations/0005_group_races.sql # applies twice: safe to paste again
run < supabase/tests/group_rides_test.sql
run <<'SQL'
drop schema public cascade; drop schema auth cascade; drop role anon; drop role authenticated; create schema public;
SQL
run < supabase/tests/auth_stub.sql
run < supabase/migrations/0001_social.sql
run < supabase/migrations/0004_group_rides.sql
run < supabase/migrations/0005_group_races.sql
run < supabase/tests/group_races_test.sql
# the races again with 0006 on top (the old calls still work), then the leagues, each on a fresh database
run <<'SQL'
drop schema public cascade; drop schema auth cascade; drop role anon; drop role authenticated; create schema public;
SQL
run < supabase/tests/auth_stub.sql
run < supabase/migrations/0001_social.sql
run < supabase/migrations/0004_group_rides.sql
run < supabase/migrations/0005_group_races.sql
run < supabase/migrations/0006_leagues.sql
run < supabase/migrations/0006_leagues.sql # applies twice: safe to paste again
run < supabase/tests/group_races_test.sql
run <<'SQL'
drop schema public cascade; drop schema auth cascade; drop role anon; drop role authenticated; create schema public;
SQL
run < supabase/tests/auth_stub.sql
run < supabase/migrations/0001_social.sql
run < supabase/migrations/0004_group_rides.sql
run < supabase/migrations/0005_group_races.sql
run < supabase/migrations/0006_leagues.sql
run < supabase/tests/leagues_test.sql
# the size of a ride in the full sync (0007)
run <<'SQL'
drop schema public cascade; drop schema auth cascade; drop role anon; drop role authenticated; create schema public;
SQL
run < supabase/tests/auth_stub.sql
run < supabase/migrations/0001_social.sql
run < supabase/migrations/0002_activities.sql
run < supabase/migrations/0007_activities_size.sql
run < supabase/migrations/0007_activities_size.sql # applies twice: safe to paste again
run < supabase/tests/activities_size_test.sql
# a race finish the server can believe (0008)
run <<'SQL'
drop schema public cascade; drop schema auth cascade; drop role anon; drop role authenticated; create schema public;
SQL
run < supabase/tests/auth_stub.sql
run < supabase/migrations/0001_social.sql
run < supabase/migrations/0004_group_rides.sql
run < supabase/migrations/0005_group_races.sql
run < supabase/migrations/0006_leagues.sql
run < supabase/migrations/0008_race_checks.sql
run < supabase/migrations/0008_race_checks.sql # applies twice: safe to paste again
run < supabase/tests/race_checks_test.sql
# a ride started when everyone is ready (0010)
run <<'SQL'
drop schema public cascade; drop schema auth cascade; drop role anon; drop role authenticated; create schema public;
SQL
run < supabase/tests/auth_stub.sql
run < supabase/migrations/0001_social.sql
run < supabase/migrations/0004_group_rides.sql
run < supabase/migrations/0005_group_races.sql
run < supabase/migrations/0006_leagues.sql
run < supabase/migrations/0008_race_checks.sql
run < supabase/migrations/0010_start_on_demand.sql
run < supabase/migrations/0010_start_on_demand.sql # applies twice: safe to paste again
run < supabase/tests/start_on_demand_test.sql
