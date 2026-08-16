// Dictation, routed through the user's own browser.
//
// Why this exists at all: a VS Code webview cannot record audio. Its iframe is
// built with allow="cross-origin-isolated; autoplay; local-network-access;
// clipboard-read; clipboard-write;" — no `microphone` — so Permissions Policy
// bars getUserMedia and speech recognition at the document level, and only VS
// Code can change that (microsoft/vscode#250568, still open). Electron
// compounds it: the recognition backend is keyed to Chrome, so even a permitted
// microphone ends in a 'network' error. Neither is reachable from extension
// code.
//
// Recognising in the extension host instead was tried and reverted. Windows
// ships System.Speech, which needs no install and no key, and it is not good
// enough to dictate a sentence with — the desktop recogniser it uses predates
// neural speech models by a decade. A browser's recogniser is the one that
// actually works, so this serves one page on loopback, opens it in the default
// browser, and the transcript is posted back into the prompt box for review.
// Nothing is ever sent to the model automatically.
//
// It also has a property nothing local does: over SSH, Dev Containers and
// Codespaces, asExternalUri forwards the port to the machine the microphone is
// actually on. Dictation keeps working there.
//
// The socket is the reason this file is careful. It is a listening port on the
// user's machine, opened by an extension whose whole security story is about
// not being tricked into talking to things:
//   * bound to 127.0.0.1 — never a routable interface;
//   * an ephemeral port, so nothing is guessable by convention;
//   * a 256-bit token required by every route, compared in constant time;
//   * Host and Origin pinned to our own origin, so a page in the user's
//     browser cannot reach it by DNS rebinding even knowing the port;
//   * bodies capped, no CORS headers, and the whole server torn down the
//     moment dictation ends or goes idle.

const http = require('http');
const crypto = require('crypto');

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

