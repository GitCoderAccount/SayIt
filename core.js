'use strict';
const ethers = window.ethers;

/* ── Constants ────────────────────────────────────────────────────────── */
const MAIN_CHANNEL   = '0x0000000000000000000000000000000000000369'; /* PulseChain burn address */
const PULSE_CHAIN_ID = 369;
const REPLY_PREFIX   = 'REPLY_TO:';
const PROFILE_PREFIX = 'PROFILE_DATA:';
/* MAX_PREVIEW: chars shown before "Show more" truncation in feed */
const MAX_PREVIEW    = 500;
/* POSTS_TARGET: stop fetching once we've added this many new posts in one
   pagination pass. Higher = denser scroll, more API calls. */
const POSTS_TARGET   = 20;
/* MAX_PAGES: hard cap on API pages scanned per fetchPosts() call. Each
   page = 50 txs, so 40 pages = 2000 txs max. Beyond this, the user gets
   a manual "Load more" button to continue. */
const MAX_PAGES      = 40;
const POLL_FIRST_MS  = 30_000;
const POLL_MS        = 120_000;
const DRAFT_KEY      = 'sayitDraft';
const PRUNE_KEY      = 'sayitLastPrune';
const LAST_CHECK_KEY = 'sayitLastCheck';
const DISCLAIMER_KEY = 'sayitDisclaimerAck'; /* '1' once the user has acknowledged */
const OFFICIAL_CHANNEL  = '0x0000000000000000000000000000000000000001'; /* placeholder — update with real address */
const LIKE_PREFIX       = 'LIKE:';
const UNLIKE_PREFIX     = 'UNLIKE:';
const BOOKMARK_PREFIX   = 'BOOKMARK:';
const UNBOOKMARK_PREFIX = 'UNBOOKMARK:';
const FOLLOW_PREFIX     = 'FOLLOW:';
const UNFOLLOW_PREFIX   = 'UNFOLLOW:';
const POLL_PREFIX       = 'POLL:';   /* POLL:{json}\n\nQuestion text */
const VOTE_PREFIX       = 'VOTE:';   /* VOTE:0xpollhash:optionIndex */
const NOTE_PREFIX       = 'NOTE:';     /* NOTE:0xposthash\n\nnote text (community note) */
const NOTERATE_PREFIX   = 'NOTERATE:'; /* NOTERATE:0xnotehash:h|n (helpful/not, last-wins) */
const TOKEN_PROFILE_PREFIX = 'PROFILE_FOR:'; /* PROFILE_FOR:0xtoken\n\n{json} — set a token channel's profile; only honored from the token's deployer or current owner() */
const NOTE_SHOW_THRESHOLD = 2;         /* net helpful (helpful − not) to graduate to "context" */
const PROFILE_INIT_PAGES  = 4;         /* pages scanned for the FIRST profile paint; rest streams on scroll */
const SETTINGS_KEY    = 'sayitSettings';
const MUTE_KEY        = 'sayitMuted';   /* JSON array of muted addresses */
const LISTS_KEY       = 'sayitLists';       /* JSON array of {id,name,members[]} */
const COMMUNITIES_KEY = 'sayitCommunities'; /* JSON array of {address,name,desc,joined} */
/* On-chain sync: a single self-tx publishes a snapshot of all lists +
   joined communities as JSON. Scanning the user's own outbox for the latest
   LC_SYNC restores them on any device. One tx per publish (not per edit) —
   keeps gas reasonable while making the data portable + publicly visible. */
const LC_SYNC_PREFIX  = 'LC_SYNC:';
const TIP_PREFIX      = 'TIP:';     /* TIP:0x<posthash> — tx VALUE carries the tip, sent to the post author */
const SPACE_PREFIX    = 'SPACE:';   /* SPACE:{"r":roomId,"s":startsMs}\n\n<title> — live audio room announcement */
const SPACE_END_PREFIX = 'SPACE_END:'; /* SPACE_END:0x<spacehash> — the host ends a Space (honored only from the Space's author) */
/* Pinned post — sent to SELF (like bookmarks). PIN:0x<posthash> marks one of
   your own posts to surface atop your profile's Posts tab; UNPIN:0x<posthash>
   clears it. Last action wins (composite block/tx order), so re-pinning a new
   post supersedes the old one. UNPIN_PREFIX must be checked before PIN_PREFIX —
   prefix collision ('UNPIN:' starts with neither, but ordering kept explicit). */
const PIN_PREFIX   = 'PIN:';
const UNPIN_PREFIX = 'UNPIN:';
/* Encrypted DMs. DMKEY1: publishes a user's public identity-key bundle
   (X25519 + ML-KEM-768) once, so others can message them; DM1: carries one
   hybrid-encrypted message (see DMCrypto below). Both are recognized by the
   message/notification parsers so the raw blobs never render as plaintext. */
const DMKEY_PREFIX = 'DMKEY1:';
const DM_PREFIX    = 'DM1:';
/* Fixed, deterministic message the wallet signs to derive the user's DM
   identity keys. The signature never leaves the browser; keys are derived from
   it (DMCrypto.deriveKeys) and re-derived each session. */
const DM_SIGN_MESSAGE = 'Say It DeFi — derive my encrypted-DM keys (v1).\n\nThis signature stays in your browser and never authorizes a transaction. Only sign it on sayitdefi.com.';
const CHANNELS_KEY    = 'sayitChannelsScan';
const SPACE_ENDS_KEY  = 'sayitSpaceEnds';   /* JSON { "<spaceTxHash>": "<senderAddr>" } — persisted SPACE_END markers (capped ~200) */
const ACTIVE_SPACE_KEY = 'sayitActiveSpace'; /* JSON {txHash,roomId,title,startsMs,channel,ts} — host's own live Space, for the rejoin banner */

/* ── Multichain registry ──────────────────────────────────────────────────
   SayIt's protocol is chain-agnostic: a post is just a transaction whose
   `input` carries a UTF-8 payload, so the SAME protocol works on any EVM
   chain (and the user's address is identical across them — one identity
   everywhere). This registry is the single source of truth for every
   supported chain: its explorer API (reads), RPC + native currency (wallet
   add/switch), display badge, and whether it's cheap enough to host the
   social/engagement layer.

   PulseChain (369) is CANONICAL: enabled, the default chain, and the default
   social chain. Other chains are defined but `enabled:false` until the
   multichain feature ships — Settings (or flipping `enabled`) turns them on.
   Reads aggregate across enabled chains; a write happens on its post's chain.

   `explorer.type` selects the read adapter (see explorerTxlistUrl):
     - 'blockscout'   legacy etherscan-compatible txlist; no chainid/apikey
     - 'etherscan-v2' unified api.etherscan.io/v2 — adds &chainid=N&apikey=KEY
   One Etherscan v2 key covers ETH/Base/BSC/etc; PulseChain needs no key.

   `social:true` marks a chain cheap enough to carry ported engagement
   (likes/follows/reposts) for users who don't want to spend on an expensive
   chain — the user picks WHICH social chain in Settings (default 369). */
const CHAINS = {
  369: {
    id: 369, hex: '0x171', name: 'PulseChain', short: 'PLS', badge: 'PLS',
    color: '#7c4dff',
    nativeCurrency: { name: 'Pulse', symbol: 'PLS', decimals: 18 },
    /* `tx` overrides the per-tx link base (default web + '/tx/'). PulseChain
       keeps OtterScan for tx links — the long-standing choice for SayIt. */
    explorer: { type: 'blockscout', name: 'OtterScan', api: 'https://api.scan.pulsechain.com/api', web: 'https://scan.pulsechain.com', tx: 'https://otter.pulsechain.com/tx/' },
    rpcUrls: ['https://rpc.pulsechain.com'],
    canonical: true, social: true, enabled: true,
  },
  1: {
    id: 1, hex: '0x1', name: 'Ethereum', short: 'ETH', badge: 'ETH',
    color: '#627eea',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorer: { type: 'etherscan-v2', name: 'Etherscan', api: 'https://api.etherscan.io/v2/api', web: 'https://etherscan.io' },
    rpcUrls: ['https://eth.llamarpc.com'],
    /* L1 gas is too high for cheap engagement — port likes/follows off it to
       the user's chosen social chain (see engagement routing). */
    social: false, enabled: false,
  },
  8453: {
    id: 8453, hex: '0x2105', name: 'Base', short: 'BASE', badge: 'BASE',
    color: '#0052ff',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorer: { type: 'etherscan-v2', name: 'BaseScan', api: 'https://api.etherscan.io/v2/api', web: 'https://basescan.org' },
    rpcUrls: ['https://mainnet.base.org'],
    social: true, enabled: false, /* cheap L2 — a good social/engagement chain */
  },
  56: {
    id: 56, hex: '0x38', name: 'BNB Smart Chain', short: 'BSC', badge: 'BSC',
    color: '#f0b90b',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    explorer: { type: 'etherscan-v2', name: 'BscScan', api: 'https://api.etherscan.io/v2/api', web: 'https://bscscan.com' },
    rpcUrls: ['https://bsc-dataseed.binance.org'],
    social: true, enabled: false,
  },
};
/* The default + canonical social chain. Everything that doesn't yet specify a
   chain (existing single-chain call sites) resolves here, so the registry is a
   no-op until multichain reads/writes are wired on. */
