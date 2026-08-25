const {
  fs, path, check, extractFunction, extSrc, makeContext, sharedMock,
} = require('./harness.js');

// ── 6f. Multi-root workspace awareness ──────────────────────────────────────
async function multiRootSuite() {
  console.log('\nmulti-root workspace awareness:');
  const os = require('os');
  const { vscode } = sharedMock();
  const uriOf = (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => p });

  let provider, dirA, dirB;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-rootA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-rootB-'));
    provider = new NavyCoderViewProvider(makeContext(dirA));
    provider.projectRoot = dirA;
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }, { uri: uriOf(dirB) }];

    fs.writeFileSync(path.join(dirA, 'a.js'), 'function fromA(){ return 1; }');
    fs.writeFileSync(path.join(dirB, 'b.js'), 'function fromB(){ return 2; }');

    // resolveWorkspacePath: a path inside a SIBLING open folder (not the
    // active projectRoot) is legitimate in a multi-root workspace, not a
    // traversal attempt.
    const resolvedSibling = provider.resolveWorkspacePath(path.join(dirB, 'b.js'));
    check('resolveWorkspacePath: accepts a path inside a sibling open folder', resolvedSibling === path.join(dirB, 'b.js'));

    // A path outside EVERY open folder must still be refused.
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-rootC-'));
    let threw = false;
    try { provider.resolveWorkspacePath(path.join(dirC, 'x.js')); } catch { threw = true; }
    check('resolveWorkspacePath: still refuses a path outside every open folder', threw);
    fs.rmSync(dirC, { recursive: true, force: true });

    // Existing single-root behavior is unaffected: a relative path still
    // resolves against the active projectRoot.
    check('resolveWorkspacePath: relative paths still resolve against the active project root',
      provider.resolveWorkspacePath('a.js') === path.join(dirA, 'a.js'));

    // _resolveTargetFolder: matches by full path or by folder basename.
    check('_resolveTargetFolder: matches a sibling folder by full path', provider._resolveTargetFolder(dirB).root === dirB);
    check('_resolveTargetFolder: matches a sibling folder by basename', provider._resolveTargetFolder(path.basename(dirB)).root === dirB);
    check('_resolveTargetFolder: no folder argument falls back to the active project', provider._resolveTargetFolder(undefined).root === dirA);
    const noMatch = provider._resolveTargetFolder('this-folder-does-not-exist');
    check('_resolveTargetFolder: an unmatched name returns an actionable error, not a silent fallback', Boolean(noMatch.error));

    // search_files/search_codebase/find_relevant_files: folder argument
    // actually redirects the search, not just accepted-and-ignored.
    const searchFilesB = await provider.toolSearchFiles('fromB', dirB);
    check('search_files: folder argument searches the sibling folder', searchFilesB.includes('b.js'));
    const searchFilesA = await provider.toolSearchFiles('fromB');
    check('search_files: omitting folder still searches only the active project', !searchFilesA.includes('b.js'));

    const searchCodebaseB = await provider.toolSearchCodebase('fromB', null, 2, dirB);
    check('search_codebase: folder argument searches the sibling folder', searchCodebaseB.includes('b.js'));

    const relevantB = await provider.toolFindRelevantFiles('fromB function', 5, dirB);
    check('find_relevant_files: folder argument ranks files from the sibling folder', relevantB.includes('b.js'));
    check('find_relevant_files: an unmatched folder name returns an actionable error',
      (await provider.toolFindRelevantFiles('anything', 5, 'nope-not-a-folder')).includes('does not match any open workspace folder'));

    // buildRepoMap: sibling-folder hint appears only when more than one
    // folder is actually open.
    const mapMulti = await provider.buildRepoMap();
    check('buildRepoMap: notes sibling open folders exist', mapMulti.includes('Other open folders') && mapMulti.includes(dirB));

    provider._repoMapCache = null; // bypass the 30s cache for the single-root re-check
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    const mapSingle = await provider.buildRepoMap();
    check('buildRepoMap: no sibling-folder hint when only one folder is open (unchanged single-root behavior)',
      !mapSingle.includes('Other open folders'));
  } catch (e) {
    check('multi-root suite ran', false, e.stack || e.message);
  } finally {
    if (provider) clearTimeout(provider._cpSaveTimer);
    vscode.workspace.workspaceFolders = undefined;
    try { if (dirA) fs.rmSync(dirA, { recursive: true, force: true }); } catch {}
    try { if (dirB) fs.rmSync(dirB, { recursive: true, force: true }); } catch {}
  }
}

// ── 6g. Session isolation (per-project state extracted into a Session class) ─
// Every existing suite above already exercises the getter/setter proxies
// indiscriminately (they ran unmodified against the new Session-backed
// provider), which is the main proof this refactor preserves behavior. These
// tests target what's actually NEW: switching projectRoot must retain each
// session's in-memory state independently rather than resetting or sharing it.
async function sessionIsolationSuite() {
  console.log('\nsession isolation (Session class extraction):');
  const os = require('os');
  sharedMock();

  let provider, dirA, dirB;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-sessA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-sessB-'));
    provider = new NavyCoderViewProvider(makeContext(dirA));

    // Tabs are identified by a generated id, not by project root (a tab can
    // exist before any project is assigned) — openNewSessionTab creates one
    // and switchSessionTab(id) moves between them, mirroring the real UI flow.
    const sessionA = provider.activeSessionId; // the default tab created by the constructor
    provider.projectRoot = dirA;
    provider.messages = [{ role: 'user', text: 'hello from A' }];
    provider.isBusy = true;
    provider.checkpoints.push({ kind: 'edit', filePath: path.join(dirA, 'f.js'), originalText: 'old' });
    const writeLockA = provider._writeLock;
    const bgProcessesA = provider.bgProcesses;

    // A brand-new tab must start with a completely fresh session, not leak
    // A's messages/busy-flag/checkpoints/locks into it.
    await provider.openNewSessionTab();
    const sessionB = provider.activeSessionId;
    check('opening a new tab: gets its own distinct session id', sessionB !== sessionA);
    provider.projectRoot = dirB;
    check('new tab: messages start empty, not leaked from the previous session', provider.messages.length === 0);
    check('new tab: isBusy resets, not leaked from the previous session', provider.isBusy === false);
    check('new tab: checkpoints start empty, not leaked from the previous session', provider.checkpoints.length === 0);
    check('new tab: bgProcesses is a SEPARATE Map instance, not shared with the previous session',
      provider.bgProcesses !== bgProcessesA);
    check('new tab: _writeLock is a SEPARATE lock chain, so a write in one project can never queue behind a write in the other',
      provider._writeLock !== writeLockA);

    // Switching BACK must retain A's state exactly as it was left — this is
    // the actual point of extracting Session objects instead of just
    // resetting everything on every switch. Uses activeSessionId directly
    // (not switchSessionTab, which does real disk I/O via loadProjectSession
    // — appropriate for the real UI flow, but this test targets the pure
    // in-memory Session mechanics, same as the plain projectRoot-assignment
    // style the rest of this suite already uses).
    provider.activeSessionId = sessionA;
    check('switch back to tab A: messages are exactly as left, not reloaded/reset', provider.messages.length === 1 && provider.messages[0].text === 'hello from A');
    check('switch back to tab A: isBusy is exactly as left', provider.isBusy === true);
    check('switch back to tab A: checkpoints are exactly as left', provider.checkpoints.length === 1);
    check('switch back to tab A: bgProcesses is the SAME Map instance as before (identity, not a copy)', provider.bgProcesses === bgProcessesA);

    // Sanity: B's state (set independently while A was active above) must
    // still be its own, unaffected by anything done to A afterward.
    provider.activeSessionId = sessionB;
    check('tab B state is still isolated after further changes to A', provider.messages.length === 0 && provider.checkpoints.length === 0);

    // ── _ensureProjectChatsLoaded reads a project's saved chats in parallel,
    // not one at a time — all must still load correctly regardless.
    let dirC;
    try {
      dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-sessC-'));
      const chatsDir = path.join(dirC, '.navy', 'chats');
      fs.mkdirSync(chatsDir, { recursive: true });
      const ids = ['chat1', 'chat2', 'chat3'];
      for (const id of ids) {
        fs.writeFileSync(path.join(chatsDir, id + '.json'), JSON.stringify({
          id, updated: new Date().toISOString(),
          messages: [{ role: 'user', text: 'hello from ' + id }],
          digest: '', checkpoints: [],
        }));
      }
      const freshProvider = new NavyCoderViewProvider(makeContext(dirC));
      await freshProvider._ensureProjectChatsLoaded(dirC);
      const loaded = ids.map(id => freshProvider.sessions.get(id));
      check('_ensureProjectChatsLoaded: all 3 chat files load, not just some (parallel reads)',
        loaded.every(Boolean));
      check('_ensureProjectChatsLoaded: each loaded chat has its own correct content, not mixed up',
        ids.every(id => loaded.find(s => s.id === id)?.messages?.[0]?.text === 'hello from ' + id));
      for (const session of freshProvider.sessions.values()) clearTimeout(session._cpSaveTimer);
    } finally {
      try { if (dirC) fs.rmSync(dirC, { recursive: true, force: true }); } catch {}
    }
  } catch (e) {
    check('session isolation suite ran', false, e.stack || e.message);
  } finally {
    if (provider) {
      for (const session of provider.sessions.values()) clearTimeout(session._cpSaveTimer);
    }
    try { if (dirA) fs.rmSync(dirA, { recursive: true, force: true }); } catch {}
    try { if (dirB) fs.rmSync(dirB, { recursive: true, force: true }); } catch {}
  }
}

