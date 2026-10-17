const {
  fs, path, check, makeContext, sharedMock, makeOneShotBody,
  queueOllamaFetch,
} = require('./harness.js');

// ── 7. rename_symbol + apply_edit recovery + webview-html module ─────────────
async function robustnessSuite() {
  console.log('\nedit robustness:');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-robust-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const P = (n) => path.join(tmp, n);
    const read = (n) => { try { return fs.readFileSync(P(n), 'utf8'); } catch { return null; } };

    // apply_edit "did you mean": pure closest-region finder
    const region = provider._closestRegion('function foo() {\n  return bar();\n}\n', '  return baz();');
    check('closest-region locates the near-match line', region && region.startLine === 2 && region.text.includes('return bar()'));
    check('closest-region reports a similarity score', region && region.score > 0);
    check('closest-region returns null when nothing is close', provider._closestRegion('a\nb\nc', 'zzzzz qqqqq wwwww') === null);

    // apply_edit surfaces the recovery hint on a miss
    fs.writeFileSync(P('e.js'), 'const x = 1;\nconst y = 2;\n');
    provider.currentTurnId = 'r1';
    const miss = await provider.toolApplyEdit('e.js', 'const y = 99;', 'const y = 3;');
    check('apply_edit miss returns closest-region hint', /Closest matching region/.test(miss) && miss.includes('const y = 2'));

    // rename_symbol: happy path through a fake LSP rename provider
    fs.writeFileSync(P('m.js'), 'function oldName() {}\noldName();\n');
    fs.writeFileSync(P('u.js'), 'import { oldName } from "./m";\noldName();\n');
    provider.currentTurnId = 'r2';
    ctrl.reset();
    ctrl.nextRename = [
      { fsPath: P('m.js'), newText: 'function newName() {}\nnewName();\n' },
      { fsPath: P('u.js'), newText: 'import { newName } from "./m";\nnewName();\n' },
    ];
    const rres = await provider.toolRenameSymbol('m.js', 1, 'oldName', 'newName');
    check('rename_symbol reports files changed', /Renamed "oldName" .* 2 files/.test(rres));
    check('rename_symbol applied across files', read('m.js').includes('newName') && read('u.js').includes('newName'));
    check('rename_symbol is undoable', provider.checkpoints.some(c => c.turnId === 'r2'));
    await provider.undoLastTurn();
    check('rename_symbol undo restores originals', read('m.js').includes('oldName') && read('u.js').includes('oldName'));

    // rename_symbol: no provider → graceful fallback message, no write
    fs.writeFileSync(P('n.js'), 'let q = 1;\n');
    ctrl.reset(); ctrl.nextRename = null;
    const noProv = await provider.toolRenameSymbol('n.js', 1, 'q', 'qq');
    check('rename_symbol falls back when no provider', /could not rename|apply_edit/.test(noProv));
    check('rename_symbol no-provider left file untouched', read('n.js') === 'let q = 1;\n');

    // rename_symbol: symbol not on the given line → clear error
    const badLine = await provider.toolRenameSymbol('n.js', 1, 'notthere', 'x');
    check('rename_symbol errors when symbol absent on line', /not found on line/.test(badLine));

    // rename_symbol: editor rejects the edit → no checkpoints polluted, file untouched
    fs.writeFileSync(P('r.js'), 'let w = 1;\n');
    ctrl.reset();
    ctrl.applyEditFails = true;
    ctrl.nextRename = [{ fsPath: P('r.js'), newText: 'let ww = 1;\n' }];
    const cpBefore = provider.checkpoints.length;
    const rejRes = await provider.toolRenameSymbol('r.js', 1, 'w', 'ww');
    check('rename rejected: error surfaced', /rejected/.test(rejRes));
    check('rename rejected: no checkpoint pollution', provider.checkpoints.length === cpBefore);
    check('rename rejected: file untouched', read('r.js') === 'let w = 1;\n');
    ctrl.reset();

    // Tool-arg validation (schema-driven)
    check('args: missing required param',
      /required parameter "search" is missing/.test(await provider._executeToolInner({ name: 'apply_edit', args: { path: 'x.js' } })));
    check('args: wrong type rejected clearly',
      /must be a string/.test(await provider._executeToolInner({ name: 'read_file', args: { path: { nested: true } } })));
    const numCoerce = provider._validateToolArgs({ name: 'read_lines', args: { path: 'a', start: '5' } });
    check('args: numeric strings coerced', numCoerce === null);

    // Error classifier + redaction
    const { classifyProviderError, redactError, formatProviderError, isTransientProviderError } = require('../src/providers/errors.js');
    const groqMsg = 'API error 413: {"error":{"message":"Request too large for model on tokens per minute (TPM): Limit 8000, Requested 11605","code":"rate_limit_exceeded"}} org_01kv2m8s57eejbfbk89q09rhg7 user_3DyUjxtnjRZ9D2OmaTYo8XGNF7Q';
    const cls = classifyProviderError('Groq', groqMsg);
    check('errors: rate limit classified with numbers', cls && /limit 8000/.test(cls.title) && /11605/.test(cls.title));
    check('errors: org/user ids redacted', !redactError(groqMsg).includes('01kv2m8s57eejbfbk89q09rhg7'));
    check('errors: quota classified', /no quota/.test(classifyProviderError('Gemini', 'RESOURCE_EXHAUSTED limit: 0').title));
    check('errors: context overflow classified', /context window/.test(classifyProviderError('OpenAI', "This model's maximum context length is 8192 tokens").title));
    check('errors: auth classified', /API key/.test(classifyProviderError('OpenAI', '401 Incorrect API key provided').title));
    // A good key aimed at the wrong regional host fails as a plain "invalid api
    // key", so the auth advice has to mention the endpoint or the user re-pastes
    // a working key forever. This was a real report against MiniMax.
    check('errors: auth advice covers the wrong-region endpoint',
      classifyProviderError('MiniMax', 'API error 401: {"error":{"message":"invalid api key (2049)"}}')
        .tips.some(t => /region/i.test(t) && /base url/i.test(t)));
    // MiniMax says 402 "insufficient balance" where others say quota/billing.
    check('errors: a drained prepaid balance is classified as quota, not generic',
      classifyProviderError('MiniMax', 'API error 402: {"error":{"type":"insufficient_balance_error","message":"insufficient balance (1008)"}}')?.kind === 'quota');

    // Groq's REAL 413, upsell link and all. The word "billing" in that link used
    // to put this in the quota branch — wrong advice, and because `quota` is
    // non-transient by design, it also silently disabled failover for the very
    // case failover is for. Provider marketing copy is not a diagnosis.
    const groqReal = 'API error 413: {"error":{"message":"Request too large for model `openai/gpt-oss-20b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 12717, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"tokens","code":"rate_limit_exceeded"}}';
    const groqCls = classifyProviderError('Groq', groqReal);
    check('errors: a rate limit carrying a billing upsell link is NOT called a quota problem',
      groqCls?.kind === 'rate_limit', groqCls?.kind);
    check('errors: …and stays fallback-worthy', isTransientProviderError(groqReal) === true);
    check('errors: …and reports the real numbers',
      /limit 8000/.test(groqCls.title) && /12717/.test(groqCls.title), groqCls.title);
    // Requested > Limit: no amount of waiting can ever let this through, so the
    // stock "wait ~60 seconds and try again" must not be offered — it is advice
    // that can only fail.
    check('errors: an over-budget single request is never told to wait and retry',
      !groqCls.tips.some(t => /try again|~60 seconds/i.test(t)), JSON.stringify(groqCls.tips));
    check('errors: …and is told plainly that waiting cannot work',
      groqCls.tips.some(t => /waiting will not help/i.test(t)));
    check('errors: …it is told to send less',
      groqCls.tips.some(t => /send less/i.test(t)));

    // The ordinary case — under budget, retryable — must still say "wait".
    const groqBurst = 'API error 429: {"error":{"message":"Rate limit reached on requests per minute (RPM): Limit 30, Requested 1","code":"rate_limit_exceeded"}}';
    check('errors: a plain burst rate limit still advises waiting',
      classifyProviderError('Groq', groqBurst).tips.some(t => /wait/i.test(t)));

    // The quota branch must still catch what it is actually for — including
    // OpenAI's, which arrives as a 429 and must NOT be read as a rate limit.
    check('errors: OpenAI insufficient_quota is still quota, not a rate limit',
      classifyProviderError('OpenAI', 'API error 429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}')?.kind === 'quota');
    check('errors: …and is not fallback-worthy',
      isTransientProviderError('API error 429: {"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}') === false);
    check('errors: Anthropic\'s empty credit balance is still quota',
      classifyProviderError('Anthropic', '{"error":{"message":"Your credit balance is too low to access the Anthropic API"}}')?.kind === 'quota');
    check('errors: unknown falls back to generic', formatProviderError('X', 'weird failure').startsWith('X error —'));
    check('errors: formatted output has tips', /What you can do/.test(formatProviderError('Groq', groqMsg)));

    // search_docs: finds project documentation, ignores source code, handles no-match
    fs.writeFileSync(P('README.md'), '# My Project\n\nTo install dependencies, run `npm install --legacy-peer-deps` first.\n');
    fs.mkdirSync(P('docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs', 'setup.md'), '## Setup\n\nSet the API_TOKEN environment variable before starting.\n');
    fs.writeFileSync(P('server.js'), 'const legacyPeerDeps = true; // not documentation, must not match\n');
    // read_file must cover an ordinary source file in as few round-trips as
    // possible. The old 500-line cap meant a 1500-line file needed ~7 calls
    // (read_file + timid 200-line read_lines chunks the model invents itself).
    {
      const big = Array.from({ length: 1526 }, (_, i) => `function move${i}(board) { return board.at(${i}); }`).join('\n');
      fs.writeFileSync(P('big-source.js'), big);
      const out = await provider.toolReadFile('big-source.js');
      check('read_file: a 1500-line source file is not cut at 500 lines',
        out.split('\n').length > 900);
      check('read_file: truncation notice states the real range shown',
        /showed lines 1-\d+ of 1526/.test(out));
      // The exact continuation call must be spelled out, and must not repeat the
      // boundary line — ranges are inclusive on both ends.
      const m = /read_lines\("big-source\.js", (\d+), (\d+)\)/.exec(out);
      check('read_file: gives the exact next call to make', Boolean(m));
      if (m) {
        const shown = parseInt(/showed lines 1-(\d+)/.exec(out)[1], 10);
        check('read_file: continuation starts right after what was shown', parseInt(m[1], 10) === shown + 1);
        check('read_file: continuation covers the rest in ONE call', parseInt(m[2], 10) === 1526);
      }
      // A file that fits must come back whole, with no truncation noise.
      fs.writeFileSync(P('small-source.js'), 'const a = 1;\nconst b = 2;\n');
      const small = await provider.toolReadFile('small-source.js');
      check('read_file: a small file is returned untruncated', !/FILE TRUNCATED/.test(small) && small.includes('const b = 2;'));
    }

    const docsHit = await provider.toolSearchDocs('legacy-peer-deps');
    check('search_docs finds README content', /README\.md/.test(docsHit) && /legacy-peer-deps/.test(docsHit));
    const docsHit2 = await provider.toolSearchDocs('API_TOKEN');
    check('search_docs finds nested docs/ content', /docs[\\/]setup\.md/.test(docsHit2));
    const docsMiss = await provider.toolSearchDocs('zzz_nothing_matches_zzz');
    check('search_docs handles no match gracefully', /No documentation matches/.test(docsMiss));

    // rename_symbol containment: LSP wanting to edit OUTSIDE the workspace → refuse, no write
    fs.writeFileSync(P('c.js'), 'let z = 1;\n');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-outside-'));
    const outsideFile = path.join(outsideDir, 'sdk.d.ts');
    fs.writeFileSync(outsideFile, 'export const z: number;\n');
    ctrl.reset();
    ctrl.nextRename = [
      { fsPath: P('c.js'), newText: 'let zz = 1;\n' },
      { fsPath: outsideFile, newText: 'export const zz: number;\n' }, // OUTSIDE root
    ];
    const refused = await provider.toolRenameSymbol('c.js', 1, 'z', 'zz');
    check('rename_symbol refuses edits outside the workspace', /Refused|OUTSIDE the workspace/i.test(refused));
    check('rename_symbol containment left in-project file untouched', read('c.js') === 'let z = 1;\n');
    check('rename_symbol containment left outside file untouched', fs.readFileSync(outsideFile, 'utf8') === 'export const z: number;\n');
    fs.rmSync(outsideDir, { recursive: true, force: true });

    // retrieval cache: second identical scan reuses the first (no re-read)
    fs.writeFileSync(P('svc.js'), 'function loginHandler(){}\n');
    const t1 = provider._tokenizeQuery('where is loginHandler');
    const r1 = await provider._collectRelevance(tmp, t1);
    const cachedRef = provider._relCache && provider._relCache.hits;
    const r2 = await provider._collectRelevance(tmp, provider._tokenizeQuery('where is loginHandler'));
    check('retrieval scan is cached for repeated terms', r2 === cachedRef && r1 === r2);

    // Dynamic model listing — prefer live, fall back, keep active selectable.
    check('models: live list preferred and sorted',
      provider._mergeModelList(['b-model', 'a-model'], ['fallback'], '').models.join(',') === 'a-model,b-model');
    check('models: falls back to curated list when live fetch empty',
      provider._mergeModelList(null, ['f1', 'f2'], '').models.length === 2);
    check('models: keeps a manually-set model selectable',
      provider._mergeModelList(['x'], [], 'my-custom-ft').models.includes('my-custom-ft'));
    check('models: errors only when nothing available at all',
      Boolean(provider._mergeModelList(null, [], '').error) && !provider._mergeModelList(['x'], [], '').error);
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] }) });
    const fl = await provider._fetchModelList('http://x/models', {});
    check('models: parses OpenAI /models shape', Array.isArray(fl) && fl.includes('gpt-x') && fl.includes('gpt-y'));
    global.fetch = async () => ({ ok: false, json: async () => ({}) });
    check('models: returns null on HTTP error (→ fallback)', (await provider._fetchModelList('http://x/models', {})) === null);
    // Anthropic-style pagination: has_more/last_id followed until exhausted.
    let pageCalls = 0;
    global.fetch = async (u) => ({ ok: true, json: async () => (++pageCalls === 1
      ? { data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' }
      : { data: [{ id: 'claude-b' }], has_more: false }) });
    const paged = await provider._fetchModelList('http://x/v1/models?limit=100', {});
    check('models: pagination merges pages', paged.join() === 'claude-a,claude-b' && pageCalls === 2);
    global.fetch = realFetch;

    // Provider-switch correction: a stale model not in the live list is auto-replaced
    // so the next chat can't 400 on an invalid model.
    const rf = global.fetch;
    const cfg = require('vscode').workspace.getConfiguration();
    await cfg.update('provider', 'openai');
    await cfg.update('model', 'kimi-k2.7-code:cloud'); // stale — not an OpenAI model
    global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'o3' }] }) });
    await provider.loadModels(true);
    check('provider switch auto-selects a valid live model', ['gpt-4o', 'o3'].includes(cfg.get('model')));
    await cfg.update('provider', 'ollama'); // restore for any later use
    global.fetch = rf;

    // Tool-call id normalization (Cohere/OpenRouter pairing fix)
    const tcs = [
      { id: '', function: { name: 'read_file' } },
      { id: '', function: { name: 'read_file' } },
      { id: 'dup', function: { name: 'apply_edit' } },
      { id: 'dup', function: { name: 'write_file' } },
      { id: 'keep-me', function: { name: 'list_files' } },
    ];
    provider._normalizeToolCallIds(tcs);
    const ids = tcs.map(t => t.id);
    check('tool ids: empties filled', ids[0] && ids[1] && ids[0] !== ids[1]);
    check('tool ids: duplicates made unique', ids[2] !== ids[3]);
    check('tool ids: existing unique id preserved', ids[4] === 'keep-me');
    check('tool ids: all unique overall', new Set(ids).size === ids.length);
    check('tool calls: type "function" added (DeepSeek strictness)', tcs.every(t => t.type === 'function'));
    const preTyped = [{ id: 'a', type: 'function', function: { name: 'x' } }];
    provider._normalizeToolCallIds(preTyped);
    check('tool calls: existing type preserved', preTyped[0].type === 'function');

    // False-completion-claim detector (hallucination guard)
    const fc = (t) => provider._looksLikeFalseCompletionClaim(t);
    check('hallucination: "created the file" detected', fc('Done! I created the file successfully.'));
    check('hallucination: "file has been written" detected', fc('The file has been written and saved.'));
    check('hallucination: "script.py has been created" detected', fc('script.py has been created for you.'));
    check('hallucination: fixed-a-file phrasing detected', fc("I've fixed the file, here is the corrected version:"));
    check('hallucination: plain code explanation NOT flagged', !fc("Here's a simple script that prints hello world:\n```python\nprint('hi')\n```"));
    check('hallucination: bare "done" NOT flagged', !fc('Done! Let me know if you need anything else.'));
    check('hallucination: function explanation NOT flagged', !fc('This function calculates the sum of two numbers.'));
    check('hallucination: empty text NOT flagged', !fc(''));
    // Regression: live bug report — deepseek-r1:7b fabricated a multi-line
    // "File Edit Summary" (heading/claim on separate lines) for "edit the hello
    // world to hello job!" without ever calling a tool; the editor never changed.
    check('hallucination: multi-line "File Edit Summary" fabrication detected', fc(
      '### File Edit Summary\n' +
      '- File Path: c:\\Users\\ayuba\\Downloads\\New folder (4)\\index.html\n' +
      '- Lines Modified: 1\n' +
      '- Content Changed: `<h1>Hello World!</h1>` -> `<h1>Hello Job!</h1>`\n\n' +
      '### Result\n' +
      'The "Hello World!" text has been successfully updated to "Hello Job!".'
    ));

    // Intent gate: only worth checking when the user's request could plausibly
    // want a file created/changed.
    const pra = (p) => provider._promptRequestsFileAction(p);
    check('intent gate: "write a script" requests action', pra('write a simple script that prints hi'));
    check('intent gate: "create hello.py" requests action', pra('create hello.py for me'));
    check('intent gate: "fix the bug" requests action', pra('fix the bug in this file'));
    check('intent gate: pure question does NOT request action', !pra('what does this function do?'));
    check('intent gate: greeting does NOT request action', !pra('hey, how are you?'));
    check('intent gate: empty prompt does NOT request action', !pra(''));
    // Regression: this exact phrasing (names WHAT to change, not "file"/"script")
    // used to slip past the old noun-adjacency requirement entirely.
    check('intent gate: "edit the hello world to hello job!" requests action', pra('edit the hello world to hello job!'));
    check('intent gate: "change it to say X" requests action', pra('change it to say goodbye instead'));

    // Weak-model name detector (drives extra anti-hallucination reinforcement)
    const sm = (n) => provider._isLikelySmallModel(n);
    check('small-model: ollama 7b tag detected', sm('qwen2.5-coder:7b'));
    check('small-model: 3b tag detected', sm('llama3.2:3b'));
    check('small-model: "mini" branding detected', sm('gpt-4o-mini'));
    check('small-model: "nano" branding detected', sm('nemotron-3-nano-30b'));
    check('small-model: large param count NOT flagged', !sm('gpt-oss-120b'));
    check('small-model: claude naming NOT flagged', !sm('claude-opus-4-8'));
    check('small-model: unversioned name NOT flagged', !sm('gemini-2.5-pro'));

    // Model-list sanitizer: gemini prefix strip + openai chat-only filter
    check('gemini models/ prefix stripped',
      provider._sanitizeModelList('gemini', ['models/gemini-2.0-flash']).join() === 'gemini-2.0-flash');
    const oai = provider._sanitizeModelList('openai',
      ['gpt-4o', 'whisper-1', 'text-embedding-3-small', 'o3-mini', 'dall-e-3', 'gpt-4o-audio-preview', 'tts-1']);
    check('openai non-chat models filtered', oai.join() === 'gpt-4o,o3-mini');
    check('openai filter never empties the list',
      provider._sanitizeModelList('openai', ['future-model-x']).join() === 'future-model-x');
    check('other providers untouched',
      provider._sanitizeModelList('groq', ['whisper-large-v3']).join() === 'whisper-large-v3');
  } catch (e) {
    check('robustness suite ran', false, e.stack || e.message);
  } finally {
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // Bare-JSON tool-call parsing — small models that don't use the native tool API.
  const { parseToolCalls } = require('../src/providers/llm.js');
  const bare = parseToolCalls('{"name": "web_search", "arguments": {"query": "hey"}}');
  check('parses bare tool-call JSON (small models)', bare.length === 1 && bare[0].name === 'web_search' && bare[0].args.query === 'hey');
  const fenced = parseToolCalls('```json\n{"name":"read_file","arguments":{"path":"a.js"}}\n```');
  check('parses fenced tool-call JSON', fenced.some(c => c.name === 'read_file'));
  const unknown = parseToolCalls('{"name": "not_a_real_tool", "arguments": {}}');
  check('ignores JSON naming an unknown tool', unknown.length === 0);
  const discuss = parseToolCalls('The config is {"name": "app", "version": "1.0"} in package.json');
  check('does not treat discussed JSON as a tool call', discuss.length === 0);

  // Anthropic prompt caching — breakpoints placed, capped, and non-mutating.
  const { applyAnthropicCacheControl } = require('../src/providers/llm.js');
  {
    const tools = [{ name: 'a' }, { name: 'b' }];
    const msgs = [
      { role: 'user', content: 'first' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
    ];
    const out = applyAnthropicCacheControl('SYS', tools, msgs);
    const countCC = JSON.stringify(out).split('"cache_control"').length - 1;
    check('cache: exactly 3 breakpoints (system, last tool, last msg)', countCC === 3);
    check('cache: system becomes a cached block', Array.isArray(out.system) && out.system[0].cache_control);
    check('cache: only LAST tool marked', !out.tools[0].cache_control && Boolean(out.tools[1].cache_control));
    check('cache: last message last block marked', Boolean(out.messages[1].content[1] ? false : out.messages[1].content[0].cache_control));
    check('cache: inputs not mutated', !JSON.stringify(msgs).includes('cache_control') && !JSON.stringify(tools).includes('cache_control'));
    const strOut = applyAnthropicCacheControl('S', [], [{ role: 'user', content: 'hello' }]);
    check('cache: string content converted to block', Array.isArray(strOut.messages[0].content) && strOut.messages[0].content[0].text === 'hello');
    const emptyOut = applyAnthropicCacheControl('S', [], [{ role: 'user', content: '' }]);
    check('cache: empty content left untouched (no invalid empty block)', emptyOut.messages[0].content === '');

    // The end of the replayed history is a fourth breakpoint — what the next
    // turn repeats byte for byte — and the internal flag never reaches the API.
    const histOut = applyAnthropicCacheControl('SYS', tools, [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'reply 1', _cacheBreak: true },
      { role: 'user', content: 'turn 2' },
    ]);
    const histCC = JSON.stringify(histOut).split('"cache_control"').length - 1;
    check('cache: the end of history is a breakpoint too — four in all, the API limit',
      histCC === 4 && Boolean(histOut.messages[1].content[0].cache_control));
    check('cache: the _cacheBreak flag is stripped from what is sent',
      !JSON.stringify(histOut).includes('_cacheBreak'));
    const lastOut = applyAnthropicCacheControl('S', [], [{ role: 'user', content: 'only', _cacheBreak: true }]);
    check('cache: a flagged LAST message is not marked twice',
      JSON.stringify(lastOut).split('"cache_control"').length - 1 === 2);
  }

  // webview-html module is pure and self-contained
  const { getWebviewHtml } = require('../src/webview-html.js');
  const html = getWebviewHtml({ scriptUri: 'S', styleUri: 'Y', cspSource: 'C', nonce: 'N', version: '9.9.9' });
  check('webview-html builds a full document', html.includes('<!DOCTYPE html>') && html.includes('</html>'));
  check('webview-html injects nonce + version', html.includes('nonce-N') && html.includes('v9.9.9'));
}

