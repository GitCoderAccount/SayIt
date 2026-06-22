'use strict';
/* Guards the service-worker cache-version transition (sw.js).
 *
 * The failure this locks down: a returning visitor's first post-deploy load
 * being served a MIXED-version asset set (e.g. a new app.js paired with stale
 * augmenter files that predate a method's existence) → "this._noteHTML is not
 * a function" → "Startup failed". The fix makes the version switch atomic and
 * all-or-nothing:
 *
 *   - build the new cache FULLY before flipping currentCacheName,
 *   - if any same-origin shell asset can't be fetched, ABORT: discard the
 *     partial new cache and keep the old, known-good cache in place,
 *   - only delete the old cache after a fully successful build.
 *
 * sw.js is loaded into a sandbox with mock self/caches/fetch so the 'message'
 * (CACHE_VER) handler can be driven directly and the resulting CacheStorage
 * state asserted. */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const SW_PATH = path.join(__dirname, '..', '..', 'sw.js');

/* Build a fresh sandbox + load sw.js into it. Returns helpers to drive the
   message handler and inspect cache state. */
function loadSW() {
  const stores = new Map();            // cacheName -> Map(url -> response)
  const failUrls = new Set();          // urls whose fetch should reject
  const posted = [];                   // messages posted to clients

  const makeResponse = url => ({ ok: true, type: 'basic', url, clone() { return this; } });

  const fetchMock = req => {
    const url = typeof req === 'string' ? req : req.url;
    return failUrls.has(url)
      ? Promise.reject(new Error('network fail: ' + url))
      : Promise.resolve(makeResponse(url));
  };

  class MockCache {
    constructor() { this.map = new Map(); }
    /* Transactional, like the real Cache.addAll: rejects and writes NOTHING
       if any request fails. */
    async addAll(requests) {
      const responses = await Promise.all(requests.map(r => fetchMock(r)));
      requests.forEach((r, i) => this.map.set(r.url, responses[i]));
    }
    async add(request) { this.map.set(request.url, await fetchMock(request)); }
  }

  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new MockCache());
      return stores.get(name);
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };

  const listeners = {};
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => {},
    location: { origin: 'https://sayitdefi.com' },
    clients: {
      matchAll: async () => [{ postMessage: m => posted.push(m) }],
      claim: async () => {},
    },
  };

  class Request { constructor(url) { this.url = typeof url === 'string' ? url : url.url; } }

  const sandbox = {
    self, caches, fetch: fetchMock, Request,
    URL, AbortController, setTimeout, clearTimeout,
    console: { ...console, log: () => {}, warn: () => {} }, // quiet expected warnings
  };
  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(sandbox), fs.readFileSync(SW_PATH, 'utf8'))(...Object.values(sandbox));

  /* Fire a CACHE_VER message and resolve once its waitUntil work completes. */
  const sendVer = async ver => {
    const evt = { data: { type: 'CACHE_VER', ver }, waitUntil(p) { this.p = p; } };
    listeners.message(evt);
    await evt.p;            // undefined (no-op) awaits fine
  };

  return { stores, failUrls, posted, sendVer };
}

const cacheName = ver => 'sayitdefi-' + ver;

test('first real version is adopted silently (no NEW_VERSION_READY toast)', async () => {
  const sw = loadSW();
  await sw.sendVer('20260101-1');
  assert.ok(sw.stores.has(cacheName('20260101-1')), 'new cache built');
  assert.ok(!sw.stores.has('sayitdefi-v1'), 'placeholder cache dropped');
  assert.equal(sw.posted.length, 0, 'placeholder→first-version is silent');
});

test('failed upgrade keeps the OLD cache and discards the partial new one', async () => {
  const sw = loadSW();
  await sw.sendVer('20260101-1');                 // establish a known-good version
  sw.posted.length = 0;

  sw.failUrls.add('./notes.js');                  // a shell asset is unreachable
  await sw.sendVer('20260102-1');

  assert.ok(sw.stores.has(cacheName('20260101-1')), 'old cache stays intact');
  assert.ok(!sw.stores.has(cacheName('20260102-1')), 'partial new cache discarded');
  assert.equal(sw.posted.length, 0, 'no version-ready toast on a failed build');
});

test('a failed upgrade still lets a later good upgrade succeed', async () => {
  const sw = loadSW();
  await sw.sendVer('20260101-1');
  sw.failUrls.add('./notes.js');
  await sw.sendVer('20260102-1');                 // fails, stays on 0101
  sw.failUrls.clear();
  sw.posted.length = 0;

  await sw.sendVer('20260103-1');                 // now succeeds
  assert.ok(sw.stores.has(cacheName('20260103-1')), 'new cache built');
  assert.ok(!sw.stores.has(cacheName('20260101-1')), 'old cache deleted after success');
  assert.ok(!sw.stores.has(cacheName('20260102-1')), 'failed-attempt cache gone');
  assert.deepEqual(sw.posted, [{ type: 'NEW_VERSION_READY' }], 'tabs told a new version is ready');
});

test('every same-origin shell asset is fetched into the new cache', async () => {
  const sw = loadSW();
  await sw.sendVer('20260101-1');
  const cache = sw.stores.get(cacheName('20260101-1'));
  // the shell must include the augmenter files whose absence caused the outage
  for (const f of ['./app.js', './notes.js', './explore.js', './index.html']) {
    assert.ok(cache.map.has(f), `${f} cached in the new version`);
  }
});
