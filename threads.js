'use strict';
/* threads.js — the thread / post-detail screen, split out of app.js. Opening a
   thread (openThread / openThreadByHash), fetching its ancestors and replies
   (_fetchThreadAncestors / fetchThreadReplies), rendering the page + hero
   (_renderThreadPage / _threadHeroHTML), posting a reply from the thread page
   (_postThreadPageReply) and the back action (_threadBack).

   Deliberately LEFT in app.js: _hydrateFeedParent (it renders parent previews in
   the MAIN feed, called from feed render — feed-core, not thread-view).

   Boot-order safety (the established constraint): every method here is reached
   only via navigation (click / keyboard / router) or rendering — never init()'s
   synchronous prefix, which runs at app.js eval time before this file loads.

   Augments SayIt.prototype (defined in app.js); load order is core -> cache ->
   app -> settings -> profile -> polls -> notes -> spaces -> explore -> lists ->
   notifications -> channels -> threads -> embeds -> dm. Cross-refs (post
   rendering helpers, `this.cache`, `this._postMap`, ...) resolve via the shared
   scope or the prototype. */
const _THREADS = class {
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
    /* Reply stays NATIVE on the parent post's chain (same as the modal reply
       path). Without the explicit chain id, an inline reply to a non-Pulse post
       forced the wallet back to PulseChain — the "switches then flips back" bug. */
    const cid = Number(post.chainId) || CANONICAL_CHAIN_ID;
    const ok = await this.publish(text, post.txHash, post.to, cid);
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
};
for (const k of Object.getOwnPropertyNames(_THREADS.prototype)) {
  if (k !== 'constructor') SayIt.prototype[k] = _THREADS.prototype[k];
}
