// Accounts and leaderboards on the page (docs/specs/social-phase1.md): the card in Profile, the first sign-in's
// window, places on the finish screen, the route's table in the lobby, the week's leader on the climb panel and
// the table itself. app.js hands over what it owns (settings, records, levels) through ctx and calls the hooks;
// without a project (social-config.js) init returns at once and none of it shows.
import {
  socialOn, initSocial, currentUser, onUser, signIn, signOut, loadProfile, saveProfile, queueAdd, queued, sendResults, leaderboard, deleteAccount,
  loadActivities, saveActivities, sendRides, regionBoard, riderBoard, groupRides, createGroupRide, cancelGroupRide, joinGroupRide, groupLive,
  finishGroupRace, groupRaceResults,
} from './social.js';
import { rideWindow } from './group.js';
import { openWatch, initWatch } from './watch-ui.js';
import { initLeagues, load as loadLeagues, leagueSelect, chosenLeague } from './league-ui.js';
import {
  SYNC_FIELDS, profileFields, accountData, mergeData, sameData, categoryOf, routeVersion, withGaps, flagOf, mergeById, workoutsData, activityRows,
  REGIONS, regionName,
} from './social-core.js';

let ctx = null;
let profileRow = null; // my row in profiles, once read
/** How the last sync went, shown in the header and the account card: never, syncing, ok (when, rides) or error. */
let syncState = { state: 'never', at: 0, rides: null, error: '' };
let snapshot = '';      // the synced settings as last seen, to tell when one changes
let syncTimer = null;
let syncing = null;
const $ = (id) => document.getElementById(id);
const versions = new Map();
const leaders = new Map(); // climb id -> the week's leader in my category, for the climb panel
const boards = new Map();  // route id -> { at, html } for the lobby
let results = new Map();   // `${segment}|${time}` -> the server's answer, for the finish screen

const tr = (s, v) => ctx.tr(s, v);
const on = () => !!ctx;

/** A built-in route's version (cached: it is the same all the page's life). */
export function versionOf(route) {
  if (!versions.has(route.id)) versions.set(route.id, routeVersion(route));
  return versions.get(route.id);
}

const localData = () => accountData({ settings: ctx.settings, lang: ctx.lang, settingsUpdatedAt: ctx.settings.settingsUpdatedAt || 0, progress: ctx.getProgress(), records: ctx.records });
const fieldsNow = () => JSON.stringify(profileFields(ctx.settings, ctx.lang));
const redirect = () => `${location.origin}${location.pathname}`;
const myCategory = () => categoryOf(ctx.settings.ftp, ctx.settings.weight);

// ---------- Start ----------

export async function initSocialUi(c) {
  if (!socialOn()) return;
  ctx = c;
  snapshot = fieldsNow();
  buildUi();
  let start = null;
  try { start = await initSocial({ stravaState: c.stravaState }); } catch (e) { status(tr('Account: {error}', { error: e.message })); }
  onUser(() => { profileRow = null; renderCard(); boards.clear(); renderRoute(); });
  renderCard();
  // back from Google: stay in the lobby (a new account gets its window over it, from sync)
  if (start?.error) { status(tr('Not signed in: {error}', { error: start.error })); c.toast(tr('Not signed in: {error}', { error: start.error })); }
  if (currentUser()) await sync({ send: true }).catch((e) => status(tr('Account: {error}', { error: e.message })));
  if (start?.returned && start.user) {
    c.track('social-login');
    if (profileRow) c.toast(tr('Signed in: {name}', { name: profileRow.display_name }));
  }
  renderRoute();
  // a group ride's link (#group=<id>), or one you were about to join before signing in
  const linked = /^#group=([0-9a-f-]{36})$/i.exec(location.hash)?.[1] || sessionStorage.getItem(GR_PENDING);
  sessionStorage.removeItem(GR_PENDING);
  if (linked) { if (location.hash) history.replaceState(null, '', location.pathname + location.search); openGroups(linked); }
  // a link to watch a ride (#watch=<id>, and whom to follow: &follow=<id>)
  const w = /^#watch=([0-9a-f-]{36})(?:&follow=([\w-]{1,64}))?$/i.exec(location.hash);
  if (w) { history.replaceState(null, '', location.pathname + location.search); watchById(w[1], w[2] || null); }
}

function status(text) { const el = $('social-status'); if (el) el.textContent = text || ''; }

