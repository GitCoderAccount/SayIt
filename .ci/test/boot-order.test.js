'use strict';
/* Guards the boot-order invariant that caused a live "Startup failed" outage.
 *
 * The SayIt class is split across app.js + augmenter <script>s that load AFTER
 * app.js (notes.js, explore.js, … dm.js) and copy their methods onto
 * SayIt.prototype. pulse.init() paints cached posts inside its async body
 * (loadCached → renderFeed), and that render calls augmenter methods like
 * _noteHTML (notes.js) and _computeTrends (explore.js).
 *
 * If init() is invoked during app.js evaluation, its first IndexedDB await can
 * resolve and render BEFORE those later scripts run on a warm reload →
 * "this._noteHTML is not a function" → init aborts → feed never paints and the
 * background wallet reconnect never runs. The smoke test can't catch this (it
 * boots with an empty IndexedDB, so loadCached renders nothing).
 *
 * Fix: init() must be DEFERRED until all augmenters have loaded (e.g. fired on
 * DOMContentLoaded). This test fails if anyone reintroduces a synchronous,
 * top-level pulse.init() call in app.js. */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');

test('app.js still boots the app (invokes pulse.init)', () => {
  assert.ok(/pulse\.init\(/.test(APP), 'app.js must call pulse.init() somewhere');
});

test('pulse.init() is NOT called at top-level during app.js eval', () => {
  /* A top-level statement starts at column 0. A deferred call lives inside a
     boot function (indented) gated by DOMContentLoaded, so it never matches. */
  assert.ok(
    !/^pulse\.init\(/m.test(APP),
    'pulse.init() must not run during app.js eval — it renders cached posts ' +
    '(loadCached → renderFeed) that call augmenter methods (_noteHTML, ' +
    '_computeTrends) defined in <script>s loaded after app.js. Defer it ' +
    '(e.g. document.addEventListener("DOMContentLoaded", ...)).');
});

test('boot is deferred until augmenters load (DOMContentLoaded / readyState gate)', () => {
  assert.ok(
    /DOMContentLoaded/.test(APP) || /document\.readyState/.test(APP),
    'init must be deferred until all augmenter scripts have run; expected a ' +
    'DOMContentLoaded listener or a document.readyState gate around the boot call.');
});
