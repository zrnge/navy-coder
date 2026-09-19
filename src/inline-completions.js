'use strict';

// Inline (ghost-text) completions: the suggestions you accept with Tab.
//
// Speed is the whole feature, and most of it does not come from the model.
//   - A suggestion you are typing straight through costs no request at all:
//     recent answers are kept, and replayed as you type the characters they
//     predicted (CompletionCache).
//   - With code still to the right of the cursor, only the rest of that line is
//     asked for - shorter to generate, and it cannot run over what follows.
//   - Providers with a real fill-in-the-middle endpoint get one: Ollama's
//     /api/generate with a suffix, and DeepSeek's /beta/completions. A FIM
//     model continues code where the cursor is; a chat model has to be told to.
//   - A local Ollama model is loaded before the first keystroke and kept loaded
//     between pauses. Ollama unloads after five idle minutes by default, and
//     reloading one costs seconds on the first keystroke back.

const { openAiCompatBase, ollamaAuthHeaders, ANTHROPIC_BASE } = require('./providers/endpoints.js');

const COMPLETION_DEBOUNCE_MS = 200;
const PREFIX_MAX_LINES = 80;
const PREFIX_MAX_CHARS = 4000;
const SUFFIX_MAX_LINES = 40;
const SUFFIX_MAX_CHARS = 1500;
const OLLAMA_KEEP_ALIVE = '30m';
const DEEPSEEK_FIM_BASE = 'https://api.deepseek.com/beta';
const CACHE_ANCHOR_CHARS = 400;   // how much of the text before the cursor identifies a spot
const CACHE_AFTER_CHARS = 200;    // ...and of the text after it
const SLOW_COMPLETION_MS = 2000;

// Line-comment syntax by VS Code languageId, for the one-line "this is
// src/app.js" hint a completion prompt opens with. A language not listed gets
// no hint rather than a comment in the wrong syntax.
const LINE_COMMENT = {
  javascript: '//', javascriptreact: '//', typescript: '//', typescriptreact: '//',
  java: '//', c: '//', cpp: '//', csharp: '//', go: '//', rust: '//', swift: '//',
  kotlin: '//', scala: '//', dart: '//', php: '//',
  python: '#', ruby: '#', shellscript: '#', perl: '#', r: '#', yaml: '#', toml: '#',
  dockerfile: '#', makefile: '#', powershell: '#',
  sql: '--', lua: '--', haskell: '--',
};

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

// What to send for a completion at the cursor, from the text either side of
// it. Pure. `mode` is 'line' when code follows the cursor on its own line -
// only the middle of that line is missing - and 'block' otherwise.
function buildCompletionContext({ before, after, relPath = '', languageId = '' }) {
  let prefix = String(before || '');
  const lines = prefix.split('\n');
  if (lines.length > PREFIX_MAX_LINES) prefix = lines.slice(-PREFIX_MAX_LINES).join('\n');
  if (prefix.length > PREFIX_MAX_CHARS) prefix = prefix.slice(-PREFIX_MAX_CHARS);
  const rest = String(after || '');
  const suffix = rest.split('\n').slice(0, SUFFIX_MAX_LINES).join('\n').slice(0, SUFFIX_MAX_CHARS);
  const mode = rest.split('\n', 1)[0].trim() ? 'line' : 'block';
  const comment = LINE_COMMENT[languageId];
  const header = comment && relPath ? `${comment} ${relPath}\n` : '';
  return { prefix, suffix, mode, header, relPath, languageId };
}

// The model's answer, made safe to insert: no markdown fence a chat model
// added anyway, no trailing whitespace, one line in 'line' mode, and none of
// the text that already follows the cursor. Pure.
function finishCompletion(text, { suffix = '', mode = 'block' } = {}) {
  let out = String(text || '');
  out = out.replace(/^```[\w+-]*\r?\n/, '').replace(/\r?\n?```\s*$/, '');
  out = out.replace(/\s+$/, '');
  if (mode === 'line') out = out.split('\n', 1)[0].replace(/\r$/, '');
  return stripSuffixOverlap(out, suffix);
}

// Recent suggestions, so typing through one costs nothing. A suggestion made
// at a spot is still good while the text before the cursor is that spot plus
// the first characters of the suggestion itself, and the text after the cursor
// has not changed.
class CompletionCache {
  constructor(max = 30) {
    this.max = max;
    this.entries = [];
  }

