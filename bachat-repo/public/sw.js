/* समूह बचत — Single Unified Service Worker (Offline Cache + Standard Web Push) */
const CACHE = 'samuha-cf-v20';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './logo-group.png',
  './owner-photo.jpg',
  './css/styles.css?v=20',
  './js/db.js?v=20',
  './js/accounting.js?v=20',
  './js/auth.js?v=20',
  './js/ui.js?v=20',
  './js/app.js?v=20'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Never intercept /api/ requests (network only)
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/api/')) {
    return;
  }

  const isSameOrigin = url.origin === self.location.origin;
  const isCodeOrDoc = e.request.mode === 'navigate' || /\.(?:html|js|css|json)$/i.test(url.pathname) || url.pathname.endsWith('/');
  const netReq = (isSameOrigin && isCodeOrDoc) ? new Request(e.request, { cache: 'no-cache' }) : e.request;

  // Network-first for HTML/JS/CSS so updates from GitHub -> Cloudflare arrive immediately on custom domain too
  e.respondWith(
    fetch(netReq)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((cached) => cached || caches.match('./index.html')))
  );
});

// Background Web Push (works even when the app tab is closed)
self.addEventListener('push', (e) => {
  let payload = {};
  try {
    payload = e.data ? e.data.json() : {};
  } catch (err) {
    payload = { title: 'समूह बचत', body: e.data ? e.data.text() : '' };
  }
  const title = payload.title || 'समूह बचत';
  const options = {
    body: payload.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: payload.tag || 'samuha-push',
    renotify: !!payload.renotify,
    requireInteraction: !!payload.requireInteraction,
    data: payload.data || {}
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = (e.notification && e.notification.data) || {};
  const openHealth = !!data.openHealth;
  const targetUrl = data.url || (openHealth ? './?open=health' : './');
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (let i = 0; i < list.length; i++) {
        if (list[i].url && 'focus' in list[i]) {
          if (openHealth && typeof list[i].postMessage === 'function') {
            try { list[i].postMessage({ type: 'OPEN_HEALTH_CHECK' }); } catch (err) {}
          }
          return list[i].focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
