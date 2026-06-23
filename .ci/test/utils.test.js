'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load, makeTx } = require('./load-app.js');

const { utils } = load();

test('safe() escapes all five HTML-significant characters', () => {
  assert.strictEqual(utils.safe(`<img src="x" onerror='a'>&`),
    '&lt;img src=&quot;x&quot; onerror=&#39;a&#39;&gt;&amp;');
  assert.strictEqual(utils.safe(null), '');
  assert.strictEqual(utils.safe(undefined), '');
  assert.strictEqual(utils.safe(123), '123');
});

test('safeUrl() allows http(s)/ipfs/ar/mailto, blocks scriptable schemes', () => {
  assert.strictEqual(utils.safeUrl('https://example.com/a'), 'https://example.com/a');
  assert.strictEqual(utils.safeUrl('ipfs://Qm123'), 'ipfs://Qm123');
  assert.strictEqual(utils.safeUrl('javascript:alert(1)'), '');
  assert.strictEqual(utils.safeUrl('data:text/html,<script>'), '');
  assert.strictEqual(utils.safeUrl('vbscript:x'), '');
  /* scheme smuggling via embedded control chars / whitespace */
  assert.strictEqual(utils.safeUrl('java\tscript:alert(1)'), '');
  assert.strictEqual(utils.safeUrl('JAVASCRIPT:alert(1)'), '');
});

test('isTxShape() accepts well-formed explorer txs', () => {
  assert.ok(utils.isTxShape(makeTx('hello')));
  /* contract creation: to is null */
  assert.ok(utils.isTxShape(makeTx('hello', { to: null })));
  assert.ok(utils.isTxShape(makeTx('hello', { to: '' })));
});

test('isTxShape() rejects malformed / scriptable hash, from, to', () => {
  /* The exact attack shape: a quote-bearing hash that would survive
     utils.safe() HTML-escaping and break out of an inline-handler
     JS string after entity decoding. */
  assert.ok(!utils.isTxShape(makeTx('x', { hash: "0x');alert(1)//" })));
  assert.ok(!utils.isTxShape(makeTx('x', { hash: '0x1234' })));            /* short */
  assert.ok(!utils.isTxShape(makeTx('x', { hash: undefined })));
  assert.ok(!utils.isTxShape(makeTx('x', { from: "0x');fetch(`//evil`)//" })));
  assert.ok(!utils.isTxShape(makeTx('x', { from: undefined })));
  assert.ok(!utils.isTxShape(makeTx('x', { to: 'not-an-address' })));
  assert.ok(!utils.isTxShape(null));
  assert.ok(!utils.isTxShape('0xabc'));
});

test('sanitizeTxs() filters bad txs and strips malformed numerics', () => {
  const good = makeTx('a');
  const evil = makeTx('b', { hash: "0x'+alert(1)+'" });
  const badTime = makeTx('c', { timeStamp: 'DROP TABLE', blockNumber: 'NaN-maker' });
  const out = utils.sanitizeTxs([good, evil, badTime, null, 42]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0], good);
  assert.strictEqual(out[1].timeStamp, undefined);
  assert.strictEqual(out[1].blockNumber, undefined);
  /* non-array input (explorer returned junk) — note: length asserts, not
     deepStrictEqual, because vm-context arrays have a different realm's
     Array.prototype */
  assert.strictEqual(utils.sanitizeTxs('junk').length, 0);
  assert.strictEqual(utils.sanitizeTxs(null).length, 0);
});

test('xPost() parses X/Twitter status URLs, rejects others', () => {
  assert.deepEqual(utils.xPost('https://x.com/jack/status/20'), { handle: 'jack', id: '20' });
  assert.deepEqual(utils.xPost('https://twitter.com/Jack_/statuses/12345'), { handle: 'Jack_', id: '12345' });
  assert.deepEqual(utils.xPost('https://mobile.x.com/a/status/9'), { handle: 'a', id: '9' });
  assert.strictEqual(utils.xPost('https://x.com/jack'), null);          /* profile, not a status */
  assert.strictEqual(utils.xPost('https://example.com/x/status/1'), null);
  assert.strictEqual(utils.xPost('not a url'), null);
});

test('grokPost() parses grok.com / x.ai pages, rejects others', () => {
  assert.deepEqual(utils.grokPost('https://grok.com/imagine/abc'), { kind: 'imagine', href: 'https://grok.com/imagine/abc' });
  assert.deepEqual(utils.grokPost('https://x.ai/share/xyz?t=1'), { kind: 'share', href: 'https://x.ai/share/xyz' });
  assert.strictEqual(utils.grokPost('https://grok.com/'), null);
  assert.strictEqual(utils.grokPost('https://example.com/imagine/a'), null);
});