const CANONICAL_CHAIN_ID = PULSE_CHAIN_ID;

/* chainCfg(id): registry entry for a chainId (number or numeric string), or
   undefined if the chain is unknown (e.g. a post fetched from a chain we don't
   list). Callers must tolerate undefined and fall back to display defaults. */
function chainCfg(id) { return CHAINS[Number(id)]; }

/* chainList({ enabledOnly, socialOnly }): registry entries as an array. */
function chainList(opts = {}) {
  let arr = Object.values(CHAINS);
  if (opts.enabledOnly) arr = arr.filter(c => c.enabled);
  if (opts.socialOnly)  arr = arr.filter(c => c.social);
  return arr;
}

/* Safe display lookups — never throw on an unknown chain. */
function chainName(id)  { return chainCfg(id)?.name  || `Chain ${Number(id)}`; }
function chainBadge(id) { return chainCfg(id)?.badge || `#${Number(id)}`; }
function chainColor(id) { return chainCfg(id)?.color || '#71767b'; }

/* txUrl(chainId, hash): the explorer "view transaction" link for a post's
   chain. Uses the chain's explorer.tx base if set, else web + '/tx/'. Unknown
   chains fall back to the canonical chain so a link is always produced. */
function txUrl(chainId, hash) {
  const cfg = chainCfg(chainId) || CHAINS[CANONICAL_CHAIN_ID];
  const base = cfg.explorer.tx || (cfg.explorer.web + '/tx/');
  return base + hash;
}

/* explorerTxlistUrl(cfg, address, page, opts): build the account-txlist URL for
   one chain, applying its explorer adapter. Blockscout (PulseScan) and the
   Etherscan-v2 unified API share the `module=account&action=txlist` shape; v2
   only prepends &chainid=N and appends &apikey=KEY. Keeping the query identical
   for Blockscout means this is byte-for-byte the legacy PulseChain request.
   opts: { offset=50, sort='desc', apiBase (override cfg.explorer.api with a
   user-configured endpoint), apiKey }. */
function explorerTxlistUrl(cfg, address, page, opts = {}) {
  const base   = opts.apiBase || cfg.explorer.api;
  const offset = opts.offset != null ? opts.offset : 50;
  const sort   = opts.sort || 'desc';
  let qs = `?module=account&action=txlist&address=${address}&offset=${offset}&page=${page}&sort=${sort}`;
  if (cfg.explorer.type === 'etherscan-v2') {
    qs = `?chainid=${cfg.id}&` + qs.slice(1);
    if (opts.apiKey) qs += `&apikey=${encodeURIComponent(opts.apiKey)}`;
  }
  return base + qs;
}

/* Accent-color presets (Settings → Display). Each maps to the four CSS
   custom properties that drive the accent — primary, lighter primary, the
   translucent "dim" fill, the faint hover tint — plus the neon glow shadow.
   SOURCE OF TRUTH: a copy of this swatch table lives in boot.js (pre-paint,
   can't import) — keep the two in sync. 'purple' = the stylesheet default;
   selecting it (or having no setting) leaves the CSS :root values untouched. */
const ACCENT_COLORS = {
  purple: { name: 'Purple', rgb: '124,77,255', primary: '#7c4dff', lt: '#b388ff' },
  blue:   { name: 'Blue',   rgb: '29,155,240', primary: '#1d9bf0', lt: '#6cc5ff' },
  pink:   { name: 'Pink',   rgb: '249,24,128', primary: '#f91880', lt: '#ff6bab' },
  green:  { name: 'Green',  rgb: '0,186,124',  primary: '#00ba7c', lt: '#4fe3b0' },
  orange: { name: 'Orange', rgb: '255,122,0',  primary: '#ff7a00', lt: '#ffab57' },
};
/* Build the var→value map for an accent (shared shape with boot.js). */
function accentVars(key) {
  const a = ACCENT_COLORS[key];
  if (!a) return null;
  return {
    '--primary':     a.primary,
    '--primary-lt':  a.lt,
    '--primary-dim': `rgba(${a.rgb},0.15)`,
    '--primary-hov': `rgba(${a.rgb},0.08)`,
    '--neon':        `0 0 8px rgba(${a.rgb},0.5),0 0 20px rgba(${a.rgb},0.15)`,
  };
}

const ERC721_ABI = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

/* Linkify patterns — hoisted and compiled once. linkify() runs on every post
   render, so recreating these regexes/Set per call was wasted work. */
