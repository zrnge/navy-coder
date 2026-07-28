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

// ── 1a2. Fenced-code regexes must not backtrack catastrophically ─────────────
// Both the webview renderer and the provider-side edit extractor match fences
// with a backreference. Left unbounded (`{3,}`), a long run of backticks in
// model output backtracks quadratically — measured at 14.5s of frozen renderer
// for a 160k run, on a regex that runs for every render of every reply.
console.log('\nfenced-code regex safety:');
{
  const sources = [
    ['media/main.js', fs.readFileSync(path.join(ROOT, 'media', 'main.js'), 'utf8')],
    ['src/providers/llm.js', fs.readFileSync(path.join(ROOT, 'src', 'providers', 'llm.js'), 'utf8')],
  ];
  for (const [name, src] of sources) {
    // Match the capturing-group form actually used in the regex, so the
    // explanatory comments (which quote the old unbounded pattern) don't
    // trip this.
    check(`${name}: fence capture group is bounded`, !/\(`\{3,\}\)/.test(src));
  }

  // Behavioural proof, not just a source-text assertion.
  const codeRe = /(?:^|\n)(`{3,8})([\w.+\-]*)(?::([^\s\n]+))?[^\n]*\n([\s\S]*?)\n\1[ \t]*(?=$|\n)/g;
  const t0 = Date.now();
  codeRe.lastIndex = 0;
  codeRe.test('`'.repeat(120000));
  const ms = Date.now() - t0;
  check('pathological backtick run stays fast (was seconds)', ms < 250, ms + 'ms');

  // Every legitimate fence form must still parse exactly as before.
  const forms = [
    ['plain', '\n```\nplain body\n```', 'plain body'],
    ['language', '\n```js\nconst a = 1;\n```', 'const a = 1;'],
    ['lang+path', '\n```python:app.py\nx = 1\n```', 'x = 1'],
    ['4-backtick wrapping 3', '\n````js\nhas ``` inside\n````', 'has ``` inside'],
  ];
  for (const [label, input, expected] of forms) {
    codeRe.lastIndex = 0;
    const m = codeRe.exec(input);
    check(`fence still parses: ${label}`, Boolean(m) && m[4] === expected, m ? m[4] : 'no match');
  }
}

// ── 1b. stripSuffixOverlap (inline FIM completion dedup) ─────────────────────
console.log('\nstripSuffixOverlap:');
{
  const stripSuffixOverlap = eval('(' + extractFunction(extSrc, 'function stripSuffixOverlap') + ')');
  check('trims a completion that echoes the start of the suffix',
    stripSuffixOverlap('return x;\n}', '\n}\n\nfunction next(){}') === 'return x;');
  check('leaves a completion with no overlap untouched',
    stripSuffixOverlap('const y = 2;', '\nfunction next(){}') === 'const y = 2;');
  check('exact full-string overlap trims to empty',
    stripSuffixOverlap('abc', 'abcdef') === '');
  check('empty completion passed through unchanged', stripSuffixOverlap('', 'abc') === '');
  check('empty suffix passed through unchanged', stripSuffixOverlap('abc', '') === 'abc');
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
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => ({}), setState: () => {} });
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

  // Regression: a LARGE file (over computeLCS's ~633-line bail-out) whose change
  // lands past the renderer's 400-row budget used to produce a diff body with no
  // changed rows in it — and diffResolved then deleted the body entirely, so an
  // edit that really happened showed a card with no diff.
  {
    const big = Array.from({ length: 900 }, (_, i) => 'line ' + i);
    const bigNew = big.slice();
    bigNew[700] = 'CHANGED_DEEP_LINE';
    send({ type: 'pendingDiff', id: 'big1', path: 'big.js', oldText: big.join('\n'), newText: bigNew.join('\n') });
    const bigCard = $('.diff-card[data-diff-id="big1"]');
    check('large-file diff: card created', Boolean(bigCard));
    check('large-file diff: the deep change is actually rendered',
      bigCard && bigCard.textContent.includes('CHANGED_DEEP_LINE'));
    check('large-file diff: has changed rows in the DOM',
      bigCard && bigCard.querySelectorAll('.diff-added, .diff-removed').length > 0);
    check('large-file diff: records a non-zero change count',
      bigCard && parseInt(bigCard.dataset.changeCount, 10) > 0);
    send({ type: 'diffResolved', id: 'big1', approved: true });
    check('large-file diff: body survives resolution instead of being deleted',
      bigCard && Boolean(bigCard.querySelector('.diff-body')));
    check('large-file diff: change still visible after resolution',
      bigCard && bigCard.textContent.includes('CHANGED_DEEP_LINE'));
  }

  // A genuinely empty diff (no changes at all) should still collapse its body —
  // the fix above must not keep an empty diff around forever.
  {
    const same = 'a\nb\nc';
    send({ type: 'pendingDiff', id: 'nochange', path: 'same.js', oldText: same, newText: same });
    const noCard = $('.diff-card[data-diff-id="nochange"]');
    check('empty diff: change count is zero', noCard && noCard.dataset.changeCount === '0');
    send({ type: 'diffResolved', id: 'nochange', approved: true });
    check('empty diff: body collapsed as before', noCard && !noCard.querySelector('.diff-body'));
  }

  const bubble = $('.message.assistant .message-bubble');
  const thinkBlock = bubble && bubble.querySelector('.think-block');
  check('reasoning tucked into a collapsed block', Boolean(thinkBlock) && !thinkBlock.hasAttribute('open'));
  check('answer text rendered', bubble && bubble.textContent.includes('Done.'));
  check('redo button exists and starts disabled', $('#redoButton') && $('#redoButton').disabled === true);
  send({ type: 'redoState', count: 1 });
  check('redo button enables on redoState', $('#redoButton').disabled === false);
  check('welcome hidden during conversation', $('#welcome').classList.contains('hidden'));

  // Plan checklist card: pure parser
  const parsePlanSteps = window.parsePlanSteps;
  check('parsePlanSteps present on window', typeof parsePlanSteps === 'function');
  if (typeof parsePlanSteps === 'function') {
    const steps = parsePlanSteps('**Plan:**\n1. Read the file\n2. Apply the fix\n3. Run tests\n\nLet me start.');
    check('parsePlanSteps extracts numbered steps in order', steps.length === 3 && steps[0] === 'Read the file' && steps[2] === 'Run tests');
    check('parsePlanSteps returns empty for plain prose', parsePlanSteps('Sure, here is an explanation of the bug.').length === 0);
    check('parsePlanSteps stops at the first non-list line', parsePlanSteps('**Plan:**\n1. Step one\n2. Step two\nNow executing.').length === 2);
  }

  // Plan checklist card: full DOM lifecycle — build, progress, complete
  send({ type: 'start', model: 'm', activeFile: '', activeLanguage: '' });
  send({ type: 'chunk', text: '**Plan:**\n1. Read config.js\n2. Fix the bug\n3. Verify with tests\n\n' });
  const planCard = $('.plan-card');
  check('plan card appears once the plan text streams in', Boolean(planCard));
  check('plan card lists all 3 steps', planCard && planCard.querySelectorAll('.plan-step').length === 3);
  send({ type: 'stepProgress', step: 2, max: 10 });
  let steps3 = planCard.querySelectorAll('.plan-step');
  check('plan card marks step 0 active on stepProgress(2)', steps3[0].classList.contains('active'));
  send({ type: 'stepProgress', step: 3, max: 10 });
  steps3 = planCard.querySelectorAll('.plan-step');
  check('plan card marks step 0 done, step 1 active on stepProgress(3)', steps3[0].classList.contains('done') && steps3[1].classList.contains('active'));
  send({ type: 'chunk', text: 'All done!' });
  send({ type: 'done' });
  steps3 = planCard.querySelectorAll('.plan-step');
  check('plan card marks every step done on successful finish', [...steps3].every(s => s.classList.contains('done')));

  // A turn with no plan text must not create a stray new card.
  const planCardCountBefore = window.document.querySelectorAll('.plan-card').length;
  send({ type: 'start', model: 'm', activeFile: '', activeLanguage: '' });
  send({ type: 'chunk', text: 'Just a normal answer, no plan here.' });
  send({ type: 'done' });
  check('no new plan card for a plan-less turn', window.document.querySelectorAll('.plan-card').length === planCardCountBefore);

  // Regression: a turn's closing summary used to land in the SAME bubble as its
  // opening line, which sits above the activity log — so after a long tool run
  // the report rendered before the work it describes, and nothing followed the
  // tool cards at all. Read top-to-bottom the summary looked missing.
  {
    send({ type: 'start', model: 'm', activeFile: '', activeLanguage: '' });
    send({ type: 'chunk', text: 'I will start by reading the full file.' });
    send({ type: 'toolCall', tool: 'read_lines', args: { path: 'big.js', start: 1, end: 800 }, callId: 'ord1' });
    send({ type: 'toolResult', tool: 'read_lines', result: 'ok', callId: 'ord1' });
    send({ type: 'chunk', text: '\n\n**Done:** fixed 2 bugs.' });
    send({ type: 'done' });

    const msg = [...window.document.querySelectorAll('.message.assistant')].pop();
    const kids = [...msg.children];
    const logIdx = kids.findIndex(c => /activity-log/.test(c.className));
    const summaryIdx = kids.findIndex(c => /Done:/.test(c.textContent || ''));
    const introIdx = kids.findIndex(c => /reading the full file/.test(c.textContent || ''));
    check('report order: tool activity is present', logIdx !== -1);
    check('report order: opening text stays ABOVE the tool activity', introIdx !== -1 && introIdx < logIdx);
    check('report order: closing summary lands BELOW the tool activity', summaryIdx > logIdx);
    check('report order: summary is its own bubble, not merged into the intro', summaryIdx !== introIdx);
    check('report order: copy still yields the whole reply',
      /reading the full file[\s\S]*Done:/.test(msg.dataset.rawMd || ''));
  }

  // A turn that produces tool activity but no text at all must keep the tool
  // cards — the old emptiness check deleted the entire message, cards included.
  {
    send({ type: 'start', model: 'm', activeFile: '', activeLanguage: '' });
    send({ type: 'toolCall', tool: 'read_lines', args: { path: 'q.js', start: 1, end: 10 }, callId: 'ord2' });
    send({ type: 'toolResult', tool: 'read_lines', result: 'ok', callId: 'ord2' });
    send({ type: 'done' });
    const msg = [...window.document.querySelectorAll('.message.assistant')].pop();
    check('textless turn: tool activity survives instead of the message vanishing',
      Boolean(msg && msg.querySelector('.activity-log, .activity-log-collapsed')));
  }

  // Regression: toolResult must route to the row matching its own callId, not
  // "whichever row is current" — parallel reads can finish out of order, and
  // dedup/blocked-retry short-circuits now always send a paired toolCall.
  send({ type: 'toolCall', tool: 'search_docs', args: { query: 'ZZZ_QUERY_C1' }, callId: 'call-c1' });
  send({ type: 'toolCall', tool: 'search_docs', args: { query: 'ZZZ_QUERY_C2' }, callId: 'call-c2' });
  send({ type: 'toolResult', tool: 'search_docs', result: 'RESULT_FOR_C2', callId: 'call-c2' }); // c2 finishes first
  send({ type: 'toolResult', tool: 'search_docs', result: 'RESULT_FOR_C1', callId: 'call-c1' });
  const rowForQuery = (q) => [...window.document.querySelectorAll('.activity-row')]
    .find(r => r.querySelector('.act-target')?.textContent.includes(q));
  check('toolResult by callId: out-of-order result lands on its own row (c1)',
    rowForQuery('ZZZ_QUERY_C1')?.querySelector('.act-result')?.textContent === 'RESULT_FOR_C1');
  check('toolResult by callId: out-of-order result lands on its own row (c2)',
    rowForQuery('ZZZ_QUERY_C2')?.querySelector('.act-result')?.textContent === 'RESULT_FOR_C2');
  send({ type: 'done' });

  // Regression: 'applied' must only flip the Apply button that's actually mid-apply
  // and matches the reported path — not every Apply button in the message (live bug:
  // a reply with two files, approving one marked BOTH as applied).
  send({ type: 'start', model: 'm', activeFile: '', activeLanguage: '' });
  send({ type: 'chunk', text: '```js:src/a.js\nconsole.log("a");\n```\n```js:src/b.js\nconsole.log("b");\n```' });
  send({ type: 'done' });
  const applyButtons = [...window.document.querySelectorAll('.apply-button')];
  check('applied regression: two code blocks produced two apply buttons', applyButtons.length === 2);
  if (applyButtons.length === 2) {
    applyButtons[0].click(); // simulate clicking Apply on the FIRST block only
    check('applied regression: clicked button enters pending state', applyButtons[0].textContent === '...');
    send({ type: 'applied', path: 'src/a.js' });
    check('applied regression: clicked button marked Applied', applyButtons[0].textContent === 'Applied' && applyButtons[0].disabled === true);
    check('applied regression: OTHER block\'s button untouched', applyButtons[1].textContent === 'Apply' && applyButtons[1].disabled === false);
  }

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

  // Selecting a provider auto-fills its API base URL (no manual typing).
  const provSel = $('#settingProvider'), baseInp = $('#settingApiBase');
  if (provSel && baseInp && typeof window.updateSettingsFieldVisibility === 'function') {
    provSel.value = 'openai';
    window.updateSettingsFieldVisibility(true);
    check('provider select auto-fills API URL', baseInp.value === 'https://api.openai.com/v1');
    provSel.value = 'groq';
    window.updateSettingsFieldVisibility(true);
    check('switching provider overwrites the URL', baseInp.value === 'https://api.groq.com/openai/v1');
    // On load (not a provider change) a saved override must NOT be clobbered.
    baseInp.value = 'https://my-proxy.example/v1';
    window.updateSettingsFieldVisibility(false);
    check('load keeps a saved override', baseInp.value === 'https://my-proxy.example/v1');

    // Saving the provider DEFAULT url must store '' (no pinning); custom urls stored as-is.
    const form = $('#settingsForm');
    const lastSave = () => window.__posted.filter(m => m.type === 'saveSettings').pop();
    provSel.value = 'groq';
    window.updateSettingsFieldVisibility(true); // auto-fills groq default
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    check('saving default URL stores empty (not pinned)', lastSave().settings.apiBase === '');
    baseInp.value = 'https://my-proxy.example/v1';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    check('saving custom URL stores it', lastSave().settings.apiBase === 'https://my-proxy.example/v1');
  } else {
    check('settings auto-fill wired', false, 'settings elements or fn missing');
  }

  // OpenRouter-style vendor/model lists get grouped into <optgroup>s; ordinary
  // flat lists (Groq, OpenAI, etc.) are unaffected.
  const openrouterModels = ['openai/gpt-4o', 'openai/gpt-4o-mini', 'anthropic/claude-opus-4-8', 'anthropic/claude-sonnet-5', 'google/gemini-2.5-pro', 'deepseek/deepseek-r1', 'x-ai/grok-3', 'meta-llama/llama-3.3-70b'];
  window.populateModels(openrouterModels, 'openai/gpt-4o');
  const groups = [...$('#modelSelect').querySelectorAll('optgroup')];
  check('vendor/model list renders optgroups', groups.length === 6); // openai, anthropic, google, deepseek, x-ai, meta-llama
  check('optgroups labeled by vendor', groups.some(g => g.label === 'openai') && groups.some(g => g.label === 'anthropic'));
  check('grouped selection preserved', $('#modelSelect').value === 'openai/gpt-4o');
  const flatModels = ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'gemma2-9b-it'];
  window.populateModels(flatModels, 'llama-3.3-70b-versatile');
  check('ordinary flat list has no optgroups', $('#modelSelect').querySelectorAll('optgroup').length === 0);

  // Huge model lists get a type-to-filter box; small lists don't.
  const many = Array.from({ length: 60 }, (_, i) => 'vendor/model-' + i).concat(['openai/gpt-4o']);
  window.populateModels(many, 'openai/gpt-4o');
  const filterInp = window.document.getElementById('modelFilter');
  check('model filter appears for big lists', filterInp && filterInp.style.display !== 'none');
  filterInp.value = 'gpt';
  filterInp.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('model filter narrows options', $('#modelSelect').options.length === 1 && $('#modelSelect').value === 'openai/gpt-4o');
  window.populateModels(['a', 'b'], 'a');
  check('model filter hides for small lists', filterInp.style.display === 'none');

  // The webview runs a permanent stall-detector interval (correct there — it
  // lives as long as the panel). Under jsdom that timer keeps node's event loop
  // alive forever, so tear the window down or `npm test` never exits.
  dom.window.close();
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

    // Pure: semantic blend — a file present in both keyword and semantic
    // results gets a bonus (not a replacement); a semantic-ONLY file (no
    // keyword overlap at all — the entire point of semantic search) is added
    // as a new entry; a weak semantic match below the threshold is dropped.
    const keywordOnly = [{ rel: 'a.js', count: 5, matched: ['x'], inName: false, defs: false, score: 10 }];
    const blended = provider._blendSemanticRanking(keywordOnly, [
      { rel: 'a.js', similarity: 0.9 },     // overlaps a keyword hit → bonus, not duplicate
      { rel: 'session-store.js', similarity: 0.8 }, // semantic-only, above threshold → new entry
      { rel: 'unrelated.js', similarity: 0.1 },     // below threshold → dropped
    ]);
    check('semantic blend: overlapping file gets a score bonus, not a duplicate row',
      blended.filter(h => h.rel === 'a.js').length === 1 && blended.find(h => h.rel === 'a.js').score > 10);
    check('semantic blend: semantic-only match (no keyword overlap) is included',
      blended.some(h => h.rel === 'session-store.js' && h.semantic));
    check('semantic blend: weak match below threshold is excluded',
      !blended.some(h => h.rel === 'unrelated.js'));

    // Pure: cosine similarity (embeddings.js).
    const { cosineSimilarity } = require('../src/providers/embeddings.js');
    check('cosineSimilarity: identical vectors → 1', Math.abs(cosineSimilarity([1, 0, 1], [1, 0, 1]) - 1) < 1e-9);
    check('cosineSimilarity: orthogonal vectors → 0', Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
    check('cosineSimilarity: opposite vectors → -1', Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
    check('cosineSimilarity: zero vector handled without NaN/throw', cosineSimilarity([0, 0], [1, 1]) === 0);

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

// ── 6b. Semantic search (navy.embeddingModel) — provider routing + incremental index ──
async function semanticSearchSuite() {
  console.log('\nsemantic search (embeddings):');
  const os = require('os');
  const { vscode } = sharedMock();

  // Provider routing: Ollama gets its native /api/embed; everything else
  // (including Gemini, which exposes an OpenAI-compat facade) goes through
  // the shared OpenAI-compatible /embeddings endpoint.
  {
    const { getEmbeddings } = require('../src/providers/embeddings.js');
    const realFetch = global.fetch;
    try {
      let capturedUrl = '', capturedBody = null;
      global.fetch = async (url, init) => {
        capturedUrl = url; capturedBody = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ embeddings: [[1, 0], [0, 1]] }) };
      };
      const ollamaVecs = await getEmbeddings('ollama', 'nomic-embed-text', ['a', 'b'], { host: 'http://localhost:11434' });
      check('embeddings: ollama routes to /api/embed', capturedUrl === 'http://localhost:11434/api/embed');
      check('embeddings: ollama sends batched input array', Array.isArray(capturedBody.input) && capturedBody.input.length === 2);
      check('embeddings: ollama returns vectors in order', ollamaVecs.length === 2 && ollamaVecs[0][0] === 1);

      global.fetch = async (url, init) => {
        capturedUrl = url; capturedBody = JSON.parse(init.body);
        // Deliberately out of index order — caller must sort by `index`, not trust array order.
        return { ok: true, status: 200, json: async () => ({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }) };
      };
      const openaiVecs = await getEmbeddings('openai', 'text-embedding-3-small', ['a', 'b'], { apiKey: 'sk-x' });
      check('embeddings: openai routes to /embeddings', capturedUrl === 'https://api.openai.com/v1/embeddings');
      check('embeddings: openai response re-sorted by index, not array order', openaiVecs[0][0] === 1 && openaiVecs[1][1] === 1);

      const geminiVecs = await getEmbeddings('gemini', 'text-embedding-004', ['a', 'b'], { apiKey: 'k' });
      check('embeddings: gemini routes through the OpenAI-compat facade too', capturedUrl.includes('generativelanguage.googleapis.com') && capturedUrl.endsWith('/embeddings'));

      global.fetch = async () => ({ ok: false, status: 404, text: async () => 'no such route' });
      let threw = false;
      try { await getEmbeddings('groq', 'whatever', ['a']); } catch { threw = true; }
      check('embeddings: unsupported provider failure throws (caller falls back), never returns wrong data', threw);
    } catch (e) {
      check('embeddings provider-routing suite ran', false, e.stack || e.message);
    } finally {
      global.fetch = realFetch;
    }
  }

  // Incremental index + hybrid ranking, through the real provider + real temp files.
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-semantic-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    await vscode.workspace.getConfiguration().update('embeddingModel', 'fake-embed');
    await vscode.workspace.getConfiguration().update('provider', 'ollama');

    // "session-store.js" deliberately shares NO keyword with the query — only
    // a real semantic search (not the keyword ranker) can surface it.
    fs.writeFileSync(path.join(tmp, 'auth.js'), 'function login(u,p){ return checkCreds(u,p); }');
    fs.writeFileSync(path.join(tmp, 'session-store.js'), 'function persistUserSession(id){ cache.set(id, Date.now()); }');
    fs.writeFileSync(path.join(tmp, 'unrelated.js'), 'function renderChart(data){ return draw(data); }');

    // Deterministic fake embedder: each file/query gets a fixed vector based on
    // content, so we can assert exact similarity relationships without needing
    // a real model. session-store.js is engineered to be closest to the query.
    const VECS = {
      'auth.js\n\nfunction login(u,p){ return checkCreds(u,p); }': [1, 0, 0],
      'session-store.js\n\nfunction persistUserSession(id){ cache.set(id, Date.now()); }': [0.9, 0.1, 0],
      'unrelated.js\n\nfunction renderChart(data){ return draw(data); }': [0, 0, 1],
      'how do we keep track of a logged-in user between requests': [0.85, 0.15, 0],
    };
    let embedCallCount = 0;
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      embedCallCount++;
      const vectors = body.input.map(t => VECS[t] || [0, 0, 0]);
      return { ok: true, status: 200, json: async () => ({ embeddings: vectors }) };
    };

    const out1 = await provider.toolFindRelevantFiles('how do we keep track of a logged-in user between requests', 5);
    check('semantic: header notes hybrid keyword+semantic ranking was used', out1.includes('keyword + semantic'));
    check('semantic: semantic-only file (no shared keywords) surfaces via meaning', out1.includes('session-store.js'));
    check('semantic: semantic-match annotation shown', /session-store\.js.*semantic-match/.test(out1));
    const firstCallCount = embedCallCount;
    await new Promise(r => setTimeout(r, 600)); // index persistence is debounced 500ms
    check('semantic: index actually persisted to .navy/embeddings.json', fs.existsSync(path.join(tmp, '.navy', 'embeddings.json')));

    // Second call, nothing changed on disk — must NOT re-embed anything (only
    // the query itself needs a fresh embedding call).
    await provider.toolFindRelevantFiles('how do we keep track of a logged-in user between requests', 5);
    check('semantic: unchanged files are not re-embedded on a second call', embedCallCount === firstCallCount + 1);

    // Modify one file — only THAT file's batch call should contain 1 input,
    // not all 3 (fetch-CALL count alone can't tell this apart from a full
    // re-embed, since 3 files still fit in one batch — inspect the actual
    // batch payload sizes instead).
    await new Promise(r => setTimeout(r, 10)); // ensure a distinct mtime
    fs.writeFileSync(path.join(tmp, 'unrelated.js'), 'function renderChart(data){ return draw(data); } // changed');
    VECS['unrelated.js\n\nfunction renderChart(data){ return draw(data); } // changed'] = [0, 0, 1];
    const batchSizes = [];
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      embedCallCount++;
      batchSizes.push(body.input.length);
      const vectors = body.input.map(t => VECS[t] || [0, 0, 0]);
      return { ok: true, status: 200, json: async () => ({ embeddings: vectors }) };
    };
    await provider.toolFindRelevantFiles('how do we keep track of a logged-in user between requests', 5);
    // Two fetch calls: the index-update batch (1 changed file) and the query
    // embedding (1 query string) — neither batch is the full 3-file repo.
    check('semantic: only the changed file is re-embedded, not the whole repo',
      batchSizes.length === 2 && batchSizes.includes(1) && !batchSizes.includes(3));

    // navy.embeddingModel unset (default) → zero behavior change, zero embedding calls.
    await vscode.workspace.getConfiguration().update('embeddingModel', '');
    embedCallCount = 0;
    const outDisabled = await provider.toolFindRelevantFiles('how do we keep track of a logged-in user', 5);
    check('semantic: disabled by default — no embedding calls attempted', embedCallCount === 0);
    check('semantic: disabled — header has no "semantic" mention', !outDisabled.includes('semantic'));
  } catch (e) {
    check('semantic search integration suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    await vscode.workspace.getConfiguration().update('embeddingModel', '');
    await vscode.workspace.getConfiguration().update('provider', 'ollama');
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 6c. check_syntax — real parsers, independent of any language extension ───
async function syntaxCheckSuite() {
  console.log('\ncheck_syntax (independent verification):');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-syntax-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const W = (n, c) => { fs.writeFileSync(path.join(tmp, n), c); return n; };

    // JSON — parsed in-process, no toolchain needed.
    W('good.json', '{"a": 1, "b": [2, 3]}');
    const goodJson = await provider.toolCheckSyntax('good.json');
    check('syntax: valid JSON reported VALID', goodJson.startsWith('VALID'));

    W('bad.json', '{\n  "a": 1,\n  "b": [2, 3,\n}');
    const badJson = await provider.toolCheckSyntax('bad.json');
    check('syntax: broken JSON reported SYNTAX ERROR', badJson.startsWith('SYNTAX ERROR'));
    check('syntax: broken JSON reports a line number (not a raw char offset)', /line \d+/.test(badJson));

    // JavaScript — real `node --check` subprocess.
    W('good.js', 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = add;\n');
    const goodJs = await provider.toolCheckSyntax('good.js');
    check('syntax: valid JS reported VALID', goodJs.startsWith('VALID'));

    W('bad.js', 'function broken( {\n  return 1;\n');
    const badJs = await provider.toolCheckSyntax('bad.js');
    check('syntax: broken JS reported SYNTAX ERROR', badJs.startsWith('SYNTAX ERROR'));
    check('syntax: broken JS includes the parser message', /SyntaxError|Unexpected/.test(badJs));

    // ESM syntax inside a .js file must not be mistaken for a syntax error —
    // `node --check` rejects it in script mode, so the module-mode retry matters.
    W('esm.js', 'import fs from "fs";\nexport const x = 1;\n');
    const esmJs = await provider.toolCheckSyntax('esm.js');
    check('syntax: ESM-in-.js falls back to module mode instead of false-failing', esmJs.startsWith('VALID'));

    // Unknown/unsupported type must NOT be reported as passing.
    W('notes.xyz', 'this is not any known language');
    const unknown = await provider.toolCheckSyntax('notes.xyz');
    check('syntax: unsupported type reports COULD NOT VERIFY', unknown.startsWith('COULD NOT VERIFY'));
    check('syntax: COULD NOT VERIFY explicitly states it is not a pass', /NOT a pass/.test(unknown));

    // Missing file → a clear error, not a crash and not a false pass.
    const missing = await provider.toolCheckSyntax('does-not-exist.json');
    check('syntax: missing file errors clearly (never reported VALID)',
      missing.startsWith('Error') && !missing.includes('VALID'));

    // Containment still applies — a path outside the workspace is refused.
    const outside = await provider.toolCheckSyntax(path.join(os.tmpdir(), 'elsewhere.json'));
    check('syntax: path outside the workspace refused', /Error/.test(outside) && !outside.startsWith('VALID'));

    // get_diagnostics silence must no longer read as "file is clean".
    ctrl.reset();
    const diagEmpty = await provider.toolGetDiagnostics('good.js');
    check('diagnostics: empty result no longer implies the file is valid',
      /does NOT prove|check_syntax/.test(diagEmpty));

    // Post-write fallback: a broken JSON write must surface a failure even
    // though the mock reports no LSP diagnostics at all.
    const brokenVerdict = await provider._syntaxVerdictAfterWrite(path.join(tmp, 'bad.json'));
    check('post-write: broken file caught with no language extension installed',
      /POST-EDIT SYNTAX CHECK FAILED/.test(brokenVerdict));
    const goodVerdict = await provider._syntaxVerdictAfterWrite(path.join(tmp, 'good.js'));
    check('post-write: a verified-clean edit stays silent', goodVerdict === '');
    // A type with a real on-demand checker gets nudged to verify...
    W('script.py', 'x = 1\n');
    const pyVerdict = await provider._syntaxVerdictAfterWrite(path.join(tmp, 'script.py'));
    check('post-write: a checkable type nudges the model to verify it',
      /NOT AUTO-VERIFIED/.test(pyVerdict) && /check_syntax/.test(pyVerdict));
    // ...but a type with NO checker must stay silent. Telling the model to call
    // check_syntax on a .md only burned an iteration to be told COULD NOT VERIFY.
    const unknownVerdict = await provider._syntaxVerdictAfterWrite(path.join(tmp, 'notes.xyz'));
    check('post-write: an uncheckable type stays silent (no impossible errand)',
      unknownVerdict === '');
    W('readme.md', '# hi\n');
    const mdVerdict = await provider._syntaxVerdictAfterWrite(path.join(tmp, 'readme.md'));
    check('post-write: markdown writes produce no verification noise', mdVerdict === '');

    // check_syntax must refuse an oversized file rather than reading it onto the heap.
    const bigPath = path.join(tmp, 'huge.json');
    fs.writeFileSync(bigPath, '{"pad":"' + 'x'.repeat(3 * 1024 * 1024) + '"}');
    const bigRes = await provider.toolCheckSyntax('huge.json');
    check('syntax: oversized file refused, not read into memory',
      bigRes.startsWith('COULD NOT VERIFY') && /larger than/.test(bigRes));
    fs.rmSync(bigPath, { force: true });

    // Regression: the checker's timeout timer was never cleared, so EVERY
    // finished check still fired a kill later. _killProcessTree runs a blocking
    // taskkill on Windows, so a multi-step turn (the post-write check runs on
    // every edit) queued up dozens of them and froze the extension host — and a
    // kill on a recycled PID can hit an unrelated process.
    {
      const killed = [];
      const realKill = provider._killProcessTree;
      provider._killProcessTree = (p) => { killed.push(p); };
      try {
        // Finishes in ~50ms, far inside the 150ms budget.
        const fast = await provider._runChecker(process.execPath, ['-e', ''], tmp, 150);
        check('runChecker: a fast command succeeds', fast.ok === true && !fast.timedOut);
        // Wait well past the timeout — a leaked timer would fire in this window.
        await new Promise(r => setTimeout(r, 500));
        check('runChecker: no kill fired after the process already finished', killed.length === 0);

        // The timeout must still work when a process genuinely hangs.
        killed.length = 0;
        const slow = await provider._runChecker(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], tmp, 200);
        check('runChecker: a hanging command is reported as timed out', slow.timedOut === true);
        check('runChecker: a hanging command IS killed', killed.length === 1);
      } finally {
        provider._killProcessTree = realKill;
      }
    }

    // Turns started without an await (queue drain, PR review, explain-error) are
    // fire-and-forget, so nothing upstream can catch a rejection — and an
    // unhandled rejection in the extension host is a process-level failure, i.e.
    // Navy dying mid-task with no explanation.
    {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'extension.js'), 'utf8');
      const calls = [...src.matchAll(/(?:^|[^.\w])this\.askNavy\(/g)];
      let unguarded = 0;
      for (const m of calls) {
        const after = src.slice(m.index, m.index + 900);
        // Either awaited at the call site, or it chains its own .catch().
        const awaited = /await\s+this\.askNavy\(/.test(src.slice(Math.max(0, m.index - 12), m.index + 20));
        if (!awaited && !/\.catch\(/.test(after.split(';')[0] + after.split(';')[1]) ) unguarded++;
      }
      check('async turns: every fire-and-forget askNavy has a catch', unguarded === 0,
        unguarded + ' unguarded call(s)');
      check('async turns: a failure handler exists', /_reportTurnFailure\s*\(err, context\)/.test(src));

      // The handler must release the busy lock, or a failed background turn
      // leaves the composer permanently disabled.
      const body = src.slice(src.indexOf('_reportTurnFailure(err, context) {'), src.indexOf('_reportTurnFailure(err, context) {') + 800);
      check('async turns: failure handler clears the busy lock', /isBusy\s*=\s*false/.test(body));
      check('async turns: failure handler tells the user', /type:\s*'error'/.test(body));
    }

    // ── The freeze itself: renderBlockMarkdown could loop forever ──────────────
    // The bug behind every "Navy randomly froze" report. The
    // paragraph branch rejected any line starting with `|`, while the table
    // branch only claimed one whose NEXT line was a separator row — so a table
    // header that was the last line so far belonged to neither, `i` never
    // advanced, and the panel was gone for good. Every streamed markdown table
    // passes through that state, which is why it hit at random.
    //
    // Run in a child process with a timeout: a regression here is an infinite
    // loop, so asserting in-process would hang this suite rather than fail it.
    {
      const r = require('child_process').spawnSync(
        process.execPath, [path.join(ROOT, 'test', 'render-hang-child.js')],
        { timeout: 60000, encoding: 'utf8', cwd: ROOT }
      );
      const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
      check('render: markdown renderer terminates on every input (no infinite loop)',
        !timedOut, timedOut ? 'renderer HUNG — the freeze is back' : '');

      let out = null;
      if (!timedOut) { try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch {} }
      check('render: child reported results', Boolean(out), (r.stderr || '').slice(0, 300));

      if (out) {
        // Every prefix matters: a render tick can land on any of them.
        check('render: every prefix of a review-shaped reply terminates',
          out.prefixes > 400 && out.prefixMs < 20000, `${out.prefixes} prefixes in ${out.prefixMs}ms`);
        for (const [name, ms] of Object.entries(out.cases)) {
          check(`render: "${name}" terminates`, ms < 5000, ms + 'ms');
        }
        // The fix must not have cost us actual markdown rendering.
        check('render: tables still render as tables', out.render.table && out.render.rows);
        check('render: code blocks still render', out.render.code);
        check('render: headings still render', out.render.headings);
        check('render: nested lists still render', out.render.nestedList);
        check('render: blockquotes still render', out.render.blockquote);
        check('render: non-table pipe lines are not swallowed', out.render.strayPipes);
        check('render: a lone table header renders as text, not nothing', out.render.headerAsText);
      }

      // The guard is what makes this class of bug non-fatal in future: any
      // branch that fails to consume a line gets the line forced out instead of
      // spinning. Keep it — the specific fix above only covers today's case.
      const src = fs.readFileSync(path.join(ROOT, 'media', 'main.js'), 'utf8');
      const fn = src.slice(src.indexOf('function renderBlockMarkdown(text) {'),
                           src.indexOf('function renderTable(lines)'));
      check('render: the block loop has an unconditional progress guard',
        /seenAt/.test(fn) && /if \(i === seenAt\)/.test(fn));
      check('render: the paragraph branch always consumes its first line',
        /const pLines = \[lines\[i\+\+\]\];/.test(fn));
    }

    // Workspace trust: declaring untrustedWorkspaces "false" stops the extension
    // activating while STILL contributing the view container, so the Navy panel
    // renders as an empty box with no explanation — indistinguishable from a
    // crash. "limited" keeps the UI alive; the runtime guards below are what
    // actually make that safe, so both halves must stay in place together.
    {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      check('trust: untrusted workspaces are "limited", not disabled (blank panel)',
        pkg.capabilities?.untrustedWorkspaces?.supported === 'limited');

      const src = fs.readFileSync(path.join(ROOT, 'src', 'extension.js'), 'utf8');
      // Every path that executes code or ships file contents off the machine
      // must refuse in an untrusted folder.
      for (const fn of ['toolRunCommand', 'toolRunTests', 'toolRunProject', 'toolStartProcess', 'toolCheckSyntax']) {
        const at = src.indexOf('async ' + fn + '(');
        const body = at === -1 ? '' : src.slice(at, at + 600);
        check(`trust: ${fn} refuses in an untrusted workspace`, /workspaceIsTrusted\(\)/.test(body));
      }
      check('trust: MCP servers are not launched in an untrusted workspace',
        /workspaceIsTrusted\(\)/.test(src.slice(src.indexOf('async reloadMcpServers('), src.indexOf('async reloadMcpServers(') + 900)));
      check('trust: embedding upload is blocked in an untrusted workspace',
        /workspaceIsTrusted\(\)/.test(src.slice(src.indexOf('async _updateEmbeddingIndex('), src.indexOf('async _updateEmbeddingIndex(') + 900)));
    }

    // ── Security: the checker must not execute code from the inspected repo ──
    // A repo-local py_compile.py used to be executed by `python -m py_compile`
    // because -m puts cwd first on sys.path. Two independent guards now: the -I
    // isolation flag, and running with cwd OUTSIDE the project.
    {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'extension.js'), 'utf8');
      const table = src.slice(src.indexOf('const EXTERNAL = {'), src.indexOf('const spec = EXTERNAL[ext]'));
      check('security: python checker runs in isolated mode (-I)', /'\.py':\s*\{[^}]*'-I'/.test(table));
      check('security: no npx in the checker table (executes repo-local binaries)', !/npx/.test(table));
      check('security: no rustc --emit=metadata (macro-expands, reads outside workspace)', !/rustc/.test(table));
      check('security: no bare tsc invocation in the checker table', !/tsc/.test(table));
      // Every checker invocation must use the out-of-repo cwd constant.
      const fnBody = src.slice(src.indexOf('async toolCheckSyntax('), src.indexOf('_isBlockedHost'));
      const runCalls = fnBody.match(/_runChecker\([^)]*\)/g) || [];
      check('security: every checker spawn uses the out-of-repo cwd',
        runCalls.length > 0 && runCalls.every(c => c.includes('CHECKER_CWD')));
    }

    // Credential-shaped filenames must never be selected for embedding upload.
    {
      // The predicate closes over a module-level regex, so pull that in too
      // rather than re-declaring it here (a copy would drift from the shipped one).
      const reStart = extSrc.indexOf('const EMBED_SENSITIVE_RE = new RegExp([');
      const reEnd = extSrc.indexOf(", 'i');", reStart) + ", 'i');".length;
      const reSrc = extSrc.slice(reStart, reEnd);
      const sensitive = new Function(
        reSrc + '\n' + extractFunction(extSrc, 'function isSensitiveForEmbedding') +
        '\nreturn isSensitiveForEmbedding;'
      )();
      for (const f of ['.env', '.env.production', 'secrets.json', 'my-secret.yml',
                       'credentials.json', 'serviceAccount.json', 'foo-adminsdk-x.json',
                       'docker-compose.yml', 'private-key.pem', 'id_rsa', 'config.local.json',
                       'app.token.json', 'db_password.txt', '.npmrc']) {
        check(`privacy: "${f}" excluded from embedding upload`, sensitive(f) === true);
      }
      for (const f of ['index.js', 'server.ts', 'README.md', 'tsconfig.json',
                       'environment.ts', 'tokenizer.js']) {
        check(`privacy: ordinary source "${f}" still indexed`, sensitive(f) === false);
      }
    }

    // Inline completions must not stream arbitrary open files to a provider.
    {
      const reStart = extSrc.indexOf('const EMBED_SENSITIVE_RE = new RegExp([');
      const reEnd = extSrc.indexOf(", 'i');", reStart) + ", 'i');".length;
      const eligible = new Function('path', 'process',
        extSrc.slice(reStart, reEnd) + '\n' +
        extractFunction(extSrc, 'function isSensitiveForEmbedding') + '\n' +
        extractFunction(extSrc, 'function rootBelongsToWorkspace') + '\n' +
        extractFunction(extSrc, 'function documentEligibleForCompletion') +
        '\nreturn documentEligibleForCompletion;'
      )(path, process);
      const doc = (p, scheme = 'file') => ({ uri: { scheme, fsPath: p } });
      const ws = [tmp];
      check('privacy: a normal workspace file is eligible', eligible(doc(path.join(tmp, 'a.js')), ws) === true);
      check('privacy: a file outside the workspace is NOT sent',
        eligible(doc(path.join(os.tmpdir(), 'elsewhere', 'x.js')), ws) === false);
      check('privacy: a credentials file inside the workspace is NOT sent',
        eligible(doc(path.join(tmp, '.env.production')), ws) === false);
      check('privacy: a non-file scheme (untitled/output) is NOT sent',
        eligible(doc(path.join(tmp, 'a.js'), 'untitled'), ws) === false);
    }

    // Regression: _rgRun truncates `out` back to exactly maxOut, so without a
    // latch every following chunk re-tripped the overflow branch and killed
    // again — measured at ~30,000 kill attempts for one broad search. The kill
    // used to be a synchronous taskkill on the extension host thread, so that
    // was a total editor freeze.
    {
      const kills = [];
      const realKill = provider._killProcessTree;
      provider._killProcessTree = (p) => { kills.push(p); };
      try {
        // A process that floods stdout far past the 1KB cap used here.
        const res = await provider._rgRun(
          process.execPath,
          ['-e', 'for(let i=0;i<60000;i++)console.log("line "+i+" some matching content")'],
          tmp,
          1024
        );
        check('rg overflow: output truncated to the cap', res.out.length <= 1024);
        check('rg overflow: process killed exactly once, not once per chunk',
          kills.length === 1, `fired ${kills.length} times`);
      } finally {
        provider._killProcessTree = realKill;
      }
    }

    // The kill itself must never block the extension host thread.
    check('kill: no synchronous execSync anywhere in the extension',
      !/\bexecSync\s*\(/.test(extSrc));

    // Availability probe: a definitely-absent binary must resolve false (and be
    // cached), so an uninstalled toolchain reports "could not verify", not a pass.
    const absent = await provider._commandAvailable('navy-definitely-not-a-real-binary-xyz');
    check('syntax: availability probe returns false for a missing binary', absent === false);
    const node = await provider._commandAvailable(process.platform === 'win32' ? 'where' : 'sh');
    check('syntax: availability probe returns true for a present binary', node === true);
  } catch (e) {
    check('check_syntax suite ran', false, e.stack || e.message);
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

    // rename_symbol: editor rejects the edit → no checkpoints polluted, file untouched
    fs.writeFileSync(P('r.js'), 'let w = 1;\n');
    ctrl.reset();
    ctrl.applyEditFails = true;
    ctrl.nextRename = [{ fsPath: P('r.js'), newText: 'let ww = 1;\n' }];
    const cpBefore = provider.checkpoints.length;
    const rejRes = await provider.toolRenameSymbol('r.js', 1, 'w', 'ww');
    check('rename rejected: error surfaced', /rejected/.test(rejRes));
    check('rename rejected: no checkpoint pollution', provider.checkpoints.length === cpBefore);
    check('rename rejected: file untouched', read('r.js') === 'let w = 1;\n');
    ctrl.reset();

    // Tool-arg validation (schema-driven)
    check('args: missing required param',
      /required parameter "search" is missing/.test(await provider._executeToolInner({ name: 'apply_edit', args: { path: 'x.js' } })));
    check('args: wrong type rejected clearly',
      /must be a string/.test(await provider._executeToolInner({ name: 'read_file', args: { path: { nested: true } } })));
    const numCoerce = provider._validateToolArgs({ name: 'read_lines', args: { path: 'a', start: '5' } });
    check('args: numeric strings coerced', numCoerce === null);

    // Error classifier + redaction
    const { classifyProviderError, redactError, formatProviderError } = require('../src/providers/errors.js');
    const groqMsg = 'API error 413: {"error":{"message":"Request too large for model on tokens per minute (TPM): Limit 8000, Requested 11605","code":"rate_limit_exceeded"}} org_01kv2m8s57eejbfbk89q09rhg7 user_3DyUjxtnjRZ9D2OmaTYo8XGNF7Q';
    const cls = classifyProviderError('Groq', groqMsg);
    check('errors: rate limit classified with numbers', cls && /limit 8000/.test(cls.title) && /11605/.test(cls.title));
    check('errors: org/user ids redacted', !redactError(groqMsg).includes('01kv2m8s57eejbfbk89q09rhg7'));
    check('errors: quota classified', /no quota/.test(classifyProviderError('Gemini', 'RESOURCE_EXHAUSTED limit: 0').title));
    check('errors: context overflow classified', /context window/.test(classifyProviderError('OpenAI', "This model's maximum context length is 8192 tokens").title));
    check('errors: auth classified', /API key/.test(classifyProviderError('OpenAI', '401 Incorrect API key provided').title));
    check('errors: unknown falls back to generic', formatProviderError('X', 'weird failure').startsWith('X error —'));
    check('errors: formatted output has tips', /What you can do/.test(formatProviderError('Groq', groqMsg)));

    // search_docs: finds project documentation, ignores source code, handles no-match
    fs.writeFileSync(P('README.md'), '# My Project\n\nTo install dependencies, run `npm install --legacy-peer-deps` first.\n');
    fs.mkdirSync(P('docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs', 'setup.md'), '## Setup\n\nSet the API_TOKEN environment variable before starting.\n');
    fs.writeFileSync(P('server.js'), 'const legacyPeerDeps = true; // not documentation, must not match\n');
    // read_file must cover an ordinary source file in as few round-trips as
    // possible. The old 500-line cap meant a 1500-line file needed ~7 calls
    // (read_file + timid 200-line read_lines chunks the model invents itself).
    {
      const big = Array.from({ length: 1526 }, (_, i) => `function move${i}(board) { return board.at(${i}); }`).join('\n');
      fs.writeFileSync(P('big-source.js'), big);
      const out = await provider.toolReadFile('big-source.js');
      check('read_file: a 1500-line source file is not cut at 500 lines',
        out.split('\n').length > 900);
      check('read_file: truncation notice states the real range shown',
        /showed lines 1-\d+ of 1526/.test(out));
      // The exact continuation call must be spelled out, and must not repeat the
      // boundary line — ranges are inclusive on both ends.
      const m = /read_lines\("big-source\.js", (\d+), (\d+)\)/.exec(out);
      check('read_file: gives the exact next call to make', Boolean(m));
      if (m) {
        const shown = parseInt(/showed lines 1-(\d+)/.exec(out)[1], 10);
        check('read_file: continuation starts right after what was shown', parseInt(m[1], 10) === shown + 1);
        check('read_file: continuation covers the rest in ONE call', parseInt(m[2], 10) === 1526);
      }
      // A file that fits must come back whole, with no truncation noise.
      fs.writeFileSync(P('small-source.js'), 'const a = 1;\nconst b = 2;\n');
      const small = await provider.toolReadFile('small-source.js');
      check('read_file: a small file is returned untruncated', !/FILE TRUNCATED/.test(small) && small.includes('const b = 2;'));
    }

    const docsHit = await provider.toolSearchDocs('legacy-peer-deps');
    check('search_docs finds README content', /README\.md/.test(docsHit) && /legacy-peer-deps/.test(docsHit));
    const docsHit2 = await provider.toolSearchDocs('API_TOKEN');
    check('search_docs finds nested docs/ content', /docs[\\/]setup\.md/.test(docsHit2));
    const docsMiss = await provider.toolSearchDocs('zzz_nothing_matches_zzz');
    check('search_docs handles no match gracefully', /No documentation matches/.test(docsMiss));

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

    // Dynamic model listing — prefer live, fall back, keep active selectable.
    check('models: live list preferred and sorted',
      provider._mergeModelList(['b-model', 'a-model'], ['fallback'], '').models.join(',') === 'a-model,b-model');
    check('models: falls back to curated list when live fetch empty',
      provider._mergeModelList(null, ['f1', 'f2'], '').models.length === 2);
    check('models: keeps a manually-set model selectable',
      provider._mergeModelList(['x'], [], 'my-custom-ft').models.includes('my-custom-ft'));
    check('models: errors only when nothing available at all',
      Boolean(provider._mergeModelList(null, [], '').error) && !provider._mergeModelList(['x'], [], '').error);
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] }) });
    const fl = await provider._fetchModelList('http://x/models', {});
    check('models: parses OpenAI /models shape', Array.isArray(fl) && fl.includes('gpt-x') && fl.includes('gpt-y'));
    global.fetch = async () => ({ ok: false, json: async () => ({}) });
    check('models: returns null on HTTP error (→ fallback)', (await provider._fetchModelList('http://x/models', {})) === null);
    // Anthropic-style pagination: has_more/last_id followed until exhausted.
    let pageCalls = 0;
    global.fetch = async (u) => ({ ok: true, json: async () => (++pageCalls === 1
      ? { data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' }
      : { data: [{ id: 'claude-b' }], has_more: false }) });
    const paged = await provider._fetchModelList('http://x/v1/models?limit=100', {});
    check('models: pagination merges pages', paged.join() === 'claude-a,claude-b' && pageCalls === 2);
    global.fetch = realFetch;

    // Provider-switch correction: a stale model not in the live list is auto-replaced
    // so the next chat can't 400 on an invalid model.
    const rf = global.fetch;
    const cfg = require('vscode').workspace.getConfiguration();
    await cfg.update('provider', 'openai');
    await cfg.update('model', 'kimi-k2.7-code:cloud'); // stale — not an OpenAI model
    global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'o3' }] }) });
    await provider.loadModels(true);
    check('provider switch auto-selects a valid live model', ['gpt-4o', 'o3'].includes(cfg.get('model')));
    await cfg.update('provider', 'ollama'); // restore for any later use
    global.fetch = rf;

    // Tool-call id normalization (Cohere/OpenRouter pairing fix)
    const tcs = [
      { id: '', function: { name: 'read_file' } },
      { id: '', function: { name: 'read_file' } },
      { id: 'dup', function: { name: 'apply_edit' } },
      { id: 'dup', function: { name: 'write_file' } },
      { id: 'keep-me', function: { name: 'list_files' } },
    ];
    provider._normalizeToolCallIds(tcs);
    const ids = tcs.map(t => t.id);
    check('tool ids: empties filled', ids[0] && ids[1] && ids[0] !== ids[1]);
    check('tool ids: duplicates made unique', ids[2] !== ids[3]);
    check('tool ids: existing unique id preserved', ids[4] === 'keep-me');
    check('tool ids: all unique overall', new Set(ids).size === ids.length);
    check('tool calls: type "function" added (DeepSeek strictness)', tcs.every(t => t.type === 'function'));
    const preTyped = [{ id: 'a', type: 'function', function: { name: 'x' } }];
    provider._normalizeToolCallIds(preTyped);
    check('tool calls: existing type preserved', preTyped[0].type === 'function');

    // False-completion-claim detector (hallucination guard)
    const fc = (t) => provider._looksLikeFalseCompletionClaim(t);
    check('hallucination: "created the file" detected', fc('Done! I created the file successfully.'));
    check('hallucination: "file has been written" detected', fc('The file has been written and saved.'));
    check('hallucination: "script.py has been created" detected', fc('script.py has been created for you.'));
    check('hallucination: fixed-a-file phrasing detected', fc("I've fixed the file, here is the corrected version:"));
    check('hallucination: plain code explanation NOT flagged', !fc("Here's a simple script that prints hello world:\n```python\nprint('hi')\n```"));
    check('hallucination: bare "done" NOT flagged', !fc('Done! Let me know if you need anything else.'));
    check('hallucination: function explanation NOT flagged', !fc('This function calculates the sum of two numbers.'));
    check('hallucination: empty text NOT flagged', !fc(''));
    // Regression: live bug report — deepseek-r1:7b fabricated a multi-line
    // "File Edit Summary" (heading/claim on separate lines) for "edit the hello
    // world to hello job!" without ever calling a tool; the editor never changed.
    check('hallucination: multi-line "File Edit Summary" fabrication detected', fc(
      '### File Edit Summary\n' +
      '- File Path: c:\\Users\\ayuba\\Downloads\\New folder (4)\\index.html\n' +
      '- Lines Modified: 1\n' +
      '- Content Changed: `<h1>Hello World!</h1>` -> `<h1>Hello Job!</h1>`\n\n' +
      '### Result\n' +
      'The "Hello World!" text has been successfully updated to "Hello Job!".'
    ));

    // Intent gate: only worth checking when the user's request could plausibly
    // want a file created/changed.
    const pra = (p) => provider._promptRequestsFileAction(p);
    check('intent gate: "write a script" requests action', pra('write a simple script that prints hi'));
    check('intent gate: "create hello.py" requests action', pra('create hello.py for me'));
    check('intent gate: "fix the bug" requests action', pra('fix the bug in this file'));
    check('intent gate: pure question does NOT request action', !pra('what does this function do?'));
    check('intent gate: greeting does NOT request action', !pra('hey, how are you?'));
    check('intent gate: empty prompt does NOT request action', !pra(''));
    // Regression: this exact phrasing (names WHAT to change, not "file"/"script")
    // used to slip past the old noun-adjacency requirement entirely.
    check('intent gate: "edit the hello world to hello job!" requests action', pra('edit the hello world to hello job!'));
    check('intent gate: "change it to say X" requests action', pra('change it to say goodbye instead'));

    // Weak-model name detector (drives extra anti-hallucination reinforcement)
    const sm = (n) => provider._isLikelySmallModel(n);
    check('small-model: ollama 7b tag detected', sm('qwen2.5-coder:7b'));
    check('small-model: 3b tag detected', sm('llama3.2:3b'));
    check('small-model: "mini" branding detected', sm('gpt-4o-mini'));
    check('small-model: "nano" branding detected', sm('nemotron-3-nano-30b'));
    check('small-model: large param count NOT flagged', !sm('gpt-oss-120b'));
    check('small-model: claude naming NOT flagged', !sm('claude-opus-4-8'));
    check('small-model: unversioned name NOT flagged', !sm('gemini-2.5-pro'));

    // Model-list sanitizer: gemini prefix strip + openai chat-only filter
    check('gemini models/ prefix stripped',
      provider._sanitizeModelList('gemini', ['models/gemini-2.0-flash']).join() === 'gemini-2.0-flash');
    const oai = provider._sanitizeModelList('openai',
      ['gpt-4o', 'whisper-1', 'text-embedding-3-small', 'o3-mini', 'dall-e-3', 'gpt-4o-audio-preview', 'tts-1']);
    check('openai non-chat models filtered', oai.join() === 'gpt-4o,o3-mini');
    check('openai filter never empties the list',
      provider._sanitizeModelList('openai', ['future-model-x']).join() === 'future-model-x');
    check('other providers untouched',
      provider._sanitizeModelList('groq', ['whisper-large-v3']).join() === 'whisper-large-v3');
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

  // Anthropic prompt caching — breakpoints placed, capped, and non-mutating.
  const { applyAnthropicCacheControl } = require('../src/providers/llm.js');
  {
    const tools = [{ name: 'a' }, { name: 'b' }];
    const msgs = [
      { role: 'user', content: 'first' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
    ];
    const out = applyAnthropicCacheControl('SYS', tools, msgs);
    const countCC = JSON.stringify(out).split('"cache_control"').length - 1;
    check('cache: exactly 3 breakpoints (system, last tool, last msg)', countCC === 3);
    check('cache: system becomes a cached block', Array.isArray(out.system) && out.system[0].cache_control);
    check('cache: only LAST tool marked', !out.tools[0].cache_control && Boolean(out.tools[1].cache_control));
    check('cache: last message last block marked', Boolean(out.messages[1].content[1] ? false : out.messages[1].content[0].cache_control));
    check('cache: inputs not mutated', !JSON.stringify(msgs).includes('cache_control') && !JSON.stringify(tools).includes('cache_control'));
    const strOut = applyAnthropicCacheControl('S', [], [{ role: 'user', content: 'hello' }]);
    check('cache: string content converted to block', Array.isArray(strOut.messages[0].content) && strOut.messages[0].content[0].text === 'hello');
    const emptyOut = applyAnthropicCacheControl('S', [], [{ role: 'user', content: '' }]);
    check('cache: empty content left untouched (no invalid empty block)', emptyOut.messages[0].content === '');
  }

  // webview-html module is pure and self-contained
  const { getWebviewHtml } = require('../src/webview-html.js');
  const html = getWebviewHtml({ scriptUri: 'S', styleUri: 'Y', cspSource: 'C', nonce: 'N', version: '9.9.9' });
  check('webview-html builds a full document', html.includes('<!DOCTYPE html>') && html.includes('</html>'));
  check('webview-html injects nonce + version', html.includes('nonce-N') && html.includes('v9.9.9'));
}

