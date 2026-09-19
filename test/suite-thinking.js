const { check, sharedMock, makeOneShotBody, makeAnthropicSuccessBody, makeGeminiBody, makeContext, fs, path } = require('./harness.js');
const T = require('../src/thinking.js');

// Navy's five thinking levels - fast, medium, high, and the deeper xhigh and
// max newer models have - and what each provider is actually sent for them,
// including a model that turns a level down.

function openAiBody(text = 'ok') {
  const buf = new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\ndata: [DONE]\n\n`);
  let sent = false;
  return { getReader: () => ({ async read() { if (sent) return { done: true }; sent = true; return { done: false, value: buf }; } }) };
}

function fakeProvider(level) {
  const posted = [];
  return {
    abortController: new AbortController(),
    context: { secrets: { get: async () => 'test-key' } },
    thinkingLevel: level, mcp: null, log: () => {},
    view: { webview: { postMessage: (m) => { posted.push(m); } } },
    posted,
  };
}

const err400 = (message) => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message } }) });

async function thinkingLevelsSuite() {
  console.log('\nthinking levels (fast, medium, high, extra high, max):');

  // ── The levels ─────────────────────────────────────────────────────────────
  check('levels: five, in order', JSON.stringify(T.THINKING_LEVELS) === '["fast","medium","high","xhigh","max"]');
  check('levels: anything else reads as medium', T.normalizeThinkingLevel('ultra') === 'medium' && T.normalizeThinkingLevel('max') === 'max');
  check('levels: a refused deep level steps down max, xhigh, high - and no lower',
    T.stepDown('max') === 'xhigh' && T.stepDown('xhigh') === 'high' && T.stepDown('high') === null && T.stepDown('fast') === null);
  check('levels: Claude\'s effort and OpenAI\'s reasoning_effort are the same words, with fast as low',
    T.effortFor('fast') === 'low' && T.effortFor('xhigh') === 'xhigh' && T.effortFor('max') === 'max');
  check('levels: o-series and GPT-5 are reasoning models, a GPT-5 chat model and GPT-4o are not',
    T.isOpenAiReasoningModel('o3') && T.isOpenAiReasoningModel('gpt-5.5') && !T.isOpenAiReasoningModel('gpt-5-chat-latest') && !T.isOpenAiReasoningModel('gpt-4o'));

  const oss = T.ollamaThink('gpt-oss:20b', 'max');
  check('ollama: gpt-oss is sent a level - it ignores on/off - and high is its deepest',
    oss.think === 'high' && oss.used === 'high' && T.ollamaThink('gpt-oss:20b', 'fast').think === 'low');
  check('ollama: other thinking models are switched on or off',
    T.ollamaThink('qwen3:8b', 'xhigh').think === true && T.ollamaThink('qwen3:8b', 'fast').think === false
    && T.ollamaThink('qwen3:8b', 'medium').think === undefined);
  check('ollama: a model that doesn\'t think is sent nothing', T.ollamaThink('llama3.1:8b', 'max').think === undefined);

  const g3 = T.geminiThinking('gemini-3-pro-preview', 'max');
  check('gemini 3: a thinking level, whose deepest is high, with room for the answer',
    g3.thinkingConfig.thinkingLevel === 'high' && !('thinkingBudget' in g3.thinkingConfig) && g3.used === 'high' && g3.maxOutputTokens === 32768);
  const g25 = T.geminiThinking('gemini-2.5-pro', 'max');
  check('gemini 2.5: a budget that grows with the level, and a cap that grows with it',
    g25.thinkingConfig.thinkingBudget === 24576 && g25.maxOutputTokens === 8192 + 24576
    && T.geminiThinking('gemini-2.5-pro', 'xhigh').thinkingConfig.thinkingBudget === 16384
    && T.geminiThinking('gemini-2.5-pro', 'medium').thinkingConfig === null);

  const p0 = fakeProvider('max');
  T.rememberCeiling(p0, 'anthropic', 'claude-x', 'high');
  check('ceiling: a level a model refused is not asked for again this session',
    T.effectiveLevel(p0, 'anthropic', 'claude-x', 'max') === 'high' && T.effectiveLevel(p0, 'anthropic', 'claude-x', 'medium') === 'medium'
    && T.effectiveLevel(p0, 'openai', 'claude-x', 'max') === 'max');
  T.noteThinkingLimit(p0, 'claude-x', 'max', 'high');
  T.noteThinkingLimit(p0, 'claude-x', 'max', 'high');
  check('notice: said once, in the chat', p0.posted.filter(m => m.type === 'systemNotice').length === 1
    && /claude-x doesn't offer Max thinking, so Navy used High/.test(p0.posted[0].text));

  // ── What each provider is sent ─────────────────────────────────────────────
  const { vscode } = sharedMock();
  const { streamAssistant } = require('../src/providers/llm.js');
  const realFetch = global.fetch;
  const run = (p, model) => streamAssistant(p, 'http://x', model, [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {});
  try {
    // Anthropic: a 4.7+ model at Extra high.
    await vscode.workspace.getConfiguration().update('provider', 'anthropic');
    let calls = [];
    let p = fakeProvider('xhigh');
    global.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) return err400('"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.');
      return { ok: true, status: 200, body: makeAnthropicSuccessBody(), text: async () => '' };
    };
    await run(p, 'claude-opus-4-8');
    check('anthropic: Extra high asks a legacy model for a bigger thinking budget, with room above it',
      calls[0].thinking?.budget_tokens === 12000 && calls[0].max_tokens === 32000, JSON.stringify(calls[0].thinking) + ' ' + calls[0].max_tokens);
    check('anthropic: ...and an adaptive model for effort xhigh, with a 64k output cap',
      calls[1].thinking?.type === 'adaptive' && calls[1].output_config?.effort === 'xhigh' && calls[1].max_tokens === 64000, JSON.stringify(calls[1].output_config));
    calls = [];
    global.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, body: makeAnthropicSuccessBody(), text: async () => '' }; };
    await run(p, 'claude-opus-4-8');
    check('anthropic: the next request goes straight to the adaptive shape - no refused legacy request first',
      calls.length === 1 && calls[0].thinking?.type === 'adaptive');

    // Anthropic: Opus 4.6 has max but no xhigh.
    calls = [];
    p = fakeProvider('xhigh');
    global.fetch = async (url, init) => {
      const b = JSON.parse(init.body);
      calls.push(b);
      if (b.thinking?.type === 'enabled') return err400('"thinking.type.enabled" is deprecated for this model. Use "thinking.type.adaptive" and "output_config.effort".');
      if (b.output_config?.effort === 'xhigh') return err400("output_config.effort: 'xhigh' is not supported for this model");
      return { ok: true, status: 200, body: makeAnthropicSuccessBody(), text: async () => '' };
    };
    const r = await run(p, 'claude-opus-4-6');
    check('anthropic: a level the model refuses is asked again one step lower, and the turn succeeds',
      r.text === 'ok' && calls.map(c => c.output_config?.effort || 'legacy').join(',') === 'legacy,xhigh,high', calls.map(c => c.output_config?.effort || 'legacy').join(','));
    check('anthropic: ...and the chat is told which level was used',
      p.posted.some(m => m.type === 'systemNotice' && /claude-opus-4-6 doesn't offer Extra high thinking, so Navy used High/.test(m.text)));
    calls = [];
    await run(p, 'claude-opus-4-6');
    check('anthropic: ...once - the next request starts at the level that worked', calls.length === 1 && calls[0].output_config?.effort === 'high');

    // Anthropic: max on a model with neither max nor xhigh.
    calls = [];
    p = fakeProvider('max');
    p._anthropicAdaptiveModels = new Set(['claude-opus-4-5']);
    global.fetch = async (url, init) => {
      const b = JSON.parse(init.body);
      calls.push(b);
      if (['max', 'xhigh'].includes(b.output_config?.effort)) return err400(`output_config.effort: '${b.output_config.effort}' is not supported for this model`);
      return { ok: true, status: 200, body: makeAnthropicSuccessBody(), text: async () => '' };
    };
    await run(p, 'claude-opus-4-5');
    check('anthropic: Max steps down through Extra high to High', calls.map(c => c.output_config?.effort).join(',') === 'max,xhigh,high');

    // Anthropic-compatible backend that won't take the larger output cap.
    calls = [];
    p = fakeProvider('max');
    p._anthropicAdaptiveModels = new Set(['glm-4.6']);
    global.fetch = async (url, init) => {
      const b = JSON.parse(init.body);
      calls.push(b);
      if (b.max_tokens > 16384) return err400('max_tokens: 64000 > 32768, which is the maximum allowed for this model');
      return { ok: true, status: 200, body: makeAnthropicSuccessBody(), text: async () => '' };
    };
    const capped = await run(p, 'glm-4.6');
    check('anthropic: a backend that refuses the larger output cap is asked again with the usual one',
      capped.text === 'ok' && calls.length === 2 && calls[1].max_tokens === 16384);

    // An unrelated 400 still fails, and is not retried.
    calls = [];
    p = fakeProvider('max');
    global.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return err400('invalid model specified'); };
    let threw = false;
    try { await run(p, 'claude-opus-4-8'); } catch { threw = true; }
    check('anthropic: an unrelated error is not retried', threw && calls.length === 1);

    // OpenAI: GPT-5.5 has xhigh but not max.
    await vscode.workspace.getConfiguration().update('provider', 'openai');
    calls = [];
    p = fakeProvider('max');
    global.fetch = async (url, init) => {
      const b = JSON.parse(init.body);
      calls.push(b);
      if (b.reasoning_effort === 'max') return err400("Unsupported value: 'reasoning_effort' does not support 'max' with this model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.");
      return { ok: true, status: 200, body: openAiBody(), text: async () => '' };
    };
    await run(p, 'gpt-5.5');
    check('openai: a GPT-5 model is sent reasoning_effort, stepping max down to xhigh, and no temperature',
      calls.map(c => c.reasoning_effort).join(',') === 'max,xhigh' && calls.every(c => !('temperature' in c)));
    check('openai: ...and the chat is told', p.posted.some(m => m.type === 'systemNotice' && /gpt-5\.5 doesn't offer Max thinking, so Navy used Extra high/.test(m.text)));
    calls = [];
    await run(p, 'gpt-5.5');
    check('openai: ...and the next request starts at xhigh', calls.length === 1 && calls[0].reasoning_effort === 'xhigh');
    calls = [];
    global.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, body: openAiBody(), text: async () => '' }; };
    await run(fakeProvider('fast'), 'o3');
    await run(fakeProvider('max'), 'gpt-4o');
    check('openai: o3 at Fast is low effort; GPT-4o, not a reasoning model, keeps its temperature',
      calls[0].reasoning_effort === 'low' && calls[1].temperature === 0.2 && !('reasoning_effort' in calls[1]));

    // Gemini: 3 against 2.5.
    await vscode.workspace.getConfiguration().update('provider', 'gemini');
    calls = [];
    global.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, body: makeGeminiBody([{ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }]), text: async () => '' }; };
    p = fakeProvider('max');
    await run(p, 'gemini-3-pro-preview');
    await run(fakeProvider('xhigh'), 'gemini-2.5-pro');
    check('gemini: 3 is sent its deepest thinking level, and the chat told Max became High',
      calls[0].generationConfig.thinkingConfig?.thinkingLevel === 'high' && calls[0].generationConfig.maxOutputTokens === 32768
      && p.posted.some(m => m.type === 'systemNotice' && /doesn't offer Max thinking/.test(m.text)), JSON.stringify(calls[0].generationConfig));
    check('gemini: 2.5 at Extra high gets a 16k budget and the room to answer after it',
      calls[1].generationConfig.thinkingConfig?.thinkingBudget === 16384 && calls[1].generationConfig.maxOutputTokens === 8192 + 16384);

    // Ollama.
    await vscode.workspace.getConfiguration().update('provider', 'ollama');
    calls = [];
    global.fetch = async (url, init) => {
      if (String(url).includes('/api/chat')) calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, body: makeOneShotBody({ message: { role: 'assistant', content: 'ok' }, done: true }), text: async () => '', json: async () => ({}) };
    };
    await run(fakeProvider('xhigh'), 'gpt-oss:20b');
    await run(fakeProvider('max'), 'qwen3:8b');
    await run(fakeProvider('high'), 'llama3.1:8b');
    check('ollama: gpt-oss gets "high", qwen3 thinking on, a non-thinking model nothing',
      calls[0].think === 'high' && calls[1].think === true && !('think' in calls[2]), JSON.stringify(calls.map(c => c.think)));
  } catch (e) {
    check('thinking levels suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    await vscode.workspace.getConfiguration().update('provider', 'ollama');
  }

  // ── The setting ───────────────────────────────────────────────────────────
  const os = require('os');
  const { ctrl } = sharedMock();
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-thinking-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    const posted = [];
    provider.view = { webview: { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } } };
    provider.setThinkingLevel('max');
    check('setting: Max can be chosen, and is saved', provider.thinkingLevel === 'max' && ctrl.config.thinkingLevel === 'max');
    provider.setThinkingLevel('ultra');
    check('setting: a level that doesn\'t exist is ignored', provider.thinkingLevel === 'max');
  } finally {
    ctrl.config.thinkingLevel = 'medium';
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { thinkingLevelsSuite };
