const { streamAssistant, parseToolCalls, extractCodeEdits } = require('./providers/llm.js');
const { openAiCompatBase, providerDisplayName } = require('./providers/endpoints.js');
const { McpManager } = require('./providers/mcp.js');
const { formatProviderError } = require('./providers/errors.js');
const { getWebviewHtml } = require('./webview-html.js');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

// Literal string replacement — avoids String.replace's $ meta-char interpolation.
// Returns the edited string, null if not found, or an Error if ambiguous (>1 match).
// Falls through: exact → CRLF-normalised → line-level fuzzy (≥85 % match).
function literalReplace(original, search, replace) {
  // 1. Exact match.
  const first = original.indexOf(search);
  if (first !== -1) {
    if (original.indexOf(search, first + 1) !== -1)
      return new Error('SEARCH string matches more than one location — make it more specific so the edit is unambiguous.');
    return original.slice(0, first) + replace + original.slice(first + search.length);
  }

  // 2. CRLF → LF normalisation (handles Windows line-ending mismatch).
  // Strategies 2 and 3 work on LF-normalised text, so remember the file's original
  // line ending and restore it on output — otherwise one small edit silently
  // rewrites every line ending in the file (a whole-file git diff).
  const hadCRLF    = original.includes('\r\n');
  const restoreEol = (s) => hadCRLF ? s.replace(/\r?\n/g, '\r\n') : s;
  const normOrig   = original.replace(/\r\n/g, '\n');
  const normSearch = search.replace(/\r\n/g, '\n');
  const normReplace = replace.replace(/\r\n/g, '\n');
  const firstNorm  = normOrig.indexOf(normSearch);
  if (firstNorm !== -1) {
    if (normOrig.indexOf(normSearch, firstNorm + 1) !== -1)
      return new Error('SEARCH string matches more than one location — make it more specific so the edit is unambiguous.');
    return restoreEol(normOrig.slice(0, firstNorm) + normReplace + normOrig.slice(firstNorm + normSearch.length));
  }

  // 3. Line-level fuzzy match — tolerates leading-whitespace mismatches (indentation drift).
  const searchLines = normSearch.split('\n');
  const origLines   = normOrig.split('\n');
  const sLen        = searchLines.length;
  const trimSearch  = searchLines.map(l => l.trim());

  let bestIdx   = -1;
  let bestScore = 0;
  let ambiguous = false;

  for (let i = 0; i <= origLines.length - sLen; i++) {
    let hits = 0;
    for (let j = 0; j < sLen; j++) {
      if (origLines[i + j].trim() === trimSearch[j]) hits++;
    }
    const score = hits / sLen;
    if (score > bestScore) { bestScore = score; bestIdx = i; ambiguous = false; }
    else if (score === bestScore && score > 0) { ambiguous = true; }
  }

  if (bestScore >= 0.85 && !ambiguous && bestIdx !== -1) {
    const before = origLines.slice(0, bestIdx).join('\n');
    const after  = origLines.slice(bestIdx + sLen).join('\n');
    return restoreEol((before ? before + '\n' : '') + normReplace + (after ? '\n' + after : ''));
  }

  return null;
}

// Tool definitions — used both for the XML-fallback prompt and for native Ollama tool calling.
const { TOOLS, TOOLS_API, TOOL_PROMPT } = require('./providers/tools.js');

class NavyCoderViewProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.lastReply = '';
    this.abortController = undefined;
    this.messages = [];
    this.pendingApprovals = new Map();
    this.pendingCommandApprovals = new Map();
    this.checkpoints = [];
    this.redoStack = []; // entries: { files: [{ filePath, text }] } — text as it was before the undo
    this.activeToolCall = null;
    // Restore the last picked project root (persisted via navy.projectRoot) so the
    // project choice survives window reloads. Scope matters: the workspace-level value
    // always applies, but the global value is only trusted when NO workspace is open —
    // otherwise a root saved in a folderless window would leak into every workspace.
    const rootInfo = vscode.workspace.getConfiguration('navy').inspect('projectRoot');
    const savedRoot = vscode.workspace.workspaceFolders?.length
      ? (rootInfo?.workspaceValue || '')
      : (rootInfo?.workspaceValue || rootInfo?.globalValue || '');
    this.projectRoot = (savedRoot && fs.existsSync(savedRoot)) ? savedRoot : '';
    this.messageQueue = [];   // queued prompts while a turn is in progress
    this.isBusy = false;
    this.modelContextLength = null; // fetched from Ollama /api/show
    // Restore the persisted thinking level so the choice survives window reloads.
    this.thinkingLevel = vscode.workspace.getConfiguration('navy').get('thinkingLevel', 'medium');
    this.currentTurnId = null;     // groups checkpoints for per-turn undo
    this.statusBarItem = null; // set by activate() after construction
    this.bgProcesses = new Map(); // id → { proc, stdout, stderr, exitCode }
    this._writeLock = Promise.resolve(); // serializes file writes across main turn + background tasks
    this.log = null; // set by activate() → Navy Coder output channel; safe to call before
    this.mcp = new McpManager((line) => this.log?.(line)); // external MCP tool servers
    this.bgWorkers   = new Map(); // taskId → { ctrl: AbortController }
    this.bgWorkerId  = 0;
    this.editedRanges = new Map(); // filePath -> [{start,end}] for gutter decorations
    this.gutterDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
  }

  async resolveWebviewView(webviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Cancel all pending approvals when the panel is closed so awaiting promises resolve.
    webviewView.onDidDispose(() => this.cancelPendingApprovals());

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          // Webview script is live — send all startup state now so nothing is dropped.
          this.sendActiveFile();
          await this.loadModels();
          this.sendApprovalMode();
          this.sendSettings();
          this.view?.webview.postMessage({ type: 'thinkingLevel', level: this.thinkingLevel });
          await this.sendWorkspaceFolders();
          await this.loadProjectSession();
          break;
        case 'ask':
          await this.askNavy(message.prompt, Boolean(message.includeContext), message.model, message.attachedFiles, message.images || []);
          break;
        case 'stop':
          // Stop means stop everything — including prompts waiting in the queue,
          // otherwise the next queued message fires the instant the abort lands.
          this.messageQueue = [];
          this.view?.webview.postMessage({ type: 'queueDrained', remaining: 0 });
          this.abortController?.abort();
          this.cancelPendingApprovals();
          break;
        case 'insertLastReply':
          await this.insertLastReply();
          break;
        case 'insertCode':
          await this.insertCode(message.text);
          break;
        case 'applyCode':
          await this.applyCode(message.text, message.path);
          break;
        case 'approveDiff':
          await this.resolveApproval(message.id, true);
          break;
        case 'rejectDiff':
          await this.resolveApproval(message.id, false);
          break;
        case 'approveCommand':
          this.resolveCommandApproval(message.id, true);
          break;
        case 'rejectCommand':
          this.resolveCommandApproval(message.id, false);
          break;
        case 'undoLast':
          await this.undoLastCheckpoint();
          break;
        case 'redoLast':
          await this.redoLast();
          break;
        case 'clear':
          this.clearChat();
          break;
        case 'getModels':
          await this.loadModels(true); // explicit refresh — bypass the cache
          break;
        case 'setModel':
          await this.setModel(message.model);
          break;
        case 'setApprovalMode': {
          if (message.mode === 'auto-approve') {
            // Auto removes every safety gate — make sure the switch is deliberate.
            const pick = await vscode.window.showWarningMessage(
              'Enable auto-approve? Navy will edit files, run commands, and delete files WITHOUT asking for confirmation.',
              { modal: true },
              'Enable'
            );
            if (pick !== 'Enable') { this.sendApprovalMode(); break; } // revert the dropdown
          }
          await vscode.workspace.getConfiguration('navy').update('approvalMode', message.mode, vscode.ConfigurationTarget.Global);
          this.sendApprovalMode();
          break;
        }
        case 'copy':
          await vscode.env.clipboard.writeText(message.text || '');
          break;
        case 'runCommand':
          // Defense in depth: the webview renders model output, so never let it invoke
          // arbitrary VS Code commands (e.g. terminal.sendSequence → shell execution).
          if (message.command && /^navy\.[a-zA-Z]+$/.test(message.command)) {
            vscode.commands.executeCommand(message.command);
          }
          break;
        case 'openFolder':
          await this.openFolder();
          break;
        case 'getWorkspaceFolders':
          await this.sendWorkspaceFolders();
          break;
        case 'setProjectRoot':
          // Never switch roots while a turn is running — executing tools resolve
          // paths against this.projectRoot live, so edits would land in the wrong project.
          if (this.isBusy) {
            vscode.window.showWarningMessage('Navy is working — stop the current task before switching projects.');
            await this.sendWorkspaceFolders(); // re-send current root so the dropdown reverts
            break;
          }
          this.projectRoot = message.root || '';
          await this._persistProjectRoot(this.projectRoot);
          await this.sendWorkspaceFolders();
          await this.loadProjectSession();
          break;
        case 'setThinkingLevel':
          this.setThinkingLevel(message.level);
          break;
        case 'clearMemory': {
          const pick = await vscode.window.showWarningMessage(
            'Clear all project memories? This cannot be undone.',
            { modal: true },
            'Clear All'
          );
          if (pick === 'Clear All') await this.toolForget('');
          break;
        }
        case 'getMemory': {
          const mem = await this.loadProjectMemory();
          this.view?.webview.postMessage({ type: 'memoryUpdated', memory: mem });
          break;
        }
        case 'getWorkspaceFiles': {
          try {
            const uris = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 300);
            const files = uris.map(u => u.fsPath).sort();
            this.view?.webview.postMessage({ type: 'workspaceFiles', files });
          } catch {
            this.view?.webview.postMessage({ type: 'workspaceFiles', files: [] });
          }
          break;
        }
        case 'getWorkspaceSymbols': {
          try {
            const syms = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', message.query || '');
            const items = (syms || []).slice(0, 12).map(s => ({
              name: s.name,
              kind: vscode.SymbolKind[s.kind] || 'Symbol',
              file: vscode.workspace.asRelativePath(s.location.uri),
              line: s.location.range.start.line + 1,
              fsPath: s.location.uri.fsPath,
            }));
            this.view?.webview.postMessage({ type: 'workspaceSymbols', symbols: items });
          } catch { this.view?.webview.postMessage({ type: 'workspaceSymbols', symbols: [] }); }
          break;
        }
        case 'exportConversation':
          await this.exportConversation(message.text || '');
          break;
        case 'reviewPR':
          await this.generatePRReview();
          break;
        case 'startBackgroundTask': {
          if (this.bgWorkers.size >= 5) {
            this.view?.webview.postMessage({ type: 'error', message: 'Too many background tasks running (max 5). Wait for one to finish first.' });
            break;
          }
          const taskId = 'bg-' + (++this.bgWorkerId);
          this.view?.webview.postMessage({ type: 'bgTaskUpdate', taskId, status: 'start', prompt: message.prompt });
          // Intentionally not awaited — runs in parallel with the main chat.
          this.runBackgroundTask(taskId, message.prompt);
          break;
        }
        case 'killBackgroundTask': {
          const worker = this.bgWorkers.get(message.taskId);
          if (worker) worker.ctrl.abort();
          break;
        }
        case 'stopRunProject': {
          const entry = this.bgProcesses.get('__run_project__');
          if (entry?.proc) {
            // Kill the full process tree (cmd.exe + npm + node on Windows, process group on Unix).
            // The proc.on('close') handler in toolRunProject will send runProjectStopped once dead.
            this._killProcessTree(entry.proc);
          } else {
            // No process running — acknowledge immediately.
            this.view?.webview.postMessage({ type: 'runProjectStopped', exitCode: 0 });
          }
          break;
        }
        case 'openUrl':
          if (message.url) vscode.env.openExternal(vscode.Uri.parse(message.url));
          break;
        case 'getSettings':
          await this.sendSettings();
          break;
        case 'saveSettings': {
          const cfg = vscode.workspace.getConfiguration('navy');
          const s = message.settings || {};
          const T = vscode.ConfigurationTarget.Global;
          if (s.provider   !== undefined) await cfg.update('provider',          s.provider,          T);
          if (s.host       !== undefined) await cfg.update('host',              s.host,              T);
          // Never store a masked display value ('ab12••••cd34') back into secrets.
          if (s.apiKey !== undefined && !String(s.apiKey).includes('••••')) {
            // cfg is a snapshot — cfg.get('provider') would return the PRE-update value.
            // Use the provider from this same save payload when present.
            const currentProvider = s.provider !== undefined ? s.provider : cfg.get('provider', 'ollama');
            await this.context.secrets.store('navy.apiKey.' + currentProvider, s.apiKey);
          }
          if (s.searchApiKey !== undefined && !String(s.searchApiKey).includes('••••')) {
            await this.context.secrets.store('navy.searchApiKey', s.searchApiKey);
          }
          if (s.apiBase    !== undefined) await cfg.update('apiBase',           s.apiBase,           T);
          if (s.temperature!== undefined) await cfg.update('temperature',       Number(s.temperature), T);
          if (s.maxIter    !== undefined) await cfg.update('maxToolIterations', Number(s.maxIter),   T);
          if (s.editFormat !== undefined) await cfg.update('editFormat',        s.editFormat,        T);
          if (s.systemPrompt!==undefined) await cfg.update('systemPrompt',      s.systemPrompt,      T);
          // Reload models in case provider/host/key changed — force a fresh fetch.
          await this.loadModels(true);
          await this.sendSettings();
          vscode.window.showInformationMessage('Navy: Settings saved.');
          break;
        }
      }
    });

    // Startup state is now sent in response to the webview's 'ready' message
    // to avoid a race where postMessage fires before the script listener is set up.

    // Guard against duplicate listeners when the panel is recreated.
    if (!this._globalListenersRegistered) {
      this._globalListenersRegistered = true;
      this.context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => this.sendActiveFile()),
        vscode.workspace.onDidChangeWorkspaceFolders(() => this.sendWorkspaceFolders())
      );
    }

    // Re-send workspace folders whenever the panel becomes visible (e.g. user switches tabs back).
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.sendWorkspaceFolders();
    });
  }

  // Resolve all queued approval promises so the agentic loop is not abandoned.
  cancelPendingApprovals() {
    for (const [, approval] of this.pendingApprovals) {
      approval.resolve('Edit cancelled');
    }
    this.pendingApprovals.clear();
    for (const [, approval] of this.pendingCommandApprovals) {
      approval.resolve(false);
    }
    this.pendingCommandApprovals.clear();
    this.sendPendingApprovalsUpdate();
  }

  resolveCommandApproval(id, approved) {
    const approval = this.pendingCommandApprovals.get(id);
    if (!approval) return;
    this.pendingCommandApprovals.delete(id);
    approval.resolve(approved);
    this.view?.webview.postMessage({ type: 'commandResolved', id, approved });
  }

  async focus() {
    if (!this.view) {
      // Sidebar has never been opened — this.view doesn't exist yet, so show() would
      // be a silent no-op. VS Code auto-generates <viewId>.focus which opens the Navy
      // container and resolves the view. Give it a moment so callers that immediately
      // send a prompt (inline edit, explain error) don't race the webview handshake.
      try {
        await vscode.commands.executeCommand('navy.chatView.focus');
        await new Promise(r => setTimeout(r, 400));
      } catch {}
      return;
    }
    this.view.show?.(true);
    this.view.webview.postMessage({ type: 'focusInput' });
  }

  clearChat() {
    // Clearing mid-turn: abort the running turn and drop queued prompts first, so a
    // ghost turn can't keep streaming into (and re-saving over) the cleared chat.
    this.messageQueue = [];
    this.abortController?.abort();
    this.cancelPendingApprovals();
    this.messages = [];
    this.lastReply = '';
    this.sessionDigest = '';
    this.checkpoints = [];
    this.redoStack = [];
    this.view?.webview.postMessage({ type: 'redoState', count: 0 });
    this._persistCheckpoints();
    this.editedRanges.clear();
    this.view?.webview.postMessage({ type: 'cleared' });
    this.saveProjectSession();
    this.loadProjectMemory().then(mem =>
      this.view?.webview.postMessage({ type: 'sessionLoaded', count: 0, memory: mem, projectRoot: this.projectRoot })
    );
  }

  sendActiveFile() {
    const editor = vscode.window.activeTextEditor;
    const filePath = editor ? editor.document.fileName : '';
    const language = editor ? editor.document.languageId : '';
    this.view?.webview.postMessage({ type: 'activeFile', path: filePath, language });

    // Auto-derive project root from the workspace folder that contains the active file,
    // or (if no workspace is open) from the active file's directory.
    if (!this.projectRoot && filePath && !filePath.startsWith('Untitled')) {
      // Containment check must be separator-aware (E:\Proj2 is NOT inside E:\Proj)
      // and case-folded on Windows where paths are case-insensitive.
      const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
      const fp = fold(filePath);
      const wsFolder = vscode.workspace.workspaceFolders?.find((f) => {
        const base = fold(f.uri.fsPath);
        return fp === base || fp.startsWith(base + path.sep);
      });
      this.projectRoot = wsFolder ? wsFolder.uri.fsPath : path.dirname(filePath);
      this.sendWorkspaceFolders();
    }
  }

  sendApprovalMode() {
    const mode = vscode.workspace.getConfiguration('navy').get('approvalMode', 'ask-always');
    this.view?.webview.postMessage({ type: 'approvalMode', mode });
  }

  async sendSettings() {
    const c = vscode.workspace.getConfiguration('navy');
    const provider = c.get('provider', 'ollama');
    // Per-provider key with legacy single-key fallback.
    const apiKey = await this.context.secrets.get('navy.apiKey.' + provider)
                || await this.context.secrets.get('navy.apiKey') || '';
    const maskedKey = apiKey ? apiKey.slice(0, 4) + '••••' + apiKey.slice(-4) : '';
    const searchKey = c.get('searchApiKey', '')
                   || await this.context.secrets.get('navy.searchApiKey') || '';
    const maskedSearchKey = searchKey ? searchKey.slice(0, 4) + '••••' + searchKey.slice(-4) : '';
    this.view?.webview.postMessage({
      type: 'settings',
      settings: {
        provider,
        host:         c.get('host',              'http://localhost:11434'),
        apiKey:       maskedKey,
        apiBase:      c.get('apiBase',           ''),
        searchApiKey: maskedSearchKey,
        temperature:  c.get('temperature',       0.2),
        maxIter:      c.get('maxToolIterations', 50),
        editFormat:   c.get('editFormat',        'search-replace'),
        systemPrompt: c.get('systemPrompt',      ''),
      }
    });
  }

  async sendWorkspaceFolders() {
    const folders = vscode.workspace.workspaceFolders || [];
    const roots = folders.map((f) => f.uri.fsPath).filter(Boolean);

    // Fallback: if no workspace folders, derive root from the active file.
    if (!this.projectRoot && roots.length === 0) {
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.document.fileName.startsWith('Untitled')) {
        this.projectRoot = path.dirname(editor.document.fileName);
      }
    }

    // Use the first workspace folder as default root if none set yet.
    if (!this.projectRoot && roots.length > 0) {
      this.projectRoot = roots[0];
    }

    // Ensure the current root appears in the list even when it was auto-derived from an open file.
    const displayRoots = (this.projectRoot && !roots.includes(this.projectRoot))
      ? [this.projectRoot, ...roots]
      : roots;

    this.view?.webview.postMessage({ type: 'workspaceFolders', roots: displayRoots, current: this.projectRoot });
  }

  // Persist the picked project root so it survives window reloads. Workspace-scoped
  // when a workspace is open (per-project memory), global otherwise.
  async _persistProjectRoot(root) {
    try {
      const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration('navy').update('projectRoot', root || '', target);
    } catch {}
  }

  async openFolder() {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Add Navy project'
    });
    if (!result || result.length === 0) return;
    const picked = result[0].fsPath;
    const uri = vscode.Uri.file(picked);
    const folders = vscode.workspace.workspaceFolders || [];
    const exists = folders.some((f) => f.uri.fsPath === picked);

    if (!exists && folders.length === 0) {
      // No workspace open — actually open the folder (Explorer, language servers,
      // file watching), exactly like File → Open Folder. Persist the root first:
      // opening a folder reloads the window, and the fresh session derives its
      // root from the newly opened workspace folder.
      this.projectRoot = picked;
      await this._persistProjectRoot(picked);
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
      return; // window reloads — nothing more to do in this session
    }

    if (!exists) {
      // Workspace already open — add the project as an additional workspace folder
      // so the current one stays available, and reveal it so it's visibly loaded.
      await vscode.workspace.updateWorkspaceFolders(folders.length, 0, uri);
      try { await vscode.commands.executeCommand('revealInExplorer', uri); } catch {}
    }

    this.projectRoot = picked;
    await this._persistProjectRoot(picked);
    await this.sendWorkspaceFolders();
    await this.loadProjectSession();
  }

  async setModel(model) {
    if (!model) return;
    const config = vscode.workspace.getConfiguration('navy');
    await config.update('model', model, true);
    await this.loadModels();
  }

  // Curated fallbacks — shown ONLY when the live /models fetch fails (no API key,
  // offline, endpoint down) so the dropdown is never empty. The live list is
  // always preferred, so a provider adding/removing a model is reflected
  // automatically without a Navy update.
  static MODEL_FALLBACKS = {
    openai:     ['gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini', 'o1', 'gpt-4-turbo'],
    anthropic:  ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022'],
    deepseek:   ['deepseek-chat', 'deepseek-reasoner'],
    gemini:     ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    xai:        ['grok-3', 'grok-3-mini', 'grok-2'],
    groq:       ['moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    openrouter: ['openai/gpt-4o', 'anthropic/claude-opus-4', 'google/gemini-2.0-flash', 'deepseek/deepseek-r1'],
  };

  // GET a provider's /models list. Returns an array of model ids, or null on any
  // failure (caller falls back). Handles OpenAI ({data:[{id}]}) and bare-array
  // shapes, and follows Anthropic-style has_more/last_id pagination (≤3 pages).
  async _fetchModelList(url, headers) {
    try {
      const all = [];
      let pageUrl = url;
      for (let page = 0; page < 3 && pageUrl; page++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(pageUrl, { headers, signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return all.length ? all : null;
        const data = await res.json();
        const raw = data.data || data.models || (Array.isArray(data) ? data : []);
        all.push(...raw.map(m => (typeof m === 'string' ? m : (m && (m.id || m.name)))).filter(Boolean));
        pageUrl = (data.has_more && data.last_id)
          ? url + (url.includes('?') ? '&' : '?') + 'after_id=' + encodeURIComponent(data.last_id)
          : null;
      }
      return all.length ? all : null;
    } catch { return null; }
  }

  // Pure: provider-specific cleanup of a live /models list.
  //  • gemini returns ids as "models/gemini-…" — strip the prefix (their chat
  //    endpoint accepts the bare id, and the prefixed form is ugly in the UI).
  //  • openai lists EVERY model (whisper, tts, dall-e, embeddings…) — keep only
  //    chat-capable families, but never filter down to empty (future-proofing).
  _sanitizeModelList(provider, list) {
    if (!list) return list;
    let out = list;
    if (provider === 'gemini') out = out.map(id => id.replace(/^models\//, ''));
    if (provider === 'openai') {
      const chat = out.filter(id =>
        /^(gpt-|o[0-9]|chatgpt)/.test(id) &&
        !/(embedding|whisper|tts|audio|realtime|dall-e|image|moderation|transcribe|davinci|babbage|search)/.test(id));
      if (chat.length) out = chat;
    }
    return out;
  }

  // Pure: decide the final dropdown list. Prefer the live list; fall back to the
  // curated list; always keep the user's active model selectable even if the
  // provider dropped it from the live list. Returns { models, error }.
  _mergeModelList(fetched, fallback, activeModel) {
    const live = fetched && fetched.length;
    let models = (live ? fetched : (fallback || [])).slice();
    const error = (!live && !(fallback && fallback.length))
      ? "Couldn't fetch models — check your API key or base URL." : undefined;
    models.sort((a, b) => a.localeCompare(b));
    if (activeModel && models.length && !models.includes(activeModel)) models = [activeModel, ...models];
    return { models, error };
  }

  async loadModels(force = false) {
    const config = vscode.workspace.getConfiguration('navy');
    const host = config.get('host', 'http://localhost:11434').replace(/\/$/, '');
    const provider = config.get('provider', 'ollama');
    const apiBase = config.get('apiBase', '');
    const apiKey = await this.context.secrets.get('navy.apiKey.' + provider)
                || await this.context.secrets.get('navy.apiKey') || '';
    const currentModel = config.get('model', '');

    // Context length is only fetchable from Ollama (/api/show) — clear it for other
    // providers so the context gauge never shows a stale value from a previous provider.
    if (provider !== 'ollama') this.modelContextLength = null;

    // Ollama — native tags endpoint (+ context length).
    if (provider === 'ollama') {
      try {
        const response = await fetch(host + '/api/tags');
        if (!response.ok) throw new Error('Ollama returned ' + response.status);
        const data = await response.json();
        const models = (data.models || []).map((m) => m.name || m.model).filter(Boolean).sort();
        if (models.length > 0 && !models.includes(currentModel)) await config.update('model', models[0], true);
        const activeModel = config.get('model', models[0] || currentModel);
        this.view?.webview.postMessage({ type: 'models', models, currentModel: activeModel });
        this.fetchModelContext(host, activeModel);
      } catch (error) {
        this.view?.webview.postMessage({ type: 'models', models: [], currentModel, error: error.message });
      }
      return;
    }

    // Everyone else exposes a /models list. Anthropic needs its own auth header;
    // the rest (openai, deepseek, gemini, xai, zai, groq, openrouter, lmstudio,
    // custom) are OpenAI-compatible and share the same Bearer + /models shape.
    let url, headers = { 'Content-Type': 'application/json' };
    if (provider === 'anthropic') {
      url = (apiBase || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/models?limit=100';
      if (apiKey) { headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01'; }
    } else {
      const base = openAiCompatBase(provider, apiBase, host) || host;
      url = base.replace(/\/$/, '') + '/models';
      if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    }

    // Cache successful fetches for 5 min so opening settings / switching the model
    // dropdown doesn't hit the network every time. Cache key includes the URL and
    // whether a key is present, so a provider/base/key change re-fetches.
    const cacheKey = provider + '|' + url + '|' + (apiKey ? 'k' : '');
    let fetched;
    if (!force && this._modelListCache?.key === cacheKey && Date.now() - this._modelListCache.time < 300_000) {
      fetched = this._modelListCache.models;
    } else {
      fetched = this._sanitizeModelList(provider, await this._fetchModelList(url, headers));
      if (fetched && fetched.length) this._modelListCache = { key: cacheKey, time: Date.now(), models: fetched };
    }

    let activeModel = config.get('model', currentModel);
    // If we have an authoritative LIVE list and the configured model isn't in it,
    // it's stale for this provider (typically right after switching providers, when
    // navy.model still holds the old provider's model). Default to the first real
    // model and persist it, so the next chat doesn't 400 on an invalid model.
    // Only when live — a failed fetch (fallback) must not clobber the user's choice.
    if (fetched && fetched.length && !fetched.includes(activeModel)) {
      activeModel = fetched[0];
      await config.update('model', activeModel, true);
    }
    const { models, error } = this._mergeModelList(fetched, NavyCoderViewProvider.MODEL_FALLBACKS[provider], activeModel);
    this.view?.webview.postMessage({ type: 'models', models, currentModel: activeModel, ...(error ? { error } : {}) });
  }

  async fetchModelContext(host, model) {
    try {
      const res = await fetch(host + '/api/show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model })
      });
      if (!res.ok) return;
      const data = await res.json();
      // context_length can be nested under model_info or at the top level.
      const ctx = data.model_info?.['llm.context_length']
        || data.context_length
        || data.parameters?.context_length
        || null;
      if (ctx) {
        this.modelContextLength = Number(ctx);
        this.view?.webview.postMessage({ type: 'contextLength', length: this.modelContextLength });
      }
    } catch (_) {}
  }

  setThinkingLevel(level) {
    if (['fast', 'medium', 'high'].includes(level)) {
      this.thinkingLevel = level;
      // Persist so the choice survives window reloads (fire-and-forget is fine here).
      vscode.workspace.getConfiguration('navy').update('thinkingLevel', level, vscode.ConfigurationTarget.Global);
      this.view?.webview.postMessage({ type: 'thinkingLevel', level });
    }
  }

  // ── Project session & memory ─────────────────────────────────────────────

  getNavyDir() {
    return this.projectRoot ? path.join(this.projectRoot, '.navy') : null;
  }

  async ensureNavyDir() {
    const dir = this.getNavyDir();
    if (!dir) return null;
    try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir)); } catch {}
    // Self-ignoring directory: session.json contains the full conversation text,
    // which must never end up committed to the user's repo.
    const gi = vscode.Uri.file(path.join(dir, '.gitignore'));
    try { await vscode.workspace.fs.stat(gi); }
    catch { try { await vscode.workspace.fs.writeFile(gi, Buffer.from('*\n', 'utf8')); } catch {} }
    return dir;
  }

  async loadProjectSession() {
    // Undo/redo history is per-project: checkpoints are reloaded below, and the
    // redo stack must not survive a switch (it holds the OTHER project's files).
    if (this.redoStack.length) {
      this.redoStack = [];
      this.view?.webview.postMessage({ type: 'redoState', count: 0 });
    }
    const dir = this.getNavyDir();
    if (!dir) return;
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(dir, 'session.json')));
      const session = JSON.parse(Buffer.from(data).toString('utf8'));
      this.messages = Array.isArray(session.messages) ? session.messages : [];
      this.sessionDigest = typeof session.digest === 'string' ? session.digest : '';
      this.restoreMessages();
      const memory = await this.loadProjectMemory();
      this.view?.webview.postMessage({
        type: 'sessionLoaded',
        count: this.messages.length,
        memory,
        projectRoot: this.projectRoot
      });
    } catch {
      this.messages = [];
      this.sessionDigest = '';
      this.view?.webview.postMessage({ type: 'sessionLoaded', count: 0, memory: '', projectRoot: this.projectRoot });
    }
    const rules = await this.loadProjectRules();
    this.view?.webview.postMessage({ type: 'rulesStatus', active: Boolean(rules) });
    await this._loadCheckpoints();
  }

  async saveProjectSession() {
    const dir = await this.ensureNavyDir();
    if (!dir) return;
    try {
      const session = { updated: new Date().toISOString(), projectRoot: this.projectRoot, messages: this.messages, digest: this.sessionDigest || '' };
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(path.join(dir, 'session.json')),
        Buffer.from(JSON.stringify(session, null, 2), 'utf8')
      );
    } catch {}
  }

  async loadProjectMemory() {
    const dir = this.getNavyDir();
    if (!dir) return '';
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(dir, 'memory.md')));
      return Buffer.from(data).toString('utf8').trim();
    } catch { return ''; }
  }

  async loadProjectRules() {
    // Check well-known per-project rule files in the workspace root first.
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) {
      for (const name of ['.navyrules', '.cursorrules', 'AGENTS.md', '.github/copilot-instructions.md']) {
        try {
          const data = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, name)));
          const text = Buffer.from(data).toString('utf8').trim();
          if (text) return text;
        } catch {}
      }
    }
    // Fall back to the Navy-managed rules.md in .navy/
    const dir = this.getNavyDir();
    if (!dir) return '';
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(dir, 'rules.md')));
      return Buffer.from(data).toString('utf8').trim();
    } catch { return ''; }
  }

  async saveProjectMemory(content) {
    const dir = await this.ensureNavyDir();
    if (!dir) return;
    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(path.join(dir, 'memory.md')),
        Buffer.from(content, 'utf8')
      );
    } catch {}
  }

  async toolRemember(fact) {
    if (!fact?.trim()) return 'No fact provided.';
    const existing = await this.loadProjectMemory();
    const date = new Date().toISOString().slice(0, 10);
    const newContent = existing
      ? existing + '\n- [' + date + '] ' + fact.trim()
      : '# Navy Project Memory\n\n- [' + date + '] ' + fact.trim();
    await this.saveProjectMemory(newContent);
    this.view?.webview.postMessage({ type: 'memoryUpdated', memory: newContent });
    return 'Remembered.';
  }

  async toolForget(query) {
    const existing = await this.loadProjectMemory();
    if (!query?.trim()) {
      await this.saveProjectMemory('# Navy Project Memory\n');
      this.view?.webview.postMessage({ type: 'memoryUpdated', memory: '' });
      return 'All project memory cleared.';
    }
    const filtered = existing
      .split('\n')
      .filter(l => !l.toLowerCase().includes(query.toLowerCase()))
      .join('\n');
    await this.saveProjectMemory(filtered);
    this.view?.webview.postMessage({ type: 'memoryUpdated', memory: filtered });
    return 'Removed memories matching: ' + query;
  }

  async clearProjectSession() {
    this.messages = [];
    this.lastReply = '';
    this.checkpoints = [];
    this.view?.webview.postMessage({ type: 'cleared' });
    await this.saveProjectSession();
    this.view?.webview.postMessage({ type: 'sessionLoaded', count: 0, memory: await this.loadProjectMemory(), projectRoot: this.projectRoot });
  }

  async askNavy(prompt, includeContext, selectedModel, attachedFiles = [], images = []) {
    if (!prompt.trim()) return;

    // Queue while busy so the user can keep typing freely.
    if (this.isBusy) {
      this.messageQueue.push({ prompt, includeContext, selectedModel, attachedFiles, images });
      this.view?.webview.postMessage({ type: 'queued', position: this.messageQueue.length });
      return;
    }

    this.isBusy = true;
    if (this.statusBarItem) this.statusBarItem.text = '$(sync~spin) Navy';
    this.currentTurnId = this.generateId();
    // Liveness beacon: the webview only declares Navy dead after 4 minutes of
    // silence, so beat every 30s for the whole turn (model calls, tools, and
    // approval waits included). Cleared in finally.
    clearInterval(this._heartbeat);
    this._heartbeat = setInterval(() => {
      this.view?.webview.postMessage({ type: 'heartbeat' });
    }, 30000);

    const config = vscode.workspace.getConfiguration('navy');
    const configuredModel = config.get('model', '');
    const model = selectedModel || configuredModel;
    const host = config.get('host', 'http://localhost:11434').replace(/\/$/, '');
    const aiProviderForTag = config.get('provider', 'ollama'); // tags _rawBlocks with its origin provider

    // Map thinking level to temperature.
    const tempByLevel = { fast: 0.0, medium: 0.2, high: 0.7 };
    const temperature = tempByLevel[this.thinkingLevel] ?? config.get('temperature', 0.2);
    const maxIterations = config.get('maxToolIterations', 50);
    const maxContextChars = config.get('maxContextChars', 12000);

    const activeEditor = vscode.window.activeTextEditor;
    const activeFile = activeEditor ? activeEditor.document.fileName : '';
    const activeLanguage = activeEditor ? activeEditor.document.languageId : '';
    const extraFiles = Array.isArray(attachedFiles) ? attachedFiles : [];

    // Auto-attach the active file if not already present and prompt is edit OR review/analysis.
    const activeFileLower = activeFile.toLowerCase();
    if (activeFile && !extraFiles.some(f => f.toLowerCase() === activeFileLower) &&
        /\b(update|edit|modify|change|fix|refactor|rewrite|replace|add|remove|delete|rename|move|create|make|implement|review|analyse|analyze|explain|check|look|show|describe|summarize|audit|inspect|read)\b/i.test(prompt)) {
      extraFiles.push(activeFile);
    }

    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'none';
    const repoMap = await this.buildRepoMap();

    // Auto-retrieval: on a code-oriented request, hand the model a ranked shortlist
    // of likely-relevant files up front so it doesn't have to guess-and-read. Only
    // paths (not contents) — the model reads the ones it wants. Gated to code tasks
    // and bounded, so simple chat and huge repos stay fast; failures are non-fatal.
    let relevantBlock = '';
    try {
      const isCodeTask = /\b(fix|bug|edit|update|change|modify|refactor|implement|add|remove|rename|review|debug|explain|where|find|which|how|trace|test|error|function|class|method|component|endpoint|route|handler|module|import|feature)\b/i.test(prompt);
      if (root !== 'none' && isCodeTask) {
        const terms = this._tokenizeQuery(prompt);
        if (terms.length) {
          const hits = await this._collectRelevance(root, terms, { maxFiles: 800 });
          const ranked = this._rankRelevance(hits, terms).slice(0, 6);
          if (ranked.length) {
            relevantBlock = '\n\n## Likely relevant files (ranked for this request — read the ones you need, this is a hint not a limit):\n'
              + ranked.map(h => `- ${h.rel}${h.defs ? ' (defines a queried symbol)' : ''}`).join('\n');
          }
        }
      }
    } catch (e) { this.log?.('auto-retrieval failed: ' + e.message); }

    let diagnosticsContext = '';
    if (activeFile) {
      try {
        const uri = vscode.Uri.file(activeFile);
        const diags = vscode.languages.getDiagnostics(uri);
        if (diags.length > 0) {
          const errors = diags.filter(d => d.severity === 0);
          const warnings = diags.filter(d => d.severity === 1);
          diagnosticsContext = `\n\n## Active File Diagnostics (${path.basename(activeFile)})\n`
            + diags.slice(0, 20).map(d => {
                const sev = ['Error', 'Warning', 'Info', 'Hint'][d.severity] || '?';
                return `[${sev}] line ${d.range.start.line + 1}: ${d.message}`;


              }).join('\n');
          if (errors.length > 0 || warnings.length > 0) {
            this.view?.webview.postMessage({ type: 'diagnostics', errors: errors.length, warnings: warnings.length });
          }
        }
      } catch {}
    }

    const contextText = includeContext ? getEditorContext(maxContextChars) : '';

    const [projectMemory, projectRules] = await Promise.all([
      this.loadProjectMemory(),
      this.loadProjectRules()
    ]);

    // Notify webview whether rules are active so the badge shows.
    this.view?.webview.postMessage({ type: 'rulesStatus', active: Boolean(projectRules) });

    const rootKnown = root && root !== 'none';
    const projectName = rootKnown ? path.basename(root) : null;
    const osPlatform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
    const nowStr = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

    let systemContent = TOOL_PROMPT;
    if (!rootKnown) {
      systemContent += `\n\n## WARNING: NO PROJECT DETECTED\nThe user has not opened a folder in VS Code. You do NOT know the project name or path. Do NOT invent or guess them. If asked about the project, tell the user to open a folder first (File → Open Folder).`;
    } else {
      systemContent += `\n\n## CURRENT ENVIRONMENT (these are facts, do NOT guess or invent alternatives)\n`
        + `- Project name: ${projectName}\n`
        + `- Project root: ${root}\n`
        + `- Operating system: ${osPlatform}\n`
        + `- Date/time: ${nowStr}\n`
        + `If asked about the project name, directory, or OS, answer using ONLY the values above.`;
    }
    // Cap each variable section so the system prompt can't itself overflow the
    // context window on a huge repo / big memory / long rules file — _compactMessages
    // only prunes tool results and images, never the system message.
    const cap = (s, n) => s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s;
    // navy.systemPrompt: user-supplied preferences, appended AFTER the mandatory
    // tool-use rules so it can't accidentally override them. Guarded against the
    // legacy pre-agentic-loop default text (SEARCH/REPLACE fence instructions) —
    // that default used to be silently persisted by clicking Save, and injecting
    // it now would tell the model to paste code instead of calling tools, which
    // is precisely the hallucination bug this rule set exists to prevent.
    const customSystemPrompt = vscode.workspace.getConfiguration('navy').get('systemPrompt', '');
    if (customSystemPrompt.trim() && !customSystemPrompt.includes('SEARCH/REPLACE blocks')) {
      systemContent += '\n\n## User preferences (does not override the tool-use rules above):\n' + cap(customSystemPrompt.trim(), 2000);
    }
    if (projectRules) {
      systemContent += '\n\n## Project Rules (permanent team conventions — always follow these, they override your defaults):\n' + cap(projectRules, 8000);
    }
    if (projectMemory) {
      systemContent += '\n\n## Project Memory (facts you learned in previous sessions — treat as ground truth unless you discover otherwise):\n' + cap(projectMemory, 6000);
    }
    if (this.sessionDigest) {
      systemContent += '\n\n## Earlier in this conversation (condensed — full text was trimmed to fit the context window):\n' + cap(this.sessionDigest, 6000);
    }
    if (diagnosticsContext) systemContent += diagnosticsContext;
    if (this.mcp?.toolCount) {
      const names = this.mcp.getToolsApi().map(t => t.function.name).join(', ');
      systemContent += '\n\n## External MCP tools available (call them exactly like built-in tools):\n' + cap(names, 2000);
    }
    systemContent += '\n\nRepository map:\n' + cap(repoMap, 12000);
    if (relevantBlock) systemContent += cap(relevantBlock, 2000);
    // Appended LAST (highest recency salience) and only for models whose name
    // suggests they're small — a blunt, maximally-explicit restatement of the
    // anti-hallucination rule for the models most likely to need it.
    if (this._isLikelySmallModel(model)) {
      systemContent += '\n\n## IMPORTANT — READ THIS LAST INSTRUCTION CAREFULLY\n'
        + 'You are running as a smaller model that sometimes forgets to use tools. Before you write ANY sentence containing '
        + 'the words "created", "saved", "written", "done", or "fixed" about a file, STOP and check: did you actually call '
        + 'write_file or apply_edit and see a success result in THIS conversation? If not, call the tool NOW instead of '
        + 'describing the change in text. Text alone changes nothing on disk.';
    }

    const messages = [{ role: 'system', content: systemContent }];

    // Always include file contents in the user message so Navy can edit without separate read_file calls
    const fileContents = [];
    if (activeFile) {
      const activeText = this.truncateForContext(await this.readFileText(activeFile));
      if (activeText !== null) fileContents.push('ACTIVE FILE: ' + activeFile + ' (language: ' + activeLanguage + ')\n\n' + activeText);
    }
    for (const file of extraFiles) {
      const fileText = this.truncateForContext(await this.readFileText(file));
      if (fileText !== null && file !== activeFile) fileContents.push('ATTACHED FILE: ' + file + '\n\n' + fileText);
    }

    const userParts = [];
    if (activeFile) {
      userParts.push('THE FILE YOU SHOULD EDIT (if the request involves changing code) IS:\n' + activeFile + ' (language: ' + activeLanguage + ')');
    }
    if (contextText) userParts.push('Current editor context:\n\n' + contextText);
    if (fileContents.length > 0) userParts.push(fileContents.join('\n\n---\n\n'));
    userParts.push('USER REQUEST:\n' + prompt);

    // Long sessions: condense the oldest turns into a digest instead of silently
    // forgetting them — Navy keeps knowing what was discussed and changed early on.
    if (this.messages.length > 80) {
      const dropped = this.messages.slice(0, this.messages.length - 60);
      this.messages = this.messages.slice(-60);
      // Mechanical digest — always available, zero latency, used as the fallback.
      const lines = dropped.map(m => {
        const head = (m.text || '').replace(/\s+/g, ' ').slice(0, 120);
        if (!head) return '';
        if (m.role === 'user') return '- User: ' + head;
        const files = m.meta?.files?.length ? ` [changed: ${m.meta.files.join(', ')}]` : '';
        return '- Navy: ' + head + files;
      }).filter(Boolean);
      let digestAddition = lines.join('\n');
      // Preferred: let the model write a REAL summary of what's being forgotten
      // (decisions, files changed, unresolved threads) — the way Claude Code
      // compacts. Rare (once per ~20 turns), so the extra call is acceptable;
      // any failure falls back to the mechanical digest above.
      try {
        this.view?.webview.postMessage({ type: 'statusText', text: 'Condensing history…' });
        const excerpt = dropped
          .map(m => (m.role === 'user' ? 'User: ' : 'Navy: ') + (m.text || '').slice(0, 600))
          .join('\n').slice(0, 12000);
        const summary = await this._completeOnce(host, model, [
          { role: 'system', content: 'You compress coding-assistant conversation history. Summarize the excerpt into at most 10 terse bullet lines covering: decisions made, files created/changed and why, problems found and their status (fixed/open), and user preferences. No preamble — output only the bullets.' },
          { role: 'user', content: excerpt },
        ]);
        if (summary && summary.trim().length > 40) digestAddition = summary.trim();
      } catch (e) { this.log?.('history summarization failed (using mechanical digest): ' + e.message); }
      this.sessionDigest = ((this.sessionDigest || '') + '\n' + digestAddition).trim();
      if (this.sessionDigest.length > 6000) {
        this.sessionDigest = '…\n' + this.sessionDigest.slice(-6000);
      }
    }

    for (const item of this.messages) {
      messages.push({ role: item.role, content: item.text });
    }

    const userText = userParts.join('\n\n---\n\n');
    if (Array.isArray(images) && images.length > 0) {
      // Vision message: content array with text + image blocks (OpenAI-compatible format).
      const parts = [{ type: 'text', text: userText }];
      for (const dataUrl of images) {
        parts.push({ type: 'image_url', image_url: { url: dataUrl } });
      }
      messages.push({ role: 'user', content: parts });
    } else {
      messages.push({ role: 'user', content: userText });
    }
    this.messages.push({ role: 'user', text: prompt });

    this.lastReply = '';

    this.sendPendingApprovalsUpdate();
    this.view?.webview.postMessage({ type: 'start', model, activeFile, activeLanguage });

    let hitCap = false;   // declared outside try so finally{} can read it
    let usedTools = false; // outside try — the catch offers "Continue" only for turns with progress
    try {

      // One controller for the entire turn so Stop cancels both the current
      // stream AND any tool-loop iteration that follows it.
      this.abortController = new AbortController();
      // Watchdog: abort if a SINGLE model call hangs for 3 minutes. Reset every
      // iteration so long multi-step tasks that are making progress are never killed.
      const resetWatchdog = () => {
        clearTimeout(this._watchdog);
        this._watchdog = setTimeout(() => this.abortController?.abort(), 180_000);
      };
      resetWatchdog();

      // Loop-detection state: prevents re-reading the same file repeatedly.
      const seenReadCalls = new Set();
      let consecutiveReadOnlyIters = 0;
      const failedCommands = new Map(); // key → consecutive fail count for run_command/run_tests
      const fileEditCounts = new Map(); // path → successful-write count this turn (loop-of-edits guard)
      const FILE_EDIT_SOFT_CAP = 5;  // stop feeding fresh diagnostics + nudge to wrap up
      const FILE_EDIT_HARD_CAP = 10; // refuse further writes to this file for the rest of the turn

      // Change tracker: accumulates what the model touched so we can append a report footer.
      const taskChanges = { touched: new Map(), deleted: [], commands: [] };
      // touched: Map<inputPath, 'created'|'modified'>; commands: { cmd, exit }[]

      let lastAssistantText = ''; // final assistant text, persisted to history after the loop
      let hallucinationNudged = false; // false-completion-claim correction sent once
      let hallucinationWarned = false; // still claimed success after the nudge — tell the user
      // Only worth running the hallucination guard at all if the user's request
      // could plausibly have wanted a file created/changed — avoids false
      // positives on purely informational turns (computed once; the prompt text
      // doesn't change mid-turn).
      const promptRequestsFileAction = this._promptRequestsFileAction(prompt);
      const messagesRef = this.messages; // identity guard: clearChat/project-switch replace this array

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (this.abortController.signal.aborted) break;
        if (iteration > 0) {
          this.view?.webview.postMessage({ type: 'stepProgress', step: iteration + 1, max: maxIterations });
        }
        resetWatchdog();
        // Keep the request within the context window on long multi-step tasks.
        if (iteration > 0) this._compactMessages(messages);
        const { text: responseText, nativeToolCalls, tokenCounts, rawBlocks } = await streamAssistant(this, host, model, messages, temperature);
        // Model call finished — stop the watchdog so it can't fire while tools run or
        // while the user takes their time reviewing a pending edit approval.
        clearTimeout(this._watchdog);

        // Send token usage and context fill level after each model call.
        const totalTokens = tokenCounts.prompt + tokenCounts.completion;
        if (totalTokens > 0) {
          this.view?.webview.postMessage({ type: 'tokenCount', prompt: tokenCounts.prompt, completion: tokenCounts.completion, total: totalTokens });
          if (this.modelContextLength) {
            this.view?.webview.postMessage({ type: 'contextUsage', used: tokenCounts.prompt, max: this.modelContextLength });
          }
        }

        // Normalize tool-call ids BEFORE they're used in the assistant message or
        // the tool results, so both sides pair correctly even on providers that
        // return empty/duplicate ids (Cohere/others via OpenRouter).
        this._normalizeToolCallIds(nativeToolCalls);

        // Build the assistant message. When using native tool calling, include tool_calls
        // so the model receives proper conversation history on the next iteration.
        if (nativeToolCalls.length > 0) {
          // _rawBlocks preserves Anthropic thinking/tool_use blocks OR Gemini
          // thought/functionCall parts for exact replay on the next iteration
          // (required for thinking + tool use on either provider). Tagged with
          // the producing provider — the two shapes are NOT interchangeable, so
          // if the user switches provider mid-conversation, each native path
          // only trusts rawBlocks it recognizes as its own and safely falls back
          // to reconstructing from the generic tool_calls array otherwise.
          messages.push({ role: 'assistant', content: responseText || '', tool_calls: nativeToolCalls,
            ...(rawBlocks?.length ? { _rawBlocks: rawBlocks, _rawBlocksProvider: aiProviderForTag } : {}) });
        } else {
          messages.push({ role: 'assistant', content: responseText });
        }
        // Track the latest text but only persist the FINAL one to session history —
        // persisting every intermediate tool-loop message creates runs of consecutive
        // assistant entries that bloat context and can 400 on providers that require
        // alternating roles (Anthropic).
        if (responseText.trim()) lastAssistantText = responseText;

        // Prefer native tool calls; fall back to XML parsing for models that embed XML in text.
        const toolCalls = nativeToolCalls.length > 0
          ? nativeToolCalls.map(tc => {
              let args = {};
              try {
                args = typeof tc.function.arguments === 'string'
                  ? JSON.parse(tc.function.arguments)
                  : (tc.function.arguments || {});
              } catch (e) {
                args = { __parseError: e.message, tool: tc.function.name };
              }
              return { name: tc.function.name, args, id: tc.id || '' };
            })
          : parseToolCalls(responseText);

        const isDone = toolCalls.length === 0 ||
          toolCalls.every((t) => t.name === 'finish');

        // Hallucination guard: the model claims a file action succeeded but never
        // called a tool this whole turn. Give it exactly ONE correction chance
        // (weak models that truly can't emit tool calls would otherwise loop
        // forever); if it still can't act, let it finish but warn the user plainly
        // instead of silently trusting the claim.
        if (isDone && !usedTools && promptRequestsFileAction && this._looksLikeFalseCompletionClaim(responseText)) {
          if (!hallucinationNudged) {
            hallucinationNudged = true;
            messages.push({
              role: 'user',
              content: '[SYSTEM: You just described a file action (created/saved/written/updated) but did NOT call any tool — nothing was actually changed. If you want to create or edit a file, call the write_file or apply_edit tool NOW. Do not just repeat the code as text.]',
            });
            continue;
          }
          hallucinationWarned = true;
        }

        if (isDone) {
          this.lastReply = responseText;

          // Build automatic change-report footer from what the model actually touched.
          const changedFiles = [...taskChanges.touched.entries()];
          const deletedFiles = taskChanges.deleted.filter(Boolean);
          const ranCmds = taskChanges.commands;
          let footer = '';
          if (changedFiles.length || deletedFiles.length || ranCmds.length) {
            const parts = [];
            if (changedFiles.length) {
              const fileList = changedFiles.map(([p, type]) =>
                '`' + path.basename(p) + '`' + (type === 'created' ? ' *(new)*' : type === 'renamed' ? ' *(renamed)*' : '')
              ).join(', ');
              parts.push(`**${changedFiles.length} file${changedFiles.length !== 1 ? 's' : ''} changed:** ${fileList}`);
            }
            if (deletedFiles.length) {
              parts.push('**Deleted:** ' + deletedFiles.map(p => '`' + path.basename(p) + '`').join(', '));
            }
            if (ranCmds.length) {
              parts.push('**Commands:** ' + ranCmds.map(c => '`' + c.cmd + '`' + (c.exit === 0 ? ' ✓' : ' ✗')).join(', '));
            }
            footer = '\n\n---\n' + parts.join('  \n');
          }
          if (hallucinationWarned) {
            footer += (footer ? '\n' : '\n\n---\n')
              + '⚠️ **No files were actually changed.** The model described a file action above but never called a tool — nothing was saved. Ask it to actually write/apply the change, or apply the code yourself.';
          }

          if (!responseText.trim()) {
            if (usedTools) {
              this.view?.webview.postMessage({
                type: 'chunk',
                text: footer
                  ? '**Task complete.**' + footer
                  : '_Task complete. (No summary was provided — ask "what did you just do?" if you need details.)_',
              });
            } else {
              this.view?.webview.postMessage({
                type: 'chunk',
                text: '_No response received. The model may have hit its context limit, or the request timed out. Try sending again or switch to a different model._',
              });
            }
          } else if (footer) {
            // Model wrote a summary — append the objective change list after it.
            this.view?.webview.postMessage({ type: 'chunk', text: footer });
          }
          break;
        }

        // Last iteration — model is still using tools, meaning the task is unfinished.
        if (iteration === maxIterations - 1) { hitCap = true; }

        usedTools = true;
        const toolResults = [];
        const nonFinish = toolCalls.filter(t => t.name !== 'finish');

        const makeToolResult = (tool, result) => nativeToolCalls.length > 0
          ? { role: 'tool', tool_call_id: tool.id || '', content: String(result) }
          : { role: 'user', content: '<tool_result name="' + tool.name + '">\n' + result + '\n</tool_result>' };

        // Read-only tools are safe to run in parallel; writes must be sequential.
        const READ_ONLY = new Set(['read_file','read_lines','list_files','search_files','search_codebase',
          'find_relevant_files','search_docs','git_status','git_diff','git_log','git_blame','get_diagnostics',
          'find_symbol','find_references',
          'web_search','fetch_url','get_terminal_output','read_process_output']);

        // Tools whose results are stable — dedup prevents re-reading the same file in a loop.
        // web_search included so a weak model can't spin on the same query repeatedly.
        const DEDUP_TOOLS = new Set(['read_file','read_lines','list_files','search_files','search_codebase',
          'find_relevant_files','search_docs','git_status','git_diff','git_log','git_blame','get_diagnostics',
          'find_symbol','find_references','web_search']);
        // Command tools where repeated failure is tracked.
        const COMMAND_TOOLS = new Set(['run_command', 'run_tests']);
        // Write tools that touch files (used for the change-report footer).
        const WRITE_TOOLS = new Set(['write_file','apply_edit','edit_line','delete_line','insert_after_line']);

        // Track whether this iteration does any writes.
        const isAllReadOnly = nonFinish.every(t => READ_ONLY.has(t.name));
        if (isAllReadOnly) { consecutiveReadOnlyIters++; } else { consecutiveReadOnlyIters = 0; }

        // Separate out calls that should be short-circuited.
        const toolsToRun = [];
        for (const tool of nonFinish) {
          // Deduplicate stable read-only calls.
          if (DEDUP_TOOLS.has(tool.name)) {
            const key = tool.name + ':' + JSON.stringify(tool.args || {});
            if (seenReadCalls.has(key)) {
              const r = '[Already retrieved — content unchanged. Use your existing context and take action now instead of re-reading.]';
              this.view?.webview.postMessage({ type: 'toolResult', tool: tool.name, result: r });
              toolResults.push(makeToolResult(tool, r));
              continue;
            }
            seenReadCalls.add(key);
          }
          // Block retrying a persistently-failing command (≥2 consecutive failures with same args).
          if (COMMAND_TOOLS.has(tool.name)) {
            const cmdKey = tool.name + ':' + (tool.args?.command || tool.args?.filter || '');
            const n = failedCommands.get(cmdKey) || 0;
            if (n >= 2) {
              const r = `[Blocked: this command has already failed ${n} time(s) in a row. Do NOT retry — diagnose the error output above, fix the code, then run again.]`;
              this.view?.webview.postMessage({ type: 'toolResult', tool: tool.name, result: r });
              toolResults.push(makeToolResult(tool, r));
              continue;
            }
          }
          // Hard stop on a loop-of-edits: the same file has already been written
          // this many times in one turn (this is what the screenshot of 16+
          // consecutive "index.html ✓ Applied" cards was — usually a fix that
          // never actually resolves the diagnostic it's chasing).
          if (WRITE_TOOLS.has(tool.name) && tool.args?.path) {
            const editCount = fileEditCounts.get(tool.args.path) || 0;
            if (editCount >= FILE_EDIT_HARD_CAP) {
              const r = `[Blocked: ${tool.args.path} has already been edited ${editCount} times this turn with no finish(). This file will not accept further edits this turn. Call get_diagnostics on it and either explain to the user what's still wrong (and why you can't fix it automatically) or call finish() now.]`;
              this.view?.webview.postMessage({ type: 'toolResult', tool: tool.name, result: r });
              toolResults.push(makeToolResult(tool, r));
              continue;
            }
          }
          toolsToRun.push(tool);
        }

        if (toolsToRun.length > 1 && toolsToRun.every(t => READ_ONLY.has(t.name))) {
          const parallel = await Promise.all(toolsToRun.map(async tool => {
            this.view?.webview.postMessage({ type: 'toolCall', tool: tool.name, args: tool.args });
            const result = await this.executeTool(tool);
            this.view?.webview.postMessage({ type: 'toolResult', tool: tool.name, result });
            return makeToolResult(tool, result);
          }));
          toolResults.push(...parallel);
        } else {
          for (const tool of toolsToRun) {
            // Stop pressed mid-iteration — don't execute the remaining tools (a write
            // tool would still hit disk after the user asked everything to halt).
            if (this.abortController.signal.aborted) break;
            this.view?.webview.postMessage({ type: 'toolCall', tool: tool.name, args: tool.args });

            // Pre-call: check whether the file exists so we can label it 'created' vs 'modified'.
            let _fileIsNew = false;
            if (WRITE_TOOLS.has(tool.name) && tool.args?.path) {
              try { await vscode.workspace.fs.stat(vscode.Uri.file(this.resolveWorkspacePath(tool.args.path))); }
              catch { _fileIsNew = true; }
            }

            let result = await this.executeTool(tool);

            // Track command failures so we can block infinite retry loops.
            if (COMMAND_TOOLS.has(tool.name)) {
              const cmdKey = tool.name + ':' + (tool.args?.command || tool.args?.filter || '');
              if (typeof result === 'string' && /^Exit code: [^0\n]/.test(result)) {
                const n = (failedCommands.get(cmdKey) || 0) + 1;
                failedCommands.set(cmdKey, n);
                result += '\n\n[SYSTEM: This command failed. Do NOT run it again without first diagnosing the error and fixing the code. Analyze the output above, find the root cause, apply a fix, then retry.]';
              } else if (typeof result === 'string' && result.startsWith('Exit code: 0')) {
                failedCommands.delete(cmdKey);
              }
              // Record for the change-report footer.
              const exitMatch = String(result).match(/^Exit code: (\d+)/);
              if (exitMatch) taskChanges.commands.push({ cmd: tool.args?.command || tool.args?.filter || '', exit: parseInt(exitMatch[1]) });
            }
            // Record successful file writes + auto-verify with fresh diagnostics.
            if (WRITE_TOOLS.has(tool.name) && typeof result === 'string' && result.startsWith('Applied to')) {
              const p = tool.args?.path || '';
              if (p) {
                taskChanges.touched.set(p, _fileIsNew ? 'created' : 'modified');
                const editCount = (fileEditCounts.get(p) || 0) + 1;
                fileEditCounts.set(p, editCount);
                if (editCount < FILE_EDIT_SOFT_CAP) {
                  // Normal case: fresh diagnostics help the model verify its own edit.
                  result += await this._diagnosticsAfterWrite(p);
                } else if (editCount === FILE_EDIT_SOFT_CAP) {
                  // Stop feeding diagnostics from here — if the model has edited this
                  // file 5 times already, more of the same feedback is very likely
                  // what's DRIVING the loop rather than helping end it.
                  result += `\n\n[SYSTEM: You have edited ${p} ${editCount} times this turn. STOP iterating on small fixes here. Re-read the file if needed, make ONE decisive final edit, then call finish() and clearly state in your report if anything remains unresolved. Diagnostics will not be shown for further edits to this file this turn.]`;
                }
                // editCount > SOFT_CAP: no diagnostics, no repeated nudge — silence
                // itself discourages continuing, and the hard cap above is the backstop.
              }
            }
            if (tool.name === 'delete_file' && typeof result === 'string' && result.startsWith('Deleted')) {
              taskChanges.deleted.push(tool.args?.path || '');
            }
            if (tool.name === 'rename_file' && typeof result === 'string' && result.startsWith('Renamed')) {
              if (tool.args?.to) taskChanges.touched.set(tool.args.to, 'renamed');
            }
            if (tool.name === 'rename_symbol' && typeof result === 'string' && result.startsWith('Renamed')) {
              taskChanges.touched.set(tool.args?.name || 'symbol', 'renamed');
            }

            this.view?.webview.postMessage({ type: 'toolResult', tool: tool.name, result });
            toolResults.push(makeToolResult(tool, result));
          }
        }

        // After 3 straight read-only iterations with no action, inject a hard nudge.
        if (consecutiveReadOnlyIters >= 3 && toolResults.length > 0) {
          const nudge = `\n\n[SYSTEM: ${consecutiveReadOnlyIters} consecutive iterations with only reads and no changes. You now have sufficient context. Your next response MUST take action — apply_edit, write_file, run_command, or finish(). Do NOT read any more files.]`;
          const last = toolResults[toolResults.length - 1];
          last.content = String(last.content) + nudge;
        }

        for (const tr of toolResults) {
          messages.push(tr);
        }
      }

      // Persist only the final assistant message to session history (see note above).
      // Skip if the chat was cleared or the project switched mid-turn — this.messages
      // is a different array by then and pushing would create an orphan entry.
      if (lastAssistantText.trim() && this.messages === messagesRef) {
        // Attach what the turn changed so a restored session can still show it —
        // the live change-report footer is webview-only and lost on reload.
        const meta = {};
        if (taskChanges.touched.size)   meta.files   = [...taskChanges.touched.keys()].map(p => path.basename(p));
        if (taskChanges.deleted.length) meta.deleted = taskChanges.deleted.filter(Boolean).map(p => path.basename(p));
        if (taskChanges.commands.length) meta.commands = taskChanges.commands.length;
        this.messages.push({ role: 'assistant', text: lastAssistantText, ...(Object.keys(meta).length ? { meta } : {}) });
      }

      // Only auto-apply code fences in pure-chat mode (no tool use), to prevent double-applies.
      if (!usedTools) {
        const codeEdits = extractCodeEdits(this.lastReply);
        for (const edit of codeEdits) {
          await this.applyCode(edit.code, edit.path);
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        this.view?.webview.postMessage({ type: 'aborted' });
      } else {
        const p = vscode.workspace.getConfiguration('navy').get('provider', 'ollama');
        const providerLabel = providerDisplayName(p);
        // Classified + redacted: plain-language cause, concrete next steps, no account ids.
        this.log?.('provider error: ' + error.message);
        this.view?.webview.postMessage({ type: 'error', message: formatProviderError(providerLabel, error.message) });
        // The turn made real progress before failing — offer a one-click resume.
        if (usedTools) this.view?.webview.postMessage({ type: 'errorContinue' });
      }
    } finally {
      clearInterval(this._heartbeat);
      this._heartbeat = undefined;
      clearTimeout(this._watchdog);
      this._watchdog = undefined;
      this.abortController = undefined;
      this.isBusy = false;
      if (this.statusBarItem) this.statusBarItem.text = '☸ Navy';
      this.view?.webview.postMessage({ type: 'done' });
      if (hitCap) this.view?.webview.postMessage({ type: 'capReached', steps: maxIterations });
      // Persist the session after every turn — wrapped so a write failure never
      // prevents 'done' from being sent or the queue from draining.
      try { await this.saveProjectSession(); } catch (e) { this.log?.('session save failed: ' + e.message); }

      // Drain the message queue — process the next queued message if any.
      if (this.messageQueue.length > 0) {
        const next = this.messageQueue.shift();
        this.view?.webview.postMessage({ type: 'queueDrained', remaining: this.messageQueue.length });
        setImmediate(() => this.askNavy(next.prompt, next.includeContext, next.selectedModel, next.attachedFiles, next.images || []));
      }
    }
  }

  // Mid-turn context compaction: when the accumulated conversation gets too large,
  // replace the OLDEST tool results with a stub so long agent tasks don't blow the
  // model's context window. Messages are edited in place (never removed) so
  // tool_use/tool_result pairing stays intact for providers that require it.
  _compactMessages(messages) {
    const MAX_CHARS = 240000;   // ≈60k tokens — conservative floor across providers
    const KEEP_RECENT = 6;      // never touch the N most recent tool results
    const sizeOf = (m) => typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
    let total = 0;
    for (const m of messages) total += sizeOf(m);
    if (total <= MAX_CHARS) return;

    // Pasted images dominate the budget (megabytes of base64) — once we're over,
    // strip image blocks from all but the LAST vision message, keeping its text.
    const visionIdxs = messages
      .map((m, i) => Array.isArray(m.content) ? i : -1)
      .filter(i => i !== -1);
    for (const idx of visionIdxs.slice(0, -1)) {
      const m = messages[idx];
      const before = sizeOf(m);
      const texts = m.content.filter(p => p.type === 'text').map(p => p.text);
      m.content = texts.join('\n') + '\n[Image(s) removed from context to stay within the window.]';
      total -= before - sizeOf(m);
    }
    if (total <= MAX_CHARS) return;

    const toolIdxs = [];
    messages.forEach((m, i) => {
      if (m.role === 'tool') toolIdxs.push(i);
      else if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<tool_result')) toolIdxs.push(i);
    });

    const prunable = toolIdxs.slice(0, Math.max(0, toolIdxs.length - KEEP_RECENT));
    for (const idx of prunable) {
      if (total <= MAX_CHARS) break;
      const m = messages[idx];
      const before = sizeOf(m);
      if (before < 300) continue; // already small — pruning gains nothing
      const note = '[Old tool output pruned to keep the conversation within the context window. Re-run the tool if you need this data again.]';
      m.content = m.role === 'tool' ? note : `<tool_result name="pruned">\n${note}\n</tool_result>`;
      total -= before - sizeOf(m);
    }
  }

  // Promise-chain mutex: file-mutating tools from the main turn and background
  // tasks (/bg) run concurrently — without this they could interleave writes to
  // the same file. Read tools stay unserialized.
  _withWriteLock(fn) {
    const run = this._writeLock.then(fn, fn);
    this._writeLock = run.catch(() => {});
    return run;
  }

  // Detects a model claiming it completed a file action (created/saved/written/
  // updated/fixed a file, script, function...) in plain text with NO tool call
  // having been made. Weak/local models that can't reliably emit tool calls fall
  // back to normal chat behavior — print code, narrate success — and Navy would
  // otherwise trust that narration verbatim. Pure, so it's directly testable.
  // Deliberately requires a creation/change VERB near a file-ish NOUN (not just
  // the word "done") to avoid false positives on ordinary explanations.
  _looksLikeFalseCompletionClaim(text) {
    if (!text || !text.trim()) return false;
    const verb = 'creat(?:ed|e)|written|wrote|writing|sav(?:ed|e)|add(?:ed)?|updat(?:ed|e)|modif(?:ied|y)|fix(?:ed)?|implement(?:ed)?|generat(?:ed|e)|appl(?:ied|y)';
    // Generic nouns PLUS an actual filename pattern (hello.py, config.json, …) —
    // real replies almost always name the file, not the word "file" itself.
    const filename = '\\w[\\w-]*\\.[a-zA-Z0-9]{1,5}';
    const noun = '(?:file|script|function|class|module|component|program|' + filename + ')';
    // The gap allows periods (filenames contain them) but is capped short and
    // newline-free so it can't bridge two unrelated sentences.
    const gap = '[^\\n]{0,40}';
    const re1 = new RegExp('\\b(?:' + verb + ')\\b' + gap + noun, 'i');
    const re2 = new RegExp(noun + gap + '\\b(?:has been|is now|was)?\\s*(?:' + verb + ')\\b', 'i');
    return re1.test(text) || re2.test(text);
  }

  // Gate for the hallucination guard: only worth checking a response for a false
  // completion claim if the user's ORIGINAL request actually asked for a file to
  // be created/changed. Without this gate, a purely informational reply that
  // happens to mention "the file was updated" (e.g. describing git history, or
  // answering "did this file change recently") could misfire. Pure + testable.
  // Heuristic: does this model NAME suggest it's a small/weak model that's more
  // likely to hallucinate tool use? No provider exposes real capability info, so
  // this is name-pattern matching only — false positives just mean a capable
  // model gets a harmless extra reminder; false negatives mean a weak model
  // doesn't get the reinforcement (the base guard in askNavy still catches it).
  _isLikelySmallModel(model) {
    const m = String(model || '').toLowerCase();
    if (/\b(mini|tiny|nano|micro)\b/.test(m)) return true;
    const paramMatch = m.match(/[:\-_](\d+(?:\.\d+)?)b\b/);
    return Boolean(paramMatch && parseFloat(paramMatch[1]) <= 9);
  }

  _promptRequestsFileAction(prompt) {
    if (!prompt) return false;
    return /\b(write|create|generate|make|add|implement|build)\b[^.\n]{0,60}\b(file|script|function|class|module|component|program|test)\b/i.test(prompt)
        || /\b(fix|edit|update|modify|refactor|rewrite|change|save|apply)\b[^.\n]{0,60}\b(file|script|function|class|module|component|program|code|bug)\b/i.test(prompt)
        || /\b(write|create|generate|make|save)\s+(a|an|the|this|me)?\s*\w[\w-]*\.[a-zA-Z0-9]{1,5}\b/i.test(prompt);
  }

  // Normalize native tool calls to the exact OpenAI shape before they go into the
  // assistant message / tool results:
  //  • unique non-empty id — Cohere/others via OpenRouter return empty or duplicate
  //    ids, which breaks tool_call↔tool_result pairing ("id ... not found").
  //  • type: "function" — required by strict deserializers (DeepSeek 400s with
  //    "missing field `type`"); OpenAI/Groq/Ollama tolerate its absence.
  // Mutates in place so the assistant message and derived tool results stay in sync.
  _normalizeToolCallIds(nativeToolCalls) {
    const seen = new Set();
    for (const tc of nativeToolCalls || []) {
      if (!tc.id || seen.has(tc.id)) {
        tc.id = ((tc.function && tc.function.name) || 'tool') + '_' + this.generateId();
      }
      seen.add(tc.id);
      if (!tc.type) tc.type = 'function';
    }
    return nativeToolCalls;
  }

  async executeTool(tool, turnIdOverride) {
    const MUTATING = new Set(['write_file', 'apply_edit', 'edit_line', 'delete_line',
      'insert_after_line', 'delete_file', 'rename_file', 'rename_symbol']);
    if (MUTATING.has(tool.name)) {
      // Inside the mutex only one mutating tool runs at a time, so this field is
      // safe to set/restore around it — lets background-task edits carry their own
      // turnId instead of folding into the main turn's Undo Last Turn grouping.
      return await this._withWriteLock(async () => {
        const prev = this._checkpointTurnId;
        this._checkpointTurnId = turnIdOverride || this.currentTurnId;
        try { return await this._executeToolInner(tool); }
        finally { this._checkpointTurnId = prev; }
      });
    }
    return await this._executeToolInner(tool);
  }

  // (Re)connect MCP servers from navy.mcpServers. Non-fatal: a bad server is
  // reported in the status bar tooltip-ish message, never breaks Navy.
  async reloadMcpServers() {
    try {
      const config = vscode.workspace.getConfiguration('navy').get('mcpServers', {});
      if (!config || !Object.keys(config).length) { this.mcp.stop(); return; }
      const results = await this.mcp.start(config);
      const ok = results.filter(r => !r.error);
      const bad = results.filter(r => r.error);
      if (ok.length) {
        vscode.window.setStatusBarMessage(`Navy: ${this.mcp.toolCount} MCP tool${this.mcp.toolCount !== 1 ? 's' : ''} from ${ok.map(r => r.name).join(', ')}`, 8000);
      }
      for (const b of bad) {
        vscode.window.showWarningMessage(`Navy: MCP server "${b.name}" failed to start — ${b.error}`);
      }
    } catch (e) {
      this.log?.('MCP reload failed: ' + e.message);
    }
  }

  // Validate/coerce args against the tool's own schema (from tools.js) so a
  // model passing garbage gets a clear, actionable message instead of a Node
  // internals error like `The "path" argument must be of type string`.
  _validateToolArgs(tool) {
    const def = TOOLS.find(t => t.name === tool.name);
    if (!def) return null;
    const props = def.parameters?.properties || {};
    const required = def.parameters?.required || [];
    const args = tool.args || {};
    for (const r of required) {
      if (args[r] === undefined || args[r] === null) {
        return `Error: required parameter "${r}" is missing for ${tool.name}. Re-emit the call with all required parameters: ${required.join(', ')}.`;
      }
    }
    for (const [k, v] of Object.entries(args)) {
      const p = props[k];
      if (!p || v === undefined || v === null) continue;
      if (p.type === 'string' && typeof v !== 'string') {
        if (typeof v === 'number' || typeof v === 'boolean') args[k] = String(v);
        else return `Error: parameter "${k}" of ${tool.name} must be a string, got ${Array.isArray(v) ? 'array' : typeof v}.`;
      } else if (p.type === 'number' && typeof v !== 'number') {
        const n = Number(v);
        if (Number.isFinite(n)) args[k] = n;
        else return `Error: parameter "${k}" of ${tool.name} must be a number, got "${String(v).slice(0, 40)}".`;
      }
    }
    return null;
  }

  async _executeToolInner(tool) {
    try {
      const invalid = this._validateToolArgs(tool);
      if (invalid) return invalid;
      // External MCP tools: approval-gated in ask mode (their side effects are
      // unknown to Navy), then routed to the owning server.
      if (this.mcp?.isMcpTool(tool.name)) {
        const approvalMode = vscode.workspace.getConfiguration('navy').get('approvalMode', 'ask-always');
        if (approvalMode !== 'auto-approve') {
          const id = this.generateId();
          const label = tool.name.replace(/^mcp__/, '').replace(/__/, ' → ');
          this.view?.webview.postMessage({
            type: 'pendingCommand', id,
            command: `MCP: ${label}(${JSON.stringify(tool.args || {}).slice(0, 300)})`,
          });
          const approved = await new Promise((resolve) => {
            this.pendingCommandApprovals.set(id, { resolve });
          });
          if (!approved) return 'MCP call rejected by user.';
        }
        return await this.mcp.call(tool.name, tool.args);
      }
      switch (tool.name) {
        case 'read_file': return await this.toolReadFile(tool.args.path);
        case 'remember': return await this.toolRemember(tool.args.fact);
        case 'forget': return await this.toolForget(tool.args.query);
        case 'read_lines': return await this.toolReadLines(tool.args.path, tool.args.start, tool.args.end);
        case 'write_file': return await this.toolWriteFile(tool.args.path, tool.args.content);
        case 'delete_file': return await this.toolDeleteFile(tool.args.path);
        case 'rename_file': return await this.toolRenameFile(tool.args.from, tool.args.to);
        case 'rename_symbol': return await this.toolRenameSymbol(tool.args.path, tool.args.line, tool.args.name, tool.args.newName);
        case 'list_files': return await this.toolListFiles(tool.args.path, tool.args.maxDepth);
        case 'search_files': return await this.toolSearchFiles(tool.args.query);
        case 'apply_edit': return await this.toolApplyEdit(tool.args.path, tool.args.search, tool.args.replace);
        case 'edit_line': return await this.toolEditLine(tool.args.path, tool.args.line, tool.args.content);
        case 'delete_line': return await this.toolDeleteLine(tool.args.path, tool.args.line);
        case 'insert_after_line': return await this.toolInsertAfterLine(tool.args.path, tool.args.line, tool.args.content);
        case 'run_command': return await this.toolRunCommand(tool.args.command, tool.args.timeout);
        case 'run_project': return await this.toolRunProject(tool.args.command);
        case 'start_process': return await this.toolStartProcess(tool.args.id, tool.args.command);
        case 'read_process_output': return await this.toolReadProcessOutput(tool.args.id, tool.args.clear);
        case 'kill_process': return await this.toolKillProcess(tool.args.id);
        case 'git_blame': return await this.toolGitBlame(tool.args.path, tool.args.startLine, tool.args.endLine);
        case 'find_symbol': return await this.toolFindSymbol(tool.args.name);
        case 'find_references': return await this.toolFindReferences(tool.args.name);
        case 'web_search': return await this.toolWebSearch(tool.args.query, tool.args.maxResults);
        case 'git_status': return await this.toolGitStatus();
        case 'git_diff': return await this.toolGitDiff(tool.args.path, tool.args.staged);
        case 'git_log': return await this.toolGitLog(tool.args.count);
        case 'get_diagnostics': return await this.toolGetDiagnostics(tool.args.path);
        case 'fetch_url': return await this.toolFetchUrl(tool.args.url);
        case 'get_terminal_output': return await this.toolGetTerminalOutput(tool.args.lines);
        case 'run_tests': return await this.toolRunTests(tool.args.filter);
        case 'search_codebase': return await this.toolSearchCodebase(tool.args.query, tool.args.filePattern, tool.args.contextLines);
        case 'search_docs': return await this.toolSearchDocs(tool.args.query, tool.args.maxResults);
        case 'find_relevant_files': return await this.toolFindRelevantFiles(tool.args.query, tool.args.maxResults);
        case '__parse_error__':
          return 'Tool call JSON was invalid and could not be parsed. Tool attempted: ' + tool.args.tool + '. Error: ' + tool.args.error + '. Please re-emit the tool block with valid JSON.';
        default: return 'Unknown tool: ' + tool.name;
      }
    } catch (error) {
      return 'Error: ' + error.message;
    }
  }

  // After a successful write, fetch fresh LSP diagnostics for the file so the model
  // immediately sees any errors its edit introduced — no need for it to remember to check.
  async _diagnosticsAfterWrite(inputPath) {
    try {
      const filePath = this.resolveWorkspacePath(inputPath);
      // Give the language server a moment to re-analyze the new content.
      await new Promise(r => setTimeout(r, 900));
      const diags = vscode.languages.getDiagnostics(vscode.Uri.file(filePath))
        .filter(d => d.severity === 0 || d.severity === 1); // errors + warnings only
      if (!diags.length) return '';
      const lines = diags.slice(0, 10).map(d => {
        const sev = d.severity === 0 ? 'Error' : 'Warning';
        return `[${sev}] line ${d.range.start.line + 1}: ${d.message}`;
      });
      const more = diags.length > 10 ? `\n…and ${diags.length - 10} more` : '';
      return `\n\n[POST-EDIT DIAGNOSTICS for ${path.basename(filePath)} — fix any Errors before finishing:]\n${lines.join('\n')}${more}`;
    } catch { return ''; }
  }

  // Resolves paths to absolute and enforces workspace containment to prevent
  // prompt-injection attacks that try to read/write files outside the project.
  resolveWorkspacePath(inputPath) {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw new Error('No project root — open a folder before using file tools');

    const candidate = path.isAbsolute(inputPath) ? inputPath : path.join(root, inputPath);
    // Windows paths are case-insensitive — compare case-folded there so "e:\code ex\…"
    // isn't falsely rejected against a root of "E:\Code Ex". Containment is unaffected.
    const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
    const normalRoot = fold(path.normalize(root));
    const normalCandidate = fold(path.normalize(candidate));
    if (normalCandidate !== normalRoot && !normalCandidate.startsWith(normalRoot + path.sep)) {
      throw new Error('Path is outside the workspace root: ' + inputPath);
    }

    // Resolve symlinks to prevent traversal through symlinks inside the workspace
    try {
      const real = fold(fs.realpathSync(candidate));
      const realRoot = fold(fs.realpathSync(root));
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw new Error('Path resolves outside workspace root via symlink: ' + inputPath);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // file not yet created — lexical check above is sufficient
    }

    return candidate;
  }

  async toolReadFile(inputPath) {
    const filePath = this.resolveWorkspacePath(inputPath);
    // Jupyter notebooks — extract cells and their outputs as readable text.
    if (filePath.endsWith('.ipynb')) {
      try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        const nb = JSON.parse(raw);
        const parts = [`# Jupyter Notebook: ${path.basename(filePath)}\n`];
        for (let i = 0; i < (nb.cells || []).length; i++) {
          const cell = nb.cells[i];
          const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
          const lang = nb.metadata?.kernelspec?.language || 'python';
          if (cell.cell_type === 'code') {
            parts.push(`## Cell ${i + 1} [code]\n\`\`\`${lang}\n${src}\n\`\`\``);
            for (const out of (cell.outputs || [])) {
              if (out.output_type === 'stream') {
                const t = Array.isArray(out.text) ? out.text.join('') : (out.text || '');
                if (t.trim()) parts.push(`\`\`\`\n${t.trim()}\n\`\`\``);
              } else if (out.output_type === 'execute_result' || out.output_type === 'display_data') {
                const t = out.data?.['text/plain'];
                if (t) parts.push(`\`\`\`\n${(Array.isArray(t) ? t.join('') : t).trim()}\n\`\`\``);
              } else if (out.output_type === 'error') {
                parts.push(`**Error:** ${out.ename}: ${out.evalue}`);
              }
            }
          } else if (cell.cell_type === 'markdown') {
            parts.push(`## Cell ${i + 1} [markdown]\n${src}`);
          } else {
            parts.push(`## Cell ${i + 1} [${cell.cell_type}]\n${src}`);
          }
        }
        return parts.join('\n\n');
      } catch (e) {
        return 'Error reading notebook: ' + e.message;
      }
    }
    const text = await this.readFileText(filePath);
    if (text === null) return 'Error: could not read ' + inputPath;
    const lines = text.split('\n');
    const MAX_READ_LINES = 500;
    const MAX_READ_CHARS = 60000; // guards minified single-line files that dodge the line cap
    if (lines.length > MAX_READ_LINES) {
      const truncated = lines.slice(0, MAX_READ_LINES).join('\n');
      return truncated.slice(0, MAX_READ_CHARS) + `\n\n[FILE TRUNCATED: showing ${MAX_READ_LINES} of ${lines.length} lines. Use read_lines("${inputPath}", startLine, endLine) to read other sections.]`;
    }
    if (text.length > MAX_READ_CHARS) {
      return text.slice(0, MAX_READ_CHARS) + `\n\n[FILE TRUNCATED: showing ${MAX_READ_CHARS} of ${text.length} characters.]`;
    }
    return text;
  }

  async toolListFiles(inputPath, maxDepth = 1) {
    const dirPath = this.resolveWorkspacePath(inputPath);
    try {
      const lines = [];
      await this._listDir(dirPath, '', maxDepth, 0, lines);
      if (lines.length > 400) {
        return lines.slice(0, 400).join('\n')
          + `\n… (${lines.length - 400} more entries — list a subdirectory or lower maxDepth)`;
      }
      return lines.join('\n') || '(empty directory)';
    } catch (error) {
      return 'Error: ' + error.message;
    }
  }

  async _listDir(dirPath, prefix, maxDepth, depth, lines) {
    // Hard stop above the 400-entry display cap — a huge directory (generated data,
    // vendored assets) must not build a million-entry array before we slice it.
    if (lines.length > 1200) return;
    const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.next', '__pycache__', '.venv']);
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (lines.length > 1200) return;
      if (entry.isDirectory()) {
        lines.push(prefix + entry.name + '/');
        if (depth < maxDepth - 1 && !SKIP.has(entry.name)) {
          await this._listDir(path.join(dirPath, entry.name), prefix + '  ', maxDepth, depth + 1, lines);
        }
      } else {
        lines.push(prefix + entry.name);
      }
    }
  }

  // Locate VS Code's bundled ripgrep so searches are fast and respect .gitignore.
  // Returns the binary path or null (then callers fall back to the JS walk).
  _findRipgrep() {
    if (this._rgPath !== undefined) return this._rgPath;
    const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const arch = `${process.platform}-${process.arch}`;
    const candidates = [
      path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
      path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
      path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep-universal', 'bin', arch, exe),
      path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', arch, exe),
    ];
    this._rgPath = candidates.find(c => { try { return fs.existsSync(c); } catch { return false; } }) || null;
    return this._rgPath;
  }

  // Run ripgrep with an output cap. Resolves { code, out } — never rejects.
  _rgRun(rgPath, args, cwd, maxOut = 60000) {
    return new Promise((resolve) => {
      const proc = spawn(rgPath, args, { cwd });
      let out = '';
      proc.stdout.on('data', d => {
        out += d.toString();
        if (out.length > maxOut) { out = out.slice(0, maxOut); this._killProcessTree(proc); }
      });
      proc.stderr.on('data', () => {});
      proc.on('close', code => resolve({ code: code ?? 0, out }));
      proc.on('error', () => resolve({ code: -1, out: '' }));
    });
  }

  async toolSearchFiles(query) {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'No workspace open';
    try {
      // Fast path: bundled ripgrep — respects .gitignore, searches the whole tree.
      const rg = this._findRipgrep();
      if (rg) {
        const { code, out } = await this._rgRun(rg,
          ['--line-number', '--max-count', '1', '--fixed-strings', '--max-filesize', '512K',
           '--no-heading', '--with-filename', '--', query, '.'], root);
        if (code === 0) {
          const lines = out.split('\n').filter(Boolean).slice(0, 20)
            .map(l => l.replace(/^\.[\\/]/, '').replace(/:(\d+):/, ':$1 '));
          if (lines.length) return lines.join('\n');
        }
        if (code === 1) return 'No matches';
        // code 2 / -1 → rg failed, fall through to the JS walk
      }
      const results = [];
      await this.searchDirectory(root, query, results, 0, root);
      return results.slice(0, 20).join('\n') || 'No matches';
    } catch (error) {
      return 'Error: ' + error.message;
    }
  }

  async searchDirectory(dir, query, results, depth, root) {
    if (depth > 2) return;
    if (results.length >= 20) return; // caller shows 20 — stop reading files past that
    const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '__pycache__', '.venv']);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= 20) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) {
          await this.searchDirectory(full, query, results, depth + 1, root);
        }
      } else {
        try {
          const stat = await fs.promises.stat(full);
          if (stat.size > 512 * 1024) continue; // skip files larger than 512 KB
          const text = await fs.promises.readFile(full, 'utf8');
          if (text.includes(query)) {
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(query)) {
                results.push(path.relative(root, full) + ':' + (i + 1) + ' ' + lines[i].trim());
                break;
              }
            }
          }
        } catch {}
      }
    }
  }

  async toolReadLines(inputPath, start, end) {
    const filePath = this.resolveWorkspacePath(inputPath);
    const text = await this.readFileText(filePath);
    if (text === null) return 'Error: could not read file: ' + inputPath;
    const lines = text.split('\n');
    const s = Math.max(1, start || 1);
    const e = end ? Math.min(end, lines.length) : lines.length;
    if (s > lines.length) return `File only has ${lines.length} lines.`;
    return lines.slice(s - 1, e)
      .map((l, i) => `${s + i}: ${l}`)
      .join('\n');
  }

  async toolWriteFile(inputPath, content) {
    const filePath = this.resolveWorkspacePath(inputPath);
    const existingText = await this.readFileText(filePath) || '';
    return await this.requestWriteApproval(inputPath, filePath, existingText, content);
  }

  async toolDeleteFile(inputPath) {
    const filePath = this.resolveWorkspacePath(inputPath);
    const basename = path.basename(filePath);
    const approvalMode = vscode.workspace.getConfiguration('navy').get('approvalMode', 'ask-always');
    if (approvalMode !== 'auto-approve') {
      // Modal dialogs add their own Cancel button — only pass the confirm action.
      const choice = await vscode.window.showWarningMessage(
        `Navy wants to delete ${basename}. It will be moved to the Recycle Bin.`,
        { modal: true },
        'Delete'
      );
      if (choice !== 'Delete') return `Deletion of ${basename} cancelled by user.`;
    }
    try {
      // Snapshot single files (≤5 MB) before deleting so Undo can restore them.
      // Directories aren't snapshotted — the Recycle Bin covers those.
      let snapshot = null;
      try {
        const st = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
        if (st.type === vscode.FileType.File && st.size <= 5_000_000) {
          snapshot = await this.readFileText(filePath);
        }
      } catch {}
      await vscode.workspace.fs.delete(vscode.Uri.file(filePath), { recursive: true, useTrash: true });
      if (snapshot !== null) this._pushCheckpoint({ kind: 'delete', filePath, originalText: snapshot });
      return `Deleted ${basename} (moved to Recycle Bin${snapshot !== null ? '; Undo can restore it' : ''}).`;
    } catch (e) {
      return `Error deleting ${basename}: ${e.message}`;
    }
  }

  async toolRenameFile(fromPath, toPath) {
    if (!fromPath || !toPath) return 'Error: both from and to paths are required.';
    // Both ends must stay inside the workspace — a rename is a read at `from`
    // plus a write at `to`, so it gets the same containment rules as each.
    const src = this.resolveWorkspacePath(fromPath);
    const dst = this.resolveWorkspacePath(toPath);
    const fromName = path.basename(src);
    const approvalMode = vscode.workspace.getConfiguration('navy').get('approvalMode', 'ask-always');
    if (approvalMode !== 'auto-approve') {
      const choice = await vscode.window.showWarningMessage(
        `Navy wants to rename ${fromName} → ${toPath}`,
        { modal: true },
        'Rename'
      );
      if (choice !== 'Rename') return `Rename of ${fromName} cancelled by user.`;
    }
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(dst)));
      await vscode.workspace.fs.rename(vscode.Uri.file(src), vscode.Uri.file(dst), { overwrite: false });
      this._pushCheckpoint({ kind: 'rename', from: src, to: dst });
      return `Renamed ${fromPath} → ${toPath}`;
    } catch (e) {
      return `Error renaming ${fromName}: ${e.message}`;
    }
  }

  // Structural, workspace-wide rename via the language server. Updates every
  // reference correctly (unlike text replace) and records an undo checkpoint per
  // affected file so the whole rename is reversible as one turn.
  async toolRenameSymbol(inputPath, line, name, newName) {
    if (!inputPath || !line || !name || !newName) {
      return 'Error: path, line, name, and newName are all required.';
    }
    const filePath = this.resolveWorkspacePath(inputPath);
    const text = await this.readFileText(filePath);
    if (text === null) return 'Error: could not read ' + inputPath;
    const lines = text.split('\n');
    const idx = line - 1;
    if (idx < 0 || idx >= lines.length) return `Error: line ${line} is out of range (file has ${lines.length} lines).`;
    const col = lines[idx].indexOf(name);
    if (col === -1) return `Error: "${name}" not found on line ${line} of ${path.basename(filePath)}. Read the file to confirm the exact line and spelling.`;

    const uri = vscode.Uri.file(filePath);
    try {
      await vscode.workspace.openTextDocument(uri); // ensure the LS has indexed it
      const position = new vscode.Position(idx, col + 1);
      const edit = await vscode.commands.executeCommand(
        'vscode.executeDocumentRenameProvider', uri, position, newName
      );
      const entries = edit && typeof edit.entries === 'function' ? edit.entries() : [];
      if (!entries.length) {
        return `The language server could not rename "${name}" (no rename provider for this file type, or the symbol isn't renameable). Fall back to apply_edit / search_codebase.`;
      }

      // Containment: every other write tool refuses to touch files outside the
      // workspace, but these edit targets come straight from the language server
      // (could include SDK stubs / linked files). If ANY is outside the root,
      // refuse the whole rename — never partially apply or edit outside the project.
      const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (root) {
        const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
        const nRoot = fold(path.normalize(root));
        const outside = entries
          .map(([u]) => u.fsPath)
          .filter(fp => { const n = fold(path.normalize(fp)); return n !== nRoot && !n.startsWith(nRoot + path.sep); });
        if (outside.length) {
          return `Refused: renaming "${name}" would also modify ${outside.length} file(s) OUTSIDE the workspace (e.g. ${path.basename(outside[0])}). Navy only edits files inside the project. Use apply_edit for an in-project-only change if that's what you intended.`;
        }
      }

      const approvalMode = vscode.workspace.getConfiguration('navy').get('approvalMode', 'ask-always');
      if (approvalMode !== 'auto-approve') {
        const choice = await vscode.window.showWarningMessage(
          `Navy wants to rename "${name}" → "${newName}" across ${entries.length} file${entries.length !== 1 ? 's' : ''} (structural, all references).`,
          { modal: true }, 'Rename'
        );
        if (choice !== 'Rename') return `Rename of "${name}" cancelled by user.`;
      }

      // Snapshot every affected file BEFORE applying, but only record checkpoints
      // AFTER the edit succeeds — a rejected edit must not pollute undo history
      // with entries for files that never changed.
      const snapshots = [];
      for (const [fileUri] of entries) {
        const original = await this.readFileText(fileUri.fsPath);
        if (original !== null) snapshots.push({ filePath: fileUri.fsPath, original });
      }
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) return `Error: the workspace edit for renaming "${name}" was rejected.`;
      for (const s of snapshots) {
        this._pushCheckpoint({ kind: 'edit', filePath: s.filePath, originalText: s.original });
      }
      const affected = snapshots.map(s => s.filePath);
      const names = affected.map(f => path.basename(f));
      return `Renamed "${name}" → "${newName}" across ${affected.length} file${affected.length !== 1 ? 's' : ''}: ${names.join(', ')}`;
    } catch (e) {
      return `rename_symbol failed: ${e.message}. Fall back to apply_edit.`;
    }
  }

  async toolEditLine(inputPath, lineNumber, content) {
    const filePath = this.resolveWorkspacePath(inputPath);
    const existing = await this.readFileText(filePath) || '';
    const lines = existing.split('\n');
    const idx = lineNumber - 1;
    if (idx < 0 || idx >= lines.length) {
      return `Line ${lineNumber} is out of range (file has ${lines.length} lines).`;
    }
    const oldLine = lines[idx];
    lines[idx] = content;
    const newText = lines.join('\n');
    const result = await this.requestWriteApproval(inputPath, filePath, existing, newText);
    if (result.startsWith('Applied')) this.highlightChangedLines(filePath, [idx], []);
    return result;
  }

  async toolDeleteLine(inputPath, lineNumber) {
    const filePath = this.resolveWorkspacePath(inputPath);
    const existing = await this.readFileText(filePath) || '';
    const lines = existing.split('\n');
    const idx = lineNumber - 1;
    if (idx < 0 || idx >= lines.length) {
      return `Line ${lineNumber} is out of range (file has ${lines.length} lines).`;
    }
    lines.splice(idx, 1);
    const newText = lines.join('\n');
    return await this.requestWriteApproval(inputPath, filePath, existing, newText);
  }

  async toolGitStatus() {
    return await this.runGit(['status', '--short', '--branch']);
  }

  async toolGitDiff(filePath, staged = false) {
    const args = ['diff'];
    if (staged) args.push('--staged');
    if (filePath) args.push('--', this.resolveWorkspacePath(filePath));
    const out = await this.runGit(args);
    return out.slice(0, 8000) || 'No diff';
  }

  async toolGitLog(count = 10) {
    return await this.runGit(['log', `--oneline`, `-${Math.min(count, 50)}`, '--decorate']);
  }

  async runGit(args) {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'No workspace open';
    return new Promise((resolve) => {
      const proc = spawn('git', args, { cwd: root });
      let out = '';
      let err = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.stderr.on('data', d => { err += d.toString(); });
      proc.on('close', code => resolve(out || err || `git exited with code ${code}`));
      proc.on('error', e => resolve('git error: ' + e.message));
    });
  }

  async toolGetDiagnostics(filePath) {
    let targetUri;
    if (filePath) {
      targetUri = vscode.Uri.file(this.resolveWorkspacePath(filePath));
    } else {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return 'No active file open.';
      targetUri = editor.document.uri;
    }
    const diags = vscode.languages.getDiagnostics(targetUri);
    if (diags.length === 0) return 'No diagnostics (no errors or warnings).';
    return diags.map(d => {
      const sev = ['Error', 'Warning', 'Info', 'Hint'][d.severity] || '?';
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      return `[${sev}] line ${line}:${col} — ${d.message}${d.source ? ' (' + d.source + ')' : ''}`;
    }).join('\n');
  }

  // Block private/local addresses: loopback, RFC-1918, link-local, IPv6 loopback,
  // decimal-encoded IPs (e.g. 2130706433 = 127.0.0.1), cloud metadata endpoints.
  _isBlockedHost(h) {
    return /^(localhost|127\.|0\.0\.0\.0|::1|::ffff:|0:0:0:0:0:0:0:1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(h)
      || /^[0-9]+$/.test(h)   // decimal IP like 2130706433
      || h === 'metadata.google.internal'
      || h.endsWith('.internal')
      || h.endsWith('.local');
  }

  async toolFetchUrl(url) {
    try {
      // Follow redirects MANUALLY so every hop is re-validated — otherwise a public
      // URL that 302s to 127.0.0.1 or a metadata endpoint bypasses the SSRF block.
      let current = url;
      for (let hop = 0; hop < 5; hop++) {
        let parsed;
        try { parsed = new URL(current); } catch { return 'Fetch error: invalid URL'; }
        if (!/^https?:$/i.test(parsed.protocol)) return 'Fetch error: only http/https URLs are allowed';
        const h = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (this._isBlockedHost(h)) return 'Fetch error: fetching private or local addresses is not allowed';
        const res = await fetch(current, {
          signal: AbortSignal.timeout(15000),
          headers: { 'User-Agent': 'NavyCoder/1.0' },
          redirect: 'manual',
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) return `HTTP ${res.status}: redirect with no Location header`;
          current = new URL(loc, current).href; // re-validated at top of loop
          continue;
        }
        if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`;
        const ct = res.headers.get('content-type') || '';
        let text = await res.text();
        if (ct.includes('html')) {
          text = text
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
        }
        return text.slice(0, 12000);
      }
      return 'Fetch error: too many redirects (max 5)';
    } catch (e) {
      return 'Fetch error: ' + e.message;
    }
  }

  async toolGetTerminalOutput(maxLines = 100) {
    const terminals = vscode.window.terminals;
    if (terminals.length === 0) return 'No terminals open.';
    const names = terminals.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
    return `Open terminals:\n${names}\n\nVS Code does not expose terminal buffer contents to extensions. To capture output, re-run the command yourself via run_command, or use start_process + read_process_output for long-running processes.`;
  }

  _shellEscapeArg(s) {
    if (process.platform === 'win32') {
      // cmd /c: % must be doubled (%%) to suppress variable expansion — ^% does NOT work
      // because cmd.exe expands %VAR% before processing ^ escapes.
      // Other shell metacharacters are escaped with caret inside double quotes.
      return '"' + s.replace(/%/g, '%%').replace(/([&|<>^"!])/g, '^$1') + '"';
    }
    // POSIX sh: single-quote wrap — fully safe against all meta-characters
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  async toolRunTests(filter) {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'No workspace open.';

    let cmd = null;
    try {
      const pkg = JSON.parse(await fs.promises.readFile(path.join(root, 'package.json'), 'utf8'));
      const scripts = pkg.scripts || {};
      if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
        // Jest-specific flags break other runners (mocha, node:test, ava) — only pass
        // them when jest is actually in play.
        const isJest = /\bjest\b/.test(scripts.test) || Boolean(pkg.devDependencies?.jest || pkg.dependencies?.jest);
        cmd = isJest
          ? 'npm test -- --watchAll=false' + (filter ? ' --testNamePattern=' + JSON.stringify(filter) : '')
          : 'npm test';
      } else if (scripts['test:unit']) cmd = 'npm run test:unit';
      else if (scripts.vitest || pkg.devDependencies?.vitest || pkg.dependencies?.vitest) {
        cmd = 'npx vitest run' + (filter ? ' -t ' + JSON.stringify(filter) : '');
      }
    } catch {}

    if (!cmd) {
      const checks = [
        [path.join(root, 'pytest.ini'), 'python -m pytest' + (filter ? ' -k ' + JSON.stringify(filter) : '') + ' -v'],
        [path.join(root, 'setup.py'), 'python -m pytest' + (filter ? ' -k ' + JSON.stringify(filter) : '') + ' -v'],
        [path.join(root, 'pyproject.toml'), 'python -m pytest' + (filter ? ' -k ' + JSON.stringify(filter) : '') + ' -v'],
        [path.join(root, 'Cargo.toml'), 'cargo test' + (filter ? ' -- ' + this._shellEscapeArg(filter) : '')],
        [path.join(root, 'go.mod'), 'go test ./...' + (filter ? ' -run ' + this._shellEscapeArg(filter) : '')],
      ];
      for (const [file, testCmd] of checks) {
        try { await fs.promises.access(file); cmd = testCmd; break; } catch {}
      }
    }

    if (!cmd) return 'Could not detect test framework. Tried npm test, pytest, cargo test, go test.';

    const result = await this.toolRunCommand(cmd, 60000);
    return result.slice(0, 8000);
  }

  // Search only the project's OWN documentation (README/CHANGELOG/CONTRIBUTING/
  // docs//*.md etc.) — lets the agent check "did the project already answer
  // this" before guessing at conventions or setup steps. Shares the same
  // ripgrep/JS-walk infrastructure as search_codebase, scoped by file type/name.
  async toolSearchDocs(query, maxResults = 8) {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'No workspace open.';
    const cap = Math.max(1, Math.min(maxResults || 8, 25));

    const rg = this._findRipgrep();
    if (rg) {
      const args = ['--line-number', '--context', '2', '--max-count', '3',
        '--max-filesize', '300K', '--max-columns', '300', '--smart-case', '--heading',
        '--glob', '*.{md,mdx,txt,rst}',
        '--glob', 'README*', '--glob', 'CHANGELOG*', '--glob', 'CONTRIBUTING*', '--glob', 'AGENTS*',
        '--glob', 'docs/**', '--glob', 'doc/**',
        '-e', query, '.'];
      const { code, out } = await this._rgRun(rg, args, root);
      if (code === 0 && out.trim()) {
        const text = out.replace(/^\.[\\/]/gm, '');
        const note = text.length > 12000 ? '\n\n[Results truncated — narrow the query.]' : '';
        return text.slice(0, 12000).trim() + note;
      }
      if (code === 1) return `No documentation matches for "${query}". Try search_codebase for source code instead.`;
      // code 2 / spawn failure → fall through to the JS walk below
    }

    const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', 'coverage', '.cache']);
    const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst']);
    const DOC_NAME_RE = /^(README|CHANGELOG|CONTRIBUTING|LICENSE|AGENTS)(\.|$)/i;
    const results = [];
    const walk = async (dir, depth) => {
      if (results.length >= cap || depth > 4) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (results.length >= cap) return;
        if (e.isDirectory()) {
          if (!SKIP.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), depth + 1);
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (!DOC_EXT.has(ext) && !DOC_NAME_RE.test(e.name)) continue;
        const full = path.join(dir, e.name);
        try {
          const stat = await fs.promises.stat(full);
          if (stat.size > 300 * 1024) continue;
          const text = await fs.promises.readFile(full, 'utf8');
          const lines = text.split('\n');
          const idx = lines.findIndex(l => l.toLowerCase().includes(query.toLowerCase()));
          if (idx !== -1) {
            const rel = path.relative(root, full).replace(/\\/g, '/');
            const start = Math.max(0, idx - 2), end = Math.min(lines.length, idx + 3);
            const snippet = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
            results.push(`${rel}:${idx + 1}\n${snippet}`);
          }
        } catch {}
      }
    };
    await walk(root, 0);
    if (!results.length) return `No documentation matches for "${query}". Try search_codebase for source code instead.`;
    return results.join('\n\n---\n\n');
  }

  async toolSearchCodebase(query, filePattern, contextLines = 2) {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'No workspace open.';

    // Fast path: bundled ripgrep — .gitignore-aware, full-tree, regex-capable.
    const rg = this._findRipgrep();
    if (rg) {
      const args = ['--line-number', '--context', String(Math.min(contextLines, 6)), '--max-count', '3',
        '--max-filesize', '300K', '--max-columns', '300', '--smart-case', '--heading'];
      if (filePattern) args.push('--glob', filePattern);
      args.push('-e', query, '.');
      const { code, out } = await this._rgRun(rg, args, root);
      if (code === 0 && out.trim()) {
        const text = out.replace(/^\.[\\/]/gm, '');
        const note = text.length > 16000 ? '\n\n[Results truncated — narrow the query or add a filePattern.]' : '';
        return text.slice(0, 16000).trim() + note;
      }
      if (code === 1) return `No matches for "${query}"`;
      // code 2 (bad regex/glob) or spawn failure → fall through to the JS walk below
    }

    const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', 'coverage', '.cache']);
    const results = [];
    let fileRegex = null;
    if (filePattern) {
      const escaped = filePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      fileRegex = new RegExp(escaped);
    }

    let searchRegex;
    try { searchRegex = new RegExp(query, 'i'); }
    catch { searchRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }

    const walk = async (dir) => {
      if (results.length >= 30) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (results.length >= 30) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP.has(e.name) && !e.name.startsWith('.')) await walk(full);
        } else {
          const rel = path.relative(root, full);
          if (fileRegex && !fileRegex.test(rel)) continue;
          try {
            const stat = await fs.promises.stat(full);
            if (stat.size > 300 * 1024) continue;
            const text = await fs.promises.readFile(full, 'utf8');
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (searchRegex.test(lines[i])) {
                const start = Math.max(0, i - contextLines);
                const end = Math.min(lines.length - 1, i + contextLines);
                const snippet = lines.slice(start, end + 1)
                  .map((l, idx) => `${start + idx + 1}${start + idx === i ? '>' : ' '} ${l}`)
                  .join('\n');
                results.push(`${rel}:${i + 1}\n${snippet}`);
                if (results.length >= 30) break;
              }
            }
          } catch {}
        }
      }
    };

    await walk(root);
    if (results.length === 0) return `No matches for "${query}"`;
    return results.join('\n\n---\n\n');
  }

  async toolInsertAfterLine(inputPath, lineNumber, content) {
    const filePath = this.resolveWorkspacePath(inputPath);
    const existing = await this.readFileText(filePath) || '';
    const lines = existing.split('\n');
    const idx = Math.max(0, Math.min(lineNumber, lines.length));
    const insertLines = content.split('\n');
    lines.splice(idx, 0, ...insertLines);
    const newText = lines.join('\n');
    const insertedIndices = Array.from({ length: insertLines.length }, (_, i) => idx + i);
    const result = await this.requestWriteApproval(inputPath, filePath, existing, newText);
    if (result.startsWith('Applied')) this.highlightChangedLines(filePath, insertedIndices, []);
    return result;
  }

  // Compute changed line indices from old→new full-text diff and highlight them.
  highlightWriteChanges(filePath, oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const added = [];
    const modified = [];
    for (let i = 0; i < newLines.length; i++) {
      if (i >= oldLines.length) {
        added.push(i);
      } else if (oldLines[i] !== newLines[i]) {
        modified.push(i);
      }
    }
    this.highlightChangedLines(filePath, added, modified);
  }

  // Show temporary green/yellow gutter decorations on changed lines after an auto-apply.
  highlightChangedLines(filePath, addedIndices, modifiedIndices) {
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === filePath || e.document.fileName === filePath
    );
    if (!editor) return;
    const toRange = (i) => new vscode.Range(i, 0, i, 0);
    const addedDeco = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full
    });
    const modDeco = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('diffEditor.modifiedLineBackground'),
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full
    });
    editor.setDecorations(addedDeco, addedIndices.map(toRange));
    editor.setDecorations(modDeco, modifiedIndices.map(toRange));
    setTimeout(() => { addedDeco.dispose(); modDeco.dispose(); }, 5000);
    // Persist changed lines for gutter badge across editor switches.
    for (const i of [...addedIndices, ...modifiedIndices]) this.markEdited(filePath, i, i);
  }

  async toolApplyEdit(inputPath, search, replace) {
    const filePath = this.resolveWorkspacePath(inputPath);
    const existingText = await this.readFileText(filePath) || '';
    const newText = literalReplace(existingText, search, replace);

    if (newText instanceof Error) return 'Error: ' + newText.message;

    if (newText === null) {
      // "Did you mean" recovery: show the model the CLOSEST-matching region of the
      // real file so it can correct in one round-trip instead of flailing — a big
      // help for weaker models that don't reproduce whitespace/text exactly.
      const region = this._closestRegion(existingText, search);
      if (region) {
        return (
          `Error: SEARCH text not found verbatim in ${path.basename(filePath)}.\n` +
          `Closest matching region (~${region.score}% similar, around line ${region.startLine}) — copy your SEARCH block from here EXACTLY, including whitespace:\n` +
          '```\n' + region.text + '\n```\n' +
          'Re-emit apply_edit with the search copied character-for-character from the lines above. If you meant to replace most of the file, use write_file.'
        );
      }
      const preview = existingText.slice(0, 300).replace(/\n/g, '\\n');
      return (
        `Error: The search text was not found verbatim in ${path.basename(filePath)}.\n` +
        `File preview (first 300 chars): ${preview}\n` +
        'Fix: call read_file first to get the exact current content, then re-emit apply_edit with text copied character-for-character. ' +
        'If you need to replace the whole file, use write_file instead.'
      );
    }

    return await this.requestWriteApproval(inputPath, filePath, existingText, newText);
  }

  // Find the file region most similar to a failed SEARCH block, for the
  // "did you mean" recovery hint. Pure. Returns { startLine, score, text } or null.
  _closestRegion(fileText, search) {
    const orig = fileText.split('\n');
    const sTrim = search.split('\n').map(l => l.trim());
    const sLen = sTrim.length;
    if (!sLen || orig.length === 0 || sLen > orig.length) return null;
    const sim = (a, b) => {
      a = a.trim(); b = b.trim();
      if (a === b) return a === '' ? 0.5 : 1;
      if (!a || !b) return 0;
      const ta = new Set(a.split(/\W+/).filter(Boolean));
      const tb = new Set(b.split(/\W+/).filter(Boolean));
      if (!ta.size || !tb.size) return 0;
      let inter = 0;
      for (const t of ta) if (tb.has(t)) inter++;
      return inter / Math.max(ta.size, tb.size);
    };
    let best = { score: -1, idx: 0 };
    for (let i = 0; i <= orig.length - sLen; i++) {
      let sc = 0;
      for (let j = 0; j < sLen; j++) sc += sim(orig[i + j], sTrim[j]);
      sc /= sLen;
      if (sc > best.score) best = { score: sc, idx: i };
    }
    if (best.score <= 0.1) return null; // nothing meaningfully close — preview fallback
    const start = best.idx;
    const text = orig.slice(start, start + sLen).map((l, k) => `${start + k + 1}: ${l}`).join('\n');
    return { startLine: start + 1, score: Math.round(best.score * 100), text };
  }

  // Central write-approval path used by both toolApplyEdit and toolWriteFile.
  // In auto-approve mode: writes immediately.
  // In ask-always mode: opens VS Code's native diff editor then asks the user.
  async requestWriteApproval(inputPath, filePath, oldText, newText) {
    const approvalMode = vscode.workspace.getConfiguration('navy').get('approvalMode', 'ask-always');
    const basename = path.basename(filePath);
    // Generate the id upfront so both paths use the same id in pendingDiff and diffResolved.
    const id = this.generateId();

    this.view?.webview.postMessage({
      type: 'pendingDiff', id, path: inputPath, oldText, newText
    });

    if (approvalMode === 'auto-approve') {
      try {
        this.createCheckpoint(filePath, oldText, newText);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(newText, 'utf8'));
        this.view?.webview.postMessage({ type: 'diffResolved', id, approved: true });
        this.highlightWriteChanges(filePath, oldText, newText);
        return `Applied to ${basename}`;
      } catch (e) {
        return `Error writing ${basename}: ${e.message}`;
      }
    }

    // Show native VS Code diff editor so the user sees the change inline.
    const proposedUri = vscode.Uri.parse(`navy-proposed:${id}/${encodeURIComponent(basename)}`);
    this.context.__navyProposedProvider?.set(id, newText);

    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(filePath),
        proposedUri,
        `⚓ Navy: ${basename}`
      );
    } catch {}

    // Race the in-chat diff card buttons against the native toast — first answer wins.
    // The card is the primary control; the toast is a convenience. Dismissing the toast
    // does NOT reject the edit — the card stays live so the agent isn't silently stalled.
    const decision = await new Promise((resolve) => {
      this.pendingApprovals.set(id, { resolve, filePath, kind: 'agent-edit' });
      this.sendPendingApprovalsUpdate();
      vscode.window.showInformationMessage(
        `Apply Navy's changes to ${basename}?`,
        'Apply',
        'Reject'
      ).then((choice) => {
        if (!this.pendingApprovals.has(id)) return; // already decided via the card
        if (choice === 'Apply' || choice === 'Reject') {
          this.pendingApprovals.delete(id);
          this.sendPendingApprovalsUpdate();
          resolve(choice === 'Apply' ? 'approve' : 'reject');
        }
        // Toast dismissed without a click → card remains the sole resolver.
      });
    });

    this.context.__navyProposedProvider?.delete(id);
    // Close the diff editor and refocus the original file.
    try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}

    if (decision === 'approve') {
      try {
        this.createCheckpoint(filePath, oldText, newText);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(newText, 'utf8'));
        this.view?.webview.postMessage({ type: 'diffResolved', id, approved: true });
        this.highlightWriteChanges(filePath, oldText, newText);
        return `Applied to ${basename}`;
      } catch (e) {
        return `Error writing ${basename}: ${e.message}`;
      }
    }

    this.view?.webview.postMessage({ type: 'diffResolved', id, approved: false });
    return decision === 'reject'
      ? `Rejected — no changes made to ${basename}`
      : `Edit cancelled — no changes made to ${basename}`;
  }

  async resolveApproval(id, approved) {
    const approval = this.pendingApprovals.get(id);
    if (!approval) return;
    this.pendingApprovals.delete(id);

    // Agent-edit approvals: requestWriteApproval owns the write + diffResolved message;
    // we just deliver the user's decision to its awaiting promise.
    if (approval.kind === 'agent-edit') {
      this.sendPendingApprovalsUpdate();
      approval.resolve(approved ? 'approve' : 'reject');
      return;
    }

    // Legacy path for sidebar-card approvals (applyCode flow).

    if (approved) {
      let result;
      try {
        const original = await this.readFileText(approval.filePath) || '';
        this.createCheckpoint(approval.filePath, original, approval.newText);
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(approval.filePath),
          Buffer.from(approval.newText, 'utf8')
        );
        result = 'Applied to ' + path.basename(approval.filePath);
      } catch (error) {
        result = 'Error writing file: ' + error.message;
      }
      approval.resolve(result);
    } else {
      approval.resolve('Edit rejected by user');
    }

    this.sendPendingApprovalsUpdate();
    this.view?.webview.postMessage({ type: 'diffResolved', id, approved });
  }

  async performEdit(filePath, search, replace) {
    try {
      const original = await this.readFileText(filePath) || '';
      const newText = literalReplace(original, search, replace);
      if (newText instanceof Error) return 'Error: ' + newText.message;
      if (newText === null) return 'Error: search text not found in ' + path.basename(filePath);

      this.createCheckpoint(filePath, original, newText);
      await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(newText, 'utf8'));
      return 'Applied edit to ' + path.basename(filePath);
    } catch (error) {
      return 'Error applying edit: ' + error.message;
    }
  }

  // Central checkpoint push: clears redo (a fresh operation invalidates redo
  // history — standard editor semantics), caps entries and bytes, persists.
  _pushCheckpoint(entry) {
    if (this.redoStack.length) {
      this.redoStack = [];
      this.view?.webview.postMessage({ type: 'redoState', count: 0 });
    }
    this.checkpoints.push({ time: Date.now(), turnId: this._checkpointTurnId || this.currentTurnId, ...entry });
    if (this.checkpoints.length > 200) this.checkpoints.splice(0, this.checkpoints.length - 200);
    // Entry cap alone isn't enough — 200 snapshots of multi-MB files would pin
    // hundreds of MB. Cap total retained bytes too, evicting oldest first.
    let bytes = 0;
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      bytes += (this.checkpoints[i].originalText || '').length;
      if (bytes > 30_000_000 && i > 0) { this.checkpoints.splice(0, i); break; }
    }
    this.view?.webview.postMessage({ type: 'checkpoints', count: this.checkpoints.length });
    this._persistCheckpoints();
  }

  createCheckpoint(filePath, originalText, newText) {
    // newHash lets undo detect "the user hand-edited this file AFTER Navy's
    // write" and ask before discarding those edits.
    const newHash = typeof newText === 'string'
      ? crypto.createHash('md5').update(newText, 'utf8').digest('hex')
      : undefined;
    this._pushCheckpoint({ kind: 'edit', filePath, originalText, ...(newHash ? { newHash } : {}) });
  }

  // Persist checkpoints to .navy/checkpoints.json (debounced) so Undo survives a
  // window reload. Only the newest ~8 MB is written — undo history, not a backup.
  _persistCheckpoints() {
    clearTimeout(this._cpSaveTimer);
    this._cpSaveTimer = setTimeout(async () => {
      const dir = await this.ensureNavyDir();
      if (!dir) return;
      try {
        let bytes = 0;
        const keep = [];
        for (let i = this.checkpoints.length - 1; i >= 0; i--) {
          bytes += (this.checkpoints[i].originalText || '').length;
          if (bytes > 8_000_000) break;
          keep.unshift(this.checkpoints[i]);
        }
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(path.join(dir, 'checkpoints.json')),
          Buffer.from(JSON.stringify({ checkpoints: keep }), 'utf8')
        );
      } catch (e) { this.log?.('checkpoint persist failed: ' + e.message); }
    }, 500);
  }

  async _loadCheckpoints() {
    const dir = this.getNavyDir();
    if (!dir) return;
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(dir, 'checkpoints.json')));
      const parsed = JSON.parse(Buffer.from(data).toString('utf8'));
      if (Array.isArray(parsed.checkpoints)) {
        this.checkpoints = parsed.checkpoints.filter(c => c && (
          (c.kind === 'rename' && c.from && c.to) ||
          (c.filePath && typeof c.originalText === 'string')
        ));
        this.view?.webview.postMessage({ type: 'checkpoints', count: this.checkpoints.length });
      }
    } catch { /* no saved checkpoints — fine */ }
  }

  // Undo a single checkpoint entry (kind-aware). Returns the redo operation.
  async _undoOne(cp) {
    if (cp.kind === 'rename') {
      await vscode.workspace.fs.rename(vscode.Uri.file(cp.to), vscode.Uri.file(cp.from), { overwrite: false });
      return { kind: 'rename', from: cp.from, to: cp.to };
    }
    // 'edit' and 'delete' both restore content ('delete' recreates the file).
    const current = await this.readFileText(cp.filePath); // null → file doesn't exist (deleted)
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(cp.filePath)));
    await vscode.workspace.fs.writeFile(vscode.Uri.file(cp.filePath), Buffer.from(cp.originalText, 'utf8'));
    return { kind: 'edit', filePath: cp.filePath, text: current };
  }

  // If the user hand-edited any of these files AFTER Navy's write, undo would
  // silently discard their work — ask first.
  // cps must be newest-first: only the NEWEST checkpoint per file carries the hash
  // of Navy's last write, i.e. what the disk should still equal. Older checkpoints
  // for the same file hash intermediate states and would false-positive.
  async _confirmUndoSafe(cps) {
    const touched = [];
    const seen = new Set();
    for (const cp of cps) {
      if (cp.kind !== 'edit' || !cp.newHash) continue;
      if (seen.has(cp.filePath)) continue;
      seen.add(cp.filePath);
      const current = await this.readFileText(cp.filePath);
      if (current === null) continue;
      const hash = crypto.createHash('md5').update(current, 'utf8').digest('hex');
      if (hash !== cp.newHash) touched.push(path.basename(cp.filePath));
    }
    if (!touched.length) return true;
    const pick = await vscode.window.showWarningMessage(
      `${touched.join(', ')} ${touched.length === 1 ? 'was' : 'were'} modified after Navy's edit — undoing will discard those changes.`,
      { modal: true },
      'Undo Anyway'
    );
    return pick === 'Undo Anyway';
  }

  _afterUndoRedo() {
    if (this.redoStack.length > 50) this.redoStack.splice(0, this.redoStack.length - 50);
    this.view?.webview.postMessage({ type: 'checkpoints', count: this.checkpoints.length });
    this.view?.webview.postMessage({ type: 'redoState', count: this.redoStack.length });
    this._persistCheckpoints();
  }

  async undoLastCheckpoint() {
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (!last) {
      vscode.window.showInformationMessage('No Navy Coder edits to undo');
      return;
    }
    if (!(await this._confirmUndoSafe([last]))) return;
    this.checkpoints.pop();
    // Through the write mutex so an in-flight background-task write to the same
    // file can't interleave with the restore.
    await this._withWriteLock(async () => {
      try {
        const redoOp = await this._undoOne(last);
        this.redoStack.push({ ops: [redoOp] });
        const what = last.kind === 'rename' ? 'rename' : last.kind === 'delete' ? 'deletion' : 'edit';
        vscode.window.showInformationMessage(`Undid last Navy Coder ${what} (Redo is available)`);
      } catch (error) {
        this.checkpoints.push(last); // restore the checkpoint — the undo didn't happen
        vscode.window.showErrorMessage('Undo failed: ' + error.message);
      }
    });
    this._afterUndoRedo();
  }

  async undoLastTurn() {
    if (this.checkpoints.length === 0) {
      vscode.window.showInformationMessage('No Navy Coder edits to undo');
      return;
    }
    const lastTurnId = this.checkpoints[this.checkpoints.length - 1].turnId;
    const toUndo = this.checkpoints.filter(c => c.turnId === lastTurnId).reverse(); // newest → oldest
    if (!(await this._confirmUndoSafe(toUndo))) return;
    this.checkpoints = this.checkpoints.filter(c => c.turnId !== lastTurnId);

    // Restore must apply EVERY checkpoint in reverse order — a file edited N times
    // in the turn has N checkpoints, and only replaying them all (newest→oldest)
    // lands it on the turn-start content. (Deduping to the newest only reverts the
    // last edit.) Redo, by contrast, needs one op per target: the FIRST _undoOne
    // for a file reads the turn-END state off disk, which is the correct redo goal.
    const redoOps = [];
    const redoSeen = new Set();
    const errors = [];
    await this._withWriteLock(async () => {
      for (const cp of toUndo) {
        const key = cp.kind === 'rename' ? 'r:' + cp.from + '→' + cp.to : 'f:' + cp.filePath;
        try {
          const redoOp = await this._undoOne(cp);
          if (!redoSeen.has(key)) { redoSeen.add(key); redoOps.push(redoOp); }
        } catch (e) {
          errors.push(path.basename(cp.filePath || cp.from || '?') + ': ' + e.message);
        }
      }
    });
    if (redoOps.length) this.redoStack.push({ ops: redoOps });
    if (errors.length > 0) {
      vscode.window.showErrorMessage('Some undos failed: ' + errors.join(', '));
    } else {
      vscode.window.showInformationMessage(`Undid ${redoOps.length} file${redoOps.length !== 1 ? 's' : ''} from last turn (Redo is available)`);
    }
    this._afterUndoRedo();
  }

  // Redo: reverse the most recent undo. Re-checkpoints the pre-redo state so
  // undo→redo→undo round-trips cleanly. Pushes checkpoints directly (NOT via
  // _pushCheckpoint) — a redo must not wipe the remaining redo history.
  async redoLast() {
    const entry = this.redoStack.pop();
    if (!entry) {
      vscode.window.showInformationMessage('Nothing to redo.');
      return;
    }
    const turnId = this.generateId();
    const errors = [];
    let done = 0;
    // Through the write mutex — same reason as undo.
    await this._withWriteLock(async () => {
      for (const op of entry.ops) {
        try {
          if (op.kind === 'rename') {
            await vscode.workspace.fs.rename(vscode.Uri.file(op.from), vscode.Uri.file(op.to), { overwrite: false });
            this.checkpoints.push({ kind: 'rename', from: op.from, to: op.to, time: Date.now(), turnId });
          } else if (op.text === null) {
            // The undo recreated a deleted file — redo deletes it again.
            const current = await this.readFileText(op.filePath) ?? '';
            await vscode.workspace.fs.delete(vscode.Uri.file(op.filePath), { recursive: false, useTrash: true });
            this.checkpoints.push({ kind: 'delete', filePath: op.filePath, originalText: current, time: Date.now(), turnId });
          } else {
            const current = await this.readFileText(op.filePath) ?? '';
            const newHash = crypto.createHash('md5').update(op.text, 'utf8').digest('hex');
            this.checkpoints.push({ kind: 'edit', filePath: op.filePath, originalText: current, newHash, time: Date.now(), turnId });
            await vscode.workspace.fs.writeFile(vscode.Uri.file(op.filePath), Buffer.from(op.text, 'utf8'));
          }
          done++;
        } catch (e) {
          errors.push(path.basename(op.filePath || op.to || '?') + ': ' + e.message);
        }
      }
    });
    if (errors.length > 0) {
      vscode.window.showErrorMessage('Redo failed for: ' + errors.join(', '));
    } else {
      vscode.window.showInformationMessage(`Redid ${done} operation${done !== 1 ? 's' : ''}.`);
    }
    this._afterUndoRedo();
  }

  async toolRunCommand(command, timeout = 30000) {
    const config = vscode.workspace.getConfiguration('navy');
    const approvalMode = config.get('approvalMode', 'ask-always');

    if (approvalMode !== 'auto-approve') {
      const id = this.generateId();
      this.view?.webview.postMessage({ type: 'pendingCommand', id, command });
      const approved = await new Promise((resolve) => {
        this.pendingCommandApprovals.set(id, { resolve });
      });
      if (!approved) return 'Command rejected by user';
    }

    const root = this.projectRoot
      || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      || (vscode.window.activeTextEditor ? path.dirname(vscode.window.activeTextEditor.document.fileName) : process.cwd());
    const isWin = process.platform === 'win32';
    const shellBin = isWin ? 'cmd' : 'sh';
    const shellArgs = isWin ? ['/c', command] : ['-c', command];

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const MAX_BUF = 200000; // cap accumulation — a chatty command must not eat memory
      const child = spawn(shellBin, shellArgs, { cwd: root, detached: !isWin });
      const timer = setTimeout(() => {
        this._killProcessTree(child);
        resolve('Command timed out after ' + timeout + 'ms\nstdout: ' + stdout.slice(-8000) + '\nstderr: ' + stderr.slice(-8000));
      }, timeout);

      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        if (stdout.length > MAX_BUF) stdout = stdout.slice(-MAX_BUF);
        this.view?.webview.postMessage({ type: 'shellChunk', chunk });
      });
      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        if (stderr.length > MAX_BUF) stderr = stderr.slice(-MAX_BUF);
        this.view?.webview.postMessage({ type: 'shellChunk', chunk, isStderr: true });
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
        resolve(out);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve('Command error: ' + error.message);
      });
    });
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
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'Error: No project folder open. Ask the user to open a folder first.';

    const cmd = command || this.detectRunCommand();
    if (!cmd) return 'Error: Could not auto-detect how to run this project. Provide an explicit command (e.g. "npm start", "python app.py").';

    const config2 = vscode.workspace.getConfiguration('navy');
    if (config2.get('approvalMode', 'ask-always') !== 'auto-approve') {
      const choice = await vscode.window.showInformationMessage(
        `Navy wants to run: ${cmd}`, { modal: false }, 'Allow', 'Deny'
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

    const projectName = path.basename(root);
    this.view?.webview.postMessage({ type: 'runProjectStart', projectName, command: cmd });

    const isWin = process.platform === 'win32';
    const entry = { proc: null, stdout: '', stderr: '', exitCode: null, command: cmd, url: null };
    // detached: true on Unix creates a new process group so _killProcessTree can kill it cleanly.
    const proc = spawn(isWin ? 'cmd' : 'sh', isWin ? ['/c', cmd] : ['-c', cmd], { cwd: root, detached: !isWin });
    entry.proc = proc;
    this.bgProcesses.set('__run_project__', entry);

    const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)\S*/;
    let urlFound = false;

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
    proc.on('error', (e) => {
      this.view?.webview.postMessage({ type: 'runProjectStopped', exitCode: -1 });
      this.bgProcesses.delete('__run_project__');
    });

    return `Starting "${projectName}" with: ${cmd}\nWatching for server URL...`;
  }

  async toolStartProcess(id, command) {
    if (!id || !command) return 'Error: id and command are required.';
    const prior = this.bgProcesses.get(id);
    if (prior?.proc) return `Error: a process named "${id}" is already running.`;
    if (prior) this.bgProcesses.delete(id); // previous run exited — allow id reuse

    const config = vscode.workspace.getConfiguration('navy');
    if (config.get('approvalMode', 'ask-always') !== 'auto-approve') {
      const choice = await vscode.window.showInformationMessage(
        `Navy wants to start a background process:\n${command}`,
        { modal: false }, 'Allow', 'Deny'
      );
      if (choice !== 'Allow') return 'Process rejected by user.';
    }

    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const isWin = process.platform === 'win32';
    const entry = { proc: null, stdout: '', stderr: '', exitCode: null, startedAt: Date.now() };

    const proc = spawn(isWin ? 'cmd' : 'sh', isWin ? ['/c', command] : ['-c', command], { cwd: root, detached: !isWin });
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
    const combined = (entry.stdout + (entry.stderr ? '\n[stderr]\n' + entry.stderr : '')).trim();
    if (clear && entry.exitCode === null) { entry.stdout = ''; entry.stderr = ''; }
    return `[${id}] ${status}\n${combined || '(no output yet)'}`;
  }

  // Kill a spawned process AND its entire child tree (npm → node, etc.).
  // On Windows uses taskkill /F /T; on Unix kills the process group (requires detached: true on spawn).
  _killProcessTree(proc) {
    if (!proc?.pid) return;
    try {
      if (process.platform === 'win32') {
        try { execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore', timeout: 5000 }); } catch {}
      } else {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill(); }
      }
    } catch {}
  }

  async toolKillProcess(id) {
    const entry = this.bgProcesses.get(id);
    if (!entry) return `No process "${id}" found.`;
    if (!entry.proc) return `Process "${id}" has already exited (code ${entry.exitCode}).`;
    this._killProcessTree(entry.proc);
    this.bgProcesses.delete(id);
    this.view?.webview.postMessage({ type: 'bgProcessDone', id, exitCode: -1 });
    return `Process "${id}" killed.`;
  }

  dispose() {
    this.mcp?.stop();
    clearInterval(this._heartbeat);
    clearTimeout(this._cpSaveTimer);
    // Kill all background processes when the extension is deactivated or reloaded.
    for (const [, entry] of this.bgProcesses) {
      if (entry?.proc) { try { this._killProcessTree(entry.proc); } catch {} }
    }
    this.bgProcesses.clear();
  }

  async runBackgroundTask(taskId, prompt) {
    const ctrl = new AbortController();
    this.bgWorkers.set(taskId, { ctrl });
    // Distinct turnId so this task's file edits form their own Undo Last Turn group,
    // never merging into whatever main-chat turn happens to be active.
    const bgTurnId = 'bg-' + this.generateId();

    const post = (status, extra = {}) =>
      this.view?.webview.postMessage({ type: 'bgTaskUpdate', taskId, status, ...extra });

    try {
      const config = vscode.workspace.getConfiguration('navy');
      const host = config.get('host', 'http://localhost:11434').replace(/\/$/, '');
      const model = this.currentModel || config.get('model', '');
      const temperature = config.get('temperature', 0.2);
      const maxIter = config.get('maxToolIterations', 50);

      const bgMessages = [
        { role: 'system', content: TOOL_PROMPT },
        { role: 'user', content: prompt }
      ];

      let usedTools = false;

      for (let iter = 0; iter < maxIter; iter++) {
        const { text, nativeToolCalls } = await streamAssistant(this,
          host, model, bgMessages, temperature,
          ctrl.signal,
          (chunk) => post('chunk', { text: chunk })
        );

        // Same normalization as the main loop — strict providers (DeepSeek's
        // `type` field, Cohere's empty ids) reject unnormalized replays here too.
        this._normalizeToolCallIds(nativeToolCalls);
        bgMessages.push({
          role: 'assistant',
          content: text || '',
          ...(nativeToolCalls.length ? { tool_calls: nativeToolCalls } : {})
        });

        const toolCalls = nativeToolCalls.length > 0
          ? nativeToolCalls.map(tc => {
              let args = {};
              try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {}); } catch {}
              return { name: tc.function.name, args, id: tc.id || '' };
            })
          : parseToolCalls(text);

        if (toolCalls.length === 0 || toolCalls.every(t => t.name === 'finish')) break;

        usedTools = true;
        const toolResults = [];
        for (const tool of toolCalls) {
          if (ctrl.signal.aborted) break;
          if (tool.name === 'finish') continue;
          post('tool', { tool: tool.name, args: tool.args });
          const result = await this.executeTool(tool, bgTurnId);
          post('toolResult', { tool: tool.name, result: String(result).slice(0, 800) });
          if (nativeToolCalls.length > 0) {
            toolResults.push({ role: 'tool', tool_call_id: tool.id || '', content: String(result) });
          } else {
            toolResults.push({ role: 'user', content: '<tool_result name="' + tool.name + '">\n' + result + '\n</tool_result>' });
          }
        }
        for (const tr of toolResults) bgMessages.push(tr);
      }

      post('done');
    } catch (e) {
      if (e.name === 'AbortError') post('aborted');
      else {
        const p = vscode.workspace.getConfiguration('navy').get('provider', 'ollama');
        post('error', { message: formatProviderError(providerDisplayName(p), e.message) });
      }
    } finally {
      this.bgWorkers.delete(taskId);
    }
  }

  async toolGitBlame(filePath, startLine, endLine) {
    const absPath = this.resolveWorkspacePath(filePath);
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(absPath);
    const args = ['blame', '--date=short', '-w'];
    if (startLine) {
      args.push('-L', endLine ? `${startLine},${endLine}` : `${startLine},${startLine}`);
    }
    args.push(absPath);
    return new Promise((resolve) => {
      const proc = spawn('git', args, { cwd: root });
      let out = '';
      let err = '';
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { err += d; });
      // Cap like git_diff — blaming a whole large file would flood the model context.
      proc.on('close', () => resolve((out.trim() || ('git blame failed: ' + err.trim())).slice(0, 8000)));
      proc.on('error', e => resolve('git error: ' + e.message));
    });
  }

  async toolFindSymbol(name) {
    try {
      const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', name);
      if (!symbols || symbols.length === 0) {
        return `No symbol named "${name}" found by the language server. Try search_codebase as a fallback.`;
      }
      const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const results = [];
      for (const sym of symbols.slice(0, 10)) {
        const filePath = sym.location.uri.fsPath;
        const line = sym.location.range.start.line;
        const kind = Object.keys(vscode.SymbolKind).find(k => vscode.SymbolKind[k] === sym.kind) || 'Symbol';
        const relPath = root ? path.relative(root, filePath) : filePath;
        let snippet = '';
        try {
          const content = await fs.promises.readFile(filePath, 'utf8');
          const lines = content.split('\n');
          const start = Math.max(0, line - 1);
          const end = Math.min(lines.length, line + 3);
          snippet = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
        } catch {}
        results.push(
          `**[${kind}]** \`${sym.name}\`${sym.containerName ? ` — in \`${sym.containerName}\`` : ''}\n` +
          `${relPath}:${line + 1}\n\`\`\`\n${snippet}\n\`\`\``
        );
      }
      return `Found ${symbols.length} result${symbols.length !== 1 ? 's' : ''} for \`${name}\`:\n\n` + results.join('\n\n---\n\n');
    } catch (e) {
      return 'find_symbol failed: ' + e.message + '. Try search_codebase as a fallback.';
    }
  }

  async toolFindReferences(name) {
    try {
      // Step 1: locate a definition position to anchor the reference query.
      const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', name);
      if (!symbols || symbols.length === 0) {
        return `No symbol named "${name}" found by the language server. Try search_codebase to locate usages by text.`;
      }
      const sym = symbols.find(s => s.name === name) || symbols[0];
      const uri = sym.location.uri;
      const pos = new vscode.Position(
        sym.location.range.start.line,
        sym.location.range.start.character + 1
      );

      // Ensure the document is loaded so the language server can index it.
      await vscode.workspace.openTextDocument(uri);

      // Step 2: ask the language server for all references.
      const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, pos);
      if (!refs || refs.length === 0) {
        return `Language server returned no references for \`${name}\`. Try opening the file in the editor first, then retry.`;
      }

      const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const lines = [];
      for (const ref of refs.slice(0, 30)) {
        const filePath = ref.uri.fsPath;
        const line = ref.range.start.line;
        const relPath = root ? path.relative(root, filePath) : filePath;
        let snippet = '';
        try {
          const content = await fs.promises.readFile(filePath, 'utf8');
          snippet = (content.split('\n')[line] || '').trim();
        } catch {}
        lines.push(`${relPath}:${line + 1}  ${snippet}`);
      }
      return (
        `**${refs.length} reference${refs.length !== 1 ? 's' : ''} to \`${name}\`**` +
        `${refs.length > 30 ? ' (showing first 30)' : ''}:\n\n` +
        lines.join('\n')
      );
    } catch (e) {
      return 'find_references failed: ' + e.message + '. Try search_codebase as a fallback.';
    }
  }

  async toolWebSearch(query, maxResults = 5) {
    const config = vscode.workspace.getConfiguration('navy');
    const searchKey = config.get('searchApiKey', '')
                    || await this.context.secrets.get('navy.searchApiKey') || '';
    if (searchKey.startsWith('tvly-')) return await this._searchTavily(query, maxResults, searchKey);
    if (searchKey) return await this._searchBrave(query, maxResults, searchKey);
    return await this._searchDuckDuckGo(query, maxResults);
  }

  async _searchTavily(query, maxResults, apiKey) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query, max_results: Math.min(maxResults, 10) }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const results = (data.results || []).slice(0, maxResults);
      if (!results.length) return 'No results found for: ' + query;
      return results.map((r, i) =>
        `[${i + 1}] **${r.title}**\n${r.url}\n${(r.content || '').slice(0, 400)}`
      ).join('\n\n---\n\n');
    } catch (e) {
      return 'Tavily search failed (' + e.message + ') — falling back to DuckDuckGo.\n\n'
           + await this._searchDuckDuckGo(query, maxResults);
    }
  }

  async _searchBrave(query, maxResults, apiKey) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(
        'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=' + Math.min(maxResults, 20),
        { headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey }, signal: ctrl.signal }
      );
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const results = (data.web?.results || []).slice(0, maxResults);
      if (!results.length) return 'No results found for: ' + query;
      return results.map((r, i) =>
        `[${i + 1}] **${r.title}**\n${r.url}\n${r.description || ''}`
      ).join('\n\n---\n\n');
    } catch (e) {
      return 'Brave search failed (' + e.message + ') — falling back to DuckDuckGo.\n\n'
           + await this._searchDuckDuckGo(query, maxResults);
    }
  }

  async _searchDuckDuckGo(query, maxResults) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      // DDG Lite has simpler, more stable HTML than the full search page.
      const res = await fetch('https://lite.duckduckgo.com/lite/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (compatible; NavyCoder/1.0)',
        },
        body: 'q=' + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const html = await res.text();
      const links = [];
      const snips = [];
      let m;
      // Tolerate attribute order and quote-style changes: match whole anchors that
      // carry the result-link class, then pull href out separately.
      const anchorRe = /<a\b[^>]*class=["']?[^"'>]*result-link[^"'>]*["']?[^>]*>([\s\S]*?)<\/a>/gi;
      while ((m = anchorRe.exec(html)) !== null) {
        const href = m[0].match(/href=["']([^"']+)["']/i);
        if (href) links.push({ url: href[1], title: m[1].replace(/<[^>]*>/g, '').trim() });
      }
      const snipRe = /<td\b[^>]*class=["']?[^"'>]*result-snippet[^"'>]*["']?[^>]*>([\s\S]*?)<\/td>/gi;
      while ((m = snipRe.exec(html)) !== null) snips.push(m[1].replace(/<[^>]*>/g, '').trim());
      const results = [];
      for (let i = 0; i < Math.min(links.length, maxResults); i++) {
        if (links[i].url.startsWith('http') && links[i].title)
          results.push({ ...links[i], snippet: snips[i] || '' });
      }
      if (!results.length) return 'No results found for: ' + query;
      return results.map((r, i) => `[${i + 1}] **${r.title}**\n${r.url}\n${r.snippet}`).join('\n\n---\n\n');
    } catch (e) {
      return 'Search failed: ' + e.message;
    }
  }

  async generatePRReview() {
    // Open the sidebar FIRST — the command-approval card (ask-always mode) renders in
    // the webview, and if the view was never resolved the await below would hang forever.
    await this.focus();
    const input = await vscode.window.showInputBox({
      prompt: 'PR number or leave blank to diff current branch vs main',
      placeHolder: 'e.g. 42',
      ignoreFocusOut: true,
    });
    if (input === undefined) return; // cancelled

    let diff;
    if (input && /^\d+$/.test(input.trim())) {
      diff = await this.toolRunCommand(`gh pr diff ${input.trim()}`, 30000);
    } else {
      const base = input?.trim() || 'main';
      diff = await this.toolGitDiff('', false) + '\n\n(base: ' + base + ')';
    }

    if (!diff || diff.startsWith('Command error') || diff.includes('command not found')) {
      vscode.window.showErrorMessage('PR Review: failed to get diff. Install GitHub CLI (gh) for PR number support.');
      return;
    }

    const prompt = `You are reviewing a pull request. For every real problem you find:\n1. Quote the relevant code snippet.\n2. Explain the bug or concern.\n3. Show the corrected version.\n\nAlso summarise overall quality at the end.\n\n\`\`\`diff\n${diff.slice(0, 80000)}\n\`\`\``;
    await this.focus();
    this.askNavy(prompt, false, null, []);
  }

  async exportConversation(conversationText) {
    const defaultName = `navy-chat-${new Date().toISOString().slice(0, 10)}.md`;
    const defaultDir = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(defaultDir, defaultName)),
      filters: { 'Markdown': ['md'], 'Text': ['txt'] },
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(conversationText, 'utf8'));
    vscode.window.showInformationMessage('Conversation exported to ' + path.basename(uri.fsPath));
  }

  markEdited(filePath, startLine, endLine) {
    if (!filePath) return;
    const existing = this.editedRanges.get(filePath) || [];
    existing.push({ start: startLine, end: endLine ?? startLine });
    // Cap per-file entries so long sessions don't accumulate unboundedly.
    if (existing.length > 500) existing.splice(0, existing.length - 500);
    this.editedRanges.set(filePath, existing);
    // Apply to any open editor showing this file.
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.fileName === filePath) this.applyGutterDecorations(editor);
    }
  }

  applyGutterDecorations(editor) {
    const ranges = this.editedRanges.get(editor.document.fileName) || [];
    const decorations = ranges.map(r =>
      new vscode.Range(r.start, 0, r.end, 0)
    );
    editor.setDecorations(this.gutterDecorationType, decorations);
  }

  // ── Lexical retrieval ────────────────────────────────────────────────────
  // Navy has no embeddings; this gives the agent a purpose-built ranked file
  // finder so it stops blindly guessing which files to read on a large repo.

  // Extract salient search terms from a prompt: identifiers/words ≥3 chars, minus
  // common English + coding filler. Also splits camelCase / snake_case so
  // "parseUserToken" contributes parse/user/token as well as the whole word. Pure.
  _tokenizeQuery(q) {
    const STOP = new Set(['the','and','for','with','this','that','from','into','have','has','are','was','were','file','files','code','line','lines','function','please','make','fix','fixes','fixed','add','added','update','updated','change','changes','create','created','remove','removed','delete','implement','refactor','review','explain','check','using','use','used','need','needs','want','should','would','could','how','what','why','where','when','which','all','any','get','set','new','old','error','errors','bug','bugs','issue','issues','test','tests','navy','let','you','your','can','not','then','than','also','here','there','they','them','its','our']);
    const words = (q || '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    const terms = new Map(); // term → weight (whole identifiers weigh more than split parts)
    const add = (t, w) => { const k = t.toLowerCase(); if (k.length >= 3 && !STOP.has(k)) terms.set(k, Math.max(terms.get(k) || 0, w)); };
    for (const w of words) {
      add(w, 2);
      // split identifier into parts
      for (const part of w.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[_\s]+/)) add(part, 1);
    }
    return [...terms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, w]) => ({ term: t, weight: w }));
  }

  // Pure ranker: hits = [{ rel, count, matched:[terms], inName:bool, defs:bool }].
  _rankRelevance(hits, terms) {
    const distinct = terms.length || 1;
    return hits
      .map(h => {
        // Sublinear frequency (TF saturation, à la BM25): the 40th mention of a term
        // barely helps, so a file that merely name-drops a term can't outrank the one
        // that DEFINES it or is named after it.
        let score = Math.min(Math.log2(1 + h.count) * 4, 20);
        score += (h.matched.length / distinct) * 25;  // coverage of distinct query terms matters most
        if (h.inName) score += 12;                    // a query term in the filename is a strong signal
        if (h.defs)   score += 10;                    // the file DEFINES a query term
        return { ...h, score: Math.round(score) };
      })
      .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  }

  // Walk the repo, read each source file once, score against terms. Bounded so a
  // huge tree can't hang: skip dirs, size cap, file-count cap. Results are cached
  // per (root, maxFiles, terms) for 30s so repeated identical prompts (e.g. the
  // same request re-sent) don't re-read the whole tree each time.
  async _collectRelevance(root, terms, { maxFiles = 1500, maxBytes = 300 * 1024 } = {}) {
    const cacheKey = root + '|' + maxFiles + '|' + terms.map(t => t.term).sort().join(',');
    if (this._relCache && this._relCache.key === cacheKey && Date.now() - this._relCache.time < 30_000) {
      return this._relCache.hits;
    }
    const SKIP = new Set(['node_modules','.git','dist','build','out','.next','.nuxt','__pycache__','.venv','venv','coverage','.cache','.navy','vendor','target']);
    const CODE = new Set(['.js','.jsx','.ts','.tsx','.mjs','.cjs','.py','.go','.rs','.java','.rb','.php','.c','.h','.cpp','.hpp','.cc','.cs','.swift','.kt','.scala','.vue','.svelte','.sql','.sh','.md','.json','.yml','.yaml','.toml']);
    const DEF_KW = 'function|class|def|const|let|var|interface|type|struct|enum|fn|func|trait|impl|module|component';
    // Compile the term + definition regexes ONCE (not per file) — a repo scan is
    // up to maxFiles × terms iterations, so per-file compilation is pure waste.
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = terms.map(t => ({
      term: t.term,
      re: new RegExp('\\b' + esc(t.term) + '\\b', 'gi'),
      defRe: new RegExp('\\b(?:' + DEF_KW + ')\\b[^\\n]*\\b' + esc(t.term) + '\\b', 'i'),
    }));
    const hits = [];
    let scanned = 0;
    const walk = async (dir) => {
      if (scanned >= maxFiles) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (scanned >= maxFiles) return;
        if (e.isDirectory()) {
          if (!SKIP.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name));
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (!CODE.has(ext)) continue;
        const full = path.join(dir, e.name);
        let text;
        try {
          const st = await fs.promises.stat(full);
          if (st.size > maxBytes) continue;
          text = await fs.promises.readFile(full, 'utf8');
        } catch { continue; }
        scanned++;
        const rel = path.relative(root, full).replace(/\\/g, '/');
        // Word-boundary name match (a query term as its own path segment / camel part),
        // so "app" no longer credits "mapper.js".
        const nameTokens = new Set(rel.toLowerCase().replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^a-z0-9]+/i).filter(Boolean));
        let count = 0, inName = false, defs = false;
        const matched = [];
        for (const p of patterns) {
          const m = text.match(p.re);
          const n = m ? m.length : 0;
          if (n > 0) { count += n; matched.push(p.term); }
          if (nameTokens.has(p.term)) inName = true;
          if (!defs && p.defRe.test(text)) defs = true;
        }
        if (count > 0 || inName) hits.push({ rel, count, matched, inName, defs });
      }
    };
    await walk(root);
    this._relCache = { key: cacheKey, time: Date.now(), hits };
    return hits;
  }

  async toolFindRelevantFiles(query, maxResults = 8) {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'No workspace open.';
    const terms = this._tokenizeQuery(query);
    if (!terms.length) return 'Give a more specific query — identifiers, symbol names, or distinctive keywords.';
    const hits = await this._collectRelevance(root, terms);
    const ranked = this._rankRelevance(hits, terms).slice(0, Math.max(1, Math.min(maxResults || 8, 25)));
    if (!ranked.length) return `No files matched: ${terms.map(t => t.term).join(', ')}`;
    const header = `Ranked by relevance to: ${terms.map(t => t.term).join(', ')}\n`;
    return header + ranked.map(h =>
      `${h.rel}  [score ${h.score}${h.defs ? ', defines' : ''}${h.inName ? ', name-match' : ''}; matched: ${h.matched.join(', ') || '—'}]`
    ).join('\n');
  }

  async buildRepoMap() {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'PROJECT ROOT UNKNOWN — do NOT invent file names or project names. Tell the user to open a folder in VS Code first.';

    // The map is rebuilt on every message but the tree rarely changes that fast —
    // cache per root for 30 s to keep prompt latency off the filesystem.
    if (this._repoMapCache?.root === root && Date.now() - this._repoMapCache.time < 30_000) {
      return this._repoMapCache.map;
    }

    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'coverage', '.cache']);
    const lines = [];

    const walk = async (dir, prefix, depth) => {
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch { return; }
      const dirs = entries.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'));
      const files = entries.filter(e => e.isFile());
      for (const f of files.slice(0, 40)) lines.push(prefix + f.name);
      if (files.length > 40) lines.push(prefix + `… (${files.length - 40} more files)`);
      if (depth < 2) {
        for (const d of dirs.slice(0, 15)) {
          lines.push(prefix + d.name + '/');
          await walk(path.join(dir, d.name), prefix + '  ', depth + 1);
        }
      } else {
        for (const d of dirs.slice(0, 10)) lines.push(prefix + d.name + '/');
      }
    };

    try {
      await walk(root, '', 0);

      // Try common project manifest files to get real project name.
      let projectMeta = '';
      for (const [file, parse] of [
        ['package.json', t => { const p = JSON.parse(t); return p.name + (p.description ? ' — ' + p.description : ''); }],
        ['Cargo.toml',   t => { const m = t.match(/name\s*=\s*"([^"]+)"/); return m ? m[1] : ''; }],
        ['pyproject.toml', t => { const m = t.match(/name\s*=\s*"([^"]+)"/); return m ? m[1] : ''; }],
        ['go.mod',       t => { const m = t.match(/^module\s+(\S+)/m); return m ? m[1] : ''; }],
      ]) {
        try {
          const txt = await fs.promises.readFile(path.join(root, file), 'utf8');
          projectMeta = parse(txt);
          if (projectMeta) break;
        } catch { /* not this type */ }
      }
      if (projectMeta) lines.unshift('Project: ' + projectMeta);

      const map = lines.join('\n') || 'Empty project directory';
      this._repoMapCache = { root, time: Date.now(), map };
      return map;
    } catch (error) {
      return 'Could not build repo map: ' + error.message;
    }
  }

  // Raw, untruncated read. Edit paths (apply_edit, edit_line, checkpoints, …) depend on
  // getting the FULL file — truncating here would corrupt any file larger than the cap
  // when the edited result is written back. Truncation for chat context happens only
  // at the context-building site via truncateForContext().
  async readFileText(filePath) {
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      return Buffer.from(data).toString('utf8');
    } catch (error) {
      return null;
    }
  }

  truncateForContext(text) {
    if (text === null || text === undefined) return text;
    const max = vscode.workspace.getConfiguration('navy').get('maxContextChars', 12000);
    return text.length > max ? text.slice(0, max) + '\n\n[Truncated to ' + max + ' characters — use read_lines for the rest]' : text;
  }

  generateId() {
    return crypto.randomBytes(6).toString('hex');
  }

  sendPendingApprovalsUpdate() {
    const approvals = [];
    for (const [id, approval] of this.pendingApprovals) {
      approvals.push({ id, path: approval.filePath });
    }
    this.view?.webview.postMessage({ type: 'pendingApprovals', approvals });
  }

  async insertCode(text) {
    const code = text || '';
    if (!code.trim()) { vscode.window.showInformationMessage('No code to insert.'); return; }
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('Open a file before inserting code.'); return; }
    await editor.edit((editBuilder) => {
      for (const selection of editor.selections) editBuilder.replace(selection, code);
    });
  }

  async applyCode(text, providedPath) {
    const code = text || '';
    if (!code.trim()) { vscode.window.showInformationMessage('No code to apply.'); return; }

    let targetPath = providedPath ? this.resolveWorkspacePath(providedPath) : '';
    if (!targetPath) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) targetPath = activeEditor.document.fileName;
    }
    if (!targetPath) {
      const picked = await vscode.window.showSaveDialog({ saveLabel: 'Apply Navy code' });
      if (!picked) return;
      targetPath = picked.fsPath;
    }

    const config = vscode.workspace.getConfiguration('navy');
    const approvalMode = config.get('approvalMode', 'ask-always');

    if (approvalMode === 'auto-approve') {
      await this.writeWholeFile(targetPath, code);
      return;
    }

    const existingText = await this.readFileText(targetPath) || '';
    const id = this.generateId();
    this.view?.webview.postMessage({ type: 'pendingDiff', id, path: providedPath || targetPath, oldText: existingText, newText: code });
    return new Promise((resolve) => {
      this.pendingApprovals.set(id, { resolve, filePath: targetPath, search: '', replace: '', newText: code });
      this.sendPendingApprovalsUpdate();
    });
  }

  async writeWholeFile(filePath, text) {
    try {
      const original = await this.readFileText(filePath) || '';
      this.createCheckpoint(filePath, original, text);
      await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(text, 'utf8'));
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage('Applied code to ' + path.basename(filePath));
      this.view?.webview.postMessage({ type: 'applied', path: filePath });
    } catch (error) {
      vscode.window.showErrorMessage('Could not apply code: ' + error.message);
    }
  }

  async insertLastReply() {
    if (!this.lastReply.trim()) { vscode.window.showInformationMessage('No Navy reply to insert yet.'); return; }
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('Open a file before inserting the reply.'); return; }
    await editor.edit((editBuilder) => {
      for (const selection of editor.selections) editBuilder.replace(selection, this.lastReply);
    });
  }

  restoreMessages() {
    this.view?.webview.postMessage({ type: 'restore', messages: this.messages });
  }

  // One-shot, non-streaming completion through the ACTIVE provider (not just Ollama).
  // Chunks are swallowed via a no-op onChunk so nothing leaks into the chat webview.
  async _completeOnce(host, model, messages) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const { text } = await streamAssistant(this, host, model, messages, 0.2, ctrl.signal, () => {});
      // Reasoning models may wrap deliberation in <think> tags — strip them.
      return (text || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
    } finally {
      clearTimeout(timer);
    }
  }

  async generateCommit() {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { vscode.window.showErrorMessage('Navy: No project root detected.'); return; }

    const diff = await this.runGit(['diff', '--staged']);
    if (!diff || diff.trim() === '') {
      const choice = await vscode.window.showWarningMessage(
        'Nothing staged. Stage changes first, or generate a message for all unstaged changes?',
        'Use unstaged diff', 'Cancel'
      );
      if (choice !== 'Use unstaged diff') return;
    }

    const diffToUse = diff.trim() ? diff : await this.runGit(['diff']);
    if (!diffToUse.trim()) { vscode.window.showInformationMessage('No changes to commit.'); return; }

    const config = vscode.workspace.getConfiguration('navy');
    const host = config.get('host', 'http://localhost:11434').replace(/\/$/, '');
    const model = config.get('model', '');

    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Navy: Generating commit message…', cancellable: false }, async () => {
      try {
        const message = await this._completeOnce(host, model, [
          { role: 'system', content: 'You write concise, conventional-commits-style git commit messages. Output ONLY the commit message — no explanation, no quotes, no markdown.' },
          { role: 'user', content: `Write a git commit message for this diff:\n\n${diffToUse.slice(0, 6000)}` }
        ]);
        if (!message) { vscode.window.showErrorMessage('Navy: Failed to generate commit message.'); return; }

        const confirmed = await vscode.window.showInputBox({
          prompt: 'Commit message (edit or press Enter to accept)',
          value: message,
          ignoreFocusOut: true
        });
        if (!confirmed) return;

        const commitResult = await this.runGit(['commit', '-m', confirmed]);
        vscode.window.showInformationMessage('Navy: ' + commitResult.trim().split('\n')[0]);
      } catch (e) {
        vscode.window.showErrorMessage('Navy: ' + e.message);
      }
    });
  }

  async generatePRDescription() {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { vscode.window.showErrorMessage('Navy: No project root detected.'); return; }

    const [log, diff] = await Promise.all([
      this.runGit(['log', 'main..HEAD', '--oneline']).catch(() => this.runGit(['log', 'master..HEAD', '--oneline'])),
      this.runGit(['diff', 'main...HEAD']).catch(() => this.runGit(['diff', 'master...HEAD']))
    ]);

    if (!log.trim() && !diff.trim()) {
      vscode.window.showInformationMessage('Navy: No commits ahead of main.'); return;
    }

    const config = vscode.workspace.getConfiguration('navy');
    const host = config.get('host', 'http://localhost:11434').replace(/\/$/, '');
    const model = config.get('model', '');

    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Navy: Generating PR description…', cancellable: false }, async () => {
      try {
        const prText = await this._completeOnce(host, model, [
          { role: 'system', content: 'You write clear GitHub pull request descriptions in markdown. Include: a short title line, a ## Summary section with bullet points, and a ## Changes section. Be concise and factual.' },
          { role: 'user', content: `Generate a PR description for these changes:\n\nCommits:\n${log}\n\nDiff (truncated):\n${diff.slice(0, 5000)}` }
        ]);
        if (!prText) { vscode.window.showErrorMessage('Navy: Failed to generate PR description.'); return; }

        const doc = await vscode.workspace.openTextDocument({ content: prText, language: 'markdown' });
        await vscode.window.showTextDocument(doc);
      } catch (e) {
        vscode.window.showErrorMessage('Navy: ' + e.message);
      }
    });
  }

  async explainTerminalError() {
    await this.focus();
    const clipboardText = await vscode.env.clipboard.readText();
    if (!clipboardText || clipboardText.trim() === '') {
      vscode.window.showInformationMessage('Please copy the terminal error to your clipboard first.');
      return;
    }
    this.askNavy(`I encountered this error. Please explain it and how to fix it:\n\n\`\`\`\n${clipboardText.slice(0, 5000)}\n\`\`\``, true);
  }

  async runTestsCommand() {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { vscode.window.showErrorMessage('Navy: No project root detected.'); return; }

    const filter = await vscode.window.showInputBox({
      prompt: 'Test filter (leave empty to run all tests)',
      placeHolder: 'e.g. auth, login, UserService',
      ignoreFocusOut: true
    });
    if (filter === undefined) return;

    await this.focus();
    await this.askNavy(`Run the test suite${filter ? ` filtering for "${filter}"` : ''} and report any failures with explanations and fixes.`, false, null, []);
  }

  getHtml(webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'styles.css'));
    const version = this.context.extension?.packageJSON?.version || '';
    return getWebviewHtml({ scriptUri, styleUri, cspSource: webview.cspSource, nonce: getNonce(), version });
  }
}

