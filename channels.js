'use strict';
/* channels.js — the Channels / chat screen, split out of app.js. Channel
   navigation (goChannels / goOfficialChannel), the recent-channels history
   (_touchChannelHistory / rebuildChannelHistory / renderChannelHistory /
   _openChannelFromHistory / _openChannelFromInput / _openChannelSpecial), the
   two-pane chat UI (_setChatTab / _autoSelectFirstChannel /
   _renderChannelPanePlaceholder / _selectChannelPane / _loadChannelPane /
   _chPaneLoadPage / _postToChannelPane), the channels page (_renderChannelPage),
   the channel banner/subtitle (showChannelBanner / _updateChannelSubtitle) and
   read-state (_getChannelSeen / _markChannelSeen / _markAllChannelsSeen /
   _channelIsUnread).

   Boot-order safety (the established constraint): every method here is reached
   only via navigation, rendering, a deferred handler, or the post-boot
   send-to-channel flow — never init()'s synchronous prefix, and the eagerly
   wired _wireChannelBar (which stays in app.js) calls none of them.

   Augments SayIt.prototype (defined in app.js); load order is core -> cache ->
   app -> settings -> profile -> polls -> notes -> spaces -> explore -> lists ->
   notifications -> channels -> embeds -> dm. Cross-refs (`utils`, `MAIN_CHANNEL`,
   `this.cache`, `this.renderFeed`, the staying token/banner helpers, ...) resolve
   via the shared scope or the prototype. */
const _CHANNELS = class {
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
            <button class="chat-toggle-btn${tab === 'channels' ? ' active' : ''}" data-chat-tab="channels" role="tab" aria-selected="${tab === 'channels' ? 'true' : 'false'}">Channels</button>
            <button class="chat-toggle-btn${tab === 'messages' ? ' active' : ''}" data-chat-tab="messages" role="tab" aria-selected="${tab === 'messages' ? 'true' : 'false'}">Messages 🔒</button>
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
};
for (const k of Object.getOwnPropertyNames(_CHANNELS.prototype)) {
  if (k !== 'constructor') SayIt.prototype[k] = _CHANNELS.prototype[k];
}
