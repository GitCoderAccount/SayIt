#!/usr/bin/env node
'use strict';
/* Derive SW_CACHE_VER from a content hash of the app-asset files, so it never
   has to be bumped by hand.
     node .ci/derive-sw-ver.js          → WRITE the version into app.js
     node .ci/derive-sw-ver.js --check  → VERIFY app.js matches (CI uses this)
   Version format is `YYYYMMDD-<hash>`: the date keeps sw.js's cmpVer cache-
   recovery ordering sensible across days; only the <hash> part is verified — it
   changes iff an app asset changes, which is exactly when the SW cache must
   rebuild. Idempotent: WRITE mode is a no-op when the hash is already current.

   To make the bump fully automatic, install the pre-commit hook once:
     git config core.hooksPath .ci/hooks */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
/* The shell assets a returning visitor's service worker caches. MUST stay in
   sync with STATIC_ASSETS in sw.js (this list is the single source of truth the
   CI guard now relies on). */
const ASSETS = [
  'index.html', 'app.js', 'core.js', 'cache.js', 'settings.js', 'profile.js',
  'polls.js', 'notes.js', 'spaces.js', 'explore.js', 'lists.js', 'notifications.js',
  'channels.js', 'threads.js', 'bookmarks.js', 'banner.js', 'embeds.js', 'dm.js',
  'boot.js', 'sayit-crypto.js',
];
const VER_RE = /const SW_CACHE_VER = '([^']*)';/;

/* Hash every asset. app.js's own SW_CACHE_VER line is normalized to a constant
   before hashing, so writing the derived value back never changes the hash
   (no self-reference loop). */
function contentHash() {
  const h = crypto.createHash('sha256');
  for (const f of ASSETS) {
    let src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (f === 'app.js') src = src.replace(VER_RE, "const SW_CACHE_VER = 'X';");
    h.update(f + '\0' + src + '\0');
  }
  return h.digest('hex').slice(0, 10);
}

const appPath = path.join(ROOT, 'app.js');
const appSrc = fs.readFileSync(appPath, 'utf8');
const m = appSrc.match(VER_RE);
if (!m) { console.error('SW_CACHE_VER constant not found in app.js'); process.exit(2); }
const current = m[1];
const currentHash = current.split('-').pop(); /* part after the last '-' */
const hash = contentHash();

if (process.argv.includes('--check')) {
  if (currentHash !== hash) {
    console.error(
      `::error::SW_CACHE_VER is stale — an app asset changed but the version's hash ` +
      `('${currentHash}') != the current content hash ('${hash}'). ` +
      `Run: node .ci/derive-sw-ver.js  (or install the hook: git config core.hooksPath .ci/hooks)`);
    process.exit(1);
  }
  console.log(`SW_CACHE_VER OK (content hash ${hash}).`);
  process.exit(0);
}

/* WRITE mode — skip when the hash is already current (don't churn just the date). */
if (currentHash === hash) {
  console.log(`SW_CACHE_VER already current (content hash ${hash}).`);
  process.exit(0);
}
const d = new Date();
const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const next = `${date}-${hash}`;
fs.writeFileSync(appPath, appSrc.replace(VER_RE, `const SW_CACHE_VER = '${next}';`));
console.log(`SW_CACHE_VER -> ${next}  (was ${current})`);
