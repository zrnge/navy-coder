'use strict';

// Navy without VS Code: what the `navy` command (src/cli.js) runs on, so /audit
// and /playthrough can gate a CI pipeline.
//
// The extension runs here unchanged. Its one link to the editor is
// require('vscode'), so this module answers that require with a stand-in:
// settings come from the command line, the environment and package.json's own
// defaults; the filesystem is the real one; and since nothing can open a
// dialog, every question gets the answer that changes nothing. Navy has no
// runtime dependencies, so this runs straight from a checkout, with no install.
//
// A headless run is read-only by construction, not by approval: the tools that
// change files are replaced with a refusal before the model sees them.
// Commands are refused as well unless --allow-commands is given, with one
// exception - /playthrough's own browser, which is the point of running it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const PACKAGE = require('../package.json');
const REPO_ROOT = path.resolve(__dirname, '..');

// Where each provider's key is looked for. NAVY_API_KEY is the fallback for all.
const KEY_ENV = {
  anthropic: ['ANTHROPIC_API_KEY'], openai: ['OPENAI_API_KEY'], deepseek: ['DEEPSEEK_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], xai: ['XAI_API_KEY'], zai: ['ZAI_API_KEY'],
  groq: ['GROQ_API_KEY'], openrouter: ['OPENROUTER_API_KEY'], moonshot: ['MOONSHOT_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'], minimax: ['MINIMAX_API_KEY'], mimo: ['MIMO_API_KEY'],
  ollama: ['OLLAMA_API_KEY'], lmstudio: [], custom: [],
};

// The tools that change files or Navy's saved memory of a project. A headless
// run replaces every one of them with a refusal.
const WRITE_TOOL_METHODS = [
  'toolWriteFile', 'toolApplyEdit', 'toolEditLine', 'toolDeleteLine', 'toolInsertAfterLine',
  'toolDeleteFile', 'toolRenameFile', 'toolRenameSymbol', 'toolRemember', 'toolForget',
];
const READ_ONLY_REFUSAL = 'Refused: this is a headless Navy run, which is read-only — it never changes files or saved memory. Report what you would change instead.';

function apiKeyFromEnv(secretKey, env) {
  const m = /^navy\.apiKey(?:\.(.+))?$/.exec(String(secretKey || ''));
  if (!m) return undefined;
  for (const name of KEY_ENV[m[1]] || []) if (env[name]) return env[name];
  return env.NAVY_API_KEY || undefined;
}

function toUri(p) {
  const fsPath = path.resolve(String(p));
  const posix = fsPath.replace(/\\/g, '/');
  return { fsPath, path: posix, scheme: 'file', toString: () => 'file://' + (posix.startsWith('/') ? '' : '/') + posix };
}

function parseUri(s) {
  const str = String(s);
  if (/^file:\/\//i.test(str)) return toUri(decodeURIComponent(str.replace(/^file:\/\/\/?/i, process.platform === 'win32' ? '' : '/')));
  const colon = str.indexOf(':');
  const rest = colon > 0 ? str.slice(colon + 1) : str;
  return { scheme: colon > 0 ? str.slice(0, colon) : 'file', path: rest, fsPath: rest, toString: () => str };
}

// The `vscode` module, as far as Navy uses it, for a process with no editor.
function createVscodeShim({ root, settings = {}, log = () => {} }) {
  const defaults = {};
  for (const [key, spec] of Object.entries(PACKAGE.contributes?.configuration?.properties || {})) {
    if (key.startsWith('navy.') && 'default' in spec) defaults[key.slice(5)] = spec.default;
  }
  const values = { ...defaults, ...settings };
  const bare = (k) => String(k).replace(/^navy\./, '');
  const disposable = () => ({ dispose() {} });
  const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range {
    constructor(a, b, c, d) {
      if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); }
      else { this.start = a; this.end = b; }
    }
  }
  class EventEmitter {
    constructor() {
      this.listeners = new Set();
      this.event = (fn) => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; };
    }
    fire(value) { for (const fn of [...this.listeners]) { try { fn(value); } catch { /* a listener's problem */ } } }
    dispose() { this.listeners.clear(); }
  }

  const textDocument = (fsPath, text) => {
    const lines = text.split('\n');
    const offset = (p) => {
      let o = 0;
      for (let i = 0; i < Math.min(p.line, lines.length); i++) o += lines[i].length + 1;
      return Math.min(o + (p.line < lines.length ? p.character : 0), text.length);
    };
    return {
      uri: toUri(fsPath), fileName: fsPath, languageId: path.extname(fsPath).slice(1) || 'plaintext',
      lineCount: lines.length, isDirty: false,
      getText: (range) => (range ? text.slice(offset(range.start), offset(range.end)) : text),
      lineAt: (i) => ({ text: lines[typeof i === 'number' ? i : i.line] || '' }),
    };
  };

  const config = {
    get: (k, d) => (bare(k) in values ? values[bare(k)] : d),
    has: (k) => bare(k) in values,
    update: async (k, v) => { values[bare(k)] = v; },
    inspect: (k) => ({ key: 'navy.' + bare(k), defaultValue: defaults[bare(k)], globalValue: settings[bare(k)] }),
  };
  const noConfig = { get: (k, d) => d, has: () => false, update: async () => {}, inspect: () => undefined };
  const folders = [{ uri: toUri(root), name: path.basename(root), index: 0 }];

  const vscode = {
    version: '1.90.0',
    env: {
      appRoot: '', appName: 'Navy CLI', language: 'en', machineId: 'navy-cli', uriScheme: 'vscode',
      clipboard: { readText: async () => '', writeText: async () => {} },
      openExternal: async () => false,
      asExternalUri: async (u) => u,
    },
    Uri: { file: toUri, parse: parseUri, joinPath: (base, ...segs) => toUri(path.join(base.fsPath, ...segs)) },
    Position, Range, Selection: Range, EventEmitter, FileType,
    ThemeColor: class { constructor(id) { this.id = id; } },
    CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
    CodeAction: class { constructor(title, kind) { this.title = title; this.kind = kind; } },
    InlineCompletionItem: class { constructor(insertText, range) { this.insertText = insertText; this.range = range; } },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    CodeActionKind: { QuickFix: 'quickfix', Refactor: 'refactor' },
    SymbolKind: {
      File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7,
      Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14,
      Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21, Struct: 22,
      Event: 23, Operator: 24, TypeParameter: 25,
    },
    workspace: {
      workspaceFolders: folders,
      name: path.basename(root),
      // The person running `navy` pointed it at this folder on purpose.
      isTrusted: true,
      textDocuments: [],
      getConfiguration: (section) => (!section || section === 'navy' ? config : noConfig),
      fs: {
        readFile: async (u) => new Uint8Array(await fs.promises.readFile(u.fsPath)),
        writeFile: async (u, data) => {
          await fs.promises.mkdir(path.dirname(u.fsPath), { recursive: true });
          await fs.promises.writeFile(u.fsPath, Buffer.from(data));
        },
        delete: async (u, opts = {}) => fs.promises.rm(u.fsPath, { recursive: Boolean(opts.recursive) }),
        rename: async (a, b, opts = {}) => {
          if (opts.overwrite === false && fs.existsSync(b.fsPath)) throw new Error('EEXIST: ' + b.fsPath);
          await fs.promises.rename(a.fsPath, b.fsPath);
        },
        copy: async (a, b) => fs.promises.copyFile(a.fsPath, b.fsPath),
        stat: async (u) => {
          const st = await fs.promises.stat(u.fsPath);
          return { type: st.isDirectory() ? FileType.Directory : FileType.File, size: st.size, ctime: st.ctimeMs, mtime: st.mtimeMs };
        },
        createDirectory: async (u) => { await fs.promises.mkdir(u.fsPath, { recursive: true }); },
        readDirectory: async (u) => (await fs.promises.readdir(u.fsPath, { withFileTypes: true }))
          .map(e => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]),
      },
      asRelativePath: (p) => {
        const fp = typeof p === 'string' ? p : (p && p.fsPath) || '';
        const rel = path.relative(root, fp);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : fp;
      },
      openTextDocument: async (arg) => {
        if (arg && typeof arg === 'object' && !arg.fsPath) {
          return textDocument(path.join(os.tmpdir(), 'untitled'), String(arg.content || ''));
        }
        const fp = typeof arg === 'string' ? arg : arg.fsPath;
        return textDocument(fp, await fs.promises.readFile(fp, 'utf8'));
      },
      findFiles: async () => [],
      createFileSystemWatcher: () => ({ onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable, dispose() {} }),
      onDidChangeWorkspaceFolders: disposable,
      onDidChangeConfiguration: disposable,
      onDidSaveTextDocument: disposable,
      onDidChangeTextDocument: disposable,
      onDidOpenTextDocument: disposable,
      registerTextDocumentContentProvider: disposable,
      applyEdit: async () => false,
      updateWorkspaceFolders: () => false,
    },
    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      terminals: [],
      showInformationMessage: async (m) => { log('info: ' + m); return undefined; },
      showWarningMessage: async (m) => { log('warning: ' + m); return undefined; },
      showErrorMessage: async (m) => { log('error: ' + m); return undefined; },
      showInputBox: async () => undefined,
      showQuickPick: async () => undefined,
      showOpenDialog: async () => undefined,
      showSaveDialog: async () => undefined,
      showTextDocument: async () => ({}),
      withProgress: async (_opts, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: disposable }),
      createOutputChannel: () => ({ appendLine: log, append: log, show() {}, hide() {}, clear() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '', command: '', name: '' }),
      createTextEditorDecorationType: () => ({ dispose() {} }),
      setStatusBarMessage: disposable,
      onDidChangeActiveTextEditor: disposable,
      onDidChangeVisibleTextEditors: disposable,
      registerWebviewViewProvider: disposable,
    },
    languages: {
      getDiagnostics: () => [],
      registerInlineCompletionItemProvider: disposable,
      registerCodeLensProvider: disposable,
      registerCodeActionsProvider: disposable,
    },
    commands: { executeCommand: async () => undefined, registerCommand: disposable },
    extensions: { getExtension: () => undefined, all: [] },
  };
  return vscode;
}

