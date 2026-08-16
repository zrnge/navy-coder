// Minimal `vscode` mock for unit-testing fs-coupled extension logic.
//
// workspace.fs is backed by the REAL node fs against a temp directory, so undo /
// redo / checkpoint code runs end-to-end against genuine files — the test exercises
// shipped code paths rather than a re-implementation, so it can't drift.
//
// Install BEFORE requiring src/extension.js: installVscodeMock() hooks Module._load
// so `require('vscode')` resolves to this mock.

const fs = require('fs');
const path = require('path');
const Module = require('module');

function createVscodeMock() {
  // Control surface the tests poke at.
  const ctrl = {
    config: {
      approvalMode: 'auto-approve',   // bypass the approval UI in write paths
      model: 'test-model',
      host: 'http://localhost:11434',
      thinkingLevel: 'medium',
      editFormat: 'search-replace',
      maxToolIterations: 50,
      maxContextChars: 12000,
      temperature: 0.2,
      provider: 'ollama',
      codeLens: true,
      inlineCompletions: false,
      providerFallbacks: [],
      persistBackgroundProcesses: false,
    },
    nextWarning: undefined,           // value the next showWarningMessage resolves to
    nextInfo: undefined,              // value the next showInformationMessage resolves to (modal choices)
    nextRename: null,                 // [{ fsPath, newText }] the fake rename provider returns
    nextOpenDialog: null,             // [fsPath] the next showOpenDialog returns, or null for cancel
    nextWorkspaceSymbols: null,       // [{ name, location: { uri: { fsPath }, range } }] the fake symbol provider returns
    nextDocumentSymbols: null,        // [{name,kind}] for every file, or a Map<fsPath, [...]> for per-file control
    executedCommands: [],             // [{ command, args }] — lets tests assert vscode.openFolder etc.
    shown: { warning: [], info: [], error: [] },
    shownInfoCalls: [],               // [{ msg, options, items }] — full showInformationMessage calls, see the mock above
    applyEditFails: false,
    reset() {
      this.nextWarning = undefined; this.nextInfo = undefined; this.nextRename = null;
      this.nextOpenDialog = null; this.applyEditFails = false;
      this.nextWorkspaceSymbols = null;
      this.nextDocumentSymbols = null;
      this.executedCommands = [];
      this.scoped = {};
      this.shown = { warning: [], info: [], error: [] };
      this.shownInfoCalls = [];
    },
  };

  const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
  const uri = (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => p });

  const wfs = {
    async readFile(u) {
      return new Uint8Array(fs.readFileSync(u.fsPath)); // throws ENOENT if missing → callers treat as null
    },
    async writeFile(u, buf) {
      fs.writeFileSync(u.fsPath, Buffer.from(buf));
    },
    async rename(src, dst, opts = {}) {
      if (opts.overwrite === false && fs.existsSync(dst.fsPath)) {
        throw new Error('EEXIST: destination already exists');
      }
      fs.renameSync(src.fsPath, dst.fsPath);
    },
    async delete(u, opts = {}) {
      fs.rmSync(u.fsPath, { recursive: Boolean(opts.recursive), force: true });
    },
    async stat(u) {
      const st = fs.statSync(u.fsPath); // throws if missing
      return { type: st.isFile() ? FileType.File : FileType.Directory, size: st.size, ctime: 0, mtime: 0 };
    },
    async createDirectory(u) {
      fs.mkdirSync(u.fsPath, { recursive: true });
    },
    async readDirectory(u) {
      let entries;
      try { entries = fs.readdirSync(u.fsPath, { withFileTypes: true }); }
      catch (e) { const err = new Error('ENOENT: ' + u.fsPath); throw err; }
      return entries.map((e) => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]);
    },
  };

  // Scoped values, so tests can exercise the workspace-vs-global precedence the
  // real settings system has (a root saved in one project must not leak into
  // another). ctrl.scoped[key] = { workspaceValue, globalValue }.
  ctrl.scoped = {};
  ctrl.watchers = []; // every createFileSystemWatcher call, for the cache-invalidation tests
  const configApi = {
    get: (k, d) => (k in ctrl.config ? ctrl.config[k] : d),
    update: async (k, v, target) => {
      ctrl.config[k] = v;
      const slot = (ctrl.scoped[k] = ctrl.scoped[k] || {});
      // ConfigurationTarget.Global === 1; anything else is workspace-ish.
      if (target === 1) slot.globalValue = v; else slot.workspaceValue = v;
    },
    inspect: (k) => ({
      workspaceValue: ctrl.scoped[k]?.workspaceValue,
      globalValue: ctrl.scoped[k]?.globalValue,
    }),
  };

  const vscode = {
    FileType,
    // No real rg.exe under a tmpdir → _findRipgrep() correctly returns null,
    // so ripgrep-backed tools deterministically exercise their JS-walk fallback
    // in tests rather than depending on the test machine's real VS Code install.
    env: { appRoot: require('os').tmpdir() },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    Uri: { file: uri, parse: (s) => uri(s), joinPath: (base, ...segs) => uri([base.fsPath, ...segs].join('/')) },
    ThemeColor: class { constructor(id) { this.id = id; } },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
    Position: class { constructor(line, ch) { this.line = line; this.character = ch; } },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => configApi,
      fs: wfs,
      // Mirrors the REAL API contract: entries must be { uri } objects, not bare
      // Uris. A bare Uri leaves `.uri` undefined and VS Code rejects the call —
      // reproducing that here is the whole point, otherwise a test can't tell a
      // correct call from the malformed one that silently added nothing.
      updateWorkspaceFolders: (start, deleteCount, ...toAdd) => {
        if (toAdd.some(f => !f || !f.uri || !f.uri.fsPath)) return false;
        const current = vscode.workspace.workspaceFolders || [];
        const next = current.slice();
        next.splice(start, deleteCount || 0, ...toAdd.map(f => ({ uri: f.uri, name: f.name })));
        vscode.workspace.workspaceFolders = next;
        return true;
      },
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      // Records the handlers so a test can fire a file event the way the editor
      // would, and records disposal so the leak is testable too.
      createFileSystemWatcher: (pattern) => {
        const w = {
          pattern, disposed: false,
          onDidCreate: (fn) => { w._create = fn; return { dispose() {} }; },
          onDidChange: (fn) => { w._change = fn; return { dispose() {} }; },
          onDidDelete: (fn) => { w._delete = fn; return { dispose() {} }; },
          dispose: () => { w.disposed = true; },
          // Test helpers — drive the callbacks the editor would fire.
          fire: (kind, fsPath) => w['_' + kind]?.({ fsPath }),
        };
        ctrl.watchers.push(w);
        return w;
      },
      asRelativePath: (p) => (p && p.fsPath) || p,
      openTextDocument: async () => ({ getText: () => '' }),
      // Applies a fake structural-rename WorkspaceEdit to the temp filesystem.
      // Set ctrl.applyEditFails = true to simulate the editor rejecting the edit.
      applyEdit: async (edit) => {
        if (ctrl.applyEditFails) return false;
        if (edit && edit.__rename) { for (const r of edit.__rename) fs.writeFileSync(r.fsPath, r.newText); return true; }
        return false;
      },
    },
    window: {
      visibleTextEditors: [],
      activeTextEditor: undefined,
      createTextEditorDecorationType: () => ({ dispose() {} }),
      showWarningMessage: async (msg) => { ctrl.shown.warning.push(msg); return ctrl.nextWarning; },
      // shownInfoCalls carries the FULL call (options/button labels included) for
      // tests that need to assert on more than the message text — ctrl.shown.info
      // stays string-only so every existing `.some(m => regex.test(m))` check
      // keeps working unmodified.
      showInformationMessage: async (msg, options, ...items) => {
        ctrl.shown.info.push(msg);
        ctrl.shownInfoCalls.push({ msg, options, items });
        return ctrl.nextInfo;
      },
      showOpenDialog: async () => (ctrl.nextOpenDialog ? ctrl.nextOpenDialog.map(uri) : undefined),
      showErrorMessage: async (msg) => { ctrl.shown.error.push(msg); return undefined; },
      createStatusBarItem: () => ({ show() {}, dispose() {}, text: '', tooltip: '', command: '', name: '' }),
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    },
    languages: { getDiagnostics: () => [] },
    commands: {
      executeCommand: async (cmd, ...args) => {
        ctrl.executedCommands.push({ command: cmd, args });
        if (cmd === 'vscode.executeDocumentRenameProvider') {
          if (!ctrl.nextRename) return undefined; // no rename provider / not renameable
          const files = ctrl.nextRename;
          return { __rename: files, entries: () => files.map(r => [uri(r.fsPath), []]) };
        }
        if (cmd === 'vscode.executeWorkspaceSymbolProvider') {
          return ctrl.nextWorkspaceSymbols || undefined; // no language server active
        }
        if (cmd === 'vscode.executeDocumentSymbolProvider') {
          const fp = args[0]?.fsPath;
          // Map → per-file control (different outline per file); plain array →
          // same result for every file; unset → no provider for any file.
          if (ctrl.nextDocumentSymbols instanceof Map) return ctrl.nextDocumentSymbols.get(fp);
          return ctrl.nextDocumentSymbols || undefined;
        }
        return undefined;
      },
      registerCommand: () => ({ dispose() {} }),
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    CodeActionKind: { QuickFix: 'quickfix' },
    // Real values (not just distinct placeholders) — code under test does
    // real Set membership checks against these, e.g. "is this kind a
    // function/class/method worth showing in a repo-map outline".
    SymbolKind: {
      File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
      Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
      Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15,
      Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21,
      Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
    },
  };

  return { vscode, ctrl };
}

