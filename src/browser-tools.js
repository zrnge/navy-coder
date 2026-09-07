// /playthrough: the browser tool layer.
//
// Lifted verbatim out of extension.js, which was past 7,600 lines. These are
// still methods on NavyCoderViewProvider - `this` means exactly what it did
// before - so no call site and no signature changed in the move; see
// mixinPrototype at the bottom of extension.js.
//
// The seam is a clean one: the block was contiguous, nothing else in the file
// reaches into it, and everything it touches is either `this` or the transport
// in src/browser.js. That file is the ENGINE (Chrome discovery, CDP over the
// debugging pipe, the page primitives); this one is the tool layer the model
// actually calls, plus the /playthrough entry point and the prompts it seeds.

const vscode = require('vscode');

class BrowserToolMethods {
  // ── Browser playthrough tools (see src/browser.js) ──────────────────────────
  // A real Chrome, driven over CDP, is created lazily on the first browser_* call
  // and reused for the rest of the session; browser_close, clearing the chat, or
  // disposing the view tears it down. Every URL is checked to be http(s) so a page
  // can't steer the browser onto file:// or a privileged chrome:// surface.
  async _ensureBrowser() {
    if (this._session.browser && this._session.browser.running) return this._session.browser;
    // A previous browser that is no longer running still owns a process handle
    // and a temp profile — drop it properly rather than overwriting the field.
    this._disposeBrowser();

    // Launching a browser is EXECUTION, not a file change: it starts a real
    // process and hands the model the ability to navigate anywhere on http(s)
    // and run arbitrary JavaScript in a page via browser_evaluate. Without this
    // any turn — including one steered by text Navy just read out of the repo —
    // could open a browser and exfiltrate through it silently. So it goes behind
    // the same gate as run_command (navy.commandApproval), asked once per
    // browser session rather than per interaction.
    if (!this._commandsAutoApproved()) {
      const id = this.generateId();
      this.view?.webview.postMessage({
        type: 'pendingCommand', id,
        command: 'Launch a browser for a visual playthrough (isolated temporary profile)',
      });
      const approved = await new Promise((resolve) => {
        this.pendingCommandApprovals.set(id, { resolve });
      });
      if (!approved) throw new Error('Browser launch rejected by user.');
    }

    const { Browser } = require('./browser.js');
    const config = vscode.workspace.getConfiguration('navy');
    this._session.browser = new Browser({
      chromePath: config.get('chromePath', '') || null,
      headed: !config.get('browserHeadless', false),
      log: (m) => this.log?.(m),
    });
    await this._session.browser.launch();
    return this._session.browser;
  }

