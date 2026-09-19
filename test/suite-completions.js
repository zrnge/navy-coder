const { check } = require('./harness.js');
const {
  createInlineCompletionProvider, requestCompletion, warmOllamaModel,
  buildCompletionContext, finishCompletion, CompletionCache, OLLAMA_KEEP_ALIVE,
} = require('../src/inline-completions.js');

// Tab-to-accept completions: what is asked for, from whom, and when nothing
// needs to be asked at all. Driven with a fake document and a fake fetch, so
// every request the provider would send is visible here.

class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
class InlineCompletionItem { constructor(insertText, range) { this.insertText = insertText; this.range = range; } }
const fakeVscode = { Position, Range, InlineCompletionItem, workspace: { asRelativePath: () => 'src/app.js' } };

function fakeDoc(text, { uri = 'file:///proj/src/app.js', languageId = 'javascript' } = {}) {
  const lines = text.split('\n');
  const offset = (p) => {
    if (p.line >= lines.length) return text.length;
    let o = 0;
    for (let i = 0; i < p.line; i++) o += lines[i].length + 1;
    return Math.min(o + p.character, text.length);
  };
  return {
    uri: { toString: () => uri, fsPath: '/proj/src/app.js', scheme: 'file' },
    languageId,
    lineCount: lines.length,
    getText: (r) => text.slice(offset(r.start), offset(r.end)),
  };
}

// The cursor is where `|` is.
function at(textWithCursor) {
  const i = textWithCursor.indexOf('|');
  const text = textWithCursor.slice(0, i) + textWithCursor.slice(i + 1);
  const before = text.slice(0, i).split('\n');
  return { doc: fakeDoc(text), pos: new Position(before.length - 1, before[before.length - 1].length) };
}

const config = (values) => ({ get: (k, d) => (k in values ? values[k] : d) });
const token = () => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

