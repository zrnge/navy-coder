// ── Command-execution sandboxing (navy.sandboxMode) ───────────────────────────
// Off by default. When on, every spawn site routes through
// _maybeWrapForSandbox, so it protects run_command, run_tests, run_project and
// background processes uniformly — and never silently falls back to
// unsandboxed execution when it cannot proceed. Refusing is the whole design: a
// sandbox that quietly switches itself off is worse than none, because by then
// the user has stopped watching for it.
//
// Three backends, because Docker turned out to be too high a price for most
// people to pay for any isolation at all:
//
//   'docker' — strongest isolation, on any OS. Needs Docker running AND the
//              project to carry its own devcontainer or Dockerfile (or
//              navy.sandboxImage); Navy will not guess at an image.
//   'wsl'    — WSL Containers (`wslc`), Microsoft's first-party Linux-container
//              runtime built into Windows (WSL 2.9.3+, Build 2026). Container
//              isolation on Windows WITHOUT Docker Desktop — same image contract
//              as 'docker'. Windows-only. See _wrapWsl.
//   'native' — the OS's own sandbox, with nothing to install: sandbox-exec
//              (Seatbelt) on macOS, bubblewrap on Linux. Weaker than a
//              container, and _nativeDenyReadPaths says exactly how. Not on
//              Windows — 'wsl' or 'docker' is the Windows answer.
//
// Extracted from extension.js unchanged. These are still methods on
// NavyCoderViewProvider — mixed into its prototype at the bottom of
// extension.js — so `this` means what it always did and no call site, no
// signature and no behaviour changed. Written as a class so the block could
// move verbatim; see mixinPrototype in extension.js for how it is applied.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { CHECKER_CWD } = require('./exec.js');

// Splits a file's content into embeddable chunks. A file that fits in one
// window (the common case for most source files) produces a SINGLE chunk
// spanning the whole file, with the exact embedded text format used before
// chunking existed (`rel + '\n\n' + content.slice(0, 1500)`) — so ordinary
// small-file behavior, and every existing test that pins that exact string,
// is unaffected. Only a file with MORE lines than one window splits into
// multiple overlapping chunks, each tagged with its own line range — this is
// what makes a symbol defined past the old 1,500-char cutoff findable by
// semantic search at all. A per-chunk window is capped at maxCharsPerChunk —
// deliberately much larger than the single-file 1,500 above: 120 lines of
// ordinary code easily runs 4,000-6,000+ characters, and reusing the smaller
// constant here would silently truncate a chunk mid-window, undermining the
// entire reason chunking exists (a real symbol landing just past that
// smaller cutoff, inside its own correct chunk, would still be invisible).
// Capped at maxChunks per file (a giant file just gets its first
// maxChunks*step lines covered, matching the caps used everywhere else in
// this file: maxFiles, MAX_READ_LINES, etc.). Pure.
// Strips // and /* */ comments from JSONC (JSON with Comments) — devcontainer.json
// commonly contains comments despite its .json extension, and JSON.parse rejects
// them outright. String-literal-aware (tracks quote/escape state) so a comment
// marker inside a quoted value (e.g. a "https://" URL) is never mistaken for a
// real comment. Pure.
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // land on the closing '/'
      continue;
    }
    out += ch;
  }
  return out;
}

class SandboxMethods {
  // Is Docker actually usable right now? Checks `docker info`, not just that
  // the binary is on PATH — Docker Desktop can be installed but not running,
  // and _commandAvailable alone would report "available" in that state.
  // Deliberately NOT cached across calls (unlike _commandAvailable, which
  // guards a hot per-edit path): Docker starting/stopping mid-session is
  // common here specifically (a user starting Docker Desktop to try this
  // feature), and this check only runs once per command execution — not a
  // path where a ~1s `docker info` call meaningfully adds latency.
  async _dockerAvailable() {
    const result = await this._runChecker('docker', ['info'], CHECKER_CWD, 5000);
    return result.ok;
  }

  // Is the WSL container runtime (`wslc`, Microsoft's native Linux-container
  // CLI shipped in WSL) usable right now? `wslc version` both proves the binary
  // is on PATH and that WSL answers — a machine on an older WSL simply has no
  // `wslc`, so this fails and the mode refuses rather than running unsandboxed.
  // Not cached, for the same reason _dockerAvailable is not: a user updating WSL
  // to try this mid-session is exactly the case that must be re-checked.
  async _wslcAvailable() {
    const result = await this._runChecker('wslc', ['version'], CHECKER_CWD, 5000);
    return result.ok;
  }

