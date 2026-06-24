/* Chat / encrypted-DM UI methods — split out of app.js (incremental app.js
   modularization). These augment SayIt.prototype, which is defined in app.js;
   load order is core → cache → app → dm. Using a throwaway class keeps the
   original class-method syntax verbatim, then we copy the methods onto the
   real prototype. Top-level consts from core.js (utils, DMCrypto, prefixes,
   ethers) are visible here via the shared global lexical scope. */
'use strict';
(function () {
  const _DM = class {
  _renderDmPanePlaceholder() {
    const host = this.g('ch-pane-content');
    if (host) host.innerHTML = `<div class="ch-pane-empty"><h3>Select a conversation</h3>
      <p>Choose a conversation, or start a new one from the list.</p></div>`;
  }

  /* Ensure keys (one signature), scan inbound DMs, render the conversation list.
     If keys aren't unlocked yet, show an explicit unlock button instead of
     silently prompting a wallet signature. */
  async _loadConversations(autoOpenPeer) {
    const list = this.g('ch-page');
    if (!list) return;
    const note = `<div class="dm-meta-note">🔒 End-to-end encrypted (X25519 + ML-KEM post-quantum). The message text is private; <strong>who you message and when is public on-chain.</strong></div>`;
    if (!this._dmKeys) {
      list.innerHTML = note + `<div class="dm-onboard">
        <h3>Encrypted messages</h3>
        <p>Sign once to unlock your inbox (this signature stays in your browser and never sends a transaction).</p>
        <button class="go-btn" id="dm-unlock-btn">Unlock messages</button></div>`;
      const ub = this.g('dm-unlock-btn');
      if (ub) ub.onclick = async () => {
        ub.disabled = true; ub.textContent = 'Check your wallet…';
        try { await this._ensureDmKeys(); this._loadConversations(autoOpenPeer); }
        catch (e) { utils.toast(e.message || 'Could not unlock'); ub.disabled = false; ub.textContent = 'Unlock messages'; }
      };
      return;
    }
    list.innerHTML = `<div class="ch-pane-loading"><div class="spinner" aria-hidden="true"></div></div>`;
    let convos = [];
    try { convos = await this._scanDms(); } catch (e) { utils.toast(e.message || 'Scan failed'); }
    if (this.state.mode !== 'channels' || this._chatTab !== 'messages') return;
    this._dmConvos = convos;
    /* Banner if the user hasn't published their key yet (others can't reach them). */
    const mine = await this._getDmKeyFor(this.state.signerAddr);
    if (this.state.mode !== 'channels' || this._chatTab !== 'messages') return;
    const banner = mine ? '' : `<div class="dm-onboard" style="border-bottom:1px solid var(--border)">
      <p>Publish your key so others can message you.</p>
      <button class="go-btn" id="dm-enable-btn">Enable encrypted DMs</button></div>`;
    const newBtn = `<div style="display:flex;gap:8px;margin:10px 12px">
      <button class="settings-btn" id="dm-new-btn" style="flex:1">✎ New message</button>
      <button class="settings-btn" id="dm-new-group-btn" style="flex:1">👥 New group</button></div>`;
    const meLc = (this.state.signerAddr || '').toLowerCase();
    const rows = convos.map(c => {
      const last = c.messages[c.messages.length - 1];
      const time = last ? `<span class="ch-hist-time">${utils.safe(this.relTime(new Date(last.ts).toISOString()))}</span>` : '';
      let name, pic, openId, prevName = '';
      if (c.isGroup) {
        openId = c.id; pic = 'image1.jpeg';
        const others = (c.members || []).filter(m => m !== meLc);
        others.forEach(a => this.fetchOtherProfile(a));
        const names = others.map(a => this.state.profCache[a]?.username || this.trunc(a));
        name = '👥 ' + utils.safe(names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : ''));
        if (last) prevName = utils.safe((this.state.profCache[last.from]?.username || this.trunc(last.from)) + ': ');
      } else {
        openId = c.addr; const prof = this.state.profCache[c.addr];
        name = prof?.username ? utils.safe(prof.username) : this.trunc(c.addr);
        pic = utils.safe(utils.safeUrl(prof?.picUrl) || 'image1.jpeg');
        this.fetchOtherProfile(c.addr);
      }
      const preview = utils.safe((last?.text || '').slice(0, 56));
      return `<div class="ch-history-item" role="button" tabindex="0" data-dm-open="${utils.safe(openId)}">
        <img src="${pic}" class="ch-hist-avatar" alt="" data-fallback-src="image1.jpeg">
        <div class="ch-hist-body">
          <div class="ch-hist-top"><span class="ch-hist-name">${name}</span>${time}</div>
          <div class="ch-hist-preview">${prevName}${preview || 'Encrypted message'}</div>
        </div>
      </div>`;
    }).join('') || `<div class="ch-pane-empty" style="padding:24px"><p>No conversations yet. Start one with “New message” or “New group”.</p></div>`;
    list.innerHTML = note + banner + newBtn + rows;
    const en = this.g('dm-enable-btn');
    if (en) en.onclick = async () => {
      en.disabled = true; en.textContent = 'Check your wallet…';
      try { await this.enableDms(); utils.toast('Encrypted DMs enabled ✓'); this._loadConversations(autoOpenPeer); }
      catch (e) { utils.toast(e.message || 'Failed'); en.disabled = false; en.textContent = 'Enable encrypted DMs'; }
    };
    const nb = this.g('dm-new-btn');
    if (nb) nb.onclick = () => this._dmNewMessage();
    const ngb = this.g('dm-new-group-btn');
    if (ngb) ngb.onclick = () => this._dmNewGroup();
    list.querySelectorAll('[data-dm-open]').forEach(el => {
      el.onclick = () => this._openDmThread(el.dataset.dmOpen);
    });
    if (autoOpenPeer) this._openDmThread(autoOpenPeer);
  }

  /* "New group" → multi-select the same Following/Followers picker, then start a
     group conversation with the chosen members. */
  _dmNewGroup() {
    this._dmRecipTab = this._dmRecipTab || 'following';
    this._dmGroupPick = new Set();
    this.g('ch-layout')?.classList.add('pane-open');
    this._renderDmRecipientPicker(true);
  }

  /* "New message" → a recipient picker in the pane: pick someone you follow or
     a follower, search them, or paste an address. */
  _dmNewMessage() {
    this._dmRecipTab = this._dmRecipTab || 'following';
    this.g('ch-layout')?.classList.add('pane-open'); /* mobile drill-in */
    this._renderDmRecipientPicker();
  }

  _renderDmRecipientPicker(groupMode) {
    const host = this.g('ch-pane-content');
    if (!host) return;
    if (groupMode !== undefined) this._dmPickGroup = !!groupMode;
    const gm = this._dmPickGroup;
    const tab = this._dmRecipTab || 'following';
    const startBar = gm ? `<div class="dm-pick-manual" style="border-bottom:none">
        <span id="dm-group-count" style="flex:1;align-self:center;color:var(--muted);font-size:13px">${this._dmGroupPick.size} selected</span>
        <button class="go-btn" id="dm-group-start" ${this._dmGroupPick.size < 2 ? 'disabled' : ''}>Start group</button>
      </div>` : '';
    host.innerHTML = `
      <div class="ch-pane-header">
        <div class="ch-pane-id"><div class="ch-pane-name">${gm ? 'New group' : 'New message'}</div>
          <div class="ch-pane-addr">${gm ? 'Select 2+ members, then Start group' : 'Pick someone you follow or a follower — or paste an address'}</div></div>
      </div>
      <div class="dm-pick-manual">
        <input id="dm-pick-addr" placeholder="0x… wallet address" autocomplete="off" spellcheck="false">
        <button class="go-btn" id="dm-pick-go">${gm ? 'Add' : 'Go'}</button>
      </div>
      ${startBar}
      <div class="chat-toggle" role="tablist">
        <button class="chat-toggle-btn${tab === 'following' ? ' active' : ''}" data-recip-tab="following" role="tab" aria-selected="${tab === 'following' ? 'true' : 'false'}">Following</button>
        <button class="chat-toggle-btn${tab === 'followers' ? ' active' : ''}" data-recip-tab="followers" role="tab" aria-selected="${tab === 'followers' ? 'true' : 'false'}">Followers</button>
      </div>
      <input id="dm-pick-search" class="dm-pick-search" placeholder="Search by name or address…" aria-label="Search people by name or address" autocomplete="off">
      <div id="dm-pick-list" class="dm-pick-list"></div>`;
    const inp = this.g('dm-pick-addr'), go = this.g('dm-pick-go');
    const submit = () => {
      const a = (inp.value || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) { utils.toast('Enter a valid 0x address'); return; }
      if (gm) { this._dmGroupPick.add(a); inp.value = ''; this._renderDmRecipientPicker(); }
      else this._openDmThread(a);
    };
    if (go) go.onclick = submit;
    if (inp) inp.onkeydown = e => { if (e.key === 'Enter') submit(); };
    host.querySelectorAll('[data-recip-tab]').forEach(btn => {
      btn.onclick = () => { this._dmRecipTab = btn.dataset.recipTab; this._renderDmRecipientPicker(); };
    });
    const start = this.g('dm-group-start');
    if (start) start.onclick = () => {
      const me = (this.state.signerAddr || '').toLowerCase();
      const members = [...new Set([...this._dmGroupPick, me])];
      const gid = this._dmGroupId(members);
      this._dmPendingGroup = { id: 'g:' + gid, members };
      this._openDmThread('g:' + gid);
    };
    const search = this.g('dm-pick-search');
    if (search) search.oninput = () => this._fillDmPickList(search.value.trim());
    this._fillDmPickList('');
  }

  async _fillDmPickList(query) {
    const listEl = this.g('dm-pick-list');
    if (!listEl) return;
    const tab = this._dmRecipTab || 'following';
    let addrs = [];
    if (tab === 'following') {
      addrs = [...(this.state.following || [])];
    } else {
      if (!this._dmFollowers) {
        listEl.innerHTML = `<div class="ch-pane-loading"><div class="spinner" aria-hidden="true"></div></div>`;
        this._dmFollowers = (await this._scanFollowers(this.state.signerAddr, this._navToken, null, 8)) || [];
        if (!this.g('dm-pick-list')) return; /* navigated/re-rendered away */
      }
      addrs = this._dmFollowers;
    }
    const q = (query || '').toLowerCase();
    const me = (this.state.signerAddr || '').toLowerCase();
    const rows = addrs
      .filter(a => a && a !== me)
      .filter(a => { if (!q) return true; const u = this.state.profCache[a]?.username || ''; return a.includes(q) || u.toLowerCase().includes(q); })
      .slice(0, 100)
      .map(a => {
        const prof = this.state.profCache[a];
        const name = prof?.username ? utils.safe(prof.username) : this.trunc(a);
        const pic = utils.safe(utils.safeUrl(prof?.picUrl) || 'image1.jpeg');
        this.fetchOtherProfile(a);
        const checked = this._dmPickGroup && this._dmGroupPick.has(a);
        const check = this._dmPickGroup ? `<span class="dm-pick-check${checked ? ' on' : ''}">${checked ? '✓' : ''}</span>` : '';
        return `<div class="ch-history-item${checked ? ' active' : ''}" role="button" tabindex="0" data-dm-pick="${utils.safe(a)}">
          <img src="${pic}" class="ch-hist-avatar" alt="" data-fallback-src="image1.jpeg">
          <div class="ch-hist-body"><div class="ch-hist-top"><span class="ch-hist-name">${name}</span></div>
          <div class="ch-hist-preview">${utils.safe(this.trunc(a))}</div></div>${check}
        </div>`;
      }).join('') || `<div class="ch-pane-empty" style="padding:24px"><p>${tab === 'following' ? 'Not following anyone yet.' : 'No followers found yet.'}</p></div>`;
    listEl.innerHTML = rows;
    listEl.querySelectorAll('[data-dm-pick]').forEach(el => {
      el.onclick = () => {
        const a = el.dataset.dmPick;
        if (this._dmPickGroup) {            /* toggle selection, keep the picker open */
          if (this._dmGroupPick.has(a)) this._dmGroupPick.delete(a); else this._dmGroupPick.add(a);
          this._renderDmRecipientPicker();
        } else this._openDmThread(a);
      };
    });
  }

  /* Render one conversation (1:1 or group) into the right pane. `id` is a peer
     address for 1:1 or "g:<gid>" for a group. */
  _openDmThread(id) {
    id = (id || '').toLowerCase();
    const isGroup = id.startsWith('g:');
    if (!isGroup && !/^0x[0-9a-f]{40}$/.test(id)) return;
    this._dmPeer = id;
    this.g('ch-layout')?.classList.add('pane-open');
    const host = this.g('ch-pane-content');
    if (!host) return;
    const me = (this.state.signerAddr || '').toLowerCase();
    const convo = (this._dmConvos || []).find(c => c.id === id || (!isGroup && c.addr === id));
    let members = convo?.members;
    if (isGroup && !members && this._dmPendingGroup && this._dmPendingGroup.id === id) members = this._dmPendingGroup.members;

    let name, pic, subtitle;
    if (isGroup) {
      const others = (members || []).filter(m => m !== me);
      others.forEach(a => this.fetchOtherProfile(a));
      const names = others.map(a => this.state.profCache[a]?.username || this.trunc(a));
      name = '👥 ' + utils.safe(names.join(', ') || 'Group');
      pic = 'image1.jpeg';
      subtitle = `${others.length + 1} members · 🔒 encrypted`;
    } else {
      const prof = this.state.profCache[id];
      name = prof?.username ? utils.safe(prof.username) : this.trunc(id);
      pic = utils.safe(utils.safeUrl(prof?.picUrl) || 'image1.jpeg');
      subtitle = `${utils.safe(this.trunc(id))} · 🔒 encrypted`;
      if (prof === undefined) this.fetchOtherProfile(id);
    }

    /* Dedup by tx hash so a message never renders twice. */
    const _seen = new Set();
    const msgs = (convo?.messages || []).filter(m => {
      const k = m.txHash || `${m.from}|${m.ts}|${m.text}`;
      if (_seen.has(k)) return false; _seen.add(k); return true;
    });
    const bubbles = msgs.map(m => {
      const mine = m.from === me;
      const sender = (isGroup && !mine)
        ? `<div class="dm-bubble-sender">${utils.safe(this.state.profCache[m.from]?.username || this.trunc(m.from))}</div>` : '';
      return `<div class="dm-bubble ${mine ? 'mine' : 'theirs'}">${sender}${utils.safe(m.text).replace(/\n/g, '<br>')}
        <div class="dm-bubble-time">${utils.safe(this.relTime(new Date(m.ts).toISOString()))}</div></div>`;
    }).join('') || `<div class="ch-pane-empty" style="padding:24px"><p>No messages yet — say hi. Messages are end-to-end encrypted.</p></div>`;
    host.innerHTML = `
      <div class="ch-pane-header">
        <img src="${pic}" class="ch-pane-avatar" alt="" data-fallback-src="image1.jpeg">
        <div class="ch-pane-id"><div class="ch-pane-name">${name}</div>
          <div class="ch-pane-addr">${subtitle}</div></div>
      </div>
      <div class="dm-thread" id="dm-thread">${bubbles}</div>
      <div class="ch-pane-compose">
        <textarea id="dm-compose" rows="2" placeholder="${isGroup ? 'Encrypted group message…' : 'Encrypted message…'}"></textarea>
        <div class="ch-pane-compose-actions">
          <button class="go-btn" id="dm-send" disabled>Send</button>
        </div>
      </div>`;
    const ta = this.g('dm-compose'), send = this.g('dm-send');
    if (ta && send) {
      ta.oninput = () => { send.disabled = !ta.value.trim(); };
      send.onclick = () => this._sendDmFromPane(id);
    }
    const th = this.g('dm-thread'); if (th) th.scrollTop = th.scrollHeight;
  }

  async _sendDmFromPane(id) {
    const ta = this.g('dm-compose'); const text = ta?.value.trim();
    if (!text) return;
    const send = this.g('dm-send'); if (send) send.disabled = true;
    const isGroup = id.startsWith('g:');
    const me = this.state.signerAddr;
    let members = null;
    if (isGroup) {
      const c = (this._dmConvos || []).find(x => x.id === id);
      members = c?.members || (this._dmPendingGroup && this._dmPendingGroup.id === id ? this._dmPendingGroup.members : null);
      if (!members) { utils.toast('Group members unknown'); if (send) send.disabled = false; return; }
    }
    let hash;
    try { hash = isGroup ? (await this.sendGroupDm(members, text)).hash : await this.sendDm(id, text); }
    catch (e) { utils.toast(e.message || 'Send failed'); if (send) send.disabled = false; return; }
    if (!hash) { if (send) send.disabled = false; return; }
    if (ta) ta.value = '';
    /* Optimistically append + record so re-opening shows it without a rescan. */
    const msg = { from: me, to: isGroup ? null : id, text, ts: Date.now(), txHash: hash };
    let convo = (this._dmConvos = this._dmConvos || []).find(c => c.id === id);
    if (!convo) { convo = { id, addr: isGroup ? null : id, isGroup, members: members || null, messages: [], last: 0 }; this._dmConvos.unshift(convo); }
    if (!convo.messages.some(m => m.txHash === hash)) { convo.messages.push(msg); convo.last = msg.ts; }
    if (this._dmPeer === id) {
      const th = this.g('dm-thread');
      if (th) {
        const empty = th.querySelector('.ch-pane-empty'); if (empty) th.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'dm-bubble mine';
        el.innerHTML = `${utils.safe(text).replace(/\n/g, '<br>')}<div class="dm-bubble-time">now</div>`;
        th.appendChild(el); th.scrollTop = th.scrollHeight;
      }
    }
  }
  };
  for (const k of Object.getOwnPropertyNames(_DM.prototype)) {
    if (k !== 'constructor') SayIt.prototype[k] = _DM.prototype[k];
  }
})();
