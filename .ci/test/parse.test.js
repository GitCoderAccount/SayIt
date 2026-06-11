'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load, makeTx, toInput } = require('./load-app.js');

const HASH64 = '0x' + 'ab'.repeat(32);
const ADDR40 = '0x' + 'cd'.repeat(20);

/* Fresh app per test group keeps pulse.state / vote accumulators isolated. */
function feedParse(txs, stateOver = {}) {
  const app = load();
  const { pulse, constants } = app;
  pulse.state.mode = 'main';
  pulse.state.channel = constants.MAIN_CHANNEL;
  pulse.state.signerAddr = null;
  Object.assign(pulse.state, stateOver);
  return { posts: pulse.parseTxs(txs), pulse, constants };
}

test('plain post parses with display text and validated metadata', () => {
  const tx = makeTx('hello world');
  const { posts } = feedParse([tx]);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].postType, 'post');
  assert.strictEqual(posts[0].display, 'hello world');
  assert.strictEqual(posts[0].txHash, tx.hash.toLowerCase());
  assert.strictEqual(posts[0].reporter, tx.from.toLowerCase());
});

test('REPLY_TO with valid hash sets parentTx; invalid hash does not', () => {
  const good = makeTx(`REPLY_TO:${HASH64}\n\nnice post`);
  const bad  = makeTx(`REPLY_TO:0xzznotahash\n\ntext`);
  const { posts } = feedParse([good, bad]);
  assert.strictEqual(posts.length, 2);
  assert.strictEqual(posts[0].parentTx, HASH64);
  assert.strictEqual(posts[0].display, 'nice post');
  assert.strictEqual(posts[1].parentTx, null);   /* malformed → plain post */
});

test('REPOST and quote-post parse; malformed target stays a plain post', () => {
  const repost = makeTx(`REPOST:${HASH64}`);
  const quote  = makeTx(`REPOST:${HASH64}\n\nmy take`);
  const bad    = makeTx(`REPOST:0x123\n\nx`);
  const { posts } = feedParse([repost, quote, bad]);
  assert.strictEqual(posts[0].postType, 'repost');
  assert.strictEqual(posts[0].repostOf, HASH64);
  assert.strictEqual(posts[1].display, 'my take');
  assert.strictEqual(posts[2].postType, 'post');
  assert.strictEqual(posts[2].repostOf, null);
});

test('LIKE with 64-hex target parses; malformed targets are dropped', () => {
  const good = makeTx(`LIKE:${HASH64}`);
  const evil = makeTx(`LIKE:0x');alert(1)//`);
  const short = makeTx('LIKE:0x1234');
  const { posts } = feedParse([good, evil, short]);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].postType, 'like');
  assert.strictEqual(posts[0].reactionTarget, HASH64);
});

test('FOLLOW with 40-hex target parses; malformed dropped', () => {
  const good = makeTx(`FOLLOW:${ADDR40}`);
  const evil = makeTx(`FOLLOW:${ADDR40}');alert(1)//`);
  const { posts } = feedParse([good, evil]);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].postType, 'follow');
  assert.strictEqual(posts[0].reactionTarget, ADDR40);
});

test('POLL payload parses question + options; VOTE is captured, not a feed item', () => {
  /* Poll JSON shape: { o: [options], e: endMs, q: fallback-question } */
  const poll = makeTx(`POLL:${JSON.stringify({ o: ['A', 'B'] })}\n\nWhich one?`);
  const vote = makeTx(`VOTE:${HASH64}:1`);
  const { posts } = feedParse([poll, vote]);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].postType, 'poll');
  assert.strictEqual(posts[0].display, 'Which one?');
  assert.deepStrictEqual([...posts[0].poll.options], ['A', 'B']);
});

test('POLL with malformed JSON falls back to plain post, never throws', () => {
  const bad = makeTx('POLL:{not json}\n\nQuestion?');
  const { posts } = feedParse([bad]);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].postType, 'post');
});

test('non-feed payloads are excluded: profile, bookmarks (self), notes, token profiles', () => {
  const me = '0x' + 'ee'.repeat(20);
  const txs = [
    makeTx('PROFILE_DATA:{"username":"a"}', { from: me, to: me }),
    makeTx(`BOOKMARK:${HASH64}`, { from: me, to: me }),
    makeTx(`UNBOOKMARK:${HASH64}`, { from: me, to: me }),
    makeTx(`NOTE:${HASH64}\n\ncontext`),
    makeTx(`NOTERATE:${HASH64}:h`),
    makeTx(`PROFILE_FOR:${ADDR40}\n\n{}`),
  ];
  const { posts } = feedParse(txs);
  assert.strictEqual(posts.length, 0);
});

test('TIP payloads are never feed posts', () => {
  const { posts } = feedParse([makeTx(`TIP:${HASH64}`)]);
  assert.strictEqual(posts.length, 0);
});

test('non-self bookmark/profile control txs are dropped, not shown as raw posts', () => {
  /* Before parser unification these leaked into feeds as raw "BOOKMARK:0x…"
     text posts (they're protocol-violating control txs sent to a channel). */
  const txs = [
    makeTx(`BOOKMARK:${HASH64}`),                  /* to = main channel */
    makeTx('PROFILE_DATA:{"username":"x"}'),       /* to = main channel */
  ];
  const { posts } = feedParse(txs);
  assert.strictEqual(posts.length, 0);
});

test('txs not addressed to the current channel are excluded in main mode', () => {
  const onChannel  = makeTx('visible');
  const offChannel = makeTx('hidden', { to: ADDR40 });
  const { posts } = feedParse([onChannel, offChannel]);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].display, 'visible');
});

test('empty input and undecodable input are skipped, not fatal', () => {
  const { posts } = feedParse([
    makeTx('ok'),
    { ...makeTx('x'), input: '0x' },
    { ...makeTx('x'), input: 'not-hex-at-all' },
    { ...makeTx('x'), input: null },
  ]);
  assert.strictEqual(posts.length, 1);
});

test('_parsePostTx agrees with parseTxs on post/reply/repost/poll (anti-drift)', () => {
  const cases = [
    makeTx('plain text post'),
    makeTx(`REPLY_TO:${HASH64}\n\na reply`),
    makeTx(`REPOST:${HASH64}\n\na quote`),
    makeTx(`POLL:${JSON.stringify({ o: ['x', 'y'] })}\n\nQ?`),
  ];
  for (const tx of cases) {
    const { posts, pulse } = feedParse([tx]);
    const single = pulse._parsePostTx(tx, { mode: 'main' });
    assert.ok(single, `single parser returned null for: ${tx.input}`);
    for (const key of ['display', 'parentTx', 'repostOf', 'postType']) {
      assert.deepStrictEqual(single[key], posts[0][key],
        `parser drift on "${key}" for payload ${Buffer.from(tx.input.slice(2), 'hex').toString().slice(0, 30)}`);
    }
  }
});

test('ingestion gate: sanitizeTxs drops txs whose hash/from would escape JS-string contexts', () => {
  const { pulse, utils, constants } = (() => { const a = load(); return a; })();
  pulse.state.mode = 'main';
  pulse.state.channel = constants.MAIN_CHANNEL;
  const evil = makeTx('innocent text', { hash: "0x');fetch('//evil.example')//" });
  /* apiFetch applies sanitizeTxs before parseTxs ever sees the list */
  const cleaned = utils.sanitizeTxs([evil, makeTx('fine')]);
  const posts = pulse.parseTxs(cleaned);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].display, 'fine');
});