  _browserUrlOk(url) {
    try {
      const u = new URL(String(url));
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch { return false; }
  }

  async toolBrowserNavigate(url) {
    if (!url || typeof url !== 'string') return 'Error: browser_navigate needs a url.';
    if (!this._browserUrlOk(url)) return 'Error: only http(s) URLs are allowed (file://, chrome://, data: and other schemes are blocked for safety).';
    try {
      const b = await this._ensureBrowser();
      const info = await b.navigate(url);
      const errs = b.drainEvents(false).filter(e => e.kind === 'pageerror' || e.kind === 'console.error');
      return `Navigated to ${info?.url || url}\nTitle: ${info?.title || '(none)'}${errs.length ? `\n${errs.length} console error(s) already — call browser_console to read them.` : ''}\nCall browser_snapshot to see the page, or browser_screenshot to look at it.`;
    } catch (e) { return 'Error: ' + e.message; }
  }

  async toolBrowserSnapshot() {
    if (!this._session.browser?.running) return 'Error: no page open — call browser_navigate first.';
    try {
      const snap = await this._session.browser.snapshot();
      if (!snap || !snap.nodes?.length) {
        return `Page: ${snap?.title || ''} (${snap?.url || ''})\n(no interactive elements found — the page may still be loading, or its UI is drawn in canvas/an iframe. Try browser_screenshot to look, or browser_scroll.)`;
      }
      const lines = snap.nodes.map(n => `[${n.ref}] ${n.role}${n.text ? ' "' + n.text + '"' : ''}`);
      return `Page: ${snap.title} (${snap.url})\n${lines.join('\n')}`;
    } catch (e) { return 'Error: ' + e.message; }
  }

  async toolBrowserScreenshot() {
    if (!this._session.browser?.running) return 'Error: no page open — call browser_navigate first.';
    try {
      const data = await this._session.browser.screenshot();
      if (!data) return 'Error: screenshot failed (empty capture).';
      // Structured result: the turn loop pulls __image out and feeds it to the
      // model as a vision message, and shows `text` on the tool card.
      return { __image: { mediaType: 'image/png', data }, text: 'Screenshot captured — inspect it for layout, styling, overlap, cut-off text, and anything only visible by looking.' };
    } catch (e) { return 'Error: ' + e.message; }
  }

  async toolBrowserClick(ref) {
    if (!this._session.browser?.running) return 'Error: no page open — call browser_navigate first.';
    if (ref == null || isNaN(Number(ref))) return 'Error: browser_click needs a numeric ref from browser_snapshot.';
    try {
      await this._session.browser.click(Number(ref));
      const info = await this._session.browser.evaluate('({ title: document.title, url: location.href })').catch(() => null);
      return `Clicked ref ${ref}. Now on: ${info?.title || ''} (${info?.url || ''}). Call browser_snapshot to see the updated page.`;
    } catch (e) { return 'Error: ' + e.message; }
  }

  async toolBrowserType(ref, text, submit) {
    if (!this._session.browser?.running) return 'Error: no page open — call browser_navigate first.';
    if (ref == null || isNaN(Number(ref))) return 'Error: browser_type needs a numeric ref from browser_snapshot.';
    try {
      await this._session.browser.type(Number(ref), String(text ?? ''), Boolean(submit));
      return `Typed into ref ${ref}${submit ? ' and pressed Enter — call browser_snapshot to see the result' : ''}.`;
    } catch (e) { return 'Error: ' + e.message; }
  }

  async toolBrowserScroll(amount) {
    if (!this._session.browser?.running) return 'Error: no page open — call browser_navigate first.';
    try {
      const pos = await this._session.browser.scroll(amount == null ? 600 : Number(amount));
      return `Scrolled. Position ${pos?.scrollY || 0}px of ${pos?.scrollHeight || '?'}px total.`;
    } catch (e) { return 'Error: ' + e.message; }
  }

  async toolBrowserEvaluate(expression) {
    if (!this._session.browser?.running) return 'Error: no page open — call browser_navigate first.';
    if (!expression) return 'Error: browser_evaluate needs an expression.';
    try {
      const val = await this._session.browser.evaluate(String(expression), { awaitPromise: true });
      let out;
      try { out = JSON.stringify(val); } catch { out = String(val); }
      if (out === undefined) out = 'undefined';
      return 'Result: ' + String(out).slice(0, 4000);
    } catch (e) { return 'Error: ' + e.message; }
  }

  async toolBrowserConsole() {
    if (!this._session.browser?.running) return 'Error: no page open — call browser_navigate first.';
    const events = this._session.browser.drainEvents(true);
    if (!events.length) return 'No console errors, page exceptions, or failed requests since the last check.';
    return events.map(e => `[${e.kind}] ${e.text}`).join('\n').slice(0, 4000);
  }

  async toolBrowserBack() {
    if (!this._session.browser?.running) return 'Error: no page open — call browser_navigate first.';
    try {
      const info = await this._session.browser.back();
      return info?.moved
        ? `Went back. Now on: ${info.title || ''} (${info.url || ''}). Call browser_snapshot to see it.`
        : `Nothing to go back to — this is the first page in the browser's history. Still on: ${info?.title || ''} (${info?.url || ''}).`;
    } catch (e) { return 'Error: ' + e.message; }
  }

  async toolBrowserClose() {
    if (!this._session.browser) return 'Browser was not open.';
    try { await this._session.browser.close(); } catch {}
    this._session.browser = null;
    return 'Browser closed.';
  }

  // Every open chat's browser, not just the active tab's — for the panel-closed
  // path, where no playthrough anywhere is being watched any more.
  _disposeAllBrowsers() {
    for (const session of this.sessions.values()) {
      if (!session.browser) continue;
      const b = session.browser;
      session.browser = null;
      try { b.close(); } catch {}
    }
  }

  // Tear this chat's browser down without waiting — used on chat clear, where
  // nothing is awaiting a graceful CDP Browser.close.
  _disposeBrowser() {
    if (!this._session.browser) return;
    const b = this._session.browser;
    this._session.browser = null;
    try { b.close(); } catch {}
  }

  // Accept what a user actually types: a bare host ("localhost:3000",
  // "example.com/app") becomes http(s), and anything already a URL is left alone.
  _normalizePlaythroughUrl(raw) {
    const s = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    // localhost / 127.x / a bare host:port default to http; a real domain to https.
    const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/i.test(s);
    return (local ? 'http://' : 'https://') + s;
  }

  // Is the typed argument an actual URL/host we should open directly, as opposed
  // to prose ("for this webserver", "test the login flow") or nothing at all? A
  // URL is a single token that, once normalised, parses as http(s) AND looks like
  // a URL — has a scheme, a dot, a colon-port, a slash-path, or is loopback — so a
  // bare word like "mysite" is treated as prose, not the host "mysite".
  _argIsExplicitUrl(arg) {
    if (!arg || /\s/.test(arg)) return false;
    const u = this._normalizePlaythroughUrl(arg);
    if (!this._browserUrlOk(u)) return false;
    return /^https?:\/\//i.test(arg) || /[.:/]/.test(arg) || /^(localhost|\[?::1\]?)$/i.test(arg);
  }

  // /playthrough entry point. A URL is OPTIONAL. If the user names one, we play
  // through exactly that; otherwise (the common case) we play through the LOCAL
  // project they're working on — the model figures out whether it's a web app,
  // serves it, and drives it, or tells the user it isn't a web project at all.
  // The browser launches lazily on the first browser_* call, so this method does
  // no I/O beyond deciding which prompt to seed.
  async runPlaythrough(rawArg) {
    const arg = String(rawArg || '').trim().replace(/^['"]|['"]$/g, '');

    // The one input we refuse outright: an explicit non-http(s) scheme
    // (file://, chrome://, …) — it IS a URL, just not one we'll open.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg) && !/^https?:\/\//i.test(arg)) {
      this.view?.webview.postMessage({ type: 'error', message: `Navy: /playthrough can only open http(s) pages — "${arg}" is not one.` });
      return;
    }

    // A URL may be followed by guidance ("/playthrough localhost:3000 test the
    // checkout flow"), so the FIRST token decides the mode and the rest, if any,
    // rides along as a hint. Testing the whole argument would send this to
    // project-discovery with a prompt insisting no URL was given.
    const [first, ...rest] = arg.split(/\s+/).filter(Boolean);
    if (first && this._argIsExplicitUrl(first)) {
      await this.askNavy(this._playthroughPrompt(this._normalizePlaythroughUrl(first), rest.join(' ')), false, null, [], []);
      return;
    }

    // No URL (or free-text guidance) → discover/serve the local project.
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.view?.webview.postMessage({ type: 'error', message: 'Navy: open a project folder before running /playthrough (or pass a URL, e.g. /playthrough http://localhost:3000).' });
      return;
    }
    await this.askNavy(this._playthroughDiscoverPrompt(arg), false, null, [], []);
  }

  // The shared half of both prompts: the header, the browser toolset, the probe
  // checklist and the report format. Only the goal and the first steps differ
  // between "play through this URL" and "find and play through this project".
  _playthroughCommon() {
    return `You have FULL AUTONOMY: submit forms, follow links, and trigger real actions as needed to exercise the site. (The user was warned this runs against a live browser; you do not need to ask permission for each interaction.)

Tools available to you (a real Chrome window is open and visible):
- browser_navigate(url) — go to a page.
- browser_snapshot() — numbered outline of interactive elements + headings + alerts; the [ref] numbers feed click/type. Re-snapshot after every navigation or page change (refs go stale).
- browser_screenshot() — SEE the page as an image. Take one on each important screen and actually look: layout, alignment, overlap, cut-off/overflowing text, contrast, broken images, responsiveness. (If you cannot see images, say so and lean on snapshot + evaluate.)
- browser_click(ref), browser_type(ref, text, submit) — interact. Use realistic input; set submit=true to send a form/search.
- browser_scroll(amount) — reveal below-the-fold content.
- browser_console() — JavaScript errors, uncaught exceptions, and failed/4xx-5xx requests since the last check. Check it after loads and after actions — these are bugs a user can't see but you can.
- browser_evaluate(expression) — read state you can't see (values, counts, computed styles, localStorage, exposed globals) or verify a functional claim.
- browser_back(), browser_close().

Once the page is open:
- Screenshot + snapshot + console to establish the baseline.
- Walk the main user journeys: click primary actions, fill and submit at least one form if present, follow key links. After each meaningful step: screenshot, snapshot, and check console.
- Probe for problems a human would catch: broken/missing images, dead or 404 links, layout that overlaps or overflows, forms that accept bad input or give no feedback, obvious accessibility gaps, and any visible security smell (secrets in page/console, mixed content, missing auth checks, sensitive data in the DOM).
- When done, call browser_close(), then write the report.

Final report format (as your finish message):
**Playthrough summary:** what you tested and the overall impression.
**Findings:** a numbered list, most severe first. For each: a one-line title, severity (Critical / Major / Minor / Polish), what you observed, and how you found it (which screen/action, quoting the console line or describing the visual). If you found nothing wrong in an area, say the site passed it.
**Not covered:** anything you couldn't reach or test, and why.

Be concrete and honest — cite the exact screen or console output. Do not invent issues; if the site works, say so.`;
  }

  _playthroughPrompt(url, hint = '') {
    const hintLine = hint ? `\nThe user added this guidance: "${hint}". Take it into account.\n` : '';
    return `[SYSTEM — PLAYTHROUGH MODE]
You are Navy running an automated, human-style visual QA playthrough of a live website. Your job is to USE the site the way a careful human tester would — look at it, click through it, fill things in, and report what is broken, confusing, or risky.

Target URL: ${url}
${hintLine}
${this._playthroughCommon()}

Start now: call update_plan with the flows you intend to test, then browser_navigate to the target URL.`;
  }

  // Discovery mode: no URL was given, so the target is the user's own project.
  _playthroughDiscoverPrompt(hint) {
    const hintLine = hint ? `\nThe user added this guidance: "${hint}". Take it into account.\n` : '';
    return `[SYSTEM — PLAYTHROUGH MODE]
You are Navy running an automated, human-style visual QA playthrough. No URL was given, so the target is THIS PROJECT — the one open in the workspace. Your job is to get it running in a browser and test it the way a careful human tester would.
${hintLine}
FIRST, determine whether this is even a web project you can open in a browser:
- Look at package.json (a "dev"/"start"/"serve" script; deps like react, vue, svelte, next, vite, angular, express, fastify, flask, django, rails, php), an index.html, or a framework/static-site config. Use list_files / read_file / search_codebase as needed — a few quick reads, not a deep audit.
- If it is NOT a web app that serves an HTTP page (e.g. it's a CLI, a library, a desktop app, a data/ML script), do NOT open a browser. Tell the user plainly: this project isn't a web app you can open in a browser, so a visual playthrough doesn't apply — and briefly say what kind of project it looks like instead. Then finish. Do not invent a website to test.

If it IS a web project, get it running and play through it:
1. Call update_plan with your steps (detect & serve, load & first impression, the main flows, console health).
2. Check whether a dev server is already running for it; if not, start it with run_project and read the local URL it reports (usually http://localhost:PORT). If run_project can't determine how to start it, tell the user what you tried and what command they should run, then stop.
3. browser_navigate to that local URL and run the playthrough.

${this._playthroughCommon()}

Begin now with the web-project check.`;
  }
}

module.exports = { BROWSER_TOOL_METHODS: BrowserToolMethods.prototype };
