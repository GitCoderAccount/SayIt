'use strict';
/* notifications.js — the Notifications page + its data gathering, split out of
   app.js. Gathers notifs from chain/state without extra network where possible:
   poll notifications (_scanPollNotifications), engagement notifs targeting the
   user's posts (_engagementNotifs), the page itself (goNotifications /
   _renderNotifs) and the per-category mute filter (_notifEnabled).

   Boot-order safety (the settings.js/profile.js/explore.js constraint): every
   method here is reached only via navigation (nav click / keyboard / router) or
   the post-boot badge poll (checkNotifBadge, which stays in app.js) — never
   init()'s synchronous prefix, which runs at app.js eval time before this file
   loads. The eagerly-wired badge color (_applyNotifBadgeColor) and the badge
   counters (checkNotifBadge / setNotifBadge / clearNotifBadge) stay in app.js,
   as does engagement *recording* (_recordEngagement, driven by action handlers).

   Augments SayIt.prototype (defined in app.js); load order is core -> cache ->
   app -> settings -> profile -> polls -> notes -> spaces -> explore -> lists ->
   notifications -> embeds -> dm. Cross-refs resolve via the shared scope or the
   prototype. */
const _NOTIFS = class {
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
};
for (const k of Object.getOwnPropertyNames(_NOTIFS.prototype)) {
  if (k !== 'constructor') SayIt.prototype[k] = _NOTIFS.prototype[k];
}
