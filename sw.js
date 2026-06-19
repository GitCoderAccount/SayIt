/*
 * Say It DeFi — Service Worker
 * Place this file at the ROOT of your GitHub Pages repo (same directory as index.html).
 *
 * Strategy:
 *   - HTML shell (index.html / navigations): Stale-While-Revalidate. Served
 *     from cache instantly, then refreshed from the network in the background
 *     so the NEXT load is current — freshness no longer depends on the page's
 *     CACHE_VER message firing.
 *   - Other static assets (manifest, icons, ethers.js CDN): Cache-First.
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
  './app.js',
  './core.js',
  './cache.js',
  './embeds.js',
  './dm.js',
  './boot.js',
  './sayit-crypto.js',
  './manifest.json',
  './image1.jpeg',
  './image1.png',
  './title_icon.png',
  /* Ethers.js from CDN — cache it so the app works offline after first load */
  'https://cdnjs.cloudflare.com/ajax/libs/ethers/6.15.0/ethers.umd.min.js',
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
  'https://cdnjs.cloudflare.com/ajax/libs/ethers/6.15.0/',
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

/* ── Activate: recover real cache version, clean up old caches ──────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      /* Recover the real current cache name from existing caches. A fresh
         SW worker starts with currentCacheName = prefix+'v1' (placeholder).
         If we don't recover the real version, the next CACHE_VER message
         from the page looks like a version change and false-fires the
         "new version available" toast on every single reload. */
      const ours = keys.filter(k => k.startsWith(CACHE_NAME_PREFIX));
      if (ours.length && currentCacheName === CACHE_NAME_PREFIX + 'v1') {
        /* Adopt the most recent existing cache as current. There's normally
           just one; if multiple, pick the newest. Compare version segments
           numerically so e.g. '20260530-10' beats '20260530-2' (a plain
           string sort would pick '-2' as larger). */
        const verKey = name => name.slice(CACHE_NAME_PREFIX.length)
          .split(/\D+/).filter(Boolean).map(Number);
        const cmpVer = (a, b) => {
          const ka = verKey(a), kb = verKey(b);
          for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
            const d = (ka[i] || 0) - (kb[i] || 0);
            if (d) return d;
          }
          return 0;
        };
        currentCacheName = ours.slice().sort(cmpVer)[ours.length - 1];
        console.log('[SW] Recovered current cache:', currentCacheName);
      }
      return Promise.all(
        keys
          .filter(k => k.startsWith(CACHE_NAME_PREFIX) && k !== currentCacheName)
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      );
    }).then(() => self.clients.claim())
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
      /* Stale-While-Revalidate for the HTML shell (navigations + index.html).
         Serve the cached shell instantly, but always kick off a background
         refresh so the next load picks up a new deploy — even if the page's
         CACHE_VER handshake never fires. This removes the "stuck on an old
         index.html forever" failure mode. */
      const isShell = request.mode === 'navigate' ||
        (url.origin === self.location.origin &&
         (url.pathname === '/' || url.pathname.endsWith('/') ||
          url.pathname.endsWith('/index.html') || url.pathname === '/index.html'));

      if (isShell) {
        const cached = await cache.match(request, { ignoreSearch: true })
                    || await cache.match('./index.html');
        const networkPromise = fetchWithTimeout(request, 10000).then(fresh => {
          /* Refresh both the request URL and the canonical './index.html'. */
          safeCachePut(cache, request, fresh);
          safeCachePut(cache, new Request('./index.html'), fresh);
          return fresh;
        }).catch(() => null);
        if (cached) {
          /* keep the SW alive long enough to finish the background refresh */
          event.waitUntil(networkPromise);
          return cached;
        }
        return (await networkPromise) || new Response(
          'Offline — please reload when connected.',
          { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }

      /* Cache-First for other static assets (same origin + whitelisted CDN
         paths). Exact-prefix match on CDN URLs avoids accidentally caching a
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
  /* Sanitize ver — strip anything that isn't alphanumeric/dash so a
     compromised page can't poison the cache namespace with path traversal
     or special characters. Reject empty/oversized values too. */
  const rawVer = String(event.data.ver || '');
  const cleanVer = rawVer.replace(/[^A-Za-z0-9\-]/g, '').slice(0, 32);
  if (!cleanVer) return;
  const newCacheName = CACHE_NAME_PREFIX + cleanVer;
  if (newCacheName === currentCacheName) return;

  /* Was the previous version a REAL version, or just the 'v1' startup
     placeholder? If placeholder, this is a first-seen version (or the
     activate handler couldn't recover) — adopt it silently WITHOUT
     showing the "new version available" toast. The toast should only
     appear when a genuinely newer version supersedes a known older one. */
  const wasPlaceholder = currentCacheName === CACHE_NAME_PREFIX + 'v1';

  console.log(`[SW] Cache version changed: ${currentCacheName} -> ${newCacheName}`);
  const oldName = currentCacheName;
  currentCacheName = newCacheName;

  if (wasPlaceholder) {
    /* Silently adopt — pre-cache under the new name, drop the old, no toast. */
    caches.open(newCacheName).then(cache =>
      cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'reload' })))
        .catch(err => console.warn('[SW] Silent adopt pre-fetch partial:', err))
    ).then(() => { if (oldName !== newCacheName) caches.delete(oldName); });
    return;
  }

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
