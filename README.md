# Navy AI Coder

**An autonomous AI coding assistant for VS Code.** Navy works with any AI provider — local or cloud — to read your project, edit files, run commands, search the web, and manage dev servers, all with your approval before anything touches disk.

> **Preview release** — core features are stable. Report bugs at [github.com/zrnge/navy-coder/issues](https://github.com/zrnge/navy-coder/issues).

---

## Features

- **Agentic tool loop** — Navy reads files, searches the codebase, runs commands, and applies edits autonomously until the task is done, remembering what it actually did (files read, commands run and their exit code) across the whole conversation, not just what it said it did
- **Diff approval gate** — every file change is shown as a side-by-side diff; you approve or reject before it's written
- **Multiple projects, multiple chats** — a tab strip holds several conversations per project (a running turn keeps streaming in a background tab while you work in another), and Navy remembers every project you've ever opened in a small catalog (`~/.navy/projects.json`) so you can jump back into one without re-browsing for its folder — picking one offers to replace the current workspace or add it alongside what's already open
- **11 AI providers** — Ollama, LM Studio, OpenAI, Anthropic Claude, DeepSeek, Google Gemini, xAI Grok, z.ai, Groq, OpenRouter, and any custom OpenAI-compatible endpoint — with a native path for Anthropic extended thinking and Gemini's thinking/tool-call signatures, not just an OpenAI-compatible shim
- **Per-provider API keys** — switch providers without losing other keys; keys live in VS Code's OS keychain, never on disk
- **Opt-in cross-provider failover** (`navy.providerFallbacks`) — an ordered list of backup providers Navy falls through to on a genuinely transient failure (rate limit, outage, network error) — never for an auth/quota/context-length problem, and every fallback attempt is announced in the chat before it runs
- **Running cost estimate** — a cumulative token counter with an approximate $ cost for well-known hosted models, priced per turn using whichever provider actually served it; local models always show $0
- **Deep retrieval** — `find_relevant_files` blends keyword search with semantic embeddings (chunked per-file, not truncated to the first slice) and real LSP symbol matches, and the repository map the model sees is enriched with a one-line function/class outline per file, not just a bare file tree
- **`delegate_research`** — the model can spin off an isolated, read-only sub-agent for a broad investigation, getting back only the written conclusion instead of filling the main conversation with every file it looked at
- **Opt-in Docker sandboxing** (`navy.sandboxMode`) — run commands, tests, and dev servers inside a container built from the project's own `.devcontainer`/`Dockerfile`, as a second layer of isolation on top of the approval gate (macOS/Linux hosts in this release — see [Safety](#safety))
- **Opt-in persistent background processes** (`navy.persistBackgroundProcesses`) — let a dev server survive a window reload instead of being killed, with its output logged to a file and Navy offering to stop it if you reopen the project with one still running
- **MCP tool servers** — plug in any Model Context Protocol server, local (stdio) or remote (streamable HTTP), same config format as Claude Desktop (`navy.mcpServers`)
- **Prompt caching on Claude** — repeated agent steps reuse the cached prefix: several times cheaper and faster
- **Web search** — built-in search via DuckDuckGo (no key needed), Brave Search, or Tavily
- **Terminal cards** — every command shows an IN/OUT card in the chat with live output, exit status, and expandable logs
- **Dev server management** — start, monitor, and stop your dev server from the chat, with live server-URL detection
- **Git integration** — status, diff, log, and blame tools available to the agent
- **Independent syntax verification** (`check_syntax`) — real parsers/toolchains (JSON, `node --check`, and Python/Go/Rust/TS/Ruby/PHP/Bash when installed), not just whatever language extensions happen to be installed
- **Multi-root workspace aware** — search and file tools can target a sibling folder explicitly in a multi-root workspace, not just the active project root
- **Rename & delete are undoable** — transactional undo/redo across edits, renames, and file deletions; structural `rename_symbol` uses the real language server when one's available
- **Inline completions** — ghost-text suggestions as you type (opt-in, can use a separate faster model via `navy.completionModel`), with real fill-in-middle context from both sides of the cursor
- **Code Lens** — "Ask Navy" buttons above functions in the editor
- **No telemetry, zero runtime dependencies** — nothing is sent anywhere except to the AI provider you configure; the shipped extension has no npm packages bundled in besides the code in this repo

---

## Installation

**From the VS Code Marketplace** *(recommended)*

Search for **Navy AI Coder** in the Extensions panel (`Ctrl+Shift+X`) and click Install.

**From a VSIX file**

1. Download the `.vsix` from the [Releases page](https://github.com/zrnge/navy-coder/releases)
2. Open the Extensions panel, click `···` → **Install from VSIX…**, and select the file

---

## Quick Start

### Local model (Ollama — no API key needed)

1. [Install Ollama](https://ollama.com) and pull a model:
   ```
   ollama pull qwen2.5-coder:7b
   ```
2. Open VS Code, click the **Navy** anchor icon in the activity bar
3. The provider defaults to **Ollama** — start chatting

### Cloud provider (OpenAI, Anthropic, etc.)

1. Open the Navy sidebar and click the **Settings** gear
2. Set **Provider** to your provider (e.g. `openai`)
3. Paste your API key — it's stored in VS Code's encrypted secrets, never on disk
4. Set the **Model** (e.g. `gpt-4o`, `claude-sonnet-5`, `deepseek-coder`) — leave it empty to auto-select the first available model for that provider
5. Start chatting

---

## Providers

| Provider | Key required | Notes |
|---|---|---|
| **Ollama** | No | Local; set `navy.host` to your Ollama URL |
| **LM Studio** | No | Local OpenAI-compatible at `http://localhost:1234` |
| **OpenAI** | Yes | GPT-4o, o-series, etc. |
| **Anthropic** | Yes | Claude Sonnet, Haiku, Opus — native extended-thinking path |
| **DeepSeek** | Yes | deepseek-coder, deepseek-chat |
| **Google Gemini** | Yes | gemini-2.5/3.x — native path for thinking models |
| **xAI** | Yes | Grok models |
| **z.ai** | Yes | z.ai models |
| **Groq** | Yes | Fast inference; llama, mixtral, etc. |
| **OpenRouter** | Yes | Routes to 100+ models, grouped by vendor in the picker |
| **Custom** | Optional | Any OpenAI-compatible endpoint; set `navy.apiBase` |

Model lists are fetched live from each provider's API where supported, so new models show up automatically.

---

## What the Agent Can Do

Navy runs an autonomous tool-use loop. The full tool set:

| Category | Tools |
|---|---|
| Read | `read_file`, `read_lines`, `list_files`, `search_files`, `search_codebase`, `search_docs`, `find_relevant_files` (keyword + semantic + LSP), `find_symbol`, `find_references`, `get_diagnostics`, `check_syntax` |
| Write | `write_file`, `apply_edit`, `edit_line`, `delete_line`, `insert_after_line`, `delete_file`, `rename_file`, `rename_symbol` (structural, LSP-backed with a text fallback) |
| Shell | `run_command`, `run_tests` (auto-detected runner), `run_project`, `start_process` / `read_process_output` / `kill_process`, `get_terminal_output` |
| Git | `git_status`, `git_diff`, `git_log`, `git_blame` |
| Web | `web_search` (Brave / Tavily / DuckDuckGo), `fetch_url` |
| Delegation | `delegate_research` — an isolated, read-only sub-agent for broad investigations |
| Memory | `remember`, `forget` — project facts that persist across sessions |
| External | Any MCP server tool you've configured, exposed as `mcp__<server>__<tool>` |

Every file-mutating tool goes through the diff approval gate (unless `navy.approvalMode` is set to `auto-approve`), and every edit is undoable.

---

## Safety

- **Workspace trust** — in an untrusted workspace, Navy still reads files and answers questions, but every tool that executes code or sends data off the machine (shell commands, tests, dev servers, MCP servers, embedding upload) refuses at runtime.
- **Approval gate** — `navy.approvalMode` defaults to `ask-always`: every edit is a diff you approve, every shell command is a confirmation dialog. `auto-approve` removes that gate — use it deliberately.
- **Opt-in Docker sandboxing** (`navy.sandboxMode`) — a second, independent layer under the approval gate; refuses to guess at a generic container image if the project has no devcontainer/Dockerfile of its own. **macOS and Linux hosts only in this release:** on Windows, Navy writes commands in cmd.exe dialect and runs them via `cmd /c`, which does not exist inside a Linux container, so sandboxed commands fail — leave it `off` on Windows.
- **Cross-provider failover is opt-in and narrow** — only ever triggers for a transient failure (rate limit, outage, network error), never for anything that would just fail again with the same account, and every attempt is announced in the chat before it runs since it can spend money on a different provider account.
- **check_syntax runs in isolation** — checkers execute outside the project directory with hardened interpreter flags, so verifying a file can't execute code from the repository being inspected.

---

## Settings

Open via **File → Preferences → Settings** and search for `navy`, or click the gear icon in the Navy sidebar.

| Setting | Default | Description |
|---|---|---|
| `navy.provider` | `ollama` | AI provider: ollama, lmstudio, openai, anthropic, deepseek, gemini, xai, zai, groq, openrouter, custom |
| `navy.model` | *(empty)* | Model name to use; empty auto-selects the first available model for the chosen provider |
| `navy.host` | `http://localhost:11434` | Base URL for Ollama or LM Studio |
| `navy.apiBase` | *(empty)* | API URL override for custom or self-hosted providers |
| `navy.providerFallbacks` | `[]` | Ordered backup providers to fall through to on a transient failure — see [Safety](#safety) |
| `navy.thinkingLevel` | `medium` | Reasoning effort: `fast`, `medium`, or `high` |
| `navy.temperature` | `0.2` | Sampling temperature (0 = deterministic, 2 = creative) |
| `navy.approvalMode` | `ask-always` | `ask-always` shows a diff before every write; `auto-approve` writes immediately |
| `navy.editFormat` | `search-replace` | `search-replace` for surgical edits; `whole-file` to rewrite the entire file |
| `navy.maxToolIterations` | `50` | Maximum agent loop iterations per turn |
| `navy.sandboxMode` | `off` | `off` or `docker` — see [Safety](#safety) |
| `navy.persistBackgroundProcesses` | `false` | Let `run_project`/`start_process` survive a window reload instead of being stopped |
| `navy.searchApiKey` | *(empty)* | Web search key: Tavily (`tvly-…`) or Brave. Empty = DuckDuckGo (free) |
| `navy.embeddingModel` | *(empty)* | Enables semantic search in `find_relevant_files`. **Sends file content to the configured provider** — see the setting's description before enabling on a private codebase |
| `navy.mcpServers` | `{}` | MCP tool servers, local (stdio) or remote (streamable HTTP) — Claude Desktop config format |
| `navy.inlineCompletions` | `false` | Enable ghost-text completions as you type |
| `navy.completionModel` | *(empty)* | Separate, faster model for inline completions only; empty reuses `navy.model` |
| `navy.codeLens` | `true` | Show "Ask Navy" buttons above functions in the editor |
| `navy.systemPrompt` | *(empty)* | Custom instructions appended after Navy's built-in tool-use rules (can't override them) |
| `navy.maxContextChars` | `12000` | Max characters of active file/selection sent as context |
| `navy.projectRoot` | *(empty)* | Override the active project root (defaults to the first workspace folder) |

API keys are **not** stored in settings — they are stored in VS Code's encrypted secrets store (same as your GitHub token). Set them via the Navy sidebar's Settings panel.

---

## Commands & Keybindings

| Command | Shortcut (Win/Linux) | Shortcut (Mac) |
|---|---|---|
| Focus Chat | `Ctrl+Alt+N` | `Cmd+Alt+N` |
| Inline Edit Selection | `Ctrl+Alt+E` | `Cmd+Alt+E` |
| Undo Last Turn | `Ctrl+Alt+Z` | `Cmd+Alt+Z` |
| Redo | `Ctrl+Alt+Shift+Z` | `Cmd+Alt+Shift+Z` |
| Generate Commit Message | `Ctrl+Alt+G` | `Cmd+Alt+G` |
| Run Tests | `Ctrl+Alt+T` | `Cmd+Alt+T` |
| Clear Chat (Navy focused) | `Ctrl+Alt+K` | `Cmd+Alt+K` |
| Insert Last Reply | `Ctrl+Alt+I` | `Cmd+Alt+I` |

Also available and only reachable via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P` → search **Navy**): Undo Last Edit, Generate PR Description, Ask About This Function, Explain Terminal Error, Export Conversation, Review Pull Request.

---

## Privacy

- Your code is sent to whichever AI provider you configure. With Ollama or LM Studio, everything stays local.
- API keys are stored in VS Code's OS keychain — never written to disk or sent anywhere except the configured provider.
- Semantic search (`navy.embeddingModel`) is opt-in and off by default; enabling it sends file content to your configured embedding provider — see that setting's description for exactly what's excluded.
- Navy has no telemetry. Diagnostic logging (failed background saves, provider errors) stays local to the "Navy Coder" output channel (View → Output) and is never sent anywhere.

---

## Development

```
npm install
npm test    # 700+ tests: mocked-provider unit tests, no network or API keys needed
npm run build
```

`npm run eval` drives the real agent loop against a real configured model in a temp repo and scores the result — a capability check, not a unit test; see `eval/README.md`.

---

## License

MIT — see [LICENSE](LICENSE)
