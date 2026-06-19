'use strict';
/* lists.js — Lists & Communities, split out of app.js. User-curated Lists
   (localStorage + optional on-chain backup) and joined Communities: the
   add/remove picker (_openListPicker), persistence (_saveLists /
   _saveCommunities), on-chain publish/restore (publishListsOnChain /
   _autoRestoreLists / restoreListsFromChain), the Lists page (goLists /
   _listsHTML / _wireListsPage / openListEditor / openList / _fetchListFeed /
   _newListId) and the Communities page (goCommunities / _communitiesHTML /
   _wireCommunitiesPage / openCommunity).

   Boot-order safety (the settings.js/profile.js/spaces.js constraint): every
   method here is reached only via navigation, a deferred handler, or a
   setTimeout (_autoRestoreLists fires 4s after connect) — never init()'s
   synchronous prefix, which runs at app.js eval time before this file loads.

   Augments SayIt.prototype (defined in app.js); load order is core -> cache ->
   app -> settings -> profile -> polls -> notes -> spaces -> explore -> lists ->
   embeds -> dm. Cross-refs (`utils`, `LISTS_KEY`, `COMMUNITIES_KEY`,
   `this.cache`, `this.renderFeed`, ...) resolve via the shared scope or the
   prototype. */
const _LISTS = class {
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
};
for (const k of Object.getOwnPropertyNames(_LISTS.prototype)) {
  if (k !== 'constructor') SayIt.prototype[k] = _LISTS.prototype[k];
}