function buildUi() {
  // the card belongs to the Profile page: shown when that page is (another may be open right now)
  $('social-card').dataset.off = '';
  $('social-card').hidden = !!document.querySelector('[data-panel="profile"]:not(#social-card)')?.hidden;
  $('btn-social-in').onclick = () => { ctx.track('social', 'sign-in'); signIn(redirect()).catch((e) => status(e.message)); };
  $('btn-social-out').onclick = async () => { await signOut(); status(tr('Signed out. Everything stays on this device.')); };
  $('btn-social-edit').onclick = () => openSetup();
  $('btn-social-sync').onclick = () => { ctx.track('social', 'sync-now'); sync({ send: true }).catch(() => {}); };
  $('f-social-public').onchange = async () => {
    try { profileRow = { ...profileRow, ...(await saveProfile({ public: $('f-social-public').checked })) }; } catch (e) { status(e.message); }
  };
  const del = $('btn-social-delete');
  del.onclick = async () => {
    if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = tr('Tap again: delete the account and all its results'); return; }
    del.dataset.armed = ''; del.textContent = tr('Delete account');
    try { await deleteAccount(); ctx.track('social', 'delete'); status(tr('Account deleted, with all its results. Your rides on this device stay.')); } catch (e) { status(e.message); }
  };
  // the first sign-in's window
  for (const el of document.querySelectorAll('[data-ss-close]')) el.onclick = () => { $('social-setup').hidden = true; };
  const names = (() => { try { return new Intl.DisplayNames([ctx.locale], { type: 'region' }); } catch { return null; } })();
  const countries = COUNTRIES.map((cc) => [cc, names?.of(cc) || cc]).sort((a, b) => a[1].localeCompare(b[1], ctx.locale));
  $('ss-country').innerHTML = `<option value="">${tr('Not shown')}</option>${countries.map(([cc, n]) => `<option value="${cc}">${flagOf(cc)} ${ctx.esc(n)}</option>`).join('')}`;
  $('ss-save').onclick = saveSetup;
  const regions = REGIONS.map(([code]) => [code, regionName(code, ctx.lang)]).sort((a, b) => a[1].localeCompare(b[1], ctx.locale));
  $('ss-region').innerHTML = `<option value="">${tr('Not shown')}</option>${regions.map(([c, n]) => `<option value="${c}">${ctx.esc(n)}</option>`).join('')}`;
  $('ss-country').onchange = () => { $('ss-region-box').hidden = $('ss-country').value !== 'UA'; };
  // the ratings across Ukraine
  $('ua-region').innerHTML = `<option value="">${tr('All of Ukraine')}</option>${regions.map(([c, n]) => `<option value="${c}">${ctx.esc(n)}</option>`).join('')}`;
  $('hdr-ua').hidden = false;
  $('hdr-ua').onclick = () => { ctx.track('social', 'ua-board'); gate('ua', openUa); };
  for (const el of document.querySelectorAll('[data-ua-close]')) el.onclick = () => { $('ua-view').hidden = true; };
  for (const id of ['ua-tab', 'ua-period', 'ua-metric', 'ua-gender']) {
    $(id).onclick = (ev) => {
      const b = ev.target.closest('[data-v]');
      if (!b) return;
      for (const x of $(id).querySelectorAll('[data-v]')) x.classList.toggle('sel', x === b);
      renderUa();
    };
  }
  $('ua-region').onchange = renderUa;
  // group rides
  $('hdr-group').hidden = false;
  $('hdr-group').onclick = () => { ctx.track('social', 'group-list'); gate('group', () => openGroups()); };
  // the lock sheet: what an account gives, from a guest's tap on something that wants one
  for (const el of document.querySelectorAll('[data-lock-close]')) el.onclick = () => { $('lock-sheet').hidden = true; };
  $('lock-signin').innerHTML = `${GOOGLE_G}<span>${ctx.esc(tr('Sign in with Google'))}</span>`;
  for (const el of document.querySelectorAll('[data-gr-close]')) el.onclick = () => { $('gr-view').hidden = true; };
  $('gr-list').onclick = groupAction;
  initWatch();
  $('gr-form').onsubmit = groupCreate;
  $('gr-kind').onchange = $('gr-route').onchange = grLapsShow;
  initLeagues({
    ctx, signedIn: () => !!currentUser(), hasProfile: () => !!profileRow,
    needAccount: () => { if (!currentUser()) signIn(redirect()).catch((e) => status(e.message)); else openSetup(); },
    openRide: (id) => { grFocus = id; renderGroups(); $('gr-list').querySelector(`[data-row="${id}"]`)?.scrollIntoView({ block: 'nearest' }); },
  });
  // the table
  for (const el of document.querySelectorAll('[data-lb-close]')) el.onclick = () => { $('lb-view').hidden = true; };
  $('lb-signin').onclick = () => signIn(redirect()).catch((e) => status(e.message));
  for (const id of ['lb-period', 'lb-gender', 'lb-cat']) {
    $(id).onclick = (ev) => {
      const b = ev.target.closest('[data-v]');
      if (!b) return;
      for (const x of $(id).querySelectorAll('[data-v]')) x.classList.toggle('sel', x === b);
      renderBoard();
    };
  }
  $('lb-seg').onchange = renderBoard;
  $('btn-social-cta').onclick = () => {
    const items = JSON.parse($('btn-social-cta').dataset.items || '[]');
    queueAdd(items); // waits here while you sign in, and goes with the first sync after
    ctx.track('social', 'sign-in-finish');
    signIn(redirect()).catch((e) => status(e.message));
  };
  // the language is in the profile too: picked here, it is the newest
  $('f-lang')?.addEventListener('change', () => { ctx.settings.settingsUpdatedAt = Date.now(); ctx.saveSettingsRaw(); });
}

/** The way to the account from the lobby: «Sign in with Google», or, signed in, who you are in the tables. */
function renderHeader() {
  const b = $('hdr-account');
  if (!b) return;
  const u = currentUser();
  b.hidden = false;
  b.classList.toggle('in', !!u);
  // a guest: who you are now and the way in; signed in: you, your oblast, and that your things are on every device
  $('hdr-guest').hidden = !!u;
  const name = profileRow?.display_name || u?.email?.split('@')[0] || '';
  // what the last sync did, not a promise: «synced» only once it went through
  const said = { syncing: tr('syncing…'), ok: tr('synced'), error: `⚠ ${tr('not synced')}` }[syncState.state] || '';
  const sub = [profileRow?.region ? regionName(profileRow.region, ctx.lang) : '', said].filter(Boolean).join(' · ');
  b.innerHTML = u
    ? `<i class="hdr-avatar" style="background:${ctx.esc(ctx.settings.jersey || '#7c3aed')}">${ctx.esc((name[0] || '?').toUpperCase())}</i><span class="hdr-who"><b>${ctx.esc(name)}</b><small>${ctx.esc(sub)}</small></span>`
    : `${GOOGLE_G}<span>${ctx.esc(tr('Sign in'))}</span>`;
  b.title = u ? tr('Your account and leaderboards') : tr('Sign in to put your times in the tables, and to have your profile on every device');
  // what wants an account wears a lock for a guest (looking stays open to anyone)
  for (const id of ['hdr-ua', 'hdr-group']) {
    const el = $(id);
    el.classList.toggle('locked', !u);
    el.querySelector('.lock-ic')?.remove();
    if (!u) el.insertAdjacentHTML('beforeend', LOCK_IC);
  }
  renderToday();
  b.onclick = u ? accountMenu : () => { ctx.track('social', 'sign-in-header'); signIn(redirect()).catch((e) => status(e.message)); };
  if (!u) $('hdr-menu')?.remove();
}

