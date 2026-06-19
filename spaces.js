'use strict';
/* spaces.js — Audio Spaces: the live-room engine + UI, split out of app.js.
   WebRTC mesh rooms (SpaceRTC lives in core.js); this file is the SayIt-side
   glue: probe/counts (_scheduleSpaceProbe / _hydrateSpaceCounts), the space
   card (_spaceCardHTML), create/join/preview (openCreateSpace / _spaceIce /
   joinSpace / openSpacePreview / _relaySpeaking), the in-call dock + roster +
   control-message handling (_mountSpaceDock / _expandSpaceDock /
   _collapseSpaceDock / _renderSpaceDockBarAvatars / _wireSpaceDockControls /
   _wireSpaceDockActions / _renderSpaceDockMsgs / _spaceRosterSummary /
   _spaceIdentity / _labelIsSpaceAdmin / _onSpaceCtl / _onSpacePeerGone /
   _renderSpaceRoster) and teardown (endSpace / leaveSpace).

   Deliberately LEFT in app.js: the SPACE: payload parse/data layer
   (_parseSpacePayload / _reviveSpace / _spaceStripHTML / _captureSpaceEnd /
   _spaceIsEnded — invoked from the post parser/renderer) and the host-rejoin
   feature (_clearActiveSpaceIf / _checkActiveSpace), because _checkActiveSpace
   runs in init()'s SYNCHRONOUS prefix (app.js eval time, before this file
   loads) and synchronously reads _spaceIsEnded — moving them would silently
   break the rejoin banner. Everything in THIS file is reached only via post
   rendering (after init's awaits) or a deferred handler.

   Augments SayIt.prototype (defined in app.js); load order is core -> cache ->
   app -> settings -> profile -> polls -> notes -> spaces -> embeds -> dm.
   Cross-refs (`utils`, `SpaceRTC`, `ACTIVE_SPACE_KEY`, `this._spaceIsEnded`,
   `this._reviveSpace`, ...) resolve via the shared scope or the prototype. */
const _SPACES = class {
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
};
for (const k of Object.getOwnPropertyNames(_SPACES.prototype)) {
  if (k !== 'constructor') SayIt.prototype[k] = _SPACES.prototype[k];
}
