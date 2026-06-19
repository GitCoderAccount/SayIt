'use strict';
/* Guards the app.js decomposition invariant.
 *
 * The SayIt class is split across app.js (which defines `class SayIt`) plus a
 * set of augmenter files (settings.js, profile.js, …) that copy a throwaway
 * class's methods onto SayIt.prototype. Two hazards this locks down:
 *
 *   1. SILENT OVERWRITE — if a method name is defined in two of these files,
 *      whichever loads last silently wins. ESLint's no-undef can't see it and
 *      the smoke test only catches it if behavior visibly breaks. This test
 *      fails the build the moment a name is defined in more than one file.
 *
 *   2. BROKEN WIRING — if an augmenter's footer fails to copy (or the file
 *      isn't loaded), its methods never reach the prototype. This loads the
 *      real bundle and asserts every augmenter method is live on `pulse`.
 *
 * Augmenter files are detected by their `SayIt.prototype[k] = _X.prototype[k]`
 * footer, so new cuts are covered automatically with no edit here. */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./load-app.js');

const ROOT = path.join(__dirname, '..', '..');
const AUGMENT_FOOTER = /SayIt\.prototype\[k\]\s*=\s*_[A-Z0-9]+\.prototype\[k\]/;

/* app.js + every file whose footer augments SayIt.prototype. */
function protoFiles() {
  const augmenters = fs.readdirSync(ROOT)
    .filter(f => f.endsWith('.js') && f !== 'app.js')
    .filter(f => AUGMENT_FOOTER.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    .sort();
  return ['app.js', ...augmenters];
}

/* The portion of a file that defines prototype methods: the SayIt class body in
 * app.js (before `const pulse = new SayIt()`), or the throwaway class body in an
 * augmenter (before its copy-to-prototype `for` loop). Excludes the bootstrap
 * IIFEs and the footer so their control-flow keywords aren't mistaken for
 * method defs. */
function classBody(file, src) {
  if (file === 'app.js') {
    const i = src.indexOf('\nconst pulse = new SayIt(');
    return i >= 0 ? src.slice(0, i) : src;
  }
  /* Stop at the copy-to-prototype `for` loop. Tolerate leading whitespace —
     dm.js wraps its augmenter in an IIFE, so the loop is indented. */
  const m = src.match(/\n\s*for \(const k of Object\.getOwnPropertyNames\(/);
  return m ? src.slice(0, m.index) : src;
}

const METHOD_RE = /^  (async |get |set )?([A-Za-z_$][\w$]*)\s*\(/gm;

function methodsOf(file) {
  const body = classBody(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const out = [];
  let m;
  METHOD_RE.lastIndex = 0;
  while ((m = METHOD_RE.exec(body)) !== null) {
    const name = m[2];
    if (name === 'constructor') continue;
    const raw = (m[1] || '').trim();
    const kind = raw === 'get' || raw === 'set' ? raw : 'method'; // async≡method
    out.push({ kind, name, key: `${kind}:${name}` });
  }
  return out;
}

test('no SayIt.prototype method is defined in more than one file (silent-overwrite guard)', () => {
  const owner = new Map(); // key -> file
  const dups = [];
  for (const file of protoFiles()) {
    for (const { key } of methodsOf(file)) {
      if (owner.has(key) && owner.get(key) !== file) {
        dups.push(`${key.replace(/^method:/, '')}  (${owner.get(key)} + ${file})`);
      } else if (!owner.has(key)) {
        owner.set(key, file);
      }
    }
  }
  assert.deepStrictEqual(dups, [],
    'duplicate prototype method(s) across files — these silently overwrite:\n  ' + dups.join('\n  '));
});

test('every augmenter method is live on SayIt.prototype after load (wiring guard)', () => {
  const { pulse } = load();
  const missing = [];
  for (const file of protoFiles().filter(f => f !== 'app.js')) {
    for (const { kind, name } of methodsOf(file)) {
      if (kind !== 'method') continue; // getters/setters: skip the typeof check
      if (typeof pulse[name] !== 'function') missing.push(`${name}  (from ${file})`);
    }
  }
  assert.deepStrictEqual(missing, [],
    'augmenter method(s) not present on the prototype — wiring/load order broke:\n  ' + missing.join('\n  '));
});
