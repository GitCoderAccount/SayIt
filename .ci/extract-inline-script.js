#!/usr/bin/env node
/* Extracts the single inline <script> block from index.html into a .js file,
   padding the head with blank lines so reported line numbers match index.html.
   Lets ESLint / `node --check` catch bugs (e.g. references to undefined
   functions) in the inlined app code without a build step. */
const fs = require('fs');

const src = process.argv[2] || 'index.html';
const out = process.argv[3] || '.ci/app.extracted.js';

const lines = fs.readFileSync(src, 'utf8').split('\n');
/* The app's inline block opens with a bare `<script>` (the ethers tag uses
   `<script src=...>`), so this match is unambiguous. */
const start = lines.findIndex(l => l.trim() === '<script>');
if (start === -1) { console.error('No bare <script> block found in ' + src); process.exit(1); }
let end = -1;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].includes('</script>')) { end = i; break; }
}
if (end === -1) { console.error('Unterminated <script> block in ' + src); process.exit(1); }

const result = lines.map((line, i) => (i > start && i < end) ? line : '');
fs.writeFileSync(out, result.join('\n'));
console.log(`Extracted lines ${start + 2}-${end} of ${src} -> ${out}`);
