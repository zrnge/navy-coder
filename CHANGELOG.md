# Changelog

## [0.2.4] - 2026-07-19

### Added
- **Native Gemini provider path** — Gemini 2.5/3.x models always attach a `thoughtSignature` to tool calls and Google requires it echoed back, a field the OpenAI-compatibility shim has no way to carry (this was the "Function call is missing a thought_signature" error). Those specific models now route through Gemini's native streaming API with full thought-signature round-tripping; older/non-thinking Gemini models (1.5, 2.0-flash) are untouched and keep using the proven shim.
- **MCP streamable-HTTP/SSE transport** — `navy.mcpServers` entries can now be `{ "name": { "url": "https://..." } }` for a remote MCP server, in addition to the existing local `{ "command": ... }` form. Handles both JSON and SSE response modes and session-id propagation per the MCP spec.
- **`search_docs` tool** — searches the project's own README/CHANGELOG/CONTRIBUTING/`docs/**` for a term, so the agent checks existing documentation before guessing at conventions or setup steps.
- **Interactive plan checklist** — when the model states a `**Plan:**` for a multi-step task, it now renders as a live checklist card (pending → active → done) instead of plain text, with steps ticking off as the agent works through them.
- **Weak-model prompt reinforcement** — models whose name suggests a small/local model (parameter-count tags like `:7b`, or `mini`/`nano`/`tiny` branding) get an extra, maximally explicit restatement of the anti-hallucination rule appended to their system prompt.
- **OpenRouter model dropdown grouped by vendor** — "vendor/model"-style lists now render as `<optgroup>`s (openai, anthropic, google, …) instead of one long flat list; ordinary provider lists are unaffected.

