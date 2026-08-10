try {
const vscode = acquireVsCodeApi();

const messagesEl = document.querySelector('#messages');
const welcomeEl = document.querySelector('#welcome');
const form = document.querySelector('#chatForm');
const promptInput = document.querySelector('#prompt');
const includeContext = document.querySelector('#includeContext');
const sendButton = document.querySelector('#sendButton');
const addContextButton = document.querySelector('#addContextButton');
const fileChips = document.querySelector('#fileChips');
const modelSelect = document.querySelector('#modelSelect');
const clearButton = document.querySelector('#clearButton');
const stopButton  = document.querySelector('#stopButton');
const undoButton = document.querySelector('#undoButton');
const redoButton = document.querySelector('#redoButton');
const projectSelect = document.querySelector('#projectSelect');
// Prefix marking a <option> value as a global-catalog entry (a project Navy
// remembers but that isn't part of THIS window's workspace right now) rather
// than one of this window's own roots — see populateProjects/the change
// handler below and openCatalogProject on the extension side.
const CATALOG_OPTION_PREFIX = '__catalog__:';
const approvalQueue = document.querySelector('#approvalQueue');
const approvalModeSelect = document.querySelector('#approvalModeSelect');
const thinkingLevelSelect = document.querySelector('#thinkingLevelSelect');
const contextSelect = document.querySelector('#contextSelect');
const queuedBadge = document.querySelector('#queuedBadge');
const statusText = document.querySelector('#statusText');
const memoryButton = document.querySelector('#memoryButton');
const memoryCount = document.querySelector('#memoryCount');
const memoryPanel = document.querySelector('#memoryPanel');
const memoryContent = document.querySelector('#memoryContent');
const clearMemoryButton = document.querySelector('#clearMemoryButton');
const closeMemoryButton = document.querySelector('#closeMemoryButton');
const tokenCounterEl = document.querySelector('#tokenCounter');
const stepBadgeEl = document.querySelector('#stepBadge');
const rulesBadgeEl = document.querySelector('#rulesBadge');
const contextBarFill = document.querySelector('#contextBarFill');
const settingsButton = document.querySelector('#settingsButton');
const settingsPanel = document.querySelector('#settingsPanel');
const settingsForm = document.querySelector('#settingsForm');
const closeSettingsButton = document.querySelector('#closeSettingsButton');
const settingProvider = document.querySelector('#settingProvider');
const settingHost = document.querySelector('#settingHost');
const settingApiBase = document.querySelector('#settingApiBase');
const settingApiKey = document.querySelector('#settingApiKey');
const settingSearchApiKey = document.querySelector('#settingSearchApiKey');
const settingTemperature = document.querySelector('#settingTemperature');
const settingMaxIter = document.querySelector('#settingMaxIter');
const settingEditFormat = document.querySelector('#settingEditFormat');
const settingSystemPrompt = document.querySelector('#settingSystemPrompt');
const settingHostGroup = document.querySelector('#settingHostGroup');
const settingApiBaseGroup = document.querySelector('#settingApiBaseGroup');
const settingApiKeyGroup = document.querySelector('#settingApiKeyGroup');
const attachButton = document.querySelector('#attachButton');
const fileAttachInput = document.querySelector('#fileAttachInput');
const imageLightbox = document.querySelector('#imageLightbox');
const lightboxImg = document.querySelector('#lightboxImg');
const lightboxClose = document.querySelector('#lightboxClose');
const lightboxBackdrop = document.querySelector('#lightboxBackdrop');
const searchButton = document.querySelector('#searchButton');
const exportButton = document.querySelector('#exportButton');
const searchBar = document.querySelector('#searchBar');
const searchInput = document.querySelector('#searchInput');
const searchClose = document.querySelector('#searchClose');
const shellPanel = document.querySelector('#shellPanel');
const shellOutput = document.querySelector('#shellOutput');
const shellPanelClose = document.querySelector('#shellPanelClose');
const sessionTabsEl = document.querySelector('#sessionTabs');

// Which session (project) this webview is currently displaying — null until
// the first tagged message arrives. See the multi-session gate at the top of
// the message listener below for how this is used and kept in sync.
let activeSessionId = null;

let activeAssistantMessage = null;
let activeAssistantBubble = null;
let activeAssistantContent = '';
let lastAssistantMessage = null;  // persists after 'done' so 'applied' can find apply buttons
let userScrolledUp = false;
let activeFilePath = '';
let attachedFiles = [];
let cachedWorkspaceFiles = [];
let isBusy = false;
let busyWatchdog = null;
let slashDropdownVisible = false;
let pastedImages = []; // Array of { dataUrl, mimeType, name? }
let attachedTexts = []; // Array of { name, content } — text/code files picked from disk

function setStatus(text) {
  if (statusText) {
    statusText.textContent = text;
  }
}

function updateSendButton() {
  // When busy, the send button becomes a stop button and must stay enabled
  const hasText = promptInput.value.trim().length > 0;
  const shouldDisable = !hasText && !isBusy;
  sendButton.disabled = shouldDisable;
}

function updateAddButton() {
  if (addContextButton) {
    addContextButton.disabled = !activeFilePath || attachedFiles.includes(activeFilePath) || isBusy;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  sendPrompt();
});

promptInput.addEventListener('input', () => {
  autoResize();
  updateSendButton();
  handleAtMention();
  handleSlashCommand();
});

// Returns the open autocomplete dropdown (slash or @-mention), or null.
function getOpenDropdown() {
  for (const id of ['slashDropdown', 'atDropdown']) {
    const d = document.getElementById(id);
    if (d && d.style.display !== 'none' && d.children.length) return d;
  }
  return null;
}

function moveDropdownSelection(dropdown, dir) {
  const items = [...dropdown.children];
  let idx = items.findIndex(i => i.classList.contains('active'));
  if (idx !== -1) items[idx].classList.remove('active');
  idx = idx === -1 ? (dir > 0 ? 0 : items.length - 1) : (idx + dir + items.length) % items.length;
  items.forEach((it, i) => {
    it.classList.toggle('active', i === idx);
    it.setAttribute('aria-selected', i === idx ? 'true' : 'false');
  });
  items[idx].scrollIntoView({ block: 'nearest' });
}

promptInput.addEventListener('keydown', (event) => {
  // Keyboard navigation for the slash-command / @-mention dropdowns.
  const dropdown = getOpenDropdown();
  if (dropdown) {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveDropdownSelection(dropdown, 1); return; }
    if (event.key === 'ArrowUp')   { event.preventDefault(); moveDropdownSelection(dropdown, -1); return; }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const target = dropdown.querySelector('.active') || dropdown.firstElementChild;
      // Items act on mousedown (to beat textarea blur) — trigger the same path.
      target?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return;
    }
  }
  if (event.key === 'Escape') { hideAtDropdown(); hideSlashDropdown(); return; }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendPrompt();
  }
});

promptInput.addEventListener('blur', () => {
  // Slight delay so mousedown on a dropdown item fires first.
  setTimeout(hideAtDropdown, 150);
  setTimeout(hideSlashDropdown, 150);
});

promptInput.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      const reader = new FileReader();
      reader.onload = (ev) => {
        pastedImages.push({ dataUrl: ev.target.result, mimeType: item.type });
        renderImagePreviews();
      };
      reader.readAsDataURL(blob);
    }
  }
});

// ── File attach button ────────────────────────────────────────────────────────
attachButton?.addEventListener('click', () => fileAttachInput?.click());

fileAttachInput?.addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    const reader = new FileReader();
    if (file.type.startsWith('image/')) {
      reader.onload = (ev) => {
        pastedImages.push({ dataUrl: ev.target.result, mimeType: file.type, name: file.name });
        renderImagePreviews();
      };
      reader.readAsDataURL(file);
    } else {
      const name = file.name;
      reader.onload = (ev) => {
        attachedTexts.push({ name, content: String(ev.target.result) });
        renderAttachedTextChips();
      };
      reader.readAsText(file);
    }
  }
  e.target.value = ''; // reset so same file can be picked again
});

// ── Lightbox ─────────────────────────────────────────────────────────────────
function openLightbox(src) {
  if (!imageLightbox || !lightboxImg) return;
  lightboxImg.src = src;
  imageLightbox.classList.remove('hidden');
}

function closeLightbox() {
  if (!imageLightbox) return;
  imageLightbox.classList.add('hidden');
  lightboxImg.src = '';
}

lightboxBackdrop?.addEventListener('click', closeLightbox);
lightboxClose?.addEventListener('click', closeLightbox);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && imageLightbox && !imageLightbox.classList.contains('hidden')) closeLightbox();
});

sendButton.addEventListener('click', (event) => {
  if (isBusy) {
    event.preventDefault();
    event.stopPropagation();
    vscode.postMessage({ type: 'stop' });
  }
});

clearButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'clear' });
});

stopButton?.addEventListener('click', () => {
  vscode.postMessage({ type: 'stop' });
});

// Commit/PR/Run Tests each launch a native VS Code dialog/progress flow with no
// webview-visible busy signal to key off of (unlike Send/Stop, which track
// `isBusy` via start/done messages) — so a rapid double-click posts the same
// runCommand twice with no feedback that anything happened. A short disable
// window on the clicked button is enough to stop that without needing a wider
// protocol change to report each native command's actual completion.
function runUtilityCommand(button, command) {
  if (!button || button.disabled) return;
  button.disabled = true;
  setTimeout(() => { button.disabled = false; }, 3000);
  vscode.postMessage({ type: 'runCommand', command });
}
document.getElementById('commitButton')?.addEventListener('click', (e) => {
  runUtilityCommand(e.currentTarget, 'navy.generateCommit');
});
document.getElementById('prButton')?.addEventListener('click', (e) => {
  runUtilityCommand(e.currentTarget, 'navy.generatePR');
});
document.getElementById('testButton')?.addEventListener('click', (e) => {
  runUtilityCommand(e.currentTarget, 'navy.runTests');
});

projectSelect?.addEventListener('change', () => {
  if (projectSelect.value === '__add_folder__') {
    vscode.postMessage({ type: 'openFolder' });
    setTimeout(() => {
      if (projectSelect.value === '__add_folder__') {
        projectSelect.value = projectSelect.dataset.lastValue || '';
      }
    }, 500);
    return;
  }
  if (projectSelect.value.startsWith(CATALOG_OPTION_PREFIX)) {
    const picked = projectSelect.value.slice(CATALOG_OPTION_PREFIX.length);
    vscode.postMessage({ type: 'openCatalogProject', root: picked });
    // Picking a catalog entry is never itself a direct switch — it opens a
    // dialog (open here / add to workspace) that can be dismissed, or
    // reloads the window — so revert the visible selection until a real
    // workspaceFolders update confirms what actually happened.
    setTimeout(() => {
      if (projectSelect.value.startsWith(CATALOG_OPTION_PREFIX)) {
        projectSelect.value = projectSelect.dataset.lastValue || '';
      }
    }, 500);
    return;
  }
  projectSelect.dataset.lastValue = projectSelect.value;
  vscode.postMessage({ type: 'setProjectRoot', root: projectSelect.value });
});

undoButton?.addEventListener('click', () => {
  vscode.postMessage({ type: 'undoLast' });
});

redoButton?.addEventListener('click', () => {
  vscode.postMessage({ type: 'redoLast' });
});

addContextButton.addEventListener('click', () => {
  if (activeFilePath && !attachedFiles.includes(activeFilePath)) {
    attachedFiles.push(activeFilePath);
    renderFileChips();
    updateAddButton();
  }
});

modelSelect.addEventListener('change', () => {
  vscode.postMessage({ type: 'setModel', model: modelSelect.value });
});

approvalModeSelect?.addEventListener('change', () => {
  vscode.postMessage({ type: 'setApprovalMode', mode: approvalModeSelect.value });
});

// Welcome chips insert a starter prompt into the composer (prompts ending in a
// space are templates for the user to complete).
welcomeEl?.addEventListener('click', (e) => {
  const chip = e.target.closest('.welcome-chip');
  const p = chip?.dataset.prompt;
  if (!p) return;
  promptInput.value = p;
  promptInput.focus();
  promptInput.selectionStart = promptInput.selectionEnd = p.length;
  autoResize();
  updateSendButton();
});

contextSelect?.addEventListener('change', () => {
  vscode.postMessage({ type: 'setContextWindow', tokens: Number(contextSelect.value) || 0 });
});

thinkingLevelSelect?.addEventListener('change', () => {
  vscode.postMessage({ type: 'setThinkingLevel', level: thinkingLevelSelect.value });
});

memoryButton?.addEventListener('click', () => {
  if (!memoryPanel) return;
  const visible = memoryPanel.style.display !== 'none';
  memoryPanel.style.display = visible ? 'none' : 'block';
  if (!visible) vscode.postMessage({ type: 'getMemory' });
});

closeMemoryButton?.addEventListener('click', () => {
  memoryPanel.style.display = 'none';
});

// Note: window.confirm() is blocked inside VS Code webviews — the extension shows
// a native confirmation modal instead.
clearMemoryButton?.addEventListener('click', () => {
  vscode.postMessage({ type: 'clearMemory' });
});

// ── Search ───────────────────────────────────────────────────────────────────

let _searchMatches = [];
let _searchIdx = -1;

function openSearch() {
  if (!searchBar) return;
  searchBar.style.display = 'flex';
  searchInput?.focus();
}

function closeSearch() {
  if (searchBar) searchBar.style.display = 'none';
  filterMessages('');
  _searchMatches = []; _searchIdx = -1;
}

function filterMessages(query) {
  const q = query.toLowerCase().trim();
  _searchMatches = [];
  document.querySelectorAll('.message').forEach(el => {
    if (!q) { el.style.display = ''; return; }
    const text = el.textContent.toLowerCase();
    const hit = text.includes(q);
    el.style.display = hit ? '' : 'none';
    if (hit) _searchMatches.push(el);
  });
  const countEl = document.getElementById('searchCount');
  if (countEl) countEl.textContent = q ? (_searchMatches.length + ' results') : '';
}

searchButton?.addEventListener('click', openSearch);
searchClose?.addEventListener('click', closeSearch);
searchInput?.addEventListener('input', () => filterMessages(searchInput.value));
searchInput?.addEventListener('keydown', e => { if (e.key === 'Escape') closeSearch(); });

document.addEventListener('keydown', ev => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'f') { ev.preventDefault(); openSearch(); }
});

// ── Export ───────────────────────────────────────────────────────────────────

exportButton?.addEventListener('click', () => {
  const lines = ['# Navy Chat Export', `> ${new Date().toLocaleString()}`, ''];
  document.querySelectorAll('.message').forEach(el => {
    const isUser = el.classList.contains('user');
    const isAssistant = el.classList.contains('assistant');
    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;
    let text = '';
    if (bubble.dataset.rawMd) {
      // Assistant messages keep their original markdown — cleanest export.
      text = bubble.dataset.rawMd.trim();
    } else {
      // Strip UI chrome (Copy/Insert/Apply buttons, expand toggles) and keep line breaks.
      const clone = bubble.cloneNode(true);
      clone.querySelectorAll('button, .msg-attachments').forEach(n => n.remove());
      clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
      text = clone.textContent.trim();
    }
    if (text) {
      lines.push(isUser ? '**You:** ' + text : isAssistant ? '**Navy:** ' + text : text);
      lines.push('');
    }
  });
  vscode.postMessage({ type: 'exportConversation', text: lines.join('\n') });
});

// ── Shell panel ──────────────────────────────────────────────────────────────

shellPanelClose?.addEventListener('click', () => {
  if (shellPanel) shellPanel.style.display = 'none';
  if (shellOutput) shellOutput.textContent = '';
});

// Clear shell panel at start of each new turn so output is fresh.

// ── Drag-and-drop files onto chat ────────────────────────────────────────────

function handleDroppedFiles(files) {
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = ev => {
        pastedImages.push({ dataUrl: ev.target.result, name: file.name });
        renderImagePreviews();
      };
      reader.readAsDataURL(file);
    } else {
      const reader = new FileReader();
      reader.onload = ev => {
        attachedTexts.push({ name: file.name, content: ev.target.result });
        renderAttachedTextChips();
      };
      reader.readAsText(file);
    }
  }
}

[messagesEl, document.querySelector('.input-area')].forEach(el => {
  if (!el) return;
  el.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; el.classList.add('drag-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('drag-over'); handleDroppedFiles([...e.dataTransfer.files]); });
});

// ── Settings panel ──────────────────────────────────────────────────────────

// Each provider's real default API base URL — auto-filled into the URL box so the
// user never has to type it (they can still edit it for a proxy / self-hosted
// gateway). These are stable infrastructure endpoints, mirrored from
// src/providers/endpoints.js (the extension's source of truth for requests).
const PROVIDER_DEFAULTS = {
  ollama:     { base: '',                                              needsKey: false, baseHint: '' },
  lmstudio:   { base: 'http://localhost:1234/v1',                      needsKey: false, baseHint: 'LM Studio local server URL. Change the port if yours differs.' },
  anthropic:  { base: 'https://api.anthropic.com',                     needsKey: true,  baseHint: 'Anthropic endpoint. Edit only for a proxy/gateway.' },
  openai:     { base: 'https://api.openai.com/v1',                     needsKey: true,  baseHint: 'OpenAI endpoint. Edit only for a proxy/gateway.' },
  deepseek:   { base: 'https://api.deepseek.com/v1',                   needsKey: true,  baseHint: 'DeepSeek endpoint. Edit only for a proxy/gateway.' },
  gemini:     { base: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, baseHint: "Google's OpenAI-compatible endpoint. Edit only for a proxy/gateway." },
  xai:        { base: 'https://api.x.ai/v1',                           needsKey: true,  baseHint: 'xAI Grok endpoint. Edit only for a proxy/gateway.' },
  zai:        { base: 'https://api.z.ai/v1',                           needsKey: true,  baseHint: 'z.ai endpoint. Edit only for a proxy/gateway.' },
  groq:       { base: 'https://api.groq.com/openai/v1',                needsKey: true,  baseHint: 'Groq endpoint. Edit only for a proxy/gateway.' },
  openrouter: { base: 'https://openrouter.ai/api/v1',                  needsKey: true,  baseHint: 'OpenRouter endpoint. Edit only for a proxy/gateway.' },
  custom:     { base: '',                                              needsKey: false, baseHint: 'Full base URL of your OpenAI-compatible API endpoint.' },
};

function updateSettingsFieldVisibility(isProviderChange) {
  const p = settingProvider?.value || 'ollama';
  const info = PROVIDER_DEFAULTS[p] || PROVIDER_DEFAULTS.custom;

  if (settingHostGroup) settingHostGroup.style.display = p === 'ollama' ? '' : 'none';
  if (settingApiBaseGroup) settingApiBaseGroup.style.display = p !== 'ollama' ? '' : 'none';
  if (settingApiKeyGroup)  settingApiKeyGroup.style.display  = info.needsKey  ? '' : 'none';

  if (settingApiBase) settingApiBase.placeholder = info.base || 'https://your-server.example.com/v1';
  const hintEl = document.querySelector('#settingApiBaseHint');
  if (hintEl) hintEl.textContent = info.baseHint;

  // Auto-fill the URL box with the provider's endpoint:
  //  • on a provider change → always overwrite with the new provider's default
  //  • on load → only when the box is empty (never clobber a saved override)
  if (settingApiBase && info.base && (isProviderChange || !settingApiBase.value)) {
    settingApiBase.value = info.base;
  }
}

settingsButton?.addEventListener('click', () => {
  const visible = settingsPanel?.style.display !== 'none';
  if (settingsPanel) settingsPanel.style.display = visible ? 'none' : 'block';
  if (!visible) vscode.postMessage({ type: 'getSettings' });
});

closeSettingsButton?.addEventListener('click', () => {
  if (settingsPanel) settingsPanel.style.display = 'none';
});

settingProvider?.addEventListener('change', () => updateSettingsFieldVisibility(true));

settingsForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  // If the URL box still holds the provider's own default, save '' — an explicit
  // override would pin users to today's endpoint even if a future Navy update
  // changes the default. Only genuinely custom URLs are stored.
  const provVal = settingProvider?.value || 'ollama';
  const rawBase = settingApiBase?.value || '';
  const provDefault = (PROVIDER_DEFAULTS[provVal] || {}).base || '';
  const settings = {
    provider:     provVal,
    host:         settingHost?.value         || 'http://localhost:11434',
    apiBase:      rawBase === provDefault ? '' : rawBase,
    temperature:  settingTemperature?.value  ?? 0.2,
    maxIter:      settingMaxIter?.value      ?? 15,
    editFormat:   settingEditFormat?.value   || 'search-replace',
    systemPrompt: settingSystemPrompt?.value || '',
  };
  // Key fields display a masked placeholder (ab12••••cd34) after load. Only send
  // them when the user actually typed a new value — sending the mask back would
  // overwrite the real stored secret with garbage.
  const apiKeyVal = settingApiKey?.value || '';
  if (!apiKeyVal.includes('••••')) settings.apiKey = apiKeyVal;
  const searchKeyVal = settingSearchApiKey?.value || '';
  if (!searchKeyVal.includes('••••')) settings.searchApiKey = searchKeyVal;
  vscode.postMessage({ type: 'saveSettings', settings });
  if (settingsPanel) settingsPanel.style.display = 'none';
});

