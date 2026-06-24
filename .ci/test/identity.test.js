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

/* _identityWriteChain: which chain a profile SAVE targets. 'wallet' (no forced
   switch) when the wallet is on an identity chain; canonical otherwise so the
   write stays resolvable. This is the fix for "saving a profile on Base
   switches back to PulseChain". */
async function writeChainWith(walletCid, settings) {
  const origWallet = pulse._currentWalletChain;
  const origSettings = pulse._getSettings;
  pulse._currentWalletChain = async () => walletCid;
  pulse._getSettings = () => settings;
  try { return await pulse._identityWriteChain(); }
  finally { pulse._currentWalletChain = origWallet; pulse._getSettings = origSettings; }
}

test('_identityWriteChain: wallet on an identity chain (Base/Pulse/ETH) → "wallet", no forced switch', async () => {
  assert.strictEqual(await writeChainWith(8453, {}), 'wallet');
  assert.strictEqual(await writeChainWith(369, {}), 'wallet');
  assert.strictEqual(await writeChainWith(1, {}), 'wallet');
});

test('_identityWriteChain: wallet on a non-identity chain (Polygon) → canonical (visibility fallback)', async () => {
  assert.strictEqual(await writeChainWith(137, {}), 369);
});

test('_identityWriteChain: flag off → Base falls back to canonical; Pulse stays "wallet" (lands on Pulse, no switch)', async () => {
  assert.strictEqual(await writeChainWith(8453, { crossChainIdentity: false }), 369);
  assert.strictEqual(await writeChainWith(369, { crossChainIdentity: false }), 'wallet');
});

/* The cross-chain reaction merge (fetchMyReactions Phase 2a): newest TIMESTAMP
   wins per target, regardless of which chain the action landed on. This is the
   correctness keystone — concatenating per-chain newest-first lists would let an
   older action on one chain override a newer action on another. */
test('_applyReactionEvents: newest timestamp wins per target across chains (global last-write-wins)', () => {
  pulse.state.likes.clear(); pulse.state.bookmarks.clear(); pulse.state.following.clear();
  pulse._applyReactionEvents([
    /* post A: LIKED on Base (ts 5000), later UNLIKED on Pulse (ts 6000) → not liked */
    { cat: 'like', key: 'a', on: true,  ts: 5000 },
    { cat: 'like', key: 'a', on: false, ts: 6000 },
    /* post B: UNLIKED long ago (ts 1000), later LIKED on another chain (ts 2000) → liked */
    { cat: 'like', key: 'b', on: false, ts: 1000 },
    { cat: 'like', key: 'b', on: true,  ts: 2000 },
    { cat: 'follow', key: '0xcc', on: true, ts: 3000 },          /* followed */
    /* bookmark D: bookmarked (ts 1000), later un-bookmarked (ts 4000) → not bookmarked */
    { cat: 'bm', key: 'd', on: true,  ts: 1000 },
    { cat: 'bm', key: 'd', on: false, ts: 4000 },
  ]);
  assert.ok(!pulse.state.likes.has('a'), 'newer cross-chain UNLIKE wins → A not liked');
  assert.ok(pulse.state.likes.has('b'),  'newer cross-chain LIKE wins → B liked');
  assert.ok(pulse.state.following.has('0xcc'), 'C followed');
  assert.ok(!pulse.state.bookmarks.has('d'), 'newer UNBOOKMARK wins → D not bookmarked');
  pulse.state.likes.clear(); pulse.state.bookmarks.clear(); pulse.state.following.clear();
});
