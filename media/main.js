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
const projectSelect = document.querySelector('#projectSelect');
const approvalQueue = document.querySelector('#approvalQueue');
const approvalModeSelect = document.querySelector('#approvalModeSelect');
const thinkingLevelSelect = document.querySelector('#thinkingLevelSelect');
const contextLengthEl = document.querySelector('#contextLength');
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
  console.log('[Navy Coder]', text);
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

document.getElementById('commitButton')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'runCommand', command: 'navy.generateCommit' });
});
document.getElementById('prButton')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'runCommand', command: 'navy.generatePR' });
});
document.getElementById('testButton')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'runCommand', command: 'navy.runTests' });
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
  projectSelect.dataset.lastValue = projectSelect.value;
  vscode.postMessage({ type: 'setProjectRoot', root: projectSelect.value });
});

undoButton?.addEventListener('click', () => {
  vscode.postMessage({ type: 'undoLast' });
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

clearMemoryButton?.addEventListener('click', () => {
  if (confirm('Clear all project memories? This cannot be undone.')) {
    vscode.postMessage({ type: 'clearMemory' });
  }
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

const PROVIDER_DEFAULTS = {
  ollama:     { base: '',                                                  needsKey: false, basePlaceholder: '',                                              baseHint: '' },
  lmstudio:   { base: 'http://localhost:1234/v1',                         needsKey: false, basePlaceholder: 'http://localhost:1234/v1',                      baseHint: 'LM Studio local server URL. Change port if needed.' },
  anthropic:  { base: '',                                                  needsKey: true,  basePlaceholder: 'https://api.anthropic.com (optional)',          baseHint: 'Leave blank to use the default Anthropic endpoint.' },
  openai:     { base: '',                                                  needsKey: true,  basePlaceholder: 'https://api.openai.com/v1 (optional)',          baseHint: 'Leave blank to use the default OpenAI endpoint.' },
  deepseek:   { base: '',                                                  needsKey: true,  basePlaceholder: 'https://api.deepseek.com/v1 (optional)',        baseHint: 'Leave blank to use the default DeepSeek endpoint.' },
  gemini:     { base: '',                                                  needsKey: true,  basePlaceholder: 'https://generativelanguage.googleapis.com/... (optional)', baseHint: "Leave blank to use Google's OpenAI-compatible endpoint." },
  xai:        { base: '',                                                  needsKey: true,  basePlaceholder: 'https://api.x.ai/v1 (optional)',               baseHint: 'Leave blank to use the default xAI Grok endpoint.' },
  zai:        { base: 'https://api.z.ai/v1',                             needsKey: true,  basePlaceholder: 'https://api.z.ai/v1',                           baseHint: 'z.ai API base URL.' },
  groq:       { base: '',                                                  needsKey: true,  basePlaceholder: 'https://api.groq.com/openai/v1 (optional)',     baseHint: 'Leave blank to use the default Groq endpoint.' },
  openrouter: { base: '',                                                  needsKey: true,  basePlaceholder: 'https://openrouter.ai/api/v1 (optional)',       baseHint: 'Leave blank to use the default OpenRouter endpoint.' },
  custom:     { base: '',                                                  needsKey: false, basePlaceholder: 'https://your-server.example.com/v1',            baseHint: 'Full base URL of your OpenAI-compatible API endpoint.' },
};

function updateSettingsFieldVisibility(isProviderChange) {
  const p = settingProvider?.value || 'ollama';
  const info = PROVIDER_DEFAULTS[p] || PROVIDER_DEFAULTS.custom;

  if (settingHostGroup) settingHostGroup.style.display = p === 'ollama' ? '' : 'none';
  if (settingApiBaseGroup) settingApiBaseGroup.style.display = p !== 'ollama' ? '' : 'none';
  if (settingApiKeyGroup)  settingApiKeyGroup.style.display  = info.needsKey  ? '' : 'none';

  if (settingApiBase) settingApiBase.placeholder = info.basePlaceholder;
  const hintEl = document.querySelector('#settingApiBaseHint');
  if (hintEl) hintEl.textContent = info.baseHint;

  if (isProviderChange && settingApiBase && info.base) {
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
  const settings = {
    provider:     settingProvider?.value     || 'ollama',
    host:         settingHost?.value         || 'http://localhost:11434',
    apiBase:      settingApiBase?.value      || '',
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

window.addEventListener('message', (event) => {
  try {
  const message = event.data;

  if (message.type === 'start') {
    flushAssistantText();
    setBusy(true);
    activeAssistantMessage = addMessage('assistant', '');
    activeAssistantBubble = activeAssistantMessage.querySelector('.message-bubble');
    activeAssistantContent = '';
    activeFilePath = message.activeFile || '';
    updateWelcome();
    // Clear shell output from previous turn.
    if (shellOutput) shellOutput.textContent = '';
    if (shellPanel) shellPanel.style.display = 'none';
    // Show an initial "Thinking" row — replaced by real tool rows as they arrive.
    addToolCallCard('__thinking__', {});
    const thinkingRow = currentActivityRowEl;
    if (thinkingRow) thinkingRow.classList.add('thinking-row');
  }

  if (message.type === 'chunk') {
    // First chunk means the model is responding directly — discard the Thinking placeholder.
    if (activityLogEl) {
      const placeholder = activityLogEl.querySelector('.thinking-row');
      if (placeholder) placeholder.remove();
      // If the log is now empty, remove it entirely so it doesn't show a ghost border.
      if (!activityLogEl.children.length) { activityLogEl.remove(); activityLogEl = null; }
    }
    appendAssistantText(message.text);
  }

  if (message.type === 'done' || message.type === 'aborted') {
    flushAssistantText();
    setBusy(false);
    if (activeAssistantContent.trim() === '' && activeAssistantMessage) {
      // No text was generated — remove the empty bubble entirely so the UI doesn't
      // show a blank assistant turn. Tool-call cards are appended to messagesEl directly
      // and remain visible regardless.
      activeAssistantMessage.remove();
      activeAssistantMessage = null;
    } else {
      lastAssistantMessage = activeAssistantMessage;
      activeAssistantMessage = null;
    }
    activeAssistantBubble = null;
    activeAssistantContent = '';
    if (stepBadgeEl) { stepBadgeEl.textContent = ''; stepBadgeEl.classList.remove('visible'); }
    collapseToolProgress();
    updateWelcome();
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
    activeAssistantMessage = null;
    activeAssistantBubble = null;
    activeAssistantContent = '';
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

  if (message.type === 'cleared') {
    // Unlock the UI first — clearing mid-turn must not leave the input locked.
    setBusy(false);
    activeAssistantMessage = null;
    activeAssistantBubble = null;
    activeAssistantContent = '';
    activityLogEl = null;
    currentActivityRowEl = null;
    messagesEl.innerHTML = '';
    messagesEl.appendChild(welcomeEl); // innerHTML='' detaches it — re-attach or it never shows again
    welcomeEl.classList.remove('hidden');
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
      button.textContent = 'Applied';
      button.disabled = true;
    }
  }

  if (message.type === 'toolCall') {
    addToolCallCard(message.tool, message.args);
    const verb = TOOL_VERB[message.tool] || message.tool;
    if (statusText) statusText.textContent = `${verb}…`;
  }

  if (message.type === 'toolResult') {
    addToolResultCard(message.tool, message.result);
    if (statusText) statusText.textContent = 'Working…';
  }

  if (message.type === 'pendingDiff') {
    addPendingDiffCard(message.id, message.path, message.oldText, message.newText);
  }

  if (message.type === 'pendingCommand') {
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
  }

  if (message.type === 'diffResolved') {
    const card = document.querySelector(`.diff-card[data-diff-id="${message.id}"]`);
    if (card) {
      // Remove the action buttons and the full diff body — no longer needed.
      card.querySelector('.diff-actions')?.remove();
      card.querySelector('.diff-body')?.remove();
      card.querySelector('.diff-summary')?.remove();
      const status = card.querySelector('.diff-status');
      if (status) status.textContent = message.approved ? '✓ Applied' : '✕ Rejected';
      card.classList.add(message.approved ? 'is-approved' : 'is-rejected');
    }
  }

  if (message.type === 'checkpoints') {
    if (undoButton) undoButton.disabled = !(message.count > 0);
  }

  if (message.type === 'workspaceFolders') {
    populateProjects(message.roots, message.current);
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

  if (message.type === 'contextLength') {
    if (contextLengthEl) {
      const k = Math.round(message.length / 1024);
      contextLengthEl.textContent = k + 'k ctx';
      contextLengthEl.title = 'Model context window: ' + message.length.toLocaleString() + ' tokens';
    }
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

  if (message.type === 'sessionLoaded') {
    updateWelcome();
    updateMemoryBadge(message.memory || '');
    if (message.count > 0) {
      addSystemMessage('Session restored — ' + message.count + ' messages from previous session.');
    }
  }

  if (message.type === 'memoryUpdated') {
    updateMemoryPanel(message.memory || '');
    updateMemoryBadge(message.memory || '');
  }

  if (message.type === 'tokenCount') {
    if (tokenCounterEl) {
      tokenCounterEl.textContent = message.total.toLocaleString() + ' tok';
      tokenCounterEl.title = `Prompt: ${message.prompt.toLocaleString()} + Completion: ${message.completion.toLocaleString()} tokens`;
      tokenCounterEl.classList.add('visible');
    }
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
    const panel = document.getElementById('shellPanel');
    const output = document.getElementById('shellOutput');
    if (panel && output) {
      panel.style.display = '';
      output.textContent += message.chunk;
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
  const refs = msg.status === 'start'
    ? getOrCreateBgTaskEl(msg.taskId, msg.prompt || '')
    : bgTaskEls.get(msg.taskId);
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
      </div>
      <pre class="bg-process-output"></pre>`;
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
  const refs = bgProcessPanels.get(id);
  if (!refs) return;
  refs.statusEl.className = exitCode === 0 ? 'bg-task-status done' : 'bg-task-status error';
  refs.statusEl.textContent = exitCode === 0 ? `✓ exited (0)` : `✕ exited (${exitCode})`;
  bgProcessPanels.delete(id);
}

// ── Run-project persistent card ───────────────────────────────────────────────

let runProjectCardEl = null;

function showRunProjectCard(projectName, command) {
  // Remove any existing card first.
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

  messagesEl.appendChild(card);
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
  if (!runProjectCardEl) return;
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
  runProjectCardEl = null;
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

function setBusy(busy) {
  if (busyWatchdog) { clearTimeout(busyWatchdog); busyWatchdog = null; }
  isBusy = busy;
  const sendIcon = document.querySelector('#sendIcon');
  const stopIcon = document.querySelector('#stopIcon');
  if (sendIcon) sendIcon.hidden = busy;
  if (stopIcon) stopIcon.hidden = !busy;
  sendButton.title = busy ? 'Stop' : 'Send';
  if (stopButton) stopButton.style.display = busy ? '' : 'none';
  if (clearButton) clearButton.style.display = busy ? 'none' : '';
  includeContext.disabled = busy;
  document.querySelector('.app')?.classList.toggle('is-thinking', busy);
  updateAddButton();
  updateSendButton();
  if (statusText) statusText.textContent = busy ? 'Working…' : '';
  if (busy) {
    // Auto-unlock if the backend crashes and never sends 'done' (4 min > backend's 3-min watchdog)
    busyWatchdog = setTimeout(() => {
      busyWatchdog = null;
      // Clear stale assistant state before unlocking so the next turn starts clean.
      flushAssistantText();
      activeAssistantMessage = null;
      activeAssistantBubble = null;
      activeAssistantContent = '';
      setBusy(false);
      collapseToolProgress();
      addMessage('error', 'Navy stopped responding. If this keeps happening try Ctrl+Shift+P → "Developer: Reload Window".');
    }, 4 * 60 * 1000);
  } else {
    if (queuedBadge) { queuedBadge.style.display = 'none'; queuedBadge.textContent = ''; }
    promptInput.focus();
  }
}

function updateWelcome() {
  const hasMessages = messagesEl.querySelectorAll('.message').length > 0;
  welcomeEl.classList.toggle('hidden', hasMessages);
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
  for (const item of history) {
    if (!item.text?.trim()) continue; // skip empty tool-only iterations
    if (item.role === 'user')      addMessage('user',      item.text);
    else if (item.role === 'assistant') addMessage('assistant', item.text);
  }
}

function populateProjects(roots, current) {
  if (!projectSelect) return;
  projectSelect.innerHTML = '';

  if (!roots || roots.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No workspace';
    projectSelect.appendChild(option);
  } else {
    for (const root of roots) {
      const option = document.createElement('option');
      option.value = root;
      option.textContent = root.replace(/^.*[\/]/, '');
      option.title = root;
      if (root === current) option.selected = true;
      projectSelect.appendChild(option);
    }
  }

  const addOption = document.createElement('option');
  addOption.value = '__add_folder__';
  addOption.textContent = '+ Add folder...';
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
    item.title = a.path;
    list.appendChild(item);
  }
  approvalQueue.appendChild(badge);
  approvalQueue.appendChild(list);
}

function populateModels(models, current, error) {
  const previous = modelSelect.value || current;
  modelSelect.innerHTML = '';

  if (error || models.length === 0) {
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
  for (const name of models) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    if (name === current || name === previous) {
      option.selected = true;
    }
    modelSelect.appendChild(option);
  }
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
      vscode.postMessage({ type: 'copy', text: bubble.dataset.rawMd || bubble.textContent || '' });
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

// Streaming render state
let _streamPre = null;    // <pre> shown live during streaming (raw text, O(1) append)
let _streamTimer = null;  // throttle timer for scroll-to-bottom during streaming

function appendAssistantText(text) {
  if (!activeAssistantMessage) {
    activeAssistantMessage = addMessage('assistant', '');
    activeAssistantBubble = activeAssistantMessage.querySelector('.message-bubble');
    activeAssistantContent = '';
  }

  activeAssistantContent += text;

  // During streaming: show raw text via textContent — O(1), no innerHTML churn,
  // no layout reflow, no markdown parsing. Final render happens in flushAssistantText.
  if (!_streamPre) {
    _streamPre = document.createElement('pre');
    _streamPre.className = 'streaming-pre';
    activeAssistantBubble.innerHTML = '';
    activeAssistantBubble.appendChild(_streamPre);
  }
  _streamPre.textContent = activeAssistantContent;

  // Throttle scroll-to-bottom so it doesn't trigger layout on every chunk.
  if (!_streamTimer) {
    _streamTimer = setTimeout(() => {
      _streamTimer = null;
      scrollToBottom();
    }, 80);
  }
}

function flushAssistantText() {
  // Cancel pending scroll timer.
  if (_streamTimer) { clearTimeout(_streamTimer); _streamTimer = null; }
  _streamPre = null;

  if (!activeAssistantBubble || !activeAssistantContent) return;
  // Single full markdown render now that streaming is complete.
  activeAssistantBubble.dataset.rawMd = activeAssistantContent; // for the copy-message button
  const rendered = renderMarkdown(activeAssistantContent);
  if (rendered || !activeAssistantBubble.innerHTML) {
    activeAssistantBubble.innerHTML = rendered;
    attachCodeBlockActions(activeAssistantBubble);
  }
  scrollToBottom();
}

function addSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'system-notice';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
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

function scrollToBottom() {
  if (!userScrolledUp) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
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

function renderMarkdown(text) {
  // Normalize line endings first — models on some backends emit \r\n.
  let cleaned = text
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/<tool\s+name="[^"]*"[^>]*>[\s\S]*?(?:<\/tool\s*>|<\|tool_call_end\|>)/g, '')
    .replace(/<\|tool_calls_section_(?:start|end)\|>/g, '')
    .trim();

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
  const codeRe = /(?:^|\n)(`{3,})([\w.+\-]*)(?::([^\s\n]+))?[^\n]*\n([\s\S]*?)\n\1[ \t]*(?=$|\n)/g;
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

  while (i < lines.length) {
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
    const pLines = [];
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
  h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/__(.+?)__/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/_([^_]+)_/g, '<em>$1</em>');
  h = h.replace(/~~(.+?)~~/g, '<del>$1</del>');
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
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
  delete_file: 'Deleting', apply_edit: 'Editing', edit_line: 'Editing',
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

let activityLogEl = null;
let currentActivityRowEl = null;

function getOrCreateActivityLog() {
  if (!activityLogEl) {
    activityLogEl = document.createElement('div');
    activityLogEl.className = 'activity-log';
    // Attach inside the active assistant message so it's visually grouped with
    // the response it belongs to, not floating between turns in the stream.
    const parent = activeAssistantMessage || messagesEl;
    parent.appendChild(activityLogEl);
  }
  return activityLogEl;
}

function removeToolProgress() {
  if (activityLogEl) { activityLogEl.remove(); activityLogEl = null; }
  currentActivityRowEl = null;
}

function collapseToolProgress() {
  if (!activityLogEl) { currentActivityRowEl = null; return; }
  // Remove any leftover "Thinking" placeholder
  activityLogEl.querySelector('.thinking-row')?.remove();
  const rows = activityLogEl.querySelectorAll('.activity-row');
  if (rows.length === 0) {
    activityLogEl.remove();
    activityLogEl = null;
    currentActivityRowEl = null;
    return;
  }
  const errors = activityLogEl.querySelectorAll('.is-error').length;
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
  activityLogEl.innerHTML = '';
  activityLogEl.appendChild(details);
  activityLogEl = null;
  currentActivityRowEl = null;
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

function addToolCallCard(tool, args) {
  // Remove the "Thinking" placeholder row when a real tool call arrives.
  if (tool !== '__thinking__' && activityLogEl) {
    const placeholder = activityLogEl.querySelector('.thinking-row');
    if (placeholder) placeholder.remove();
  }

  const verb   = TOOL_VERB[tool] || tool;
  const target = args.path || args.directory || args.query || args.command || args.id || args.url || args.fact || args.name || '';
  const fname  = target ? target.replace(/^.*[\\/]/, '') : '';

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

  log.appendChild(row);
  currentActivityRowEl = row;
  scrollToBottom();
}

function addToolResultCard(tool, result) {
  const row = currentActivityRowEl;
  if (!row) return;

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
      <span class="diff-filename" title="${escapeHtml(filePath)}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-1px;margin-right:5px;opacity:0.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>${escapeHtml(fname)}</span>
      ${fdir ? `<span class="diff-filepath">${escapeHtml(fdir)}</span>` : ''}
      ${badgeHtml}
    </div>
    <span class="diff-status">Review required</span>`;
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

  messagesEl.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  userScrolledUp = false;
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

  messagesEl.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  userScrolledUp = false;
}

// ── LCS-based unified diff ────────────────────────────────────────────────────

function computeLCS(a, b) {
  const m = a.length, n = b.length;
  // For large files, cap context to avoid O(mn) freeze.
  if (m * n > 400000) return null;
  const dp = new Uint32Array((m + 1) * (n + 1));
  const W = n + 1;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i * W + j] = a[i-1] === b[j-1]
        ? dp[(i-1) * W + (j-1)] + 1
        : Math.max(dp[(i-1) * W + j], dp[i * W + (j-1)]);
    }
  }
  // Backtrack
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      ops.push({ t: '=', line: a[i-1], ol: i, nl: j }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i * W + (j-1)] >= dp[(i-1) * W + j])) {
      ops.push({ t: '+', line: b[j-1], nl: j }); j--;
    } else {
      ops.push({ t: '-', line: a[i-1], ol: i }); i--;
    }
  }
  return ops.reverse();
}

function renderDiff(oldText, newText) {
  const CONTEXT = 3;
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const ops = computeLCS(oldLines, newLines);

  // Fall back to simple sequential diff for very large files.
  if (!ops) {
    let html = '', added = 0, removed = 0;
    const max = Math.max(oldLines.length, newLines.length);
    for (let k = 0; k < max; k++) {
      if (k < oldLines.length && k < newLines.length && oldLines[k] === newLines[k]) {
        html += diffRow(' ', 'diff-unchanged', null, null, oldLines[k]);
      } else {
        if (k < oldLines.length) { html += diffRow('-', 'diff-removed', k+1, null, oldLines[k]); removed++; }
        if (k < newLines.length) { html += diffRow('+', 'diff-added',   null, k+1, newLines[k]); added++; }
      }
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
  let added = 0, removed = 0;
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
    if (op.t === '=') {
      html += diffRow(' ', 'diff-unchanged', op.ol, op.nl, op.line);
    } else if (op.t === '+') {
      html += diffRow('+', 'diff-added',   null, op.nl, op.line); added++;
    } else {
      html += diffRow('-', 'diff-removed', op.ol, null, op.line); removed++;
    }
    k++;
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

// Initialize — signal readiness so the extension sends all startup state.
console.log('Navy Coder webview script loaded');
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