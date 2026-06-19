'use strict';
/* embeds.js — X/Twitter + DexScreener inline embeds (a tap/scroll-to-load
   facade → the provider's own iframe). Extracted from app.js as the first cut
   of the app.js decomposition.

   These methods augment SayIt.prototype, which is defined in app.js; load order
   is core → cache → app → embeds → dm. The throwaway class below keeps method
   syntax clean; its methods are copied onto SayIt.prototype. Everything they
   reference resolves via the shared classic-script global scope (core.js consts
   like `utils`) or the prototype (`this._embedThumbsAllowed`, etc.), so nothing
   has to be imported. init() runs on DOMContentLoaded, after every augmenter
   has loaded, so the methods are always present by the time the app boots. */
const _EMB = class {
  /* Swap an X facade for X's own iframe embed (full post + video). Privacy
     mode (embeds off) opens X in a new tab instead — same gate as YouTube. */
  _loadXEmbed(el) {
    const id = el.dataset.xId, href = el.dataset.xHref;
    if (!/^[0-9]{5,25}$/.test(id || '')) { if (href) window.open(href, '_blank', 'noopener,noreferrer'); return; }
    if (!this._embedThumbsAllowed()) { if (href) window.open(href, '_blank', 'noopener,noreferrer'); return; }
    this._wireXEmbedResize();
    const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const frame = document.createElement('iframe');
    frame.src = `https://platform.twitter.com/embed/Tweet.html?id=${encodeURIComponent(id)}&theme=${theme}&dnt=true`;
    frame.className = 'x-embed-frame';
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('frameborder', '0');
    frame.setAttribute('title', 'Post on X');
    frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
    /* allow="fullscreen" grants the permission, but the iframe also needs the
       allowfullscreen attribute or a video's fullscreen is confined to the
       iframe's own box instead of filling the screen. */
    frame.setAttribute('allowfullscreen', '');
    el._facadeHTML = el.innerHTML; /* so scrolling away can restore the facade */
    el.classList.remove('x-embed-facade');
    el.classList.add('x-embed-loaded');
    el.innerHTML = '';
    el.appendChild(frame);
  }

  /* Swap a DexScreener facade for the live embedded chart (tap-to-load). Same
     privacy gate as X/YouTube — with embeds off, open DexScreener in a tab
     instead. Virtualization unmounts the post (and its iframe) when it scrolls
     out of the buffer, so no explicit revert is needed to bound memory. */
  _loadDexEmbed(el) {
    const chain = el.dataset.dexChain, pair = el.dataset.dexPair, href = el.dataset.dexHref;
    const ok = /^[a-z0-9-]{2,32}$/.test(chain || '') &&
               /^(0x[a-fA-F0-9]{40}|[A-Za-z0-9]{32,44})$/.test(pair || '');
    if (!ok || !this._embedThumbsAllowed()) { if (href) window.open(href, '_blank', 'noopener,noreferrer'); return; }
    const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const frame = document.createElement('iframe');
    frame.src = `https://dexscreener.com/${encodeURIComponent(chain)}/${encodeURIComponent(pair)}?embed=1&theme=${theme}&info=0`;
    frame.className = 'dex-embed-frame';
    frame.setAttribute('frameborder', '0');
    frame.setAttribute('title', 'DexScreener chart');
    frame.setAttribute('loading', 'lazy');
    el.classList.remove('dex-embed-facade');
    el.classList.add('dex-embed-loaded');
    el.innerHTML = '';
    el.appendChild(frame);
  }

  /* Restore a loaded X embed back to its facade (scrolled away). */
  _revertXEmbed(el) {
    if (!el.classList.contains('x-embed-loaded') || el._facadeHTML == null) return;
    el.innerHTML = el._facadeHTML;
    el.classList.remove('x-embed-loaded', 'x-embed-capped');
    el.classList.add('x-embed-facade');
  }

  /* X's Tweet.html iframe can't size itself — it posts its rendered height to
     the parent. Wire one global listener (lazily, on the first embed) that
     matches each message to its iframe by source window and sets the exact
     height, so tweets stop getting clipped at a fixed height. */
  _wireXEmbedResize() {
    if (this._xResizeWired) return;
    this._xResizeWired = true;
    window.addEventListener('message', e => this._onXEmbedMessage(e));
  }

  _onXEmbedMessage(e) {
    if (e.origin !== 'https://platform.twitter.com') return;
    let data = e.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
    const embed = data && data['twttr.embed'];
    if (!embed || embed.method !== 'twttr.private.resize') return;
    const p = Array.isArray(embed.params) && embed.params[0];
    const h = p && (p.height || (p.data && p.data.height));
    if (!h) return;
    const frame = [...document.querySelectorAll('iframe.x-embed-frame')]
      .find(f => f.contentWindow === e.source);
    if (frame) this._sizeXEmbed(frame, Math.ceil(h));
  }

  /* Fit the iframe to the tweet; cap very tall tweets behind a "Show full
     post" fade button (like X's truncated quote posts). */
  _sizeXEmbed(frame, h) {
    frame.style.height = h + 'px';
    const card = frame.closest('.x-embed-loaded');
    if (!card) return;
    const CAP = 420;
    if (h > CAP) {
      card.classList.add('x-embed-capped');
      if (!card.querySelector('.x-embed-more')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'x-embed-more';
        btn.textContent = 'Show full post';
        card.appendChild(btn);
      }
    } else {
      card.classList.remove('x-embed-capped');
      const btn = card.querySelector('.x-embed-more');
      if (btn) btn.remove();
    }
  }
};
for (const k of Object.getOwnPropertyNames(_EMB.prototype)) {
  if (k !== 'constructor') SayIt.prototype[k] = _EMB.prototype[k];
}
