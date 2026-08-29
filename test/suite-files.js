const {
  fs, path, ROOT, check, extractFunction, extSrc, makeContext, sharedMock,
  queueOllamaFetch,
} = require('./harness.js');

// fs-coupled undo/redo/checkpoint logic is exercised end-to-end.
async function undoRedoSuite() {
  console.log('\nundo/redo (real fs):');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-undo-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    const P = (name) => path.join(tmp, name);
    const read = (name) => { try { return fs.readFileSync(P(name), 'utf8'); } catch { return null; } };
    const write = (name, txt) => fs.writeFileSync(P(name), txt);

    // A) multi-edit turn: undo must reach turn-START, no spurious warning
    write('a.txt', 'v0');
    provider.currentTurnId = 't1';
    ctrl.reset();
    await provider.toolWriteFile('a.txt', 'v1');
    await provider.toolWriteFile('a.txt', 'v2');
    await provider.toolWriteFile('a.txt', 'v3');
    check('multi-edit: disk at final state', read('a.txt') === 'v3');
    await provider.undoLastTurn();
    check('multi-edit: undo reaches turn-start (Bug 1)', read('a.txt') === 'v0');
    check('multi-edit: no spurious modified warning (Bug 5)', ctrl.shown.warning.length === 0);
    await provider.redoLast();
    check('multi-edit: redo restores final state', read('a.txt') === 'v3');

    // B) hand-edit detection: warn, respect cancel, then honor "Undo Anyway"
    write('b.txt', 'orig');
    provider.currentTurnId = 't2';
    await provider.toolWriteFile('b.txt', 'navy');
    write('b.txt', 'user-edited');            // simulate the user editing after Navy
    ctrl.reset(); ctrl.nextWarning = undefined; // user cancels the modal
    await provider.undoLastTurn();
    check('hand-edit: warning shown', ctrl.shown.warning.length === 1);
    check('hand-edit: cancel preserves user content', read('b.txt') === 'user-edited');
    ctrl.nextWarning = 'Undo Anyway';
    await provider.undoLastTurn();
    check('hand-edit: confirm discards to turn-start', read('b.txt') === 'orig');

    // C) rename undo/redo (single-step)
    write('c.txt', 'hi');
    provider.currentTurnId = 't3';
    ctrl.reset();
    await provider.toolRenameFile('c.txt', 'c2.txt');
    check('rename: applied', read('c2.txt') === 'hi' && read('c.txt') === null);
    await provider.undoLastCheckpoint();
    check('rename: undo reverses', read('c.txt') === 'hi' && read('c2.txt') === null);
    await provider.redoLast();
    check('rename: redo reapplies', read('c2.txt') === 'hi' && read('c.txt') === null);

    // D) delete undo/redo (single-step)
    write('d.txt', 'data');
    provider.currentTurnId = 't4';
    ctrl.reset();
    await provider.toolDeleteFile('d.txt');
    check('delete: applied', read('d.txt') === null);
    await provider.undoLastCheckpoint();
    check('delete: undo restores content', read('d.txt') === 'data');
    await provider.redoLast();
    check('delete: redo deletes again', read('d.txt') === null);
  } catch (e) {
    check('undo/redo suite ran', false, e.stack || e.message);
  } finally {
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── Missing-path hint on command failure (_spawnAndCollect) ────────────────
// A model that guesses a wrong path/filename and retries with a different
// guess, over and over, never converges — the real name has to actually be
// looked up. This nudges toward that instead of letting the retry loop run
// unbounded. No hardcoding to any one scenario: the detector is a general
// "does this output look like an OS/toolchain path-not-found error" pattern
// match, exercised here against synthetic text AND real spawned processes.
async function missingPathHintSuite() {
  console.log('\nmissing-path hint on command failure:');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();

  // Pure: the detector itself, against a range of real OS/toolchain error
  // phrasings — including one taken verbatim from a live cross-compiler
  // failure, not just cmd.exe's own errors — and clear negatives that must
  // NOT trigger it (a genuine compile/logic error, a bare non-zero exit).
  {
    // Exported from src/commands.js since the extraction — required directly
    // rather than eval'd out of source, which is both simpler and stronger.
    const { looksLikeMissingPathError } = require('../src/commands.js');
    const positives = [
      'The system cannot find the file specified.',
      'The system cannot find the path specified.',
      'The filename, directory name, or volume label syntax is incorrect.',
      "'gcc' is not recognized as an internal or external command, operable program or batch file.",
      "cc1.exe: fatal error: c:\\Users\\x\\Downloads\\hexdumb\\pe-any.c: No such file or directory\ncompilation terminated.",
      'bash: fooo: command not found',
      'ls: cannot access /nope: No such file or directory',
    ];
    for (const text of positives) {
      check('looksLikeMissingPathError: detects — ' + JSON.stringify(text.slice(0, 40)) + '…', looksLikeMissingPathError(text));
    }
    const negatives = [
      "error: expected ';' before '}' token",
      'AssertionError: expected 2 to equal 3',
      '',
      'Exit code: 1\nstdout:\n\nstderr:\n',
      'warning: unused variable \'x\'',
    ];
    for (const text of negatives) {
      check('looksLikeMissingPathError: does NOT flag — ' + JSON.stringify(text.slice(0, 40)), !looksLikeMissingPathError(text));
    }
  }

  // The container-pull detector — a docker/wsl sandbox that can't pull/reach its
  // image (usually DNS). It reads like the command failed; it is the sandbox's
  // network, not the code. Includes the exact wslc output that reported this.
  {
    const { looksLikeContainerPullError } = require('../src/commands.js');
    const pullFails = [
      "Image 'mcr.microsoft.com/devcontainers/javascript-node:22' not found, pulling\nGet \"https://mcr.microsoft.com/v2/\": dial tcp: lookup mcr.microsoft.com on 0.0.0.0:53: read udp 127.0.0.1:18486->127.0.0.1:53: i/o timeout\nError code: E_FAIL",
      'docker: Error response from daemon: manifest unknown',
      'failed to resolve reference "node:22": Temporary failure in name resolution',
      'Error: pull access denied for privaterepo, repository does not exist',
      'Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: no such host',
    ];
    for (const text of pullFails) {
      check('looksLikeContainerPullError: detects — ' + JSON.stringify(text.slice(0, 34)) + '…', looksLikeContainerPullError(text));
    }
    const notPull = [
      'Exit code: 1\nTypeError: cannot read property x of undefined',
      "error: expected ';' before '}' token",
      'AssertionError: 2 !== 3',
      '',
      'Exit code: 0\nall tests passed',
    ];
    for (const text of notPull) {
      check('looksLikeContainerPullError: does NOT flag — ' + JSON.stringify(text.slice(0, 34)), !looksLikeContainerPullError(text));
    }
  }

  // Real end-to-end, via a genuine spawned process through toolRunCommand —
  // not a mock of the spawn layer.
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-missingpath-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    ctrl.config.approvalMode = 'auto-approve';
    const isWin = process.platform === 'win32';

    const missing = path.join(tmp, 'definitely-does-not-exist-' + Date.now());
    const notFoundCmd = isWin ? `dir "${missing}"` : `ls "${missing}"`;
    const notFoundResult = await provider.toolRunCommand(notFoundCmd, 10000);
    check('toolRunCommand: a real not-found path gets the hint appended', /Navy: this looks like a path\/file\/command/.test(notFoundResult));
    check('toolRunCommand: the hint tells it to list the parent, not guess again', /do not guess again/.test(notFoundResult));

    const okCmd = isWin ? 'echo real-success-marker' : 'echo real-success-marker';
    const okResult = await provider.toolRunCommand(okCmd, 10000);
    check('toolRunCommand: a real successful command gets NO hint', !/Navy: this looks like/.test(okResult));

    const badExitCmd = isWin ? 'exit 3' : 'exit 3';
    const badExitResult = await provider.toolRunCommand(badExitCmd, 10000);
    check('toolRunCommand: a real non-path failure (bad exit code, no path text) gets NO hint', !/Navy: this looks like/.test(badExitResult));
  } catch (e) {
    check('missing-path hint suite ran', false, e.stack || e.message);
  } finally {
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 6d. check_syntax — real parsers, independent of any language extension ───
async function syntaxCheckSuite() {
  console.log('\ncheck_syntax (independent verification):');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-syntax-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const W = (n, c) => { fs.writeFileSync(path.join(tmp, n), c); return n; };

    // JSON — parsed in-process, no toolchain needed.
    W('good.json', '{"a": 1, "b": [2, 3]}');
    const goodJson = await provider.toolCheckSyntax('good.json');
    check('syntax: valid JSON reported VALID', goodJson.startsWith('VALID'));

    W('bad.json', '{\n  "a": 1,\n  "b": [2, 3,\n}');
    const badJson = await provider.toolCheckSyntax('bad.json');
    check('syntax: broken JSON reported SYNTAX ERROR', badJson.startsWith('SYNTAX ERROR'));
    check('syntax: broken JSON reports a line number (not a raw char offset)', /line \d+/.test(badJson));

    // JavaScript — real `node --check` subprocess.
    W('good.js', 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = add;\n');
    const goodJs = await provider.toolCheckSyntax('good.js');
    check('syntax: valid JS reported VALID', goodJs.startsWith('VALID'));

    W('bad.js', 'function broken( {\n  return 1;\n');
    const badJs = await provider.toolCheckSyntax('bad.js');
    check('syntax: broken JS reported SYNTAX ERROR', badJs.startsWith('SYNTAX ERROR'));
    check('syntax: broken JS includes the parser message', /SyntaxError|Unexpected/.test(badJs));

    // ESM syntax inside a .js file must not be mistaken for a syntax error —
    // `node --check` rejects it in script mode, so the module-mode retry matters.
    W('esm.js', 'import fs from "fs";\nexport const x = 1;\n');
    const esmJs = await provider.toolCheckSyntax('esm.js');
    check('syntax: ESM-in-.js falls back to module mode instead of false-failing', esmJs.startsWith('VALID'));

    // Unknown/unsupported type must NOT be reported as passing.
    W('notes.xyz', 'this is not any known language');
    const unknown = await provider.toolCheckSyntax('notes.xyz');
    check('syntax: unsupported type reports COULD NOT VERIFY', unknown.startsWith('COULD NOT VERIFY'));
    check('syntax: COULD NOT VERIFY explicitly states it is not a pass', /NOT a pass/.test(unknown));

    // Missing file → a clear error, not a crash and not a false pass.
    const missing = await provider.toolCheckSyntax('does-not-exist.json');
    check('syntax: missing file errors clearly (never reported VALID)',
      missing.startsWith('Error') && !missing.includes('VALID'));

    // Containment still applies — a path outside the workspace is refused.
    const outside = await provider.toolCheckSyntax(path.join(os.tmpdir(), 'elsewhere.json'));
    check('syntax: path outside the workspace refused', /Error/.test(outside) && !outside.startsWith('VALID'));

    // get_diagnostics silence must no longer read as "file is clean".
    ctrl.reset();
    const diagEmpty = await provider.toolGetDiagnostics('good.js');
    check('diagnostics: empty result no longer implies the file is valid',
      /does NOT prove|check_syntax/.test(diagEmpty));

    // Post-write fallback: a broken JSON write must surface a failure even
    // though the mock reports no LSP diagnostics at all.
    const brokenVerdict = await provider._syntaxVerdictAfterWrite(path.join(tmp, 'bad.json'));
    check('post-write: broken file caught with no language extension installed',
      /POST-EDIT SYNTAX CHECK FAILED/.test(brokenVerdict));
    const goodVerdict = await provider._syntaxVerdictAfterWrite(path.join(tmp, 'good.js'));
    check('post-write: a verified-clean edit stays silent', goodVerdict === '');
    // A type with a real on-demand checker gets nudged to verify...
    W('script.py', 'x = 1\n');
    const pyVerdict = await provider._syntaxVerdictAfterWrite(path.join(tmp, 'script.py'));
    check('post-write: a checkable type nudges the model to verify it',
      /NOT AUTO-VERIFIED/.test(pyVerdict) && /check_syntax/.test(pyVerdict));
    // ...but a type with NO checker must stay silent. Telling the model to call
    // check_syntax on a .md only burned an iteration to be told COULD NOT VERIFY.
    const unknownVerdict = await provider._syntaxVerdictAfterWrite(path.join(tmp, 'notes.xyz'));
    check('post-write: an uncheckable type stays silent (no impossible errand)',
      unknownVerdict === '');
    W('readme.md', '# hi\n');
    const mdVerdict = await provider._syntaxVerdictAfterWrite(path.join(tmp, 'readme.md'));
    check('post-write: markdown writes produce no verification noise', mdVerdict === '');

    // check_syntax must refuse an oversized file rather than reading it onto the heap.
    const bigPath = path.join(tmp, 'huge.json');
    fs.writeFileSync(bigPath, '{"pad":"' + 'x'.repeat(3 * 1024 * 1024) + '"}');
    const bigRes = await provider.toolCheckSyntax('huge.json');
    check('syntax: oversized file refused, not read into memory',
      bigRes.startsWith('COULD NOT VERIFY') && /larger than/.test(bigRes));
    fs.rmSync(bigPath, { force: true });

    // Regression: the checker's timeout timer was never cleared, so EVERY
    // finished check still fired a kill later. _killProcessTree runs a blocking
    // taskkill on Windows, so a multi-step turn (the post-write check runs on
    // every edit) queued up dozens of them and froze the extension host — and a
    // kill on a recycled PID can hit an unrelated process.
    {
      const killed = [];
      const realKill = provider._killProcessTree;
      provider._killProcessTree = (p) => { killed.push(p); };
      try {
        // Finishes in ~50ms, far inside the 150ms budget.
        const fast = await provider._runChecker(process.execPath, ['-e', ''], tmp, 150);
        check('runChecker: a fast command succeeds', fast.ok === true && !fast.timedOut);
        // Wait well past the timeout — a leaked timer would fire in this window.
        await new Promise(r => setTimeout(r, 500));
        check('runChecker: no kill fired after the process already finished', killed.length === 0);

        // The timeout must still work when a process genuinely hangs.
        killed.length = 0;
        const slow = await provider._runChecker(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], tmp, 200);
        check('runChecker: a hanging command is reported as timed out', slow.timedOut === true);
        check('runChecker: a hanging command IS killed', killed.length === 1);
      } finally {
        provider._killProcessTree = realKill;
      }
    }

    // Turns started without an await (queue drain, PR review, explain-error) are
    // fire-and-forget, so nothing upstream can catch a rejection — and an
    // unhandled rejection in the extension host is a process-level failure, i.e.
    // Navy dying mid-task with no explanation.
    {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'extension.js'), 'utf8');
      const calls = [...src.matchAll(/(?:^|[^.\w])this\.askNavy\(/g)];
      let unguarded = 0;
      for (const m of calls) {
        const after = src.slice(m.index, m.index + 900);
        // Either awaited at the call site, or it chains its own .catch().
        const awaited = /await\s+this\.askNavy\(/.test(src.slice(Math.max(0, m.index - 12), m.index + 20));
        if (!awaited && !/\.catch\(/.test(after.split(';')[0] + after.split(';')[1]) ) unguarded++;
      }
      check('async turns: every fire-and-forget askNavy has a catch', unguarded === 0,
        unguarded + ' unguarded call(s)');
      check('async turns: a failure handler exists', /_reportTurnFailure\s*\(err, context\)/.test(src));

      // The handler must release the busy lock, or a failed background turn
      // leaves the composer permanently disabled.
      const body = src.slice(src.indexOf('_reportTurnFailure(err, context) {'), src.indexOf('_reportTurnFailure(err, context) {') + 800);
      check('async turns: failure handler clears the busy lock', /isBusy\s*=\s*false/.test(body));
      check('async turns: failure handler tells the user', /type:\s*'error'/.test(body));
    }

    // ── The freeze itself: renderBlockMarkdown could loop forever ──────────────
    // The bug behind every "Navy randomly froze" report. The
    // paragraph branch rejected any line starting with `|`, while the table
    // branch only claimed one whose NEXT line was a separator row — so a table
    // header that was the last line so far belonged to neither, `i` never
    // advanced, and the panel was gone for good. Every streamed markdown table
    // passes through that state, which is why it hit at random.
    //
    // Run in a child process with a timeout: a regression here is an infinite
    // loop, so asserting in-process would hang this suite rather than fail it.
    {
      const r = require('child_process').spawnSync(
        process.execPath, [path.join(ROOT, 'test', 'render-hang-child.js')],
        { timeout: 60000, encoding: 'utf8', cwd: ROOT }
      );
      const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
      check('render: markdown renderer terminates on every input (no infinite loop)',
        !timedOut, timedOut ? 'renderer HUNG — the freeze is back' : '');

      let out = null;
      if (!timedOut) { try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch {} }
      check('render: child reported results', Boolean(out), (r.stderr || '').slice(0, 300));

      if (out) {
        // Every prefix matters: a render tick can land on any of them.
        check('render: every prefix of a review-shaped reply terminates',
          out.prefixes > 400 && out.prefixMs < 20000, `${out.prefixes} prefixes in ${out.prefixMs}ms`);
        for (const [name, ms] of Object.entries(out.cases)) {
          check(`render: "${name}" terminates`, ms < 5000, ms + 'ms');
        }
        // The fix must not have cost us actual markdown rendering.
        check('render: tables still render as tables', out.render.table && out.render.rows);
        check('render: code blocks still render', out.render.code);
        check('render: headings still render', out.render.headings);
        check('render: nested lists still render', out.render.nestedList);
        check('render: blockquotes still render', out.render.blockquote);
        check('render: non-table pipe lines are not swallowed', out.render.strayPipes);
        check('render: a lone table header renders as text, not nothing', out.render.headerAsText);
      }

      // The guard is what makes this class of bug non-fatal in future: any
      // branch that fails to consume a line gets the line forced out instead of
      // spinning. Keep it — the specific fix above only covers today's case.
      const src = fs.readFileSync(path.join(ROOT, 'media', 'main.js'), 'utf8');
      const fn = src.slice(src.indexOf('function renderBlockMarkdown(text) {'),
                           src.indexOf('function renderTable(lines)'));
      check('render: the block loop has an unconditional progress guard',
        /seenAt/.test(fn) && /if \(i === seenAt\)/.test(fn));
      check('render: the paragraph branch always consumes its first line',
        /const pLines = \[lines\[i\+\+\]\];/.test(fn));
    }

    // Workspace trust: declaring untrustedWorkspaces "false" stops the extension
    // activating while STILL contributing the view container, so the Navy panel
    // renders as an empty box with no explanation — indistinguishable from a
    // crash. "limited" keeps the UI alive; the runtime guards below are what
    // actually make that safe, so both halves must stay in place together.
    {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      check('trust: untrusted workspaces are "limited", not disabled (blank panel)',
        pkg.capabilities?.untrustedWorkspaces?.supported === 'limited');

      // Every src/*.js, not just extension.js: these assert that a guard exists
      // somewhere in the shipped code, and pinning them to one file makes an
      // ordinary module extraction look like a security regression.
      const src = fs.readdirSync(path.join(ROOT, 'src'), { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.js'))
        .map(e => fs.readFileSync(path.join(ROOT, 'src', e.name), 'utf8'))
        .join('\n');
      // Every path that executes code or ships file contents off the machine
      // must refuse in an untrusted folder.
      for (const fn of ['toolRunCommand', 'toolRunTests', 'toolRunProject', 'toolStartProcess', 'toolCheckSyntax']) {
        const at = src.indexOf('async ' + fn + '(');
        const body = at === -1 ? '' : src.slice(at, at + 600);
        check(`trust: ${fn} refuses in an untrusted workspace`, /workspaceIsTrusted\(\)/.test(body));
      }
      check('trust: MCP servers are not launched in an untrusted workspace',
        /workspaceIsTrusted\(\)/.test(src.slice(src.indexOf('async reloadMcpServers('), src.indexOf('async reloadMcpServers(') + 900)));
      check('trust: embedding upload is blocked in an untrusted workspace',
        /workspaceIsTrusted\(\)/.test(src.slice(src.indexOf('async _updateEmbeddingIndex('), src.indexOf('async _updateEmbeddingIndex(') + 900)));
    }

    // ── Security: the checker must not execute code from the inspected repo ──
    // A repo-local py_compile.py used to be executed by `python -m py_compile`
    // because -m puts cwd first on sys.path. Two independent guards now: the -I
    // isolation flag, and running with cwd OUTSIDE the project.
    {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'extension.js'), 'utf8');
      const table = src.slice(src.indexOf('const EXTERNAL = {'), src.indexOf('const spec = EXTERNAL[ext]'));
      check('security: python checker runs in isolated mode (-I)', /'\.py':\s*\{[^}]*'-I'/.test(table));
      check('security: no npx in the checker table (executes repo-local binaries)', !/npx/.test(table));
      check('security: no rustc --emit=metadata (macro-expands, reads outside workspace)', !/rustc/.test(table));
      check('security: no bare tsc invocation in the checker table', !/tsc/.test(table));
      // Every checker invocation must use the out-of-repo cwd constant.
      const fnBody = src.slice(src.indexOf('async toolCheckSyntax('), src.indexOf('_isBlockedHost'));
      const runCalls = fnBody.match(/_runChecker\([^)]*\)/g) || [];
      check('security: every checker spawn uses the out-of-repo cwd',
        runCalls.length > 0 && runCalls.every(c => c.includes('CHECKER_CWD')));
    }

    // Credential-shaped filenames must never be selected for embedding upload.
    {
      // The predicate closes over a module-level regex, so pull that in too
      // rather than re-declaring it here (a copy would drift from the shipped one).
      // Moved to src/retrieval.js with the rest of the embedding code, so it is
      // imported rather than source-extracted — the shipped function itself,
      // which is what the extraction was working around in the first place.
      const { isSensitiveForEmbedding: sensitive } = require('../src/retrieval.js');
      for (const f of ['.env', '.env.production', 'secrets.json', 'my-secret.yml',
                       'credentials.json', 'serviceAccount.json', 'foo-adminsdk-x.json',
                       'docker-compose.yml', 'private-key.pem', 'id_rsa', 'config.local.json',
                       'app.token.json', 'db_password.txt', '.npmrc']) {
        check(`privacy: "${f}" excluded from embedding upload`, sensitive(f) === true);
      }
      for (const f of ['index.js', 'server.ts', 'README.md', 'tsconfig.json',
                       'environment.ts', 'tokenizer.js']) {
        check(`privacy: ordinary source "${f}" still indexed`, sensitive(f) === false);
      }
    }

    // Inline completions must not stream arbitrary open files to a provider.
    {
      // fold/foldPath and isSensitiveForEmbedding are real modules now
      // (src/paths.js, src/retrieval.js), so they are imported rather than
      // source-extracted — which is what they should always have been.
      // documentEligibleForCompletion is still inline in extension.js, so it
      // is still lifted out and given its dependencies as parameters.
      const { fold, foldPath } = require('../src/paths.js');
      const { isSensitiveForEmbedding } = require('../src/retrieval.js');
      const eligible = new Function('path', 'process', 'fold', 'foldPath', 'isSensitiveForEmbedding',
        extractFunction(extSrc, 'function rootBelongsToWorkspace') + '\n' +
        extractFunction(extSrc, 'function documentEligibleForCompletion') +
        '\nreturn documentEligibleForCompletion;'
      )(path, process, fold, foldPath, isSensitiveForEmbedding);
      const doc = (p, scheme = 'file') => ({ uri: { scheme, fsPath: p } });
      const ws = [tmp];
      check('privacy: a normal workspace file is eligible', eligible(doc(path.join(tmp, 'a.js')), ws) === true);
      check('privacy: a file outside the workspace is NOT sent',
        eligible(doc(path.join(os.tmpdir(), 'elsewhere', 'x.js')), ws) === false);
      check('privacy: a credentials file inside the workspace is NOT sent',
        eligible(doc(path.join(tmp, '.env.production')), ws) === false);
      check('privacy: a non-file scheme (untitled/output) is NOT sent',
        eligible(doc(path.join(tmp, 'a.js'), 'untitled'), ws) === false);
    }

    // Regression: _rgRun truncates `out` back to exactly maxOut, so without a
    // latch every following chunk re-tripped the overflow branch and killed
    // again — measured at ~30,000 kill attempts for one broad search. The kill
    // used to be a synchronous taskkill on the extension host thread, so that
    // was a total editor freeze.
    {
      const kills = [];
      const realKill = provider._killProcessTree;
      provider._killProcessTree = (p) => { kills.push(p); };
      try {
        // A process that floods stdout far past the 1KB cap used here.
        const res = await provider._rgRun(
          process.execPath,
          ['-e', 'for(let i=0;i<60000;i++)console.log("line "+i+" some matching content")'],
          tmp,
          1024
        );
        check('rg overflow: output truncated to the cap', res.out.length <= 1024);
        check('rg overflow: process killed exactly once, not once per chunk',
          kills.length === 1, `fired ${kills.length} times`);
      } finally {
        provider._killProcessTree = realKill;
      }
    }

    // The kill itself must never block the extension host thread.
    check('kill: no synchronous execSync anywhere in the extension',
      !/\bexecSync\s*\(/.test(extSrc));

    // Availability probe: a definitely-absent binary must resolve false (and be
    // cached), so an uninstalled toolchain reports "could not verify", not a pass.
    const absent = await provider._commandAvailable('navy-definitely-not-a-real-binary-xyz');
    check('syntax: availability probe returns false for a missing binary', absent === false);
    const node = await provider._commandAvailable(process.platform === 'win32' ? 'where' : 'sh');
    check('syntax: availability probe returns true for a present binary', node === true);
  } catch (e) {
    check('check_syntax suite ran', false, e.stack || e.message);
  } finally {
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── Replayable tool cards ───────────────────────────────────────────────────
// A saved chat used to keep only role + text, so reopening one replaced every
// activity row, terminal card and edit card with bare prose. These records are
// what a restore redraws from — and they live in a file inside the user's repo,
// so what they DON'T keep matters as much as what they do.
function cardRecordSuite() {
  console.log('\nsession restore — tool cards:');
  const { makeCardRecord } = require('../src/extension.js');

  const read = makeCardRecord('read_file', { path: 'src/app.js' }, 'a\nb\nc');
  check('card: the tool and its target are kept', read.tool === 'read_file' && read.args.path === 'src/app.js');
  check('card: a short result is kept whole', read.result === 'a\nb\nc');
  check('card: …and needs no size record', read.full === undefined);

  // The single biggest thing that would bloat .navy/chats/<id>.json: a card
  // never displays file content, so it never stores it.
  const write = makeCardRecord('write_file', { path: 'src/app.js', content: 'x'.repeat(50_000) }, 'Applied to src/app.js');
  check('card: a written file body is dropped, not truncated', write.args.content === undefined);
  check('card: …while what the card actually shows survives', write.args.path === 'src/app.js');
  check('card: the record of a whole-file write stays tiny',
    JSON.stringify(write).length < 200, String(JSON.stringify(write).length));

  // Truncation changes what the card would count, so the true sizes travel
  // with the excerpt — otherwise a 900-line file comes back as "8 lines".
  const big = Array.from({ length: 900 }, (_, i) => (i % 5 ? 'line ' + i : '')).join('\n');
  const huge = makeCardRecord('read_file', { path: 'big.js' }, big);
  check('card: an oversized result is truncated', huge.result.length < big.length);
  check('card: …but its real line count is preserved', huge.full.lines === 900, String(huge.full?.lines));
  check('card: …and its real size', huge.full.chars === big.length);
  check('card: …and the non-blank count the file-list previews use',
    huge.full.filled === big.split('\n').filter(l => l.trim()).length);

  // Terminal cards print real output, so they get a much larger allowance than
  // the one-line previews every other tool shows.
  const out = 'Exit code: 0\n' + 'stdout line\n'.repeat(500);
  const term = makeCardRecord('run_command', { command: 'npm test' }, out);
  check('card: a command keeps enough output to be worth reading',
    term.result.length > 3000, String(term.result.length));
  check('card: …but is still bounded', term.result.length <= 4000);

  const err = makeCardRecord('read_file', { path: 'gone.js' }, 'Error: no such file');
  check('card: a failure is recorded as one', err.result.startsWith('Error'));

  // Nothing here may mutate the live tool arguments — the same object is handed
  // to the model's own tool-result record moments later.
  const args = { path: 'a.js', content: 'body' };
  makeCardRecord('write_file', args, 'Applied to a.js');
  check('card: recording does not disturb the arguments it was given', args.content === 'body');
}

// Undoing a bad turn's FILES was always possible; the conversation it happened
// in was not. That left the worst of the three states — the files back where
// they were, and the model still holding every wrong assumption that produced
// them, including its own confident account of edits that no longer exist.
async function rewindSuite() {
  console.log('\nconversation rewind (transcript, digest, files):');
  const os = require('os');
  const { ctrl } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-rewind-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const posted = [];
    provider.view = { webview: { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } } };
    provider._wslCache = { available: false };
    ctrl.config.approvalMode = 'auto-approve';

    const target = path.join(tmp, 'thing.js');
    fs.writeFileSync(target, 'original');

    // Three turns, the middle one writing a file.
    global.fetch = queueOllamaFetch([{ text: 'First answer.' }]);
    await provider.askNavy('question one', false, null, [], []);
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'thing.js', content: 'rewritten by turn two' } }] },
      { text: 'I rewrote it.' },
    ]);
    await provider.askNavy('question two', false, null, [], []);
    global.fetch = queueOllamaFetch([{ text: 'Third answer.' }]);
    await provider.askNavy('question three', false, null, [], []);

    check('setup: six messages, three turns', provider.messages.length === 6);
    check('setup: the file was actually changed', fs.readFileSync(target, 'utf8') === 'rewritten by turn two');

    // ── Every user message records what a rewind to it would restore. ─────
    const stamped = provider.messages.filter(m => m.role === 'user');
    check('turns record WHEN they were asked, in epoch ms',
      stamped.every(m => Number.isFinite(m.ts) && Math.abs(Date.now() - m.ts) < 60000),
      JSON.stringify(stamped.map(m => m.ts)));
    check('replies are not stamped — one timestamp per exchange',
      provider.messages.filter(m => m.role === 'assistant').every(m => m.ts === undefined));

    check('rewind: user messages carry a rewind point',
      provider.messages.filter(m => m.role === 'user').every(m => typeof m.rewind?.digest === 'string'));
    check('rewind: assistant messages carry the turn id that maps to their file changes',
      provider.messages.filter(m => m.role === 'assistant').every(m => typeof m.meta?.turnId === 'string'));

    // ── What a rewind would cost, before anything is done. ───────────────
    const impact = provider._rewindImpact(2); // index 2 = "question two"
    check('rewind: impact counts the turns that would be discarded', impact.turns === 2, impact.turns);
    check('rewind: impact names the files those turns changed',
      impact.files.length === 1 && /thing\.js$/.test(impact.files[0]), JSON.stringify(impact.files));

    // ── Rewinding without touching files. ────────────────────────────────
    posted.length = 0;
    const kept = await provider.rewindToMessage(2, false);
    check('rewind: the transcript is truncated to the chosen message', provider.messages.length === 2);
    check('rewind: …and the discarded turns are really gone',
      !provider.messages.some(m => /question two|question three/.test(m.text || '')));
    check('rewind: the earlier turns are untouched', provider.messages[0].text === 'question one');
    check('rewind: keeping files leaves the file as the turn left it',
      fs.readFileSync(target, 'utf8') === 'rewritten by turn two' && kept.files === 0);
    check('rewind: the panel is told to redraw from the truncated history',
      posted.some(m => m.type === 'restore' && m.messages.length === 2));
    check('rewind: …and told what happened, with the prompt handed back',
      posted.some(m => m.type === 'rewound' && m.prompt === 'question two'));

    // ── Rewinding WITH files. ────────────────────────────────────────────
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'thing.js', content: 'rewritten again' } }] },
      { text: 'Rewrote it again.' },
    ]);
    await provider.askNavy('question four', false, null, [], []);
    check('setup: the file changed again', fs.readFileSync(target, 'utf8') === 'rewritten again');

    const before = provider.checkpoints.length;
    const undone = await provider.rewindToMessage(2, true);
    check('rewind with files: the file is restored to what it was before the turn',
      fs.readFileSync(target, 'utf8') === 'rewritten by turn two', fs.readFileSync(target, 'utf8'));
    check('rewind with files: it reports how many it restored', undone.files === 1);
    check('rewind with files: the turn checkpoints are consumed', provider.checkpoints.length < before);
    check('rewind with files: …and the restore is redoable', provider.redoStack.length > 0);

    // ── Refusals. ────────────────────────────────────────────────────────
    ctrl.shown.warning.length = 0;
    check('rewind: an out-of-range index is refused', (await provider.rewindToMessage(99, false)) === null);
    check('rewind: a negative index is refused', (await provider.rewindToMessage(-1, false)) === null);
    check('rewind: targeting an assistant message is refused — rewind means "before I said this"',
      (await provider.rewindToMessage(1, false)) === null);
    provider.isBusy = true;
    check('rewind: refused mid-turn rather than truncating under a running turn',
      (await provider.rewindToMessage(0, false)) === null);
    provider.isBusy = false;
    check('rewind: every refusal told the user why', ctrl.shown.warning.length === 4, ctrl.shown.warning.length);

    // ── The digest goes back with the transcript. ────────────────────────
    provider.messages = [
      { role: 'user', text: 'early', rewind: { digest: 'DIGEST AS OF EARLY' } },
      { role: 'assistant', text: 'ok', meta: { turnId: 'ta' } },
      { role: 'user', text: 'later', rewind: { digest: 'DIGEST AS OF LATER' } },
      { role: 'assistant', text: 'ok', meta: { turnId: 'tb' } },
    ];
    provider.sessionDigest = 'DIGEST AS OF NOW';
    await provider.rewindToMessage(2, false);
    check('rewind: the session digest is restored to what it was at that point',
      provider.sessionDigest === 'DIGEST AS OF LATER', provider.sessionDigest);

    // ── A plan cannot outlive the turn it belonged to. ───────────────────
    await provider.toolUpdatePlan(['a step']);
    await provider.rewindToMessage(0, false);
    check('rewind: the plan is cleared with the turns that made it', provider.plan.length === 0);

    // ── Chats saved before rewind existed still rewind. ──────────────────
    provider.messages = [
      { role: 'user', text: 'old question' },                       // no rewind point
      { role: 'assistant', text: 'old answer', meta: { files: ['x.js'] } }, // no turnId
      { role: 'user', text: 'new question', rewind: { digest: 'D' } },
      { role: 'assistant', text: 'new answer', meta: { turnId: 'tc' } },
    ];
    const legacy = await provider.rewindToMessage(0, true);
    check('rewind: a chat saved before 0.3.1 still rewinds', legacy !== null && provider.messages.length === 0);
    check('rewind: …and reports no files, because none can be matched to it', legacy.files === 0);

    // ── The manifest command. ────────────────────────────────────────────
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    check('navy.rewindConversation is declared',
      manifest.contributes.commands.some(c => c.command === 'navy.rewindConversation'));

    // undoLastTurn and rewind must share one implementation: two copies of the
    // newest-to-oldest replay rule would be a very quiet divergence.
    const undoSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'undo.js'), 'utf8');
    check('undoLastTurn and rewind share _undoTurns',
      /_undoTurns\(\[lastTurnId\]\)/.test(undoSrc) && (undoSrc.match(/for \(const cp of toUndo\)/g) || []).length === 1);
  } finally {
    global.fetch = realFetch;
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { undoRedoSuite, missingPathHintSuite, syntaxCheckSuite, cardRecordSuite, rewindSuite };
