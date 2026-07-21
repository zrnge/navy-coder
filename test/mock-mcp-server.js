// Tiny MCP server used by the test suite: newline-delimited JSON-RPC over stdio.
// Implements initialize / tools/list / tools/call with two tools:
//   echo(text)  → returns the text
//   add(a, b)   → returns a+b
//   boom()      → returns an isError result
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
      capabilities: { tools: {} },
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
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params;
    if (name === 'echo') reply(msg.id, { content: [{ type: 'text', text: String(args.text) }] });
    else if (name === 'add') reply(msg.id, { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] });
    else if (name === 'boom') reply(msg.id, { isError: true, content: [{ type: 'text', text: 'it broke' }] });
    else reply(msg.id, { isError: true, content: [{ type: 'text', text: 'unknown tool ' + name }] });
  }
  // notifications (no id) are ignored
}