/** Signed in, a tap on your name in the header: a small menu, to your profile or out of the account. */
function accountMenu(ev) {
  ev.stopPropagation();
  if ($('hdr-menu')) { $('hdr-menu').remove(); return; }
  const b = $('hdr-account'), m = document.createElement('div');
  m.id = 'hdr-menu';
  m.className = 'hdr-menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = `<button role="menuitem" data-m="profile">${ctx.esc(tr('Your account and leaderboards'))}</button>`
    + `<button role="menuitem" data-m="out">${ctx.esc(tr('Sign out'))}</button>`;
  const r = b.getBoundingClientRect();
  m.style.top = `${Math.round(r.bottom + 6)}px`;
  m.style.right = `${Math.round(Math.max(8, innerWidth - r.right))}px`;
  document.body.append(m);
  const close = () => { m.remove(); document.removeEventListener('click', away, true); document.removeEventListener('keydown', esc); };
  const away = (e) => { if (!m.contains(e.target) && e.target !== b && !b.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('click', away, true);
  document.addEventListener('keydown', esc);
  m.onclick = async (e) => {
    const it = e.target.closest('[data-m]');
    if (!it) return;
    close();
    if (it.dataset.m === 'profile') { showAccount(); return; }
    ctx.track('social', 'sign-out-header');
    await signOut();
    ctx.toast(tr('Signed out. Everything stays on this device.'));
  };
  m.querySelector('button').focus();
}

const LOCK_IC = '<svg class="lock-ic" viewBox="0 0 24 24" role="img" aria-label="with an account"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

// ---------- A guest at something that wants an account ----------
const LOCK_SEEN = 'gruppetto.lockSeen';
const LOCKS = {
  ua: { title: 'Ratings of Ukraine: with an account', why: 'So that your kilometres and climbing count for your oblast. Anyone can look at the board.', guest: 'Just look, as a guest' },
  group: { title: 'Group rides: with an account', why: 'So that the others see who rides beside them. Anyone sees the calendar; joining and riding come after signing in.', guest: 'See the calendar as a guest' },
};
const OPENS = { tables: 'the tables of climbs, sprints and laps', ua: 'Ratings of Ukraine', group: 'group rides', sync: 'your profile and history on every device' };

/**
 * A guest's first tap on something that wants an account: the sheet with what it gives and the two ways on, once
 * per feature (later taps go straight to it, where its own line asks to sign in). Signed in: straight on.
 */
function gate(kind, go) {
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(LOCK_SEEN) || '{}'); } catch { /* private mode */ }
  if (currentUser() || seen[kind]) { go(); return; }
  seen[kind] = 1;
  try { localStorage.setItem(LOCK_SEEN, JSON.stringify(seen)); } catch { /* private mode */ }
  const L = LOCKS[kind];
  $('lock-title').textContent = tr(L.title);
  $('lock-why').textContent = tr(L.why);
  $('lock-also').textContent = Object.keys(OPENS).filter((k) => k !== kind).map((k) => tr(OPENS[k])).join(' · ');
  $('lock-guest').textContent = tr(L.guest);
  $('lock-guest').onclick = () => { ctx.track('social', `lock-guest-${kind}`); $('lock-sheet').hidden = true; go(); };
  $('lock-signin').onclick = () => { ctx.track('social', `lock-sign-in-${kind}`); signIn(redirect()).catch((e) => status(e.message)); };
  $('lock-sheet').hidden = false;
  ctx.track('social', `lock-${kind}`);
}

/** Sign in from outside this file (the first visit's welcome). */
export function socialSignIn(source = 'welcome') {
  if (!socialOn()) return;
  ctx?.track('social', `sign-in-${source}`);
  signIn(redirect()).catch((e) => status(e.message));
}

// ---------- Your day, signed in ----------
let todayAt = 0;
let todayData = null;

/** The lobby's strip for a signed-in rider: your oblast this week, the next group ride. Nothing for a guest. */
async function renderToday(force = false) {
  const box = $('me-today');
  if (!box) return;
  const u = currentUser();
  if (!u || !profileRow) { box.hidden = true; return; } // the profile first (its oblast)
  if (force || !todayData || Date.now() - todayAt > 120000) {
    todayAt = Date.now();
    const [regions, rides] = await Promise.all([
      profileRow?.region ? regionBoard({ period: 'week', metric: 'km' }).catch(() => null) : Promise.resolve(null),
      groupRides(7).catch(() => null),
    ]);
    todayData = { regions, rides };
  }
  if (currentUser()?.id !== u.id) return;
  const { regions, rides } = todayData;
  const tiles = [];
  if (profileRow?.region) {
    const r = regions?.find((x) => x.region === profileRow.region);
    tiles.push(`<button class="me-tile" data-today="ua"><small>${tr('Your oblast this week')}</small>`
      + `<b>${ctx.esc(regionName(profileRow.region, ctx.lang))}${r ? ` · ${tr('{place} of {n}', { place: r.place, n: regions.length })}` : ''}</b>`
      + `<span>${r ? tr('{km} km together, {riders} riding', { km: Math.round(Number(r.distance_km)).toLocaleString(ctx.locale), riders: r.riders }) : tr('No kilometres yet this week: yours can be the first')}</span></button>`);
  } else if (!profileRow.country || profileRow.country === 'UA') {
    tiles.push(`<button class="me-tile" data-today="setup"><small>${tr('Ratings of Ukraine')}</small><b>${tr('Pick your oblast')}</b><span>${tr('and your kilometres count for it')}</span></button>`);
  }
  const now = Date.now(), next = (rides || []).filter((g) => rideWindow(Date.parse(g.starts_at), now).state !== 'over');
  const g = next.find((x) => x.joined) || next[0];
  if (g) {
    const d = new Date(g.starts_at), today = d.toDateString() === new Date().toDateString();
    const when = `${today ? tr('Today') : d.toLocaleDateString(ctx.locale, { weekday: 'short', day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(ctx.locale, { hour: '2-digit', minute: '2-digit' })}`;
    const route = ctx.routes().find((r) => r.id === g.route_id);
    tiles.push(`<button class="me-tile acc" data-today="group"><small>${g.joined ? tr('Your group ride') : tr('Group ride')}</small><b>${ctx.esc(when)}</b>`
      + `<span>${ctx.esc(g.title)}${route ? ` · ${ctx.esc(route.name)}` : ''} · ${tr('{n} going', { n: g.riders })}</span></button>`);
  } else {
    tiles.push(`<button class="me-tile" data-today="group"><small>${tr('Group rides')}</small><b>${tr('Nothing planned this week')}</b><span>${tr('Set one up and send the link to friends')}</span></button>`);
  }
  box.innerHTML = tiles.join('');
  box.hidden = false;
  box.onclick = (ev) => {
    const t = ev.target.closest('[data-today]')?.dataset.today;
    if (t === 'ua') openUa(); else if (t === 'setup') openSetup(); else if (t === 'group') openGroups(g?.id || null);
  };
}

/** Profile, at the account card. */
function showAccount() {
  ctx.openDrawer('profile', 'me');
  requestAnimationFrame(() => $('social-card').scrollIntoView({ block: 'start' }));
}

export const GOOGLE_G = '<svg viewBox="0 0 48 48" class="g-logo" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function renderCard() {
  if (!on()) return;
  renderHeader();
  const u = currentUser();
  $('social-out').hidden = !!u;
  $('social-in').hidden = !u;
  $('social-pitch').hidden = !!u;
  if (u) {
    const name = profileRow?.display_name;
    $('social-who').textContent = name ? tr('Signed in as {email} · in the tables: {name}', { email: u.email || '', name }) : tr('Signed in as {email}', { email: u.email || '' });
    $('f-social-public').checked = profileRow?.public !== false;
  }
  renderSync();
}

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? tr('just now') : m < 60 ? tr('{n} min ago', { n: m }) : new Date(t).toLocaleTimeString(ctx.locale, { hour: '2-digit', minute: '2-digit' });
};