messagesEl.addEventListener('scroll', () => {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
  userScrolledUp = !nearBottom;
});

// ── Webview self-watchdog ────────────────────────────────────────────────────
// The panel runs in its own renderer, so when it stalls nothing reaches the
// extension host log and the only symptom the user can report is "it froze,
// I don't know why". This heartbeat measures the renderer's OWN event loop: if
// a tick is late, the thread was blocked, and we report how long for and what
// it was doing immediately beforehand. That turns an unreproducible freeze into
// a line in the Navy Coder output channel.
let _wdLastTick = Date.now();
let _wdLastActivity = 'idle';
let _wdReports = 0;
setInterval(() => {
  const now = Date.now();
  const gap = now - _wdLastTick;
  _wdLastTick = now;
  // 250ms interval; anything past ~1s means the thread genuinely stopped.
  if (gap > 1000 && _wdReports < 25) {
    _wdReports++;
    try {
      vscode.postMessage({
        type: 'perfWarning',
        ms: gap,
        chars: (typeof activeAssistantContent === 'string' ? activeAssistantContent.length : 0),
        mode: `STALL — last activity "${_wdLastActivity}", dom=${document.querySelectorAll('*').length} nodes`,
      });
    } catch {}
  }
}, 250);

window.addEventListener('message', (event) => {
  try {
  const message = event.data;
  _wdLastActivity = message && message.type ? message.type : 'unknown';

  // Multi-session gating: every message from the extension is tagged with
  // the session (an opaque generated id, in `message.sessionId`) it belongs
  // to. 'sessionList' and 'workspaceFolders' always pass through.
  // 'workspaceFolders' is what teaches this webview the CORRECT active
  // session no matter which UI element triggered a switch — the legacy
  // dropdown and openFolder never optimistically update activeSessionId
  // themselves (only the tab strip's own click handler does, see
  // switchToSessionTab), and EVERY project-switch path sends this message,
  // so adopting `message.sessionId` here (NOT `message.current`, which is
  // just the project ROOT path for populating the dropdown, a completely
  // different value from the session id) is what keeps activeSessionId
  // correct regardless of which control was used. Without this, switching
  // via the dropdown would leave activeSessionId stale, and every resulting
  // state-sync message (chat restore, even the dropdown's own update) would
  // then be wrongly gated out below as "belongs to a different tab". The
  // very first tagged message ever seen establishes the baseline with no
  // gating — nothing has been rendered yet, so there's nothing to protect.
  // After that, anything tagged for a DIFFERENT session than the one
  // currently displayed belongs to a background tab's turn and must not
  // touch this tab's visible thread — its state still accumulates
  // server-side; switching to that tab later requests a fresh snapshot
  // instead.
  if (activeSessionId === null && message.sessionId !== undefined) activeSessionId = message.sessionId;
  if (message.type === 'workspaceFolders' && message.sessionId !== undefined && message.sessionId !== activeSessionId) {
    adoptActiveSession(message.sessionId);
  }
  const sessionGateExempt = message.type === 'sessionList' || message.type === 'workspaceFolders';
  if (!sessionGateExempt && message.sessionId !== undefined && message.sessionId !== activeSessionId) {
    return;
  }

  // Any message from the extension proves it's alive — push the dead-backend
  // watchdog out. Includes the 30s 'heartbeat' sent during long turns.
  if (isBusy) armBusyWatchdog();
  if (message.type === 'heartbeat') return;

  if (message.type === 'start') {
    flushAssistantText();
    setBusy(true);
    resetPlanCard();
    activeAssistantMessage = addMessage('assistant', '');
    activeAssistantBubble = activeAssistantMessage.querySelector('.message-bubble');
    _primaryBubble = activeAssistantBubble;
    activeAssistantContent = '';
    _segmentStart = 0;
    _needNewBubble = false;
    _streamPre = null;
    _perfWarned = false;
    activeFilePath = message.activeFile || '';
    updateWelcome();
    // Clear shell output from previous turn; orphan a stale terminal card so a
    // new turn's chunks can't stream into last turn's card.
    activeTermCard = null;
    if (shellOutput) shellOutput.textContent = '';
    if (shellPanel) shellPanel.style.display = 'none';
    // Defensive: a prior turn normally clears these via collapseToolProgress,
    // but a fresh turn must never inherit leftover activity-log state either way.
    allActivityLogEls = [];
    _needNewActivityLog = false;
    currentActivityRowEl = null;
    activityRowsById.clear();
    // Show an initial "Thinking" row — replaced by real tool rows as they arrive.
    addToolCallCard('__thinking__', {});
    const thinkingRow = currentActivityRowEl;
    if (thinkingRow) thinkingRow.classList.add('thinking-row');
  }

  if (message.type === 'chunk') {
    // First chunk means the model is responding directly — discard the Thinking placeholder.
    {
      const log = currentActivityLog();
      if (log) {
        const placeholder = log.querySelector('.thinking-row');
        if (placeholder) placeholder.remove();
        // If the log is now empty, remove it entirely so it doesn't show a ghost border.
        if (!log.children.length) removeCurrentActivityLog();
      }
    }
    appendAssistantText(message.text);
  }

  if (message.type === 'done' || message.type === 'aborted') {
    flushAssistantText();
    setBusy(false);
    // Only a genuinely successful finish claims every plan step is done — an
    // aborted turn may have only completed some of them.
    if (message.type === 'done') updatePlanProgress(0, true);
    // A command still streaming when the turn ends (Stop pressed) — close its card.
    // Every card still in flight, not just the most recent one — Stop ends
    // all of them, and a keyed card left out would spin at 'running…' forever.
    for (const id of [...termCardsById.keys()]) finalizeTermCard('__stopped__', id);
    if (activeTermCard) finalizeTermCard('__stopped__');
    // Drop bubbles that render to nothing (e.g. a reply that was purely tool-call
    // JSON from a small model, or a trailing bubble opened for text that never
    // arrived). Only discard the whole message when NOTHING is left — the old
    // check deleted the entire message on an empty bubble, taking every tool card
    // with it, even though the comment claimed the cards survived.
    if (activeAssistantMessage) {
      for (const b of [...activeAssistantMessage.querySelectorAll('.message-bubble')]) {
        if (!b.innerHTML.trim()) b.remove();
      }
      if (!activeAssistantMessage.querySelector('.message-bubble, .activity-log, .activity-log-collapsed')) {
        activeAssistantMessage.remove();
        activeAssistantMessage = null;
      } else {
        lastAssistantMessage = activeAssistantMessage;
        activeAssistantMessage = null;
      }
    }
    activeAssistantBubble = null;
    activeAssistantContent = '';
    if (stepBadgeEl) { stepBadgeEl.textContent = ''; stepBadgeEl.classList.remove('visible'); }
    collapseToolProgress();
    updateWelcome();
  }

  if (message.type === 'errorContinue') {
    // The turn errored after real progress — one click resumes where it stopped.
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'continue-btn';
    btn.textContent = 'Continue where it stopped';
    btn.addEventListener('click', () => {
      btn.remove();
      const p = 'Continue the task — the previous turn was interrupted by a provider error. Pick up exactly where you left off; files already changed are done, do not redo them.';
      addMessage('user', p);
      vscode.postMessage({ type: 'ask', prompt: p });
    });
    messagesEl.appendChild(btn);
    scrollToBottom();
  }

  if (message.type === 'capReached') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'continue-btn';
    btn.textContent = `Continue (reached ${message.steps}-step limit)`;
    btn.addEventListener('click', () => {
      btn.remove();
      const continuePrompt = 'Continue the task — you were cut off at the step limit. Pick up exactly where you left off and finish what you started.';
      addMessage('user', continuePrompt);
      vscode.postMessage({ type: 'ask', prompt: continuePrompt });
    });
    messagesEl.appendChild(btn);
    scrollToBottom();
  }

  if (message.type === 'error') {
    flushAssistantText();
    setBusy(false);
    // Every card still in flight, not just the most recent one — Stop ends
    // all of them, and a keyed card left out would spin at 'running…' forever.
    for (const id of [...termCardsById.keys()]) finalizeTermCard('__stopped__', id);
    if (activeTermCard) finalizeTermCard('__stopped__');
    activeAssistantMessage = null;
    activeAssistantBubble = null;
    activeAssistantContent = '';
    resetPlanCard();
    collapseToolProgress();
    addMessage('error', message.message);
    updateWelcome();
  }

  if (message.type === 'focusInput') {
    promptInput.focus();
  }

  if (message.type === 'restore') {
    renderHistory(message.messages);
    updateWelcome();
  }

  if (message.type === 'sessionList') {
    // The backend's own `active` flag is authoritative — must be checked
    // FIRST, not merely as a fallback for when the old id is missing from
    // the list entirely. Opening a new tab (or closeSessionTab falling back
    // to a sibling) leaves the OLD session right there in the list, just
    // with active:false now — matching it by id alone found it and treated
    // that as "nothing changed", so the switch was never adopted (the
    // "blue active tab doesn't move until you click away and back" bug).
    const active = message.sessions.find(s => s.active) || message.sessions.find(s => s.id === activeSessionId);
    // Only touch busy/focus state on an ACTUAL switch, not every routine
    // refresh of this list (sent on every turn start/end too) — calling
    // setBusy(false) unconditionally would steal focus into the prompt input
    // on every single one of those, not just when the user actually switches.
    if (active && active.id !== activeSessionId) {
      // The backend's active session can change without a direct tab click
      // (e.g. opening a new tab, or closing the tab you were viewing which
      // auto-switches to another) — adopt it BEFORE rendering the tab strip
      // below, or the strip highlights the OLD tab for one more render.
      // renderSessionTabs marks a tab active by comparing against
      // activeSessionId, so it has to see the corrected value, not the
      // stale one. Also soft-clear so stale content doesn't linger, and
      // sync busy state since 'start'/'done' for that tab's own turn may
      // have already fired while it was in the background and gated out.
      adoptActiveSession(active.id, { busy: active.busy });
    }
    renderSessionTabs(message.sessions);
  }

  if (message.type === 'cleared') {
    // Unlock the UI first — clearing mid-turn must not leave the input locked.
    setBusy(false);
    resetThreadDisplay();
    attachedFiles = [];
    attachedTexts = [];
    pastedImages = [];
    renderFileChips();
    renderAttachedTextChips();
    renderImagePreviews();
    updateAddButton();
    if (queuedBadge) { queuedBadge.style.display = 'none'; queuedBadge.textContent = ''; }
  }

  if (message.type === 'models') {
    populateModels(message.models, message.currentModel, message.error);
    // If project selector is still empty after models arrive, re-request workspace folders.
    if (projectSelect && (!projectSelect.value || projectSelect.value === '__add_folder__')) {
      vscode.postMessage({ type: 'getWorkspaceFolders' });
    }
  }

  if (message.type === 'modelUpdated') {
    // setModel on the extension side now calls loadModels which sends a full 'models' message.
    // This message is kept for backward compat; just update the selected value without rebuilding the list.
    if (modelSelect.querySelector(`option[value="${CSS.escape(message.model)}"]`)) {
      modelSelect.value = message.model;
    }
  }

  if (message.type === 'activeFile') {
    activeFilePath = message.path || '';
    updateAddButton();
  }

  if (message.type === 'applied') {
    // activeAssistantBubble may already be null (done fired before applied).
    // Fall back to lastAssistantMessage which persists after done.
    const bubble = activeAssistantBubble || lastAssistantMessage?.querySelector('.message-bubble');
    const blocks = bubble?.querySelectorAll('.apply-button') || [];
    for (const button of blocks) {
      // Only a button actually mid-apply ("...") is a candidate — a reply with
      // several code blocks must not have ALL of them flip to "Applied" just
      // because one file write succeeded.
      if (button.textContent !== '...') continue;
      const blockPath = button.closest('.code-block')?.querySelector('.code-path')?.dataset.path || '';
      const msgPath = (message.path || '').replace(/\\/g, '/');
      // Narrow by path when both sides have one; a trailing-segment match
      // handles the block storing a relative path and the host an absolute one.
      if (msgPath && blockPath && !msgPath.endsWith('/' + blockPath.replace(/\\/g, '/')) && msgPath !== blockPath) continue;
      button.textContent = 'Applied';
      button.disabled = true;
    }
  }

  if (message.type === 'toolCall') {
    // Shell commands get a dedicated IN/OUT terminal card instead of an activity row.
    if (message.tool === 'run_command' || message.tool === 'run_tests') {
      const cmdText = message.args?.command
        || ('run_tests' + (message.args?.filter ? ' — ' + message.args.filter : ' (auto-detected)'));
      createTermCard(message.tool, cmdText, message.callId);
    } else {
      addToolCallCard(message.tool, message.args, message.callId);
    }
    const verb = TOOL_VERB[message.tool] || message.tool;
    if (statusText) statusText.textContent = `${verb}…`;
  }

  if (message.type === 'toolResult') {
    if ((message.tool === 'run_command' || message.tool === 'run_tests') && termCardFor(message.callId)) {
      finalizeTermCard(message.result, message.callId);
    } else {
      addToolResultCard(message.tool, message.result, message.callId);
    }
    if (statusText) statusText.textContent = 'Working…';
  }

  if (message.type === 'pendingDiff') {
    addPendingDiffCard(message.id, message.path, message.oldText, message.newText);
  }

  if (message.type === 'pendingCommand') {
    // Ask mode: the command hasn't started yet — don't let the card claim it's running.
    if (activeTermCard) {
      activeTermCard.statusEl.textContent = 'awaiting approval';
      activeTermCard.statusEl.className = 'term-status running';
    }
    addPendingCommandCard(message.id, message.command);
  }

  if (message.type === 'commandResolved') {
    const card = document.querySelector(`.command-card[data-command-id="${message.id}"]`);
    if (card) {
      const actions = card.querySelector('.command-actions');
      if (actions) actions.remove();
      const status = card.querySelector('.command-status');
      if (status) status.textContent = message.approved ? 'Approved — running' : 'Rejected by you';
    }
    if (activeTermCard && message.approved) {
      activeTermCard.statusEl.textContent = 'running…';
      activeTermCard.statusEl.className = 'term-status running';
    }
  }

  if (message.type === 'diffResolved') {
    const card = document.querySelector(`.diff-card[data-diff-id="${message.id}"]`);
    if (card) {
      card.querySelector('.diff-actions')?.remove();
      card.querySelector('.diff-summary')?.remove();
      const status = card.querySelector('.diff-status');
      if (status) status.textContent = message.approved ? '✓ Applied' : '✕ Rejected';
      card.classList.add(message.approved ? 'is-approved' : 'is-rejected');
      const body = card.querySelector('.diff-body');
      if (body) {
        // Prefer the count recorded at render time; fall back to a DOM count only
        // for cards created before that was tracked.
        const changedRows = card.dataset.changeCount !== undefined
          ? parseInt(card.dataset.changeCount, 10) || 0
          : body.querySelectorAll('.diff-added, .diff-removed').length;
        if (message.approved && changedRows > 0) {
          // Keep a compact preview of the change (added/removed lines only) with a
          // toggle to reveal the full diff — instead of discarding it entirely.
          body.classList.add('preview');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'expand-btn diff-expand-btn';
          btn.textContent = 'Click to expand';
          btn.addEventListener('click', () => {
            const collapsed = body.classList.toggle('preview');
            btn.textContent = collapsed ? 'Click to expand' : 'Collapse';
          });
          card.appendChild(btn);
        } else {
          body.remove(); // rejected (or empty diff): collapse to the one-line summary
        }
      }
    }
  }

  if (message.type === 'checkpoints') {
    if (undoButton) undoButton.disabled = !(message.count > 0);
  }

  if (message.type === 'redoState') {
    if (redoButton) redoButton.disabled = !(message.count > 0);
  }

  if (message.type === 'workspaceFolders') {
    populateProjects(message.roots, message.current, message.catalog);
    if (projectSelect && message.current) {
      projectSelect.dataset.lastValue = message.current;
      projectSelect.value = message.current;
    }
  }

  if (message.type === 'pendingApprovals') {
    renderApprovalQueue(message.approvals || []);
  }

  if (message.type === 'approvalMode') {
    if (approvalModeSelect) approvalModeSelect.value = message.mode;
  }

  if (message.type === 'settings') {
    const s = message.settings || {};
    if (settingProvider)     settingProvider.value     = s.provider     || 'ollama';
    if (settingHost)         settingHost.value         = s.host         || 'http://localhost:11434';
    if (settingApiKey)       settingApiKey.value       = s.apiKey       || '';
    if (settingSearchApiKey) settingSearchApiKey.value = s.searchApiKey || '';
    if (settingApiBase)      settingApiBase.value      = s.apiBase      || '';
    if (settingTemperature)  settingTemperature.value  = s.temperature  ?? 0.2;
    if (settingMaxIter)      settingMaxIter.value      = s.maxIter      ?? 15;
    if (settingEditFormat)   settingEditFormat.value   = s.editFormat   || 'search-replace';
    if (settingSystemPrompt) settingSystemPrompt.value = s.systemPrompt || '';
    updateSettingsFieldVisibility(false);
  }

  if (message.type === 'thinkingLevel') {
    if (thinkingLevelSelect) thinkingLevelSelect.value = message.level;
  }

  if (message.type === 'contextWindow') {
    renderContextWindowSelect(message);
  }

  if (message.type === 'statusText') {
    if (statusText) statusText.textContent = message.text || '';
  }

  if (message.type === 'queued') {
    if (queuedBadge) {
      queuedBadge.textContent = message.position + ' queued';
      queuedBadge.style.display = 'inline';
    }
  }

  if (message.type === 'queueDrained') {
    if (queuedBadge) {
      if (message.remaining === 0) {
        queuedBadge.style.display = 'none';
        queuedBadge.textContent = '';
      } else {
        queuedBadge.textContent = message.remaining + ' queued';
      }
    }
  }

  if (message.type === 'restrictedMode') {
    // Without this the only symptom is tools quietly refusing, which is
    // indistinguishable from Navy being broken.
    if (!document.querySelector('.restricted-notice')) {
      const el = document.createElement('div');
      el.className = 'system-notice restricted-notice';
      el.textContent = 'This folder is not trusted, so Navy will not run commands, start toolchains or MCP servers, '
        + 'or upload code for embeddings. Reading files and answering questions still work. '
        + 'Use "Workspaces: Manage Workspace Trust" to enable everything.';
      messagesEl.appendChild(el);
      updateWelcome();
      scrollToBottom();
    }
  }

  if (message.type === 'sessionLoaded') {
    updateWelcome();
    updateMemoryBadge(message.memory || '');
    if (message.count > 0) {
      addSystemMessage('Session restored — ' + message.count + ' messages from previous session.');
    }
    // Restoring a chat (or switching to a sibling tab) shows ITS accumulated
    // usage immediately, not blank until the next new message.
    renderTokenCounter(message.sessionTotal, message.sessionPrompt, message.sessionCompletion, message.estimatedCost, message.costKnown);
  }

  if (message.type === 'memoryUpdated') {
    updateMemoryPanel(message.memory || '');
    updateMemoryBadge(message.memory || '');
  }

  if (message.type === 'tokenCount') {
    // sessionTotal/etc. are only absent from an older extension host talking
    // to a newer webview — fall back to the single-turn figures rather than
    // showing nothing.
    renderTokenCounter(
      message.sessionTotal ?? message.total,
      message.sessionPrompt ?? message.prompt,
      message.sessionCompletion ?? message.completion,
      message.estimatedCost, message.costKnown);
  }

  if (message.type === 'contextUsage') {
    if (contextBarFill && message.max > 0) {
      const pct = Math.min(100, (message.used / message.max) * 100);
      contextBarFill.style.width = pct + '%';
      contextBarFill.className = 'context-bar-fill ' + (pct > 85 ? 'danger' : pct > 60 ? 'warn' : 'ok');
      contextBarFill.title = `Context: ${message.used.toLocaleString()} / ${message.max.toLocaleString()} tokens (${Math.round(pct)}%)`;
    }
  }

  if (message.type === 'stepProgress') {
    if (statusText) statusText.textContent = `Working… (step ${message.step})`;
    if (stepBadgeEl) {
      stepBadgeEl.textContent = `step ${message.step}`;
      stepBadgeEl.classList.add('visible');
    }
    // Best-effort mapping of tool-loop iteration → plan step (message.step starts
    // at 2 on the loop's second iteration; see extension.js).
    if (planCardEl && planStepCount > 0) {
      const activeIdx = Math.min(Math.max(message.step - 2, 0), planStepCount - 1);
      updatePlanProgress(activeIdx, false);
    }
  }

  if (message.type === 'rulesStatus') {
    if (rulesBadgeEl) {
      rulesBadgeEl.classList.toggle('active', Boolean(message.active));
    }
  }

  if (message.type === 'diagnostics') {
    const badge = document.getElementById('diagBadge');
    if (badge) {
      const total = (message.errors || 0) + (message.warnings || 0);
      badge.textContent = (message.errors ? `⚠ ${message.errors}` : '') + (message.warnings && !message.errors ? `◈ ${message.warnings}` : '');
      badge.className = 'diag-badge' + (message.errors > 0 ? ' diag-error' : ' diag-warn');
      badge.style.display = total > 0 ? 'inline-flex' : 'none';
    }
  }

  if (message.type === 'workspaceFiles') {
    cachedWorkspaceFiles = message.files || [];
    handleAtMention();
  }

  if (message.type === 'workspaceSymbols') {
    renderSymbolDropdown(message.symbols || []);
  }

  if (message.type === 'shellChunk') {
    // Route into the active IN/OUT terminal card when one exists; the top shell
    // panel remains as a fallback for commands run outside the tool loop (PR review).
    if (appendTermOutput(message.chunk, message.isStderr, message.streamId)) return;
    const panel = document.getElementById('shellPanel');
    const output = document.getElementById('shellOutput');
    if (panel && output) {
      panel.style.display = '';
      // Append as a text node (O(1)) instead of textContent += (re-serializes all),
      // and keep only the last ~30k chars so chatty commands can't freeze the panel.
      output.appendChild(document.createTextNode(message.chunk));
      if (output.textContent.length > 30000) {
        output.textContent = output.textContent.slice(-30000);
      }
      output.scrollTop = output.scrollHeight;
    }
  }


  if (message.type === 'requestExport') {
    const lines = ['# Navy Chat Export', `> ${new Date().toLocaleString()}`, ''];
    document.querySelectorAll('.message').forEach(el => {
      const isUser = el.classList.contains('message-user');
      const isAssistant = el.classList.contains('message-assistant');
      const bubble = el.querySelector('.message-bubble');
      const text = bubble ? bubble.innerText.trim() : '';
      if (text) {
        lines.push(isUser ? '**You:** ' + text : isAssistant ? '**Navy:** ' + text : text);
        lines.push('');
      }
    });
    vscode.postMessage({ type: 'exportConversation', text: lines.join('\n') });
  }

  // ── Background task updates ───────────────────────────────────────────────────
  if (message.type === 'bgTaskUpdate') {
    handleBgTaskUpdate(message);
  }

  if (message.type === 'bgProcessOutput') {
    appendBgProcessOutput(message.id, message.chunk, message.isStderr);
  }

  if (message.type === 'bgProcessDone') {
    markBgProcessDone(message.id, message.exitCode);
  }

  // ── Run-project card ──────────────────────────────────────────────────────────
  if (message.type === 'runProjectStart') {
    showRunProjectCard(message.projectName, message.command);
  }
  if (message.type === 'runProjectReady') {
    setRunProjectReady(message.url);
  }
  if (message.type === 'runProjectOutput') {
    appendRunProjectOutput(message.chunk);
  }
  if (message.type === 'runProjectStopped') {
    setRunProjectStopped(message.exitCode);
  }
  } catch (err) {
    console.error('[Navy] message handler error:', err);
    // Always unlock the UI — a handler crash must never leave Navy stuck busy.
    if (isBusy) setBusy(false);
  }
});

