const {
  fs, path, check, makeContext, sharedMock, queueOllamaFetch,
  makeAnthropicSuccessBody, makeGeminiBody,
} = require('./harness.js');

// ── 7b3. Cost/spend visibility ────────────────────────────────────────────────
// This is the one feature in Navy that touches the user's actual money, so it
// gets the most direct, precise tests in the suite: pure-function pricing math
// (no mocking needed at all), multi-turn/mixed-provider aggregation exercised
// by writing synthetic meta directly onto provider.messages, and ONE real
// end-to-end turn to prove the wiring (meta captured correctly, message shape
// correct) without needing to mock every provider's wire format.
async function costEstimateSuite() {
  console.log('\ncost/spend visibility:');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider, estimateCost } = require('../src/extension.js');

    // ── Pure pricing math — no provider instance needed ──────────────────
    check('estimateCost: ollama is always free regardless of "model" name', estimateCost('ollama', 'gpt-4o', 1_000_000, 1_000_000) === 0);
    check('estimateCost: lmstudio is always free', estimateCost('lmstudio', 'claude-opus', 1_000_000, 1_000_000) === 0);
    check('estimateCost: an unrecognized hosted model returns null, never a guess', estimateCost('anthropic', 'totally-unknown-future-model', 1000, 1000) === null);
    const claudeCost = estimateCost('anthropic', 'claude-sonnet-5', 1_000_000, 1_000_000);
    check('estimateCost: a known model prices input and output separately', claudeCost === 3 + 15);
    check('estimateCost: scales linearly with token count', estimateCost('anthropic', 'claude-sonnet-5', 500_000, 0) === 1.5);
    check('estimateCost: zero tokens costs zero (not null) for a known model', estimateCost('anthropic', 'claude-sonnet-5', 0, 0) === 0);

    // ── _sessionUsage aggregation — synthetic meta, no network at all ────
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-cost-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    check('_sessionUsage: no turns yet is all zero, cost known (nothing to not-know)',
      JSON.stringify(provider._sessionUsage()) === JSON.stringify({ prompt: 0, completion: 0, cost: 0, costKnown: true }));

    // Turn 1: free (ollama). Turn 2: paid (anthropic). A session spanning a
    // PROVIDER switch must price each turn at what actually ran it — not
    // "whatever's configured right now" (which could misreport a paid turn
    // as free, or vice versa, well after the fact).
    provider.messages = [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'ok', meta: { tokens: { prompt: 1000, completion: 1000 }, provider: 'ollama', model: 'llama3' } },
      { role: 'user', text: 'hi again' },
      { role: 'assistant', text: 'ok again', meta: { tokens: { prompt: 1_000_000, completion: 1_000_000 }, provider: 'anthropic', model: 'claude-sonnet-5' } },
    ];
    const usage = provider._sessionUsage();
    check('_sessionUsage: sums prompt/completion tokens across every turn', usage.prompt === 1_001_000 && usage.completion === 1_001_000);
    check('_sessionUsage: prices each turn by ITS OWN provider/model, not the current config',
      usage.cost === 18 && usage.costKnown === true); // turn 1 (ollama) contributes $0, turn 2 (claude) contributes $18

    // A turn using a model with no known pricing makes the TOTAL explicitly
    // "not fully known" (costKnown: false) rather than silently under-reporting.
    provider.messages.push({ role: 'assistant', text: 'x', meta: { tokens: { prompt: 1000, completion: 1000 }, provider: 'anthropic', model: 'some-brand-new-model' } });
    const usage2 = provider._sessionUsage();
    check('_sessionUsage: costKnown flips false when any priced turn is unrecognized', usage2.costKnown === false);
    check('_sessionUsage: still sums whatever COULD be priced, as a floor', usage2.cost === 18);

    // A turn with no meta.tokens at all (e.g. a pure-chat turn that made no
    // model call, or history from before this feature existed) is silently
    // skipped, not treated as a zero-cost known turn or a crash.
    provider.messages = [{ role: 'assistant', text: 'no meta here' }];
    check('_sessionUsage: a turn with no meta.tokens is skipped cleanly', provider._sessionUsage().prompt === 0);

    // ── End-to-end wiring: a real turn through askNavy ────────────────────
    provider.messages = [];
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    provider._wslCache = { available: false };
    global.fetch = queueOllamaFetch([{ text: 'done' }]); // queueOllamaFetch's mock reports prompt_eval_count/eval_count: 5 each
    await provider.askNavy('hello', false, null, [], []);

    check('turn wiring: meta.tokens captured on the persisted assistant message', provider.messages[1]?.meta?.tokens?.prompt === 5 && provider.messages[1]?.meta?.tokens?.completion === 5);
    check('turn wiring: meta.provider/meta.model captured (ollama — the shared mock default)', provider.messages[1]?.meta?.provider === 'ollama' && Boolean(provider.messages[1]?.meta?.model));
    const tc = posted.find(m => m.type === 'tokenCount');
    check('turn wiring: tokenCount carries a running session total, not just this turn\'s figures',
      Boolean(tc) && tc.sessionTotal === 10 && tc.sessionPrompt === 5 && tc.sessionCompletion === 5);
    check('turn wiring: ollama turns price at exactly $0, known (not "unavailable")', tc.estimatedCost === 0 && tc.costKnown === true);

    // A second turn must ACCUMULATE, not replace, the running total.
    posted.length = 0;
    global.fetch = queueOllamaFetch([{ text: 'done again' }]);
    await provider.askNavy('hello again', false, null, [], []);
    const tc2 = posted.find(m => m.type === 'tokenCount');
    check('turn wiring: a second turn ACCUMULATES onto the session total (10 + 10 = 20)', tc2?.sessionTotal === 20);

    // Restoring/switching a chat must reflect ITS accumulated usage right
    // away — not require sending another message first.
    posted.length = 0;
    await provider.loadProjectSession();
    const sl = posted.find(m => m.type === 'sessionLoaded');
    check('sessionLoaded: carries the same accumulated session usage as tokenCount', sl?.sessionTotal === 20);

    // A brand-new tab starts at a clean, KNOWN zero — not "unavailable".
    posted.length = 0;
    await provider.openNewSessionTab();
    const slNew = posted.find(m => m.type === 'sessionLoaded');
    check('openNewSessionTab: a fresh chat reports zero usage, not missing/unavailable',
      slNew?.sessionTotal === 0 && slNew?.estimatedCost === null && slNew?.costKnown === true);
  } catch (e) {
    check('cost estimate suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    if (provider) { for (const s of provider.sessions.values()) { clearTimeout(s._cpSaveTimer); clearInterval(s._heartbeat); clearTimeout(s._watchdog); } }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 7b5. Cross-provider failover (navy.providerFallbacks) ────────────────────
// The one feature here that can spend money on a DIFFERENT account than the
// one you're looking at — tested accordingly: the opt-in gate (empty by
// default), the transient-vs-not classification (never falls back for auth/
// quota/context-length, only rate-limit/server-outage/network), ordering,
// malformed-entry safety, and that meta/cost attribution follows whichever
// provider ACTUALLY served the turn, not whatever's configured as primary.
//
// A genuinely transient failure also engages streamAssistant's own
// fetchWithRetry (3 attempts, real ~3s of backoff) before _streamWithFallback
// ever sees it — that's real, correct behavior, not something to mock around,
// so a few of these tests are deliberately slower than the rest of the suite.
async function providerFallbackSuite() {
  console.log('\ncross-provider failover (navy.providerFallbacks):');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();
  const { isTransientProviderError } = require('../src/providers/errors.js');
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    // ── Pure classification — no network at all ──────────────────────────
    check('isTransientProviderError: rate limit (429) is transient', isTransientProviderError('429 Too Many Requests'));
    check('isTransientProviderError: server outage (503) is transient', isTransientProviderError('503 Service Unavailable'));
    check('isTransientProviderError: network failure is transient', isTransientProviderError('fetch failed: ECONNREFUSED'));
    check('isTransientProviderError: an auth error is NOT transient (a different account needs its OWN valid key, not a retry)',
      !isTransientProviderError('401 Incorrect API key provided'));
    check('isTransientProviderError: a quota/billing error is NOT transient', !isTransientProviderError('RESOURCE_EXHAUSTED: exceeded your current quota'));
    check('isTransientProviderError: context-length is NOT transient', !isTransientProviderError("This model's maximum context length is 8192 tokens"));
    check('isTransientProviderError: an unclassified error is NOT transient (never guess it\'s safe to retry elsewhere)', !isTransientProviderError('something bizarre happened'));

    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-failover-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider._wslCache = { available: false };
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    provider.abortController = new AbortController();
    await vscode.workspace.getConfiguration().update('provider', 'ollama');
    await vscode.workspace.getConfiguration().update('providerFallbacks', []);

    // ── Opt-in gate: nothing configured → behaves exactly like a plain call ──
    global.fetch = queueOllamaFetch([{ text: 'straight through, no fallback configured' }]);
    const plain = await provider._streamWithFallback('http://localhost:11434', 'llama3', [{ role: 'user', content: 'hi' }], 0.2);
    check('no fallbacks configured: a successful primary call passes through untouched',
      plain.text === 'straight through, no fallback configured' && plain.usedProvider === 'ollama' && plain.usedModel === 'llama3');

    // ── A non-transient primary failure NEVER engages fallback, even when
    // fallbacks ARE configured — fast (401 isn't in fetchWithRetry's
    // retryable set, so no internal backoff delay). Only 1 response queued:
    // if fallback were (wrongly) attempted, the queue would throw "exhausted".
    await vscode.workspace.getConfiguration().update('providerFallbacks', [{ provider: 'ollama', model: 'backup-model' }]);
    global.fetch = queueOllamaFetch([{ fail: { status: 401, text: 'Incorrect API key' } }]);
    let authErr = null;
    try { await provider._streamWithFallback('http://localhost:11434', 'llama3', [{ role: 'user', content: 'hi' }], 0.2); }
    catch (e) { authErr = e; }
    check('a non-transient (auth) primary failure propagates directly, never tries a configured fallback',
      authErr && /401/.test(authErr.message));

    // ── No fallbacks configured → even a genuinely transient failure just
    // propagates normally (the feature is a true no-op when unconfigured).
    // Needs 3 queued failures to exhaust streamAssistant's own internal retry.
    await vscode.workspace.getConfiguration().update('providerFallbacks', []);
    global.fetch = queueOllamaFetch([
      { fail: { status: 429, text: 'rate limited' } },
      { fail: { status: 429, text: 'rate limited' } },
      { fail: { status: 429, text: 'rate limited' } },
    ]);
    let noFallbackErr = null;
    try { await provider._streamWithFallback('http://localhost:11434', 'llama3', [{ role: 'user', content: 'hi' }], 0.2); }
    catch (e) { noFallbackErr = e; }
    check('a transient failure with NO fallbacks configured propagates normally (opt-in, not automatic)',
      noFallbackErr && /429/.test(noFallbackErr.message));

    // ── The main mechanism: primary fails transiently → a malformed entry is
    // skipped (no network attempt) → the next fallback fails (fast, 401) →
    // the one after THAT succeeds. Proves gating, skip-malformed, ordering,
    // and success all in one real transient-failure setup.
    await vscode.workspace.getConfiguration().update('providerFallbacks', [
      { provider: 'ollama' }, // malformed — missing "model", must be skipped without a fetch
      { provider: 'ollama', model: 'backup-1' },
      { provider: 'ollama', model: 'backup-2', host: 'http://backup-host:11434' },
    ]);
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { fail: { status: 503, text: 'overloaded' } },
      { fail: { status: 503, text: 'overloaded' } },
      { fail: { status: 503, text: 'overloaded' } }, // exhausts the PRIMARY's internal retries
      { fail: { status: 401, text: 'bad key' } },     // backup-1 fails (fast, non-retryable)
      { text: 'backup-2 came through' },              // backup-2 succeeds
    ]);
    const result = await provider._streamWithFallback('http://localhost:11434', 'primary-model', [{ role: 'user', content: 'hi' }], 0.2);
    check('mechanism: the malformed fallback entry is silently skipped, not attempted', result.text === 'backup-2 came through');
    check('mechanism: falls through to the NEXT fallback when one fails', result.usedModel === 'backup-2');
    check('mechanism: usedProvider/usedModel reflect the fallback that actually served it, not the primary', result.usedProvider === 'ollama' && result.usedModel === 'backup-2');
    const announcements = posted.filter(m => m.type === 'chunk' && /trying fallback|Fallback succeeded/.test(m.text || ''));
    check('mechanism: the primary\'s failure and each REAL fallback attempt are announced in the chat (never silent)',
      announcements.some(m => /backup-1/.test(m.text)) && announcements.some(m => /backup-2/.test(m.text)) && announcements.some(m => /Fallback succeeded/.test(m.text)));
    check('mechanism: the skipped malformed entry gets no announcement of its own',
      !announcements.some(m => m.text.includes('undefined')));

    // ── All configured fallbacks fail → throws the LAST fallback's error
    // (not the primary's) — so the user sees what actually went wrong most
    // recently, not a stale first-failure message.
    await vscode.workspace.getConfiguration().update('providerFallbacks', [
      { provider: 'ollama', model: 'backup-1' },
      { provider: 'ollama', model: 'backup-2' },
    ]);
    global.fetch = queueOllamaFetch([
      { fail: { status: 429, text: 'primary rate limited' } },
      { fail: { status: 429, text: 'primary rate limited' } },
      { fail: { status: 429, text: 'primary rate limited' } }, // exhausts primary
      { fail: { status: 401, text: 'backup-1 bad key' } },
      { fail: { status: 401, text: 'backup-2 bad key' } },
    ]);
    let allFailedErr = null;
    try { await provider._streamWithFallback('http://localhost:11434', 'primary-model', [{ role: 'user', content: 'hi' }], 0.2); }
    catch (e) { allFailedErr = e; }
    check('all fallbacks exhausted: throws the LAST fallback\'s error, not the primary\'s stale one',
      allFailedErr && /backup-2 bad key/.test(allFailedErr.message));

    // ── Full end-to-end integration: meta.provider/meta.model and cost
    // attribution must follow the FALLBACK that actually ran, not the
    // primary that failed — this is separate wiring in _askNavyTurn from
    // _streamWithFallback itself, so it needs its own real test.
    await vscode.workspace.getConfiguration().update('providerFallbacks', [{ provider: 'ollama', model: 'backup-e2e' }]);
    provider.messages = [];
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { fail: { status: 503, text: 'overloaded' } },
      { fail: { status: 503, text: 'overloaded' } },
      { fail: { status: 503, text: 'overloaded' } },
      { text: 'Handled by the fallback model.' },
    ]);
    await provider.askNavy('hello', false, 'primary-e2e-model', [], []);
    check('e2e: the turn still completes successfully via the fallback',
      (provider.messages[1]?.text || '').includes('Handled by the fallback model.'));
    check('e2e: meta.model records the FALLBACK model that actually ran, not the failed primary',
      provider.messages[1]?.meta?.model === 'backup-e2e');
    // The notice that a DIFFERENT account served this turn is persisted with
    // the reply, not merely streamed — otherwise the record of who got billed
    // disappears on the next window reload.
    check('e2e: the persisted reply records that a fallback ran',
      /Fallback succeeded/.test(provider.messages[1]?.text || ''));
    check('e2e: the persisted reply names the reason the primary failed',
      /trying fallback/.test(provider.messages[1]?.text || ''));
  } catch (e) {
    check('provider fallback suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    await vscode.workspace.getConfiguration().update('providerFallbacks', []);
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function cachingFallbackSuite() {
  console.log('\nAnthropic caching fallback:');
  const { vscode, ctrl } = sharedMock();
  const { streamAssistant } = require('../src/providers/llm.js');
  const realFetch = global.fetch;
  try {
    ctrl.reset();
    await vscode.workspace.getConfiguration().update('provider', 'anthropic');
    const fakeProvider = {
      abortController: new AbortController(),
      context: { secrets: { get: async () => 'test-key' } },
      thinkingLevel: 'medium',
      mcp: null,
      view: undefined,
    };
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) {
        // First attempt (with cache_control) → simulate a proxy that rejects it.
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'cache_control is not supported by this endpoint' } }) };
      }
      return { ok: true, status: 200, body: makeAnthropicSuccessBody(), text: async () => '' };
    };
    const result = await streamAssistant(fakeProvider, 'http://x', 'claude-sonnet-5',
      [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {});
    check('caching fallback: first attempt used cache_control', JSON.stringify(calls[0]).includes('cache_control'));
    check('caching fallback: retry omitted cache_control', calls[1] && !JSON.stringify(calls[1]).includes('cache_control'));
    check('caching fallback: turn still succeeds', result.text === 'ok');

    // Sanity: an UNRELATED 400 must NOT trigger the fallback retry (would mask
    // the real error) — only ONE call should happen, and it should throw.
    calls.length = 0;
    global.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'invalid model specified' } }) };
    };
    let threw = false;
    try { await streamAssistant(fakeProvider, 'http://x', 'claude-sonnet-5', [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {}); }
    catch { threw = true; }
    check('caching fallback: unrelated 400 does not retry', calls.length === 1 && threw);
  } catch (e) {
    check('caching fallback suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    await vscode.workspace.getConfiguration().update('provider', 'ollama');
  }
}

