const {
  fs, path, check, makeContext, sharedMock,
} = require('./harness.js');

// ── 9. cancelPendingApprovals (Stop/Clear) must notify the webview ───────────
// Regression: previously resolved pending approval promises directly with no
// notification, leaving whatever Approve/Reject card was still pending stuck
// with visibly-enabled but functionally dead buttons after Stop.
async function approvalCancelSuite() {
  console.log('\napproval cancel (Stop must not leave dead buttons):');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-cancel-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    const filePath = path.join(tmp, 'a.js');
    fs.writeFileSync(filePath, 'original');

    // Pending command approval — the "Run this command?" card.
    let cmdResolvedWith;
    const cmdPromise = new Promise((resolve) => {
      provider.pendingCommandApprovals.set('cmd1', { resolve: (v) => { cmdResolvedWith = v; resolve(v); } });
    });

    // Pending agent-edit approval — the main diff-card flow.
    let editResolvedWith;
    const editPromise = new Promise((resolve) => {
      provider.pendingApprovals.set('edit1', { resolve: (v) => { editResolvedWith = v; resolve(v); }, filePath, kind: 'agent-edit' });
    });

    // Pending legacy applyCode approval (no `kind` — the sidebar-card apply flow).
    let legacyResolvedWith;
    const legacyPromise = new Promise((resolve) => {
      provider.pendingApprovals.set('legacy1', { resolve: (v) => { legacyResolvedWith = v; resolve(v); }, filePath, search: '', replace: '', newText: 'CHANGED' });
    });

    provider.cancelPendingApprovals();
    await Promise.all([cmdPromise, editPromise, legacyPromise]);

    check('cancel: command approval resolves rejected', cmdResolvedWith === false);
    check('cancel: command card notified so its buttons unstick',
      posted.some(m => m.type === 'commandResolved' && m.id === 'cmd1' && m.approved === false));

    check('cancel: agent-edit approval resolves to reject', editResolvedWith === 'reject');
    check('cancel: agent-edit entry removed from the pending map', !provider.pendingApprovals.has('edit1'));

    check('cancel: legacy apply card notified so its buttons unstick',
      posted.some(m => m.type === 'diffResolved' && m.id === 'legacy1' && m.approved === false));
    check('cancel: legacy apply did NOT write the file', fs.readFileSync(filePath, 'utf8') === 'original');
    check('cancel: legacy apply resolves to a rejection, not a silent placeholder string', legacyResolvedWith === 'Edit rejected by user');

    check('cancel: both pending maps fully drained', provider.pendingApprovals.size === 0 && provider.pendingCommandApprovals.size === 0);
  } catch (e) {
    check('approval cancel suite ran', false, e.stack || e.message);
  } finally {
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// navy.approvalMode (files) and navy.commandApproval (execution) are two
// settings on purpose. They were one until 0.3.1, which meant a user who turned
// off diff prompts also granted unattended shell execution and unattended
// third-party MCP calls — while the setting's own description said it governed
// file edits. These assertions exist so that can never quietly come back.
async function approvalScopeSuite() {
  console.log('\napproval scopes (files vs execution are separate gates):');
  const os = require('os');
  const { ctrl } = sharedMock();
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-approvalscope-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const posted = [];
    provider.view = { webview: { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } } };

    // ── The two helpers read two different keys, and nothing else. ─────────
    const perms = [
      ['ask-always', 'ask-always', false, false],
      ['auto-approve', 'ask-always', true, false],
      ['ask-always', 'auto-approve', false, true],
      ['auto-approve', 'auto-approve', true, true],
    ];
    let permsOk = true;
    for (const [edit, cmd, wantEdit, wantCmd] of perms) {
      ctrl.config.approvalMode = edit;
      ctrl.config.commandApproval = cmd;
      if (provider._editsAutoApproved() !== wantEdit || provider._commandsAutoApproved() !== wantCmd) permsOk = false;
    }
    check('approval helpers: each reads its own key, independently', permsOk);

    // ── The regression itself. Edits auto, commands ask: a file write goes
    //    through untouched, and a COMMAND still stops for a human. ──────────
    ctrl.config.approvalMode = 'auto-approve';
    ctrl.config.commandApproval = 'ask-always';
    posted.length = 0;
    const cmdGate = provider._approveCommand('rm -rf /');
    const settled = await Promise.race([cmdGate.then(() => 'resolved'), Promise.resolve('pending')]);
    check('edits auto + commands ask: _approveCommand does NOT auto-approve', settled === 'pending');
    check('edits auto + commands ask: a command approval card is raised', posted.some(m => m.type === 'pendingCommand' && m.command === 'rm -rf /'));
    // Release the waiter so the suite can't leak a live promise.
    for (const [id] of provider.pendingCommandApprovals) provider.resolveCommandApproval(id, false);
    check('edits auto + commands ask: rejecting the card denies the command', (await cmdGate) === false);

    // Same config, the file side: no prompt, the delete just happens.
    fs.writeFileSync(path.join(tmp, 'gone.txt'), 'x');
    ctrl.shown.warning.length = 0;
    ctrl.nextWarning = undefined; // nothing would confirm a prompt if one were raised
    const delResult = await provider.toolDeleteFile('gone.txt');
    check('edits auto + commands ask: a file delete is NOT gated', /Deleted gone.txt/.test(delResult) && ctrl.shown.warning.length === 0);

    // ── The mirror image: commands auto, edits ask. ────────────────────────
    ctrl.config.approvalMode = 'ask-always';
    ctrl.config.commandApproval = 'auto-approve';
    check('commands auto + edits ask: _approveCommand approves immediately', (await provider._approveCommand('npm test')) === true);

    fs.writeFileSync(path.join(tmp, 'kept.txt'), 'x');
    ctrl.shown.warning.length = 0;
    ctrl.nextWarning = undefined;   // user dismisses
    const keptResult = await provider.toolDeleteFile('kept.txt');
    check('commands auto + edits ask: a file delete IS gated', ctrl.shown.warning.length === 1 && /cancelled by user/.test(keptResult));
    check('commands auto + edits ask: the dismissed delete did not happen', fs.existsSync(path.join(tmp, 'kept.txt')));

    // ── The webview is told about both, so neither dropdown can drift. ─────
    ctrl.config.approvalMode = 'auto-approve';
    ctrl.config.commandApproval = 'ask-always';
    posted.length = 0;
    provider.sendApprovalMode();
    const sent = posted.find(m => m.type === 'approvalMode');
    check('sendApprovalMode: reports both scopes', sent?.mode === 'auto-approve' && sent?.commandMode === 'ask-always');

    // ── setApprovalMode writes the key its scope names, and only that one. ──
    let handler = null;
    const fakeView = {
      webview: {
        postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
        asWebviewUri: (u) => u,
        cspSource: 'test-csp',
        onDidReceiveMessage: (h) => { handler = h; return { dispose() {} }; },
      },
      onDidDispose: () => {}, onDidChangeVisibility: () => {},
    };
    await provider.resolveWebviewView(fakeView);

    ctrl.config.approvalMode = 'ask-always';
    ctrl.config.commandApproval = 'ask-always';
    ctrl.nextWarning = 'Enable';
    await handler({ type: 'setApprovalMode', scope: 'command', mode: 'auto-approve' });
    check('setApprovalMode scope=command: writes commandApproval only',
      ctrl.config.commandApproval === 'auto-approve' && ctrl.config.approvalMode === 'ask-always');

    ctrl.config.commandApproval = 'ask-always';
    ctrl.nextWarning = 'Enable';
    await handler({ type: 'setApprovalMode', scope: 'edit', mode: 'auto-approve' });
    check('setApprovalMode scope=edit: writes approvalMode only',
      ctrl.config.approvalMode === 'auto-approve' && ctrl.config.commandApproval === 'ask-always');

    // A message with no scope is the pre-0.3.1 shape — it must mean FILES, not
    // execution, or an old webview would silently switch commands on.
    ctrl.config.approvalMode = 'ask-always';
    ctrl.config.commandApproval = 'ask-always';
    ctrl.nextWarning = 'Enable';
    await handler({ type: 'setApprovalMode', mode: 'auto-approve' });
    check('setApprovalMode without scope: defaults to the FILE gate',
      ctrl.config.approvalMode === 'auto-approve' && ctrl.config.commandApproval === 'ask-always');

    // Declining the modal must leave the setting alone.
    ctrl.config.commandApproval = 'ask-always';
    ctrl.nextWarning = undefined; // dismissed
    await handler({ type: 'setApprovalMode', scope: 'command', mode: 'auto-approve' });
    check('setApprovalMode: a declined confirmation does not change the setting', ctrl.config.commandApproval === 'ask-always');

    // The warning has to describe the gate actually being flipped — the old
    // single message named edits and commands together, which is now wrong
    // whichever one you are changing.
    ctrl.shown.warning.length = 0;
    ctrl.nextWarning = undefined;
    await handler({ type: 'setApprovalMode', scope: 'command', mode: 'auto-approve' });
    const cmdWarn = ctrl.shown.warning[0] || '';
    check('setApprovalMode: the command warning names execution, not edits', /COMMANDS/.test(cmdWarn) && /cannot be undone/.test(cmdWarn));
    ctrl.shown.warning.length = 0;
    ctrl.nextWarning = undefined;
    await handler({ type: 'setApprovalMode', scope: 'edit', mode: 'auto-approve' });
    const editWarn = ctrl.shown.warning[0] || '';
    check('setApprovalMode: the edit warning says commands are unaffected', /FILE CHANGES/.test(editWarn) && /Commands are unaffected/.test(editWarn));

    // ── Static guard. Wiring a new tool to the wrong gate is a safety bug,
    //    not a style problem, so no site outside the two helpers and the
    //    reporter may read either key directly. ──────────────────────────────
    const srcDir = path.join(__dirname, '..', 'src');
    const srcFiles = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full); else if (e.name.endsWith('.js')) srcFiles.push(full);
      }
    })(srcDir);

    const rawRead = /\.get\('(approvalMode|commandApproval)'/g;
    let rawTotal = 0;
    const strays = [];
    for (const file of srcFiles) {
      const text = fs.readFileSync(file, 'utf8');
      const hits = text.match(rawRead) || [];
      rawTotal += hits.length;
      if (hits.length && path.basename(file) !== 'extension.js') strays.push(path.basename(file));
    }
    check('approval keys: no module outside extension.js reads them directly', strays.length === 0, strays.join(', '));
    // Two in the helpers, two in sendApprovalMode. Any other read is a gate
    // that bypassed the helpers, which is exactly the bug this suite pins.
    check('approval keys: exactly 4 raw reads, all in the helpers + reporter', rawTotal === 4, 'found ' + rawTotal);

    // Counted across ALL of src/, not just extension.js. The gates used to
    // live in one file; _approveCommand, run_project and start_process moved
    // to commands.js, and a guard that kept looking in one place would have
    // read that as three gates disappearing.
    const allSrc = srcFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
    const editGates = (allSrc.match(/_editsAutoApproved\(\)/g) || []).length;
    const cmdGates = (allSrc.match(/_commandsAutoApproved\(\)/g) || []).length;
    // 1 definition + 5 gates (write, delete, rename, rename_symbol, applyCode)
    // + 1 read in the diagnostics report, which states the EFFECTIVE setting
    // and goes through the helper for that reason rather than reading the key.
    check('file gates route through _editsAutoApproved', editGates === 7, 'found ' + editGates);
    // 1 definition + 5 gates (MCP tools, MCP resource reads, _approveCommand,
    // run_project, start_process) + the same diagnostics read. Reading an MCP
    // resource reaches a server the user configured, so it is gated like every
    // other call to one — it is not a file read, and the file gate has nothing
    // to say about it.
    check('execution gates route through _commandsAutoApproved', cmdGates === 7, 'found ' + cmdGates);

    // ── The manifest must ship the safe default, whatever the file gate says. ──
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const decl = manifest.contributes.configuration.properties['navy.commandApproval'];
    check('navy.commandApproval is declared and defaults to ask-always', decl?.default === 'ask-always');
    check('navy.approvalMode no longer claims to cover commands',
      !/run command/i.test(manifest.contributes.configuration.properties['navy.approvalMode'].description));
  } finally {
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// Every navy.* setting is declared once in the manifest and read many times in
// the source, each read carrying its own fallback literal. When those disagree
// the manifest wins at runtime and the fallback becomes dead code — right up
// until the setting cannot be read, at which point Navy quietly behaves like a
// version nobody shipped.
//
// maxToolIterations sat like that: the manifest said 100, three call sites
// passed 50. The in-editor suite checks that declared settings resolve to their
// declared defaults, which it reads FROM the manifest — so it could never see
// the other half of the disagreement.
async function settingsDefaultsSuite() {
  console.log('\nsettings defaults (manifest vs code fallbacks):');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const declared = manifest.contributes.configuration.properties;

  const srcDir = path.join(__dirname, '..', 'src');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full); else if (e.name.endsWith('.js')) files.push(full);
    }
  })(srcDir);

  // Only literals can be compared. An object/array default, or a computed one,
  // is skipped rather than guessed at — a false alarm here would be worse than
  // the gap, because the next person would learn to ignore this test.
  const parseLiteral = (raw) => {
    const t = raw.trim();
    if (/^'[^']*'$/.test(t)) return { ok: true, value: t.slice(1, -1) };
    if (/^-?\d+(\.\d+)?$/.test(t)) return { ok: true, value: Number(t) };
    if (t === 'true') return { ok: true, value: true };
    if (t === 'false') return { ok: true, value: false };
    return { ok: false };
  };

  const mismatches = [];
  let compared = 0;
  // Matches both the inline form and the destructured-handle form; the key
  // having to exist in the manifest is what keeps non-navy configs out.
  const re = /\.get\(\s*'([A-Za-z][\w]*)'\s*,\s*([^),]+?)\s*\)/g;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = re.exec(text)) !== null) {
      const [, key, rawDefault] = m;
      const decl = declared['navy.' + key];
      if (!decl || !('default' in decl)) continue;
      const lit = parseLiteral(rawDefault);
      if (!lit.ok) continue;
      compared++;
      if (lit.value !== decl.default) {
        mismatches.push(`${path.basename(file)}: navy.${key} — manifest ${JSON.stringify(decl.default)}, code ${JSON.stringify(lit.value)}`);
      }
    }
  }

  check('settings: the suite actually found call sites to compare', compared > 20, 'compared ' + compared);
  check('settings: every code fallback matches the manifest default', mismatches.length === 0,
    '\n      ' + mismatches.join('\n      '));

  // The specific one that was wrong, pinned by name so a regression is legible
  // rather than just a count going up.
  const extSrc = fs.readFileSync(path.join(srcDir, 'extension.js'), 'utf8');
  check('settings: maxToolIterations agrees with the manifest everywhere it is read',
    !/maxToolIterations', 50\)/.test(extSrc) && declared['navy.maxToolIterations'].default === 100);
}

