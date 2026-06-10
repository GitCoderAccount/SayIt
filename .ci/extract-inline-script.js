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

const lines = fs.readFileSync(src, 'utf8').split('\n');
const headOut = path.join(path.dirname(out), 'head.extracted.js');
let headStart = -1;
for (let i = 0; i < lines.length; i++) {
  if (/<script>(?!<)/.test(lines[i]) && !lines[i].includes('<script src=')) { headStart = i; break; }
}
if (headStart === -1) {
  fs.writeFileSync(headOut, '');
  console.log(`No head <script> block found -> ${headOut} (empty)`);
} else {
  let headEnd = -1;
  for (let i = headStart; i < lines.length; i++) {
    if (lines[i].includes('</script>')) { headEnd = i; break; }
  }
  if (headEnd === -1) { console.error('Unterminated head <script> block in ' + src); process.exit(1); }
  const headLines = lines.map((line, i) => {
    if (i < headStart || i > headEnd) return '';
    let l = line;
    if (i === headEnd) l = l.slice(0, l.indexOf('</script>'));
    if (i === headStart) l = l.slice(l.indexOf('<script>') + '<script>'.length);
    return l;
  });
  fs.writeFileSync(headOut, headLines.join('\n'));
  console.log(`Extracted head script lines ${headStart + 1}-${headEnd + 1} of ${src} -> ${headOut}`);
}
