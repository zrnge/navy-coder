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

// ── 4. Webview DOM (jsdom) ───────────────────────────────────────────────────
console.log('\nwebview DOM:');
{
  const { JSDOM } = require('jsdom');
  const bodyMatch = extSrc.match(/<body>([\s\S]*?)<\/body>/);
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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
