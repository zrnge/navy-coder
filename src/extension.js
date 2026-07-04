const { streamAssistant, parseToolCalls, extractCodeEdits } = require('./providers/llm.js');
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
    this.thinkingLevel = 'medium'; // fast | medium | high
    this.currentTurnId = null;     // groups checkpoints for per-turn undo
    this.statusBarItem = null; // set by activate() after construction
    this.bgProcesses = new Map(); // id → { proc, stdout, stderr, exitCode }
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
        case 'clear':
          this.clearChat();
          break;
        case 'getModels':
          await this.loadModels();
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
          if (message.command) vscode.commands.executeCommand(message.command);
          break;
        case 'openFolder':
          await this.openFolder();
          break;
        case 'getWorkspaceFolders':
          await this.sendWorkspaceFolders();
          break;
        case 'setProjectRoot':
          this.projectRoot = message.root || '';
          await this._persistProjectRoot(this.projectRoot);
          await this.sendWorkspaceFolders();
          await this.loadProjectSession();
          break;
        case 'setThinkingLevel':
          this.setThinkingLevel(message.level);
          break;
        case 'clearMemory':
          await this.toolForget('');
          break;
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
          // Reload models in case provider/host changed.
          await this.loadModels();
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
    this.messages = [];
    this.lastReply = '';
    this.checkpoints = [];
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
      const wsFolder = vscode.workspace.workspaceFolders?.find(
        (f) => filePath.startsWith(f.uri.fsPath)
      );
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
    const folders = vscode.workspace.workspaceFolders || [];
    const exists = folders.some((f) => f.uri.fsPath === picked);
    if (exists) {
      this.projectRoot = picked;
    } else {
      const uri = vscode.Uri.file(picked);
      const newIndex = folders.length;
      await vscode.workspace.updateWorkspaceFolders(newIndex, 0, uri);
      this.projectRoot = picked;
    }
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

  async loadModels() {
    const config = vscode.workspace.getConfiguration('navy');
    const host = config.get('host', 'http://localhost:11434').replace(/\/$/, '');
    const currentModel = config.get('model', 'kimi-k2.7-code:cloud');

    const provider = config.get('provider', 'ollama');
    const apiBase = config.get('apiBase', '');
    const apiKey = await this.context.secrets.get('navy.apiKey.' + provider)
                || await this.context.secrets.get('navy.apiKey') || '';

    // Context length is only fetchable from Ollama (/api/show) — clear it for other
    // providers so the context gauge never shows a stale value from a previous provider.
    if (provider !== 'ollama') this.modelContextLength = null;

    // Providers with static model lists
    const STATIC_MODELS = {
      openai:     ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini', 'o3', 'o3-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
      anthropic:  ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229'],
      deepseek:   ['deepseek-chat', 'deepseek-reasoner'],
      gemini:     ['gemini-2.5-pro-preview-06-05', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
      xai:        ['grok-3', 'grok-3-mini', 'grok-2', 'grok-beta'],
      groq:       ['moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
      openrouter: ['openai/gpt-4o', 'anthropic/claude-opus-4', 'google/gemini-2.0-flash', 'deepseek/deepseek-r1', 'meta-llama/llama-3.3-70b-instruct', 'x-ai/grok-3'],
    };

    if (STATIC_MODELS[provider]) {
      const models = STATIC_MODELS[provider];
      const activeModel = config.get('model', models[0]);
      this.view?.webview.postMessage({ type: 'models', models, currentModel: activeModel });
      return;
    }

    // LM Studio — fetch from local OpenAI-compatible endpoint
    if (provider === 'lmstudio') {
      const base = (apiBase || 'http://localhost:1234/v1').replace(/\/$/, '');
      try {
        const res = await fetch(base + '/models');
        if (res.ok) {
          const data = await res.json();
          const models = (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
          if (models.length > 0) {
            const activeModel = config.get('model', models[0]);
            this.view?.webview.postMessage({ type: 'models', models, currentModel: activeModel });
            return;
          }
        }
      } catch {}
      this.view?.webview.postMessage({ type: 'models', models: [], currentModel, error: 'LM Studio not reachable at ' + base });
      return;
    }

    // z.ai — fetch from their OpenAI-compatible endpoint
    if (provider === 'zai') {
      const base = (apiBase || 'https://api.z.ai/v1').replace(/\/$/, '');
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
        const res = await fetch(base + '/models', { headers });
        if (res.ok) {
          const data = await res.json();
          const models = (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
          if (models.length > 0) {
            const activeModel = config.get('model', models[0]);
            this.view?.webview.postMessage({ type: 'models', models, currentModel: activeModel });
            return;
          }
        }
      } catch {}
      this.view?.webview.postMessage({ type: 'models', models: [], currentModel, error: 'z.ai not reachable or no models returned' });
      return;
    }

    // Custom — fetch from user-specified base URL
    if (provider === 'custom' && apiBase) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
        const res = await fetch(apiBase.replace(/\/$/, '') + '/models', { headers });
        if (res.ok) {
          const data = await res.json();
          const models = (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
          if (models.length > 0) {
            const activeModel = config.get('model', models[0]);
            this.view?.webview.postMessage({ type: 'models', models, currentModel: activeModel });
            return;
          }
        }
      } catch {}
    }

    // Ollama (default)
    try {
      const response = await fetch(host + '/api/tags');
      if (!response.ok) throw new Error('Ollama returned ' + response.status);
      const data = await response.json();
      const models = (data.models || []).map((m) => m.name || m.model).filter(Boolean).sort();
      if (models.length > 0 && !models.includes(currentModel)) {
        await config.update('model', models[0], true);
      }
      const activeModel = config.get('model', models[0] || currentModel);
      this.view?.webview.postMessage({ type: 'models', models, currentModel: activeModel });
      this.fetchModelContext(host, activeModel);
    } catch (error) {
      this.view?.webview.postMessage({ type: 'models', models: [], currentModel, error: error.message });
    }
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
    return dir;
  }

  async loadProjectSession() {
    const dir = this.getNavyDir();
    if (!dir) return;
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(dir, 'session.json')));
      const session = JSON.parse(Buffer.from(data).toString('utf8'));
      this.messages = Array.isArray(session.messages) ? session.messages : [];
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
      this.view?.webview.postMessage({ type: 'sessionLoaded', count: 0, memory: '', projectRoot: this.projectRoot });
    }
    const rules = await this.loadProjectRules();
    this.view?.webview.postMessage({ type: 'rulesStatus', active: Boolean(rules) });
  }

  async saveProjectSession() {
    const dir = await this.ensureNavyDir();
    if (!dir) return;
    try {
      const session = { updated: new Date().toISOString(), projectRoot: this.projectRoot, messages: this.messages };
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

    const config = vscode.workspace.getConfiguration('navy');
    const configuredModel = config.get('model', 'kimi-k2.7-code:cloud');
    const model = selectedModel || configuredModel;
    const host = config.get('host', 'http://localhost:11434').replace(/\/$/, '');

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
    if (projectRules) {
      systemContent += '\n\n## Project Rules (permanent team conventions — always follow these, they override your defaults):\n' + projectRules;
    }
    if (projectMemory) {
      systemContent += '\n\n## Project Memory (facts you learned in previous sessions — treat as ground truth unless you discover otherwise):\n' + projectMemory;
    }
    if (diagnosticsContext) systemContent += diagnosticsContext;
    systemContent += '\n\nRepository map:\n' + repoMap;

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

    if (this.messages.length > 80) {
      this.messages = this.messages.slice(-60);
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
    try {
      let usedTools = false;

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

      // Change tracker: accumulates what the model touched so we can append a report footer.
      const taskChanges = { touched: new Map(), deleted: [], commands: [] };
      // touched: Map<inputPath, 'created'|'modified'>; commands: { cmd, exit }[]

      let lastAssistantText = ''; // final assistant text, persisted to history after the loop

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (this.abortController.signal.aborted) break;
        if (iteration > 0) {
          this.view?.webview.postMessage({ type: 'stepProgress', step: iteration + 1, max: maxIterations });
        }
        resetWatchdog();
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

        // Build the assistant message. When using native tool calling, include tool_calls
        // so the model receives proper conversation history on the next iteration.
        if (nativeToolCalls.length > 0) {
          // _rawBlocks preserves Anthropic thinking/tool_use blocks for exact replay
          // on the next iteration (required when extended thinking is enabled).
          messages.push({ role: 'assistant', content: responseText || '', tool_calls: nativeToolCalls,
            ...(rawBlocks?.length ? { _rawBlocks: rawBlocks } : {}) });
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
                '`' + path.basename(p) + '`' + (type === 'created' ? ' *(new)*' : '')
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
          'git_status','git_diff','git_log','git_blame','get_diagnostics',
          'find_symbol','find_references',
          'web_search','fetch_url','get_terminal_output','read_process_output']);

        // Tools whose results are stable — dedup prevents re-reading the same file in a loop.
        const DEDUP_TOOLS = new Set(['read_file','read_lines','list_files','search_files','search_codebase',
          'git_status','git_diff','git_log','git_blame','get_diagnostics',
          'find_symbol','find_references']);
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
                result += await this._diagnosticsAfterWrite(p);
              }
            }
            if (tool.name === 'delete_file' && typeof result === 'string' && result.startsWith('Deleted')) {
              taskChanges.deleted.push(tool.args?.path || '');
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
      if (lastAssistantText.trim()) this.messages.push({ role: 'assistant', text: lastAssistantText });

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
        const providerLabel = { ollama: 'Ollama', lmstudio: 'LM Studio', anthropic: 'Anthropic', openai: 'OpenAI', deepseek: 'DeepSeek', gemini: 'Gemini', xai: 'xAI', zai: 'z.ai', groq: 'Groq', openrouter: 'OpenRouter', custom: 'Custom endpoint' }[p] || p;
        const hint = p === 'ollama' ? ' (run "ollama serve" if not running)' : '';
        this.view?.webview.postMessage({ type: 'error', message: `${providerLabel} error${hint} — ${error.message}` });
      }
    } finally {
      clearTimeout(this._watchdog);
      this._watchdog = undefined;
      this.abortController = undefined;
      this.isBusy = false;
      if (this.statusBarItem) this.statusBarItem.text = '☸ Navy';
      this.view?.webview.postMessage({ type: 'done' });
      if (hitCap) this.view?.webview.postMessage({ type: 'capReached', steps: maxIterations });
      // Persist the session after every turn — wrapped so a write failure never
      // prevents 'done' from being sent or the queue from draining.
      try { await this.saveProjectSession(); } catch (e) { console.error('[Navy] saveProjectSession failed:', e); }

      // Drain the message queue — process the next queued message if any.
      if (this.messageQueue.length > 0) {
        const next = this.messageQueue.shift();
        this.view?.webview.postMessage({ type: 'queueDrained', remaining: this.messageQueue.length });
        setImmediate(() => this.askNavy(next.prompt, next.includeContext, next.selectedModel, next.attachedFiles, next.images || []));
      }
    }
  }

  async executeTool(tool) {
    try {
      switch (tool.name) {
        case 'read_file': return await this.toolReadFile(tool.args.path);
        case 'remember': return await this.toolRemember(tool.args.fact);
        case 'forget': return await this.toolForget(tool.args.query);
        case 'read_lines': return await this.toolReadLines(tool.args.path, tool.args.start, tool.args.end);
        case 'write_file': return await this.toolWriteFile(tool.args.path, tool.args.content);
        case 'delete_file': return await this.toolDeleteFile(tool.args.path);
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
    const normalRoot = path.normalize(root);
    const normalCandidate = path.normalize(candidate);
    if (normalCandidate !== normalRoot && !normalCandidate.startsWith(normalRoot + path.sep)) {
      throw new Error('Path is outside the workspace root: ' + inputPath);
    }

    // Resolve symlinks to prevent traversal through symlinks inside the workspace
    try {
      const real = fs.realpathSync(candidate);
      const realRoot = fs.realpathSync(root);
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
      return lines.join('\n') || '(empty directory)';
    } catch (error) {
      return 'Error: ' + error.message;
    }
  }

  async _listDir(dirPath, prefix, maxDepth, depth, lines) {
    const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.next', '__pycache__', '.venv']);
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
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

  async toolSearchFiles(query) {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'No workspace open';
    try {
      const results = [];
      await this.searchDirectory(root, query, results, 0, root);
      return results.slice(0, 20).join('\n') || 'No matches';
    } catch (error) {
      return 'Error: ' + error.message;
    }
  }

  async searchDirectory(dir, query, results, depth, root) {
    if (depth > 2) return;
    const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '__pycache__', '.venv']);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
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
      await vscode.workspace.fs.delete(vscode.Uri.file(filePath), { recursive: true, useTrash: true });
      return `Deleted ${basename} (moved to Recycle Bin).`;
    } catch (e) {
      return `Error deleting ${basename}: ${e.message}`;
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
    this.highlightChangedLines(filePath, [idx], []);
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

  async toolFetchUrl(url) {
    try {
      let parsed;
      try { parsed = new URL(url); } catch { return 'Fetch error: invalid URL'; }
      if (!/^https?:$/i.test(parsed.protocol)) return 'Fetch error: only http/https URLs are allowed';
      const h = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      // Block private/local addresses: loopback, RFC-1918, link-local, IPv6 loopback,
      // decimal-encoded IPs (e.g. 2130706433 = 127.0.0.1), cloud metadata endpoints.
      if (/^(localhost|127\.|0\.0\.0\.0|::1|::ffff:|0:0:0:0:0:0:0:1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(h)
        || /^[0-9]+$/.test(h)   // decimal IP like 2130706433
        || h === 'metadata.google.internal'
        || h.endsWith('.internal')
        || h.endsWith('.local'))
        return 'Fetch error: fetching private or local addresses is not allowed';
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'NavyCoder/1.0' } });
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

  async toolSearchCodebase(query, filePattern, contextLines = 2) {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'No workspace open.';

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
    this.highlightChangedLines(filePath, insertedIndices, []);
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
      // Auto-retry hint: show first 300 chars so the model can correct without a round-trip.
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
        this.createCheckpoint(filePath, oldText);
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
        this.createCheckpoint(filePath, oldText);
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
        this.createCheckpoint(approval.filePath, original);
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

      this.createCheckpoint(filePath, original);
      await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(newText, 'utf8'));
      return 'Applied edit to ' + path.basename(filePath);
    } catch (error) {
      return 'Error applying edit: ' + error.message;
    }
  }

  createCheckpoint(filePath, originalText) {
    this.checkpoints.push({ filePath, originalText, time: Date.now(), turnId: this.currentTurnId });
    if (this.checkpoints.length > 200) this.checkpoints.splice(0, this.checkpoints.length - 200);
    this.view?.webview.postMessage({ type: 'checkpoints', count: this.checkpoints.length });
  }

  async undoLastCheckpoint() {
    const last = this.checkpoints.pop();
    if (!last) {
      vscode.window.showInformationMessage('No Navy Coder edits to undo');
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(last.filePath), Buffer.from(last.originalText, 'utf8'));
      vscode.window.showInformationMessage('Undid last Navy Coder edit');
      this.view?.webview.postMessage({ type: 'checkpoints', count: this.checkpoints.length });
    } catch (error) {
      vscode.window.showErrorMessage('Undo failed: ' + error.message);
    }
  }

  async undoLastTurn() {
    if (this.checkpoints.length === 0) {
      vscode.window.showInformationMessage('No Navy Coder edits to undo');
      return;
    }
    const lastTurnId = this.checkpoints[this.checkpoints.length - 1].turnId;
    const toUndo = this.checkpoints.filter(c => c.turnId === lastTurnId).reverse();
    this.checkpoints = this.checkpoints.filter(c => c.turnId !== lastTurnId);
    const errors = [];
    for (const cp of toUndo) {
      try {
        await vscode.workspace.fs.writeFile(vscode.Uri.file(cp.filePath), Buffer.from(cp.originalText, 'utf8'));
      } catch (e) {
        errors.push(path.basename(cp.filePath) + ': ' + e.message);
      }
    }
    if (errors.length > 0) {
      vscode.window.showErrorMessage('Some undos failed: ' + errors.join(', '));
    } else {
      vscode.window.showInformationMessage(`Undid ${toUndo.length} edit${toUndo.length !== 1 ? 's' : ''} from last turn`);
    }
    this.view?.webview.postMessage({ type: 'checkpoints', count: this.checkpoints.length });
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
      const child = spawn(shellBin, shellArgs, { cwd: root, detached: !isWin });
      const timer = setTimeout(() => {
        this._killProcessTree(child);
        resolve('Command timed out after ' + timeout + 'ms\nstdout: ' + stdout + '\nstderr: ' + stderr);
      }, timeout);

      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        this.view?.webview.postMessage({ type: 'shellChunk', chunk });
      });
      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        this.view?.webview.postMessage({ type: 'shellChunk', chunk, isStderr: true });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve('Exit code: ' + code + '\nstdout:\n' + stdout + '\nstderr:\n' + stderr);
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
    // Kill all background processes when the extension is deactivated or reloaded.
    for (const [, entry] of this.bgProcesses) {
      if (entry?.proc) { try { this._killProcessTree(entry.proc); } catch {} }
    }
    this.bgProcesses.clear();
  }

  async runBackgroundTask(taskId, prompt) {
    const ctrl = new AbortController();
    this.bgWorkers.set(taskId, { ctrl });

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
          if (tool.name === 'finish') continue;
          post('tool', { tool: tool.name, args: tool.args });
          const result = await this.executeTool(tool);
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
      else post('error', { message: e.message });
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
      proc.on('close', () => resolve(out.trim() || ('git blame failed: ' + err.trim())));
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
      const linkRe = /<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = linkRe.exec(html)) !== null) links.push({ url: m[1], title: m[2].replace(/<[^>]*>/g, '').trim() });
      const snipRe = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
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

  async buildRepoMap() {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'PROJECT ROOT UNKNOWN — do NOT invent file names or project names. Tell the user to open a folder in VS Code first.';

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

      return lines.join('\n') || 'Empty project directory';
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
      this.createCheckpoint(filePath, original);
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
        const res = await fetch(host + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: 'You write concise, conventional-commits-style git commit messages. Output ONLY the commit message — no explanation, no quotes, no markdown.' },
              { role: 'user', content: `Write a git commit message for this diff:\n\n${diffToUse.slice(0, 6000)}` }
            ],
            stream: false
          })
        });
        const data = await res.json();
        const message = (data.message?.content || '').trim();
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
        const res = await fetch(host + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: 'You write clear GitHub pull request descriptions in markdown. Include: a short title line, a ## Summary section with bullet points, and a ## Changes section. Be concise and factual.' },
              { role: 'user', content: `Generate a PR description for these changes:\n\nCommits:\n${log}\n\nDiff (truncated):\n${diff.slice(0, 5000)}` }
            ],
            stream: false
          })
        });
        const data = await res.json();
        const prText = (data.message?.content || '').trim();
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
    const host = vscode.workspace.getConfiguration('navy').get('host', 'http://localhost:11434').replace(/\/$/, '');
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:; connect-src 'none';">
  <link href="${styleUri}" rel="stylesheet">
  <title>Navy Coder</title>