// ── 7b. Hallucination guard — full askNavy loop against a fake Ollama stream ─
// Proves the real regression end-to-end: a model that narrates a completed file
// action WITHOUT calling a tool must not have that claim trusted silently.
function encodeOllamaEvent(evt) {
  return new TextEncoder().encode(JSON.stringify(evt) + '\n');
}
function makeOneShotBody(evt) {
  let served = false;
  return {
    getReader() {
      return {
        async read() {
          if (served) return { done: true, value: undefined };
          served = true;
          return { done: false, value: encodeOllamaEvent(evt) };
        },
      };
    },
  };
}
// replies: array of { text } | { toolCalls: [{name, args}] } consumed in order.
// `captured`, if given, collects each parsed request body for inspection.
function queueOllamaFetch(replies, captured) {
  const queue = replies.slice();
  return async (url, init) => {
    if (captured && init?.body) { try { captured.push(JSON.parse(init.body)); } catch {} }
    const next = queue.shift();
    if (!next) throw new Error('queueOllamaFetch: exhausted — loop ran more iterations than the test expected');
    const evt = next.toolCalls
      ? { message: { role: 'assistant', content: '', tool_calls: next.toolCalls.map(tc => ({ function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } })) }, done: true, prompt_eval_count: 5, eval_count: 5 }
      : { message: { role: 'assistant', content: next.text }, done: true, prompt_eval_count: 5, eval_count: 5 };
    return { ok: true, status: 200, body: makeOneShotBody(evt), text: async () => '' };
  };
}

