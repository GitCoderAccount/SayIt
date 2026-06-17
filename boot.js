/* Tighten connect-src before anything fetches. */
try {
  const _cs = [
    "'self'",
    'https://*.pulsechain.com',
    'https://ipfs.io', 'https://arweave.net',
    'https://dweb.link', 'https://cloudflare-ipfs.com', 'https://nftstorage.link',
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.btorrent.xyz',
    // Default multichain Blockscout domains (for default-enabled chains)
    'https://eth.blockscout.com',
    'https://base.blockscout.com',
    'https://bsc.blockscout.com'
  ];
  const _CHAIN_ORIGINS = {
    1:    ['https://eth.blockscout.com', 'https://eth.llamarpc.com'],
    8453: ['https://base.blockscout.com', 'https://mainnet.base.org'],
    56:   ['https://bsc.blockscout.com', 'https://bsc-dataseed.binance.org'],
  };
  try {
    const _s2 = JSON.parse(localStorage.getItem('sayitSettings') || '{}');
    [_s2.apiUrl, _s2.backupApiUrl, _s2.rpcUrl].forEach(u => {
      if (typeof u === 'string' && u) { try { _cs.push(new URL(u).origin); } catch (e) {} }
    });
    (Array.isArray(_s2.enabledChains) ? _s2.enabledChains : []).forEach(id => {
      (_CHAIN_ORIGINS[Number(id)] || []).forEach(o => _cs.push(o));
    });
    const _ce = _s2.chainEndpoints || {};
    Object.keys(_ce).forEach(id => {
      [_ce[id]?.api, _ce[id]?.rpc].forEach(u => {
        if (typeof u === 'string' && u) { try { _cs.push(new URL(u).origin); } catch (e) {} }
      });
    });
  } catch (e) {}
  const _m = document.createElement('meta');
  _m.httpEquiv = 'Content-Security-Policy';
  _m.content = 'connect-src ' + [...new Set(_cs)].join(' ');
  document.head.appendChild(_m);
} catch (e) {}
