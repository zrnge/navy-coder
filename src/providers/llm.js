const { TOOLS_API, TOOLS } = require('./tools.js');
const vscode = require('vscode');
const https = require('https');



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

    // Provider → OpenAI-compatible base URL map
    const OPENAI_COMPAT_BASE = {
      openai:     'https://api.openai.com/v1',
      lmstudio:   apiBase || 'http://localhost:1234/v1',
      deepseek:   'https://api.deepseek.com/v1',
      gemini:     'https://generativelanguage.googleapis.com/v1beta/openai',
      xai:        'https://api.x.ai/v1',
      zai:        apiBase || 'https://api.z.ai/v1',
      groq:       'https://api.groq.com/openai/v1',
      openrouter: 'https://openrouter.ai/api/v1',
      custom:     apiBase || host,
    };

    if (aiProvider === 'anthropic') {
      return await streamAnthropic(provider, model, messages, temperature, apiKey, apiBase, signal, onChunk);
    }

    if (OPENAI_COMPAT_BASE[aiProvider]) {
      const base = apiBase || OPENAI_COMPAT_BASE[aiProvider];
      return await streamOpenAI(provider, base, model, messages, temperature, apiKey, signal, onChunk);
    }

    const options = { temperature };
    if (provider.modelContextLength) options.num_ctx = provider.modelContextLength;

    // Ollama uses a separate `images` field (base64 strings, no data-URI prefix) rather than
    // the OpenAI content-array format, so convert any vision messages here.
    const ollamaMessages = messages.map(msg => {
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

    const response = await fetch(host + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: ollamaMessages,
        stream: true,
        options,
        tools: TOOLS_API
      }),
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

  async function streamAnthropic(provider, model, messages, temperature, apiKey, baseUrl = '', signal = null, onChunk = null) {
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

    // Convert TOOLS_API (OpenAI format) to Anthropic tool format.
    const anthropicTools = TOOLS_API.map(t => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));

    const body = {
      model,
      max_tokens: 16384,
      stream: true,
      temperature,
      messages: anthropicMessages,
      tools: anthropicTools,
    };
    if (systemText) body.system = systemText;

    const anthropicEndpoint = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
    const response = await fetch(anthropicEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: signal || provider.abortController.signal,
    });

    if (!response.ok || !response.body) {
      const txt = await response.text();
      throw new Error('Anthropic API error ' + response.status + ': ' + txt);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const nativeToolCalls = [];
    const tokenCounts = { prompt: 0, completion: 0 };
    // Track streaming tool-use blocks by index.
    const toolBlocks = {};

    const processLine = (line) => {
      const dataLine = line.startsWith('data: ') ? line.slice(6).trim() : null;
      if (!dataLine) return;
      let evt;
      try { evt = JSON.parse(dataLine); } catch { return; }

      if (evt.type === 'message_start' && evt.message?.usage) {
        tokenCounts.prompt = evt.message.usage.input_tokens || 0;
      }
      if (evt.type === 'message_delta' && evt.usage) {
        tokenCounts.completion = evt.usage.output_tokens || 0;
      }
      if (evt.type === 'content_block_start') {
        if (evt.content_block?.type === 'tool_use') {
          toolBlocks[evt.index] = { id: evt.content_block.id, name: evt.content_block.name, argsJson: '' };
        }
      }
      if (evt.type === 'content_block_delta') {
        const delta = evt.delta;
        if (delta?.type === 'text_delta') {
          text += delta.text;
          if (onChunk) onChunk(delta.text);
          else provider.view?.webview.postMessage({ type: 'chunk', text: delta.text });
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

    return { text, nativeToolCalls, tokenCounts };
  }

  async function streamOpenAI(provider, baseUrl, model, messages, temperature, apiKey, signal = null, onChunk = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

    const body = {
      model,
      messages,
      temperature,
      stream: true,
      tools: TOOLS_API
    };

    const response = await fetch(baseUrl + '/chat/completions', {
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

    return { text, nativeToolCalls, tokenCounts };
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
        if (toolName && TOOLS.some(t => t.name === toolName)) {
          calls.push({ name: toolName, args: toolArgs });
        }
      } catch {}
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

  
module.exports = { streamAssistant, parseToolCalls, extractCodeEdits };
