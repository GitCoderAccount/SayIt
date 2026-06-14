/* CI coverage for the encrypted-DM crypto (DMCrypto + the vendored sayit-crypto
   bundle). Loads sayit-crypto.js (the @noble IIFE) and core.js in a vm context
   with a real getRandomValues, then exercises the hybrid X25519+ML-KEM scheme:
   deterministic keygen, dual-wrap round-trip (recipient AND sender), and
   rejection of tamper / wrong-recipient / sender-spoof. Mirrors the headless
   browser check so a crypto regression fails the build, not just manual QA. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');

function loadDMCrypto() {
  const cryptoSrc = fs.readFileSync(path.join(ROOT, 'sayit-crypto.js'), 'utf8');
  const coreSrc = fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8');
  const win = {};
  const sandbox = {
    window: win, self: win,
    TextEncoder, TextDecoder, btoa, atob, console,
    /* Real CSPRNG so noble's randomBytes produces proper key material. */
    crypto: { getRandomValues: (a) => { nodeCrypto.randomFillSync(a); return a; } },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(cryptoSrc, ctx);                  /* defines SAYIT_CRYPTO */
  const SC = vm.runInContext('typeof SAYIT_CRYPTO !== "undefined" ? SAYIT_CRYPTO : null', ctx);
  assert.ok(SC && SC.x25519 && SC.ml_kem768, 'sayit-crypto bundle exposes the primitives');
  win.SAYIT_CRYPTO = SC;
  vm.runInContext(coreSrc, ctx);                    /* defines DMCrypto, sets window.DMCrypto */
  const DMCrypto = win.DMCrypto;
  assert.ok(DMCrypto && DMCrypto.ready(), 'DMCrypto loaded and ready');
  return DMCrypto;
}

const DM = loadDMCrypto();
const A = '0xaaaa000000000000000000000000000000000001';
const B = '0xbbbb000000000000000000000000000000000002';

test('deriveKeys is deterministic for a given signature', () => {
  const k1 = DM.deriveKeys('alice-signature');
  const k2 = DM.deriveKeys('alice-signature');
  assert.deepStrictEqual([...k1.xPublic], [...k2.xPublic]);
  assert.deepStrictEqual([...k1.mlPublic], [...k2.mlPublic]);
  const k3 = DM.deriveKeys('bob-signature');
  assert.notDeepStrictEqual([...k1.xPublic], [...k3.xPublic]);
});

test('identity key bundle pack → parse round-trips', () => {
  const k = DM.deriveKeys('alice-signature');
  const parsed = DM.parseIdentityKey(DM.packIdentityKey(k));
  assert.deepStrictEqual([...parsed.xPublic], [...k.xPublic]);
  assert.deepStrictEqual([...parsed.mlPublic], [...k.mlPublic]);
});

test('dual-wrap: both recipient AND sender can decrypt', () => {
  const ak = DM.deriveKeys('alice-signature');
  const bk = DM.deriveKeys('bob-signature');
  const blob = DM.encrypt('hybrid pq end to end 🔒', { xPublic: bk.xPublic, mlPublic: bk.mlPublic }, ak, A, B);
  assert.ok(blob.startsWith('DM1:'));
  assert.strictEqual(DM.decrypt(blob, bk, A, B).text, 'hybrid pq end to end 🔒'); /* recipient */
  assert.strictEqual(DM.decrypt(blob, ak, A, B).text, 'hybrid pq end to end 🔒'); /* sender self-wrap */
});

test('rejects tamper, wrong recipient, and sender spoofing', () => {
  const ak = DM.deriveKeys('alice-signature');
  const bk = DM.deriveKeys('bob-signature');
  const ck = DM.deriveKeys('carol-signature');
  const blob = DM.encrypt('secret', { xPublic: bk.xPublic, mlPublic: bk.mlPublic }, ak, A, B);
  /* flip the last base64 char */
  const tampered = blob.slice(0, -2) + (blob.slice(-2) === 'AA' ? 'AB' : 'AA');
  assert.throws(() => DM.decrypt(tampered, bk, A, B), 'tamper rejected');
  assert.throws(() => DM.decrypt(blob, ck, A, B), 'third party rejected');
  assert.throws(() => DM.decrypt(blob, bk, '0xEvil000000000000000000000000000000000009', B), 'sender spoof rejected');
});
