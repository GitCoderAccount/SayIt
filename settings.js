'use strict';
/* settings.js — the Settings PAGE: its full UI (_settingsHTML plus the
   muted-accounts list helpers) and every set-* control listener
   (_wireSettingsListeners). Second cut of the app.js decomposition.

   NOTE on what stays behind: the settings *state accessors*
   (_getSettings / _saveSettings, and _getPostCap / _getMaxScanPages) remain
   in app.js on purpose. They're reached from the synchronous prefix of
   init() — which runs at app.js eval time, BEFORE this file loads — so moving
   them would make `_getSettings` undefined at boot. Only methods that are
   never called before the augmenters finish loading (here: the Settings page,
   reached only via goSettings() on user navigation) are safe to split out.

   These methods augment SayIt.prototype, which is defined in app.js; load
   order is core → cache → app → settings → embeds → dm. The throwaway class
   below keeps method syntax clean; its methods are copied onto
   SayIt.prototype. Everything they reference resolves via the shared
   classic-script global scope (core.js consts like `utils`) or the prototype
   (`this._getSettings()`, `this._exportData()`, …), so nothing has to be
   imported. */
const _SET = class {
  _settingsHTML() {
    const s = this._getSettings();
    return `
    <div class="settings-view">
      <!-- Appearance -->
      <div class="settings-section">
        <div class="settings-section-title">Appearance</div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>Theme</strong><span>Pure black (Dark) or a softer slate (Dim)</span></div>
          <div class="seg-group" id="set-theme" role="radiogroup" aria-label="Theme">
            ${[['dark','Dark'],['dim','Dim'],['light','Light']].map(([v,label]) =>
              `<button type="button" class="seg-btn" data-seg-val="${v}"
                role="radio" aria-checked="${(s.theme || 'dark') === v ? 'true' : 'false'}">${label}</button>`).join('')}
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>Display size</strong><span>Scale the whole interface up or down</span></div>
          <div class="seg-group" id="set-zoom" role="radiogroup" aria-label="Display size">
            ${[['0.9','Small'],['1','Default'],['1.1','Large'],['1.25','Larger']].map(([v,label]) =>
              `<button type="button" class="seg-btn" data-seg-val="${v}"
                role="radio" aria-checked="${String(s.displayZoom || '1') === v ? 'true' : 'false'}">${label}</button>`).join('')}
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>Reduce motion</strong><span>Minimize animations &amp; transitions</span></div>
          <label class="settings-switch">
            <input type="checkbox" id="set-reduce-motion" ${s.reduceMotion ? 'checked' : ''}>
            <span class="settings-switch-slider"></span>
          </label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>Accent color</strong><span>Tint buttons, links &amp; highlights</span></div>
          <div class="accent-swatches" id="set-accent">
            ${Object.entries(ACCENT_COLORS).map(([key, a]) => `
              <button type="button" class="accent-swatch${(s.accentColor || 'purple') === key ? ' selected' : ''}"
                data-accent="${key}" title="${utils.safe(a.name)}" aria-label="${utils.safe(a.name)} accent"
                aria-pressed="${(s.accentColor || 'purple') === key ? 'true' : 'false'}"
                style="background:${a.primary}"></button>`).join('')}
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>Notification badge color</strong><span>Color of the unread-count badge (defaults to your accent)</span></div>
          <div class="accent-swatches" id="set-notif-color">
            <button type="button" class="accent-swatch${!s.notifBadgeColor ? ' selected' : ''}" data-notif=""
              title="Match accent" aria-label="Match accent" aria-pressed="${!s.notifBadgeColor ? 'true' : 'false'}"
              style="background:var(--primary)"></button>
            ${[['#ff3cac','Pink'],['#f4212e','Red'],['#1d9bf0','Blue'],['#00ba7c','Green'],['#ff7a00','Orange']].map(([c,name]) => `
              <button type="button" class="accent-swatch${s.notifBadgeColor === c ? ' selected' : ''}" data-notif="${c}"
                title="${name}" aria-label="${name} badge" aria-pressed="${s.notifBadgeColor === c ? 'true' : 'false'}"
                style="background:${c}"></button>`).join('')}
          </div>
        </div>
      </div>

      <!-- Accessibility -->
      <div class="settings-section">
        <div class="settings-section-title">Accessibility</div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>High contrast</strong><span>Brighten secondary text &amp; borders for better legibility</span></div>
          <label class="settings-switch">
            <input type="checkbox" id="set-high-contrast" ${s.highContrast ? 'checked' : ''}>
            <span class="settings-switch-slider"></span>
          </label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>Underline links</strong><span>Always underline links, hashtags &amp; mentions in posts (not just on hover)</span></div>
          <label class="settings-switch">
            <input type="checkbox" id="set-underline-links" ${s.underlineLinks ? 'checked' : ''}>
            <span class="settings-switch-slider"></span>
          </label>
        </div>
      </div>

      <!-- API -->
      <div class="settings-section">
        <div class="settings-section-title">API Configuration</div>
        <div class="settings-row" style="flex-direction:column;align-items:flex-start">
          <div class="settings-row-label">
            <strong>Primary API URL</strong>
            <span>PulseScan transaction API endpoint</span>
          </div>
          <input class="settings-input" id="set-api-primary"
            value="${utils.safe(s.apiUrl || 'https://api.scan.pulsechain.com/api')}"
            placeholder="https://api.scan.pulsechain.com/api">
        </div>
        <div class="settings-row" style="flex-direction:column;align-items:flex-start;margin-top:12px">
          <div class="settings-row-label">
            <strong>Backup API URL</strong>
            <span>Fallback if primary fails (optional)</span>
          </div>
          <input class="settings-input" id="set-api-backup"
            value="${utils.safe(s.backupApiUrl || '')}"
            placeholder="https://…">
        </div>
        <div class="settings-row" style="margin-top:12px">
          <button class="settings-btn primary" id="set-test-api">Test Connection</button>
          <button class="settings-btn" id="set-save-api">Save API Settings</button>
        </div>
      </div>

      <!-- Networks (multichain) -->
      <div class="settings-section">
        <div class="settings-section-title">Networks</div>
        <div class="settings-row" style="display:block">
          <span style="font-size:13px;color:var(--muted);line-height:1.6">
            SayIt is multichain — your feed aggregates posts across EVM chains, and your address is the same identity on all of them.
            <strong>PulseChain is always on;</strong> Ethereum &amp; Base are on by default. These toggles control which chains your <strong>feed reads</strong> (reads use Etherscan's unified API — one key covers Ethereum, Base &amp; BNB Chain).
            <strong>You post on whatever network your wallet is set to</strong> — SayIt never switches it for you; just change networks in your wallet to post on another chain. (Newly-enabled feeds appear after a reload.)
          </span>
        </div>
        ${chainList().filter(c => !c.canonical).map(c => `
          <div class="settings-row">
            <div class="settings-row-label"><strong>${utils.safe(c.name)}
              <span class="chain-badge" style="--chain-color:${chainColor(c.id)};margin-left:4px">${utils.safe(c.badge)}</span></strong>
              <span>${c.social ? 'Social chain — can host ported likes/follows' : 'Content chain (engagement ports to your default)'} · via ${utils.safe(c.explorer.name)}</span></div>
            <label class="settings-switch">
              <input type="checkbox" class="set-chain-toggle" data-chain-id="${c.id}" ${this._effectiveEnabledChains().includes(c.id) ? 'checked' : ''}>
              <span class="settings-switch-slider"></span>
            </label>
          </div>`).join('')}
        <div class="settings-row" style="flex-direction:column;align-items:flex-start;margin-top:12px">
          <div class="settings-row-label"><strong>Etherscan API key</strong>
            <span>Free from etherscan.io — one key covers Ethereum, Base, BNB Chain &amp; more via the unified API. Required to read non-PulseChain networks.</span></div>
          <input class="settings-input" id="set-etherscan-key" value="${utils.safe(s.etherscanKey || '')}"
            placeholder="Your Etherscan v2 API key" autocomplete="off" autocorrect="off" spellcheck="false">
        </div>
        <div class="settings-row" style="flex-direction:column;align-items:flex-start;margin-top:12px">
          <div class="settings-row-label"><strong>Default chain</strong>
            <span>Where ported engagement (likes on expensive chains) is routed. Your <em>posts</em> always go to your wallet's current network, not this.</span></div>
          <select class="settings-input" id="set-default-chain">
            ${[CHAINS[CANONICAL_CHAIN_ID], ...chainList().filter(c => !c.canonical && this._effectiveEnabledChains().includes(c.id))]
              .map(c => `<option value="${c.id}" ${Number(s.defaultChain || CANONICAL_CHAIN_ID) === c.id ? 'selected' : ''}>${utils.safe(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="settings-row" style="margin-top:12px">
          <button class="settings-btn primary" id="set-save-networks">Save Networks</button>
        </div>
      </div>

      <!-- Content & Feed filters -->
      <div class="settings-section">
        <div class="settings-section-title">Content &amp; Feed</div>
        ${[
          ['set-hide-reposts', 'hideReposts', 'Hide reposts', 'Hide reposts &amp; quotes from the timeline'],
          ['set-hide-replies', 'hideReplies', 'Hide replies', 'Hide standalone replies from the feed'],
          ['set-hide-polls',   'hidePolls',   'Hide polls',   'Hide poll posts'],
          ['set-hide-binary',  'hideBinary',  'Hide non-text posts', 'Hide posts whose content is binary / undecodable'],
        ].map(([id, key, title, desc]) => `
          <div class="settings-row">
            <div class="settings-row-label"><strong>${title}</strong><span>${desc}</span></div>
            <label class="settings-switch">
              <input type="checkbox" id="${id}" data-feed-filter ${s[key] ? 'checked' : ''}>
              <span class="settings-switch-slider"></span>
            </label>
          </div>`).join('')}
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="settings-row-label"><strong>Muted words</strong><span>Hide posts from others that contain any of these words or phrases — one per line, case-insensitive. Whole-word match; your own posts are never hidden. Applies on the next feed refresh.</span></div>
          <textarea id="set-muted-words" rows="4" placeholder="e.g.&#10;giveaway&#10;rug&#10;not financial advice"
            style="width:100%;background:var(--bg-mid);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-size:14px;font-family:inherit;resize:vertical">${utils.safe((s.mutedWords || []).join('\n'))}</textarea>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>Default tab on launch</strong><span>Where the app opens (when not following a shared link)</span></div>
          <select class="settings-btn" id="set-default-view" style="padding:9px 12px">
            ${[['home','Home'],['explore','Explore'],['bookmarks','Bookmarks']].map(([v,label]) =>
              `<option value="${v}" ${(s.defaultView || 'home') === v ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
      </div>

      <!-- Privacy -->
      <div class="settings-section">
        <div class="settings-section-title">Privacy</div>
        <div style="font-size:13px;color:var(--muted);line-height:1.6;padding:4px 0 12px">
          Say It DeFi sets <strong style="color:var(--text)">no cookies</strong> and uses
          <strong style="color:var(--text)">no analytics or tracking services</strong> — the Analytics page is computed
          entirely inside your browser from your own local cache. Everything stored (posts cache, settings,
          archives) lives on this device only. Your IP address is visible, as with any website, to the
          infrastructure that serves content: the static host (GitHub Pages), the block-explorer API endpoint
          you configure, and the hosts of any media you choose to view. Embedded video previews and muted autoplay are ON by default for the best
          feed experience — loading or playing an embed connects you to YouTube/Vimeo, and shared X/Twitter
          posts load X's own embed (full post, images &amp; video) as they scroll into view, subject to those services' cookies. Turn both off right here (or enable Data saver) and everything becomes click-to-load — zero third-party contact until you tap.
        </div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>Load embed thumbnails</strong><span>Fetch YouTube/Vimeo preview images (connects to their servers as you scroll). Off = neutral cards; nothing contacts them until you tap.</span></div>
          <label class="settings-switch">
            <input type="checkbox" id="set-embed-thumbs" ${s.loadEmbedThumbs === false ? '' : 'checked'}>
            <span class="settings-switch-slider"></span>
          </label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>Auto-load &amp; play embeds</strong><span>Load shared X posts and start YouTube/Vimeo (muted) automatically as they scroll into view — like X. Off = a tap-to-load card for each (more private). Requires embed thumbnails.</span></div>
          <label class="settings-switch">
            <input type="checkbox" id="set-autoplay-embeds" ${s.autoplayEmbeds === false ? '' : 'checked'}>
            <span class="settings-switch-slider"></span>
          </label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>Link cards</strong><span>Show a styled card (domain + path) for posted links instead of a plain text link. Built entirely from the URL — no network, no third-party contact. Off = plain text links.</span></div>
          <label class="settings-switch">
            <input type="checkbox" id="set-link-previews" ${s.linkPreviews === false ? '' : 'checked'}>
            <span class="settings-switch-slider"></span>
          </label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>Mask my IP in Live Spaces</strong><span>Route Space audio through a TURN relay so other participants see the relay's
            address instead of yours (audio stays end-to-end encrypted — the relay can't listen). Needs a relay server below; without masking,
            speakers see each other's IPs, and listeners are only ever visible to the host. Signaling trackers see your IP either way, like any site you visit.</span></div>
          <label class="settings-switch">
            <input type="checkbox" id="set-space-mask" ${s.spaceMaskIp ? 'checked' : ''}>
            <span class="settings-switch-slider"></span>
          </label>
        </div>
        <div class="settings-row" id="space-turn-rows" style="flex-direction:column;align-items:stretch;gap:8px;${s.spaceMaskIp ? '' : 'display:none'}">
          <div class="settings-row-label"><strong>TURN relay server</strong><span>e.g. turn:relay.example.com:443?transport=tcp — any standard TURN service
            or a self-hosted coturn works. There is currently no reliable free public TURN, so this is bring-your-own.</span></div>
          <input type="text" id="set-turn-url" placeholder="turn:host:port" value="${utils.safe(s.spaceTurnUrl || '')}"
            style="width:100%;background:var(--bg-mid);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-size:13px">
          <div style="display:flex;gap:8px">
            <input type="text" id="set-turn-user" placeholder="username" value="${utils.safe(s.spaceTurnUser || '')}"
              style="flex:1;background:var(--bg-mid);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-size:13px">
            <input type="text" id="set-turn-cred" placeholder="credential" value="${utils.safe(s.spaceTurnCred || '')}"
              style="flex:1;background:var(--bg-mid);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-size:13px">
          </div>
        </div>
      </div>

      <!-- Media -->
      <div class="settings-section">
        <div class="settings-section-title">Media</div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>Autoplay videos</strong><span>Play video files automatically (muted) as they scroll into view</span></div>
          <label class="settings-switch">
            <input type="checkbox" id="set-autoplay" ${s.autoplayMedia === false ? '' : 'checked'}>
            <span class="settings-switch-slider"></span>
          </label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>Data saver</strong><span>Everything click-to-play: no autoplay of any kind, video files show controls</span></div>
          <label class="settings-switch">
            <input type="checkbox" id="set-data-saver" ${s.dataSaver ? 'checked' : ''}>
            <span class="settings-switch-slider"></span>
          </label>
        </div>
      </div>

      <!-- Notifications -->
      <div class="settings-section">
        <div class="settings-section-title">Notifications</div>
        ${[
          ['set-notif-like',    'like',    'Likes',         'Someone likes your post'],
          ['set-notif-reply',   'reply',   'Replies',       'Someone replies to you'],
          ['set-notif-repost',  'repost',  'Reposts',       'Someone reposts your post'],
          ['set-notif-follow',  'follow',  'Follows',       'Someone follows you'],
          ['set-notif-message', 'message', 'Messages',      'Someone sends you a message'],
          ['set-notif-poll',    'poll',    'Poll activity', 'Votes on your polls &amp; polls ending'],
        ].map(([id, cat, title, desc]) => `
          <div class="settings-row">
            <div class="settings-row-label"><strong>${title}</strong><span>${desc}</span></div>
            <label class="settings-switch">
              <input type="checkbox" id="${id}" data-notif-mute="${cat}" ${!(s.notifMute||{})[cat] ? 'checked' : ''}>
              <span class="settings-switch-slider"></span>
            </label>
          </div>`).join('')}
      </div>

      <!-- Cache -->
      <div class="settings-section">
        <div class="settings-section-title">Cache &amp; Storage</div>
        <div class="settings-row">
          <div class="settings-row-label">
            <strong>Post cache age</strong>
            <span>Posts older than this are pruned daily</span>
          </div>
          <select class="settings-btn" id="set-prune-age" style="padding:9px 12px">
            ${[3,7,14,30].map(d => `<option value="${d}" ${(s.pruneAgeDays||30)==d?'selected':''}>${d} days</option>`).join('')}
          </select>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <strong>Feed post cap</strong>
            <span>Max posts kept in memory per session. Higher = more history while scrolling, more RAM used.</span>
          </div>
          <select class="settings-btn" id="set-post-cap" style="padding:9px 12px">
            <option value="unlimited" ${(!s.postCap || s.postCap==='unlimited' || s.postCap==='0')?'selected':''}>Unlimited (recommended)</option>
            ${[500,1000,2000,5000,10000,50000].map(n =>
              `<option value="${n}" ${s.postCap==n?'selected':''}>${n.toLocaleString()} posts</option>`
            ).join('')}
          </select>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <strong>Max scan depth</strong>
            <span>API pages scanned per profile/follower lookup (50 txs per page). Higher finds more history but takes longer.</span>
          </div>
          <select class="settings-btn" id="set-max-scan" style="padding:9px 12px">
            ${[30,100,300,0].map(n =>
              `<option value="${n}" ${(s.maxScanPages ?? 0) == n ? 'selected' : ''}>${n === 0 ? 'Unlimited' : n + ' pages (' + (n*50).toLocaleString() + ' txs)'}</option>`
            ).join('')}
          </select>
        </div>
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="settings-row-label">
            <strong>Storage</strong>
            <span id="storage-usage-label">Calculating…</span>
          </div>
          <div class="storage-bar"><div class="storage-bar-fill" id="storage-bar-fill"></div></div>
          <div id="storage-counts" style="font-size:13px;color:var(--muted)"></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <strong>Deep sync</strong>
            <span>Archive the main feed's history into this browser — search, analytics and threads work from your own complete local copy. Resumes where it left off; new posts still arrive live.</span>
            <span id="deep-sync-status" style="display:block;margin-top:4px;color:var(--primary-lt)"></span>
          </div>
          <button class="settings-btn" id="set-deep-sync">Start</button>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"><strong>Deep sync scope</strong><span>How far back to archive, and whether to include the likes archive (powers engagement analytics; takes a bit more space)</span></div>
          <div style="display:flex;gap:8px;align-items:center">
            <select class="settings-btn" id="set-ds-depth" style="padding:9px 12px">
              ${[[0, 'Full history'], [300, '300 pages'], [100, '100 pages']].map(([v, l]) =>
                `<option value="${v}" ${(s.deepSyncMaxPages || 0) == v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <label class="settings-switch" title="Archive likes">
              <input type="checkbox" id="set-ds-likes" ${s.deepSyncLikes === false ? '' : 'checked'}>
              <span class="settings-switch-slider"></span>
            </label>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <strong>Posts snapshot</strong>
            <span>Export your synced posts as JSON to share or restore on another device; import merges a snapshot into the local cache.</span>
          </div>
          <div style="display:flex;gap:8px">
            <button class="settings-btn" id="set-export-posts">Export</button>
            <button class="settings-btn" id="set-import-posts">Import</button>
            <input type="file" id="set-import-posts-file" accept="application/json,.json" style="display:none">
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <strong>Clear post cache</strong>
            <span>Removes all cached posts from IndexedDB (also resets deep-sync progress)</span>
          </div>
          <button class="settings-btn danger" id="set-clear-posts">Clear posts</button>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <strong>Clear channel history</strong>
            <span>Removes saved channel list (rebuilt from chain on next visit)</span>
          </div>
          <button class="settings-btn danger" id="set-clear-channels">Clear channels</button>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <strong>Clear offline queue</strong>
            <span>Removes posts saved while offline that failed to publish</span>
          </div>
          <button class="settings-btn danger" id="set-clear-pending">Clear pending</button>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <strong>Clear likes archive</strong>
            <span>Removes archived likes (engagement numbers in Analytics/Dashboard rebuild on the next deep sync)</span>
          </div>
          <button class="settings-btn danger" id="set-clear-likes">Clear likes</button>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <strong>Clear search index</strong>
            <span>Removes the local full-text index (rebuilt automatically as posts load)</span>
          </div>
          <button class="settings-btn danger" id="set-clear-search">Clear index</button>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <strong>Export data</strong>
            <span>Download your settings, muted accounts, lists &amp; communities as a JSON backup. (Your wallet/seed remains your only identity backup.)</span>
          </div>
          <button class="settings-btn" id="set-export">Export</button>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <strong>Import data</strong>
            <span>Restore settings/mutes/lists/communities from a previously exported file</span>
          </div>
          <button class="settings-btn" id="set-import">Import</button>
          <input type="file" id="set-import-file" accept="application/json,.json" style="display:none">
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <strong>Reset settings</strong>
            <span>Restore every setting to its default (API endpoints, appearance, filters, scan depth). Cached posts, mutes, lists &amp; communities are kept.</span>
          </div>
          <button class="settings-btn danger" id="set-reset-defaults">Reset to defaults</button>
        </div>
      </div>

      <!-- About -->
      <div class="settings-section">
        <div class="settings-section-title">About</div>
        <div class="settings-about-logo">
          <img src="image1.jpeg" alt="Say It DeFi">
          <div>
            <strong>Say It DeFi</strong>
            <span>Uncensorable on-chain social on PulseChain</span>
          </div>
        </div>
        <div style="font-size:14px;color:var(--muted);line-height:1.8">
          Chain ID: <strong style="color:var(--text)">369 (PulseChain)</strong><br>
          Main channel: <code style="color:var(--primary-lt);font-size:12px">${MAIN_CHANNEL}</code><br>
          Storage: IndexedDB + localStorage<br>
          No server, no backend, no ads.
        </div>
        <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
          <a href="https://github.com/GitCoderAccount/SayIt" target="_blank" rel="noopener noreferrer"
            class="settings-btn" style="text-decoration:none;display:inline-block">GitHub ↗</a>
          <a href="https://pulsechain.com" target="_blank" rel="noopener noreferrer"
            class="settings-btn" style="text-decoration:none;display:inline-block">PulseChain ↗</a>
        </div>
      </div>

      <!-- Muted accounts -->
      <div class="settings-section">
        <div class="settings-section-title">Muted Accounts</div>
        <div id="muted-list">${this._mutedListHTML()}</div>
      </div>
    </div>`;
  }

  /* Render the muted-accounts list for the Settings page. Each row shows
     the address (and cached name if known) with an Unmute button. */
  _mutedListHTML() {
    const muted = [...this.state.muted];
    if (muted.length === 0) {
      return `<div style="padding:16px;color:var(--muted);font-size:14px;text-align:center">
        No muted accounts. Mute someone from the ··· menu on their posts.</div>`;
    }
    return muted.map(addr => {
      const prof = this.state.profCache[addr];
      const name = prof?.username ? utils.safe(prof.username) : this.trunc(addr);
      const pic  = utils.safe(utils.safeUrl(prof?.picUrl) || 'image1.jpeg');
      return `
        <div class="settings-row" style="align-items:center" data-muted-addr="${utils.safe(addr)}">
          <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
            <img src="${pic}" alt="" data-fallback-src="image1.jpeg"
              style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0">
            <div style="min-width:0">
              <div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
              <div style="font-size:12px;color:var(--muted)">@${utils.safe(this.trunc(addr))}</div>
            </div>
          </div>
          <button class="settings-btn" data-unmute="${utils.safe(addr)}"
            style="flex-shrink:0">Unmute</button>
        </div>`;
    }).join('');
  }

  /* Re-render just the muted list in place (after an unmute). */
  _refreshMutedList() {
    const el = this.g('muted-list');
    if (el) el.innerHTML = this._mutedListHTML();
  }

  _wireSettingsListeners() {
    const g = id => document.getElementById(id);
    /* Unmute buttons in the Muted Accounts section. Delegated so it works
       after the list re-renders. */
    const mutedListEl = g('muted-list');
    if (mutedListEl) {
      mutedListEl.addEventListener('click', e => {
        const btn = e.target.closest('[data-unmute]');
        if (!btn) return;
        const addr = btn.dataset.unmute;
        this.unmuteAddress(addr);
        this._refreshMutedList();
      });
    }
    /* Save API */
    g('set-save-api')?.addEventListener('click', () => {
      const s = this._getSettings();
      const rawPrimary = g('set-api-primary').value.trim();
      const rawBackup  = g('set-api-backup').value.trim();
      /* Validate URLs before saving — a bad URL causes confusing fetch errors */
      const isValidUrl = u => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };
      if (rawPrimary && !isValidUrl(rawPrimary)) {
        utils.toast('Primary API URL is not a valid URL'); return;
      }
      if (rawBackup && !isValidUrl(rawBackup)) {
        utils.toast('Backup API URL is not a valid URL'); return;
      }
      s.apiUrl       = rawPrimary || 'https://api.scan.pulsechain.com/api';
      s.backupApiUrl = rawBackup;
      this._saveSettings(s);
      utils.toast('API settings saved ✓');
    });
    /* Networks (multichain): enabled chains + Etherscan key + default chain. */
    g('set-save-networks')?.addEventListener('click', () => {
      const s = this._getSettings();
      const prevEnabled = (s.enabledChains || []).map(Number).sort().join(',');
      const enabled = [...document.querySelectorAll('.set-chain-toggle')]
        .filter(cb => cb.checked)
        .map(cb => Number(cb.dataset.chainId))
        .filter(id => !!chainCfg(id));
      s.enabledChains = enabled;
      s.etherscanKey  = g('set-etherscan-key').value.trim();
      /* Default chain must be the canonical chain or one that's enabled. */
      let dc = Number(g('set-default-chain').value) || CANONICAL_CHAIN_ID;
      if (dc !== CANONICAL_CHAIN_ID && !enabled.includes(dc)) dc = CANONICAL_CHAIN_ID;
      s.defaultChain = dc;
      this._saveSettings(s);
      const changed = enabled.slice().sort().join(',') !== prevEnabled;
      /* These settings only control which chains the FEED reads (you post on
         whatever network your wallet is on). The chain set + connect-src are
         read at boot, so reading a newly-enabled chain's posts needs a reload. */
      utils.toast(changed ? 'Networks saved — reload to refresh the feed' : 'Networks saved ✓');
    });
    /* Export / Import data backup. */
    g('set-export')?.addEventListener('click', () => this._exportData());
    g('set-import')?.addEventListener('click', () => g('set-import-file')?.click());
    g('set-import-file')?.addEventListener('change', e => {
      const f = e.target.files?.[0];
      if (f) this._importData(f);
      e.target.value = '';
    });
    /* Reset every setting to defaults. Same reload pattern as import — a
       clean boot re-applies appearance and re-reads defaults everywhere,
       with no half-applied state. Only SETTINGS_KEY is touched: cached
       posts, mutes, lists and communities are intentionally preserved. */
    g('set-reset-defaults')?.addEventListener('click', () => {
      if (!confirm('Reset all settings to their defaults? Cached posts, mutes, lists & communities are kept.')) return;
      localStorage.removeItem(SETTINGS_KEY);
      utils.toast('Settings reset — reloading…');
      setTimeout(() => location.reload(), 1000);
    });
    /* Segmented pill groups (Theme, Display size) — X-style option pills in
       place of native <select>s. CSP-safe: per-button click listeners mirror
       the accent-swatch wiring above. The callback persists + applies exactly
       what the old change handlers did; _wireSegGroup keeps aria-checked in
       sync across the group so one pill is always the active radio. */
    this._wireSegGroup('set-theme', val => {
      const s = this._getSettings();
      s.theme = val;
      this._saveSettings(s);
      this._applyTheme(val);
    });
    /* Accent color — persist + apply immediately, update the selected ring. */
    g('set-accent')?.querySelectorAll('.accent-swatch').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.accent;
        if (!ACCENT_COLORS[key]) return;
        const s = this._getSettings();
        s.accentColor = key;
        this._saveSettings(s);
        this._applyAccent(key);
        g('set-accent').querySelectorAll('.accent-swatch').forEach(b => {
          const on = b === btn;
          b.classList.toggle('selected', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      });
    });
    /* Notification badge color — empty data-notif = match accent (clear override). */
    g('set-notif-color')?.querySelectorAll('.accent-swatch').forEach(btn => {
      btn.addEventListener('click', () => {
        const color = btn.dataset.notif || '';
        const s = this._getSettings();
        if (color) s.notifBadgeColor = color; else delete s.notifBadgeColor;
        this._saveSettings(s);
        this._applyNotifBadgeColor(color);
        g('set-notif-color').querySelectorAll('.accent-swatch').forEach(b => {
          const on = b === btn;
          b.classList.toggle('selected', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      });
    });
    /* Display size (zoom) — apply immediately. '1' clears the override. */
    this._wireSegGroup('set-zoom', val => {
      const s = this._getSettings();
      s.displayZoom = val;
      this._saveSettings(s);
      document.documentElement.style.zoom = (String(val) !== '1') ? val : '';
    });
    /* Reduce motion — toggle the forced-motion class immediately. */
    g('set-reduce-motion')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.reduceMotion = g('set-reduce-motion').checked;
      this._saveSettings(s);
      document.documentElement.classList.toggle('force-reduce-motion', s.reduceMotion);
    });
    /* Accessibility — high contrast + underline links apply immediately (boot.js
       re-applies them pre-paint on the next load). */
    g('set-high-contrast')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.highContrast = g('set-high-contrast').checked;
      this._saveSettings(s);
      document.documentElement.classList.toggle('hc', s.highContrast);
    });
    g('set-underline-links')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.underlineLinks = g('set-underline-links').checked;
      this._saveSettings(s);
      document.documentElement.classList.toggle('ul-links', s.underlineLinks);
    });
    /* Content & Feed filter toggles — save on change; the feed picks them up
       on the next renderFeed (when the user navigates back to it). */
    const filterKeys = { 'set-hide-reposts': 'hideReposts', 'set-hide-replies': 'hideReplies',
      'set-hide-polls': 'hidePolls', 'set-hide-binary': 'hideBinary' };
    document.querySelectorAll('[data-feed-filter]').forEach(cb => {
      cb.addEventListener('change', () => {
        const s = this._getSettings();
        s[filterKeys[cb.id]] = cb.checked;
        this._saveSettings(s);
      });
    });
    /* Muted words — save the list (one per line), invalidate the compiled
       matcher cache, and re-render the feed so the change applies right away. */
    g('set-muted-words')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.mutedWords = g('set-muted-words').value.split('\n').map(w => w.trim()).filter(Boolean).slice(0, 200);
      this._saveSettings(s);
      this._mwCacheKey = undefined;   /* force _mutedWordsRe to recompile */
      if (!this._selfManagedModes.has(this.state.mode)) this.renderFeed();
    });
    /* Autoplay videos — applies on the next render; re-wire the current feed
       so the change takes effect immediately. */
    g('set-embed-thumbs')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.loadEmbedThumbs = g('set-embed-thumbs').checked;
      this._saveSettings(s);
      /* Facade markup differs per mode — re-render the feed. */
      if (!this._selfManagedModes.has(this.state.mode)) this.renderFeed();
    });
    g('set-autoplay-embeds')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.autoplayEmbeds = g('set-autoplay-embeds').checked;
      this._saveSettings(s);
      const feed = this.g('feed');
      if (feed) this._wireVideoObserver(feed, true);
    });
    g('set-link-previews')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.linkPreviews = g('set-link-previews').checked;
      this._saveSettings(s);
      /* Link-card markup is decided in linkify — re-render so it applies now. */
      if (!this._selfManagedModes.has(this.state.mode)) this.renderFeed();
    });
    g('set-data-saver')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.dataSaver = g('set-data-saver').checked;
      this._saveSettings(s);
      const feed = this.g('feed');
      if (feed) this._wireVideoObserver(feed, true);
    });
    g('set-space-mask')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.spaceMaskIp = g('set-space-mask').checked;
      this._saveSettings(s);
      const rows = g('space-turn-rows');
      if (rows) rows.style.display = s.spaceMaskIp ? '' : 'none';
    });
    ['set-turn-url', 'set-turn-user', 'set-turn-cred'].forEach((id, i) => {
      g(id)?.addEventListener('change', () => {
        const s = this._getSettings();
        s[['spaceTurnUrl', 'spaceTurnUser', 'spaceTurnCred'][i]] = g(id).value.trim();
        this._saveSettings(s);
      });
    });
    g('set-autoplay')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.autoplayMedia = g('set-autoplay').checked;
      this._saveSettings(s);
      const feed = this.g('feed');
      if (feed) this._wireVideoObserver(feed, true); /* reset: setting changed */
    });
    /* Default tab on launch — applied at boot (see init bootstrap). */
    g('set-default-view')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.defaultView = g('set-default-view').value;
      this._saveSettings(s);
    });
    /* Per-type notification opt-outs — checked = show. Re-filter the open
       notifications view in place (cached, no rescan) and refresh the badge. */
    document.querySelectorAll('[data-notif-mute]').forEach(cb => {
      cb.addEventListener('change', () => {
        const s = this._getSettings();
        s.notifMute = s.notifMute || {};
        s.notifMute[cb.dataset.notifMute] = !cb.checked;
        this._saveSettings(s);
        if (this.state.mode === 'notifications') this._renderNotifs();
        this.checkNotifBadge();
      });
    });
    /* Test API — mirrors runtime: tries primary, falls back to backup */
    g('set-test-api')?.addEventListener('click', async () => {
      const primary = g('set-api-primary').value.trim() || 'https://api.scan.pulsechain.com/api';
      const backup  = g('set-api-backup').value.trim();
      const qs = `?module=account&action=txlist&address=${MAIN_CHANNEL}&offset=1&page=1`;
      utils.toast('Testing connection…', 4000);
      const tryUrl = async url => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        try {
          const res = await fetch(url + qs, { signal: ctrl.signal });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const data = await res.json();
          return data.status === '1' || Array.isArray(data.result);
        } finally { clearTimeout(timer); }
      };
      try {
        const ok = await tryUrl(primary);
        utils.toast(ok ? '✓ Primary API works!' : '⚠ Primary responded but returned no data');
      } catch (err) {
        if (!backup) { utils.toast('✗ Primary failed: ' + err.message); return; }
        utils.toast('Primary failed, trying backup…', 3000);
        try {
          const ok = await tryUrl(backup);
          utils.toast(ok ? '✓ Backup API works (primary down)' : '⚠ Backup responded but returned no data');
        } catch (err2) { utils.toast('✗ Both APIs failed: ' + err2.message); }
      }
    });
    /* Prune age */
    g('set-prune-age')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.pruneAgeDays = parseInt(g('set-prune-age').value, 10);
      this._saveSettings(s);
      utils.toast('Prune age saved ✓');
    });
    g('set-post-cap')?.addEventListener('change', () => {
      const s = this._getSettings();
      const capVal = g('set-post-cap').value;
      s.postCap = (capVal === 'unlimited') ? 'unlimited' : (Number(capVal) || 'unlimited');
      this._saveSettings(s);
      utils.toast('Feed cap saved ✓');
    });
    g('set-max-scan')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.maxScanPages = Number(g('set-max-scan').value);
      this._saveSettings(s);
      /* Invalidate profile scan cache so next profile visit uses new depth */
      this._profileScanCache = {};
      const v = s.maxScanPages;
      utils.toast('Scan depth: ' + (v === 0 ? 'Unlimited' : v + ' pages') + ' ✓');
    });
    /* Clear posts */
    g('set-clear-posts')?.addEventListener('click', async () => {
      this._deepSyncing = false;                  /* stop an active sync */
      localStorage.removeItem('sayitDeepSync');   /* reset its cursor */
      await this.cache.clearAllPosts();
      utils.safeLS.remove(PRUNE_KEY);
      utils.safeLS.remove('sayit_idx_v1'); /* allow search index rebuild */
      this.state.posts = [];
      this._postHashSet = new Set();
      const dss = g('deep-sync-status'); if (dss) dss.textContent = '';
      const dsb = g('set-deep-sync'); if (dsb) dsb.textContent = 'Start';
      utils.toast('Post cache cleared ✓');
    });
    /* Deep sync + posts snapshot */
    g('set-deep-sync')?.addEventListener('click', () => this.toggleDeepSync());
    {
      const st = this._deepSyncState();
      const dsb = g('set-deep-sync');
      if (dsb) dsb.textContent = this._deepSyncing ? 'Pause' : (st.done ? 'Re-sync' : (st.lastPage > 0 ? 'Resume' : 'Start'));
      const dss = g('deep-sync-status');
      if (dss) dss.textContent = this._deepSyncStatusText(st, this._deepSyncing);
    }
    /* Storage overview — best-effort, fills in as the async calls land. */
    (async () => {
      try {
        const est  = (navigator.storage && navigator.storage.estimate) ? await navigator.storage.estimate() : {};
        const used = est.usage || 0, quota = est.quota || 0;
        const fmt  = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
        const lbl  = g('storage-usage-label');
        if (lbl) lbl.textContent = quota ? `${fmt(used)} used of ~${fmt(quota)} available to this site` : 'Storage estimate unavailable in this browser';
        const fill = g('storage-bar-fill');
        if (fill && quota) fill.style.width = Math.min(100, (used / quota) * 100).toFixed(2) + '%';
        const c  = await this.cache.storeCounts();
        const sc = g('storage-counts');
        if (sc) sc.textContent = `${(c.posts || 0).toLocaleString()} posts · ${(c.likes || 0).toLocaleString()} archived likes · ${(c.profiles || 0).toLocaleString()} profiles · ${(c.channels || 0).toLocaleString()} channels · ${(c.search_index || 0).toLocaleString()} search rows · ${(c.pending_posts || 0).toLocaleString()} queued`;
      } catch { /* overview is informational only */ }
    })();
    g('set-export-posts')?.addEventListener('click', () => this._exportPostsSnapshot());
    g('set-import-posts')?.addEventListener('click', () => g('set-import-posts-file')?.click());
    g('set-import-posts-file')?.addEventListener('change', e => {
      const f = e.target.files?.[0];
      if (f) this._importPostsSnapshot(f);
      e.target.value = '';
    });
    /* Clear channels */
    g('set-clear-channels')?.addEventListener('click', async () => {
      await this.cache.clearChannels();
      this.state.channelHistory = [];
      utils.safeLS.remove(CHANNELS_KEY);
      utils.toast('Channel history cleared ✓');
    });
    g('set-ds-depth')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.deepSyncMaxPages = Number(g('set-ds-depth').value) || 0;
      this._saveSettings(s);
    });
    g('set-ds-likes')?.addEventListener('change', () => {
      const s = this._getSettings();
      s.deepSyncLikes = g('set-ds-likes').checked;
      this._saveSettings(s);
    });
    g('set-clear-likes')?.addEventListener('click', async () => {
      try { await this.cache.clearStore('likes'); utils.toast('Likes archive cleared ✓'); }
      catch { utils.toast('Could not clear likes'); }
    });
    g('set-clear-search')?.addEventListener('click', async () => {
      try { await this.cache.clearStore('search_index'); utils.toast('Search index cleared ✓'); }
      catch { utils.toast('Could not clear index'); }
    });
    g('set-clear-pending')?.addEventListener('click', async () => {
      /* Remove all pending posts from IDB and any visual indicators */
      try {
        const pending = await this.cache.getPendingPosts();
        await Promise.all(pending.map(q => this.cache.deletePendingPost(q.queueId)));
        document.querySelectorAll('.pending-post').forEach(el => el.remove());
        utils.toast(`Cleared ${pending.length} queued post${pending.length !== 1 ? 's' : ''} ✓`);
      } catch { utils.toast('Could not clear queue'); }
    });
  }
};
for (const k of Object.getOwnPropertyNames(_SET.prototype)) {
  if (k !== 'constructor') SayIt.prototype[k] = _SET.prototype[k];
}