test('dexPair() parses DexScreener pair URLs, rejects others', () => {
  const evm = '0x' + 'a'.repeat(40);
  assert.deepEqual(utils.dexPair('https://dexscreener.com/ethereum/' + evm),
    { chain: 'ethereum', pair: evm, href: 'https://dexscreener.com/ethereum/' + evm });
  assert.deepEqual(utils.dexPair('https://www.dexscreener.com/pulsechain/' + evm),
    { chain: 'pulsechain', pair: evm, href: 'https://www.dexscreener.com/pulsechain/' + evm });
  /* trailing slash still parses (href keeps it — only used as a fallback link) */
  assert.strictEqual(utils.dexPair('https://dexscreener.com/base/' + evm + '/').chain, 'base');
  assert.strictEqual(utils.dexPair('https://dexscreener.com/solana/' + 'A'.repeat(40)).chain, 'solana');
  assert.strictEqual(utils.dexPair('https://dexscreener.com'), null);          /* bare domain → not a chart */
  assert.strictEqual(utils.dexPair('https://dexscreener.com/ethereum'), null); /* no pair */
  assert.strictEqual(utils.dexPair('https://example.com/ethereum/' + evm), null);
});

test('fbVideo() parses Facebook video/Reel/Watch URLs, rejects others', () => {
  assert.deepEqual(utils.fbVideo('https://www.facebook.com/reel/1234567890'),
    { href: 'https://www.facebook.com/reel/1234567890' });
  assert.deepEqual(utils.fbVideo('https://web.facebook.com/somepage/videos/9876543210/'),
    { href: 'https://web.facebook.com/somepage/videos/9876543210/' });
  /* watch?v= → tracking params dropped, v preserved */
  assert.deepEqual(utils.fbVideo('https://www.facebook.com/watch/?v=555&fbclid=xyz'),
    { href: 'https://www.facebook.com/watch/?v=555' });
  assert.deepEqual(utils.fbVideo('https://m.facebook.com/video.php?v=42'),
    { href: 'https://m.facebook.com/video.php?v=42' });
  assert.strictEqual(utils.fbVideo('https://www.facebook.com/share/r/abcDEF/').href,
    'https://www.facebook.com/share/r/abcDEF/');
  assert.strictEqual(utils.fbVideo('https://fb.watch/aBcD1234/').href, 'https://fb.watch/aBcD1234/');
  /* non-video facebook paths fall through to a normal link card */
  assert.strictEqual(utils.fbVideo('https://www.facebook.com/zuck'), null);          /* profile */
  assert.strictEqual(utils.fbVideo('https://www.facebook.com/watch/'), null);        /* no v= */
  assert.strictEqual(utils.fbVideo('https://fb.watch'), null);                       /* bare host */
  assert.strictEqual(utils.fbVideo('https://example.com/reel/1'), null);             /* wrong host */
  assert.strictEqual(utils.fbVideo('not a url'), null);
});

test('linkCardHTML() builds a local card from the URL, no network', () => {
  const html = utils.linkCardHTML('https://www.example.com/path/to/page?x=1');
  assert.match(html, /class="link-card"/);
  assert.match(html, /href="https:\/\/www\.example\.com\/path\/to\/page\?x=1"/);
  assert.match(html, />example\.com</);            /* www stripped, domain shown */
  assert.match(html, /\/path\/to\/page</);         /* readable path, query dropped */
  assert.match(html, /link-card-mono[^>]*>E</);    /* monogram = first letter */
  assert.strictEqual(utils.linkCardHTML('not a url'), '');
});

test('refHash() strips eip155 chain qualifier → bare hash (cross-chain like dedup)', () => {
  const h = '0x' + 'a'.repeat(64);
  assert.strictEqual(utils.refHash(h), h);                       /* native ref unchanged */
  assert.strictEqual(utils.refHash('eip155:1:' + h), h);        /* ported (Ethereum) */
  assert.strictEqual(utils.refHash('eip155:8453:' + h), h);     /* ported (Base) */
  assert.strictEqual(utils.refHash('  EIP155:1:' + h.toUpperCase() + '  '), h); /* trims + lowercases */
  assert.strictEqual(utils.refHash(null), '');
});