async function completionsSuite() {
  console.log('\ninline completions:');

  // ── What is asked for ──────────────────────────────────────────────────────
  const mid = buildCompletionContext({ before: 'const total = add(', after: 'a, b);\nreturn total;', relPath: 'src/app.js', languageId: 'javascript' });
  check('context: code to the right of the cursor asks for the rest of one line', mid.mode === 'line');
  const eol = buildCompletionContext({ before: 'function add(a, b) {\n  ', after: '\n}\n', relPath: 'src/app.js', languageId: 'javascript' });
  check('context: nothing to the right asks for a block', eol.mode === 'block');
  check('context: the prompt names the file, in the language\'s own comment syntax',
    eol.header === '// src/app.js\n'
    && buildCompletionContext({ before: 'x', after: '', relPath: 'tool.py', languageId: 'python' }).header === '# tool.py\n');
  check('context: ...and a language without line comments gets no hint rather than a wrong one',
    buildCompletionContext({ before: 'x', after: '', relPath: 'notes.md', languageId: 'markdown' }).header === '');
  const big = buildCompletionContext({
    before: Array.from({ length: 300 }, (_, i) => 'line ' + i).join('\n'),
    after: Array.from({ length: 300 }, (_, i) => 'after ' + i).join('\n'),
  });
  check('context: both sides are bounded, keeping what is nearest the cursor',
    big.prefix.split('\n').length <= 80 && big.prefix.length <= 4000 && big.prefix.endsWith('line 299')
    && big.suffix.split('\n').length <= 40 && big.suffix.startsWith('after 0'));

  // ── What gets inserted ─────────────────────────────────────────────────────
  check('finish: a fence a chat model added anyway is dropped',
    finishCompletion('```js\nreturn a + b;\n```', { mode: 'block' }) === 'return a + b;');
  check('finish: line mode keeps one line', finishCompletion('a, b);\nconsole.log(1);', { mode: 'line' }) === 'a, b);');
  check('finish: text already after the cursor is not inserted a second time',
    finishCompletion('a, b);', { mode: 'line', suffix: ');\nreturn total;' }) === 'a, b');

  // ── Typing through a suggestion ────────────────────────────────────────────
  const cache = new CompletionCache();
  const spot = 'function add(a, b) {\n  return ';
  cache.remember('doc', spot, '\n}', 'a + b;');
  check('cache: the same spot gets the same suggestion back', cache.lookup('doc', spot, '\n}') === 'a + b;');
  check('cache: typing through it leaves the rest of it', cache.lookup('doc', spot + 'a +', '\n}') === ' b;');
  check('cache: typing something else is a miss', cache.lookup('doc', spot + 'x', '\n}') === null);
  check('cache: ...and so is a change after the cursor', cache.lookup('doc', spot + 'a', '\n  }') === null);
  check('cache: ...or another document', cache.lookup('other', spot, '\n}') === null);
  check('cache: typing the whole suggestion leaves nothing to suggest', cache.lookup('doc', spot + 'a + b;', '\n}') === null);
  const small = new CompletionCache(2);
  small.remember('a', 'x', '', '1');
  small.remember('b', 'x', '', '2');
  small.remember('c', 'x', '', '3');
  check('cache: bounded, oldest first out', small.entries.length === 2 && small.lookup('a', 'x', '') === null && small.lookup('c', 'x', '') === '3');

  // ── Who is asked, and how ──────────────────────────────────────────────────
  const calls = [];
  const replying = (reply, status = 200) => async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: status < 300, status, json: async () => reply };
  };
  const block = buildCompletionContext({ before: 'function add(a, b) {\n  ', after: '\n}', relPath: 'src/app.js', languageId: 'javascript' });

  calls.length = 0;
  const fromOllama = await requestCompletion({
    provider: 'ollama', model: 'qwen2.5-coder:1.5b', ollamaBase: 'http://localhost:11434', ctx: mid, fetchImpl: replying({ response: 'x, y' }),
  });
  const ob = calls[0].body;
  check('ollama: a real fill-in-the-middle request, suffix and all',
    calls[0].url === 'http://localhost:11434/api/generate' && ob.suffix === mid.suffix
    && ob.prompt === '// src/app.js\nconst total = add(' && ob.stream === false && fromOllama === 'x, y', JSON.stringify(ob));
  check('ollama: ...keeping the model loaded between pauses', ob.keep_alive === OLLAMA_KEEP_ALIVE);
  check('ollama: ...asking for one short line mid-line', ob.options.num_predict === 48 && JSON.stringify(ob.options.stop) === '["\\n"]');
  calls.length = 0;
  await requestCompletion({ provider: 'ollama', model: 'm', ollamaBase: 'http://o', ctx: block, fetchImpl: replying({ response: '' }) });
  check('ollama: ...and a longer block at the end of a line', calls[0].body.options.num_predict === 128 && calls[0].body.options.stop.includes('\n\n'));

  calls.length = 0;
  const fim = await requestCompletion({
    provider: 'deepseek', model: 'deepseek-flash', apiKey: 'k', ctx: block, state: {}, fetchImpl: replying({ choices: [{ text: 'return a + b;' }] }),
  });
  check('deepseek: uses its fill-in-the-middle endpoint, not chat',
    calls[0].url === 'https://api.deepseek.com/beta/completions' && calls[0].body.suffix === block.suffix
    && calls[0].body.prompt.endsWith(block.prefix) && calls[0].headers.Authorization === 'Bearer k' && fim === 'return a + b;');

  calls.length = 0;
  const refused = {};
  let n = 0;
  const refuseThenChat = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    n++;
    return n === 1
      ? { ok: false, status: 400, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'from chat' } }] }) };
  };
  const viaChat = await requestCompletion({ provider: 'deepseek', model: 'deepseek-chat', apiKey: 'k', ctx: block, state: refused, fetchImpl: refuseThenChat });
  check('deepseek: a model that refuses FIM gets chat instead',
    viaChat === 'from chat' && calls[1].url === 'https://api.deepseek.com/v1/chat/completions' && refused.deepseekFimOff === true);
  calls.length = 0;
  await requestCompletion({ provider: 'deepseek', model: 'deepseek-chat', apiKey: 'k', ctx: block, state: refused, fetchImpl: refuseThenChat });
  check('deepseek: ...and goes straight to chat after that', calls.length === 1 && /chat\/completions$/.test(calls[0].url));
  const limited = {};
  const rateLimited = await requestCompletion({ provider: 'deepseek', model: 'deepseek-flash', apiKey: 'k', ctx: block, state: limited, fetchImpl: replying({}, 429) });
  check('deepseek: a rate limit is not a reason to give FIM up', rateLimited === '' && !limited.deepseekFimOff);

  calls.length = 0;
  await requestCompletion({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k', ctx: mid, fetchImpl: replying({ content: [{ text: 'a' }] }) });
  check('anthropic: a chat request that names the file and asks for the rest of the line',
    calls[0].url === 'https://api.anthropic.com/v1/messages' && calls[0].body.max_tokens === 48
    && /File: src\/app\.js/.test(calls[0].body.messages[0].content) && /rest of the current line/.test(calls[0].body.messages[0].content));
  calls.length = 0;
  await requestCompletion({ provider: 'openai', model: 'gpt-5-mini', apiKey: 'k', ctx: block, fetchImpl: replying({ choices: [{ message: { content: 'b' } }] }) });
  check('openai-compatible: a chat request to the provider\'s own endpoint',
    calls[0].url === 'https://api.openai.com/v1/chat/completions' && calls[0].headers.Authorization === 'Bearer k'
    && calls[0].body.messages[0].role === 'system');

  calls.length = 0;
  await warmOllamaModel({ ollamaBase: 'http://localhost:11434', model: 'qwen2.5-coder:1.5b', apiKey: '', fetchImpl: replying({}) });
  check('warm-up: loads the model and keeps it loaded, without generating anything',
    calls[0].url === 'http://localhost:11434/api/generate' && calls[0].body.model === 'qwen2.5-coder:1.5b'
    && calls[0].body.keep_alive === OLLAMA_KEEP_ALIVE && calls[0].body.prompt === undefined);

  // ── The provider VS Code calls ─────────────────────────────────────────────
  let sent = 0;
  const deps = (over = {}) => ({
    vscode: fakeVscode,
    getConfig: () => config({ inlineCompletions: true, model: 'm', provider: 'ollama' }),
    getApiKey: async () => '',
    ollamaBase: () => 'http://o',
    eligible: () => true,
    isTrusted: () => true,
    debounceMs: 0,
    fetchImpl: async () => { sent++; return { ok: true, status: 200, json: async () => ({ response: 'a + b;' }) }; },
    ...over,
  });
  const p = createInlineCompletionProvider(deps());
  const one = at('function add(a, b) {\n  return |\n}');
  const first = await p.provideInlineCompletionItems(one.doc, one.pos, {}, token());
  check('provider: a suggestion comes back as an inline item at the cursor',
    first.length === 1 && first[0].insertText === 'a + b;' && first[0].range.start === one.pos && sent === 1);
  const two = at('function add(a, b) {\n  return a +|\n}');
  const second = await p.provideInlineCompletionItems(two.doc, two.pos, {}, token());
  check('provider: typing through it answers at once from the cache, with no new request',
    second.length === 1 && second[0].insertText === ' b;' && sent === 1 && p.state.cacheHits === 1);

  sent = 0;
  const waiting = createInlineCompletionProvider(deps({ debounceMs: 30 }));
  const a = at('const x = |');
  const b = at('const xy = |');
  const [ra, rb] = await Promise.all([
    waiting.provideInlineCompletionItems(a.doc, a.pos, {}, token()),
    waiting.provideInlineCompletionItems(b.doc, b.pos, {}, token()),
  ]);
  check('provider: a keystroke that supersedes a waiting request drops it before it is sent',
    ra.length === 0 && rb.length === 1 && sent === 1);

  sent = 0;
  const off = await createInlineCompletionProvider(deps({ getConfig: () => config({ inlineCompletions: false, model: 'm' }) }))
    .provideInlineCompletionItems(one.doc, one.pos, {}, token());
  const untrusted = await createInlineCompletionProvider(deps({ isTrusted: () => false })).provideInlineCompletionItems(one.doc, one.pos, {}, token());
  const ineligible = await createInlineCompletionProvider(deps({ eligible: () => false })).provideInlineCompletionItems(one.doc, one.pos, {}, token());
  const noModel = await createInlineCompletionProvider(deps({ getConfig: () => config({ inlineCompletions: true, model: '' }) }))
    .provideInlineCompletionItems(one.doc, one.pos, {}, token());
  check('provider: off, untrusted, a file it may not read, or no model - nothing is sent',
    !off.length && !untrusted.length && !ineligible.length && !noModel.length && sent === 0);
  const cancelled = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) };
  const gone = await createInlineCompletionProvider(deps()).provideInlineCompletionItems(one.doc, one.pos, {}, cancelled);
  check('provider: a request VS Code has already cancelled is never sent', !gone.length && sent === 0);
}

module.exports = { completionsSuite };