// Guessing this is not meaningfully easier than guessing a session key.
function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Timing-safe even though a token leak here costs little — the comparison is
// the kind of thing that gets copied into somewhere it matters.
function tokenMatches(expected, given) {
  const a = Buffer.from(String(expected || ''), 'utf8');
  const b = Buffer.from(String(given || ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

// A browser that reached us through a hostname we did not choose is a browser
// following someone else's DNS. Only the two names that can only mean loopback
// are accepted, and the port must be ours.
function hostAllowed(hostHeader, port) {
  if (!hostHeader) return false;
  const host = String(hostHeader).trim().toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

// Cross-site POSTs carry an Origin the browser sets and script cannot forge.
// Same-origin fetch sends it too, so anything other than our own origin — or a
// non-browser client that sends none — is refused.
function originAllowed(originHeader, port) {
  if (originHeader === undefined || originHeader === null) return true;
  const origin = String(originHeader).trim().toLowerCase();
  if (origin === 'null' || origin === '') return false;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function isLoopbackAddress(addr) {
  if (!addr) return false;
  const a = String(addr);
  return a === '::1' || a === '127.0.0.1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { finish(null); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(null); }
    });
    req.on('error', () => finish(null));
  });
}

/**
 * One dictation session. Constructed per use and disposed when it ends — the
 * server does not outlive the microphone.
 *
 * @param {object} handlers
 * @param {(text: string, done: boolean) => void} handlers.onTranscript
 * @param {(state: string) => void} [handlers.onState] page reports 'open'|'listening'|'error'
 * @param {(reason: string) => void} [handlers.onEnd] fired exactly once
 * @param {number} [handlers.idleMs] silence after which the session self-closes
 */
class DictationBridge {
  constructor({ onTranscript, onState, onEnd, idleMs = DEFAULT_IDLE_MS } = {}) {
    this.onTranscript = onTranscript || (() => {});
    this.onState = onState || (() => {});
    this.onEnd = onEnd || (() => {});
    this.idleMs = idleMs;
    this.token = makeToken();
    this.server = null;
    this.port = 0;
    this._idleTimer = null;
    this._ended = false;
    // Highest sequence number accepted from the page. Transcript posts are
    // fire-and-forget fetches and the network does not promise to deliver them
    // in the order they were sent, so without this an older, SHORTER transcript
    // arriving late would overwrite a newer one and the prompt box would
    // visibly lose words the user had already said.
    this._lastSeq = -1;
    // What the extension wants the page to be doing. Sent on every /events
    // connect rather than only when it changes, so an instruction issued while
    // the page's EventSource was reconnecting is not silently lost — the page
    // reconciles to this state instead of replaying a queue of commands.
    this.desired = 'listening';
    this._clients = new Set(); // open SSE responses
  }

  get running() { return !!this.server; }

  /** Asks the page to stop. No-op once the session has ended. */
  setDesired(state) {
    if (this._ended || !this.server) return;
    this.desired = state;
    this._broadcast();
  }

  _broadcast() {
    const frame = `data: ${JSON.stringify({ desired: this.desired })}\n\n`;
    for (const res of this._clients) {
      try { res.write(frame); } catch { this._clients.delete(res); }
    }
  }

  /** Starts listening on loopback. Resolves with the URL to open. */
  start() {
    if (this.server) return Promise.resolve(this.url());
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      // A client that connects and then says nothing must not hold the port.
      server.headersTimeout = 10_000;
      server.requestTimeout = 30_000;
      server.on('error', (err) => { this._teardown(); reject(err); });
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        this._touch();
        resolve(this.url());
      });
    });
  }

  url() { return `http://127.0.0.1:${this.port}/?t=${this.token}`; }

  /** Ends the session. Safe to call twice; onEnd fires only once. */
  stop(reason = 'stopped') {
    const wasRunning = !!this.server || !this._ended;
    this._teardown();
    if (wasRunning && !this._ended) {
      this._ended = true;
      try { this.onEnd(reason); } catch { /* a listener must not keep the port open */ }
    }
  }

  _teardown() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    // Tell any open page it is over BEFORE the socket dies, so it stops the
    // microphone and says so rather than showing a connection error.
    this.desired = 'ended';
    this._broadcast();
    for (const res of this._clients) { try { res.end(); } catch { /* already gone */ } }
    this._clients.clear();
    const server = this.server;
    this.server = null;
    if (server) { try { server.close(); } catch { /* already closing */ } try { server.closeAllConnections?.(); } catch { /* older Node */ } }
  }

  // Any accepted request resets the clock: a session ends because the user
  // walked away, not because they spoke for longer than five minutes.
  _touch() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (!this.idleMs) return;
    this._idleTimer = setTimeout(() => this.stop('timeout'), this.idleMs);
    this._idleTimer.unref?.();
  }

  _deny(res, code = 404) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not found');
  }

  async _handle(req, res) {
    try {
      if (!isLoopbackAddress(req.socket?.remoteAddress)) return this._deny(res, 403);
      if (!hostAllowed(req.headers.host, this.port)) return this._deny(res, 403);

      const url = new URL(req.url, `http://127.0.0.1:${this.port}`);

      if (req.method === 'GET' && url.pathname === '/') {
        if (!tokenMatches(this.token, url.searchParams.get('t'))) return this._deny(res);
        this._touch();
        const body = renderPage(this.token);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          // The page needs nothing from the network but this same origin, and
          // its own inline script is admitted by nonce rather than by
          // 'unsafe-inline' — which would admit any injected script too.
          'Content-Security-Policy':
            `default-src 'none'; script-src 'nonce-${body.nonce}'; style-src 'nonce-${body.nonce}'; `
            + "connect-src 'self'; base-uri 'none'; form-action 'none'",
        });
        return res.end(body.html);
      }

      // Control channel. Without it the panel's own Stop closed the port and
      // left the page still listening — the extension could receive words but
      // could not say anything back. Server-Sent Events because it is one-way,
      // plain HTTP on a socket that is already open, and EventSource reconnects
      // by itself; a WebSocket would buy nothing here.
      if (req.method === 'GET' && url.pathname === '/events') {
        if (!tokenMatches(this.token, url.searchParams.get('t'))) return this._deny(res);
        this._touch();
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive',
          'X-Content-Type-Options': 'nosniff',
        });
        // Nothing must idle this socket shut underneath a stream that is
        // deliberately quiet between commands.
        req.socket.setTimeout(0);
        this._clients.add(res);
        res.on('close', () => this._clients.delete(res));
        res.write(`retry: 2000\n\n`);
        res.write(`data: ${JSON.stringify({ desired: this.desired })}\n\n`);
        // The page being connected at all is what tells the panel the browser
        // is genuinely open, rather than "we asked the OS to open something".
        try { this.onState('open'); } catch { /* keep serving */ }
        return;
      }

      if (req.method === 'POST' && (url.pathname === '/transcript' || url.pathname === '/state' || url.pathname === '/end')) {
        if (!originAllowed(req.headers.origin, this.port)) return this._deny(res, 403);
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return this._deny(res, 415);
        const body = await readJsonBody(req);
        if (!body || !tokenMatches(this.token, body.token)) return this._deny(res);
        this._touch();

        if (url.pathname === '/transcript') {
          // Out-of-order delivery is dropped rather than applied — see _lastSeq.
          // A post with no seq at all is accepted, so an older page still works.
          const seq = typeof body.seq === 'number' ? body.seq : null;
          if (seq !== null && seq <= this._lastSeq) {
            res.writeHead(204, { 'Cache-Control': 'no-store' });
            return res.end();
          }
          if (seq !== null) this._lastSeq = seq;
          const text = typeof body.text === 'string' ? body.text.slice(0, 20_000) : '';
          try { this.onTranscript(text, !!body.done); } catch { /* keep serving */ }
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          return res.end();
        }

        if (url.pathname === '/state') {
          const state = typeof body.state === 'string' ? body.state.slice(0, 40) : '';
          if (state) { try { this.onState(state); } catch { /* keep serving */ } }
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          return res.end();
        }

        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        // Close after the response is on the wire, so the page sees success
        // rather than a connection reset it would report as a failure.
        return setTimeout(() => this.stop('finished'), 0).unref?.();
      }

      return this._deny(res);
    } catch {
      try { this._deny(res, 400); } catch { /* socket already gone */ }
    }
  }
}

