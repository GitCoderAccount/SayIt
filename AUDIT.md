# SayIt — AUDIT / work log

**Read this first** when starting work on SayIt — it's the living record of what's done and what's open. Then read the full **`reference-sayit-repo`** memory (architecture, commands, gotchas, conventions) before changing anything. **Keep this file current:** move items from "Open" to "Done" as you finish them, and add new findings to "Open".

SayIt — decentralized social on PulseChain (chain 369); no-build static-file front-end; live at sayitdefi.com; CI green.

## Done (high level — git log has the per-commit detail)
- **Feature-complete X-style client:** feed, threads, profiles, follows, channels/chat, Explore, Lists & Communities, Notifications, Bookmarks, polls, Community Notes, Audio Spaces (WebRTC), tipping, encrypted DMs (x25519 + ML-KEM-768), Twemoji, image lightbox, PWA/offline.
- **Multichain — built & default-on:** aggregated Home feed across PulseChain + Ethereum + Base (keyless via Blockscout); writes stay on the post's chain (auto-switch); engagement on expensive chains ported via chain-qualified refs; global address identity. BSC is opt-in (needs a paid Etherscan-v2 key).
- **app.js decomposition COMPLETE (2026-06-19):** the ~15.3k-line `SayIt` class split into 13 per-subsystem augmenter files (settings, profile, polls, notes, spaces, explore, lists, notifications, channels, threads, bookmarks, banner, embeds) — app.js now ~8,867 lines (−42%). What remains is the feed/render/state/virtualization core + bootstrap + eager wiring + core posting path.
- **Test/guard hardening (2026-06-19):** `.ci/test/augment.test.js` (no duplicate prototype methods; every augmenter method lands on `SayIt.prototype`) + `.ci/test/render.test.js` (`utils.linkify` XSS escaping); ESLint expanded to ~19 correctness rules. 54 unit tests; lint + smoke + nightly live-smoke all green.

## Open / to work on (2026-06-19 audit — none urgent; codebase is healthy)
1. **Refactor complexity hotspots**, biggest first: `_wireGlobalDelegates` (~325 lines), `renderFeed` (~200), `goDashboard` (~194), `_renderSearchDropdown` (~171).
2. **Refresh the stale README architecture section** (still says "six static files / bundles core+cache+app" + the old 5-file `SW_CACHE_VER` list; the protocol table is fine).
3. **a11y:** ~15 `<img>` (mostly avatars) lack an `alt` attribute — add `alt=""` (decorative) or descriptive text.
4. **Minor:** gate the 3 `sw.js` `console.log`s behind a debug flag; 2 `var` → `const/let` in app.js; optionally auto-derive `SW_CACHE_VER` from a content hash.

## Standing / deferred (bigger or owner-gated)
- **Owner real-wallet validation** of every write path (including multichain writes) — currently verified only with a STUBBED signer headlessly; recommend a dust-amount live test on Base via Rabby.
- P0: external crypto review of the DM layer + a DM-payload scan in CI. P1: group-DM fan-out. P2: chat virtualization + exact cross-chain follower counts.
- Held per owner: Spaces recording (host `MediaRecorder` on the WebAudio mix — designed, not built) + listener fan-out handoff if the host drops; self-hosted TURN; `OFFICIAL_CHANNEL` placeholder `0x…0001`; spam-resilience; i18n; snapshot→IPFS.

*Not worth doing:* further app.js splits — compose/publish is eager + the core posting path; search is eager-wired. Diminishing returns; app.js is now the genuine core.
