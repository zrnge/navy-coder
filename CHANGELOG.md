# Changelog

## [0.2.1] - 2026-07-15

### Added
- Terminal IN/OUT cards: every `run_command` / `run_tests` gets its own card in the chat — command in, live output out (stderr tinted), status chip (exit 0 / failed / timeout / rejected), long output collapses behind "Click to expand"
- Applied edits keep an expandable diff preview (changed lines in red/green) instead of collapsing to a bare "Applied" line
- `rename_file` tool — moves/renames within the workspace with approval gating
- Ripgrep-backed `search_codebase` / `search_files`: full-tree, `.gitignore`-aware, much faster (JS walk remains as fallback)
- Undo survives window reloads — checkpoints persist per project
- Mid-turn context compaction: long agent tasks prune old tool output instead of overflowing the model's context window
- Automatic retry with backoff on rate limits (429) and transient 5xx errors for all providers
- Restored sessions show a per-turn summary of changed files and commands
- **Redo** — reverse an accidental undo (button next to Undo, `Ctrl+Alt+Shift+Z`); redo history is cleared when new edits land so it can never clobber newer work
- **Transactional undo**: renames and single-file deletions are now undoable too, and undo asks before discarding edits you made by hand after Navy's write
- **Session digest**: long conversations condense their oldest turns into a summary instead of forgetting them
- File writes from the main chat and `/bg` background tasks are serialized — no more interleaved edits to the same file
- Real test suite (`npm test`): 32 checks covering the edit engine, context compaction, markdown rendering, and a full simulated webview conversation
- Version number shown on the welcome screen

### Fixed
- "Generate Commit Message" and "Generate PR Description" now work with every provider (previously Ollama-only)
- Stop button shows a proper stop icon and turns red while Navy is working (send/stop icons were rendering stacked)
- Smooth chat motion: entrance transitions for messages and cards, frame-synced scrolling, no more bouncing during streaming
- Stop now also halts tools already queued in the current step (a write could previously still land after Stop)
- Inline code like `snake_case_names` is no longer mangled by italic formatting
- `fetch_url` re-validates every redirect hop (SSRF hardening)
- Token counter works for OpenAI-compatible providers; mid-stream provider errors are reported instead of "No response received"
- Diff and terminal cards no longer collapse into thin lines in long chats (flexbox was crushing overflow-hidden cards)
- False "Navy stopped responding" during long tasks eliminated — the extension heartbeats every 30s and the UI only alarms after 4 minutes of true silence
- Model reasoning (`<think>` blocks) is hidden behind a "💭 Reasoning…" indicator while streaming instead of flooding the chat; finished reasoning stays in a collapsed dropdown
- Model dropdown keeps manually configured model names for cloud providers
- `.navy/` session data is excluded from git automatically

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
