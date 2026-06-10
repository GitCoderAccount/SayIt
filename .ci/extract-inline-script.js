#!/usr/bin/env node
/* Prepares the lint/test artifacts in .ci/:
   - app.extracted.js: a copy of app.js (the app code moved out of
     index.html in the app.js split; the copy keeps every CI/test path
     stable and line numbers now match app.js exactly).
   - head.extracted.js: the small inline pre-paint <script> block from
     index.html's head, line-aligned for diagnostics. */
const fs = require('fs');
const path = require('path');

const src = process.argv[2] || 'index.html';
const out = process.argv[3] || '.ci/app.extracted.js';

const appSrc = path.join(path.dirname(src), 'app.js');
if (!fs.existsSync(appSrc)) { console.error('app.js not found next to ' + src); process.exit(1); }
fs.copyFileSync(appSrc, out);
console.log(`Copied ${appSrc} -> ${out}`);

/* boot.js holds the pre-paint theme script (was inline; strict CSP). */
const bootSrc = path.join(path.dirname(src), 'boot.js');
const headOut = path.join(path.dirname(out), 'head.extracted.js');
if (fs.existsSync(bootSrc)) {
  fs.copyFileSync(bootSrc, headOut);
  console.log(`Copied ${bootSrc} -> ${headOut}`);
} else {
  fs.writeFileSync(headOut, '');
  console.log(`No boot.js found -> ${headOut} (empty)`);
}