const _LK_RE         = /ipfs:\/\/\S+|ar:\/\/\S+|arweave:\/\/\S+|https?:\/\/[^\s<>"{}|\\^[\]`]+|#([a-zA-Z]\w{0,99})|@(0x[a-fA-F0-9]{40})/g;
/* In-body links to another SayIt post: full sayitdefi.com URL or a bare
   in-app #/post/0x<64hex> hash. The first match renders as a quote card and
   is stripped from the displayed body (X-style). Global so postHTML can
   replace ALL occurrences from the preview text. */
const _SAYIT_POST_RE = /(?:https?:\/\/)?(?:www\.)?sayitdefi\.com\/#\/post\/(0x[a-fA-F0-9]{64})|#\/post\/(0x[a-fA-F0-9]{64})/g;
const _LK_IMG_RE     = /\.(jpg|jpeg|png|gif|webp|svg|avif|tiff|bmp)(\?[^\s]*)?$/i;
const _LK_VID_RE     = /\.(mp4|webm|ogg|mov|m4v)(\?[^\s]*)?$/i;
const _LK_IMG_DOMAINS = /\/(ipfs|ipns)\//i;          /* IPFS gateways: .../ipfs/Qm... */
const _LK_IMG_HOSTS  = new Set([
  'pbs.twimg.com', 'ton.twimg.com',                  /* Twitter/X image CDN */
  'i.imgur.com', 'imgur.com',                        /* Imgur */
  'cdn.discordapp.com', 'media.discordapp.net',      /* Discord attachments */
  'media.tenor.com', 'c.tenor.com',                  /* Tenor GIFs */
  'media.giphy.com', 'i.giphy.com',                  /* Giphy */
  'media1.giphy.com', 'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com',
  'nftstorage.link', 'gateway.pinata.cloud',         /* IPFS gateways */
  'cloudflare-ipfs.com', 'dweb.link',
]);

/* ── Utils ────────────────────────────────────────────────────────────── */
const utils = {
  _t: null,
  toast(msg, ms = 3000) {
    /* Queue toasts so rapid-fire actions (like + repost) show both messages
       rather than the second one immediately stomping the first. */
    this._toastQueue = this._toastQueue || [];
    this._toastBusy  = this._toastBusy  || false;
    this._toastQueue.push({ msg, ms });
    if (!this._toastBusy) this._drainToastQueue();
  },
  _drainToastQueue() {
    if (!this._toastQueue?.length) { this._toastBusy = false; return; }
    this._toastBusy = true;
    const { msg, ms } = this._toastQueue.shift();
    const el = document.getElementById('toast');
    if (!el) { this._drainToastQueue(); return; }
    el.textContent = msg;
    el.style.display = 'block';
    /* After this toast, wait briefly then show the next (or hide). */
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      el.style.display = 'none';
      /* Short gap between queued toasts so the user sees the transition */
      setTimeout(() => this._drainToastQueue(), 200);
    }, ms);
  },
  loading(show, label = 'Publishing…') {
    document.getElementById('loading-overlay').classList.toggle('on', show);
    document.getElementById('loading-label').textContent = label;
  },
  /* ── Explorer-response validation (ingestion gate) ──────────────────────
     The block explorer API is an input, not an oracle: the endpoint is
     user-configurable and network-supplied, so a malicious or compromised
     explorer must not be able to inject scriptable values. tx.hash/from/to
     end up interpolated into inline-handler JS-string contexts where
     HTML-entity escaping is decoded away before the JS engine runs — their
     only real protection is strict shape validation here. Malformed numeric
     fields are stripped (not dropped) so downstream Number()/Date fallbacks
     engage instead of producing NaN. */
  isTxShape(tx) {
    if (!tx || typeof tx !== 'object') return false;
    if (!/^0x[0-9a-f]{64}$/i.test(tx.hash  || '')) return false;
    if (!/^0x[0-9a-f]{40}$/i.test(tx.from  || '')) return false;
    /* tx.to is null/'' for contract creation — allow; otherwise strict. */
    if (tx.to != null && tx.to !== '' && !/^0x[0-9a-f]{40}$/i.test(tx.to)) return false;
    return true;
  },
  _stripBadNumerics(tx) {
    if (tx.timeStamp   != null && !/^\d+$/.test(String(tx.timeStamp)))   delete tx.timeStamp;
    if (tx.blockNumber != null && !/^\d+$/.test(String(tx.blockNumber))) delete tx.blockNumber;
    return tx;
  },
  sanitizeTxs(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(tx => this.isTxShape(tx)).map(tx => this._stripBadNumerics(tx));
  },
  /* Extract the 11-char YouTube video id from any common URL form, or the
     numeric Vimeo id. Shared by linkify's media cards and quote-card
     previews. Returns null when the URL isn't a video link. */
  ytId(url) {
    try {
      const u = new URL(url);
      const h = u.hostname.replace(/^www\./, '');
      if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(h)) return null;
      let id = '';
      if (h === 'youtu.be')                       id = u.pathname.slice(1).split('/')[0];
      else if (u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2] || '';
      else if (u.pathname.startsWith('/embed/'))  id = u.pathname.split('/')[2] || '';
      else if (u.pathname.startsWith('/live/'))   id = u.pathname.split('/')[2] || '';
      else                                        id = u.searchParams.get('v') || '';
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    } catch { return null; }
  },
  vimeoId(url) {
    const m = String(url).match(/vimeo\.com\/(?:video\/)?(\d+)/i);
    return m ? m[1] : null;
  },
  /* Format a wei string as PLS for display (not financial math). */
  fmtPLS(wei) {
    const n = Number(wei || 0) / 1e18;
    if (!isFinite(n) || n <= 0) return '0';
    if (n >= 1000) return Math.round(n).toLocaleString();
    return n.toLocaleString(undefined, { maximumSignificantDigits: 4 });
  },
  safe(str) {
    /* Escapes for BOTH text and attribute contexts. The old textContent→
       innerHTML trick does NOT escape quotes (HTML text-node serialization
       never does), so any value interpolated into a "..." attribute — e.g.
       <img src="${safe(picUrl)}"> — could close the attribute with a " and
       inject an event handler. picUrl/website/etc. are attacker-controlled
       on-chain data, so escaping quotes here is what blocks that XSS. */
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },
  linkify(text, fullText) {
    /* fullText = complete post text for image extraction (ignores MAX_PREVIEW truncation)
       text     = possibly truncated text for body rendering */
    /* Cheap aliases to the module-level compiled patterns (see _LK_* above). */
    const re = _LK_RE, imgRe = _LK_IMG_RE, vidRe = _LK_VID_RE,
          imgDomains = _LK_IMG_DOMAINS, imgHosts = _LK_IMG_HOSTS;
    const isMediaUrl = url => {
      if (imgRe.test(url)) return 'img';
      if (vidRe.test(url)) return 'vid';
      if (imgDomains.test(url)) return 'img';    /* IPFS gateway path */
      if (url.includes('arweave.net/')) return 'img';
      try {
        const host = new URL(url).hostname;
        if (imgHosts.has(host)) return 'img';
        /* YouTube / Vimeo — embedded as click-to-play facades (can't autoplay) */
        if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(host) && ytId(url)) return 'youtube';
        if (/(^|\.)vimeo\.com$/i.test(host) && vimeoId(url)) return 'vimeo';
      } catch { /* invalid URL — skip */ }
      if (xPost(url)) return 'tweet';   /* X / Twitter post → styled link card */
      if (grokPost(url)) return 'grok'; /* Grok (grok.com) → click-out link card */
      return null;
    };
    const resolveUrl = u => {
      if (u.startsWith('ipfs://'))    return 'https://ipfs.io/ipfs/' + u.slice(7);
      if (u.startsWith('ar://'))      return 'https://arweave.net/' + u.slice(5);
      if (u.startsWith('arweave://')) return 'https://arweave.net/' + u.slice(10);
      return u;
    };
    /* Extract the 11-char YouTube video ID from any common URL form
       (watch?v=, youtu.be/, /embed/, /shorts/). Returns null if not found. */
    const ytId = url => {
      try {
        const u = new URL(url);
        const h = u.hostname.replace(/^www\./, '');
        let id = '';
        if (h === 'youtu.be')               id = u.pathname.slice(1).split('/')[0];
        else if (u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2] || '';
        else if (u.pathname.startsWith('/embed/'))  id = u.pathname.split('/')[2] || '';
        else if (u.pathname.startsWith('/live/'))   id = u.pathname.split('/')[2] || '';
        else                                id = u.searchParams.get('v') || '';
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
      } catch { return null; }
    };
    /* Extract the numeric Vimeo video ID. Returns null if not found. */
    const vimeoId = url => {
      const m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
      return m ? m[1] : null;
    };
    /* Parse an X/Twitter post URL → { handle, id } or null. Only matches
       real status URLs (x.com/<handle>/status/<id>); anything else (profiles,
       search, etc.) falls through to a plain link. No third-party script is
       loaded — we render our own styled card that links out to X. */
    const xPost = url => {
      try {
        const u = new URL(url);
        const h = u.hostname.replace(/^(www|mobile|m)\./, '');
        if (h !== 'x.com' && h !== 'twitter.com') return null;
        const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/);
        return m ? { handle: m[1], id: m[2] } : null;
      } catch { return null; }
    };
    /* Parse a Grok URL (grok.com / x.ai) → { kind, href } or null. Grok pages
       send X-Frame-Options: DENY (frame-ancestors only x.com), so they CANNOT
       be embedded in an iframe by us — and the URL is a web page, not a direct
       media file, so there's nothing to play inline. We render our own styled
       click-out card (canonical link, tracking params dropped) that opens Grok
       in a new tab — the closest we can faithfully show. */
    const grokPost = url => {
      try {
        const u = new URL(url);
        const h = u.hostname.replace(/^www\./, '');
        if (h !== 'grok.com' && h !== 'x.ai') return null;
        const m = u.pathname.match(/^\/(imagine|share|chat)(?:\/|$)/);
        if (!m) return null;
        return { kind: m[1], href: u.origin + u.pathname };
      } catch { return null; }
    };

    /* ── Pass 1: extract ALL media from fullText (never truncated) ── */
    const scanText = fullText || text;
    let imgHtml = '', embedHtml = '', mediaCount = 0;
    const mediaUrls = new Set(); /* dedup */
    let mScan;
    re.lastIndex = 0;
    while ((mScan = re.exec(scanText)) !== null && mediaCount < 4) {
      const raw = mScan[0];
      if (!raw.startsWith('http') && !raw.startsWith('ipfs://') &&
          !raw.startsWith('ar://') && !raw.startsWith('arweave://')) continue;
      const resolved = resolveUrl(raw);
      if (mediaUrls.has(resolved)) continue;
      const mtype = isMediaUrl(resolved);
      if (mtype === 'img') {
        mediaUrls.add(resolved);
        const safeR = utils.safe(resolved);
        const safeRaw = utils.safe(raw);
        imgHtml += `<img src="${safeR}" class="post-img-thumb" alt="image"
          loading="lazy" data-fallback="hide"
          data-href="${safeR}" title="Right-click to copy URL"
          data-raw-url="${safeRaw}">`;
        mediaCount++;
      } else if (mtype === 'vid') {
        mediaUrls.add(resolved);
        const safeR = utils.safe(resolved);
        imgHtml += `<div class="post-vid-wrap">
          <video src="${safeR}" class="post-vid-thumb"
            autoplay muted loop playsinline preload="auto"
            data-fallback="hide-wrap"></video>
          <button class="vid-unmute-btn" title="Tap to unmute"
            >🔇</button>
        </div>`;
        mediaCount++;
      } else if (mtype === 'youtube') {
        const vid = ytId(resolved);
        if (vid) {
          mediaUrls.add(resolved);
          const safeVid = utils.safe(vid);
          /* Thumbnail + play button — iframe loads on click (faster, avoids
             Google tracking before user interaction, and works in feed context
             where autoplay is blocked by browser sandbox). */
          const thumbOk = (typeof pulse !== 'undefined') && pulse._embedThumbsAllowed && pulse._embedThumbsAllowed();
          imgHtml += `<div class="post-vid-wrap post-yt-facade${thumbOk ? '' : ' yt-facade-private'}" data-yt-id="${safeVid}">
            ${thumbOk ? `<img src="https://i.ytimg.com/vi/${safeVid}/hqdefault.jpg"
              class="post-yt-thumb" alt="YouTube video" loading="lazy"
              data-fallback-src="https://i.ytimg.com/vi/${safeVid}/default.jpg">`
            : `<div class="post-yt-private-label">▶ YouTube video<span>Tap to load — connects to YouTube</span></div>`}
            <div class="post-yt-play">
              <svg viewBox="0 0 68 48" width="68" height="48">
                <path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="#f00"/>
                <path d="M45 24 27 14v20" fill="#fff"/>
              </svg>
            </div>
          </div>`;
          mediaCount++;
        }
      } else if (mtype === 'vimeo') {
        const vid = vimeoId(resolved);
        if (vid) {
          mediaUrls.add(resolved);
          const safeVid = utils.safe(vid);
          /* Facade: thumbnail from vumbnail.com + branded play button.
             Clicking loads the real iframe with autoplay — same pattern as YouTube. */
          imgHtml += `<div class="post-vid-wrap post-yt-facade post-vimeo-facade" data-vimeo-id="${safeVid}">
            <img src="https://vumbnail.com/${safeVid}.jpg"
              class="post-yt-thumb" alt="Vimeo video" loading="lazy"
              data-fallback="hide">
            <div class="post-yt-play post-vimeo-play">
              <svg viewBox="0 0 68 48" width="68" height="48">
                <rect width="68" height="48" rx="8" fill="#1AB7EA" opacity="0.9"/>
                <path d="M45 24 27 14v20" fill="#fff"/>
              </svg>
            </div>
          </div>`;
          mediaCount++;
        }
      } else if (mtype === 'tweet') {
        const tw = xPost(resolved);
        if (tw) {
          mediaUrls.add(resolved);
          /* Canonical URL (drops tracking params); handle is [A-Za-z0-9_] only. */
          const href = `https://x.com/${tw.handle}/status/${tw.id}`;
          const safeHandle = utils.safe(tw.handle);
          const safeId = utils.safe(tw.id);
          /* Click-to-load X embed facade: nothing contacts X until the user
             taps. On tap (with embeds allowed) we swap in X's own iframe
             embed — it renders the full post incl. video, and X's runtime
             runs INSIDE that sandboxed third-party iframe, so our page CSP
             stays strict (only frame-src lists platform.twitter.com) and no
             X script touches our origin. In strict privacy mode the tap
             opens X in a new tab instead. */
          embedHtml += `<div class="x-embed-card x-embed-facade" data-x-id="${safeId}" data-x-href="${utils.safe(href)}" role="button" tabindex="0">
            <span class="x-embed-hdr">
              <svg class="x-embed-logo" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              <span class="x-embed-title">Post on X</span>
            </span>
            <span class="x-embed-handle">@${safeHandle}</span>
            <span class="x-embed-cta">▶ Tap to load this post (text, images &amp; video)</span>
          </div>`;
          mediaCount++;
        }
      } else if (mtype === 'grok') {
        const gk = grokPost(resolved);
        if (gk) {
          mediaUrls.add(resolved);
          /* Grok can't be iframed (X-Frame-Options: DENY) and the URL isn't a
             direct media file, so this is a click-out card, not an inline
             player — opens Grok in a new tab. */
          const href = utils.safe(gk.href);
          const label = gk.kind === 'imagine' ? 'Grok Imagine' : 'Grok';
          const sub = gk.kind === 'imagine' ? 'Image &amp; video on Grok' : 'View on Grok';
          embedHtml += `<a class="grok-card" href="${href}" target="_blank" rel="noopener noreferrer">
            <span class="grok-card-logo" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2.5l2.6 6.9L21.5 12l-6.9 2.6L12 21.5l-2.6-6.9L2.5 12l6.9-2.6z"/></svg>
            </span>
            <span class="grok-card-body">
              <span class="grok-card-title">${label}</span>
              <span class="grok-card-sub">${sub}</span>
            </span>
            <span class="grok-card-cta">Open ↗</span>
          </a>`;
          mediaCount++;
        }
      }
    }

    /* ── Pass 2: render body text (may be truncated), suppressing media URLs ── */
    let result = '', last = 0;
    re.lastIndex = 0;
    while ((mScan = re.exec(text)) !== null) {
      result += utils.safe(text.slice(last, mScan.index)).replace(/\n/g, '<br>');
      last = mScan.index + mScan[0].length;
      const raw = mScan[0];
      if (mScan[1]) {
        /* hashtag */
        result += `<span class="post-tag" role="button" tabindex="0" data-tag="${utils.safe(mScan[1])}">#${utils.safe(mScan[1])}</span>`;
      } else if (mScan[2]) {
        /* @address mention */
        const addr = mScan[2].toLowerCase();
        result += `<span class="post-mention" role="button" tabindex="0" data-addr="${utils.safe(addr)}">@${utils.safe(addr.slice(0,6)+'…'+addr.slice(-4))}</span>`;
      } else {
        /* URL — suppress if it's a media URL we're already rendering as image/video */
        const resolved = resolveUrl(raw);
        if (mediaUrls.has(resolved)) {
          /* Suppressed — shown as inline media instead */
        } else {
          const display = raw.length > 50 ? raw.slice(0, 47) + '…' : raw;
          result += `<a href="${utils.safe(resolved)}" target="_blank" rel="noopener noreferrer"
            class="post-link">${utils.safe(display)}</a>`;
        }
      }
    }
    result += utils.safe(text.slice(last)).replace(/\n/g, '<br>');
    return { text: result, images: imgHtml, embeds: embedHtml };
  },
  resolveIPFS(uri) {
    if (!uri) return null;
    if (uri.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + uri.slice(7);
    return uri;
  },
  /* Defensive URL validation. Returns the URL if safe to render in an
     <a href>, <img src>, or similar context, otherwise returns ''.
     Blocks javascript:, data:, vbscript:, file:, and any other scheme
     not in the allowlist. Critical: chain data is attacker-controlled
     and CAN contain javascript: URIs that bypass client-side validation.
     Allowed schemes: http, https, ipfs, ar, arweave, mailto. */
  safeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const s = url.trim();
    if (!s) return '';
    /* Schemeless URLs (no colon before first /) are fine — treated as relative */
    const colonIdx = s.indexOf(':');
    const slashIdx = s.indexOf('/');
    if (colonIdx === -1 || (slashIdx !== -1 && slashIdx < colonIdx)) return s;
    /* Lowercase the scheme for comparison, strip control chars/whitespace
       that some browsers tolerate before the colon. */
    const scheme = s.slice(0, colonIdx).toLowerCase().replace(/[\s\x00-\x1f]/g, '');
    const allowed = new Set(['http', 'https', 'ipfs', 'ar', 'arweave', 'mailto']);
    return allowed.has(scheme) ? s : '';
  },
  /* Escape a URL for safe interpolation inside a CSS url('...') value.
     CSS-escapes single quotes, backslashes, newlines, and control chars
     that could break out of the url() and inject CSS declarations.
     Returns '' if the URL fails safeUrl validation. */
  cssUrlValue(url) {
    const safe = this.safeUrl(url);
    if (!safe) return '';
    return safe.replace(/[\\\n\r\f'"]/g, c => '\\' + c.charCodeAt(0).toString(16) + ' ');
  },
  debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  },
  /* throttle: fires at most once per `ms`. Used for scroll-style events
     where you want continuous updates during the action, not just a final
     trailing call. The trailing setTimeout guarantees the LAST event is
     processed even if it lands inside the cooldown window. */
  throttle(fn, ms) {
    let last = 0, pending = null;
    return (...a) => {
      const now = Date.now();
      const remaining = ms - (now - last);
      if (remaining <= 0) {
        if (pending) { clearTimeout(pending); pending = null; }
        last = now;
        fn(...a);
      } else if (!pending) {
        pending = setTimeout(() => {
          last = Date.now();
          pending = null;
          fn(...a);
        }, remaining);
      }
    };
  },
  autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 400) + 'px';
  },
  /* Check if an img URL is too large to render safely.
     Loads a test Image element and checks naturalWidth*naturalHeight*4 bytes.
     Returns true if safe, false if oversized. Timeout: 5s. */
  async checkImageSize(url, maxBytes = 8_000_000) {
    return new Promise(resolve => {
      const img = new Image();
      const timer = setTimeout(() => { img.src = ''; resolve(true); }, 5000);
      img.onload = () => {
        clearTimeout(timer);
        const bytes = img.naturalWidth * img.naturalHeight * 4;
        resolve(bytes <= maxBytes);
      };
      img.onerror = () => { clearTimeout(timer); resolve(true); };
      img.src = url;
    });
  },
  copyToClipboard(text, label = 'Copied!') {
    navigator.clipboard?.writeText(text).then(() => this.toast(label)).catch(() => this.toast('Copy failed'));
  },
  /* Safe localStorage wrapper — silently no-ops on quota errors,
     private-mode blocks, or other write failures. Returns true on success,
     false on failure. Callers that care can branch on the return. */
  safeLS: {
    set(key, val) {
      try { localStorage.setItem(key, val); return true; }
      catch { return false; }
    },
    get(key, fallback = null) {
      try { return localStorage.getItem(key) ?? fallback; }
      catch { return fallback; }
    },
    remove(key) {
      try { localStorage.removeItem(key); return true; }
      catch { return false; }
    },
  },
  updateCharCount(el, countEl) {
    const n   = el.value.length;
    const max = 62.83;
    /* The ring belongs to the HOME composer — don't let the modal/thread
       composers (which pass their own countEl) drive it. */
    if (el.id === 'compose-text') {
      const ring = document.getElementById('char-ring');
      const fg   = document.getElementById('cr-fg');
      const num  = document.getElementById('char-count-num');
      if (ring && fg) {
        ring.style.display = n > 0 ? 'flex' : 'none';   /* hide until typing (X-style) */
        /* There's no hard character limit (long-form posts are intended), so
           the ring is a soft length hint that tops out — not an "over the
           limit" warning. Show the real count, never a red "over" state. */
        const pct = Math.min(n / 1000, 1);
        fg.setAttribute('stroke-dasharray', `${pct * max} ${max}`);
        ring.className = 'char-ring ' + (n > 700 ? 'warn' : n > 280 ? 'note' : 'ok');
        if (num) num.textContent = n > 280 ? n.toLocaleString() : '';
      }
    }
    if (countEl && countEl !== document.getElementById('char-ring')) {
      countEl.textContent = n > 0 ? n.toLocaleString() : '';
    }
  },
};