/** The account card's line on the sync: when it last went through and how many rides the account holds, or what went wrong. */
function renderSync() {
  const el = $('social-sync');
  if (!el) return;
  const s = syncState, u = currentUser();
  el.hidden = !u || s.state === 'never';
  el.classList.toggle('bad', s.state === 'error');
  $('social-sync-text').textContent = s.state === 'syncing' ? tr('Syncing…')
    : s.state === 'error' ? tr('Not synced: {error}', { error: s.error })
      : [tr('Synced {when}', { when: ago(s.at) }), s.rides === null ? '' : tr('{n} rides in the account', { n: s.rides })].filter(Boolean).join(' · ');
  $('btn-social-sync').disabled = s.state === 'syncing';
}

function setSync(next) { syncState = { ...syncState, ...next }; renderHeader(); renderSync(); }

// ---------- Profile ----------

/** Puts the account's data here (the newer profile, the best records) and leaves the rest. */
function apply(merged) {
  const s = ctx.settings, p = merged.profile || {};
  let changed = false;
  for (const k of SYNC_FIELDS) {
    if (k === 'lang' || p[k] === undefined || sameData(s[k], p[k])) continue;
    s[k] = p[k]; changed = true;
  }
  if (p.lang && p.lang !== ctx.lang) { try { localStorage.setItem('gruppetto.lang', p.lang); } catch { /* private mode */ } } // from the next page load
  s.settingsUpdatedAt = merged.settingsUpdatedAt || s.settingsUpdatedAt || 0;
  ctx.saveSettingsRaw();
  const r = ctx.records;
  let recs = false;
  for (const k of ['lap', 'seg', 'top']) {
    for (const [id, v] of Object.entries(merged.records?.[k] || {})) {
      if (r[k][id] === v) continue;
      if (k === 'seg') delete r.segTrace[id]; // a record from another device: its climb ghost rides an even pace
      r[k][id] = v; recs = true;
    }
  }
  if (recs) ctx.saveRecords();
  if (merged.progress && !sameData(merged.progress, ctx.getProgress())) { ctx.setProgress(merged.progress); changed = true; }
  snapshot = fieldsNow();
  if (changed || recs) ctx.refresh();
}

/**
 * This device and the account, the same: read, merge, write back what changed. A new account gets this
 * device's data (after the window asking for a name). `send`: also the results waiting in the queue.
 */
export function sync({ send = false } = {}) {
  if (!on() || !currentUser()) return Promise.resolve();
  if (syncing) return syncing.then(() => sync({ send }));
  setSync({ state: 'syncing' });
  syncing = (async () => {
    const row = await loadProfile();
    if (!row) {
      // a new account: this device's profile is the one, from now
      if (!ctx.settings.settingsUpdatedAt) { ctx.settings.settingsUpdatedAt = Date.now(); ctx.saveSettingsRaw(); }
      openSetup({ first: true });
      return;
    }
    profileRow = row;
    renderCard();
    renderToday(true);
    const merged = mergeData(localData(), row.data);
    merged.workouts = syncWorkouts(row.data?.workouts);
    apply(merged);
    // each part on its own: the profile failing to save must not keep the rides or the results from syncing
    const errors = [];
    const step = async (f) => { try { await f(); } catch (e) { errors.push(e); } };
    if (!sameData(merged, row.data)) await step(() => saveProfile({ data: merged }));
    await step(async () => { const n = await syncRides(); if (n !== undefined) syncState.rides = n; });
    if (send) await step(flush);
    if (errors.length) throw errors[0];
  })().then(() => { if (syncState.state === 'syncing') setSync({ state: 'ok', at: Date.now(), error: '' }); },
    (e) => { setSync({ state: 'error', error: e?.message || String(e) }); throw e; })
    .finally(() => { syncing = null; });
  return syncing;
}

const unionDeleted = (a, b) => { const out = { ...(a || {}) }; for (const [id, t] of Object.entries(b || {})) if (!(out[id] >= t)) out[id] = t; return out; };

/** Your own workouts, here and in the account's data, as one; this device takes the result. */
function syncWorkouts(remote) {
  const deleted = unionDeleted(ctx.workoutsDeleted(), remote?.deleted);
  const m = mergeById(ctx.getWorkouts(), remote?.list || [], { deleted });
  if (m.removed.length || !sameData(m.items, ctx.getWorkouts()) || !sameData(deleted, ctx.workoutsDeleted())) ctx.setWorkouts(m.items, deleted);
  return workoutsData(m.items, deleted);
}

/** The ride history, here and in the activities table, as one: new rides both ways, deletions both ways. */
async function syncRides() {
  const rows = await loadActivities();
  if (!rows) return undefined; // the table is not in the project yet (0002_activities.sql)
  const remoteDeleted = {}, remote = [];
  for (const r of rows) {
    if (r.deleted) remoteDeleted[r.id] = r.changed_at || 0;
    else if (r.entry) remote.push({ ...r.entry, updatedAt: r.changed_at || r.entry.updatedAt || 0 });
  }
  const localDeleted = ctx.historyDeleted();
  const m = mergeById(ctx.getHistory(), remote, { deleted: unionDeleted(localDeleted, remoteDeleted) });
  const items = m.items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 100); // this device keeps the latest 100
  if (m.removed.length || !sameData(items.map((x) => x.id), ctx.getHistory().map((x) => x.id)) || items.some((x, i) => x !== ctx.getHistory()[i])) {
    ctx.setHistory(items, m.removed);
  }
  // up: rides the table lacks or holds older, and deletions it has not heard of
  const byId = new Map(rows.map((r) => [r.id, r]));
  const gone = Object.fromEntries(Object.entries(localDeleted).filter(([id, t]) => { const r = byId.get(id); return !r || !r.deleted || (r.changed_at || 0) < t; }));
  await saveActivities(activityRows(m.push, gone));
  // the rides the account holds now: what it had, and what went up from here
  const there = new Set(rows.filter((r) => !r.deleted).map((r) => r.id));
  for (const e of m.push) there.add(e.id);
  for (const id of Object.keys(gone)) there.delete(id);
  return there.size;
}

function openSetup({ first = false } = {}) {
  $('ss-name').value = profileRow?.display_name || (ctx.settings.name && ctx.settings.name !== 'Me' ? ctx.settings.name : '') || currentUser()?.user_metadata?.full_name?.slice(0, 24) || '';
  $('ss-country').value = profileRow?.country || '';
  $('ss-region').value = profileRow?.region || '';
  $('ss-region-box').hidden = $('ss-country').value !== 'UA';
  $('ss-gender').value = profileRow?.gender || '';
  $('ss-public').checked = profileRow ? profileRow.public !== false : true;
  $('social-setup').dataset.first = first ? '1' : '';
  $('social-setup').hidden = false;
  $('ss-name').focus();
}

