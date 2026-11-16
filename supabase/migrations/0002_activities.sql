-- Full sync: your rides in the account, so every device you sign in on has the same history (docs/superpowers/
-- specs/2026-11-15-full-sync-design.md). One row per ride: the history entry as the app keeps it, or a deletion
-- (deleted = true, entry null) so a ride removed on one device goes from the others too. Only its owner reads
-- and writes it. For `supabase db push`, or to paste into the SQL Editor as it is.

create table if not exists public.activities (
  user_id uuid not null references auth.users on delete cascade,
  id text not null check (char_length(id) between 1 and 40),          -- the app's ride id, 'r1794746...'
  ridden_at timestamptz,
  entry jsonb check (entry is null or octet_length(entry::text) <= 65536),
  deleted boolean not null default false,
  changed_at bigint not null default 0,                                -- ms, the app's updatedAt: the newer copy wins
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists activities_user_ridden on public.activities (user_id, ridden_at desc);

drop trigger if exists activities_touch on public.activities;
create trigger activities_touch before update on public.activities for each row execute function public.touch_updated_at();

alter table public.activities enable row level security;

drop policy if exists activities_own_read on public.activities;
drop policy if exists activities_own_insert on public.activities;
drop policy if exists activities_own_update on public.activities;
drop policy if exists activities_own_delete on public.activities;
create policy activities_own_read on public.activities for select to authenticated using (user_id = auth.uid());
create policy activities_own_insert on public.activities for insert to authenticated with check (user_id = auth.uid());
create policy activities_own_update on public.activities for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy activities_own_delete on public.activities for delete to authenticated using (user_id = auth.uid());
revoke all on public.activities from anon, authenticated;
grant select, insert, update, delete on public.activities to authenticated;
-- delete_me() removes the auth user, and the rides go with it (on delete cascade)