function getEditorContext(maxChars) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return 'No active editor.';
  const document = editor.document;
  const selections = editor.selections.filter((s) => !s.isEmpty).map((s) => document.getText(s));
  if (selections.length > 0) {
    const selected = selections.join('\n\n---\n\n');
    return [
      'File: ' + document.fileName,
      'Language: ' + document.languageId,
      'Selected text:',
      selected.length > maxChars ? selected.slice(0, maxChars) + '\n\n[Truncated to ' + maxChars + ' characters]' : selected
    ].join('\n');
  }
  const fullText = document.getText();
  const truncated = fullText.length > maxChars ? fullText.slice(0, maxChars) + '\n\n[Truncated to first ' + maxChars + ' characters]' : fullText;
  return ['File: ' + document.fileName, 'Language: ' + document.languageId, 'File text:', truncated].join('\n');
}

function getNonce() {
  return crypto.randomBytes(24).toString('base64url');
}

// In-memory content provider that serves proposed file content for the VS Code diff editor.
class NavyProposedContentProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChange = this._emitter.event;
    this._contents = new Map();
  }
  set(id, content) {
    this._contents.set(id, content);
    this._emitter.fire(vscode.Uri.parse(`navy-proposed:${id}`));
  }
  delete(id) { this._contents.delete(id); }
  provideTextDocumentContent(uri) {
    // URI path is "id/encoded-filename" — split on first slash.
    const id = uri.path.split('/')[0];
    return this._contents.get(id) || '';
  }
}