  // Resolves (building if needed) the Docker image to run sandboxed commands
  // in — cached per project root, since a `docker build` invocation (even
  // one that resolves instantly off Docker's OWN layer cache) is still a
  // real daemon round-trip, and otherwise repeats before EVERY single
  // sandboxed command in a turn even though the resolved image essentially
  // never changes within a session. Invalidated by re-checking the mtime of
  // whichever config file (devcontainer.json / Dockerfile) actually exists —
  // cheap (one or two stat calls) — so editing either takes effect on the
  // very next command rather than needing a reload.
  async _resolveSandboxImage(root, builder = 'docker') {
    const cache = this._projCacheFor(root);
    const statMtime = async (p) => { try { return (await fs.promises.stat(p)).mtimeMs; } catch { return null; } };
    const [dcMtime, dfMtime] = await Promise.all([
      statMtime(path.join(root, '.devcontainer', 'devcontainer.json')),
      statMtime(path.join(root, 'Dockerfile')),
    ]);
    // navy.sandboxImage is part of the key: without it, setting the image would
    // appear to do nothing until one of the two files happened to change. The
    // builder is too — docker and wslc keep SEPARATE image stores, so a tag one
    // builds is invisible to the other, and switching modes must re-resolve.
    const configured = this._configuredSandboxImage();
    const cached = cache.sandboxImageCache;
    if (cached && cached.dcMtime === dcMtime && cached.dfMtime === dfMtime && cached.configured === configured && cached.builder === builder) {
      return cached.result;
    }

    const result = await this._resolveSandboxImageUncached(root, builder);
    cache.sandboxImageCache = { dcMtime, dfMtime, configured, builder, result };
    return result;
  }

  // Only trusts config the PROJECT ITSELF already declares — a
  // .devcontainer/devcontainer.json (the exact file VS Code's own Dev
  // Containers feature reads) or a plain Dockerfile at the project root —
  // and never guesses at a generic multi-language image: a container that
  // doesn't actually have the project's real toolchain is a false sense of
  // safety, worse than no sandbox at all. Returns { image }, or null if
  // there's nothing to build from (caller refuses sandboxed execution with
  // an actionable message rather than silently running unsandboxed).
  async _resolveSandboxImageUncached(root, builder = 'docker') {
    let dockerfilePath = null;
    let context = root;
    let directImage = null;

    const devcontainerPath = path.join(root, '.devcontainer', 'devcontainer.json');
    try {
      const raw = await fs.promises.readFile(devcontainerPath, 'utf8');
      const config = JSON.parse(stripJsonComments(raw));
      if (typeof config.image === 'string' && config.image.trim()) {
        directImage = config.image.trim();
      } else {
        const df = config.build?.dockerfile || config.dockerFile;
        if (df) {
          dockerfilePath = path.resolve(path.dirname(devcontainerPath), df);
          context = path.resolve(path.dirname(devcontainerPath), config.build?.context || '.');
        }
      }
    } catch {}

    if (!directImage && !dockerfilePath) {
      // No usable devcontainer config — fall back to a plain root Dockerfile,
      // same as VS Code's own Dev Containers feature does in that case.
      const plainDockerfile = path.join(root, 'Dockerfile');
      try { await fs.promises.access(plainDockerfile); dockerfilePath = plainDockerfile; context = root; } catch {}
    }

    if (directImage) return { image: directImage };
    if (!dockerfilePath) {
      // Nothing in the project. An image the user named for this workspace is
      // an answer, not a guess, so it is used — but only here, after every
      // project-owned option has been tried.
      const configured = this._configuredSandboxImage();
      return configured ? { image: configured, fromSetting: true } : null;
    }

    // Stable tag derived from the project root — repeated runs reuse Docker's
    // own layer cache (a rebuild with nothing changed is near-instant)
    // instead of accumulating a fresh anonymous image every time.
    const tag = 'navy-sandbox-' + crypto.createHash('md5').update(root).digest('hex').slice(0, 12);
    // `builder` is 'docker' or 'wslc'; wslc's `build` mirrors Docker's flags, so
    // the same argv builds the image in whichever runtime will then run it.
    const build = await this._runChecker(builder, ['build', '-t', tag, '-f', dockerfilePath, context], CHECKER_CWD, 300000);
    if (!build.ok) return null;
    return { image: tag };
  }