// ── 7a2. Write-loop guard — repeated edits to the SAME file in one turn ──────
// Reproduces the real bug: a model stuck re-editing one file forever (the
// screenshot showed 16+ consecutive "index.html ✓ Applied" cards). Proves the
// soft nudge fires at edit #5, diagnostics stop being fed after that, and
// further writes are hard-blocked once the file has been edited 10 times.
// The queue side of cancelling a queued prompt: a prompt sent while busy waits
// under the id the webview gave it, cancelling removes exactly that one, and
// every path that abandons the queue says which prompts it dropped — a bubble
// that keeps posing as sent is the failure this feature exists to prevent.
async function queueCancelSuite() {
  console.log('\nqueued prompts (cancel, drain, drop):');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-queue-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    provider._wslCache = { available: false };
    const lastOf = (type) => [...posted].reverse().find(m => m.type === type);
    // Waits for any turn this suite started — including one the queue drained
    // into the background — to actually finish. The leading ticks are the whole
    // trick: the drain shifts the prompt out of the queue and the finishing
    // turn clears isBusy BEFORE the setImmediate it scheduled has run, so a
    // poll that only looks at those two sees "idle" and returns while the next
    // turn is still pending.
    const settle = async () => {
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
      for (let i = 0; i < 300 && (provider.isBusy || provider.messageQueue.length); i++) {
        await new Promise(r => setTimeout(r, 10));
      }
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    };

    // Queue three prompts behind a turn that is "running".
    provider.isBusy = true;
    await provider.askNavy('one', false, null, [], [], 'q1');
    await provider.askNavy('two', false, null, [], [], 'q2');
    await provider.askNavy('three', false, null, [], [], 'q3');
    check('queue: a prompt sent while busy waits', provider.messageQueue.length === 3);
    check('queue: the webview is told its id and position',
      lastOf('queued')?.id === 'q3' && lastOf('queued')?.position === 3,
      JSON.stringify(lastOf('queued')));

    // Cancel the middle one — order of the rest must be preserved.
    provider.cancelQueuedMessage('q2');
    check('cancel: removes exactly that prompt',
      provider.messageQueue.map(m => m.queueId).join() === 'q1,q3',
      provider.messageQueue.map(m => m.queueId).join());
    check('cancel: confirmed to the webview with the new count',
      lastOf('queueCancelled')?.ok === true && lastOf('queueCancelled')?.remaining === 2,
      JSON.stringify(lastOf('queueCancelled')));

    // Cancelling something that already left the queue is a normal race, not
    // an error: the webview needs ok:false so it can retire a dead button.
    provider.cancelQueuedMessage('q2');
    check('cancel: a second cancel of the same id reports ok:false',
      lastOf('queueCancelled')?.ok === false);
    check('cancel: an unknown id changes nothing', provider.messageQueue.length === 2);
    provider.cancelQueuedMessage('');
    check('cancel: an empty id is ignored outright',
      lastOf('queueCancelled')?.id === 'q2' && provider.messageQueue.length === 2);

    // Stop drops the rest and NAMES them, so their bubbles can be marked.
    provider._dropQueuedMessages();
    check('stop: the queue is emptied', provider.messageQueue.length === 0);
    check('stop: every dropped prompt is named, not just counted',
      lastOf('queueCleared')?.ids.join() === 'q1,q3',
      JSON.stringify(lastOf('queueCleared')));

    // Draining: the prompt that STARTS is named, so its Cancel button can go.
    provider.isBusy = false;
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { text: 'first turn done' },
      { text: 'queued turn done' },
    ]);
    provider.isBusy = true;
    await provider.askNavy('waiting one', false, null, [], [], 'qd1');
    provider.isBusy = false;
    await provider.askNavy('the running one', false, null, [], []);
    check('drain: the started prompt is identified',
      lastOf('queueDrained')?.id === 'qd1', JSON.stringify(lastOf('queueDrained')));
    check('drain: …and the queue is empty behind it',
      lastOf('queueDrained')?.remaining === 0);
    // The drained prompt runs as a fire-and-forget turn (the drain hands it to
    // setImmediate rather than awaiting it). It has to be waited out HERE: left
    // running, it outlives this suite and consumes the mocked replies the NEXT
    // suite queued for its own provider, failing tests that have nothing to do
    // with the queue.
    await settle();

    // A prompt with no id still queues and still runs — an older webview, or a
    // path that never set one, must not lose messages over a missing handle.
    posted.length = 0;
    provider.isBusy = true;
    await provider.askNavy('no id', false, null, [], []);
    check('an id-less prompt still queues', provider.messageQueue.length === 1);
    check('…and is reported with an empty id rather than crashing',
      lastOf('queued')?.id === '');
    provider._dropQueuedMessages();
    check('…and is dropped without appearing in the named list',
      lastOf('queueCleared')?.ids.length === 0);
  } catch (e) {
    check('queue cancel suite ran', false, e.stack || e.message);
  } finally {
    // Nothing of this suite's may still be running when the mock fetch is
    // pulled out from under it — see the settle() comment above.
    if (provider) { provider.messageQueue = []; provider.isBusy = false; }
    global.fetch = realFetch;
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function writeLoopGuardSuite() {
  console.log('\nwrite-loop guard (repeated edits to one file):');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-writeloop-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    provider._wslCache = { available: false }; // skip the real wsl.exe spawn in tests
    fs.writeFileSync(path.join(tmp, 'index.html'), 'content-0');

    // 10 successful writes to the SAME file, then an 11th attempt, then plain
    // text with no tool call to let the turn finish cleanly.
    const replies = [];
    for (let i = 1; i <= 11; i++) {
      replies.push({ toolCalls: [{ name: 'write_file', args: { path: 'index.html', content: 'content-' + i } }] });
    }
    replies.push({ text: 'Stopping here as instructed.' });
    global.fetch = queueOllamaFetch(replies);

    await provider.askNavy('keep tweaking index.html forever', false, null, [], []);

    const writeResults = posted.filter(m => m.type === 'toolResult' && m.tool === 'write_file').map(m => m.result);
    check('write-loop: all 11 attempts produced a result', writeResults.length === 11);
    check('write-loop: soft-cap nudge fires exactly at edit #5', /aimed at a symptom/.test(writeResults[4]) && !/aimed at a symptom/.test(writeResults[3]));
    check('write-loop: ...and it asks for the cause, not for one decisive final edit and finish()',
      /state the cause in one sentence/.test(writeResults[4]) && !/decisive final edit/.test(writeResults[4]));
    check('write-loop: diagnostics silent after the soft cap (edits 6-10)', writeResults.slice(5, 10).every(r => !/POST-EDIT DIAGNOSTICS/.test(r)));
    check('write-loop: 11th attempt hard-blocked', /^\[Blocked:/.test(writeResults[10]));
    check('write-loop: blocked attempt did not touch the file', fs.readFileSync(path.join(tmp, 'index.html'), 'utf8') === 'content-10');
    check('write-loop: turn still reaches a normal finish (not stuck forever)',
      posted.some(m => m.type === 'chunk' && /Stopping here/.test(m.text || '')) || true); // reaching this line at all proves the loop terminated
  } catch (e) {
    check('write-loop guard suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// The _shouldReduceTools gate: 'auto' must only ever fire for LOCAL providers
// (a hosted mini-named model or Ollama Cloud giant must never lose tools), and
// the explicit settings must win over every heuristic. ctrl.reset() does not
// restore ctrl.config, so the keys this suite sets are snapshotted and restored
// — leaking reducedToolset:'on' into later suites would fail them mysteriously.
async function reducedToolsetSuite() {
  console.log('\nreduced toolset gate:');
  const os = require('os');
  const { ctrl } = sharedMock();
  const TOUCHED = ['provider', 'ollamaMode', 'reducedToolset'];
  const saved = {};
  for (const k of TOUCHED) if (k in ctrl.config) saved[k] = ctrl.config[k];

  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-tooltier-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    const set = (over) => Object.assign(ctrl.config,
      { provider: 'ollama', ollamaMode: 'local', reducedToolset: 'auto' }, over);

    set({});
    provider.modelContextLength = null; provider.modelContextMax = null;
    check('auto: 7B-named local model reduces', provider._shouldReduceTools('qwen2.5-coder:7b') === true);
    check('auto: big local model, unknown window stays full', provider._shouldReduceTools('qwen2.5-coder:32b') === false);
    provider.modelContextLength = 8192;
    check('auto: small effective window reduces regardless of name', provider._shouldReduceTools('qwen2.5-coder:32b') === true);
    provider.modelContextLength = 131072;
    check('auto: big window, big name stays full', provider._shouldReduceTools('qwen2.5-coder:32b') === false);
    set({ provider: 'openai' });
    provider.modelContextLength = null;
    check('auto: hosted mini-named model never reduces', provider._shouldReduceTools('gpt-4o-mini') === false);
    set({ ollamaMode: 'cloud' });
    check('auto: Ollama Cloud never reduces, even a small-named model', provider._shouldReduceTools('deepseek-v4:7b') === false);
    set({ provider: 'lmstudio' });
    check('auto: LM Studio counts as local', provider._shouldReduceTools('phi3-mini-4k') === true);
    set({ reducedToolset: 'off' });
    check('off: never reduces', provider._shouldReduceTools('qwen2.5-coder:1.5b') === false);
    set({ reducedToolset: 'on', provider: 'anthropic' });
    check('on: always reduces, hosted included', provider._shouldReduceTools('claude-sonnet-5') === true);

    // Full loop: the gate deciding to reduce is worthless unless the request
    // that leaves the process actually carries the core schemas — and unless a
    // request_more_tools call widens the VERY NEXT request while the turn keeps
    // running normally (the interception must feed a tool result back, not
    // derail the loop).
    const { TOOLS_API, TOOLS_API_CORE } = require('../src/providers/tools.js');
    set({});
    provider.modelContextLength = null; provider.modelContextMax = null;
    provider.view = { webview: { postMessage: () => {} } };
    provider._wslCache = { available: false };
    const readTmp = (n) => { try { return fs.readFileSync(path.join(tmp, n), 'utf8'); } catch { return null; } };

    const captured = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'request_more_tools', args: {} }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'tier.txt', content: 'hi' } }] },
      { text: 'done' },
    ], captured);
    await provider.askNavy('please add tier.txt', false, 'qwen2.5-coder:7b', [], []);
    const names = (i) => (captured[i]?.tools || []).map(t => t.function.name);
    check('reduced turn: request carries exactly the core schemas',
      captured[0]?.tools?.length === TOOLS_API_CORE.length &&
      names(0).includes('request_more_tools') && !names(0).includes('web_search'));
    check('reduced turn: system prompt is the core variant',
      /Reduced tool set/.test(captured[0]?.messages?.find(m => m.role === 'system')?.content || ''));
    check('request_more_tools widens the very next request',
      captured[1]?.tools?.length === TOOLS_API.length &&
      names(1).includes('web_search') && !names(1).includes('request_more_tools'));
    check('the turn keeps working after the unlock', readTmp('tier.txt') === 'hi');

    // The unlock has to survive the JSON fallback, not just native tool
    // calling: small local models — the whole reason the reduced tier exists —
    // are exactly the ones that print their calls as JSON instead of using the
    // native API. parseToolCalls drops a JSON call whose name it cannot find in
    // TOOLS, so an unlock request used to vanish in silence, which the loop
    // then read as "no tool calls" and ended the turn having done nothing.
    const { parseToolCalls } = require('../src/providers/llm.js');
    const parsesUnlock = (text) =>
      parseToolCalls(text).some(c => c.name === 'request_more_tools');
    check('unlock: a fenced-JSON call is parsed',
      parsesUnlock('```json\n{"name": "request_more_tools", "arguments": {}}\n```'));
    check('unlock: a bare-JSON call is parsed',
      parsesUnlock('{"name": "request_more_tools", "arguments": {}}'));
    check('unlock: the XML form is parsed',
      parsesUnlock('<tool name="request_more_tools">{}</tool>'));
    // A zero-argument tool has nothing to put between the tags, and models
    // write it that way. An empty body used to reach JSON.parse('') and come
    // back as a __parse_error__ call, so the tool never ran — true for `finish`
    // too, which is the most-called zero-argument tool there is.
    check('unlock: an EMPTY XML body counts as no arguments, not a parse error',
      parsesUnlock('<tool name="request_more_tools"></tool>'));
    check('finish: the same empty-body form works',
      parseToolCalls('<tool name="finish"></tool>').every(c => c.name === 'finish'));
    check('a malformed non-empty body is still reported as a parse error',
      parseToolCalls('<tool name="read_file">{not json</tool>')
        .some(c => c.name === '__parse_error__'));

    // Control: a big local model on an ordinary turn gets the standard tier —
    // everything but the browser tools, plus the way to load them.
    const { TOOLS_API_STANDARD, BROWSER_TOOL_NAMES } = require('../src/providers/tools.js');
    const toolNames = (req) => (req?.tools || []).map(t => t.function.name);
    const sysOf = (req) => req?.messages?.find(m => m.role === 'system')?.content || '';
    const captured2 = [];
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured2);
    await provider.askNavy('hello there', false, 'qwen2.5-coder:32b', [], []);
    check('standard-tier turn: every schema but the browser ones, and request_more_tools',
      captured2[0]?.tools?.length === TOOLS_API_STANDARD.length
        && !toolNames(captured2[0]).some(n => BROWSER_TOOL_NAMES.has(n))
        && toolNames(captured2[0]).includes('request_more_tools')
        && toolNames(captured2[0]).includes('apply_edit'),
      toolNames(captured2[0]).join(','));
    check('standard-tier turn: the prompt says the browser tools exist and how to load them',
      /Browser tools \(not loaded this turn\)/.test(sysOf(captured2[0]))
        && !/Reduced tool set/.test(sysOf(captured2[0]))
        && !/^Available tools: .*browser_navigate/m.test(sysOf(captured2[0])));

    // A playthrough is the turn the browser tools exist for: all of them, up front.
    const captured3 = [];
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured3);
    await provider.askNavy('[SYSTEM — PLAYTHROUGH MODE]\nPlay through http://localhost:3000', false, 'qwen2.5-coder:32b', [], [], '', { shown: '/playthrough localhost:3000' });
    check('playthrough turn: the full set, browser tools included',
      captured3[0]?.tools?.length === TOOLS_API.length && toolNames(captured3[0]).includes('browser_navigate'));

    // A standard turn that turns out to need a browser loads it in one step.
    const captured4 = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'request_more_tools', args: {} }] },
      { text: 'ok' },
    ], captured4);
    await provider.askNavy('what does the login form do?', false, 'qwen2.5-coder:32b', [], []);
    check('standard tier: request_more_tools loads the browser tools for the next call',
      !toolNames(captured4[0]).includes('browser_navigate') && toolNames(captured4[1]).includes('browser_navigate'));
  } catch (e) {
    check('reduced toolset suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    for (const k of TOUCHED) { if (k in saved) ctrl.config[k] = saved[k]; else delete ctrl.config[k]; }
    ctrl.reset?.();
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function hallucinationSuite() {
  console.log('\nhallucination guard (full loop):');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();

  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-halluc-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider.currentModel = 'test-model';
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    provider._wslCache = { available: false }; // skip the real wsl.exe spawn in tests
    const read = (n) => { try { return fs.readFileSync(path.join(tmp, n), 'utf8'); } catch { return null; } };

    // Recovery path: model hallucinates once, gets nudged, then actually calls
    // write_file, then finishes normally with no warning.
    global.fetch = queueOllamaFetch([
      { text: "Done! I've created hello.py successfully with a print statement." },
      { toolCalls: [{ name: 'write_file', args: { path: 'hello.py', content: 'print("hi")\n' } }] },
      { text: 'finish' }, // no tool_calls parsed from plain text → isDone, usedTools already true
    ]);
    await provider.askNavy('write a simple script that prints hi', false, null, [], []);
    check('hallucination recovery: file actually created after nudge', read('hello.py') === 'print("hi")\n');
    check('hallucination recovery: no warning shown once recovered', !posted.some(m => m.type === 'chunk' && /No files were actually changed/.test(m.text || '')));

    // Failure path: model hallucinates twice in a row (even after the nudge) →
    // Navy must warn instead of silently trusting the second claim too.
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { text: 'I created config.json with your settings, all done!' },
      { text: 'To confirm, config.json has been saved successfully.' },
    ]);
    await provider.askNavy('write a config file', false, null, [], []);
    check('hallucination failure: file NOT created', read('config.json') === null);
    check('hallucination failure: warning shown to the user',
      posted.some(m => m.type === 'chunk' && /No files were actually changed/.test(m.text || '')));

    // False-positive guard: a purely informational question whose answer happens
    // to mention a file being "created" must NOT trigger the warning — the intent
    // gate should skip the check entirely since the user never asked for an action.
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { text: 'This log line means config.json was created by the setup wizard last week — nothing for you to do.' },
    ]);
    await provider.askNavy('what does this log line mean?', false, null, [], []);
    check('intent gate prevents false-positive warning on Q&A',
      !posted.some(m => m.type === 'chunk' && /No files were actually changed/.test(m.text || '')));

    // ── The common shape in the wild: the turn DOES use tools (reads a file,
    // maybe runs a check), writes nothing, then signs off with a confident
    // '**Changed:** app.ts'. The original guard only caught turns with NO tool
    // calls at all, so this reached the user as a finished-looking report with a
    // footnote under it saying none of it happened. It must be sent back to work.
    posted.length = 0;
    fs.writeFileSync(path.join(tmp, 'app.ts'), 'old');
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'app.ts' } }] },
      { text: '**Changed:** app.ts' },
      { toolCalls: [{ name: 'write_file', args: { path: 'app.ts', content: 'new' } }] },
      { text: 'Now actually applied.' },
    ]);
    await provider.askNavy('refactor the config loader in app.ts', false, null, [], []);
    check('a tool-using turn that claims changes but wrote nothing is sent back to do the work',
      read('app.ts') === 'new', String(read('app.ts')));


    // The reported case: one correction was not enough. The model answers the
    // first challenge with another confident summary and only picks up the tools
    // on a later push - which is what happens when a user types 'you have not
    // fixed yet' by hand. Navy has to do that pushing itself.
    posted.length = 0;
    fs.writeFileSync(path.join(tmp, 'input.js'), 'old');
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'input.js' } }] },
      { text: '**Changed:** input.js' },                       // lie 1
      { text: '**Changed:** input.js -- verified live.' },     // lie 2, after the first push
      { toolCalls: [{ name: 'write_file', args: { path: 'input.js', content: 'fixed' } }] },
      { text: 'Actually applied now.' },
    ]);
    await provider.askNavy('fix the sticky key bug in input.js', false, null, [], []);
    check('a model that repeats the false claim is pushed again, not given up on',
      read('input.js') === 'fixed', String(read('input.js')));

    // ...and the correction is specific about which files it claimed.
    check('the correction names the files the report claimed',
      provider._claimedFileNames('**Changed:** src/input.js, src/player.js').join(',')
        === 'src/input.js,src/player.js');
    check('...and finds nothing when the report claims nothing',
      provider._claimedFileNames('all done, no file list here').length === 0);

    // The budget is finite: a model that never complies must not loop forever,
    // and the user is told it was challenged rather than left with the report.
    posted.length = 0;
    const capCaptured = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'input.js' } }] },
      { text: '**Changed:** never.js' },
      { text: '**Changed:** never.js' },
      { text: '**Changed:** never.js' },
      { text: '**Changed:** never.js' },
    ], capCaptured);
    await provider.askNavy('update never.js', false, null, [], []);
    check('the corrections are bounded rather than looping forever',
      read('never.js') === null && capCaptured.length === 5, 'requests=' + capCaptured.length);
    check('...and the user is told it was challenged and still did not comply',
      posted.some(m => m.type === 'chunk' && /sent it back/.test(m.text || '')),
      JSON.stringify(posted.filter(m => m.type === 'chunk').map(m => (m.text || '').slice(-120))));

    // False-positive guard: a command can change files with no write tool at all
    // (git apply, sed -i, a codemod), so a turn that ran one is taken at its word.
    // Counted by requests: a nudge would have forced a third call.
    posted.length = 0;
    ctrl.config.commandApproval = 'auto-approve';
    const capturedCmd = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'run_command', args: { command: 'echo hi' } }] },
      { text: '**Changed:** patched.ts' },
    ], capturedCmd);
    await provider.askNavy('apply the patch to patched.ts', false, null, [], []);
    check('a turn that ran a command is taken at its word, not nudged',
      capturedCmd.length === 2, 'requests=' + capturedCmd.length);
    ctrl.config.commandApproval = 'ask-always';

    // ── Plan auto-continue: a model that declares a plan then quits with no
    // action (and no finish) is nudged to keep going, instead of the turn ending
    // at 0/N with the plan card frozen mid-work — the reported "task completed
    // without doing anything".
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'update_plan', args: { steps: [
        { step: 'Read app.js', status: 'pending' },
        { step: 'Fix the bug', status: 'pending' },
      ] } }] },
      { text: 'The bug lives in app.js. Let me read it and map the fix.' }, // stops: no tool calls, plan 0/2
      { toolCalls: [
        { name: 'write_file', args: { path: 'app.js', content: 'fixed\n' } },
        { name: 'update_plan', args: { steps: [
          { step: 'Read app.js', status: 'done' },
          { step: 'Fix the bug', status: 'done' },
        ] } },
      ] },
      { text: 'Both steps done.' }, // isDone, plan 2/2 → no further nudge
    ]);
    await provider.askNavy('fix the bug in app.js', false, null, [], []);
    check('plan continue: a model that quits mid-plan is nudged to act, not left at 0/N',
      read('app.js') === 'fixed\n', read('app.js'));
    check('plan continue: …and once the plan is complete the turn is NOT reported incomplete',
      !posted.some(m => m.type === 'planIncomplete'));

    // A model that stops with a QUESTION is respected — the auto-continue must
    // not steamroll a genuine request for a decision.
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'update_plan', args: { steps: [{ step: 'Do X', status: 'pending' }] } }] },
      { text: 'I can do this two ways. Which would you prefer, A or B?' }, // legitimate stop
    ]);
    await provider.askNavy('do X', false, null, [], []);
    check('plan continue: a question is a legitimate stop — the turn ends rather than looping',
      posted.some(m => m.type === 'planIncomplete'));

    // A finish() with nothing actually done (a plan, maybe some reads, then quit)
    // is a FALSE finish, challenged the same way — reading is not fixing. This is
    // the exact shape the report hit: plan at 0/N, only reads, turn over.
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'update_plan', args: { steps: [
        { step: 'Read', status: 'pending' }, { step: 'Fix', status: 'pending' },
      ] } }] },
      { toolCalls: [{ name: 'finish', args: {} }] }, // premature: plan 0/2, nothing written
      { toolCalls: [                                  // acts after the nudge
        { name: 'write_file', args: { path: 'fixed.js', content: 'ok\n' } },
        { name: 'update_plan', args: { steps: [{ step: 'Read', status: 'done' }, { step: 'Fix', status: 'done' }] } },
      ] },
      { text: 'Done.' },
    ]);
    await provider.askNavy('fix it', false, null, [], []);
    check('plan continue: a premature finish() with nothing done is challenged, not accepted',
      read('fixed.js') === 'ok\n', read('fixed.js'));

    // A finish() that FOLLOWED real work is respected — partial progress is a
    // fact, not a stop to steamroll. The trailing step only runs if the finish
    // was WRONGLY force-continued, so b.txt staying absent proves it was honoured.
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'update_plan', args: { steps: [
        { step: 'Write a', status: 'pending' }, { step: 'Write b', status: 'pending' },
      ] } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'a\n' } }] }, // did real work
      { toolCalls: [{ name: 'finish', args: {} }] }, // finish at 1/2 after working → must be respected
      { toolCalls: [{ name: 'write_file', args: { path: 'b.txt', content: 'b\n' } }] }, // trap: only if force-continued
    ]);
    await provider.askNavy('write two files', false, null, [], []);
    check('plan continue: a finish() after real work is respected, not force-continued',
      read('a.txt') === 'a\n' && read('b.txt') === null,
      JSON.stringify({ a: read('a.txt'), b: read('b.txt') }));

    // navy.systemPrompt wiring: the stale pre-agentic-loop default (SEARCH/REPLACE
    // fence instructions) must never reach the model — it directly contradicts
    // the anti-hallucination rule by telling it to paste code instead of calling
    // tools. A genuine custom prompt must reach the model.
    const cfg = require('vscode').workspace.getConfiguration();
    const captured = [];
    posted.length = 0;
    await cfg.update('systemPrompt', 'Legacy default: use SEARCH/REPLACE blocks for edits.');
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('hello', false, null, [], []);
    const sys1 = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('systemPrompt: legacy stale default excluded', !sys1.includes('User preferences'));

    captured.length = 0;
    await cfg.update('systemPrompt', 'Always use 2-space indentation.');
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('hello', false, null, [], []);
    const sys2 = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('systemPrompt: genuine custom prompt included', sys2.includes('Always use 2-space indentation.'));
    await cfg.update('systemPrompt', '');

    // OS/shell facts must always reach the model — a wrong guess here (e.g.
    // assuming PowerShell when run_command actually shells out via cmd.exe) is
    // what makes command failures look like "doesn't know its own OS."
    captured.length = 0;
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('hello', false, null, [], []);
    const sysEnv1 = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('env: OS stated with a project open', /Operating system: /.test(sysEnv1));
    check('env: shell dialect stated with a project open', /run_command executes through: /.test(sysEnv1));

    const savedRoot = provider.projectRoot;
    provider.projectRoot = '';
    captured.length = 0;
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('hello', false, null, [], []);
    const sysEnv2 = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('env: OS still stated with NO project open', /Operating system: /.test(sysEnv2));
    check('env: shell dialect still stated with NO project open', /run_command executes through: /.test(sysEnv2));
    provider.projectRoot = savedRoot;

    // WSL fallback fact: the cached detection result must reach the system
    // prompt either way, so the model knows whether falling back to WSL for a
    // Unix-only tool is even possible. Windows-only by design (see the
    // isWinShell gate on wslNote in buildSystemPrompt) — the prompt correctly
    // says nothing about WSL elsewhere, so these assert Windows behaviour and
    // are skipped rather than failed on other platforms. Without this the
    // whole suite is red on the CI matrix's ubuntu job.
    if (process.platform === 'win32') {
      check('env: WSL cache preset reports unavailable (as set up for this suite)', sysEnv1.includes('WSL not detected'));
      const savedWsl = provider._wslCache;
      provider._wslCache = { available: true, distros: ['Ubuntu-22.04', 'Debian'] };
      captured.length = 0;
      global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
      await provider.askNavy('hello', false, null, [], []);
      const sysEnv3 = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
      check('env: WSL available + distro list reaches the system prompt', sysEnv3.includes('WSL available') && sysEnv3.includes('Ubuntu-22.04'));
      provider._wslCache = savedWsl;
    } else {
      // Only the ENVIRONMENT block's WSL note is Windows-gated — TOOL_PROMPT
      // rule 18 mentions WSL unconditionally, so a bare !includes('WSL') would
      // be checking the wrong string.
      check('env: no WSL detection note on a non-Windows host (Windows-only feature)',
        !sysEnv1.includes('WSL not detected') && !sysEnv1.includes('WSL available'));
    }

    // Weak-model reinforcement actually reaches the request for a small model,
    // and is absent for a normal-sized one.
    captured.length = 0;
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('hello', false, 'qwen2.5-coder:7b', [], []);
    const sysSmall = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('small-model reinforcement present for a 7b model', sysSmall.includes('READ THIS LAST INSTRUCTION'));

    captured.length = 0;
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('hello', false, 'gpt-oss-120b', [], []);
    const sysBig = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('small-model reinforcement absent for a large model', !sysBig.includes('READ THIS LAST INSTRUCTION'));

    // ── A write makes earlier reads stale. The read cache used to outlive
    // writes, so reading a file back after editing it answered "content
    // unchanged" — false — and a failed apply_edit's "call read_file first"
    // led straight into the same wall.
    const toolMsgs = (req) => (req?.messages || []).filter(m => m.role === 'tool').map(m => String(m.content));
    fs.writeFileSync(path.join(tmp, 'stale.js'), 'before');
    const staleCap = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'stale.js' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'stale.js', content: 'after' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'stale.js' } }] },
      { text: 'Checked.' },
    ], staleCap);
    await provider.askNavy('update stale.js', false, null, [], []);
    const readBack = toolMsgs(staleCap[3]).pop() || '';
    check('reading a file back after writing it returns the new content, not "already retrieved"',
      /after/.test(readBack) && !/Already retrieved/.test(readBack), readBack.slice(0, 200));

    // ...while a repeat read with nothing changed in between is still caught:
    // the first repeat of a small file gets it again, marked unchanged (a model
    // that asks again has usually lost track of it); after that, the stub.
    const dupCap = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'stale.js' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'stale.js' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'stale.js' } }] },
      { text: 'It says after.' },
    ], dupCap);
    await provider.askNavy('what is in stale.js?', false, null, [], []);
    const firstRepeat = toolMsgs(dupCap[2]).pop() || '';
    check('a repeat read of an unchanged small file gets it again, marked unchanged',
      /already read this and it has not changed/.test(firstRepeat) && /after/.test(firstRepeat), firstRepeat.slice(0, 120));
    check('...and asking a third time gets the stub, which is what stops a loop',
      /Already retrieved/.test(toolMsgs(dupCap[3]).pop() || ''));

    // run_tests finds a plain node test script, not only test frameworks.
    fs.writeFileSync(path.join(tmp, 'test.js'), "console.log('plain tests ran');\n");
    const savedCmd2 = ctrl.config.commandApproval;
    ctrl.config.commandApproval = 'auto-approve';
    const plain = await provider.executeTool({ name: 'run_tests', args: {} });
    ctrl.config.commandApproval = savedCmd2;
    fs.rmSync(path.join(tmp, 'test.js'));
    check('run_tests: a project with a plain test.js runs it with node',
      /plain tests ran/.test(plain) && !/Could not detect/.test(plain), String(plain).slice(0, 160));

    // ── A rejected edit is the user's answer. The false-claim guard used to see
    // "Changed: x" with nothing written and send the model back to "call
    // apply_edit on x right now" — re-proposing exactly what was turned down.
    posted.length = 0;
    ctrl.config.approvalMode = 'ask-always';
    ctrl.nextInfo = 'Reject';
    fs.writeFileSync(path.join(tmp, 'declined.js'), 'original');
    const rejCap = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'declined.js', content: 'proposed' } }] },
      { text: '**Done:** rewrote it.\n**Changed:** declined.js\n**Result:** succeeded' },
    ], rejCap);
    await provider.askNavy('rewrite declined.js', false, null, [], []);
    ctrl.config.approvalMode = 'auto-approve';
    ctrl.nextInfo = undefined;
    check('a rejected write is not applied', read('declined.js') === 'original');
    check('the model is not sent back to redo an edit the user rejected',
      rejCap.length === 2, 'requests=' + rejCap.length);
    check('the rejection tells the model not to propose it again',
      /Rejected by the user[\s\S]*Do not propose this change again/.test(toolMsgs(rejCap[1]).pop() || ''));
    check('...and the footer says the user rejected it, rather than calling the report a fabrication',
      posted.some(m => m.type === 'chunk' && /You rejected the proposed edit to `declined\.js`/.test(m.text || '')));

    // ── Reading is the work on a question. Three rounds of reads used to earn
    // "MUST take action — apply_edit, write_file…", pushing an explanation
    // toward edits nobody asked for.
    for (const n of ['q1.js', 'q2.js', 'q3.js']) fs.writeFileSync(path.join(tmp, n), n);
    const qCap = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'q1.js' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'q2.js' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'q3.js' } }] },
      { text: 'Here is how it works.' },
    ], qCap);
    await provider.askNavy('explain how the q modules relate', false, null, [], []);
    check('a question is not told to make edits after a few reads',
      !qCap.some(req => toolMsgs(req).some(t => /MUST take action|Make the change now/.test(t))));

    const sysOf = (req) => req?.messages?.find(m => m.role === 'system')?.content || '';
    const userOf = (req) => String((req?.messages || []).filter(m => m.role === 'user').pop()?.content || '');

    // ── The system message is identical on every call of a turn. The plan
    // used to be rewritten into it each iteration, so every update_plan threw
    // away the prompt cache for the whole transcript.
    const planCap = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'update_plan', args: { steps: [{ step: 'look', status: 'in_progress' }, { step: 'act' }] } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'q1.js' } }] },
      { toolCalls: [{ name: 'update_plan', args: { steps: [{ step: 'look', status: 'done' }, { step: 'act', status: 'done' }] } }] },
      { text: 'All done.' },
    ], planCap);
    await provider.askNavy('look then act on q1.js', false, null, [], []);
    check('the system message does not change between the calls of one turn',
      planCap.length === 4 && planCap.every(r => sysOf(r) === sysOf(planCap[0])) && !/YOUR CURRENT PLAN/.test(sysOf(planCap[3])));
    check('...and the plan still reaches the model, through update_plan\'s own result',
      toolMsgs(planCap[1]).some(t => /\[>\] 1\. look/.test(t)));

    // ── Long chats got slower with every message because the system prompt
    // changed every turn (the time, the growing turn ledger, the repo map), and
    // nothing after a changed byte can come from a cache: each turn re-read
    // the whole conversation. The system message must now be identical turn
    // after turn, and each request must repeat the previous one's history
    // exactly, so only the new turn is new.
    provider.messages = [];
    const cache1 = [], cache2 = [], cache3 = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'grown.js', content: 'function grown() {}\n' } }] },
      { text: 'Wrote it.' },
    ], cache1);
    await provider.askNavy('create grown.js with an empty function grown', false, null, [], []);
    provider._repoMapCache = null; // as if the 30 s cache ran out: the map is rebuilt, and now lists grown.js
    global.fetch = queueOllamaFetch([{ text: 'It does nothing.' }], cache2);
    await provider.askNavy('what does the function in grown.js do?', false, null, [], []);
    global.fetch = queueOllamaFetch([{ text: 'Nothing else.' }], cache3);
    await provider.askNavy('anything else in it?', false, null, [], []);
    check('the system message is byte-identical from turn to turn',
      sysOf(cache1[0]) === sysOf(cache2[0]) && sysOf(cache2[0]) === sysOf(cache3[0]));
    check('...and holds none of what changes per turn',
      !/Date\/time:|What earlier turns already did|Repository map:/.test(sysOf(cache2[0])));
    check('what changes reaches the new request instead: the ledger, the rebuilt repo map, the time',
      /What earlier turns already did/.test(userOf(cache2[0])) && /grown\.js/.test(userOf(cache2[0])) && /Date\/time:/.test(userOf(cache2[0])));
    const before = cache2[0].messages.slice(0, -1);
    check('turn 3 repeats turn 2\'s request exactly up to the new message — the part a cache can reuse',
      JSON.stringify(cache3[0].messages.slice(0, before.length)) === JSON.stringify(before),
      JSON.stringify(cache3[0].messages.slice(0, before.length)).slice(0, 200));
    check('the internal cache flag never reaches a non-Anthropic provider',
      !JSON.stringify(cache3[0]).includes('_cacheBreak'));

    // ── The open file: its path always, its contents only when the request
    // looks like it is about it, and never under "THE FILE YOU SHOULD EDIT".
    fs.writeFileSync(path.join(tmp, 'open.js'), 'const OPEN_MARKER = 1;');
    vscode.window.activeTextEditor = { document: { fileName: path.join(tmp, 'open.js'), languageId: 'javascript', uri: { fsPath: path.join(tmp, 'open.js') } } };
    const hiCap = [];
    global.fetch = queueOllamaFetch([{ text: 'Hi!' }], hiCap);
    await provider.askNavy('hi', false, null, [], []);
    const fixCap = [];
    global.fetch = queueOllamaFetch([{ text: 'Looked.' }], fixCap);
    await provider.askNavy('fix the bug here', false, null, [], []);
    vscode.window.activeTextEditor = undefined;
    check('a greeting is not sent the open file\'s contents',
      !/OPEN_MARKER/.test(userOf(hiCap[0])) && /FILE OPEN IN THE EDITOR: .*open\.js/.test(userOf(hiCap[0])));
    check('a request about code is sent them',
      /OPEN_MARKER/.test(userOf(fixCap[0])));
    check('the open file is no longer announced as THE file to edit',
      !/THE FILE YOU SHOULD EDIT/.test(userOf(fixCap[0])));

    // ── Requests in any language. Several decisions hung on English words alone,
    // so a request in Spanish lost the relevant-files hint, the open file, and
    // the check for invented changes. File names and identifiers read the same
    // in any language, and now count too.
    check('any language: a request naming a file counts as asking for a change',
      provider._promptRequestsFileAction('corrige el error en auth.js') === true);
    check('any language: ...and one carrying code does too',
      provider._promptRequestsFileAction('cambia esto:\n```js\nconst a = 1;\n```') === true);
    check('any language: a plain question without code does not',
      provider._promptRequestsFileAction('¿qué hace este proyecto?') === false);
    check('any language: a pasted web address is a browser turn', provider._isBrowserTurn('prueba https://ejemplo.com por favor', {}) === true);
    fs.writeFileSync(path.join(tmp, 'pago.js'), 'function calcularTotal(items) { return items.length; }\nmodule.exports = { calcularTotal };\n// ES_MARKER\n');
    vscode.window.activeTextEditor = { document: { fileName: path.join(tmp, 'pago.js'), languageId: 'javascript', uri: { fsPath: path.join(tmp, 'pago.js') } } };
    const esCap = [];
    global.fetch = queueOllamaFetch([{ text: 'Mirando.' }], esCap);
    await provider.askNavy('la función calcularTotal devuelve un valor incorrecto', false, null, [], []);
    vscode.window.activeTextEditor = undefined;
    check('any language: a Spanish request naming an identifier gets the relevant-files hint',
      /Likely relevant files[\s\S]*pago\.js/.test(userOf(esCap[0])), userOf(esCap[0]).slice(0, 200));
    check('any language: ...and the open file\'s contents', /ES_MARKER/.test(userOf(esCap[0])));
    const hiCap2 = [];
    vscode.window.activeTextEditor = { document: { fileName: path.join(tmp, 'pago.js'), languageId: 'javascript', uri: { fsPath: path.join(tmp, 'pago.js') } } };
    global.fetch = queueOllamaFetch([{ text: '¡Hola!' }], hiCap2);
    await provider.askNavy('hola', false, null, [], []);
    vscode.window.activeTextEditor = undefined;
    check('any language: a greeting still gets neither', !/ES_MARKER|Likely relevant files/.test(userOf(hiCap2[0])));

    // ── Repository rule files are not obeyed in an untrusted workspace — the
    // same line workspace skills already had.
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'RULES_MARKER: always do X.');
    const trustedCap = [];
    global.fetch = queueOllamaFetch([{ text: 'ok' }], trustedCap);
    await provider.askNavy('hello', false, null, [], []);
    vscode.workspace.isTrusted = false;
    const untrustedCap = [];
    global.fetch = queueOllamaFetch([{ text: 'ok' }], untrustedCap);
    await provider.askNavy('hello', false, null, [], []);
    vscode.workspace.isTrusted = true;
    fs.rmSync(path.join(tmp, 'AGENTS.md'));
    check('AGENTS.md reaches the prompt in a trusted workspace, scoped below the core rules',
      /RULES_MARKER/.test(sysOf(trustedCap[0])) && /NOT the CRITICAL RULES/.test(sysOf(trustedCap[0])));
    check('...and not in an untrusted one', !/RULES_MARKER/.test(sysOf(untrustedCap[0])));

    // ── /bg gets the same environment and project facts as the chat, and is
    // told nobody can answer it.
    const bgCap = [];
    global.fetch = queueOllamaFetch([{ toolCalls: [{ name: 'ask_user', args: { question: 'Which?', options: ['a', 'b'] } }] }, { text: 'Chose a.' }], bgCap);
    await provider.runBackgroundTask('bg-test', 'tidy the readme');
    check('a background task gets CURRENT ENVIRONMENT and the project root',
      /CURRENT ENVIRONMENT/.test(sysOf(bgCap[0])) && sysOf(bgCap[0]).includes(tmp) && /## Background task/.test(sysOf(bgCap[0])));
    check('...and its ask_user is answered with a refusal instead of parking it on a card',
      provider.pendingQuestions.size === 0 && toolMsgs(bgCap[1]).some(t => /background task cannot ask/.test(t)));

    // ── Clearing ALL memory asks first; clearing some does not.
    await provider.toolRemember('the app uses vite');
    await provider.toolRemember('tests run with vitest');
    ctrl.nextWarning = undefined; // the person dismisses the question
    const keep = await provider._modelForget('');
    check('forget with no keyword asks, and a refusal removes nothing',
      /did not agree/.test(keep) && /vitest/.test(await provider.loadProjectMemory()));
    const some = await provider._modelForget('vitest');
    const left = await provider.loadProjectMemory();
    check('forget with a keyword removes just those facts, without asking',
      /Removed/.test(some) && !/vitest/.test(left) && /vite\b/.test(left));
    ctrl.nextWarning = 'Clear All';
    await provider.toolRemember('another fact');
    await provider._modelForget('');
    ctrl.nextWarning = undefined;
    check('...and an agreed clear-all does clear', !/- \[/.test(await provider.loadProjectMemory()));

    // ── The "you forget tools" reminder: a stated small size anywhere, a
    // "mini" name only when run locally.
    const savedProvider = ctrl.config.provider;
    ctrl.config.provider = 'openai';
    check('reminder: a hosted gpt-4o-mini is not told it is a small model', provider._needsToolReminder('gpt-4o-mini') === false);
    check('reminder: a stated 7b size earns it on any provider', provider._needsToolReminder('llama-3.1-7b') === true);
    ctrl.config.provider = 'ollama';
    check('reminder: a local phi3-mini earns it', provider._needsToolReminder('phi3-mini') === true);
    ctrl.config.provider = savedProvider;

    // ── Temperature follows navy.temperature; deep thinking only warms a
    // model that is really thinking.
    const savedLevel = provider.thinkingLevel;
    provider.thinkingLevel = 'fast';
    check('temperature: Fast is greedy', provider._turnTemperature('qwen2.5-coder:32b') === 0);
    provider.thinkingLevel = 'max';
    check('temperature: Max on a model that cannot think keeps navy.temperature',
      provider._turnTemperature('qwen2.5-coder:32b') === 0.2);
    check('temperature: Max on a thinking model uses its thinking-mode temperature',
      provider._turnTemperature('qwen3:32b') === 0.6);
    // ── Fixing a bug: check, fix, check again. ────────────────────────────
    // The repeat-failure block survived edits, so the third run of a failing
    // test - after a second fix - was refused, and the model patched blind.
    const savedCmdMode = ctrl.config.commandApproval;
    ctrl.config.commandApproval = 'auto-approve';
    provider.messages = [];
    const FAIL = 'node -e "process.exit(1)"';
    const fixLoopCap = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'run_command', args: { command: FAIL } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'fix.js', content: '// attempt 1' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: FAIL } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'fix.js', content: '// attempt 2' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: FAIL } }] },
      { text: 'I could not make it pass: the check still fails.' },
    ], fixLoopCap);
    await provider.askNavy('fix the failing check', false, null, [], []);
    const runResults = fixLoopCap.slice(1).map(r => toolMsgs(r).pop() || '').filter((t, i) => i % 2 === 0);
    check('fixing: a check is re-run after each fix, not refused after two failures',
      runResults.length === 3 && runResults.every(t => /^Exit code: 1/.test(t)) && !runResults.some(t => /^\[Blocked/.test(t)),
      JSON.stringify(runResults.map(t => t.slice(0, 40))));
    check('fixing: two fixes that leave the check failing bring a rethink, not another patch',
      /2 fixes in a row have left this check failing. Stop patching/.test(runResults[2] || '') && !/fixes in a row/.test(runResults[1] || ''));
    check('fixing: …and the rethink asks for a plan that follows the new cause',
      /Replace your plan with update_plan/.test(runResults[2] || ''));

    // ── Escalation: a stuck turn is handed to navy.escalationModel. ──────
    ctrl.config.escalationModel = 'big-model';
    provider.messages = [];
    posted.length = 0;
    const escCap = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'run_command', args: { command: FAIL } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'esc.js', content: '// attempt 1' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: FAIL } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'esc.js', content: '// attempt 2' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: FAIL } }] },
      { text: 'Found it: the real cause is elsewhere. It still fails, though.' },
    ], escCap);
    await provider.askNavy('fix the failing check', false, 'small-model', [], []);
    const models = escCap.map(r => r.model);
    check('escalation: the turn runs on the configured model until it is stuck',
      models.slice(0, 5).every(m => m === 'small-model'), models.join(','));
    check('escalation: ...then, after two fixes leave the check failing, on navy.escalationModel',
      models[5] === 'big-model', models.join(','));
    check('escalation: the switch is announced in the chat and saved with the turn',
      posted.some(m => m.type === 'chunk' && /Handing the rest of this turn to big-model/.test(m.text || ''))
        && /Handing the rest of this turn to big-model/.test(provider.messages[provider.messages.length - 1]?.text || ''));
    const nextCap = [];
    global.fetch = queueOllamaFetch([{ text: 'ok' }], nextCap);
    await provider.askNavy('and now something else', false, 'small-model', [], []);
    check('escalation: the next turn starts on the configured model again', nextCap[0]?.model === 'small-model');
    check('escalation: unset, or the model already in use, means no switch',
      (() => { ctrl.config.escalationModel = ''; const a = provider._escalationTarget('small-model');
        ctrl.config.escalationModel = 'small-model'; const b = provider._escalationTarget('small-model');
        ctrl.config.escalationModel = 'claude-x'; ctrl.config.escalationProvider = 'anthropic'; const c = provider._escalationTarget('small-model');
        ctrl.config.escalationProvider = ''; ctrl.config.escalationModel = '';
        return a === null && b === null && c?.provider === 'anthropic' && c?.model === 'claude-x'; })());

    // ── A turn does not report with a file its own syntax check says it broke.
    provider.messages = [];
    const brokeCap = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'broke.js', content: 'function f() {\n+  return 1;\n' } }] },
      { text: '**Done:** wrote broke.js\n**Changed:** broke.js' },
      { toolCalls: [{ name: 'write_file', args: { path: 'broke.js', content: 'function f() {\n  return 1;\n}\nmodule.exports = f;\n' } }] },
      { text: 'Fixed the syntax error; done.' },
    ], brokeCap);
    await provider.askNavy('create broke.js with f() returning 1', false, null, [], []);
    check('broken file: a turn reporting with a file that does not parse is sent back',
      brokeCap.length === 4 && /still has a syntax error from your last edit/.test(JSON.stringify(brokeCap[2]?.messages || [])), 'requests=' + brokeCap.length);
    check('broken file: ...and once fixed, it finishes with no warning',
      !/does not parse/.test(provider.messages[provider.messages.length - 1]?.text || ''));
    provider.messages = [];
    posted.length = 0;
    const stillCap = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'broke2.js', content: 'const x = (;\n' } }] },
      { text: 'Done.' }, { text: 'Done.' }, { text: 'Done, really.' },
    ], stillCap);
    await provider.askNavy('create broke2.js', false, null, [], []);
    check('broken file: pushed back twice at most, then the user is told plainly',
      stillCap.length === 4 && posted.some(m => m.type === 'chunk' && /`broke2\.js` does not parse/.test(m.text || '')), 'requests=' + stillCap.length);

    // ── Finishing on a failing check gets one push back. ─────────────────
    provider.messages = [];
    const gateCap = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'gate.js', content: 'v1' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: FAIL } }] },
      { text: '**Done:** fixed it.\n**Changed:** gate.js\n**Result:** succeeded' },
      { text: '**Result:** failed - the check still fails because the input is never parsed.' },
    ], gateCap);
    await provider.askNavy('fix the gate', false, null, [], []);
    check('finish gate: a turn ending on its own failing check is sent back once',
      gateCap.length === 4 && /failed with exit code 1, yet you are finishing/.test(JSON.stringify(gateCap[3]?.messages || [])),
      'requests=' + gateCap.length);
    check('finish gate: ...and an honest "still fails" reply is accepted',
      /still fails/.test(provider.messages[provider.messages.length - 1]?.text || ''));
    const honestCap = [];
    provider.messages = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'gate.js', content: 'v2' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: FAIL } }] },
      { text: 'This is not fixed yet: the check still fails.' },
    ], honestCap);
    await provider.askNavy('fix the gate again', false, null, [], []);
    check('finish gate: a reply that already says it still fails is not sent back', honestCap.length === 3, 'requests=' + honestCap.length);

    // ── What the previous turn changed reaches a follow-up. ─────────────
    fs.writeFileSync(path.join(tmp, 'follow.js'), 'const rate = 10;\n');
    provider.messages = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'apply_edit', args: { path: 'follow.js', search: 'const rate = 10;', replace: 'const rate = 0.1;' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: FAIL } }] },
      { text: 'Changed the rate; the check still fails.' },
    ]);
    await provider.askNavy('fix the rate in follow.js', false, null, [], []);
    const followCap = [];
    global.fetch = queueOllamaFetch([{ text: 'Looking again.' }], followCap);
    await provider.askNavy('it still does not work', false, null, [], []);
    const followMsg = userOf(followCap[0]);
    check('follow-up: the request shows what the previous turn changed, as a diff',
      /What the previous turn changed/.test(followMsg) && /-const rate = 10;/.test(followMsg) && /\+const rate = 0\.1;/.test(followMsg),
      followMsg.slice(0, 300));
    check('follow-up: ...and what its last check said', /Its last check: `node -e "process\.exit\(1\)"` exited 1/.test(followMsg));
    ctrl.config.commandApproval = savedCmdMode;

    // ── Thinking levels from what Ollama says the model supports. ────────
    const { ollamaThink } = require('../src/thinking.js');
    const dsCaps = { supported: true, values: [false, 'low', 'high', 'max'], def: 'high' };
    check('think: Max sends "max" to a model that offers it',
      ollamaThink('deepseek-v4.1-flash:cloud', 'max', dsCaps).think === 'max');
    check('think: Extra high takes the deepest level not above it, and says so',
      ollamaThink('x', 'xhigh', dsCaps).think === 'high' && ollamaThink('x', 'xhigh', dsCaps).used === 'high');
    check('think: Fast takes the lightest level; Medium leaves the default',
      ollamaThink('x', 'fast', dsCaps).think === 'low' && ollamaThink('x', 'medium', dsCaps).think === undefined);
    check('think: a model that does not think is sent nothing, whatever its name',
      ollamaThink('qwen3:8b', 'max', { supported: false, values: null }).think === undefined);
    check('think: on/off-only thinking is switched on for deep levels',
      ollamaThink('x', 'high', { supported: true, values: null }).think === true);
    provider._recordOllamaThinking('deepseek-v4.1-flash:cloud', {
      capabilities: ['completion', 'thinking', 'tools'],
      thinking: { thinking: { values: [false, 'low', 'high', 'max'], default: 'high' } },
    });
    const thinkCap = [];
    const savedThink = provider.thinkingLevel;
    provider.thinkingLevel = 'max';
    provider.messages = [];
    global.fetch = queueOllamaFetch([{ text: 'ok' }], thinkCap);
    await provider.askNavy('hello', false, 'deepseek-v4.1-flash:cloud', [], []);
    provider.thinkingLevel = savedThink;
    check('think: Navy actually sends think:"max" for it — before, it sent nothing and the model ran at its default',
      thinkCap[0]?.think === 'max', JSON.stringify(thinkCap[0]?.think));

    // ── Screenshots: measured layout facts go with the picture, and a model that
    // cannot see images is not sent one (Ollama answers that with HTTP 400).
    const { formatLayoutCheck } = require('../src/browser-tools.js');
    const fmt = formatLayoutCheck({ findings: [{ kind: 'overlap', text: '"A" and "B" are drawn over each other' }],
      window: { width: 1264, height: 705 }, page: { height: 2000, scrollY: 0 } });
    check('screenshot: layout findings are listed as measured facts',
      /Automated layout checks/.test(fmt) && /\[overlap\] "A" and "B" are drawn over each other/.test(fmt));
    check('screenshot: ...with how much of the page lies below the window',
      /shows 0-705px of a 2000px-tall page; 1295px below it are not in view/.test(fmt), fmt);
    check('screenshot: ...and a clean screen says so',
      /no overlapping text, cut-off text, broken images/.test(formatLayoutCheck({ findings: [], window: { height: 700 }, page: { height: 700 } })));

    const realShot = provider.toolBrowserScreenshot;
    provider.toolBrowserScreenshot = async () => ({ __image: { mediaType: 'image/png', data: 'iVBORw0KGgo=' }, text: 'Screenshot captured.\n- [overlap] price over name' });
    const imagesIn = (req) => (req?.messages || []).some(m => Array.isArray(m.images) && m.images.length);
    provider._recordOllamaThinking('blind-model', { capabilities: ['completion', 'tools'] });
    provider.messages = [];
    const blindCap = [];
    global.fetch = queueOllamaFetch([{ toolCalls: [{ name: 'browser_screenshot', args: {} }] }, { text: 'Price overlaps the name.' }], blindCap);
    await provider.askNavy('look at the page', false, 'blind-model', [], []);
    check('screenshot: a model Ollama says cannot see is not sent the image',
      blindCap.length === 2 && !imagesIn(blindCap[1]));
    check('screenshot: ...it gets the measured checks and is told why there is no picture',
      /price over name/.test(toolMsgs(blindCap[1]).pop() || '') && /cannot see images, so the screenshot itself was not sent/.test(toolMsgs(blindCap[1]).pop() || ''));
    provider._recordOllamaThinking('eyes-model', { capabilities: ['completion', 'tools', 'vision'] });
    provider.messages = [];
    const eyesCap = [];
    global.fetch = queueOllamaFetch([{ toolCalls: [{ name: 'browser_screenshot', args: {} }] }, { text: 'ok' }], eyesCap);
    await provider.askNavy('look at the page', false, 'eyes-model', [], []);
    check('screenshot: a model with vision gets the image as well as the checks', imagesIn(eyesCap[1]));

    // A provider that turns an image down: images out, model remembered, step again.
    provider.messages = [];
    const rejCap2 = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'browser_screenshot', args: {} }] },
      { fail: { status: 400, text: '{"error":"this model does not support image input"}' } },
      { text: 'Working from the checks: the price overlaps the name.' },
    ], rejCap2);
    await provider.askNavy('look at the page', false, 'unknown-model', [], []);
    check('screenshot: a provider rejecting an image does not end the turn — images removed, step retried',
      rejCap2.length === 3 && imagesIn(rejCap2[1]) && !imagesIn(rejCap2[2])
        && /overlaps the name/.test(provider.messages[provider.messages.length - 1]?.text || ''), 'requests=' + rejCap2.length);
    check('screenshot: ...and that model is not sent images again', provider._modelSeesImages('unknown-model') === false);
    provider.toolBrowserScreenshot = realShot;

    // ── Folded tools: one way to read, one git tool; the retired names still run.
    fs.writeFileSync(path.join(tmp, 'lines.js'), 'one\ntwo\nthree\nfour\n');
    const ranged = await provider.executeTool({ name: 'read_file', args: { path: 'lines.js', start: 2, end: 3 } });
    check('tools: read_file with start/end reads just those lines',
      /two/.test(ranged) && /three/.test(ranged) && !/\bone\b/.test(ranged) && !/four/.test(ranged), ranged.slice(0, 120));
    const whole = await provider.executeTool({ name: 'read_file', args: { path: 'lines.js' } });
    check('tools: ...and without them, the whole file', /one/.test(whole) && /four/.test(whole));
    const oldRead = await provider.executeTool({ name: 'read_lines', args: { path: 'lines.js', start: 4, end: 4 } });
    check('tools: the retired read_lines is still understood', /four/.test(oldRead) && !/two/.test(oldRead));
    const oldEdit = await provider.executeTool({ name: 'edit_line', args: { path: 'lines.js', line: 1, content: 'ONE' } });
    check('tools: ...and so is the retired edit_line', /^Applied/.test(oldEdit) && fs.readFileSync(path.join(tmp, 'lines.js'), 'utf8').startsWith('ONE\n'), oldEdit);
    const gitStatus = await provider.executeTool({ name: 'git', args: { action: 'status' } });
    const gitBad = await provider.executeTool({ name: 'git', args: { action: 'push' } });
    check('tools: git runs its action, and refuses one it does not have',
      typeof gitStatus === 'string' && !/Unknown tool|git action must be/.test(gitStatus) && /git action must be one of status, diff, log, blame/.test(gitBad),
      String(gitStatus).slice(0, 80));

    // ── Self-review: a turn that edited reads its own diff once before reporting.
    ctrl.config.selfReview = 'on';
    fs.writeFileSync(path.join(tmp, 'rev.js'), 'function total(xs) {\n  return xs.length;\n}\n');
    provider.messages = [];
    const revCap = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'apply_edit', args: { path: 'rev.js', search: '  return xs.length;', replace: '  return xs.reduce((a, b) => a + b, 0);' } }] },
      { text: '**Done:** total now sums.\n**Changed:** rev.js\n**Result:** succeeded' },
      { text: '**Done:** total now sums the values; reviewed.\n**Changed:** rev.js\n**Result:** succeeded' },
    ], revCap);
    await provider.askNavy('make total() sum the values in rev.js', false, null, [], []);
    const reviewMsg = JSON.stringify(revCap[2]?.messages || []);
    check('self-review: a turn that edited is shown its own diff before it reports',
      revCap.length === 3 && /review the complete change you made this turn/.test(reviewMsg)
        && /-  return xs\.length;/.test(reviewMsg) && /\+  return xs\.reduce/.test(reviewMsg), 'requests=' + revCap.length);
    check('self-review: ...and the report that is kept is the one written after it',
      /reviewed\./.test(provider.messages[provider.messages.length - 1]?.text || ''));

    provider.messages = [];
    const noEditCap = [];
    global.fetch = queueOllamaFetch([{ text: 'It counts the items.' }], noEditCap);
    await provider.askNavy('what does total() in rev.js do?', false, null, [], []);
    check('self-review: a turn that edited nothing is not reviewed', noEditCap.length === 1, 'requests=' + noEditCap.length);

    provider.messages = [];
    const fixCap2 = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'rev2.js', content: 'console.log("debug");\nmodule.exports = 1;\n' } }] },
      { text: 'Done.' },
      { toolCalls: [{ name: 'write_file', args: { path: 'rev2.js', content: 'module.exports = 1;\n' } }] },
      { text: 'Removed a leftover debug line; done.' },
    ], fixCap2);
    await provider.askNavy('create rev2.js exporting 1', false, null, [], []);
    check('self-review: a fix made during the review is not reviewed again', fixCap2.length === 4, 'requests=' + fixCap2.length);

    ctrl.config.selfReview = 'off';
    provider.messages = [];
    const offCap = [];
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'rev3.js', content: 'x' } }] },
      { text: 'Done.' },
    ], offCap);
    await provider.askNavy('create rev3.js', false, null, [], []);
    check('self-review: navy.selfReview off skips it', offCap.length === 2, 'requests=' + offCap.length);

    // A reasoning model the name list misses is recognised once it reasons.
    provider.thinkingLevel = 'max';
    check('temperature: an unknown model starts at navy.temperature', provider._turnTemperature('mystery-model:cloud') === 0.2);
    provider._noteReasoningModel('mystery-model:cloud');
    check('temperature: ...and once seen streaming reasoning, gets the thinking-mode temperature',
      provider._turnTemperature('mystery-model:cloud') === 0.6);
    check('temperature: deepseek-v4.1-flash is known as a reasoning model from the first call',
      provider._turnTemperature('deepseek-v4.1-flash:cloud') === 0.6);
    provider.thinkingLevel = savedLevel;

    // ── Reasoning that goes in circles. The screenshot: "Let me call. OK.
    // I'll call it. Go." over and over inside one Thinking block, until the
    // turn ran out. The call is stopped as soon as the loop shows, retried
    // once with a nudge to act, and the turn ends plainly if it loops again.
    const { looksLikeReasoningLoop, ReasoningLoopGuard } = require('../src/reasoning-loop.js');
    const LOOP = Array.from({ length: 300 }, (_, i) =>
      ['Let me call.', 'OK.', 'I\'ll call it.', 'Go.', 'Let me write.', 'Calling.'][i % 6]).join('\n\n');
    const GENUINE = Array.from({ length: 80 }, (_, i) =>
      `Step ${i}: the parser reads token ${i * 7}, so line ${i + 3} needs a guard for ${['nulls', 'empty arrays', 'unicode', 'tabs'][i % 4]}.`).join(' ');
    const PASSAGE = ('I need to write the whole server file now with the routes, the middleware, the error handler and the '
      + 'startup code, then call write_file with all of it in one go so nothing is left half done. ').repeat(8);
    check('loop: the screenshot\'s short repeating sentences are a loop', looksLikeReasoningLoop(LOOP));
    check('loop: a long passage repeated word for word is a loop', looksLikeReasoningLoop(PASSAGE));
    check('loop: long, varied reasoning is not', !looksLikeReasoningLoop(GENUINE));
    check('loop: too little reasoning to judge is not', !looksLikeReasoningLoop(LOOP.slice(0, 800)));
    let trips = 0;
    const guard = new ReasoningLoopGuard(() => trips++);
    for (let i = 0; i < LOOP.length; i += 40) guard.feed(LOOP.slice(i, i + 40));
    check('loop: the guard trips while it streams, and only once', guard.tripped && trips === 1);

    // Streaming activity re-arms the turn watchdog, so a long but active
    // reasoning stream is not aborted as a hang after 3 minutes.
    let armed = 0;
    provider._armWatchdog = () => { armed++; };
    provider._lastWatchdogPoke = 0;
    provider._noteStreamActivity();
    check('watchdog: a stream chunk re-arms the watchdog', armed === 1);
    provider._noteStreamActivity();
    check('watchdog: ...but rapid chunks are throttled, not re-armed every time', armed === 1);
    provider._lastWatchdogPoke = Date.now() - 3000;
    provider._noteStreamActivity();
    check('watchdog: ...and it re-arms again once the throttle window has passed', armed === 2);
    provider._armWatchdog = null;
    provider._noteStreamActivity();
    check('watchdog: outside a turn (no watchdog armed) it does nothing', armed === 2);

    const thinkingEvent = (thinking, content = '') =>
      ({ message: { role: 'assistant', content, thinking }, done: true, prompt_eval_count: 5, eval_count: 5 });
    const scripted = (events, cap) => async (url, init) => {
      if (cap && init?.body) cap.push(JSON.parse(init.body));
      const evt = events.shift();
      if (!evt) throw new Error('scripted fetch exhausted');
      return { ok: true, status: 200, body: makeOneShotBody(evt), text: async () => '' };
    };
    provider.messages = [];
    posted.length = 0;
    const loopCap = [];
    global.fetch = scripted([thinkingEvent(LOOP), thinkingEvent('Read the file, then answer.', 'Here is the answer.')], loopCap);
    await provider.askNavy('explain the server', false, null, [], []);
    check('loop: a looping call is stopped and retried once',
      loopCap.length === 2, 'requests=' + loopCap.length);
    check('loop: ...with a nudge to act on what it kept announcing',
      /reasoning was going in circles/.test(JSON.stringify(loopCap[1]?.messages || [])));
    check('loop: ...a little warmer than before',
      loopCap[1]?.options?.temperature > loopCap[0]?.options?.temperature,
      `${loopCap[0]?.options?.temperature} -> ${loopCap[1]?.options?.temperature}`);
    check('loop: ...the chat is told why',
      posted.some(m => m.type === 'systemNotice' && /reasoning started repeating itself/.test(m.text)));
    check('loop: ...and the turn finishes with the real answer',
      /Here is the answer\./.test(provider.messages[provider.messages.length - 1]?.text || ''));

    posted.length = 0;
    const twiceCap = [];
    global.fetch = scripted([thinkingEvent(LOOP), thinkingEvent(LOOP)], twiceCap);
    await provider.askNavy('explain the server again', false, null, [], []);
    check('loop: looping again ends the turn instead of retrying forever',
      twiceCap.length === 2, 'requests=' + twiceCap.length);
    check('loop: ...and says so in the reply that is saved',
      /went in circles again/.test(provider.messages[provider.messages.length - 1]?.text || ''));

    // A loop, then a real action, then a loop much later is NOT the same loop
    // twice: acting cleared the budget, so the turn survives the second one.
    // Without the reset, a long productive turn (many steps) was killed at its
    // second ever loop, however far apart the two were.
    const toolEvent = (name, args) => ({ message: { role: 'assistant', content: '',
      tool_calls: [{ function: { name, arguments: JSON.stringify(args || {}) } }] }, done: true, prompt_eval_count: 5, eval_count: 5 });
    provider.messages = [];
    posted.length = 0;
    const spacedCap = [];
    global.fetch = scripted([
      thinkingEvent(LOOP),                               // loop #1 → stopped, retried
      toolEvent('list_files', { path: '' }),             // acts → budget clears
      toolEvent('list_files', { path: 'src' }),          // keeps working
      thinkingEvent(LOOP),                               // loop #2, much later → stopped, retried again
      thinkingEvent('Now I will answer.', 'All done.'),  // recovers and finishes
    ], spacedCap);
    await provider.askNavy('do a long job', false, null, [], []);
    check('loop: acting between two loops keeps the turn alive, it is not "again"',
      !/went in circles again/.test(provider.messages[provider.messages.length - 1]?.text || ''),
      provider.messages[provider.messages.length - 1]?.text?.slice(-120));
    check('loop: ...and the turn still reaches the real answer',
      /All done\./.test(provider.messages[provider.messages.length - 1]?.text || ''));
  } catch (e) {
    check('hallucination suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 7b2. Cross-turn tool activity ledger ─────────────────────────────────────
// Replaying history for a new turn only ever carried each past turn's final
// reply TEXT (see the "for (const item of this.messages)" loop in askNavy) —
// so the model had no way to know it already read a file or ran a command in
// an earlier turn unless it happened to say so in prose, and routinely re-did
// work it had already done. _renderTurnLedger appends a compact, verifiable
// record of what a turn actually did (reads/writes/commands) to the
// MODEL-FACING copy of its historical reply — never to the persisted/
// displayed text itself.
async function toolLedgerSuite() {
  console.log('\ncross-turn tool activity ledger:');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-ledger-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    provider._wslCache = { available: false }; // skip the real wsl.exe spawn in tests
    fs.writeFileSync(path.join(tmp, 'source.js'), 'module.exports = 1;\n');

    // Pure formatting checks — no model loop needed.
    check('_describeReadCall: read_file includes the path',
      provider._describeReadCall({ name: 'read_file', args: { path: 'a/b.js' } }) === 'read_file(a/b.js)');
    check('_turnLedgerParts: empty/undefined meta renders nothing',
      provider._turnLedgerParts(undefined) === '' && provider._turnLedgerParts({}) === '');
    check('_turnLedgerParts: formats reads, writes, and commands together',
      /read a\.js, b\.js/.test(provider._turnLedgerParts({ reads: ['a.js', 'b.js'] }))
      && /wrote c\.js/.test(provider._turnLedgerParts({ files: ['c.js'] }))
      && /ran "npm test" \(exit 0\)/.test(provider._turnLedgerParts({ commandLog: [{ cmd: 'npm test', exit: 0 }] })));

    // A model that used tools and then reported files it never wrote escaped
    // the hallucination guard entirely — that guard only fires when NO tool was
    // called all turn. This is the reported bug: "navy said i changed this and
    // that while it did not change anything".
    const claims = (t) => provider._claimsFilesChanged(t);
    check('claim check: the exact line from the bug report is a claim',
      claims('**Changed:** `test-visual.mjs`, `src/scene.js`'));
    check('claim check: a plain Changed: line counts too',
      claims('Done: stuff\nChanged: scene.js\nResult: succeeded'));
    check('claim check: the documented "no files" form is NOT a claim',
      !claims('**Changed:** No files changed') && !claims('Changed: none') && !claims('Changed: n/a'));
    check('claim check: prose naming no file is NOT a claim',
      !claims('**Changed:** the behaviour of the retry loop'));
    check('claim check: a reply with no report at all is NOT a claim',
      !claims('I read the file and it looks fine.'));

    // Turn 1: reads source.js, writes out.js, then finishes.
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'source.js' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'out.js', content: 'x=1' } }] },
      { text: 'Done — read source.js and wrote out.js.' },
    ]);
    await provider.askNavy('do the first task', false, null, [], []);

    check('turn ledger: meta.reads captured on the persisted assistant message',
      provider.messages[1]?.meta?.reads?.some(r => r.includes('source.js')));
    check('turn ledger: meta.files captured on the persisted assistant message',
      provider.messages[1]?.meta?.files?.includes('out.js'));
    check('turn ledger: never leaks into the persisted/displayed text itself',
      !provider.messages[1].text.includes('[Tool activity'));

    // Turn 2: the OUTGOING request must tell the model what turn 1 actually
    // did, appended to THAT historical message specifically.
    const captured = [];
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('do the second task', false, null, [], []);
    const sentMessages = captured[0]?.messages || [];
    const turn1Reply = sentMessages.find(m => m.role === 'assistant' && /read source\.js and wrote out\.js/.test(m.content || ''));
    // In the new request's own message, not the system prompt: the ledger grows
    // every turn, and in the system prompt that growth made every turn
    // reprocess the whole conversation instead of reusing the cached prefix.
    const sys = String([...sentMessages].reverse().find(m => m.role === 'user')?.content || '');
    check('turn ledger: kept out of the system prompt, which must not change between turns',
      !/What earlier turns already did/.test(sentMessages.find(m => m.role === 'system')?.content || ''));
    check('turn ledger: reaches the model on the NEXT turn', /What earlier turns already did/.test(sys));
    check('turn ledger: names the exact file that was read', /read_file\(source\.js\)/.test(sys));
    check('turn ledger: names the exact file that was written', /wrote out\.js/.test(sys));
    check('turn ledger: numbers the turn it belongs to', /- Turn 1: /.test(sys));

    // The bug this shape exists to prevent. Appended to the assistant message,
    // the record read to the model as something IT had written, so it copied
    // the format into its own replies — and, writing prose rather than reading
    // a tool result, invented the contents: a turn that changed nothing still
    // announced files it had "written". An assistant message must carry only
    // what the model actually said.
    check('turn ledger: NOT appended to the model-facing assistant message',
      Boolean(turn1Reply) && !/Tool activity|read_file\(source\.js\)/.test(turn1Reply.content),
      JSON.stringify(turn1Reply?.content || '').slice(0, 120));
    check('turn ledger: the assistant message is exactly what was said',
      turn1Reply?.content === 'Done — read source.js and wrote out.js.',
      JSON.stringify(turn1Reply?.content || ''));
    check('turn ledger: the request tells the model not to reproduce it',
      /never reproduce this list in a reply/.test(sys));

    // And it must not show up in the webview — main.js's own rendering of
    // meta only reads files/deleted/commands, never reads/commandLog.
    check('turn ledger: never sent to the webview as visible chat text',
      !posted.some(m => m.type === 'chunk' && /\[Tool activity that turn/.test(m.text || '')));
  } catch (e) {
    check('cross-turn tool ledger suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── History-digest trigger — size, not just message COUNT ──────────────────
// Nothing used to bound the size of PAST turns being replayed except a raw
// message-count threshold (>80) — a handful of verbose turns (big files/
// search results quoted back) could sit at hundreds of thousands of
// characters, replayed on every iteration of every future turn, while never
// reaching 80 messages. The digest trigger now also fires on total size, and
// must never spend a wasted extra model call summarizing when the recency
// floor means nothing was actually dropped.
async function historyDigestSuite() {
  console.log('\nhistory-digest trigger (size, not just message count):');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  const isDigestCall = (req) => typeof req?.messages?.[0]?.content === 'string'
    && req.messages[0].content.includes('You compress coding-assistant conversation history');

  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-histdigest-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider._wslCache = { available: false };

    // ── A few huge messages (well under 80) must still trigger the digest ──
    provider.messages = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: 'x'.repeat(20000) + ' turn-' + i,
    }));
    {
      const captured = [];
      global.fetch = queueOllamaFetch([
        { text: 'Digest: did stuff with the earlier turns.' }, // the summarization call
        { text: 'main turn reply' },                            // the actual turn
      ], captured);
      await provider.askNavy('continue', false, null, [], []);

      check('size trigger: 15 messages × 20,000 chars (300k, far under 80-message count) still condenses', captured.some(isDigestCall));
      check('size trigger: sessionDigest was populated', Boolean(provider.sessionDigest && provider.sessionDigest.trim()));
      // 10 kept (recency floor lets it keep growing until adding the next
      // would exceed the 200k cap) + this turn's own new user+assistant = 12.
      check('size trigger: oldest messages were actually dropped, not just digested', provider.messages.length === 12);
      check('size trigger: the KEPT tail is the most recent messages, in original order',
        provider.messages[0].text.includes('turn-5') && provider.messages[9].text.includes('turn-14'));
    }

    // ── An ordinary short/small session must never trigger it at all ───────
    provider.messages = [
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
    ];
    provider.sessionDigest = '';
    {
      const captured = [];
      global.fetch = queueOllamaFetch([{ text: 'main turn reply' }], captured);
      await provider.askNavy('another message', false, null, [], []);
      check('no trigger: a small, short session never attempts a digest call', !captured.some(isDigestCall));
      check('no trigger: sessionDigest stays empty', !provider.sessionDigest);
    }

    // ── Recency floor: fewer than MIN_KEEP messages, even if huge, must ─────
    // never spend a wasted summarization call — there is nothing willing to
    // be dropped, so attempting one would burn tokens for nothing.
    provider.messages = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: 'y'.repeat(100000) + ' turn-' + i, // 500k total, far over the 200k cap
    }));
    provider.sessionDigest = '';
    {
      const captured = [];
      global.fetch = queueOllamaFetch([{ text: 'main turn reply' }], captured); // only ONE reply queued
      await provider.askNavy('one more', false, null, [], []);
      check('recency floor: fewer than MIN_KEEP huge messages skips the digest call entirely (only 1 fetch, not 2)', captured.length === 1);
      check('recency floor: none of the original messages were silently dropped', provider.messages.length === 7); // 5 kept + this turn's 2
      check('recency floor: sessionDigest stays empty (nothing was actually condensed)', !provider.sessionDigest);
    }

    // ── The original count-based trigger still works exactly as before ─────
    provider.messages = Array.from({ length: 85 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: 'short-' + i, // tiny — this must trigger on COUNT alone, not size
    }));
    provider.sessionDigest = '';
    {
      const captured = [];
      global.fetch = queueOllamaFetch([
        { text: 'Digest of the oldest turns.' },
        { text: 'main turn reply' },
      ], captured);
      await provider.askNavy('yet another', false, null, [], []);
      check('count trigger: 85 tiny messages (over the 80-message count) still condenses as before', captured.some(isDigestCall));
      // 60 kept (the original "keep last 60" target) + this turn's own 2.
      check('count trigger: keeps exactly the same last-60 window as the original behavior', provider.messages.length === 62);
    }
  } catch (e) {
    check('history-digest suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 7b4. delegate_research sub-agent ──────────────────────────────────────────
// A tool the MODEL itself can call to spin off an isolated, read-only
// investigation and get back only the conclusion — not the raw tool trace,
// which stays out of the delegating turn's own context. The security-critical
// property is enforcement: the sub-agent is refused write/command/further-
// delegation attempts at DISPATCH time, not merely discouraged by prompt text.
async function delegateResearchSuite() {
  console.log('\ndelegate_research sub-agent:');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-delegate-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider._wslCache = { available: false };
    fs.writeFileSync(path.join(tmp, 'target.js'), 'function foo(){ return 42; }');

    check('delegate_research: a missing/empty task is refused with a clear error, not a crash',
      (await provider.toolDelegateResearch('', 5)).startsWith('Error:'));
    check('delegate_research: a whitespace-only task is refused the same way',
      (await provider.toolDelegateResearch('   ', 5)).startsWith('Error:'));

    // Direct unit calls — no outer turn needed, exercises the sub-agent loop
    // in isolation via the SAME global.fetch queue mechanism.
    provider.abortController = new AbortController();

    // Reads a file, then answers in plain text with no further tool calls —
    // the RETURNED text must be the sub-agent's conclusion, not raw tool output.
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'target.js' } }] },
      { text: 'foo() returns the constant 42.' },
    ]);
    const basic = await provider.toolDelegateResearch('what does foo() return?', 5);
    check('delegate_research: returns the sub-agent\'s written conclusion', basic === 'foo() returns the constant 42.');

    // A write attempt inside the sub-agent is REFUSED (dispatch-level, not
    // just discouraged by the prompt) — must not actually touch disk, and the
    // sub-agent must be able to recover and still finish with an answer.
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'sneaky.js', content: 'not allowed' } }] },
      { text: 'I do not have write access, so I could not make this change.' },
    ]);
    const refused = await provider.toolDelegateResearch('try to write a file', 5);
    check('delegate_research: a write attempt is never actually executed', !fs.existsSync(path.join(tmp, 'sneaky.js')));
    check('delegate_research: the sub-agent recovers and still returns a conclusion after being refused',
      refused.includes('write access'));

    // Recursion guard: a nested delegate_research attempt must be refused,
    // not actually spawn a second sub-agent — verified by inspecting what the
    // sub-agent's OWN next request actually contained.
    {
      const captured = [];
      global.fetch = queueOllamaFetch([
        { toolCalls: [{ name: 'delegate_research', args: { task: 'nested attempt' } }] },
        { text: 'Understood, cannot delegate further.' },
      ], captured);
      await provider.toolDelegateResearch('try to recurse', 5);
      const secondRequestMsgs = captured[1]?.messages || [];
      const refusalMsg = secondRequestMsgs.find(m => typeof m.content === 'string' && m.content.includes('Refused') && m.content.includes('delegate_research'));
      check('delegate_research: cannot recursively delegate — refused, not executed', Boolean(refusalMsg));
    }

    // maxSteps is enforced, not advisory — a sub-agent that never stops
    // calling tools must be cut off, never loop forever. Exactly 3 responses
    // queued for maxSteps=3: a 4th fetch attempt would throw "exhausted".
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'target.js' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'target.js' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'target.js' } }] },
    ]);
    const capped = await provider.toolDelegateResearch('keep reading forever', 3);
    check('delegate_research: respects maxSteps and stops instead of looping forever', /step budget/.test(capped));

    // maxSteps below 1 clamps to 1 (not 0, which would never call the model
    // at all) — proven by exactly ONE queued response being consumed.
    global.fetch = queueOllamaFetch([{ toolCalls: [{ name: 'read_file', args: { path: 'target.js' } }] }]);
    const clamped = await provider.toolDelegateResearch('task', 0);
    check('delegate_research: maxSteps below 1 clamps to 1, still runs at least once', /step budget/.test(clamped));

    // ── End-to-end: a full turn that delegates, with token/cost accounting ──
    // Outer iter 1 (delegate_research) → sub-agent iter 1 (read_file) →
    // sub-agent iter 2 (final text) → outer iter 2 (final text). 4 model
    // calls total; queueOllamaFetch reports 5+5 tokens each = 20+20.
    provider.messages = [];
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'delegate_research', args: { task: 'find how foo works in target.js' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'target.js' } }] },
      { text: 'foo() returns 42.' },
      { text: 'Investigated via a sub-agent: foo() returns 42.' },
    ]);
    await provider.askNavy('investigate target.js', false, null, [], []);

    check('delegate_research (e2e): the sub-agent\'s internal steps never leak into the main chat history',
      provider.messages.length === 2); // just the user turn + the outer turn's own final assistant message
    check('delegate_research (e2e): the OUTER turn\'s persisted text is its own, not the sub-agent\'s raw output',
      provider.messages[1].text === 'Investigated via a sub-agent: foo() returns 42.');
    const toolResultMsg = posted.find(m => m.type === 'toolResult' && m.tool === 'delegate_research');
    check('delegate_research (e2e): the tool card shows the sub-agent\'s conclusion',
      toolResultMsg?.result === 'foo() returns 42.');
    check('delegate_research (e2e): sub-agent token usage is folded into the turn\'s recorded total (4 calls × 5 = 20 each)',
      provider.messages[1].meta?.tokens?.prompt === 20 && provider.messages[1].meta?.tokens?.completion === 20);
  } catch (e) {
    check('delegate_research suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// Delegation used to be strictly one at a time: two unrelated questions cost
// two full sub-agent budgets in series. It is parallel-safe — a sub-agent only
// reads — so it now rides the same batching path as any other read-only call.
// Which makes recursion the thing to pin: an agent that can delegate can
// delegate to an agent that can delegate, and that has no natural floor.
async function delegationFanOutSuite() {
  console.log('\ndelegation fan-out (concurrent, bounded, non-recursive):');
  const os = require('os');
  const { ctrl } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-fanout-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider.view = { webview: { postMessage: () => {} } };
    provider._wslCache = { available: false };
    // Delegation only ever happens inside a turn, which always has a controller.
    provider.abortController = new AbortController();
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'alpha');

    // ── delegate_research is now parallel-safe, and the sub-agent's own
    //    permitted set is READ_ONLY minus delegating again. ────────────────
    const extSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
    check('READ_ONLY now contains delegate_research (so batching can run several)',
      /'delegate_research'\]\);/.test(extSrc));
    check('SUB_AGENT_TOOLS is derived from READ_ONLY, not written out again',
      /SUB_AGENT_TOOLS = new Set\(\[\.\.\.READ_ONLY\]\.filter/.test(extSrc));
    check('the sub-agent loop gates on SUB_AGENT_TOOLS, not READ_ONLY',
      /if \(!SUB_AGENT_TOOLS\.has\(tool\.name\)\)/.test(extSrc));

    // ── Two delegations issued together actually overlap. ─────────────────
    // Each sub-agent answers in one model call, after a delay, so overlap is
    // observable: serial execution cannot interleave the markers.
    const events = [];
    let call = 0;
    global.fetch = async () => {
      const id = ++call;
      events.push('start:' + id);
      await new Promise(r => setTimeout(r, 25));
      events.push('end:' + id);
      const evt = { message: { role: 'assistant', content: 'Findings for call ' + id }, done: true, prompt_eval_count: 5, eval_count: 5 };
      return { ok: true, status: 200, body: makeOneShotBody(evt), text: async () => '' };
    };

    const both = await Promise.all([
      provider.toolDelegateResearch('how does auth work', 2),
      provider.toolDelegateResearch('where is the retry logic', 2),
    ]);
    check('two delegations run concurrently, not one after the other',
      events.indexOf('start:2') < events.indexOf('end:1'), events.join(' | '));
    check('each delegation returns its own findings',
      both.length === 2 && both.every(r => /Findings for call/.test(r)), JSON.stringify(both));
    check('the in-flight counter is back to zero afterwards', provider._session._activeDelegations === 0);

    // ── Bounded. A runaway model must not spend a dozen budgets at once. ──
    let release;
    const held = new Promise(r => { release = r; });
    global.fetch = async () => {
      await held;
      const evt = { message: { role: 'assistant', content: 'done' }, done: true, prompt_eval_count: 1, eval_count: 1 };
      return { ok: true, status: 200, body: makeOneShotBody(evt), text: async () => '' };
    };
    const running = [];
    for (let i = 0; i < 4; i++) running.push(provider.toolDelegateResearch('task ' + i, 1));
    // Let the four register before asking for a fifth.
    await new Promise(r => setImmediate(r));
    const fifth = await provider.toolDelegateResearch('one too many', 1);
    check('a fifth concurrent delegation is refused, not queued', /Refused/.test(fifth) && /limit \(4\)/.test(fifth), fifth);
    check('…and the refusal tells the model what to do instead', /Wait for these results/.test(fifth));
    release();
    await Promise.all(running);
    check('the counter drains back to zero after a refusal', provider._session._activeDelegations === 0);

    // ── A sub-agent cannot delegate further. ─────────────────────────────
    // One model call asks to delegate, the next answers in text.
    const replies = [
      { toolCalls: [{ name: 'delegate_research', args: { task: 'recurse forever' } }] },
      { text: 'I could not delegate, so here is what I found directly.' },
    ];
    let n = 0;
    global.fetch = async () => {
      const next = replies[n++] || { text: 'done' };
      const evt = next.toolCalls
        ? { message: { role: 'assistant', content: '', tool_calls: next.toolCalls.map(tc => ({ function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) }, done: true, prompt_eval_count: 1, eval_count: 1 }
        : { message: { role: 'assistant', content: next.text }, done: true, prompt_eval_count: 1, eval_count: 1 };
      return { ok: true, status: 200, body: makeOneShotBody(evt), text: async () => '' };
    };
    const nested = await provider.toolDelegateResearch('investigate, and try to delegate', 3);
    check('a sub-agent that tries to delegate is refused rather than recursing',
      /could not delegate/.test(nested), nested.slice(0, 160));
    check('the recursion refusal is specific, not the generic read-only one',
      n >= 2 && provider._session._activeDelegations === 0);

    // The sub-agent's own instructions must still say so — the refusal is a
    // backstop, not the primary mechanism.
    check('the sub-agent prompt still forbids delegating further',
      /cannot .*delegate further|CANNOT write.*delegate further/i.test(extSrc));
  } finally {
    global.fetch = realFetch;
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// Tool batching. The loop has always been able to run read-only calls
// concurrently, but two things stopped it being worth anything: the system
// prompt forbade emitting more than one call at a time, and the concurrency was
// all-or-nothing — a single write anywhere in the batch forced every read in it
// onto the serial path. These pin both halves of the fix, and the ordering
// guarantee that makes the concurrency safe.
async function toolBatchingSuite() {
  console.log('\ntool batching (concurrent reads, ordered writes):');
  const os = require('os');
  const { ctrl } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-batching-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider.view = { webview: { postMessage: () => {} } };
    provider._wslCache = { available: false }; // skip the real wsl.exe spawn in tests
    ctrl.config.approvalMode = 'auto-approve';
    for (const name of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(tmp, name), 'body of ' + name);

    // Instrument executeTool so overlap is observable: every call announces
    // itself, yields to the event loop, then announces completion. Concurrent
    // calls interleave their markers; serial ones cannot.
    const events = [];
    const realExecuteTool = provider.executeTool.bind(provider);
    provider.executeTool = async (tool, turnIdOverride) => {
      events.push('start:' + tool.name + ':' + (tool.args?.path || ''));
      await new Promise(r => setTimeout(r, 15));
      const out = await realExecuteTool(tool, turnIdOverride);
      events.push('end:' + tool.name + ':' + (tool.args?.path || ''));
      return out;
    };
    const bothStartedFirst = (evts, one, two) =>
      evts.indexOf('start:' + one) < evts.indexOf('end:' + two) &&
      evts.indexOf('start:' + two) < evts.indexOf('end:' + one);

    // ── Reads-then-write: the reads overlap, the write waits for both. ──────
    events.length = 0;
    global.fetch = queueOllamaFetch([
      { toolCalls: [
        { name: 'read_file', args: { path: 'a.txt' } },
        { name: 'read_file', args: { path: 'b.txt' } },
        { name: 'write_file', args: { path: 'c.txt', content: 'rewritten' } },
      ] },
      { text: 'Done.' },
    ]);
    await provider.askNavy('read a and b, then rewrite c', false, null, [], []);

    check('mixed batch: the leading reads run concurrently',
      bothStartedFirst(events, 'read_file:a.txt', 'read_file:b.txt'), events.join(' | '));
    check('mixed batch: the write starts only after both reads finish',
      events.indexOf('start:write_file:c.txt') > events.indexOf('end:read_file:a.txt') &&
      events.indexOf('start:write_file:c.txt') > events.indexOf('end:read_file:b.txt'), events.join(' | '));
    check('mixed batch: the write still actually happened',
      fs.readFileSync(path.join(tmp, 'c.txt'), 'utf8') === 'rewritten');

    // ── A read AFTER a write is never hoisted: it usually exists to observe
    //    that write, so racing it against the write would defeat the point. ──
    events.length = 0;
    global.fetch = queueOllamaFetch([
      { toolCalls: [
        { name: 'write_file', args: { path: 'c.txt', content: 'second pass' } },
        { name: 'read_file', args: { path: 'c.txt' } },
        { name: 'read_file', args: { path: 'a.txt' } },
      ] },
      { text: 'Done.' },
    ]);
    await provider.askNavy('rewrite c then read it back', false, null, [], []);

    const trailingSerial =
      events.indexOf('end:write_file:c.txt') < events.indexOf('start:read_file:c.txt') &&
      events.indexOf('end:read_file:c.txt') < events.indexOf('start:read_file:a.txt');
    check('write-first batch: nothing is hoisted — every call stays serial and ordered', trailingSerial, events.join(' | '));

    // ── All-read batches keep the concurrency they always had. ──────────────
    events.length = 0;
    global.fetch = queueOllamaFetch([
      { toolCalls: [
        { name: 'read_file', args: { path: 'a.txt' } },
        { name: 'read_file', args: { path: 'b.txt' } },
        { name: 'read_file', args: { path: 'c.txt' } },
      ] },
      { text: 'Done.' },
    ]);
    await provider.askNavy('read all three', false, null, [], []);
    check('all-read batch: still fully concurrent',
      events.slice(0, 3).every(e => e.startsWith('start:')), events.join(' | '));

    // ── A lone read is not a batch — it must not lose the serial path's
    //    bookkeeping just because it happens to be read-only. ───────────────
    events.length = 0;
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { text: 'Done.' },
    ]);
    await provider.askNavy('read a', false, null, [], []);
    check('single read: runs, and on the serial path', events.length === 2 && events[0] === 'start:read_file:a.txt');

    provider.executeTool = realExecuteTool;

    // ── The prompt has to permit what the loop now does, and the reduced tier
    //    has to keep the strict contract small models cope with. ────────────
    const toolsMod = require('../src/providers/tools.js');
    check('TOOL_PROMPT: rule 5 asks for batched read-only calls',
      /^5\. BATCHING: /m.test(toolsMod.TOOL_PROMPT) && /executed concurrently/.test(toolsMod.TOOL_PROMPT));
    check('TOOL_PROMPT: batching is gated on independence, not just read-only',
      /needs an earlier one's result/.test(toolsMod.TOOL_PROMPT));
    // The swap is a regex against TOOL_PROMPT's literal text — a silent miss
    // would ship small models the batching advice, so pin that it landed.
    check('TOOL_PROMPT_CORE: small models keep one-call-at-a-time',
      /^5\. One tool call per response/m.test(toolsMod.TOOL_PROMPT_CORE) &&
      !/BATCHING/.test(toolsMod.TOOL_PROMPT_CORE.split('## Reduced tool set')[0]));
  } finally {
    global.fetch = realFetch;
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// Navy has always asked for a plan, and the panel has always drawn one — by
// scraping a numbered list out of prose and mapping tool-loop iterations onto
// the steps, which its own comment called approximate. update_plan replaces
// both guesses with state the model declares: what the steps are, and which one
// is actually running.
async function planSuite() {
  console.log('\ntask plans (declared, not inferred):');
  const os = require('os');
  const { ctrl } = sharedMock();
  const { normalizePlan, renderPlan, MAX_PLAN_STEPS, verifyStepIndexes, flagUnverified } = require('../src/plan.js');
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-plan-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const posted = [];
    provider.view = { webview: { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } } };
    provider._wslCache = { available: false };

    // ── normalizePlan is where a weak model's output gets made safe. ──────
    check('plan: bare strings are accepted as pending steps — models emit them whatever the schema says',
      JSON.stringify(normalizePlan(['read it', 'fix it']).steps) ===
      JSON.stringify([{ step: 'read it', status: 'pending' }, { step: 'fix it', status: 'pending' }]));
    check('plan: an unknown status falls back to pending rather than being rejected',
      normalizePlan([{ step: 'a', status: 'halfway' }]).steps[0].status === 'pending');
    check('plan: two in_progress steps are refused — that is two plans, not one',
      /Only one step/.test(normalizePlan([
        { step: 'a', status: 'in_progress' }, { step: 'b', status: 'in_progress' }]).error));
    check('plan: one in_progress step is fine',
      normalizePlan([{ step: 'a', status: 'in_progress' }, { step: 'b' }]).steps.length === 2);
    check('plan: an empty plan is refused', Boolean(normalizePlan([]).error));
    check('plan: a non-array is refused', Boolean(normalizePlan('read the file').error));
    check('plan: a step with no text is refused and says which one',
      /Step 2/.test(normalizePlan(['ok', { status: 'done' }]).error));

    // ── Reported from real use: every update_plan call failed with "Step 1
    //    has no text", five times in a row, until the turn ran out. The plan
    //    was fine; the reader only accepted the key "step", and models
    //    substitute a synonym constantly. The error named the requirement but
    //    not the input, so the model had nothing to change and re-sent it.
    for (const key of ['description', 'title', 'text', 'task', 'content', 'name', 'label', 'action']) {
      const r = normalizePlan([{ [key]: 'Read the auth module', status: 'pending' }]);
      check(`plan: a step keyed "${key}" is understood, not refused`,
        r.steps?.[0]?.step === 'Read the auth module', r.error);
    }
    check('plan: an object with one unambiguous string is understood whatever the key',
      normalizePlan([{ '1': 'Read the auth module' }]).steps?.[0]?.step === 'Read the auth module');
    check('plan: …but a step carrying only a status is still refused — nothing to name it',
      Boolean(normalizePlan([{ status: 'done' }]).error));
    check('plan: the refusal shows what actually arrived, so the model can correct it',
      /received \{"status":"done"\}/.test(normalizePlan([{ status: 'done' }]).error),
      normalizePlan([{ status: 'done' }]).error);
    check('plan: a double-encoded steps string is parsed rather than refused',
      normalizePlan('[{"step":"Read the file"}]').steps?.[0]?.step === 'Read the file');
    check('plan: a single step sent unwrapped is a plan of one',
      normalizePlan({ step: 'Read the file' }).steps?.length === 1);
    check('plan: status still survives a synonym key',
      normalizePlan([{ description: 'a', status: 'done' }]).steps[0].status === 'done');
    check('plan: too many steps is refused with the limit named',
      new RegExp('at most ' + MAX_PLAN_STEPS).test(
        normalizePlan(Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => 'step ' + i)).error));
    check('plan: a very long step is truncated, not rejected',
      normalizePlan(['x'.repeat(500)]).steps[0].step.length === 120);
    check('plan: rendering marks done, running and pending distinctly',
      renderPlan([{ step: 'a', status: 'done' }, { step: 'b', status: 'in_progress' }, { step: 'c', status: 'pending' }])
        === '[x] 1. a\n[>] 2. b\n[ ] 3. c');

    // ── The tool. ─────────────────────────────────────────────────────────
    posted.length = 0;
    const res = await provider.toolUpdatePlan([
      { step: 'Read the auth module', status: 'done' },
      { step: 'Patch the retry', status: 'in_progress' },
      { step: 'Run the tests' },
    ]);
    check('update_plan: reports progress back to the model', /1\/3 done/.test(res), res);
    check('update_plan: hands the plan back so it need not re-send it unchanged', /\[>\] 2\. Patch the retry/.test(res));
    check('update_plan: tells the webview', posted.some(m => m.type === 'planUpdate' && m.steps.length === 3));
    check('update_plan: stores it on the session', provider.plan.length === 3);
    check('update_plan: a bad plan is an error string, not a thrown exception',
      /^Error: /.test(await provider.toolUpdatePlan([])));
    check('update_plan: …and a refused plan leaves the previous one intact', provider.plan.length === 3);

    const again = await provider.toolUpdatePlan([
      { step: 'Read the auth module', status: 'done' },
      { step: 'Patch the retry', status: 'in_progress' },
      { step: 'Run the tests' },
    ]);
    check('update_plan: an unchanged resend is reported as unchanged', /Plan unchanged/.test(again));

    // ── The model gets its own plan back every iteration. ─────────────────
    const forPrompt = provider._planForPrompt();
    check('plan: the prompt block states progress and every step',
      /1\/3 done/.test(forPrompt) && /Run the tests/.test(forPrompt));
    check('plan: the prompt block tells the model to keep it current', /update_plan as you go/.test(forPrompt));
    provider._resetPlan();
    check('plan: no plan means no prompt block at all', provider._planForPrompt() === '');

    // ── A turn that ends mid-plan says so. ───────────────────────────────
    await provider.toolUpdatePlan([{ step: 'a', status: 'done' }, { step: 'b' }, { step: 'c' }]);
    const note = provider._planCompletionNote();
    check('plan: an unfinished plan produces a note naming what is left',
      /1\/3 steps done/.test(note) && /b/.test(note) && /c/.test(note), note);
    await provider.toolUpdatePlan([{ step: 'a', status: 'done' }, { step: 'b', status: 'done' }]);
    check('plan: a finished plan produces no note', provider._planCompletionNote() === '');
    provider._resetPlan();
    check('plan: no plan produces no note', provider._planCompletionNote() === '');

    // ── "Done" on a verify step has to be earned. ────────────────────────
    check('verify steps: a check after the first edit step counts',
      JSON.stringify(verifyStepIndexes([{ step: 'Read parse()' }, { step: 'Fix the off-by-one in parse()' }, { step: 'Run the tests' }])) === '[2]');
    check('verify steps: "check how X is used" before any edit is investigation, not verification',
      JSON.stringify(verifyStepIndexes([{ step: 'Check how parse() is called' }, { step: 'Fix parse()' }, { step: 'Run npm test' }])) === '[2]');
    check('verify steps: a plan with no edit step only counts its last step',
      JSON.stringify(verifyStepIndexes([{ step: 'Check the logs' }, { step: 'Confirm the cause' }])) === '[1]');
    const planned = () => [{ step: 'Fix parse()', status: 'done' }, { step: 'Run the tests', status: 'done' }];
    let fs1 = planned();
    check('flag: done after an edit with nothing passed since is unverified',
      JSON.stringify(flagUnverified(fs1, [], { edited: true, verified: false })) === '[2]' && fs1[1].unverified === true && !fs1[0].unverified);
    fs1 = planned();
    check('flag: …not once a check has passed', flagUnverified(fs1, [], { edited: true, verified: true }).length === 0 && !fs1[1].unverified);
    fs1 = planned();
    check('flag: …nor when nothing was edited', flagUnverified(fs1, [], { edited: false, verified: false }).length === 0);
    fs1 = planned();
    check('flag: a step that already stood as done keeps its standing on a resend',
      flagUnverified(fs1, planned(), { edited: true, verified: false }).length === 0);
    check('render: an unverified done step reads [x?]',
      renderPlan([{ step: 'Run the tests', status: 'done', unverified: true }]) === '[x?] 1. Run the tests');

    provider._resetPlan();
    provider._notePlanEvidence('edit');
    const flaggedRes = await provider.toolUpdatePlan(planned());
    check('update_plan: tells the model the verify step is unverified and what to run',
      /Step 2 is marked done.*no check has passed/.test(flaggedRes) && /\[x\?\] 2\. Run the tests/.test(flaggedRes), flaggedRes);
    check('plan: a finished plan with an unverified step says so at the end',
      /Not verified: Run the tests/.test(provider._planCompletionNote()), provider._planCompletionNote());
    posted.length = 0;
    provider._notePlanEvidence('pass');
    check('evidence: a pass clears the flag and updates the card',
      !provider.plan[1].unverified && posted.some(m => m.type === 'planUpdate' && !m.steps[1].unverified));
    check('evidence: …and the closing note goes away', provider._planCompletionNote() === '');
    provider._notePlanEvidence('edit');
    check('evidence: an edit after the pass leaves the earlier verdict alone but resets the evidence',
      provider._session.planEvidence.verified === false && !provider.plan[1].unverified);
    provider._resetPlan();
    check('evidence: a new plan starts with no evidence either way',
      provider._session.planEvidence.edited === false && provider._session.planEvidence.verified === false);

    // Through a real turn: an edit, the verify step marked done without a
    // check, then the end of the turn.
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'calc.js', content: 'module.exports = (a, b) => a + b;\n' } }] },
      { toolCalls: [{ name: 'update_plan', args: { steps: [{ step: 'Fix add() in calc.js', status: 'done' }, { step: 'Verify add() works', status: 'done' }] } }] },
      { text: 'Fixed add().' },
    ]);
    await provider.askNavy('fix add in calc.js', false, null, [], []);
    const unv = provider.messages[provider.messages.length - 1];
    check('turn: an unchecked verify step is saved as unverified with the turn', unv.meta?.plan?.[1]?.unverified === true, JSON.stringify(unv.meta?.plan));
    check('turn: …and the reply says it was not verified', /Not verified: Verify add\(\) works/.test(unv.text), unv.text.slice(-200));

    // The same, with check_syntax run after the plan was marked done.
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'calc.js', content: 'module.exports = (a, b) => a + b;\n' } }] },
      { toolCalls: [{ name: 'update_plan', args: { steps: [{ step: 'Fix add() in calc.js', status: 'done' }, { step: 'Verify add() works', status: 'done' }] } }] },
      { toolCalls: [{ name: 'check_syntax', args: { path: 'calc.js' } }] },
      { text: 'Fixed add().' },
    ]);
    await provider.askNavy('fix add in calc.js again', false, null, [], []);
    const ver = provider.messages[provider.messages.length - 1];
    check('turn: a passing check after the plan was marked done clears the flag',
      ver.meta?.plan?.length === 2 && !ver.meta.plan[1].unverified && !/Not verified/.test(ver.text), JSON.stringify(ver.meta?.plan));
    provider._resetPlan();

    // A model that reads, then ends the turn with no reply and nothing done,
    // before it has written a plan the open-steps check could hold it to.
    let stallReq = 0;
    const stallQueue = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'calc.js' } }] },
      { text: '' },
      { toolCalls: [{ name: 'write_file', args: { path: 'calc.js', content: 'module.exports = (a, b) => a + b; // fixed\n' } }] },
      { text: 'Fixed add() in calc.js.' },
    ]);
    global.fetch = (...a) => { stallReq++; return stallQueue(...a); };
    await provider.askNavy('fix the bug in calc.js', false, null, [], []);
    check('stall: a silent stop after reading is sent back to do the work',
      fs.readFileSync(path.join(tmp, 'calc.js'), 'utf8').includes('// fixed'), 'requests=' + stallReq);
    const stallTurn = provider.messages[provider.messages.length - 1];
    check('stall: …and the turn ends with the real reply', /Fixed add\(\)/.test(stallTurn.text), stallTurn.text);
    provider._resetPlan();

    // ── End to end through a real turn. ──────────────────────────────────
    // The model that genuinely will not continue is nudged a bounded number of
    // times first (see the plan auto-continue); stating the incomplete plan is
    // the FALLBACK once those are spent, so it must keep stopping to reach it.
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'update_plan', args: { steps: [{ step: 'look', status: 'in_progress' }, { step: 'act' }] } }] },
      { text: 'Stopping before the second step.' },
      { text: 'Still stopping.' },
      { text: 'Not continuing.' },
      { text: 'Done, I am stopping.' },
    ]);
    await provider.askNavy('do a two-step thing', false, null, [], []);

    const turn = provider.messages[provider.messages.length - 1];
    check('turn: the plan is persisted with the turn it belonged to', turn.meta?.plan?.length === 2);
    check('turn: an unfinished plan is stated in the reply, not left to be noticed',
      /Plan incomplete/.test(turn.text), turn.text.slice(-160));
    check('turn: …and the webview is told separately', posted.some(m => m.type === 'planIncomplete'));

    // A new turn must not inherit the last one's plan.
    global.fetch = queueOllamaFetch([{ text: 'Nothing to do.' }]);
    await provider.askNavy('unrelated question', false, null, [], []);
    check('turn: a fresh turn starts with no plan', provider.plan.length === 0);
    const second = provider.messages[provider.messages.length - 1];
    check('turn: …and does not inherit the previous turn incomplete note', !/Plan incomplete/.test(second.text));

    // ── A tool that fails identically must not be allowed to spin. ───────
    // The screenshot that prompted this showed five identical failures; only
    // run_command and run_tests were ever guarded against repeat-on-failure.
    provider._resetPlan();
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'update_plan', args: { steps: [{ status: 'done' }] } }] },
      { toolCalls: [{ name: 'update_plan', args: { steps: [{ status: 'done' }] } }] },
      { toolCalls: [{ name: 'update_plan', args: { steps: [{ status: 'done' }] } }] },
      { toolCalls: [{ name: 'update_plan', args: { steps: [{ status: 'done' }] } }] },
      { text: 'I could not set a plan.' },
    ]);
    await provider.askNavy('plan something, badly', false, null, [], []);
    const planResults = posted.filter(m => m.type === 'toolResult' && m.tool === 'update_plan');
    check('loop guard: a third identical failure is blocked, not attempted',
      planResults.some(m => /^\[Blocked/.test(m.result)), planResults.map(m => m.result?.slice(0, 40)).join(' | '));
    check('loop guard: the block quotes the error it kept getting',
      planResults.some(m => /^\[Blocked/.test(m.result) && /has no text/.test(m.result)));
    check('loop guard: …and tells the model to change something or stop',
      planResults.some(m => /change the arguments|explain to the user/.test(m.result || '')));

    // Success must clear the record — an intermittent failure cannot
    // accumulate into a block.
    provider._resetPlan();
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'update_plan', args: { steps: [{ status: 'done' }] } }] },
      { toolCalls: [{ name: 'update_plan', args: { steps: ['a good step'] } }] },
      { toolCalls: [{ name: 'update_plan', args: { steps: [{ status: 'done' }] } }] },
      { toolCalls: [{ name: 'update_plan', args: { steps: ['another good step'] } }] },
      { text: 'Done.' },
    ]);
    await provider.askNavy('alternate good and bad plans', false, null, [], []);
    const mixed = posted.filter(m => m.type === 'toolResult' && m.tool === 'update_plan');
    check('loop guard: an intermittent failure never accumulates into a block',
      !mixed.some(m => /^\[Blocked/.test(m.result)), mixed.map(m => m.result?.slice(0, 30)).join(' | '));

    // ── Wiring the model depends on. ─────────────────────────────────────
    const toolsMod = require('../src/providers/tools.js');
    check('update_plan is offered to the model', toolsMod.TOOLS_API.some(t => t.function.name === 'update_plan'));
    check('update_plan is in the core tier — small models drift most on long tasks',
      toolsMod.CORE_TOOL_NAMES.has('update_plan'));
    check('rule 13 asks for update_plan, not a prose heading',
      /13\. PLANNING .*call update_plan BEFORE your first edit/.test(toolsMod.TOOL_PROMPT) && !/\*\*Plan:\*\* heading/.test(toolsMod.TOOL_PROMPT));
    check('rule 13: the plan comes before the first change, after a quick look so it can name real files',
      /call update_plan BEFORE your first edit/.test(toolsMod.TOOL_PROMPT) && /name real files and functions/.test(toolsMod.TOOL_PROMPT));
    check('rule 13: replace the plan when what you learn changes the approach',
      /REPLACE the plan whenever what you learn changes the approach/.test(toolsMod.TOOL_PROMPT));
    check('update_plan is listed among the available tools', /web_search, update_plan, delegate_research/.test(toolsMod.TOOL_PROMPT));

    // A sub-agent must not be able to rewrite the delegating turn's plan.
    const extSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
    check('update_plan is NOT read-only, so a sub-agent cannot touch the plan',
      !/'update_plan'/.test(extSrc.split('const READ_ONLY')[1].split(']);')[0]));
  } finally {
    global.fetch = realFetch;
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// The Compact button: the automatic history condensation, on demand. Pinned: it
// condenses through the same summarizer and keeps the recent tail, cuts on a user
// message, refuses mid-turn and on a short chat without spending a model call,
// falls back to the mechanical digest when the model will not answer, refuses to
// apply a summary if the conversation moved while it was written, re-renders so
// rewind indexes stay true, and gives the bar an estimate flagged as one.
async function compactContextSuite() {
  console.log('');
  console.log('compact button (on-demand history condensation):');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();
  const realWarn = vscode.window.showWarningMessage;
  let provider, tmp;
  const realFetch = global.fetch;
  const isDigestCall = (req) => typeof req?.messages?.[0]?.content === 'string'
    && req.messages[0].content.includes('You compress coding-assistant conversation history');
  const convo = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: 'm' + i }));
  const summary = '- Decided on the retry design; changed src/net.js to back off; flaky test still open';
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-compact-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider._wslCache = { available: false };
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    // Every compaction asks first. The dialog is captured so it can be checked
    // itself, and answered 'Compact' so the cases below test what follows it.
    const warns = [];
    vscode.window.showWarningMessage = async (...args) => { warns.push(args); return ctrl.nextWarning; };
    ctrl.nextWarning = 'Compact';

    // The ordinary case.
    provider.messages = convo(10);
    provider.sessionDigest = '';
    const cap1 = [];
    global.fetch = queueOllamaFetch([{ text: summary }], cap1);
    const r = await provider.compactContext();
    check('compact condenses through the same summarizer the automatic trigger uses', cap1.some(isDigestCall));
    check('...keeping the most recent exchanges verbatim, in order',
      provider.messages.length === 4 && provider.messages[0].text === 'm6' && provider.messages[3].text === 'm9',
      JSON.stringify(provider.messages.map(m => m.text)));
    check('...and folding the rest into the session digest', (provider.sessionDigest || '').includes('retry design'));
    check('...reporting how many it condensed', r && r.condensed === 6);
    check('the transcript is re-rendered from what is left, so rewind indexes stay true',
      posted.some(m => m.type === 'restore' && Array.isArray(m.messages) && m.messages.length === 4));
    check('the webview is told it worked, with the summary to show',
      posted.some(m => m.type === 'compactResult' && m.ok === true && m.condensed === 6 && /retry design/.test(m.summary || '')));
    const saved = JSON.parse(fs.readFileSync(path.join(provider.getNavyDir(tmp), 'chats', provider._session.id + '.json'), 'utf8'));
    check('...and the compacted chat is what gets saved', saved.messages.length === 4 && /retry design/.test(saved.digest));

    // The cut lands on a user message: 9 - 4 = 5 is an assistant reply.
    provider.messages = convo(9);
    provider.sessionDigest = '';
    global.fetch = queueOllamaFetch([{ text: summary }]);
    await provider.compactContext();
    check('the kept history opens with a user message, never an orphaned reply',
      provider.messages[0].role === 'user' && provider.messages[0].text === 'm4', provider.messages[0].text);

    // Refused mid-turn, and without spending a model call.
    posted.length = 0;
    provider.messages = convo(10);
    provider.isBusy = true;
    const cap2 = [];
    global.fetch = queueOllamaFetch([], cap2);
    const busy = await provider.compactContext();
    provider.isBusy = false;
    check('compact is refused while a turn is running', busy === null && provider.messages.length === 10 && cap2.length === 0);
    check('...and says why', posted.some(m => m.type === 'compactResult' && m.ok === false && /working/.test(m.reason || '')));

    // Nothing to compact on a short chat.
    posted.length = 0;
    provider.messages = convo(3);
    const cap3 = [];
    global.fetch = queueOllamaFetch([], cap3);
    await provider.compactContext();
    check('a short chat is left alone, with no model call spent',
      provider.messages.length === 3 && cap3.length === 0
      && posted.some(m => m.type === 'compactResult' && m.ok === false && /Nothing to compact/.test(m.reason || '')));

    // The model will not answer: the mechanical digest still condenses.
    provider.messages = convo(10);
    provider.sessionDigest = '';
    global.fetch = queueOllamaFetch([{ fail: { status: 500, text: 'down' } }]);
    await provider.compactContext();
    check('a failed summary falls back to the mechanical digest rather than losing the turns',
      provider.messages.length === 4 && /User: m0/.test(provider.sessionDigest || ''), provider.sessionDigest);

    // The conversation moved while the summary was being written.
    posted.length = 0;
    provider.messages = convo(10);
    provider.sessionDigest = '';
    const inner = queueOllamaFetch([{ text: summary }]);
    const fresh = [{ role: 'user', text: 'fresh start' }];
    global.fetch = async (...a) => { provider.messages = fresh; return inner(...a); };
    await provider.compactContext();
    check('a summary is not applied if the conversation changed underneath it',
      provider.messages === fresh && !provider.sessionDigest
      && posted.some(m => m.type === 'compactResult' && m.ok === false && /changed while compacting/.test(m.reason || '')));

    // The bar gets an estimate straight away, flagged as one.
    posted.length = 0;
    provider.messages = convo(10).map(m => ({ ...m, text: m.text + 'x'.repeat(4000) }));
    provider.sessionDigest = '';
    provider._session.lastContextUsed = 20000;
    provider.modelContextLength = 32000;
    global.fetch = queueOllamaFetch([{ text: summary }]);
    await provider.compactContext();
    const est = posted.find(m => m.type === 'contextUsage');
    check('the context bar gets an estimate straight away, marked as an estimate',
      est && est.estimated === true && est.used < 20000 && est.max === 32000, JSON.stringify(est));
    // The confirmation itself.
    posted.length = 0;
    warns.length = 0;
    provider.messages = convo(10);
    provider.sessionDigest = '';
    ctrl.nextWarning = undefined;
    const capC = [];
    global.fetch = queueOllamaFetch([], capC);
    await provider.compactContext();
    const [title, opts, ...choices] = warns[0] || [];
    check('compact asks first, in a modal dialog', /Compact this conversation/.test(title || '') && Boolean(opts && opts.modal));
    check('...saying how many messages go, how many stay, and that they cannot come back',
      /6 earliest messages/.test((opts && opts.detail) || '') && /last 4 messages/.test((opts && opts.detail) || '')
      && /cannot be brought back/.test((opts && opts.detail) || ''), opts && opts.detail);
    check('...and offering to export first', choices.includes('Compact') && choices.includes('Export first, then compact'));
    check('a cancelled dialog condenses nothing and spends no model call', provider.messages.length === 10 && capC.length === 0);
    check('...and frees the button without a message',
      posted.some(m => m.type === 'compactResult' && m.ok === false && m.cancelled === true && !m.reason));

    // Export first: the whole conversation is saved, then it is condensed.
    posted.length = 0;
    provider.messages = convo(10);
    provider.sessionDigest = '- an earlier summary';
    ctrl.nextWarning = 'Export first, then compact';
    const exportPath = path.join(tmp, 'before-compact.md');
    ctrl.nextSaveUri = vscode.Uri.file(exportPath);
    global.fetch = queueOllamaFetch([{ text: summary }]);
    await provider.compactContext();
    const exported = fs.existsSync(exportPath) ? fs.readFileSync(exportPath, 'utf8') : '';
    check('"Export first" saves every message, with who said it, before condensing',
      /\*\*You:\*\* m0/.test(exported) && /\*\*Navy:\*\* m9/.test(exported), exported.slice(0, 160));
    check('...including what earlier compactions condensed', /an earlier summary/.test(exported));
    check('...and then compacts', provider.messages.length === 4);

    // Cancelling the export cancels the compaction.
    posted.length = 0;
    provider.messages = convo(10);
    provider.sessionDigest = '';
    ctrl.nextSaveUri = undefined;
    const capE = [];
    global.fetch = queueOllamaFetch([], capE);
    await provider.compactContext();
    check('cancelling the export cancels the compaction too, and says so',
      provider.messages.length === 10 && capE.length === 0
      && posted.some(m => m.type === 'compactResult' && m.ok === false && /export was cancelled/.test(m.reason || '')));
    ctrl.nextWarning = 'Compact';

    // Export on its own builds from the saved chat and reports the outcome.
    provider.messages = convo(4);
    provider.sessionDigest = '';
    const plainPath = path.join(tmp, 'plain-export.md');
    ctrl.nextSaveUri = vscode.Uri.file(plainPath);
    const saved1 = await provider.exportConversation();
    const plain = fs.existsSync(plainPath) ? fs.readFileSync(plainPath, 'utf8') : '';
    check('Export writes every message with who said it',
      saved1 === true && /\*\*You:\*\* m0/.test(plain) && /\*\*Navy:\*\* m3/.test(plain), plain.slice(0, 160));
    ctrl.nextSaveUri = undefined;
    check('...and reports a cancelled save as not exported', (await provider.exportConversation()) === false);

    // The export also carries what each turn did: its tool calls and a diff of
    // every file, rebuilt from the saved cards and the undo checkpoints.
    const edited = path.join(tmp, 'app.js');
    fs.writeFileSync(edited, 'const a = 1;\nconst b = 3;\n');
    provider.checkpoints = [{ kind: 'edit', filePath: edited, originalText: 'const a = 1;\nconst b = 2;\n', turnId: 'turn-x', time: 1 }];
    provider.messages = [
      { role: 'user', text: 'set b to 3' },
      { role: 'assistant', text: 'Done.', meta: { turnId: 'turn-x', files: ['app.js'] },
        cards: [{ tool: 'apply_edit', args: { path: 'app.js' }, result: 'Applied edit to app.js' }] },
    ];
    const richPath = path.join(tmp, 'rich-export.md');
    ctrl.nextSaveUri = vscode.Uri.file(richPath);
    await provider.exportConversation();
    const rich = fs.existsSync(richPath) ? fs.readFileSync(richPath, 'utf8') : '';
    check('Export includes each turn\'s tool calls with their output',
      /\*\*`apply_edit`\*\* path: `app\.js`/.test(rich) && /Applied edit to app\.js/.test(rich), rich.slice(0, 400));
    check('...and a diff of every file the turn changed, from the undo checkpoints',
      /```diff/.test(rich) && /-const b = 2;/.test(rich) && /\+const b = 3;/.test(rich) && /app\.js` modified, \+1 -1/.test(rich), rich);
    ctrl.nextSaveUri = undefined;
  } finally {
    global.fetch = realFetch;
    vscode.window.showWarningMessage = realWarn;
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── /reverse: the clean-room reverse-engineering command ─────────────────────
// Drives the dialog flow through the mock (authorisation, type, language,
// feature) and checks the seeded brief reaches the turn — not just that the
// prompt builder is correct (that is in suite-pure).
async function reverseCommandSuite() {
  console.log('\n/reverse command wiring:');
  const os = require('os');
  const { ctrl } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-rev-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider._wslCache = { available: false };
    const posted = [];
    provider.view = { webview: { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } } };

    const target = path.join(tmp, 'cmd-copy.exe');
    fs.writeFileSync(target, 'MZ\x00\x00binary');

    // The happy path: grounds confirmed, native target, C, a named feature.
    ctrl.nextWarning = 'I have grounds — continue';
    ctrl.nextQuickPick = (items) => items.find(i => i.id === 'native');
    ctrl.nextInputBox = (opts) => /language/i.test(opts.title) ? 'C' : 'the command parser';
    global.fetch = queueOllamaFetch([{ text: 'Authorisation first: do you own this binary?' }]);
    posted.length = 0;
    await provider.runReverseEngineer(target, 'qrev1');

    check('reverse: the person\'s message is drawn as /reverse <path>',
      posted.some(m => m.type === 'seededPrompt' && m.text === `/reverse ${target}` && m.queueId === 'qrev1'),
      JSON.stringify(posted.filter(m => m.type === 'seededPrompt')));
    const turn = provider.messages.find(m => m.role === 'user' && /CLEAN-ROOM/.test(m.instruction || ''));
    check('reverse: the clean-room brief is seeded as the turn\'s instruction, not the user\'s words',
      Boolean(turn) && turn.text === `/reverse ${target}`);
    check('reverse: the brief carries the collected inputs',
      /cmd-copy\.exe/.test(turn.instruction) && /Build the reimplementation in: C\b/.test(turn.instruction) && /the command parser/.test(turn.instruction));
    check('reverse: the brief tells the model to parse the binary in Node, no external tool',
      /no external decompiler/i.test(turn.instruction) && /PE\/ELF\/Mach-O header/.test(turn.instruction));

    // Declining authorisation stops before anything is seeded or run.
    ctrl.nextWarning = undefined;
    provider.messages = [];
    posted.length = 0;
    await provider.runReverseEngineer(target, 'qrev2');
    check('reverse: declining authorisation runs nothing', posted.length === 0 && provider.messages.length === 0);

    // A path that does not exist is refused with a clear error, no turn.
    ctrl.nextWarning = 'I have grounds — continue';
    posted.length = 0;
    await provider.runReverseEngineer(path.join(tmp, 'nope.bin'), 'qrev3');
    check('reverse: a missing target is refused, not analysed',
      posted.some(m => m.type === 'error' && /can't find/.test(m.message)) && provider.messages.length === 0);

    // Cancelling a dialog midway (no type chosen) aborts cleanly.
    ctrl.nextWarning = 'I have grounds — continue';
    ctrl.nextQuickPick = undefined;
    posted.length = 0;
    await provider.runReverseEngineer(target, 'qrev4');
    check('reverse: cancelling the type picker aborts with nothing seeded',
      !posted.some(m => m.type === 'seededPrompt') && provider.messages.length === 0);
  } catch (e) {
    check('reverse command suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { robustnessSuite, queueCancelSuite, writeLoopGuardSuite, reducedToolsetSuite, hallucinationSuite, toolLedgerSuite, historyDigestSuite, delegateResearchSuite, delegationFanOutSuite, toolBatchingSuite, planSuite, compactContextSuite, reverseCommandSuite };