async function saveSetup() {
  const name = $('ss-name').value.trim().slice(0, 24);
  if (!name) { $('ss-name').focus(); return; }
  const country = $('ss-country').value || null;
  const fields = { display_name: name, country, gender: $('ss-gender').value || null, public: $('ss-public').checked };
  if (country === 'UA' || profileRow?.region) fields.region = country === 'UA' ? $('ss-region').value || null : null;
  const first = $('social-setup').dataset.first === '1';
  try {
    if (first) fields.data = mergeData(localData(), null);
    profileRow = { ...profileRow, ...(await saveProfile(fields)) };
    $('social-setup').hidden = true;
    renderCard();
    if (first) { status(tr('Your profile is in the account now, on every device you sign in on.')); await flush(); sync().catch((e) => console.warn('Account sync:', e.message)); }
  } catch (e) { $('ss-error').textContent = e.message; }
}

/** After a setting is saved: when it is one that syncs, it is the newest now, and goes up in 3 s. */
export function socialSettingsSaved() {
  if (!on()) return;
  const now = fieldsNow();
  if (now === snapshot) return;
  snapshot = now;
  ctx.settings.settingsUpdatedAt = Date.now();
  ctx.saveSettingsRaw();
  if (!currentUser()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync().catch((e) => console.warn('Account sync:', e.message)), 3000);
}

/** After the ride history or your workouts change here: up to the account in 3 s. */
export function socialDataChanged() {
  if (!on() || !currentUser()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync().catch((e) => console.warn('Account sync:', e.message)), 3000);
}

// ---------- Results ----------

/** The results waiting, sent; their places noted for the finish screen. */
async function flush(items = []) {
  if (!profileRow) { queueAdd(items); return []; } // the first sign-in's window first: the profile must exist
  const answers = await sendResults(items);
  if ((await sendRides()).some((r) => r?.status === 'saved')) uaCache.clear();
  for (const { item, result } of answers) if (result) results.set(`${item.segment_id}|${item.time_s}`, result);
  const saved = answers.filter((a) => a.result?.status === 'saved');
  if (saved.length) { ctx.track('social-submit', saved.length > 9 ? '10+' : String(saved.length)); boards.clear(); leaders.clear(); }
  return answers;
}

/**
 * After a ride (items: its results that may go in the tables). Signed in: they go now (or wait for the
 * network) and the finish screen shows the places; signed out: the finish screen asks you to sign in.
 */
export async function socialAfterRide(items, { firstName, simulated = false, timed = false, ride = null } = {}) {
  if (!on()) return;
  // the ride's kilometres and climbing for the ratings across Ukraine: now, or with the first sync after signing in
  if (ride) sendRides(ride).then((r) => { if (r.some((x) => x?.status === 'saved')) uaCache.clear(); }).catch(() => {});
  const cta = $('sum-social');
  cta.hidden = true;
  results = new Map();
  if (!items.length) {
    if (currentUser()) sync().catch((e) => console.warn('Account sync:', e.message));
    // laps or segments were timed, but none go to the tables: say why, rather than nothing
    if (timed) {
      $('sum-social-text').textContent = simulated
        ? tr('Simulator ride: these times stay on this device. The tables take rides on a trainer only.')
        : tr('These times did not pass the checks (power, speed, weight), so they are not in the tables.');
      $('btn-social-cta').hidden = true;
      cta.hidden = false;
    }
    return;
  }
  if (!currentUser()) {
    $('btn-social-cta').hidden = false;
    $('btn-social-cta').textContent = tr('Sign in, so your time on {climb} goes into the table', { climb: firstName || tr('this route') });
    $('btn-social-cta').dataset.items = JSON.stringify(items);
    $('sum-social-text').textContent = '';
    cta.hidden = false;
    return;
  }
  try {
    const answers = await flush(items);
    if (!answers.length && queued().length) { $('sum-social-text').textContent = tr('No connection: your times go to the tables next time'); $('btn-social-cta').hidden = true; cta.hidden = false; }
    decorateSummary();
    await sync();
  } catch (e) { status(e.message); }
}

/** The places beside this ride's times on the finish screen («#14 of 213 · week #3»); a click opens the table. */
export function decorateSummary() {
  if (!on()) return;
  for (const tr0 of document.querySelectorAll('#sum-seg-rows tr[data-seg]')) {
    const r = results.get(`${tr0.dataset.seg}|${tr0.dataset.t}`);
    const cell = tr0.querySelector('.lb-cell');
    if (!cell) continue;
    if (!r || r.status === 'rejected' || !r.place) { cell.innerHTML = r?.status === 'rejected' ? `<small class="muted" title="${ctx.esc(tr('Not believable, so not in the table'))}">—</small>` : ''; continue; }
    const week = r.week_place ? ` · ${tr('week #{n}', { n: r.week_place })}` : '';
    cell.innerHTML = `<button class="lb-place" data-seg="${ctx.esc(tr0.dataset.seg)}">${tr('#{place} of {total}', { place: r.place, total: r.total })}${week}</button>`;
    cell.querySelector('button').onclick = () => openBoard(ctx.routeOfSegment(tr0.dataset.seg), tr0.dataset.seg);
  }
}

// ---------- Tables ----------

const segmentsOf = (route) => [
  { id: `${route.id}-lap`, name: route.oneWay ? tr('Finish') : tr('Lap') },
  ...route.climbs.map((c) => ({ id: c.id, name: `⛰ ${c.name}` })),
  ...(route.sprints || []).map((s) => ({ id: s.id, name: `⚡ ${s.name}` })),
];

let boardRoute = null;
/** The table of a route's segment, with its filters. */
export function openBoard(route, segId) {
  if (!on() || !route || route.custom) return;
  boardRoute = route;
  const segs = segmentsOf(route);
  $('lb-title').textContent = route.name;
  $('lb-seg').innerHTML = segs.map((s) => `<option value="${ctx.esc(s.id)}">${ctx.esc(s.name)}</option>`).join('');
  $('lb-seg').value = segId && segs.some((s) => s.id === segId) ? segId : segs[0].id;
  $('lb-view').hidden = false;
  renderBoard();
}

const pick = (id) => $(id).querySelector('.sel')?.dataset.v || '';

