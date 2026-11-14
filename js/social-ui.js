// Accounts and leaderboards on the page (docs/specs/social-phase1.md): the card in Profile, the first sign-in's
// window, places on the finish screen, the route's table in the lobby, the week's leader on the climb panel and
// the table itself. app.js hands over what it owns (settings, records, levels) through ctx and calls the hooks;
// without a project (social-config.js) init returns at once and none of it shows.
import {
  socialOn, initSocial, currentUser, onUser, signIn, signOut, loadProfile, saveProfile, queueAdd, queued, sendResults, leaderboard, deleteAccount,
} from './social.js';
import { SYNC_FIELDS, profileFields, accountData, mergeData, sameData, categoryOf, routeVersion, withGaps, flagOf } from './social-core.js';

let ctx = null;
let profileRow = null; // my row in profiles, once read
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
}

function status(text) { const el = $('social-status'); if (el) el.textContent = text || ''; }

function buildUi() {
  // the card belongs to the Profile page: shown when that page is (another may be open right now)
  $('social-card').dataset.off = '';
  $('social-card').hidden = !!document.querySelector('[data-panel="profile"]:not(#social-card)')?.hidden;
  $('btn-social-in').onclick = () => { ctx.track('social', 'sign-in'); signIn(redirect()).catch((e) => status(e.message)); };
  $('btn-social-out').onclick = async () => { await signOut(); status(tr('Signed out. Everything stays on this device.')); };
  $('btn-social-edit').onclick = () => openSetup();
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
  b.innerHTML = u ? `🏆 <span>${ctx.esc(profileRow?.display_name || u.email || '')}</span>` : `${GOOGLE_G}<span>${ctx.esc(tr('Sign in with Google'))}</span>`;
  b.title = u ? tr('Your account and leaderboards') : tr('Sign in to put your times in the tables, and to have your profile on every device');
  b.onclick = u ? showAccount : () => { ctx.track('social', 'sign-in-header'); signIn(redirect()).catch((e) => status(e.message)); };
}

/** Profile, at the account card. */
function showAccount() {
  ctx.openDrawer('profile', 'me');
  requestAnimationFrame(() => $('social-card').scrollIntoView({ block: 'start' }));
}

const GOOGLE_G = '<svg viewBox="0 0 48 48" class="g-logo" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

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
}

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
    const merged = mergeData(localData(), row.data);
    apply(merged);
    if (!sameData(merged, row.data)) await saveProfile({ data: merged });
    if (send) await flush();
  })().finally(() => { syncing = null; });
  return syncing;
}

function openSetup({ first = false } = {}) {
  $('ss-name').value = profileRow?.display_name || (ctx.settings.name && ctx.settings.name !== 'Me' ? ctx.settings.name : '') || currentUser()?.user_metadata?.full_name?.slice(0, 24) || '';
  $('ss-country').value = profileRow?.country || '';
  $('ss-gender').value = profileRow?.gender || '';
  $('ss-public').checked = profileRow ? profileRow.public !== false : true;
  $('social-setup').dataset.first = first ? '1' : '';
  $('social-setup').hidden = false;
  $('ss-name').focus();
}

async function saveSetup() {
  const name = $('ss-name').value.trim().slice(0, 24);
  if (!name) { $('ss-name').focus(); return; }
  const fields = { display_name: name, country: $('ss-country').value || null, gender: $('ss-gender').value || null, public: $('ss-public').checked };
  const first = $('social-setup').dataset.first === '1';
  try {
    if (first) fields.data = mergeData(localData(), null);
    profileRow = { ...profileRow, ...(await saveProfile(fields)) };
    $('social-setup').hidden = true;
    renderCard();
    if (first) { status(tr('Your profile is in the account now, on every device you sign in on.')); await flush(); }
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
  syncTimer = setTimeout(() => sync().catch(() => {}), 3000);
}

// ---------- Results ----------

/** The results waiting, sent; their places noted for the finish screen. */
async function flush(items = []) {
  if (!profileRow) { queueAdd(items); return []; } // the first sign-in's window first: the profile must exist
  const answers = await sendResults(items);
  for (const { item, result } of answers) if (result) results.set(`${item.segment_id}|${item.time_s}`, result);
  const saved = answers.filter((a) => a.result?.status === 'saved');
  if (saved.length) { ctx.track('social-submit', saved.length > 9 ? '10+' : String(saved.length)); boards.clear(); leaders.clear(); }
  return answers;
}

/**
 * After a ride (items: its results that may go in the tables). Signed in: they go now (or wait for the
 * network) and the finish screen shows the places; signed out: the finish screen asks you to sign in.
 */
export async function socialAfterRide(items, { firstName, simulated = false, timed = false } = {}) {
  if (!on()) return;
  const cta = $('sum-social');
  cta.hidden = true;
  results = new Map();
  if (!items.length) {
    if (currentUser()) sync().catch(() => {});
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

// every country with a flag, by ISO 3166 code
const COUNTRIES = ('AD AE AF AG AI AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FO FR GA GB GD GE GH GI GL GM GN GQ GR GT GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NZ OM PA PE PG PH PK PL PR PS PT PY QA RE RO RS RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TW TZ UA UG US UY UZ VA VC VE VN VU WS XK YE ZA ZM ZW').split(' ');
