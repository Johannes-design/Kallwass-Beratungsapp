/* Service Worker – Bestattungshaus Kallwaß Beratungsapp
 * v2.0.0 – Neuaufbau
 *
 * Grundidee gegenüber v1.3.0:
 *  - Bilder kommen jetzt von der EIGENEN Domain (/img/...) statt von Firebase Storage.
 *    Damit entfallen CORS, Download-Tokens und die komplette IndexedDB-/Blob-URL-Mechanik.
 *  - Es werden NUR noch echte, gültige Antworten gecacht (res.ok). Niemals opaque.
 *    In v1.3.0 wurden die HTTP-402-Fehler als "opaque" für Erfolge gehalten und
 *    dauerhaft einsortiert – der Bild-Cache bestand am Ende aus 83 leeren Hüllen,
 *    die cache-first für immer ausgeliefert wurden.
 *  - Kein automatischer Reload mehr. Eine neue Version meldet sich in der App;
 *    der Nutzer entscheidet, wann geladen wird (nicht mitten im Trauergespräch).
 */

const VERSION = 'v2.1.0';
const CACHE_SHELL  = 'bk-shell-'  + VERSION;
const CACHE_VENDOR = 'bk-vendor-' + VERSION;   // Firebase-SDKs, Google Fonts
const CACHE_IMAGES = 'bk-images';              // bewusst OHNE Version: Bilder überleben App-Updates

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  // Firebase-SDKs und Schriften liegen seit v2.1 lokal. Vorher kamen sie von
  // gstatic.com bzw. fonts.googleapis.com – und weil der Service Worker
  // Antworten fremder Server nicht pruefen kann, landeten sie in keinem Cache.
  // Ohne Netz fehlte damit das Firebase-SDK und die App startete gar nicht.
  './vendor/firebase-app-compat.js',
  './vendor/firebase-auth-compat.js',
  './vendor/firebase-firestore-compat.js',
  './vendor/fonts/schriften.css',
  './vendor/fonts/v19_pe0TMImSLYBIv1o4X1M8ce2xCx3yop4tQpF_MeTm0lfGWVpNn64CL7U8upHZIbMV51Q42ptCp7t1R-s.woff2',
  './vendor/fonts/v19_pe0TMImSLYBIv1o4X1M8ce2xCx3yop4tQpF_MeTm0lfGWVpNn64CL7U8upHZIbMV51Q42ptCp7t7R-tCKQ.woff2',
  './vendor/fonts/v21_co3ZmX5slCNuHLi8bLeY9MK7whWMhyjYrEtGmSq17w.woff2',
  './vendor/fonts/v21_co3ZmX5slCNuHLi8bLeY9MK7whWMhyjYrEtImSo.woff2',
  './vendor/fonts/v21_co3bmX5slCNuHLi8bLeY9MK7whWMhyjYp3tKgS4.woff2',
  './vendor/fonts/v21_co3bmX5slCNuHLi8bLeY9MK7whWMhyjYqXtK.woff2'
];

/* Hosts, deren Antworten NIE in einen Cache gehören (Live-Daten, Auth-Tokens) */
const NEVER_CACHE = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_SHELL);
    // Einzeln statt addAll: ein fehlendes Icon darf nicht die ganze Installation kippen.
    await Promise.all(SHELL_ASSETS.map(async url => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch (e) {
        console.warn('[SW] Shell-Asset übersprungen:', url, e.message);
      }
    }));
    // Kein skipWaiting() – die neue Version wartet, bis der Nutzer zustimmt.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        // Alte versionierte Caches wegräumen. CACHE_IMAGES ist unversioniert und bleibt.
        .filter(k => k.startsWith('bk-') && k !== CACHE_IMAGES && !k.endsWith(VERSION))
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (NEVER_CACHE.some(h => url.hostname.includes(h))) return;

  // Seitenaufrufe: erst Netz (damit Änderungen sofort ankommen), Cache als Rückfall.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, CACHE_SHELL));
    return;
  }

  // Produktbilder aus dem Vercel-Blob-Store – cache-first. Jede Datei bekommt beim
  // Upload einen Zufallssuffix, die URL ist damit unveränderlich und ewig cachebar.
  if (istBildUrl(url)) {
    event.respondWith(cacheFirst(req, CACHE_IMAGES));
    return;
  }

  // Firebase-SDKs und Google Fonts – cache-first, feste Versionen.
  if (url.hostname.includes('gstatic.com') || url.hostname.includes('fonts.googleapis.com')) {
    event.respondWith(cacheFirst(req, CACHE_VENDOR));
    return;
  }

  // Restliche eigene Dateien (CSS/JS/Icons) – cache-first mit Hintergrund-Auffrischung.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, CACHE_SHELL));
    return;
  }
});

