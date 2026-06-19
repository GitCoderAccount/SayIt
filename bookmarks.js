'use strict';
/* bookmarks.js — the Bookmarks screen, split out of app.js. Opening the
   bookmarks view (goBookmarks) and loading the bookmarked posts from the IDB
   cache + filling any missing ones from chain (_loadBookmarksFromCache /
   _fetchMissingBookmarks). The bookmark *action* on a post (toggleBookmark)
   stays in app.js alongside the other post actions (like/repost).

   Boot-order safety (the established constraint): reached only via navigation
   (nav click / keyboard) — never init()'s synchronous prefix.

   Augments SayIt.prototype (defined in app.js); load order is core -> cache ->
   app -> settings -> profile -> polls -> notes -> spaces -> explore -> lists ->
   notifications -> channels -> threads -> bookmarks -> embeds -> dm. Cross-refs
   resolve via the shared scope or the prototype. */
const _BOOKMARKS = class {
  goBookmarks() {
    if (!this.signer) { utils.toast('Connect wallet to view Bookmarks'); return; }
    /* Reset the per-session "tried and failed" set on each open so a transient
       network blip doesn't permanently mark a bookmark as unloadable. */
    this._bkFetchAttempted = new Set();
    this._updateTitle('Bookmarks');
    this._setRoute('/bookmarks');
    this.setNav('nav-bookmarks', null); /* highlights the sidebar Bookmarks item */
    this.state.mode = 'bookmarks';
    this.g('feed-tabs').classList.remove('tabs-sticky');
    const bkUser = this.state.profile.username
      ? '@' + utils.safe(this.state.profile.username)
      : (this.state.signerAddr ? '@' + this.trunc(this.state.signerAddr) : '');
    this._pendingPageHeader = this._makePageHeader({
      title: 'Bookmarks', subtitle: bkUser, noBack: true });
    this.g('compose-area').style.display = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('feed-tabs').style.display    = 'none';
    this.g('loading-more').style.display = 'none';
    const bkHeader = this._applyPageHeader();
    if (this.state.bookmarks.size === 0) {
      this.g('feed').innerHTML = bkHeader + `
        <div class="placeholder-view">
          <span class="ph-icon">🔖</span>
          <h2>No bookmarks yet</h2>
          <p>Save posts by clicking the bookmark icon.</p>
        </div>`;
      return;
    }
    /* Show a loading state immediately, then resolve bookmarks from
       memory + IDB. Avoids the dead "Bookmarks loading…" state when the
       posts aren't in current state.posts. The _bkLoadToken guards against
       two rapid Bookmarks clicks racing to write feed.innerHTML. */
    this.g('feed').innerHTML = bkHeader +
      `<div class="placeholder-view"><div class="spinner" aria-hidden="true" style="margin:0 auto 14px"></div><h2>Loading bookmarks…</h2><p>Pulling from your local cache.</p></div>`;
    this._bkLoadToken = (this._bkLoadToken || 0) + 1;
    this._loadBookmarksFromCache(bkHeader, this._bkLoadToken);
  }

  /* Resolve every bookmark hash against state.posts first, then fall back
     to IDB. Posts found only in IDB are added to _postMap so action menus
     work normally. Bookmarks pointing to chain-only data (never cached)
     are listed as a small placeholder at the end. */
  async _loadBookmarksFromCache(bkHeader, myToken) {
    const wantedHashes = [...this.state.bookmarks];
    const inMemory = new Map();
    this.state.posts.forEach(p => {
      if (this.state.bookmarks.has(p.txHash)) inMemory.set(p.txHash, p);
    });
    /* Look up hashes not in memory from IDB */
    const missing = wantedHashes.filter(h => !inMemory.has(h));
    const fromIDB = new Map();
    if (missing.length) {
      try {
        const cached = await this.cache.getPosts(p => this.state.bookmarks.has(p.txHash));
        cached.forEach(p => { if (!inMemory.has(p.txHash)) fromIDB.set(p.txHash, p); });
      } catch { /* IDB unavailable — skip */ }
    }
    /* Only proceed if (a) the user is still on Bookmarks AND (b) we haven't
       been superseded by a later click. Either condition failing means our
       writes would clobber a more recent state. */
    if (this.state.mode !== 'bookmarks') return;
    if (myToken !== this._bkLoadToken) return;
    /* Combine, sort newest-first by timestamp */
    const all = [...inMemory.values(), ...fromIDB.values()]
      .sort((a, b) => (b._tsMs ??= new Date(b.timestamp).getTime()) - (a._tsMs ??= new Date(a.timestamp).getTime()));
    const stillMissing = wantedHashes.filter(h => !inMemory.has(h) && !fromIDB.has(h));

    if (!all.length && !stillMissing.length) {
      this.g('feed').innerHTML = bkHeader + `
        <div class="placeholder-view">
          <span class="ph-icon">🔖</span>
          <h2>Bookmarks not available</h2>
          <p>The bookmarked posts aren't in your local cache. Visit the original channels to load them.</p>
        </div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    all.forEach(post => {
      this._postMap.set(post.txHash, post);
      const el = document.createElement('div');
      el.className = 'post-item';
      el.dataset.txhash = post.txHash;
      el.innerHTML = this.postHTML(post, false, null);
      frag.appendChild(el);
    });
    this.g('feed').innerHTML = bkHeader;
    this.g('feed').appendChild(frag);
    /* Any bookmark not in local cache: fetch it directly by tx hash from
       chain instead of the old "go visit the channel" dead end. Split into
       not-yet-tried (fetch now) and already-tried-and-failed (genuine dead
       ends) so a permanently-unreachable tx can't loop. */
    if (stillMissing.length) {
      this._bkFetchAttempted ??= new Set();
      const toFetch     = stillMissing.filter(h => !this._bkFetchAttempted.has(h));
      const unfetchable = stillMissing.filter(h =>  this._bkFetchAttempted.has(h));
      if (unfetchable.length) {
        const note = document.createElement('div');
        note.className = 'placeholder-view';
        note.style.cssText = 'padding:24px 16px';
        note.innerHTML = `<p style="font-size:13px;color:var(--muted)">
          ${unfetchable.length} bookmark${unfetchable.length > 1 ? 's' : ''} couldn't be loaded from chain (the transaction may no longer be retrievable).
        </p>`;
        this.g('feed').appendChild(note);
      }
      if (toFetch.length) {
        const loading = document.createElement('div');
        loading.className = 'placeholder-view';
        loading.style.cssText = 'padding:24px 16px';
        loading.innerHTML = `<p style="font-size:13px;color:var(--muted)">
          <span class="spinner sp-sm" aria-hidden="true"></span>Loading ${toFetch.length} more bookmark${toFetch.length > 1 ? 's' : ''} from chain…
        </p>`;
        this.g('feed').appendChild(loading);
        this._fetchMissingBookmarks(toFetch, bkHeader, myToken);
      }
    }
  }

  /* Fetch bookmarked posts that aren't cached locally directly by tx hash,
     persist them to IDB (so they resolve instantly next time), then re-render
     the Bookmarks list. Bounded concurrency keeps API load modest. Hashes are
     marked attempted up front so a second pass won't re-fetch failures. */
  async _fetchMissingBookmarks(hashes, bkHeader, myToken) {
    this._bkFetchAttempted ??= new Set();
    const queue   = [...hashes];
    const fetched = [];
    const worker  = async () => {
      while (queue.length) {
        const h = queue.shift();
        this._bkFetchAttempted.add(h);
        const post = await this._fetchTxByHash(h);
        if (post && this.state.bookmarks.has(post.txHash)) fetched.push(post);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, hashes.length) }, worker));
    /* Bail if the user navigated away or a newer Bookmarks load superseded us. */
    if (this.state.mode !== 'bookmarks' || myToken !== this._bkLoadToken) return;
    if (fetched.length) {
      try { await this.cache.savePosts(fetched); } catch { /* IDB full/unavailable */ }
    }
    /* Re-resolve from memory + IDB: successes now come from cache; failures
       are in _bkFetchAttempted so they render as dead ends without looping. */
    this._loadBookmarksFromCache(bkHeader, myToken);
  }
};
for (const k of Object.getOwnPropertyNames(_BOOKMARKS.prototype)) {
  if (k !== 'constructor') SayIt.prototype[k] = _BOOKMARKS.prototype[k];
}
