#!/usr/bin/env python3
"""Full behavioral regression matrix for SayIt — the manual pre-release gate.

Runs the local checkout in headless Chromium (real CSP enforcement) and
exercises every major surface: boot, navigation, Following feed, thread
hero + ancestors, themes, analytics, settings/storage panel, search
(text + tx-hash Enter-jump), the delegated-action system, hover
popups, and a mobile overflow sweep. Exits non-zero on any failure.

Usage:
    pip install playwright && playwright install chromium
    python3 .ci/regression.py

This complements (not replaces) CI: CI runs lint + unit tests + boot
smoke on every push; this matrix is heavier and meant to be run before
tagged releases or after risky changes.
"""
import os, sys, time, json, http.server, socketserver, threading, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('SAYIT_PORT', '8123'))

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
class Quiet(socketserver.TCPServer):
    allow_reuse_address = True
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
http.server.SimpleHTTPRequestHandler.log_message = lambda *a, **k: None

httpd = Quiet(("127.0.0.1", PORT), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

FOLLOW_ADDR = '0x75f17e59ef0c97fde04d79f48dcfc444f48885a5'
FOLLOWING = ['0x490ee229913202fefbf52925bf5100ca87fb4421',
             '0xfc834970512a2123c8c01c4afdd8b8622e6868f8']

results, failures = {}, []

def check(name, ok, detail=''):
    results[name] = bool(ok)
    mark = '✓' if ok else '✗'
    print(f"  {mark} {name}" + (f"  ({detail})" if detail and not ok else ''))
    if not ok:
        failures.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    pg = b.new_page(viewport={'width': 1280, 'height': 900})
    page_errors, csp_violations = [], []
    pg.on("pageerror", lambda e: page_errors.append(str(e)[:160]))
    pg.on("console", lambda m: csp_violations.append(m.text[:160])
          if m.type == "error" and 'Content Security Policy' in m.text else None)

    pg.goto(f"http://127.0.0.1:{PORT}/index.html", wait_until="domcontentloaded", timeout=30000)
    pg.wait_for_function("() => typeof pulse !== 'undefined'", timeout=20000)
    time.sleep(2)
    el = pg.query_selector('#disclaimer-agree')
    if el:
        el.click(); time.sleep(0.4)
    pg.wait_for_function("() => pulse.state.posts.length > 0", timeout=40000)
    time.sleep(2)

    check('boot: feed loads', pg.evaluate("() => pulse.state.posts.length > 0"))

    # Following feed (real chain data, stubbed wallet)
    pg.evaluate(f"""() => {{ pulse.state.signerAddr = '{FOLLOW_ADDR}'; pulse.signer = {{}};
        pulse.state.following = new Set({json.dumps(FOLLOWING)});
        pulse.setFeedTab('following'); }}""")
    time.sleep(2)
    pg.wait_for_function("() => !document.querySelector('.following-progress')", timeout=120000)
    check('following: rows render', pg.evaluate(
        "() => document.querySelectorAll('#feed [data-txhash]').length > 3"))
    pg.evaluate("() => pulse.setFeedTab('foryou')"); time.sleep(1)
    check('following: no leak back to For You', pg.evaluate("""() => {
        const extra = pulse._followingExtra ? new Set([...pulse._followingExtra.keys()]) : new Set();
        const main = new Set(pulse.state.posts.map(p => p.txHash));
        return [...document.querySelectorAll('#feed [data-txhash]')]
          .filter(r => extra.has(r.dataset.txhash) && !main.has(r.dataset.txhash)).length === 0;
    }"""))

    # Thread hero + ancestor chain
    pg.evaluate("""() => {
        const mk = (i, text, extra={}) => ({ content:text, display:text, parentTx:null, repostOf:null,
            direction:null, poll:null, postType:'post', reactionTarget:null,
            reporter:'0x'+String(i).repeat(40).slice(0,40), to:pulse.state.channel,
            timestamp:new Date(Date.now()-i*60000).toISOString(),
            txHash:'0x'+String(i).repeat(64).slice(0,64), channel:pulse.state.channel, mode:'main',
            blockNumber:1, ...extra });
        const parent = mk(1, 'regression parent');
        const reply  = mk(2, 'regression reply', { parentTx: parent.txHash });
        [parent, reply].forEach(x => pulse._postMap.set(x.txHash, x));
        pulse.state.posts.unshift(parent, reply);
        pulse.openThread(reply);
    }""")
    time.sleep(3.5)
    check('thread: hero renders', pg.evaluate("() => !!document.querySelector('.hero-body')"))
    check('thread: ancestors connected, no label', pg.evaluate(
        "() => document.querySelectorAll('.thread-ancestor-item').length >= 1"
        " && !document.body.textContent.includes('ancestor post')"))
    check('thread: header kept after re-render', pg.evaluate(
        "() => !!document.querySelector('#feed .page-header')"))

    # Analytics
    pg.evaluate("() => pulse.goAnalytics()"); time.sleep(2)
    check('analytics: 14-day chart', pg.evaluate(
        "() => document.querySelectorAll('.ana-bar').length === 14"))

    # Settings + storage panel + media toggles
    pg.evaluate("() => pulse.goSettings()"); time.sleep(2)
    check('settings: storage counts', pg.evaluate(
        "() => (document.getElementById('storage-counts')?.textContent || '').length > 10"))
    check('settings: media toggles', pg.evaluate(
        "() => !!document.getElementById('set-autoplay-embeds') && !!document.getElementById('set-data-saver')"))

    # Themes
    check('themes: light applies', pg.evaluate("""() => {
        pulse._applyTheme('light');
        const ok = getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)';
        pulse._applyTheme('dark');
        return ok; }"""))

    # Search: tx hash Enter-jump
    pg.evaluate("() => pulse.goHome()"); time.sleep(1.5)
    h = pg.evaluate("() => pulse.state.posts.find(p => p.postType === 'post')?.txHash")
    pg.fill('#search-input', h or ''); time.sleep(0.8)
    pg.press('#search-input', 'Enter'); time.sleep(2.5)
    check('search: hash opens thread', pg.evaluate("() => pulse.state.mode") == 'thread')

    # Delegated actions
    pg.evaluate("() => pulse.goHome()"); time.sleep(1.5)
    pg.evaluate("() => document.querySelector('[data-act=\"search-trend\"]')?.click()")
    time.sleep(1.2)
    check('delegate: trend click searches', bool(pg.evaluate("() => pulse.state.searchTerm")))

    # Hover popup
    pg.evaluate("() => { pulse._clearSearch?.(); pulse.goHome(); }"); time.sleep(2)
    try:
        pg.hover('#feed .post-item .post-name', timeout=5000); time.sleep(1.5)
        hover_ok = pg.evaluate(
            "() => { const p = document.getElementById('profile-popup') || document.querySelector('.profile-popup');"
            " return p ? p.offsetHeight > 0 : false; }")
    except Exception:
        hover_ok = False
    check('hover: profile popup', hover_ok)

    check('zero page errors', len(page_errors) == 0, '; '.join(page_errors[:3]))
    check('zero CSP violations', len(csp_violations) == 0, '; '.join(csp_violations[:2]))
    pg.close()

    # Mobile overflow sweep
    pg2 = b.new_page(viewport={'width': 390, 'height': 844})
    pg2.goto(f"http://127.0.0.1:{PORT}/index.html", wait_until="domcontentloaded", timeout=30000)
    pg2.wait_for_function("() => typeof pulse !== 'undefined'", timeout=20000)
    time.sleep(2.5)
    overflows = pg2.evaluate("""() => { let n = 0;
        for (const el of document.querySelectorAll('#feed *, #compose-area *')) {
            if (el.children.length) continue;
            const r = el.getBoundingClientRect();
            if (r.right > window.innerWidth + 1 && r.width > 0 && !el.closest('.prof-tabs,.explore-tabs')) n++;
        } return n; }""")
    check('mobile: zero overflows', overflows == 0, f'{overflows} overflowing')
    b.close()

httpd.shutdown()
print(f"\n{'PASS' if not failures else 'FAIL'}: {sum(results.values())}/{len(results)} checks"
      + (f" — failures: {', '.join(failures)}" if failures else ""))
sys.exit(0 if not failures else 1)
