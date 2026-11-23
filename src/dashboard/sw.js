/**
 * LIU Concierge — Progressive Web App Service Worker
 * 
 * Strict Security Policy:
 * Caches ONLY safe static application shell assets (HTML, CSS, icons, manifest).
 * NEVER caches dynamic APIs (/admin/*, /api/*, /webhook, etc.) to ensure
 * live WhatsApp messages, customer data, and auth tokens remain secure.
 */

const CACHE_NAME = 'liu-pwa-v1.0.2';
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon.png',
  '/icons/icon.svg'
];

// Install: Pre-cache static app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Pre-caching partial failure, proceeding:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate: Clean up old cache versions and claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event handler
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. NEVER cache sensitive dynamic APIs or webhooks
  if (
    url.pathname.startsWith('/admin') ||
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/webhook') ||
    url.pathname.startsWith('/simulate') ||
    url.pathname.startsWith('/health') ||
    event.request.method !== 'GET'
  ) {
    // Network-only for live APIs
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(
          JSON.stringify({
            error: 'Network offline. Cannot sync live WhatsApp messages or server state.',
            offline: true
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      })
    );
    return;
  }

  // 2. Navigation requests: Network-first falling back to cached app shell
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // If valid response, update cache
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Fall back to cached app shell
          return caches.match('/') || caches.match('/dashboard/');
        })
    );
    return;
  }

  // 3. Static assets: Cache-first, then network update
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cached and refresh in background
        fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
            }
          })
          .catch(() => {});
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.ok) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      });
    })
  );
});