</head>
<body>
  <main class="app">
    <header class="topbar">
      <!-- Row 1: brand · live status · mode controls · actions -->
      <div class="topbar-row topbar-row1">
        <div class="topbar-brand">
          <svg class="brand-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="12" cy="12" r="9.5" stroke="currentColor" stroke-width="1.8"/>
            <circle cx="12" cy="12" r="2.8" stroke="currentColor" stroke-width="1.5"/>
            <g stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(0 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(45 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(90 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(135 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(180 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(225 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(270 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(315 12 12)"/>
            </g>
            <g fill="currentColor">
              <circle cx="12" cy="2" r="1.1" transform="rotate(0 12 12)"/>
              <circle cx="12" cy="2" r="1.1" transform="rotate(45 12 12)"/>
              <circle cx="12" cy="2" r="1.1" transform="rotate(90 12 12)"/>
              <circle cx="12" cy="2" r="1.1" transform="rotate(135 12 12)"/>
              <circle cx="12" cy="2" r="1.1" transform="rotate(180 12 12)"/>
              <circle cx="12" cy="2" r="1.1" transform="rotate(225 12 12)"/>
              <circle cx="12" cy="2" r="1.1" transform="rotate(270 12 12)"/>
              <circle cx="12" cy="2" r="1.1" transform="rotate(315 12 12)"/>
            </g>
          </svg>
          <span class="brand-title">Navy</span>
          <svg class="brand-thinking" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-label="Thinking" title="Navy is thinking…">
            <circle cx="12" cy="12" r="9.5" stroke="currentColor" stroke-width="1.8"/>
            <circle cx="12" cy="12" r="2.8" stroke="currentColor" stroke-width="1.5"/>
            <g stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(0 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(45 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(90 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(135 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(180 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(225 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(270 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(315 12 12)"/>
            </g>
            <g fill="currentColor">
              <circle cx="12" cy="2" r="1" transform="rotate(0 12 12)"/>
              <circle cx="12" cy="2" r="1" transform="rotate(45 12 12)"/>
              <circle cx="12" cy="2" r="1" transform="rotate(90 12 12)"/>
              <circle cx="12" cy="2" r="1" transform="rotate(135 12 12)"/>
              <circle cx="12" cy="2" r="1" transform="rotate(180 12 12)"/>
              <circle cx="12" cy="2" r="1" transform="rotate(225 12 12)"/>
              <circle cx="12" cy="2" r="1" transform="rotate(270 12 12)"/>
              <circle cx="12" cy="2" r="1" transform="rotate(315 12 12)"/>
            </g>
          </svg>
        </div>
        <!-- Live status (elastic, mostly hidden) -->
        <div class="topbar-info">
          <span id="diagBadge" class="diag-badge" style="display:none"></span>
          <span id="stepBadge" class="step-badge"></span>
          <span id="queuedBadge" class="queued-badge" style="display:none"></span>
          <span id="statusText" class="status-text"></span>
          <span id="rulesBadge" class="rules-badge" title="Project rules active">RULES</span>
          <span id="contextLength" class="context-length-badge" title="Context window"></span>
          <span id="tokenCounter" class="token-counter" title="Tokens used"></span>
          <span id="inlineEditBadge" class="inline-edit-badge"></span>
        </div>
        <!-- Mode selects + icon buttons -->
        <div class="topbar-actions">
          <select id="thinkingLevelSelect" title="Thinking depth" class="select-compact">
            <option value="fast">Fast</option>
            <option value="medium" selected>Med</option>
            <option value="high">High</option>
          </select>
          <select id="approvalModeSelect" title="Edit approval mode" class="select-compact">
            <option value="ask-always">Ask</option>
            <option value="auto-approve">Auto</option>
          </select>
          <button id="memoryButton" type="button" class="icon-button memory-button" title="Project memory" aria-label="Project memory">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
            </svg>
            <span id="memoryCount" class="memory-count" style="display:none">0</span>
          </button>
          <button id="undoButton" type="button" class="icon-button" title="Undo last edit" aria-label="Undo last edit" disabled>
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7v6h6"></path>
              <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path>
            </svg>
          </button>
          <button id="searchButton" type="button" class="icon-button" title="Search chat (Ctrl+F)" aria-label="Search chat">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
          </button>
          <button id="exportButton" type="button" class="icon-button" title="Export conversation" aria-label="Export conversation">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
          </button>
          <button id="clearButton" type="button" class="icon-button new-chat-button" title="New chat" aria-label="New chat">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v14M5 12h14"></path>
            </svg>
            <span class="new-chat-label">New chat</span>
          </button>
          <button id="settingsButton" type="button" class="icon-button" title="Settings" aria-label="Settings">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
        </div>
      </div>
      <!-- Row 2: context selectors (project · model) -->
      <div class="topbar-row topbar-row2">
        <select id="projectSelect" title="Project directory" class="select-project"></select>
        <select id="modelSelect" title="Model" class="select-model"></select>
      </div>
    </header>
    <div class="context-bar"><div id="contextBarFill" class="context-bar-fill ok"></div></div>

    <div id="debugPanel" class="debug-panel" style="display:none"></div>

    <!-- Project memory panel (shown when memoryButton is clicked) -->
    <div id="memoryPanel" class="memory-panel" style="display:none">
      <div class="memory-panel-header">
        <span class="memory-panel-title">Project Memory</span>
        <div class="memory-panel-actions">
          <button id="clearMemoryButton" type="button" class="memory-action-btn" title="Clear all memories">Clear all</button>
          <button id="closeMemoryButton" type="button" class="memory-action-btn" title="Close">✕</button>
        </div>
      </div>
      <div id="memoryContent" class="memory-content">
        <span class="memory-empty">No memories yet. Navy will remember facts about this project as you work.</span>
      </div>
    </div>

    <!-- Settings panel -->
    <div id="settingsPanel" class="settings-panel" style="display:none">
      <div class="settings-header">
        <span class="settings-title">⚙ Settings</span>
        <button id="closeSettingsButton" type="button" class="memory-action-btn" title="Close">✕</button>
      </div>
      <div class="settings-body">
        <form id="settingsForm">

          <div class="setting-group">
            <label class="setting-label">Provider</label>
            <select id="settingProvider" class="setting-select">
              <option value="ollama">Ollama (local)</option>
              <option value="lmstudio">LM Studio (local)</option>
              <option value="anthropic">Anthropic Claude</option>
              <option value="openai">OpenAI / ChatGPT</option>
              <option value="deepseek">DeepSeek</option>
              <option value="gemini">Google Gemini</option>
              <option value="xai">xAI / Grok</option>
              <option value="zai">z.ai</option>
              <option value="groq">Groq</option>
              <option value="openrouter">OpenRouter</option>
              <option value="custom">Custom Endpoint</option>
            </select>
          </div>

          <div class="setting-group" id="settingHostGroup">
            <label class="setting-label">Ollama Host</label>
            <input id="settingHost" type="text" class="setting-input" placeholder="http://localhost:11434" />
            <span class="setting-hint">URL where Ollama is running. Change this to connect to a remote server or different port (e.g. http://192.168.1.10:11434).</span>
          </div>

          <div class="setting-group" id="settingApiBaseGroup" style="display:none">
            <label class="setting-label">API Base URL</label>
            <input id="settingApiBase" type="text" class="setting-input" placeholder="" />
            <span class="setting-hint" id="settingApiBaseHint">Base URL for the API endpoint.</span>
          </div>

          <div class="setting-group" id="settingApiKeyGroup" style="display:none">
            <label class="setting-label">API Key</label>
            <input id="settingApiKey" type="password" class="setting-input" placeholder="sk-..." autocomplete="off" />
            <span class="setting-hint">Your API key for this provider. Stored in VS Code's encrypted secrets — each provider keeps its own key.</span>
          </div>

          <div class="setting-group">
            <label class="setting-label">Web Search API Key <span class="setting-optional">(optional)</span></label>
            <input id="settingSearchApiKey" type="password" class="setting-input" placeholder="tvly-… (Tavily) or Brave key — empty = DuckDuckGo" autocomplete="off" />
            <span class="setting-hint">Tavily keys (tvly-…) and Brave Search keys are auto-detected. Leave empty to use free DuckDuckGo search.</span>
          </div>

          <div class="setting-row">
            <div class="setting-group setting-half">
              <label class="setting-label">Temperature</label>
              <input id="settingTemperature" type="number" class="setting-input" min="0" max="2" step="0.05" placeholder="0.2" />
            </div>
            <div class="setting-group setting-half">
              <label class="setting-label">Max Tool Iterations</label>
              <input id="settingMaxIter" type="number" class="setting-input" min="1" max="100" step="1" placeholder="15" />
            </div>
          </div>

          <div class="setting-group">
            <label class="setting-label">Edit Format</label>
            <select id="settingEditFormat" class="setting-select">
              <option value="search-replace">Search / Replace (surgical edits)</option>
              <option value="whole-file">Whole file (full rewrite)</option>
            </select>
          </div>

          <div class="setting-group">
            <label class="setting-label">System Prompt</label>
            <textarea id="settingSystemPrompt" class="setting-textarea" rows="5" placeholder="You are a concise AI coding assistant..."></textarea>
          </div>

          <div class="settings-footer">
            <button type="submit" class="settings-save-btn">Save Settings</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Search bar (hidden by default, toggled by search button) -->
    <div id="searchBar" class="search-bar" style="display:none">
      <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" class="search-bar-icon">
        <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
      <input id="searchInput" type="text" class="search-input" placeholder="Search messages…" autocomplete="off">
      <span id="searchCount" class="search-count"></span>
      <button id="searchClose" class="search-close" title="Close search">✕</button>
    </div>

    <!-- Live shell output panel (shown while run_command is streaming) -->
    <div id="shellPanel" class="shell-panel" style="display:none">
      <div class="shell-panel-header">
        <span class="shell-panel-title">Terminal output</span>
        <button id="shellPanelClose" class="shell-panel-close" title="Dismiss">✕</button>
      </div>
      <pre id="shellOutput" class="shell-output"></pre>
    </div>

    <section id="messages" class="messages" aria-live="polite">
      <div id="welcome" class="welcome">
        <div class="welcome-logo">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="12" cy="12" r="9.5" stroke="currentColor" stroke-width="1.8"/>
            <circle cx="12" cy="12" r="2.8" stroke="currentColor" stroke-width="1.5"/>
            <g stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(0 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(45 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(90 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(135 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(180 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(225 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(270 12 12)"/>
              <line x1="12" y1="9.2" x2="12" y2="2.5" transform="rotate(315 12 12)"/>
            </g>
            <g fill="currentColor">
              <circle cx="12" cy="2" r="1.1" transform="rotate(0 12 12)"/>
              <circle cx="12" cy="2" r="1.1" transform="rotate(45 12 12)"/>
              <circle cx="12" cy="2" r="1.1" transform="rotate(90 12 12)"/>
              <circle cx="12" cy="2" r="1.1" transform="rotate(135 12 12)"/>
              <circle cx="12" cy="2" r="1.1" transform="rotate(180 12 12)"/>
              <circle cx="12" cy="2" r="1.1" transform="rotate(225 12 12)"/>
              <circle cx="12" cy="2" r="1.1" transform="rotate(270 12 12)"/>
              <circle cx="12" cy="2" r="1.1" transform="rotate(315 12 12)"/>
            </g>
          </svg>
        </div>
        <h1 class="welcome-title">Navy Coder</h1>
        <p class="welcome-tagline">AI coding agent — local with Ollama, or OpenAI, Claude, Gemini &amp; more.</p>
        <div class="welcome-chips">
          <button type="button" class="welcome-chip" data-prompt="Review the active file for bugs, edge cases, and improvements.">⚓ Review code</button>
          <button type="button" class="welcome-chip" data-prompt="Edit the active file to ">✏️ Edit files</button>
          <button type="button" class="welcome-chip" data-prompt="Search the codebase for ">🔍 Search codebase</button>
          <button type="button" class="welcome-chip" data-prompt="Run the test suite and fix any failures.">🧪 Run tests</button>
          <button type="button" class="welcome-chip" data-prompt="Generate a commit message for my staged changes.">📝 Git commit</button>
          <button type="button" class="welcome-chip" data-prompt="Run this project and give me the local URL.">▶ Run project</button>
        </div>
        <p class="welcome-hint">Type <code>/</code> for commands · paste images · <code>@</code> mention files</p>
      </div>
    </section>

    <div class="composer-wrap">
      <form id="chatForm" class="composer">
        <input type="file" id="fileAttachInput" multiple hidden>
        <div class="input-area">
          <textarea id="prompt" rows="1" placeholder="Ask Navy to code, edit, or run commands..."></textarea>
          <div class="input-meta">
            <div class="file-chips" id="fileChips">
              <button type="button" id="addContextButton" class="chip chip-add" title="Add current file to context">+ Add file</button>
            </div>
            <div class="composer-actions">
              <label class="context-toggle" title="Include current editor context">
                <input id="includeContext" type="checkbox" checked>
                <span>Context</span>
              </label>
              <button type="button" id="attachButton" class="attach-button" title="Attach images or files" aria-label="Attach images or files">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                </svg>
              </button>
              <div id="approvalQueue" class="approval-queue" title="Pending approvals"></div>
              <button id="sendButton" type="submit" class="send-button" title="Send" aria-label="Send message" disabled>
                <svg id="sendIcon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"></line>
                  <polygon points="22 2 15 22 11 13 2 9"></polygon>
                </svg>
                <svg id="stopIcon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" hidden>
                  <rect x="6" y="6" width="12" height="12" rx="2"></rect>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
    <!-- Full-size image lightbox -->
    <div id="imageLightbox" class="lightbox hidden" role="dialog" aria-modal="true">
      <div id="lightboxBackdrop" class="lightbox-backdrop"></div>
      <img id="lightboxImg" class="lightbox-img" src="" alt="Full size preview">
      <button id="lightboxClose" class="lightbox-close" title="Close (Esc)">✕</button>
    </div>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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

  // First-run welcome — point new users at the sidebar so they know where Navy lives.
  if (!context.globalState.get('navy.welcomed')) {
    context.globalState.update('navy.welcomed', true);
    vscode.window.showInformationMessage(
      'Navy AI Coder is ready — find it at the ☸ anchor icon in the activity bar (left edge).',
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

      const OPENAI_COMPAT_BASE = {
        openai: 'https://api.openai.com/v1', lmstudio: apiBase || 'http://localhost:1234/v1',
        deepseek: 'https://api.deepseek.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
        xai: 'https://api.x.ai/v1', zai: apiBase || 'https://api.z.ai/v1',
        groq: 'https://api.groq.com/openai/v1', openrouter: 'https://openrouter.ai/api/v1',
        custom: apiBase || host,
      };

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
          const base = OPENAI_COMPAT_BASE[aiProvider] || host;
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
      provider.focus();
      await provider.askNavy(prompt, false, null, [filePath]);
    }),
    vscode.commands.registerCommand('navy.generateCommit', () => provider.generateCommit()),
    vscode.commands.registerCommand('navy.generatePR', () => provider.generatePRDescription()),
    vscode.commands.registerCommand('navy.runTests', () => provider.runTestsCommand()),
    vscode.commands.registerCommand('navy.askAboutLine', (uri, line) => {
      provider.focus();
      const relativePath = vscode.workspace.asRelativePath(uri);
      provider.askNavy(`Explain the function at line ${line} of ${relativePath}. What does it do, are there any issues, and how could it be improved?`, false, null, [uri.fsPath]);
    }),
    vscode.commands.registerCommand('navy.explainTerminalError', () => provider.explainTerminalError()),
    vscode.languages.registerCodeLensProvider({ pattern: '**/*.{js,ts,jsx,tsx,py,rs,go,java,cs,cpp,c,rb,php}' }, new NavyCodeLensProvider(provider)),
    vscode.languages.registerCodeActionsProvider({ pattern: '**' }, new NavyFixCodeActionProvider(provider), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.commands.registerCommand('navy.fixDiagnostic', (uri, diag) => {
      const rel = vscode.workspace.asRelativePath(uri);
      const line = diag.range.start.line + 1;
      const sev = diag.severity === 0 ? 'error' : 'warning';
      const prompt = `Fix the ${sev} on line ${line} of ${rel}:\n\n"${diag.message}"\n\nRead the file, understand the root cause, then apply the minimal correct fix.`;
      provider.focus();
      provider.askNavy(prompt, false, null, [uri.fsPath]);
    }),
    vscode.commands.registerCommand('navy.exportConversation', () => provider.view?.webview.postMessage({ type: 'requestExport' })),
    vscode.commands.registerCommand('navy.reviewPR', () => provider.generatePRReview()),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) provider.applyGutterDecorations(editor);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.sendWorkspaceFolders()),
    { dispose: () => provider.dispose() }
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
