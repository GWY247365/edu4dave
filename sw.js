// Stale-while-revalidate service worker for Math Quiz.
// Bump CACHE when shipping a release that needs old caches purged.
const CACHE = 'mathquiz-v66';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS).catch(() => null))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Is this a request for the app shell (a navigation / the HTML document)?
function isDocument(req, url) {
  return req.mode === 'navigate' || req.destination === 'document' ||
         url.pathname.endsWith('/') || url.pathname.endsWith('.html');
}

// The page compares this against its own APP_VERSION to decide whether an
// "Update ready" chip is warranted — no guessing from lifecycle events.
self.addEventListener('message', (event) => {
  const d = event.data;
  if (!d || d.type !== 'version') return;
  const reply = { type: 'version', version: CACHE };
  if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
  else if (event.source) event.source.postMessage(reply);
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API calls are live data and must never be answered from cache. Before
  // this, the cache-first path below returned the PREVIOUS response to every
  // sync pull, so each device merged a cloud copy one version stale and could
  // push it over another device's newer progress.
  if (url.pathname.startsWith('/api/')) return;

  // The document goes NETWORK-FIRST (cache only as an offline fallback).
  // Cache-first served yesterday's HTML while the new worker activated
  // underneath it, so every post-release open showed stale content plus an
  // "Update ready" chip that could not clear.
  if (isDocument(req, url)) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const networked = fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || networked;
    })
  );
});
