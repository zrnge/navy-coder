// ── Command and process execution ────────────────────────────────────────────
// Everything that runs something: WSL detection, the approval prompt, the
// shared spawn-and-collect, run_command, run_tests' binary path, the dev-server
// launcher, and the three background-process tools.
//
// This is the seam CONTRIBUTING named as the natural first cut of the tool
// implementations — "do it by domain (file tools, git tools, process tools),
// moving each tool's helpers with it" — and it is exactly that: a contiguous
// run of eleven methods with nothing unrelated between them, plus the two
// module-level helpers only they used.
//
// Moved verbatim. These are still methods on NavyCoderViewProvider — mixed
// into its prototype at the bottom of extension.js — so `this` means what it
// always did and no call site, no signature and no behaviour changed. Written
// as a class so the block could move without retyping it; see mixinPrototype.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { workspaceIsTrusted } = require('./workspace.js');
const { UNTRUSTED_REFUSAL } = require('./trust.js');

// Matches the handful of OS/toolchain error strings that mean "a path in
// this command doesn't actually exist" (cmd.exe, POSIX shells, and common
// compiler frontends all phrase this differently) — used by _spawnAndCollect
// to nudge the model toward verifying the real name instead of guessing a
// new spelling and retrying, which otherwise repeats indefinitely (a wrong
// path never becomes right by chance). Deliberately narrow: only genuine
// "this path/command doesn't exist" signatures, never a generic non-zero
// exit, so a real compile error or test failure never gets misdiagnosed as
// a path problem. Pure.
function looksLikeMissingPathError(output) {
  // "file not found" is cmd.exe's own wording for `dir`/`type` on a path that
  // isn't there — and also clang's ("'foo.h' file not found"), which is the
  // same class of problem. It was missing until _shellEscapeArg was fixed:
  // before that, quoting corruption meant a not-found path reached cmd
  // mangled, so it reported a SYNTAX error instead and this pattern never had
  // to recognise the plain not-found case.
  return /cannot find the (file|path) specified|the filename, directory name, or volume label syntax is incorrect|is not recognized as an internal or external command|no such file or directory|\bfile not found\b|command not found/i.test(output);
}

// The signatures of a container sandbox (docker/wsl) that could not PULL or
// REACH its image: a registry it can't resolve (DNS), a manifest that is
// missing or denied, a pull that times out. This is a networking problem in the
// sandbox, not a bug in the project — but it surfaces as confusing output (a
// bare "E_FAIL", a "dial tcp: lookup … i/o timeout") that reads like the
// command itself failed, sending the model off to edit code that is fine. The
// CALLER gates this on the sandbox actually being a container mode; this only
// recognises the shape. Pure.
function looksLikeContainerPullError(output) {
  return /not found, pulling|failed to (?:resolve|pull)|manifest unknown|pull access denied|error pulling image|dial tcp|i\/o timeout|temporary failure in name resolution|no such host|lookup [^\n]* on [^\n]*:53|\bE_FAIL\b/i.test(String(output || ''));
}

// Reads only the last `maxBytes` of a file via a positional read, instead of
// loading the whole thing into memory just to throw away everything but the
// tail — used for persisted background-process logs, which a chatty dev
// server can grow to multi-MB, and which get read repeatedly (once per
// read_process_output call, and up to 20 times by run_project's own
// server-URL poll). A synchronous full-file read on the extension host's
// single thread scales with how much the process has ever logged, not with
// maxBytes; this scales with neither the file's total size nor how many
// times it's read.
function readFileTail(filePath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const readSize = Math.min(size, maxBytes);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    // Cutting at a byte offset lands mid-character whenever the boundary falls
    // inside a multi-byte UTF-8 sequence, and decoding that yields a leading
    // U+FFFD — visible junk at the top of every truncated read. A lead byte is
    // 0b0xxxxxxx (ASCII) or 0b11xxxxxx (sequence start); 0b10xxxxxx is a
    // continuation, so skipping forward to the first non-continuation byte
    // drops at most 3 bytes of a character that was already incomplete. Only
    // applies when the read actually started mid-file — a tail covering the
    // whole file begins on a real character boundary by definition. Kept
    // inline rather than factored out: the test suite extracts this function
    // by name and evaluates it standalone.
    let from = 0;
    if (readSize < size) {
      while (from < 4 && from < buf.length && (buf[from] & 0xc0) === 0x80) from++;
    }
    return (from ? buf.subarray(from) : buf).toString('utf8');
  } catch { return ''; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}

