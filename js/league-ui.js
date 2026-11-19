// Leagues (#84, part 2) in the group rides' window: the Leagues tab (the list, a league's standings and races, a
// new league), and the league select in the new ride's form. social-ui.js hands over what it owns through `h`.
import { leagues, createLeague, leagueStandings, leagueRaces } from './social.js';
import { splitRaces, placed } from './league.js';

let h = null;      // { ctx, signedIn(), hasProfile(), needAccount(), openRide(id) }
let rows = [];     // the leagues, as last loaded
let mine = [];     // yours, for the new race's select
let openId = null; // the league shown, or null for the list
const $ = (id) => document.getElementById(id);
const tr = (s, v) => h.ctx.tr(s, v);
const esc = (s) => h.ctx.esc(s);

export function initLeagues(handles) {
  h = handles;
  $('gr-tabs').onclick = (ev) => { const b = ev.target.closest('[data-gr-tab]'); if (b) showTab(b.dataset.grTab); };
  $('gr-lg-list').onclick = (ev) => { const b = ev.target.closest('[data-lg]'); if (b) openLeague(b.dataset.lg); };
  $('gr-lg-back').onclick = () => { openId = null; render(); };
  $('gr-lg-form').onsubmit = create;
  $('gr-lg-races').onclick = (ev) => { const b = ev.target.closest('[data-ride]'); if (b) { showTab('cal'); h.openRide(b.dataset.ride); } };
}

/** The calendar (cal) or the leagues (lg). */
export function showTab(t) {
  for (const b of $('gr-tabs').querySelectorAll('[data-gr-tab]')) b.classList.toggle('sel', b.dataset.grTab === t);
  $('gr-cal').hidden = t !== 'cal';
  $('gr-lg').hidden = t !== 'lg';
  if (t === 'lg') { h.ctx.track('social', 'league-list'); load(); }
}

/** The leagues again (also for the form's select: yours). */
export async function load() {
  try { rows = await leagues(); } catch (e) {
    if (!$('gr-lg').hidden) $('gr-lg-list').innerHTML = `<li class="muted">${esc(tr('Could not reach the leaderboards: {error}', { error: e.message }))}</li>`;
    return;
  }
  mine = rows.filter((l) => l.mine);
  leagueSelect();
  render();
}

/** The new ride's league select: shown for a race when you have a league of your own. */
export function leagueSelect() {
  const wrap = $('gr-league-wrap'), sel = $('gr-league');
  if (!wrap) return;
  const was = sel.value;
  sel.innerHTML = `<option value="">${esc(tr('No league'))}</option>` + mine.map((l) => `<option value="${esc(l.id)}">🏆 ${esc(l.title)}</option>`).join('');
  if (mine.some((l) => l.id === was)) sel.value = was;
  wrap.hidden = $('gr-kind').value !== 'race' || !mine.length;
}

/** The league picked for the new race, or null. */
export const chosenLeague = () => ($('gr-league-wrap')?.hidden ? null : $('gr-league').value || null);

const when = (iso) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString(h.ctx.locale, { weekday: 'short', day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(h.ctx.locale, { hour: '2-digit', minute: '2-digit' })}`;
};

function render() {
  $('gr-lg-home').hidden = !!openId;
  $('gr-lg-one').hidden = !openId;
  if (openId) return;
  $('gr-lg-empty').hidden = !!rows.length;
  $('gr-lg-list').innerHTML = rows.map((l) => `<li class="gr-row gr-lg-row" data-lg="${esc(l.id)}" role="button" tabindex="0">`
    + `<div class="gr-when"><b>🏆</b></div>`
    + `<div class="gr-what"><b>${esc(l.title)}</b><small>${esc(l.host_name || tr('a rider'))} · ${esc(tr('{n} races', { n: l.races }))}`
    + `${l.next_at ? ` · ${esc(tr('next {t}', { t: when(l.next_at) }))}` : ''}</small></div>`
    + `<div class="gr-acts"><span class="pill-btn">${esc(tr('Standings'))}</span></div></li>`).join('');
}

async function openLeague(id) {
  openId = id;
  const l = rows.find((x) => x.id === id);
  $('gr-lg-name').textContent = l ? `🏆 ${l.title}` : '';
  $('gr-lg-rows').innerHTML = `<tr><td colspan="5" class="muted">${esc(tr('Loading…'))}</td></tr>`;
  $('gr-lg-races').innerHTML = '';
  $('gr-lg-none').hidden = true;
  render();
  h.ctx.track('social', 'league-open');
  let st, races;
  try { [st, races] = await Promise.all([leagueStandings(id), leagueRaces(id)]); } catch (e) {
    $('gr-lg-rows').innerHTML = `<tr><td colspan="5" class="muted">${esc(tr('Could not reach the leaderboards: {error}', { error: e.message }))}</td></tr>`;
    return;
  }
  if (openId !== id) return;
  $('gr-lg-none').hidden = !!st.length;
  $('gr-lg-rows').innerHTML = placed(st).map((r) => `<tr class="${r.me ? 'me' : ''}"><td>${r.place}</td><td>${esc(r.name || tr('a rider'))}</td>`
    + `<td>${r.points}</td><td>${r.races}</td><td>${r.wins || ''}</td></tr>`).join('');
  const { done, next } = splitRaces(races, Date.now());
  const item = (r, past) => `<li><span class="gr-lg-when">${esc(when(r.starts_at))}</span> <b>${esc(r.title)}</b>`
    + (past ? ` <small>${esc(tr('{n} finished', { n: r.finishers }))}</small>` : ` <button class="link-btn" data-ride="${esc(r.id)}">${esc(tr('In the calendar'))}</button>`) + '</li>';
  $('gr-lg-races').innerHTML = [...done.map((r) => item(r, true)), ...next.map((r) => item(r, false))].join('')
    || `<li class="muted">${esc(tr('No races in this league yet'))}</li>`;
}

async function create(ev) {
  ev.preventDefault();
  const err = $('gr-lg-err');
  err.hidden = true;
  if (!h.signedIn() || !h.hasProfile()) { h.needAccount(); return; }
  $('gr-lg-create').disabled = true;
  try {
    const id = await createLeague($('gr-lg-title').value.trim());
    h.ctx.track('social', 'league-create');
    $('gr-lg-title').value = '';
    $('gr-lg-new').open = false;
    await load();
    h.ctx.toast(tr('League created. Now schedule a race in the calendar and choose this league'));
    openLeague(id);
  } catch (e) { err.textContent = e.message; err.hidden = false; } finally { $('gr-lg-create').disabled = false; }
}
