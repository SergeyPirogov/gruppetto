-- Full sync, the second half: a ride's full record (every second: power, heart rate, cadence, speed, distance,
-- heights), so a ride ridden on one device can be saved as .FIT, uploaded or uploaded again on another. The
-- history entry (0002) is the ride's summary and chart; this is the rest, gzip'd and in base64, fetched only when
-- the ride is opened. Only its owner reads and writes it. Safe to apply again.

create table if not exists public.activity_records (
  user_id uuid not null references auth.users on delete cascade,
  id text not null check (char_length(id) between 1 and 40),
  data text not null check (octet_length(data) <= 4194304),           -- base64 of the gzip'd JSON, at most 4 MB
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.activity_records enable row level security;
drop policy if exists activity_records_own_read on public.activity_records;
drop policy if exists activity_records_own_insert on public.activity_records;
drop policy if exists activity_records_own_update on public.activity_records;
drop policy if exists activity_records_own_delete on public.activity_records;
create policy activity_records_own_read on public.activity_records for select to authenticated using (user_id = auth.uid());
create policy activity_records_own_insert on public.activity_records for insert to authenticated with check (user_id = auth.uid());
create policy activity_records_own_update on public.activity_records for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy activity_records_own_delete on public.activity_records for delete to authenticated using (user_id = auth.uid());
revoke all on public.activity_records from anon, authenticated;
grant select, insert, update, delete on public.activity_records to authenticated;
