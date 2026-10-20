/**
 * Keeps the shell available offline so the app opens instantly and does not show a
 * browser error on a dead connection.
 *
 * Reports themselves are never cached. A civic register showing yesterday's data as
 * if it were current would be worse than showing nothing, so anything under /api goes
 * to the network and fails honestly when there isn't one.
 */
const SHELL = 'civicfix-shell-v1';
const SHELL_FILES = ['/', '/index.html', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;           // tiles, fonts, Google — leave alone
  if (url.pathname.startsWith('/api')) return;               // never serve stale civic data
  if (url.pathname.startsWith('/uploads')) return;           // photos and video are large

  // navigations: try the network, fall back to the cached shell
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(SHELL).then((cache) => cache.put(request, copy));
      }
      return response;
    }))
  );
});