// ── Background task UI ────────────────────────────────────────────────────────

const bgTaskEls = new Map(); // taskId → { el, textEl, logEl, statusEl }
const bgProcessPanels = new Map(); // processId → { el, outputEl }

function getOrCreateBgTaskEl(taskId, promptText) {
  if (bgTaskEls.has(taskId)) return bgTaskEls.get(taskId);

  const el = document.createElement('div');
  el.className = 'message message-bg-task';
  el.dataset.taskId = taskId;
  el.innerHTML = `
    <div class="bg-task-header">
      <span class="bg-task-badge">⚙ BG</span>
      <span class="bg-task-prompt" title="${escapeHtml(promptText)}">${escapeHtml(promptText.slice(0, 80))}${promptText.length > 80 ? '…' : ''}</span>
      <span class="bg-task-status running">● running</span>
      <button class="bg-task-abort" title="Abort">✕</button>
    </div>
    <details class="bg-task-details" open>
      <summary class="bg-task-summary">Activity log</summary>
      <div class="bg-task-log"></div>
    </details>
    <div class="bg-task-text message-bubble"></div>`;

  el.querySelector('.bg-task-abort').addEventListener('click', () => {
    vscode.postMessage({ type: 'killBackgroundTask', taskId });
  });

  messagesEl.appendChild(el);
  if (welcomeEl) welcomeEl.style.display = 'none';

  const refs = {
    el,
    textEl: el.querySelector('.bg-task-text'),
    logEl:  el.querySelector('.bg-task-log'),
    statusEl: el.querySelector('.bg-task-status'),
  };
  bgTaskEls.set(taskId, refs);
  scrollToBottom();
  return refs;
}

function handleBgTaskUpdate(msg) {
  // Created on demand for ANY status, not just 'start'. Switching tabs clears
  // bgTaskEls while the task keeps running, and the 'start' that would have
  // rebuilt the card is long past — so every later chunk, tool line and the
  // final answer were dropped and the task's result never appeared at all.
  // The extension also re-announces live tasks on tab switch
  // (_sendLiveCardState), which restores the real prompt label; this is the
  // belt-and-braces path for anything that arrives before it.
  const refs = bgTaskEls.get(msg.taskId)
    || (msg.status === 'done' || msg.status === 'aborted' || msg.status === 'error' || msg.status === 'start'
        || msg.status === 'chunk' || msg.status === 'tool'
      ? getOrCreateBgTaskEl(msg.taskId, msg.prompt || '(background task)')
      : null);
  if (!refs) return;

  const { textEl, logEl, statusEl } = refs;

  if (msg.status === 'chunk') {
    const rawMd = (textEl.dataset.rawMd || '') + msg.text;
    textEl.dataset.rawMd = rawMd;
    // Stream as raw text (O(1) per chunk); markdown rendered once on done
    if (!textEl._bgPre) {
      textEl._bgPre = document.createElement('pre');
      textEl._bgPre.className = 'streaming-pre';
      textEl.innerHTML = '';
      textEl.appendChild(textEl._bgPre);
    }
    textEl._bgPre.textContent = rawMd;
    if (!textEl._bgTimer) {
      textEl._bgTimer = setTimeout(() => { textEl._bgTimer = null; scrollToBottom(); }, 80);
    }
  } else if (msg.status === 'tool') {
    const line = document.createElement('div');
    line.className = 'bg-task-log-line';
    const argsStr = JSON.stringify(msg.args || {}).slice(0, 120);
    line.textContent = `⚙ ${msg.tool}(${argsStr})`;
    logEl.appendChild(line);
    scrollToBottom();
  } else if (msg.status === 'toolResult') {
    const last = logEl.lastElementChild;
    if (last) last.classList.add('bg-log-done');
  } else if (msg.status === 'done' || msg.status === 'aborted' || msg.status === 'error') {
    // Flush streaming pre → final markdown render
    if (textEl._bgTimer) { clearTimeout(textEl._bgTimer); textEl._bgTimer = null; }
    textEl._bgPre = null;
    if (textEl.dataset.rawMd) {
      textEl.innerHTML = renderMarkdown(textEl.dataset.rawMd);
      attachCodeBlockActions(textEl);
    }
    if (msg.status === 'done') {
      statusEl.className = 'bg-task-status done';
      statusEl.textContent = '✓ done';
      refs.el.querySelector('.bg-task-details')?.removeAttribute('open');
    } else if (msg.status === 'aborted') {
      statusEl.className = 'bg-task-status aborted';
      statusEl.textContent = '✕ aborted';
    } else {
      statusEl.className = 'bg-task-status error';
      statusEl.textContent = '✕ error';
      const line = document.createElement('div');
      line.className = 'bg-task-log-line error';
      line.textContent = msg.message || 'Unknown error';
      logEl.appendChild(line);
    }
    refs.el.querySelector('.bg-task-abort')?.remove();
    bgTaskEls.delete(msg.taskId);
    scrollToBottom();
  }
}

function appendBgProcessOutput(id, chunk, isStderr) {
  let refs = bgProcessPanels.get(id);
  if (!refs) {
    const el = document.createElement('div');
    el.className = 'message message-bg-process';
    el.innerHTML = `
      <div class="bg-task-header">
        <span class="bg-task-badge">⬡ PROC</span>
        <span class="bg-task-prompt">${escapeHtml(String(id))}</span>
        <span class="bg-task-status running">● running</span>
        <button class="bg-task-abort bg-proc-stop" title="Stop process">✕</button>
      </div>
      <pre class="bg-process-output"></pre>`;
    // Background TASKS had an abort button; background PROCESSES did not, even
    // though kill_process exists — a stray dev server started by start_process
    // could only be stopped by asking the model to do it.
    el.querySelector('.bg-proc-stop').addEventListener('click', () => {
      vscode.postMessage({ type: 'killBgProcess', id });
    });
    messagesEl.appendChild(el);
    if (welcomeEl) welcomeEl.style.display = 'none';
    refs = { el, outputEl: el.querySelector('.bg-process-output'), statusEl: el.querySelector('.bg-task-status') };
    bgProcessPanels.set(id, refs);
  }
  const text = document.createTextNode(chunk);
  refs.outputEl.appendChild(text);
  // Cap at 10k chars visible
  if (refs.outputEl.textContent.length > 10000) {
    refs.outputEl.textContent = refs.outputEl.textContent.slice(-10000);
  }
  scrollToBottom();
}

function markBgProcessDone(id, exitCode) {
  // Built on demand if the panel isn't there (a tab switch cleared it): the
  // exit status is the one thing you most need to see, and returning early
  // meant a process that finished while you were on another tab reported
  // nothing at all — or worse, reappeared as "running" on its next output.
  const refs = bgProcessPanels.get(id) || (appendBgProcessOutput(id, ''), bgProcessPanels.get(id));
  if (!refs) return;
  refs.statusEl.className = exitCode === 0 ? 'bg-task-status done' : 'bg-task-status error';
  refs.statusEl.textContent = exitCode === 0 ? `✓ exited (0)` : `✕ exited (${exitCode})`;
  refs.el.querySelector('.bg-proc-stop')?.remove();
  bgProcessPanels.delete(id);
}

// ── Run-project persistent card ───────────────────────────────────────────────

let runProjectCardEl = null;

function showRunProjectCard(projectName, command) {
  // Supersede ANY previous run-project card, live or already stopped. Only the
  // tracked (live) one used to be removed, and setRunProjectStopped had already
  // dropped that reference — so every stopped server left its card behind and
  // they piled up, one per run, for the life of the conversation.
  for (const old of messagesEl.querySelectorAll('.run-project-card')) old.remove();
  runProjectCardEl?.remove();

  const card = document.createElement('div');
  card.className = 'run-project-card';
  card.innerHTML = `
    <div class="rp-left">
      <div class="rp-wheel-wrap">${WHEEL_SVG}</div>
    </div>
    <div class="rp-body">
      <div class="rp-title">
        <span class="rp-name">${escapeHtml(projectName)}</span>
        <span class="rp-status">Starting…</span>
      </div>
      <div class="rp-command">${escapeHtml(command)}</div>
      <div class="rp-url" style="display:none"></div>
      <details class="rp-log-wrap">
        <summary class="rp-log-toggle">Show output</summary>
        <pre class="rp-log"></pre>
      </details>
    </div>
    <div class="rp-actions">
      <button class="rp-stop-btn" title="Stop server">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
        Stop
      </button>
    </div>`;

  card.querySelector('.rp-stop-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'stopRunProject' });
  });

  appendTurnCard(card);
  runProjectCardEl = card;
  if (welcomeEl) welcomeEl.style.display = 'none';
  scrollToBottom();
}

function setRunProjectReady(url) {
  if (!runProjectCardEl) return;
  const statusEl = runProjectCardEl.querySelector('.rp-status');
  const urlEl    = runProjectCardEl.querySelector('.rp-url');
  const wheelEl  = runProjectCardEl.querySelector('.rp-wheel-wrap');

  if (statusEl) { statusEl.textContent = 'Live'; statusEl.classList.add('ready'); }
  if (urlEl) {
    const safeUrl = /^https?:\/\//i.test(url) ? url : '';
    urlEl.style.display = '';
    urlEl.innerHTML =
      `<span class="rp-dot"></span>` +
      (safeUrl ? `<a class="rp-link" href="${escapeHtml(safeUrl)}" title="${escapeHtml(safeUrl)}">${escapeHtml(safeUrl)}</a>` : `<span class="rp-link">${escapeHtml(url)}</span>`) +
      `<button class="rp-open-btn" data-url="${escapeHtml(safeUrl || url)}">Open ↗</button>`;
    urlEl.querySelector('.rp-open-btn')?.addEventListener('click', (e) => {
      vscode.postMessage({ type: 'openUrl', url: e.currentTarget.dataset.url });
    });
  }
  if (wheelEl) wheelEl.classList.add('ready');
  scrollToBottom();
}

function appendRunProjectOutput(chunk) {
  if (!runProjectCardEl) return;
  const log = runProjectCardEl.querySelector('.rp-log');
  if (!log) return;
  const node = document.createTextNode(chunk);
  log.appendChild(node);
  if (log.textContent.length > 20000) log.textContent = log.textContent.slice(-20000);
}

function setRunProjectStopped(exitCode) {
  // Idempotent, and the card reference is KEPT: output can still arrive after
  // the process is reported dead (a final flush, a crash trace), and nulling
  // the reference here silently discarded exactly the lines that explain why
  // it stopped. showRunProjectCard is what clears the card, when a new server
  // supersedes it.
  if (!runProjectCardEl || runProjectCardEl.classList.contains('stopped')) return;
  const statusEl  = runProjectCardEl.querySelector('.rp-status');
  const wheelWrap = runProjectCardEl.querySelector('.rp-wheel-wrap');
  const stopBtn   = runProjectCardEl.querySelector('.rp-stop-btn');
  const urlEl     = runProjectCardEl.querySelector('.rp-url');
  const dotEl     = urlEl?.querySelector('.rp-dot');

  runProjectCardEl.classList.add('stopped');
  if (statusEl) { statusEl.textContent = exitCode === 0 ? 'Stopped' : `Crashed (${exitCode})`; statusEl.classList.remove('ready'); statusEl.classList.add(exitCode === 0 ? 'stopped' : 'crashed'); }
  if (wheelWrap) wheelWrap.innerHTML = `<span class="rp-stopped-icon">■</span>`;
  if (stopBtn)   stopBtn.remove();
  if (dotEl)     dotEl.classList.add('offline');
}

function autoResize() {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(220, promptInput.scrollHeight) + 'px';
}

// ── Slash commands ────────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { cmd: '/fix',             label: 'Fix',           icon: '🔧', desc: 'Fix bugs in the active file',              prompt: 'Find and fix all bugs in this file. Explain each fix.' },
  { cmd: '/explain',         label: 'Explain',       icon: '💡', desc: 'Explain what this code does',              prompt: 'Explain what this code does in clear terms. Cover the purpose, key logic, and any non-obvious parts.' },
  { cmd: '/review',          label: 'Review',        icon: '🔍', desc: 'Code review with suggestions',             prompt: 'Perform a thorough code review. Check for bugs, performance issues, security problems, and style improvements.' },
  { cmd: '/test',            label: 'Test',          icon: '✅', desc: 'Run tests and fix failures',               prompt: 'Run the test suite, show the results, and fix any failing tests.' },
  { cmd: '/generate-tests',  label: 'Gen Tests',     icon: '🧪', desc: 'Generate unit tests for this file',        prompt: 'Generate comprehensive unit tests for the active file. First read_file to see its full content. Cover the happy path, edge cases, and error paths. Use the existing test framework — check package.json and any existing test files first to match conventions.' },
  { cmd: '/optimize',        label: 'Optimize',      icon: '⚡', desc: 'Optimize code performance',               prompt: 'Analyze the active file for performance bottlenecks. First read_file to see its full content. Identify the most impactful issues (unnecessary re-renders, redundant I/O, O(n²) loops, etc.) and apply optimizations without changing observable behaviour. Explain each change.' },
  { cmd: '/security',        label: 'Security',      icon: '🔒', desc: 'Security audit this code',                 prompt: 'Perform a thorough security audit of this project. Use list_files then read_file on the relevant source files. Check for OWASP Top 10 issues: injection (SQL, command, XSS), broken authentication, insecure deserialization, security misconfiguration, sensitive data exposure, and access control flaws. For each issue found: quote the vulnerable line, explain the risk and attack vector, then show the corrected code.' },
  { cmd: '/commit',          label: 'Commit',        icon: '📝', desc: 'Generate a git commit message',            prompt: 'Generate a conventional commit message for the current staged changes.' },
  { cmd: '/pr',              label: 'PR',            icon: '🚀', desc: 'Generate a PR description',               prompt: 'Generate a pull request title and description for the changes in this branch compared to main.' },
  { cmd: '/pr-review',       label: 'PR Review',     icon: '👁',  desc: 'Review a pull request',                   prompt: '' },
  { cmd: '/refactor',        label: 'Refactor',      icon: '♻️', desc: 'Refactor for clarity and performance',    prompt: 'Refactor this code for better readability, maintainability, and performance. Keep behaviour identical.' },
  { cmd: '/docs',            label: 'Docs',          icon: '📖', desc: 'Add documentation and comments',          prompt: 'Add clear JSDoc/docstring comments to all public functions and classes in the active file. First read_file to see its current content. Keep comments concise, accurate, and focused on WHY not WHAT. Then apply the changes with apply_edit.' },
  { cmd: '/debug',           label: 'Debug',         icon: '🐛', desc: 'Help diagnose the current problem',        prompt: 'Help me debug this. Start by calling get_diagnostics on the active file, then read_file to see the code, then run_tests if a test suite exists. Identify the root cause and apply a fix.' },
  { cmd: '/search',          label: 'Web Search',    icon: '🌐', desc: 'Search the web for an answer',            prompt: 'Search the web for: ' },
  { cmd: '/run',             label: 'Run Project',   icon: '▶',  desc: 'Start this project locally in background', prompt: 'Detect and run this project using the run_project tool. Tell me the URL so I can open it.' },
  { cmd: '/bg',              label: 'Background',    icon: '⚙️', desc: 'Run a task in background (non-blocking)',  prompt: '/bg ' },
];