// Answers require('vscode') with the shim. Returns the undo.
function installVscode(vscode) {
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return vscode;
    return original.call(this, request, ...rest);
  };
  return () => { Module._load = original; };
}

function createHeadlessContext({ storageDir, env }) {
  const memento = () => {
    const m = new Map();
    return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); }, keys: () => [...m.keys()], setKeysForSync() {} };
  };
  return {
    secrets: {
      get: async (key) => apiKeyFromEnv(key, env),
      store: async () => {},
      delete: async () => {},
      onDidChange: () => ({ dispose() {} }),
    },
    subscriptions: [],
    globalState: memento(),
    workspaceState: memento(),
    globalStorageUri: toUri(storageDir),
    storageUri: toUri(storageDir),
    logUri: toUri(storageDir),
    extensionUri: toUri(REPO_ROOT),
    extensionPath: REPO_ROOT,
    asAbsolutePath: (p) => path.join(REPO_ROOT, p),
    extension: { id: 'Zrnge.navy-coder', packageJSON: PACKAGE },
    extensionMode: 1,
  };
}

// A one-line summary of a tool call for the progress log.
function describeCall(tool, args = {}) {
  const shown = args.url || args.path || args.command || args.query || args.name || args.ref;
  return shown === undefined ? tool : `${tool} ${String(shown).slice(0, 100)}`;
}

