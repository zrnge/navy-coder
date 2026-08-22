// ── Persistent background processes (navy.persistBackgroundProcesses) ─────────
// The manifest, the log files, and the machinery for deciding whether a pid
// recorded by a previous window is still the process we started — a recycled
// pid must never be killed on our say-so.
//
// Extracted from extension.js unchanged. These are still methods on
// NavyCoderViewProvider — mixed into its prototype at the bottom of
// extension.js — so `this` means what it always did and no call site, no
// signature and no behaviour changed. Written as a class so the block could
// move verbatim; see mixinPrototype in extension.js for how it is applied.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { CHECKER_CWD } = require('./exec.js');

// How many .navy/bg-logs/*.log files a project keeps (see _pruneBgLogs).
// Generous — these are small unless a dev server is genuinely chatty, and the
// point is only to stop unbounded growth over a project's whole lifetime, not
// to be stingy about recent history the user may still want to read back.
const PERSIST_LOG_KEEP = 20;

class BackgroundMethods {
  _persistBgEnabled() {
    return vscode.workspace.getConfiguration('navy').get('persistBackgroundProcesses', false) === true;
  }

  _bgManifestPath(root) { return path.join(root, '.navy', 'bg-processes.json'); }

  // The stable handle for one background task: `navy/<project>/<task>`.
  //
  // A pid is not an identity — it is reused, it means nothing after a restart,
  // and it is not something a person can recognise. This is: it names the
  // project and the task, it is the same string across windows and restarts,
  // and it is what the panel shows, what the log file is named after, and what
  // a stop request refers to. `__run_project__` is spelled `dev-server` here
  // because the path is read by people.
  _taskPathFor(root, id) {
    const project = path.basename(root || '') || 'project';
    const task = id === '__run_project__' ? 'dev-server' : String(id || 'task');
    const safe = (s) => String(s).replace(/[^a-z0-9._-]/gi, '-').replace(/^-+|-+$/g, '') || 'x';
    return `navy/${safe(project)}/${safe(task)}`;
  }

  async _readBgManifest(root) {
    const parsed = await this._readJsonFile(this._bgManifestPath(root), []);
    return Array.isArray(parsed) ? parsed : [];
  }

  async _writeBgManifest(root, list) {
    await this.ensureNavyDir(root); // also seeds .navy/.gitignore — this must never end up committed
    await this._writeJsonFile(this._bgManifestPath(root), list, 'bg-process manifest');
  }

  // Serializes writers to ONE project's manifest WITHIN this window — same
  // pattern as _withGlobalProjectsLock, just per-project (via _projCacheFor,
  // so it works for whatever root a persisted process's OWN exit handler
  // captured, not necessarily whatever's currently active) instead of one
  // global lock, and deliberately its own field rather than reusing
  // _writeLock — a slow unrelated file edit must never delay a sibling tab's
  // background-process bookkeeping, or vice versa. Sibling chat tabs on the
  // same project can genuinely run persisted start_process/run_project calls
  // (or their exit handlers) concurrently, which is exactly the race this
  // closes; _rmwJsonFile's retry underneath is the remaining cross-WINDOW
  // defense, for the narrower case of the same project open in two windows.
  _withBgManifestLock(root, fn) {
    const cache = this._projCacheFor(root);
    const run = (cache.bgManifestLock || Promise.resolve()).then(fn, fn);
    cache.bgManifestLock = run.catch(() => {});
    return run;
  }

  async _addToBgManifest(root, record) {
    return this._withBgManifestLock(root, async () => {
      await this.ensureNavyDir(root);
      return this._rmwJsonFile(this._bgManifestPath(root), [], (list) => [...(Array.isArray(list) ? list : []), record]);
    });
  }

  // Merges fields into the record for one live pid — used when something about
  // a running process becomes known only later, the dev server's URL being the
  // case that matters: it appears in the output seconds after the spawn that
  // wrote the record.
  async _updateBgManifestEntry(root, pid, fields) {
    return this._withBgManifestLock(root, async () => {
      await this.ensureNavyDir(root);
      return this._rmwJsonFile(this._bgManifestPath(root), [], (list) =>
        (Array.isArray(list) ? list : []).map(r => r && r.pid === pid ? { ...r, ...fields } : r));
    });
  }

  async _removeFromBgManifest(root, pid) {
    return this._withBgManifestLock(root, async () => {
      await this.ensureNavyDir(root);
      return this._rmwJsonFile(this._bgManifestPath(root), [], (list) => (Array.isArray(list) ? list : []).filter(r => r.pid !== pid));
    });
  }

