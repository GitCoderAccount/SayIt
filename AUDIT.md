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

- [ ] **Theme setting (Dark / Dim / Light)** — `[data-theme]` CSS-var overrides; persist `s.theme`. *(M · settings)*
- [ ] **Content/feed filters** — hide reposts/replies/polls/binary txs, applied in `renderFeed()`. *(M · settings)*
- [ ] **Export / Import app data** — back up mutes/lists/communities/history/settings to JSON. *(M · settings)*
- [ ] **JSON-RPC node URL setting** — expose `s.rpcUrl`; null `_readProvider` on save. *(S · settings)*
- [ ] **Mobile header search is a dead button** — channel/profile search focus a hidden sidebar input on phones; route narrow viewports to inline search. *(M · mobile)*
- [x] **Bottom nav ignores safe-area insets** — added `viewport-fit=cover` + `env(safe-area-inset-bottom)` to mobile-nav/fab/connect. — add `viewport-fit=cover` + `env(safe-area-inset-bottom)`. *(S · mobile)*
- [x] **Long error toasts clipped on mobile** — toast now wraps (`white-space:normal`). — allow wrapping (`white-space:normal`). *(S · mobile)*
- [x] **Toasts/loading invisible to screen readers** — added `role=status aria-live` to #toast and #loading-overlay. — add `role="status" aria-live`. *(S · a11y)*
- [ ] **Post menu / emoji / repost popups mouse-only** — roles, keyboard nav, Escape, ARIA on triggers. *(M · a11y)*
- [ ] **Like/reply/repost notifications open the explorer, not the post** — call `openThreadByHash(n.target)`. *(S · notifications)*
- [ ] **Notification badge undercounts engagement** — fold engagement/poll counts in (or fix the misleading comment). *(M · notifications)*
- [ ] **Following feed admits non-followed authors / cross-channel posts** — filter `to===channel` and `from===addr`. *(M · correctness)*
- [ ] **No persistent wrong-network indicator on mobile** — show a pill while `_wrongChain`; clear it on disconnect/reconnect. *(M · mobile/wallet)*
- [ ] **Explore Follow button breaks after click** — `toggleFollow` overwrites `className`; re-sync misses `data-explore-follow`. *(S · explore)*
- [ ] **Engagement counts don't update optimistically** — bump `.act-count` on like/repost, revert on failure. *(S · home)*

## P2 — Polish & consistency

- [ ] Reduce-motion + font-scale settings *(M · settings)*
- [ ] Per-type notification opt-outs *(S · settings)*
- [ ] Media-autoplay toggle + default-channel setting *(S · settings)*
- [ ] Notif tabs drop the `follow` category (realign `inTab`) *(S · notifications)*
- [ ] Profile Media filter differs paint-vs-scroll (share one `isMediaUrl`) *(S · profile)*
- [ ] Stale profile post-count subtitle (recompute on scroll/tab) *(S · profile)*
- [ ] My-Channel (`self`) subtitle blank + hex-name flash *(S · channel)*
- [ ] Token-channel button crowding — `flex-wrap` or overflow menu *(S · channel)*
- [ ] 7-item bottom nav < 44px taps on small phones *(S · mobile)*
- [ ] Wrong Following / tag-search empty-state copy *(S · home/explore)*
- [ ] Bookmark "couldn't load" sticks on transient failures *(S · lists-thread)*
- [ ] Generic modal: no Escape / dialog ARIA; `openShareCard` missing focus trap *(S · modals/a11y)*
- [ ] Standardize avatar `src` on `safeUrl` (notif/muted/preview/compose) *(S · consistency)*
- [ ] Double-escaped usernames in `_patchProfilesInFeed` *(S · correctness)*
- [ ] Clickable spans (`.post-handle`/`.post-mention`/counts) not keyboard-operable *(S · a11y)*
- [ ] Cover live-preview ad-hoc escaping (route through `cssUrlValue`/`safeUrl`) *(S · profile)*
- [ ] Explore results hard-capped, no "load more" *(M · explore)*
- [ ] Char ring implies a non-existent 1000-char limit *(S · home)*

## P3 — Optional / future

- [ ] Unify the two tx parsers (`parseTxs` delegate to `_parsePostTx`) — root-causes several items *(L · correctness)*
- [ ] Consolidate empty/loading/error + button components *(M · design)*
- [ ] Coherent accent palette; bump `--muted` contrast for WCAG AA *(S · design/a11y)*
- [ ] Closed polls still tally late votes (gate by `endMs`) *(M · correctness)*
- [ ] Bound `_voteAccum` / `_vfHeightMap` growth *(S · perf)*
- [ ] Avoid full-table IDB scans / redundant work on hot paths *(M · perf)*
- [ ] Search-index partial-prune corruption (prune by whole-post groups) *(M · correctness)*
- [ ] Robustness batch (`_scanFollowers` target check, history-open address guard, `pruneIfStale` promise, gas-estimate fallback) *(M · correctness/wallet)*
- [ ] Parser defense-in-depth (`resolveIPFS`→`safeUrl`, hex-validate `LIKE:` target, prefer delegated listeners over inline onclick) *(S · security)*
- [ ] Misc dead-code cleanup (dead `.explore-search-wrap` CSS, `has-custom-cover`, redundant `feed-tabs` hide, NFT sub-form reset, `alt`, new-posts-banner `aria-live`, emoji-picker z-index) *(S · polish)*

---
_Security note: the dedicated security pass found no exploitable XSS — escaping via `safe`/`safeUrl`/`cssUrlValue` is applied at the sinks that matter, and the SW cache key is sanitized._
