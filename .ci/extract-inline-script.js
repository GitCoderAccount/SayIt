#!/usr/bin/env node
/* Prepares the lint/test artifacts in .ci/:
   - app.extracted.js: core.js + cache.js + app.js concatenated in load
     order. The browser loads them as classic scripts sharing one global
     lexical scope, so the concatenation is the faithful single-scope
     equivalent for ESLint (no-undef across files) and the vm test
     harness. Line numbers no longer match app.js 1:1 — each section is
     prefixed with a banner comment for diagnostics.
   - head.extracted.js: boot.js (the pre-paint theme script). */
const fs = require('fs');
const path = require('path');

const src = process.argv[2] || 'index.html';
const out = process.argv[3] || '.ci/app.extracted.js';
const dir = path.dirname(src);

const parts = ['core.js', 'cache.js', 'app.js', 'settings.js', 'profile.js', 'polls.js', 'embeds.js', 'dm.js'];
/* One leading directive for the whole bundle; per-file ones are stripped
   (a banner before 'use strict' would otherwise neuter it). */
let bundle = "'use strict';\n";
for (const name of parts) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) { console.error(`${name} not found next to ${src}`); process.exit(1); }
  const code = fs.readFileSync(p, 'utf8').replace(/^'use strict';\n/, '');
  bundle += `/* ════ ${name} ════ */\n` + code + '\n';
}
fs.writeFileSync(out, bundle);
console.log(`Bundled ${parts.join(' + ')} -> ${out}`);

/* boot.js holds the pre-paint theme script (was inline; strict CSP). */
const bootSrc = path.join(dir, 'boot.js');
const headOut = path.join(path.dirname(out), 'head.extracted.js');
if (fs.existsSync(bootSrc)) {
  fs.copyFileSync(bootSrc, headOut);
  console.log(`Copied ${bootSrc} -> ${headOut}`);
} else {
  fs.writeFileSync(headOut, '');
  console.log(`No boot.js found -> ${headOut} (empty)`);
}
