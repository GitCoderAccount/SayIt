'use strict';
/* profile.js — the profile / social-graph subsystem, split out of app.js
   in installments. Contains:
     1. the follow-graph UI — following/follower lists (_showFollowingList /
        _showFollowerList / _scanFollowers / _renderFollowList /
        _renderFollowListMore / _renderFollowRow / _hydrateFollowRow), the
        follow/follower counts (_showFollowingCount / _fetchFollowerCount) and
        the follow toggle (toggleFollow);
     2. the profile PAGE — entry (openProfileModal / goProfilePage), render
        (_profilePageHTML), token-identity patches, listener wiring
        (_wireProfilePageListeners), the tab loader + chain scans
        (loadProfileTab / _scanProfilePages / _scanProfileExtraChains), and the
        own-profile edit form + on-chain save (showEditForm / saveProfile).
   Still pending in app.js for later installments: the profile-fetch helpers
   (fetchMyProfile / fetchOtherProfile), the profile infinite-scroll engine
   (_onProfileScroll / fetchProfileMore / _fillProfileViewport /
   _filterProfileTxs / _updateProfileSubtitle), and the token-profile editor
   (renderBanner / _openTokenProfileEditor / _publishTokenProfile / …).

   Boot-order note (same constraint that shaped settings.js): every method here
   is reached only via user navigation or a deferred event handler (onclick /
   keydown / the router / the profile-page render), NEVER from init()'s
   synchronous prefix — which runs at app.js eval time, before this file loads.
   So splitting them out is safe. Methods that ARE wired eagerly at boot (e.g.
   the hover popup via _wireHoverPopups in wireListeners) deliberately stay in
   app.js.

   These methods augment SayIt.prototype, defined in app.js; load order is
   core → cache → app → settings → profile → embeds → dm. The throwaway class
   below keeps method syntax clean; its methods are copied onto SayIt.prototype.
   Everything they reference resolves via the shared classic-script global scope
   (core.js consts like `utils`) or the prototype (`this._getMaxScanPages()`,
   `this.trunc()`, `this._lazyFollowCounts()`, …), so nothing has to be imported. */
