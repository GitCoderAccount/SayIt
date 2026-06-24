'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./load-app.js');

/* Cross-chain IDENTITY resolution (Phase 1: profiles). The key invariant is
   that the identity chain-set is FIXED + viewer-independent — if it varied with
   each viewer's feed toggles, two viewers would resolve a different "latest"
   profile for the same address. */
const { ctx } = load();
const eval_ = expr => require('vm').runInContext(expr, ctx);
const pulse = eval_('pulse');

/* Run pulse._identityChains() with a controlled settings object (the method
   reads the flag via _getSettings); always restore the original after. */
function identityChainsWith(settings) {
  const orig = pulse._getSettings;
  pulse._getSettings = () => settings;
  try { return [...pulse._identityChains()]; } /* spread out of the vm realm */
  finally { pulse._getSettings = orig; }
}

test('_identityChains: default (flag on) = the keyless set, canonical first', () => {
  assert.deepStrictEqual(identityChainsWith({}), [369, 1, 8453]);
});

test('_identityChains: excludes BSC — identity must be keyless so every viewer resolves the same set', () => {
  assert.ok(!identityChainsWith({}).includes(56), 'BSC needs a paid key → not an identity chain');
});

test('_identityChains: viewer-INDEPENDENT — ignores the per-viewer feed enabledChains setting', () => {
  /* A viewer who turned ETH/Base off in their FEED toggles must STILL resolve
     the same identity set, else profiles would differ between viewers. */
  assert.deepStrictEqual(identityChainsWith({ enabledChains: [], crossChainIdentity: true }), [369, 1, 8453]);
  assert.deepStrictEqual(identityChainsWith({ enabledChains: [1] }), [369, 1, 8453]);
});

test('_identityChains: flag off collapses to canonical-only (instant, behavior-preserving revert)', () => {
  assert.deepStrictEqual(identityChainsWith({ crossChainIdentity: false }), [369]);
});

test('_findLatestProfile: newest TIMESTAMP wins across chains (cross-chain last-write-wins)', async () => {
  const origScan = pulse._scanProfileTxOnChain;
  const origChains = pulse._identityChains;
  /* Pulse holds an OLD profile, Base a NEWER one, ETH none → Base must win
     (block order isn't comparable across chains, so we sort by timestamp). */
  pulse._identityChains = () => [369, 1, 8453];
  pulse._scanProfileTxOnChain = async (addr, cid) => {
    if (cid === 369)  return { data: { username: 'old-pulse' }, ts: 1000 };
    if (cid === 8453) return { data: { username: 'new-base' },  ts: 5000 };
    return null; /* ETH: no profile set */
  };
  try {
    const best = await pulse._findLatestProfile('0xABC');
    assert.ok(best, 'a profile is resolved');
    assert.strictEqual(best.data.username, 'new-base');
    assert.strictEqual(best.ts, 5000);
  } finally {
    pulse._scanProfileTxOnChain = origScan;
    pulse._identityChains = origChains;
  }
});

test('_findLatestProfile: returns null when no identity chain has a profile', async () => {
  const origScan = pulse._scanProfileTxOnChain;
  const origChains = pulse._identityChains;
  pulse._identityChains = () => [369, 1, 8453];
  pulse._scanProfileTxOnChain = async () => null;
  try {
    assert.strictEqual(await pulse._findLatestProfile('0xABC'), null);
  } finally {
    pulse._scanProfileTxOnChain = origScan;
    pulse._identityChains = origChains;
  }
});
