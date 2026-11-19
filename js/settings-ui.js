// Settings drawn as buttons: every <select data-seg> in the page gets a row of buttons over it (segments),
// cards with a small picture (data-seg="cards"), a grid of tiles (data-seg="tiles") or − / + (data-seg="step").
// The select stays, hidden: the app reads and sets its value and listens to it as before. A click sets the
// value and fires input and change; a value set in code (a camera key in the ride) shows on the buttons too.

const ART = {
  'f-style': {
    cartoon: '<svg viewBox="0 0 120 50" preserveAspectRatio="none"><rect width="120" height="50" rx="6" fill="#8cc4ec"/><path d="M0 34 L30 22 L60 30 L90 18 L120 28 V50 H0Z" fill="#6aa656"/><path d="M50 50 L58 30 H62 L70 50Z" fill="#3c4046"/><circle cx="60" cy="40" r="4" fill="#14b8a6"/></svg>',
    pixel: '<svg viewBox="0 0 120 50" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="120" height="50" fill="#5a8fd0"/><path d="M0 34 H20 V26 H40 V30 H60 V20 H80 V26 H100 V22 H120 V50 H0Z" fill="#4e8a3c"/><path d="M54 50 V34 H66 V50Z" fill="#3c4046"/><rect x="56" y="36" width="8" height="8" fill="#14b8a6"/></svg>',
  },
  'f-hud-layout': {
    a: '<svg viewBox="0 0 120 64" preserveAspectRatio="none"><rect width="120" height="64" rx="6" fill="#4a6a52"/><rect x="5" y="5" width="26" height="26" rx="3" fill="#121824"/><rect x="42" y="5" width="36" height="9" rx="3" fill="#121824"/><rect x="89" y="5" width="26" height="18" rx="3" fill="#121824"/><rect x="5" y="52" width="110" height="7" rx="2" fill="#121824"/></svg>',
    b: '<svg viewBox="0 0 120 64" preserveAspectRatio="none"><rect width="120" height="64" rx="6" fill="#4a6a52"/><rect x="89" y="5" width="26" height="18" rx="3" fill="#121824"/><rect x="5" y="38" width="110" height="6" rx="2" fill="#2f8f4e"/><rect x="5" y="47" width="110" height="12" rx="3" fill="#121824"/></svg>',
  },
  'f-summary-layout': {
    a: '<svg viewBox="0 0 120 64" preserveAspectRatio="none"><rect width="120" height="64" rx="6" fill="#0b1019"/><rect x="6" y="6" width="25" height="12" rx="3" fill="#1b2740"/><rect x="34" y="6" width="25" height="12" rx="3" fill="#1b2740"/><rect x="62" y="6" width="25" height="12" rx="3" fill="#1b2740"/><rect x="90" y="6" width="24" height="12" rx="3" fill="#1b2740"/><rect x="6" y="22" width="108" height="20" rx="3" fill="#182030"/><rect x="6" y="46" width="108" height="12" rx="3" fill="#182030"/></svg>',
    b: '<svg viewBox="0 0 120 64" preserveAspectRatio="none"><rect width="120" height="64" rx="6" fill="#0b1019"/><rect x="6" y="6" width="108" height="22" rx="4" fill="#2a1c12" stroke="#6a3a14"/><rect x="12" y="11" width="24" height="12" rx="2" fill="#ffc233"/><rect x="70" y="14" width="38" height="6" rx="2" fill="#e8edf5" opacity=".7"/><rect x="6" y="32" width="108" height="12" rx="3" fill="#182030"/><rect x="6" y="48" width="52" height="11" rx="3" fill="#182030"/><rect x="62" y="48" width="52" height="11" rx="3" fill="#182030"/></svg>',
  },
};

const VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function pick(sel, value) {
  if (sel.value === value) return;
  sel.value = value;
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Draws one select's buttons again from its options and value. */
function render(sel, box, tr) {
  const kind = sel.dataset.seg || 'seg';
  const opts = [...sel.options];
  const label = (o) => esc(o.dataset.short ? tr(o.dataset.short) : o.textContent.trim());
  if (kind === 'step') {
    const i = sel.selectedIndex;
    box.innerHTML = `<button type="button" data-step="-1" aria-label="${esc(tr('Fewer'))}" ${i <= 0 ? 'disabled' : ''}>−</button>`
      + `<b>${label(opts[i] || opts[0])}</b>`
      + `<button type="button" data-step="1" aria-label="${esc(tr('More'))}" ${i >= opts.length - 1 ? 'disabled' : ''}>+</button>`;
    return;
  }
  box.innerHTML = opts.map((o) => {
    const on = o.value === sel.value;
    const art = kind === 'cards' ? ART[sel.id]?.[o.value] || '' : '';
    const key = kind === 'tiles' && o.dataset.key ? `<i>${esc(o.dataset.key)}</i>` : '';
    return `<button type="button" role="radio" aria-checked="${on}" data-v="${esc(o.value)}" title="${esc(o.textContent.trim())}">${art}${key}<span>${label(o)}</span></button>`;
  }).join('');
}

/** Turns one select into buttons; safe to call again (it only redraws). */
export function segmentSelect(sel, tr = (s) => s) {
  if (sel._seg) { render(sel, sel._seg, tr); return sel._seg; }
  const box = document.createElement('div');
  box.className = `seg seg-${sel.dataset.seg || 'seg'}`;
  box.setAttribute('role', sel.dataset.seg === 'step' ? 'group' : 'radiogroup');
  const name = sel.getAttribute('aria-label') || sel.closest('label')?.querySelector('span')?.textContent;
  if (name) box.setAttribute('aria-label', name.trim());
  sel.after(box);
  sel.classList.add('seg-src');
  sel._seg = box;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    e.preventDefault(); // inside a <label>: no click passed on to the select
    if (b.dataset.step) {
      const o = sel.options[Math.max(0, Math.min(sel.options.length - 1, sel.selectedIndex + Number(b.dataset.step)))];
      if (o) pick(sel, o.value);
    } else pick(sel, b.dataset.v);
  });
  // a value set in code shows on the buttons
  Object.defineProperty(sel, 'value', {
    configurable: true,
    get() { return VALUE.get.call(this); },
    set(v) { VALUE.set.call(this, v); if (this._seg) render(this, this._seg, tr); },
  });
  sel.addEventListener('change', () => render(sel, box, tr));
  render(sel, box, tr);
  return box;
}

/** Every select[data-seg] under `root`, drawn (again). */
export function segmentAll(root, tr) {
  for (const sel of root.querySelectorAll('select[data-seg]')) segmentSelect(sel, tr);
}