function getSlashState() {
  const val = promptInput.value;
  const pos = promptInput.selectionStart;
  const before = val.slice(0, pos);
  // Match a '/' at the start or after a newline, possibly followed by letters
  const m = before.match(/(^|\n)(\/\w*)$/);
  if (!m) return null;
  return { query: m[2], index: before.lastIndexOf(m[2]), end: pos };
}

function showSlashDropdown(query) {
  let dropdown = document.getElementById('slashDropdown');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = 'slashDropdown';
    dropdown.className = 'slash-dropdown';
    dropdown.setAttribute('role', 'listbox');
    document.querySelector('.input-area')?.appendChild(dropdown);
  }
  const q = query.slice(1).toLowerCase();
  const matches = SLASH_COMMANDS.filter(c => c.cmd.slice(1).startsWith(q));
  if (matches.length === 0) { hideSlashDropdown(); return; }
  dropdown.innerHTML = matches.map((c, i) =>
    `<div class="slash-item" role="option" aria-selected="false" data-idx="${i}" data-cmd="${c.cmd}">
      <span class="slash-icon">${c.icon}</span>
      <span class="slash-label">${c.label}</span>
      <span class="slash-desc">${c.desc}</span>
    </div>`
  ).join('');
  dropdown.querySelectorAll('.slash-item').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const cmd = SLASH_COMMANDS.find(c => c.cmd === item.dataset.cmd);
      if (cmd) applySlashCommand(cmd);
    });
  });
  dropdown.style.display = 'block';
  slashDropdownVisible = true;
}

function hideSlashDropdown() {
  const d = document.getElementById('slashDropdown');
  if (d) d.style.display = 'none';
  slashDropdownVisible = false;
}

function applySlashCommand(cmd) {
  hideSlashDropdown();
  // Special commands that trigger extension actions rather than setting prompt text.
  if (cmd.cmd === '/pr-review') {
    vscode.postMessage({ type: 'reviewPR' });
    const state = getSlashState();
    if (state) promptInput.value = promptInput.value.slice(0, state.index) + promptInput.value.slice(state.end);
    promptInput.focus(); autoResize(); updateSendButton();
    return;
  }
  const state = getSlashState();
  if (!state) { promptInput.value = cmd.prompt; }
  else {
    const val = promptInput.value;
    promptInput.value = val.slice(0, state.index) + cmd.prompt + val.slice(state.end);
  }
  promptInput.focus();
  autoResize();
  updateSendButton();
}

function handleSlashCommand() {
  const state = getSlashState();
  if (state) showSlashDropdown(state.query);
  else hideSlashDropdown();
}

// ── Image paste previews ──────────────────────────────────────────────────────

function renderImagePreviews() {
  let previewsEl = document.getElementById('imagePreviewsRow');
  if (!previewsEl) {
    previewsEl = document.createElement('div');
    previewsEl.id = 'imagePreviewsRow';
    previewsEl.className = 'image-previews-row';
    fileChips?.parentNode?.insertBefore(previewsEl, fileChips);
  }
  previewsEl.innerHTML = '';
  pastedImages.forEach((img, i) => {
    const chip = document.createElement('div');
    chip.className = 'image-preview-chip';

    const thumb = document.createElement('img');
    thumb.src = img.dataUrl;
    thumb.className = 'image-thumb';
    thumb.title = img.name || `Pasted image ${i + 1}`;
    // Measure dimensions once loaded and show label
    const label = document.createElement('div');
    label.className = 'image-chip-label';
    const displayName = img.name || `image ${i + 1}`;
    label.textContent = displayName;
    thumb.addEventListener('load', () => {
      label.textContent = `${displayName} ${thumb.naturalWidth}×${thumb.naturalHeight}`;
    });
    // Click thumbnail to open lightbox
    thumb.addEventListener('click', () => openLightbox(img.dataUrl));
    thumb.style.cursor = 'zoom-in';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'image-chip-remove';
    removeBtn.dataset.idx = String(i);
    removeBtn.title = 'Remove';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      pastedImages.splice(i, 1);
      renderImagePreviews();
    });

    chip.appendChild(thumb);
    chip.appendChild(label);
    chip.appendChild(removeBtn);
    previewsEl.appendChild(chip);
  });
  previewsEl.style.display = pastedImages.length ? 'flex' : 'none';
}

// ── Attached text/code file chips ─────────────────────────────────────────────
function renderAttachedTextChips() {
  let el = document.getElementById('attachedTextChips');
  if (!el) {
    el = document.createElement('div');
    el.id = 'attachedTextChips';
    el.className = 'attached-text-chips';
    const previewsRow = document.getElementById('imagePreviewsRow');
    const anchor = previewsRow || fileChips;
    anchor?.parentNode?.insertBefore(el, anchor);
  }
  el.innerHTML = '';
  attachedTexts.forEach((f, i) => {
    const chip = document.createElement('div');
    chip.className = 'text-attach-chip';
    const ext = f.name.split('.').pop().slice(0, 4).toUpperCase();
    const badge = document.createElement('span');
    badge.className = 'text-chip-ext';
    badge.textContent = ext || 'TXT';
    const name = document.createElement('span');
    name.className = 'text-chip-name';
    name.textContent = f.name;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'text-chip-remove';
    rm.title = 'Remove';
    rm.textContent = '✕';
    rm.addEventListener('click', () => { attachedTexts.splice(i, 1); renderAttachedTextChips(); });
    chip.appendChild(badge);
    chip.appendChild(name);
    chip.appendChild(rm);
    el.appendChild(chip);
  });
  el.style.display = attachedTexts.length ? 'flex' : 'none';
}

// ── @mention autocomplete ─────────────────────────────────────────────────────

function getAtMentionState() {
  const val = promptInput.value;
  const cursor = promptInput.selectionStart;
  const before = val.slice(0, cursor);
  const atIdx = before.lastIndexOf('@');
  if (atIdx === -1) return null;
  // Only trigger when @ is at start of word (after space, newline, or start of text).
  if (atIdx > 0 && !/[\s,]/.test(before[atIdx - 1])) return null;
  return { query: before.slice(atIdx + 1).toLowerCase(), atIdx };
}

function handleAtMention() {
  const state = getAtMentionState();
  if (!state) { hideAtDropdown(); return; }

  const { query } = state;

  // @#query → workspace symbol search (functions, classes, variables).
  if (query.startsWith('#')) {
    vscode.postMessage({ type: 'getWorkspaceSymbols', query: query.slice(1) });
    return;
  }

  if (cachedWorkspaceFiles.length === 0) {
    vscode.postMessage({ type: 'getWorkspaceFiles' });
    return;
  }

  const matches = cachedWorkspaceFiles
    .filter(f => {
      const name = f.replace(/^.*[\\/]/, '').toLowerCase();
      return name.includes(query) || f.toLowerCase().includes(query);
    })
    .slice(0, 8);

  if (matches.length === 0) { hideAtDropdown(); return; }
  renderAtDropdown(matches, state);
}

function renderAtDropdown(files, state) {
  let dropdown = document.querySelector('#atDropdown');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = 'atDropdown';
    dropdown.className = 'at-dropdown';
    dropdown.setAttribute('role', 'listbox');
    document.querySelector('.composer-wrap')?.appendChild(dropdown);
  }

  dropdown.innerHTML = '';
  for (const file of files) {
    const fname = file.replace(/^.*[\\/]/, '');
    const fdir  = file.slice(0, file.length - fname.length);
    const item = document.createElement('div');
    item.className = 'at-dropdown-item';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', 'false');
    item.innerHTML = `<span class="at-file-name">${escapeHtml(fname)}</span><span class="at-file-dir">${escapeHtml(fdir)}</span>`;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent textarea blur
      const val = promptInput.value;
      const cursor = promptInput.selectionStart;
      const before = val.slice(0, cursor);
      const after  = val.slice(cursor);
      const newBefore = before.slice(0, state.atIdx);
      promptInput.value = newBefore + after;
      promptInput.selectionStart = promptInput.selectionEnd = newBefore.length;
      hideAtDropdown();
      if (!attachedFiles.includes(file)) {
        attachedFiles.push(file);
        renderFileChips();
        updateAddButton();
      }
    });
    dropdown.appendChild(item);
  }
  dropdown.style.display = 'block';
}

function hideAtDropdown() {
  const dropdown = document.querySelector('#atDropdown');
  if (dropdown) dropdown.style.display = 'none';
}

function renderSymbolDropdown(symbols) {
  const state = getAtMentionState();
  if (!state || !symbols.length) { hideAtDropdown(); return; }
  let dropdown = document.querySelector('#atDropdown');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = 'atDropdown';
    dropdown.className = 'at-dropdown';
    dropdown.setAttribute('role', 'listbox');
    document.querySelector('.composer-wrap')?.appendChild(dropdown);
  }
  dropdown.innerHTML = '';
  for (const sym of symbols) {
    const item = document.createElement('div');
    item.className = 'at-dropdown-item';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', 'false');
    item.innerHTML = `<span class="at-symbol-kind">${sym.kind}</span><span class="at-file-name">${escapeHtml(sym.name)}</span><span class="at-file-dir">${escapeHtml(sym.file)}:${sym.line}</span>`;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const val = promptInput.value;
      const cursor = promptInput.selectionStart;
      const before = val.slice(0, cursor);
      const after = val.slice(cursor);
      const newBefore = before.slice(0, state.atIdx);
      promptInput.value = newBefore + after;
      promptInput.selectionStart = promptInput.selectionEnd = newBefore.length;
      hideAtDropdown();
      if (!attachedFiles.includes(sym.fsPath)) {
        attachedFiles.push(sym.fsPath);
        renderFileChips();
        updateAddButton();
      }
    });
    dropdown.appendChild(item);
  }
  dropdown.style.display = 'block';
}

function sendPrompt() {
  const prompt = promptInput.value.trim();
  if (!prompt && pastedImages.length === 0) return;

  // Background task: /bg <task> — non-blocking, runs in parallel with main chat.
  if (prompt.startsWith('/bg ')) {
    const taskPrompt = prompt.slice(4).trim();
    if (!taskPrompt) return;
    promptInput.value = '';
    promptInput.style.height = 'auto';
    updateSendButton();
    vscode.postMessage({ type: 'startBackgroundTask', prompt: taskPrompt });
    return;
  }

  // Build the final prompt — prepend attached text-file contents as code blocks.
  let finalPrompt = prompt;
  if (attachedTexts.length > 0) {
    const blocks = attachedTexts.map(f => {
      const ext = f.name.split('.').pop();
      const truncated = f.content.length > 12000;
      return `[Attached: ${f.name}${truncated ? ' — TRUNCATED to first 12,000 of ' + f.content.length + ' characters' : ''}]\n\`\`\`${ext}\n${f.content.slice(0, 12000)}\n\`\`\``;
    }).join('\n\n');
    finalPrompt = blocks + '\n\n' + prompt;
  }

  addMessage('user', prompt, attachedTexts.map(f => f.name), pastedImages.length);
  promptInput.value = '';
  promptInput.style.height = 'auto';
  updateSendButton();

  // When busy, the backend queues the message and sends back a 'queued' event.
  vscode.postMessage({
    type: 'ask',
    prompt: finalPrompt,
    includeContext: includeContext.checked,
    model: modelSelect.value,
    activeFile: activeFilePath,
    attachedFiles,
    images: pastedImages.map(i => i.dataUrl)
  });
  pastedImages = [];
  attachedTexts = [];
  renderImagePreviews();
  renderAttachedTextChips();
}

// Recovery path when the extension host truly went silent (crash / kill).
function busyRecovery() {
  busyWatchdog = null;
  flushAssistantText();
  activeAssistantMessage = null;
  activeAssistantBubble = null;
  activeAssistantContent = '';
  setBusy(false);
  collapseToolProgress();
  addMessage('error', 'Navy stopped responding. If this keeps happening try Ctrl+Shift+P → "Developer: Reload Window".');
}

// (Re)arm the dead-backend watchdog. Called on EVERY message from the extension
// while busy — the extension heartbeats every 30s during a turn, so this only
// fires after 4 minutes of true silence, never during long-running work or
// while an approval sits waiting for the user. Rearming is throttled to once
// per 5s: streaming delivers dozens of chunks a second and per-chunk timer
// churn is pure waste against a 4-minute deadline.
let _watchdogArmedAt = 0;
function armBusyWatchdog(force) {
  const now = Date.now();
  if (!force && busyWatchdog && now - _watchdogArmedAt < 5000) return;
  _watchdogArmedAt = now;
  if (busyWatchdog) { clearTimeout(busyWatchdog); busyWatchdog = null; }
  if (isBusy) busyWatchdog = setTimeout(busyRecovery, 4 * 60 * 1000);
}

function setBusy(busy) {
  if (busyWatchdog) { clearTimeout(busyWatchdog); busyWatchdog = null; }
  isBusy = busy;
  const sendIcon = document.querySelector('#sendIcon');
  const stopIcon = document.querySelector('#stopIcon');
  // SVGElement has NO `hidden` property — assigning it creates a dead expando.
  // Toggle the ATTRIBUTE itself: it's what the svg[hidden]{display:none} CSS
  // matches, including the initial hidden attr baked into the HTML.
  if (sendIcon) { if (busy) sendIcon.setAttribute('hidden', ''); else sendIcon.removeAttribute('hidden'); }
  if (stopIcon) { if (busy) stopIcon.removeAttribute('hidden'); else stopIcon.setAttribute('hidden', ''); }
  sendButton.classList.toggle('stop-mode', busy);
  sendButton.setAttribute('aria-label', busy ? 'Stop' : 'Send message');
  sendButton.title = busy ? 'Stop' : 'Send';
  if (stopButton) stopButton.style.display = busy ? '' : 'none';
  if (clearButton) clearButton.style.display = busy ? 'none' : '';
  includeContext.disabled = busy;
  document.querySelector('.app')?.classList.toggle('is-thinking', busy);
  updateAddButton();
  updateSendButton();
  if (statusText) statusText.textContent = busy ? 'Working…' : '';
  if (busy) {
    armBusyWatchdog(true); // fresh turn — always start a clean 4-minute window
  } else {
    if (queuedBadge) { queuedBadge.style.display = 'none'; queuedBadge.textContent = ''; }
    promptInput.focus();
  }
}

function updateWelcome() {
  // Count cards too — a tools-only turn has no .message article, and the welcome
  // screen must not reappear in the middle of an active conversation.
  const hasMessages = messagesEl.querySelectorAll('.message, .diff-card, .command-card, .term-card, .run-project-card, .activity-log').length > 0;
  welcomeEl.classList.toggle('hidden', hasMessages);
}

// How many messages a restore renders up front. A long chat previously built
// every message into the DOM at once, and the chat has no virtualisation — so
// reopening a project with hundreds of turns paid the full parse and layout
// cost before the panel became usable. The rest stay one click away.
const HISTORY_RENDER_LIMIT = 60;

function renderHistoryItem(item) {
  if (item.role === 'user') {
    // Attachment/image badges are part of what the question WAS — replayed
    // from the persisted message rather than dropped on restore.
    addMessage('user', item.text, item.attachments || [], item.images || 0);
  } else if (item.role === 'assistant') {
    addMessage('assistant', item.text);
    // Restore the change summary for this turn (live footer isn't persisted).
    if (item.meta) {
      const bits = [];
      if (item.meta.files?.length)   bits.push('changed ' + item.meta.files.join(', '));
      if (item.meta.deleted?.length) bits.push('deleted ' + item.meta.deleted.join(', '));
      if (item.meta.commands)        bits.push(item.meta.commands + ' command' + (item.meta.commands > 1 ? 's' : '') + ' run');
      if (bits.length) addSystemMessage('This turn: ' + bits.join(' · '));
    }
  }
}

function renderHistory(history) {
  messagesEl.innerHTML = '';
  messagesEl.appendChild(welcomeEl); // innerHTML='' detaches it — keep it in the DOM
  if (!Array.isArray(history) || !history.length) { updateWelcome(); return; }
  welcomeEl.classList.add('hidden');
  // Restored sessions only contain text — tool cards and diffs are not replayed.
  const note = document.createElement('div');
  note.className = 'restore-note';
  note.textContent = 'Session restored — earlier tool activity and diffs are not shown.';
  messagesEl.appendChild(note);

  const renderable = history.filter(i => i.text?.trim()); // skip empty tool-only iterations
  const hidden = Math.max(0, renderable.length - HISTORY_RENDER_LIMIT);
  if (hidden) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'history-more-btn';
    more.textContent = `Show ${hidden} earlier message${hidden === 1 ? '' : 's'} ↑`;
    more.addEventListener('click', () => {
      // renderHistoryItem appends to the end, so the earlier messages are
      // rendered there and then moved, as a block, to just above this button —
      // which sits above the recent ones. Order within the block is preserved
      // (a fragment keeps insertion order), so the transcript still reads
      // oldest-first rather than coming back reversed or interleaved.
      const mark = messagesEl.childNodes.length;
      for (const item of renderable.slice(0, hidden)) renderHistoryItem(item);
      const frag = document.createDocumentFragment();
      for (const node of [...messagesEl.childNodes].slice(mark)) frag.appendChild(node);
      messagesEl.insertBefore(frag, more);
      more.remove();
    });
    messagesEl.appendChild(more);
  }
  for (const item of renderable.slice(hidden)) renderHistoryItem(item);
}

function populateProjects(roots, current, catalog) {
  if (!projectSelect) return;
  projectSelect.innerHTML = '';

  if (!roots || roots.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No workspace';
    projectSelect.appendChild(option);
  } else {
    // A blank "New Chat" tab (current === '') has no project bound yet — show
    // an explicit placeholder instead of letting the browser silently
    // default to pre-selecting the first real folder in the list below.
    if (!current) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '(select a project)';
      projectSelect.appendChild(placeholder);
    }
    for (const root of roots) {
      const option = document.createElement('option');
      option.value = root;
      option.textContent = root.replace(/^.*[\/]/, '');
      option.title = root;
      if (root === current) option.selected = true;
      projectSelect.appendChild(option);
    }
  }

  // Other projects Navy remembers (the global ~/.navy/projects.json catalog)
  // that aren't part of THIS window's workspace right now — picking one
  // opens the same "open here or add to workspace" choice a brand-new
  // folder pick gets, rather than switching directly (see the change
  // handler above and openCatalogProject on the extension side).
  if (catalog && catalog.length) {
    const group = document.createElement('optgroup');
    group.label = 'Other projects';
    for (const proj of catalog) {
      const option = document.createElement('option');
      option.value = CATALOG_OPTION_PREFIX + proj.path;
      option.textContent = proj.name;
      option.title = proj.path;
      group.appendChild(option);
    }
    projectSelect.appendChild(group);
  }

  const addOption = document.createElement('option');
  addOption.value = '__add_folder__';
  addOption.textContent = '+ Open project...';
  projectSelect.appendChild(addOption);

  // If we just added a folder, re-select the current root
  if (current) {
    projectSelect.value = current;
  }
}

