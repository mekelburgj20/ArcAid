const CACHE_NAME = 'arcaid-v101';
const STATIC_ASSETS = [];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Navigation requests: network-first with cache fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Static assets (CSS, JS, fonts): cache-first with network fallback
  const url = new URL(request.url);
  const isStaticAsset =
    url.pathname.match(/\.(css|js|woff2?|ttf|eot|png|jpg|svg|webp)$/) ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com';

  if (isStaticAsset) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // All other requests (API calls, etc.): network only
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
      icon: '/arcaid-icon-192.png',
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
