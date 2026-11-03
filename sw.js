// Service Worker: hält die App-Dateien offline vor (Netzwerk zuerst, sonst Cache).
// Kartenkacheln und Geocodierung werden nicht gecacht.
const CACHE = 'cominghome-v4';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg',
  'icon-192.png', 'icon-512.png', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
