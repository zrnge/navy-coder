// Minimal MCP (Model Context Protocol) client — stdio and streamable HTTP.
//
// Lets Navy consume external MCP servers (databases, browsers, debuggers,
// anything from the MCP ecosystem) exactly like Claude Desktop / Cursor / Roo do.
// Newline-delimited JSON-RPC 2.0 per the MCP spec. Failures are always
// non-fatal to Navy itself.
//
// Scope: tools, resources and prompts. The three are surfaced differently
// because they are different things, and flattening them into one shape is
// what makes an MCP integration feel wrong:
//
//   tools     — the model calls them, so they become tool schemas.
//   resources — DATA the model may want to read. A server can expose hundreds,
//               and putting each one in the tool schema would cost more context
//               than the data is worth, so they get exactly two tools between
//               them: one to list, one to read.
//   prompts   — templates a PERSON invokes, so they become slash commands.
//               Handing them to the model as tools would be the same category
//               error in the other direction.
//
// All three are capability-gated: a server that does not declare resources is
// never asked for them, and the resource tools are not offered to the model at
// all unless some connected server actually has some.
//
// NOT here: OAuth for remote HTTP servers. That needs a device/authorisation
// flow, token storage in the OS keychain, and refresh — enough moving parts to
// be its own piece of work rather than a footnote to this one. Until then a
// remote server can only be reached with a static header (see `headers`).
//
// Config shape (VS Code setting `navy.mcpServers`, same as Claude Desktop):
//   { "windbg": { "command": "pwsh.exe", "args": ["-File", "server.ps1"], "env": {} } }

const { spawn } = require('child_process');
// Single source of truth for the MCP clientInfo version — previously hardcoded
// separately in each transport's initialize() call, and both copies had
// drifted from the actual extension version (and from each other).
const { version: EXTENSION_VERSION } = require('../../package.json');

// The two tools that stand in for every resource on every server. Declared
// here rather than in tools.js because they exist only when MCP does, and
// tools.js builds the static schema list once at load.
const MCP_RESOURCE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_mcp_resources',
      description: 'List the data resources exposed by connected MCP servers — files, records, documents the server makes readable. Returns each resource\'s uri, which read_mcp_resource takes. Call this before guessing a uri.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_mcp_resource',
      description: 'Read one resource from a connected MCP server by its uri, as listed by list_mcp_resources. Returns its text; binary content is described rather than returned.',
      parameters: {
        type: 'object',
        properties: { uri: { type: 'string', description: 'The resource uri, exactly as list_mcp_resources reported it.' } },
        required: ['uri'],
      },
    },
  },
];

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

// resources/read returns content blocks like a tool result, but with uri and
// mimeType instead of a type discriminator, and `blob` for binary. Binary is
// described rather than decoded: a base64 image pasted into a model's context
// as text is thousands of useless tokens.
function formatResourceRead(res, uri) {
  const parts = [];
  for (const c of res?.contents || []) {
    if (typeof c.text === 'string') parts.push(c.text);
    else if (c.blob) parts.push(`[binary ${c.mimeType || 'content'} omitted — ${String(c.blob).length} base64 chars]`);
  }
  let out = parts.join('\n').trim() || '(resource returned no content)';
  if (out.length > MAX_RESULT_CHARS) {
    out = out.slice(0, MAX_RESULT_CHARS) + `\n[...truncated ${out.length - MAX_RESULT_CHARS} chars]`;
  }
  return `Resource ${uri}:\n${out}`;
}

// prompts/get returns a conversation. Navy flattens it to the text a slash
// command expands into — the roles are the server's idea of how to stage the
// request, and Navy already owns that decision for its own turns.
function formatPromptMessages(res) {
  const parts = [];
  for (const m of res?.messages || []) {
    const c = m?.content;
    if (typeof c === 'string') parts.push(c);
    else if (c && typeof c.text === 'string') parts.push(c.text);
    else if (Array.isArray(c)) parts.push(c.map(b => b?.text || '').filter(Boolean).join('\n'));
  }
  return parts.join('\n\n').trim();
}

// Asks a connected server for whatever it ALSO offers beyond tools. Both
// non-fatal and both capability-gated: a server that never declared resources
// is never asked, and one that declares them then fails to list is logged and
// left with none rather than failing the whole connection. An MCP server is
// something a user configured for one job; losing it entirely because a
// secondary feature misbehaved would be the wrong trade.
async function discoverExtras(conn) {
  if (conn.capabilities?.resources) {
    try {
      const r = await conn._rpc('resources/list', {}, INIT_TIMEOUT_MS);
      conn.resources = Array.isArray(r?.resources) ? r.resources : [];
    } catch (e) { conn.log(`[mcp:${conn.name}] resources/list failed: ${e.message}`); }
  }
  if (conn.capabilities?.prompts) {
    try {
      const p = await conn._rpc('prompts/list', {}, INIT_TIMEOUT_MS);
      conn.prompts = Array.isArray(p?.prompts) ? p.prompts : [];
    } catch (e) { conn.log(`[mcp:${conn.name}] prompts/list failed: ${e.message}`); }
  }
}