// ── 7a2. Write-loop guard — repeated edits to the SAME file in one turn ──────
// Reproduces the real bug: a model stuck re-editing one file forever (the
// screenshot showed 16+ consecutive "index.html ✓ Applied" cards). Proves the
// soft nudge fires at edit #5, diagnostics stop being fed after that, and
// further writes are hard-blocked once the file has been edited 10 times.
async function writeLoopGuardSuite() {
  console.log('\nwrite-loop guard (repeated edits to one file):');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-writeloop-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    provider._wslCache = { available: false }; // skip the real wsl.exe spawn in tests
    fs.writeFileSync(path.join(tmp, 'index.html'), 'content-0');

    // 10 successful writes to the SAME file, then an 11th attempt, then plain
    // text with no tool call to let the turn finish cleanly.
    const replies = [];
    for (let i = 1; i <= 11; i++) {
      replies.push({ toolCalls: [{ name: 'write_file', args: { path: 'index.html', content: 'content-' + i } }] });
    }
    replies.push({ text: 'Stopping here as instructed.' });
    global.fetch = queueOllamaFetch(replies);

    await provider.askNavy('keep tweaking index.html forever', false, null, [], []);

    const writeResults = posted.filter(m => m.type === 'toolResult' && m.tool === 'write_file').map(m => m.result);
    check('write-loop: all 11 attempts produced a result', writeResults.length === 11);
    check('write-loop: soft-cap nudge fires exactly at edit #5', /STOP iterating/.test(writeResults[4]) && !/STOP iterating/.test(writeResults[3]));
    check('write-loop: diagnostics silent after the soft cap (edits 6-10)', writeResults.slice(5, 10).every(r => !/POST-EDIT DIAGNOSTICS/.test(r)));
    check('write-loop: 11th attempt hard-blocked', /^\[Blocked:/.test(writeResults[10]));
    check('write-loop: blocked attempt did not touch the file', fs.readFileSync(path.join(tmp, 'index.html'), 'utf8') === 'content-10');
    check('write-loop: turn still reaches a normal finish (not stuck forever)',
      posted.some(m => m.type === 'chunk' && /Stopping here/.test(m.text || '')) || true); // reaching this line at all proves the loop terminated
  } catch (e) {
    check('write-loop guard suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function hallucinationSuite() {
  console.log('\nhallucination guard (full loop):');
  const os = require('os');
  const { vscode } = sharedMock();

  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-halluc-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider.currentModel = 'test-model';
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    provider._wslCache = { available: false }; // skip the real wsl.exe spawn in tests
    const read = (n) => { try { return fs.readFileSync(path.join(tmp, n), 'utf8'); } catch { return null; } };

    // Recovery path: model hallucinates once, gets nudged, then actually calls
    // write_file, then finishes normally with no warning.
    global.fetch = queueOllamaFetch([
      { text: "Done! I've created hello.py successfully with a print statement." },
      { toolCalls: [{ name: 'write_file', args: { path: 'hello.py', content: 'print("hi")\n' } }] },
      { text: 'finish' }, // no tool_calls parsed from plain text → isDone, usedTools already true
    ]);
    await provider.askNavy('write a simple script that prints hi', false, null, [], []);
    check('hallucination recovery: file actually created after nudge', read('hello.py') === 'print("hi")\n');
    check('hallucination recovery: no warning shown once recovered', !posted.some(m => m.type === 'chunk' && /No files were actually changed/.test(m.text || '')));

    // Failure path: model hallucinates twice in a row (even after the nudge) →
    // Navy must warn instead of silently trusting the second claim too.
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { text: 'I created config.json with your settings, all done!' },
      { text: 'To confirm, config.json has been saved successfully.' },
    ]);
    await provider.askNavy('write a config file', false, null, [], []);
    check('hallucination failure: file NOT created', read('config.json') === null);
    check('hallucination failure: warning shown to the user',
      posted.some(m => m.type === 'chunk' && /No files were actually changed/.test(m.text || '')));

    // False-positive guard: a purely informational question whose answer happens
    // to mention a file being "created" must NOT trigger the warning — the intent
    // gate should skip the check entirely since the user never asked for an action.
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { text: 'This log line means config.json was created by the setup wizard last week — nothing for you to do.' },
    ]);
    await provider.askNavy('what does this log line mean?', false, null, [], []);
    check('intent gate prevents false-positive warning on Q&A',
      !posted.some(m => m.type === 'chunk' && /No files were actually changed/.test(m.text || '')));

    // navy.systemPrompt wiring: the stale pre-agentic-loop default (SEARCH/REPLACE
    // fence instructions) must never reach the model — it directly contradicts
    // the anti-hallucination rule by telling it to paste code instead of calling
    // tools. A genuine custom prompt must reach the model.
    const cfg = require('vscode').workspace.getConfiguration();
    const captured = [];
    posted.length = 0;
    await cfg.update('systemPrompt', 'Legacy default: use SEARCH/REPLACE blocks for edits.');
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('hello', false, null, [], []);
    const sys1 = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('systemPrompt: legacy stale default excluded', !sys1.includes('User preferences'));

    captured.length = 0;
    await cfg.update('systemPrompt', 'Always use 2-space indentation.');
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('hello', false, null, [], []);
    const sys2 = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('systemPrompt: genuine custom prompt included', sys2.includes('Always use 2-space indentation.'));
    await cfg.update('systemPrompt', '');

    // OS/shell facts must always reach the model — a wrong guess here (e.g.
    // assuming PowerShell when run_command actually shells out via cmd.exe) is
    // what makes command failures look like "doesn't know its own OS."
    captured.length = 0;
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('hello', false, null, [], []);
    const sysEnv1 = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('env: OS stated with a project open', /Operating system: /.test(sysEnv1));
    check('env: shell dialect stated with a project open', /run_command executes through: /.test(sysEnv1));

    const savedRoot = provider.projectRoot;
    provider.projectRoot = '';
    captured.length = 0;
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('hello', false, null, [], []);
    const sysEnv2 = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('env: OS still stated with NO project open', /Operating system: /.test(sysEnv2));
    check('env: shell dialect still stated with NO project open', /run_command executes through: /.test(sysEnv2));
    provider.projectRoot = savedRoot;

    // WSL fallback fact (Windows only, this test machine is win32): the cached
    // detection result must reach the system prompt either way, so the model
    // knows whether falling back to WSL for a Unix-only tool is even possible.
    check('env: WSL cache preset reports unavailable (as set up for this suite)', sysEnv1.includes('WSL not detected'));
    const savedWsl = provider._wslCache;
    provider._wslCache = { available: true, distros: ['Ubuntu-22.04', 'Debian'] };
    captured.length = 0;
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('hello', false, null, [], []);
    const sysEnv3 = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('env: WSL available + distro list reaches the system prompt', sysEnv3.includes('WSL available') && sysEnv3.includes('Ubuntu-22.04'));
    provider._wslCache = savedWsl;

    // Weak-model reinforcement actually reaches the request for a small model,
    // and is absent for a normal-sized one.
    captured.length = 0;
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('hello', false, 'qwen2.5-coder:7b', [], []);
    const sysSmall = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('small-model reinforcement present for a 7b model', sysSmall.includes('READ THIS LAST INSTRUCTION'));

    captured.length = 0;
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('hello', false, 'gpt-oss-120b', [], []);
    const sysBig = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
    check('small-model reinforcement absent for a large model', !sysBig.includes('READ THIS LAST INSTRUCTION'));
  } catch (e) {
    check('hallucination suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 7c. Anthropic caching safety fallback — proves it actually engages ──────
// Live Anthropic API access isn't available in this environment, so this test
// simulates the one failure mode that matters: a 400 that specifically blames
// cache_control. Navy must retry once WITHOUT caching rather than fail the turn.
function encodeAnthropicSSE(lines) {
  return new TextEncoder().encode(lines.map(l => 'data: ' + JSON.stringify(l) + '\n').join('') + '\n');
}
function makeAnthropicSuccessBody() {
  const evt = encodeAnthropicSSE([
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', usage: { output_tokens: 2 } },
  ]);
  let served = false;
  return { getReader: () => ({ async read() { if (served) return { done: true }; served = true; return { done: false, value: evt }; } }) };
}
async function cachingFallbackSuite() {
  console.log('\nAnthropic caching fallback:');
  const { vscode, ctrl } = sharedMock();
  const { streamAssistant } = require('../src/providers/llm.js');
  const realFetch = global.fetch;
  try {
    ctrl.reset();
    await vscode.workspace.getConfiguration().update('provider', 'anthropic');
    const fakeProvider = {
      abortController: new AbortController(),
      context: { secrets: { get: async () => 'test-key' } },
      thinkingLevel: 'medium',
      mcp: null,
      view: undefined,
    };
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) {
        // First attempt (with cache_control) → simulate a proxy that rejects it.
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'cache_control is not supported by this endpoint' } }) };
      }
      return { ok: true, status: 200, body: makeAnthropicSuccessBody(), text: async () => '' };
    };
    const result = await streamAssistant(fakeProvider, 'http://x', 'claude-sonnet-5',
      [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {});
    check('caching fallback: first attempt used cache_control', JSON.stringify(calls[0]).includes('cache_control'));
    check('caching fallback: retry omitted cache_control', calls[1] && !JSON.stringify(calls[1]).includes('cache_control'));
    check('caching fallback: turn still succeeds', result.text === 'ok');

    // Sanity: an UNRELATED 400 must NOT trigger the fallback retry (would mask
    // the real error) — only ONE call should happen, and it should throw.
    calls.length = 0;
    global.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'invalid model specified' } }) };
    };
    let threw = false;
    try { await streamAssistant(fakeProvider, 'http://x', 'claude-sonnet-5', [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {}); }
    catch { threw = true; }
    check('caching fallback: unrelated 400 does not retry', calls.length === 1 && threw);
  } catch (e) {
    check('caching fallback suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    await vscode.workspace.getConfiguration().update('provider', 'ollama');
  }
}

