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
import sys, os, time, http.server, socketserver, threading, functools
from playwright.sync_api import sync_playwright

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
    pg.goto(f"http://127.0.0.1:{PORT}/index.html", wait_until="domcontentloaded", timeout=30000)
    try:
        pg.wait_for_function("() => typeof pulse !== 'undefined'", timeout=20000)
        booted = True
    except Exception:
        booted = False
    time.sleep(2)
    # Dismiss the first-load disclaimer / any open modal if present.
    for sel in ('#disclaimer-agree', '#disclaimer-close', '#generic-modal-close'):
        el = pg.query_selector(sel)
        if el:
            try:
                el.click()
                time.sleep(0.5)
            except Exception:
                pass
    if GOTO:
        el = pg.query_selector('#' + GOTO)
        if el:
            el.click()
            time.sleep(2.5)
    pg.screenshot(path=SHOT, full_page=False)
    b.close()
httpd.shutdown()

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
print("screenshot:", SHOT)

# Gate CI: non-zero exit if the app didn't boot or threw page errors.
# Console errors and failed requests are reported but don't fail the run
# (third-party CDN/API hiccups shouldn't break the build).
sys.exit(0 if (booted and not perr) else 1)
