#!/usr/bin/env python3
"""Headless smoke test for the SayIt single-page app.

Serves the repo root over HTTP, loads index.html in headless Chromium via
Playwright, and reports any page errors, console errors, or failed network
requests. Exits non-zero if the app fails to boot or emits page errors, so it
can gate CI.

Usage:
    python3 .ci/smoke.py [screenshot.png] [nav-id-to-click]

Examples:
    python3 .ci/smoke.py                      # home view -> /tmp/smoke.png
    python3 .ci/smoke.py /tmp/explore.png nav-explore

Environment:
    SAYIT_CHROMIUM   path to a Chromium/Chrome binary. If unset, falls back to
                     /usr/bin/chromium, then to Playwright's bundled browser.
    SAYIT_PORT       port for the local static server (default 8099).

Requires: pip install playwright  (and a Chromium, system or `playwright install`).
"""
import sys, os, time, re, http.server, socketserver, threading, functools
from playwright.sync_api import sync_playwright

# SAYIT_URL: when set (e.g. https://sayitdefi.com), smoke-test that deployed
# site instead of serving the local checkout — used by the nightly workflow.
TARGET_URL = os.environ.get('SAYIT_URL', '')

# Repo root = parent of this file's directory (.ci/smoke.py -> repo/).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('SAYIT_PORT', '8099'))
SHOT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/smoke.png'
GOTO = sys.argv[2] if len(sys.argv) > 2 else ''   # optional: nav id to click after load


def _chromium_path():
    """Prefer an explicit override, then a common system path, else let
    Playwright use its bundled browser (executable_path=None)."""
    env = os.environ.get('SAYIT_CHROMIUM')
    if env and os.path.exists(env):
        return env
    if os.path.exists('/usr/bin/chromium'):
        return '/usr/bin/chromium'
    return None


Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)


class Q(socketserver.TCPServer):
    allow_reuse_address = True


httpd = None
if not TARGET_URL:
    httpd = Q(("127.0.0.1", PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

cerr, warn, perr, rfail = [], [], [], []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=_chromium_path(), headless=True,
                          args=['--no-sandbox', '--disable-dev-shm-usage'])
    pg = b.new_page(viewport={'width': 1280, 'height': 900})
    pg.on("console", lambda m: cerr.append(m.text) if m.type == "error"
          else (warn.append(m.text) if m.type == "warning" else None))
    pg.on("pageerror", lambda e: perr.append(str(e)))
    pg.on("requestfailed", lambda r: rfail.append(f"{r.url.split('?')[0]} :: {r.failure}"))
    def boot_wait():
        try:
            pg.wait_for_function("() => typeof pulse !== 'undefined'", timeout=20000)
            return True
        except Exception:
            return False

    def dismiss_modals():
        # Dismiss the first-load disclaimer / any open modal if present.
        for sel in ('#disclaimer-agree', '#disclaimer-close', '#generic-modal-close'):
            el = pg.query_selector(sel)
            if el:
                try:
                    el.click(); time.sleep(0.5)
                except Exception:
                    pass

    pg.goto(TARGET_URL or f"http://127.0.0.1:{PORT}/index.html", wait_until="domcontentloaded", timeout=45000)
    booted = boot_wait()
    time.sleep(2)
    dismiss_modals()

    # Reload to exercise the cached-render boot path: loadCached → renderFeed →
    # postHTML/_noteHTML + renderTrending/_computeTrends. The first load starts
    # with an EMPTY IndexedDB and never runs that path — the blind spot that let
    # the boot-order "Startup failed" crash ship green. Wait for the first load
    # to cache some posts (best-effort), then reload and re-confirm boot. Home
    # smoke only (a GOTO nav smoke is exercising a different view).
    if not GOTO:
        try:
            pg.wait_for_function(
                "() => document.querySelectorAll('.post-item').length > 0", timeout=15000)
        except Exception:
            pass  # explorer returned no posts — the reload is still a valid boot check
        pg.reload(wait_until="domcontentloaded")
        booted = boot_wait() and booted
        time.sleep(2)
        dismiss_modals()

    if GOTO:
        el = pg.query_selector('#' + GOTO)
        if el:
            el.click(); time.sleep(2.5)
    pg.screenshot(path=SHOT, full_page=False)
    b.close()
if httpd: httpd.shutdown()

print("=== SMOKE REPORT ===")
print("app booted (typeof pulse):", booted)
print(f"page errors: {len(perr)}" + (" ✓" if not perr else ""))
for e in perr[:10]:
    print("  ✗", e[:240])
print(f"console.error: {len(cerr)}" + (" ✓" if not cerr else ""))
for e in cerr[:12]:
    print("  ⚠", e[:200])
print(f"failed requests: {len(rfail)}")
for e in rfail[:8]:
    print("  ⚫", e[:200])

# Boot-crash gate: any init-render failure (the boot-order class of bug) shows up
# as a console.error/warning/pageerror matching these — and is FATAL even though
# it's a *caught* console.error rather than an uncaught pageerror. This, plus the
# reload pass above, is what closes the smoke blind spot that let the boot-order
# "Startup failed" crash ship green twice.
INIT_FAIL_RE = re.compile(r'Init error|Startup failed|is not a function')
init_fail = [m for m in (perr + cerr + warn) if INIT_FAIL_RE.search(m)]
print(f"init/boot failures: {len(init_fail)}" + (" ✓" if not init_fail else ""))
for e in init_fail[:6]:
    print("  ✗", e[:240])
print("screenshot:", SHOT)

# Gate CI: non-zero exit if the app didn't boot, threw page errors, or hit an
# init/boot-render failure. Other console errors and failed requests are reported
# but don't fail the run (third-party CDN/API hiccups shouldn't break the build).
sys.exit(0 if (booted and not perr and not init_fail) else 1)
