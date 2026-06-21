# SayIt — AUDIT / work log

**Read this first** when starting work on SayIt — it's the living record of what's done and what's open. Then read the full **`reference-sayit-repo`** memory (architecture, commands, gotchas, conventions) before changing anything. **Keep this file current:** move items from "Open" to "Done" as you finish them, and add new findings to "Open".

SayIt — decentralized social on PulseChain (chain 369); no-build static-file front-end; live at sayitdefi.com; CI green.

## Repo location & layout
**Local path:** `~/SayIt`  ·  GitHub `GitCoderAccount/SayIt` (remote `origin`, branch `main`).

No build pipeline — static files served as-is. One `SayIt` class lives in `app.js`; each feature subsystem is a per-file **augmenter** that copies its methods onto `SayIt.prototype`. **Load order** (index.html `<script>` tags): sayit-crypto → core → cache → app → settings → profile → polls → notes → spaces → explore → lists → notifications → channels → threads → bookmarks → banner → embeds → dm.

- `index.html` — HTML + CSS (the UI shell)
- `core.js` — constants, `utils`, `SpaceRTC`, `DMCrypto`, URL/embed parsers, the `CHAINS` registry
- `cache.js` — IndexedDB `Cache` layer
- `app.js` — the `SayIt` class + bootstrap; **`SW_CACHE_VER` lives here**; the feed/render/state/virtualization core + eager wiring + core posting path
- `settings.js · profile.js · polls.js · notes.js · spaces.js · explore.js · lists.js · notifications.js · channels.js · threads.js · bookmarks.js · banner.js · embeds.js · dm.js` — feature augmenters (one subsystem each)
- `boot.js` — pre-paint theme (in `<head>`)  ·  `sayit-crypto.js` — vendored SRI-pinned crypto  ·  `sw.js` — PWA service worker
- `README.md` · `CRYPTO_BUILD.md` · `AUDIT.md` (this file)
- `.ci/` — extractor + ESLint config + `node --test` suite (incl. `augment.test.js`, `render.test.js`) + `smoke.py`  ·  `.github/workflows/` — `lint.yml` (lint+smoke) + `nightly.yml` (live-site smoke)

⚠ Bump **`SW_CACHE_VER`** (top of app.js, `YYYYMMDD-N`) on any app-asset change — CI enforces it. Full architecture / commands / gotchas: the **`reference-sayit-repo`** memory.

