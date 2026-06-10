<p align="center">
  <img src="image1.png" alt="Say It DeFi logo" width="120">
</p>

# Say It DeFi

**Uncensorable social media, built entirely on the PulseChain blockchain.** — [sayitdefi.com](https://sayitdefi.com) · [@SayItDeFi](https://x.com/SayItDeFi)

Say It DeFi is a decentralized social platform where every post, reply, like, follow, poll, profile, and community note lives on-chain. There is no central server storing your content, no database that can be wiped, and no company that can delete your account or silence your voice. If your wallet can sign a transaction, you can speak — and what you say is permanent, public, and owned by no one but the network itself.

This repository hosts the **front-end**: a single, self-contained web application that reads the social graph directly from the blockchain and lets you write to it with your own wallet. The front-end is just a window. The data is the chain.

---

## What it is

Say It DeFi is a client for a permissionless social protocol. Instead of trusting a platform to host your posts, every action is encoded as a blockchain transaction:

- A **post** is a transaction whose data payload contains your message.
- A **reply** references the transaction hash of the post it answers.
- A **like**, **bookmark**, **follow**, or **repost** is a small tagged transaction.
- A **poll** embeds its question and options on-chain; **votes** are transactions tallied by scanning the chain.
- A **community note** and its **ratings** are tagged transactions that surface reader context on a post.
- Your **profile** (display name, bio, avatar, banner, links) is written on-chain and read back by any client.

Because all of this is just blockchain data, anyone can build their own interface to the same network. This front-end is one such interface — open, auditable, and dependency-free. (See [The on-chain protocol](#the-on-chain-protocol) below if you want to build your own.)

---

## Core features

### Posting and conversation
- **Write anything.** No character limit — short thoughts, long essays, or full articles. Long posts collapse behind a "Show more" expander in the feed.
- **Threaded replies** with visual connector lines, so conversations are easy to follow.
- **Reposts and quote-posts** to amplify others, with the original post embedded inline.
- **Rich media** — attach images, GIFs, and video by URL (including IPFS and Arweave links, which are resolved automatically). YouTube, Vimeo, and X/Twitter links render as inline cards.
- **Emoji picker** with categorized, multi-select emoji, plus a draft autosave so you never lose a half-written post.
- **Offline queue** — if a post fails to send (offline or a network hiccup), it's saved and automatically retried when you reconnect.

### Engagement
- **Likes, bookmarks, and follows**, all recorded on-chain and reflected live across the interface.
- **On-chain polls** — create a poll with multiple options and an optional time limit. Votes are counted directly from the blockchain on a last-vote-wins basis, so the tally is verifiable by anyone. Closed polls surface their final results.
- **Community notes** — X-style reader context. Anyone can attach a note to a post; readers rate notes *helpful* / *not helpful*, and a note graduates to a public "Readers added context" card once it passes the net-helpfulness threshold.
- **Real engagement counts** derived from chain data, not from a private server.

### Discovery
- **For You and Following feeds** to switch between the whole network and the accounts you follow. The Following feed shows each followed account's own posts wherever they posted them — main timeline, their channel, token channels, or replies — fetched efficiently per-account so even accounts buried under heavy incoming engagement surface correctly.
- **Explore** and a **trending** panel that highlights active hashtags on the network.
- **Search** people (by display name **or** address), hashtags, and full post text. Paste a complete **0x address** for a direct jump to that account's **profile** or **channel**, or paste a **transaction hash** to open that post as a thread — Enter jumps straight there.
- **Profile hovercards** — hover any name or avatar (in the feed, followers lists, or the who-to-follow panel) for a quick profile preview without leaving the page.
- **Today's News** and **Latest Polls** side panels surfacing the most active recent content.
- **Who to follow** suggestions derived from active accounts in your current feed.

### Channels
A **channel** is simply an address you post *to*. The default channel is the main public timeline; every wallet, contract, or token address is its own channel.

- A redesigned **Channels** page: a tabbed inbox of every channel you touch — **All**, **Unread**, and **Following**.
- Quick-access rows pinned at the top: **Main Feed**, **Your inbox** (posts addressed *to you*), and the **Say It DeFi Channel** (official updates).
- **Unread indicators** — channels with new activity since you last opened them are flagged; "mark all read" clears them.
- Open any address as a channel from the search bar or the channel input; your visited channels build up automatically.

### Token channels
Every **token contract** is a channel where holders can talk about it — and it gets a real identity automatically:

- **Auto-identity** — a token channel shows the token's **logo, name (SYMBOL), banner, website, and socials**, pulled from DexScreener, with a "Token" badge. No setup required.
- **Verified profiles** — a token's **deployer** or current **`owner()`** can publish a profile for it ("Set token profile"), shown with a green **✓ Verified** badge. This lets projects claim and brand their channel, and because the profile is signed by the contract's on-chain deployer/owner, anyone can verify it's authentic. Tokens are detected and the editor appears only when *your* connected wallet is the deployer/owner.

### Organization
- **Lists** — group accounts into named lists and view a combined feed of just those members.
- **Communities** — follow address-scoped community channels.
- **Hybrid on-chain sync** — Lists and Communities work instantly and locally by default, and can be **published on-chain** as a single snapshot transaction so they travel with you across devices and are publicly portable. A matching **restore** reads your latest snapshot back. Returning on a fresh device auto-restores them in the background.
- **Bookmarks** — save posts to revisit later.
- **Analytics** (More → Analytics) — local network stats computed from your own cached slice of the chain: posts per day, most active authors, trending terms, and totals. No server, no tracking.

### Notifications
- A unified notifications view with **All / Mentions / Likes** tabs.
- Alerts for likes, follows, replies, reposts — plus **poll notifications**: get notified when someone votes on a poll you created and when one of your polls ends.
- A live unread badge (title + favicon) for quick activity, with full poll-activity scanning when you open the notifications page.

### Profiles
- Editable **display name, bio, avatar, banner, website, and location**, all stored on-chain.
- An **on-chain "verified"** check appears next to any account that has published a profile — free, gatekeeper-free proof of identity.
- Tabbed profile view: **Posts, Replies, Media, Likes** (plus **Highlights** and **Articles**, coming soon).
- **Follower and following** lists, counted by scanning the chain, with hover previews.

### Experience
- **Progressive Web App** — installable to your home screen or desktop, with a service worker for fast loads and offline-aware behavior.
- **Virtualized feed** that recycles DOM nodes, so even very long timelines stay smooth.
- **Real links** — nav items, channels, and profiles are proper links, so **right-click / middle-click / ⌘-click open them in a new tab** like any website; plain clicks route instantly in-app.
- **Keyboard shortcuts** for power users — press <kbd>?</kbd> anywhere to see the full list (navigate with `j`/`k`, act with `l`/`r`/`t`/`b`, jump pages with `g` then a key, compose with `n`/`e`, search with `/`).
- **Two-standard button system** (purple primary, outline secondary), centered responsive layout, **relative timestamps** that refresh themselves, sticky "new posts" indicators, focus-trapped modals, ARIA labelling, and other accessibility and polish touches throughout.
- A first-visit **disclaimer** that explains the decentralized, non-custodial nature of the platform.

---

## How it works

```
Your wallet  ──signs──►  PulseChain transaction  ──contains──►  your post / action
                                   │
                                   ▼
                        The blockchain (chain ID 369)
                                   │
        Say It DeFi reads it back ─┘  via a PulseChain block explorer API
                                   │
                                   ▼
                        Rendered in your feed
```

Every social action is a transaction whose input data carries a small, human-readable payload (for example, a post is plain text; a follow is a short tagged marker addressed to the followed account; a vote references a poll's transaction hash). The front-end scans the chain through a public block explorer API, decodes these payloads, and assembles them into feeds, threads, profiles, tallies, and notes. Reactions and engagement are computed the same way — by reading what's already on-chain.

Nothing is stored on a private server. The only local storage is your own browser cache (for speed) and your personal preferences.

- **Network:** PulseChain (chain ID **369**)
- **Default channel:** a fixed on-chain address that serves as the main public timeline
- **Data source:** a configurable PulseChain block explorer API (defaults to the public PulseScan endpoint), with an optional backup endpoint for resilience. Token identity is read from DexScreener; contract deployer/owner lookups use the explorer and a public RPC.

---

## The on-chain protocol

Want to build your own client, bot, or analytics on the same network? Everything is just a transaction sent **to a channel address** with a UTF-8 payload in the `input` field. The payload's prefix determines its type:

| Prefix | Meaning |
|---|---|
| *(none)* | A regular post |
| `REPLY_TO:0x<txhash>\n\n<text>` | A reply to a post |
| `REPOST:0x<txhash>[\n\n<text>]` | Repost / quote-post |
| `LIKE:0x<txhash>` / `UNLIKE:0x<txhash>` | Like / unlike (last action wins) |
| `BOOKMARK:0x<txhash>` / `UNBOOKMARK:` | Private bookmark (sent to self) |
| `FOLLOW:0x<addr>` / `UNFOLLOW:0x<addr>` | Follow / unfollow (sent to the target) |
| `PROFILE_DATA:{json}` | Your own profile (sent to self) |
| `PROFILE_FOR:0x<token>\n\n{json}` | A token's profile — honored only from the token's deployer or current `owner()` |
| `POLL:{json}\n\n<question>` | A poll |
| `VOTE:0x<pollhash>:<optionIndex>` | A poll vote (last vote wins) |
| `NOTE:0x<posthash>\n\n<text>` | A community note on a post |
| `NOTERATE:0x<notehash>:h\|n` | Rate a note helpful / not (last rating wins) |

Likes, follows, votes, notes, etc. are derived by scanning and applying these in chain order, so any client computes the same state.

---

## Running it

This is a single self-contained front-end. There is no build step and no backend to deploy.

1. Serve the files (`index.html` and `sw.js`) from any static host — GitHub Pages, IPFS, or any web server. (For the service worker / PWA features, it must be served over HTTP(S), not opened as a `file://`.)
2. Open the site in a browser with a Web3 wallet (such as one supporting PulseChain).
3. Connect your wallet, make sure it's on PulseChain (chain ID 369), and start posting.

To read the timeline you don't even need a wallet — connect one only when you want to post or interact.

Locally:

```bash
cd SayIt
python3 -m http.server 8080
# then open http://localhost:8080
```

### Configuration

Most settings are adjustable in-app under **Settings**, including:

- The block explorer **API endpoint** (and an optional backup endpoint).
- **Scan depth** — how many pages of chain history to read when building feeds and follower lists (set to unlimited for the deepest history, at the cost of slower scans).
- **Feed post cap** and local cache pruning, plus buttons to clear the post cache, channel history, and offline queue.
- **Deep sync** — opt-in, resumable archive of the main feed's full history into your browser; search, threads, and analytics then work from your complete local copy. Export the archive as a **posts snapshot** to share or restore on another device (imports are strictly validated).
- **Themes** — Dark, Dim, and Light, applied before first paint.
- **Export / Import** your settings, mutes, lists and communities as a JSON backup — and a one-click **Reset to defaults** for all settings.

---

## Privacy, permanence, and responsibility

Say It DeFi is a front-end to a public, permissionless network. Please understand:

- Everything you post is **public, permanent, and immutable**. Once a post is on-chain, no one — including the operators of this interface — can edit or remove it.
- This interface does **not** host, store, moderate, or control any content. It only reads and displays what already exists on the blockchain.
- **You are responsible** for your wallet, your keys, and everything you post. On-chain transactions cost gas and cannot be reversed.
- Nothing in the app is financial, legal, or investment advice.

By using the interface, you acknowledge that the creators and operators are not liable for content posted or actions taken on the underlying decentralized network.

### Original, independent software

This application was **built from scratch** as free, open-source software. It is not affiliated with, endorsed by, or derived from any other platform or company. Any resemblance to other social applications is purely coincidental and limited to familiar user-interface conventions (timelines, replies, reposts) that are common across the industry. The entire source code is public in this repository — it may be freely inspected, shared, forked, and built upon.

---

## Tech notes

- **Single-file front-end** — the entire application is one `index.html` (HTML, CSS, and JavaScript inlined), paired with a service worker (`sw.js`) for PWA caching. No frameworks, no bundler, no build pipeline. The only runtime dependency is **ethers.js v6**, loaded from a CDN with a pinned version and SRI integrity hash.
- **Wallet & chain access** via ethers.js and the browser's injected Web3 provider; read-only contract calls (e.g. token `owner()`) use a public PulseChain RPC.
- **Trust but verify** — the explorer API is treated as an input, not an oracle: every transaction it returns is shape-validated at ingestion before anything touches a render path, and a Content-Security-Policy restricts what the page can load and where scripts may come from.
- **Local cache** in IndexedDB (posts, profiles, channels, search index, offline queue) keeps the timeline fast and reduces redundant chain reads.
- **Resilient reads** — the chain-scanning layer retries with backoff and can fail over to a backup explorer endpoint; storage and external lookups (DexScreener, RPC) degrade gracefully when unavailable.
- **Tested in CI** — every push runs syntax checks, ESLint, protocol unit tests (every payload prefix incl. malformed and adversarial shapes), and a headless-Chromium boot smoke test that fails the build if the app doesn't start.
- **Deploys** are just a push to the static host. After changing `index.html`, bump `SW_CACHE_VER` so the service worker invalidates its cache on the next load.

---

## License

See the repository for license details.

---

*Say It DeFi — uncensorable social on PulseChain.*
