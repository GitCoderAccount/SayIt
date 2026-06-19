'use strict';
/* profile.js — the profile / social-graph subsystem, split out of app.js.
   FIRST INSTALLMENT: the follow-graph UI — following/follower lists
   (_showFollowingList / _showFollowerList / _scanFollowers / _renderFollowList
   / _renderFollowListMore / _renderFollowRow / _hydrateFollowRow), the
   follow/follower counts (_showFollowingCount / _fetchFollowerCount) and the
   follow toggle (toggleFollow). The profile *page* view/edit and the hover
   popup are appended in later cuts.

   Boot-order note (same constraint that shaped settings.js): every method here
   is reached only via user navigation or a deferred event handler (onclick /
   keydown / the profile-page render), NEVER from init()'s synchronous prefix —
   which runs at app.js eval time, before this file loads. So splitting them out
   is safe. Methods that ARE wired eagerly at boot (e.g. the hover popup via
   _wireHoverPopups in wireListeners) deliberately stay in app.js.

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
            } catch {}
          });
          if (raw.length < 50) break;
          await this._scanDelay(150);
        }
        addrs = [...lastAction.entries()].filter(([,v]) => v.action === 'follow').map(([a]) => a);
      } catch {}
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
          } catch {}
        });
        if (raw.length < 50) break;
        await this._scanDelay(150);
      }
    } catch {}
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
          } catch {}
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
    } catch {}
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
          } catch {}
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
};
for (const k of Object.getOwnPropertyNames(_PROF.prototype)) {
  if (k !== 'constructor') SayIt.prototype[k] = _PROF.prototype[k];
}