/* ── SpaceRTC: serverless WebRTC audio mesh ───────────────────────────
   Signaling rides public WebTorrent trackers (the browser-torrent
   WebSocket protocol): we "announce" the room id as an info_hash with
   WebRTC offers attached; the tracker forwards offers to other peers on
   the same hash and routes their answers back. ICE is non-trickle (we
   wait for gathering, then ship one complete SDP) which keeps the
   protocol to exactly announce → offer → answer. Mesh topology: every
   peer offers to the room; fine for ≤8 participants (phase-1 limit). */
class SpaceRTC {
  static TRACKERS = [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.btorrent.xyz',
  ];
  static ICE = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };

  constructor(roomId, micStream, { role, host, ice, onStatus, onPeers, onCtl, onPeerGone, onListeners, onNoRelay, onSpeaking } = {}) {
    /* info_hash must be exactly 20 bytes; roomId is 16 bytes hex → pad.
       Speakers mesh on the main hash; listeners meet the host on a second
       hash (LIST pad) where the host fans out one mixed stream each. */
    this.hash = SpaceRTC.roomHash(roomId);
    this.listHash = SpaceRTC.listenerHash(roomId);
    this.role = role === 'listener' ? 'listener' : 'speaker';
    this.isHost = !!host;
    this.peerId = [...crypto.getRandomValues(new Uint8Array(20))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    this.mic = micStream || null; /* listeners have no mic */
    this.onStatus = onStatus || (() => {});
    this.onPeers = onPeers || (() => {});
    this.onCtl = onCtl || (() => {});         /* (label, msg) — control message from a peer */
    this.onPeerGone = onPeerGone || (() => {});
    this.onListeners = onListeners || (() => {}); /* host: live listener count */
    this.onNoRelay = onNoRelay || (() => {}); /* relay-only mode but TURN gave no candidates */
    this.onSpeaking = onSpeaking || (() => {}); /* (Set<label>) — fires when the speaking set changes */
    this.speaking = new Set();    /* labels currently above the speaking threshold */
    this._anaCtx = null;          /* lazy AudioContext for level analysis */
    this._analysers = new Map();  /* label → {analyser, data} */
    this.ice = ice || SpaceRTC.ICE;
    this.identity = null;                     /* {addr,name,ts,sig} sent on ctl open */
    this.sockets = [];
    this.pcs = new Map();       /* speaker mesh: remote peer_id → RTCPeerConnection */
    this.listeners = new Map(); /* host only: 'L:'+peer_id → RTCPeerConnection */
    this.audioEls = new Map();  /* label → <audio> */
    this.offers = new Map();    /* offer_id → RTCPeerConnection (ours, awaiting answer) */
    this.connectedToHost = false; /* listener: stop offering once the host answered */
    this.destroyed = false;
  }

  static LISTENER_CAP = 40; /* host upload ceiling for mixed-stream fan-out */

  /* 20-byte strings, binary-safe for the tracker JSON protocol. */
  static bin(hex) {
    let out = '';
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }

  static unbin(b) {
    return [...(b || '')].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  }

  static roomHash(roomId) {
    return (roomId + '00000000').slice(0, 40);
  }

  /* Listener-tier hash: same room, 'LIST' pad. */
  static listenerHash(roomId) {
    return (roomId + '4c495354').slice(0, 40);
  }

  /* Passive room liveness — ask the trackers how many peers are announced
     on each room's info_hash WITHOUT joining. Powers the "N here now"
     counts and empty-room ended detection on Space cards. Privacy: one
     WebSocket to the tracker (an infra host, like the explorer API) — no
     peer ever learns you looked.

     Trackers differ (verified live): btorrent answers `scrape` directly;
     openwebtorrent ignores scrape but a throwaway announce's reply carries
     self-inclusive complete/incomplete counts, deregistered on socket
     close. Scrape all trackers in parallel and merge by max — each tracker
     only sees the peers that reached it, so the max is the best estimate.
     Returns Map<roomId, peerCount> or null if no tracker answered. */
  static async probe(roomIds) {
    /* Count both tiers: speakers (main hash, everyone left:0) plus
       listeners (list hash, complete only — the host parks there with
       left:1 so it lands in `incomplete` and isn't double-counted). */
    const byHash = new Map();
    roomIds.forEach(r => {
      byHash.set(SpaceRTC.roomHash(r), { r, tier: 'main' });
      byHash.set(SpaceRTC.listenerHash(r), { r, tier: 'list' });
    });
    const tryTracker = url => new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(url); } catch { reject(new Error('dial')); return; }
      const fail = () => { try { ws.close(); } catch { /* closing */ } reject(new Error('tracker')); };
      const timer = setTimeout(fail, 5000);
      ws.onerror = fail;
      const out = new Map();
      const announcedSeen = new Set();
      let announced = 0;
      ws.onopen = () => ws.send(JSON.stringify({
        action: 'scrape', info_hash: [...byHash.keys()].map(h => SpaceRTC.bin(h)),
      }));
      ws.onmessage = e => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        const tally = (entry, complete, incomplete, probeSelf) => {
          /* main tier: everyone counts; list tier: complete only (host is
             incomplete there). The throwaway announce-probe registers
             itself as complete — subtract it. */
          const n = entry.tier === 'main'
            ? complete + incomplete - probeSelf
            : complete - probeSelf;
          out.set(entry.r, (out.get(entry.r) || 0) + Math.max(0, n));
        };
        if (msg.action === 'scrape' && msg.files) {
          clearTimeout(timer);
          for (const [binHash, st] of Object.entries(msg.files)) {
            const entry = byHash.get(SpaceRTC.unbin(binHash));
            if (entry) tally(entry, Number(st?.complete) || 0, Number(st?.incomplete) || 0, 0);
          }
          try { ws.close(); } catch { /* done */ }
          resolve(out);
        } else if (msg.action === 'announce' && msg.info_hash && msg.complete !== undefined) {
          const entry = byHash.get(SpaceRTC.unbin(msg.info_hash));
          if (entry) tally(entry, Number(msg.complete) || 0, Number(msg.incomplete) || 0, 1);
          announcedSeen.add(SpaceRTC.unbin(msg.info_hash));
          if (announcedSeen.size >= announced) {
            clearTimeout(timer);
            try { ws.close(); } catch { /* done — closing also deregisters the probes */ }
            resolve(out);
          }
        }
      };
      /* No scrape answer after 2s → fall back to throwaway announces. */
      setTimeout(() => {
        if (ws.readyState !== 1 || out.size) return;
        for (const h of byHash.keys()) {
          announced++;
          ws.send(JSON.stringify({
            action: 'announce', info_hash: SpaceRTC.bin(h),
            peer_id: SpaceRTC.bin([...crypto.getRandomValues(new Uint8Array(20))]
              .map(b => b.toString(16).padStart(2, '0')).join('')),
            numwant: 0, uploaded: 0, downloaded: 0, left: 0, event: 'started', offers: [],
          }));
        }
      }, 2000);
    });
    const results = await Promise.allSettled(SpaceRTC.TRACKERS.map(tryTracker));
    let merged = null;
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      merged ||= new Map();
      for (const [roomId, n] of r.value) merged.set(roomId, Math.max(merged.get(roomId) || 0, n));
    }
    return merged;
  }

  /* ── Speaking detection ───────────────────────────────────────────────
     One shared AudioContext + a per-label AnalyserNode reading time-domain
     samples; a 300ms poll computes RMS deviation from the 128 midpoint and
     flips labels in/out of this.speaking, firing onSpeaking on change.
     Listeners send no audio, so 'L:' labels are never wired. */
  _wireAnalyser(label, stream) {
    if (!stream || label?.startsWith('L:') || this._analysers.has(label)) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this._anaCtx ||= new Ctx();
      this._anaCtx.resume?.().catch(() => { /* resumes on first gesture */ });
      const src = this._anaCtx.createMediaStreamSource(stream);
      const analyser = this._anaCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this._analysers.set(label, { analyser, src, data: new Uint8Array(analyser.fftSize) });
    } catch { /* stream without an audio track */ }
  }

  _dropAnalyser(label) {
    const a = this._analysers.get(label);
    if (a) { try { a.src.disconnect(); } catch { /* detached */ } this._analysers.delete(label); }
    if (this.speaking.delete(label)) this.onSpeaking(this.speaking);
  }

  _pollSpeaking() {
    const now = Date.now();
    this._spkLastLoud ||= new Map(); /* label → last ts above threshold */
    const next = new Set();
    for (const [label, { analyser, data }] of this._analysers) {
      /* Own mic muted (track disabled) → never speaking; also clear any hold. */
      if (label === 'me') {
        const t = this.mic?.getAudioTracks()[0];
        if (t && t.enabled === false) { this._spkLastLoud.delete(label); continue; }
      }
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const d = data[i] - 128; sum += d * d; }
      const rms = Math.sqrt(sum / data.length);
      if (rms > 4) this._spkLastLoud.set(label, now);
      /* Hold "speaking" for 600ms after the last loud sample so the ring
         doesn't flicker between syllables (X-style), and so a brief pip is
         reliably observable. */
      if (now - (this._spkLastLoud.get(label) || 0) < 600) next.add(label);
    }
    /* Only fire on a content change. */
    let changed = next.size !== this.speaking.size;
    if (!changed) { for (const l of next) if (!this.speaking.has(l)) { changed = true; break; } }
    if (changed) { this.speaking = next; this.onSpeaking(this.speaking); }
  }

  start() {
    this.onStatus('Connecting to signaling…');
    this._open = new Set();
    if (this.isHost) this._mixedStream(); /* ready before the first listener offer */
    if (this.mic) this._wireAnalyser('me', this.mic);
    this._spkInterval = setInterval(() => this._pollSpeaking(), 300);
    SpaceRTC.TRACKERS.forEach(url => this._dial(url, 0));
    /* re-announce periodically so late joiners find us */
    this._interval = setInterval(() => {
      this.sockets.forEach(ws => { if (ws.readyState === 1) this._announce(ws); });
    }, 50000);
    /* Listener offers reach the host probabilistically (the tracker hands
       each offer to a random peer on the hash), so retry briskly until the
       host answers. */
    if (this.role === 'listener') {
      this._listInterval = setInterval(() => {
        if (this.connectedToHost) { clearInterval(this._listInterval); return; }
        this.sockets.forEach(ws => { if (ws.readyState === 1) this._announce(ws); });
      }, 9000);
    }
    setTimeout(() => {
      if (!this.destroyed && this._open.size === 0) this.onStatus('✗ No signaling tracker reachable — try again later');
    }, 8000);
  }

  /* One tracker connection, self-healing. A down tracker logs a console
     line per attempt (browser-level, can't be suppressed), so back off
     exponentially and give up after a few tries while another tracker is
     carrying the room — but never stop retrying if we'd otherwise have
     no signaling at all. */
  _dial(url, attempt) {
    if (this.destroyed) return;
    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    this.sockets.push(ws);
    ws.onopen = () => {
      this._open.add(url);
      this.onStatus(`Looking for participants… (signaling ${this._open.size}/${SpaceRTC.TRACKERS.length})`);
      this._announce(ws);
    };
    ws.onmessage = e => this._onMessage(ws, e);
    ws.onerror = () => { /* close fires next; reconnect handled there */ };
    ws.onclose = () => {
      this._open.delete(url);
      this.sockets = this.sockets.filter(s => s !== ws);
      if (this.destroyed) return;
      if (attempt < 4 || this._open.size === 0) {
        setTimeout(() => this._dial(url, attempt + 1), Math.min(30000, 2000 * 2 ** attempt));
      }
    };
  }

  async _newPC(remoteLabel, { offerer, recvonly, sendStream } = {}) {
    const pc = new RTCPeerConnection(this.ice);
    /* The label is LIVE: a PC we created for an offer ('offer:<id>') is
       re-labeled to the remote's real peer_id when answered. Handlers read
       pc._label at fire time so audio elements and drops stay keyed
       consistently (fixed: drops used to miss the re-keyed audio el). */
    pc._label = remoteLabel;
    if (recvonly || !this.mic) {
      if (!sendStream) pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    if (sendStream) sendStream.getTracks().forEach(t => pc.addTrack(t, sendStream));
    else if (this.mic && !recvonly) this.mic.getTracks().forEach(t => pc.addTrack(t, this.mic));
    /* Per-peer 'ctl' data channel: identity claims + host controls. The
       offerer creates it; the answerer receives it via ondatachannel. */
    if (offerer) this._wireCtl(pc, pc.createDataChannel('ctl'));
    pc.ondatachannel = ev => { if (ev.channel.label === 'ctl') this._wireCtl(pc, ev.channel); };
    pc.ontrack = ev => {
      const label = pc._label;
      let el = this.audioEls.get(label);
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        el.style.display = 'none';
        document.body.appendChild(el);
        this.audioEls.set(label, el);
      }
      el.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      /* Host: feed every speaker's audio into the listener mix. (The
         stream must also be playing in an <audio> el — it is, above — or
         Chrome's WebAudio taps silence from remote streams.) */
      if (this.isHost) this._mixAdd(pc._label, el.srcObject);
      /* Speaking detection for this remote stream (listeners send none). */
      this._wireAnalyser(pc._label, el.srcObject);
      this._peersChanged();
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this._dropPeer(pc._label);
      } else if (pc.connectionState === 'connected') {
        this.onStatus('Live — connected');
        this._peersChanged();
      }
    };
    return pc;
  }

  _wireCtl(pc, ch) {
    pc._ctl = ch;
    ch.onopen = () => { if (this.identity) this._ctlSend(ch, { t: 'hi', ...this.identity }); };
    ch.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg && typeof msg.t === 'string') this.onCtl(pc._label, msg);
    };
  }

  _ctlSend(ch, msg) {
    if (ch?.readyState === 'open') {
      try { ch.send(JSON.stringify(msg)); } catch { /* racing close */ }
    }
  }

  broadcast(msg) {
    this.pcs.forEach(pc => this._ctlSend(pc._ctl, msg));
    this.listeners.forEach(pc => this._ctlSend(pc._ctl, msg));
  }

  broadcastListeners(msg) { this.listeners.forEach(pc => this._ctlSend(pc._ctl, msg)); }

  sendTo(label, msg) {
    this._ctlSend((this.pcs.get(label) || this.listeners.get(label))?._ctl, msg);
  }

  _gathered(pc) {
    return new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, 3000); /* don't hang on pathological NATs */
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); }
      });
    });
  }

  async _announce(ws) {
    if (this.role === 'listener') {
      /* Listener: recvonly offers on the listener hash; once the host has
         answered, keep announcing bare (stays in the live count). */
      const offers = this.connectedToHost ? [] : await this._makeOffers(6, { recvonly: true, tier: 'list' });
      this._send(ws, this.listHash, { left: 0, offers });
      return;
    }
    /* Speaker: mesh offers on the main hash. */
    const offers = await this._makeOffers(4, { tier: 'main' });
    this._send(ws, this.hash, { left: 0, offers });
    /* Host also sits on the listener hash (no offers — listeners offer to
       us) with left:1 so probes can tell host (incomplete) from listeners
       (complete) and count rooms cleanly. */
    if (this.isHost) this._send(ws, this.listHash, { left: 1, offers: [] });
  }

  _send(ws, hash, extra) {
    if (ws.readyState !== 1 || this.destroyed) return;
    ws.send(JSON.stringify({
      action: 'announce', info_hash: SpaceRTC.bin(hash), peer_id: SpaceRTC.bin(this.peerId),
      numwant: 8, uploaded: 0, downloaded: 0, event: 'started', ...extra,
    }));
  }

  async _makeOffers(n, { recvonly, tier }) {
    const offers = [];
    for (let i = 0; i < n; i++) {
      const id = [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, '0')).join('');
      const pc = await this._newPC('offer:' + id, { offerer: true, recvonly });
      pc._tier = tier;
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await this._gathered(pc);
      /* Relay-only mode sanity check: if the TURN server produced zero
         relay candidates our SDP is empty of routes — nobody could ever
         reach us. Surface it once instead of failing silently. */
      if (!this._relayChecked && this.ice.iceTransportPolicy === 'relay') {
        this._relayChecked = true;
        if (!/ typ relay/.test(pc.localDescription.sdp)) this.onNoRelay();
      }
      this.offers.set(id, pc);
      offers.push({ offer_id: SpaceRTC.bin(id), offer: { type: 'offer', sdp: pc.localDescription.sdp } });
    }
    return offers;
  }

  async _onMessage(ws, e) {
    if (this.destroyed) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    const hex = b => [...(b || '')].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    /* Someone answered one of our offers. */
    if (msg.answer && msg.offer_id) {
      const id = hex(msg.offer_id);
      const pc = this.offers.get(id);
      if (pc && !pc.currentRemoteDescription) {
        const remote = hex(msg.peer_id) || ('peer:' + id);
        this.offers.delete(id);
        pc._label = remote; /* re-key before media/ctl start flowing */
        this.pcs.set(remote, pc);
        if (pc._tier === 'list') {
          /* The host took one of our listener offers — stop offering and
             retire the rest. */
          this.connectedToHost = true;
          for (const [oid, opc] of [...this.offers]) {
            if (opc._tier === 'list') { this.offers.delete(oid); try { opc.close(); } catch { /* closing */ } }
          }
        }
        try { await pc.setRemoteDescription(msg.answer); } catch { this._dropPeer(remote); }
      }
      return;
    }
    /* Someone offered to us — answer it. */
    if (msg.offer && msg.offer_id) {
      const remote = hex(msg.peer_id);
      if (!remote || remote === this.peerId) return;
      const onList = hex(msg.info_hash) === this.listHash;
      if (onList) {
        /* Listener-tier offer: only the host answers, with the mixed
           speaker audio attached (one stream per listener). */
        if (!this.isHost || this.role === 'listener') return;
        if (this.listeners.size >= SpaceRTC.LISTENER_CAP) return;
        const label = 'L:' + remote;
        if (this.listeners.has(label)) return;
        const pc = await this._newPC(label, { sendStream: this._mixedStream() });
        this.listeners.set(label, pc);
        if (!(await this._answerVia(ws, pc, msg, this.listHash))) this._dropPeer(label);
        else this.onListeners(this.listeners.size);
        return;
      }
      if (this.role === 'listener' || this.pcs.has(remote)) return;
      const pc = await this._newPC(remote, {});
      this.pcs.set(remote, pc);
      if (!(await this._answerVia(ws, pc, msg, this.hash))) this._dropPeer(remote);
    }
  }

  async _answerVia(ws, pc, msg, hash) {
    try {
      await pc.setRemoteDescription(msg.offer);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await this._gathered(pc);
      if (ws.readyState === 1) ws.send(JSON.stringify({
        action: 'announce', info_hash: SpaceRTC.bin(hash), peer_id: SpaceRTC.bin(this.peerId),
        to_peer_id: msg.peer_id, offer_id: msg.offer_id,
        answer: { type: 'answer', sdp: pc.localDescription.sdp },
      }));
      return true;
    } catch { return false; }
  }

  _dropPeer(label) {
    const isList = label.startsWith('L:');
    const map = isList ? this.listeners : this.pcs;
    const pc = map.get(label);
    if (pc) { try { pc.close(); } catch { /* already closed */ } }
    const had = map.delete(label);
    const el = this.audioEls.get(label);
    if (el) { el.remove(); this.audioEls.delete(label); }
    this._mixRemove(label);
    this._dropAnalyser(label);
    if (isList) { if (had) this.onListeners(this.listeners.size); return; }
    this._peersChanged();
    if (had) this.onPeerGone(label);
  }

  /* ── Host listener-tier mix: one WebAudio graph blending the host mic
     with every speaker's stream; its output stream is what every listener
     receives (so listener count doesn't multiply mesh traffic). */
  _mixedStream() {
    if (this._mixDest) return this._mixDest.stream;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this._mixCtx = new Ctx();
    this._mixCtx.resume?.().catch(() => { /* resumes on first gesture */ });
    this._mixDest = this._mixCtx.createMediaStreamDestination();
    this._mixSrcs = new Map();
    if (this.mic) {
      const s = this._mixCtx.createMediaStreamSource(this.mic);
      s.connect(this._mixDest);
      this._mixSrcs.set('me', s);
    }
    return this._mixDest.stream;
  }

  _mixAdd(label, stream) {
    if (!this._mixDest || this._mixSrcs.has(label) || label.startsWith('L:')) return;
    try {
      const s = this._mixCtx.createMediaStreamSource(stream);
      s.connect(this._mixDest);
      this._mixSrcs.set(label, s);
    } catch { /* stream without audio track */ }
  }

  _mixRemove(label) {
    const s = this._mixSrcs?.get(label);
    if (s) { try { s.disconnect(); } catch { /* detached */ } this._mixSrcs.delete(label); }
  }

  _peersChanged() {
    const live = [...this.pcs.values()].filter(pc => pc.connectionState === 'connected').length;
    this.onPeers(live);
  }

  toggleMute() {
    const t = this.mic.getAudioTracks()[0];
    if (!t) return false;
    t.enabled = !t.enabled;
    return !t.enabled; /* true = now muted */
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this._interval);
    clearInterval(this._listInterval);
    clearInterval(this._spkInterval);
    this._analysers.forEach(a => { try { a.src.disconnect(); } catch { /* detached */ } });
    this._analysers.clear();
    this._anaCtx?.close().catch(() => { /* closing */ });
    this._anaCtx = null;
    this.speaking.clear();
    this._open?.clear();
    this.sockets.forEach(ws => { try { ws.close(); } catch { /* closing */ } });
    [...this.pcs.keys()].forEach(k => this._dropPeer(k));
    [...this.listeners.keys()].forEach(k => this._dropPeer(k));
    this.offers.forEach(pc => { try { pc.close(); } catch { /* closing */ } });
    this.offers.clear();
    this._mixCtx?.close().catch(() => { /* closing */ });
    this._mixCtx = this._mixDest = this._mixSrcs = null;
    this.mic?.getTracks().forEach(t => t.stop());
  }
}

