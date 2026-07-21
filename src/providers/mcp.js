// Minimal MCP (Model Context Protocol) client — stdio transport.
//
// Lets Navy consume external MCP tool servers (databases, browsers, debuggers,
// anything from the MCP ecosystem) exactly like Claude Desktop / Cursor / Roo do.
// Scope: tools only (no resources/prompts), stdio transport only, newline-delimited
// JSON-RPC 2.0 per the MCP spec. Failures are always non-fatal to Navy itself.
//
// Config shape (VS Code setting `navy.mcpServers`, same as Claude Desktop):
//   { "windbg": { "command": "pwsh.exe", "args": ["-File", "server.ps1"], "env": {} } }

const { spawn } = require('child_process');

const PROTOCOL_VERSION = '2024-11-05';
const CALL_TIMEOUT_MS = 60_000;
const INIT_TIMEOUT_MS = 15_000;
const MAX_RESULT_CHARS = 16_000;

// Shared by both transports: MCP tool results are an array of content blocks;
// flatten text blocks into one string, describe anything else, cap the length.
function formatToolResult(res) {
  const parts = [];
  for (const c of res?.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else parts.push(`[${c.type} content omitted]`);
  }
  let out = parts.join('\n').trim() || '(no content returned)';
  if (res?.isError) out = 'MCP tool error: ' + out;
  if (out.length > MAX_RESULT_CHARS) {
    out = out.slice(0, MAX_RESULT_CHARS) + `\n[...truncated ${out.length - MAX_RESULT_CHARS} chars]`;
  }
  return out;
}

class McpServerConnection {
  constructor(name, config, log) {
    this.name = name;
    this.config = config;
    this.log = log || (() => {});
    this.proc = null;
    this.tools = [];          // raw tool defs from tools/list
    this.ready = false;
    this._nextId = 1;
    this._pending = new Map(); // id → { resolve, reject, timer }
    this._buffer = '';
  }

  async start() {
    const { command, args = [], env = {} } = this.config;
    if (!command) throw new Error('mcpServers.' + this.name + ' is missing "command"');
    this.proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.proc.stderr.on('data', (d) => this.log(`[mcp:${this.name}] ${String(d).trim()}`));
    this.proc.on('close', (code) => {
      this.ready = false;
      const err = new Error(`MCP server "${this.name}" exited (code ${code})`);
      for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(err); }
      this._pending.clear();
    });
    this.proc.on('error', (e) => {
      this.ready = false;
      for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(e); }
      this._pending.clear();
    });

    await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'navy-coder', version: '0.2.3' },
    }, INIT_TIMEOUT_MS);
    this._notify('notifications/initialized', {});
    const res = await this._request('tools/list', {}, INIT_TIMEOUT_MS);
    this.tools = Array.isArray(res?.tools) ? res.tools : [];
    this.ready = true;
    return this.tools;
  }

  async callTool(toolName, args) {
    if (!this.ready) throw new Error(`MCP server "${this.name}" is not running`);
    const res = await this._request('tools/call', { name: toolName, arguments: args || {} }, CALL_TIMEOUT_MS);
    return formatToolResult(res);
  }

  stop() {
    this.ready = false;
    try { this.proc?.kill(); } catch {}
    this.proc = null;
  }

  _request(method, params, timeoutMs) {
    const id = this._nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP "${this.name}" ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._send(msg);
    });
  }

  _notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  _send(msg) {
    try { this.proc?.stdin.write(JSON.stringify(msg) + '\n'); }
    catch (e) { this.log(`[mcp:${this.name}] write failed: ${e.message}`); }
  }

  _onData(chunk) {
    this._buffer += chunk.toString();
    // Newline-delimited JSON-RPC; tolerate partial lines and non-JSON noise.
    let idx;
    while ((idx = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this._pending.has(msg.id)) {
        const p = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      // Server-initiated requests/notifications are ignored (tools-only scope).
    }
  }
}

// MCP "streamable HTTP" transport (the current spec's remote-server transport,
// supersedes the older standalone-SSE transport). Each JSON-RPC call is one POST;
// the response is either a single JSON object or an SSE stream of JSON-RPC
// messages (progress notifications interleaved with the final response) —
// both are handled. A session id returned on the first response (if any) is
// echoed on every subsequent request, per spec.
class McpHttpConnection {
  constructor(name, config, log) {
    this.name = name;
    this.url = config.url;
    this.headers = config.headers || {};
    this.log = log || (() => {});
    this.tools = [];
    this.ready = false;
    this.sessionId = null;
    this._nextId = 1;
  }