// ── 6h. Session-tagged postMessage + tab management (backend) ────────────────
// Verifies the actual mechanism that lets a background tab's turn keep
// running safely: resolveWebviewView's postMessage wrapper tags every
// outgoing message with a session id, preferring sessionContext (so a turn
// stays bound to the session it started in) over the live activeSessionId.
async function sessionTaggingSuite() {
  console.log('\nsession-tagged postMessage + tab management:');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();

  let provider, dirA, dirB;
  try {
    const { NavyCoderViewProvider, sessionContext } = require('../src/extension.js');
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-tagA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-tagB-'));
    provider = new NavyCoderViewProvider(makeContext(dirA));
    // The constructor derives an initial session from shared mock config
    // that earlier suites may have left set — prune anything but the
    // default one so the close-tab assertions below have a deterministic
    // session count to work from, regardless of what leaked in from another
    // suite's state.
    const sessionA = provider.activeSessionId;
    for (const key of [...provider.sessions.keys()]) {
      if (key !== sessionA) provider.sessions.delete(key);
    }
    provider.projectRoot = dirA; // assign a root to the default tab (id sessionA)

    // A second tab, identified by its OWN generated id, independent of
    // whatever root gets assigned to it (or not).
    await provider.openNewSessionTab();
    const sessionB = provider.activeSessionId;
    provider.projectRoot = dirB;
    provider.activeSessionId = sessionA; // back to A as "currently displayed", no disk I/O

    const posted = [];
    const fakeWebview = {
      postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
      asWebviewUri: (u) => u,
      cspSource: 'test-csp',
      onDidReceiveMessage: () => ({ dispose() {} }),
    };
    const fakeView = { webview: fakeWebview, onDidDispose: () => {}, onDidChangeVisibility: () => {} };
    await provider.resolveWebviewView(fakeView);

    // Outside any turn, postMessage tags with whichever session is currently active.
    posted.length = 0;
    provider.view.webview.postMessage({ type: 'probe1' });
    check('postMessage: tags with the live active session outside any turn', posted[0].sessionId === sessionA);

    // Switching the active session changes what UN-wrapped code gets tagged with.
    provider.activeSessionId = sessionB;
    posted.length = 0;
    provider.view.webview.postMessage({ type: 'probe2' });
    check('postMessage: reflects the NEW active session after a switch (no turn in progress)', posted[0].sessionId === sessionB);

    // The actual point: code running inside sessionContext.run(sessionA, ...)
    // stays tagged with sessionA even though the active session is now
    // sessionB — this is what keeps a background turn's messages routed to
    // ITS OWN tab.
    posted.length = 0;
    await sessionContext.run(sessionA, async () => {
      provider.view.webview.postMessage({ type: 'probe3' });
      // Switch AGAIN mid-"turn" — must not affect this context's tagging.
      provider.activeSessionId = sessionA; // back to A, but via the context, not the switch
    });
    check('postMessage: code inside sessionContext.run stays tagged with ITS session, not the live active one',
      posted[0].sessionId === sessionA);

    // And the _session getter itself resolves the same way — state accessed
    // from inside a sessionContext.run binds to THAT session even if
    // activeSessionId differs, which is what keeps a running turn's
    // messages/checkpoints/etc. from leaking into whatever tab is now visible.
    provider.activeSessionId = sessionB; // sessionB is now the live active session
    let messagesInsideContext;
    await sessionContext.run(sessionA, async () => {
      messagesInsideContext = provider.messages; // should resolve to sessionA's session
    });
    check('_session getter: resolves to the sessionContext session, not the live active one',
      messagesInsideContext === provider.sessions.get(sessionA).messages);

    // ── Tab management: tabs are CHILDREN of a project ───────────────────
    // Navigating between a project's own chats is purely Navy-internal — it
    // must never write navy.projectRoot to .vscode/settings.json or touch
    // the real VS Code Explorer/workspace. Only EXPLICITLY picking a
    // DIFFERENT project (via _switchProjectRoot, the dropdown's path) does
    // either of those.
    ctrl.scoped = {}; // clear whatever earlier persistence in this suite left behind
    ctrl.executedCommands = [];
    provider.activeSessionId = sessionA; // sessionA: dirA
    provider.sessions.get(sessionB).projectRoot = dirA; // rebind B to be A's sibling under the same project

    await provider.switchSessionTab(sessionB);
    check('switchSessionTab: becomes the active session', provider.activeSessionId === sessionB);
    check('switchSessionTab: sends an updated session list', posted.some(m => m.type === 'sessionList'));
    check('switchSessionTab: never persists the project root (switching a project\'s own chats is not switching projects)',
      !ctrl.scoped.projectRoot && !provider.context.workspaceState.get('navy.lastProjectRoot'));
    check('switchSessionTab: never touches the real VS Code Explorer/workspace',
      !ctrl.executedCommands.some(c => c.command === 'revealInExplorer'));

    // The tab strip only shows the ACTIVE PROJECT's own chats — not a flat
    // list spanning every project ever opened.
    const summaries = provider._sessionSummaries();
    check('_sessionSummaries: only includes chats belonging to the active project',
      summaries.length === 2 && summaries.every(s => s.root === dirA));
    check('_sessionSummaries: includes both siblings',
      summaries.some(s => s.id === sessionA) && summaries.some(s => s.id === sessionB));

    // Explicitly picking a DIFFERENT project from the dropdown DOES persist
    // and DOES reveal it in Explorer — "from the VS Code side too". Give the
    // active chat real content first, so the switch has to spawn a fresh
    // chat under the new project rather than silently repurposing an
    // in-progress conversation.
    provider.messages = [{ role: 'user', text: 'hello from B' }];
    posted.length = 0;
    const sessionBeforeSwitch = provider.activeSessionId;
    await provider._switchProjectRoot(dirB);
    check('_switchProjectRoot (dropdown pick): remembers the root in workspaceState',
      provider.context.workspaceState.get('navy.lastProjectRoot') === dirB);
    check('_switchProjectRoot (dropdown pick): does NOT write navy.projectRoot into the repo settings',
      !ctrl.scoped.projectRoot);
    check('_switchProjectRoot (dropdown pick): reveals the folder in VS Code\'s own Explorer',
      ctrl.executedCommands.some(c => c.command === 'revealInExplorer' && c.args[0]?.fsPath === dirB));
    check('_switchProjectRoot: a project with no chats yet and a non-blank active tab starts a FRESH chat, not a reused one',
      provider.activeSessionId !== sessionBeforeSwitch && provider.projectRoot === dirB && provider.messages.length === 0);
    check('_switchProjectRoot: the chat left behind on the old project is untouched, not discarded',
      provider.sessions.has(sessionB) && provider.sessions.get(sessionB).messages.length === 1);
    check('_switchProjectRoot (dropdown pick): also sends an updated session list',
      posted.some(m => m.type === 'sessionList' && m.sessions.some(s => s.root === dirB && s.active)));
    const sessionC = provider.activeSessionId; // the freshly created dirB chat

    // Switching back to dirA resumes whichever chat was last active there
    // (sessionB, from the switchSessionTab call above) — not a new one.
    // Regression: the constructor's bootstrap placeholder (sessionA) is
    // still blank, and this is dirA's first REAL activation this window, so
    // it gets cleaned up in favor of the real chat instead of lingering as a
    // dangling empty duplicate.
    posted.length = 0;
    await provider._switchProjectRoot(dirA);
    check('_switchProjectRoot: switching back to a project resumes the chat you were last on',
      provider.activeSessionId === sessionB);
    check('_switchProjectRoot: the never-used bootstrap tab is cleaned up once a real chat for its project is found',
      !provider.sessions.has(sessionA));

    // New-tab workflow: "+" creates a chat as a CHILD of the CURRENT
    // project — no dialog, no separate "assign a project" step.
    let dialogShown = false;
    const realShowOpenDialog = vscode.window.showOpenDialog;
    vscode.window.showOpenDialog = async (...args) => { dialogShown = true; return realShowOpenDialog(...args); };
    posted.length = 0;
    const sessionBeforeNewTab = provider.activeSessionId;
    await provider.openNewSessionTab();
    check('openNewSessionTab: never opens a folder picker dialog', !dialogShown);
    check('openNewSessionTab: switches to a brand-new session', provider.activeSessionId !== sessionBeforeNewTab);
    check('openNewSessionTab: the new chat inherits the CURRENT project as its parent', provider.projectRoot === dirA);
    check('openNewSessionTab: shown as "New Chat" in the tab strip (no messages yet)',
      provider._sessionSummaries().find(s => s.id === provider.activeSessionId)?.name === 'New Chat');
    vscode.window.showOpenDialog = realShowOpenDialog;
    const sessionD = provider.activeSessionId;

    // closeSessionTab freely closes a chat that still has a sibling under
    // the same project, falling back to that sibling.
    posted.length = 0;
    await provider.closeSessionTab(sessionD);
    check('closeSessionTab: removes the session', !provider.sessions.has(sessionD));
    check('closeSessionTab: falls back to the remaining sibling under the same project', provider.activeSessionId === sessionB);

    // Refuses to close a project's very last remaining chat. sessionC (a
    // DIFFERENT project, dirB) existing elsewhere must not count as a
    // sibling that makes this "safe" — tabs only compete with their own
    // project's siblings.
    posted.length = 0;
    await provider.closeSessionTab(sessionB);
    check('closeSessionTab: refuses to close a project\'s last remaining chat',
      provider.sessions.has(sessionB) && provider.activeSessionId === sessionB);
    check('closeSessionTab: a DIFFERENT project\'s chat count never satisfies this project\'s "last one" guard',
      provider.sessions.has(sessionC));

    // ── Project-scoped state (write lock, embeddings cache, gutter ranges) ──
    // These must be SHARED across sibling chats on the same project, not
    // duplicated per chat — duplicating them was a real bug: two sibling
    // chats writing to the same file at once wouldn't serialize against
    // each other (the write lock exists specifically to prevent
    // interleaved writes), and each kept its own copy of the shared
    // embeddings.json cache, so whichever chat's debounced save fired last
    // silently discarded the other's contribution.
    await provider.openNewSessionTab(); // sibling of sessionB, same project (dirA)
    const sessionE = provider.activeSessionId;
    provider._writeLock = Promise.resolve('marker-A');
    provider._embedIndexCache = { root: dirA, marker: 'A' };
    provider.editedRanges.set('marker-file.js', [{ start: 1, end: 2 }]);
    const lockSetFromE = provider._writeLock;

    provider.activeSessionId = sessionB; // sibling, same project — direct switch, no I/O
    check('project-scoped write lock: shared across sibling chats on the same project',
      provider._writeLock === lockSetFromE);
    check('project-scoped embeddings cache: shared across sibling chats on the same project',
      provider._embedIndexCache?.marker === 'A');
    check('project-scoped gutter decorations: shared across sibling chats on the same project',
      provider.editedRanges.get('marker-file.js')?.length === 1);

    provider.activeSessionId = sessionC; // a DIFFERENT project (dirB)
    check('project-scoped write lock: isolated from a DIFFERENT project',
      provider._writeLock !== lockSetFromE);
    check('project-scoped embeddings cache: isolated from a DIFFERENT project',
      provider._embedIndexCache?.marker !== 'A');
    check('project-scoped gutter decorations: isolated from a DIFFERENT project',
      !provider.editedRanges.has('marker-file.js'));
    provider.activeSessionId = sessionB;

    // ── Message ordering: 'sessionList' (gate-exempt) must reach the
    // frontend BEFORE any message tagged with a newly-active session that
    // the frontend has no advance notice of — otherwise the frontend (still
    // holding the OLD activeSessionId) silently drops 'restore'/
    // 'sessionLoaded' via its per-message gate, and the user sees a blank
    // thread instead of the target chat's real content.
    posted.length = 0;
    await provider.openNewSessionTab();
    {
      const listIdx = posted.findIndex(m => m.type === 'sessionList');
      const restoreIdx = posted.findIndex(m => m.type === 'restore');
      const loadedIdx = posted.findIndex(m => m.type === 'sessionLoaded');
      check('openNewSessionTab: sessionList sent before restore',
        listIdx !== -1 && restoreIdx !== -1 && listIdx < restoreIdx);
      check('openNewSessionTab: sessionList sent before sessionLoaded',
        listIdx !== -1 && loadedIdx !== -1 && listIdx < loadedIdx);
    }
    // Same regression via closeSessionTab falling back to a sibling the
    // frontend had NO advance notice of (unlike a direct tab click, which
    // optimistically updates the frontend's activeSessionId itself first).
    const siblingToClose = provider.activeSessionId; // the tab just opened above
    posted.length = 0;
    await provider.closeSessionTab(siblingToClose);
    {
      const listIdx = posted.findIndex(m => m.type === 'sessionList');
      const restoreIdx = posted.findIndex(m => m.type === 'restore');
      check('closeSessionTab fallback: sessionList sent before restore for the sibling it switches to',
        listIdx !== -1 && restoreIdx !== -1 && listIdx < restoreIdx);
    }

    // ── cancelPendingApprovals (Stop/Clear) vs cancelAllPendingApprovals
    // (whole panel disposed) ─────────────────────────────────────────────
    // Stop/Clear are per-chat actions and must not reach into an unrelated
    // BACKGROUND tab and reject its approval. But when the whole webview
    // panel is disposed, nothing will ever resolve a background tab's
    // pending approval otherwise, hanging that turn forever — every
    // session's approvals must be resolved then, not just the active one.
    {
      const bg = provider.sessions.get(sessionC); // dirB chat, NOT currently active
      let bgResolved;
      bg.pendingApprovals.set('fake-bg-approval', { kind: 'agent-edit', resolve: (v) => { bgResolved = v; } });

      provider.cancelPendingApprovals(); // active-session-only
      check('cancelPendingApprovals: leaves a DIFFERENT (background) session\'s approval untouched',
        bg.pendingApprovals.has('fake-bg-approval') && bgResolved === undefined);

      provider.cancelAllPendingApprovals();
      check('cancelAllPendingApprovals: resolves a background session\'s approval too',
        !bg.pendingApprovals.has('fake-bg-approval') && bgResolved === 'reject');
    }

    // First-ever project pick (nothing ever selected before) reuses the
    // constructor's own blank bootstrap tab instead of leaving it dangling
    // and creating a redundant second one.
    {
      vscode.workspace.workspaceFolders = [];
      ctrl.scoped = {};
      const dirD = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-tagD-'));
      const { NavyCoderViewProvider: FreshProvider } = require('../src/extension.js');
      const fresh = new FreshProvider(makeContext(dirD));
      const freshBootstrapId = fresh.activeSessionId;
      try {
        await fresh._switchProjectRoot(dirD);
        check('fresh install: first-ever project pick reuses the bootstrap tab instead of spawning a new one',
          fresh.activeSessionId === freshBootstrapId && fresh.projectRoot === dirD && fresh.sessions.size === 1);
      } finally {
        clearTimeout(fresh._cpSaveTimer); clearInterval(fresh._heartbeat); clearTimeout(fresh._watchdog);
        try { fs.rmSync(dirD, { recursive: true, force: true }); } catch {}
      }
    }
  } catch (e) {
    check('session tagging suite ran', false, e.stack || e.message);
  } finally {
    if (provider) {
      for (const session of provider.sessions.values()) {
        clearTimeout(session._cpSaveTimer);
        clearInterval(session._heartbeat);
        clearTimeout(session._watchdog);
      }
    }
    try { if (dirA) fs.rmSync(dirA, { recursive: true, force: true }); } catch {}
    try { if (dirB) fs.rmSync(dirB, { recursive: true, force: true }); } catch {}
  }
}