  remember(key, before, after, completion) {
    if (!completion) return;
    this.entries.push({
      key,
      anchor: String(before).slice(-CACHE_ANCHOR_CHARS),
      afterHead: String(after).slice(0, CACHE_AFTER_CHARS),
      completion,
    });
    if (this.entries.length > this.max) this.entries.shift();
  }

  // The part of a remembered suggestion still to come, or null.
  lookup(key, before, after) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.key !== key || !String(after).startsWith(e.afterHead)) continue;
      const most = Math.min(e.completion.length - 1, before.length - e.anchor.length);
      for (let typed = 0; typed <= most; typed++) {
        const at = before.length - typed;
        if (before.startsWith(e.anchor, at - e.anchor.length) && before.startsWith(e.completion.slice(0, typed), at)) {
          return e.completion.slice(typed);
        }
      }
    }
    return null;
  }
}

const CHAT_SYSTEM = 'You are a code completion engine filling in the gap between CODE BEFORE and CODE AFTER. '
  + 'Output ONLY the missing middle — no explanation, no markdown fences, no repeating CODE BEFORE, '
  + 'and do NOT repeat any part of CODE AFTER.';

function chatUserPrompt(ctx) {
  const where = ctx.relPath ? `File: ${ctx.relPath}${ctx.languageId ? ' (' + ctx.languageId + ')' : ''}\n` : '';
  const shape = ctx.mode === 'line' ? 'Complete only the rest of the current line.\n' : '';
  return `${where}${shape}CODE BEFORE:\n${ctx.prefix}\n\nCODE AFTER:\n${ctx.suffix}`;
}

// One completion from the configured provider. Returns the raw text ('' when
// the provider had nothing or said no); finishCompletion makes it insertable.
// `state.deepseekFimOff` is set once DeepSeek refuses FIM for this model or
// endpoint, so later requests go straight to chat.
async function requestCompletion(opts) {
  const {
    provider, model, host, apiBase, apiKey, ollamaBase, ctx, signal,
    fetchImpl = fetch, state = {},
  } = opts;
  const maxTokens = ctx.mode === 'line' ? 48 : 128;
  const stop = ctx.mode === 'line'
    ? ['\n']
    : ['\n\n', '```', '\nfunction ', '\nclass ', '\ndef '];
  const json = (headers, body) => ({
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal,
  });

  if (provider === 'ollama') {
    const res = await fetchImpl(ollamaBase + '/api/generate', json(ollamaAuthHeaders(apiKey), {
      model, prompt: ctx.header + ctx.prefix, suffix: ctx.suffix, stream: false, keep_alive: OLLAMA_KEEP_ALIVE,
      options: { temperature: 0.05, num_predict: maxTokens, stop },
    }));
    if (!res.ok) return '';
    return (await res.json()).response || '';
  }

  if (provider === 'deepseek' && !state.deepseekFimOff) {
    const base = apiBase ? String(apiBase).replace(/\/+$/, '').replace(/\/v1$/, '') + '/beta' : DEEPSEEK_FIM_BASE;
    const res = await fetchImpl(base + '/completions', json({ Authorization: 'Bearer ' + apiKey }, {
      model, prompt: ctx.header + ctx.prefix, suffix: ctx.suffix, max_tokens: maxTokens, temperature: 0.05, stop,
    }));
    if (res.ok) return (await res.json()).choices?.[0]?.text || '';
    // This model or endpoint does not do FIM: chat from now on. Anything else
    // (a rate limit, an outage) is not a reason to give FIM up for good.
    if (res.status === 400 || res.status === 404 || res.status === 422) state.deepseekFimOff = true;
    else return '';
  }

  if (provider === 'anthropic') {
    const res = await fetchImpl((apiBase || ANTHROPIC_BASE) + '/v1/messages', json(
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: maxTokens, temperature: 0.05, system: CHAT_SYSTEM, messages: [{ role: 'user', content: chatUserPrompt(ctx) }] }));
    if (!res.ok) return '';
    return (await res.json()).content?.[0]?.text || '';
  }

  const base = openAiCompatBase(provider, apiBase, host) || host;
  const res = await fetchImpl(base + '/chat/completions', json(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}, {
    model, max_tokens: maxTokens, temperature: 0.05,
    messages: [{ role: 'system', content: CHAT_SYSTEM }, { role: 'user', content: chatUserPrompt(ctx) }],
  }));
  if (!res.ok) return '';
  return (await res.json()).choices?.[0]?.message?.content || '';
}

