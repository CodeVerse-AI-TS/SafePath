/* SafePath service worker.
 *
 * Strategy: NETWORK-FIRST for everything it handles, with the cache used only
 * as an offline fallback.
 *
 * That is a deliberate choice. SafePath shows safety information, so a stale
 * page is worse than a slow one: a user must never be shown yesterday's risk
 * score or a route that has since changed. Network-first also means a code
 * deploy is picked up on the next load, with no "clear your cache" step.
 *
 * The cache therefore exists for one purpose only: to let the app open and
 * show the last known view when the device is offline.
 *
 * Never cached: /api/* responses (live data), and anything that is not a
 * same-origin GET.
 */

const VERSION = 'safepath-v1';
const SHELL_CACHE = `${VERSION}-shell`;

// Small precache so a cold offline start has something to show. Kept to the
// app shell; everything else is cached on first successful fetch.
const PRECACHE = [
  '/',
  '/styles.css',
  '/app.js',
  '/nav.js',
  '/nav_math.js',
  '/autocomplete.js',
  '/select.js',
  '/auth.js',
  '/auth-ui.js',
  '/firebase-config.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Individually, so one missing file cannot fail the whole install.
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch {
        // A file that is missing now will be cached on first real request.
      }
    }));
    // Take over as soon as possible.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from older versions of this worker.
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('safepath-') && n !== SHELL_CACHE).map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/** Should this request be handled at all? */
function isCacheable(request) {
  if (request.method !== 'GET') return false;

  const url = new URL(request.url);

  // Same-origin only. Third-party responses (map tiles, Firebase modules) are
  // left to the browser's own HTTP cache.
  if (url.origin !== self.location.origin) return false;

  // Live data must never be served from the cache.
  if (url.pathname.startsWith('/api/')) return false;

  return true;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheable(request)) return;

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try {
      // Network first: always prefer fresh content when we have a connection.
      const response = await fetch(request);
      if (response && response.ok) {
        // Clone before the body is consumed by the page.
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (err) {
      // Offline, or the network failed: fall back to the last good copy.
      const cached = await cache.match(request);
      if (cached) return cached;

      // A navigation with nothing cached still gets the cached shell, so the
      // user sees the app rather than the browser's offline error.
      if (request.mode === 'navigate') {
        const shell = await cache.match('/');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