// ── Project cache eviction (_projectCaches must not grow unbounded) ────────
// Without a cap, _projectCaches gains one entry (embedding index, repo map,
// relevance/.gitignore caches) for every distinct project root ever visited
// in this window, forever — a real memory-growth concern for a long-lived
// window that touches many repos. Eviction must ONLY ever remove a root with
// no currently-open chat tab, since that's the one condition guaranteeing no
// turn/background task could be using its write lock.
async function projectCacheEvictionSuite() {
  console.log('\nproject cache eviction (_projectCaches cap):');
  const os = require('os');
  sharedMock();

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-cacheevict-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));

    // ── Basic cap enforcement, cycling a single session through many roots ──
    // Fake, non-existent paths are fine — _projectCaches is a pure in-memory
    // Map keyed by the root string, never touches disk.
    for (let i = 0; i < 25; i++) {
      provider.projectRoot = `/fake/evict-proj-${i}`;
      void provider._proj; // touch the getter — this is what creates/caches the entry
    }
    check('project cache: never grows past the cap even after visiting 25 distinct roots',
      provider._projectCaches.size <= 20);
    check('project cache: the most-recently-touched root survived', provider._projectCaches.has('/fake/evict-proj-24'));
    check('project cache: the very first (oldest, long since abandoned) root was evicted',
      !provider._projectCaches.has('/fake/evict-proj-0'));

    // ── An OPEN root must never be evicted, no matter how stale ─────────────
    provider = new NavyCoderViewProvider(makeContext(tmp)); // fresh instance, clean cache
    const keepRoot = '/fake/keep-me-open';
    provider.projectRoot = keepRoot;
    void provider._proj; // touched once, then never again — would be the OLDEST by lastTouched
    await provider.openNewSessionTab(); // a SECOND tab — keepRoot's session (the first tab) stays alive and open

    for (let i = 0; i < 25; i++) {
      provider.projectRoot = `/fake/churn-proj-${i}`; // the second tab churns through many other roots
      void provider._proj;
    }
    check('project cache: a root with a currently-open tab survives eviction pressure even though it\'s the oldest',
      provider._projectCaches.has(keepRoot));
    check('project cache: still enforces the cap overall (only counting the CLOSED/churned roots)',
      provider._projectCaches.size <= 20);
    check('project cache: recent churned roots survive, old ones don\'t',
      provider._projectCaches.has('/fake/churn-proj-24') && !provider._projectCaches.has('/fake/churn-proj-0'));

    // ── An evicted root's pending debounced embeddings-save timer is cleared ─
    // (not flushed — same tradeoff dispose() already makes on full shutdown),
    // so it can't fire against a cache entry that no longer exists.
    provider = new NavyCoderViewProvider(makeContext(tmp));
    let timerFired = false;
    provider.projectRoot = '/fake/evict-with-timer';
    void provider._proj;
    provider._embedSaveTimer = setTimeout(() => { timerFired = true; }, 30);
    for (let i = 0; i < 25; i++) {
      provider.projectRoot = `/fake/timerchurn-proj-${i}`;
      void provider._proj;
    }
    check('project cache: the evicted root really was evicted (setup sanity check)',
      !provider._projectCaches.has('/fake/evict-with-timer'));
    await new Promise(r => setTimeout(r, 80));
    check('project cache: an evicted root\'s pending embed-save timer is cleared, never fires', !timerFired);
  } catch (e) {
    check('project cache eviction suite ran', false, e.stack || e.message);
  } finally {
    if (provider) {
      for (const session of provider.sessions.values()) {
        clearTimeout(session._cpSaveTimer);
        clearInterval(session._heartbeat);
        clearTimeout(session._watchdog);
      }
      for (const p of provider._projectCaches.values()) clearTimeout(p.embedSaveTimer);
    }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── Session cache eviction (this.sessions must not grow unbounded) ─────────
// Mirrors projectCacheEvictionSuite for the sibling growth path Angle H's
// review found: this.sessions accumulates every chat ever loaded from disk
// or created in this window, forever, unless capped. Far more conservative
// than the project cache though — a session holds real, possibly-unsaved
// chat content, so the eligibility rules matter as much as the cap itself.
async function sessionCacheEvictionSuite() {
  console.log('\nsession cache eviction (this.sessions cap):');
  const os = require('os');
  sharedMock();

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-sessevict-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    const activeId = provider.activeSessionId; // the constructor's own bootstrap session

    // Fake sessions are plain objects — _evictStaleSessions only ever reads
    // .projectRoot/.isBusy/._updated and deletes by id, so a real Session
    // instance isn't needed to exercise it directly and fast (no disk I/O).
    const fakeSession = (root, updated, extra = {}) => ({
      projectRoot: root, isBusy: false, messages: [{ role: 'user', text: 'x' }],
      _updated: updated, checkpoints: [], ...extra,
    });

    // ── Basic cap enforcement: 45 distinct, fully-saved, non-active, ────────
    // non-last-of-their-project sessions (each its own project, 2 chats per
    // project so "last remaining chat" never blocks eviction here).
    provider.sessions.clear();
    provider.sessions.set(activeId, fakeSession('/fake/sess-active', ''));
    provider.activeSessionId = activeId;
    for (let i = 0; i < 45; i++) {
      const root = '/fake/sess-proj-' + i;
      const t = new Date(2020, 0, 1, 0, 0, i).toISOString(); // strictly increasing — i=0 oldest
      provider.sessions.set('sib-a-' + i, fakeSession(root, t));
      provider.sessions.set('sib-b-' + i, fakeSession(root, t)); // sibling — neither is "the last chat"
    }
    provider._evictStaleSessions();
    check('session cache: never grows past the cap (40) even with 91 total sessions',
      provider.sessions.size <= 40);
    check('session cache: the active session always survives', provider.sessions.has(activeId));
    check('session cache: the most-recently-saved sessions survive', provider.sessions.has('sib-a-44') && provider.sessions.has('sib-b-44'));
    check('session cache: the oldest-saved sessions were evicted', !provider.sessions.has('sib-a-0') && !provider.sessions.has('sib-b-0'));
    check('session cache: evicting un-marks the project so it can be re-read from disk later',
      !provider._loadedChatRoots.has('/fake/sess-proj-0'));

    // ── A project's LAST remaining chat is never evicted, no matter how old ─
    provider.sessions.clear();
    provider.activeSessionId = activeId;
    provider.sessions.set(activeId, fakeSession('/fake/keep-active', ''));
    provider.sessions.set('lonely-old', fakeSession('/fake/lonely-project', new Date(2000, 0, 1).toISOString()));
    for (let i = 0; i < 45; i++) {
      provider.sessions.set('churn-' + i, fakeSession('/fake/churn-proj-' + i, new Date(2021, 0, 1, 0, 0, i).toISOString()));
    }
    provider._evictStaleSessions();
    check('session cache: a project\'s only remaining chat survives even though it\'s the oldest',
      provider.sessions.has('lonely-old'));

    // ── A busy session is never evicted ─────────────────────────────────────
    provider.sessions.clear();
    provider.activeSessionId = activeId;
    provider.sessions.set(activeId, fakeSession('/fake/keep-active2', ''));
    provider.sessions.set('busy-old', fakeSession('/fake/busy-project', new Date(2000, 0, 1).toISOString(), { isBusy: true }));
    provider.sessions.set('busy-old-sibling', fakeSession('/fake/busy-project', new Date(2000, 0, 2).toISOString()));
    for (let i = 0; i < 45; i++) {
      provider.sessions.set('churn2-' + i, fakeSession('/fake/churn2-proj-' + i, new Date(2021, 0, 1, 0, 0, i).toISOString()));
    }
    provider._evictStaleSessions();
    check('session cache: a busy session is never evicted', provider.sessions.has('busy-old'));

    // ── A session with nothing saved to disk yet is never evicted ──────────
    // (empty _updated — evicting it would lose content with nowhere to
    // reload it from).
    provider.sessions.clear();
    provider.activeSessionId = activeId;
    provider.sessions.set(activeId, fakeSession('/fake/keep-active3', ''));
    provider.sessions.set('unsaved-old', fakeSession('/fake/unsaved-project', ''));
    provider.sessions.set('unsaved-old-sibling', fakeSession('/fake/unsaved-project', new Date(2000, 0, 1).toISOString()));
    for (let i = 0; i < 45; i++) {
      provider.sessions.set('churn3-' + i, fakeSession('/fake/churn3-proj-' + i, new Date(2021, 0, 1, 0, 0, i).toISOString()));
    }
    provider._evictStaleSessions();
    check('session cache: a never-saved (_updated empty) session is never evicted', provider.sessions.has('unsaved-old'));
  } catch (e) {
    check('session cache eviction suite ran', false, e.stack || e.message);
  } finally {
    if (provider) {
      for (const session of provider.sessions.values()) {
        clearTimeout(session._cpSaveTimer);
        clearInterval(session._heartbeat);
        clearTimeout(session._watchdog);
      }
    }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 6c2. Project rules — layered, not "first file wins" ──────────────────────
// A project commonly has a tool-agnostic AGENTS.md for shared team
// conventions AND a small tool-specific file (.cursorrules, .navyrules)
// layering a targeted tweak on top. loadProjectRules used to return only the
// FIRST well-known file it found, so adding either one silently discarded
// ALL of the other.
async function projectRulesSuite() {
  console.log('\nproject rules (layered, not first-file-wins):');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-rules-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const W = (n, c) => fs.writeFileSync(path.join(tmp, n), c);

    check('project rules: no files anywhere returns empty', (await provider.loadProjectRules()) === '');

    W('AGENTS.md', 'Use 2-space indentation.');
    const single = await provider.loadProjectRules();
    check('project rules: a single file is included', single.includes('Use 2-space indentation.'));
    check('project rules: labeled with its source file', single.includes('### From AGENTS.md'));

    fs.mkdirSync(path.join(tmp, '.github'), { recursive: true });
    W('.github/copilot-instructions.md', 'Prefer functional components.');
    W('.cursorrules', '   '); // whitespace-only — must be skipped, not included as empty noise
    W('.navyrules', 'Always run tests before finishing.');
    const merged = await provider.loadProjectRules();
    check('project rules: ALL non-empty files are merged, not just the first',
      merged.includes('Use 2-space indentation.')
      && merged.includes('Prefer functional components.')
      && merged.includes('Always run tests before finishing.'));
    check('project rules: a whitespace-only file contributes nothing',
      !merged.includes('.cursorrules') || merged.split('### From').length === 4); // 3 real sources, not 4
    check('project rules: broadest source (AGENTS.md) appears before the most Navy-specific (.navyrules)',
      merged.indexOf('AGENTS.md') < merged.indexOf('.navyrules'));

    fs.rmSync(path.join(tmp, 'AGENTS.md'));
    fs.rmSync(path.join(tmp, '.github', 'copilot-instructions.md'));
    fs.rmSync(path.join(tmp, '.cursorrules'));
    fs.rmSync(path.join(tmp, '.navyrules'));

    // Only once NONE of the well-known files exist does the Navy-managed
    // .navy/rules.md fallback apply.
    check('project rules: falls back to .navy/rules.md only when no well-known file exists',
      (await provider.loadProjectRules()) === '');
    const navyDir = await provider.ensureNavyDir();
    fs.writeFileSync(path.join(navyDir, 'rules.md'), 'Fallback convention.');
    check('project rules: .navy/rules.md fallback is read once it exists',
      (await provider.loadProjectRules()) === 'Fallback convention.');

    W('AGENTS.md', 'Real convention.');
    check('project rules: a real well-known file takes priority over the .navy/rules.md fallback',
      (await provider.loadProjectRules()).includes('Real convention.')
      && !(await provider.loadProjectRules()).includes('Fallback convention.'));
  } catch (e) {
    check('project rules suite ran', false, e.stack || e.message);
  } finally {
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 8b. Opening / switching project folders ─────────────────────────────────
// Regression: openFolder passed a bare Uri to updateWorkspaceFolders, which
// takes { uri } objects — VS Code rejected the call and returned false, so the
// folder was never added, yet Navy set projectRoot and reported success anyway.
async function projectFolderSuite() {
  console.log('\nproject folder open/switch:');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();
  let provider, dirA, dirB;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-projA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-projB-'));
    provider = new NavyCoderViewProvider(makeContext(dirA));
    provider.view = { webview: { postMessage: () => {} } };

    const uriOf = (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => p });

    // The mock enforces the real API contract, so this proves the shape matters:
    // a bare Uri (the original bug) is rejected; a { uri } object is accepted.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    check('updateWorkspaceFolders rejects a bare Uri (the original bug shape)',
      vscode.workspace.updateWorkspaceFolders(1, 0, uriOf(dirB)) === false);
    check('updateWorkspaceFolders accepts a { uri } object',
      vscode.workspace.updateWorkspaceFolders(1, 0, { uri: uriOf(dirB) }) === true);
    check('accepted add actually landed in workspaceFolders',
      (vscode.workspace.workspaceFolders || []).some(f => f.uri.fsPath === dirB));

    // "Add to List" — folder really gets added to the workspace, but Navy
    // deliberately does NOT switch to it: adding a project to the list and
    // selecting it are two separate steps (see openFolder's comment) — the
    // user picks it from the dropdown afterward.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    provider.isBusy = false;
    ctrl.nextOpenDialog = [dirB];
    ctrl.nextInfo = 'Add to List';
    await provider.openFolder();
    check('add-to-list: folder added to the workspace for real',
      (vscode.workspace.workspaceFolders || []).some(f => f.uri.fsPath === dirB));
    check('add-to-list: does NOT switch Navy\'s active project', provider.projectRoot === dirA);
    check('add-to-list: original project still open alongside',
      (vscode.workspace.workspaceFolders || []).some(f => f.uri.fsPath === dirA));

    // "Open Here" — replaces the window via vscode.openFolder, and must NOT
    // quietly add a second root instead (that was the reported symptom).
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextOpenDialog = [dirB];
    ctrl.nextInfo = 'Open Here';
    await provider.openFolder();
    const opened = ctrl.executedCommands.find(c => c.command === 'vscode.openFolder');
    check('open-here: issues vscode.openFolder to replace the window', Boolean(opened));
    check('open-here: opens the picked folder', opened && opened.args[0]?.fsPath === dirB);
    check('open-here: does not add a second root instead of switching',
      (vscode.workspace.workspaceFolders || []).length === 1);

    // Dismissing the modal must change nothing at all.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextOpenDialog = [dirB];
    ctrl.nextInfo = undefined; // dismissed
    await provider.openFolder();
    check('dismissed: project root unchanged', provider.projectRoot === dirA);
    check('dismissed: workspace untouched', (vscode.workspace.workspaceFolders || []).length === 1);
    check('dismissed: no folder opened', !ctrl.executedCommands.some(c => c.command === 'vscode.openFolder'));

    // A failed add must NOT move projectRoot to a folder that isn't open.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextOpenDialog = [dirB];
    ctrl.nextInfo = 'Add to List';
    const realUpdate = vscode.workspace.updateWorkspaceFolders;
    vscode.workspace.updateWorkspaceFolders = () => false; // simulate VS Code refusing
    await provider.openFolder();
    vscode.workspace.updateWorkspaceFolders = realUpdate;
    check('failed add: projectRoot NOT moved to a folder that never opened', provider.projectRoot === dirA);
    check('failed add: user is told it failed', ctrl.shown.error.some(m => /could not add/i.test(m)));

    // Mid-turn switching is refused — tools resolve paths against projectRoot live.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    provider.isBusy = true;
    ctrl.nextOpenDialog = [dirB];
    ctrl.nextInfo = 'Open Here';
    await provider.openFolder();
    provider.isBusy = false;
    check('busy: refuses to switch project mid-turn', provider.projectRoot === dirA);
    check('busy: warns the user why', ctrl.shown.warning.some(m => /stop the current task/i.test(m)));
    check('busy: never even opened the folder picker',
      !ctrl.executedCommands.some(c => c.command === 'vscode.openFolder'));

    // Picking a folder already in the workspace via the dialog does nothing
    // but tell the user it's already there — it's already selectable from
    // the dropdown, and the dialog never switches regardless.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }, { uri: uriOf(dirB) }];
    provider.projectRoot = dirA;
    ctrl.nextOpenDialog = [dirB];
    await provider.openFolder();
    check('existing folder: does not switch without prompting', provider.projectRoot === dirA);
    check('existing folder: tells the user it\'s already in the list',
      ctrl.shown.info.some(m => /already in your project list/i.test(m)));
    check('existing folder: no duplicate root added',
      (vscode.workspace.workspaceFolders || []).length === 2);

    // ── The chat must auto-link to the project that's actually open ──────────
    // Pure containment predicate behind the guard — depends on the shared
    // fold/foldPath helpers, which are now a real module (src/paths.js) and so
    // are imported rather than extracted out of the source.
    const { fold, foldPath } = require('../src/paths.js');
    const belongs = new Function('path', 'process', 'fold', 'foldPath',
      extractFunction(extSrc, 'function rootBelongsToWorkspace') +
      '\nreturn rootBelongsToWorkspace;'
    )(path, process, fold, foldPath);
    check('root-belongs: a workspace folder itself belongs', belongs(dirA, [dirA]));
    check('root-belongs: a sub-directory of a workspace folder belongs',
      belongs(path.join(dirA, 'src'), [dirA]));
    check('root-belongs: another project does NOT belong', !belongs(dirB, [dirA]));
    check('root-belongs: with no workspace open, anything is allowed', belongs(dirB, []));
    check('root-belongs: empty root never belongs', !belongs('', [dirA]));

    // "Open Here" must not stamp the new project's path into the OLD project's
    // workspace settings — that stale pointer is what made a later reopen of the
    // old project land on the wrong root until fixed by hand.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextOpenDialog = [dirB];
    ctrl.nextInfo = 'Open Here';
    await provider.openFolder();
    check('open-here: does not poison the old workspace settings with the new path',
      ctrl.scoped.projectRoot?.workspaceValue !== dirB);

    // A saved root pointing at a project that is NOT open must be ignored, so a
    // freshly opened folder links up on its own instead of needing a manual fix.
    ctrl.reset();
    ctrl.scoped.projectRoot = { workspaceValue: dirB }; // stale pointer to another project
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    const fresh = new NavyCoderViewProvider(makeContext(dirA));
    check('stale saved root from another project is ignored', fresh.projectRoot !== dirB);
    fresh.view = { webview: { postMessage: () => {} } };
    await fresh.sendWorkspaceFolders();
    check('freshly opened project auto-links to the open folder', fresh.projectRoot === dirA);
    clearTimeout(fresh._cpSaveTimer); clearInterval(fresh._heartbeat);

    // A legitimate saved root (inside the open folder) is still honoured.
    ctrl.reset();
    const sub = path.join(dirA, 'packages', 'api');
    fs.mkdirSync(sub, { recursive: true });
    ctrl.config.projectRoot = sub; // pre-0.2.7 setting / explicit override — read via get()
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    const kept = new NavyCoderViewProvider(makeContext(dirA));
    check('a saved sub-folder root inside the open project is still honoured', kept.projectRoot === sub);
    clearTimeout(kept._cpSaveTimer); clearInterval(kept._heartbeat);
    // ctrl.reset() does not clear ctrl.config, so an override left here would be
    // read as a pinned project by every suite that follows.
    delete ctrl.config.projectRoot;
  } catch (e) {
    check('project folder suite ran', false, e.stack || e.message);
  } finally {
    delete ctrl.config.projectRoot;
    vscode.workspace.workspaceFolders = undefined;
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); }
    for (const d of [dirA, dirB]) { try { if (d) fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}

// ── Global project catalog (~/.navy/projects.json) ──────────────────────────
// A small, user-inspectable catalog of every project root Navy has ever been
// pointed at, independent of any one window's workspace — so a project used
// in a window that's since closed can still be resumed from the dropdown.
// _globalProjectsDirOverride redirects it to an isolated temp dir so these
// tests never touch the real user's home directory.
async function globalProjectCatalogSuite() {
  console.log('\nglobal project catalog (~/.navy/projects.json):');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();
  const uriOf = (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => p });

  let provider, homeDir, dirA, dirB, dirC;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-home-'));
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-catA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-catB-'));
    dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-catC-'));
    provider = new NavyCoderViewProvider(makeContext(dirA));
    provider._globalProjectsDirOverride = path.join(homeDir, '.navy');
    provider.view = { webview: { postMessage: () => {} } };

    // ── Persistence round-trip ──────────────────────────────────────────────
    await provider._recordProjectUsage(dirA);
    check('catalog file actually written to disk under the overridden home dir',
      fs.existsSync(path.join(homeDir, '.navy', 'projects.json')));
    let list = await provider._readGlobalProjects();
    check('a recorded project is read back with the right path and name',
      list.length === 1 && list[0].path === dirA && list[0].name === path.basename(dirA));
    check('a recorded project gets a real lastOpened timestamp', typeof list[0].lastOpened === 'number' && list[0].lastOpened > 0);

    // ── Dedup: recording the same path again updates it, not duplicates it ──
    await provider._recordProjectUsage(dirA);
    list = await provider._readGlobalProjects();
    check('recording the same project again does not duplicate it', list.length === 1);

    // ── Multiple projects, sorted most-recently-used first ─────────────────
    await provider._recordProjectUsage(dirB);
    list = await provider._readGlobalProjects();
    check('a second distinct project is added', list.length === 2);
    check('sorted most-recently-used first', list[0].path === dirB && list[1].path === dirA);

    // ── _withGlobalProjectsLock genuinely serializes concurrent callers ─────
    // (the actual fix for the lost-update race a within-one-window concurrent
    // write used to hit) — proven deterministically via ordering markers
    // rather than relying on real fs timing to trigger a race or not.
    {
      const order = [];
      const p1 = provider._withGlobalProjectsLock(async () => {
        order.push('1-start');
        await new Promise(r => setTimeout(r, 30));
        order.push('1-end');
      });
      const p2 = provider._withGlobalProjectsLock(async () => {
        order.push('2-start');
        order.push('2-end');
      });
      await Promise.all([p1, p2]);
      check('_withGlobalProjectsLock: a second caller never starts before the first finishes',
        order.join(',') === '1-start,1-end,2-start,2-end');
    }

    // ── _recordProjectUsage: concurrent calls for DIFFERENT projects (same
    // window) must not lose either update — the actual bug found in review.
    // Deterministic BECAUSE of the lock above: with real serialization, the
    // second call's read always happens after the first call's write, so
    // both entries surviving isn't a matter of lucky timing.
    {
      await provider._writeGlobalProjects([]);
      const dirX = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-catX-'));
      const dirY = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-catY-'));
      await Promise.all([provider._recordProjectUsage(dirX), provider._recordProjectUsage(dirY)]);
      const concurrent = await provider._readGlobalProjects();
      check('_recordProjectUsage: two concurrent calls for different projects both survive',
        concurrent.some(p => p.path === dirX) && concurrent.some(p => p.path === dirY));
      try { fs.rmSync(dirX, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(dirY, { recursive: true, force: true }); } catch {}
    }

    // ── _rmwJsonFile: detects a change from ANOTHER writer (simulating a
    // different VS Code window's own process, which no in-memory lock can
    // see) between its read and its write, and retries against the fresh
    // data instead of blindly overwriting it.
    {
      const rmwPath = path.join(homeDir, 'rmw-test.json');
      await provider._writeJsonFile(rmwPath, ['initial'], 'test');
      let readCount = 0;
      const origRead = provider._readJsonFile.bind(provider);
      provider._readJsonFile = async (fp, fallback) => {
        if (fp === rmwPath) {
          readCount++;
          // Before the RECHECK read (the 2nd call) actually reads the file,
          // simulate an external writer — e.g. another window — landing in
          // between, bypassing this provider's own tracked state entirely.
          if (readCount === 2) fs.writeFileSync(rmwPath, JSON.stringify(['external-writer-was-here']));
        }
        return origRead(fp, fallback);
      };
      const rmwResult = await provider._rmwJsonFile(rmwPath, [], (l) => [...l, 'mine']);
      provider._readJsonFile = origRead;
      check('_rmwJsonFile: retries and merges instead of clobbering an externally-written change',
        rmwResult.includes('external-writer-was-here') && rmwResult.includes('mine'));
    }

    // ── Stale entries (folder no longer exists) are dropped on read ────────
    const goneDir = path.join(homeDir, 'this-folder-was-deleted');
    await provider._writeGlobalProjects([
      { path: dirA, name: 'a', lastOpened: 5 },
      { path: goneDir, name: 'gone', lastOpened: 10 },
    ]);
    list = await provider._readGlobalProjects();
    check('an entry whose folder no longer exists is excluded on read', list.length === 1 && list[0].path === dirA);

    // ── Cap: never grows past 100, keeping the most recently used ──────────
    {
      const capBase = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-catcap-'));
      const seeded = [];
      for (let i = 0; i < 105; i++) {
        const p = path.join(capBase, 'p' + i);
        fs.mkdirSync(p);
        seeded.push({ path: p, name: 'p' + i, lastOpened: i }); // p0 oldest, p104 newest of the batch
      }
      await provider._writeGlobalProjects(seeded);
      const freshOne = path.join(capBase, 'fresh');
      fs.mkdirSync(freshOne);
      await provider._recordProjectUsage(freshOne); // Date.now() — newer than every seeded entry
      const capped = await provider._readGlobalProjects();
      check('catalog never exceeds 100 entries', capped.length === 100);
      check('the just-recorded project survives the cap', capped.some(p => p.path === freshOne));
      check('the 6 oldest seeded entries were dropped to make room (105 + 1 - 100 = 6)',
        !capped.some(p => p.path === path.join(capBase, 'p0')) && !capped.some(p => p.path === path.join(capBase, 'p5')));
      check('the newest seeded entries survive', capped.some(p => p.path === path.join(capBase, 'p104')));
      try { fs.rmSync(capBase, { recursive: true, force: true }); } catch {}
    }

    // Reset to a clean, known catalog for the rest of this suite.
    await provider._writeGlobalProjects([]);

    // ── sendWorkspaceFolders: catalog excludes whatever's already shown ────
    await provider._recordProjectUsage(dirB); // known globally, not open in this window
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    await provider.sendWorkspaceFolders();
    const wf = posted.find(m => m.type === 'workspaceFolders');
    check('sendWorkspaceFolders: catalog includes a globally-known project not open in this window',
      wf?.catalog?.some(p => p.path === dirB));
    check('sendWorkspaceFolders: catalog excludes the project already shown as an open root',
      !wf?.catalog?.some(p => p.path === dirA));

    // ── openFolder now catalogs whatever's picked, regardless of the choice ─
    ctrl.reset();
    await provider._writeGlobalProjects([]);
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextOpenDialog = [dirC];
    ctrl.nextInfo = 'Open Here';
    await provider.openFolder();
    // _recordProjectUsage is deliberately fire-and-forget from openFolder (folder
    // picking must never block on catalog bookkeeping) — give it a moment to land.
    await new Promise(r => setTimeout(r, 50));
    list = await provider._readGlobalProjects();
    check('openFolder: the picked folder is catalogued globally', list.some(p => p.path === dirC));

    // ── The dialog itself now offers "Add to Workspace", not "Add to List" ──
    const dialogCall = ctrl.shownInfoCalls.find(c => Array.isArray(c.items) && c.items.includes('Open Here'));
    check('openFolder: the dialog offers "Add to Workspace"', Boolean(dialogCall && dialogCall.items.includes('Add to Workspace')));
    check('openFolder: the dialog no longer offers the old "Add to List" label', !(dialogCall && dialogCall.items.includes('Add to List')));

    // ── openCatalogProject: already part of THIS window's workspace → direct switch, no dialog ──
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }, { uri: uriOf(dirB) }];
    provider.projectRoot = dirA;
    await provider.openCatalogProject(dirB);
    check('openCatalogProject: an already-open root switches directly', provider.projectRoot === dirB);
    check('openCatalogProject: no dialog shown for an already-open root', ctrl.shown.info.length === 0);

    // ── openCatalogProject: not open here, workspace non-empty, "Open Here" ─
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextInfo = 'Open Here';
    await provider.openCatalogProject(dirC);
    const openedCmd = ctrl.executedCommands.find(c => c.command === 'vscode.openFolder');
    check('openCatalogProject (Open Here): issues vscode.openFolder for the picked project', openedCmd?.args[0]?.fsPath === dirC);
    check('openCatalogProject (Open Here): projectRoot updated to the picked project', provider.projectRoot === dirC);

    // ── openCatalogProject: not open here, workspace non-empty, "Add to Workspace" ─
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextInfo = 'Add to Workspace';
    await provider.openCatalogProject(dirC);
    check('openCatalogProject (Add to Workspace): the folder is really added to the workspace',
      (vscode.workspace.workspaceFolders || []).some(f => f.uri.fsPath === dirC));
    check('openCatalogProject (Add to Workspace): does NOT switch — projectRoot unchanged', provider.projectRoot === dirA);

    // ── openCatalogProject: dismissed dialog changes nothing ───────────────
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextInfo = undefined;
    await provider.openCatalogProject(dirC);
    check('openCatalogProject (dismissed): projectRoot unchanged', provider.projectRoot === dirA);
    check('openCatalogProject (dismissed): workspace unchanged', (vscode.workspace.workspaceFolders || []).length === 1);

    // ── openCatalogProject: no workspace open at all → behaves like a fresh open ─
    ctrl.reset();
    vscode.workspace.workspaceFolders = undefined;
    provider.projectRoot = '';
    await provider.openCatalogProject(dirC);
    const openedNoWs = ctrl.executedCommands.find(c => c.command === 'vscode.openFolder');
    check('openCatalogProject (no workspace open): opens the folder directly, no dialog needed', Boolean(openedNoWs));
    check('openCatalogProject (no workspace open): never showed a choice dialog', ctrl.shown.info.length === 0);

    // ── openCatalogProject: a path that no longer exists ────────────────────
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    const missingPath = path.join(homeDir, 'never-existed-xyz');
    await provider.openCatalogProject(missingPath);
    check('openCatalogProject (missing path): reports the error, does not crash', ctrl.shown.error.some(m => /no longer exists/i.test(m)));
    check('openCatalogProject (missing path): projectRoot left unchanged', provider.projectRoot === dirA);

    // ── openCatalogProject: refuses mid-turn, same as every other project switch ─
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    provider.isBusy = true;
    await provider.openCatalogProject(dirC);
    provider.isBusy = false;
    check('openCatalogProject: refuses to switch mid-turn', provider.projectRoot === dirA);
    check('openCatalogProject: warns why', ctrl.shown.warning.some(m => /stop the current task/i.test(m)));

    // ── _activateProjectRoot also keeps the catalog fresh (covers restore/startup, not just explicit picks) ─
    await provider._writeGlobalProjects([]);
    await provider._activateProjectRoot(dirA);
    await new Promise(r => setTimeout(r, 50)); // same fire-and-forget settle as above
    list = await provider._readGlobalProjects();
    check('_activateProjectRoot records the project too (covers startup restore, not just dropdown picks)',
      list.some(p => p.path === dirA));
  } catch (e) {
    check('global project catalog suite ran', false, e.stack || e.message);
  } finally {
    vscode.workspace.workspaceFolders = undefined;
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); }
    for (const d of [homeDir, dirA, dirB, dirC]) { try { if (d) fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}

// ── 8b15. Cache invalidation on real file changes ───────────────────────────
// The repo-map/relevance/gitignore caches expired purely on time, so for up to
// 30–60s Navy could answer from a snapshot of a file that had since changed —
// including files it had just edited itself.
async function fileWatcherSuite() {
  console.log('\nfile watcher cache invalidation:');
  const os = require('os');
  const { ctrl } = sharedMock();
  const { NavyCoderViewProvider } = require('../src/extension.js');
  const provider = new NavyCoderViewProvider(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'navy-fw-'))));

  ctrl.watchers.length = 0;
  const watcher = provider._startFileWatcher();
  check('watcher: one watcher is created for the whole window', ctrl.watchers.length === 1);
  check('watcher: …covering everything, so multi-root workspaces need no extra ones',
    watcher.pattern === '**/*', String(watcher.pattern));
  check('watcher: create/change/delete are all wired',
    Boolean(watcher._create && watcher._change && watcher._delete));
  check('watcher: starting twice does not stack watchers',
    (provider._startFileWatcher(), ctrl.watchers.length === 1));

  const root = path.join(os.tmpdir(), 'proj-a');
  const other = path.join(os.tmpdir(), 'proj-b');
  const seed = (r) => {
    const c = provider._projCacheFor(r);
    c.repoMapCache = { root: r, time: Date.now(), map: 'x' };
    c.relCache = { key: 'k', time: Date.now(), hits: [] };
    c.gitIgnoredCache = { root: r, time: Date.now(), set: new Set() };
    return c;
  };

  // A source edit invalidates what content changed, and nothing else.
  let a = seed(root), b = seed(other);
  watcher.fire('change', path.join(root, 'src', 'app.js'));
  check('watcher: an edited file drops the repo map', a.repoMapCache === null);
  check('watcher: …and the relevance cache', a.relCache === null);
  check('watcher: …but NOT the gitignore set, which an edit cannot change',
    a.gitIgnoredCache !== null);
  check('watcher: a sibling project on another root is untouched',
    b.repoMapCache !== null && b.relCache !== null);

  // Appearing/disappearing files CAN change ignore status; edits cannot.
  a = seed(root);
  watcher.fire('create', path.join(root, 'src', 'new.js'));
  check('watcher: a new file does drop the gitignore set', a.gitIgnoredCache === null);
  a = seed(root);
  watcher.fire('delete', path.join(root, 'src', 'gone.js'));
  check('watcher: …as does a deleted one', a.gitIgnoredCache === null);
  a = seed(root);
  watcher.fire('change', path.join(root, '.gitignore'));
  check('watcher: …as does editing .gitignore itself', a.gitIgnoredCache === null);

  // The failure that would make the watcher worse than no watcher: Navy writes
  // into .navy/ constantly, so reacting to its own writes would hold every
  // cache permanently empty.
  a = seed(root);
  watcher.fire('change', path.join(root, '.navy', 'chats', 'abc.json'));
  check('watcher: Navy\'s own .navy/ writes are ignored', a.repoMapCache !== null);
  watcher.fire('change', path.join(root, 'node_modules', 'left-pad', 'index.js'));
  check('watcher: node_modules churn is ignored', a.repoMapCache !== null);
  watcher.fire('change', path.join(root, '.git', 'index'));
  check('watcher: git internals are ignored', a.repoMapCache !== null);
  watcher.fire('change', path.join(root, 'dist', 'bundle.js'));
  check('watcher: build output is ignored', a.repoMapCache !== null);
  // …but a real file whose NAME merely resembles one of those must still count.
  watcher.fire('change', path.join(root, 'src', 'node_modules_helper.js'));
  check('watcher: a path that only looks like a skipped dir still invalidates',
    a.repoMapCache === null);

  check('watcher: a malformed event is survived', (provider._invalidatePathCaches(''), true));
  provider.dispose();
  check('watcher: disposing the provider disposes the watcher', watcher.disposed === true);
}

module.exports = { multiRootSuite, sessionIsolationSuite, sessionTaggingSuite, projectCacheEvictionSuite, sessionCacheEvictionSuite, projectRulesSuite, projectFolderSuite, globalProjectCatalogSuite, fileWatcherSuite };
