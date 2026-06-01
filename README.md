# Say It DeFi

**Uncensorable social media, built entirely on the PulseChain blockchain.**

Say It DeFi is a decentralized social platform where every post, reply, like, follow, poll, and profile lives on-chain. There is no central server storing your content, no database that can be wiped, and no company that can delete your account or silence your voice. If your wallet can sign a transaction, you can speak — and what you say is permanent, public, and owned by no one but the network itself.

This repository hosts the **front-end**: a single, self-contained web application that reads the social graph directly from the blockchain and lets you write to it with your own wallet. The front-end is just a window. The data is the chain.

---

## What it is

Say It DeFi is a client for a permissionless social protocol. Instead of trusting a platform to host your posts, every action is encoded as a blockchain transaction:

- A **post** is a transaction whose data payload contains your message.
- A **reply** references the transaction hash of the post it answers.
- A **like**, **bookmark**, **follow**, or **repost** is a small tagged transaction.
- A **poll** embeds its question and options on-chain; **votes** are transactions tallied by scanning the chain.
- Your **profile** (display name, bio, avatar, banner) is written on-chain and read back by any client.

Because all of this is just blockchain data, anyone can build their own interface to the same network. This front-end is one such interface — open, auditable, and dependency-free.

---

## Core features

### Posting and conversation
- **Write anything.** No character limit — short thoughts, long essays, or full articles. Long posts collapse behind a "Show more" expander in the feed.
- **Threaded replies** with visual connector lines, so conversations are easy to follow.
- **Reposts and quote-posts** to amplify others, with the original post embedded inline.
- **Rich media** — attach images, GIFs, and video by URL (including IPFS and Arweave links, which are resolved automatically).
- **Emoji picker** with categorized, multi-select emoji, plus a draft autosave so you never lose a half-written post.

### Engagement
- **Likes, bookmarks, and follows**, all recorded on-chain and reflected live across the interface.
- **On-chain polls** — create a poll with multiple options and an optional time limit. Votes are counted directly from the blockchain on a last-vote-wins basis, so the tally is verifiable by anyone. Closed polls surface their final results.
- **Real engagement counts** derived from chain data, not from a private server.

### Discovery
- **For You and Following feeds** to switch between the whole network and the accounts you follow.
- **Explore** and a **trending** panel that highlights active hashtags on the network.
- **Search-as-you-type** across people and hashtags, with keyboard navigation.
- **Today's News** and **Latest Polls** side panels surfacing the most active recent content.
- **Who to follow** suggestions derived from active accounts in your current feed.
- **Channels** — post into and browse different on-chain channels (address-scoped spaces), including a featured partner channel.

### Organization
- **Lists** — group accounts into named lists and view a combined feed of just those members.
- **Communities** — follow address-scoped community channels.
- **Hybrid on-chain sync** — Lists and Communities work instantly and locally by default, and can be **published on-chain** as a single snapshot transaction so they travel with you across devices and are publicly portable. A matching **restore** reads your latest snapshot back. Returning on a fresh device auto-restores them in the background.
- **Bookmarks** — save posts to revisit later.

### Notifications
- A unified notifications view with **All / Mentions / Likes** tabs.
- Alerts for likes, follows, replies, reposts — plus **poll notifications**: get notified when someone votes on a poll you created and when one of your polls ends.
- A live unread badge (title + favicon) for quick activity, with full poll-activity scanning when you open the notifications page.

### Profiles
- Editable **display name, bio, avatar, and banner**, all stored on-chain.
- Tabbed profile view: **Posts, Replies, Media, Likes**.
- **Follower and following** lists, counted by scanning the chain.

### Experience
- **Progressive Web App** — installable to your home screen or desktop, with a service worker for fast loads and offline-aware behavior.
- **Virtualized feed** that recycles DOM nodes, so even very long timelines stay smooth.
- **Keyboard shortcuts** for power users — press <kbd>?</kbd> anywhere to see the full list (navigate with `j`/`k`, act with `l`/`r`/`t`/`b`, jump pages with `g` then a key, compose with `n`/`e`, search with `/`).
- **Relative timestamps** that refresh themselves, sticky "new posts" indicators, focus-trapped modals, ARIA labelling, and other accessibility and polish touches throughout.
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

Every social action is a transaction whose input data carries a small, human-readable payload (for example, a post is plain text; a follow is a short tagged marker addressed to the followed account; a vote references a poll's transaction hash). The front-end scans the chain through a public block explorer API, decodes these payloads, and assembles them into feeds, threads, profiles, and tallies. Reactions and engagement are computed the same way — by reading what's already on-chain.

Nothing is stored on a private server. The only local storage is your own browser cache (for speed) and your personal preferences.

- **Network:** PulseChain (chain ID **369**)
- **Default channel:** a fixed on-chain address that serves as the main public timeline
- **Data source:** a configurable PulseChain block explorer API (defaults to the public PulseScan endpoint), with an optional backup endpoint for resilience

---

## Running it

This is a single self-contained front-end. There is no build step and no backend to deploy.

1. Serve the files (`index.html` and `sw.js`) from any static host — GitHub Pages, IPFS, or any web server.
2. Open the site in a browser with a Web3 wallet (such as one supporting PulseChain).
3. Connect your wallet, make sure it's on PulseChain (chain ID 369), and start posting.

To read the timeline you don't even need a wallet — connect one only when you want to post or interact.

### Configuration

Most settings are adjustable in-app under **Settings**, including:

- The block explorer **API endpoint** (and an optional backup endpoint).
- **Scan depth** — how many pages of chain history to read when building feeds and follower lists (set to unlimited for the deepest history, at the cost of slower scans).
- Local cache pruning age and other preferences.

---

## Privacy, permanence, and responsibility

Say It DeFi is a front-end to a public, permissionless network. Please understand:

- Everything you post is **public, permanent, and immutable**. Once a post is on-chain, no one — including the operators of this interface — can edit or remove it.
- This interface does **not** host, store, moderate, or control any content. It only reads and displays what already exists on the blockchain.
- **You are responsible** for your wallet, your keys, and everything you post. On-chain transactions cost gas and cannot be reversed.
- Nothing in the app is financial, legal, or investment advice.

By using the interface, you acknowledge that the creators and operators are not liable for content posted or actions taken on the underlying decentralized network.

---

## Tech notes

- **Single-file front-end** — the entire application is one `index.html` (HTML, CSS, and JavaScript inlined), paired with a service worker (`sw.js`) for PWA caching. No frameworks, no bundler, no build pipeline.
- **Wallet & chain access** via ethers.js and the browser's injected Web3 provider.
- **Local cache** in IndexedDB for posts and engagement maps, keeping the timeline fast and reducing redundant chain reads.
- **Resilient reads** — the chain-scanning layer retries with backoff and can fail over to a backup explorer endpoint.

---

## License

See the repository for license details.

---

*Say It DeFi — uncensorable social on PulseChain.*