function renderApprovalQueue(approvals) {
  if (!approvalQueue) return;
  approvalQueue.innerHTML = '';
  if (approvals.length === 0) {
    approvalQueue.classList.add('empty');
    return;
  }
  approvalQueue.classList.remove('empty');
  const badge = document.createElement('span');
  badge.className = 'approval-badge';
  badge.textContent = approvals.length;
  badge.title = approvals.length + ' pending approval' + (approvals.length === 1 ? '' : 's');
  const list = document.createElement('div');
  list.className = 'approval-list';
  for (const a of approvals) {
    const item = document.createElement('div');
    item.className = 'approval-item';
    item.textContent = a.path.replace(/^.*[\/]/, '');
    item.title = a.path + ' — click to jump to its card';
    // Now that adding a diff card no longer hijacks the scroll position, this
    // queue is how you get back to a card you have scrolled past. Clicking an
    // entry has to actually take you there for that to hold.
    item.addEventListener('click', () => {
      const card = a.id
        ? [...messagesEl.querySelectorAll('.diff-card')].find(c => c.dataset.diffId === String(a.id))
        : null;
      if (card) {
        userScrolledUp = true; // an explicit jump, not a follow-the-stream scroll
        card.scrollIntoView({ block: 'center' });
      }
    });
    list.appendChild(item);
  }
  approvalQueue.appendChild(badge);
  approvalQueue.appendChild(list);
}

// True when a model list is dominated by "vendor/model" naming (OpenRouter's
// convention) — worth grouping into <optgroup>s by vendor. A minority of
// slash-containing names (e.g. one oddly-named model on Groq) isn't enough to
// group everything else, so this requires most of the list to match.
function shouldGroupByVendor(models) {
  if (models.length < 8) return false;
  const withSlash = models.filter(m => /^[\w.-]+\//.test(m)).length;
  return withSlash / models.length >= 0.7;
}

// Renders `models` into `select`, grouped into <optgroup>s by vendor prefix when
// the list looks like OpenRouter's "vendor/model" convention, flat otherwise.
// Shared by the initial populate and the filter-box's live re-render so grouping
// behavior never diverges between the two.
function renderModelOptions(select, models, selectedValue) {
  select.innerHTML = '';
  if (shouldGroupByVendor(models)) {
    const groups = new Map(); // vendor → [names]
    for (const name of models) {
      const m = name.match(/^([\w.-]+)\//);
      const vendor = m ? m[1] : '(other)';
      if (!groups.has(vendor)) groups.set(vendor, []);
      groups.get(vendor).push(name);
    }
    for (const [vendor, names] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const grp = document.createElement('optgroup');
      grp.label = vendor;
      for (const name of names) {
        const o = document.createElement('option');
        o.value = name; o.textContent = name;
        if (name === selectedValue) o.selected = true;
        grp.appendChild(o);
      }
      select.appendChild(grp);
    }
  } else {
    for (const name of models) {
      const o = document.createElement('option');
      o.value = name; o.textContent = name;
      if (name === selectedValue) o.selected = true;
      select.appendChild(o);
    }
  }
}

function populateModels(models, current, error) {
  const previous = modelSelect.value || current;

  if (error || models.length === 0) {
    modelSelect.innerHTML = '';
    const option = document.createElement('option');
    option.value = current || '';
    option.textContent = current || 'No models';
    if (error) {
      option.title = error;
      setStatus('No models: ' + error);
    } else {
      setStatus('No models pulled');
    }
    modelSelect.appendChild(option);
    return;
  }

  setStatus(models.length + ' models');
  // Prefer `current` if it's actually in the list; otherwise fall back to
  // whatever the select previously held (`previous`) — matches the original
  // "select current OR previous" intent with a single target value.
  const selectedValue = models.includes(current) ? current : (models.includes(previous) ? previous : current);
  renderModelOptions(modelSelect, models, selectedValue);

  updateModelFilter(models, current || previous);
}

// Big providers (OpenRouter lists 300+ models) make a bare <select> unusable —
// show a small type-to-filter box next to it once the list crosses a threshold.
let _allModels = [];
function updateModelFilter(models, current) {
  _allModels = models.slice();
  let input = document.getElementById('modelFilter');
  if (models.length <= 30) { if (input) input.style.display = 'none'; return; }
  if (!input) {
    input = document.createElement('input');
    input.id = 'modelFilter';
    input.type = 'text';
    input.className = 'model-filter';
    input.placeholder = 'filter…';
    input.setAttribute('aria-label', 'Filter models');
    modelSelect?.parentNode?.insertBefore(input, modelSelect);
    input.addEventListener('input', () => {
      const q = input.value.toLowerCase().trim();
      const filtered = q ? _allModels.filter(m => m.toLowerCase().includes(q)) : _allModels;
      const selected = modelSelect.value;
      renderModelOptions(modelSelect, filtered.length ? filtered : _allModels, selected);
    });
  }
  input.style.display = '';
}

function renderFileChips() {
  const existing = fileChips.querySelectorAll('.chip-file');
  for (const chip of existing) {
    chip.remove();
  }

  for (const file of attachedFiles) {
    const chip = document.createElement('span');
    chip.className = 'chip chip-file';
    chip.title = file;

    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = file.replace(/^.*[\\/]/, '');
    chip.appendChild(label);

    const remove = document.createElement('button');
    remove.className = 'chip-remove';
    remove.type = 'button';
    remove.textContent = '�';
    remove.title = 'Remove file';
    remove.addEventListener('click', () => {
      attachedFiles = attachedFiles.filter((f) => f !== file);
      renderFileChips();
      updateAddButton();
    });
    chip.appendChild(remove);

    fileChips.insertBefore(chip, addContextButton);
  }

  updateAddButton();
}

function createMessageHeader(role) {
  const header = document.createElement('div');
  header.className = 'message-header';

  const icon = document.createElement('span');
  icon.innerHTML = role === 'user' ? userIcon() : role === 'error' ? errorIcon() : anchorIcon();
  header.appendChild(icon);

  const label = document.createElement('span');
  label.textContent = role === 'user' ? 'You' : role === 'error' ? 'Error' : 'Navy';
  header.appendChild(label);

  return header;
}

function addMessage(role, text, attachedFileNames = [], imageCount = 0) {
  const article = document.createElement('article');
  article.className = `message ${role}`;

  // User messages have no header — right-aligned bubble speaks for itself
  if (role !== 'user') {
    article.appendChild(createMessageHeader(role));
  }

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  if (role === 'user') {
    const lines = text.split('\n');
    const COLLAPSE_LINES = 10;
    const COLLAPSE_CHARS = 600;
    const isLong = lines.length > COLLAPSE_LINES || text.length > COLLAPSE_CHARS;

    if (isLong) {
      const previewLines = lines.slice(0, 8);
      const restLines = lines.slice(8);
      // Preview text
      previewLines.forEach((line, i) => {
        if (i > 0) bubble.appendChild(document.createElement('br'));
        bubble.appendChild(document.createTextNode(line));
      });
      // Hidden overflow
      const overflow = document.createElement('span');
      overflow.className = 'msg-overflow';
      overflow.hidden = true;
      restLines.forEach(line => {
        overflow.appendChild(document.createElement('br'));
        overflow.appendChild(document.createTextNode(line));
      });
      bubble.appendChild(overflow);
      // Expand / collapse toggle
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'msg-expand-btn';
      toggle.textContent = `Show ${restLines.length} more lines ↓`;
      toggle.addEventListener('click', () => {
        const collapsed = overflow.hidden;
        overflow.hidden = !collapsed;
        toggle.textContent = collapsed
          ? 'Show less ↑'
          : `Show ${restLines.length} more lines ↓`;
      });
      bubble.appendChild(document.createElement('br'));
      bubble.appendChild(toggle);
    } else {
      // Render in normal readable font, preserving line breaks safely
      lines.forEach((line, i) => {
        if (i > 0) bubble.appendChild(document.createElement('br'));
        bubble.appendChild(document.createTextNode(line));
      });
    }

    // Attachment badges shown inside the bubble
    if (attachedFileNames.length > 0 || imageCount > 0) {
      const badges = document.createElement('div');
      badges.className = 'msg-attachments';
      for (const name of attachedFileNames) {
        const b = document.createElement('span');
        b.className = 'msg-attach-badge';
        b.textContent = '📎 ' + name;
        badges.appendChild(b);
      }
      if (imageCount > 0) {
        const b = document.createElement('span');
        b.className = 'msg-attach-badge';
        b.textContent = `🖼 ${imageCount} image${imageCount > 1 ? 's' : ''}`;
        badges.appendChild(b);
      }
      bubble.appendChild(badges);
    }
  } else if (role === 'error') {
    const pre = document.createElement('pre');
    pre.textContent = text;
    bubble.appendChild(pre);
  } else {
    bubble.dataset.rawMd = text;
    bubble.innerHTML = renderMarkdown(text);
    attachCodeBlockActions(bubble);
  }

  // Hover copy button for assistant messages — copies the whole reply as markdown.
  if (role === 'assistant') {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'msg-copy-btn';
    copyBtn.title = 'Copy message';
    copyBtn.setAttribute('aria-label', 'Copy message');
    copyBtn.textContent = '⧉';
    copyBtn.addEventListener('click', () => {
      // Prefer the article: a reply split across several bubbles by tool activity
      // records its full markdown there, so copy still yields the whole reply.
      vscode.postMessage({ type: 'copy', text: copyableReply(article.dataset.rawMd || bubble.dataset.rawMd || article.textContent || '') });
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '⧉'; }, 1200);
    });
    article.appendChild(copyBtn);
  }

  article.appendChild(bubble);
  messagesEl.appendChild(article);
  scrollToBottom();
  return article;
}

// ── Plan checklist card ────────────────────────────────────────────────────
// Parses a "**Plan:**" section (rule 13 in TOOL_PROMPT asks the model for one
// on any 3+ tool-call task) into an array of step strings. Pure/testable.
// Stops at the first blank line after the list, or at end of text.
function parsePlanSteps(text) {
  const m = text.match(/\*\*Plan:\*\*[ \t]*\n([\s\S]*)/i) || text.match(/(?:^|\n)Plan:[ \t]*\n([\s\S]*)/i);
  if (!m) return [];
  const steps = [];
  for (const line of m[1].split('\n')) {
    const sm = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (sm) steps.push(sm[1].trim());
    else if (steps.length && line.trim() === '') break;
    else if (steps.length && !sm) break; // non-numbered line after the list ends it
  }
  return steps;
}

let planCardEl = null;
let planStepCount = 0;

// Builds the checklist once per turn, as soon as a parseable plan appears in the
// streamed text. Best-effort/visual only — a wrong step count or a model that
// never states a plan just means no card appears; nothing else depends on it.
function maybeBuildPlanCard() {
  if (planCardEl || !activeAssistantContent) return;
  const steps = parsePlanSteps(activeAssistantContent);
  if (!steps.length) return;
  planStepCount = steps.length;
  const card = document.createElement('div');
  card.className = 'plan-card';
  const header = document.createElement('div');
  header.className = 'plan-card-header';
  header.textContent = `Plan — ${steps.length} step${steps.length !== 1 ? 's' : ''}`;
  card.appendChild(header);
  const list = document.createElement('ol');
  list.className = 'plan-card-list';
  for (const s of steps) {
    const li = document.createElement('li');
    li.className = 'plan-step pending';
    const icon = document.createElement('span');
    icon.className = 'plan-step-icon';
    const label = document.createElement('span');
    label.className = 'plan-step-text';
    label.textContent = s;
    li.appendChild(icon);
    li.appendChild(label);
    list.appendChild(li);
  }
  card.appendChild(list);
  (activeAssistantMessage || messagesEl).appendChild(card);
  planCardEl = card;
  scrollToBottom();
}

// activeIdx: 0-based step currently "in progress" (best-effort — Navy's tool
// iterations don't map 1:1 to plan steps, so this is an approximate indicator,
// not a guarantee). allDone forces every step to the done state.
function updatePlanProgress(activeIdx, allDone) {
  if (!planCardEl) return;
  const items = planCardEl.querySelectorAll('.plan-step');
  items.forEach((li, i) => {
    li.classList.remove('pending', 'active', 'done');
    if (allDone || i < activeIdx) li.classList.add('done');
    else if (i === activeIdx) li.classList.add('active');
    else li.classList.add('pending');
  });
}

function resetPlanCard() {
  planCardEl = null;
  planStepCount = 0;
}

// Resets everything tied to the currently-displayed conversation THREAD —
// shared by the 'cleared' message handler and by switching session tabs
// (soft-clearing before the target tab's sessionLoaded/restore repopulates
// it). Deliberately leaves composer/draft state (attachedFiles, pastedImages,
// the prompt textarea) untouched — that's what the user is about to send,
// not part of which project's history is on screen, and losing it on an
// accidental tab click would be a bad surprise.
function resetThreadDisplay() {
  activeAssistantMessage = null;
  activeAssistantBubble = null;
  activeAssistantContent = '';
  allActivityLogEls = [];
  currentActivityRowEl = null;
  activityRowsById.clear();
  activeTermCard = null;
  termCardsById.clear();
  lastAssistantMessage = null;
  // A run-project server or background task/process can still be running
  // server-side after Clear/a tab switch (those aren't reset here). Drop the
  // now-stale DOM references so their next update doesn't write into a
  // detached node — bgTaskEls/bgProcessPanels lazily recreate their card on
  // the next message; the extension host re-sends runProjectStart right
  // after 'cleared' if a project is still running, since that card has no
  // such lazy-recreate path.
  runProjectCardEl = null;
  bgTaskEls.clear();
  bgProcessPanels.clear();
  if (tokenCounterEl) { tokenCounterEl.textContent = ''; tokenCounterEl.classList.remove('visible'); }
  if (contextBarFill) { contextBarFill.style.width = '0%'; contextBarFill.className = 'context-bar-fill'; }
  resetPlanCard();
  messagesEl.innerHTML = '';
  messagesEl.appendChild(welcomeEl); // innerHTML='' detaches it — re-attach or it never shows again
  welcomeEl.classList.remove('hidden');
}

// Latest session list, kept so switchToSessionTab can read a target tab's
// busy flag immediately at click time rather than waiting for another
// message — see the comment there for why that timing matters.
let lastSessionSummaries = [];

// Renders the tab strip from the extension's session list. Rebuilt from
// scratch on every update (the list is small — a handful of open projects at
// most — so there's no need for incremental diffing here).
function renderSessionTabs(sessions) {
  lastSessionSummaries = sessions;
  if (!sessionTabsEl) return;
  sessionTabsEl.innerHTML = '';
  const multiple = sessions.length > 1;
  for (const s of sessions) {
    const tab = document.createElement('div');
    tab.className = 'session-tab' + (s.id === activeSessionId ? ' active' : '') + (s.busy ? ' busy' : '');
    tab.setAttribute('role', 'tab');
    // s.id is an opaque generated identifier, not meaningful to show. Every
    // visible tab already belongs to the SAME project (shown once, in the
    // dropdown above) — so the tooltip is just the chat's own name.
    tab.title = s.name;
    tab.addEventListener('click', () => switchToSessionTab(s.id));

    const label = document.createElement('span');
    label.className = 'session-tab-label';
    label.textContent = s.name;
    tab.appendChild(label);

    if (s.busy) {
      const spinner = document.createElement('span');
      spinner.className = 'session-tab-spinner';
      spinner.title = 'A turn is running in this tab';
      tab.appendChild(spinner);
    }

    if (multiple) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'session-tab-close';
      closeBtn.textContent = '✕';
      closeBtn.title = 'Close tab';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // must not also trigger the tab's own switch-click
        vscode.postMessage({ type: 'closeSessionTab', sessionId: s.id });
      });
      tab.appendChild(closeBtn);
    }
    sessionTabsEl.appendChild(tab);
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'session-tab-add';
  addBtn.title = 'Start a new chat in this project';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSessionTab' }));
  sessionTabsEl.appendChild(addBtn);
}

// Single funnel for "the active tab changed" — every site that mutates
// activeSessionId calls this instead of setting the variable directly, so
// the accompanying side effects (soft-clearing the old tab's display,
// syncing busy state) can't be applied inconsistently between call sites
// the way three independent copies of "set it, then remember to also do X
// and Y" otherwise drift. `busy` is deliberately optional, not defaulted —
// whether a caller has a real busy value to sync (and whether it should)
// genuinely differs per site (see switchToSessionTab's own comment on why
// double-firing setBusy from two different paths is itself a bug to avoid),
// so omitting it is a real, intentional per-caller choice, not an oversight.
function adoptActiveSession(id, { busy } = {}) {
  activeSessionId = id;
  resetThreadDisplay();
  if (busy !== undefined) setBusy(busy);
}

// Switches the displayed tab. Adopts the target session id IMMEDIATELY, before
// the extension even responds — any message still in flight tagged with the
// OLD session is then correctly treated as background from this instant on
// (see the multi-session gate at the top of the message listener). Soft-clears
// the visible thread since the incoming sessionLoaded/restore for the new tab
// is about to fully repopulate it — this just avoids a flash of the old tab's
// content in between. Busy state is synced from the tab strip's OWN data
// (already known, from the last sessionList) right here, rather than waiting
// for a fresh sessionList to arrive — the sessionList handler only re-syncs
// busy state when the active id changes WITHOUT this function having run
// (e.g. the tab you were viewing got closed out from under you), so relying
// on it here too would double-fire setBusy on every ordinary click.
function switchToSessionTab(sessionId) {
  if (!sessionId || sessionId === activeSessionId) return;
  const target = lastSessionSummaries.find(s => s.id === sessionId);
  adoptActiveSession(sessionId, { busy: Boolean(target?.busy) });
  vscode.postMessage({ type: 'switchSessionTab', sessionId });
}

// Streaming render state. Formatted markdown is rendered live, but the parse +
// DOM write is throttled to at most once per MD_RENDER_THROTTLE_MS regardless
// of how many chunks arrive in between — a growing response otherwise means
// the plan-card check and full markdown re-parse both re-run on EVERY token,
// which gets slower as the response grows (O(n) work times up to hundreds of
// chunks). A 150ms cap bounds the total work to a small, constant number of
// re-parses per second no matter how fast the provider streams, while still
// looking live to a human reader.
let _mdRenderTimer = null;
let _lastMdRenderAt = 0;
let _mdRenderCost = 0;      // ms the last live render actually took
let _streamPre = null;      // cheap plain-text element used past the size ceiling
let _perfWarned = false;    // slow-render reported once per turn, not per tick
let _segmentStart = 0;      // index in activeAssistantContent where this bubble starts
let _needNewBubble = false; // tool activity happened — next text opens a new bubble
let _primaryBubble = null;  // first bubble of the turn; carries rawMd for the copy button
const MD_RENDER_THROTTLE_MS = 150;
const MD_RENDER_MAX_MS = 2000;
// Past this much accumulated text, a full re-parse costs more than live
// formatting is worth: rendering ~60 KB of reply produces ~130 KB of HTML, and
// re-parsing/re-laying-out that several times a second is what locked the panel
// up. Beyond the ceiling we stream plain text (cheap, no HTML parse, no layout
// thrash) and the complete markdown render still happens once at the end.
const LIVE_MD_MAX_CHARS = 20000;

// The throttle adapts to what rendering actually costs on THIS machine and at
// THIS reply length, so the render loop can never occupy more than ~25% of the
// time. A fixed 150ms interval was fine early in a reply and hopeless later,
// when a single render exceeded the interval and renders queued back-to-back.
function nextRenderDelay() {
  return Math.min(MD_RENDER_MAX_MS, Math.max(MD_RENDER_THROTTLE_MS, _mdRenderCost * 4));
}

