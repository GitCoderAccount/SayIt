'use strict';
/* Loaded after core.js — uses its constants and utils. */

/* ── IndexedDB Cache ──────────────────────────────────────────────────── */
class Cache {
  constructor() {
    this._db    = null;
    this._ready = new Promise((res, rej) => {
      const req = indexedDB.open('SayIt', 5);
      req.onupgradeneeded = e => {
        const db  = e.target.result;
        const old = e.oldVersion;
        if (!db.objectStoreNames.contains('posts'))
          db.createObjectStore('posts', { keyPath: 'txHash' });
        if (!db.objectStoreNames.contains('profiles'))
          db.createObjectStore('profiles', { keyPath: 'address' });
        if (!db.objectStoreNames.contains('channels'))
          db.createObjectStore('channels', { keyPath: 'address' });
        if (old < 2 && !db.objectStoreNames.contains('muted'))
          db.createObjectStore('muted', { keyPath: 'address' });
        /* v3: offline post queue — posts saved when tx fails/offline */
        if (old < 3 && !db.objectStoreNames.contains('pending_posts'))
          db.createObjectStore('pending_posts', { keyPath: 'queueId' });
        /* v5: archived LIKE reactions (deep sync) — powers engagement
           analytics. Key = the LIKE tx hash; 'target' indexes the liked
           post. Replies/reposts need no store: they're posts already. */
        if (old < 5 && !db.objectStoreNames.contains('likes')) {
          const ls = db.createObjectStore('likes', { keyPath: 'txHash' });
          ls.createIndex('target', 'target');
        }
        /* v4: channel index on posts — loadCached queries one channel's
           posts directly instead of a full-table scan per channel switch.
           Works for fresh DBs too: stores created above are visible in
           this same upgrade transaction. */
        if (old < 4) {
          try { e.target.transaction.objectStore('posts').createIndex('channel', 'channel'); }
          catch { /* index already exists */ }
        }
        /* v3: full-text search trigram index */
        if (old < 3 && !db.objectStoreNames.contains('search_index'))
          db.createObjectStore('search_index', { keyPath: 'id', autoIncrement: true })
            .createIndex('trigram', 'trigram', { unique: false });
        if (!db.objectStoreNames.contains('migrations')) {
          const ms = db.createObjectStore('migrations', { keyPath: 'version' });
          ms.transaction.oncomplete = () => {
            const tx2 = db.transaction('migrations', 'readwrite');
            tx2.objectStore('migrations').put({ version: 3, ts: Date.now(), note: 'Added pending_posts + search_index' });
          };
        }
      };
      req.onsuccess = () => { this._db = req.result; res(); };
      req.onerror   = () => rej(req.error);
    });
  }
  /* Archived LIKE reactions (deep sync). */
  async saveLikes(rows) {
    if (!rows.length) return;
    await this._ready;
    return new Promise(res => {
      const tx = this._db.transaction('likes', 'readwrite');
      const st = tx.objectStore('likes');
      rows.forEach(r => st.put(r));
      tx.oncomplete = res;
      tx.onerror = res; /* best-effort archive */
    });
  }
  /* target → like count across the whole archive. */
  async likeCounts() {
    await this._ready;
    return new Promise(res => {
      const out = new Map();
      let req;
      try { req = this._db.transaction('likes', 'readonly').objectStore('likes').getAll(); }
      catch { res(out); return; }
      req.onsuccess = () => {
        (req.result || []).forEach(r => out.set(r.target, (out.get(r.target) || 0) + 1));
        res(out);
      };
      req.onerror = () => res(out);
    });
  }
  /* Raw archive rows ({ txHash, target, … }) — lets callers merge the deep-sync
     archive with LIKE txs already in the post cache and dedupe by tx hash, so
     engagement numbers populate without requiring a manual Deep sync. */
  async likeRows() {
    await this._ready;
    return new Promise(res => {
      let req;
      try { req = this._db.transaction('likes', 'readonly').objectStore('likes').getAll(); }
      catch { res([]); return; }
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => res([]);
    });
  }

  /* Row counts per store — powers the Settings storage overview. */
  async storeCounts() {
    await this._ready;
    const names = ['posts', 'profiles', 'channels', 'search_index', 'pending_posts', 'likes'];
    const out = {};
    await Promise.all(names.map(n => new Promise(res => {
      try {
        const req = this._db.transaction(n, 'readonly').objectStore(n).count();
        req.onsuccess = () => { out[n] = req.result; res(); };
        req.onerror   = () => { out[n] = 0; res(); };
      } catch { out[n] = 0; res(); }
    })));
    return out;
  }

