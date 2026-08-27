// Webview HTML shell — extracted from extension.js so the file stays focused and
// the markup is unit-testable. Pure: given the resolved URIs / nonce / version it
// returns the full document string. The extension computes the vscode-specific bits.
//
// Icons come from the inline sprite this file embeds once (see src/icons.js):
// Font Awesome Free paths, bundled, so the panel needs no webfont, no icon CSS
// and no network — and every icon inherits the theme through currentColor
// rather than being a fixed-colour emoji glyph the OS picks for us.
const { spriteHtml, icon } = require('./icons.js');

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
  ${spriteHtml()}
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
        </div>
        <!-- Live status (elastic, mostly hidden) -->
        <div class="topbar-info">
          <span id="diagBadge" class="diag-badge" style="display:none"></span>
          <span id="stepBadge" class="step-badge"></span>
          <span id="queuedBadge" class="queued-badge" style="display:none"></span>
          <span id="statusText" class="status-text"></span>
          <span id="rulesBadge" class="rules-badge" title="Project rules active">RULES</span>
          <span id="tokenCounter" class="token-counter" title="Tokens used"></span>
          <span id="inlineEditBadge" class="inline-edit-badge"></span>
        </div>
        <!-- Chat-level actions. The controls that decide how the next TURN
             behaves live down by the composer instead — see .composer-modes. -->
        <div class="topbar-actions">
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
          <button id="outlineButton" type="button" class="icon-button" title="Chat outline (Ctrl+O)" aria-label="Chat outline" aria-expanded="false" aria-controls="outlinePanel">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <line x1="9" y1="6" x2="20" y2="6"></line>
              <line x1="9" y1="12" x2="20" y2="12"></line>
              <line x1="9" y1="18" x2="20" y2="18"></line>
              <circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none"></circle>
              <circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none"></circle>
              <circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none"></circle>
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
        <select id="projectSelect" title="Project directory" aria-label="Project directory" class="select-project"></select>
        <select id="modelSelect" title="Model" class="select-model" aria-label="Model"></select>
        <!-- Next to the model because it is a property OF the model: populated
             from whatever window the ACTIVE one reports (see
             resolveModelContext / fetchModelContext), rebuilt when the model
             changes, and hidden entirely while no window is known rather than
             offering a guess. "Max · 256k ctx" is meaningless without the model
             it is the max for. -->
        <select id="contextSelect" class="select-compact context-select" title="Context window" aria-label="Context window"></select>
      </div>
      <!-- Row 3: session tabs — one per open project. A background tab's turn
           keeps running (see its spinner) but only the active tab's
           conversation is rendered; switching snaps to that project's
           accumulated state. Part of the topbar (not a separate .app grid
           row) so it lays out exactly like row 1/row 2 above it. -->
      <div id="sessionTabs" class="session-tabs" role="tablist"></div>
    </header>
    <!-- How full the context window is. This was a pair of bare divs whose only
         readable form was a "title" on the inner one — a tooltip on a node that
         cannot take focus, so keyboard and touch users never saw it and assistive
         tech was told nothing at all. It is a progressbar, so it says so, and the
         numbers live in aria-valuetext where they can actually be read. -->
    <div class="context-bar" id="contextBar" role="progressbar"
         aria-label="Context window used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div id="contextBarFill" class="context-bar-fill ok"></div>
    </div>

    <div id="debugPanel" class="debug-panel" style="display:none"></div>

    <!-- Project memory panel (shown when memoryButton is clicked) -->
    <div id="memoryPanel" class="memory-panel" style="display:none">
      <div class="memory-panel-header">
        <span class="memory-panel-title">Project Memory</span>
        <div class="memory-panel-actions">
          <button id="clearMemoryButton" type="button" class="memory-action-btn" title="Clear all memories">Clear all</button>
          <button id="closeMemoryButton" type="button" class="memory-action-btn" title="Close">${icon('close')}</button>
        </div>
      </div>
      <div id="memoryContent" class="memory-content">
        <span class="memory-empty">No memories yet. Navy will remember facts about this project as you work.</span>
      </div>
    </div>

    <!-- Settings panel -->
    <!-- Chat outline. A long conversation is hard to move around in: the only
         way back to something you asked twenty turns ago was to scroll and read.
         This lists the turns — the questions, which are what a conversation is
         actually structured around — and jumps to one. Built from the DOM on
         open rather than kept as a parallel list, so it cannot drift out of step
         with what is on screen. -->
    <div id="outlinePanel" class="outline-panel" style="display:none" aria-label="Chat outline">
      <div class="outline-header">
        <span class="outline-title">Chat outline</span>
        <span id="outlineCount" class="outline-count"></span>
        <button id="outlineClose" type="button" class="memory-action-btn" title="Close" aria-label="Close outline">${icon('close')}</button>
      </div>
      <div id="outlineList" class="outline-list" role="list"></div>
      <p id="outlineEmpty" class="outline-empty" hidden>
        Nothing to jump to yet — the prompts you send appear here, so you can get
        back to any of them without scrolling.
      </p>
    </div>

    <div id="settingsPanel" class="settings-panel" style="display:none">
      <div class="settings-header">
        <span class="settings-title">${icon('settings')} Settings</span>
        <button id="closeSettingsButton" type="button" class="memory-action-btn" title="Close">${icon('close')}</button>
      </div>
      <div class="settings-body">
        <form id="settingsForm">

          <!-- Three sections, because these controls answer three unrelated
               questions: what Navy talks to, how it behaves, and what it does
               with search and speech. They used to run together in one
               undifferentiated column, so finding a field meant reading all of
               them. <fieldset>/<legend> rather than styled divs — a screen
               reader then announces the section when focus enters it. -->
          <fieldset class="setting-section">
            <legend class="setting-legend">Connection</legend>

          <div class="setting-group">
            <label class="setting-label" for="settingProvider">Provider</label>
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
              <option value="moonshot">Moonshot / Kimi</option>
              <option value="qwen">Qwen (DashScope)</option>
              <option value="minimax">MiniMax</option>
              <option value="mimo">Xiaomi MiMo</option>
              <option value="custom">Custom Endpoint</option>
            </select>
          </div>

          <!-- Ollama only: local install vs Ollama Cloud. Cloud needs no local
               install at all, just an API key, so the Host field below is
               hidden for it — navy.host describes a machine-local server and
               is deliberately ignored in cloud mode. -->
          <div class="setting-group" id="settingOllamaModeGroup" style="display:none">
            <label class="setting-label" for="settingOllamaMode">Ollama</label>
            <select id="settingOllamaMode" class="setting-input">
              <option value="local">Local (installed on this machine)</option>
              <option value="cloud">Ollama Cloud (ollama.com — no install needed)</option>
            </select>
            <span class="setting-hint" id="settingOllamaModeHint">Local talks to the server below. Cloud runs large models on ollama.com and only needs an API key.</span>
          </div>

          <div class="setting-group" id="settingHostGroup">
            <label class="setting-label" for="settingHost">Ollama Host</label>
            <input id="settingHost" type="text" class="setting-input" placeholder="http://localhost:11434" />
            <span class="setting-hint">URL where Ollama is running. Change this to connect to a remote server or different port (e.g. http://192.168.1.10:11434).</span>
          </div>

          <div class="setting-group" id="settingApiBaseGroup" style="display:none">
            <label class="setting-label" for="settingApiBase">API Base URL</label>
            <input id="settingApiBase" type="text" class="setting-input" placeholder="" />
            <span class="setting-hint" id="settingApiBaseHint">Base URL for the API endpoint.</span>
          </div>

          <div class="setting-group" id="settingApiKeyGroup" style="display:none">
            <label class="setting-label" for="settingApiKey">API Key</label>
            <input id="settingApiKey" type="password" class="setting-input" placeholder="sk-..." autocomplete="off" />
            <span class="setting-hint">Your API key for this provider. Stored in VS Code's encrypted secrets — each provider keeps its own key.</span>
          </div>
          </fieldset>

          <fieldset class="setting-section">
            <legend class="setting-legend">Search &amp; speech</legend>

          <div class="setting-group">
            <label class="setting-label" for="settingSearchApiKey">Web Search API Key <span class="setting-optional">(optional)</span></label>
            <input id="settingSearchApiKey" type="password" class="setting-input" placeholder="tvly-… (Tavily) or Brave key — empty = DuckDuckGo" autocomplete="off" />
            <span class="setting-hint">Tavily keys (tvly-…) and Brave Search keys are auto-detected. Leave empty to use free DuckDuckGo search.</span>
          </div>

          <!-- Read-aloud. The list is filled in by the webview from the
               voices this renderer actually has (populateVoiceOptions) —
               the extension host cannot see them, and they differ per
               machine, so there is nothing to declare in package.json. -->
          <div class="setting-row">
            <div class="setting-group setting-half">
              <label class="setting-label" for="settingSpeechVoice">Read-aloud Voice</label>
              <select id="settingSpeechVoice" class="setting-select">
                <option value="">Automatic</option>
              </select>
            </div>
            <div class="setting-group setting-half">
              <label class="setting-label" for="settingSpeechRate">Reading Speed</label>
              <input id="settingSpeechRate" type="number" class="setting-input" min="0.5" max="2" step="0.05" placeholder="1" />
            </div>
          </div>
          </fieldset>

          <fieldset class="setting-section">
            <legend class="setting-legend">Behaviour</legend>

          <div class="setting-row">
            <div class="setting-group setting-half">
              <label class="setting-label" for="settingTemperature">Temperature</label>
              <input id="settingTemperature" type="number" class="setting-input" min="0" max="2" step="0.05" placeholder="0.2" />
            </div>
            <div class="setting-group setting-half">
              <label class="setting-label" for="settingMaxIter">Max Tool Iterations</label>
              <input id="settingMaxIter" type="number" class="setting-input" min="1" max="200" step="1" placeholder="50" />
            </div>
          </div>

          <div class="setting-group">
            <label class="setting-label" for="settingEditFormat">Edit Format</label>
            <select id="settingEditFormat" class="setting-select">
              <option value="search-replace">Search / Replace (surgical edits)</option>
              <option value="whole-file">Whole file (full rewrite)</option>
            </select>
          </div>

          <div class="setting-group">
            <label class="setting-label" for="settingSystemPrompt">System Prompt</label>
            <textarea id="settingSystemPrompt" class="setting-textarea" rows="5" placeholder="You are a concise AI coding assistant..."></textarea>
          </div>
          </fieldset>

          <!-- This panel carries the eleven settings you change while working.
               The other seventeen are declared in package.json and edited in
               VS Code's own settings UI, which already has search and sync —
               duplicating them here would mean two places to look and two
               places for them to disagree. -->
          <p class="settings-more">
            More settings — sandboxing, caps, indexing, completions —
            live in <button type="button" id="openVsSettingsLink" class="settings-link">VS Code Settings</button>.
          </p>

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
      <input id="searchInput" type="text" class="search-input" placeholder="Search messages…" aria-label="Search messages" autocomplete="off">
      <span id="searchCount" class="search-count"></span>
      <button id="searchClose" class="search-close" title="Close search">${icon('close')}</button>
    </div>

    <!-- Live shell output panel (shown while run_command is streaming) -->
    <div id="shellPanel" class="shell-panel" style="display:none">
      <div class="shell-panel-header">
        <span class="shell-panel-title">Terminal output</span>
        <button id="shellPanelClose" class="shell-panel-close" title="Dismiss">${icon('close')}</button>
      </div>
      <pre id="shellOutput" class="shell-output"></pre>
    </div>

    <!-- The transcript is wrapped so the two scroll arrows have somewhere to
         anchor. They cannot live inside .messages itself: an absolutely
         positioned child of a scroll container scrolls away with the content.
         The wrapper takes the exact grid slot the section used to occupy. -->
    <div class="messages-wrap">
      <button type="button" id="msgPrev" class="scroll-arrow up" hidden
              title="Previous message (Alt+↑)" aria-label="Previous message">
        <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="3"
             fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 15l6-6 6 6"></path>
        </svg>
      </button>
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
          <button type="button" class="welcome-chip" data-prompt="Review the active file for bugs, edge cases, and improvements.">${icon('review')} Review code</button>
          <button type="button" class="welcome-chip" data-prompt="Edit the active file to ">${icon('edit')} Edit files</button>
          <button type="button" class="welcome-chip" data-prompt="Search the codebase for ">${icon('search')} Search codebase</button>
          <button type="button" class="welcome-chip" data-prompt="Run the test suite and fix any failures.">${icon('gen-tests')} Run tests</button>
          <button type="button" class="welcome-chip" data-prompt="Generate a commit message for my staged changes.">${icon('commit')} Git commit</button>
          <button type="button" class="welcome-chip" data-prompt="Run this project and give me the local URL.">${icon('run')} Run project</button>
        </div>
        <p class="welcome-hint">Type <code>/</code> for commands · paste images · <code>@</code> mention files${version ? ' · <span class="welcome-version">v' + version + '</span>' : ''}</p>

        <!-- Shown only when the model list came back empty or failed. That is
             the most common first-run state, and it used to report itself as
             the word "No models" in a dropdown with the actual error hidden in
             a title tooltip — so the one screen that most needs to tell you
             what to do next was the least informative in the panel. The two
             buttons are the two things that actually resolve it. -->
        <div id="welcomeProblem" class="welcome-problem" hidden>
          <p class="welcome-problem-title">No models available</p>
          <p class="welcome-problem-detail" id="welcomeProblemDetail"></p>
          <div class="welcome-problem-actions">
            <button type="button" id="welcomeTestBtn" class="welcome-problem-btn primary">Test connection</button>
            <button type="button" id="welcomeSettingsBtn" class="welcome-problem-btn">Open settings</button>
          </div>
        </div>
      </div>
    </section>
      <button type="button" id="msgNext" class="scroll-arrow down" hidden
              title="Next message (Alt+↓)" aria-label="Next message">
        <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="3"
             fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6"></path>
        </svg>
      </button>
    </div>

    <div class="composer-wrap">
      <!-- Autoscroll stops the moment you scroll up, which is right — it must
           not yank you away from something you are reading. But there was then
           no way back and no sign anything was still arriving, so scrolling up
           during a long turn stranded you. Shown only while away from the
           bottom, and it counts what landed meanwhile. Lives inside
           .composer-wrap so "bottom: 100%" parks it directly above the composer
           however tall the textarea has grown. -->
      <!-- Centred above the composer, on its own now that the step arrows have
           moved to the ends of the scrollbar. -->
      <!-- Anything still running, docked where it cannot scroll away. The card
           in the transcript stays exactly where it happened — that is the
           record of when it started — but a dev server you launched twenty
           replies ago scrolls out of reach, and its Stop button with it. This
           mirrors the live ones only, and empties itself as they end. -->
      <div id="taskDock" class="task-dock" hidden aria-live="polite"></div>
      <div class="chat-nav">
        <button type="button" id="jumpLatest" class="jump-latest" hidden>
          <span id="jumpLatestText">Jump to latest</span>
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.4"
               fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 9l6 6 6-6"></path>
          </svg>
        </button>
      </div>
      <form id="chatForm" class="composer">
        <input type="file" id="fileAttachInput" multiple hidden>
        <div class="input-area">
          <!-- role="combobox" because this box does control a popup listbox:
               typing "/" opens the command menu and "@" opens the file menu,
               both role="listbox" with role="option" children. Without the role
               the two menus were orphaned from the input that drives them —
               nothing announced that a menu had opened, and arrowing through it
               announced nothing either, because aria-activedescendant is only
               honoured on a combobox and the options had no ids to point at.
               A multiline textarea carrying this role is the same construction
               GitHub's own @-mention composer uses. aria-expanded is kept in
               sync by syncComboboxState() in main.js. The placeholder is not a
               label, hence aria-label as well. -->
          <textarea id="prompt" rows="1"
            aria-label="Ask Navy to code, edit, or run commands"
            role="combobox" aria-expanded="false" aria-autocomplete="list" aria-haspopup="listbox"
            placeholder="Ask Navy to code, edit, or run commands..."></textarea>
          <div class="input-meta">
            <div class="file-chips" id="fileChips">
              <button type="button" id="addContextButton" class="chip chip-add" title="Add current file to context">+ Add file</button>
            </div>
            <!-- How the next message will be handled: how much context it may
                 use, how hard to think, and what Navy may do without asking.
                 One group, in the empty middle of a row that already existed,
                 reading left to right in the order you would decide them. -->
            <div class="composer-modes">
              <select id="thinkingLevelSelect" title="Thinking depth" aria-label="Thinking depth" class="select-compact">
                <option value="fast">Fast</option>
                <option value="medium" selected>Med</option>
                <option value="high">High</option>
              </select>
              <span class="composer-modes-sep" aria-hidden="true"></span>
              <select id="approvalModeSelect" title="Approval for file changes — writes, deletes and renames" aria-label="Approval for file changes" class="select-compact">
                <option value="ask-always">Edits: Ask</option>
                <option value="auto-approve">Edits: Auto</option>
              </select>
              <select id="commandApprovalSelect" title="Approval for running commands, background processes and MCP tools" aria-label="Approval for running commands" class="select-compact">
                <option value="ask-always">Cmds: Ask</option>
                <option value="auto-approve">Cmds: Auto</option>
              </select>
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
              <!-- Dictation. Unhidden by the script, which is also the only
                   place that knows what pressing it does — recognition happens
                   in the user's browser (src/dictation-bridge.js), so nothing
                   about this renderer decides whether it can work. Recognised
                   text goes into the box above for review; it is never sent
                   automatically. There is deliberately no pause control: the
                   browser's recogniser has none, and faking it by restarting
                   the engine lost whatever was said across the gap. -->
              <button type="button" id="micButton" class="attach-button mic-button" title="Dictate a message" aria-label="Dictate a message" hidden>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="23"/>
                </svg>
              </button>
              <span id="micStatus" class="mic-status" hidden></span>
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
      <button id="lightboxClose" class="lightbox-close" title="Close (Esc)">${icon('close')}</button>
    </div>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

module.exports = { getWebviewHtml };
