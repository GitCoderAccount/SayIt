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