  // Central sandboxing decision point — called by every process-spawning
  // tool (_spawnAndCollect, toolRunProject, toolStartProcess) so enabling
  // navy.sandboxMode protects all of them uniformly. When 'off' (default),
  // returns the { bin, args, cwd, verbatim } spec completely unchanged. When
  // 'docker', resolves an image from the project's own devcontainer/Dockerfile
  // and rewrites the spawn target to run inside it with ONLY the project
  // folder mounted. Never silently falls back to unsandboxed execution if
  // sandboxing was requested but can't proceed — that would be a false sense
  // of safety; returns { refused: true, message } for the caller to surface
  // directly as the tool's result instead.
  async _maybeWrapForSandbox(spec) {
    const { bin, args, cwd } = spec;
    const mode = vscode.workspace.getConfiguration('navy').get('sandboxMode', 'off');
    if (mode === 'native') return await this._wrapNative(spec);
    if (mode === 'wsl') return await this._wrapWsl(spec);
    if (mode !== 'docker') return { ...spec };

    if (!(await this._dockerAvailable())) {
      return { refused: true, message: 'Sandboxed execution requested (navy.sandboxMode is "docker") but Docker is not installed or not running — refusing to run unsandboxed. Start Docker Desktop, or set navy.sandboxMode to "off".' };
    }
    const resolved = await this._resolveSandboxImage(cwd);
    if (!resolved) {
      // Docker is present and only the image is missing, which is a question
      // with an answer rather than a wall. Asked once per session, and the
      // command is still refused this time — the user has not answered yet.
      this.offerSandboxImage(cwd).catch(() => {});
      return { refused: true, message: `Sandboxed execution requested (navy.sandboxMode is "docker") but no .devcontainer/devcontainer.json or Dockerfile was found in ${path.basename(cwd)}, and navy.sandboxImage is not set — Navy will not guess at a generic image that might not match this project's real toolchain. Set navy.sandboxImage to the image this project builds in (e.g. "node:20"), add a devcontainer config or Dockerfile, or set navy.sandboxMode to "off".` };
    }
    // Docker Desktop accepts a drive-letter path in -v, but forward slashes are
    // the form its docs use and the one that survives every backend; a
    // backslash path is a needless way for a Windows mount to fail.
    const mount = process.platform === 'win32' ? cwd.replace(/\\/g, '/') : cwd;
    // `bin, ...args` is the container's own shell, not the host's: _shellSpec
    // returns `sh -c …` whenever the command is bound for a container, so this
    // line stays correct on a Windows host. It was `cmd /c …` before, which no
    // Linux image has — the reason sandboxing never worked on Windows.
    const dockerArgs = [
      'run', '--rm', '--memory', '2g', '--cpus', '2',
      '-v', `${mount}:/workspace`, '-w', '/workspace',
      resolved.image, bin, ...args,
    ];
    // verbatim is deliberately cleared: this is now a direct argv spawn of
    // docker.exe, where Node's own CRT-rule quoting is exactly right and
    // verbatim (which would concatenate the args with bare spaces) would
    // mangle any argument containing one.
    return { bin: 'docker', args: dockerArgs, cwd, verbatim: false };
  }

