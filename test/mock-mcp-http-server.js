// Minimal streamable-HTTP MCP server for tests — real http.Server, not a fetch
// mock, so the client's actual request/response parsing is exercised end-to-end.
// Response format (JSON vs SSE) is chosen per-request via the `x-test-mode`
// header so both McpHttpConnection code paths get real coverage.
const http = require('http');

function startMockMcpHttpServer() {
  let sessionId = null;
  const server = http.createServer((req, res) => {
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
      const mode = req.headers['x-test-mode'] || 'json';

      const respond = (result, error) => {
        const payload = { jsonrpc: '2.0', id: msg.id, ...(error ? { error } : { result }) };
        if (msg.method === 'initialize' && !sessionId) sessionId = 'sess-' + Math.random().toString(16).slice(2, 10);
        const headers = {};
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;
        if (mode === 'sse') {
          res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream' });
          // An interleaved progress-style message the client must skip, then the
          // real matching response — proves it scans past unrelated SSE frames.
          res.write('data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }) + '\n\n');
          res.write('data: ' + JSON.stringify(payload) + '\n\n');
          res.end();
        } else {
          res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        }
      };

      if (msg.method === 'initialize') {
        respond({ protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'mock-http-mcp', version: '1.0.0' } });
      } else if (msg.method === 'notifications/initialized') {
        res.writeHead(202); res.end(); // notification — no JSON-RPC response body
      } else if (msg.method === 'tools/list') {
        respond({ tools: [
          { name: 'ping', description: 'Replies pong', inputSchema: { type: 'object', properties: {} } },
          { name: 'boom', description: 'Always errors', inputSchema: { type: 'object', properties: {} } },
        ] });
      } else if (msg.method === 'tools/call') {
        const { name } = msg.params;
        if (name === 'ping') respond({ content: [{ type: 'text', text: 'pong' }] });
        else if (name === 'boom') respond({ isError: true, content: [{ type: 'text', text: 'it broke remotely' }] });
        else respond({ isError: true, content: [{ type: 'text', text: 'unknown tool' }] });
      } else {
        respond(undefined, { code: -32601, message: 'method not found' });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, getSessionId: () => sessionId }));
  });
}

module.exports = { startMockMcpHttpServer };
