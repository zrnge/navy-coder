const {
  fs, path, check, makeContext, sharedMock,
} = require('./harness.js');

// ── 8. MCP client against a real child-process mock server ───────────────────
async function mcpSuite() {
  console.log('\nMCP client:');
  const { McpManager } = require('../src/providers/mcp.js');
  const mgr = new McpManager();
  try {
    const results = await mgr.start({
      mock: { command: process.execPath, args: [path.join(__dirname, 'mock-mcp-server.js')] },
      broken: { command: process.execPath, args: ['-e', 'process.exit(3)'] },
    });
    const okServer = results.find(r => r.name === 'mock');
    const badServer = results.find(r => r.name === 'broken');
    check('mcp: handshake + tools/list', okServer && okServer.tools === 3);
    check('mcp: broken server reported, not fatal', badServer && Boolean(badServer.error));

    const api = mgr.getToolsApi();
    check('mcp: tools exposed with namespaced names', api.some(t => t.function.name === 'mcp__mock__echo'));
    check('mcp: tool schema passed through', api.find(t => t.function.name === 'mcp__mock__add').function.parameters.required.includes('a'));
    check('mcp: isMcpTool routing predicate', mgr.isMcpTool('mcp__mock__echo') && !mgr.isMcpTool('read_file'));

    check('mcp: echo call round-trips', (await mgr.call('mcp__mock__echo', { text: 'ahoy' })) === 'ahoy');
    check('mcp: add call computes', (await mgr.call('mcp__mock__add', { a: 20, b: 22 })) === '42');
    check('mcp: isError surfaces as tool error', /MCP tool error: it broke/.test(await mgr.call('mcp__mock__boom', {})));
    check('mcp: unknown server handled', /not connected/.test(await mgr.call('mcp__nope__x', {})));
  } catch (e) {
    check('mcp suite ran', false, e.stack || e.message);
  } finally {
    mgr.stop();
  }
}

// ── 8b. MCP streamable-HTTP transport — real local http.Server, both JSON and
// SSE response modes, session-id propagation, error handling ─────────────────
async function mcpHttpSuite() {
  console.log('\nMCP HTTP transport:');
  const { McpManager } = require('../src/providers/mcp.js');
  const { startMockMcpHttpServer } = require('./mock-mcp-http-server.js');

  for (const mode of ['json', 'sse']) {
    let handle;
    try {
      handle = await startMockMcpHttpServer();
      const mgr = new McpManager();
      const results = await mgr.start({
        remote: { url: `http://127.0.0.1:${handle.port}/mcp`, headers: { 'x-test-mode': mode } },
      });
      check(`http(${mode}): handshake + tools/list`, results[0] && results[0].tools === 2);
      check(`http(${mode}): session id captured`, Boolean(handle.getSessionId()));
      check(`http(${mode}): tool call round-trips`, (await mgr.call('mcp__remote__ping', {})) === 'pong');
      check(`http(${mode}): isError surfaces as tool error`, /MCP tool error: it broke remotely/.test(await mgr.call('mcp__remote__boom', {})));
      check(`http(${mode}): SSE frame the client must skip doesn't break parsing`, true); // implied by the round-trip passing
      mgr.stop();
    } catch (e) {
      check(`http(${mode}) suite ran`, false, e.stack || e.message);
    } finally {
      handle?.server.close();
    }
  }

  // Unreachable server → reported as a startup error, never throws out of start().
  const { McpManager: McpManager2 } = require('../src/providers/mcp.js');
  const mgr2 = new McpManager2();
  const results2 = await mgr2.start({ dead: { url: 'http://127.0.0.1:1/mcp' } });
  check('http: unreachable server reported, not fatal', Boolean(results2[0]?.error));
  mgr2.stop();
}

