/*
 * Say It DeFi — Service Worker
 * Place this file at the ROOT of your GitHub Pages repo (same directory as index.html).
 *
 * Strategy:
 *   - Static shell (index.html, ethers.js CDN): Cache-First. Served from cache
 *     instantly on repeat visits. Cache is invalidated by SW_CACHE_VER in index.html.
 *   - API calls (api.scan.pulsechain.com, otter.pulsechain.com): Network-Only.
 *     Never cached — chain data must always be fresh.
 *   - Everything else: Network-First with cache fallback.
 *
 * To force a cache refresh after deploying a new version:
 *   1. Bump SW_CACHE_VER in index.html (e.g. '20260527-2')
 *   2. Push to GitHub. On next page load the SW detects the version mismatch,
 *      deletes the old cache, fetches fresh assets, and notifies the page.
 */

const CACHE_NAME_PREFIX = 'sayitdefi-';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './image1.jpeg',
  /* Ethers.js from CDN — cache it so the app works offline after first load */
  'https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js',
];

/* Domains whose requests should NEVER be cached */
const BYPASS_CACHE_HOSTS = new Set([
  'api.scan.pulsechain.com',
  'otter.pulsechain.com',
  'scan.pulsechain.com',
]);

/* Skip caching cross-origin responses larger than this — prevents the cache
   from growing unbounded when users browse channels with lots of large
   images, videos, or IPFS payloads. Same-origin responses (the app shell)
   are always cached regardless of size. */
const MAX_CACHE_BYTES = 5 * 1024 * 1024; /* 5 MB */

/* Allowed cross-origin host prefixes for static cache. Tight match so a
   future ethers version bump doesn't accidentally cache a different lib. */
const STATIC_CDN_PATHS = [
  'https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/',
];

let currentCacheName = CACHE_NAME_PREFIX + 'v1'; /* overwritten by CACHE_VER message */

/* Fetch with a hard timeout — prevents a hung network from blocking
   indefinitely before falling back to cache. */
function fetchWithTimeout(request, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(request, { signal: ctrl.signal })
    .finally(() => clearTimeout(timer));
}

/* ── Install: pre-cache the shell ───────────────────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(currentCacheName).then(cache =>
      cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'reload' })))
        .catch(err => {
          /* If CDN is unreachable during install, continue without it —
             it will be cached on first network fetch instead. */
          console.warn('[SW] Pre-cache partial failure:', err);
        })
    ).then(() => self.skipWaiting())
  );
});

/* ── Activate: clean up old caches ──────────────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith(CACHE_NAME_PREFIX) && k !== currentCacheName)
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch: serve from cache or network ─────────────────────────────────── */
self.addEventListener('fetch', event => {
  const { request } = event;
  /* Only handle GET requests */
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); }
  catch { return; }

  /* API / chain data — always network, never cache */
  if (BYPASS_CACHE_HOSTS.has(url.hostname)) return;

  /* Blob URLs (SW self-registration fallback) — skip */
  if (url.protocol === 'blob:') return;

  event.respondWith(
    caches.open(currentCacheName).then(async cache => {
      /* Cache-First for static assets (same origin + whitelisted CDN paths).
         Exact-prefix match on CDN URLs avoids accidentally caching a
         different library when the ethers path/version changes. */
      const isStatic = url.origin === self.location.origin ||
        STATIC_CDN_PATHS.some(prefix => url.href.startsWith(prefix));

      if (isStatic) {
        const cached = await cache.match(request);
        if (cached) return cached;
        /* Not in cache yet — fetch and store. 10s timeout prevents a
           hung CDN from blocking the page indefinitely. */
        try {
          const fresh = await fetchWithTimeout(request, 10000);
          safeCachePut(cache, request, fresh);
          return fresh;
        } catch (err) {
          /* Offline and not cached — nothing we can do */
          console.warn('[SW] Fetch failed (offline?):', request.url, err);
          return new Response('Offline — please reload when connected.', {
            status: 503, headers: { 'Content-Type': 'text/plain' }
          });
        }
      }

      /* Network-First for everything else (third-party images, IPFS, etc.).
         10s timeout — if the network is slow, fall back to cache instead
         of hanging. */
      try {
        const fresh = await fetchWithTimeout(request, 10000);
        safeCachePut(cache, request, fresh);
        return fresh;
      } catch {
        const cached = await cache.match(request);
        return cached || new Response('', { status: 503 });
      }
    })
  );
});

/* Safely put a response in the cache. Skips when the response is not
   cacheable: non-2xx status, opaque (status 0), error type, or when the
   request scheme is chrome-extension://, blob://, etc. cache.put would
   otherwise throw a TypeError that we'd silently swallow.

   Also skips cross-origin responses larger than MAX_CACHE_BYTES so the
   cache can't grow unbounded from browsing many image-heavy channels. */
function safeCachePut(cache, request, response) {
  if (!response || !response.ok) return;
  if (response.type === 'opaque' || response.type === 'error') return;
  /* Cache API only supports http(s) schemes */
  if (!request.url.startsWith('http')) return;

  /* Size check — only for cross-origin responses. Same-origin app shell
     files are always cached (typically small). Uses Content-Length when
     present; absence is treated as "unknown, allow" to avoid skipping
     legitimate small responses on servers that don't send the header. */
  const isSameOrigin = (() => {
    try { return new URL(request.url).origin === self.location.origin; }
    catch { return false; }
  })();
  if (!isSameOrigin) {
    const cl = response.headers.get('content-length');
    if (cl && parseInt(cl, 10) > MAX_CACHE_BYTES) return;
  }

  /* Clone first — body can only be consumed once */
  try { cache.put(request, response.clone()); }
  catch (err) { /* TypeError on unsupported request — silent */ }
}

/* ── Message: receive SW_CACHE_VER from the page ────────────────────────── */
self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_VER') return;
  const newCacheName = CACHE_NAME_PREFIX + event.data.ver;
  if (newCacheName === currentCacheName) return;

  console.log(`[SW] Cache version changed: ${currentCacheName} -> ${newCacheName}`);
  const oldName = currentCacheName;
  currentCacheName = newCacheName;

  /* Pre-cache with the new name */
  caches.open(newCacheName).then(cache =>
    cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'reload' })))
      .catch(err => console.warn('[SW] New cache pre-fetch partial failure:', err))
  ).then(() =>
    /* Delete the old cache */
    caches.delete(oldName)
  ).then(() => {
    /* Tell all open tabs that a new version is ready */
    self.clients.matchAll({ includeUncontrolled: true }).then(clients =>
      clients.forEach(c => c.postMessage({ type: 'NEW_VERSION_READY' }))
    );
  });
});
