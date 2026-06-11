<p align="center">
  <img src="image1.png" alt="Say It DeFi logo" width="120">
</p>

# Say It DeFi

**Uncensorable social media, built entirely on the PulseChain blockchain.** — [sayitdefi.com](https://sayitdefi.com) · [@SayItDeFi](https://x.com/SayItDeFi)

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

As with any website, your IP is technically visible to whoever serves you bytes: the static host, the block-explorer API **you** configure in Settings, and the hosts of media **you** choose to view. For the best feed experience, videos and embedded previews (YouTube/Vimeo, and shared X posts) **autoplay/load by default** — which connects you to those providers. Prefer zero third-party contact? Flip it off in **Settings → Privacy** (or enable **Data saver**), and embeds become click-to-load with neutral placeholders.

---

## Core features

### Posting and conversation
- **Write anything** — no character limit. Long posts collapse behind a "Show more" expander.
- **Threaded replies** rendered X-style: a reply in your feed carries the **original post above it**, joined by a thread line, and conversations show the full ancestor chain.
- **Reposts and quote-posts** with the original embedded inline (including its media).
- **Rich media** — images, GIFs, and video by URL (IPFS/Arweave auto-resolved). Videos **autoplay muted, one at a time**, and pause when scrolled off-screen. YouTube, Vimeo, and **X/Twitter posts** render as click-to-load embeds — a shared X post shows its full text, images, and **playable video** in place.
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

### Live Spaces (experimental)
- **Serverless audio rooms.** Announce a Space on-chain; the audio is a direct peer-to-peer WebRTC mesh between participants — no server, no accounts. Best with a small group (~8 speakers) in this first phase. (More → 🎙 Start a Space.)

### Channels, lists & organization
- A **channel** is any address you post *to* — the main timeline, any wallet, or any **token contract** (which auto-shows the token's logo/name/socials, and lets the deployer/owner publish a verified profile).
- **Lists** and **Communities**, optionally **published on-chain** as a portable snapshot.
- **Bookmarks**, **mutes**, and a tabbed **Channels** inbox with unread indicators and post counts.

### Notifications & profiles
- Unified **All / Mentions / Likes** notifications, including likes, replies, reposts, follows, poll activity, and **tips**.
- Editable on-chain profiles with a free **"verified" check** for any account that has published one; tabbed **Posts / Replies / Media** (Media includes images **and** video).

### Experience
- **Progressive Web App**, installable, offline-aware.
- **Three themes** — Dark, Dim, and Light — applied before first paint.
- **X-style two-pane Settings**, a virtualized feed, real links (⌘/middle-click open new tabs), keyboard shortcuts (press <kbd>?</kbd>), and **local-first deep sync** that archives the feed's full history into your browser for instant search, threads, and analytics — exportable as a portable snapshot.

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

- **Network:** PulseChain (chain ID **369**)
- **Data source:** a configurable block-explorer API (defaults to PulseScan) with an optional backup endpoint. Token identity is read from DexScreener; contract owner lookups use a public RPC.

---

## The on-chain protocol

Everything is a transaction sent **to a channel/recipient address** with a UTF-8 payload in the `input` field. The prefix determines its type:

| Prefix | Meaning |
|---|---|
| *(none)* | A regular post |
| `REPLY_TO:0x<txhash>\n\n<text>` | A reply to a post |
| `REPOST:0x<txhash>[\n\n<text>]` | Repost / quote-post |
| `LIKE:0x<txhash>` / `UNLIKE:0x<txhash>` | Like / unlike (last action wins) |
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

Likes, follows, votes, tips, etc. are derived by scanning and applying these in chain order, so any client computes the same state.

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

- **Three-file front-end** — `index.html` (HTML + CSS), `app.js` (all application JavaScript), and `sw.js` (service worker for PWA caching), plus a tiny `boot.js` pre-paint theme script. No framework, no bundler, no build pipeline. The only runtime dependency is **ethers.js v6**, pinned with an SRI integrity hash.
- **Trust but verify** — the explorer API is treated as an input, not an oracle: every transaction it returns is shape-validated at ingestion before anything touches a render path. A strict CSP, sink-level escaping, and delegated (never inline) event handlers form a layered defense.
- **Local cache** in IndexedDB (posts, profiles, channels, search index, likes archive, offline queue) keeps the timeline fast; deep sync can archive full history locally.
- **Resilient** — chain reads retry with backoff and fail over to a backup endpoint; external lookups degrade gracefully.
- **Tested** — every push runs syntax checks, ESLint, protocol unit tests, and a headless-Chromium boot smoke test; a nightly job smokes the live site, and `.ci/regression.py` is a 16-check behavioral gate for releases.
- **Deploys** are a push to the static host. After editing `index.html`/`app.js`, bump `SW_CACHE_VER` (CI enforces this).

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
