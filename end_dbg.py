import time, json, http.server, socketserver, threading, functools
from playwright.sync_api import sync_playwright
ROOT = '/home/user/SayIt'
Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
http.server.SimpleHTTPRequestHandler.log_message = lambda *a, **k: None
class Quiet(socketserver.TCPServer): allow_reuse_address = True
httpd = Quiet(("127.0.0.1", 8140), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=['--no-sandbox','--disable-dev-shm-usage','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
    pg = b.new_page(viewport={'width':1280,'height':900})
    pg.on("pageerror", lambda e: print('PAGEERR:', str(e)[:200]))
    pg.on("console", lambda m: print('CONSOLE:', m.text[:150]) if m.type == 'error' else None)
    pg.goto("http://127.0.0.1:8140/index.html", wait_until="domcontentloaded")
    pg.wait_for_function("() => typeof pulse !== 'undefined'", timeout=20000)
    time.sleep(2)
    el = pg.query_selector('#disclaimer-agree')
    if el: el.click(); time.sleep(0.4)
    pg.wait_for_function("() => pulse.state.posts.length > 0", timeout=40000)
    pg.evaluate("""() => {
        const w = new ethers.Wallet('0x' + '11'.repeat(32));
        pulse.signer = w;
        pulse.state.signerAddr = w.address.toLowerCase();
        pulse.publish = async () => '0x' + 'e'.repeat(64);
        pulse.openCreateSpace();
    }""")
    time.sleep(0.5)
    pg.evaluate("() => { document.getElementById('space-title').value = 'dbg'; document.getElementById('space-create').click(); }")
    time.sleep(3)
    out = pg.evaluate("""() => ({
        room: !!pulse._spaceRoom,
        post: pulse._spaceRoomPost ? {tx: pulse._spaceRoomPost.txHash?.slice(0,10), rep: pulse._spaceRoomPost.reporter?.slice(0,10)} : null,
        status: document.getElementById('space-status')?.textContent || null,
        modalTitle: document.querySelector('#generic-modal .modal-title, .generic-modal-title')?.textContent || null,
    })""")
    print(json.dumps(out, indent=1))
    b.close()
httpd.shutdown()
