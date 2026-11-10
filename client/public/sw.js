/* TradeOS service worker: app-shell caching + Web Push. Never caches /api (private data). */
const CACHE = 'tradeos-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    // Network first so users always get the latest app; cached shell when offline.
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); return r; }).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    })));
  }
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'TradeOS', body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'TradeOS';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    // tag = server dedupe key: a duplicate delivery replaces instead of stacking.
    tag: data.tag || undefined,
    renotify: false,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/', notificationId: data.notificationId },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || '/', location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) { if (w.url.startsWith(location.origin)) { w.navigate(target); return w.focus(); } }
    return self.clients.openWindow(target);
  }));
});

// The browser rotated the subscription: re-subscribe and tell the server.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const res = await fetch('/api/push/vapid-public-key', { credentials: 'same-origin' });
    const { publicKey } = await res.json();
    const pad = '='.repeat((4 - (publicKey.length % 4)) % 4);
    const raw = atob((publicKey + pad).replace(/-/g, '+').replace(/_/g, '/'));
    const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch('/api/push/subscribe', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-TradeOS-Request': '1' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
  })());
});
