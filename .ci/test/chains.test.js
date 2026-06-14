'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./load-app.js');

/* The registry + its helpers are top-level in core.js, so they live as
   context-globals in the same vm the harness builds. Pull them out by name. */
const { ctx } = load();
const eval_ = expr => require('vm').runInContext(expr, ctx);

const CHAINS = eval_('CHAINS');
const CANONICAL_CHAIN_ID = eval_('CANONICAL_CHAIN_ID');

test('CANONICAL chain is PulseChain (369), enabled + social', () => {
  assert.strictEqual(CANONICAL_CHAIN_ID, 369);
  const pls = CHAINS[369];
  assert.ok(pls, 'PulseChain present');
  assert.strictEqual(pls.canonical, true);
  assert.strictEqual(pls.enabled, true);
  assert.strictEqual(pls.social, true);
  assert.strictEqual(pls.explorer.type, 'blockscout');
});

test('only the canonical chain is enabled by default (others behind flag)', () => {
  const enabled = Object.values(CHAINS).filter(c => c.enabled).map(c => c.id);
  assert.deepStrictEqual(enabled, [369]);
});

test('every registry entry has the fields the wallet/UI need', () => {
  for (const c of Object.values(CHAINS)) {
    assert.strictEqual(typeof c.id, 'number');
    assert.match(c.hex, /^0x[0-9a-f]+$/i);
    assert.strictEqual(parseInt(c.hex, 16), c.id, `${c.name} hex matches id`);
    assert.ok(c.name && c.short && c.badge, `${c.id} has labels`);
    assert.ok(c.nativeCurrency?.symbol, `${c.name} native currency`);
    assert.ok(Array.isArray(c.rpcUrls) && c.rpcUrls.length, `${c.name} rpc`);
    assert.match(c.explorer.api, /^https:\/\//, `${c.name} explorer api`);
    assert.ok(['blockscout', 'etherscan-v2'].includes(c.explorer.type));
  }
});

test('chainCfg() resolves by number or numeric string, undefined for unknown', () => {
  assert.strictEqual(eval_('chainCfg(369)').id, 369);
  assert.strictEqual(eval_('chainCfg("369")').id, 369);
  assert.strictEqual(eval_('chainCfg(999999)'), undefined);
});

test('chainList() filters by enabled/social', () => {
  /* Spread vm-realm arrays into native ones so deepStrictEqual's prototype
     check passes (the arrays are constructed inside the vm context). */
  assert.deepStrictEqual([...eval_('chainList({enabledOnly:true}).map(c=>c.id)')], [369]);
  const social = [...eval_('chainList({socialOnly:true}).map(c=>c.id)')];
  assert.ok(social.includes(369));
  assert.ok(!social.includes(1), 'Ethereum L1 is not a social chain');
});

test('display helpers never throw on unknown chains', () => {
  assert.strictEqual(eval_('chainName(369)'), 'PulseChain');
  assert.strictEqual(eval_('chainBadge(369)'), 'PLS');
  assert.strictEqual(eval_('chainName(424242)'), 'Chain 424242');
  assert.strictEqual(eval_('chainBadge(424242)'), '#424242');
  assert.match(eval_('chainColor(424242)'), /^#[0-9a-f]{6}$/i);
});

test('explorerTxlistUrl: Blockscout request is byte-for-byte the legacy one', () => {
  const url = eval_(`explorerTxlistUrl(CHAINS[369], '0xabc', 2)`);
  assert.strictEqual(
    url,
    'https://api.scan.pulsechain.com/api?module=account&action=txlist&address=0xabc&offset=50&page=2&sort=desc');
});

test('explorerTxlistUrl: apiBase override replaces the endpoint', () => {
  const url = eval_(`explorerTxlistUrl(CHAINS[369], '0xabc', 1, { apiBase: 'https://backup.example/api' })`);
  assert.ok(url.startsWith('https://backup.example/api?module=account'));
});

test('explorerTxlistUrl: Etherscan-v2 adds chainid + apikey', () => {
  const url = eval_(`explorerTxlistUrl(CHAINS[1], '0xdef', 1, { apiKey: 'KEY123' })`);
  assert.ok(url.startsWith('https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlist'));
  assert.match(url, /address=0xdef/);
  assert.match(url, /&apikey=KEY123$/);
});

test('explorerTxlistUrl: Etherscan-v2 omits apikey when none supplied', () => {
  const url = eval_(`explorerTxlistUrl(CHAINS[8453], '0x1', 1)`);
  assert.ok(url.startsWith('https://api.etherscan.io/v2/api?chainid=8453&module=account'));
  assert.ok(!/apikey/.test(url));
});
