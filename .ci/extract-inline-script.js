#!/usr/bin/env node
/* Extracts the inline <script> blocks from index.html into .js files so
   ESLint / `node --check` can catch bugs (e.g. references to undefined
   functions) in the inlined code without a build step.

   - The main app block (opens with a bare `<script>` line) is written to
     the output path (default .ci/app.extracted.js), padded with blank
     lines so reported line numbers match index.html.
   - The head pre-paint block (opens mid-line: `<script>/* ... `) is
     written alongside it as head.extracted.js, also line-aligned. */
const fs = require('fs');
const path = require('path');

const src = process.argv[2] || 'index.html';
const out = process.argv[3] || '.ci/app.extracted.js';

const lines = fs.readFileSync(src, 'utf8').split('\n');

/* ── Main app block: bare `<script>` line ── */
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

/* ── Head pre-paint block: starts mid-line with `<script>` + code, ends
   mid-line with `</script>`. Match the first such block before the main
   one that isn't a `<script src=...>` tag. ── */
const headOut = path.join(path.dirname(out), 'head.extracted.js');
let headStart = -1;
for (let i = 0; i < start; i++) {
  const m = lines[i].match(/<script>(?!<)/);
  if (m && !lines[i].includes('<script src=')) { headStart = i; break; }
}
if (headStart === -1) {
  /* No head block — write an empty placeholder so CI's node --check passes. */
  fs.writeFileSync(headOut, '');
  console.log(`No head <script> block found -> ${headOut} (empty)`);
} else {
  let headEnd = -1;
  for (let i = headStart; i < start; i++) {
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
