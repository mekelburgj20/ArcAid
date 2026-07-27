// BUILD_ID is replaced at build time by the `arcaid-sw-build-id` Vite plugin
// (admin-ui/vite.config.ts), which derives it deterministically from the
// built asset filenames + index.html contents (admin-ui/scripts/swBuildId.ts).
// Under `vite dev` this placeholder is served raw (no build step runs), so
// the dev-server cache name is literally `arcaid-static-__ARCAID_BUILD_ID__`
// — harmless, since dev never goes through this build pipeline.
const BUILD_ID = '__ARCAID_BUILD_ID__';
const STATIC_CACHE = `arcaid-static-${BUILD_ID}`; // new name every build — no manual bump, ever
const IMAGE_CACHE = 'arcaid-images-v1'; // stable name — survives deploys, LRU-capped below
const IMAGE_CACHE_MAX_ENTRIES = 200;

// Same-origin path prefixes served from data/ (see src/api/server.ts) — cover
// art, style images, room assets, score photos. Checked BEFORE the static
// asset extension regex so these never leak into STATIC_CACHE.
const IMAGE_PATH_PREFIXES = [
  '/api/catalogue-images/',
  '/api/styles/images/',
  '/api/room-assets/',
  '/api/score-photos/',
];

function isImageRequest(url) {
  return IMAGE_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

const STATIC_ASSET_RE = /\.(css|js|woff2?|ttf|eot|png|jpg|jpeg|svg|webp)$/;

function isStaticAsset(url) {
  if (url.pathname === '/sw.js') return false; // never cache the SW itself
  // Never let an /api/* route fall through to the extension regex below — a
  // JSON endpoint whose final path segment is a user-controlled value (e.g.
  // an iScored username, which encodeURIComponent does NOT strip '.' from)
  // could end in a static-looking extension like ".png" and get cached
  // cache-first forever. isImageRequest() already claims the four image
  // mounts before this function is ever consulted (see the fetch handler
  // below) — this guard covers every other /api/* route.
  if (url.pathname.startsWith('/api/')) return false;
  return (
    url.pathname.startsWith('/assets/') ||
    STATIC_ASSET_RE.test(url.pathname) ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  );
}

// LRU trim: caches.Cache#keys() returns entries in insertion order, so the
// front of the list is the oldest. Called after every put into IMAGE_CACHE.
async function trimImageCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - IMAGE_CACHE_MAX_ENTRIES;
  if (excess <= 0) return;
  for (let i = 0; i < excess; i++) {
    await cache.delete(keys[i]);
  }
}

self.addEventListener('install', () => {
  // No install-time precache — an addAll() failure would block install for
  // no benefit. Static assets populate STATIC_CACHE on first fetch instead.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          // Delete every legacy/stale cache (old `arcaid-v###` generations AND
          // old `arcaid-static-*` generations from prior deploys) but ALWAYS
          // keep the current STATIC_CACHE and the stable IMAGE_CACHE — a naive
          // "delete everything but today's static cache" filter would wipe the
          // image cache on every single deploy.
          .filter((key) => key !== STATIC_CACHE && key !== IMAGE_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Non-GET (POST/PUT/DELETE/...): pass through untouched, never cache.
  if (request.method !== 'GET') {
    event.respondWith(fetch(request));
    return;
  }

  // Navigation requests: network-first with cache fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  const url = new URL(request.url);

  // Image mounts: stale-while-revalidate, LRU-capped at IMAGE_CACHE_MAX_ENTRIES.
  if (isImageRequest(url)) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) {
          event.waitUntil(
            fetch(request)
              .then((response) => {
                if (!response.ok) return;
                return cache.put(request, response).then(() => trimImageCache(cache));
              })
              .catch(() => {})
          );
          return cached;
        }
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(request, response.clone());
          await trimImageCache(cache);
        }
        return response;
      })
    );
    return;
  }

  // Build/static assets: cache-first with network fallback.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else (API calls, unknown): network only.
  event.respondWith(fetch(request));
});

// --- Web push (S15) ---
// Payload shape: { title, body, url, tag } — see WebPushService (backend).

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'ArcAid', {
      body: payload.body || '',
      icon: '/arcaid-icon-192-v3.png',
      tag: payload.tag || undefined,
      data: { url: payload.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/';
  // Normalize via URL so 'https://arcaid.app' vs '.../' and relative
  // fallbacks compare correctly against client.url (always absolute).
  const target = new URL(raw, self.location.origin);
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus an existing same-origin tab (navigating it if it's elsewhere
      // in the app); only open a new window when none exists.
      for (const client of windowClients) {
        if (new URL(client.url).origin !== target.origin) continue;
        const focused = 'focus' in client ? client.focus() : Promise.resolve(client);
        if (client.url !== target.href && 'navigate' in client) {
          return focused.then(() => client.navigate(target.href)).catch(() => {});
        }
        return focused;
      }
      return clients.openWindow(target.href);
    })
  );
});