// Stands in for the panel: prints progress, and answers every approval the
// way a read-only run must. An approval is registered a moment after the
// message announcing it, so the answer waits until there is something to answer.
function createHeadlessView(provider, { note, allowCommands }) {
  const state = { error: '', refusedCommands: [], refusedEdits: [], calls: 0 };
  const answerWhenAsked = (pending, id, answer) => {
    let tries = 0;
    const tick = () => {
      if (pending().has(id)) answer();
      else if (tries++ < 1000) setTimeout(tick, 10);
    };
    tick();
  };
  const webview = {
    postMessage: async (m) => {
      if (!m || typeof m !== 'object') return true;
      if (m.type === 'toolCall') {
        state.calls++;
        note('  → ' + describeCall(m.tool, m.args));
      } else if (m.type === 'pendingCommand') {
        const ok = Boolean(allowCommands) || m.kind === 'browser-launch';
        if (!ok) {
          state.refusedCommands.push(m.command);
          note(`  ✗ refused to run "${m.command}" — pass --allow-commands to allow commands`);
        }
        answerWhenAsked(() => provider.pendingCommandApprovals, m.id, () => provider.resolveCommandApproval(m.id, ok));
      } else if (m.type === 'pendingDiff') {
        state.refusedEdits.push(m.path);
        note(`  ✗ refused to change ${m.path} — a headless run never edits files`);
        answerWhenAsked(() => provider.pendingApprovals, m.id, () => provider.resolveApproval(m.id, false));
      } else if (m.type === 'error') {
        state.error = String(m.message || 'unknown error');
      }
      return true;
    },
    asWebviewUri: (u) => u,
    cspSource: '',
    options: {},
    html: '',
    onDidReceiveMessage: () => ({ dispose() {} }),
  };
  return { webview, state, visible: true, show() {}, onDidDispose: () => ({ dispose() {} }), onDidChangeVisibility: () => ({ dispose() {} }) };
}

