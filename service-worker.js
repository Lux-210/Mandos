const CACHE_NAME = 'mis-dualsense-v5';

const APP_SHELL = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

// Estos dos cambian seguido durante el desarrollo activo: van con estrategia "red primero".
const NETWORK_FIRST = ['./index.html', './manifest.json'];

// Desde que React, ReactDOM y el CSS de Tailwind quedaron incrustados directamente en el HTML,
// la única dependencia externa real que queda es la fuente tipográfica (opcional: si falla,
// el CSS ya tiene familias de respaldo del sistema).
const EXTERNAL_SHELL = [
  'https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,500;0,600;1,500&family=IBM+Plex+Mono:wght@500;600&family=Inter:wght@400;500;600;700&display=swap',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      await Promise.all(
        APP_SHELL.map(url => cache.add(url).catch(() => {}))
      );
      await Promise.all(
        EXTERNAL_SHELL.map(url =>
          fetch(url, { mode: 'no-cors' })
            .then(resp => cache.put(url, resp))
            .catch(() => {})
        )
      );
      self.skipWaiting();
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;
  const isGitHubApiCall = url.indexOf('api.github.com') !== -1 || url.indexOf('githubusercontent.com') !== -1;
  if (isGitHubApiCall) {
    // La sincronización con la nube nunca debe servirse desde el caché.
    event.respondWith(fetch(event.request));
    return;
  }

  const isNavigation = event.request.mode === 'navigate';
  const isOwnAppShell =
    isNavigation ||
    (url.startsWith(self.location.origin) && NETWORK_FIRST.some(shellUrl => url.endsWith(shellUrl.replace('./', ''))));

  if (isOwnAppShell) {
    // Red primero: si estamos online, siempre mostramos la última versión publicada.
    // Si falla la red (offline), servimos la última copia guardada en caché.
    event.respondWith(
      fetch(event.request)
        .then(resp => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Librerías externas (React, Tailwind, fuentes, etc.): caché primero, ya que casi nunca cambian.
  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request)
        .then(resp => {
          if (resp && (resp.ok || resp.type === 'opaque')) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
