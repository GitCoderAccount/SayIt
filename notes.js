'use strict';
/* notes.js — Community Notes, split out of app.js. A note is an on-chain tx
   `NOTE:<postHash>\n\n<text>`; ratings are `NOTERATE:<noteHash>:h|n`
   (last-rating-wins per address). Notes stay "proposed" until net-helpful
   reaches NOTE_SHOW_THRESHOLD, then graduate to a public "Readers added
   context" card. This file owns the whole feature: the tagged-tx sender
   (_sendTagged, used only here), the per-channel scan (_scanChannelNotes /
   _scanNotesForChannel), the render + in-place refresh (_noteHTML / _noteRateRow
   / _refreshNoteSlot / _refreshVisibleNotes), the note composer
   (openNoteComposer / _submitNote) and rating (_applyLocalRating / rateNote).

   Boot-order safety (the settings.js/profile.js/polls.js constraint): every
   method here is reached only from feed/post rendering (after init()'s awaits),
   a channel scan, or a deferred handler — never init()'s synchronous prefix,
   which runs at app.js eval time before this file loads.

   Augments SayIt.prototype (defined in app.js); load order is
   core -> cache -> app -> settings -> profile -> polls -> notes -> embeds -> dm.
   The throwaway class keeps method syntax clean; its methods are copied onto
   SayIt.prototype. Cross-refs (`utils`, `ethers`, `NOTERATE_PREFIX`,
   `this.cache`, `this._postMap`, ...) resolve via the shared classic-script
   scope or the prototype, so nothing is imported. */
