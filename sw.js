/* 波波酪梨 · 出貨通知系統  sw.js  v1.9.0
 * 改版時務必更新 CACHE 名稱，否則舊快取不會被淘汰。
 */
const CACHE = 'probro-ship-v1.9.0';

const ASSETS = [
  './', './index.html', './app.js', './manifest.json',
  './icon-192.png', './icon-512.png', './icon-512-maskable.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(ASSETS.map(u => c.add(new Request(u, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isJSZip = url.href.startsWith('https://cdnjs.cloudflare.com/ajax/libs/jszip/');

  // GAS 訂單介面永遠走網路，絕不快取：資料新舊由 App 用 fetchedAt 管理並顯示。
  if (!sameOrigin && !isJSZip) return;

  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) {
      e.waitUntil((async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
        } catch (err) { /* 離線 */ }
      })());
      return cached;
    }
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
      return fresh;
    } catch (err) {
      const fb = await caches.match('./index.html');
      return fb || new Response('離線且沒有快取', { status: 503 });
    }
  })());
});