// An assistant turn interleaves prose and tool activity, but every bubble and
// every activity log is appended to the same message — so all text collected in
// ONE bubble that sits above ALL the tool cards. A turn that said "I'll read the
// file", ran twenty tools, then wrote its summary rendered as: intro, summary,
// then the work that happened between them. Read top-to-bottom the summary looked
// missing entirely, because nothing follows the tool activity.
//
// Fix: when tool activity begins after the model has already written something,
// seal that bubble. The next text starts a fresh bubble, which lands after the
// activity log — so the transcript reads in the order things actually happened.
function sealCurrentBubble() {
  if (!activeAssistantBubble || _needNewBubble) return;
  const segment = activeAssistantContent.slice(_segmentStart);
  if (segment.trim()) {
    const html = renderMarkdown(segment);
    activeAssistantBubble.innerHTML = html;
    if (html) attachCodeBlockActions(activeAssistantBubble);
  }
  // Marked even when this bubble is still EMPTY. Whatever the caller is about
  // to append lands after it, so text arriving later has to start a new bubble
  // BELOW that — otherwise it flows back into this one, which sits above, and
  // a turn whose very first action was a tool call renders its explanation
  // above the work it is explaining. Returning early on an empty segment (the
  // previous behaviour) is exactly how that happened. A leftover empty bubble
  // is invisible: see `.message-bubble:empty` in styles.css.
  _needNewBubble = true;
  _streamPre = null;
}

function appendAssistantText(text) {
  if (!activeAssistantMessage) {
    activeAssistantMessage = addMessage('assistant', '');
    activeAssistantBubble = activeAssistantMessage.querySelector('.message-bubble');
    _primaryBubble = activeAssistantBubble;
    activeAssistantContent = '';
    _segmentStart = 0;
    _needNewBubble = false;
    _lastMdRenderAt = 0;
    _mdRenderCost = 0;
    _streamPre = null;
    _perfWarned = false;
  }

  // First text after tool activity — open a new bubble below it.
  if (_needNewBubble && text.trim()) {
    const b = document.createElement('div');
    b.className = 'message-bubble';
    activeAssistantMessage.appendChild(b);
    activeAssistantBubble = b;
    _segmentStart = activeAssistantContent.length;   // before this text is added
    _needNewBubble = false;
    _streamPre = null;
    // If MORE tool activity starts after this, it needs a fresh log of its
    // own (positioned after THIS bubble) rather than resuming the old one —
    // see getOrCreateActivityLog/allActivityLogEls.
    _needNewActivityLog = true;
  }

  activeAssistantContent += text;

  const now = Date.now();
  const wait = nextRenderDelay();
  if (now - _lastMdRenderAt >= wait) {
    if (_mdRenderTimer) { clearTimeout(_mdRenderTimer); _mdRenderTimer = null; }
    renderStreamingContent();
  } else if (!_mdRenderTimer) {
    _mdRenderTimer = setTimeout(() => { _mdRenderTimer = null; renderStreamingContent(); }, wait - (now - _lastMdRenderAt));
  }
}

function renderStreamingContent() {
  const _renderStart = Date.now();
  _lastMdRenderAt = _renderStart;
  if (!activeAssistantBubble) return;
  maybeBuildPlanCard();

  // NEVER show raw <think> reasoning while streaming: drop closed blocks and,
  // if a block is still open, hide its contents behind a live indicator.
  // The final render collapses finished reasoning into the 💭 dropdown.
  // Only this bubble's slice — text written before the last tool run already
  // lives in its own sealed bubble above the activity log.
  let display = activeAssistantContent.slice(_segmentStart)
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  let thinkingLive = false;
  const openIdx = display.search(/<think(?:ing)?>/i);
  if (openIdx !== -1) {
    display = display.slice(0, openIdx);
    thinkingLive = true;
    if (statusText) statusText.textContent = 'Reasoning…';
  } else if (statusText && statusText.textContent === 'Reasoning…') {
    // Thinking closed and the answer is streaming — don't leave the stale label up.
    statusText.textContent = 'Working…';
  }
  display = display.trim();

  // A response that's a raw tool-call JSON (small models that print the call as
  // text) is executed by the agent, not shown — suppress it while streaming too so
  // it doesn't flash as a JSON block before the tool card replaces it.
  if (/^\{\s*"(?:name|tool|function)"\s*:/.test(display)) {
    if (statusText) statusText.textContent = 'Working…';
    return;
  }

  // Models emit stray newline-only chunks between tool calls — don't render
  // anything for pure whitespace or it grows into a tall blank block in the chat.
  if (!display && !thinkingLive) return;

  if (display.length > LIVE_MD_MAX_CHARS) {
    // Long reply: stream as plain text. One text-node write, no HTML parse and
    // no layout of a large tree, so cost stays flat however long the reply gets.
    // flushAssistantText still renders the full markdown when the turn ends.
    if (!_streamPre || _streamPre.parentNode !== activeAssistantBubble) {
      activeAssistantBubble.innerHTML = '';
      _streamPre = document.createElement('pre');
      _streamPre.className = 'streaming-pre';
      activeAssistantBubble.appendChild(_streamPre);
    }
    _streamPre.textContent = display + (thinkingLive ? '\n\n💭 Reasoning…' : '');
  } else {
    // Formatted markdown, live — an in-progress fenced code block simply falls
    // back to plain text until its closing fence arrives, then reformats.
    _streamPre = null;
    activeAssistantBubble.innerHTML = renderMarkdown(display) + (thinkingLive ? '<div class="think-streaming">💭 Reasoning…</div>' : '');
    // renderMarkdown emits Copy/Apply buttons on every completed code block. This
    // used to run only on the final flush, so mid-stream those buttons rendered
    // with no listeners attached — clicking Apply did nothing at all. The DOM is
    // rebuilt each tick, so the dataset.bound guard inside is re-evaluated fresh.
    attachCodeBlockActions(activeAssistantBubble);
  }

  // Feeds the adaptive throttle: if this render was expensive, the next one is
  // scheduled proportionally further out instead of piling up behind it.
  _mdRenderCost = Date.now() - _renderStart;

  // A stalled webview logs nothing to the extension host, so report slow renders
  // upward — they show up in the Navy Coder output channel, where they can
  // actually be found. Reported once per turn so a slow machine can't spam it.
  if (_mdRenderCost > 250 && !_perfWarned) {
    _perfWarned = true;
    vscode.postMessage({
      type: 'perfWarning',
      ms: _mdRenderCost,
      chars: activeAssistantContent.length,
      mode: display.length > LIVE_MD_MAX_CHARS ? 'plain-text' : 'markdown',
    });
  }

  // rAF-batched — at most one scroll write per painted frame.
  scrollToBottom();
}

function flushAssistantText() {
  if (_mdRenderTimer) { clearTimeout(_mdRenderTimer); _mdRenderTimer = null; }
  // Reset the throttle window here, not just when appendAssistantText lazily
  // creates a new message — the 'start' handler pre-creates activeAssistantMessage
  // directly (and calls flushAssistantText first), so without this the first
  // chunk of a brand-new response could inherit a very recent timestamp from the
  // PREVIOUS response and get needlessly delayed instead of painting immediately.
  _lastMdRenderAt = 0;
  _mdRenderCost = 0;
  _streamPre = null;   // the bubble is about to be replaced by the final render

  if (!activeAssistantBubble || !activeAssistantContent) return;
  // The copy button lives on the FIRST bubble and must yield the whole reply,
  // even when it was split across several bubbles by tool activity.
  (_primaryBubble || activeAssistantBubble).dataset.rawMd = activeAssistantContent;
  if (activeAssistantMessage) activeAssistantMessage.dataset.rawMd = activeAssistantContent;
  // Final render of THIS bubble's slice — earlier segments were already given
  // their final render when they were sealed. Always assign, even when empty, so
  // a stale streaming <pre> never lingers as a tall blank block in the chat.
  const rendered = renderMarkdown(activeAssistantContent.slice(_segmentStart));
  activeAssistantBubble.innerHTML = rendered;
  if (rendered) attachCodeBlockActions(activeAssistantBubble);
  scrollToBottom();
}

function addSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'system-notice';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

// Renders the running session-cumulative token count (and $ cost estimate,
// when the model/provider is recognized) into the token counter — shared by
// the 'tokenCount' (live, during a turn) and 'sessionLoaded' (restoring a
// chat or switching tabs) handlers so both paths render identically.
// estimatedCost is null when the model isn't in Navy's pricing table (never
// shown as $0 — that would misreport an unknown cost as a known free one);
// costKnown is false when SOME but not all of the session's turns priced
// successfully, so the total is a floor, not the full picture.
// Context windows are quoted in two different conventions: binary for local
// models (131,072 is universally written "128k") and decimal for hosted APIs
// (Claude's 200,000 is written "200k", not "195k"). A round DECIMAL value is
// the reliable signal, so it's tested first — testing divisibility by 1024
// first gets 128,000 wrong, since that is exactly 125 × 1024 and would print
// as "125k" despite being quoted everywhere as 128K.
function formatContextWindow(n) {
  if (n >= 1000000) {
    return (n % 1000000 === 0 ? n / 1000000 : +(n / 1048576).toFixed(1)) + 'M ctx';
  }
  return (n % 1000 === 0 ? n / 1000 : Math.round(n / 1024)) + 'k ctx';
}

// Rebuilds the context-window picker for whichever model is now active. The
// options come from the extension (derived from what that model actually
// reports), never from a list hardcoded here — an 8k model must not be offered
// 128k, and a 1M model must not be capped at whatever a frontend constant
// happened to stop at.
//
// The first entry is "Max", value 0, which is deliberately NOT the same as
// picking the maximum explicitly: 0 means "track the model", so switching
// models moves with it, whereas an explicit size stays put until changed.
function renderContextWindowSelect(info) {
  if (!contextSelect) return;
  if (!info.max) {
    // Unknown for this model — hide rather than offer sizes that may not exist.
    contextSelect.innerHTML = '';
    contextSelect.style.display = 'none';
    return;
  }
  contextSelect.style.display = '';
  contextSelect.innerHTML = '';

  const maxOption = document.createElement('option');
  maxOption.value = '0';
  maxOption.textContent = 'Max · ' + formatContextWindow(info.max);
  contextSelect.appendChild(maxOption);

  for (const size of info.options || []) {
    if (size >= info.max) continue; // already covered by "Max" above
    const option = document.createElement('option');
    option.value = String(size);
    option.textContent = formatContextWindow(size);
    contextSelect.appendChild(option);
  }

  // `current` equals max both when "Max" is selected and when the largest size
  // was picked explicitly — so the stored preference decides which is shown,
  // not the resolved number.
  contextSelect.value = (info.current && info.current < info.max) ? String(info.current) : '0';

  contextSelect.title = 'Context window: ' + info.current.toLocaleString() + ' tokens'
    + (info.live
      ? '\nMaximum reported by the provider for this model.'
      : '\nMaximum is approximate — this provider does not report it, so it comes from Navy\'s known-model list.')
    + (info.adjustable
      ? '\nSent to Ollama as num_ctx — a smaller window reserves less memory.'
      : '\nFixed by the provider; a smaller value here only makes Navy treat the chat as full sooner.');
}

function renderTokenCounter(sessionTotal, sessionPrompt, sessionCompletion, estimatedCost, costKnown) {
  if (!tokenCounterEl) return;
  if (!sessionTotal) {
    tokenCounterEl.textContent = '';
    tokenCounterEl.classList.remove('visible');
    return;
  }
  let text = sessionTotal.toLocaleString() + ' tok';
  let title = `Session total: ${(sessionPrompt || 0).toLocaleString()} prompt + ${(sessionCompletion || 0).toLocaleString()} completion tokens`;
  if (typeof estimatedCost === 'number') {
    const shown = estimatedCost > 0 && estimatedCost < 0.01 ? estimatedCost.toFixed(4) : estimatedCost.toFixed(2);
    text += ' · ≈$' + shown + (costKnown ? '' : '+');
    title += `\nEstimated cost: ≈$${estimatedCost.toFixed(4)}`
      + (costKnown ? '' : ' or more — part of this session used a model with no known pricing')
      + '\nBased on published list pricing, not a live rate — verify against your provider for exact billing.';
  } else {
    title += '\nCost estimate unavailable for this model.';
  }
  tokenCounterEl.textContent = text;
  tokenCounterEl.title = title;
  tokenCounterEl.classList.add('visible');
}

function updateMemoryBadge(memoryContent) {
  if (!memoryCount || !memoryButton) return;
  // Count non-header, non-empty bullet lines.
  const count = memoryContent
    .split('\n')
    .filter(l => l.trim().startsWith('-')).length;
  if (count > 0) {
    memoryCount.textContent = count;
    memoryCount.style.display = 'inline';
    memoryButton.classList.add('has-memory');
  } else {
    memoryCount.style.display = 'none';
    memoryButton.classList.remove('has-memory');
  }
}

function updateMemoryPanel(mem) {
  if (!memoryContent) return;
  if (!mem || !mem.trim() || mem.trim() === '# Navy Project Memory') {
    memoryContent.innerHTML = '<span class="memory-empty">No memories yet. Navy will remember facts about this project as you work.</span>';
    return;
  }
  // Render memory as markdown inside the panel.
  memoryContent.innerHTML = renderBlockMarkdown(mem);
}

// rAF-batched scroll pinning: at most one scroll write per frame, synced to paint,
// so streaming chunks and card insertions never cause competing scroll jumps.
let _scrollPending = false;
function scrollToBottom() {
  if (userScrolledUp || _scrollPending) return;
  _scrollPending = true;
  requestAnimationFrame(() => {
    _scrollPending = false;
    if (!userScrolledUp) messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function attachCodeBlockActions(container) {
  const blocks = container.querySelectorAll('.code-block');
  for (const block of blocks) {
    if (block.dataset.bound) {
      continue;
    }
    block.dataset.bound = 'true';

    const copyButton = block.querySelector('.copy-button');
    const applyButton = block.querySelector('.apply-button');
    const code = block.querySelector('pre code');
    const pathEl = block.querySelector('.code-path');
    const text = code ? code.textContent : '';
    const path = pathEl ? pathEl.dataset.path : '';

    copyButton?.addEventListener('click', () => {
      if (!text) return;
      vscode.postMessage({ type: 'copy', text });
      copyButton.textContent = 'Copied';
      setTimeout(() => {
        copyButton.textContent = 'Copy';
      }, 1500);
    });

    applyButton?.addEventListener('click', () => {
      if (!text) return;
      applyButton.textContent = '...';
      applyButton.disabled = true;
      vscode.postMessage({ type: 'applyCode', text, path });
    });
  }
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

// True when a string is a tool call the model printed as raw JSON instead of
// using the tool API (common with small local models). Such text is executed by
// the agent, never meant for the user — so it must not render as a chat bubble.
function isToolCallJson(s) {
  const t = (s || '').trim();
  if (t[0] !== '{' || t[t.length - 1] !== '}') return false;
  try {
    const o = JSON.parse(t);
    const name = o.name || o.tool || o.function;
    const args = o.arguments ?? o.parameters ?? o.args ?? o.input;
    return typeof name === 'string' && args !== undefined && typeof args === 'object';
  } catch { return false; }
}

// Remove every top-level tool-call JSON object from text, including several
// concatenated back-to-back ({...}{...}{...}) — small models emit tool calls
// this way and they must never render (the agent executes them). Brace-matched
// so strings containing braces don't confuse it.
function stripToolCallJson(text) {
  let out = '', i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === '{') {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let j = i; j < n; j++) {
        const c = text[j];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
      }
      if (end !== -1) {
        const obj = text.slice(i, end);
        if (isToolCallJson(obj)) { i = end; continue; } // drop this tool call
        out += obj; i = end; continue;
      }
    }
    out += text[i++];
  }
  return out;
}

function renderMarkdown(text) {
  // Normalize line endings first — models on some backends emit \r\n.
  let cleaned = text
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/<tool\s+name="[^"]*"[^>]*>[\s\S]*?(?:<\/tool\s*>|<\|tool_call_end\|>)/g, '')
    .replace(/<\|tool_calls_section_(?:start|end)\|>/g, '')
    .trim();

  // Strip tool-call JSON small models print as text — one object, or several
  // concatenated ({...}{...}{...}). If nothing but tool calls remains, render
  // nothing (the tool activity card is the real feedback).
  cleaned = stripToolCallJson(cleaned).trim();
  if (!cleaned) return '';
  // Fenced tool-call JSON inside other text → drop just that block.
  cleaned = cleaned.replace(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g, (m, body) => isToolCallJson(body) ? '' : m).trim();

  // Extract <think>…</think> blocks (DeepSeek-R1, Qwen3, etc.) and render as collapsible.
  let thinkingHtml = '';
  cleaned = cleaned.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, (_, inner) => {
    const safe = inner.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    thinkingHtml += `<details class="think-block"><summary class="think-summary">💭 Reasoning <span class="think-toggle-hint">(click to expand)</span></summary><pre class="think-content">${safe}</pre></details>`;
    return '';
  });
  // Handle an unclosed <think> tag still streaming — show a live indicator.
  if (/^<think(?:ing)?>/i.test(cleaned.trim())) {
    return '<div class="think-streaming">💭 Reasoning…</div>';
  }
  // Strip orphan think tags (closing tag with no opening, or vice versa) — some
  // models emit malformed tags that would otherwise leak into the chat as literal text.
  cleaned = cleaned.replace(/<\/?think(?:ing)?>/gi, '');
  cleaned = cleaned.trim();

  // Split on fenced code blocks first so block-markdown never touches code content.
  // Relaxed: handles [\w.+-] language names, optional trailing text on fence line,
  // optional trailing whitespace before closing fence.
  const segments = [];
  // The fence length is bounded on purpose. `{3,}` combined with the \1
  // backreference backtracks quadratically over a long run of backticks —
  // measured at 14.5 SECONDS of frozen renderer for a 160k-backtick run, and
  // this regex runs on every render of every reply. Real fences are 3 or 4
  // backticks; capping at 8 keeps every legitimate form parsing identically
  // while making the pathological case constant-time.
  const codeRe = /(?:^|\n)(`{3,8})([\w.+\-]*)(?::([^\s\n]+))?[^\n]*\n([\s\S]*?)\n\1[ \t]*(?=$|\n)/g;
  let pos = 0;
  let m;
  while ((m = codeRe.exec(cleaned)) !== null) {
    const textBefore = cleaned.slice(pos, m.index);
    if (textBefore) segments.push({ type: 'text', content: textBefore });
    segments.push({ type: 'code', language: m[2] || '', path: m[3] || '', code: m[4] });
    pos = codeRe.lastIndex;
  }
  if (pos < cleaned.length) segments.push({ type: 'text', content: cleaned.slice(pos) });

  const body = segments.map(seg =>
    seg.type === 'code'
      ? renderCodeBlock(seg.language, seg.path, seg.code)
      : renderBlockMarkdown(seg.content)
  ).join('');
  return thinkingHtml + body;
}

// Render block-level constructs (headings, lists, blockquotes, tables, paragraphs).
function renderBlockMarkdown(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let seenAt = -1;

  while (i < lines.length) {
    // Unconditional progress guard. Every branch below is *supposed* to advance
    // `i`, but this loop runs on partial, model-generated text on every render,
    // so a branch that declines a line it was expected to claim costs the user
    // the whole panel — permanently. Rather than trusting each branch to be
    // exhaustive, notice when a line has already been offered around once and
    // force it out as a paragraph. Worst case a future bug mis-renders one
    // line; it can no longer hang the renderer.
    if (i === seenAt) {
      out.push(`<p>${renderInline(lines[i])}</p>`);
      i++;
      continue;
    }
    seenAt = i;

    const line = lines[i];
    const trimmed = line.trim();

    // — blank line —
    if (trimmed === '') { i++; continue; }

    // — ATX heading (#…######) —
    const hm = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      const lvl = hm[1].length;
      out.push(`<h${lvl}>${renderInline(hm[2])}</h${lvl}>`);
      i++; continue;
    }

    // — horizontal rule: skip silently — models emit --- as filler separators that
    //   clutter narrow panels without adding value.
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      i++; continue;
    }

    // — blockquote —
    if (trimmed.startsWith('>')) {
      const qLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        qLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderBlockMarkdown(qLines.join('\n'))}</blockquote>`);
      continue;
    }

    // — unordered or ordered list (supports nesting and loose lists) —
    if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      const indent = line.length - line.trimStart().length;
      const [html, nextI] = renderList(lines, i, indent);
      out.push(html);
      i = nextI;
      continue;
    }

    // — GFM table (row | separator | rows…) —
    if (line.includes('|') && i + 1 < lines.length && /^\|?[\s:-]+\|/.test(lines[i + 1])) {
      const tLines = [];
      while (i < lines.length && lines[i].includes('|')) { tLines.push(lines[i]); i++; }
      out.push(renderTable(tLines));
      continue;
    }

    // — paragraph: gather consecutive "plain" lines —
    // The first line is consumed unconditionally, and that is load-bearing.
    // Every branch above has already declined this line, so if the loop
    // conditions below could reject it too, `i` would never advance and this
    // while-loop would spin on the same line forever — freezing the entire
    // panel with no error, no log, and no way out but killing the window.
    //
    // It was reachable, and common: the loop rejects any line starting with
    // `|`, while the table branch only claims one whose NEXT line is a
    // separator row. A table header is therefore fatal for as long as it is the
    // last line received — which is precisely what every streamed markdown
    // table looks like in the gap before its `|---|---|` arrives. Whether a
    // render tick landed in that gap decided whether Navy froze, which is why
    // it looked random.
    const pLines = [lines[i++]];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,6}\s/.test(lines[i].trim()) &&
      !/^[-*+]\s/.test(lines[i].trim()) &&
      !/^\d+\.\s/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith('>') &&
      !/^(?:-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      // Stop before table lines (pipe-starting) so they reach the table renderer.
      !/^\|/.test(lines[i].trim()) &&
      !(i + 1 < lines.length && /^\|?[\s:-]+\|/.test(lines[i + 1]))
    ) {
      pLines.push(lines[i]);
      i++;
    }
    if (pLines.length) {
      // Double-space line-ending → <br>; single newline within paragraph → <br>
      const inner = pLines.map(l => renderInline(l)).join('<br>');
      out.push(`<p>${inner}</p>`);
    }
  }

  return out.join('\n');
}