## Done (high level — git log has the per-commit detail)
- **Feature-complete X-style client:** feed, threads, profiles, follows, channels/chat, Explore, Lists & Communities, Notifications, Bookmarks, polls, Community Notes, Audio Spaces (WebRTC), tipping, encrypted DMs (x25519 + ML-KEM-768), Twemoji, image lightbox, PWA/offline.
- **Multichain — built & default-on (reads AND writes):** aggregated Home feed across PulseChain + Ethereum + Base (keyless via Blockscout); the composer "post to" picker is now shown by default too (see 2026-06-21 entry); writes stay on the post's chain (auto-switch); engagement on expensive chains ported via chain-qualified refs; global address identity. BSC is opt-in (needs a paid Etherscan-v2 key).
- **app.js decomposition COMPLETE (2026-06-19):** the ~15.3k-line `SayIt` class split into 13 per-subsystem augmenter files (settings, profile, polls, notes, spaces, explore, lists, notifications, channels, threads, bookmarks, banner, embeds) — app.js now ~8,867 lines (−42%). What remains is the feed/render/state/virtualization core + bootstrap + eager wiring + core posting path.
- **Test/guard hardening (2026-06-19):** `.ci/test/augment.test.js` (no duplicate prototype methods; every augmenter method lands on `SayIt.prototype`) + `.ci/test/render.test.js` (`utils.linkify` XSS escaping); ESLint expanded to ~19 correctness rules. 54 unit tests; lint + smoke + nightly live-smoke all green.
- **Disconnected-feed fix + hygiene (2026-06-21):** the Home feed now paints **without waiting on wallet reconnect**. `init()` used to `await tryAutoReconnect()` before the first `fetchPosts()`, so an installed-but-locked wallet (its `eth_accounts`/`eth_chainId` request stays pending until the user unlocks) stalled the whole feed for anyone who hadn't connected — the common case for a crypto user with MetaMask/Rabby installed but not connected to SayIt. Reconnect now runs in the background; `afterConnect()` re-renders the feed in place once it resolves. Reads were already wallet-independent (Home scans `MAIN_CHANNEL` via a keyless explorer). Same pass: `alt=""` on the 4 remaining decorative imgs, SW diagnostic logs gated behind an `SW_DEBUG` flag, and the stale README architecture bullet rewritten. **Feed fix verified headless (boot smoke green) — still needs the owner to confirm in a real browser with an installed-but-locked wallet.**
- **Emoji picker + multichain-write fixes (2026-06-21):**
  1. *Emoji picker no longer janks on open.* The ~1300-button grid is built from one HTML string with CSS-class buttons + a single delegated click handler (zero per-button listeners), and colorization is **lazy** — an `IntersectionObserver` twemojifies one category-section at a time as it scrolls into view (~250 imgs, not ~1300); the body MutationObserver skips the picker so it can't bulk-colorize it. Flags expanded by ~60 countries. *Was:* every open rebuilt 1200 buttons + ran twemoji over all of them synchronously (~1s main-thread block → "takes forever / can't click outside yet"). Verified headless: opens fast, 1312 buttons, delegated insert works, 257/1312 colorized.
  2. *Multichain writes ON by default.* New `_effectiveEnabledChains()` (unset = registry keyless chains: ETH+Base) shared by the feed reader, the composer "post to" picker, and the Settings checkboxes — so the picker appears with Pulse/ETH/Base **without configuring Settings**, and Settings shows ETH/Base on by default (explicit uncheck-all = Pulse only). Settings → Networks re-inits the picker on save (no reload to start posting).
  3. *Thread-page inline reply now publishes on the parent post's chain* (was omitting the chain id → forced the wallet back to PulseChain: the owner-reported **"switches then flips back"** bug).
  4. *Offline retry queue preserves a post's chain* (queued record now carries `chainId`).
  5. *ethers v6 fix:* `Signer.getChainId()` (removed in v6) → `provider.getNetwork().chainId` (the old call threw on first connect, leaving `defaultChain` unset).
  Verified headless (default `_effectiveEnabledChains()=[1,8453]`, picker visible, Base→8453); 54 tests + smoke green. **Real-wallet send on Base/ETH still owner-gated** (see Standing).

## Open / to work on (2026-06-21 — none urgent; codebase is healthy)
1. **Refactor complexity hotspots**, biggest first: `_wireGlobalDelegates` (~325 lines), `renderFeed` (~200), `goDashboard` (~194), `_renderSearchDropdown` (~171). The only remaining audit item with real effort — pure refactor, churn risk, no functional gain; do it only if a hotspot is actually being touched for another reason.
2. **Minor:** poll creation (`publish(body)` for `POLL:`) always publishes on PulseChain — it ignores the composer's chain picker. Low priority (polls are reasonably Pulse-native/cheap); revisit if cross-chain polls are wanted.
3. **Optional:** auto-derive `SW_CACHE_VER` from a content hash so the manual bump can't be forgotten (CI already guards it, so low priority).

*Resolved 2026-06-21 (see Done):* README architecture refresh; sw.js log gating; a11y alt attributes. Two audit items turned out **overstated on verification**: only **4** real alt-less `<img>` existed (not ~15 — the rest were multi-line tags whose `alt` sits on the continuation line, plus comment false-positives), and the **"2 `var` → const/let"** item was a false positive (both grep hits were inside comments — app.js has no `var` declarations).

## Standing / deferred (bigger or owner-gated)
- **Owner real-wallet validation** of every write path (including multichain writes) — currently verified only with a STUBBED signer headlessly; recommend dust-amount live tests on Base via Rabby. Specifically after the 2026-06-21 multichain-write changes: (a) top-level post to Base via the composer picker; (b) reply to a Base post from BOTH the reply modal AND the thread-page inline box (confirm the wallet lands/stays on Base, no flip back to Pulse); (c) like/repost a Base post; (d) an offline-then-online retry of a Base post.
- P0: external crypto review of the DM layer + a DM-payload scan in CI. P1: group-DM fan-out. P2: chat virtualization + exact cross-chain follower counts.
- Held per owner: Spaces recording (host `MediaRecorder` on the WebAudio mix — designed, not built) + listener fan-out handoff if the host drops; self-hosted TURN; `OFFICIAL_CHANNEL` placeholder `0x…0001`; spam-resilience; i18n; snapshot→IPFS.

*Not worth doing:* further app.js splits — compose/publish is eager + the core posting path; search is eager-wired. Diminishing returns; app.js is now the genuine core.
