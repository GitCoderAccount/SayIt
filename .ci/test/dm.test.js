/* Unit tests for the pure (non-crypto) parts of DMCrypto — identity-key
   framing/parsing and prefix constants. The actual hybrid encryption round-trip
   (X25519 + ML-KEM-768) needs window.SAYIT_CRYPTO, so it's verified in the
   headless browser suite, not here. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { load } = require('./load-app.js');

const { ctx } = load();
const DMCrypto     = vm.runInContext('DMCrypto', ctx);
const DM_PREFIX    = vm.runInContext('DM_PREFIX', ctx);
const DMKEY_PREFIX = vm.runInContext('DMKEY_PREFIX', ctx);

test('prefixes are the versioned DM constants', () => {
  assert.strictEqual(DM_PREFIX, 'DM1:');
  assert.strictEqual(DMKEY_PREFIX, 'DMKEY1:');
});

test('identity key pack → parse round-trips the public keys', () => {
  const xPublic  = new Uint8Array(DMCrypto.X_PUB_LEN).fill(7);
  const mlPublic = new Uint8Array(DMCrypto.ML_PUB_LEN).fill(9);
  const packed = DMCrypto.packIdentityKey({ xPublic, mlPublic });
  assert.ok(packed.startsWith(DMKEY_PREFIX), 'has DMKEY1: prefix');

  const parsed = DMCrypto.parseIdentityKey(packed);
  assert.ok(parsed, 'parses');
  assert.strictEqual(parsed.xPublic.length, DMCrypto.X_PUB_LEN);
  assert.strictEqual(parsed.mlPublic.length, DMCrypto.ML_PUB_LEN);
  assert.deepStrictEqual([...parsed.xPublic], [...xPublic]);
  assert.deepStrictEqual([...parsed.mlPublic], [...mlPublic]);
});

test('parseIdentityKey rejects malformed input', () => {
  assert.strictEqual(DMCrypto.parseIdentityKey(null), null);
  assert.strictEqual(DMCrypto.parseIdentityKey('hello'), null);          /* no prefix */
  assert.strictEqual(DMCrypto.parseIdentityKey('DMKEY1:!!!notb64'), null); /* bad base64/length */
  /* right prefix but wrong length (32+1184 expected, give a short blob) */
  const short = DMKEY_PREFIX + DMCrypto._b64(new Uint8Array([1, 2, 3]));
  assert.strictEqual(DMCrypto.parseIdentityKey(short), null);
  /* correct length but wrong version byte */
  const badVer = DMKEY_PREFIX + DMCrypto._b64(
    new Uint8Array(1 + DMCrypto.X_PUB_LEN + DMCrypto.ML_PUB_LEN).fill(0).map((v, i) => (i === 0 ? 9 : v)));
  assert.strictEqual(DMCrypto.parseIdentityKey(badVer), null);
});

test('base64 helpers round-trip arbitrary bytes', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 65, 0, 128]);
  assert.deepStrictEqual([...DMCrypto._unb64(DMCrypto._b64(bytes))], [...bytes]);
});

test('crypto ops fail clearly when the library is absent (node has no SAYIT_CRYPTO)', () => {
  assert.strictEqual(DMCrypto.ready(), false);
  assert.throws(() => DMCrypto.deriveKeys('sig'), /not loaded/);
});
