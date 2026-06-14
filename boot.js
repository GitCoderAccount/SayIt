/* Tighten connect-src before anything fetches. The static meta keeps
   `connect-src *` (so removing it can't fall back to default-src 'self' and
   break the app); this injected policy INTERSECTS with it, narrowing connect-src
   to the hosts we actually use + the user's configured endpoints. That removes
   the arbitrary-host exfiltration path (important now that encrypted-DM key
   material lives client-side) while leaving every legit endpoint working. If a
   browser ignores a script-inserted meta CSP, the static `*` simply remains —
   no breakage. */
try {
  const _cs = [
    "'self'",
    'https://*.pulsechain.com',                 /* explorer API + RPC (default) */
    'https://ipfs.io', 'https://arweave.net',   /* NFT / token metadata fetches */
    'https://dweb.link', 'https://cloudflare-ipfs.com', 'https://nftstorage.link',
    'wss://tracker.openwebtorrent.com',         /* Spaces WebRTC signaling */
    'wss://tracker.webtorrent.dev',
    'wss://tracker.btorrent.xyz',
  ];
  try {
    const _s2 = JSON.parse(localStorage.getItem('sayitSettings') || '{}');
    [_s2.apiPrimary, _s2.apiBackup, _s2.rpcUrl].forEach(u => {
      if (typeof u === 'string' && u) { try { _cs.push(new URL(u).origin); } catch (e) {} }
    });
  } catch (e) { /* settings unreadable — defaults only */ }
  const _m = document.createElement('meta');
  _m.httpEquiv = 'Content-Security-Policy';
  _m.content = 'connect-src ' + [...new Set(_cs)].join(' ');
  document.head.appendChild(_m);
} catch (e) { /* CSP injection best-effort */ }

/* Apply saved appearance prefs before first paint to avoid a flash of the wrong
   colors / size / motion. Theme, forced reduce-motion, display zoom, and the
   accent color. */
try {
  const _s = JSON.parse(localStorage.getItem('sayitSettings') || '{}');
  const _de = document.documentElement;
  if (_s.theme === 'dim' || _s.theme === 'light') _de.setAttribute('data-theme', _s.theme);
  if (_s.reduceMotion) _de.classList.add('force-reduce-motion');
  if (_s.highContrast) _de.classList.add('hc');
  if (_s.underlineLinks) _de.classList.add('ul-links');
  if (_s.displayZoom && String(_s.displayZoom) !== '1') _de.style.zoom = _s.displayZoom;
  /* Accent color — a copy of core.js ACCENT_COLORS (boot.js runs before any
     script and can't import). SOURCE OF TRUTH: ACCENT_COLORS in core.js — keep
     these in sync. 'purple'/no setting leaves the stylesheet :root defaults. */
  const _ACCENTS = {
    blue:   { rgb: '29,155,240', primary: '#1d9bf0', lt: '#6cc5ff' },
    pink:   { rgb: '249,24,128', primary: '#f91880', lt: '#ff6bab' },
    green:  { rgb: '0,186,124',  primary: '#00ba7c', lt: '#4fe3b0' },
    orange: { rgb: '255,122,0',  primary: '#ff7a00', lt: '#ffab57' },
  };
  const _a = _ACCENTS[_s.accentColor];
  if (_a) {
    _de.style.setProperty('--primary', _a.primary);
    _de.style.setProperty('--primary-lt', _a.lt);
    _de.style.setProperty('--primary-dim', 'rgba(' + _a.rgb + ',0.15)');
    _de.style.setProperty('--primary-hov', 'rgba(' + _a.rgb + ',0.08)');
    _de.style.setProperty('--neon', '0 0 8px rgba(' + _a.rgb + ',0.5),0 0 20px rgba(' + _a.rgb + ',0.15)');
  }
} catch (e) {}
