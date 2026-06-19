'use strict';
/* Loaded after core.js and cache.js (constants, utils, Cache, SpaceRTC). */

/* SW_CACHE_VER: bump this string whenever you deploy a new version (any
   of index.html / app.js / core.js / cache.js / boot.js changing). The
   service worker uses it to invalidate cached files. */
const SW_CACHE_VER = '20260618-239';

/* ── Say It DeFi ────────────────────────────────────────────── */
class SayIt {
  constructor() {
    this.state = {
      posts: [], pending: [], searchTerm: '', activeTag: null,
      loading: false, hasMore: true, nextPage: 1,
      channel: MAIN_CHANNEL, mode: 'main',
      profile: { username:'', picUrl:'image1.jpeg', bio:'' },
      signerAddr: null, expanded: new Set(),
      replyTarget: null, repostTarget: null, threadPost: null, profCache: {},
      /* reactions & social */
      likes:      new Set(),   /* txHashes this user has liked */
      bookmarks:  new Set(),   /* txHashes this user has bookmarked */
      following:  new Set(),   /* addresses this user follows */
      /* muted: loaded from IDB in init() after cache is ready; seeded
         with localStorage fallback for backwards compat. Try/catch guards
         against corrupt localStorage data crashing the entire constructor. */
      muted: (() => {
        try { return new Set(JSON.parse(localStorage.getItem(MUTE_KEY) || '[]')); }
        catch { return new Set(); }
      })(),
      /* Lists & Communities — local, stored in localStorage. Lists are
         {id, name, members:[addr]}; communities are {address, name, desc, joined}. */
      lists: (() => {
        try { return JSON.parse(localStorage.getItem(LISTS_KEY) || '[]'); }
        catch { return []; }
      })(),
      communities: (() => {
        try { return JSON.parse(localStorage.getItem(COMMUNITIES_KEY) || '[]'); }
        catch { return []; }
      })(),
      activeList: null,        /* id of the list currently being viewed */
      /* channel history */
      channelHistory: [],      /* [{address, label, lastActivity, preview, postCount}] */
      /* settings */
      settings: (() => {
        try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
      })(),
    };
    this.signer        = null;
    this.cache         = new Cache();
    this.pollTimer     = null;
    this._profInFlight = 0;
    this._profQueue    = [];
    /* Monotonic token bumped whenever we want to invalidate in-flight fetches
       (channel switch, refresh). The async fetch loop checks this against
       its locally captured token and aborts if they differ. Prevents stale
       fetches from overwriting fresh state. */
    this._fetchToken   = 0;
    this._walletReg    = false;
    this._postMap      = new Map();
    this._postHashSet  = new Set(); /* O(1) dedup — kept in sync with state.posts */
    /* Virtualization state. Posts outside the visible window render as
       placeholders with reserved height; an IntersectionObserver swaps
       them for real .post-item elements as the user scrolls into range. */
    this._vfHeightMap  = new Map(); /* txHash → measured pixel height */
    this._vfMaps       = null;      /* { replyMap, likeMap, repostMap, engagerMap } */
    this._vfObserver   = null;      /* IntersectionObserver instance */
    /* Persistent engagement maps — built from full IDB cache, not just
       state.posts. Without these, counts are limited to what's in memory:
       a post with 1000 likes shows as 50 if only 50 like-txs are loaded.
       Refreshed from IDB on init and on channel switch; updated
       incrementally when new reactions arrive. */
    this._engagement   = { replyMap: new Map(), likeMap: new Map(),
                           repostMap: new Map(), engagerMap: new Map(),
                           /* target → Map(engager → {liked, ts}). Tracks each
                              engager's latest like-state by timestamp so an
                              UNLIKE removes an earlier LIKE from the count,
                              regardless of the order batches arrive in.
                              likeMap is derived from this. */
                           likeState: new Map() };
    this._engagementReady = false;
    /* Poll votes ride in on the same channel scan the feed already does:
       parseTxs/_parsePostTx capture every VOTE tx into _voteAccum instead of
       discarding it, so visible polls tally for free with no per-poll
       re-scan. _voteAccum: pollHash → Map(voter → {optIdx, ts}) (newest-wins
       by ts). Tallies are aggregated on the fly from this by _pollTally. */
    this._voteAccum    = new Map();
    this._pollScanned  = new Map(); /* pollHash → ts of last cold-scan fallback */
    this._pollScanning = new Set(); /* poll hashes with an in-flight cold scan */
    this._myVotes      = new Map(); /* pollHash → optIdx the user has voted (session) */
    this._pollEndMs    = new Map(); /* pollHash → endMs; gates out post-close votes */
    /* Community Notes: per-post note data, scan throttle, session ratings,
       and which posts have their pending-note panel expanded. */
    this._noteData      = new Map(); /* postHash → { notes:[…], scannedAt } */
    this._noteScanning  = new Set(); /* channels with an in-flight note scan */
    this._noteScanAt    = new Map(); /* channel → last scan timestamp */
    this._myNoteRatings = new Map(); /* noteHash → 'h'|'n' (session, optimistic) */
    this._expandedNotes = new Set(); /* postHashes whose pending notes are shown */
    this._navToken     = 0;         /* bumped on every navigation; async view
                                       renders check it before painting #feed */
    /* Tab title + favicon badge state. _titleSuffix is the per-view label
       (Home, Notifications, etc.); _unreadCount drives the (N) prefix and
       the favicon dot. Both compose in _updateTitle / _updateFavicon. */
    this._titleSuffix  = '';
    this._unreadCount  = 0;
    this._faviconBase  = null;   /* cached base favicon image */
    this._vfEstHeight  = 200;       /* default estimate per post */
    this._vfMountedRef = new WeakMap(); /* element → post reference */
    this.g             = id => document.getElementById(id);
    /* Profile-triggered re-renders: instead of rebuilding the entire feed,
       patch only the avatar+name elements for the address that just loaded.
       Full re-renders still happen for structural changes (new posts, filters). */
    this._debouncedRender = utils.debounce(() => this._patchProfilesInFeed(), 120);
    this._draftSave       = utils.debounce(() => this._saveDraft(), 500);
    /* Persisted SPACE_END markers: { spaceTxHash → senderAddr }. Loaded into a
       Map so ended Spaces stay ended across reloads (otherwise an ended card
       flickers back to "live" until a chain scan happens to re-parse the end
       tx). Lowercased on the way in. */
    this._spaceEnds = (() => {
      const m = new Map();
      try {
        const obj = JSON.parse(utils.safeLS.get(SPACE_ENDS_KEY, '{}')) || {};
        for (const [h, s] of Object.entries(obj)) {
          if (typeof h === 'string' && typeof s === 'string') m.set(h.toLowerCase(), s.toLowerCase());
        }
      } catch { /* corrupt — start empty */ }
      return m;
    })();
  }

  /* Single funnel for recording a SPACE_END: update the in-memory Map AND
     persist to localStorage (capped at the most recent ~200), then refresh the
     right-column live module so an ended room drops out of the sidebar without
     waiting for a full feed re-render. */
  _recordSpaceEnd(hash, sender) {
    if (!hash || !sender) return;
    hash = hash.toLowerCase(); sender = sender.toLowerCase();
    (this._spaceEnds ||= new Map()).set(hash, sender);
    /* Persist, capped to the most recent ~200 entries (Map preserves insertion
       order; trim from the front). */
    try {
      const entries = [...this._spaceEnds.entries()];
      const capped = entries.slice(-200);
      if (capped.length !== entries.length) this._spaceEnds = new Map(capped);
      utils.safeLS.set(SPACE_ENDS_KEY, JSON.stringify(Object.fromEntries(capped)));
    } catch { /* storage full / unavailable — Map still holds it for this session */ }
    try { this.renderLiveSpaces(); } catch { /* sidebar not mounted yet */ }
  }

  async init(opts = {}) {
    this.wireListeners();
    this.updateChLabel();
    /* Apply the saved notification-badge color override (accent by default). */
    this._applyNotifBadgeColor(this._getSettings().notifBadgeColor);
    /* Use the user's pruneAgeDays setting (default 30). */
    const _pruneDays = parseInt(this._getSettings().pruneAgeDays, 10) || 30;
    /* Housekeeping — never block boot on it. */
    this.cache.pruneIfStale(_pruneDays).catch(err => console.warn('Prune failed', err));
    /* Deep-sync auto-resume: quietly pick up an interrupted archive once
       the app has settled (never competes with first paint). */
    setTimeout(() => {
      const ds = this._deepSyncState();
      if (ds.lastPage > 0 && !ds.done && navigator.onLine && !this._deepSyncing) this.toggleDeepSync();
    }, 8000);
    /* Host rejoin banner: a reload killed the room but their Space may
       still be live. Re-check a few times — the wallet usually auto-
       reconnects a moment after boot. */
    [5000, 15000, 30000].forEach(ms => setTimeout(() => {
      try { this._checkActiveSpace(); } catch { /* banner is best-effort */ }
    }, ms));
    /* Migrate muted list from localStorage to IDB if needed */
    try {
      const idbMuted = await this.cache.getMuted();
      if (idbMuted.length > 0) {
        /* IDB has data — use it as the source of truth */
        this.state.muted = new Set(idbMuted);
      } else if (this.state.muted.size > 0) {
        /* localStorage has data but IDB doesn't — migrate */
        await this.cache.saveMuted([...this.state.muted]);
      }
    } catch (err) { console.warn('Muted IDB load:', err); }
    this._restoreDraft();
    await this.loadCached();
    await this.tryAutoReconnect();
    /* Skip the home-feed scan when the page was opened on a deep link that
       loads its own data (post / profile / channel) — otherwise that view
       waits behind a full home scan before its own scan even starts. The
       home feed loads lazily when the user navigates Home. Cached posts from
       loadCached() are still in state.posts for anything that needs them. */
    if (!opts.skipHomeFetch) await this.fetchPosts(true);
    this._initComposePlaceholderRotation();
    this._refreshSidebarPanels();
    /* First-visit disclaimer — shown once per device, then remembered. */
    this._maybeShowDisclaimer();
    /* Resume polling immediately when tab becomes visible — picks up
       anything that landed on-chain while the user was away. */
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.pollNew();
    });
    window.addEventListener('online', () => {
      utils.toast('✅ Back online — retrying queued posts…');
      setTimeout(() => this._retryPendingPosts(), 1000);
    });
    setTimeout(() => { this.pollNew(); this.startPolling(); }, POLL_FIRST_MS);
    this._loadPendingPostsIntoFeed();
    /* Kick off engagement-from-IDB build during idle time. Posts already
       loaded into state.posts will be merged on first render via
       _mergeEngagement; this catches the rest from IDB. */
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => this._refreshEngagementFromCache(), { timeout: 3000 });
    } else {
      setTimeout(() => this._refreshEngagementFromCache(), 1500);
    }
    /* Refresh relative timestamps in place every 60s so "2m" becomes "3m"
       without a full feed re-render. Only touches .post-time elements that
       carry a data-ts attribute; cheap DOM text updates. */
    this._timeTickTimer = setInterval(() => this._tickRelativeTimes(), 60000);
    /* Debounced sidebar refresh: renderFeed can fire many times in quick
       succession (virtualized scroll, polling, tab switches). Each sidebar
       rebuild re-scans all posts (trending/polls/news/who-to-follow), so
       coalescing rapid calls into one avoids redundant O(n) passes. */
    this._refreshSidebarDebounced = utils.debounce(() => this._refreshSidebarPanels(), 150);

    /* Pre-warm the profile cache from IDB for the authors of already-loaded
       posts. Without this, avatars/names flash the default placeholder on
       reload until each profile lazy-loads. fetchOtherProfile reads IDB
       first (fast) and patches the feed in place when done. */
    {
      const authors = new Set();
      for (const p of this.state.posts) {
        if (p.reporter && p.reporter !== this.state.signerAddr) authors.add(p.reporter);
        if (authors.size >= 30) break; /* only the first screenful matters */
      }
      authors.forEach(addr => this.fetchOtherProfile(addr));
    }
    /* One-time idle-time search index rebuild for posts cached before r18. */
    this._rebuildSearchIndex();
  }

  /* Per-channel draft storage — keyed by channel address so switching
     channels preserves each channel's draft independently. Falls back
     to DRAFT_KEY for backwards compat with any saved drafts. */
  _draftKey() {
    const ch = this.state.channel || 'global';
    return `${DRAFT_KEY}:${ch}`;
  }
  _saveDraft() {
    const v = this.g('compose-text').value;
    const key = this._draftKey();
    if (v.trim()) {
      utils.safeLS.set(key, v);
      this._flashDraftSaved();
    } else {
      utils.safeLS.remove(key);
      utils.safeLS.remove(DRAFT_KEY); /* clean up legacy key too */
    }
  }

  /* Briefly show the "Draft saved" hint, then fade it out. Debounced via
     a timer so rapid saves don't flicker. */
  _flashDraftSaved() {
    const hint = this.g('draft-saved-hint');
    if (!hint) return;
    hint.classList.add('show');
    clearTimeout(this._draftHintTimer);
    this._draftHintTimer = setTimeout(() => hint.classList.remove('show'), 1800);
  }
  _restoreDraft() {
    /* Try per-channel key first, then fall back to legacy global key */
    const draft = utils.safeLS.get(this._draftKey())
                || utils.safeLS.get(DRAFT_KEY)
                || '';
    if (!draft) return;
    this.g('compose-text').value = draft;
    utils.autoGrow(this.g('compose-text'));
    utils.updateCharCount(this.g('compose-text'), null);
    this._syncPostBtn();
  }
  _clearDraft() {
    utils.safeLS.remove(this._draftKey());
    utils.safeLS.remove(DRAFT_KEY); /* clean up any legacy key */
  }

  wireListeners() {
    const g = this.g.bind(this);
    /* Safe wire: silently skips if element doesn't exist.
       Prevents "Cannot set properties of null" crashes when HTML
       and JS get out of sync during development or future HTML changes. */
    const w = (id, event, fn) => {
      const el = g(id);
      if (el) el[event] = fn;
    };

    /* Each group wires one functional area; order preserved from the
       original monolith (capture-listener precedence is order-sensitive). */
    this._wireTopNav();
    this._wireFeedTabs();
    this._wireSideNav();
    this._wireCompose();
    this._wireFeedDelegation();
    this._wireHoverPopups();
    this._wireChannelBar();
    this._wireGlobalDelegates();
  }

  _wireTopNav() {
    const g = this.g.bind(this);
    /* ── Top-level nav: logo, wallet, post buttons ─────────────────── */
    this._initVideoAutoWire();
    this._initTwemoji();
    /* Unmute toggle for feed videos (was an inline handler; CSP-strict). */
    document.addEventListener('click', e => {
      const btn = e.target.closest('.vid-unmute-btn');
      if (!btn) return;
      e.stopPropagation();
      const v = btn.parentElement?.querySelector('video');
      if (v) { v.muted = !v.muted; btn.textContent = v.muted ? '🔇' : '🔊'; }
    }, true);
    /* Resource-error fallbacks (was inline onerror=; CSP-strict). 'error'
       doesn't bubble — capture phase catches every img/video on the page.
       data-fallback-src swaps the source once; data-fallback hides. */
    document.addEventListener('error', e => {
      const el = e.target;
      if (!el || !el.tagName || (el.tagName !== 'IMG' && el.tagName !== 'VIDEO')) return;
      const fbSrc = el.dataset?.fallbackSrc;
      if (fbSrc && !el._fbDone) { el._fbDone = true; el.src = fbSrc; return; }
      const fb = el.dataset?.fallback;
      if (fb === 'hide' || fbSrc) el.style.display = 'none';
      else if (fb === 'hide-wrap') { const w = el.closest('.post-vid-wrap'); if (w) w.style.display = 'none'; }
    }, true);
    g('logo-wrap').onclick     = () => this.goHome();
    /* Wave / PulseChain pinned rows are wired via inline onclick in the
       HTML (so they survive renderTrending's outerHTML rebuild). Wave opens
       the Wave channel; PulseChain opens pulsechain.com. */
    g('connect-btn').onclick   = () => this.toggleWallet();
    const mConn = g('mobile-connect');
    if (mConn) mConn.onclick = () => this.toggleWallet();
    g('nav-post-btn').onclick  = () => this.openComposeModal();
    g('mobile-fab').onclick    = () => this.openComposeModal();

    /* Tapping the active tab refreshes feed -- matches X/Twitter */
  }

  _wireFeedTabs() {
    const g = this.g.bind(this);
    /* ── Feed tabs (For You / Following) ───────────────────────────── */
    g('tab-foryou').onclick = () => {
      if (document.getElementById('tab-foryou').classList.contains('active')) {
        this.refreshFeed(); return;
      }
      this.setFeedTab('foryou');
    };
    g('tab-following').onclick = () => {
      if (document.getElementById('tab-following').classList.contains('active')) {
        this.refreshFeed(); return;
      }
      this.setFeedTab('following');
    };

    g('compose-text').addEventListener('focus', () => {
      g('compose-area').classList.add('focused');
    });
    document.addEventListener('click', e => {
      if (!g('compose-area').contains(e.target) &&
          e.target !== g('post-btn') && e.target !== g('expand-compose-btn')) {
        if (!g('compose-text').value.trim()) {
          g('compose-area').classList.remove('focused');
        }
      }
      /* close More popup on outside click */
      if (!g('nav-more-wrap').contains(e.target)
          && !e.target.closest('#mn-more')
          && !e.target.closest('#more-popup')) this.hideMoreMenu();
    });

    const apill = g('account-pill');
    if (apill) {
      apill.onclick = e => {
        if (e.target.closest('#ap-dots')) this.disconnect();
        else this.openProfileModal();
      };
    }
  }

  _wireSideNav() {
    const g = this.g.bind(this);
    /* Safe wire: silently skips if the element doesn't exist. */
    const w = (id, event, fn) => {
      const el = g(id);
      if (el) el[event] = fn;
    };
    /* These nav items are real <a href="#/…"> links so right-click / middle-click
       / ctrl-click open them in a new tab. On a plain left-click we preventDefault
       and route in-app (no reload); modified clicks fall through to the browser. */
    const navClick = fn => e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
      e.preventDefault();
      fn();
    };
    /* ── Sidebar + mobile nav items ────────────────────────────────── */
    g('nav-home').onclick      = navClick(() => this.goHome());
    g('nav-explore').onclick   = navClick(() => this.goExplore());
    g('nav-notifs').onclick    = navClick(() => this.goNotifications());
    g('nav-channels').onclick  = navClick(() => this.goChannels());
    w('nav-notgrok', 'onclick', navClick(() => this.goNotGrok()));
    g('nav-bookmarks').onclick = navClick(() => this.goBookmarks());
    g('nav-studio').onclick    = navClick(() => this.goDashboard());
    /* Lists / Communities are NOT top-level nav entries in X —
       they live in the More menu (wired below). */
    w('nav-premium', 'onclick', () => this.goPremium());
    w('sb-premium-btn', 'onclick', () => this.goPremium());
    g('nav-profile').onclick   = navClick(() => this.openProfileModal());
    g('nav-more').onclick      = e => { e.stopPropagation(); this.toggleMoreMenu(); };
    /* The mobile #mn-more button is wired via the [data-mn="more"]
       delegation handler below. */
    g('more-settings').onclick = () => { this.hideMoreMenu(); this.goSettings(); };
    const mlBtn = g('more-lists');
    if (mlBtn) mlBtn.onclick = () => { this.hideMoreMenu(); this.goLists(); };
    const mcBtn = g('more-communities');
    if (mcBtn) mcBtn.onclick = () => { this.hideMoreMenu(); this.goCommunities(); };
    /* Bookmarks + Creator dashboard live in the nav on wide screens and in
       More once it compresses (CSS toggles visibility; both handlers wired). */
    const mbkBtn = g('more-bookmarks-mn');
    if (mbkBtn) mbkBtn.onclick = () => { this.hideMoreMenu(); this.goBookmarks(); };
    const msdBtn = g('more-studio');
    if (msdBtn) msdBtn.onclick = () => { this.hideMoreMenu(); this.goDashboard(); };
    const maBtn = g('more-analytics');
    if (maBtn) maBtn.onclick = () => { this.hideMoreMenu(); this.goAnalytics(); };
    const mvBtn = g('more-verify');
    if (mvBtn) mvBtn.onclick = () => { this.hideMoreMenu(); this.goVerify(); };
    const msBtn = g('more-space');
    if (msBtn) msBtn.onclick = () => { this.hideMoreMenu(); this.openCreateSpace(); };

    document.querySelectorAll('[data-mn]').forEach(b => {
      b.onclick = (ev) => {
        const t = b.dataset.mn;
        if (t === 'more') ev.stopPropagation();
        if (t === 'home')      this.goHome();
        if (t === 'explore')   this.goExplore();
        if (t === 'notifs')    this.goNotifications();
        if (t === 'channels')  this.goChannels();
        if (t === 'mychannel') this.goSelf();
        if (t === 'profile')   this.openProfileModal();
        if (t === 'more')      this.toggleMoreMenu();
      };
    });

  }

  _wireCompose() {
    const g = this.g.bind(this);
    /* ── Compose box + compose modal ───────────────────────────────── */
    g('compose-text').oninput = () => {
      utils.autoGrow(g('compose-text'));
      utils.updateCharCount(g('compose-text'), null);
      this._syncPostBtn();
      this._draftSave();
    };
    g('post-btn').onclick           = () => this.publishPost();
    g('expand-compose-btn').onclick = () => this.openComposeModal();
    this._syncPostBtn(); /* initial: disabled while the box is empty */
    this._initComposerChains(); /* multichain "posting to" selectors */

    g('close-compose-modal').onclick = () => this.closeModal('compose-modal');
    g('modal-compose-text').oninput  = () => {
      utils.autoGrow(g('modal-compose-text'));
      utils.updateCharCount(g('modal-compose-text'), g('modal-char-count'));
      this._syncPostBtn();
    };
    g('modal-post-btn').onclick = () => this.publishFromModal();


  }

  _wireFeedDelegation() {
    const g = this.g.bind(this);
    const handlePostClick = (e, inModal) => {
      const img = e.target.closest('.post-img-thumb');
      if (img) {
        e.stopPropagation();
        const wrap = img.closest('.post-images') || img.parentElement;
        const thumbs = [...(wrap?.querySelectorAll('.post-img-thumb') || [img])];
        const imgs = thumbs.map(t => ({ full: t.dataset.href || t.src, thumb: t.src, alt: t.alt || '' }));
        this._openImageLightbox(imgs, Math.max(0, thumbs.indexOf(img)));
        return;
      }
      const tag = e.target.closest('.post-tag');
      if (tag) { e.stopPropagation(); this.filterByTag(tag.dataset.tag); return; }
      const mention = e.target.closest('.post-mention');
      if (mention) { e.stopPropagation(); this.g('custom-input').value = mention.dataset.addr; this.goCustom(); return; }
      const handle = e.target.closest('.post-handle');
      if (handle) { e.stopPropagation(); utils.copyToClipboard(handle.dataset.addr, 'Address copied!'); return; }
      /* Click on poster's display name or avatar → profile popup card.
         Avatar click is also a popup trigger (matches Twitter behavior
         on touch, where hover doesn't exist). */
      const name   = e.target.closest('.post-name');
      const avatar = e.target.closest('.post-avatar');
      if (name || avatar) {
        /* Name and avatar are both real <a href="#/profile/…"> links: on a
           modified click let the browser open it in a new tab; on a plain
           click route in-app. */
        const link = e.target.closest('a');
        if (link && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1)) return;
        e.preventDefault();
        e.stopPropagation();
        /* Resolve via the nearest [data-txhash] — not .post-item — so a
           conversation-module parent (.feed-parent-item, nested inside the
           outer reply's .post-item) resolves to the PARENT author, not the
           reply author. */
        const item = e.target.closest('[data-txhash]');
        const post = item ? (this._postMap.get(item.dataset.txhash) || this._parentCache?.get(item.dataset.txhash)) : null;
        if (post?.reporter) {
          /* Click navigates straight to the profile (like X). The hovercard
             still appears on hover via the separate mouseover handler. */
          this.hideProfilePopup();
          this.goProfilePage(post.reporter, post.reporter === this.state.signerAddr);
        }
        return;
      }
      this.onFeedClick(e, inModal);
    };
    /* ── Feed delegation: post actions, keyboard parity ────────────── */
    g('feed').addEventListener('click', e => handlePostClick(e, false));
    /* Keyboard activation for the clickable spans (post-tag / post-mention /
       post-handle) — they're role="button" tabindex="0", so Enter/Space must
       fire the same action a click does. Reuses handlePostClick's dispatch. */
    g('feed').addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!e.target.closest('.post-tag, .post-mention, .post-handle')) return;
      e.preventDefault();
      handlePostClick(e, false);
    });

  }

  _wireHoverPopups() {
    const g = this.g.bind(this);
    /* ── Hover popup (desktop only) ──────────────────────────────────
       Uses mouseover/mouseout on the feed so we don't attach N listeners.
       400ms hover delay matches Twitter. Cleared immediately on mouseout
       unless the mouse moved into the popup itself. */
    let _hoverTimer = null;
    let _hoverAddr  = null;
    const isTouch = () => window.matchMedia('(hover: none)').matches;

    const onFeedMouseover = e => {
      if (isTouch()) return;
      let trigger = e.target.closest('.post-name, .post-avatar');
      let addr = null;
      if (trigger) {
        /* [data-txhash] (not .post-item) so a conversation-module parent
           resolves to the parent author, not the outer reply. */
        const item = e.target.closest('[data-txhash]');
        const post = item ? (this._postMap.get(item.dataset.txhash) || this._parentCache?.get(item.dataset.txhash)) : null;
        addr = post?.reporter?.toLowerCase() || null;
      }
      /* Fallback for non-post rows (followers/following lists, etc.) that carry
         the address directly on a [data-pop-addr] element. */
      if (!addr) {
        const popEl = e.target.closest('[data-pop-addr]');
        if (popEl) { trigger = popEl; addr = popEl.dataset.popAddr?.toLowerCase() || null; }
      }
      if (!addr || !trigger) return;
      /* If already showing for this address, don't re-trigger */
      if (this.g('profile-popup')?.classList.contains('open') &&
          this.g('profile-popup').dataset.addr === addr) return;
      /* Debounce: cancel any pending show, restart timer */
      clearTimeout(_hoverTimer);
      _hoverAddr = addr;
      _hoverTimer = setTimeout(() => {
        if (_hoverAddr === addr) this.showProfilePopup(addr, trigger, 'hover');
      }, 400);
    };

    const onFeedMouseout = e => {
      if (isTouch()) return;
      /* Did the mouse leave toward the popup? If so, keep it open. */
      const popup = this.g('profile-popup');
      if (popup?.contains(e.relatedTarget)) return;
      clearTimeout(_hoverTimer);
      _hoverAddr = null;
      /* Small grace window — if mouse re-enters popup within 150ms,
         we leave it open. This prevents flicker when gap between
         trigger and popup is crossed. */
      if (popup?.classList.contains('open')) {
        const closeTimer = setTimeout(() => {
          /* Only auto-close if mouse is outside BOTH trigger and popup */
          if (!popup.matches(':hover') && !popup.contains(document.activeElement)) {
            this.hideProfilePopup();
          }
        }, 150);
        popup._pendingClose = closeTimer;
      }
    };

    /* Single permanent capture-phase click listener for popup dismissal.
       Runs before any other click handler. If popup is open:
         - Click inside popup -> handled by popup (action or navigate)
         - Click outside popup -> close popup, then let event continue
       We NEVER stopPropagation for outside clicks — that's what was
       causing the left sidebar to lose click ability. When dismiss fired
       via a leaked listener and called stopPropagation, sidebar buttons
       never got the event. */
    document.addEventListener('click', e => {
      const popup = this.g('profile-popup');
      if (!popup?.classList.contains('open')) return;
      if (popup.contains(e.target)) {
        /* Inside popup: handle follow/unfollow action */
        const btn = e.target.closest('[data-pp-action]');
        if (btn) {
          e.stopPropagation();
          const addr = popup.dataset.addr;
          this.toggleFollowAddr(addr, null);
          setTimeout(() => {
            if (popup.classList.contains('open') && popup.dataset.addr === addr) {
              const postCount = this.state.posts.filter(
                p => p.reporter?.toLowerCase() === addr &&
                     (!p.postType || p.postType === 'post')).length;
              popup.innerHTML = this._profilePopupHTML(addr,
                this.state.profCache[addr] ||
                (addr === this.state.signerAddr ? this.state.profile : {}), postCount);
            }
          }, 500);
          return;
        }
        /* Following / Followers counts -> open that list (X behavior). */
        const listBtn = e.target.closest('[data-pp-list]');
        if (listBtn) {
          e.stopPropagation();
          const addr = popup.dataset.addr;
          this.hideProfilePopup();
          if (listBtn.dataset.ppList === 'following') this._showFollowingList(addr, addr === this.state.signerAddr);
          else this._showFollowerList(addr);
          return;
        }
        /* Click on popup body -> open profile page */
        const addr = popup.dataset.addr;
        this.hideProfilePopup();
        this.goProfilePage(addr, addr === this.state.signerAddr);
        return;
      }
      /* Outside popup: close it. Do NOT stopPropagation — allow the
         click to reach its intended target (sidebar, buttons, etc). */
      this.hideProfilePopup();
      /* Note: we intentionally do NOT return or stopPropagation here.
         The sidebar/feed elements get this click event normally. */
    }, true /* capture phase: run before target handlers */);

    /* Backstop: a capture-phase pointerdown also dismisses the popup on any
       outside tap/click. Covers cases the click path can miss (e.g. the
       trigger element was removed by a feed re-render, or a handler swallows
       the click). Triggers themselves are excluded so they can re-open/toggle. */
    document.addEventListener('pointerdown', e => {
      const popup = this.g('profile-popup');
      if (!popup?.classList.contains('open')) return;
      if (popup.contains(e.target)) return;
      if (e.target.closest?.('.post-name, .post-avatar')) return;
      this.hideProfilePopup();
    }, true);

    g('feed').addEventListener('mouseover', onFeedMouseover);
    g('feed').addEventListener('mouseout',  onFeedMouseout);
    /* Same hovercard for [data-pop-addr] rows in the right column (who-to-follow). */
    const sbr = g('sidebar-right');
    if (sbr) {
      sbr.addEventListener('mouseover', onFeedMouseover);
      sbr.addEventListener('mouseout',  onFeedMouseout);
    }

  }

  _wireChannelBar() {
    const g = this.g.bind(this);
    /* ── Channel bar + misc controls ───────────────────────────────── */
    g('cb-address').onclick = () => {
      const addr = g('cb-address').textContent;
      if (addr) utils.copyToClipboard(addr, 'Address copied!');
    };

    /* Escape in the search input clears the search (Twitter parity).
       Global keydown handler early-returns for INPUT/TEXTAREA, so we wire
       Escape on the input itself. */
    const _searchInputEl = g('search-input');
    if (_searchInputEl) {
      _searchInputEl.addEventListener('keydown', e => {
        if (e.key === 'Escape' && _searchInputEl.value) {
          e.preventDefault();
          _searchInputEl.value = '';
          this.state.searchTerm = '';
          this.state.activeTag  = null;
          this._updateSearchClearBtn();
          if (!this._selfManagedModes.has(this.state.mode)) this.renderFeed();
          _searchInputEl.blur();
        }
      });
    }

    /* Search clear (X) button — wire BEFORE the oninput handler so it's
       available when the handler calls _updateSearchClearBtn. */
    const searchClear = g('search-clear');
    if (searchClear) {
      searchClear.onclick = () => {
        const inp = g('search-input');
        inp.value = '';
        this.state.searchTerm = '';
        this.state.activeTag  = null;
        this._updateSearchClearBtn();
        this._hideSearchDropdown();
        if (!this._selfManagedModes.has(this.state.mode)) this.renderFeed();
        inp.focus();
      };
    }
    /* Dismiss the search dropdown on outside click. Delayed so a click on
       a dropdown item registers before the dropdown is hidden. */
    document.addEventListener('click', e => {
      const wrap = g('search-input')?.closest('.search-wrap');
      if (wrap && !wrap.contains(e.target)) this._hideSearchDropdown();
    });
    /* Keyboard navigation for the search dropdown: ↑/↓ to move between
       suggestions, Enter to select the active one, Escape to close. */
    g('search-input').addEventListener('keydown', e => {
      const dd = this.g('search-dropdown');
      const open = dd && dd.classList.contains('open');
      if (e.key === 'Escape') { this._hideSearchDropdown(); return; }
      if (!open) return;
      const items = Array.from(dd.querySelectorAll('.search-dd-item'));
      if (!items.length) return;
      let idx = items.findIndex(el => el.classList.contains('active'));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        idx = (idx + 1) % items.length;
        items.forEach(el => el.classList.remove('active'));
        items[idx].classList.add('active');
        items[idx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        idx = idx <= 0 ? items.length - 1 : idx - 1;
        items.forEach(el => el.classList.remove('active'));
        items[idx].classList.add('active');
        items[idx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        /* If an item is highlighted, activate it. Otherwise: a pasted tx
           hash or address jumps straight to the post / profile (no need to
           arrow down to the dropdown row first). Anything else falls
           through to the normal full-text search (no preventDefault). */
        if (idx >= 0) {
          e.preventDefault();
          items[idx].click();
        } else {
          const q = e.target.value.trim().toLowerCase();
          if (/^0x[a-f0-9]{64}$/.test(q)) {
            e.preventDefault();
            this._hideSearchDropdown();
            this._clearSearch();
            this.openThreadByHash(q);
          } else if (/^0x[a-f0-9]{40}$/.test(q)) {
            e.preventDefault();
            this._hideSearchDropdown();
            this._clearSearch();
            this.goProfilePage(q, q === this.state.signerAddr);
          }
        }
      }
    });
    g('search-input').oninput = utils.debounce(async () => {
      const term = g('search-input').value.trim();
      this.state.searchTerm = term.toLowerCase();
      this.state.activeTag  = null;
      /* Build the live suggestion dropdown (people + hashtags). */
      this._renderSearchDropdown(term);
      /* Search input is dead on self-managed pages (renderFeed bails early).
         If the user is typing and we're on Notifications/Bookmarks/etc,
         switch to home so they can actually see results. We await goHome()
         so resetAndFetch finishes clearing state BEFORE we re-apply the
         search term — otherwise resetAndFetch would clobber it (race). */
      if (term && this._selfManagedModes.has(this.state.mode)) {
        await this.goHome();
        /* goHome / resetAndFetch already cleared state.searchTerm and the
           input value. Re-apply, then render. */
        this.state.searchTerm = term.toLowerCase();
        g('search-input').value = term;
        this._updateSearchClearBtn();
        this.renderFeed();
        return;
      }
      this._updateSearchClearBtn();
      this.renderFeed();
    }, 250);

    g('new-banner').onclick  = () => this.loadPending();
    const newPill = g('new-pill');
    if (newPill) newPill.onclick = () => this.loadPending();
    /* Show the floating pill only when there are pending posts AND the user
       has scrolled the stationary bar out of view. Throttled via rAF. */
    let _pillTick = false;
    window.addEventListener('scroll', () => {
      if (_pillTick) return;
      _pillTick = true;
      requestAnimationFrame(() => {
        _pillTick = false;
        this._updateFloatingPill();
      });
    }, { passive: true });

    g('ch-main').onclick = () => this.goHome();
    g('ch-self').onclick = () => this.goSelf();
    g('ch-go').onclick   = () => this.goCustom();
    g('custom-input').onkeydown = e => { if (e.key === 'Enter') this.goCustom(); };

    window.addEventListener('scroll', utils.throttle(() => this.onScroll(), 100), { passive: true });

  }

  _wireGlobalDelegates() {
    const g = this.g.bind(this);
    /* Safe wire: silently skips if the element doesn't exist. */
    const w = (id, event, fn) => {
      const el = g(id);
      if (el) el[event] = fn;
    };
    /* ── Central delegated click handler ─────────────────────────────────
       Replaces every template-interpolated inline onclick. Two security
       wins: (1) values never enter a JS-string context (where HTML-attr
       escaping is decoded away before the JS engine evaluates the handler)
       — they ride in data attributes instead; (2) hash/address arguments
       are format-validated again right here at the sink.
       Bound in CAPTURE phase so cases that need to shield an enclosing
       clickable row (the old event.stopPropagation() contract on buttons
       inside rows) can stop propagation before row-level bubble handlers
       fire. Note: stopPropagation from document-capture also suppresses
       the target's own addEventListener handlers — fine for these
       elements, whose only behavior lived in the converted inline
       attribute. Keyboard activation still works: the global keydown
       delegate dispatches el.click() on role="button" elements. */
    document.addEventListener('click', e => {
      /* Media elements inside actionable cards (e.g. a YouTube facade in a
         quote card) handle their own clicks — let them through instead of
         firing the card's action. */
      if (e.target.closest('.post-yt-facade, .post-embed-playing, video.post-vid-thumb, .vid-unmute-btn, .x-embed-facade, .x-embed-loaded, .dex-embed-facade, .dex-embed-loaded')) return;
      const el = e.target.closest('[data-act]');
      if (!el) return;
      /* A link inside an actionable element is a link first (timestamps,
         embeds, websites) — unless the action host IS the link itself. */
      const link = e.target.closest('a[href]');
      if (link && link !== el) return;
      const arg  = el.dataset.actArg  || '';
      const arg2 = el.dataset.actArg2 || '';
      const isHash = /^0x[a-f0-9]{64}$/i.test(arg);
      const isAddr = /^0x[a-f0-9]{40}$/i.test(arg);
      switch (el.dataset.act) {
        case 'open-thread':
          if (isHash) this.openThreadByHash(arg.toLowerCase());
          break;
        case 'open-dm':
          if (isAddr) this.goMessages(arg.toLowerCase());
          break;
        case 'notif-open':
          /* Whole notification row — but the avatar/name inside open the
             profile popup via their own delegate; let those through. */
          if (e.target.closest('.notif-pop')) return;
          if (arg2 === 'tx') {
            if (isHash) window.open(txUrl(CANONICAL_CHAIN_ID, arg.toLowerCase()), '_blank', 'noopener,noreferrer');
          } else if (isHash) this.openThreadByHash(arg.toLowerCase());
          break;
        case 'open-tx':
          if (isHash) window.open(txUrl(CANONICAL_CHAIN_ID, arg.toLowerCase()), '_blank', 'noopener,noreferrer');
          break;
        case 'share-profile':
          e.stopPropagation();
          if (isAddr) this._shareUrl(this._profileUrl(arg), '');
          break;
        case 'open-channel':
          /* Real <a href> — modifier/middle clicks fall through to the
             browser for open-in-new-tab. */
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
          e.preventDefault(); e.stopPropagation();
          if (isAddr) { this.g('custom-input').value = arg; this.goCustom(); }
          break;
        case 'modal-open-channel':
          e.preventDefault();
          this._closeGenericModal();
          if (isAddr) { this.g('custom-input').value = arg; this.goCustom(); }
          break;
        case 'follow-toggle':
          e.stopPropagation();
          if (isAddr) this.toggleFollow(arg, el);
          break;
        case 'follow-toggle-addr':
          e.stopPropagation();
          if (isAddr) this.toggleFollowAddr(arg, el);
          break;
        case 'open-profile':
          if (isAddr) this.goProfilePage(arg, arg2 === '1');
          break;
        case 'follow-more':
          this._renderFollowListMore(el, parseInt(arg, 10) || 0);
          break;
        case 'open-quote':
          e.stopPropagation();
          if (isHash) this._openQuotedPost(arg, /^0x[a-f0-9]{40}$/i.test(arg2) ? arg2 : '');
          break;
        case 'search-trend':
          this._searchTrend(arg);
          break;
        case 'load-more':
          this.fetchPosts(false);
          break;
        case 'nav-back':
          this._navBack();
          break;
        case 'focus-search':
          this._focusSearch();
          break;
        case 'channel-search':
          this._channelSearch();
          break;
        case 'show-disclaimer':
          e.preventDefault();
          this.showDisclaimer(true);
          break;
        case 'switch-chain':
          this._switchToPulse();
          break;
        case 'go-verify':
          e.preventDefault();
          this.goVerify();
          break;
        case 'open-support':
          e.preventDefault();
          this.goOfficialChannel();
          break;
      }
    }, true);

    document.addEventListener('keydown', e => {
      /* Escape closes an open modal / generic modal BEFORE the INPUT/TEXTAREA
         early-return below — these modals autofocus their textarea, so without
         this Escape could never close them while you're typing (X parity). */
      if (e.key === 'Escape') {
        if (this.g('generic-modal')) { this._closeGenericModal(); return; }
        const openModal = ['compose-modal','reply-modal','repost-modal','media-modal','share-modal','profile-modal']
          .find(id => this.g(id)?.classList.contains('open'));
        if (openModal) { this.closeModal(openModal); return; }
      }
      const active = document.activeElement?.tagName;
      if (active === 'INPUT' || active === 'TEXTAREA') return;
      /* Enter/Space activates a focused custom button (role="button" on a
         non-native element) — keyboard parity for clickable rows/cards. */
      const ae = document.activeElement;
      if (ae && ae.getAttribute && ae.getAttribute('role') === 'button' &&
          ae.tagName !== 'BUTTON' && ae.tagName !== 'A' &&
          !ae.hasAttribute('onkeydown') && /* element handles its own keys */
          (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        ae.click();
        return;
      }
      /* ── Compose / nav shortcuts ── */
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        g('compose-text').focus();
        g('compose-text').scrollIntoView({ behavior:'smooth', block:'center' });
        return;
      }
      if (e.key === '/') { e.preventDefault(); g('search-input').focus(); return; }
      if (e.key === '?') { e.preventDefault(); this.showShortcutsHelp(); return; }
      if (e.key === 'e' || e.key === 'E') { e.preventDefault(); this.openComposeModal(); return; }
      /* ── J/K post navigation ── */
      if (e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        const items = [...document.querySelectorAll('.post-item')];
        if (!items.length) return;
        const focused = document.querySelector('.post-item.kb-focus');
        let idx = focused ? items.indexOf(focused) : -1;
        if (e.key === 'j' || e.key === 'J') idx = Math.min(idx + 1, items.length - 1);
        else                                  idx = Math.max(idx - 1, 0);
        items.forEach(el => el.classList.remove('kb-focus'));
        items[idx].classList.add('kb-focus');
        items[idx].scrollIntoView({ behavior:'smooth', block:'nearest' });
        this._kbFocusedPost = this._postMap.get(items[idx].dataset.txhash);
        return;
      }
      /* ── Actions on focused post ── */
      const post = this._kbFocusedPost;
      if (post) {
        if (e.key === 'Enter') { e.preventDefault(); this.openThread(post); return; }
        if (e.key === 'l' || e.key === 'L') {
          e.preventDefault();
          const el = document.querySelector(`.post-item.kb-focus`);
          if (el) this.toggleLike(post, el);
          return;
        }
        if (e.key === 'r' || e.key === 'R') { e.preventDefault(); this.openReplyModal(post); return; }
        if (e.key === 't' || e.key === 'T') { e.preventDefault(); this.openRepostChoice(post, null); return; }
        if (e.key === 'b' || e.key === 'B') {
          e.preventDefault();
          const el = document.querySelector(`.post-item.kb-focus`);
          if (el) this.toggleBookmark(post, el);
          return;
        }
        if (e.key === 'u' || e.key === 'U') {
          e.preventDefault();
          utils.copyToClipboard(txUrl(post.chainId, post.txHash), 'Link copied!');
          return;
        }
      }
      /* ── Page navigation shortcuts ── */
      if (e.key === 'g' && !e.shiftKey) {
        /* g+h home, g+n notifications, g+p profile etc — wait for 2nd key */
        this._gPressed = true;
        setTimeout(() => { this._gPressed = false; }, 1500);
        return;
      }
      if (this._gPressed) {
        this._gPressed = false;
        if (e.key === 'h') { e.preventDefault(); this.goHome(); return; }
        if (e.key === 'n') { e.preventDefault(); this.goNotifications(); return; }
        if (e.key === 'p') { e.preventDefault(); this.openProfileModal(); return; }
        if (e.key === 's') { e.preventDefault(); this.goSelf(); return; }
        if (e.key === 'b') { e.preventDefault(); this.goBookmarks(); return; }
      }
      if (e.key === 'Escape') {
        /* Close popup first — it's higher in the UI stack than modals. */
        if (this.g('profile-popup')?.classList.contains('open')) {
          this.hideProfilePopup();
          return;
        }
        /* Clear J/K focus */
        if (document.querySelector('.post-item.kb-focus')) {
          document.querySelectorAll('.post-item.kb-focus').forEach(el => el.classList.remove('kb-focus'));
          this._kbFocusedPost = null;
          return;
        }
        /* Generic modal is built on the fly and sits topmost when present —
           close it first (it removes itself + releases focus). */
        if (this.g('generic-modal')) { this._closeGenericModal(); return; }
        ['compose-modal','profile-modal','reply-modal','repost-modal','media-modal','share-modal'].forEach(id => {
          if (g(id).classList.contains('open')) this.closeModal(id);
        });
      }
    });

    ['compose-modal','profile-modal','reply-modal','repost-modal','media-modal','share-modal'].forEach(id => {
      g(id).addEventListener('click', e => { if (e.target === g(id)) this.closeModal(id); });
    });

    g('close-profile').onclick    = () => this.closeModal('profile-modal');
    g('cancel-edit-btn').onclick  = () => this.closeModal('profile-modal');
    g('save-profile-btn').onclick = () => this.saveProfile();
    g('pe-pic').oninput = () => {
      const v = g('pe-pic').value.trim();
      g('pe-preview').src = v || 'image1.jpeg';
    };
    g('pe-cover').oninput = () => {
      const v = g('pe-cover').value.trim();
      const prev = g('pe-cover-preview');
      /* Route through cssUrlValue (validates scheme + CSS-escapes) — same path
         the saved cover renders through, so the preview matches and a hostile
         javascript:/data: URL can't break out of url() or render. */
      const css = v ? utils.cssUrlValue(v) : '';
      if (css) {
        prev.style.backgroundImage    = `url('${css}')`;
        prev.style.backgroundSize     = 'cover';
        prev.style.backgroundPosition = 'center';
        prev.classList.add('has-cover');
      } else {
        prev.style.backgroundImage = '';
        prev.classList.remove('has-cover');
      }
    };
    g('pe-bio').oninput = () => {
      const n = g('pe-bio').value.length;
      g('pe-bio-count').textContent = `${n}/160`;
      g('pe-bio-count').style.color = n > 140 ? '#f4212e' : 'var(--muted)';
    };
    g('fetch-nft-btn').onclick = () => this.fetchNFTImage();

    w('close-share-modal', 'onclick', () => this.closeModal('share-modal'));
    g('close-reply').onclick      = () => this.closeModal('reply-modal');
    g('cancel-reply-btn').onclick = () => this.closeModal('reply-modal');
    g('post-reply-btn').onclick   = () => this.postReply();
    g('reply-input').oninput = () => {
      utils.autoGrow(g('reply-input'));
      utils.updateCharCount(g('reply-input'), g('reply-count'));
    };

    /* Repost modal */
    g('close-repost').onclick      = () => this.closeModal('repost-modal');
    g('cancel-repost-btn').onclick = () => this.closeModal('repost-modal');
    g('post-repost-btn').onclick   = () => this.postRepost();
    g('repost-input').oninput = () => {
      utils.autoGrow(g('repost-input'));
      utils.updateCharCount(g('repost-input'), g('repost-count'));
    };

    /* Compose toolbar — Image / GIF / Emoji */
    /* "Media" button (photos + video, auto-detected from the URL). */
    g('cmp-image-btn').onclick = () => this.openMediaModal('media');
    g('cmp-gif-btn').onclick   = () => this.openMediaModal('gif');
    const pollBtn = g('cmp-poll-btn');
    if (pollBtn) pollBtn.onclick = () => this.openPollComposer();
    /* Expanded modal compose toolbar — same merged Media affordance. */
    const miBtn = g('modal-cmp-image-btn');
    const mgBtn = g('modal-cmp-gif-btn');
    const mpBtn = g('modal-cmp-poll-btn');
    const meBtn = g('modal-cmp-emoji-btn');
    if (miBtn) miBtn.onclick = () => this.openMediaModal('media');
    if (mgBtn) mgBtn.onclick = () => this.openMediaModal('gif');
    if (mpBtn) mpBtn.onclick = () => this.openPollComposer(); /* modal poll button */
    /* Emoji in the expanded composer — picker anchored to its own button and
       targeting the modal textarea (parity with the inline composer). */
    if (meBtn) meBtn.onclick = () => this._openEmojiPickerFor(g('modal-compose-text'), meBtn);
    g('cmp-emoji-btn').onclick = () => this.toggleEmojiPicker();

    /* Media attach modal */
    g('close-media-modal').onclick  = () => this.closeModal('media-modal');
    g('media-url-input').oninput    = () => this._previewMedia();
    g('media-attach-btn').onclick   = () => this._attachMedia();
    g('media-cancel-btn').onclick   = () => this.closeModal('media-modal');

    /* Reply + Quote modal toolbars — same Media / GIF / Emoji affordances as
       the main composer, each targeting its OWN textarea (X parity: you can
       add media, GIFs, and emoji when replying or quoting). */
    const wireMiniToolbar = (imgId, gifId, emojiId, taId) => {
      const ta = g(taId);
      if (!ta) return;
      const ib = g(imgId), gb = g(gifId), eb = g(emojiId);
      if (ib) ib.onclick = () => this.openMediaModal('media', ta);
      if (gb) gb.onclick = () => this.openMediaModal('gif', ta);
      if (eb) eb.onclick = () => this._openEmojiPickerFor(ta, eb);
    };
    wireMiniToolbar('reply-image-btn',  'reply-gif-btn',  'reply-emoji-btn',  'reply-input');
    wireMiniToolbar('repost-image-btn', 'repost-gif-btn', 'repost-emoji-btn', 'repost-input');

    this._initPullToRefresh();
  }


  _initPullToRefresh() {
    let startY = 0, active = false;
    const pill = this.g('ptr-pill');
    document.addEventListener('touchstart', e => {
      if (window.scrollY === 0) { startY = e.touches[0].clientY; active = true; }
    }, { passive: true });
    document.addEventListener('touchmove', e => {
      if (!active) return;
      if (e.touches[0].clientY - startY > 70) pill.classList.add('show');
    }, { passive: true });
    document.addEventListener('touchend', () => {
      if (!active) return;
      active = false;
      if (pill.classList.contains('show')) { pill.classList.remove('show'); this.refreshFeed(); }
    });
  }

  /* Replace a YouTube/Vimeo facade thumbnail with the real autoplaying iframe.
     IDs were validated at render time (ytId: [A-Za-z0-9_-]{11}; vimeoId: \d+)
     and are URL-encoded here as defense in depth. */
  /* Privacy gate for third-party embed PREVIEWS. Strict (default): no
     request leaves the browser toward YouTube/Vimeo until the user
     explicitly clicks a facade — thumbnails are replaced by a neutral
     local card. Opt-in via Settings → Privacy. */
  _embedThumbsAllowed() { return this._getSettings().loadEmbedThumbs !== false; }

  /* Whether third-party embeds (X tweets, YouTube/Vimeo) auto-load as they
     scroll into view — the default, X-like behavior. Off when the user opts
     into a more private / data-light mode. Single source of truth for the
     scroll observer and the facade's loading affordance. */
  _embedsAutoLoad() {
    const s = this._getSettings();
    return !s.dataSaver && s.autoplayEmbeds !== false && s.loadEmbedThumbs !== false;
  }

  /* Whether to render local link cards (domain + path + monogram) for plain
     URLs instead of a bare text link. ON by default. These are built entirely
     from the URL — no network, no third-party contact — so Data saver doesn't
     gate them; it's purely a display preference (Settings → Privacy). */
  _linkPreviewsEnabled() {
    return this._getSettings().linkPreviews !== false;
  }

  _playFacade(el, muted = false) {
    const yt = el.dataset.ytId, vm = el.dataset.vimeoId;
    let src = '';
    if (yt)      src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}?autoplay=1&rel=0${muted ? '&mute=1&playsinline=1' : ''}`;
    else if (vm) src = `https://player.vimeo.com/video/${encodeURIComponent(vm)}?autoplay=1&dnt=1${muted ? '&muted=1' : ''}`;
    if (!src) return;
    /* One playing media at a time — stop everything else first. */
    this._stopOtherMedia(el);
    /* Stash the facade so scrolling away can restore it (which is also how
       an off-screen embed is stopped — iframes can't be paused reliably). */
    el._facadeHTML = el.innerHTML;
    el._facadeWasVimeo = el.classList.contains('post-vimeo-facade');
    const frame = document.createElement('iframe');
    frame.src = src;
    frame.className = 'post-yt-frame';
    /* fullscreen rides the allow list; setting allowFullscreen too makes
       Chrome warn that allow takes precedence. */
    frame.setAttribute('allow', 'autoplay;accelerometer;clipboard-write;encrypted-media;gyroscope;picture-in-picture;fullscreen');
    frame.setAttribute('title', yt ? 'YouTube video' : 'Vimeo video');
    el.innerHTML = '';
    el.appendChild(frame);
    /* Drop the facade affordances and give the container a 16:9 box so the
       absolutely-positioned iframe has height (emptying the thumbnail would
       otherwise collapse the wrapper to 0 and hide the player). */
    el.classList.remove('post-yt-facade', 'post-vimeo-facade');
    el.classList.add('post-embed-playing');
  }

  /* Restore a playing embed back to its click-to-play facade. This is the
     only reliable way to stop a cross-origin iframe. */
  _revertEmbed(el) {
    if (!el.classList.contains('post-embed-playing') || el._facadeHTML == null) return;
    el.innerHTML = el._facadeHTML;
    el.classList.remove('post-embed-playing');
    el.classList.add('post-yt-facade');
    if (el._facadeWasVimeo) el.classList.add('post-vimeo-facade');
  }

  /* Strict one-playing-media rule (owner requirement): starting ANY media —
     native video or embed — pauses every other native video and reverts
     every other playing embed. */
  _stopOtherMedia(except) {
    document.querySelectorAll('video.post-vid-thumb').forEach(v => {
      if (v !== except && !v.paused) v.pause();
    });
    document.querySelectorAll('.post-embed-playing').forEach(w => {
      if (w !== except) this._revertEmbed(w);
    });
  }

  onFeedClick(e, inModal) {
    /* Links handle themselves (external timestamps/cards open their href;
       in-app #/ links use the router) — never also fire the row action.
       Replaces the per-link inline stopPropagation handlers (CSP-strict). */
    if (e.target.closest('a[href]')) return;
    /* YouTube/Vimeo click-to-play facade → swap the thumbnail for the real
       player iframe (autoplay on). Handled before post routing so it doesn't
       open the thread. Iframe is built via DOM APIs (no HTML-string nesting). */
    const facade = e.target.closest('.post-yt-facade');
    if (facade) {
      e.stopPropagation();
      this._playFacade(facade);
      return;
    }
    const xFacade = e.target.closest('.x-embed-facade');
    if (xFacade) {
      e.stopPropagation();
      this._loadXEmbed(xFacade);
      return;
    }
    /* "Show full post" — drop the height cap on a long, capped X embed. */
    const xMore = e.target.closest('.x-embed-more');
    if (xMore) {
      e.stopPropagation();
      const card = xMore.closest('.x-embed-loaded');
      if (card) card.classList.remove('x-embed-capped');
      xMore.remove();
      return;
    }
    const dexFacade = e.target.closest('.dex-embed-facade');
    if (dexFacade) {
      e.stopPropagation();
      this._loadDexEmbed(dexFacade);
      return;
    }
    /* Poll vote buttons are handled before the generic post routing. */
    const voteBtn = e.target.closest('[data-poll-vote]');
    if (voteBtn) {
      e.stopPropagation();
      this.votePoll(voteBtn.dataset.pollHash, Number(voteBtn.dataset.pollVote));
      return;
    }
    /* Community-note controls: expand/collapse the proposed-note panel, or rate. */
    const noteExpand = e.target.closest('[data-note-expand]');
    if (noteExpand) {
      e.stopPropagation();
      const ph = noteExpand.dataset.noteExpand;
      this._expandedNotes.has(ph) ? this._expandedNotes.delete(ph) : this._expandedNotes.add(ph);
      this._refreshNoteSlot(ph);
      return;
    }
    const noteRate = e.target.closest('[data-note-rate]');
    if (noteRate) {
      e.stopPropagation();
      /* A note-slot can sit inside a conversation-module parent; resolve the
         owning post via the nearest .feed-parent-item/.post-item so a rating
         targets the parent's note, not the outer reply's. */
      const host = e.target.closest('.feed-parent-item, .post-item');
      this.rateNote(noteRate.dataset.noteRate, noteRate.dataset.noteVal, host?.dataset.txhash);
      return;
    }
    const action = e.target.closest('[data-action]')?.dataset.action;
    const item   = e.target.closest('.feed-parent-item, .post-item');
    if (!item) return;
    const post = this._postMap.get(item.dataset.txhash) || this._parentCache?.get(item.dataset.txhash);
    if (!post) return;

    if (action === 'expand') {
      e.stopPropagation();
      this.state.expanded.has(post.txHash)
        ? this.state.expanded.delete(post.txHash)
        : this.state.expanded.add(post.txHash);
      /* Re-render ONLY this post in place. A full renderFeed() would
         re-virtualize from the top and re-placeholder posts past the initial
         mount window, so expanding a post far down the feed appeared to do
         nothing (and jumped scroll). Swap this item's content and re-measure. */
      const m = this._vfMaps || {};
      item.innerHTML = this.postHTML(post, inModal, m.replyMap, m.likeMap, m.repostMap, m.engagerMap);
      if (this._vfHeightMap) this._vfHeightMap.set(post.txHash, item.offsetHeight);
      this._wireVideoObserver?.(item);
    } else if (action === 'reply') {
      e.stopPropagation();
      this.openReplyModal(post);
    } else if (action === 'tip') {
      e.stopPropagation();
      this.openTipModal(post);
    } else if (action === 'join-space') {
      e.stopPropagation();
      /* Already in this room? Expand the dock; otherwise show the preview. */
      if (this._spaceRoom && this._spaceRoomPost?.txHash === post.txHash) this._expandSpaceDock();
      else this.openSpacePreview(post);
    } else if (action === 'like') {
      e.stopPropagation();
      this.toggleLike(post, item);
    } else if (action === 'repost') {
      e.stopPropagation();
      this.openRepostChoice(post, e.target.closest('.act-btn'));
    } else if (action === 'bookmark') {
      e.stopPropagation();
      this.toggleBookmark(post, item);
    } else if (action === 'share') {
      e.stopPropagation();
      this.sharePost(post);
    } else if (action === 'mute') {
      e.stopPropagation();
      this.muteAddress(post.reporter);
    } else if (action === 'menu') {
      e.stopPropagation();
      /* Anchor to the actual ⋯ button. e.currentTarget is the delegated
         listener host (#feed), which made the menu open against the whole
         feed's rect instead of the button. */
      this.openPostMenu(post, e.target.closest('[data-action="menu"]') || e.target.closest('.post-menu-btn'));
    } else if (!action && !inModal && !e.target.closest('a') && !e.target.closest('button')) {
      /* Don't open threads for pure reaction posts — they have no body to display */
      if (post.postType === 'like' || post.postType === 'follow') return;
      this.openThread(post);
    }
  }

  setFeedTab(tab) {
    document.querySelectorAll('.feed-tab').forEach(t => t.classList.remove('active'));
    this.g(tab === 'foryou' ? 'tab-foryou' : 'tab-following').classList.add('active');
    if (tab === 'following') {
      if (!this.signer) { utils.toast('Connect wallet to see Following feed'); return; }
      if (this.state.following.size === 0) {
        utils.toast('Follow some accounts first to see their posts here');
        this.g('tab-foryou').classList.add('active');
        this.g('tab-following').classList.remove('active');
        return;
      }
      this.state.searchTerm = '';
      this._followingFilter = true;
      /* Show what we have immediately, then fetch fresh posts from followed
         addresses in parallel (up to 5 concurrent). */
      this.renderFeed();
      this._fetchFollowingFeed();
    } else {
      this._followingFilter = false;
      this.state.searchTerm = '';
      this.g('search-input').value = '';
      this._updateSearchClearBtn();
      this.renderFeed();
    }
  }

  async _fetchFollowingFeed() {
    /* Cancel any in-flight following fetch from a previous tab click */
    const myToken = (this._followingFetchToken = (this._followingFetchToken || 0) + 1);
    /* 200 followed addresses — generous cap for the parallel fetch strategy */
    const addrs = [...this.state.following].slice(0, 200);
    if (!addrs.length) return;
    /* Skip only posts that already RENDER in the Following view (current
       state.posts + the extra store). NOT _postHashSet — that set keeps every
       hash ever loaded, including posts long since capped out of state.posts,
       which made their authors silently vanish from the Following feed over
       a long session. */
    const known = new Set(this.state.posts.map(p => p.txHash));
    if (this._followingExtra) for (const h of this._followingExtra.keys()) known.add(h);
    let newPosts = [];
    /* Fetch pages from each followed address, 5 addresses at a time.
       Page count per address: 1 for small scan depth, up to 3 for larger.
       Keeps total API calls bounded: 200 addrs * 3 pages * 5 concurrent = manageable. */
    const scanLimit  = this._getMaxScanPages();
    const pagesPerAddr = scanLimit === Infinity ? 3 : Math.min(3, Math.ceil(scanLimit / 30));
    /* Global follows: a followed address is the same identity on every EVM
       chain, so scan their posts across all enabled chains (one page each on
       non-canonical chains to bound cost). Empty extra set → canonical only,
       unchanged. */
    const fExtraChains = (this._getSettings().enabledChains || [])
      .map(Number).filter(id => id !== CANONICAL_CHAIN_ID && chainCfg(id));
    const BATCH = 5;
    const totalBatches = Math.ceil(addrs.length / BATCH);
    const startedAt = Date.now();
    /* Format mm:ss elapsed for the progress banner */
    const fmtElapsed = () => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      const m = Math.floor(s / 60), r = s % 60;
      return m > 0 ? `${m}m ${r}s` : `${s}s`;
    };
    let batchNum = 0;
    for (let i = 0; i < addrs.length; i += BATCH) {
      batchNum++;
      /* Show live progress in the feed while loading */
      const progBanner = this.g('feed')?.querySelector('.following-progress');
      if (!progBanner && this._followingFilter) {
        const banner = document.createElement('div');
        banner.className = 'following-progress';
        banner.style.cssText = 'padding:10px 16px;font-size:13px;color:var(--muted);border-bottom:1px solid var(--border)';
        /* Spinner + status span: per-batch updates touch only the status
           span so the spinner isn't wiped and restarted each batch. */
        banner.innerHTML = '<span class="spinner sp-sm" aria-hidden="true"></span><span class="fp-status"></span>';
        this.g('feed')?.insertAdjacentElement('afterbegin', banner);
      }
      const prog = this.g('feed')?.querySelector('.following-progress .fp-status')
                || this.g('feed')?.querySelector('.following-progress');
      const done = Math.min(batchNum * BATCH, addrs.length);
      if (prog) {
        prog.textContent = `Loading following feed… ${done}/${addrs.length} addresses • ${fmtElapsed()} elapsed`;
      }
      const batch = addrs.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async addr => {
          const all = [];
          /* Canonical chain: sent-only fetch first (guarantees the account's
             own latest posts even when received engagement floods their mixed
             txlist); fall back to compat txlist pages. Tag each tx's origin
             chain so _parsePostTx stamps the right chainId. */
          const sent = await this._apiFetchSentTxs(addr);
          if (sent) { sent.forEach(t => { t._chainId = CANONICAL_CHAIN_ID; }); all.push(...sent); }
          else {
            for (let pg = 1; pg <= pagesPerAddr; pg++) {
              try {
                const r = await this.apiFetch(addr, pg, CANONICAL_CHAIN_ID);
                r.forEach(t => { t._chainId = CANONICAL_CHAIN_ID; });
                all.push(...r);
                if (r.length < 50) break;
                if (pg < pagesPerAddr) await this._scanDelay(100);
              } catch { break; }
            }
          }
          /* Other enabled chains: a couple of txlist pages each. Etherscan v2
             has no sent-only filter (unlike PulseChain's Blockscout v2), so an
             active account's own posts can be buried under received engagement
             in a single page — scan a few, stop early at end-of-history. Their
             own posts are filtered by reporter below; received txs dropped. */
          for (const cid of fExtraChains) {
            for (let pg = 1; pg <= 2; pg++) {
              let r;
              try { r = await this.apiFetch(addr, pg, cid); }
              catch { break; }
              r.forEach(t => { t._chainId = cid; });
              all.push(...r);
              if (r.length < 50) break;
            }
          }
          return all;
        })
      );
      results.forEach((res, j) => {
        if (res.status !== 'fulfilled') return;
        const addr = batch[j];
        // Robust flatten: pages array may be nested in some API responses
        let txList = res.value || [];
        if (Array.isArray(txList) && txList.length > 0 && Array.isArray(txList[0])) {
          txList = txList.flat();
        }
        txList.forEach(tx => {
          const hash = tx.hash?.toLowerCase();
          if (!hash || known.has(hash)) return;
          if (!tx.input || tx.input === '0x') return;
          const parsed = this._parsePostTx(tx, { mode: 'main', chainId: tx._chainId || CANONICAL_CHAIN_ID });
          if (!parsed) return;
          /* Only the followed account's OWN posts — their txlist also contains
             received txs authored by others. But any destination channel is
             fine: a followed account's posts and replies belong in Following
             wherever they posted them (matches X). The old to===main-or-self
             restriction silently dropped their posts to other channels and
             inboxes, which was a root cause of "Following shows only one
             account". Content filters still apply at render. */
          if (parsed.reporter?.toLowerCase() !== addr.toLowerCase()) return;
          known.add(hash);
          newPosts.push(parsed);
        });
      });
    }
    /* Remove progress banner */
    this.g('feed')?.querySelector('.following-progress')?.remove();
    if (!newPosts.length) return;
    if (myToken !== this._followingFetchToken) return;
    /* Store following-only posts SEPARATELY so they show in the Following feed
       but never leak into the For You (main-channel) timeline. */
    this._followingExtra = this._followingExtra || new Map();
    newPosts.forEach(p => this._followingExtra.set(p.txHash, p));
    /* Cap the store so a long session can't grow it without bound. */
    if (this._followingExtra.size > 1000) {
      const keys = [...this._followingExtra.keys()];
      for (let k = 0; k < keys.length - 1000; k++) this._followingExtra.delete(keys[k]);
    }
    if (newPosts.some(pp => pp.poll)) setTimeout(() => this._tallyVisiblePolls(), 150);
    await this.cache.savePosts(newPosts);
    if (this._followingFilter && myToken === this._followingFetchToken) {
      this.renderFeed();
      utils.toast(`Loaded ${newPosts.length} new post${newPosts.length>1?'s':''} from follows`);
    }
  }

  filterByTag(tag) {
    this.state.activeTag  = tag;
    this._setRoute('/tag/' + encodeURIComponent(tag));
    this.state.searchTerm = '#' + tag;
    this.g('search-input').value = '#' + tag;
    this._updateSearchClearBtn();
    this.renderFeed();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* Search a trend term from the sidebar "What's happening" card (visible on
     any page). #tags use the tag filter; plain words do a text search. Routes
     through Home first when on a self-managed view (Explore, Profile, …) where
     renderFeed() no-ops, so results actually appear. */
  _searchTrend(term) {
    term = (term || '').trim();
    if (!term) return;
    const run = () => {
      if (term.startsWith('#')) { this.filterByTag(term.slice(1)); return; }
      this.state.activeTag  = null;
      this.state.searchTerm = term.toLowerCase();
      const si = this.g('search-input');
      if (si) si.value = term;
      this._updateSearchClearBtn?.();
      this.renderFeed();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    if (this._selfManagedModes.has(this.state.mode)) {
      const r = this.goHome();
      (r && r.then) ? r.then(run) : run();
    } else {
      run();
    }
  }

  openComposeModal() {
    const existing = this.g('compose-text').value;
    this.g('modal-compose-text').value = existing;
    utils.autoGrow(this.g('modal-compose-text'));
    utils.updateCharCount(this.g('modal-compose-text'), this.g('modal-char-count'));
    this._syncPostBtn();
    this.g('modal-compose-avatar').src = this.state.profile.picUrl || 'image1.jpeg';
    this.g('compose-modal').classList.add('open');
    this._trapFocus(this.g('compose-modal'));
    setTimeout(() => this.g('modal-compose-text').focus(), 100);
  }

  async publishFromModal() {
    const text = this.g('modal-compose-text').value.trim();
    if (!text) return;
    this.g('compose-text').value = text;
    const ok = await this.publishPost(this._composerChainFrom('modal-compose-chain'));
    if (ok) {
      this.closeModal('compose-modal');
      this.g('modal-compose-text').value = '';
      this._syncPostBtn();
    }
  }

  async goHome() {
    this._updateTitle('Home');
    this._setRoute('/home');
    if (this.state.mode === 'main' && this.state.channel === MAIN_CHANNEL) {
      if (this.state.searchTerm || this.state.activeTag) {
        this.state.searchTerm = '';
        this.state.activeTag  = null;
        const si = this.g('search-input');
        if (si) si.value = '';
        this._updateSearchClearBtn();
        this.renderFeed();
      }
      window.scrollTo({ top: 0, behavior: 'smooth' }); return;
    }
    this.setNav('nav-home','home');
    this.state.mode    = 'main';
    this.state.channel = MAIN_CHANNEL;
    /* Clear any stale search from a prior view so the home feed isn't
       filtered by it and the search box doesn't keep the old query. */
    this._clearSearch();
    /* Home: tabs are the sticky top element, no title header */
    this.g('feed-tabs').style.display      = 'flex';
    this.g('feed-tabs').classList.add('tabs-sticky');
    this.g('compose-area').style.display   = 'flex';
    this.g('channel-banner').style.display = 'none';
    this._pendingPageHeader = null;
    /* Clear feed immediately so previous page's content doesn't flash */
    const homeF = this.g('feed');
    if (homeF) homeF.innerHTML = '';
    this.setChActive('ch-main');
    this.updateChLabel();
    await this.resetAndFetch();
  }

  /* Scan for poll-related notifications:
       - 'vote': someone voted on a poll I created (VOTE tx to my poll's
         channel targeting my poll hash, from someone other than me).
       - 'pollend': a poll I created or voted in has ended since last check.
     Returns an array of notif objects shaped like the inbound ones. */
  async _scanPollNotifications() {
    const me = this.state.signerAddr;
    if (!me) return [];
    const lastCheck = parseInt(utils.safeLS.get(LAST_CHECK_KEY, '0'), 10);
    const notifs = [];

    /* Collect my polls (authored by me) and polls I voted in, from loaded
       state + IDB cache. We need their hashes + channels. */
    const myPolls = new Map();   /* pollHash → { post } authored by me */
    const votedPolls = new Map();/* pollHash → { post } I voted in (any author) */
    const allCached = await this.cache.getPosts(() => true).catch(() => []);
    const pool = [...this.state.posts, ...allCached];
    const seenPoll = new Set();
    for (const p of pool) {
      if (p.postType !== 'poll' || !p.poll) continue;
      if (seenPoll.has(p.txHash)) continue;
      seenPoll.add(p.txHash);
      if (p.reporter === me) myPolls.set(p.txHash, p);
    }
    if (myPolls.size === 0) return [];

    /* Scan each channel hosting one of my polls for VOTE txs. Group polls
       by channel to minimize scans. */
    const channels = new Set();
    for (const p of myPolls.values()) channels.add((p.to || p.channel || MAIN_CHANNEL));
    const voteSeen = new Set(); /* dedupe by tx hash */
    for (const channel of channels) {
      const scanLimit = Math.min(this._getMaxScanPages(), 10);
      for (let page = 1; page <= scanLimit; page++) {
        let raw;
        try { raw = await this.apiFetch(channel, page); }
        catch { break; }
        let recentEnough = true;
        for (const tx of raw) {
          if (!tx.input || tx.input === '0x') continue;
          const voter = tx.from?.toLowerCase();
          if (!voter || voter === me) continue; /* skip my own votes */
          let text;
          try { text = ethers.toUtf8String(tx.input).trim(); }
          catch { continue; }
          if (!text.startsWith(VOTE_PREFIX)) continue;
          const m = text.match(/^VOTE:(0x[a-f0-9]{64}):(\d+)/i);
          if (!m) continue;
          const pollHash = m[1].toLowerCase();
          if (!myPolls.has(pollHash)) continue;
          const ts = tx.timeStamp ? Number(tx.timeStamp) * 1000 : Date.now();
          if (ts <= lastCheck) { recentEnough = false; continue; } /* older than last check */
          const hash = tx.hash.toLowerCase();
          if (voteSeen.has(hash)) continue;
          voteSeen.add(hash);
          const poll = myPolls.get(pollHash).poll;
          const optIdx = Number(m[2]);
          const optLabel = poll.options[optIdx] || '';
          notifs.push({
            type: 'vote', from: voter, target: pollHash,
            preview: `voted "${optLabel}" on: ${poll.question.slice(0, 60)}`,
            timestamp: new Date(ts).toISOString(), txHash: hash,
          });
        }
        if (raw.length < 50) break;
        if (!recentEnough && page > 2) break; /* mostly old votes — stop */
      }
    }

    /* Poll-ended notifications: my polls whose end time passed since the
       last check. One synthetic notif each. */
    for (const [hash, p] of myPolls) {
      if (!p.poll.endMs) continue;
      if (p.poll.endMs <= Date.now() && p.poll.endMs > lastCheck) {
        notifs.push({
          type: 'pollend', from: me, target: hash,
          preview: `Your poll ended: ${p.poll.question.slice(0, 70)}`,
          timestamp: new Date(p.poll.endMs).toISOString(), txHash: hash,
        });
      }
    }
    return notifs;
  }

  /* Show the disclaimer on first visit (or when reopened from the footer).
     forceShow=true bypasses the "already acknowledged" check so the footer
     link always works. */
  _maybeShowDisclaimer(forceShow = false) {
    if (!forceShow && utils.safeLS.get(DISCLAIMER_KEY) === '1') return;
    this.showDisclaimer(forceShow);
  }

  showDisclaimer(alreadyAck = false) {
    const body = `
      <div class="disclaimer-body">
        <p><strong>Say It DeFi is an open, decentralized front-end.</strong>
        It is a web interface to a public, permissionless social protocol that lives on multiple EVM chains by default (PulseChain + Ethereum + Base + BSC).</p>

        <p>All posts, replies, polls, votes, profiles, and other content are
        created by users and written directly to the blockchain by their own
        wallets. They are <strong>public, permanent, and immutable</strong> —
        no one, including the creators of this interface, can edit or delete
        them once they are on-chain.</p>

        <p>This site does <strong>not</strong> host, store, control, moderate,
        endorse, or verify any content. It only reads what already exists on
        the blockchain and displays it. The creators and operators of this
        interface are <strong>not responsible or liable</strong> for any
        content posted by users, for how you use the protocol, or for any
        transactions you choose to broadcast from your wallet.</p>

        <p>You are solely responsible for your own actions, your wallet, your
        keys, and anything you post. On-chain transactions cost gas and cannot
        be reversed. Nothing here is financial, legal, or investment advice.</p>

        <p><strong>Privacy.</strong> This interface sets no cookies and runs
        no analytics or tracking services. Everything it stores (caches,
        settings, archives) stays in your browser. For the best experience,
        videos and YouTube/Vimeo previews <strong>autoplay muted by
        default</strong> — loading an embed connects you to that provider
        and is subject to their cookies. Prefer zero third-party contact?
        Turn it off any time in <strong>Settings → Privacy</strong> (or
        enable Data saver). Your IP is otherwise visible only to the
        infrastructure that serves you: the static host, the explorer API
        you configure, and hosts of media you choose to view.</p>

        <p><strong>Original, independent software.</strong> This application
        was built from scratch as free, open-source software. It is not
        affiliated with, endorsed by, or derived from any other platform or
        company; any resemblance to other applications is purely coincidental
        and limited to familiar user-interface conventions. The source code is
        public and may be freely inspected, shared, and built upon.</p>

        <p>By continuing to use this interface, you acknowledge and agree to
        the above, and you agree that the creators and operators are not liable
        for anything posted or done on the underlying decentralized network.

        <strong>Default Network.</strong> Your default posting network is set
        automatically the first time you connect your wallet. You can change
        it anytime in <strong>Settings → Networks</strong>. The main feed
        aggregates posts from all supported networks regardless of your
        default.</p>
      </div>
      <div class="btn-row" style="margin-top:16px;justify-content:flex-end">
        ${alreadyAck
          ? '<button class="btn-pri" id="disclaimer-close">Close</button>'
          : '<button class="btn-pri" id="disclaimer-agree">I Understand &amp; Agree</button>'}
      </div>`;
    this._showGenericModal('Welcome to Say It DeFi', body);
    const agree = document.getElementById('disclaimer-agree');
    if (agree) agree.onclick = () => {
      utils.safeLS.set(DISCLAIMER_KEY, '1');
      this._closeGenericModal();
    };
    const close = document.getElementById('disclaimer-close');
    if (close) close.onclick = () => this._closeGenericModal();
  }

  /* Keyboard shortcuts help overlay (press ?). Lists the shortcuts that
     already exist so they're discoverable, like X's help dialog. */
  showShortcutsHelp() {
    const groups = [
      { title: 'Navigation', items: [
        ['g then h', 'Go to Home'],
        ['g then n', 'Go to Notifications'],
        ['g then p', 'Open your Profile'],
        ['g then s', 'Go to your Channel'],
        ['g then b', 'Go to Bookmarks'],
        ['/', 'Focus search'],
      ]},
      { title: 'Compose', items: [
        ['n', 'New post'],
        ['e', 'Open the expanded composer'],
      ]},
      { title: 'Timeline', items: [
        ['j', 'Next post'],
        ['k', 'Previous post'],
        ['Enter', 'Open the focused post'],
      ]},
      { title: 'Actions on the focused post', items: [
        ['l', 'Like'],
        ['r', 'Reply'],
        ['t', 'Repost / Quote'],
        ['b', 'Bookmark'],
        ['u', 'Copy link to post'],
      ]},
      { title: 'General', items: [
        ['?', 'Show this help'],
        ['Esc', 'Close dialogs / popups'],
      ]},
    ];
    const body = groups.map(gr => `
      <div class="ks-group">
        <div class="ks-group-title">${gr.title}</div>
        ${gr.items.map(([key, desc]) => `
          <div class="ks-row">
            <span class="ks-desc">${desc}</span>
            <span class="ks-keys">${key.split(' then ').map(k =>
              `<kbd>${k}</kbd>`).join('<span class="ks-then">then</span>')}</span>
          </div>`).join('')}
      </div>`).join('');
    this._showGenericModal('Keyboard shortcuts', `<div class="ks-wrap">${body}</div>`);
  }

  /* Accumulate a like/reply/repost seen during a feed scan, keyed by its tx
     hash. Bounded to ~300 recent entries so memory stays flat on busy
     channels. _engagementNotifs() later filters these to the ones targeting
     the signed-in user's posts — so engagement notifications cost no extra API
     calls (they ride along with the feed scan, like poll-vote tallies). */
  _recordEngagement(type, from, target, preview, tx) {
    if (!type || !from || !target) return;
    const me = this.state.signerAddr;
    if (me && from === me) return;            /* never notify yourself */
    const txHash = tx.hash?.toLowerCase();
    if (!txHash) return;
    this._engagementAccum = this._engagementAccum || new Map();
    if (this._engagementAccum.has(txHash)) return;
    const ts = tx.timeStamp ? Number(tx.timeStamp) * 1000 : Date.now();
    this._engagementAccum.set(txHash, { type, from, target, preview: preview || '', ts, txHash });
    if (this._engagementAccum.size > 400) {
      /* Bulk-trim to the 300 newest (cheap, runs only once per 100 over cap). */
      const keep = [...this._engagementAccum.values()].sort((a, b) => b.ts - a.ts).slice(0, 300);
      this._engagementAccum = new Map(keep.map(e => [e.txHash, e]));
    }
  }

  /* Turn accumulated engagement into notifications for likes/replies/reposts
     that target MY posts. My post hashes come from loaded state + the IDB
     cache (no network). Returns [] when nothing matches. */
  async _engagementNotifs() {
    const me = this.state.signerAddr;
    if (!me || !this._engagementAccum || this._engagementAccum.size === 0) return [];
    const mine = new Set();
    this.state.posts.forEach(p => { if (p.reporter === me) mine.add(p.txHash); });
    try {
      const cached = await this.cache.getPosts(p => p.reporter === me);
      cached.forEach(p => mine.add(p.txHash));
    } catch { /* IDB unavailable — use in-memory posts only */ }
    if (!mine.size) return [];
    const out = [];
    for (const e of this._engagementAccum.values()) {
      if (!mine.has(e.target)) continue;
      out.push({
        type: e.type, from: e.from, target: e.target, preview: e.preview || '',
        timestamp: new Date(e.ts).toISOString(), txHash: e.txHash,
      });
    }
    return out;
  }

  async goNotifications() {
    this._updateTitle('Notifications');
    this._setRoute('/notifications');
    this.setNav('nav-notifs','notifs');
    const navToken = this._navToken; /* if this changes, user navigated away */
    this.g('feed-tabs').classList.remove('tabs-sticky');
    this.g('feed-tabs').style.display      = 'none';
    this.g('compose-area').style.display   = 'none';
    this.g('channel-banner').style.display = 'none';
    /* Inject sticky header at top of feed */
    this._pendingPageHeader = this._makePageHeader({
      title: 'Notifications', noBack: true });
    this.g('new-banner').classList.remove('visible');
    this.g('loading-more').style.display   = 'none';
    this.state.mode = 'notifications';
    /* No wallet → render the standard page chrome with a connect prompt
       (previously this returned silently, leaving the prior page on screen). */
    if (!this.signer) {
      this.g('feed').innerHTML = this._applyPageHeader() +
        `<div class="prof-empty"><h3>Connect your wallet</h3>
        <p style="color:var(--muted)">Notifications show likes, replies, reposts, follows and tips for your account.</p></div>`;
      return;
    }
    /* NOTE: don't stamp LAST_CHECK_KEY here — _scanPollNotifications reads it to
       window vote/poll-end notifications, so writing "now" before the scan made
       that window empty every time. We stamp it AFTER the scan (below). */
    this.clearNotifBadge();

    if (navToken !== this._navToken) return;
    this.g('feed').innerHTML = this._applyPageHeader() +
      `<div class="prof-empty"><div class="spinner" aria-hidden="true"></div><h3>Loading notifications…</h3></div>`;

    try {
      const allNotifs = [];
      /* Respect user's scan-depth setting but cap at 10 pages (500 txs) —
         notifications only need recent inbound messages. */
      const notifLimit = Math.min(this._getMaxScanPages(), 10);
      for (let page = 1; page <= notifLimit; page++) {
        let raw;
        try { raw = await this.apiFetch(this.state.signerAddr, page); }
        catch { break; }
        raw.forEach(tx => {
          const from = tx.from?.toLowerCase();
          const to   = tx.to?.toLowerCase();
          if (to !== this.state.signerAddr || from === this.state.signerAddr) return;
          if (!tx.input || tx.input === '0x') return;
          try {
            const text = ethers.toUtf8String(tx.input).trim();
            if (text.startsWith(PROFILE_PREFIX)) return;
            if (text.startsWith(BOOKMARK_PREFIX) || text.startsWith(UNBOOKMARK_PREFIX)) return;
            if (text.startsWith(UNLIKE_PREFIX)) return;
            if (text.startsWith(DMKEY_PREFIX)) return; /* key publication — not a notification */
            const ts = tx.timeStamp ? new Date(Number(tx.timeStamp)*1000).toISOString() : new Date().toISOString();
            /* Encrypted DM — notify without decrypting the ciphertext (the
               Messages view decrypts on open); click opens that conversation. */
            if (text.startsWith(DM_PREFIX)) {
              allNotifs.push({ type: 'dm', from, target: from, preview: '', timestamp: ts, txHash: tx.hash.toLowerCase() });
              return;
            }
            let type = 'message', target = null, preview = '';
            if (text.startsWith(LIKE_PREFIX)) {
              type = 'like'; target = utils.refHash(text.slice(LIKE_PREFIX.length));
            } else if (text.startsWith(FOLLOW_PREFIX)) {
              type = 'follow'; target = text.slice(FOLLOW_PREFIX.length).trim().toLowerCase();
            } else if (text.startsWith(UNFOLLOW_PREFIX)) {
              return; /* skip unfollows from notifications */
            } else if (text.match(/^REPLY_TO:(0x[a-f0-9]{64})\n\n/i)) {
              type = 'reply';
              const m = text.match(/^REPLY_TO:(0x[a-f0-9]{64})\n\n/i);
              target  = m[1].toLowerCase();
              preview = text.slice(m[0].length).trim().slice(0, 100);
            } else if (text.match(/^REPOST:(?:eip155:\d+:)?(0x[a-f0-9]{64})/i)) {
              type = 'repost';
              const m = text.match(/^REPOST:(?:eip155:\d+:)?(0x[a-f0-9]{64})/i);
              target  = m[1].toLowerCase();
            } else if (text.startsWith(TIP_PREFIX)) {
              const t = text.slice(TIP_PREFIX.length).trim().toLowerCase();
              if (!/^0x[a-f0-9]{64}$/.test(t)) return; /* malformed tip — drop */
              type = 'tip'; target = t;
              preview = `${utils.fmtPLS(tx.value)} PLS`;
            } else {
              type = 'message'; preview = text.slice(0, 100);
            }
            allNotifs.push({ type, from, target, preview, timestamp: ts, txHash: tx.hash.toLowerCase() });
          } catch { /* skip */ }
        });
        if (raw.length < 50) break;
      }

      /* Poll notifications: votes on my polls + polls I voted in that ended.
         Votes are channel txs (not inbound), so scan separately. */
      try {
        const pollNotifs = await this._scanPollNotifications();
        if (pollNotifs.length) allNotifs.push(...pollNotifs);
      } catch (err) { console.warn('Poll notif scan:', err); }

      /* Likes/replies/reposts on my posts — gathered for free from feed scans
         (no extra channel scan), matched against my posts here. */
      try {
        const eng = await this._engagementNotifs();
        if (eng.length) allNotifs.push(...eng);
      } catch (err) { console.warn('Engagement notif:', err); }

      /* Dedupe by tx hash, then sort newest-first. */
      const _seenNotif = new Set();
      const _deduped = allNotifs.filter(n => n.txHash && !_seenNotif.has(n.txHash) && _seenNotif.add(n.txHash));
      _deduped.sort((a, b) => (b._tsMs ??= new Date(b.timestamp).getTime()) - (a._tsMs ??= new Date(a.timestamp).getTime()));
      allNotifs.length = 0;
      allNotifs.push(..._deduped);

      /* User navigated away while we were scanning — don't paint over the
         new view (this caused a flash of Notifications when returning Home). */
      if (navToken !== this._navToken) return;

      /* Scan succeeded and we're still here → mark everything up to now as seen
         (the scanners above used the PREVIOUS value to build their windows). */
      utils.safeLS.set(LAST_CHECK_KEY, Date.now().toString());

      /* Cache the parsed notifs so tab switching filters in place without
         rescanning the chain. Always render via _renderNotifs so the All /
         Verified / Mentions / Likes tab bar shows even when empty (X parity). */
      this._notifs = allNotifs;
      this._notifTab = this._notifTab || 'all';
      this._renderNotifs();
      if (!allNotifs.length) return;

      /* Lazy-refresh avatars/names once profiles load. Single non-recursive update. */
      const refreshAvatars = () => {
        if (this.state.mode !== 'notifications') return;
        document.querySelectorAll('.notif-item').forEach(item => {
          const addr = item.dataset.from;
          if (!addr) return;
          const prof = this.state.profCache[addr];
          if (prof?.picUrl) {
            const img = item.querySelector('.notif-avatar');
            if (img && img.src.endsWith('image1.jpeg') && prof.picUrl !== 'image1.jpeg') {
              img.src = prof.picUrl;
            }
          }
          if (prof?.username) {
            const nameEl = item.querySelector('.notif-name');
            if (nameEl && nameEl.textContent.startsWith('0x')) {
              nameEl.textContent = prof.username;
            }
          }
        });
      };
      /* One-shot refresh after profile fetches resolve */
      setTimeout(refreshAvatars, 1500);
      setTimeout(refreshAvatars, 4000);

    } catch (err) {
      this.g('feed').innerHTML = `<div class="prof-empty"><span>⚠️</span><h3>Error loading</h3><p>${utils.safe(err.message)}</p></div>`;
    }
  }

  /* Render notifications with the active tab filter. Tabs: All, Mentions
     (replies + reposts + messages — things addressed at you), Likes
     (likes + follows). Filters the cached this._notifs in place. */
  /* Per-type notification opt-outs (Settings → Notifications). Returns false
     when the user has muted this notification's category. vote/pollend share
     one "poll" category. */
  _notifEnabled(type) {
    const cat  = (type === 'vote' || type === 'pollend') ? 'poll' : type;
    const mute = this._getSettings().notifMute || {};
    return !mute[cat];
  }

  _renderNotifs() {
    const all = this._notifs || [];
    const tab = this._notifTab || 'all';
    const icons = { like:'❤️', follow:'👤', reply:'💬', repost:'🔁', message:'✉️', vote:'📊', pollend:'🏁', dm:'🔒' };
    const labels = {
      like:'liked your post', follow:'followed you', reply:'replied to you',
      repost:'reposted your post', message:'sent you a message',
      vote:'voted on your poll', pollend:'', tip:'tipped your post 💎',
      dm:'sent you an encrypted message',
    };
    /* Tabs partition All cleanly: Likes = plain likes; Mentions = everything
       else (replies, reposts, messages, poll votes/ends, follows). No type is
       orphaned to "All"-only. */
    const inTab = (n) => {
      if (tab === 'likes')    return n.type === 'like';
      /* Verified: same items as All, filtered to actors with an on-chain
         profile (username present in profCache). Cache-only — no fetches. */
      if (tab === 'verified') return !!this.state.profCache[n.from]?.username;
      if (tab === 'mentions') return n.type !== 'like';
      return true; /* all */
    };
    const filtered = all.filter(n => this._notifEnabled(n.type)).filter(inTab);
    const tabBar = `
      <div class="notif-tabs">
        <button class="notif-tab ${tab==='all'?'active':''}" data-notif-tab="all">All</button>
        <button class="notif-tab ${tab==='verified'?'active':''}" data-notif-tab="verified">Verified</button>
        <button class="notif-tab ${tab==='mentions'?'active':''}" data-notif-tab="mentions">Mentions</button>
        <button class="notif-tab ${tab==='likes'?'active':''}" data-notif-tab="likes">Likes</button>
      </div>`;
    let body;
    if (filtered.length === 0) {
      body = `<div class="prof-empty"><span>🔔</span><h3>Nothing here</h3><p>No ${tab==='all'?'notifications':tab} yet.</p></div>`;
    } else {
      body = '<div class="notif-list">' + filtered.map(n => {
        const time = this.relTime(n.timestamp);
        const icon = icons[n.type] || '📩';
        /* Poll-ended is a self-notification — render the preview as the
           headline with the poll hash opening the thread, no "from" user. */
        if (n.type === 'pollend') {
          return `
            <div class="notif-item" role="button" tabindex="0" data-act="open-thread" data-act-arg="${utils.safe(n.target)}">
              <div class="notif-icon-wrap">${icon}</div>
              <div class="notif-body">
                <span class="notif-label">${utils.safe(n.preview)}</span>
              </div>
              <span class="notif-time">${time}</span>
            </div>`;
        }
        const prof = this.state.profCache[n.from];
        const pic  = utils.safe(utils.safeUrl(prof?.picUrl) || 'image1.jpeg');
        const name = prof?.username ? utils.safe(prof.username) : this.trunc(n.from);
        const label = labels[n.type] || 'interacted with you';
        this.fetchOtherProfile(n.from);
        /* Engagement on a known post (vote/like/reply/repost) opens that post's
           thread in-app; types with no post target (message/follow) fall back
           to the tx on the explorer. */
        const opensThread = n.target && ['vote', 'like', 'reply', 'repost', 'tip'].includes(n.type);
        const clickAttr = n.type === 'dm'
          ? `data-act="open-dm" data-act-arg="${utils.safe(n.from)}"`        /* open the encrypted conversation */
          : opensThread
            ? `data-act="notif-open" data-act-arg="${utils.safe(n.target)}"`
            : `data-act="notif-open" data-act-arg="${utils.safe(n.txHash)}" data-act-arg2="tx"`;
        return `
          <div class="notif-item" role="button" tabindex="0" data-from="${utils.safe(n.from)}" ${clickAttr}>
            <div class="notif-icon-wrap">${icon}</div>
            <img src="${pic}" class="notif-avatar notif-pop" alt="" data-pop-addr="${utils.safe(n.from)}" data-fallback-src="image1.jpeg">
            <div class="notif-body">
              <span class="notif-name notif-pop" data-pop-addr="${utils.safe(n.from)}">${name}</span>
              <span class="notif-label"> ${label}</span>
              ${n.preview ? `<div class="notif-preview">${utils.safe(n.preview)}</div>` : ''}
            </div>
            <span class="notif-time">${time}</span>
          </div>`;
      }).join('') + '</div>';
    }
    /* Keep the page header that's already in the feed; replace the rest. */
    const headerEl = this.g('feed').querySelector('.page-header');
    const headerHTML = headerEl ? headerEl.outerHTML : this._applyPageHeader();
    this.g('feed').innerHTML = headerHTML + tabBar + body;
    /* Wire tab buttons */
    this.g('feed').querySelectorAll('[data-notif-tab]').forEach(btn => {
      btn.onclick = () => { this._notifTab = btn.dataset.notifTab; this._renderNotifs(); };
    });
    /* Profile popup on a notifier's name/avatar — click opens it; on desktop
       a 400ms hover does too. stopPropagation so the row's open-tx onclick
       doesn't also fire. */
    const list = this.g('feed').querySelector('.notif-list');
    if (list) {
      list.addEventListener('click', e => {
        const t = e.target.closest('.notif-pop');
        if (!t) return;
        e.stopPropagation();
        /* Click navigates to the profile (like the feed / X); hover still
           shows the hovercard via the mouseover handler below. */
        if (t.dataset.popAddr) {
          this.hideProfilePopup();
          this.goProfilePage(t.dataset.popAddr, t.dataset.popAddr === this.state.signerAddr);
        }
      });
      const isTouch = () => window.matchMedia('(hover: none)').matches;
      let hov = null;
      list.addEventListener('mouseover', e => {
        if (isTouch()) return;
        const t = e.target.closest('.notif-pop');
        if (!t || !t.dataset.popAddr) return;
        clearTimeout(hov);
        const addr = t.dataset.popAddr;
        hov = setTimeout(() => this.showProfilePopup(addr, t, 'hover'), 400);
      });
      list.addEventListener('mouseout', e => {
        if (isTouch()) return;
        const popup = this.g('profile-popup');
        if (popup?.contains(e.relatedTarget)) return;
        clearTimeout(hov);
      });
    }
  }

  async goSelf() {
    if (!this.signer) { utils.toast('Connect wallet to view your chat'); return; }
    this._updateTitle('My Chat');
    this._setRoute('/channel/' + this.state.signerAddr);
    this.setNav('nav-channels', 'channels'); /* "My Chat" lives under Chat now */
    this.state.mode    = 'self';
    this.state.channel = this.state.signerAddr;
    this.g('feed-tabs').classList.remove('tabs-sticky');
    this.g('feed-tabs').style.display = 'none';
    const selfTitle = this.state.profile.username || 'My Chat';
    const selfHandle = this.state.signerAddr ? '@' + this.trunc(this.state.signerAddr) : '';
    this._pendingPageHeader = this._makePageHeader({
      title: selfTitle, subtitle: selfHandle, noBack: true });
    this.g('compose-area').style.display = 'flex';
    this.setChActive('ch-self');
    this.updateChLabel();
    this.showChannelBanner(this.state.signerAddr);
    await this.resetAndFetch();
  }

  async goCustom() {
    const raw = this.g('custom-input').value.trim().toLowerCase();
    if (!ethers.isAddress(raw)) { utils.toast('Invalid address'); return; }
    this._setRoute('/channel/' + raw);
    this.setNav(null, null);
    this.state.mode    = 'custom';
    this.state.channel = raw;
    this.g('feed-tabs').classList.remove('tabs-sticky');
    this.g('feed-tabs').style.display = 'none';
    this._pendingPageHeader = this._makePageHeader({
      title: this.trunc(raw), subtitle: raw, noBack: false });
    this.g('compose-area').style.display = 'flex';
    this.setChActive(null);
    this.updateChLabel();
    this.showChannelBanner(raw);
    /* track this channel in history + mark it read (opening it = seen) */
    this._touchChannelHistory(raw);
    this._markChannelSeen(raw);
    await this.resetAndFetch();
    this._updateChannelSubtitle();
  }

  /* Search within the current channel. The global search box scopes to
     whichever feed is loaded, and a channel feed (mode 'custom', not
     self-managed) is loaded here — so focusing it filters this channel's
     posts. Mirrors the profile header's search affordance. (On phones the
     sidebar search is hidden; that's a shared limitation with the profile.) */
  _channelSearch() { this._focusSearch(); }

  /* Focus the search box. On phones the sidebar search is hidden
     (offsetParent === null), so there's nothing to focus — route to Explore's
     always-visible inline search instead of leaving a dead button. */
  _focusSearch() {
    const inp = this.g('search-input');
    if (!inp || inp.offsetParent === null) {
      this.goExplore('trending');
      setTimeout(() => this.g('explore-search-input')?.focus(), 120);
      return;
    }
    inp.focus();
    inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async goOfficialChannel() {
    this.setNav(null, null);
    this.state.mode    = 'custom';
    this.state.channel = OFFICIAL_CHANNEL;
    this.g('custom-input').value         = OFFICIAL_CHANNEL;
    this.g('feed-tabs').classList.remove('tabs-sticky');
    this.g('feed-tabs').style.display = 'none';
    this._pendingPageHeader = this._makePageHeader({
      title: 'Say It DeFi Channel', subtitle: 'Official channel', noBack: false });
    this.g('compose-area').style.display = 'flex';
    this.setChActive(null);
    this.updateChLabel();
    this.showChannelBanner(OFFICIAL_CHANNEL);
    await this.resetAndFetch();
    this._updateChannelSubtitle();
  }

  /* ── New navigation methods ─────────────────────────────────────────── */
  goExplore(tab = null) {
    this.state.exploreTab = tab || this.state.exploreTab || 'trending';
    this._updateTitle('Explore');
    this._setRoute('/explore' + (this.state.exploreTab !== 'trending' ? '/' + this.state.exploreTab : ''));
    this.setNav('nav-explore','explore');
    /* Explore renders its own trending list + search bar, so hide the sidebar
       duplicates (mirrors mode-settings; setNav clears it on every nav). */
    document.body.classList.add('mode-explore');
    this.state.mode = 'explore';
    this.g('feed-tabs').classList.remove('tabs-sticky');
    this.g('feed-tabs').style.display      = 'none';
    this.g('compose-area').style.display   = 'none';
    this.g('channel-banner').style.display = 'none';
    this._pendingPageHeader = this._makePageHeader({ title: 'Explore', noBack: true });
    this.g('loading-more').style.display   = 'none';
    const _exploreHeader = this._applyPageHeader();
    this._renderExplorePage(_exploreHeader);
  }

  /* ── Explore page (X-style: search-first, tabbed) ───────────────────────
     Tabs: Trending (frequent #hashtags + significant words from recent
     posts), People (who-to-follow), Channels (most-active channels), Latest
     (recent posts). All derived from the in-memory feed + profile cache —
     clicks route through Home because Explore is a self-managed mode where
     renderFeed() no-ops. */
  _renderExplorePage(_headerHTML = '') {
    const tab = this.state.exploreTab || 'trending';
    const tabBtn = (id, label) =>
      `<button class="explore-tab${tab === id ? ' active' : ''}" data-explore-tab="${id}" role="tab">${label}</button>`;
    this.g('feed').innerHTML = _headerHTML + `
      <div class="explore-page">
        <div class="explore-search-bar">
          <span class="search-icon" aria-hidden="true">🔎</span>
          <input type="text" id="explore-search-input" class="xp-search-input"
            placeholder="Search Say It DeFi" autocomplete="off"
            aria-label="Search posts and people">
          <button class="explore-search-clear hidden" id="explore-search-clear"
            type="button" title="Clear search" aria-label="Clear search">✕</button>
        </div>
        <div class="explore-tabs" role="tablist">
          ${tabBtn('trending', 'Trending')}
          ${tabBtn('news', 'News')}
          ${tabBtn('media', 'Media')}
          ${tabBtn('people', 'People')}
          ${tabBtn('channels', 'Channels')}
          ${tabBtn('latest', 'Latest')}
        </div>
        <div id="explore-tab-content"></div>
      </div>`;
    /* Wire tab bar, search input, and a delegated click handler for the rows
       (terms/people/channels/follow) once the DOM exists. */
    setTimeout(() => {
      const feed = this.g('feed');
      feed.querySelectorAll('[data-explore-tab]').forEach(btn => {
        btn.onclick = () => this.setExploreTab(btn.dataset.exploreTab);
      });
      const host = this.g('explore-tab-content');
      if (host) {
        host.addEventListener('click', e => {
          const fol = e.target.closest('[data-explore-follow]');
          if (fol) { e.stopPropagation(); this.toggleFollowAddr(fol.dataset.exploreFollow, fol); return; }
          const term = e.target.closest('[data-explore-term]');
          if (term) { this._exploreSearch(term.dataset.exploreTerm); return; }
          const ch = e.target.closest('[data-explore-channel]');
          if (ch) { this.g('custom-input').value = ch.dataset.exploreChannel; this.goCustom(); return; }
          const prof = e.target.closest('[data-explore-profile]');
          if (prof) { const a = prof.dataset.exploreProfile; this.goProfilePage(a, a === this.state.signerAddr); return; }
          const goto = e.target.closest('[data-explore-goto]');
          if (goto) { this.setExploreTab(goto.dataset.exploreGoto); return; }
        });
      }
      this._wireExploreSearch();
    }, 0);
    this._renderExploreTab(tab);
  }

  setExploreTab(tab) {
    /* Switching tabs exits any active search. */
    const inp = this.g('explore-search-input');
    if (inp) inp.value = '';
    const clr = this.g('explore-search-clear');
    if (clr) clr.classList.add('hidden');
    this._exploreSearchToken = (this._exploreSearchToken || 0) + 1; /* cancel pending IDB search */
    this.state.exploreTab = tab;
    this._setRoute('/explore' + (tab !== 'trending' ? '/' + tab : ''));
    const feed = this.g('feed');
    feed.querySelectorAll('[data-explore-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.exploreTab === tab);
    });
    this._renderExploreTab(tab);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  _renderExploreTab(tab) {
    const host = this.g('explore-tab-content');
    if (!host) return;
    if (tab === 'news')          host.innerHTML = this._exploreNewsHTML();
    else if (tab === 'media')     host.innerHTML = this._exploreMediaHTML();
    else if (tab === 'people')   host.innerHTML = this._explorePeopleHTML();
    else if (tab === 'channels') host.innerHTML = this._exploreChannelsHTML();
    else if (tab === 'latest')   this._exploreRenderLatest(host);
    else                         host.innerHTML = this._exploreTrendingHTML();
  }

  /* Run a search/term from Explore (trending tap or a typed query). Results
     render INLINE on the Explore page — we no longer yank the user back to the
     main feed or echo the query into the sidebar search box. */
  _exploreSearch(term) {
    term = (term || '').trim();
    if (!term) return;
    const inp = this.g('explore-search-input');
    if (inp) inp.value = term;
    this._exploreApplySearch(term);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* Apply the Explore search box: a term shows results in the tab-content
     area; an empty term restores the active tab. */
  _exploreApplySearch(term) {
    term = (term || '').trim();
    const host = this.g('explore-tab-content');
    if (!host) return;
    const clr = this.g('explore-search-clear');
    if (clr) clr.classList.toggle('hidden', !term);
    const tabs = this.g('feed').querySelectorAll('[data-explore-tab]');
    if (!term) {
      const active = this.state.exploreTab || 'trending';
      tabs.forEach(b => b.classList.toggle('active', b.dataset.exploreTab === active));
      this._renderExploreTab(active);
      return;
    }
    /* Searching → results aren't a tab, so drop the tab highlight. */
    tabs.forEach(b => b.classList.remove('active'));
    this._exploreRenderResults(host, term);
  }

  /* Filter loaded posts by the term (text or #tag), falling back to the IDB
     trigram index when nothing matches in memory. */
  _exploreRenderResults(host, term) {
    const lc = term.toLowerCase();
    const isTag = lc.startsWith('#');
    const inMem = this.state.posts.filter(p => {
      if (p.postType && p.postType !== 'post') return false;
      if (!p.display) return false;
      if (isTag) return p.display.toLowerCase().includes(lc);
      return p.display.toLowerCase().includes(lc) || p.reporter?.toLowerCase().includes(lc);
    });
    this._exploreRenderPostList(host, inMem, term);
    const token = (this._exploreSearchToken = (this._exploreSearchToken || 0) + 1);
    if (!inMem.length && !isTag && term.length >= 3) {
      this.cache.searchByText(term).then(hashes => {
        if (token !== this._exploreSearchToken || this.state.mode !== 'explore') return;
        if (!hashes?.length) return;
        return Promise.all(hashes.map(h => new Promise(res => {
          const req = this.cache._db?.transaction('posts', 'readonly')?.objectStore('posts')?.get(h);
          if (req) { req.onsuccess = () => res(req.result); req.onerror = () => res(null); } else res(null);
        }))).then(found => {
          if (token !== this._exploreSearchToken || this.state.mode !== 'explore') return;
          const posts = (found || []).filter(Boolean);
          if (posts.length) this._exploreRenderPostList(host, posts, term);
        });
      }).catch(() => {});
    }
  }

  _exploreRenderPostList(host, posts, term) {
    if (!posts.length) {
      host.innerHTML = `<div class="explore-empty">No results for “${utils.safe(term)}”.<br>Try another word, #tag, or address.</div>`;
      return;
    }
    const sorted = posts.slice()
      .sort((a, b) => (b._tsMs ??= new Date(b.timestamp).getTime()) - (a._tsMs ??= new Date(a.timestamp).getTime()));
    this._exploreRenderPaged(host, sorted, `Results for “${term}”`);
  }

  /* Render a sorted post list into an Explore host with incremental
     "Load more" (no more hard 20/30 cap). headText is an optional results
     header. State lives on _exploreList so the button can append the next
     batch in place. */
  _exploreRenderPaged(host, sorted, headText) {
    this._exploreList = { sorted, host, shown: 0, headText: headText || '' };
    host.innerHTML = '';
    this._exploreLoadMore();
  }
  _exploreLoadMore() {
    const st = this._exploreList;
    if (!st || !st.host) return;
    const PAGE = 30;
    const { sorted, host } = st;
    host.querySelector('.explore-load-more')?.remove();
    if (st.shown === 0 && st.headText) {
      const head = document.createElement('div');
      head.className = 'explore-results-head';
      head.textContent = st.headText;
      host.appendChild(head);
    }
    const next = sorted.slice(st.shown, st.shown + PAGE);
    const frag = document.createDocumentFragment();
    next.forEach(post => {
      this._postMap.set(post.txHash, post);
      const el = document.createElement('div');
      el.className = 'post-item';
      el.dataset.txhash = post.txHash;
      el.innerHTML = this.postHTML(post, false, null);
      frag.appendChild(el);
    });
    host.appendChild(frag);
    st.shown += next.length;
    next.forEach(p => { if (p.reporter !== this.state.signerAddr) this.fetchOtherProfile(p.reporter); });
    if (st.shown < sorted.length) {
      const btn = document.createElement('button');
      btn.className = 'settings-btn explore-load-more';
      btn.style.cssText = 'display:block;margin:16px auto';
      btn.textContent = `Load more (${sorted.length - st.shown})`;
      btn.onclick = () => this._exploreLoadMore();
      host.appendChild(btn);
    }
  }

  /* Fetch profiles for a set of addresses (once each), then re-render the tab
     so real names/avatars replace truncated addresses. _exploreProfTried stops
     addresses with no on-chain profile from looping forever. */
  _exploreResolveProfiles(addrs, tab) {
    this._exploreProfTried = this._exploreProfTried || new Set();
    const todo = addrs.filter(a => !this.state.profCache[a]?.username && !this._exploreProfTried.has(a));
    if (!todo.length) return;
    todo.forEach(a => this._exploreProfTried.add(a));
    Promise.all(todo.map(a => this.fetchOtherProfile(a).catch(() => {}))).then(() => {
      if (this.state.mode === 'explore' && this.state.exploreTab === tab) this._renderExploreTab(tab);
    });
  }

  /* Shared trend computation — ranks #hashtags + significant words across
     recent posts (binary posts + stopwords excluded). Returns [[term,count]].
     Used by BOTH the Explore Trending tab and the sidebar "What's happening",
     so they never disagree. */
  _computeTrends(maxTerms = 12, sample = 500) {
    const STOP = this._exploreStopwords || (this._exploreStopwords = new Set(
      ('the a an and or but if then else for to of in on at by with from as is are was were be been being '
      + 'this that these those it its has have had will can could would should just so up out get got about '
      + 'not no yes do does did done you your youre they them their there here what when who how why all any '
      + 'too very more most some such only own same than now into over also dont cant wont im ive pls www http '
      + 'https com one will new like via').split(' ')));
    const counts = new Map();
    this.state.posts.slice(0, sample).forEach(p => {
      if (p.postType && p.postType !== 'post') return;
      if (!p.display) return;
      /* Skip binary/non-text posts so their decoded garbage (e.g. "arc.txt")
         doesn't pollute the trend list. */
      if (this._isLikelyBinary(p.display)) return;
      (p.display.match(/#[A-Za-z0-9_]{2,30}/g) || []).forEach(t => {
        const k = t.toLowerCase();
        counts.set(k, (counts.get(k) || 0) + 1);
      });
      const noTags = p.display.replace(/#[A-Za-z0-9_]+/g, ' ');
      (noTags.toLowerCase().match(/[a-z][a-z0-9]{2,20}/g) || []).forEach(w => {
        if (STOP.has(w)) return;
        counts.set(w, (counts.get(w) || 0) + 1);
      });
    });
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const strong = ranked.filter(([, n]) => n >= 2);
    return (strong.length ? strong : ranked).slice(0, maxTerms);
  }

  /* ── Trending tab: ranked terms, each taps through to a search ────────── */
  _exploreTrendingHTML() {
    /* X-style Explore: a "Happening now" hero of high-engagement recent
       posts (same heuristic as the sidebar news card), the ranked trends,
       then a short Latest preview linking into the Latest tab. */
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const imgRe = /https?:\/\/[^\s<>"{}|\\^[\]`]+\.(jpg|jpeg|png|gif|webp|avif)/i;
    const score = p => {
      let sc = 0;
      const age = (Date.now() - new Date(p.timestamp).getTime()) / 3_600_000;
      sc += Math.max(0, 24 - age) * 2;
      if ((p.display || '').match(/#[A-Za-z0-9_]{2,30}/)) sc += 8;
      if (imgRe.test(p.display || '')) sc += 10;
      if ((p.display || '').length > 80) sc += 4;
      return sc;
    };
    const hero = this.state.posts
      .filter(p => (!p.postType || p.postType === 'post') && p.display && p.display.length >= 40
        && new Date(p.timestamp).getTime() >= cutoff)
      .map(p => ({ p, sc: score(p) }))
      .sort((a, b) => b.sc - a.sc).slice(0, 3).map(x => x.p);
    const heroHtml = hero.map(p => {
      const author = this.state.profCache[p.reporter];
      const name = author?.username ? utils.safe(author.username) : this.trunc(p.reporter || '');
      const text = utils.safe((p.display || '').replace(/https?:\/\/\S+/g, '').trim().slice(0, 110));
      const im = (p.display || '').match(imgRe);
      const thumb = im ? utils.safe(utils.safeUrl(im[0]) || '') : '';
      return `<div class="explore-row" role="button" tabindex="0" data-act="open-thread" data-act-arg="${utils.safe(p.txHash)}">
        <div class="explore-content">
          <div class="explore-label">${name} · ${utils.safe(this.relTime(p.timestamp))}</div>
          <div class="explore-name" style="font-size:15px;font-weight:700">${text}</div>
        </div>
        ${thumb ? `<img class="xp-hero-thumb" src="${thumb}" alt="" loading="lazy" data-fallback="hide">` : ''}
      </div>`;
    }).join('');

    const ranked = this._computeTrends(10);
    const trendsHtml = ranked.map(([term, count], i) =>
      `<div class="explore-row" role="button" tabindex="0" data-explore-term="${utils.safe(term)}">
        <div class="explore-rank">${i + 1}</div>
        <div class="explore-content">
          <div class="explore-label">Trending on PulseChain</div>
          <div class="explore-name">${utils.safe(term)}</div>
          <div class="explore-meta">${count} post${count > 1 ? 's' : ''}</div>
        </div>
        <div class="explore-arrow">→</div>
      </div>`).join('');

    const latest = this.state.posts
      .filter(p => (!p.postType || p.postType === 'post') && p.display
        && !this._isLikelyBinary(p.display))
      .slice(0, 3);
    const latestHtml = latest.map(p => {
      const author = this.state.profCache[p.reporter];
      const name = author?.username ? utils.safe(author.username) : this.trunc(p.reporter || '');
      /* Clean preview: strip URLs (media renders elsewhere); fall back to a
         media hint when the post was only a link. */
      let text = (p.display || '').replace(/(https?:|ipfs:|ar:|arweave:)\S+/g, '').replace(/\s{2,}/g, ' ').trim();
      if (!text) {
        if (utils.ytId(p.display)) text = '▶ Video';
        else if (this._postHasMedia(p.display)) text = '🖼 Media post';
        else {
          /* Link-only post (e.g. a Grok page): show "🔗 host" instead of the
             full ugly URL. */
          const m = (p.display || '').match(/https?:\/\/([^\s/]+)/);
          text = m ? '🔗 ' + m[1].replace(/^www\./, '') : (p.display || '').slice(0, 90);
        }
      }
      return `<div class="explore-row" role="button" tabindex="0" data-act="open-thread" data-act-arg="${utils.safe(p.txHash)}">
        <div class="explore-content">
          <div class="explore-label">${name} · ${utils.safe(this.relTime(p.timestamp))}</div>
          <div class="explore-meta" style="color:var(--text)">${utils.safe(text.slice(0, 90))}</div>
        </div>
      </div>`;
    }).join('');

    if (!heroHtml && !trendsHtml && !latestHtml) {
      return `<div class="explore-empty">Nothing here yet — load the feed, then check back.</div>`;
    }
    return (heroHtml ? `<div class="explore-section-title">Happening now</div>${heroHtml}` : '')
      + (trendsHtml ? `<div class="explore-section-title">Trends</div>${trendsHtml}` : '')
      + (latestHtml ? `<div class="explore-section-title">Latest</div>${latestHtml}
          <div class="explore-row explore-showall" role="button" tabindex="0" data-explore-goto="latest">
            <div class="explore-content"><div class="explore-name" style="color:var(--primary-lt)">Show all latest posts</div></div>
            <div class="explore-arrow">→</div>
          </div>` : '');
  }

  /* ── News: full-page ranked headlines (same heuristic as the sidebar's
     renderTodaysNews — recency + hashtags + media + substance — but the top
     ~20 as X-news-tab-style headline rows). Clicking opens the thread. ──── */
  _exploreNewsHTML() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; /* 24h window */
    const imgRe = /https?:\/\/[^\s<>"{}|\\^[\]`]+\.(jpg|jpeg|png|gif|webp|avif)/i;
    const ipfsRe = /(ipfs:\/\/|\/ipfs\/)\S+/i;
    const score = (p) => {
      let s = 0;
      const ageHours = (Date.now() - new Date(p.timestamp).getTime()) / 3_600_000;
      s += Math.max(0, 24 - ageHours) * 2;
      if ((p.display || '').match(/#[A-Za-z0-9_]{2,30}/)) s += 8;
      if (imgRe.test(p.display || '') || ipfsRe.test(p.display || '')) s += 10;
      if ((p.display || '').length > 80) s += 4;
      return s;
    };
    /* A sparse chain day can leave the 24h window empty — widen to 7 days
       rather than render an empty tab (X's News always has content; ours
       depends on organic volume). */
    const pick = (cut) => this.state.posts
      .filter(p => {
        if (p.postType && p.postType !== 'post') return false;
        if (!p.display || p.display.length < 40) return false;
        return new Date(p.timestamp).getTime() >= cut;
      })
      .map(p => ({ post: p, score: score(p) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(x => x.post);
    let ranked = pick(cutoff);
    if (!ranked.length) ranked = pick(Date.now() - 7 * 24 * 60 * 60 * 1000);

    if (!ranked.length) {
      return `<div class="explore-empty">No fresh news yet — load the feed, then check back.</div>`;
    }
    return ranked.map(p => {
      const author = this.state.profCache[p.reporter];
      const authorName = author?.username ? utils.safe(author.username) : this.trunc(p.reporter || '');
      const tagMatch = (p.display || '').match(/#([A-Za-z0-9_]{2,30})/);
      const label = tagMatch ? '#' + utils.safe(tagMatch[1]) + ' · Trending' : utils.safe(authorName);
      const thumbUrl = this._mediaImageUrls(p.display)[0] || '';
      const thumb = thumbUrl ? utils.safe(utils.safeUrl(thumbUrl) || '') : '';
      let headlineRaw = (p.display || '').replace(/https?:\/\/\S+/g, '').trim();
      /* Posts that are only a media/embed URL strip to nothing — an empty
         headline reads as broken. Fall back to a plain-text media descriptor
         (no emoji — the target system lacks color-emoji fonts). */
      if (!headlineRaw) {
        headlineRaw = (utils.ytId(p.display) || utils.vimeoId(p.display)) ? 'Shared a video'
          : thumbUrl ? 'Shared an image' : 'Shared a link';
      }
      const headline = utils.safe(headlineRaw.slice(0, 140));
      const time = this.relTime(p.timestamp);
      return `
        <div class="news-row" role="button" tabindex="0" data-act="open-thread" data-act-arg="${utils.safe(p.txHash)}">
          <div class="news-body">
            <div class="news-label">${label}</div>
            <div class="news-headline">${headline}</div>
            <div class="news-meta">
              <span>${utils.safe(authorName)}</span>
              <span>·</span>
              <span>${time}</span>
            </div>
          </div>
          ${thumb ? `<img src="${thumb}" class="news-thumb" alt="" loading="lazy" data-fallback="hide">` : ''}
        </div>`;
    }).join('');
  }

  /* ── People: who-to-follow, ranked by post activity ───────────────────── */
  _explorePeopleHTML() {
    const me = this.state.signerAddr;
    const counts = new Map();
    this.state.posts.forEach(p => {
      if (p.postType && p.postType !== 'post') return;
      const r = p.reporter?.toLowerCase();
      if (!r || r === me) return;
      counts.set(r, (counts.get(r) || 0) + 1);
    });
    let ranked = [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => {
        const ap = this.state.profCache[a[0]]?.username ? 1 : 0;
        const bp = this.state.profCache[b[0]]?.username ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return b[1] - a[1];
      });
    if (!ranked.length) ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    ranked = ranked.slice(0, 15);
    if (!ranked.length) {
      return `<div class="explore-empty">No active posters yet — load the feed first.</div>`;
    }
    this._exploreResolveProfiles(ranked.map(([a]) => a), 'people');
    return ranked.map(([addr, count]) => {
      const c = this.state.profCache[addr];
      const name = c?.username ? utils.safe(c.username) : this.trunc(addr);
      const pic  = utils.safe(utils.safeUrl(c?.picUrl) || 'image1.jpeg');
      const meta = c?.bio ? utils.safe(c.bio.slice(0, 80)) : `${count} post${count > 1 ? 's' : ''} in feed`;
      const isFollowing = this.state.following.has(addr);
      const followBtn = (me && addr !== me)
        ? `<button class="explore-follow-btn${isFollowing ? ' following' : ''}" data-explore-follow="${utils.safe(addr)}">${isFollowing ? 'Following' : 'Follow'}</button>`
        : '';
      return `<div class="explore-row explore-person" role="button" tabindex="0" data-explore-profile="${utils.safe(addr)}">
        <img src="${pic}" class="explore-avatar" data-pop-addr="${utils.safe(addr)}" data-fallback-src="image1.jpeg" alt="">
        <div class="explore-content">
          <div class="explore-name" data-pop-addr="${utils.safe(addr)}">${name}</div>
          <div class="explore-meta">${meta}</div>
        </div>
        ${followBtn}
      </div>`;
    }).join('');
  }

  /* ── Channels: most-posted-to channels in the feed (excl. the main feed) +
       recently visited channels ──────────────────────────────────────────── */
  _exploreChannelsHTML() {
    const main = MAIN_CHANNEL.toLowerCase();
    const counts = new Map();
    this.state.posts.forEach(p => {
      const to = (p.to || p.channel)?.toLowerCase();
      if (!to || to === main) return;
      counts.set(to, (counts.get(to) || 0) + 1);
    });
    let ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const seen = new Set(ranked.map(([a]) => a));
    (this.state.channelHistory || []).forEach(ch => {
      const a = ch.address?.toLowerCase();
      if (a && a !== main && !seen.has(a)) { ranked.push([a, 0]); seen.add(a); }
    });
    if (!ranked.length) {
      return `<div class="explore-empty">No channels in the feed yet. Open one from a token post or the Channels page.</div>`;
    }
    this._exploreResolveProfiles(ranked.map(([a]) => a), 'channels');
    return ranked.map(([addr, count]) => {
      const c = this.state.profCache[addr];
      const hist = (this.state.channelHistory || []).find(h => h.address?.toLowerCase() === addr);
      const name = c?.username ? utils.safe(c.username) : utils.safe(hist?.label || this.trunc(addr));
      const pic  = utils.safe(utils.safeUrl(c?.picUrl || hist?.picUrl) || 'image1.jpeg');
      const meta = count > 0 ? `${count} post${count > 1 ? 's' : ''} in feed` : utils.safe(this.trunc(addr));
      return `<div class="explore-row" role="button" tabindex="0" data-explore-channel="${utils.safe(addr)}">
        <img src="${pic}" class="explore-avatar" data-fallback-src="image1.jpeg" alt="">
        <div class="explore-content">
          <div class="explore-name">${name}</div>
          <div class="explore-meta">${meta}</div>
        </div>
        <div class="explore-arrow">→</div>
      </div>`;
    }).join('');
  }

  /* ── Media: an X-style grid of every image/video/YouTube thumbnail in the
       loaded feed. Reuses the profile Media-grid cell + CSS; cells open the
       post's thread via the feed's delegated open-thread handler. ─────────── */
  _exploreMediaHTML() {
    const items = [];
    const seen = new Set();
    for (const p of this.state.posts) {
      if (p.postType && p.postType !== 'post') continue;
      for (const it of this._postMediaItems(p.display)) {
        if (seen.has(it.thumb)) continue;          /* dedup repeated media URLs */
        seen.add(it.thumb);
        items.push({ ...it, txHash: p.txHash });
        if (items.length >= 60) break;
      }
      if (items.length >= 60) break;
    }
    if (!items.length) {
      return `<div class="explore-empty">No media in the feed yet — scroll Home to load posts with images or video.</div>`;
    }
    return `<div class="prof-media-grid">${items.map(it => this._mediaGridCellHTML(it)).join('')}</div>`;
  }

  /* ── Latest: most recent posts, rendered as real post cards. They live
       inside #feed, so the feed's delegated click handler gives them full
       reply/like/thread interactivity for free. ─────────────────────────── */
  _exploreRenderLatest(host) {
    const posts = this.state.posts
      .filter(p => !p.postType || p.postType === 'post')
      .slice()
      .sort((a, b) => (b._tsMs ??= new Date(b.timestamp).getTime()) - (a._tsMs ??= new Date(a.timestamp).getTime()));
    if (!posts.length) { host.innerHTML = `<div class="explore-empty">No posts loaded yet.</div>`; return; }
    this._exploreRenderPaged(host, posts, null);
  }

  /* Wire the Explore search input — same behavior as the sidebar search:
     typing routes to Home with the search term applied. */
  /* Wire the Explore search input. Results render inline on the Explore page
     (via _exploreApplySearch) — this no longer navigates to Home or writes to
     the sidebar search box. */
  _wireExploreSearch() {
    const inp = this.g('explore-search-input');
    const clr = this.g('explore-search-clear');
    if (!inp) return;
    if (clr) clr.classList.toggle('hidden', !inp.value.trim());
    inp.oninput = utils.debounce(() => this._exploreApplySearch(inp.value.trim()), 250);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Escape' && inp.value) {
        e.preventDefault();
        inp.value = '';
        this._exploreApplySearch('');
        inp.blur();
      }
    });
    if (clr) {
      clr.onclick = () => {
        inp.value = '';
        this._exploreApplySearch('');
        inp.focus();
      };
    }
  }

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

  async goChannels(tab = 'channels') {
    this._chatTab = tab === 'messages' ? 'messages' : 'channels';
    this._updateTitle('Chat');
    this._setRoute(this._chatTab === 'messages' ? '/messages' : '/channels');
    this.setNav('nav-channels','channels');
    /* X behavior: the Chat page collapses the left nav to its icon rail and
       drops the right column so the two-pane area fills the width (CSS keys
       off body.mode-channels; setNav clears it on every nav). */
    document.body.classList.add('mode-channels');
    this.g('feed-tabs').classList.remove('tabs-sticky');
    this._pendingPageHeader = this._makePageHeader({ title: 'Chat', noBack: true });
    this.g('compose-area').style.display = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('feed-tabs').style.display    = 'none';
    this.g('loading-more').style.display = 'none';
    this.state.mode = 'channels';
    /* Fresh start on each entry: clear the selected pane so re-entering the
       page begins with the desktop auto-select (first channel) or the mobile
       list, rather than a stale selection from a previous visit. */
    this._chSelected = null;

    /* Load cached immediately */
    const cached = await this.cache.getChannels();
    this.state.channelHistory = cached;
    const chHeader = this._applyPageHeader();
    this.renderChannelHistory(chHeader);

    /* If nothing cached, trigger a rescan from chain — but only when actually
       viewing the Channels tab (the Messages tab doesn't need channel history,
       and the scan toast there was confusing). */
    if (this._chatTab !== 'messages' && cached.length === 0 && this.state.signerAddr) {
      this.rebuildChannelHistory();
    }
  }

  /* The user-data localStorage keys that Export/Import round-trips (settings,
     mutes, lists, communities). Caches (posts/IDB) and the wallet are excluded. */
  get _exportableKeys() { return [SETTINGS_KEY, MUTE_KEY, LISTS_KEY, COMMUNITIES_KEY]; }

  _exportData() {
    const data = {};
    this._exportableKeys.forEach(k => { const v = localStorage.getItem(k); if (v != null) data[k] = v; });
    const payload = { app: 'SayIt', version: 1, exportedAt: new Date().toISOString(), data };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'sayit-backup.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    utils.toast('Backup downloaded ✓');
  }

  _importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || parsed.app !== 'SayIt' || !parsed.data || typeof parsed.data !== 'object') {
          throw new Error('not a SayIt backup');
        }
        let n = 0;
        for (const [k, v] of Object.entries(parsed.data)) {
          if (!this._exportableKeys.includes(k) || typeof v !== 'string') continue;
          try { JSON.parse(v); } catch { continue; }   /* value must be valid JSON */
          localStorage.setItem(k, v); n++;
        }
        if (!n) { utils.toast('Nothing to import from this file'); return; }
        utils.toast(`Imported ${n} item${n !== 1 ? 's' : ''} — reloading…`);
        setTimeout(() => location.reload(), 1200);
      } catch { utils.toast('Invalid backup file'); }
    };
    reader.onerror = () => utils.toast('Could not read file');
    reader.readAsText(file);
  }

  /* Wire a segmented pill group (Appearance pane): for each .seg-btn in the
     group, a click sets that pill active (aria-checked across the group) and
     invokes onPick(value). CSP-safe — addEventListener, no inline handlers.
     Mirrors the accent-swatch wiring. id is the group host's element id. */
  _wireSegGroup(id, onPick) {
    const group = this.g(id);
    if (!group) return;
    group.querySelectorAll('.seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.seg-btn').forEach(b =>
          b.setAttribute('aria-checked', b === btn ? 'true' : 'false'));
        onPick(btn.dataset.segVal);
      });
    });
  }

  /* Apply the chosen theme by toggling data-theme on <html> (the [data-theme]
     CSS-var overrides do the rest). Default 'dark' = no attribute. */
  _applyTheme(theme) {
    theme = theme || this._getSettings().theme || 'dark';
    if (theme === 'dim' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }

  /* Accent color (Settings → Display). Sets the --primary* CSS vars inline on
     <html>; 'purple' (the default) clears the inline overrides so the
     stylesheet :root values take over — keeps reset/no-setting clean. boot.js
     applies the same vars pre-paint. */
  _applyAccent(key) {
    const de = document.documentElement;
    const vars = accentVars(key);
    const names = ['--primary', '--primary-lt', '--primary-dim', '--primary-hov', '--neon'];
    if (!vars || key === 'purple') { names.forEach(n => de.style.removeProperty(n)); return; }
    for (const [n, v] of Object.entries(vars)) de.style.setProperty(n, v);
  }

  /* Notification-badge color (Settings → Appearance). Empty/undefined → clear
     the override so the badge falls back to the accent (--primary) via the CSS
     var fallback. */
  _applyNotifBadgeColor(color) {
    const de = document.documentElement;
    if (color) de.style.setProperty('--notif-badge', color);
    else de.style.removeProperty('--notif-badge');
  }

  /* ── Local-first deep sync ──────────────────────────────────────────
     Opt-in archive of the main channel's full history into IndexedDB.
     Pages oldest cursor → end at a polite rate while the user keeps
     browsing; the cursor persists (localStorage) so it resumes across
     sessions; pruneIfStale leaves archived posts alone. Search, threads,
     and Analytics automatically benefit (they read the same cache). */
  _deepSyncState() {
    try { return JSON.parse(localStorage.getItem('sayitDeepSync') || 'null') || { lastPage: 0, saved: 0, done: false }; }
    catch { return { lastPage: 0, saved: 0, done: false }; }
  }
  _setDeepSyncState(st) { try { localStorage.setItem('sayitDeepSync', JSON.stringify(st)); } catch { /* full */ } }

  _deepSyncStatusText(st, active) {
    if (st.done) return `✓ Complete — ${st.saved.toLocaleString()} posts archived`;
    if (active) return `Syncing… page ${st.lastPage} · ${st.saved.toLocaleString()} posts so far`;
    if (st.lastPage > 0) return `Paused at page ${st.lastPage} · ${st.saved.toLocaleString()} posts — resume any time`;
    return '';
  }

  async toggleDeepSync() {
    if (this._deepSyncing) { this._deepSyncing = false; return; } /* pause requested */
    this._deepSyncing = true;
    const btn = this.g('set-deep-sync');
    const status = this.g('deep-sync-status');
    if (btn) btn.textContent = 'Pause';
    const st = this._deepSyncState();
    if (st.done) { st.done = false; st.lastPage = 0; st.saved = 0; } /* re-sync from scratch */
    try {
      const scope = this._getSettings();
      const maxPages = Number(scope.deepSyncMaxPages) || 0; /* 0 = full history */
      const wantLikes = scope.deepSyncLikes !== false;
      while (this._deepSyncing) {
        const page = st.lastPage + 1;
        if (maxPages && page > maxPages) { st.done = true; this._deepSyncing = false; this._setDeepSyncState(st); break; }
        let raw;
        try { raw = await this.apiFetch(MAIN_CHANNEL, page); }
        catch (err) {
          if (status) status.textContent = 'Network hiccup — retrying in 5s…';
          await this._scanDelay(5000);
          continue;
        }
        const posts = [];
        const likes = [];
        for (const tx of raw) {
          const parsed = this._parsePostTx(tx, { mode: 'main' });
          /* Archive view-scoped like the feed does, so loadCached sees them. */
          if (parsed) { posts.push({ ...parsed, channel: MAIN_CHANNEL, mode: 'main' }); continue; }
          /* Reactions: archive LIKEs for engagement analytics (replies and
             reposts are posts — already archived above). */
          if (!wantLikes) continue;
          try {
            const text = ethers.toUtf8String(tx.input).trim();
            if (text.startsWith(LIKE_PREFIX)) {
              const target = utils.refHash(text.slice(LIKE_PREFIX.length));
              if (/^0x[a-f0-9]{64}$/.test(target)) {
                likes.push({ txHash: tx.hash.toLowerCase(), target,
                             from: tx.from.toLowerCase(),
                             ts: tx.timeStamp ? Number(tx.timeStamp) * 1000 : Date.now() });
              }
            }
          } catch { /* non-UTF8 input — skip */ }
        }
        if (posts.length) await this.cache.savePosts(posts);
        if (likes.length) await this.cache.saveLikes(likes);
        st.lastPage = page;
        st.saved += posts.length;
        if (raw.length < 50) { st.done = true; this._deepSyncing = false; }
        this._setDeepSyncState(st);
        if (status) status.textContent = this._deepSyncStatusText(st, this._deepSyncing);
        await this._scanDelay(300); /* polite to the explorer */
      }
    } finally {
      this._deepSyncing = false;
      const b2 = this.g('set-deep-sync');
      if (b2) b2.textContent = this._deepSyncState().done ? 'Re-sync' : 'Resume';
      const s2 = this.g('deep-sync-status');
      if (s2) s2.textContent = this._deepSyncStatusText(this._deepSyncState(), false);
    }
  }

  async _exportPostsSnapshot() {
    let posts = [];
    try { posts = await this.cache.getPosts(() => true); } catch { /* empty */ }
    if (!posts.length) { utils.toast('No cached posts to export'); return; }
    const payload = { app: 'SayIt', type: 'posts-snapshot', version: 1,
                      exportedAt: new Date().toISOString(), count: posts.length, posts };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sayit-posts-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    utils.toast(`Exported ${posts.length.toLocaleString()} posts ✓`);
  }

  _importPostsSnapshot(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const d = JSON.parse(reader.result);
        if (d?.app !== 'SayIt' || d?.type !== 'posts-snapshot' || !Array.isArray(d.posts)) {
          utils.toast('Not a SayIt posts snapshot'); return;
        }
        /* Never trust a file: whitelist-rebuild every post and validate the
           fields that reach render paths (same trust stance as the explorer
           ingestion gate). */
        const clean = [];
        for (const p of d.posts) {
          if (!p || typeof p !== 'object') continue;
          if (!/^0x[0-9a-f]{64}$/i.test(p.txHash || '')) continue;
          if (!/^0x[0-9a-f]{40}$/i.test(p.reporter || '')) continue;
          if (p.to != null && p.to !== '' && !/^0x[0-9a-f]{40}$/i.test(p.to)) continue;
          if (p.parentTx != null && !/^0x[0-9a-f]{64}$/i.test(p.parentTx)) continue;
          if (p.repostOf != null && !/^0x[0-9a-f]{64}$/i.test(p.repostOf)) continue;
          const ts = new Date(p.timestamp || 0);
          if (isNaN(ts.getTime())) continue;
          clean.push({
            content: String(p.content ?? ''), display: String(p.display ?? ''),
            parentTx: p.parentTx ? p.parentTx.toLowerCase() : null,
            repostOf: p.repostOf ? p.repostOf.toLowerCase() : null,
            direction: null, poll: p.poll && typeof p.poll === 'object' ? {
              question: String(p.poll.question ?? ''),
              options: Array.isArray(p.poll.options) ? p.poll.options.slice(0, 4).map(o => String(o).slice(0, 60)) : [],
              endMs: Number(p.poll.endMs) || 0,
            } : null,
            postType: ['post','reply','repost','poll'].includes(p.postType) ? p.postType : 'post',
            reactionTarget: null,
            reporter: p.reporter.toLowerCase(), to: p.to ? p.to.toLowerCase() : null,
            timestamp: ts.toISOString(),
            txHash: p.txHash.toLowerCase(),
            channel: /^0x[0-9a-f]{40}$/i.test(p.channel || '') ? p.channel.toLowerCase() : MAIN_CHANNEL,
            mode: 'main',
            blockNumber: Number.isFinite(Number(p.blockNumber)) ? Number(p.blockNumber) : null,
          });
        }
        if (!clean.length) { utils.toast('Snapshot contained no valid posts'); return; }
        /* Batch to keep transactions reasonable. */
        for (let i = 0; i < clean.length; i += 500) {
          await this.cache.savePosts(clean.slice(i, i + 500));
        }
        utils.toast(`Imported ${clean.length.toLocaleString()} posts ✓`);
      } catch { utils.toast('Invalid snapshot file'); }
    };
    reader.onerror = () => utils.toast('Could not read file');
    reader.readAsText(file);
  }

  /* ── Verify it yourself: the trust page. Everything claimed about
     privacy and decentralization, with concrete steps any user can take
     to check it — view source, watch the network tab, read the CSP,
     rebuild from the repo. Static content; no data calls. ── */
  goVerify() {
    this._updateTitle('Verify it yourself');
    this._setRoute('/verify');
    this.setNav(null, null);
    this.state.mode = 'verify';
    this.g('compose-area').style.display   = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('feed-tabs').style.display      = 'none';
    this.g('loading-more').style.display   = 'none';
    this._pendingPageHeader = this._makePageHeader({ title: 'Verify it yourself', noBack: true });
    const headerHTML = this._applyPageHeader();
    this.g('feed').innerHTML = headerHTML + `
      <div class="verify-page">
        <p class="vp-lead">Don't trust this page — check it. Every claim below comes with a way
        to verify it yourself, because that's the whole point of building on a public chain.</p>

        <h3>🧾 The code is public</h3>
        <p>This entire app is a few readable files of plain HTML/CSS/JavaScript — no build step, no
        minified blobs. Read it on
        <a href="https://github.com/GitCoderAccount/SayIt" target="_blank" rel="noopener noreferrer">GitHub</a>,
        or right here: View Source shows <code>index.html</code>, <code>app.js</code>, <code>boot.js</code>
        and <code>sw.js</code> — exactly what runs. Serve those files anywhere (any static host, IPFS,
        your laptop) and you have an identical, independent copy of this interface.</p>

        <h3>🍪 No cookies, no trackers</h3>
        <p>Open DevTools → Application → Cookies: this origin sets none. There is no analytics service,
        no telemetry, no fingerprinting script — the in-app Analytics page is computed from your own
        local cache. A strict <strong>Content-Security-Policy</strong> (view it in the page source)
        means no inline script can execute and code only loads from this origin and the pinned
        ethers.js build.</p>

        <h3>📡 Watch the network</h3>
        <p>Open DevTools → Network and browse. You'll see requests to exactly three kinds of places:
        the static host serving these files, the block-explorer API <em>you</em> configure in Settings,
        and the hosts of media you choose to view (embeds only load after you tap them, unless you've
        enabled autoplay — Settings → Privacy). Nothing reports back to anyone.</p>

        <h3>⛓ Your data is the chain</h3>
        <p>Every post, reply, like, follow, poll, and tip is a plain PulseChain transaction with a
        human-readable payload — the protocol table is in the README. Verify any post: open it and
        click the timestamp to see the raw transaction on an independent explorer. Any developer can
        rebuild this entire social graph from public data; this interface holds nothing back.</p>

        <h3>🔑 Your keys, your voice</h3>
        <p>There are no accounts and no server-side identity. Your wallet signs your posts directly;
        this interface never sees your keys and cannot censor, edit, or delete anything once it's
        on-chain — and neither can anyone else.</p>

        <p class="vp-foot">Found something that doesn't match these claims?
        <a href="https://github.com/GitCoderAccount/SayIt/issues" target="_blank" rel="noopener noreferrer">Open an issue</a> —
        public scrutiny is the security model.</p>
      </div>`;
  }

  /* ── Analytics: client-side network stats computed from the local post
     cache + in-memory engagement maps. No server — the same data any
     client can derive from the chain. ── */
  /* Per-post like counts merged from the deep-sync archive AND the LIKE txs
     already sitting in the post cache (and any provided corpus), deduped by
     LIKE-tx hash. This makes engagement on Analytics + the Creator dashboard
     populate from normal browsing — no manual Deep sync required — and keeps
     both pages reading from one shared source so their numbers agree. */
  async _mergedLikeCounts(corpus) {
    const byTarget = new Map(); /* target → Set(likeTxHash) */
    const add = (target, txHash) => {
      if (!target || !txHash) return;
      let s = byTarget.get(target);
      if (!s) { s = new Set(); byTarget.set(target, s); }
      s.add(txHash);
    };
    try { (await this.cache.likeRows()).forEach(r => add(r.target, r.txHash)); }
    catch { /* archive unavailable */ }
    try {
      const posts = corpus || await this.cache.getPosts(() => true);
      posts.forEach(p => {
        if (p.postType !== 'like') return;
        let target = p.reactionTarget;
        if (!target && typeof p.content === 'string' && p.content.startsWith('LIKE:'))
          target = utils.refHash(p.content.slice(5));
        add(target, p.txHash);
      });
    } catch { /* cache unavailable */ }
    const counts = new Map();
    byTarget.forEach((s, t) => counts.set(t, s.size));
    return counts;
  }

  async goAnalytics() {
    this._updateTitle('Analytics');
    this._setRoute('/analytics');
    this.setNav(null, null);
    this.state.mode = 'analytics';
    this.g('compose-area').style.display   = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('feed-tabs').style.display      = 'none';
    this.g('loading-more').style.display   = 'none';
    this._pendingPageHeader = this._makePageHeader({ title: 'Analytics', noBack: true });
    const headerHTML = this._applyPageHeader();
    const feed = this.g('feed');
    feed.innerHTML = headerHTML + `<div class="prof-empty"><div class="spinner" aria-hidden="true"></div><h3>Crunching the chain…</h3></div>`;

    let posts = [];
    try { posts = await this.cache.getPosts(() => true); } catch { /* cache empty */ }
    if (this.state.mode !== 'analytics') return; /* navigated away mid-load */
    /* Union with the in-memory feed so a fresh session still has data. */
    const seen = new Set(posts.map(p => p.txHash));
    this.state.posts.forEach(p => { if (!seen.has(p.txHash)) { posts.push(p); seen.add(p.txHash); } });

    const range = this._anaRange || 14;   /* 7 | 14 | 30 days */
    const feedPosts = posts.filter(p => ['post','repost','poll'].includes(p.postType) || p.parentTx);
    const authors = new Map();
    const types = { post: 0, reply: 0, repost: 0, poll: 0 };
    const byDay = new Map();
    const DAY = 86400000;
    const today = new Date(); today.setHours(0,0,0,0);
    for (let i = range - 1; i >= 0; i--) byDay.set(today.getTime() - i * DAY, 0);
    feedPosts.forEach(p => {
      authors.set(p.reporter, (authors.get(p.reporter) || 0) + 1);
      const t = p.parentTx ? 'reply' : (p.postType in types ? p.postType : 'post');
      types[t]++;
      const d = new Date(p.timestamp); d.setHours(0,0,0,0);
      if (byDay.has(d.getTime())) byDay.set(d.getTime(), byDay.get(d.getTime()) + 1);
    });
    const topAuthors = [...authors.entries()].sort((a,b) => b[1]-a[1]).slice(0, 5);
    const trends = this._computeTrends(5, 500);
    const maxDay = Math.max(1, ...byDay.values());
    const fmtDay = ts => new Date(ts).toLocaleDateString('en-US', { month:'short', day:'numeric' });

    /* Engagement: likes merged from the archive + cached LIKE txs (so numbers
       populate without a Deep sync); replies computed from posts. */
    const likeCounts = await this._mergedLikeCounts(posts);
    if (this.state.mode !== 'analytics') return;
    const replyCounts = new Map();
    feedPosts.forEach(p => { if (p.parentTx) replyCounts.set(p.parentTx, (replyCounts.get(p.parentTx) || 0) + 1); });
    const byHash = new Map(posts.map(p => [p.txHash, p]));
    const topPosts = [...new Set([...likeCounts.keys(), ...replyCounts.keys()])]
      .map(h => ({ h, likes: likeCounts.get(h) || 0, replies: replyCounts.get(h) || 0, post: byHash.get(h) }))
      .filter(x => x.post && (x.likes + x.replies) > 0)
      .sort((a, b) => (b.likes * 2 + b.replies) - (a.likes * 2 + a.replies))
      .slice(0, 5);
    const topRows = topPosts.map(x => {
      const author = this.state.profCache[x.post.reporter];
      const name = author?.username ? utils.safe(author.username) : this.trunc(x.post.reporter || '');
      const text = utils.safe((x.post.display || '').replace(/https?:\/\/\S+/g, '').trim().slice(0, 70)) || '🖼 Media post';
      return `<div class="ana-row" role="button" tabindex="0" data-act="open-thread" data-act-arg="${utils.safe(x.h)}">
        <span class="ana-row-name" style="font-weight:500">${text}<span style="color:var(--muted);font-weight:400"> — ${name}</span></span>
        <span class="ana-row-val">♥ ${x.likes} · 💬 ${x.replies}</span></div>`;
    }).join('') || '<div class="ana-empty">No engagement data yet — run a Deep sync (Settings → Cache & Storage) to archive likes.</div>';

    const stat = (label, value) => `
      <div class="ana-stat"><div class="ana-num">${value}</div><div class="ana-label">${label}</div></div>`;
    const bars = [...byDay.entries()].map(([ts, n]) => `
      <div class="ana-bar-col" title="${fmtDay(ts)}: ${n} post${n === 1 ? '' : 's'}">
        <div class="ana-bar" style="height:${Math.round((n / maxDay) * 100)}%"></div>
        <div class="ana-bar-day">${fmtDay(ts).split(' ')[1]}</div>
      </div>`).join('');
    const authorRows = topAuthors.map(([addr, n]) => {
      const prof = this.state.profCache[addr];
      const name = prof?.username ? utils.safe(prof.username) : this.trunc(addr);
      this.fetchOtherProfile(addr);
      return `<div class="ana-row" role="button" tabindex="0" data-act="open-profile" data-act-arg="${utils.safe(addr)}">
        <span class="ana-row-name">${name}</span><span class="ana-row-val">${n} posts</span></div>`;
    }).join('') || '<div class="ana-empty">No author data yet</div>';
    const tagRows = trends.map(([term, n]) =>
      `<div class="ana-row" role="button" tabindex="0" data-act="search-trend" data-act-arg="${utils.safe(term)}">
        <span class="ana-row-name">${utils.safe(term)}</span><span class="ana-row-val">${n}</span></div>`
    ).join('') || '<div class="ana-empty">No trends yet</div>';

    feed.innerHTML = headerHTML + `
      <div class="ana-page">
        <div class="ana-note">Computed locally from your cached slice of the chain — scan more history (scroll feeds, raise scan depth, or run a Deep sync) for deeper numbers.</div>
        <div class="ana-range" role="tablist">
          ${[7, 14, 30].map(d => `<button class="ana-range-btn${range === d ? ' active' : ''}" data-ana-range="${d}" role="tab">${d}d</button>`).join('')}
        </div>
        <div class="ana-stats">
          ${stat('Cached posts', feedPosts.length.toLocaleString())}
          ${stat('Distinct authors', authors.size.toLocaleString())}
          ${stat('Replies', types.reply.toLocaleString())}
          ${stat('Reposts', types.repost.toLocaleString())}
          ${stat('Polls', types.poll.toLocaleString())}
        </div>
        <div class="ana-section"><h3>Posts per day — last ${range} days</h3>
          <div class="ana-chart">${bars}</div></div>
        <div class="ana-section"><h3>Top posts by engagement</h3>${topRows}</div>
        <div class="ana-section"><h3>Most active authors</h3>${authorRows}</div>
        <div class="ana-section"><h3>Trending terms</h3>${tagRows}</div>
      </div>`;
    feed.querySelectorAll('[data-ana-range]').forEach(btn => {
      btn.onclick = () => { this._anaRange = Number(btn.dataset.anaRange); this.goAnalytics(); };
    });
  }

  /* ── Creator dashboard ──────────────────────────────────────────────
     Your on-chain creator stats, computed locally and only for you: tips
     received (bounded scan of txs to your address), likes from the local
     archive, replies from the cache, followers gained in the scanned
     window, and the Spaces you've hosted. Nothing leaves the browser. */
  async goDashboard() {
    this._updateTitle('Creator dashboard');
    this._setRoute('/dashboard');
    this.setNav('nav-studio', null); /* highlights the sidebar Creator dashboard item */
    this.state.mode = 'dashboard';
    this.g('compose-area').style.display   = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('feed-tabs').style.display      = 'none';
    this.g('loading-more').style.display   = 'none';
    this._pendingPageHeader = this._makePageHeader({ title: 'Creator dashboard', noBack: true });
    const headerHTML = this._applyPageHeader();
    const feed = this.g('feed');
    const me = this.state.signerAddr;
    if (!me) {
      feed.innerHTML = headerHTML + `<div class="prof-empty"><h3>Connect your wallet</h3>
        <p style="color:var(--muted)">The dashboard shows tips, engagement, followers and Spaces for your account — all computed locally.</p></div>`;
      return;
    }
    feed.innerHTML = headerHTML + `<div class="prof-empty"><div class="spinner" aria-hidden="true"></div><h3>Crunching your chain history…</h3></div>`;

    const range = this._dashRange || 30; /* 7 | 14 | 30 days */
    const DAY = 86400000;

    /* Bounded scan of my address: tips + follow events to me, posts by me. */
    const tips = [];           /* { ts, wei, from, post } */
    let followsGained = 0;
    const myPosts = new Map(); /* txHash → parsed post */
    const seenTx = new Set();
    const pages = Math.min(this._getMaxScanPages(), 6);
    for (let page = 1; page <= pages; page++) {
      let raw = [];
      try { raw = await this.apiFetch(me, page); } catch { break; }
      if (this.state.mode !== 'dashboard') return;
      raw.forEach(tx => {
        if (!tx.hash || seenTx.has(tx.hash)) return;
        seenTx.add(tx.hash);
        if (!tx.input || tx.input === '0x') return;
        const from = tx.from?.toLowerCase();
        let text;
        try { text = ethers.toUtf8String(tx.input).trim(); } catch { return; }
        if (from === me) {
          const parsed = this._parsePostTx(tx, { mode: 'dashboard' });
          if (parsed) myPosts.set(parsed.txHash, parsed);
          return;
        }
        if (text.startsWith(TIP_PREFIX)) {
          let wei = 0n;
          try { wei = BigInt(tx.value || 0); } catch { /* odd value field */ }
          tips.push({ ts: Number(tx.timeStamp) * 1000 || 0, wei, from,
            post: text.slice(TIP_PREFIX.length).trim().toLowerCase() });
        } else if (text.startsWith(FOLLOW_PREFIX)) followsGained++;
        else if (text.startsWith(UNFOLLOW_PREFIX)) followsGained--;
      });
      if (raw.length < 50) break;
    }
    /* Cover the SAME corpus the Analytics page does — not just the live 6-page
       address scan — so the two pages agree. Union my posts from the cached
       archive AND the in-memory feed into myPosts (older liked posts beyond the
       live scan would otherwise be missed, making "Likes received"/top posts
       diverge from Analytics); and count replies over that same cache∪feed
       corpus (deduped) so per-post reply counts match too. Likes come from the
       shared archive (cache.likeCounts) in both places. */
    let cached = [];
    try { cached = await this.cache.getPosts(() => true); } catch { /* cache empty */ }
    if (this.state.mode !== 'dashboard') return;
    const isFeedType = p => !p.postType || ['post', 'repost', 'poll', 'space'].includes(p.postType);
    const corpus = [...cached, ...this.state.posts];
    /* Likes from the merged source (archive + cached LIKE txs) so engagement
       populates without a manual Deep sync — same source the Analytics page
       uses, keeping the two pages consistent. */
    const likeCounts = await this._mergedLikeCounts(corpus);
    if (this.state.mode !== 'dashboard') return;
    corpus.forEach(p => {
      if (p.reporter === me && p.txHash && !myPosts.has(p.txHash) && isFeedType(p)) myPosts.set(p.txHash, p);
    });
    const spacesHosted = [...myPosts.values()].filter(p => p.postType === 'space');
    const replyCounts = new Map();
    const seenReply = new Set();
    corpus.forEach(p => {
      if (p.parentTx && p.txHash && !seenReply.has(p.txHash) && myPosts.has(p.parentTx)) {
        seenReply.add(p.txHash);
        replyCounts.set(p.parentTx, (replyCounts.get(p.parentTx) || 0) + 1);
      }
    });
    const tipByPost = new Map();
    tips.forEach(t => tipByPost.set(t.post, (tipByPost.get(t.post) || 0n) + t.wei));
    let likesTotal = 0;
    const engage = [...myPosts.values()].map(p => {
      const likes = likeCounts.get(p.txHash) || 0;
      likesTotal += likes;
      return { post: p, likes, replies: replyCounts.get(p.txHash) || 0, tipWei: tipByPost.get(p.txHash) || 0n };
    });
    const topPosts = engage
      .filter(e => e.likes + e.replies > 0 || e.tipWei > 0n)
      .sort((a, b) => Number(b.tipWei - a.tipWei) || (b.likes * 2 + b.replies) - (a.likes * 2 + a.replies))
      .slice(0, 5);

    /* Supporters: who tipped me the most. */
    const byTipper = new Map();
    tips.forEach(t => byTipper.set(t.from, (byTipper.get(t.from) || 0n) + t.wei));
    const topTippers = [...byTipper.entries()].sort((a, b) => Number(b[1] - a[1])).slice(0, 5);

    /* Tips per day for the chart. */
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const byDay = new Map();
    for (let i = range - 1; i >= 0; i--) byDay.set(today.getTime() - i * DAY, 0n);
    tips.forEach(t => {
      const d = new Date(t.ts); d.setHours(0, 0, 0, 0);
      if (byDay.has(d.getTime())) byDay.set(d.getTime(), byDay.get(d.getTime()) + t.wei);
    });
    const maxDay = [...byDay.values()].reduce((a, b) => (b > a ? b : a), 1n);
    const fmtDay = ts => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const tipWeiTotal = tips.reduce((a, t) => a + t.wei, 0n);

    const stat = (label, value) => `
      <div class="ana-stat"><div class="ana-num">${value}</div><div class="ana-label">${label}</div></div>`;
    const bars = [...byDay.entries()].map(([ts, wei]) => `
      <div class="ana-bar-col" title="${fmtDay(ts)}: ${utils.fmtPLS(wei.toString())} PLS">
        <div class="ana-bar" style="height:${Math.round(Number(wei * 100n / maxDay))}%"></div>
        <div class="ana-bar-day">${fmtDay(ts).split(' ')[1]}</div>
      </div>`).join('');
    const postRows = topPosts.map(x => {
      const text = utils.safe((x.post.display || '').replace(/https?:\/\/\S+/g, '').trim().slice(0, 70)) || '🖼 Media post';
      const tipTxt = x.tipWei > 0n ? ` · 💎 ${utils.fmtPLS(x.tipWei.toString())} PLS` : '';
      return `<div class="ana-row" role="button" tabindex="0" data-act="open-thread" data-act-arg="${utils.safe(x.post.txHash)}">
        <span class="ana-row-name" style="font-weight:500">${text}</span>
        <span class="ana-row-val">♥ ${x.likes} · 💬 ${x.replies}${tipTxt}</span></div>`;
    }).join('') || '<div class="ana-empty">No engagement on your posts in the scanned window yet — likes need a Deep sync archive (Settings → Cache &amp; Storage).</div>';
    const tipperRows = topTippers.map(([addr, wei]) => {
      const prof = this.state.profCache[addr];
      const name = prof?.username ? utils.safe(prof.username) : this.trunc(addr);
      this.fetchOtherProfile(addr);
      return `<div class="ana-row" role="button" tabindex="0" data-act="open-profile" data-act-arg="${utils.safe(addr)}">
        <span class="ana-row-name">${name}</span><span class="ana-row-val">💎 ${utils.fmtPLS(wei.toString())} PLS</span></div>`;
    }).join('') || '<div class="ana-empty">No tips received in the scanned window yet</div>';
    const spaceRows = spacesHosted.map(p => {
      const ended = this._spaceIsEnded(p);
      return `<div class="ana-row" role="button" tabindex="0" data-act="open-thread" data-act-arg="${utils.safe(p.txHash)}">
        <span class="ana-row-name">🎙 ${utils.safe(p.space.title)}</span>
        <span class="ana-row-val">${ended ? 'Ended' : '🔴 Live'} · ${this.relTime(p.timestamp)}</span></div>`;
    }).join('') || '<div class="ana-empty">No Spaces hosted yet — More → 🎙 Start a Space</div>';

    feed.innerHTML = headerHTML + `
      <div class="ana-page">
        <div class="ana-note">Computed locally from the last ${pages} page(s) of your address history and your cached archive — nothing is sent anywhere.</div>
        <div class="ana-range" role="tablist">
          ${[7, 14, 30].map(d => `<button class="ana-range-btn${range === d ? ' active' : ''}" data-dash-range="${d}" role="tab">${d}d</button>`).join('')}
        </div>
        <div class="ana-stats">
          ${stat('Tips received', tips.length.toLocaleString())}
          ${stat('PLS earned', utils.fmtPLS(tipWeiTotal.toString()))}
          ${stat('Likes received', likesTotal.toLocaleString())}
          ${stat('Posts scanned', myPosts.size.toLocaleString())}
          ${stat('Followers gained', Math.max(0, followsGained).toLocaleString())}
          ${stat('Spaces hosted', spacesHosted.length.toLocaleString())}
        </div>
        <!-- PROGRAMS — revenue + supporters (X Creator Studio parity). -->
        <div class="studio-group">
          <div class="studio-group-title">Programs</div>
          <div class="ana-section"><h3>PLS tipped to you — last ${range} days</h3>
            <div class="ana-chart">${bars}</div></div>
          <div class="ana-section"><h3>Top supporters</h3>${tipperRows}</div>
          <div class="ana-section"><h3>Subscriptions</h3>
            <div class="ana-empty">Recurring on-chain subscriptions are coming soon — let supporters back you with a monthly PLS payment. For now, tips are your revenue stream.</div></div>
        </div>
        <!-- TOOLS — content performance + analytics. -->
        <div class="studio-group">
          <div class="studio-group-title">Tools</div>
          <div class="ana-section"><h3>Your top posts</h3>${postRows}</div>
          <div class="ana-section"><h3>Your Spaces</h3>${spaceRows}</div>
          <div class="ana-section"><h3>Analytics</h3>
            <div class="ana-row" role="button" tabindex="0" id="dash-analytics-link">
              <span class="ana-row-name">Open full Analytics</span><span class="ana-row-val">→</span></div></div>
        </div>
        <!-- SUPPORT — help + learn more. -->
        <div class="studio-group">
          <div class="studio-group-title">Support</div>
          <div class="ana-section">
            <a class="ana-row" href="https://github.com/GitCoderAccount/SayIt/issues" target="_blank" rel="noopener noreferrer">
              <span class="ana-row-name">Contact support (GitHub Issues)</span><span class="ana-row-val">↗</span></a>
            <a class="ana-row" href="https://github.com/GitCoderAccount/SayIt" target="_blank" rel="noopener noreferrer">
              <span class="ana-row-name">Learn more (docs &amp; source)</span><span class="ana-row-val">↗</span></a>
            <div class="ana-row" role="button" tabindex="0" id="dash-verify-link">
              <span class="ana-row-name">Verify it yourself</span><span class="ana-row-val">→</span></div>
          </div>
        </div>
      </div>`;
    feed.querySelectorAll('[data-dash-range]').forEach(btn => {
      btn.onclick = () => { this._dashRange = Number(btn.dataset.dashRange); this.goDashboard(); };
    });
    const al = this.g('dash-analytics-link'); if (al) al.onclick = () => this.goAnalytics();
    const vl = this.g('dash-verify-link');    if (vl) vl.onclick = () => this.goVerify();
  }

  goSettings() {
    this._updateTitle('Settings');
    this._setRoute('/settings');
    this.setNav(null, null);
    /* Hide the mobile compose FAB here — it has no purpose on Settings and
       overlapped the API-settings action buttons on phones. */
    document.body.classList.add('mode-settings');
    this.state.mode = 'settings';
    this.g('compose-area').style.display   = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('feed-tabs').style.display      = 'none';
    this.g('feed-tabs').classList.remove('tabs-sticky');
    this.g('loading-more').style.display   = 'none';
    this._pendingPageHeader = this._makePageHeader({ title: 'Settings', noBack: true });
    const headerHTML = this._applyPageHeader();
    this.g('feed').innerHTML = headerHTML + this._settingsHTML();
    this._wireSettingsListeners();
    this._settingsNavify();
  }

  /* X-style two-pane Settings: post-processes the rendered sections into a
     left nav (section list) + right pane (active section). Works on
     whatever sections _settingsHTML emits — adding a section needs no
     changes here. Mobile: list first, drill into a section, back returns.
     All control ids/wiring stay intact — sections are only re-parented
     and visibility-toggled. */
  _settingsNavify() {
    const feed = this.g('feed');
    const sections = [...feed.querySelectorAll('.settings-section')];
    if (sections.length < 2) return;
    const layout = document.createElement('div');
    layout.className = 'settings-layout';
    const nav  = document.createElement('nav');
    nav.className = 'settings-nav';
    nav.setAttribute('aria-label', 'Settings sections');
    const pane = document.createElement('div');
    pane.className = 'settings-pane';
    sections[0].parentNode.insertBefore(layout, sections[0]);

    const back = document.createElement('button');
    back.className = 'settings-pane-back';
    back.innerHTML = '← All settings';
    back.onclick = () => layout.classList.remove('pane-open');
    pane.appendChild(back);

    const items = [];
    const activate = (i, drill) => {
      sections.forEach((sec, j) => { sec.style.display = j === i ? '' : 'none'; });
      items.forEach((b, j) => b.classList.toggle('active', j === i));
      if (drill) layout.classList.add('pane-open');
      this._settingsActiveSec = i;
      pane.scrollTop = 0;
    };
    sections.forEach((sec, i) => {
      const title = sec.querySelector('.settings-section-title')?.textContent?.trim() || `Section ${i + 1}`;
      pane.appendChild(sec);
      const btn = document.createElement('button');
      btn.className = 'settings-nav-item';
      btn.innerHTML = `<span>${utils.safe(title)}</span><span class="sn-chev">›</span>`;
      btn.onclick = () => activate(i, true);
      nav.appendChild(btn);
      items.push(btn);
    });
    layout.appendChild(nav);
    layout.appendChild(pane);
    /* Desktop opens on the remembered (or first) section; mobile starts on
       the list (pane hidden by CSS until a section is chosen). */
    activate(Math.min(this._settingsActiveSec || 0, sections.length - 1), false);
  }

  /* ── More menu ──────────────────────────────────────────────────────── */
  toggleMoreMenu() {
    const p = this.g('more-popup');
    p.classList.toggle('open');
  }
  hideMoreMenu() {
    this.g('more-popup')?.classList.remove('open');
  }

  /* ── Channel history ────────────────────────────────────────────────── */
  async _touchChannelHistory(address) {
    if (!address || address === MAIN_CHANNEL) return;
    const existing = this.state.channelHistory.find(c => c.address === address) || {};
    const prof = this.state.profCache[address];
    const updated = {
      address,
      label:        prof?.username || existing.label || '',
      picUrl:       prof?.picUrl   || existing.picUrl || 'image1.jpeg',
      lastActivity: new Date().toISOString(),
      preview:      existing.preview || '',
      postCount:    (existing.postCount || 0) + 1,
    };
    await this.cache.saveChannel(updated);
    /* update in-memory list */
    const idx = this.state.channelHistory.findIndex(c => c.address === address);
    if (idx >= 0) this.state.channelHistory[idx] = updated;
    else this.state.channelHistory.unshift(updated);
    /* Cap history at 50 entries to prevent unbounded IDB growth. Also
       delete the popped (oldest) entry from IDB — otherwise the in-memory
       cap is meaningless because getChannels() reloads everything next
       session. */
    if (this.state.channelHistory.length > 50) {
      const popped = this.state.channelHistory.pop();
      if (popped?.address) {
        this.cache.deleteChannel(popped.address).catch(() => {});
      }
    }
  }

  async rebuildChannelHistory() {
    if (!this.state.signerAddr) return;
    utils.toast('Scanning chain for channel history…', 5000);
    const seen = new Map(); /* address → {lastActivity, preview, postCount} */
    try {
      /* Respect user's scan-depth setting but cap at 20 pages (1000 txs) —
         most users have far fewer than 20 active channels in their history. */
      const chLimit = Math.min(this._getMaxScanPages(), 20);
      for (let page = 1; page <= chLimit; page++) {
        let raw;
        try { raw = await this.apiFetch(this.state.signerAddr, page); }
        catch { break; }
        raw.forEach(tx => {
          const from = tx.from?.toLowerCase();
          const to   = tx.to?.toLowerCase();
          if (!tx.input || tx.input === '0x') return;
          /* Interactions: from=me → channel, or from=other → me */
          const partner = (from === this.state.signerAddr) ? to : from;
          if (!partner || partner === this.state.signerAddr || partner === MAIN_CHANNEL) return;
          try {
            const text = ethers.toUtf8String(tx.input).trim();
            if (text.startsWith(PROFILE_PREFIX)) return;
            if (text.startsWith(LIKE_PREFIX) || text.startsWith(UNLIKE_PREFIX)) return;
            if (text.startsWith(BOOKMARK_PREFIX) || text.startsWith(UNBOOKMARK_PREFIX)) return;
            if (text.startsWith(FOLLOW_PREFIX) || text.startsWith(UNFOLLOW_PREFIX)) return;
            const ts = tx.timeStamp ? new Date(Number(tx.timeStamp) * 1000).toISOString() : '';
            const prev = seen.get(partner);
            if (!prev || ts > prev.lastActivity) {
              seen.set(partner, {
                lastActivity: ts,
                preview: text.slice(0, 80),
                postCount: (prev?.postCount || 0) + 1,
              });
            }
          } catch { /* skip */ }
        });
        if (raw.length < 50) break;
      }
    } catch { /* silent */ }

    /* Merge with existing cache */
    for (const [address, data] of seen) {
      const existing = this.state.channelHistory.find(c => c.address === address) || {};
      const prof = this.state.profCache[address];
      await this.cache.saveChannel({
        address,
        label:        prof?.username || existing.label || '',
        picUrl:       prof?.picUrl   || existing.picUrl || 'image1.jpeg',
        lastActivity: data.lastActivity,
        preview:      data.preview,
        postCount:    data.postCount,
      });
    }

    /* Reload and re-render if still in channels view */
    this.state.channelHistory = await this.cache.getChannels();
    utils.safeLS.set(CHANNELS_KEY, Date.now().toString());
    if (this.state.mode === 'channels') {
      /* Refresh just the list body so the page header stays in place; if the
         page body isn't mounted yet, do a full render with a header. */
      if (this._chatTab === 'messages') { /* on the Messages tab — leave the DM list alone */ }
      else if (this.g('ch-page')) { this._renderChannelPage(); this._autoSelectFirstChannel(); }
      else this.renderChannelHistory(this._applyPageHeader());
    }
    utils.toast('Channel history updated ✓');
  }

  renderChannelHistory(headerHTML = '') {
    /* Seed the "seen" baseline on first ever visit so the Unread tab starts
       quiet (everything read as of now); new activity surfaces after that. */
    if (utils.safeLS.get('sayitChannelSeen') === null) this._markAllChannelsSeen();
    /* X-style two-column Chat layout, rendered entirely inside #feed (channels
       is a self-managed mode, so renderFeed bails and we own #feed). The left
       column is the existing channel list (#ch-page); the right column loads
       the selected channel's posts in place — no navigation away. Mirrors the
       Settings two-pane + mobile-drill pattern. */
    const tab = this._chatTab === 'messages' ? 'messages' : 'channels';
    this.g('feed').innerHTML = headerHTML + `
      <div class="ch-layout" id="ch-layout">
        <div class="ch-col-list">
          <div class="chat-toggle" role="tablist">
            <button class="chat-toggle-btn${tab === 'channels' ? ' active' : ''}" data-chat-tab="channels" role="tab">Channels</button>
            <button class="chat-toggle-btn${tab === 'messages' ? ' active' : ''}" data-chat-tab="messages" role="tab">Messages 🔒</button>
          </div>
          <div id="ch-page"></div>
        </div>
        <div class="ch-col-pane">
          <button class="ch-pane-back" id="ch-pane-back">← ${tab === 'messages' ? 'Messages' : 'Channels'}</button>
          <div id="ch-pane-content"></div>
        </div>
      </div>`;
    const back = this.g('ch-pane-back');
    if (back) back.onclick = () => this.g('ch-layout')?.classList.remove('pane-open');
    this.g('feed').querySelectorAll('[data-chat-tab]').forEach(btn => {
      btn.onclick = () => this._setChatTab(btn.dataset.chatTab);
    });
    if (tab === 'messages') {
      this._renderDmPanePlaceholder();
      this._loadConversations(this._dmPeer);
      return;
    }
    this._renderChannelPage();
    /* Mobile starts on the list (pane hidden by CSS until a row is tapped);
       show the placeholder until something is selected. On desktop,
       _autoSelectFirstChannel opens the first real (non-special) channel. */
    if (!this._chSelected) this._renderChannelPanePlaceholder();
    this._autoSelectFirstChannel();
  }

  /* Switch the Chat page between the Channels list and encrypted Messages,
     keeping the same "Chat" header. */
  _setChatTab(tab) {
    tab = tab === 'messages' ? 'messages' : 'channels';
    if (tab === (this._chatTab || 'channels')) return;
    this._chatTab = tab;
    this._chSelected = null; this._dmPeer = null;
    this._setRoute(tab === 'messages' ? '/messages' : '/channels');
    const headerEl = this.g('feed').querySelector('.page-header');
    this.renderChannelHistory(headerEl ? headerEl.outerHTML : this._applyPageHeader());
  }

  /* Desktop: open the first NON-special channel (X opens the first conversation)
     when nothing is selected yet. Safe to call repeatedly — it's re-invoked
     after the async channel rescan so a channel that loads later still opens. */
  _autoSelectFirstChannel() {
    if (window.innerWidth <= 768 || this._chSelected) return;
    const firstRow = this.g('ch-page')?.querySelector('[data-ch-open]');
    if (firstRow) this._selectChannelPane(firstRow.dataset.chOpen);
  }

  /* Centered empty-state for the right pane (nothing selected). */
  _renderChannelPanePlaceholder() {
    const host = this.g('ch-pane-content');
    if (!host) return;
    host.innerHTML = `
      <div class="ch-pane-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none"
             stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round"
             stroke-linejoin="round" aria-hidden="true">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
        </svg>
        <h3>Select a channel</h3>
        <p>Choose a conversation from the list to view its posts here.</p>
      </div>`;
  }

  /* Select a channel row: highlight it in the list, mark the pane open on
     mobile (drill-in), and load the channel into the right pane in place. */
  _selectChannelPane(addr) {
    if (!addr) return;
    this._chSelected = addr.toLowerCase();
    /* Highlight the active row (mirror .settings-nav-item.active). */
    const page = this.g('ch-page');
    if (page) {
      page.querySelectorAll('[data-ch-open]').forEach(el => {
        el.classList.toggle('active', (el.dataset.chOpen || '').toLowerCase() === this._chSelected);
      });
    }
    /* Mobile drill-in: reveal the pane, hide the list. Desktop ignores this. */
    this.g('ch-layout')?.classList.add('pane-open');
    this._loadChannelPane(this._chSelected);
  }

  /* Load one channel's recent posts into the right pane WITHOUT mutating the
     global state.channel/mode. Posts are registered in _postMap so the global
     #feed click delegation handles their like/reply/repost/menu actions. */
  async _loadChannelPane(addr) {
    const host = this.g('ch-pane-content');
    if (!host) return;
    addr = (addr || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) {
      host.innerHTML = `<div class="ch-pane-empty"><h3>Invalid address</h3></div>`;
      return;
    }
    /* Header (avatar + name + truncated address + "Open full view ↗") and a
       compose box render immediately; the post list streams in after fetch. */
    const prof = this.state.profCache[addr];
    const name = prof?.username || this.trunc(addr);
    const pic  = prof?.picUrl || 'image1.jpeg';
    host.innerHTML = `
      <div class="ch-pane-header">
        <img src="${utils.safe(pic)}" class="ch-pane-avatar" alt="" data-fallback-src="image1.jpeg">
        <div class="ch-pane-id">
          <div class="ch-pane-name">${utils.safe(name)}</div>
          <div class="ch-pane-addr">${utils.safe(this.trunc(addr))}</div>
        </div>
        <button class="ch-pane-fullview" id="ch-pane-fullview" title="Open the full chat">Open full chat ↗</button>
      </div>
      <div id="ch-pane-posts"><div class="ch-pane-loading"><div class="spinner" aria-hidden="true"></div></div></div>
      <div class="ch-pane-compose">
        <textarea id="ch-pane-compose" rows="2" placeholder="Post to this channel…"></textarea>
        <div class="ch-pane-compose-actions">
          <div class="compose-icons">
            <button class="cmp-icon" id="ch-media-btn" title="Add photos or video" aria-label="Add media">
              <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 5.5C3 4.119 4.119 3 5.5 3h13C19.881 3 21 4.119 21 5.5v13c0 1.381-1.119 2.5-2.5 2.5h-13C4.119 21 3 19.881 3 18.5v-13zM5.5 5c-.276 0-.5.224-.5.5v9.086l3-3 3 3 5-5 3 3V5.5c0-.276-.224-.5-.5-.5h-13zM19 15.414l-3-3-5 5-3-3-3 3V18.5c0 .276.224.5.5.5h13c.276 0 .5-.224.5-.5v-3.086zM9.75 7C8.784 7 8 7.784 8 8.75s.784 1.75 1.75 1.75 1.75-.784 1.75-1.75S10.716 7 9.75 7z"/></svg>
            </button>
            <button class="cmp-icon" id="ch-gif-btn" title="Add a GIF" aria-label="Add GIF">
              <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 5.5C3 4.119 4.119 3 5.5 3h13C19.881 3 21 4.119 21 5.5v13c0 1.381-1.119 2.5-2.5 2.5h-13C4.119 21 3 19.881 3 18.5v-13zM5.5 5c-.276 0-.5.224-.5.5v13c0 .276.224.5.5.5h13c.276 0 .5-.224.5-.5v-13c0-.276-.224-.5-.5-.5h-13zM8 13.5v-3h1.5v.75H11v1.5H9.5v.75H8zm4.5-3H14c.552 0 1 .448 1 1v1c0 .552-.448 1-1 1h-1.5V10.5zm1.25 1.25v.5H14v-.5h-.25zM15.5 10.5H17v1.25h-1.5v.25H17v1.25h-1.5c-.552 0-1-.448-1-1v-1.25c0-.552.448-.5 1-.5z"/></svg>
            </button>
            <button class="cmp-icon" id="ch-emoji-btn" title="Emoji" aria-label="Insert emoji">
              <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8 9.5C8 8.672 8.672 8 9.5 8s1.5.672 1.5 1.5S10.328 11 9.5 11 8 10.328 8 9.5zm6.5 1.5c.828 0 1.5-.672 1.5-1.5S15.328 8 14.5 8 13 8.672 13 9.5s.672 1.5 1.5 1.5zM12 16c-2.224 0-3.021-1.4-3.094-1.536l-1.76.992C7.196 15.69 8.638 18 12 18s4.804-2.31 4.854-2.544l-1.76-.992C15.021 14.6 14.224 16 12 16zm-.002-14C6.477 2 2 6.477 2 12s4.477 10 9.998 10C17.523 22 22 17.523 22 12S17.523 2 11.998 2zM12 20C7.582 20 4 16.418 4 12s3.582-8 8-8 8 3.582 8 8-3.582 8-8 8z"/></svg>
            </button>
          </div>
          <button class="go-btn" id="ch-pane-post" disabled>Post</button>
        </div>
      </div>`;

    /* Wire header + compose (CSP-safe: no inline handlers). */
    const fv = this.g('ch-pane-fullview');
    if (fv) fv.onclick = () => this._openChannelFromHistory(addr);
    const ta = this.g('ch-pane-compose'), post = this.g('ch-pane-post');
    if (ta && post) {
      ta.oninput = () => { post.disabled = !ta.value.trim(); };
      post.onclick = () => this._postToChannelPane(addr);
      /* Compose toolbar — media/GIF open the rich media modal (with preview)
         targeting THIS box; emoji opens the picker targeting it. Both their
         inserts dispatch 'input', which re-enables Post via ta.oninput. */
      const cm = this.g('ch-media-btn');
      if (cm) cm.onclick = () => this.openMediaModal('media', ta);
      const cg = this.g('ch-gif-btn');
      if (cg) cg.onclick = () => this.openMediaModal('gif', ta);
      const ce = this.g('ch-emoji-btn');
      if (ce) ce.onclick = () => this._openEmojiPickerFor(ta, ce);
    }

    /* Fetch one page of the channel's txlist and parse posts TO this channel,
       newest-first, capped at 30. Stale-guard against rapid row switching. */
    /* Load the chat's posts page by page — full history via "Load older". */
    this._chPanePosts = [];
    await this._chPaneLoadPage(addr, 1);
  }

  /* Fetch one page of a chat's posts (TO the address), accumulate + render
     newest-first, and show a "Load older posts" button while pages remain.
     Stale-guarded against rapid row switching. */
  async _chPaneLoadPage(addr, page) {
    if (this._chSelected !== addr || this.state.mode !== 'channels') return;
    const ph = this.g('ch-pane-posts');
    if (!ph) return;
    let raw;
    try { raw = await this.apiFetch(addr, page); }
    catch {
      if (this._chSelected !== addr) return;
      if (page === 1) ph.innerHTML = `<div class="ch-pane-empty"><p>Couldn't load this chat. Try again.</p></div>`;
      else { const mb0 = this.g('ch-pane-more'); if (mb0) { mb0.disabled = false; mb0.textContent = 'Load older posts'; } }
      return;
    }
    if (this._chSelected !== addr || this.state.mode !== 'channels') return;
    /* New posts on this page (TO the chat, not already loaded). */
    const newPosts = [];
    for (const tx of raw) {
      if (tx.to?.toLowerCase() !== addr) continue;
      const p = this._parsePostTx(tx, { mode: 'custom', extra: { channel: addr } });
      if (p && !this._chPanePosts.some(x => x.txHash === p.txHash)) { this._chPanePosts.push(p); newPosts.push(p); }
    }
    this.g('ch-pane-sentinel')?.remove();
    if (!this._chPanePosts.length) {
      ph.innerHTML = `<div class="ch-pane-empty"><p>No posts in this chat yet — be the first.</p></div>`;
      return;
    }
    const replyMap = new Map();
    this._chPanePosts.forEach(p => { if (p.parentTx) replyMap.set(p.parentTx, (replyMap.get(p.parentTx) || 0) + 1); });
    newPosts.forEach(p => this._postMap.set(p.txHash, p));
    /* Append this page's posts (page 1 replaces; later pages append → no scroll
       jump). A sentinel at the bottom auto-loads the next page on scroll. */
    const frag = newPosts.map(p =>
      `<div class="post-item" data-txhash="${utils.safe(p.txHash)}">${this.postHTML(p, false, replyMap, null)}</div>`
    ).join('');
    if (page === 1) ph.innerHTML = frag; else ph.insertAdjacentHTML('beforeend', frag);
    if (raw.length >= 50) {
      ph.insertAdjacentHTML('beforeend', '<div id="ch-pane-sentinel" style="height:1px"></div>');
      const sentinel = this.g('ch-pane-sentinel');
      if (sentinel) {
        const obs = new IntersectionObserver(es => {
          if (es[0].isIntersecting) { obs.disconnect(); this._chPaneLoadPage(addr, page + 1); }
        }, { root: ph, rootMargin: '500px' });
        obs.observe(sentinel);
      }
    }
    /* Auto-load X/YouTube embeds on scroll (same as the profile/feed) and lazy
       author profiles + poll tallies, for the posts just added. */
    this._wireVideoObserver(ph);
    newPosts.forEach(p => { if (p.reporter !== this.state.signerAddr) this.fetchOtherProfile(p.reporter); });
    if (newPosts.some(pp => pp.poll)) setTimeout(() => this._tallyVisiblePolls(), 100);
  }

  /* Post to the channel currently shown in the pane. Optimistically prepends
     the new post to the pane list and registers it in _postMap. */
  async _postToChannelPane(addr) {
    addr = (addr || '').toLowerCase();
    const ta = this.g('ch-pane-compose');
    const text = ta?.value.trim();
    if (!text) return;
    if (!this.signer) { utils.toast('Connect wallet to post'); return; }
    const post = this.g('ch-pane-post');
    if (post) post.disabled = true;
    let hash;
    try { hash = await this.publish(text, null, addr); }
    finally { if (post) post.disabled = !ta?.value.trim(); }
    if (!hash) return;
    /* Clear the box. */
    if (ta) { ta.value = ''; }
    if (post) post.disabled = true;
    /* Stale-guard: only mutate the pane if it still shows this channel. */
    if (this._chSelected !== addr || this.state.mode !== 'channels') return;
    /* Build a minimal optimistic post (same shape as publish's optimistic row). */
    const optimistic = {
      content: text, display: text,
      parentTx: null, direction: null, repostOf: null, poll: null, postType: 'post',
      reporter: this.state.signerAddr, to: addr,
      timestamp: new Date().toISOString(),
      txHash: hash, channel: addr, mode: 'custom',
    };
    this._postMap.set(hash, optimistic);
    const ph = this.g('ch-pane-posts');
    if (!ph) return;
    /* Drop any empty-state placeholder before prepending the first post. */
    const empty = ph.querySelector('.ch-pane-empty');
    if (empty) ph.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'post-item';
    el.dataset.txhash = hash;
    el.innerHTML = this.postHTML(optimistic, false, new Map(), null);
    ph.insertBefore(el, ph.firstChild);
  }

  /* Render (and re-render on tab switch / mark-read) the Channels page body:
     a new-channel input, the All/Unread/Following tab bar, pinned quick-access
     rows (Main, your inbox, official), then the channel list for the tab. */
  _renderChannelPage() {
    const host = this.g('ch-page');
    if (!host) return;
    const tab     = this._channelTab || 'all';
    const seen    = this._getChannelSeen();
    const follow  = this.state.following;
    const history = this.state.channelHistory || [];

    /* No pinned static rows on the Chat page anymore — Main Feed lives under
       Home, your own inbox under My Channel, and Say It DeFi Support moved to
       the right-sidebar footer. The Chat list is now purely your conversations. */
    const pinned = [];

    /* Visited/scanned channels, plus synthesized rows for follows not yet visited. */
    const entries = history.map(ch => ({
      addr: ch.address,
      name: ch.label || this.trunc(ch.address),
      pic:  ch.picUrl || 'image1.jpeg',
      preview: ch.preview || '',
      time: ch.lastActivity ? this.relTime(ch.lastActivity) : '',
      unread: this._channelIsUnread(ch, seen),
      following: follow.has((ch.address || '').toLowerCase()),
      posts: ch.postCount || 0,
    }));
    const have = new Set(history.map(c => (c.address || '').toLowerCase()));
    for (const addr of follow) {
      if (have.has(addr)) continue;
      const prof = this.state.profCache[addr];
      entries.push({ addr, name: prof?.username || this.trunc(addr),
        pic: prof?.picUrl || 'image1.jpeg', preview:'', time:'', unread:false, following:true });
    }

    /* Drop the user's own address — it's shown once as the pinned "My Chat" row,
       so it must not also appear as a regular entry (was showing twice). */
    const meLc = (this.state.signerAddr || '').toLowerCase();
    const entriesNoMe = meLc ? entries.filter(e => (e.addr || '').toLowerCase() !== meLc) : entries;

    /* Filter by active tab. */
    let pins = pinned, list = entriesNoMe;
    if (tab === 'unread')        { pins = pinned.filter(p => p.unread); list = entriesNoMe.filter(e => e.unread); }
    else if (tab === 'following'){ pins = []; list = entriesNoMe.filter(e => e.following); }

    const TABS = { all:'All', unread:'Unread', following:'Following' };
    const row = e => {
      const left = e.special
        ? `<div class="ch-pin-icon">${e.icon}</div>`
        : `<img src="${utils.safe(e.pic)}" class="ch-hist-avatar" alt="" data-fallback-src="image1.jpeg">`;
      const right = e.unread
        ? (e.count ? `<span class="ch-hist-count">${e.count > 99 ? '99+' : e.count}</span>` : `<span class="ch-unread-dot"></span>`)
        : (e.posts ? `<span class="ch-hist-posts">${e.posts > 999 ? '999+' : e.posts}</span>` : '');
      const time = e.time ? `<span class="ch-hist-time">${utils.safe(e.time)}</span>` : '';
      const open = e.special ? `data-ch-special="${e.special}"` : `data-ch-open="${utils.safe(e.addr)}"`;
      return `<div class="ch-history-item${e.unread ? ' ch-item-unread' : ''}" role="button" tabindex="0" ${open}>
        ${left}
        <div class="ch-hist-body">
          <div class="ch-hist-top"><span class="ch-hist-name">${utils.safe(e.name)}</span>${time}</div>
          <div class="ch-hist-preview">${utils.safe(e.special ? e.sub : e.preview)}</div>
        </div>
        ${right}
      </div>`;
    };

    let html = `
      <div class="ch-new-row">
        <input type="text" id="ch-new-input" placeholder="Enter 0x address to open a channel…">
        <button class="go-btn" id="ch-new-go">Go</button>
      </div>
      <div class="ch-tabs">
        ${Object.keys(TABS).map(t => `<button class="ch-tab${tab === t ? ' active' : ''}" data-ch-tab="${t}">${TABS[t]}</button>`).join('')}
        <span class="ch-tab-spacer"></span>
        <button class="ch-tab ch-tab-action" id="ch-mark-read" title="Mark all as read">✓ Read</button>
        <button class="ch-tab ch-tab-action" id="ch-rescan" title="Rescan the chain for channels">↺</button>
      </div>`;

    /* "My Chat" — the connected user's own channel, pinned first (opens in the
       pane like any other chat). Hidden on the Following tab (it's you, not a
       follow). Replaces the old "My Channel" nav button. */
    const me = this.state.signerAddr;
    const myProf = me ? (this.state.profCache[me] || this.state.profile || {}) : {};
    const myChatRow = (me && tab !== 'following')
      ? `<div class="ch-history-item ch-mychat" role="button" tabindex="0" data-ch-open="${utils.safe(me)}">
          <img src="${utils.safe(utils.safeUrl(myProf.picUrl) || 'image1.jpeg')}" class="ch-hist-avatar" alt="" data-fallback-src="image1.jpeg">
          <div class="ch-hist-body"><div class="ch-hist-top"><span class="ch-hist-name">My Chat</span></div>
          <div class="ch-hist-preview">Your channel · posts sent to you</div></div>
        </div>`
      : '';

    if (!myChatRow && !pins.length && !list.length) {
      const msg = tab === 'unread'    ? 'Nothing unread 🎉'
        : tab === 'following' ? (this.state.signerAddr ? "You're not following anyone yet" : 'Connect your wallet to see who you follow')
        : 'No chats yet — post to any address and it shows up here.';
      html += `<div class="ch-empty-tab">${msg}</div>`;
    } else {
      html += myChatRow + pins.map(row).join('') + list.map(row).join('');
    }

    host.innerHTML = html;

    /* Wiring */
    const inp = this.g('ch-new-input'), go = this.g('ch-new-go');
    if (inp && go) {
      go.onclick = () => this._openChannelFromInput();
      inp.onkeydown = e => { if (e.key === 'Enter') this._openChannelFromInput(); };
    }
    host.querySelectorAll('[data-ch-tab]').forEach(el => {
      el.onclick = () => { this._channelTab = el.dataset.chTab; this._renderChannelPage(); };
    });
    host.querySelectorAll('[data-ch-open]').forEach(el => {
      /* Load the channel into the right pane in place — do NOT navigate away.
         (The "Open full view ↗" button in the pane header reaches goCustom
         for power users who want the virtualized full feed.) */
      el.onclick = () => this._selectChannelPane(el.dataset.chOpen);
      /* Re-apply the active highlight after a tab switch / rescan re-render. */
      if (this._chSelected && (el.dataset.chOpen || '').toLowerCase() === this._chSelected) {
        el.classList.add('active');
      }
    });
    host.querySelectorAll('[data-ch-special]').forEach(el => {
      el.onclick = () => this._openChannelSpecial(el.dataset.chSpecial);
    });
    const mr = this.g('ch-mark-read'); if (mr) mr.onclick = () => { this._markAllChannelsSeen(); this._renderChannelPage(); };
    const rs = this.g('ch-rescan');    if (rs) rs.onclick = () => this.rebuildChannelHistory();

    /* Lazy-load missing profile pics/names for channel rows. */
    history.forEach(ch => {
      if (!ch.label || ch.picUrl === 'image1.jpeg') {
        this.fetchOtherProfile(ch.address).then(() => {
          const prof = this.state.profCache[ch.address];
          /* prof can be null when a concurrent fetch is still in flight (the
             dedup early-return leaves the cache null) — guard before reading
             .username, or this throws "null.username". */
          if (prof && (prof.username || prof.picUrl !== 'image1.jpeg')) {
            this.cache.saveChannel({ ...ch, label: prof.username, picUrl: prof.picUrl });
          }
        });
      }
    });
  }

  _openChannelSpecial(kind) {
    if (kind === 'main')          this.goHome();
    else if (kind === 'inbox')    this.goSelf();
    else if (kind === 'official') this.goOfficialChannel();
  }

  /* ── Per-channel "seen" tracking for the Unread tab ──────────────────────
     A channel is unread when its recorded lastActivity is newer than the last
     time we marked it seen. Approximate by design: lastActivity only advances
     when you open the channel or run a rescan (there's no live backend). */
  _getChannelSeen() {
    try { return JSON.parse(utils.safeLS.get('sayitChannelSeen', '{}')) || {}; }
    catch { return {}; }
  }
  _markChannelSeen(address) {
    if (!address) return;
    const m = this._getChannelSeen();
    m[address.toLowerCase()] = new Date().toISOString();
    utils.safeLS.set('sayitChannelSeen', JSON.stringify(m));
  }
  _markAllChannelsSeen() {
    const m = this._getChannelSeen();
    const now = new Date().toISOString();
    (this.state.channelHistory || []).forEach(c => { if (c.address) m[c.address.toLowerCase()] = now; });
    utils.safeLS.set('sayitChannelSeen', JSON.stringify(m));
  }
  _channelIsUnread(ch, seen) {
    if (!ch || !ch.lastActivity) return false;
    const s = (seen || this._getChannelSeen())[(ch.address || '').toLowerCase()];
    return !s || ch.lastActivity > s;
  }

  async _openChannelFromHistory(address) {
    this.g('custom-input').value = address;
    await this.goCustom();
  }

  _openChannelFromInput() {
    const val = this.g('ch-new-input')?.value.trim().toLowerCase();
    if (!val) return;
    if (!ethers.isAddress(val)) { utils.toast('Invalid address'); return; }
    this.g('custom-input').value = val;
    this.goCustom();
  }

  /* ── Settings state accessors (the Settings page UI lives in settings.js;
        these stay here because init()'s sync prefix reads them at boot) ──── */
  _getSettings() {
    try { return JSON.parse(utils.safeLS.get(SETTINGS_KEY, '{}')); }
    catch { return {}; }
  }
  _getPostCap() {
    const s = this._getSettings();
    /* No cap by default — block gas limit caps individual post size, and
       IndexedDB has plenty of room for any realistic feed. Users can set
       a manual cap in Settings if they want to bound memory usage on
       very long-lived sessions. */
    if (s.postCap === 'unlimited' || s.postCap === '0' || s.postCap === 0) return Infinity;
    return Number(s.postCap) || Infinity;
  }
  /* Max API pages for deep scans. 0 = Infinity (unlimited).
     Default 100 pages = 5000 txs. */
  _getMaxScanPages() {
    const s = this._getSettings();
    const v = Number(s.maxScanPages);
    /* Default (unset) is now Unlimited — deeper history for follows/search/
       profile scans. The main feed is bounded by MAX_PAGES regardless. */
    if (s.maxScanPages === undefined || s.maxScanPages === 0 || s.maxScanPages === '0') return Infinity;
    return v || 100;
  }
  /* Polite rate-limit pause between API pages */
  _scanDelay(ms = 150) {
    return new Promise(res => setTimeout(res, ms));
  }
  _saveSettings(s) {
    utils.safeLS.set(SETTINGS_KEY, JSON.stringify(s));
    this.state.settings = s;
  }

  setNav(desktopId, mobileKey) {
    this._navToken++;   /* invalidate any in-flight view render */
    this.hideProfilePopup?.();
    this._threadBackOverride = false;
    /* Per-view body marker — views that need view-scoped CSS (e.g. hiding
       the compose FAB on Settings) re-add their class after calling setNav. */
    document.body.classList.remove('mode-settings');
    document.body.classList.remove('mode-explore');
    document.body.classList.remove('mode-channels');
    this._profileScanCache = {}; /* clear stale profile scan data on navigation */
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.mn-btn').forEach(b => b.classList.remove('active'));
    if (desktopId) this.g(desktopId)?.classList.add('active');
    if (mobileKey) document.querySelector(`[data-mn="${mobileKey}"]`)?.classList.add('active');
  }

  setChActive(id) {
    document.querySelectorAll('.ch-btn').forEach(b => b.classList.remove('active'));
    if (id) this.g(id)?.classList.add('active');
  }

  updateChLabel() {
    const { mode, channel, signerAddr } = this.state;
    const map = {
      main:          `Main: ${this.trunc(MAIN_CHANNEL)}`,
      notifications: `To: ${this.trunc(signerAddr || '')}`,
      self:          `My channel: ${this.trunc(signerAddr || '')}`,
      custom:        `Channel: ${this.trunc(channel)}`,
      channels:      'Your channel history',
      explore:       'Discover on PulseChain',
      bookmarks:     'Saved posts',
      settings:      'App configuration',
      profile:       'Your on-chain profile',
    };
    const _chLabel = this.g('ch-label');
    if (_chLabel) _chLabel.textContent = map[mode] || '';
  }

  showChannelBanner(address) {
    const banner = this.g('channel-banner');
    banner.style.display = 'block';
    banner.className = '';
    if (address === this.state.signerAddr) {
      this.renderBanner(this.state.profile, address); return;
    }
    const cached = this.state.profCache[address];
    if (cached) { this.renderBanner(cached, address); }
    else {
      this.renderBanner({ username:'', picUrl:'image1.jpeg', bio:'Loading profile…' }, address);
      this.fetchOtherProfile(address).then(() => {
        const loaded = this.state.profCache[address];
        if (loaded && banner.style.display !== 'none') this.renderBanner(loaded, address);
      });
    }
    /* Token channel: fetch DexScreener identity (Layer 1), the deployer/owner
       editor set + any deployer/owner-signed profile (Layer 2), then re-render.
       renderBanner reads these caches, so a profile re-render won't clobber
       them and precedence is: human self-profile > verified > token > address. */
    const reRender = () => {
      if (this.state.channel === address && banner.style.display !== 'none') {
        this.renderBanner(this.state.profCache[address] || {}, address);
      }
    };
    /* Render each piece as soon as it lands so a slow scan never blocks the
       rest: DexScreener identity (fast), the deployer/owner editor set (fast —
       this is what reveals the "Set token profile" button), and finally any
       existing deployer/owner-verified profile (slower — scans tx history). */
    this._fetchTokenInfo(address).then(reRender);
    this._fetchTokenAuth(address).then(reRender);
    this._fetchVerifiedTokenProfile(address).then(reRender);
  }

  renderBanner(profile, address) {
    /* Identity precedence: a human self-profile wins; else a deployer/owner-
       VERIFIED token profile; else DexScreener token identity; else the raw
       address. A token contract can't self-publish, so the human case never
       collides with the token cases. */
    const lc       = (address || '').toLowerCase();
    const token    = this._tokenInfoCache?.[lc];
    const verified = this._verifiedTokenCache?.[lc];
    const auth     = this._tokenAuthCache?.[lc];
    const hasHuman = !!(profile && profile.username);
    const vPic     = verified && utils.safeUrl(verified.picUrl || '');
    this.g('cb-avatar').src = hasHuman ? (profile.picUrl || 'image1.jpeg')
      : (vPic || (token && token.logo) || profile?.picUrl || 'image1.jpeg');
    this.g('cb-name').textContent = hasHuman ? profile.username
      : (verified && verified.username) ? verified.username
      : token ? (token.symbol ? `${token.name} (${token.symbol})` : token.name)
      : this.trunc(address);
    this.g('cb-bio').textContent = profile?.bio || (verified && verified.bio) || (token ? 'Token on PulseChain' : '');
    this.g('cb-address').textContent = address || '';
    /* Sticky page-style header — mirrors the profile: name as the title, and a
       post-count subtitle (filled by _updateChannelSubtitle once the feed
       loads), rather than a redundant "Channel" label. */
    const _hdrTitle = this.g('cb-header-title');
    if (_hdrTitle) _hdrTitle.textContent = this.g('cb-name').textContent || 'Chat';
    this._updateChannelSubtitle();
    const meta = this.g('cb-token-meta');
    if (meta) meta.innerHTML = (verified || token) ? this._tokenMetaHTML(token, !!verified, verified) : '';
    /* "Set token profile" — shown only when the connected wallet is the
       token's deployer or current owner(). */
    const editBtn = this.g('cb-token-edit-btn');
    if (editBtn) {
      const canEdit = !!(auth && this.state.signerAddr && auth.editors && auth.editors.has(this.state.signerAddr));
      editBtn.style.display = canEdit ? '' : 'none';
      if (canEdit) editBtn.onclick = e => { e.stopPropagation(); this._openTokenProfileEditor(address); };
    }
    /* Follow button for contract/token channel pages (hidden on your own). */
    const followBtn = this.g('cb-follow-btn');
    if (followBtn) {
      const addr = address?.toLowerCase();
      if (!addr || addr === this.state.signerAddr) {
        followBtn.style.display = 'none';
      } else {
        followBtn.style.display = '';
        const isF = this.state.following.has(addr);
        followBtn.textContent = isF ? 'Following' : 'Follow';
        followBtn.classList.toggle('following', isF);
        followBtn.onclick = e => { e.stopPropagation(); this.toggleFollowAddr(addr, followBtn); };
      }
    }
    /* "View profile" jumps to the full profile page for this channel's address.
       (Channel = posts TO an address; profile = that address's identity + posts
       BY them.) Shown for any address, including your own. */
    const profileBtn = this.g('cb-profile-btn');
    if (profileBtn) {
      if (address) {
        profileBtn.style.display = '';
        profileBtn.onclick = e => {
          e.stopPropagation();
          this.goProfilePage(address, address.toLowerCase() === this.state.signerAddr);
        };
      } else {
        profileBtn.style.display = 'none';
      }
    }
    /* Show profile cover image in the banner if available. Use
       utils.cssUrlValue to fully escape for CSS context AND validate
       the scheme — chain data is attacker-controlled. */
    const coverEl = document.querySelector('#channel-banner .cb-cover');
    if (coverEl) {
      /* Cover precedence: human cover > dev-verified cover > DexScreener banner. */
      const coverSrc = (profile && profile.coverUrl) || (verified && verified.coverUrl) || (token && token.header) || '';
      const safeCover = coverSrc ? utils.cssUrlValue(coverSrc) : '';
      if (safeCover) {
        coverEl.style.background = `url('${safeCover}') center/cover no-repeat`;
      } else {
        /* Reset to default gradient if no cover */
        coverEl.style.background = '';
      }
    }
  }

  /* Look up token identity for a channel address via DexScreener (name,
     symbol, logo, website, socials). Cached per address (null = not a
     DEX-listed token). Best-effort: any failure resolves to null so the
     banner just falls back to the plain address. */
  async _fetchTokenInfo(address) {
    const key = (address || '').toLowerCase();
    if (!key) return null;
    this._tokenInfoCache = this._tokenInfoCache || {};
    if (key in this._tokenInfoCache) return this._tokenInfoCache[key];
    let result = null;
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${key}`);
      if (r.ok) {
        const d = await r.json();
        /* Only treat it as "this token" when it's the BASE token of a pair
           (otherwise we'd mislabel e.g. DAI when it's just the quote side). */
        const pair = (d.pairs || []).find(p => p.baseToken?.address?.toLowerCase() === key);
        if (pair) {
          const bt = pair.baseToken || {}, info = pair.info || {};
          result = {
            name:   bt.name || 'Token',
            symbol: bt.symbol || '',
            logo:   utils.safeUrl(info.imageUrl || '') || '',
            header: utils.safeUrl(info.header || '') || '', /* DexScreener banner (600x200), if the token set one */
            website:(info.websites || [])[0]?.url || '',
            socials: Array.isArray(info.socials) ? info.socials : [],
            dexUrl: pair.url || '',
          };
        }
      }
    } catch { /* offline or not a token — leave null */ }
    this._tokenInfoCache[key] = result;
    return result;
  }

  /* Badge + website/socials/DexScreener links for a token channel banner.
     `token` (DexScreener) may be null when only a verified profile exists.
     All URLs are scheme-validated + escaped (this data is third-party). */
  _tokenMetaHTML(token, isVerified, verified) {
    const link = (url, label) => {
      const u = utils.safeUrl(url || '');
      return u ? `<a href="${utils.safe(u)}" target="_blank" rel="noopener noreferrer">${utils.safe(label)}</a>` : '';
    };
    const parts = [ isVerified
      ? '<span class="cb-token-badge cb-verified-badge">✓ Verified</span>'
      : '<span class="cb-token-badge">⬡ Token</span>' ];
    const website = (verified && verified.website) || (token && token.website);
    if (website) parts.push(link(website, '🌐 Website'));
    if (token) (token.socials || []).forEach(s => parts.push(link(s.url, (s.type || 'link'))));
    if (token && token.dexUrl) parts.push(link(token.dexUrl, 'DexScreener ↗'));
    return parts.filter(Boolean).join('');
  }

  /* Read-only provider for view calls (owner()) without a connected wallet. */
  _getReadProvider() {
    if (!this._readProvider) {
      const s = this._getSettings();
      this._readProvider = new ethers.JsonRpcProvider(
        s.rpcUrl || 'https://rpc.pulsechain.com', PULSE_CHAIN_ID);
    }
    return this._readProvider;
  }

  /* Resolve a token channel's authorized editors: the contract deployer
     (Blockscout v2 `creator_address_hash`) plus the current `owner()` if the
     contract is Ownable. Cached. { isContract, deployer, owner, editors:Set }. */
  async _fetchTokenAuth(address) {
    const key = (address || '').toLowerCase();
    if (!key) return null;
    this._tokenAuthCache = this._tokenAuthCache || {};
    if (key in this._tokenAuthCache) return this._tokenAuthCache[key];
    const auth = { isContract:false, deployer:null, owner:null, editors:new Set() };
    try {
      const s = this._getSettings();
      const base = (s.apiUrl || 'https://api.scan.pulsechain.com/api').replace(/\/api\/?$/, '');
      const r = await fetch(`${base}/api/v2/addresses/${key}`);
      if (r.ok) {
        const d = await r.json();
        auth.isContract = !!d.is_contract;
        const dep = (d.creator_address_hash || '').toLowerCase();
        if (dep) { auth.deployer = dep; auth.editors.add(dep); }
      }
    } catch { /* not reachable — leave defaults */ }
    if (auth.isContract) {
      try {
        const c = new ethers.Contract(key, ['function owner() view returns (address)'], this._getReadProvider());
        const o = (await c.owner()).toLowerCase();
        if (o && !/^0x0{40}$/.test(o)) { auth.owner = o; auth.editors.add(o); }
      } catch { /* not Ownable / reverted — fine */ }
    }
    this._tokenAuthCache[key] = auth;
    return auth;
  }

  /* Latest token profile (PROFILE_FOR:<token>) published by an authorized
     editor (deployer/owner). The publish sends the tx TO the token, so it
     lives in the token's channel; scan a few pages for it. Cached per token. */
  async _fetchVerifiedTokenProfile(address) {
    const key = (address || '').toLowerCase();
    if (!key) return null;
    this._verifiedTokenCache = this._verifiedTokenCache || {};
    if (key in this._verifiedTokenCache) return this._verifiedTokenCache[key];
    let result = null;
    const auth = await this._fetchTokenAuth(key);
    if (auth && auth.editors.size) {
      /* Scan each editor's OWN tx history for the latest PROFILE_FOR:<token>
         they published. Targeted + reliable: it's their own outgoing tx, so
         it's near the top of their list — far better than scanning a hot
         token's channel where it could be buried under thousands of txs. */
      for (const editor of auth.editors) {
        try {
          for (let page = 1; page <= 3; page++) {
            let raw;
            try { raw = await this.apiFetch(editor, page); } catch { break; }
            for (const tx of raw) {
              if (tx.from?.toLowerCase() !== editor || !tx.input || tx.input === '0x') continue;
              let text;
              try { text = ethers.toUtf8String(tx.input).trim(); } catch { continue; }
              if (!text.startsWith(TOKEN_PROFILE_PREFIX)) continue;
              const m = text.match(/^PROFILE_FOR:(0x[a-f0-9]{40})\n\n([\s\S]+)$/i);
              if (!m || m[1].toLowerCase() !== key) continue;
              let json; try { json = JSON.parse(m[2]); } catch { continue; }
              const ts = Number(tx.timeStamp) || 0;
              if (!result || ts > result._ts) result = { ...json, _ts: ts, by: editor };
            }
            if (raw.length < 50) break;
          }
        } catch { /* ignore this editor */ }
      }
    }
    this._verifiedTokenCache[key] = result;
    return result;
  }

  /* Form for a token's deployer/owner to set its channel profile. */
  _openTokenProfileEditor(address) {
    if (!this.signer) { utils.toast('Connect wallet'); return; }
    const lc = (address || '').toLowerCase();
    const v  = this._verifiedTokenCache?.[lc] || {};
    const t  = this._tokenInfoCache?.[lc] || {};
    const val = s => utils.safe(s || '');
    const body = `
      <div class="tp-form">
        <label class="tp-l">Name<input id="tp-name" class="tp-in" maxlength="60" value="${val(v.username || t.name)}"></label>
        <label class="tp-l">Bio<textarea id="tp-bio" class="tp-in" rows="3" maxlength="300">${val(v.bio)}</textarea></label>
        <label class="tp-l">Logo image URL<input id="tp-pic" class="tp-in" value="${val(v.picUrl || t.logo)}"></label>
        <label class="tp-l">Banner image URL<input id="tp-cover" class="tp-in" value="${val(v.coverUrl || t.header)}"></label>
        <label class="tp-l">Website<input id="tp-web" class="tp-in" value="${val(v.website)}"></label>
        <div class="tp-note">Published on-chain from your wallet (the token's deployer/owner) — anyone can verify it. Gas only; no value sent.</div>
        <button class="btn-pri" id="tp-save">Publish token profile</button>
      </div>`;
    this._showGenericModal('Set token profile', body);
    const save = document.getElementById('tp-save');
    if (save) save.onclick = () => {
      const data = {
        username: document.getElementById('tp-name').value.trim(),
        bio:      document.getElementById('tp-bio').value.trim(),
        picUrl:   document.getElementById('tp-pic').value.trim(),
        coverUrl: document.getElementById('tp-cover').value.trim(),
        website:  document.getElementById('tp-web').value.trim(),
      };
      this._closeGenericModal();
      this._publishTokenProfile(lc, data);
    };
  }

  /* Publish a PROFILE_FOR:<token> tx (to the token address). */
  async _publishTokenProfile(address, data) {
    if (!this.signer) { utils.toast('Connect wallet'); return; }
    const token = (address || '').toLowerCase();
    const body  = `${TOKEN_PROFILE_PREFIX}${token}\n\n${JSON.stringify(data)}`;
    try {
      const d   = ethers.hexlify(ethers.toUtf8Bytes(body));
      const gas = await this._estimateGasSafe({ to: token, value: '0', data: d }, (d.length - 2) / 2);
      const tx  = await this.signer.sendTransaction({ to: token, value: '0', data: d, gasLimit: gas });
      utils.toast('Publishing token profile… confirming on-chain');
      await tx.wait();
      if (this._verifiedTokenCache) delete this._verifiedTokenCache[token];
      await this._fetchVerifiedTokenProfile(token);
      if (this.state.channel === token) this.renderBanner(this.state.profCache[token] || {}, token);
      utils.toast('Token profile published ✓');
    } catch (err) {
      const msg = err.reason || err.message || 'Unknown error';
      const rejected = err.code === 4001 || err.code === 'ACTION_REJECTED' || /user (denied|rejected)/i.test(msg);
      utils.toast(rejected ? 'Cancelled' : 'Failed: ' + msg);
    }
  }

  /* Count NEW notifications (since LAST_CHECK_KEY) for the nav badge. Counts
     inbound follows/messages + engagement (likes/replies/reposts on my posts).
     Poll-vote/poll-ended notifs are NOT counted here — they need channel scans
     too heavy for a poller; they still show on the Notifications page.
     Accuracy: txlist is newest-first, so we page until we cross the lastCheck
     boundary (then everything older follows) — usually just 1 page, but it
     won't undercount a busy account the way a fixed page-1 scan did. */
  async checkNotifBadge() {
    if (!this.state.signerAddr) return;
    const me = this.state.signerAddr;
    const lastCheck = parseInt(utils.safeLS.get(LAST_CHECK_KEY, '0'), 10);
    try {
      let count = 0;
      const maxPages = Math.min(this._getMaxScanPages(), 5); /* bound the poll */
      for (let page = 1; page <= maxPages; page++) {
        let raw;
        try { raw = await this.apiFetch(me, page); } catch { break; }
        let reachedOld = false;
        for (const tx of raw) {
          if (Number(tx.timeStamp) * 1000 <= lastCheck) { reachedOld = true; continue; }
          if (tx.to?.toLowerCase() !== me) continue;
          if (tx.from?.toLowerCase() === me) continue;
          if (!tx.input || tx.input === '0x') continue;
          try {
            const text = ethers.toUtf8String(tx.input).trim();
            if (!text.length
              || text.startsWith(PROFILE_PREFIX) || text.startsWith(BOOKMARK_PREFIX)
              || text.startsWith(UNBOOKMARK_PREFIX) || text.startsWith(UNLIKE_PREFIX)
              || text.startsWith(UNFOLLOW_PREFIX)) continue;
            /* Inbound = follow (sent to target) or message; honor opt-outs. */
            if (this._notifEnabled(text.startsWith(FOLLOW_PREFIX) ? 'follow' : 'message')) count++;
          } catch { /* skip non-UTF8 */ }
        }
        /* Newest-first: once we hit txs older than lastCheck, or a short page,
           nothing newer remains further down. */
        if (reachedOld || raw.length < 50) break;
      }
      /* Likes/replies/reposts on my posts (from feed-scan accumulator).
         Disjoint from the inbound set (those are channel txs) — no double count. */
      try {
        const eng = await this._engagementNotifs();
        count += eng.filter(e => new Date(e.timestamp).getTime() > lastCheck && this._notifEnabled(e.type)).length;
      } catch { /* engagement is best-effort */ }
      this.setNotifBadge(count);
    } catch { /* silent */ }
  }

  setNotifBadge(n) {
    const b  = this.g('notif-badge');
    const mb = this.g('mn-dot');
    if (n > 0) {
      b.textContent = n > 99 ? '99+' : String(n);
      b.classList.add('on'); mb?.classList.add('on');
    } else {
      b.classList.remove('on'); mb?.classList.remove('on');
    }
    /* Mirror the count into the tab title (N) prefix and favicon dot so
       the user sees pending notifications even when the tab is in the
       background. */
    this._unreadCount = n;
    this._updateTitle();   /* recompose with current suffix + new count */
    this._updateFavicon();
  }
  clearNotifBadge() { this.setNotifBadge(0); }

  _registerWalletListeners() {
    if (this._walletReg) return;
    this._walletReg = true;
    const eth = this._getEthereum();
    if (!eth || typeof eth.on !== 'function') return;
    eth.on('accountsChanged', accounts => {
      if (accounts.length === 0) { this.disconnect(); return; }
      /* Ignore the accountsChanged that fires during our own connect(). */
      if (this._connecting) return;
      if (accounts[0].toLowerCase() !== this.state.signerAddr) {
        utils.toast('Account changed — reconnecting…');
        this.disconnect();
        setTimeout(() => this.connect(), 500);
      }
    });
    eth.on('chainChanged', chainId => {
      /* Ignore switches WE triggered (connect / _ensurePulseChain). Reacting to
         our own switch — plus hard-disconnecting on any non-369 chain — is what
         made the wallet connect then disconnect repeatedly on mobile. */
      if (this._switchingChain) return;
      /* The wallet's current chain does NOT gate the app: reads come from the
         explorer APIs (chain-independent) and writes switch to the right chain
         on demand via _ensureOnChain. So any chain is fine — just refresh the
         signer so it reflects the new network. (v6: getSigner is async; this
         handler is sync, so chain the promise.) */
      this._wrongChain = false;
      this._reflectChainState();
      new ethers.BrowserProvider(eth).getSigner()
        .then(s => { this.signer = s; })
        .catch(() => {});
    });
  }

  /* Safely get the current ethereum provider. Some browser extensions
     (evmAsk, Brave Wallet) conflict with MetaMask by trying to redefine
     window.ethereum after it's already been set as non-configurable.
     We cache a reference at first access and use that throughout. */
  _getEthereum() {
    if (!this._cachedEthereum) {
      try { this._cachedEthereum = window.ethereum; }
      catch { this._cachedEthereum = null; }
    }
    return this._cachedEthereum;
  }

  async tryAutoReconnect() {
    const eth = this._getEthereum();
    if (!eth) return;
    try {
      const prov = new ethers.BrowserProvider(eth);
      const accs = await prov.listAccounts();
      if (accs.length && utils.safeLS.get('sayitConnected') === '1') {
        /* Reconnect on whatever chain the wallet is on — the current chain
           doesn't gate anything (reads are chain-independent; writes switch to
           the right chain via _ensureOnChain), so there's no "wrong chain" to
           guard against here anymore. */
        this.signer = await prov.getSigner();
        this.state.signerAddr = (await this.signer.getAddress()).toLowerCase();
        // Set defaultChain from first wallet connection if not already set
        const s = this._getSettings();
        if (!s.defaultChain) {
          s.defaultChain = await this.signer.getChainId();
          this._saveSettings(s);
        }
        this._registerWalletListeners();
        await this.afterConnect();
      }
    } catch (err) { console.warn('Auto-reconnect failed', err); }
  }

  async toggleWallet() { this.signer ? this.disconnect() : await this.connect(); }

  /* Show the connected user's avatar on the mobile Profile nav button so the
     connected identity is visible in the bottom nav (the sidebar account pill
     is hidden on mobile). Reverts to the person icon on disconnect. */
  _updateMobileProfileAvatar() {
    const btn = document.querySelector('#mobile-nav [data-mn="profile"] .mn-icon');
    if (!btn) return;
    if (this.signer && this.state.signerAddr) {
      const pic = this.state.profile?.picUrl || 'image1.jpeg';
      btn.innerHTML = `<img src="${utils.safe(pic)}" alt="" class="mn-avatar" data-fallback-src="image1.jpeg">`;
    } else {
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M12 11c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm0-6C9.239 5 7 7.239 7 10s2.239 5 5 5 5-2.239 5-5-2.239-5-5-5zM5.651 19h12.698c-.337-1.8-1.023-2.891-1.929-3.4-1.285-.736-3.574-1.1-4.42-1.1-.845 0-3.135.364-4.42 1.1-.906.509-1.592 1.6-1.929 3.4z"/></svg>`;
    }
  }

  /* Read the wallet's current chain id via a live eth_chainId call. We avoid
     ethers' Web3Provider.getNetwork() here because it caches the network and
     reads stale right after a switch (a big source of the mobile flakiness). */
  async _readChainId(eth) {
    try { return parseInt(await eth.request({ method: 'eth_chainId' }), 16); }
    catch { return null; }
  }

  /* Poll eth_chainId until the wallet reports the wanted chain — switches are
     async on mobile and can take a moment. Returns the last value read (~2s).
     wantId defaults to PulseChain so existing callers are unchanged. */
  async _readChainWithRetry(eth, wantId = PULSE_CHAIN_ID, tries = 8) {
    let id = null;
    for (let i = 0; i < tries; i++) {
      id = await this._readChainId(eth);
      if (id === wantId) return id;
      await new Promise(r => setTimeout(r, 250));
    }
    return id;
  }

  /* Make sure the wallet is on a given chain before sending a transaction.
     Mobile wallets often sit on Ethereum; a tx on the wrong chain wastes gas
     and never shows up where expected. Switches (adding the chain if unknown)
     and refreshes the signer; returns false (with a toast) if it can't, so the
     caller aborts. Registry-driven — works for any supported chain. */
  async _ensureOnChain(chainId = CANONICAL_CHAIN_ID) {
    const cfg = chainCfg(chainId) || CHAINS[CANONICAL_CHAIN_ID];
    const eth = this._getEthereum();
    if (!eth) return true;
    let cur = await this._readChainId(eth);
    if (cur === cfg.id) return true;
    utils.toast(`Switching to ${cfg.name}…`);
    try { await this._ensureChainAdded(eth, cfg); } catch { /* handled below */ }
    cur = await this._readChainWithRetry(eth, cfg.id);
    if (cur === cfg.id) {
      this.signer = await new ethers.BrowserProvider(eth).getSigner();
      this._wrongChain = false;
      this._reflectChainState();
      return true;
    }
    utils.toast(`Please switch your wallet to ${cfg.name} (chain ${cfg.id}), then try again.`);
    return false;
  }

  /* Backward-compatible wrapper — every existing caller targets PulseChain. */
  async _ensureOnPulseForTx() { return this._ensureOnChain(CANONICAL_CHAIN_ID); }

  /* Show/hide the persistent wrong-network bar (only while connected). */
  _reflectChainState() {
    document.getElementById('wrong-chain-bar')?.classList.toggle('on', !!this._wrongChain && !!this.signer);
  }
  /* "Switch" button on the wrong-network bar. */
  async _switchToPulse() {
    await this._ensureOnChain(CANONICAL_CHAIN_ID);
    this._reflectChainState();
  }

  /* Switch the wallet to a chain. If the chain isn't known to the wallet
     (EIP-1193 error 4902), add it first with the registry's RPC params, then
     the wallet switches to it. _switchingChain guards the chainChanged
     listener so OUR switches don't trigger its handler. */
  async _ensureChainAdded(eth, cfg) {
    cfg = cfg || CHAINS[CANONICAL_CHAIN_ID];
    this._switchingChain = true;
    try {
      try {
        await eth.request({ method:'wallet_switchEthereumChain', params:[{ chainId: cfg.hex }] });
      } catch (err) {
        const code = err?.code ?? err?.data?.originalError?.code;
        if (code === 4902 || /unrecognized chain|add this network|wallet_addEthereumChain/i.test(err?.message || '')) {
          await eth.request({
            method:'wallet_addEthereumChain',
            params:[{
              chainId: cfg.hex,
              chainName: cfg.name,
              nativeCurrency: cfg.nativeCurrency,
              rpcUrls: cfg.rpcUrls,
              blockExplorerUrls: [cfg.explorer.web],
            }],
          });
          /* Adding a chain usually switches to it; make the switch explicit. */
          try { await eth.request({ method:'wallet_switchEthereumChain', params:[{ chainId: cfg.hex }] }); }
          catch {}
        } else {
          throw err;
        }
      }
    } finally {
      /* Keep the guard up briefly — the chainChanged event can arrive a moment
         after the request resolves; we don't want it treated as external. */
      setTimeout(() => { this._switchingChain = false; }, 1500);
    }
  }

  /* Backward-compatible wrapper used by connect(). */
  async _ensurePulseChain(eth) { return this._ensureChainAdded(eth, CHAINS[CANONICAL_CHAIN_ID]); }

  async connect() {
    const eth = this._getEthereum();
    if (!eth) {
      /* No injected provider. On mobile this almost always means the user is
         in a normal browser (Safari/Chrome) rather than a wallet's built-in
         dApp browser, where there's nothing to connect to. */
      const isMobile = window.innerWidth <= 768 ||
        /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      utils.toast(isMobile
        ? 'No wallet found. Open this site inside your wallet app\'s browser (e.g. Rabby, MetaMask) to connect.'
        : 'No wallet detected. Install a PulseChain-compatible wallet extension to connect.');
      return;
    }
    this._connecting = true;
    try {
      const prov = new ethers.BrowserProvider(eth);
      /* Request accounts FIRST. Mobile wallets (MetaMask/Rabby) often won't
         honor a network switch until the dApp is actually connected, and doing
         it first avoids the switch-then-connect ordering that made mobile
         flaky. */
      await prov.send('eth_requestAccounts', []);
      /* Connect on whatever chain the wallet is on — multichain users may want
         to be on Ethereum/Base, and the current chain doesn't gate anything
         (reads are chain-independent; writes switch to the right chain on
         demand via _ensureOnChain). No forced network switch. */
      const liveProv = new ethers.BrowserProvider(eth);
      this.signer = await liveProv.getSigner();
      this.state.signerAddr = (await this.signer.getAddress()).toLowerCase();
      this._wrongChain = false;
      this._reflectChainState();
      utils.safeLS.set('sayitConnected', '1');
      this._registerWalletListeners();
      await this.afterConnect();
      utils.toast('Wallet connected ✓');
    } catch (err) {
      const msg = err.message || String(err);
      /* User rejected the MetaMask popup. EIP-1193 code 4001 or
         'ACTION_REJECTED' / common message patterns. Show a friendly
         toast instead of dumping the raw error text. */
      const isRejection = err.code === 4001 ||
        err.code === 'ACTION_REJECTED' ||
        /user (denied|rejected)/i.test(msg) ||
        /rejected (the )?(transaction|request)/i.test(msg);
      if (isRejection) {
        utils.toast('Connection cancelled');
        return;
      }
      /* Extension conflict errors look like "Cannot redefine property" —
         they come from third-party extensions, not from our code. */
      if (msg.includes('redefine') || msg.includes('defineProperty')) {
        utils.toast('Wallet extension conflict detected. Try disabling other wallet extensions and reload.');
      } else {
        utils.toast('Connect failed: ' + msg);
      }
    } finally {
      this._connecting = false;
    }
  }

  async afterConnect() {
    const addr = this.state.signerAddr;
    document.body.classList.add('wallet-connected');
    this.g('account-pill').style.display = 'flex';
    this._updateMobileProfileAvatar();
    this.g('connect-btn').style.display  = 'none';
    this.g('ap-addr').textContent        = this.trunc(addr);
    this.g('ch-self').style.display      = 'block';
    this._syncNavLinks();
    /* Retry any posts that failed while offline */
    setTimeout(() => this._retryPendingPosts(), 2000);
    const cached = await this.cache.getProfile(addr);
    if (cached) this.applyProfile(cached);
    /* Load profile + reactions in parallel */
    await Promise.all([
      this.fetchMyProfile(),
      this.fetchMyReactions(),
    ]);
    this.checkNotifBadge();
    /* Background: rebuild channel history if not scanned recently */
    const lastScan = parseInt(utils.safeLS.get(CHANNELS_KEY, '0'), 10);
    if (Date.now() - lastScan > 86_400_000) {
      setTimeout(() => this.rebuildChannelHistory(), 3000);
    }
    /* Only re-render feed if we're actually on a feed view */
    const feedModes = ['main', 'self', 'custom'];
    if (feedModes.includes(this.state.mode)) this.renderFeed();
    /* Refresh the sidebar panels (Who to follow, trending, polls) now that
       we know who the user follows — otherwise Who-to-follow stays empty
       until the next render (which is why it needed a reload before). */
    this._refreshSidebarPanels();
    /* Auto-restore lists/communities from chain if we have none locally —
       silent (no toasts), best-effort, so a returning user on a new device
       gets their lists back without manually clicking Restore. */
    if (this.state.lists.length === 0 && this.state.communities.length === 0) {
      setTimeout(() => this._autoRestoreLists(), 4000);
    }
  }

  /* Load likes, bookmarks, follows from chain */
  async fetchMyReactions() {
    if (!this.state.signerAddr) return;
    this.state.likes.clear();
    this.state.bookmarks.clear();
    this.state.following.clear();
    /* Last-write-wins resolution. API returns newest-first; we mark the
       first action seen per target as authoritative and skip older actions
       for the same target. This makes UNLIKE/UNBOOKMARK/UNFOLLOW work
       correctly — the most recent decision wins.

       Previously: UNFOLLOW followed by an older FOLLOW (newest-first iteration)
       would re-add to following. That was a pre-existing bug. */
    const seenLike     = new Set();
    const seenBookmark = new Set();
    const seenFollow   = new Set();
    try {
      /* Cap at 40 pages (2000 txs) — covers heavy reactors generously */
      const rxLimit = Math.min(this._getMaxScanPages(), 40);
      for (let page = 1; page <= rxLimit; page++) {
        let raw;
        try { raw = await this.apiFetch(this.state.signerAddr, page); }
        catch { break; }
        raw.forEach(tx => {
          const from = tx.from?.toLowerCase();
          const to   = tx.to?.toLowerCase();
          if (from !== this.state.signerAddr) return; /* only my sent txs */
          if (!tx.input || tx.input === '0x') return;
          try {
            const text = ethers.toUtf8String(tx.input).trim();
            /* UNLIKE check before LIKE (defensive ordering — neither
               startsWith would clash but readability matters). */
            if (text.startsWith(UNLIKE_PREFIX)) {
              const h = utils.refHash(text.slice(UNLIKE_PREFIX.length));
              if (!seenLike.has(h)) seenLike.add(h);
            } else if (text.startsWith(LIKE_PREFIX)) {
              const h = utils.refHash(text.slice(LIKE_PREFIX.length));
              if (!seenLike.has(h)) { seenLike.add(h); this.state.likes.add(h); }
            } else if (text.startsWith(UNBOOKMARK_PREFIX) && to === from) {
              const h = text.slice(UNBOOKMARK_PREFIX.length).trim().toLowerCase();
              if (!seenBookmark.has(h)) seenBookmark.add(h);
            } else if (text.startsWith(BOOKMARK_PREFIX) && to === from) {
              const h = text.slice(BOOKMARK_PREFIX.length).trim().toLowerCase();
              if (!seenBookmark.has(h)) { seenBookmark.add(h); this.state.bookmarks.add(h); }
            } else if (text.startsWith(UNFOLLOW_PREFIX)) {
              const a = text.slice(UNFOLLOW_PREFIX.length).trim().toLowerCase();
              if (!seenFollow.has(a)) seenFollow.add(a);
            } else if (text.startsWith(FOLLOW_PREFIX)) {
              const a = text.slice(FOLLOW_PREFIX.length).trim().toLowerCase();
              if (!seenFollow.has(a)) { seenFollow.add(a); this.state.following.add(a); }
            }
          } catch { /* skip */ }
        });
        if (raw.length < 50) break;
      }
    } catch (err) { console.warn('Reactions fetch error', err); }
  }

  disconnect() {
    this.signer = null;
    this.state.signerAddr = null;
    this._wrongChain = false;
    this._reflectChainState();
    this.state.profile    = { username:'', picUrl:'image1.jpeg', bio:'' };
    document.body.classList.remove('wallet-connected');
    this._updateMobileProfileAvatar();
    this.g('account-pill').style.display = 'none';
    this.g('connect-btn').style.display  = 'block';
    this.g('compose-avatar').src         = 'image1.jpeg';
    this.g('ch-self').style.display      = 'none';
    this.g('ap-avatar').src          = 'image1.jpeg';
    this.g('ap-name').textContent    = 'My Wallet';
    this.g('ap-addr').textContent    = '';
    this.clearNotifBadge();
    utils.safeLS.remove('sayitConnected');
    this.renderFeed();
    utils.toast('Wallet disconnected');
  }

  async fetchMyProfile() {
    if (!this.state.signerAddr) return;
    /* Scan every page of this wallet's tx history until we either find the
       PROFILE_DATA self-send or exhaust all pages. Profile-save txs are
       self-sends (from === to === signerAddr) so they only appear once in
       history; on an active wallet it could be many pages deep. */
    try {
      /* Hard cap as defense-in-depth against an API that returns stale
         pages forever. 2000 pages = 100k txs — covers anyone realistic. */
      const MAX_PROFILE_SCAN = 2000;
      for (let page = 1; page <= MAX_PROFILE_SCAN; page++) {
        let raw;
        try { raw = await this.apiFetch(this.state.signerAddr, page); }
        catch (err) { console.warn('fetchMyProfile API error (p' + page + '):', err); break; }
        if (!raw || !raw.length) break; /* end of tx history */
        for (const tx of raw) {
          if (tx.from?.toLowerCase() !== this.state.signerAddr) continue;
          if (tx.to?.toLowerCase()   !== this.state.signerAddr) continue;
          try {
            const text = ethers.toUtf8String(tx.input).trim();
            if (!text.startsWith(PROFILE_PREFIX)) continue;
            const data = JSON.parse(text.slice(PROFILE_PREFIX.length).trim());
            this.applyProfile(data);
            await this.cache.saveProfile({ address: this.state.signerAddr, ...data });
            /* Profile found — update the open profile page header in-place
               without a full re-render (preserves the already-loaded feed). */
            if (this.state.mode === 'profile' &&
                this.state.channel === this.state.signerAddr) {
              const nameEl   = document.getElementById('prof-display-name');
              const avatarEl = document.getElementById('prof-page-avatar');
              if (nameEl)   nameEl.textContent = data.username || this.trunc(this.state.signerAddr);
              if (avatarEl) avatarEl.src = data.picUrl || 'image1.jpeg';
              const bioEl = document.querySelector('.prof-bio');
              if (bioEl && data.bio) bioEl.textContent = data.bio;
              const coverEl = document.querySelector('.prof-cover');
              if (coverEl && data.coverUrl) {
                const safeCover = utils.cssUrlValue(data.coverUrl);
                if (safeCover) coverEl.style.background = `url('${safeCover}') center/cover no-repeat`;
              }
            }
            /* Update My Channel page-header title if user is on that page */
            if (this.state.mode === 'self' && data.username) {
              const hdrTitle = this.g('feed')?.querySelector('.page-header-title');
              if (hdrTitle && (hdrTitle.textContent === 'My Chat' || hdrTitle.textContent === 'My Channel' || !hdrTitle.textContent)) {
                hdrTitle.textContent = data.username;
              }
            }
            return; /* found — stop */
          } catch { continue; }
        }
        if (raw.length < 50) break; /* last page — stop regardless */
      }
    } catch (err) { console.warn('fetchMyProfile error:', err); }
  }

  async fetchOtherProfile(address) {
    if (!address) return;
    /* Skip if in profCache, unless it's a stale empty record (>24h old) */
    if (address in this.state.profCache) {
      const cached = this.state.profCache[address];
      if (cached === null) return; /* fetch already in progress */
      if (cached?.username) {
        /* Found profile — re-fetch after 1 hour so profile updates propagate */
        const ONE_HOUR = 3_600_000;
        if (!cached._cachedAt || (Date.now() - cached._cachedAt) < ONE_HOUR) return;
        /* Stale found profile — fall through and re-fetch */
        delete this.state.profCache[address];
      } else {
        /* Empty placeholder: re-scan after 24h */
        const TWENTY_FOUR_H = 86_400_000;
        if (cached?._emptyAt && (Date.now() - cached._emptyAt) < TWENTY_FOUR_H) return;
        /* Stale empty — fall through and re-scan */
        delete this.state.profCache[address];
      }
    }
    /* Mark in-progress immediately — prevents duplicate concurrent fetches. */
    this.state.profCache[address] = null;
    const work = async () => {
      this._profInFlight++;
      try {
        /* 1. Try IndexedDB cache first — fast, no API call needed. */
        const db = await this.cache.getProfile(address);
        if (db) {
          /* Store ALL available fields — popup and profile page need bio,
             coverUrl, location, website — not just username + picUrl. */
          this.state.profCache[address] = {
            username: db.username  || '',
            picUrl:   db.picUrl    || 'image1.jpeg',
            bio:      db.bio       || '',
            coverUrl: db.coverUrl  || '',
            location: db.location  || '',
            website:  db.website   || '',
          };
          this._pruneProfileCache();
          this._debouncedRender();
          return;
        }
        /* 2. Scan the FULL tx history of this address until we find
              a PROFILE_DATA self-send or run out of pages.
              - profInFlight cap (3 concurrent) prevents API flooding.
              - _debouncedRender() fires immediately on find, so the UI
                updates progressively — user sees names/avatars appear
                as each profile is located rather than waiting for all.
              - Cached permanently in IndexedDB so subsequent sessions
                are instant regardless of how deep the scan went. */
        /* Hard cap as defense-in-depth. 2000 pages = 100k txs.
           Real history will exit via the empty-page break long before this. */
        const MAX_PROFILE_SCAN = 2000;
        for (let page = 1; page <= MAX_PROFILE_SCAN; page++) {
          let raw;
          try { raw = await this.apiFetch(address, page); }
          catch (err) {
            console.warn(`fetchOtherProfile(${this.trunc(address)}) API err p${page}:`, err);
            break;
          }
          if (!raw || !raw.length) break; /* end of tx history */
          let found = false;
          for (const tx of raw) {
            if (tx.from?.toLowerCase() !== address ||
                tx.to?.toLowerCase()   !== address) continue;
            try {
              const text = ethers.toUtf8String(tx.input).trim();
              if (!text.startsWith(PROFILE_PREFIX)) continue;
              const data = JSON.parse(text.slice(PROFILE_PREFIX.length).trim());
              this.state.profCache[address] = {
                username: data.username || '',
                picUrl:   data.picUrl   || 'image1.jpeg',
                bio:      data.bio      || '',
                coverUrl: data.coverUrl || '',
                location: data.location || '',
                website:  data.website  || '',
                _cachedAt: Date.now(),   /* TTL: re-fetch after 1h */
              };
              await this.cache.saveProfile({ address, ...data });
              this._pruneProfileCache();
              this._debouncedRender();
              found = true;
              break;
            } catch { continue; }
          }
          if (found) return;
          if (raw.length < 50) break; /* last page — stop */
        }
        /* No profile found — store empty placeholder with timestamp so we can
           re-scan after 24h (user may publish a profile in the future). */
        this.state.profCache[address] = { username:'', picUrl:'image1.jpeg',
                                          bio:'', coverUrl:'', location:'', website:'',
                                          _emptyAt: Date.now() };
      } catch {
        this.state.profCache[address] = { username:'', picUrl:'image1.jpeg',
                                          bio:'', coverUrl:'', location:'', website:'',
                                          _emptyAt: Date.now() };
      } finally {
        this._profInFlight--;
        this._drainProfileQueue();
      }
    };
    if (this._profInFlight < 3) work();
    else this._profQueue.push(work);
  }

  _drainProfileQueue() {
    /* Wrap synchronous invocation: if work() throws before its inner async
       runs (e.g. cache reference goes null mid-shutdown), we still keep
       draining the queue instead of deadlocking _profInFlight. */
    while (this._profInFlight < 3 && this._profQueue.length > 0) {
      const work = this._profQueue.shift();
      try { work(); } catch (err) { console.warn('Profile drain error:', err); }
    }
  }

  applyProfile(data) {
    /* Sanitize URL fields at write time — chain data may contain
       javascript:/data:/etc URIs that we never want to render anywhere.
       safeUrl returns '' for blocked schemes so the field falls back to default. */
    const cleanPic   = utils.safeUrl(data.picUrl || data.profilePicUrl) || 'image1.jpeg';
    const cleanCover = utils.safeUrl(data.coverUrl);
    const cleanSite  = utils.safeUrl(data.website);
    this.state.profile = {
      username:  data.username  || '',
      picUrl:    cleanPic,
      bio:       data.bio       || '',
      coverUrl:  cleanCover,
      location:  data.location  || '',
      website:   cleanSite,
      joinedTs:  data.joinedTs  || null,
    };
    this.g('compose-avatar').src       = this.state.profile.picUrl;
    this.g('modal-compose-avatar').src = this.state.profile.picUrl;
    this.g('ap-avatar').src       = this.state.profile.picUrl || 'image1.jpeg';
    this.g('ap-name').textContent = this.state.profile.username || this.trunc(this.state.signerAddr || '');
    /* Keep the mobile Profile nav avatar in sync once the real pic loads. */
    this._updateMobileProfileAvatar();
  }

  /* ── Profile page (full in-column view) ──────────────────────────────── */
  /* Premium — placeholder for now. A future subscription will unlock Articles
     (long-form on-chain posts), unlimited post length, profile Highlights, etc. */
  goPremium() {
    this._updateTitle('Premium');
    this._setRoute('/premium');
    this.setNav('nav-premium', null);
    this.state.mode = 'premium';
    this.g('compose-area').style.display   = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('feed-tabs').style.display      = 'none';
    this.g('loading-more').style.display   = 'none';
    this._pendingPageHeader = this._makePageHeader({ title: 'Premium', noBack: true });
    const headerHTML = this._applyPageHeader();
    const rows = [
      ['📝', 'Articles',
        'Publish long-form essays, guides, even whole books — settled on-chain and readable forever.'],
      ['♾️', 'Unlimited post length',
        'Drop the character cap. Say everything you need to in a single on-chain post.'],
      ['🌟', 'Profile Highlights',
        'Pin your best posts to a dedicated Highlights tab so newcomers see your finest first.'],
      ['🖼️', 'Larger media uploads',
        'Share higher-resolution images and longer clips with room-to-breathe limits.'],
      ['✦', 'Verified-style profile perks',
        'A distinct premium mark and profile flourishes that travel with your wallet, not a server.'],
    ];
    const rowsHTML = rows.map(([icon, title, desc]) => `
        <div class="premium-feature">
          <span class="pf-icon" aria-hidden="true">${icon}</span>
          <div class="pf-body">
            <div class="pf-title">${utils.safe(title)}</div>
            <div class="pf-desc">${utils.safe(desc)}</div>
          </div>
        </div>`).join('');
    this.g('feed').innerHTML = headerHTML + `
      <div class="premium-page">
        <div class="pp-hero">
          <div class="pp-mark" aria-hidden="true">✦</div>
          <h2 class="pp-title">Say It Premium</h2>
          <p class="pp-intro">A future subscription that unlocks long-form writing and richer ways to
          express yourself — all settled on the same public chain as everything else here.</p>
        </div>
        <div class="pp-features">${rowsHTML}</div>
        <p class="pp-soon">Coming soon — Premium is not yet available.</p>
        <button class="pp-subscribe" id="premium-subscribe-btn" disabled>Subscribe (coming soon)</button>
      </div>`;
  }

  async fetchNFTImage() {
    const contractAddr = this.g('nft-contract').value.trim().toLowerCase();
    const tokenIdRaw   = this.g('nft-token-id').value.trim();
    const status       = this.g('nft-status');
    if (!ethers.isAddress(contractAddr)) { status.textContent = '✗ Invalid contract'; return; }
    if (!tokenIdRaw || isNaN(tokenIdRaw))       { status.textContent = '✗ Invalid token ID'; return; }
    if (!this.signer)                            { status.textContent = '✗ Connect wallet first'; return; }
    status.innerHTML = '<span class="spinner sp-sm" aria-hidden="true"></span>Fetching…';
    try {
      const contract = new ethers.Contract(contractAddr, ERC721_ABI, this.signer.provider);
      let owner;
      try { owner = (await contract.ownerOf(tokenIdRaw)).toLowerCase(); }
      catch { status.textContent = '✗ Token not found'; return; }
      if (owner !== this.state.signerAddr) { status.textContent = "✗ You don't own this token"; return; }
      let tokenUri;
      try { tokenUri = await contract.tokenURI(tokenIdRaw); }
      catch { status.textContent = '✗ tokenURI() failed'; return; }
      let imageUrl = null;
      if (tokenUri.startsWith('data:application/json;base64,')) {
        try {
          const meta = JSON.parse(atob(tokenUri.slice('data:application/json;base64,'.length)));
          imageUrl = utils.safeUrl(utils.resolveIPFS(meta.image)) || null;
        } catch { status.textContent = '✗ Could not parse metadata'; return; }
      } else {
        try {
          const res  = await fetch(utils.resolveIPFS(tokenUri));
          const meta = await res.json();
          imageUrl = utils.safeUrl(utils.resolveIPFS(meta.image)) || null;
        } catch { status.textContent = '✗ Could not fetch metadata'; return; }
      }
      if (!imageUrl) { status.textContent = '✗ No image found'; return; }
      this.g('pe-pic').value   = imageUrl;
      this.g('pe-preview').src = imageUrl;
      status.textContent = '✓ NFT image loaded!';
    } catch (err) { status.textContent = '✗ ' + (err.message || err); }
  }

  async apiFetch(address, page, chainId = CANONICAL_CHAIN_ID) {
    const s   = this._getSettings();
    const cfg = chainCfg(chainId) || CHAINS[CANONICAL_CHAIN_ID];
    /* The canonical chain honors user-configured endpoints (apiUrl + optional
       backupApiUrl); every other chain uses the registry endpoint plus the
       shared Etherscan-v2 key. The query string is built by the explorer
       adapter, so a Blockscout (PulseChain) request stays byte-for-byte the
       legacy one — this is a behavior-preserving refactor for chain 369. */
    const isCanon     = cfg.id === CANONICAL_CHAIN_ID;
    const apiKey      = s.etherscanKey || '';
    const primaryBase = isCanon ? (s.apiUrl || cfg.explorer.api) : cfg.explorer.api;
    const backupBase  = isCanon ? (s.backupApiUrl || '')         : '';
    const primary = explorerTxlistUrl(cfg, address, page, { apiBase: primaryBase, apiKey });
    const backup  = backupBase ? explorerTxlistUrl(cfg, address, page, { apiBase: backupBase, apiKey }) : '';

    /* fetchWithRetry: up to 3 attempts with exponential backoff (1s, 2s).
       Retries on network errors, timeouts, 429 (rate limit), and 5xx.
       Stops immediately on other 4xx (client errors a retry won't fix). */
    const fetchWithRetry = async url => {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          const delay = Math.pow(2, attempt - 1) * 1000; /* 1s, 2s */
          await new Promise(res => setTimeout(res, delay));
        }
        /* 15s timeout per attempt prevents a hung explorer from indefinitely
           holding state.loading=true and breaking the rest of the UI. */
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        let res;
        try {
          /* url is the complete request (endpoint + adapter query string). */
          res = await fetch(url, { signal: ctrl.signal });
        } catch (err) {
          /* Network error or timeout (AbortError) — retry. */
          lastErr = err;
          continue;
        } finally {
          clearTimeout(timer);
        }
        if (res.ok) {
          try {
            const data = await res.json();
            /* Ingestion gate: drop malformed txs so no explorer-supplied
               value can reach a render path unvalidated. */
            return (data.status === '1' && Array.isArray(data.result)) ? utils.sanitizeTxs(data.result) : [];
          } catch (err) {
            lastErr = err; /* malformed JSON — retry */
            continue;
          }
        }
        lastErr = new Error(`API ${res.status}`);
        /* Don't retry 4xx (except 429) — they won't improve with a retry. */
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
        /* 429 / 5xx → loop retries after backoff. */
      }
      throw lastErr;
    };

    try {
      return await fetchWithRetry(primary);
    } catch (err) {
      if (backup) {
        try { return await fetchWithRetry(backup); }
        catch { /* fall through */ }
      }
      throw err;
    }
  }

  /* Resolve an address's FIRST on-chain activity (X's "Joined" parity).
     One Etherscan-style txlist call sorted ascending, offset=1 — the single
     oldest tx. Reuses apiFetch's endpoint plumbing + the same ingestion gate
     (explorer data is untrusted). Returns ms timestamp, or null on failure /
     no history. Cached in-memory on profCache[addr].firstSeen. */
  async _fetchFirstSeen(address) {
    const lc = (address || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(lc)) return null;
    const cached = this.state.profCache[lc]?.firstSeen;
    if (cached !== undefined) return cached; /* null cached too — don't refetch */
    const s       = this._getSettings();
    const primary = s.apiUrl      || 'https://api.scan.pulsechain.com/api';
    /* Blockscout can't serve sort=asc txlist on busy addresses — verified
       live: the query hangs server-side, then errors. Instead: (1) the tx
       COUNT from the v2 counters endpoint, (2) the LAST page of the normal
       desc listing — its final row is the first-ever tx. Two bounded calls;
       very large accounts (>20k txs → deep pagination gets slow) are
       skipped and simply show no line. */
    const v2base = primary.replace(/\/api\/?$/, '/api/v2');
    let ms = null;
    /* Only persist a null result when the explorer answered AUTHORITATIVELY
       (count===0, count too large to scan, or the last page came back with no
       usable rows). On a fetch FAILURE (network error / non-ok status / abort)
       we leave the cache untouched so the next profile visit retries instead
       of blanking the "On-chain since" line for the rest of the session. */
    let authoritative = false;
    try {
      const ctl1 = new AbortController();
      const t1 = setTimeout(() => ctl1.abort(), 10000);
      let count;
      try {
        const r = await fetch(`${v2base}/addresses/${lc}/counters`, { signal: ctl1.signal });
        if (!r.ok) throw new Error('counters ' + r.status);
        count = Number((await r.json())?.transactions_count);
      } finally { clearTimeout(t1); }
      if (Number.isFinite(count) && (count === 0 || count > 20000)) {
        /* Explorer answered: no txs, or too many to scan — null is correct. */
        authoritative = true;
      } else if (Number.isFinite(count) && count > 0 && count <= 20000) {
        const lastPage = Math.max(1, Math.ceil(count / 50));
        const ctl2 = new AbortController();
        const t2 = setTimeout(() => ctl2.abort(), 15000);
        try {
          const r = await fetch(
            `${primary}?module=account&action=txlist&address=${lc}&offset=50&page=${lastPage}&sort=desc`,
            { signal: ctl2.signal });
          if (!r.ok) throw new Error('txlist ' + r.status);
          const data = await r.json();
          /* The last page answered — whatever it contains is authoritative. */
          authoritative = true;
          /* Same ingestion gate apiFetch applies — status '1' + sanitized rows. */
          if (data.status === '1' && Array.isArray(data.result) && data.result.length) {
            const rows = utils.sanitizeTxs(data.result);
            const tsSec = Number(rows[rows.length - 1]?.timeStamp);
            if (Number.isFinite(tsSec) && tsSec > 0) ms = tsSec * 1000;
          }
        } finally { clearTimeout(t2); }
      }
    } catch {
      /* explorer hiccup / network failure — DON'T cache, leave undefined so
         the next visit retries. No error UI. */
      return undefined;
    }
    if (!authoritative) return undefined; /* nothing definitive — allow retry */
    /* Cache on the in-memory profile record (create a stub if absent). */
    (this.state.profCache[lc] ||= {}).firstSeen = ms;
    return ms;
  }

  /* Resolve + render the profile's "On-chain since <Month Year>" line.
     Guards against the user navigating away mid-fetch. Leaves the span empty
     (no error UI) if the explorer can't answer. Inline SVG calendar (own
     asset) instead of an emoji — the owner's system lacks a color-emoji
     font, so emoji icons render as broken boxes there. */
  async _fillFirstSeen(address) {
    const lc = (address || '').toLowerCase();
    let ms;
    try { ms = await this._fetchFirstSeen(lc); } catch { ms = null; }
    if (ms == null) return;
    /* Stale-guard: still on this same profile page? */
    if (this.state.mode !== 'profile' || this.state.channel?.toLowerCase() !== lc) return;
    const el = document.getElementById('prof-firstseen');
    if (!el) return;
    const when = new Date(ms).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    el.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
        style="vertical-align:-2px;margin-right:3px"><path fill="currentColor"
        d="M7 2v2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7zm-2 7h14v10H5V9z"/></svg>On-chain since ${utils.safe(when)}`;
    el.style.display = '';
  }

  /* Fetch only an address's SENT transactions via the Blockscout v2 API
     (filter=from), newest first. The etherscan-compat txlist mixes sent and
     received txs, and a popular account's received engagement (every like/
     follow/reply lands as a tx TO them) buries their own posts beyond any
     reasonable page window — the root cause of Following feeds and profiles
     showing only some accounts. One filtered request covers an account's
     last 50 posts regardless of how much engagement they receive.
     Returns a sanitized etherscan-shaped array, or null when the configured
     endpoint doesn't speak v2 (caller falls back to the compat txlist). */
  async _apiFetchSentTxs(addr) {
    if (!/^0x[0-9a-f]{40}$/i.test(addr || '')) return null;
    const s = this._getSettings();
    const base = (s.apiUrl || 'https://api.scan.pulsechain.com/api').replace(/\/api\/?$/, '');
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let res;
      try {
        res = await fetch(`${base}/api/v2/addresses/${addr}/transactions?filter=from`,
          { signal: ctrl.signal });
      } finally { clearTimeout(timer); }
      if (!res.ok) return null;
      const d = await res.json();
      if (!Array.isArray(d?.items)) return null;
      /* Map the v2 shape onto the etherscan-compat shape every parser
         expects, then through the standard ingestion gate. */
      return utils.sanitizeTxs(d.items.map(it => ({
        hash:  it.hash,
        from:  it.from?.hash,
        to:    it.to?.hash ?? null,
        input: it.raw_input,
        timeStamp: it.timestamp
          ? String(Math.floor(new Date(it.timestamp).getTime() / 1000)) : undefined,
        blockNumber: it.block_number ?? it.block ?? undefined,
        transactionIndex: it.position ?? undefined,
      })));
    } catch { return null; }
  }

  queryAddr() {
    const { mode, signerAddr, channel } = this.state;
    return (mode === 'notifications' || mode === 'self')
      ? signerAddr : channel;
  }

  async fetchOnePage(page) {
    const addr = this.queryAddr();
    if (!addr) return [];
    return this.apiFetch(addr, page);
  }

  /* The chains the current feed should read. Only the Home feed (main channel)
     aggregates across the user's enabled chains; every other surface (profiles,
     token channels, notifications, threads) stays single-chain on the canonical
     chain. Returns [369] by default, so with no extra chains enabled this is a
     no-op and the single-chain path below is used unchanged. */
  _activeFeedChains() {
    if (this.state.mode === 'main'
        && (this.state.channel || '').toLowerCase() === MAIN_CHANNEL.toLowerCase()) {
      let enabled = this._getSettings().enabledChains;
      if (!Array.isArray(enabled) || enabled.length === 0) {
        /* No explicit choice → aggregate the registry's enabled chains
           (canonical + any keyless-readable chain). enabled:false chains like
           BSC stay out, so a broken/keyed explorer never fires on first load. */
        enabled = chainList({ enabledOnly: true }).map(c => c.id).filter(id => id !== CANONICAL_CHAIN_ID);
      } else {
        /* Explicit user selection is honored as-is — including an opt-in
           keyed chain like BSC the user enabled in Settings. */
        enabled = enabled.map(Number).filter(id => id !== CANONICAL_CHAIN_ID && chainCfg(id));
      }
      if (enabled.length) return [CANONICAL_CHAIN_ID, ...enabled];
    }
    return [CANONICAL_CHAIN_ID];
  }

  /* Aggregated fetch: pull the next page from every active chain in parallel,
     parse each with its own chainId, and return the merged posts. Per-chain
     page cursors + end-of-history live in state.chainPages / chainHasMore so
     each chain paginates independently; state.hasMore stays true while ANY
     chain has more. A chain that errors is dropped for this pass (others still
     render) — one slow/broken explorer never blocks the rest of the feed. */
  async _fetchNextAcrossChains(chains, myToken) {
    this.state.chainPages   = this.state.chainPages   || {};
    this.state.chainHasMore = this.state.chainHasMore || {};
    const addr = this.queryAddr();
    const batches = await Promise.all(chains.map(async cid => {
      if (this.state.chainHasMore[cid] === false) return [];
      const page = this.state.chainPages[cid] || 1;
      let raw;
      try { raw = await this.apiFetch(addr, page, cid); }
      catch { this.state.chainHasMore[cid] = false; return []; }
      this.state.chainPages[cid] = page + 1;
      if (raw.length < 50) this.state.chainHasMore[cid] = false;
      return this.parseTxs(raw, cid);
    }));
    if (myToken !== this._fetchToken) return [];
    this.state.hasMore = chains.some(cid => this.state.chainHasMore[cid] !== false);
    return batches.flat();
  }

  async fetchPosts(reset = false) {
    if (this.state.loading) return;
    this.state.loading = true;
    /* Capture token at entry. If a channel switch / refresh bumps it during
       our await, we abort writes to prevent cross-channel post leakage. */
    const myToken = this._fetchToken;
    if (reset) {
      this.state.nextPage = 1; this.state.hasMore = true;
      this.state.chainPages = {}; this.state.chainHasMore = {};
    }
    const loadingEl = this.g('loading-more');
    loadingEl.style.display = 'block';
    /* Spinner div contributes no text, so the textContent comparison in the
       finally block below still matches exactly. */
    loadingEl.innerHTML = '<div class="spinner sp-feed" aria-hidden="true"></div>Scanning the chain…';

    let found = 0, pages = 0;
    try {
      while (found < POSTS_TARGET && this.state.hasMore && pages < MAX_PAGES) {
        const _chains = this._activeFeedChains();
        let parsed;
        if (_chains.length > 1) {
          /* Aggregated Home feed across the user's enabled chains. */
          try { parsed = await this._fetchNextAcrossChains(_chains, myToken); }
          catch (err) {
            if (myToken === this._fetchToken) utils.toast('Fetch error — ' + err.message);
            break;
          }
          if (myToken !== this._fetchToken) return;
          pages++;
        } else {
          let raw;
          try { raw = await this.fetchOnePage(this.state.nextPage); }
          catch (err) {
            /* Don't toast on aborted fetches — they're intentional. */
            if (myToken === this._fetchToken) utils.toast('Fetch error — ' + err.message);
            break;
          }
          /* Stale fetch — channel changed mid-flight. Abandon silently. */
          if (myToken !== this._fetchToken) return;
          this.state.nextPage++;
          pages++;
          /* End-of-history is "API returned fewer than the page size" — robust
             against a single 49-result page that the old equality check would
             misread as "definitive end". */
          if (raw.length < 50) this.state.hasMore = false;
          parsed = this.parseTxs(raw);
        }
        if (parsed.length > 0) {
          /* Dedup within this batch AND against already-loaded posts */
          const unique = parsed.filter(p => !this._postHashSet.has(p.txHash));
          if (unique.length > 0) {
            unique.forEach(p => this._postHashSet.add(p.txHash));
            this.state.posts = [...this.state.posts, ...unique]
              .sort((a, b) => (b._tsMs ??= new Date(b.timestamp).getTime()) - (a._tsMs ??= new Date(a.timestamp).getTime()))
              .slice(0, this._getPostCap()); /* cap — configurable in Settings */
            await this.cache.savePosts(unique);
            if (myToken !== this._fetchToken) return;
            found += unique.length;
            this.renderFeed();
            this._refreshSidebarPanels();
          }
        }
        if (this.state.mode === 'notifications') break;
      }
      /* MAX_PAGES cap with more history likely available: surface a manual
         "Load more" button so the user can keep going on dense channels
         instead of silently stalling. */
      if (pages >= MAX_PAGES && this.state.hasMore && myToken === this._fetchToken) {
        loadingEl.innerHTML =
          `<button class="settings-btn" style="margin:8px auto;display:block" ` +
          `data-act="load-more">Load more from chain</button>`;
        loadingEl.style.display = 'block';
        return;
      }
      if (this.state.posts.length === 0 && myToken === this._fetchToken) this.renderFeed();
    } finally {
      if (myToken === this._fetchToken) this.state.loading = false;
      /* Only hide the loader if we left it as text — don't clobber the
         "Load more" button we may have installed. */
      if (loadingEl.textContent === 'Scanning the chain…') loadingEl.style.display = 'none';
      /* A deep scan can capture many VOTE txs in one go — bound the poll maps
         here too (no-op when under the cap). */
      this._prunePollMaps();
    }
  }

  /* ── Canonical single-tx parser ──────────────────────────────────────
     Returns a normalized post object for one tx, or null if the tx should
     not appear in a feed (profile updates, reactions, votes, empty posts).
     This is the SINGLE SOURCE OF TRUTH for poll/vote/repost/reply parsing —
     secondary feed paths should call this instead of re-implementing the
     logic (which historically drifted and leaked raw data). opts lets each
     caller set mode and any extra fields. */
  _parsePostTx(tx, opts = {}) {
    const hash = tx.hash?.toLowerCase();
    if (!hash) return null;
    if (!tx.input || tx.input === '0x') return null;
    /* Callers that already decoded the payload (parseTxs) pass it via
       opts._text to avoid a second UTF-8 decode per tx. */
    let text = opts._text;
    if (text === undefined) {
      try { text = ethers.toUtf8String(tx.input).trim(); }
      catch { return null; }
    }
    if (!text) return null;
    /* Non-post payloads that never render as feed items. */
    if (text.startsWith(PROFILE_PREFIX)) return null;
    /* Encrypted DMs + published DM key bundles — never render as posts; they're
       handled by the Messages surface (DMCrypto) and the inbound DM scan. */
    if (text.startsWith(DM_PREFIX) || text.startsWith(DMKEY_PREFIX)) return null;
    if (text.startsWith(VOTE_PREFIX)) { this._captureVote(text, tx); return null; }
    if (text.startsWith(TOKEN_PROFILE_PREFIX)) return null; /* token-profile metadata, not a feed post */
    if (text.startsWith(TIP_PREFIX)) return null; /* tips surface via notifications, never as posts */
    /* A host ending their Space — recorded, never rendered. */
    if (text.startsWith(SPACE_END_PREFIX)) { this._captureSpaceEnd(text, tx); return null; }
    /* SPACE announcements are feed posts with a live-room card. */
    if (text.startsWith(SPACE_PREFIX)) {
      const space = this._parseSpacePayload(text);
      if (space) {
        return {
          content: text, display: space.title, parentTx: null, repostOf: null,
          poll: null, postType: 'space', space,
          reactionTarget: null, direction: null,
          reporter: tx.from?.toLowerCase(),
          to: tx.to?.toLowerCase() ?? null,
          channel: tx.to?.toLowerCase(),
          timestamp: tx.timeStamp
            ? new Date(Number(tx.timeStamp) * 1000).toISOString()
            : new Date().toISOString(),
          txHash: hash,
          blockNumber: tx.blockNumber ? Number(tx.blockNumber) : null,
          chainId: Number(opts.chainId) || CANONICAL_CHAIN_ID,
          mode: opts.mode || 'main',
          ...opts.extra,
        };
      }
      /* malformed SPACE json — fall through to plain post */
    }
    /* Community notes + ratings are not feed posts — gathered via _scanChannelNotes. */
    if (text.startsWith(NOTE_PREFIX) || text.startsWith(NOTERATE_PREFIX)) return null;
    /* Pin markers are self-sent control txs, never feed posts. UNPIN checked
       first so the PIN prefix can't swallow it. */
    if (text.startsWith(UNPIN_PREFIX) || text.startsWith(PIN_PREFIX)) return null;
    if (text.startsWith(LIKE_PREFIX) || text.startsWith(UNLIKE_PREFIX)
      || text.startsWith(BOOKMARK_PREFIX) || text.startsWith(UNBOOKMARK_PREFIX)
      || text.startsWith(FOLLOW_PREFIX) || text.startsWith(UNFOLLOW_PREFIX)) return null;

    let parentTx = null, repostOf = null, repostOfChain = null, poll = null, postType = 'post', display;
    const replyM = text.match(/^REPLY_TO:(0x[a-f0-9]{64})\n\n/i);
    if (text.startsWith(POLL_PREFIX)) {
      poll = this._parsePoll(text);
      display = poll ? poll.question : text;
      if (poll) postType = 'poll';
    } else {
      /* REPOST may name the original on another chain: REPOST:eip155:<id>:0x…
         An unqualified REPOST:0x… means the original is on the canonical chain
         (true for every pre-multichain repost). */
      const repostM = text.match(/^REPOST:(?:eip155:(\d+):)?(0x[a-f0-9]{64})(?:\n\n([\s\S]*))?$/i);
      if (repostM) {
        repostOf      = repostM[2].toLowerCase();
        repostOfChain = repostM[1] ? Number(repostM[1]) : CANONICAL_CHAIN_ID;
        display  = repostM[3]?.trim() || '';
        postType = 'repost';
      } else if (replyM) {
        parentTx = replyM[1].toLowerCase();
        display  = text.slice(replyM[0].length).trim();
      } else {
        display = text;
      }
    }
    if (!display && !repostOf) return null;

    return {
      content: text, display, parentTx, repostOf, repostOfChain, poll, postType,
      reactionTarget: null, direction: null,
      reporter: tx.from?.toLowerCase(),
      to: tx.to?.toLowerCase() ?? null,
      channel: tx.to?.toLowerCase(),
      timestamp: tx.timeStamp
        ? new Date(Number(tx.timeStamp) * 1000).toISOString()
        : new Date().toISOString(),
      txHash: hash,
      blockNumber: tx.blockNumber ? Number(tx.blockNumber) : null,
      /* Post identity is (chainId, txHash). Defaults to the canonical chain so
         every existing single-chain call site keeps working unchanged; callers
         scanning another chain pass opts.chainId (see parseTxs). */
      chainId: Number(opts.chainId) || CANONICAL_CHAIN_ID,
      mode: opts.mode || 'main',
      ...opts.extra,
    };
  }

  parseTxs(txs, chainId = CANONICAL_CHAIN_ID) {
    const { mode, channel, signerAddr } = this.state;
    const lastCheck = parseInt(utils.safeLS.get(LAST_CHECK_KEY, '0'), 10);
    return txs.reduce((acc, tx) => {
      if (!tx.input || tx.input === '0x') return acc;
      const from = tx.from?.toLowerCase();
      const to   = tx.to?.toLowerCase();
      let raw;
      try { raw = ethers.toUtf8String(tx.input).trim(); }
      catch { return acc; }
      if (!raw) return acc;

      /* Mode-based address filtering — applies identically to reactions
         and posts, so it runs before either branch. */
      if (mode === 'notifications') {
        /* Notifications: txs TO me, not FROM me, newer than lastCheck */
        if (to !== signerAddr || from === signerAddr) return acc;
        if (Number(tx.timeStamp) * 1000 <= lastCheck) return acc;
      } else if (mode === 'self') {
        if (to !== signerAddr) return acc;
      } else {
        /* main / custom / wave — must be to this channel */
        if (to !== channel) return acc;
      }

      /* Reactions: LIKE/UNLIKE/FOLLOW/UNFOLLOW — parsed as typed feed items
         here (renderFeed skips them from display; the notifications tab
         shows them). Everything else routes through the canonical
         _parsePostTx so post/reply/repost/poll/vote semantics live in
         exactly one place. UN* checks first to avoid prefix collisions. */
      let postType = null;
      let reactionTarget = null;
      if (raw.startsWith(UNLIKE_PREFIX)) {
        postType = 'unlike';
        reactionTarget = utils.refHash(raw.slice(UNLIKE_PREFIX.length));
      } else if (raw.startsWith(LIKE_PREFIX)) {
        postType = 'like';
        reactionTarget = utils.refHash(raw.slice(LIKE_PREFIX.length));
      } else if (raw.startsWith(UNFOLLOW_PREFIX)) {
        postType = 'unfollow';
        reactionTarget = raw.slice(UNFOLLOW_PREFIX.length).trim().toLowerCase();
      } else if (raw.startsWith(FOLLOW_PREFIX)) {
        postType = 'follow';
        reactionTarget = raw.slice(FOLLOW_PREFIX.length).trim().toLowerCase();
      }

      if (postType) {
        /* Defense-in-depth: a reaction's target is sliced raw from chain
           data — validate its shape before it can pollute engagement or
           notifications. Malformed control txs are dropped. */
        if ((postType === 'like' || postType === 'unlike') && !/^0x[a-f0-9]{64}$/.test(reactionTarget)) return acc;
        if ((postType === 'follow' || postType === 'unfollow') && !/^0x[a-f0-9]{40}$/.test(reactionTarget)) return acc;
        /* Piggyback engagement detection on the feed scan (no extra API
           calls) — matched to my posts later in _engagementNotifs(). */
        if (postType === 'like') this._recordEngagement('like', from, reactionTarget, '', tx);
        acc.push({
          content: raw, display: raw, parentTx: null, repostOf: null,
          direction: null, poll: null, postType, reactionTarget,
          reporter: from, to: to ?? null,
          timestamp: tx.timeStamp
            ? new Date(Number(tx.timeStamp) * 1000).toISOString()
            : new Date().toISOString(),
          txHash: tx.hash.toLowerCase(), channel, mode,
          chainId: Number(chainId) || CANONICAL_CHAIN_ID,
          blockNumber: tx.blockNumber ? Number(tx.blockNumber) : null,
        });
        return acc;
      }

      /* Posts / replies / reposts / polls — and the silent capture of
         VOTE txs — all happen inside the single canonical parser.
         (This also drops non-self bookmark/profile control txs that the
         old inline logic let through as raw-text posts.) */
      const base = this._parsePostTx(tx, { mode, _text: raw, chainId });
      if (!base) return acc;

      /* Engagement piggyback for replies and reposts (see note above). */
      if (base.postType === 'repost' && base.repostOf) {
        this._recordEngagement('repost', from, base.repostOf, base.display.slice(0, 100), tx);
      } else if (base.parentTx) {
        this._recordEngagement('reply', from, base.parentTx, base.display.slice(0, 100), tx);
      }

      /* channel/mode are view-scoped (used by the IDB cache filter), not
         tx-scoped — override the canonical parser's tx-derived values. */
      acc.push({ ...base, channel, mode, direction: null });
      return acc;
    }, []);
  }

  startPolling() {
    this.stopPolling();
    if (typeof requestIdleCallback !== 'undefined') {
      const scheduleNext = () => {
        this._pollTimeout = setTimeout(() => {
          requestIdleCallback(() => {
            if (!this._pollStopped) { this.pollNew(); scheduleNext(); }
          }, { timeout: POLL_MS * 2 });
        }, POLL_MS);
      };
      this._pollStopped = false;
      scheduleNext();
    } else {
      this.pollTimer = setInterval(() => this.pollNew(), POLL_MS);
    }
  }
  stopPolling() {
    clearInterval(this.pollTimer);
    clearTimeout(this._pollTimeout);
    this.pollTimer    = null;
    this._pollTimeout = null;
    this._pollStopped = true;
  }

  async pollNew() {
    /* Skip on pages where the "Show N posts" banner makes no sense —
       user is on a specific channel, not the main timeline. */
    if (this._noBannerModes.has(this.state.mode)) return;
    if (!this.state.channel || this.state.loading) return;
    /* Skip polling when tab is hidden — saves bandwidth and rate limit.
       visibilitychange handler in init() resumes immediately on tab focus. */
    if (typeof document !== 'undefined' && document.hidden) return;
    const latestTs = this.state.posts[0] ? new Date(this.state.posts[0].timestamp) : new Date(0);
    try {
      /* Reuse _postMap rather than rebuilding a Set every poll cycle.
         _postMap is the canonical post lookup, kept in sync by renderFeed. */
      const inPending = new Set(this.state.pending.map(p => p.txHash));
      /* Use _postHashSet (O(1)) if available, fall back to _postMap.has */
      const inFeed = this._postHashSet || null;
      /* On the aggregated Home feed, poll page 1 of every enabled chain in
         parallel (each parsed with its chainId) so new posts on any chain
         surface in the "N new posts" banner. Single-chain → existing path. */
      const _chains = this._activeFeedChains();
      let candidates;
      if (_chains.length > 1) {
        const batches = await Promise.all(_chains.map(async cid => {
          try { return this.parseTxs(await this.apiFetch(this.queryAddr(), 1, cid), cid); }
          catch { return []; }
        }));
        candidates = batches.flat();
      } else {
        candidates = this.parseTxs(await this.fetchOnePage(1));
      }
      const fresh = candidates.filter(p =>
        /* >= not >: PulseScan timestamps are per-second, so a genuinely new
           post mined in the same second as the newest loaded post would be
           dropped. The hash-set + pending checks below reject true dupes. */
        new Date(p.timestamp) >= latestTs &&
        !(inFeed ? inFeed.has(p.txHash) : this._postMap.has(p.txHash)) &&
        !inPending.has(p.txHash)
      );
      if (fresh.length) {
        this.state.pending = [...fresh, ...this.state.pending];
        this._updateNewBanner();
      }
      /* parseTxs above captured any VOTE txs into the poll maps. Bound them on
         this recurring path too — previously they were only pruned on the
         cold-scan fallback, so a long session that never cold-opened a poll
         grew _voteAccum without limit. (No-op when under the cap.) */
      this._prunePollMaps();
      if (this.state.signerAddr) this.checkNotifBadge();
    } catch (err) { console.warn('Poll error', err); }
  }

  /* Update the floating "new posts" pill — populates the avatars
     (up to 3 unique posters from pending) and the count text. Called
     whenever state.pending changes via pollNew. */
  _updateNewBanner() {
    const btn       = this.g('new-banner');
    const avatarsEl = this.g('new-banner-avatars');
    const textEl    = this.g('new-banner-text');
    if (!btn || !avatarsEl || !textEl) return;
    const n = this.state.pending.length;
    if (n === 0) {
      btn.classList.remove('visible');
      return;
    }
    /* Up to 3 unique posters, newest first. Dedupe by reporter address. */
    const seen = new Set();
    const unique = [];
    for (const post of this.state.pending) {
      const addr = (post.reporter || '').toLowerCase();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      const profile = this.state.profCache[addr];
      const pic = profile?.picUrl || 'image1.jpeg';
      unique.push({ addr, pic });
      if (unique.length >= 3) break;
    }
    avatarsEl.innerHTML = unique.map(u =>
      `<img src="${utils.safe(u.pic)}" alt="" data-fallback-src="image1.jpeg">`
    ).join('');
    textEl.textContent = `Show ${n} post${n > 1 ? 's' : ''}`;
    btn.classList.add('visible');
    /* Keep the floating pill's label in sync; visibility is scroll-driven. */
    const pillText = this.g('new-pill-text');
    if (pillText) pillText.textContent = `Show ${n} post${n > 1 ? 's' : ''}`;
    this._updateFloatingPill();
  }

  /* Show the floating pill when there are pending posts and the stationary
     bar has scrolled out of view; hide it otherwise. */
  _updateFloatingPill() {
    const pill = this.g('new-pill');
    if (!pill) return;
    const n = this.state.pending.length;
    /* Fast path: no pending posts → never show the pill, and skip the
       getBoundingClientRect() layout read entirely. This avoids a forced
       reflow on every scroll frame during normal scrolling (the common
       case), which the browser was flagging as a performance violation. */
    if (n === 0) { pill.classList.remove('visible'); return; }
    /* Cheap scroll-position check first; only measure the bar when we've
       scrolled far enough that it could plausibly be out of view. */
    if (window.scrollY <= 200) { pill.classList.remove('visible'); return; }
    const bar = this.g('new-banner');
    const barOutOfView = bar ? bar.getBoundingClientRect().bottom < 60 : true;
    if (barOutOfView) pill.classList.add('visible');
    else pill.classList.remove('visible');
  }

  /* Update all visible relative timestamps in place. Reads the raw
     timestamp from each .post-time[data-ts] and recomputes relTime. */
  _tickRelativeTimes() {
    const els = document.querySelectorAll('.post-time[data-ts]');
    if (!els.length) return;
    els.forEach(el => {
      const ts = el.dataset.ts;
      if (!ts) return;
      const fresh = this.relTime(ts);
      if (el.textContent !== fresh) el.textContent = fresh;
    });
  }

  loadPending() {
    /* Keep the dedup set in sync, otherwise the next pagination fetch treats
       these just-promoted posts as unseen and re-appends duplicates. */
    this.state.pending.forEach(p => this._postHashSet.add(p.txHash));
    this.state.posts   = [...this.state.pending, ...this.state.posts];
    this.state.pending = [];
    this.g('new-banner').classList.remove('visible');
    this.g('new-pill')?.classList.remove('visible');
    this.renderFeed();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    /* Wire video autoplay observer for newly prepended posts */
    const feedEl = this.g('feed');
    /* Additive (no reset): renderFeed just rebuilt the observer; a second
       reset here would re-fire initial entries against mid-rebuild nodes. */
    if (feedEl) this._wireVideoObserver(feedEl);
  }

  async refreshFeed() {
    /* Bump token to cancel any in-flight fetch from before refresh. */
    this._fetchToken++;
    this.state.posts     = [];
    this.state.pending   = [];
    this.state.nextPage  = 1;
    this.state.hasMore   = true;
    this._postHashSet    = new Set(); /* invalidate O(1) dedup cache */
    /* Match resetAndFetch — refresh should give the user a clean slate,
       not preserve a stale search filter or expanded posts. */
    this.state.expanded.clear();
    this.state.activeTag  = null;
    this.state.searchTerm = '';
    const search = this.g('search-input');
    if (search) search.value = '';
    this.g('new-banner').classList.remove('visible');
    /* Loading flag may have been left true by a fetch we just cancelled. */
    this.state.loading = false;
    await this.fetchPosts(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });

  }

  async resetAndFetch() {
    this.stopPolling();
    /* Save current draft before channel switch, then restore the new
       channel's draft after the channel address changes. */
    this._saveDraft();
    this._fetchToken++;
    this.state.loading   = false;
    this.state.posts     = [];
    this.state.pending   = [];
    this.state.nextPage  = 1;
    this.state.hasMore   = true;
    this._postHashSet    = new Set();
    this._postMap.clear();
    this._fetchingQuotes = new Set(); /* clear in-flight quote fetches */
    /* Clear feed DOM and show skeleton placeholders so old channel's
       posts don't flash while new channel's posts are loading. The skeleton
       gets replaced when the first batch lands via loadCached/fetchPosts.
       Also disconnect the virtualization observer so we don't leak
       references to the old channel's elements. */
    const feedEl = this.g('feed');
    if (feedEl && !this._selfManagedModes.has(this.state.mode)) {
      if (this._vfObserver) { this._vfObserver.disconnect(); this._vfObserver = null; }
      this._renderSkeleton(4);
    }
    this.state.expanded.clear();
    this.state.activeTag  = null;
    this.state.searchTerm = '';
    this.g('search-input').value = '';
    this._updateSearchClearBtn();
    this.g('new-banner').classList.remove('visible');
    /* Restore draft for the new channel (set by caller before resetAndFetch) */
    this.g('compose-text').value = '';
    this._restoreDraft();
    await this.loadCached();
    await this.fetchPosts(true);
    if (this.state.mode !== 'notifications') this.startPolling();
  }

  async loadCached() {
    const { mode, channel, signerAddr } = this.state;
    let posts = [];
    if (mode !== 'notifications') {
      const chanKey = mode === 'self' ? signerAddr : channel;
      posts = (await this.cache.getPostsByChannel(chanKey))
        .filter(p => mode === 'self' ? p.mode === 'self' : p.mode === mode);
    }
    this.state.posts = posts.sort((a, b) => (b._tsMs ??= new Date(b.timestamp).getTime()) - (a._tsMs ??= new Date(a.timestamp).getTime()));
    /* Rebuild _postHashSet from cached posts so fetchPosts() doesn't
       re-add them as "new". Without this, every cached post appears
       twice in the feed after a channel switch: once from IDB via
       loadCached, and again from the chain scan via fetchPosts. */
    this._postHashSet = new Set(posts.map(p => p.txHash));
    this.renderFeed();
  }

  renderFeed() {
    /* Debounced — coalesces bursts of renders into one sidebar rebuild. */
    (this._refreshSidebarDebounced || (() => this._refreshSidebarPanels()))();
    const selfManaged = this._selfManagedModes;
    /* Inject pending page-header BEFORE the self-managed bail.
       Self-managed pages (Notifications, Explore, etc.) call
       feed.innerHTML = header + content in their own render functions.
       Non-self-managed pages (My Channel, Wave, Custom, Main) get the
       header prepended here to their feed DOM. */
    if (this._pendingPageHeader && !this.g('feed')?.querySelector('.page-header')) {
      const feed = this.g('feed');
      if (feed) feed.insertAdjacentHTML('afterbegin', this._pendingPageHeader);
      this._pendingPageHeader = null;
    }
    if (selfManaged.has(this.state.mode)) return;

    const feed = this.g('feed');
    const term = this.state.searchTerm;
    let list = this.state.posts;

    /* Following tab filter. The Following feed = posts from followed accounts,
       drawn from the main list PLUS a separate _followingExtra store (posts
       fetched only for this tab). Keeping them separate means they never leak
       into the For You / main-channel timeline. */
    if (this._followingFilter && this.state.following.size > 0) {
      const fset = this.state.following;
      const seen = new Set();
      const extra = this._followingExtra ? [...this._followingExtra.values()] : [];
      list = [...this.state.posts, ...extra].filter(p => {
        const r = p.reporter?.toLowerCase();
        if (!fset.has(r) || seen.has(p.txHash)) return false;
        seen.add(p.txHash); return true;
      }).sort((a, b) => (b._tsMs ??= new Date(b.timestamp).getTime()) - (a._tsMs ??= new Date(a.timestamp).getTime()));
    }

    /* Search filter */
    if (term) {
      if (term.startsWith('#')) {
        const tag = term.slice(1).toLowerCase();
        list = list.filter(p => p.display.toLowerCase().includes('#' + tag));
      } else {
        const lc = term.toLowerCase();
        const memResults = list.filter(p =>
          p.display?.toLowerCase().includes(lc) ||
          p.reporter?.toLowerCase().includes(lc));
        if (memResults.length > 0 || term.length < 3) {
          list = memResults;
        } else {
          /* No in-memory results — try full IDB trigram search asynchronously.
             Show empty feed immediately; results flow in when IDB responds. */
          this.cache.searchByText(term).then(hashes => {
            if (!hashes.length) return;
            return Promise.all(hashes.map(h => new Promise(res => {
              const req = this.cache._db?.transaction('posts','readonly')
                ?.objectStore('posts')?.get(h);
              if (req) { req.onsuccess = () => res(req.result); req.onerror = () => res(null); }
              else res(null);
            })));
          }).then(found => {
            if (!found) return;
            const posts = found.filter(Boolean);
            if (!posts.length) return;
            const known = this._postHashSet || new Set(this.state.posts.map(p => p.txHash));
            const fresh = posts.filter(p => !known.has(p.txHash));
            if (fresh.length) {
              this.state.posts = [...this.state.posts, ...fresh]
                .sort((a,b) => (b._tsMs ??= new Date(b.timestamp).getTime()) - (a._tsMs ??= new Date(a.timestamp).getTime()))
                .slice(0, this._getPostCap());
              fresh.forEach(p => { if (this._postHashSet) this._postHashSet.add(p.txHash); });
              this.renderFeed();
            }
          }).catch(() => {});
          list = memResults;
        }
      }
    }
    /* Engagement maps: prefer the persistent IDB-derived maps (which
       include reactions from across all sessions, not just what's loaded
       into state.posts right now). Merge in any state.posts entries that
       aren't yet in the persistent maps (e.g. new reactions just received
       from the chain but not yet flushed to IDB). */
    this._mergeEngagement(this.state.posts, /*reset=*/false);
    const replyMap   = this._engagement.replyMap;
    const likeMap    = this._engagement.likeMap;
    const repostMap  = this._engagement.repostMap;
    const engagerMap = this._engagement.engagerMap;

    /* Filter muted addresses */
    if (this.state.muted.size > 0) {
      list = list.filter(p => !this.state.muted.has(p.reporter?.toLowerCase()));
    }
    /* Only render actual posts -- filter out reactions/follows. Polls
       are real posts (postType 'poll') and must be included. Defensive:
       also drop any stray VOTE tx (e.g. cached before the drop logic
       existed) so raw VOTE data can never surface in the feed. */
    const cf = this._getSettings();
    const mwRe = this._mutedWordsRe();   /* Muted words matcher (null if none) */
    const me = this.state.signerAddr;
    const displayList = list.filter(p => {
      if (this._notInterested?.has(p.txHash)) return false; /* locally hidden */
      if (p.content && p.content.startsWith(VOTE_PREFIX)) return false;
      if (p.content && (p.content.startsWith(DM_PREFIX) || p.content.startsWith(DMKEY_PREFIX))) return false; /* never show DM ciphertext as a feed post */
      if (!(!p.postType || p.postType === 'post' || p.postType === 'repost' || p.postType === 'poll' || p.postType === 'space')) return false;
      /* User content filters (Settings → Content & Feed). */
      if (cf.hideReposts && p.postType === 'repost') return false;
      if (cf.hidePolls   && p.postType === 'poll')   return false;
      if (cf.hideReplies && p.parentTx)              return false;
      if (cf.hideBinary  && this._isLikelyBinary(p.display)) return false;
      /* Muted words — hide others' posts containing a muted word/phrase (your
         own posts are never hidden from you). */
      if (mwRe && p.reporter !== me && p.display && mwRe.test(p.display)) return false;
      return true;
    });

    if (!displayList.length) {
      /* Context-aware empty state — the message has to match WHY the feed is
         empty (still scanning / no tag matches / no followed posts / no search
         hits / genuinely empty channel), not always "be the first to post". */
      let icon = '📡', title, sub;
      if (this.state.loading) {
        icon = '<div class="spinner" aria-hidden="true" style="margin:0 auto"></div>';
        title = 'Scanning the chain…';
        sub   = `Checked ${this.state.nextPage - 1} page(s) so far`;
      } else if (this.state.activeTag) {
        icon = '🔍';
        title = `No posts tagged #${utils.safe(this.state.activeTag)}`;
        sub   = 'Nobody has used this hashtag yet — try another, or be the first.';
      } else if (this._followingFilter) {
        icon = '👤';
        title = 'No posts from people you follow yet';
        sub   = 'When the accounts you follow post, you’ll see them here.';
      } else if (term) {
        icon = '🔍';
        title = `No posts matching “${utils.safe(term)}”`;
        sub   = 'Try a different word, #tag, or address.';
      } else {
        const msgs = { notifications: 'No new notifications', self: 'No posts to your channel yet' };
        title = msgs[this.state.mode] || 'Nothing here yet';
        sub   = 'Be the first to post in this channel';
      }
      feed.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">${icon}</span>
          <h3>${title}</h3>
          <p style="font-size:14px;margin-top:6px;color:var(--muted)">${sub}</p>
        </div>`;
      return;
    }
    /* Virtualized render. The first batch (INITIAL_MOUNT) is mounted as
       real .post-item DOM so the user sees content immediately. Everything
       after is a .post-placeholder with reserved height; the
       IntersectionObserver promotes them to real items as they enter the
       buffer zone (2 viewports above/below visible). This dramatically
       reduces DOM weight on long feeds (2000-post cap goes from ~6MB of
       DOM to <500KB). */
    const INITIAL_MOUNT = 20;
    this._postMap.clear();
    /* Cache the engagement maps so observer swap-ins can call postHTML
       with the same data the initial render used. */
    this._vfMaps = { replyMap, likeMap, repostMap, engagerMap };

    const frag = document.createDocumentFragment();
    displayList.forEach((post, idx) => {
      this._postMap.set(post.txHash, post);
      const el = (idx < INITIAL_MOUNT)
        ? this._vfMountReal(post)
        : this._vfMountPlaceholder(post);
      frag.appendChild(el);
      if (idx < INITIAL_MOUNT && post.reporter !== this.state.signerAddr) {
        this.fetchOtherProfile(post.reporter);
      }
    });
    /* Bound the virtualization height cache: heights for posts no longer in the
       feed are dead weight that accumulates over a long session. _postMap now
       holds exactly the current feed, so prune to it once the cache has grown
       well past the feed (slack avoids churning the map on every render). */
    if (this._vfHeightMap.size > displayList.length + 500) {
      for (const k of this._vfHeightMap.keys()) {
        if (!this._postMap.has(k)) this._vfHeightMap.delete(k);
      }
    }
    feed.innerHTML = '';
    feed.appendChild(frag);
    this._wireVideoObserver(feed, true); /* reset: feed DOM rebuilt */
    /* Initialize the observer AFTER the DOM is in place so it can compute
       intersection rects against the freshly-rendered elements. */
    this._vfInitObserver(feed);
    /* Measure the mounted posts so future swaps use real heights. */
    this._vfMeasureMounted(feed);
    /* Gather community notes for this channel (throttled 60s) and fill in the
       note slots when done. Fire-and-forget — doesn't block the render. */
    this._scanChannelNotes();
  }

  /* Build engagement maps from the full IDB cache. Counts every reply,
     like, and repost we've ever observed across all sessions — not just
     what's currently in state.posts. Lazy-called; result cached on the
     class. Filtered by channel/mode so different views show the right
     scope. Cost: one IDB scan per channel switch; amortized over many
     renders. */
  async _refreshEngagementFromCache() {
    try {
      const all = await this.cache.getPosts(() => true);
      this._mergeEngagement(all, /*reset=*/true);
      this._engagementReady = true;
      /* Re-render the feed so visible posts pick up the fresh counts. */
      if (!this._selfManagedModes.has(this.state.mode)) this.renderFeed();
    } catch (err) {
      console.warn('Engagement rebuild failed:', err);
    }
  }

  /* Merge a batch of posts into the engagement maps. If reset=true, the
     maps are cleared first (used on channel switch). Otherwise this is
     incremental — new posts just add to the existing counts. Idempotent
     via engagerMap which tracks unique addresses. */
  _mergeEngagement(posts, reset = false) {
    const eng = this._engagement;
    if (reset) {
      eng.replyMap.clear(); eng.likeMap.clear();
      eng.repostMap.clear(); eng.engagerMap.clear();
      eng.likeState.clear();
    }
    /* Track which (target, engager) pairs we've already counted so
       incremental updates don't double-count. The engagerMap value is a
       Set of addresses; .add() is naturally idempotent. */
    posts.forEach(p => {
      if (p.parentTx) {
        if (!eng.engagerMap.has(p.parentTx)) eng.engagerMap.set(p.parentTx, new Set());
        const set = eng.engagerMap.get(p.parentTx);
        if (!set.has(p.reporter)) {
          set.add(p.reporter);
          eng.replyMap.set(p.parentTx, (eng.replyMap.get(p.parentTx) || 0) + 1);
        }
      }
      if ((p.postType === 'like' || p.postType === 'unlike') && p.reactionTarget) {
        const target = p.reactionTarget;
        /* engagerMap is the "ever interacted" set behind the eye/interaction
           count — a like OR an unlike both count as having interacted, so we
           record presence either way (idempotent via the Set). */
        if (!eng.engagerMap.has(target)) eng.engagerMap.set(target, new Set());
        eng.engagerMap.get(target).add(p.reporter);
        /* likeMap is the CURRENT like count. Keep the latest like-state per
           engager (by timestamp) so an UNLIKE undoes an earlier LIKE no
           matter what order batches are merged in, then recount. */
        if (!eng.likeState.has(target)) eng.likeState.set(target, new Map());
        const states = eng.likeState.get(target);
        const ts     = Date.parse(p.timestamp) || 0;
        const prev   = states.get(p.reporter);
        if (!prev || ts >= prev.ts) {
          states.set(p.reporter, { liked: p.postType === 'like', ts });
        }
        let count = 0;
        states.forEach(s => { if (s.liked) count++; });
        eng.likeMap.set(target, count);
      }
      if (p.postType === 'repost' && p.repostOf) {
        if (!eng.engagerMap.has(p.repostOf)) eng.engagerMap.set(p.repostOf, new Set());
        const set = eng.engagerMap.get(p.repostOf);
        if (!set.has(p.reporter)) {
          set.add(p.reporter);
          eng.repostMap.set(p.repostOf, (eng.repostMap.get(p.repostOf) || 0) + 1);
        }
      }
    });
  }

  /* Build a real .post-item element. Used by the initial render and by
     the observer when promoting a placeholder. */
  _vfMountReal(post) {
    const el = document.createElement('div');
    el.className      = 'post-item';
    el.dataset.txhash = post.txHash;
    const maps = this._vfMaps || {};
    el.innerHTML = this.postHTML(post, false,
      maps.replyMap, maps.likeMap, maps.repostMap, maps.engagerMap);
    this._vfMountedRef.set(el, post);
    /* If this post is a poll, render it from votes already captured by the
       feed scan (instant); _ensurePollTally cold-scans only if none seen. */
    if (post.poll) this._ensurePollTally(post);
    return el;
  }

  /* Build a .post-placeholder element with reserved height. The height
     uses the cached measured height if known, otherwise an estimate.
     Without this height reservation, swapping placeholder→real on
     scroll would shift everything below. */
  _vfMountPlaceholder(post) {
    const el = document.createElement('div');
    el.className      = 'post-placeholder';
    el.dataset.txhash = post.txHash;
    const h = this._vfHeightMap.get(post.txHash) || this._vfEstHeight;
    el.style.height = h + 'px';
    return el;
  }

  /* Set up the IntersectionObserver. Uses a 200% rootMargin so posts
     mount well before they're visible (smooth scroll, no pop-in). */
  _vfInitObserver(feed) {
    if (this._vfObserver) this._vfObserver.disconnect();
    if (!('IntersectionObserver' in window)) {
      /* Browser doesn't support — mount everything. Graceful degradation. */
      feed.querySelectorAll('.post-placeholder').forEach(ph => {
        this._vfPromote(ph);
      });
      return;
    }
    this._vfObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const el = entry.target;
        if (entry.isIntersecting) {
          if (el.classList.contains('post-placeholder')) {
            this._vfPromote(el);
          }
        } else {
          if (el.classList.contains('post-item')) {
            this._vfDemote(el);
          }
        }
      });
    }, {
      root: null,
      /* Mount/unmount window: roughly 2 viewports above and below */
      rootMargin: '200% 0px 200% 0px',
      threshold: 0,
    });
    feed.querySelectorAll('.post-placeholder, .post-item').forEach(el => {
      this._vfObserver.observe(el);
    });
  }

  /* Measure mounted .post-item heights and cache them. Called after
     initial render and after each promote. Uses requestAnimationFrame
     so layout is settled when we read offsetHeight. */
  _vfMeasureMounted(feed) {
    requestAnimationFrame(() => {
      feed.querySelectorAll('.post-item').forEach(el => {
        const h = el.offsetHeight;
        const txHash = el.dataset.txhash;
        if (txHash && h > 0) this._vfHeightMap.set(txHash, h);
      });
    });
  }

  /* Promote a placeholder to a real .post-item. Preserves scroll
     position by leaving the element in-place (only innerHTML and
     class swap). */
  _vfPromote(placeholder) {
    const txHash = placeholder.dataset.txhash;
    if (!txHash) return;
    const post = this._postMap.get(txHash);
    if (!post) return;
    const maps = this._vfMaps || {};
    /* Convert in-place — don't replaceChild because that would lose the
       observer registration. Just swap class + content. */
    placeholder.className = 'post-item';
    placeholder.style.height = '';
    placeholder.innerHTML = this.postHTML(post, false,
      maps.replyMap, maps.likeMap, maps.repostMap, maps.engagerMap);
    this._vfMountedRef.set(placeholder, post);
    /* Measure once layout settles */
    requestAnimationFrame(() => {
      const h = placeholder.offsetHeight;
      if (h > 0) this._vfHeightMap.set(txHash, h);
    });
    /* Videos in promoted posts must join the play/pause observer — without
       this, any video that enters via scroll-virtualization autoplays from
       its attribute but never pauses off-screen (it was never observed). */
    this._wireVideoObserver?.(placeholder);
    /* Lazy-load author profile for newly mounted posts */
    if (post.reporter !== this.state.signerAddr) {
      this.fetchOtherProfile(post.reporter);
    }
  }

  /* Demote a .post-item back to a .post-placeholder. Caches the current
     height so the swap doesn't shift content below. Skips demotion for
     pending posts (those at the top of the feed that aren't on-chain
     yet — keep them mounted so the user sees their post status). */
  _vfDemote(item) {
    if (item.classList.contains('pending-post')) return;
    const txHash = item.dataset.txhash;
    if (!txHash) return;
    /* Capture height BEFORE clearing innerHTML */
    const h = item.offsetHeight;
    if (h > 0) this._vfHeightMap.set(txHash, h);
    item.className = 'post-placeholder';
    item.style.height = (h || this._vfEstHeight) + 'px';
    item.innerHTML = '';
    this._vfMountedRef.delete(item);
  }

  _wireVideoObserver(container, reset = false) {
    /* MEDIA observer — native <video> posts AND YouTube/Vimeo embeds.
       Native videos: pause off-screen, autoplay (muted) on-screen when the
       setting allows. Embeds: a facade entering the viewport auto-converts
       to a MUTED playing embed (autoplay setting permitting); any embed
       leaving the viewport reverts to its facade — the only reliable way to
       stop a cross-origin iframe, and it also stops click-started (sound)
       embeds once scrolled away. Strict one-playing rule across everything
       via _stopOtherMedia. */
    const media = container.querySelectorAll('.post-vid-thumb, .post-yt-facade, .post-embed-playing, .x-embed-facade, .x-embed-loaded');
    if (!media.length && !reset) return;
    const st = this._getSettings();
    const autoplay = st.autoplayMedia !== false && !st.dataSaver;
    if (reset) {
      this._vidObserver?.disconnect(); this._vidObserver = null;
      this._embObserver?.disconnect(); this._embObserver = null;
    }
    if (!this._vidObserver) {
      this._vidObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          const el = entry.target;
          if (!entry.isIntersecting) {
            if (!el.isConnected) { this._vidObserver.unobserve(el); return; }
            el.pause();
            return;
          }
          const s2 = this._getSettings();
          if (s2.autoplayMedia === false || s2.dataSaver) return;
          if (!el.controls) el.play().catch(() => {});
        });
      }, { threshold: 0.5 });
    }
    if (!this._embObserver) {
      /* Embeds get a gentler gate than file videos: start only when ¾
         visible, stop only when mostly gone (<¼) — hysteresis prevents
         the start/stop churn of a single threshold while scrolling. */
      this._embObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          const el = entry.target;
          if (el.classList.contains('post-embed-playing')) {
            if (!el.isConnected) { this._embObserver.unobserve(el); return; }
            if (entry.intersectionRatio < 0.25) this._revertEmbed(el);
            return;
          }
          /* X embeds ride the same hysteresis: load X's iframe at ¾
             visible (default ON, same gate as YT/Vimeo), unload back to
             the facade when mostly gone — bounds memory and is the only
             way to stop a cross-origin player. */
          if (el.classList.contains('x-embed-loaded')) {
            if (!el.isConnected) { this._embObserver.unobserve(el); return; }
            /* Keep the loaded tweet until it's almost entirely gone — avoids
               churn now that it loads early. */
            if (entry.intersectionRatio < 0.05) this._revertXEmbed(el);
            return;
          }
          if (el.classList.contains('x-embed-facade')) {
            const s3 = this._getSettings();
            if (s3.dataSaver || s3.autoplayEmbeds === false || s3.loadEmbedThumbs === false) return;
            /* X posts auto-load as soon as they enter the viewport (≥¼), so a
               shared tweet appears on its own like it does on X — no tap. The
               privacy toggles above (or Data saver) turn this off. */
            if (entry.intersectionRatio >= 0.25) this._loadXEmbed(el);
            return;
          }
          if (!el.classList.contains('post-yt-facade')) return;
          const s2 = this._getSettings();
          /* Auto-embedding loads Google/Vimeo iframes without a click —
             OPT-IN only, and never while strict embed privacy is on. */
          if (s2.dataSaver || s2.autoplayEmbeds === false || s2.loadEmbedThumbs === false) return;
          if (entry.intersectionRatio >= 0.75) this._playFacade(el, true);
        });
      }, { threshold: [0.05, 0.25, 0.75] });
    }
    media.forEach(el => {
      const isVideo = el.tagName === 'VIDEO';
      /* Reveal the video (fade in) once its first frame is ready, so it never
         flashes a blank black box while loading. Reveal immediately if already
         buffered; otherwise on the first of loadeddata/canplay/playing, with a
         safety timeout so a video that never fires those is never left hidden. */
      if (isVideo && el.dataset.vidReady !== '1') {
        const reveal = () => { el.dataset.vidReady = '1'; el.classList.add('vid-ready'); };
        /* Reveal on the first ACTUALLY-painted frame (requestVideoFrameCallback)
           so the fade-in lands on real pixels. The data-ready events below fire
           before the first frame composites, which is what caused the black
           blink on start. Keep them only as a fallback: paused videos never
           present a frame to rVFC, and a safety timeout guarantees a video is
           never left hidden. */
        if (typeof el.requestVideoFrameCallback === 'function') {
          el.requestVideoFrameCallback(reveal);
          el.addEventListener('loadeddata', () => { if (el.paused) reveal(); }, { once: true });
        } else if (el.readyState >= 2) {
          reveal();
        } else {
          el.addEventListener('loadeddata', reveal, { once: true });
          el.addEventListener('canplay',    reveal, { once: true });
          el.addEventListener('playing',    reveal, { once: true });
        }
        setTimeout(reveal, 2500);
      }
      if (isVideo) {
        if (autoplay && el.controls) {
          el.controls = false;
          const btn = el.parentElement?.querySelector('.vid-unmute-btn');
          if (btn) btn.style.display = '';
        } else if (!autoplay) {
          el.removeAttribute('autoplay');
          el.controls = true;
          el.pause();
          const btn = el.parentElement?.querySelector('.vid-unmute-btn');
          if (btn) btn.style.display = 'none';
        }
      }
      if (!reset && el.dataset.vidObserved === '1') return;
      el.dataset.vidObserved = '1';
      (isVideo ? this._vidObserver : this._embObserver).observe(el);
    });
    /* Strict exclusivity for natives that start by attribute/controls, and
       single-sound via volumechange. Capture phase: media events don't
       bubble. Wired once. */
    if (!this._singleVidWired) {
      this._singleVidWired = true;
      document.addEventListener('play', e => {
        const v = e.target;
        if (!v || v.tagName !== 'VIDEO' || !v.classList.contains('post-vid-thumb')) return;
        this._stopOtherMedia(v);
      }, true);
      document.addEventListener('volumechange', e => {
        const v = e.target;
        if (!v || v.tagName !== 'VIDEO' || !v.classList.contains('post-vid-thumb') || v.muted) return;
        this._stopOtherMedia(v);
        document.querySelectorAll('video.post-vid-thumb').forEach(o => {
          if (o !== v && !o.muted) {
            o.muted = true;
            const b = o.parentElement?.querySelector('.vid-unmute-btn');
            if (b) b.textContent = '🔇';
          }
        });
      }, true);
    }
  }

  /* Auto-wire safety net: a MutationObserver watches the whole page for
     media added by ANY render path — main feed, profiles, threads,
     bookmarks, lists, quote cards, future views — and registers it with
     the media observer. Forgotten per-path wiring was why profile and
     thread videos never paused off-screen. */
  _initVideoAutoWire() {
    if (this._videoAutoWire) return;
    /* Includes .x-embed-facade so X embeds inserted by async paths (e.g. a
       repost/quote card hydrated after fetch) also auto-load on scroll. */
    const SEL = '.post-vid-thumb, .post-yt-facade, .x-embed-facade';
    this._videoAutoWire = new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches?.(SEL)) { this._wireVideoObserver(n.parentElement || n); continue; }
          if (n.querySelector?.(SEL)) this._wireVideoObserver(n);
        }
      }
    });
    this._videoAutoWire.observe(document.body, { childList: true, subtree: true });
  }

  /* ── Twemoji (Twitter/X color emoji) ──────────────────────────────────
     Replace emoji TEXT with Twitter's own emoji images so they render
     identically across every device/OS instead of each platform's native
     monochrome-or-mismatched glyphs. Display-only: the source text nodes are
     swapped for <img class="emoji">, but inputs/textareas keep the real char
     in .value (twemoji only touches DOM text nodes, never form-control values).
     Library is from cdnjs (SRI-pinned); images come from a live jsdelivr base. */
  _twemojify(root) {
    if (!root || !window.twemoji || this._twemojiParsing) return;
    this._twemojiParsing = true;
    try {
      window.twemoji.parse(root, {
        folder: 'svg', ext: '.svg',
        base: 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/',
        className: 'emoji',
      });
    } catch { /* twemoji unavailable/offline — emoji fall back to system glyphs */ }
    finally { this._twemojiParsing = false; }
  }

  /* Auto-apply twemoji to everything the app renders. A debounced
     MutationObserver on <body> catches every render path (feed, profiles,
     threads, modals, quote cards, …) so we never have to remember to call
     _twemojify by hand. Loop-safe: twemoji's own inserted <img class="emoji">
     nodes are ignored, and the _twemojiParsing flag makes parse re-entrant-safe;
     text inside <textarea>/<input> is skipped so typed content is never imaged. */
  _initTwemoji() {
    if (this._twemojiObserver || !window.twemoji) return;
    this._twemojiQueue = new Set();
    const flush = () => {
      this._twemojiFlushTimer = null;
      const nodes = this._twemojiQueue;
      this._twemojiQueue = new Set();
      for (const n of nodes) {
        if (!n.isConnected) continue;
        this._twemojify(n);
        this._twemojiParseCount = (this._twemojiParseCount || 0) + 1;
      }
    };
    this._twemojiObserver = new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;                 // elements only
          /* Skip twemoji's own output so we never re-trigger ourselves. */
          if (n.tagName === 'IMG' && n.classList.contains('emoji')) continue;
          /* Never parse into form controls — their text lives in .value. */
          const tag = n.tagName;
          if (tag === 'TEXTAREA' || tag === 'INPUT') continue;
          if (n.closest?.('textarea, input')) continue;
          this._twemojiQueue.add(n);
        }
      }
      if (this._twemojiQueue.size && !this._twemojiFlushTimer) {
        this._twemojiFlushTimer = setTimeout(flush, 80);
      }
    });
    this._twemojiObserver.observe(document.body, { childList: true, subtree: true });
    /* Parse whatever is already on the page (initial paint the observer missed). */
    this._twemojify(document.body);
  }


  /* Resolve display info (avatar, name, verified badge) for a post.
     Pulls from this.state.profile if it's our own post, otherwise from
     this.state.profCache. Returns the bits needed by postHTML. */
  _postProfileFields(post) {
    const isOwn = post.reporter === this.state.signerAddr;
    let picUrl, displayName, hasProfile;
    if (isOwn) {
      picUrl      = this.state.profile.picUrl || 'image1.jpeg';
      displayName = this.state.profile.username
        ? utils.safe(this.state.profile.username)
        : this.trunc(post.reporter);
      hasProfile  = !!this.state.profile.username;
    } else {
      const c = this.state.profCache[post.reporter];
      picUrl      = c?.picUrl  || 'image1.jpeg';
      displayName = c?.username ? utils.safe(c.username) : this.trunc(post.reporter);
      hasProfile  = !!c?.username;
    }
    /* On-chain "verified" — ✓ next to names that have published a
       PROFILE_DATA tx. Free differentiator over Twitter: no payment,
       no gatekeeper, just chain proof of identity. */
    const verifiedBadge = hasProfile
      ? '<span class="verified-icon" title="On-chain profile verified"><svg viewBox="0 0 22 22" width="14" height="14" style="vertical-align:-2px"><path fill="#1d9bf0" d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"/></svg></span>'
      : '';
    return { isOwn, picUrl, displayName, verifiedBadge, hasProfile };
  }

  /* Heuristic: is this post's text actually binary/non-text data (a tx whose
     input bytes happen to decode without throwing but aren't a real message)?
     Used to flag + de-emphasize such posts rather than show a wall of gibberish.
     Conservative — only LABELS them, so an occasional false positive is harmless. */
  _isLikelyBinary(s) {
    if (!s || s.length < 16) return false;
    let ctrl = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      /* Control chars (except tab/newline/CR) and the Unicode replacement char
         are the reliable binary signal. Legit non-Latin scripts (Chinese,
         Arabic, …) and emoji contain none, so they're never mislabeled — unlike
         the old "dense non-ASCII + few spaces" rule, which flagged real prose. */
      if (c === 0xFFFD || (c < 0x20 && c !== 9 && c !== 10 && c !== 13)) ctrl++;
    }
    return ctrl / s.length > 0.03;
  }

  /* Compiled, cached matcher for the user's Muted words (Settings → Content &
     Feed). Returns a word-boundary RegExp that matches any muted word/phrase,
     or null when none are set. Cached by the word list so it compiles once. */
  _mutedWordsRe() {
    const words = (this._getSettings().mutedWords || [])
      .map(w => String(w).trim()).filter(Boolean);
    const key = words.join('');
    if (this._mwCacheKey === key) return this._mwRe;
    this._mwCacheKey = key;
    if (!words.length) { this._mwRe = null; return null; }
    const esc = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    try { this._mwRe = new RegExp('(?:^|\\W)(?:' + esc.join('|') + ')(?:\\W|$)', 'i'); }
    catch { this._mwRe = null; }
    return this._mwRe;
  }

  /* Build the embedded repost/quote card showing the original post.
     If the original is in _postMap, render the quote inline.
     If not, render a loading placeholder and trigger a background fetch. */
  /* Inner HTML for a quote card (header + text + compact media preview).
     Shared by the immediate render (_postRepostCard) and the async patch
     (_fetchQuotedPost) so both paths produce identical cards. Media URLs
     are stripped from the text preview and shown as a small thumbnail
     (images) or a ▶ Video chip instead of raw link text — X-style. */
  _quoteCardInner(orig) {
    this._reviveSpace(orig);
    const c    = this.state.profCache[orig.reporter] || {};
    const name = c.username ? utils.safe(c.username) : this.trunc(orig.reporter);
    const pic  = utils.safe(utils.safeUrl(c.picUrl) || 'image1.jpeg');
    const imgs   = this._mediaImageUrls(orig.display);
    const words  = orig.display.split(/\s+/);
    const vidUrl = words.find(w => _LK_VID_RE.test(w) && /^(https?:|ipfs:|ar:|arweave:)/.test(w));
    let ytVid = null, vmVid = null, xTw = null, grok = null;
    for (const w of words) {
      if (!ytVid) ytVid = utils.ytId(w);
      if (!vmVid) vmVid = utils.vimeoId(w);
      if (!xTw)   xTw   = utils.xPost(w);
      if (!grok)  grok  = utils.grokPost(w);
      if (ytVid || vmVid || xTw || grok) break;
    }
    /* Strip media + embed URLs (incl. X / Grok) from the preview text; what
       remains is the author's own words. Without the X/Grok cases a reposted
       X share left its raw x.com URL in the body (looked like "raw data"). */
    const isEmbedUrl = u => this._postHasMedia(u) || _LK_VID_RE.test(u)
      || !!utils.ytId(u) || !!utils.vimeoId(u) || !!utils.xPost(u) || !!utils.grokPost(u);
    let text = orig.display.replace(_LK_RE, m =>
      (/^(https?:|ipfs:|ar:|arweave:)/.test(m) && isEmbedUrl(m)) ? '' : m);
    text = text.replace(/\s{2,}/g, ' ').trim();
    const body = utils.safe(text.slice(0, 200) + (text.length > 200 ? '…' : ''));
    /* Real media in the card, like the original post: native videos get a
       muted looping preview; YouTube/Vimeo get the same click-to-play
       facade the feed uses (the media observer + delegated-click guard
       treat them identically to feed media). */
    let mediaHtml = '';
    if (vidUrl) {
      const safeV = utils.safe(utils.safeUrl(vidUrl.startsWith('ipfs://') ? utils.resolveIPFS(vidUrl) : vidUrl) || '');
      if (safeV) mediaHtml = `<div class="post-vid-wrap repost-card-vidwrap">
        <video src="${safeV}" class="post-vid-thumb" autoplay muted loop playsinline preload="metadata"
          data-fallback="hide-wrap"></video>
      </div>`;
    } else if (ytVid) {
      const sv = utils.safe(ytVid);
      const thumbOk = this._embedThumbsAllowed();
      mediaHtml = `<div class="post-vid-wrap post-yt-facade repost-card-vidwrap${thumbOk ? '' : ' yt-facade-private'}" data-yt-id="${sv}">
        ${thumbOk ? `<img src="https://i.ytimg.com/vi/${sv}/hqdefault.jpg" class="post-yt-thumb" alt="YouTube video" loading="lazy"
          data-fallback-src="https://i.ytimg.com/vi/${sv}/default.jpg">`
        : `<div class="post-yt-private-label">▶ YouTube video<span>Tap to load — connects to YouTube</span></div>`}
        <div class="post-yt-play">
          <svg viewBox="0 0 68 48" width="68" height="48">
            <path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="#f00"/>
            <path d="M45 24 27 14v20" fill="#fff"/>
          </svg>
        </div>
      </div>`;
    } else if (vmVid) {
      mediaHtml = `<div class="post-vid-wrap post-yt-facade post-vimeo-facade repost-card-vidwrap" data-vimeo-id="${utils.safe(vmVid)}">
        <div class="post-yt-play" style="position:static;margin:40px auto">
          <svg viewBox="0 0 68 48" width="68" height="48"><rect width="68" height="48" rx="10" fill="#17a2e6"/><path d="M45 24 27 14v20" fill="#fff"/></svg>
        </div>
      </div>`;
    } else if (imgs.length) {
      mediaHtml = `<img class="repost-card-thumb" src="${utils.safe(imgs[0])}" alt="" loading="lazy" data-fallback="hide">`;
    } else if (xTw) {
      /* Reposted X share: render the FULL X embed (the same auto-loading
         facade the feed uses), so the quote card shows the real tweet —
         text, images & video — not just a "Post on X" placeholder. The
         media observer auto-loads it as it scrolls into view. */
      mediaHtml = utils.xFacadeHTML(xTw.handle, xTw.id, `https://x.com/${xTw.handle}/status/${xTw.id}`);
    } else if (grok) {
      const label = grok.kind === 'imagine' ? 'Grok Imagine' : 'Grok';
      mediaHtml = `<a class="grok-card" href="${utils.safe(grok.href)}" target="_blank" rel="noopener noreferrer">
        <span class="grok-card-logo" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2.5l2.6 6.9L21.5 12l-6.9 2.6L12 21.5l-2.6-6.9L2.5 12l6.9-2.6z"/></svg></span>
        <span class="grok-card-body"><span class="grok-card-title">${label}</span><span class="grok-card-sub">View on Grok</span></span>
      </a>`;
    }
    return `
      <div class="repost-card-hdr">
        <img src="${pic}" class="repost-card-avatar" alt="" data-fallback-src="image1.jpeg">
        <span class="repost-card-name">${name}</span>
        <span style="color:var(--muted);font-size:13px;margin-left:4px">· ${this.relTime(orig.timestamp)}</span>
      </div>
      ${body ? `<div class="repost-card-body">${body}</div>` : ''}
      ${orig.space ? this._spaceStripHTML(orig.space) : ''}
      ${mediaHtml}`;
  }

  /* Detect an in-body link to ANOTHER SayIt post and strip it from the text.
     Sets post._linkQuote to the first non-self referenced hash (or null) and
     returns the body text with every occurrence of that link removed. A real
     repost (post.repostOf) wins; binary posts are skipped. post.content is
     never touched — callers pass post.display and use the returned string. */
  _applyLinkQuote(post) {
    let text = post.display;
    post._linkQuote = null;
    if (post.repostOf || typeof text !== 'string' || this._isLikelyBinary(text)) return text;
    _SAYIT_POST_RE.lastIndex = 0;
    let m, firstHash = null;
    const selfHash = (post.txHash || '').toLowerCase();
    while ((m = _SAYIT_POST_RE.exec(text))) {
      const h = (m[1] || m[2] || '').toLowerCase();
      if (h && h !== selfHash) { firstHash = h; break; }
    }
    if (firstHash) {
      post._linkQuote = firstHash;
      text = text.replace(_SAYIT_POST_RE, (full, a, b) =>
        ((a || b || '').toLowerCase() === firstHash ? '' : full)).replace(/[ \t]{2,}/g, ' ').trim();
    }
    return text;
  }

  _postRepostCard(post) {
    /* A real repost/quote (post.repostOf) wins; otherwise an in-body link to
       another SayIt post (post._linkQuote, set in postHTML) renders the same
       quote card. Both share the identical fetch-on-miss hydration path. */
    const hash = post.repostOf || post._linkQuote;
    if (!hash) return '';
    const orig = this._postMap.get(hash);
    if (orig) {
      return `
        <div class="repost-card" data-open-quote="${utils.safe(hash)}" data-act="open-quote" data-act-arg="${utils.safe(hash)}" data-act-arg2="${utils.safe(post.to || this.state.channel || '')}">
          ${this._quoteCardInner(orig)}
        </div>`;
    }
    /* Original not in _postMap — render placeholder and trigger fetch from the
       original's own chain (repostOfChain), so cross-chain reposts resolve. */
    const qid = utils.safe(hash);
    this._fetchQuotedPost(hash, post.to || this.state.channel, post.repostOfChain);
    return `<div class="repost-card repost-card-missing" data-fetch-quote="${qid}" id="qc-${qid.slice(2,8)}">
      <span class="spinner sp-sm" aria-hidden="true"></span>
      <span>Loading quoted post…</span>
    </div>`;
  }

  /* Build the small "engagement" indicator (eye icon + interaction count)
     shown in the action row. Returns '' if there's no engagement and no
     block number; returns a faded indicator if only block info is available. */
  _postEngagementHTML(post, engagerMap) {
    const engagers = engagerMap ? engagerMap.get(post.txHash) : null;
    const count    = engagers ? engagers.size : 0;
    const eyeSvg   = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';
    if (count > 0) {
      return '<span class="act-views" title="' + (count === 1 ? '1 interaction' : count + ' interactions') +
             '"><span class="act-icon">' + eyeSvg + '</span><span class="act-count">' + count + '</span></span>';
    }
    if (post.blockNumber) {
      return '<span class="act-views" title="Block #' + post.blockNumber + '" style="opacity:0.4"><span class="act-icon">' + eyeSvg + '</span></span>';
    }
    return '';
  }

  /* Build the small badges shown above the body (direction, to:, replying to). */
  _postBadges(post) {
    return {
      dirBadge: post.direction
        ? `<span class="dir-badge dir-${post.direction}">${post.direction === 'sent' ? '↑ sent' : '↓ received'}</span>`
        : '',
      toLabel: (post.direction === 'sent' && post.to)
        ? `<span class="to-label">To: ${this.trunc(post.to)}</span>`
        : '',
      replyBadge: post.parentTx
        ? `<span class="reply-badge">↳ Replying to ${this._replyBadgeLabel(post.parentTx)}</span>`
        : '',
    };
  }

  /* Reply badge text: prefer the parent author's @username (cache-only, no
     fetch), then the parent author's truncated address if known-but-unnamed,
     finally the truncated parent-tx hash if the parent isn't cached at all. */
  _replyBadgeLabel(parentTx) {
    const parent = this._postMap.get(parentTx) || this._parentCache?.get(parentTx);
    if (parent && parent.reporter) {
      const name = this.state.profCache[parent.reporter]?.username;
      return '@' + utils.safe(name || this.trunc(parent.reporter));
    }
    return this.trunc(parentTx);
  }

  /* Standard action bar (reply / repost / like / views / bookmark / share).
     Shared by the feed's postHTML and the thread hero so the markup — and
     the data-action contract the feed delegation depends on — never
     drifts between them. */
  _postActionsHTML(post, replyMap, likeMap, repostMap, engagerMap) {
    const rc  = replyMap  ? (replyMap.get(post.txHash)  || 0) : 0;
    const lc  = likeMap   ? (likeMap.get(post.txHash)   || 0) : 0;
    const rpc = repostMap ? (repostMap.get(post.txHash) || 0) : 0;
    const rcLabel  = rc  > 0 ? String(rc)  : '';
    const lcLabel  = lc  > 0 ? String(lc)  : '';
    const rpcLabel = rpc > 0 ? String(rpc) : '';
    const isLiked      = this.state.likes.has(post.txHash);
    const isBookmarked = this.state.bookmarks.has(post.txHash);
    const engagementHTML = this._postEngagementHTML(post, engagerMap);
    return `
          <div class="post-actions">
            <div class="post-actions-left">
            <button class="act-btn act-reply" data-action="reply" title="Reply" aria-label="Reply to this post">
              <span class="act-icon">${this.icon('ic-reply')}</span>
              <span class="act-count">${rcLabel}</span>
            </button>
            <button class="act-btn act-repost" data-action="repost" title="Repost or Quote" aria-label="Repost or quote">
              <span class="act-icon">${this.icon('ic-repost')}</span>
              <span class="act-count">${rpcLabel}</span>
            </button>
            <button class="act-btn act-like ${isLiked ? 'liked' : ''}" data-action="like" title="${isLiked ? 'Unlike' : 'Like'}" aria-label="${isLiked ? 'Unlike this post' : 'Like this post'}" aria-pressed="${isLiked ? 'true' : 'false'}">
              <span class="act-icon">${this.icon(isLiked ? 'ic-heart-full' : 'ic-heart-empty')}</span>
              <span class="act-count">${lcLabel}</span>
            </button>
            ${engagementHTML}
            </div><!-- /.post-actions-left -->
            <div class="post-actions-right">
            <button class="act-btn act-bookmark ${isBookmarked ? 'bookmarked' : ''}" data-action="bookmark" title="${isBookmarked ? 'Remove bookmark' : 'Bookmark'}" aria-label="${isBookmarked ? 'Remove bookmark' : 'Bookmark this post'}" aria-pressed="${isBookmarked ? 'true' : 'false'}">
              <span class="act-icon">${this.icon(isBookmarked ? 'ic-bookmark-full' : 'ic-bookmark-empty')}</span>
            </button>
            <button class="act-btn act-share" data-action="share" title="Share" aria-label="Share this post">
              <span class="act-icon">${this.icon('ic-share')}</span>
            </button>
            </div><!-- /.post-actions-right -->
          </div><!-- /.post-actions -->`;
  }

  /* A small chain-origin pill for a post (e.g. "ETH", "BASE"). Dormant in the
     common single-chain case: returns '' unless the post is from a non-canonical
     chain OR more than one chain is enabled — so nothing changes visually until
     multichain reads are turned on. The pill is color-coded per the registry and
     links to the post's chain explorer page for its tx. */
  _chainBadge(post) {
    const cid = Number(post?.chainId) || CANONICAL_CHAIN_ID;
    const multi = chainList({ enabledOnly: true }).length > 1;
    if (!multi && cid === CANONICAL_CHAIN_ID) return '';
    return `<span class="chain-badge" style="--chain-color:${chainColor(cid)}"
      title="Posted on ${utils.safe(chainName(cid))}">${utils.safe(chainBadge(cid))}</span>`;
  }

  postHTML(post, inModal, replyMap, likeMap, repostMap, engagerMap = null) {
    this._reviveSpace(post);
    const expanded = this.state.expanded.has(post.txHash);
    /* Profile + verified badge (own profile vs. cached other-user profile) */
    const { picUrl, displayName, verifiedBadge, hasProfile } = this._postProfileFields(post);
    /* Posts whose tx input is binary/non-text: flag + de-emphasize, and use a
       much shorter preview so they don't dominate the feed (still expandable). */
    const nonText = this._isLikelyBinary(post.display);
    const previewLimit = nonText ? 140 : MAX_PREVIEW;
    /* Binary payloads: never show the raw bytes in the collapsed feed view —
       the mojibake under the warning label reads as a rendering bug. Show
       the label alone; "Show more" still expands to the raw payload. */
    const hideBinary = nonText && !inModal && !expanded;
    /* In-body link to another SayIt post → render it as a quote card and strip
       the URL from the displayed text. Strips BEFORE truncation so a long URL
       can't eat the preview. post.content/display are never mutated. */
    const displayText = this._applyLinkQuote(post);
    /* Body text + image extraction. Always run linkify on full text so
       media below the preview cap still renders in the feed. */
    const textToRender = hideBinary ? ''
      : (!inModal && !expanded && displayText.length > previewLimit)
        ? displayText.slice(0, previewLimit) + '…'
        : displayText;
    const { text: bodyHtml, images: imgHtml, embeds: embedHtml } = utils.linkify(textToRender, displayText);
    const isLong     = !inModal && (nonText || displayText.length > previewLimit);
    const needsMore  = isLong && !expanded;
    const canCollapse = isLong && expanded;
    /* Repost / quote card + badges */
    const repostCard = this._postRepostCard(post);
    const { dirBadge, toLabel, replyBadge } = this._postBadges(post);
    /* X-style conversation module: a reply shown in a FEED carries its
       parent post above it, joined by a thread line — the "Replying to"
       badge is redundant then. Thread pages render their own chain
       (inModal=true there), so this only applies to feed surfaces. */
    let parentModule = '';
    const showParent = !inModal && !!post.parentTx;
    /* Thread rows (inModal) for direct replies under the focal post would
       otherwise show "↳ Replying to <focal>" — redundant on the thread page
       (X shows nothing there). Suppress just that case. */
    const suppressReplyBadge = inModal && this.state.mode === 'thread'
      && post.parentTx === this._threadFocalHash;
    if (showParent) {
      const parent = this._postMap.get(post.parentTx) || this._parentCache?.get(post.parentTx);
      if (parent) {
        parentModule = `<div class="feed-parent-item" data-txhash="${utils.safe(parent.txHash)}">${this.postHTML(parent, true, replyMap, likeMap, repostMap, engagerMap)}</div>`;
      } else {
        parentModule = `<div class="feed-parent-item feed-parent-missing" data-fp="${utils.safe(post.parentTx)}" data-txhash="${utils.safe(post.parentTx)}">
          <span class="spinner sp-sm" aria-hidden="true"></span><span style="color:var(--muted);font-size:13px">Loading post…</span>
        </div>`;
        this._hydrateFeedParent(post.parentTx);
      }
    }
    const fullDate = new Date(post.timestamp).toLocaleString();
    const relT     = this.relTime(post.timestamp);

    return `${parentModule}
      <div class="post-hdr">
        <a class="post-avatar-link" href="#/profile/${utils.safe(post.reporter)}"
          aria-label="View profile" tabindex="-1"><img src="${utils.safe(picUrl)}" class="post-avatar" alt=""
          loading="lazy" data-fallback-src="image1.jpeg"></a>
        <button class="post-menu-btn post-tip-btn" data-action="tip" title="Tip PLS"
          aria-label="Tip the author">💎</button>
        <button class="post-menu-btn" data-action="menu" title="More options"
          aria-label="More options" aria-haspopup="menu" aria-expanded="false">${this.icon('ic-menu')}</button>
        <div class="post-col">
          <div class="post-meta-row">
            <a class="post-name" href="#/profile/${utils.safe(post.reporter)}">${displayName}</a>${verifiedBadge}
            ${hasProfile ? `<span class="post-dot">·</span>
            <span class="post-handle" role="button" tabindex="0" aria-label="Copy address ${utils.safe(post.reporter)}"
              data-addr="${utils.safe(post.reporter)}"
              title="Click to copy address">@${this.trunc(post.reporter)}</span>` : ''}
            <span class="post-time-dot">·</span>
            <a href="${utils.safe(txUrl(post.chainId, post.txHash))}"
              target="_blank" rel="noopener noreferrer" class="post-time" title="${utils.safe(fullDate)}"
              data-ts="${utils.safe(post.timestamp)}"
             >${utils.safe(relT)}</a>
            ${this._chainBadge(post)}
            ${dirBadge}
          </div>
          ${toLabel}${(showParent || suppressReplyBadge) ? '' : replyBadge}
          ${post.repostOf ? `<div class="repost-label">
            <svg width="14" height="14" style="vertical-align:middle;margin-right:4px" aria-hidden="true"><use href="#ic-repost"/></svg>
            <span class="post-name">${displayName}</span> reposted</div>` : ''}
          <div class="post-body${nonText ? ' is-nontext' : ''}">${nonText ? '<div class="post-nontext">⚠ Non-text content (binary data)</div>' : ''}${bodyHtml}</div>
          ${post.poll ? this._pollHTML(post) : ''}
          ${post.space ? this._spaceCardHTML(post) : ''}
          ${repostCard}
          ${embedHtml || ''}
          <div class="note-slot" data-note-host="${utils.safe(post.txHash)}">${this._noteHTML(post)}</div>
          ${needsMore ? `<button class="read-more-btn" data-action="expand">Show more ↓</button>` : ''}
          ${canCollapse ? `<button class="read-more-btn" data-action="expand">Show less ↑</button>` : ''}
          ${imgHtml ? `<div class="post-images">${imgHtml}</div>` : ''}
          ${this._postActionsHTML(post, replyMap, likeMap, repostMap, engagerMap)}
        </div>
      </div>`;
  }

  openPollComposer() {
    if (!this.signer) { utils.toast('Connect wallet to create a poll'); return; }
    this._showGenericModal('Create a poll', `
      <div style="margin-bottom:12px">
        <input type="text" class="form-input" id="poll-q" placeholder="Ask a question…" maxlength="200">
      </div>
      <div id="poll-opts">
        <input type="text" class="form-input poll-opt" placeholder="Option 1" maxlength="60" style="margin-bottom:8px">
        <input type="text" class="form-input poll-opt" placeholder="Option 2" maxlength="60" style="margin-bottom:8px">
      </div>
      <button class="btn-ghost" id="poll-add-opt" style="font-size:13px;padding:6px 12px;margin-bottom:12px">+ Add option</button>
      <div style="margin-bottom:12px">
        <label style="font-size:13px;color:var(--muted);display:block;margin-bottom:4px">Poll length</label>
        <select class="settings-btn" id="poll-duration" style="padding:9px 12px;width:100%">
          <option value="60">1 hour</option>
          <option value="360">6 hours</option>
          <option value="1440" selected>1 day</option>
          <option value="4320">3 days</option>
          <option value="10080">7 days</option>
        </select>
      </div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn-pri" id="poll-create-btn">Post poll</button>
        <button class="btn-ghost" id="poll-cancel-btn">Cancel</button>
      </div>
    `);
    const g = id => document.getElementById(id);
    g('poll-add-opt').onclick = () => {
      const opts = document.querySelectorAll('.poll-opt');
      if (opts.length >= 4) { utils.toast('Maximum 4 options'); return; }
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'form-input poll-opt';
      inp.placeholder = `Option ${opts.length + 1}`;
      inp.maxLength = 60;
      inp.style.marginBottom = '8px';
      g('poll-opts').appendChild(inp);
    };
    g('poll-cancel-btn').onclick = () => this._closeGenericModal();
    g('poll-create-btn').onclick = () => this._createPoll();
  }

  async _createPoll() {
    const g = id => document.getElementById(id);
    const question = g('poll-q')?.value.trim();
    const options = [...document.querySelectorAll('.poll-opt')]
      .map(i => i.value.trim()).filter(Boolean);
    if (!question) { utils.toast('Enter a question'); return; }
    if (options.length < 2) { utils.toast('Add at least 2 options'); return; }
    const mins = Number(g('poll-duration')?.value) || 1440;
    const endMs = Date.now() + mins * 60000;
    /* Compact JSON payload; question duplicated after \n\n for explorer readability. */
    const payload = JSON.stringify({ o: options, e: endMs });
    const body = `${POLL_PREFIX}${payload}\n\n${question}`;
    this._closeGenericModal();
    await this.publish(body);
  }

  /* Estimate gas with a deterministic fallback. A transient node error on
     estimateGas must not block publishing — a data tx's intrinsic cost is
     21000 + ~16 gas per byte; pad generously (×2) for safety. The wallet
     still shows the final fee for user approval. */
  async _estimateGasSafe(txReq, byteLen) {
    try {
      const gas = await this.signer.estimateGas(txReq);
      return (gas * 130n) / 100n;
    } catch (err) {
      console.warn('estimateGas failed — using heuristic fallback', err);
      return BigInt(21000 + Math.ceil(byteLen * 32));
    }
  }

  /* ── Encrypted DMs ──────────────────────────────────────────────────────
     Plumbing for hybrid PQ direct messages (see DMCrypto in core.js). Keys are
     derived from a one-off wallet signature and cached in memory for the
     session. Content is encrypted end-to-end; on-chain metadata stays public. */

  /* Derive + cache this session's DM identity keys (prompts one wallet signature
     the first time). Throws if no wallet or the crypto lib isn't loaded. */
  async _ensureDmKeys() {
    if (this._dmKeys) return this._dmKeys;
    if (!this.signer) throw new Error('Connect your wallet to use encrypted DMs');
    if (!DMCrypto.ready()) throw new Error('Encryption library still loading — try again in a moment');
    const sig = await this.signer.signMessage(DM_SIGN_MESSAGE);
    this._dmKeys = DMCrypto.deriveKeys(sig);
    return this._dmKeys;
  }

  /* Publish this user's public DM key bundle on-chain (one tx to self) so others
     can message them — the "Enable encrypted DMs" action. */
  async enableDms() {
    const keys = await this._ensureDmKeys();
    const payload = DMCrypto.packIdentityKey(keys);
    const hash = await this.publish(payload, null, this.state.signerAddr);
    if (hash) {
      this._dmKeyCache = this._dmKeyCache || {};
      this._dmKeyCache[this.state.signerAddr.toLowerCase()] = { xPublic: keys.xPublic, mlPublic: keys.mlPublic };
    }
    return hash;
  }

  /* Discover a recipient's published DM public-key bundle by scanning their
     address for the most recent DMKEY1: tx. Caches results (incl. negatives). */
  async _getDmKeyFor(addr) {
    addr = (addr || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return null;
    this._dmKeyCache = this._dmKeyCache || {};
    if (addr in this._dmKeyCache) return this._dmKeyCache[addr];
    let found = null;
    const pages = Math.min(this._getMaxScanPages(), 10);
    for (let page = 1; page <= pages && !found; page++) {
      let raw;
      try { raw = await this.apiFetch(addr, page); } catch { break; }
      for (const tx of raw) {
        if (tx.from?.toLowerCase() !== addr || !tx.input || tx.input === '0x') continue;
        let text; try { text = ethers.toUtf8String(tx.input).trim(); } catch { continue; }
        if (text.startsWith(DMKEY_PREFIX)) { const k = DMCrypto.parseIdentityKey(text); if (k) { found = k; break; } }
      }
      if (raw.length < 50) break;
    }
    this._dmKeyCache[addr] = found;
    return found;
  }

  /* Encrypt `text` for `toAddr` and publish it as a DM1: tx. Throws with a
     clear message if the recipient hasn't enabled DMs. */
  async sendDm(toAddr, text) {
    if (!text || !text.trim()) throw new Error('Message cannot be empty');
    const keys = await this._ensureDmKeys();
    const recip = await this._getDmKeyFor(toAddr);
    if (!recip) throw new Error('This account hasn’t enabled encrypted DMs yet');
    const payload = DMCrypto.encrypt(text.trim(), recip, keys, this.state.signerAddr, toAddr);
    return await this.publish(payload, null, toAddr);
  }

  /* Stable group id for a member SET — every member derives the same id, so
     their clients group the conversation together. */
  _dmGroupId(members) {
    const sorted = [...new Set((members || []).map(m => (m || '').toLowerCase()).filter(Boolean))].sort();
    const bytes = window.SAYIT_CRYPTO.sha256(new TextEncoder().encode('SAYIT-DM-group\n' + sorted.join(',')));
    return [...bytes.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /* Send a group message: one encrypted tx per other member (each readable by
     that member + you), all tagged with the shared group id + member list.
     Returns { gid, sent, failed }. Note: M members ⇒ M wallet confirmations. */
  async sendGroupDm(allMembers, text) {
    if (!text || !text.trim()) throw new Error('Message cannot be empty');
    const keys = await this._ensureDmKeys();
    const me = (this.state.signerAddr || '').toLowerCase();
    const members = [...new Set((allMembers || []).map(m => (m || '').toLowerCase()).filter(Boolean))];
    if (!members.includes(me)) members.push(me);
    const recipients = members.filter(m => m !== me);
    if (!recipients.length) throw new Error('Add at least one other member');
    const gid = this._dmGroupId(members);
    const extra = { gid, members };
    let lastHash = null, sent = 0; const failed = [];
    for (const m of recipients) {
      const recip = await this._getDmKeyFor(m);
      if (!recip) { failed.push(m); continue; }
      const payload = DMCrypto.encrypt(text.trim(), recip, keys, me, m, extra);
      const h = await this.publish(payload, null, m);
      if (h) { lastHash = h; sent++; }
    }
    if (!sent) throw new Error('None of the members have enabled encrypted DMs');
    return { gid, hash: lastHash, sent, failed };
  }

  /* Scan the user's txs (BOTH directions) for encrypted DMs, decrypt the ones
     we can (received via the recipient wrap, sent via the self wrap), and group
     by counterparty. Returns [{ addr, messages:[{from,to,text,ts,txHash}], last }]
     newest-first. Requires DM keys (prompts a signature on first use). */
  async _scanDms() {
    const me = (this.state.signerAddr || '').toLowerCase();
    if (!me) return [];
    const keys = await this._ensureDmKeys();
    const byKey = new Map();
    const seen = new Set();
    const pages = Math.min(this._getMaxScanPages(), 10);
    for (let page = 1; page <= pages; page++) {
      let raw;
      try { raw = await this.apiFetch(me, page); } catch { break; }
      for (const tx of raw) {
        const from = tx.from?.toLowerCase(), to = tx.to?.toLowerCase();
        if (!tx.input || tx.input === '0x') continue;
        if (from !== me && to !== me) continue;            /* either side must be me */
        let text; try { text = ethers.toUtf8String(tx.input).trim(); } catch { continue; }
        if (!text.startsWith(DM_PREFIX)) continue;
        const h = tx.hash?.toLowerCase();
        if (h && seen.has(h)) continue; if (h) seen.add(h);
        let msg;
        try { msg = DMCrypto.decrypt(text, keys, from, to); } catch { continue; } /* not for us / tampered */
        const ts = tx.timeStamp ? Number(tx.timeStamp) * 1000 : (msg.ts || Date.now());
        /* Group messages (msg.gid) collapse across their per-member txs into one
           conversation; 1:1 messages group by the other party. */
        const key = msg.gid ? 'g:' + msg.gid : (from === me ? to : from);
        if (!byKey.has(key)) byKey.set(key, { msgs: [], members: msg.members || null });
        const conv = byKey.get(key);
        if (msg.members && !conv.members) conv.members = msg.members;
        conv.msgs.push({ from, to, text: msg.text, ts, txHash: h });
      }
      if (raw.length < 50) break;
    }
    return [...byKey.entries()]
      .map(([key, c]) => {
        /* Dedup group messages by tx hash (the same logical message arrives once
           per member; on your own account you only see your copies, but guard
           anyway). */
        const seenMsg = new Set();
        const messages = c.msgs.filter(m => { if (m.txHash && seenMsg.has(m.txHash)) return false; if (m.txHash) seenMsg.add(m.txHash); return true; });
        messages.sort((a, b) => a.ts - b.ts);
        const isGroup = key.startsWith('g:');
        return { id: key, addr: isGroup ? null : key, isGroup, members: c.members,
          messages, last: messages[messages.length - 1]?.ts || 0 };
      })
      .sort((a, b) => b.last - a.last);
  }

  /* ── Messages UI (encrypted DMs) — X-style two-column, reusing the Channels
     ch-layout + rail-collapse. Content is E2E encrypted; the header note makes
     the public-metadata caveat explicit. ─────────────────────────────────── */
  /* Messages now live inside the Chat page under the "Messages" toggle —
     this just opens Chat on that tab (optionally deep-linked to a peer). */
  goMessages(peerAddr = null) {
    this._dmPeer = peerAddr ? peerAddr.toLowerCase() : null;
    return this.goChannels('messages');
  }

  /* "Not Grok" — placeholder page for our future on-chain AI assistant. */
  goNotGrok() {
    this._updateTitle('Not Grok');
    this._setRoute('/notgrok');
    this.setNav('nav-notgrok', null);
    this.state.mode = 'notgrok';
    this.g('compose-area').style.display   = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('feed-tabs').style.display      = 'none';
    this.g('loading-more').style.display   = 'none';
    this._pendingPageHeader = this._makePageHeader({ title: 'Not Grok', noBack: true });
    this.g('feed').innerHTML = this._applyPageHeader() + `
      <div class="prof-empty" style="padding:52px 24px">
        <span style="font-size:42px">✨</span>
        <h3>Not Grok — coming soon</h3>
        <p style="color:var(--muted);max-width:400px;margin:8px auto 0;line-height:1.6">
          Our own on-chain AI assistant will live here. (Yes, the name's a joke — for now.)
          It'll help you draft posts, summarize threads, and explore PulseChain without leaving Say&nbsp;It.</p>
      </div>`;
  }


  async publish(content, parentTx = null, toAddress = null, chainId = CANONICAL_CHAIN_ID) {
    if (!this.signer)     { utils.toast('Connect wallet first'); return false; }
    if (!content?.trim()) { utils.toast('Message cannot be empty'); return false; }
    /* Guard the chain: switch the wallet to the target chain (default = the
       canonical chain, so every existing caller is unchanged). The composer
       passes the user's chosen chain; replies pass the parent post's chain. */
    if (!(await this._ensureOnChain(chainId))) return false;
    let body = content.trim();
    /* No character limit — users can post articles, essays, or books.
       The feed truncates long posts with a "Show more" expand link. */
    if (parentTx) body = `${REPLY_PREFIX}${parentTx}\n\n${body}`;
    const to = toAddress || this.state.channel;
    /* Non-blocking: no full-screen overlay. The wallet's own signing UI
       covers the confirmation step; after that the user can keep using
       the app while the tx mines. Toasts report the outcome. */
    try {
      const bytes   = ethers.toUtf8Bytes(body);
      const data    = ethers.hexlify(bytes);
      const txReq   = { to, value: '0', data };
      const gas     = await this._estimateGasSafe(txReq, bytes.length);
      const tx      = await this.signer.sendTransaction({ ...txReq, gasLimit: gas });
      utils.toast('Submitting to chain… you can keep browsing');
      const receipt = await tx.wait();
      const hash    = receipt.hash.toLowerCase(); /* v6: transactionHash → hash */
      /* Only insert an optimistic feed row for genuine feed content (plain
         post, reply, repost/quote, poll). Exclude every non-feed prefix —
         VOTE/NOTERATE/PROFILE_FOR/NOTE/LC_SYNC were missing, so those showed
         up as a bogus "post" after publishing. */
      if (!body.startsWith(PROFILE_PREFIX) &&
          !body.startsWith(LIKE_PREFIX) &&
          !body.startsWith(UNLIKE_PREFIX) &&
          !body.startsWith(BOOKMARK_PREFIX) &&
          !body.startsWith(UNBOOKMARK_PREFIX) &&
          !body.startsWith(FOLLOW_PREFIX) &&
          !body.startsWith(UNFOLLOW_PREFIX) &&
          !body.startsWith(VOTE_PREFIX) &&
          !body.startsWith(NOTERATE_PREFIX) &&
          !body.startsWith(TOKEN_PROFILE_PREFIX) &&
          !body.startsWith(NOTE_PREFIX) &&
          !body.startsWith(SPACE_END_PREFIX) &&
          !body.startsWith(PIN_PREFIX) &&
          !body.startsWith(UNPIN_PREFIX) &&
          !body.startsWith(DM_PREFIX) &&       /* encrypted DM — never a feed post */
          !body.startsWith(DMKEY_PREFIX) &&    /* DM key publication — never a feed post */
          !body.startsWith(LC_SYNC_PREFIX)) {
        /* If this is a poll, parse it so the feed renders the poll UI
           rather than the raw POLL:{json} text. */
        const parsedPoll = body.startsWith(POLL_PREFIX) ? this._parsePoll(body) : null;
        const post = {
          content: body,
          display: parsedPoll ? parsedPoll.question : content.trim(),
          parentTx, direction: null, repostOf: null,
          poll: parsedPoll,
          postType: parsedPoll ? 'poll' : 'post',
          reporter: this.state.signerAddr, to: to.toLowerCase(),
          timestamp: new Date().toISOString(),
          txHash: hash, channel: this.state.channel, mode: this.state.mode,
          chainId: Number(chainId) || CANONICAL_CHAIN_ID,
        };
        this.state.posts.unshift(post);
        /* Add to the dedup set so the next poll doesn't treat our own
           just-published post as "new" and create a duplicate row. */
        if (this._postHashSet) this._postHashSet.add(hash);
        await this.cache.savePosts([post]);
        this.renderFeed();
      }
      utils.toast(`Published ✓  ${this.trunc(hash)}`);
      return hash; /* truthy; callers that need the tx hash (Spaces) use it */
    } catch (err) {
      const msg = err.reason || err.message || 'Unknown error';
      /* Detect user rejection (MetaMask "user rejected transaction" or
         EIP-1193 code 4001 / 'ACTION_REJECTED'). Show a friendly toast
         instead of dumping the raw error string. */
      const isRejection = err.code === 4001 ||
        err.code === 'ACTION_REJECTED' ||
        /user (denied|rejected)/i.test(msg) ||
        /rejected (the )?(transaction|request)/i.test(msg);
      if (isRejection) {
        utils.toast('Transaction cancelled');
        return false;
      }
      /* On network errors, save to offline queue so we can retry later */
      const isOffline = !navigator.onLine || msg.includes('network') ||
        msg.includes('timeout') || msg.includes('fetch');
      if (isOffline) {
        /* Don't queue reactions/control txs (like/unlike/follow/bookmark/vote/
           note/profile) — they're fire-and-forget, and a stale retry after the
           original actually mined would duplicate the tx / double gas. Only
           real posts/replies/quotes/polls are worth re-sending. */
        const isReaction = [LIKE_PREFIX, UNLIKE_PREFIX, FOLLOW_PREFIX, UNFOLLOW_PREFIX,
          BOOKMARK_PREFIX, UNBOOKMARK_PREFIX, VOTE_PREFIX, NOTERATE_PREFIX,
          PROFILE_PREFIX, TOKEN_PROFILE_PREFIX, NOTE_PREFIX, LC_SYNC_PREFIX]
          .some(p => body.startsWith(p));
        if (isReaction) { utils.toast('Network error — please try again'); return false; }
        const queueId = `pq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const queued = {
          queueId, content, parentTx, toAddress: toAddress || this.state.channel,
          channel: this.state.channel, mode: this.state.mode,
          signerAddr: this.state.signerAddr,
          queuedAt: new Date().toISOString(),
        };
        try {
          await this.cache.savePendingPost(queued);
          /* Show as pending in the feed immediately */
          this._showPendingInFeed(queued);
          utils.toast('⏳ Saved offline — will retry when reconnected');
        } catch { utils.toast('Failed: ' + msg); }
      } else {
        utils.toast('Failed: ' + msg);
      }
      return false;
    }
  }

  /* The chain a composer should post to: its selector value, falling back to
     the user's default chain (or canonical). */
  _composerChainFrom(selId) {
    const el = this.g(selId);
    const v  = el ? Number(el.value) : NaN;
    if (v && chainCfg(v)) return v;
    return Number(this._getSettings().defaultChain) || CANONICAL_CHAIN_ID;
  }

  /* Populate + show the composer "posting to" selectors. Only shown when the
     user has >1 chain enabled; otherwise hidden (single-chain users see no
     change). Default selection = the user's default chain. */
  _initComposerChains() {
    const enabled = (this._getSettings().enabledChains || [])
      .map(Number).filter(id => id !== CANONICAL_CHAIN_ID && chainCfg(id));
    const ids = [CANONICAL_CHAIN_ID, ...enabled];
    const def = Number(this._getSettings().defaultChain) || CANONICAL_CHAIN_ID;
    ['compose-chain', 'modal-compose-chain'].forEach(selId => {
      const el = this.g(selId);
      if (!el) return;
      if (ids.length <= 1) { el.hidden = true; el.innerHTML = ''; return; }
      el.innerHTML = ids.map(id =>
        `<option value="${id}"${id === def ? ' selected' : ''}>${utils.safe(chainName(id))}</option>`).join('');
      el.hidden = false;
    });
  }

  async publishPost(chainId) {
    const text = this.g('compose-text').value.trim();
    if (!text) return false;
    const cid = chainId != null ? chainId : this._composerChainFrom('compose-chain');
    /* Disable the Post button during the publish round-trip so users can't
       double-click and fire two transactions. Re-enable in finally. */
    const btn = this.g('post-btn');
    if (btn) btn.disabled = true;
    try {
      const ok = await this.publish(text, null, null, cid);
      if (ok) {
        this.g('compose-text').value = '';
        this.g('compose-text').style.height = '';
        utils.updateCharCount(this.g('compose-text'), null);
        this._clearDraft();
      }
      return ok;
    } finally {
      /* Re-derive from content: empty after a successful post → stays disabled;
         still has text after a failure → re-enabled so the user can retry. */
      this._syncPostBtn();
    }
  }

  /* Enable the Post buttons only when their compose box has content. */
  _syncPostBtn() {
    const pb = this.g('post-btn');
    if (pb) pb.disabled = !this.g('compose-text')?.value.trim();
    const mpb = this.g('modal-post-btn');
    if (mpb) mpb.disabled = !this.g('modal-compose-text')?.value.trim();
  }

  /* Point the Profile nav link at the connected wallet's page so right-click /
     middle-click / ⌘-click can open it in a new tab. */
  _syncNavLinks() {
    const a = this.state.signerAddr;
    const pr = this.g('nav-profile');
    if (pr) { if (a) pr.href = '#/profile/' + a; else pr.removeAttribute('href'); }
  }

  openReplyModal(post) {
    this.state.replyTarget = post;
    const preview = post.display.length > 120 ? post.display.slice(0, 120) + '…' : post.display;
    this.g('reply-quote').textContent  = `↳ ${this.trunc(post.reporter)}: "${preview}"`;
    this.g('reply-input').value        = '';
    this.g('reply-input').style.height = '';
    this.g('reply-count').textContent  = '';
    this.g('reply-modal').classList.add('open');
    this._trapFocus(this.g('reply-modal'));
    this.g('reply-input').focus();
  }

  /* ── Like ───────────────────────────────────────────────────────────── */
  /* In-flight reaction guard: a second tap on like/bookmark/follow/repost
     while the first tx is still in the wallet round-trip would read the
     already-flipped optimistic state and fire the OPPOSITE action (e.g. LIKE
     then UNLIKE), wasting gas. _reactionBusy(key) returns true (and reserves
     the key) if free, false if already in flight. */
  _reactionBusy(key) {
    this._pendingTx ??= new Set();
    if (this._pendingTx.has(key)) return false;
    this._pendingTx.add(key);
    return true;
  }

  /* The social chain to port engagement (likes/reposts) to: the user's default
     chain if it can host engagement, else the canonical chain (always social). */
  _engagementChain() {
    const def = Number(this._getSettings().defaultChain) || CANONICAL_CHAIN_ID;
    return chainCfg(def)?.social ? def : CANONICAL_CHAIN_ID;
  }

  /* Where a like/repost for `post` should be recorded:
     - the post's OWN chain when that chain is cheap (social) — native, bare ref;
     - otherwise the user's social chain — ported, with a chain-qualified ref
       (LIKE:eip155:<postChainId>:<hash>) so it still names the target post.
     Counts aggregate either way (utils.refHash collapses both to the hash). */
  _engagementRouteFor(post) {
    const postChain = Number(post?.chainId) || CANONICAL_CHAIN_ID;
    if (chainCfg(postChain)?.social) return { chainId: postChain, qualified: false };
    return { chainId: this._engagementChain(), qualified: true };
  }

  /* Build the engagement ref for a post — chain-qualified only when ported. */
  _engagementRef(post, route) {
    const hash = post.txHash;
    return route.qualified ? `eip155:${Number(post.chainId) || CANONICAL_CHAIN_ID}:${hash}` : hash;
  }

  /* Repost/quote ref for an original post — chain-qualified when the original
     lives on a non-canonical chain, so the quote card can fetch it from the
     right chain. Unqualified means the original is on the canonical chain
     (back-compatible with every pre-multichain repost). */
  _repostRef(post) {
    const cid = Number(post?.chainId) || CANONICAL_CHAIN_ID;
    return cid === CANONICAL_CHAIN_ID ? post.txHash : `eip155:${cid}:${post.txHash}`;
  }

  async toggleLike(post, itemEl) {
    if (!this.signer) { utils.toast('Connect wallet to like posts'); return; }
    const hash = post.txHash;
    if (!this._reactionBusy('like:' + hash)) return;
    try {
      const btn  = itemEl.querySelector('[data-action="like"]');
      const icon = btn?.querySelector('.act-icon');
      const heartFull  = this.icon('ic-heart-full');
      const heartEmpty = this.icon('ic-heart-empty');
      /* Optimistic like count — bump the .act-count immediately, revert on fail. */
      const countEl = btn?.querySelector('.act-count');
      const bump = d => { if (!countEl) return; const c = (parseInt(countEl.textContent, 10) || 0) + d; countEl.textContent = c > 0 ? String(c) : ''; };
      const destination = post.to || this.state.channel;
      /* Route engagement: native on cheap chains, ported to the user's social
         chain (chain-qualified ref) for expensive ones. */
      const route = this._engagementRouteFor(post);
      const ref   = this._engagementRef(post, route);
      if (this.state.likes.has(hash)) {
        /* Toggle off — publish UNLIKE so the change persists across sessions.
           Optimistic UI: remove immediately, revert on tx failure. */
        this.state.likes.delete(hash);
        if (btn)  btn.classList.remove('liked');
        if (icon) icon.innerHTML = heartEmpty;
        bump(-1);
        const ok = await this.publish(UNLIKE_PREFIX + ref, null, destination, route.chainId);
        if (!ok) {
          this.state.likes.add(hash);
          if (btn)  btn.classList.add('liked');
          if (icon) icon.innerHTML = heartFull;
          bump(1);
        } else {
          utils.toast('Like removed on-chain');
        }
      } else {
        this.state.likes.add(hash);
        if (btn)  btn.classList.add('liked');
        if (icon) icon.innerHTML = heartFull;
        bump(1);
        const ok = await this.publish(LIKE_PREFIX + ref, null, destination, route.chainId);
        if (!ok) {
          this.state.likes.delete(hash);
          if (btn)  btn.classList.remove('liked');
          if (icon) icon.innerHTML = heartEmpty;
          bump(-1);
        } else {
          utils.toast('Liked on-chain');
        }
      }
    } finally {
      this._pendingTx.delete('like:' + hash);
    }
  }

  /* ── Bookmark ───────────────────────────────────────────────────────── */
  async toggleBookmark(post, itemEl) {
    if (!this.signer) { utils.toast('Connect wallet to bookmark posts'); return; }
    const hash = post.txHash;
    if (!this._reactionBusy('bookmark:' + hash)) return;
    try {
      const btn  = itemEl.querySelector('[data-action="bookmark"]');
      const icon = btn?.querySelector('.act-icon');
      const bmFull  = this.icon('ic-bookmark-full');
      const bmEmpty = this.icon('ic-bookmark-empty');
      if (this.state.bookmarks.has(hash)) {
        /* Toggle off — publish UNBOOKMARK so the change persists. */
        this.state.bookmarks.delete(hash);
        if (btn)  btn.classList.remove('bookmarked');
        if (icon) icon.innerHTML = bmEmpty;
        const ok = await this.publish(UNBOOKMARK_PREFIX + hash, null, this.state.signerAddr);
        if (!ok) {
          this.state.bookmarks.add(hash);
          if (btn)  btn.classList.add('bookmarked');
          if (icon) icon.innerHTML = bmFull;
        } else {
          utils.toast('Bookmark removed on-chain');
        }
      } else {
        this.state.bookmarks.add(hash);
        if (btn)  btn.classList.add('bookmarked');
        if (icon) icon.innerHTML = bmFull;
        const ok = await this.publish(BOOKMARK_PREFIX + hash, null, this.state.signerAddr);
        if (!ok) {
          this.state.bookmarks.delete(hash);
          if (btn)  btn.classList.remove('bookmarked');
          if (icon) icon.innerHTML = bmEmpty;
        } else {
          utils.toast('Bookmarked on-chain');
        }
      }
    } finally {
      this._pendingTx.delete('bookmark:' + hash);
    }
  }

  /* ── Pinned post (X parity) ──────────────────────────────────────────────
     Your pin is a self-sent PIN:0x<hash> tx; UNPIN clears it. We mirror the
     bookmark target (this.state.signerAddr) and track the current pin
     optimistically in localStorage (sayitMyPin:<addr>) so the profile renders
     it instantly without re-scanning. On-chain remains the source of truth —
     the profile scan reconciles last-action-wins. */
  _myPinKey() {
    return this.state.signerAddr ? `sayitMyPin:${this.state.signerAddr}` : null;
  }

  _getMyPin() {
    if (this._myPin !== undefined) return this._myPin;
    const key = this._myPinKey();
    this._myPin = key ? (utils.safeLS.get(key, '') || null) : null;
    return this._myPin;
  }

  _setMyPin(hash) {
    this._myPin = hash || null;
    const key = this._myPinKey();
    if (!key) return;
    if (hash) utils.safeLS.set(key, hash);
    else      utils.safeLS.remove(key);
  }

  async togglePin(post) {
    if (!this.signer) { utils.toast('Connect wallet to pin posts'); return; }
    if (post.reporter !== this.state.signerAddr) { utils.toast('You can only pin your own posts'); return; }
    const hash = post.txHash;
    if (!this._reactionBusy('pin:' + hash)) return;
    try {
      const isPinned = this._getMyPin() === hash;
      const prefix = isPinned ? UNPIN_PREFIX : PIN_PREFIX;
      const ok = await this.publish(prefix + hash, null, this.state.signerAddr);
      if (!ok) return;
      this._setMyPin(isPinned ? null : hash);
      utils.toast(isPinned ? 'Unpinned from your profile' : '📌 Pinned to your profile');
      /* If we're looking at our own profile Posts tab, re-render so the pin
         surfaces / clears immediately. */
      if (this.state.mode === 'profile'
          && this.state.channel?.toLowerCase() === this.state.signerAddr
          && this._profilePageState?.tab === 'posts') {
        this.loadProfileTab(this.state.signerAddr, true, 'posts');
      }
    } finally {
      this._pendingTx.delete('pin:' + hash);
    }
  }

  /* ── Repost / Quote (X-style) ────────────────────────────────────────── */

  /* Show the two-option repost menu: instant repost OR quote post */
  openRepostChoice(post, anchorEl) {
    /* Close any existing menu */
    const existing = document.querySelector('.repost-choice-menu');
    if (existing) { existing.remove(); return; }

    const menu = document.createElement('div');
    menu.className = 'repost-choice-menu post-menu-dropdown open';
    menu.innerHTML = `
      <div class="post-menu-item" id="rc-repost">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path fill="currentColor" d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46L19.5 20.12l-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"/>
        </svg>
        <span>Repost</span>
      </div>
      <div class="post-menu-item" id="rc-quote">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path fill="currentColor" d="M19.75 2H4.25C3.01 2 2 3.01 2 4.25v15.5C2 20.99 3.01 22 4.25 22h15.5c1.24 0 2.25-1.01 2.25-2.25V4.25C22 3.01 20.99 2 19.75 2zM11.5 17.5h-7v-1.5l2-2H4.5V10h7v7zm7 0h-7v-1.5l2-2H11.5V10h7v7z"/>
        </svg>
        <span>Quote Post</span>
      </div>`;

    document.body.appendChild(menu);

    /* Position below the repost button */
    const rect = anchorEl ? anchorEl.getBoundingClientRect()
      : { left: window.innerWidth/2 - 110, bottom: window.innerHeight/2, top: window.innerHeight/2 - 40 };
    const mw = menu.offsetWidth  || 220;
    const mh = menu.offsetHeight || 100;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left, top;
    if (anchorEl) {
      /* Align menu's left edge with button; clamp to viewport */
      left = rect.left;
      top  = rect.bottom + 6;
      /* Flip above if it would overflow bottom */
      if (top + mh > vh - 8) top = rect.top - mh - 6;
      /* Keep fully within horizontal bounds */
      if (left + mw > vw - 8) left = vw - mw - 8;
      if (left < 8) left = 8;
    } else {
      /* Keyboard trigger / no anchor — center in viewport */
      left = Math.max(8, (vw - mw) / 2);
      top  = Math.max(8, (vh - mh) / 2);
    }
    /* Final clamp — guarantees menu is never off-screen on any device */
    left = Math.min(left, vw - mw - 8);
    top  = Math.min(top,  vh - mh - 8);
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top  = Math.max(8, top)  + 'px';

    /* Wire actions */
    menu.querySelector('#rc-repost').onclick = async e2 => {
      e2.stopPropagation();
      menu.remove();
      /* Instant repost — no text, no modal */
      if (!this.signer) { utils.toast('Connect wallet to repost'); return; }
      if (!this._reactionBusy('repost:' + post.txHash)) return;
      try {
        /* Publish on the user's default chain; the ref is chain-qualified when
           the original lives elsewhere, so the quote card can locate it. */
        const cid = Number(this._getSettings().defaultChain) || CANONICAL_CHAIN_ID;
        const ok = await this.publish(`REPOST:${this._repostRef(post)}`, null, null, cid);
        if (ok) utils.toast('Reposted');
      } finally {
        this._pendingTx.delete('repost:' + post.txHash);
      }
    };
    menu.querySelector('#rc-quote').onclick = e2 => {
      e2.stopPropagation();
      menu.remove();
      this.openQuoteModal(post);
    };

    /* Close on outside click */
    setTimeout(() => {
      const close = e2 => {
        if (!menu.contains(e2.target)) {
          menu.remove();
          document.removeEventListener('click', close, true);
        }
      };
      document.addEventListener('click', close, true);
    }, 0);
  }

  /* Open the quote compose modal with the quoted post card */
  openQuoteModal(post) {
    if (!this.signer) { utils.toast('Connect wallet to quote'); return; }
    this.state.repostTarget = post;
    /* Build a full quoted card in the modal */
    const c       = this.state.profCache[post.reporter];
    const name    = c?.username ? utils.safe(c.username) : this.trunc(post.reporter);
    const pic     = utils.safe(utils.safeUrl(c?.picUrl) || 'image1.jpeg');
    const preview = utils.safe(post.display.slice(0, 200) + (post.display.length > 200 ? '…' : ''));
    const relT    = this.relTime(post.timestamp);
    this.g('repost-quote').innerHTML = `
      <div class="quote-card-preview">
        <div class="repost-card-hdr">
          <img src="${pic}" class="repost-card-avatar" alt="" data-fallback-src="image1.jpeg">
          <span class="repost-card-name">${name}</span>
          <span style="color:var(--muted);font-size:13px;margin-left:4px">· ${relT}</span>
        </div>
        <div class="repost-card-body">${preview}</div>
      </div>`;
    /* Change modal title to "Quote Post" */
    const title = this.g('repost-modal').querySelector('.modal-title');
    if (title) title.textContent = 'Quote Post';
    const btn = this.g('post-repost-btn');
    if (btn) btn.textContent = 'Quote';
    this.g('repost-input').value        = '';
    this.g('repost-input').style.height = '';
    this.g('repost-modal').classList.add('open');
    this._trapFocus(this.g('repost-modal'));
    this.g('repost-input').focus();
  }

  /* openRepostModal: redirects to quote flow (keyboard shortcut T and legacy callers) */
  openRepostModal(post) { this.openQuoteModal(post); }

  async postRepost() {
    if (!this.state.repostTarget) return;
    const comment = this.g('repost-input').value.trim();
    if (!comment) { utils.toast('Add some text to quote this post'); return; }
    /* Quote format: REPOST:{ref}\n\n{comment}. A quote is a fresh post →
       publish on the user's default chain; the ref is chain-qualified when the
       original lives on another chain so the quote card can locate it. */
    const content = `REPOST:${this._repostRef(this.state.repostTarget)}\n\n${comment}`;
    const cid = Number(this._getSettings().defaultChain) || CANONICAL_CHAIN_ID;
    const ok = await this.publish(content, null, null, cid);
    if (ok) {
      this.closeModal('repost-modal');
      this.g('repost-input').value = '';
      utils.toast('Quoted on-chain');
    }
  }

  async postReply() {
    const text = this.g('reply-input').value.trim();
    if (!text || !this.state.replyTarget) return;
    /* Replies stay NATIVE — published on the parent post's own chain (the same
       channel address exists on every EVM chain), so the thread stays on-chain
       where the post lives. */
    const cid = Number(this.state.replyTarget.chainId) || CANONICAL_CHAIN_ID;
    const ok = await this.publish(text, this.state.replyTarget.txHash, this.state.replyTarget.to, cid);
    if (ok) { this.closeModal('reply-modal'); this.g('reply-input').value = ''; }
  }

  /* Open a quoted post by hash. Tries _postMap first; if not there,
     looks in IDB; if still not there, fetches from chain. The placeholder
     card click landed us here because _postMap may have been cleared by
     navigation since the card was rendered. */
  async _openQuotedPost(hash, channelHint) {
    if (!hash) return;
    const inMap = this._postMap.get(hash);
    if (inMap) { this.openThread(inMap); return; }
    /* Try IDB cache */
    try {
      const cached = await this.cache.getPost(hash);
      if (cached) {
        this._postMap.set(hash, cached);
        this.openThread(cached);
        return;
      }
    } catch { /* IDB miss — fall through to chain fetch */ }
    /* Last resort: fetch from chain on the channel hint */
    if (!channelHint) { utils.toast('Post not loaded yet — try again'); return; }
    utils.toast('Loading post from chain…', 2000);
    await this._fetchQuotedPost(hash, channelHint);
    const fetched = this._postMap.get(hash);
    if (fetched) this.openThread(fetched);
    else utils.toast("Couldn't find that post on this channel");
  }

  /* ── Hash-based routing ───────────────────────────────────────────────
     Views map to URL hashes (#/profile/0x…, #/post/0x…, #/explore, …) so
     pages are shareable and back/forward works. Hash routes are domain- and
     base-path-independent, so they survive a custom-domain switch and work on
     any static host (GitHub Pages, IPFS) with no server rewrites. */
  _postUrl(hash)    { return location.origin + location.pathname + '#/post/' + hash; }
  _profileUrl(addr) { return location.origin + location.pathname + '#/profile/' + addr; }

  /* Push a route into the address bar. No-op when navigation was initiated BY
     the router (back/forward / deep link), so we don't add duplicate history. */
  _setRoute(path) {
    if (this._suppressRoute) return;
    const target = '#' + path;
    if (location.hash === target) { this._lastRoutedHash = target; return; }
    try {
      /* First navigation replaces the load entry; later ones push so
         back/forward walks the in-app history. */
      if (!this._lastRoutedHash) history.replaceState(null, '', target);
      else history.pushState(null, '', target);
    } catch { location.hash = target; }
    this._lastRoutedHash = target;
  }

  /* Drive the app from the current URL hash (initial load, back/forward, or a
     manual address-bar edit). Dispatches to the matching view with route
     pushes suppressed so it doesn't re-push the same entry. */
  _routeTo() {
    const cur = location.hash;
    if (cur === this._lastRoutedHash) return; /* deduped (popstate+hashchange both fire) */
    this._lastRoutedHash = cur;
    const parts = cur.replace(/^#\/?/, '').split('/');
    const seg = parts[0] || '';
    const arg = parts[1] ? decodeURIComponent(parts[1]) : '';
    this._suppressRoute = true;
    try {
      switch (seg) {
        case '': case 'home':  this.goHome(); break;
        case 'explore':        this.goExplore(['news','people','channels','latest','trending'].includes(arg) ? arg : null); break;
        case 'notifications':  this.goNotifications(); break;
        case 'bookmarks':      this.goBookmarks(); break;
        case 'channels':       this.goChannels(); break;
        case 'messages':       this.goMessages?.(/^0x[a-f0-9]{40}$/i.test(arg) ? arg.toLowerCase() : null); break;
        case 'notgrok':        this.goNotGrok?.(); break;
        case 'settings':       this.goSettings(); break;
        case 'lists':          this.goLists?.(); break;
        case 'analytics':      this.goAnalytics?.(); break;
        case 'dashboard':      this.goDashboard?.(); break;
        case 'verify':         this.goVerify?.(); break;
        case 'premium':        this.goPremium?.(); break;
        case 'communities':    this.goCommunities?.(); break;
        case 'profile':        /^0x[a-f0-9]{40}$/i.test(arg)
                                 ? this.goProfilePage(arg.toLowerCase(), arg.toLowerCase() === this.state.signerAddr)
                                 : this.goHome(); break;
        case 'post':           /^0x[a-f0-9]{64}$/i.test(arg) ? this.openThreadByHash(arg.toLowerCase()) : this.goHome(); break;
        case 'channel':        if (/^0x[a-f0-9]{40}$/i.test(arg)) { this.g('custom-input').value = arg; this.goCustom(); } else this.goHome(); break;
        case 'tag':            arg ? this.filterByTag(arg) : this.goHome(); break;
        default:               this.goHome();
      }
    } finally { this._suppressRoute = false; }
  }

  _initRouter() {
    const handler = () => this._routeTo();
    window.addEventListener('popstate', handler);
    window.addEventListener('hashchange', handler);
  }

  /* Open the user's chosen launch tab (Settings → Content & Feed) when the
     page wasn't opened on a deep link. Only self-loading views are offered, so
     there's no dependency on the (skipped) home scan or a connected wallet. */
  _goDefaultView(view) {
    switch (view) {
      case 'explore':   this.goExplore(); break;
      case 'bookmarks': this.goBookmarks(); break;
      default:          this.goHome();
    }
  }

  /* Share a URL via the native share sheet when available, else copy it. */
  _shareUrl(url, text) {
    if (navigator.share) {
      navigator.share({ title: 'Say It DeFi', text: text || '', url }).catch(() => {});
    } else {
      utils.copyToClipboard(url, 'Link copied!');
    }
  }
  sharePost(post) {
    if (!post) return;
    this._shareUrl(this._postUrl(post.txHash), (post.display || '').slice(0, 80));
  }

  /* Fetch a single tx by hash (for deep-linking a post, or loading a
     bookmark that isn't cached). Primary path is the Blockscout v2 single-tx
     endpoint, which returns the input, from/to AND a real timestamp in one
     call. (The old module=proxy&action=eth_getTransactionByHash action was
     dropped by PulseScan — it now answers "Unknown action", which is why cold
     deep-links had stopped resolving.) Falls back to the JSON-RPC node,
     enriched with the block timestamp, if v2 is unreachable. */
  async _fetchTxByHash(hash, chainId = CANONICAL_CHAIN_ID) {
    /* Guard: hash is interpolated into the request URL below — never send
       a malformed value to the explorer (and short-circuit junk lookups). */
    if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) return null;
    const cid = Number(chainId) || CANONICAL_CHAIN_ID;
    /* Non-canonical chain (cross-chain quoted post): Etherscan v2 proxy
       eth_getTransactionByHash. That response has no block timestamp, so
       _parsePostTx falls back to "now" for the quote card's relative time. */
    if (cid !== CANONICAL_CHAIN_ID) {
      const cfg = chainCfg(cid);
      if (!cfg || cfg.explorer.type !== 'etherscan-v2') return null;
      try {
        const sx  = this._getSettings();
        const key = sx.etherscanKey ? `&apikey=${encodeURIComponent(sx.etherscanKey)}` : '';
        const res = await fetch(`${cfg.explorer.api}?chainid=${cfg.id}&module=proxy&action=eth_getTransactionByHash&txhash=${hash}${key}`);
        if (res.ok) {
          const d = await res.json();
          const r = d && d.result;
          if (r && r.input && r.input !== '0x') {
            const txLike = {
              hash: r.hash || hash, from: r.from, to: r.to, input: r.input,
              blockNumber: r.blockNumber ? parseInt(r.blockNumber, 16) : null, timeStamp: null,
            };
            if (!utils.isTxShape(txLike)) return null;
            utils._stripBadNumerics(txLike);
            const parsed = this._parsePostTx(txLike, { mode: 'main', chainId: cid });
            if (parsed) this._postMap.set(hash, parsed);
            return parsed;
          }
        }
      } catch { /* give up */ }
      return null;
    }
    const s = this._getSettings();
    const base = (s.apiUrl || 'https://api.scan.pulsechain.com/api').replace(/\/api\/?$/, '');
    let txLike = null;
    /* Primary: Blockscout v2. */
    try {
      const res = await fetch(`${base}/api/v2/transactions/${hash}`);
      if (res.ok) {
        const d = await res.json();
        if (d && d.raw_input && d.raw_input !== '0x') {
          txLike = {
            hash:  d.hash || hash,
            from:  d.from?.hash,
            to:    d.to?.hash,
            input: d.raw_input,
            blockNumber: d.block ?? null,
            timeStamp: d.timestamp ? Math.floor(new Date(d.timestamp).getTime() / 1000) : null,
          };
        }
      }
    } catch { /* fall through to RPC */ }
    /* Fallback: JSON-RPC node, with a best-effort block-timestamp lookup. */
    if (!txLike) {
      try {
        const prov = this._getReadProvider();
        const tx = await prov.getTransaction(hash);
        if (tx && tx.data && tx.data !== '0x') {
          let timeStamp = null;
          try {
            if (tx.blockNumber != null) {
              const blk = await prov.getBlock(tx.blockNumber);
              if (blk?.timestamp) timeStamp = blk.timestamp;
            }
          } catch { /* leave null → _parsePostTx falls back to now */ }
          txLike = {
            hash: tx.hash || hash, from: tx.from, to: tx.to,
            input: tx.data, blockNumber: tx.blockNumber ?? null, timeStamp,
          };
        }
      } catch { /* give up below */ }
    }
    if (!txLike) return null;
    /* Same ingestion gate as apiFetch — single-tx lookups must not bypass
       the explorer-shape validation. */
    if (!utils.isTxShape(txLike)) return null;
    utils._stripBadNumerics(txLike);
    const parsed = this._parsePostTx(txLike, { mode: 'main' });
    if (parsed) this._postMap.set(hash, parsed);
    return parsed;
  }

  openThread(post) {
    if (!post) { utils.toast('Post not loaded yet — try again'); return; }
    this._setRoute('/post/' + post.txHash);
    this._updateTitle('Post');
    /* Save previous view so back button can restore it */
    this._prevMode    = this.state.mode;
    this._prevChannel = this.state.channel;
    this._prevPosts   = this.state.posts;
    /* Remember WHICH profile we came from — back must return to the viewed
       profile page, not the signed-in user's profile modal. */
    this._prevProfileAddr = this._prevMode === 'profile' ? this._profilePageState?.address : null;
    /* Stash control: _renderThreadPage re-renders after the async ancestor
       fetch; it stashes its own header on first render so re-renders never
       reuse a stale or foreign (e.g. profile username) header. */
    this._threadHeaderHTML = null;
    /* Thread always starts at the top — arriving from a scrolled profile
       otherwise leaves the viewport mid-thread ("no post at the top"). */
    window.scrollTo({ top: 0 });

    this.state.mode = 'thread';
    this.g('compose-area').style.display   = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('feed-tabs').style.display      = 'none';
    this.g('new-banner').classList.remove('visible');
    this.g('loading-more').style.display   = 'none';
    /* Thread page header: back arrow + "Post" title, exactly like X */
    this._pendingPageHeader = this._makePageHeader({
      title: 'Post',
      back: true,
    });
    /* Override back action to restore previous view, not history.back() */
    this._threadBackOverride = true;

    this.state.threadPost = post;
    this.state.threadAncestors = [];   /* reset; filled by _fetchThreadAncestors */
    this._renderThreadPage(post);
    this.fetchThreadReplies(post);
    /* If this post is a reply, fetch and render its ancestors above it */
    if (post.parentTx) this._fetchThreadAncestors(post);
  }

  /* Walk the parentTx chain upward from the focused post, up to 5 ancestors.
     Missing parents are resolved by hash via _fetchTxByHash (works no matter
     how deep in the channel they are — the old page-1 scan missed anything
     older than the latest 50 txs). Ancestors are stored in state and rendered
     by _renderThreadPage, so a reply re-render no longer wipes them. */
  async _fetchThreadAncestors(post) {
    const MAX_HOPS = 5;
    let current = post;
    const ancestors = [];
    for (let hop = 0; hop < MAX_HOPS && current.parentTx; hop++) {
      let parent = this._postMap.get(current.parentTx);
      if (!parent) {
        try { parent = await this._fetchTxByHash(current.parentTx); }
        catch { break; }
      }
      if (!parent) break;
      ancestors.unshift(parent);
      if (parent.reporter && parent.reporter !== this.state.signerAddr)
        this.fetchOtherProfile(parent.reporter);
      current = parent;
    }
    if (!ancestors.length) return;
    /* Bail if the user navigated away or opened a different thread while we
       were fetching. */
    if (this.state.mode !== 'thread' || this.state.threadPost?.txHash !== post.txHash) return;
    this.state.threadAncestors = ancestors;
    this._renderThreadPage(post);
  }

  /* Resolve a feed-reply's parent post and patch its conversation-module
     placeholder(s) in place. Same direct-hash strategy as quote cards. */
  async _hydrateFeedParent(hash) {
    this._fetchingParents = this._fetchingParents || new Set();
    if (this._fetchingParents.has(hash)) return;
    this._fetchingParents.add(hash);
    try {
      const parent = this._postMap.get(hash) || this._parentCache?.get(hash)
        || await this._fetchTxByHash(hash);
      if (parent) {
        /* renderFeed clears _postMap on every render — module parents live
           in their own bounded cache so they survive re-renders instead of
           re-fetching forever. */
        this._parentCache = this._parentCache || new Map();
        this._parentCache.set(hash, parent);
        if (this._parentCache.size > 300) {
          this._parentCache.delete(this._parentCache.keys().next().value);
        }
      }
      const nodes = document.querySelectorAll(`[data-fp="${hash}"]`);
      if (!nodes.length) return;
      nodes.forEach(ph => {
        if (!parent) {
          ph.innerHTML = '<span style="color:var(--muted);font-size:13px">Original post unavailable</span>';
          return;
        }
        ph.classList.remove('feed-parent-missing');
        ph.removeAttribute('data-fp');
        ph.innerHTML = this.postHTML(parent, true, null, null);
      });
      if (parent?.reporter) this.fetchOtherProfile(parent.reporter);
    } finally {
      this._fetchingParents.delete(hash);
    }
  }

  /* ── Live Spaces (experimental) ──────────────────────────────────────
     Phase 1: small-room live audio, fully serverless.
     - DISCOVERY is on-chain: a SPACE: post announces the room (uncensorable).
     - SIGNALING rides public WebTorrent trackers over WebSocket — the same
       infrastructure browser torrents use; we speak the tracker's announce/
       offer/answer protocol directly. No server of ours, no accounts.
     - AUDIO is a WebRTC mesh (everyone connects to everyone), which holds
       up for roughly 6–8 active participants — the documented phase-1
       limit; bigger rooms need a relay tier later.
     - STUN via Cloudflare (IP visible to them during connection setup —
       called out in the room UI). */
  /* Decode a SPACE: payload → { roomId, startsMs, title } or null.
     Single source of truth — used by the chain parser and by _reviveSpace. */
  _parseSpacePayload(text) {
    if (typeof text !== 'string' || !text.startsWith(SPACE_PREFIX)) return null;
    try {
      const rest = text.slice(SPACE_PREFIX.length);
      const nl = rest.indexOf('\n\n');
      const meta = JSON.parse(nl >= 0 ? rest.slice(0, nl) : rest);
      const title = (nl >= 0 ? rest.slice(nl + 2) : '').trim() || 'Live Space';
      if (typeof meta?.r === 'string' && /^[a-f0-9]{16,40}$/.test(meta.r)) {
        return { roomId: meta.r, startsMs: Number(meta.s) || 0, title };
      }
    } catch { /* malformed SPACE json */ }
    return null;
  }

  /* Posts cached before the Space feature shipped carry the raw SPACE:
     payload but no .space field, so they rendered as plain text in some
     feeds while freshly-parsed ones got the live card. Re-derive at every
     render entry point; no-op for everything else. */
  _reviveSpace(post) {
    if (!post || post.space || typeof post.content !== 'string'
      || !post.content.startsWith(SPACE_PREFIX)) return post;
    const space = this._parseSpacePayload(post.content);
    if (space) {
      post.space = space;
      post.postType = 'space';
      post.display = space.title;
    }
    return post;
  }

  /* Compact LIVE strip for quote cards — no Join button there because the
     feed delegate resolves actions against the OUTER post; tapping the
     quote opens the space post's own thread, which has the full card. */
  _spaceStripHTML(sp) {
    const live = !sp.startsMs || sp.startsMs <= Date.now();
    return `<div class="space-strip">${live ? '🔴 LIVE' : '🎙 Scheduled'} · Audio Space</div>`;
  }

  /* Record a SPACE_END marker seen on-chain. Sender is validated against
     the Space's author at render time (we may see the end before the
     announcement during a scan). */
  _captureSpaceEnd(text, tx) {
    const m = text.match(/^SPACE_END:(0x[a-f0-9]{64})/i);
    if (!m || !tx.from) return;
    this._recordSpaceEnd(m[1], tx.from);
  }

  /* A Space is over when: the host published SPACE_END for it; OR it's
     older than the 24h hard cap; OR the trackers say the room is empty
     after a 10-minute grace period (host gone without paying for an end
     marker — the "still going with no people in it" case). */
  _spaceIsEnded(post) {
    const sp = post?.space;
    if (!sp) return false;
    if (post.txHash && this._spaceEnds?.get(post.txHash.toLowerCase()) === post.reporter?.toLowerCase()) return true;
    const started = sp.startsMs || new Date(post.timestamp).getTime();
    const age = Date.now() - started;
    if (age > 24 * 3600 * 1000) return true;
    const probed = this._spaceProbeCache?.get(sp.roomId);
    return !!(probed && probed.n === 0 && age > 10 * 60 * 1000
      && Date.now() - probed.t < 5 * 60 * 1000);
  }

  /* Coalesce probe requests from render paths; keep counts fresh while
     any Space card is on screen. */
  _scheduleSpaceProbe() {
    if (this._spaceProbeTimer) return;
    this._spaceProbeTimer = setTimeout(() => {
      this._spaceProbeTimer = null;
      this._hydrateSpaceCounts();
    }, 600);
    this._spaceProbeInterval ||= setInterval(() => {
      if (document.querySelector('[data-space-count]')) this._hydrateSpaceCounts();
    }, 60000);
  }

  async _hydrateSpaceCounts() {
    const els = [...document.querySelectorAll('[data-space-count]')];
    if (!els.length) return;
    this._spaceProbeCache ||= new Map();
    const stale = [...new Set(els.map(el => el.dataset.spaceCount))].filter(id => {
      const c = this._spaceProbeCache.get(id);
      return !c || Date.now() - c.t > 45000;
    });
    if (stale.length) {
      const res = await SpaceRTC.probe(stale.slice(0, 12));
      if (res) stale.forEach(id => this._spaceProbeCache.set(id, { n: res.get(id) ?? 0, t: Date.now() }));
    }
    document.querySelectorAll('[data-space-count]').forEach(el => {
      const c = this._spaceProbeCache.get(el.dataset.spaceCount);
      if (c) el.textContent = c.n > 0
        ? `${c.n} ${c.n === 1 ? 'person' : 'people'} here now`
        : 'Nobody here yet';
    });
    /* Probe may have just revealed an empty room — flip those cards to the
       ended state in place (full re-derive via _spaceCardHTML). */
    document.querySelectorAll('.space-card[data-space-host]').forEach(card => {
      const hash = card.closest('[data-txhash]')?.dataset.txhash;
      const post = hash && (this._postMap.get(hash) || this._parentCache?.get(hash));
      if (post && this._spaceIsEnded(post)) card.outerHTML = this._spaceCardHTML(post);
    });
  }

  _spaceCardHTML(post) {
    const sp = post.space;
    const ended = this._spaceIsEnded(post);
    const host = this.state.profCache[post.reporter] || {};
    const hostName = host.username ? utils.safe(host.username) : this.trunc(post.reporter);
    const hostPic = utils.safe(utils.safeUrl(host.picUrl) || 'image1.jpeg');
    /* Row 3: avatar · host name · Host chip · " · " · live count, all on ONE
       line, vertically centered, ellipsizing. The count span keeps its
       data-space-count hook so the live probe patches it in place. */
    const hostRow = (countInner) => `
      <div class="space-card-host">
        <img src="${hostPic}" class="space-host-pic" alt="" loading="lazy" data-fallback-src="image1.jpeg">
        <span class="space-card-hostname">${hostName}</span><span class="space-host-chip">Host</span>${countInner ? `<span class="space-card-dot">·</span>${countInner}` : ''}
      </div>`;
    if (ended) {
      return `
        <div class="space-card space-card-ended">
          <div class="space-card-badge ended">🎙 Space · Ended</div>
          <div class="space-card-title">${utils.safe(sp.title)}</div>
          ${hostRow('')}
        </div>`;
    }
    const live = !sp.startsMs || sp.startsMs <= Date.now();
    if (live) this._scheduleSpaceProbe();
    const countInner = live
      ? `<span class="space-card-count" data-space-count="${utils.safe(sp.roomId)}">Checking who's here…</span>`
      : `<span class="space-card-count">Starts ${utils.safe(this.relTime(new Date(sp.startsMs).toISOString()))}</span>`;
    return `
      <div class="space-card" data-space-host="${utils.safe(post.reporter || '')}">
        <div class="space-card-badge">${live
          ? '<span class="live-dot" aria-hidden="true"></span><span class="space-card-live">LIVE</span>'
          : '<span class="space-card-live">🎙 Scheduled</span>'}<span class="space-exp">experimental</span></div>
        <div class="space-card-title">${utils.safe(sp.title)}</div>
        ${hostRow(countInner)}
        <button class="btn-pri space-join-btn" data-action="join-space">${live ? 'Listen live' : 'Join'}</button>
      </div>`;
  }

  openCreateSpace() {
    if (!this.signer) { utils.toast('Connect wallet to start a Space'); return; }
    const body = `
      <div style="font-size:14px;color:var(--muted);margin-bottom:12px">
        A Space is a live audio room. The announcement is an on-chain post;
        the audio is a direct peer-to-peer mesh between participants
        (works best with up to ~8 people — experimental).
      </div>
      <input type="text" id="space-title" maxlength="80" placeholder="What are we talking about?"
        style="width:100%;background:var(--bg-mid);border:1px solid var(--border);border-radius:10px;padding:12px;color:var(--text)">
      <div style="display:flex;justify-content:flex-end;margin-top:12px">
        <button class="btn-pri" id="space-create" style="flex:0 0 auto;padding:10px 24px">Go live 🎙</button>
      </div>`;
    this._showGenericModal('Start a Space', body);
    const btn = this.g('space-create');
    if (btn) btn.onclick = async () => {
      const title = (this.g('space-title')?.value || '').trim() || 'Live Space';
      const roomId = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
      const startsMs = Date.now();
      const content = `${SPACE_PREFIX}${JSON.stringify({ r: roomId, s: startsMs })}\n\n${title}`;
      btn.disabled = true; btn.textContent = 'Publishing…';
      /* A Space announcement is a GLOBAL broadcast (X-parity): always send it
         to MAIN_CHANNEL, NOT this.state.channel — otherwise a host viewing
         their own profile/channel publishes the Space there and nobody else
         (right column / main feed) ever sees it. */
      const hash = await this.publish(content, null, MAIN_CHANNEL);
      btn.disabled = false; btn.textContent = 'Go live 🎙';
      if (hash) {
        this._closeGenericModal();
        /* Join with the REAL post (publish returns the tx hash). The old
           synthetic post had no txHash/reporter/channel, so End Space
           published 'SPACE_END:undefined' — the marker tx mined but
           matched nothing and the card stayed live. */
        const post = {
          content, display: title, parentTx: null, repostOf: null, direction: null,
          poll: null, postType: 'space', space: { roomId, startsMs, title },
          reactionTarget: null, reporter: this.state.signerAddr,
          to: MAIN_CHANNEL, channel: MAIN_CHANNEL,
          timestamp: new Date().toISOString(),
          txHash: typeof hash === 'string' ? hash : null,
          blockNumber: null, mode: this.state.mode,
        };
        if (post.txHash) this._postMap.set(post.txHash, post);
        utils.toast('🎙 You’re live — announced on the main feed');
        this.joinSpace(post);
      }
    };
  }

  /* ICE config for Spaces. Masking ON + TURN configured → relay-only: the
     SDP we hand to peers contains only the relay's candidates, so they
     never learn our address (audio is DTLS-SRTP end-to-end — the relay
     forwards ciphertext). Returns null (direct), 'unconfigured', or a
     config. */
  _spaceIce() {
    const s = this._getSettings();
    if (!s.spaceMaskIp) return null;
    if (!s.spaceTurnUrl || !/^turns?:/.test(s.spaceTurnUrl)) return 'unconfigured';
    const entry = { urls: s.spaceTurnUrl };
    if (s.spaceTurnUser) entry.username = s.spaceTurnUser;
    if (s.spaceTurnCred) entry.credential = s.spaceTurnCred;
    return { iceServers: [entry], iceTransportPolicy: 'relay' };
  }

  /* Join a Space. X model: the host (Space author) joins as a speaker;
     everyone else starts as a LISTENER — no mic permission, receive-only —
     and can request the mic (host approves → rejoin as speaker). */
  async joinSpace(post, role, forceDirect) {
    const sp = this._reviveSpace(post).space;
    if (!sp) return;
    if (this._spaceIsEnded(post)) { utils.toast('This Space has ended'); return; }
    if (this._spaceRoom) this.leaveSpace();
    const isHost = !!this.state.signerAddr && post.reporter === this.state.signerAddr;
    role = role || (isHost ? 'speaker' : 'listener');
    const asSpeaker = role === 'speaker';
    const ice = forceDirect ? null : this._spaceIce();
    const masked = !!ice && ice !== 'unconfigured';
    const note = masked
      ? '🛡 IP masking is ON: participants see your relay’s address, not yours. Audio stays end-to-end encrypted — the relay can’t listen in. The signaling trackers still see your IP, like any website you visit.'
      : asSpeaker
        ? 'Speakers connect peer-to-peer, so other speakers’ devices can see your IP address (never shown in the app, but visible to a technical user). Listeners only ever connect to the host. To hide your IP behind a relay, enable masking in Settings → Privacy.'
        : 'Listening is low-exposure: only the host’s device and the signaling trackers can see your connection — other listeners never do. To hide your IP from the host too, enable masking in Settings → Privacy.';
    /* Mount the bottom-right dock (replaces the old room modal). It carries
       every id the room logic references (space-status/-peers/-direct/-mute/
       -req/-asspeaker/-leave/-end) plus the new chat composer. */
    this._mountSpaceDock(post, role, { isHost, asSpeaker, note });
    const status = () => this.g('space-status');
    const offerDirect = msg => {
      const el = status();
      if (el) el.textContent = msg;
      const btn = this.g('space-direct');
      if (btn) {
        btn.style.display = '';
        btn.onclick = () => { this.leaveSpace(); this.joinSpace(post, role, true); };
      }
    };
    /* Masking on but no relay configured: never silently fall back to a
       direct connection the user explicitly opted out of. */
    if (ice === 'unconfigured') {
      offerDirect('🛡 IP masking is enabled but no TURN relay is configured — add one in Settings → Privacy, or join without masking.');
      const leaveBtn0 = this.g('space-leave');
      if (leaveBtn0) leaveBtn0.onclick = () => { this.leaveSpace(); };
      return;
    }
    try {
      const mic = asSpeaker ? await navigator.mediaDevices.getUserMedia({ audio: true }) : null;
      const room = new SpaceRTC(sp.roomId, mic, {
        role, host: isHost, ice: masked ? ice : undefined,
        onStatus: t => { const el = status(); if (el) el.textContent = t; },
        onPeers: () => this._renderSpaceRoster(),
        onCtl: (label, msg) => this._onSpaceCtl(label, msg),
        onPeerGone: label => this._onSpacePeerGone(label),
        onListeners: () => this._renderSpaceRoster(),
        onNoRelay: () => offerDirect('✗ The TURN relay returned no routes — with masking on, nobody can reach you. Check the relay in Settings → Privacy, or join without masking.'),
        onSpeaking: () => {
          this._renderSpaceRoster();
          /* Host relays who's speaking to listeners (who only hold the mixed
             stream and can't analyse per-speaker). Throttle to ≥500ms. */
          if (isHost) this._relaySpeaking();
        },
      });
      this._spaceRoom = room;
      this._spaceRoomPost = post;
      this._spaceRole = role;
      /* Host: remember the live Space so a reload can offer Rejoin/End. */
      if (isHost && /^0x[a-f0-9]{64}$/.test(post.txHash || '')) {
        try {
          utils.safeLS.set(ACTIVE_SPACE_KEY, JSON.stringify({
            txHash: post.txHash, roomId: sp.roomId, title: sp.title,
            startsMs: sp.startsMs || Date.now(),
            channel: post.channel || post.to || MAIN_CHANNEL, ts: Date.now(),
          }));
        } catch { /* storage full — banner just won't appear */ }
      }
      this._spacePeers = new Map();   /* label → {addr, name, verified} */
      this._spaceCohosts = new Set(); /* lowercase addresses granted by the host */
      this._spaceSpeakReqs = new Map(); /* host: label → {addr, name} */
      this._spaceRosterInfo = null;     /* listener: host's room summary */
      this._spaceHostLabel = isHost ? 'me' : null;
      /* Identity: one free wallet signature proves who you are to the room
         (that's what makes the Host chip unforgeable). Declining it — or
         listening — joins as a guest; listeners sign when requesting
         the mic instead. */
      if (asSpeaker) room.identity = await this._spaceIdentity(sp.roomId, room.peerId);
      room.start();
      this._renderSpaceRoster();
      /* Live chat: replies to the announcement post. Seed from what we have,
         fetch fresh, and poll for new replies every 20s while docked. */
      this._renderSpaceDockMsgs();
      this.fetchThreadReplies(post).then(() => this._renderSpaceDockMsgs());
      this._spaceMsgTimer = setInterval(() => {
        if (!this._spaceRoom) return;
        this.fetchThreadReplies(this._spaceRoomPost).then(() => this._renderSpaceDockMsgs());
      }, 20000);
      if (isHost) {
        /* Periodic room summary so listeners (who only connect to the
           host) still see who's speaking and how many are listening. */
        this._spaceRosterTimer = setInterval(() => {
          if (!this._spaceRoom) return;
          this._spaceRoom.broadcastListeners({ t: 'roster', ...this._spaceRosterSummary() });
        }, 10000);
      }
      const muteBtn = this.g('space-mute');
      if (muteBtn) muteBtn.onclick = () => {
        const on = room.toggleMute();
        muteBtn.textContent = on ? '🔇 Unmute' : '🎙 Mute';
      };
      const reqBtn = this.g('space-req');
      if (reqBtn) reqBtn.onclick = async () => {
        if (!this.signer) { utils.toast('Connect wallet to request the mic'); return; }
        const claim = await this._spaceIdentity(sp.roomId, room.peerId);
        if (!claim) return;
        room.broadcast({ t: 'speak', ...claim });
        reqBtn.disabled = true;
        reqBtn.textContent = '✋ Requested…';
      };
      const asSpkBtn = this.g('space-asspeaker');
      if (asSpkBtn) asSpkBtn.onclick = () => { this.leaveSpace(); this.joinSpace(post, 'speaker'); };
      const leaveBtn = this.g('space-leave');
      if (leaveBtn) leaveBtn.onclick = () => { this.leaveSpace(); };
      const endBtn = this.g('space-end');
      if (endBtn) endBtn.onclick = () => this.endSpace(post);
    } catch (err) {
      const el = status();
      if (el) el.textContent = '✗ Microphone unavailable: ' + (err?.message || err);
    }
  }

  /* Throttled host→listener relay of the speaking set as verified addresses.
     Listeners only hold the mixed stream, so they can't tell who's talking;
     the host (who analyses each speaker) tells them. */
  _relaySpeaking() {
    const room = this._spaceRoom;
    if (!room) return;
    const now = Date.now();
    if (this._spkRelayAt && now - this._spkRelayAt < 500) {
      clearTimeout(this._spkRelayPending);
      this._spkRelayPending = setTimeout(() => this._relaySpeaking(), 500 - (now - this._spkRelayAt));
      return;
    }
    this._spkRelayAt = now;
    const addrs = [];
    for (const label of room.speaking) {
      const addr = label === 'me' ? this.state.signerAddr : this._spacePeers?.get(label)?.addr;
      if (addr && /^0x[a-f0-9]{40}$/i.test(addr)) addrs.push(addr.toLowerCase());
    }
    room.broadcastListeners({ t: 'spk', addrs });
  }

  /* ── Preview modal (X-style "join screen" before entering a Space) ────── */
  openSpacePreview(post) {
    const sp = this._reviveSpace(post).space;
    if (!sp) return;
    const ended = this._spaceIsEnded(post);
    const host = this.state.profCache[post.reporter] || {};
    const hostName = host.username ? utils.safe(host.username) : this.trunc(post.reporter);
    const hostPic = utils.safe(utils.safeUrl(host.picUrl) || 'image1.jpeg');
    const live = !sp.startsMs || sp.startsMs <= Date.now();
    const badge = ended
      ? 'Ended'
      : live
        ? '<span class="live-dot" aria-hidden="true"></span> LIVE'
        : 'Scheduled';
    const iAmHost = !!this.state.signerAddr && post.reporter === this.state.signerAddr;
    let btn = '';
    if (!ended) {
      btn = iAmHost
        ? '<button class="btn-pri" id="space-preview-go" style="width:100%;padding:12px">🎙 Rejoin your Space</button>'
        : '<button class="btn-pri" id="space-preview-go" style="width:100%;padding:12px">🎧 Start listening</button>';
    }
    const countLine = (!ended && live)
      ? `<div class="space-card-sub" style="margin-top:8px"><span data-space-count="${utils.safe(sp.roomId)}">Checking who's here…</span></div>`
      : '';
    const body = `
      <div class="space-card" style="margin-top:0">
        <div class="space-card-badge">${badge}<span class="space-exp">experimental</span></div>
        <div class="space-card-title" style="font-size:22px">${utils.safe(sp.title)}</div>
        <div class="space-card-host" style="margin-top:6px">
          <img src="${hostPic}" class="space-host-pic" alt="" loading="lazy" data-fallback-src="image1.jpeg">
          <span>${hostName}</span><span class="space-host-chip">Host</span>
        </div>
        ${countLine}
      </div>
      <div style="margin-top:16px">
        ${ended ? '<div class="space-card-sub">This Space has ended</div>' : btn}
      </div>`;
    this._showGenericModal('Space', body);
    if (!ended && live) this._scheduleSpaceProbe();
    const go = this.g('space-preview-go');
    if (go) go.onclick = () => { this._closeGenericModal(); this.joinSpace(post); };
  }

  /* ── The dock (bottom-right player) ───────────────────────────────────── */
  _mountSpaceDock(post, role, { isHost, asSpeaker, note }) {
    const dock = this.g('space-dock');
    if (!dock) return;
    /* Set the post early so the dock's post-only actions (Reply / Share) wire
       up at mount, before joinSpace assigns the (async) room. */
    this._spaceRoomPost = post;
    /* Re-mounting: clear any prior polls/timers tied to a previous room. */
    clearInterval(this._spaceMsgTimer);
    const sp = post.space;
    const title = utils.safe(sp.title);
    const leaveLabel = isHost ? 'End' : 'Leave';
    dock.innerHTML = `
      <!-- Collapsed bar -->
      <span class="live-dot" aria-hidden="true"></span>
      <span class="space-dock-bar-title">${title}</span>
      <span class="space-dock-bar-avs" id="space-dock-bar-avs"></span>
      <button class="space-dock-leave-mini" id="space-dock-leave-mini">${leaveLabel}</button>`;
    /* Build the expanded panel as a sibling content holder; both states share
       the same #space-dock element, toggled by class. We keep BOTH layouts in
       the DOM and let CSS show the right one via .collapsed/.expanded. To keep
       it simple, store the expanded markup and swap innerHTML on toggle. */
    this._spaceDockCollapsedHTML = dock.innerHTML;
    this._spaceDockExpandedHTML = `
      <div class="space-dock-head">
        <span class="live-dot" aria-hidden="true"></span>
        <span class="space-dock-head-title">${title}</span>
        <button class="space-dock-toggle" id="space-dock-repost" aria-label="Repost or quote this Space" title="Repost / Quote">↻</button>
        <button class="space-dock-toggle" id="space-dock-share" aria-label="Share this Space" title="Share this Space">↗</button>
        <button class="space-dock-toggle" id="space-dock-toggle" aria-label="Collapse">⌄</button>
      </div>
      <div class="space-dock-body">
        <div class="space-dock-msgs" id="space-dock-msgs"></div>
        <div class="space-dock-replybar">
          <button class="space-dock-replybtn" id="space-dock-reply">💬 Reply to this Space</button>
        </div>
        <div class="space-peers" id="space-peers"></div>
        <div class="space-dock-status" id="space-status">${asSpeaker ? 'Requesting microphone…' : 'Tuning in…'}</div>
        <div class="space-dock-note">${note}</div>
        <div class="space-dock-foot">
          <button class="settings-btn" id="space-direct" style="display:none">Join without masking</button>
          ${asSpeaker ? '<button class="settings-btn" id="space-mute">🎙 Mute</button>'
            : `<button class="settings-btn" id="space-req">🎙 Request to speak</button>
               <button class="settings-btn" id="space-asspeaker" style="display:none">🎙 Join with mic</button>`}
          <button class="settings-btn" id="space-leave">Leave</button>
          ${isHost ? '<button class="settings-btn danger" id="space-end">End Space</button>' : ''}
        </div>
      </div>`;
    dock.style.display = '';
    /* Mount expanded initially (X opens the player open after you join). The
       room object isn't assigned yet at mount time — joinSpace wires the
       controls/roster a moment later — so expand the DOM unconditionally. */
    this._expandSpaceDock();
  }

  /* Swap the dock into its expanded panel and (re)wire the in-panel controls
     that joinSpace's handlers expect. Re-wiring on every expand is required
     because we replace innerHTML between states. Safe to call before the room
     is assigned (mount time): wiring/roster simply no-op until it exists. */
  _expandSpaceDock() {
    const dock = this.g('space-dock');
    if (!dock || !this._spaceDockExpandedHTML) return;
    dock.style.display = '';
    dock.classList.remove('collapsed');
    dock.classList.add('expanded');
    dock.innerHTML = this._spaceDockExpandedHTML;
    dock.onclick = null; /* expanded panel has no bar-click handler */
    const toggle = this.g('space-dock-toggle');
    /* stopPropagation: collapse swaps innerHTML and rebinds dock.onclick to the
       expand handler; without this the same bubbling click would immediately
       re-expand. */
    if (toggle) toggle.onclick = e => { e.stopPropagation(); this._collapseSpaceDock(); };
    /* Post-only actions (Reply / Share) need just _spaceRoomPost, which is set
       at mount — wire them every expand, independent of the room. */
    this._wireSpaceDockActions(this._spaceRoomPost);
    /* Re-wire the room controls (handlers were bound to the previous nodes).
       These guard internally on this._spaceRoom. */
    this._wireSpaceDockControls();
    this._renderSpaceRoster();
    this._renderSpaceDockMsgs();
  }

  _collapseSpaceDock() {
    const dock = this.g('space-dock');
    if (!dock) return;
    dock.classList.remove('expanded');
    dock.classList.add('collapsed');
    dock.innerHTML = this._spaceDockCollapsedHTML;
    /* Clicking the bar (anywhere but the leave button) expands again. */
    dock.onclick = e => {
      if (e.target.closest('#space-dock-leave-mini')) return;
      this._expandSpaceDock();
    };
    const mini = this.g('space-dock-leave-mini');
    if (mini) mini.onclick = e => {
      e.stopPropagation();
      const post = this._spaceRoomPost;
      if (this._spaceHostLabel === 'me' && post) this.endSpace(post);
      else this.leaveSpace();
    };
    this._renderSpaceDockBarAvatars();
  }

  /* Up to 3 tiny stacked avatars on the collapsed bar (host + speakers). */
  _renderSpaceDockBarAvatars() {
    const el = this.g('space-dock-bar-avs');
    const room = this._spaceRoom, post = this._spaceRoomPost;
    if (!el || !room || !post) return;
    const addrs = [];
    const me = this.state.signerAddr;
    if (this._spaceRole !== 'listener') addrs.push(me);
    for (const [label, pc] of room.pcs) {
      if (pc.connectionState !== 'connected') continue;
      addrs.push(this._spacePeers?.get(label)?.addr || null);
    }
    if (this._spaceRole === 'listener') {
      addrs.unshift(post.reporter); /* host first for listeners */
    }
    el.innerHTML = addrs.slice(0, 3).map(a => {
      const pic = utils.safe(utils.safeUrl(a ? this.state.profCache[a]?.picUrl : null) || 'image1.jpeg');
      return `<img src="${pic}" alt="" data-fallback-src="image1.jpeg">`;
    }).join('');
  }

  /* Wire the room control buttons inside the expanded dock. Idempotent —
     called fresh after each innerHTML swap. */
  _wireSpaceDockControls() {
    const room = this._spaceRoom, post = this._spaceRoomPost;
    if (!room || !post) return;
    const muteBtn = this.g('space-mute');
    if (muteBtn) {
      /* Reflect current mute state on re-wire. */
      const t = room.mic?.getAudioTracks()[0];
      muteBtn.textContent = (t && t.enabled === false) ? '🔇 Unmute' : '🎙 Mute';
      muteBtn.onclick = () => {
        const on = room.toggleMute();
        muteBtn.textContent = on ? '🔇 Unmute' : '🎙 Mute';
      };
    }
    const reqBtn = this.g('space-req');
    if (reqBtn) reqBtn.onclick = async () => {
      if (!this.signer) { utils.toast('Connect wallet to request the mic'); return; }
      const claim = await this._spaceIdentity(post.space.roomId, room.peerId);
      if (!claim) return;
      room.broadcast({ t: 'speak', ...claim });
      reqBtn.disabled = true;
      reqBtn.textContent = '✋ Requested…';
    };
    const asSpkBtn = this.g('space-asspeaker');
    if (asSpkBtn) {
      asSpkBtn.style.display = this._spaceHostLabel ? 'none' : '';
      asSpkBtn.onclick = () => { this.leaveSpace(); this.joinSpace(post, 'speaker'); };
    }
    const leaveBtn = this.g('space-leave');
    if (leaveBtn) leaveBtn.onclick = () => { this.leaveSpace(); };
    const endBtn = this.g('space-end');
    if (endBtn) endBtn.onclick = () => this.endSpace(post);
  }

  /* X behavior: you don't type in the player — you reply to the Space post.
     The Reply button opens the on-chain reply composer (REPLY_TO:); Share
     opens the standard share sheet (copy link / native share). */
  _wireSpaceDockActions(post) {
    const reply = this.g('space-dock-reply');
    if (reply) reply.onclick = () => {
      if (!this.signer) { utils.toast('Connect wallet to reply'); return; }
      this.openReplyModal(this._spaceRoomPost || post);
    };
    const share = this.g('space-dock-share');
    if (share) share.onclick = e => { e.stopPropagation(); this.sharePost(this._spaceRoomPost || post); };
    /* X's "post options": the standard repost/quote chooser for the Space's
       announcement post — a quote renders the Space as a card via the new
       in-body link-quote path too. */
    const rp = this.g('space-dock-repost');
    if (rp) rp.onclick = e => {
      e.stopPropagation();
      if (!this.signer) { utils.toast('Connect wallet to repost'); return; }
      this.openRepostChoice(this._spaceRoomPost || post, rp);
    };
  }

  /* Render the chat: replies to the announcement post (oldest→newest),
     autoscrolled to the bottom. */
  _renderSpaceDockMsgs() {
    const el = this.g('space-dock-msgs');
    const post = this._spaceRoomPost;
    if (!el || !post) return;
    const byHash = new Map();
    for (const p of this.state.posts) {
      if (p.parentTx === post.txHash && p.display) byHash.set(p.txHash, p);
    }
    for (const m of this._spaceLocalMsgs || []) {
      if (m.parentTx === post.txHash) byHash.set(m.txHash, m);
    }
    const msgs = [...byHash.values()].sort((a, b) =>
      (a._tsMs ??= new Date(a.timestamp).getTime()) - (b._tsMs ??= new Date(b.timestamp).getTime()));
    if (!msgs.length) {
      el.innerHTML = '<div class="space-dock-msgs-empty">No messages yet — say hi 👋</div>';
      return;
    }
    /* Lazily fetch avatars/names for chat authors we haven't seen. */
    msgs.forEach(m => {
      if (m.reporter && m.reporter !== this.state.signerAddr && !this.state.profCache[m.reporter]?.username)
        this.fetchOtherProfile?.(m.reporter);
    });
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    el.innerHTML = msgs.map(m => {
      const prof = this.state.profCache[m.reporter] || {};
      const name = prof.username ? utils.safe(prof.username) : utils.safe(this.trunc(m.reporter || ''));
      const pic = utils.safe(utils.safeUrl(prof.picUrl) || 'image1.jpeg');
      return `<div class="space-dock-msg">
        <img src="${pic}" alt="" data-fallback-src="image1.jpeg">
        <div class="space-dock-msg-body">
          <div><span class="space-dock-msg-name">${name}</span><span class="space-dock-msg-time">${utils.safe(this.relTime(m.timestamp))}</span></div>
          <div class="space-dock-msg-text">${utils.safe(m.display)}</div>
        </div>
      </div>`;
    }).join('');
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  _spaceRosterSummary() {
    const me = this.state.signerAddr;
    const speakers = [{ addr: me || null, name: me ? (this.state.profCache[me]?.username || null) : null }];
    for (const [label, pc] of this._spaceRoom?.pcs || []) {
      if (pc.connectionState !== 'connected') continue;
      const info = this._spacePeers?.get(label);
      speakers.push({ addr: info?.addr || null, name: info?.name || null });
    }
    return { speakers: speakers.slice(0, 12), n: this._spaceRoom?.listeners.size || 0 };
  }

  /* Sign a per-room identity claim. The message binds room + OUR peerId +
     a timestamp, so a copied signature only ever vouches for that peer in
     that room within a 15-minute window — best-effort anti-replay. */
  async _spaceIdentity(roomId, peerId) {
    if (!this.signer || !this.state.signerAddr) return null;
    try {
      const ts = Date.now();
      const sig = await this.signer.signMessage(`Say It DeFi Space\nroom:${roomId}\npeer:${peerId}\nts:${ts}`);
      const name = this.state.profCache[this.state.signerAddr]?.username || null;
      return { addr: this.state.signerAddr, name, ts, sig };
    } catch { return null; } /* declined — join as guest */
  }

  /* Is this peer the (verified) host, or a co-host the host appointed? */
  _labelIsSpaceAdmin(label) {
    if (label === this._spaceHostLabel) return true;
    const info = this._spacePeers?.get(label);
    return !!(info?.verified && info.addr && this._spaceCohosts?.has(info.addr));
  }

  _onSpaceCtl(label, msg) {
    const room = this._spaceRoom, post = this._spaceRoomPost;
    if (!room || !post) return;
    if (msg.t === 'hi') {
      const info = { addr: null, verified: false,
        name: typeof msg.name === 'string' ? msg.name.slice(0, 40) : null };
      /* Verify the wallet-signed claim; any failure demotes to guest. */
      if (typeof msg.addr === 'string' && /^0x[a-f0-9]{40}$/i.test(msg.addr)
        && typeof msg.sig === 'string' && Math.abs(Date.now() - Number(msg.ts)) < 15 * 60 * 1000) {
        try {
          const m = `Say It DeFi Space\nroom:${post.space.roomId}\npeer:${label}\nts:${msg.ts}`;
          if (ethers.verifyMessage(m, msg.sig).toLowerCase() === msg.addr.toLowerCase()) {
            info.addr = msg.addr.toLowerCase();
            info.verified = true;
            this.fetchOtherProfile(info.addr); /* roster avatar + name */
          }
        } catch { /* bad signature — guest */ }
      }
      this._spacePeers.set(label, info);
      if (info.verified && info.addr === post.reporter) {
        this._spaceHostLabel = label;
        clearTimeout(this._spaceHostGone); /* host (re)arrived */
      }
      this._renderSpaceRoster();
    } else if (msg.t === 'end') {
      if (!this._labelIsSpaceAdmin(label)) return;
      utils.toast('The host ended this Space');
      this._recordSpaceEnd(post.txHash, post.reporter);
      this._clearActiveSpaceIf(post.txHash);
      this.leaveSpace();
      this.renderFeed();
    } else if (msg.t === 'mute') {
      /* Host/co-host asked US to mute. Soft enforcement: mute locally,
         keep the unmute button (X lets speakers unmute themselves too). */
      if (!this._labelIsSpaceAdmin(label) || msg.peer !== room.peerId) return;
      const t = room.mic.getAudioTracks()[0];
      if (t && t.enabled) {
        t.enabled = false;
        const b = this.g('space-mute');
        if (b) b.textContent = '🔇 Unmute';
        utils.toast('The host muted your mic — you can unmute');
      }
    } else if (msg.t === 'cohost') {
      /* Only the verified host can appoint co-hosts. */
      if (label !== this._spaceHostLabel) return;
      if (typeof msg.addr === 'string' && /^0x[a-f0-9]{40}$/i.test(msg.addr)) {
        this._spaceCohosts.add(msg.addr.toLowerCase());
        if (msg.addr.toLowerCase() === this.state.signerAddr) utils.toast('The host made you a co-host 🎉');
        this._renderSpaceRoster();
      }
    } else if (msg.t === 'speak') {
      /* A listener asks for the mic (host side) — carries a fresh signed
         claim; unsigned requests are ignored. */
      if (!label.startsWith('L:') || this.state.signerAddr !== post.reporter) return;
      let addr = null;
      const name = typeof msg.name === 'string' ? msg.name.slice(0, 40) : null;
      if (typeof msg.addr === 'string' && /^0x[a-f0-9]{40}$/i.test(msg.addr)
        && typeof msg.sig === 'string' && Math.abs(Date.now() - Number(msg.ts)) < 15 * 60 * 1000) {
        try {
          const m = `Say It DeFi Space\nroom:${post.space.roomId}\npeer:${label.slice(2)}\nts:${msg.ts}`;
          if (ethers.verifyMessage(m, msg.sig).toLowerCase() === msg.addr.toLowerCase()) {
            addr = msg.addr.toLowerCase();
            this.fetchOtherProfile(addr);
          }
        } catch { /* bad signature */ }
      }
      if (!addr) return;
      this._spaceSpeakReqs.set(label, { addr, name });
      utils.toast(`🎙 ${name || this.trunc(addr)} wants to speak`);
      this._renderSpaceRoster();
    } else if (msg.t === 'promote') {
      /* The host approved our speak request (listener side): rejoin the
         room as a speaker — mic permission happens on the way in. */
      if (label !== this._spaceHostLabel || this._spaceRole !== 'listener') return;
      utils.toast('🎙 The host invited you to speak');
      this.leaveSpace();
      this.joinSpace(post, 'speaker');
    } else if (msg.t === 'roster') {
      /* Host's periodic room summary (listener side). */
      if (label !== this._spaceHostLabel) return;
      this._spaceRosterInfo = {
        speakers: Array.isArray(msg.speakers) ? msg.speakers.slice(0, 12) : [],
        n: Number(msg.n) || 0,
      };
      this._renderSpaceRoster();
    } else if (msg.t === 'spk') {
      /* Host's speaking relay (listener side): which addresses are talking.
         Only honored from the verified host. */
      if (label !== this._spaceHostLabel) return;
      this._spaceSpeakingAddrs = new Set(
        (Array.isArray(msg.addrs) ? msg.addrs : [])
          .filter(a => typeof a === 'string' && /^0x[a-f0-9]{40}$/i.test(a))
          .map(a => a.toLowerCase()));
      this._renderSpaceRoster();
    }
  }

  _onSpacePeerGone(label) {
    this._spacePeers?.delete(label);
    this._renderSpaceRoster();
    /* Host left: give them 60s to reconnect, then the Space is over for
       everyone (X behavior — the room dies with the host). */
    if (label === this._spaceHostLabel && this._spaceRoom) {
      this._spaceHostLabel = null;
      clearTimeout(this._spaceHostGone);
      this._spaceHostGone = setTimeout(() => {
        if (!this._spaceRoom || this._spaceHostLabel) return;
        const post = this._spaceRoomPost;
        utils.toast('The host left — Space ended');
        if (post) { this._recordSpaceEnd(post.txHash, post.reporter); this._clearActiveSpaceIf(post.txHash); }
        this.leaveSpace();
        this.renderFeed();
      }, 60000);
    }
  }

  /* Roster: speakers as pills (avatar, name, role chip; host/co-hosts get
     per-peer mute + co-host controls), listener count, and — host side —
     pending speak requests with Approve. Listeners see the host's
     periodic summary instead (they only connect to the host). */
  _renderSpaceRoster() {
    const el = this.g('space-peers');
    const room = this._spaceRoom, post = this._spaceRoomPost;
    if (!room || !post) return;
    /* Keep the collapsed bar's avatars fresh even when the participants grid
       isn't mounted (dock collapsed). */
    this._renderSpaceDockBarAvatars();
    if (!el) return; /* collapsed — no participants grid to fill */
    const me = this.state.signerAddr;
    const iAmHost = !!me && me === post.reporter;
    const iAmAdmin = iAmHost || (!!me && this._spaceCohosts.has(me));
    const listener = this._spaceRole === 'listener';
    /* Speaking test: speaker view keys on the room's own analyser labels
       ('me' for self); listener view keys on the host-relayed addresses. */
    const speakingByLabel = room.speaking || new Set();
    const speakingAddrs = this._spaceSpeakingAddrs || new Set();
    const isSpeaking = (label, addr, isMe) => listener
      ? !!(addr && speakingAddrs.has(addr))
      : (isMe ? speakingByLabel.has('me') : !!(label && speakingByLabel.has(label)));
    /* One participant tile: 44px avatar (speaking ring), name, role chip, and
       admin controls — same logic as the old pills, restyled as a grid tile. */
    const tile = (label, addr, name, verified, isMe) => {
      const prof = addr ? this.state.profCache[addr] : null;
      const pic = utils.safe(utils.safeUrl(prof?.picUrl) || 'image1.jpeg');
      const shown = isMe ? 'You' : (name || prof?.username || (addr ? this.trunc(addr) : 'Guest'));
      const role = addr === post.reporter && (verified || isMe) ? 'Host'
        : (addr && this._spaceCohosts.has(addr)) ? 'Co-host' : '';
      const spk = isSpeaking(label, addr, isMe);
      const btns = (iAmAdmin && !isMe && label)
        ? `<button class="space-chip-btn" data-space-mute="${utils.safe(label)}" title="Mute their mic">🔇</button>`
          + (iAmHost && verified && addr && addr !== post.reporter && !this._spaceCohosts.has(addr)
            ? `<button class="space-chip-btn" data-space-cohost="${utils.safe(addr)}" title="Make co-host">⭐</button>` : '')
        : '';
      return `<div class="space-tile">
        <div class="space-tile-av${spk ? ' speaking' : ''}"><img src="${pic}" alt="" data-fallback-src="image1.jpeg"></div>
        <div class="space-tile-name">${utils.safe(String(shown).slice(0, 24))}</div>
        ${role ? `<div class="space-tile-role">${role}</div>` : ''}
        ${btns ? `<div class="space-tile-btns">${btns}</div>` : ''}
      </div>`;
    };
    let html = '';
    let listenerCount = 0;
    if (listener) {
      /* What we know: the host's summary, plus our own presence. */
      const sum = this._spaceRosterInfo;
      if (sum?.speakers?.length) {
        sum.speakers.forEach(s => {
          const addr = typeof s?.addr === 'string' && /^0x[a-f0-9]{40}$/i.test(s.addr) ? s.addr.toLowerCase() : null;
          html += tile(null, addr, typeof s?.name === 'string' ? s.name : null, !!addr, false);
        });
      } else {
        for (const [label] of room.pcs) {
          const info = this._spacePeers.get(label);
          html += tile(null, info?.addr || null, info?.name || null, !!info?.verified, false);
        }
      }
      html += tile(null, me, null, !!me, true);
      listenerCount = Math.max(sum?.n || 0, 1);
    } else {
      html = tile('me', me, null, true, true);
      for (const [label, pc] of room.pcs) {
        if (pc.connectionState !== 'connected') continue;
        const info = this._spacePeers.get(label);
        html += tile(label, info?.addr || null, info?.name || null, !!info?.verified, false);
      }
      listenerCount = room.listeners.size;
      /* Pending mic requests (host only). */
      if (iAmHost) {
        for (const [label, req] of this._spaceSpeakReqs || []) {
          if (!room.listeners.has(label)) { this._spaceSpeakReqs.delete(label); continue; }
          const prof = this.state.profCache[req.addr];
          html += `<div class="space-tile-extra">✋ ${utils.safe(String(req.name || prof?.username || this.trunc(req.addr)).slice(0, 24))}
            <button class="space-chip-btn" data-space-approve="${utils.safe(label)}" title="Let them speak">✓ Approve</button></div>`;
        }
      }
    }
    if (listenerCount) html += `<div class="space-tile-extra">👂 ${listenerCount} listening</div>`;
    el.innerHTML = html;
    /* Listener view: "Join with mic" only makes sense while no verified
       host runs the room (small rooms among friends). */
    const asSpk = this.g('space-asspeaker');
    if (asSpk) asSpk.style.display = this._spaceHostLabel ? 'none' : '';
    el.querySelectorAll('[data-space-mute]').forEach(b => {
      b.onclick = () => { room.sendTo(b.dataset.spaceMute, { t: 'mute', peer: b.dataset.spaceMute }); utils.toast('Mute request sent'); };
    });
    el.querySelectorAll('[data-space-cohost]').forEach(b => {
      b.onclick = () => {
        this._spaceCohosts.add(b.dataset.spaceCohost);
        room.broadcast({ t: 'cohost', addr: b.dataset.spaceCohost });
        this._renderSpaceRoster();
      };
    });
    el.querySelectorAll('[data-space-approve]').forEach(b => {
      b.onclick = () => {
        room.sendTo(b.dataset.spaceApprove, { t: 'promote' });
        this._spaceSpeakReqs.delete(b.dataset.spaceApprove);
        utils.toast('Approved — they can join the mic now');
        this._renderSpaceRoster();
      };
    });
  }

  /* Host-only: tell the room it's over (instant, via ctl channels), then
     publish the on-chain end marker (to the same channel as the
     announcement so every scanner sees it), then tear the room down. The
     marker is one tiny tx; if the host declines it, the room still closed
     for everyone present, and the empty-room probe flips the card for
     everyone else within minutes. */
  async endSpace(post) {
    this._spaceRoom?.broadcast({ t: 'end' });
    /* Never publish a marker against a bogus hash (the create-flow bug
       sent literal 'SPACE_END:undefined' to the chain). */
    if (/^0x[a-f0-9]{64}$/.test(post?.txHash || '')) {
      const ok = await this.publish(`${SPACE_END_PREFIX}${post.txHash}`, null, post.channel || post.to);
      if (ok) {
        this._recordSpaceEnd(post.txHash, post.reporter || this.state.signerAddr);
        utils.toast('Space ended');
      }
    } else {
      utils.toast('Space closed for participants (announcement tx not found for the on-chain marker)');
    }
    this._clearActiveSpaceIf(post?.txHash);
    this.leaveSpace();
    this.renderFeed();
  }

  /* ── Host rejoin banner ───────────────────────────────────────────────
     The dock is ephemeral: a reload kills the room while the Space stays
     live on-chain. Persist the host's own Space and offer Rejoin / End on
     the next boot. */
  _clearActiveSpaceIf(hash) {
    try {
      const cur = JSON.parse(utils.safeLS.get(ACTIVE_SPACE_KEY, 'null'));
      if (!hash || cur?.txHash === hash) utils.safeLS.remove(ACTIVE_SPACE_KEY);
    } catch { utils.safeLS.remove(ACTIVE_SPACE_KEY); }
  }

  _checkActiveSpace() {
    let st = null;
    try { st = JSON.parse(utils.safeLS.get(ACTIVE_SPACE_KEY, 'null')); } catch { return; }
    if (!st?.txHash || !st.roomId) return;
    if (Date.now() - (st.ts || 0) > 24 * 3600 * 1000) { utils.safeLS.remove(ACTIVE_SPACE_KEY); return; }
    const me = this.state.signerAddr;
    if (!me || this._spaceRoom || this.g('space-rejoin-banner')) return;
    const post = this._postMap.get(st.txHash) || {
      content: 'SPACE:', display: st.title, parentTx: null, repostOf: null, direction: null,
      poll: null, postType: 'space',
      space: { roomId: st.roomId, startsMs: st.startsMs || st.ts, title: st.title },
      reactionTarget: null, reporter: me, to: st.channel || MAIN_CHANNEL,
      channel: st.channel || MAIN_CHANNEL,
      timestamp: new Date(st.startsMs || st.ts).toISOString(),
      txHash: st.txHash, blockNumber: null, mode: 'main',
    };
    if (post.reporter !== me) return; /* stale entry from another account */
    if (this._spaceIsEnded(post)) { utils.safeLS.remove(ACTIVE_SPACE_KEY); return; }
    const el = document.createElement('div');
    el.id = 'space-rejoin-banner';
    el.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:900;'
      + 'display:flex;gap:10px;align-items:center;padding:10px 16px;border-radius:9999px;'
      + 'background:linear-gradient(120deg,#7c4dff,#ff3cac);color:#fff;font-size:13px;font-weight:700;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,0.45);max-width:92vw';
    el.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🎙 Your Space “${utils.safe(String(st.title || 'Live Space').slice(0, 40))}” may still be live</span>
      <button id="space-rejoin-go" style="flex:0 0 auto;border:none;border-radius:9999px;padding:6px 14px;background:#fff;color:#7c4dff;font-weight:800;cursor:pointer">Rejoin</button>
      <button id="space-rejoin-end" style="flex:0 0 auto;border:1px solid rgba(255,255,255,0.7);border-radius:9999px;padding:6px 12px;background:none;color:#fff;font-weight:700;cursor:pointer">End it</button>
      <button id="space-rejoin-x" aria-label="Dismiss" style="flex:0 0 auto;border:none;background:none;color:#fff;font-size:15px;cursor:pointer;padding:0 2px">✕</button>`;
    document.body.appendChild(el);
    const kill = () => el.remove();
    this.g('space-rejoin-go').onclick = () => { kill(); this._postMap.set(post.txHash, post); this.joinSpace(post); };
    this.g('space-rejoin-end').onclick = () => { kill(); this._postMap.set(post.txHash, post); this.endSpace(post); };
    this.g('space-rejoin-x').onclick = () => { kill(); utils.safeLS.remove(ACTIVE_SPACE_KEY); };
  }

  leaveSpace() {
    clearTimeout(this._spaceHostGone);
    clearInterval(this._spaceRosterTimer);
    clearInterval(this._spaceMsgTimer);
    clearTimeout(this._spkRelayPending);
    this._spaceRoom?.destroy();
    this._spaceRoom = null;
    this._spaceRoomPost = null;
    this._spaceRole = null;
    this._spacePeers = null;
    this._spaceCohosts = null;
    this._spaceSpeakReqs = null;
    this._spaceRosterInfo = null;
    this._spaceHostLabel = null;
    this._spaceSpeakingAddrs = null;
    this._spaceLocalMsgs = null;
    /* Hide and clear the dock. */
    const dock = this.g('space-dock');
    if (dock) {
      dock.style.display = 'none';
      dock.innerHTML = '';
      dock.classList.remove('expanded');
      dock.classList.add('collapsed');
      dock.onclick = null;
    }
  }

  /* ── Tipping ─────────────────────────────────────────────────────────
     A tip is a plain PLS transfer TO the post author whose input is
     TIP:0x<posthash>, so any client can attribute it to the post. The
     value travels in the tx itself — no contract, no middleman. */
  openTipModal(post) {
    if (!this.signer) { utils.toast('Connect wallet to tip'); return; }
    if (post.reporter === this.state.signerAddr) { utils.toast("That's your own post"); return; }
    const author = this.state.profCache[post.reporter];
    const name = author?.username ? utils.safe(author.username) : this.trunc(post.reporter);
    const body = `
      <div style="font-size:14px;color:var(--muted);margin-bottom:14px">
        Send PLS directly to <strong style="color:var(--text)">${name}</strong>
        (${utils.safe(this.trunc(post.reporter))}) for this post. The tip is a
        normal on-chain transfer — no fees besides gas, no middleman.
      </div>
      <div class="tip-presets">
        ${[1000, 10000, 100000].map(v =>
          `<button class="settings-btn tip-preset" data-tip-preset="${v}">${v.toLocaleString()} PLS</button>`).join('')}
      </div>
      <div style="display:flex;gap:10px;margin-top:12px">
        <input type="number" id="tip-amount" min="0" step="any" placeholder="Custom amount (PLS)"
          style="flex:1;background:var(--bg-mid);border:1px solid var(--border);border-radius:10px;padding:10px 12px;color:var(--text)">
        <button class="btn-pri" id="tip-send" style="flex:0 0 auto;padding:10px 22px">Send tip</button>
      </div>
      <div id="tip-status" style="margin-top:10px;font-size:13px;color:var(--muted)"></div>`;
    this._showGenericModal('Tip 💎', body);
    document.querySelectorAll('.tip-preset').forEach(b => {
      b.onclick = () => { const inp = this.g('tip-amount'); if (inp) inp.value = b.dataset.tipPreset; };
    });
    const send = this.g('tip-send');
    if (send) send.onclick = () => this._sendTip(post);
  }

  async _sendTip(post) {
    const inp = this.g('tip-amount');
    const status = this.g('tip-status');
    const amountStr = (inp?.value || '').trim();
    const amount = Number(amountStr);
    if (!amountStr || !isFinite(amount) || amount <= 0) {
      if (status) status.textContent = '✗ Enter an amount';
      return;
    }
    if (!this._reactionBusy('tip:' + post.txHash)) return;
    const btn = this.g('tip-send');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      if (!(await this._ensureOnPulseForTx())) return;
      const value = ethers.parseEther(amountStr);
      const data  = ethers.hexlify(ethers.toUtf8Bytes(TIP_PREFIX + post.txHash));
      const txReq = { to: post.reporter, value, data };
      const gas = await this._estimateGasSafe(txReq, (data.length - 2) / 2);
      const tx = await this.signer.sendTransaction({ ...txReq, gasLimit: gas });
      if (status) status.textContent = 'Submitting to chain…';
      await tx.wait();
      this._closeGenericModal();
      utils.toast(`Tip sent — ${amount.toLocaleString()} PLS 💎`);
    } catch (err) {
      const msg = err?.message || String(err);
      const rejected = err?.code === 4001 || err?.code === 'ACTION_REJECTED' || /user (denied|rejected)/i.test(msg);
      if (status) status.textContent = rejected ? 'Cancelled' : '✗ ' + msg.slice(0, 80);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Send tip'; }
    }
  }

  _threadBack() {
    this._threadBackOverride = false;
    /* Restore previous view */
    const prev = this._prevMode || 'main';
    if (prev === 'main')         this.goHome();
    else if (prev === 'profile') {
      /* Back to the PAGE we were viewing (any author) — openProfileModal
         would wrongly open the signed-in user's own editor. */
      if (this._prevProfileAddr) this.goProfilePage(this._prevProfileAddr, this._prevProfileAddr === this.state.signerAddr);
      else this.openProfileModal();
    }
    else if (prev === 'self')    this.goSelf();
    else if (prev === 'custom') {
      this.g('custom-input').value = this._prevChannel || '';
      this.goCustom();
    } else this.goHome();
  }

  /* X-style focal-post layout for the thread page: avatar with stacked
     name/handle in the header row, full-width large body below, complete
     timestamp line, then the standard action bar. Action buttons carry the
     same data-action attributes, so the feed delegation handles them. */
  _threadHeroHTML(post, replyMap) {
    this._reviveSpace(post);
    const { picUrl, displayName, verifiedBadge } = this._postProfileFields(post);
    /* Same in-body SayIt-post-link → quote card treatment as the feed. */
    const heroText = this._applyLinkQuote(post);
    const { text: bodyHtml, images: imgHtml, embeds: embedHtml } = utils.linkify(heroText, heroText);
    const repostCard = this._postRepostCard(post);
    const d = new Date(post.timestamp);
    const timeLine = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      + ' · ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      + (post.blockNumber ? ` · Block #${post.blockNumber}` : '');
    return `
      <div class="hero-hdr">
        <a class="post-avatar-link" href="#/profile/${utils.safe(post.reporter)}"
          aria-label="View profile" tabindex="-1"><img src="${utils.safe(picUrl)}" class="post-avatar" alt=""
          loading="lazy" data-fallback-src="image1.jpeg"></a>
        <div class="hero-id">
          <span class="hero-name-row"><a class="post-name" href="#/profile/${utils.safe(post.reporter)}">${displayName}</a>${verifiedBadge}${this._chainBadge(post)}</span>
          <span class="hero-handle" role="button" tabindex="0" data-addr="${utils.safe(post.reporter)}"
            title="Click to copy address">@${this.trunc(post.reporter)}</span>
        </div>
        <button class="post-menu-btn post-tip-btn" data-action="tip" title="Tip PLS"
          aria-label="Tip the author">💎</button>
        <button class="post-menu-btn" data-action="menu" title="More options"
          aria-label="More options" aria-haspopup="menu" aria-expanded="false">${this.icon('ic-menu')}</button>
      </div>
      <div class="hero-body">${bodyHtml}</div>
      ${post.poll ? this._pollHTML(post) : ''}
      ${post.space ? this._spaceCardHTML(post) : ''}
      ${repostCard}
      ${embedHtml || ''}
      ${imgHtml ? `<div class="post-images">${imgHtml}</div>` : ''}
      <div class="note-slot" data-note-host="${utils.safe(post.txHash)}">${this._noteHTML(post)}</div>
      <a class="hero-time" href="${utils.safe(txUrl(post.chainId, post.txHash))}"
        target="_blank" rel="noopener noreferrer" title="View transaction on explorer"
       >${utils.safe(timeLine)}</a>
      ${this._postActionsHTML(post, replyMap, null, null, null)}`;
  }

  _renderThreadPage(post) {
    /* Consulted by postHTML to suppress the redundant "Replying to <focal>"
       badge on direct replies (only read in thread mode). */
    this._threadFocalHash = post.txHash;
    const replyMap = new Map();
    this.state.posts.forEach(p => {
      if (p.parentTx) replyMap.set(p.parentTx, (replyMap.get(p.parentTx) || 0) + 1);
    });
    this._postMap.set(post.txHash, post);
    const origHTML = this._threadHeroHTML(post, replyMap);

    /* Ancestor posts above the focal post — resolved by _fetchThreadAncestors
       and kept in state, so this re-render (e.g. after posting a reply) keeps
       them instead of wiping the DOM-inserted rows. Clicks are handled by the
       #feed delegated listener (the posts are in _postMap). */
    const ancestors = this.state.threadAncestors || [];
    let ancestorsHTML = '';
    if (ancestors.length) {
      ancestors.forEach(anc => {
        this._postMap.set(anc.txHash, anc);
        ancestorsHTML += `<div class="post-item thread-ancestor-item" data-txhash="${utils.safe(anc.txHash)}">${this.postHTML(anc, true, null, null)}</div>`;
      });
    }

    const replies = this.state.posts
      .filter(p => p.parentTx === post.txHash && p.postType !== 'like' && p.postType !== 'follow')
      .sort((a,b) => (a._tsMs ??= new Date(a.timestamp).getTime()) - (b._tsMs ??= new Date(b.timestamp).getTime()));

    let repliesHTML = '';
    replies.forEach((r, i) => {
      this._postMap.set(r.txHash, r);
      /* Connector position classes: first/last/only get special line
         treatment so the thread line connects cleanly between rows. */
      let posClass = '';
      if (replies.length === 1)       posClass = ' thread-only-reply';
      else if (i === 0)               posClass = ' thread-first-reply';
      else if (i === replies.length-1) posClass = ' thread-last-reply';
      repliesHTML += `<div class="post-item thread-reply-item${posClass}" data-txhash="${utils.safe(r.txHash)}">${this.postHTML(r, true, null, null)}</div>`;
    });

    /* The ancestor fetch re-renders this page and _applyPageHeader() only
       yields the header once — stash it on first render. (Never reuse a
       header already in the DOM: arriving from a profile, that's the
       profile's username header, not the thread's.) */
    if (!this._threadHeaderHTML) this._threadHeaderHTML = this._applyPageHeader();
    const threadHeader = this._threadHeaderHTML;
    /* X-canonical thread layout: original post at top, the reply composer
       directly beneath it, then the replies below. */
    const replyingToName = this.state.profCache[post.reporter]?.username
      || this.trunc(post.reporter);
    this.g('feed').innerHTML = threadHeader + `
      <div class="thread-page">
        ${ancestorsHTML}
        <div class="post-item thread-orig-item${ancestors.length ? ' has-ancestors' : ''}" data-txhash="${utils.safe(post.txHash)}"
          style="cursor:default">
          ${origHTML}
        </div>
        <div class="thread-reply-to">Replying to <span>@${utils.safe(replyingToName)}</span></div>
        <div class="thread-compose">
          <img src="${utils.safe(utils.safeUrl(this.state.profile.picUrl) || 'image1.jpeg')}"
            class="compose-avatar" alt="" data-fallback-src="image1.jpeg">
          <div style="flex:1">
            <textarea class="auto-textarea" id="thread-page-input"
              placeholder="Post your reply…" style="min-height:54px"></textarea>
            <div class="thread-compose-bar">
              <div class="compose-icons">
                <button class="cmp-icon" id="thread-media-btn" title="Add photos or video" aria-label="Add media">
                  <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 5.5C3 4.119 4.119 3 5.5 3h13C19.881 3 21 4.119 21 5.5v13c0 1.381-1.119 2.5-2.5 2.5h-13C4.119 21 3 19.881 3 18.5v-13zM5.5 5c-.276 0-.5.224-.5.5v9.086l3-3 3 3 5-5 3 3V5.5c0-.276-.224-.5-.5-.5h-13zM19 15.414l-3-3-5 5-3-3-3 3V18.5c0 .276.224.5.5.5h13c.276 0 .5-.224.5-.5v-3.086zM9.75 7C8.784 7 8 7.784 8 8.75s.784 1.75 1.75 1.75 1.75-.784 1.75-1.75S10.716 7 9.75 7z"/></svg>
                </button>
                <button class="cmp-icon" id="thread-gif-btn" title="Add a GIF" aria-label="Add GIF">
                  <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 5.5C3 4.119 4.119 3 5.5 3h13C19.881 3 21 4.119 21 5.5v13c0 1.381-1.119 2.5-2.5 2.5h-13C4.119 21 3 19.881 3 18.5v-13zM5.5 5c-.276 0-.5.224-.5.5v13c0 .276.224.5.5.5h13c.276 0 .5-.224.5-.5v-13c0-.276-.224-.5-.5-.5h-13zM8 13.5v-3h1.5v.75H11v1.5H9.5v.75H8zm4.5-3H14c.552 0 1 .448 1 1v1c0 .552-.448 1-1 1h-1.5V10.5zm1.25 1.25v.5H14v-.5h-.25zM15.5 10.5H17v1.25h-1.5v.25H17v1.25h-1.5c-.552 0-1-.448-1-1v-1.25c0-.552.448-.5 1-.5z"/></svg>
                </button>
                <button class="cmp-icon" id="thread-emoji-btn" title="Emoji" aria-label="Insert emoji">
                  <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8 9.5C8 8.672 8.672 8 9.5 8s1.5.672 1.5 1.5S10.328 11 9.5 11 8 10.328 8 9.5zm6.5 1.5c.828 0 1.5-.672 1.5-1.5S15.328 8 14.5 8 13 8.672 13 9.5s.672 1.5 1.5 1.5zM12 16c-2.224 0-3.021-1.4-3.094-1.536l-1.76.992C7.196 15.69 8.638 18 12 18s4.804-2.31 4.854-2.544l-1.76-.992C15.021 14.6 14.224 16 12 16zm-.002-14C6.477 2 2 6.477 2 12s4.477 10 9.998 10C17.523 22 22 17.523 22 12S17.523 2 11.998 2zM12 20C7.582 20 4 16.418 4 12s3.582-8 8-8 8 3.582 8 8-3.582 8-8 8z"/></svg>
                </button>
              </div>
              <button class="btn-pri" id="thread-page-reply-btn" style="padding:8px 20px">Reply</button>
            </div>
          </div>
        </div>
        ${repliesHTML ? '' : ''}
        <div id="thread-replies-page">
          ${repliesHTML || '<div class="prof-empty" style="padding:40px 32px"><span>💬</span><h3>No replies yet</h3><p>Be the first to reply.</p></div>'}
        </div>
        <div id="thread-loading-page" style="display:none;padding:16px;text-align:center;color:var(--muted);font-size:14px">
          <span class="spinner sp-sm" aria-hidden="true"></span>Fetching replies from chain…
        </div>
      </div>`;

    /* Back button: handled by the global nav-back delegate → _navBack(),
       which routes to _threadBack() while _threadBackOverride is set. A
       direct onclick here double-fired with the delegate. */

    /* Wire thread compose */
    const input = document.getElementById('thread-page-input');
    const btn   = document.getElementById('thread-page-reply-btn');
    if (input) input.oninput = () => utils.autoGrow(input);
    if (btn) btn.onclick = () => this._postThreadPageReply(post, input);
    /* Thread compose toolbar — media/gif insert a URL into the reply box,
       emoji opens the picker targeting the thread input. */
    const tMedia = document.getElementById('thread-media-btn');
    const tGif   = document.getElementById('thread-gif-btn');
    const tEmoji = document.getElementById('thread-emoji-btn');
    const insertIntoThread = (text) => {
      if (!input) return;
      const pos = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, pos) + text + input.value.slice(pos);
      input.focus(); utils.autoGrow(input);
    };
    if (tMedia) tMedia.onclick = () => {
      const url = prompt('Paste an image, GIF, or video URL:');
      if (url && url.trim()) insertIntoThread((input.value ? ' ' : '') + url.trim());
    };
    if (tGif) tGif.onclick = () => {
      const url = prompt('Paste a GIF URL:');
      if (url && url.trim()) insertIntoThread((input.value ? ' ' : '') + url.trim());
    };
    if (tEmoji) tEmoji.onclick = () => this._openEmojiPickerFor(input, tEmoji);

    /* Wire click delegation on replies */
    const repliesEl = document.getElementById('thread-replies-page');
    if (repliesEl) repliesEl.addEventListener('click', e => this.onFeedClick(e, true));
    const origEl = this.g('feed').querySelector('.thread-orig-item');
    if (origEl) origEl.addEventListener('click', e => this.onFeedClick(e, true));
    this._tallyVisiblePolls();
    /* Gather community notes so the "Readers added context" card / proposed
       marker shows on the thread's posts too. */
    this._scanChannelNotes();
  }

  async _postThreadPageReply(post, inputEl) {
    const text = inputEl?.value.trim();
    if (!text) return;
    const ok = await this.publish(text, post.txHash, post.to);
    if (ok) {
      inputEl.value = '';
      inputEl.style.height = '';
      /* Re-render thread with new reply */
      this._renderThreadPage(post);
    }
  }

  async fetchThreadReplies(post) {
    const loadingEl = document.getElementById('thread-loading-page');
    if (loadingEl) loadingEl.style.display = 'block';

    const targetHash = post.txHash;
    const scanAddr   = post.to || this.state.channel;
    const known      = new Set(this.state.posts.map(p => p.txHash));
    const newFound   = [];
    try {
      for (let page = 1; page <= 5; page++) {
        let raw;
        try { raw = await this.apiFetch(scanAddr, page); }
        catch { break; }
        raw.forEach(tx => {
          if (!tx.input || tx.input === '0x') return;
          try {
            const text = ethers.toUtf8String(tx.input).trim();
            const m    = text.match(/^REPLY_TO:(0x[a-f0-9]{64})\n\n/i);
            if (!m || m[1].toLowerCase() !== targetHash) return;
            const display = text.slice(m[0].length).trim();
            if (!display) return;
            const hash = tx.hash.toLowerCase();
            if (known.has(hash)) return;
            known.add(hash);
            newFound.push({
              content: text, display, parentTx: targetHash, direction: null,
              postType: 'post', reactionTarget: null, repostOf: null,
              reporter: tx.from?.toLowerCase(), to: tx.to?.toLowerCase() ?? null,
              timestamp: tx.timeStamp ? new Date(Number(tx.timeStamp)*1000).toISOString() : new Date().toISOString(),
              txHash: hash, channel: scanAddr, mode: post.mode,
            });
          } catch { /* skip */ }
        });
        if (raw.length < 50) break;
      }
    } finally {
      if (loadingEl) loadingEl.style.display = 'none';
    }

    if (newFound.length > 0) {
      this.state.posts = [...this.state.posts, ...newFound]
        .sort((a, b) => (b._tsMs ??= new Date(b.timestamp).getTime()) - (a._tsMs ??= new Date(a.timestamp).getTime()))
        .slice(0, this._getPostCap());
      if (this._postHashSet) newFound.forEach(p => this._postHashSet.add(p.txHash));
      await this.cache.savePosts(newFound);
      if (this.state.threadPost?.txHash === targetHash && this.state.mode === 'thread') {
        this._renderThreadPage(post);
      }
    }
  }

  /* ── Media attach ───────────────────────────────────────────────────── */
  openMediaModal(type, targetEl) {
    this._mediaType = type;
    /* Optional insert target (e.g. the Channels chat box). Null = the main
       composer, preserving the original behavior. */
    this._mediaTarget = targetEl || null;
    const title   = this.g('media-modal-title');
    const hint    = this.g('media-url-hint');
    const preview = this.g('media-preview-area');
    if (type === 'gif') {
      title.textContent = 'Add a GIF';
      hint.textContent  = 'Paste any GIF URL (https:// or ipfs://)';
    } else if (type === 'video') {
      title.textContent = 'Add Video';
      hint.textContent  = 'Paste a YouTube, Vimeo, or direct .mp4 / .webm URL';
    } else if (type === 'media') {
      /* Merged photos + video, like X's Media button. Type is detected
         from the URL at preview/attach time. */
      title.textContent = 'Add photos or video';
      hint.textContent  = 'Paste an image, GIF, or video URL — https://, ipfs://, or arweave://';
    } else {
      title.textContent = 'Add Image';
      hint.textContent  = 'Paste any image URL (https://, ipfs://, or arweave://)';
    }
    this.g('media-url-input').value = '';
    preview.innerHTML = '';
    preview.style.display = 'none';
    this.g('media-modal').classList.add('open');
    this._trapFocus(this.g('media-modal'));
    setTimeout(() => this.g('media-url-input').focus(), 80);
  }

  _resolveMediaUrl(raw) {
    if (!raw) return '';
    if (raw.startsWith('ipfs://'))     return 'https://ipfs.io/ipfs/' + raw.slice(7);
    if (raw.startsWith('ar://'))       return 'https://arweave.net/' + raw.slice(5);
    if (raw.startsWith('arweave://'))  return 'https://arweave.net/' + raw.slice(10);
    return raw;
  }

  _previewMedia() {
    const raw     = this.g('media-url-input').value.trim();
    const preview = this.g('media-preview-area');
    if (!raw) { preview.innerHTML = ''; preview.style.display = 'none'; return; }
    const resolved = this._resolveMediaUrl(raw);
    preview.style.display = 'block';
    /* Detect video (YouTube/Vimeo/direct file) vs image so the preview
       shows something sensible for each. */
    const isVideo = /\.(mp4|webm|mov|m4v)(\?|$)/i.test(resolved)
      || /youtube\.com|youtu\.be|vimeo\.com/i.test(resolved);
    if (isVideo) {
      preview.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:14px;
          border:1px solid var(--border);border-radius:12px;background:var(--bg-mid)">
          <svg viewBox="0 0 24 24" width="28" height="28" style="flex-shrink:0;color:var(--primary-lt)">
            <path fill="currentColor" d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>
          <div style="min-width:0">
            <div style="font-weight:700;font-size:14px">Video attached</div>
            <div style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${utils.safe(resolved)}</div>
          </div>
        </div>`;
      return;
    }
    preview.innerHTML = `
      <img src="${utils.safe(resolved)}" alt="preview" style="
        max-width:100%; max-height:220px; border-radius:12px;
        object-fit:contain; display:block; margin:0 auto;
        border:1px solid var(--border);">`;
    /* CSP-strict error handling: swap the broken preview for a note. */
    preview.querySelector('img')?.addEventListener('error', function () {
      this.replaceWith(Object.assign(document.createElement('p'), {
        textContent: '⚠ Could not load preview — the URL will still post',
        style: 'color:var(--muted);font-size:13px;text-align:center;padding:12px',
      }));
    }, { once: true });
  }

  _attachMedia() {
    const raw = this.g('media-url-input').value.trim();
    if (!raw) { utils.toast('Enter a URL first'); return; }
    /* Append the ORIGINAL URL (ipfs:// etc.) to the target box on a new line.
       linkify() resolves it for display. On-chain the raw URL is preserved. */
    const compose = this._mediaTarget || this.g('compose-text');
    const existing = compose.value;
    compose.value = existing
      ? existing.trimEnd() + '\n' + raw
      : raw;
    utils.autoGrow(compose);
    if (this._mediaTarget) {
      /* Custom target (e.g. the Channels chat box) — fire its own oninput so
         its Post button enables / it re-measures, instead of the main
         composer's char-count + draft save. */
      this._mediaTarget.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      utils.updateCharCount(compose, null);
      this._saveDraft();
    }
    this.closeModal('media-modal');
    utils.toast('Media attached ✓');
  }

  /* Lightweight generic modal — used by the list editor. Builds a modal
     overlay on the fly with a title, arbitrary body HTML, and a close
     button. Reuses the existing .modal-bg / .modal styles. */
  _showGenericModal(title, bodyHTML) {
    this._closeGenericModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-bg open';
    overlay.id = 'generic-modal';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${utils.safe(title)}">
        <div class="modal-head">
          <span class="modal-title">${utils.safe(title)}</span>
          <button class="modal-close" aria-label="Close" id="generic-modal-close">✕</button>
        </div>
        <div>${bodyHTML}</div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('generic-modal-close').onclick = () => this._closeGenericModal();
    overlay.addEventListener('click', e => { if (e.target === overlay) this._closeGenericModal(); });
    this._trapFocus(overlay);
  }
  _closeGenericModal() {
    const m = document.getElementById('generic-modal');
    if (m) { this._releaseFocus(m); m.remove(); }
  }

  /* "About this post" — surfaces metadata that's otherwise only visible on a
     block explorer: which channel/address it was posted to, the author, the
     content type, block number, and the tx. All of this already lives on the
     post object, so there's no fetching. */
  _showAboutPost(post) {
    const esc = s => utils.safe(s);
    const row = (label, value) => `<div style="display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid var(--border)">
      <span style="color:var(--muted);flex-shrink:0">${label}</span>
      <span style="text-align:right;word-break:break-word">${value}</span></div>`;
    const chan   = (post.to || post.channel || '').toLowerCase();
    const isMain = chan && chan === MAIN_CHANNEL.toLowerCase();
    const chanName = chan && this.state.profCache[chan]?.username;
    let chanVal;
    if (!chan)        chanVal = '—';
    else if (isMain)  chanVal = 'Main feed';
    else {
      const label = (chanName ? esc(chanName) + ' · ' : '') + esc(this.trunc(chan));
      chanVal = `<a href="#" style="color:var(--primary-lt)" data-act="modal-open-channel" data-act-arg="${esc(chan)}">${label} ↗</a>`;
    }
    const typeMap = { post:'Post', reply:'Reply', poll:'Poll', repost:'Repost' };
    const authorName = this.state.profCache[post.reporter]?.username;
    const author = (authorName ? esc(authorName) + ' · ' : '') + '@' + esc(this.trunc(post.reporter));
    let body = `<div style="font-size:14px;line-height:1.45;padding:4px 2px">`;
    body += row('Type',      esc(typeMap[post.postType] || 'Post'));
    body += row('Posted to', chanVal);
    body += row('Author',    author);
    body += row('Posted',    esc(new Date(post.timestamp).toLocaleString()));
    if (post.blockNumber) body += row('Block',     '#' + esc(String(post.blockNumber)));
    if (post.parentTx)    body += row('Reply to',  esc(this.trunc(post.parentTx)));
    if (post.repostOf)    body += row('Repost of', esc(this.trunc(post.repostOf)));
    body += row('Transaction', `<a href="${esc(txUrl(post.chainId, post.txHash))}" target="_blank" rel="noopener noreferrer" style="color:var(--primary-lt)">${esc(this.trunc(post.txHash))} ↗</a>`);
    body += `</div>`;
    this._showGenericModal('About this post', body);
  }

  /* Lazily snapshot the persisted profiles store into memory so handle search
     covers profiles cached in past sessions, not just this one. Loaded once;
     profiles discovered this session are already in profCache (also searched). */
  _ensureProfileSnapshot() {
    if (this._profileSnapshot !== undefined) return;
    this._profileSnapshot = null; /* loading */
    this.cache.getAllProfiles()
      .then(list => { this._profileSnapshot = (list || []).map(p => ({
        addr: (p.address || '').toLowerCase(), username: p.username || '', picUrl: p.picUrl || 'image1.jpeg' })); })
      .catch(() => { this._profileSnapshot = []; });
  }

  /* Open the emoji picker targeting a specific textarea (e.g. the thread
     reply box). Lightweight wrapper that temporarily points insertion at
     the given element. */
  _openEmojiPickerFor(targetEl, anchorBtn) {
    this._emojiTarget = targetEl;
    this._emojiAnchor = anchorBtn;
    this.toggleEmojiPicker();
  }

  /* ── Emoji picker ───────────────────────────────────────────────────── */
  toggleEmojiPicker() {
    const existing = document.getElementById('emoji-picker-pop');
    if (existing) { existing.remove(); return; }

    /* Categorized emoji set — X-parity coverage of the common Unicode set
       (~1200 glyphs). The first "Crypto" group is our own addon of trading
       favourites kept up front; the remaining 8 mirror X's picker order:
       Smileys & People, Animals & Nature, Food & Drink, Activity,
       Travel & Places, Objects, Symbols, Flags. A handful of glyphs appear
       in more than one group on purpose (e.g. crypto favourites also live in
       their natural category, and sports figures live in both Activity and
       People) — X does the same.

       The picker stays OPEN after each selection so the user can insert
       several in a row (X behavior). Closes on the ✕ button, Escape, or an
       outside click. */
    const categories = [
      { name: 'Crypto', emojis: ['💎','🚀','🌙','📈','💰','🪙','⛓️','🔗','🛡️','🐂','🐻','🔥','💯'] },
      { name: 'Smileys & People', emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','🫠','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🫢','🫣','🤫','🤔','🫡','🤐','🤨','😐','😑','😶','🫥','😶‍🌫️','😏','😒','🙄','😬','😮‍💨','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','😵‍💫','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','🫤','😟','🙁','☹️','😮','😯','😲','😳','🥺','🥹','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾','👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','👀','👁️','👅','👄','🫦','🦷','👂','🦻','👃','🧠','🫀','🫁','🦴','👶','🧒','👦','👧','🧑','👨','👩','🧓','👴','👵','🧔','👮','🕵️','💂','👷','🤴','👸','👳','👲','🧕','🤵','👰','🤰','🤱','👼','🎅','🤶','🦸','🦹','🧙','🧚','🧛','🧜','🧝','🧞','🧟','💆','💇','🚶','🧍','🧎','🏃','💃','🕺','👯','🧖','🧗','🤺','🏇','⛷️','🏂','🏌️','🏄','🚣','🏊','⛹️','🏋️','🚴','🚵','🤸','🤼','🤽','🤾','🤹','🧘','🛀','🛌'] },
      { name: 'Animals & Nature', emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐽','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷️','🕸️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦣','🦛','🦏','🐪','🐫','🦒','🦘','🦬','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐈','🐈‍⬛','🪶','🐓','🦃','🦤','🦚','🦜','🦢','🦩','🕊️','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿️','🦔','🐉','🐲','🌵','🎄','🌲','🌳','🌴','🪵','🌱','🌿','☘️','🍀','🎍','🪴','🎋','🍃','🍂','🍁','🍄','🐚','🪨','🌾','💐','🌷','🌹','🥀','🌺','🌸','🌼','🌻','☀️','🌝','🌞','🌛','🌜','🌚','🌕','🌖','🌗','🌘','🌑','🌒','🌓','🌔','🌙','🌎','🌍','🌏','🪐','💫','⭐','🌟','✨','⚡','☄️','💥','🔥','🌪️','🌈','☁️','🌤️','⛅','🌥️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌬️','💨','💧','💦','🌊','🌫️'] },
      { name: 'Food & Drink', emojis: ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🦴','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🥛','🍼','🫖','☕','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🧉','🍾','🧊','🥄','🍴','🍽️','🥣','🥡','🥢','🧂'] },
      { name: 'Activity', emojis: ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🏑','🥍','🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🏂','🪂','🏋️','🤼','🤸','⛹️','🤺','🤾','🏌️','🏇','🧘','🏄','🏊','🤽','🚣','🧗','🚵','🚴','🏆','🥇','🥈','🥉','🏅','🎖️','🏵️','🎗️','🎫','🎟️','🎪','🤹','🎭','🩰','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🎷','🎺','🪗','🎸','🪕','🎻','🎲','♟️','🎯','🎳','🎮','🎰','🧩'] },
      { name: 'Travel & Places', emojis: ['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🦯','🦽','🦼','🛴','🚲','🛵','🏍️','🛺','🚨','🚔','🚍','🚘','🚖','🚡','🚠','🚟','🚃','🚋','🚞','🚝','🚄','🚅','🚈','🚂','🚆','🚇','🚊','🚉','✈️','🛫','🛬','🛩️','💺','🛰️','🚀','🛸','🚁','🛶','⛵','🚤','🛥️','🛳️','⛴️','🚢','⚓','🪝','⛽','🚧','🚦','🚥','🗺️','🗿','🗽','🗼','🏰','🏯','🏟️','🎡','🎢','🎠','⛲','⛱️','🏖️','🏝️','🏜️','🌋','⛰️','🏔️','🗻','🏕️','⛺','🛖','🏠','🏡','🏘️','🏚️','🏗️','🏭','🏢','🏬','🏣','🏤','🏥','🏦','🏨','🏪','🏫','🏩','💒','🏛️','⛪','🕌','🕍','🛕','🕋','⛩️','🌁','🌃','🏙️','🌄','🌅','🌆','🌇','🌉','🎑','🌌','🧭'] },
      { name: 'Objects', emojis: ['⌚','📱','📲','💻','⌨️','🖥️','🖨️','🖱️','🖲️','🕹️','🗜️','💽','💾','💿','📀','📼','📷','📸','📹','🎥','📽️','🎞️','📞','☎️','📟','📠','📺','📻','🎙️','🎚️','🎛️','🧭','⏱️','⏲️','⏰','🕰️','⌛','⏳','📡','🔋','🪫','🔌','💡','🔦','🕯️','🪔','🧯','🛢️','💸','💵','💴','💶','💷','🪙','💰','💳','🧾','💎','⚖️','🪜','🧰','🪛','🔧','🔨','⚒️','🛠️','⛏️','🪚','🔩','⚙️','🪤','🧲','🔫','💣','🧨','🪓','🔪','🗡️','⚔️','🛡️','🚬','⚰️','🪦','⚱️','🏺','🔮','📿','🧿','💈','⚗️','🔭','🔬','🕳️','🩹','🩺','💊','💉','🩸','🧬','🦠','🧫','🧪','🌡️','🧹','🪠','🧺','🧻','🚽','🚰','🚿','🛁','🛀','🧼','🪥','🪒','🧽','🪣','🧴','🛎️','🔑','🗝️','🚪','🪑','🛋️','🛏️','🛌','🧸','🪆','🖼️','🪞','🪟','🛍️','🛒','🎁','🎈','🎏','🎀','🪄','🪅','🎊','🎉','🎎','🏮','🎐','🧧','✉️','📩','📨','📧','💌','📥','📤','📦','🏷️','📪','📫','📬','📭','📮','📯','📜','📃','📄','📑','📊','📈','📉','🗒️','🗓️','📆','📅','🗑️','📇','🗃️','🗳️','🗄️','📋','📁','📂','🗂️','🗞️','📰','📓','📔','📒','📕','📗','📘','📙','📚','📖','🔖','🧷','🔗','📎','🖇️','📐','📏','🧮','📌','📍','✂️','🖊️','🖋️','✒️','🖌️','🖍️','📝','✏️','🔍','🔎','🔏','🔐','🔒','🔓'] },
      { name: 'Symbols', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','♥️','💌','💋','💯','💢','💥','💫','💦','💨','🕳️','💬','👁️‍🗨️','🗨️','🗯️','💭','💤','✅','❌','⭕','🚫','💮','♨️','🛑','🕛','✔️','☑️','✖️','➕','➖','➗','✳️','✴️','❇️','‼️','⁉️','❓','❔','❕','❗','〰️','©️','®️','™️','#️⃣','*️⃣','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','🔢','▶️','⏸️','⏯️','⏹️','⏺️','⏭️','⏮️','⏩','⏪','🔼','🔽','⏫','⏬','◀️','🔀','🔁','🔂','🔃','🔄','➡️','⬅️','⬆️','⬇️','↗️','↘️','↙️','↖️','↕️','↔️','↩️','↪️','⤴️','⤵️','🔝','🔚','🔙','🔛','🔜','🆗','🆕','🆒','🆓','🆙','🆖','🆎','🅰️','🅱️','🅾️','🆔','💲','💱','♻️','⚜️','🔱','📛','🔰','✨','🌟','⭐','🌠','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','⛎','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛓️','♾️','⚡','⚠️','🚸','🔔','🔕','🎵','🎶','〽️','⚛️','🉑','☢️','☣️','📴','📳','🆚','🅿️','🔣','ℹ️','🔤','🔡','🔠','💠','🔘','🔳','🔲','◾','◽','◼️','◻️','⬛','⬜','🟥','🟧','🟨','🟩','🟦','🟪','🟫','🔴','🟠','🟡','🟢','🔵','🟣','🟤','⚫','⚪'] },
      { name: 'Flags', emojis: ['🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️','🇺🇸','🇬🇧','🇨🇦','🇦🇺','🇩🇪','🇫🇷','🇪🇸','🇮🇹','🇯🇵','🇰🇷','🇨🇳','🇮🇳','🇧🇷','🇲🇽','🇷🇺','🇳🇱','🇸🇪','🇳🇴','🇨🇭','🇸🇬','🇦🇪','🇸🇦','🇿🇦','🇦🇷','🇵🇹','🇮🇪','🇵🇱','🇹🇷','🇮🇩','🇹🇭','🇵🇭','🇻🇳','🇳🇿','🇧🇪','🇦🇹','🇩🇰','🇫🇮','🇬🇷'] },
    ];

    /* Lightweight keyword → emoji index for search. Emoji carry no names in
       this codebase, so we keep a compact map for common search terms. Each
       value is an ARRAY of emoji strings (proper graphemes — not a packed
       string, which would split variation selectors). A search query matches
       a term when the term *includes* the typed text; results are the union
       of those terms' emoji plus any emoji whose category name matches. */
    const KW = {
      smile:['😀','😃','😄','😁','😊','🙂','😺'], happy:['😀','😃','😄','😁','😆','😊','🥰','😍','🤩'],
      laugh:['😂','🤣','😆','😹'], sad:['😢','😭','😔','🙁','☹️','😞'], cry:['😢','😭','😿'],
      angry:['😠','😡','🤬','👿'], love:['❤️','🥰','😍','😘','💕','💞','💖','💝'], kiss:['😘','😗','😚','💋'],
      wink:['😉'], cool:['😎','🆒'], nerd:['🤓','🧐'], sick:['🤒','🤕','🤢','🤮','🤧','😷'],
      sleep:['😴','😪','🥱','💤'], think:['🤔','🧐'], wow:['😮','😯','😲','🤯'], party:['🥳','🎉','🎊','🎈'],
      rich:['🤑','💰','💵'], clown:['🤡'], ghost:['👻'], alien:['👽','👾','🛸'], robot:['🤖'],
      skull:['💀','☠️'], poop:['💩'], devil:['😈','👿'], cat:['🐱','🐈','😺','😸','😹','😻'],
      dog:['🐶','🐕','🦮','🐩'], fox:['🦊'], bear:['🐻','🐻‍❄️'], panda:['🐼'], lion:['🦁'],
      tiger:['🐯','🐅'], monkey:['🐵','🐒','🙈','🙉','🙊'], pig:['🐷','🐽','🐖'], cow:['🐮','🐄','🐂'],
      horse:['🐴','🐎','🦄'], unicorn:['🦄'], bird:['🐦','🐤','🐣','🐥','🦅','🦉','🦆'],
      fish:['🐟','🐠','🐡','🐬','🐳','🐋','🦈'], bug:['🐛','🐝','🦋','🐞','🐜'], snake:['🐍'], dragon:['🐉','🐲'],
      flower:['🌸','🌺','🌻','🌹','🌷','🌼','💐','🥀'], tree:['🌲','🌳','🌴','🌵','🎄'],
      plant:['🌱','🌿','☘️','🍀','🪴'], leaf:['🍃','🍂','🍁'], sun:['☀️','🌞','🌝'],
      moon:['🌙','🌚','🌛','🌜','🌕'], star:['⭐','🌟','✨','🌠'], fire:['🔥'], water:['💧','💦','🌊'],
      wave:['🌊','👋'], rain:['🌧️','⛈️','☔'], snow:['❄️','☃️','⛄','🌨️'], cloud:['☁️','🌤️','⛅'],
      rainbow:['🌈'], lightning:['⚡','🌩️'], earth:['🌍','🌎','🌏'], apple:['🍎','🍏'], banana:['🍌'],
      grape:['🍇'], strawberry:['🍓'], orange:['🍊'], lemon:['🍋'], watermelon:['🍉'], pizza:['🍕'],
      burger:['🍔'], fries:['🍟'], taco:['🌮','🌯'], cake:['🍰','🎂','🧁'], cookie:['🍪'], donut:['🍩'],
      icecream:['🍦','🍨','🍧'], coffee:['☕'], tea:['🍵','🫖'], beer:['🍺','🍻'], wine:['🍷','🍸','🥂','🍾'],
      drink:['🍺','🍷','🥤','🧋','☕'], food:['🍔','🍕','🍟','🌮','🍜','🍣'], meat:['🍖','🍗','🥩','🥓'],
      egg:['🥚','🍳'], bread:['🍞','🥐','🥖','🥯'], sushi:['🍣','🍱'], soccer:['⚽'], football:['🏈','⚽'],
      basketball:['🏀'], baseball:['⚾'], tennis:['🎾'], golf:['⛳','🏌️'], game:['🎮','🕹️','🎲','🎯','🎰'],
      dice:['🎲'], target:['🎯'], trophy:['🏆'], medal:['🥇','🥈','🥉','🏅'],
      music:['🎵','🎶','🎸','🎹','🎺','🥁'], guitar:['🎸'], art:['🎨'], movie:['🎬','🎥','📽️'],
      mic:['🎤','🎙️'], book:['📚','📖','📕','📗','📘','📙'], car:['🚗','🚕','🚙','🏎️'], bus:['🚌','🚎'],
      train:['🚂','🚆','🚄','🚇','🚊'], plane:['✈️','🛫','🛬'], rocket:['🚀'], boat:['⛵','🚤','🛳️','🚢'],
      bike:['🚲','🚴'], truck:['🚚','🚛','🛻'], house:['🏠','🏡','🏘️'], building:['🏢','🏬','🏛️'],
      city:['🏙️','🌆','🌃'], castle:['🏰','🏯'], beach:['🏖️','🏝️'], mountain:['⛰️','🏔️','🗻','🌋'],
      volcano:['🌋'], map:['🗺️','🧭'], flag:['🏁','🚩','🏴','🏳️'], phone:['📱','📲','☎️','📞'],
      computer:['💻','🖥️','⌨️','🖱️'], camera:['📷','📸','📹','🎥'], tv:['📺'], clock:['⏰','🕰️','⏳','⌛'],
      light:['💡','🔦','🕯️'], battery:['🔋','🪫'], money:['💰','💵','💴','💶','💷','💸','💳','🪙','🤑'],
      diamond:['💎'], gem:['💎'], coin:['🪙'], key:['🔑','🗝️'], lock:['🔒','🔓','🔐'],
      tool:['🔧','🔨','🛠️','⚙️'], gear:['⚙️'], bomb:['💣','🧨'], gift:['🎁'],
      heart:['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💕','💞','💓','💗','💖','💘','💝','💟','♥️','💔'],
      check:['✅','✔️','☑️'], cross:['❌','✖️'], warning:['⚠️','🚸'], question:['❓','❔'],
      exclamation:['❗','❕','‼️','⁉️'], hundred:['💯'], sparkle:['✨','🌟'], recycle:['♻️'],
      peace:['☮️','✌️'], zodiac:['♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓'],
      arrow:['➡️','⬅️','⬆️','⬇️','↗️','↘️','↙️','↖️','🔝'],
      number:['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','🔢'],
      thumbsup:['👍'], thumbsdown:['👎'], ok:['👌','🆗'], clap:['👏','🙌'], pray:['🙏'],
      muscle:['💪','🦾'], point:['👈','👉','👆','👇','☝️'], fist:['✊','👊','🤛','🤜'],
      hand:['✋','🖐️','🤚','👋'], eye:['👀','👁️'], bull:['🐂'], chain:['⛓️','🔗'], shield:['🛡️'],
      up:['📈','⬆️','🔝'], down:['📉','⬇️'],
    };

    const picker = document.createElement('div');
    picker.id = 'emoji-picker-pop';
    picker.style.cssText = `
      position:absolute; z-index:600;
      background:var(--bg-mid); border:1px solid var(--border);
      border-radius:16px; padding:0;
      width:340px; max-height:420px; display:flex; flex-direction:column;
      box-shadow:0 8px 32px rgba(0,0,0,0.5);
      animation:popIn 0.15s ease; overflow:hidden;`;

    /* Header with title + close button */
    const header = document.createElement('div');
    header.style.cssText = `
      display:flex; align-items:center; justify-content:space-between;
      padding:10px 12px; border-bottom:1px solid var(--border);
      flex-shrink:0;`;
    header.innerHTML = `<span style="font-weight:800;font-size:14px">Emoji</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Close emoji picker');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
      border:none; background:transparent; color:var(--muted);
      font-size:16px; cursor:pointer; width:28px; height:28px;
      border-radius:50%; transition:background 0.12s;`;
    closeBtn.onmouseenter = () => closeBtn.style.background = 'var(--surface-2)';
    closeBtn.onmouseleave = () => closeBtn.style.background = 'transparent';
    closeBtn.onclick = () => removePicker();
    header.appendChild(closeBtn);
    picker.appendChild(header);

    /* Search box — filters the grid as you type (X has one). */
    const searchWrap = document.createElement('div');
    searchWrap.style.cssText = `padding:8px 10px; border-bottom:1px solid var(--border); flex-shrink:0;`;
    const search = document.createElement('input');
    search.id = 'emoji-search';
    search.type = 'text';
    search.placeholder = 'Search emoji';
    search.setAttribute('aria-label', 'Search emoji');
    search.style.cssText = `
      width:100%; box-sizing:border-box; padding:7px 10px;
      background:var(--bg-card); border:1px solid var(--border);
      border-radius:9999px; color:var(--text); font-size:13px;
      font-family:inherit; outline:none;`;
    searchWrap.appendChild(search);
    picker.appendChild(searchWrap);

    /* Category quick-jump tabs (X-style). Each scrolls its section into
       view; the row scrolls horizontally if it overflows. */
    const tabs = document.createElement('div');
    tabs.style.cssText = `
      display:flex; gap:2px; padding:6px 8px; border-bottom:1px solid var(--border);
      overflow-x:auto; flex-shrink:0; scrollbar-width:none;`;
    picker.appendChild(tabs);

    /* Scrollable body with category sections */
    const body = document.createElement('div');
    body.style.cssText = `overflow-y:auto; padding:8px 10px 12px; flex:1;`;

    const insertEmoji = (em) => {
      /* If a custom target was set (thread reply box), insert there. modalOpen
         must be declared at function scope — it's read again below for the
         char-count target. (It was block-scoped inside the if, which threw
         "modalOpen is not defined" on every emoji insert.) */
      let compose = this._emojiTarget || null;
      const modalOpen = !compose && this.g('compose-modal')?.classList.contains('open');
      if (!compose) {
        compose = modalOpen ? this.g('modal-compose-text') : this.g('compose-text');
      }
      if (!compose) return;
      const pos = compose.selectionStart ?? compose.value.length;
      compose.value = compose.value.slice(0,pos) + em + compose.value.slice(pos);
      compose.selectionStart = compose.selectionEnd = pos + em.length;
      compose.focus();
      utils.autoGrow(compose);
      utils.updateCharCount(compose, modalOpen ? this.g('modal-char-count') : null);
      this._saveDraft();
      /* Re-sync the Post button enable-state — inserting an emoji counts as
         content, so the button must light up even if the user never typed.
         For custom targets (thread/reply boxes) fire a synthetic input event
         so that target's own oninput enable-logic runs too. */
      this._syncPostBtn();
      if (this._emojiTarget) this._emojiTarget.dispatchEvent(new Event('input', { bubbles: true }));
      /* Picker intentionally stays open for multi-select. */
    };

    /* Track each section so search can hide/show whole categories and the
       tabs can scroll to them. */
    const sections = [];

    categories.forEach(cat => {
      const section = document.createElement('div');

      const label = document.createElement('div');
      label.className = 'emoji-cat-label';
      label.textContent = cat.name;
      label.style.cssText = `
        font-size:11px; font-weight:700; color:var(--muted);
        text-transform:uppercase; letter-spacing:0.5px;
        margin:8px 2px 4px;`;
      section.appendChild(label);

      const grid = document.createElement('div');
      grid.style.cssText = `display:grid; grid-template-columns:repeat(8,1fr); gap:2px;`;
      const btns = [];
      cat.emojis.forEach(em => {
        const btn = document.createElement('button');
        btn.textContent = em;
        btn.type = 'button';
        btn.dataset.emoji = em;
        btn.style.cssText = `
          width:100%; aspect-ratio:1; border:none; background:transparent;
          border-radius:8px; font-size:20px; cursor:pointer;
          transition:background 0.1s; line-height:1; padding:0;`;
        btn.onmouseenter = () => btn.style.background = 'var(--surface-2)';
        btn.onmouseleave = () => btn.style.background = 'transparent';
        btn.onclick = (e) => { e.stopPropagation(); insertEmoji(em); };
        grid.appendChild(btn);
        btns.push(btn);
      });
      section.appendChild(grid);
      body.appendChild(section);
      sections.push({ name: cat.name, section, btns });

      /* Quick-jump tab for this category. */
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.textContent = cat.emojis[0] || cat.name.slice(0, 1);
      tab.title = cat.name;
      tab.setAttribute('aria-label', cat.name);
      tab.style.cssText = `
        flex:0 0 auto; border:none; background:transparent; cursor:pointer;
        font-size:17px; line-height:1; padding:5px 7px; border-radius:8px;
        transition:background 0.1s;`;
      tab.onmouseenter = () => tab.style.background = 'var(--surface-2)';
      tab.onmouseleave = () => tab.style.background = 'transparent';
      tab.onclick = (e) => {
        e.stopPropagation();
        search.value = '';
        applyFilter('');
        section.scrollIntoView({ block: 'start' });
      };
      tabs.appendChild(tab);
    });
    picker.appendChild(body);

    /* Search filter: empty → everything; otherwise the union of keyword
       matches plus emoji in any category whose name matches the query. */
    let noResults = null;
    const applyFilter = (raw) => {
      const q = raw.trim().toLowerCase();
      if (!q) {
        sections.forEach(s => {
          s.section.style.display = '';
          s.btns.forEach(b => { b.style.display = ''; });
        });
        if (noResults) noResults.style.display = 'none';
        return;
      }
      const allowed = new Set();
      for (const term in KW) {
        if (term.includes(q)) KW[term].forEach(e => allowed.add(e));
      }
      let anyShown = false;
      sections.forEach(s => {
        const catMatch = s.name.toLowerCase().includes(q);
        let shown = 0;
        s.btns.forEach(b => {
          const ok = catMatch || allowed.has(b.dataset.emoji);
          b.style.display = ok ? '' : 'none';
          if (ok) shown++;
        });
        s.section.style.display = shown ? '' : 'none';
        if (shown) anyShown = true;
      });
      if (!noResults) {
        noResults = document.createElement('div');
        noResults.textContent = 'No emoji found';
        noResults.style.cssText = `
          padding:18px 8px; text-align:center; color:var(--muted); font-size:13px;`;
        body.appendChild(noResults);
      }
      noResults.style.display = anyShown ? 'none' : '';
    };
    search.addEventListener('input', () => applyFilter(search.value));
    /* Don't let clicks inside the search bubble to the outside-close handler. */
    search.addEventListener('click', e => e.stopPropagation());

    /* Position below the emoji button (use a custom anchor if one was set
       via _openEmojiPickerFor, e.g. the thread reply toolbar). Clamp to the
       viewport so the wider/taller picker never spills off-screen — flip it
       above the button if there isn't room below. */
    const emojiBtn = this._emojiAnchor || this.g('cmp-emoji-btn');
    const rect = emojiBtn.getBoundingClientRect();
    const PW = 340, MAXH = 420, M = 8;
    const left = Math.max(M, Math.min(rect.left - 140, window.innerWidth - PW - M));
    const spaceBelow = window.innerHeight - rect.bottom;
    const wantH = Math.min(MAXH, window.innerHeight - 2 * M);
    let top;
    if (spaceBelow >= wantH + 6 || spaceBelow >= rect.top) {
      top = rect.bottom + 6;                       // below the button
    } else {
      top = Math.max(M, rect.top - wantH - 6);     // flip above
    }
    top = Math.min(top, window.innerHeight - wantH - M);
    top = Math.max(M, top);
    picker.style.left = left + 'px';
    picker.style.top  = (top + window.scrollY) + 'px';
    document.body.appendChild(picker);
    /* Render the picker grid with color Twemoji images too (otherwise the
       buttons show the platform's monochrome/box glyphs). Explicit call so the
       grid is colorized synchronously rather than waiting on the observer. */
    this._twemojify(picker);

    /* Teardown helper + dismiss wiring */
    const removePicker = () => {
      picker.remove();
      document.removeEventListener('click', close, true);
      document.removeEventListener('keydown', onKey, true);
      this._emojiTarget = null;
      this._emojiAnchor = null;
    };
    const close = e => {
      /* Use contains(), not ===: a click on the button lands on the inner SVG
         path, so `e.target !== emojiBtn` was always true — the capture-phase
         listener removed the picker right before the button's own toggle
         re-opened it, so it took two taps to open (and never toggled shut). */
      if (!picker.contains(e.target) && !emojiBtn.contains(e.target)) removePicker();
    };
    const onKey = e => { if (e.key === 'Escape') removePicker(); };
    setTimeout(() => {
      document.addEventListener('click', close, true);
      document.addEventListener('keydown', onKey, true);
    }, 50);
  }

  closeModal(id) {
    const _modalEl = this.g(id);
    _modalEl.classList.remove('open');
    this._releaseFocus(_modalEl);
    if (id === 'compose-modal') {
      const modalText = this.g('modal-compose-text').value;
      if (modalText.trim()) {
        this.g('compose-text').value = modalText;
        utils.autoGrow(this.g('compose-text'));
        utils.updateCharCount(this.g('compose-text'), null);
        this._saveDraft();
      }
    }
  }

  /* ── Full-screen image lightbox (X parity) ──────────────────────────
     Clicking a post image opens a top-most in-app viewer instead of a
     new tab. `images` = [{full, thumb, alt}] for the clicked post (its
     sibling thumbs within one .post-images container); `startIndex` is
     the clicked thumb's position. Supports a clamped carousel (no wrap),
     keyboard (Esc / ←/→), backdrop-to-close, focus trap restore, and an
     "Open original" escape hatch preserving the old new-tab affordance.
     CSP-safe: built via createElement + addEventListener, no inline HTML
     for user data; URLs/alt run through utils.safeUrl()/utils.safe(). */
  _openImageLightbox(images, startIndex) {
    if (!Array.isArray(images) || images.length === 0) return;
    /* Only one at a time — replace any existing overlay. */
    this._closeImageLightbox();

    const SVG = {
      close: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M13.41 12l6.3-6.29a1 1 0 0 0-1.42-1.42L12 10.59l-6.29-6.3a1 1 0 0 0-1.42 1.42l6.3 6.29-6.3 6.29a1 1 0 1 0 1.42 1.42L12 13.41l6.29 6.3a1 1 0 0 0 1.42-1.42z"/></svg>',
      prev:  '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>',
      next:  '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>'
    };

    const multi = images.length > 1;
    let idx = Math.min(Math.max(0, startIndex | 0), images.length - 1);

    const overlay = document.createElement('div');
    overlay.className = 'lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Image viewer');

    /* Centered image. utils.safeUrl blocks javascript:/data: schemes from
       attacker-controlled chain data; alt is escaped via utils.safe. */
    const imgEl = document.createElement('img');
    imgEl.className = 'lightbox-img';
    imgEl.loading = 'eager';
    overlay.appendChild(imgEl);

    /* Close (top-left, X behavior). */
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'lightbox-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = SVG.close;
    closeBtn.onclick = () => this._closeImageLightbox();
    overlay.appendChild(closeBtn);

    let counter = null, prevBtn = null, nextBtn = null;
    if (multi) {
      counter = document.createElement('div');
      counter.className = 'lightbox-counter';
      overlay.appendChild(counter);

      prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'lightbox-nav lightbox-prev';
      prevBtn.setAttribute('aria-label', 'Previous image');
      prevBtn.innerHTML = SVG.prev;
      prevBtn.onclick = (e) => { e.stopPropagation(); show(idx - 1); };
      overlay.appendChild(prevBtn);

      nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'lightbox-nav lightbox-next';
      nextBtn.setAttribute('aria-label', 'Next image');
      nextBtn.innerHTML = SVG.next;
      nextBtn.onclick = (e) => { e.stopPropagation(); show(idx + 1); };
      overlay.appendChild(nextBtn);
    }

    /* "Open original" — preserves the prior new-tab affordance. */
    const orig = document.createElement('a');
    orig.className = 'lightbox-original';
    orig.target = '_blank';
    orig.rel = 'noopener noreferrer';
    orig.textContent = 'Open original ↗';
    overlay.appendChild(orig);

    const show = (i) => {
      idx = Math.min(Math.max(0, i), images.length - 1); /* clamp, no wrap */
      const cur = images[idx] || {};
      imgEl.src = utils.safeUrl(cur.full || '');
      imgEl.alt = utils.safe(cur.alt || '');
      orig.href = utils.safeUrl(cur.full || '');
      if (counter) counter.textContent = `${idx + 1} / ${images.length}`;
      if (prevBtn) prevBtn.disabled = idx <= 0;
      if (nextBtn) nextBtn.disabled = idx >= images.length - 1;
    };

    /* Backdrop click closes; clicks on the image or a button do not. */
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this._closeImageLightbox();
    });

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this._closeImageLightbox(); return; }
      if (!multi) return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); show(idx - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); show(idx + 1); }
    };
    document.addEventListener('keydown', onKey);

    this._lightbox = { overlay, onKey, prevFocus: document.activeElement };
    show(idx);
    document.body.appendChild(overlay);
    closeBtn.focus();
  }

  _closeImageLightbox() {
    const lb = this._lightbox;
    if (!lb) return;
    document.removeEventListener('keydown', lb.onKey);
    if (lb.overlay && lb.overlay.parentNode) lb.overlay.parentNode.removeChild(lb.overlay);
    this._lightbox = null;
    /* Restore focus to the element that was focused before opening. */
    if (lb.prevFocus && typeof lb.prevFocus.focus === 'function') {
      try { lb.prevFocus.focus(); } catch (_) { /* element may be gone */ }
    }
  }

  /* Pages in this set render their own feed content (profile, thread,
     etc.) and would silently swallow appended posts if infinite-scroll
     fired on them. Keep this in sync with renderFeed()'s selfManaged list. */
  /* Modes that replace the entire #feed DOM themselves — renderFeed must
     NOT overwrite them with the standard post list. */
  _selfManagedModes = new Set([
    'notifications', 'profile', 'thread', 'channels', 'messages', 'notgrok',
    'explore', 'bookmarks', 'settings', 'lists', 'communities', 'followlist',
    'analytics', 'verify', 'dashboard', 'premium'
  ]);  /* lists/communities render their own browse UI into #feed */
  /* Modes where pollNew's "Show N posts" banner makes no sense.
     Superset of _selfManagedModes — includes wave/self/custom where
     the user is on a specific channel feed that isn't the main timeline. */
  _noBannerModes = new Set([
    'notifications', 'profile', 'thread', 'channels', 'messages',
    'explore', 'bookmarks', 'settings', 'self', 'custom', 'followlist'
  ]);

  onScroll() {
    /* Profile page has its own pagination — route to dedicated handler. */
    if (this.state.mode === 'profile') {
      this._onProfileScroll();
      return;
    }
    if (this._selfManagedModes.has(this.state.mode)) return;
    if (!this.state.hasMore || this.state.loading) return;
    /* documentElement.scrollHeight is the canonical scrollable height —
       document.body.offsetHeight is wrong when sticky/fixed elements
       contribute to layout. 600px lookahead = ~1 viewport of buffer
       on a 720p screen, prefetching feels seamless. */
    const doc = document.documentElement;
    const bottom = window.scrollY + window.innerHeight;
    if (bottom >= doc.scrollHeight - 600) this.fetchPosts(false);
  }

  /* __ Per-page sticky header __ */
  /* Returns an HTML string for a sticky top-of-feed header bar.
     opts: { title, subtitle, back: bool, searchAddr, noBack: bool } */
  _makePageHeader(opts = {}) {
    const backBtn = opts.noBack ? '' : `
      <button class="page-header-back" data-act="nav-back"
        aria-label="Back">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path fill="currentColor" d="M7.414 13l5.043 5.04-1.414 1.42L3.586 12l7.457-7.46 1.414 1.42L7.414 11H21v2H7.414z"/>
        </svg>
      </button>`;
    const searchBtn = opts.searchAddr ? `
      <button class="page-header-action" title="Search posts" data-act="focus-search">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path fill="currentColor" d="M10.25 3.75c-3.59 0-6.5 2.91-6.5 6.5s2.91 6.5 6.5 6.5c1.795 0 3.419-.726 4.596-1.904 1.178-1.177 1.904-2.801 1.904-4.596 0-3.59-2.91-6.5-6.5-6.5zm-8.5 6.5c0-4.694 3.806-8.5 8.5-8.5s8.5 3.806 8.5 8.5c0 1.986-.682 3.815-1.814 5.272l4.771 4.771-1.414 1.414-4.771-4.771A8.456 8.456 0 0110.25 18.75c-4.694 0-8.5-3.806-8.5-8.5z"/>
        </svg>
      </button>` : '';
    const subtitle = opts.subtitle
      ? `<div class="page-header-subtitle">${utils.safe(opts.subtitle)}</div>` : '';
    return `<div class="page-header">
      ${backBtn}
      <div class="page-header-titles">
        <div class="page-header-title">${utils.safe(opts.title || '')}</div>
        ${subtitle}
      </div>
      ${searchBtn}
    </div>`;
  }

  /* Enforce a max size on profCache to prevent unbounded memory growth.
     Evicts oldest entries (by insertion order) when over the cap. */
  _pruneProfileCache(maxSize = 500) {
    const keys = Object.keys(this.state.profCache);
    if (keys.length <= maxSize) return;
    /* Remove the oldest (first inserted) entries */
    const toRemove = keys.slice(0, keys.length - maxSize);
    toRemove.forEach(k => delete this.state.profCache[k]);
  }

  /* Cap the poll session maps so a long session browsing many polls doesn't
     grow them without bound. Maps keep insertion order, so we evict the
     oldest entries first. The cap is generous — eviction only matters after
     hundreds of distinct polls, and an evicted poll simply re-tallies on its
     next render. */
  _prunePollMaps(maxSize = 800) {
    for (const m of [this._voteAccum, this._pollScanned, this._myVotes, this._pollEndMs]) {
      if (m.size <= maxSize) continue;
      const keys = [...m.keys()];
      for (let i = 0; i < keys.length - maxSize; i++) m.delete(keys[i]);
    }
  }

  /* Prepend the pending page header to the feed if not already present.
     Call at the start of any function that sets feed.innerHTML directly. */
  _applyPageHeader() {
    if (!this._pendingPageHeader) return '';
    const h = this._pendingPageHeader;
    this._pendingPageHeader = null;
    return h;
  }

  /* Navigate back using app state rather than browser history.
     history.back() is unreliable on GitHub Pages (SW inflates history.length).
     We check if there's a meaningful previous state to restore. */
  _navBack() {
    /* Thread page has explicit state saved in _prevMode */
    if (this._threadBackOverride) {
      this._threadBack();
      return;
    }
    /* Profile/other pages: try real history first, fall back to Home */
    if (window.history.length > 2) {
      window.history.back();
    } else {
      this.goHome();
    }
  }

  /* __ Post context menu __ */
  /* Locally hide a single post from the feed (session-only; not on-chain). */
  markNotInterested(post) {
    (this._notInterested ||= new Set()).add(post.txHash);
    const el = this.g('feed')?.querySelector(`.post-item[data-txhash="${post.txHash}"], .post-placeholder[data-txhash="${post.txHash}"]`);
    if (el) el.remove();
    utils.toast('Post hidden — not interested');
  }

  /* Small dropdown to add/remove an address from one of the user's Lists. */
  _openListPicker(addr, anchorEl) {
    if (!addr) return;
    document.querySelector('.post-menu-dropdown.open')?.remove();
    const lists = this.state.lists || [];
    if (!lists.length) { utils.toast('Create a list first'); this.goLists?.(); return; }
    const menu = document.createElement('div');
    menu.className = 'post-menu-dropdown open';
    lists.forEach(list => {
      const inList = list.members.includes(addr);
      const el = document.createElement('div');
      el.className = 'post-menu-item';
      el.innerHTML = `<span>${inList ? '✓ ' : ''}${utils.safe(list.name)}</span>`;
      el.onclick = e => {
        e.stopPropagation();
        if (inList) list.members = list.members.filter(m => m !== addr);
        else list.members.push(addr);
        this._saveLists();
        utils.toast(inList ? 'Removed from list' : 'Added to list');
        menu.remove();
      };
      menu.appendChild(el);
    });
    document.body.appendChild(menu);
    const rect = anchorEl ? anchorEl.getBoundingClientRect()
      : { right: window.innerWidth - 8, bottom: 60 };
    const mw = menu.offsetWidth || 220, mh = menu.offsetHeight || 200;
    let left = (rect.right ?? (rect.left || 0) + 34) - mw;
    let top  = (rect.bottom ?? 60) + 4;
    if (top + mh > window.innerHeight) top = Math.max(8, window.innerHeight - mh - 8);
    if (left < 8) left = 8;
    menu.style.left = left + 'px';
    menu.style.top  = top + 'px';
    setTimeout(() => {
      const close = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close, true); } };
      document.addEventListener('click', close, true);
    }, 0);
  }

  openPostMenu(post, anchorEl) {
    /* Close any existing menu */
    const existing = document.querySelector('.post-menu-dropdown.open');
    if (existing) existing.remove();

    const isOwn = post.reporter === this.state.signerAddr;
    const isMuted = this.isMuted(post.reporter);
    const handle = '@' + this.trunc(post.reporter);

    const menu = document.createElement('div');
    menu.className = 'post-menu-dropdown open';
    menu.setAttribute('role', 'menu');

    /* Build the menu in X's order directly (no unshift/push juggling). Each
       reusable item is defined once below, then assembled per isOwn. The
       only structural addition vs X is a { divider:true } separating the
       X-style core actions from our chain-specific group (Copy link / About /
       OtterScan / Permanent). We deliberately OMIT Block & Report: they
       contradict an uncensorable on-chain protocol — there's no central
       authority to report to and a block can't remove on-chain data. */
    const isFollowing = this.state.following.has(post.reporter?.toLowerCase());
    const isPinned = isOwn && this._getMyPin() === post.txHash;

    const followItem = {
      icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h10v-2c0-.41.06-.81.17-1.19C13.2 14.27 12.5 14 12 14zm7 0v3h-3v2h3v3h2v-3h3v-2h-3v-3h-2z"/></svg>',
      label: (isFollowing ? 'Unfollow ' : 'Follow ') + handle,
      action: () => this.toggleFollowAddr(post.reporter.toLowerCase(), null), danger: false };
    /* Not interested — locally hides this single post from the feed */
    const notInterestedItem = {
      icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10 10-4.49 10-10S17.51 2 12 2zm0 18c-4.41 0-8-3.59-8-8 0-1.85.63-3.55 1.69-4.9L16.9 18.31C15.55 19.37 13.85 20 12 20zm6.31-3.1L7.1 5.69C8.45 4.63 10.15 4 12 4c4.41 0 8 3.59 8 8 0 1.85-.63 3.55-1.69 4.9z"/></svg>',
      label: 'Not interested in this post', action: () => this.markNotInterested(post), danger: false };
    /* Add / remove from a List */
    const listItem = {
      icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 5h18v2H3V5zm0 6h12v2H3v-2zm0 6h12v2H3v-2zm15-3v3h-3v2h3v3h2v-3h3v-2h-3v-3h-2z"/></svg>',
      label: 'Add / remove from List', action: () => this._openListPicker(post.reporter?.toLowerCase(), anchorEl), danger: false };
    const muteItem = isMuted
      ? { icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M18 6.41L16.59 5 12 9.59 7.41 5 6 6.41 10.59 11 6 15.59 7.41 17 12 12.41 16.59 17 18 15.59 13.41 11z"/></svg>',
          label: `Unmute ${handle}`, action: () => this.unmuteAddress(post.reporter), danger: false }
      : { icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M18 11v2h4v-2h-4zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61zM20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.65 3.2-2.4zM4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1l5 5V4L5 9H4zm11.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>',
          label: `Mute ${handle}`, action: () => this.muteAddress(post.reporter), danger: false };
    /* Write a community note */
    const noteItem = {
      icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
      label: 'Write a community note', action: () => this.openNoteComposer(post), danger: false };
    const pinItem = {
      icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>',
      label: isPinned ? 'Unpin from your profile' : 'Pin to your profile',
      action: () => this.togglePin(post), danger: false };
    /* Copy link */
    const copyItem = {
      icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.48-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>',
      label: 'Copy post link', action: () => utils.copyToClipboard(this._postUrl(post.txHash), 'Link copied!'), danger: false };
    /* About this post — metadata (channel, author, type, block, tx) */
    const aboutItem = {
      icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M11 7h2v2h-2V7zm0 4h2v6h-2v-6zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>',
      label: 'About this post', action: () => this._showAboutPost(post), danger: false };
    /* View on the post chain's block explorer (OtterScan for PulseChain). */
    const otterItem = {
      icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M18.36 5.64c-1.95-1.96-5.11-1.96-7.07 0L9.88 7.05 8.46 5.64l1.42-1.42c2.73-2.73 7.16-2.73 9.9 0 2.73 2.74 2.73 7.17 0 9.9l-1.42 1.42-1.41-1.42 1.41-1.41c1.96-1.96 1.96-5.12 0-7.07zm-2.12 3.53l-7.07 7.07-1.41-1.41 7.07-7.07 1.41 1.41zm-12.02.71l1.42-1.42 1.41 1.42-1.41 1.41c-1.96 1.96-1.96 5.12 0 7.07 1.95 1.96 5.11 1.96 7.07 0l1.41-1.41 1.42 1.41-1.42 1.42c-2.73 2.73-7.16 2.73-9.9 0-2.73-2.74-2.73-7.17 0-9.9z"/></svg>',
      label: 'View on ' + (chainCfg(post.chainId)?.explorer.name || 'block explorer'), action: () => window.open(txUrl(post.chainId, post.txHash), '_blank', 'noopener,noreferrer'), danger: false };
    const permanentItem = {
      icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
      label: 'Posts are permanent on-chain', action: () => utils.toast('On-chain posts are permanent by design.'), danger: false };

    const items = isOwn
      ? [pinItem, listItem, noteItem,
         { divider: true },
         copyItem, aboutItem, otterItem, permanentItem]
      : [followItem, notInterestedItem, listItem, muteItem, noteItem,
         { divider: true },
         copyItem, aboutItem, otterItem];

    /* removeMenu cleans up listeners + the trigger's aria-expanded; restores
       focus to the trigger only on keyboard dismissal (Escape). */
    const removeMenu = (restoreFocus) => {
      menu.remove();
      document.removeEventListener('click', close, true);
      document.removeEventListener('keydown', onKey, true);
      anchorEl?.setAttribute?.('aria-expanded', 'false');
      if (restoreFocus) anchorEl?.focus?.();
    };
    items.forEach(({ icon, label, action, danger, divider }) => {
      if (divider) {
        const sep = document.createElement('div');
        sep.className = 'post-menu-divider';
        menu.appendChild(sep);
        return;
      }
      const el = document.createElement('button');
      el.type = 'button';
      el.setAttribute('role', 'menuitem');
      el.className = 'post-menu-item' + (danger ? ' danger' : '');
      el.innerHTML = `${icon}<span>${utils.safe(label)}</span>`;
      el.onclick = e2 => { e2.stopPropagation(); removeMenu(false); action(); };
      menu.appendChild(el);
    });
    /* Keyboard: Escape closes (restoring focus), arrows move between items. */
    const onKey = e2 => {
      const btns = [...menu.querySelectorAll('.post-menu-item')];
      const idx  = btns.indexOf(document.activeElement);
      if (e2.key === 'Escape')         { e2.preventDefault(); removeMenu(true); }
      else if (e2.key === 'ArrowDown') { e2.preventDefault(); btns[(idx + 1) % btns.length]?.focus(); }
      else if (e2.key === 'ArrowUp')   { e2.preventDefault(); btns[(idx - 1 + btns.length) % btns.length]?.focus(); }
    };

    /* Append to DOM first so offsetWidth/Height are measurable */
    document.body.appendChild(menu);
    const rect   = anchorEl ? anchorEl.getBoundingClientRect()
      : { left: window.innerWidth - 240, bottom: 60, top: 40, right: window.innerWidth - 8 };
    const mw     = menu.offsetWidth  || 240;
    const mh     = menu.offsetHeight || 200;
    /* Align menu's right edge with the anchor's right edge (like Twitter) */
    let left = (rect.right ?? rect.left + 34) - mw;
    let top  = rect.bottom + 4;
    /* Clamp horizontally */
    if (left < 8) left = 8;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    /* Flip above if would overflow below */
    if (top + mh > window.innerHeight - 8) top = rect.top - mh - 4;
    if (top < 8) top = 8;
    menu.style.left = left + 'px';
    menu.style.top  = top  + 'px';

    /* Close on outside click */
    const close = e2 => { if (!menu.contains(e2.target)) removeMenu(false); };
    anchorEl?.setAttribute?.('aria-expanded', 'true');
    setTimeout(() => {
      document.addEventListener('click', close, true);
      document.addEventListener('keydown', onKey, true);
      menu.querySelector('.post-menu-item')?.focus();   /* focus first item for keyboard users */
    }, 0);
  }

  /* Update the profile page-header subtitle with the real post count
     after the profile tab has finished loading posts. */
  _updateProfileSubtitle(address) {
    if (this.state.mode !== 'profile') return;
    const subtitle = this.g('feed')?.querySelector('.page-header-subtitle');
    if (!subtitle) return;
    /* Count the active tab's rendered items (authoritative after a tab load /
       scroll-append). Media renders thumbs, the other tabs render post rows. */
    const profFeed = this.g('feed')?.querySelector('.prof-feed');
    if (!profFeed) return;
    const tab = this._profilePageState?.tab || 'posts';
    const count = tab === 'media'
      ? profFeed.querySelectorAll('.prof-media-thumb').length
      : profFeed.querySelectorAll('.post-item').length;
    if (count <= 0) return;   /* tab switch clears the stale count up-front */
    const nouns = { posts: ['post', 'posts'], replies: ['reply', 'replies'],
      media: ['image', 'images'], likes: ['like', 'likes'] };
    const [one, many] = nouns[tab] || nouns.posts;
    subtitle.textContent = `${count} ${count === 1 ? one : many}`;
  }

  /* Channel banner header subtitle = post count (mirrors the profile header,
     instead of a static "Channel" label). Counts mounted + virtualized rows. */
  _updateChannelSubtitle() {
    const sub = this.g('cb-header-sub');
    if (!sub) return;
    /* Both channel views ('custom') and My Channel ('self') show the banner. */
    if (this.state.mode !== 'custom' && this.state.mode !== 'self') { sub.textContent = ''; return; }
    const feed = this.g('feed');
    const count = feed ? feed.querySelectorAll('.post-item, .post-placeholder').length : 0;
    sub.textContent = count > 0 ? `${count} post${count !== 1 ? 's' : ''}` : '';
  }

  /* Fetch a single quoted post that isn't in _postMap yet and patch the
     placeholder card in the DOM. Resolves the tx DIRECTLY by hash via
     _fetchTxByHash — the old 5-page channel scan never found quoted posts
     older than ~250 txs in the channel, leaving the card stuck on
     "Loading quoted post…" forever (most visible with older video posts). */
  async _fetchQuotedPost(hash, channel, chainId = CANONICAL_CHAIN_ID) {
    /* Only fetch if not already in progress */
    if (!this._fetchingQuotes) this._fetchingQuotes = new Set();
    if (this._fetchingQuotes.has(hash)) return;
    this._fetchingQuotes.add(hash);
    try {
      /* Yield once so the synchronous renderFeed loop finishes repopulating
         _postMap before we read it. The quoted post is often LATER in the same
         feed than the post quoting it (a quote/link points back at an older
         post that also renders below) — without this yield _postMap.get misses
         it and we'd do a needless chain fetch (and, offline, fail outright). */
      await Promise.resolve();
      const orig = this._postMap.get(hash) || await this._fetchTxByHash(hash, chainId);
      const placeholder = document.getElementById('qc-' + hash.slice(2, 8));
      if (!orig) {
        /* Unresolvable (pruned node, wrong hash, network down) — say so
           instead of spinning forever. */
        if (placeholder) placeholder.innerHTML = `<span style="color:var(--muted)">Quoted post unavailable</span>`;
        return;
      }
      if (this._postHashSet) this._postHashSet.add(hash);
      if (placeholder) {
        placeholder.className = 'repost-card';
        placeholder.removeAttribute('data-fetch-quote');
        /* Same delegated action as cards rendered the fast path. */
        placeholder.setAttribute('data-act', 'open-quote');
        placeholder.setAttribute('data-act-arg', hash);
        placeholder.setAttribute('data-act-arg2', channel || '');
        placeholder.innerHTML = this._quoteCardInner(orig);
      }
      /* Fetch their profile too */
      if (orig.reporter) this.fetchOtherProfile(orig.reporter);
    } finally {
      this._fetchingQuotes.delete(hash);
    }
  }

  /* Build trigram search index for all IDB posts not yet indexed.
     Runs during browser idle time — safe to call on every startup since
     indexPost() is idempotent (it appends; we check before running). */
  _rebuildSearchIndex() {
    const key = 'sayit_idx_v1';
    if (utils.safeLS.get(key)) return;
    const run = async () => {
      try {
        const posts = await this.cache.getPosts(() => true);
        if (!posts.length) return;
        for (let i = 0; i < posts.length; i++) {
          await this.cache.indexPost(posts[i]);
          if (i % 50 === 49) await new Promise(res => setTimeout(res, 0));
        }
        utils.safeLS.set(key, '1');
        console.info('[search] Indexed ' + posts.length + ' cached posts');
      } catch (err) { console.warn('[search] Rebuild failed:', err); }
    };
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => run(), { timeout: 30000 });
    } else {
      setTimeout(run, 5000);
    }
  }

  /* __ Offline post queue __ */
  _showPendingInFeed(queued) {
    /* Render the pending post at the top of the feed with a clock indicator */
    const feed = this.g('feed');
    if (!feed) return;
    const el = document.createElement('div');
    el.className = 'post-item pending-post';
    el.dataset.queueid = queued.queueId;
    el.style.cssText = 'opacity:0.7;border-left:3px solid var(--primary);';
    const displayText = queued.content.length > MAX_PREVIEW
      ? queued.content.slice(0, MAX_PREVIEW) + '…'
      : queued.content;
    el.innerHTML = `
      <div style="padding:12px 16px;display:flex;gap:10px;align-items:flex-start">
        <img src="${utils.safe(utils.safeUrl(this.state.profile.picUrl) || 'image1.jpeg')}" style="width:40px;height:40px;border-radius:50%;flex-shrink:0;object-fit:cover" data-fallback-src="image1.jpeg">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:var(--primary-lt);margin-bottom:4px">
            ⌛ Publishing… <span style="color:var(--muted);font-size:12px">(saved offline)</span>
          </div>
          <div style="font-size:15px;color:var(--text);word-break:break-word">${utils.safe(displayText)}</div>
        </div>
      </div>`;
    /* Insert before first real post */
    const firstPost = feed.querySelector('.post-item:not(.pending-post)');
    if (firstPost) feed.insertBefore(el, firstPost);
    else feed.prepend(el);
  }

  async _retryPendingPosts() {
    if (!this.signer || !navigator.onLine) return;
    /* Re-entrancy guard: both the 'online' listener and afterConnect schedule
       this, and overlapping runs would read the same queue and double-publish
       (duplicate on-chain txs) before either deletes the entry. */
    if (this._retrying) return;
    this._retrying = true;
    try {
      let pending;
      try { pending = await this.cache.getPendingPosts(); }
      catch (err) { console.warn('Offline queue unreadable — retry skipped', err); return; }
      if (!pending.length) return;
      for (const queued of pending) {
        /* Skip if not from this wallet (different account logged in) */
        if (queued.signerAddr !== this.state.signerAddr) continue;
        utils.toast(`↺ Retrying queued post…`);
        try {
          const ok = await this.publish(queued.content, queued.parentTx, queued.toAddress);
          if (ok) {
            await this.cache.deletePendingPost(queued.queueId);
            /* Remove pending indicator from feed */
            const el = document.querySelector(`[data-queueid="${queued.queueId}"]`);
            if (el) el.remove();
          }
        } catch { /* leave in queue for next retry */ }
      }
    } finally {
      this._retrying = false;
    }
  }

  /* Load pending posts from IDB and show them in feed on startup */
  async _loadPendingPostsIntoFeed() {
    if (!this.state.signerAddr) return;
    try {
      const pending = await this.cache.getPendingPosts();
      pending
        .filter(q => q.signerAddr === this.state.signerAddr)
        .forEach(q => this._showPendingInFeed(q));
    } catch { /* IDB not ready yet */ }
  }

  /* __ Profile patch: update avatars + names in-place after profile fetch __
     Called by _debouncedRender (triggered by fetchOtherProfile completions).
     Walks existing post-item elements and patches only changed avatar/name
     nodes — no innerHTML rebuild, no reflow of the whole feed.
     Falls back to full renderFeed if the post list has changed. */
  _patchProfilesInFeed() {
    const feed = this.g('feed');
    if (!feed) return;
    /* Patch ONLY the currently-mounted post-items. Virtualization keeps a
       scrolling WINDOW mounted (everything else is a placeholder), and
       _postMap holds every displayed post — so patching by hash works for
       whatever window is mounted, at any scroll position.

       A profile update only fills in an avatar/name; it never changes the post
       list, so this must NOT fall back to a full renderFeed(). The old code
       compared the mounted window against the FIRST N of state.posts and
       rebuilt the whole feed on a mismatch — which is the normal case the
       moment you scroll. As profiles streamed in (slow, staggered chain
       scans), that fired renderFeed() over and over, recreating every <video>
       and making the feed blink/flash repeatedly. */
    const items = feed.querySelectorAll('.post-item[data-txhash]');
    if (!items.length) return;
    /* Patch avatars and names in-place. O(n) DOM walk but no innerHTML. */
    items.forEach(item => {
      const hash = item.dataset.txhash;
      const post = this._postMap.get(hash);
      if (!post) return;
      const addr = post.reporter;
      if (!addr || addr === this.state.signerAddr) return;
      const prof = this.state.profCache[addr];
      if (!prof || (!prof.username && prof.picUrl === 'image1.jpeg')) return;
      /* Patch avatar */
      const avatar = item.querySelector('.post-avatar');
      if (avatar && prof.picUrl && prof.picUrl !== 'image1.jpeg' &&
          avatar.src.endsWith('image1.jpeg')) {
        avatar.src = prof.picUrl;
      }
      /* Patch display name */
      const nameEl = item.querySelector('.post-name');
      if (nameEl && prof.username) {
        /* Assign the RAW username — textContent doesn't parse HTML, so escaping
           here double-encoded "&"/"<" and made the !== guard always misfire. */
        if (nameEl.textContent !== prof.username && nameEl.textContent.includes('...')) {
          nameEl.textContent = prof.username;
        }
      }
    });
    /* Also refresh sidebar panels (cheap) */
    this._refreshSidebarPanels();
  }

  /* ── Sidebar: dynamic trending + who-to-follow ────────────────────────
     Called from fetchPosts() after new posts land and from feed re-renders.
     Cheap: all data comes from in-memory state.posts and state.profCache. */
  _refreshSidebarPanels() {
    try { this.renderLiveSpaces(); } catch (err) { console.warn('Live render:', err); }
    try { this.renderTrending(); } catch (err) { console.warn('Trending render:', err); }
    try { this.renderLatestPolls(); } catch (err) { console.warn('Polls render:', err); }
    try { this.renderTodaysNews(); } catch (err) { console.warn('News render:', err); }
    try { this.renderWhoToFollow(); } catch (err) { console.warn('W2F render:', err); }
  }

  /* Live on Say It — live Spaces from the loaded feed, first content card
     in the right column (X puts its live module straight under search).
     Hidden when nothing is live. */
  renderLiveSpaces() {
    const card = this.g('sb-live-card');
    const list = this.g('sb-live-list');
    if (!card || !list) return;
    const seen = new Set();
    const live = [];
    for (const p of this.state.posts) {
      this._reviveSpace(p);
      if (!p.space || seen.has(p.space.roomId)) continue;
      seen.add(p.space.roomId);
      if (this._spaceIsEnded(p)) continue;
      if (p.space.startsMs > Date.now()) continue; /* scheduled, not live yet */
      live.push(p);
      if (live.length >= 2) break; /* posts are newest-first already */
    }
    if (!live.length) { card.style.display = 'none'; return; }
    card.style.display = '';
    list.innerHTML = live.map(p => {
      const host = this.state.profCache[p.reporter] || {};
      const hostName = host.username ? utils.safe(host.username) : this.trunc(p.reporter);
      const hostPic = utils.safe(utils.safeUrl(host.picUrl) || 'image1.jpeg');
      return `
        <div class="sb-live-row">
          <img src="${hostPic}" class="sb-live-pic" alt="" loading="lazy" data-fallback-src="image1.jpeg">
          <div class="sb-live-info">
            <div class="sb-live-title"><span class="live-dot" aria-hidden="true"></span><span class="sb-live-title-text">${utils.safe(p.space.title)}</span></div>
            <div class="sb-live-meta">${hostName} · <span data-space-count="${utils.safe(p.space.roomId)}">live now</span></div>
          </div>
          <button class="sb-live-btn" data-sb-join="${utils.safe(p.txHash)}">Listen live</button>
        </div>`;
    }).join('');
    list.querySelectorAll('[data-sb-join]').forEach(el => {
      el.onclick = () => {
        const post = this._postMap.get(el.dataset.sbJoin)
          || this.state.posts.find(x => x.txHash === el.dataset.sbJoin);
        if (!post) return;
        /* Already in this room? Just expand the dock instead of re-previewing. */
        if (this._spaceRoom && this._spaceRoomPost?.txHash === post.txHash) this._expandSpaceDock();
        else this.openSpacePreview(post);
      };
    });
    this._scheduleSpaceProbe();
  }

  /* Latest Polls sidebar card — surfaces active polls from the loaded
     feed (newest first, open polls prioritized over closed). Clicking a
     row opens that poll's thread. Hidden when there are no polls. */
  renderLatestPolls() {
    const card = this.g('sb-polls-card');
    const list = this.g('sb-polls-list');
    if (!card || !list) return;
    const polls = this.state.posts
      .filter(p => p.postType === 'poll' && p.poll)
      .sort((a, b) => {
        /* Open polls first, then newest */
        const aClosed = this._pollIsClosed(a.poll) ? 1 : 0;
        const bClosed = this._pollIsClosed(b.poll) ? 1 : 0;
        if (aClosed !== bClosed) return aClosed - bClosed;
        return (b._tsMs ??= new Date(b.timestamp).getTime()) - (a._tsMs ??= new Date(a.timestamp).getTime());
      })
      .slice(0, 4);
    if (polls.length === 0) { card.style.display = 'none'; return; }
    card.style.display = '';
    list.innerHTML = polls.map(p => {
      const tally = this._pollTally(p);
      const total = tally.total;
      const status = this._pollIsClosed(p.poll)
        ? 'Final results'
        : (p.poll.endMs ? this._pollTimeLeft(p.poll) : 'Open');
      return `
        <div class="sb-poll-row" data-open-poll="${utils.safe(p.txHash)}">
          <div class="sb-poll-q">${utils.safe(p.poll.question)}</div>
          <div class="sb-poll-meta">${total} vote${total === 1 ? '' : 's'} · ${utils.safe(status)}</div>
        </div>`;
    }).join('');
    list.querySelectorAll('[data-open-poll]').forEach(el => {
      el.onclick = () => {
        const post = this._postMap.get(el.dataset.openPoll)
          || this.state.posts.find(x => x.txHash === el.dataset.openPoll);
        if (post) this.openThread(post);
      };
    });
  }

  /* Today's News — surfaces top-engagement posts from the recent feed.
     Differs from renderTrending (hashtags) and renderWhoToFollow (addresses):
     this card shows actual posts as headline-style cards.

     Ranking heuristic (we don't have a true engagement index):
       1. Posts from the last 24 hours
       2. With substantive content (text length > 40)
       3. Prefer posts with hashtags (more topical/newsy)
       4. Prefer posts with media (image thumbnails make the card look right)
       5. Newer wins ties

     Max 3 entries — matches X's news card density. */
  renderTodaysNews() {
    const list = this.g('sb-news-list');
    const card = this.g('sb-news-card');
    if (!list || !card) return;

    const cutoff = Date.now() - 24 * 60 * 60 * 1000; /* 24h window */
    const imgRe = /https?:\/\/[^\s<>"{}|\\^[\]`]+\.(jpg|jpeg|png|gif|webp|avif)/i;
    const ipfsRe = /(ipfs:\/\/|\/ipfs\/)\S+/i;

    const score = (p) => {
      let s = 0;
      const ts = new Date(p.timestamp).getTime();
      const ageHours = (Date.now() - ts) / 3_600_000;
      /* Newer = higher base score */
      s += Math.max(0, 24 - ageHours) * 2;
      /* Hashtag bonus */
      if ((p.display || '').match(/#[A-Za-z0-9_]{2,30}/)) s += 8;
      /* Media bonus */
      if (imgRe.test(p.display || '') || ipfsRe.test(p.display || '')) s += 10;
      /* Substantive bonus */
      if ((p.display || '').length > 80) s += 4;
      return s;
    };

    const candidates = this.state.posts
      .filter(p => {
        if (p.postType === 'poll') return false; /* polls handled separately below */
        if (p.postType && p.postType !== 'post') return false; /* skip likes/follows */
        if (!p.display || p.display.length < 40) return false;
        const ts = new Date(p.timestamp).getTime();
        return ts >= cutoff;
      })
      .map(p => ({ post: p, score: score(p) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(x => x.post);

    /* Recently-ended polls (last 48h) with a tally — surface their results. */
    const pollCutoff = Date.now() - 48 * 60 * 60 * 1000;
    const endedPolls = this.state.posts
      .filter(p => p.postType === 'poll' && p.poll && this._pollIsClosed(p.poll)
        && p.poll.endMs >= pollCutoff)
      .sort((a, b) => b.poll.endMs - a.poll.endMs)
      .slice(0, 2);

    if (candidates.length === 0 && endedPolls.length === 0) { card.style.display = 'none'; return; }
    card.style.display = '';

    const pollRows = endedPolls.map(p => {
      const tally = this._pollTally(p);
      let winner = '', winPct = 0;
      if (tally.total > 0) {
        let maxIdx = 0;
        tally.counts.forEach((c, i) => { if (c > (tally.counts[maxIdx] || 0)) maxIdx = i; });
        winner = p.poll.options[maxIdx] || '';
        winPct = Math.round((tally.counts[maxIdx] / tally.total) * 100);
      }
      return `
        <div class="news-row" role="button" tabindex="0" data-act="open-thread" data-act-arg="${utils.safe(p.txHash)}">
          <div class="news-body">
            <div class="news-label"><svg width="14" height="14" viewBox="0 0 18 18" fill="none"
              stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true" style="vertical-align:-2px;margin-right:4px">
              <path d="M2 16h14"/><path d="M5 16V9"/><path d="M9 16V4"/><path d="M13 16v-5"/>
            </svg>Poll · Final results</div>
            <div class="news-headline">${utils.safe(p.poll.question)}</div>
            <div class="news-meta">
              ${winner ? `<span>Winner: ${utils.safe(winner)} (${winPct}%)</span>` : '<span>No votes</span>'}
              <span>·</span><span>${tally ? tally.total : 0} votes</span>
            </div>
          </div>
        </div>`;
    }).join('');

    list.innerHTML = pollRows + candidates.map(p => {
      const author = this.state.profCache[p.reporter];
      const authorName = author?.username
        ? utils.safe(author.username)
        : this.trunc(p.reporter || '');
      /* Extract first hashtag for label, or fall back to author */
      const tagMatch = (p.display || '').match(/#([A-Za-z0-9_]{2,30})/);
      const label = tagMatch ? '#' + utils.safe(tagMatch[1]) + ' · Trending' : authorName;
      /* First image URL for thumbnail, if any */
      const imgMatch = (p.display || '').match(/https?:\/\/[^\s<>"{}|\\^[\]`]+\.(jpg|jpeg|png|gif|webp|avif)/i);
      const thumb = imgMatch ? utils.safeUrl(imgMatch[0]) : '';
      /* Headline: strip URLs from the display for cleaner preview */
      const headlineRaw = (p.display || '').replace(/https?:\/\/\S+/g, '').trim();
      const headline = utils.safe(headlineRaw.slice(0, 140));
      const time = this.relTime(p.timestamp);
      return `
        <div class="news-row" role="button" tabindex="0" data-act="open-thread" data-act-arg="${utils.safe(p.txHash)}">
          <div class="news-body">
            <div class="news-label">${label}</div>
            <div class="news-headline">${headline}</div>
            <div class="news-meta">
              <span>${utils.safe(authorName)}</span>
              <span>·</span>
              <span>${time}</span>
            </div>
          </div>
          ${thumb ? `<img src="${utils.safe(thumb)}" class="news-thumb"
            alt="" loading="lazy" data-fallback="hide">` : ''}
        </div>`;
    }).join('');
  }

  /* Helper for news card row clicks — looks up the post and opens its thread. */
  async openThreadByHash(hash) {
    hash = (hash || '').toLowerCase();
    let post = this._postMap.get(hash) ||
               this.state.posts.find(p => p.txHash === hash);
    if (!post) {
      /* Not loaded (e.g. a shared deep link opened cold) — fetch it. */
      utils.toast('Loading post…');
      post = await this._fetchTxByHash(hash);
    }
    if (post) this.openThread(post);
    else utils.toast('Post not found');
  }

  renderTrending() {
    const list = this.g('sb-trending-list');
    if (!list) return;
    /* Real trends: #hashtags + significant words (shared with Explore via
       _computeTrends), not hashtags-only — on-chain posts rarely use #tags, so
       the old hashtag-only version almost always fell back to a static
       "#PulseChain" placeholder. Top 5 for the compact sidebar card. */
    const top = this._computeTrends(5, 200);

    /* Inline line-chart icon (own asset) replacing the 📈 emoji, which renders
       as a broken-glyph box on systems without a color-emoji font (e.g. some
       Linux Chromium setups). aria-hidden — purely decorative; stroke follows
       --muted so it tints with the theme. */
    const chartIcon =
      `<svg class="trend-icon" width="18" height="18" viewBox="0 0 18 18" fill="none"
         stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" style="align-self:center;flex-shrink:0">
        <path d="M2 15h14"/><path d="M3 12l4-5 3 3 5-7"/>
      </svg>`;

    const trendHTML = top.map(([term, count]) =>
      `<div class="sb-card-row" role="button" tabindex="0" data-act="search-trend" data-act-arg="${utils.safe(term)}" style="cursor:pointer">
        <div style="flex:1">
          <span class="trend-label">Trending on PulseChain</span>
          <span class="trend-name">${utils.safe(term)}</span>
          <span class="trend-count">${count} post${count > 1 ? 's' : ''}</span>
        </div>
        ${chartIcon}
      </div>`).join('');

    /* Fallback when nothing trends yet — keeps the card from looking empty. */
    const fallback = (top.length === 0)
      ? `<div class="sb-card-row" role="button" tabindex="0" data-act="search-trend" data-act-arg="PulseChain" style="cursor:pointer">
          <div style="flex:1">
            <span class="trend-label">Trending on PulseChain</span>
            <span class="trend-name">#PulseChain</span>
            <span class="trend-count">Join the conversation</span>
          </div>
          ${chartIcon}
        </div>`
      : '';

    list.innerHTML = trendHTML + fallback;
  }

  renderWhoToFollow() {
    const list = this.g('sb-w2f-list');
    const card = this.g('sb-w2f-card');
    if (!list || !card) return;
    if (!this.state.signerAddr) { card.style.display = 'none'; return; }

    /* Count post frequency by reporter, excluding self and already-followed. */
    const counts = new Map();
    this.state.posts.slice(0, 200).forEach(p => {
      const r = p.reporter?.toLowerCase();
      if (!r || r === this.state.signerAddr) return;
      if (this.state.following.has(r)) return;
      counts.set(r, (counts.get(r) || 0) + 1);
    });
    /* Prefer addresses we have profile info for — nicer cards, real names. */
    const _w2fSorted = [...counts.entries()]
      .sort((a, b) => {
        const aHasProfile = this.state.profCache[a[0]]?.username ? 1 : 0;
        const bHasProfile = this.state.profCache[b[0]]?.username ? 1 : 0;
        if (aHasProfile !== bHasProfile) return bHasProfile - aHasProfile;
        return b[1] - a[1];
      });
    this._w2fTotal = _w2fSorted.length;
    /* Default: 3 visible; Show more reveals 6. Matches X's W2F card density. */
    const candidates = _w2fSorted.slice(0, this._w2fExpanded ? 6 : 3);

    if (candidates.length === 0) { card.style.display = 'none'; return; }
    card.style.display = '';
    /* Append a Show more / Show less footer link if there are more
       candidates than currently shown. Removed and re-added each render. */
    setTimeout(() => {
      const _card = this.g('sb-w2f-card');
      if (!_card) return;
      const existing = _card.querySelector('.w2f-show-more');
      if (existing) existing.remove();
      if ((this._w2fTotal || 0) > 3) {
        const btn = document.createElement('button');
        btn.className = 'sb-show-more w2f-show-more';
        btn.textContent = this._w2fExpanded ? 'Show less' : 'Show more';
        btn.onclick = () => {
          this._w2fExpanded = !this._w2fExpanded;
          this.renderWhoToFollow();
        };
        _card.appendChild(btn);
      }
    }, 0);
    list.innerHTML = candidates.map(([addr]) => {
      const c = this.state.profCache[addr];
      const name = c?.username ? utils.safe(c.username) : this.trunc(addr);
      const pic  = c?.picUrl || 'image1.jpeg';
      return `<div class="sb-card-row" role="button" tabindex="0" style="cursor:pointer" data-act="open-profile" data-act-arg="${utils.safe(addr)}">
        <img src="${utils.safe(pic)}" class="w2f-avatar" data-pop-addr="${utils.safe(addr)}" data-fallback-src="image1.jpeg"
          alt="" style="width:40px;height:40px;border-radius:50%;margin-right:10px;flex-shrink:0">
        <div style="flex:1;min-width:0">
          <span class="trend-name" data-pop-addr="${utils.safe(addr)}" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}</span>
          <span class="trend-count">${this.trunc(addr)}</span>
        </div>
        <button class="w2f-follow-btn" data-act="follow-toggle-addr" data-act-arg="${utils.safe(addr)}"
          style="padding:6px 14px;border-radius:9999px;background:var(--primary);color:#fff;
                 font-weight:700;font-size:13px;border:0;cursor:pointer;flex-shrink:0">Follow</button>
      </div>`;
    }).join('');
  }

  /* Toggle follow/unfollow for an address. Sends a FOLLOW:/UNFOLLOW: tx
     addressed TO the target. This is what makes followers discoverable:
       - your OUTGOING FOLLOW txs  = who you follow
       - a user's INCOMING FOLLOW txs = who follows them
     Previously this self-sent (to your own address), so a target could
     never see who followed them — the cause of the "0 followers" bug.
     Updates state.following optimistically; reverts on tx failure.
     Called from the Who-to-follow card, profile popup, and profile page. */
  /* Thin alias → toggleFollow is the single canonical implementation. Kept
     because several call sites (Who-to-follow card, profile popup) use this
     name. Both now send the FOLLOW tx to the target and share one code path. */
  toggleFollowAddr(addr, btn) {
    return this.toggleFollow(addr, btn);
  }

  /* Rotating compose placeholder — light Twitter polish. Only rotates when
     the textarea is empty AND unfocused, so we never disturb a user typing. */
  _initComposePlaceholderRotation() {
    const placeholders = [
      "What's happening on Pulse?",
      "What's on your mind?",
      "Drop something uncensorable…",
      "Speak freely — the chain remembers.",
      "Say it on-chain.",
    ];
    const targets = ['compose-text', 'modal-compose-text'].map(id => this.g(id)).filter(Boolean);
    if (targets.length === 0) return;
    let idx = 0;
    setInterval(() => {
      idx = (idx + 1) % placeholders.length;
      targets.forEach(el => {
        if (!el.value && document.activeElement !== el) {
          el.placeholder = placeholders[idx];
        }
      });
    }, 8000);
  }

  /* ── Profile page: infinite scroll ───────────────────────────────────
     Triggered from the global scroll listener when mode === 'profile'.
     Keeps fetching more pages from the chain and appending matching posts
     until we hit the end of history or fail. */
  async _onProfileScroll() {
    const st = this._profilePageState;
    if (!st || st.loading || !st.hasMore) return;
    if (this.state.mode !== 'profile') return;
    /* Trigger when within ~600px of the bottom — same threshold as the main feed */
    const doc = document.documentElement;
    if (window.scrollY + window.innerHeight < doc.scrollHeight - 600) return;
    await this.fetchProfileMore();
  }

  async fetchProfileMore() {
    const st = this._profilePageState;
    if (!st || st.loading || !st.hasMore) return;
    st.loading = true;
    const feedEl = document.getElementById('prof-feed');
    /* Show a small loading footer at the bottom of the profile feed */
    let footer = feedEl?.querySelector('.prof-loading-more');
    if (feedEl && !footer) {
      footer = document.createElement('div');
      footer.className = 'prof-loading-more';
      footer.style.cssText = 'padding:24px;text-align:center;color:var(--muted);font-size:14px';
      footer.textContent = 'Loading more posts…';
      feedEl.appendChild(footer);
    }
    try {
      /* Scan the next batch of 4 pages */
      const startPage = st.pagesScanned + 1;
      const endPage   = startPage + 3;
      let batch = [];
      for (let p = startPage; p <= endPage; p++) {
        let raw;
        try { raw = await this.apiFetch(st.address, p); }
        catch (err) { console.warn('Profile fetch error:', err); st.hasMore = false; break; }
        if (raw.length === 0) { st.hasMore = false; break; }
        batch.push(...raw);
        if (raw.length < 50) { st.hasMore = false; break; }
      }
      st.pagesScanned = endPage;
      st.rawTxs.push(...batch);
      /* The awaits above can span a navigation (e.g. user tapped Followers,
         which swaps #feed and sets mode='followlist'). If we're no longer on
         the profile page, OR the feed element we captured is detached, abort
         — otherwise insertBefore throws (footer is no longer a child) and the
         new page's content gets corrupted. */
      if (this.state.mode !== 'profile' ||
          !feedEl || !feedEl.isConnected ||
          (footer && footer.parentNode !== feedEl)) {
        st.loading = false;
        return;
      }
      /* Filter for current tab and append */
      const tab = st.tab;
      const newPosts = this._filterProfileTxs(batch, tab, st.address);
      /* Schedule poll tallies for any polls just rendered. */
      if (newPosts.some(pp => pp.poll)) {
        setTimeout(() => this._tallyVisiblePolls(), 100);
      }
      const fresh = newPosts.filter(p => !st.visibleTxHashes.has(p.txHash));
      fresh.forEach(p => {
        st.visibleTxHashes.add(p.txHash);
        this._postMap.set(p.txHash, p);
      });
      if (fresh.length && feedEl && feedEl.isConnected &&
          (!footer || footer.parentNode === feedEl)) {
        /* Clear the deep-loading placeholder shown when the first pages had
           no matching posts. */
        document.getElementById('prof-loading-deep')?.remove();
        const frag = document.createDocumentFragment();
        const replyMap = new Map();
        fresh.forEach(p => { if (p.parentTx) replyMap.set(p.parentTx, (replyMap.get(p.parentTx)||0)+1); });
        fresh.forEach(p => {
          if (tab === 'media') {
            /* Same cells as the initial paint (all media types). */
            const cells = this._postMediaItems(p.display)
              .map(it => this._mediaGridCellHTML({ ...it, txHash: p.txHash })).join('');
            if (cells) {
              const grid = feedEl.querySelector('.prof-media-grid') || (() => {
                const g2 = document.createElement('div');
                g2.className = 'prof-media-grid';
                feedEl.insertBefore(g2, footer);
                return g2;
              })();
              grid.insertAdjacentHTML('beforeend', cells);
            }
            return;
          }
          const el = document.createElement('div');
          el.className = 'post-item';
          el.dataset.txhash = p.txHash;
          el.innerHTML = this.postHTML(p, false, replyMap, null);
          frag.appendChild(el);
          if (p.reporter !== this.state.signerAddr) this.fetchOtherProfile(p.reporter);
        });
        feedEl.insertBefore(frag, footer);
        /* More posts/thumbs landed — keep the header count in sync (it was
           stale because it was only computed once after the initial load). */
        this._updateProfileSubtitle(st.address);
      }
      /* Update footer based on outcome:
         - No more pages: show end marker briefly, then remove.
         - More pages exist: HIDE the footer (we're now idle). It will
           re-appear on the next scroll-triggered fetch. Leaving it as
           "Loading more posts…" while idle looked like a stuck spinner. */
      if (footer) {
        if (!st.hasMore) {
          footer.textContent = '— End of profile —';
          setTimeout(() => footer?.remove(), 5000);
        } else {
          footer.remove();
        }
      }
    } finally {
      st.loading = false;
    }
  }

  /* Auto-load more profile pages until the content is tall enough to scroll
     (or history runs out). Without this, a short first paint — e.g. an active
     account whose first pages are mostly replies/reactions on the Posts tab —
     would strand the user with no way to trigger infinite scroll. Capped. */
  async _fillProfileViewport() {
    for (let guard = 0; guard < 12; guard++) {
      const st = this._profilePageState;
      if (!st || !st.hasMore || this.state.mode !== 'profile') break;
      if (document.documentElement.scrollHeight > window.innerHeight + 400) break;
      const before = st.pagesScanned;
      await this.fetchProfileMore();
      const st2 = this._profilePageState;
      if (!st2 || st2.pagesScanned === before) break; /* no progress / navigated away */
    }
  }

  /* Single source of truth for the profile Media tab. Returns every resolved
     image URL in a post's text, using the SAME compiled host/path patterns as
     utils.linkify — so the initial paint, the scroll-fill, and what actually
     renders never diverge (previously three different host lists). */
  _mediaImageUrls(text) {
    const out = [];
    const matches = (text || '').match(_LK_RE) || [];
    for (const raw of matches) {
      if (!/^(https?:\/\/|ipfs:\/\/|ar:\/\/|arweave:\/\/)/i.test(raw)) continue;
      const u = raw.startsWith('ipfs://')    ? 'https://ipfs.io/ipfs/' + raw.slice(7)
              : raw.startsWith('arweave://') ? 'https://arweave.net/'  + raw.slice(10)
              : raw.startsWith('ar://')      ? 'https://arweave.net/'  + raw.slice(5)
              : raw;
      let isImg = _LK_IMG_RE.test(u) || _LK_IMG_DOMAINS.test(u) || u.includes('arweave.net/');
      if (!isImg) { try { isImg = _LK_IMG_HOSTS.has(new URL(u).hostname); } catch { /* invalid URL */ } }
      if (isImg) out.push(u);
    }
    return out;
  }
  _postHasMedia(text) { return this._postMediaItems(text).length > 0; }

  /* One cell of the profile Media grid. Videos render as muted previews
     with a play badge; YouTube links by their thumbnail. Clicking opens
     the post's thread. */
  _mediaGridCellHTML(it) {
    const open = `data-act="open-thread" data-act-arg="${utils.safe(it.txHash)}" style="cursor:pointer"`;
    if (it.type === 'vid') {
      return `<div class="prof-media-cell" ${open}>
        <video src="${utils.safe(it.thumb)}" class="prof-media-thumb" muted playsinline preload="metadata" data-fallback="hide-wrap"></video>
        <span class="prof-media-play">▶</span></div>`;
    }
    if (it.type === 'yt') {
      if (!this._embedThumbsAllowed()) {
        return `<div class="prof-media-cell prof-media-private" ${open}><span class="prof-media-play">▶</span></div>`;
      }
      return `<div class="prof-media-cell" ${open}>
        <img src="${utils.safe(it.thumb)}" class="prof-media-thumb" loading="lazy" data-fallback="hide">
        <span class="prof-media-play">▶</span></div>`;
    }
    return `<img src="${utils.safe(it.thumb)}" class="prof-media-thumb" loading="lazy" data-fallback="hide" ${open}>`;
  }

  /* Every media item a post carries, for the profile Media grid:
     images (incl. gifs), native video files, and YouTube links (rendered
     by their thumbnail). Returns [{type:'img'|'vid'|'yt', url, thumb}]. */
  _postMediaItems(text) {
    const items = this._mediaImageUrls(text).map(u => ({ type: 'img', url: u, thumb: u }));
    for (const w of String(text || '').split(/\s+/)) {
      if (!/^(https?:|ipfs:|ar:|arweave:)/.test(w)) continue;
      if (_LK_VID_RE.test(w)) {
        const u = utils.safeUrl(w.startsWith('ipfs://') ? utils.resolveIPFS(w) : w);
        if (u) items.push({ type: 'vid', url: u, thumb: u });
        continue;
      }
      const yt = utils.ytId(w);
      if (yt) items.push({ type: 'yt', url: w, thumb: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` });
    }
    return items;
  }

  /* Pure tx filter — split out of loadProfileTab so fetchProfileMore can
     reuse it without re-fetching. Returns parsed post objects. */
  _filterProfileTxs(rawTxs, tab, address) {
    const addrLow = address.toLowerCase();
    const posts = [];
    rawTxs.forEach(tx => {
      const from = tx.from?.toLowerCase();
      const to   = tx.to?.toLowerCase();
      if (from !== addrLow) return;
      if (!tx.input || tx.input === '0x') return;
      try {
        /* Canonical parse — same as the main feed and the initial profile
           load. Handles reposts/polls/replies and returns null for
           profile/reaction/vote/note txs, so raw "REPOST:…" / "NOTE:…" never
           leak into the profile feed. */
        const parsed = this._parsePostTx(tx, { mode: 'profile' });
        if (!parsed) return;
        const isReply = !!parsed.parentTx;
        if (tab === 'posts'   &&  isReply) return;
        if (tab === 'replies' && !isReply) return;
        if (tab === 'media' && !this._postHasMedia(parsed.display)) return;
        posts.push(parsed);
      } catch { /* skip */ }
    });
    return posts;
  }

  /* ── Profile popup card ─────────────────────────────────────────────
     Twitter-style profile preview shown when user clicks a name or avatar
     in the feed. Click on the popup body (not the Follow button) opens
     the full profile page. Closes on outside click, ESC, scroll, or a
     second click on the same anchor (toggle). */
  async showProfilePopup(address, anchorEl, trigger = 'click') {
    address = address.toLowerCase();
    const popup = this.g('profile-popup');
    if (!popup) return;
    /* Click-toggle: clicking the same anchor again closes the popup.
       Hover-open never toggles — moving away closes it instead. */
    if (trigger === 'click' &&
        popup.classList.contains('open') && popup.dataset.addr === address) {
      this.hideProfilePopup();
      return;
    }
    /* If hover is opening but click-popup is already showing something else,
       don't clobber it — let click take priority. */
    if (trigger === 'hover' && popup.classList.contains('open') &&
        popup.dataset.addr !== address) return;
    popup.dataset.addr = address;

    /* Resolve profile data: own state, prof cache, then trigger fetch if missing. */
    let prof = null;
    if (address === this.state.signerAddr) {
      prof = this.state.profile;
    } else {
      prof = this.state.profCache[address];
      if (!prof || prof === null) {
        /* Render placeholder, kick off fetch, refresh on completion. */
        this.fetchOtherProfile(address).then(() => {
          if (popup.classList.contains('open') && popup.dataset.addr === address) {
            popup.innerHTML = this._profilePopupHTML(address, this.state.profCache[address] || {});
          }
        });
      }
    }

    /* Count posts by this address in current feed for the "N posts" stat. */
    const postCount = this.state.posts.filter(
      p => p.reporter?.toLowerCase() === address && (!p.postType || p.postType === 'post')
    ).length;

    popup.innerHTML = this._profilePopupHTML(address, prof || {}, postCount);

    /* Lazy-fill Following/Followers counts (cached), then refresh the card. */
    this._lazyFollowCounts(address).then(() => {
      if (popup.classList.contains('open') && popup.dataset.addr === address) {
        const p = this.state.profCache[address] || (address === this.state.signerAddr ? this.state.profile : {}) || {};
        popup.innerHTML = this._profilePopupHTML(address, p, postCount);
      }
    });

    /* Position popup near anchor — clamped to viewport. */
    this._positionPopup(popup, anchorEl);
    clearTimeout(popup._openRemoveTimer); /* cancel any pending hide */
    popup.classList.add('open');
    requestAnimationFrame(() => popup.classList.add('visible'));

    /* Close the popup when the mouse leaves it (hover-opened popups only).
       Without this, moving the mouse off the popup — rather than back onto
       the trigger — left the popup stuck open. A short grace delay lets
       the user move between trigger and popup without flicker. */
    if (trigger === 'hover') {
      popup.onmouseleave = () => {
        clearTimeout(popup._pendingClose);
        popup._pendingClose = setTimeout(() => {
          /* Only close if the mouse isn't back over the popup or its trigger */
          if (!popup.matches(':hover')) this.hideProfilePopup();
        }, 200);
      };
      popup.onmouseenter = () => {
        /* Re-entered the popup — cancel any pending close */
        clearTimeout(popup._pendingClose);
        popup._pendingClose = null;
      };
    }

    this._wirePopupDismiss();
  }

  _profilePopupHTML(address, prof, postCount = null) {
    const isOwn = address === this.state.signerAddr;
    const isFollowing = this.state.following.has(address);
    const name = prof.username ? utils.safe(prof.username) : this.trunc(address);
    const handle = '@' + this.trunc(address);
    const pic = utils.safe(utils.safeUrl(prof.picUrl) || 'image1.jpeg');
    const bio = prof.bio ? utils.safe(prof.bio) : '';
    const hasProfile = !!prof.username;
    const verifiedSvg = hasProfile
      ? '<svg viewBox="0 0 22 22" width="15" height="15"><path fill="#1d9bf0" d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"/></svg>'
      : '';

    const followBtn = isOwn
      ? ''
      : isFollowing
        ? `<button class="pp-follow-btn following" data-pp-action="unfollow"><span class="pp-following-label">Following</span></button>`
        : `<button class="pp-follow-btn" data-pp-action="follow">Follow</button>`;

    return `
      <div class="pp-header">
        <img src="${pic}" class="pp-avatar" alt="" data-fallback-src="image1.jpeg">
        ${followBtn}
      </div>
      <div class="pp-name">${name}${verifiedSvg ? `<span class="verified-icon">${verifiedSvg}</span>` : ''}</div>
      <div class="pp-handle">${handle}</div>
      ${bio ? `<div class="pp-bio">${bio}</div>` : ''}
      <div class="pp-stats">${this._ppStatsInner(address, isOwn)}</div>
    `;
  }

  /* The Following / Followers line for the profile popup (X-style). Reads the
     cached counts; shows a dot until the lazy scan fills them in. */
  _ppStatsInner(address, isOwn) {
    const c = (this._followCountCache || {})[(address || '').toLowerCase()];
    const fmt = n => (n === null || n === undefined) ? '·'
      : (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K' : n);
    const following = c ? c.following : (isOwn ? this.state.following.size : null);
    const followers = c ? c.followers : null;
    return `<span class="pp-stat" role="button" tabindex="0" data-pp-list="following"><strong>${fmt(following)}</strong> Following</span>
      <span class="pp-stat" role="button" tabindex="0" data-pp-list="followers"><strong>${fmt(followers)}</strong> Followers</span>`;
  }

  /* Cached, capped follow-count scan for the popup: one pass over the address's
     txs yields BOTH following (their outgoing FOLLOW) and followers (incoming),
     latest-action-per-peer wins. Capped to keep hovers snappy; the full profile
     page shows exact counts. */
  async _lazyFollowCounts(addr) {
    addr = (addr || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return null;
    this._followCountCache = this._followCountCache || {};
    /* Hydrate once from localStorage (12h TTL) so counts survive reloads and we
       don't re-scan the chain for accounts seen recently. */
    if (!this._fcHydrated) {
      this._fcHydrated = true;
      try {
        const stored = JSON.parse(utils.safeLS.get('sayitFollowCounts', '{}')) || {};
        const cutoff = Date.now() - 12 * 3600 * 1000;
        for (const [a, v] of Object.entries(stored)) {
          if (v && v.ts > cutoff) this._followCountCache[a] = { following: v.following, followers: v.followers };
        }
      } catch { /* ignore corrupt cache */ }
    }
    if (this._followCountCache[addr]) return this._followCountCache[addr];
    const isOwn = addr === this.state.signerAddr;
    const followingMap = new Map(), followerMap = new Map();
    const upd = (m, k, action, order) => { const p = m.get(k); if (!p || order >= p.order) m.set(k, { action, order }); };
    try {
      const limit = Math.min(this._getMaxScanPages(), 8);
      for (let page = 1; page <= limit; page++) {
        let raw = [];
        try { raw = await this.apiFetch(addr, page); } catch { break; }
        for (const tx of raw) {
          if (!tx.input || tx.input === '0x') continue;
          const from = tx.from?.toLowerCase();
          let text; try { text = ethers.toUtf8String(tx.input).trim(); } catch { continue; }
          const isF = text.startsWith(FOLLOW_PREFIX), isU = text.startsWith(UNFOLLOW_PREFIX);
          if (!isF && !isU) continue;
          const action = isF ? 'follow' : 'unfollow';
          const tgt = text.slice((isF ? FOLLOW_PREFIX : UNFOLLOW_PREFIX).length).trim().toLowerCase();
          const order = (Number(tx.blockNumber) || 0) * 100000 + (Number(tx.transactionIndex) || 0);
          if (from === addr && tgt) upd(followingMap, tgt, action, order);
          if (tgt === addr && from && from !== addr) upd(followerMap, from, action, order);
        }
        if (raw.length < 50) break;
      }
    } catch { /* leave counts as best-effort */ }
    const following = isOwn ? this.state.following.size
      : [...followingMap.values()].filter(v => v.action === 'follow').length;
    const followers = [...followerMap.values()].filter(v => v.action === 'follow').length;
    const counts = { following, followers };
    this._followCountCache[addr] = counts;
    /* Persist (12h TTL, capped) so a future session skips the scan. */
    try {
      const stored = JSON.parse(utils.safeLS.get('sayitFollowCounts', '{}')) || {};
      stored[addr] = { following, followers, ts: Date.now() };
      const keys = Object.keys(stored);
      if (keys.length > 300) {
        keys.sort((a, b) => (stored[a].ts || 0) - (stored[b].ts || 0))
          .slice(0, keys.length - 300).forEach(k => delete stored[k]);
      }
      utils.safeLS.set('sayitFollowCounts', JSON.stringify(stored));
    } catch { /* storage full/unavailable */ }
    return counts;
  }

  _positionPopup(popup, anchor) {
    const rect = anchor.getBoundingClientRect();
    popup.style.display = 'block';
    popup.style.visibility = 'hidden';
    const pw = popup.offsetWidth || 320;
    const ph = popup.offsetHeight || 200;
    popup.style.visibility = '';

    let left = rect.left;
    let top  = rect.bottom + 8;
    if (left + pw > window.innerWidth - 12) left = window.innerWidth - pw - 12;
    if (left < 12) left = 12;
    if (top + ph > window.innerHeight - 12) {
      const flipped = rect.top - ph - 8;
      top = flipped > 12 ? flipped : Math.max(12, window.innerHeight - ph - 12);
    }
    popup.style.left = left + 'px';
    popup.style.top  = top  + 'px';
  }

  _wirePopupDismiss() {
    /* Click handling is done by the permanent capture listener in wireListeners.
       Here we only add ESC (keydown) and scroll — both are safe to attach once
       per popup open since they call hideProfilePopup which is idempotent. */
    if (this._popupHandlersAttached) return;
    this._popupHandlersAttached = true;
    const dismiss = e => {
      if (e.type === 'keydown' && e.key === 'Escape') this.hideProfilePopup();
      else if (e.type === 'scroll') this.hideProfilePopup();
    };
    this._popupDismiss = dismiss;
    document.addEventListener('keydown', dismiss);
    window.addEventListener('scroll', dismiss, { passive: true, once: false });
  }

  hideProfilePopup() {
    const popup = this.g('profile-popup');
    if (!popup) return;
    /* Always clear 'visible' (idempotent, no early-return) so the popup can
       never get stuck on screen. The deferred 'open' removal is token-guarded
       (cleared on re-open) so a stale timer can't desync the classes. */
    clearTimeout(popup._pendingClose); popup._pendingClose = null;
    clearTimeout(popup._openRemoveTimer);
    popup.classList.remove('visible');
    popup._openRemoveTimer = setTimeout(() => popup.classList.remove('open'), 180);
    /* Clean up ESC/scroll listener (click is handled by permanent listener) */
    if (this._popupDismiss) {
      document.removeEventListener('keydown', this._popupDismiss);
      window.removeEventListener('scroll', this._popupDismiss);
      this._popupDismiss = null;
    }
    this._popupHandlersAttached = false;
  }

  /* ── Share card ─────────────────────────────────────────────────── */
  openShareCard(post) {
    const canvas  = this.g('share-canvas');
    const modal   = this.g('share-modal');
    const copyBtn = this.g('share-copy-img-btn');
    const linkBtn = this.g('share-copy-link-btn');
    const nativeBtn = this.g('share-native-btn');
    if (!canvas || !modal) {
      utils.copyToClipboard(txUrl(post.chainId, post.txHash), 'Link copied!');
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const W = 480, H = 280;
    canvas.width  = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#16181c'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#2f3336'; ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W-1, H-1);
    const c = this.state.profCache[post.reporter];
    const displayName = c?.username || this.trunc(post.reporter);
    const text = (post.display || '').slice(0, 280);
    const ts = this.relTime(post.timestamp);
    const brand = '#7c4dff';
    ctx.fillStyle = brand; ctx.fillRect(0, 0, 4, H);
    ctx.fillStyle = '#e7e9ea';
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillText(displayName, 24, 36);
    ctx.fillStyle = '#71767b';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('@' + this.trunc(post.reporter), 24, 54);
    ctx.fillStyle = '#2f3336'; ctx.fillRect(16, 64, W-32, 1);
    ctx.fillStyle = '#e7e9ea';
    ctx.font = '14px system-ui, sans-serif';
    const words = text.split(' ');
    let line = '', y = 88;
    for (const word of words) {
      const test = line + (line ? ' ' : '') + word;
      if (ctx.measureText(test).width > W-48 && line) {
        ctx.fillText(line, 24, y); line = word; y += 22;
        if (y > H-60) { ctx.fillText(line+'…', 24, y); line=''; break; }
      } else line = test;
    }
    if (line) ctx.fillText(line, 24, y);
    ctx.fillStyle = '#1d1f23'; ctx.fillRect(0, H-48, W, 48);
    ctx.fillStyle = '#71767b'; ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(ts + '  ·  PulseChain', 24, H-26);
    ctx.fillStyle = brand; ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText('Say It DeFi', W-100, H-26);
    modal.classList.add('open');
    this._trapFocus(modal);   /* keep Tab focus inside; restore on close */
    copyBtn.onclick = async () => {
      try {
        canvas.toBlob(async blob => {
          if (!blob) { utils.toast('Canvas error'); return; }
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          utils.toast('Image copied ✓');
        }, 'image/png');
      } catch { utils.toast('Copy not supported — try Share'); }
    };
    if (navigator.share && navigator.canShare) {
      nativeBtn.style.display = '';
      nativeBtn.onclick = async () => {
        try {
          const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          const file = new File([blob], 'post.png', { type:'image/png' });
          if (navigator.canShare({ files:[file] })) {
            await navigator.share({ files:[file], title:'Post on Say It DeFi',
              text: text.slice(0,100), url:txUrl(post.chainId, post.txHash) });
          } else {
            await navigator.share({ title:'Post on Say It DeFi',
              url:txUrl(post.chainId, post.txHash) });
          }
        } catch(err) { if(err.name!=='AbortError') utils.toast('Share failed: '+err.message); }
      };
    }
    linkBtn.onclick = () => utils.copyToClipboard(
      txUrl(post.chainId, post.txHash), 'Link copied!');
  }

  /* ── Mute / unmute ──────────────────────────────────────────────── */
  /* ── Lists & Communities persistence (localStorage) ─────────────── */
  _saveLists() {
    utils.safeLS.set(LISTS_KEY, JSON.stringify(this.state.lists));
  }
  _saveCommunities() {
    utils.safeLS.set(COMMUNITIES_KEY, JSON.stringify(this.state.communities));
  }

  /* Publish a snapshot of lists + joined communities on-chain as a single
     self-transaction. Portable across devices and publicly visible to
     anyone scanning the user's address. One tx per publish. */
  async publishListsOnChain() {
    if (!this.signer) { utils.toast('Connect wallet to publish'); return; }
    const snapshot = {
      v: 1,
      lists: this.state.lists.map(l => ({ id: l.id, name: l.name, members: l.members })),
      communities: this.state.communities
        .filter(c => c.joined)
        .map(c => ({ address: c.address, name: c.name, desc: c.desc || '' })),
    };
    const body = LC_SYNC_PREFIX + JSON.stringify(snapshot);
    /* No artificial size cap — the block gas limit is the real ceiling, and
       it's very large. If a snapshot ever exceeds what a block can hold the
       tx will simply fail at estimateGas, which we surface below. */
    try {
      const to    = this.state.signerAddr; /* self-tx */
      const data  = ethers.hexlify(ethers.toUtf8Bytes(body));
      const gas   = await this._estimateGasSafe({ to, value: '0', data }, (data.length - 2) / 2);
      const tx    = await this.signer.sendTransaction({ to, value: '0', data, gasLimit: gas });
      utils.toast('Publishing lists on-chain… you can keep browsing');
      await tx.wait();
      utils.toast('Lists published on-chain ✓');
    } catch (err) {
      const msg = err.reason || err.message || 'Unknown error';
      const rejected = err.code === 4001 || err.code === 'ACTION_REJECTED' || /user (denied|rejected)/i.test(msg);
      utils.toast(rejected ? 'Publish cancelled' : 'Publish failed: ' + msg);
    }
  }

  /* Silent best-effort restore used on connect — no toasts, only applies
     if it finds a snapshot, never overwrites a non-empty local store. */
  async _autoRestoreLists() {
    if (!this.state.signerAddr) return;
    if (this.state.lists.length || this.state.communities.length) return;
    try {
      let snapshot = null;
      const scanLimit = Math.min(this._getMaxScanPages(), 6);
      outer:
      for (let page = 1; page <= scanLimit; page++) {
        let raw;
        try { raw = await this.apiFetch(this.state.signerAddr, page); }
        catch { break; }
        for (const tx of raw) {
          if (tx.from?.toLowerCase() !== this.state.signerAddr) continue;
          if (!tx.input || tx.input === '0x') continue;
          let text;
          try { text = ethers.toUtf8String(tx.input).trim(); }
          catch { continue; }
          if (!text.startsWith(LC_SYNC_PREFIX)) continue;
          try { snapshot = JSON.parse(text.slice(LC_SYNC_PREFIX.length)); break outer; }
          catch { continue; }
        }
        if (raw.length < 50) break;
      }
      if (!snapshot) return;
      this.state.lists = (snapshot.lists || []).map(l => ({
        id: l.id, name: l.name, members: Array.isArray(l.members) ? l.members : [],
      }));
      this._saveLists();
      this.state.communities = (snapshot.communities || []).map(c => ({
        address: (c.address || '').toLowerCase(),
        name: c.name || this.trunc(c.address || ''),
        desc: c.desc || '', joined: true,
      })).filter(c => c.address);
      this._saveCommunities();
      utils.toast('Restored your lists from chain ✓');
    } catch { /* silent */ }
  }

  /* Restore lists + communities from the latest on-chain LC_SYNC snapshot
     in the user's outbox. Merges with local (on-chain wins for matching
     ids/addresses). Called on demand from the Lists/Communities pages. */
  async restoreListsFromChain() {
    if (!this.state.signerAddr) { utils.toast('Connect wallet first'); return; }
    utils.toast('Looking for your on-chain lists…');
    try {
      let snapshot = null;
      const scanLimit = Math.min(this._getMaxScanPages(), 10);
      outer:
      for (let page = 1; page <= scanLimit; page++) {
        let raw;
        try { raw = await this.apiFetch(this.state.signerAddr, page); }
        catch { break; }
        for (const tx of raw) {
          if (tx.from?.toLowerCase() !== this.state.signerAddr) continue;
          if (!tx.input || tx.input === '0x') continue;
          let text;
          try { text = ethers.toUtf8String(tx.input).trim(); }
          catch { continue; }
          if (!text.startsWith(LC_SYNC_PREFIX)) continue;
          try { snapshot = JSON.parse(text.slice(LC_SYNC_PREFIX.length)); break outer; }
          catch { continue; }
        }
        if (raw.length < 50) break;
      }
      if (!snapshot) { utils.toast('No on-chain lists found'); return; }
      /* Merge lists: on-chain entries replace local ones with the same id. */
      const localById = new Map(this.state.lists.map(l => [l.id, l]));
      (snapshot.lists || []).forEach(l => localById.set(l.id, {
        id: l.id, name: l.name, members: Array.isArray(l.members) ? l.members : [],
      }));
      this.state.lists = [...localById.values()];
      this._saveLists();
      /* Merge communities by address (mark restored ones joined). */
      const localByAddr = new Map(this.state.communities.map(c => [c.address, c]));
      (snapshot.communities || []).forEach(c => {
        const addr = (c.address || '').toLowerCase();
        if (!addr) return;
        localByAddr.set(addr, { address: addr, name: c.name || this.trunc(addr), desc: c.desc || '', joined: true });
      });
      this.state.communities = [...localByAddr.values()];
      this._saveCommunities();
      utils.toast('Restored from chain ✓');
      if (this.state.mode === 'lists') this.goLists();
      else if (this.state.mode === 'communities') this.goCommunities();
    } catch (err) {
      utils.toast('Restore failed: ' + (err.message || 'error'));
    }
  }
  _newListId() {
    return 'l_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ── LISTS ──────────────────────────────────────────────────────────
     A list is { id, name, members:[address] }. Viewing a list scans posts
     from all member addresses (same strategy as the Following feed). */
  goLists() {
    this._updateTitle('Lists');
    this._setRoute('/lists');
    this.setNav(null, null); /* reached via More — no sidebar button */
    this.state.mode = 'lists';
    this.state.activeList = null;
    this.g('compose-area').style.display   = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('feed-tabs').style.display      = 'none';
    this.g('new-banner').classList.remove('visible');
    this.g('loading-more').style.display   = 'none';
    this._pendingPageHeader = this._makePageHeader({ title: 'Lists', noBack: true });
    const header = this._applyPageHeader();
    this.g('feed').innerHTML = header + this._listsHTML();
    this._wireListsPage();
  }

  _listsHTML() {
    const lists = this.state.lists;
    const rows = lists.length === 0
      ? `<div class="placeholder-view" style="padding:48px 32px">
           <span class="ph-icon">📋</span>
           <h2>No lists yet</h2>
           <p>Create a list to curate posts from a specific set of accounts.</p>
         </div>`
      : lists.map(l => `
          <div class="lc-row" data-open-list="${utils.safe(l.id)}">
            <div class="lc-icon">📋</div>
            <div class="lc-body">
              <div class="lc-name">${utils.safe(l.name)}</div>
              <div class="lc-sub">${l.members.length} member${l.members.length === 1 ? '' : 's'}</div>
            </div>
            <button class="lc-action" data-edit-list="${utils.safe(l.id)}" title="Edit list" aria-label="Edit list">⚙</button>
          </div>`).join('');
    return `
      <div class="lc-page">
        <div class="lc-new-row">
          <input type="text" id="new-list-name" placeholder="New list name…" maxlength="40" autocomplete="off">
          <button class="go-btn" id="new-list-go">Create</button>
        </div>
        <div class="lc-sync-row">
          <button class="lc-sync-btn" id="lists-publish">⬆ Publish on-chain</button>
          <button class="lc-sync-btn ghost" id="lists-restore">⬇ Restore from chain</button>
        </div>
        ${rows}
      </div>`;
  }

  _wireListsPage() {
    const g = id => document.getElementById(id);
    const nameInput = g('new-list-name');
    const createBtn = g('new-list-go');
    const pubBtn = g('lists-publish');
    const resBtn = g('lists-restore');
    if (pubBtn) pubBtn.onclick = () => this.publishListsOnChain();
    if (resBtn) resBtn.onclick = () => this.restoreListsFromChain();
    const create = () => {
      const name = nameInput?.value.trim();
      if (!name) { utils.toast('Enter a list name'); return; }
      this.state.lists.push({ id: this._newListId(), name, members: [] });
      this._saveLists();
      this.goLists();
      utils.toast('List created ✓');
    };
    if (createBtn) createBtn.onclick = create;
    if (nameInput) nameInput.onkeydown = e => { if (e.key === 'Enter') create(); };
    this.g('feed').querySelectorAll('[data-open-list]').forEach(el => {
      el.onclick = e => {
        if (e.target.closest('[data-edit-list]')) return; /* let edit handler fire */
        this.openList(el.dataset.openList);
      };
    });
    this.g('feed').querySelectorAll('[data-edit-list]').forEach(el => {
      el.onclick = e => { e.stopPropagation(); this.openListEditor(el.dataset.editList); };
    });
  }

  /* List editor modal — rename, add/remove members, delete. */
  openListEditor(listId) {
    const list = this.state.lists.find(l => l.id === listId);
    if (!list) return;
    const memberRows = list.members.length
      ? list.members.map(addr => {
          const prof = this.state.profCache[addr];
          const name = prof?.username ? utils.safe(prof.username) : this.trunc(addr);
          const pic  = utils.safe(utils.safeUrl(prof?.picUrl) || 'image1.jpeg');
          return `<div class="settings-row" style="align-items:center">
            <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
              <img src="${pic}" data-fallback-src="image1.jpeg" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0">
              <div style="min-width:0">
                <div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
                <div style="font-size:12px;color:var(--muted)">@${utils.safe(this.trunc(addr))}</div>
              </div>
            </div>
            <button class="settings-btn" data-remove-member="${utils.safe(addr)}" style="flex-shrink:0">Remove</button>
          </div>`;
        }).join('')
      : `<div style="padding:12px;color:var(--muted);font-size:14px;text-align:center">No members yet. Add an address below.</div>`;

    this._showGenericModal('Edit List', `
      <div style="margin-bottom:12px">
        <label style="font-size:13px;color:var(--muted);display:block;margin-bottom:4px">List name</label>
        <input type="text" class="form-input" id="edit-list-name" value="${utils.safe(list.name)}" maxlength="40">
      </div>
      <div style="margin-bottom:8px">
        <label style="font-size:13px;color:var(--muted);display:block;margin-bottom:4px">Add member by address</label>
        <div style="display:flex;gap:8px">
          <input type="text" class="form-input" id="add-member-addr" placeholder="0x…" style="flex:1">
          <button class="btn-pri" id="add-member-btn" style="flex-shrink:0;padding:8px 16px">Add</button>
        </div>
      </div>
      <div id="list-members" style="max-height:260px;overflow-y:auto;margin:8px 0">${memberRows}</div>
      <div class="btn-row" style="margin-top:12px;justify-content:space-between">
        <button class="btn-ghost" id="delete-list-btn" style="color:#f4212e">Delete list</button>
        <button class="btn-pri" id="save-list-btn">Save</button>
      </div>
    `);

    const g = id => document.getElementById(id);
    g('add-member-btn').onclick = () => {
      const a = g('add-member-addr').value.trim().toLowerCase();
      if (!ethers.isAddress(a)) { utils.toast('Invalid address'); return; }
      if (list.members.includes(a)) { utils.toast('Already in this list'); return; }
      list.members.push(a);
      this._saveLists();
      this.openListEditor(listId); /* re-render */
    };
    g('add-member-addr').onkeydown = e => { if (e.key === 'Enter') g('add-member-btn').click(); };
    document.querySelectorAll('[data-remove-member]').forEach(btn => {
      btn.onclick = () => {
        const a = btn.dataset.removeMember;
        list.members = list.members.filter(m => m !== a);
        this._saveLists();
        this.openListEditor(listId);
      };
    });
    g('save-list-btn').onclick = () => {
      const newName = g('edit-list-name').value.trim();
      if (newName) list.name = newName;
      this._saveLists();
      this._closeGenericModal();
      if (this.state.mode === 'lists') this.goLists();
      utils.toast('List saved ✓');
    };
    g('delete-list-btn').onclick = () => {
      this.state.lists = this.state.lists.filter(l => l.id !== listId);
      this._saveLists();
      this._closeGenericModal();
      this.goLists();
      utils.toast('List deleted');
    };
  }

  /* Open a list's feed — scans posts from all member addresses. */
  async openList(listId) {
    const list = this.state.lists.find(l => l.id === listId);
    if (!list) return;
    this.state.mode = 'lists';
    this.state.activeList = listId;
    this._updateTitle(list.name);
    this.g('compose-area').style.display   = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('feed-tabs').style.display      = 'none';
    this.g('new-banner').classList.remove('visible');
    this.g('loading-more').style.display   = 'none';
    this._pendingPageHeader = this._makePageHeader({
      title: list.name, subtitle: `${list.members.length} members`, back: true });
    const header = this._applyPageHeader();
    if (list.members.length === 0) {
      this.g('feed').innerHTML = header + `
        <div class="placeholder-view" style="padding:48px 32px">
          <span class="ph-icon">📋</span>
          <h2>This list is empty</h2>
          <p>Add accounts to it from the Lists page (⚙ button).</p>
        </div>`;
      const back = this.g('feed').querySelector('.page-header-back');
      if (back) back.onclick = () => this.goLists();
      return;
    }
    this.g('feed').innerHTML = header + `
      <div class="placeholder-view" style="padding:48px 32px">
        <div class="spinner" aria-hidden="true" style="margin:0 auto 14px"></div>
        <h2>Loading ${utils.safe(list.name)}…</h2>
        <p>Scanning posts from ${list.members.length} accounts.</p>
      </div>`;
    const back = this.g('feed').querySelector('.page-header-back');
    if (back) back.onclick = () => this.goLists();
    await this._fetchListFeed(list, header);
  }

  /* Scan posts from a list's members and render them. Reuses the
     multi-address batch strategy from the Following feed. */
  async _fetchListFeed(list, header) {
    const myToken = (this._listFetchToken = (this._listFetchToken || 0) + 1);
    const addrs = list.members.slice(0, 200);
    const collected = [];
    const seen = new Set();
    const scanLimit = this._getMaxScanPages();
    const pagesPerAddr = scanLimit === Infinity ? 3 : Math.min(3, Math.ceil(scanLimit / 30));
    const BATCH = 5;
    for (let i = 0; i < addrs.length; i += BATCH) {
      if (myToken !== this._listFetchToken) return; /* superseded */
      const batch = addrs.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(async addr => {
        const pages = [];
        for (let pg = 1; pg <= pagesPerAddr; pg++) {
          try {
            const r = await this.apiFetch(addr, pg);
            pages.push(...r);
            if (r.length < 50) break;
            if (pg < pagesPerAddr) await this._scanDelay(100);
          } catch { break; }
        }
        return pages;
      }));
      results.forEach(res => {
        if (res.status !== 'fulfilled') return;
        res.value.forEach(tx => {
          const hash = tx.hash?.toLowerCase();
          if (!hash || seen.has(hash)) return;
          if (!tx.input || tx.input === '0x') return;
          /* Canonical parse — same poll/vote/repost/reply handling as the
             main feed (mode 'lists'). */
          const parsed = this._parsePostTx(tx, { mode: 'lists' });
          if (!parsed) return;
          seen.add(hash);
          collected.push(parsed);
        });
      });
    }
    if (myToken !== this._listFetchToken) return;
    if (this.state.mode !== 'lists' || this.state.activeList !== list.id) return;
    collected.sort((a, b) => (b._tsMs ??= new Date(b.timestamp).getTime()) - (a._tsMs ??= new Date(a.timestamp).getTime()));
    /* Render into the feed using the standard post pipeline */
    this.state.posts = collected;
    collected.forEach(pp => this._postMap.set(pp.txHash, pp));
    const replyMap = this._engagement.replyMap;
    const likeMap = this._engagement.likeMap;
    const repostMap = this._engagement.repostMap;
    const engagerMap = this._engagement.engagerMap;
    this._mergeEngagement(collected, false);
    let html = header;
    if (collected.length === 0) {
      html += `<div class="placeholder-view" style="padding:48px 32px">
        <span class="ph-icon">📋</span><h2>No posts found</h2>
        <p>These accounts haven't posted recently.</p></div>`;
    } else {
      html += '<div id="list-feed">' + collected.map(pp =>
        `<div class="post-item" data-txhash="${utils.safe(pp.txHash)}">${this.postHTML(pp, false, replyMap, likeMap, repostMap, engagerMap)}</div>`
      ).join('') + '</div>';
    }
    this.g('feed').innerHTML = html;
    const back = this.g('feed').querySelector('.page-header-back');
    if (back) back.onclick = () => this.goLists();
    const listFeed = this.g('list-feed');
    if (listFeed) listFeed.addEventListener('click', e => this.onFeedClick(e, false));
    this._tallyVisiblePolls();
    /* Lazy-load author profiles */
    collected.slice(0, 30).forEach(pp => {
      if (pp.reporter !== this.state.signerAddr) this.fetchOtherProfile(pp.reporter);
    });
  }

  /* ── COMMUNITIES ────────────────────────────────────────────────────
     A community is { address, name, desc, joined }. A community IS a
     channel address; viewing one reuses the channel-feed flow (goCustom). */
  goCommunities() {
    this._updateTitle('Communities');
    this._setRoute('/communities');
    this.setNav(null, null); /* reached via More — no sidebar button */
    this.state.mode = 'communities';
    this.g('compose-area').style.display   = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('feed-tabs').style.display      = 'none';
    this.g('new-banner').classList.remove('visible');
    this.g('loading-more').style.display   = 'none';
    this._pendingPageHeader = this._makePageHeader({ title: 'Communities', noBack: true });
    const header = this._applyPageHeader();
    this.g('feed').innerHTML = header + this._communitiesHTML();
    this._wireCommunitiesPage();
  }

  _communitiesHTML() {
    const comms = this.state.communities;
    const joined = comms.filter(c => c.joined);
    const discover = comms.filter(c => !c.joined);
    const card = c => `
      <div class="lc-row" data-open-comm="${utils.safe(c.address)}">
        <div class="lc-icon">👥</div>
        <div class="lc-body">
          <div class="lc-name">${utils.safe(c.name)}</div>
          <div class="lc-sub">${c.desc ? utils.safe(c.desc) : this.trunc(c.address)}</div>
        </div>
        <button class="lc-join ${c.joined ? 'joined' : ''}" data-toggle-join="${utils.safe(c.address)}">
          ${c.joined ? 'Joined' : 'Join'}
        </button>
      </div>`;
    let body = '';
    if (joined.length) {
      body += `<div class="lc-section-title">Your Communities</div>` + joined.map(card).join('');
    }
    if (discover.length) {
      body += `<div class="lc-section-title">Discover</div>` + discover.map(card).join('');
    }
    if (comms.length === 0) {
      body = `<div class="placeholder-view" style="padding:40px 32px">
        <span class="ph-icon">👥</span><h2>No communities yet</h2>
        <p>Create one by adding a channel address below.</p></div>`;
    }
    return `
      <div class="lc-page">
        <div class="lc-new-row lc-new-comm">
          <input type="text" id="new-comm-name" placeholder="Community name…" maxlength="40" autocomplete="off">
          <input type="text" id="new-comm-addr" placeholder="0x channel address…" autocomplete="off">
          <button class="go-btn" id="new-comm-go">Add</button>
        </div>
        <div class="lc-sync-row">
          <button class="lc-sync-btn" id="comms-publish">⬆ Publish on-chain</button>
          <button class="lc-sync-btn ghost" id="comms-restore">⬇ Restore from chain</button>
        </div>
        ${body}
      </div>`;
  }

  _wireCommunitiesPage() {
    const g = id => document.getElementById(id);
    const pubBtn = g('comms-publish');
    const resBtn = g('comms-restore');
    if (pubBtn) pubBtn.onclick = () => this.publishListsOnChain();
    if (resBtn) resBtn.onclick = () => this.restoreListsFromChain();
    const create = () => {
      const name = g('new-comm-name')?.value.trim();
      const addr = g('new-comm-addr')?.value.trim().toLowerCase();
      if (!name) { utils.toast('Enter a community name'); return; }
      if (!ethers.isAddress(addr)) { utils.toast('Invalid channel address'); return; }
      if (this.state.communities.some(c => c.address === addr)) {
        utils.toast('That community already exists'); return;
      }
      this.state.communities.push({ address: addr, name, desc: '', joined: true });
      this._saveCommunities();
      this.goCommunities();
      utils.toast('Community added ✓');
    };
    const goBtn = g('new-comm-go');
    if (goBtn) goBtn.onclick = create;
    this.g('feed').querySelectorAll('[data-open-comm]').forEach(el => {
      el.onclick = e => {
        if (e.target.closest('[data-toggle-join]')) return;
        this.openCommunity(el.dataset.openComm);
      };
    });
    this.g('feed').querySelectorAll('[data-toggle-join]').forEach(el => {
      el.onclick = e => {
        e.stopPropagation();
        const addr = el.dataset.toggleJoin;
        const c = this.state.communities.find(x => x.address === addr);
        if (c) { c.joined = !c.joined; this._saveCommunities(); this.goCommunities(); }
      };
    });
  }

  /* Open a community's feed — it's a channel, so reuse the channel flow. */
  async openCommunity(addr) {
    const c = this.state.communities.find(x => x.address === addr);
    if (!c) return;
    this.setNav(null, null);
    this.state.mode    = 'custom';
    this.state.channel = addr;
    this.g('feed-tabs').classList.remove('tabs-sticky');
    this.g('feed-tabs').style.display = 'none';
    this._pendingPageHeader = this._makePageHeader({
      title: c.name, subtitle: c.desc || 'Community', back: true });
    this.g('compose-area').style.display = 'flex';
    this.setChActive(null);
    this.updateChLabel();
    this.showChannelBanner(addr);
    await this.resetAndFetch();
    /* Override back button to return to the communities list */
    const back = this.g('feed')?.querySelector('.page-header-back')
      || document.querySelector('.page-header-back');
    if (back) back.onclick = () => this.goCommunities();
  }

  muteAddress(addr) {
    addr = addr.toLowerCase();
    if (this.state.muted.has(addr)) { utils.toast('Already muted'); return; }
    this.state.muted.add(addr);
    const list = [...this.state.muted];
    utils.safeLS.set(MUTE_KEY, JSON.stringify(list));
    this.cache.saveMuted(list).catch(err => console.warn('Mute IDB save:', err));
    utils.toast(`Muted ${this.trunc(addr)}`);
    this.renderFeed();
  }
  unmuteAddress(addr) {
    addr = addr.toLowerCase();
    this.state.muted.delete(addr);
    const list = [...this.state.muted];
    utils.safeLS.set(MUTE_KEY, JSON.stringify(list));
    this.cache.saveMuted(list).catch(err => console.warn('Unmute IDB save:', err));
    utils.toast(`Unmuted ${this.trunc(addr)}`);
    this.renderFeed();
  }
  isMuted(addr) { return !!(addr && this.state.muted.has(addr.toLowerCase())); }

  /* Build a <svg><use> reference to a sprite symbol. Returns the HTML
     string for inline injection. Defaults to 18px square. */
  icon(id, sz = 18) {
    return `<svg width="${sz}" height="${sz}" aria-hidden="true"><use href="#${id}"/></svg>`;
  }

  /* Focus trap for modals — keeps Tab/Shift+Tab focus inside the modal
     while it's open, returns focus to the previously-focused element on
     close. Called by classList.add('open') sites via openModal() if you
     want the trap; falls back gracefully if the modal has no focusable
     children. */
  _trapFocus(modalEl) {
    if (!modalEl) return;
    /* Save the element that triggered the modal so we can restore focus */
    modalEl._previousFocus = document.activeElement;
    /* Find focusable children */
    const focusableSel = 'a[href], button:not([disabled]), input:not([disabled]), ' +
                         'textarea:not([disabled]), select:not([disabled]), ' +
                         '[tabindex]:not([tabindex="-1"])';
    const focusables = Array.from(modalEl.querySelectorAll(focusableSel))
      .filter(el => !el.hasAttribute('hidden') && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last  = focusables[focusables.length - 1];
    /* Focus the first focusable element. Wrapped in rAF so it lands AFTER
       any close animations of other modals finish. */
    requestAnimationFrame(() => {
      try { first.focus(); } catch {}
    });
    /* Wire keydown handler. Stored on the element so we can remove it on close. */
    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      if (focusables.length === 1) {
        e.preventDefault();
        return;
      }
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    modalEl._focusTrapHandler = onKeyDown;
    modalEl.addEventListener('keydown', onKeyDown);
  }

  /* Release focus trap and restore prior focus. Called when a modal closes. */
  _releaseFocus(modalEl) {
    if (!modalEl) return;
    if (modalEl._focusTrapHandler) {
      modalEl.removeEventListener('keydown', modalEl._focusTrapHandler);
      modalEl._focusTrapHandler = null;
    }
    if (modalEl._previousFocus && modalEl._previousFocus.focus) {
      try { modalEl._previousFocus.focus(); } catch {}
      modalEl._previousFocus = null;
    }
  }

  /* Render N skeleton post placeholders into the feed. Used during initial
     fetch so the user sees structure immediately instead of a spinner. */
  _renderSkeleton(count = 4) {
    const feed = this.g('feed');
    if (!feed) return;
    const skel = Array(count).fill(0).map(() => `
      <div class="skel-post">
        <div class="skel-avatar"></div>
        <div class="skel-body">
          <div class="skel-line short"></div>
          <div class="skel-line long"></div>
          <div class="skel-line medium"></div>
        </div>
      </div>`).join('');
    feed.innerHTML = skel;
  }

  /* Set the browser tab/window title based on the current view. */
  _updateTitle(suffix) {
    /* Remember the per-view suffix so a later badge update can recompose
       the title without losing the current view label. */
    if (suffix !== undefined) this._titleSuffix = suffix;
    const base   = 'Say It DeFi';
    const middle = this._titleSuffix ? `${this._titleSuffix} / ${base}` : base;
    const prefix = this._unreadCount > 0
      ? `(${this._unreadCount > 99 ? '99+' : this._unreadCount}) ` : '';
    document.title = prefix + middle;
  }

  /* Draw the notification dot onto the favicon. Composites the base
     favicon image with a small red dot in the corner when there are
     unread notifications; restores the plain favicon when zero.
     Falls back silently if canvas/image operations fail. */
  _updateFavicon() {
    try {
      const link = document.querySelector('link[rel="icon"]');
      if (!link) return;
      const draw = (baseImg) => {
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (baseImg) {
          ctx.drawImage(baseImg, 0, 0, size, size);
        } else {
          /* No base image available — fill with brand color */
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, size, size);
        }
        if (this._unreadCount > 0) {
          /* Red dot, top-right */
          const r = 18;
          ctx.beginPath();
          ctx.arc(size - r - 2, r + 2, r, 0, Math.PI * 2);
          ctx.fillStyle = '#f91880';
          ctx.fill();
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
        link.href = canvas.toDataURL('image/png');
      };
      if (this._unreadCount <= 0) {
        /* Restore the plain favicon */
        link.href = 'title_icon.png';
        return;
      }
      if (this._faviconBase) {
        draw(this._faviconBase);
      } else {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { this._faviconBase = img; draw(img); };
        img.onerror = () => draw(null); /* draw dot on solid bg if image fails */
        img.src = 'title_icon.png';
      }
    } catch { /* favicon badge is non-essential — never throw */ }
  }

  /* Build and show the search suggestion dropdown for the given term.
     Suggests up to 5 people (from profile cache, matched by username or
     address) and up to 5 hashtags (from loaded posts). Clicking a person
     opens their profile; clicking a hashtag filters the feed by tag. */
  _renderSearchDropdown(term) {
    const dd  = this.g('search-dropdown');
    const inp = this.g('search-input');
    if (!dd) return;
    const q = (term || '').trim().toLowerCase();
    if (q.length < 1) { this._hideSearchDropdown(); return; }

    /* Full address typed/pasted → offer a direct jump even if we've never seen
       this address. It needn't be indexed; addresses are shareable, so this
       lets someone paste an address from anywhere and land on its profile. */
    const isFullAddr = /^0x[0-9a-f]{40}$/.test(q);
    const isTxHash   = /^0x[0-9a-f]{64}$/.test(q);

    /* People: match known profiles by username or address. Searches BOTH the
       live session cache and a lazy snapshot of the persisted profiles store,
       so handle search covers anyone we've ever cached (not just this session). */
    this._ensureProfileSnapshot();
    const people = [];
    const seen = new Set();
    const consider = (addr, prof) => {
      if (people.length >= 5) return;
      const addrL = (addr || '').toLowerCase();
      if (!addrL || !prof || seen.has(addrL)) return;
      const uname = (prof.username || '').toLowerCase();
      if (uname.includes(q) || addrL.includes(q)) {
        seen.add(addrL);
        people.push({ addr: addrL, username: prof.username || '', picUrl: prof.picUrl || 'image1.jpeg' });
      }
    };
    for (const [addr, prof] of Object.entries(this.state.profCache)) consider(addr, prof);
    if (Array.isArray(this._profileSnapshot)) {
      for (const p of this._profileSnapshot) consider(p.addr, p);
    }

    /* Hashtags: collect from loaded posts, count frequency, match the term. */
    const tagCounts = new Map();
    const tagQuery = q.replace(/^#/, '');
    for (const post of this.state.posts) {
      if (!post.display) continue;
      const tags = post.display.match(/#[A-Za-z0-9_]{2,30}/g);
      if (!tags) continue;
      for (const t of tags) {
        const key = t.slice(1).toLowerCase();
        if (key.includes(tagQuery)) {
          tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
        }
      }
    }
    const tags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (people.length === 0 && tags.length === 0 && !isFullAddr && !isTxHash) {
      dd.innerHTML = `<div class="search-dd-empty">No people or tags match “${utils.safe(term)}”<br><span style="font-size:13px">Press Enter to search post text</span></div>`;
      dd.classList.add('open');
      if (inp) inp.setAttribute('aria-expanded', 'true');
      return;
    }

    let html = '';
    if (isTxHash) {
      /* A full 64-hex transaction hash — offer to open it as a post thread.
         openThreadByHash resolves it via _fetchTxByHash even when the post
         isn't in the local cache. */
      const sh = utils.safe(q);
      html += `<div class="search-dd-section-title">Post</div>`;
      html += `<div class="search-dd-item" role="option" data-search-hash="${sh}">
        <div class="search-dd-tag-icon">📝</div>
        <div class="search-dd-body">
          <div class="search-dd-name">Open post</div>
          <div class="search-dd-sub">${utils.safe(this.trunc(q))} · view this transaction as a thread</div>
        </div>
      </div>`;
    }
    if (isFullAddr) {
      const sa = utils.safe(q), ta = utils.safe(this.trunc(q));
      html += `<div class="search-dd-section-title">Address</div>`;
      html += `<div class="search-dd-item" role="option" data-search-addr="${sa}" data-go="profile">
        <div class="search-dd-tag-icon">👤</div>
        <div class="search-dd-body">
          <div class="search-dd-name">View profile</div>
          <div class="search-dd-sub">${ta} · identity & posts by this address</div>
        </div>
      </div>`;
      html += `<div class="search-dd-item" role="option" data-search-addr="${sa}" data-go="channel">
        <div class="search-dd-tag-icon">#</div>
        <div class="search-dd-body">
          <div class="search-dd-name">Open chat</div>
          <div class="search-dd-sub">${ta} · public posts to this address</div>
        </div>
      </div>`;
    }
    if (people.length) {
      html += `<div class="search-dd-section-title">People</div>`;
      html += people.map(pp => {
        const name = pp.username ? utils.safe(pp.username) : this.trunc(pp.addr);
        return `<div class="search-dd-item" role="option" data-search-person="${utils.safe(pp.addr)}">
          <img src="${utils.safe(pp.picUrl)}" alt="" data-fallback-src="image1.jpeg">
          <div class="search-dd-body">
            <div class="search-dd-name">${name}</div>
            <div class="search-dd-sub">@${utils.safe(this.trunc(pp.addr))}</div>
          </div>
        </div>`;
      }).join('');
    }
    if (tags.length) {
      html += `<div class="search-dd-section-title">Tags</div>`;
      html += tags.map(([tag, count]) =>
        `<div class="search-dd-item" role="option" data-search-tag="${utils.safe(tag)}">
          <div class="search-dd-tag-icon">#</div>
          <div class="search-dd-body">
            <div class="search-dd-name">#${utils.safe(tag)}</div>
            <div class="search-dd-sub">${count} post${count === 1 ? '' : 's'} in view</div>
          </div>
        </div>`
      ).join('');
    }
    dd.innerHTML = html;
    dd.classList.add('open');
    if (inp) inp.setAttribute('aria-expanded', 'true');

    /* Wire item clicks */
    dd.querySelectorAll('[data-search-person]').forEach(el => {
      el.onclick = () => {
        const addr = el.dataset.searchPerson;
        this._hideSearchDropdown();
        this.goProfilePage(addr, addr === this.state.signerAddr);
      };
    });
    dd.querySelectorAll('[data-search-addr]').forEach(el => {
      el.onclick = () => {
        const addr = el.dataset.searchAddr;
        this._hideSearchDropdown();
        if (el.dataset.go === 'channel') {
          this.g('custom-input').value = addr;
          this.goCustom();
        } else {
          this.goProfilePage(addr, addr === this.state.signerAddr);
        }
      };
    });
    dd.querySelectorAll('[data-search-hash]').forEach(el => {
      el.onclick = () => {
        const hash = el.dataset.searchHash;
        this._hideSearchDropdown();
        this._clearSearch();
        if (/^0x[0-9a-f]{64}$/i.test(hash)) this.openThreadByHash(hash.toLowerCase());
      };
    });
    dd.querySelectorAll('[data-search-tag]').forEach(el => {
      el.onclick = () => {
        const tag = el.dataset.searchTag;
        this._hideSearchDropdown();
        const si = this.g('search-input');
        if (si) si.value = '#' + tag;
        this.state.searchTerm = ('#' + tag).toLowerCase();
        this.state.activeTag = tag;
        this._updateSearchClearBtn();
        if (this._selfManagedModes.has(this.state.mode)) {
          this.goHome().then(() => {
            this.state.searchTerm = ('#' + tag).toLowerCase();
            this.state.activeTag = tag;
            this.renderFeed();
          });
        } else {
          this.renderFeed();
        }
      };
    });
  }

  _hideSearchDropdown() {
    const dd = this.g('search-dropdown');
    if (dd) dd.classList.remove('open');
    const inp = this.g('search-input');
    if (inp) inp.setAttribute('aria-expanded', 'false');
  }

  /* Show/hide the search clear (X) button based on input content. */
  _updateSearchClearBtn() {
    const inp = this.g('search-input');
    const btn = this.g('search-clear');
    if (!inp || !btn) return;
    const has = inp.value.length > 0;
    btn.classList.toggle('show', has);
    inp.classList.toggle('has-value', has);
  }

  /* Reset search state + the search box. Called when navigating to a view that
     isn't a search result (e.g. the followers/following lists, Home) so a
     stale query can't linger in the box or filter the next feed. */
  _clearSearch() {
    this.state.searchTerm = '';
    this.state.activeTag  = null;
    const si = this.g('search-input');
    if (si) si.value = '';
    this._updateSearchClearBtn();
  }

  trunc = a => (a && a.length > 10) ? `${a.slice(0,6)}...${a.slice(-4)}` : (a || '');

  relTime = ts => {
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return '?';
      const s = Math.floor((Date.now() - d) / 1000);
      if (s < 0)       return 'just now'; /* future timestamp (clock skew) */
      if (s < 60)      return 'just now';
      if (s < 3600)    return `${Math.floor(s / 60)}m`;
      if (s < 86400)   return `${Math.floor(s / 3600)}h`;
      if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;   /* 1d–6d like X, then a date */
      if (s < 86400 * 365) {
        /* Same year: "Jan 5". Different year within last year: "Jan 5, 2024" */
        const now = new Date();
        const opts = d.getFullYear() === now.getFullYear()
          ? { month:'short', day:'numeric' }
          : { month:'short', day:'numeric', year:'numeric' };
        return d.toLocaleDateString('en-US', opts);
      }
      /* More than a year: "Jan 5, 2023" */
      return d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    } catch { return '?'; }
  };
}

const pulse = new SayIt();
/* Capture the URL hash at load time so a deep link (#/post/…, #/profile/…)
   isn't clobbered by the default Home bootstrap before we can route to it. */
const INITIAL_HASH = location.hash;
/* post/profile/channel views fetch their own data, so on a deep link to one
   of them we skip the default home-feed scan (it would otherwise run first
   and delay the deep-linked view's own scan). */
const DEEP_SELF_LOADING = /^#\/?(post|profile|channel)\//.test(INITIAL_HASH);
/* Default launch tab (Settings → Content & Feed). Honored only when the page
   wasn't opened on a deep link / explicit hash. A non-home choice loads its
   own data, so we skip the default home scan it would otherwise sit behind. */
const NO_DEEP_LINK = !INITIAL_HASH || /^#\/?(home)?$/.test(INITIAL_HASH);
let BOOT_VIEW = null;
if (NO_DEEP_LINK) {
  try { BOOT_VIEW = JSON.parse(localStorage.getItem('sayitSettings') || '{}').defaultView || null; } catch {}
  if (BOOT_VIEW === 'home') BOOT_VIEW = null;
}

/* ── Service Worker — offline shell + fast repeat loads ──────────────
   Registers sw.js which caches index.html and ethers.js for instant
   load on repeat visits. API calls (PulseScan) bypass the cache.
   To force a cache refresh after a new deploy:
     1. Bump SW_CACHE_VER at the top of this file
     2. Push to GitHub — the SW will detect the version mismatch
        on next page load and fetch fresh assets automatically. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        /* Pass the current cache version to the SW via postMessage
           so it knows when to invalidate its cache. */
        const sendVer = () => {
          if (reg.active) reg.active.postMessage({ type: 'CACHE_VER', ver: SW_CACHE_VER });
        };
        if (reg.active) sendVer();
        reg.addEventListener('updatefound', () => {
          reg.installing?.addEventListener('statechange', e => {
            if (e.target.state === 'activated') sendVer();
          });
        });
        /* Resend the version when a freshly-installed worker takes control.
           Without this, a just-activated SW that wasn't yet controlling the
           page at load never receives the new CACHE_VER, so the "new version
           available" toast is intermittently missed and users lag a deploy. */
        navigator.serviceWorker.addEventListener('controllerchange', sendVer);
        /* When the SW signals a new version is ready, show the user
           a refresh banner so they get the update without a hard reload. */
        navigator.serviceWorker.addEventListener('message', e => {
          if (e.data?.type === 'NEW_VERSION_READY') {
            utils.toast('↺ New version available — refresh to update');
          }
        });
        console.info('[SW] Registered, scope:', reg.scope);
      })
      .catch(err => console.warn('[SW] Registration failed:', err));
  });
}
pulse.init({ skipHomeFetch: DEEP_SELF_LOADING || !!BOOT_VIEW }).then(() => {
  /* Wire back/forward + manual hash edits, then honor any deep link the page
     was opened with (otherwise the normal Home bootstrap, or the user's chosen
     launch tab, stands). */
  pulse._initRouter();
  if (INITIAL_HASH && !/^#\/?(home)?$/.test(INITIAL_HASH)) {
    /* The Home bootstrap above may have pushed '#/home'; restore the original
       deep-link hash (no event) before routing to it. */
    history.replaceState(null, '', INITIAL_HASH);
    pulse._routeTo();
  } else if (BOOT_VIEW) {
    pulse._goDefaultView(BOOT_VIEW);
  }
}).catch(err => {
  console.error('Init error:', err);
  if (err.stack) console.error('Stack:', err.stack);
  utils.toast('Startup failed — reload and check console');
});
/* PWA install prompt — captures the beforeinstallprompt event on
   Chromium-based browsers so we can offer Install via our own UI later.
   Hidden if the user already installed or dismissed the prompt. */
(function wirePWAInstall() {
  let deferredPrompt = null;
  const DISMISS_KEY = 'sayit_install_dismissed';
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    /* Respect the user's previous dismiss for 14 days */
    try {
      const dismissed = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
      if (Date.now() - dismissed < 14 * 24 * 60 * 60 * 1000) return;
    } catch {}
    const card = document.getElementById('sb-install-card');
    if (card) card.classList.add('visible');
  });
  function bindButtons() {
    const installBtn = document.getElementById('install-btn');
    const dismissBtn = document.getElementById('install-dismiss');
    const card = document.getElementById('sb-install-card');
    if (installBtn) {
      installBtn.onclick = async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        try { await deferredPrompt.userChoice; } catch {}
        deferredPrompt = null;
        if (card) card.classList.remove('visible');
      };
    }
    if (dismissBtn) {
      dismissBtn.onclick = () => {
        try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {}
        if (card) card.classList.remove('visible');
      };
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindButtons);
  } else {
    bindButtons();
  }
  /* Hide the card once installation completes */
  window.addEventListener('appinstalled', () => {
    const card = document.getElementById('sb-install-card');
    if (card) card.classList.remove('visible');
  });
})();
/* Scroll-to-top button: shown when user scrolls past 800px.
   Click smoothly returns to the feed top. */
(function wireScrollTop() {
  function init() {
    const btn = document.createElement('button');
    btn.id = 'scroll-top-btn';
    btn.setAttribute('aria-label', 'Scroll to top');
    btn.title = 'Scroll to top';
    btn.textContent = '↑';
    btn.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    document.body.appendChild(btn);
    let lastY = 0;
    function onScroll() {
      const y = window.scrollY;
      if (y > 800 && lastY <= 800) btn.classList.add('visible');
      else if (y <= 800 && lastY > 800) btn.classList.remove('visible');
      lastY = y;
    }
    window.addEventListener('scroll', onScroll, { passive: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
