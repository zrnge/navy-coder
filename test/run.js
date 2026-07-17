// Navy Coder test suite — run with `npm test`.
// No framework: each section asserts and pushes failures; exit 1 if any fail.
//
// Pure functions (literalReplace, _compactMessages, renderInline) are extracted
// from the real source files by pattern so tests can never drift from shipped code.
// The webview suite drives media/main.js inside jsdom with real extension messages.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const failures = [];
let passed = 0;

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failures.push(name); console.error('  FAIL', name, detail !== undefined ? '— ' + detail : ''); }
}

function extractFunction(source, header) {
  // Matches `header` up to the function's closing brace at the same indent level.
  // Naive brace counting — fine for functions whose brace-char-literals balance;
  // functions that don't (e.g. stripToolCallJson) are tested via the jsdom window.
  const start = source.indexOf(header);
  if (start === -1) throw new Error('cannot find: ' + header);
  let depth = 0, i = source.indexOf('{', start);
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces for: ' + header);
}

const extSrc  = fs.readFileSync(path.join(ROOT, 'src', 'extension.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'media', 'main.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'webview-html.js'), 'utf8');

// ── 1. literalReplace ────────────────────────────────────────────────────────
console.log('\nliteralReplace:');
{
  const literalReplace = eval('(' + extractFunction(extSrc, 'function literalReplace') + ')');
  check('exact match', literalReplace('abc def', 'def', 'xyz') === 'abc xyz');
  check('CRLF file + LF search preserves CRLF',
    literalReplace('a\r\nb\r\nc', 'a\nb', 'A\nB') === 'A\r\nB\r\nc');
  check('LF file + CRLF search stays LF',
    literalReplace('a\nb\nc', 'a\r\nb', 'A\r\nB') === 'A\nB\nc');
  check('fuzzy indentation match',
    literalReplace('  foo();\n  bar();', 'foo();\nbar();', 'baz();') === 'baz();');
  check('ambiguous returns Error', literalReplace('x x', 'x', 'y') instanceof Error);
  check('not found returns null', literalReplace('abc', 'zzz', 'y') === null);
  check('fuzzy on CRLF preserves CRLF',
    literalReplace('  a();\r\n  b();', 'a();\nb();', 'c();') === 'c();');
}

// ── 2. _compactMessages ──────────────────────────────────────────────────────
console.log('\ncompactMessages:');
{
  // Header includes the brace so we match the DEFINITION, not a call site.
  const body = extractFunction(extSrc, '_compactMessages(messages) {');
  const compact = eval('(function ' + body + ')');
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: 't' + i }] });
    msgs.push({ role: 'tool', tool_call_id: 't' + i, content: 'X'.repeat(30000) });
  }
  compact(msgs);
  const intact = msgs.filter(m => m.role === 'tool' && m.content.length === 30000).length;
  const total = msgs.reduce((a, m) => a + (typeof m.content === 'string' ? m.content.length : 0), 0);
  check('keeps at least 6 recent tool results', intact >= 6, intact);
  check('total under budget', total <= 240000, total);
  check('tool_call_id pairing preserved', msgs.every(m => m.role !== 'tool' || m.tool_call_id));

  const vision = [
    { role: 'user', content: [{ type: 'text', text: 'img1' }, { type: 'image_url', image_url: { url: 'data:x,' + 'A'.repeat(300000) } }] },
    { role: 'user', content: [{ type: 'text', text: 'img2' }, { type: 'image_url', image_url: { url: 'data:x,' + 'B'.repeat(300000) } }] },
  ];
  compact(vision);
  check('old image stripped to text', typeof vision[0].content === 'string' && vision[0].content.startsWith('img1'));
  check('latest image kept', Array.isArray(vision[1].content));

  const small = [{ role: 'user', content: 'hi' }, { role: 'tool', tool_call_id: 'a', content: 'Y'.repeat(500) }];
  compact(small);
  check('small conversation untouched', small[1].content.length === 500);
}

// ── 3. renderInline (webview markdown) ───────────────────────────────────────
console.log('\nrenderInline:');
{
  const escapeHtml = eval('(' + extractFunction(mainSrc, 'function escapeHtml') + ')');
  const src = extractFunction(mainSrc, 'function renderInline');
  const renderInline = eval('(' + src + ')');
  check('code spans protected from italics',
    renderInline('`my_var_name`') === '<code>my_var_name</code>');
  check('asterisks in code untouched',
    renderInline('`*args*`') === '<code>*args*</code>');
  check('bold works', renderInline('**b**') === '<strong>b</strong>');
  check('plain C3 text not treated as placeholder', renderInline('press C3 now') === 'press C3 now');
  check('unsafe link neutralized', renderInline('[x](javascript:alert(1))').includes('href="#"'));
  check('html escaped', renderInline('<script>') === '&lt;script&gt;');
}

