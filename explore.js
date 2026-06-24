'use strict';
/* explore.js — the Explore page, split out of app.js. The whole tabbed Explore
   screen: entry/routing (goExplore / setExploreTab / _renderExplorePage /
   _renderExploreTab), in-page search (_exploreSearch / _exploreApplySearch /
   _exploreRenderResults / _wireExploreSearch), the paged result list
   (_exploreRenderPostList / _exploreRenderPaged / _exploreLoadMore /
   _exploreRenderLatest / _exploreResolveProfiles), trend computation
   (_computeTrends) and the per-tab HTML (_exploreTrendingHTML / _exploreNewsHTML
   / _explorePeopleHTML / _exploreChannelsHTML / _exploreMediaHTML).

   Boot-order safety (the settings.js/profile.js/spaces.js constraint): every
   method here is reached only via navigation (nav click / router) or rendering
   — never init()'s synchronous prefix, which runs at app.js eval time before
   this file loads. (_computeTrends is also called by the sidebar renderTrending
   that stays in app.js; that's a fine cross-file call, post-boot.)

   Augments SayIt.prototype (defined in app.js); load order is core -> cache ->
   app -> settings -> profile -> polls -> notes -> spaces -> explore -> embeds
   -> dm. Cross-refs (`utils`, `this.cache`, `this._postMap`, `this.renderFeed`,
   ...) resolve via the shared scope or the prototype. */
const _EXPLORE = class {
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
      `<button class="explore-tab${tab === id ? ' active' : ''}" data-explore-tab="${id}" role="tab" aria-selected="${tab === id ? 'true' : 'false'}">${label}</button>`;
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
};
for (const k of Object.getOwnPropertyNames(_EXPLORE.prototype)) {
  if (k !== 'constructor') SayIt.prototype[k] = _EXPLORE.prototype[k];
}
