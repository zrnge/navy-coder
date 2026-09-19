// A stand-in Ollama server, for tests that run Navy as its own process - the
// `navy` command line - where the in-process fake fetch cannot reach. It
// answers /api/chat from a script, one reply per request, in order, and
// records every request so a test can see exactly what Navy sent.
//
// A reply is { text } for a final answer, or { toolCalls: [{ name, args }] }.

const http = require('http');

function startStubOllama(script = []) {
  const requests = [];
  let next = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* not JSON */ }
      requests.push({ url: req.url, body });
      const json = (value, type = 'application/json') => {
        res.writeHead(200, { 'Content-Type': type });
        res.end(typeof value === 'string' ? value : JSON.stringify(value));
      };
      if (req.url === '/api/tags') return json({ models: [{ name: 'stub', model: 'stub' }] });
      if (req.url === '/api/show') {
        return json({ model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 }, capabilities: ['completion', 'tools', 'vision'] });
      }
      if (req.url === '/api/chat') {
        const reply = script[next++] || { text: 'Nothing more to do.' };
        const message = reply.toolCalls
          ? { role: 'assistant', content: '', tool_calls: reply.toolCalls.map(tc => ({ function: { name: tc.name, arguments: tc.args || {} } })) }
          : { role: 'assistant', content: reply.text };
        return json(JSON.stringify({ model: 'stub', message, done: true, prompt_eval_count: 5, eval_count: 5 }) + '\n', 'application/x-ndjson');
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      requests,
      chats: () => requests.filter(r => r.url === '/api/chat'),
      close: () => new Promise(r => server.close(r)),
    }));
  });
}

module.exports = { startStubOllama };
