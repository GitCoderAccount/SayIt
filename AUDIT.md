# SayIt — audit backlog

Prioritized to-do list from a multi-agent code+UI audit (2026-06-06). Items are
checked off as they ship. Findings were code-reasoned by parallel reviewers and
should be **verified before fixing** — a few are theoretical (see notes).

Effort: S/M/L. Status: `[ ]` todo · `[x]` done · `[~]` partial · `[-]` skipped.

## P0 — Critical (bugs / broken UX)

- [x] **Post ⋯ menu anchors to the whole feed** — `onFeedClick` passed `e.currentTarget` (= `#feed`) to `openPostMenu`; now passes the actual `[data-action="menu"]` button. *(S · home · verified real)*
- [-] **Duplicate stacked channel headers** — **false positive.** Runtime check shows exactly 1 `.page-header` on a channel page (the pending header isn't injected when the banner renders). Skipped.
- [x] **Thread ancestors wiped + only scan page 1** — resolve parents via `_fetchTxByHash`; ancestors stored in state and rendered by `_renderThreadPage` (survive reply re-renders). — `_renderThreadPage`'s `innerHTML=` destroys ancestor rows from `_fetchThreadAncestors`, which also resolves parents only from the latest 50 channel txs. Resolve via `_fetchTxByHash`; store ancestors in state and re-render. *(M · thread)*
- [x] **Vote/poll-end notifications never fire** — `goNotifications` stamped `LAST_CHECK_KEY=now` before `_scanPollNotifications` read it. Now stamped after the scan (gated on navToken). *(S · notifications)*
- [x] **No in-flight guard on like/bookmark/follow/repost** — added `_reactionBusy` guard / try-finally on toggleLike/Bookmark/Follow + instant repost. — double-tap during the wallet round-trip fires the opposite action (double gas). Add a per-target pending set / disable the button. *(M · home/wallet)*
- [x] **Offline retry republishes reactions** — publish() no longer queues reaction/control txs offline (only real posts/replies/quotes/polls). — only queue real posts/replies/quotes offline; de-dupe `_showPendingInFeed` against the published hash. *(M · wallet)*
- [x] **Optimistic feed insert fires for VOTE/NOTERATE/PROFILE_FOR/NOTE/LC_SYNC** — extended the publish exclude-list so only genuine feed content inserts. *(S · wallet)*
- [x] **Profile non-Posts tabs leak real posts on scroll** — `highlights`/`articles`/`likes(not own)` early-returns now set `_profilePageState.hasMore=false`. *(S · profile)*
- [-] **Official channel pin → placeholder `0x…0001`** — **deferred by owner** (will be a custom wallet address, not yet set up). Leave as-is.
- [x] **Polling drops same-second posts** — `pollNew` now uses `>=` (dedup rejects true dupes). *(S · correctness)*

## P1 — Important (UI/UX + high-value features/settings)

- [~] **Theme setting** — Dark/Dim added (Settings → Appearance, no-flash on load). Full Light deferred per owner.
- [x] **Content/feed filters** — Settings → Content & Feed: hide reposts/replies/polls/non-text, applied in renderFeed. — hide reposts/replies/polls/binary txs, applied in `renderFeed()`. *(M · settings)*
- [x] **Export / Import app data** — Settings → Cache & Storage: download/restore settings/mutes/lists/communities as JSON. — back up mutes/lists/communities/history/settings to JSON. *(M · settings)*
- [-] **JSON-RPC node URL setting** — removed per owner (reads use the default; the wallet handles the user's network).
- [x] **Mobile header search** — _focusSearch routes to Explore inline search on phones (where the sidebar search is hidden); desktop unchanged. — channel/profile search focus a hidden sidebar input on phones; route narrow viewports to inline search. *(M · mobile)*
- [x] **Bottom nav ignores safe-area insets** — added `viewport-fit=cover` + `env(safe-area-inset-bottom)` to mobile-nav/fab/connect. — add `viewport-fit=cover` + `env(safe-area-inset-bottom)`. *(S · mobile)*
- [x] **Long error toasts clipped on mobile** — toast now wraps (`white-space:normal`). — allow wrapping (`white-space:normal`). *(S · mobile)*
- [x] **Toasts/loading invisible to screen readers** — added `role=status aria-live` to #toast and #loading-overlay. — add `role="status" aria-live`. *(S · a11y)*
- [~] **Post ⋯ menu keyboard-operable** — role=menu/menuitem buttons, focus first item, Escape/arrow nav, aria-haspopup/expanded on trigger. (emoji/repost popups still mouse-first) — roles, keyboard nav, Escape, ARIA on triggers. *(M · a11y)*
- [x] **Like/reply/repost notifications open the post** — vote/like/reply/repost now openThreadByHash(target); message/follow keep the tx link. — call `openThreadByHash(n.target)`. *(S · notifications)*
- [x] **Notification badge undercounts engagement** — fold engagement (likes/replies/reposts on your posts) into the badge; fixed the misleading comment. — fold engagement/poll counts in (or fix the misleading comment). *(M · notifications)*
- [x] **Following feed filter** — keep only the followed user's own posts (reporter===addr) to an allowed channel. — filter `to===channel` and `from===addr`. *(M · correctness)*
- [x] **Persistent wrong-network bar** — shows while connected on a non-369 chain, with a Switch button; cleared on disconnect/reconnect. — show a pill while `_wrongChain`; clear it on disconnect/reconnect. *(M · mobile/wallet)*
- [x] **Explore Follow button breaks after click** — toggle `.following` instead of replacing className; re-sync includes data-explore-follow. — `toggleFollow` overwrites `className`; re-sync misses `data-explore-follow`. *(S · explore)*
- [x] **Engagement counts update optimistically** — like/unlike bumps .act-count, reverts on failure. — bump `.act-count` on like/repost, revert on failure. *(S · home)*

## P2 — Polish & consistency

- [x] Reduce-motion + font-scale settings — Settings → Appearance: forced reduce-motion toggle + Display-size zoom (0.9/1/1.1/1.25). Applied no-flash via the early head script. (Font-scale done as display zoom since the design is px-based, not rem.) *(M · settings)*
- [x] Per-type notification opt-outs — Settings → Notifications: 6 category toggles (likes/replies/reposts/follows/messages/poll activity). Filtered in `_renderNotifs` (cached, no rescan) and `checkNotifBadge`. *(S · settings)*
- [x] Media-autoplay toggle + default-channel setting — Settings → Content & Feed: "Autoplay videos" (off → native controls, paused, observer skipped) and "Default tab on launch" (Home/Explore/Bookmarks, honored at boot when not deep-linked). Only self-loading views offered, so no wallet/empty-feed footgun. *(S · settings)*
- [x] Notif tabs drop the `follow` category (realign `inTab`) — tabs now partition cleanly: Likes = plain likes, Mentions = everything else (so follows/poll-ends are no longer orphaned to All-only). *(S · notifications)*
- [x] Profile Media filter differs paint-vs-scroll (share one `isMediaUrl`) — both paths now call one `_postHasMedia`/`_mediaImageUrls` helper built on linkify's canonical `_LK_*` patterns; deleted the two divergent local host lists. *(S · profile)*
- [x] Stale profile post-count subtitle (recompute on scroll/tab) — `_updateProfileSubtitle` is now tab-aware (counts thumbs on Media, per-tab noun) and recomputed after scroll-append + on tab switch (which also clears the prior count up-front). *(S · profile)*
- [x] My-Channel (`self`) subtitle blank + hex-name flash *(S · channel)*
- [x] Token-channel button crowding — `flex-wrap` or overflow menu *(S · channel)*
- [x] 7-item bottom nav < 44px taps on small phones *(S · mobile)*
- [x] Wrong Following / tag-search empty-state copy — the feed empty-state is now context-aware: distinct copy + icon for scanning / tag-search / Following / text-search vs the generic "be the first to post". *(S · home/explore)*
- [x] Bookmark "couldn't load" sticks on transient failures *(S · lists-thread)*
- [x] Generic modal: no Escape / dialog ARIA; `openShareCard` missing focus trap — generic modal now has `role=dialog`/`aria-modal`/`aria-label` + Escape (closes topmost first); `openShareCard` now calls `_trapFocus`. *(S · modals/a11y)*
- [x] Standardize avatar `src` on `safeUrl` (notif/muted/preview/compose) *(S · consistency)*
- [x] Double-escaped usernames in `_patchProfilesInFeed` *(S · correctness)*
- [x] Clickable spans (`.post-handle`/`.post-mention`/counts) not keyboard-operable — `.post-tag`/`.post-mention`/`.post-handle` are now `role=button tabindex=0` with a delegated Enter/Space handler reusing the click dispatch. (Action counts were already real `<button>`s.) *(S · a11y)*
- [x] Cover live-preview ad-hoc escaping (route through `cssUrlValue`/`safeUrl`) — the `pe-cover` oninput preview now uses `utils.cssUrlValue` (same path as the saved cover), so it validates scheme + CSS-escapes instead of hand-rolling. *(S · profile)*
- [x] Explore results hard-capped, no "load more" — search results (was 30) and the Latest tab (was 20) now share one paged renderer (`_exploreRenderPaged`/`_exploreLoadMore`) that shows 30 at a time with a "Load more (N)" button. *(M · explore)*
- [x] Char ring implies a non-existent 1000-char limit *(S · home)*

## P3 — Optional / future

- [ ] Unify the two tx parsers (`parseTxs` delegate to `_parsePostTx`) — root-causes several items *(L · correctness)*
- [ ] Consolidate empty/loading/error + button components *(M · design)*
- [ ] Coherent accent palette; bump `--muted` contrast for WCAG AA *(S · design/a11y)*
- [x] Closed polls still tally late votes (gate by `endMs`) — votes mined after a poll's `endMs` are now excluded at tally time (`_pollTally`) and dropped at record time (`_recordVote`, via a new `_pollEndMs` cache) so a late re-vote can't clobber a valid one. Cache pruned in `_prunePollMaps`. *(M · correctness)*
- [x] Bound `_voteAccum` / `_vfHeightMap` growth — `_vfHeightMap` is pruned to the current feed in `renderFeed` (was never cleared); `_prunePollMaps` now also runs on the feed paths (`pollNew` + end of `fetchPosts`), not only the cold-scan fallback, so `_voteAccum` stays capped over a long session. *(S · perf)*
- [ ] Avoid full-table IDB scans / redundant work on hot paths *(M · perf)*
- [ ] Search-index partial-prune corruption (prune by whole-post groups) *(M · correctness)*
- [ ] Robustness batch (`_scanFollowers` target check, history-open address guard, `pruneIfStale` promise, gas-estimate fallback) *(M · correctness/wallet)*
- [~] Parser defense-in-depth — NFT metadata `image` now routed `resolveIPFS`→`safeUrl` (blocks `javascript:`/`data:`); reaction targets hex-validated in `parseTxs` (like/unlike→64-hex, follow/unfollow→40-hex; malformed control txs dropped). Inline-onclick→delegated-listener conversion deferred — broad, and args are already `utils.safe`-escaped so there's no XSS gap. *(S · security)*
- [ ] Misc dead-code cleanup (dead `.explore-search-wrap` CSS, `has-custom-cover`, redundant `feed-tabs` hide, NFT sub-form reset, `alt`, new-posts-banner `aria-live`, emoji-picker z-index) *(S · polish)*

---
_Security note: the dedicated security pass found no exploitable XSS — escaping via `safe`/`safeUrl`/`cssUrlValue` is applied at the sinks that matter, and the SW cache key is sanitized._
