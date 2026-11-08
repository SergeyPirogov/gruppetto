// Full second-by-second records of recent rides, in IndexedDB (too big for localStorage): an older
// ride can still be downloaded as .FIT/.TCX or sent to intervals.icu. The latest KEEP rides are kept.
const DB = 'gruppetto', STORE = 'rides', KEEP = 50;

let dbp = null;
function open() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return dbp ||= new Promise((resolve) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null); // private mode or blocked: rides simply aren't kept
  });
}

function run(mode, fn) {
  return open().then((db) => (db ? new Promise((resolve) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
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