async function renderBoard() {
  const route = boardRoute, seg = $('lb-seg').value;
  const body = $('lb-rows');
  body.innerHTML = `<tr><td colspan="7" class="muted">${tr('Loading…')}</td></tr>`;
  $('lb-empty').hidden = true;
  $('lb-cta').hidden = !!currentUser();
  try {
    const b = await leaderboard({ segment: seg, version: versionOf(route), period: pick('lb-period') || 'all', gender: pick('lb-gender') || null, category: pick('lb-cat') || null });
    if (route !== boardRoute || seg !== $('lb-seg').value) return; // another one picked meanwhile
    $('lb-count').textContent = b.total ? tr('{n} riders', { n: b.total }) : '';
    $('lb-empty').hidden = !!b.rows.length;
    const date = (iso) => new Date(iso).toLocaleDateString(ctx.locale, { day: 'numeric', month: 'short' });
    body.innerHTML = withGaps(b.rows).map((r) => (r.gap ? '<tr class="lb-gap"><td colspan="7">⋯</td></tr>'
      : `<tr class="${r.me ? 'me' : ''}"><td>${r.place}</td><td>${flagOf(r.country)}</td><td>${ctx.esc(r.display_name)}${r.flags?.length ? ` <small class="lb-flag" title="${ctx.esc(tr('Unconfirmed: no heart rate, or close to the limit of the possible'))}">?</small>` : ''}</td>`
        + `<td>${ctx.fmtTime(Number(r.time_s))}</td><td>${Number(r.wkg).toFixed(1)}</td><td>${r.avg_hr || '—'}</td><td>${date(r.ridden_at)}</td></tr>`)).join('');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7" class="muted">${ctx.esc(tr('No connection to the tables: {error}', { error: e.message }))}</td></tr>`;
  }
}

/** The lobby: the route's lap (or finish) table at a glance, and a way to all of its tables. */
export async function renderRoute(route = ctx?.currentRoute()) {
  if (!on()) return;
  const box = $('route-board');
  if (!route || route.custom) { box.hidden = true; return; }
  const cached = boards.get(route.id);
  if (cached && Date.now() - cached.at < 60000) { show(cached.html); return; }
  function show(html) {
    if (ctx.currentRoute()?.id !== route.id) return;
    box.innerHTML = html;
    box.hidden = false;
    box.querySelector('[data-board]').onclick = () => openBoard(route);
    const si = box.querySelector('[data-signin]');
    if (si) si.onclick = () => { ctx.track('social', 'sign-in-board'); signIn(redirect()).catch((e) => status(e.message)); };
  }
  try {
    const b = await leaderboard({ segment: `${route.id}-lap`, version: versionOf(route) });
    const lead = b.rows[0], me = b.rows.find((r) => r.me);
    const who = lead && `${flagOf(lead.country)} ${ctx.esc(lead.display_name)} <b>${ctx.fmtTime(Number(lead.time_s))}</b>`;
    const head = lead
      ? (route.oneWay ? tr('🏆 Best finish: {who}', { who }) : tr('🏆 Best lap: {who}', { who }))
      : (route.oneWay ? tr('🏆 No finish times in the table yet: ride it on a trainer to be the first') : tr('🏆 No lap times in the table yet: ride a lap on a trainer to be the first'));
    const html = `<span>${head}${me ? ` · ${tr('yours {time}, {place} of {total}', { time: ctx.fmtTime(Number(me.time_s)), place: me.place, total: b.total })}` : ''}`
      + `${currentUser() ? '' : ` <button class="link-btn" data-signin>${tr('Sign in so your time is here')}</button>`}</span>`
      + `<button class="pill-btn" data-board>${tr('Leaderboards')}</button>`;
    boards.set(route.id, { at: Date.now(), html });
    show(html);
  } catch { box.hidden = true; }
}

/** A climb or sprint begins: the week's best in my category, fetched for the panel. */
export function socialSegStart(route, climb) {
  if (!on() || route.custom || leaders.has(climb.id)) return;
  leaders.set(climb.id, null);
  leaderboard({ segment: climb.id, version: versionOf(route), period: 'week', category: myCategory(), aroundMe: false })
    .then((b) => { const r = b.rows[0]; leaders.set(climb.id, r ? { time: Number(r.time_s), name: r.display_name } : null); })
    .catch(() => leaders.delete(climb.id));
}

/** « · 👑 3:55 (week, B)» for the climb panel, or ''. */
export function socialSegLeader(climbId) {
  const l = on() && leaders.get(climbId);
  return l ? ` · 👑 ${tr('{time} this week, {cat}', { time: ctx.fmtTime(l.time), cat: myCategory() })}` : '';
}

// ---------- Ratings across Ukraine ----------

const uaCache = new Map(); // filters -> { at, data }, a minute
const uaPick = (id) => $(id).querySelector('.sel')?.dataset.v || '';

/** Oblast against oblast, or rider against rider, by kilometres or climbing. */
export function openUa() {
  if (!on()) return;
  $('ua-view').hidden = false;
  if (profileRow?.region && !$('ua-region').dataset.set) { $('ua-region').value = ''; $('ua-region').dataset.set = '1'; }
  renderUa();
}

