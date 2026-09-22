const {
  fs, path, check, makeContext, sharedMock, queueOllamaFetch,
} = require('./harness.js');

const browser = require('../src/browser.js');
const { Browser, chromeCandidates, firstExisting, launchArgs, drainFrames, snapshotScript, INTERACTIVE_TAGS } = browser;

// A fake Chrome speaking CDP over the pipe: stdio[3] is where Navy writes
// commands, stdio[4] is where we push responses. `handler(msg)` decides the
// reply for each command; a reply may carry `__also` events (e.g. the
// Page.loadEventFired that a real navigation fires unsolicited).
function fakeChrome(handler) {
  const listeners = { data: [], error: [], exit: [] };
  const on = (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); };
  const frame = (obj) => Buffer.concat([Buffer.from(JSON.stringify(obj)), Buffer.from([0])]);
  const emit4 = (buf) => { for (const cb of (listeners.data || [])) cb(buf); };
  const stdio4 = { on: (ev, cb) => on(ev, cb) };
  const stdio3 = {
    write(buf) {
      const { frames } = drainFrames(Buffer.from(buf));
      for (const msg of frames) {
        const res = handler(msg) || {};
        const also = res.__also;
        // The handler's return IS the CDP method result (which for Runtime.evaluate
        // legitimately contains its own `result` field), so only an explicit
        // __result overrides it; __also-only replies default the result to {}.
        const result = res.__result !== undefined ? res.__result : (also ? {} : res);
        setImmediate(() => {
          emit4(frame({ id: msg.id, result }));
          if (also) for (const ev of also) emit4(frame(ev));
        });
      }
      return true;
    },
    end() {},
  };
  const proc = {
    pid: 4242, killed: false,
    stdio: [null, {}, {}, stdio3, stdio4],
    on: (ev, cb) => on(ev, cb),
    kill() { this.killed = true; },
  };
  return { proc, emit4, frame };
}

function defaultHandler(msg) {
  switch (msg.method) {
    case 'Target.createTarget': return { targetId: 'T1' };
    case 'Target.attachToTarget': return { sessionId: 'S1' };
    case 'Page.captureScreenshot': return { data: 'UE5HREFUQQ==' };
    case 'Page.navigate': return { __also: [{ method: 'Page.loadEventFired', params: {} }] };
    case 'Runtime.evaluate': {
      const e = msg.params.expression || '';
      if (/document\.title/.test(e)) return { result: { value: { title: 'Test Page', url: 'http://localhost:3000/' } } };
      if (/40\s*\+\s*2/.test(e)) return { result: { value: 42 } };
      return { result: { value: null } };
    }
    default: return {};
  }
}