// Navy transmits nothing, and that stays true. The cost is that a bug report
// reduces to "it didn't work" — so the diagnostics bundle assembles what a
// maintainer would otherwise ask for, locally, and lets the user decide whether
// to share it. Which makes what it CANNOT contain the important part.
async function diagnosticsSuite() {
  console.log('\ndiagnostics bundle (local, redacted, never sent):');
  const os = require('os');
  const { ctrl } = sharedMock();
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    const { LOG_RING_MAX } = require('../src/diagnostics.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-diag-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    // ── Redaction, which happens on the way IN. ────────────────────────────
    const secrets = [
      ['sk-abcdefghijklmnopqrstuvwxyz012345', 'sk-'],
      ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'sk-ant-'],
      ['gsk_abcdefghijklmnopqrstuvwxyz012345', 'gsk_'],
      ['xai-abcdefghijklmnopqrstuvwxyz012345', 'xai-'],
      ['AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ01234', 'AIza'],
    ];
    for (const [key, prefix] of secrets) {
      const out = provider._redactForReport('calling with key=' + key);
      check(`redaction: a ${prefix}… key never survives`, !out.includes(key), out);
    }
    check('redaction: an Authorization header is scrubbed',
      !provider._redactForReport('Authorization: Bearer hunter2hunter2').includes('hunter2'));
    check('redaction: any long token-shaped run is scrubbed even if unrecognised',
      provider._redactForReport('tok ' + 'a'.repeat(50)).includes('<redacted-long-token>'));

    check('redaction: the project path is replaced',
      provider._redactForReport('failed at ' + tmp + '/src/a.js') === 'failed at <project>/src/a.js');
    check('redaction: the project path is replaced in forward-slash form too',
      provider._redactForReport('failed at ' + tmp.replace(/\\/g, '/') + '/src/a.js') === 'failed at <project>/src/a.js');
    check('redaction: the home directory is replaced',
      provider._redactForReport('read ' + os.homedir() + '/.navy/x').includes('~/'));
    check('redaction: survives a null line without throwing', provider._redactForReport(null) === '');

    // ── The ring is bounded and scrubbed at the door. ─────────────────────
    provider._logRing = null;
    provider._recordLogLine('key=sk-abcdefghijklmnopqrstuvwxyz012345');
    check('log ring: the STORED line is already scrubbed, not scrubbed at render time',
      !provider._logRing[0].includes('sk-abcdefghijklmnopqrstuvwxyz012345'));
    for (let i = 0; i < LOG_RING_MAX + 50; i++) provider._recordLogLine('line ' + i);
    check('log ring: bounded', provider._logRing.length === LOG_RING_MAX, provider._logRing.length);
    check('log ring: keeps the MOST RECENT lines',
      provider._logRing[provider._logRing.length - 1] === 'line ' + (LOG_RING_MAX + 49));

    // ── The report. ───────────────────────────────────────────────────────
    ctrl.config.provider = 'anthropic';
    ctrl.config.model = 'some-unreleased-model';
    provider._diagnosticsKeyState = false;
    provider._logRing = ['turn failed: ECONNREFUSED'];
    const report = provider.buildDiagnosticsReport();

    check('report: says plainly that nothing was transmitted', /has not been sent anywhere/.test(report));
    check('report: names the provider and model', /anthropic/.test(report) && /some-unreleased-model/.test(report));
    check('report: reports a MISSING key without ever printing one',
      /API key\s+MISSING/.test(report) && !/sk-/.test(report));
    check('report: flags a model the pricing table cannot cost',
      /Cost estimate\s+UNAVAILABLE/.test(report) && /navy\.modelPricing/.test(report));
    check('report: dates the pricing snapshot so a stale estimate reads as stale',
      /Pricing checked\s+\d{4}-\d{2}-\d{2}/.test(report));
    check('report: states both approval gates separately',
      /File approval/.test(report) && /Command approval/.test(report));
    check('report: states the resolved shell', /Shell\s+\w/.test(report));
    check('report: includes the recent log', /ECONNREFUSED/.test(report));

    ctrl.config.provider = 'ollama';
    check('report: a local provider is described as free, not as uncosted',
      /Cost estimate\s+n\/a — local models are free/.test(provider.buildDiagnosticsReport()));

    provider._logRing = [];
    check('report: an empty log says so rather than rendering an empty block',
      /Nothing logged yet/.test(provider.buildDiagnosticsReport()));

    // A report that cannot be built when things are badly broken is worthless,
    // and "badly broken" is exactly when it gets used.
    provider.projectRoot = '';
    let built = null;
    try { built = provider.buildDiagnosticsReport(); } catch { built = null; }
    check('report: still builds with no project open', typeof built === 'string' && /Project open\s+NO/.test(built));

    // ── The command has to be declared, or it does not exist. ─────────────
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    check('navy.exportDiagnostics is declared in the manifest',
      manifest.contributes.commands.some(c => c.command === 'navy.exportDiagnostics'));

    // ── The weekly eval must stay weekly. ─────────────────────────────────
    const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'eval.yml'), 'utf8');
    check('eval workflow: runs on a schedule and on demand',
      /schedule:/.test(wf) && /workflow_dispatch:/.test(wf));
    check('eval workflow: is NOT a pull-request gate — forks have no secrets and models are nondeterministic',
      !/^on:[\s\S]*?pull_request:/m.test(wf.split('jobs:')[0]));
    check('eval workflow: gates on regression, not on any failure', /--fail-on-regression/.test(wf));
    check('eval workflow: skips cleanly when no key is configured', /NAVY_EVAL_API_KEY is not set/.test(wf));
    const evalSrc = fs.readFileSync(path.join(__dirname, '..', 'eval', 'run.js'), 'utf8');
    check('eval harness: supports --fail-on-regression', /--fail-on-regression/.test(evalSrc));
    check('eval harness: a missing baseline is not treated as a regression', /baselineMissing/.test(evalSrc));
  } finally {
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { approvalCancelSuite, approvalScopeSuite, settingsDefaultsSuite, diagnosticsSuite };
