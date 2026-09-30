const {
  fs, path, check, makeContext, sharedMock,
} = require('./harness.js');
const {
  formatProblems, describe, sourceTag, MAX_PER_FILE, COVERAGE_NOTE,
} = require('../src/problems.js');

// Reading VS Code's Problems panel. get_diagnostics read one file; the panel is
// the whole workspace, and it is where a person looks first for what is broken.
// It also only covers what the language extensions have analysed, which is why
// every answer says so, and points at the project's own checker.
async function problemsSuite() {
  console.log('\nthe Problems panel:');
  const os = require('os');
  const root = path.join(os.tmpdir(), 'navy-problems-root');
  const uri = (rel) => ({ scheme: 'file', fsPath: path.join(root, ...rel.split('/')) });
  const diag = (severity, line, message, extra = {}) => ({ severity, message, range: { start: { line, character: 4 } }, ...extra });

  // ── One problem, one line ──────────────────────────────────────────────────
  check('a problem reads as severity, position, message and where it came from',
    describe(diag(0, 11, "Cannot find name 'foo'.", { source: 'ts', code: 2304 })) === "[Error] 12:5 Cannot find name 'foo'. (ts 2304)");
  check('a rule code that links to its docs is read by value',
    sourceTag({ source: 'eslint', code: { value: 'no-unused-vars', target: {} } }) === ' (eslint no-unused-vars)');
  check('a multi-line message keeps the line that says what is wrong',
    describe(diag(1, 0, "Type 'string' is not assignable to type 'number'.\n  Details that go on for a while")) === "[Warning] 1:5 Type 'string' is not assignable to type 'number'.");

  // ── The whole panel ────────────────────────────────────────────────────────
  const panel = [
    [uri('src/ok.ts'), [diag(1, 3, 'unused variable', { source: 'eslint' })]],
    [uri('src/bad.ts'), [diag(1, 9, 'prefer const'), diag(0, 20, 'second error'), diag(0, 2, 'first error')]],
    [uri('src/hints.ts'), [diag(3, 1, 'could be simplified')]],
    [{ scheme: 'file', fsPath: path.join(os.tmpdir(), 'elsewhere', 'settings.json') }, [diag(0, 0, 'not in this project')]],
    [{ scheme: 'git', fsPath: path.join(root, 'src', 'bad.ts') }, [diag(0, 0, 'a git view of the file')]],
  ];
  const out = formatProblems(panel, { root });
  check('the whole panel is summed up first',
    out.startsWith('Problems panel: 2 errors, 2 warnings in 2 files.'), out.split('\n')[0]);
  check('...grouped by file, with the worst file first',
    out.indexOf('src/bad.ts — 2 errors, 1 warning') < out.indexOf('src/ok.ts — 1 warning'), out);
  check('...and within a file, errors before warnings, in line order',
    out.indexOf('3:5 first error') < out.indexOf('21:5 second error') && out.indexOf('21:5 second error') < out.indexOf('10:5 prefer const'), out);
  check('paths are relative to the project, as a person would say them', /\nsrc\/bad\.ts — /.test(out) && !out.includes(root));
  check('files outside the project are counted and left out, not mixed in',
    !out.includes('not in this project') && /1 in files outside this project/.test(out), out);
  check('only real files are read - not a git or diff view of one', !out.includes('a git view'));
  check('hints are left out by default, and it says how to see them',
    !out.includes('could be simplified') && /1 of lower severity \(pass severity: "all"/.test(out), out);
  check('every answer says what the panel cannot see', out.includes(COVERAGE_NOTE));

  check('errors only, when that is what was asked',
    !formatProblems(panel, { root, severity: 'error' }).includes('prefer const'));
  check('everything, when that is what was asked',
    formatProblems(panel, { root, severity: 'all' }).includes('could be simplified'));
  const onlyOk = formatProblems(panel, { root, folder: 'src/ok.ts' });
  check('a path narrows it to that folder or file', onlyOk.includes('unused variable') && !onlyOk.includes('first error'), onlyOk);

  const empty = formatProblems([], { root });
  check('an empty panel says so - and that empty is not the same as clean',
    empty.startsWith('The Problems panel has no errors or warnings.') && /not proof the rest is clean/.test(empty), empty);
  check('...pointing at the project\'s own checker, run through run_command so it stays behind approval',
    /run its own checker with run_command/.test(empty) && /npx tsc --noEmit/.test(empty), empty);

  const many = [[uri('src/huge.ts'), Array.from({ length: MAX_PER_FILE + 7 }, (_, i) => diag(0, i, 'e' + i))]];
  const capped = formatProblems(many, { root });
  check('a file with a flood of problems is capped, and says how many more',
    capped.includes(`… 7 more in this file`) && !capped.includes(`e${MAX_PER_FILE + 3}`), capped.slice(-200));

  // ── Through the tool ───────────────────────────────────────────────────────
  const { vscode } = sharedMock();
  const realGet = vscode.languages.getDiagnostics;
  const realEditor = vscode.window.activeTextEditor;
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-problems-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const inProj = (rel) => ({ scheme: 'file', fsPath: path.join(tmp, ...rel.split('/')) });
    const all = [
      [inProj('a.ts'), [diag(0, 0, 'broken in a')]],
      [inProj('b.ts'), [diag(1, 0, 'dubious in b')]],
    ];
    vscode.languages.getDiagnostics = (u) => (u ? (all.find(([x]) => x.fsPath === u.fsPath) || [null, []])[1] : all);

    const ws = await provider.toolGetDiagnostics(undefined, { scope: 'workspace' });
    check('scope "workspace" reads the whole Problems panel',
      /broken in a/.test(ws) && /dubious in b/.test(ws) && /1 error, 1 warning in 2 files/.test(ws), ws);

    vscode.window.activeTextEditor = undefined;
    const none = await provider.toolGetDiagnostics();
    check('with no file open, the whole panel is the answer - not "no active file"',
      /^No file is open, so this is the whole Problems panel\./.test(none) && /broken in a/.test(none), none);

    const one = await provider.toolGetDiagnostics('a.ts');
    check('naming one file still reads just that file, as before',
      /broken in a/.test(one) && !/dubious in b/.test(one) && !/Problems panel:/.test(one), one);

    const scoped = await provider.toolGetDiagnostics('b.ts', { scope: 'workspace' });
    check('with scope "workspace", a path narrows the panel to it', /dubious in b/.test(scoped) && !/broken in a/.test(scoped), scoped);

    const outside = await provider.toolGetDiagnostics(path.join(os.tmpdir(), 'somewhere-else'), { scope: 'workspace' });
    check('a folder outside the project is an error, not silently the whole project',
      /^Error: .* is outside this project/.test(outside) && !/broken in a/.test(outside), outside);
    check('...and so is one that climbs out of it', /^Error:/.test(await provider.toolGetDiagnostics('../elsewhere', { scope: 'workspace' })));

    const errorsOnly = await provider.toolGetDiagnostics(undefined, { scope: 'workspace', severity: 'error' });
    check('severity narrows it to errors', /broken in a/.test(errorsOnly) && !/dubious in b/.test(errorsOnly));

    const { TOOLS } = require('../src/providers/tools.js');
    const schema = TOOLS.find(t => t.name === 'get_diagnostics').parameters.properties;
    check('the tool offers the whole panel and a severity filter to the model', schema.scope && schema.severity && !schema.scan);
  } finally {
    vscode.languages.getDiagnostics = realGet;
    vscode.window.activeTextEditor = realEditor;
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { problemsSuite };