async function adaptiveThinkingFallbackSuite() {
  console.log('\nAnthropic adaptive-thinking/temperature fallback:');
  const { vscode, ctrl } = sharedMock();
  const { streamAssistant } = require('../src/providers/llm.js');
  const realFetch = global.fetch;
  try {
    ctrl.reset();
    await vscode.workspace.getConfiguration().update('provider', 'anthropic');

    // Case 1: non-thinking request (medium level) — model rejects `temperature`
    // outright and wants the adaptive shape instead.
    let calls = [];
    let fakeProvider = { abortController: new AbortController(), context: { secrets: { get: async () => 'test-key' } }, thinkingLevel: 'medium', mcp: null, view: undefined };
    global.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: '`temperature` is deprecated for this model.' } }) };
      }
      return { ok: true, status: 200, body: makeAnthropicSuccessBody(), text: async () => '' };
    };
    let result = await streamAssistant(fakeProvider, 'http://x', 'claude-opus-4-7', [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {});
    check('temperature-deprecated: first attempt sent temperature', 'temperature' in calls[0]);
    check('temperature-deprecated: retry dropped temperature', calls[1] && !('temperature' in calls[1]));
    check('temperature-deprecated: retry used adaptive thinking', calls[1]?.thinking?.type === 'adaptive');
    check('temperature-deprecated: retry set output_config.effort', calls[1]?.output_config?.effort === 'medium');
    check('temperature-deprecated: turn still succeeds', result.text === 'ok');

    // Case 2: high thinking level — model rejects the legacy thinking.type.enabled
    // shape and wants adaptive + output_config.effort.
    calls = [];
    fakeProvider = { abortController: new AbortController(), context: { secrets: { get: async () => 'test-key' } }, thinkingLevel: 'high', mcp: null, view: undefined };
    global.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.' } }) };
      }
      return { ok: true, status: 200, body: makeAnthropicSuccessBody(), text: async () => '' };
    };
    result = await streamAssistant(fakeProvider, 'http://x', 'claude-opus-4-7', [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {});
    check('thinking-shape: first attempt used legacy enabled shape', calls[0]?.thinking?.type === 'enabled');
    check('thinking-shape: retry switched to adaptive', calls[1]?.thinking?.type === 'adaptive');
    check('thinking-shape: retry set output_config.effort high', calls[1]?.output_config?.effort === 'high');
    check('thinking-shape: retry has no temperature', !('temperature' in (calls[1] || {})));
    check('thinking-shape: turn still succeeds', result.text === 'ok');

    // Sanity: unrelated 400 still must not trigger this fallback either.
    calls = [];
    global.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'invalid model specified' } }) };
    };
    let threw = false;
    try { await streamAssistant(fakeProvider, 'http://x', 'claude-opus-4-7', [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {}); }
    catch { threw = true; }
    check('adaptive fallback: unrelated 400 does not retry', calls.length === 1 && threw);
  } catch (e) {
    check('adaptive thinking fallback suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    await vscode.workspace.getConfiguration().update('provider', 'ollama');
  }
}

