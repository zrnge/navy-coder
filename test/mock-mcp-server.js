// Tiny MCP server used by the test suite: newline-delimited JSON-RPC over stdio.
// Implements initialize / tools/list / tools/call with three tools:
//   echo(text)  → returns the text
//   add(a, b)   → returns a+b
//   boom()      → returns an isError result
// …plus resources and prompts, both declared at initialize so the client's
// capability gating is exercised rather than bypassed:
//   resources: mock://doc.txt (text), mock://pic.png (binary)
//   prompts:   summarize(subject), plain (no arguments)
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function handle(msg) {
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'mock-mcp', version: '1.0.0' },
    });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, {
      tools: [
        { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
        { name: 'boom', description: 'Always errors', inputSchema: { type: 'object', properties: {} } },
      ],
    });
  } else if (msg.method === 'resources/list') {
    reply(msg.id, {
      resources: [
        { uri: 'mock://doc.txt', name: 'A document', description: 'Some text', mimeType: 'text/plain' },
        { uri: 'mock://pic.png', name: 'A picture', mimeType: 'image/png' },
      ],
    });
  } else if (msg.method === 'resources/read') {
    const uri = msg.params?.uri;
    if (uri === 'mock://doc.txt') {
      reply(msg.id, { contents: [{ uri, mimeType: 'text/plain', text: 'the document body' }] });
    } else if (uri === 'mock://pic.png') {
      // Binary must be described, not decoded into the model's context.
      reply(msg.id, { contents: [{ uri, mimeType: 'image/png', blob: 'QUJDRA=='.repeat(10) }] });
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'no such resource: ' + uri } }) + '\n');
    }
  } else if (msg.method === 'prompts/list') {
    reply(msg.id, {
      prompts: [
        { name: 'summarize', description: 'Summarize a subject', arguments: [{ name: 'subject', required: true }] },
        { name: 'plain', description: 'No arguments at all', arguments: [] },
      ],
    });
  } else if (msg.method === 'prompts/get') {
    const { name, arguments: pargs = {} } = msg.params || {};
    if (name === 'summarize') {
      reply(msg.id, {
        description: 'Summarize a subject',
        messages: [{ role: 'user', content: { type: 'text', text: 'Please summarize ' + (pargs.subject || '(nothing)') } }],
      });
    } else if (name === 'plain') {
      reply(msg.id, { messages: [{ role: 'user', content: { type: 'text', text: 'A prompt with no arguments.' } }] });
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'no such prompt: ' + name } }) + '\n');
    }
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params;
    if (name === 'echo') reply(msg.id, { content: [{ type: 'text', text: String(args.text) }] });
    else if (name === 'add') reply(msg.id, { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] });
    else if (name === 'boom') reply(msg.id, { isError: true, content: [{ type: 'text', text: 'it broke' }] });
    else reply(msg.id, { isError: true, content: [{ type: 'text', text: 'unknown tool ' + name }] });
  }
  // notifications (no id) are ignored
}