  // WSL Containers ('wsl') — Microsoft's native Linux-container runtime built
  // into Windows (public preview, `wslc`). It is the piece that was missing:
  // real container isolation on Windows WITHOUT Docker Desktop. Windows-only —
  // it IS the Windows answer, and macOS/Linux already have their own backends.
  //
  // Same shape as the docker path on purpose: wslc's CLI mirrors Docker's, so
  // the image resolves the same way (the project's own devcontainer/Dockerfile,
  // or navy.sandboxImage — never a guess) and the spawn is the same `run --rm -v
  // <root>:/workspace -w /workspace <image> <cmd>`, only built and run through
  // wslc's own image store instead of Docker's.
  async _wrapWsl(spec) {
    const { bin, args, cwd } = spec;
    if (process.platform !== 'win32') {
      return { refused: true, message: 'Sandboxed execution requested (navy.sandboxMode is "wsl") but WSL Containers is a Windows-only backend. On this platform use "native" (macOS/Linux) or "docker".' };
    }
    if (!(await this._wslcAvailable())) {
      return { refused: true, message: 'Sandboxed execution requested (navy.sandboxMode is "wsl") but the WSL container runtime (wslc) was not found — refusing to run unsandboxed. Install it with "wsl --update --pre-release" (needs WSL 2.9.3+), or set navy.sandboxMode to "docker" or "off".' };
    }
    const resolved = await this._resolveSandboxImage(cwd, 'wslc');
    if (!resolved) {
      this.offerSandboxImage(cwd).catch(() => {});
      return { refused: true, message: `Sandboxed execution requested (navy.sandboxMode is "wsl") but no .devcontainer/devcontainer.json or Dockerfile was found in ${path.basename(cwd)}, and navy.sandboxImage is not set — Navy will not guess at a generic image that might not match this project's real toolchain. Set navy.sandboxImage (e.g. "node:20"), add a devcontainer config or Dockerfile, or set navy.sandboxMode to "off".` };
    }
    // Forward-slash the mount, exactly as the docker path does — Microsoft's own
    // wslc examples use that form and it is the one that survives every backend.
    const mount = cwd.replace(/\\/g, '/');
    const wslcArgs = [
      'run', '--rm', '--memory', '2g', '--cpus', '2',
      '-v', `${mount}:/workspace`, '-w', '/workspace',
      resolved.image, bin, ...args,
    ];
    return { bin: 'wslc', args: wslcArgs, cwd, verbatim: false };
  }

  // Seatbelt (macOS) and bubblewrap (Linux) express the same policy in two
  // different languages. Both are built from the SAME two facts — what may be
  // written, and what may not be read — so the two platforms cannot drift into
  // protecting different things.
  //
  // What this actually buys, stated plainly, because a sandbox nobody
  // understands is a sandbox nobody can rely on:
  //
  //   * writes are confined to the project and the temp directory. A command
  //     cannot rewrite your shell profile, install a git hook in another
  //     checkout, or touch anything elsewhere on disk.
  //   * a short list of credential stores cannot be READ, so a command cannot
  //     quietly walk off with SSH or cloud keys.
  //   * the network is NOT restricted. Blocking it would break npm install,
  //     pip, cargo and go — the commands people most want to run — so this
  //     does not pretend to stop a determined exfiltration. Use 'docker' with
  //     a network-less image if that is the threat you care about.
  //
  // ~/.npmrc and ~/.gitconfig are deliberately NOT denied: package installs and
  // git both need them, and a sandbox that breaks the build gets switched off,
  // which protects nothing at all.
  _nativeDenyReadPaths() {
    const home = os.homedir();
    return ['.ssh', '.aws', '.gnupg', '.kube', '.netrc', '.docker/config.json', '.config/gcloud']
      .map(p => path.join(home, p));
  }

  // SBPL: later rules win, so this reads as "allow everything, then take writes
  // away, then hand back the two places a build legitimately needs".
  _seatbeltProfile(projectDir, tmpDir) {
    const q = (p) => '"' + String(p).replace(/"/g, '\\"') + '"';
    const denyRead = this._nativeDenyReadPaths().map(p => '(subpath ' + q(p) + ')').join(' ');
    return [
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      '(allow file-write* (subpath ' + q(projectDir) + ') (subpath ' + q(tmpDir) + ') (subpath "/dev"))',
      denyRead ? '(deny file-read* ' + denyRead + ')' : '',
    ].filter(Boolean).join(' ');
  }

  // Everything readable, the two writable places bound read-write, and each
  // credential store masked with an empty tmpfs so a read finds nothing rather
  // than failing in a way that reads as a bug.
  _bubblewrapArgs(projectDir, tmpDir) {
    const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
      '--bind', projectDir, projectDir, '--bind', tmpDir, tmpDir];
    for (const p of this._nativeDenyReadPaths()) args.push('--tmpfs', p);
    // --die-with-parent matters here: Navy's kill path targets the process it
    // spawned, and without this a bwrap child could outlive it.
    args.push('--die-with-parent');
    return args;
  }