// The page. Deliberately one self-contained string: it is served to a real
// browser over loopback with a strict CSP and pulls in nothing.
// Returns { html, nonce } — the nonce belongs in the CSP header the response
// carries, so the two can never drift apart.
//
// There is no Pause. The recogniser has no pause of its own, so it was
// implemented by tearing the engine down and building a new one, and the gap
// swallowed whatever was said across it. Start and Send are the two things this
// page actually needs.
function renderPage(token) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Navy — Dictation</title>
<style nonce="${nonce}">
  :root { color-scheme: dark light; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
         background:#1e1e1e; color:#e7e7e7; }
  main { width:min(560px,92vw); text-align:center; padding:32px 24px; }
  h1 { font-size:17px; font-weight:600; margin:0 0 6px; letter-spacing:.2px; }
  p.sub { margin:0 0 26px; font-size:13px; opacity:.6; }
  #transcript { min-height:96px; padding:16px; border-radius:10px; background:#252526;
                border:1px solid #3c3c3c; text-align:left; font-size:15px; line-height:1.55;
                white-space:pre-wrap; word-break:break-word; }
  #transcript:empty::before { content:'Your words appear here, and in Navy as you speak.'; opacity:.35; }
  #interim { opacity:.5; }
  .row { display:flex; gap:10px; justify-content:center; margin-top:22px; }
  button { font:inherit; font-size:13px; padding:9px 20px; border-radius:6px; cursor:pointer;
           border:1px solid #3c3c3c; background:#333; color:#e7e7e7; }
  button:hover:not(:disabled) { background:#3d3d3d; }
  button.primary { background:#0e639c; border-color:#0e639c; color:#fff; }
  button.primary:hover:not(:disabled) { background:#1177bb; }
  button:disabled { opacity:.4; cursor:default; }
  #status { margin-top:18px; font-size:12px; min-height:16px; opacity:.65; }
  .err { color:#f48771 !important; opacity:1 !important; }
  .note { margin-top:26px; font-size:11px; opacity:.4; line-height:1.5; }
</style>
</head>
<body>
<main>
  <h1>Dictate to Navy</h1>
  <p class="sub">Your editor can't reach the microphone — this tab can.</p>
  <div id="transcript"><span id="committed"></span><span id="interim"></span></div>
  <div class="row">
    <button id="start" class="primary">Start talking</button>
    <button id="done" disabled>Send to Navy</button>
  </div>
  <div id="status"></div>
  <p class="note">Text goes to Navy's prompt box for you to review — it is never sent to the model from here.
     Speech recognition is your browser's, which uploads audio to its own service.</p>
</main>
<script nonce="${nonce}">
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  var committedEl = document.getElementById('committed');
  var interimEl = document.getElementById('interim');
  var startBtn = document.getElementById('start');
  var doneBtn = document.getElementById('done');
  var statusEl = document.getElementById('status');
  var rec = null, committed = '', listening = false, ended = false;
  var seq = 0;            // see _lastSeq on the server
  var pushTimer = null, pendingInterim = '';

  function say(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.className = isError ? 'err' : '';
  }

  // Every post carries the whole transcript, so a dropped one costs nothing:
  // the next post makes Navy correct again.
  function post(path, body, onFail) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ token: TOKEN }, body)),
    }).catch(function () { if (onFail) onFail(); });
  }

  function report(state) { post('/state', { state: state }); }

  function send(interim, done) {
    var text = (committed + (interim ? ' ' + interim : '')).trim();
    seq += 1;
    post('/transcript', { text: text, done: !!done, seq: seq }, function () {
      if (!ended) say('Lost contact with Navy — is the panel still open?', true);
    });
  }

  // Interim results fire many times a second and each one used to be its own
  // request. That is what made dictation look unreliable: dozens of in-flight
  // posts racing each other, arriving out of order, so the prompt box jittered
  // between older and newer guesses. Only the revisable interim guess is
  // coalesced onto a trailing post; 'settled' (the engine finalised a phrase)
  // and 'done' (the user pressed Send) both go immediately, because those are
  // the moments the user is watching the text stop moving.
  function push(interim, done, settled) {
    if (done || settled) {
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      pendingInterim = '';
      send(interim, !!done);
      return;
    }
    pendingInterim = interim;
    if (pushTimer) return;
    pushTimer = setTimeout(function () {
      pushTimer = null;
      send(pendingInterim, false);
    }, 250);
  }

  if (!Rec) {
    startBtn.disabled = true;
    say('This browser has no speech recognition. Chrome or Edge does.', true);
    report('error');
    return;
  }

  function begin() {
    rec = new Rec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';

    rec.onresult = function (event) {
      var interim = '', settled = false;
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var phrase = event.results[i][0] ? event.results[i][0].transcript : '';
        if (event.results[i].isFinal) { committed += (committed ? ' ' : '') + phrase.trim(); settled = true; }
        else interim += phrase;
      }
      committedEl.textContent = committed;
      interimEl.textContent = interim ? (committed ? ' ' : '') + interim : '';
      push(interim, false, settled);
    };

    rec.onerror = function (event) {
      var err = event && event.error;
      if (err === 'aborted' || err === 'no-speech') return;
      listening = false;
      startBtn.disabled = false;
      say(err === 'not-allowed'
        ? 'Microphone permission was denied. Allow it for this page and try again.'
        : 'Speech recognition failed (' + err + ').', true);
      report('error');
    };

    // The engine stops on its own after a lull; keep going unless the user
    // asked it not to, so a pause in speech isn't the end of the session.
    rec.onend = function () { if (listening) { try { rec.start(); } catch (e) { /* already restarting */ } } };

    try { rec.start(); } catch (e) { say('Could not start the microphone.', true); report('error'); return; }
    listening = true;
    startBtn.disabled = true;
    doneBtn.disabled = false;
    say('Listening…');
    report('listening');
  }

  function finish(fromNavy) {
    if (ended) return;
    ended = true;
    listening = false;
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    try { rec && rec.stop(); } catch (e) {}
    // A stop that came FROM Navy arrives as the server is already tearing the
    // port down, so posting into it would only produce a "lost contact" error
    // about a disconnection the user asked for. Navy already holds every
    // transcript posted up to this moment.
    if (!fromNavy) { push('', true, true); post('/end', {}); }
    startBtn.disabled = true;
    doneBtn.disabled = true;
    say(fromNavy ? 'Stopped from Navy — you can close this tab.' : 'Sent to Navy — you can close this tab.');
  }

  startBtn.addEventListener('click', begin);
  doneBtn.addEventListener('click', function () { finish(false); });

  // Navy's own Stop, arriving over the control channel. Expressed as the state
  // the panel WANTS rather than as a command, so reconnecting after a dropped
  // stream re-applies the current intent instead of losing what was sent while
  // the page was offline.
  try {
    var events = new EventSource('/events?t=' + encodeURIComponent(TOKEN));
    events.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.desired === 'ended') { events.close(); finish(true); }
    };
  } catch (e) { /* the page still works on its own buttons */ }

  // Closing the tab is a perfectly good way to end dictation; tell the
  // extension so the port doesn't sit open waiting for a page that is gone.
  window.addEventListener('pagehide', function () {
    if (ended) return;
    ended = true;
    try {
      var payload = new Blob([JSON.stringify({ token: TOKEN })], { type: 'application/json' });
      navigator.sendBeacon('/end', payload);
    } catch (e) { /* the idle timeout is the backstop */ }
  });
})();
</script>
</body>
</html>`;
  return { html, nonce };
}

module.exports = { DictationBridge, tokenMatches, hostAllowed, originAllowed, isLoopbackAddress, renderPage };
