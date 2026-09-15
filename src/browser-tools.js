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
const fs = require('fs');
const path = require('path');
const png = require('./png.js');

// How many changed pixels still count as "the same screen". A text caret that
// blinked between two captures is about 16 pixels; a genuine change is at least
// a glyph. A percentage would be the wrong measure here: one changed word on a
// 1280x800 capture is a few hundred pixels, well under a tenth of a percent,
// and a regression check that cannot see one wrong word is not doing its job.
const VISUAL_NOISE_PIXELS = 24;

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

  async toolBrowserAccessibility() {
    if (!this._session.browser?.running) return 'Error: no page open — call browser_navigate first.';
    try {
      const b = this._session.browser;
      const audit = await b.accessibilityAudit();
      const focus = await b.focusOrder();
      return this._formatAccessibility(audit, focus);
    } catch (e) { return 'Error: ' + e.message; }
  }

  // One readable report from the markup audit and the Tab walk. Bounded, so a
  // page with hundreds of problems does not flood the context: the counts are
  // always complete, the examples are capped. It ends by saying what automated
  // checks cannot see, so a clean result is not reported as "accessible".
  _formatAccessibility(audit, focus) {
    const out = [];
    const where = audit && audit.title ? `${audit.title} (${audit.url})` : (audit && audit.url) || 'this page';
    out.push(`Accessibility check of ${where}`);
    const issues = (audit && audit.issues) || [];
    const rank = { serious: 0, moderate: 1, minor: 2 };
    if (!issues.length) {
      out.push(`Markup and contrast: no problems found (${(audit && audit.contrastChecked) || 0} text elements checked for contrast).`);
    } else {
      const by = { serious: 0, moderate: 0, minor: 0 };
      for (const i of issues) by[i.severity] = (by[i.severity] || 0) + 1;
      out.push(`Markup and contrast: ${issues.length} finding${issues.length === 1 ? '' : 's'} — ${by.serious} serious, ${by.moderate} moderate, ${by.minor} minor.`);
      const shown = issues.slice().sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)).slice(0, 25);
      for (const i of shown) out.push(`  [${i.severity}] ${i.kind} — ${i.where}: ${i.text}`);
      if (issues.length > shown.length) out.push(`  …and ${issues.length - shown.length} more of the same kinds.`);
    }
    if (focus) {
      const seq = focus.sequence || [];
      const name = (s) => `${s.tag}${s.label ? ' "' + s.label + '"' : ''}`;
      out.push(`Keyboard: Tab reached ${seq.length} stop${seq.length === 1 ? '' : 's'}`
        + (focus.complete ? '.' : ` and had not come back round after ${focus.pressed} presses.`));
      if (seq.length) {
        out.push('  Order: ' + seq.slice(0, 15).map((s, k) => `${k + 1} ${name(s)}`).join(' → ') + (seq.length > 15 ? ' → …' : ''));
      } else {
        out.push('  Nothing on the page took keyboard focus — fine for a static page, serious if it has anything to click or fill in.');
      }
      for (const t of focus.traps || []) out.push(`  [serious] Focus is trapped on ${name(t)}: pressing Tab does not move it.`);
      for (const v of focus.invisible || []) out.push(`  [serious] Focus lands on ${name(v)}, which is not visible.`);
      const ni = focus.noIndicator || [];
      if (ni.length) {
        out.push(`  [moderate] ${ni.length} stop${ni.length === 1 ? '' : 's'} show no visible focus indicator (no outline or ring when focused), e.g. ${ni.slice(0, 3).map(name).join(', ')}.`);
      }
    }
    out.push('Automated checks catch only part of what matters: whether alt text is meaningful, whether the reading order makes sense, and how a screen reader actually announces the page still need a person. Report the findings, not a clean bill of health.');
    return out.join('\n');
  }

  // A short, file-safe version of a screen name or a host. Anything outside
  // [a-z0-9._-] becomes a dash, and leading or trailing dots and dashes are cut,
  // so a name like "../../x" cannot climb out of the baselines folder.
  _baselineKey(raw) {
    return String(raw || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  }

  // Where baselines live: the project's own .navy folder when one is open, so
  // they sit with the project they describe (.navy is already kept out of git);
  // Navy's global storage otherwise, for a URL tested with no folder open.
  async _baselineDir() {
    const navy = this.projectRoot ? await this.ensureNavyDir() : null;
    return { dir: path.join(navy || this._globalProjectsDir(), 'playthrough', 'baselines'), inProject: Boolean(navy) };
  }

  // Which site a baseline belongs to. A local dev server's port is not part of
  // its identity: Vite moves from 5173 to 5174 whenever 5173 is taken, and a
  // name that included the port quietly saved a fresh baseline for every screen
  // instead of comparing - a regression check that silently stopped checking.
  // The loopback spellings (localhost, 127.0.0.1, [::1], 0.0.0.0) are one
  // machine, so they share one name too. That holds inside a project's .navy,
  // where every local server is that project's own. With no folder open the
  // baselines are shared by every project, so there the port still tells two
  // local apps apart. A real domain always keeps its port: staging:8443 is not
  // the live site.
  _baselineHost(info, inProject) {
    const host = String((info && info.host) || '').toLowerCase();
    const hostname = String((info && info.hostname) || host.replace(/:\d+$/, '')).toLowerCase();
    if (inProject) {
      if (/^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/.test(hostname)) return 'localhost';
      if (/\.localhost$|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return this._baselineKey(hostname) || 'site';
    }
    return this._baselineKey(host) || 'site';
  }

  async toolBrowserVisualCheck(name, update) {
    if (!this._session.browser?.running) return 'Error: no page open — call browser_navigate first.';
    const key = this._baselineKey(name);
    if (!key) return 'Error: browser_visual_check needs a name for the screen, e.g. "home" or "checkout-form".';
    try {
      const b = this._session.browser;
      const info = await b.evaluate('({ host: location.host, hostname: location.hostname, url: location.href })').catch(() => null);
      const { dir, inProject } = await this._baselineDir();
      const host = this._baselineHost(info, inProject);
      const file = path.join(dir, host + '__' + key + '.png');
      const shot = Buffer.from(await b.captureFixed(), 'base64');
      const existed = fs.existsSync(file);
      if (!existed || update) {
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(file, shot);
        return existed
          ? `Updated the baseline for "${key}" on ${host} to the current screen. Later checks compare against this one.`
          : `No baseline for "${key}" on ${host} yet — saved the current screen as its baseline. Later runs of browser_visual_check("${key}") compare against it.`;
      }
      const d = png.diffImages(png.decodePng(await fs.promises.readFile(file)), png.decodePng(shot));
      if (d.sizeMismatch) {
        return `"${key}" cannot be compared: its baseline is ${d.base.width}x${d.base.height} but the current capture is ${d.current.width}x${d.current.height}. `
          + `If that is expected, call browser_visual_check("${key}", update: true) to re-baseline it.`;
      }
      const pct = (d.ratio * 100).toFixed(d.ratio < 0.01 ? 2 : 1);
      if (d.changed <= VISUAL_NOISE_PIXELS) {
        return `"${key}" matches its baseline (${d.changed} pixel${d.changed === 1 ? '' : 's'} differ — within noise).`;
      }
      const box = d.bbox;
      return {
        __image: {
          mediaType: 'image/png',
          data: png.encodePng(d.diff).toString('base64'),
          caption: `[Screenshot from browser_visual_check — this is a DIFF of "${key}" against its baseline, not a screenshot: the baseline is washed out to pale grey and every changed pixel is solid red. Judge whether the red areas are a regression or an intended change.]`,
        },
        text: `"${key}" CHANGED since its baseline: ${d.changed} pixels (${pct}%) differ, within x ${box.x}–${box.x + box.width - 1}, y ${box.y}–${box.y + box.height - 1} of a ${d.width}x${d.height} capture. `
          + `The attached diff shows where. If the change is intended, call browser_visual_check("${key}", update: true) to accept it as the new baseline; if not, report it as a regression.`,
      };
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
- browser_accessibility() — what a screen-reader or keyboard user would hit: missing alt text and labels, unnamed buttons and links, text below WCAG AA contrast, and a real Tab walk of the focus order (traps, invisible focus). Run it on each important screen.
- browser_visual_check(name, update) — visual regression: compares the screen with its saved baseline and attaches a red-on-grey diff of what changed. Give each screen a short, stable name ("home", "checkout"); the first run saves the baseline. Pass update: true only for a change that is intended.
- browser_back(), browser_close().

Once the page is open:
- Screenshot + snapshot + console to establish the baseline.
- Walk the main user journeys: click primary actions, fill and submit at least one form if present, follow key links. After each meaningful step: screenshot, snapshot, and check console.
- Probe for problems a human would catch: broken/missing images, dead or 404 links, layout that overlaps or overflows, forms that accept bad input or give no feedback, obvious accessibility gaps, and any visible security smell (secrets in page/console, mixed content, missing auth checks, sensitive data in the DOM).
- On each important screen, run browser_accessibility and browser_visual_check (with that screen's stable name).
- When done, call browser_close(), then write the report.

Final report format (as your finish message):
**Playthrough summary:** what you tested and the overall impression.
**Findings:** a numbered list, most severe first. For each: a one-line title, severity (Critical / Major / Minor / Polish), what you observed, and how you found it (which screen/action, quoting the console line or describing the visual). If you found nothing wrong in an area, say the site passed it.
**Accessibility:** what browser_accessibility found, most serious first. Automated checks cover only part of accessibility, so say that rather than calling the site accessible.
**Visual changes:** each screen that differs from its baseline, whether it looks like a regression or an intended change, and any baselines saved for the first time.
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