  async start() {
    if (!this.url) throw new Error('mcpServers.' + this.name + ' is missing "url"');
    await this._send({ jsonrpc: '2.0', id: this._nextId++, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'navy-coder', version: '0.2.4' } } },
      INIT_TIMEOUT_MS, true);
    await this._send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, INIT_TIMEOUT_MS, false);
    const listResult = await this._send({ jsonrpc: '2.0', id: this._nextId++, method: 'tools/list', params: {} }, INIT_TIMEOUT_MS, true);
    this.tools = Array.isArray(listResult?.tools) ? listResult.tools : [];
    this.ready = true;
    return this.tools;
  }

  async callTool(toolName, args) {
    if (!this.ready) throw new Error(`MCP server "${this.name}" is not running`);
    const result = await this._send({ jsonrpc: '2.0', id: this._nextId++, method: 'tools/call', params: { name: toolName, arguments: args || {} } }, CALL_TIMEOUT_MS, true);
    return formatToolResult(result);
  }

  stop() {
    this.ready = false;
    if (this.sessionId) {
      // Best-effort session close per spec — must never block or throw.
      const headers = { ...this.headers, 'Mcp-Session-Id': this.sessionId };
      try { fetch(this.url, { method: 'DELETE', headers }).catch(() => {}); } catch {}
    }
  }

  async _send(msg, timeoutMs, expectResponse) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers = { ...this.headers, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    let res;
    try {
      res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(msg), signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!expectResponse) return undefined; // fire-and-forget notification
    if (!res.ok) {
      let errText = '';
      try { errText = (await res.text()).slice(0, 300); } catch {}
      throw new Error(`MCP "${this.name}" HTTP ${res.status}` + (errText ? ': ' + errText : ''));
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      return data.result;
    }
    if (ct.includes('text/event-stream')) {
      return await this._readSseForId(res, msg.id, timeoutMs);
    }
    throw new Error(`MCP "${this.name}" unexpected response content-type: ${ct || '(none)'}`);
  }

  // Reads an SSE response looking for the JSON-RPC message matching our request
  // id (other messages on the same stream, e.g. progress notifications, are
  // ignored). Frames are separated by a blank line per the SSE spec.
  async _readSseForId(res, id, timeoutMs) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        if (Date.now() > deadline) throw new Error(`MCP "${this.name}" SSE response timed out waiting for id ${id}`);
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
          if (!dataLines.length) continue;
          let msg;
          try { msg = JSON.parse(dataLines.join('')); } catch { continue; }
          if (msg.id === id) {
            try { reader.cancel(); } catch {}
            if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
            return msg.result;
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    throw new Error(`MCP "${this.name}" SSE stream ended before a response for id ${id} arrived`);
  }
}

// Manages all configured servers. Tool names are exposed to the model as
// "mcp__<server>__<tool>" so they can't collide with Navy's built-ins.
class McpManager {
  constructor(log) {
    this.log = log || (() => {});
    this.servers = new Map(); // name → McpServerConnection
  }

  // config: { name: { command, args, env } } for stdio servers, or
  //         { name: { url, headers } } for streamable-HTTP servers.
  async start(config) {
    this.stop();
    const names = Object.keys(config || {});
    const results = [];
    for (const name of names) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) { results.push({ name, error: 'invalid server name' }); continue; }
      const entry = config[name] || {};
      const conn = entry.url
        ? new McpHttpConnection(name, entry, this.log)
        : new McpServerConnection(name, entry, this.log);
      try {
        const tools = await conn.start();
        this.servers.set(name, conn);
        results.push({ name, tools: tools.length });
      } catch (e) {
        conn.stop();
        results.push({ name, error: e.message });
      }
    }
    return results;
  }

  // OpenAI-style tool defs for every connected server's tools.
  getToolsApi() {
    const out = [];
    for (const [name, conn] of this.servers) {
      for (const t of conn.tools) {
        out.push({
          type: 'function',
          function: {
            name: `mcp__${name}__${t.name}`,
            description: `[MCP:${name}] ${t.description || t.name}`,
            parameters: t.inputSchema || { type: 'object', properties: {} },
          },
        });
      }
    }
    return out;
  }

  isMcpTool(toolName) { return typeof toolName === 'string' && toolName.startsWith('mcp__'); }

  // "mcp__server__tool" → routed call. Tool names may themselves contain
  // underscores, so split only on the first two delimiters.
  async call(toolName, args) {
    const m = toolName.match(/^mcp__([a-zA-Z0-9_-]+?)__(.+)$/);
    if (!m) return `Error: malformed MCP tool name "${toolName}"`;
    const conn = this.servers.get(m[1]);
    if (!conn) return `Error: MCP server "${m[1]}" is not connected.`;
    try { return await conn.callTool(m[2], args); }
    catch (e) { return `MCP call failed: ${e.message}`; }
  }

  get toolCount() {
    let n = 0;
    for (const [, c] of this.servers) n += c.tools.length;
    return n;
  }

  stop() {
    for (const [, conn] of this.servers) conn.stop();
    this.servers.clear();
  }
}

module.exports = { McpManager, McpServerConnection, McpHttpConnection };
