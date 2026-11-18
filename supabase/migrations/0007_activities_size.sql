-- Full sync: a ride's history entry may be up to 1 MB. The 64 KB limit of 0002 was too small for a long ride (the
-- chart holds six series every 5 s: a 3-hour ride is past 64 KB), and one such ride failed the whole batch of up
-- to 100, so no ride reached the account and other devices saw no history.
alter table public.activities drop constraint if exists activities_entry_check;
alter table public.activities drop constraint if exists activities_entry_size;
alter table public.activities add constraint activities_entry_size check (entry is null or octet_length(entry::text) <= 1048576);