class McpServerConnection {
  constructor(name, config, log) {
    this.name = name;
    this.config = config;
    this.log = log || (() => {});
    this.proc = null;
    this.tools = [];          // raw tool defs from tools/list
    this.resources = [];      // raw resource defs from resources/list
    this.prompts = [];        // raw prompt defs from prompts/list
    this.capabilities = {};   // what the server declared at initialize
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

    const init = await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'navy-coder', version: EXTENSION_VERSION },
    }, INIT_TIMEOUT_MS);
    this.capabilities = init?.capabilities || {};
    this._notify('notifications/initialized', {});
    const res = await this._request('tools/list', {}, INIT_TIMEOUT_MS);
    this.tools = Array.isArray(res?.tools) ? res.tools : [];
    // Ready BEFORE the extras: they are optional, and a server whose
    // resources/list hangs must still be usable for the tools it already
    // reported.
    this.ready = true;
    await discoverExtras(this);
    return this.tools;
  }

  // One request shape both transports answer to, so discoverExtras and the
  // reads below are written once instead of once per transport.
  _rpc(method, params, timeoutMs) { return this._request(method, params, timeoutMs); }

  async callTool(toolName, args) {
    if (!this.ready) throw new Error(`MCP server "${this.name}" is not running`);
    const res = await this._request('tools/call', { name: toolName, arguments: args || {} }, CALL_TIMEOUT_MS);
    return formatToolResult(res);
  }

  async readResource(uri) {
    if (!this.ready) throw new Error(`MCP server "${this.name}" is not running`);
    return formatResourceRead(await this._rpc('resources/read', { uri }, CALL_TIMEOUT_MS), uri);
  }

  async getPrompt(name, args) {
    if (!this.ready) throw new Error(`MCP server "${this.name}" is not running`);
    return formatPromptMessages(await this._rpc('prompts/get', { name, arguments: args || {} }, CALL_TIMEOUT_MS));
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
    this.resources = [];
    this.prompts = [];
    this.capabilities = {};
    this.ready = false;
    this.sessionId = null;
    this._nextId = 1;
  }

  async start() {
    if (!this.url) throw new Error('mcpServers.' + this.name + ' is missing "url"');
    const init = await this._send({ jsonrpc: '2.0', id: this._nextId++, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'navy-coder', version: EXTENSION_VERSION } } },
      INIT_TIMEOUT_MS, true);
    this.capabilities = init?.capabilities || {};
    await this._send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, INIT_TIMEOUT_MS, false);
    const listResult = await this._send({ jsonrpc: '2.0', id: this._nextId++, method: 'tools/list', params: {} }, INIT_TIMEOUT_MS, true);
    this.tools = Array.isArray(listResult?.tools) ? listResult.tools : [];
    this.ready = true;
    await discoverExtras(this);
    return this.tools;
  }

  _rpc(method, params, timeoutMs) {
    return this._send({ jsonrpc: '2.0', id: this._nextId++, method, params: params || {} }, timeoutMs, true);
  }

  async readResource(uri) {
    if (!this.ready) throw new Error(`MCP server "${this.name}" is not running`);
    return formatResourceRead(await this._rpc('resources/read', { uri }, CALL_TIMEOUT_MS), uri);
  }

  async getPrompt(name, args) {
    if (!this.ready) throw new Error(`MCP server "${this.name}" is not running`);
    return formatPromptMessages(await this._rpc('prompts/get', { name, arguments: args || {} }, CALL_TIMEOUT_MS));
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

  // OpenAI-style tool defs for every connected server's tools, plus the two
  // resource tools when there is anything to point them at.
  getToolsApi() {
    const out = [];
    if (this.hasResources()) out.push(...MCP_RESOURCE_TOOLS);
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

  // Every connected server's resources, flattened and qualified by server.
  // Resources are DATA, not actions: a server can expose hundreds, and one tool
  // schema each would cost more context than most of them are worth. So they
  // are reached through two tools rather than becoming tools.
  listResources() {
    const out = [];
    for (const [server, conn] of this.servers) {
      for (const r of conn.resources || []) {
        if (!r?.uri) continue;
        out.push({ server, uri: r.uri, name: r.name || r.uri, description: r.description || '', mimeType: r.mimeType || '' });
      }
    }
    return out;
  }

  hasResources() { return this.listResources().length > 0; }

  // Routed by URI rather than by server name: a URI is already unique, and
  // making the model carry the server name too would be a second thing for it
  // to get wrong for no benefit.
  async readResource(uri) {
    if (!uri) return 'Error: a resource uri is required.';
    for (const [, conn] of this.servers) {
      if ((conn.resources || []).some(r => r.uri === uri)) {
        try { return await conn.readResource(uri); }
        catch (e) { return `MCP resource read failed: ${e.message}`; }
      }
    }
    // Not in any list — try every server that has resources at all before
    // giving up. Lists can be stale (a server may add resources after connect,
    // and notifications are out of scope), so refusing on the list alone would
    // make a legitimate URI unreachable.
    for (const [, conn] of this.servers) {
      if (!(conn.resources || []).length) continue;
      try { return await conn.readResource(uri); } catch { /* try the next one */ }
    }
    return `Error: no connected MCP server has a resource "${uri}". Call list_mcp_resources to see what is available.`;
  }

  // Prompts are templates a PERSON invokes, so they surface as slash commands
  // rather than as tools — see SLASH_COMMAND_METHODS in src/slash-commands.js.
  listPrompts() {
    const out = [];
    for (const [server, conn] of this.servers) {
      for (const p of conn.prompts || []) {
        if (!p?.name) continue;
        out.push({
          server,
          name: p.name,
          command: `mcp:${server}:${p.name}`,
          description: p.description || `${p.name} (from ${server})`,
          arguments: Array.isArray(p.arguments) ? p.arguments : [],
        });
      }
    }
    return out;
  }

  async getPrompt(server, name, args) {
    const conn = this.servers.get(server);
    if (!conn) return `Error: MCP server "${server}" is not connected.`;
    try {
      const text = await conn.getPrompt(name, args);
      return text || `Error: MCP prompt "${name}" returned no text.`;
    } catch (e) { return `MCP prompt failed: ${e.message}`; }
  }

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
