const { fs, path, check, makeContext, sharedMock } = require('./harness.js');

// Removing projects from the picker's "Other projects" list: the list changes,
// nothing else does, and a removal can't undo a concurrent recording (or be
// undone by one).
async function forgetProjectsSuite() {
  console.log('\nremoving projects from the list:');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();
  const savedFolders = vscode.workspace.workspaceFolders;
  let provider, home;
  const dirs = [];
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-forget-home-'));
    for (const n of ['a', 'b', 'c', 'd']) dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), 'navy-forget-' + n + '-')));
    const [A, B, C, D] = dirs;
    provider = new NavyCoderViewProvider(makeContext(A));
    provider._globalProjectsDirOverride = path.join(home, '.navy');
    const posted = [];
    provider.view = { webview: { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } } };
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: A, scheme: 'file' }, name: 'a' }];
    provider.projectRoot = A;
    for (const d of [A, B, C, D]) await provider._recordProjectUsage(d);
    const listed = async () => (await provider._readGlobalProjects()).map(p => p.path);

    ctrl.nextQuickPick = (items) => items.filter(i => i.path === B || i.path === C);
    await provider.forgetProjectsFromList();
    const call = ctrl.quickPickCalls[0];
    check('picker: offers what "Other projects" shows - never the project open in this window',
      Boolean(call) && JSON.stringify(call.items.map(i => i.path)) === JSON.stringify([D, C, B]), JSON.stringify(call && call.items.map(i => i.path)));
    check('picker: several can be removed at once', call && call.options && call.options.canPickMany === true);
    check('remove: the chosen projects leave the list, the rest stay',
      JSON.stringify(await listed()) === JSON.stringify([D, A]), JSON.stringify(await listed()));
    check('remove: only the list changes - the folders are still there', fs.existsSync(B) && fs.existsSync(C));
    const redrawn = posted.filter(m => m.type === 'workspaceFolders').pop();
    check('remove: the dropdown is redrawn without them', Boolean(redrawn) && JSON.stringify(redrawn.catalog.map(p => p.path)) === JSON.stringify([D]));
    check('remove: and says what happened', ctrl.shown.info.some(m => /removed 2 projects from the list/.test(m)), JSON.stringify(ctrl.shown.info));

    ctrl.nextQuickPick = undefined;
    await provider.forgetProjectsFromList();
    check('cancel: dismissing the picker changes nothing', JSON.stringify(await listed()) === JSON.stringify([D, A]));

    await provider._recordProjectUsage(B);
    check('reopen: a removed project opened again comes back', (await listed()).includes(B));

    const removed = await provider._forgetProjects([process.platform === 'win32' ? B.toUpperCase() : B]);
    check('paths: matched the way every other path is - regardless of case on Windows', removed === 1 && !(await listed()).includes(B));

    await Promise.all([provider._recordProjectUsage(C), provider._forgetProjects([D])]);
    const both = await listed();
    check('concurrency: a removal and a recording at the same moment both land', both.includes(C) && !both.includes(D), JSON.stringify(both));

    await provider._forgetProjects([C]);
    ctrl.quickPickCalls = [];
    await provider.forgetProjectsFromList();
    check('empty: with nothing else on the list it says so instead of opening an empty picker',
      ctrl.quickPickCalls.length === 0 && ctrl.shown.info.some(m => /no other projects on the list/.test(m)));
  } finally {
    vscode.workspace.workspaceFolders = savedFolders;
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    for (const d of [home, ...dirs]) { try { if (d) fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}

module.exports = { forgetProjectsSuite };