### Fixed
- **Hallucinated file actions** — small/local models that can't reliably emit tool calls would fall back to plain chat behavior: print code, then say "done, file created" without ever calling a tool, and Navy trusted that claim. Navy now detects a false completion claim (a description of a file being created/saved/updated with no tool call this turn AND only when the user's request actually asked for a file action, to avoid false positives on Q&A), gives the model one correction chance to actually call the tool, and — if it still can't — shows the user a clear warning instead of silently displaying a lie. The system prompt also now explicitly forbids claiming a file action without calling the corresponding tool.
- **`navy.systemPrompt` was a dead setting** — visible in Settings, saved, but never actually sent to the model. Now wired in as a genuine "user preferences" section appended after the mandatory tool-use rules (so it can't override them). The legacy default value (pre-agentic-loop SEARCH/REPLACE instructions, which directly contradicted the fix above) is no longer shipped or sent.
- **Removed a fictitious default model** (`kimi-k2.7-code:cloud`) that most users don't have pulled — `navy.model` now defaults to empty and auto-selects the first real model for whichever provider is active, the same self-healing path already used when switching providers.
- **Infinite edit loop on the same file** — a model could get stuck re-editing one file dozens of times in a single turn (seen live as 16+ consecutive "✓ Applied" cards for the same file with no end in sight). Root cause: fresh LSP diagnostics were unconditionally re-injected after *every* write with no cap, so if a fix never fully resolved the diagnostic it was chasing, the model just kept "fixing" it forever. Navy now tracks edits-per-file within a turn: a stern one-time nudge to stop and finish() fires at the 5th edit, diagnostics stop being fed back after that (removing the likely driver of the loop), and any further write to that file past the 10th is hard-blocked for the rest of the turn with a clear explanation. Verified end-to-end: nudge fires exactly once, diagnostics go silent, the 11th attempt is blocked and never touches the file, and the turn still reaches a normal finish instead of running to the iteration cap.
- **MCP tool calls no longer silently dropped** for models using the JSON-fallback parsing path (small/local models) — the fallback only recognized Navy's built-in tools by name, so a valid `mcp__server__tool` call was discarded.
- **Anthropic prompt caching has a safety fallback** — if a proxy or API version rejects the `cache_control` field, Navy now retries once without caching instead of failing the turn; an unrelated 400 is never masked by this retry.
- **Newest Claude models (e.g. claude-opus-4-7) rejected every request** — those generations dropped the legacy `thinking: {type:'enabled', budget_tokens}` shape and `temperature` entirely, wanting `thinking: {type:'adaptive'}` + `output_config.effort` instead, so every message 400'd. Rather than hardcode which model generation needs which shape (guaranteed to go stale the moment Anthropic ships another one), Navy now detects these two error signatures at runtime and retries once with the adaptive shape — same pattern as the existing cache_control fallback. An unrelated 400 is never masked by this retry.
- Background-task (`/bg`) error messages now show the provider's proper name ("OpenAI") instead of the raw setting value ("openai") — the display-name map existed in only one of the two error paths.

### Changed
- `_rawBlocks` (thinking/tool-use replay state) is now tagged with its producing provider — prevents a latent bug where switching providers mid-conversation (e.g. Gemini-thinking → Anthropic) could replay one provider's raw blocks into another's request.

## [0.2.3] - 2026-07-18

### Added
- **MCP client** — Navy can now use external MCP (Model Context Protocol) tool servers, the same ecosystem Claude Desktop/Cursor/Roo use. Configure `navy.mcpServers` (Claude Desktop format: `{ "name": { "command": …, "args": […] } }`); each server's tools appear to the agent as `mcp__<server>__<tool>`, approval-gated in ask mode, hot-reloaded when the setting changes. Stdio transport, tools-only, failures never break Navy.
- **Anthropic prompt caching** — the static prefix (system prompt + tool schemas) and the newest message are marked as cache breakpoints, so multi-step turns on Claude are billed at ~10% for the repeated prefix and stream noticeably faster from the second step on.
- **Real history compaction** — when a long session trims old turns, the model now writes an actual summary of what's being forgotten (decisions, files changed, open problems) instead of a mechanical text clip; falls back to the clip if the summarization call fails.
- **Human-readable errors** — provider failures are classified (rate limit, quota/billing, bad key, context overflow, invalid model, outage, unreachable) and shown as a plain-language explanation with concrete next steps; account identifiers (org/user ids, keys) are redacted before display. A turn that errors after making progress gets a one-click "Continue where it stopped" button.
- **"Navy Coder" Output channel** — best-effort failures (checkpoint persistence, MCP servers, history summarization) are now visible in View → Output instead of vanishing.
- Resize-proof UI: the toolbar wraps instead of clipping on narrow sidebars, the chat stays pinned to the latest message while you drag the splitter, and huge model lists (OpenRouter) get a type-to-filter box; Anthropic model listing follows pagination; saving a default API URL no longer pins it as an override
- Tool arguments are validated against each tool's schema, so a model passing bad parameters gets a clear correction message instead of a cryptic internal error; rejected structural renames no longer leave stray undo entries.

### Changed
- **Dynamic model lists for every provider** — OpenAI, Anthropic, DeepSeek, Gemini, xAI, z.ai, Groq, OpenRouter, LM Studio, and custom endpoints now fetch their available models live from the provider's `/models` API instead of a hardcoded list. New models appear automatically and retired ones disappear, so a provider changing its lineup no longer breaks Navy or hides a model. The curated lists remain only as an offline fallback (no key / unreachable). Fetches are cached 5 minutes; saving settings forces a refresh.
- **Provider API URL auto-fills** — selecting a provider in Settings drops its endpoint straight into the API Base URL box (still editable for a proxy/gateway), so you never have to look up or type the full URL. A saved custom override is preserved on reload.

### Fixed
- **Switching provider no longer 400s on an invalid model** — after changing provider, if the previously-selected model isn't in the new provider's live list (e.g. the old provider's model or the Ollama default), Navy now auto-selects a valid model for that provider instead of sending a model it doesn't have.
- **Tool calls work on more models** — providers that return empty or duplicate tool-call ids (Cohere and others via OpenRouter) were causing `tool call id ... not found in previous tool calls` 400s. Navy now assigns a unique id to every tool call and uses it consistently for the call and its result, fixing the pairing.
- **DeepSeek (and other strict providers) tool calls fixed** — the replayed `tool_calls` were missing the OpenAI-required `type: "function"` field, which DeepSeek rejects with `missing field type`. Navy now emits the complete tool-call shape. Background (`/bg`) tasks get the same normalization.
- **Cleaner model dropdowns** — Gemini ids lose their `models/` prefix, and OpenAI's list is filtered to chat-capable models (no more whisper/dall-e/embeddings in the picker).

## [0.2.2] - 2026-07-17

### Added
- **Codebase retrieval** — a new `find_relevant_files` tool ranks source files by symbol definitions, filename matches, and term frequency (BM25-style saturation) so the agent targets the right files instead of blindly guessing on large repos. On a code-oriented request Navy also auto-injects a ranked shortlist of likely-relevant files up front. Works fully offline, no embeddings.
- **`rename_symbol`** — structural, workspace-wide rename via the language server (updates every reference, leaves matching-but-unrelated text alone), fully undoable. Prefer it over text-replace for renames.
- **Smarter failed-edit recovery** — when an `apply_edit` search string isn't found, Navy now shows the closest-matching region of the real file so the model (especially weaker/local ones) can correct in one round-trip instead of guessing.

### Fixed
- **Small-model support** — models that can't use the native tool-calling API (e.g. qwen-coder-7b) emit tool calls as raw JSON text; Navy now parses those bare-JSON calls so tools actually run, and never renders tool-call JSON as a chat message. Greeting/small-talk prompting tightened so small models stop firing spurious searches.

### Changed
- Webview HTML shell extracted from `extension.js` into its own module; test suite now 81 checks (added retrieval, rename_symbol, edit-recovery, and end-to-end undo coverage through a mock-vscode + real temp filesystem).
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
- Real test suite (`npm test`): 51 checks covering the edit engine, context compaction, markdown rendering, a full simulated webview conversation, and end-to-end undo/redo (rename, delete, multi-edit turns, hand-edit detection) driven through the real provider against a mock-vscode + temp filesystem
- Undo fixes: "Undo Last Turn" now returns files edited multiple times in a turn to their true turn-start content (previously only the last edit was reverted); no more spurious "file was modified" warning on multi-edit undos; undo/redo now go through the write mutex; background-task edits form their own undo group; system-prompt sections are capped so a huge repo/memory can't overflow the context window
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
