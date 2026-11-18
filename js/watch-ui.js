// Watching a group ride or race (#86): someone not riding follows it live, on the same channel as the riders
// (social.js groupLive). They hear the riders' positions, never send one, and see the board, the route with everyone
// on it, the rider they follow (power, speed, place) and the chat; they send reactions (and, signed in, messages).
// A spectator says «I am watching» every 10 s, so the riders see how many are.
import { Mates, spectate, rideWindow } from './group.js';
import { ChatLog, Reactions, Watchers, SendGate, QUICK, REACTS, guestId } from './chat.js';
import { drawProfile } from './render.js';

const $ = (id) => document.getElementById(id);
let W = null; // the ride being watched

/**
 * Open the spectator's screen for a ride from the calendar.
 * env: { ride (a group_ride_list row), route, me ({ id, name } or null for a guest), canChat, channel (groupChannel),
 *        tr, esc, toast, track, follow (a rider's id to follow first) }
 */
export async function openWatch(env) {
  closeWatch();
  const { ride: g, route, tr } = env;
  const id = env.me?.id || guestId();
  W = {
    env, g, route, id, name: env.me?.name || tr('Spectator'), t0: Date.parse(g.starts_at),
    mates: new Mates(id), chat: new ChatLog(id), gate: new SendGate(), reacts: new Reactions(), watchers: new Watchers(),
    follow: null, want: env.follow || null, live: null, timer: null, pinged: 0, got: 0,
  };
  const w = W;
  $('watch-view').hidden = false;
  document.body.classList.add('watching');
  $('wv-title').textContent = g.title;
  $('wv-route').textContent = [route?.name, g.kind === 'race' ? `🏁 ${tr('Race')}${!route?.oneWay && g.laps > 1 ? ` · ${tr('{n} laps', { n: g.laps })}` : ''}` : tr('Group ride')].filter(Boolean).join(' · ');
  $('wv-react').innerHTML = REACTS.map((e, i) => `<button class="wv-r" data-e="${i}" aria-label="${env.esc(e)}">${e}</button>`).join('');
  $('wv-quick').innerHTML = QUICK.map((q) => `<button class="pill-btn chat-q" data-q="${q.id}">${env.esc(tr(q.text))}</button>`).join('');
  $('wv-write').hidden = !env.canChat;
  $('wv-write-hint').hidden = !!env.canChat;
  $('wv-feed').innerHTML = '';
  render();
  w.timer = setInterval(() => { if (W === w) render(); }, 250);
  try {
    const live = await env.channel(g.id, {
      pos: (p) => { if (W === w) { w.mates.receive(p, Date.now()); w.got = Date.now(); } },
      chat: (p) => { if (W === w && w.chat.receive(p, Date.now())) renderChat(); },
      react: (p) => { if (W === w) { const r = w.reacts.receive(p, Date.now()); if (r) floatReact(r); } },
      watch: (p) => { if (W === w) w.watchers.receive(p, Date.now()); },
      start: () => { if (W === w && w.g.held) recheck(w); },
    }, { rider: false }); // a spectator sends on the fans' channel only
    if (W === w) w.live = live; else live.leave();
  } catch (e) { env.toast(e.message); }
}

export function closeWatch() {
  if (!W) return;
  clearInterval(W.timer);
  W.live?.leave();
  W = null;
  $('watch-view').hidden = true;
  document.body.classList.remove('watching');
}

const fmt = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };

function render() {
  const w = W, { tr, esc } = w.env, now = Date.now();
  // say we are here, every 10 s
  if (w.live?.joined && now - w.pinged > 10000) { w.pinged = now; w.live.say('watch', { u: w.id }); }
  if (w.g.held && now - (w.polledAt || 0) > 20000) recheck(w);
  const win = rideWindow(w.t0, now, w.g.held);
  $('wv-clock').textContent = win.held ? tr('On the line: waiting for the host to start') : win.state === 'later' || win.state === 'open' ? tr('Starts in {t}', { t: fmt(win.in) })
    : win.state === 'live' ? tr('Riding · {t}', { t: fmt(win.since) }) : tr('Over');
  const n = w.watchers.count(now) + 1; // you too
  $('wv-watchers').textContent = `👀 ${n}`;
  const L = w.route?.length || 0;
  const rows = spectate(w.mates, now, { length: L, laps: w.g.kind === 'race' ? w.g.laps || 1 : 1, oneWay: !!w.route?.oneWay });
  const race = w.g.kind === 'race';
  // the rider asked for (a link's &follow=, or tapped) once they are on the road; till then, the leader
  if (w.want && rows.some((r) => r.id === w.want)) { w.follow = w.want; w.want = null; }
  if (!rows.some((r) => r.id === w.follow)) w.follow = rows[0]?.id || null;
  const f = rows.find((r) => r.id === w.follow);
  $('wv-empty').hidden = rows.length > 0;
  $('wv-empty').textContent = w.live?.joined ? tr('No one on the road yet: riders show up here once they open the ride') : tr('Connecting…');
  // the rider you follow
  $('wv-follow').hidden = !f;
  if (f) {
    $('wv-f-name').textContent = f.name;
    $('wv-f-dot').style.background = f.color;
    $('wv-f-dot').style.boxShadow = `0 0 0 3px ${f.stripe}`;
    $('wv-f-power').textContent = f.finish ? '—' : String(f.power);
    $('wv-f-speed').textContent = f.finish ? '—' : (f.v * 3.6).toFixed(1);
    $('wv-f-wkg').textContent = f.finish ? '—' : f.wkg.toFixed(1);
    $('wv-f-place').textContent = `${f.place}/${rows.length}`;
    const lapTxt = race && !w.route?.oneWay && (w.g.laps || 1) > 1 ? `${tr('Lap {n}', { n: f.lap })}/${w.g.laps} · ` : '';
    $('wv-f-where').textContent = f.finish ? `🏁 ${fmt(f.finish)}` : `${lapTxt}${(Math.max(0, f.dist) / 1000).toFixed(2)} km`;
    $('wv-react').querySelectorAll('button').forEach((b) => { b.disabled = !w.live?.joined; });
  }
  // the board
  $('wv-rows').innerHTML = rows.map((r) => `<li class="wv-row${r.id === w.follow ? ' sel' : ''}" data-id="${esc(r.id)}">`
    + `<span class="rp">${r.place}</span><i style="background:${esc(r.color)};box-shadow:0 0 0 2px ${esc(r.stripe)}"></i><b>${esc(r.name)}</b>`
    + `<span class="wv-w">${r.finish ? `🏁 ${fmt(r.finish)}` : `${r.power} W · ${r.wkg.toFixed(1)}`}</span>`
    + `<span class="wv-g">${r.gap === null ? '' : `+${r.gap.toFixed(1)}${tr('s')}`}</span></li>`).join('');
  // the route, everyone on it, the one you follow on top
  const cv = $('wv-profile');
  if (w.route && cv.clientWidth) {
    const riders = rows.filter((r) => r.id !== w.follow).map((r) => ({ dist: Math.max(0, r.dist), color: r.color }));
    if (f) riders.push({ dist: Math.max(0, f.dist), color: f.color, self: true });
    drawProfile(cv, w.route, riders);
  }
  renderChat();
}

