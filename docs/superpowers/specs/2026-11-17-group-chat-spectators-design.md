# Chat in group rides (#85) and spectator mode (#86)

**Why:** testers asked to talk during a group ride, and to watch a friend's race and cheer.

## Chat
- **Where:** in a group ride, the last messages show over the road, bottom left, for 20 s each. The 💬 button or **Enter** opens the field.
- **Quick phrases:** for a rider on the trainer who cannot type. There are six (👍, On your wheel, Wait for me, Easy, Attack!, Good ride!). They are clickable, and the digits 1–6 send them when the field is empty. Each is sent as an id, so every screen shows it in its own language.
- **Transport:** the ride's Realtime broadcast channel (`group:<id>`), event `chat`, `{ u, n, m | q }`. Nothing is stored.
- **Moderation, on every screen (js/chat.js):**
  - rude words are masked (Ukrainian, Russian and English roots, Latin look-alikes folded);
  - links are dropped;
  - control and bidi characters are stripped, and a message is at most 140 characters;
  - you send at most 1 message a second and 5 in 15 s, and the other screens drop anything faster from a sender;
  - a tap on a name (twice) mutes that rider for the ride.

## Spectators
- **The way in:**
  - **👀 Watch** on a calendar row once the ride is open, for anyone, a guest too;
  - a link `#watch=<id>`;
  - a rider's own **«Copy a link to watch me»** link (`&follow=<their id>`), from the chat field.
- **The screen (js/watch-ui.js):**
  - the rider you follow: power, speed, W/kg, place, lap and km (finished: their time);
  - the route profile with everyone on it;
  - the board, with finishers first by time, then by distance, and gaps in seconds (`spectate` in js/group.js);
  - the chat.
- **Reactions:** 👍 🔥 👏 💪 ⚡, event `react` `{ u, n, to, e }`, at most one a second per spectator. The rider they are sent to sees the emoji float up their screen, with the name.
- **Watchers:** a spectator sends `watch` `{ u }` every 10 s. A rider sees «👀 N», where N counts those heard from in the last 25 s.
- **Writing:** writing in the chat needs an account with a profile. Reactions do not. A guest gets a random id for the tab.
- **Power in the packet:** the position packet now carries `p`, the watts over the last 3 s, held to 0–3000 W.

## Known limits
- The channel is public, like the positions: anyone with the anon key can send to it, under any name. A private channel (RLS on `realtime.messages`, only those who joined) is the next step. It also covers the league results.
- Moderation is client-side: it filters what each screen shows, and it cannot ban anyone.