  // Opens the real log file a persisted child's stdout/stderr get wired to.
  // Must be a genuine fd (dup'd into the child at spawn time), not a pipe —
  // see the section comment above for why that's what actually makes
  // survival past this process exiting work.
  async _openPersistLog(root, id) {
    await this.ensureNavyDir(root);
    const dir = path.join(root, '.navy', 'bg-logs');
    await fs.promises.mkdir(dir, { recursive: true });
    const safe = String(id).replace(/[^a-z0-9_-]/gi, '_');
    const logPath = path.join(dir, `${safe}-${Date.now()}.log`);
    const fd = fs.openSync(logPath, 'a'); // a real fd, dup'd into the child — see above
    // Opening a new log is the natural moment to retire old ones; nothing else
    // ever revisits this directory, so without it every launch adds a file that
    // stays for the life of the project (a chatty dev server's logs are MBs
    // each). Fire-and-forget: log housekeeping must never delay or fail
    // starting the process the user actually asked for.
    this._pruneBgLogs(dir, logPath).catch(() => {});
    return { fd, logPath };
  }

  // Keeps .navy/bg-logs/ to the most recent PERSIST_LOG_KEEP files. Never
  // touches the log just opened, nor one still named by a live manifest entry —
  // read_process_output reads these back from disk, so deleting one out from
  // under a running process would silently blank its output.
  async _pruneBgLogs(dir, currentLogPath) {
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return; }
    const logs = names.filter(n => n.endsWith('.log'));
    if (logs.length <= PERSIST_LOG_KEEP) return;

    const root = path.dirname(path.dirname(dir)); // .../<root>/.navy/bg-logs → <root>
    const inUse = new Set([currentLogPath]);
    for (const rec of await this._readBgManifest(root)) { if (rec.logPath) inUse.add(rec.logPath); }

