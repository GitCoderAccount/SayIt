# Say It DeFi

![Pulse Underground](image1.jpeg)

**Decentralized • Censorship-Resistant • Real-Time News & Messaging on PulseChain**

> No one can stop you from posting whatever you want.  
> No one can silence you.  
> Welcome to The Pulse Underground.

## Vision

**Say It DeFi** is a fully decentralized social news and messaging platform built natively on **PulseChain**.  

Instead of relying on centralized servers, databases, or Web2 platforms that can censor, shadow-ban, or shut you down, Pulse Underground turns **zero-value transactions** into immutable public posts and private channels.

Every message is embedded directly in the blockchain as transaction data. The entire feed is pulled from the public PulseScan API. There are no servers, no moderators, no accounts, and no single point of failure.

This is freedom of speech at the protocol level.

## ✨ Key Features

### Core Functionality
- **Post via Transactions** — Type a message → send 0-value tx with UTF-8 text in the data field
- **Channels = Addresses** — Every PulseChain address functions as a channel/room
- **Main Channel** — Global public feed
- **Self Channel** — Your personal inbox (only shows messages **sent to** your address)
- **Custom Channels** — Join any address instantly

### Smart Feed Experience
- **Incoming-Only Filtering** — Self Channel never shows your outgoing messages
- **Infinite Scroll** — Automatically loads older history when you reach the bottom
- **Background Live Updates** — Polls every 2 minutes without refreshing the page
- **"New Stories Available" Button** — Twitter/X-style notification at the top
- **Dynamic Gas Estimation** — Always uses the cheapest safe gas limit
- **Local Profile** — Username + avatar URL (stored in browser)
- **Instant Search** — Filter posts by content or reporter
- **IndexedDB Caching** — Lightning-fast reloads and offline-ish feel

### Freedom & Privacy
- Fully client-side (single HTML file)
- No backend, no database, no KYC
- Censorship is impossible as long as PulseChain lives

## How It Works (Technical Breakdown)

1. Connect your PulseChain wallet
2. Select a channel (Main / Self / Custom address)
3. Write message → encoded as `data` in a 0-value transaction
4. App scans transaction history of the channel address via PulseScan API
5. Filters to **only incoming** transactions (`to === channel`)
6. Decodes `raw_input` from hex to UTF-8 text
7. New messages detected via background polling

**To post in your own Self Channel** → simply send the transaction to yourself.

## Quick Start

### Option 1: Use it Now
Just open `index.html` (or visit the hosted version).

### Option 2: Run Locally / Host Yourself
```bash
git clone https://github.com/yourusername/pulse-underground.git
cd pulse-underground
# Open index.html in any browser
Requirements:

MetaMask (or any PulseChain-compatible wallet)
Connected to PulseChain Mainnet (Chain ID: 369)

Usage Guide

Connect Wallet — Sidebar button
Switch Channels — Use the buttons or enter any address
Post — Type in the box and hit the arrow (➤)
Scroll Down — Auto-loads older posts when you reach the bottom
New Posts — If new messages arrive while browsing, a glowing button appears at the top
Profile — Click "Profile" in sidebar to set username + avatar URL

Tech Stack

Frontend: Vanilla HTML5 + CSS3 + JavaScript (single file — no build tools)
Blockchain: PulseChain (Chain ID 369)
Wallet Library: ethers.js v5
Data Source: PulseScan API v2
Storage: IndexedDB (posts + profiles)
Theme: Custom dark neon cyberpunk UI

Project Structure
textpulse-underground/
├── index.html          # The entire application (copy-paste ready)
├── image1.jpeg         # Logo + default avatar
├── README.md
└── (future: assets/, separate JS when we scale)
Roadmap

 Media embeds (IPFS hashes in transaction data)
 Reply threading (reference previous txHash)
 On-chain profile registry (optional contract)
 Mobile PWA + offline support
 Channel discovery & active rooms list
 DAO control over Main Channel address
 Multi-language support

Contributing
This is a rebellion. All freedom fighters welcome.

Fork the repo
Create your feature branch (git checkout -b feature/legendary-idea)
Commit (git commit -m 'Drop the fire')
Push & open a Pull Request

Big love to every dev who helps scar the stars with light.
License
Unlicense — This project belongs to humanity. Do whatever the fuck you want with it.

Built with blood, code, and pure PulseChain fire.
The Pulse Underground — Where free speech still lives.
No kings. No servers. No censorship.
Made for the people, by the people, on the chain that never sleeps.
