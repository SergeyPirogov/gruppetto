// Interface language (#31): English or Ukrainian. English text is the key; a missing translation
// falls back to English. The language is fixed for the page's life: switching saves it and reloads.
import { UK } from './i18n-uk.js';

const KEY = 'gruppetto.lang';
export const LANGS = [{ id: 'en', name: 'English' }, { id: 'uk', name: 'Українська' }];

export const lang = (() => {
  try { const v = localStorage.getItem(KEY); if (v === 'en' || v === 'uk') return v; } catch { /* storage blocked */ }
  return typeof navigator !== 'undefined' && /^uk|^ru-ua/i.test(navigator.language || '') ? 'uk' : 'en';
})();
const dict = lang === 'uk' ? UK : {};

/** Translate `s`; {name} placeholders are filled from `vars`. */
export function t(s, vars) {
  let out = dict[s] ?? s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return out;
}

/** Ukrainian plural: plural(5, ['хвилина', 'хвилини', 'хвилин']) -> 'хвилин'. */
export function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

export function setLang(id) {
  try { localStorage.setItem(KEY, id); } catch { /* storage blocked */ }
  location.reload();
}

export const locale = lang === 'uk' ? 'uk-UA' : 'en-GB';

/** Translate the static page: text nodes whose whole text is a known phrase, and a few attributes. */
export function translateDom(root = document.body) {
  if (lang === 'en') return;
  document.documentElement.lang = lang;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.nodeValue, key = raw.trim().replace(/\s+/g, ' ');
    if (key && dict[key] !== undefined) n.nodeValue = raw.replace(raw.trim(), dict[key]);
  }
  for (const el of root.querySelectorAll('[title],[placeholder],[aria-label]')) {
    for (const a of ['title', 'placeholder', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v && dict[v] !== undefined) el.setAttribute(a, dict[v]);
    }
  }
}