class CommandMethods {
  // Transactional undo / redo lives in src/undo.js, mixed into this
  // prototype at the bottom of the file — still methods on this class, so
  // every call site is unchanged.

  // Detects WSL availability + installed distros on Windows so the model can
  // fall back to it for Unix-only tools (gcc, make, …) that aren't on the
  // Windows PATH — checked once per session and cached, not per-turn, since
  // spawning wsl.exe costs real time and the answer never changes mid-session.
  async _detectWsl() {
    if (process.platform !== 'win32') return { available: false };
    if (this._wslCache) return this._wslCache;
    this._wslCache = await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(result);
      };
      try {
        const child = spawn('wsl.exe', ['--list', '--quiet'], { windowsHide: true });
        let buf = Buffer.alloc(0);
        child.stdout?.on('data', (d) => { buf = Buffer.concat([buf, d]); });
        child.on('close', (code) => {
          // A non-zero exit means "no distributions installed" (or WSL not
          // provisioned) — and wsl.exe prints that explanation to stdout. Without
          // this check the message itself was parsed as the distro list, so Navy
          // told the model WSL was available and rule 18 sent it chasing every
          // missing Unix tool through a `wsl` prefix that could never work.
          if (code !== 0) return finish({ available: false });
          // wsl.exe emits UTF-16LE when its output isn't attached to a real
          // console (always true for a spawned child) — decoding as UTF-8
          // here would produce garbled text interleaved with null bytes.
          let text = buf.toString('utf16le').replace(/\0/g, '').trim();
          if (!text) text = buf.toString('utf8').replace(/\0/g, '').trim();
          const distros = text.split(/\r?\n/)
            .map(s => s.trim())
            // A distro name is a single short token; prose sentences are not.
            .filter(s => s && !/\s/.test(s) && s.length <= 64);
          finish({ available: distros.length > 0, distros });
        });
        child.on('error', () => finish({ available: false }));
        // Never let this delay a turn — treat "still running after 3s" as unavailable.
        timer = setTimeout(() => finish({ available: false }), 3000);
      } catch {
        finish({ available: false });
      }
    });
    return this._wslCache;
  }

  // Approval gate shared by every command-executing tool. `displayCommand` is
  // shown verbatim in the approval card — the user sees the same thing
  // whether the actual execution ends up going through a shell string or a
  // direct argv spawn. Returns whether the caller may proceed.
  async _approveCommand(displayCommand) {
    if (this._commandsAutoApproved()) return true;
    const id = this.generateId();
    this.view?.webview.postMessage({ type: 'pendingCommand', id, command: displayCommand });
    return await new Promise((resolve) => {
      this.pendingCommandApprovals.set(id, { resolve });
    });
  }

  // Spawns the given { bin, args, cwd, verbatim } spec and streams stdout/
  // stderr to the webview, with the same timeout/kill and output-capping
  // behavior for every caller. Shared by toolRunCommand (a _shellSpec — the
  // platform shell plus a command STRING) and _runTestBinary (a real
  // executable plus a real argv array, no shell involved at all). Routes
  // through _maybeWrapForSandbox first so navy.sandboxMode protects every
  // caller uniformly.
  // `streamId` tags the live output with the tool call it belongs to. Without
  // it every command's output was broadcast untagged and the webview appended
  // it to whichever terminal card happened to be current — so a background
  // task's command (background tasks run their own agent loop, concurrently
  // with the main turn) wrote into the main turn's card. Untagged output now
  // falls through to the shell panel instead of contaminating a card that
  // belongs to something else.
  async _spawnAndCollect(spec, timeout, streamId) {
    const resolved = await this._maybeWrapForSandbox(spec);
    if (resolved.refused) return resolved.message;
    const { bin, args } = resolved;
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const MAX_BUF = 200000; // cap accumulation — a chatty command must not eat memory
      const child = spawn(bin, args, this._spawnOptions(resolved, { detached: process.platform !== 'win32' }));
      const timer = setTimeout(() => {
        this._killProcessTree(child);
        resolve('Command timed out after ' + timeout + 'ms\nstdout: ' + stdout.slice(-8000) + '\nstderr: ' + stderr.slice(-8000));
      }, timeout);

      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        if (stdout.length > MAX_BUF) stdout = stdout.slice(-MAX_BUF);
        this.view?.webview.postMessage({ type: 'shellChunk', chunk, streamId });
      });
      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        if (stderr.length > MAX_BUF) stderr = stderr.slice(-MAX_BUF);
        this.view?.webview.postMessage({ type: 'shellChunk', chunk, isStderr: true, streamId });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        let out = 'Exit code: ' + code + '\nstdout:\n' + stdout + '\nstderr:\n' + stderr;
        // Cap what goes back to the model: keep the head (exit code + first lines,
        // which the failure tracker parses) and the tail (where errors usually are).
        if (out.length > 16000) {
          out = out.slice(0, 2000)
              + `\n\n[... output truncated — ${out.length.toLocaleString()} chars total, showing head and tail ...]\n\n`
              + out.slice(-13000);
        }
        // A failed command whose own output says a path/command doesn't
        // exist is a signal worth surfacing explicitly — left alone, a model
        // that guessed wrong just guesses again with a slightly different
        // spelling and repeats the same failure, since a wrong path never
        // becomes right by chance. Appended AFTER truncation so it's never
        // the part that gets cut.
        if (code !== 0 && looksLikeMissingPathError(out)) {
          out += '\n\n[Navy: this looks like a path/file/command that does not exist, not a code or logic error. Before retrying with a different guessed spelling, list the actual parent directory (e.g. `dir`/`ls` on it, or list_files if it is inside the workspace) and use the exact name it reports — do not guess again.]';
        }
        resolve(out);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve('Command error: ' + error.message);
      });
    });
  }

  async toolRunCommand(command, timeout = 30000, streamId) {
    if (!workspaceIsTrusted()) return UNTRUSTED_REFUSAL('run shell commands');
    if (!(await this._approveCommand(command + this._sandboxLabelSuffix()))) return 'Command rejected by user';

    const root = this.projectRoot
      || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      || (vscode.window.activeTextEditor ? path.dirname(vscode.window.activeTextEditor.document.fileName) : process.cwd());
    return this._spawnAndCollect({ ...this._shellSpec(command), cwd: root }, timeout, streamId);
  }

  // Runs a test binary directly with a real argv array — no shell, so a
  // filter containing shell metacharacters (&, |, %, $(...), backticks,
  // quotes) is delivered to the process byte-for-byte with zero
  // reinterpretation, instead of being concatenated into a shell command
  // string. Only for real executables (pytest/cargo/go) that never need
  // shell resolution the way npm/npx (.cmd shims on Windows) do — verified
  // empirically that a plain (non-shell) spawn delivers each arg unmodified
  // with no injection, no %-expansion, and no operator-splitting.
  async _runTestBinary(bin, args, root, timeout, streamId) {
    const display = [bin, ...args].map(a => /[\s"&|<>^%!$`']/.test(a) ? JSON.stringify(a) : a).join(' ');
    if (!(await this._approveCommand(display + this._sandboxLabelSuffix()))) return 'Command rejected by user';
    // verbatim: false — a real argv spawn, where Node's own per-argument
    // quoting is exactly what's wanted (see _shellSpec for the contrast).
    return this._spawnAndCollect({ bin, args, cwd: root, verbatim: false }, timeout, streamId);
  }

  detectRunCommand() {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;
    const has = (f) => fs.existsSync(path.join(root, f));
    const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };

    if (has('package.json')) {
      try {
        const pkg = JSON.parse(read('package.json'));
        const s = pkg.scripts || {};
        if (s.dev)     return 'npm run dev';
        if (s.start)   return 'npm start';
        if (s.serve)   return 'npm run serve';
        if (s.preview) return 'npm run preview';
      } catch {}
    }
    if (has('manage.py'))         return 'python manage.py runserver';
    if (has('pyproject.toml')) {
      const c = read('pyproject.toml').toLowerCase();
      if (c.includes('uvicorn') || c.includes('fastapi')) return 'uvicorn main:app --reload';
      if (c.includes('flask'))  return 'flask run';
    }
    if (has('requirements.txt')) {
      const r = read('requirements.txt').toLowerCase();
      if (r.includes('uvicorn') || r.includes('fastapi')) return 'uvicorn main:app --reload';
      if (r.includes('flask'))  return 'flask run';
    }
    if (has('app.py'))   return 'python app.py';
    if (has('main.py'))  return 'python main.py';
    if (has('go.mod'))   return 'go run .';
    if (has('Cargo.toml')) return 'cargo run';
    if (has('Gemfile'))  return 'bundle exec ruby app.rb';
    if (has('pom.xml'))  return 'mvn spring-boot:run -q';
    if (has('build.gradle') || has('build.gradle.kts')) return 'gradle bootRun -q';
    if (has('Makefile')) return 'make';
    return null;
  }

  async toolRunProject(command = null) {
    if (!workspaceIsTrusted()) return UNTRUSTED_REFUSAL('start the project');
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'Error: No project folder open. Ask the user to open a folder first.';

    const cmd = command || this.detectRunCommand();
    if (!cmd) return 'Error: Could not auto-detect how to run this project. Provide an explicit command (e.g. "npm start", "python app.py").';

    if (!this._commandsAutoApproved()) {
      const choice = await vscode.window.showInformationMessage(
        `Navy wants to run: ${cmd}${this._sandboxLabelSuffix()}`, { modal: false }, 'Allow', 'Deny'
      );
      if (choice !== 'Allow') return 'Command rejected by user.';
    }

    // If the project is already running, don't kill and restart — report it instead.
    const existing = this.bgProcesses.get('__run_project__');
    if (existing?.proc) {
      const urlNote = existing.url ? ` at ${existing.url}` : '';
      return `Project is already running${urlNote} (command: ${existing.command}). Stop it first via the Stop button if you need to restart. Do not call run_project again while it is running.`;
    }
    // Previous run exited — clean up its entry before starting fresh.
    if (existing) this.bgProcesses.delete('__run_project__');

    const isWin = process.platform === 'win32';
    // Resolved BEFORE posting runProjectStart — a sandboxing refusal should
    // never leave the webview showing a "starting..." state for a project
    // that was never actually launched.
    const resolved = await this._maybeWrapForSandbox({ ...this._shellSpec(cmd), cwd: root });
    if (resolved.refused) return resolved.message;

    const projectName = path.basename(root);
    this.view?.webview.postMessage({ type: 'runProjectStart', projectName, command: cmd });

    const entry = { proc: null, stdout: '', stderr: '', exitCode: null, command: cmd, url: null };
    const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)\S*/;
    let urlFound = false;

    if (this._persistBgEnabled()) {
      // A real log-file fd, not a pipe — see the section comment above
      // _persistBgEnabled for why that's what actually lets this process
      // outlive a reload. There is then no live stream to read, so this
      // branch can't wire the usual onData/webview streaming or synchronous
      // URL detection — instead it polls the log file itself, capped,
      // self-clearing, same style as every other bounded timer in this file.
      //
      // detached is Unix-only here (`!isWin`), verified empirically rather
      // than assumed: on Windows, `detached: true` on the cmd.exe wrapper
      // reliably breaks the grandchild's (node/npm/etc.) I/O ever reaching
      // the redirected fd at all — cmd.exe runs it and exits 0, but the log
      // file stays empty, with no error anywhere. This reproduced across
      // both a raw fd AND cmd's own `>` redirection, and both with and
      // without shell:true, so it isn't specific to one mechanism — plain
      // (non-detached) + unref() reliably captures output and (unlike
      // detached, which mainly governs console/signal-group inheritance,
      // irrelevant to a window reload) is what this actually needs: nothing
      // here calls _killProcessTree on a persist:true entry (see
      // _disposeSession), so the process is simply never told to stop.
      const { fd, logPath } = await this._openPersistLog(root, '__run_project__');
      const proc = spawn(resolved.bin, resolved.args, this._spawnOptions(resolved, { detached: !isWin, stdio: ['ignore', fd, fd] }));
      try { fs.closeSync(fd); } catch {} // child already has its own dup'd handle
      proc.unref();
      Object.assign(entry, { proc, persist: true, root, pid: proc.pid, logPath });
      this.bgProcesses.set('__run_project__', entry);
      await this._addToBgManifest(root, { id: '__run_project__', taskPath: this._taskPathFor(root, '__run_project__'),
        pid: proc.pid, command: cmd, startedAt: Date.now(), logPath, kind: 'run_project' });

      let tries = 0;
      const poll = setInterval(() => {
        tries++;
        if (urlFound || tries > 20 || this.bgProcesses.get('__run_project__') !== entry) { clearInterval(poll); return; }
        const tail = readFileTail(logPath, 4000);
        const m = tail.match(URL_RE);
        if (m) {
          urlFound = true;
          entry.url = m[0].replace(/0\.0\.0\.0/, 'localhost');
          this.view?.webview.postMessage({ type: 'runProjectReady', url: entry.url });
          clearInterval(poll);
        }
      }, 500);

      proc.on('exit', (code) => {
        entry.exitCode = code ?? 0;
        entry.proc = null;
        this.bgProcesses.delete('__run_project__');
        this._removeFromBgManifest(root, proc.pid).catch(() => {});
        this.view?.webview.postMessage({ type: 'runProjectStopped', exitCode: entry.exitCode });
      });
      proc.on('error', () => {
        this.view?.webview.postMessage({ type: 'runProjectStopped', exitCode: -1 });
        this.bgProcesses.delete('__run_project__');
      });

      return `Starting "${projectName}" with: ${cmd}\nRunning detached (navy.persistBackgroundProcesses is on) — output logged to ${logPath}, and it will survive a window reload. Watching the log for the server URL...`;
    }

    // detached: true on Unix creates a new process group so _killProcessTree can kill it cleanly.
    const proc = spawn(resolved.bin, resolved.args, this._spawnOptions(resolved, { detached: !isWin }));
    entry.proc = proc;
    this.bgProcesses.set('__run_project__', entry);
    // Deliberately NOT written to the project's bg manifest. That file is
    // shared by every window open on this project, and a non-persistent server
    // belongs to THIS window — it is killed when this window closes
    // (_disposeSession tree-kills it). Recording it made a sibling window
    // classify a live server as an orphan from a previous session and offer to
    // stop it, which is a far worse failure than the one it was added to
    // catch. navy.persistBackgroundProcesses is the supported way to have a
    // server outlive its window, and that path records and recovers properly.

    const onData = (chunk) => {
      const text = chunk.toString();
      entry.stdout += text;
      if (entry.stdout.length > 200000) entry.stdout = entry.stdout.slice(-200000);
      this.view?.webview.postMessage({ type: 'runProjectOutput', chunk: text });
      if (!urlFound) {
        const m = text.match(URL_RE);
        if (m) {
          urlFound = true;
          const url = m[0].replace(/0\.0\.0\.0/, 'localhost');
          entry.url = url;
          this.view?.webview.postMessage({ type: 'runProjectReady', url });
          // Persist it: after a restart the pid alone cannot tell anyone WHERE
          // the server is, and "a process is running" is a much less useful
          // thing to be told than "your dev server is still on this address".
          // Only the persistent path has a manifest record to update.
          if (entry.persist && entry.root) {
            this._updateBgManifestEntry(entry.root, proc.pid, { url }).catch(() => {});
          }
        }
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData); // Many frameworks log the URL to stderr
    proc.on('close', (code) => {
      entry.exitCode = code ?? 0;
      entry.proc = null;
      this.bgProcesses.delete('__run_project__');
      this.view?.webview.postMessage({ type: 'runProjectStopped', exitCode: entry.exitCode });
    });
    proc.on('error', () => {
      this.view?.webview.postMessage({ type: 'runProjectStopped', exitCode: -1 });
      this.bgProcesses.delete('__run_project__');
    });

    return `Starting "${projectName}" with: ${cmd}\nWatching for server URL...`;
  }

  async toolStartProcess(id, command) {
    if (!workspaceIsTrusted()) return UNTRUSTED_REFUSAL('start background processes');
    if (!id || !command) return 'Error: id and command are required.';
    const prior = this.bgProcesses.get(id);
    if (prior?.proc) return `Error: a process named "${id}" is already running.`;
    if (prior) this.bgProcesses.delete(id); // previous run exited — allow id reuse

    if (!this._commandsAutoApproved()) {
      const choice = await vscode.window.showInformationMessage(
        `Navy wants to start a background process:\n${command}${this._sandboxLabelSuffix()}`,
        { modal: false }, 'Allow', 'Deny'
      );
      if (choice !== 'Allow') return 'Process rejected by user.';
    }

    // Distinct from `root` below: persisting needs somewhere real to anchor
    // the manifest/log to, so it's never enabled off the process.cwd()
    // fallback (no actual open project to write .navy/ under).
    const persistRoot = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
    const root = persistRoot || process.cwd();
    const isWin = process.platform === 'win32';
    const resolved = await this._maybeWrapForSandbox({ ...this._shellSpec(command), cwd: root });
    if (resolved.refused) return resolved.message;

    const entry = { proc: null, stdout: '', stderr: '', exitCode: null, startedAt: Date.now() };

    if (persistRoot && this._persistBgEnabled()) {
      // See the persist branch of toolRunProject for why this needs a real
      // fd (not the usual pipe), can't wire live webview streaming, and why
      // `detached` is Unix-only (empirically verified: on Windows it breaks
      // the grandchild's I/O ever reaching the redirected fd through the
      // cmd.exe wrapper).
      const { fd, logPath } = await this._openPersistLog(persistRoot, id);
      const proc = spawn(resolved.bin, resolved.args, this._spawnOptions(resolved, { detached: !isWin, stdio: ['ignore', fd, fd] }));
      try { fs.closeSync(fd); } catch {}
      proc.unref();
      Object.assign(entry, { proc, persist: true, root: persistRoot, pid: proc.pid, logPath });
      this.bgProcesses.set(id, entry);
      await this._addToBgManifest(persistRoot, { id, taskPath: this._taskPathFor(persistRoot, id),
        pid: proc.pid, command, startedAt: entry.startedAt, logPath, kind: 'start_process' });

      proc.on('exit', code => {
        entry.exitCode = code ?? 0;
        entry.proc = null;
        this._removeFromBgManifest(persistRoot, proc.pid).catch(() => {});
        this.view?.webview.postMessage({ type: 'bgProcessDone', id, exitCode: entry.exitCode });
      });
      proc.on('error', () => { entry.exitCode = -1; });

      return `Process "${id}" started (PID ${proc.pid}), detached — it will survive a window reload (navy.persistBackgroundProcesses is on). Output is logged to ${logPath}; use read_process_output("${id}") to read it.`;
    }

    const proc = spawn(resolved.bin, resolved.args, this._spawnOptions(resolved, { detached: !isWin }));
    entry.proc = proc;
    this.bgProcesses.set(id, entry);

    proc.stdout.on('data', d => {
      const chunk = d.toString();
      entry.stdout += chunk;
      if (entry.stdout.length > 100000) entry.stdout = entry.stdout.slice(-100000);
      this.view?.webview.postMessage({ type: 'bgProcessOutput', id, chunk });
    });
    proc.stderr.on('data', d => {
      const chunk = d.toString();
      entry.stderr += chunk;
      if (entry.stderr.length > 100000) entry.stderr = entry.stderr.slice(-100000);
      this.view?.webview.postMessage({ type: 'bgProcessOutput', id, chunk, isStderr: true });
    });
    proc.on('close', code => {
      entry.exitCode = code ?? 0;
      entry.proc = null;
      this.view?.webview.postMessage({ type: 'bgProcessDone', id, exitCode: entry.exitCode });
    });
    proc.on('error', e => {
      entry.stderr += '\nProcess error: ' + e.message;
      entry.exitCode = -1;
    });

    return `Process "${id}" started (PID ${proc.pid}). Use read_process_output("${id}") after a moment to check output.`;
  }

  async toolReadProcessOutput(id, clear = false) {
    const entry = this.bgProcesses.get(id);
    if (!entry) {
      const running = [...this.bgProcesses.keys()];
      return running.length
        ? `No process "${id}". Running: ${running.join(', ')}.`
        : `No process "${id}". No background processes running.`;
    }
    const status = entry.exitCode !== null ? `exited (code ${entry.exitCode})` : 'running';
    // Persisted (navy.persistBackgroundProcesses) processes have no live
    // in-memory buffer to read — their stdio is a real file, not a pipe
    // this process ever sees (see _openPersistLog) — so read its current
    // tail from disk instead. `clear` intentionally has no effect on a real
    // log file rather than silently discarding it.
    if (entry.logPath) {
      const tail = readFileTail(entry.logPath, 100000);
      return `[${id}] ${status} (persisted — logged to ${entry.logPath})\n${tail.trim() || '(no output yet)'}`;
    }
    const combined = (entry.stdout + (entry.stderr ? '\n[stderr]\n' + entry.stderr : '')).trim();
    if (clear && entry.exitCode === null) { entry.stdout = ''; entry.stderr = ''; }
    return `[${id}] ${status}\n${combined || '(no output yet)'}`;
  }

  // Kill a spawned process AND its entire child tree (npm → node, etc.).
  // On Windows uses taskkill /F /T; on Unix kills the process group (requires detached: true on spawn).
  // Delegates to _killPidTree (spawn, NOT execSync — this is called from
  // stream handlers, timers, and the tool loop, all on the extension host
  // thread, and a synchronous kill would freeze the whole editor for as
  // long as the child takes to die) so the same by-pid kill logic serves
  // both a live ChildProcess here and a bare pid recovered from a previous
  // window's manifest (see _checkOrphanedBgProcesses, which has no
  // ChildProcess object to hand this).
  _killProcessTree(proc) {
    if (!proc?.pid || proc.killed) return;
    this._killPidTree(proc.pid);
  }

  async toolKillProcess(id) {
    const entry = this.bgProcesses.get(id);
    if (!entry) return `No process "${id}" found.`;
    if (!entry.proc) return `Process "${id}" has already exited (code ${entry.exitCode}).`;
    this._killProcessTree(entry.proc);
    this.bgProcesses.delete(id);
    if (entry.persist && entry.root) await this._removeFromBgManifest(entry.root, entry.pid);
    this.view?.webview.postMessage({ type: 'bgProcessDone', id, exitCode: -1 });
    return `Process "${id}" killed.`;
  }
}

module.exports = {
  COMMAND_METHODS: CommandMethods.prototype,
  // Exported for the tests, which read them out of this file rather than
  // reimplementing them.
  looksLikeMissingPathError, looksLikeContainerPullError, readFileTail,
};
