// Full second-by-second records of recent rides, in IndexedDB (too big for localStorage): an older
// ride can still be downloaded as .FIT/.TCX or sent to intervals.icu. The latest KEEP rides are kept.
const DB = 'gruppetto', STORE = 'rides', DRAFTS = 'drafts', ROUTES = 'routes', KEEP = 50;

let dbp = null;
function open() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return dbp ||= new Promise((resolve) => {
    const req = indexedDB.open(DB, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS, { keyPath: 'id' }); // the ride in progress
      if (!db.objectStoreNames.contains(ROUTES)) db.createObjectStore(ROUTES, { keyPath: 'id' }); // the routes imported from GPX
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null); // private mode or blocked: rides simply aren't kept
  });
}

function run(mode, fn, store = STORE) {
  return open().then((db) => (db ? new Promise((resolve) => {
    const tx = db.transaction(store, mode);
    const out = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result ?? null : null);
    tx.onerror = tx.onabort = () => resolve(null);
  }) : null)).catch(() => null);
}

/** Keeps a ride: { id, start (ms), samples, lapStarts }; drops the oldest beyond KEEP. */
export async function putRide(rec) {
  await run('readwrite', (s) => s.put(rec));
  const keys = await run('readonly', (s) => s.getAllKeys());
  if (keys && keys.length > KEEP) {
    const old = keys.sort().slice(0, keys.length - KEEP); // ids are r<timestamp>: sorted = oldest first
    await run('readwrite', (s) => { for (const k of old) s.delete(k); });
  }
}
export const getRide = (id) => run('readonly', (s) => s.get(id));
export const deleteRide = (id) => run('readwrite', (s) => s.delete(id));

// The ride in progress, saved every 30 s: after a closed tab, a reload or a crash it can still be saved.
export const putDraft = (rec) => run('readwrite', (s) => s.put({ ...rec, id: 'current' }), DRAFTS);
export const getDraft = () => run('readonly', (s) => s.get('current'), DRAFTS);
export const deleteDraft = () => run('readwrite', (s) => s.delete('current'), DRAFTS);
/** Another account signs in: the cut-off ride goes aside under its account's name, and that account's comes back. */
export async function swapDraft(from, to) {
  const cur = await getDraft(), back = await run('readonly', (s) => s.get(`owner:${to}`), DRAFTS);
  await run('readwrite', (s) => {
    s.delete('current'); s.delete(`owner:${to}`);
    if (cur) s.put({ ...cur, id: `owner:${from}` });
    if (back) s.put({ ...back, id: 'current' });
  }, DRAFTS);
}

// The routes imported from GPX: { id, owner, def }. A 600 km brevet is about 2 MB, so they live here, not in
// localStorage (5 MB for everything). `owner` is the account whose route it is (null: a guest's, which the first
// account to sign in here takes).
/** All the routes kept on this device, or null when IndexedDB is not there (private mode). */
export const getRoutes = () => run('readonly', (s) => s.getAll(), ROUTES);
/** Keeps one; true when it was written (false: no room, or no IndexedDB). */
export const putRoute = (rec) => run('readwrite', (s) => s.put(rec), ROUTES).then((k) => k !== null);
export const deleteRoute = (id) => run('readwrite', (s) => s.delete(id), ROUTES);