    const stated = await Promise.all(logs.map(async (name) => {
      const full = path.join(dir, name);
      try { return { full, mtime: (await fs.promises.stat(full)).mtimeMs }; }
      catch { return null; }
    }));
    const candidates = stated
      .filter(e => e && !inUse.has(e.full))
      .sort((a, b) => b.mtime - a.mtime)          // newest first
      .slice(Math.max(0, PERSIST_LOG_KEEP - inUse.size)); // everything past the keep window
    for (const entry of candidates) {
      try { await fs.promises.unlink(entry.full); } catch {}
    }
  }

  // Kills by bare pid — the manifest-driven orphan cleanup below only ever
  // has a pid from a previous window, never a live ChildProcess object to
  // hand _killProcessTree.
  _killPidTree(pid) {
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, detached: false });
        killer.on('error', () => {});
      } else {
        try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
      }
    } catch {}
  }

  // Existence check, not an actual signal — sending signal 0 is the
  // standard cross-platform way to ask "is this pid still alive" without
  // affecting it. EPERM (rather than ESRCH) still means a real process is
  // there, just not one this user owns.
  _pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }

  // Wall-clock start time of `pid` in epoch ms, or null when it can't be
  // determined (process already gone, query tool unavailable, output not what
  // was expected). Only ever used to prove a pid is still the process we
  // recorded — see _classifyBgRecord.
  // Captures a command's STDOUT ONLY, as its own trimmed lines. Deliberately
  // not _runChecker, which merges stdout and stderr into one string: that is
  // right for a syntax checker (where the diagnostic IS the point) but wrong
  // for parsing a value, since any unrelated warning on stderr lands in front
  // of the answer and corrupts it. Observed for real — under WSL, `ps` prints
  // "your 131072x1 screen size is bogus" to stderr and exits 0, which made
  // every start-time lookup unparseable and so every live process
  // "unverified".
  _runForStdoutLines(bin, args, timeout = 8000) {
    return new Promise((resolve) => {
      let out = '';
      let done = false;
      let timer = null;
      const finish = (lines) => {
        if (done) return;
        done = true;
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(lines);
      };
      try {
        const child = spawn(bin, args, { cwd: CHECKER_CWD, windowsHide: true });
        child.stdout?.on('data', (d) => { out += d.toString(); });
        child.on('close', () => finish(out.split('\n').map(l => l.trim()).filter(Boolean)));
        child.on('error', () => finish([]));
        timer = setTimeout(() => {
          if (done) return;
          this._killProcessTree(child);
          finish([]);
        }, timeout);
      } catch { finish([]); }
    });
  }

  async _pidStartTimeMs(pid) {
    // Both branches scan the captured lines for the first that parses, rather
    // than assuming the value is the whole output — cheap insurance against a
    // banner or notice slipping onto stdout too.
    if (process.platform === 'win32') {
      // Get-Process is the only dependable route on current Windows: wmic is
      // gone from Windows 11 24H2 onward, and tasklist reports no start time.
      const script = `try { [int64]((Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds } catch { '' }`;
      const lines = await this._runForStdoutLines('powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script]);
      for (const line of lines) {
        const ms = Number(line);
        if (Number.isFinite(ms) && ms > 0) return ms;
      }
      return null;
    }
    // POSIX: `lstart` is supported by both Linux (procps) and macOS ps, and is
    // an absolute ctime(3) timestamp ("Sun Aug  9 21:01:12 2026") rather than
    // an elapsed duration — so interpreting it needs no second "and what time
    // is it now" round trip, and Date.parse handles the format directly.
    const lines = await this._runForStdoutLines('ps', ['-o', 'lstart=', '-p', String(Number(pid))]);
    for (const line of lines) {
      const parsed = Date.parse(line);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  // Is `record.pid` still the process this record was written for, or has an
  // unrelated process since inherited that number?
  //
  // This gate stands directly in front of `taskkill /F /T` / `kill(-pid)`, so
  // getting it wrong destroys a stranger's whole process TREE because an
  // integer happened to match. PIDs recycle aggressively — a busy machine can
  // wrap the space within hours, and these records routinely outlive a
  // reboot — so liveness alone proves nothing. Start time is the cheap
  // discriminator: our record knows when we spawned it, and a recycled pid's
  // process necessarily started later.
  //
  // Three outcomes, deliberately not two:
  //   'ours'       — alive and start time matches; safe to offer to stop.
  //   'gone'       — not running, or running with a different start time
  //                  (i.e. recycled); the record is stale, prune it.
  //   'unverified' — alive, but identity could not be established (a manifest
  //                  entry from before startedAt was recorded, or the query
  //                  tool is missing/slow). NEVER killed, and NOT pruned
  //                  either: silently dropping it would leave a real orphan
  //                  running with nothing left pointing at it.
  async _classifyBgRecord(record) {
    if (!this._pidAlive(record.pid)) return 'gone';
    if (!record.startedAt) return 'unverified';
    const started = await this._pidStartTimeMs(record.pid);
    if (started === null) return 'unverified';
    // `ps -o lstart` has one-second resolution, and startedAt is stamped in
    // the parent a moment either side of the child actually starting — so an
    // exact match isn't available. A recycled pid is separated by far more
    // than this tolerance.
    return Math.abs(started - record.startedAt) <= 15000 ? 'ours' : 'gone';
  }

  // Called once per project root per window (see _activateProjectRoot) —
  // prunes manifest entries that are no longer running (so a stale record
  // can't keep re-prompting about a long-dead process), then, if anything
  // genuinely survived, asks whether to stop it. Fire-and-forget from the
  // caller's perspective (never blocks project activation on a modal-less
  // dialog) and always resolves rather than throwing, since it runs unattended
  // off the main activation path.
  async _checkOrphanedBgProcesses(root) {
    if (!root || this._orphanCheckedRoots.has(root)) return;
    this._orphanCheckedRoots.add(root);
    const list = await this._readBgManifest(root);
    if (!list.length) return;

    const classified = await Promise.all(list.map(async (r) => ({ record: r, state: await this._classifyBgRecord(r) })));
    const ours = classified.filter(c => c.state === 'ours').map(c => c.record);
    const unverified = classified.filter(c => c.state === 'unverified').map(c => c.record);

    // Keep everything still running — including what couldn't be identified —
    // and drop only what is provably finished or recycled.
    const keep = [...ours, ...unverified];
    if (keep.length !== list.length) await this._withBgManifestLock(root, () => this._writeBgManifest(root, keep));
    if (!keep.length) return;

    const describe = (r) => `${r.id === '__run_project__' ? 'project' : r.id} (${r.command})`;
    if (!ours.length) {
      // Nothing confirmed ours, but something is still holding those pids.
      // Report rather than act: killing on an unconfirmed match is exactly
      // what this whole path exists to avoid.
      vscode.window.showWarningMessage(
        `Navy has ${unverified.length} background process record(s) from a previous session it could not verify are still the same processes `
        + `(pid ${unverified.map(r => r.pid).join(', ')}: ${unverified.map(describe).join(', ')}). `
        + `They were left alone — stop them yourself if they are still wanted gone.`);
      return;
    }

    // Show them in the panel, not only in a notification. A dialog is a single
    // moment: dismiss it — or miss it, because it arrives while the window is
    // still opening — and there is nothing left anywhere saying a server is
    // still up. These go into the task dock instead, where they sit above the
    // composer with the same Stop button a process started in THIS window has,
    // and where a dev server still carries the address it was serving on.
    this._postRestoredProcesses(root, ours);

    const label = ours.length === 1 ? '1 background process' : `${ours.length} background processes`;
    const names = ours.map(describe).join(', ');
    const unverifiedNote = unverified.length
      ? ` (${unverified.length} further record(s) could not be verified and will be left alone.)`
      : '';
    const choice = await vscode.window.showWarningMessage(
      `Navy left ${label} running from a previous session: ${names}. They are listed above the chat input, where you can stop them individually.${unverifiedNote}`,
      { modal: false }, 'Stop All', 'Leave Running'
    );
    if (choice === 'Stop All') {
      for (const rec of ours) this._killPidTree(rec.pid);
      await this._withBgManifestLock(root, () => this._writeBgManifest(root, unverified));
      this._postRestoredProcesses(root, []);
    }
  }

  // Hands the webview everything that survived, keyed by its task path, and
  // remembers which paths were shown for this root — stopRestoredProcess only
  // ever re-posts those, so a later post can never introduce a row for a
  // process this window owns and is already showing live.
  _postRestoredProcesses(root, records) {
    this._restoredShown = this._restoredShown || new Map();
    this._restoredShown.set(root, new Set(
      records.map(r => r.taskPath || this._taskPathFor(root, r.id))));
    this.view?.webview.postMessage({
      type: 'restoredProcesses',
      root,
      processes: records.map(r => ({
        taskPath: r.taskPath || this._taskPathFor(root, r.id),
        id: r.id,
        label: r.id === '__run_project__' ? (path.basename(root || '') || 'dev server') : String(r.id),
        command: r.command || '',
        url: r.url || '',
        pid: r.pid,
        startedAt: r.startedAt || 0,
      })),
    });
  }

  // Stops one recovered process, by task path rather than by pid: the webview
  // must never be able to name an arbitrary pid to kill. The record is looked
  // up in the manifest and re-verified as ours immediately before the signal —
  // the same check that guards the Stop All path, for the same reason, since
  // minutes may have passed since the classification that put it on screen.
  async stopRestoredProcess(root, taskPath) {
    // Only the rows this window actually put on screen are ever re-posted.
    // Re-sending the whole manifest would hand the panel this window's OWN live
    // dev server as a row labelled "from a previous session", sitting next to
    // the live one it already has.
    const shown = this._restoredShown?.get(root);
    const repost = async () => {
      const list = await this._readBgManifest(root);
      this._postRestoredProcesses(root,
        list.filter(r => shown?.has(r.taskPath || this._taskPathFor(root, r.id))));
    };

    const list = await this._readBgManifest(root);
    const rec = list.find(r => (r.taskPath || this._taskPathFor(root, r.id)) === taskPath);
    if (!rec) {
      // Re-post what IS still there rather than an empty list: an empty one
      // tells the panel to drop every recovered row, including a second process
      // that is still running and still needs its Stop button.
      await repost();
      return 'That process is no longer recorded — nothing to stop.';
    }

    const state = await this._classifyBgRecord(rec);
    if (state === 'unverified') {
      // Left in the manifest on purpose. An unverifiable record is the one case
      // where Navy does not know what it is looking at, and dropping it makes a
      // genuine orphan invisible forever — the opposite of what a record is
      // for. Reported, never pruned, never signalled.
      await repost();
      return 'That pid could not be verified as the process Navy started, so it was left alone and kept on record.';
    }
    if (state === 'gone') {
      await this._withBgManifestLock(root, () => this._writeBgManifest(root, list.filter(r => r !== rec)));
      shown?.delete(taskPath);
      await repost();
      return 'That process had already exited.';
    }

    this._killPidTree(rec.pid);
    await this._withBgManifestLock(root, () => this._writeBgManifest(root, list.filter(r => r !== rec)));
    shown?.delete(taskPath);
    await repost();
    return `Stopped ${taskPath}.`;
  }
}

module.exports = {
  BACKGROUND_METHODS: BackgroundMethods.prototype,
};
