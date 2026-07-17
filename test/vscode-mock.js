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
    },
    nextWarning: undefined,           // value the next showWarningMessage resolves to
    nextRename: null,                 // [{ fsPath, newText }] the fake rename provider returns
    shown: { warning: [], info: [], error: [] },
    reset() { this.nextWarning = undefined; this.nextRename = null; this.shown = { warning: [], info: [], error: [] }; },
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
  };

  const configApi = {
    get: (k, d) => (k in ctrl.config ? ctrl.config[k] : d),
    update: async () => {},
    inspect: () => ({ workspaceValue: undefined, globalValue: undefined }),
  };

  const vscode = {
    FileType,
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    Uri: { file: uri, parse: (s) => uri(s) },
    ThemeColor: class { constructor(id) { this.id = id; } },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
    Position: class { constructor(line, ch) { this.line = line; this.character = ch; } },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => configApi,
      fs: wfs,
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      asRelativePath: (p) => (p && p.fsPath) || p,
      openTextDocument: async () => ({ getText: () => '' }),
      // Applies a fake structural-rename WorkspaceEdit to the temp filesystem.
      applyEdit: async (edit) => {
        if (edit && edit.__rename) { for (const r of edit.__rename) fs.writeFileSync(r.fsPath, r.newText); return true; }
        return false;
      },
    },
    window: {
      visibleTextEditors: [],
      activeTextEditor: undefined,
      createTextEditorDecorationType: () => ({ dispose() {} }),
      showWarningMessage: async (msg) => { ctrl.shown.warning.push(msg); return ctrl.nextWarning; },
      showInformationMessage: async (msg) => { ctrl.shown.info.push(msg); return undefined; },
      showErrorMessage: async (msg) => { ctrl.shown.error.push(msg); return undefined; },
      createStatusBarItem: () => ({ show() {}, dispose() {}, text: '', tooltip: '', command: '', name: '' }),
    },
    languages: { getDiagnostics: () => [] },
    commands: {
      executeCommand: async (cmd) => {
        if (cmd === 'vscode.executeDocumentRenameProvider') {
          if (!ctrl.nextRename) return undefined; // no rename provider / not renameable
          const files = ctrl.nextRename;
          return { __rename: files, entries: () => files.map(r => [uri(r.fsPath), []]) };
        }
        return undefined;
      },
      registerCommand: () => ({ dispose() {} }),
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    CodeActionKind: { QuickFix: 'quickfix' },
    SymbolKind: {},
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
  return {
    secrets: { get: async () => '', store: async () => {} },
    subscriptions: [],
    globalState: { get: () => undefined, update: async () => {} },
    extensionUri: { fsPath: tmp, path: tmp, scheme: 'file' },
    extension: { packageJSON: { version: 'test' } },
  };
}

module.exports = { createVscodeMock, installVscodeMock, uninstallVscodeMock, makeContext };
