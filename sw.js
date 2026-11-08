// Gruppetto offline (#30): the app opens without a network once it has been opened online.
// Code and pages: from the network first (a new version shows up straight away), the saved copy when
// offline. Models, textures and libraries: from the saved copy at once, refreshed in the background.
const CACHE = 'gruppetto-v1';
const SHELL = ['./', 'index.html', 'css/style.css', 'js/app.js', 'logo.svg', 'favicon.svg', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gruppetto-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // intervals.icu and the like: straight through
  const heavy = /\/(assets|vendor|icons)\//.test(url.pathname);
  e.respondWith(heavy ? savedFirst(req, e) : networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' && (await cache.match('index.html'))) || Response.error();
  }
}

async function savedFirst(req, e) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(req);
  const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; });
  if (saved) { e.waitUntil(fresh.catch(() => {})); return saved; }
  return fresh;
}