let _restore = null;
function installVscodeMock(vscode) {
  const orig = Module._load;
  _restore = () => { Module._load = orig; };
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return vscode;
    return orig.call(this, request, ...rest);
  };
}
function uninstallVscodeMock() { if (_restore) { _restore(); _restore = null; } }

function makeContext(tmp) {
  // workspaceState is backed by a real Map, not a stub: it is now where the
  // remembered project root lives (previously a workspace-scoped setting, which
  // wrote .vscode/settings.json into the user's repo), so tests that exercise
  // "reopen and remember" need it to actually retain values.
  const ws = new Map();
  return {
    secrets: { get: async () => '', store: async () => {} },
    subscriptions: [],
    globalState: { get: () => undefined, update: async () => {} },
    workspaceState: {
      get: (k, d) => (ws.has(k) ? ws.get(k) : d),
      update: async (k, v) => { ws.set(k, v); },
    },
    // VS Code's per-extension, per-profile global storage directory — where the
    // project catalog belongs. Pointed at the temp dir so no test can reach the
    // developer's real profile storage.
    globalStorageUri: { fsPath: require('path').join(tmp, 'globalStorage'), scheme: 'file' },
    extensionUri: { fsPath: tmp, path: tmp, scheme: 'file' },
    extension: { packageJSON: { version: 'test' } },
  };
}

module.exports = { createVscodeMock, installVscodeMock, uninstallVscodeMock, makeContext };
