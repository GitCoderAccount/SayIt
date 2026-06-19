'use strict';
/* polls.js — the on-chain poll engine, split out of app.js. Parsing
   (_parsePoll), vote capture/tally (_captureVote / _recordVote / _pollTally /
   _ensurePollTally / _tallyPoll / _tallyVisiblePolls), rendering (_pollHTML /
   _refreshPollBlock / _pollIsClosed / _pollTimeLeft) and casting a vote
   (votePoll). The poll *composer* (openPollComposer / _createPoll) is a compose
   concern and will move to compose.js with the other "open a composer" methods.

   Boot-order safety (the constraint from settings.js/profile.js): every method
   here is reached only from feed/post rendering (which runs after init()'s
   awaits) or a deferred handler — never init()'s synchronous prefix, which runs
   at app.js eval time before this file loads.

   Augments SayIt.prototype (defined in app.js); load order is
   core -> cache -> app -> settings -> profile -> polls -> embeds -> dm. The
   throwaway class keeps method syntax clean; its methods are copied onto
   SayIt.prototype. Cross-refs (`utils`, `POLL_PREFIX`, `this._postMap`,
   `this.cache`, ...) resolve via the shared classic-script scope or the
   prototype, so nothing is imported. */
const _POLLS = class {
  /* ── POLLS ──────────────────────────────────────────────────────────
     Encoding: POLL:{"q":"...","o":["opt",...],"e":endMs}\n\nQuestion
     A vote is a separate tx: VOTE:<pollHash>:<optionIndex> to the channel. */

  /* Parse a POLL: payload into { question, options[], endMs } or null. */
  _parsePoll(raw) {
    if (!raw.startsWith(POLL_PREFIX)) return null;
    try {
      /* Payload is the first line after the prefix; question follows \n\n. */
      const rest = raw.slice(POLL_PREFIX.length);
      const nl   = rest.indexOf('\n\n');
      const jsonPart = nl >= 0 ? rest.slice(0, nl) : rest;
      const obj = JSON.parse(jsonPart);
      if (!obj || !Array.isArray(obj.o) || obj.o.length < 2) return null;
      const question = (nl >= 0 ? rest.slice(nl + 2) : (obj.q || '')).trim();
      return {
        question: question || obj.q || 'Poll',
        options: obj.o.slice(0, 4).map(s => String(s).slice(0, 60)),
        endMs: Number(obj.e) || 0,
      };
    } catch { return null; }
  }

  _pollIsClosed(poll) {
    return poll.endMs > 0 && Date.now() > poll.endMs;
  }

  _pollTimeLeft(poll) {
    if (!poll.endMs) return '';
    const ms = poll.endMs - Date.now();
    if (ms <= 0) return 'Final results';
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m left`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h left`;
    return `${Math.floor(hrs / 24)}d left`;
  }

  /* Pull a VOTE tx into the running vote accumulator. Called from the feed
     parsers (parseTxs / _parsePostTx) so votes are tallied from the channel
     scan the feed already performs — no separate per-poll re-scan needed. */
  _captureVote(text, tx) {
    const m = text.match(/^VOTE:(0x[a-f0-9]{64}):(\d+)/i);
    if (!m) return;
    this._recordVote(m[1].toLowerCase(), tx.from?.toLowerCase(), Number(m[2]),
      Number(tx.timeStamp) ? Number(tx.timeStamp) * 1000 : 0);
  }
  /* Upsert a single vote, newest-wins by timestamp. */
  _recordVote(pollHash, voter, optIdx, ts) {
    if (!pollHash || !voter || !Number.isInteger(optIdx) || optIdx < 0) return;
    /* A poll closes at endMs — a vote mined after it is invalid, so drop it
       entirely (don't let it overwrite a valid earlier vote via newest-wins).
       endMs is known once the poll has been parsed/tallied; votes captured
       before that are filtered at tally time instead. ts===0 = unknown time,
       treated as valid. */
    const end = this._pollEndMs.get(pollHash);
    if (end && ts && ts > end) return;
    let m = this._voteAccum.get(pollHash);
    if (!m) { m = new Map(); this._voteAccum.set(pollHash, m); }
    const prev = m.get(voter);
    if (!prev || ts >= prev.ts) m.set(voter, { optIdx, ts });
  }
  /* Aggregate the accumulated votes for one poll into the render shape
     { counts:[n per option], voters:Map(addr→optIdx), total }. Out-of-range
     option indexes (malformed/older polls) are ignored. */
  _pollTally(post) {
    const poll     = post && post.poll;
    const optCount = poll ? poll.options.length : 0;
    const endMs    = poll ? poll.endMs : 0;
    /* Remember this poll's close time so _recordVote can drop later late votes
       at the source (prevents a post-close re-vote clobbering a valid one). */
    if (endMs) this._pollEndMs.set(post.txHash, endMs);
    const counts = new Array(optCount).fill(0);
    const voters = new Map();
    const accum = this._voteAccum.get(post.txHash);
    if (accum) {
      for (const [voter, v] of accum) {
        if (v.optIdx < 0 || v.optIdx >= optCount) continue;
        /* Poll closed before this vote was mined → it doesn't count. Catches
           votes captured before endMs was known (record-time gate handles the
           rest). ts===0 = unknown time, kept. */
        if (endMs && v.ts && v.ts > endMs) continue;
        voters.set(voter, v.optIdx);
        counts[v.optIdx]++;
      }
    }
    return { counts, voters, total: voters.size };
  }
  /* Render a poll from already-accumulated votes (instant), then cold-scan
     the channel ONLY if we've seen no votes for it yet — i.e. the poll was
     opened directly before the feed scanned its channel. Polls the feed has
     already paged past never trigger a scan, so there's no double-scan. */
  _ensurePollTally(post) {
    if (!post || !post.poll) return;
    this._refreshPollBlock(post.txHash);
    const haveVotes = (this._voteAccum.get(post.txHash)?.size || 0) > 0;
    const last = this._pollScanned.get(post.txHash) || 0;
    if (!haveVotes && Date.now() - last >= 60000) {
      this._tallyPoll(post).then(() => this._refreshPollBlock(post.txHash)).catch(() => {});
    }
  }
  /* Cold-scan fallback: scan the poll's channel for VOTE txs and feed them
     into the accumulator. Used only when a poll is viewed without the feed
     having scanned its channel. Honors the user's Max scan depth setting
     (votes can be sparse across many pages), with an empty-streak early-out
     so quiet channels don't always scan to the full depth. */
  async _tallyPoll(post) {
    const hash = post.txHash;
    if (this._pollScanning.has(hash)) return;
    const last = this._pollScanned.get(hash) || 0;
    if (Date.now() - last < 60000) return;
    this._pollScanning.add(hash);
    const channel  = post.to || post.channel || this.state.channel;
    const optCount = post.poll ? post.poll.options.length : 0;
    try {
      const scanLimit = this._getMaxScanPages();
      let emptyStreak = 0;
      for (let page = 1; page <= scanLimit; page++) {
        let raw;
        try { raw = await this.apiFetch(channel, page); }
        catch { break; }
        let any = false;
        for (const tx of raw) {
          if (!tx.input || tx.input === '0x') continue;
          let text;
          try { text = ethers.toUtf8String(tx.input).trim(); }
          catch { continue; }
          if (!text.startsWith(VOTE_PREFIX)) continue;
          const m = text.match(/^VOTE:(0x[a-f0-9]{64}):(\d+)/i);
          if (!m || m[1].toLowerCase() !== hash) continue;
          const optIdx = Number(m[2]);
          if (optIdx < 0 || optIdx >= optCount) continue;
          const voter = tx.from?.toLowerCase();
          if (!voter) continue;
          this._recordVote(hash, voter, optIdx,
            Number(tx.timeStamp) ? Number(tx.timeStamp) * 1000 : 0);
          any = true;
        }
        if (raw.length < 50) break;
        emptyStreak = any ? 0 : emptyStreak + 1;
        if (emptyStreak >= 5) break; /* quiet run — likely past all votes */
      }
      this._pollScanned.set(hash, Date.now());
      this._prunePollMaps();
      /* Surface the user's own vote so the vote buttons stay hidden. */
      const mine = this._voteAccum.get(hash)?.get(this.state.signerAddr)?.optIdx;
      if (mine !== undefined && !this._myVotes.has(hash)) this._myVotes.set(hash, mine);
    } finally {
      this._pollScanning.delete(hash);
    }
  }

  /* Build the poll UI for a post, reading counts from votes already captured
     during the feed scan (see _pollTally). Mounting triggers _ensurePollTally
     for the cold-open fallback; this function itself does no fetching. */
  _pollHTML(post) {
    const poll = post.poll;
    if (!poll) return '';
    const tally = this._pollTally(post);
    /* Prefer the session record (instant) over the accumulator. This stops
       the vote buttons from showing — and inviting a re-vote — before the
       user's own vote rides back in on a scan. */
    const sessionVote = this._myVotes.get(post.txHash);
    const myVote = sessionVote !== undefined
      ? sessionVote
      : tally.voters.get(this.state.signerAddr);
    const closed = this._pollIsClosed(poll);
    const showResults = closed || myVote !== undefined;
    const total = tally.total;
    const optsHTML = poll.options.map((opt, i) => {
      const count = tally.counts[i] || 0;
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      const isMine = myVote === i;
      if (showResults) {
        return `
          <div class="poll-result-row">
            <div class="poll-result-bar" style="width:${pct}%"></div>
            <div class="poll-result-label">
              <span>${utils.safe(opt)} ${isMine ? '✓' : ''}</span>
              <span>${pct}%</span>
            </div>
          </div>`;
      }
      return `
        <button class="poll-vote-btn" data-poll-vote="${i}" data-poll-hash="${utils.safe(post.txHash)}">
          ${utils.safe(opt)}
        </button>`;
    }).join('');
    const meta = `${total} vote${total === 1 ? '' : 's'}${poll.endMs ? ' · ' + this._pollTimeLeft(poll) : ''}`;
    return `
      <div class="poll-block" data-poll-container="${utils.safe(post.txHash)}">
        ${optsHTML}
        <div class="poll-meta">${meta}</div>
      </div>`;
  }

  /* Cast a vote: send VOTE:<pollHash>:<idx> to the poll's channel. */
  async votePoll(pollHash, optIdx) {
    if (!this.signer) { utils.toast('Connect wallet to vote'); return; }
    const post = this._postMap.get(pollHash);
    if (!post || !post.poll) { utils.toast('Poll not found'); return; }
    if (this._pollIsClosed(post.poll)) { utils.toast('This poll has ended'); return; }
    /* Already voted this option this session? No-op (last-vote-wins still
       allows changing, but re-submitting the same choice is pointless). */
    if (this._myVotes.get(pollHash) === optIdx) {
      utils.toast('You already voted for this option');
      return;
    }
    /* Optimistically record our vote (session + accumulator) so the UI flips
       to results and the buttons disappear immediately — prevents accidental
       double-clicks while the tx is in flight. Remember any prior choice so
       we can restore it on error. */
    const prevVote = this._myVotes.get(pollHash);
    this._myVotes.set(pollHash, optIdx);
    this._recordVote(pollHash, this.state.signerAddr, optIdx, Date.now());
    this._refreshPollBlock(pollHash);
    const channel = post.to || post.channel || this.state.channel;
    const body = `${VOTE_PREFIX}${pollHash}:${optIdx}`;
    try {
      const data  = ethers.hexlify(ethers.toUtf8Bytes(body));
      const gas   = await this._estimateGasSafe({ to: channel, value: '0', data }, (data.length - 2) / 2);
      const tx    = await this.signer.sendTransaction({ to: channel, value: '0', data, gasLimit: gas });
      utils.toast('Vote submitted ✓ confirming on-chain…');
      await tx.wait();
      utils.toast('Vote confirmed ✓');
    } catch (err) {
      const msg = err.reason || err.message || 'Unknown error';
      const rejected = err.code === 4001 || err.code === 'ACTION_REJECTED' ||
        /user (denied|rejected)/i.test(msg);
      utils.toast(rejected ? 'Vote cancelled' : 'Vote failed: ' + msg);
      /* Roll back the optimistic vote in both the session map and the
         accumulator, restoring any previous choice rather than clearing it. */
      if (prevVote !== undefined) {
        this._myVotes.set(pollHash, prevVote);
        this._recordVote(pollHash, this.state.signerAddr, prevVote, Date.now());
      } else {
        this._myVotes.delete(pollHash);
        this._voteAccum.get(pollHash)?.delete(this.state.signerAddr);
      }
      this._refreshPollBlock(pollHash);
    }
  }

  /* Re-render just one poll's block in place (after voting or tally). */
  _refreshPollBlock(pollHash) {
    const post = this._postMap.get(pollHash);
    if (!post) return;
    document.querySelectorAll(`[data-poll-container="${pollHash}"]`).forEach(container => {
      const fresh = this._pollHTML(post);
      const tmp = document.createElement('div');
      tmp.innerHTML = fresh;
      const newBlock = tmp.firstElementChild;
      if (newBlock) container.replaceWith(newBlock);
    });
  }

  /* Scan the DOM for mounted poll posts and tally any not yet cached.
     Used by non-virtualized views (lists, threads, profiles) where
     _vfMountReal's per-mount tally doesn't run. */
  _tallyVisiblePolls() {
    document.querySelectorAll('[data-poll-container]').forEach(el => {
      const post = this._postMap.get(el.dataset.pollContainer);
      if (post && post.poll) this._ensurePollTally(post);
    });
  }
};
for (const k of Object.getOwnPropertyNames(_POLLS.prototype)) {
  if (k !== 'constructor') SayIt.prototype[k] = _POLLS.prototype[k];
}
