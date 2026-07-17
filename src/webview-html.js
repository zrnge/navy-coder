// Webview HTML shell — extracted from extension.js so the file stays focused and
// the markup is unit-testable. Pure: given the resolved URIs / nonce / version it
// returns the full document string. The extension computes the vscode-specific bits.
function getWebviewHtml({ scriptUri, styleUri, cspSource, nonce, version }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data: blob:; connect-src 'none';">
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
          <button id="redoButton" type="button" class="icon-button" title="Redo (reverse last undo)" aria-label="Redo last undone edit" disabled>
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 7v6h-6"></path>
              <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"></path>
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
              <input id="settingMaxIter" type="number" class="setting-input" min="1" max="200" step="1" placeholder="50" />
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
        <p class="welcome-hint">Type <code>/</code> for commands · paste images · <code>@</code> mention files${version ? ' · <span class="welcome-version">v' + version + '</span>' : ''}</p>
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

module.exports = { getWebviewHtml };