  async _wrapNative(spec) {
    const { bin, args, cwd } = spec;
    const tmpDir = os.tmpdir();

    if (process.platform === 'darwin') {
      if (!(await this._commandAvailable('sandbox-exec'))) {
        return { refused: true, message: 'Sandboxed execution requested (navy.sandboxMode is "native") but sandbox-exec was not found — refusing to run unsandboxed. Set navy.sandboxMode to "docker", or to "off".' };
      }
      return {
        bin: 'sandbox-exec',
        args: ['-p', this._seatbeltProfile(cwd, tmpDir), bin, ...args],
        cwd,
        // A direct argv spawn: Node's own quoting is right here, and verbatim
        // would join the profile's spaces into nonsense.
        verbatim: false,
      };
    }

    if (process.platform === 'linux') {
      if (!(await this._commandAvailable('bwrap'))) {
        return { refused: true, message: 'Sandboxed execution requested (navy.sandboxMode is "native") but bubblewrap (bwrap) is not installed — refusing to run unsandboxed. Install it (e.g. "apt install bubblewrap"), or set navy.sandboxMode to "docker" or "off".' };
      }
      return {
        bin: 'bwrap',
        args: [...this._bubblewrapArgs(cwd, tmpDir), bin, ...args],
        cwd,
        verbatim: false,
      };
    }

  // Windows has no native backend, and this is the reasoning rather than an
  // omission — everything below was looked at and rejected for a stated reason,
  // so nobody has to re-derive it, and nobody ships a fake one:
  //
  //   Windows Sandbox (WindowsSandbox.exe) — present on Pro/Enterprise, absent
  //     on Home, and not drivable. It takes a .wsb config and boots a full GUI
  //     VM; there is no CLI that runs a command and returns its output. A
  //     LogonCommand's output goes to the VM's screen, so capturing it means a
  //     mapped folder and a polling loop, per command, behind a multi-second
  //     boot. A tool loop runs dozens of commands.
  //
  //   AppContainer — the right primitive, and unreachable from here.
  //     CreateAppContainerProfile plus CreateProcess with a security capability
  //     needs a native addon or a shipped helper .exe, and this extension has
  //     no runtime dependencies and no compiled artefacts on purpose.
  //
  //   Job objects — limit CPU, memory and process count, and do not restrict
  //     the filesystem at all. They would constrain the two things that were
  //     never the worry while leaving credentials readable.
  //
  //   runas /trustlevel — drops admin rights but still runs as the same user,
  //     so every file that user owns stays readable and writable. That is not
  //     the boundary this is defending.
  //
  //   WSL + bubblewrap — technically works, and quietly swaps the toolchain:
  //     WSL's node/python/cargo are a different installation from the host's,
  //     so `npm test` would run against a runtime the user never chose. A
  //     sandbox that silently changes what is being tested is worse than none.
  //
  //   WSL Containers ('wsl') — this DID change the picture. As of WSL 2.9.3
  //     (Build 2026, public preview) Microsoft ships `wslc`, a first-party Linux
  //     container runtime built into Windows — real container isolation with no
  //     Docker Desktop. It is a distinct container backend (see _wrapWsl), so
  //     'native' on Windows still has nothing to drive; the answer is to switch
  //     to 'wsl' or 'docker', not to pretend 'native' works here.
  //
  // So Windows now has TWO container answers — 'docker' and 'wsl' — and both
  // genuinely work: the shell-targeting bug that once made every sandboxed
  // command fail on Windows is fixed (see _commandTargetIsPosix).
  //
  // The asymmetry is smaller than it was but still real: on macOS and Linux you
  // get some protection with nothing installed; on Windows you need Docker or
  // WSL Containers, AND an image (the project's own devcontainer/Dockerfile, or
  // navy.sandboxImage).
    return { refused: true, message: 'Sandboxed execution requested (navy.sandboxMode is "native"), but Windows has no NATIVE sandbox Navy can drive: Windows Sandbox boots a GUI VM with no way to return a command\'s output, and AppContainer needs a compiled helper this extension deliberately does not ship. Windows does have two container sandboxes though — set navy.sandboxMode to "wsl" (WSL Containers, no Docker Desktop needed) or "docker", or to "off" to run commands directly.' };
  }