/** A held ride: its start as the database has it now (env.reload), once the host says so or every 20 s. */
function recheck(w) {
  w.polledAt = Date.now();
  w.env.reload?.(w.g.id).then((g) => { if (W === w && g) { w.g = g; w.t0 = Date.parse(g.starts_at); } }).catch(() => {});
}

function renderChat() {
  const w = W;
  if (!w) return;
  const { tr, esc } = w.env;
  const items = w.chat.recent(Date.now(), 30);
  const el = $('wv-feed'), atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  const html = items.map((m) => `<div class="chat-msg${m.me ? ' me' : ''}${m.quick ? ' quick' : ''}">`
    + (m.me ? `<b>${esc(tr('You'))}</b>` : `<button class="chat-who" data-mute="${esc(m.from)}" title="${esc(tr('Mute {name} for this ride', { name: m.name }))}">${esc(m.name)}</button>`)
    + ` <span>${esc(m.quick ? tr(m.text) : m.text)}</span></div>`).join('') || `<p class="muted">${esc(tr('The riders\' chat shows here'))}</p>`;
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; if (atEnd) el.scrollTop = el.scrollHeight; }
}

function say(body) {
  const w = W;
  if (!w?.live?.joined || !w.env.canChat) return false;
  if (!w.gate.ok(Date.now())) { w.env.toast(w.env.tr('Not so fast: a message a second')); return false; }
  const msg = { u: w.id, n: w.name, ...body };
  const shown = w.chat.receive(msg, Date.now(), { mine: true });
  if (!shown) return false;
  w.live.say('chat', body.q ? msg : { ...msg, m: shown.text });
  w.env.track('social', body.q ? 'watch-chat-quick' : 'watch-chat');
  renderChat();
  return true;
}

/** A reaction, yours or another spectator's: it floats up over the rider card. */
function floatReact(r) {
  const el = document.createElement('div');
  el.className = 'react-pop wv-pop';
  el.style.left = `${20 + Math.random() * 60}%`;
  el.innerHTML = `<span>${r.emoji}</span>`;
  $('wv-follow').append(el);
  setTimeout(() => el.remove(), 2600);
}

/** The buttons of the screen, wired once. */
export function initWatch() {
  $('wv-close').onclick = closeWatch;
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && W && !e.target.closest?.('input')) closeWatch(); });
  $('wv-rows').onclick = (e) => { const li = e.target.closest('[data-id]'); if (li && W) { W.follow = li.dataset.id; W.want = null; render(); } };
  $('wv-react').onclick = (e) => {
    const b = e.target.closest('[data-e]'), w = W;
    if (!b || !w?.live?.joined || !w.follow) return;
    if (!w.gate.ok(Date.now())) return;
    w.live.say('react', { u: w.id, n: w.name, to: w.follow, e: Number(b.dataset.e) });
    w.env.track('social', 'watch-react');
    floatReact({ emoji: REACTS[Number(b.dataset.e)] });
    b.classList.remove('sent'); void b.offsetWidth; b.classList.add('sent');
  };
  $('wv-quick').onclick = (e) => { const b = e.target.closest('[data-q]'); if (b) say({ q: b.dataset.q }); };
  const send = () => { const t = $('wv-input').value.trim(); if (t && say({ m: t })) $('wv-input').value = ''; };
  $('wv-send').onclick = send;
  $('wv-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  $('wv-feed').onclick = (e) => {
    const b = e.target.closest('[data-mute]');
    if (!b || !W) return;
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = W.env.tr('Mute?'); return; }
    W.chat.mute(b.dataset.mute);
    W.env.toast(W.env.tr('Muted for this ride'));
    $('wv-feed').dataset.html = '';
    renderChat();
  };
}

/** Whether the spectator's screen is open (for tests). */
export const watching = () => !!W;
