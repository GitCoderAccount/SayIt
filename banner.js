'use strict';
/* banner.js — profile / token-channel banner rendering, split out of app.js.
   renderBanner is the shared banner renderer (regular profiles AND verified
   token-channel profiles); the rest support the token-channel case: token
   metadata (_fetchTokenInfo / _tokenMetaHTML), verification + auth
   (_fetchTokenAuth / _fetchVerifiedTokenProfile) and editing a token channel's
   profile (_openTokenProfileEditor / _publishTokenProfile). Consumers are
   profile.js (profile banner) and channels.js (showChannelBanner), which call
   in cross-file via the prototype.

   Deliberately LEFT in app.js: _getReadProvider (a shared chain-read provider
   helper used well beyond banners). Boot-order safety (the established
   constraint): every method here is reached only via banner rendering
   (navigation / render) or a deferred handler — never init()'s synchronous
   prefix, and no eager wiring calls them.

   Augments SayIt.prototype (defined in app.js); load order is core -> cache ->
   app -> ... -> threads -> bookmarks -> banner -> embeds -> dm. Cross-refs
   (`utils`, `ethers`, `this._getReadProvider`, `this.cache`, ...) resolve via
   the shared scope or the prototype. */
const _BANNER = class {
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
};
for (const k of Object.getOwnPropertyNames(_BANNER.prototype)) {
  if (k !== 'constructor') SayIt.prototype[k] = _BANNER.prototype[k];
}
