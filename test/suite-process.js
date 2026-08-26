const {
  fs, path, check, makeContext, sharedMock,
  queueOllamaFetch,
} = require('./harness.js');

// ── 6e. Command-execution sandboxing (navy.sandboxMode) ───────────────────
async function sandboxSuite() {
  console.log('\ncommand-execution sandboxing (navy.sandboxMode):');
  const os = require('os');
  const { vscode } = sharedMock();

  // Pure: stripJsonComments must not mistake a comment marker inside a quoted
  // string (e.g. a URL) for a real comment, and must strip real // and /* */
  // comments so devcontainer.json (which commonly has them) parses as JSON.
  {
    // Moved to src/sandbox.js, which is its only caller — imported rather than
    // source-extracted now that it is a real module export.
    const { stripJsonComments } = require('../src/sandbox.js');
    const withComments = '{\n  // a line comment\n  "image": "foo:latest", /* inline */\n  "url": "https://example.com" // trailing\n}';
    let parsed;
    check('stripJsonComments: result still parses as JSON', (() => { try { parsed = JSON.parse(stripJsonComments(withComments)); return true; } catch { return false; } })());
    check('stripJsonComments: real values survive', parsed?.image === 'foo:latest');
    check('stripJsonComments: "//" inside a quoted string is NOT treated as a comment', parsed?.url === 'https://example.com');
  }

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-sandbox-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    // sandboxMode 'off' (default) — must not even ask whether Docker is
    // available; a passthrough that touches Docker at all would add latency
    // to every command for the overwhelming majority of users who never
    // enable this.
    await vscode.workspace.getConfiguration().update('sandboxMode', 'off');
    let dockerAvailableCalled = false;
    provider._dockerAvailable = async () => { dockerAvailableCalled = true; return true; };
    const passthrough = await provider._maybeWrapForSandbox({ bin: 'echo', args: ['hi'], cwd: tmp, verbatim: false });
    check('sandboxMode off: bin/args/cwd returned completely unchanged',
      passthrough.bin === 'echo' && passthrough.args.length === 1 && passthrough.args[0] === 'hi' && passthrough.cwd === tmp);
    check('sandboxMode off: never even checks Docker availability', !dockerAvailableCalled);

    // sandboxMode 'docker' + Docker not available → refuses, never falls
    // back to running unsandboxed (that would be a false sense of safety).
    await vscode.workspace.getConfiguration().update('sandboxMode', 'docker');
    provider._dockerAvailable = async () => false;
    const noDocker = await provider._maybeWrapForSandbox({ bin: 'echo', args: ['hi'], cwd: tmp, verbatim: false });
    check('sandboxMode docker + Docker not running: refuses', noDocker.refused === true);
    check('sandboxMode docker + Docker not running: message is actionable', /Docker is not installed or not running/.test(noDocker.message));

    // sandboxMode 'docker' + Docker available but no devcontainer/Dockerfile
    // → refuses rather than guessing at a generic image.
    provider._dockerAvailable = async () => true;
    provider._resolveSandboxImage = async () => null;
    const noConfig = await provider._maybeWrapForSandbox({ bin: 'echo', args: ['hi'], cwd: tmp, verbatim: false });
    check('sandboxMode docker + no devcontainer/Dockerfile: refuses', noConfig.refused === true);
    check('sandboxMode docker + no devcontainer/Dockerfile: message names the missing config',
      /devcontainer\.json or Dockerfile/.test(noConfig.message));

    // sandboxMode 'docker' + an image resolved → rewrites the spawn target
    // to run inside it, with only the project folder mounted.
    provider._resolveSandboxImage = async () => ({ image: 'my-project-image' });
    const wrapped = await provider._maybeWrapForSandbox({ bin: 'bash', args: ['-c', 'echo hi'], cwd: tmp, verbatim: false });
    check('sandboxMode docker + image resolved: bin becomes docker', wrapped.bin === 'docker');
    // Docker Desktop's documented mount form uses forward slashes; a Windows
    // path is converted rather than passed with backslashes.
    const expectedMount = (process.platform === 'win32' ? tmp.replace(/\\/g, '/') : tmp) + ':/workspace';
    check('sandboxMode docker + image resolved: mounts exactly the project root read-write at /workspace',
      wrapped.args.includes('-v') && wrapped.args[wrapped.args.indexOf('-v') + 1] === expectedMount,
      wrapped.args[wrapped.args.indexOf('-v') + 1]);
    check('sandboxMode docker + image resolved: working directory is the mounted path',
      wrapped.args.includes('-w') && wrapped.args[wrapped.args.indexOf('-w') + 1] === '/workspace');
    check('sandboxMode docker + image resolved: uses the resolved image', wrapped.args.includes('my-project-image'));
    check('sandboxMode docker + image resolved: original bin/args are appended after the image',
      wrapped.args.slice(-3).join(' ') === 'bash -c echo hi');
    check('sandboxMode docker + image resolved: container is removed on exit (--rm)', wrapped.args.includes('--rm'));

    // ── The shell has to follow the EXECUTION TARGET, not the host ──
    // A Linux container has no cmd.exe, so building `cmd /c …` on a Windows
    // host produced a command that could only ever fail — the reason this
    // feature shipped documented as macOS/Linux only. These assertions hold on
    // every platform: on Linux they are trivially true, on Windows they are
    // the fix, and asserting them unconditionally is what stops the two
    // diverging again.
    check('sandbox: a sandboxed command targets POSIX regardless of host',
      provider._commandTargetIsPosix() === true);
    const sandboxedSpec = provider._shellSpec('echo hi');
    check('sandbox: …so the shell spec is sh -c, never cmd /c',
      sandboxedSpec.bin === 'sh' && sandboxedSpec.args[0] === '-c', sandboxedSpec.bin);
    check('sandbox: …and verbatim (a cmd.exe-only quoting mode) is off',
      sandboxedSpec.verbatim === false);
    check('sandbox: argument escaping switches to POSIX quoting too',
      provider._shellEscapeArg("it's") === "'it'\\''s'", provider._shellEscapeArg("it's"));

    const viaShell = await provider._maybeWrapForSandbox({ ...provider._shellSpec('npm test'), cwd: tmp });
    check('sandbox: the container is handed its own shell',
      viaShell.args.slice(-3).join(' ') === 'sh -c npm test', viaShell.args.slice(-3).join(' '));
    check('sandbox: no cmd.exe ever reaches the container', !viaShell.args.includes('cmd'));

    // …and turning sandboxing off must put the host's own shell straight back.
    await vscode.workspace.getConfiguration().update('sandboxMode', 'off');
    const hostSpec = provider._shellSpec('list things');
    check('sandbox off: the host shell is restored',
      process.platform === 'win32'
        ? hostSpec.bin === 'cmd' && hostSpec.verbatim === true
        : hostSpec.bin === 'sh' && hostSpec.verbatim === false,
      hostSpec.bin);
    await vscode.workspace.getConfiguration().update('sandboxMode', 'docker');

    // _spawnAndCollect must actually route through _maybeWrapForSandbox and
    // surface a refusal as its result — never silently spawn unsandboxed.
    provider._maybeWrapForSandbox = async () => ({ refused: true, message: 'REFUSED_FOR_TEST' });
    const spawnResult = await provider._spawnAndCollect('echo', ['hi'], tmp, 5000);
    check('_spawnAndCollect: a sandbox refusal is returned directly, nothing is spawned', spawnResult === 'REFUSED_FOR_TEST');

    // Real filesystem resolution (no Docker needed): a devcontainer.json that
    // declares "image" directly resolves without ever needing to build.
    delete provider._resolveSandboxImage; // restore the real implementation
    const dcDir = path.join(tmp, '.devcontainer');
    fs.mkdirSync(dcDir);
    fs.writeFileSync(path.join(dcDir, 'devcontainer.json'), '{\n  // comment devcontainer.json commonly has\n  "image": "node:20"\n}');
    const resolvedDirect = await provider._resolveSandboxImage(tmp);
    check('_resolveSandboxImage: devcontainer.json with "image" resolves directly (no build)', resolvedDirect?.image === 'node:20');

    // No devcontainer, no Dockerfile at all → null, not a guessed image.
    fs.rmSync(dcDir, { recursive: true, force: true });
    const resolvedNone = await provider._resolveSandboxImage(tmp);
    check('_resolveSandboxImage: no devcontainer/Dockerfile → null (never guesses a generic image)', resolvedNone === null);

    // ── _resolveSandboxImage caches per project root (a `docker build`
    // round-trip otherwise repeats before EVERY sandboxed command) —
    // invalidated by the config file's mtime, not just its presence.
    {
      fs.mkdirSync(dcDir, { recursive: true });
      fs.writeFileSync(path.join(dcDir, 'devcontainer.json'), '{"image": "node:20"}');

      let uncachedCalls = 0;
      const origUncached = provider._resolveSandboxImageUncached.bind(provider);
      provider._resolveSandboxImageUncached = async (root) => { uncachedCalls++; return origUncached(root); };

      const first = await provider._resolveSandboxImage(tmp);
      const second = await provider._resolveSandboxImage(tmp);
      check('_resolveSandboxImage: caches — a second call for the SAME unchanged project does not re-resolve',
        uncachedCalls === 1 && first?.image === 'node:20' && second?.image === 'node:20');

      // A real mtime change (not just content) must invalidate the cache.
      const newTime = new Date(Date.now() + 5000);
      fs.writeFileSync(path.join(dcDir, 'devcontainer.json'), '{"image": "node:22"}');
      fs.utimesSync(path.join(dcDir, 'devcontainer.json'), newTime, newTime);
      const third = await provider._resolveSandboxImage(tmp);
      check('_resolveSandboxImage: editing the devcontainer invalidates the cache',
        uncachedCalls === 2 && third?.image === 'node:22');

      provider._resolveSandboxImageUncached = origUncached;
      fs.rmSync(dcDir, { recursive: true, force: true });
    }

    // sandbox label suffix reflects the raw setting, shown in approval cards.
    await vscode.workspace.getConfiguration().update('sandboxMode', 'off');
    check('_sandboxLabelSuffix: empty when off', provider._sandboxLabelSuffix() === '');
    await vscode.workspace.getConfiguration().update('sandboxMode', 'docker');
    // Names the BACKEND now, not just the fact. With two of them, and one
    // materially weaker than the other, a card that said only 'sandboxed'
    // would be telling the user less than they need to approve the command.
    check('_sandboxLabelSuffix: names the backend when docker mode is set', provider._sandboxLabelSuffix() === ' (sandboxed: docker)');
  } catch (e) {
    check('sandbox suite ran', false, e.stack || e.message);
  } finally {
    await vscode.workspace.getConfiguration().update('sandboxMode', 'off');
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── Persistent background processes (navy.persistBackgroundProcesses) ──────
async function persistentBgProcessSuite() {
  console.log('\npersistent background processes (navy.persistBackgroundProcesses):');
  const os = require('os');
  const { spawn: nodeSpawn } = require('child_process');
  const { vscode, ctrl } = sharedMock();

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-bgpersist-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    // ── Task paths ──────────────────────────────────────────────────────────
    // A pid is not an identity: it is recycled, it means nothing after a
    // restart, and nobody recognises one. The task path does all three jobs —
    // it names the project and the task, it is the same string across windows,
    // and it is what a stop request refers to.
    const projectName = path.basename(tmp);
    check('task path names the project and the task',
      provider._taskPathFor(tmp, 'tsc-watch') === `navy/${projectName}/tsc-watch`,
      provider._taskPathFor(tmp, 'tsc-watch'));
    check('the dev server gets a name a person would recognise',
      provider._taskPathFor(tmp, '__run_project__') === `navy/${projectName}/dev-server`);
    const pathA = provider._taskPathFor(tmp, 'a');
    const pathB = provider._taskPathFor(tmp, 'a');
    check('the same task yields the same path every time',
      pathA === pathB && pathA.startsWith('navy/'), JSON.stringify(pathA));
    check('a name with separators in it cannot reshape the path',
      provider._taskPathFor(tmp, 'a/../b c').split('/').length === 3,
      provider._taskPathFor(tmp, 'a/../b c'));
    check('a project with no root still yields a usable path',
      provider._taskPathFor('', 'x') === 'navy/project/x');

    // ── Stopping a process this window never owned ──────────────────────────
    // Recovered rows are stopped BY PATH. The webview never names a pid, and
    // the record is re-verified as ours immediately before anything is
    // signalled — minutes can pass between the check that put it on screen and
    // the click, and a recycled pid must never be killed on Navy's say-so.
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    const bogus = `navy/${projectName}/ghost`;
    await provider._writeBgManifest(tmp, [
      { id: 'ghost', taskPath: bogus, pid: 999999, command: 'x', startedAt: Date.now(), kind: 'start_process' },
    ]);
    const note = await provider.stopRestoredProcess(tmp, bogus);
    check('stopping a dead record reports it rather than signalling anything',
      /already exited|no longer recorded/i.test(note), note);
    check('…and the record is dropped',
      (await provider._readBgManifest(tmp)).length === 0);
    check('…and the panel is told what is left',
      posted.some(m => m.type === 'restoredProcesses' && m.processes.length === 0));

    const unknown = await provider.stopRestoredProcess(tmp, `navy/${projectName}/never-existed`);
    check('an unknown task path is refused, not guessed at',
      /no longer recorded/i.test(unknown), unknown);

    // Off by default, and reflects the setting once toggled — this is the
    // gate every persist-mode branch below is behind.
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', false);
    check('_persistBgEnabled: off by default', provider._persistBgEnabled() === false);
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', true);
    check('_persistBgEnabled: true once the setting is turned on', provider._persistBgEnabled() === true);
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', false);

    // Manifest round-trip on the real filesystem (.navy/bg-processes.json).
    await provider._addToBgManifest(tmp, { id: 'a', pid: 111, command: 'cmd-a', startedAt: 1 });
    await provider._addToBgManifest(tmp, { id: 'b', pid: 222, command: 'cmd-b', startedAt: 2 });
    let manifest = await provider._readBgManifest(tmp);
    check('manifest: two added records both persisted to disk', manifest.length === 2);
    await provider._removeFromBgManifest(tmp, 111);
    manifest = await provider._readBgManifest(tmp);
    check('manifest: removeFromBgManifest drops only the matching pid', manifest.length === 1 && manifest[0].pid === 222);
    check('manifest: file actually exists on disk at .navy/bg-processes.json', fs.existsSync(path.join(tmp, '.navy', 'bg-processes.json')));
    await provider._writeBgManifest(tmp, []); // reset for later tests

    // _pidAlive: true for a pid that definitely exists (this test process
    // itself), false for one that has genuinely already exited.
    check('_pidAlive: true for this process\'s own pid', provider._pidAlive(process.pid) === true);
    const shortLived = nodeSpawn('node', ['-e', ''], { cwd: tmp });
    const deadPid = await new Promise(res => shortLived.on('exit', () => res(shortLived.pid)));
    check('_pidAlive: false for a pid that has already exited', provider._pidAlive(deadPid) === false);

    // _disposeSession must NEVER kill a persist:true entry (that's the whole
    // point of the setting) but must still kill an ordinary one — the single
    // most safety-critical invariant of this feature.
    {
      const killed = [];
      provider._killProcessTree = (proc) => killed.push(proc.pid);
      const fakeSession = {
        _heartbeat: undefined, _watchdog: undefined, _cpSaveTimer: undefined,
        bgProcesses: new Map([
          ['persisted', { proc: { pid: 9001, killed: false }, persist: true }],
          ['ordinary', { proc: { pid: 9002, killed: false }, persist: false }],
        ]),
        bgWorkers: new Map(),
      };
      provider._disposeSession(fakeSession);
      check('_disposeSession: a persist:true entry is left running, never killed', !killed.includes(9001));
      check('_disposeSession: an ordinary (non-persist) entry is still killed as before', killed.includes(9002));
    }
    delete provider._killProcessTree; // restore the real implementation for what follows

    // toolStartProcess/toolRunProject always run the command through
    // `cmd /c <string>` on Windows (existing, unrelated behavior — unchanged
    // by this feature). cmd.exe's own argument parsing mishandles a string
    // with quotes NESTED inside its outer quoting (verified directly: `cmd
    // /c "node -e \"console.log(1)\""` silently produces no output at all)
    // — a real, pre-existing Windows quirk of the shell-string path itself,
    // not something this feature changes. Sidestep it in these tests the
    // same way a real script would: write the code to a file with no spaces
    // in its path and run `node <path>`, so no quoting is needed at all.
    const writeNodeScript = (name, code) => {
      const p = path.join(tmp, name);
      fs.writeFileSync(p, code);
      return `node ${p}`;
    };

    // ── Real end-to-end: persist mode ON ──────────────────────────────────
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', true);
    ctrl.config.commandApproval = 'auto-approve'; // start_process is an EXECUTION gate
    const marker = 'BGPERSIST_MARKER_' + Date.now();
    const startResult = await provider.toolStartProcess('logger', writeNodeScript('logger.js', `console.log('${marker}');`));
    check('toolStartProcess (persist on): reports detached + survives-reload', /detached/.test(startResult) && /survive a window reload/.test(startResult));
    const entry = provider.bgProcesses.get('logger');
    check('toolStartProcess (persist on): entry is marked persist:true', entry?.persist === true);
    check('toolStartProcess (persist on): entry has a real logPath', typeof entry?.logPath === 'string' && entry.logPath.length > 0);

    manifest = await provider._readBgManifest(tmp);
    check('toolStartProcess (persist on): manifest gained a record for it', manifest.some(r => r.id === 'logger' && r.pid === entry.pid));

    // Wait for the real child to actually finish and write its output.
    for (let i = 0; i < 50 && provider.bgProcesses.get('logger')?.proc; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    check('toolStartProcess (persist on): the real process actually exited on its own', provider.bgProcesses.get('logger')?.proc == null);

    const readBack = await provider.toolReadProcessOutput('logger');
    check('toolReadProcessOutput (persist on): reads the real log file, containing the marker', readBack.includes(marker));
    check('toolReadProcessOutput (persist on): labels the output as persisted', /persisted — logged to/.test(readBack));

    manifest = await provider._readBgManifest(tmp);
    check('toolStartProcess (persist on): manifest entry removed once the process exits naturally', !manifest.some(r => r.id === 'logger'));

    // ── readFileTail: a genuinely large log returns just the tail, not the ──
    // whole file (the actual fix — a synchronous full-file read scales with
    // how much a chatty dev server has ever logged, not with what's asked for).
    {
      const bigLogPath = path.join(tmp, 'big-tail-test.log');
      const headMarker = 'HEAD_MARKER_SHOULD_NOT_APPEAR_IN_TAIL';
      const filler = 'x'.repeat(50000);
      const tailMarker = 'TAIL_MARKER_' + Date.now();
      fs.writeFileSync(bigLogPath, headMarker + filler + filler + filler + filler + tailMarker); // ~200KB, distinct markers at each end
      // Exported from src/commands.js since the extraction. No longer worth
      // eval'ing out of source now that it lives in a module small enough to
      // require directly — and requiring the real thing is stronger than
      // reconstructing it.
      const { readFileTail } = require('../src/commands.js');
      const tail = readFileTail(bigLogPath, 100);
      check('readFileTail: returns a bounded slice, not the whole (~200KB) file', tail.length <= 100);
      check('readFileTail: the slice is the REAL tail — contains the marker at the very end', tail.includes(tailMarker));
      check('readFileTail: does not contain the marker from the start of the file', !tail.includes(headMarker));
      try { fs.rmSync(bigLogPath, { force: true }); } catch {}
    }

    // ── Real end-to-end: persist mode OFF (default) — unchanged behavior ──
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', false);
    const marker2 = 'NOPERSIST_MARKER_' + Date.now();
    await provider.toolStartProcess('logger2', writeNodeScript('logger2.js', `console.log('${marker2}');`));
    const entry2 = provider.bgProcesses.get('logger2');
    check('toolStartProcess (persist off): entry has no persist flag', !entry2?.persist);
    check('toolStartProcess (persist off): entry has no logPath (uses the in-memory buffer as before)', !entry2?.logPath);
    for (let i = 0; i < 50 && provider.bgProcesses.get('logger2')?.proc; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    const readBack2 = await provider.toolReadProcessOutput('logger2');
    check('toolReadProcessOutput (persist off): still reads the live in-memory buffer, not a log file', readBack2.includes(marker2) && !/persisted/.test(readBack2));

    // ── toolKillProcess on a persisted entry also cleans the manifest ─────
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', true);
    await provider.toolStartProcess('longrun', writeNodeScript('longrun.js', 'setInterval(()=>{}, 1000);'));
    const longEntry = provider.bgProcesses.get('longrun');
    manifest = await provider._readBgManifest(tmp);
    check('toolKillProcess setup: long-running persisted process is in the manifest before killing', manifest.some(r => r.id === 'longrun'));
    const killMsg = await provider.toolKillProcess('longrun');
    check('toolKillProcess: reports success', /killed/i.test(killMsg));
    manifest = await provider._readBgManifest(tmp);
    check('toolKillProcess: removes the persisted entry from the manifest too, not just bgProcesses', !manifest.some(r => r.id === 'longrun'));
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', false);

    // ── _withBgManifestLock genuinely serializes concurrent callers for the
    // SAME project (sibling chat tabs can legitimately start/stop persisted
    // processes at the same time — this is the actual fix for the lost-
    // update race review found). Proven via ordering markers, same
    // deterministic style as the global-catalog lock's own test.
    await provider._writeBgManifest(tmp, []);
    {
      const order = [];
      const p1 = provider._withBgManifestLock(tmp, async () => {
        order.push('1-start');
        await new Promise(r => setTimeout(r, 30));
        order.push('1-end');
      });
      const p2 = provider._withBgManifestLock(tmp, async () => {
        order.push('2-start');
        order.push('2-end');
      });
      await Promise.all([p1, p2]);
      check('_withBgManifestLock: a second caller never starts before the first finishes',
        order.join(',') === '1-start,1-end,2-start,2-end');
    }

    // A DIFFERENT project's lock must be independent — one project's slow
    // manifest write must never delay an unrelated project's.
    {
      const tmpOther = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-bgpersist-other-'));
      const order = [];
      const pSlow = provider._withBgManifestLock(tmp, async () => {
        order.push('tmp-start');
        await new Promise(r => setTimeout(r, 40));
        order.push('tmp-end');
      });
      const pOther = provider._withBgManifestLock(tmpOther, async () => {
        order.push('other-start');
        order.push('other-end');
      });
      await Promise.all([pSlow, pOther]);
      check('_withBgManifestLock: a different project is not serialized behind this one',
        order.indexOf('other-start') < order.indexOf('tmp-end'));
      try { fs.rmSync(tmpOther, { recursive: true, force: true }); } catch {}
    }

    // ── _addToBgManifest: concurrent calls for the SAME project must not
    // lose either record — the actual bug found in review.
    {
      await provider._writeBgManifest(tmp, []);
      await Promise.all([
        provider._addToBgManifest(tmp, { id: 'concurrent-a', pid: 111111, command: 'a', startedAt: 1 }),
        provider._addToBgManifest(tmp, { id: 'concurrent-b', pid: 222222, command: 'b', startedAt: 2 }),
      ]);
      const concurrentManifest = await provider._readBgManifest(tmp);
      check('_addToBgManifest: two concurrent adds to the same project both survive',
        concurrentManifest.some(r => r.id === 'concurrent-a') && concurrentManifest.some(r => r.id === 'concurrent-b'));
    }

    // ── _checkOrphanedBgProcesses: the "found leftovers from last time" flow ─
    {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-bgpersist-orphan-'));
      // startedAt must be the REAL spawn time, exactly as production records
      // it: _classifyBgRecord verifies the pid's actual start time against it
      // so a recycled pid is never mistaken for ours (and never killed).
      const aliveStartedAt = Date.now();
      const stillAlive = nodeSpawn('node', ['-e', 'setInterval(()=>{}, 1000)'], { cwd: tmp2 });
      await new Promise(r => setTimeout(r, 100)); // let it actually start
      const alreadyDead = nodeSpawn('node', ['-e', ''], { cwd: tmp2 });
      const deadPid2 = await new Promise(res => alreadyDead.on('exit', () => res(alreadyDead.pid)));

      await provider._writeBgManifest(tmp2, [
        { id: 'alive-one', pid: stillAlive.pid, command: 'sleeper', startedAt: aliveStartedAt },
        { id: 'dead-one', pid: deadPid2, command: 'gone', startedAt: aliveStartedAt },
      ]);

      const killedPids = [];
      provider._killPidTree = (pid) => killedPids.push(pid);
      ctrl.shown.warning = [];
      ctrl.nextWarning = 'Stop All';
      await provider._checkOrphanedBgProcesses(tmp2);

      check('_checkOrphanedBgProcesses: prompts exactly once, naming the survivor', ctrl.shown.warning.length === 1 && /alive-one/.test(ctrl.shown.warning[0]));
      check('_checkOrphanedBgProcesses: the already-dead entry is silently pruned, never named in the prompt', !/dead-one/.test(ctrl.shown.warning[0] || ''));
      check('_checkOrphanedBgProcesses: "Stop All" kills the surviving pid', killedPids.includes(stillAlive.pid));
      const manifestAfter = await provider._readBgManifest(tmp2);
      check('_checkOrphanedBgProcesses: manifest is emptied after Stop All', manifestAfter.length === 0);
      // _killPidTree was stubbed above to observe the call without a real kill —
      // stillAlive's setInterval never clears on its own, so it must be reaped
      // for real here or it outlives this whole test process.
      try { process.kill(stillAlive.pid); } catch {}

      // Re-checking the SAME root this window must not prompt again.
      await provider._writeBgManifest(tmp2, [{ id: 'again', pid: process.pid, command: 'x', startedAt: 1 }]);
      ctrl.shown.warning = [];
      await provider._checkOrphanedBgProcesses(tmp2);
      check('_checkOrphanedBgProcesses: does not re-prompt for a root already checked this window', ctrl.shown.warning.length === 0);

      // "Leave Running" leaves the manifest and the process alone.
      const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-bgpersist-orphan2-'));
      const alive2StartedAt = Date.now();
      const stillAlive2 = nodeSpawn('node', ['-e', 'setInterval(()=>{}, 1000)'], { cwd: tmp3 });
      await new Promise(r => setTimeout(r, 100));
      await provider._writeBgManifest(tmp3, [{ id: 'keep-me', pid: stillAlive2.pid, command: 'sleeper', startedAt: alive2StartedAt }]);
      const killedPids2 = [];
      provider._killPidTree = (pid) => killedPids2.push(pid);
      ctrl.nextWarning = 'Leave Running';
      await provider._checkOrphanedBgProcesses(tmp3);
      check('_checkOrphanedBgProcesses: "Leave Running" kills nothing', killedPids2.length === 0);
      const manifestAfter3 = await provider._readBgManifest(tmp3);
      check('_checkOrphanedBgProcesses: "Leave Running" keeps the manifest entry', manifestAfter3.length === 1);

      delete provider._killPidTree;
      try { process.kill(stillAlive2.pid); } catch {}

      // ── PID reuse: a live pid whose start time does NOT match the record is
      // a DIFFERENT process that inherited the number. It must never be
      // killed — this gate sits directly in front of `taskkill /F /T`.
      {
        const startedNow = Date.now();
        const impostor = nodeSpawn('node', ['-e', 'setInterval(()=>{}, 1000)'], { cwd: tmp3 });
        await new Promise(r => setTimeout(r, 100));
        check('_classifyBgRecord: matching start time → "ours"',
          (await provider._classifyBgRecord({ pid: impostor.pid, startedAt: startedNow })) === 'ours');
        check('_classifyBgRecord: recycled pid (start time far off) → "gone", never killed',
          (await provider._classifyBgRecord({ pid: impostor.pid, startedAt: startedNow - 86400000 })) === 'gone');
        check('_classifyBgRecord: legacy record with no startedAt → "unverified", never killed',
          (await provider._classifyBgRecord({ pid: impostor.pid })) === 'unverified');
        check('_classifyBgRecord: a pid that is simply gone → "gone"',
          (await provider._classifyBgRecord({ pid: deadPid2, startedAt: startedNow })) === 'gone');

        // An unverifiable-but-live record is reported, kept in the manifest,
        // and left strictly alone — dropping it would leak a real orphan.
        const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-bgpersist-orphan3-'));
        await provider._writeBgManifest(tmp4, [{ id: 'legacy', pid: impostor.pid, command: 'legacy-entry' }]);
        const killedPids3 = [];
        provider._killPidTree = (pid) => killedPids3.push(pid);
        ctrl.shown.warning = [];
        ctrl.nextWarning = 'Stop All'; // even if the user would say yes, there is nothing to say yes TO
        await provider._checkOrphanedBgProcesses(tmp4);
        check('_checkOrphanedBgProcesses: an unverifiable live record is never killed', killedPids3.length === 0);
        check('_checkOrphanedBgProcesses: it is reported rather than silently ignored',
          ctrl.shown.warning.length === 1 && /could not verify/.test(ctrl.shown.warning[0]));
        check('_checkOrphanedBgProcesses: an unverifiable record stays in the manifest',
          (await provider._readBgManifest(tmp4)).length === 1);
        delete provider._killPidTree;
        try { process.kill(impostor.pid); } catch {}
        try { fs.rmSync(tmp4, { recursive: true, force: true }); } catch {}
      }

      try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(tmp3, { recursive: true, force: true }); } catch {}
    }
  } catch (e) {
    check('persistent background process suite ran', false, e.stack || e.message);
  } finally {
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', false);
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// navy.shell. Windows used to mean cmd.exe with no way out, even though VS
// Code's own default terminal there is PowerShell — the cost showed up as a
// whole system-prompt rule arguing the model out of the syntax it reasonably
// assumed. These pin that the setting really reaches all three things that have
// to agree (the spawn, the escaping dialect, and what the model is told), that
// "auto" changes nothing, and that the sandbox still overrides all of it.
async function shellSelectionSuite() {
  console.log('\nnavy.shell (which shell, which dialect):');
  const os = require('os');
  const { ctrl } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  const isWin = process.platform === 'win32';
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-shell-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider.view = { webview: { postMessage: () => {} } };
    provider._wslCache = { available: false };
    ctrl.config.commandApproval = 'auto-approve';
    ctrl.config.sandboxMode = 'off';

    // ── "auto" is the platform default, unchanged. ─────────────────────────
    ctrl.config.shell = 'auto';
    const autoSpec = provider._shellSpec('echo hi');
    check('shell auto: the platform default, exactly as before',
      isWin ? (autoSpec.bin === 'cmd' && autoSpec.args[0] === '/c' && autoSpec.verbatim === true)
            : (autoSpec.bin === 'sh' && autoSpec.args[0] === '-c' && autoSpec.verbatim === false), autoSpec.bin);
    check('shell auto: posix-ness matches the platform', provider._commandTargetIsPosix() === !isWin);

    // ── PowerShell: its own spawn shape, and NOT cmd.exe's verbatim mode. ──
    ctrl.config.shell = 'powershell';
    const psSpec = provider._shellSpec('npm test');
    check('shell powershell: spawns powershell', psSpec.bin === 'powershell');
    check('shell powershell: -NoProfile and -NonInteractive are not optional',
      psSpec.args.includes('-NoProfile') && psSpec.args.includes('-NonInteractive'));
    check('shell powershell: the command is passed to -Command',
      psSpec.args[psSpec.args.indexOf('-Command') + 1].startsWith('npm test'));
    // The subtle one: without this, powershell.exe reports 0 after a native
    // program that failed, and the tool loop reads "Exit code:" to decide
    // whether to tell the model its command worked.
    check('shell powershell: the exit code of the last native command is propagated',
      /\nexit \$LASTEXITCODE$/.test(psSpec.args[psSpec.args.indexOf('-Command') + 1]));
    check('shell powershell: verbatim (a cmd.exe-only mode) stays off', psSpec.verbatim === false);
    check('shell powershell: escaping switches to PowerShell quoting',
      provider._shellEscapeArg("it's") === "'it''s'", provider._shellEscapeArg("it's"));
    check('shell powershell: is not treated as POSIX', provider._commandTargetIsPosix() === false);

    ctrl.config.shell = 'pwsh';
    check('shell pwsh: spawns pwsh, same flags', provider._shellSpec('x').bin === 'pwsh' && provider._shellSpec('x').args.includes('-NoProfile'));

    // The 'that program is not installed' nudge hands the model a probe command
    // verbatim, so it has to follow navy.shell too — telling a PowerShell
    // session to run 'where' wastes the retry the nudge exists to save.
    ctrl.config.shell = 'powershell';
    check('probe hint: PowerShell gets Get-Command', provider._resolveShell().probe === 'Get-Command <tool>');
    ctrl.config.shell = 'cmd';
    check('probe hint: cmd.exe gets where', provider._resolveShell().probe === 'where <tool>');
    ctrl.config.shell = 'sh';
    check('probe hint: sh gets command -v', provider._resolveShell().probe === 'command -v <tool>');

    // ── bash is available as an explicit choice on every platform. ─────────
    ctrl.config.shell = 'bash';
    const bashSpec = provider._shellSpec('ls');
    check('shell bash: sh-style invocation and POSIX escaping',
      bashSpec.bin === 'bash' && bashSpec.args[0] === '-c' && bashSpec.verbatim === false &&
      provider._shellEscapeArg("it's") === "'it'\\''s'");

    // ── A hand-edited nonsense value must not spawn something that isn't
    //    there — that would fail every command with a confusing ENOENT. ─────
    ctrl.config.shell = 'fish-but-not-really';
    check('shell unknown: falls back to the platform default',
      provider._shellSpec('x').bin === (isWin ? 'cmd' : 'sh'));

    // ── The container still wins over the setting. ─────────────────────────
    ctrl.config.shell = 'powershell';
    ctrl.config.sandboxMode = 'docker';
    const sandboxed = provider._shellSpec('echo hi');
    check('sandbox overrides navy.shell: the container gets sh, never powershell',
      sandboxed.bin === 'sh' && sandboxed.args[0] === '-c' && sandboxed.verbatim === false, sandboxed.bin);
    check('sandbox overrides navy.shell: escaping goes back to POSIX',
      provider._shellEscapeArg("it's") === "'it'\\''s'");
    ctrl.config.sandboxMode = 'off';

    // ── The model is told which shell it is actually writing for. ──────────
    const captured = [];
    ctrl.config.shell = 'powershell';
    global.fetch = queueOllamaFetch([{ text: 'Nothing to do.' }], captured);
    await provider.askNavy('hello', false, null, [], []);
    const psPrompt = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('prompt: names PowerShell as the shell when that is what will run',
      /run_command executes through: Windows PowerShell/.test(psPrompt) && /\$env:VAR/.test(psPrompt), psPrompt.slice(0, 0));
    check('prompt: does not still insist on cmd.exe syntax under PowerShell',
      !/NOT PowerShell/.test(psPrompt));

    captured.length = 0;
    ctrl.config.shell = 'auto';
    global.fetch = queueOllamaFetch([{ text: 'Nothing to do.' }], captured);
    await provider.askNavy('hello', false, null, [], []);
    const autoPrompt = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('prompt: auto still describes the platform shell',
      isWin ? /run_command executes through: cmd\.exe/.test(autoPrompt) && /NOT PowerShell/.test(autoPrompt)
            : /run_command executes through: sh/.test(autoPrompt));
    global.fetch = realFetch;

    // ── Real execution through a non-default shell. Only where that shell
    //    actually exists: PowerShell on Windows, bash on POSIX. ─────────────
    const altShell = isWin ? 'powershell' : 'bash';
    if (await provider._commandAvailable(altShell)) {
      ctrl.config.shell = altShell;
      const printer = path.join(tmp, 'print-argv.js');
      fs.writeFileSync(printer, 'console.log("ARGV:" + JSON.stringify(process.argv.slice(2)));');

      for (const value of ["it's here", 'foo bar', 'a;echo PWNED', '$(id)', 'x&y']) {
        const out = await provider.toolRunCommand('node print-argv.js ' + provider._shellEscapeArg(value), 20000);
        const m = out.match(/ARGV:(\[.*\])/);
        let argv = null; try { argv = JSON.parse(m[1]); } catch {}
        check(`shell ${altShell}: _shellEscapeArg round-trips ${JSON.stringify(value)} as one literal argument`,
          Array.isArray(argv) && argv.length === 1 && argv[0] === value, out.slice(0, 200));
      }

      // A failing program has to be reported as failing. This is the whole
      // reason PS_ARGS appends an explicit exit.
      const failed = await provider.toolRunCommand('node -e "process.exit(3)"', 20000);
      check(`shell ${altShell}: a non-zero exit code survives the shell wrapper`,
        /^Exit code: 3/.test(failed), failed.slice(0, 200));
      const ok = await provider.toolRunCommand('node -e "process.exit(0)"', 20000);
      check(`shell ${altShell}: a successful command still reports 0`, /^Exit code: 0/.test(ok), ok.slice(0, 200));
    } else {
      console.log(`  SKIP ${altShell} round-trip — not installed on this machine`);
    }
  } finally {
    global.fetch = realFetch;
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// Two limitations that turned out to be scope decisions rather than facts of
// nature: sandboxing was Docker-or-nothing, and search_files' fallback was a
// shallow walk that reported "No matches" in a voice indistinguishable from
// ripgrep's.
async function nativeSandboxSuite() {
  console.log('\nnative sandboxing + honest search fallback:');
  const os = require('os');
  const { ctrl } = sharedMock();
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-native-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    // ── The policy, which is the part worth pinning: it is built once and
    //    rendered twice, so macOS and Linux cannot protect different things. ──
    const denied = provider._nativeDenyReadPaths();
    for (const store of ['.ssh', '.aws', '.gnupg', '.kube', '.netrc']) {
      check(`native: ${store} is unreadable`, denied.some(p => p.endsWith(store) || p.includes(store + path.sep)), store);
    }
    // A sandbox that breaks the build gets switched off, which protects
    // nothing — so these two stay readable on purpose.
    check('native: ~/.npmrc is NOT denied — package installs need it',
      !denied.some(p => p.endsWith('.npmrc')));
    check('native: ~/.gitconfig is NOT denied — git needs it',
      !denied.some(p => p.endsWith('.gitconfig')));

    const profile = provider._seatbeltProfile('/proj', '/tmp/x');
    check('seatbelt: allows by default, then takes writes away',
      /\(allow default\)/.test(profile) && /\(deny file-write\*\)/.test(profile));
    check('seatbelt: hands back the project and temp, in that order after the deny',
      profile.indexOf('(deny file-write*)') < profile.indexOf('(allow file-write* (subpath "/proj")'), profile);
    check('seatbelt: /dev stays writable, or nothing can print',
      /\(subpath "\/dev"\)/.test(profile));
    check('seatbelt: the credential stores are denied for READ, not just write',
      /\(deny file-read\*/.test(profile) && /\.ssh/.test(profile));
    check('seatbelt: a quote in a path cannot break out of the profile',
      /\\"/.test(provider._seatbeltProfile('/a"b', '/tmp')), provider._seatbeltProfile('/a"b', '/tmp'));

    const bwrap = provider._bubblewrapArgs('/proj', '/tmp/x');
    check('bubblewrap: everything readable, nothing writable by default',
      bwrap.join(' ').includes('--ro-bind / /'));
    check('bubblewrap: the project and temp are bound read-write',
      bwrap.join(' ').includes('--bind /proj /proj') && bwrap.join(' ').includes('--bind /tmp/x /tmp/x'));
    check('bubblewrap: credential stores are masked with an empty tmpfs',
      denied.every(p => bwrap.includes(p) && bwrap[bwrap.indexOf(p) - 1] === '--tmpfs'));
    check('bubblewrap: dies with its parent, so a sandboxed child cannot outlive Navy',
      bwrap.includes('--die-with-parent'));

    // ── Never silently unsandboxed. ──────────────────────────────────────
    ctrl.config.sandboxMode = 'native';
    const spec = { bin: 'sh', args: ['-c', 'echo hi'], cwd: tmp, verbatim: false };
    const wrapped = await provider._maybeWrapForSandbox(spec);
    if (process.platform === 'win32') {
      check('native on Windows: refused, never run unsandboxed',
        wrapped.refused === true && /Windows has no sandbox Navy can drive/.test(wrapped.message), JSON.stringify(wrapped));
      check('native on Windows: the refusal names the way out', /"docker"/.test(wrapped.message));
      // A bare 'not supported' reads as Navy not having bothered. It names the
      // two things that were actually considered and why each fails.
      check('native on Windows: the refusal explains why, not just that',
        /Windows Sandbox/.test(wrapped.message) && /AppContainer/.test(wrapped.message), wrapped.message);

      // Failing closed is right; finding out one failed command at a time is
      // not. Setting it must say so immediately, and offer the way out.
      ctrl.nextWarning = 'Use Docker';
      provider._warnedSandboxUnavailable = undefined;
      ctrl.shown.warning.length = 0;
      await provider.warnIfSandboxUnavailable();
      check('native on Windows: warns when the setting is CHANGED, not per command',
        ctrl.shown.warning.length === 1 && /no support for/.test(ctrl.shown.warning[0]), JSON.stringify(ctrl.shown.warning));
      check('native on Windows: …and the offered fix is applied', ctrl.config.sandboxMode === 'docker');
      ctrl.shown.warning.length = 0;
      await provider.warnIfSandboxUnavailable();
      check('native on Windows: does not nag once it has been said', ctrl.shown.warning.length === 0);
      ctrl.config.sandboxMode = 'native';
    } else {
      const expected = process.platform === 'darwin' ? 'sandbox-exec' : 'bwrap';
      check(`native on ${process.platform}: wrapped with ${expected}, or refused if it is missing`,
        wrapped.refused === true || wrapped.bin === expected, JSON.stringify(wrapped).slice(0, 160));
      if (!wrapped.refused) {
        check('native: the original command survives at the end of the argv',
          wrapped.args.slice(-2).join(' ') === '-c echo hi', wrapped.args.slice(-3).join(' '));
        check('native: verbatim stays off — this is a direct argv spawn', wrapped.verbatim === false);
      }
    }

    // Native wraps the HOST's shell, so unlike docker it must NOT rewrite the
    // dialect the model is told to write.
    //
    // navy.shell is set explicitly rather than assumed: ctrl.reset() does not
    // clear ctrl.config, so shellSelectionSuite — which runs just before this
    // one — leaves its last choice behind. That is the cross-suite leakage the
    // runner's header warns about, felt from the inside.
    ctrl.config.shell = 'auto';
    check('native does not pretend the command is bound for Linux',
      provider._resolveShell().id === (process.platform === 'win32' ? 'cmd' : 'sh'));
    check('native is labelled distinctly on the approval card',
      provider._sandboxLabelSuffix() === ' (sandboxed: native)');
    ctrl.config.sandboxMode = 'docker';
    check('docker is still labelled too', provider._sandboxLabelSuffix() === ' (sandboxed: docker)');
    ctrl.config.sandboxMode = 'off';
    check('off is labelled not at all', provider._sandboxLabelSuffix() === '');

    // The manifest has to offer it, or the mode is unreachable.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const decl = manifest.contributes.configuration.properties['navy.sandboxMode'];
    check('navy.sandboxMode offers native', decl.enum.includes('native'));
    check('…and every mode is described', decl.enum.length === decl.enumDescriptions.length);
    check('…and the description admits the network is not restricted',
      /network is NOT restricted/i.test(decl.enumDescriptions[decl.enum.indexOf('native')]));

    // ── The search fallback tells the truth about itself. ────────────────
    // Forced onto the JS path by making ripgrep unfindable.
    provider._rgPath = null;
    fs.mkdirSync(path.join(tmp, 'a', 'b', 'c', 'd', 'e'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'a', 'b', 'c', 'd', 'e', 'deep.js'), 'const NEEDLE = 1;');
    fs.writeFileSync(path.join(tmp, 'shallow.js'), 'const NEEDLE = 2;');

    const found = await provider.toolSearchFiles('NEEDLE');
    check('fallback: reaches past the old depth-2 ceiling', /deep\.js/.test(found), found.slice(0, 300));
    check('fallback: says it was not ripgrep', /ripgrep unavailable/.test(found));
    check('fallback: warns that it may have missed matches', /may be matches this pass did not reach/.test(found));

    const none = await provider.toolSearchFiles('STRING_THAT_IS_NOT_THERE_ANYWHERE');
    check('fallback: a miss is explicitly NOT proof of absence',
      /NOT proof the text is absent/.test(none), none.slice(0, 200));
    check('fallback: …and suggests what to do instead', /search_codebase|read the likely file/.test(none));

    // Binary content must not be searched as text.
    fs.writeFileSync(path.join(tmp, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x4e, 0x45, 0x45, 0x44, 0x4c, 0x45]));
    const afterBinary = await provider.toolSearchFiles('NEEDLE');
    check('fallback: binary files are skipped, not reported as line matches',
      !/blob\.bin/.test(afterBinary), afterBinary.slice(0, 200));

    // The bigger skip list is the shared one, so build output is not searched.
    fs.mkdirSync(path.join(tmp, 'target'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'target', 'gen.js'), 'const NEEDLE = 3;');
    const afterBuildDir = await provider.toolSearchFiles('NEEDLE');
    check('fallback: build output directories are skipped', !/target/.test(afterBuildDir), afterBuildDir.slice(0, 200));
  } finally {
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// Windows has no native backend, so Docker is its only sandbox — and Docker was
// reachable only by projects that already carried a devcontainer, which most do
// not. That second barrier was Navy's own rule, not the platform's: "will not
// guess an image" and "will not accept an answer" are different things, and
// conflating them left most Windows users with no sandbox available at all.
async function sandboxImageSuite() {
  console.log('\nnavy.sandboxImage (the second Windows barrier):');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-simg-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider._dockerAvailable = async () => true;
    await vscode.workspace.getConfiguration().update('sandboxMode', 'docker');

    // ── Still refuses when nothing is configured. The rule is intact. ──────
    provider._offeredSandboxImage = true; // suppress the modal for this check
    ctrl.config.sandboxImage = '';
    let r = await provider._maybeWrapForSandbox({ bin: 'sh', args: ['-c', 'x'], cwd: tmp, verbatim: false });
    check('no devcontainer and no setting: still refused, never guessed',
      r.refused === true && /will not guess/.test(r.message));
    check('…and the refusal now names the setting that fixes it',
      /navy\.sandboxImage/.test(r.message), r.message);

    // ── An image the user named is an answer, so it is used. ─────────────
    ctrl.config.sandboxImage = 'node:20';
    r = await provider._maybeWrapForSandbox({ bin: 'sh', args: ['-c', 'x'], cwd: tmp, verbatim: false });
    check('a configured image is used when the project has none',
      r.refused !== true && r.args.includes('node:20'), JSON.stringify(r).slice(0, 140));
    check('…and the command still runs inside it',
      r.bin === 'docker' && r.args.slice(-3).join(' ') === 'sh -c x');

    // ── A project that carries its own config still wins. ────────────────
    fs.mkdirSync(path.join(tmp, '.devcontainer'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.devcontainer', 'devcontainer.json'), '{ "image": "project-owned:1" }');
    r = await provider._maybeWrapForSandbox({ bin: 'sh', args: ['-c', 'x'], cwd: tmp, verbatim: false });
    check('the project\'s own devcontainer beats the setting',
      r.args.includes('project-owned:1') && !r.args.includes('node:20'), JSON.stringify(r.args).slice(0, 160));
    fs.rmSync(path.join(tmp, '.devcontainer'), { recursive: true, force: true });

    // ── Changing the setting takes effect immediately. ───────────────────
    // The resolution is cached on the two config files' mtimes; without the
    // setting in that key, editing it would appear to do nothing until one of
    // those files happened to change.
    ctrl.config.sandboxImage = 'python:3.12';
    r = await provider._maybeWrapForSandbox({ bin: 'sh', args: ['-c', 'x'], cwd: tmp, verbatim: false });
    check('changing the setting is not masked by the resolution cache',
      r.args.includes('python:3.12'), JSON.stringify(r.args).slice(0, 160));

    // ── Malformed input must not reach a docker argv. ────────────────────
    ctrl.config.sandboxImage = 'node 20';   // a space cannot be an image ref
    r = await provider._maybeWrapForSandbox({ bin: 'sh', args: ['-c', 'x'], cwd: tmp, verbatim: false });
    check('an image with whitespace is rejected, not spliced into the argv',
      r.refused === true, JSON.stringify(r).slice(0, 120));
    ctrl.config.sandboxImage = '   ';
    r = await provider._maybeWrapForSandbox({ bin: 'sh', args: ['-c', 'x'], cwd: tmp, verbatim: false });
    check('a blank setting is treated as unset', r.refused === true);

    // ── The suggestion is derived from the project, and only suggested. ───
    check('suggests nothing for a project it does not recognise',
      provider._suggestSandboxImage(tmp) === '');
    for (const [file, expected] of [
      ['package.json', 'node:20'], ['requirements.txt', 'python:3.12'],
      ['go.mod', 'golang:1.22'], ['Cargo.toml', 'rust:1'], ['Gemfile', 'ruby:3.3'],
    ]) {
      const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-sugg-'));
      fs.writeFileSync(path.join(probe, file), '');
      check(`suggests ${expected} for a project with ${file}`,
        provider._suggestSandboxImage(probe) === expected, provider._suggestSandboxImage(probe));
      fs.rmSync(probe, { recursive: true, force: true });
    }

    // ── The offer: asked once, and its answer is stored per-workspace. ────
    ctrl.config.sandboxImage = '';
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    provider._offeredSandboxImage = false;
    ctrl.nextWarning = 'Use node:20';
    await provider.offerSandboxImage(tmp);
    check('the offer applies the suggestion the user accepted', ctrl.config.sandboxImage === 'node:20');
    check('…scoped to the workspace, not globally — which image a project needs is that project\'s fact',
      ctrl.scoped.sandboxImage?.workspaceValue === 'node:20', JSON.stringify(ctrl.scoped.sandboxImage));

    ctrl.config.sandboxImage = '';
    ctrl.shown.warning.length = 0;
    await provider.offerSandboxImage(tmp);
    check('the offer is made once per session, not once per command', ctrl.shown.warning.length === 0);

    // Declining leaves everything as it was.
    provider._offeredSandboxImage = false;
    ctrl.nextWarning = undefined;
    await provider.offerSandboxImage(tmp);
    check('declining the offer changes nothing', !ctrl.config.sandboxImage);

    // …and it offers a way out that is not "configure something".
    provider._offeredSandboxImage = false;
    ctrl.nextWarning = 'Turn sandboxing off';
    await provider.offerSandboxImage(tmp);
    check('the offer can also just turn sandboxing off', ctrl.config.sandboxMode === 'off');

    // ── The manifest. ────────────────────────────────────────────────────
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const decl = manifest.contributes.configuration.properties['navy.sandboxImage'];
    check('navy.sandboxImage is declared and defaults to unset', decl?.type === 'string' && decl.default === '');
    check('…and its description says the project\'s own config wins',
      /devcontainer or Dockerfile always wins/i.test(decl.markdownDescription));
  } finally {
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { sandboxSuite, persistentBgProcessSuite, shellSelectionSuite, nativeSandboxSuite, sandboxImageSuite };
