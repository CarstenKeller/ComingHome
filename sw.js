// Service Worker
// - App-Dateien: Netzwerk zuerst, sonst Cache (offline nutzbar)
// - Kartenkacheln (Esri): Cache zuerst; die App lädt den Bereich um die
//   aktuelle Position vorab (Nachricht "prefetch").
const CACHE = 'cominghome-v21';
const TILE_CACHE = 'cominghome-tiles-v1';
const TILE_HOST = 'server.arcgisonline.com';
const MAX_TILES = 4000; // danach werden die ältesten Kacheln gelöscht

const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg',
  'icon-192.png', 'icon-512.png', 'vendor/leaflet/leaflet.js', 'vendor/leaflet-rotate/leaflet-rotate.js', 'vendor/leaflet/leaflet.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k !== CACHE && k !== TILE_CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isTile = (url) => url.hostname === TILE_HOST && url.pathname.includes('/tile/');

// Kachel mit CORS laden (damit sie sinnvoll gecacht werden kann)
async function fetchTile(urlStr) {
  const res = await fetch(urlStr, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function tileResponse(request) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  try {
    const res = await fetchTile(request.url);
    cache.put(request.url, res.clone());
    return res;
  } catch (_) {
    // z. B. kein CORS: normal (ohne Cache) laden
    return fetch(request);
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (isTile(url)) {
    e.respondWith(tileResponse(e.request));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(
    // HTTP-Cache umgehen (GitHub Pages cacht bis zu 10 Min.), damit
    // Aktualisierungen sofort ankommen
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});

// ---------- Vorabladen ----------
let prefetchRun = 0;
async function prefetch(urls, client) {
  const run = ++prefetchRun;
  const cache = await caches.open(TILE_CACHE);
  let done = 0;
  let loaded = 0;
  let failed = 0;
  const queue = urls.slice();
  async function worker() {
    while (queue.length && run === prefetchRun) {
      const u = queue.shift();
      try {
        if (!(await cache.match(u))) {
          const res = await fetchTile(u);
          await cache.put(u, res);
          loaded++;
        }
      } catch (_) {
        failed++;
      }
      done++;
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  if (run !== prefetchRun) return; // durch neueren Auftrag ersetzt
  // Cache begrenzen (älteste Einträge zuerst)
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
  client?.postMessage({ type: 'prefetch-done', total: urls.length, done, loaded, failed });
}

self.addEventListener('message', (e) => {
  if (e.data?.type === 'prefetch' && Array.isArray(e.data.urls)) {
    e.waitUntil(prefetch(e.data.urls.slice(0, 1500), e.source));
  }
});