const _NOTES = class {
  /* ── Community Notes ──────────────────────────────────────────────────
     A note is an on-chain tx `NOTE:<postHash>\n\n<text>`; ratings are
     `NOTERATE:<noteHash>:h|n` (last-rating-wins per address). Notes stay
     "proposed" (rate-able behind a marker) until net helpful reaches
     NOTE_SHOW_THRESHOLD, then graduate to a public "Readers added context"
     card — the X model. Notes are gathered with ONE channel scan per render
     (throttled 60s), not per-post, so the cost matches a single poll tally. */
  async _sendTagged(channel, body) {
    const data = ethers.hexlify(ethers.toUtf8Bytes(body));
    const gas = await this._estimateGasSafe({ to: channel, value: '0', data }, (data.length - 2) / 2);
    return this.signer.sendTransaction({ to: channel, value: '0', data, gasLimit: gas });
  }

  async _scanChannelNotes() {
    /* Scan the current channel AND the main channel — most posts/notes live in
       main, and on profiles/threads state.channel differs — so notes show
       across views, not just the main feed. */
    const channels = new Set([this.state.channel || MAIN_CHANNEL, MAIN_CHANNEL]);
    for (const ch of channels) await this._scanNotesForChannel(ch);
  }
  async _scanNotesForChannel(channel) {
    if (this._noteScanning.has(channel)) return;
    if (Date.now() - (this._noteScanAt.get(channel) || 0) < 60000) return;
    this._noteScanning.add(channel);
    const notesByPost = new Map(); /* postHash → Map(noteHash → note) */
    const ratings = new Map();     /* noteHash → Map(rater → 'h'|'n') */
    try {
      const scanLimit = Math.min(this._getMaxScanPages(), 20);
      for (let page = 1; page <= scanLimit; page++) {
        let raw;
        try { raw = await this.apiFetch(channel, page); } catch { break; }
        for (const tx of raw) {
          if (!tx.input || tx.input === '0x') continue;
          let text;
          try { text = ethers.toUtf8String(tx.input).trim(); } catch { continue; }
          if (text.startsWith(NOTE_PREFIX)) {
            const m = text.match(/^NOTE:(0x[a-f0-9]{64})\n\n([\s\S]+)$/i);
            if (!m) continue;
            const ph = m[1].toLowerCase(), nh = tx.hash?.toLowerCase();
            if (!nh) continue;
            if (!notesByPost.has(ph)) notesByPost.set(ph, new Map());
            const nm = notesByPost.get(ph);
            if (!nm.has(nh)) nm.set(nh, { hash: nh, author: tx.from?.toLowerCase(),
              text: m[2].trim(), ts: tx.timeStamp ? Number(tx.timeStamp) * 1000 : Date.now() });
          } else if (text.startsWith(NOTERATE_PREFIX)) {
            const m = text.match(/^NOTERATE:(0x[a-f0-9]{64}):(h|n)/i);
            if (!m) continue;
            const nh = m[1].toLowerCase(), rater = tx.from?.toLowerCase();
            if (!rater) continue;
            if (!ratings.has(nh)) ratings.set(nh, new Map());
            const rm = ratings.get(nh);
            if (!rm.has(rater)) rm.set(rater, m[2].toLowerCase()); /* newest-first: first seen = latest */
          }
        }
        if (raw.length < 50) break;
      }
      for (const [ph, nm] of notesByPost) {
        const list = [...nm.values()].map(n => {
          const rm = ratings.get(n.hash) || new Map();
          let helpful = 0, notHelpful = 0;
          for (const v of rm.values()) { if (v === 'h') helpful++; else notHelpful++; }
          const my = rm.get(this.state.signerAddr) || this._myNoteRatings.get(n.hash) || null;
          return { ...n, helpful, notHelpful, score: helpful - notHelpful, myRating: my };
        }).sort((a, b) => b.score - a.score || b.ts - a.ts);
        this._noteData.set(ph, { notes: list, scannedAt: Date.now() });
      }
      if (this._noteData.size > 500) {
        const ks = [...this._noteData.keys()];
        for (let i = 0; i < ks.length - 500; i++) this._noteData.delete(ks[i]);
      }
      this._noteScanAt.set(channel, Date.now());
      this._refreshVisibleNotes();
    } finally { this._noteScanning.delete(channel); }
  }

  _refreshNoteSlot(postHash) {
    const slot = this.g('feed')?.querySelector(`.note-slot[data-note-host="${postHash}"]`);
    const post = this._postMap.get(postHash);
    if (slot && post) slot.innerHTML = this._noteHTML(post);
  }

  _refreshVisibleNotes() {
    this.g('feed')?.querySelectorAll('.note-slot[data-note-host]').forEach(slot => {
      const post = this._postMap.get(slot.dataset.noteHost);
      if (post) slot.innerHTML = this._noteHTML(post);
    });
  }

  _noteHTML(post) {
    const data = this._noteData.get(post.txHash);
    if (!data || !data.notes.length) return '';
    const top = data.notes[0];
    const bodyHtml = utils.safe(top.text).replace(/\n/g, '<br>');
    if (top.score >= NOTE_SHOW_THRESHOLD) {
      return `<div class="note-card">
        <div class="note-card-hdr">🛈 Readers added context</div>
        <div class="note-card-body">${bodyHtml}</div>
        ${this._noteRateRow(top)}
      </div>`;
    }
    if (!this._expandedNotes.has(post.txHash)) {
      const n = data.notes.length;
      return `<button class="note-pending-toggle" data-note-expand="${utils.safe(post.txHash)}">🛈 ${n} community note${n > 1 ? 's' : ''} proposed — review &amp; rate</button>`;
    }
    return `<div class="note-card note-card-pending">
      <div class="note-card-hdr">🛈 Proposed note${data.notes.length > 1 ? ` · top of ${data.notes.length}` : ''}</div>
      <div class="note-card-body">${bodyHtml}</div>
      ${this._noteRateRow(top)}
      <button class="note-pending-toggle" data-note-expand="${utils.safe(post.txHash)}" style="margin-top:6px">Hide</button>
    </div>`;
  }

  _noteRateRow(note) {
    const mine = note.myRating;
    return `<div class="note-rate-row">
      <span class="note-score">${note.helpful} found helpful</span>
      <button class="note-rate-btn${mine === 'h' ? ' on' : ''}" data-note-rate="${utils.safe(note.hash)}" data-note-val="h">Helpful</button>
      <button class="note-rate-btn${mine === 'n' ? ' on' : ''}" data-note-rate="${utils.safe(note.hash)}" data-note-val="n">Not helpful</button>
    </div>`;
  }

  openNoteComposer(post) {
    if (!this.signer) { utils.toast('Connect wallet to write a note'); return; }
    this._showGenericModal('Write a community note', `
      <p style="font-size:13px;color:var(--muted);margin-bottom:10px">Add context to this post. Notes are public and permanent on-chain. A note becomes publicly visible once enough readers rate it Helpful.</p>
      <textarea class="form-textarea" id="note-text" placeholder="Add context — cite a source if you can…" maxlength="280" rows="4" style="width:100%"></textarea>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn-pri" id="note-submit-btn">Publish note</button>
        <button class="btn-ghost" id="note-cancel-btn">Cancel</button>
      </div>
    `);
    document.getElementById('note-cancel-btn').onclick = () => this._closeGenericModal();
    document.getElementById('note-submit-btn').onclick = () => this._submitNote(post);
  }

  async _submitNote(post) {
    const txt = document.getElementById('note-text')?.value.trim();
    if (!txt) { utils.toast('Write something first'); return; }
    const channel = post.to || post.channel || this.state.channel;
    const body = `${NOTE_PREFIX}${post.txHash}\n\n${txt}`;
    this._closeGenericModal();
    try {
      utils.toast('Publishing note…');
      const tx = await this._sendTagged(channel, body);
      /* Optimistic: show our note as pending immediately. */
      const data = this._noteData.get(post.txHash) || { notes: [], scannedAt: 0 };
      data.notes.unshift({ hash: (tx.hash || '').toLowerCase(), author: this.state.signerAddr,
        text: txt, ts: Date.now(), helpful: 0, notHelpful: 0, score: 0, myRating: null });
      this._noteData.set(post.txHash, data);
      this._expandedNotes.add(post.txHash);
      this._refreshNoteSlot(post.txHash);
      await tx.wait();
      utils.toast('Note published ✓');
      this._noteScanAt.delete(channel); /* allow a fresh scan to pick it up */
    } catch (err) {
      const msg = err.reason || err.message || 'Error';
      const rej = err.code === 4001 || err.code === 'ACTION_REJECTED' || /reject|denied/i.test(msg);
      utils.toast(rej ? 'Note cancelled' : 'Note failed: ' + msg);
    }
  }

  _applyLocalRating(postHash, noteHash, oldVal, newVal) {
    const data = this._noteData.get(postHash); if (!data) return;
    const note = data.notes.find(n => n.hash === noteHash); if (!note) return;
    if (oldVal === 'h') note.helpful = Math.max(0, note.helpful - 1);
    else if (oldVal === 'n') note.notHelpful = Math.max(0, note.notHelpful - 1);
    if (newVal === 'h') note.helpful++;
    else if (newVal === 'n') note.notHelpful++;
    note.score = note.helpful - note.notHelpful;
    note.myRating = newVal || null;
    data.notes.sort((a, b) => b.score - a.score || b.ts - a.ts);
  }

  async rateNote(noteHash, val, postHash) {
    if (!this.signer) { utils.toast('Connect wallet to rate notes'); return; }
    if (!noteHash || !postHash) return;
    const post = this._postMap.get(postHash);
    const channel = post ? (post.to || post.channel || this.state.channel) : this.state.channel;
    const prev = this._myNoteRatings.get(noteHash);
    if (prev === val) { utils.toast('Already rated'); return; }
    /* Optimistic apply + refresh. */
    this._myNoteRatings.set(noteHash, val);
    this._applyLocalRating(postHash, noteHash, prev, val);
    this._refreshNoteSlot(postHash);
    try {
      const tx = await this._sendTagged(channel, `${NOTERATE_PREFIX}${noteHash}:${val}`);
      utils.toast('Rating submitted ✓');
      await tx.wait();
      this._noteScanAt.delete(channel);
    } catch (err) {
      const msg = err.reason || err.message || 'Error';
      const rej = err.code === 4001 || err.code === 'ACTION_REJECTED' || /reject|denied/i.test(msg);
      utils.toast(rej ? 'Rating cancelled' : 'Rating failed: ' + msg);
      /* Roll back the optimistic rating. */
      if (prev !== undefined) this._myNoteRatings.set(noteHash, prev); else this._myNoteRatings.delete(noteHash);
      this._applyLocalRating(postHash, noteHash, val, prev);
      this._refreshNoteSlot(postHash);
    }
  }
};
for (const k of Object.getOwnPropertyNames(_NOTES.prototype)) {
  if (k !== 'constructor') SayIt.prototype[k] = _NOTES.prototype[k];
}