  // Called when navy.sandboxMode changes, and once at activation. Warns rather
  // than reverting: the setting is the user's, and silently rewriting it would
  // be a worse surprise than a message.
  async warnIfSandboxUnavailable() {
    const cfg = vscode.workspace.getConfiguration('navy');
    const mode = cfg.get('sandboxMode', 'off');
    const win = process.platform === 'win32';

    // 'wsl' where it cannot run — the wrong OS, or Windows without the runtime.
    // It would refuse every command until changed, so say so when it is set.
    if (mode === 'wsl') {
      if (win && await this._wslcAvailable()) return; // set correctly and present
      if (this._warnedSandboxUnavailable === mode) return;
      this._warnedSandboxUnavailable = mode;
      const [msg, alt, altMode] = win
        ? ['Navy: navy.sandboxMode is "wsl", but the WSL container runtime (wslc) was not found — every command will be refused until it is installed. Run "wsl --update --pre-release" (needs WSL 2.9.3+), or use Docker.', 'Use Docker', 'docker']
        : ['Navy: navy.sandboxMode is "wsl", but WSL Containers is Windows-only — every command will be refused here. Use the native sandbox on macOS/Linux, or Docker.', 'Use native', 'native'];
      const pick = await vscode.window.showWarningMessage(msg, alt, 'Turn sandboxing off');
      if (pick === alt) await cfg.update('sandboxMode', altMode, vscode.ConfigurationTarget.Global);
      else if (pick === 'Turn sandboxing off') await cfg.update('sandboxMode', 'off', vscode.ConfigurationTarget.Global);
      return;
    }

    // 'native' on Windows: no native backend. Offer WSL Containers FIRST when it
    // is actually installed — it isolates on Windows with no Docker Desktop —
    // then Docker, then off.
    if (mode !== 'native' || !win) return;
    if (this._warnedSandboxUnavailable === mode) return;
    this._warnedSandboxUnavailable = mode;
    const hasWslc = await this._wslcAvailable();
    const pick = await vscode.window.showWarningMessage(
      'Navy: navy.sandboxMode is "native", which Windows has no support for — every command will be refused until you change it.'
      + (hasWslc
        ? ' WSL Containers (wslc) is installed here and isolates on Windows without Docker Desktop.'
        : ' Docker sandboxing does work on Windows.'),
      ...(hasWslc ? ['Use WSL container'] : []), 'Use Docker', 'Turn sandboxing off');
    if (pick === 'Use WSL container') {
      await cfg.update('sandboxMode', 'wsl', vscode.ConfigurationTarget.Global);
    } else if (pick === 'Use Docker') {
      await cfg.update('sandboxMode', 'docker', vscode.ConfigurationTarget.Global);
    } else if (pick === 'Turn sandboxing off') {
      await cfg.update('sandboxMode', 'off', vscode.ConfigurationTarget.Global);
    }
  }

  // A project's own devcontainer/Dockerfile is always preferred, and Navy will
  // still never GUESS an image — running `npm test` in an image with no node in
  // it fails in a way that looks like the test suite broke. But "will not guess"
  // and "will not accept an answer" are different things, and conflating them
  // was the second barrier on Windows.
  //
  // Windows has no native backend, so Docker is the only sandbox available
  // there — and it was reachable only by projects that already carried a
  // devcontainer, which most do not. The user naming an image is not a guess.
  // navy.sandboxImage is that answer, consulted only when the project has
  // nothing of its own.
  _configuredSandboxImage() {
    const raw = vscode.workspace.getConfiguration('navy').get('sandboxImage', '');
    const image = String(raw || '').trim();
    // A tag with a space in it cannot be a real image reference and would be
    // spliced straight into a `docker run` argv, so refuse rather than pass it
    // through and produce an incomprehensible Docker error.
    return image && !/\s/.test(image) ? image : '';
  }

