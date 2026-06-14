/* Test harness: evaluates the extracted inline app script in a Node `vm`
   context with just enough browser stubs that all classes and objects are
   DEFINED but the app never BOOTS (document.readyState stays 'loading', so
   the bootstrap IIFE only registers a DOMContentLoaded listener that never
   fires). Tests then exercise the pure protocol logic (utils, parseTxs,
   _parsePostTx) directly.

   Run `node .ci/extract-inline-script.js index.html .ci/app.extracted.js`
   first (the npm-less equivalent of a build step); CI does this in the
   lint job before `node --test`. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXTRACTED = path.join(__dirname, '..', 'app.extracted.js');

/* ── Generic DOM element stub: absorbs all property sets, returns itself or
   harmless values for everything the constructor/wiring code touches. ── */
function makeEl() {
  const el = {
    style: {}, dataset: {}, children: [], childNodes: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { return c; }, removeChild(c) { return c; }, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, contains() { return false; },
    focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    insertAdjacentHTML() {}, scrollIntoView() {},
    textContent: '', innerHTML: '', value: '', id: '',
  };
  return el;
}

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
}

/* Minimal ethers stub — only what the protocol-parsing paths use.
   v6 shape: helpers live flat on the namespace (no .utils). */
const ethersStub = {
  toUtf8String(hex) {
    if (typeof hex !== 'string' || !hex.startsWith('0x')) throw new Error('invalid hex');
    if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('invalid hex');
    return Buffer.from(hex.slice(2), 'hex').toString('utf8');
  },
  toUtf8Bytes: s => Buffer.from(String(s), 'utf8'),
  hexlify: b => '0x' + Buffer.from(b).toString('hex'),
  isAddress: a => /^0x[0-9a-fA-F]{40}$/.test(a || ''),
  getAddress: a => a,
};

function load() {
  if (!fs.existsSync(EXTRACTED)) {
    throw new Error('Run `node .ci/extract-inline-script.js index.html .ci/app.extracted.js` first');
  }
  const src = fs.readFileSync(EXTRACTED, 'utf8');

  const documentStub = {
    readyState: 'loading',            /* ← keeps the bootstrap from running */
    addEventListener() {}, removeEventListener() {},
    getElementById: () => makeEl(),
    createElement: () => makeEl(),
    querySelector: () => null, querySelectorAll: () => [],
    body: makeEl(), head: makeEl(), documentElement: makeEl(),
    title: '', hidden: false,
  };

  const windowStub = {
    ethers: ethersStub,
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    scrollTo() {}, open() {},
    location: { hash: '', href: 'http://localhost/', origin: 'http://localhost', pathname: '/' },
    history: { pushState() {}, replaceState() {}, state: null },
    innerWidth: 1280, innerHeight: 900,
    navigator: { onLine: true, serviceWorker: undefined, clipboard: {} },
    requestIdleCallback: undefined,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    localStorage: makeLocalStorage(),
    sessionStorage: makeLocalStorage(),
    navigator: windowStub.navigator,
    location: windowStub.location,
    history: windowStub.history,
    matchMedia: windowStub.matchMedia,
    IntersectionObserver: windowStub.IntersectionObserver,
    ResizeObserver: windowStub.ResizeObserver,
    indexedDB: { open: () => ({ /* request whose events never fire — Cache._ready just stays pending */ }) },
    fetch: () => Promise.reject(new Error('no network in tests')),
    AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console, URL, URLSearchParams, TextEncoder, TextDecoder, btoa, atob,
    Date, Math, JSON, Promise,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    crypto: { randomUUID: () => 'test-uuid', getRandomValues: a => a },
  };
  windowStub.localStorage = sandbox.localStorage;
  sandbox.globalThis = sandbox;
  sandbox.self = windowStub;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: 'app.extracted.js' });

  /* Everything top-level in the script is context-global. */
  return {
    utils: vm.runInContext('utils', ctx),
    pulse: vm.runInContext('pulse', ctx),
    SayIt: vm.runInContext('SayIt', ctx),
    constants: vm.runInContext(
      '({ MAIN_CHANNEL, REPLY_PREFIX, LIKE_PREFIX, FOLLOW_PREFIX, POLL_PREFIX, VOTE_PREFIX, NOTE_PREFIX })', ctx),
    ctx,
  };
}

/* Encode a UTF-8 payload the way wallets do: hex tx input data. */
function toInput(text) {
  return '0x' + Buffer.from(text, 'utf8').toString('hex');
}

/* Build a well-formed explorer tx. Override any field (incl. invalid ones). */
let _nonce = 0;
function makeTx(payload, over = {}) {
  _nonce++;
  return {
    hash: '0x' + String(_nonce).padStart(64, '0'),
    from: '0x' + String(_nonce).padStart(40, '1'),
    to: '0x0000000000000000000000000000000000000369',
    input: toInput(payload),
    timeStamp: String(1750000000 + _nonce),
    blockNumber: String(20000000 + _nonce),
    ...over,
  };
}

module.exports = { load, toInput, makeTx };