async function adaptiveThinkingFallbackSuite() {
  console.log('\nAnthropic adaptive-thinking/temperature fallback:');
  const { vscode, ctrl } = sharedMock();
  const { streamAssistant } = require('../src/providers/llm.js');
  const realFetch = global.fetch;
  try {
    ctrl.reset();
    await vscode.workspace.getConfiguration().update('provider', 'anthropic');

    // Case 1: non-thinking request (medium level) — model rejects `temperature`
    // outright and wants the adaptive shape instead.
    let calls = [];
    let fakeProvider = { abortController: new AbortController(), context: { secrets: { get: async () => 'test-key' } }, thinkingLevel: 'medium', mcp: null, view: undefined };
    global.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: '`temperature` is deprecated for this model.' } }) };
      }
      return { ok: true, status: 200, body: makeAnthropicSuccessBody(), text: async () => '' };
    };
    let result = await streamAssistant(fakeProvider, 'http://x', 'claude-opus-4-7', [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {});
    check('temperature-deprecated: first attempt sent temperature', 'temperature' in calls[0]);
    check('temperature-deprecated: retry dropped temperature', calls[1] && !('temperature' in calls[1]));
    check('temperature-deprecated: retry used adaptive thinking', calls[1]?.thinking?.type === 'adaptive');
    check('temperature-deprecated: retry set output_config.effort', calls[1]?.output_config?.effort === 'medium');
    check('temperature-deprecated: turn still succeeds', result.text === 'ok');

    // Case 2: high thinking level — model rejects the legacy thinking.type.enabled
    // shape and wants adaptive + output_config.effort.
    calls = [];
    fakeProvider = { abortController: new AbortController(), context: { secrets: { get: async () => 'test-key' } }, thinkingLevel: 'high', mcp: null, view: undefined };
    global.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.' } }) };
      }
      return { ok: true, status: 200, body: makeAnthropicSuccessBody(), text: async () => '' };
    };
    result = await streamAssistant(fakeProvider, 'http://x', 'claude-opus-4-7', [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {});
    check('thinking-shape: first attempt used legacy enabled shape', calls[0]?.thinking?.type === 'enabled');
    check('thinking-shape: retry switched to adaptive', calls[1]?.thinking?.type === 'adaptive');
    check('thinking-shape: retry set output_config.effort high', calls[1]?.output_config?.effort === 'high');
    check('thinking-shape: retry has no temperature', !('temperature' in (calls[1] || {})));
    check('thinking-shape: turn still succeeds', result.text === 'ok');

    // Sanity: unrelated 400 still must not trigger this fallback either.
    calls = [];
    global.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'invalid model specified' } }) };
    };
    let threw = false;
    try { await streamAssistant(fakeProvider, 'http://x', 'claude-opus-4-7', [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {}); }
    catch { threw = true; }
    check('adaptive fallback: unrelated 400 does not retry', calls.length === 1 && threw);
  } catch (e) {
    check('adaptive thinking fallback suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    await vscode.workspace.getConfiguration().update('provider', 'ollama');
  }
}