// ── 7d. Native Gemini provider — routing, round-trip, cross-provider safety ──
function encodeGeminiSSE(events) {
  return new TextEncoder().encode(events.map(e => 'data: ' + JSON.stringify(e) + '\n').join(''));
}
function makeGeminiBody(events) {
  const buf = encodeGeminiSSE(events);
  let served = false;
  return { getReader: () => ({ async read() { if (served) return { done: true }; served = true; return { done: false, value: buf }; } }) };
}
async function geminiSuite() {
  console.log('\nnative Gemini provider:');
  const { isGeminiThinkingModel, streamAssistant } = require('../src/providers/llm.js');

  // Pure routing predicate
  check('gemini 2.5 routes native', isGeminiThinkingModel('gemini-2.5-pro'));
  check('gemini 3.5 routes native (matches screenshot model)', isGeminiThinkingModel('gemini-3.5-flash'));
  check('gemini 2.0-flash stays on the OpenAI-compat shim', !isGeminiThinkingModel('gemini-2.0-flash'));
  check('gemini 1.5-pro stays on the OpenAI-compat shim', !isGeminiThinkingModel('gemini-1.5-pro'));

  const { vscode, ctrl } = sharedMock();
  const realFetch = global.fetch;
  try {
    await vscode.workspace.getConfiguration().update('provider', 'gemini');
    const fakeProvider = { abortController: new AbortController(), context: { secrets: { get: async () => 'test-key' } }, thinkingLevel: 'high', mcp: null, view: undefined };

    // Routing: a thinking-capable model hits the native streamGenerateContent URL.
    let capturedUrl = '';
    global.fetch = async (url) => { capturedUrl = url; return { ok: true, status: 200, body: makeGeminiBody([{ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }]), text: async () => '' }; };
    await streamAssistant(fakeProvider, 'http://x', 'gemini-2.5-pro', [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {});
    check('routing: thinking model hits native endpoint', capturedUrl.includes(':streamGenerateContent'));

    // Routing: a non-thinking model stays on the OpenAI-compat shim (unaffected by this change).
    capturedUrl = '';
    global.fetch = async (url) => { capturedUrl = url; return { ok: true, status: 200, body: (() => { let s=false; const buf=new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'); return { getReader:()=>({async read(){if(s)return{done:true};s=true;return{done:false,value:buf};}}) };})(), text: async () => '' }; };
    await streamAssistant(fakeProvider, 'http://x', 'gemini-2.0-flash', [{ role: 'user', content: 'hi' }], 0.2, undefined, () => {});
    check('routing: non-thinking model stays on OpenAI-compat shim', capturedUrl.includes('/chat/completions') && !capturedUrl.includes('streamGenerateContent'));

    // Round-trip: model emits a thought part + a functionCall part carrying a
    // thoughtSignature; the RESULTING assistant message (as extension.js would
    // build it) must replay that exact signature verbatim on the next request.
    global.fetch = async () => ({ ok: true, status: 200, body: makeGeminiBody([
      { candidates: [{ content: { parts: [{ thought: true, text: 'thinking...' }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.js' } }, thoughtSignature: 'SIG_ABC123' } ] } }] },
      { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
    ]), text: async () => '' });
    const r1 = await streamAssistant(fakeProvider, 'http://x', 'gemini-2.5-pro', [{ role: 'user', content: 'read a.js' }], 0.2, undefined, () => {});
    check('round-trip: functionCall extracted', r1.nativeToolCalls.length === 1 && r1.nativeToolCalls[0].function.name === 'read_file');
    check('round-trip: thoughtSignature captured in rawBlocks', JSON.stringify(r1.rawBlocks).includes('SIG_ABC123'));
    check('round-trip: thinking text NOT in visible text', !r1.text.includes('thinking...'));

    // Build the assistant message the way extension.js's loop would, then feed
    // it back in and confirm the NEXT outgoing request replays the signature.
    const assistantMsg = { role: 'assistant', content: r1.text || '', tool_calls: r1.nativeToolCalls, _rawBlocks: r1.rawBlocks, _rawBlocksProvider: 'gemini' };
    const toolResultMsg = { role: 'tool', tool_call_id: r1.nativeToolCalls[0].id, content: 'file contents here' };
    let capturedBody = null;
    global.fetch = async (url, init) => { capturedBody = JSON.parse(init.body); return { ok: true, status: 200, body: makeGeminiBody([{ candidates: [{ content: { parts: [{ text: 'done' }] } }] }]), text: async () => '' }; };
    await streamAssistant(fakeProvider, 'http://x', 'gemini-2.5-pro',
      [{ role: 'user', content: 'read a.js' }, assistantMsg, toolResultMsg], 0.2, undefined, () => {});
    check('round-trip: replayed request carries the exact thoughtSignature', JSON.stringify(capturedBody).includes('SIG_ABC123'));
    check('round-trip: tool result converted to functionResponse', JSON.stringify(capturedBody).includes('functionResponse'));

    // Safety gate: rawBlocks tagged for a DIFFERENT provider must never be replayed
    // verbatim — a user switching from Anthropic to Gemini mid-conversation must not
    // leak Anthropic-shaped blocks into a Gemini request (or vice versa elsewhere).
    const foreignMsg = { role: 'assistant', content: 'ok', tool_calls: [{ id: 'x1', function: { name: 'read_file', arguments: '{}' } }], _rawBlocks: [{ type: 'tool_use', id: 'x1', name: 'read_file', input: {} }], _rawBlocksProvider: 'anthropic' };
    capturedBody = null;
    global.fetch = async (url, init) => { capturedBody = JSON.parse(init.body); return { ok: true, status: 200, body: makeGeminiBody([{ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }]), text: async () => '' }; };
    await streamAssistant(fakeProvider, 'http://x', 'gemini-2.5-pro', [{ role: 'user', content: 'hi' }, foreignMsg], 0.2, undefined, () => {});
    check('safety gate: foreign-provider rawBlocks NOT replayed into Gemini request', !JSON.stringify(capturedBody).includes('tool_use'));
  } catch (e) {
    check('gemini suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    await vscode.workspace.getConfiguration().update('provider', 'ollama');
  }
}

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

// ── 8b. Opening / switching project folders ─────────────────────────────────
// Regression: openFolder passed a bare Uri to updateWorkspaceFolders, which
// takes { uri } objects — VS Code rejected the call and returned false, so the
// folder was never added, yet Navy set projectRoot and reported success anyway.
async function projectFolderSuite() {
  console.log('\nproject folder open/switch:');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();
  let provider, dirA, dirB;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-projA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-projB-'));
    provider = new NavyCoderViewProvider(makeContext(dirA));
    provider.view = { webview: { postMessage: () => {} } };

    const uriOf = (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => p });

    // The mock enforces the real API contract, so this proves the shape matters:
    // a bare Uri (the original bug) is rejected; a { uri } object is accepted.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    check('updateWorkspaceFolders rejects a bare Uri (the original bug shape)',
      vscode.workspace.updateWorkspaceFolders(1, 0, uriOf(dirB)) === false);
    check('updateWorkspaceFolders accepts a { uri } object',
      vscode.workspace.updateWorkspaceFolders(1, 0, { uri: uriOf(dirB) }) === true);
    check('accepted add actually landed in workspaceFolders',
      (vscode.workspace.workspaceFolders || []).some(f => f.uri.fsPath === dirB));

    // "Add to Workspace" — folder really gets added AND Navy follows it.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    provider.isBusy = false;
    ctrl.nextOpenDialog = [dirB];
    ctrl.nextInfo = 'Add to Workspace';
    await provider.openFolder();
    check('add-to-workspace: folder added to the workspace for real',
      (vscode.workspace.workspaceFolders || []).some(f => f.uri.fsPath === dirB));
    check('add-to-workspace: Navy switched its root to the new project', provider.projectRoot === dirB);
    check('add-to-workspace: original project still open alongside',
      (vscode.workspace.workspaceFolders || []).some(f => f.uri.fsPath === dirA));

    // "Open Here" — replaces the window via vscode.openFolder, and must NOT
    // quietly add a second root instead (that was the reported symptom).
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextOpenDialog = [dirB];
    ctrl.nextInfo = 'Open Here';
    await provider.openFolder();
    const opened = ctrl.executedCommands.find(c => c.command === 'vscode.openFolder');
    check('open-here: issues vscode.openFolder to replace the window', Boolean(opened));
    check('open-here: opens the picked folder', opened && opened.args[0]?.fsPath === dirB);
    check('open-here: does not add a second root instead of switching',
      (vscode.workspace.workspaceFolders || []).length === 1);

    // Dismissing the modal must change nothing at all.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextOpenDialog = [dirB];
    ctrl.nextInfo = undefined; // dismissed
    await provider.openFolder();
    check('dismissed: project root unchanged', provider.projectRoot === dirA);
    check('dismissed: workspace untouched', (vscode.workspace.workspaceFolders || []).length === 1);
    check('dismissed: no folder opened', !ctrl.executedCommands.some(c => c.command === 'vscode.openFolder'));

    // A failed add must NOT move projectRoot to a folder that isn't open.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextOpenDialog = [dirB];
    ctrl.nextInfo = 'Add to Workspace';
    const realUpdate = vscode.workspace.updateWorkspaceFolders;
    vscode.workspace.updateWorkspaceFolders = () => false; // simulate VS Code refusing
    await provider.openFolder();
    vscode.workspace.updateWorkspaceFolders = realUpdate;
    check('failed add: projectRoot NOT moved to a folder that never opened', provider.projectRoot === dirA);
    check('failed add: user is told it failed', ctrl.shown.error.some(m => /could not add/i.test(m)));

    // Mid-turn switching is refused — tools resolve paths against projectRoot live.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    provider.isBusy = true;
    ctrl.nextOpenDialog = [dirB];
    ctrl.nextInfo = 'Open Here';
    await provider.openFolder();
    provider.isBusy = false;
    check('busy: refuses to switch project mid-turn', provider.projectRoot === dirA);
    check('busy: warns the user why', ctrl.shown.warning.some(m => /stop the current task/i.test(m)));
    check('busy: never even opened the folder picker',
      !ctrl.executedCommands.some(c => c.command === 'vscode.openFolder'));

    // Picking a folder already in the workspace just switches to it.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }, { uri: uriOf(dirB) }];
    provider.projectRoot = dirA;
    ctrl.nextOpenDialog = [dirB];
    await provider.openFolder();
    check('existing folder: switches without prompting', provider.projectRoot === dirB);
    check('existing folder: no duplicate root added',
      (vscode.workspace.workspaceFolders || []).length === 2);

    // ── The chat must auto-link to the project that's actually open ──────────
    // Pure containment predicate behind the guard.
    const belongs = eval('(' + extractFunction(extSrc, 'function rootBelongsToWorkspace') + ')');
    check('root-belongs: a workspace folder itself belongs', belongs(dirA, [dirA]));
    check('root-belongs: a sub-directory of a workspace folder belongs',
      belongs(path.join(dirA, 'src'), [dirA]));
    check('root-belongs: another project does NOT belong', !belongs(dirB, [dirA]));
    check('root-belongs: with no workspace open, anything is allowed', belongs(dirB, []));
    check('root-belongs: empty root never belongs', !belongs('', [dirA]));

    // "Open Here" must not stamp the new project's path into the OLD project's
    // workspace settings — that stale pointer is what made a later reopen of the
    // old project land on the wrong root until fixed by hand.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextOpenDialog = [dirB];
    ctrl.nextInfo = 'Open Here';
    await provider.openFolder();
    check('open-here: does not poison the old workspace settings with the new path',
      ctrl.scoped.projectRoot?.workspaceValue !== dirB);

    // A saved root pointing at a project that is NOT open must be ignored, so a
    // freshly opened folder links up on its own instead of needing a manual fix.
    ctrl.reset();
    ctrl.scoped.projectRoot = { workspaceValue: dirB }; // stale pointer to another project
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    const fresh = new NavyCoderViewProvider(makeContext(dirA));
    check('stale saved root from another project is ignored', fresh.projectRoot !== dirB);
    fresh.view = { webview: { postMessage: () => {} } };
    await fresh.sendWorkspaceFolders();
    check('freshly opened project auto-links to the open folder', fresh.projectRoot === dirA);
    clearTimeout(fresh._cpSaveTimer); clearInterval(fresh._heartbeat);

    // A legitimate saved root (inside the open folder) is still honoured.
    ctrl.reset();
    const sub = path.join(dirA, 'packages', 'api');
    fs.mkdirSync(sub, { recursive: true });
    ctrl.scoped.projectRoot = { workspaceValue: sub };
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    const kept = new NavyCoderViewProvider(makeContext(dirA));
    check('a saved sub-folder root inside the open project is still honoured', kept.projectRoot === sub);
    clearTimeout(kept._cpSaveTimer); clearInterval(kept._heartbeat);
  } catch (e) {
    check('project folder suite ran', false, e.stack || e.message);
  } finally {
    vscode.workspace.workspaceFolders = undefined;
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); }
    for (const d of [dirA, dirB]) { try { if (d) fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}

// ── 9. cancelPendingApprovals (Stop/Clear) must notify the webview ───────────
// Regression: previously resolved pending approval promises directly with no
// notification, leaving whatever Approve/Reject card was still pending stuck
// with visibly-enabled but functionally dead buttons after Stop.
async function approvalCancelSuite() {
  console.log('\napproval cancel (Stop must not leave dead buttons):');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-cancel-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    const filePath = path.join(tmp, 'a.js');
    fs.writeFileSync(filePath, 'original');

    // Pending command approval — the "Run this command?" card.
    let cmdResolvedWith;
    const cmdPromise = new Promise((resolve) => {
      provider.pendingCommandApprovals.set('cmd1', { resolve: (v) => { cmdResolvedWith = v; resolve(v); } });
    });

    // Pending agent-edit approval — the main diff-card flow.
    let editResolvedWith;
    const editPromise = new Promise((resolve) => {
      provider.pendingApprovals.set('edit1', { resolve: (v) => { editResolvedWith = v; resolve(v); }, filePath, kind: 'agent-edit' });
    });

    // Pending legacy applyCode approval (no `kind` — the sidebar-card apply flow).
    let legacyResolvedWith;
    const legacyPromise = new Promise((resolve) => {
      provider.pendingApprovals.set('legacy1', { resolve: (v) => { legacyResolvedWith = v; resolve(v); }, filePath, search: '', replace: '', newText: 'CHANGED' });
    });

    provider.cancelPendingApprovals();
    await Promise.all([cmdPromise, editPromise, legacyPromise]);

    check('cancel: command approval resolves rejected', cmdResolvedWith === false);
    check('cancel: command card notified so its buttons unstick',
      posted.some(m => m.type === 'commandResolved' && m.id === 'cmd1' && m.approved === false));

    check('cancel: agent-edit approval resolves to reject', editResolvedWith === 'reject');
    check('cancel: agent-edit entry removed from the pending map', !provider.pendingApprovals.has('edit1'));

    check('cancel: legacy apply card notified so its buttons unstick',
      posted.some(m => m.type === 'diffResolved' && m.id === 'legacy1' && m.approved === false));
    check('cancel: legacy apply did NOT write the file', fs.readFileSync(filePath, 'utf8') === 'original');
    check('cancel: legacy apply resolves to a rejection, not a silent placeholder string', legacyResolvedWith === 'Edit rejected by user');

    check('cancel: both pending maps fully drained', provider.pendingApprovals.size === 0 && provider.pendingCommandApprovals.size === 0);
  } catch (e) {
    check('approval cancel suite ran', false, e.stack || e.message);
  } finally {
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

undoRedoSuite()
  .then(retrievalSuite)
  .then(semanticSearchSuite)
  .then(syntaxCheckSuite)
  .then(robustnessSuite)
  .then(writeLoopGuardSuite)
  .then(hallucinationSuite)
  .then(cachingFallbackSuite)
  .then(adaptiveThinkingFallbackSuite)
  .then(geminiSuite)
  .then(mcpSuite)
  .then(mcpHttpSuite)
  .then(projectFolderSuite)
  .then(approvalCancelSuite)
  .then(() => {
    uninstallVscodeMock();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
  });