class NavyFixCodeActionProvider {
  constructor(provider) { this._provider = provider; }
  provideCodeActions(document, _range, context) {
    if (!context.diagnostics.length) return [];
    return context.diagnostics.map(diag => {
      const sev = diag.severity === 0 ? 'error' : 'warning';
      const action = new vscode.CodeAction(`⚓ Navy: fix this ${sev}`, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diag];
      action.isPreferred = false;
      action.command = {
        command: 'navy.fixDiagnostic',
        title: `Navy: fix ${sev}`,
        arguments: [document.uri, diag],
      };
      return action;
    });
  }
}

class NavyCodeLensProvider {
  constructor(provider) {
    this._provider = provider;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this._onDidChange.event;
  }

  provideCodeLenses(document) {
    const config = vscode.workspace.getConfiguration('navy');
    if (!config.get('codeLens', true)) return [];

    const lenses = [];
    const text = document.getText();
    const lines = text.split('\n');
    const fnPattern = /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w+|^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(|^\s*(public|private|protected|static|\s)*(async\s+)?\w+\s*\([^)]*\)\s*[\{:]|^\s*def\s+\w+\s*\(|^\s*(pub\s+)?(async\s+)?fn\s+\w+/;

    for (let i = 0; i < Math.min(lines.length, 500); i++) {
      if (fnPattern.test(lines[i])) {
        const range = new vscode.Range(i, 0, i, 0);
        lenses.push(new vscode.CodeLens(range, {
          title: '⚓ Ask Navy',
          command: 'navy.askAboutLine',
          arguments: [document.uri, i + 1]
        }));
      }
    }
    return lenses;
  }
}

function activate(context) {
  const proposedProvider = new NavyProposedContentProvider();
  context.__navyProposedProvider = proposedProvider;

  const provider = new NavyCoderViewProvider(context);

  // Output channel: the home for best-effort failures (checkpoint persistence,
  // MCP server chatter, provider errors) — View → Output → "Navy Coder".
  const outputChannel = vscode.window.createOutputChannel('Navy Coder');
  context.subscriptions.push(outputChannel);
  provider.log = (line) => outputChannel.appendLine(new Date().toISOString().slice(11, 19) + '  ' + line);

  // First-run welcome — point new users at the sidebar so they know where Navy lives.
  if (!context.globalState.get('navy.welcomed')) {
    context.globalState.update('navy.welcomed', true);
    vscode.window.showInformationMessage(
      'Navy AI Coder is ready — find it at the ☸ wheel icon in the activity bar (left edge).',
      'Open Navy'
    ).then((choice) => {
      if (choice === 'Open Navy') vscode.commands.executeCommand('navy.chatView.focus');
    });
  }

  // ── Status bar item ─────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.name    = 'Navy AI Coder';
  statusBar.text    = '☸ Navy';
  statusBar.tooltip = 'Navy AI Coder — click to open';
  statusBar.command = 'navy.focusChat';
  statusBar.show();
  context.subscriptions.push(statusBar);
  provider.statusBarItem = statusBar;

  // Inline ghost-text completions — routes to the active provider with debounce.
  let _inlineReqId = 0;
  const inlineCompletionProvider = {
    async provideInlineCompletionItems(document, position, _ctx, token) {
      const config = vscode.workspace.getConfiguration('navy');
      if (!config.get('inlineCompletions', false)) return [];
      const model = config.get('model', '');
      if (!model) return [];

      const reqId = ++_inlineReqId;
      await new Promise(r => setTimeout(r, 350));
      if (reqId !== _inlineReqId || token.isCancellationRequested) return [];

      const startLine = Math.max(0, position.line - 20);
      const prefix = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
      if (!prefix.trim()) return [];

      const aiProvider = config.get('provider', 'ollama');
      const host       = config.get('host', 'http://localhost:11434').replace(/\/$/, '');
      const apiBase    = config.get('apiBase', '');
      const apiKey     = await provider.context.secrets.get('navy.apiKey.' + aiProvider)
                       || await provider.context.secrets.get('navy.apiKey') || '';

      const ctrl = new AbortController();
      token.onCancellationRequested(() => ctrl.abort());

      try {
        let completion = '';

        if (aiProvider === 'ollama') {
          const res = await fetch(host + '/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: prefix, stream: false,
              options: { temperature: 0.05, num_predict: 80, stop: ['\n\n', '```', '\nfunction ', '\nclass ', '\ndef '] } }),
            signal: ctrl.signal,
          });
          if (!res.ok) return [];
          const data = await res.json();
          completion = (data.response || '').trimEnd();

        } else if (aiProvider === 'anthropic') {
          const baseUrl = apiBase || 'https://api.anthropic.com';
          const res = await fetch(baseUrl + '/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey,
              'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model, max_tokens: 80, temperature: 0.05,
              system: 'You are a code completion engine. Output ONLY the continuation — no explanation, no markdown fences.',
              messages: [{ role: 'user', content: 'Complete this code at the cursor:\n' + prefix }] }),
            signal: ctrl.signal,
          });
          if (!res.ok) return [];
          const data = await res.json();
          completion = (data.content?.[0]?.text || '').trimEnd();

        } else {
          const base = openAiCompatBase(aiProvider, apiBase, host) || host;
          const headers = { 'Content-Type': 'application/json' };
          if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
          const res = await fetch(base + '/chat/completions', {
            method: 'POST',
            headers,
            body: JSON.stringify({ model, max_tokens: 80, temperature: 0.05,
              messages: [
                { role: 'system', content: 'You are a code completion engine. Output ONLY the continuation — no explanation, no markdown fences, no repeating existing code.' },
                { role: 'user', content: prefix },
              ] }),
            signal: ctrl.signal,
          });
          if (!res.ok) return [];
          const data = await res.json();
          completion = (data.choices?.[0]?.message?.content || '').trimEnd();
        }

        if (!completion || token.isCancellationRequested) return [];
        return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
      } catch { return []; }
    }
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('navy-proposed', proposedProvider),
    vscode.window.registerWebviewViewProvider('navy.chatView', provider),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineCompletionProvider),
    vscode.commands.registerCommand('navy.focusChat', () => provider.focus()),
    vscode.commands.registerCommand('navy.insertLastReply', () => provider.insertLastReply()),
    vscode.commands.registerCommand('navy.clearChat', () => provider.clearChat()),
    vscode.commands.registerCommand('navy.undoLastEdit', () => provider.undoLastCheckpoint()),
    vscode.commands.registerCommand('navy.undoLastTurn', () => provider.undoLastTurn()),
    vscode.commands.registerCommand('navy.redoLastUndo', () => provider.redoLast()),
    vscode.commands.registerCommand('navy.inlineEdit', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sel = editor.selection;
      const selectedText = sel.isEmpty
        ? editor.document.lineAt(sel.active.line).text
        : editor.document.getText(sel);

      const instruction = await vscode.window.showInputBox({
        prompt: 'What should Navy change?',
        placeHolder: 'e.g. add error handling, convert to async/await, add JSDoc',
        ignoreFocusOut: true
      });
      if (!instruction) return;

      const filePath = editor.document.fileName;
      const lang = editor.document.languageId;
      const prompt = `You are editing a ${lang} file. Edit ONLY the following code snippet as instructed. Return ONLY the edited code with no explanation, no markdown fences, no extra text.\n\nInstruction: ${instruction}\n\nCode to edit:\n${selectedText}`;
      await provider.focus();
      await provider.askNavy(prompt, false, null, [filePath]);
    }),
    vscode.commands.registerCommand('navy.generateCommit', () => provider.generateCommit()),
    vscode.commands.registerCommand('navy.generatePR', () => provider.generatePRDescription()),
    vscode.commands.registerCommand('navy.runTests', () => provider.runTestsCommand()),
    vscode.commands.registerCommand('navy.askAboutLine', async (uri, line) => {
      await provider.focus();
      const relativePath = vscode.workspace.asRelativePath(uri);
      provider.askNavy(`Explain the function at line ${line} of ${relativePath}. What does it do, are there any issues, and how could it be improved?`, false, null, [uri.fsPath]);
    }),
    vscode.commands.registerCommand('navy.explainTerminalError', () => provider.explainTerminalError()),
    vscode.languages.registerCodeLensProvider({ pattern: '**/*.{js,ts,jsx,tsx,py,rs,go,java,cs,cpp,c,rb,php}' }, new NavyCodeLensProvider(provider)),
    vscode.languages.registerCodeActionsProvider({ pattern: '**' }, new NavyFixCodeActionProvider(provider), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.commands.registerCommand('navy.fixDiagnostic', async (uri, diag) => {
      const rel = vscode.workspace.asRelativePath(uri);
      const line = diag.range.start.line + 1;
      const sev = diag.severity === 0 ? 'error' : 'warning';
      const prompt = `Fix the ${sev} on line ${line} of ${rel}:\n\n"${diag.message}"\n\nRead the file, understand the root cause, then apply the minimal correct fix.`;
      await provider.focus();
      provider.askNavy(prompt, false, null, [uri.fsPath]);
    }),
    vscode.commands.registerCommand('navy.exportConversation', () => provider.view?.webview.postMessage({ type: 'requestExport' })),
    vscode.commands.registerCommand('navy.reviewPR', () => provider.generatePRReview()),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) provider.applyGutterDecorations(editor);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.sendWorkspaceFolders()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('navy.mcpServers')) provider.reloadMcpServers();
    }),
    { dispose: () => provider.dispose() }
  );

  // Connect configured MCP servers in the background — never blocks activation.
  provider.reloadMcpServers();
}

function deactivate() {}

// NavyCoderViewProvider is exported for the test suite (test/run.js drives its
// undo/redo/checkpoint logic against a mock vscode + real temp filesystem).
module.exports = { activate, deactivate, NavyCoderViewProvider };
