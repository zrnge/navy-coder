const { TOOLS_API, TOOLS } = require('./tools.js');
const { openAiCompatBase } = require('./endpoints.js');
const vscode = require('vscode');
const https = require('https');

// Abortable sleep for retry backoff. The abort listener is removed on normal
// completion — otherwise every retry leaks a listener on the turn's signal.
function backoffSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// fetch with automatic retry on transient failures (429 rate limit, 5xx, network
// error). Safe here because retries only happen BEFORE any stream chunk is consumed.
// Honors Retry-After when present; backs off 1s → 2s → gives up (3 attempts total).
async function fetchWithRetry(url, init) {
  const RETRYABLE = new Set([429, 500, 502, 503, 529]);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (e.name === 'AbortError' || attempt === 2) throw e;
      lastError = e;
      await backoffSleep(1000 * 2 ** attempt, init.signal);
      continue;
    }
    if (RETRYABLE.has(res.status) && attempt < 2) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      const delay = Math.min(Math.max(retryAfter * 1000, 1000 * 2 ** attempt), 15000);
      await backoffSleep(delay, init.signal);
      continue;
    }
    return res;
  }
  throw lastError || new Error('fetch failed after retries');
}



  // Returns { text, nativeToolCalls } where nativeToolCalls is an array of
  // { function: { name, arguments } } objects from the model's native tool-calling API.
  // If the model does not support native tool calling, nativeToolCalls is empty and the
  // caller should fall back to parseToolCalls(text).
  async function streamAssistant(provider, host, model, messages, temperature, signal = null, onChunk = null) {
    const config = vscode.workspace.getConfiguration('navy');
    const aiProvider = config.get('provider', 'ollama');
    const apiKey = await provider.context.secrets.get('navy.apiKey.' + aiProvider)
                || await provider.context.secrets.get('navy.apiKey') || '';
    const apiBase = config.get('apiBase', '');

    // Built-in tools plus any live MCP server tools (dynamic per request, so
    // connecting/disconnecting a server needs no reload).
    const toolsApi = TOOLS_API.concat(provider.mcp?.getToolsApi?.() || []);

    if (aiProvider === 'anthropic') {
      return await streamAnthropic(provider, model, messages, temperature, apiKey, apiBase, signal, onChunk, toolsApi);
    }

    // Gemini 2.5+/3.x always attach a thoughtSignature to functionCall parts when
    // tools are involved, and Google REQUIRES it to be echoed back on the next
    // request — a field the OpenAI-compatibility shim has no way to carry. Route
    // those specific models through Gemini's native API, which can round-trip it.
    // Older/non-thinking Gemini models (1.5, 2.0-flash) are unaffected by this and
    // keep using the proven OpenAI-compat path — this is additive, not a replacement.
    if (aiProvider === 'gemini' && isGeminiThinkingModel(model)) {
      return await streamGeminiNative(provider, model, messages, temperature, apiKey, apiBase, signal, onChunk, toolsApi);
    }

    const compatBase = openAiCompatBase(aiProvider, apiBase, host);
    if (compatBase) {
      return await streamOpenAI(provider, compatBase, model, messages, temperature, apiKey, signal, onChunk, toolsApi);
    }

    const options = { temperature };
    if (provider.modelContextLength) options.num_ctx = provider.modelContextLength;

    // Ollama uses a separate `images` field (base64 strings, no data-URI prefix) rather than
    // the OpenAI content-array format, so convert any vision messages here.
    // Also strip _rawBlocks/_rawBlocksProvider (Anthropic/Gemini-only replay state).
    const ollamaMessages = messages.map(({ _rawBlocks, _rawBlocksProvider, ...msg }) => {
      if (!Array.isArray(msg.content)) return msg;
      const texts = [];
      const imgs = [];
      for (const part of msg.content) {
        if (part.type === 'text') texts.push(part.text);
        else if (part.type === 'image_url') {
          const url = part.image_url?.url || '';
          if (url.startsWith('data:')) imgs.push(url.split(',')[1] || '');
        }
      }
      return { role: msg.role, content: texts.join('\n'), ...(imgs.length ? { images: imgs } : {}) };
    });

    const ollamaBody = {
      model,
      messages: ollamaMessages,
      stream: true,
      options,
      tools: toolsApi
    };
    // Toggle native thinking for model families that support it. Only sent when the
    // name matches — Ollama 400s if `think` is passed to a non-thinking model.
    if (/(qwen3|deepseek-r1|gpt-oss|magistral|smallthinker|exaone-deep|phi4-reasoning)/i.test(model)) {
      const level = provider.thinkingLevel || 'medium';
      if (level === 'high') ollamaBody.think = true;
      else if (level === 'fast') ollamaBody.think = false;
    }

    const response = await fetchWithRetry(host + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ollamaBody),
      signal: signal || provider.abortController.signal
    });

    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error('Ollama returned ' + response.status + ': ' + (text || response.statusText));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const nativeToolCalls = [];
    const tokenCounts = { prompt: 0, completion: 0 };

    const processLine = (line) => {
      if (!line.trim()) return;
      const events = extractJsonObjects(line);
      for (const event of events) {
        // Ollama reports mid-stream failures (model crash, OOM) as {"error": "..."} —
        // surface them instead of silently ending with an empty response.
        if (event.error) throw new Error('Ollama error: ' + event.error);
        // Native think mode streams reasoning in a separate field (never rendered) —
        // update the status line so the UI doesn't look frozen while it thinks.
        if (event.message?.thinking && !event.message?.content) {
          provider.view?.webview.postMessage({ type: 'statusText', text: 'Reasoning…' });
        }
        const content = event.message?.content || '';
        if (content) {
          text += content;
          if (onChunk) onChunk(content);
          else provider.view?.webview.postMessage({ type: 'chunk', text: content });
        }
        // Collect native tool calls from the model's function-calling API.
        const tcs = event.message?.tool_calls;
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            if (tc?.function?.name) nativeToolCalls.push(tc);
          }
        }
        // Capture token usage from the final Ollama chunk (done: true).
        if (event.done) {
          if (event.prompt_eval_count) tokenCounts.prompt = event.prompt_eval_count;
          if (event.eval_count) tokenCounts.completion = event.eval_count;
        }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);

    return { text, nativeToolCalls, tokenCounts };
  }

  // Anthropic prompt caching: mark the static prefix (system + tools) and the
  // newest message block as ephemeral cache breakpoints. On a multi-step agent
  // turn the ~10k-token prefix is then billed at ~10% and served far faster from
  // the second call on. Pure — clones instead of mutating, so breakpoints never
  // accumulate across iterations (Anthropic allows at most 4 per request).
  function applyAnthropicCacheControl(systemText, tools, messages) {
    const cc = { cache_control: { type: 'ephemeral' } };
    const system = systemText ? [{ type: 'text', text: systemText, ...cc }] : undefined;
    const outTools = tools.length
      ? tools.map((t, i) => i === tools.length - 1 ? { ...t, ...cc } : t)
      : tools;
    const outMsgs = messages.slice();
    if (outMsgs.length) {
      const last = { ...outMsgs[outMsgs.length - 1] };
      if (typeof last.content === 'string' && last.content) {
        last.content = [{ type: 'text', text: last.content, ...cc }];
      } else if (Array.isArray(last.content) && last.content.length) {
        const blocks = last.content.slice();
        blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], ...cc };
        last.content = blocks;
      }
      outMsgs[outMsgs.length - 1] = last;
    }
    return { system, tools: outTools, messages: outMsgs };
  }

  async function streamAnthropic(provider, model, messages, temperature, apiKey, baseUrl = '', signal = null, onChunk = null, toolsApi = TOOLS_API) {
    // Convert OpenAI-format messages to Anthropic Messages API format.
    let systemText = '';
    const anthropicMessages = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemText += (systemText ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : '');
      } else if (msg.role === 'tool') {
        // Fold tool results into the preceding user block or open a new one.
        const last = anthropicMessages[anthropicMessages.length - 1];
        const toolBlock = { type: 'tool_result', tool_use_id: msg.tool_call_id || '', content: String(msg.content) };
        if (last?.role === 'user' && Array.isArray(last.content)) {
          last.content.push(toolBlock);
        } else {
          anthropicMessages.push({ role: 'user', content: [toolBlock] });
        }
      } else if (msg.role === 'assistant' && msg._rawBlocksProvider === 'anthropic' && Array.isArray(msg._rawBlocks) && msg._rawBlocks.length) {
        // Replay the exact content blocks from a previous streaming turn. Required when
        // extended thinking is enabled: Anthropic rejects tool_use turns whose thinking
        // blocks were stripped or reconstructed. Provider-tag-gated: if the user
        // switched provider mid-conversation, rawBlocks from a DIFFERENT provider
        // (e.g. Gemini's parts shape) must never be replayed here — fall through
        // to the generic tool_calls reconstruction branch below instead.
        anthropicMessages.push({ role: 'assistant', content: msg._rawBlocks });
      } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
        // Convert OpenAI tool-call assistant turn to Anthropic tool_use blocks.
        const blocks = [];
        if (msg.content) blocks.push({ type: 'text', text: String(msg.content) });
        for (const tc of msg.tool_calls) {
          let inp = {};
          try { inp = JSON.parse(tc.function?.arguments || '{}'); } catch {}
          blocks.push({ type: 'tool_use', id: tc.id || '', name: tc.function?.name || '', input: inp });
        }
        anthropicMessages.push({ role: 'assistant', content: blocks });
      } else if (Array.isArray(msg.content)) {
        // Vision message — convert OpenAI content array to Anthropic blocks.
        const blocks = [];
        for (const part of msg.content) {
          if (part.type === 'text') {
            blocks.push({ type: 'text', text: part.text });
          } else if (part.type === 'image_url') {
            const url = part.image_url?.url || '';
            if (url.startsWith('data:')) {
              const [meta, data] = url.split(',');
              const mediaType = meta.slice(5).split(';')[0]; // "data:image/png;base64" → "image/png"
              blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
            }
          }
        }
        if (blocks.length > 0) {
          anthropicMessages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: blocks });
        }
      } else {
        // Regular text user / assistant message.
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content || msg.role === 'user') {
          anthropicMessages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: String(content) });
        }
      }
    }

    // Merge consecutive same-role messages — Anthropic 400s when roles don't alternate.
    // (Happens after an aborted turn: two user entries land back to back in history.)
    const mergedMessages = [];
    for (const m of anthropicMessages) {
      const prev = mergedMessages[mergedMessages.length - 1];
      if (prev && prev.role === m.role) {
        const toBlocks = (c) => Array.isArray(c) ? c : [{ type: 'text', text: String(c) }];
        prev.content = [...toBlocks(prev.content), ...toBlocks(m.content)];
      } else {
        mergedMessages.push(m);
      }
    }

    // Convert the OpenAI-format tool list (built-ins + MCP) to Anthropic format.
    const anthropicTools = toolsApi.map(t => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));

    // Older model generations cap max_tokens lower — exceeding the cap is a 400 error.
    const maxTokens = /claude-3-(opus|sonnet|haiku)-/.test(model) ? 4096
                    : /claude-3-5-/.test(model) ? 8192
                    : 16384;
    // High thinking level → Anthropic extended thinking. Temperature must be omitted
    // (the API requires the default of 1 when thinking is enabled). Claude 3.x
    // generations don't support the thinking parameter — fall back to temperature.
    const supportsThinking = !/claude-3-(opus|sonnet|haiku|5)/.test(model);
    const thinkingLevel = provider.thinkingLevel || 'medium';
    const useThinking = supportsThinking && thinkingLevel === 'high';
    const effortMap = { fast: 'low', medium: 'medium', high: 'high' };

    // Prompt caching: system + tools + newest message become cache breakpoints.
    const cached = applyAnthropicCacheControl(systemText, anthropicTools, mergedMessages);

    // Newer model generations reject the legacy thinking shape ({type:'enabled',
    // budget_tokens}) and reject `temperature` outright, wanting
    // {type:'adaptive'} + output_config.effort instead. We can't know which
    // generation a given model name belongs to ahead of time without going stale
    // the moment a new one ships, so build both shapes and fall back at runtime
    // on the API's own error text — same pattern as the cache_control fallback.
    const buildBody = (useAdaptive, withCaching) => {
      const b = {
        model,
        max_tokens: maxTokens,
        stream: true,
        messages: withCaching ? cached.messages : mergedMessages,
        tools: withCaching ? cached.tools : anthropicTools,
      };
      if (useAdaptive) {
        b.thinking = { type: 'adaptive' };
        b.output_config = { effort: effortMap[thinkingLevel] || 'medium' };
      } else if (useThinking) {
        b.thinking = { type: 'enabled', budget_tokens: 6000 };
      } else {
        b.temperature = temperature;
      }
      const sys = withCaching ? cached.system : systemText;
      if (sys) b.system = sys;
      return b;
    };

    const anthropicEndpoint = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
    const anthropicHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
    const postAnthropic = (b) => fetchWithRetry(anthropicEndpoint, {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify(b),
      signal: signal || provider.abortController.signal,
    });

    const looksLikeCachingIssue = (txt) => /cache_control|cache/i.test(txt);
    const needsAdaptiveRetry = (txt) => /thinking\.type\.enabled|thinking\.type\.adaptive|output_config\.effort|`?temperature`?\s+is deprecated/i.test(txt);

    let withCaching = true;
    let useAdaptive = false;
    let response = await postAnthropic(buildBody(useAdaptive, withCaching));
    let txt = null;
    if (!response.ok || !response.body) {
      txt = await response.text();

      if (response.status === 400 && looksLikeCachingIssue(txt) && !needsAdaptiveRetry(txt)) {
        withCaching = false;
        response = await postAnthropic(buildBody(useAdaptive, withCaching));
        txt = (response.ok && response.body) ? null : await response.text();
      }

      if (txt !== null && response.status === 400 && needsAdaptiveRetry(txt)) {
        useAdaptive = true;
        response = await postAnthropic(buildBody(useAdaptive, withCaching));
        txt = (response.ok && response.body) ? null : await response.text();
      }

      if (txt !== null) {
        throw new Error('Anthropic API error ' + response.status + ': ' + txt);
      }
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const nativeToolCalls = [];
    const tokenCounts = { prompt: 0, completion: 0 };
    // Track streaming tool-use blocks by index.
    const toolBlocks = {};
    // Preserve the exact ordered content blocks (thinking/text/tool_use) so the next
    // iteration can replay them verbatim — mandatory when extended thinking is on.
    const rawBlocks = [];
    const rawByIndex = {};

    const processLine = (line) => {
      const dataLine = line.startsWith('data: ') ? line.slice(6).trim() : null;
      if (!dataLine) return;
      let evt;
      try { evt = JSON.parse(dataLine); } catch { return; }

      // Mid-stream API errors (overloaded, rate limit) arrive as an error event —
      // throw so the user sees the real reason instead of "No response received".
      if (evt.type === 'error') {
        throw new Error('Anthropic stream error: ' + (evt.error?.message || JSON.stringify(evt.error || {})));
      }
      if (evt.type === 'message_start' && evt.message?.usage) {
        tokenCounts.prompt = evt.message.usage.input_tokens || 0;
      }
      if (evt.type === 'message_delta' && evt.usage) {
        tokenCounts.completion = evt.usage.output_tokens || 0;
      }
      if (evt.type === 'content_block_start') {
        const cb = evt.content_block;
        if (cb?.type === 'tool_use') {
          toolBlocks[evt.index] = { id: cb.id, name: cb.name, argsJson: '' };
          rawByIndex[evt.index] = { type: 'tool_use', id: cb.id, name: cb.name, input: {} };
        } else if (cb?.type === 'thinking') {
          rawByIndex[evt.index] = { type: 'thinking', thinking: '', signature: '' };
          provider.view?.webview.postMessage({ type: 'statusText', text: 'Reasoning…' });
        } else if (cb?.type === 'redacted_thinking') {
          rawByIndex[evt.index] = { type: 'redacted_thinking', data: cb.data || '' };
        } else if (cb?.type === 'text') {
          rawByIndex[evt.index] = { type: 'text', text: '' };
          // Reasoning finished — reflect that the model is now writing the answer.
          provider.view?.webview.postMessage({ type: 'statusText', text: 'Working…' });
        }
        if (rawByIndex[evt.index]) rawBlocks.push(rawByIndex[evt.index]);
      }
      if (evt.type === 'content_block_delta') {
        const delta = evt.delta;
        const raw = rawByIndex[evt.index];
        if (delta?.type === 'text_delta') {
          text += delta.text;
          if (raw?.type === 'text') raw.text += delta.text;
          if (onChunk) onChunk(delta.text);
          else provider.view?.webview.postMessage({ type: 'chunk', text: delta.text });
        }
        if (delta?.type === 'thinking_delta' && raw?.type === 'thinking') {
          raw.thinking += delta.thinking || '';
        }
        if (delta?.type === 'signature_delta' && raw?.type === 'thinking') {
          raw.signature = delta.signature || '';
        }
        if (delta?.type === 'input_json_delta' && toolBlocks[evt.index]) {
          toolBlocks[evt.index].argsJson += delta.partial_json || '';
        }
      }
      if (evt.type === 'content_block_stop' && toolBlocks[evt.index]) {
        const tb = toolBlocks[evt.index];
        let args = {};
        try { args = JSON.parse(tb.argsJson || '{}'); } catch {}
        nativeToolCalls.push({ id: tb.id, function: { name: tb.name, arguments: JSON.stringify(args) } });
        if (rawByIndex[evt.index]?.type === 'tool_use') rawByIndex[evt.index].input = args;
        delete toolBlocks[evt.index];
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer) buffer.split('\n').forEach(processLine);

    return { text, nativeToolCalls, tokenCounts, rawBlocks };
  }

  async function streamOpenAI(provider, baseUrl, model, messages, temperature, apiKey, signal = null, onChunk = null, toolsApi = TOOLS_API) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

    const body = {
      model,
      // _rawBlocks/_rawBlocksProvider are Anthropic/Gemini-only replay state — never
      // send them to OpenAI-compat APIs.
      messages: messages.map(({ _rawBlocks, _rawBlocksProvider, ...m }) => m),
      stream: true,
      tools: toolsApi
    };
    // Without this, OpenAI-compatible streams never include usage and the token
    // counter / context gauge stay at 0. Gemini's compat layer rejects the field.
    if (!baseUrl.includes('generativelanguage')) {
      body.stream_options = { include_usage: true };
    }
    // o-series reasoning models reject `temperature` and take `reasoning_effort` instead.
    if (/^o[0-9]/.test(model)) {
      const level = provider.thinkingLevel || 'medium';
      body.reasoning_effort = level === 'high' ? 'high' : level === 'fast' ? 'low' : 'medium';
    } else {
      body.temperature = temperature;
    }

    const response = await fetchWithRetry(baseUrl + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal || provider.abortController.signal
    });

    if (!response.ok || !response.body) {
      const txt = await response.text();
      throw new Error('API error ' + response.status + ': ' + txt);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const nativeToolCalls = [];
    const tokenCounts = { prompt: 0, completion: 0 };

    const processSSE = (line) => {
      if (!line.startsWith('data: ')) return;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;
      try {
        const evt = JSON.parse(data);
        const delta = evt.choices?.[0]?.delta;
        if (delta?.content) {
          text += delta.content;
          if (onChunk) onChunk(delta.content);
          else provider.view?.webview.postMessage({ type: 'chunk', text: delta.content });
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            // OpenAI streams tool calls in fragments: first chunk has name+id,
            // later chunks have only arguments fragments at the same index.
            const idx = tc.index ?? nativeToolCalls.length;
            if (!nativeToolCalls[idx]) {
              nativeToolCalls[idx] = { id: '', function: { name: '', arguments: '' } };
            }
            if (tc.id) nativeToolCalls[idx].id = tc.id;
            if (tc.function?.name) nativeToolCalls[idx].function.name = tc.function.name;
            if (tc.function?.arguments) nativeToolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
        if (evt.usage) {
          tokenCounts.prompt = evt.usage.prompt_tokens || 0;
          tokenCounts.completion = evt.usage.completion_tokens || 0;
        }
      } catch {}
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) processSSE(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processSSE(buffer);

    // Sparse indexes (a provider skipping tc.index values) leave holes that would
    // crash the caller's .map(tc => tc.function.name) — compact them out.
    return { text, nativeToolCalls: nativeToolCalls.filter(Boolean), tokenCounts };
  }

  // Gemini 2.5+ and 3.x always think, and Google requires the resulting
  // thoughtSignature to be echoed back on functionCall parts on the next request
  // or tool use breaks outright ("Function call is missing a thought_signature").
  // The OpenAI-compat shim (used for older Gemini models) has no field for it.
  function isGeminiThinkingModel(model) {
    return /gemini-(2\.5|3(?:\.\d+)?)/i.test(String(model || ''));
  }

  // Native Gemini streaming (generateContent SSE), used only for isGeminiThinkingModel().
  // Mirrors the Anthropic native path's approach: preserve the exact "parts" the
  // model returned (including thought/thoughtSignature) in rawBlocks, and replay
  // them verbatim as the next request's "model" turn — Gemini's analogue of
  // Anthropic's _rawBlocks requirement for thinking + tool use.
  async function streamGeminiNative(provider, model, messages, temperature, apiKey, baseUrl = '', signal = null, onChunk = null, toolsApi = TOOLS_API) {
    // Convert the OpenAI-shaped internal message list to Gemini's `contents`.
    // Track tool_call_id → name so 'tool' role results (which only carry the id)
    // can be turned into Gemini's name-keyed functionResponse parts.
    let systemText = '';
    const contents = [];
    const idToName = {};

    const toGeminiParts = (content) => {
      if (typeof content === 'string') return content ? [{ text: content }] : [];
      if (!Array.isArray(content)) return [];
      const parts = [];
      for (const part of content) {
        if (part.type === 'text' && part.text) parts.push({ text: part.text });
        else if (part.type === 'image_url') {
          const url = part.image_url?.url || '';
          if (url.startsWith('data:')) {
            const [meta, data] = url.split(',');
            const mimeType = meta.slice(5).split(';')[0];
            parts.push({ inlineData: { mimeType, data } });
          }
        }
      }
      return parts;
    };

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemText += (systemText ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : '');
      } else if (msg.role === 'assistant' && msg._rawBlocksProvider === 'gemini' && Array.isArray(msg._rawBlocks) && msg._rawBlocks.length) {
        // Exact replay — required to keep thoughtSignature intact. Gated on the
        // provider tag for the same cross-provider-switch reason as Anthropic's
        // replay branch above.
        contents.push({ role: 'model', parts: msg._rawBlocks });
        for (const tc of (msg.tool_calls || [])) if (tc.id) idToName[tc.id] = tc.function?.name || '';
      } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
        // No native rawBlocks available (e.g. history from a different provider) —
        // reconstruct a best-effort functionCall-only turn.
        const parts = [];
        if (msg.content) parts.push({ text: String(msg.content) });
        for (const tc of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
          parts.push({ functionCall: { name: tc.function?.name || '', args } });
          if (tc.id) idToName[tc.id] = tc.function?.name || '';
        }
        contents.push({ role: 'model', parts });
      } else if (msg.role === 'tool') {
        const name = idToName[msg.tool_call_id] || 'unknown_function';
        const responsePart = { functionResponse: { name, response: { result: String(msg.content) } } };
        const last = contents[contents.length - 1];
        if (last?.role === 'user' && last.parts.every(p => p.functionResponse)) last.parts.push(responsePart);
        else contents.push({ role: 'user', parts: [responsePart] });
      } else if (Array.isArray(msg.content)) {
        const parts = toGeminiParts(msg.content);
        if (parts.length) contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
      } else {
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (text || msg.role === 'user') contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: text ? [{ text }] : [{ text: '' }] });
      }
    }

    const geminiTools = toolsApi.length
      ? [{ functionDeclarations: toolsApi.map(t => ({
          name: t.function.name,
          description: t.function.description || '',
          parameters: t.function.parameters || { type: 'object', properties: {} },
        })) }]
      : undefined;

    const useThinking = (provider.thinkingLevel || 'medium') === 'high';
    const body = {
      contents,
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      ...(geminiTools ? { tools: geminiTools } : {}),
      generationConfig: {
        temperature,
        maxOutputTokens: 8192,
        ...(useThinking ? { thinkingConfig: { includeThoughts: true, thinkingBudget: 8000 } } : {}),
      },
    };

    const base = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    const url = base + '/v1beta/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse';
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: signal || provider.abortController.signal,
    });

    if (!response.ok || !response.body) {
      const txt = await response.text();
      throw new Error('Gemini API error ' + response.status + ': ' + txt);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const nativeToolCalls = [];
    const tokenCounts = { prompt: 0, completion: 0 };
    const rawBlocks = []; // exact parts, replayed verbatim next turn
    let thinkingStarted = false;

    const processLine = (line) => {
      const dataLine = line.startsWith('data: ') ? line.slice(6).trim() : null;
      if (!dataLine || dataLine === '[DONE]') return;
      let evt;
      try { evt = JSON.parse(dataLine); } catch { return; }
      if (evt.usageMetadata) {
        tokenCounts.prompt = evt.usageMetadata.promptTokenCount || tokenCounts.prompt;
        tokenCounts.completion = evt.usageMetadata.candidatesTokenCount || tokenCounts.completion;
      }
      const parts = evt.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.functionCall) {
          const id = part.functionCall.id || (part.functionCall.name + '_' + Math.random().toString(16).slice(2, 10));
          nativeToolCalls.push({ id, function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } });
          rawBlocks.push(part); // preserves thoughtSignature on this part, if present
        } else if (part.thought) {
          if (!thinkingStarted) {
            thinkingStarted = true;
            provider.view?.webview.postMessage({ type: 'statusText', text: 'Reasoning…' });
          }
          rawBlocks.push(part);
        } else if (typeof part.text === 'string') {
          text += part.text;
          rawBlocks.push(part);
          if (thinkingStarted) provider.view?.webview.postMessage({ type: 'statusText', text: 'Working…' });
          if (onChunk) onChunk(part.text);
          else provider.view?.webview.postMessage({ type: 'chunk', text: part.text });
        }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) buffer.split('\n').forEach(processLine);

    return { text, nativeToolCalls, tokenCounts, rawBlocks };
  }

  function extractJsonObjects(text) {
    const events = [];
    let pos = 0;
    while (pos < text.length) {
      while (pos < text.length && text[pos] !== '{') pos++;
      if (pos >= text.length) break;
      const start = pos;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let i = pos; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { end = i + 1; break; }
        }
      }
      if (end === -1) break;
      const jsonText = text.slice(start, end);
      try { events.push(JSON.parse(jsonText)); } catch {}
      pos = end;
    }
    return events;
  }

  function parseToolCalls(text) {
    const calls = [];

    const CLOSE = '(?:</tool\\s*>|<\\|tool_call_end\\|>)';
    const regex1 = new RegExp('<tool\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)' + CLOSE, 'g');
    let match;
    while ((match = regex1.exec(text)) !== null) {
      const name = match[1].trim();
      try {
        calls.push({ name, args: JSON.parse(match[2].trim()) });
      } catch {
        const fixed = match[2].trim().replace(/,\s*}/, '}').replace(/'/g, '"');
        try { calls.push({ name, args: JSON.parse(fixed) }); }
        catch (e) { calls.push({ name: '__parse_error__', args: { tool: name, error: e.message } }); }
      }
    }

    const regex2 = /<\|tool_call_begin\|>([\s\S]*?)<\|tool_call_end\|>/g;
    while ((match = regex2.exec(text)) !== null) {
      try {
        const obj = JSON.parse(match[1].trim());
        if (obj.name) calls.push({ name: obj.name, args: obj.parameters || obj.arguments || obj.args || {} });
      } catch {}
    }

    const regex3 = /```(?:json)?\s*\n(\{[\s\S]*?\})\s*\n```/g;
    while ((match = regex3.exec(text)) !== null) {
      try {
        const obj = JSON.parse(match[1]);
        const toolName = obj.tool || obj.function || obj.name;
        const toolArgs = obj.arguments || obj.parameters || obj.args || {};
        // mcp__<server>__<tool> is Navy's own reserved namespace for connected MCP
        // servers — allow it through even though it's not in the static TOOLS list
        // (that list only knows the built-ins). A name that doesn't correspond to
        // an actually-connected server is handled gracefully by McpManager.call().
        if (toolName && (TOOLS.some(t => t.name === toolName) || /^mcp__/.test(toolName))) {
          calls.push({ name: toolName, args: toolArgs });
        }
      } catch {}
    }

    // Bare JSON tool calls — small local models (qwen-coder, llama, etc.) often
    // can't use native tool calling or the XML format and just print the call as
    // raw JSON text. Fallback only: fire when nothing else matched AND the object
    // clearly names a KNOWN tool with an arguments object, so we never mistake
    // JSON the user is merely discussing for a tool call.
    if (calls.length === 0) {
      for (const obj of extractJsonObjects(text)) {
        if (!obj || typeof obj !== 'object') continue;
        const name = obj.name || obj.tool || obj.function;
        const rawArgs = obj.arguments ?? obj.parameters ?? obj.args ?? obj.input;
        if (typeof name !== 'string' || rawArgs === undefined) continue;
        if (!TOOLS.some(t => t.name === name) && !/^mcp__/.test(name)) continue;
        let args = rawArgs;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        calls.push({ name, args: args && typeof args === 'object' ? args : {} });
      }
    }

    return calls;
  }

  function extractCodeEdits(text) {
    const edits = [];
    const regex = /(^|\n)(`{3,})(\w+)?(?::([^\s\n]+))?\n([\s\S]*?)\n\2($|\n)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const language = match[3] || '';
      const filePath = match[4] || '';
      const code = match[5];
      if (!filePath) continue;
      edits.push({ language, path: filePath, code });
    }
    return edits;
  }

  
module.exports = { streamAssistant, parseToolCalls, extractCodeEdits, applyAnthropicCacheControl, isGeminiThinkingModel };