const _PROF = class {
  /* Show a Twitter/X-style list of accounts this address follows.
     For own profile: read state.following (already loaded).
     For others: scan their sent txs for FOLLOW: prefixes. */
  async _showFollowingList(address, isOwn) {
    this.state.mode = 'followlist';
    this._clearSearch();
    this.g('compose-area').style.display = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('new-banner')?.classList.remove('visible');
    this.g('new-pill')?.classList.remove('visible');
    const feed = this.g('feed');
    if (!feed) return;
    const headerHTML = this._makePageHeader({ title: 'Following', back: true });
    feed.innerHTML = headerHTML + `<div class="prof-empty"><div class="spinner" aria-hidden="true"></div><h3>Loading…</h3></div>`;

    const backBtn = feed.querySelector('.page-header-back');
    if (backBtn) backBtn.onclick = () => this.goProfilePage(address, isOwn);

    let addrs = [];
    if (isOwn && this.state.signerAddr === address.toLowerCase()) {
      addrs = [...this.state.following];
    } else {
      /* Scan their SENT txs for FOLLOW:/UNFOLLOW: — latest action per target
         wins (txs arrive newest-first; an unfollow→refollow must resolve to
         the most recent action regardless of page order). */
      try {
        const targetAddr = address.toLowerCase();
        const lastAction = new Map(); /* target → { action, order } */
        const flimit = this._getMaxScanPages();
        const emptyD = feed.querySelector('.prof-empty');
        const progFL = emptyD ? document.createElement('p') : null;
        if (emptyD && progFL) emptyD.appendChild(progFL);
        for (let page = 1; (flimit === Infinity || page <= flimit); page++) {
          if (progFL) progFL.textContent = `Scanning page ${page}…`;
          let raw = [];
          try { raw = await this.apiFetch(targetAddr, page); }
          catch { break; }
          raw.forEach(tx => {
            if (tx.from?.toLowerCase() !== targetAddr) return; /* only their sent txs */
            if (!tx.input || tx.input === '0x') return;
            /* Composite on-chain order: block timestamps are per-SECOND, so
               an unfollow + re-follow in the same block share a ts and the
               tie-break becomes ambiguous (scan-order dependent). blockNumber
               then transactionIndex give the true, deterministic order. */
            const order = (Number(tx.blockNumber) || 0) * 100000
                        + (Number(tx.transactionIndex) || 0);
            try {
              const text = ethers.toUtf8String(tx.input).trim();
              let tgt = null, action = null;
              if (text.startsWith(FOLLOW_PREFIX)) {
                tgt = text.slice(FOLLOW_PREFIX.length).trim().toLowerCase(); action = 'follow';
              } else if (text.startsWith(UNFOLLOW_PREFIX)) {
                tgt = text.slice(UNFOLLOW_PREFIX.length).trim().toLowerCase(); action = 'unfollow';
              }
              if (tgt && action) {
                const prev = lastAction.get(tgt);
                if (!prev || order >= prev.order) lastAction.set(tgt, { action, order });
              }
            } catch { /* best-effort follow-graph scan: ignore a failed/malformed tx row, keep partial results */ }
          });
          if (raw.length < 50) break;
          await this._scanDelay(150);
        }
        addrs = [...lastAction.entries()].filter(([,v]) => v.action === 'follow').map(([a]) => a);
      } catch { /* best-effort follow-graph scan: ignore a failed/malformed tx row, keep partial results */ }
    }
    this._renderFollowList(feed, headerHTML, address, isOwn, addrs, 'Following', backBtn);
  }

  /* Show a list of addresses that follow this profile.
     Reads from the follower scan data we already have (or re-scans). */
  async _showFollowerList(address) {
    const feed = this.g('feed');
    if (!feed) return;
    /* Dedicated mode so pollNew / main-feed renders don't paint over this
       page (which previously made the compose box reappear at the top and
       could wipe the freshly-scanned follower list). */
    this.state.mode = 'followlist';
    this._clearSearch();
    const navToken = (this._navToken = (this._navToken || 0) + 1);
    this.g('compose-area').style.display = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('new-banner')?.classList.remove('visible');
    this.g('new-pill')?.classList.remove('visible');
    const isOwn = address.toLowerCase() === this.state.signerAddr?.toLowerCase();
    const headerHTML = this._makePageHeader({ title: 'Followers', back: true });

    const addr = address.toLowerCase();
    this._followerCache = this._followerCache || new Map();
    const cached = this._followerCache.get(addr);

    if (cached) {
      /* Show the cached result immediately — no loading spinner on revisit —
         then refresh quietly in the background and update only if changed. */
      const backBtnC = this._renderFollowList(feed, headerHTML, address, isOwn, cached, 'Followers', null);
      const fresh = await this._scanFollowers(addr, navToken, null);
      if (fresh && this.state.mode === 'followlist' && navToken === this._navToken) {
        if (fresh.length !== cached.length || fresh.some((a, i) => a !== cached[i])) {
          this._followerCache.set(addr, fresh);
          this._renderFollowList(feed, headerHTML, address, isOwn, fresh, 'Followers', null);
        }
      }
      return;
    }

    /* No cache yet — show the loading UI and scan. */
    feed.innerHTML = headerHTML + `<div class="prof-empty"><div class="spinner" aria-hidden="true"></div><h3>Loading…</h3></div>`;
    const backBtn = feed.querySelector('.page-header-back');
    if (backBtn) backBtn.onclick = () => this.goProfilePage(address, isOwn);
    const progEl = feed.querySelector('.prof-empty');
    const prog   = progEl ? document.createElement('p') : null;
    if (progEl && prog) progEl.appendChild(prog);

    const addrs = await this._scanFollowers(addr, navToken, prog);
    if (!addrs || this.state.mode !== 'followlist' || navToken !== this._navToken) return;
    this._followerCache.set(addr, addrs);
    this._renderFollowList(feed, headerHTML, address, isOwn, addrs, 'Followers', backBtn);
  }

  /* Raw follower scan → returns the resolved follower address array, or null
     if it was aborted by navigation. Shared by the cached entry point above. */
  async _scanFollowers(addr, navToken, prog, maxPages = Infinity) {
    /* Track the LATEST action per follower (txs arrive newest-first; an
       unfollow→refollow must resolve to the most recent action). */
    const lastAction = new Map(); /* from → { action, order } */
    try {
      const flimit2 = Math.min(this._getMaxScanPages(), maxPages);
      for (let page = 1; (flimit2 === Infinity || page <= flimit2); page++) {
        if (prog) prog.textContent = `Scanning page ${page}…`;
        if (navToken !== this._navToken) return null; /* navigated away */
        let raw = [];
        try { raw = await this.apiFetch(addr, page); }
        catch { break; }
        raw.forEach(tx => {
          if (!tx.input || tx.input === '0x') return;
          const from = tx.from?.toLowerCase();
          const to   = tx.to?.toLowerCase();
          if (from === addr) return; /* a follow FROM this addr isn't a follower */
          /* Composite on-chain order — see note in the following-list scan:
             same-block unfollow+refollow share a per-second ts, so we order by
             blockNumber then transactionIndex for a deterministic latest action. */
          const order = (Number(tx.blockNumber) || 0) * 100000
                      + (Number(tx.transactionIndex) || 0);
          try {
            const text = ethers.toUtf8String(tx.input).trim();
            let action = null;
            if (text.startsWith(FOLLOW_PREFIX)) {
              const target = text.slice(FOLLOW_PREFIX.length).trim().toLowerCase();
              /* Strict: the PAYLOAD must name this address. A tx merely
                 sent here whose payload follows someone else must not
                 count as a follower of this address. */
              if (target === addr) action = 'follow';
            } else if (text.startsWith(UNFOLLOW_PREFIX)) {
              const target = text.slice(UNFOLLOW_PREFIX.length).trim().toLowerCase();
              if (target === addr) action = 'unfollow';
            }
            if (action) {
              const prev = lastAction.get(from);
              if (!prev || order >= prev.order) lastAction.set(from, { action, order });
            }
          } catch { /* best-effort follow-graph scan: ignore a failed/malformed tx row, keep partial results */ }
        });
        if (raw.length < 50) break;
        await this._scanDelay(150);
      }
    } catch { /* best-effort follow-graph scan: ignore a failed/malformed tx row, keep partial results */ }
    return [...lastAction.entries()].filter(([,v]) => v.action === 'follow').map(([a]) => a);
  }

  /* Render a single row for the Followers/Following list. Used by both
     the initial render (_renderFollowList) and the "Show more" expand
     (_renderFollowListMore) so both pages produce identical row markup. */
  _renderFollowRow(addr) {
    const c           = this.state.profCache[addr] || {};
    const name        = c.username ? utils.safe(c.username) : this.trunc(addr);
    const pic         = utils.safe(utils.safeUrl(c.picUrl) || 'image1.jpeg');
    const isFollowing = this.state.following.has(addr);
    const isSelf      = addr === this.state.signerAddr?.toLowerCase();
    const followBtn   = (!isSelf && this.signer)
      ? `<button class="prof-follow-btn${isFollowing ? ' following' : ''}"
          data-act="follow-toggle" data-act-arg="${utils.safe(addr)}"
          style="padding:6px 16px;font-size:13px">${isFollowing ? 'Following' : 'Follow'}</button>`
      : '';
    const bioLine = c.bio
      ? `<div style="font-size:13px;color:var(--text);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${utils.safe(c.bio.slice(0,80))}</div>`
      : '';
    return `
      <div class="post-item follow-list-row" data-follow-addr="${utils.safe(addr)}"
        style="cursor:pointer;display:flex;align-items:center;gap:12px;padding:12px 16px"
        data-act="open-profile" data-act-arg="${utils.safe(addr)}" data-act-arg2="${isSelf ? '1' : ''}">
        <img class="follow-list-avatar" alt="" src="${pic}" data-pop-addr="${utils.safe(addr)}"
          style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0"
          data-fallback-src="image1.jpeg" loading="lazy">
        <div style="flex:1;min-width:0">
          <div class="follow-list-name" data-pop-addr="${utils.safe(addr)}" style="font-weight:700;font-size:15px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
          <div style="font-size:13px;color:var(--muted)">@${utils.safe(this.trunc(addr))}</div>
          ${bioLine}
        </div>
        ${followBtn}
      </div>`;
  }

  /* Lazy-load profile data for a row, then patch its name+avatar in-place
     once the profile resolves. Shared by both pages of the follow list. */
  _hydrateFollowRow(feed, addr) {
    const c = this.state.profCache[addr] || {};
    if (c.username) return;
    this.fetchOtherProfile(addr).then(() => {
      const row = feed.querySelector(`[data-follow-addr="${addr}"]`);
      if (!row) return;
      const prof = this.state.profCache[addr];
      if (!prof?.username) return;
      const nameEl = row.querySelector('.follow-list-name');
      const imgEl  = row.querySelector('.follow-list-avatar');
      if (nameEl) nameEl.textContent = prof.username;
      if (imgEl && prof.picUrl !== 'image1.jpeg') imgEl.src = prof.picUrl;
    }).catch(() => {});
  }

  /* Shared renderer for Followers/Following list screens.
     Shows avatar, name, handle, follow button — exactly like X. */
  _renderFollowList(feed, headerHTML, profileAddr, profileIsOwn, addrs, title, backBtn) {
    if (!addrs.length) {
      feed.innerHTML = headerHTML + `<div class="prof-empty"><span>👥</span><h3>No ${title}</h3><p>None yet.</p></div>`;
      const nb = feed.querySelector('.page-header-back');
      if (nb) nb.onclick = () => this.goProfilePage(profileAddr, profileIsOwn);
      return;
    }
    /* Paginate: first 50 visible, then "Show more" */
    const PAGE_SIZE = 50;
    const renderPage = (start) => {
      const slice = addrs.slice(start, start + PAGE_SIZE);
      let listHTML = slice.map(addr => this._renderFollowRow(addr)).join('');
      /* "Show more" button if more pages exist */
      const hasMore = (start + PAGE_SIZE) < addrs.length;
      if (hasMore) {
        const remaining = addrs.length - (start + PAGE_SIZE);
        listHTML += `<div style="padding:16px;text-align:center">
          <button class="btn-ghost" data-act="follow-more" data-act-arg="${start + PAGE_SIZE}"
            style="padding:10px 24px">
            Show ${Math.min(remaining, PAGE_SIZE)} more (${remaining} remaining)
          </button>
        </div>`;
      }
      if (start === 0) {
        feed.innerHTML = headerHTML + listHTML;
      } else {
        /* Append: remove old "show more" and append new rows */
        const oldBtn = feed.querySelector('[onclick*="_renderFollowListMore"]')?.closest('div');
        if (oldBtn) oldBtn.remove();
        feed.insertAdjacentHTML('beforeend', listHTML);
      }
      /* Hydrate profile names/avatars asynchronously */
      slice.forEach(addr => this._hydrateFollowRow(feed, addr));
      /* Wire back button */
      const newBack = feed.querySelector('.page-header-back');
      if (newBack) newBack.onclick = () => this.goProfilePage(profileAddr, profileIsOwn);
    };

    /* Store context for "show more" button */
    this._followListCtx = { feed, headerHTML, profileAddr, profileIsOwn, addrs, title };
    renderPage(0);
  }

  _renderFollowListMore(btn, nextStart) {
    const ctx = this._followListCtx;
    if (!ctx) return;
    const { feed, addrs } = ctx;
    const PAGE_SIZE = 50;
    const slice = addrs.slice(nextStart, nextStart + PAGE_SIZE);
    let listHTML = slice.map(addr => this._renderFollowRow(addr)).join('');
    const hasMore = (nextStart + PAGE_SIZE) < addrs.length;
    if (hasMore) {
      const remaining = addrs.length - (nextStart + PAGE_SIZE);
      listHTML += `<div style="padding:16px;text-align:center">
        <button class="btn-ghost" data-act="follow-more" data-act-arg="${nextStart + PAGE_SIZE}"
          style="padding:10px 24px">
          Show ${Math.min(remaining, PAGE_SIZE)} more (${remaining} remaining)
        </button>
      </div>`;
    }
    const oldBtnEl = btn.closest('div');
    if (oldBtnEl) oldBtnEl.remove();
    feed.insertAdjacentHTML('beforeend', listHTML);
    /* Hydrate profile data for the new rows */
    slice.forEach(addr => this._hydrateFollowRow(feed, addr));
  }

  async _showFollowingCount(address = null, isOwn = false) {
    const el = document.getElementById('prof-following-count');
    if (!el) return;
    /* Own profile: state.following is already loaded and authoritative. */
    if (isOwn || (address && address.toLowerCase() === this.state.signerAddr)) {
      el.innerHTML = `<strong>${this.state.following.size}</strong> Following`;
      return;
    }
    if (!address) { el.innerHTML = `<strong>0</strong> Following`; return; }
    /* Other profile: scan THEIR outgoing FOLLOW/UNFOLLOW txs, latest action
       per target wins (composite blockNumber+txIndex order). */
    const navAddr = address.toLowerCase();
    const lastAction = new Map(); /* target → { action, order } */
    try {
      const limit = this._getMaxScanPages();
      for (let page = 1; (limit === Infinity || page <= limit); page++) {
        let raw = [];
        try { raw = await this.apiFetch(navAddr, page); }
        catch { break; }
        raw.forEach(tx => {
          if (tx.from?.toLowerCase() !== navAddr) return; /* only their sent txs */
          if (!tx.input || tx.input === '0x') return;
          const order = (Number(tx.blockNumber) || 0) * 100000
                      + (Number(tx.transactionIndex) || 0);
          try {
            const text = ethers.toUtf8String(tx.input).trim();
            let tgt = null, action = null;
            if (text.startsWith(FOLLOW_PREFIX)) {
              tgt = text.slice(FOLLOW_PREFIX.length).trim().toLowerCase(); action = 'follow';
            } else if (text.startsWith(UNFOLLOW_PREFIX)) {
              tgt = text.slice(UNFOLLOW_PREFIX.length).trim().toLowerCase(); action = 'unfollow';
            }
            if (tgt && action) {
              const prev = lastAction.get(tgt);
              if (!prev || order >= prev.order) lastAction.set(tgt, { action, order });
            }
          } catch { /* best-effort follow-graph scan: ignore a failed/malformed tx row, keep partial results */ }
        });
        /* Live update as pages come in (only while still on this profile). */
        if (this.state.mode === 'profile' && this.state.channel === navAddr) {
          const live = [...lastAction.values()].filter(v => v.action === 'follow').length;
          const elNow = document.getElementById('prof-following-count');
          if (elNow) elNow.innerHTML = `<strong>${live}</strong> Following`;
        }
        if (raw.length < 50) break;
        await this._scanDelay(150);
      }
    } catch { /* best-effort follow-graph scan: ignore a failed/malformed tx row, keep partial results */ }
    if (this.state.mode === 'profile' && this.state.channel === navAddr) {
      const n = [...lastAction.values()].filter(v => v.action === 'follow').length;
      const elNow = document.getElementById('prof-following-count');
      if (elNow) elNow.innerHTML = `<strong>${n}</strong> Following`;
    }
  }

  async _fetchFollowerCount(address) {
    /* FOLLOW txs are sent TO the target address. Scan that address's
       received txs for FOLLOW/UNFOLLOW markers.
       Key insight: scan ascending (oldest first) — FOLLOW txs tend to be
       early in an address's history. Descending would bury them on later pages. */
    const el = document.getElementById('prof-follower-count');
    if (!el) return;
    try {
      const addr = address.toLowerCase();
      const follows = new Map(); /* follower address → 'follow'|'unfollow' */

      /* Respect the user's scan-depth setting fully (unlimited if they set
         it to 0). Follows can appear anywhere in history — recent followers
         live in recent txs — so we no longer cap or early-exit aggressively. */
      /* Use apiFetch (retry/backoff + consistent parsing). The previous
         manual fetch could fail silently on a transient error or unexpected
         status field — the likely reason the count showed 0 despite real
         followers. Accept a follow if the payload names this address OR the
         tx was sent to it. */
      /* Track the LATEST action per follower. Txs arrive newest-first
         (sort=desc), and an address may follow→unfollow→refollow. Keeping
         the highest-timestamp action (not last-write) is the only correct
         way to resolve the final state regardless of scan/page order. */
      const lastAction = new Map(); /* from → { action, order } */
      /* Tips piggyback on this same received-tx scan — zero extra calls. */
      let tipCount = 0, tipWei = 0n;
      const tipSeen = new Set();
      const fcLimit = this._getMaxScanPages();
      for (let page = 1; (fcLimit === Infinity || page <= fcLimit); page++) {
        let raw = [];
        try { raw = await this.apiFetch(addr, page); }
        catch { break; }

        raw.forEach(tx => {
          const from = tx.from?.toLowerCase();
          const to   = tx.to?.toLowerCase();
          if (from === addr) return; /* a follow FROM this addr isn't a follower */
          if (!tx.input || tx.input === '0x') return;
          /* Composite on-chain order — see note in the following-list scan:
             same-block unfollow+refollow share a per-second ts, so we order by
             blockNumber then transactionIndex for a deterministic latest action. */
          const order = (Number(tx.blockNumber) || 0) * 100000
                      + (Number(tx.transactionIndex) || 0);
          try {
            const text = ethers.toUtf8String(tx.input).trim();
            let action = null;
            if (text.startsWith(FOLLOW_PREFIX)) {
              const target = text.slice(FOLLOW_PREFIX.length).trim().toLowerCase();
              if (target === addr || to === addr) action = 'follow';
            } else if (text.startsWith(UNFOLLOW_PREFIX)) {
              const target = text.slice(UNFOLLOW_PREFIX.length).trim().toLowerCase();
              if (target === addr || to === addr) action = 'unfollow';
            } else if (text.startsWith(TIP_PREFIX) && !tipSeen.has(tx.hash)) {
              tipSeen.add(tx.hash);
              tipCount++;
              try { tipWei += BigInt(tx.value || 0); } catch { /* odd value field */ }
            }
            if (action) {
              const prev = lastAction.get(from);
              if (!prev || order >= prev.order) lastAction.set(from, { action, order });
            }
          } catch { /* best-effort follow-graph scan: ignore a failed/malformed tx row, keep partial results */ }
        });

        /* Rebuild the follows map from latest actions; update live count. */
        follows.clear();
        for (const [f, { action }] of lastAction) follows.set(f, action);
        const live = [...follows.values()].filter(v => v === 'follow').length;
        const elNow = document.getElementById('prof-follower-count');
        if (elNow) elNow.innerHTML = `<strong>${live}</strong> Followers`;
        /* Live-update the tips badge as pages land. */
        const tipsEl = document.getElementById('prof-tips');
        if (tipsEl && tipCount > 0) {
          tipsEl.style.display = '';
          tipsEl.textContent = `💎 ${tipCount} tip${tipCount === 1 ? '' : 's'} · ${utils.fmtPLS(tipWei.toString())} PLS`;
        }

        if (raw.length < 50) break; /* last page — reached the end */
      }
    } catch { /* silent */ }
  }

  async toggleFollow(address, btn) {
    if (!this.signer) { utils.toast('Connect wallet to follow'); return; }
    const addr = address.toLowerCase();
    /* Address-level guard: the passed btn is disabled below, but the popup
       calls this with btn=null and the same address can have several visible
       buttons — guard by address so a double-tap can't double-fire. */
    if (!this._reactionBusy('follow:' + addr)) return;
    try {
    const isFollowing = this.state.following.has(addr);
    /* Send FOLLOW/UNFOLLOW TO the target address (not self-send).
       This lets the target count followers by scanning their received txs.
       You find your following list by scanning your own sent FOLLOW: txs. */
    const prefix = isFollowing ? UNFOLLOW_PREFIX : FOLLOW_PREFIX;
    /* Optimistic UI: update immediately, revert on failure */
    if (btn) {
      btn.disabled    = true;
      btn.textContent = isFollowing ? 'Unfollowing…' : 'Following…';
    }
    const ok = await this.publish(prefix + addr, null, addr);
    if (btn) btn.disabled = false;
    if (ok) {
      /* Toggle the .following modifier — don't replace className, which stripped
         the base class off non-profile buttons (e.g. .explore-follow-btn). */
      if (isFollowing) {
        this.state.following.delete(addr);
        if (btn) { btn.textContent = 'Follow'; btn.classList.remove('following'); }
      } else {
        this.state.following.add(addr);
        if (btn) { btn.textContent = 'Following'; btn.classList.add('following'); }
      }
      this._showFollowingCount();
      /* A follow/unfollow changes follower lists — drop cached scans so the
         next visit re-scans fresh. */
      this._followerCache?.delete(addr);
      this._followerCache?.delete(this.state.signerAddr);
      /* Refresh Who-to-follow (drops the followed account) and sync any other
         visible follow buttons for this address. */
      setTimeout(() => {
        this.renderWhoToFollow?.();
        document.querySelectorAll(`[data-follow-addr="${addr}"], [data-explore-follow="${addr}"]`).forEach(b => {
          const following = this.state.following.has(addr);
          b.textContent = following ? 'Following' : 'Follow';
          b.classList.toggle('following', following);
        });
      }, 1200);
    } else {
      /* Revert on failure — restore original text/state */
      if (btn) {
        btn.textContent = isFollowing ? 'Following' : 'Follow';
        btn.classList.toggle('following', isFollowing);
      }
    }
    } finally {
      this._pendingTx.delete('follow:' + addr);
    }
  }

  /* ── Profile PAGE (installment 2): the profile view/edit screen —
     entry (openProfileModal / goProfilePage), render (_profilePageHTML),
     token-identity patches, listener wiring (_wireProfilePageListeners),
     the posts/replies/etc. tab loader + chain scans (loadProfileTab /
     _scanProfilePages / _scanProfileExtraChains), and the own-profile edit
     form + on-chain save (showEditForm / saveProfile). All navigation- or
     handler-triggered, never init's sync prefix. ──────────────────────── */
  openProfileModal() {
    /* Own profile: go to profile page */
    if (this.state.signerAddr) {
      this.goProfilePage(this.state.signerAddr, true);
    } else {
      utils.toast('Connect wallet to view your profile');
    }
  }

  async goProfilePage(address, isOwn = false) {
    this._setRoute('/profile/' + address);
    this.setNav(isOwn ? 'nav-profile' : null, isOwn ? 'profile' : null);
    /* Title placeholder until profile resolves. Refined below if cached. */
    const cachedName = this.state.profCache[address]?.username
      || (isOwn ? this.state.profile?.username : null);
    this._updateTitle(cachedName ? '@' + cachedName : 'Profile');
    this.state.mode    = 'profile';
    this.state.channel = address; /* prevent renderFeed from overwriting this page */
    /* Bump the fetch token so any in-flight main-feed fetchPosts becomes a
       no-op — otherwise its guarded "Load more from chain" button write
       (guarded only by myToken === _fetchToken) lands on top of this
       profile page. */
    this._fetchToken++;
    this.state.loading = false;
    this.g('compose-area').style.display   = 'none';
    this.g('channel-banner').style.display = 'none';
    this.g('feed-tabs').style.display      = 'none';
    this.g('new-banner').classList.remove('visible');
    this.g('loading-more').style.display   = 'none';
    this.g('loading-more').innerHTML       = '<div class="spinner sp-feed" aria-hidden="true"></div>Scanning the chain…'; /* reset any leftover button */
    /* Set a real title so the header isn't blank */
    /* page header via _makePageHeader handles the title now */

    /* Profile data resolution:
       - Own profile: always start with state.profile (may be partial — has
         picUrl + bio even without username). Then try cache. Always render
         what we have; trigger a fresh on-chain fetch in the background. */
    let prof;
    if (isOwn) {
      /* state.profile is initialized at construction so always truthy. Use
         whatever fields are populated rather than gate-keeping on username. */
      prof = this.state.profile || {};
      const hasAnyData = !!(prof.username || prof.bio || prof.coverUrl ||
                            (prof.picUrl && prof.picUrl !== 'image1.jpeg'));
      if (!hasAnyData) {
        /* Try IndexedDB cache fallback */
        try {
          const cached = await this.cache.getProfile(address);
          if (cached) { this.applyProfile(cached); prof = this.state.profile; }
        } catch (err) { console.warn('Profile cache miss:', err); }
      }
    } else {
      /* Don't BLOCK on the profile-data fetch — render the page and start
         loading posts immediately, then let the profile fill in async. Awaiting
         here meant other users' profiles sat through a full profile-data scan
         before their posts even began loading (looked like "just scanning"). */
      prof = this.state.profCache[address] || {};
      if (!this.state.profCache[address]) this.fetchOtherProfile(address);
    }
    if (!prof) prof = {};

    /* Initialize profile-page pagination state. This is what enables
       infinite scroll on profile pages — see _onProfileScroll. */
    this._profilePageState = {
      address: address.toLowerCase(),
      isOwn,
      tab: 'posts',
      pagesScanned: 0,
      loading: false,
      hasMore: true,
      rawTxs: [],
      visibleTxHashes: new Set(),
    };

    this.g('feed-tabs').classList.remove('tabs-sticky');
    /* Profile header: back arrow + Name + post count + search icon.
       Post count starts empty (may not be loaded yet) and updates
       in-place after loadProfileTab finishes. */
    const profHeaderHTML = this._makePageHeader({
      title: prof.username || this.trunc(address),
      subtitle: '',   /* filled in by _updateProfileSubtitle after tab loads */
      back: true,
      searchAddr: address,
    });
    this.g('feed').innerHTML = profHeaderHTML + this._profilePageHTML(address, prof, isOwn);
    this._wireProfilePageListeners(address, isOwn);
    /* Fill the "On-chain since <Month Year>" line async (X's Joined parity).
       Mirrors the prof-tips pattern: empty span, filled when the call lands. */
    this._fillFirstSeen(address);
    /* If this profile is a token contract, fill in its identity (logo, name,
       banner, verified profile, links) the same way the channel banner does. */
    if (!isOwn) this._applyTokenIdentityToProfile(address);

    /* Profile scan depth comes from the global Max scan pages setting.
       This way users who bump it to 200 or unlimited get correspondingly
       deeper profile history without having to set per-page values.
       Other users get scanned a bit less aggressively (half the cap) to
       avoid pounding the API on every profile visit. */
    const globalLimit = this._getMaxScanPages();
    const maxPages    = isOwn ? globalLimit : Math.min(globalLimit, Math.max(50, Math.floor(globalLimit / 2)));
    this.loadProfileTab(address, isOwn, 'posts', maxPages).then(() => {
      this._updateProfileSubtitle(address);
    }).catch(() => {});

    /* Background-refresh own profile from chain. When it lands, re-render
       the page header in-place. We DON'T save/restore the feed's innerHTML
       — doing so used to capture a transient scan-progress block and freeze
       it on screen (the "page 4 — 150 txs" bug). Instead we only touch the
       header, leaving the already-rendered tab content untouched. */
    if (isOwn) {
      this.fetchMyProfile().then(() => {
        if (this.state.mode !== 'profile' || this.state.channel !== address) return;
        const feed = this.g('feed');
        if (!feed || !feed.querySelector('.prof-page')) return;
        /* Patch only the header text bits in-place — name, avatar, bio —
           without rebuilding the whole page (which would disturb the feed
           and any in-flight scan progress). */
        const nameEl = feed.querySelector('.prof-display-name');
        if (nameEl && this.state.profile.username) {
          nameEl.textContent = this.state.profile.username;
        }
        const titleEl = feed.querySelector('.page-header-title');
        if (titleEl && this.state.profile.username) {
          titleEl.textContent = this.state.profile.username;
        }
        const avatarEl = feed.querySelector('.prof-page-avatar');
        if (avatarEl && this.state.profile.picUrl && this.state.profile.picUrl !== 'image1.jpeg') {
          avatarEl.src = this.state.profile.picUrl;
        }
        const bioEl = feed.querySelector('.prof-bio');
        if (bioEl && this.state.profile.bio) {
          bioEl.textContent = this.state.profile.bio;
        }
      }).catch(() => {});
    } else {
      /* Other user's profile: the fetch was kicked off non-blocking above —
         when it lands, patch the header in place (name/avatar/bio). */
      this.fetchOtherProfile(address).then(() => {
        if (this.state.mode !== 'profile' || this.state.channel !== address) return;
        const p = this.state.profCache[address];
        const feed = this.g('feed');
        if (!p || !feed || !feed.querySelector('.prof-page')) return;
        const nameEl = feed.querySelector('.prof-display-name');
        if (nameEl && p.username) nameEl.textContent = p.username;
        const titleEl = feed.querySelector('.page-header-title');
        if (titleEl && p.username) titleEl.textContent = p.username;
        const avatarEl = feed.querySelector('.prof-page-avatar');
        if (avatarEl && p.picUrl && p.picUrl !== 'image1.jpeg') avatarEl.src = p.picUrl;
        const bioEl = feed.querySelector('.prof-bio');
        if (bioEl && p.bio) bioEl.textContent = p.bio;
      }).catch(() => {});
    }
  }

  _profilePageHTML(address, prof, isOwn) {
    const name     = utils.safe(prof.username || this.trunc(address));
    const handle   = utils.safe(address);
    const bio      = utils.safe(prof.bio || '');
    const location = utils.safe(prof.location || '');
    /* website handled via safeUrl below — see metaItems */
    const joined   = prof.joinedTs
      ? new Date(prof.joinedTs).toLocaleDateString('en-US',{month:'long',year:'numeric'})
      : '';
    /* picUrl: validate scheme to block javascript:/data: URIs in <img src>.
       <img src> + javascript: doesn't execute in modern browsers but defense
       in depth never hurts. Falls back to default avatar on invalid URL. */
    const picUrlSafe = utils.safeUrl(prof.picUrl) || 'image1.jpeg';
    const picUrl   = utils.safe(picUrlSafe);
    /* coverUrl: validate AND CSS-escape for url() context */
    const coverCss = prof.coverUrl ? utils.cssUrlValue(prof.coverUrl) : '';

    const coverStyle = coverCss
      ? `background:url('${coverCss}') center/cover no-repeat`
      : `background:linear-gradient(135deg,rgba(124,77,255,0.55),rgba(179,136,255,0.25),rgba(43,134,197,0.15))`;

    const followBtn = isOwn
      ? `<button class="prof-edit-btn" id="prof-dash-btn" title="Creator dashboard" style="margin-right:8px">📊 Dashboard</button>
         <button class="prof-edit-btn" id="prof-edit-trigger">Edit profile</button>`
      : this.state.following.has(address.toLowerCase())
        ? `<button class="prof-following-btn" id="prof-follow-btn">Following</button>`
        : `<button class="prof-follow-btn" id="prof-follow-btn">Follow</button>`;

    /* Re-validate URL at render time. Chain data is attacker-controlled
       and client-side saveProfile validation can be bypassed by publishing
       a PROFILE_DATA tx directly. safeUrl() blocks javascript:, data:, etc. */
    const websiteHref = prof.website ? utils.safeUrl(prof.website) : '';
    const websiteHrefSafe = websiteHref ? utils.safe(websiteHref) : '';
    const websiteDisplay = websiteHref ? utils.safe(websiteHref.replace(/^https?:\/\//, '')) : '';
    const metaItems = [
      location ? `<span class="prof-meta-item">📍 ${location}</span>` : '',
      websiteHrefSafe ? `<span class="prof-meta-item">🔗 <a href="${websiteHrefSafe}" target="_blank" rel="noopener noreferrer">${websiteDisplay}</a></span>` : '',
      joined   ? `<span class="prof-meta-item">📅 Joined ${utils.safe(joined)}</span>` : '',
      `<span class="prof-meta-item" id="prof-firstseen" style="display:none" title="First on-chain activity"></span>`,
      `<span class="prof-meta-item" id="prof-tips" style="display:none" title="PLS tips received on posts"></span>`,
    ].filter(Boolean).join('');

    return `
    <div class="prof-page">
      <div class="prof-cover" style="${coverStyle}"></div>
      <div class="prof-avatar-row">
        <img src="${picUrl}" class="prof-page-avatar" id="prof-page-avatar"
          alt="" data-fallback-src="image1.jpeg">
        <div class="prof-actions">
          <button class="prof-edit-btn" title="Share profile" aria-label="Share profile" style="padding:6px 10px"
            data-act="share-profile" data-act-arg="${utils.safe(address)}">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.48-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>
          </button>
          <a class="prof-edit-btn" title="View their chat" aria-label="View their chat" style="padding:6px 10px;display:inline-flex;align-items:center"
            href="#/channel/${utils.safe(address)}"
            data-act="open-channel" data-act-arg="${utils.safe(address)}">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M1.998 5.5c0-1.381 1.119-2.5 2.5-2.5h15c1.381 0 2.5 1.119 2.5 2.5v13c0 1.381-1.119 2.5-2.5 2.5h-15c-1.381 0-2.5-1.119-2.5-2.5v-13zm2.5-.5a.5.5 0 00-.5.5v2.764l8 3.638 8-3.638V5.5a.5.5 0 00-.5-.5h-15zM19.998 10.236l-8 3.636-8-3.636V18.5a.5.5 0 00.5.5h15a.5.5 0 00.5-.5v-8.264z"/></svg>
          </a>
          <button id="prof-token-edit-btn" class="prof-edit-btn" style="display:none">Set token profile</button>
          ${followBtn}
        </div>
      </div>
      <div class="prof-info">
        <div class="prof-display-name" id="prof-display-name">${name}</div>
        <div class="prof-handle" id="prof-handle-addr"
          title="Click to copy" data-addr="${handle}">${handle}</div>
        ${bio ? `<div class="prof-bio">${bio}</div>` : ''}
        ${metaItems ? `<div class="prof-meta-row">${metaItems}</div>` : ''}
        <div id="prof-token-meta"></div>
        <div class="prof-counts-row">
          <span class="prof-count-item" id="prof-following-count">
            <strong>—</strong> Following
          </span>
          <span class="prof-count-item" id="prof-follower-count">
            <strong>?</strong> Followers
          </span>
        </div>
      </div>
      <div class="prof-tabs">
        <button class="prof-tab active" data-ptab="posts">Posts</button>
        <button class="prof-tab" data-ptab="replies">Replies</button>
        <button class="prof-tab" data-ptab="highlights">Highlights</button>
        <button class="prof-tab" data-ptab="articles">Articles</button>
        <button class="prof-tab" data-ptab="media">Media</button>
        ${isOwn ? `<button class="prof-tab" data-ptab="likes">Likes</button>` : ''}
      </div>
      <div class="prof-feed" id="prof-feed">
        <div class="prof-empty">
          <div class="spinner" aria-hidden="true"></div>
          <h3>Loading…</h3>
          <p>Fetching from chain</p>
        </div>
      </div>
    </div>`;
  }

  /* Fill in a token contract's identity on its profile page (avatar, name,
     banner, bio, badge + links), mirroring the channel banner. The fast
     DexScreener identity (Layer 1) is applied first; the deployer/owner
     verified profile (Layer 2, may scan the channel) upgrades it when ready.
     No-op for EOAs or once a human profile has loaded. */
  async _applyTokenIdentityToProfile(address) {
    const lc = (address || '').toLowerCase();
    const token = await this._fetchTokenInfo(lc);
    if (token) this._patchProfileIdentity(lc, token, null);
    /* Fast path: reveal the "Set token profile" button for the deployer/owner
       without waiting on the (slower) verified-profile scan. */
    this._fetchTokenAuth(lc).then(auth => this._patchProfileTokenEdit(lc, auth));
    const verified = await this._fetchVerifiedTokenProfile(lc);
    if (token || verified) this._patchProfileIdentity(lc, token, verified);
  }

  /* Toggle the profile page's "Set token profile" button for the deployer/owner. */
  _patchProfileTokenEdit(lc, auth) {
    if (this.state.mode !== 'profile') return;
    if (this._profilePageState && this._profilePageState.address !== lc) return;
    const btn = document.getElementById('prof-token-edit-btn');
    if (!btn) return;
    const canEdit = !!(auth && this.state.signerAddr && auth.editors && auth.editors.has(this.state.signerAddr));
    btn.style.display = canEdit ? '' : 'none';
    if (canEdit) btn.onclick = e => { e.stopPropagation(); this._openTokenProfileEditor(lc); };
  }

  _patchProfileIdentity(lc, token, verified) {
    /* Bail if we've navigated away or a human profile took over. */
    if (this.state.mode !== 'profile') return;
    if (this._profilePageState && this._profilePageState.address !== lc) return;
    if (this.state.profCache[lc] && this.state.profCache[lc].username) return;
    const page = document.querySelector('.prof-page');
    if (!page) return;
    const name = (verified && verified.username)
      || (token ? (token.symbol ? `${token.name} (${token.symbol})` : token.name) : '');
    if (name) {
      const nameEl = document.getElementById('prof-display-name');
      if (nameEl) nameEl.textContent = name;
      const titleEl = document.querySelector('.page-header-title');
      if (titleEl) titleEl.textContent = name;
      this._updateTitle(name);
    }
    const avatar = (verified && utils.safeUrl(verified.picUrl || '')) || (token && token.logo);
    if (avatar) { const av = document.getElementById('prof-page-avatar'); if (av) av.src = avatar; }
    const coverSrc = (verified && verified.coverUrl) || (token && token.header) || '';
    if (coverSrc) {
      const css = utils.cssUrlValue(coverSrc);
      const coverEl = page.querySelector('.prof-cover');
      if (css && coverEl) coverEl.style.background = `url('${css}') center/cover no-repeat`;
    }
    const bioText = (verified && verified.bio) || (token ? 'Token on PulseChain' : '');
    if (bioText) {
      let bioEl = page.querySelector('.prof-bio');
      if (!bioEl) {
        bioEl = document.createElement('div');
        bioEl.className = 'prof-bio';
        document.getElementById('prof-handle-addr')?.insertAdjacentElement('afterend', bioEl);
      }
      bioEl.textContent = bioText;
    }
    const meta = document.getElementById('prof-token-meta');
    if (meta) meta.innerHTML = this._tokenMetaHTML(token, !!verified, verified);
  }

  _wireProfilePageListeners(address, isOwn) {
    /* Follow/Unfollow button on the full profile page header. */
    const fbtn = document.getElementById('prof-follow-btn');
    if (fbtn && !isOwn) {
      fbtn.onclick = (e) => {
        e.stopPropagation();
        this.toggleFollowAddr(address, fbtn);
      };
    }
    /* Tab switching — same depth rule as initial load. */
    const _globalLimit = this._getMaxScanPages();
    const maxPages = isOwn ? _globalLimit : Math.min(_globalLimit, Math.max(50, Math.floor(_globalLimit / 2)));
    document.querySelectorAll('.prof-tab').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.prof-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        /* Update pagination state's current tab so fetchProfileMore filters
           correctly. Reset visibleTxHashes since the new tab has a different
           filtered set of the same raw txs. */
        if (this._profilePageState) {
          this._profilePageState.tab = btn.dataset.ptab;
          this._profilePageState.visibleTxHashes = new Set();
        }
        /* Clear the previous tab's count immediately so it can't linger stale
           while the new tab loads; refresh it once the load resolves. */
        const sub = this.g('feed')?.querySelector('.page-header-subtitle');
        if (sub) sub.textContent = '';
        this.loadProfileTab(address, isOwn, btn.dataset.ptab, maxPages)
          .then(() => this._updateProfileSubtitle(address)).catch(() => {});
      };
    });

    /* Address copy */
    const handleEl = document.getElementById('prof-handle-addr');
    if (handleEl) {
      handleEl.onclick = () => utils.copyToClipboard(address, 'Address copied!');
    }

    /* Edit profile button (own profile) */
    const editBtn = document.getElementById('prof-edit-trigger');
    if (editBtn) editBtn.onclick = () => this.showEditForm();
    const dashBtn = document.getElementById('prof-dash-btn');
    if (dashBtn) dashBtn.onclick = () => this.goDashboard();

    /* Follow/Unfollow (other profiles) */
    const followBtn = document.getElementById('prof-follow-btn');
    if (followBtn) {
      followBtn.onclick = () => this.toggleFollow(address, followBtn);
    }

    /* Count following and fetch follower count. Following count is
       address-aware: own profile reads state.following; others are scanned. */
    this._showFollowingCount(address, isOwn);
    this._fetchFollowerCount(address);

    /* Follower/Following counts → open list screen (Twitter/X pattern) */
    const followingCountEl = document.getElementById('prof-following-count');
    const followerCountEl  = document.getElementById('prof-follower-count');
    if (followingCountEl) followingCountEl.onclick = () => this._showFollowingList(address, isOwn);
    if (followerCountEl)  followerCountEl.onclick  = () => this._showFollowerList(address);
  }

  /* ── Profile tab content ────────────────────────────────────────────── */
  /* Returns a Promise that resolves when the initial tab content is rendered */
  async loadProfileTab(address, isOwn, tab, maxPages = 50) {
    const feedEl = document.getElementById('prof-feed');
    if (!feedEl) return;
    feedEl.innerHTML = `<div class="prof-empty"><div class="spinner" aria-hidden="true"></div><h3>Loading…</h3></div>`;

    if (tab === 'likes' && !isOwn) {
      feedEl.innerHTML = `<div class="prof-empty"><span>🔒</span><h3>Private</h3><p>Likes are only visible to the account holder.</p></div>`;
      /* Non-paginated placeholder tab — stop infinite-scroll from paging in
         the owner's real posts under this placeholder. */
      if (this._profilePageState) { this._profilePageState.tab = tab; this._profilePageState.hasMore = false; }
      return;
    }

    /* Highlights / Articles — placeholders for now. Articles will be a Premium
       feature for long-form, on-chain posts (essays, guides, even books);
       Highlights will let users pin standout posts. */
    if (tab === 'highlights' || tab === 'articles') {
      const isArt = tab === 'articles';
      feedEl.innerHTML = `<div class="prof-empty"><span>${isArt ? '📰' : '✨'}</span>
        <h3>${isArt ? 'Articles' : 'Highlights'}</h3>
        <p>${isArt
          ? 'Long-form articles are coming soon — a Premium feature for posting essays, guides, or even whole books on-chain.'
          : 'Highlighted posts are coming soon.'}</p></div>`;
      if (this._profilePageState) { this._profilePageState.tab = tab; this._profilePageState.hasMore = false; }
      return;
    }

    try {
      let posts = [];
      let scannedHasMore = false; /* set below: were there more pages past the initial scan? */
      let pinnedHash = null;      /* resolved pinned-post hash for the Posts tab, or null */
      const addrLc = address.toLowerCase();

      if (tab === 'likes') {
        /* Likes: resolve txHashes from state.likes */
        const fromCache = this.state.posts.filter(p => this.state.likes.has(p.txHash));
        const cachedSet = new Set(fromCache.map(p => p.txHash));
        posts = fromCache;
        const missing = [...this.state.likes].filter(h => !cachedSet.has(h)).slice(0, 20);
        for (const hash of missing) {
          try {
            const cached = await this.cache.getPost(hash);
            if (cached) posts.push(cached);
          } catch { /* skip */ }
        }
        posts.sort((a,b) => (b._tsMs ??= new Date(b.timestamp).getTime()) - (a._tsMs ??= new Date(a.timestamp).getTime()));
      } else {
        /* Posts / Replies / Media: scan once, cache, reuse across tabs */
        this._profileScanCache = this._profileScanCache || {};
        /* Use settings-derived limit as cache key (maxPages may be null) */
        const _limit  = this._getMaxScanPages();
        const cacheKey = `${address}_${_limit}`;
        let raw = this._profileScanCache[cacheKey];
        if (!raw) {
          /* Initial paint: a sent-only fetch (guarantees the profile's own
             latest posts even when received engagement floods the mixed
             txlist pages) merged with a shallow page scan; deeper history
             streams in via fetchProfileMore (scroll / fill). */
          const [sent, paged, extra] = await Promise.all([
            this._apiFetchSentTxs(address),
            this._scanProfilePages(address, PROFILE_INIT_PAGES),
            this._scanProfileExtraChains(address, PROFILE_INIT_PAGES),
          ]);
          if (sent?.length) {
            const seen = new Set(sent.map(t => t.hash.toLowerCase()));
            raw = [...sent, ...(paged || []).filter(t => !seen.has(t.hash?.toLowerCase()))];
          } else {
            raw = paged || [];
          }
          /* Merge in the enabled non-canonical chains' posts (chain-tagged),
             deduped by hash, then sort all by time. */
          if (extra && extra.length) {
            const seen2 = new Set(raw.map(t => t.hash?.toLowerCase()));
            for (const t of extra) {
              const h = t.hash?.toLowerCase();
              if (h && !seen2.has(h)) { raw.push(t); seen2.add(h); }
            }
          }
          raw.sort((a, b) => Number(b.timeStamp || 0) - Number(a.timeStamp || 0));
          /* Cache for 60s — covers all tab switching */
          this._profileScanCache[cacheKey] = raw;
          setTimeout(() => { delete this._profileScanCache[cacheKey]; }, 60_000);
        }
        /* If the initial scan filled all its pages, there's likely more. */
        scannedHasMore = raw.length >= PROFILE_INIT_PAGES * 50;

        /* Pinned-post resolution (Posts tab only): self-sent PIN:/UNPIN: txs
           where from === to === address. Last action wins via the composite
           block*1e5+txIndex order (same pattern as the follower scan). */
        let pinResolved; /* { hash, order } | undefined */
        raw.forEach(tx => {
          const from = tx.from?.toLowerCase();
          const to   = tx.to?.toLowerCase();
          if (from !== address.toLowerCase()) return;
          if (!tx.input || tx.input === '0x') return;
          /* Pins resolve from canonical-chain txs only — block numbers aren't
             comparable across chains, so the last-wins ordering would be wrong
             if pins existed on multiple chains. */
          if (tab === 'posts' && to === addrLc && (!tx._chainId || tx._chainId === CANONICAL_CHAIN_ID)) {
            try {
              const t = ethers.toUtf8String(tx.input).trim();
              let pinHash = null, isUnpin = false;
              if (t.startsWith(UNPIN_PREFIX)) { pinHash = t.slice(UNPIN_PREFIX.length).trim().toLowerCase(); isUnpin = true; }
              else if (t.startsWith(PIN_PREFIX)) { pinHash = t.slice(PIN_PREFIX.length).trim().toLowerCase(); }
              if (pinHash && /^0x[a-f0-9]{64}$/.test(pinHash)) {
                const order = (Number(tx.blockNumber) || 0) * 100000 + (Number(tx.transactionIndex) || 0);
                if (!pinResolved || order >= pinResolved.order) {
                  pinResolved = { hash: isUnpin ? null : pinHash, order };
                }
              }
            } catch { /* skip malformed pin tx */ }
          }
          try {
            /* Canonical parse — identical poll/vote/repost/reply handling
               to the main feed. Returns null for non-post txs (profile,
               reactions, votes). chainId from the tx's origin chain tag. */
            const parsed = this._parsePostTx(tx, { mode: 'profile', chainId: tx._chainId || CANONICAL_CHAIN_ID });
            if (!parsed) return;
            const isReply = !!parsed.parentTx;
            if (tab === 'posts'   &&  isReply) return;
            if (tab === 'replies' && !isReply) return;
            if (tab === 'media' && !this._postHasMedia(parsed.display)) return;
            posts.push(parsed);
          } catch { /* skip */ }
        });
        /* Reconcile the pin: on-chain scan is authoritative when it found any
           PIN/UNPIN marker; otherwise fall back to the optimistic localStorage
           value for our own profile (the just-pinned post may post-date the
           cached scan). */
        if (tab === 'posts') {
          if (pinResolved) pinnedHash = pinResolved.hash;
          else if (addrLc === this.state.signerAddr) pinnedHash = this._getMyPin();
          /* Keep our own optimistic record in sync with the chain. */
          if (pinResolved && addrLc === this.state.signerAddr) this._setMyPin(pinResolved.hash);
        }
      }

      if (!posts.length && !pinnedHash) {
        /* No matching posts in the initial pages, but more history remains —
           don't show the empty state yet; keep scanning deeper pages. */
        if (scannedHasMore && tab !== 'likes') {
          if (this._profilePageState) {
            this._profilePageState.tab = tab;
            this._profilePageState.pagesScanned = Math.max(this._profilePageState.pagesScanned, PROFILE_INIT_PAGES);
            this._profilePageState.hasMore = true;
            this._profilePageState.visibleTxHashes = new Set();
          }
          feedEl.innerHTML = `<div class="prof-empty" id="prof-loading-deep"><div class="spinner" aria-hidden="true"></div><h3>Loading…</h3></div>`;
          this._fillProfileViewport();
          return;
        }
        const empties = {
          posts:   ['📝','No posts yet',   'Posts will appear here.'],
          replies: ['💬','No replies yet', 'Replies to others appear here.'],
          media:   ['🖼','No media yet',   'Posts with images appear here.'],
          likes:   ['🤍','No likes yet',   'Posts you like appear here.'],
        };
        const [icon, title, desc] = empties[tab] || ['📡','Nothing here',''];
        feedEl.innerHTML = `<div class="prof-empty"><span>${icon}</span><h3>${title}</h3><p>${desc}</p></div>`;
        return;
      }

      if (tab === 'media') {
        const items = [];
        posts.forEach(p => {
          this._postMediaItems(p.display).forEach(it => items.push({ ...it, txHash: p.txHash }));
        });
        feedEl.innerHTML = `<div class="prof-media-grid">${
          items.slice(0, 60).map(it => this._mediaGridCellHTML(it)).join('')
        }</div>`;
        return;
      }

      /* Posts / Replies / Likes: standard post list */
      const replyMap = new Map();
      posts.forEach(p => { if (p.parentTx) replyMap.set(p.parentTx, (replyMap.get(p.parentTx)||0)+1); });
      /* Pinned post (Posts tab): hoist it to the top under a 📌 label and
         remove its natural occurrence so it isn't shown twice. If it wasn't in
         the scanned set, fetch it by hash; skip silently if unfetchable. */
      let pinnedPost = null;
      if (tab === 'posts' && pinnedHash) {
        pinnedPost = posts.find(p => p.txHash === pinnedHash) || null;
        if (pinnedPost) posts = posts.filter(p => p.txHash !== pinnedHash);
        else {
          try {
            const fetched = await this._fetchTxByHash(pinnedHash);
            /* Only honor a pin that points at one of this author's own posts. */
            if (fetched && fetched.reporter === addrLc && !fetched.parentTx) pinnedPost = fetched;
          } catch { /* unfetchable — skip silently */ }
        }
      }
      const frag = document.createDocumentFragment();
      const renderPost = (p, pinned) => {
        this._postMap.set(p.txHash, p);
        const el = document.createElement('div');
        el.className      = 'post-item' + (pinned ? ' prof-pinned-post' : '');
        el.dataset.txhash = p.txHash;
        el.innerHTML      = (pinned ? '<div class="prof-pinned-label">📌 Pinned</div>' : '')
          + this.postHTML(p, false, replyMap, null);
        frag.appendChild(el);
        if (p.reporter !== this.state.signerAddr) this.fetchOtherProfile(p.reporter);
      };
      /* Pin hash was set but the post couldn't be resolved AND there are no
         other posts — show the normal empty state rather than a blank list. */
      if (!pinnedPost && !posts.length) {
        feedEl.innerHTML = `<div class="prof-empty"><span>📝</span><h3>No posts yet</h3><p>Posts will appear here.</p></div>`;
        if (this._profilePageState) { this._profilePageState.tab = tab; this._profilePageState.hasMore = scannedHasMore; }
        return;
      }
      if (pinnedPost) renderPost(pinnedPost, true);
      posts.forEach(p => renderPost(p, false));
      feedEl.innerHTML = '';
      feedEl.appendChild(frag);
      /* Tally any polls just rendered so their results fill in. */
      if (posts.some(pp => pp.poll)) {
        setTimeout(() => this._tallyVisiblePolls(), 100);
      }
      /* Gather community notes for these posts (covers profile view). */
      this._scanChannelNotes();
      /* Seed pagination state so infinite scroll won't re-show these posts. */
      if (this._profilePageState) {
        this._profilePageState.tab = tab;
        this._profilePageState.pagesScanned = Math.max(this._profilePageState.pagesScanned, PROFILE_INIT_PAGES);
        this._profilePageState.hasMore = scannedHasMore;
        this._profilePageState.visibleTxHashes = new Set(posts.map(p => p.txHash));
        if (pinnedPost) this._profilePageState.visibleTxHashes.add(pinnedPost.txHash);
      }
      /* If the initial posts don't fill the screen, auto-load more so the user
         sees a full feed without having to scroll a short page. */
      if (tab !== 'likes' && scannedHasMore) this._fillProfileViewport();

    } catch (err) {
      feedEl.innerHTML = `<div class="prof-empty"><span>⚠️</span><h3>Error loading tab</h3><p>${utils.safe(err.message)}</p></div>`;
    }
  }

  async _scanProfilePages(address, maxPages = null) {
    /* null means "use settings". Caller can pass explicit value to override. */
    const limit = (maxPages !== null && maxPages !== undefined)
      ? maxPages
      : this._getMaxScanPages();
    const all = [];
    /* Show progress as a small sticky pill at the top of the profile feed
       — never a big block that displaces posts. The pill is inserted once,
       updated in place, and removed when the scan completes. */
    const feedEl = document.getElementById('prof-feed');
    let pill = null, pillStatus = null;
    const showPill = (feedEl && (limit > 30 || limit === Infinity));
    if (showPill) {
      /* If the feed only has the "Loading…" placeholder, clear it so the
         pill sits above real content as it streams in. */
      const ph = feedEl.querySelector('.prof-empty');
      if (ph && /Loading…/.test(ph.textContent)) feedEl.innerHTML = '';
      pill = document.getElementById('prof-scan-pill');
      if (!pill) {
        pill = document.createElement('div');
        pill.id = 'prof-scan-pill';
        pill.className = 'scan-pill';
        pill.innerHTML = `<span class="scan-spin"></span><span id="prof-scan-status">Scanning chain…</span>`;
        feedEl.prepend(pill);
      }
      pillStatus = document.getElementById('prof-scan-status');
    }
    for (let page = 1; (limit === Infinity || page <= limit); page++) {
      if (pillStatus) pillStatus.textContent = `Scanning chain… ${all.length} posts`;
      let raw;
      try { raw = await this.apiFetch(address, page); }
      catch { break; }
      all.push(...raw);
      if (raw.length < 50) break; /* last page */
      await this._scanDelay(150);
    }
    /* Remove the pill — loadProfileTab will render the final post list. */
    const donePill = document.getElementById('prof-scan-pill');
    if (donePill) donePill.remove();
    return all;
  }

  /* Scan an address's posts on the user's enabled NON-canonical chains for the
     profile's initial paint. One identity across EVM chains, so a profile
     should show its posts everywhere. Each tx is tagged with its origin chain
     (_chainId) so _parsePostTx stamps it. Bounded to a few pages per chain;
     empty enabled set → [] (canonical-only profile, unchanged). Deeper scroll
     still pages the canonical chain only — see AUDIT follow-up. */
  async _scanProfileExtraChains(address, pagesPerChain = 2) {
    const extra = (this._getSettings().enabledChains || [])
      .map(Number).filter(id => id !== CANONICAL_CHAIN_ID && chainCfg(id));
    if (!extra.length) return [];
    const out = [];
    await Promise.all(extra.map(async cid => {
      for (let page = 1; page <= pagesPerChain; page++) {
        let raw;
        try { raw = await this.apiFetch(address, page, cid); }
        catch { break; }
        raw.forEach(t => { t._chainId = cid; });
        out.push(...raw);
        if (raw.length < 50) break;
      }
    }));
    return out;
  }

  /* ── Edit profile modal ─────────────────────────────────────────────── */
  showEditForm() {
    const p = this.state.profile;
    const g = this.g.bind(this);
    g('pe-name').value     = p.username  || '';
    g('pe-bio').value      = p.bio       || '';
    g('pe-location').value = p.location  || '';
    g('pe-website').value  = p.website   || '';
    g('pe-pic').value      = (p.picUrl && p.picUrl !== 'image1.jpeg') ? p.picUrl : '';
    g('pe-cover').value    = p.coverUrl  || '';
    g('pe-preview').src    = p.picUrl    || 'image1.jpeg';
    /* Reset the NFT sub-form fully so a prior session's contract/token-id don't
       linger (only the status line was being cleared). */
    g('nft-contract').value = '';
    g('nft-token-id').value = '';
    g('nft-status').textContent = '';

    /* Bio counter */
    const n = g('pe-bio').value.length;
    g('pe-bio-count').textContent = n ? `${n}/160` : '';

    /* Cover preview */
    const prev = g('pe-cover-preview');
    if (p.coverUrl) {
      prev.style.backgroundImage    = `url('${utils.cssUrlValue(p.coverUrl)}')`;
      prev.style.backgroundSize     = 'cover';
      prev.style.backgroundPosition = 'center';
      prev.classList.add('has-cover');
    } else {
      prev.style.backgroundImage = '';
      prev.classList.remove('has-cover');
    }

    g('profile-modal').classList.add('open');
    this._trapFocus(g('profile-modal'));
  }

  async saveProfile() {
    const g = this.g.bind(this);
    const username = g('pe-name').value.trim();
    let   picUrl   = g('pe-pic').value.trim();
    let   coverUrl = g('pe-cover').value.trim();
    const bio      = g('pe-bio').value.trim().slice(0, 160);
    const location = g('pe-location').value.trim().slice(0, 30);
    const website  = g('pe-website').value.trim().slice(0, 100);

    if (picUrl && !picUrl.startsWith('https://')) {
      utils.toast('Profile picture must be an https:// URL'); return;
    }
    if (coverUrl && !coverUrl.startsWith('https://')) {
      utils.toast('Cover photo must be an https:// URL'); return;
    }
    /* Website: must be http(s)://, or empty. Renders are defensively
       sanitized via utils.safeUrl in round 34, but catching it here gives
       the user feedback instead of silently dropping their entry. */
    if (website && !/^https?:\/\//i.test(website)) {
      utils.toast('Website must start with http:// or https://'); return;
    }
    if (picUrl) {
      /* Check image loads AND is not excessively large (> 8MB of pixels) */
      const loadOk = await new Promise(r => {
        const img = new Image(); img.onload = ()=>r(true); img.onerror = ()=>r(false); img.src = picUrl;
      });
      if (!loadOk) {
        picUrl = ''; utils.toast('Profile image could not load -- using default');
      } else {
        const sizeOk = await utils.checkImageSize(picUrl);
        if (!sizeOk) { picUrl = ''; utils.toast('Profile image is too large (> 8 MB) -- using default'); }
      }
    }
    picUrl = picUrl || 'image1.jpeg';

    const joinedTs = this.state.profile.joinedTs || Date.now();
    const data = { username, picUrl, coverUrl, bio, location, website, joinedTs };
    this.applyProfile(data);
    await this.cache.saveProfile({ address: this.state.signerAddr, ...data });
    /* Keep profCache in sync so the popup reflects the new profile immediately
       without waiting for the next fetchOtherProfile scan. */
    if (this.state.signerAddr) {
      this.state.profCache[this.state.signerAddr] = {
        username: data.username || '',
        /* Sanitize URL fields at the cache boundary, same as applyProfile and
           the fetchOtherProfile cache writes — keeps profCache safe-by-default. */
        picUrl:   utils.safeUrl(data.picUrl) || 'image1.jpeg',
        bio:      data.bio      || '',
        coverUrl: utils.safeUrl(data.coverUrl) || '',
        location: data.location || '',
        website:  utils.safeUrl(data.website) || '',
      };
    }
    const ok = await this.publish(PROFILE_PREFIX + JSON.stringify(data), null, this.state.signerAddr);
    if (ok) {
      this.closeModal('profile-modal');
      /* Refresh profile page if currently on it */
      if (this.state.mode === 'profile') {
        this.goProfilePage(this.state.signerAddr, true);
      }
      utils.toast('Profile saved on-chain ✓');
    }
  }
};
for (const k of Object.getOwnPropertyNames(_PROF.prototype)) {
  if (k !== 'constructor') SayIt.prototype[k] = _PROF.prototype[k];
}