async function geminiSuite() {
  console.log('\nnative Gemini provider:');
  const { isGeminiThinkingModel, streamAssistant } = require('../src/providers/llm.js');

  // Pure routing predicate
  check('gemini 2.5 routes native', isGeminiThinkingModel('gemini-2.5-pro'));
  check('gemini 3.5 routes native (matches screenshot model)', isGeminiThinkingModel('gemini-3.5-flash'));
  check('gemini 2.0-flash stays on the OpenAI-compat shim', !isGeminiThinkingModel('gemini-2.0-flash'));
  check('gemini 1.5-pro stays on the OpenAI-compat shim', !isGeminiThinkingModel('gemini-1.5-pro'));

  const { vscode, ctrl } = sharedMock();
  const realFetch = global.fetch;
  try {
    await vscode.workspace.getConfiguration().update('provider', 'gemini');
    const fakeProvider = { abortController: new AbortController(), context: { secrets: { get: async () => 'test-key' } }, thinkingLevel: 'high', mcp: null, view: undefined };

    // Routing: a thinking-capable model hits the native streamGenerateContent URL.
    let capturedUrl = '';
    global.fetch = async (url) => { capturedUrl = url; return { ok: true, status: 200, body: makeGeminiBody([{ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }]), text: async () => '' }; };
    await streamAssistant(fakeProvider, 'http://x', 'gemini-2.5-pro', [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {});
    check('routing: thinking model hits native endpoint', capturedUrl.includes(':streamGenerateContent'));

    // Routing: a non-thinking model stays on the OpenAI-compat shim (unaffected by this change).
    capturedUrl = '';
    global.fetch = async (url) => { capturedUrl = url; return { ok: true, status: 200, body: (() => { let s=false; const buf=new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'); return { getReader:()=>({async read(){if(s)return{done:true};s=true;return{done:false,value:buf};}}) };})(), text: async () => '' }; };
    await streamAssistant(fakeProvider, 'http://x', 'gemini-2.0-flash', [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {});
    check('routing: non-thinking model stays on OpenAI-compat shim', capturedUrl.includes('/chat/completions') && !capturedUrl.includes('streamGenerateContent'));

    // Round-trip: model emits a thought part + a functionCall part carrying a
    // thoughtSignature; the RESULTING assistant message (as extension.js would
    // build it) must replay that exact signature verbatim on the next request.
    global.fetch = async () => ({ ok: true, status: 200, body: makeGeminiBody([
      { candidates: [{ content: { parts: [{ thought: true, text: 'thinking...' }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.js' } }, thoughtSignature: 'SIG_ABC123' } ] } }] },
      { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
    ]), text: async () => '' });
    const r1 = await streamAssistant(fakeProvider, 'http://x', 'gemini-2.5-pro', [{ role: 'user', content: 'read a.js' }], 0.2, undefined, () => {});
    check('round-trip: functionCall extracted', r1.nativeToolCalls.length === 1 && r1.nativeToolCalls[0].function.name === 'read_file');
    check('round-trip: thoughtSignature captured in rawBlocks', JSON.stringify(r1.rawBlocks).includes('SIG_ABC123'));
    check('round-trip: thinking text NOT in visible text', !r1.text.includes('thinking...'));

    // Build the assistant message the way extension.js's loop would, then feed
    // it back in and confirm the NEXT outgoing request replays the signature.
    const assistantMsg = { role: 'assistant', content: r1.text || '', tool_calls: r1.nativeToolCalls, _rawBlocks: r1.rawBlocks, _rawBlocksProvider: 'gemini' };
    const toolResultMsg = { role: 'tool', tool_call_id: r1.nativeToolCalls[0].id, content: 'file contents here' };
    let capturedBody = null;
    global.fetch = async (url, init) => { capturedBody = JSON.parse(init.body); return { ok: true, status: 200, body: makeGeminiBody([{ candidates: [{ content: { parts: [{ text: 'done' }] } }] }]), text: async () => '' }; };
    await streamAssistant(fakeProvider, 'http://x', 'gemini-2.5-pro',
      [{ role: 'user', content: 'read a.js' }, assistantMsg, toolResultMsg], 0.2, undefined, () => {});
    check('round-trip: replayed request carries the exact thoughtSignature', JSON.stringify(capturedBody).includes('SIG_ABC123'));
    check('round-trip: tool result converted to functionResponse', JSON.stringify(capturedBody).includes('functionResponse'));

    // Safety gate: rawBlocks tagged for a DIFFERENT provider must never be replayed
    // verbatim — a user switching from Anthropic to Gemini mid-conversation must not
    // leak Anthropic-shaped blocks into a Gemini request (or vice versa elsewhere).
    const foreignMsg = { role: 'assistant', content: 'ok', tool_calls: [{ id: 'x1', function: { name: 'read_file', arguments: '{}' } }], _rawBlocks: [{ type: 'tool_use', id: 'x1', name: 'read_file', input: {} }], _rawBlocksProvider: 'anthropic' };
    capturedBody = null;
    global.fetch = async (url, init) => { capturedBody = JSON.parse(init.body); return { ok: true, status: 200, body: makeGeminiBody([{ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }]), text: async () => '' }; };
    await streamAssistant(fakeProvider, 'http://x', 'gemini-2.5-pro', [{ role: 'user', content: 'hi' }, foreignMsg], 0.2, undefined, () => {});
    check('safety gate: foreign-provider rawBlocks NOT replayed into Gemini request', !JSON.stringify(capturedBody).includes('tool_use'));
  } catch (e) {
    check('gemini suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    await vscode.workspace.getConfiguration().update('provider', 'ollama');
  }
}

// ── 8b16. Provider connection self-test ─────────────────────────────────────
// Every one of these verdicts corresponds to a real failure someone hit and
// could not diagnose from the chat: a base URL that 404s, a key valid in the
// other region, an empty prepaid balance, a provider needing a key it hasn't
// got. The classifier is pure, so all of them are covered without a network.
async function providerSelfTestSuite() {
  console.log('\nprovider self-test:');
  const { NavyCoderViewProvider } = require('../src/extension.js');
  const D = (o) => NavyCoderViewProvider.diagnoseProviderResponse({
    provider: 'minimax', url: 'https://api.minimax.io/v1/models', hasKey: true, ...o,
  });

  const ok = D({ status: 200, models: ['MiniMax-M2.7', 'MiniMax-M3'] });
  check('selftest: a working provider is reported as working', ok.ok === true && ok.kind === 'ok');
  check('selftest: …and names what it found', /MiniMax-M2\.7/.test(ok.detail));

  // z.ai's real failure: the host answers, the path does not exist.
  const four04 = D({ status: 404, body: '<html>404 Not Found</html>' });
  check('selftest: a 404 is called a wrong base URL, not a bad key',
    four04.kind === 'wrong_base' && /base URL/i.test(four04.detail), four04.kind);

  // MiniMax's real failure: right vendor, wrong regional host.
  const auth = D({ status: 401, body: '{"error":{"message":"invalid api key (2049)"}}' });
  check('selftest: a rejected key names the other regional endpoint',
    auth.kind === 'auth' && /api\.minimax\.chat/.test(auth.detail), auth.detail);
  check('selftest: …and explains why it looks like a bad key',
    /rejected by the other|exactly like an invalid key/i.test(auth.detail));

  // A provider with no regional twin must not invent one.
  const groq = NavyCoderViewProvider.diagnoseProviderResponse({
    provider: 'groq', url: 'https://api.groq.com/openai/v1/models', hasKey: true, status: 401, body: '{}',
  });
  check('selftest: a provider with one endpoint gets no regional advice',
    groq.kind === 'auth' && !/mainland/.test(groq.detail));

  check('selftest: no key saved is distinguished from a rejected key',
    D({ hasKey: false, status: 401, body: '{}' }).kind === 'no_key');

  // Both of these mean "your setup is right, your account isn't".
  check('selftest: an empty balance is separated from a connection problem',
    D({ status: 402, body: '{"error":{"message":"insufficient balance (1008)"}}' }).kind === 'balance');
  check('selftest: …including when it arrives on a 200-shaped error body',
    D({ status: 400, body: 'Insufficient balance or no resource package. Please recharge.' }).kind === 'balance');
  check('selftest: a rate limit says the connection is fine',
    /connection is fine/i.test(D({ status: 429, body: '{}' }).detail));

  // A base URL pointing at a marketing site rather than an API root.
  const html = D({ status: 200, models: null });
  check('selftest: a 200 that is not a model list is not called success',
    html.ok === false && html.kind === 'not_an_api');
  check('selftest: an empty model list is not called success',
    D({ status: 200, models: [] }).ok === false);

  // Local Ollama that simply isn't running is the most common local failure.
  const down = NavyCoderViewProvider.diagnoseProviderResponse({
    provider: 'ollama', url: 'http://127.0.0.1:11434/api/tags', hasKey: false,
    networkError: 'connect ECONNREFUSED 127.0.0.1:11434',
  });
  check('selftest: a refused connection is not reported as an auth problem',
    down.kind === 'unreachable');
  check('selftest: …and local Ollama is told to start the server',
    /ollama serve/.test(down.detail), down.detail);
  check('selftest: a bad hostname is called a DNS failure',
    D({ networkError: 'getaddrinfo ENOTFOUND api.nope.invalid' }).kind === 'dns');

  // The self-test must ask the same URL the product asks, or it can pass
  // against an endpoint nothing else uses.
  const os = require('os');
  const { ctrl } = sharedMock();
  const provider = new NavyCoderViewProvider(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'navy-st-'))));
  const built = provider._modelListRequest('zai', '', '', 'k');
  check('selftest: the request is built from the shipped provider defaults',
    built.url === 'https://api.z.ai/api/paas/v4/models', built.url);
  check('selftest: …and carries the key', built.headers.Authorization === 'Bearer k');
  const anthropic = provider._modelListRequest('anthropic', '', '', 'k');
  check('selftest: Anthropic keeps its own auth header shape',
    anthropic.headers['x-api-key'] === 'k' && Boolean(anthropic.headers['anthropic-version']));
  check('selftest: an explicit apiBase is honoured',
    provider._modelListRequest('zai', 'https://open.bigmodel.cn/api/paas/v4', '', 'k').url
      === 'https://open.bigmodel.cn/api/paas/v4/models');
  void ctrl;
}

// ── 8b2. Provider endpoint defaults ─────────────────────────────────────────
// Three separate reports came from the same root cause: a default base URL that
// looks fine and isn't. These are pure-data assertions — they cannot prove a
// URL is live (that needs a real key, which is exactly how each was found), but
// they do pin the shape and the corrections so a regression is loud.
async function providerEndpointSuite() {
  console.log('\nprovider endpoint defaults:');
  const { openAiCompatBase } = require('../src/providers/endpoints.js');
  const { NavyCoderViewProvider } = require('../src/extension.js');
  const base = (p) => openAiCompatBase(p, '', '');

  // z.ai serves no /v1 at all — api.z.ai/v1/models is a bare nginx 404, so the
  // model list came back empty and the key looked wrong. The OpenAI-compatible
  // surface is under /api/paas/v4.
  check('endpoints: z.ai points at the PaaS v4 path, not /v1',
    base('zai') === 'https://api.z.ai/api/paas/v4', base('zai'));
  // MiniMax: api.minimaxi.com is live and answers /v1/models, but rejects
  // current international keys. Only api.minimax.io accepts them.
  check('endpoints: MiniMax points at the host that accepts current keys',
    base('minimax') === 'https://api.minimax.io/v1', base('minimax'));
  check('endpoints: Moonshot stays on the international host',
    base('moonshot') === 'https://api.moonshot.ai/v1', base('moonshot'));
  check('endpoints: Qwen stays on the international DashScope host',
    base('qwen') === 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', base('qwen'));

  // An explicit navy.apiBase must still win — it is the only escape hatch when
  // a user's account lives on the other regional endpoint.
  check('endpoints: an explicit apiBase overrides the default',
    openAiCompatBase('zai', 'https://open.bigmodel.cn/api/paas/v4', '') === 'https://open.bigmodel.cn/api/paas/v4');

  // Every keyed provider needs SOMETHING in the dropdown when the live fetch
  // fails, or the user is left with an empty list and no way forward — which is
  // what z.ai did, having no entry at all.
  const fallbacks = NavyCoderViewProvider.MODEL_FALLBACKS;
  const keyed = ['openai', 'anthropic', 'deepseek', 'gemini', 'xai', 'zai', 'groq',
                 'openrouter', 'moonshot', 'qwen', 'minimax', 'mimo'];
  const missing = keyed.filter(p => !Array.isArray(fallbacks[p]) || fallbacks[p].length === 0);
  check('endpoints: every keyed provider has fallback models', missing.length === 0, missing.join(', '));

  // A context window is a send budget: too low wastes context, too high makes
  // the request fail outright. Driven through the real resolver, so ordering
  // bugs in the table (a broad /glm-4/ shadowing /glm-4\.6/) are caught too.
  const { resolveModelContext } = require('../src/extension.js');
  const ctxOf = (model) => resolveModelContext(model, null);
  check('endpoints: glm-4.6 gets its raised 200K window, not the old 128K', ctxOf('glm-4.6') === 200000, String(ctxOf('glm-4.6')));
  check('endpoints: glm-5.2 is not left unmatched', ctxOf('glm-5.2') === 200000, String(ctxOf('glm-5.2')));
  check('endpoints: glm-4.5 keeps 128K', ctxOf('glm-4.5') === 128000, String(ctxOf('glm-4.5')));
  check('endpoints: kimi-k3 gets its 1M window', ctxOf('kimi-k3') === 1000000, String(ctxOf('kimi-k3')));
  check('endpoints: kimi-k2.6 still matches the K2 entry', ctxOf('kimi-k2.6') === 256000, String(ctxOf('kimi-k2.6')));
}

// The pricing table's ordering is load-bearing and silent when wrong — a
// single `gemini-.*flash` rule once billed 2.5-flash turns at 1.5-flash rates
// and nothing failed. Every entry now names the model it exists FOR, and the
// build breaks if a broader rule added above it starts swallowing that model.
async function pricingSuite() {
  console.log('\nmodel pricing (ordering, overrides):');
  const pricing = require('../src/providers/pricing.js');
  const { MODEL_PRICING, PRICING_AS_OF, estimateCost, parsePricingOverrides } = pricing;

  // ── Ordering: every entry still wins for its own example. ──────────────
  const shadowed = MODEL_PRICING.filter(e => MODEL_PRICING.find(p => p.re.test(e.example)) !== e);
  check('pricing: no entry is shadowed by a broader rule above it', shadowed.length === 0,
    shadowed.map(e => e.example).join(', '));
  check('pricing: every entry declares the model it exists for',
    MODEL_PRICING.every(e => typeof e.example === 'string' && e.example.length > 0));
  check('pricing: every entry prices input and output', MODEL_PRICING.every(e =>
    Number.isFinite(e.in) && Number.isFinite(e.out) && e.in >= 0 && e.out >= 0));
  check('pricing: the table says when it was last checked', /^\d{4}-\d{2}-\d{2}$/.test(PRICING_AS_OF));

  // The specific regression the comment in the table describes.
  const flash25 = MODEL_PRICING.find(p => p.re.test('gemini-2.5-flash'));
  const flash15 = MODEL_PRICING.find(p => p.re.test('gemini-1.5-flash'));
  check('pricing: gemini 2.5-flash is not priced at 1.5-flash rates', flash25 !== flash15 && flash25.in === 0.3);

  // ── Behaviour that must not change. ────────────────────────────────────
  check('pricing: local providers are free whatever the model is called',
    estimateCost('ollama', 'claude-opus-4-1', 1e6, 1e6) === 0 && estimateCost('lmstudio', 'gpt-5', 1e6, 1e6) === 0);
  check('pricing: an unknown hosted model is null, never a guess',
    estimateCost('anthropic', 'totally-unknown-future-model', 1000, 1000) === null);
  check('pricing: a known model prices input and output separately',
    estimateCost('anthropic', 'claude-sonnet-5', 1e6, 1e6) === 3 + 15);

  // ── navy.modelPricing: a user can price what Navy has never heard of. ──
  const override = { 'my-finetune': { in: 1.5, out: 6 } };
  check('override: prices a model the built-in table does not know',
    estimateCost('custom', 'acme/my-finetune-v2', 1e6, 1e6, override) === 7.5);
  check('override: beats the built-in table for a model it DOES know',
    estimateCost('anthropic', 'claude-sonnet-5', 1e6, 0, { 'claude-sonnet': { in: 99, out: 1 } }) === 99);
  check('override: matching is case-insensitive',
    estimateCost('custom', 'ACME/My-FineTune', 1e6, 0, override) === 1.5);
  check('override: local providers still ignore it and stay free',
    estimateCost('ollama', 'my-finetune', 1e6, 1e6, override) === 0);
  check('override: the longest key wins, so a specific one is not shadowed',
    estimateCost('custom', 'gpt-5-mini', 1e6, 0, { 'gpt-5': { in: 10, out: 10 }, 'gpt-5-mini': { in: 1, out: 1 } }) === 1);

  // Malformed input must be dropped, never half-applied: a confident wrong
  // number is worse than no number in the one place that touches real money.
  for (const [label, bad] of [
    ['a missing price', { x: { in: 1 } }],
    ['a non-numeric price', { x: { in: 'free', out: 2 } }],
    ['a negative price', { x: { in: -1, out: 2 } }],
    ['a non-object value', { x: 5 }],
    ['an array instead of an object', [{ in: 1, out: 2 }]],
    ['null', null],
  ]) {
    check(`override: ${label} is ignored, not defaulted`,
      estimateCost('anthropic', 'x-model', 1000, 1000, bad) === null, JSON.stringify(bad));
  }
  check('override: a valid entry beside a malformed one still applies',
    estimateCost('custom', 'good-model', 1e6, 0, { 'bad': { in: 'x' }, 'good-model': { in: 2, out: 3 } }) === 2);
  check('parsePricingOverrides: drops everything malformed',
    parsePricingOverrides({ a: { in: 1, out: 2 }, b: { in: 'x', out: 2 }, c: null }).length === 1);

  // ── The manifest has to declare it, or the setting silently does nothing. ──
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const decl = manifest.contributes.configuration.properties['navy.modelPricing'];
  check('navy.modelPricing is declared and defaults to empty',
    decl?.type === 'object' && JSON.stringify(decl.default) === '{}');
}

module.exports = { costEstimateSuite, providerFallbackSuite, cachingFallbackSuite, adaptiveThinkingFallbackSuite, geminiSuite, providerSelfTestSuite, providerEndpointSuite, pricingSuite };
