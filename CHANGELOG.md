# Changelog

## [0.2.0] - 2026-07-05

### Fixed — data safety
- **Critical:** editing a file larger than 12 KB no longer truncates it — edit paths and undo checkpoints now always operate on the full file contents
- In-chat Approve/Reject buttons on edit diff cards now work (previously only the native toast applied the edit); dismissing the toast no longer stalls the agent
- API keys are stored per provider and are no longer overwritten with a masked value when saving settings without retyping the key
- Fuzzy edits preserve the file's original line endings (CRLF files stay CRLF)
- Deleting folders works (recursive delete, to Recycle Bin) and respects auto-approve mode

### Added
- LSP-backed `find_symbol` and `find_references` tools
- Automatic post-edit verification: fresh diagnostics for every edited file are fed back to the model
- Plan-first prompting: multi-step tasks start with a visible numbered plan
- Real thinking control: Anthropic extended thinking, OpenAI o-series `reasoning_effort`, Ollama `think` for reasoning models
- Web search providers: Tavily and Brave Search (auto-detected by key), DuckDuckGo fallback
- Task report after every run: files changed, deletions, commands with exit status
- Keyboard navigation (arrows / Enter / Tab) in slash-command and @-mention dropdowns
- Whole-message copy button on assistant replies
- Clickable welcome-screen quick-start chips
- First-run welcome notification pointing to the sidebar
- Project folder choice persists across window reloads

### Fixed — reliability & UX
- Clicking the Navy icon now opens the sidebar even before its first use
- Long multi-step tasks no longer abort at exactly 3 minutes
- Same failing command is blocked after repeated failures; duplicate file reads are short-circuited
- Dev servers are no longer duplicated or orphaned; full process-tree kill on stop and on window close
- Welcome screen reappears after "New chat"
- Light-theme support: accents follow the active VS Code theme
- Switching to auto-approve asks for confirmation once
- o-series OpenAI models no longer fail (temperature parameter removed for them)
- Fuzzy matching for `apply_edit` tolerates line-ending and indentation drift

## [0.1.0] - 2026-07-01

### Added
- Activity-bar sidebar with chat UI and streaming markdown rendering
- Multi-provider support: Ollama, LM Studio, Anthropic, OpenAI, DeepSeek, Gemini, xAI, Groq, OpenRouter, custom endpoints
- Agentic tool-use loop: read files, list directories, search workspace, run shell commands
- SEARCH/REPLACE and whole-file edit modes with diff-card approval gate
- Auto-approve mode for unattended file edits
- Inline code completions powered by the configured model
- Background task runner for long-running commands
- Project session persistence and memory panel
- Code lens "Ask Navy" buttons above functions
- Undo last edit / undo last turn commands
- Generate commit message and PR description commands
- Wheel icon with light-blue branding (#58a6ff)
