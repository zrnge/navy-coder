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

  // ── Tool schemas and prompt wiring ─────────────────────────────────────────
  {
    const { TOOLS, TOOLS_API, TOOL_PROMPT } = require('../src/providers/tools.js');
    const names = new Set(TOOLS.map(t => t.name));
    const browserTools = ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_evaluate', 'browser_console', 'browser_back', 'browser_close'];
    check('all ten browser tools are declared in TOOLS', browserTools.every(n => names.has(n)));
    check('browser tools ride on the wire schema (TOOLS_API)', browserTools.every(n => TOOLS_API.some(t => t.function.name === n)));
    check('the tool prompt lists the browser tools', /browser_navigate/.test(TOOL_PROMPT) && /browser_screenshot/.test(TOOL_PROMPT));
    const nav = TOOLS.find(t => t.name === 'browser_navigate');
    check('browser_navigate requires a url', nav.parameters.required.includes('url'));
    const type = TOOLS.find(t => t.name === 'browser_type');
    check('browser_type requires ref + text', type.parameters.required.includes('ref') && type.parameters.required.includes('text'));
  }

  // ── The manifest declares the browser settings ─────────────────────────────
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const props = manifest.contributes.configuration.properties;
    check('navy.chromePath is declared', props['navy.chromePath']?.type === 'string');
    check('navy.browserHeadless is declared and defaults to false (headed)', props['navy.browserHeadless']?.type === 'boolean' && props['navy.browserHeadless'].default === false);
  }
}

module.exports = { browserSuite };