/* Produktbild? Entweder aus dem Blob-Store oder – falls später einmal ein
   Rewrite auf die eigene Domain dazukommt – unter /img/ auf dem eigenen Origin. */
function istBildUrl(url) {
  if (url.hostname.endsWith('.public.blob.vercel-storage.com')) return true;
  if (url.origin === self.location.origin && url.pathname.startsWith('/img/')) return true;
  return false;
}

/* --- Strategien -------------------------------------------------------- */

/* Nur echte Treffer cachen. res.ok ist false bei 402/403/404/500,
   und opaque-Antworten (status 0) fallen ebenfalls durch – genau der Bug aus v1.3.0. */
function isCacheable(res) {
  return res && res.ok && res.type !== 'opaque';
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (isCacheable(res)) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'Offline und nicht im Cache' });
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (isCacheable(res)) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = (await cache.match(req)) || (await cache.match('./index.html'));
    if (hit) return hit;
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fetching = fetch(req)
    .then(res => {
      if (isCacheable(res)) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => hit || new Response('', { status: 504 }));
  return hit || fetching;
}

/* --- Nachrichten aus der App ------------------------------------------- */

self.addEventListener('message', event => {
  const msg = event.data || {};

  // Nutzer hat dem Update zugestimmt.
  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // Die App schickt die Liste aller Bild-URLs; wir legen sie fürs Offline-Gespräch an.
  if (msg.type === 'PRECACHE_IMAGES' && Array.isArray(msg.urls)) {
    event.waitUntil(precacheImages(msg.urls, event.source));
    return;
  }

  // Bild-Cache leeren (Verwaltung → Wartung).
  if (msg.type === 'CLEAR_IMAGES') {
    event.waitUntil(
      caches.delete(CACHE_IMAGES).then(() => reply(event.source, { type: 'IMAGES_CLEARED' }))
    );
    return;
  }

  // Statusabfrage: wie viele Bilder liegen offline bereit?
  if (msg.type === 'IMAGE_STATUS') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_IMAGES);
      const keys = await cache.keys();
      reply(event.source, { type: 'IMAGE_STATUS', cached: keys.length });
    })());
  }
});

function reply(client, data) {
  if (client && client.postMessage) client.postMessage(data);
}

async function precacheImages(urls, client) {
  const cache = await caches.open(CACHE_IMAGES);
  const missing = [];
  for (const u of urls) {
    if (!(await cache.match(u))) missing.push(u);
  }

  if (!missing.length) {
    reply(client, { type: 'PRECACHE_DONE', total: 0, ok: 0, failed: 0, alreadyComplete: true });
    return;
  }

  let ok = 0, failed = 0, done = 0;
  const BATCH = 4;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    await Promise.all(batch.map(async u => {
      try {
        const res = await fetch(u, { cache: 'no-cache' });
        if (isCacheable(res)) { await cache.put(u, res.clone()); ok++; }
        else { failed++; console.warn('[SW] Bild nicht cachebar:', u, res.status); }
      } catch (e) {
        failed++;
      }
      done++;
      reply(client, { type: 'PRECACHE_PROGRESS', done, total: missing.length });
    }));
  }
  reply(client, { type: 'PRECACHE_DONE', total: missing.length, ok, failed });
}
