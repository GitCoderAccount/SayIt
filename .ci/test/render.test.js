'use strict';
/* Escaping tests for the body renderer.
 *
 * utils.safe()/safeUrl() are unit-tested directly in utils.test.js. This file
 * covers utils.linkify() — the composition that turns freeform on-chain post
 * text into HTML — which is the highest-value XSS surface in the app: every
 * post body flows through it. It must route ALL text/tag/mention/link segments
 * through safe(), never emitting attacker-controlled characters raw. */
const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./load-app.js');

const { utils } = load();
/* Full rendered output: a payload could be routed to body text, the media
   strip, or an embed/link card — escaping must hold across all three. */
const body = input => { const r = utils.linkify(input, input); return r.text + r.images + r.embeds; };

test('linkify escapes HTML/script in body text', () => {
  const out = body(`<script>alert('xss')</script> hello`);
  assert.ok(!/<script/i.test(out), 'raw <script must never appear in output');
  assert.ok(out.includes('&lt;script&gt;'), 'the tag must be HTML-escaped');
});

test('linkify escapes an attribute-breakout attempt embedded in text', () => {
  const out = body(`"><img src=x onerror=alert(1)>`);
  assert.ok(!/<img/i.test(out), 'raw <img must never appear');
  assert.ok(!/onerror=/.test(out) || /&quot;|&lt;/.test(out),
    'breakout chars must be escaped, not emitted as live markup');
  assert.ok(out.includes('&quot;') && out.includes('&lt;img'), 'quotes and < are escaped');
});

test('linkify cannot be tricked into a javascript: href', () => {
  const out = body('tap javascript:alert(document.cookie) now');
  assert.ok(!/href="javascript:/i.test(out), 'no javascript: scheme in any href');
});

test('a URL token carrying a quote cannot break out of the href attribute', () => {
  const out = body('see http://example.com/a.jpg"onerror="alert(1) end');
  assert.ok(!/href="[^"]*"\s*onerror/i.test(out),
    'the embedded quote must be escaped so it cannot close href and add a handler');
});

test('linkify still renders a normal URL as a safe link (no over-escaping)', () => {
  const out = body('visit http://example.com/page for more');
  assert.ok(/href="https?:\/\/example\.com\/page"/.test(out), 'plain URL becomes a real link');
  assert.ok(/rel="[^"]*noopener/.test(out), 'external links carry rel=noopener');
});

test('linkify escapes the # in a hashtag chip', () => {
  const out = body('gm #"><b>tag');
  assert.ok(!/<b>/.test(out), 'no raw markup leaks via a hashtag');
});