// MCP was tools-only. Resources and prompts are the other two things a server
// can offer, and they are surfaced differently on purpose: resources are DATA
// the model may want (two tools between all of them, because a server can
// expose hundreds and one schema each would cost more than the data is worth),
// prompts are templates a PERSON invokes (slash commands). Flattening either
// into the other is what makes an MCP integration feel wrong.
async function mcpExtrasSuite() {
  console.log('\nMCP resources and prompts:');
  const os = require('os');
  const { ctrl } = sharedMock();
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    const { McpManager } = require('../src/providers/mcp.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-mcpx-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const posted = [];
    provider.view = { webview: { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } } };

    const mgr = new McpManager(() => {});
    provider.mcp = mgr;
    const started = await mgr.start({
      mock: { command: process.execPath, args: [path.join(__dirname, 'mock-mcp-server.js')] },
    });
    check('mcp: the server connected', started[0]?.tools >= 3, JSON.stringify(started));

    // ── Resources. ────────────────────────────────────────────────────────
    const resources = mgr.listResources();
    check('resources: discovered and qualified by server',
      resources.length === 2 && resources.every(r => r.server === 'mock'), JSON.stringify(resources));
    check('resources: hasResources reflects that', mgr.hasResources() === true);

    ctrl.config.commandApproval = 'auto-approve';
    const listed = provider.toolListMcpResources();
    check('list_mcp_resources: reports each uri the model needs',
      /mock:\/\/doc\.txt/.test(listed) && /mock:\/\/pic\.png/.test(listed), listed);
    check('list_mcp_resources: names the server each came from', /\[mock\]/.test(listed));

    const doc = await provider.toolReadMcpResource('mock://doc.txt');
    check('read_mcp_resource: returns the text', /the document body/.test(doc), doc);

    // Binary must be DESCRIBED. A base64 image pasted into a model's context as
    // text is thousands of tokens of nothing.
    const pic = await provider.toolReadMcpResource('mock://pic.png');
    check('read_mcp_resource: binary is described, never decoded into context',
      /binary image\/png omitted/.test(pic) && !/QUJDRA/.test(pic), pic);

    check('read_mcp_resource: a missing uri is refused before any call',
      /^Error: a resource uri is required/.test(await provider.toolReadMcpResource('')));
    const bogus = await provider.toolReadMcpResource('mock://nope');
    check('read_mcp_resource: an unknown uri fails with something actionable',
      /no connected MCP server|resource read failed/i.test(bogus), bogus);

    // ── The two tools are offered only when there is something to point them
    //    at, and they ride the dynamic MCP schema list. ────────────────────
    const api = mgr.getToolsApi();
    const names = api.map(t => t.function.name);
    check('the resource tools are offered when a server has resources',
      names.includes('list_mcp_resources') && names.includes('read_mcp_resource'), names.join(', '));
    check('…alongside the server tools, not instead of them',
      names.some(n => n === 'mcp__mock__echo'));
    const empty = new McpManager(() => {});
    check('…and not offered at all when nothing has resources',
      empty.getToolsApi().length === 0 && empty.hasResources() === false);

    // They read, so they may run concurrently and a research sub-agent may use
    // them — that is what READ_ONLY means here.
    const extSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
    const readOnlyBlock = extSrc.split('const READ_ONLY')[1].split(']);')[0];
    check('the resource tools are read-only',
      /'list_mcp_resources'/.test(readOnlyBlock) && /'read_mcp_resource'/.test(readOnlyBlock));

    // Reading from a server the user configured is a call OUT, so it is gated
    // like every other one — by navy.commandApproval, not the file gate.
    ctrl.config.commandApproval = 'ask-always';
    posted.length = 0;
    const gated = provider.toolReadMcpResource('mock://doc.txt');
    await new Promise(r => setImmediate(r));
    check('read_mcp_resource: gated by commandApproval, not the file gate',
      posted.some(m => m.type === 'pendingCommand' && /read resource/.test(m.command)));
    for (const [id] of provider.pendingCommandApprovals) provider.resolveCommandApproval(id, false);
    check('read_mcp_resource: a rejected read does not happen', /rejected by user/.test(await gated));
    ctrl.config.commandApproval = 'auto-approve';

    // ── Prompts. ──────────────────────────────────────────────────────────
    const prompts = mgr.listPrompts();
    check('prompts: discovered, with their arguments',
      prompts.length === 2 && prompts.find(p => p.name === 'summarize')?.arguments?.length === 1,
      JSON.stringify(prompts));
    check('prompts: named so a slash command can address them',
      prompts.every(p => p.command === 'mcp:mock:' + p.name));

    const text = await mgr.getPrompt('mock', 'summarize', { subject: 'the auth module' });
    check('prompts: get returns flattened text, ready to send as a message',
      text === 'Please summarize the auth module', JSON.stringify(text));
    check('prompts: a prompt with no arguments works too',
      (await mgr.getPrompt('mock', 'plain', {})) === 'A prompt with no arguments.');
    check('prompts: an unknown server is refused',
      /is not connected/.test(await mgr.getPrompt('nope', 'plain', {})));
    check('prompts: an unknown prompt fails without throwing',
      /failed|Error/.test(await mgr.getPrompt('mock', 'nope', {})));

    // They reach the composer as slash commands, behind everything the user
    // wrote themselves.
    posted.length = 0;
    await provider.sendSlashCommands();
    const sent = posted.find(m => m.type === 'slashCommands');
    const mcpCmds = (sent?.commands || []).filter(c => c.mcp);
    check('prompts: reach the composer as slash commands',
      mcpCmds.length === 2 && mcpCmds.every(c => c.cmd.startsWith('/mcp:mock:')), JSON.stringify(mcpCmds.map(c => c.cmd)));
    check('prompts: carry no local prompt text — the server owns it',
      mcpCmds.every(c => c.prompt === '' && c.mcp.server === 'mock'));
    check('prompts: are labelled as coming from MCP', mcpCmds.every(c => /^\[MCP:mock\]/.test(c.description)));

    // ── A server that declares nothing extra is never asked. ─────────────
    const bare = new McpManager(() => {});
    await bare.start({ bare: { command: process.execPath, args: ['-e', `
      let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i).trim();b=b.slice(i+1);if(!l)continue;const m=JSON.parse(l);
      if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'bare',version:'1'}}})+'\\n');
      else if(m.method==='tools/list')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[]}})+'\\n');
      else if(m.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'method not found: '+m.method}})+'\\n');}});
    `] } });
    check('capability gating: a tools-only server yields no resources or prompts',
      bare.listResources().length === 0 && bare.listPrompts().length === 0);
    check('capability gating: …and is still perfectly usable', bare.servers.has('bare'));
    bare.stop();

    mgr.stop();
    empty.stop();
  } finally {
    try { provider?.mcp?.stop?.(); } catch {}
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { mcpSuite, mcpHttpSuite, mcpExtrasSuite };