// Loads the completion model ahead of the first keystroke and asks Ollama to
// keep it loaded between pauses. A generate request with no prompt loads a
// model without generating anything.
async function warmOllamaModel({ ollamaBase, model, apiKey, fetchImpl = fetch }) {
  try {
    await fetchImpl(ollamaBase + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ollamaAuthHeaders(apiKey) },
      body: JSON.stringify({ model, keep_alive: OLLAMA_KEEP_ALIVE }),
    });
  } catch { /* best effort: the first completion simply loads it instead */ }
}

// The provider VS Code calls on every keystroke. Everything it touches comes
// in through `deps`, so the tests drive it with a fake document and fetch.
function createInlineCompletionProvider(deps) {
  const {
    vscode, getConfig, getApiKey, ollamaBase, eligible, isTrusted, log,
    fetchImpl = (...a) => fetch(...a), debounceMs = COMPLETION_DEBOUNCE_MS,
  } = deps;
  const cache = new CompletionCache();
  const state = { reqId: 0, deepseekFimOff: false, requests: 0, cacheHits: 0, totalMs: 0 };

  return {
    cache,
    state,
    async provideInlineCompletionItems(document, position, _context, token) {
      const config = getConfig();
      if (!config.get('inlineCompletions', false)) return [];
      if (!isTrusted()) return [];
      if (!eligible(document)) return [];
      // A separate model exists so completions, which need low latency, don't
      // have to share a slow or large chat model.
      const model = config.get('completionModel', '').trim() || config.get('model', '');
      if (!model) return [];

      const startLine = Math.max(0, position.line - PREFIX_MAX_LINES);
      const before = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
      if (!before.trim()) return [];
      const endLine = Math.min(document.lineCount, position.line + SUFFIX_MAX_LINES);
      const after = document.getText(new vscode.Range(position, new vscode.Position(endLine, 0)));
      const key = String(document.uri);
      const item = (text) => [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];

      // Typing through a suggestion: answer at once, no debounce, no request.
      const rest = cache.lookup(key, before, after);
      if (rest) {
        state.cacheHits++;
        return item(rest);
      }

      const reqId = ++state.reqId;
      if (debounceMs) await new Promise(r => setTimeout(r, debounceMs));
      if (reqId !== state.reqId || token.isCancellationRequested) return [];

      const relPath = vscode.workspace?.asRelativePath ? vscode.workspace.asRelativePath(document.uri, false) : '';
      const ctx = buildCompletionContext({ before, after, relPath: String(relPath || ''), languageId: document.languageId || '' });
      const provider = config.get('provider', 'ollama');
      const ctrl = new AbortController();
      const sub = token.onCancellationRequested ? token.onCancellationRequested(() => ctrl.abort()) : null;
      const started = Date.now();
      try {
        const raw = await requestCompletion({
          provider, model, ctx, signal: ctrl.signal, fetchImpl, state,
          host: config.get('host', 'http://localhost:11434').replace(/\/$/, ''),
          apiBase: config.get('apiBase', ''),
          apiKey: await getApiKey(provider),
          ollamaBase: ollamaBase(),
        });
        const ms = Date.now() - started;
        state.requests++;
        state.totalMs += ms;
        if (ms > SLOW_COMPLETION_MS) {
          log?.(`inline completion took ${ms} ms (${provider} ${model}) — a small navy.completionModel answers much faster`);
        }
        const completion = finishCompletion(raw, ctx);
        if (!completion || token.isCancellationRequested) return [];
        cache.remember(key, before, after, completion);
        return item(completion);
      } catch {
        return [];
      } finally {
        if (sub && sub.dispose) sub.dispose();
      }
    },
  };
}

module.exports = {
  createInlineCompletionProvider, requestCompletion, warmOllamaModel,
  buildCompletionContext, finishCompletion, stripSuffixOverlap, CompletionCache,
  COMPLETION_DEBOUNCE_MS, OLLAMA_KEEP_ALIVE, DEEPSEEK_FIM_BASE,
};
