# sayit-crypto.js — vendored crypto bundle (reproducible)

`sayit-crypto.js` is a single self-contained IIFE exposing `window.SAYIT_CRYPTO`,
used by the encrypted-DM feature. It is **vendored** (frozen + committed) rather
than loaded from a CDN so that no third party can serve tampered code to users,
and it is integrity-checked via SRI on its `<script>` tag in index.html.

## What it contains (exact pins, all by @paulmillr, audited)
- @noble/curves@1.9.2        — x25519
- @noble/post-quantum@0.4.1  — ml_kem768 (ML-KEM-768 / FIPS 203)
- @noble/hashes@1.8.0        — sha256, sha512, hkdf, randomBytes
- @noble/ciphers@1.3.0       — xchacha20poly1305

## Reproducible build
```
mkdir build && cd build && npm init -y
npm install @noble/curves@1.9.2 @noble/post-quantum@0.4.1 @noble/hashes@1.8.0 @noble/ciphers@1.3.0
cat > entry.js <<'JS'
export { x25519 } from '@noble/curves/ed25519';
export { ml_kem768 } from '@noble/post-quantum/ml-kem';
export { sha256, sha512 } from '@noble/hashes/sha2';
export { hkdf } from '@noble/hashes/hkdf';
export { randomBytes } from '@noble/hashes/utils';
export { xchacha20poly1305 } from '@noble/ciphers/chacha';
JS
npx esbuild@0.24.0 entry.js --bundle --format=iife --global-name=SAYIT_CRYPTO --minify --legal-comments=none --outfile=sayit-crypto.js
```

Verify it matches the committed file:
- SHA-256: `5967eb8a2f808581148bad886b281656dd0007cc4360d662ad0479d701669ac4`
- SRI:     `sha384-SO0IcIwt3f+M1WMw+PAfLT74xgyCtNGlqEE7HJYJfuq8DJFmmgEYeUEdkOXuVfmT`

Properties: no eval/Function/WASM, zero external imports (fully self-contained),
makes no network calls. If you re-bundle, update the SRI integrity attribute in
index.html to match.