// Everything a headless command needs, started: the shim installed, the
// extension loaded, a provider bound to the project, and the stand-in panel.
function startHeadless({ root, settings = {}, env = process.env, note = () => {}, verbose = false, allowCommands = false }) {
  const log = verbose ? (m) => note('  · ' + m) : () => {};
  const vscode = createVscodeShim({ root, settings, log });
  const uninstall = installVscode(vscode);
  const { NavyCoderViewProvider } = require('./extension.js');
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-cli-'));
  const provider = new NavyCoderViewProvider(createHeadlessContext({ storageDir, env }));
  provider.log = log;
  provider.projectRoot = root;
  // Read-only: the tools that change files are gone, and so is the one path
  // that writes code without a tool (applying a reply's code blocks).
  for (const name of WRITE_TOOL_METHODS) {
    if (typeof provider[name] !== 'function') throw new Error(`headless: expected ${name} on the provider — was it renamed?`);
    provider[name] = async () => READ_ONLY_REFUSAL;
  }
  provider.applyCode = async () => {};
  // A headless run is not one of your chats: nothing is saved to .navy/chats.
  provider.saveProjectSession = async () => {};
  const view = createHeadlessView(provider, { note, allowCommands });
  provider.view = view;

  return {
    vscode, provider, view, root,
    // One model turn; returns Navy's reply. Throws on a provider error, or
    // when the turn runs past `timeoutMs`.
    async ask(prompt, { timeoutMs = 20 * 60 * 1000 } = {}) {
      const before = provider.messages.length;
      let timer;
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { provider.abortController?.abort(); } catch { /* already over */ }
          reject(new Error(`the run took longer than ${Math.round(timeoutMs / 60000)} minutes and was stopped`));
        }, timeoutMs);
      });
      try {
        await Promise.race([provider.askNavy(prompt, false, null, [], []), timedOut]);
      } finally {
        clearTimeout(timer);
      }
      if (view.state.error) throw new Error(view.state.error);
      const reply = provider.messages.slice(before).reverse().find(m => m.role === 'assistant');
      return reply ? String(reply.text || '') : '';
    },
    async close() {
      // Close any browser gracefully and give Chrome the moment it needs to
      // let go of its temporary profile, so the profile can be deleted.
      let hadBrowser = false;
      for (const s of provider.sessions.values()) {
        if (!s.browser) continue;
        hadBrowser = true;
        try { await s.browser.close(); } catch { /* already gone */ }
        s.browser = null;
      }
      try { provider.dispose(); } catch { /* best effort */ }
      if (hadBrowser) await new Promise(r => setTimeout(r, 1700));
      try { fs.rmSync(storageDir, { recursive: true, force: true }); } catch { /* temp dir */ }
      uninstall();
    },
  };
}

module.exports = {
  createVscodeShim, installVscode, createHeadlessContext, createHeadlessView, startHeadless,
  apiKeyFromEnv, describeCall, WRITE_TOOL_METHODS, READ_ONLY_REFUSAL, KEY_ENV,
};