function renderTable(lines) {
  if (lines.length < 2) return `<p>${renderInline(lines[0] || '')}</p>`;
  const parseCells = l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const headers = parseCells(lines[0]);
  const body = lines.slice(2).map(parseCells);
  const th = headers.map(h => `<th>${renderInline(h)}</th>`).join('');
  const tr = body.map(row =>
    `<tr>${row.map(c => `<td>${renderInline(c)}</td>`).join('')}</tr>`
  ).join('');
  return `<div class="md-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

// Renders a list (ul or ol) starting at lines[startI] with items at baseIndent.
// Handles nested sub-lists via indentation, loose lists (blank lines between items),
// and GFM task list items (- [ ] / - [x]).
// Returns [htmlString, nextLineIndex].
function renderList(lines, startI, baseIndent) {
  const isOrdered = /^\d+\.\s/.test(lines[startI].trim());
  const items = [];
  let i = startI;

  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === '') { i++; continue; } // skip blank lines in loose lists
    const indent = raw.length - raw.trimStart().length;
    const tr = raw.trim();
    const isUl = /^[-*+]\s/.test(tr);
    const isOl = /^\d+\.\s/.test(tr);
    if (!isUl && !isOl) break;          // not a list line — end of list
    if (indent < baseIndent) break;     // outdented — end of this level
    if (indent > baseIndent) {          // deeper indent — nested sub-list
      if (items.length === 0) break;
      const [nestedHtml, nextI] = renderList(lines, i, indent);
      items[items.length - 1] += nestedHtml;
      i = nextI;
      continue;
    }
    // Same indentation level — new item
    const rawText = isUl ? tr.replace(/^[-*+]\s+/, '') : tr.replace(/^\d+\.\s+/, '');
    const taskM = rawText.match(/^\[([xX ])\]\s+(.*)/);
    const text = taskM ? taskM[2] : rawText;
    const prefix = taskM
      ? `<input type="checkbox" disabled${taskM[1].toLowerCase() === 'x' ? ' checked' : ''}> `
      : '';
    items.push(prefix + renderInline(text));
    i++;
  }

  const tag = isOrdered ? 'ol' : 'ul';
  return [`<${tag}>${items.map(it => `<li>${it}</li>`).join('')}</${tag}>`, i];
}

// Render inline markdown (bold, italic, code, links, strikethrough).
function renderInline(text) {
  let h = escapeHtml(text);
  // Pull code spans out FIRST — otherwise `snake_case_names` and `*args` inside
  // backticks get mangled by the italic/bold regexes below.
  const NUL = String.fromCharCode(0); // delimiter that can never appear in HTML-escaped text
  const codeSpans = [];
  h = h.replace(/`([^`]+)`/g, (_, c) => {
    codeSpans.push(c);
    return NUL + 'C' + (codeSpans.length - 1) + NUL;
  });
  h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/__(.+?)__/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/_([^_]+)_/g, '<em>$1</em>');
  h = h.replace(/~~(.+?)~~/g, '<del>$1</del>');
  h = h.replace(new RegExp(NUL + 'C(\\d+)' + NUL, 'g'), (_, i) => '<code>' + codeSpans[Number(i)] + '</code>');
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    // url is HTML-escaped at this point — unescape & before using in href.
    const rawUrl = url.replace(/&amp;/g, '&');
    const safe = /^https?:\/\//i.test(rawUrl) ? rawUrl : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return h;
}

function renderCodeBlock(language, path, code) {
  const pathAttr = path ? ` data-path="${escapeHtml(path)}"` : '';
  const pathLabel = path ? `<span class="code-path" title="${escapeHtml(path)}"${pathAttr}>${escapeHtml(path)}</span>` : '';
  const showApply = Boolean(path);
  return `<div class="code-block">
    <div class="code-header">
      <div class="code-meta">
        <span class="code-language">${language || 'code'}</span>
        ${pathLabel}
      </div>
      <div class="code-actions">
        <button class="copy-button" type="button">Copy</button>
        ${showApply ? `<button class="apply-button" type="button" title="Apply to file">Apply</button>` : ''}
      </div>
    </div>
    <pre><code class="language-${language}"${pathAttr}>${escapeHtml(code)}</code></pre>
  </div>`;
}

// What the copy button should actually put on the clipboard. rawMd is the
// model's untouched output, which still contains its <think> blocks — the UI
// goes to some trouble to keep reasoning behind a collapsed dropdown, and then
// copying handed you the raw tags and everything in them. Exported reasoning
// belongs to the export/expand paths, not to "copy this reply". Pure.
function copyableReply(raw) {
  return String(raw || '')
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/i, '') // an unterminated block (stopped mid-reasoning)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


// ─── Tool card icons ─────────────────────────────────────────────────────────

const TOOL_ICON_SVG = {
  read_file:        `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>`,
  read_lines:       `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/></svg>`,
  write_file:       `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
  delete_file:      `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  apply_edit:       `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  edit_line:        `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
  delete_line:      `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  insert_after_line:`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`,
  list_files:       `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  search_files:     `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  run_command:      `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  remember:         `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
  forget:           `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><line x1="17" y1="14" x2="7" y2="14"/></svg>`,
  finish:           `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
};

const TOOL_VERB = {
  read_file: 'Reading', read_lines: 'Reading', write_file: 'Writing',
  delete_file: 'Deleting', rename_file: 'Renaming', apply_edit: 'Editing', edit_line: 'Editing',
  delete_line: 'Deleting', insert_after_line: 'Inserting',
  list_files: 'Listing', search_files: 'Searching', search_codebase: 'Searching',
  fetch_url: 'Fetching', web_search: 'Web searching',
  run_command: 'Running', run_tests: 'Running tests',
  start_process: 'Starting', read_process_output: 'Reading output', kill_process: 'Stopping process',
  git_status: 'Git status', git_diff: 'Git diff', git_log: 'Git log', git_blame: 'Git blame',
  get_diagnostics: 'Checking diagnostics',
  remember: 'Remembering', forget: 'Forgetting', finish: 'Done',
  __thinking__: 'Thinking',
};

function toolCardIcon(tool) {
  return TOOL_ICON_SVG[tool] || `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>`;
}

// ── Activity log: stacked tool steps with result previews ────────────────────

const WHEEL_SVG = `<svg class="spin-wheel" viewBox="0 0 24 24" width="14" height="14" fill="none" aria-label="Working">
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
</svg>`;

// EVERY activity-log segment created so far this turn, in order — a turn
// with tool calls in more than one place (text → tools → text → tools →
// text, not just a single text/tools/text split) needs each batch of tool
// activity in its OWN log positioned right where it actually happened, not
// all merged into whichever one was created first. The CURRENT (most
// recent) one is always derived via currentActivityLog() below rather than
// tracked in a second variable — a past version kept both an
// `activityLogEl` variable AND this array in sync by hand at every read/
// write site, which is exactly the kind of thing a future edit forgets one
// half of (this file's own resetThreadDisplay() had already drifted that
// way once). collapseToolProgress/removeToolProgress finalize/remove every
// segment, not just the current one.
let allActivityLogEls = [];

function currentActivityLog() {
  return allActivityLogEls.length ? allActivityLogEls[allActivityLogEls.length - 1] : null;
}

// Removes the CURRENT (most recent) segment entirely — used when it turns
// out to be empty (only ever held the "Thinking" placeholder, which just
// got removed) so it doesn't sit there as an empty bordered box.
function removeCurrentActivityLog() {
  const log = currentActivityLog();
  if (!log) return;
  log.remove();
  allActivityLogEls.pop();
}
// Set whenever a fresh text bubble opens after a batch of tool activity
// (see appendAssistantText) — tells the NEXT tool call to start a fresh log
// of its own instead of silently resuming the old one, which would leave it
// stuck at its original DOM position while everything after piles into a
// single bubble whose <think> blocks then render out of chronological order
// (the exact bug this exists to prevent: a second round of reasoning midway
// through a turn rendering as if it happened at the very start).
let _needNewActivityLog = false;
let currentActivityRowEl = null;
// Rows keyed by the extension host's per-call id — needed because a toolResult
// doesn't always arrive right after its own toolCall: parallel read-only calls
// can finish out of order, and short-circuited calls (dedup/blocked-retry/hard-cap)
// jump straight from toolCall to toolResult. currentActivityRowEl alone can't
// tell those results apart from whatever OTHER call happened to run last.
const activityRowsById = new Map();

// Places a card produced BY THE CURRENT TURN — a terminal card, a diff, a
// command approval, the run-project card — at the point in the transcript where
// it actually happened.
//
// Every one of these used to be appended straight to `messagesEl`, i.e. as a
// SIBLING after the assistant message. Text and activity logs, meanwhile, are
// appended INTO that message. Since the message element was created first,
// anything the model wrote or did after a card rendered ABOVE it: run a
// command, explain the result, and the explanation appeared over the terminal
// card. This is the same ordering fault sealCurrentBubble/allActivityLogEls
// were introduced to fix for activity logs — it just never got applied to the
// cards, which is why one shared helper does it for all of them now.
//
// Sealing has two effects, both required: the current bubble is finalised so
// following prose opens a NEW bubble below the card, and the next batch of tool
// activity is forced into a fresh log below it as well.
function appendTurnCard(el) {
  sealCurrentBubble();
  _needNewActivityLog = true;
  (activeAssistantMessage || messagesEl).appendChild(el);
  updateWelcome();
  return el;
}

function getOrCreateActivityLog() {
  if (!currentActivityLog() || _needNewActivityLog) {
    // Close off whatever the model has said so far, so this activity lands
    // BELOW it and anything written afterwards lands below the activity.
    sealCurrentBubble();
    const log = document.createElement('div');
    log.className = 'activity-log';
    // Attach inside the active assistant message so it's visually grouped with
    // the response it belongs to, not floating between turns in the stream.
    const parent = activeAssistantMessage || messagesEl;
    parent.appendChild(log);
    allActivityLogEls.push(log);
    currentActivityRowEl = null;
    _needNewActivityLog = false;
  }
  return currentActivityLog();
}

function removeToolProgress() {
  for (const el of allActivityLogEls) el.remove();
  allActivityLogEls = [];
  currentActivityRowEl = null;
  activityRowsById.clear();
}

// Collapses ONE activity-log segment's rows into a "✓ N steps — verb, verb…"
// summary, in place. Shared by collapseToolProgress across however many
// segments the turn actually produced (see allActivityLogEls above).
function collapseOneActivityLog(log) {
  log.querySelector('.thinking-row')?.remove(); // leftover "Thinking" placeholder, if any
  const rows = log.querySelectorAll('.activity-row');
  if (rows.length === 0) { log.remove(); return; }
  const errors = log.querySelectorAll('.is-error').length;
  const count = rows.length;
  const verbs = [...rows].slice(0, 4).map(r => r.querySelector('.act-verb')?.textContent || '').filter(Boolean);
  const verbStr = verbs.join(', ') + (count > 4 ? ` +${count - 4}` : '');
  const details = document.createElement('details');
  details.className = 'activity-log-collapsed';
  const summary = document.createElement('summary');
  summary.className = 'activity-summary';
  summary.innerHTML =
    (errors ? `<span class="act-x">✕</span>` : `<span class="act-check">✓</span>`) +
    ` ${count} step${count !== 1 ? 's' : ''}` +
    (verbStr ? ` — ${escapeHtml(verbStr)}` : '');
  details.appendChild(summary);
  [...rows].forEach(r => details.appendChild(r));
  log.innerHTML = '';
  log.appendChild(details);
}

function collapseToolProgress() {
  // Every segment the turn produced — not just the current/latest one — so a
  // turn with tool activity in more than one place ends with each batch
  // collapsed in place, not just the last.
  for (const log of allActivityLogEls) collapseOneActivityLog(log);
  allActivityLogEls = [];
  currentActivityRowEl = null;
  activityRowsById.clear();
}

function buildResultPreview(tool, result) {
  if (!result) return '';
  const r = String(result);
  if (r.startsWith('Error')) return r.slice(0, 90);

  switch (tool) {
    case 'read_file': case 'read_lines': {
      const n = r.split('\n').length;
      return `${n} line${n !== 1 ? 's' : ''}`;
    }
    case 'list_files': {
      const n = r.split('\n').filter(l => l.trim()).length;
      return `${n} file${n !== 1 ? 's' : ''}`;
    }
    case 'search_files': case 'search_codebase': {
      const n = r.split('\n').filter(l => l.trim() && !l.startsWith('---')).length;
      return n ? `${n} match${n !== 1 ? 'es' : ''}` : 'no matches';
    }
    case 'run_command': case 'start_process': {
      const first = r.split('\n').find(l => l.trim());
      return first ? first.slice(0, 80) : 'done';
    }
    case 'read_process_output': {
      const lines = r.split('\n').filter(l => l.trim()).length;
      return `${lines} line${lines !== 1 ? 's' : ''}`;
    }
    case 'write_file': case 'apply_edit': return 'saved';
    case 'delete_file': return 'deleted';
    case 'rename_file': return 'renamed';
    case 'web_search': {
      const n = (r.match(/^\[\d+\]/gm) || []).length;
      return n ? `${n} result${n !== 1 ? 's' : ''}` : r.slice(0, 60);
    }
    case 'git_status': {
      const n = r.split('\n').filter(l => l.trim()).length;
      return n ? `${n} change${n !== 1 ? 's' : ''}` : 'clean';
    }
    case 'git_diff': {
      const n = (r.match(/^diff --git/gm) || []).length;
      return n ? `${n} file${n !== 1 ? 's' : ''} changed` : 'no changes';
    }
    case 'git_log': {
      const n = (r.match(/^commit /gm) || []).length;
      return n ? `${n} commit${n !== 1 ? 's' : ''}` : r.slice(0, 60);
    }
    case 'git_blame': {
      const n = r.split('\n').filter(l => l.trim()).length;
      return `${n} line${n !== 1 ? 's' : ''}`;
    }
    case 'fetch_url': return `${Math.round(r.length / 1024)} KB`;
    case 'get_diagnostics': {
      const errors   = (r.match(/\[Error\]/g)   || []).length;
      const warnings = (r.match(/\[Warning\]/g) || []).length;
      if (!errors && !warnings) return 'no issues';
      return [errors && `${errors} error${errors !== 1 ? 's' : ''}`, warnings && `${warnings} warning${warnings !== 1 ? 's' : ''}`].filter(Boolean).join(', ');
    }
    case 'remember': return 'saved to memory';
    case 'forget':   return 'removed from memory';
    case 'run_tests': {
      const pass = (r.match(/pass(ed|ing)?/gi) || []).length;
      const fail = (r.match(/fail(ed|ing)?/gi) || []).length;
      return fail ? `${fail} failing` : pass ? `${pass} passing` : r.slice(0, 60);
    }
    case 'kill_process': return 'stopped';
    default: return r.length > 80 ? r.slice(0, 80) + '…' : r || 'done';
  }
}

function addToolCallCard(tool, args, callId) {
  // Remove the "Thinking" placeholder row when a real tool call arrives.
  if (tool !== '__thinking__') {
    const placeholder = currentActivityLog()?.querySelector('.thinking-row');
    if (placeholder) placeholder.remove();
  }

  const verb   = TOOL_VERB[tool] || tool;
  const base   = (p) => String(p).replace(/^.*[\\/]/, '');
  const target = (args.from && args.to ? args.from + ' → ' + args.to : '')
    || args.path || args.directory || args.query || args.command || args.id || args.url || args.fact || args.name || '';
  const fname  = args.from && args.to ? base(args.from) + ' → ' + base(args.to)
    : target ? base(target) : '';

  let rangeStr = '';
  if (args.start != null && args.end != null) rangeStr = ` ${args.start}–${args.end}`;
  else if (args.start != null) rangeStr = ` L${args.start}`;
  else if (args.line != null)  rangeStr = ` L${args.line}`;

  const log = getOrCreateActivityLog();
  const row = document.createElement('div');
  row.className = 'activity-row running';
  row.innerHTML =
    `<span class="act-icon">${WHEEL_SVG}</span>` +
    `<span class="act-verb">${escapeHtml(verb)}</span>` +
    (fname || target
      ? `<code class="act-target" title="${escapeHtml(target)}">${escapeHtml(fname || target)}${escapeHtml(rangeStr)}</code>`
      : '') +
    `<span class="act-result"></span>`;

  row.dataset.tool = tool; // lets a result with no id find its own row — see below
  log.appendChild(row);
  currentActivityRowEl = row;
  if (callId) activityRowsById.set(callId, row);
  scrollToBottom();
}

function addToolResultCard(tool, result, callId) {
  // With an id this is exact. Without one (the XML fallback path small models
  // use), falling straight back to currentActivityRowEl picked whichever row
  // was created LAST — wrong whenever read-only tools ran in parallel, since
  // several are in flight and they finish out of order. Preferring the oldest
  // STILL-RUNNING row for the same tool matches results to calls correctly for
  // the common case of several different tools running at once.
  let row = callId ? activityRowsById.get(callId) : null;
  if (!row) {
    // Matched by walking the rows rather than with a selector: a tool name goes
    // into the attribute unescaped, and CSS.escape is not available in every
    // environment this file runs in.
    const log = currentActivityLog();
    row = [...(log?.querySelectorAll('.activity-row.running') || [])].find(r => r.dataset.tool === tool)
      || (currentActivityRowEl?.classList.contains('running') ? currentActivityRowEl : null)
      || currentActivityRowEl;
  }
  if (!row) return;
  if (callId) activityRowsById.delete(callId);

  const isError = typeof result === 'string' && result.startsWith('Error');
  row.classList.remove('running');
  row.classList.add(isError ? 'is-error' : 'is-done');

  const iconEl = row.querySelector('.act-icon');
  if (iconEl) iconEl.innerHTML = isError ? '<span class="act-x">✕</span>' : '<span class="act-check">✓</span>';

  const preview = buildResultPreview(tool, String(result || ''));
  if (preview) {
    const resultEl = row.querySelector('.act-result');
    if (resultEl) resultEl.textContent = preview;
  }
  scrollToBottom();
}

