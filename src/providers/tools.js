const TOOLS = [
  {
    name: 'remember',
    description: 'Persist an important fact about this project to long-term memory. Navy will recall this in every future session on this project. Use it for tech stack, conventions, key files, recurring patterns, constraints, or anything a future AI session should know.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The fact to remember. Write it as a concise, self-contained sentence.' }
      },
      required: ['fact']
    }
  },
  {
    name: 'forget',
    description: 'Remove one or more facts from project memory. Pass a keyword to delete matching lines, or omit it to wipe all memory.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword to match against memories to delete. Omit to clear all.' }
      },
      required: []
    }
  },
  {
    name: 'read_file',
    description: 'Read the full contents of a file. Always call this before editing a file you have not seen yet.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path.' }
      },
      required: ['path']
    }
  },
  {
    name: 'read_lines',
    description: 'Read a range of lines from a file (1-indexed, both ends inclusive). Use this to inspect a specific section without loading the whole file, or to continue after read_file reported a truncated file. Read in LARGE ranges (500-1500 lines at a time) — every call costs a full round-trip, so covering a file in 200-line chunks wastes several turns. Ranges are inclusive, so continue from the previous end + 1 (e.g. 1-800, then 801-1600) rather than repeating the boundary line.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        start: { type: 'number', description: 'First line to read (1-indexed, inclusive).' },
        end: { type: 'number', description: 'Last line to read (1-indexed, inclusive). Omit to read to end of file.' }
      },
      required: ['path', 'start']
    }
  },
  {
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing file with new content. Use this when you need to replace most of the file or create it from scratch. Prefer apply_edit for targeted changes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
        content: { type: 'string', description: 'Full content to write to the file.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_files',
    description: 'List files and directories at a given path. Use this to explore the project layout.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative directory path.' },
        maxDepth: { type: 'number', description: 'How many directory levels deep to list (default 1).' },
        folder: { type: 'string', description: 'Optional: target a specific open workspace folder by path or name, in a multi-root workspace. A relative `path` is then resolved against that folder instead of the active project. Omit to use the active project.' }
      },
      required: ['path']
    }
  },
  {
    name: 'search_files',
    description: 'Search for literal text or a regex pattern across all project files. Returns matching file paths and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regex to search for.' },
        folder: { type: 'string', description: 'Optional: target a specific open workspace folder by path or name, in a multi-root workspace. Omit to search the active project.' }
      },
      required: ['query']
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file or directory (moved to the OS Recycle Bin / Trash, recoverable there). The user is asked to confirm unless auto-approve is on. Use with caution.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to delete.' }
      },
      required: ['path']
    }
  },
  {
    name: 'rename_file',
    description: 'Rename or move a file/directory within the workspace. Creates missing target directories. Fails if the destination already exists. Much safer than read + write + delete for moves.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Current file path.' },
        to:   { type: 'string', description: 'New file path (may be in a different directory).' }
      },
      required: ['from', 'to']
    }
  },
  {
    name: 'edit_line',
    description: 'Replace the content of a single line in a file (1-indexed). Faster than apply_edit for single-line changes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        line: { type: 'number', description: 'Line number to replace (1-indexed).' },
        content: { type: 'string', description: 'New content for that line (without trailing newline).' }
      },
      required: ['path', 'line', 'content']
    }
  },
  {
    name: 'delete_line',
    description: 'Delete a single line from a file (1-indexed).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        line: { type: 'number', description: 'Line number to delete (1-indexed).' }
      },
      required: ['path', 'line']
    }
  },
  {
    name: 'insert_after_line',
    description: 'Insert one or more lines of text after a given line number (1-indexed). Use line 0 to insert before the first line.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        line: { type: 'number', description: 'Insert after this line (1-indexed). Use 0 to prepend.' },
        content: { type: 'string', description: 'Text to insert (may contain newlines for multiple lines).' }
      },
      required: ['path', 'line', 'content']
    }
  },
  {
    name: 'apply_edit',
    description: 'Apply a precise SEARCH/REPLACE edit to a file. The search string must match the file content exactly (character-for-character, including whitespace and line endings). Keep search as SHORT as possible — only the exact lines that change plus the minimum surrounding context needed to make the match unique. Never pass an entire function or file as the search string when just a few lines actually change. Use edit_line for a single-line change, or write_file only when you truly need to replace most of the file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
        search: { type: 'string', description: 'Exact text to find in the file.' },
        replace: { type: 'string', description: 'Text to replace the search match with.' }
      },
      required: ['path', 'search', 'replace']
    }
  },
  {
    name: 'run_command',
    description: 'Run a shell command. Use only when the user explicitly asks to run, build, or test something. Never use this to write files — use write_file or apply_edit instead.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000).' }
      },
      required: ['command']
    }
  },
  {
    name: 'git_status',
    description: 'Show the current git status: staged, unstaged, and untracked files.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'git_diff',
    description: 'Show a git diff. Pass a file path to diff a specific file, or leave empty for the full working-tree diff.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional file path to diff.' },
        staged: { type: 'boolean', description: 'If true, show staged (index) diff instead of working tree.' }
      },
      required: []
    }
  },
  {
    name: 'git_log',
    description: 'Show the last N git commits with their messages and authors.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of commits to show (default 10).' }
      },
      required: []
    }
  },
  {
    name: 'get_diagnostics',
    description: 'Get all LSP errors and warnings for the current file or a specific file. Use this to see TypeScript errors, linting issues, etc. NOTE: this only reports what an installed language extension found — it returns nothing for a language the user has no extension for, which is NOT the same as the file being valid. Use check_syntax when you need a definitive answer.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to get diagnostics for. Omit for the currently active file.' }
      },
      required: []
    }
  },
  {
    name: 'check_syntax',
    description: 'Independently verify that a file actually parses, without relying on any VS Code language extension being installed. Uses a real parser/compiler for the language (JSON parsed directly, JavaScript via "node --check", Python/TypeScript/Go/Rust/etc. via their own toolchain if installed). Clearly distinguishes "valid", "syntax error" (with line numbers), and "could not verify" — never reports a file as clean just because no checker was available. Use this after writing or editing a file when get_diagnostics returns nothing, and always for JSON/config files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to syntax-check.' }
      },
      required: ['path']
    }
  },
  {
    name: 'fetch_url',
    description: 'Fetch the text content of a URL. Use for reading documentation, API specs, or any web page.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' }
      },
      required: ['url']
    }
  },
  {
    name: 'get_terminal_output',
    description: 'List the currently open VS Code terminals by name. NOTE: VS Code does not let extensions read terminal buffer contents. To capture command output, use run_command (foreground) or start_process + read_process_output (background) instead — do not expect this tool to return terminal text.',
    parameters: { type: 'object', properties: {
      lines: { type: 'number', description: 'Unused (kept for compatibility).' }
    }}
  },
  {
    name: 'run_tests',
    description: 'Auto-detect and run the project test suite (Jest, Vitest, Pytest, cargo test, go test, npm test). Returns test output.',
    parameters: { type: 'object', properties: {
      filter: { type: 'string', description: 'Optional test name filter or file pattern.' }
    }}
  },
  {
    name: 'search_codebase',
    description: 'Search the entire codebase for a term, symbol, or pattern. Returns file paths, line numbers, and surrounding context lines. Better than search_files for finding where a symbol is defined or used.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Text or regex to search for.' },
      filePattern: { type: 'string', description: 'Optional glob to restrict search, e.g. "*.ts" or "src/**".' },
      contextLines: { type: 'number', description: 'Lines of context to show around each match (default 2).' },
      folder: { type: 'string', description: 'Optional: target a specific open workspace folder by path or name, in a multi-root workspace. Omit to search the active project.' }
    }, required: ['query'] }
  },
  {
    name: 'run_project',
    description: 'Auto-detect how to run this project (npm run dev, python manage.py runserver, go run ., etc.) and start it in the background. Monitors output for a localhost URL and reports it to the user as a live clickable link. The server stays running until the user stops it. Call this when the user asks you to run, start, or launch the project.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Optional: explicit command to run. Omit to let Navy auto-detect from package.json, manage.py, go.mod, Cargo.toml, etc.' }
      },
      required: []
    }
  },
  {
    name: 'start_process',
    description: 'Start a long-running shell process in the background. The process keeps running after this tool returns — use read_process_output to check its output and kill_process to stop it. Ideal for dev servers, file watchers, build watchers, or any command that runs continuously.',
    parameters: {
      type: 'object',
      properties: {
        id:      { type: 'string', description: 'A unique name for this process (e.g. "dev-server", "watcher"). Used to read output or kill it later.' },
        command: { type: 'string', description: 'Shell command to run.' }
      },
      required: ['id', 'command']
    }
  },
  {
    name: 'read_process_output',
    description: 'Read accumulated stdout/stderr from a background process started with start_process. Call this after waiting a moment to see if the process produced any output.',
    parameters: {
      type: 'object',
      properties: {
        id:    { type: 'string', description: 'The process id given when started.' },
        clear: { type: 'boolean', description: 'If true, clears the buffer after reading so subsequent reads only show new output.' }
      },
      required: ['id']
    }
  },
  {
    name: 'kill_process',
    description: 'Kill a background process started with start_process.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The process id to kill.' }
      },
      required: ['id']
    }
  },
  {
    name: 'git_blame',
    description: 'Show git blame for a file — who last changed each line, when, and in which commit. Optionally limit to a line range.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        startLine: { type: 'number', description: 'First line to blame (1-indexed). Omit for the whole file.' },
        endLine: { type: 'number', description: 'Last line to blame (1-indexed). Defaults to startLine when only startLine is given.' }
      },
      required: ['path']
    }
  },
  {
    name: 'search_docs',
    description: 'Search the project\'s OWN documentation (README, CHANGELOG, CONTRIBUTING, docs/**, *.md) for a term. Use this BEFORE guessing at project conventions, setup steps, architecture decisions, or "how do I run this" — the project may have already documented the answer. Different from search_codebase, which searches source code, not docs.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Term or phrase to search for in the project documentation.' },
        maxResults: { type: 'number', description: 'Maximum matches to return (default 8).' }
      },
      required: ['query']
    }
  },
  {
    name: 'activate_skill',
    description: 'Load an installed skill\'s full instructions before doing work that matches it. The system prompt lists each skill\'s name and one-line description — that summary is ALL you know until you activate it, so activate rather than guessing at what a skill contains. Call this FIRST, before starting the task, not after. Pass `file` to read one of the skill\'s own bundled documents (listed when you activate it) instead of its instructions. Activating a skill grants no extra permission: anything it tells you to run or change still goes to the user for approval.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name, exactly as listed in the system prompt.' },
        file: { type: 'string', description: 'Optional. A path inside the skill, e.g. "references/api.md", to read that file instead of the skill\'s instructions.' }
      },
      required: ['name']
    }
  },
  {
    name: 'find_relevant_files',
    description: 'Find the files most relevant to a task or question, ranked. Give it the user\'s request or a set of keywords/symbol names; it scores every source file by symbol definitions, filename matches, and term frequency and returns the top candidates with a reason. Use this FIRST on an unfamiliar or large codebase to decide which files to read — it is far more targeted than list_files or a raw search.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The task description, question, or space-separated keywords / symbol names to rank files against.' },
        maxResults: { type: 'number', description: 'How many ranked files to return (default 8).' },
        folder: { type: 'string', description: 'Optional: target a specific open workspace folder by path or name, in a multi-root workspace (see the repository map\'s "Other open folders" line). Omit to search the active project. Note: semantic/embedding-based ranking only applies to the active project even when this is set — keyword and language-server matches still work for any folder.' }
      },
      required: ['query']
    }
  },
  {
    name: 'find_symbol',
    description: 'Find where a symbol (function, class, variable, interface, etc.) is defined in the workspace using the language server. Returns file path, line number, symbol kind, and a code snippet. Faster and more precise than search_codebase for looking up definitions.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name to look up (e.g. "MyClass", "parseUser", "AuthToken").' }
      },
      required: ['name']
    }
  },
  {
    name: 'rename_symbol',
    description: 'Rename a symbol (variable, function, class, method, etc.) across the ENTIRE workspace using the language server — a true structural rename that updates every reference and leaves unrelated text that merely matches the name untouched. Give the file, the 1-indexed line where the symbol appears, its exact current name, and the new name. Strongly prefer this over apply_edit for renames.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A file where the symbol appears (usually its definition).' },
        line: { type: 'number', description: '1-indexed line number on which the symbol name appears in that file.' },
        name: { type: 'string', description: 'The exact current symbol name.' },
        newName: { type: 'string', description: 'The new name.' }
      },
      required: ['path', 'line', 'name', 'newName']
    }
  },
  {
    name: 'find_references',
    description: 'Find all usages of a symbol across the entire workspace using the language server. Returns every file and line where the symbol is referenced. Use this before renaming, deleting, or understanding the impact of changing a symbol.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name to find references for.' }
      },
      required: ['name']
    }
  },
  {
    name: 'web_search',
    description: 'Search the web (Tavily or Brave when a key is configured, DuckDuckGo otherwise). Returns titles, URLs, and snippets. Use this to find documentation, packages, error solutions, or anything not in the project files.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        maxResults: { type: 'number', description: 'Maximum results to return (default 5).' }
      },
      required: ['query']
    }
  },
  {
    name: 'delegate_research',
    description: 'Delegate a focused, READ-ONLY investigation to an isolated sub-agent and get back only its written summary — use this for a broad question that would otherwise take many read/search calls and fill up YOUR OWN context with detail you only need the CONCLUSION of (e.g. "how does authentication work in this codebase", "find every place X is called and summarize the pattern", "investigate why Y might be failing"). The sub-agent has no memory of this conversation (describe the task fully) and can read, search, and browse the codebase, but cannot write, delete, rename, run commands, or delegate further — for making changes, do that yourself directly, do not delegate it.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'A clear, self-contained description of what to investigate. The sub-agent starts with NO context from this conversation, so include everything it needs.' },
        maxSteps: { type: 'number', description: 'Maximum tool-use iterations for the sub-agent (default 12, capped at 20).' }
      },
      required: ['task']
    }
  },
  {
    name: 'finish',
    description: 'Signal that the task is fully complete and no further tool calls are needed.',
    parameters: { type: 'object', properties: {} }
  }
];

