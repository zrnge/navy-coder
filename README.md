# Navy AI Coder

**An autonomous AI coding assistant for VS Code.** Navy works with any AI provider — local or cloud — to read your project, edit files, run commands, search the web, and manage dev servers, all with your approval before anything touches disk.

> **Preview release** — core features are stable. Report bugs at [github.com/zrnge/navy-coder/issues](https://github.com/zrnge/navy-coder/issues).

---

## Features

- **Agentic tool loop** — Navy reads files, searches the codebase, runs commands, and applies edits autonomously until the task is done
- **Diff approval gate** — every file change is shown as a side-by-side diff; you approve or reject before it's written
- **11 AI providers** — Ollama, LM Studio, OpenAI, Anthropic Claude, DeepSeek, Google Gemini, xAI Grok, z.ai, Groq, OpenRouter, and any custom OpenAI-compatible endpoint
- **Per-provider API keys** — switch providers without losing other keys
- **MCP tool servers** — plug in any Model Context Protocol server (`navy.mcpServers`, Claude Desktop config format) and the agent can use its tools
- **Prompt caching on Claude** — repeated agent steps reuse the cached prefix: several times cheaper and faster
- **Web search** — built-in search via DuckDuckGo (no key needed), Brave Search, or Tavily
- **Terminal cards** — every command shows an IN/OUT card in the chat with live output, exit status, and expandable logs
- **Dev server management** — start, monitor, and stop your dev server from the chat
- **Git integration** — status, diff, log, and blame tools available to the agent
- **Fast search & retrieval** — ripgrep-backed `.gitignore`-aware search, plus a ranked "find relevant files" retriever that points the agent at the right code on large repos
- **Rename & delete are undoable** — transactional undo/redo across edits, renames, and file deletions
- **Inline completions** — ghost-text suggestions as you type (opt-in, uses the active provider)
- **Undo & Redo** — revert any edit, rename, or file deletion (survives window reloads), and redo an accidental undo
- **Code Lens** — "Ask Navy" buttons above functions in the editor

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
4. Set the **Model** (e.g. `gpt-4o`, `claude-sonnet-4-6`, `deepseek-coder`)
5. Start chatting

---

## Providers

| Provider | Key required | Notes |
|---|---|---|
| **Ollama** | No | Local; set `navy.host` to your Ollama URL |
| **LM Studio** | No | Local OpenAI-compatible at `http://localhost:1234` |
| **OpenAI** | Yes | GPT-4o, o3, etc. |
| **Anthropic** | Yes | Claude Sonnet, Haiku, Opus |
| **DeepSeek** | Yes | deepseek-coder, deepseek-chat |
| **Google Gemini** | Yes | gemini-2.5-pro, gemini-2.5-flash |
| **xAI** | Yes | Grok models |
| **z.ai** | Yes | z.ai models |
| **Groq** | Yes | Fast inference; llama, mixtral, etc. |
| **OpenRouter** | Yes | Routes to 100+ models |
| **Custom** | Optional | Any OpenAI-compatible endpoint; set `navy.apiBase` |

---

## What the Agent Can Do

Navy runs an autonomous loop with these tools:

| Category | Tools |
|---|---|
| Files | Read, write, edit lines, apply surgical edits, delete |
| Search | Search files by text/regex, search codebase with context |
| Shell | Run commands, run tests (auto-detected), start/stop background processes |
| Web | Web search (Brave / Tavily / DuckDuckGo), fetch any URL |
| Git | Status, diff, log, blame |
| VS Code | Get LSP diagnostics, read terminal output |
| Memory | Remember project facts across sessions |

---

## Settings

Open via **File → Preferences → Settings** and search for `navy`, or click the gear icon in the Navy sidebar.

| Setting | Default | Description |
|---|---|---|
| `navy.provider` | `ollama` | AI provider: ollama, lmstudio, openai, anthropic, deepseek, gemini, xai, zai, groq, openrouter, custom |
| `navy.model` | `kimi-k2.7-code:cloud` | Model name to use (e.g. `gpt-4o`, `claude-sonnet-4-6`, `llama3.2`) |
| `navy.host` | `http://localhost:11434` | Base URL for Ollama or LM Studio |
| `navy.apiBase` | *(empty)* | API URL override for custom or self-hosted providers |
| `navy.temperature` | `0.2` | Sampling temperature (0 = deterministic, 2 = creative) |
| `navy.approvalMode` | `ask-always` | `ask-always` shows a diff before every write; `auto-approve` writes immediately |
| `navy.editFormat` | `search-replace` | `search-replace` for surgical edits; `whole-file` to rewrite the entire file |
| `navy.maxToolIterations` | `50` | Maximum agent loop iterations per turn |
| `navy.searchApiKey` | *(empty)* | Web search key: Tavily (`tvly-…`) or Brave. Empty = DuckDuckGo (free) |
| `navy.inlineCompletions` | `false` | Enable ghost-text completions as you type (uses the active provider) |
| `navy.codeLens` | `true` | Show "Ask Navy" buttons above functions in the editor |
| `navy.systemPrompt` | *(empty)* | Custom system prompt prepended to every conversation |
| `navy.maxContextChars` | `12000` | Max characters of active file/selection sent as context |
| `navy.projectRoot` | *(empty)* | Override the project root directory (defaults to first workspace folder) |

API keys are **not** stored in settings — they are stored in VS Code's encrypted secrets store (same as your GitHub token). Set them via the Navy sidebar's Settings panel.

---

## Commands & Keybindings

| Command | Shortcut (Win/Linux) | Shortcut (Mac) |
|---|---|---|
| Focus Chat | `Ctrl+Alt+N` | `Cmd+Alt+N` |
| Inline Edit Selection | `Ctrl+Alt+E` | `Cmd+Alt+E` |
| Undo Last Turn | `Ctrl+Alt+Z` | `Cmd+Alt+Z` |
| Generate Commit Message | `Ctrl+Alt+G` | `Cmd+Alt+G` |
| Run Tests | `Ctrl+Alt+T` | `Cmd+Alt+T` |
| Clear Chat (Navy focused) | `Ctrl+Alt+K` | `Cmd+Alt+K` |
| Insert Last Reply | `Ctrl+Alt+I` | `Cmd+Alt+I` |

All commands are also accessible via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) — search **Navy**.

---

## Privacy

- Your code is sent to whichever AI provider you configure. With Ollama or LM Studio, everything stays local.
- API keys are stored in VS Code's OS keychain — never written to disk or sent anywhere except the configured provider.
- Navy has no telemetry.

---

## License

MIT — see [LICENSE](LICENSE)
