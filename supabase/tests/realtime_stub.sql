-- What Supabase Realtime has and a plain Postgres lacks: realtime.messages and realtime.topic() (tests only).
create schema if not exists realtime;
create table if not exists realtime.messages (id bigserial primary key, topic text not null, extension text not null, payload jsonb, event text, private boolean default true);
alter table realtime.messages enable row level security;
create or replace function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
grant usage on schema realtime to anon, authenticated;
grant select, insert on realtime.messages to anon, authenticated;
grant usage, select on sequence realtime.messages_id_seq to authenticated;
