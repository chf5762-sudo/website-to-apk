const CACHE_NAME = 'webdav-ppt-v2';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './remote.html',
  './manifest.json',
  './manifest-remote.json',
  './icon.png',
  './icon-192.png',
  './apple-touch-icon.png',
  'https://unpkg.com/mqtt@5.3.4/dist/mqtt.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[ServiceWorker] Pre-caching offline assets');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(keyList.map((key) => {
        if (key !== CACHE_NAME) {
          console.log('[ServiceWorker] Removing old cache', key);
          return caches.delete(key);
        }
      }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') {
    // Return cached assets or fetch from network (Network Falling back to Cache strategy could be better for dynamic content, but for static assets Cache First is fine)
    // However, our app relies on live API data for file lists.
    // Let's use Stale-While-Revalidate for static assets, and Network Only for API calls.
    return; 
  }
  
  event.respondWith(
    fetch(event.request)
      .catch(() => {
        return caches.open(CACHE_NAME)
          .then((cache) => {
            return cache.match(event.request);
            // .then(response => response || caches.match('./index.html')); // Fallback to index?
          });
      })
  );
});