// ── Terminal IN/OUT card (Claude-Code-style) ─────────────────────────────────
// One card per run_command / run_tests call: IN = the command, OUT = live output.
// Long output collapses behind a "Click to expand" toggle when the command ends.

// Terminal cards keyed by the tool call that owns them, so two commands in
// flight at once (a background task runs its own agent loop alongside the main
// turn) can't write into each other's card. `activeTermCard` remains as the
// fallback for output that arrives with no id at all.
const termCardsById = new Map();
let activeTermCard = null;

function termCardFor(streamId) {
  if (streamId && termCardsById.has(streamId)) return termCardsById.get(streamId);
  // A KNOWN id that matches no card belongs to something this view isn't
  // showing (a background task's command) — deliberately NOT routed to
  // whatever card is current, which is exactly the mix-up this fixes. The
  // caller falls back to the shell panel.
  if (streamId) return null;
  return activeTermCard;
}

function createTermCard(tool, commandText, streamId) {
  // Terminal cards bypass addToolCallCard, which normally clears the "Thinking"
  // placeholder — clear it here too or it spins forever above the card.
  {
    const log = currentActivityLog();
    if (log) {
      log.querySelector('.thinking-row')?.remove();
      if (!log.children.length) removeCurrentActivityLog();
    }
  }
  const card = document.createElement('div');
  card.className = 'term-card';
  card.innerHTML = `
    <div class="term-row term-in-row">
      <span class="term-label">IN</span>
      <pre class="term-in"></pre>
      <span class="term-status running">running…</span>
    </div>
    <div class="term-row term-out-row" style="display:none">
      <span class="term-label">OUT</span>
      <pre class="term-out"></pre>
    </div>`;
  card.querySelector('.term-in').textContent = commandText;
  appendTurnCard(card);
  const refs = {
    el: card,
    outEl: card.querySelector('.term-out'),
    outRow: card.querySelector('.term-out-row'),
    statusEl: card.querySelector('.term-status'),
    tool,
    streamId,
  };
  activeTermCard = refs;
  if (streamId) termCardsById.set(streamId, refs);

  // Command output is frequently the thing you most want to paste into an
  // issue, and it was the one block in the transcript with no way to copy it.
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'term-copy-btn';
  copyBtn.title = 'Copy command and output';
  copyBtn.textContent = '⧉';
  copyBtn.addEventListener('click', () => {
    const body = refs.outEl.textContent || '';
    vscode.postMessage({ type: 'copy', text: '$ ' + commandText + (body ? '\n' + body : '') });
    copyBtn.textContent = '✓';
    setTimeout(() => { copyBtn.textContent = '⧉'; }, 1200);
  });
  card.querySelector('.term-in-row').appendChild(copyBtn);

  updateWelcome();
  scrollToBottom();
}

function appendTermOutput(chunk, isStderr, streamId) {
  const t = termCardFor(streamId);
  if (!t) return false;
  t.outRow.style.display = '';
  if (isStderr) {
    const span = document.createElement('span');
    span.className = 'term-stderr';
    span.textContent = chunk;
    t.outEl.appendChild(span);
  } else {
    t.outEl.appendChild(document.createTextNode(chunk));
  }
  // Drop whole leading nodes rather than reassigning textContent. Reassigning
  // flattens the element to a single text node, which silently destroyed the
  // .term-stderr spans — every previously-red line turned into ordinary output
  // the moment a command crossed the cap.
  let total = t.outEl.textContent.length;
  while (total > 30000 && t.outEl.firstChild) {
    total -= (t.outEl.firstChild.textContent || '').length;
    t.outEl.removeChild(t.outEl.firstChild);
  }
  t.outEl.scrollTop = t.outEl.scrollHeight;
  return true;
}

function finalizeTermCard(result, streamId) {
  const t = termCardFor(streamId);
  if (!t) return;
  if (t.streamId) termCardsById.delete(t.streamId);
  if (activeTermCard === t) activeTermCard = null;
  const r = String(result || '');
  let label = 'done', cls = 'ok';
  const exitM = r.match(/^Exit code: (\d+)/);
  if (exitM)                                { label = 'exit ' + exitM[1]; cls = exitM[1] === '0' ? 'ok' : 'fail'; }
  else if (r.startsWith('Command timed out')) { label = 'timeout';  cls = 'fail'; }
  else if (r.startsWith('Command rejected'))  { label = 'rejected'; cls = 'fail'; }
  else if (r.startsWith('[Blocked'))          { label = 'blocked';  cls = 'fail'; }
  else if (r.startsWith('Command error'))     { label = 'error';    cls = 'fail'; }
  else if (r === '__stopped__')               { label = 'stopped';  cls = 'fail'; }
  t.statusEl.textContent = label;
  t.statusEl.className = 'term-status ' + cls;

  // Nothing streamed (short command, or output only in the result) — show the result body.
  if (!t.outEl.textContent.trim() && r && r !== '__stopped__') {
    const body = r.replace(/^Exit code: \d+\n?/, '').replace(/^stdout:\n?/m, '').replace(/\n?stderr:\n?$/, '').trim();
    if (body) { t.outRow.style.display = ''; t.outEl.textContent = body.slice(0, 4000); }
  }

  // Collapse long output behind an expand toggle.
  const txt = t.outEl.textContent;
  if (txt.length > 600 || txt.split('\n').length > 8) {
    t.outEl.classList.add('collapsed');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'expand-btn';
    btn.textContent = 'Click to expand';
    btn.addEventListener('click', () => {
      const collapsed = t.outEl.classList.toggle('collapsed');
      btn.textContent = collapsed ? 'Click to expand' : 'Collapse';
    });
    t.el.appendChild(btn);
  }
  scrollToBottom();
}

function addPendingDiffCard(id, filePath, oldText, newText) {
  const { html, added, removed } = renderDiff(oldText || '', newText || '');

  const card = document.createElement('div');
  card.className = 'diff-card';
  card.dataset.diffId = id;

  const header = document.createElement('div');
  header.className = 'diff-header';
  const fname = filePath.replace(/^.*[\\/]/, '');
  const fdir  = filePath.slice(0, filePath.length - fname.length);
  
  let badgeHtml = '';
  if (added > 0 || removed > 0) {
    badgeHtml = `
      <div class="diff-count-badge" style="display:inline-flex; gap:6px; font-size:11px; margin-left:8px;">
        <span class="diff-added-count" style="color:var(--vscode-gitDecoration-addedResourceForeground)">+${added}</span>
        <span class="diff-removed-count" style="color:var(--vscode-gitDecoration-deletedResourceForeground)">-${removed}</span>
      </div>`;
  }

  header.innerHTML = `
    <div class="diff-file-info">
      <button type="button" class="diff-filename diff-open-btn" title="Open ${escapeHtml(filePath)} in the editor">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-1px;margin-right:5px;opacity:0.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>${escapeHtml(fname)}</button>
      ${fdir ? `<span class="diff-filepath">${escapeHtml(fdir)}</span>` : ''}
      ${badgeHtml}
    </div>
    <span class="diff-status">Review required</span>`;
  // The card renders at most MAX_ROWS and then tells you to use the editor —
  // advice that was previously unreachable, since nothing in the card opened
  // anything. The filename is now the way there.
  header.querySelector('.diff-open-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openDiffFile', path: filePath });
  });
  card.appendChild(header);

  // Action buttons come BEFORE the diff body so they are always visible at the top.
  const actions = document.createElement('div');
  actions.className = 'diff-actions';
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'diff-approve';
  approve.textContent = '✓ Approve';
  approve.addEventListener('click', () => {
    approve.disabled = true;
    reject.disabled = true;
    vscode.postMessage({ type: 'approveDiff', id });
  });
  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'diff-reject';
  reject.textContent = '✕ Reject';
  reject.addEventListener('click', () => {
    approve.disabled = true;
    reject.disabled = true;
    vscode.postMessage({ type: 'rejectDiff', id });
  });
  actions.appendChild(approve);
  actions.appendChild(reject);
  card.appendChild(actions);

  const body = document.createElement('div');
  body.className = 'diff-body';
  body.innerHTML = html;
  card.appendChild(body);

  // Record the REAL change counts. diffResolved used to re-derive this by
  // counting .diff-added/.diff-removed elements, which undercounts whenever the
  // renderer truncated rows — and a count of 0 made it delete the whole diff
  // body, so a genuine edit showed a card with no changes in it.
  card.dataset.changeCount = String(added + removed);

  appendTurnCard(card);
  // No smooth scrollIntoView here — it fights the instant streaming scroll and
  // causes visible rubber-banding. One rAF-pinned scroll keeps motion consistent.
  //
  // Deliberately does NOT reset userScrolledUp: this was the only place that
  // overrode a deliberate scroll, yanking you to the bottom while you were
  // reading back through the very context you needed in order to judge the
  // edit. The pending-approval count in the approval queue is what surfaces a
  // card you scrolled past.
  scrollToBottom();
}

function addPendingCommandCard(id, command) {
  const card = document.createElement('div');
  card.className = 'command-card';
  card.dataset.commandId = id;

  const header = document.createElement('div');
  header.className = 'diff-header';
  header.innerHTML = `<span class="diff-path">Run command</span><span class="command-status diff-status">Waiting for approval</span>`;
  card.appendChild(header);

  const actions = document.createElement('div');
  actions.className = 'command-actions diff-actions';
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'diff-approve';
  approve.textContent = '▶ Run';
  approve.addEventListener('click', () => {
    approve.disabled = true;
    reject.disabled = true;
    vscode.postMessage({ type: 'approveCommand', id });
  });
  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'diff-reject';
  reject.textContent = '✕ Reject';
  reject.addEventListener('click', () => {
    approve.disabled = true;
    reject.disabled = true;
    vscode.postMessage({ type: 'rejectCommand', id });
  });
  actions.appendChild(approve);
  actions.appendChild(reject);
  card.appendChild(actions);

  const body = document.createElement('pre');
  body.className = 'tool-details';
  body.style.margin = '0';
  body.textContent = command;
  card.appendChild(body);

  appendTurnCard(card);
  userScrolledUp = false;
  scrollToBottom();
}

// ── Myers-diff-based unified diff ─────────────────────────────────────────────

// Myers' O(ND) diff algorithm: finds the shortest edit script (SES) between
// two line arrays. Replaces an O(n*m) DP table that had to bail out above a
// hard product cap (~633 lines either side) REGARDLESS of how similar the
// two versions actually were — so any edit to a larger file, even a single
// changed line, fell back to a cruder view. Cost here scales with D — the
// number of ACTUAL differences — not with file size: a 5000-line file with
// one changed line stays fast and exact, because the search terminates the
// moment it finds the (tiny) shortest edit script, never touching most of
// the file. D_LIMIT is scaled inversely with file size so the worst-case
// total work (size × D_LIMIT) — the pathological case of a huge file that's
// also almost entirely rewritten, where line alignment stops being useful
// context anyway — stays bounded regardless of input size, matching (and
// improving on) the old implementation's bounded-but-fixed cost. Same
// contract as its predecessor: returns null when it bails, and the caller's
// existing context-window fallback handles that rare case unchanged.
// The furthest-reaching path per diagonal k lives in ONE Int32Array indexed by
// k + OFF, rather than a plain object keyed by a (frequently negative) integer.
// Objects with negative-integer keys deoptimise straight to dictionary mode, so
// the hot inner loop was doing hash lookups; and the per-round `{ ...v }` copy
// the previous version needed made the whole search O(D²) in object
// allocations. The array is written in place instead: within round d only
// diagonals of parity d are written, while every read is of parity d-1, so
// nothing read this round can have been clobbered this round — the copy was
// never load-bearing.
//
// `trace[d]` still snapshots the state entering round d, since backtracking
// needs it, but stores only the live band (k ∈ [-d-1, d+1]) as a compact
// Int32Array — D² ints in total rather than D² object properties.
function computeMyersDiff(a, b) {
  const n = a.length, m = b.length;
  if (n === 0 && m === 0) return [];
  const total = n + m;
  const D_LIMIT = Math.min(total, Math.max(200, Math.floor(2000000 / Math.max(total, 1))));

  const OFF = D_LIMIT + 2;                     // k = -D_LIMIT-1 … D_LIMIT+1 all land in bounds
  const v = new Int32Array(2 * D_LIMIT + 5);
  v[OFF + 1] = 0;                              // seed: the virtual k=1 predecessor of round 0
  const trace = [];
  const bandAt = (d, k) => trace[d][k + d + 1]; // trace[d] covers k ∈ [-d-1, d+1]

  let foundD = -1;
  for (let d = 0; d <= D_LIMIT; d++) {
    trace.push(v.slice(OFF - d - 1, OFF + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[OFF + k - 1] < v[OFF + k + 1])) {
        x = v[OFF + k + 1];
      } else {
        x = v[OFF + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[OFF + k] = x;
      if (x >= n && y >= m) { foundD = d; break; }
    }
    if (foundD !== -1) break;
  }
  if (foundD === -1) return null; // genuinely very different — caller falls back

  // Backtrack through the trace to reconstruct the edit script.
  const ops = [];
  let x = n, y = m;
  for (let d = foundD; d > 0; d--) {
    const k = x - y;
    const prevK = (k === -d || (k !== d && bandAt(d, k - 1) < bandAt(d, k + 1))) ? k + 1 : k - 1;
    const prevX = bandAt(d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: '=', line: a[x - 1], ol: x, nl: y });
      x--; y--;
    }
    if (x === prevX) {
      ops.push({ t: '+', line: b[y - 1], nl: y });
    } else {
      ops.push({ t: '-', line: a[x - 1], ol: x });
    }
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ t: '=', line: a[x - 1], ol: x, nl: y });
    x--; y--;
  }
  return ops.reverse();
}

function renderDiff(oldText, newText) {
  const CONTEXT = 3;
  const MAX_ROWS = 400; // cap DOM rows so huge files can't freeze the sidebar
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const ops = computeMyersDiff(oldLines, newLines);

  // Fall back to simple sequential diff only for the rare case of two huge,
  // almost entirely rewritten files (see computeMyersDiff's D_LIMIT) — no
  // longer common, since file size alone no longer forces this path.
  if (!ops) {
    const max = Math.max(oldLines.length, newLines.length);
    // Mark changed lines first, then show only those ± CONTEXT — same as the LCS
    // path below. Emitting every unchanged line instead would burn the whole
    // MAX_ROWS budget on leading context, so a change past line 400 produced a
    // diff body with NO changed rows in it at all.
    const changedAt = new Uint8Array(max);
    let added = 0, removed = 0;
    for (let k = 0; k < max; k++) {
      if (!(k < oldLines.length && k < newLines.length && oldLines[k] === newLines[k])) {
        changedAt[k] = 1;
        if (k < oldLines.length) removed++;
        if (k < newLines.length) added++;
      }
    }
    const visible = new Uint8Array(max);
    for (let k = 0; k < max; k++) {
      if (!changedAt[k]) continue;
      for (let d = Math.max(0, k - CONTEXT); d <= Math.min(max - 1, k + CONTEXT); d++) visible[d] = 1;
    }

    let html = '', rows = 0, truncated = false;
    let k = 0;
    while (k < max) {
      if (!visible[k]) {
        let skip = 0;
        while (k < max && !visible[k]) { skip++; k++; }
        html += `<div class="diff-skip">↕ ${skip} unchanged line${skip > 1 ? 's' : ''}</div>`;
        continue;
      }
      if (rows >= MAX_ROWS) { truncated = true; break; }
      if (!changedAt[k]) {
        html += diffRow(' ', 'diff-unchanged', k + 1, k + 1, oldLines[k]);
        rows++;
      } else {
        if (k < oldLines.length) { html += diffRow('-', 'diff-removed', k + 1, null, oldLines[k]); rows++; }
        if (k < newLines.length && rows < MAX_ROWS) { html += diffRow('+', 'diff-added', null, k + 1, newLines[k]); rows++; }
      }
      k++;
    }
    if (truncated) {
      html += `<div class="diff-skip">↕ diff truncated — use the editor diff view for the full change</div>`;
    }
    return { html, added, removed };
  }

  // Mark which ops touch changed lines so we know where to add context.
  const changed = ops.map(o => o.t !== '=');

  // Build visible set: changed lines ± CONTEXT.
  const visible = new Uint8Array(ops.length);
  for (let k = 0; k < ops.length; k++) {
    if (changed[k]) {
      for (let d = Math.max(0, k-CONTEXT); d <= Math.min(ops.length-1, k+CONTEXT); d++) visible[d] = 1;
    }
  }

  let html = '';
  let added = 0, removed = 0, rows = 0;
  let truncated = false;
  let k = 0;
  while (k < ops.length) {
    if (!visible[k]) {
      // Count how many hidden unchanged rows in a row.
      let skip = 0;
      while (k < ops.length && !visible[k]) { skip++; k++; }
      html += `<div class="diff-skip">↕ ${skip} unchanged line${skip > 1 ? 's' : ''}</div>`;
      continue;
    }
    const op = ops[k];
    // Keep counting +/- for the badge, but stop emitting DOM rows past the cap.
    if (op.t === '=') {
      if (rows < MAX_ROWS) { html += diffRow(' ', 'diff-unchanged', op.ol, op.nl, op.line); rows++; }
      else truncated = true;
    } else if (op.t === '+') {
      added++;
      if (rows < MAX_ROWS) { html += diffRow('+', 'diff-added', null, op.nl, op.line); rows++; }
      else truncated = true;
    } else {
      removed++;
      if (rows < MAX_ROWS) { html += diffRow('-', 'diff-removed', op.ol, null, op.line); rows++; }
      else truncated = true;
    }
    k++;
  }
  if (truncated) {
    html += `<div class="diff-skip">↕ diff truncated — use the editor diff view for the full change</div>`;
  }

  return { html: html || diffRow(' ', 'diff-unchanged', null, null, 'No changes'), added, removed };
}

function diffRow(marker, cls, oldN, newN, line) {
  const ol = oldN != null ? String(oldN).padStart(4) : '    ';
  const nl = newN != null ? String(newN).padStart(4) : '    ';
  return `<div class="diff-line ${cls}"><span class="diff-ln">${ol}</span><span class="diff-ln">${nl}</span><span class="diff-marker">${marker}</span><code>${escapeHtml(line)}</code></div>`;
}

function diffSummary(added, removed) {
  if (added === 0 && removed === 0) return '';
  return `<div class="diff-summary"><span class="diff-count diff-added-count">+${added}</span> <span class="diff-count diff-removed-count">-${removed}</span></div>`;
}

function anchorIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
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
  </svg>`;
}

function userIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="2"/>
    <path d="M4 20c0-4 4-6 8-6s8 2 8 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

function errorIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
    <line x1="12" y1="8" x2="12" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <circle cx="12" cy="16" r="1" fill="currentColor"/>
  </svg>`;
}

// Panel resizes reflow the whole chat: keep the view pinned to the bottom
// (unless the user deliberately scrolled up) and re-fit the composer textarea
// to its new width. rAF-batched — one adjustment per painted frame while the
// user drags the splitter. Guarded for environments without ResizeObserver.
if (typeof ResizeObserver === 'function') {
  let _resizePending = false;
  const _panelObserver = new ResizeObserver(() => {
    if (_resizePending) return;
    _resizePending = true;
    requestAnimationFrame(() => {
      _resizePending = false;
      autoResize();
      if (!userScrolledUp) messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  });
  _panelObserver.observe(document.body);
}

// Initialize — signal readiness so the extension sends all startup state.
setStatus('Loading...');
updateAddButton();
updateSendButton();
vscode.postMessage({ type: 'ready' });

} catch (e) {
  const debugPanel = document.getElementById('debugPanel');
  if (debugPanel) {
    debugPanel.style.display = 'block';
    debugPanel.textContent = 'FATAL ERROR: ' + (e && e.message ? e.message : String(e)) + '\n' + (e && e.stack ? e.stack : '');
  }
  console.error('Navy Coder fatal error:', e);
}