  // What image a project of this shape would plausibly want. Used ONLY to
  // populate the suggestion in the offer below — never applied on its own,
  // because a wrong guess produces commands that fail for reasons that look
  // nothing like a wrong image.
  _suggestSandboxImage(root) {
    const has = (f) => { try { return fs.existsSync(path.join(root, f)); } catch { return false; } };
    if (has('package.json')) return 'node:20';
    if (has('pyproject.toml') || has('requirements.txt') || has('manage.py')) return 'python:3.12';
    if (has('go.mod')) return 'golang:1.22';
    if (has('Cargo.toml')) return 'rust:1';
    if (has('Gemfile')) return 'ruby:3.3';
    if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) return 'maven:3-eclipse-temurin-21';
    return '';
  }

  // Shown once per session when sandboxing is on, Docker is there, and the only
  // thing missing is an image. Offering beats refusing repeatedly: the refusal
  // is correct but it is also a dead end, and on Windows it is the dead end
  // every user without a devcontainer hits.
  async offerSandboxImage(root) {
    if (this._offeredSandboxImage) return;
    this._offeredSandboxImage = true;
    const suggestion = this._suggestSandboxImage(root);
    const pick = await vscode.window.showWarningMessage(
      `Navy: sandboxing is on, but ${path.basename(root)} has no .devcontainer or Dockerfile, so there is no image to run commands in.`
      + (suggestion ? ` This looks like a project that would run in ${suggestion} — Navy can use it as the default image for every project that has no config of its own, so you set this up once, not per repo.` : ''),
      ...(suggestion ? [`Use ${suggestion} for all projects`] : []), 'Choose an image…', 'Turn sandboxing off');
    if (!pick) return;
    if (pick === 'Turn sandboxing off') {
      await vscode.workspace.getConfiguration('navy').update('sandboxMode', 'off', vscode.ConfigurationTarget.Global);
      return;
    }
    let image = suggestion;
    if (pick === 'Choose an image…') {
      image = await vscode.window.showInputBox({
        prompt: 'Container image to run sandboxed commands in — applies to every project without its own config',
        placeHolder: suggestion || 'node:20',
        value: suggestion,
        validateInput: (v) => (!v || /\s/.test(v.trim()) ? 'An image reference, e.g. node:20' : undefined),
      });
    }
    if (!image) return;
    // GLOBAL by default — one image for every project that has no config of its
    // own, so a sandbox is set up ONCE (in your user settings) rather than a
    // devcontainer created repo by repo. This is deliberately the opposite of the
    // old per-workspace default: a single fallback image is what most people
    // want, and a project whose toolchain differs still wins with its OWN
    // devcontainer/Dockerfile (which always beats this), or with navy.sandboxImage
    // set for that workspace by hand. The tradeoff is real — a Node image applied
    // to a Python repo fails confusingly — but it is the user's stated choice
    // here, and the project's own config is the escape hatch.
    await vscode.workspace.getConfiguration('navy').update(
      'sandboxImage', image.trim(), vscode.ConfigurationTarget.Global);
  }

  // Shown appended to every command-approval card so the user knows which
  // mode is about to run — computed from the raw setting rather than the
  // resolution outcome, since resolution (Docker running? config present?)
  // only happens after approval; a refusal still surfaces plainly as the
  // tool's result if sandboxing was requested but couldn't proceed.
  _sandboxLabelSuffix() {
    const mode = vscode.workspace.getConfiguration('navy').get('sandboxMode', 'off');
    if (mode === 'docker') return ' (sandboxed: docker)';
    if (mode === 'wsl') return ' (sandboxed: wsl)';
    if (mode === 'native') return ' (sandboxed: native)';
    return '';
  }

  // ── Persistent background processes (opt-in via navy.persistBackgroundProcesses) ─
  // Off by default — zero behavior change unless the user turns it on. Today,
  // run_project/start_process children are killed outright whenever this
  // window reloads or the extension deactivates (see _disposeSession) — fine
  // for a one-off command, but it means a long dev server has to be
  // restarted after every single reload. When this setting is on, those
  // children are spawned fully detached (unref'd, and — Windows too, which
  // previously never detached at all) and simply left running instead of
  // killed. Per Node's own documented behavior, a detached child only
  // actually survives its parent exiting if its stdio is NOT an inherited
  // pipe (the pipe's read end is owned by the parent and disappears with
  // it) — so persisted output goes to a real log file under .navy/bg-logs/
  // instead of the in-memory buffer/live webview streaming a normal
  // (non-persisted) process gets. A small manifest (.navy/bg-processes.json)
  // records what's still out there so a later window can find it and offer
  // to stop it — the alternative is a leaked process nobody but Task
  // Manager/`ps` would ever notice.
}

module.exports = {
  SANDBOX_METHODS: SandboxMethods.prototype,
  stripJsonComments,
};