async function renderUa() {
  const tab = uaPick('ua-tab') || 'regions', period = uaPick('ua-period') || 'week', metric = uaPick('ua-metric') || 'km';
  const riders = tab === 'riders', region = riders ? $('ua-region').value || null : null, gender = riders ? uaPick('ua-gender') || null : null;
  $('ua-gender').hidden = !riders;
  $('ua-region').hidden = !riders;
  const km = (x) => `${Number(x).toLocaleString(ctx.locale, { maximumFractionDigits: 0 })} ${tr('km')}`;
  const up = (x) => `${Number(x).toLocaleString(ctx.locale)} ${tr('m')}`;
  $('ua-head').innerHTML = riders
    ? `<tr><th>#</th><th>${tr('Rider')}</th><th>${tr('Kilometres')}</th><th>${tr('Climbing')}</th><th>${tr('Rides')}</th></tr>`
    : `<tr><th>#</th><th>${tr('Oblast')}</th><th>${tr('Kilometres')}</th><th>${tr('Climbing')}</th><th>${tr('Riders')}</th></tr>`;
  const body = $('ua-rows');
  body.innerHTML = `<tr><td colspan="5" class="muted">${tr('Loading…')}</td></tr>`;
  $('ua-empty').hidden = true;
  // who is not on the board yet, and why
  const u = currentUser();
  $('ua-cta').hidden = !!(u && profileRow?.region);
  $('ua-cta').innerHTML = !u ? `<button class="pill-btn" data-ua-signin>${tr('Sign in with Google')}</button> ${tr('to put your kilometres on the board of your oblast')}`
    : `<button class="link-btn" data-ua-setup>${tr('Pick your oblast')}</button> ${tr('to ride for it')}`;
  const si = $('ua-cta').querySelector('[data-ua-signin]'), su = $('ua-cta').querySelector('[data-ua-setup]');
  if (si) si.onclick = () => signIn(redirect()).catch((e) => status(e.message));
  if (su) su.onclick = () => openSetup();
  const key = [tab, period, metric, region, gender, u?.id].join('|');
  try {
    let hit = uaCache.get(key);
    if (!hit || Date.now() - hit.at > 60000) {
      hit = { at: Date.now(), data: riders ? await riderBoard({ period, metric, region, gender }) : await regionBoard({ period, metric }) };
      uaCache.set(key, hit);
    }
    if (key !== [uaPick('ua-tab') || 'regions', uaPick('ua-period') || 'week', uaPick('ua-metric') || 'km', riders ? $('ua-region').value || null : null, riders ? uaPick('ua-gender') || null : null, currentUser()?.id].join('|')) return; // another filter picked meanwhile
    const rows = riders ? hit.data.rows : hit.data;
    $('ua-empty').hidden = !!rows.length;
    if (riders) {
      body.innerHTML = withGaps(rows).map((r) => (r.gap ? '<tr class="lb-gap"><td colspan="5">⋯</td></tr>'
        : `<tr class="${r.me ? 'me' : ''}"><td>${r.place}</td><td>${ctx.esc(r.display_name)}${r.region ? ` <small class="muted">${ctx.esc(regionName(r.region, ctx.lang))}</small>` : ''}</td>`
          + `<td class="${metric === 'km' ? 'on' : ''}">${km(r.distance_km)}</td><td class="${metric === 'climb' ? 'on' : ''}">${up(r.climb_m)}</td><td>${r.rides}</td></tr>`)).join('');
    } else {
      const top = Math.max(1, ...rows.map((r) => Number(metric === 'climb' ? r.climb_m : r.distance_km)));
      const mine = profileRow?.region;
      body.innerHTML = rows.map((r) => `<tr class="${r.region === mine ? 'me' : ''}"><td>${r.place}</td>`
        + `<td>${ctx.esc(regionName(r.region, ctx.lang))}<i class="ua-bar" style="width:${Math.max(4, Math.round((Number(metric === 'climb' ? r.climb_m : r.distance_km) / top) * 100))}%"></i></td>`
        + `<td class="${metric === 'km' ? 'on' : ''}">${km(r.distance_km)}</td><td class="${metric === 'climb' ? 'on' : ''}">${up(r.climb_m)}</td><td>${r.riders}</td></tr>`).join('');
    }
  } catch (e) {
    uaCache.delete(key);
    body.innerHTML = `<tr><td colspan="5" class="muted">${ctx.esc(tr('No connection to the tables: {error}', { error: e.message }))}</td></tr>`;
  }
}

// ---------- Group rides (#84) ----------
const GR_PENDING = 'gruppetto.groupOpen';
let grRows = [];
let grFocus = null; // the ride a link opened, shown first and marked
let grTimer = null;

/** Riding a group ride together, or watching it: the live channel (social.js groupLive). */
export const groupChannel = (id, on) => groupLive(id, on);
/** A group race: your finish to the results, and the results (social.js). */
export const groupFinish = (id, result) => finishGroupRace(id, result);
export const groupResults = (id) => groupRaceResults(id);

