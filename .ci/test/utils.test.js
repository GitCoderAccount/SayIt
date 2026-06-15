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

test('refHash() strips eip155 chain qualifier → bare hash (cross-chain like dedup)', () => {
  const h = '0x' + 'a'.repeat(64);
  assert.strictEqual(utils.refHash(h), h);                       /* native ref unchanged */
  assert.strictEqual(utils.refHash('eip155:1:' + h), h);        /* ported (Ethereum) */
  assert.strictEqual(utils.refHash('eip155:8453:' + h), h);     /* ported (Base) */
  assert.strictEqual(utils.refHash('  EIP155:1:' + h.toUpperCase() + '  '), h); /* trims + lowercases */
  assert.strictEqual(utils.refHash(null), '');
});
