const { streamAssistant, parseToolCalls, extractCodeEdits } = require('./providers/llm.js');
const { openAiCompatBase, providerDisplayName, ollamaHost, ollamaAuthHeaders } = require('./providers/endpoints.js');
const { McpManager } = require('./providers/mcp.js');
const { formatProviderError, classifyProviderError, isTransientProviderError } = require('./providers/errors.js');
const { getEmbeddings, cosineSimilarity } = require('./providers/embeddings.js');
const { getWebviewHtml } = require('./webview-html.js');
const { DictationBridge } = require('./dictation-bridge.js');
const { PROJECT_CATALOG_METHODS } = require('./projects.js');
const { RETRIEVAL_METHODS, RELEVANCE_SKIP_DIRS, RELEVANCE_CODE_EXTS,
        isSensitiveForEmbedding, encodeVector, decodeVector, shardOf } = require('./retrieval.js');
const { SANDBOX_METHODS, stripJsonComments } = require('./sandbox.js');
const { BACKGROUND_METHODS } = require('./background.js');
const { NET_SAFETY_METHODS } = require('./net-safety.js');
const { UNDO_METHODS } = require('./undo.js');
const { WEB_SEARCH_METHODS } = require('./web-search.js');
const { DIAGNOSTICS_METHODS } = require('./diagnostics.js');
const { PLAN_METHODS } = require('./plan.js');
const { SLASH_COMMAND_METHODS } = require('./slash-commands.js');
const { SKILL_METHODS } = require('./skills.js');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
// Deliberately NOT importing execSync: every child process here is launched from
// the extension host thread, and a synchronous spawn there freezes the editor.
const { spawn } = require('child_process');
const crypto = require('crypto');
const dns = require('dns');
// fetch_url goes through http/https directly rather than global fetch(), which
// offers no way to control address resolution — see _requestPinned.
const http = require('http');
const https = require('https');
const zlib = require('zlib');

// Session binding — see src/session-context.js.
const { sessionContext } = require('./session-context.js');

// Workspace trust — see src/workspace.js for why it lives in its own module.
const { workspaceIsTrusted } = require('./workspace.js');

// Manifest support is "limited", not false: declaring false leaves the view
// container contributed but the extension never activates, so the panel renders
// as an empty box with no explanation — which reads as a crash. Navy stays
// usable for reading and answering; only the operations that would execute
// code from, or upload code out of, an untrusted folder are refused here.
const UNTRUSTED_REFUSAL = (what) =>
  `Refused: this workspace is not trusted, so Navy will not ${what} in it. `
  + `Tell the user to trust the folder (Workspaces: Manage Workspace Trust) if they want this. `
  + `Reading files and answering questions still work — do not retry this tool.`;

// Syntax checkers run with cwd set OUTSIDE the project on purpose — see
// src/exec.js, which owns CHECKER_CWD because the sandbox and background-process
// modules spawn through it too.
const { CHECKER_CWD } = require('./exec.js');
// Cap what check_syntax will read — an unbounded readFile on the extension
// host's heap is an OOM waiting to happen on a repo with a large data file.
const CHECK_SYNTAX_MAX_BYTES = 2 * 1024 * 1024;
// ── Conversation size budget ────────────────────────────────────────────────
// Both the pre-turn history trim and mid-turn compaction used to be fixed
// literals (240k/200k chars ≈ 60k/50k tokens), which was wrong in both
// directions: on a 200k-token model Navy threw away history it had ample room
// for — and paid for a summarization call to do it — while on an 8k model it
// happily assembled 60k tokens' worth for a window that could never hold it.
// Both now scale with the window the ACTIVE model actually has.
//
// 4 is the English-prose chars-per-token figure. Code tokenizes nearer 3–3.5
// and CJK lower still, so `tokens * 4` OVER-states how much text fits; CONTEXT_FILL
// covers that as well as leaving room for this turn's own growth. It is doing
// both jobs at once, which is why raising it is not the free win it looks like.
const CHARS_PER_TOKEN = 4;
// Bounds on the LEARNED ratio (see _observeTokenRatio). Nothing real sits
// outside these: ~1.5 is dense CJK, ~8 is highly repetitive text a BPE
// tokenizer folds hard. Clamping means a bad sample degrades the estimate
// rather than handing compaction a budget that is wrong by an order of
// magnitude.
const CHARS_PER_TOKEN_MIN = 1.5;
const CHARS_PER_TOKEN_MAX = 8;
// How fast the learned ratio moves. Low, because the mix of a conversation
// changes slowly and a single odd sample should not swing the budget.
const CPT_SMOOTHING = 0.25;
// Below this much growth between two calls the delta is mostly noise — token
// counts are integers and providers round.
const CPT_MIN_DELTA_CHARS = 2000;
const CONTEXT_FILL = 0.6;

// Size of an assembled message array, the same way every budget check counts
// it. Shared so the compactor, the pre-turn history cap and the token-ratio
// calibration can never disagree about what "how big is this" means.
//
// Named for the ASSEMBLED array (system + history + this turn's churn), not
// "messages", because _askNavyTurn already has a local `messagesCharSize`
// holding a NUMBER — the size of this.messages. A module-level function by
// that name is shadowed by it for the whole method, and the call fails with
// "not a function" a long way from the declaration that caused it.
function assembledCharSize(messages) {
  let total = 0;
  for (const m of messages) {
    total += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
  }
  return total;
}
// A ceiling on the derived budget, not on the model. The assembled conversation
// is measured and stringified synchronously on the extension host's main thread
// on every iteration of every turn, so an unbounded budget on a 1M-token model
// (kimi-k3, gpt-4.1, qwen-turbo) would hand us ~2.4 MB of string per pass and
// the UI freeze that comes with it — the same failure EMBED_SHARD_MAX_BYTES
// above exists to prevent.
const CONTEXT_CHARS_CEILING = 1000000;
// Used only when the model's window is unknown — the original conservative
// floor, unchanged, so an unrecognised model behaves exactly as it always did.
const CONTEXT_CHARS_FLOOR = 240000;
// The pre-turn history cap must stay strictly UNDER the compaction ceiling:
// compaction still has this turn's own tool churn to add on top of whatever
// history survives. Expressed as the ratio the two literals already had
// (200000/240000) so they can never drift apart.
const HISTORY_CAP_FRACTION = 5 / 6;

// Is a saved project root actually meaningful for the folders open in THIS
// window? A root that belongs to some other project is worse than no root at
// all: Navy silently operates on a project the user isn't looking at. Accepts a
// root that IS a workspace folder or lives inside one (picking a sub-directory
// as the project root is legitimate). Pure, so it's directly testable.
// Path identity — see src/paths.js for why these are one shared pair, and why
// they live in their own module rather than here.
const { fold, foldPath } = require('./paths.js');

function rootBelongsToWorkspace(root, folderPaths) {
  if (!root) return false;
  if (!folderPaths || folderPaths.length === 0) return true; // no workspace to contradict it
  const r = foldPath(root);
  return folderPaths.some((f) => {
    const n = foldPath(f);
    return r === n || r.startsWith(n + path.sep);
  });
}

// Model pricing lives in its own module — see src/providers/pricing.js for
// why, and for how navy.modelPricing lets a user price a model Navy has
// never heard of without waiting for a release.
const { estimateCost, PRICING_AS_OF } = require('./providers/pricing.js');

// workspaceState key holding the project root Navy last used in THIS workspace.
// Deliberately not a setting — see _persistProjectRoot.
const WS_LAST_PROJECT_ROOT = 'navy.lastProjectRoot';

// Ceiling for _projectCaches (embedding index, repo-map, relevance, .gitignore
// caches, keyed per project root — see the _proj getter) before the LEAST
// recently touched, currently-unopen entries start getting evicted. Generous
// on purpose: a normal session touching a handful of projects never comes
// close to this, so eviction only ever engages for the genuinely unusual
// case of visiting many different repos in one long-lived window — see
// _evictStaleProjectCaches.
const PROJECT_CACHE_CAP = 20;

// Ceiling for this.sessions (every chat tab, loaded or created, in this
// window — see _evictStaleSessions). Higher than PROJECT_CACHE_CAP since an
// individual chat is usually far smaller than a project's embedding index,
// but the growth risk is the same shape: visiting many projects over a
// long-lived window auto-loads every one of their saved chats and never
// used to free any of them.
const SESSION_CACHE_CAP = 40;

// Context window per model family, in tokens — the FALLBACK for providers that
// don't report it themselves. Live values are always preferred: Ollama reports
// it per model via /api/show, and OpenRouter (plus vLLM and other
// OpenAI-compatible servers) reports it in the model list — see
// _fetchModelList/resolveModelContext, which consult this only when the
// provider said nothing. Like MODEL_PRICING this is a best-effort snapshot, not
// live data, so anything unrecognized resolves to null and the UI simply hides
// the badge rather than showing a number that might be wrong. First match wins,
// ordered most-specific-first.
const MODEL_CONTEXT = [
  { re: /claude-/i, ctx: 200000 },
  { re: /gpt-4\.1/i, ctx: 1047576 },
  { re: /gpt-5/i, ctx: 400000 },
  { re: /gpt-4o/i, ctx: 128000 },
  { re: /gpt-4-turbo/i, ctx: 128000 },
  { re: /gpt-3\.5/i, ctx: 16385 },
  { re: /^o1-mini/i, ctx: 128000 },
  { re: /^o1\b|^o3|^o4-mini/i, ctx: 200000 },
  { re: /gemini-1\.5-pro/i, ctx: 2097152 },
  { re: /gemini-/i, ctx: 1048576 },
  { re: /deepseek/i, ctx: 128000 },
  { re: /grok-4/i, ctx: 256000 },
  { re: /grok/i, ctx: 131072 },
  // Deliberately conservative: this budget decides how much Navy sends, so
  // under-stating a window costs a little context and over-stating it costs a
  // failed request. GLM-4.6 raised the window from 128K to 200K; GLM-5.x is
  // 200K+ and 5.2 is reported higher still, so 200K is the safe floor for both.
  { re: /glm-4\.[67]/i, ctx: 200000 },
  { re: /glm-5/i, ctx: 200000 },
  { re: /glm-4/i, ctx: 128000 },
  { re: /kimi-k3/i, ctx: 1000000 },
  { re: /kimi-k2|kimi-latest/i, ctx: 256000 },
  { re: /moonshot-v1-128k/i, ctx: 128000 },
  { re: /moonshot-v1-32k/i, ctx: 32768 },
  { re: /moonshot-v1/i, ctx: 8192 },
  { re: /qwen3|qwen-max|qwen-plus/i, ctx: 131072 },
  { re: /qwen-turbo/i, ctx: 1008192 },
  { re: /minimax/i, ctx: 1000000 },
  { re: /mimo/i, ctx: 262144 },
  { re: /llama-?3/i, ctx: 131072 },
  { re: /mistral|mixtral/i, ctx: 32768 },
];

// Context window for `model`, or null when it genuinely isn't known. `live` is
// whatever the provider itself reported for that model (see _fetchModelList),
// and always wins — a real answer from the provider beats a table that can only
// ever be a snapshot. Pure, so it's directly testable.
function resolveModelContext(model, live) {
  const fromProvider = Number(live);
  if (Number.isFinite(fromProvider) && fromProvider > 0) return fromProvider;
  const entry = MODEL_CONTEXT.find(e => e.re.test(model || ''));
  return entry ? entry.ctx : null;
}

// The selectable window sizes offered for a model whose maximum is `max`:
// familiar power-of-two steps up to that maximum, plus the maximum itself when
// it isn't already one of them (200,000 and 1,000,000 are not). Built per model
// rather than from a fixed list, so an 8k model never offers 128k and a 1M
// model isn't silently limited to whatever a hardcoded list happened to stop
// at. Descending, so the largest — the default — reads first. Pure.
function contextWindowOptions(max) {
  if (!Number.isFinite(max) || max <= 0) return [];
  const steps = [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];
  const offered = steps.filter(s => s < max);
  offered.push(max);
  return offered.reverse();
}


// Read-only tools — safe to run in parallel within a turn (see the
// Promise.all gate in _askNavyTurn) and the full set a delegate_research
// sub-agent is permitted to call (see toolDelegateResearch). One shared
// definition so the two notions of "read-only" can't drift apart.
const READ_ONLY = new Set(['read_file','read_lines','list_files','search_files','search_codebase',
  'find_relevant_files','search_docs','git_status','git_diff','git_log','git_blame','get_diagnostics',
  'check_syntax','find_symbol','find_references',
  // activate_skill only reads a file the user installed. What a skill then
  // TELLS the model to do is gated as it always was — see src/skills.js.
  'activate_skill',
  'web_search','fetch_url','get_terminal_output','read_process_output',
  // A sub-agent only ever reads, so delegating is parallel-safe: two
  // investigations of different questions share nothing but the filesystem
  // they are both reading. This is what lets a model fan out — "how does auth
  // work here" and "where is the retry logic" answered at the same time rather
  // than one after the other, each costing a full model-call budget in series.
  'delegate_research']);

// What a delegate_research sub-agent is itself allowed to call: everything
// parallel-safe EXCEPT delegating again.
//
// The two sets were one, which was right while they agreed. They stopped
// agreeing the moment delegation became parallel-safe: an agent that can
// delegate can delegate to an agent that can delegate, and that recursion has
// no natural floor. Each level costs its own model-call budget, the cost lands
// on the delegating turn, and nothing in the returned text would tell you it
// had happened. Derived from READ_ONLY by subtraction rather than written out
// again, so a tool added to one is still added to both.
const SUB_AGENT_TOOLS = new Set([...READ_ONLY].filter(n => n !== 'delegate_research'));

// How many sub-agents may run at once. The batching path imposes no limit of
// its own — for reads that is fine, but each delegation is a whole agent loop
// with its own model calls, so a model that emitted a dozen would spend twelve
// budgets simultaneously. Four is enough for the fan-out this exists for and
// small enough that a runaway is bounded rather than expensive.
const MAX_CONCURRENT_DELEGATIONS = 4;

// Every shell Navy can run a command STRING through (navy.shell). Three
// properties matter and they are not interchangeable:
//
//   posix    — which escaping dialect _shellEscapeArg must use, AND which
//              syntax the model is told to write. Getting it wrong produces
//              commands that fail in a way that reads as the model not knowing
//              its own OS, when it was really handed the wrong dialect.
//   verbatim — a cmd.exe-only quoting mode. See _shellSpec for why cmd needs
//              it and why nothing else may have it.
//   args     — how the command string is handed to that shell.
//
// PowerShell needs three flags cmd.exe does not. -NoProfile, or every command
// pays for the user's profile script and inherits whatever it redefined.
// -NonInteractive, so a cmdlet that wants to prompt fails instead of hanging a
// turn forever behind a prompt nobody can see. And an explicit exit, because
// powershell.exe otherwise reports 0 after a native program that failed —
// while the whole tool loop reads "Exit code:" to decide whether a command
// worked, so a silent 0 would tell the model a broken build succeeded. It goes
// on its own LINE rather than after a semicolon: a command ending in a "#"
// comment would swallow the semicolon form.
const PS_ARGS = (command) => ['-NoProfile', '-NonInteractive', '-Command', command + '\nexit $LASTEXITCODE'];

const SHELLS = {
  sh:   { bin: 'sh',   label: 'sh',      posix: true,  verbatim: false, args: (c) => ['-c', c],
          probe: 'command -v <tool>',
          dialect: 'POSIX sh/bash-compatible syntax.' },
  bash: { bin: 'bash', label: 'bash',    posix: true,  verbatim: false, args: (c) => ['-c', c],
          probe: 'command -v <tool>',
          dialect: 'bash syntax (POSIX-compatible).' },
  cmd:  { bin: 'cmd',  label: 'cmd.exe', posix: false, verbatim: true,  args: (c) => ['/c', c],
          probe: 'where <tool>',
          dialect: 'cmd.exe syntax — NOT PowerShell: %VAR% for env vars, & or && to chain, "dir" not "Get-ChildItem", "del" not "Remove-Item".' },
  powershell: { bin: 'powershell', label: 'Windows PowerShell (powershell.exe)', posix: false, verbatim: false, args: PS_ARGS,
          probe: 'Get-Command <tool>',
          dialect: 'PowerShell syntax — NOT cmd.exe: $env:VAR for env vars, ; or && to chain, Get-ChildItem/ls not "dir /b", Remove-Item/rm not "del". Native programs (git, node, npm) are invoked normally.' },
  pwsh: { bin: 'pwsh', label: 'PowerShell 7 (pwsh)', posix: false, verbatim: false, args: PS_ARGS,
          probe: 'Get-Command <tool>',
          dialect: 'PowerShell syntax — NOT cmd.exe: $env:VAR for env vars, ; or && to chain, Get-ChildItem/ls not "dir /b", Remove-Item/rm not "del". Native programs (git, node, npm) are invoked normally.' },
};

// Shared by _collectRelevance (keyword search) and _listCodeFiles (embedding
// index) — both walk the same repo the same way, so a single definition
// keeps their notion of "a code file worth looking at" from drifting apart.
// Re-anchors a replacement block to the indentation of the region it is
// actually replacing.
//
// Strategy 3 above matches on TRIMMED lines, which is the whole point — a
// model reconstructing a search block from memory gets the code right and the
// indentation wrong constantly, and refusing the edit over leading whitespace
// wastes a round-trip. But the replacement was then spliced in at whatever
// indentation the model happened to write, so a match found at four spaces
// deep came back at column zero: a mangled diff in any language, and broken
// code outright in Python, YAML, or anything else where indentation is syntax.
//
// The correction is a single uniform delta, taken from the first line that is
// non-blank on BOTH sides, so the replacement keeps its own internal nesting
// and only its base indentation moves. When the two indents are not a prefix
// of one another (spaces on one side, tabs on the other) nothing is guessed —
// the replacement is left exactly as written, which is the previous behaviour.
function reindentReplacement(searchLines, matchedLines, replaceLines) {
  const leading = (s) => (s.match(/^[ \t]*/) || [''])[0];
  let fileIndent = null, searchIndent = null;
  for (let i = 0; i < searchLines.length; i++) {
    if (!searchLines[i].trim() || !matchedLines[i] || !matchedLines[i].trim()) continue;
    searchIndent = leading(searchLines[i]);
    fileIndent = leading(matchedLines[i]);
    break;
  }
  if (fileIndent === null || fileIndent === searchIndent) return replaceLines;

  if (fileIndent.startsWith(searchIndent)) {
    const add = fileIndent.slice(searchIndent.length);
    return replaceLines.map(l => (l.trim() ? add + l : l));
  }
  if (searchIndent.startsWith(fileIndent)) {
    const drop = searchIndent.length - fileIndent.length;
    return replaceLines.map(l => {
      if (!l.trim()) return l;
      // Only ever remove whitespace — never a real character, however
      // shallowly the line happens to be indented.
      const removable = Math.min(drop, leading(l).length);
      return l.slice(removable);
    });
  }
  return replaceLines; // mixed tabs/spaces — do not guess
}

function literalReplace(original, search, replace) {
  // 1. Exact match.
  const first = original.indexOf(search);
  if (first !== -1) {
    if (original.indexOf(search, first + 1) !== -1)
      return new Error('SEARCH string matches more than one location — make it more specific so the edit is unambiguous.');
    return original.slice(0, first) + replace + original.slice(first + search.length);
  }

  // 2. CRLF → LF normalisation (handles Windows line-ending mismatch).
  // Strategies 2 and 3 work on LF-normalised text, so remember the file's original
  // line ending and restore it on output — otherwise one small edit silently
  // rewrites every line ending in the file (a whole-file git diff).
  const hadCRLF    = original.includes('\r\n');
  const restoreEol = (s) => hadCRLF ? s.replace(/\r?\n/g, '\r\n') : s;
  const normOrig   = original.replace(/\r\n/g, '\n');
  const normSearch = search.replace(/\r\n/g, '\n');
  const normReplace = replace.replace(/\r\n/g, '\n');
  const firstNorm  = normOrig.indexOf(normSearch);
  if (firstNorm !== -1) {
    if (normOrig.indexOf(normSearch, firstNorm + 1) !== -1)
      return new Error('SEARCH string matches more than one location — make it more specific so the edit is unambiguous.');
    return restoreEol(normOrig.slice(0, firstNorm) + normReplace + normOrig.slice(firstNorm + normSearch.length));
  }

  // 3. Line-level fuzzy match — tolerates leading-whitespace mismatches (indentation drift).
  const searchLines = normSearch.split('\n');
  const origLines   = normOrig.split('\n');
  const sLen        = searchLines.length;
  const trimSearch  = searchLines.map(l => l.trim());

  let bestIdx   = -1;
  let bestScore = 0;
  let ambiguous = false;

  for (let i = 0; i <= origLines.length - sLen; i++) {
    let hits = 0;
    for (let j = 0; j < sLen; j++) {
      if (origLines[i + j].trim() === trimSearch[j]) hits++;
    }
    const score = hits / sLen;
    if (score > bestScore) { bestScore = score; bestIdx = i; ambiguous = false; }
    else if (score === bestScore && score > 0) { ambiguous = true; }
  }

  if (bestScore >= 0.85 && !ambiguous && bestIdx !== -1) {
    const before = origLines.slice(0, bestIdx).join('\n');
    const after  = origLines.slice(bestIdx + sLen).join('\n');
    const matched = origLines.slice(bestIdx, bestIdx + sLen);
    const indented = reindentReplacement(searchLines, matched, normReplace.split('\n')).join('\n');
    return restoreEol((before ? before + '\n' : '') + indented + (after ? '\n' + after : ''));
  }

  return null;
}


// Matches the handful of OS/toolchain error strings that mean "a path in
// this command doesn't actually exist" (cmd.exe, POSIX shells, and common
// compiler frontends all phrase this differently) — used by _spawnAndCollect
// to nudge the model toward verifying the real name instead of guessing a
// new spelling and retrying, which otherwise repeats indefinitely (a wrong
// path never becomes right by chance). Deliberately narrow: only genuine
// "this path/command doesn't exist" signatures, never a generic non-zero
// exit, so a real compile error or test failure never gets misdiagnosed as
// a path problem. Pure.
function looksLikeMissingPathError(output) {
  // "file not found" is cmd.exe's own wording for `dir`/`type` on a path that
  // isn't there — and also clang's ("'foo.h' file not found"), which is the
  // same class of problem. It was missing until _shellEscapeArg was fixed:
  // before that, quoting corruption meant a not-found path reached cmd
  // mangled, so it reported a SYNTAX error instead and this pattern never had
  // to recognise the plain not-found case.
  return /cannot find the (file|path) specified|the filename, directory name, or volume label syntax is incorrect|is not recognized as an internal or external command|no such file or directory|\bfile not found\b|command not found/i.test(output);
}

// Wraps a tool's result in whichever wire shape the model expects: a native
// tool-result message when the model used real provider tool-calling, or an
// XML-tagged user message for the JSON-fallback path (small/local models).
// Shared by the main turn loop and delegate_research's own sub-agent loop —
// this shape has needed provider-specific fixes before (Anthropic
// cache_control, DeepSeek's required `type` field, …), and a single
// definition means a future one can't be applied to one caller and
// forgotten on the other. Pure.
function makeToolResultMessage(tool, result, isNative) {
  return isNative
    ? { role: 'tool', tool_call_id: tool.id || '', content: String(result) }
    : { role: 'user', content: '<tool_result name="' + tool.name + '">\n' + result + '\n</tool_result>' };
}

// Reads only the last `maxBytes` of a file via a positional read, instead of
// loading the whole thing into memory just to throw away everything but the
// tail — used for persisted background-process logs, which a chatty dev
// server can grow to multi-MB, and which get read repeatedly (once per
// read_process_output call, and up to 20 times by run_project's own
// server-URL poll). A synchronous full-file read on the extension host's
// single thread scales with how much the process has ever logged, not with
// maxBytes; this scales with neither the file's total size nor how many
// times it's read.
function readFileTail(filePath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const readSize = Math.min(size, maxBytes);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    // Cutting at a byte offset lands mid-character whenever the boundary falls
    // inside a multi-byte UTF-8 sequence, and decoding that yields a leading
    // U+FFFD — visible junk at the top of every truncated read. A lead byte is
    // 0b0xxxxxxx (ASCII) or 0b11xxxxxx (sequence start); 0b10xxxxxx is a
    // continuation, so skipping forward to the first non-continuation byte
    // drops at most 3 bytes of a character that was already incomplete. Only
    // applies when the read actually started mid-file — a tail covering the
    // whole file begins on a real character boundary by definition. Kept
    // inline rather than factored out: the test suite extracts this function
    // by name and evaluates it standalone.
    let from = 0;
    if (readSize < size) {
      while (from < 4 && from < buf.length && (buf[from] & 0xc0) === 0x80) from++;
    }
    return (from ? buf.subarray(from) : buf).toString('utf8');
  } catch { return ''; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}

// Tool definitions — used both for the XML-fallback prompt and for native Ollama tool calling.
const { TOOLS, TOOLS_API, TOOL_PROMPT, TOOLS_API_CORE, TOOL_PROMPT_CORE, WITHHELD_TOOLS } = require('./providers/tools.js');

// ── Replayable record of a turn's tool cards ────────────────────────────────
// A session used to persist only role + text, so reopening a chat replaced
// every activity row, terminal card and edit card with bare prose — the
// transcript claimed the model had simply answered, with no sign of the twenty
// tools it ran to get there. What the webview renders live is a pure function
// of (tool, args, result), so recording those three is enough to redraw the
// same cards on restore; see renderHistoryItem in media/main.js.
//
// The caps exist because this goes into .navy/chats/<id>.json, which the user
// keeps in their repo. Persisting raw tool output would put whole file bodies
// (read_file), whole diffs and whole search results into it, several times over.
const CARD_LOG_MAX = 60;             // cards recorded per turn
const CARD_RESULT_MAX = 400;         // enough for any preview line the cards show
const CARD_TERM_RESULT_MAX = 4000;   // run_command/run_tests print real output in the card
// The only argument keys the cards actually display (addToolCallCard). Anything
// else — notably write_file's `content` and apply_edit's search/replace bodies —
// is deliberately dropped rather than truncated: it is never shown, and it is
// the single biggest thing that would bloat the file.
const CARD_ARG_KEYS = ['path','directory','query','command','filter','id','url','fact','name','from','to','start','end','line'];
const CARD_ARG_MAX = 200;

// Compact one executed tool call into something the webview can redraw.
// Pure — takes the raw result, returns the record, and never mutates its input.
function makeCardRecord(tool, args, result) {
  const slimArgs = {};
  for (const key of CARD_ARG_KEYS) {
    const v = args?.[key];
    if (v === undefined || v === null || v === '') continue;
    slimArgs[key] = typeof v === 'number' ? v : String(v).slice(0, CARD_ARG_MAX);
  }
  const raw = typeof result === 'string' ? result : String(result ?? '');
  const cap = (tool === 'run_command' || tool === 'run_tests') ? CARD_TERM_RESULT_MAX : CARD_RESULT_MAX;
  const record = { tool, args: slimArgs, result: raw.length > cap ? raw.slice(0, cap) : raw };
  // Truncating changes what the card would count ("3 lines" for a 900-line
  // file), so when anything is dropped the true sizes travel with the excerpt
  // and the preview uses those instead — see buildResultPreview.
  if (raw.length > cap) {
    record.full = {
      chars: raw.length,
      lines: raw.split('\n').length,
      filled: raw.split('\n').filter(l => l.trim()).length,
    };
  }
  return record;
}

// Per-project state that used to live as flat NavyCoderViewProvider instance
// fields (messages, checkpoints, isBusy, bgProcesses, …) — extracted so more
// than one project's state can be tracked at once without a switch clobbering
// whatever was live for the previous one. NavyCoderViewProvider exposes every
// field below as a getter/setter proxying to the ACTIVE session (see the
// property block right after its constructor), so every existing
// `this.messages`, `this.isBusy`, `this.checkpoints`, etc. call site
// elsewhere in this file keeps working completely unchanged — this class
// only changes WHERE that state physically lives, not how it's used.
//
// Identity is a generated `id`, NOT projectRoot — a tab ("New Chat") can
// exist before any project is assigned to it, and `projectRoot` is a plain
// mutable field on the session rather than its lookup key. MANY sessions can
// share the same projectRoot at once — the tab strip shows them as that
// project's own set of chats (children of the project, selected via the
// dropdown), each persisted to its OWN file under that project's .navy/
// directory (.navy/chats/<id>.json — see _ensureProjectChatsLoaded /
// saveProjectSession), so two chats on the same project never clobber each
// other's history the way a single shared session.json used to.
class Session {
  constructor(id, projectRoot) {
    this.id = id;
    this.projectRoot = projectRoot || '';
    this.lastReply = '';
    this.abortController = undefined;
    this.messages = [];
    this.pendingApprovals = new Map();
    this.pendingCommandApprovals = new Map();
    this.checkpoints = [];
    this.redoStack = []; // entries: { files: [{ filePath, text }] } — text as it was before the undo
    this.activeToolCall = null;
    this.messageQueue = [];   // queued prompts while a turn is in progress
    this.isBusy = false;
    this.currentTurnId = null;     // groups checkpoints for per-turn undo
    this.bgProcesses = new Map(); // id → { proc, stdout, stderr, exitCode }
    this.bgWorkers   = new Map(); // taskId → { ctrl: AbortController }
    this.bgWorkerId  = 0;
    this.sessionDigest = '';
    // Learned chars-per-token for THIS conversation, and the previous call's
    // (chars, promptTokens) pair the next delta is measured against. In memory
    // only: it re-learns within a turn or two, and persisting a stale ratio
    // from a conversation whose content mix has since changed would be worse
    // than starting from the default. See _observeTokenRatio.
    this.charsPerToken = 0;
    this._cptSample = null;
    this._updated = ''; // ISO timestamp of the last save to this chat's own file — used to pick the most-recent chat when reactivating a project
    // Token usage from delegate_research sub-agent calls made DURING the
    // current turn — reset at the start of each turn, folded into that
    // turn's meta.tokens at the end (see toolDelegateResearch/_askNavyTurn).
    // Session-scoped (not a local var in _askNavyTurn) because
    // toolDelegateResearch is a separate method with no other channel back
    // into the turn's own token accounting.
    this.subAgentTokens = { prompt: 0, completion: 0 };
    // Sub-agents running RIGHT NOW in this chat. Delegation is parallel-safe, so
    // a model can fan several investigations out at once — this is what keeps
    // that bounded. See MAX_CONCURRENT_DELEGATIONS.
    this._activeDelegations = 0;
    // The current task plan: [{ step, status }]. Belongs to a chat, persists
    // with it, and is reset at the start of each turn — see src/plan.js.
    this.plan = [];
    this.planTurnId = null;
    // The model the currently-running turn was invoked with (the picker's
    // choice arrives per-request, so it can differ from navy.model). Read by
    // tools that make their own model calls — see toolDelegateResearch.
    this.activeModel = '';
    // Provider-fallback notices raised during the current turn, folded into
    // that turn's persisted reply text at the end — see _announceFallback.
    this.fallbackNotices = [];
    this._checkpointTurnId = undefined;
    this._heartbeat = undefined;
    this._watchdog = undefined;
    this._cpSaveTimer = undefined;
    // Write-lock, gutter-decoration ranges, and embeddings/repo-map/
    // .gitignore/relevance caches all live on the PROVIDER, keyed by
    // project root (see _projectCaches / the _proj getter) — not here. They
    // mirror shared on-disk/filesystem state (and, for the write-lock, a
    // shared invariant — no two writes to the same file at once) that's the
    // same for every chat on a project, so they must be shared across
    // sibling sessions, not duplicated per chat.
  }
}

class NavyCoderViewProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.sessions = new Map(); // generated id → Session; lets more than one tab's state exist at once
    // Restore the last picked project root (persisted via navy.projectRoot) so the
    // project choice survives window reloads. Scope matters: the workspace-level value
    // always applies, but the global value is only trusted when NO workspace is open —
    // otherwise a root saved in a folderless window would leak into every workspace.
    // Precedence: what Navy remembered for THIS workspace, then navy.projectRoot
    // as a user-set override (and as the upgrade path — a value written by
    // 0.2.6 or earlier is still picked up here, so nobody loses their project
    // when they update). workspaceState is inherently per-workspace, so unlike
    // the old inspect()-based logic there is no way for a root chosen in a
    // folderless window to leak into an unrelated workspace.
    const folderPaths = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    const savedRoot = String(context.workspaceState?.get(WS_LAST_PROJECT_ROOT) || '')
      || String(vscode.workspace.getConfiguration('navy').get('projectRoot', '') || '');
    // The saved root must still exist AND belong to the folders open right now.
    // Without the second check, a root left over from a different project makes
    // the chat silently operate on a project that isn't open, forcing the user to
    // fix it by hand in the picker every time they open that folder.
    const initialRoot = (savedRoot && fs.existsSync(savedRoot) && rootBelongsToWorkspace(savedRoot, folderPaths))
      ? savedRoot
      : '';
    const initialId = this.generateId();
    this.sessions.set(initialId, new Session(initialId, initialRoot));
    this.activeSessionId = initialId;
    this._bootstrapSessionId = initialId; // identifies ONLY this constructor-created placeholder — see _activateProjectRoot's cleanup, which must never sweep up a deliberately-created empty "+" tab
    this._loadedChatRoots = new Set(); // roots whose .navy/chats/ has been read from disk this window — read once, then trust in-memory state
    this._orphanCheckedRoots = new Set(); // roots already checked for leftover persisted background processes this window — see _checkOrphanedBgProcesses
    this._lastActiveByRoot = new Map(); // projectRoot -> sessionId, so re-selecting a project resumes whichever of its chats you were last on
    this._projectCaches = new Map(); // projectRoot -> { embedIndexCache, embedInFlight, embedUnavailable, embedSaveTimer, repoMapCache, relCache, gitIgnoredCache } — shared across every chat on that project, see the _proj getter
    // The window Navy actually uses: sent as num_ctx to Ollama, and the
    // denominator of the context-fill gauge. Derived from modelContextMax and
    // the user's navy.contextWindow choice — see _applyContextWindow. Tied to
    // the active model, not a project.
    this.modelContextLength = null;
    this.modelContextMax = null; // the largest window the ACTIVE model reports, before the user's choice is applied
    // Restore the persisted thinking level so the choice survives window reloads.
    this.thinkingLevel = vscode.workspace.getConfiguration('navy').get('thinkingLevel', 'medium');
    this.statusBarItem = null; // set by activate() after construction
    this.log = null; // set by activate() → Navy Coder output channel; safe to call before
    this.mcp = new McpManager((line) => this.log?.(line)); // external MCP tool servers — shared across all sessions, config is global
    this.dictation = null; // DictationBridge while a voice session is open; see startDictation()
    this.gutterDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
  }

  // ── Active-session field proxies ─────────────────────────────────────────
  // Every getter/setter below reads/writes the ACTIVE Session object instead
  // of a flat field on `this`. `_session` lazily creates a blank one if
  // somehow missing (defensive — activeSessionId should always name a real
  // entry in `this.sessions` once the constructor has run).
  get _session() {
    // A turn/background-task running inside sessionContext.run(...) keeps
    // resolving to the session it STARTED with, even after the user switches
    // the visible tab to a different one — only code running outside any
    // such context (webview message handlers reacting to whatever tab is
    // currently on-screen) falls back to the live activeSessionId.
    const ctxId = sessionContext.getStore();
    const key = ctxId !== undefined ? ctxId : this.activeSessionId;
    let s = this.sessions.get(key);
    if (!s) { s = new Session(key, ''); this.sessions.set(key, s); }
    return s;
  }

  get projectRoot() { return this._session.projectRoot; }
  set projectRoot(root) {
    // A plain field mutation on the ACTIVE tab — session identity is a
    // generated id (see the Session class), independent of which project a
    // tab is pointed at, so assigning here never switches tabs or creates a
    // new one. "Switch to a different EXISTING tab" is done by assigning
    // activeSessionId directly (see switchSessionTab), and "point Navy at a
    // root, reusing an existing tab for it if one already has it" is
    // _switchProjectRoot's job, not this setter's.
    this._session.projectRoot = root || '';
  }

  get lastReply() { return this._session.lastReply; }
  set lastReply(v) { this._session.lastReply = v; }
  get abortController() { return this._session.abortController; }
  set abortController(v) { this._session.abortController = v; }
  get messages() { return this._session.messages; }
  set messages(v) { this._session.messages = v; }
  get pendingApprovals() { return this._session.pendingApprovals; }
  set pendingApprovals(v) { this._session.pendingApprovals = v; }
  get pendingCommandApprovals() { return this._session.pendingCommandApprovals; }
  set pendingCommandApprovals(v) { this._session.pendingCommandApprovals = v; }
  get checkpoints() { return this._session.checkpoints; }
  set checkpoints(v) { this._session.checkpoints = v; }
  get redoStack() { return this._session.redoStack; }
  set redoStack(v) { this._session.redoStack = v; }
  get activeToolCall() { return this._session.activeToolCall; }
  set activeToolCall(v) { this._session.activeToolCall = v; }
  get messageQueue() { return this._session.messageQueue; }
  set messageQueue(v) { this._session.messageQueue = v; }
  get isBusy() { return this._session.isBusy; }
  set isBusy(v) { this._session.isBusy = v; }
  get currentTurnId() { return this._session.currentTurnId; }
  set currentTurnId(v) { this._session.currentTurnId = v; }
  get bgProcesses() { return this._session.bgProcesses; }
  set bgProcesses(v) { this._session.bgProcesses = v; }
  // Project-scoped, not session-scoped: two sibling chats on the SAME
  // project can each run a turn/background task at once, and both may
  // mutate files — the lock has to serialize across ALL of a project's
  // chats, not just within one, or two chats' writes to the same file can
  // interleave and corrupt it. See _proj.
  get _writeLock() { return this._proj.writeLock; }
  set _writeLock(v) { this._proj.writeLock = v; }
  get bgWorkers() { return this._session.bgWorkers; }
  set bgWorkers(v) { this._session.bgWorkers = v; }
  get bgWorkerId() { return this._session.bgWorkerId; }
  set bgWorkerId(v) { this._session.bgWorkerId = v; }
  // Project-scoped, not session-scoped: gutter marks reflect real edits on
  // disk, which exist regardless of which of a project's chats made them.
  // Session-scoping this meant a sibling chat writing to a shared file
  // would call applyGutterDecorations with ITS OWN (mostly empty)
  // editedRanges map, wiping out the gutter marks another chat had just set
  // for that same file/editor.
  get editedRanges() { return this._proj.editedRanges || (this._proj.editedRanges = new Map()); }
  set editedRanges(v) { this._proj.editedRanges = v; }
  get plan() { return this._session.plan; }
  set plan(v) { this._session.plan = v; }
  get planTurnId() { return this._session.planTurnId; }
  set planTurnId(v) { this._session.planTurnId = v; }
  get charsPerToken() { return this._session.charsPerToken; }
  set charsPerToken(v) { this._session.charsPerToken = v; }
  get _cptSample() { return this._session._cptSample; }
  set _cptSample(v) { this._session._cptSample = v; }
  get sessionDigest() { return this._session.sessionDigest; }
  set sessionDigest(v) { this._session.sessionDigest = v; }
  get subAgentTokens() { return this._session.subAgentTokens; }
  set subAgentTokens(v) { this._session.subAgentTokens = v; }
  get _checkpointTurnId() { return this._session._checkpointTurnId; }
  set _checkpointTurnId(v) { this._session._checkpointTurnId = v; }
  get _heartbeat() { return this._session._heartbeat; }
  set _heartbeat(v) { this._session._heartbeat = v; }
  get _watchdog() { return this._session._watchdog; }
  set _watchdog(v) { this._session._watchdog = v; }
  get _cpSaveTimer() { return this._session._cpSaveTimer; }
  set _cpSaveTimer(v) { this._session._cpSaveTimer = v; }

  // Embeddings/repo-map/.gitignore caches are keyed by PROJECT ROOT, not by
  // chat session — they mirror a single shared on-disk file
  // (.navy/embeddings.json) and filesystem state that's the same regardless
  // of which of a project's chats is asking. Session-scoping these (as they
  // were before) meant two sibling chats on the same project each kept
  // their OWN copy of the embedding index and their OWN in-flight/
  // rate-limit guards — so both could kick off redundant embedding calls at
  // once (exactly what _embedInFlight exists to prevent), and whichever
  // chat's debounced save fired last would silently overwrite the other's
  // additions to the shared embeddings.json.
  get _proj() { return this._projCacheFor(this.projectRoot); }

  // Same lookup as _proj, but for an EXPLICIT root rather than the active
  // session's — needed by anything that takes `root` as its own parameter
  // (the bg-process manifest lock below) rather than always meaning "the
  // currently active tab's project", which may differ or may no longer be
  // active at all by the time an async continuation (e.g. a persisted
  // process's exit handler, which can fire long after its own tab closed)
  // actually runs.
  _projCacheFor(root) {
    let p = this._projectCaches.get(root);
    if (!p) {
      p = { writeLock: Promise.resolve(), lastTouched: Date.now() };
      this._projectCaches.set(root, p);
      // Stamped BEFORE evicting, and the entry is exempted by root below:
      // eviction sorts on `lastTouched || 0`, so an unstamped brand-new entry
      // sorted as the OLDEST and became the first thing thrown away — the
      // exact inverse of the intent. That mattered for real: _withBgManifestLock
      // asks for the cache of a root with no open session (a persisted
      // process's exit handler firing after its tab closed), then stores the
      // lock on the object it got back — which, once evicted, is detached, so
      // the next writer creates a fresh entry with no lock and manifest writes
      // stop being serialized at all.
      this._evictStaleProjectCaches(root);
    } else {
      p.lastTouched = Date.now();
    }
    return p;
  }

  // ── Cache invalidation on real file changes ────────────────────────────────
  // The repo map, relevance and gitignore caches used to expire purely on time
  // (30s/30s/60s). That is not a performance tuning choice, it is a correctness
  // one: inside that window Navy answers from a snapshot of a file that has
  // since changed — including files IT just edited, and files the user changed
  // in the editor while a turn was running. Time never told us anything about
  // whether the answer was still true; the filesystem does.
  //
  // One watcher for the whole window rather than one per project: an event is
  // matched back to whichever cached project contains the path, so multi-root
  // workspaces and sibling chats on different projects are covered without
  // re-creating anything when the active project changes.
  _startFileWatcher() {
    if (this._fileWatcher) return this._fileWatcher;
    if (typeof vscode.workspace.createFileSystemWatcher !== 'function') return null;
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate((uri) => this._invalidatePathCaches(uri?.fsPath, 'create'));
    watcher.onDidChange((uri) => this._invalidatePathCaches(uri?.fsPath, 'change'));
    watcher.onDidDelete((uri) => this._invalidatePathCaches(uri?.fsPath, 'delete'));
    this._fileWatcher = watcher;
    return watcher;
  }

  // Invalidation is deliberately just three assignments — everything here is
  // rebuilt lazily on next use, so a `git checkout` firing thousands of events
  // costs three writes each and no work at all until something asks again.
  _invalidatePathCaches(fsPath, kind = 'change') {
    if (!fsPath) return;
    // Navy writes into .navy/ continuously (chats, background logs, the
    // embedding index) and node_modules/dist churn on every install or build.
    // Reacting to those would invalidate on our own writes, permanently — a
    // watcher that never lets a cache live is worse than no cache. Reuses the
    // walker's own skip list so the two can't disagree about what counts as
    // project content.
    for (const segment of String(fsPath).split(/[\\/]+/)) {
      if (RELEVANCE_SKIP_DIRS.has(segment)) return;
    }
    const isGitignore = /(^|[\\/])\.gitignore$/.test(fsPath);
    for (const [root, cache] of this._projectCaches) {
      if (!root || !(fsPath === root || fsPath.startsWith(root + path.sep))) continue;
      cache.repoMapCache = null;
      cache.relCache = null;
      // Editing a file cannot change whether git ignores it — only the rules
      // changing, or the file appearing/disappearing, can. Recomputing this one
      // shells out to git, so it is left alone for the common case.
      if (isGitignore || kind === 'create' || kind === 'delete') cache.gitIgnoredCache = null;
    }
  }

  // Keeps _projectCaches bounded — without this it grows by one entry for
  // every distinct project root ever visited in this window, for the rest of
  // the window's life, holding onto that project's embedding vectors/repo-map/
  // relevance caches long after the user has moved on. Only ever evicts a
  // root with NO currently-open chat tab anywhere in this window: that's
  // exactly the condition under which no turn or background task could be
  // touching its write lock, so this can never race a real write — a write
  // already in flight keeps its own reference to the writeLock it captured
  // regardless of whether the Map entry still exists, and a NEW write can
  // only start once a session for that root exists again, which is precisely
  // what "currently-open" rules out. embedSaveTimer is cleared, not flushed,
  // on eviction — the same tradeoff dispose() already makes on full shutdown.
  _evictStaleProjectCaches(protectRoot) {
    if (this._projectCaches.size <= PROJECT_CACHE_CAP) return;
    const openRoots = new Set([...this.sessions.values()].map(s => s.projectRoot).filter(Boolean));
    const evictable = [...this._projectCaches.entries()]
      .filter(([root]) => !openRoots.has(root) && root !== protectRoot)
      .sort((a, b) => (a[1].lastTouched || 0) - (b[1].lastTouched || 0)); // oldest-touched first
    let over = this._projectCaches.size - PROJECT_CACHE_CAP;
    for (const [root, cache] of evictable) {
      if (over <= 0) break;
      clearTimeout(cache.embedSaveTimer);
      this._projectCaches.delete(root);
      over--;
    }
  }
  get _embedIndexCache() { return this._proj.embedIndexCache; }
  set _embedIndexCache(v) { this._proj.embedIndexCache = v; }
  get _embedInFlight() { return this._proj.embedInFlight; }
  set _embedInFlight(v) { this._proj.embedInFlight = v; }
  get _embedUnavailable() { return this._proj.embedUnavailable; }
  set _embedUnavailable(v) { this._proj.embedUnavailable = v; }
  get _embedSaveTimer() { return this._proj.embedSaveTimer; }
  set _embedSaveTimer(v) { this._proj.embedSaveTimer = v; }
  get _repoMapCache() { return this._proj.repoMapCache; }
  set _repoMapCache(v) { this._proj.repoMapCache = v; }
  get _relCache() { return this._proj.relCache; }
  set _relCache(v) { this._proj.relCache = v; }
  get _gitIgnoredCache() { return this._proj.gitIgnoredCache; }
  set _gitIgnoredCache(v) { this._proj.gitIgnoredCache = v; }

  async resolveWebviewView(webviewView) {
    this.view = webviewView;
    // Auto-tag every outgoing message with the session it belongs to — reads
    // sessionContext first (so a background turn's messages stay tagged with
    // ITS session even after the user switches tabs), falling back to
    // whichever tab is currently on-screen for everything else (settings,
    // model list, and other UI-driven messages with no running turn behind
    // them). Wrapping the ONE postMessage call here, instead of editing every
    // one of the ~150 `this.view.webview.postMessage(...)` call sites
    // elsewhere in this file, keeps every existing call site unchanged —
    // same trick as the Session getter/setter proxies above.
    const realPostMessage = webviewView.webview.postMessage.bind(webviewView.webview);
    webviewView.webview.postMessage = (message) => {
      const sessionId = sessionContext.getStore() ?? this.activeSessionId;
      return realPostMessage({ sessionId, ...message });
    };

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Cancel all pending approvals when the panel is closed so awaiting promises resolve.
    // Dictation goes with it: with no panel there is nowhere for the words to
    // land, and an open microphone port must not outlive its only consumer.
    webviewView.onDidDispose(() => {
      this.cancelAllPendingApprovals();
      this.stopDictation('panel closed');
    });

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          // Webview script is live — send all startup state now so nothing is dropped.
          this.sendActiveFile();
          await this.loadModels();
          this.sendApprovalMode();
          this.sendSettings();
          this.view?.webview.postMessage({ type: 'thinkingLevel', level: this.thinkingLevel });
          if (!this.projectRoot) await this._restoreLastProject();
          if (this.projectRoot) await this._activateProjectRoot(this.projectRoot);
          await this.sendWorkspaceFolders();
          await this.loadProjectSession();
          this._sendSessionList();
          await this.sendSlashCommands();
          // Say plainly when tools are restricted, rather than letting the user
          // discover it by watching every command get refused.
          if (!workspaceIsTrusted()) {
            this.view?.webview.postMessage({ type: 'restrictedMode' });
          }
          break;
        case 'newSessionTab':
          await this.openNewSessionTab();
          break;
        case 'switchSessionTab':
          await this.switchSessionTab(message.sessionId || '');
          break;
        case 'closeSessionTab':
          await this.closeSessionTab(message.sessionId || '');
          break;
        case 'ask':
          await this.askNavy(message.prompt, Boolean(message.includeContext), message.model, message.attachedFiles, message.images || [], message.queueId || '');
          break;
        case 'cancelQueued':
          this.cancelQueuedMessage(message.id || '');
          break;
        case 'stop':
          // Stop means stop everything — including prompts waiting in the queue,
          // otherwise the next queued message fires the instant the abort lands.
          // The webview is told WHICH prompts were dropped, not just that the
          // count is now zero: each one is already sitting in the transcript as
          // a user bubble, and leaving those looking sent is the same lie that
          // cancelling one by hand has to avoid.
          this._dropQueuedMessages();
          this.abortController?.abort();
          this.cancelPendingApprovals();
          break;
        case 'insertLastReply':
          await this.insertLastReply();
          break;
        case 'insertCode':
          await this.insertCode(message.text);
          break;
        case 'applyCode':
          await this.applyCode(message.text, message.path);
          break;
        case 'approveDiff':
          await this.resolveApproval(message.id, true);
          break;
        case 'rejectDiff':
          await this.resolveApproval(message.id, false);
          break;
        case 'approveCommand':
          this.resolveCommandApproval(message.id, true);
          break;
        case 'rejectCommand':
          this.resolveCommandApproval(message.id, false);
          break;
        case 'undoLast':
          await this.undoLastCheckpoint();
          break;
        case 'redoLast':
          await this.redoLast();
          break;
        case 'clear':
          this.clearChat();
          break;
        case 'getModels':
          await this.loadModels(true); // explicit refresh — bypass the cache
          break;
        case 'setModel':
          await this.setModel(message.model);
          break;
        case 'setApprovalMode': {
          // Which gate is being changed. Defaults to the file-edit one so an
          // older webview (or a test posting the pre-0.3.1 message shape) still
          // means what it used to, rather than silently switching execution on.
          const key = message.scope === 'command' ? 'commandApproval' : 'approvalMode';
          if (message.mode === 'auto-approve') {
            // Confirm against what THIS switch actually grants. The old single
            // warning listed edits and commands together, which was accurate
            // only because one setting really did control both — now that they
            // are separate, saying "run commands" while flipping the file-edit
            // gate would be the same conflation in the opposite direction.
            const pick = await vscode.window.showWarningMessage(
              key === 'commandApproval'
                ? 'Enable auto-approve for COMMANDS? Navy will run shell commands, start background processes, and call MCP tools WITHOUT asking. Their effects are not contained to the project and cannot be undone.'
                : 'Enable auto-approve for FILE CHANGES? Navy will write, delete and rename files in this project WITHOUT showing you a diff first. Commands are unaffected — see navy.commandApproval.',
              { modal: true },
              'Enable'
            );
            if (pick !== 'Enable') { this.sendApprovalMode(); break; } // revert the dropdown
          }
          await vscode.workspace.getConfiguration('navy').update(key, message.mode, vscode.ConfigurationTarget.Global);
          this.sendApprovalMode();
          break;
        }
        case 'copy':
          await vscode.env.clipboard.writeText(message.text || '');
          break;
        // The webview runs in its own renderer, so when the panel stalls nothing
        // appears in the extension host log — which makes "Navy froze" almost
        // impossible to diagnose from the outside. The webview reports slow
        // renders here so they land in the Navy Coder output channel instead.
        case 'perfWarning': {
          const line = `webview ${message.ms}ms | ${message.chars} chars | ${message.mode || ''}`;
          this.log?.(line);
          // A stall is the thing we've been unable to catch, so make it
          // impossible to miss rather than burying it in the output channel.
          if (String(message.mode || '').startsWith('STALL')) {
            this.outputChannelShow?.();
          }
          break;
        }
        case 'runCommand':
          // Defense in depth: the webview renders model output, so never let it invoke
          // arbitrary VS Code commands (e.g. terminal.sendSequence → shell execution).
          if (message.command && /^navy\.[a-zA-Z]+$/.test(message.command)) {
            vscode.commands.executeCommand(message.command);
          }
          break;
        case 'openFolder':
          await this.openFolder();
          break;
        case 'getWorkspaceFolders':
          await this.sendWorkspaceFolders();
          break;
        case 'setProjectRoot':
          // Never switch roots while a turn is running — executing tools resolve
          // paths against this.projectRoot live, so edits would land in the wrong project.
          if (this._refuseIfBusy()) {
            await this.sendWorkspaceFolders(); // re-send current root so the dropdown reverts
            break;
          }
          await this._switchProjectRoot(message.root || '');
          break;
        case 'openCatalogProject':
          await this.openCatalogProject(message.root || '');
          break;
        case 'setThinkingLevel':
          this.setThinkingLevel(message.level);
          break;
        case 'setContextWindow':
          await this.setContextWindow(message.tokens);
          break;
        case 'clearMemory': {
          const pick = await vscode.window.showWarningMessage(
            'Clear all project memories? This cannot be undone.',
            { modal: true },
            'Clear All'
          );
          if (pick === 'Clear All') await this.toolForget('');
          break;
        }
        case 'getMemory': {
          const mem = await this.loadProjectMemory();
          this.view?.webview.postMessage({ type: 'memoryUpdated', memory: mem });
          break;
        }
        case 'getWorkspaceFiles': {
          try {
            const uris = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 300);
            const files = uris.map(u => u.fsPath).sort();
            this.view?.webview.postMessage({ type: 'workspaceFiles', files });
          } catch {
            this.view?.webview.postMessage({ type: 'workspaceFiles', files: [] });
          }
          break;
        }
        case 'getWorkspaceSymbols': {
          try {
            const syms = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', message.query || '');
            const items = (syms || []).slice(0, 12).map(s => ({
              name: s.name,
              kind: vscode.SymbolKind[s.kind] || 'Symbol',
              file: vscode.workspace.asRelativePath(s.location.uri),
              line: s.location.range.start.line + 1,
              fsPath: s.location.uri.fsPath,
            }));
            this.view?.webview.postMessage({ type: 'workspaceSymbols', symbols: items });
          } catch { this.view?.webview.postMessage({ type: 'workspaceSymbols', symbols: [] }); }
          break;
        }
        case 'exportConversation':
          await this.exportConversation(message.text || '');
          break;
        case 'reviewPR':
          await this.generatePRReview();
          break;
        case 'startBackgroundTask': {
          if (this.bgWorkers.size >= 5) {
            this.view?.webview.postMessage({ type: 'error', message: 'Too many background tasks running (max 5). Wait for one to finish first.' });
            break;
          }
          const taskId = 'bg-' + (++this.bgWorkerId);
          this.view?.webview.postMessage({ type: 'bgTaskUpdate', taskId, status: 'start', prompt: message.prompt });
          // Intentionally not awaited — runs in parallel with the main chat.
          this.runBackgroundTask(taskId, message.prompt);
          break;
        }
        case 'killBackgroundTask': {
          const worker = this.bgWorkers.get(message.taskId);
          if (worker) worker.ctrl.abort();
          break;
        }
        case 'killBgProcess':
          // The Stop button on a background-process panel. Routed through the
          // same tool the model uses, so manifest cleanup and the bgProcessDone
          // notification happen identically either way.
          if (message.id) await this.toolKillProcess(message.id);
          break;
        case 'stopRestoredProcess': {
          // A process from a PREVIOUS session: this window never had a handle
          // on it, so it cannot go through toolKillProcess — it is identified
          // by its task path and re-verified against the manifest before
          // anything is signalled.
          const root = message.root || this.projectRoot;
          if (root && message.taskPath) {
            const note = await this.stopRestoredProcess(root, message.taskPath);
            if (note) this.view?.webview.postMessage({ type: 'statusText', text: note });
          }
          break;
        }
        case 'showRestoredLog': {
          // "Show output" on a recovered row. The log is the only thing left of
          // a process this window never owned, and it is a real file on disk.
          const root = message.root || this.projectRoot;
          const list = root ? await this._readBgManifest(root) : [];
          const rec = list.find(r => (r.taskPath || this._taskPathFor(root, r.id)) === message.taskPath);
          if (rec?.logPath) {
            try {
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(rec.logPath));
              await vscode.window.showTextDocument(doc, { preview: true });
            } catch (e) {
              vscode.window.showWarningMessage('Could not open that log: ' + e.message);
            }
          }
          break;
        }
        case 'openDiffFile':
          // "Open in editor" on a diff card — the card can only ever show a
          // truncated view of a large change, and it used to say "use the
          // editor diff view" with no way to get there.
          if (message.path) {
            try {
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(message.path));
              await vscode.window.showTextDocument(doc, { preview: false });
            } catch (e) {
              vscode.window.showWarningMessage(`Navy: could not open ${path.basename(message.path)} — ${e.message}`);
            }
          }
          break;
        case 'stopRunProject': {
          const entry = this.bgProcesses.get('__run_project__');
          if (entry?.proc) {
            // Kill the full process tree (cmd.exe + npm + node on Windows, process group on Unix).
            // The proc.on('close') handler in toolRunProject will send runProjectStopped once dead.
            this._killProcessTree(entry.proc);
          } else {
            // No process running — acknowledge immediately.
            this.view?.webview.postMessage({ type: 'runProjectStopped', exitCode: 0 });
          }
          break;
        }
        case 'openUrl':
          if (message.url) vscode.env.openExternal(vscode.Uri.parse(message.url));
          break;
        case 'dictate':
          await this.startDictation();
          break;
        case 'dictateStop':
          this.stopDictation('cancelled');
          break;
        case 'getSettings':
          await this.sendSettings();
          break;
        case 'getSlashCommands':
          await this.sendSlashCommands();
          break;
        case 'newSlashCommand':
          await this.createSlashCommand();
          break;
        case 'openSlashCommand':
          // Validated, not taken on trust — see _commandNameForFile.
          if (this._commandNameForFile(message.file)) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(message.file));
            await vscode.window.showTextDocument(doc, { preview: false });
          }
          break;
        case 'deleteSlashCommand':
          await this.deleteSlashCommand(message.file);
          break;
        // The settings panel carries the eleven settings you change while
        // working; the rest are edited in VS Code's own UI. Filtering on
        // 'navy.' opens it already scoped to this extension.
        case 'openVsSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'navy.');
          break;
        // Offered from the no-models notice. Same routine as the Command
        // Palette entry, so there is one diagnosis to keep correct.
        case 'testProvider':
          await this.testProviderConnection();
          break;
        case 'saveSettings': {
          const cfg = vscode.workspace.getConfiguration('navy');
          const s = message.settings || {};
          const T = vscode.ConfigurationTarget.Global;
          if (s.provider   !== undefined) await cfg.update('provider',          s.provider,          T);
          if (s.host       !== undefined) await cfg.update('host',              s.host,              T);
          if (s.ollamaMode !== undefined) await cfg.update('ollamaMode',        s.ollamaMode,        T);
          // Never store a masked display value ('ab12••••cd34') back into secrets.
          if (s.apiKey !== undefined && !String(s.apiKey).includes('••••')) {
            // cfg is a snapshot — cfg.get('provider') would return the PRE-update value.
            // Use the provider from this same save payload when present.
            const currentProvider = s.provider !== undefined ? s.provider : cfg.get('provider', 'ollama');
            await this.context.secrets.store('navy.apiKey.' + currentProvider, s.apiKey);
          }
          if (s.searchApiKey !== undefined && !String(s.searchApiKey).includes('••••')) {
            await this.context.secrets.store('navy.searchApiKey', s.searchApiKey);
          }
          if (s.apiBase    !== undefined) await cfg.update('apiBase',           s.apiBase,           T);
          if (s.temperature!== undefined) await cfg.update('temperature',       Number(s.temperature), T);
          if (s.maxIter    !== undefined) await cfg.update('maxToolIterations', Number(s.maxIter),   T);
          if (s.editFormat !== undefined) await cfg.update('editFormat',        s.editFormat,        T);
          if (s.systemPrompt!==undefined) await cfg.update('systemPrompt',      s.systemPrompt,      T);
          if (s.speechVoice !== undefined) await cfg.update('speechVoice',      String(s.speechVoice), T);
          if (s.speechRate  !== undefined) {
            // Clamped rather than trusted: rate multiplies playback speed, and
            // 0 is silence while 10 is unintelligible. The webview clamps too —
            // this is the guard for a hand-edited settings.json.
            const rate = Number(s.speechRate);
            await cfg.update('speechRate', Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1, T);
          }
          // Reload models in case provider/host/key changed — force a fresh fetch.
          await this.loadModels(true);
          await this.sendSettings();
          vscode.window.showInformationMessage('Navy: Settings saved.');
          break;
        }
      }
    });

    // Startup state is now sent in response to the webview's 'ready' message
    // to avoid a race where postMessage fires before the script listener is set up.

    // Guard against duplicate listeners when the panel is recreated.
    if (!this._globalListenersRegistered) {
      this._globalListenersRegistered = true;
      this.context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => this.sendActiveFile()),
        vscode.workspace.onDidChangeWorkspaceFolders(() => this.sendWorkspaceFolders())
      );
      // Saving a command file is how a custom command gets written, so a save
      // is the event worth listening for — cheaper and more precise than a
      // filesystem watcher, and the general one deliberately ignores .navy/
      // (see _invalidatePathCaches). Guarded because the API is absent in the
      // test mock and in very old VS Code.
      if (typeof vscode.workspace.onDidSaveTextDocument === 'function') {
        this.context.subscriptions.push(
          vscode.workspace.onDidSaveTextDocument((doc) => {
            const p = doc?.uri?.fsPath;
            // A saved SKILL.md changes the "/" menu too, since every skill is
            // also a command — one resend covers both.
            const skills = this._invalidateSkills(p);
            if (this._invalidateSlashCommands(p) || skills) this.sendSlashCommands();
          })
        );
      }
    }

    // Re-send workspace folders whenever the panel becomes visible (e.g. user switches tabs back).
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) return;
      this.sendWorkspaceFolders();
      // A hidden panel is destroyed and rebuilt, so a dictation session that
      // outlived it has to introduce itself again or the mic sits there looking
      // idle while the browser page is still listening.
      if (this.dictation?.running) {
        this.view?.webview.postMessage({ type: 'dictationState', state: 'listening' });
      }
    });
  }

  // Last-resort handler for turns started without an await (queue drain, PR
  // review, explain-error). Those are fire-and-forget by design, so nothing
  // upstream can catch a rejection — and an unhandled rejection in the
  // extension host is a process-level failure, i.e. Navy dying mid-task with no
  // explanation. Surface it in the chat and the log instead, and always release
  // the busy lock so the UI can't be left permanently stuck.
  _reportTurnFailure(err, context) {
    const msg = (err && err.message) || String(err);
    this.log?.(`turn failed (${context}): ${msg}`);
    try {
      this.isBusy = false;
      if (this.statusBarItem) this.statusBarItem.text = '☸ Navy';
      this.view?.webview.postMessage({ type: 'done' });
      this.view?.webview.postMessage({
        type: 'error',
        message: `Navy hit an unexpected error during ${context}: ${msg}`,
      });
    } catch {}
  }

  // Resolve all queued approval promises so the agentic loop is not abandoned.
  // Routed through the SAME resolveApproval/resolveCommandApproval paths a real
  // user rejection uses (treating "cancel" as "reject") — those are the only
  // places that post diffResolved/commandResolved back to the webview. Resolving
  // the promises directly here (the previous approach) left whatever
  // Approve/Reject card was still pending stuck with visibly-enabled but dead
  // buttons after Stop, since nothing ever told the webview it was resolved.
  // Active session only — Stop and Clear are per-chat actions (mirroring
  // the abortController/messageQueue resets right next to their call
  // sites), so this must not reach into an unrelated background tab and
  // reject ITS approvals too. For "cancel literally everything, the whole
  // panel is going away" semantics, see cancelAllPendingApprovals.
  cancelPendingApprovals() {
    for (const id of [...this.pendingApprovals.keys()]) {
      this.resolveApproval(id, false);
    }
    for (const id of [...this.pendingCommandApprovals.keys()]) {
      this.resolveCommandApproval(id, false);
    }
  }

  // Every session's pending approvals — used ONLY when the whole webview
  // panel is being disposed (extension deactivation, view container
  // removed). A background chat's turn can be sitting on an approval right
  // then, and nothing will ever resolve that promise once the webview that
  // would show it is gone, leaving the turn hung forever. Bound via
  // sessionContext.run so resolveApproval/resolveCommandApproval (which
  // read/write through the active-session proxies) act on each session's
  // OWN maps regardless of which one happens to be live.
  cancelAllPendingApprovals() {
    for (const session of this.sessions.values()) {
      sessionContext.run(session.id, () => {
        for (const id of [...session.pendingApprovals.keys()]) {
          this.resolveApproval(id, false);
        }
        for (const id of [...session.pendingCommandApprovals.keys()]) {
          this.resolveCommandApproval(id, false);
        }
      });
    }
  }

  resolveCommandApproval(id, approved) {
    const approval = this.pendingCommandApprovals.get(id);
    if (!approval) return;
    this.pendingCommandApprovals.delete(id);
    approval.resolve(approved);
    this.view?.webview.postMessage({ type: 'commandResolved', id, approved });
  }

  async focus() {
    if (!this.view) {
      // Sidebar has never been opened — this.view doesn't exist yet, so show() would
      // be a silent no-op. VS Code auto-generates <viewId>.focus which opens the Navy
      // container and resolves the view. Give it a moment so callers that immediately
      // send a prompt (inline edit, explain error) don't race the webview handshake.
      try {
        await vscode.commands.executeCommand('navy.chatView.focus');
        await new Promise(r => setTimeout(r, 400));
      } catch {}
      return;
    }
    this.view.show?.(true);
    this.view.webview.postMessage({ type: 'focusInput' });
  }

  clearChat() {
    // Clearing mid-turn: abort the running turn and drop queued prompts first, so a
    // ghost turn can't keep streaming into (and re-saving over) the cleared chat.
    // The queueCleared notice is harmless here (the transcript is about to go)
    // and keeps every queue-abandoning path on one code path.
    this._dropQueuedMessages();
    this.abortController?.abort();
    this.cancelPendingApprovals();
    this.messages = [];
    this.lastReply = '';
    this.sessionDigest = '';
    this.charsPerToken = 0;
    this._cptSample = null;
    this.checkpoints = [];
    this.redoStack = [];
    this.view?.webview.postMessage({ type: 'redoState', count: 0 });
    this._persistCheckpoints();
    // Deliberately does NOT clear editedRanges: gutter marks reflect real
    // edits still sitting on disk (possibly from a sibling chat on the same
    // project too), so clearing THIS conversation must not erase them.
    this.view?.webview.postMessage({ type: 'cleared' });
    // A run-project dev server is deliberately NOT killed by Clear (Clear resets
    // the conversation, not your running work) — but its card has no lazy
    // recreate path like background-task/process cards do, so without this it
    // silently vanishes from the UI while the server keeps running underneath.
    const runProject = this.bgProcesses.get('__run_project__');
    if (runProject?.proc) {
      const projectName = path.basename(this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');
      this.view?.webview.postMessage({ type: 'runProjectStart', projectName, command: runProject.command });
      if (runProject.url) this.view?.webview.postMessage({ type: 'runProjectReady', url: runProject.url });
    }
    this.saveProjectSession();
    this.loadProjectMemory().then(mem =>
      this.view?.webview.postMessage({ type: 'sessionLoaded', count: 0, memory: mem, projectRoot: this.projectRoot })
    );
  }

  // ── Dictation ──────────────────────────────────────────────────────────────
  // The microphone is unreachable from a webview (see src/dictation-bridge.js),
  // so recognition happens in the user's browser and the words come back here.
  // Recognising in the extension host instead was tried and reverted: the only
  // engine that needs no install and no key is Windows' System.Speech, and it
  // is not good enough to dictate a sentence with.
  //
  // Only ever one session: a second port listening for speech is a second thing
  // to get wrong, and there is only one prompt box to fill.
  async startDictation() {
    if (this.dictation) { this.stopDictation('cancelled'); return; }

    const bridge = new DictationBridge({
      onTranscript: (text, done) =>
        this.view?.webview.postMessage({ type: 'dictationText', text, done }),
      // The page's own state — 'open' the moment it connects, then listening or
      // error as the user works it. The panel showed "opening your browser…"
      // indefinitely before this, whether the page had loaded, been denied the
      // microphone, or never been opened at all.
      onState: (state) =>
        this.view?.webview.postMessage({ type: 'dictationState', state }),
      onEnd: (reason) => {
        this.dictation = null;
        this.view?.webview.postMessage({ type: 'dictationState', state: 'ended', reason });
      },
    });

    let url;
    try {
      url = await bridge.start();
    } catch (err) {
      this.view?.webview.postMessage({ type: 'dictationState', state: 'ended', reason: 'failed' });
      vscode.window.showErrorMessage(`Navy: could not start dictation — ${err?.message || err}`);
      return;
    }

    this.dictation = bridge;
    try {
      // asExternalUri is what makes this work over SSH, Dev Containers and
      // Codespaces: the browser runs on the user's machine, the server does
      // not, and VS Code forwards the port between them.
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(url));
      await vscode.env.openExternal(external);
    } catch (err) {
      this.stopDictation('failed');
      vscode.window.showErrorMessage(`Navy: could not open the dictation page — ${err?.message || err}`);
      return;
    }
    this.view?.webview.postMessage({ type: 'dictationState', state: 'browser' });
  }

  stopDictation(reason = 'stopped') {
    const bridge = this.dictation;
    this.dictation = null;
    if (bridge) bridge.stop(reason);
    else this.view?.webview.postMessage({ type: 'dictationState', state: 'ended', reason });
  }


  sendActiveFile() {
    const editor = vscode.window.activeTextEditor;
    const filePath = editor ? editor.document.fileName : '';
    const language = editor ? editor.document.languageId : '';
    this.view?.webview.postMessage({ type: 'activeFile', path: filePath, language });

    // Auto-derive project root from the workspace folder that contains the active file,
    // or (if no workspace is open) from the active file's directory.
    if (!this.projectRoot && filePath && !filePath.startsWith('Untitled')) {
      // Containment check must be separator-aware (E:\Proj2 is NOT inside E:\Proj)
      // and case-folded on Windows where paths are case-insensitive.
      const fp = fold(filePath);
      const wsFolder = vscode.workspace.workspaceFolders?.find((f) => {
        const base = fold(f.uri.fsPath);
        return fp === base || fp.startsWith(base + path.sep);
      });
      this.projectRoot = wsFolder ? wsFolder.uri.fsPath : path.dirname(filePath);
      this.sendWorkspaceFolders();
    }
  }

  // Approval is TWO independent decisions, and collapsing them into one was a
  // real safety bug. navy.approvalMode covers changes to FILES: already
  // contained to the workspace by resolveWorkspacePath, shown as a diff,
  // recorded as an undo checkpoint, and visible in git afterwards. Turning it
  // off is a statement about how much diff-clicking you want.
  //
  // navy.commandApproval covers EXECUTION — run_command, run_tests,
  // run_project, start_process, and third-party MCP tools. None of that is
  // contained, reviewable or undoable: Navy cannot know what a command does
  // before it runs, and cannot take it back afterwards.
  //
  // Until 0.3.1 both read navy.approvalMode, whose own manifest description
  // said "How Navy Coder should handle file edits" — so a user who flipped the
  // topbar dropdown to stop reviewing diffs also granted unattended arbitrary
  // shell execution and unattended third-party MCP calls, globally, in every
  // workspace, without being told. Anything gating execution must read
  // _commandsAutoApproved; anything gating a file change reads
  // _editsAutoApproved. Never the other one, and never the raw setting.
  _editsAutoApproved() {
    return vscode.workspace.getConfiguration('navy').get('approvalMode', 'ask-always') === 'auto-approve';
  }

  _commandsAutoApproved() {
    return vscode.workspace.getConfiguration('navy').get('commandApproval', 'ask-always') === 'auto-approve';
  }

  sendApprovalMode() {
    const c = vscode.workspace.getConfiguration('navy');
    this.view?.webview.postMessage({
      type: 'approvalMode',
      mode: c.get('approvalMode', 'ask-always'),
      commandMode: c.get('commandApproval', 'ask-always'),
    });
  }

  async sendSettings() {
    const c = vscode.workspace.getConfiguration('navy');
    const provider = c.get('provider', 'ollama');
    // Per-provider key with legacy single-key fallback.
    const apiKey = await this.context.secrets.get('navy.apiKey.' + provider)
                || await this.context.secrets.get('navy.apiKey') || '';
    const maskedKey = apiKey ? apiKey.slice(0, 4) + '••••' + apiKey.slice(-4) : '';
    const searchKey = c.get('searchApiKey', '')
                   || await this.context.secrets.get('navy.searchApiKey') || '';
    const maskedSearchKey = searchKey ? searchKey.slice(0, 4) + '••••' + searchKey.slice(-4) : '';
    this.view?.webview.postMessage({
      type: 'settings',
      settings: {
        provider,
        ollamaMode:   c.get('ollamaMode',        'local'),
        host:         c.get('host',              'http://localhost:11434'),
        apiKey:       maskedKey,
        apiBase:      c.get('apiBase',           ''),
        searchApiKey: maskedSearchKey,
        temperature:  c.get('temperature',       0.2),
        maxIter:      c.get('maxToolIterations', 100),
        editFormat:   c.get('editFormat',        'search-replace'),
        systemPrompt: c.get('systemPrompt',      ''),
        speechVoice:  c.get('speechVoice',       ''),
        speechRate:   c.get('speechRate',        1),
      }
    });
  }

  async sendWorkspaceFolders() {
    const folders = vscode.workspace.workspaceFolders || [];
    const roots = folders.map((f) => f.uri.fsPath).filter(Boolean);

    // Single-file mode: no folder is open at all, just a loose file. The
    // file's own directory is the only sensible root, so derive it regardless
    // of how many tabs exist. This deliberately is NOT gated on
    // `sessions.size === 1` — that guard exists to stop a blank "New Chat" tab
    // being auto-filled with a project the user meant to choose themselves,
    // but there is nothing to choose when no folder is open, and gating it
    // here meant opening a second tab left projectRoot empty and every file
    // tool failing with "No project root — open a folder before using file
    // tools" for the rest of the session.
    if (!this.projectRoot && roots.length === 0) {
      const derived = this._activeFileDir();
      if (derived) this.projectRoot = derived;
    }

    // With folders open there IS something to choose, so defaulting to the
    // first one stays limited to a single, still-untouched tab.
    if (this.sessions.size === 1 && !this.projectRoot && roots.length > 0) {
      this.projectRoot = roots[0];
    }

    // Ensure the current root appears in the list even when it was auto-derived from an open file.
    const displayRoots = (this.projectRoot && !roots.includes(this.projectRoot))
      ? [this.projectRoot, ...roots]
      : roots;

    // Global catalog entries NOT already shown above (this window's own
    // roots) — "other projects Navy remembers", sorted most-recent-first.
    // Picking one goes through openCatalogProject's open-here/add-to-
    // workspace choice instead of a direct switch, since it isn't part of
    // this window's workspace (yet).
    const shown = new Set(displayRoots.map(fold));
    const globalProjects = await this._readGlobalProjects();
    const catalog = globalProjects
      .filter(p => !shown.has(fold(p.path)))
      .map(p => ({ path: p.path, name: p.name || path.basename(p.path) }));

    this.view?.webview.postMessage({ type: 'workspaceFolders', roots: displayRoots, current: this.projectRoot, catalog });
  }

  // The Ollama base URL for the current settings — ollama.com in cloud mode,
  // navy.host otherwise. Every Ollama endpoint (/api/tags, /api/show,
  // /api/generate, /api/embed, /api/chat) resolves through this one helper so
  // enabling cloud can't reach some of them and miss others.
  _ollamaBase() {
    const config = vscode.workspace.getConfiguration('navy');
    return ollamaHost(config.get('ollamaMode', 'local'), config.get('host', 'http://localhost:11434'));
  }

  // The saved Ollama API key. Required for cloud, ignored by a local server.
  async _ollamaKey() {
    return await this.context.secrets.get('navy.apiKey.ollama')
        || await this.context.secrets.get('navy.apiKey') || '';
  }

  // navy.host, except that Ollama resolves through _ollamaBase so cloud mode
  // is honoured. Used by callers that hit a provider endpoint directly rather
  // than through streamAssistant (which does its own resolution).
  _hostForProvider(provider) {
    const host = vscode.workspace.getConfiguration('navy').get('host', 'http://localhost:11434').replace(/\/$/, '');
    return provider === 'ollama' ? this._ollamaBase() : host;
  }

  // Last-resort restore of the project you were last working in, from the
  // global catalog (~/.navy/projects.json, most-recent-first).
  //
  // The catalog was written faithfully but only ever READ to populate the
  // dropdown's "Other projects" group — nothing consulted it when deciding
  // which project to open with. Restoring relied solely on navy.projectRoot,
  // which is stored workspace-scoped whenever a folder is open; so a project
  // added to an unsaved multi-root workspace, or opened in a window that later
  // starts with no folder, had nothing to restore from and Navy came up blank.
  // That is the "it doesn't remember my project" behaviour.
  //
  // Deliberately conservative about WHICH entry it takes, to preserve the rule
  // that Navy must never silently operate on a project that isn't open:
  //   • folders open  → only a catalog entry inside one of them
  //   • no folders    → the most recent entry that still exists, since there is
  //                     no open project for it to contradict
  async _restoreLastProject() {
    let catalog;
    try { catalog = await this._readGlobalProjects(); } catch { return; }
    if (!catalog.length) return;

    const folderPaths = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    const usable = folderPaths.length
      ? catalog.find(p => rootBelongsToWorkspace(p.path, folderPaths))
      : catalog[0];
    if (!usable) return;

    this.projectRoot = usable.path;
    // Written back through the normal path so the settings-based restore
    // (which is faster, and correct for a saved workspace) works next time
    // without needing the catalog at all.
    await this._persistProjectRoot(usable.path);
    this.log?.('restored last project from the global catalog: ' + usable.path);
  }

  // Directory of the file currently open in the editor, or '' when there
  // isn't one worth using. Untitled documents have no directory on disk, so
  // they never qualify. Shared by single-file-mode root derivation and by
  // resolveWorkspacePath, so both agree on what "the file you're looking at"
  // means.
  _activeFileDir() {
    const editor = vscode.window.activeTextEditor;
    const name = editor?.document?.fileName || '';
    if (!name || name.startsWith('Untitled') || editor.document.uri?.scheme === 'untitled') return '';
    try { return path.dirname(name); } catch { return ''; }
  }

  // Persist the picked project root so it survives window reloads. Workspace-scoped
  // when a workspace is open (per-project memory), global otherwise.
  async _persistProjectRoot(root) {
    // workspaceState, not a setting. Saving this as a workspace-scoped setting
    // made VS Code write `navy.projectRoot` into `.vscode/settings.json` inside
    // the user's own repository — a file many teams commit, so simply picking a
    // project in Navy could show up in someone's `git diff`. A remembered UI
    // selection is not something a user edits by hand, so it belongs in
    // workspaceState: scoped to this workspace automatically, invisible to the
    // repo, and removed with the extension.
    //
    // navy.projectRoot remains a real setting, but now read-only from Navy's
    // side: an override you may set deliberately (see adoptConfiguredProjectRoot).
    try { await this.context.workspaceState?.update(WS_LAST_PROJECT_ROOT, root || ''); } catch {}
  }

  // Honours an explicit edit to navy.projectRoot. Because Navy no longer writes
  // that setting, a change to it can only have come from the user, which makes
  // it an unambiguous instruction to switch — the behaviour someone editing a
  // setting called "Active project directory" expects.
  async adoptConfiguredProjectRoot() {
    const configured = String(vscode.workspace.getConfiguration('navy').get('projectRoot', '') || '');
    if (!configured) return;
    if (foldPath(configured) === foldPath(this.projectRoot || '')) return;
    if (!fs.existsSync(configured)) {
      vscode.window.showWarningMessage(`Navy: navy.projectRoot points at "${configured}", which does not exist.`);
      return;
    }
    if (this._refuseIfBusy()) return;
    await this._switchProjectRoot(configured);
  }

  // ── Shared small-JSON-file I/O (global catalog + per-project bg-manifest) ──
  // Both files are read as a whole array, mutated, and written back whole —
  // same shape, so one pair of low-level helpers backs both instead of two
  // independent copies of the same read/parse/fallback and
  // stringify/write/log-on-failure logic.
  async _readJsonFile(filePath, fallback) {
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      return JSON.parse(Buffer.from(data).toString('utf8'));
    } catch { return fallback; }
  }

  async _writeJsonFile(filePath, data, label) {
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(filePath)));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
    } catch (e) { this.log?.((label || filePath) + ' write failed: ' + e.message); }
  }

  // Read → mutate → write, but re-reads once right before writing and
  // retries the whole cycle (recomputing `mutate` against the fresh data) if
  // the file changed underneath it — both the global catalog and the
  // bg-process manifest can ALSO be written by a completely different VS
  // Code window's own extension host process, where an in-memory lock is no
  // help at all (different processes, no shared memory to lock). This isn't
  // a perfect guarantee — a write from another process can still land in the
  // gap between this function's own re-read and its write — but it turns the
  // common case of "another writer finished just before us" into a merge
  // instead of a silent lost update, which no locking at all would give.
  // Callers that CAN also serialize in-process (same window) should still do
  // so on top of this — see _withGlobalProjectsLock / the per-project
  // bgManifestLock — since that fixes the same-process race completely,
  // where this can only narrow it.
  async _rmwJsonFile(filePath, fallback, mutate) {
    const MAX_RETRIES = 3;
    let before = await this._readJsonFile(filePath, fallback);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const next = mutate(before);
      if (attempt < MAX_RETRIES) {
        const recheck = await this._readJsonFile(filePath, fallback);
        if (JSON.stringify(recheck) !== JSON.stringify(before)) { before = recheck; continue; }
      }
      await this._writeJsonFile(filePath, next, filePath);
      return next;
    }
  }

  // The global project catalog lives in src/projects.js and is mixed into this
  // prototype at the bottom of the file: _globalProjectsDir, _globalProjectsPath,
  // _legacyGlobalProjectsPath, _migrateGlobalProjectsOnce, _readGlobalProjects,
  // _writeGlobalProjects, _withGlobalProjectsLock and _recordProjectUsage. They
  // are still methods on this class, so every call site below is unchanged.

  // Shared "is Navy busy" guard for every project-switch entry point
  // (openFolder, openCatalogProject, the setProjectRoot message handler) —
  // shows the warning and reports true so the caller can bail out. One
  // definition so the wording/condition can't drift between call sites, or
  // be updated in some and missed in others.
  _refuseIfBusy() {
    if (!this.isBusy) return false;
    vscode.window.showWarningMessage('Navy is working — stop the current task before switching projects.');
    return true;
  }

  async openFolder() {
    // "Open Here"/no-workspace-yet below still directly replace this.projectRoot
    // (they reload the window into a different project entirely) — switching
    // that mid-turn would make executing tools resolve paths against a
    // different project than the one they started in, so edits would land
    // in the wrong repo. setProjectRoot already refuses this for the same
    // reason.
    if (this._refuseIfBusy()) {
      return;
    }

    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Add Navy project'
    });
    if (!result || result.length === 0) return;
    const picked = result[0].fsPath;
    const folders = vscode.workspace.workspaceFolders || [];
    // Case-fold on Windows: the open dialog can return "E:\Proj" for a folder
    // stored as "e:\Proj", and a case-sensitive compare would then offer to
    // "add" a project that is already open.
    const exists = folders.some((f) => foldPath(f.uri.fsPath) === foldPath(picked));
    const name = path.basename(picked);

    // Catalog it regardless of what happens next — a folder picked here is
    // "known" to Navy from this point on, independent of whether it ends up
    // open in THIS window at all (see the global catalog section above).
    this._recordProjectUsage(picked).catch(() => {});

    // Already part of this workspace — nothing to add. Picking the dialog
    // option is never itself a "switch to it" action (see below) — it's
    // already selectable from the list, so just say so.
    if (exists) {
      vscode.window.showInformationMessage(`"${name}" is already in your project list — select it above.`);
      await this.sendWorkspaceFolders();
      return;
    }

    await this._offerOpenOrAdd(picked);
  }

  // The "what do you want to do with this project" choice — shared by
  // openFolder (a brand-new folder from the file dialog) and
  // openCatalogProject (a previously-known project from the global catalog
  // that isn't part of THIS window's workspace right now). Either way the
  // folder is not currently one of this window's roots, so the same two
  // legitimate meanings of "open it" apply: replace what's here, or add it
  // alongside what's already open.
  async _offerOpenOrAdd(picked) {
    const uri = vscode.Uri.file(picked);
    const name = path.basename(picked);
    const folders = vscode.workspace.workspaceFolders || [];

    if (folders.length === 0) {
      // No workspace open at all — there's no "list" to add to yet; opening
      // the folder IS how a workspace comes into being, exactly like File →
      // Open Folder. Persist the root first: opening a folder reloads the
      // window, and the fresh session derives its root from the newly
      // opened workspace folder.
      this.projectRoot = picked;
      await this._persistProjectRoot(picked);
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
      return; // window reloads — nothing more to do in this session
    }

    // A workspace is already open. Previously this silently turned the window
    // into an untitled multi-root workspace, which is not what most people mean
    // by "open another project" — they expect the new one to replace the current
    // one. Both are legitimate, so ask rather than guessing.
    const choice = await vscode.window.showInformationMessage(
      `Open "${name}"?`,
      {
        modal: true,
        detail: 'Open here replaces the current project in this window (like File → Open Folder).\n\n'
              + 'Add to workspace keeps what\'s already open and adds this one alongside it — pick which chat to work in from the tab strip.',
      },
      'Open Here', 'Add to Workspace'
    );
    if (!choice) return; // dismissed — leave everything as it was

    if (choice === 'Open Here') {
      // Deliberately do NOT persist here. _persistProjectRoot writes to the
      // CURRENT workspace's settings, and we're about to leave that workspace —
      // so saving would stamp the new project's path into the OLD project's
      // .vscode/settings.json. Reopening the old project later would then point
      // Navy at a folder that isn't open, which is exactly the "chat isn't
      // linked to the project I just opened" symptom. The reloaded window
      // derives its root from its own workspace folder instead.
      this.projectRoot = picked;
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
      return; // window reloads
    }

    await this._addFolderToWorkspace(picked);
  }

  // Picking a project from the GLOBAL catalog (see the section above) that
  // isn't part of this window's workspace right now — same "open here or add
  // to the workspace" choice as a brand-new folder pick, just sourced from
  // Navy's own memory instead of a fresh file-dialog browse.
  async openCatalogProject(picked) {
    if (!picked) return;
    if (this._refuseIfBusy()) return;
    if (!fs.existsSync(picked)) {
      vscode.window.showErrorMessage(`Navy: "${path.basename(picked)}" no longer exists at ${picked} — it will be removed from the list.`);
      await this.sendWorkspaceFolders(); // re-send so the (now-stale) entry is dropped from what's displayed
      return;
    }
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.some((f) => foldPath(f.uri.fsPath) === foldPath(picked))) {
      // Already part of this window's workspace (e.g. it was added in
      // another session of this same window) — just switch to it directly,
      // exactly like picking it from the main part of the dropdown.
      await this._switchProjectRoot(picked);
      return;
    }
    await this._offerOpenOrAdd(picked);
  }

  // Adds `picked` to the REAL VS Code workspace (Explorer, file watching, and
  // language servers all need this — not just Navy's own state), WITHOUT
  // switching Navy to it. Adding a project to the list and making it the
  // active one are deliberately two separate steps: the dialog only ever
  // registers the folder; the user then explicitly picks it from the
  // dropdown (case 'setProjectRoot' → _switchProjectRoot), which is the one
  // and only action that actually changes what Navy — and the rest of the
  // editor — is pointed at.
  async _addFolderToWorkspace(picked) {
    const uri = vscode.Uri.file(picked);
    const name = path.basename(picked);
    const folders = vscode.workspace.workspaceFolders || [];
    // updateWorkspaceFolders takes { uri } objects, NOT bare Uris — passing a
    // bare Uri leaves `.uri` undefined, so VS Code rejects the call and returns
    // false. That was the original bug: the folder was never added, but Navy set
    // projectRoot and reported success anyway, so the UI claimed a project that
    // the editor had never actually opened.
    const added = vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri });
    if (!added) {
      vscode.window.showErrorMessage(`Navy could not add "${name}" to this workspace. Try File → Add Folder to Workspace.`);
      return false;
    }
    // onDidChangeWorkspaceFolders re-sends the folder list once VS Code has
    // applied the change, so the dropdown picks the new folder up.
    await this.sendWorkspaceFolders();
    return true;
  }

  // Reads `root`'s persisted chats (.navy/chats/*.json) into `this.sessions`
  // the first time this window visits that root — a no-op on every later
  // call, so re-selecting a project you've already opened this session never
  // re-hits disk or clobbers whatever's accumulated in memory since. Falls
  // back to the legacy single-file .navy/session.json (+ checkpoints.json)
  // format for projects that predate per-chat files; the next save for that
  // chat writes it out in the new format, so migration is automatic and
  // requires no separate step.
  async _ensureProjectChatsLoaded(root) {
    if (!root || this._loadedChatRoots.has(root)) return;
    this._loadedChatRoots.add(root);
    const chatsDir = path.join(root, '.navy', 'chats');
    let entries = [];
    try { entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(chatsDir)); } catch { entries = []; }
    const chatFiles = entries.filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'));
    if (chatFiles.length) {
      // Independent reads — no ordering dependency between them, and each
      // writes a distinct `id` into this.sessions, so firing them all at
      // once instead of one at a time doesn't change the outcome, just how
      // long a project with many saved chats takes to become usable.
      await Promise.all(chatFiles.map(async ([name]) => {
        const id = name.slice(0, -'.json'.length);
        if (this.sessions.has(id)) return;
        try {
          const data = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(chatsDir, name)));
          const parsed = JSON.parse(Buffer.from(data).toString('utf8'));
          const s = new Session(id, root);
          s.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
          s.sessionDigest = typeof parsed.digest === 'string' ? parsed.digest : '';
          s.checkpoints = Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [];
          s._updated = typeof parsed.updated === 'string' ? parsed.updated : '';
          this.sessions.set(id, s);
        } catch {}
      }));
    } else {
      try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, '.navy', 'session.json')));
        const parsed = JSON.parse(Buffer.from(data).toString('utf8'));
        const id = this.generateId();
        const s = new Session(id, root);
        s.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        s.sessionDigest = typeof parsed.digest === 'string' ? parsed.digest : '';
        try {
          const cpData = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, '.navy', 'checkpoints.json')));
          const cpParsed = JSON.parse(Buffer.from(cpData).toString('utf8'));
          if (Array.isArray(cpParsed.checkpoints)) s.checkpoints = cpParsed.checkpoints;
        } catch {}
        this.sessions.set(id, s);
      } catch { /* brand-new project — nothing to load */ }
    }
    // Loading a project's chats is the dominant way `this.sessions` grows in
    // bulk (a whole project's history at once) — the natural point to check
    // whether it's grown past the cap, mirroring _proj's eviction check on
    // every new _projectCaches entry.
    this._evictStaleSessions(root);
  }

  // Keeps `this.sessions` bounded, mirroring _evictStaleProjectCaches for
  // _projectCaches — without this, every chat ever created or loaded from
  // disk in this window stays in memory (full messages array + undo
  // checkpoints with pre-edit file text) for the rest of the window's life.
  // Deliberately conservative about which sessions are eligible: unlike the
  // project cache (freely-recomputable data), a session holds real chat
  // content, and losing any of it would be far worse than the memory growth
  // this fixes. Only evicts a session that is: not the active tab, not busy
  // (a turn/background task could be appending to it right now — messages
  // only ever change while isBusy is true), already fully saved to disk (a
  // real _updated timestamp, together with !isBusy, guarantees nothing in
  // memory is unsaved), and not its project's LAST remaining chat
  // (closeSessionTab already refuses to let the UI close that one; eviction
  // honors the same invariant, or reactivating that project would wrongly
  // look like it has no chats yet). Also un-marks the session's project root
  // in _loadedChatRoots, so a later visit re-reads it from disk — cheap
  // (skips every sibling chat already in memory) and is what makes the
  // evicted chat resumable again instead of gone for the rest of the window.
  //
  // `justLoadedRoot` (the root _ensureProjectChatsLoaded has this moment
  // hydrated) is held back from eviction entirely. Evicting one of its chats
  // would un-mark it in _loadedChatRoots — the very set that call just added
  // it to — so the next visit re-reads the same directory, re-adds the same
  // chats, exceeds the cap again and evicts again: a loop that re-hits disk
  // on every project switch forever while freeing nothing durably. The cap is
  // a ceiling on growth, not a hard limit, so deferring to the next load of a
  // DIFFERENT project costs nothing.
  _evictStaleSessions(justLoadedRoot) {
    if (this.sessions.size <= SESSION_CACHE_CAP) return;
    const countByRoot = new Map();
    for (const s of this.sessions.values()) {
      if (s.projectRoot) countByRoot.set(s.projectRoot, (countByRoot.get(s.projectRoot) || 0) + 1);
    }
    const evictable = [...this.sessions.entries()]
      .filter(([id, s]) => id !== this.activeSessionId && !s.isBusy && s._updated
        && !(justLoadedRoot && s.projectRoot === justLoadedRoot)
        && (!s.projectRoot || (countByRoot.get(s.projectRoot) || 0) > 1))
      .sort((a, b) => a[1]._updated.localeCompare(b[1]._updated)); // oldest-saved first
    let over = this.sessions.size - SESSION_CACHE_CAP;
    for (const [id, s] of evictable) {
      if (over <= 0) break;
      this.sessions.delete(id);
      if (s.projectRoot) {
        this._loadedChatRoots.delete(s.projectRoot);
        if (this._lastActiveByRoot.get(s.projectRoot) === id) this._lastActiveByRoot.delete(s.projectRoot);
        countByRoot.set(s.projectRoot, (countByRoot.get(s.projectRoot) || 1) - 1);
      }
      over--;
    }
  }

  // Makes `root` the active project: hydrates its chats (once — see above),
  // then activates whichever chat was last active for it, or the most
  // recently saved one, or creates a fresh chat if it has none yet. Shared
  // by the startup handshake and _switchProjectRoot so both hydrate/activate
  // identically.
  async _activateProjectRoot(root) {
    if (!root) return;
    // Fire-and-forget: bookkeeping for the global catalog must never block
    // or fail activation itself (covers explicit switches, the startup
    // restore, and landing back here after openFolder's window reload).
    this._recordProjectUsage(root).catch(() => {});
    await this._ensureProjectChatsLoaded(root);
    const forRoot = [...this.sessions.values()].filter(s => s.projectRoot === root);
    if (!forRoot.length) {
      // No chats exist yet for this project — reuse the active tab if it's
      // still a genuinely blank, untouched one, otherwise start a fresh
      // chat under it rather than repurposing an unrelated one.
      if (!this.projectRoot && this.messages.length === 0) {
        this.projectRoot = root;
      } else {
        const id = this.generateId();
        this.sessions.set(id, new Session(id, root));
        this.activeSessionId = id;
      }
    } else {
      const remembered = this._lastActiveByRoot.get(root);
      const target = forRoot.find(s => s.id === remembered)
        || forRoot.slice().sort((a, b) => (b._updated || '').localeCompare(a._updated || ''))[0];
      this.activeSessionId = target.id;
      // The constructor's bootstrap placeholder tab, specifically, can be
      // left dangling once a real persisted chat for its root is found —
      // clean up ONLY that exact tab (matched by id, not just "any blank
      // tab happens to be lying around"), so a deliberately-created empty
      // "+" tab the user is keeping open is never swept up by this.
      const bootstrap = this.sessions.get(this._bootstrapSessionId);
      if (bootstrap && bootstrap.id !== this.activeSessionId && bootstrap.projectRoot === root
        && bootstrap.messages.length === 0 && bootstrap.checkpoints.length === 0) {
        this.sessions.delete(bootstrap.id);
      }
    }
    this._lastActiveByRoot.set(root, this.activeSessionId);
    // Fire-and-forget: a leftover-process prompt must never block/delay
    // activating the project itself, and this runs unattended off the
    // normal turn/tool error paths, so a failure here needs its own catch.
    this._checkOrphanedBgProcesses(root).catch(() => {});
  }

  // Points Navy at `root` — the ONE action that actually changes the active
  // project (case 'setProjectRoot', the dropdown). Activates that project's
  // own chats (see _activateProjectRoot) — tabs are children of a project,
  // so switching projects switches which set of tabs is visible, same as
  // reopening a document. Also reveals the folder in VS Code's own Explorer
  // — picking a project here is a deliberate "make THIS the project I'm
  // working on" action, so the rest of the editor (not just Navy's chat)
  // should reflect it. Adding a folder to the list (openFolder /
  // _addFolderToWorkspace) is deliberately a SEPARATE step that never calls
  // this — see openFolder's comment for why.
  async _switchProjectRoot(root) {
    if (root && root !== this.projectRoot) {
      await this._activateProjectRoot(root);
    }
    await this._persistProjectRoot(root);
    if (root) { try { await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(root)); } catch {} }
    await this.sendWorkspaceFolders();
    await this.loadProjectSession();
    this._sendSessionList();
    // A different project has a different .navy/commands/ and .navy/skills/ —
    // both caches are keyed on the root, so this is a re-read rather than a
    // stale-cache flush.
    await this.sendSlashCommands();
  }

  // ── Session tabs ──────────────────────────────────────────────────────────
  // A tab is a Session identified by a generated id (see the Session class).
  // Tabs are children of a project — the tab strip only ever shows the
  // chats belonging to the CURRENTLY selected project (see
  // _sessionSummaries), and switching project (the dropdown) switches which
  // set of tabs is visible, the same way reopening a document resumes it.

  // Creates a brand-new chat tab UNDER THE CURRENT PROJECT and switches to
  // it — never prompts for a project folder; a new tab is always a sibling
  // of whatever tab it was opened from. If no project is selected yet, it's
  // a genuinely blank/unbound "New Chat" instead, exactly like the very
  // first tab before any project has ever been picked.
  async openNewSessionTab() {
    const root = this.projectRoot;
    const id = this.generateId();
    this.sessions.set(id, new Session(id, root));
    this.activeSessionId = id;
    if (root) this._lastActiveByRoot.set(root, id);
    // 'sessionList' first: it's exempt from the webview's per-message
    // sessionId gate and is what teaches the frontend the active session
    // just changed. Sending 'restore'/'sessionLoaded' (both gated) before it
    // would have them silently dropped, since the frontend's local
    // activeSessionId is still the OLD tab's until it sees an exempt
    // message — see resolveWebviewView's postMessage wrapper.
    this._sendSessionList();
    this.restoreMessages();
    const memory = root ? await this.loadProjectMemory() : '';
    // A brand-new chat has no usage yet — 0/null, same shape loadProjectSession
    // sends, so the frontend never has to special-case "just-created" vs.
    // "restored with nothing spent".
    this.view?.webview.postMessage({
      type: 'sessionLoaded', count: 0, memory, projectRoot: root,
      sessionPrompt: 0, sessionCompletion: 0, sessionTotal: 0, estimatedCost: null, costKnown: true,
    });
    // Same reason loadProjectSession does it: 'restore' wipes the transcript,
    // and with it the dev server's card and the dock row pointing at it. A new
    // tab is not a new machine — anything still running has to be re-announced
    // or its Stop button exists nowhere at all.
    this._sendLiveCardState();
  }

  // Switches the ACTIVE tab to the session `sessionId` — used by tab clicks.
  // Unlike the dropdown's webview-message handler (case 'setProjectRoot',
  // which itself refuses while isBusy before ever calling _switchProjectRoot),
  // tab clicks never refuse — with per-session state, and sessionContext
  // binding a running turn to the session it started in, letting a turn keep
  // running in the background while the user switches away is the entire
  // point of tabs. Never touches the real VS Code workspace/Explorer or
  // navy.projectRoot — switching between a project's own chats isn't a
  // change of project at all.
  async switchSessionTab(sessionId) {
    if (!sessionId || !this.sessions.has(sessionId) || sessionId === this.activeSessionId) return;
    this.activeSessionId = sessionId;
    if (this.projectRoot) this._lastActiveByRoot.set(this.projectRoot, sessionId);
    // 'sessionList' first — see openNewSessionTab's comment. A direct tab
    // click already updated the frontend's activeSessionId optimistically
    // before this ever runs, so this is a no-op for that caller — but
    // closeSessionTab also calls this to fall back to a sibling the
    // frontend had NO advance notice of, and without 'sessionList' arriving
    // first, that sibling's 'restore'/'sessionLoaded' would be silently
    // dropped by the gate, leaving the chat showing blank/welcome instead
    // of that sibling's real history.
    this._sendSessionList();
    await this.loadProjectSession();
  }

  // Closes a tab. A running turn is aborted first (same as pressing Stop)
  // rather than left orphaned, writing to a session nobody can see anymore.
  // Refuses to close a project's very last remaining chat — there must
  // always be at least one per project that has any open at all (other
  // projects' chat counts are irrelevant here, tabs only compete with their
  // own siblings).
  async closeSessionTab(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const siblings = [...this.sessions.values()].filter(s => s.projectRoot === session.projectRoot);
    if (siblings.length <= 1) return;
    session.abortController?.abort();
    for (const [, approval] of session.pendingApprovals) approval.resolve(false);
    for (const [, approval] of session.pendingCommandApprovals) approval.resolve(false);
    this._disposeSession(session);
    this.sessions.delete(sessionId);
    // Closing is permanent, so the chat's own file goes with it. Dropping the
    // session from memory alone left .navy/chats/<id>.json on disk, and
    // _ensureProjectChatsLoaded resurrected the tab on the next window reload
    // — a closed tab that keeps coming back is indistinguishable from a bug.
    // Deliberately AFTER the in-memory delete: a failed unlink (file already
    // gone, read-only checkout) must not keep the tab open.
    await this._deleteChatFile(session);
    if (this.activeSessionId === sessionId) {
      const sibling = siblings.find(s => s.id !== sessionId);
      await this.switchSessionTab(sibling.id);
    } else {
      this._sendSessionList();
    }
  }

  // Removes a chat's persisted file. Also cancels its pending debounced save,
  // which would otherwise fire a few hundred ms later and write the file
  // straight back — the one ordering mistake that would silently undo this.
  async _deleteChatFile(session) {
    clearTimeout(session._cpSaveTimer);
    session._cpSaveTimer = undefined;
    if (!session.projectRoot || !session.id) return;
    const file = path.join(session.projectRoot, '.navy', 'chats', session.id + '.json');
    try { await vscode.workspace.fs.delete(vscode.Uri.file(file)); }
    catch { /* never written (unsaved/blank chat), or already gone — nothing to do */ }
  }

  // Summary for the tab strip: id, display name, and whether a turn is
  // currently running in it (drives the per-tab busy spinner). Only the
  // CURRENTLY ACTIVE project's own chats are included — tabs are children
  // of a project, not a flat list spanning every project ever opened. The
  // name is drawn from the chat's first user message (like a browser tab
  // titling itself from the page), not the project name — the project is
  // already shown once, above, in the dropdown.
  // The tab strip always describes what is ON SCREEN, so the root is read
  // from the VISIBLE session directly — deliberately NOT `this.projectRoot`,
  // which goes through the active-session proxy and therefore resolves to the
  // *turn's* project whenever this runs inside sessionContext.run. A
  // background tab's turn ending calls _sendSessionList from its own context
  // (see _askNavyTurn's finally block), and 'sessionList' is exempt from the
  // webview's per-message session gate, so using the proxy here would replace
  // the visible project's tab strip with a different project's tabs.
  _sessionSummaries() {
    const root = this.sessions.get(this.activeSessionId)?.projectRoot ?? '';
    return [...this.sessions.entries()]
      .filter(([, s]) => s.projectRoot === root)
      .map(([id, s]) => {
        const first = s.messages.find(m => m.role === 'user' && typeof m.text === 'string' && m.text.trim());
        const text = first?.text.trim() || '';
        const name = text ? (text.length > 40 ? text.slice(0, 40) + '…' : text) : 'New Chat';
        return { id, name, root: s.projectRoot, busy: s.isBusy, active: id === this.activeSessionId };
      });
  }

  _sendSessionList() {
    this.view?.webview.postMessage({ type: 'sessionList', sessions: this._sessionSummaries() });
  }

  async setModel(model) {
    if (!model) return;
    const config = vscode.workspace.getConfiguration('navy');
    await config.update('model', model, true);
    await this.loadModels();
  }

  // Curated fallbacks — shown ONLY when the live /models fetch fails (no API key,
  // offline, endpoint down) so the dropdown is never empty. The live list is
  // always preferred, so a provider adding/removing a model is reflected
  // automatically without a Navy update.
  static MODEL_FALLBACKS = {
    openai:     ['gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini', 'o1', 'gpt-4-turbo'],
    anthropic:  ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022'],
    deepseek:   ['deepseek-chat', 'deepseek-reasoner'],
    gemini:     ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    xai:        ['grok-3', 'grok-3-mini', 'grok-2'],
    // z.ai had NO entry at all, so a failed fetch left its dropdown empty with
    // nothing to pick — the "No models" report. Taken from a live
    // /api/paas/v4/models.
    zai:        ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.7', 'glm-4.6', 'glm-4.5-air'],
    groq:       ['moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    openrouter: ['openai/gpt-4o', 'anthropic/claude-opus-4', 'google/gemini-2.0-flash', 'deepseek/deepseek-r1'],
    // Shown only when the live /models call fails (no key yet, or offline), so
    // the dropdown still offers something recognisable to pick.
    // Per Kimi's own platform docs; the previous list was the K2-preview era
    // (kimi-k2-turbo-preview, kimi-k2-0711-preview, moonshot-v1-128k) and those
    // ids are no longer what the platform leads with.
    moonshot:   ['kimi-k3', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-latest'],
    qwen:       ['qwen3-coder-plus', 'qwen-max', 'qwen-plus', 'qwen-turbo'],
    // Taken from a live /v1/models on api.minimax.io — the previous list had
    // MiniMax-M1 and MiniMax-Text-01, which the API no longer serves.
    minimax:    ['MiniMax-M2.7', 'MiniMax-M3', 'MiniMax-M2.5', 'MiniMax-M2'],
    mimo:       ['mimo-v2-pro', 'mimo-v2-flash', 'mimo-v2-omni'],
  };

  // ── Provider connection self-test ──────────────────────────────────────────
  // Providers fail in ways that all look alike from the chat: a wrong base URL,
  // a key from the wrong region, an empty balance and an actually-bad key all
  // surface as "it didn't work". Three shipped broken defaults were each found
  // only by someone trying that provider by hand. This turns that into one
  // command that says which of those it is.
  //
  // Pure: takes the outcome of a request and returns the verdict, so every
  // branch is testable without a network. `body` is the raw response text,
  // which is where providers put the detail their status code omits.
  static diagnoseProviderResponse({ provider, url, hasKey, status, body, models, networkError }) {
    const alt = NavyCoderViewProvider.REGIONAL_ALTERNATES[provider];
    const regionHint = alt
      ? ` ${providerDisplayName(provider)} also runs a ${alt.label} endpoint at ${alt.url} — a key issued for one region is rejected by the other exactly like an invalid key. Set navy.apiBase to switch.`
      : '';

    if (networkError) {
      const dns = /ENOTFOUND|EAI_AGAIN/i.test(networkError);
      const refused = /ECONNREFUSED/i.test(networkError);
      return {
        ok: false,
        kind: refused ? 'unreachable' : dns ? 'dns' : 'network',
        title: refused ? 'Nothing is listening at that address' : dns ? 'That host does not resolve' : 'Could not reach the provider',
        detail: refused
          ? `${url} refused the connection.${provider === 'ollama' ? ' If this is local Ollama, is `ollama serve` running?' : ''}`
          : `${url} — ${networkError}`,
      };
    }

    if (status === 200 && Array.isArray(models) && models.length) {
      return {
        ok: true, kind: 'ok',
        title: `${providerDisplayName(provider)} is working`,
        detail: `${url} returned ${models.length} model${models.length === 1 ? '' : 's'}: ${models.slice(0, 4).join(', ')}${models.length > 4 ? ', …' : ''}`,
      };
    }
    // A 200 that isn't a model list means the URL is serving something else —
    // a docs page, a proxy's index, an SPA shell. Reachable is not correct.
    if (status === 200) {
      return {
        ok: false, kind: 'not_an_api',
        title: 'That URL answered, but not with a model list',
        detail: `${url} returned 200 and no models. This is usually a base URL pointing at a website rather than the API root.`,
      };
    }
    if (status === 401 || status === 403) {
      return {
        ok: false, kind: hasKey ? 'auth' : 'no_key',
        title: hasKey ? 'The key was rejected' : 'This provider needs an API key',
        detail: hasKey
          ? `${url} rejected the key.${regionHint} Otherwise the key may be revoked, or belong to a different provider.`
          : `${url} requires authentication and no key is saved. Open Settings (gear icon) and add one.`,
      };
    }
    if (status === 404) {
      return {
        ok: false, kind: 'wrong_base',
        title: 'That URL does not serve a model list',
        detail: `${url} returned 404. The base URL is almost certainly wrong — this is not the API root for ${providerDisplayName(provider)}. Clear navy.apiBase to return to the built-in default.`,
      };
    }
    if (status === 402 || /insufficient[_ ](balance|credit|funds)|credit balance is too low/i.test(body || '')) {
      return {
        ok: false, kind: 'balance',
        title: 'Reachable and authenticated, but the account has no balance',
        detail: `${url} accepted the key and refused on billing. Top the account up; nothing in Navy needs changing.`,
      };
    }
    if (status === 429) {
      return {
        ok: false, kind: 'rate_limit',
        title: 'Reachable and authenticated, but rate limited right now',
        detail: `${url} returned 429. The connection is fine — this is a per-minute or quota limit on the account.`,
      };
    }
    return {
      ok: false, kind: 'http',
      title: `Unexpected response (HTTP ${status})`,
      detail: `${url} — ${String(body || '').slice(0, 300) || 'no response body'}`,
    };
  }

  // Providers that run separate mainland-China and international endpoints. A
  // key from the wrong one fails as a plain 401, so the self-test names the
  // alternative instead of leaving the user to discover it.
  static REGIONAL_ALTERNATES = {
    moonshot: { url: 'https://api.moonshot.cn/v1', label: 'mainland-China' },
    qwen:     { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', label: 'mainland-China' },
    minimax:  { url: 'https://api.minimax.chat/v1', label: 'mainland-China' },
    zai:      { url: 'https://open.bigmodel.cn/api/paas/v4', label: 'mainland-China' },
  };

  // Runs the self-test against the CURRENTLY configured provider and reports.
  async testProviderConnection() {
    const config = vscode.workspace.getConfiguration('navy');
    const provider = config.get('provider', 'ollama');
    const apiKey = await this.context.secrets.get('navy.apiKey.' + provider);
    const label = providerDisplayName(provider);

    // Ollama speaks its own API; everyone else goes through the shared builder.
    const req = provider === 'ollama'
      ? { url: this._ollamaBase() + '/api/tags', headers: ollamaAuthHeaders(this._ollamaKey ? await this._ollamaKey() : apiKey) }
      : this._modelListRequest(provider, config.get('apiBase', ''), config.get('host', 'http://localhost:11434'), apiKey);

    let verdict;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(req.url, { headers: req.headers, signal: ctrl.signal });
      clearTimeout(timer);
      const body = await res.text();
      let models = null;
      try {
        const data = JSON.parse(body);
        const raw = data.data || data.models || (Array.isArray(data) ? data : []);
        models = raw.map(m => (typeof m === 'string' ? m : (m && (m.id || m.name || m.model)))).filter(Boolean);
      } catch { /* not JSON — diagnoseProviderResponse treats that as "not an API" */ }
      verdict = NavyCoderViewProvider.diagnoseProviderResponse({
        provider, url: req.url, hasKey: Boolean(apiKey), status: res.status, body, models,
      });
    } catch (err) {
      verdict = NavyCoderViewProvider.diagnoseProviderResponse({
        provider, url: req.url, hasKey: Boolean(apiKey), networkError: err?.message || String(err),
      });
    }

    this.log?.(`provider self-test — ${label}: ${verdict.title} :: ${verdict.detail}`);
    const show = verdict.ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    show(`Navy — ${verdict.title}`, { modal: false, detail: verdict.detail }, 'Open Settings')
      .then?.((pick) => { if (pick === 'Open Settings') vscode.commands.executeCommand('workbench.action.openSettings', 'navy.'); });
    return verdict;
  }

  // Where a provider's model list lives, and how to authenticate to it.
  // Anthropic needs its own auth header; everyone else (openai, deepseek,
  // gemini, xai, zai, groq, openrouter, moonshot, qwen, minimax, mimo, lmstudio,
  // custom) is OpenAI-compatible and shares the Bearer + /models shape.
  //
  // Split out so the connection self-test builds its request through the exact
  // same code as a real model fetch. A diagnostic that constructs its own URL
  // can report success against a URL the product never uses — which is how
  // three providers shipped with base URLs that had never worked.
  _modelListRequest(provider, apiBase, host, apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (provider === 'anthropic') {
      const url = (apiBase || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/models?limit=100';
      if (apiKey) { headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01'; }
      return { url, headers };
    }
    const base = openAiCompatBase(provider, apiBase, host) || host;
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    return { url: base.replace(/\/$/, '') + '/models', headers };
  }

  // GET a provider's /models list. Returns an array of model ids, or null on any
  // failure (caller falls back). Handles OpenAI ({data:[{id}]}) and bare-array
  // shapes, and follows Anthropic-style has_more/last_id pagination (≤3 pages).
  // `contextsOut`, when given, is a Map filled with modelId → context window for
  // any provider that reports one in its own model list. OpenRouter does
  // (`context_length`), as do vLLM (`max_model_len`) and several other
  // OpenAI-compatible servers — reading it here costs nothing extra, since the
  // list is already being fetched, and a live answer from the provider is
  // always better than the MODEL_CONTEXT snapshot. Optional so the existing
  // two-argument callers (and tests) are unaffected.
  async _fetchModelList(url, headers, contextsOut) {
    try {
      const all = [];
      let pageUrl = url;
      for (let page = 0; page < 3 && pageUrl; page++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(pageUrl, { headers, signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return all.length ? all : null;
        const data = await res.json();
        const raw = data.data || data.models || (Array.isArray(data) ? data : []);
        if (contextsOut) {
          for (const m of raw) {
            if (!m || typeof m === 'string') continue;
            const id = m.id || m.name;
            const ctx = Number(m.context_length ?? m.max_context_length ?? m.max_model_len ?? m.context_window);
            if (id && Number.isFinite(ctx) && ctx > 0) contextsOut.set(id, ctx);
          }
        }
        all.push(...raw.map(m => (typeof m === 'string' ? m : (m && (m.id || m.name)))).filter(Boolean));
        pageUrl = (data.has_more && data.last_id)
          ? url + (url.includes('?') ? '&' : '?') + 'after_id=' + encodeURIComponent(data.last_id)
          : null;
      }
      return all.length ? all : null;
    } catch { return null; }
  }

  // Pure: provider-specific cleanup of a live /models list.
  //  • gemini returns ids as "models/gemini-…" — strip the prefix (their chat
  //    endpoint accepts the bare id, and the prefixed form is ugly in the UI).
  //  • openai lists EVERY model (whisper, tts, dall-e, embeddings…) — keep only
  //    chat-capable families, but never filter down to empty (future-proofing).
  _sanitizeModelList(provider, list) {
    if (!list) return list;
    let out = list;
    if (provider === 'gemini') out = out.map(id => id.replace(/^models\//, ''));
    if (provider === 'openai') {
      const chat = out.filter(id =>
        /^(gpt-|o[0-9]|chatgpt)/.test(id) &&
        !/(embedding|whisper|tts|audio|realtime|dall-e|image|moderation|transcribe|davinci|babbage|search)/.test(id));
      if (chat.length) out = chat;
    }
    return out;
  }

  // Pure: decide the final dropdown list. Prefer the live list; fall back to the
  // curated list; always keep the user's active model selectable even if the
  // provider dropped it from the live list. Returns { models, error }.
  _mergeModelList(fetched, fallback, activeModel) {
    const live = fetched && fetched.length;
    let models = (live ? fetched : (fallback || [])).slice();
    const error = (!live && !(fallback && fallback.length))
      ? "Couldn't fetch models — check your API key or base URL." : undefined;
    models.sort((a, b) => a.localeCompare(b));
    if (activeModel && models.length && !models.includes(activeModel)) models = [activeModel, ...models];
    return { models, error };
  }

  async loadModels(force = false) {
    const config = vscode.workspace.getConfiguration('navy');
    const host = config.get('host', 'http://localhost:11434').replace(/\/$/, '');
    const provider = config.get('provider', 'ollama');
    const apiBase = config.get('apiBase', '');
    const apiKey = await this.context.secrets.get('navy.apiKey.' + provider)
                || await this.context.secrets.get('navy.apiKey') || '';
    const currentModel = config.get('model', '');

    // Cleared up front so a provider switch can never leave the previous
    // provider's window on screen: whichever branch below resolves one will set
    // it again, and if none does the picker stays hidden rather than offering
    // sizes for a model that isn't loaded. Telling the webview matters as much
    // as clearing the field — clearing only the field left the control
    // displaying the old model's sizes indefinitely, since nothing ever sent a
    // follow-up message to blank it.
    this._applyContextWindow(null, false);

    // Ollama — native tags endpoint (+ context length). Cloud mode points the
    // same endpoints at ollama.com with a bearer token; see _ollamaBase.
    if (provider === 'ollama') {
      const base = this._ollamaBase();
      try {
        const response = await fetch(base + '/api/tags', { headers: ollamaAuthHeaders(apiKey) });
        if (!response.ok) throw new Error('Ollama returned ' + response.status + (response.status === 401 ? ' (Unauthorized — Ollama Cloud needs an API key)' : ''));
        const data = await response.json();
        const models = (data.models || []).map((m) => m.name || m.model).filter(Boolean).sort();
        if (models.length > 0 && !models.includes(currentModel)) await config.update('model', models[0], true);
        const activeModel = config.get('model', models[0] || currentModel);
        this.view?.webview.postMessage({ type: 'models', models, currentModel: activeModel });
        this.fetchModelContext(base, activeModel, apiKey);
      } catch (error) {
        this.view?.webview.postMessage({ type: 'models', models: [], currentModel, error: error.message });
      }
      return;
    }

    // Everyone else exposes a /models list. Anthropic needs its own auth header;
    // the rest (openai, deepseek, gemini, xai, zai, groq, openrouter, lmstudio,
    // custom) are OpenAI-compatible and share the same Bearer + /models shape.
    const { url, headers } = this._modelListRequest(provider, apiBase, host, apiKey);

    // Cache successful fetches for 5 min so opening settings / switching the model
    // dropdown doesn't hit the network every time. Cache key includes the URL and
    // whether a key is present, so a provider/base/key change re-fetches.
    const cacheKey = provider + '|' + url + '|' + (apiKey ? 'k' : '');
    let fetched;
    // Windows the provider itself reported, keyed by its own model ids — cached
    // alongside the list so a cache hit doesn't lose them and silently drop the
    // badge back to the MODEL_CONTEXT snapshot.
    let liveContexts = new Map();
    if (!force && this._modelListCache?.key === cacheKey && Date.now() - this._modelListCache.time < 300_000) {
      fetched = this._modelListCache.models;
      liveContexts = this._modelListCache.contexts || liveContexts;
    } else {
      const contexts = new Map();
      fetched = this._sanitizeModelList(provider, await this._fetchModelList(url, headers, contexts));
      liveContexts = contexts;
      if (fetched && fetched.length) this._modelListCache = { key: cacheKey, time: Date.now(), models: fetched, contexts };
    }

    let activeModel = config.get('model', currentModel);
    // If we have an authoritative LIVE list and the configured model isn't in it,
    // it's stale for this provider (typically right after switching providers, when
    // navy.model still holds the old provider's model). Default to the first real
    // model and persist it, so the next chat doesn't 400 on an invalid model.
    // Only when live — a failed fetch (fallback) must not clobber the user's choice.
    if (fetched && fetched.length && !fetched.includes(activeModel)) {
      activeModel = fetched[0];
      await config.update('model', activeModel, true);
    }
    const { models, error } = this._mergeModelList(fetched, NavyCoderViewProvider.MODEL_FALLBACKS[provider], activeModel);
    this.view?.webview.postMessage({ type: 'models', models, currentModel: activeModel, ...(error ? { error } : {}) });

    // _sanitizeModelList can rewrite an id for display (Gemini's "models/" prefix
    // is stripped), so look the live value up under both the displayed name and
    // the provider's own raw id before falling back to the snapshot table.
    const rawId = [...liveContexts.keys()].find(k => k === activeModel || k.endsWith('/' + activeModel) || k.split('/').pop() === activeModel);
    const reported = liveContexts.get(activeModel) ?? (rawId ? liveContexts.get(rawId) : undefined);
    const ctx = resolveModelContext(activeModel, reported);
    if (ctx) this._applyContextWindow(ctx, reported !== undefined);
  }

  async fetchModelContext(host, model, apiKey) {
    try {
      const res = await fetch(host + '/api/show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ollamaAuthHeaders(apiKey) },
        body: JSON.stringify({ name: model })
      });
      if (!res.ok) return;
      const data = await res.json();
      const modelInfo = (data && typeof data.model_info === 'object' && data.model_info) || {};

      // Ollama reports the window under an ARCHITECTURE-prefixed key —
      // `llama.context_length`, `qwen2.context_length`, `gptoss.context_length`,
      // `deepseek4.context_length`, … — never a fixed `llm.` prefix. Looking
      // only for `llm.context_length` (and for `parameters.context_length`,
      // where `parameters` is actually a newline-delimited STRING, not an
      // object) meant this never once found a value: the context badge stayed
      // permanently blank, the context-fill bar never moved, and — because
      // this same field is what sets `num_ctx` on every Ollama request — Navy
      // never asked for a context window at all, silently leaving long
      // conversations to be truncated at Ollama's own small default.
      const archKey = Object.keys(modelInfo).find(k => k.endsWith('.context_length'));
      const archMax = Number(modelInfo[archKey] ?? modelInfo['llm.context_length'] ?? data.context_length ?? 0);
      // A Modelfile may pin num_ctx. Take whichever is LARGER: Navy sets num_ctx
      // explicitly on every request, so a Modelfile default doesn't constrain
      // what can be asked for — but a Modelfile that pins something ABOVE what
      // the architecture reports is still a real, usable window.
      const pinned = Number(/^\s*num_ctx\s+(\d+)/mi.exec(String(data.parameters || ''))?.[1] || 0);
      const detected = Math.max(
        Number.isFinite(archMax) ? archMax : 0,
        Number.isFinite(pinned) ? pinned : 0);
      if (detected <= 0) return; // unknown — leave the badge hidden rather than guess

      this._applyContextWindow(detected, true);
    } catch (_) {}
  }

  // Single place where "what window did the provider report" (`max`) becomes
  // "what window is Navy actually using" (`modelContextLength`) — every source
  // of a window routes through here so the clamp, the persisted user choice,
  // and the message to the webview can never be applied by one caller and
  // forgotten by another.
  //
  // navy.contextWindow of 0 means Max: the effective window then tracks the
  // model, so switching from an 8k model to a 1M one just works instead of
  // staying pinned to whatever number was right for the previous model. An
  // explicit choice is always clamped to what the model really supports, so a
  // stale larger pick can never ask for a window that doesn't exist.
  //
  // `live` records whether `max` came from the provider itself or from the
  // MODEL_CONTEXT snapshot, purely so the UI can say which.
  _applyContextWindow(max, live) {
    this.modelContextMax = Number.isFinite(max) && max > 0 ? max : null;
    // Remembered so setContextWindow can re-post without having to re-derive
    // where the maximum originally came from.
    this._contextWindowWasLive = Boolean(live);
    if (!this.modelContextMax) {
      this.modelContextLength = null;
      this.view?.webview.postMessage({ type: 'contextWindow', max: null, current: null, options: [] });
      return;
    }
    const chosen = Number(vscode.workspace.getConfiguration('navy').get('contextWindow', 0)) || 0;
    this.modelContextLength = chosen > 0 ? Math.min(chosen, this.modelContextMax) : this.modelContextMax;
    this.view?.webview.postMessage({
      type: 'contextWindow',
      max: this.modelContextMax,
      current: this.modelContextLength,
      options: contextWindowOptions(this.modelContextMax),
      // Only Ollama takes num_ctx from this; elsewhere the window is fixed by
      // the API and the choice only affects when Navy treats the chat as full.
      adjustable: vscode.workspace.getConfiguration('navy').get('provider', 'ollama') === 'ollama',
      live: Boolean(live),
    });
  }

  // Per-file edit caps for one turn. Clamped rather than trusted: these guard
  // against a model looping on one file, so a configuration that disables the
  // guard (zero, negative) or inverts it must still leave something coherent
  // standing. An inverted pair raises the HARD cap to meet the soft one rather
  // than lowering the soft cap — someone who set them apart wanted more rope,
  // not less, and silently tightening a guard is the surprising direction.
  _fileEditCaps() {
    const cfg = vscode.workspace.getConfiguration('navy');
    const soft = Math.max(1, Math.round(Number(cfg.get('fileEditSoftCap', 5)) || 5));
    const hard = Math.max(soft, Math.round(Number(cfg.get('fileEditHardCap', 10)) || 10));
    return { soft, hard };
  }

  // How many characters of conversation Navy is willing to assemble, derived
  // from the window the active model really has. See the constants at the top
  // of this file for why the factors are what they are.
  //
  // Reads modelContextLength, NOT modelContextMax: the former is the user's
  // navy.contextWindow choice already clamped to what the model supports, which
  // is exactly what that setting is documented to control ("only affects when
  // Navy treats the chat as full"). Deriving from the max instead would ignore
  // a deliberate choice, and re-applying the clamp here would duplicate logic
  // that already lives in _applyContextWindow and could drift from it.
  // navy.modelPricing, read at the call site rather than baked into
  // estimateCost, which stays pure. See src/providers/pricing.js.
  _modelPricingOverrides() {
    return vscode.workspace.getConfiguration('navy').get('modelPricing', {});
  }

  _contextCharCaps() {
    const tokens = Number(this.modelContextLength) || 0;
    const compact = tokens
      ? Math.min(Math.floor(tokens * this._charsPerToken() * CONTEXT_FILL), CONTEXT_CHARS_CEILING)
      : CONTEXT_CHARS_FLOOR;
    return { compact, history: Math.floor(compact * HISTORY_CAP_FRACTION) };
  }

  // The user picking a size from the dropdown. Persisted globally (it's a
  // property of the machine's memory and the model, not of one project), then
  // re-resolved through the same path everything else uses.
  async setContextWindow(tokens) {
    const value = Number(tokens);
    const normalized = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    await vscode.workspace.getConfiguration('navy').update('contextWindow', normalized, vscode.ConfigurationTarget.Global);
    this._applyContextWindow(this.modelContextMax, this._contextWindowWasLive);
  }

  setThinkingLevel(level) {
    if (['fast', 'medium', 'high'].includes(level)) {
      this.thinkingLevel = level;
      // Persist so the choice survives window reloads (fire-and-forget is fine here).
      vscode.workspace.getConfiguration('navy').update('thinkingLevel', level, vscode.ConfigurationTarget.Global);
      this.view?.webview.postMessage({ type: 'thinkingLevel', level });
    }
  }

  // ── Project session & memory ─────────────────────────────────────────────

  // Both accept an optional root override (defaulting to the active
  // project) so callers that need to write into a project's .navy/ dir
  // BEFORE it's necessarily the active one — e.g. persisted background
  // processes, which are keyed by whichever root spawned them, not
  // whichever one happens to be on-screen — don't have to fake-switch
  // projectRoot just to reuse this helper.
  getNavyDir(root = this.projectRoot) {
    return root ? path.join(root, '.navy') : null;
  }

  // Self-ignoring directory: chat files contain the full conversation text,
  // which must never end up committed to the user's repo.
  //
  // `commands/` is the deliberate exception. A project's slash commands are
  // meant to be shared with the people working on it, and a blanket `*` made
  // that impossible — the files existed and git refused to see them. Both
  // negations are needed: git does not descend into an excluded directory, so
  // un-ignoring only the contents would never be reached.
  static NAVY_GITIGNORE = '*\n!.gitignore\n!commands/\n!commands/**\n';

  async ensureNavyDir(root = this.projectRoot) {
    const dir = this.getNavyDir(root);
    if (!dir) return null;
    try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir)); } catch {}
    const gi = vscode.Uri.file(path.join(dir, '.gitignore'));
    let current = null;
    try { current = Buffer.from(await vscode.workspace.fs.readFile(gi)).toString('utf8'); } catch {}
    // Rewritten only when it is still byte-for-byte what Navy itself wrote
    // before commands existed. Anything the user has since edited is theirs,
    // and silently rewriting a .gitignore is not a thing to do twice.
    if (current === null || current === '*\n') {
      try { await vscode.workspace.fs.writeFile(gi, Buffer.from(NavyCoderViewProvider.NAVY_GITIGNORE, 'utf8')); } catch {}
    }
    return dir;
  }

  // Refreshes the webview from the ACTIVE session's already-in-memory state.
  // Does NOT read chat history from disk — that only ever happens once, in
  // _ensureProjectChatsLoaded, when a project is first activated this
  // window — so calling this repeatedly (every tab switch, every project
  // switch) can't re-import stale disk content over newer in-memory state.
  async loadProjectSession() {
    // Undo/redo history is per-chat: the redo stack must not survive a
    // switch (it holds the OTHER chat's files).
    if (this.redoStack.length) {
      this.redoStack = [];
      this.view?.webview.postMessage({ type: 'redoState', count: 0 });
    }
    this.restoreMessages();
    const memory = this.projectRoot ? await this.loadProjectMemory() : '';
    // Usage travels with 'sessionLoaded' too — restoring a chat or switching
    // to a sibling should show ITS accumulated cost immediately, not stay
    // blank until you happen to send another message in it.
    const usage = this._sessionUsage();
    this.view?.webview.postMessage({
      type: 'sessionLoaded',
      count: this.messages.length,
      memory,
      projectRoot: this.projectRoot,
      sessionPrompt: usage.prompt,
      sessionCompletion: usage.completion,
      sessionTotal: usage.prompt + usage.completion,
      estimatedCost: usage.prompt + usage.completion > 0 ? usage.cost : null,
      costKnown: usage.costKnown,
    });
    const rules = this.projectRoot ? await this.loadProjectRules() : '';
    this.view?.webview.postMessage({ type: 'rulesStatus', active: Boolean(rules) });
    this.view?.webview.postMessage({ type: 'checkpoints', count: this.checkpoints.length });
    this._sendLiveCardState();
  }

  // Re-announces anything still RUNNING in this chat, because switching tabs
  // clears the view entirely while the work underneath carries on.
  //
  // Without this, leaving a tab and coming back left a dev server with no card
  // and no Stop button, and a running background task whose every later
  // message the frontend then discarded (its card is only created on 'start',
  // which had already been and gone) — so the task's final answer was lost
  // outright. Clear Chat already re-sent the run-project card for exactly this
  // reason; a tab switch needs the same treatment, for all three card kinds.
  _sendLiveCardState() {
    const post = (m) => this.view?.webview.postMessage(m);

    const runProject = this.bgProcesses.get('__run_project__');
    if (runProject?.proc) {
      const projectName = path.basename(this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');
      post({ type: 'runProjectStart', projectName, command: runProject.command });
      if (runProject.url) post({ type: 'runProjectReady', url: runProject.url });
    }

    for (const [taskId, worker] of this.bgWorkers) {
      post({ type: 'bgTaskUpdate', taskId, status: 'start', prompt: worker.prompt || '' });
    }

    for (const [id, entry] of this.bgProcesses) {
      if (id === '__run_project__' || !entry?.proc) continue;
      // Replays what has been captured so far, which also recreates the panel
      // (appendBgProcessOutput builds it on demand). A persisted process has no
      // in-memory buffer — an empty chunk still restores its panel and its
      // Stop control.
      post({ type: 'bgProcessOutput', id, chunk: entry.stdout || '' });
    }
  }

  // Persists the ACTIVE chat to its OWN file (.navy/chats/<id>.json) — never
  // a file shared with any other chat, so two chats on the same project can
  // never clobber each other's history. See _persistCheckpoints, which
  // writes the same file (also carrying checkpoints) on its own debounce.
  async _writeChatFile() {
    const dir = await this.ensureNavyDir();
    if (!dir) return;
    const chatsDir = path.join(dir, 'chats');
    try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(chatsDir)); } catch {}
    const s = this._session;
    let bytes = 0;
    const keepCps = [];
    for (let i = s.checkpoints.length - 1; i >= 0; i--) {
      bytes += (s.checkpoints[i].originalText || '').length;
      if (bytes > 8_000_000) break;
      keepCps.unshift(s.checkpoints[i]);
    }
    s._updated = new Date().toISOString();
    try {
      const payload = { id: s.id, updated: s._updated, messages: s.messages, digest: s.sessionDigest || '', checkpoints: keepCps };
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(path.join(chatsDir, s.id + '.json')),
        Buffer.from(JSON.stringify(payload), 'utf8')
      );
    } catch (e) { this.log?.('chat persist failed: ' + e.message); }
  }

  async saveProjectSession() {
    if (!this.projectRoot) return;
    await this._writeChatFile();
  }

  async loadProjectMemory() {
    const dir = this.getNavyDir();
    if (!dir) return '';
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(dir, 'memory.md')));
      return Buffer.from(data).toString('utf8').trim();
    } catch { return ''; }
  }

  async loadProjectRules() {
    // Merge EVERY well-known rule file found, not just the first — a project
    // commonly has a tool-agnostic AGENTS.md for shared team conventions AND
    // a small tool-specific file (.cursorrules, .navyrules) layering a
    // targeted tweak on top. "First file wins" meant adding either one
    // silently discarded ALL of the other: a repo that already had AGENTS.md
    // and then dropped in a two-line .navyrules note would lose the entire
    // rest of its conventions the moment Navy read rules at all. Ordered
    // broadest-first so a more Navy-specific file reads as a refinement of
    // (and, on conflict, an override for) the general ones before it —
    // matching the "later = can override earlier" convention already used
    // for navy.systemPrompt vs. the built-in tool-use rules.
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const sections = [];
    if (root) {
      for (const name of ['AGENTS.md', '.github/copilot-instructions.md', '.cursorrules', '.navyrules']) {
        try {
          const data = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, name)));
          const text = Buffer.from(data).toString('utf8').trim();
          if (text) sections.push(`### From ${name}\n${text}`);
        } catch {}
      }
    }
    if (sections.length) return sections.join('\n\n');
    // Fall back to the Navy-managed rules.md in .navy/ only when NONE of the
    // well-known files above exist at all.
    const dir = this.getNavyDir();
    if (!dir) return '';
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(dir, 'rules.md')));
      return Buffer.from(data).toString('utf8').trim();
    } catch { return ''; }
  }

  async saveProjectMemory(content) {
    const dir = await this.ensureNavyDir();
    if (!dir) return;
    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(path.join(dir, 'memory.md')),
        Buffer.from(content, 'utf8')
      );
    } catch {}
  }

  async toolRemember(fact) {
    if (!fact?.trim()) return 'No fact provided.';
    const existing = await this.loadProjectMemory();
    const date = new Date().toISOString().slice(0, 10);
    const newContent = existing
      ? existing + '\n- [' + date + '] ' + fact.trim()
      : '# Navy Project Memory\n\n- [' + date + '] ' + fact.trim();
    await this.saveProjectMemory(newContent);
    this.view?.webview.postMessage({ type: 'memoryUpdated', memory: newContent });
    return 'Remembered.';
  }

  async toolForget(query) {
    const existing = await this.loadProjectMemory();
    if (!query?.trim()) {
      await this.saveProjectMemory('# Navy Project Memory\n');
      this.view?.webview.postMessage({ type: 'memoryUpdated', memory: '' });
      return 'All project memory cleared.';
    }
    const filtered = existing
      .split('\n')
      .filter(l => !l.toLowerCase().includes(query.toLowerCase()))
      .join('\n');
    await this.saveProjectMemory(filtered);
    this.view?.webview.postMessage({ type: 'memoryUpdated', memory: filtered });
    return 'Removed memories matching: ' + query;
  }

  async clearProjectSession() {
    this.messages = [];
    this.lastReply = '';
    this.checkpoints = [];
    this.view?.webview.postMessage({ type: 'cleared' });
    await this.saveProjectSession();
    this.view?.webview.postMessage({ type: 'sessionLoaded', count: 0, memory: await this.loadProjectMemory(), projectRoot: this.projectRoot });
  }

  // Drops every prompt still waiting in the queue and tells the webview which
  // ones went, so their bubbles can be marked instead of silently posing as
  // sent. Shared by Stop and clearChat — both abandon the queue, and having one
  // of them forget to say so is exactly how a bubble ends up lying.
  _dropQueuedMessages() {
    const ids = this.messageQueue.map(m => m.queueId).filter(Boolean);
    this.messageQueue = [];
    this.view?.webview.postMessage({ type: 'queueCleared', ids, remaining: 0 });
  }

  // Removes ONE queued prompt by the id the webview generated for it. Racy by
  // nature: the turn can finish and drain the queue between the click and this
  // handler, so a miss is a normal outcome, not an error — `ok: false` tells
  // the webview the message is already running and its cancel affordance
  // should simply go away. Only ever touches the queue: a prompt that has
  // started is the running turn's business, and Stop is the control for that.
  cancelQueuedMessage(id) {
    if (!id) return;
    const before = this.messageQueue.length;
    this.messageQueue = this.messageQueue.filter(m => m.queueId !== id);
    const removed = this.messageQueue.length < before;
    this.view?.webview.postMessage({
      type: 'queueCancelled', id, ok: removed, remaining: this.messageQueue.length,
    });
  }

  async askNavy(prompt, includeContext, selectedModel, attachedFiles = [], images = [], queueId = '') {
    if (!prompt.trim()) return;

    // Queue while busy so the user can keep typing freely. queueId is the
    // webview's handle on the bubble it already drew for this prompt — it is
    // what lets that bubble carry a working Cancel button (see
    // cancelQueuedMessage) and what identifies the prompt when it starts.
    if (this.isBusy) {
      this.messageQueue.push({ prompt, includeContext, selectedModel, attachedFiles, images, queueId });
      this.view?.webview.postMessage({ type: 'queued', id: queueId, position: this.messageQueue.length });
      return;
    }

    // Captured once, at invocation — everything below runs bound to THIS
    // session regardless of which tab the user switches to while it's
    // running (see the _session getter and sessionContext at the top of this
    // file). Without this, a background turn would start reading and writing
    // a DIFFERENT project's messages/checkpoints the instant the user
    // switched tabs, since those otherwise resolve from the live, shared
    // activeSessionId.
    //
    // Prefers an ALREADY-ESTABLISHED context over activeSessionId, same as
    // the postMessage wrapper and _persistCheckpoints: the queue drain in
    // _askNavyTurn's finally block re-enters here from inside the finishing
    // turn's own context (AsyncLocalStorage propagates through the
    // setImmediate it uses), so reading activeSessionId unconditionally
    // would re-bind a queued prompt to whichever tab is VISIBLE by then —
    // running tab A's queued message against tab B's messages, checkpoints
    // and projectRoot, landing its file writes in the wrong project.
    const boundSession = sessionContext.getStore() ?? this.activeSessionId;
    return sessionContext.run(boundSession, () => this._askNavyTurn(prompt, includeContext, selectedModel, attachedFiles, images));
  }

  // Tries the configured primary provider first, exactly like a plain
  // streamAssistant call — and ONLY for a genuinely transient failure
  // (isTransientProviderError: rate limit, server outage, or network error;
  // NEVER auth/quota/context-length/model-not-found, which need YOU to fix
  // something rather than a different account to silently pay for) falls
  // through navy.providerFallbacks in order, each entry using its OWN
  // already-saved API key. Empty by default (opt-in only) — with nothing
  // configured this behaves identically to calling streamAssistant directly.
  // Every fallback attempt is announced in the chat BEFORE it runs and
  // whether it succeeded — real money can land on a different account, so
  // that must never happen invisibly. Returns the normal streamAssistant
  // result plus { usedProvider, usedModel } so the caller can tag rawBlocks/
  // cost/meta with whichever provider ACTUALLY served this call, not
  // whatever's configured as primary.
  async _streamWithFallback(host, model, messages, temperature, toolsApiOverride = null) {
    const config = vscode.workspace.getConfiguration('navy');
    const primaryProvider = config.get('provider', 'ollama');
    try {
      const result = await streamAssistant(this, host, model, messages, temperature, this.abortController?.signal, null, null, toolsApiOverride);
      return { ...result, usedProvider: primaryProvider, usedModel: model };
    } catch (primaryError) {
      if (this.abortController?.signal.aborted) throw primaryError; // never fall back from an intentional Stop
      if (!isTransientProviderError(primaryError.message)) throw primaryError;
      const fallbacks = config.get('providerFallbacks', []);
      if (!Array.isArray(fallbacks) || !fallbacks.length) throw primaryError;

      const primaryLabel = providerDisplayName(primaryProvider);
      let lastError = primaryError;
      for (const fb of fallbacks) {
        if (!fb || !fb.provider || !fb.model) continue; // malformed entry — skip rather than crash the turn over a settings typo
        if (this.abortController?.signal.aborted) throw lastError;
        const fbLabel = providerDisplayName(fb.provider);
        const reason = classifyProviderError(primaryLabel, lastError.message)?.title || `${primaryLabel} error: ${lastError.message}`;
        this._announceFallback(`${reason} — trying fallback: ${fbLabel} (${fb.model})…`);
        try {
          const fbHost = (fb.provider === 'ollama' || fb.provider === 'lmstudio') ? (fb.host || host) : host;
          // The fallback keeps the SAME tool tier as the primary: the transcript
          // so far was built against that tool list, and mid-turn consistency
          // matters more than briefly widening the set for a bigger model.
          const result = await streamAssistant(this, fbHost, fb.model, messages, temperature, this.abortController?.signal, null,
            { aiProvider: fb.provider, apiBase: fb.apiBase }, toolsApiOverride);
          this._announceFallback(`Fallback succeeded: ${fbLabel}`);
          return { ...result, usedProvider: fb.provider, usedModel: fb.model };
        } catch (fbError) {
          // No separate "also failed" message here — the next iteration's own
          // "trying fallback: …" line (or, if none remain, the final thrown
          // error's normal formatted display) already makes that clear.
          lastError = fbError;
        }
      }
      throw lastError;
    }
  }

  // Streams a fallback notice into the live reply AND records it on the
  // session, so it survives into persisted history. Posting a bare 'chunk' was
  // display-only: the notice appeared while the turn ran, then vanished on the
  // next reload, because only the model's own responseText is persisted. That
  // is exactly the wrong thing to lose — it is the record of which account got
  // billed for the turn.
  _announceFallback(text) {
    this.view?.webview.postMessage({ type: 'chunk', text: `\n\n_[${text}]_\n\n` });
    this._session.fallbackNotices.push(text);
  }

  async _askNavyTurn(prompt, includeContext, selectedModel, attachedFiles, images) {
    this.isBusy = true;
    this._session.fallbackNotices = []; // per-turn; folded into the persisted reply below
    this._sendSessionList(); // tab strip's busy spinner reflects this session's turn starting
    if (this.statusBarItem) this.statusBarItem.text = '$(sync~spin) Navy';
    this.currentTurnId = this.generateId();
    this._resetPlan();
    // Liveness beacon: the webview only declares Navy dead after 4 minutes of
    // silence, so beat every 30s for the whole turn (model calls, tools, and
    // approval waits included). Cleared in finally.
    clearInterval(this._heartbeat);
    this._heartbeat = setInterval(() => {
      this.view?.webview.postMessage({ type: 'heartbeat' });
    }, 30000);

    const config = vscode.workspace.getConfiguration('navy');
    const configuredModel = config.get('model', '');
    const model = selectedModel || configuredModel; // the configured PRIMARY — always what _streamWithFallback tries first, every iteration; never reassigned
    // Published on the session so tools that make their OWN model calls run on
    // the same model as the turn that invoked them — see toolDelegateResearch.
    // The picker's choice arrives as `selectedModel` and only reaches
    // navy.model via setModel, so reading config directly can lag by a turn.
    this._session.activeModel = model;
    const host = config.get('host', 'http://localhost:11434').replace(/\/$/, '');
    const aiProviderForTag = config.get('provider', 'ollama'); // ditto: the configured primary, immutable
    // Whichever provider/model actually served the MOST RECENT model call —
    // equals the primary above unless navy.providerFallbacks kicked in for
    // that call. Used (instead of the immutable pair above) anywhere a call's
    // OWN result needs tagging: rawBlocks replay safety, cost estimation, and
    // the turn's persisted meta.provider/meta.model.
    let lastUsedProvider = aiProviderForTag;
    let lastUsedModel = model;

    // Map thinking level to temperature.
    const tempByLevel = { fast: 0.0, medium: 0.2, high: 0.7 };
    const temperature = tempByLevel[this.thinkingLevel] ?? config.get('temperature', 0.2);
    const maxIterations = config.get('maxToolIterations', 100);
    const maxContextChars = config.get('maxContextChars', 12000);

    // Reduced tool tier for small models — decided once so the system prompt
    // and every model call this turn agree on which tools are on offer.
    // `extraToolsUnlocked` flips when the model calls request_more_tools; from
    // the next model call on it gets the full schemas.
    const reducedTools = this._shouldReduceTools(model);
    let extraToolsUnlocked = false;
    if (reducedTools) {
      this.log?.(`Reduced tool set for ${model}: offering ${TOOLS_API_CORE.length} core tools, withholding ${WITHHELD_TOOLS.length} (request_more_tools unlocks them). navy.reducedToolset=off disables this.`);
    }

    const activeEditor = vscode.window.activeTextEditor;
    const activeFile = activeEditor ? activeEditor.document.fileName : '';
    const activeLanguage = activeEditor ? activeEditor.document.languageId : '';
    const extraFiles = Array.isArray(attachedFiles) ? attachedFiles : [];

    // Auto-attach the active file if not already present and prompt is edit OR review/analysis.
    const activeFileLower = activeFile.toLowerCase();
    if (activeFile && !extraFiles.some(f => f.toLowerCase() === activeFileLower) &&
        /\b(update|edit|modify|change|fix|refactor|rewrite|replace|add|remove|delete|rename|move|create|make|implement|review|analyse|analyze|explain|check|look|show|describe|summarize|audit|inspect|read)\b/i.test(prompt)) {
      extraFiles.push(activeFile);
    }

    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'none';
    const repoMap = await this.buildRepoMap();

    // Auto-retrieval: on a code-oriented request, hand the model a ranked shortlist
    // of likely-relevant files up front so it doesn't have to guess-and-read. Only
    // paths (not contents) — the model reads the ones it wants. Gated to code tasks
    // and bounded, so simple chat and huge repos stay fast; failures are non-fatal.
    let relevantBlock = '';
    try {
      const isCodeTask = /\b(fix|bug|edit|update|change|modify|refactor|implement|add|remove|rename|review|debug|explain|where|find|which|how|trace|test|error|function|class|method|component|endpoint|route|handler|module|import|feature)\b/i.test(prompt);
      if (root !== 'none' && isCodeTask) {
        const terms = this._tokenizeQuery(prompt);
        if (terms.length) {
          const hits = await this._collectRelevance(root, terms, { maxFiles: 800 });
          const ranked = this._rankRelevance(hits, terms).slice(0, 6);
          if (ranked.length) {
            relevantBlock = '\n\n## Likely relevant files (ranked for this request — read the ones you need, this is a hint not a limit):\n'
              + ranked.map(h => `- ${h.rel}${h.defs ? ' (defines a queried symbol)' : ''}`).join('\n');
          }
        }
      }
    } catch (e) { this.log?.('auto-retrieval failed: ' + e.message); }

    let diagnosticsContext = '';
    if (activeFile) {
      try {
        const uri = vscode.Uri.file(activeFile);
        const diags = vscode.languages.getDiagnostics(uri);
        if (diags.length > 0) {
          const errors = diags.filter(d => d.severity === 0);
          const warnings = diags.filter(d => d.severity === 1);
          diagnosticsContext = `\n\n## Active File Diagnostics (${path.basename(activeFile)})\n`
            + diags.slice(0, 20).map(d => {
                const sev = ['Error', 'Warning', 'Info', 'Hint'][d.severity] || '?';
                return `[${sev}] line ${d.range.start.line + 1}: ${d.message}`;
              }).join('\n');
          if (errors.length > 0 || warnings.length > 0) {
            this.view?.webview.postMessage({ type: 'diagnostics', errors: errors.length, warnings: warnings.length });
          }
        }
      } catch {}
    }

    const contextText = includeContext ? getEditorContext(maxContextChars) : '';

    const [projectMemory, projectRules] = await Promise.all([
      this.loadProjectMemory(),
      this.loadProjectRules()
    ]);

    // Notify webview whether rules are active so the badge shows.
    this.view?.webview.postMessage({ type: 'rulesStatus', active: Boolean(projectRules) });

    const rootKnown = root && root !== 'none';
    const projectName = rootKnown ? path.basename(root) : null;
    // The shell the model must WRITE for, which is not necessarily the host's:
    // under navy.sandboxMode 'docker' every command runs inside a Linux
    // container. Telling a model on Windows to write cmd.exe syntax that then
    // executes in a container is the same bug as building `cmd /c` for it —
    // both have to follow the execution target. See _commandTargetIsPosix.
    const sandboxed = vscode.workspace.getConfiguration('navy').get('sandboxMode', 'off') === 'docker';
    const isWinShell = !this._commandTargetIsPosix();
    const hostPlatform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
    const osPlatform = sandboxed
      ? `${hostPlatform} host, but commands run inside a Linux container (navy.sandboxMode is "docker")`
      : hostPlatform;
    // The exact shell run_command executes through — NOT just the OS family,
    // and NOT inferable from it either: navy.shell can name any of them, and
    // Docker sandboxing overrides that in turn. A model told only "Windows"
    // reasonably assumes PowerShell (the modern default terminal), so if the
    // command is really bound for cmd.exe its syntax fails in a way that
    // looks like the model not knowing its own OS, when it was handed the
    // wrong dialect. Both halves come from _resolveShell, which is also what
    // _shellSpec and _shellEscapeArg read — the name, the spawn and the
    // quoting cannot disagree.
    const activeShell = this._resolveShell();
    const shellName = activeShell.label;
    const shellNote = activeShell.dialect;
    const nowStr = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    // Cached after the first check (see _detectWsl) — a Unix-only tool (gcc,
    // make, …) that isn't on the Windows PATH may still exist inside WSL.
    // Irrelevant when sandboxed: the command is already in Linux, and telling
    // it to reach for `wsl` from inside a container would only waste a turn.
    const wslInfo = isWinShell ? await this._detectWsl() : { available: false };
    const wslNote = isWinShell
      ? (wslInfo.available
          ? `WSL available (distros: ${wslInfo.distros.join(', ')}) — for a Unix-only tool not on the Windows PATH, try running it via WSL, e.g.: wsl <command>. Windows paths need converting (C:\\foo\\bar → /mnt/c/foo/bar, or use "wsl wslpath 'C:\\foo\\bar'" to convert).`
          : 'WSL not detected — Unix-only tools with no Windows build are genuinely unavailable unless the user installs WSL.')
      : null;

    // OS/shell facts are always included — even with no project open, a wrong
    // guess here (e.g. assuming PowerShell or a Unix tool on Windows) is what
    // makes run_command calls fail in ways that look like blind guessing.
    let systemContent = (reducedTools ? TOOL_PROMPT_CORE : TOOL_PROMPT)
      + `\n\n## CURRENT ENVIRONMENT (these are facts, do NOT guess or invent alternatives)\n`
      + `- Operating system: ${osPlatform}\n`
      + `- run_command executes through: ${shellName} (${shellNote})\n`
      + (wslNote ? `- ${wslNote}\n` : '')
      + `- Date/time: ${nowStr}\n`;
    if (!rootKnown) {
      systemContent += `- Project: NONE — no folder is open in VS Code. Do NOT invent a project name or path; tell the user to open a folder first (File → Open Folder).`;
    } else {
      systemContent += `- Project name: ${projectName}\n`
        + `- Project root: ${root}\n`
        + `If asked about the project name, directory, or OS, answer using ONLY the values above.`;
    }
    // Cap each variable section so the system prompt can't itself overflow the
    // context window on a huge repo / big memory / long rules file — _compactMessages
    // only prunes tool results and images, never the system message.
    const cap = (s, n) => s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s;
    // Same idea, from the other end. The turn ledger is oldest-first, so
    // capping its head keeps turns 1-30 and drops everything recent — the exact
    // inverse of what a record of "what has already been done" is for.
    const capTail = (s, n) => s.length > n
      ? `…[${s.length - n} earlier characters trimmed]\n` + s.slice(-n) : s;
    // navy.systemPrompt: user-supplied preferences, appended AFTER the mandatory
    // tool-use rules so it can't accidentally override them. Guarded against the
    // legacy pre-agentic-loop default text (SEARCH/REPLACE fence instructions) —
    // that default used to be silently persisted by clicking Save, and injecting
    // it now would tell the model to paste code instead of calling tools, which
    // is precisely the hallucination bug this rule set exists to prevent.
    const customSystemPrompt = vscode.workspace.getConfiguration('navy').get('systemPrompt', '');
    if (customSystemPrompt.trim() && !customSystemPrompt.includes('SEARCH/REPLACE blocks')) {
      systemContent += '\n\n## User preferences (does not override the tool-use rules above):\n' + cap(customSystemPrompt.trim(), 2000);
    }
    if (projectRules) {
      systemContent += '\n\n## Project Rules (permanent team conventions — always follow these, they override your defaults; where multiple sources below conflict, the LATER one wins):\n' + cap(projectRules, 8000);
    }
    if (projectMemory) {
      systemContent += '\n\n## Project Memory (facts you learned in previous sessions — treat as ground truth unless you discover otherwise):\n' + cap(projectMemory, 6000);
    }
    if (this.sessionDigest) {
      systemContent += '\n\n## Earlier in this conversation (condensed — full text was trimmed to fit the context window):\n' + cap(this.sessionDigest, 6000);
    }
    // Navy own record of what past turns actually did, stated by the harness
    // in a place the model reads as context rather than as its own output, so
    // there is no format here for it to imitate.
    const historyLedger = this._historyLedger();
    if (historyLedger) {
      systemContent += '\n\n## What earlier turns already did (recorded by Navy — NOT your words; never reproduce this list in a reply)\n' + capTail(historyLedger, 4000);
    }
    if (diagnosticsContext) systemContent += diagnosticsContext;
    // Names and descriptions only — the bodies are read by activate_skill when
    // the model decides a task calls for one. Already bounded against the
    // model's own window inside skillManifest (see _skillBudgetChars), so no
    // cap() here: capping it twice would truncate a skill mid-description and
    // leave the model matching on half a sentence.
    const skillManifest = await this.skillManifest();
    if (skillManifest) systemContent += '\n\n## ' + skillManifest;
    if (this.mcp?.toolCount) {
      const names = this.mcp.getToolsApi().map(t => t.function.name).join(', ');
      systemContent += '\n\n## External MCP tools available (call them exactly like built-in tools):\n' + cap(names, 2000);
    }
    systemContent += '\n\nRepository map:\n' + cap(repoMap, 12000);
    if (relevantBlock) systemContent += cap(relevantBlock, 2000);
    // Appended LAST (highest recency salience) and only for models whose name
    // suggests they're small — a blunt, maximally-explicit restatement of the
    // anti-hallucination rule for the models most likely to need it.
    if (this._isLikelySmallModel(model)) {
      systemContent += '\n\n## IMPORTANT — READ THIS LAST INSTRUCTION CAREFULLY\n'
        + 'You are running as a smaller model that sometimes forgets to use tools. Before you write ANY sentence containing '
        + 'the words "created", "saved", "written", "done", or "fixed" about a file, STOP and check: did you actually call '
        + 'write_file or apply_edit and see a success result in THIS conversation? If not, call the tool NOW instead of '
        + 'describing the change in text. Text alone changes nothing on disk.';
    }

    const messages = [{ role: 'system', content: systemContent }];

    // Always include file contents in the user message so Navy can edit without separate read_file calls
    const fileContents = [];
    if (activeFile) {
      const activeText = this.truncateForContext(await this.readFileText(activeFile));
      if (activeText !== null) fileContents.push('ACTIVE FILE: ' + activeFile + ' (language: ' + activeLanguage + ')\n\n' + activeText);
    }
    for (const file of extraFiles) {
      const fileText = this.truncateForContext(await this.readFileText(file));
      if (fileText !== null && file !== activeFile) fileContents.push('ATTACHED FILE: ' + file + '\n\n' + fileText);
    }

    const userParts = [];
    if (activeFile) {
      userParts.push('THE FILE YOU SHOULD EDIT (if the request involves changing code) IS:\n' + activeFile + ' (language: ' + activeLanguage + ')');
    }
    if (contextText) userParts.push('Current editor context:\n\n' + contextText);
    if (fileContents.length > 0) userParts.push(fileContents.join('\n\n---\n\n'));
    userParts.push('USER REQUEST:\n' + prompt);

    // Long sessions: condense the oldest turns into a digest instead of silently
    // forgetting them — Navy keeps knowing what was discussed and changed early on.
    // Two independent triggers, not just message COUNT: a handful of verbose
    // turns (long files quoted back, big search/read results folded into the
    // reply) can already be hundreds of thousands of characters — replayed on
    // EVERY iteration of EVERY future turn — while staying nowhere near 80
    // messages. _compactMessages (below, in the tool loop) only ever prunes
    // THIS turn's own fresh tool churn; nothing else bounds the size of past
    // turns being replayed, so that's this trigger's job.
    const HISTORY_CHAR_CAP = this._contextCharCaps().history; // kept under _compactMessages' own ceiling, which still has this turn's OWN growth to add on top
    const messagesCharSize = this.messages.reduce((sum, m) => sum + (m.text || '').length, 0);
    if (this.messages.length > 80 || messagesCharSize > HISTORY_CHAR_CAP) {
      // Keep at least the most recent MIN_KEEP messages no matter what (never
      // gut near-term continuity in one shot), otherwise keep growing the
      // kept window from the end until either MAX_KEEP messages are kept (the
      // original count-based target) or adding the next one would push the
      // KEPT portion itself back over the cap — whichever comes first, so a
      // handful of oversized messages gets trimmed even when there aren't 80+.
      const MIN_KEEP = 10, MAX_KEEP = 60;
      let keepCount = 0, keptSize = 0;
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const size = (this.messages[i].text || '').length;
        if (keepCount >= MIN_KEEP && (keepCount >= MAX_KEEP || keptSize + size > HISTORY_CHAR_CAP)) break;
        keptSize += size;
        keepCount++;
      }
      const dropped = this.messages.slice(0, this.messages.length - keepCount);
      // A size-triggered check on a session with FEWER than MIN_KEEP messages
      // has nothing it's willing to drop (the recency floor protects all of
      // them) — bail out before spending a whole extra model call summarizing
      // zero messages, which would waste tokens instead of saving them.
      if (dropped.length) {
        this.messages = this.messages.slice(-keepCount);
        // Mechanical digest — always available, zero latency, used as the fallback.
        const lines = dropped.map(m => {
          const head = (m.text || '').replace(/\s+/g, ' ').slice(0, 120);
          if (!head) return '';
          if (m.role === 'user') return '- User: ' + head;
          const files = m.meta?.files?.length ? ` [changed: ${m.meta.files.join(', ')}]` : '';
          const reads = m.meta?.reads?.length ? ` [read: ${m.meta.reads.join(', ')}]` : '';
          return '- Navy: ' + head + files + reads;
        }).filter(Boolean);
        let digestAddition = lines.join('\n');
        // Preferred: let the model write a REAL summary of what's being forgotten
        // (decisions, files changed, unresolved threads) — the way Claude Code
        // compacts. Rare (once per ~20 turns), so the extra call is acceptable;
        // any failure falls back to the mechanical digest above.
        try {
          this.view?.webview.postMessage({ type: 'statusText', text: 'Condensing history…' });
          const excerpt = dropped
            .map(m => (m.role === 'user' ? 'User: ' : 'Navy: ') + (m.text || '').slice(0, 600))
            .join('\n').slice(0, 12000);
          const summary = await this._completeOnce(host, model, [
            { role: 'system', content: 'You compress coding-assistant conversation history. Summarize the excerpt into at most 10 terse bullet lines covering: decisions made, files created/changed and why, problems found and their status (fixed/open), and user preferences. No preamble — output only the bullets.' },
            { role: 'user', content: excerpt },
          ]);
          if (summary && summary.trim().length > 40) digestAddition = summary.trim();
        } catch (e) { this.log?.('history summarization failed (using mechanical digest): ' + e.message); }
        this.sessionDigest = ((this.sessionDigest || '') + '\n' + digestAddition).trim();
        if (this.sessionDigest.length > 6000) {
          this.sessionDigest = '…\n' + this.sessionDigest.slice(-6000);
        }
      }
    }

    for (const item of this.messages) {
      // Exactly what was said, and nothing else. What each turn DID is real
      // and the model needs it — but it must NOT ride along on an assistant
      // message: a model reads its own prior turns as examples of how it
      // writes, so a note appended there becomes a format it copies. Once it
      // is copying the shape it invents the contents too, reporting files it
      // never touched. That record is in the system prompt now — _historyLedger.
      messages.push({ role: item.role, content: item.text });
    }

    const userText = userParts.join('\n\n---\n\n');
    if (Array.isArray(images) && images.length > 0) {
      // Vision message: content array with text + image blocks (OpenAI-compatible format).
      const parts = [{ type: 'text', text: userText }];
      for (const dataUrl of images) {
        parts.push({ type: 'image_url', image_url: { url: dataUrl } });
      }
      messages.push({ role: 'user', content: parts });
    } else {
      messages.push({ role: 'user', content: userText });
    }
    // Attachment names and the image count are persisted with the message so a
    // restored chat still shows its 📎/🖼 badges. They were rendered live and
    // then dropped, so reopening a chat made a question that hinged on an
    // attached file look like it was asked with no context at all.
    const attachedNames = (attachedFiles || [])
      .map(f => (typeof f === 'string' ? f : (f?.path || f?.name || '')))
      .filter(Boolean)
      .map(p => String(p).replace(/^.*[\\/]/, ''));
    this.messages.push({
      role: 'user',
      text: prompt,
      ...(attachedNames.length ? { attachments: attachedNames } : {}),
      ...(images?.length ? { images: images.length } : {}),
    });
    // Tab titles are drawn from the first user message (see
    // _sessionSummaries) — refresh now so a "New Chat" tab picks up its
    // real title the moment you send the first prompt, not only once the
    // whole turn finishes (the next _sendSessionList after this one).
    this._sendSessionList();

    this.lastReply = '';

    this.sendPendingApprovalsUpdate();
    this.view?.webview.postMessage({ type: 'start', model, activeFile, activeLanguage });

    let hitCap = false;   // declared outside try so finally{} can read it
    let usedTools = false; // outside try — the catch offers "Continue" only for turns with progress
    try {

      // One controller for the entire turn so Stop cancels both the current
      // stream AND any tool-loop iteration that follows it.
      this.abortController = new AbortController();
      // Watchdog: abort if a SINGLE model call hangs for 3 minutes. Reset every
      // iteration so long multi-step tasks that are making progress are never killed.
      const resetWatchdog = () => {
        clearTimeout(this._watchdog);
        this._watchdog = setTimeout(() => this.abortController?.abort(), 180_000);
      };
      resetWatchdog();

      // Loop-detection state: prevents re-reading the same file repeatedly.
      const seenReadCalls = new Set();
      let consecutiveReadOnlyIters = 0;
      const failedCommands = new Map(); // key → consecutive fail count for run_command/run_tests
      const fileEditCounts = new Map(); // path → successful-write count this turn (loop-of-edits guard)
      // stop feeding fresh diagnostics + nudge to wrap up / refuse further
      // writes to this file for the rest of the turn. Configurable because a
      // genuine single-file refactor can legitimately exceed ten writes; see
      // _fileEditCaps for why they're clamped rather than trusted.
      const { soft: FILE_EDIT_SOFT_CAP, hard: FILE_EDIT_HARD_CAP } = this._fileEditCaps();

      // Change tracker: accumulates what the model touched so we can append a report footer,
      // AND (via reads/commands persisted into meta below) so a LATER turn can see what THIS
      // turn actually verified/ran instead of only what its final reply claimed.
      const taskChanges = { touched: new Map(), deleted: [], commands: [], reads: [] };
      // touched: Map<inputPath, 'created'|'modified'>; commands/reads: capped arrays, see below
      // What the transcript SHOWED, kept so reopening the chat can show it
      // again (see makeCardRecord). Separate from taskChanges, which records
      // what the turn DID for the model's benefit — this one is purely visual
      // and is capped independently.
      const cardLog = [];
      const postToolCall = (tool, args, callId) =>
        this.view?.webview.postMessage({ type: 'toolCall', tool, args, callId });
      const postToolResult = (tool, args, result, callId) => {
        this.view?.webview.postMessage({ type: 'toolResult', tool, result, callId });
        if (cardLog.length < CARD_LOG_MAX) cardLog.push(makeCardRecord(tool, args, result));
      };
      const turnTokens = { prompt: 0, completion: 0 }; // accumulated across every model call this turn — see meta.tokens below
      this.subAgentTokens = { prompt: 0, completion: 0 }; // reset — any delegate_research calls this turn accumulate into this fresh object

      let lastAssistantText = ''; // final assistant text, persisted to history after the loop
      let hallucinationNudged = false; // false-completion-claim correction sent once
      let hallucinationWarned = false; // still claimed success after the nudge — tell the user
      // Only worth running the hallucination guard at all if the user's request
      // could plausibly have wanted a file created/changed — avoids false
      // positives on purely informational turns (computed once; the prompt text
      // doesn't change mid-turn).
      const promptRequestsFileAction = this._promptRequestsFileAction(prompt);
      const messagesRef = this.messages; // identity guard: clearChat/project-switch replace this array

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (this.abortController.signal.aborted) break;
        if (iteration > 0) {
          this.view?.webview.postMessage({ type: 'stepProgress', step: iteration + 1, max: maxIterations });
        }
        resetWatchdog();
        // Keep the request within the context window on long multi-step tasks.
        if (iteration > 0) this._compactMessages(messages);
        // The plan is re-stated on every iteration, replacing the previous
        // copy rather than accumulating: a long turn that only saw the plan
        // once at the start is exactly the drift the prose version suffered
        // from, and a plan repeated ten times is ten copies of the same text
        // in the context window.
        if (messages[0]?.role === 'system') {
          messages[0].content = systemContent + this._planForPrompt();
        }
        // Measured BEFORE the call, so the sample pairs the exact text sent
        // with the token count the provider reports back for it.
        const promptCharsSent = assembledCharSize(messages);
        const { text: responseText, nativeToolCalls, tokenCounts, rawBlocks, usedProvider, usedModel } = await this._streamWithFallback(
          host, model, messages, temperature,
          reducedTools && !extraToolsUnlocked ? TOOLS_API_CORE : null);
        lastUsedProvider = usedProvider;
        lastUsedModel = usedModel;
        // Model call finished — stop the watchdog so it can't fire while tools run or
        // while the user takes their time reviewing a pending edit approval.
        clearTimeout(this._watchdog);

        // Send token usage and context fill level after each model call.
        const totalTokens = tokenCounts.prompt + tokenCounts.completion;
        if (tokenCounts.prompt > 0) this._observeTokenRatio(promptCharsSent, tokenCounts.prompt);
        if (totalTokens > 0) {
          turnTokens.prompt += tokenCounts.prompt;
          turnTokens.completion += tokenCounts.completion;
          // Running session total = every already-PERSISTED turn's usage
          // (this._sessionUsage) plus however much of the CURRENT turn has
          // run so far — so the counter climbs live during a long multi-step
          // turn instead of jumping only once the turn finally finishes.
          const persisted = this._sessionUsage();
          // Includes any delegate_research sub-agent calls made so far this
          // turn — they ran through the SAME provider/model, so pricing the
          // combined total at that rate is exact, not an approximation.
          const turnPromptSoFar = turnTokens.prompt + this.subAgentTokens.prompt;
          const turnCompletionSoFar = turnTokens.completion + this.subAgentTokens.completion;
          const sessionPrompt = persisted.prompt + turnPromptSoFar;
          const sessionCompletion = persisted.completion + turnCompletionSoFar;
          // Prices the WHOLE turn's accumulated tokens at whichever provider
          // served the MOST RECENT call — a known simplification if a
          // fallback engaged partway through a multi-iteration turn (an
          // already-existing one-provider-per-turn assumption predating
          // navy.providerFallbacks, not something this feature makes worse
          // in a new way).
          const liveCost = estimateCost(lastUsedProvider, lastUsedModel, turnPromptSoFar, turnCompletionSoFar, this._modelPricingOverrides());
          const estimatedCost = liveCost === null ? null : persisted.cost + liveCost;
          const costKnown = persisted.costKnown && liveCost !== null;
          this.view?.webview.postMessage({
            type: 'tokenCount', prompt: tokenCounts.prompt, completion: tokenCounts.completion, total: totalTokens,
            sessionPrompt, sessionCompletion, sessionTotal: sessionPrompt + sessionCompletion,
            estimatedCost, costKnown,
          });
          if (this.modelContextLength) {
            this.view?.webview.postMessage({ type: 'contextUsage', used: tokenCounts.prompt, max: this.modelContextLength });
          }
        }

        // Normalize tool-call ids BEFORE they're used in the assistant message or
        // the tool results, so both sides pair correctly even on providers that
        // return empty/duplicate ids (Cohere/others via OpenRouter).
        this._normalizeToolCallIds(nativeToolCalls);

        // Build the assistant message. When using native tool calling, include tool_calls
        // so the model receives proper conversation history on the next iteration.
        if (nativeToolCalls.length > 0) {
          // _rawBlocks preserves Anthropic thinking/tool_use blocks OR Gemini
          // thought/functionCall parts for exact replay on the next iteration
          // (required for thinking + tool use on either provider). Tagged with
          // the producing provider — the two shapes are NOT interchangeable, so
          // if the user switches provider mid-conversation, each native path
          // only trusts rawBlocks it recognizes as its own and safely falls back
          // to reconstructing from the generic tool_calls array otherwise.
          messages.push({ role: 'assistant', content: responseText || '', tool_calls: nativeToolCalls,
            ...(rawBlocks?.length ? { _rawBlocks: rawBlocks, _rawBlocksProvider: lastUsedProvider } : {}) });
        } else {
          messages.push({ role: 'assistant', content: responseText });
        }
        // Track the latest text but only persist the FINAL one to session history —
        // persisting every intermediate tool-loop message creates runs of consecutive
        // assistant entries that bloat context and can 400 on providers that require
        // alternating roles (Anthropic).
        if (responseText.trim()) lastAssistantText = responseText;

        // Prefer native tool calls; fall back to XML parsing for models that embed XML in text.
        const toolCalls = nativeToolCalls.length > 0
          ? nativeToolCalls.map(tc => {
              let args = {};
              try {
                args = typeof tc.function.arguments === 'string'
                  ? JSON.parse(tc.function.arguments)
                  : (tc.function.arguments || {});
              } catch (e) {
                args = { __parseError: e.message, tool: tc.function.name };
              }
              return { name: tc.function.name, args, id: tc.id || '' };
            })
          : parseToolCalls(responseText);

        const isDone = toolCalls.length === 0 ||
          toolCalls.every((t) => t.name === 'finish');

        // Hallucination guard: the model claims a file action succeeded but never
        // called a tool this whole turn. Give it exactly ONE correction chance
        // (weak models that truly can't emit tool calls would otherwise loop
        // forever); if it still can't act, let it finish but warn the user plainly
        // instead of silently trusting the claim.
        if (isDone && !usedTools && promptRequestsFileAction && this._looksLikeFalseCompletionClaim(responseText)) {
          if (!hallucinationNudged) {
            hallucinationNudged = true;
            messages.push({
              role: 'user',
              content: '[SYSTEM: You just described a file action (created/saved/written/updated) but did NOT call any tool — nothing was actually changed. If you want to create or edit a file, call the write_file or apply_edit tool NOW. Do not just repeat the code as text.]',
            });
            continue;
          }
          hallucinationWarned = true;
        }

        if (isDone) {
          this.lastReply = responseText;

          // Build automatic change-report footer from what the model actually touched.
          const changedFiles = [...taskChanges.touched.entries()];
          const deletedFiles = taskChanges.deleted.filter(Boolean);
          const ranCmds = taskChanges.commands;
          let footer = '';
          if (changedFiles.length || deletedFiles.length || ranCmds.length) {
            const parts = [];
            if (changedFiles.length) {
              const fileList = changedFiles.map(([p, type]) =>
                '`' + path.basename(p) + '`' + (type === 'created' ? ' *(new)*' : type === 'renamed' ? ' *(renamed)*' : '')
              ).join(', ');
              parts.push(`**${changedFiles.length} file${changedFiles.length !== 1 ? 's' : ''} changed:** ${fileList}`);
            }
            if (deletedFiles.length) {
              parts.push('**Deleted:** ' + deletedFiles.map(p => '`' + path.basename(p) + '`').join(', '));
            }
            if (ranCmds.length) {
              parts.push('**Commands:** ' + ranCmds.map(c => '`' + c.cmd + '`' + (c.exit === 0 ? ' ✓' : ' ✗')).join(', '));
            }
            footer = '\n\n---\n' + parts.join('  \n');
          }
          // A turn that used tools escapes the guard above — it only catches a
          // reply with no tool calls at all — so a model that ran commands and
          // then reported files it never wrote passed unchallenged. This is the
          // same claim checked against Navy's own record of the turn: if the
          // report names files and nothing was written, renamed or deleted, say
          // so rather than letting the claim stand.
          // Only claimed when Navy could actually have seen the change. A turn
          // that edited through run_command — `git apply`, `sed -i`, a codemod
          // — changes files without any write TOOL being called, and warning
          // there would call a true report a fabrication.
          const fabricatedChangeClaim = !changedFiles.length && !deletedFiles.length
            && !ranCmds.length
            && this._claimsFilesChanged(responseText);
          if (fabricatedChangeClaim) {
            footer += (footer ? '\n' : '\n\n---\n')
              + '⚠️ **No files were changed this turn.** The summary above lists files as changed, but Navy did not write, rename or delete anything — check before relying on it.';
          }
          if (hallucinationWarned) {
            footer += (footer ? '\n' : '\n\n---\n')
              + '⚠️ **No files were actually changed.** The model described a file action above but never called a tool — nothing was saved. Ask it to actually write/apply the change, or apply the code yourself.';
          }

          if (!responseText.trim()) {
            if (usedTools) {
              this.view?.webview.postMessage({
                type: 'chunk',
                text: footer
                  ? '**Task complete.**' + footer
                  : '_Task complete. (No summary was provided — ask "what did you just do?" if you need details.)_',
              });
            } else {
              this.view?.webview.postMessage({
                type: 'chunk',
                text: '_No response received. The model may have hit its context limit, or the request timed out. Try sending again or switch to a different model._',
              });
            }
          } else if (footer) {
            // Model wrote a summary — append the objective change list after it.
            this.view?.webview.postMessage({ type: 'chunk', text: footer });
          }
          break;
        }

        // Last iteration — model is still using tools, meaning the task is unfinished.
        if (iteration === maxIterations - 1) { hitCap = true; }

        usedTools = true;
        const toolResults = [];
        const nonFinish = toolCalls.filter(t => t.name !== 'finish');

        const makeToolResult = (tool, result) => makeToolResultMessage(tool, result, nativeToolCalls.length > 0);

        // Tools whose results are stable — dedup prevents re-reading the same file in a loop.
        // web_search included so a weak model can't spin on the same query repeatedly.
        // Deliberately EXCLUDES check_syntax and get_diagnostics: verifying a file,
        // fixing it, then re-verifying is the correct workflow, and deduping the
        // second check returns a stale "content unchanged" answer that tells the
        // model its fix didn't land (or that a broken file is still fine).
        const DEDUP_TOOLS = new Set(['read_file','read_lines','list_files','search_files','search_codebase',
          'find_relevant_files','search_docs','git_status','git_diff','git_log','git_blame',
          'find_symbol','find_references','web_search']);
        // Command tools where repeated failure is tracked.
        const COMMAND_TOOLS = new Set(['run_command', 'run_tests']);
        // Write tools that touch files (used for the change-report footer).
        const WRITE_TOOLS = new Set(['write_file','apply_edit','edit_line','delete_line','insert_after_line']);

        // Track whether this iteration does any writes.
        const isAllReadOnly = nonFinish.every(t => READ_ONLY.has(t.name));
        if (isAllReadOnly) { consecutiveReadOnlyIters++; } else { consecutiveReadOnlyIters = 0; }

        // Separate out calls that should be short-circuited.
        const toolsToRun = [];
        for (const tool of nonFinish) {
          // request_more_tools is pure turn-loop state, never a real tool: it
          // flips the tier so the NEXT model call carries the full schemas.
          // Handled unconditionally (not only when reduced) because a model can
          // imitate a call it saw earlier in the transcript — answering "already
          // available" beats executeTool's unknown-tool error. Names only in the
          // result: the native path gets real schemas on the next request, and
          // the fallback path never sees schemas for ANY tool, just names.
          if (tool.name === 'request_more_tools') {
            const r = (!reducedTools || extraToolsUnlocked)
              ? '[All tools are already available — call the one you need directly.]'
              : '[Full tool set unlocked for the rest of this turn. Now also available: '
                + WITHHELD_TOOLS.map(t => t.name).join(', ')
                + '. Call them exactly like any other tool.]';
            extraToolsUnlocked = true;
            const callId = this.generateId();
            postToolCall(tool.name, tool.args, callId);
            postToolResult(tool.name, tool.args, r, callId);
            toolResults.push(makeToolResult(tool, r));
            continue;
          }
          // Deduplicate stable read-only calls.
          if (DEDUP_TOOLS.has(tool.name)) {
            const key = tool.name + ':' + JSON.stringify(tool.args || {});
            if (seenReadCalls.has(key)) {
              const r = '[Already retrieved — content unchanged. Use your existing context and take action now instead of re-reading.]';
              // Short-circuited calls still get their own visible card, tagged
              // with a unique callId — without this, the webview had no card to
              // attribute the result to and silently overwrote whatever OTHER
              // tool card happened to be on screen last.
              const callId = this.generateId();
              postToolCall(tool.name, tool.args, callId);
              postToolResult(tool.name, tool.args, r, callId);
              toolResults.push(makeToolResult(tool, r));
              continue;
            }
            seenReadCalls.add(key);
            // Record what was actually looked at (capped) so a LATER turn can be told
            // this turn already read/searched it — see _historyLedger.
            if (taskChanges.reads.length < 12) {
              const d = this._describeReadCall(tool);
              if (d) taskChanges.reads.push(d);
            }
          }
          // Block retrying a persistently-failing command (≥2 consecutive failures with same args).
          if (COMMAND_TOOLS.has(tool.name)) {
            const cmdKey = tool.name + ':' + (tool.args?.command || tool.args?.filter || '');
            const n = failedCommands.get(cmdKey) || 0;
            if (n >= 2) {
              const r = `[Blocked: this command has already failed ${n} time(s) in a row. Do NOT retry — diagnose the error output above, fix the code, then run again.]`;
              const callId = this.generateId();
              postToolCall(tool.name, tool.args, callId);
              postToolResult(tool.name, tool.args, r, callId);
              toolResults.push(makeToolResult(tool, r));
              continue;
            }
          }
          // Hard stop on a loop-of-edits: the same file has already been written
          // this many times in one turn (this is what the screenshot of 16+
          // consecutive "index.html ✓ Applied" cards was — usually a fix that
          // never actually resolves the diagnostic it's chasing).
          if (WRITE_TOOLS.has(tool.name) && tool.args?.path) {
            const editCount = fileEditCounts.get(tool.args.path) || 0;
            if (editCount >= FILE_EDIT_HARD_CAP) {
              const r = `[Blocked: ${tool.args.path} has already been edited ${editCount} times this turn with no finish(). This file will not accept further edits this turn. Call get_diagnostics on it and either explain to the user what's still wrong (and why you can't fix it automatically) or call finish() now.]`;
              const callId = this.generateId();
              postToolCall(tool.name, tool.args, callId);
              postToolResult(tool.name, tool.args, r, callId);
              toolResults.push(makeToolResult(tool, r));
              continue;
            }
          }
          toolsToRun.push(tool);
        }

        // Concurrency is safe for exactly the LEADING run of read-only calls,
        // and that boundary is a real one rather than a convenience. Those calls
        // are provably independent of every write in this batch, because no
        // write has happened yet. A read that comes AFTER a write in the same
        // response usually exists to observe that write — reading back what was
        // just written, re-checking diagnostics on it — so hoisting it into a
        // concurrent group would race it against the thing it is there to check.
        //
        // The previous rule was all-or-nothing: one write anywhere in the batch
        // forced every read in it to run serially too. Reads-then-act is the
        // shape a model actually emits, so that surrendered the concurrency in
        // precisely the case worth having it.
        let leadingReads = 0;
        while (leadingReads < toolsToRun.length && READ_ONLY.has(toolsToRun[leadingReads].name)) leadingReads++;
        if (leadingReads < 2) leadingReads = 0; // one call is not a batch — leave it to the serial path, which tracks more
        const parallelGroup = toolsToRun.slice(0, leadingReads);
        const serialGroup = toolsToRun.slice(leadingReads);

        if (parallelGroup.length > 1) {
          const parallel = await Promise.all(parallelGroup.map(async tool => {
            // Each call gets its own id so results — which can complete out of
            // order relative to each other since they run concurrently — always
            // update the card that actually belongs to them.
            const callId = this.generateId();
            postToolCall(tool.name, tool.args, callId);
            const result = await this.executeTool(tool);
            postToolResult(tool.name, tool.args, result, callId);
            return makeToolResult(tool, result);
          }));
          toolResults.push(...parallel);
        }

        if (serialGroup.length) {
          for (const tool of serialGroup) {
            // Stop pressed mid-iteration — don't execute the remaining tools (a write
            // tool would still hit disk after the user asked everything to halt).
            if (this.abortController.signal.aborted) break;
            const callId = this.generateId();
            postToolCall(tool.name, tool.args, callId);

            // Pre-call: check whether the file exists so we can label it 'created' vs 'modified'.
            let _fileIsNew = false;
            if (WRITE_TOOLS.has(tool.name) && tool.args?.path) {
              try { await vscode.workspace.fs.stat(vscode.Uri.file(this.resolveWorkspacePath(tool.args.path))); }
              catch { _fileIsNew = true; }
            }

            let result = await this.executeTool(tool);

            // Track command failures so we can block infinite retry loops.
            if (COMMAND_TOOLS.has(tool.name)) {
              const cmdKey = tool.name + ':' + (tool.args?.command || tool.args?.filter || '');
              if (typeof result === 'string' && /^Exit code: [^0\n]/.test(result)) {
                const n = (failedCommands.get(cmdKey) || 0) + 1;
                failedCommands.set(cmdKey, n);
                // A "not found"-shaped failure is a missing/PATH problem, not a code
                // bug — point at that specifically instead of the generic "diagnose
                // and fix the code" nudge, which doesn't apply here.
                const notFound = /is not recognized as an internal or external command|command not found|No such file or directory.*(?:PATH|command)/i.test(result);
                result += notFound
                  ? `\n\n[SYSTEM: This command failed because the program isn't installed or isn't on PATH — this is NOT a code bug. Verify with "${this._resolveShell().probe}" before trying again, and use an alternative if it's genuinely unavailable.]`
                  : '\n\n[SYSTEM: This command failed. Do NOT run it again without first diagnosing the error and fixing the code. Analyze the output above, find the root cause, apply a fix, then retry.]';
              } else if (typeof result === 'string' && result.startsWith('Exit code: 0')) {
                failedCommands.delete(cmdKey);
              }
              // Record for the change-report footer (and, capped, for the turn ledger).
              const exitMatch = String(result).match(/^Exit code: (\d+)/);
              if (exitMatch && taskChanges.commands.length < 8) {
                taskChanges.commands.push({ cmd: tool.args?.command || tool.args?.filter || '', exit: parseInt(exitMatch[1]) });
              }
            }
            // Record successful file writes + auto-verify with fresh diagnostics.
            if (WRITE_TOOLS.has(tool.name) && typeof result === 'string' && result.startsWith('Applied to')) {
              const p = tool.args?.path || '';
              if (p) {
                taskChanges.touched.set(p, _fileIsNew ? 'created' : 'modified');
                const editCount = (fileEditCounts.get(p) || 0) + 1;
                fileEditCounts.set(p, editCount);
                if (editCount < FILE_EDIT_SOFT_CAP) {
                  // Normal case: fresh diagnostics help the model verify its own edit.
                  result += await this._diagnosticsAfterWrite(p);
                } else if (editCount === FILE_EDIT_SOFT_CAP) {
                  // Stop feeding diagnostics from here — if the model has edited this
                  // file 5 times already, more of the same feedback is very likely
                  // what's DRIVING the loop rather than helping end it.
                  result += `\n\n[SYSTEM: You have edited ${p} ${editCount} times this turn. STOP iterating on small fixes here. Re-read the file if needed, make ONE decisive final edit, then call finish() and clearly state in your report if anything remains unresolved. Diagnostics will not be shown for further edits to this file this turn.]`;
                }
                // editCount > SOFT_CAP: no diagnostics, no repeated nudge — silence
                // itself discourages continuing, and the hard cap above is the backstop.
              }
            }
            if (tool.name === 'delete_file' && typeof result === 'string' && result.startsWith('Deleted')) {
              taskChanges.deleted.push(tool.args?.path || '');
            }
            if (tool.name === 'rename_file' && typeof result === 'string' && result.startsWith('Renamed')) {
              if (tool.args?.to) taskChanges.touched.set(tool.args.to, 'renamed');
            }
            if (tool.name === 'rename_symbol' && typeof result === 'string' && result.startsWith('Renamed')) {
              taskChanges.touched.set(tool.args?.name || 'symbol', 'renamed');
            }

            postToolResult(tool.name, tool.args, result, callId);
            toolResults.push(makeToolResult(tool, result));
          }
        }

        // After 3 straight read-only iterations with no action, inject a hard nudge.
        if (consecutiveReadOnlyIters >= 3 && toolResults.length > 0) {
          const nudge = `\n\n[SYSTEM: ${consecutiveReadOnlyIters} consecutive iterations with only reads and no changes. You now have sufficient context. Your next response MUST take action — apply_edit, write_file, run_command, or finish(). Do NOT read any more files.]`;
          const last = toolResults[toolResults.length - 1];
          last.content = String(last.content) + nudge;
        }

        for (const tr of toolResults) {
          messages.push(tr);
        }
      }

      // Persist only the final assistant message to session history (see note above).
      // Skip if the chat was cleared or the project switched mid-turn — this.messages
      // is a different array by then and pushing would create an orphan entry.
      if (lastAssistantText.trim() && this.messages === messagesRef) {
        // Attach what the turn changed so a restored session can still show it —
        // the live change-report footer is webview-only and lost on reload.
        const meta = {};
        if (taskChanges.touched.size)   meta.files   = [...taskChanges.touched.keys()].map(p => path.basename(p));
        if (taskChanges.deleted.length) meta.deleted = taskChanges.deleted.filter(Boolean).map(p => path.basename(p));
        if (taskChanges.commands.length) {
          meta.commands = taskChanges.commands.length; // display only — media/main.js renders this as a count
          meta.commandLog = taskChanges.commands;       // model-facing only — see _historyLedger
        }
        // reads: model-facing only — the webview has no use for it and ignores unknown meta keys.
        if (taskChanges.reads.length) meta.reads = taskChanges.reads;
        // provider/model travel WITH the tokens they priced — _sessionUsage prices
        // each turn at what actually ran it, not whatever's currently configured.
        // lastUsedProvider/lastUsedModel (not the immutable primary aiProviderForTag/
        // model) so a turn where navy.providerFallbacks actually engaged is priced
        // at the provider that really ran it, not the one that failed.
        // Includes any delegate_research sub-agent usage from this turn — it's
        // real spend against the same provider/model, so it belongs in the total.
        const finalTokens = {
          prompt: turnTokens.prompt + this.subAgentTokens.prompt,
          completion: turnTokens.completion + this.subAgentTokens.completion,
        };
        if (finalTokens.prompt + finalTokens.completion > 0) {
          meta.tokens = finalTokens;
          meta.provider = lastUsedProvider;
          meta.model = lastUsedModel;
        }
        // The plan as it stood when the turn ended, so reopening the chat shows
        // the same progress it showed live. Display-only, like cards: the model
        // is handed the CURRENT plan directly by _planForPrompt, and replaying
        // every past turn's finished plan into its context would be noise.
        if (this._session.plan?.length) meta.plan = this._session.plan;

        // Fallback notices ride along in the persisted text so a reloaded
        // session still shows that a different provider (and a different
        // account) served this turn — see _announceFallback.
        const notices = this._session.fallbackNotices;
        // A plan with steps still open is a fact about what happened, not an
        // error — the user may have pressed Stop, or the task may genuinely be
        // partial. Stating it beats a progress display that simply stopped.
        const planNote = this._planCompletionNote();
        const persistedText = (notices.length
          ? notices.map(n => `_[${n}]_`).join('\n') + '\n\n' + lastAssistantText
          : lastAssistantText) + planNote;
        if (planNote) this.view?.webview.postMessage({ type: 'planIncomplete', note: planNote.trim() });
        this.messages.push({
          role: 'assistant',
          text: persistedText,
          ...(Object.keys(meta).length ? { meta } : {}),
          // Visual only. Kept off `meta` on purpose: meta is read back into the
          // model's context by _historyLedger, and the cards are already
          // described there far more cheaply than replaying them as prose.
          ...(cardLog.length ? { cards: cardLog } : {}),
        });
      }

      // Only auto-apply code fences in pure-chat mode (no tool use), to prevent double-applies.
      if (!usedTools) {
        const codeEdits = extractCodeEdits(this.lastReply);
        for (const edit of codeEdits) {
          await this.applyCode(edit.code, edit.path);
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        this.view?.webview.postMessage({ type: 'aborted' });
      } else {
        const p = vscode.workspace.getConfiguration('navy').get('provider', 'ollama');
        const providerLabel = providerDisplayName(p);
        // Classified + redacted: plain-language cause, concrete next steps, no account ids.
        this.log?.('provider error: ' + error.message);
        this.view?.webview.postMessage({ type: 'error', message: formatProviderError(providerLabel, error.message) });
        // The turn made real progress before failing — offer a one-click resume.
        if (usedTools) this.view?.webview.postMessage({ type: 'errorContinue' });
      }
    } finally {
      clearInterval(this._heartbeat);
      this._heartbeat = undefined;
      clearTimeout(this._watchdog);
      this._watchdog = undefined;
      this.abortController = undefined;
      this.isBusy = false;
      this._sendSessionList(); // tab strip's busy spinner reflects this session's turn ending
      if (this.statusBarItem) this.statusBarItem.text = '☸ Navy';
      this.view?.webview.postMessage({ type: 'done' });
      if (hitCap) this.view?.webview.postMessage({ type: 'capReached', steps: maxIterations });
      // Persist the session after every turn — wrapped so a write failure never
      // prevents 'done' from being sent or the queue from draining.
      try { await this.saveProjectSession(); } catch (e) { this.log?.('session save failed: ' + e.message); }

      // Drain the message queue — process the next queued message if any.
      if (this.messageQueue.length > 0) {
        const next = this.messageQueue.shift();
        // `id` names the prompt that is STARTING, so the webview can retire
        // exactly that bubble's Cancel button. Once a prompt is out of the
        // queue there is nothing left to cancel — Stop is the control from
        // here on, and a button that silently stopped working would be worse
        // than no button.
        this.view?.webview.postMessage({ type: 'queueDrained', id: next.queueId || '', remaining: this.messageQueue.length });
        // Fire-and-forget, so it MUST carry its own catch: an unhandled
        // rejection out of the turn loop can take down the extension host,
        // which surfaces to the user as Navy simply dying mid-task.
        setImmediate(() => {
          // Carries its queueId back in. This runs a tick later, so another turn
          // can have started in between (the user sends again in that window) —
          // askNavy then puts this prompt BACK in the queue, and without its own
          // id it would be re-queued as an anonymous entry: no Cancel button on a
          // bubble that is genuinely waiting again, and nothing for Stop to name.
          this.askNavy(next.prompt, next.includeContext, next.selectedModel, next.attachedFiles, next.images || [], next.queueId || '')
            .catch(e => this._reportTurnFailure(e, 'queued message'));
        });
      }
    }
  }

  // Short human-readable label for a read-type tool call, for the turn ledger
  // (see _historyLedger) — never shown in the chat UI, just fed back to the
  // model so it knows what a PAST turn actually looked at, not just what that
  // turn's reply claimed.
  _describeReadCall(tool) {
    const a = tool.args || {};
    switch (tool.name) {
      case 'read_file': return a.path ? 'read_file(' + a.path + ')' : '';
      case 'read_lines': return a.path ? `read_lines(${a.path}:${a.start ?? '?'}-${a.end ?? '?'})` : '';
      case 'list_files': return 'list_files(' + (a.path || '.') + ')';
      case 'search_files': return a.query ? `search_files("${a.query.slice(0, 40)}")` : '';
      case 'search_codebase': return a.query ? `search_codebase("${a.query.slice(0, 40)}")` : '';
      case 'find_relevant_files': return a.query ? `find_relevant_files("${a.query.slice(0, 40)}")` : '';
      case 'search_docs': return a.query ? `search_docs("${a.query.slice(0, 40)}")` : '';
      case 'activate_skill': return a.name ? `activate_skill(${a.name}${a.file ? ':' + a.file : ''})` : '';
      case 'web_search': return a.query ? `web_search("${a.query.slice(0, 40)}")` : '';
      case 'find_symbol': return a.name ? 'find_symbol(' + a.name + ')' : '';
      case 'find_references': return a.name ? 'find_references(' + a.name + ')' : '';
      case 'git_blame': return a.path ? 'git_blame(' + a.path + ')' : '';
      case 'git_status': return 'git_status()';
      case 'git_diff': return 'git_diff()';
      case 'git_log': return 'git_log()';
      default: return tool.name + '()';
    }
  }

  // Renders a past turn's tool activity (see the taskChanges tracker in
  // _askNavyTurn / the `meta` attached to each persisted assistant message)
  // as a short, model-facing note — NEVER shown in the chat UI (main.js only
  // reads meta.files/deleted/commands for its own display, and ignores
  // reads/commandLog entirely). Without this, replaying history for a new
  // turn only carries each past turn's final reply TEXT (see the "for (const
  // item of this.messages)" loop in askNavy) — so the model has no way to
  // know it already read a file or ran a command two turns ago unless it
  // happened to mention that in prose, and routinely re-did work it had
  // already done. This gives it a compact, verifiable record instead.
  // Every past turn's real tool activity, numbered, as ONE block for the
  // system prompt. Built from the same per-turn meta the tests pin, and
  // deliberately placed outside the conversation itself: as an assistant-role
  // suffix this record taught the model to end its replies with a bracketed
  // activity list of its own — invented, since it was writing prose rather
  // than reading a tool result — which is how a turn that changed nothing
  // still claimed to have written files.
  _historyLedger() {
    const lines = [];
    let turn = 0;
    for (const item of this.messages) {
      if (item.role !== 'assistant') continue;
      turn++;
      const parts = this._turnLedgerParts(item.meta);
      if (parts) lines.push('- Turn ' + turn + ': ' + parts);
    }
    return lines.join('\n');
  }

  // The bare description of one turn's tool activity: "read a.js; wrote b.js".
  // Shared by _historyLedger, which is the only consumer — it exists as its own
  // function because the per-turn shape is what the tests pin and what any
  // future per-turn use would want.
  _turnLedgerParts(meta) {
    if (!meta) return '';
    const parts = [];
    if (meta.reads?.length) parts.push('read ' + meta.reads.join(', '));
    if (meta.files?.length) parts.push('wrote ' + meta.files.join(', '));
    if (meta.deleted?.length) parts.push('deleted ' + meta.deleted.join(', '));
    if (meta.commandLog?.length) {
      parts.push('ran ' + meta.commandLog.map(c => '"' + c.cmd + '"' + (c.exit === 0 ? ' (exit 0)' : ' (exit ' + c.exit + ')')).join(', '));
    }
    return parts.join('; ');
  }

  // Sums token usage (and estimated cost) across every PERSISTED turn of the
  // active chat — not a separately-maintained running counter, so it's
  // automatically correct after Clear (this.messages is empty → 0), after
  // restoring an old chat (recomputed straight from its saved meta.tokens),
  // and after switching tabs (each session's own messages, never mixed with
  // a sibling's). Cost is computed PER TURN using that turn's OWN provider
  // and model (meta.provider/meta.model) — a session can span a provider or
  // model switch, and pricing an earlier turn at whatever's CURRENTLY
  // configured would silently misreport it (e.g. an old paid-API turn
  // reading as free just because you've since switched to local Ollama).
  // costKnown is false whenever at least one priced turn's model isn't in
  // MODEL_PRICING, so the caller can show "≈$X+" instead of a number that
  // looks exact but is actually missing part of the total.
  _sessionUsage() {
    let prompt = 0, completion = 0, cost = 0, costKnown = true;
    for (const m of this.messages) {
      const t = m.meta?.tokens;
      if (!t) continue;
      prompt += t.prompt || 0;
      completion += t.completion || 0;
      const c = estimateCost(m.meta.provider, m.meta.model, t.prompt || 0, t.completion || 0, this._modelPricingOverrides());
      if (c === null) costKnown = false; else cost += c;
    }
    return { prompt, completion, cost, costKnown };
  }

  // What one character of THIS conversation actually costs in tokens.
  //
  // CHARS_PER_TOKEN is 4 — the English-prose figure. Code tokenizes nearer
  // 3–3.5, CJK far lower, base64 and minified JS lower still, so a fixed 4
  // over-states how much text fits and CONTEXT_FILL has been quietly absorbing
  // the error for every language that is not English prose.
  //
  // The provider already tells us the true prompt-token count on every call.
  // The trap is that it counts things the message array does not contain — the
  // tool schemas (~36 of them), and whatever the provider adds itself — so
  // dividing total chars by total tokens measures that fixed overhead as much
  // as it measures the text.
  //
  // Taking the DELTA between two consecutive calls in the same turn cancels the
  // overhead exactly: the schemas and the system prompt are byte-identical
  // between iterations, so whatever grew is only the conversation.
  //
  //     chars-per-token ≈ (chars[i+1] - chars[i]) / (tokens[i+1] - tokens[i])
  //
  // Samples that cannot mean anything are dropped rather than smoothed: a
  // shrinking prompt (compaction just ran), a non-positive token delta, or a
  // change too small to survive integer rounding. Prompt caching does not
  // distort this — a cache hit changes what is BILLED, not what is counted.
  _observeTokenRatio(chars, promptTokens) {
    const prev = this._cptSample;
    this._cptSample = { chars, promptTokens };
    if (!prev) return;
    const dChars = chars - prev.chars;
    const dTokens = promptTokens - prev.promptTokens;
    if (dChars < CPT_MIN_DELTA_CHARS || dTokens <= 0) return;
    const observed = dChars / dTokens;
    if (!Number.isFinite(observed)) return;
    const clamped = Math.min(Math.max(observed, CHARS_PER_TOKEN_MIN), CHARS_PER_TOKEN_MAX);
    const current = this.charsPerToken || CHARS_PER_TOKEN;
    this.charsPerToken = current + (clamped - current) * CPT_SMOOTHING;
  }

  // The ratio the budget is currently derived from — the learned one once this
  // conversation has produced a usable sample, the English-prose default until
  // then, so a first turn behaves exactly as it always did.
  _charsPerToken() {
    return this.charsPerToken || CHARS_PER_TOKEN;
  }

  // Mid-turn context compaction: when the accumulated conversation gets too large,
  // replace the OLDEST tool results with a stub so long agent tasks don't blow the
  // model's context window. Messages are edited in place (never removed) so
  // tool_use/tool_result pairing stays intact for providers that require it.
  _compactMessages(messages) {
    const MAX_CHARS = this._contextCharCaps().compact; // scales with the active model's window
    const KEEP_RECENT = 6;      // never touch the N most recent tool results
    const KEEP_RECENT_ASSISTANT = 3; // ditto for the model's own recent reasoning
    const sizeOf = (m) => typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
    let total = assembledCharSize(messages);
    if (total <= MAX_CHARS) return;

    // Pasted images dominate the budget (megabytes of base64) — once we're over,
    // strip image blocks from all but the LAST vision message, keeping its text.
    const visionIdxs = messages
      .map((m, i) => Array.isArray(m.content) ? i : -1)
      .filter(i => i !== -1);
    for (const idx of visionIdxs.slice(0, -1)) {
      const m = messages[idx];
      const before = sizeOf(m);
      const texts = m.content.filter(p => p.type === 'text').map(p => p.text);
      m.content = texts.join('\n') + '\n[Image(s) removed from context to stay within the window.]';
      total -= before - sizeOf(m);
    }
    if (total <= MAX_CHARS) return;

    const toolIdxs = [];
    messages.forEach((m, i) => {
      if (m.role === 'tool') toolIdxs.push(i);
      else if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<tool_result')) toolIdxs.push(i);
    });

    const prunable = toolIdxs.slice(0, Math.max(0, toolIdxs.length - KEEP_RECENT));
    for (const idx of prunable) {
      if (total <= MAX_CHARS) break;
      const m = messages[idx];
      const before = sizeOf(m);
      if (before < 300) continue; // already small — pruning gains nothing
      const note = '[Old tool output pruned to keep the conversation within the context window. Re-run the tool if you need this data again.]';
      m.content = m.role === 'tool' ? note : `<tool_result name="pruned">\n${note}\n</tool_result>`;
      total -= before - sizeOf(m);
    }
    if (total <= MAX_CHARS) return;

    // Tool output is gone and it still does not fit. What is left is the
    // model's OWN accumulated text: a turn is allowed up to maxToolIterations
    // (100 by default) model calls, and every one of them can leave a paragraph
    // of reasoning behind. Nothing used to bound that — the compactor pruned
    // tool results and then had nothing else it was willing to touch, so a
    // single long turn could walk into the ceiling with no way back.
    //
    // Only the TEXT is trimmed, never tool_calls: those pair with the
    // tool_result messages that follow them, and dropping one strands the
    // other on every provider that validates the pairing.
    //
    // Messages carrying _rawBlocks are skipped deliberately. That field is the
    // verbatim Anthropic thinking/tool_use or Gemini thought/functionCall
    // payload, replayed exactly because those providers require it; trimming
    // .content would not shrink what is actually sent for them, and dropping
    // the blocks to make it shrink risks the signature errors the field exists
    // to prevent. Those providers keep the tool-result pruning above, and
    // prompt caching blunts the rest.
    const assistantIdxs = [];
    messages.forEach((m, i) => { if (m.role === 'assistant' && !m._rawBlocks) assistantIdxs.push(i); });
    const trimmable = assistantIdxs.slice(0, Math.max(0, assistantIdxs.length - KEEP_RECENT_ASSISTANT));
    for (const idx of trimmable) {
      if (total <= MAX_CHARS) break;
      const m = messages[idx];
      if (typeof m.content !== 'string') continue;
      const before = sizeOf(m);
      if (before < 400) continue; // already small — trimming gains nothing
      // Keep the opening sentence or so: it is usually the model stating what
      // it is about to do, which is the part a later step actually refers back
      // to. The rest is working-out that the tool results already record.
      m.content = m.content.slice(0, 200).trimEnd()
        + '\n[…earlier reasoning trimmed to stay within the context window.]';
      total -= before - sizeOf(m);
    }
  }

  // Promise-chain mutex: file-mutating tools from the main turn and background
  // tasks (/bg) run concurrently — without this they could interleave writes to
  // the same file. Read tools stay unserialized.
  _withWriteLock(fn) {
    const run = this._writeLock.then(fn, fn);
    this._writeLock = run.catch(() => {});
    return run;
  }

  // Detects a model claiming it completed a file action (created/saved/written/
  // updated/fixed a file, script, function...) in plain text with NO tool call
  // having been made. Weak/local models that can't reliably emit tool calls fall
  // back to normal chat behavior — print code, narrate success — and Navy would
  // otherwise trust that narration verbatim. Pure, so it's directly testable.
  // Deliberately requires a creation/change VERB near a file-ish NOUN (not just
  // the word "done") to avoid false positives on ordinary explanations.
  // Does this reply's structured task report NAME files as changed? Rule 8 in
  // TOOL_PROMPT asks for a `**Changed:**` line listing what the turn touched,
  // and "No files changed" is its documented form for a turn that touched
  // nothing — so anything else on that line is a claim about this turn's work,
  // checkable against what Navy actually observed. Pure + testable.
  _claimsFilesChanged(text) {
    if (!text) return false;
    const m = /(?:^|\n)\s*(?:\*\*)?Changed:?(?:\*\*)?\s*([^\n]*)/i.exec(text);
    if (!m) return false;
    const claim = m[1].trim().replace(/[`*_]/g, '');
    if (!claim) return false;
    // The documented ways of saying "nothing".
    if (/^(?:none|nothing|no files? changed|no|n\/a|-+)$/i.test(claim)) return false;
    // Must actually name something file-shaped, so prose like "Changed: the
    // behaviour of the retry loop" is not read as a file claim.
    return /[\w-]+\.[a-zA-Z0-9]{1,6}(?![\w])/.test(claim);
  }

  _looksLikeFalseCompletionClaim(text) {
    if (!text || !text.trim()) return false;
    const verb = 'creat(?:ed|e)|written|wrote|writing|sav(?:ed|e)|add(?:ed)?|updat(?:ed|e)|modif(?:ied|y)|fix(?:ed)?|implement(?:ed)?|generat(?:ed|e)|appl(?:ied|y)|edit(?:ed|s)?|chang(?:ed|e)';
    // Generic nouns PLUS an actual filename pattern (hello.py, config.json, …) —
    // real replies often name the file, not the word "file" itself.
    const filename = '\\w[\\w-]*\\.[a-zA-Z0-9]{1,5}';
    const noun = '(?:file|script|function|class|module|component|program|' + filename + ')';
    // The gap allows periods (filenames contain them) but is capped short and
    // newline-free so it can't bridge two unrelated sentences.
    const gap = '[^\\n]{0,40}';
    const re1 = new RegExp('\\b(?:' + verb + ')\\b' + gap + noun, 'i');
    const re2 = new RegExp(noun + gap + '\\b(?:has been|is now|was)?\\s*(?:' + verb + ')\\b', 'i');
    // Narrative/structured "I'm done" phrasing doesn't always sit on the same
    // line as a filename — a fabricated "File Edit Summary" block can put the
    // heading on one line and "...has been successfully updated" several lines
    // later, which re1/re2 (newline-free gap) can never bridge. This call only
    // ever runs when NO tool was used this turn, so any claim of completion —
    // regardless of what noun it's near — is inherently suspicious here.
    const re3 = /\b(?:(?:has|have)\s+been|i'?ve|successfully)\s+(?:successfully\s+)?(?:updated|changed|modified|created|fixed|applied|edited|saved|written)\b/i;
    return re1.test(text) || re2.test(text) || re3.test(text);
  }

  // Gate for the hallucination guard: only worth checking a response for a false
  // completion claim if the user's ORIGINAL request actually asked for a file to
  // be created/changed. Without this gate, a purely informational reply that
  // happens to mention "the file was updated" (e.g. describing git history, or
  // answering "did this file change recently") could misfire. Pure + testable.
  // Heuristic: does this model NAME suggest it's a small/weak model that's more
  // likely to hallucinate tool use? No provider exposes real capability info, so
  // this is name-pattern matching only — false positives just mean a capable
  // model gets a harmless extra reminder; false negatives mean a weak model
  // doesn't get the reinforcement (the base guard in askNavy still catches it).
  _isLikelySmallModel(model) {
    const m = String(model || '').toLowerCase();
    if (/\b(mini|tiny|nano|micro)\b/.test(m)) return true;
    const paramMatch = m.match(/[:\-_](\d+(?:\.\d+)?)b\b/);
    return Boolean(paramMatch && parseFloat(paramMatch[1]) <= 9);
  }

  // Whether this turn should offer the model the reduced core tool set instead
  // of all of TOOLS_API (see tools.js for what the core is and why). Decided
  // once per turn: the full schemas cost thousands of tokens per request and
  // measurably worsen tool choice on small models, and the model can widen the
  // set itself mid-turn via request_more_tools. 'auto' applies it only to LOCAL
  // providers (local Ollama, LM Studio) — hosted "mini"-named models have big
  // windows and handle wide tool lists fine, and Ollama Cloud runs models too
  // large to fit locally — and only when the model's name suggests ≤9B params
  // or its effective window is genuinely small. Never a permission boundary:
  // executeTool doesn't check the tier, so a withheld tool that somehow gets
  // called still runs (through the same approval gate as always).
  _shouldReduceTools(model) {
    const config = vscode.workspace.getConfiguration('navy');
    const mode = config.get('reducedToolset', 'auto');
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    const provider = config.get('provider', 'ollama');
    const isLocal = provider === 'lmstudio' ||
      (provider === 'ollama' && config.get('ollamaMode', 'local') === 'local');
    if (!isLocal) return false;
    const ctx = this.modelContextLength || this.modelContextMax;
    return this._isLikelySmallModel(model) ||
      (Number.isFinite(ctx) && ctx > 0 && ctx <= 16384);
  }

  _promptRequestsFileAction(prompt) {
    if (!prompt) return false;
    // Broad by design: any directive/action verb in a coding-assistant prompt is
    // presumptively about the code/file the user has open. Requiring a specific
    // noun (file/script/function/…) to follow it — the previous approach — is a
    // closed keyword list that misses everyday phrasing like "edit the hello
    // world to hello job!" (names WHAT to change, not the word "file"). A false
    // positive here only costs one harmless internal nudge; a false negative
    // lets a fabricated "it's done" claim reach the user unchecked.
    return /\b(write|create|generate|make|add|implement|build|fix|edit|update|modify|refactor|rewrite|change|save|apply|delete|remove|rename)\b/i.test(prompt);
  }

  // Normalize native tool calls to the exact OpenAI shape before they go into the
  // assistant message / tool results:
  //  • unique non-empty id — Cohere/others via OpenRouter return empty or duplicate
  //    ids, which breaks tool_call↔tool_result pairing ("id ... not found").
  //  • type: "function" — required by strict deserializers (DeepSeek 400s with
  //    "missing field `type`"); OpenAI/Groq/Ollama tolerate its absence.
  // Mutates in place so the assistant message and derived tool results stay in sync.
  _normalizeToolCallIds(nativeToolCalls) {
    const seen = new Set();
    for (const tc of nativeToolCalls || []) {
      if (!tc.id || seen.has(tc.id)) {
        tc.id = ((tc.function && tc.function.name) || 'tool') + '_' + this.generateId();
      }
      seen.add(tc.id);
      if (!tc.type) tc.type = 'function';
    }
    return nativeToolCalls;
  }

  async executeTool(tool, turnIdOverride) {
    const MUTATING = new Set(['write_file', 'apply_edit', 'edit_line', 'delete_line',
      'insert_after_line', 'delete_file', 'rename_file', 'rename_symbol']);
    if (MUTATING.has(tool.name)) {
      // Inside the mutex only one mutating tool runs at a time, so this field is
      // safe to set/restore around it — lets background-task edits carry their own
      // turnId instead of folding into the main turn's Undo Last Turn grouping.
      return await this._withWriteLock(async () => {
        const prev = this._checkpointTurnId;
        this._checkpointTurnId = turnIdOverride || this.currentTurnId;
        try { return await this._executeToolInner(tool); }
        finally { this._checkpointTurnId = prev; }
      });
    }
    return await this._executeToolInner(tool);
  }

  // (Re)connect MCP servers from navy.mcpServers. Non-fatal: a bad server is
  // reported in the status bar tooltip-ish message, never breaks Navy.
  async reloadMcpServers() {
    try {
      const config = vscode.workspace.getConfiguration('navy').get('mcpServers', {});
      if (!config || !Object.keys(config).length) { this.mcp.stop(); return; }
      // MCP servers are launched as local processes (or given the project's
      // network context) — never start them for a folder the user hasn't trusted.
      if (!workspaceIsTrusted()) {
        this.mcp.stop();
        this.log?.('MCP servers not started: workspace is not trusted');
        return;
      }
      const results = await this.mcp.start(config);
      const ok = results.filter(r => !r.error);
      const bad = results.filter(r => r.error);
      if (ok.length) {
        vscode.window.setStatusBarMessage(`Navy: ${this.mcp.toolCount} MCP tool${this.mcp.toolCount !== 1 ? 's' : ''} from ${ok.map(r => r.name).join(', ')}`, 8000);
      }
      for (const b of bad) {
        vscode.window.showWarningMessage(`Navy: MCP server "${b.name}" failed to start — ${b.error}`);
      }
    } catch (e) {
      this.log?.('MCP reload failed: ' + e.message);
    }
  }

  // Validate/coerce args against the tool's own schema (from tools.js) so a
  // model passing garbage gets a clear, actionable message instead of a Node
  // internals error like `The "path" argument must be of type string`.
  _validateToolArgs(tool) {
    const def = TOOLS.find(t => t.name === tool.name);
    if (!def) return null;
    const props = def.parameters?.properties || {};
    const required = def.parameters?.required || [];
    const args = tool.args || {};
    for (const r of required) {
      if (args[r] === undefined || args[r] === null) {
        return `Error: required parameter "${r}" is missing for ${tool.name}. Re-emit the call with all required parameters: ${required.join(', ')}.`;
      }
    }
    for (const [k, v] of Object.entries(args)) {
      const p = props[k];
      if (!p || v === undefined || v === null) continue;
      if (p.type === 'string' && typeof v !== 'string') {
        if (typeof v === 'number' || typeof v === 'boolean') args[k] = String(v);
        else return `Error: parameter "${k}" of ${tool.name} must be a string, got ${Array.isArray(v) ? 'array' : typeof v}.`;
      } else if (p.type === 'number' && typeof v !== 'number') {
        const n = Number(v);
        if (Number.isFinite(n)) args[k] = n;
        else return `Error: parameter "${k}" of ${tool.name} must be a number, got "${String(v).slice(0, 40)}".`;
      }
    }
    return null;
  }

  async _executeToolInner(tool) {
    try {
      const invalid = this._validateToolArgs(tool);
      if (invalid) return invalid;
      // External MCP tools: approval-gated in ask mode (their side effects are
      // unknown to Navy), then routed to the owning server.
      if (this.mcp?.isMcpTool(tool.name)) {
        if (!this._commandsAutoApproved()) {
          const id = this.generateId();
          const label = tool.name.replace(/^mcp__/, '').replace(/__/, ' → ');
          this.view?.webview.postMessage({
            type: 'pendingCommand', id,
            command: `MCP: ${label}(${JSON.stringify(tool.args || {}).slice(0, 300)})`,
          });
          const approved = await new Promise((resolve) => {
            this.pendingCommandApprovals.set(id, { resolve });
          });
          if (!approved) return 'MCP call rejected by user.';
        }
        return await this.mcp.call(tool.name, tool.args);
      }
      switch (tool.name) {
        case 'read_file': return await this.toolReadFile(tool.args.path);
        case 'remember': return await this.toolRemember(tool.args.fact);
        case 'forget': return await this.toolForget(tool.args.query);
        case 'read_lines': return await this.toolReadLines(tool.args.path, tool.args.start, tool.args.end);
        case 'write_file': return await this.toolWriteFile(tool.args.path, tool.args.content);
        case 'delete_file': return await this.toolDeleteFile(tool.args.path);
        case 'rename_file': return await this.toolRenameFile(tool.args.from, tool.args.to);
        case 'rename_symbol': return await this.toolRenameSymbol(tool.args.path, tool.args.line, tool.args.name, tool.args.newName);
        case 'list_files': return await this.toolListFiles(tool.args.path, tool.args.maxDepth, tool.args.folder);
        case 'search_files': return await this.toolSearchFiles(tool.args.query, tool.args.folder);
        case 'apply_edit': return await this.toolApplyEdit(tool.args.path, tool.args.search, tool.args.replace);
        case 'edit_line': return await this.toolEditLine(tool.args.path, tool.args.line, tool.args.content);
        case 'delete_line': return await this.toolDeleteLine(tool.args.path, tool.args.line);
        case 'insert_after_line': return await this.toolInsertAfterLine(tool.args.path, tool.args.line, tool.args.content);
        case 'run_command': return await this.toolRunCommand(tool.args.command, tool.args.timeout, tool.id);
        case 'run_project': return await this.toolRunProject(tool.args.command);
        case 'start_process': return await this.toolStartProcess(tool.args.id, tool.args.command);
        case 'read_process_output': return await this.toolReadProcessOutput(tool.args.id, tool.args.clear);
        case 'kill_process': return await this.toolKillProcess(tool.args.id);
        case 'git_blame': return await this.toolGitBlame(tool.args.path, tool.args.startLine, tool.args.endLine);
        case 'find_symbol': return await this.toolFindSymbol(tool.args.name);
        case 'find_references': return await this.toolFindReferences(tool.args.name);
        case 'web_search': return await this.toolWebSearch(tool.args.query, tool.args.maxResults);
        case 'delegate_research': return await this.toolDelegateResearch(tool.args.task, tool.args.maxSteps);
        case 'update_plan': return await this.toolUpdatePlan(tool.args.steps);
        case 'git_status': return await this.toolGitStatus();
        case 'git_diff': return await this.toolGitDiff(tool.args.path, tool.args.staged);
        case 'git_log': return await this.toolGitLog(tool.args.count);
        case 'get_diagnostics': return await this.toolGetDiagnostics(tool.args.path);
        case 'check_syntax': return await this.toolCheckSyntax(tool.args.path);
        case 'fetch_url': return await this.toolFetchUrl(tool.args.url);
        case 'get_terminal_output': return await this.toolGetTerminalOutput(tool.args.lines);
        case 'run_tests': return await this.toolRunTests(tool.args.filter, tool.id);
        case 'search_codebase': return await this.toolSearchCodebase(tool.args.query, tool.args.filePattern, tool.args.contextLines, tool.args.folder);
        case 'search_docs': return await this.toolSearchDocs(tool.args.query, tool.args.maxResults);
        case 'find_relevant_files': return await this.toolFindRelevantFiles(tool.args.query, tool.args.maxResults, tool.args.folder);
        case 'activate_skill': return await this.toolActivateSkill(tool.args);
        case '__parse_error__':
          return 'Tool call JSON was invalid and could not be parsed. Tool attempted: ' + tool.args.tool + '. Error: ' + tool.args.error + '. Please re-emit the tool block with valid JSON.';
        default: return 'Unknown tool: ' + tool.name;
      }
    } catch (error) {
      return 'Error: ' + error.message;
    }
  }

  // After a successful write, fetch fresh LSP diagnostics for the file so the model
  // immediately sees any errors its edit introduced — no need for it to remember to check.
  async _diagnosticsAfterWrite(inputPath) {
    try {
      const filePath = this.resolveWorkspacePath(inputPath);
      // Give the language server a moment to re-analyze the new content.
      await new Promise(r => setTimeout(r, 900));
      const diags = vscode.languages.getDiagnostics(vscode.Uri.file(filePath))
        .filter(d => d.severity === 0 || d.severity === 1); // errors + warnings only
      if (diags.length) {
        const lines = diags.slice(0, 10).map(d => {
          const sev = d.severity === 0 ? 'Error' : 'Warning';
          return `[${sev}] line ${d.range.start.line + 1}: ${d.message}`;
        });
        const more = diags.length > 10 ? `\n…and ${diags.length - 10} more` : '';
        return `\n\n[POST-EDIT DIAGNOSTICS for ${path.basename(filePath)} — fix any Errors before finishing:]\n${lines.join('\n')}${more}`;
      }

      // No LSP diagnostics is NOT proof the file is fine — it usually means the
      // user has no language extension installed for this file type (or the
      // server hasn't analyzed a file that was never opened). Fall back to a
      // real parser so a syntactically broken file can't sail through as clean.
      const verdict = await this._syntaxVerdictAfterWrite(filePath);
      if (verdict) return verdict;
      return '';
    } catch { return ''; }
  }

  // Post-write syntax fallback. Only runs the CHEAP, always-available checkers
  // (JSON parse, node --check) — shelling out to an external toolchain after
  // every single edit would add seconds of latency to the agent loop, so those
  // stay opt-in via the check_syntax tool. Returns '' when there's nothing
  // useful to say, so a clean edit stays quiet.
  async _syntaxVerdictAfterWrite(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    // Checked inline after every write: cheap, no external process.
    const CHEAP = ['.json', '.js', '.jsx', '.mjs', '.cjs'];
    // Has a real checker, but it costs a process spawn — too slow to run after
    // every edit, so the model is nudged to call check_syntax itself instead.
    const CHECKABLE_ON_DEMAND = ['.py', '.rb', '.php', '.go'];
    const base = path.basename(filePath);

    if (CHEAP.includes(ext)) {
      const result = await this.toolCheckSyntax(filePath);
      if (typeof result === 'string' && result.startsWith('SYNTAX ERROR')) {
        return `\n\n[POST-EDIT SYNTAX CHECK FAILED for ${base} — you broke this file, fix it before finishing:]\n${result}`;
      }
      return ''; // verified valid — stay quiet, the edit is fine
    }

    if (CHECKABLE_ON_DEMAND.includes(ext)) {
      return `\n\n[NOT AUTO-VERIFIED: no language extension reported diagnostics for ${base}. Navy can check "${ext}" on demand — if this edit could have broken syntax, call check_syntax on it before finishing.]`;
    }

    // Everything else (.md, .css, .html, .txt, …): there is no checker to call,
    // so telling the model to call one just burned an iteration to be told
    // "COULD NOT VERIFY". Say nothing rather than send it on an errand that
    // cannot succeed — a markdown file has no syntax to break.
    return '';
  }

  // Resolves paths to absolute and enforces workspace containment to prevent
  // prompt-injection attacks that try to read/write files outside the project.
  // Multi-root aware: VS Code natively supports several folders open in one
  // workspace at once, so a tool call targeting an absolute path inside a
  // SIBLING open folder (not just the active projectRoot) is legitimate, not
  // a traversal attempt. Only projectRoot resolves a RELATIVE path (one
  // unambiguous base is still required for that), but containment is checked
  // against every currently-open folder.
  resolveWorkspacePath(inputPath) {
    const openFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    // In single-file mode (no folder open at all) the directory of whatever
    // file is on screen is a legitimate root — that is the ONLY thing the user
    // has given Navy to work with. It is added only when no folder is open, so
    // it can never widen containment for a real workspace.
    const looseDir = openFolders.length === 0 ? this._activeFileDir() : '';
    const root = this.projectRoot || openFolders[0] || looseDir;
    if (!root) throw new Error('No project root — open a file or a folder before using file tools');

    const candidate = path.isAbsolute(inputPath) ? inputPath : path.join(root, inputPath);
    // Windows paths are case-insensitive — compare case-folded there so "c:\my project\…"
    // isn't falsely rejected against a root of "C:\My Project". Containment is unaffected.
    const allRoots = [root, ...openFolders, looseDir].filter(Boolean);
    const normalRoots = [...new Set(allRoots.map(foldPath))];
    const normalCandidate = foldPath(candidate);
    const isUnder = (r) => normalCandidate === r || normalCandidate.startsWith(r + path.sep);
    if (!normalRoots.some(isUnder)) {
      throw new Error(`Path is outside the ${looseDir ? "open file's folder" : 'project folder'}: ${inputPath}`);
    }

    // Resolve symlinks to prevent traversal through symlinks inside the workspace
    try {
      const real = fold(fs.realpathSync(candidate));
      const realRoots = normalRoots.map(r => { try { return fold(fs.realpathSync(r)); } catch { return r; } });
      if (!realRoots.some(r => real === r || real.startsWith(r + path.sep))) {
        throw new Error('Path resolves outside the project via symlink: ' + inputPath);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // file not yet created — lexical check above is sufficient
    }

    return candidate;
  }

  // Resolves an optional `folder` argument (search_codebase/search_files/
  // find_relevant_files) against the currently open workspace folders — lets
  // a multi-root workspace target a SIBLING folder explicitly instead of
  // only ever searching the active projectRoot. Matches by exact path or by
  // folder name (case-insensitive on Windows), since the model may have only
  // seen the short name via buildRepoMap's sibling-folder hint. Returns
  // { root } on success, or { error } naming what didn't match so the caller
  // can report a clear message instead of silently using the wrong folder.
  _resolveTargetFolder(folder) {
    const fallback = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return { root: fallback };
    const wanted = fold(folder.trim());
    const folders = vscode.workspace.workspaceFolders || [];
    const match = folders.find(f => fold(f.uri.fsPath) === wanted || fold(path.basename(f.uri.fsPath)) === wanted);
    if (!match) {
      const available = folders.map(f => f.uri.fsPath).join(', ') || '(none open)';
      return { error: `"${folder}" does not match any open workspace folder. Open folders: ${available}` };
    }
    return { root: match.uri.fsPath };
  }

  async toolReadFile(inputPath) {
    const filePath = this.resolveWorkspacePath(inputPath);
    // Jupyter notebooks — extract cells and their outputs as readable text.
    if (filePath.endsWith('.ipynb')) {
      try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        const nb = JSON.parse(raw);
        const parts = [`# Jupyter Notebook: ${path.basename(filePath)}\n`];
        for (let i = 0; i < (nb.cells || []).length; i++) {
          const cell = nb.cells[i];
          const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
          const lang = nb.metadata?.kernelspec?.language || 'python';
          if (cell.cell_type === 'code') {
            parts.push(`## Cell ${i + 1} [code]\n\`\`\`${lang}\n${src}\n\`\`\``);
            for (const out of (cell.outputs || [])) {
              if (out.output_type === 'stream') {
                const t = Array.isArray(out.text) ? out.text.join('') : (out.text || '');
                if (t.trim()) parts.push(`\`\`\`\n${t.trim()}\n\`\`\``);
              } else if (out.output_type === 'execute_result' || out.output_type === 'display_data') {
                const t = out.data?.['text/plain'];
                if (t) parts.push(`\`\`\`\n${(Array.isArray(t) ? t.join('') : t).trim()}\n\`\`\``);
              } else if (out.output_type === 'error') {
                parts.push(`**Error:** ${out.ename}: ${out.evalue}`);
              }
            }
          } else if (cell.cell_type === 'markdown') {
            parts.push(`## Cell ${i + 1} [markdown]\n${src}`);
          } else {
            parts.push(`## Cell ${i + 1} [${cell.cell_type}]\n${src}`);
          }
        }
        return parts.join('\n\n');
      } catch (e) {
        return 'Error reading notebook: ' + e.message;
      }
    }
    const text = await this.readFileText(filePath);
    if (text === null) return 'Error: could not read ' + inputPath;
    const lines = text.split('\n');
    // The CHARACTER cap is the real guard — it's what actually bounds context
    // cost. The line cap only exists so a file of very long lines still gets cut
    // somewhere sensible. It used to be 500, which truncated most real source
    // files and forced the model into a multi-call chunked read just to see one
    // file; the character cap already prevented anything genuinely huge from
    // getting through, so the low line cap only cost round-trips.
    const MAX_READ_LINES = 1500;
    const MAX_READ_CHARS = 60000; // guards minified single-line files that dodge the line cap

    if (lines.length > MAX_READ_LINES || text.length > MAX_READ_CHARS) {
      let shown = lines.slice(0, MAX_READ_LINES).join('\n');
      let shownLines = Math.min(lines.length, MAX_READ_LINES);
      if (shown.length > MAX_READ_CHARS) {
        shown = shown.slice(0, MAX_READ_CHARS);
        shownLines = shown.split('\n').length; // stay accurate after a char-based cut
      }
      if (shownLines >= lines.length) return shown; // nothing actually withheld
      // Hand the model the exact next call. Left to itself it picks timid
      // 200-line windows and burns a turn per chunk; the range is spelled out
      // so continuing costs the fewest possible round-trips.
      const nextStart = shownLines + 1;
      const nextEnd = Math.min(lines.length, shownLines + MAX_READ_LINES);
      return shown
        + `\n\n[FILE TRUNCATED: showed lines 1-${shownLines} of ${lines.length}.`
        + ` To continue, call read_lines("${inputPath}", ${nextStart}, ${nextEnd}).`
        + ` Read in large ranges like that — small 100-200 line chunks waste a turn each.]`;
    }
    return text;
  }

  async toolListFiles(inputPath, maxDepth = 1, folder) {
    const target = this._resolveTargetFolder(folder);
    if (target.error) return target.error;
    if (!target.root) return 'No workspace open.';
    // `folder` only chooses which root a RELATIVE path is resolved against —
    // the result still goes through resolveWorkspacePath, so containment is
    // checked against every open folder exactly as before and this can never
    // widen what's reachable. An absolute path is passed through untouched,
    // since it already names its own root.
    const requested = inputPath || '.';
    const base = path.isAbsolute(requested) ? requested : path.join(target.root, requested);
    const dirPath = this.resolveWorkspacePath(base);
    try {
      const lines = [];
      await this._listDir(dirPath, '', maxDepth, 0, lines);
      if (lines.length > 400) {
        return lines.slice(0, 400).join('\n')
          + `\n… (${lines.length - 400} more entries — list a subdirectory or lower maxDepth)`;
      }
      return lines.join('\n') || '(empty directory)';
    } catch (error) {
      return 'Error: ' + error.message;
    }
  }

  async _listDir(dirPath, prefix, maxDepth, depth, lines) {
    // Hard stop above the 400-entry display cap — a huge directory (generated data,
    // vendored assets) must not build a million-entry array before we slice it.
    if (lines.length > 1200) return;
    const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.next', '__pycache__', '.venv']);
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (lines.length > 1200) return;
      if (entry.isDirectory()) {
        lines.push(prefix + entry.name + '/');
        if (depth < maxDepth - 1 && !SKIP.has(entry.name)) {
          await this._listDir(path.join(dirPath, entry.name), prefix + '  ', maxDepth, depth + 1, lines);
        }
      } else {
        lines.push(prefix + entry.name);
      }
    }
  }

  // Locate VS Code's bundled ripgrep so searches are fast and respect .gitignore.
  // Returns the binary path or null (then callers fall back to the JS walk).
  _findRipgrep() {
    if (this._rgPath !== undefined) return this._rgPath;
    const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const arch = `${process.platform}-${process.arch}`;
    const candidates = [
      path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
      path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
      path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep-universal', 'bin', arch, exe),
      path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', arch, exe),
    ];
    this._rgPath = candidates.find(c => { try { return fs.existsSync(c); } catch { return false; } }) || null;
    return this._rgPath;
  }

  // Run ripgrep with an output cap. Resolves { code, out } — never rejects.
  _rgRun(rgPath, args, cwd, maxOut = 60000) {
    return new Promise((resolve) => {
      const proc = spawn(rgPath, args, { cwd });
      let out = '';
      // `out` is truncated back to exactly maxOut, so without this flag the very
      // next data chunk re-trips the condition and kills again — and again, for
      // every chunk still in flight before the process actually dies. Measured
      // at ~30,000 kill attempts for a single broad search. Combined with a
      // synchronous kill that was a total editor freeze, which is why the kill
      // is now non-blocking too (see _killProcessTree).
      let killed = false;
      proc.stdout.on('data', d => {
        if (killed) return;                 // stop accumulating once we've given up
        out += d.toString();
        if (out.length > maxOut) {
          out = out.slice(0, maxOut);
          killed = true;
          this._killProcessTree(proc);
        }
      });
      proc.stderr.on('data', () => {});
      proc.on('close', code => resolve({ code: code ?? 0, out }));
      proc.on('error', () => resolve({ code: -1, out: '' }));
    });
  }

  async toolSearchFiles(query, folder) {
    const resolved = this._resolveTargetFolder(folder);
    if (resolved.error) return resolved.error;
    const root = resolved.root;
    if (!root) return 'No workspace open';
    try {
      // Fast path: bundled ripgrep — respects .gitignore, searches the whole tree.
      const rg = this._findRipgrep();
      if (rg) {
        const { code, out } = await this._rgRun(rg,
          ['--line-number', '--max-count', '1', '--fixed-strings', '--max-filesize', '512K',
           '--no-heading', '--with-filename', '--', query, '.'], root);
        if (code === 0) {
          const lines = out.split('\n').filter(Boolean).slice(0, 20)
            .map(l => l.replace(/^\.[\\/]/, '').replace(/:(\d+):/, ':$1 '));
          if (lines.length) return lines.join('\n');
        }
        if (code === 1) return 'No matches';
        // code 2 / -1 → rg failed, fall through to the JS walk
      }
      const results = [];
      await this.searchDirectory(root, query, results, 0, root);
      return results.slice(0, 20).join('\n') || 'No matches';
    } catch (error) {
      return 'Error: ' + error.message;
    }
  }

  async searchDirectory(dir, query, results, depth, root) {
    if (depth > 2) return;
    if (results.length >= 20) return; // caller shows 20 — stop reading files past that
    const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '__pycache__', '.venv']);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= 20) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) {
          await this.searchDirectory(full, query, results, depth + 1, root);
        }
      } else {
        try {
          const stat = await fs.promises.stat(full);
          if (stat.size > 512 * 1024) continue; // skip files larger than 512 KB
          const text = await fs.promises.readFile(full, 'utf8');
          if (text.includes(query)) {
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(query)) {
                results.push(path.relative(root, full) + ':' + (i + 1) + ' ' + lines[i].trim());
                break;
              }
            }
          }
        } catch {}
      }
    }
  }

  async toolReadLines(inputPath, start, end) {
    const filePath = this.resolveWorkspacePath(inputPath);
    const text = await this.readFileText(filePath);
    if (text === null) return 'Error: could not read file: ' + inputPath;
    const lines = text.split('\n');
    const s = Math.max(1, start || 1);
    const e = end ? Math.min(end, lines.length) : lines.length;
    if (s > lines.length) return `File only has ${lines.length} lines.`;
    return lines.slice(s - 1, e)
      .map((l, i) => `${s + i}: ${l}`)
      .join('\n');
  }

  async toolWriteFile(inputPath, content) {
    const filePath = this.resolveWorkspacePath(inputPath);
    const existingText = await this.readFileText(filePath) || '';
    return await this.requestWriteApproval(inputPath, filePath, existingText, content);
  }

  async toolDeleteFile(inputPath) {
    const filePath = this.resolveWorkspacePath(inputPath);
    const basename = path.basename(filePath);
    if (!this._editsAutoApproved()) {
      // Modal dialogs add their own Cancel button — only pass the confirm action.
      const choice = await vscode.window.showWarningMessage(
        `Navy wants to delete ${basename}. It will be moved to the Recycle Bin.`,
        { modal: true },
        'Delete'
      );
      if (choice !== 'Delete') return `Deletion of ${basename} cancelled by user.`;
    }
    try {
      // Snapshot single files (≤5 MB) before deleting so Undo can restore them.
      // Directories aren't snapshotted — the Recycle Bin covers those.
      let snapshot = null;
      try {
        const st = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
        if (st.type === vscode.FileType.File && st.size <= 5_000_000) {
          snapshot = await this.readFileText(filePath);
        }
      } catch {}
      await vscode.workspace.fs.delete(vscode.Uri.file(filePath), { recursive: true, useTrash: true });
      if (snapshot !== null) this._pushCheckpoint({ kind: 'delete', filePath, originalText: snapshot });
      return `Deleted ${basename} (moved to Recycle Bin${snapshot !== null ? '; Undo can restore it' : ''}).`;
    } catch (e) {
      return `Error deleting ${basename}: ${e.message}`;
    }
  }

  async toolRenameFile(fromPath, toPath) {
    if (!fromPath || !toPath) return 'Error: both from and to paths are required.';
    // Both ends must stay inside the workspace — a rename is a read at `from`
    // plus a write at `to`, so it gets the same containment rules as each.
    const src = this.resolveWorkspacePath(fromPath);
    const dst = this.resolveWorkspacePath(toPath);
    const fromName = path.basename(src);
    if (!this._editsAutoApproved()) {
      const choice = await vscode.window.showWarningMessage(
        `Navy wants to rename ${fromName} → ${toPath}`,
        { modal: true },
        'Rename'
      );
      if (choice !== 'Rename') return `Rename of ${fromName} cancelled by user.`;
    }
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(dst)));
      await vscode.workspace.fs.rename(vscode.Uri.file(src), vscode.Uri.file(dst), { overwrite: false });
      this._pushCheckpoint({ kind: 'rename', from: src, to: dst });
      return `Renamed ${fromPath} → ${toPath}`;
    } catch (e) {
      return `Error renaming ${fromName}: ${e.message}`;
    }
  }

  // Structural, workspace-wide rename via the language server. Updates every
  // reference correctly (unlike text replace) and records an undo checkpoint per
  // affected file so the whole rename is reversible as one turn.
  async toolRenameSymbol(inputPath, line, name, newName) {
    if (!inputPath || !line || !name || !newName) {
      return 'Error: path, line, name, and newName are all required.';
    }
    const filePath = this.resolveWorkspacePath(inputPath);
    const text = await this.readFileText(filePath);
    if (text === null) return 'Error: could not read ' + inputPath;
    const lines = text.split('\n');
    const idx = line - 1;
    if (idx < 0 || idx >= lines.length) return `Error: line ${line} is out of range (file has ${lines.length} lines).`;
    const col = lines[idx].indexOf(name);
    if (col === -1) return `Error: "${name}" not found on line ${line} of ${path.basename(filePath)}. Read the file to confirm the exact line and spelling.`;

    const uri = vscode.Uri.file(filePath);
    try {
      await vscode.workspace.openTextDocument(uri); // ensure the LS has indexed it
      const position = new vscode.Position(idx, col + 1);
      const edit = await vscode.commands.executeCommand(
        'vscode.executeDocumentRenameProvider', uri, position, newName
      );
      const entries = edit && typeof edit.entries === 'function' ? edit.entries() : [];
      if (!entries.length) {
        return `The language server could not rename "${name}" (no rename provider for this file type, or the symbol isn't renameable). Fall back to apply_edit / search_codebase.`;
      }

      // Containment: every other write tool refuses to touch files outside the
      // workspace, but these edit targets come straight from the language server
      // (could include SDK stubs / linked files). If ANY is outside the root,
      // refuse the whole rename — never partially apply or edit outside the project.
      const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (root) {
        const nRoot = foldPath(root);
        const outside = entries
          .map(([u]) => u.fsPath)
          .filter(fp => { const n = foldPath(fp); return n !== nRoot && !n.startsWith(nRoot + path.sep); });
        if (outside.length) {
          return `Refused: renaming "${name}" would also modify ${outside.length} file(s) OUTSIDE the workspace (e.g. ${path.basename(outside[0])}). Navy only edits files inside the project. Use apply_edit for an in-project-only change if that's what you intended.`;
        }
      }

      if (!this._editsAutoApproved()) {
        const choice = await vscode.window.showWarningMessage(
          `Navy wants to rename "${name}" → "${newName}" across ${entries.length} file${entries.length !== 1 ? 's' : ''} (structural, all references).`,
          { modal: true }, 'Rename'
        );
        if (choice !== 'Rename') return `Rename of "${name}" cancelled by user.`;
      }

      // Snapshot every affected file BEFORE applying, but only record checkpoints
      // AFTER the edit succeeds — a rejected edit must not pollute undo history
      // with entries for files that never changed.
      const snapshots = [];
      for (const [fileUri] of entries) {
        const original = await this.readFileText(fileUri.fsPath);
        if (original !== null) snapshots.push({ filePath: fileUri.fsPath, original });
      }
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) return `Error: the workspace edit for renaming "${name}" was rejected.`;
      for (const s of snapshots) {
        this._pushCheckpoint({ kind: 'edit', filePath: s.filePath, originalText: s.original });
      }
      const affected = snapshots.map(s => s.filePath);
      const names = affected.map(f => path.basename(f));
      return `Renamed "${name}" → "${newName}" across ${affected.length} file${affected.length !== 1 ? 's' : ''}: ${names.join(', ')}`;
    } catch (e) {
      return `rename_symbol failed: ${e.message}. Fall back to apply_edit.`;
    }
  }

  async toolEditLine(inputPath, lineNumber, content) {
    const filePath = this.resolveWorkspacePath(inputPath);
    const existing = await this.readFileText(filePath) || '';
    const lines = existing.split('\n');
    const idx = lineNumber - 1;
    if (idx < 0 || idx >= lines.length) {
      return `Line ${lineNumber} is out of range (file has ${lines.length} lines).`;
    }
    const oldLine = lines[idx];
    lines[idx] = content;
    const newText = lines.join('\n');
    const result = await this.requestWriteApproval(inputPath, filePath, existing, newText);
    if (result.startsWith('Applied')) this.highlightChangedLines(filePath, [idx], []);
    return result;
  }

  async toolDeleteLine(inputPath, lineNumber) {
    const filePath = this.resolveWorkspacePath(inputPath);
    const existing = await this.readFileText(filePath) || '';
    const lines = existing.split('\n');
    const idx = lineNumber - 1;
    if (idx < 0 || idx >= lines.length) {
      return `Line ${lineNumber} is out of range (file has ${lines.length} lines).`;
    }
    lines.splice(idx, 1);
    const newText = lines.join('\n');
    return await this.requestWriteApproval(inputPath, filePath, existing, newText);
  }

  async toolGitStatus() {
    return await this.runGit(['status', '--short', '--branch']);
  }

  async toolGitDiff(filePath, staged = false) {
    const args = ['diff'];
    if (staged) args.push('--staged');
    if (filePath) args.push('--', this.resolveWorkspacePath(filePath));
    const out = await this.runGit(args);
    return out.slice(0, 8000) || 'No diff';
  }

  async toolGitLog(count = 10) {
    return await this.runGit(['log', `--oneline`, `-${Math.min(count, 50)}`, '--decorate']);
  }

  async runGit(args) {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'No workspace open';
    return new Promise((resolve) => {
      const proc = spawn('git', args, { cwd: root });
      let out = '';
      let err = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.stderr.on('data', d => { err += d.toString(); });
      proc.on('close', code => resolve(out || err || `git exited with code ${code}`));
      proc.on('error', e => resolve('git error: ' + e.message));
    });
  }

  async toolGetDiagnostics(filePath) {
    let targetUri;
    if (filePath) {
      targetUri = vscode.Uri.file(this.resolveWorkspacePath(filePath));
    } else {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return 'No active file open.';
      targetUri = editor.document.uri;
    }
    const diags = vscode.languages.getDiagnostics(targetUri);
    if (diags.length === 0) {
      // An empty diagnostics list is NOT proof of validity — it usually just
      // means no language extension is installed for this file type. Saying
      // "no errors" here is exactly how a broken file gets reported as clean.
      return 'No diagnostics reported. NOTE: this only means no installed language extension flagged this file — it does NOT prove the file is valid. Call check_syntax for a definitive answer.';
    }
    return diags.map(d => {
      const sev = ['Error', 'Warning', 'Info', 'Hint'][d.severity] || '?';
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      return `[${sev}] line ${line}:${col} — ${d.message}${d.source ? ' (' + d.source + ')' : ''}`;
    }).join('\n');
  }

  // Is an external command available on PATH? Cached per session — this is used
  // on the post-write path, so re-probing for every edit would add real latency.
  async _commandAvailable(bin) {
    this._binAvailable = this._binAvailable || new Map();
    if (this._binAvailable.has(bin)) return this._binAvailable.get(bin);
    const probe = await new Promise((resolve) => {
      let timer = null;
      const settle = (v) => { if (timer) { clearTimeout(timer); timer = null; } resolve(v); };
      try {
        const isWin = process.platform === 'win32';
        const child = spawn(isWin ? 'where' : 'command', isWin ? [bin] : ['-v', bin],
          { shell: !isWin, windowsHide: true });
        child.on('close', (code) => settle(code === 0));
        child.on('error', () => settle(false));
        timer = setTimeout(() => settle(false), 2500);
      } catch { settle(false); }
    });
    this._binAvailable.set(bin, probe);
    return probe;
  }

  // Runs an external checker and resolves { ok, output }. Never throws.
  _runChecker(bin, args, cwd, timeout = 15000) {
    return new Promise((resolve) => {
      let out = '';
      let done = false;
      let timer = null;
      const finish = (r) => {
        if (done) return;
        done = true;
        // Clearing this matters a lot: the timer below runs a BLOCKING taskkill
        // on the extension host's main thread. Leaving it armed after the
        // process had already exited meant every syntax check fired a pointless
        // kill 15s later — and since the post-write check runs on every edit,
        // a multi-step turn queued up dozens of them, freezing the UI in bursts.
        // Worse, PIDs get recycled, so a stale kill can hit an unrelated process.
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(r);
      };
      try {
        const child = spawn(bin, args, { cwd, windowsHide: true });
        child.stdout?.on('data', (d) => { out += d.toString(); });
        child.stderr?.on('data', (d) => { out += d.toString(); });
        child.on('close', (code) => finish({ ok: code === 0, output: out.trim() }));
        child.on('error', (e) => finish({ ok: false, output: '', spawnError: e.message }));
        timer = setTimeout(() => {
          if (done) return; // never kill a process that already finished
          this._killProcessTree(child);
          finish({ ok: false, output: out.trim(), timedOut: true });
        }, timeout);
      } catch (e) {
        finish({ ok: false, output: '', spawnError: e.message });
      }
    });
  }

  // ── Command-execution sandboxing (opt-in via navy.sandboxMode) ──────────
  // Off by default — zero behavior change unless the user turns it on. When
  // 'docker', every spawn site routes through _maybeWrapForSandbox below, so
  // enabling it protects run_command, run_tests, run_project, and background
  // processes uniformly rather than needing separate wiring in each tool.

  // Command-execution sandboxing (navy.sandboxMode) lives in src/sandbox.js, mixed into this
  // prototype at the bottom of the file — still methods on this class, so
  // every call site is unchanged.

  // Persistent background processes (navy.persistBackgroundProcesses) lives in src/background.js, mixed into this
  // prototype at the bottom of the file — still methods on this class, so
  // every call site is unchanged.

  // Pin down WHERE a JSON parse failed. V8's message format varies: sometimes it
  // already carries "(line N column M)", sometimes only a character offset, and
  // sometimes neither (just a truncated context snippet). The last case is
  // common and the least actionable, so fall back to a string-aware bracket
  // scan that names the offending line and its matching opener. Pure.
  _jsonErrorLocation(content, message) {
    const direct = /\(line (\d+) column (\d+)\)/.exec(message);
    if (direct) return ` (line ${direct[1]}, column ${direct[2]})`;

    const pos = /position (\d+)/.exec(message);
    if (pos) {
      const upto = content.slice(0, parseInt(pos[1], 10));
      const line = upto.split('\n').length;
      const col = upto.length - upto.lastIndexOf('\n');
      return ` (line ${line}, column ${col})`;
    }

    // No position in the message — locate the structural problem ourselves.
    const stack = [];
    let inStr = false, esc = false, line = 1;
    for (const ch of content) {
      if (ch === '\n') { line++; continue; }
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{' || ch === '[') { stack.push({ ch, line }); continue; }
      if (ch === '}' || ch === ']') {
        const open = stack.pop();
        const wanted = ch === '}' ? '{' : '[';
        if (!open) return ` (line ${line} — unexpected "${ch}" with nothing open)`;
        if (open.ch !== wanted) return ` (line ${line} — "${ch}" closes a "${open.ch}" that was opened on line ${open.line})`;
      }
    }
    if (stack.length) {
      const last = stack[stack.length - 1];
      return ` (line ${last.line} — "${last.ch}" is never closed)`;
    }
    return '';
  }

  // Independent syntax verification that does NOT depend on any VS Code language
  // extension being installed. Three outcomes, always clearly distinguished:
  //   VALID          — a real parser accepted the file
  //   SYNTAX ERROR   — a real parser rejected it (with the parser's own message)
  //   COULD NOT VERIFY — no checker available; explicitly NOT a pass
  async toolCheckSyntax(filePath) {
    if (!filePath) return 'Error: path is required.';
    if (!workspaceIsTrusted()) {
      return 'COULD NOT VERIFY — this workspace is not trusted, so Navy will not start language toolchains in it. This is NOT a pass.';
    }
    let abs;
    try { abs = this.resolveWorkspacePath(filePath); }
    catch (e) { return 'Error: ' + e.message; }

    const base = path.basename(abs);
    const ext = path.extname(abs).toLowerCase();

    // Never read an unbounded file onto the extension host's heap — every other
    // reader in Navy caps its input, and a multi-GB log or data dump would
    // otherwise OOM the host before any parser ever saw it.
    try {
      const st = await fs.promises.stat(abs);
      if (st.size > CHECK_SYNTAX_MAX_BYTES) {
        return `COULD NOT VERIFY — ${base} is ${(st.size / 1048576).toFixed(1)} MB, larger than the ${CHECK_SYNTAX_MAX_BYTES / 1048576} MB syntax-check limit. This is NOT a pass.`;
      }
    } catch (e) {
      return `Error: could not read ${filePath}: ${e.message}`;
    }

    let content;
    try { content = await fs.promises.readFile(abs, 'utf8'); }
    catch (e) { return `Error: could not read ${filePath}: ${e.message}`; }

    // ── In-process checks: no external toolchain, always available ────────────
    if (ext === '.json') {
      try {
        JSON.parse(content);
        return `VALID — ${base} parses as JSON.`;
      } catch (e) {
        return `SYNTAX ERROR in ${base}${this._jsonErrorLocation(content, e.message)}: ${e.message}`;
      }
    }

    // node --check parses without executing. The extension host IS Node, so
    // process.execPath is guaranteed present — no availability probe needed.
    // cwd is deliberately the OS temp dir, not the project: a checker must never
    // resolve anything out of the repository being inspected.
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      // --check rejects ESM-only syntax in .js files unless told it's a module;
      // try script mode first, then module mode before declaring a real error.
      const asScript = await this._runChecker(process.execPath, ['--check', abs], CHECKER_CWD);
      if (asScript.ok) return `VALID — ${base} parses as JavaScript.`;
      const asModule = await this._runChecker(process.execPath, ['--input-type=module', '--check', abs], CHECKER_CWD);
      if (asModule.ok) return `VALID — ${base} parses as an ES module.`;
      return `SYNTAX ERROR in ${base}:\n${(asScript.output || asModule.output || 'parse failed').slice(0, 1500)}`;
    }

    // ── External toolchains ───────────────────────────────────────────────────
    // SECURITY: every entry here must be a PARSE-ONLY invocation that cannot
    // execute, import, or resolve anything from the repository being checked.
    // Removed deliberately, do not re-add without solving the underlying problem:
    //   • python -m py_compile  — `-m` puts cwd first on sys.path, so a repo
    //     containing py_compile.py had its code executed. Fixed with -I
    //     (isolated: ignores cwd, PYTHON* env, and user site-packages).
    //   • npx tsc (.ts/.tsx)    — resolves and RUNS <repo>/node_modules/.bin/tsc,
    //     i.e. a binary shipped by the repo. Also never spawned on Windows
    //     (bare spawn can't resolve npx.cmd). And tsc given a filename ignores
    //     tsconfig.json, so it reported type errors as syntax errors.
    //   • rustc --emit=metadata — macro-expands, so include!("<abs path>") reads
    //     files outside the workspace and echoes them into the error output.
    const EXTERNAL = {
      // -I is isolated mode: cwd is NOT added to sys.path, so a repo-local
      // py_compile.py can no longer hijack the check. Verified: still reports
      // SyntaxError with exit 1 on a broken file.
      '.py':  { bin: 'python', args: ['-I', '-m', 'py_compile', abs], alt: 'python3' },
      '.rb':  { bin: 'ruby',   args: ['--disable-gems', '-c', abs] },
      '.php': { bin: 'php',    args: ['-n', '-l', abs] },   // -n: ignore php.ini
      '.go':  { bin: 'gofmt',  args: ['-e', abs] },         // pure parser, no build
    };

    const spec = EXTERNAL[ext];
    if (!spec || !spec.bin) {
      return `COULD NOT VERIFY — Navy has no safe parse-only checker for "${ext || base}". This is NOT a pass: the file may or may not be valid. Read it back and inspect it manually, or run the project's own build/lint command (e.g. tsc, cargo check) via run_command if you need certainty.`;
    }

    let bin = spec.bin;
    if (!(await this._commandAvailable(bin))) {
      if (spec.alt && await this._commandAvailable(spec.alt)) bin = spec.alt;
      else return `COULD NOT VERIFY — "${spec.bin}" is not installed or not on PATH, so ${base} could not be syntax-checked. This is NOT a pass. Either install it, or verify the file another way.`;
    }

    const res = await this._runChecker(bin, spec.args, CHECKER_CWD);
    if (res.timedOut) return `COULD NOT VERIFY — the ${bin} syntax check for ${base} timed out. This is NOT a pass.`;
    if (res.spawnError) return `COULD NOT VERIFY — could not run ${bin}: ${res.spawnError}. This is NOT a pass.`;
    if (res.ok) return `VALID — ${base} passed the ${bin} syntax check.`;
    return `SYNTAX ERROR in ${base} (reported by ${bin}):\n${(res.output || 'check failed with no output').slice(0, 1500)}`;
  }

  // Outbound request safety (SSRF defence) + fetch_url lives in src/net-safety.js, mixed into this
  // prototype at the bottom of the file — still methods on this class, so
  // every call site is unchanged.

  async toolGetTerminalOutput(maxLines = 100) {
    const terminals = vscode.window.terminals;
    if (terminals.length === 0) return 'No terminals open.';
    const names = terminals.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
    return `Open terminals:\n${names}\n\nVS Code does not expose terminal buffer contents to extensions. To capture output, re-run the command yourself via run_command, or use start_process + read_process_output for long-running processes.`;
  }

  // Characters cmd.exe itself acts on when they appear UNQUOTED on a command
  // line. Each one gets a caret prefix in stage 2 of _shellEscapeArg below.
  // `%` is here because expansion happens before operator parsing, so an
  // unescaped %VAR% both leaks environment contents and can smuggle an & or |
  // in through the variable's VALUE; `!` because delayed expansion may be on.
  static get WIN_CMD_METACHARS() { return /[()%!^"<>&|]/g; }

  // Escapes for whichever shell the command will actually reach — see
  // _commandTargetIsPosix. A sandboxed command on Windows is bound for `sh`
  // inside a container, so cmd.exe's caret rules would corrupt it.
  _shellEscapeArg(s) {
    const shell = this._resolveShell();
    if (shell.id === 'powershell' || shell.id === 'pwsh') {
      // PowerShell is the easy one, for once. A single-quoted string is
      // literal and the only escape inside it is a doubled quote — no caret
      // stage and no CRT stage, because powershell.exe parses its own command
      // line with ordinary CRT rules, so Node's default quoting already
      // delivers -Command intact. That is exactly why verbatim is off for it
      // in SHELLS: turning it on would hand PowerShell an unquoted line.
      return "'" + s.replace(/'/g, "''") + "'";
    }
    if (!shell.posix) {
      // The same string is parsed TWICE on Windows, by two parsers with
      // different rules, so escaping has to happen in two ordered stages:
      //
      //  1. CommandLineToArgvW quoting, for the CHILD program's own argv
      //     split: wrap in quotes, double any backslash run that precedes a
      //     quote (and any trailing run, which precedes the closing quote),
      //     and escape embedded quotes as \".
      //  2. Caret-escape every cmd.exe metacharacter — INCLUDING the quotes
      //     stage 1 just added — so cmd.exe hands the whole thing through
      //     untouched, stripping only the carets.
      //
      // Stage 2 must cover the quotes, and that is the crux: a caret inside a
      // quoted region is LITERAL to cmd.exe, which only honours carets
      // outside quotes. The previous `"…%^…"` form relied on a caret that was
      // always inside quotes, so it did suppress expansion but never got
      // removed — a filter of `%PATH%` reached the child as the literal
      // `%^PATH%`, and `50%` as `50%^`. With no unescaped quote anywhere in
      // the result, every caret does its job and disappears.
      //
      // This only survives the trip to cmd.exe when the spawn asks for
      // verbatim argument passing — see _shellSpec, which is the only
      // supported way to run a string escaped by this function.
      const crt = '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
      return crt.replace(NavyCoderViewProvider.WIN_CMD_METACHARS, '^$&');
    }
    // POSIX sh: single-quote wrap — fully safe against all meta-characters
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  // The platform shell invocation for a command STRING, plus whether Node must
  // pass the arguments to CreateProcess verbatim.
  //
  // On Windows it must. Node's default quoting applies CRT rules to each arg,
  // so the command string gets wrapped in quotes and any quote inside it
  // becomes \" — but cmd.exe does not understand \" and forwards it literally,
  // so `-t "foo bar"` arrives at the child as two argv entries, `"foo` and
  // `bar"`. Verbatim hands cmd.exe exactly the line built here, which is what
  // makes _shellEscapeArg's quoting (and a raw command whose own program path
  // is quoted, e.g. `"C:\Program Files\x\y.exe" arg`) work at all.
  //
  // Only ever for a real shell invocation: a direct argv spawn (_runTestBinary)
  // or a docker-wrapped one needs Node's normal quoting, and verbatim would
  // break it — see _maybeWrapForSandbox, which clears the flag when it rewrites
  // the spawn target.
  _shellSpec(command) {
    const shell = this._resolveShell();
    return { bin: shell.bin, args: shell.args(command), verbatim: shell.verbatim };
  }

  // The one place that decides which shell a command is bound for. Everything
  // downstream — the spawn, the escaping dialect, and what the model is told to
  // write — reads it here so the three can never disagree.
  //
  // navy.shell exists because this used to be `process.platform === 'win32'`
  // and nothing else: Windows meant cmd.exe with no way out, while VS Code's
  // own default terminal there is PowerShell. The cost showed up in the system
  // prompt, which had to spend a whole rule arguing the model out of the
  // PowerShell syntax it reasonably assumed — prompt text compensating for a
  // missing setting.
  _resolveShell() {
    const config = vscode.workspace.getConfiguration('navy');
    // The container wins over the setting, always. A sandboxed command runs
    // inside Linux whatever the host is, so honouring a navy.shell of
    // "powershell" here would splice powershell.exe into a `docker run` for an
    // image that has no such thing — the identical bug that shipped sandboxing
    // broken on Windows, one layer up. _maybeWrapForSandbox either wraps the
    // spec or refuses it, so this can never leak sh onto a Windows host.
    if (config.get('sandboxMode', 'off') === 'docker') return { id: 'sh', ...SHELLS.sh };

    const choice = config.get('shell', 'auto');
    const id = choice === 'auto' ? (process.platform === 'win32' ? 'cmd' : 'sh') : choice;
    // An unrecognised id can only come from a hand-edited settings file. Fall
    // back to the platform default rather than spawning something that is not
    // there, which would fail every command with a confusing ENOENT.
    const spec = SHELLS[id];
    if (spec) return { id, ...spec };
    const fallbackId = process.platform === 'win32' ? 'cmd' : 'sh';
    return { id: fallbackId, ...SHELLS[fallbackId] };
  }

  // Which shell dialect a model-authored command has to be written in, and run
  // through. This is a question about the EXECUTION ENVIRONMENT, not about the
  // host: with navy.sandboxMode 'docker' the command runs inside a Linux
  // container whatever the host is, so a Windows host must stop producing
  // cmd.exe.
  //
  // Keying this off process.platform was why sandboxing was broken on Windows
  // outright — _shellSpec returned `cmd /c …`, _maybeWrapForSandbox spliced it
  // straight into `docker run … <image> cmd /c …`, and no Linux image has a
  // `cmd`. Every sandboxed command failed instantly, which is why the feature
  // shipped documented as macOS/Linux only.
  //
  // Safe as a single decision because when the mode IS 'docker',
  // _maybeWrapForSandbox either wraps the spec or refuses it — it never hands
  // an unwrapped one back, so `sh -c` can't escape onto a Windows host.
  _commandTargetIsPosix() {
    return this._resolveShell().posix;
  }

  // Spawn options shared by every process-launching site here, so the verbatim
  // decision can never be applied at some of them and forgotten at others.
  _spawnOptions(resolved, extra = {}) {
    return {
      cwd: resolved.cwd,
      ...(resolved.verbatim ? { windowsVerbatimArguments: true } : {}),
      ...extra,
    };
  }

  async toolRunTests(filter, streamId) {
    if (!workspaceIsTrusted()) return UNTRUSTED_REFUSAL('run tests');
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'No workspace open.';

    // npm/npx are .cmd shims on Windows — they need the shell to resolve at
    // all, so these still build a command string. `filter` used to go through
    // JSON.stringify(), which provides NO shell protection at all (a POSIX
    // double-quoted string still runs $(...) as real command substitution) —
    // routed through the hardened _shellEscapeArg instead, same as cargo/go below.
    let cmd = null;
    try {
      const pkg = JSON.parse(await fs.promises.readFile(path.join(root, 'package.json'), 'utf8'));
      const scripts = pkg.scripts || {};
      if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
        // Jest-specific flags break other runners (mocha, node:test, ava) — only pass
        // them when jest is actually in play.
        const isJest = /\bjest\b/.test(scripts.test) || Boolean(pkg.devDependencies?.jest || pkg.dependencies?.jest);
        cmd = isJest
          ? 'npm test -- --watchAll=false' + (filter ? ' --testNamePattern=' + this._shellEscapeArg(filter) : '')
          : 'npm test';
      } else if (scripts['test:unit']) cmd = 'npm run test:unit';
      else if (scripts.vitest || pkg.devDependencies?.vitest || pkg.dependencies?.vitest) {
        cmd = 'npx vitest run' + (filter ? ' -t ' + this._shellEscapeArg(filter) : '');
      }
    } catch {}

    if (cmd) {
      const result = await this.toolRunCommand(cmd, 60000, streamId);
      return result.slice(0, 8000);
    }

    // pytest/cargo/go are real executables — run via a direct argv spawn, no
    // shell involved at all, so `filter` needs no escaping and can't be
    // reinterpreted as anything other than one literal argument.
    const binaryChecks = [
      [path.join(root, 'pytest.ini'),     'python', ['-m', 'pytest', ...(filter ? ['-k', filter] : []), '-v']],
      [path.join(root, 'setup.py'),       'python', ['-m', 'pytest', ...(filter ? ['-k', filter] : []), '-v']],
      [path.join(root, 'pyproject.toml'), 'python', ['-m', 'pytest', ...(filter ? ['-k', filter] : []), '-v']],
      [path.join(root, 'Cargo.toml'),     'cargo',  ['test', ...(filter ? ['--', filter] : [])]],
      [path.join(root, 'go.mod'),         'go',     ['test', './...', ...(filter ? ['-run', filter] : [])]],
    ];
    let matched = null;
    for (const [file, bin, args] of binaryChecks) {
      try { await fs.promises.access(file); matched = { bin, args }; break; } catch {}
    }
    if (!matched) return 'Could not detect test framework. Tried npm test, pytest, cargo test, go test.';

    const result = await this._runTestBinary(matched.bin, matched.args, root, 60000, streamId);
    return result.slice(0, 8000);
  }

  // Search only the project's OWN documentation (README/CHANGELOG/CONTRIBUTING/
  // docs//*.md etc.) — lets the agent check "did the project already answer
  // this" before guessing at conventions or setup steps. Shares the same
  // ripgrep/JS-walk infrastructure as search_codebase, scoped by file type/name.
  async toolSearchDocs(query, maxResults = 8) {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'No workspace open.';
    const cap = Math.max(1, Math.min(maxResults || 8, 25));

    const rg = this._findRipgrep();
    if (rg) {
      const args = ['--line-number', '--context', '2', '--max-count', '3',
        '--max-filesize', '300K', '--max-columns', '300', '--smart-case', '--heading',
        '--glob', '*.{md,mdx,txt,rst}',
        '--glob', 'README*', '--glob', 'CHANGELOG*', '--glob', 'CONTRIBUTING*', '--glob', 'AGENTS*',
        '--glob', 'docs/**', '--glob', 'doc/**',
        '-e', query, '.'];
      const { code, out } = await this._rgRun(rg, args, root);
      if (code === 0 && out.trim()) {
        const text = out.replace(/^\.[\\/]/gm, '');
        const note = text.length > 12000 ? '\n\n[Results truncated — narrow the query.]' : '';
        return text.slice(0, 12000).trim() + note;
      }
      if (code === 1) return `No documentation matches for "${query}". Try search_codebase for source code instead.`;
      // code 2 / spawn failure → fall through to the JS walk below
    }

    const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', 'coverage', '.cache']);
    const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst']);
    const DOC_NAME_RE = /^(README|CHANGELOG|CONTRIBUTING|LICENSE|AGENTS)(\.|$)/i;
    const results = [];
    const walk = async (dir, depth) => {
      if (results.length >= cap || depth > 4) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (results.length >= cap) return;
        if (e.isDirectory()) {
          if (!SKIP.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), depth + 1);
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (!DOC_EXT.has(ext) && !DOC_NAME_RE.test(e.name)) continue;
        const full = path.join(dir, e.name);
        try {
          const stat = await fs.promises.stat(full);
          if (stat.size > 300 * 1024) continue;
          const text = await fs.promises.readFile(full, 'utf8');
          const lines = text.split('\n');
          const idx = lines.findIndex(l => l.toLowerCase().includes(query.toLowerCase()));
          if (idx !== -1) {
            const rel = path.relative(root, full).replace(/\\/g, '/');
            const start = Math.max(0, idx - 2), end = Math.min(lines.length, idx + 3);
            const snippet = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
            results.push(`${rel}:${idx + 1}\n${snippet}`);
          }
        } catch {}
      }
    };
    await walk(root, 0);
    if (!results.length) return `No documentation matches for "${query}". Try search_codebase for source code instead.`;
    return results.join('\n\n---\n\n');
  }

  async toolSearchCodebase(query, filePattern, contextLines = 2, folder) {
    const resolved = this._resolveTargetFolder(folder);
    if (resolved.error) return resolved.error;
    const root = resolved.root;
    if (!root) return 'No workspace open.';

    // Fast path: bundled ripgrep — .gitignore-aware, full-tree, regex-capable.
    const rg = this._findRipgrep();
    if (rg) {
      const args = ['--line-number', '--context', String(Math.min(contextLines, 6)), '--max-count', '3',
        '--max-filesize', '300K', '--max-columns', '300', '--smart-case', '--heading'];
      if (filePattern) args.push('--glob', filePattern);
      args.push('-e', query, '.');
      const { code, out } = await this._rgRun(rg, args, root);
      if (code === 0 && out.trim()) {
        const text = out.replace(/^\.[\\/]/gm, '');
        const note = text.length > 16000 ? '\n\n[Results truncated — narrow the query or add a filePattern.]' : '';
        return text.slice(0, 16000).trim() + note;
      }
      if (code === 1) return `No matches for "${query}"`;
      // code 2 (bad regex/glob) or spawn failure → fall through to the JS walk below
    }

    const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', 'coverage', '.cache']);
    const results = [];
    let fileRegex = null;
    if (filePattern) {
      const escaped = filePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      fileRegex = new RegExp(escaped);
    }

    let searchRegex;
    try { searchRegex = new RegExp(query, 'i'); }
    catch { searchRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }

    const walk = async (dir) => {
      if (results.length >= 30) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (results.length >= 30) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP.has(e.name) && !e.name.startsWith('.')) await walk(full);
        } else {
          const rel = path.relative(root, full);
          if (fileRegex && !fileRegex.test(rel)) continue;
          try {
            const stat = await fs.promises.stat(full);
            if (stat.size > 300 * 1024) continue;
            const text = await fs.promises.readFile(full, 'utf8');
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (searchRegex.test(lines[i])) {
                const start = Math.max(0, i - contextLines);
                const end = Math.min(lines.length - 1, i + contextLines);
                const snippet = lines.slice(start, end + 1)
                  .map((l, idx) => `${start + idx + 1}${start + idx === i ? '>' : ' '} ${l}`)
                  .join('\n');
                results.push(`${rel}:${i + 1}\n${snippet}`);
                if (results.length >= 30) break;
              }
            }
          } catch {}
        }
      }
    };

    await walk(root);
    if (results.length === 0) return `No matches for "${query}"`;
    return results.join('\n\n---\n\n');
  }

  async toolInsertAfterLine(inputPath, lineNumber, content) {
    const filePath = this.resolveWorkspacePath(inputPath);
    const existing = await this.readFileText(filePath) || '';
    const lines = existing.split('\n');
    const idx = Math.max(0, Math.min(lineNumber, lines.length));
    const insertLines = content.split('\n');
    lines.splice(idx, 0, ...insertLines);
    const newText = lines.join('\n');
    const insertedIndices = Array.from({ length: insertLines.length }, (_, i) => idx + i);
    const result = await this.requestWriteApproval(inputPath, filePath, existing, newText);
    if (result.startsWith('Applied')) this.highlightChangedLines(filePath, insertedIndices, []);
    return result;
  }

  // Compute changed line indices from old→new full-text diff and highlight them.
  highlightWriteChanges(filePath, oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const added = [];
    const modified = [];
    for (let i = 0; i < newLines.length; i++) {
      if (i >= oldLines.length) {
        added.push(i);
      } else if (oldLines[i] !== newLines[i]) {
        modified.push(i);
      }
    }
    this.highlightChangedLines(filePath, added, modified);
  }

  // Show temporary green/yellow gutter decorations on changed lines after an auto-apply.
  highlightChangedLines(filePath, addedIndices, modifiedIndices) {
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === filePath || e.document.fileName === filePath
    );
    if (!editor) return;
    const toRange = (i) => new vscode.Range(i, 0, i, 0);
    const addedDeco = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full
    });
    const modDeco = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('diffEditor.modifiedLineBackground'),
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full
    });
    editor.setDecorations(addedDeco, addedIndices.map(toRange));
    editor.setDecorations(modDeco, modifiedIndices.map(toRange));
    setTimeout(() => { addedDeco.dispose(); modDeco.dispose(); }, 5000);
    // Persist changed lines for gutter badge across editor switches.
    for (const i of [...addedIndices, ...modifiedIndices]) this.markEdited(filePath, i, i);
  }

  async toolApplyEdit(inputPath, search, replace) {
    const filePath = this.resolveWorkspacePath(inputPath);
    const existingText = await this.readFileText(filePath) || '';
    const newText = literalReplace(existingText, search, replace);

    if (newText instanceof Error) return 'Error: ' + newText.message;

    if (newText === null) {
      // "Did you mean" recovery: show the model the CLOSEST-matching region of the
      // real file so it can correct in one round-trip instead of flailing — a big
      // help for weaker models that don't reproduce whitespace/text exactly.
      const region = this._closestRegion(existingText, search);
      if (region) {
        return (
          `Error: SEARCH text not found verbatim in ${path.basename(filePath)}.\n` +
          `Closest matching region (~${region.score}% similar, around line ${region.startLine}) — copy your SEARCH block from here EXACTLY, including whitespace:\n` +
          '```\n' + region.text + '\n```\n' +
          'Re-emit apply_edit with the search copied character-for-character from the lines above. If you meant to replace most of the file, use write_file.'
        );
      }
      const preview = existingText.slice(0, 300).replace(/\n/g, '\\n');
      return (
        `Error: The search text was not found verbatim in ${path.basename(filePath)}.\n` +
        `File preview (first 300 chars): ${preview}\n` +
        'Fix: call read_file first to get the exact current content, then re-emit apply_edit with text copied character-for-character. ' +
        'If you need to replace the whole file, use write_file instead.'
      );
    }

    return await this.requestWriteApproval(inputPath, filePath, existingText, newText);
  }

  // Find the file region most similar to a failed SEARCH block, for the
  // "did you mean" recovery hint. Pure. Returns { startLine, score, text } or null.
  _closestRegion(fileText, search) {
    const orig = fileText.split('\n');
    const sTrim = search.split('\n').map(l => l.trim());
    const sLen = sTrim.length;
    if (!sLen || orig.length === 0 || sLen > orig.length) return null;
    const sim = (a, b) => {
      a = a.trim(); b = b.trim();
      if (a === b) return a === '' ? 0.5 : 1;
      if (!a || !b) return 0;
      const ta = new Set(a.split(/\W+/).filter(Boolean));
      const tb = new Set(b.split(/\W+/).filter(Boolean));
      if (!ta.size || !tb.size) return 0;
      let inter = 0;
      for (const t of ta) if (tb.has(t)) inter++;
      return inter / Math.max(ta.size, tb.size);
    };
    let best = { score: -1, idx: 0 };
    for (let i = 0; i <= orig.length - sLen; i++) {
      let sc = 0;
      for (let j = 0; j < sLen; j++) sc += sim(orig[i + j], sTrim[j]);
      sc /= sLen;
      if (sc > best.score) best = { score: sc, idx: i };
    }
    if (best.score <= 0.1) return null; // nothing meaningfully close — preview fallback
    const start = best.idx;
    const text = orig.slice(start, start + sLen).map((l, k) => `${start + k + 1}: ${l}`).join('\n');
    return { startLine: start + 1, score: Math.round(best.score * 100), text };
  }

  // Central write-approval path used by both toolApplyEdit and toolWriteFile.
  // In auto-approve mode: writes immediately.
  // In ask-always mode: opens VS Code's native diff editor then asks the user.
  async requestWriteApproval(inputPath, filePath, oldText, newText) {
    const basename = path.basename(filePath);
    // Generate the id upfront so both paths use the same id in pendingDiff and diffResolved.
    const id = this.generateId();

    this.view?.webview.postMessage({
      type: 'pendingDiff', id, path: inputPath, oldText, newText
    });

    if (this._editsAutoApproved()) {
      try {
        this.createCheckpoint(filePath, oldText, newText);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(newText, 'utf8'));
        this.view?.webview.postMessage({ type: 'diffResolved', id, approved: true });
        this.highlightWriteChanges(filePath, oldText, newText);
        return `Applied to ${basename}`;
      } catch (e) {
        return `Error writing ${basename}: ${e.message}`;
      }
    }

    // Show native VS Code diff editor so the user sees the change inline.
    const proposedUri = vscode.Uri.parse(`navy-proposed:${id}/${encodeURIComponent(basename)}`);
    this.context.__navyProposedProvider?.set(id, newText);

    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(filePath),
        proposedUri,
        `⚓ Navy: ${basename}`
      );
    } catch {}

    // Race the in-chat diff card buttons against the native toast — first answer wins.
    // The card is the primary control; the toast is a convenience. Dismissing the toast
    // does NOT reject the edit — the card stays live so the agent isn't silently stalled.
    const decision = await new Promise((resolve) => {
      this.pendingApprovals.set(id, { resolve, filePath, kind: 'agent-edit' });
      this.sendPendingApprovalsUpdate();
      vscode.window.showInformationMessage(
        `Apply Navy's changes to ${basename}?`,
        'Apply',
        'Reject'
      ).then((choice) => {
        if (!this.pendingApprovals.has(id)) return; // already decided via the card
        if (choice === 'Apply' || choice === 'Reject') {
          this.pendingApprovals.delete(id);
          this.sendPendingApprovalsUpdate();
          resolve(choice === 'Apply' ? 'approve' : 'reject');
        }
        // Toast dismissed without a click → card remains the sole resolver.
      });
    });

    this.context.__navyProposedProvider?.delete(id);
    // Close the diff editor and refocus the original file.
    try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}

    if (decision === 'approve') {
      try {
        this.createCheckpoint(filePath, oldText, newText);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(newText, 'utf8'));
        this.view?.webview.postMessage({ type: 'diffResolved', id, approved: true });
        this.highlightWriteChanges(filePath, oldText, newText);
        return `Applied to ${basename}`;
      } catch (e) {
        return `Error writing ${basename}: ${e.message}`;
      }
    }

    this.view?.webview.postMessage({ type: 'diffResolved', id, approved: false });
    return decision === 'reject'
      ? `Rejected — no changes made to ${basename}`
      : `Edit cancelled — no changes made to ${basename}`;
  }

  async resolveApproval(id, approved) {
    const approval = this.pendingApprovals.get(id);
    if (!approval) return;
    this.pendingApprovals.delete(id);

    // Agent-edit approvals: requestWriteApproval owns the write + diffResolved message;
    // we just deliver the user's decision to its awaiting promise.
    if (approval.kind === 'agent-edit') {
      this.sendPendingApprovalsUpdate();
      approval.resolve(approved ? 'approve' : 'reject');
      return;
    }

    // Legacy path for sidebar-card approvals (applyCode flow).

    if (approved) {
      let result;
      try {
        const original = await this.readFileText(approval.filePath) || '';
        this.createCheckpoint(approval.filePath, original, approval.newText);
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(approval.filePath),
          Buffer.from(approval.newText, 'utf8')
        );
        result = 'Applied to ' + path.basename(approval.filePath);
      } catch (error) {
        result = 'Error writing file: ' + error.message;
      }
      approval.resolve(result);
    } else {
      approval.resolve('Edit rejected by user');
    }

    this.sendPendingApprovalsUpdate();
    this.view?.webview.postMessage({ type: 'diffResolved', id, approved });
  }

  async performEdit(filePath, search, replace) {
    try {
      const original = await this.readFileText(filePath) || '';
      const newText = literalReplace(original, search, replace);
      if (newText instanceof Error) return 'Error: ' + newText.message;
      if (newText === null) return 'Error: search text not found in ' + path.basename(filePath);

      this.createCheckpoint(filePath, original, newText);
      await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(newText, 'utf8'));
      return 'Applied edit to ' + path.basename(filePath);
    } catch (error) {
      return 'Error applying edit: ' + error.message;
    }
  }

  // Transactional undo / redo lives in src/undo.js, mixed into this
  // prototype at the bottom of the file — still methods on this class, so
  // every call site is unchanged.

  // Detects WSL availability + installed distros on Windows so the model can
  // fall back to it for Unix-only tools (gcc, make, …) that aren't on the
  // Windows PATH — checked once per session and cached, not per-turn, since
  // spawning wsl.exe costs real time and the answer never changes mid-session.
  async _detectWsl() {
    if (process.platform !== 'win32') return { available: false };
    if (this._wslCache) return this._wslCache;
    this._wslCache = await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(result);
      };
      try {
        const child = spawn('wsl.exe', ['--list', '--quiet'], { windowsHide: true });
        let buf = Buffer.alloc(0);
        child.stdout?.on('data', (d) => { buf = Buffer.concat([buf, d]); });
        child.on('close', (code) => {
          // A non-zero exit means "no distributions installed" (or WSL not
          // provisioned) — and wsl.exe prints that explanation to stdout. Without
          // this check the message itself was parsed as the distro list, so Navy
          // told the model WSL was available and rule 18 sent it chasing every
          // missing Unix tool through a `wsl` prefix that could never work.
          if (code !== 0) return finish({ available: false });
          // wsl.exe emits UTF-16LE when its output isn't attached to a real
          // console (always true for a spawned child) — decoding as UTF-8
          // here would produce garbled text interleaved with null bytes.
          let text = buf.toString('utf16le').replace(/\0/g, '').trim();
          if (!text) text = buf.toString('utf8').replace(/\0/g, '').trim();
          const distros = text.split(/\r?\n/)
            .map(s => s.trim())
            // A distro name is a single short token; prose sentences are not.
            .filter(s => s && !/\s/.test(s) && s.length <= 64);
          finish({ available: distros.length > 0, distros });
        });
        child.on('error', () => finish({ available: false }));
        // Never let this delay a turn — treat "still running after 3s" as unavailable.
        timer = setTimeout(() => finish({ available: false }), 3000);
      } catch {
        finish({ available: false });
      }
    });
    return this._wslCache;
  }

  // Approval gate shared by every command-executing tool. `displayCommand` is
  // shown verbatim in the approval card — the user sees the same thing
  // whether the actual execution ends up going through a shell string or a
  // direct argv spawn. Returns whether the caller may proceed.
  async _approveCommand(displayCommand) {
    if (this._commandsAutoApproved()) return true;
    const id = this.generateId();
    this.view?.webview.postMessage({ type: 'pendingCommand', id, command: displayCommand });
    return await new Promise((resolve) => {
      this.pendingCommandApprovals.set(id, { resolve });
    });
  }

  // Spawns the given { bin, args, cwd, verbatim } spec and streams stdout/
  // stderr to the webview, with the same timeout/kill and output-capping
  // behavior for every caller. Shared by toolRunCommand (a _shellSpec — the
  // platform shell plus a command STRING) and _runTestBinary (a real
  // executable plus a real argv array, no shell involved at all). Routes
  // through _maybeWrapForSandbox first so navy.sandboxMode protects every
  // caller uniformly.
  // `streamId` tags the live output with the tool call it belongs to. Without
  // it every command's output was broadcast untagged and the webview appended
  // it to whichever terminal card happened to be current — so a background
  // task's command (background tasks run their own agent loop, concurrently
  // with the main turn) wrote into the main turn's card. Untagged output now
  // falls through to the shell panel instead of contaminating a card that
  // belongs to something else.
  async _spawnAndCollect(spec, timeout, streamId) {
    const resolved = await this._maybeWrapForSandbox(spec);
    if (resolved.refused) return resolved.message;
    const { bin, args } = resolved;
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const MAX_BUF = 200000; // cap accumulation — a chatty command must not eat memory
      const child = spawn(bin, args, this._spawnOptions(resolved, { detached: process.platform !== 'win32' }));
      const timer = setTimeout(() => {
        this._killProcessTree(child);
        resolve('Command timed out after ' + timeout + 'ms\nstdout: ' + stdout.slice(-8000) + '\nstderr: ' + stderr.slice(-8000));
      }, timeout);

      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        if (stdout.length > MAX_BUF) stdout = stdout.slice(-MAX_BUF);
        this.view?.webview.postMessage({ type: 'shellChunk', chunk, streamId });
      });
      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        if (stderr.length > MAX_BUF) stderr = stderr.slice(-MAX_BUF);
        this.view?.webview.postMessage({ type: 'shellChunk', chunk, isStderr: true, streamId });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        let out = 'Exit code: ' + code + '\nstdout:\n' + stdout + '\nstderr:\n' + stderr;
        // Cap what goes back to the model: keep the head (exit code + first lines,
        // which the failure tracker parses) and the tail (where errors usually are).
        if (out.length > 16000) {
          out = out.slice(0, 2000)
              + `\n\n[... output truncated — ${out.length.toLocaleString()} chars total, showing head and tail ...]\n\n`
              + out.slice(-13000);
        }
        // A failed command whose own output says a path/command doesn't
        // exist is a signal worth surfacing explicitly — left alone, a model
        // that guessed wrong just guesses again with a slightly different
        // spelling and repeats the same failure, since a wrong path never
        // becomes right by chance. Appended AFTER truncation so it's never
        // the part that gets cut.
        if (code !== 0 && looksLikeMissingPathError(out)) {
          out += '\n\n[Navy: this looks like a path/file/command that does not exist, not a code or logic error. Before retrying with a different guessed spelling, list the actual parent directory (e.g. `dir`/`ls` on it, or list_files if it is inside the workspace) and use the exact name it reports — do not guess again.]';
        }
        resolve(out);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve('Command error: ' + error.message);
      });
    });
  }

  async toolRunCommand(command, timeout = 30000, streamId) {
    if (!workspaceIsTrusted()) return UNTRUSTED_REFUSAL('run shell commands');
    if (!(await this._approveCommand(command + this._sandboxLabelSuffix()))) return 'Command rejected by user';

    const root = this.projectRoot
      || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      || (vscode.window.activeTextEditor ? path.dirname(vscode.window.activeTextEditor.document.fileName) : process.cwd());
    return this._spawnAndCollect({ ...this._shellSpec(command), cwd: root }, timeout, streamId);
  }

  // Runs a test binary directly with a real argv array — no shell, so a
  // filter containing shell metacharacters (&, |, %, $(...), backticks,
  // quotes) is delivered to the process byte-for-byte with zero
  // reinterpretation, instead of being concatenated into a shell command
  // string. Only for real executables (pytest/cargo/go) that never need
  // shell resolution the way npm/npx (.cmd shims on Windows) do — verified
  // empirically that a plain (non-shell) spawn delivers each arg unmodified
  // with no injection, no %-expansion, and no operator-splitting.
  async _runTestBinary(bin, args, root, timeout, streamId) {
    const display = [bin, ...args].map(a => /[\s"&|<>^%!$`']/.test(a) ? JSON.stringify(a) : a).join(' ');
    if (!(await this._approveCommand(display + this._sandboxLabelSuffix()))) return 'Command rejected by user';
    // verbatim: false — a real argv spawn, where Node's own per-argument
    // quoting is exactly what's wanted (see _shellSpec for the contrast).
    return this._spawnAndCollect({ bin, args, cwd: root, verbatim: false }, timeout, streamId);
  }

  detectRunCommand() {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;
    const has = (f) => fs.existsSync(path.join(root, f));
    const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };

    if (has('package.json')) {
      try {
        const pkg = JSON.parse(read('package.json'));
        const s = pkg.scripts || {};
        if (s.dev)     return 'npm run dev';
        if (s.start)   return 'npm start';
        if (s.serve)   return 'npm run serve';
        if (s.preview) return 'npm run preview';
      } catch {}
    }
    if (has('manage.py'))         return 'python manage.py runserver';
    if (has('pyproject.toml')) {
      const c = read('pyproject.toml').toLowerCase();
      if (c.includes('uvicorn') || c.includes('fastapi')) return 'uvicorn main:app --reload';
      if (c.includes('flask'))  return 'flask run';
    }
    if (has('requirements.txt')) {
      const r = read('requirements.txt').toLowerCase();
      if (r.includes('uvicorn') || r.includes('fastapi')) return 'uvicorn main:app --reload';
      if (r.includes('flask'))  return 'flask run';
    }
    if (has('app.py'))   return 'python app.py';
    if (has('main.py'))  return 'python main.py';
    if (has('go.mod'))   return 'go run .';
    if (has('Cargo.toml')) return 'cargo run';
    if (has('Gemfile'))  return 'bundle exec ruby app.rb';
    if (has('pom.xml'))  return 'mvn spring-boot:run -q';
    if (has('build.gradle') || has('build.gradle.kts')) return 'gradle bootRun -q';
    if (has('Makefile')) return 'make';
    return null;
  }

  async toolRunProject(command = null) {
    if (!workspaceIsTrusted()) return UNTRUSTED_REFUSAL('start the project');
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'Error: No project folder open. Ask the user to open a folder first.';

    const cmd = command || this.detectRunCommand();
    if (!cmd) return 'Error: Could not auto-detect how to run this project. Provide an explicit command (e.g. "npm start", "python app.py").';

    if (!this._commandsAutoApproved()) {
      const choice = await vscode.window.showInformationMessage(
        `Navy wants to run: ${cmd}${this._sandboxLabelSuffix()}`, { modal: false }, 'Allow', 'Deny'
      );
      if (choice !== 'Allow') return 'Command rejected by user.';
    }

    // If the project is already running, don't kill and restart — report it instead.
    const existing = this.bgProcesses.get('__run_project__');
    if (existing?.proc) {
      const urlNote = existing.url ? ` at ${existing.url}` : '';
      return `Project is already running${urlNote} (command: ${existing.command}). Stop it first via the Stop button if you need to restart. Do not call run_project again while it is running.`;
    }
    // Previous run exited — clean up its entry before starting fresh.
    if (existing) this.bgProcesses.delete('__run_project__');

    const isWin = process.platform === 'win32';
    // Resolved BEFORE posting runProjectStart — a sandboxing refusal should
    // never leave the webview showing a "starting..." state for a project
    // that was never actually launched.
    const resolved = await this._maybeWrapForSandbox({ ...this._shellSpec(cmd), cwd: root });
    if (resolved.refused) return resolved.message;

    const projectName = path.basename(root);
    this.view?.webview.postMessage({ type: 'runProjectStart', projectName, command: cmd });

    const entry = { proc: null, stdout: '', stderr: '', exitCode: null, command: cmd, url: null };
    const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)\S*/;
    let urlFound = false;

    if (this._persistBgEnabled()) {
      // A real log-file fd, not a pipe — see the section comment above
      // _persistBgEnabled for why that's what actually lets this process
      // outlive a reload. There is then no live stream to read, so this
      // branch can't wire the usual onData/webview streaming or synchronous
      // URL detection — instead it polls the log file itself, capped,
      // self-clearing, same style as every other bounded timer in this file.
      //
      // detached is Unix-only here (`!isWin`), verified empirically rather
      // than assumed: on Windows, `detached: true` on the cmd.exe wrapper
      // reliably breaks the grandchild's (node/npm/etc.) I/O ever reaching
      // the redirected fd at all — cmd.exe runs it and exits 0, but the log
      // file stays empty, with no error anywhere. This reproduced across
      // both a raw fd AND cmd's own `>` redirection, and both with and
      // without shell:true, so it isn't specific to one mechanism — plain
      // (non-detached) + unref() reliably captures output and (unlike
      // detached, which mainly governs console/signal-group inheritance,
      // irrelevant to a window reload) is what this actually needs: nothing
      // here calls _killProcessTree on a persist:true entry (see
      // _disposeSession), so the process is simply never told to stop.
      const { fd, logPath } = await this._openPersistLog(root, '__run_project__');
      const proc = spawn(resolved.bin, resolved.args, this._spawnOptions(resolved, { detached: !isWin, stdio: ['ignore', fd, fd] }));
      try { fs.closeSync(fd); } catch {} // child already has its own dup'd handle
      proc.unref();
      Object.assign(entry, { proc, persist: true, root, pid: proc.pid, logPath });
      this.bgProcesses.set('__run_project__', entry);
      await this._addToBgManifest(root, { id: '__run_project__', taskPath: this._taskPathFor(root, '__run_project__'),
        pid: proc.pid, command: cmd, startedAt: Date.now(), logPath, kind: 'run_project' });

      let tries = 0;
      const poll = setInterval(() => {
        tries++;
        if (urlFound || tries > 20 || this.bgProcesses.get('__run_project__') !== entry) { clearInterval(poll); return; }
        const tail = readFileTail(logPath, 4000);
        const m = tail.match(URL_RE);
        if (m) {
          urlFound = true;
          entry.url = m[0].replace(/0\.0\.0\.0/, 'localhost');
          this.view?.webview.postMessage({ type: 'runProjectReady', url: entry.url });
          clearInterval(poll);
        }
      }, 500);

      proc.on('exit', (code) => {
        entry.exitCode = code ?? 0;
        entry.proc = null;
        this.bgProcesses.delete('__run_project__');
        this._removeFromBgManifest(root, proc.pid).catch(() => {});
        this.view?.webview.postMessage({ type: 'runProjectStopped', exitCode: entry.exitCode });
      });
      proc.on('error', () => {
        this.view?.webview.postMessage({ type: 'runProjectStopped', exitCode: -1 });
        this.bgProcesses.delete('__run_project__');
      });

      return `Starting "${projectName}" with: ${cmd}\nRunning detached (navy.persistBackgroundProcesses is on) — output logged to ${logPath}, and it will survive a window reload. Watching the log for the server URL...`;
    }

    // detached: true on Unix creates a new process group so _killProcessTree can kill it cleanly.
    const proc = spawn(resolved.bin, resolved.args, this._spawnOptions(resolved, { detached: !isWin }));
    entry.proc = proc;
    this.bgProcesses.set('__run_project__', entry);
    // Deliberately NOT written to the project's bg manifest. That file is
    // shared by every window open on this project, and a non-persistent server
    // belongs to THIS window — it is killed when this window closes
    // (_disposeSession tree-kills it). Recording it made a sibling window
    // classify a live server as an orphan from a previous session and offer to
    // stop it, which is a far worse failure than the one it was added to
    // catch. navy.persistBackgroundProcesses is the supported way to have a
    // server outlive its window, and that path records and recovers properly.

    const onData = (chunk) => {
      const text = chunk.toString();
      entry.stdout += text;
      if (entry.stdout.length > 200000) entry.stdout = entry.stdout.slice(-200000);
      this.view?.webview.postMessage({ type: 'runProjectOutput', chunk: text });
      if (!urlFound) {
        const m = text.match(URL_RE);
        if (m) {
          urlFound = true;
          const url = m[0].replace(/0\.0\.0\.0/, 'localhost');
          entry.url = url;
          this.view?.webview.postMessage({ type: 'runProjectReady', url });
          // Persist it: after a restart the pid alone cannot tell anyone WHERE
          // the server is, and "a process is running" is a much less useful
          // thing to be told than "your dev server is still on this address".
          // Only the persistent path has a manifest record to update.
          if (entry.persist && entry.root) {
            this._updateBgManifestEntry(entry.root, proc.pid, { url }).catch(() => {});
          }
        }
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData); // Many frameworks log the URL to stderr
    proc.on('close', (code) => {
      entry.exitCode = code ?? 0;
      entry.proc = null;
      this.bgProcesses.delete('__run_project__');
      this.view?.webview.postMessage({ type: 'runProjectStopped', exitCode: entry.exitCode });
    });
    proc.on('error', () => {
      this.view?.webview.postMessage({ type: 'runProjectStopped', exitCode: -1 });
      this.bgProcesses.delete('__run_project__');
    });

    return `Starting "${projectName}" with: ${cmd}\nWatching for server URL...`;
  }

  async toolStartProcess(id, command) {
    if (!workspaceIsTrusted()) return UNTRUSTED_REFUSAL('start background processes');
    if (!id || !command) return 'Error: id and command are required.';
    const prior = this.bgProcesses.get(id);
    if (prior?.proc) return `Error: a process named "${id}" is already running.`;
    if (prior) this.bgProcesses.delete(id); // previous run exited — allow id reuse

    if (!this._commandsAutoApproved()) {
      const choice = await vscode.window.showInformationMessage(
        `Navy wants to start a background process:\n${command}${this._sandboxLabelSuffix()}`,
        { modal: false }, 'Allow', 'Deny'
      );
      if (choice !== 'Allow') return 'Process rejected by user.';
    }

    // Distinct from `root` below: persisting needs somewhere real to anchor
    // the manifest/log to, so it's never enabled off the process.cwd()
    // fallback (no actual open project to write .navy/ under).
    const persistRoot = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
    const root = persistRoot || process.cwd();
    const isWin = process.platform === 'win32';
    const resolved = await this._maybeWrapForSandbox({ ...this._shellSpec(command), cwd: root });
    if (resolved.refused) return resolved.message;

    const entry = { proc: null, stdout: '', stderr: '', exitCode: null, startedAt: Date.now() };

    if (persistRoot && this._persistBgEnabled()) {
      // See the persist branch of toolRunProject for why this needs a real
      // fd (not the usual pipe), can't wire live webview streaming, and why
      // `detached` is Unix-only (empirically verified: on Windows it breaks
      // the grandchild's I/O ever reaching the redirected fd through the
      // cmd.exe wrapper).
      const { fd, logPath } = await this._openPersistLog(persistRoot, id);
      const proc = spawn(resolved.bin, resolved.args, this._spawnOptions(resolved, { detached: !isWin, stdio: ['ignore', fd, fd] }));
      try { fs.closeSync(fd); } catch {}
      proc.unref();
      Object.assign(entry, { proc, persist: true, root: persistRoot, pid: proc.pid, logPath });
      this.bgProcesses.set(id, entry);
      await this._addToBgManifest(persistRoot, { id, taskPath: this._taskPathFor(persistRoot, id),
        pid: proc.pid, command, startedAt: entry.startedAt, logPath, kind: 'start_process' });

      proc.on('exit', code => {
        entry.exitCode = code ?? 0;
        entry.proc = null;
        this._removeFromBgManifest(persistRoot, proc.pid).catch(() => {});
        this.view?.webview.postMessage({ type: 'bgProcessDone', id, exitCode: entry.exitCode });
      });
      proc.on('error', () => { entry.exitCode = -1; });

      return `Process "${id}" started (PID ${proc.pid}), detached — it will survive a window reload (navy.persistBackgroundProcesses is on). Output is logged to ${logPath}; use read_process_output("${id}") to read it.`;
    }

    const proc = spawn(resolved.bin, resolved.args, this._spawnOptions(resolved, { detached: !isWin }));
    entry.proc = proc;
    this.bgProcesses.set(id, entry);

    proc.stdout.on('data', d => {
      const chunk = d.toString();
      entry.stdout += chunk;
      if (entry.stdout.length > 100000) entry.stdout = entry.stdout.slice(-100000);
      this.view?.webview.postMessage({ type: 'bgProcessOutput', id, chunk });
    });
    proc.stderr.on('data', d => {
      const chunk = d.toString();
      entry.stderr += chunk;
      if (entry.stderr.length > 100000) entry.stderr = entry.stderr.slice(-100000);
      this.view?.webview.postMessage({ type: 'bgProcessOutput', id, chunk, isStderr: true });
    });
    proc.on('close', code => {
      entry.exitCode = code ?? 0;
      entry.proc = null;
      this.view?.webview.postMessage({ type: 'bgProcessDone', id, exitCode: entry.exitCode });
    });
    proc.on('error', e => {
      entry.stderr += '\nProcess error: ' + e.message;
      entry.exitCode = -1;
    });

    return `Process "${id}" started (PID ${proc.pid}). Use read_process_output("${id}") after a moment to check output.`;
  }

  async toolReadProcessOutput(id, clear = false) {
    const entry = this.bgProcesses.get(id);
    if (!entry) {
      const running = [...this.bgProcesses.keys()];
      return running.length
        ? `No process "${id}". Running: ${running.join(', ')}.`
        : `No process "${id}". No background processes running.`;
    }
    const status = entry.exitCode !== null ? `exited (code ${entry.exitCode})` : 'running';
    // Persisted (navy.persistBackgroundProcesses) processes have no live
    // in-memory buffer to read — their stdio is a real file, not a pipe
    // this process ever sees (see _openPersistLog) — so read its current
    // tail from disk instead. `clear` intentionally has no effect on a real
    // log file rather than silently discarding it.
    if (entry.logPath) {
      const tail = readFileTail(entry.logPath, 100000);
      return `[${id}] ${status} (persisted — logged to ${entry.logPath})\n${tail.trim() || '(no output yet)'}`;
    }
    const combined = (entry.stdout + (entry.stderr ? '\n[stderr]\n' + entry.stderr : '')).trim();
    if (clear && entry.exitCode === null) { entry.stdout = ''; entry.stderr = ''; }
    return `[${id}] ${status}\n${combined || '(no output yet)'}`;
  }

  // Kill a spawned process AND its entire child tree (npm → node, etc.).
  // On Windows uses taskkill /F /T; on Unix kills the process group (requires detached: true on spawn).
  // Delegates to _killPidTree (spawn, NOT execSync — this is called from
  // stream handlers, timers, and the tool loop, all on the extension host
  // thread, and a synchronous kill would freeze the whole editor for as
  // long as the child takes to die) so the same by-pid kill logic serves
  // both a live ChildProcess here and a bare pid recovered from a previous
  // window's manifest (see _checkOrphanedBgProcesses, which has no
  // ChildProcess object to hand this).
  _killProcessTree(proc) {
    if (!proc?.pid || proc.killed) return;
    this._killPidTree(proc.pid);
  }

  async toolKillProcess(id) {
    const entry = this.bgProcesses.get(id);
    if (!entry) return `No process "${id}" found.`;
    if (!entry.proc) return `Process "${id}" has already exited (code ${entry.exitCode}).`;
    this._killProcessTree(entry.proc);
    this.bgProcesses.delete(id);
    if (entry.persist && entry.root) await this._removeFromBgManifest(entry.root, entry.pid);
    this.view?.webview.postMessage({ type: 'bgProcessDone', id, exitCode: -1 });
    return `Process "${id}" killed.`;
  }

  // Stops every process/timer a session owns — used when closing a tab, and
  // (iterating every session) when the extension itself deactivates. Kept as
  // one shared helper so a tab's cleanup and full-shutdown cleanup can never
  // drift apart from each other.
  _disposeSession(session) {
    clearInterval(session._heartbeat);
    clearTimeout(session._watchdog);
    clearTimeout(session._cpSaveTimer);
    for (const [, entry] of session.bgProcesses) {
      // navy.persistBackgroundProcesses processes are deliberately left
      // running — killing them here would defeat the entire point of the
      // setting. They're already detached/unref'd and recorded in the
      // project's manifest, so nothing further is needed to let them go.
      if (entry?.proc && !entry.persist) { try { this._killProcessTree(entry.proc); } catch {} }
    }
    for (const [, worker] of session.bgWorkers) { try { worker.ctrl.abort(); } catch {} }
  }

  dispose() {
    this.mcp?.stop();
    this.stopDictation('shutdown');
    try { this._fileWatcher?.dispose(); } catch { /* already gone */ }
    this._fileWatcher = null;
    // Every open tab's processes/timers, not just the currently active one —
    // a background dev server or task in a non-visible tab must still be
    // stopped when the extension deactivates or the window reloads.
    for (const session of this.sessions.values()) this._disposeSession(session);
    // Project-level caches (see _proj) are shared across a project's chats,
    // not owned by any one session — their debounce timer is cleared here.
    for (const p of this._projectCaches.values()) clearTimeout(p.embedSaveTimer);
  }

  // Captured once, at invocation — everything the background task does stays
  // bound to the session that was active when it was started, even after the
  // user switches tabs (see the _session getter and sessionContext note above).
  // Prefers an already-established context over activeSessionId for the same
  // reason askNavy does: if this is ever reached from inside a running turn,
  // the task belongs to THAT turn's session, not to whichever tab happens to
  // be on screen by then.
  runBackgroundTask(taskId, prompt) {
    const boundSession = sessionContext.getStore() ?? this.activeSessionId;
    return sessionContext.run(boundSession, () => this._runBackgroundTaskBody(taskId, prompt));
  }

  async _runBackgroundTaskBody(taskId, prompt) {
    const ctrl = new AbortController();
    // `prompt` is kept so _sendLiveCardState can rebuild this task's card with
    // its real label after a tab switch wiped the view.
    this.bgWorkers.set(taskId, { ctrl, prompt });
    // Distinct turnId so this task's file edits form their own Undo Last Turn group,
    // never merging into whatever main-chat turn happens to be active.
    const bgTurnId = 'bg-' + this.generateId();

    const post = (status, extra = {}) =>
      this.view?.webview.postMessage({ type: 'bgTaskUpdate', taskId, status, ...extra });

    try {
      const config = vscode.workspace.getConfiguration('navy');
      const host = config.get('host', 'http://localhost:11434').replace(/\/$/, '');
      const model = this.currentModel || config.get('model', '');
      const temperature = config.get('temperature', 0.2);
      const maxIter = config.get('maxToolIterations', 100);

      const bgMessages = [
        { role: 'system', content: TOOL_PROMPT },
        { role: 'user', content: prompt }
      ];

      let usedTools = false;

      for (let iter = 0; iter < maxIter; iter++) {
        const { text, nativeToolCalls } = await streamAssistant(this,
          host, model, bgMessages, temperature,
          ctrl.signal,
          (chunk) => post('chunk', { text: chunk })
        );

        // Same normalization as the main loop — strict providers (DeepSeek's
        // `type` field, Cohere's empty ids) reject unnormalized replays here too.
        this._normalizeToolCallIds(nativeToolCalls);
        bgMessages.push({
          role: 'assistant',
          content: text || '',
          ...(nativeToolCalls.length ? { tool_calls: nativeToolCalls } : {})
        });

        const toolCalls = nativeToolCalls.length > 0
          ? nativeToolCalls.map(tc => {
              let args = {};
              try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {}); } catch {}
              return { name: tc.function.name, args, id: tc.id || '' };
            })
          : parseToolCalls(text);

        if (toolCalls.length === 0 || toolCalls.every(t => t.name === 'finish')) break;

        usedTools = true;
        const toolResults = [];
        for (const tool of toolCalls) {
          if (ctrl.signal.aborted) break;
          if (tool.name === 'finish') continue;
          post('tool', { tool: tool.name, args: tool.args });
          const result = await this.executeTool(tool, bgTurnId);
          post('toolResult', { tool: tool.name, result: String(result).slice(0, 800) });
          if (nativeToolCalls.length > 0) {
            toolResults.push({ role: 'tool', tool_call_id: tool.id || '', content: String(result) });
          } else {
            toolResults.push({ role: 'user', content: '<tool_result name="' + tool.name + '">\n' + result + '\n</tool_result>' });
          }
        }
        for (const tr of toolResults) bgMessages.push(tr);
      }

      post('done');
    } catch (e) {
      if (e.name === 'AbortError') post('aborted');
      else {
        const p = vscode.workspace.getConfiguration('navy').get('provider', 'ollama');
        post('error', { message: formatProviderError(providerDisplayName(p), e.message) });
      }
    } finally {
      this.bgWorkers.delete(taskId);
    }
  }

  async toolGitBlame(filePath, startLine, endLine) {
    const absPath = this.resolveWorkspacePath(filePath);
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(absPath);
    const args = ['blame', '--date=short', '-w'];
    if (startLine) {
      args.push('-L', endLine ? `${startLine},${endLine}` : `${startLine},${startLine}`);
    }
    args.push(absPath);
    return new Promise((resolve) => {
      const proc = spawn('git', args, { cwd: root });
      let out = '';
      let err = '';
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { err += d; });
      // Cap like git_diff — blaming a whole large file would flood the model context.
      proc.on('close', () => resolve((out.trim() || ('git blame failed: ' + err.trim())).slice(0, 8000)));
      proc.on('error', e => resolve('git error: ' + e.message));
    });
  }

  async toolFindSymbol(name) {
    try {
      const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', name);
      if (!symbols || symbols.length === 0) {
        return `No symbol named "${name}" found by the language server. Try search_codebase as a fallback.`;
      }
      const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const results = [];
      for (const sym of symbols.slice(0, 10)) {
        const filePath = sym.location.uri.fsPath;
        const line = sym.location.range.start.line;
        const kind = Object.keys(vscode.SymbolKind).find(k => vscode.SymbolKind[k] === sym.kind) || 'Symbol';
        const relPath = root ? path.relative(root, filePath) : filePath;
        let snippet = '';
        try {
          const content = await fs.promises.readFile(filePath, 'utf8');
          const lines = content.split('\n');
          const start = Math.max(0, line - 1);
          const end = Math.min(lines.length, line + 3);
          snippet = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
        } catch {}
        results.push(
          `**[${kind}]** \`${sym.name}\`${sym.containerName ? ` — in \`${sym.containerName}\`` : ''}\n` +
          `${relPath}:${line + 1}\n\`\`\`\n${snippet}\n\`\`\``
        );
      }
      return `Found ${symbols.length} result${symbols.length !== 1 ? 's' : ''} for \`${name}\`:\n\n` + results.join('\n\n---\n\n');
    } catch (e) {
      return 'find_symbol failed: ' + e.message + '. Try search_codebase as a fallback.';
    }
  }

  async toolFindReferences(name) {
    try {
      // Step 1: locate a definition position to anchor the reference query.
      const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', name);
      if (!symbols || symbols.length === 0) {
        return `No symbol named "${name}" found by the language server. Try search_codebase to locate usages by text.`;
      }
      const sym = symbols.find(s => s.name === name) || symbols[0];
      const uri = sym.location.uri;
      const pos = new vscode.Position(
        sym.location.range.start.line,
        sym.location.range.start.character + 1
      );

      // Ensure the document is loaded so the language server can index it.
      await vscode.workspace.openTextDocument(uri);

      // Step 2: ask the language server for all references.
      const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, pos);
      if (!refs || refs.length === 0) {
        return `Language server returned no references for \`${name}\`. Try opening the file in the editor first, then retry.`;
      }

      const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const lines = [];
      for (const ref of refs.slice(0, 30)) {
        const filePath = ref.uri.fsPath;
        const line = ref.range.start.line;
        const relPath = root ? path.relative(root, filePath) : filePath;
        let snippet = '';
        try {
          const content = await fs.promises.readFile(filePath, 'utf8');
          snippet = (content.split('\n')[line] || '').trim();
        } catch {}
        lines.push(`${relPath}:${line + 1}  ${snippet}`);
      }
      return (
        `**${refs.length} reference${refs.length !== 1 ? 's' : ''} to \`${name}\`**` +
        `${refs.length > 30 ? ' (showing first 30)' : ''}:\n\n` +
        lines.join('\n')
      );
    } catch (e) {
      return 'find_references failed: ' + e.message + '. Try search_codebase as a fallback.';
    }
  }

  // Runs an isolated, READ-ONLY sub-agent to investigate `task` and returns
  // only its written conclusion — not the raw tool trace it took to get
  // there, keeping the DELEGATING turn's own context clean. Reuses the exact
  // model-call and native/text tool-call dispatch machinery _askNavyTurn
  // itself uses (streamAssistant, _normalizeToolCallIds, the same
  // native-vs-parseToolCalls fallback), so it behaves identically across
  // providers — deliberately does NOT thread through _rawBlocks
  // (Anthropic/Gemini extended-thinking continuity) since a short, focused
  // investigation doesn't need multi-turn deliberation carried between its
  // OWN steps the way a long primary conversation does.
  //
  // Every tool call is checked against READ_ONLY before running — the model
  // sees no restricted schema (still the same TOOLS_API everyone gets), so
  // enforcement happens at DISPATCH, not by hiding tools it might still try:
  // a write/command/delegate attempt is refused with an explanation instead
  // of silently no-oping or (worse) actually running.
  async toolDelegateResearch(task, maxSteps) {
    if (!task || !task.trim()) return 'Error: task is required — describe what to investigate.';
    // NOT `parseInt(maxSteps, 10) || 12` — 0 is falsy, so that would silently
    // replace an explicit maxSteps: 0 with the default (12) instead of
    // clamping it to the minimum (1). Only a genuinely non-numeric/absent
    // value should fall back to the default.
    const parsedSteps = parseInt(maxSteps, 10);
    const steps = Math.min(Math.max(Number.isFinite(parsedSteps) ? parsedSteps : 12, 1), 20);
    // Refuse rather than queue. A queued delegation would sit holding the whole
    // turn open while the model waited on a result it could not see coming;
    // told plainly that it asked for too many at once, it can run the rest in
    // the next step, which is the same work in a shape the user can follow.
    const inFlight = this._session._activeDelegations || 0;
    if (inFlight >= MAX_CONCURRENT_DELEGATIONS) {
      return `[Refused: ${inFlight} research sub-agents are already running, which is the limit (${MAX_CONCURRENT_DELEGATIONS}). Wait for these results, then delegate the rest.]`;
    }
    this._session._activeDelegations = inFlight + 1;
    try {
      return await this._runDelegatedResearch(task, steps);
    } finally {
      this._session._activeDelegations = Math.max(0, (this._session._activeDelegations || 1) - 1);
    }
  }

  // The sub-agent loop itself. Split out so the concurrency bookkeeping above
  // cannot be skipped by an early return from inside it.
  async _runDelegatedResearch(task, steps) {
    const config = vscode.workspace.getConfiguration('navy');
    // The model the DELEGATING turn is actually running on, not whatever
    // navy.model happens to say: the model picker sends its choice with the
    // request itself, so config can still hold the previous one and the
    // sub-agent would silently run on a different (possibly much weaker or
    // more expensive) model than its parent — while its tokens get billed
    // into that parent's usage total. Falls back to config for a call made
    // outside any turn.
    const model = this._session.activeModel || config.get('model', '');
    const host = config.get('host', 'http://localhost:11434').replace(/\/$/, '');
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'none';

    const systemContent = `You are a focused research sub-agent inside the Navy Coder VS Code extension, delegated ONE investigation by another agent. You have NO memory of any earlier conversation — the task below is everything you know.

Project root: ${root}

You may call READ-ONLY tools to investigate: read_file, read_lines, list_files, search_files, search_codebase, find_relevant_files, find_symbol, find_references, search_docs, git_status, git_diff, git_log, git_blame, get_diagnostics, check_syntax, web_search, fetch_url. You CANNOT write, delete, rename files, run commands, or delegate further — any such attempt will be refused. When you have enough to answer, respond in PLAIN TEXT with a clear, well-organized report the delegating agent can act on directly — do not call finish(), just stop calling tools once you're done.

Investigation task:
${task.trim()}`;

    const messages = [{ role: 'system', content: systemContent }];
    let finalText = '';
    let filesLookedAt = 0;

    for (let i = 0; i < steps; i++) {
      if (this.abortController?.signal.aborted) { finalText = finalText || '[Interrupted by Stop.]'; break; }
      let streamed;
      try {
        streamed = await streamAssistant(this, host, model, messages, 0.2, this.abortController?.signal, () => {});
      } catch (e) {
        return `Sub-agent research failed: ${e.message}` + (finalText ? `\n\nPartial findings before the failure:\n${finalText}` : '');
      }
      const { text, nativeToolCalls, tokenCounts } = streamed;
      this.subAgentTokens.prompt += tokenCounts.prompt;
      this.subAgentTokens.completion += tokenCounts.completion;
      this._normalizeToolCallIds(nativeToolCalls);
      messages.push(nativeToolCalls.length > 0
        ? { role: 'assistant', content: text || '', tool_calls: nativeToolCalls }
        : { role: 'assistant', content: text });
      if (text?.trim()) finalText = text;

      const toolCalls = nativeToolCalls.length > 0
        ? nativeToolCalls.map(tc => {
            let args = {};
            try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {}); }
            catch (e) { args = { __parseError: e.message, tool: tc.function.name }; }
            return { name: tc.function.name, args, id: tc.id || '' };
          })
        : parseToolCalls(text);

      const nonFinish = toolCalls.filter(t => t.name !== 'finish');
      if (!nonFinish.length) break; // no tool calls (or only finish) — finalText above is the answer

      const makeResult = (tool, result) => makeToolResultMessage(tool, result, nativeToolCalls.length > 0);

      for (const tool of nonFinish) {
        let result;
        if (!SUB_AGENT_TOOLS.has(tool.name)) {
          result = tool.name === 'delegate_research'
            ? '[Refused: "delegate_research" is not available inside a sub-agent — a sub-agent cannot delegate further. Investigate this yourself with the read-only tools, or say in your report that the question needs its own investigation.]'
            : `[Refused: delegate_research sub-agents are read-only — "${tool.name}" is not permitted. State your findings as text; the delegating agent will make any actual changes.]`;
        } else {
          try { result = await this.executeTool(tool); }
          catch (e) { result = 'Error: ' + e.message; }
          filesLookedAt++;
        }
        messages.push(makeResult(tool, result));
      }
    }

    if (!finalText.trim()) {
      finalText = filesLookedAt
        ? `Sub-agent investigated but did not produce a written conclusion within its step budget (${steps}). Consider raising maxSteps or narrowing the task.`
        : 'Sub-agent produced no findings.';
    }
    return finalText.trim();
  }

  // Web search backends lives in src/web-search.js, mixed into this
  // prototype at the bottom of the file — still methods on this class, so
  // every call site is unchanged.

  async generatePRReview() {
    // Open the sidebar FIRST — the command-approval card (ask-always mode) renders in
    // the webview, and if the view was never resolved the await below would hang forever.
    await this.focus();
    const input = await vscode.window.showInputBox({
      prompt: 'PR number or leave blank to diff current branch vs main',
      placeHolder: 'e.g. 42',
      ignoreFocusOut: true,
    });
    if (input === undefined) return; // cancelled

    let diff;
    if (input && /^\d+$/.test(input.trim())) {
      diff = await this.toolRunCommand(`gh pr diff ${input.trim()}`, 30000);
    } else {
      const base = input?.trim() || 'main';
      diff = await this.toolGitDiff('', false) + '\n\n(base: ' + base + ')';
    }

    if (!diff || diff.startsWith('Command error') || diff.includes('command not found')) {
      vscode.window.showErrorMessage('PR Review: failed to get diff. Install GitHub CLI (gh) for PR number support.');
      return;
    }

    const prompt = `You are reviewing a pull request. For every real problem you find:\n1. Quote the relevant code snippet.\n2. Explain the bug or concern.\n3. Show the corrected version.\n\nAlso summarise overall quality at the end.\n\n\`\`\`diff\n${diff.slice(0, 80000)}\n\`\`\``;
    await this.focus();
    this.askNavy(prompt, false, null, [])
      .catch(e => this._reportTurnFailure(e, 'PR review'));
  }

  async exportConversation(conversationText) {
    const defaultName = `navy-chat-${new Date().toISOString().slice(0, 10)}.md`;
    const defaultDir = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(defaultDir, defaultName)),
      filters: { 'Markdown': ['md'], 'Text': ['txt'] },
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(conversationText, 'utf8'));
    vscode.window.showInformationMessage('Conversation exported to ' + path.basename(uri.fsPath));
  }

  markEdited(filePath, startLine, endLine) {
    if (!filePath) return;
    const existing = this.editedRanges.get(filePath) || [];
    existing.push({ start: startLine, end: endLine ?? startLine });
    // Cap per-file entries so long sessions don't accumulate unboundedly.
    if (existing.length > 500) existing.splice(0, existing.length - 500);
    this.editedRanges.set(filePath, existing);
    // Apply to any open editor showing this file.
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.fileName === filePath) this.applyGutterDecorations(editor);
    }
  }

  applyGutterDecorations(editor) {
    const ranges = this.editedRanges.get(editor.document.fileName) || [];
    const decorations = ranges.map(r =>
      new vscode.Range(r.start, 0, r.end, 0)
    );
    editor.setDecorations(this.gutterDecorationType, decorations);
  }

  // Lexical + semantic retrieval, the repo map and the embedding index all
  // live in src/retrieval.js, mixed into this prototype at the bottom of the
  // file. They are still methods on this class, so every call site is unchanged.

  // Raw, untruncated read. Edit paths (apply_edit, edit_line, checkpoints, …) depend on
  // getting the FULL file — truncating here would corrupt any file larger than the cap
  // when the edited result is written back. Truncation for chat context happens only
  // at the context-building site via truncateForContext().
  async readFileText(filePath) {
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      return Buffer.from(data).toString('utf8');
    } catch (error) {
      return null;
    }
  }

  truncateForContext(text) {
    if (text === null || text === undefined) return text;
    const max = vscode.workspace.getConfiguration('navy').get('maxContextChars', 12000);
    return text.length > max ? text.slice(0, max) + '\n\n[Truncated to ' + max + ' characters — use read_lines for the rest]' : text;
  }

  generateId() {
    return crypto.randomBytes(6).toString('hex');
  }

  sendPendingApprovalsUpdate() {
    const approvals = [];
    for (const [id, approval] of this.pendingApprovals) {
      approvals.push({ id, path: approval.filePath });
    }
    this.view?.webview.postMessage({ type: 'pendingApprovals', approvals });
  }

  async insertCode(text) {
    const code = text || '';
    if (!code.trim()) { vscode.window.showInformationMessage('No code to insert.'); return; }
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('Open a file before inserting code.'); return; }
    await editor.edit((editBuilder) => {
      for (const selection of editor.selections) editBuilder.replace(selection, code);
    });
  }

  async applyCode(text, providedPath) {
    const code = text || '';
    if (!code.trim()) { vscode.window.showInformationMessage('No code to apply.'); return; }

    let targetPath = providedPath ? this.resolveWorkspacePath(providedPath) : '';
    if (!targetPath) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) targetPath = activeEditor.document.fileName;
    }
    if (!targetPath) {
      const picked = await vscode.window.showSaveDialog({ saveLabel: 'Apply Navy code' });
      if (!picked) return;
      targetPath = picked.fsPath;
    }

    if (this._editsAutoApproved()) {
      await this.writeWholeFile(targetPath, code);
      return;
    }

    const existingText = await this.readFileText(targetPath) || '';
    const id = this.generateId();
    this.view?.webview.postMessage({ type: 'pendingDiff', id, path: providedPath || targetPath, oldText: existingText, newText: code });
    return new Promise((resolve) => {
      this.pendingApprovals.set(id, { resolve, filePath: targetPath, search: '', replace: '', newText: code });
      this.sendPendingApprovalsUpdate();
    });
  }

  async writeWholeFile(filePath, text) {
    try {
      const original = await this.readFileText(filePath) || '';
      this.createCheckpoint(filePath, original, text);
      await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(text, 'utf8'));
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage('Applied code to ' + path.basename(filePath));
      this.view?.webview.postMessage({ type: 'applied', path: filePath });
    } catch (error) {
      vscode.window.showErrorMessage('Could not apply code: ' + error.message);
    }
  }

  async insertLastReply() {
    if (!this.lastReply.trim()) { vscode.window.showInformationMessage('No Navy reply to insert yet.'); return; }
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('Open a file before inserting the reply.'); return; }
    await editor.edit((editBuilder) => {
      for (const selection of editor.selections) editBuilder.replace(selection, this.lastReply);
    });
  }

  restoreMessages() {
    this.view?.webview.postMessage({ type: 'restore', messages: this.messages });
  }

  // One-shot, non-streaming completion through the ACTIVE provider (not just Ollama).
  // Chunks are swallowed via a no-op onChunk so nothing leaks into the chat webview.
  async _completeOnce(host, model, messages) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const { text } = await streamAssistant(this, host, model, messages, 0.2, ctrl.signal, () => {});
      // Reasoning models may wrap deliberation in <think> tags — strip them.
      return (text || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
    } finally {
      clearTimeout(timer);
    }
  }

  async generateCommit() {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { vscode.window.showErrorMessage('Navy: No project root detected.'); return; }

    const diff = await this.runGit(['diff', '--staged']);
    if (!diff || diff.trim() === '') {
      const choice = await vscode.window.showWarningMessage(
        'Nothing staged. Stage changes first, or generate a message for all unstaged changes?',
        'Use unstaged diff', 'Cancel'
      );
      if (choice !== 'Use unstaged diff') return;
    }

    const diffToUse = diff.trim() ? diff : await this.runGit(['diff']);
    if (!diffToUse.trim()) { vscode.window.showInformationMessage('No changes to commit.'); return; }

    const config = vscode.workspace.getConfiguration('navy');
    const host = config.get('host', 'http://localhost:11434').replace(/\/$/, '');
    const model = config.get('model', '');

    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Navy: Generating commit message…', cancellable: false }, async () => {
      try {
        const message = await this._completeOnce(host, model, [
          { role: 'system', content: 'You write concise, conventional-commits-style git commit messages. Output ONLY the commit message — no explanation, no quotes, no markdown.' },
          { role: 'user', content: `Write a git commit message for this diff:\n\n${diffToUse.slice(0, 6000)}` }
        ]);
        if (!message) { vscode.window.showErrorMessage('Navy: Failed to generate commit message.'); return; }

        const confirmed = await vscode.window.showInputBox({
          prompt: 'Commit message (edit or press Enter to accept)',
          value: message,
          ignoreFocusOut: true
        });
        if (!confirmed) return;

        const commitResult = await this.runGit(['commit', '-m', confirmed]);
        vscode.window.showInformationMessage('Navy: ' + commitResult.trim().split('\n')[0]);
      } catch (e) {
        vscode.window.showErrorMessage('Navy: ' + e.message);
      }
    });
  }

  async generatePRDescription() {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { vscode.window.showErrorMessage('Navy: No project root detected.'); return; }

    const [log, diff] = await Promise.all([
      this.runGit(['log', 'main..HEAD', '--oneline']).catch(() => this.runGit(['log', 'master..HEAD', '--oneline'])),
      this.runGit(['diff', 'main...HEAD']).catch(() => this.runGit(['diff', 'master...HEAD']))
    ]);

    if (!log.trim() && !diff.trim()) {
      vscode.window.showInformationMessage('Navy: No commits ahead of main.'); return;
    }

    const config = vscode.workspace.getConfiguration('navy');
    const host = config.get('host', 'http://localhost:11434').replace(/\/$/, '');
    const model = config.get('model', '');

    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Navy: Generating PR description…', cancellable: false }, async () => {
      try {
        const prText = await this._completeOnce(host, model, [
          { role: 'system', content: 'You write clear GitHub pull request descriptions in markdown. Include: a short title line, a ## Summary section with bullet points, and a ## Changes section. Be concise and factual.' },
          { role: 'user', content: `Generate a PR description for these changes:\n\nCommits:\n${log}\n\nDiff (truncated):\n${diff.slice(0, 5000)}` }
        ]);
        if (!prText) { vscode.window.showErrorMessage('Navy: Failed to generate PR description.'); return; }

        const doc = await vscode.workspace.openTextDocument({ content: prText, language: 'markdown' });
        await vscode.window.showTextDocument(doc);
      } catch (e) {
        vscode.window.showErrorMessage('Navy: ' + e.message);
      }
    });
  }

  async explainTerminalError() {
    await this.focus();
    const clipboardText = await vscode.env.clipboard.readText();
    if (!clipboardText || clipboardText.trim() === '') {
      vscode.window.showInformationMessage('Please copy the terminal error to your clipboard first.');
      return;
    }
    this.askNavy(`I encountered this error. Please explain it and how to fix it:\n\n\`\`\`\n${clipboardText.slice(0, 5000)}\n\`\`\``, true)
      .catch(e => this._reportTurnFailure(e, 'explain terminal error'));
  }

  async runTestsCommand() {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { vscode.window.showErrorMessage('Navy: No project root detected.'); return; }

    const filter = await vscode.window.showInputBox({
      prompt: 'Test filter (leave empty to run all tests)',
      placeHolder: 'e.g. auth, login, UserService',
      ignoreFocusOut: true
    });
    if (filter === undefined) return;

    await this.focus();
    await this.askNavy(`Run the test suite${filter ? ` filtering for "${filter}"` : ''} and report any failures with explanations and fixes.`, false, null, []);
  }

  getHtml(webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'styles.css'));
    const version = this.context.extension?.packageJSON?.version || '';
    return getWebviewHtml({ scriptUri, styleUri, cspSource: webview.cspSource, nonce: getNonce(), version });
  }
}

function getEditorContext(maxChars) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return 'No active editor.';
  const document = editor.document;
  const selections = editor.selections.filter((s) => !s.isEmpty).map((s) => document.getText(s));
  if (selections.length > 0) {
    const selected = selections.join('\n\n---\n\n');
    return [
      'File: ' + document.fileName,
      'Language: ' + document.languageId,
      'Selected text:',
      selected.length > maxChars ? selected.slice(0, maxChars) + '\n\n[Truncated to ' + maxChars + ' characters]' : selected
    ].join('\n');
  }
  const fullText = document.getText();
  const truncated = fullText.length > maxChars ? fullText.slice(0, maxChars) + '\n\n[Truncated to first ' + maxChars + ' characters]' : fullText;
  return ['File: ' + document.fileName, 'Language: ' + document.languageId, 'File text:', truncated].join('\n');
}

function getNonce() {
  return crypto.randomBytes(24).toString('base64url');
}

// In-memory content provider that serves proposed file content for the VS Code diff editor.
class NavyProposedContentProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChange = this._emitter.event;
    this._contents = new Map();
  }
  set(id, content) {
    this._contents.set(id, content);
    this._emitter.fire(vscode.Uri.parse(`navy-proposed:${id}`));
  }
  delete(id) { this._contents.delete(id); }
  provideTextDocumentContent(uri) {
    // URI path is "id/encoded-filename" — split on first slash.
    const id = uri.path.split('/')[0];
    return this._contents.get(id) || '';
  }
}

class NavyFixCodeActionProvider {
  constructor(provider) { this._provider = provider; }
  provideCodeActions(document, _range, context) {
    if (!context.diagnostics.length) return [];
    return context.diagnostics.map(diag => {
      const sev = diag.severity === 0 ? 'error' : 'warning';
      const action = new vscode.CodeAction(`⚓ Navy: fix this ${sev}`, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diag];
      action.isPreferred = false;
      action.command = {
        command: 'navy.fixDiagnostic',
        title: `Navy: fix ${sev}`,
        arguments: [document.uri, diag],
      };
      return action;
    });
  }
}

class NavyCodeLensProvider {
  constructor(provider) {
    this._provider = provider;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this._onDidChange.event;
  }

  provideCodeLenses(document) {
    const config = vscode.workspace.getConfiguration('navy');
    if (!config.get('codeLens', true)) return [];

    const lenses = [];
    const text = document.getText();
    const lines = text.split('\n');
    const fnPattern = /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w+|^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(|^\s*(public|private|protected|static|\s)*(async\s+)?\w+\s*\([^)]*\)\s*[\{:]|^\s*def\s+\w+\s*\(|^\s*(pub\s+)?(async\s+)?fn\s+\w+/;

    for (let i = 0; i < Math.min(lines.length, 500); i++) {
      if (fnPattern.test(lines[i])) {
        const range = new vscode.Range(i, 0, i, 0);
        lenses.push(new vscode.CodeLens(range, {
          title: '⚓ Ask Navy',
          command: 'navy.askAboutLine',
          arguments: [document.uri, i + 1]
        }));
      }
    }
    return lenses;
  }
}

// Should Navy send this document's contents to a completion provider?
// Inline completions fire on every keystroke, so an over-broad registration
// silently streams whatever file happens to be open — including credential
// files a user opened just to read. Requires: a real on-disk file, inside the
// workspace, that isn't credential-shaped. Pure apart from the two inputs.
function documentEligibleForCompletion(document, folderPaths) {
  if (!document || document.uri?.scheme !== 'file') return false;
  const fsPath = document.uri.fsPath || '';
  if (!fsPath) return false;
  if (isSensitiveForEmbedding(fsPath)) return false; // same credential-name filter
  return rootBelongsToWorkspace(fsPath, folderPaths);
}

// A model given both prefix and suffix context (FIM) sometimes "overshoots"
// and echoes part of the suffix back at the end of its completion instead of
// stopping right before it. Trims the longest matching overlap between the
// end of `completion` and the start of `suffix`, so that text isn't inserted
// twice. Pure — greedy longest-match, capped so it can't scan huge strings.
function stripSuffixOverlap(completion, suffix) {
  if (!completion || !suffix) return completion;
  const maxCheck = Math.min(completion.length, suffix.length, 200);
  for (let n = maxCheck; n > 0; n--) {
    if (completion.slice(-n) === suffix.slice(0, n)) return completion.slice(0, -n);
  }
  return completion;
}

function activate(context) {
  const proposedProvider = new NavyProposedContentProvider();
  context.__navyProposedProvider = proposedProvider;

  const provider = new NavyCoderViewProvider(context);

  // Output channel: the home for best-effort failures (checkpoint persistence,
  // MCP server chatter, provider errors) — View → Output → "Navy Coder".
  const outputChannel = vscode.window.createOutputChannel('Navy Coder');
  context.subscriptions.push(outputChannel);
  provider.log = (line) => {
    const stamped = new Date().toISOString().slice(11, 19) + '  ' + line;
    outputChannel.appendLine(stamped);
    provider._recordLogLine(stamped);
  };
  // The manifest is the only place the version is not a guess.
  provider._diagnosticsVersion = context.extension?.packageJSON?.version || '';
  // Reveal the channel (without stealing focus) the first time the webview
  // reports a stall — a randomly-freezing panel is only diagnosable if the
  // evidence surfaces on its own rather than waiting to be looked for.
  let _shownForStall = false;
  provider.outputChannelShow = () => {
    if (_shownForStall) return;
    _shownForStall = true;
    try { outputChannel.show(true); } catch {}
  };

  // First-run welcome — point new users at the sidebar so they know where Navy lives.
  if (!context.globalState.get('navy.welcomed')) {
    context.globalState.update('navy.welcomed', true);
    vscode.window.showInformationMessage(
      'Navy AI Coder is ready — find it at the ☸ wheel icon in the activity bar (left edge).',
      'Open Navy'
    ).then((choice) => {
      if (choice === 'Open Navy') vscode.commands.executeCommand('navy.chatView.focus');
    });
  }

  // ── Status bar item ─────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.name    = 'Navy AI Coder';
  statusBar.text    = '☸ Navy';
  statusBar.tooltip = 'Navy AI Coder — click to open';
  statusBar.command = 'navy.focusChat';
  statusBar.show();
  context.subscriptions.push(statusBar);
  provider.statusBarItem = statusBar;

  // Inline ghost-text completions — routes to the active provider (or the
  // separate, faster navy.completionModel if set) with debounce.
  let _inlineReqId = 0;
  const inlineCompletionProvider = {
    async provideInlineCompletionItems(document, position, _ctx, token) {
      const config = vscode.workspace.getConfiguration('navy');
      if (!config.get('inlineCompletions', false)) return [];
      if (!workspaceIsTrusted()) return [];
      // Registered on '**', so this is where scope is actually enforced: only
      // real files inside the workspace, never credential-shaped ones.
      const folderPaths = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
      if (!documentEligibleForCompletion(document, folderPaths)) return [];
      // A separate model exists specifically so completions (which need low
      // latency) don't have to share a slow/large chat model just because
      // that's what navy.model is set to.
      const model = config.get('completionModel', '').trim() || config.get('model', '');
      if (!model) return [];

      const reqId = ++_inlineReqId;
      await new Promise(r => setTimeout(r, 350));
      if (reqId !== _inlineReqId || token.isCancellationRequested) return [];

      const startLine = Math.max(0, position.line - 20);
      const prefix = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
      if (!prefix.trim()) return [];
      // Fill-in-middle context: code AFTER the cursor. Without this the model
      // has no idea a closing brace/return/next statement is right there and
      // routinely duplicates or contradicts it — this matters most for
      // completions requested mid-function, the common case while editing.
      const endLine = Math.min(document.lineCount, position.line + 20);
      const suffix = document.getText(new vscode.Range(position, new vscode.Position(endLine, 0))).slice(0, 2000);

      const aiProvider = config.get('provider', 'ollama');
      const host       = config.get('host', 'http://localhost:11434').replace(/\/$/, '');
      const apiBase    = config.get('apiBase', '');
      const apiKey     = await provider.context.secrets.get('navy.apiKey.' + aiProvider)
                       || await provider.context.secrets.get('navy.apiKey') || '';

      const ctrl = new AbortController();
      token.onCancellationRequested(() => ctrl.abort());

      try {
        let completion = '';

        if (aiProvider === 'ollama') {
          // Ollama's /api/generate has native FIM support via `suffix` for
          // FIM-capable models (qwen2.5-coder, deepseek-coder, codegemma, …).
          const res = await fetch(provider._ollamaBase() + '/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...ollamaAuthHeaders(apiKey) },
            body: JSON.stringify({ model, prompt: prefix, suffix, stream: false,
              options: { temperature: 0.05, num_predict: 80, stop: ['\n\n', '```', '\nfunction ', '\nclass ', '\ndef '] } }),
            signal: ctrl.signal,
          });
          if (!res.ok) return [];
          const data = await res.json();
          completion = (data.response || '').trimEnd();

        } else if (aiProvider === 'anthropic') {
          const baseUrl = apiBase || 'https://api.anthropic.com';
          const res = await fetch(baseUrl + '/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey,
              'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model, max_tokens: 80, temperature: 0.05,
              system: 'You are a code completion engine filling in the gap between CODE BEFORE and CODE AFTER. Output ONLY the missing middle — no explanation, no markdown fences, and do NOT repeat any part of CODE AFTER.',
              messages: [{ role: 'user', content: `CODE BEFORE:\n${prefix}\n\nCODE AFTER:\n${suffix}` }] }),
            signal: ctrl.signal,
          });
          if (!res.ok) return [];
          const data = await res.json();
          completion = stripSuffixOverlap((data.content?.[0]?.text || '').trimEnd(), suffix);

        } else {
          const base = openAiCompatBase(aiProvider, apiBase, host) || host;
          const headers = { 'Content-Type': 'application/json' };
          if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
          const res = await fetch(base + '/chat/completions', {
            method: 'POST',
            headers,
            body: JSON.stringify({ model, max_tokens: 80, temperature: 0.05,
              messages: [
                { role: 'system', content: 'You are a code completion engine filling in the gap between CODE BEFORE and CODE AFTER. Output ONLY the missing middle — no explanation, no markdown fences, no repeating CODE BEFORE, and do NOT repeat any part of CODE AFTER.' },
                { role: 'user', content: `CODE BEFORE:\n${prefix}\n\nCODE AFTER:\n${suffix}` },
              ] }),
            signal: ctrl.signal,
          });
          if (!res.ok) return [];
          const data = await res.json();
          completion = stripSuffixOverlap((data.choices?.[0]?.message?.content || '').trimEnd(), suffix);
        }

        if (!completion || token.isCancellationRequested) return [];
        return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
      } catch { return []; }
    }
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('navy-proposed', proposedProvider),
    vscode.window.registerWebviewViewProvider('navy.chatView', provider),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineCompletionProvider),
    vscode.commands.registerCommand('navy.focusChat', () => provider.focus()),
    vscode.commands.registerCommand('navy.insertLastReply', () => provider.insertLastReply()),
    vscode.commands.registerCommand('navy.clearChat', () => provider.clearChat()),
    vscode.commands.registerCommand('navy.undoLastEdit', () => provider.undoLastCheckpoint()),
    vscode.commands.registerCommand('navy.undoLastTurn', () => provider.undoLastTurn()),
    vscode.commands.registerCommand('navy.redoLastUndo', () => provider.redoLast()),
    vscode.commands.registerCommand('navy.inlineEdit', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sel = editor.selection;
      const selectedText = sel.isEmpty
        ? editor.document.lineAt(sel.active.line).text
        : editor.document.getText(sel);

      const instruction = await vscode.window.showInputBox({
        prompt: 'What should Navy change?',
        placeHolder: 'e.g. add error handling, convert to async/await, add JSDoc',
        ignoreFocusOut: true
      });
      if (!instruction) return;

      const filePath = editor.document.fileName;
      const lang = editor.document.languageId;
      const prompt = `You are editing a ${lang} file. Edit ONLY the following code snippet as instructed. Return ONLY the edited code with no explanation, no markdown fences, no extra text.\n\nInstruction: ${instruction}\n\nCode to edit:\n${selectedText}`;
      await provider.focus();
      await provider.askNavy(prompt, false, null, [filePath]);
    }),
    vscode.commands.registerCommand('navy.generateCommit', () => provider.generateCommit()),
    vscode.commands.registerCommand('navy.generatePR', () => provider.generatePRDescription()),
    vscode.commands.registerCommand('navy.runTests', () => provider.runTestsCommand()),
    vscode.commands.registerCommand('navy.askAboutLine', async (uri, line) => {
      await provider.focus();
      const relativePath = vscode.workspace.asRelativePath(uri);
      provider.askNavy(`Explain the function at line ${line} of ${relativePath}. What does it do, are there any issues, and how could it be improved?`, false, null, [uri.fsPath]);
    }),
    vscode.commands.registerCommand('navy.explainTerminalError', () => provider.explainTerminalError()),
    vscode.languages.registerCodeLensProvider({ pattern: '**/*.{js,ts,jsx,tsx,py,rs,go,java,cs,cpp,c,rb,php}' }, new NavyCodeLensProvider(provider)),
    vscode.languages.registerCodeActionsProvider({ pattern: '**' }, new NavyFixCodeActionProvider(provider), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.commands.registerCommand('navy.fixDiagnostic', async (uri, diag) => {
      const rel = vscode.workspace.asRelativePath(uri);
      const line = diag.range.start.line + 1;
      const sev = diag.severity === 0 ? 'error' : 'warning';
      const prompt = `Fix the ${sev} on line ${line} of ${rel}:\n\n"${diag.message}"\n\nRead the file, understand the root cause, then apply the minimal correct fix.`;
      await provider.focus();
      provider.askNavy(prompt, false, null, [uri.fsPath]);
    }),
    vscode.commands.registerCommand('navy.exportConversation', () => provider.view?.webview.postMessage({ type: 'requestExport' })),
    vscode.commands.registerCommand('navy.reviewPR', () => provider.generatePRReview()),
    vscode.commands.registerCommand('navy.testProvider', () => provider.testProviderConnection()),
    vscode.commands.registerCommand('navy.exportDiagnostics', () => provider.exportDiagnostics()),
    vscode.commands.registerCommand('navy.newSlashCommand', () => provider.createSlashCommand()),
    vscode.commands.registerCommand('navy.openSlashCommands', () => provider.openSlashCommandsFolder()),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) provider.applyGutterDecorations(editor);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.sendWorkspaceFolders()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('navy.mcpServers')) provider.reloadMcpServers();
      // Navy no longer writes this setting, so a change to it is necessarily the
      // user's own edit — and therefore an instruction to switch project.
      if (e.affectsConfiguration('navy.projectRoot')) {
        provider.adoptConfiguredProjectRoot().catch(() => {});
      }
    }),
    { dispose: () => provider.dispose() }
  );

  // Connect configured MCP servers in the background — never blocks activation.
  provider.reloadMcpServers();
  // Watch the workspace so the repo-map/relevance/gitignore caches expire on
  // real changes instead of on a timer. Disposed via provider.dispose() above.
  provider._startFileWatcher();
}

// The global project catalog, moved out to src/projects.js. Mixed into the
// prototype rather than passed a provider instance: the methods keep using
// `this` exactly as they did when they were written inline, so the extraction
// changed no call site, no signature and no behaviour — which is the only way
// a move of this size stays reviewable.
// ── Extracted method groups ─────────────────────────────────────────────────
// Each module below holds a contiguous run of methods lifted out of this file
// verbatim. They are still methods on this class — `this` means what it always
// did — so no call site, signature or behaviour changed in the move.
//
// Class-prototype methods are non-enumerable, so Object.assign skips them: the
// descriptors are copied instead. That is what lets a block move as a class
// body with no retyping, which is the only way a move of this size stays
// reviewable.
function mixinPrototype(target, source) {
  for (const key of Object.getOwnPropertyNames(source)) {
    if (key === 'constructor') continue;
    Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
  }
}

Object.assign(NavyCoderViewProvider.prototype, PROJECT_CATALOG_METHODS);
mixinPrototype(NavyCoderViewProvider.prototype, RETRIEVAL_METHODS);
mixinPrototype(NavyCoderViewProvider.prototype, SANDBOX_METHODS);
mixinPrototype(NavyCoderViewProvider.prototype, BACKGROUND_METHODS);
mixinPrototype(NavyCoderViewProvider.prototype, NET_SAFETY_METHODS);
mixinPrototype(NavyCoderViewProvider.prototype, UNDO_METHODS);
mixinPrototype(NavyCoderViewProvider.prototype, WEB_SEARCH_METHODS);
mixinPrototype(NavyCoderViewProvider.prototype, DIAGNOSTICS_METHODS);
mixinPrototype(NavyCoderViewProvider.prototype, PLAN_METHODS);
Object.assign(NavyCoderViewProvider.prototype, SLASH_COMMAND_METHODS);
Object.assign(NavyCoderViewProvider.prototype, SKILL_METHODS);

function deactivate() {}

// NavyCoderViewProvider is exported for the test suite (test/run.js drives its
// undo/redo/checkpoint logic against a mock vscode + real temp filesystem).
// sessionContext is exported so tests can directly verify that code running
// inside it stays bound to the session it started with, independent of
// mocking a full turn's model/tool call chain.
module.exports = { activate, deactivate, NavyCoderViewProvider, sessionContext, estimateCost, PRICING_AS_OF, resolveModelContext, contextWindowOptions,
  // Exported for the session-restore tests: what a card record keeps, and what
  // it deliberately drops, is what decides both how a reopened chat looks and
  // how large .navy/chats/<id>.json gets.
  makeCardRecord,
  // Exported for the semantic-index tests: the encoding is the part where a
  // silent corruption would be worst (a wrong-length vector compared against a
  // right-length one), so it is covered directly rather than only end-to-end.
  encodeVector, decodeVector, shardOf };
