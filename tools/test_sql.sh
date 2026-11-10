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