  /* O(1) single-post lookup by primary key. */
  async getPost(hash) {
    await this._ready;
    return new Promise((res, rej) => {
      const req = this._db.transaction('posts','readonly').objectStore('posts').get(hash);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => rej(req.error);
    });
  }
  /* Channel-scoped fetch via the v4 index; falls back to a full scan on
     very old DBs where the index doesn't exist yet. */
  async getPostsByChannel(channel) {
    await this._ready;
    return new Promise((res, rej) => {
      const store = this._db.transaction('posts','readonly').objectStore('posts');
      let req;
      try { req = store.index('channel').getAll(channel); }
      catch { req = store.getAll(); }
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  }
  async getPosts(filterFn) {
    await this._ready;
    return new Promise((res, rej) => {
      const req = this._db.transaction('posts','readonly').objectStore('posts').getAll();
      req.onsuccess = () => res((req.result || []).filter(filterFn));
      req.onerror   = () => rej(req.error);
    });
  }
  async savePosts(posts) {
    await this._ready;
    const tx    = this._db.transaction('posts', 'readwrite');
    const store = tx.objectStore('posts');
    posts.forEach(p => store.put(p));
    return new Promise((res) => {
      tx.oncomplete = () => {
        /* Index for search in ONE batched IDB transaction instead of N.
           Was: 100 posts = 100 transactions = ~1s of overhead. */
        /* Search indexing is best-effort, but log failures — a persistently
           failing index silently degrades full-text search to in-memory only. */
        this.indexPostsBatch(posts).catch(err => console.warn('Search indexing failed', err)).then(() => {
          this.pruneSearchIndex().catch(err => console.warn('Search-index prune failed', err));
        });
        res();
      };
      tx.onerror = () => {
        /* Almost always QuotaExceededError — local storage is full. Don't
           hard-reject: the posts are already in memory (and on-chain), so
           persistence is best-effort. Free space by force-pruning old posts
           so the NEXT save can land, and warn the user once. */
        const err = tx.error;
        if (err && err.name === 'QuotaExceededError') {
          if (!this._quotaWarned) {
            this._quotaWarned = true;
            utils.toast?.('Local storage full — clearing old cached posts');
          }
          this.pruneIfStale(3, /*force=*/true).catch(() => {});
        }
        res();
      };
    });
  }
  /* Batched search-index writer. One IDB transaction per call instead of
     one-per-post. Posts are immutable on-chain, so a post only ever needs
     indexing once; polling re-returns the same recent posts every cycle, so
     without a guard we'd append the same trigram rows over and over —
     unbounded duplicate growth that eventually trips pruneSearchIndex and
     silently degrades search. We seed a set of already-indexed txHashes once
     per session (from the existing index) and skip anything in it. */
  async indexPostsBatch(posts) {
    await this._ready;
    if (!this._db.objectStoreNames.contains('search_index')) return;
    if (!this._indexedHashes) {
      this._indexedHashes = await new Promise(res => {
        const out = new Set();
        const req = this._db.transaction('search_index', 'readonly')
          .objectStore('search_index').getAll();
        req.onsuccess = () => { (req.result || []).forEach(r => out.add(r.txHash)); res(out); };
        req.onerror   = () => res(out);
      });
    }
    const writes = [];
    posts.forEach(post => {
      if (!post.txHash || this._indexedHashes.has(post.txHash)) return;
      this._indexedHashes.add(post.txHash);
      const tris = this._trigrams((post.display || '') + ' ' + (post.reporter || ''));
      tris.forEach(tri => writes.push({ trigram: tri, txHash: post.txHash }));
    });
    if (!writes.length) return;
    const tx = this._db.transaction('search_index', 'readwrite');
    const store = tx.objectStore('search_index');
    writes.forEach(w => store.add(w));
    return new Promise(res => { tx.oncomplete = res; tx.onerror = res; });
  }
  async pruneSearchIndex(maxRows = 200000) {
    await this._ready;
    if (!this._db.objectStoreNames.contains('search_index')) return;
    const countReq = this._db.transaction('search_index', 'readonly')
      .objectStore('search_index').count();
    const count = await new Promise(res => { countReq.onsuccess = () => res(countReq.result); });
    if (count <= maxRows) return;
    const toDelete = count - maxRows;
    /* Evict by WHOLE post (txHash) groups, not a raw row count. Each post
       contributes many trigram rows, so deleting an arbitrary number of oldest
       rows would slice through a post — leaving it partially indexed, so it
       matched some search queries but not others (corrupt results). Pass 1
       gathers the txHashes covering the oldest ~toDelete rows; pass 2 deletes
       every row belonging to them (rounding up to whole posts). */
    const victims = await new Promise(res => {
      const set = new Set();
      let seen = 0;
      const req = this._db.transaction('search_index', 'readonly')
        .objectStore('search_index').openCursor();
      req.onsuccess = e => {
        const cur = e.target.result;
        if (!cur || seen >= toDelete) { res(set); return; }
        set.add(cur.value.txHash);
        seen++;
        cur.continue();
      };
      req.onerror = () => res(set);
    });
    if (!victims.size) return;
    return new Promise(res => {
      const tx = this._db.transaction('search_index', 'readwrite');
      tx.oncomplete = () => res();
      tx.onerror    = () => res();
      const req = tx.objectStore('search_index').openCursor();
      req.onsuccess = e => {
        const cur = e.target.result;
        if (!cur) return;
        if (victims.has(cur.value.txHash)) cur.delete();
        cur.continue();
      };
    });
  }

  async getPendingPosts() {
    await this._ready;
    if (!this._db.objectStoreNames.contains('pending_posts')) return [];
    return new Promise((res, rej) => {
      const req = this._db.transaction('pending_posts','readonly')
        .objectStore('pending_posts').getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  }
  async savePendingPost(item) {
    await this._ready;
    if (!this._db.objectStoreNames.contains('pending_posts')) return;
    return new Promise((res, rej) => {
      const req = this._db.transaction('pending_posts','readwrite')
        .objectStore('pending_posts').put(item);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  }
  async deletePendingPost(queueId) {
    await this._ready;
    if (!this._db.objectStoreNames.contains('pending_posts')) return;
    return new Promise((res, rej) => {
      const req = this._db.transaction('pending_posts','readwrite')
        .objectStore('pending_posts').delete(queueId);
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  }
  /* Full-text search via trigram index */
  _trigrams(text) {
    /* Generate all 3-char substrings from lowercase text — the index key type */
    const s = text.toLowerCase().replace(/\s+/g, ' ');
    const tris = new Set();
    for (let i = 0; i <= s.length - 3; i++) tris.add(s.slice(i, i + 3));
    return [...tris];
  }
  async indexPost(post) {
    await this._ready;
    if (!this._db.objectStoreNames.contains('search_index')) return;
    if (!post.txHash) return;
    /* Share indexPostsBatch's already-indexed guard so the one-time backfill
       and the per-fetch indexer never double-index the same post. (When the
       set isn't seeded yet — e.g. backfill on an empty index — this is a
       no-op and the eventual seed picks these rows up from the store.) */
    if (this._indexedHashes?.has(post.txHash)) return;
    const tris = this._trigrams((post.display || '') + ' ' + (post.reporter || ''));
    if (!tris.length) return;
    this._indexedHashes?.add(post.txHash);
    const tx = this._db.transaction('search_index', 'readwrite');
    const store = tx.objectStore('search_index');
    tris.forEach(tri => store.add({ trigram: tri, txHash: post.txHash }));
    return new Promise(res => { tx.oncomplete = res; tx.onerror = res; });
  }
  async searchByText(query, limit = 50) {
    await this._ready;
    if (!this._db.objectStoreNames.contains('search_index')) return [];
    const tris = this._trigrams(query);
    if (!tris.length) return [];
    /* AND-search: find txHashes that appear in ALL trigram result sets */
    const sets = await Promise.all(tris.map(tri => new Promise((res, rej) => {
      const range = IDBKeyRange.only(tri);
      const req   = this._db.transaction('search_index','readonly')
        .objectStore('search_index').index('trigram').getAll(range);
      req.onsuccess = () => res(new Set((req.result || []).map(r => r.txHash)));
      req.onerror   = () => rej(req.error);
    })));
    /* Intersect all sets */
    let result = sets[0];
    for (let i = 1; i < sets.length; i++) {
      result = new Set([...result].filter(h => sets[i].has(h)));
      if (!result.size) break;
    }
    /* Return at most `limit` matching txHashes */
    return [...result].slice(0, limit);
  }
  async getMuted() {
    await this._ready;
    if (!this._db.objectStoreNames.contains('muted')) return [];
    return new Promise((res, rej) => {
      const req = this._db.transaction('muted','readonly')
        .objectStore('muted').getAll();
      req.onsuccess = () => res((req.result || []).map(r => r.address));
      req.onerror   = () => rej(req.error);
    });
  }
  async saveMuted(addresses) {
    await this._ready;
    if (!this._db.objectStoreNames.contains('muted')) return;
    const tx = this._db.transaction('muted', 'readwrite');
    const store = tx.objectStore('muted');
    /* Clear and re-write — muted list is small, full replace is fine */
    store.clear();
    addresses.forEach(addr => store.put({ address: addr.toLowerCase() }));
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
    });
  }
  async getProfile(address) {
    await this._ready;
    return new Promise((res, rej) => {
      const req = this._db.transaction('profiles','readonly').objectStore('profiles').get(address);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror   = () => rej(req.error);
    });
  }
  async saveProfile(data) {
    await this._ready;
    return new Promise((res, rej) => {
      const tx = this._db.transaction('profiles','readwrite');
      tx.objectStore('profiles').put(data);
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    });
  }
  /* All persisted profiles — used to broaden handle search beyond the
     current session's in-memory cache. Resolves to [] on any error. */
  async getAllProfiles() {
    await this._ready;
    return new Promise((res) => {
      const req = this._db.transaction('profiles','readonly').objectStore('profiles').getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => res([]);
    });
  }
  async pruneIfStale(maxAgeDays = 7, force = false) {
    /* Deep sync builds a full local archive — age-pruning posts would
       silently undo it. Skip post pruning while a sync is in progress or
       complete (clearing the post cache in Settings resets this). */
    try {
      const ds = JSON.parse(localStorage.getItem('sayitDeepSync') || 'null');
      if (ds && (ds.done || ds.lastPage > 0)) return;
    } catch { /* corrupt state — prune normally */ }
    const last = parseInt(utils.safeLS.get(PRUNE_KEY, '0'), 10);
    if (!force && Date.now() - last < 86_400_000) return;
    await this._ready;
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    await new Promise((res, rej) => {
      const tx  = this._db.transaction('posts','readwrite');
      const s   = tx.objectStore('posts');
      const req = s.getAll();
      req.onsuccess = () => {
        (req.result || []).filter(p => p.timestamp < cutoff).forEach(p => s.delete(p.txHash));
        tx.oncomplete = () => { utils.safeLS.set(PRUNE_KEY, Date.now().toString()); res(); };
      };
      req.onerror = () => rej(req.error);
    });
  }
  /* ── Channel history store ── */
  async getChannels() {
    await this._ready;
    return new Promise((res, rej) => {
      const req = this._db.transaction('channels','readonly').objectStore('channels').getAll();
      req.onsuccess = () => res((req.result || []).sort((a,b) => (b.lastActivity||'') > (a.lastActivity||'') ? 1 : -1));
      req.onerror   = () => rej(req.error);
    });
  }
  async saveChannel(data) {
    await this._ready;
    return new Promise((res, rej) => {
      const tx = this._db.transaction('channels','readwrite');
      tx.objectStore('channels').put(data);
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    });
  }
  async clearChannels() {
    await this._ready;
    return new Promise((res, rej) => {
      const tx = this._db.transaction('channels','readwrite');
      tx.objectStore('channels').clear();
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    });
  }
  async deleteChannel(address) {
    await this._ready;
    return new Promise((res, rej) => {
      const req = this._db.transaction('channels','readwrite')
        .objectStore('channels').delete(address);
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  }
  async clearAllPosts() {
    await this._ready;
    return new Promise((res, rej) => {
      const tx = this._db.transaction('posts','readwrite');
      tx.objectStore('posts').clear();
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    });
  }

  /* Generic store wipe for the storage manager (likes archive, search
     index). Only whitelisted names — never user-callable with arbitrary
     store names. */
  async clearStore(name) {
    if (!['likes', 'search_index'].includes(name)) return;
    await this._ready;
    return new Promise((res, rej) => {
      const tx = this._db.transaction(name, 'readwrite');
      tx.objectStore(name).clear();
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    });
  }
}