// ── 3b. isToolCallJson (hides raw tool-call JSON small models emit as text) ───
console.log('\ntool-call JSON detection:');
{
  const isToolCallJson = eval('(' + extractFunction(mainSrc, 'function isToolCallJson') + ')');
  check('detects bare tool-call JSON', isToolCallJson('{"name":"web_search","arguments":{"query":"hey"}}'));
  check('detects tool/parameters shape', isToolCallJson('{"tool":"read_file","parameters":{"path":"a.js"}}'));
  check('ignores ordinary JSON without args', !isToolCallJson('{"name":"Ada","age":3}'));
  check('ignores prose', !isToolCallJson('Here is your answer.'));
  check('ignores non-object', !isToolCallJson('[1,2,3]'));
  // stripToolCallJson (unbalanced brace-char-literals) is verified in the DOM suite.
}

// ── 4. Webview DOM (jsdom) ───────────────────────────────────────────────────
console.log('\nwebview DOM:');
{
  const { JSDOM } = require('jsdom');
  const bodyMatch = htmlSrc.match(/<body>([\s\S]*?)<\/body>/); // now lives in webview-html.js
  const body = bodyMatch[1].replace(/\$\{[^}]*\}/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${body}</body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => ({}), setState: () => {} });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.eval(mainSrc);
  const send = (data) => window.dispatchEvent(new window.MessageEvent('message', { data }));
  const $ = (sel) => window.document.querySelector(sel);

  send({ type: 'sessionLoaded', count: 0, memory: '', projectRoot: 'e:/p' });
  send({ type: 'start', model: 'm', activeFile: '', activeLanguage: '' });
  send({ type: 'heartbeat' });                       // must be a no-op
  send({ type: 'toolCall', tool: 'run_command', args: { command: 'echo hi' } });
  send({ type: 'shellChunk', chunk: 'hi\n' });
  send({ type: 'toolResult', tool: 'run_command', result: 'Exit code: 0\nstdout:\nhi\nstderr:\n' });
  send({ type: 'toolCall', tool: 'apply_edit', args: { path: 'a.js' } });
  send({ type: 'pendingDiff', id: 'd1', path: 'a.js', oldText: '1\n2\n3', newText: '1\nTWO\n3' });
  send({ type: 'diffResolved', id: 'd1', approved: true });
  send({ type: 'toolResult', tool: 'apply_edit', result: 'Applied to a.js' });
  send({ type: 'chunk', text: '<think>secret reasoning</think>Done.' });
  send({ type: 'done' });

  const term = $('.term-card');
  check('terminal card created', Boolean(term));
  check('terminal IN shows command', term && term.querySelector('.term-in').textContent === 'echo hi');
  check('terminal OUT received chunk', term && term.querySelector('.term-out').textContent.includes('hi'));
  check('terminal status exit 0', term && term.querySelector('.term-status').textContent === 'exit 0');

  const card = $('.diff-card.is-approved');
  check('diff card resolved approved', Boolean(card));
  check('diff card keeps preview body', card && Boolean(card.querySelector('.diff-body.preview')));
  check('diff card has expand button', card && Boolean(card.querySelector('.diff-expand-btn')));
  check('changed line visible in preview', card && card.textContent.includes('TWO'));

  const bubble = $('.message.assistant .message-bubble');
  const thinkBlock = bubble && bubble.querySelector('.think-block');
  check('reasoning tucked into a collapsed block', Boolean(thinkBlock) && !thinkBlock.hasAttribute('open'));
  check('answer text rendered', bubble && bubble.textContent.includes('Done.'));
  check('redo button exists and starts disabled', $('#redoButton') && $('#redoButton').disabled === true);
  send({ type: 'redoState', count: 1 });
  check('redo button enables on redoState', $('#redoButton').disabled === false);
  check('welcome hidden during conversation', $('#welcome').classList.contains('hidden'));

  // Small-model tool-call JSON leak (qwen-coder): a turn whose whole reply is
  // several concatenated tool-call JSON objects must render NO assistant bubble.
  const before = window.document.querySelectorAll('.message.assistant').length;
  send({ type: 'start', model: 'm', activeFile: '', activeLanguage: '' });
  send({ type: 'chunk', text: '{\n"name": "web_search",\n"arguments": {\n"query": "hey"\n}\n}{"name": "websearch", "arguments": {"query": "hey", "maxResults": 5}}{\n"name": "finish",\n"arguments": {}\n}' });
  send({ type: 'done' });
  const after = window.document.querySelectorAll('.message.assistant').length;
  check('concatenated tool-call JSON renders no bubble', after === before);
  // The pure stripper, pulled off the executed webview window:
  const strip = window.stripToolCallJson;
  check('stripToolCallJson present on window', typeof strip === 'function');
  if (typeof strip === 'function') {
    check('strips concatenated tool calls to empty',
      strip('{"name":"web_search","arguments":{"query":"x"}}{"name":"finish","arguments":{}}').trim() === '');
    check('keeps prose around tool calls',
      strip('Sure! {"name":"web_search","arguments":{"query":"x"}} ok').replace(/\s+/g, ' ').trim() === 'Sure! ok');
    check('leaves ordinary text untouched', strip('normal reply') === 'normal reply');
  }

  // Stop button icon swap — the hidden ATTRIBUTE is what the CSS targets
  // (SVGElement has no `hidden` property, and svg[hidden] needs the attr).
  send({ type: 'start', model: 'm', activeFile: '', activeLanguage: '' });
  check('busy: send icon hidden', $('#sendIcon').hasAttribute('hidden'));
  check('busy: stop icon visible', !$('#stopIcon').hasAttribute('hidden'));
  check('busy: button in stop-mode', $('#sendButton').classList.contains('stop-mode'));
  send({ type: 'done' });
  check('idle: send icon restored', !$('#sendIcon').hasAttribute('hidden'));
  check('idle: stop icon hidden again', $('#stopIcon').hasAttribute('hidden'));
  check('idle: stop-mode removed', !$('#sendButton').classList.contains('stop-mode'));
}