async function browserSuite() {
  console.log('\nbrowser playthrough (src/browser.js + tools):');

  // ── Pure: executable discovery ─────────────────────────────────────────────
  {
    const win = chromeCandidates('win32', { 'PROGRAMFILES': 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\PF86', 'LOCALAPPDATA': 'C:\\Users\\me\\AppData\\Local' });
    check('chromeCandidates win32 includes a chrome.exe path', win.some(p => /chrome\.exe$/i.test(p)));
    check('chromeCandidates win32 includes an Edge fallback', win.some(p => /msedge\.exe$/i.test(p)));
    const mac = chromeCandidates('darwin', { HOME: '/Users/me' });
    check('chromeCandidates darwin points at Google Chrome.app', mac.some(p => /Google Chrome\.app/.test(p)));
    const lin = chromeCandidates('linux', {});
    check('chromeCandidates linux includes google-chrome', lin.some(p => /google-chrome/.test(p)));
    check('firstExisting returns the first path its existsSync accepts',
      firstExisting(['/a', '/b', '/c'], (p) => p === '/b') === '/b');
    check('firstExisting returns null when none exist', firstExisting(['/a', '/b'], () => false) === null);
  }

  // ── Pure: launch flags — the security-relevant invariants ──────────────────
  {
    const headed = launchArgs({ userDataDir: '/tmp/prof', headed: true });
    check('launchArgs uses the pipe transport (no debugging port)', headed.includes('--remote-debugging-pipe'));
    check('launchArgs isolates the profile in the given dir', headed.includes('--user-data-dir=/tmp/prof'));
    check('launchArgs NEVER passes --no-sandbox (Chrome sandbox protects the host)', !headed.some(a => /--no-sandbox/.test(a)));
    check('launchArgs never disables web security', !headed.some(a => /disable-web-security/.test(a)));
    check('launchArgs headed does NOT go headless', !headed.some(a => /--headless/.test(a)));
    check('launchArgs ends on about:blank, not the phone-home new-tab page', headed[headed.length - 1] === 'about:blank');
    const headless = launchArgs({ userDataDir: '/tmp/p', headed: false });
    check('launchArgs headless adds --headless=new', headless.includes('--headless=new'));
  }

  // ── Pure: NUL framing ──────────────────────────────────────────────────────
  {
    const two = Buffer.concat([Buffer.from('{"id":1,"result":{}}'), Buffer.from([0]), Buffer.from('{"method":"X"}'), Buffer.from([0])]);
    const r = drainFrames(two);
    check('drainFrames splits two complete NUL-delimited frames', r.frames.length === 2 && r.frames[0].id === 1 && r.frames[1].method === 'X');
    check('drainFrames leaves no remainder when input ends on a NUL', r.rest.length === 0);
    const partial = Buffer.concat([Buffer.from('{"id":2,"result":{}}'), Buffer.from([0]), Buffer.from('{"id":3')]);
    const r2 = drainFrames(partial);
    check('drainFrames yields the complete frame and buffers the partial tail', r2.frames.length === 1 && r2.frames[0].id === 2 && r2.rest.toString() === '{"id":3');
    const bad = Buffer.concat([Buffer.from('not json'), Buffer.from([0]), Buffer.from('{"id":4}'), Buffer.from([0])]);
    check('drainFrames skips an unparseable frame but keeps the good one', drainFrames(bad).frames.length === 1 && drainFrames(bad).frames[0].id === 4);
  }

  // ── Pure: the in-page snapshot script ──────────────────────────────────────
  {
    const s = snapshotScript(120);
    check('snapshotScript stores refs on window.__navyRefs', /window\.__navyRefs\s*=/.test(s));
    check('snapshotScript reads geometry via getBoundingClientRect', /getBoundingClientRect/.test(s));
    check('snapshotScript embeds the interactive-tag set', /button/.test(s) && INTERACTIVE_TAGS.has('input'));
  }

  // ── resolveExecutable ──────────────────────────────────────────────────────
  {
    const b = new Browser({ existsSync: () => false });
    let threw = false;
    try { b.resolveExecutable(); } catch { threw = true; }
    check('resolveExecutable throws when no browser is found', threw);
    const b2 = new Browser({ chromePath: '/opt/chrome', existsSync: (p) => p === '/opt/chrome' });
    check('resolveExecutable honours a valid navy.chromePath', b2.resolveExecutable() === '/opt/chrome');
    const b3 = new Browser({ chromePath: '/nope', existsSync: () => false });
    let threw3 = false;
    try { b3.resolveExecutable(); } catch (e) { threw3 = /does not exist/.test(e.message); }
    check('resolveExecutable rejects a chromePath that does not exist', threw3);
  }

  // ── Live-ish CDP round trip against the fake pipe ──────────────────────────
  {
    const fake = fakeChrome(defaultHandler);
    const b = new Browser({ chromePath: '/fake/chrome', existsSync: () => true, spawn: () => fake.proc, navTimeout: 200 });
    await b.launch();
    check('launch completes the attach handshake and marks the browser running', b.running === true && b._sessionId === 'S1');

    const val = await b.evaluate('40 + 2');
    check('evaluate returns the page value', val === 42);

    const shot = await b.screenshot();
    check('screenshot returns base64 PNG data', shot === 'UE5HREFUQQ==');

    const info = await b.navigate('http://localhost:3000/');
    check('navigate resolves after the load event and reports the page', info && info.title === 'Test Page');

    // An unsolicited console error event must land in the captured buffer.
    fake.emit4(fake.frame({ method: 'Runtime.consoleAPICalled', params: { type: 'error', args: [{ value: 'boom' }] } }));
    const events = b.drainEvents(true);
    check('a console.error event is captured for browser_console', events.some(e => e.kind === 'console.error' && /boom/.test(e.text)));
    check('drainEvents clears after reading', b.drainEvents(true).length === 0);

    await b.close();
    check('close tears the browser down', b.running === false);
  }

  // ── Provider-level: URL normalisation, scheme guard, tool guards ───────────
  {
    const os = require('os');
    const { vscode, ctrl } = sharedMock();
    let provider, tmp;
    try {
      const { NavyCoderViewProvider } = require('../src/extension.js');
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-browser-'));
      provider = new NavyCoderViewProvider(makeContext(tmp));
      provider.projectRoot = tmp;

      check('bare localhost host normalises to http', provider._normalizePlaythroughUrl('localhost:3000') === 'http://localhost:3000');
      check('a real domain normalises to https', provider._normalizePlaythroughUrl('example.com/app') === 'https://example.com/app');
      check('an already-qualified http URL is left alone', provider._normalizePlaythroughUrl('http://x.test/y') === 'http://x.test/y');
      check('surrounding quotes are stripped', provider._normalizePlaythroughUrl('"http://x.test"') === 'http://x.test');
      check('empty input yields empty', provider._normalizePlaythroughUrl('   ') === '');

      check('_browserUrlOk accepts http(s)', provider._browserUrlOk('http://x') && provider._browserUrlOk('https://x'));
      check('_browserUrlOk rejects file://', provider._browserUrlOk('file:///etc/passwd') === false);
      check('_browserUrlOk rejects chrome://', provider._browserUrlOk('chrome://settings') === false);

      // A blocked scheme must be refused BEFORE any browser is launched.
      const blocked = await provider.toolBrowserNavigate('file:///etc/passwd');
      check('browser_navigate refuses a non-http scheme without launching', /Error:/.test(blocked) && !provider._session.browser);

      // Every browser tool errors cleanly when nothing is open.
      const noPage = await provider.toolBrowserSnapshot();
      check('browser tools report "no page open" before navigate', /no page open/.test(noPage));

      // Launching a browser is execution, so it goes through the command-approval
      // gate. Declining must stop it before any Chrome is spawned — without this
      // any turn could open a browser and run arbitrary in-page JS unprompted.
      {
        const posted = [];
        ctrl.config.commandApproval = 'ask-always';
        provider.view = { webview: { postMessage: (m) => {
          posted.push(m);
          if (m.type === 'pendingCommand') setImmediate(() => provider.pendingCommandApprovals.get(m.id)?.resolve(false));
        } } };
        const denied = await provider.toolBrowserNavigate('http://localhost:65123/');
        check('a browser launch asks for command approval first',
          posted.some(m => m.type === 'pendingCommand' && /playthrough/i.test(m.command || '')));
        check('declining the launch stops it, with no browser spawned',
          /rejected by user/i.test(denied) && !provider._session.browser);
        provider.view = { webview: { postMessage: () => {} } };
      }

      // _disposeBrowser closes and clears a live handle.
      let closed = false;
      provider._session.browser = { running: true, close() { closed = true; } };
      provider._disposeBrowser();
      check('_disposeBrowser closes and drops the browser handle', closed === true && provider._session.browser === null);

      // toolBrowserClose on an already-null handle is a no-op message.
      check('browser_close with no browser is a friendly no-op', /not open/.test(await provider.toolBrowserClose()));

      // ── Routing: a URL/host is opened directly; prose or nothing tests the
      //    local project; a non-http scheme is refused. ─────────────────────────
      check('_argIsExplicitUrl accepts a full URL', provider._argIsExplicitUrl('http://localhost:3000'));
      check('_argIsExplicitUrl accepts host:port', provider._argIsExplicitUrl('localhost:3000'));
      check('_argIsExplicitUrl accepts a dotted domain', provider._argIsExplicitUrl('example.com'));
      check('_argIsExplicitUrl rejects multiword prose', !provider._argIsExplicitUrl('for this webserver'));
      check('_argIsExplicitUrl rejects a bare word (not a host)', !provider._argIsExplicitUrl('mysite'));
      check('_argIsExplicitUrl rejects empty', !provider._argIsExplicitUrl(''));

      // Capture which prompt runPlaythrough seeds, and any error it posts.
      let seeded = null;
      provider.askNavy = async (p) => { seeded = p; };
      const sent = [];
      provider.view = { webview: { postMessage: (m) => sent.push(m) } };

      await provider.runPlaythrough('http://localhost:3000');
      check('runPlaythrough with a URL seeds the direct (Target URL) prompt', /Target URL:/.test(seeded || ''));

      seeded = null;
      await provider.runPlaythrough('for this webserver');
      check('runPlaythrough with prose seeds the local-project discovery prompt', /THIS PROJECT/.test(seeded || '') && /No URL was given/.test(seeded || ''));
      check('…and carries the free-text as guidance', /for this webserver/.test(seeded || ''));

      seeded = null;
      await provider.runPlaythrough('');
      check('bare /playthrough seeds discovery on the local project', /THIS PROJECT/.test(seeded || ''));

      seeded = null; sent.length = 0;
      await provider.runPlaythrough('file:///etc/passwd');
      check('runPlaythrough refuses an explicit file:// scheme with a message, not a turn',
        seeded === null && sent.some(m => m.type === 'error' && /http\(s\)/.test(m.message)));

      // Discovery needs a project; with none open at all, it says so instead of
      // seeding a turn. Stub workspaceFolders so the fallback finds nothing either.
      seeded = null; sent.length = 0;
      provider.projectRoot = null;
      const origFolders = vscode.workspace.workspaceFolders;
      vscode.workspace.workspaceFolders = undefined;
      await provider.runPlaythrough('');
      check('bare /playthrough with no open folder asks the user to open one',
        seeded === null && sent.some(m => m.type === 'error' && /project folder/.test(m.message)));
      vscode.workspace.workspaceFolders = origFolders;
      provider.projectRoot = tmp;
    } finally {
      try { provider?._disposeBrowser?.(); } catch {}
      try { provider?.dispose?.(); } catch {}
      try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  // ── Regression: the screenshot's vision message must land AFTER every tool
  //    result, never spliced between them. Batching screenshot+console is what
  //    the playthrough prompt actively asks for, and splicing a user message
  //    into the run of tool replies is rejected outright by OpenAI ("assistant
  //    with tool_calls must be followed by tool messages") and leaves
  //    Anthropic's tool_result blocks stranded after the image. ──────────────
  {
    const os = require('os');
    const { ctrl } = sharedMock();
    let provider, tmp;
    const realFetch = global.fetch;
    try {
      const { NavyCoderViewProvider } = require('../src/extension.js');
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-shotorder-'));
      provider = new NavyCoderViewProvider(makeContext(tmp));
      provider.projectRoot = tmp;
      provider.view = { webview: { postMessage: () => {} } };
      provider._wslCache = { available: false };

      // Already "open", so no launch and no approval gate is involved here.
      provider._session.browser = {
        running: true,
        async screenshot() { return 'QUJD'; },
        drainEvents() { return [{ kind: 'console.error', text: 'boom' }]; },
        async close() {},
      };

      const captured = [];
      global.fetch = queueOllamaFetch([
        { toolCalls: [
          { name: 'browser_screenshot', args: {} },
          { name: 'browser_console', args: {} },
        ] },
        { text: 'Done.' },
      ], captured);

      await provider.askNavy('look at the page', false, null, [], []);

      const msgs = (captured[1] && captured[1].messages) || [];
      const toolIdxs = msgs.map((m, i) => (m.role === 'tool' ? i : -1)).filter(i => i !== -1);
      const imgIdx = msgs.findIndex(m => Array.isArray(m.images) && m.images.length);
      check('both batched browser tool results reach the model', toolIdxs.length === 2, JSON.stringify(msgs.map(m => m.role)));
      check('the screenshot image is delivered to the model', imgIdx !== -1);
      check('the vision message lands AFTER every tool result, not spliced between them',
        imgIdx > toolIdxs[toolIdxs.length - 1],
        `image at ${imgIdx}, last tool result at ${toolIdxs[toolIdxs.length - 1]}`);
    } finally {
      global.fetch = realFetch;
      ctrl.reset?.();
      try { provider?.dispose?.(); } catch {}
      try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  // ── _pruneOldScreenshots: only Navy's own screenshots, only the stale ones ─
  {
    const os = require('os');
    sharedMock();
    let provider, tmp;
    try {
      const { NavyCoderViewProvider } = require('../src/extension.js');
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-shotprune-'));
      provider = new NavyCoderViewProvider(makeContext(tmp));
      const shot = (n) => ({ role: 'user', content: [
        { type: 'text', text: `[Screenshot from browser_screenshot — ${n}]` },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ] });
      const pasted = { role: 'user', content: [
        { type: 'text', text: 'here is my mockup' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,ZZZ' } },
      ] };
      const msgs = [pasted, shot(1), shot(2), shot(3), shot(4)];
      provider._pruneOldScreenshots(msgs);
      const stillImage = (m) => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url');
      check('a user-pasted image is never pruned as a screenshot', stillImage(msgs[0]));
      check('stale screenshots lose their image', !stillImage(msgs[1]) && !stillImage(msgs[2]));
      check('…and keep their text plus a note', /Screenshot from/.test(msgs[1].content) && /take a fresh one/.test(msgs[1].content));
      check('the two most recent screenshots are kept intact', stillImage(msgs[3]) && stillImage(msgs[4]));
    } finally {
      try { provider?.dispose?.(); } catch {}
      try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  // ── browser_accessibility: one report from the audit and the Tab walk ───────
  {
    const os = require('os');
    sharedMock();
    let provider, tmp;
    try {
      const { NavyCoderViewProvider } = require('../src/extension.js');
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-a11ytool-'));
      provider = new NavyCoderViewProvider(makeContext(tmp));
      provider.projectRoot = tmp;
      provider._session.browser = {
        running: true,
        accessibilityAudit: async () => ({
          url: 'http://localhost:3000/', title: 'Shop', contrastChecked: 12,
          issues: [
            { kind: 'headings', severity: 'minor', where: 'h3 "Deals"', text: 'Heading jumps from h1 to h3.' },
            { kind: 'img-alt', severity: 'serious', where: 'img', text: 'Image has no alt text.' },
          ],
          counts: { headings: 1, 'img-alt': 1 },
        }),
        focusOrder: async () => ({
          sequence: [
            { key: 'f1', tag: 'a', label: 'Home', visible: true, indicator: true },
            { key: 'f2', tag: 'button', label: 'Go', visible: true, indicator: false },
          ],
          traps: [], invisible: [], noIndicator: [{ key: 'f2', tag: 'button', label: 'Go' }], complete: true, pressed: 3,
        }),
      };
      const out = await provider.toolBrowserAccessibility();
      check('a11y tool: reports the findings, most serious first',
        /2 findings/.test(out) && out.indexOf('img-alt') < out.indexOf('headings'), out);
      check('a11y tool: ...with the Tab order it walked',
        /Tab reached 2 stops/.test(out) && /1 a "Home"/.test(out) && /2 button "Go"/.test(out), out);
      check('a11y tool: ...and the stop with no visible focus', /no visible focus indicator/.test(out) && /button "Go"/.test(out));
      check('a11y tool: ...and says what automated checks cannot see', /only part of what matters/.test(out));
      const prompt = provider._playthroughCommon();
      check('a11y tool: the playthrough prompt asks for both checks and reports on them',
        /browser_accessibility/.test(prompt) && /browser_visual_check/.test(prompt)
        && /\*\*Accessibility:\*\*/.test(prompt) && /\*\*Visual changes:\*\*/.test(prompt));
      provider._session.browser = null;
      check('a11y tool: needs an open page', /no page open/.test(await provider.toolBrowserAccessibility()));
    } finally {
      try { provider?.dispose?.(); } catch {}
      try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  // ── browser_visual_check: baselines, comparison, the diff image ─────────────
  {
    const os = require('os');
    const png = require('../src/png.js');
    sharedMock();
    let provider, tmp;
    const solid = (w, h, rgba) => {
      const data = new Uint8Array(w * h * 4);
      for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
      return { width: w, height: h, data };
    };
    const withBlock = (img, x0, y0, bw, bh) => {
      const c = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
      for (let y = y0; y < y0 + bh; y++) {
        for (let x = x0; x < x0 + bw; x++) c.data.set([200, 30, 30, 255], (y * img.width + x) * 4);
      }
      return c;
    };
    const px = (img, x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
    try {
      const { NavyCoderViewProvider } = require('../src/extension.js');
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-visual-'));
      provider = new NavyCoderViewProvider(makeContext(tmp));
      provider.projectRoot = tmp;
      let screen = solid(40, 30, [255, 255, 255, 255]);
      let where = { host: 'localhost:3000', hostname: 'localhost', url: 'http://localhost:3000/' };
      provider._session.browser = {
        running: true,
        evaluate: async () => where,
        captureFixed: async () => png.encodePng(screen).toString('base64'),
      };
      const dir = path.join(provider.getNavyDir(tmp), 'playthrough', 'baselines');
      const file = path.join(dir, 'localhost__home.png');

      const first = await provider.toolBrowserVisualCheck('home');
      check('visual: the first check saves a baseline, in the project\'s folder in the profile, and says so',
        /saved the current screen as its baseline/.test(first) && fs.existsSync(file), first);

      const same = await provider.toolBrowserVisualCheck('home');
      check('visual: an unchanged screen matches its baseline', typeof same === 'string' && /matches its baseline/.test(same), String(same));

      screen = withBlock(solid(40, 30, [255, 255, 255, 255]), 2, 2, 3, 3);
      const speck = await provider.toolBrowserVisualCheck('home');
      check('visual: a caret-sized speck (9 px) is noise, not a change',
        typeof speck === 'string' && /matches its baseline/.test(speck), String(speck));

      screen = withBlock(solid(40, 30, [255, 255, 255, 255]), 10, 5, 8, 6);
      const changed = await provider.toolBrowserVisualCheck('home');
      check('visual: a real change is reported with where it is',
        Boolean(changed) && typeof changed === 'object' && /CHANGED/.test(changed.text) && /x 10.17, y 5.10/.test(changed.text),
        JSON.stringify(changed && changed.text));
      const diffImg = png.decodePng(Buffer.from(changed.__image.data, 'base64'));
      check('visual: ...with a diff image, changed pixels in red', JSON.stringify(px(diffImg, 12, 7)) === '[255,0,0,255]');
      check('visual: ...captioned as a diff so it is not read as a screenshot to critique',
        /^\[Screenshot from browser_visual_check/.test(changed.__image.caption) && /DIFF/.test(changed.__image.caption));

      const upd = await provider.toolBrowserVisualCheck('home', true);
      check('visual: update accepts the current screen as the new baseline', /Updated the baseline/.test(upd), upd);
      const after = await provider.toolBrowserVisualCheck('home');
      check('visual: ...so the same screen then matches', typeof after === 'string' && /matches its baseline/.test(after), String(after));

      const evil = await provider.toolBrowserVisualCheck('../../outside');
      check('visual: a name cannot climb out of the baselines folder',
        fs.existsSync(path.join(dir, 'localhost__outside.png')) && !fs.existsSync(path.join(tmp, 'outside.png')), evil);
      check('visual: a check needs a name', /needs a name/.test(await provider.toolBrowserVisualCheck('  ')));

      // A local dev server's port is not part of its identity.
      where = { host: 'localhost:5174', hostname: 'localhost', url: 'http://localhost:5174/' };
      const movedPort = await provider.toolBrowserVisualCheck('home');
      check('visual: a dev server that moved port still compares against its baseline',
        typeof movedPort === 'string' && /matches its baseline/.test(movedPort), String(movedPort));
      where = { host: '127.0.0.1:8080', hostname: '127.0.0.1', url: 'http://127.0.0.1:8080/' };
      const alias = await provider.toolBrowserVisualCheck('home');
      check('visual: ...and so does the same machine spelled 127.0.0.1',
        typeof alias === 'string' && /matches its baseline/.test(alias), String(alias));
      where = { host: 'staging.example.com:8443', hostname: 'staging.example.com', url: 'https://staging.example.com:8443/' };
      const staging = await provider.toolBrowserVisualCheck('home');
      check('visual: a real domain keeps its port, so staging is never compared with the live site',
        /saved the current screen as its baseline/.test(staging) && fs.existsSync(path.join(dir, 'staging.example.com-8443__home.png')), staging);
      check('visual: with no folder open the baselines are shared by every project, so a local port still tells apps apart',
        provider._baselineHost({ host: 'localhost:3000', hostname: 'localhost' }, false) === 'localhost-3000');
      check('visual: a LAN dev server drops its port inside a project',
        provider._baselineHost({ host: '192.168.1.20:5173', hostname: '192.168.1.20' }, true) === '192.168.1.20');
      check('visual: ...as do *.localhost names and IPv6 loopback',
        provider._baselineHost({ host: 'app.localhost:3000', hostname: 'app.localhost' }, true) === 'app.localhost'
        && provider._baselineHost({ host: '[::1]:3000', hostname: '[::1]' }, true) === 'localhost');
      check('visual: a page answer without hostname falls back to the host minus its port',
        provider._baselineHost({ host: 'localhost:4000' }, true) === 'localhost');
      provider._session.browser = null;
      check('visual: needs an open page', /no page open/.test(await provider.toolBrowserVisualCheck('home')));
    } finally {
      try { provider?.dispose?.(); } catch {}
      try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  // ── captureFixed captures the page at rest ──────────────────────────────────
  // Measured in real Chrome, a focus ring left by the Tab walk, a scrolled page
  // and a :hover style under the mouse each changed hundreds to thousands of
  // pixels of an untouched screen. This pins the order that prevents all three.
  {
    const b = new Browser({ existsSync: () => false });
    const log = [];
    b._send = async (method, params) => {
      log.push(method === 'Input.dispatchMouseEvent' ? `${method} ${params.type} ${params.x},${params.y}` : method);
      return method === 'Page.captureScreenshot' ? { data: 'PNG' } : {};
    };
    let scrolledTo = { x: 0, y: 1815 };
    b.evaluate = async (expr) => {
      if (/blur\(\)/.test(expr) && /scrollTo\(0, 0\)/.test(expr)) { log.push('settle'); return scrolledTo; }
      if (/^window\.scrollTo\(/.test(expr)) { log.push(expr); return undefined; }
      return true;
    };
    const data = await b.captureFixed();
    const at = (s) => log.indexOf(s);
    check('captureFixed: moves the mouse off the page first, so no :hover style is captured',
      log[0] === 'Input.dispatchMouseEvent mouseMoved -1,-1', JSON.stringify(log));
    check('captureFixed: ...blurs focus and scrolls to the top before capturing',
      at('settle') > 0 && at('settle') < at('Page.captureScreenshot'), JSON.stringify(log));
    check('captureFixed: ...captures at the fixed size, then clears the override',
      at('Emulation.setDeviceMetricsOverride') < at('Page.captureScreenshot')
      && at('Page.captureScreenshot') < at('Emulation.clearDeviceMetricsOverride') && data === 'PNG', JSON.stringify(log));
    check('captureFixed: ...and puts the scroll back afterwards',
      log[log.length - 1] === 'window.scrollTo(0, 1815)', JSON.stringify(log));
    log.length = 0;
    scrolledTo = { x: 0, y: 0 };
    await b.captureFixed();
    check('captureFixed: a page already at the top is not scrolled again', !log.some(s => /^window\.scrollTo/.test(s)), JSON.stringify(log));
  }

  // ── The diff reaches the model captioned as a diff ──────────────────────────
  {
    const os = require('os');
    const png = require('../src/png.js');
    const { ctrl } = sharedMock();
    let provider, tmp;
    const realFetch = global.fetch;
    try {
      const { NavyCoderViewProvider } = require('../src/extension.js');
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-visualturn-'));
      provider = new NavyCoderViewProvider(makeContext(tmp));
      provider.projectRoot = tmp;
      provider.view = { webview: { postMessage: () => {} } };
      provider._wslCache = { available: false };
      const white = { width: 20, height: 10, data: new Uint8Array(20 * 10 * 4).fill(255) };
      const dark = { width: 20, height: 10, data: new Uint8Array(20 * 10 * 4).fill(40) };
      let screen = white;
      provider._session.browser = {
        running: true,
        evaluate: async () => ({ host: 'site.test' }),
        captureFixed: async () => png.encodePng(screen).toString('base64'),
      };
      await provider.toolBrowserVisualCheck('home');   // seed the baseline
      screen = dark;
      const captured = [];
      global.fetch = queueOllamaFetch([
        { toolCalls: [{ name: 'browser_visual_check', args: { name: 'home' } }] },
        { text: 'Done.' },
      ], captured);
      await provider.askNavy('check the home screen', false, null, [], []);
      const msgs = (captured[1] && captured[1].messages) || [];
      const img = msgs.find(m => Array.isArray(m.images) && m.images.length);
      check('visual: the diff reaches the model as a vision message', Boolean(img), JSON.stringify(msgs.map(m => m.role)));
      check('visual: ...captioned as a diff of that screen', Boolean(img) && /DIFF of "home"/.test(img.content || ''), img && img.content);
    } finally {
      global.fetch = realFetch;
      ctrl.reset?.();
      try { provider?.dispose?.(); } catch {}
      try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
  // ── Tool schemas and prompt wiring ─────────────────────────────────────────
  {
    const { TOOLS, TOOLS_API, TOOL_PROMPT } = require('../src/providers/tools.js');
    const names = new Set(TOOLS.map(t => t.name));
    const browserTools = ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_type',
      'browser_hover', 'browser_press', 'browser_upload', 'browser_wait', 'browser_viewport', 'browser_tabs',
      'browser_dialog', 'browser_drag', 'browser_forward', 'browser_network',
      'browser_scroll', 'browser_evaluate', 'browser_console', 'browser_back', 'browser_close',
      'browser_accessibility', 'browser_visual_check'];
    check('every browser tool is declared in TOOLS', browserTools.every(n => names.has(n)),
      browserTools.filter(n => !names.has(n)).join(', '));
    check('browser tools ride on the wire schema (TOOLS_API)', browserTools.every(n => TOOLS_API.some(t => t.function.name === n)));
    check('the tool prompt lists the browser tools', /browser_navigate/.test(TOOL_PROMPT) && /browser_screenshot/.test(TOOL_PROMPT));
    check('...including the ones that reach the parts of a UI the others cannot',
      /browser_hover/.test(TOOL_PROMPT) && /browser_upload/.test(TOOL_PROMPT) && /browser_viewport/.test(TOOL_PROMPT));
    const nav = TOOLS.find(t => t.name === 'browser_navigate');
    check('browser_navigate requires a url', nav.parameters.required.includes('url'));
    const type = TOOLS.find(t => t.name === 'browser_type');
    check('browser_type requires the text, and takes a ref or a selector for where',
      type.parameters.required.includes('text') && !type.parameters.required.includes('ref')
      && type.parameters.properties.selector && type.parameters.properties.ref);
    check('every tool that acts on an element accepts a selector as well as a ref',
      ['browser_click', 'browser_hover', 'browser_upload'].every(n => {
        const p = TOOLS.find(x => x.name === n).parameters.properties;
        return p.ref && p.selector;
      }));
  }

  // ── The manifest declares the browser settings ─────────────────────────────
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const props = manifest.contributes.configuration.properties;
    check('navy.chromePath is declared', props['navy.chromePath']?.type === 'string');
    check('navy.browserHeadless is declared and defaults to false (headed)', props['navy.browserHeadless']?.type === 'boolean' && props['navy.browserHeadless'].default === false);
  }
}


// ── Driving a UI, not just a page ────────────────────────────────────────────
// A dialog used to stall the whole session, a popup was never followed, an
// iframe's controls were invisible, and there was no way to hover, press a key,
// attach a file, drag, wait, or resize. Each of those is a thing a tester does
// on the way to a bug, so each is checked here against the fake pipe, and
// against a real Chrome in test/integration.
async function browserControlSuite() {
  console.log('\nbrowser: driving the whole UI:');
  const { quadArea, keySpec, describeTarget, missingTarget } = browser;

  // ── Pure helpers ───────────────────────────────────────────────────────────
  check('a content quad\'s area is its real area', quadArea([0, 0, 10, 0, 10, 4, 0, 4]) === 40);
  check('...and a collapsed one has none', quadArea([5, 5, 5, 5, 5, 5, 5, 5]) === 0);
  check('a named key carries the code Chrome wants', keySpec('Escape').code2 === 27 && keySpec('escape').code === 'Escape');
  check('a printable key carries its text, so it types', keySpec('a').text === 'a' && keySpec('a').code === 'KeyA');
  check('an unknown key is refused rather than sent as nothing', keySpec('Fnord') === null);
  check('a target names itself the way it was given',
    describeTarget(7) === 'ref 7' && describeTarget({ selector: '#a' }) === '"#a"');
  check('a stale ref and a selector that matches nothing say different things',
    /stale/.test(missingTarget({ ref: 3 })) && /matches nothing/.test(missingTarget({ selector: '.x' })));

  // ── A fake Chrome that records what it was asked to do ─────────────────────
  const sentOf = (log, method) => log.filter(m => m.method === method);
  const openBrowser = async (extra = () => undefined) => {
    const log = [];
    const fake = fakeChrome((msg) => {
      log.push(msg);
      const custom = extra(msg, log);
      if (custom !== undefined) return custom;
      return defaultHandler(msg);
    });
    const b = new Browser({ chromePath: '/fake/chrome', existsSync: () => true, spawn: () => fake.proc, navTimeout: 200, commandTimeout: 2000 });
    await b.launch();
    return { b, fake, log };
  };

  // ── Dialogs ────────────────────────────────────────────────────────────────
  {
    const { b, fake, log } = await openBrowser();
    fake.emit4(fake.frame({ method: 'Page.javascriptDialogOpening', params: { type: 'confirm', message: 'delete it?' }, sessionId: 'S1' }));
    await new Promise(r => setTimeout(r, 30));
    const answered = sentOf(log, 'Page.handleJavaScriptDialog');
    check('a dialog is answered instead of being left to stall the session',
      answered.length === 1 && answered[0].params.accept === true, JSON.stringify(answered));
    check('...and reported like any other page event',
      b.drainEvents(false).some(e => e.kind === 'dialog' && /delete it\?/.test(e.text)));

    b.setDialogPolicy({ accept: false, promptText: 'typed answer' });
    fake.emit4(fake.frame({ method: 'Page.javascriptDialogOpening', params: { type: 'prompt', message: 'name?' }, sessionId: 'S1' }));
    await new Promise(r => setTimeout(r, 30));
    const second = sentOf(log, 'Page.handleJavaScriptDialog')[1];
    check('a confirm can be cancelled, which is what tests what it guards', second.params.accept === false);
    check('...and a prompt gets the answer the caller set', second.params.promptText === 'typed answer');

    fake.emit4(fake.frame({ method: 'Page.javascriptDialogOpening', params: { type: 'beforeunload', message: '' }, sessionId: 'S1' }));
    await new Promise(r => setTimeout(r, 30));
    check('a beforeunload is always accepted, or the page could never be left',
      sentOf(log, 'Page.handleJavaScriptDialog')[2].params.accept === true);
    await b.close();
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────
  {
    const { b, fake } = await openBrowser((msg) => {
      if (msg.method === 'Runtime.evaluate' && msg.sessionId === 'S2') {
        return { result: { value: { title: 'Popup Page', url: 'http://x.test/popup' } } };
      }
      return undefined;
    });
    check('the tab Navy opened is the only one listed at the start', b._tabs.length === 1);
    fake.emit4(fake.frame({ method: 'Target.attachedToTarget', params: { sessionId: 'S2', targetInfo: { type: 'page', targetId: 'T2', url: 'http://x.test/popup' } } }));
    await new Promise(r => setTimeout(r, 30));
    check('a popup is attached and becomes the tab being driven',
      b._tabs.length === 2 && b._sessionId === 'S2', JSON.stringify(b._tabs));
    check('...and is announced, so the model knows where it now is',
      b.drainEvents(false).some(e => e.kind === 'tab' && /new tab opened/.test(e.text)));
    const tabs = await b.listTabs();
    check('the tab list says which one is current', tabs.length === 2 && tabs[1].current === true && tabs[0].current === false);

    fake.emit4(fake.frame({ method: 'Target.detachedFromTarget', params: { sessionId: 'S2' } }));
    await new Promise(r => setTimeout(r, 30));
    check('closing the current tab falls back to the one underneath',
      b._tabs.length === 1 && b._sessionId === 'S1');

    // A tab that was already open before Navy started is not part of the run.
    b._ignoreTargets.add('T9');
    fake.emit4(fake.frame({ method: 'Target.attachedToTarget', params: { sessionId: 'S9', targetInfo: { type: 'page', targetId: 'T9', url: 'about:blank' } } }));
    await new Promise(r => setTimeout(r, 30));
    check('the browser\'s own starting tab is left out of the run', b._tabs.length === 1);
    await b.close();
  }

  // ── Frames ─────────────────────────────────────────────────────────────────
  {
    const rowsFor = { 1: 'Main button', 2: 'Child button', 5: 'Cross-origin button' };
    const { b, fake } = await openBrowser((msg) => {
      // A real frame tree, so the top frame is known to be the top frame.
      if (msg.method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: msg.sessionId === 'S5' ? 'FRAME-OOP' : 'FRAME-MAIN' } } };
      }
      if (msg.method !== 'Runtime.evaluate' || !/__navyRefs/.test(msg.params.expression || '')) return undefined;
      const label = rowsFor[msg.params.contextId] || 'unknown';
      return { result: { value: { title: 'T', url: 'http://x.test/' + (msg.sessionId || 'main'), nodes: [{ ref: 0, role: 'button', text: label, x: 5, y: 5, act: true }] } } };
    });
    // The main frame, a same-origin child frame, and a cross-origin one.
    const ctx = (id, frameId, sessionId) => fake.emit4(fake.frame({ method: 'Runtime.executionContextCreated', params: { context: { id, auxData: { frameId, isDefault: true } } }, ...(sessionId ? { sessionId } : {}) }));
    ctx(1, 'FRAME-MAIN', 'S1');
    ctx(2, 'FRAME-CHILD', 'S1');
    fake.emit4(fake.frame({ method: 'Target.attachedToTarget', params: { sessionId: 'S5', targetInfo: { type: 'iframe', targetId: 'T5', url: 'http://other.test/' } }, sessionId: 'S1' }));
    ctx(5, 'FRAME-OOP', 'S5');
    await new Promise(r => setTimeout(r, 30));

    const snap = await b.snapshot();
    const texts = snap.nodes.map(n => n.text);
    check('a snapshot covers every frame, not just the top one',
      texts.includes('Main button') && texts.includes('Child button') && texts.includes('Cross-origin button'), JSON.stringify(texts));
    check('...with the frame rows marked as such',
      snap.nodes.find(n => n.text === 'Child button').frame && !snap.nodes.find(n => n.text === 'Main button').frame);
    check('...and refs numbered across the whole page', snap.nodes.map(n => n.ref).join(',') === '0,1,2');
    check('each ref remembers the frame it came from',
      b._refs[2].sessionId === 'S5' && b._refs[1].contextId === 2 && b._refs[0].contextId === 1, JSON.stringify(b._refs));
    await b.close();
  }

  // ── Clicking, typing, hovering, pressing, uploading ────────────────────────
  {
    const { b, log } = await openBrowser((msg) => {
      if (msg.method === 'Runtime.evaluate' && /__navyRefs/.test(msg.params.expression || '')) {
        return { result: { objectId: 'OBJ-' + (msg.sessionId || 'S1') } };
      }
      if (msg.method === 'DOM.getContentQuads') return { quads: [[10, 20, 30, 20, 30, 40, 10, 40]] };
      if (msg.method === 'DOM.requestNode') return { nodeId: 77 };
      if (msg.method === 'Runtime.callFunctionOn') {
        const f = msg.params.functionDeclaration || '';
        if (/tagName/.test(f)) return { result: { value: { tag: 'select', type: '' } } };
        if (/options/.test(f)) return { result: { value: { ok: true, chosen: 'Bananas', value: 'b' } } };
        return { result: { value: null } };
      }
      return undefined;
    });
    b._refs = [{ sessionId: 'S1', contextId: 1, index: 0 }];

    const at = await b.click(0);
    check('a click lands at the centre of the element\'s content quad', at.x === 20 && at.y === 30, JSON.stringify(at));
    const mouse = sentOf(log, 'Input.dispatchMouseEvent');
    check('...as a real move, press and release', mouse.some(m => m.params.type === 'mousePressed') && mouse.some(m => m.params.type === 'mouseReleased'));

    log.length = 0;
    await b.click(0, { button: 'right' });
    check('a right-click is sent as one', sentOf(log, 'Input.dispatchMouseEvent').some(m => m.params.button === 'right' && m.params.type === 'mousePressed'));
    log.length = 0;
    await b.click(0, { clicks: 2 });
    check('a double-click sends the second press with clickCount 2',
      sentOf(log, 'Input.dispatchMouseEvent').some(m => m.params.type === 'mousePressed' && m.params.clickCount === 2));

    // A <select> is chosen from, not typed into.
    const chosen = await b.type(0, 'Bananas');
    check('typing into a dropdown picks the matching option', chosen.select === true && chosen.chosen === 'Bananas', JSON.stringify(chosen));
    check('...without sending keystrokes to it', !sentOf(log, 'Input.insertText').length);

    // Hover: the pointer AND the forced pseudo-state, because a headed window
    // ignores a synthetic move.
    log.length = 0;
    await b.hover(0);
    check('hovering moves the pointer onto the element',
      sentOf(log, 'Input.dispatchMouseEvent').some(m => m.params.type === 'mouseMoved' && m.params.x === 20));
    const forced = sentOf(log, 'CSS.forcePseudoState');
    check('...and forces :hover, which is the half that works in a visible window',
      forced.length === 1 && forced[0].params.forcedPseudoClasses.join() === 'hover' && forced[0].params.nodeId === 77);
    log.length = 0;
    await b.clearHover();
    check('letting go clears the forced state and takes the pointer off',
      sentOf(log, 'CSS.forcePseudoState')[0].params.forcedPseudoClasses.length === 0
      && sentOf(log, 'Input.dispatchMouseEvent').some(m => m.params.x === -1));

    // Keys, with and without modifiers.
    log.length = 0;
    await b.press('Escape');
    const esc = sentOf(log, 'Input.dispatchKeyEvent');
    check('a named key is sent with its Windows virtual key code', esc[0].params.windowsVirtualKeyCode === 27 && esc[0].params.key === 'Escape');
    check('...and released afterwards', esc[1].params.type === 'keyUp');
    log.length = 0;
    await b.press('Control+a');
    const combo = sentOf(log, 'Input.dispatchKeyEvent')[0];
    check('a shortcut carries the modifier bit', combo.params.modifiers === 2 && combo.params.key === 'a');
    check('...and no text, or the shortcut would type a character instead', combo.params.text === undefined);
    let keyErr = '';
    try { await b.press('Hyper+x'); } catch (e) { keyErr = e.message; }
    check('an unknown modifier is refused rather than silently dropped', /unknown modifier/.test(keyErr), keyErr);

    await b.close();
  }

  // ── Uploads, waiting, viewport, network, drag ──────────────────────────────
  {
    let bodyText = 'loading';
    const { b, log } = await openBrowser((msg) => {
      if (msg.method === 'Runtime.evaluate') {
        const e = msg.params.expression || '';
        if (/__navyRefs/.test(e)) return { result: { objectId: 'OBJ' } };
        if (/innerText/.test(e)) return { result: { value: bodyText.includes('ready') } };
      }
      if (msg.method === 'DOM.getContentQuads') return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] };
      if (msg.method === 'Runtime.callFunctionOn') {
        const f = msg.params.functionDeclaration || '';
        if (/tagName/.test(f)) return { result: { value: { tag: 'input', type: 'file' } } };
        if (/files/.test(f)) return { result: { value: { count: 1, names: ['a.png'] } } };
        return { result: { value: null } };
      }
      return undefined;
    });
    b._refs = [{ sessionId: 'S1', contextId: 1, index: 0 }];

    const up = await b.upload(0, ['C:\\ws\\a.png']);
    const set = sentOf(log, 'DOM.setFileInputFiles');
    check('a file input is filled through the DOM agent, the only way that works',
      set.length === 1 && set[0].params.files[0] === 'C:\\ws\\a.png' && up.count === 1, JSON.stringify(set));

    // Waiting returns as soon as the page catches up, and gives up otherwise.
    setTimeout(() => { bodyText = 'ready'; }, 250);
    const found = await b.waitFor({ text: 'ready', timeout: 3000 });
    check('waiting returns when the page catches up', found.found === true && found.waitedMs < 3000, JSON.stringify(found));
    bodyText = 'loading';
    const gave = await b.waitFor({ text: 'ready', timeout: 600 });
    check('...and gives up rather than hanging the turn', gave.found === false && gave.waitedMs >= 600, JSON.stringify(gave));

    log.length = 0;
    const vp = await b.setViewport({ width: 390, height: 844, mobile: true });
    const metrics = sentOf(log, 'Emulation.setDeviceMetricsOverride')[0];
    check('a viewport is set as device metrics, so the layout really changes',
      metrics.params.width === 390 && metrics.params.mobile === true && vp.height === 844);
    check('...with touch emulation for a mobile one',
      sentOf(log, 'Emulation.setTouchEmulationEnabled')[0].params.enabled === true);
    log.length = 0;
    await b.captureFixed({ width: 1280, height: 800 });
    const after = sentOf(log, 'Emulation.setDeviceMetricsOverride').pop();
    check('a baseline capture puts the caller\'s viewport back rather than clearing it',
      after.params.width === 390 && !sentOf(log, 'Emulation.clearDeviceMetricsOverride').length, JSON.stringify(after.params));
    await b.clearViewport();
    check('resetting clears the override', Boolean(sentOf(log, 'Emulation.clearDeviceMetricsOverride').length));

    log.length = 0;
    await b.setNetworkCondition('offline');
    check('offline emulation is a real network condition, not a page trick',
      sentOf(log, 'Network.emulateNetworkConditions')[0].params.offline === true);
    await b.setNetworkCondition('slow');
    check('...and slow means latency and a throttled pipe',
      sentOf(log, 'Network.emulateNetworkConditions')[1].params.latency === 400);
    let netErr = '';
    try { await b.setNetworkCondition('potato'); } catch (e) { netErr = e.message; }
    check('an unknown condition is refused', /offline, slow or normal/.test(netErr), netErr);

    // Drag: mouse first, and the HTML5 events when the page starts a real drag.
    b._refs = [{ sessionId: 'S1', contextId: 1, index: 0 }, { sessionId: 'S1', contextId: 1, index: 1 }];
    log.length = 0;
    const plain = await b.drag(0, 1);
    const moves = sentOf(log, 'Input.dispatchMouseEvent').filter(m => m.params.type === 'mouseMoved');
    check('a drag is a gesture, not a jump', moves.length >= 4 && plain.html5 === false, String(moves.length));
    check('...bracketed by a press and a release',
      sentOf(log, 'Input.dispatchMouseEvent').some(m => m.params.type === 'mousePressed')
      && sentOf(log, 'Input.dispatchMouseEvent').some(m => m.params.type === 'mouseReleased'));
    await b.close();
  }

  // ── The tool layer ─────────────────────────────────────────────────────────
  {
    const os = require('os');
    const { ctrl } = sharedMock();
    let provider, tmp;
    try {
      const { NavyCoderViewProvider } = require('../src/extension.js');
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-browser-ui-'));
      provider = new NavyCoderViewProvider(makeContext(tmp));
      provider.projectRoot = tmp;
      provider.view = { webview: { postMessage: () => {} } };

      for (const call of ['toolBrowserHover', 'toolBrowserPress', 'toolBrowserUpload', 'toolBrowserWait',
        'toolBrowserViewport', 'toolBrowserTabs', 'toolBrowserDialog', 'toolBrowserDrag', 'toolBrowserForward', 'toolBrowserNetwork']) {
        // Every one of them refuses cleanly before a browser exists.
        const out = await provider[call]();
        if (!/no page open/.test(String(out))) check(`${call} reports "no page open" before navigate`, false, String(out));
      }
      check('every new browser tool refuses cleanly before a page is open', true);

      // A fake browser handle: the tool layer's own behaviour, without Chrome.
      const calls = [];
      provider._session.browser = {
        running: true,
        hover: async (t) => { calls.push(['hover', t]); },
        press: async (k) => { calls.push(['press', k]); },
        upload: async (t, files) => { calls.push(['upload', t, files]); return { count: files.length }; },
        drag: async (a, z) => { calls.push(['drag', a, z]); return { html5: true }; },
        type: async (t, text) => { calls.push(['type', t, text]); return { select: true, ok: false, options: ['Apples', 'Pears'] }; },
        click: async (t, o) => { calls.push(['click', t, o]); return { x: 1, y: 2, clicks: o.clicks, button: o.button }; },
        evaluate: async () => ({ title: 'T', url: 'http://x.test/' }),
        setDialogPolicy: (p) => ({ accept: p.accept, promptText: p.promptText }),
        listTabs: async () => ([{ index: 0, current: true, title: 'One', url: 'http://x.test/' }]),
        snapshot: async () => ({ title: 'T', url: 'u', nodes: [
          { ref: 0, role: 'button', text: 'Pay', x: 1, y: 1 },
          { ref: 1, role: 'button', text: 'Card number', x: 1, y: 1, frame: 'http://pay.test/' },
        ] }),
      };

      const snap = await provider.toolBrowserSnapshot();
      check('the outline tells the model which rows are inside an iframe',
        /\(in iframe: http:\/\/pay\.test\/\)/.test(snap) && /1 iframe/.test(snap), snap);

      check('an element can be named by selector where the outline has no row for it',
        /"#drop"/.test(await provider.toolBrowserHover(null, '#drop')), await provider.toolBrowserHover(null, '#drop'));
      check('...and a tool with neither says what it needs',
        /ref .*or a CSS selector/.test(await provider.toolBrowserHover()));

      const dd = await provider.toolBrowserClick(3, null, 'right', 2);
      check('a right double-click is passed through as one', /2× right-Clicked ref 3/.test(dd), dd);
      check('an invalid button is refused', /left, right or middle/.test(await provider.toolBrowserClick(1, null, 'foot')));

      const noOption = await provider.toolBrowserType(1, 'Cherries');
      check('a dropdown without the wanted option reports the real ones',
        /no option matching "Cherries"/.test(noOption) && /"Apples"/.test(noOption), noOption);

      // The file for an upload has to be in the workspace: the page it goes to
      // is a website, so anything else would be a way off the machine.
      fs.writeFileSync(path.join(tmp, 'shot.png'), 'x');
      const good = await provider.toolBrowserUpload(1, 'shot.png');
      check('a workspace file can be attached to a file input', /Attached shot\.png/.test(good), good);
      const outside = await provider.toolBrowserUpload(1, path.join(os.tmpdir(), 'elsewhere.txt'));
      check('a file outside the workspace is refused', /Error:/.test(outside), outside);
      const missing = await provider.toolBrowserUpload(1, 'nope.png');
      check('a file that does not exist is refused', /does not exist/.test(missing), missing);

      check('the dialog policy says which way it will answer',
        /dismissed \(Cancel\)/.test(await provider.toolBrowserDialog(false)));
      check('the tab list marks the current tab', /\(current\)/.test(await provider.toolBrowserTabs('list')));
      check('an unknown tab action is refused', /list, switch or close/.test(await provider.toolBrowserTabs('sideways', 0)));
      check('a drag reports whether the page took it as an HTML5 one',
        /as an HTML5 drag/.test(await provider.toolBrowserDrag(0, 1)), await provider.toolBrowserDrag(0, 1));
      check('browser_wait needs something to wait for', /text to wait for/.test(await provider.toolBrowserWait()));
      check('browser_viewport needs a size, or a reset', /width and a height/.test(await provider.toolBrowserViewport()));
      provider._session.browser = null;
    } finally {
      ctrl.reset?.();
      try { provider?.dispose?.(); } catch {}
      try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
}

module.exports = { browserSuite, browserControlSuite };