/** The calendar: what is planned, joining, riding, and a new ride. */
export function openGroups(focus = null) {
  if (!on()) return;
  if (focus) grFocus = focus;
  $('gr-view').hidden = false;
  const u = currentUser();
  $('gr-cta').hidden = !!u;
  $('gr-cta').innerHTML = `<button class="pill-btn" data-gr-signin>${tr('Sign in with Google')}</button> ${tr('to join group rides and set them up')}`;
  $('gr-cta').querySelector('[data-gr-signin]').onclick = () => signIn(redirect()).catch((e) => status(e.message));
  // the form: the routes you can ride together (built in: a GPX of your own is only on your device), from the next hour
  const list = ctx.routes(), cur = ctx.currentRoute();
  $('gr-route').innerHTML = list.map((r) => `<option value="${ctx.esc(r.id)}">${ctx.esc(r.name)}</option>`).join('');
  $('gr-route').value = list.some((r) => r.id === cur?.id) ? cur.id : list[0]?.id || '';
  grLapsShow();
  if (!$('gr-date').value) {
    const t = new Date(Date.now() + 3600e3); t.setMinutes(0, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    $('gr-date').value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
    $('gr-time').value = `${pad(t.getHours())}:00`;
  }
  loadGroups();
  loadLeagues(); // the league select in the form, and the Leagues tab
  clearInterval(grTimer); // the «starts in» and the Ride buttons keep up with the clock while the calendar is open
  grTimer = setInterval(() => { if ($('gr-view').hidden) clearInterval(grTimer); else renderGroups(); }, 15000);
}

/** The laps: for a race on a loop (a point-to-point route is raced once, start to finish). */
function grLapsShow() {
  const r = ctx.routes().find((x) => x.id === $('gr-route').value);
  $('gr-laps-wrap').hidden = $('gr-kind').value !== 'race' || !!r?.oneWay;
  leagueSelect();
}

/** What a ride is, for its row: a race and its laps, or nothing for riding together. */
const raceLabel = (g, route) => (g.kind !== 'race' ? ''
  : (route?.oneWay || !(g.laps > 1) ? `🏁 ${tr('Race')}` : `🏁 ${tr('Race')} · ${tr('{n} laps', { n: g.laps })}`) + (g.league_title ? ` · 🏆 ${g.league_title}` : ''));

async function loadGroups() {
  if (!grRows.length) $('gr-list').innerHTML = `<li class="muted">${tr('Loading…')}</li>`;
  try { grRows = await groupRides(); } catch (e) {
    $('gr-list').innerHTML = `<li class="muted">${ctx.esc(tr('No connection to the tables: {error}', { error: e.message }))}</li>`;
    return;
  }
  renderGroups();
  const f = grFocus && $('gr-list').querySelector(`[data-row="${grFocus}"]`);
  f?.scrollIntoView({ block: 'nearest' });
}

const inTime = (s) => (s < 3600 ? tr('{n} min', { n: Math.max(1, Math.ceil(s / 60)) }) : s < 86400 ? tr('{n} h', { n: Math.round(s / 3600) }) : tr('{n} d', { n: Math.round(s / 86400) }));

function renderGroups() {
  const now = Date.now(), rows = grRows.filter((g) => rideWindow(Date.parse(g.starts_at), now).state !== 'over');
  $('gr-empty').hidden = !!rows.length;
  $('gr-list').innerHTML = rows.map((g) => {
    const w = rideWindow(Date.parse(g.starts_at), now), d = new Date(g.starts_at);
    const route = ctx.routes().find((r) => r.id === g.route_id);
    const day = d.toLocaleDateString(ctx.locale, { weekday: 'short', day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString(ctx.locale, { hour: '2-digit', minute: '2-digit' });
    const state = w.state === 'live' ? `<span class="gr-tag live">${tr('Riding now')}</span>`
      : w.state === 'open' ? `<span class="gr-tag open">${tr('On the line: starts in {t}', { t: inTime(w.in) })}</span>`
        : `<span class="gr-tag">${tr('in {t}', { t: inTime(w.in) })}</span>`;
    const can = route && w.state !== 'later';
    const acts = [
      can ? `<button class="primary gr-ride" data-act="ride" data-id="${g.id}">${tr('Ride now')}</button>`
        : g.joined ? `<button class="pill-btn sel" data-act="leave" data-id="${g.id}" title="${ctx.esc(tr('Leave this ride'))}">✓ ${tr('Going')}</button>`
          : `<button class="pill-btn" data-act="join" data-id="${g.id}">${tr('Join')}</button>`,
      w.state !== 'later' ? `<button class="pill-btn" data-act="watch" data-id="${g.id}" title="${ctx.esc(tr('Watch it live: the riders, their power, the chat'))}">👀 ${tr('Watch')}</button>` : '',
      `<button class="pill-btn gr-icon" data-act="link" data-id="${g.id}" title="${ctx.esc(tr('Copy the link to send it to friends'))}" aria-label="${ctx.esc(tr('Copy the link'))}">🔗</button>`,
      g.mine && w.state === 'later' ? `<button class="link-btn gr-cancel" data-act="cancel" data-id="${g.id}">${tr('Call off')}</button>` : '',
    ].join('');
    return `<li class="gr-row${g.id === grFocus ? ' focus' : ''}${w.state !== 'later' ? ' soon' : ''}" data-row="${g.id}">`
      + `<div class="gr-when"><b>${ctx.esc(time)}</b><small>${ctx.esc(day)}</small></div>`
      + `<div class="gr-what"><b>${ctx.esc(g.title)}</b>${g.kind === 'race' ? `<span class="gr-race">${ctx.esc(raceLabel(g, route))}</span>` : ''}`
      + `<small>${ctx.esc(route?.name || tr('a route this Gruppetto does not have'))} · ${ctx.esc(g.host_name || tr('a rider'))} · 👥 ${g.riders}</small>${state}</div>`
      + `<div class="gr-acts">${acts}</div></li>`;
  }).join('');
}

/** A tap on a ride's button: the link, joining or leaving, calling it off, riding. Signed out: to Google first. */
async function groupAction(ev) {
  const b = ev.target.closest('[data-act]'), g = b && grRows.find((x) => x.id === b.dataset.id);
  if (!g) return;
  const act = b.dataset.act;
  if (act === 'link') {
    const url = `${location.origin}${location.pathname}#group=${g.id}`;
    try { await navigator.clipboard.writeText(url); ctx.toast(tr('Link copied: send it to your friends')); } catch { ctx.toast(url); }
    ctx.track('social', 'group-link');
    return;
  }
  if (act === 'watch') { $('gr-view').hidden = true; watch(g); return; } // open to anyone, a guest too
  if (!currentUser()) { sessionStorage.setItem(GR_PENDING, g.id); signIn(redirect()).catch((e) => status(e.message)); return; }
  if (!profileRow) { openSetup(); return; }
  try {
    if (act === 'join' || act === 'leave') { await joinGroupRide(g.id, act === 'join'); ctx.track('social', `group-${act}`); await loadGroups(); }
    if (act === 'cancel') {
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = tr('Tap again to call it off'); return; }
      await cancelGroupRide(g.id); ctx.track('social', 'group-cancel'); await loadGroups();
    }
    if (act === 'ride') {
      if (!g.joined) await joinGroupRide(g.id, true).catch(() => {});
      $('gr-view').hidden = true;
      ctx.track('social', 'group-ride');
      ctx.startGroupRide({ id: g.id, title: g.title, routeId: g.route_id, startsAt: Date.parse(g.starts_at), kind: g.kind || 'ride', laps: g.laps || 1, me: { id: currentUser().id, name: profileRow.display_name || ctx.settings.name || tr('Rider') } });
    }
  } catch (e) { ctx.toast(e.message); }
}

/** Watch a ride from the calendar (#86): a guest too (reactions); writing in the chat wants an account with a profile. */
function watch(g, follow = null) {
  const route = ctx.routes().find((r) => r.id === g.route_id) || null;
  const u = currentUser();
  ctx.track('social', 'group-watch');
  openWatch({
    ride: g, route, follow, channel: groupChannel, tr, esc: ctx.esc, toast: ctx.toast, track: ctx.track,
    me: u && profileRow ? { id: u.id, name: profileRow.display_name || tr('Spectator') } : null, canChat: !!(u && profileRow),
  });
}
async function watchById(id, follow) {
  try {
    const g = (await groupRides()).find((x) => x.id === id);
    if (!g || rideWindow(Date.parse(g.starts_at), Date.now()).state === 'over') { ctx.toast(tr('This ride is over or was called off')); openGroups(); return; }
    watch(g, follow);
  } catch (e) { ctx.toast(e.message); }
}

async function groupCreate(ev) {
  ev.preventDefault();
  const err = $('gr-err');
  err.hidden = true;
  if (!currentUser()) { signIn(redirect()).catch((e) => status(e.message)); return; }
  if (!profileRow) { openSetup(); return; }
  const startsAt = new Date(`${$('gr-date').value}T${$('gr-time').value}`);
  if (!(startsAt.getTime() > Date.now() - 60e3)) { err.textContent = tr('Pick a time to come'); err.hidden = false; return; }
  $('gr-create').disabled = true;
  try {
    const kind = $('gr-kind').value === 'race' ? 'race' : 'ride';
    const laps = Math.max(1, Math.min(10, Math.round(Number($('gr-laps').value) || 1)));
    const route = ctx.routes().find((x) => x.id === $('gr-route').value);
    const league = kind === 'race' ? chosenLeague() : null;
    const id = await createGroupRide({ title: $('gr-title').value.trim(), routeId: $('gr-route').value, startsAt, kind, laps: route?.oneWay ? 1 : laps, league });
    if (league) loadLeagues(); // its race count
    ctx.track('social', 'group-create');
    $('gr-title').value = '';
    $('gr-new').open = false;
    grFocus = id;
    await loadGroups();
    const url = `${location.origin}${location.pathname}#group=${id}`;
    try { await navigator.clipboard.writeText(url); ctx.toast(tr('Group ride set up. Link copied: send it to your friends')); } catch { ctx.toast(tr('Group ride set up')); }
  } catch (e) { err.textContent = e.message; err.hidden = false; } finally { $('gr-create').disabled = false; }
}

// every country with a flag, by ISO 3166 code
const COUNTRIES = ('AD AE AF AG AI AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FO FR GA GB GD GE GH GI GL GM GN GQ GR GT GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NZ OM PA PE PG PH PK PL PR PS PT PY QA RE RO RS RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TW TZ UA UG US UY UZ VA VC VE VN VU WS XK YE ZA ZM ZW').split(' ');