// ── 5. Undo/Redo & checkpoints (real provider, mock vscode, real temp fs) ────
// Drives the shipped NavyCoderViewProvider against genuine files so the
// One shared mock, installed once. extension.js captures require('vscode') at
// module load, so every suite MUST use the same mock instance it captured.
const { createVscodeMock, installVscodeMock, uninstallVscodeMock, makeContext } = require('./vscode-mock.js');
let _shared = null;
function sharedMock() {
  if (!_shared) { _shared = createVscodeMock(); installVscodeMock(_shared.vscode); }
  _shared.ctrl.reset();
  return _shared;
}

// fs-coupled undo/redo/checkpoint logic is exercised end-to-end.
async function undoRedoSuite() {
  console.log('\nundo/redo (real fs):');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-undo-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    const P = (name) => path.join(tmp, name);
    const read = (name) => { try { return fs.readFileSync(P(name), 'utf8'); } catch { return null; } };
    const write = (name, txt) => fs.writeFileSync(P(name), txt);

    // A) multi-edit turn: undo must reach turn-START, no spurious warning
    write('a.txt', 'v0');
    provider.currentTurnId = 't1';
    ctrl.reset();
    await provider.toolWriteFile('a.txt', 'v1');
    await provider.toolWriteFile('a.txt', 'v2');
    await provider.toolWriteFile('a.txt', 'v3');
    check('multi-edit: disk at final state', read('a.txt') === 'v3');
    await provider.undoLastTurn();
    check('multi-edit: undo reaches turn-start (Bug 1)', read('a.txt') === 'v0');
    check('multi-edit: no spurious modified warning (Bug 5)', ctrl.shown.warning.length === 0);
    await provider.redoLast();
    check('multi-edit: redo restores final state', read('a.txt') === 'v3');

    // B) hand-edit detection: warn, respect cancel, then honor "Undo Anyway"
    write('b.txt', 'orig');
    provider.currentTurnId = 't2';
    await provider.toolWriteFile('b.txt', 'navy');
    write('b.txt', 'user-edited');            // simulate the user editing after Navy
    ctrl.reset(); ctrl.nextWarning = undefined; // user cancels the modal
    await provider.undoLastTurn();
    check('hand-edit: warning shown', ctrl.shown.warning.length === 1);
    check('hand-edit: cancel preserves user content', read('b.txt') === 'user-edited');
    ctrl.nextWarning = 'Undo Anyway';
    await provider.undoLastTurn();
    check('hand-edit: confirm discards to turn-start', read('b.txt') === 'orig');

    // C) rename undo/redo (single-step)
    write('c.txt', 'hi');
    provider.currentTurnId = 't3';
    ctrl.reset();
    await provider.toolRenameFile('c.txt', 'c2.txt');
    check('rename: applied', read('c2.txt') === 'hi' && read('c.txt') === null);
    await provider.undoLastCheckpoint();
    check('rename: undo reverses', read('c.txt') === 'hi' && read('c2.txt') === null);
    await provider.redoLast();
    check('rename: redo reapplies', read('c2.txt') === 'hi' && read('c.txt') === null);

    // D) delete undo/redo (single-step)
    write('d.txt', 'data');
    provider.currentTurnId = 't4';
    ctrl.reset();
    await provider.toolDeleteFile('d.txt');
    check('delete: applied', read('d.txt') === null);
    await provider.undoLastCheckpoint();
    check('delete: undo restores content', read('d.txt') === 'data');
    await provider.redoLast();
    check('delete: redo deletes again', read('d.txt') === null);
  } catch (e) {
    check('undo/redo suite ran', false, e.stack || e.message);
  } finally {
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 6. Retrieval (find_relevant_files) — pure ranking + real temp-repo ───────
async function retrievalSuite() {
  console.log('\nretrieval:');
  const os = require('os');
  const { vscode } = sharedMock();

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-retr-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    // Pure: tokenizer drops filler, splits camelCase, keeps identifiers.
    const terms = provider._tokenizeQuery('please fix the parseUserToken auth bug').map(t => t.term);
    check('tokenize keeps salient identifier', terms.includes('parseusertoken'));
    check('tokenize splits camelCase', terms.includes('parse') && terms.includes('token'));
    check('tokenize drops filler words', !terms.includes('please') && !terms.includes('the') && !terms.includes('bug'));

    // Pure: ranker prefers definer + filename match over raw frequency.
    const ranked = provider._rankRelevance([
      { rel: 'a.js', count: 40, matched: ['auth'], inName: false, defs: false },
      { rel: 'auth.js', count: 3, matched: ['auth'], inName: true, defs: true },
    ], [{ term: 'auth', weight: 2 }]);
    check('ranker: definer+name-match beats raw frequency', ranked[0].rel === 'auth.js');

    // Integration: real files, real walk, real scoring through the tool.
    fs.writeFileSync(path.join(tmp, 'auth.js'), 'function parseUserToken(t){ return verify(t); }\nclass AuthService {}');
    fs.writeFileSync(path.join(tmp, 'ui.js'), 'export function renderButton(){ return "<button>"; }');
    fs.writeFileSync(path.join(tmp, 'notes.md'), 'nothing relevant here about widgets');
    const out = await provider.toolFindRelevantFiles('where is parseUserToken defined for auth', 5);
    const lines = out.split('\n').filter(l => l.includes('.js') || l.includes('.md'));
    check('retrieval ranks the defining file first', lines[0] && lines[0].includes('auth.js'));
    check('retrieval marks the definer', /auth\.js.*defines/.test(out));
    check('retrieval excludes irrelevant files', !out.includes('notes.md'));
    const empty = await provider.toolFindRelevantFiles('zzz', 5);
    check('retrieval handles no-match gracefully', /No files matched|more specific/.test(empty));
  } catch (e) {
    check('retrieval suite ran', false, e.stack || e.message);
  } finally {
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 7. rename_symbol + apply_edit recovery + webview-html module ─────────────
async function robustnessSuite() {
  console.log('\nedit robustness:');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-robust-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const P = (n) => path.join(tmp, n);
    const read = (n) => { try { return fs.readFileSync(P(n), 'utf8'); } catch { return null; } };

    // apply_edit "did you mean": pure closest-region finder
    const region = provider._closestRegion('function foo() {\n  return bar();\n}\n', '  return baz();');
    check('closest-region locates the near-match line', region && region.startLine === 2 && region.text.includes('return bar()'));
    check('closest-region reports a similarity score', region && region.score > 0);
    check('closest-region returns null when nothing is close', provider._closestRegion('a\nb\nc', 'zzzzz qqqqq wwwww') === null);

    // apply_edit surfaces the recovery hint on a miss
    fs.writeFileSync(P('e.js'), 'const x = 1;\nconst y = 2;\n');
    provider.currentTurnId = 'r1';
    const miss = await provider.toolApplyEdit('e.js', 'const y = 99;', 'const y = 3;');
    check('apply_edit miss returns closest-region hint', /Closest matching region/.test(miss) && miss.includes('const y = 2'));

    // rename_symbol: happy path through a fake LSP rename provider
    fs.writeFileSync(P('m.js'), 'function oldName() {}\noldName();\n');
    fs.writeFileSync(P('u.js'), 'import { oldName } from "./m";\noldName();\n');
    provider.currentTurnId = 'r2';
    ctrl.reset();
    ctrl.nextRename = [
      { fsPath: P('m.js'), newText: 'function newName() {}\nnewName();\n' },
      { fsPath: P('u.js'), newText: 'import { newName } from "./m";\nnewName();\n' },
    ];
    const rres = await provider.toolRenameSymbol('m.js', 1, 'oldName', 'newName');
    check('rename_symbol reports files changed', /Renamed "oldName" .* 2 files/.test(rres));
    check('rename_symbol applied across files', read('m.js').includes('newName') && read('u.js').includes('newName'));
    check('rename_symbol is undoable', provider.checkpoints.some(c => c.turnId === 'r2'));
    await provider.undoLastTurn();
    check('rename_symbol undo restores originals', read('m.js').includes('oldName') && read('u.js').includes('oldName'));

    // rename_symbol: no provider → graceful fallback message, no write
    fs.writeFileSync(P('n.js'), 'let q = 1;\n');
    ctrl.reset(); ctrl.nextRename = null;
    const noProv = await provider.toolRenameSymbol('n.js', 1, 'q', 'qq');
    check('rename_symbol falls back when no provider', /could not rename|apply_edit/.test(noProv));
    check('rename_symbol no-provider left file untouched', read('n.js') === 'let q = 1;\n');

    // rename_symbol: symbol not on the given line → clear error
    const badLine = await provider.toolRenameSymbol('n.js', 1, 'notthere', 'x');
    check('rename_symbol errors when symbol absent on line', /not found on line/.test(badLine));

    // rename_symbol containment: LSP wanting to edit OUTSIDE the workspace → refuse, no write
    fs.writeFileSync(P('c.js'), 'let z = 1;\n');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-outside-'));
    const outsideFile = path.join(outsideDir, 'sdk.d.ts');
    fs.writeFileSync(outsideFile, 'export const z: number;\n');
    ctrl.reset();
    ctrl.nextRename = [
      { fsPath: P('c.js'), newText: 'let zz = 1;\n' },
      { fsPath: outsideFile, newText: 'export const zz: number;\n' }, // OUTSIDE root
    ];
    const refused = await provider.toolRenameSymbol('c.js', 1, 'z', 'zz');
    check('rename_symbol refuses edits outside the workspace', /Refused|OUTSIDE the workspace/i.test(refused));
    check('rename_symbol containment left in-project file untouched', read('c.js') === 'let z = 1;\n');
    check('rename_symbol containment left outside file untouched', fs.readFileSync(outsideFile, 'utf8') === 'export const z: number;\n');
    fs.rmSync(outsideDir, { recursive: true, force: true });

    // retrieval cache: second identical scan reuses the first (no re-read)
    fs.writeFileSync(P('svc.js'), 'function loginHandler(){}\n');
    const t1 = provider._tokenizeQuery('where is loginHandler');
    const r1 = await provider._collectRelevance(tmp, t1);
    const cachedRef = provider._relCache && provider._relCache.hits;
    const r2 = await provider._collectRelevance(tmp, provider._tokenizeQuery('where is loginHandler'));
    check('retrieval scan is cached for repeated terms', r2 === cachedRef && r1 === r2);
  } catch (e) {
    check('robustness suite ran', false, e.stack || e.message);
  } finally {
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // Bare-JSON tool-call parsing — small models that don't use the native tool API.
  const { parseToolCalls } = require('../src/providers/llm.js');
  const bare = parseToolCalls('{"name": "web_search", "arguments": {"query": "hey"}}');
  check('parses bare tool-call JSON (small models)', bare.length === 1 && bare[0].name === 'web_search' && bare[0].args.query === 'hey');
  const fenced = parseToolCalls('```json\n{"name":"read_file","arguments":{"path":"a.js"}}\n```');
  check('parses fenced tool-call JSON', fenced.some(c => c.name === 'read_file'));
  const unknown = parseToolCalls('{"name": "not_a_real_tool", "arguments": {}}');
  check('ignores JSON naming an unknown tool', unknown.length === 0);
  const discuss = parseToolCalls('The config is {"name": "app", "version": "1.0"} in package.json');
  check('does not treat discussed JSON as a tool call', discuss.length === 0);

  // webview-html module is pure and self-contained
  const { getWebviewHtml } = require('../src/webview-html.js');
  const html = getWebviewHtml({ scriptUri: 'S', styleUri: 'Y', cspSource: 'C', nonce: 'N', version: '9.9.9' });
  check('webview-html builds a full document', html.includes('<!DOCTYPE html>') && html.includes('</html>'));
  check('webview-html injects nonce + version', html.includes('nonce-N') && html.includes('v9.9.9'));
}

undoRedoSuite()
  .then(retrievalSuite)
  .then(robustnessSuite)
  .then(() => {
    uninstallVscodeMock();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
  });