/* ── DMCrypto: end-to-end encrypted direct messages ─────────────────────────
   Hybrid post-quantum scheme (so the permanent on-chain ciphertext stays safe
   even against a future quantum computer, defeating "harvest now, decrypt
   later"):

     key agreement = X25519  ⊕  ML-KEM-768   (broken only if BOTH fall)
     KDF           = HKDF-SHA256
     AEAD          = XChaCha20-Poly1305

   Identity keys are derived deterministically from a one-off wallet signature
   (never stored; re-derived per session). The transaction's `from` already
   proves the sender, so messages use an anonymous sealed box (fresh ephemeral
   X25519 key per message → sender-side forward secrecy); sender/recipient are
   bound into both the AEAD AAD and the plaintext to stop blob replay/spoofing.

   Primitives come from window.SAYIT_CRYPTO (vendored sayit-crypto.js — see
   CRYPTO_BUILD.md). Content is encrypted; on-chain METADATA (who↔who, when)
   is inherently public — callers must surface that to users. */
const DMCrypto = {
  X_PUB_LEN: 32, ML_PUB_LEN: 1184, KEM_CT_LEN: 1088, NONCE_LEN: 24, WRAP_LEN: 48, VER: 1,

  ready() { return typeof window !== 'undefined' && !!window.SAYIT_CRYPTO; },
  _c() {
    const c = (typeof window !== 'undefined') && window.SAYIT_CRYPTO;
    if (!c) throw new Error('Encryption library not loaded yet');
    return c;
  },
  _cat(...arrs) {
    const n = arrs.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(n);
    let i = 0; for (const a of arrs) { out.set(a, i); i += a.length; }
    return out;
  },
  _b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); },
  _unb64(b64) { const s = atob(b64); const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; },

  /* Deterministically derive this user's keypairs from a wallet signature
     string. Returns { xSecret, xPublic, mlSecret, mlPublic }. */
  deriveKeys(signature) {
    const C = this._c(); const te = new TextEncoder();
    const xSecret = C.sha512(this._cat(te.encode('SAYIT-DM-x25519-v1\n'), te.encode(signature))).slice(0, 32);
    const xPublic = C.x25519.getPublicKey(xSecret);
    const mlSeed  = C.sha512(this._cat(te.encode('SAYIT-DM-mlkem-v1\n'), te.encode(signature))); /* 64 bytes */
    const ml      = C.ml_kem768.keygen(mlSeed);
    return { xSecret, xPublic, mlSecret: ml.secretKey, mlPublic: ml.publicKey };
  },

  /* The DMKEY1: payload others read to message you (X25519 + ML-KEM public). */
  packIdentityKey(keys) {
    return DMKEY_PREFIX + this._b64(this._cat(new Uint8Array([this.VER]), keys.xPublic, keys.mlPublic));
  },
  parseIdentityKey(payload) {
    if (typeof payload !== 'string' || !payload.startsWith(DMKEY_PREFIX)) return null;
    let raw; try { raw = this._unb64(payload.slice(DMKEY_PREFIX.length)); } catch { return null; }
    if (raw.length !== 1 + this.X_PUB_LEN + this.ML_PUB_LEN || raw[0] !== this.VER) return null;
    return { xPublic: raw.slice(1, 1 + this.X_PUB_LEN), mlPublic: raw.slice(1 + this.X_PUB_LEN) };
  },

  /* KEK for the recipient: hybrid X25519+ML-KEM shared secrets → HKDF. */
  _hybridKek(ssEC, ssPQ, ephPub, recipXPub, kemCt) {
    const C = this._c();
    const salt = C.sha256(this._cat(ephPub, recipXPub, kemCt));
    return C.hkdf(C.sha256, this._cat(ssEC, ssPQ), salt, new TextEncoder().encode('SAYIT-DM-kek-v2'), 32);
  },
  /* KEK for the SENDER's own copy: derived only from the sender's X25519 secret,
     so you (and only you) can re-read your own sent messages on any device.
     Symmetric → quantum-safe; no ECDH/KEM needed. */
  _selfKek(xSecret) {
    const C = this._c(); const te = new TextEncoder();
    return C.hkdf(C.sha256, xSecret, C.sha256(te.encode('SAYIT-DM-self')), te.encode('SAYIT-DM-self-v2'), 32);
  },

  /* Encrypt `text` so BOTH the recipient and the sender can read it later: the
     body is sealed with a random key K, and K is wrapped twice — once to the
     recipient via the hybrid PQ KEM, once symmetrically to the sender. me = the
     sender's keys ({ xSecret, … }); recip = { xPublic, mlPublic }. → DM1: string. */
  encrypt(text, recip, me, fromAddr, toAddr, extra) {
    const C = this._c(); const te = new TextEncoder();
    const K = C.randomBytes(32);
    const from = (fromAddr || '').toLowerCase(), to = (toAddr || '').toLowerCase();
    const aad = te.encode(from + '|' + to);
    const nonceBody = C.randomBytes(this.NONCE_LEN);
    /* `extra` carries optional group metadata ({ gid, members }) so a group
       message — sent as one tx per member — can be grouped client-side. */
    const inner = JSON.stringify({ v: 2, from, to, ts: Date.now(), text: String(text), ...(extra || {}) });
    const bodyCt = C.xchacha20poly1305(K, nonceBody, aad).encrypt(te.encode(inner));
    /* Recipient wrap (hybrid PQ). */
    const ephSecret = C.randomBytes(32);
    const ephPub = C.x25519.getPublicKey(ephSecret);
    const ssEC = C.x25519.getSharedSecret(ephSecret, recip.xPublic);
    const { cipherText: kemCt, sharedSecret: ssPQ } = C.ml_kem768.encapsulate(recip.mlPublic);
    const kekR = this._hybridKek(ssEC, ssPQ, ephPub, recip.xPublic, kemCt);
    const wnR = C.randomBytes(this.NONCE_LEN);
    const wrapR = C.xchacha20poly1305(kekR, wnR).encrypt(K);
    /* Self wrap (symmetric — only the sender's xSecret unlocks it). */
    const wnS = C.randomBytes(this.NONCE_LEN);
    const wrapS = C.xchacha20poly1305(this._selfKek(me.xSecret), wnS).encrypt(K);
    return DM_PREFIX + this._b64(this._cat(
      new Uint8Array([2]), nonceBody, ephPub, kemCt, wnR, wrapR, wnS, wrapS, bodyCt));
  },

  /* Decrypt a DM1: payload with `me` ({ xSecret, xPublic, mlSecret }). Works
     whether you SENT it (self wrap) or RECEIVED it (recipient wrap). fromAddr/
     toAddr are the tx's from/to. Throws on tamper / wrong key / binding mismatch. */
  decrypt(payload, me, fromAddr, toAddr) {
    const C = this._c(); const td = new TextDecoder(); const te = new TextEncoder();
    if (typeof payload !== 'string' || !payload.startsWith(DM_PREFIX)) throw new Error('not a DM');
    const raw = this._unb64(payload.slice(DM_PREFIX.length));
    const from = (fromAddr || '').toLowerCase(), to = (toAddr || '').toLowerCase();
    const aad = te.encode(from + '|' + to);
    const ver = raw[0];
    if (ver === 1) return this._decryptV1(raw, me, aad, from, to);
    if (ver !== 2) throw new Error('unsupported DM version');
    let o = 1;
    const nonceBody = raw.slice(o, o += this.NONCE_LEN);
    const ephPub    = raw.slice(o, o += this.X_PUB_LEN);
    const kemCt     = raw.slice(o, o += this.KEM_CT_LEN);
    const wnR       = raw.slice(o, o += this.NONCE_LEN);
    const wrapR     = raw.slice(o, o += this.WRAP_LEN);
    const wnS       = raw.slice(o, o += this.NONCE_LEN);
    const wrapS     = raw.slice(o, o += this.WRAP_LEN);
    const bodyCt    = raw.slice(o);
    /* Recover K from whichever wrap is ours: try the recipient hybrid first,
       fall back to the self wrap (so the sender reads their own message). */
    let K = null;
    try {
      const ssEC = C.x25519.getSharedSecret(me.xSecret, ephPub);
      const ssPQ = C.ml_kem768.decapsulate(kemCt, me.mlSecret);
      K = C.xchacha20poly1305(this._hybridKek(ssEC, ssPQ, ephPub, me.xPublic, kemCt), wnR).decrypt(wrapR);
    } catch { /* not the recipient — try the self wrap below */ }
    if (!K) K = C.xchacha20poly1305(this._selfKek(me.xSecret), wnS).decrypt(wrapS); /* throws if neither */
    const pt = C.xchacha20poly1305(K, nonceBody, aad).decrypt(bodyCt);
    const inner = JSON.parse(td.decode(pt));
    if (inner.from !== from || inner.to !== to) throw new Error('binding mismatch');
    return { text: inner.text, ts: inner.ts, gid: inner.gid, members: inner.members };
  },

  /* Legacy v1 (recipient-only sealed box) — kept so already-received messages
     still decrypt. New messages are always v2. */
  _decryptV1(raw, me, aad, from, to) {
    const C = this._c(); const td = new TextDecoder();
    let o = 1;
    const nonce  = raw.slice(o, o += this.NONCE_LEN);
    const ephPub = raw.slice(o, o += this.X_PUB_LEN);
    const kemCt  = raw.slice(o, o += this.KEM_CT_LEN);
    const ct     = raw.slice(o);
    const ssEC = C.x25519.getSharedSecret(me.xSecret, ephPub);
    const ssPQ = C.ml_kem768.decapsulate(kemCt, me.mlSecret);
    const salt = C.sha256(this._cat(ephPub, me.xPublic, kemCt));
    const key  = C.hkdf(C.sha256, this._cat(ssEC, ssPQ), salt, new TextEncoder().encode('SAYIT-DM-v1'), 32);
    const pt = C.xchacha20poly1305(key, nonce, aad).decrypt(ct);
    const inner = JSON.parse(td.decode(pt));
    if (inner.from !== from || inner.to !== to) throw new Error('binding mismatch');
    return { text: inner.text, ts: inner.ts };
  },
};
if (typeof window !== 'undefined') window.DMCrypto = DMCrypto;
