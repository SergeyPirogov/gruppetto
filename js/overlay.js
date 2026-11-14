// Gruppetto HUD (overlay/, a small Mac app): a see-through panel over everything — a film, the football, a
// full-screen video. While a ride goes, the page sends it the mini window's numbers over a WebSocket on this
// computer (127.0.0.1:47629); nothing leaves the Mac. Without the app nothing happens: one quiet try now and then.

const URL_WS = 'ws://127.0.0.1:47629';
let ws = null, wanted = false, retry = null, onChange = null;

/** Is the Mac app listening right now? */
export const overlayOn = () => ws?.readyState === 1;

/** Start looking for the app (a ride began); `changed(on)` is told when it comes or goes. */
export function overlayStart(changed) {
  wanted = true;
  onChange = changed || null;
  connect();
}

/** The ride ended: let go of the app (it hides its panel a few seconds later). */
export function overlayStop() {
  wanted = false;
  clearTimeout(retry); retry = null;
  try { ws?.close(); } catch { /* gone */ }
  ws = null;
}

function connect() {
  if (!wanted || ws) return;
  try { ws = new WebSocket(URL_WS); } catch { ws = null; schedule(); return; }
  ws.onopen = () => onChange?.(true);
  ws.onclose = () => { const was = ws; ws = null; if (was) onChange?.(false); schedule(); };
  ws.onerror = () => { /* onclose follows */ };
}

function schedule() {
  if (!wanted || retry) return;
  retry = setTimeout(() => { retry = null; connect(); }, 10000); // every 10 s: the app may be opened mid-ride
}

/** The numbers, once a second. */
export function overlaySend(state) {
  if (ws?.readyState === 1) { try { ws.send(JSON.stringify(state)); } catch { /* next second */ } }
}
