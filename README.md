# Navy AI Coder

**An autonomous AI coding assistant for VS Code.** Navy works with any AI provider — local or cloud — to read your project, edit files, run commands, search the web, and manage dev servers, all with your approval before anything touches disk.

> **Preview release** — core features are stable. Report bugs at [github.com/zrnge/navy-coder/issues](https://github.com/zrnge/navy-coder/issues).

---

## Features

- **Agentic tool loop** — Navy reads files, searches the codebase, runs commands, and applies edits autonomously until the task is done, remembering what it actually did (files read, commands run and their exit code) across the whole conversation, not just what it said it did
- **Diff approval gate** — every file change is shown as a side-by-side diff; you approve or reject before it's written
- **Queue a prompt while Navy works — and take it back** — anything you send during a running turn waits its turn, and its own bubble carries a Cancel button for as long as it is still waiting; cancelling leaves your text in the transcript, marked as never sent, rather than deleting what you wrote or forcing you to Stop the running turn to get rid of it
- **Multiple projects, multiple chats** — a tab strip holds several conversations per project (a running turn keeps streaming in a background tab while you work in another), and Navy remembers every project you've ever opened in a small catalog (`~/.navy/projects.json`) so you can jump back into one without re-browsing for its folder — picking one offers to replace the current workspace or add it alongside what's already open
- **11 AI providers** — Ollama, LM Studio, OpenAI, Anthropic Claude, DeepSeek, Google Gemini, xAI Grok, z.ai, Groq, OpenRouter, and any custom OpenAI-compatible endpoint — with a native path for Anthropic extended thinking and Gemini's thinking/tool-call signatures, not just an OpenAI-compatible shim
- **Per-provider API keys** — switch providers without losing other keys; keys live in VS Code's OS keychain, never on disk
- **Opt-in cross-provider failover** (`navy.providerFallbacks`) — an ordered list of backup providers Navy falls through to on a genuinely transient failure (rate limit, outage, network error) — never for an auth/quota/context-length problem, and every fallback attempt is announced in the chat before it runs
- **Running cost estimate** — a cumulative token counter with an approximate $ cost for well-known hosted models, priced per turn using whichever provider actually served it; local models always show $0
- **Deep retrieval** — `find_relevant_files` blends keyword search with semantic embeddings (chunked per-file, not truncated to the first slice) and real LSP symbol matches, and the repository map the model sees is enriched with a one-line function/class outline per file, not just a bare file tree
- **Reduced tool set for small models** (`navy.reducedToolset`) — the full ~37 tool schemas ride on every request, which is a real tax on a 7B local model's context and measurably worsens its tool choice; a small local model (Ollama/LM Studio, ≤9B-named or ≤16k effective window) is instead offered a lean core covering read → edit → verify, and unlocks the full set mid-turn with one `request_more_tools` call when the task needs it — a context optimization, never a permission change
- **`delegate_research`** — the model can spin off an isolated, read-only sub-agent for a broad investigation, getting back only the written conclusion instead of filling the main conversation with every file it looked at
- **Opt-in Docker sandboxing** (`navy.sandboxMode`) — run commands, tests, and dev servers inside a container built from the project's own `.devcontainer`/`Dockerfile`, as a second layer of isolation on top of the approval gate, on every host — see [Safety](#safety)
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
- **Read aloud & dictation** — a speaker button reads any message out as prose (not punctuation), and a microphone button transcribes speech into the prompt box, where you review and send it yourself. VS Code webviews cannot reach the microphone ([microsoft/vscode#250568](https://github.com/microsoft/vscode/issues/250568)), so dictation runs in your browser via a token-gated loopback page and streams the words back — see [Privacy](#privacy)
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
| Skills | `activate_skill` — load an installed skill's instructions, or one of its bundled documents |
| Memory | `remember`, `forget` — project facts that persist across sessions |
| External | Any MCP server tool you've configured, exposed as `mcp__<server>__<tool>` |

Every file-mutating tool goes through the diff approval gate (unless `navy.approvalMode` is set to `auto-approve`), and every edit is undoable. Anything that *executes* — shell commands, test runs, dev servers, background processes, MCP tools — is gated separately by `navy.commandApproval`, which you have to turn off on its own.

---

## Slash Commands

Type `/` in the composer for the built-in prompts — `/fix`, `/review`, `/test`, `/security`, `/commit` and a dozen more.

**You can add your own.** A command is a markdown file: the filename is what you type, the body is the prompt.

```
.navy/commands/triage.md          →  /triage        committed with the project
.claude/commands/*.md             →  read as-is, if your repo already has them
<global storage>/commands/*.md    →  yours, in every project
```

`Ctrl+Shift+P` → **Navy Coder: New Slash Command** creates one and opens it; so does the *New command* row at the bottom of the `/` menu. A subdirectory groups related commands (`.navy/commands/db/migrate.md` → `/db:migrate`).

```markdown
---
description: Run the integration suite and triage what fails
icon: 🧪
hint: [suite name]
---

Run `npm run test:integration $ARGUMENTS`. For each failure, read the test,
read the code under test, and say whether it's the test or the code that's
wrong before changing anything.
```

Anything you type after the command replaces `$ARGUMENTS` — `/triage auth` runs it against `auth`. Leave `$ARGUMENTS` out and those words are appended instead, so a command does something sensible either way.

In the `/` menu, **alt-click** an entry to edit its file, or hover it and click **×** to remove it — that deletes the file, so Navy asks first and moves it to the trash where the OS supports one. Built-ins have no × since there is no file behind them.

A custom command **may shadow a built-in** — if your team's `/test` means something specific, name it `/test`; the menu shows which definition it is offering. Commands from a project only load in a trusted workspace, and a command is prompt text and nothing more: it cannot pre-approve a tool, skip a diff, or run anything by existing.

---

## Skills

A slash command is one you invoke. A **skill** is expertise the *model* reaches for when a task calls for it — and the difference that matters is what it costs to have installed.

```
.navy/skills/pdf-tools/
├── SKILL.md          # required: frontmatter + instructions
├── references/       # docs read only when needed
├── scripts/          # executable code
└── assets/           # templates, schemas
```

```markdown
---
name: pdf-tools
description: Extract text and tables from PDFs, fill forms, merge and split files
---

Use `pdftotext -layout` first; the default mode loses column structure...
```

Only the **name and description** are in the model's context — the body is read when it activates the skill, and `references/` one file at a time after that. A skill can carry a 400-line reference for about thirty tokens a turn.

Format is the [Agent Skills spec](https://agentskills.io/specification) verbatim, so skills written for other tools work here unchanged. Navy reads, in precedence order: its global storage, `~/.claude/skills/`, `.claude/skills/`, `.navy/skills/`.

**A skill grants nothing.** Its `allowed-tools` is parsed and shown so you can see what it *wants*, and never honoured as pre-approval — a repository must not be able to switch off the approval gate by shipping a file. Bundled scripts run through `run_command`, the same dialog and the same sandbox as any other command. Project skills don't load in an untrusted workspace; they're listed so you can see what's on offer.

Every skill is **also a slash command** — `/pdf-tools` loads it directly, no model selection involved. Picking the right skill from a one-line description is exactly what small local models are worst at, and a skill that never gets selected is pure context cost.

`navy.skills` is `auto` (default), `off`, or an explicit list of names. Every installed skill's description sits in every request, so Navy caps the total against the model's own context window and names in the output channel anything it had to leave out.

---

## Safety

- **Workspace trust** — in an untrusted workspace, Navy still reads files and answers questions, but every tool that executes code or sends data off the machine (shell commands, tests, dev servers, MCP servers, embedding upload) refuses at runtime. A repository's own slash commands and skills don't load there either: cloning something must not silently redefine what `/fix` means.
- **The dictation port is treated as the security surface it is** — bound to `127.0.0.1` on an ephemeral port, every route gated on a 256-bit token compared in constant time, `Host` and `Origin` pinned against DNS rebinding, bodies capped, no CORS headers, a strict nonce CSP on the page, and the whole server torn down the moment dictation ends, the tab closes, the panel closes, or five idle minutes pass.
- **Two approval gates, not one** — `navy.approvalMode` covers changes to *files*: every edit is a diff you approve, and every change is contained to the workspace, checkpointed for undo, and visible in git afterwards. `navy.commandApproval` covers *execution*: shell commands, test runs, dev servers, background processes, and third-party MCP tool calls. Both default to `ask-always` and each has to be turned off on its own, because they are not the same decision — a file edit is bounded and reversible, whereas Navy cannot know what a command will do before it runs or take it back afterwards. Until 0.3.1 these were one setting, so switching off diff prompts also granted unattended command execution; if you had `auto-approve` set before upgrading, file edits stay automatic and commands go back to asking.
- **Opt-in Docker sandboxing** (`navy.sandboxMode`) — a second, independent layer under the approval gate; refuses to guess at a generic container image if the project has no devcontainer/Dockerfile of its own. Works on Windows, macOS and Linux: when sandboxing is on, Navy targets the container rather than the host, so commands are written and run in POSIX `sh` even from a Windows host.
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
| `navy.ollamaMode` | `local` | Which Ollama to talk to. `local` uses the server at `navy.host` and needs Ollama installed; `cloud` uses ollama.com, which needs no install and runs models too large for most machines — but needs an API key, and your code leaves the machine |
| `navy.apiBase` | *(empty)* | API URL override for custom or self-hosted providers |
| `navy.providerFallbacks` | `[]` | Ordered backup providers to fall through to on a transient failure — see [Safety](#safety) |
| `navy.thinkingLevel` | `medium` | Reasoning effort: `fast`, `medium`, or `high` |
| `navy.temperature` | `0.2` | Sampling temperature (0 = deterministic, 2 = creative) |
| `navy.approvalMode` | `ask-always` | Files only. `ask-always` shows a diff before every write, delete or rename; `auto-approve` applies them immediately |
| `navy.commandApproval` | `ask-always` | Execution only. `ask-always` confirms every shell command, background process and MCP tool call; `auto-approve` runs them unattended |
| `navy.editFormat` | `search-replace` | `search-replace` for surgical edits; `whole-file` to rewrite the entire file |
| `navy.maxToolIterations` | `100` | Maximum agent loop iterations per turn |
| `navy.fileEditSoftCap` | `5` | Writes to the same file in one turn before Navy stops feeding back fresh diagnostics and nudges the model to wrap up |
| `navy.fileEditHardCap` | `10` | Writes to the same file in one turn after which further writes to it are refused — the backstop against an edit loop |
| `navy.sandboxMode` | `off` | `off` or `docker` — see [Safety](#safety) |
| `navy.persistBackgroundProcesses` | `false` | Let `run_project`/`start_process` survive a window reload instead of being stopped |
| `navy.searchApiKey` | *(empty)* | Web search key: Tavily (`tvly-…`) or Brave. Empty = DuckDuckGo (free) |
| `navy.embeddingModel` | *(empty)* | Enables semantic search in `find_relevant_files`. **Sends file content to the configured provider** — see the setting's description before enabling on a private codebase |
| `navy.mcpServers` | `{}` | MCP tool servers, local (stdio) or remote (streamable HTTP) — Claude Desktop config format |
| `navy.inlineCompletions` | `false` | Enable ghost-text completions as you type |
| `navy.completionModel` | *(empty)* | Separate, faster model for inline completions only; empty reuses `navy.model` |
| `navy.codeLens` | `true` | Show "Ask Navy" buttons above functions in the editor |
| `navy.systemPrompt` | *(empty)* | Custom instructions appended after Navy's built-in tool-use rules (can't override them) |
| `navy.skills` | `auto` | `auto`, `off`, or an array of skill names. Every offered skill's description is in every request — a real cost on a small local model, capped against its context window |
| `navy.speechVoice` | *(empty)* | Voice used for Read Aloud. Empty picks the best one installed for your language — prefer the Settings panel's dropdown, which lists what this machine actually has |
| `navy.speechRate` | `1` | Read Aloud speed. Above ~1.3 most voices clip consonants, costing comprehension rather than saving time |
| `navy.contextWindow` | `0` *(max)* | The model's context window, in tokens. `0` follows whatever the model reports, so it tracks the model instead of being pinned to a number that goes stale the moment you switch. Lowering it is the fix for a local model that loads slowly or spills onto the CPU — for Ollama it is sent as `num_ctx`, so the KV cache shrinks with it. Hosted windows are fixed by the API, so there a smaller value only makes Navy treat the chat as full sooner |
| `navy.maxContextChars` | `12000` | Max characters of the active file/selection sent as context — unlike `navy.contextWindow`, this bounds what Navy attaches, not what the model can hold |
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

Also available and only reachable via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P` → search **Navy**): Undo Last Edit, Generate PR Description, Ask About This Function, Explain Terminal Error, Export Conversation, Review Pull Request, **Test Provider Connection**, New Slash Command, Open Slash Commands Folder.

**Test Provider Connection** is the one to reach for when something won't connect. It asks your configured provider for its model list through the same code a real request uses, and tells you which problem you have — wrong base URL, wrong key, right key for the wrong region, empty balance, rate limited, or nothing listening — instead of leaving you to guess. See [Troubleshooting](TROUBLESHOOTING.md).

---

## Privacy

- Your code is sent to whichever AI provider you configure. With Ollama or LM Studio, everything stays local.
- API keys are stored in VS Code's OS keychain — never written to disk or sent anywhere except the configured provider.
- Semantic search (`navy.embeddingModel`) is opt-in and off by default; enabling it sends file content to your configured embedding provider — see that setting's description for exactly what's excluded.
- Navy has no telemetry. Diagnostic logging (failed background saves, provider errors) stays local to the "Navy Coder" output channel (View → Output) and is never sent anywhere.
- Dictation opens a page in your browser and your browser's speech recognition uploads the audio to its vendor's service (Google, for Chrome and Edge) — the same as dictating on any website. Navy receives only the text. The loopback server that carries it exists only while you are dictating: it binds `127.0.0.1` on an ephemeral port, requires a 256-bit token on every request, pins `Host` and `Origin` against DNS rebinding, and shuts down when you finish, close the tab, close the panel, or go idle for five minutes. Read-aloud uses your OS's own voice and sends nothing anywhere.

---

## Development

```
npm install
npm run check   # syntax
npm test        # 1,579 tests: extension host + webview, no network or API keys needed
npm run build
```

`npm run eval` drives the real agent loop against a real configured model in a temp repo and scores the result — a capability check, not a unit test; see `eval/README.md`.

`node test/check-provider-endpoints.js` confirms every shipped provider base URL is still live. It makes real network calls (with a deliberately invalid key, so no secrets are needed), which is why it isn't part of `npm test`; CI runs it weekly.

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the repo layout, the invariants that aren't negotiable, and the exact set of places to touch when adding a provider, a tool, or a setting. **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** covers connection problems, sandboxing, dictation and project folders.

---

## License

MIT — see [LICENSE](LICENSE)

### Third-party assets

Navy's interface icons are from **[Font Awesome Free](https://fontawesome.com)** 7.3.1, licensed **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**.

Only the ~38 icons the panel actually draws are bundled, as raw SVG paths in [`src/icons.js`](src/icons.js) — no webfont, no icon CSS, and nothing fetched at runtime, so the panel renders identically offline and in a workspace with no network. To change the set, see [`tools/build-icons.js`](tools/build-icons.js). No other third-party code ships in the extension.