// Ollama-compatible tool schema (OpenAI function-calling format).
const TOOLS_API = TOOLS
  .filter(t => t.name !== 'finish')
  .map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

const TOOL_PROMPT = `You are Navy Coder, an expert AI coding assistant embedded inside VS Code. You have DIRECT ACCESS to the user's project files through tools — you do NOT need the user to paste any code.

## CRITICAL RULES (follow without exception)

NEVER say "please provide the code", "paste the file", or "I don't have access" — you DO have access, use your tools.
NEVER refuse a coding task because you "don't see the code" — call list_files then read_file.
NEVER invent a task the user did not request. If the message is a greeting, small talk, or is ambiguous, reply in ONE short plain-text sentence and DO NOT call any tool (no web_search, no reading files) — just answer.
When the user DOES ask to review, fix, explain, or improve code, START by reading the relevant files immediately — do not ask them to paste anything.

## Tool usage

When you need to call a tool, emit one XML block and WAIT for the result before continuing.

Available tools: read_file, read_lines, write_file, delete_file, rename_file, list_files, search_files, search_codebase, search_docs, find_relevant_files, find_symbol, find_references, rename_symbol, apply_edit, edit_line, delete_line, insert_after_line, run_command, run_project, start_process, read_process_output, kill_process, get_terminal_output, run_tests, git_status, git_diff, git_log, git_blame, get_diagnostics, check_syntax, fetch_url, web_search, delegate_research, remember, forget, finish.

## Workflow rules
1. Review / analyse requests → on an unfamiliar or large project, call find_relevant_files with the user's request FIRST to get a ranked shortlist, then read_file on the top hits. On a tiny project, list_files then read_file is fine.
2. Edit requests → read_file first, then edit with the SMALLEST tool that does the job: edit_line for one line, apply_edit for a few contiguous lines (search string must match the file exactly — include ONLY the lines that actually change plus the minimum context needed to make the match unique, never the whole function or file), write_file only when most of the file's content is genuinely changing. If you find yourself putting more than ~10-15 unchanged lines into a search block just to "be safe," stop — narrow it to the real change.
3. New file requests → use write_file with the full content.
4. Never use run_command to write files.
5. One tool call per XML block — wait for each result before the next.
6. Call finish() when the task is fully complete.
7. Call remember() whenever you discover a durable project fact: tech stack, key file locations, conventions, architectural decisions, or anything a future session should know. Be proactive — do this as you learn, not only when asked.
8. Before calling finish(), ALWAYS write a structured task report in this format:
   **Done:** 1-3 sentences describing what you accomplished and why.
   **Changed:** comma-separated list of files modified/created (e.g. "src/utils.js, src/app.ts"), or "No files changed" for chat responses.
   **Result:** succeeded / failed / partial — one sentence on the final outcome or caveats.
   Calling finish() immediately after tool use with no preceding explanation is not allowed.
9. Use find_symbol to locate where a function/class/variable is defined — it is faster and more accurate than search_codebase for definitions. Use find_references before renaming or deleting anything to understand its full impact across the codebase.
10. Never read the same file more than once per task. Once read, use that content. If you have read 3 or more files without making any change, you have enough context — stop reading and act now.
11. If a command fails (non-zero exit code), NEVER run the same command again immediately. Read the error output, identify the root cause, fix the code, THEN retry once. Repeating a failing command without a fix accomplishes nothing.
12. NEVER call run_project if the project is already running — it will report "already running". Only call run_project once per session; use the existing server for all subsequent testing.
13. PLANNING: For any task that will need 3 or more tool calls, START your first response with a short numbered plan (3-6 one-line steps) under a "**Plan:**" heading, BEFORE the first tool call. Then execute the steps in order. If the plan must change mid-task, state the revised step in one line before continuing. Simple one-tool questions need no plan.
14. VERIFICATION: Tool results after each file edit include fresh diagnostics for that file. If an edit introduced Errors, fix them immediately — never call finish() while your own edits have unresolved Errors. IMPORTANT: an empty/absent diagnostics report does NOT prove the file is valid — it usually means the user has no language extension installed for that file type. When a write reports "[SYNTAX UNVERIFIED]", or you edited a JSON/config file, or you need certainty before finishing, call check_syntax on the file: it runs a real parser and tells you definitively "valid", "syntax error at line N", or "could not verify". Never claim a file is correct on the basis of silence alone.
15. CRITICAL — DO NOT HALLUCINATE FILE ACTIONS: Writing code in your reply text does NOT save it anywhere — it only appears in the chat. If the user asked you to create, write, save, or edit a file, you MUST call the write_file or apply_edit tool and see its result before saying it succeeded. NEVER say "created", "saved", "written", "done", or similar unless you actually called that tool THIS turn and it returned success. If you are only showing an example or discussing code without being asked to save it, say so explicitly instead of claiming completion.
16. Before guessing at project conventions, setup/run instructions, or "why was this built this way" — call search_docs first. The project's own README/docs may already answer it; don't make the user repeat what's already written down.
17. COMMAND ACCURACY — check before assuming: run_command executes through the exact shell named in CURRENT ENVIRONMENT above (cmd.exe on Windows, sh on macOS/Linux) — write commands in THAT dialect, not whatever you'd default to. Shell builtins (cmd.exe: dir, cd, type, del, copy, move, mkdir, echo, set; sh: ls, cd, cat, rm, cp, mv, mkdir, echo, export) always exist — no need to check. A third-party CLI (git, node, npm, python, rg, jq, docker, etc.) may or may not be installed or on PATH — if you haven't already confirmed it works earlier this turn, check it first with "where <tool>" (cmd.exe) or "command -v <tool>" (sh) before depending on it, so a failure tells you "not installed" instead of wasting an attempt on a guess. If a command still fails with "not recognized"/"command not found", that means the tool isn't available — don't retry the same command, find or install an alternative.
18. WSL FALLBACK (Windows only): some tools genuinely have no native Windows build (gcc, make, and other Unix-toolchain staples are the common case) — CURRENT ENVIRONMENT states whether WSL is available and which distros. If a build/compile tool is missing from cmd.exe per rule 17, and WSL is available, try it there before telling the user it's unavailable: prefix the command with "wsl ", e.g. "wsl gcc file.c -o file.out". Windows paths must be converted for WSL first (C:\foo\bar → /mnt/c/foo/bar — or run "wsl wslpath 'C:\foo\bar'" to convert one). If WSL is not available, say so plainly rather than retrying Windows-native variants of the same missing tool.
19. DELEGATION: for a broad investigation you don't need to keep the raw detail of — "how does X work here", "find every place Y is used and summarize the pattern" — prefer delegate_research over doing it yourself with many read/search calls: you get back only the written conclusion instead of filling your own context with files you won't need again. Do NOT delegate anything that needs to WRITE, run a command, or that's simple enough to resolve in 1-2 tool calls yourself — delegation has overhead and the sub-agent can't act on what it finds.`

module.exports = { TOOLS, TOOLS_API, TOOL_PROMPT };
