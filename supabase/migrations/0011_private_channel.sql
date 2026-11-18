-- A group ride's live channel made private (Realtime Authorization). The riders' positions, their chat and the
-- host's start go on `group:<ride id>` with `private: true`: anyone may listen to a ride that is on (spectators,
-- guests too), but only the ride's riders may send on it, so no one else can put a made-up rider on the road or
-- write in the riders' name. Spectators' reactions, «I am watching» and their chat go on the public `fans:<ride id>`
-- (js/social.js groupLive). Safe to apply again.

-- whether the channel `topic` is a ride that is on (or held, or to come in 10 minutes), and for p_send, ridden by you
create or replace function public.group_channel_ok(p_topic text, p_send boolean)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.group_rides g
    where p_topic = 'group:' || g.id::text
      and (g.held and g.starts_at > now() or g.starts_at between now() - interval '4 hours' and now() + interval '15 minutes')
      and (not p_send or exists (select 1 from public.group_ride_riders r where r.ride_id = g.id and r.user_id = auth.uid()))
  )
$$;
revoke all on function public.group_channel_ok(text, boolean) from public, anon, authenticated;
grant execute on function public.group_channel_ok(text, boolean) to anon, authenticated;

drop policy if exists group_channel_listen on realtime.messages;
drop policy if exists group_channel_send on realtime.messages;
create policy group_channel_listen on realtime.messages for select to anon, authenticated
  using (realtime.messages.extension = 'broadcast' and public.group_channel_ok(realtime.topic(), false));
create policy group_channel_send on realtime.messages for insert to authenticated
  with check (realtime.messages.extension = 'broadcast' and public.group_channel_ok(realtime.topic(), true));
