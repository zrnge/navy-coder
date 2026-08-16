// ── Global project catalog (projects.json) ──────────────────────────────────
// navy.projectRoot and vscode.workspace.workspaceFolders both only ever
// describe THIS window — a project used in a window that's since closed had
// no way to be picked again except re-browsing for its folder from scratch.
// This is a small, user-inspectable catalog (plain JSON under VS Code's
// per-extension global storage — same spirit as the per-project .navy/ files,
// just not scoped to any one project) of every root Navy has ever been pointed
// at, across every window, so it can be resumed from the dropdown regardless of
// what's open right now. See openFolder/_activateProjectRoot for where it's kept
// up to date, and sendWorkspaceFolders for where it reaches the webview.
//
// Extracted from extension.js unchanged. These are still methods on
// NavyCoderViewProvider — mixed into its prototype at the bottom of
// extension.js — so `this` means what it always did and no call site or
// signature changed. The JSON read/write/read-modify-write helpers they use
// (_readJsonFile, _writeJsonFile, _rmwJsonFile) deliberately stayed behind:
// they are shared with the chat and background-process files, and moving them
// here would have made this module the owner of something it doesn't own.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fold, foldPath } = require('./paths.js');

const PROJECT_CATALOG_METHODS = {
  _globalProjectsDir() {
    // Overridable so tests never touch the real user's storage. The env var is
    // the belt to the per-instance override's braces: suites that exercise
    // project switching reach _recordProjectUsage indirectly (via
    // _activateProjectRoot) on providers they never thought to override, and
    // were writing their temp-dir paths into the developer's real catalog —
    // found there during a review, dozens of entries.
    if (this._globalProjectsDirOverride) return this._globalProjectsDirOverride;
    if (process.env.NAVY_HOME) return path.join(process.env.NAVY_HOME, '.navy');
    // VS Code's own per-extension global storage. This used to be ~/.navy,
    // which is wrong in four ways that all bite real users: it is shared across
    // VS Code profiles and between Stable and Insiders (so two profiles fought
    // over one catalog — the contention _rmwJsonFile's retry exists to survive),
    // it is not removed when the extension is uninstalled, it is not covered by
    // Settings Sync, and over SSH/WSL `~` resolves on the remote host rather
    // than where the user thinks. globalStorageUri has none of those problems.
    const managed = this.context?.globalStorageUri?.fsPath;
    if (managed) return managed;
    return path.join(os.homedir(), '.navy'); // no globalStorageUri (very old VS Code)
  },

  // Where the catalog lived before 0.2.7. Kept only so it can be migrated.
  _legacyGlobalProjectsPath() {
    return path.join(os.homedir(), '.navy', 'projects.json');
  },

  // Moves a pre-0.2.7 catalog into VS Code's managed storage, once. Runs before
  // the first read or write so an upgrading user's project list survives the
  // move rather than silently starting empty.
  //
  // The old file is deliberately LEFT in place: it is the user's data in a
  // location they were told about, deleting it buys nothing, and if they roll
  // back to 0.2.6 it still works.
  async _migrateGlobalProjectsOnce() {
    if (this._globalProjectsMigrated) return;
    this._globalProjectsMigrated = true;
    // An explicit redirect means storage is deliberately isolated (tests), and
    // there is nothing to migrate INTO it. Without this the migration read the
    // developer's real ~/.navy/projects.json and copied all 100 entries into
    // the test's temp catalog, so suites that assert on its contents saw a
    // hundred of someone else's projects.
    if (this._globalProjectsDirOverride || process.env.NAVY_HOME) return;
    const target = this._globalProjectsPath();
    const legacy = this._legacyGlobalProjectsPath();
    if (foldPath(target) === foldPath(legacy)) return; // already pointing there
    try { await fs.promises.access(target); return; } catch {} // target exists — nothing to do
    let parsed;
    try { parsed = JSON.parse(await fs.promises.readFile(legacy, 'utf8')); } catch { return; }
    if (!Array.isArray(parsed) || !parsed.length) return;
    await this._writeJsonFile(target, parsed, 'global project catalog (migration)');
    this.log?.(`migrated ${parsed.length} remembered project(s) into ${target}`);
  },

  _globalProjectsPath() {
    return path.join(this._globalProjectsDir(), 'projects.json');
  },

  async _readGlobalProjects() {
    await this._migrateGlobalProjectsOnce();
    const parsed = await this._readJsonFile(this._globalProjectsPath(), []);
    if (!Array.isArray(parsed)) return [];
    const entries = parsed.filter(p => p && typeof p.path === 'string');
    // Drop entries whose folder no longer exists — a moved/deleted project
    // shouldn't linger in the picker forever offering a dead path. Not
    // rewritten back to disk here (that would mean a write on every single
    // read); a stale entry is dropped for real the next time _recordProjectUsage
    // rewrites the file for an unrelated reason.
    //
    // Async and concurrent, deliberately: this runs on every
    // sendWorkspaceFolders (startup, every project switch, every workspace
    // folder change), and the catalog holds up to 100 entries. A synchronous
    // existsSync loop put up to 100 blocking stat calls on the extension host's
    // single thread each time — and against a path on a disconnected network
    // share, ONE of those can block for seconds, freezing the whole editor.
    const alive = await Promise.all(entries.map(async (p) => {
      try { await fs.promises.access(p.path); return p; } catch { return null; }
    }));
    return alive.filter(Boolean);
  },

  async _writeGlobalProjects(list) {
    await this._writeJsonFile(this._globalProjectsPath(), list, 'global project catalog');
  },

  // Serializes writers WITHIN this window — a plain Promise-chain mutex, same
  // pattern as _withWriteLock, just scoped to the one shared global-catalog
  // file rather than per-project. Two rapid project switches (or the
  // startup restore racing an explicit pick) in the SAME window are fully
  // serialized by this; a DIFFERENT window's writer is handled by
  // _rmwJsonFile's retry instead, since this lock's Promise chain only
  // exists in this process's memory.
  _withGlobalProjectsLock(fn) {
    const run = (this._globalProjectsLock || Promise.resolve()).then(fn, fn);
    this._globalProjectsLock = run.catch(() => {});
    return run;
  },

  // Upserts `root` into the global catalog with a fresh lastOpened timestamp
  // (case-folded path match on Windows, same as every other path-identity
  // check), capped to the most recent 100 entries so the catalog can't grow
  // without bound over years of use.
  async _recordProjectUsage(root) {
    if (!root) return;
    await this._migrateGlobalProjectsOnce();
    // Which recorded folders still exist, resolved BEFORE the read-modify-write
    // (whose mutate step is synchronous). Dead entries have to be dropped here,
    // on the rewrite, because nothing else ever removes them: _readGlobalProjects
    // filters them out for display but deliberately doesn't write back, so a
    // folder that has since been deleted stayed in the file permanently. With a
    // 100-entry cap that is not merely untidy — accumulated dead entries push
    // real projects out of the catalog, which is precisely how "Navy forgot my
    // project" happens.
    // Tracks paths positively CONFIRMED missing, never "paths we saw exist".
    // The distinction is load-bearing: the mutate step below is synchronous and
    // re-reads the file, so it can legitimately see entries this scan never
    // examined — a concurrent write from another project switch. Filtering on
    // an "alive" allow-list silently discarded those; filtering on a
    // confirmed-dead deny-list keeps anything unknown, which is the safe
    // direction for user data.
    const dead = new Set();
    await this._withGlobalProjectsLock(async () => {
      try {
        const existing = await this._readJsonFile(this._globalProjectsPath(), []);
        await Promise.all((Array.isArray(existing) ? existing : []).map(async (p) => {
          if (!p || typeof p.path !== 'string') return;
          try { await fs.promises.access(p.path); } catch { dead.add(fold(p.path)); }
        }));
      } catch {}
      return this._rmwJsonFile(this._globalProjectsPath(), [], (list) => {
        const arr = Array.isArray(list) ? list : [];
        const next = arr.filter(p => p && typeof p.path === 'string'
          && fold(p.path) !== fold(root)
          && !dead.has(fold(p.path)));
        // Forced strictly ahead of every entry already present, rather than
        // trusting Date.now() to have moved. Two projects opened in quick
        // succession can land in the SAME millisecond — the sort then sees a tie,
        // leaves them in array order, and "most recently used" silently reports
        // the wrong project first. Rare on Windows (coarse clock, slow I/O
        // between the calls), routine on Linux, which is exactly the kind of
        // difference that only shows up once it is someone else's machine.
        const newest = arr.reduce((max, p) => Math.max(max, p?.lastOpened || 0), 0);
        const lastOpened = Math.max(Date.now(), newest + 1);
        next.push({ path: root, name: path.basename(root), lastOpened });
        next.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
        return next.slice(0, 100);
      });
    });
  },
};

module.exports = { PROJECT_CATALOG_METHODS };
