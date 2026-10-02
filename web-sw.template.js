// Offline cache for the app shell. No skipWaiting on purpose: a new version waits until old tabs close,
// so an open page never mixes old main.js with a new worker.js.
const CACHE = 'audio-fit-__BUILD__';
const FILES = __FILES__;
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('audio-fit-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // never touch cross-origin requests
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
