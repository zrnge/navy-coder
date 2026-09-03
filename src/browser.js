'use strict';

// Navy's zero-dependency browser controller.
//
// Drives a real Chrome/Edge/Chromium over the Chrome DevTools Protocol so the
// model can play through a website the way a human tester would — navigate,
// look, click, type, and read what the page reports. The transport is CDP over
// --remote-debugging-pipe: Chrome reads commands on inherited fd 3 and writes
// responses/events on fd 4, one UTF-8 JSON object per message, NUL-delimited.
// No WebSocket, no open debugging port, no npm package — which is the whole
// point: this feature exists BECAUSE Navy ships with no runtime dependencies,
// and a browser-automation library (Puppeteer/Playwright) would break that.
//
// Security posture: every launch runs Chrome in a throwaway --user-data-dir, so
// the test never touches the user's real cookies, sessions, or history; Chrome's
// own OS sandbox stays ON (we never pass --no-sandbox), so page code cannot reach
// the host; and only http(s) is navigable — file:// and other schemes are refused,
// so a page can't talk the browser into reading local files.
//
// The launch itself is gated once per browser session by navy.commandApproval —
// the run_command gate, not the file-edit one — because starting a browser is
// execution: it spawns a process and grants navigation plus arbitrary in-page
// JavaScript (browser_evaluate). See _ensureBrowser in extension.js. The
// individual interactions within a playthrough are deliberately NOT re-prompted;
// clicking through a site is the whole point of the feature.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Executable discovery ─────────────────────────────────────────────────────
// Ordered by preference: real Chrome, then Edge (Chromium under the hood on every
// current platform and near-universal on Windows), then a bare Chromium. A
// user-set navy.chromePath always wins over this list.
function chromeCandidates(platform = process.platform, env = process.env) {
  const p = (...parts) => parts.filter(Boolean).join(path.sep);
  if (platform === 'win32') {
    const pf = env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = env['LOCALAPPDATA'] || (env['USERPROFILE'] ? p(env['USERPROFILE'], 'AppData', 'Local') : '');
    return [
      p(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      p(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local && p(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      p(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      p(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      p(pf, 'Chromium', 'Application', 'chrome.exe'),
    ].filter(Boolean);
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      env['HOME'] ? p(env['HOME'], 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome') : '',
    ].filter(Boolean);
  }
  // Linux / other unix
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ];
}

function firstExisting(paths, existsSync = fs.existsSync) {
  for (const p of paths) { try { if (p && existsSync(p)) return p; } catch {} }
  return null;
}

// The launch argument list. An isolated temp profile, the automation-hygiene
// flags Chromium's own tooling uses to silence first-run noise and background
// chatter, a fixed window size so screenshots are reproducible, and the pipe
// transport. Deliberately NOT here: --no-sandbox (keeping Chrome's sandbox is
// what protects the host) and any --disable-web-security style flag.
function launchArgs({ userDataDir, headed = true, windowSize = '1280,800' }) {
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${windowSize}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-features=Translate,TranslateUI,MediaRouter,OptimizationHints',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-hang-monitor',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
  ];
  if (!headed) args.push('--headless=new', '--hide-scrollbars', '--mute-audio');
  // A blank start page rather than the new-tab page, which phones home to Google.
  args.push('about:blank');
  return args;
}

// ── NUL-delimited framing ────────────────────────────────────────────────────
// Split a running byte buffer into complete NUL-terminated frames, returning the
// parsed messages and whatever trailing bytes belong to the next (incomplete)
// frame. Pure, so the wire framing is unit-testable without a real Chrome.
function drainFrames(buf) {
  const frames = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      const slice = buf.slice(start, i);
      if (slice.length) {
        try { frames.push(JSON.parse(slice.toString('utf8'))); } catch {}
      }
      start = i + 1;
    }
  }
  return { frames, rest: buf.slice(start) };
}

// Roles the QA loop can act on. Everything else in a snapshot is context only.
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label', 'option']);

// The in-page snapshot script. Runs in the page's main world (via Runtime.evaluate,
// which is not subject to the page's CSP) and returns a compact list of the things
// a tester interacts with or reads: interactive controls, headings, and anything
// that looks like an error/alert. Each row carries a stable ref (its index into
// window.__navyRefs, which browser_click/browser_type resolve against) plus the
// element's centre point so a click lands where a real cursor would.
function snapshotScript(max) {
  return `(() => {
    const out = [];
    const refs = [];
    const seen = new Set();
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
      return r;
    };
    const label = (el) => {
      let t = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt'))) || '';
      if (!t) t = (el.value && el.type !== 'password') ? el.value : '';
      if (!t) t = (el.innerText || el.textContent || '').trim();
      return t.replace(/\\s+/g, ' ').slice(0, 80);
    };
    const role = (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'input') return (el.type || 'text') + '-input';
      if (tag === 'a') return 'link';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return el.getAttribute('role') || tag;
    };
    const interactive = (el) => {
      const tag = el.tagName.toLowerCase();
      if (${JSON.stringify([...INTERACTIVE_TAGS])}.includes(tag)) return true;
      if (el.getAttribute && (el.getAttribute('role') || el.getAttribute('onclick') != null)) return true;
      if (el.tabIndex >= 0 && tag !== 'body') return true;
      if (el.isContentEditable) return true;
      return false;
    };
    const noteworthy = (el) => {
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) return true;
      const role = (el.getAttribute && el.getAttribute('role')) || '';
      if (role === 'alert' || role === 'status') return true;
      const cls = (el.className && el.className.toString ? el.className.toString() : '') + ' ' + (el.id || '');
      if (/error|danger|invalid|warning|toast|alert/i.test(cls)) return true;
      return false;
    };
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (out.length >= ${max}) break;
      const act = interactive(el);
      if (!act && !noteworthy(el)) continue;
      const r = vis(el);
      if (!r) continue;
      const txt = label(el);
      if (!act && !txt) continue;
      const key = role(el) + '|' + txt + '|' + Math.round(r.left) + '|' + Math.round(r.top);
      if (seen.has(key)) continue;
      seen.add(key);
      const ref = refs.length;
      refs.push(el);
      out.push({ ref, role: role(el), text: txt, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), act });
    }
    window.__navyRefs = refs;
    return { title: document.title, url: location.href, nodes: out };
  })()`;
}

class Browser {
  constructor(opts = {}) {
    this.chromePath = opts.chromePath || null;
    this.headed = opts.headed !== false;
    this.windowSize = opts.windowSize || '1280,800';
    this.log = opts.log || (() => {});
    this._spawn = opts.spawn || spawn;
    this._existsSync = opts.existsSync || fs.existsSync;
    this._cmdTimeout = opts.commandTimeout || 30000;
    this._navTimeout = opts.navTimeout || 20000;

    this.proc = null;
    this.userDataDir = null;
    this.executablePath = null;
    this._nextId = 1;
    this._pending = new Map();   // id → { resolve, reject, timer }
    this._recv = Buffer.alloc(0);
    this._sessionId = null;      // the attached page target's flat session
    this._targetId = null;
    this._events = [];           // captured console / exceptions / failed requests
    this._loadWaiters = [];      // resolvers fired by Page.loadEventFired
    this._closed = false;
    this._launched = false;
  }

  get running() { return this._launched && !this._closed; }

  resolveExecutable() {
    if (this.chromePath) {
      if (this._existsSync(this.chromePath)) return this.chromePath;
      throw new Error(`navy.chromePath points at "${this.chromePath}", which does not exist.`);
    }
    const found = firstExisting(chromeCandidates(), this._existsSync);
    if (!found) {
      throw new Error('No Chrome, Edge, or Chromium found. Install Google Chrome, or set navy.chromePath to your browser executable.');
    }
    return found;
  }

  async launch() {
    if (this._launched) return;
    const exe = this.resolveExecutable();
    this.executablePath = exe;
    this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-browser-'));
    const args = launchArgs({ userDataDir: this.userDataDir, headed: this.headed, windowSize: this.windowSize });
    this.log(`Launching ${path.basename(exe)} (${this.headed ? 'headed' : 'headless'}) for playthrough`);

    // fds 1/2 are 'ignore', not 'pipe': Chrome's protocol rides only on 3/4, and
    // its stdout/stderr are just logs. Piping them without a drain would let the
    // ~64KB OS pipe buffer fill on a chatty Chrome and block it mid-write.
    // windowsHide hides only a stray console window — Chrome's GUI window (when
    // headed) is unaffected.
    this.proc = this._spawn(exe, args, {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this._launched = true;

    const writePipe = this.proc.stdio[3];  // Chrome reads commands here (its fd 3)
    const readPipe = this.proc.stdio[4];    // Chrome writes responses here (its fd 4)
    if (!writePipe || !readPipe) {
      // Chrome is already spawned at this point — leaving it running would orphan
      // a browser (and its temp profile) that nothing holds a handle to.
      this._launched = false;
      this._closed = true;
      this._killProc();
      this._cleanupProfile();
      throw new Error('Chrome did not expose the remote-debugging pipe (fd 3/4). This build may not support --remote-debugging-pipe.');
    }
    this._writePipe = writePipe;
    readPipe.on('data', (d) => this._onData(d));
    readPipe.on('error', () => {});
    this.proc.on('exit', () => this._onExit());
    this.proc.on('error', () => this._onExit());

    // Attach to a fresh page target with the flat protocol so every later command
    // just rides its sessionId — no nested Target.sendMessageToTarget wrapping.
    await this._send('Target.setDiscoverTargets', { discover: true });
    const { targetId } = await this._send('Target.createTarget', { url: 'about:blank' });
    this._targetId = targetId;
    const { sessionId } = await this._send('Target.attachToTarget', { targetId, flatten: true });
    this._sessionId = sessionId;

    await this._send('Page.enable', {}, sessionId);
    await this._send('Runtime.enable', {}, sessionId);
    await this._send('Log.enable', {}, sessionId);
    await this._send('Network.enable', {}, sessionId);
    await this._send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  }

  _onData(chunk) {
    this._recv = Buffer.concat([this._recv, chunk]);
    const { frames, rest } = drainFrames(this._recv);
    this._recv = rest;
    for (const msg of frames) this._dispatch(msg);
  }

  _dispatch(msg) {
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject, timer } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (timer) clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
      else resolve(msg.result || {});
      return;
    }
    if (msg.method) this._onEvent(msg.method, msg.params || {});
  }

  _onEvent(method, params) {
    switch (method) {
      case 'Page.loadEventFired': {
        const waiters = this._loadWaiters;
        this._loadWaiters = [];
        for (const w of waiters) w();
        break;
      }
      case 'Runtime.consoleAPICalled': {
        const text = (params.args || []).map(a => a.value != null ? String(a.value) : (a.description || a.type || '')).join(' ');
        this._record(params.type === 'error' ? 'console.error' : `console.${params.type || 'log'}`, text);
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails || {};
        const msg = d.exception?.description || d.text || 'Uncaught exception';
        this._record('pageerror', msg);
        break;
      }
      case 'Log.entryAdded': {
        const e = params.entry || {};
        if (e.level === 'error' || e.level === 'warning') this._record(`log.${e.level}`, `${e.text || ''}${e.url ? ' (' + e.url + ')' : ''}`);
        break;
      }
      case 'Network.responseReceived': {
        const r = params.response || {};
        if (r.status >= 400) this._record('network', `HTTP ${r.status} ${r.url || ''}`);
        break;
      }
      case 'Network.loadingFailed': {
        if (!params.canceled) this._record('network', `Request failed: ${params.errorText || 'unknown'} (${params.type || ''})`);
        break;
      }
    }
  }

  _record(kind, text) {
    if (!text) return;
    this._events.push({ kind, text: String(text).slice(0, 500), at: Date.now() });
    if (this._events.length > 500) this._events.shift();
  }

  _send(method, params = {}, sessionId = null) {
    if (this._closed) return Promise.reject(new Error('Browser is closed.'));
    const id = this._nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP timeout: ${method} did not respond in ${this._cmdTimeout}ms`));
        }
      }, this._cmdTimeout);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._writeFrame(payload);
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // Put one NUL-terminated JSON frame on the pipe. Split out of _send so a
  // fire-and-forget command (Browser.close, which Chrome answers by closing the
  // connection rather than replying) can be written without registering a
  // pending promise that would then sit until the command timeout.
  _writeFrame(payload) {
    this._writePipe.write(Buffer.concat([Buffer.from(JSON.stringify(payload), 'utf8'), Buffer.from([0])]));
  }

  _onExit() {
    if (this._closed) return;
    this._closed = true;
    for (const { reject, timer } of this._pending.values()) {
      if (timer) clearTimeout(timer);
      try { reject(new Error('Browser process exited.')); } catch {}
    }
    this._pending.clear();
    // Chrome died on its own (crash, user closed the window). Nothing else will
    // come back for the profile dir, so remove it here rather than leaking one
    // per playthrough.
    setTimeout(() => this._cleanupProfile(), 1500);
  }

  // Run an expression in the page and return the value by value. Throws on a
  // thrown JS exception so callers surface real page errors rather than undefined.
  async evaluate(expression, { awaitPromise = false } = {}) {
    const res = await this._send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, userGesture: true,
    }, this._sessionId);
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluation failed');
    }
    return res.result?.value;
  }

  async navigate(url) {
    // Resolve on whichever comes first: the load event, or the timeout for a page
    // that never fires one (a stalled subresource, an SPA that never completes).
    // Both paths clean up after themselves — an uncleared timer would keep the
    // event loop busy for the full timeout, and a timed-out waiter left in
    // _loadWaiters would sit there for the life of the browser.
    const done = new Promise((resolve) => {
      let timer = null;
      const waiter = () => { if (timer) clearTimeout(timer); resolve(); };
      this._loadWaiters.push(waiter);
      timer = setTimeout(() => {
        const i = this._loadWaiters.indexOf(waiter);
        if (i !== -1) this._loadWaiters.splice(i, 1);
        resolve();
      }, this._navTimeout);
    });
    const res = await this._send('Page.navigate', { url }, this._sessionId);
    if (res.errorText) throw new Error(`Navigation failed: ${res.errorText}`);
    await done;
    await new Promise(r => setTimeout(r, 400)); // brief settle for late scripts/SPAs
    return this.evaluate('({ title: document.title, url: location.href })');
  }

  // Reports whether it actually moved: at the first entry there is nothing to go
  // back to, and silently reporting success would have the model believe it
  // exercised a back-button it never pressed.
  async back() {
    const hist = await this._send('Page.getNavigationHistory', {}, this._sessionId);
    const idx = hist.currentIndex;
    let moved = false;
    if (idx > 0) {
      await this._send('Page.navigateToHistoryEntry', { entryId: hist.entries[idx - 1].id }, this._sessionId);
      await new Promise(r => setTimeout(r, 600));
      moved = true;
    }
    const info = await this.evaluate('({ title: document.title, url: location.href })');
    return { ...(info || {}), moved };
  }

  async screenshot() {
    const res = await this._send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, this._sessionId);
    return res.data; // base64 PNG
  }

  async snapshot(max = 150) {
    return this.evaluate(snapshotScript(max));
  }

  // Resolve a ref to its live element's centre, scroll it into view, and return
  // the point. Returns null when the ref is stale (the DOM changed since the last
  // snapshot) so callers can tell the model to snapshot again.
  async _refPoint(ref) {
    return this.evaluate(`(() => {
      const el = (window.__navyRefs || [])[${Number(ref)}];
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase() };
    })()`);
  }

  async click(ref) {
    const pt = await this._refPoint(ref);
    if (!pt) throw new Error(`ref ${ref} is stale — call browser_snapshot again to get fresh refs.`);
    await new Promise(r => setTimeout(r, 60));
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this._send('Input.dispatchMouseEvent', {
        type, x: pt.x, y: pt.y, button: 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mousePressed' ? 1 : 0,
      }, this._sessionId);
    }
    await new Promise(r => setTimeout(r, 300)); // let a click-driven nav/render begin
    return pt;
  }

  async type(ref, text, submit = false) {
    const pt = await this._refPoint(ref);
    if (!pt) throw new Error(`ref ${ref} is stale — call browser_snapshot again to get fresh refs.`);
    // Focus by clicking, clear any existing value, then insert as real input.
    await this._send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: 1 }, this._sessionId);
    await this._send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: 0 }, this._sessionId);
    await this.evaluate(`(() => { const el = (window.__navyRefs||[])[${Number(ref)}]; if (el && 'value' in el) el.value=''; })()`);
    await this._send('Input.insertText', { text: String(text) }, this._sessionId);
    if (submit) {
      for (const type of ['keyDown', 'keyUp']) {
        await this._send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, this._sessionId);
      }
      await new Promise(r => setTimeout(r, 400));
    }
    return pt;
  }

  async scroll(amount = 600) {
    await this._send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: Number(amount) || 600,
    }, this._sessionId);
    await new Promise(r => setTimeout(r, 250));
    return this.evaluate('({ scrollY: Math.round(window.scrollY), scrollHeight: document.body ? document.body.scrollHeight : 0 })');
  }

  // Return captured console/error/network entries, newest cleared by default so
  // each call reports only what happened since the last one.
  drainEvents(clear = true) {
    const out = this._events.slice();
    if (clear) this._events = [];
    return out;
  }

  async close() {
    if (this._closed) { this._killProc(); this._cleanupProfile(); return; }
    // Ask Chrome to exit gracefully FIRST, while the transport is still open —
    // setting _closed before this would make _send reject and the graceful path
    // would silently never happen, leaving every run to be force-killed (and the
    // profile still locked when cleanup tried to remove it). Fire-and-forget: a
    // closing Chrome drops the pipe instead of answering.
    try { this._writeFrame({ id: this._nextId++, method: 'Browser.close', params: {} }); } catch {}
    this._closed = true;
    // Give it a moment to go on its own, then make sure it is gone either way.
    await new Promise(r => setTimeout(r, 300));
    try { this._writePipe?.end(); } catch {}
    this._killProc();
    // Chrome needs a beat to release the profile lock before the dir can go.
    setTimeout(() => this._cleanupProfile(), 1500);
  }

  _killProc() {
    if (!this.proc || this.proc.killed) return;
    try {
      if (process.platform === 'win32' && this.proc.pid) {
        spawn('taskkill', ['/F', '/T', '/PID', String(this.proc.pid)], { stdio: 'ignore', windowsHide: true });
      } else {
        this.proc.kill('SIGTERM');
      }
    } catch {}
  }

  _cleanupProfile() {
    if (!this.userDataDir) return;
    const dir = this.userDataDir;
    this.userDataDir = null;
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
}

module.exports = { Browser, chromeCandidates, firstExisting, launchArgs, drainFrames, snapshotScript, INTERACTIVE_TAGS };
