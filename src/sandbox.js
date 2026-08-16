// ── Command-execution sandboxing (navy.sandboxMode) ───────────────────────────
// Off by default. When 'docker', every spawn site routes through
// _maybeWrapForSandbox, so enabling it protects run_command, run_tests,
// run_project and background processes uniformly — and never silently falls
// back to unsandboxed execution when it cannot proceed.
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

  // Resolves (building if needed) the Docker image to run sandboxed commands
  // in — cached per project root, since a `docker build` invocation (even
  // one that resolves instantly off Docker's OWN layer cache) is still a
  // real daemon round-trip, and otherwise repeats before EVERY single
  // sandboxed command in a turn even though the resolved image essentially
  // never changes within a session. Invalidated by re-checking the mtime of
  // whichever config file (devcontainer.json / Dockerfile) actually exists —
  // cheap (one or two stat calls) — so editing either takes effect on the
  // very next command rather than needing a reload.
  async _resolveSandboxImage(root) {
    const cache = this._projCacheFor(root);
    const statMtime = async (p) => { try { return (await fs.promises.stat(p)).mtimeMs; } catch { return null; } };
    const [dcMtime, dfMtime] = await Promise.all([
      statMtime(path.join(root, '.devcontainer', 'devcontainer.json')),
      statMtime(path.join(root, 'Dockerfile')),
    ]);
    const cached = cache.sandboxImageCache;
    if (cached && cached.dcMtime === dcMtime && cached.dfMtime === dfMtime) return cached.result;

    const result = await this._resolveSandboxImageUncached(root);
    cache.sandboxImageCache = { dcMtime, dfMtime, result };
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
  async _resolveSandboxImageUncached(root) {
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
    if (!dockerfilePath) return null;

    // Stable tag derived from the project root — repeated runs reuse Docker's
    // own layer cache (a rebuild with nothing changed is near-instant)
    // instead of accumulating a fresh anonymous image every time.
    const tag = 'navy-sandbox-' + crypto.createHash('md5').update(root).digest('hex').slice(0, 12);
    const build = await this._runChecker('docker', ['build', '-t', tag, '-f', dockerfilePath, context], CHECKER_CWD, 300000);
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
    if (mode !== 'docker') return { ...spec };

    if (!(await this._dockerAvailable())) {
      return { refused: true, message: 'Sandboxed execution requested (navy.sandboxMode is "docker") but Docker is not installed or not running — refusing to run unsandboxed. Start Docker Desktop, or set navy.sandboxMode to "off".' };
    }
    const resolved = await this._resolveSandboxImage(cwd);
    if (!resolved) {
      return { refused: true, message: `Sandboxed execution requested (navy.sandboxMode is "docker") but no .devcontainer/devcontainer.json or Dockerfile was found in ${path.basename(cwd)} — Navy will not guess at a generic image that might not match this project's real toolchain. Add a devcontainer config or Dockerfile, or set navy.sandboxMode to "off".` };
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

  // Shown appended to every command-approval card so the user knows which
  // mode is about to run — computed from the raw setting rather than the
  // resolution outcome, since resolution (Docker running? config present?)
  // only happens after approval; a refusal still surfaces plainly as the
  // tool's result if sandboxing was requested but couldn't proceed.
  _sandboxLabelSuffix() {
    return vscode.workspace.getConfiguration('navy').get('sandboxMode', 'off') === 'docker' ? ' (sandboxed)' : '';
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
