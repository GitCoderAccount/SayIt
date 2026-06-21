<p align="center">
  <img src="image1.png" alt="Say It DeFi logo" width="120">
</p>

# Say It DeFi

**Uncensorable social media, built on multiple EVM chains (PulseChain + Ethereum + Base + BSC by default).** — [sayitdefi.com](https://sayitdefi.com) · [@SayItDeFi](https://x.com/SayItDeFi)

Say It DeFi is a decentralized social platform where every post, reply, like, follow, poll, tip, profile, and community note lives on-chain. There is no central server storing your content, no database that can be wiped, no company that can delete your account or silence your voice, and **no tracking of any kind**. If your wallet can sign a transaction, you can speak — and what you say is permanent, public, and owned by no one but the network itself.

This repository hosts the **front-end**: a small, self-contained, from-scratch web application that reads the social graph directly from the blockchain and lets you write to it with your own wallet. The front-end is just a window. The data is the chain.

---

## What it is

A client for a permissionless social protocol. Instead of trusting a platform to host your posts, every action is a blockchain transaction:

- A **post** is a transaction whose data payload contains your message.
- A **reply** references the transaction hash of the post it answers.
- A **like**, **bookmark**, **follow**, or **repost** is a small tagged transaction.
- A **tip** is a PLS transfer straight to an author, tagged with the post it rewards.
- A **poll** embeds its question and options on-chain; **votes** are tallied by scanning the chain.
- A **community note** and its **ratings** surface reader context on a post.
- Your **profile** (name, bio, avatar, banner, links) is written on-chain and read back by any client.

Because all of this is just blockchain data, anyone can build their own interface to the same network. This front-end is one such interface — open, auditable, and dependency-light. (See [The on-chain protocol](#the-on-chain-protocol) to build your own.)

---

## Privacy — no cookies, no trackers, no server

Say It DeFi is built for people who want to speak freely without being watched. We mean that literally:

- **No cookies. No analytics. No telemetry. No fingerprinting.** The in-app Analytics page is computed entirely inside your browser from your own local cache — nothing is ever sent anywhere.
- **No server of ours.** The app is static files served from a host like GitHub Pages or IPFS. There is no backend to log you, and nothing in this project ever receives your IP or activity.
- **A strict Content-Security-Policy** means no inline or third-party script can execute on the page; code loads only from this origin and one pinned library.
- **Your data stays on your device.** Caches, settings, and archives live in your browser and can be wiped from Settings anytime.
- **You can verify all of this yourself** — open the in-app **"Verify it yourself"** page (More → 🛡️), watch your browser's Network tab, or read the source. Public scrutiny is the security model.

As with any website, your IP is technically visible to whoever serves you bytes: the static host, the block-explorer API **you** configure in Settings, and the hosts of media **you** choose to view. For the best feed experience, videos and embedded previews (YouTube/Vimeo, and shared **X/Twitter** posts) **autoplay/load by default** — which connects you to those providers. X embeds follow the same opt-out story as YouTube: they auto-load (full post, images, video via X's own iframe) as they scroll into view and unload when scrolled away. Prefer zero third-party contact? Flip it off in **Settings → Privacy** (or enable **Data saver**), and embeds become click-to-load with neutral placeholders; **strict** mode opens X externally instead of embedding.

**Live Spaces and your network address.** Spaces are real-time audio, so they involve direct connections that the privacy notes above don't cover. In one honest sentence each: **speakers** join a peer-to-peer audio mesh, so each speaker's device sees the others' IP addresses; **listeners** connect only to the host, so only the host and the discovery trackers ever see your connection; and the optional **IP-masking** mode (Settings → Privacy) routes everything through a TURN relay you supply, so other participants see the relay's address rather than yours — though the trackers, like any host you connect to, still see your real IP, and your audio is end-to-end encrypted (DTLS-SRTP) either way.

---

## Core features

### Posting and conversation
- **Write anything** — no character limit. Long posts collapse behind a "Show more" expander.
- **Threaded replies** rendered X-style: a reply in your feed carries the **original post above it**, joined by a thread line, and conversations show the full ancestor chain.
- **Reposts and quote-posts** with the original embedded inline (including its media).
- **Rich media** — images, GIFs, and video by URL (IPFS/Arweave auto-resolved). Videos **autoplay muted, one at a time**, and pause when scrolled off-screen. YouTube, Vimeo, and **X/Twitter posts** render inline — by default an X post **auto-loads as it scrolls into view** (full text, images, and **playable video** via X's own iframe) and unloads when scrolled away; switch it to click-to-load or strict (open-externally) in Settings → Privacy.
- **Emoji picker**, draft autosave, and an **offline queue** that retries failed posts when you reconnect.

### Engagement
- **Likes, bookmarks, follows, and tips**, all on-chain. Tip any author in PLS with one tap (💎); a profile shows how many tips and how much PLS it has received.
- **On-chain polls** with optional time limits, tallied verifiably from the chain.
- **Community notes** — X-style reader context that graduates to a public card once it passes a net-helpfulness threshold.

### Discovery
- **For You and Following feeds.** The Following feed shows each followed account's own posts wherever they posted, fetched efficiently so even busy accounts surface correctly.
- **Explore**, X-style: a "Happening now" hero, trending terms, and a Latest preview.
- **Search** people (by name **or** address), hashtags, and full post text — paste a **0x address** to jump to a profile/channel, or a **transaction hash** to open that post; Enter jumps straight there.
- **Profile hovercards**, **Today's News**, **Latest Polls**, and **Who to follow** panels.

### Creator dashboard
- A personal **Creator dashboard** (More → 🎬 Creator dashboard, the 📊 **Dashboard** button on your own profile, or `#/dashboard`) summarizes your reach: **tips received** (count, total PLS, and a per-day chart over 7/14/30 days), **likes received**, **top posts** (tips-first), **top supporters**, **followers gained**, and **Spaces hosted** — all computed **entirely locally** from your own cache, nothing sent anywhere.

### Live Spaces (experimental — now a flagship)
**Serverless, on-chain-announced audio rooms** — still experimental, but no longer a toy. There is no server and no account: a Space is announced as an on-chain post, and the audio rides direct peer-to-peer WebRTC. Spaces are **live-only and ephemeral** — nothing is recorded or played back, which is a privacy property, not a missing feature: when a Space ends, its audio is simply gone.

- **Space cards everywhere.** A Space renders as an X-style card in every feed, thread, and quote (with stale-cache revive so it stays consistent): a pulsing **LIVE** dot, the host's avatar and a **Host** chip, a live **participant count** that refreshes while the card is on screen, and a **Listen live** button. Ended Spaces show a muted "Ended" state.
- **Speakers and listeners.** Speakers form a small (≤8) audio mesh. Anyone else can **Listen live** with no microphone (receive-only): the host fans out a single WebAudio-mixed stream of all speakers to up to **40 listeners**, who only ever connect to the host. A listener can **request to speak** (wallet-signed); the host **Approves** to promote them into the speaker mesh.
- **The player.** Tapping a card opens a **preview** (title, host, live count, Start listening). Joining mounts a persistent **bottom-right dock** — like X's player — that survives navigation: a collapsed pill that expands into a panel with a **live chat** nest at the top (messages are on-chain replies to the Space's announcement post), a **participants grid** with **speaking rings** (live audio-level detection, relayed from host to listeners), and controls (mute / request-to-speak / leave / End).
- **Host controls and trust.** Room identity is **wallet-signed** (a signature over room + peer + timestamp, verified with `verifyMessage`), so the **Host** chip can't be forged. Hosts can **mute** participants and **grant co-host**. A host can **End** a Space for everyone instantly; if the host disconnects there's a 60-second grace period before auto-end.
- **Auto-ending.** Empty rooms end themselves (a passive tracker probe sees zero people for 10+ minutes), and every Space has a 24-hour hard cap.
- **IP-masking option (Settings → Privacy).** Optionally route your connection through a **TURN relay you supply**, so other participants see the relay's address instead of yours; audio stays end-to-end encrypted (DTLS-SRTP) regardless. It's **off by default** (no reliable free public TURN exists), and if you turn it on without configuring a relay, joining is **blocked** with an explicit "Join without masking" choice — never a silent fallback. The room UI carries role-aware privacy notes. (More → 🎙 Start a Space.)

### Chat — channels & encrypted DMs
- The **Chat** page has two sides: **Channels** (public per-address conversations) and **Messages** — **end-to-end encrypted, post-quantum direct messages** (X25519 + ML-KEM-768; see [Encrypted direct messages](#encrypted-direct-messages)). Content is private; on-chain metadata stays public.
- A **channel** is any address you post *to* — the main timeline, any wallet, or any **token contract** (which auto-shows the token's logo/name/socials, and lets the deployer/owner publish a verified profile).
- **Lists** and **Communities**, optionally **published on-chain** as a portable snapshot.
- **Bookmarks**, **mutes**, and a tabbed Chat inbox with unread indicators and post counts.

### Notifications & profiles
- Unified **All / Mentions / Likes** notifications, including likes, replies, reposts, follows, poll activity, and **tips**.
- Editable on-chain profiles with a free **"verified" check** for any account that has published one; tabbed **Posts / Replies / Media** (Media includes images **and** video).

### Experience
- **Progressive Web App**, installable, offline-aware.
- **Three themes** — Dark, Dim, and Light — applied before first paint.
- **X-style two-pane Settings**, a virtualized feed, real links (⌘/middle-click open new tabs), keyboard shortcuts (press <kbd>?</kbd>), and **local-first deep sync** that archives the feed's full history into your browser for instant search, threads, and analytics — exportable as a portable snapshot. A **deep-sync scope selector** (full history, or the last 300 / 100 pages, with an optional likes-archive toggle) controls how much to pull, and a **storage manager** shows what's cached (including the archived-likes count) with per-store clears for the likes archive and search index.

---

## How it works

```
Your wallet ──signs──► PulseChain transaction ──contains──► your post / action
                                  │
                                  ▼
                       The blockchain (chain ID 369)
                                  │
       Say It DeFi reads it back ─┘  via a configurable block-explorer API
                                  │
                                  ▼
                          Rendered in your feed
```

Every social action is a transaction whose input data carries a small, human-readable payload. The front-end scans the chain through a public block-explorer API, decodes these payloads, and assembles them into feeds, threads, profiles, tallies, and notes — computing reactions and engagement the same way. Nothing is stored on a private server; the only local storage is your own browser cache and preferences.

- **Network:** PulseChain (chain ID **369**) by default — and **any EVM chain** you enable (Ethereum, Base, BNB Chain). See [Multichain](#multichain).
- **Data source:** a configurable block-explorer API (defaults to PulseScan) with an optional backup endpoint; other chains read through Etherscan's unified v2 API. Token identity is read from DexScreener; contract owner lookups use a public RPC.

---

## The on-chain protocol

Everything is a transaction sent **to a channel/recipient address** with a UTF-8 payload in the `input` field. The prefix determines its type:

| Prefix | Meaning |
|---|---|
| *(none)* | A regular post |
| `REPLY_TO:0x<txhash>\n\n<text>` | A reply to a post |
| `REPOST:0x<txhash>[\n\n<text>]` | Repost / quote-post |
| `LIKE:0x<txhash>` / `UNLIKE:0x<txhash>` | Like / unlike (last action wins) |
| `LIKE:eip155:<chainId>:0x<txhash>` | A like **ported** from another chain (see Multichain). Counts collapse to the bare hash, so native + ported likes aggregate. |
| `BOOKMARK:0x<txhash>` / `UNBOOKMARK:` | Private bookmark (sent to self) |
| `FOLLOW:0x<addr>` / `UNFOLLOW:0x<addr>` | Follow / unfollow (sent to the target) |
| `TIP:0x<txhash>` | Tip the post's author — the tx **value** is the tip (PLS) |
| `PROFILE_DATA:{json}` | Your own profile (sent to self) |
| `PROFILE_FOR:0x<token>\n\n{json}` | A token's profile — honored only from its deployer/`owner()` |
| `POLL:{json}\n\n<question>` | A poll |
| `VOTE:0x<pollhash>:<optionIndex>` | A poll vote (last vote wins) |
| `NOTE:0x<posthash>\n\n<text>` | A community note on a post |
| `NOTERATE:0x<notehash>:h\|n` | Rate a note helpful / not (last rating wins) |
| `SPACE:{json}\n\n<title>` | A live audio Space announcement |
| `SPACE_END:0x<spacehash>` | End a Space — honored only from the Space's author |
| `DMKEY1:<base64>` | Publish your public **encrypted-DM** key bundle (X25519 + ML-KEM-768), sent to self |
| `DM1:<base64>` | One end-to-end **encrypted** direct message (see below) |

Likes, follows, votes, tips, etc. are derived by scanning and applying these in chain order, so any client computes the same state.

---

## Multichain

SayIt's protocol is chain-agnostic — a post is just a transaction with a UTF-8 `input`, so the **same protocol runs on any EVM chain**, and your wallet address is the **same identity everywhere**. PulseChain (369) is the canonical chain; Ethereum and Base are on by default, BNB Chain is opt-in.

- **You post on whatever chain your wallet is on.** There's no chain picker. SayIt reads your wallet's **current network** and posts/replies/reposts there — it **never switches your network for you**. Want to post on another chain? Just change the network inside your wallet, and everything you do is on that chain. The composer shows your current network and passively warns when its gas is pricey (or when it isn't indexed). **PulseChain is recommended** — near-free gas.
- **Reads vs. writes.** **Settings → Networks** controls which chains your **feed reads** (enable chains, paste a free **Etherscan v2 API key** — one key covers Ethereum/Base/BNB Chain reads; PulseChain needs no key via Blockscout). Reads aggregate across those chains regardless of which chain you're posting from.
- **One aggregated feed.** Your Home feed reads the main channel on every enabled chain in parallel and time-merges the results; each post shows a small **chain badge** (PLS / ETH / BASE / BSC) and links to that chain's explorer. **Replies thread by tx hash**, so a reply stitches to its parent even if they live on different chains.
- **Engagement & identity stay on PulseChain.** Likes/follows/profiles are read from the canonical chain (your identity is global), so those actions are recorded there. A like on an expensive-chain post is **ported** with a chain-qualified ref `LIKE:eip155:<chainId>:0x<hash>`; because a tx hash is globally unique, native and ported likes for the same post **collapse to one count**. Follows are global (the **Following feed** gathers a followed address's posts from all enabled chains). **Tips stay native** (they carry real value and can't be ported).

---

## Encrypted direct messages

DMs are **end-to-end encrypted** and **post-quantum**. Only the message *content* is protected — like any on-chain action, the *metadata* (who messaged whom, and when) is permanent and public. The app says so plainly in the UI; treat it as "private contents, public envelope."

**Scheme.** Each message body is sealed with a random key `K` using **XChaCha20-Poly1305**; `K` is then wrapped for the people who may read it:

- **Key agreement is hybrid:** **X25519** (elliptic-curve) **combined with ML-KEM-768** (NIST FIPS 203 lattice KEM), mixed through **HKDF-SHA256**. A message stays secret unless *both* are broken — so it survives a future quantum computer (defeating "harvest-now-decrypt-later," which matters because the ciphertext lives on-chain forever).
- **Dual-wrap envelope:** `K` is wrapped twice — once to the **recipient** (hybrid KEM) and once to the **sender** (a symmetric key derived from the sender's own X25519 secret). That's why you can read your *own* sent messages on any device, while still being end-to-end.
- **Identity keys** are derived **deterministically from a one-off wallet signature** (`DM_SIGN_MESSAGE`) — they're never stored and never leave the browser; sign once per session to unlock. Your public bundle is published once via `DMKEY1:` so others can reach you.
- **Authenticity & anti-replay:** the transaction's `from` already proves the sender; the sender and recipient addresses are bound into the AEAD so a copied ciphertext can't be replayed from another account. A version byte (`DM1:` payload v2) lets the format evolve.

**Crypto library.** The primitives are [`@noble/curves`](https://github.com/paulmillr/noble-curves), [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum), `@noble/hashes`, and `@noble/ciphers` — **vendored** as a single self-contained, **SRI-pinned** file (`sayit-crypto.js`), built reproducibly (see `CRYPTO_BUILD.md`). No `eval`/WASM, no network calls.

**Limits (by design).** Lose the wallet, lose the history (keys derive from it; no recovery). Metadata is public. Group DMs aren't supported yet.

---

## Running it

No build step, no backend.

```bash
cd SayIt
python3 -m http.server 8080
# then open http://localhost:8080
```

Serve over HTTP(S) (not `file://`) so the service worker works. Open in a browser with a Web3 wallet on PulseChain (chain ID 369). You don't need a wallet to read — only to post or interact. Deploy by serving the static files from any host (GitHub Pages, IPFS, your own server).

Most settings are adjustable in-app under **Settings** (two-pane, X-style): block-explorer endpoint, scan depth, feed/media controls, privacy, deep-sync archive + snapshot export/import, and a one-click reset.

---

## Tech notes

- **Modular, build-free front-end** — ~20 static files, no framework and no bundler. One `SayIt` class lives in `app.js`; each feature subsystem (settings, profile, polls, notes, spaces, explore, lists, notifications, channels, threads, bookmarks, banner, embeds, DMs) is a per-file *augmenter* that copies its methods onto `SayIt.prototype` at load time. The classic scripts share one global scope and load in a fixed order — `sayit-crypto` → `core` → `cache` → `app` → the feature augmenters — alongside `index.html` (HTML + CSS), `boot.js` (a tiny pre-paint theme script) and `sw.js` (the PWA service worker). `core.js` holds constants, utils, the `SpaceRTC` engine and the multichain `CHAINS` registry; `cache.js` is the IndexedDB layer; `app.js` is the feed/render/state core plus bootstrap. For lint and tests, `.ci/extract-inline-script.js` **bundles `core` + `cache` + `app` + every augmenter** into a single `.ci/app.extracted.js`. The only runtime dependency is **ethers.js v6**, pinned with an SRI integrity hash.
- **Trust but verify** — the explorer API is treated as an input, not an oracle: every transaction it returns is shape-validated at ingestion before anything touches a render path. A strict CSP, sink-level escaping, and delegated (never inline) event handlers form a layered defense.
- **Local cache** in IndexedDB (posts, profiles, channels, search index, likes archive, offline queue) keeps the timeline fast; deep sync can archive full history locally.
- **Resilient** — chain reads retry with backoff and fail over to a backup endpoint; external lookups degrade gracefully.
- **Tested** — every push runs syntax checks, ESLint, protocol unit tests, and a headless-Chromium boot smoke test; a nightly job smokes the live site, and `.ci/regression.py` is a 16-check behavioral gate for releases.
- **Deploys** are a push to the static host. Bump `SW_CACHE_VER` (in `app.js`) whenever any front-end asset changes — `index.html`, `boot.js`, `sayit-crypto.js`, or any of the JS modules (`app.js`, `core.js`, `cache.js` and the feature augmenters) — so the service worker invalidates its cache (CI enforces this).

---

## Privacy, permanence, and responsibility

- Everything you post is **public, permanent, and immutable**. No one — including the operators of this interface — can edit or remove an on-chain post.
- This interface does **not** host, store, moderate, or control any content. It only reads and displays what already exists on the blockchain.
- **You are responsible** for your wallet, your keys, and everything you post. On-chain transactions cost gas and cannot be reversed.
- Nothing in the app is financial, legal, or investment advice.

### Original, independent software

This application was **built from scratch** as free, open-source software. It is not affiliated with, endorsed by, or derived from any other platform or company. Any resemblance to other social applications is purely coincidental and limited to familiar user-interface conventions (timelines, replies, reposts) common across the industry. The entire source code is public in this repository — it may be freely inspected, shared, forked, and built upon.

---

## License

See the repository for license details.

---

*Say It DeFi — uncensorable social on PulseChain.*

## Multi-Network Support
Say It DeFi aggregates content across multiple EVM chains. Your wallet identity
is the same on every chain; posts, likes, and follows are chain-specific, but
the Home feed shows them together.

- **Enabled by default** (read keyless via Blockscout): **PulseChain**
  (canonical), **Ethereum**, **Base**.
- **Opt-in:** **BSC** has no keyless explorer, so it needs a (paid) Etherscan
  API key and ships off by default — add a key and enable it under
  **Settings → Networks**.

Customize which networks to include under **Settings → Networks**.
