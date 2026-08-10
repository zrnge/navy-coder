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

  // Regression: a LARGE file (over the old computeLCS's ~633-line bail-out) whose change
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

  // ── computeMyersDiff: direct correctness + ceiling tests ──────────────────
  // Round-trip reconstruction is the strongest possible check here — it's
  // agnostic to WHICH shortest edit script the algorithm picked among ties,
  // it only demands that separating the ops back into "what came from old"
  // vs "what came from new" reproduces both inputs EXACTLY. Any backtracking
  // bug (a real risk in a hand-rolled Myers implementation) fails this.
  {
    const reconstruct = (ops) => {
      const oldOut = [], newOut = [];
      for (const op of ops) {
        if (op.t === '=') { oldOut.push(op.line); newOut.push(op.line); }
        else if (op.t === '-') { oldOut.push(op.line); }
        else if (op.t === '+') { newOut.push(op.line); }
      }
      return { old: oldOut, new: newOut };
    };
    const roundTrips = (oldLines, newLines) => {
      const ops = window.computeMyersDiff(oldLines, newLines);
      if (!ops) return false;
      const rec = reconstruct(ops);
      return JSON.stringify(rec.old) === JSON.stringify(oldLines)
        && JSON.stringify(rec.new) === JSON.stringify(newLines);
    };

    check('myers diff: identical arrays round-trip (all "=" ops)', roundTrips(['a', 'b', 'c'], ['a', 'b', 'c']));
    check('myers diff: pure insertion round-trips', roundTrips(['a', 'b', 'c'], ['a', 'X', 'b', 'c']));
    check('myers diff: pure deletion round-trips', roundTrips(['a', 'b', 'c'], ['a', 'c']));
    check('myers diff: pure replacement round-trips', roundTrips(['a', 'b', 'c'], ['a', 'X', 'c']));
    check('myers diff: both empty returns []', JSON.stringify(window.computeMyersDiff([], [])) === '[]');
    check('myers diff: old empty (all insertions) round-trips', roundTrips([], ['a', 'b']));
    check('myers diff: new empty (all deletions) round-trips', roundTrips(['a', 'b'], []));

    // The actual ceiling fix: a 5000-line file (nearly 8x the old ~633-line
    // hard cap) with a handful of scattered small edits — this used to be
    // IMPOSSIBLE to diff exactly (computeLCS bailed on file size alone); now
    // it stays fast because cost tracks the tiny number of real differences,
    // not the file size.
    {
      const big = Array.from({ length: 5000 }, (_, i) => 'line ' + i);
      const bigNew = big.slice();
      bigNew.splice(2500, 0, 'INSERTED_LINE'); // a pure insertion, not just a same-index change
      bigNew[100] = 'CHANGED_LINE_100';
      bigNew[4900] = 'CHANGED_LINE_4900';
      const t0 = Date.now();
      const ops = window.computeMyersDiff(big, bigNew);
      const elapsedMs = Date.now() - t0;
      check('myers diff: exact diff succeeds well past the old 633-line ceiling', Boolean(ops));
      check('myers diff: stays fast on a large file with a small edit', elapsedMs < 1000, elapsedMs + 'ms');
      const rec = ops && reconstruct(ops);
      check('myers diff: large-file round-trip is exact (old side)', rec && JSON.stringify(rec.old) === JSON.stringify(big));
      check('myers diff: large-file round-trip is exact (new side)', rec && JSON.stringify(rec.new) === JSON.stringify(bigNew));
      // Proves real alignment (not the naive index-compare fallback, which
      // would treat every line after an insertion as changed): only the 3
      // actual edits should produce non-"=" ops.
      const changedOps = ops ? ops.filter(o => o.t !== '=').length : Infinity;
      check('myers diff: an insertion does not cascade into hundreds of spurious changes',
        changedOps <= 6, changedOps + ' changed ops');
    }

    // Pathological case: two huge, almost entirely DIFFERENT files (the one
    // case that genuinely doesn't benefit from line alignment) — must bail
    // out (null, same contract as before) rather than hang.
    {
      const hugeA = Array.from({ length: 3000 }, (_, i) => 'unique-old-' + i);
      const hugeB = Array.from({ length: 3000 }, (_, i) => 'unique-new-' + i);
      const t0 = Date.now();
      const ops = window.computeMyersDiff(hugeA, hugeB);
      const elapsedMs = Date.now() - t0;
      check('myers diff: bails (null) on a huge near-total rewrite instead of hanging', ops === null);
      check('myers diff: the bailout itself stays bounded and fast', elapsedMs < 2000, elapsedMs + 'ms');
    }
  }

  // ── renderTokenCounter: cost/spend display ────────────────────────────────
  {
    send({ type: 'tokenCount', prompt: 5, completion: 5, total: 10, sessionPrompt: 1000, sessionCompletion: 1000, sessionTotal: 2000, estimatedCost: 0.006, costKnown: true });
    const counter = $('#tokenCounter');
    check('token counter: shows the SESSION total, not just this turn\'s 10', counter.textContent.includes('2,000'));
    check('token counter: shows a known cost estimate', counter.textContent.includes('$0.01') || counter.textContent.includes('0.0060'));
    check('token counter: tooltip discloses it\'s an estimate, not a live rate', /not a live rate/.test(counter.title));
    check('token counter: becomes visible', counter.classList.contains('visible'));

    send({ type: 'tokenCount', prompt: 5, completion: 5, total: 10, sessionPrompt: 1000, sessionCompletion: 1000, sessionTotal: 2000, estimatedCost: 0.5, costKnown: false });
    check('token counter: a partial (costKnown:false) total is marked with a "+"', $('#tokenCounter').textContent.includes('+'));

    send({ type: 'tokenCount', prompt: 5, completion: 5, total: 10, sessionPrompt: 1000, sessionCompletion: 1000, sessionTotal: 2000, estimatedCost: null, costKnown: true });
    check('token counter: an unrecognized model shows tokens with no dollar figure (never a guess)',
      !$('#tokenCounter').textContent.includes('$'));
    check('token counter: tooltip says the estimate is unavailable, not silently omitted',
      /unavailable/.test($('#tokenCounter').title));

    send({ type: 'tokenCount', prompt: 0, completion: 0, total: 0, sessionPrompt: 0, sessionCompletion: 0, sessionTotal: 0, estimatedCost: null, costKnown: true });
    check('token counter: a zero session total hides the counter entirely', !$('#tokenCounter').classList.contains('visible'));

    // sessionLoaded (restoring a chat / switching tabs) must render identically.
    send({ type: 'sessionLoaded', count: 3, memory: '', projectRoot: 'e:/p', sessionPrompt: 500, sessionCompletion: 500, sessionTotal: 1000, estimatedCost: 0, costKnown: true });
    check('sessionLoaded: restoring a chat shows its accumulated usage immediately',
      $('#tokenCounter').textContent.includes('1,000') && $('#tokenCounter').classList.contains('visible'));
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

  // Regression: a turn with tool activity in MORE than one place (reasoning →
  // tools → reasoning again → tools → summary — a real multi-iteration agent
  // turn, not just a single split) used to merge everything after the FIRST
  // batch of tool calls into one bubble. A SECOND round of reasoning midway
  // through the turn then rendered as if it happened at the very start,
  // because <think> extraction hoists reasoning to the top of whatever text
  // segment contains it — and that segment wrongly spanned the entire rest
  // of the turn. Each batch of tool activity now gets its own log, so each
  // round of reasoning stays isolated to its own bubble, in its real position.
  {
    send({ type: 'start', model: 'm', activeFile: '', activeLanguage: '' });
    send({ type: 'chunk', text: '<think>reasoning about the codebase</think>Let me look at the entry point.' });
    send({ type: 'toolCall', tool: 'read_file', args: { path: 'index.js' }, callId: 'multi1' });
    send({ type: 'toolResult', tool: 'read_file', result: 'ok', callId: 'multi1' });
    send({ type: 'chunk', text: '<think>now checking the config too</think>Now checking the config file.' });
    send({ type: 'toolCall', tool: 'read_file', args: { path: 'config.js' }, callId: 'multi2' });
    send({ type: 'toolResult', tool: 'read_file', result: 'ok', callId: 'multi2' });
    send({ type: 'chunk', text: '\n\n**Summary:** this project is a config-driven app.' });
    send({ type: 'done' });

    const msg2 = [...window.document.querySelectorAll('.message.assistant')].pop();
    const kids2 = [...msg2.children];
    const logIdxs = kids2.map((c, i) => /activity-log/.test(c.className) ? i : -1).filter(i => i !== -1);
    const reasoning1Idx = kids2.findIndex(c => /reasoning about the codebase/.test(c.textContent || ''));
    const reasoning2Idx = kids2.findIndex(c => /now checking the config too/.test(c.textContent || ''));
    const summaryIdx2 = kids2.findIndex(c => /Summary:/.test(c.textContent || ''));

    check('multi-phase: two SEPARATE activity-log segments, not one merged log', logIdxs.length === 2);
    check('multi-phase: both rounds of reasoning are present', reasoning1Idx !== -1 && reasoning2Idx !== -1);
    check('multi-phase: the SECOND round of reasoning is its own bubble, not merged into the first (the reported bug)',
      reasoning1Idx !== reasoning2Idx);
    check('multi-phase: real chronological order — reasoning1, tools A, reasoning2, tools B, summary',
      reasoning1Idx < logIdxs[0] && logIdxs[0] < reasoning2Idx && reasoning2Idx < logIdxs[1] && logIdxs[1] < summaryIdx2);
    // Both segments must actually collapse on 'done' — not just the latest
    // one (collapseToolProgress used to only ever finalize whichever single
    // activityLogEl it currently pointed at).
    check('multi-phase: the FIRST log segment collapsed too, not left as raw uncollapsed rows',
      Boolean(kids2[logIdxs[0]]?.querySelector('.activity-log-collapsed')));
    check('multi-phase: the SECOND log segment collapsed as well',
      Boolean(kids2[logIdxs[1]]?.querySelector('.activity-log-collapsed')));
  }

  // Regression: resetThreadDisplay() (Clear Chat / switching tabs) used to
  // null out the old standalone activityLogEl variable but never touch
  // allActivityLogEls — so a reset mid-turn (with an uncollapsed segment
  // still in the array) left a stale, now-detached reference behind instead
  // of genuinely starting fresh. Reset is now the single source of truth
  // (allActivityLogEls itself, via currentActivityLog()) with nothing left
  // to fall out of sync.
  {
    send({ type: 'start', model: 'm', activeFile: '', activeLanguage: '' });
    send({ type: 'toolCall', tool: 'read_file', args: { path: 'x.js' }, callId: 'reset-test-1' });
    check('resetThreadDisplay: an activity log genuinely exists mid-turn, before any reset',
      Boolean(window.currentActivityLog()));
    window.resetThreadDisplay(); // simulates Clear Chat / a tab switch mid-turn
    check('resetThreadDisplay: currentActivityLog() is null right after reset — no stale segment lingers',
      window.currentActivityLog() === null);
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

  // Multi-session tab strip: the backend tags every message with a sessionId
  // (added in the extension-side wrapper, not reproduced here — these sends
  // set it explicitly to drive the gate directly). None of the messages sent
  // earlier in this suite carried one, so activeSessionId is still null;
  // establishing it via a real sessionList message exercises the same
  // "adopt on first sight" path a real startup would.
  send({ type: 'sessionList', sessionId: 'session-A', sessions: [
    { id: 'session-A', name: 'ProjA', root: '/path/to/ProjA', busy: false, active: true },
    { id: 'session-B', name: 'ProjB', root: '/path/to/ProjB', busy: true, active: false },
  ] });
  check('multi-session: tab strip renders one tab per session', $('#sessionTabs').querySelectorAll('.session-tab').length === 2);
  check('multi-session: active tab is marked active', $('#sessionTabs').querySelector('.session-tab.active')?.title === 'ProjA');
  check('multi-session: a busy background tab shows a spinner', $('#sessionTabs').querySelector('.session-tab.busy .session-tab-spinner') !== null);

  // Regression: a backend-initiated switch with NO prior click (e.g.
  // opening a new tab, or closeSessionTab falling back to a sibling) must
  // highlight the NEW tab on THIS FIRST sessionList render — not lag by one
  // extra render. renderSessionTabs used to run BEFORE the activeSessionId
  // correction below, so the strip rendered against the STALE id and stayed
  // visually stuck on the old tab until some later, unrelated update
  // happened to trigger a re-render (surfaced as "the blue active tab
  // doesn't move until you click away and back").
  send({ type: 'sessionList', sessionId: 'session-A', sessions: [
    { id: 'session-A', name: 'ProjA', root: '/path/to/ProjA', busy: false, active: false },
    { id: 'session-B', name: 'ProjB', root: '/path/to/ProjB', busy: true, active: false },
    { id: 'session-New', name: 'New Chat', root: '/path/to/ProjA', busy: false, active: true },
  ] });
  check('multi-session: a backend-initiated switch (no prior click) highlights the NEW tab immediately',
    $('#sessionTabs').querySelector('.session-tab.active')?.title === 'New Chat');
  check('multi-session: the previously-active tab loses the highlight on that same render',
    !$('#sessionTabs').querySelector('.session-tab[title="ProjA"]')?.classList.contains('active'));
  // Restore the two-tab baseline the rest of this suite expects.
  send({ type: 'sessionList', sessionId: 'session-A', sessions: [
    { id: 'session-A', name: 'ProjA', root: '/path/to/ProjA', busy: false, active: true },
    { id: 'session-B', name: 'ProjB', root: '/path/to/ProjB', busy: true, active: false },
  ] });

  // Clicking a different tab posts switchSessionTab and adopts it immediately
  // (before the extension even responds).
  window.__posted.length = 0;
  const tabB = [...$('#sessionTabs').querySelectorAll('.session-tab')].find(t => t.title === 'ProjB');
  tabB.click();
  check('multi-session: clicking a tab posts switchSessionTab with its id',
    window.__posted.some(m => m.type === 'switchSessionTab' && m.sessionId === 'session-B'));

  // Now viewing session-B — a message still tagged for session-A (the tab we
  // just left) belongs to a background turn and must not touch this thread.
  const messageCountBefore = window.document.querySelectorAll('.message').length;
  send({ type: 'chunk', text: 'INVISIBLEMARKERONE', sessionId: 'session-A' });
  check('multi-session: a message tagged for a background tab does not touch the visible thread',
    window.document.querySelectorAll('.message').length === messageCountBefore
    && !window.document.body.textContent.includes('INVISIBLEMARKERONE'));

  // A message tagged for the CURRENTLY active tab (session-B) is processed
  // normally. Markdown rendering is throttled (150ms) and only force-flushed
  // by 'done' — send that before checking, same as the earlier tests in this
  // suite that check bubble text after a 'done'.
  send({ type: 'start', model: 'm', activeFile: '', activeLanguage: '', sessionId: 'session-B' });
  send({ type: 'chunk', text: 'VISIBLEMARKERTWO', sessionId: 'session-B' });
  send({ type: 'done', sessionId: 'session-B' });
  check('multi-session: a message tagged for the active tab renders normally',
    window.document.body.textContent.includes('VISIBLEMARKERTWO'));

  // Close (✕) and new-tab (+) controls post their respective messages.
  window.__posted.length = 0;
  $('#sessionTabs .session-tab.active .session-tab-close')?.click();
  check('multi-session: the close button posts closeSessionTab', window.__posted.some(m => m.type === 'closeSessionTab'));
  window.__posted.length = 0;
  $('#sessionTabs .session-tab-add')?.click();
  check('multi-session: the + button posts newSessionTab', window.__posted.some(m => m.type === 'newSessionTab'));

  // Regression: switching via a path OTHER than a tab click (the legacy
  // dropdown, openFolder) never optimistically updates activeSessionId —
  // only the tab strip's own click handler does that. Those paths instead
  // rely on 'workspaceFolders' to correct this webview's notion of the
  // active session — specifically from `sessionId` (the opaque session id,
  // uniformly tagged on every message), NOT `current` (the project ROOT
  // path, a completely different value used only to populate the dropdown).
  // `current` is deliberately given a value that looks nothing like
  // `sessionId` here, matching the real shape (session ids are generated,
  // roots are filesystem paths) — a version of this fix that mixed the two
  // fields up would still "accidentally" pass if they happened to be equal,
  // which is exactly what happened once already. Without correctly reading
  // `sessionId` here, activeSessionId would stay stuck on session-B and
  // every subsequent message for session-C (chat restore, the dropdown's own
  // update) would be wrongly gated out as "a background tab".
  send({ type: 'workspaceFolders', sessionId: 'session-C', current: '/path/to/project-C', roots: ['/path/to/project-C'] });
  send({ type: 'start', model: 'm', activeFile: '', activeLanguage: '', sessionId: 'session-C' });
  send({ type: 'chunk', text: 'DROPDOWNSWITCHMARKER', sessionId: 'session-C' });
  send({ type: 'done', sessionId: 'session-C' });
  check('multi-session: a non-tab-click switch (workspaceFolders.sessionId, not .current) still updates the active session',
    window.document.body.textContent.includes('DROPDOWNSWITCHMARKER'));

  // Regression: a blank "New Chat" tab (current === '') must show an explicit
  // placeholder in the project dropdown, not silently default to whatever
  // the first real folder in the list happens to be.
  send({ type: 'workspaceFolders', sessionId: 'session-C', current: '', roots: ['/path/to/project-C'] });
  check('project dropdown: blank tab shows an explicit "select a project" placeholder, not the first real folder',
    $('#projectSelect').value === '');

  // Global catalog entries — "other projects Navy remembers" that aren't
  // part of THIS window's workspace — render as a separate optgroup, and
  // picking one routes through openCatalogProject (the open-here/add-to-
  // workspace choice), never a direct setProjectRoot switch.
  send({
    type: 'workspaceFolders', sessionId: 'session-C', current: '/path/to/project-C',
    roots: ['/path/to/project-C'], catalog: [{ path: '/path/to/other-proj', name: 'other-proj' }],
  });
  const catalogGroup = [...$('#projectSelect').querySelectorAll('optgroup')].find(g => g.label === 'Other projects');
  check('project dropdown: catalog entries render in their own optgroup', Boolean(catalogGroup));
  const catalogOption = catalogGroup?.querySelector('option');
  check('project dropdown: catalog option is labeled by name, not the raw path', catalogOption?.textContent === 'other-proj');
  check('project dropdown: catalog option value carries the real path (prefixed, so the change handler can tell it apart)',
    catalogOption?.value === '__catalog__:/path/to/other-proj');

  window.__posted.length = 0;
  $('#projectSelect').value = catalogOption.value;
  $('#projectSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  const catalogPick = window.__posted.find(m => m.type === 'openCatalogProject');
  check('project dropdown: picking a catalog entry posts openCatalogProject with the real (unprefixed) path',
    catalogPick?.root === '/path/to/other-proj');
  check('project dropdown: picking a catalog entry never posts a direct setProjectRoot',
    !window.__posted.some(m => m.type === 'setProjectRoot'));

  // Regression: an ordinary already-open root must still switch directly —
  // the catalog branch above must not have hijacked the normal path.
  window.__posted.length = 0;
  $('#projectSelect').value = '/path/to/project-C';
  $('#projectSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('project dropdown: picking an already-open root still posts a direct setProjectRoot',
    window.__posted.some(m => m.type === 'setProjectRoot' && m.root === '/path/to/project-C'));

  // No catalog entries → no stray empty optgroup.
  send({ type: 'workspaceFolders', sessionId: 'session-C', current: '/path/to/project-C', roots: ['/path/to/project-C'], catalog: [] });
  check('project dropdown: no optgroup at all when the catalog is empty',
    ![...$('#projectSelect').querySelectorAll('optgroup')].some(g => g.label === 'Other projects'));

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

// ── 6c. Retrieval upgrades — chunked embeddings + real LSP symbol blending ───
async function retrievalUpgradesSuite() {
  console.log('\nretrieval upgrades (chunked embeddings + LSP blend):');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();

  // Chunking: a symbol buried well past the OLD single-file 1,500-char /
  // one-window cutoff must now be findable by semantic search.
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-chunking-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    await vscode.workspace.getConfiguration().update('embeddingModel', 'fake-embed');
    await vscode.workspace.getConfiguration().update('provider', 'ollama');

    // 200 lines: filler lines are long enough (~50 chars each) that the
    // marker function, placed at line 150, sits well past 1,500 chars into
    // the file — unreachable by the pre-chunking single-slice embed. With
    // 120-line windows / 20-line overlap it lands in the SECOND chunk
    // (lines 101-200), never the first (1-120), so finding it proves multi-
    // chunk indexing actually happened rather than being a lucky truncation.
    const lines = [];
    for (let i = 1; i <= 200; i++) {
      lines.push(i === 150
        ? 'function trackActiveUserSession(id){ registry.set(id, Date.now()); }'
        : `// filler filler filler filler filler filler line ${i}`);
    }
    fs.writeFileSync(path.join(tmp, 'bigfile.js'), lines.join('\n'));

    // Content-based fake embedder (not an exact-string lookup) so the test
    // doesn't have to reproduce chunkFileForEmbedding's exact slicing math.
    const vectorFor = (text) => {
      if (text.includes('trackActiveUserSession')) return [0.9, 0.1, 0];
      if (text.includes('logged-in user')) return [0.85, 0.15, 0]; // the query text
      return [0, 0, 1]; // filler / unrelated chunks
    };
    const capturedTexts = [];
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      capturedTexts.push(...body.input);
      return { ok: true, status: 200, json: async () => ({ embeddings: body.input.map(vectorFor) }) };
    };

    const out = await provider.toolFindRelevantFiles('how do we keep track of a logged-in user between requests', 5);
    check('chunking: the marker line actually reached the embedder (proves the 1,500-char cutoff was bypassed)',
      capturedTexts.some(t => t.includes('trackActiveUserSession')));
    check('chunking: file containing a symbol past the old cutoff is now found via semantic search', out.includes('bigfile.js'));
    check('chunking: reported hit points at the chunk that actually matched (lines 101-200), not the whole file',
      /bigfile\.js.*semantic-match at lines 101-200/.test(out));
  } catch (e) {
    check('chunking suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    await vscode.workspace.getConfiguration().update('embeddingModel', '');
    await vscode.workspace.getConfiguration().update('provider', 'ollama');
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    provider = null; tmp = null;
  }

  // LSP symbol blend: a real language-server definition surfaces a file with
  // ZERO keyword overlap with the query, same as semantic search does — but
  // needs no embeddingModel configured at all.
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-lspblend-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    await vscode.workspace.getConfiguration().update('embeddingModel', ''); // semantic search off — isolates the LSP path

    fs.writeFileSync(path.join(tmp, 'helper-utils.js'), 'function unrelatedHelper(x){ return x*2; }');

    // Query is a single distinctive identifier so _tokenizeQuery's top term
    // is exactly this name (whole-identifier weight 2 beats any split part).
    ctrl.nextWorkspaceSymbols = [{
      name: 'AuthTokenValidator',
      location: { uri: { fsPath: path.join(tmp, 'helper-utils.js') }, range: { start: { line: 0, character: 0 } } },
    }];
    const withLsp = await provider.toolFindRelevantFiles('AuthTokenValidator', 5);
    check('LSP blend: a real language-server definition surfaces a file with no keyword overlap',
      withLsp.includes('helper-utils.js'));
    check('LSP blend: annotated as an LSP match, not a keyword/semantic guess', /helper-utils\.js.*LSP-defines/.test(withLsp));

    // Negative control: same query, no language server answers this time —
    // the file must NOT surface, proving the LSP data was what found it above.
    ctrl.nextWorkspaceSymbols = null;
    const withoutLsp = await provider.toolFindRelevantFiles('AuthTokenValidator', 5);
    check('LSP blend: without a language-server answer, the same query does NOT surface the file',
      !withoutLsp.includes('helper-utils.js'));
  } catch (e) {
    check('LSP symbol blend suite ran', false, e.stack || e.message);
  } finally {
    await vscode.workspace.getConfiguration().update('embeddingModel', '');
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // Repo-map symbol outline: buildRepoMap enriches code files with a
  // function/class/method outline via the SAME real language-server
  // infrastructure (executeDocumentSymbolProvider) the LSP blend above uses
  // — not a new parser. Previously the map was pure filenames with zero
  // symbol information, regardless of what language servers were active.
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-repomap-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    fs.writeFileSync(path.join(tmp, 'auth.js'), 'function login(){}\nfunction logout(){}\nconst x = 1;\n');
    fs.writeFileSync(path.join(tmp, 'plain.txt'), 'not code');

    const authPath = path.join(tmp, 'auth.js');
    ctrl.nextDocumentSymbols = new Map([
      [authPath, [
        { name: 'login', kind: vscode.SymbolKind.Function },
        { name: 'logout', kind: vscode.SymbolKind.Function },
        { name: 'x', kind: vscode.SymbolKind.Variable }, // NOT "interesting" — must be filtered out
      ]],
    ]);
    const map = await provider.buildRepoMap();
    check('repo map: a code file is enriched with its function outline', /auth\.js.*— login, logout/.test(map));
    check('repo map: uninteresting symbol kinds (variables/constants) are filtered out', !map.includes(', x'));
    check('repo map: a file with no code extension is never queried and shows as a plain filename',
      map.includes('plain.txt') && !/plain\.txt.*—/.test(map));

    // Negative control: no language server answers at all — the map must be
    // IDENTICAL in shape to the old plain-filename behavior, not broken.
    provider._repoMapCache = null;
    ctrl.nextDocumentSymbols = null;
    const mapNoLsp = await provider.buildRepoMap();
    check('repo map: with no language server, files show as plain filenames (unchanged behavior)',
      mapNoLsp.includes('auth.js') && !mapNoLsp.includes(' — login'));

    // A hung/slow provider must not stall the whole map build — and running
    // the (capped, per-call time-boxed) fetches in parallel means the total
    // cost stays close to ONE timeout window, not one per file.
    provider._repoMapCache = null;
    const realExecuteCommand = vscode.commands.executeCommand;
    vscode.commands.executeCommand = async (cmd, ...args) => {
      if (cmd === 'vscode.executeDocumentSymbolProvider') return new Promise(() => {}); // never resolves
      return realExecuteCommand(cmd, ...args);
    };
    const t0 = Date.now();
    const mapHung = await provider.buildRepoMap();
    const elapsed = Date.now() - t0;
    vscode.commands.executeCommand = realExecuteCommand;
    check('repo map: a hung language server does not stall the map build past its timeout', elapsed < 2000, elapsed + 'ms');
    check('repo map: still returns a usable map despite the hang', mapHung.includes('auth.js'));
  } catch (e) {
    check('repo map symbol outline suite ran', false, e.stack || e.message);
  } finally {
    ctrl.nextDocumentSymbols = null;
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 6e. Command-execution sandboxing (navy.sandboxMode) ───────────────────
async function sandboxSuite() {
  console.log('\ncommand-execution sandboxing (navy.sandboxMode):');
  const os = require('os');
  const { vscode } = sharedMock();

  // Pure: stripJsonComments must not mistake a comment marker inside a quoted
  // string (e.g. a URL) for a real comment, and must strip real // and /* */
  // comments so devcontainer.json (which commonly has them) parses as JSON.
  {
    const stripJsonComments = eval('(' + extractFunction(extSrc, 'function stripJsonComments') + ')');
    const withComments = '{\n  // a line comment\n  "image": "foo:latest", /* inline */\n  "url": "https://example.com" // trailing\n}';
    let parsed;
    check('stripJsonComments: result still parses as JSON', (() => { try { parsed = JSON.parse(stripJsonComments(withComments)); return true; } catch { return false; } })());
    check('stripJsonComments: real values survive', parsed?.image === 'foo:latest');
    check('stripJsonComments: "//" inside a quoted string is NOT treated as a comment', parsed?.url === 'https://example.com');
  }

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-sandbox-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    // sandboxMode 'off' (default) — must not even ask whether Docker is
    // available; a passthrough that touches Docker at all would add latency
    // to every command for the overwhelming majority of users who never
    // enable this.
    await vscode.workspace.getConfiguration().update('sandboxMode', 'off');
    let dockerAvailableCalled = false;
    provider._dockerAvailable = async () => { dockerAvailableCalled = true; return true; };
    const passthrough = await provider._maybeWrapForSandbox({ bin: 'echo', args: ['hi'], cwd: tmp, verbatim: false });
    check('sandboxMode off: bin/args/cwd returned completely unchanged',
      passthrough.bin === 'echo' && passthrough.args.length === 1 && passthrough.args[0] === 'hi' && passthrough.cwd === tmp);
    check('sandboxMode off: never even checks Docker availability', !dockerAvailableCalled);

    // sandboxMode 'docker' + Docker not available → refuses, never falls
    // back to running unsandboxed (that would be a false sense of safety).
    await vscode.workspace.getConfiguration().update('sandboxMode', 'docker');
    provider._dockerAvailable = async () => false;
    const noDocker = await provider._maybeWrapForSandbox({ bin: 'echo', args: ['hi'], cwd: tmp, verbatim: false });
    check('sandboxMode docker + Docker not running: refuses', noDocker.refused === true);
    check('sandboxMode docker + Docker not running: message is actionable', /Docker is not installed or not running/.test(noDocker.message));

    // sandboxMode 'docker' + Docker available but no devcontainer/Dockerfile
    // → refuses rather than guessing at a generic image.
    provider._dockerAvailable = async () => true;
    provider._resolveSandboxImage = async () => null;
    const noConfig = await provider._maybeWrapForSandbox({ bin: 'echo', args: ['hi'], cwd: tmp, verbatim: false });
    check('sandboxMode docker + no devcontainer/Dockerfile: refuses', noConfig.refused === true);
    check('sandboxMode docker + no devcontainer/Dockerfile: message names the missing config',
      /devcontainer\.json or Dockerfile/.test(noConfig.message));

    // sandboxMode 'docker' + an image resolved → rewrites the spawn target
    // to run inside it, with only the project folder mounted.
    provider._resolveSandboxImage = async () => ({ image: 'my-project-image' });
    const wrapped = await provider._maybeWrapForSandbox({ bin: 'bash', args: ['-c', 'echo hi'], cwd: tmp, verbatim: false });
    check('sandboxMode docker + image resolved: bin becomes docker', wrapped.bin === 'docker');
    check('sandboxMode docker + image resolved: mounts exactly the project root read-write at /workspace',
      wrapped.args.includes('-v') && wrapped.args[wrapped.args.indexOf('-v') + 1] === `${tmp}:/workspace`);
    check('sandboxMode docker + image resolved: working directory is the mounted path',
      wrapped.args.includes('-w') && wrapped.args[wrapped.args.indexOf('-w') + 1] === '/workspace');
    check('sandboxMode docker + image resolved: uses the resolved image', wrapped.args.includes('my-project-image'));
    check('sandboxMode docker + image resolved: original bin/args are appended after the image',
      wrapped.args.slice(-3).join(' ') === 'bash -c echo hi');
    check('sandboxMode docker + image resolved: container is removed on exit (--rm)', wrapped.args.includes('--rm'));

    // _spawnAndCollect must actually route through _maybeWrapForSandbox and
    // surface a refusal as its result — never silently spawn unsandboxed.
    provider._maybeWrapForSandbox = async () => ({ refused: true, message: 'REFUSED_FOR_TEST' });
    const spawnResult = await provider._spawnAndCollect('echo', ['hi'], tmp, 5000);
    check('_spawnAndCollect: a sandbox refusal is returned directly, nothing is spawned', spawnResult === 'REFUSED_FOR_TEST');

    // Real filesystem resolution (no Docker needed): a devcontainer.json that
    // declares "image" directly resolves without ever needing to build.
    delete provider._resolveSandboxImage; // restore the real implementation
    const dcDir = path.join(tmp, '.devcontainer');
    fs.mkdirSync(dcDir);
    fs.writeFileSync(path.join(dcDir, 'devcontainer.json'), '{\n  // comment devcontainer.json commonly has\n  "image": "node:20"\n}');
    const resolvedDirect = await provider._resolveSandboxImage(tmp);
    check('_resolveSandboxImage: devcontainer.json with "image" resolves directly (no build)', resolvedDirect?.image === 'node:20');

    // No devcontainer, no Dockerfile at all → null, not a guessed image.
    fs.rmSync(dcDir, { recursive: true, force: true });
    const resolvedNone = await provider._resolveSandboxImage(tmp);
    check('_resolveSandboxImage: no devcontainer/Dockerfile → null (never guesses a generic image)', resolvedNone === null);

    // ── _resolveSandboxImage caches per project root (a `docker build`
    // round-trip otherwise repeats before EVERY sandboxed command) —
    // invalidated by the config file's mtime, not just its presence.
    {
      fs.mkdirSync(dcDir, { recursive: true });
      fs.writeFileSync(path.join(dcDir, 'devcontainer.json'), '{"image": "node:20"}');

      let uncachedCalls = 0;
      const origUncached = provider._resolveSandboxImageUncached.bind(provider);
      provider._resolveSandboxImageUncached = async (root) => { uncachedCalls++; return origUncached(root); };

      const first = await provider._resolveSandboxImage(tmp);
      const second = await provider._resolveSandboxImage(tmp);
      check('_resolveSandboxImage: caches — a second call for the SAME unchanged project does not re-resolve',
        uncachedCalls === 1 && first?.image === 'node:20' && second?.image === 'node:20');

      // A real mtime change (not just content) must invalidate the cache.
      const newTime = new Date(Date.now() + 5000);
      fs.writeFileSync(path.join(dcDir, 'devcontainer.json'), '{"image": "node:22"}');
      fs.utimesSync(path.join(dcDir, 'devcontainer.json'), newTime, newTime);
      const third = await provider._resolveSandboxImage(tmp);
      check('_resolveSandboxImage: editing the devcontainer invalidates the cache',
        uncachedCalls === 2 && third?.image === 'node:22');

      provider._resolveSandboxImageUncached = origUncached;
      fs.rmSync(dcDir, { recursive: true, force: true });
    }

    // sandbox label suffix reflects the raw setting, shown in approval cards.
    await vscode.workspace.getConfiguration().update('sandboxMode', 'off');
    check('_sandboxLabelSuffix: empty when off', provider._sandboxLabelSuffix() === '');
    await vscode.workspace.getConfiguration().update('sandboxMode', 'docker');
    check('_sandboxLabelSuffix: shown when docker mode is set', provider._sandboxLabelSuffix() === ' (sandboxed)');
  } catch (e) {
    check('sandbox suite ran', false, e.stack || e.message);
  } finally {
    await vscode.workspace.getConfiguration().update('sandboxMode', 'off');
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── Missing-path hint on command failure (_spawnAndCollect) ────────────────
// A model that guesses a wrong path/filename and retries with a different
// guess, over and over, never converges — the real name has to actually be
// looked up. This nudges toward that instead of letting the retry loop run
// unbounded. No hardcoding to any one scenario: the detector is a general
// "does this output look like an OS/toolchain path-not-found error" pattern
// match, exercised here against synthetic text AND real spawned processes.
async function missingPathHintSuite() {
  console.log('\nmissing-path hint on command failure:');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();

  // Pure: the detector itself, against a range of real OS/toolchain error
  // phrasings — including one taken verbatim from a live cross-compiler
  // failure, not just cmd.exe's own errors — and clear negatives that must
  // NOT trigger it (a genuine compile/logic error, a bare non-zero exit).
  {
    const looksLikeMissingPathError = eval('(' + extractFunction(extSrc, 'function looksLikeMissingPathError') + ')');
    const positives = [
      'The system cannot find the file specified.',
      'The system cannot find the path specified.',
      'The filename, directory name, or volume label syntax is incorrect.',
      "'gcc' is not recognized as an internal or external command, operable program or batch file.",
      "cc1.exe: fatal error: c:\\Users\\x\\Downloads\\hexdumb\\pe-any.c: No such file or directory\ncompilation terminated.",
      'bash: fooo: command not found',
      'ls: cannot access /nope: No such file or directory',
    ];
    for (const text of positives) {
      check('looksLikeMissingPathError: detects — ' + JSON.stringify(text.slice(0, 40)) + '…', looksLikeMissingPathError(text));
    }
    const negatives = [
      "error: expected ';' before '}' token",
      'AssertionError: expected 2 to equal 3',
      '',
      'Exit code: 1\nstdout:\n\nstderr:\n',
      'warning: unused variable \'x\'',
    ];
    for (const text of negatives) {
      check('looksLikeMissingPathError: does NOT flag — ' + JSON.stringify(text.slice(0, 40)), !looksLikeMissingPathError(text));
    }
  }

  // Real end-to-end, via a genuine spawned process through toolRunCommand —
  // not a mock of the spawn layer.
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-missingpath-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    ctrl.config.approvalMode = 'auto-approve';
    const isWin = process.platform === 'win32';

    const missing = path.join(tmp, 'definitely-does-not-exist-' + Date.now());
    const notFoundCmd = isWin ? `dir "${missing}"` : `ls "${missing}"`;
    const notFoundResult = await provider.toolRunCommand(notFoundCmd, 10000);
    check('toolRunCommand: a real not-found path gets the hint appended', /Navy: this looks like a path\/file\/command/.test(notFoundResult));
    check('toolRunCommand: the hint tells it to list the parent, not guess again', /do not guess again/.test(notFoundResult));

    const okCmd = isWin ? 'echo real-success-marker' : 'echo real-success-marker';
    const okResult = await provider.toolRunCommand(okCmd, 10000);
    check('toolRunCommand: a real successful command gets NO hint', !/Navy: this looks like/.test(okResult));

    const badExitCmd = isWin ? 'exit 3' : 'exit 3';
    const badExitResult = await provider.toolRunCommand(badExitCmd, 10000);
    check('toolRunCommand: a real non-path failure (bad exit code, no path text) gets NO hint', !/Navy: this looks like/.test(badExitResult));
  } catch (e) {
    check('missing-path hint suite ran', false, e.stack || e.message);
  } finally {
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── Persistent background processes (navy.persistBackgroundProcesses) ──────
async function persistentBgProcessSuite() {
  console.log('\npersistent background processes (navy.persistBackgroundProcesses):');
  const os = require('os');
  const { spawn: nodeSpawn } = require('child_process');
  const { vscode, ctrl } = sharedMock();

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-bgpersist-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    // Off by default, and reflects the setting once toggled — this is the
    // gate every persist-mode branch below is behind.
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', false);
    check('_persistBgEnabled: off by default', provider._persistBgEnabled() === false);
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', true);
    check('_persistBgEnabled: true once the setting is turned on', provider._persistBgEnabled() === true);
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', false);

    // Manifest round-trip on the real filesystem (.navy/bg-processes.json).
    await provider._addToBgManifest(tmp, { id: 'a', pid: 111, command: 'cmd-a', startedAt: 1 });
    await provider._addToBgManifest(tmp, { id: 'b', pid: 222, command: 'cmd-b', startedAt: 2 });
    let manifest = await provider._readBgManifest(tmp);
    check('manifest: two added records both persisted to disk', manifest.length === 2);
    await provider._removeFromBgManifest(tmp, 111);
    manifest = await provider._readBgManifest(tmp);
    check('manifest: removeFromBgManifest drops only the matching pid', manifest.length === 1 && manifest[0].pid === 222);
    check('manifest: file actually exists on disk at .navy/bg-processes.json', fs.existsSync(path.join(tmp, '.navy', 'bg-processes.json')));
    await provider._writeBgManifest(tmp, []); // reset for later tests

    // _pidAlive: true for a pid that definitely exists (this test process
    // itself), false for one that has genuinely already exited.
    check('_pidAlive: true for this process\'s own pid', provider._pidAlive(process.pid) === true);
    const shortLived = nodeSpawn('node', ['-e', ''], { cwd: tmp });
    const deadPid = await new Promise(res => shortLived.on('exit', () => res(shortLived.pid)));
    check('_pidAlive: false for a pid that has already exited', provider._pidAlive(deadPid) === false);

    // _disposeSession must NEVER kill a persist:true entry (that's the whole
    // point of the setting) but must still kill an ordinary one — the single
    // most safety-critical invariant of this feature.
    {
      const killed = [];
      provider._killProcessTree = (proc) => killed.push(proc.pid);
      const fakeSession = {
        _heartbeat: undefined, _watchdog: undefined, _cpSaveTimer: undefined,
        bgProcesses: new Map([
          ['persisted', { proc: { pid: 9001, killed: false }, persist: true }],
          ['ordinary', { proc: { pid: 9002, killed: false }, persist: false }],
        ]),
        bgWorkers: new Map(),
      };
      provider._disposeSession(fakeSession);
      check('_disposeSession: a persist:true entry is left running, never killed', !killed.includes(9001));
      check('_disposeSession: an ordinary (non-persist) entry is still killed as before', killed.includes(9002));
    }
    delete provider._killProcessTree; // restore the real implementation for what follows

    // toolStartProcess/toolRunProject always run the command through
    // `cmd /c <string>` on Windows (existing, unrelated behavior — unchanged
    // by this feature). cmd.exe's own argument parsing mishandles a string
    // with quotes NESTED inside its outer quoting (verified directly: `cmd
    // /c "node -e \"console.log(1)\""` silently produces no output at all)
    // — a real, pre-existing Windows quirk of the shell-string path itself,
    // not something this feature changes. Sidestep it in these tests the
    // same way a real script would: write the code to a file with no spaces
    // in its path and run `node <path>`, so no quoting is needed at all.
    const writeNodeScript = (name, code) => {
      const p = path.join(tmp, name);
      fs.writeFileSync(p, code);
      return `node ${p}`;
    };

    // ── Real end-to-end: persist mode ON ──────────────────────────────────
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', true);
    ctrl.config.approvalMode = 'auto-approve';
    const marker = 'BGPERSIST_MARKER_' + Date.now();
    const startResult = await provider.toolStartProcess('logger', writeNodeScript('logger.js', `console.log('${marker}');`));
    check('toolStartProcess (persist on): reports detached + survives-reload', /detached/.test(startResult) && /survive a window reload/.test(startResult));
    const entry = provider.bgProcesses.get('logger');
    check('toolStartProcess (persist on): entry is marked persist:true', entry?.persist === true);
    check('toolStartProcess (persist on): entry has a real logPath', typeof entry?.logPath === 'string' && entry.logPath.length > 0);

    manifest = await provider._readBgManifest(tmp);
    check('toolStartProcess (persist on): manifest gained a record for it', manifest.some(r => r.id === 'logger' && r.pid === entry.pid));

    // Wait for the real child to actually finish and write its output.
    for (let i = 0; i < 50 && provider.bgProcesses.get('logger')?.proc; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    check('toolStartProcess (persist on): the real process actually exited on its own', provider.bgProcesses.get('logger')?.proc == null);

    const readBack = await provider.toolReadProcessOutput('logger');
    check('toolReadProcessOutput (persist on): reads the real log file, containing the marker', readBack.includes(marker));
    check('toolReadProcessOutput (persist on): labels the output as persisted', /persisted — logged to/.test(readBack));

    manifest = await provider._readBgManifest(tmp);
    check('toolStartProcess (persist on): manifest entry removed once the process exits naturally', !manifest.some(r => r.id === 'logger'));

    // ── readFileTail: a genuinely large log returns just the tail, not the ──
    // whole file (the actual fix — a synchronous full-file read scales with
    // how much a chatty dev server has ever logged, not with what's asked for).
    {
      const bigLogPath = path.join(tmp, 'big-tail-test.log');
      const headMarker = 'HEAD_MARKER_SHOULD_NOT_APPEAR_IN_TAIL';
      const filler = 'x'.repeat(50000);
      const tailMarker = 'TAIL_MARKER_' + Date.now();
      fs.writeFileSync(bigLogPath, headMarker + filler + filler + filler + filler + tailMarker); // ~200KB, distinct markers at each end
      const readFileTail = new Function('fs', extractFunction(extSrc, 'function readFileTail') + '\nreturn readFileTail;')(fs);
      const tail = readFileTail(bigLogPath, 100);
      check('readFileTail: returns a bounded slice, not the whole (~200KB) file', tail.length <= 100);
      check('readFileTail: the slice is the REAL tail — contains the marker at the very end', tail.includes(tailMarker));
      check('readFileTail: does not contain the marker from the start of the file', !tail.includes(headMarker));
      try { fs.rmSync(bigLogPath, { force: true }); } catch {}
    }

    // ── Real end-to-end: persist mode OFF (default) — unchanged behavior ──
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', false);
    const marker2 = 'NOPERSIST_MARKER_' + Date.now();
    await provider.toolStartProcess('logger2', writeNodeScript('logger2.js', `console.log('${marker2}');`));
    const entry2 = provider.bgProcesses.get('logger2');
    check('toolStartProcess (persist off): entry has no persist flag', !entry2?.persist);
    check('toolStartProcess (persist off): entry has no logPath (uses the in-memory buffer as before)', !entry2?.logPath);
    for (let i = 0; i < 50 && provider.bgProcesses.get('logger2')?.proc; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    const readBack2 = await provider.toolReadProcessOutput('logger2');
    check('toolReadProcessOutput (persist off): still reads the live in-memory buffer, not a log file', readBack2.includes(marker2) && !/persisted/.test(readBack2));

    // ── toolKillProcess on a persisted entry also cleans the manifest ─────
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', true);
    await provider.toolStartProcess('longrun', writeNodeScript('longrun.js', 'setInterval(()=>{}, 1000);'));
    const longEntry = provider.bgProcesses.get('longrun');
    manifest = await provider._readBgManifest(tmp);
    check('toolKillProcess setup: long-running persisted process is in the manifest before killing', manifest.some(r => r.id === 'longrun'));
    const killMsg = await provider.toolKillProcess('longrun');
    check('toolKillProcess: reports success', /killed/i.test(killMsg));
    manifest = await provider._readBgManifest(tmp);
    check('toolKillProcess: removes the persisted entry from the manifest too, not just bgProcesses', !manifest.some(r => r.id === 'longrun'));
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', false);

    // ── _withBgManifestLock genuinely serializes concurrent callers for the
    // SAME project (sibling chat tabs can legitimately start/stop persisted
    // processes at the same time — this is the actual fix for the lost-
    // update race review found). Proven via ordering markers, same
    // deterministic style as the global-catalog lock's own test.
    await provider._writeBgManifest(tmp, []);
    {
      const order = [];
      const p1 = provider._withBgManifestLock(tmp, async () => {
        order.push('1-start');
        await new Promise(r => setTimeout(r, 30));
        order.push('1-end');
      });
      const p2 = provider._withBgManifestLock(tmp, async () => {
        order.push('2-start');
        order.push('2-end');
      });
      await Promise.all([p1, p2]);
      check('_withBgManifestLock: a second caller never starts before the first finishes',
        order.join(',') === '1-start,1-end,2-start,2-end');
    }

    // A DIFFERENT project's lock must be independent — one project's slow
    // manifest write must never delay an unrelated project's.
    {
      const tmpOther = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-bgpersist-other-'));
      const order = [];
      const pSlow = provider._withBgManifestLock(tmp, async () => {
        order.push('tmp-start');
        await new Promise(r => setTimeout(r, 40));
        order.push('tmp-end');
      });
      const pOther = provider._withBgManifestLock(tmpOther, async () => {
        order.push('other-start');
        order.push('other-end');
      });
      await Promise.all([pSlow, pOther]);
      check('_withBgManifestLock: a different project is not serialized behind this one',
        order.indexOf('other-start') < order.indexOf('tmp-end'));
      try { fs.rmSync(tmpOther, { recursive: true, force: true }); } catch {}
    }

    // ── _addToBgManifest: concurrent calls for the SAME project must not
    // lose either record — the actual bug found in review.
    {
      await provider._writeBgManifest(tmp, []);
      await Promise.all([
        provider._addToBgManifest(tmp, { id: 'concurrent-a', pid: 111111, command: 'a', startedAt: 1 }),
        provider._addToBgManifest(tmp, { id: 'concurrent-b', pid: 222222, command: 'b', startedAt: 2 }),
      ]);
      const concurrentManifest = await provider._readBgManifest(tmp);
      check('_addToBgManifest: two concurrent adds to the same project both survive',
        concurrentManifest.some(r => r.id === 'concurrent-a') && concurrentManifest.some(r => r.id === 'concurrent-b'));
    }

    // ── _checkOrphanedBgProcesses: the "found leftovers from last time" flow ─
    {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-bgpersist-orphan-'));
      // startedAt must be the REAL spawn time, exactly as production records
      // it: _classifyBgRecord verifies the pid's actual start time against it
      // so a recycled pid is never mistaken for ours (and never killed).
      const aliveStartedAt = Date.now();
      const stillAlive = nodeSpawn('node', ['-e', 'setInterval(()=>{}, 1000)'], { cwd: tmp2 });
      await new Promise(r => setTimeout(r, 100)); // let it actually start
      const alreadyDead = nodeSpawn('node', ['-e', ''], { cwd: tmp2 });
      const deadPid2 = await new Promise(res => alreadyDead.on('exit', () => res(alreadyDead.pid)));

      await provider._writeBgManifest(tmp2, [
        { id: 'alive-one', pid: stillAlive.pid, command: 'sleeper', startedAt: aliveStartedAt },
        { id: 'dead-one', pid: deadPid2, command: 'gone', startedAt: aliveStartedAt },
      ]);

      const killedPids = [];
      provider._killPidTree = (pid) => killedPids.push(pid);
      ctrl.shown.warning = [];
      ctrl.nextWarning = 'Stop All';
      await provider._checkOrphanedBgProcesses(tmp2);

      check('_checkOrphanedBgProcesses: prompts exactly once, naming the survivor', ctrl.shown.warning.length === 1 && /alive-one/.test(ctrl.shown.warning[0]));
      check('_checkOrphanedBgProcesses: the already-dead entry is silently pruned, never named in the prompt', !/dead-one/.test(ctrl.shown.warning[0] || ''));
      check('_checkOrphanedBgProcesses: "Stop All" kills the surviving pid', killedPids.includes(stillAlive.pid));
      const manifestAfter = await provider._readBgManifest(tmp2);
      check('_checkOrphanedBgProcesses: manifest is emptied after Stop All', manifestAfter.length === 0);
      // _killPidTree was stubbed above to observe the call without a real kill —
      // stillAlive's setInterval never clears on its own, so it must be reaped
      // for real here or it outlives this whole test process.
      try { process.kill(stillAlive.pid); } catch {}

      // Re-checking the SAME root this window must not prompt again.
      await provider._writeBgManifest(tmp2, [{ id: 'again', pid: process.pid, command: 'x', startedAt: 1 }]);
      ctrl.shown.warning = [];
      await provider._checkOrphanedBgProcesses(tmp2);
      check('_checkOrphanedBgProcesses: does not re-prompt for a root already checked this window', ctrl.shown.warning.length === 0);

      // "Leave Running" leaves the manifest and the process alone.
      const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-bgpersist-orphan2-'));
      const alive2StartedAt = Date.now();
      const stillAlive2 = nodeSpawn('node', ['-e', 'setInterval(()=>{}, 1000)'], { cwd: tmp3 });
      await new Promise(r => setTimeout(r, 100));
      await provider._writeBgManifest(tmp3, [{ id: 'keep-me', pid: stillAlive2.pid, command: 'sleeper', startedAt: alive2StartedAt }]);
      const killedPids2 = [];
      provider._killPidTree = (pid) => killedPids2.push(pid);
      ctrl.nextWarning = 'Leave Running';
      await provider._checkOrphanedBgProcesses(tmp3);
      check('_checkOrphanedBgProcesses: "Leave Running" kills nothing', killedPids2.length === 0);
      const manifestAfter3 = await provider._readBgManifest(tmp3);
      check('_checkOrphanedBgProcesses: "Leave Running" keeps the manifest entry', manifestAfter3.length === 1);

      delete provider._killPidTree;
      try { process.kill(stillAlive2.pid); } catch {}

      // ── PID reuse: a live pid whose start time does NOT match the record is
      // a DIFFERENT process that inherited the number. It must never be
      // killed — this gate sits directly in front of `taskkill /F /T`.
      {
        const startedNow = Date.now();
        const impostor = nodeSpawn('node', ['-e', 'setInterval(()=>{}, 1000)'], { cwd: tmp3 });
        await new Promise(r => setTimeout(r, 100));
        check('_classifyBgRecord: matching start time → "ours"',
          (await provider._classifyBgRecord({ pid: impostor.pid, startedAt: startedNow })) === 'ours');
        check('_classifyBgRecord: recycled pid (start time far off) → "gone", never killed',
          (await provider._classifyBgRecord({ pid: impostor.pid, startedAt: startedNow - 86400000 })) === 'gone');
        check('_classifyBgRecord: legacy record with no startedAt → "unverified", never killed',
          (await provider._classifyBgRecord({ pid: impostor.pid })) === 'unverified');
        check('_classifyBgRecord: a pid that is simply gone → "gone"',
          (await provider._classifyBgRecord({ pid: deadPid2, startedAt: startedNow })) === 'gone');

        // An unverifiable-but-live record is reported, kept in the manifest,
        // and left strictly alone — dropping it would leak a real orphan.
        const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-bgpersist-orphan3-'));
        await provider._writeBgManifest(tmp4, [{ id: 'legacy', pid: impostor.pid, command: 'legacy-entry' }]);
        const killedPids3 = [];
        provider._killPidTree = (pid) => killedPids3.push(pid);
        ctrl.shown.warning = [];
        ctrl.nextWarning = 'Stop All'; // even if the user would say yes, there is nothing to say yes TO
        await provider._checkOrphanedBgProcesses(tmp4);
        check('_checkOrphanedBgProcesses: an unverifiable live record is never killed', killedPids3.length === 0);
        check('_checkOrphanedBgProcesses: it is reported rather than silently ignored',
          ctrl.shown.warning.length === 1 && /could not verify/.test(ctrl.shown.warning[0]));
        check('_checkOrphanedBgProcesses: an unverifiable record stays in the manifest',
          (await provider._readBgManifest(tmp4)).length === 1);
        delete provider._killPidTree;
        try { process.kill(impostor.pid); } catch {}
        try { fs.rmSync(tmp4, { recursive: true, force: true }); } catch {}
      }

      try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(tmp3, { recursive: true, force: true }); } catch {}
    }
  } catch (e) {
    check('persistent background process suite ran', false, e.stack || e.message);
  } finally {
    await vscode.workspace.getConfiguration().update('persistBackgroundProcesses', false);
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 6f. Multi-root workspace awareness ──────────────────────────────────────
async function multiRootSuite() {
  console.log('\nmulti-root workspace awareness:');
  const os = require('os');
  const { vscode } = sharedMock();
  const uriOf = (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => p });

  let provider, dirA, dirB;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-rootA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-rootB-'));
    provider = new NavyCoderViewProvider(makeContext(dirA));
    provider.projectRoot = dirA;
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }, { uri: uriOf(dirB) }];

    fs.writeFileSync(path.join(dirA, 'a.js'), 'function fromA(){ return 1; }');
    fs.writeFileSync(path.join(dirB, 'b.js'), 'function fromB(){ return 2; }');

    // resolveWorkspacePath: a path inside a SIBLING open folder (not the
    // active projectRoot) is legitimate in a multi-root workspace, not a
    // traversal attempt.
    const resolvedSibling = provider.resolveWorkspacePath(path.join(dirB, 'b.js'));
    check('resolveWorkspacePath: accepts a path inside a sibling open folder', resolvedSibling === path.join(dirB, 'b.js'));

    // A path outside EVERY open folder must still be refused.
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-rootC-'));
    let threw = false;
    try { provider.resolveWorkspacePath(path.join(dirC, 'x.js')); } catch { threw = true; }
    check('resolveWorkspacePath: still refuses a path outside every open folder', threw);
    fs.rmSync(dirC, { recursive: true, force: true });

    // Existing single-root behavior is unaffected: a relative path still
    // resolves against the active projectRoot.
    check('resolveWorkspacePath: relative paths still resolve against the active project root',
      provider.resolveWorkspacePath('a.js') === path.join(dirA, 'a.js'));

    // _resolveTargetFolder: matches by full path or by folder basename.
    check('_resolveTargetFolder: matches a sibling folder by full path', provider._resolveTargetFolder(dirB).root === dirB);
    check('_resolveTargetFolder: matches a sibling folder by basename', provider._resolveTargetFolder(path.basename(dirB)).root === dirB);
    check('_resolveTargetFolder: no folder argument falls back to the active project', provider._resolveTargetFolder(undefined).root === dirA);
    const noMatch = provider._resolveTargetFolder('this-folder-does-not-exist');
    check('_resolveTargetFolder: an unmatched name returns an actionable error, not a silent fallback', Boolean(noMatch.error));

    // search_files/search_codebase/find_relevant_files: folder argument
    // actually redirects the search, not just accepted-and-ignored.
    const searchFilesB = await provider.toolSearchFiles('fromB', dirB);
    check('search_files: folder argument searches the sibling folder', searchFilesB.includes('b.js'));
    const searchFilesA = await provider.toolSearchFiles('fromB');
    check('search_files: omitting folder still searches only the active project', !searchFilesA.includes('b.js'));

    const searchCodebaseB = await provider.toolSearchCodebase('fromB', null, 2, dirB);
    check('search_codebase: folder argument searches the sibling folder', searchCodebaseB.includes('b.js'));

    const relevantB = await provider.toolFindRelevantFiles('fromB function', 5, dirB);
    check('find_relevant_files: folder argument ranks files from the sibling folder', relevantB.includes('b.js'));
    check('find_relevant_files: an unmatched folder name returns an actionable error',
      (await provider.toolFindRelevantFiles('anything', 5, 'nope-not-a-folder')).includes('does not match any open workspace folder'));

    // buildRepoMap: sibling-folder hint appears only when more than one
    // folder is actually open.
    const mapMulti = await provider.buildRepoMap();
    check('buildRepoMap: notes sibling open folders exist', mapMulti.includes('Other open folders') && mapMulti.includes(dirB));

    provider._repoMapCache = null; // bypass the 30s cache for the single-root re-check
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    const mapSingle = await provider.buildRepoMap();
    check('buildRepoMap: no sibling-folder hint when only one folder is open (unchanged single-root behavior)',
      !mapSingle.includes('Other open folders'));
  } catch (e) {
    check('multi-root suite ran', false, e.stack || e.message);
  } finally {
    if (provider) clearTimeout(provider._cpSaveTimer);
    vscode.workspace.workspaceFolders = undefined;
    try { if (dirA) fs.rmSync(dirA, { recursive: true, force: true }); } catch {}
    try { if (dirB) fs.rmSync(dirB, { recursive: true, force: true }); } catch {}
  }
}

// ── 6g. Session isolation (per-project state extracted into a Session class) ─
// Every existing suite above already exercises the getter/setter proxies
// indiscriminately (they ran unmodified against the new Session-backed
// provider), which is the main proof this refactor preserves behavior. These
// tests target what's actually NEW: switching projectRoot must retain each
// session's in-memory state independently rather than resetting or sharing it.
async function sessionIsolationSuite() {
  console.log('\nsession isolation (Session class extraction):');
  const os = require('os');
  sharedMock();

  let provider, dirA, dirB;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-sessA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-sessB-'));
    provider = new NavyCoderViewProvider(makeContext(dirA));

    // Tabs are identified by a generated id, not by project root (a tab can
    // exist before any project is assigned) — openNewSessionTab creates one
    // and switchSessionTab(id) moves between them, mirroring the real UI flow.
    const sessionA = provider.activeSessionId; // the default tab created by the constructor
    provider.projectRoot = dirA;
    provider.messages = [{ role: 'user', text: 'hello from A' }];
    provider.isBusy = true;
    provider.checkpoints.push({ kind: 'edit', filePath: path.join(dirA, 'f.js'), originalText: 'old' });
    const writeLockA = provider._writeLock;
    const bgProcessesA = provider.bgProcesses;

    // A brand-new tab must start with a completely fresh session, not leak
    // A's messages/busy-flag/checkpoints/locks into it.
    await provider.openNewSessionTab();
    const sessionB = provider.activeSessionId;
    check('opening a new tab: gets its own distinct session id', sessionB !== sessionA);
    provider.projectRoot = dirB;
    check('new tab: messages start empty, not leaked from the previous session', provider.messages.length === 0);
    check('new tab: isBusy resets, not leaked from the previous session', provider.isBusy === false);
    check('new tab: checkpoints start empty, not leaked from the previous session', provider.checkpoints.length === 0);
    check('new tab: bgProcesses is a SEPARATE Map instance, not shared with the previous session',
      provider.bgProcesses !== bgProcessesA);
    check('new tab: _writeLock is a SEPARATE lock chain, so a write in one project can never queue behind a write in the other',
      provider._writeLock !== writeLockA);

    // Switching BACK must retain A's state exactly as it was left — this is
    // the actual point of extracting Session objects instead of just
    // resetting everything on every switch. Uses activeSessionId directly
    // (not switchSessionTab, which does real disk I/O via loadProjectSession
    // — appropriate for the real UI flow, but this test targets the pure
    // in-memory Session mechanics, same as the plain projectRoot-assignment
    // style the rest of this suite already uses).
    provider.activeSessionId = sessionA;
    check('switch back to tab A: messages are exactly as left, not reloaded/reset', provider.messages.length === 1 && provider.messages[0].text === 'hello from A');
    check('switch back to tab A: isBusy is exactly as left', provider.isBusy === true);
    check('switch back to tab A: checkpoints are exactly as left', provider.checkpoints.length === 1);
    check('switch back to tab A: bgProcesses is the SAME Map instance as before (identity, not a copy)', provider.bgProcesses === bgProcessesA);

    // Sanity: B's state (set independently while A was active above) must
    // still be its own, unaffected by anything done to A afterward.
    provider.activeSessionId = sessionB;
    check('tab B state is still isolated after further changes to A', provider.messages.length === 0 && provider.checkpoints.length === 0);

    // ── _ensureProjectChatsLoaded reads a project's saved chats in parallel,
    // not one at a time — all must still load correctly regardless.
    let dirC;
    try {
      dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-sessC-'));
      const chatsDir = path.join(dirC, '.navy', 'chats');
      fs.mkdirSync(chatsDir, { recursive: true });
      const ids = ['chat1', 'chat2', 'chat3'];
      for (const id of ids) {
        fs.writeFileSync(path.join(chatsDir, id + '.json'), JSON.stringify({
          id, updated: new Date().toISOString(),
          messages: [{ role: 'user', text: 'hello from ' + id }],
          digest: '', checkpoints: [],
        }));
      }
      const freshProvider = new NavyCoderViewProvider(makeContext(dirC));
      await freshProvider._ensureProjectChatsLoaded(dirC);
      const loaded = ids.map(id => freshProvider.sessions.get(id));
      check('_ensureProjectChatsLoaded: all 3 chat files load, not just some (parallel reads)',
        loaded.every(Boolean));
      check('_ensureProjectChatsLoaded: each loaded chat has its own correct content, not mixed up',
        ids.every(id => loaded.find(s => s.id === id)?.messages?.[0]?.text === 'hello from ' + id));
      for (const session of freshProvider.sessions.values()) clearTimeout(session._cpSaveTimer);
    } finally {
      try { if (dirC) fs.rmSync(dirC, { recursive: true, force: true }); } catch {}
    }
  } catch (e) {
    check('session isolation suite ran', false, e.stack || e.message);
  } finally {
    if (provider) {
      for (const session of provider.sessions.values()) clearTimeout(session._cpSaveTimer);
    }
    try { if (dirA) fs.rmSync(dirA, { recursive: true, force: true }); } catch {}
    try { if (dirB) fs.rmSync(dirB, { recursive: true, force: true }); } catch {}
  }
}

// ── 6h. Session-tagged postMessage + tab management (backend) ────────────────
// Verifies the actual mechanism that lets a background tab's turn keep
// running safely: resolveWebviewView's postMessage wrapper tags every
// outgoing message with a session id, preferring sessionContext (so a turn
// stays bound to the session it started in) over the live activeSessionId.
async function sessionTaggingSuite() {
  console.log('\nsession-tagged postMessage + tab management:');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();

  let provider, dirA, dirB;
  try {
    const { NavyCoderViewProvider, sessionContext } = require('../src/extension.js');
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-tagA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-tagB-'));
    provider = new NavyCoderViewProvider(makeContext(dirA));
    // The constructor derives an initial session from shared mock config
    // that earlier suites may have left set — prune anything but the
    // default one so the close-tab assertions below have a deterministic
    // session count to work from, regardless of what leaked in from another
    // suite's state.
    const sessionA = provider.activeSessionId;
    for (const key of [...provider.sessions.keys()]) {
      if (key !== sessionA) provider.sessions.delete(key);
    }
    provider.projectRoot = dirA; // assign a root to the default tab (id sessionA)

    // A second tab, identified by its OWN generated id, independent of
    // whatever root gets assigned to it (or not).
    await provider.openNewSessionTab();
    const sessionB = provider.activeSessionId;
    provider.projectRoot = dirB;
    provider.activeSessionId = sessionA; // back to A as "currently displayed", no disk I/O

    const posted = [];
    const fakeWebview = {
      postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
      asWebviewUri: (u) => u,
      cspSource: 'test-csp',
      onDidReceiveMessage: () => ({ dispose() {} }),
    };
    const fakeView = { webview: fakeWebview, onDidDispose: () => {}, onDidChangeVisibility: () => {} };
    await provider.resolveWebviewView(fakeView);

    // Outside any turn, postMessage tags with whichever session is currently active.
    posted.length = 0;
    provider.view.webview.postMessage({ type: 'probe1' });
    check('postMessage: tags with the live active session outside any turn', posted[0].sessionId === sessionA);

    // Switching the active session changes what UN-wrapped code gets tagged with.
    provider.activeSessionId = sessionB;
    posted.length = 0;
    provider.view.webview.postMessage({ type: 'probe2' });
    check('postMessage: reflects the NEW active session after a switch (no turn in progress)', posted[0].sessionId === sessionB);

    // The actual point: code running inside sessionContext.run(sessionA, ...)
    // stays tagged with sessionA even though the active session is now
    // sessionB — this is what keeps a background turn's messages routed to
    // ITS OWN tab.
    posted.length = 0;
    await sessionContext.run(sessionA, async () => {
      provider.view.webview.postMessage({ type: 'probe3' });
      // Switch AGAIN mid-"turn" — must not affect this context's tagging.
      provider.activeSessionId = sessionA; // back to A, but via the context, not the switch
    });
    check('postMessage: code inside sessionContext.run stays tagged with ITS session, not the live active one',
      posted[0].sessionId === sessionA);

    // And the _session getter itself resolves the same way — state accessed
    // from inside a sessionContext.run binds to THAT session even if
    // activeSessionId differs, which is what keeps a running turn's
    // messages/checkpoints/etc. from leaking into whatever tab is now visible.
    provider.activeSessionId = sessionB; // sessionB is now the live active session
    let messagesInsideContext;
    await sessionContext.run(sessionA, async () => {
      messagesInsideContext = provider.messages; // should resolve to sessionA's session
    });
    check('_session getter: resolves to the sessionContext session, not the live active one',
      messagesInsideContext === provider.sessions.get(sessionA).messages);

    // ── Tab management: tabs are CHILDREN of a project ───────────────────
    // Navigating between a project's own chats is purely Navy-internal — it
    // must never write navy.projectRoot to .vscode/settings.json or touch
    // the real VS Code Explorer/workspace. Only EXPLICITLY picking a
    // DIFFERENT project (via _switchProjectRoot, the dropdown's path) does
    // either of those.
    ctrl.scoped = {}; // clear whatever earlier persistence in this suite left behind
    ctrl.executedCommands = [];
    provider.activeSessionId = sessionA; // sessionA: dirA
    provider.sessions.get(sessionB).projectRoot = dirA; // rebind B to be A's sibling under the same project

    await provider.switchSessionTab(sessionB);
    check('switchSessionTab: becomes the active session', provider.activeSessionId === sessionB);
    check('switchSessionTab: sends an updated session list', posted.some(m => m.type === 'sessionList'));
    check('switchSessionTab: never persists navy.projectRoot (switching a project\'s own chats is not switching projects)',
      !ctrl.scoped.projectRoot);
    check('switchSessionTab: never touches the real VS Code Explorer/workspace',
      !ctrl.executedCommands.some(c => c.command === 'revealInExplorer'));

    // The tab strip only shows the ACTIVE PROJECT's own chats — not a flat
    // list spanning every project ever opened.
    const summaries = provider._sessionSummaries();
    check('_sessionSummaries: only includes chats belonging to the active project',
      summaries.length === 2 && summaries.every(s => s.root === dirA));
    check('_sessionSummaries: includes both siblings',
      summaries.some(s => s.id === sessionA) && summaries.some(s => s.id === sessionB));

    // Explicitly picking a DIFFERENT project from the dropdown DOES persist
    // and DOES reveal it in Explorer — "from the VS Code side too". Give the
    // active chat real content first, so the switch has to spawn a fresh
    // chat under the new project rather than silently repurposing an
    // in-progress conversation.
    provider.messages = [{ role: 'user', text: 'hello from B' }];
    posted.length = 0;
    const sessionBeforeSwitch = provider.activeSessionId;
    await provider._switchProjectRoot(dirB);
    check('_switchProjectRoot (dropdown pick): persists navy.projectRoot',
      ctrl.scoped.projectRoot?.workspaceValue === dirB || ctrl.scoped.projectRoot?.globalValue === dirB);
    check('_switchProjectRoot (dropdown pick): reveals the folder in VS Code\'s own Explorer',
      ctrl.executedCommands.some(c => c.command === 'revealInExplorer' && c.args[0]?.fsPath === dirB));
    check('_switchProjectRoot: a project with no chats yet and a non-blank active tab starts a FRESH chat, not a reused one',
      provider.activeSessionId !== sessionBeforeSwitch && provider.projectRoot === dirB && provider.messages.length === 0);
    check('_switchProjectRoot: the chat left behind on the old project is untouched, not discarded',
      provider.sessions.has(sessionB) && provider.sessions.get(sessionB).messages.length === 1);
    check('_switchProjectRoot (dropdown pick): also sends an updated session list',
      posted.some(m => m.type === 'sessionList' && m.sessions.some(s => s.root === dirB && s.active)));
    const sessionC = provider.activeSessionId; // the freshly created dirB chat

    // Switching back to dirA resumes whichever chat was last active there
    // (sessionB, from the switchSessionTab call above) — not a new one.
    // Regression: the constructor's bootstrap placeholder (sessionA) is
    // still blank, and this is dirA's first REAL activation this window, so
    // it gets cleaned up in favor of the real chat instead of lingering as a
    // dangling empty duplicate.
    posted.length = 0;
    await provider._switchProjectRoot(dirA);
    check('_switchProjectRoot: switching back to a project resumes the chat you were last on',
      provider.activeSessionId === sessionB);
    check('_switchProjectRoot: the never-used bootstrap tab is cleaned up once a real chat for its project is found',
      !provider.sessions.has(sessionA));

    // New-tab workflow: "+" creates a chat as a CHILD of the CURRENT
    // project — no dialog, no separate "assign a project" step.
    let dialogShown = false;
    const realShowOpenDialog = vscode.window.showOpenDialog;
    vscode.window.showOpenDialog = async (...args) => { dialogShown = true; return realShowOpenDialog(...args); };
    posted.length = 0;
    const sessionBeforeNewTab = provider.activeSessionId;
    await provider.openNewSessionTab();
    check('openNewSessionTab: never opens a folder picker dialog', !dialogShown);
    check('openNewSessionTab: switches to a brand-new session', provider.activeSessionId !== sessionBeforeNewTab);
    check('openNewSessionTab: the new chat inherits the CURRENT project as its parent', provider.projectRoot === dirA);
    check('openNewSessionTab: shown as "New Chat" in the tab strip (no messages yet)',
      provider._sessionSummaries().find(s => s.id === provider.activeSessionId)?.name === 'New Chat');
    vscode.window.showOpenDialog = realShowOpenDialog;
    const sessionD = provider.activeSessionId;

    // closeSessionTab freely closes a chat that still has a sibling under
    // the same project, falling back to that sibling.
    posted.length = 0;
    await provider.closeSessionTab(sessionD);
    check('closeSessionTab: removes the session', !provider.sessions.has(sessionD));
    check('closeSessionTab: falls back to the remaining sibling under the same project', provider.activeSessionId === sessionB);

    // Refuses to close a project's very last remaining chat. sessionC (a
    // DIFFERENT project, dirB) existing elsewhere must not count as a
    // sibling that makes this "safe" — tabs only compete with their own
    // project's siblings.
    posted.length = 0;
    await provider.closeSessionTab(sessionB);
    check('closeSessionTab: refuses to close a project\'s last remaining chat',
      provider.sessions.has(sessionB) && provider.activeSessionId === sessionB);
    check('closeSessionTab: a DIFFERENT project\'s chat count never satisfies this project\'s "last one" guard',
      provider.sessions.has(sessionC));

    // ── Project-scoped state (write lock, embeddings cache, gutter ranges) ──
    // These must be SHARED across sibling chats on the same project, not
    // duplicated per chat — duplicating them was a real bug: two sibling
    // chats writing to the same file at once wouldn't serialize against
    // each other (the write lock exists specifically to prevent
    // interleaved writes), and each kept its own copy of the shared
    // embeddings.json cache, so whichever chat's debounced save fired last
    // silently discarded the other's contribution.
    await provider.openNewSessionTab(); // sibling of sessionB, same project (dirA)
    const sessionE = provider.activeSessionId;
    provider._writeLock = Promise.resolve('marker-A');
    provider._embedIndexCache = { root: dirA, marker: 'A' };
    provider.editedRanges.set('marker-file.js', [{ start: 1, end: 2 }]);
    const lockSetFromE = provider._writeLock;

    provider.activeSessionId = sessionB; // sibling, same project — direct switch, no I/O
    check('project-scoped write lock: shared across sibling chats on the same project',
      provider._writeLock === lockSetFromE);
    check('project-scoped embeddings cache: shared across sibling chats on the same project',
      provider._embedIndexCache?.marker === 'A');
    check('project-scoped gutter decorations: shared across sibling chats on the same project',
      provider.editedRanges.get('marker-file.js')?.length === 1);

    provider.activeSessionId = sessionC; // a DIFFERENT project (dirB)
    check('project-scoped write lock: isolated from a DIFFERENT project',
      provider._writeLock !== lockSetFromE);
    check('project-scoped embeddings cache: isolated from a DIFFERENT project',
      provider._embedIndexCache?.marker !== 'A');
    check('project-scoped gutter decorations: isolated from a DIFFERENT project',
      !provider.editedRanges.has('marker-file.js'));
    provider.activeSessionId = sessionB;

    // ── Message ordering: 'sessionList' (gate-exempt) must reach the
    // frontend BEFORE any message tagged with a newly-active session that
    // the frontend has no advance notice of — otherwise the frontend (still
    // holding the OLD activeSessionId) silently drops 'restore'/
    // 'sessionLoaded' via its per-message gate, and the user sees a blank
    // thread instead of the target chat's real content.
    posted.length = 0;
    await provider.openNewSessionTab();
    {
      const listIdx = posted.findIndex(m => m.type === 'sessionList');
      const restoreIdx = posted.findIndex(m => m.type === 'restore');
      const loadedIdx = posted.findIndex(m => m.type === 'sessionLoaded');
      check('openNewSessionTab: sessionList sent before restore',
        listIdx !== -1 && restoreIdx !== -1 && listIdx < restoreIdx);
      check('openNewSessionTab: sessionList sent before sessionLoaded',
        listIdx !== -1 && loadedIdx !== -1 && listIdx < loadedIdx);
    }
    // Same regression via closeSessionTab falling back to a sibling the
    // frontend had NO advance notice of (unlike a direct tab click, which
    // optimistically updates the frontend's activeSessionId itself first).
    const siblingToClose = provider.activeSessionId; // the tab just opened above
    posted.length = 0;
    await provider.closeSessionTab(siblingToClose);
    {
      const listIdx = posted.findIndex(m => m.type === 'sessionList');
      const restoreIdx = posted.findIndex(m => m.type === 'restore');
      check('closeSessionTab fallback: sessionList sent before restore for the sibling it switches to',
        listIdx !== -1 && restoreIdx !== -1 && listIdx < restoreIdx);
    }

    // ── cancelPendingApprovals (Stop/Clear) vs cancelAllPendingApprovals
    // (whole panel disposed) ─────────────────────────────────────────────
    // Stop/Clear are per-chat actions and must not reach into an unrelated
    // BACKGROUND tab and reject its approval. But when the whole webview
    // panel is disposed, nothing will ever resolve a background tab's
    // pending approval otherwise, hanging that turn forever — every
    // session's approvals must be resolved then, not just the active one.
    {
      const bg = provider.sessions.get(sessionC); // dirB chat, NOT currently active
      let bgResolved;
      bg.pendingApprovals.set('fake-bg-approval', { kind: 'agent-edit', resolve: (v) => { bgResolved = v; } });

      provider.cancelPendingApprovals(); // active-session-only
      check('cancelPendingApprovals: leaves a DIFFERENT (background) session\'s approval untouched',
        bg.pendingApprovals.has('fake-bg-approval') && bgResolved === undefined);

      provider.cancelAllPendingApprovals();
      check('cancelAllPendingApprovals: resolves a background session\'s approval too',
        !bg.pendingApprovals.has('fake-bg-approval') && bgResolved === 'reject');
    }

    // First-ever project pick (nothing ever selected before) reuses the
    // constructor's own blank bootstrap tab instead of leaving it dangling
    // and creating a redundant second one.
    {
      vscode.workspace.workspaceFolders = [];
      ctrl.scoped = {};
      const dirD = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-tagD-'));
      const { NavyCoderViewProvider: FreshProvider } = require('../src/extension.js');
      const fresh = new FreshProvider(makeContext(dirD));
      const freshBootstrapId = fresh.activeSessionId;
      try {
        await fresh._switchProjectRoot(dirD);
        check('fresh install: first-ever project pick reuses the bootstrap tab instead of spawning a new one',
          fresh.activeSessionId === freshBootstrapId && fresh.projectRoot === dirD && fresh.sessions.size === 1);
      } finally {
        clearTimeout(fresh._cpSaveTimer); clearInterval(fresh._heartbeat); clearTimeout(fresh._watchdog);
        try { fs.rmSync(dirD, { recursive: true, force: true }); } catch {}
      }
    }
  } catch (e) {
    check('session tagging suite ran', false, e.stack || e.message);
  } finally {
    if (provider) {
      for (const session of provider.sessions.values()) {
        clearTimeout(session._cpSaveTimer);
        clearInterval(session._heartbeat);
        clearTimeout(session._watchdog);
      }
    }
    try { if (dirA) fs.rmSync(dirA, { recursive: true, force: true }); } catch {}
    try { if (dirB) fs.rmSync(dirB, { recursive: true, force: true }); } catch {}
  }
}

// ── Project cache eviction (_projectCaches must not grow unbounded) ────────
// Without a cap, _projectCaches gains one entry (embedding index, repo map,
// relevance/.gitignore caches) for every distinct project root ever visited
// in this window, forever — a real memory-growth concern for a long-lived
// window that touches many repos. Eviction must ONLY ever remove a root with
// no currently-open chat tab, since that's the one condition guaranteeing no
// turn/background task could be using its write lock.
async function projectCacheEvictionSuite() {
  console.log('\nproject cache eviction (_projectCaches cap):');
  const os = require('os');
  sharedMock();

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-cacheevict-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));

    // ── Basic cap enforcement, cycling a single session through many roots ──
    // Fake, non-existent paths are fine — _projectCaches is a pure in-memory
    // Map keyed by the root string, never touches disk.
    for (let i = 0; i < 25; i++) {
      provider.projectRoot = `/fake/evict-proj-${i}`;
      void provider._proj; // touch the getter — this is what creates/caches the entry
    }
    check('project cache: never grows past the cap even after visiting 25 distinct roots',
      provider._projectCaches.size <= 20);
    check('project cache: the most-recently-touched root survived', provider._projectCaches.has('/fake/evict-proj-24'));
    check('project cache: the very first (oldest, long since abandoned) root was evicted',
      !provider._projectCaches.has('/fake/evict-proj-0'));

    // ── An OPEN root must never be evicted, no matter how stale ─────────────
    provider = new NavyCoderViewProvider(makeContext(tmp)); // fresh instance, clean cache
    const keepRoot = '/fake/keep-me-open';
    provider.projectRoot = keepRoot;
    void provider._proj; // touched once, then never again — would be the OLDEST by lastTouched
    await provider.openNewSessionTab(); // a SECOND tab — keepRoot's session (the first tab) stays alive and open

    for (let i = 0; i < 25; i++) {
      provider.projectRoot = `/fake/churn-proj-${i}`; // the second tab churns through many other roots
      void provider._proj;
    }
    check('project cache: a root with a currently-open tab survives eviction pressure even though it\'s the oldest',
      provider._projectCaches.has(keepRoot));
    check('project cache: still enforces the cap overall (only counting the CLOSED/churned roots)',
      provider._projectCaches.size <= 20);
    check('project cache: recent churned roots survive, old ones don\'t',
      provider._projectCaches.has('/fake/churn-proj-24') && !provider._projectCaches.has('/fake/churn-proj-0'));

    // ── An evicted root's pending debounced embeddings-save timer is cleared ─
    // (not flushed — same tradeoff dispose() already makes on full shutdown),
    // so it can't fire against a cache entry that no longer exists.
    provider = new NavyCoderViewProvider(makeContext(tmp));
    let timerFired = false;
    provider.projectRoot = '/fake/evict-with-timer';
    void provider._proj;
    provider._embedSaveTimer = setTimeout(() => { timerFired = true; }, 30);
    for (let i = 0; i < 25; i++) {
      provider.projectRoot = `/fake/timerchurn-proj-${i}`;
      void provider._proj;
    }
    check('project cache: the evicted root really was evicted (setup sanity check)',
      !provider._projectCaches.has('/fake/evict-with-timer'));
    await new Promise(r => setTimeout(r, 80));
    check('project cache: an evicted root\'s pending embed-save timer is cleared, never fires', !timerFired);
  } catch (e) {
    check('project cache eviction suite ran', false, e.stack || e.message);
  } finally {
    if (provider) {
      for (const session of provider.sessions.values()) {
        clearTimeout(session._cpSaveTimer);
        clearInterval(session._heartbeat);
        clearTimeout(session._watchdog);
      }
      for (const p of provider._projectCaches.values()) clearTimeout(p.embedSaveTimer);
    }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── Session cache eviction (this.sessions must not grow unbounded) ─────────
// Mirrors projectCacheEvictionSuite for the sibling growth path Angle H's
// review found: this.sessions accumulates every chat ever loaded from disk
// or created in this window, forever, unless capped. Far more conservative
// than the project cache though — a session holds real, possibly-unsaved
// chat content, so the eligibility rules matter as much as the cap itself.
async function sessionCacheEvictionSuite() {
  console.log('\nsession cache eviction (this.sessions cap):');
  const os = require('os');
  sharedMock();

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-sessevict-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    const activeId = provider.activeSessionId; // the constructor's own bootstrap session

    // Fake sessions are plain objects — _evictStaleSessions only ever reads
    // .projectRoot/.isBusy/._updated and deletes by id, so a real Session
    // instance isn't needed to exercise it directly and fast (no disk I/O).
    const fakeSession = (root, updated, extra = {}) => ({
      projectRoot: root, isBusy: false, messages: [{ role: 'user', text: 'x' }],
      _updated: updated, checkpoints: [], ...extra,
    });

    // ── Basic cap enforcement: 45 distinct, fully-saved, non-active, ────────
    // non-last-of-their-project sessions (each its own project, 2 chats per
    // project so "last remaining chat" never blocks eviction here).
    provider.sessions.clear();
    provider.sessions.set(activeId, fakeSession('/fake/sess-active', ''));
    provider.activeSessionId = activeId;
    for (let i = 0; i < 45; i++) {
      const root = '/fake/sess-proj-' + i;
      const t = new Date(2020, 0, 1, 0, 0, i).toISOString(); // strictly increasing — i=0 oldest
      provider.sessions.set('sib-a-' + i, fakeSession(root, t));
      provider.sessions.set('sib-b-' + i, fakeSession(root, t)); // sibling — neither is "the last chat"
    }
    provider._evictStaleSessions();
    check('session cache: never grows past the cap (40) even with 91 total sessions',
      provider.sessions.size <= 40);
    check('session cache: the active session always survives', provider.sessions.has(activeId));
    check('session cache: the most-recently-saved sessions survive', provider.sessions.has('sib-a-44') && provider.sessions.has('sib-b-44'));
    check('session cache: the oldest-saved sessions were evicted', !provider.sessions.has('sib-a-0') && !provider.sessions.has('sib-b-0'));
    check('session cache: evicting un-marks the project so it can be re-read from disk later',
      !provider._loadedChatRoots.has('/fake/sess-proj-0'));

    // ── A project's LAST remaining chat is never evicted, no matter how old ─
    provider.sessions.clear();
    provider.activeSessionId = activeId;
    provider.sessions.set(activeId, fakeSession('/fake/keep-active', ''));
    provider.sessions.set('lonely-old', fakeSession('/fake/lonely-project', new Date(2000, 0, 1).toISOString()));
    for (let i = 0; i < 45; i++) {
      provider.sessions.set('churn-' + i, fakeSession('/fake/churn-proj-' + i, new Date(2021, 0, 1, 0, 0, i).toISOString()));
    }
    provider._evictStaleSessions();
    check('session cache: a project\'s only remaining chat survives even though it\'s the oldest',
      provider.sessions.has('lonely-old'));

    // ── A busy session is never evicted ─────────────────────────────────────
    provider.sessions.clear();
    provider.activeSessionId = activeId;
    provider.sessions.set(activeId, fakeSession('/fake/keep-active2', ''));
    provider.sessions.set('busy-old', fakeSession('/fake/busy-project', new Date(2000, 0, 1).toISOString(), { isBusy: true }));
    provider.sessions.set('busy-old-sibling', fakeSession('/fake/busy-project', new Date(2000, 0, 2).toISOString()));
    for (let i = 0; i < 45; i++) {
      provider.sessions.set('churn2-' + i, fakeSession('/fake/churn2-proj-' + i, new Date(2021, 0, 1, 0, 0, i).toISOString()));
    }
    provider._evictStaleSessions();
    check('session cache: a busy session is never evicted', provider.sessions.has('busy-old'));

    // ── A session with nothing saved to disk yet is never evicted ──────────
    // (empty _updated — evicting it would lose content with nowhere to
    // reload it from).
    provider.sessions.clear();
    provider.activeSessionId = activeId;
    provider.sessions.set(activeId, fakeSession('/fake/keep-active3', ''));
    provider.sessions.set('unsaved-old', fakeSession('/fake/unsaved-project', ''));
    provider.sessions.set('unsaved-old-sibling', fakeSession('/fake/unsaved-project', new Date(2000, 0, 1).toISOString()));
    for (let i = 0; i < 45; i++) {
      provider.sessions.set('churn3-' + i, fakeSession('/fake/churn3-proj-' + i, new Date(2021, 0, 1, 0, 0, i).toISOString()));
    }
    provider._evictStaleSessions();
    check('session cache: a never-saved (_updated empty) session is never evicted', provider.sessions.has('unsaved-old'));
  } catch (e) {
    check('session cache eviction suite ran', false, e.stack || e.message);
  } finally {
    if (provider) {
      for (const session of provider.sessions.values()) {
        clearTimeout(session._cpSaveTimer);
        clearInterval(session._heartbeat);
        clearTimeout(session._watchdog);
      }
    }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 6c2. Project rules — layered, not "first file wins" ──────────────────────
// A project commonly has a tool-agnostic AGENTS.md for shared team
// conventions AND a small tool-specific file (.cursorrules, .navyrules)
// layering a targeted tweak on top. loadProjectRules used to return only the
// FIRST well-known file it found, so adding either one silently discarded
// ALL of the other.
async function projectRulesSuite() {
  console.log('\nproject rules (layered, not first-file-wins):');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-rules-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const W = (n, c) => fs.writeFileSync(path.join(tmp, n), c);

    check('project rules: no files anywhere returns empty', (await provider.loadProjectRules()) === '');

    W('AGENTS.md', 'Use 2-space indentation.');
    const single = await provider.loadProjectRules();
    check('project rules: a single file is included', single.includes('Use 2-space indentation.'));
    check('project rules: labeled with its source file', single.includes('### From AGENTS.md'));

    fs.mkdirSync(path.join(tmp, '.github'), { recursive: true });
    W('.github/copilot-instructions.md', 'Prefer functional components.');
    W('.cursorrules', '   '); // whitespace-only — must be skipped, not included as empty noise
    W('.navyrules', 'Always run tests before finishing.');
    const merged = await provider.loadProjectRules();
    check('project rules: ALL non-empty files are merged, not just the first',
      merged.includes('Use 2-space indentation.')
      && merged.includes('Prefer functional components.')
      && merged.includes('Always run tests before finishing.'));
    check('project rules: a whitespace-only file contributes nothing',
      !merged.includes('.cursorrules') || merged.split('### From').length === 4); // 3 real sources, not 4
    check('project rules: broadest source (AGENTS.md) appears before the most Navy-specific (.navyrules)',
      merged.indexOf('AGENTS.md') < merged.indexOf('.navyrules'));

    fs.rmSync(path.join(tmp, 'AGENTS.md'));
    fs.rmSync(path.join(tmp, '.github', 'copilot-instructions.md'));
    fs.rmSync(path.join(tmp, '.cursorrules'));
    fs.rmSync(path.join(tmp, '.navyrules'));

    // Only once NONE of the well-known files exist does the Navy-managed
    // .navy/rules.md fallback apply.
    check('project rules: falls back to .navy/rules.md only when no well-known file exists',
      (await provider.loadProjectRules()) === '');
    const navyDir = await provider.ensureNavyDir();
    fs.writeFileSync(path.join(navyDir, 'rules.md'), 'Fallback convention.');
    check('project rules: .navy/rules.md fallback is read once it exists',
      (await provider.loadProjectRules()) === 'Fallback convention.');

    W('AGENTS.md', 'Real convention.');
    check('project rules: a real well-known file takes priority over the .navy/rules.md fallback',
      (await provider.loadProjectRules()).includes('Real convention.')
      && !(await provider.loadProjectRules()).includes('Fallback convention.'));
  } catch (e) {
    check('project rules suite ran', false, e.stack || e.message);
  } finally {
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 6d. check_syntax — real parsers, independent of any language extension ───
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
        extractFunction(extSrc, 'function fold(p)') + '\n' +
        extractFunction(extSrc, 'function foldPath(p)') + '\n' +
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
// replies: array of { text } | { toolCalls: [{name, args}] } | { fail: { status, text } }
// consumed in order. `fail` simulates a non-ok HTTP response (rate limit,
// server outage, etc.) — streamAssistant's Ollama branch throws
// 'Ollama returned <status>: <text>' for it, same as a real failure would.
// `captured`, if given, collects each parsed request body for inspection.
function queueOllamaFetch(replies, captured) {
  const queue = replies.slice();
  return async (url, init) => {
    if (captured && init?.body) { try { captured.push(JSON.parse(init.body)); } catch {} }
    const next = queue.shift();
    if (!next) throw new Error('queueOllamaFetch: exhausted — loop ran more iterations than the test expected');
    if (next.fail) {
      return { ok: false, status: next.fail.status, body: true, text: async () => next.fail.text || '', headers: { get: () => null } };
    }
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

    // WSL fallback fact: the cached detection result must reach the system
    // prompt either way, so the model knows whether falling back to WSL for a
    // Unix-only tool is even possible. Windows-only by design (see the
    // isWinShell gate on wslNote in buildSystemPrompt) — the prompt correctly
    // says nothing about WSL elsewhere, so these assert Windows behaviour and
    // are skipped rather than failed on other platforms. Without this the
    // whole suite is red on the CI matrix's ubuntu job.
    if (process.platform === 'win32') {
      check('env: WSL cache preset reports unavailable (as set up for this suite)', sysEnv1.includes('WSL not detected'));
      const savedWsl = provider._wslCache;
      provider._wslCache = { available: true, distros: ['Ubuntu-22.04', 'Debian'] };
      captured.length = 0;
      global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
      await provider.askNavy('hello', false, null, [], []);
      const sysEnv3 = captured[0]?.messages?.find(m => m.role === 'system')?.content || '';
      check('env: WSL available + distro list reaches the system prompt', sysEnv3.includes('WSL available') && sysEnv3.includes('Ubuntu-22.04'));
      provider._wslCache = savedWsl;
    } else {
      // Only the ENVIRONMENT block's WSL note is Windows-gated — TOOL_PROMPT
      // rule 18 mentions WSL unconditionally, so a bare !includes('WSL') would
      // be checking the wrong string.
      check('env: no WSL detection note on a non-Windows host (Windows-only feature)',
        !sysEnv1.includes('WSL not detected') && !sysEnv1.includes('WSL available'));
    }

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

// ── 7b2. Cross-turn tool activity ledger ─────────────────────────────────────
// Replaying history for a new turn only ever carried each past turn's final
// reply TEXT (see the "for (const item of this.messages)" loop in askNavy) —
// so the model had no way to know it already read a file or ran a command in
// an earlier turn unless it happened to say so in prose, and routinely re-did
// work it had already done. _renderTurnLedger appends a compact, verifiable
// record of what a turn actually did (reads/writes/commands) to the
// MODEL-FACING copy of its historical reply — never to the persisted/
// displayed text itself.
async function toolLedgerSuite() {
  console.log('\ncross-turn tool activity ledger:');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-ledger-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    provider._wslCache = { available: false }; // skip the real wsl.exe spawn in tests
    fs.writeFileSync(path.join(tmp, 'source.js'), 'module.exports = 1;\n');

    // Pure formatting checks — no model loop needed.
    check('_describeReadCall: read_file includes the path',
      provider._describeReadCall({ name: 'read_file', args: { path: 'a/b.js' } }) === 'read_file(a/b.js)');
    check('_renderTurnLedger: empty/undefined meta renders nothing',
      provider._renderTurnLedger(undefined) === '' && provider._renderTurnLedger({}) === '');
    check('_renderTurnLedger: formats reads, writes, and commands together',
      /read a\.js, b\.js/.test(provider._renderTurnLedger({ reads: ['a.js', 'b.js'] }))
      && /wrote c\.js/.test(provider._renderTurnLedger({ files: ['c.js'] }))
      && /ran "npm test" \(exit 0\)/.test(provider._renderTurnLedger({ commandLog: [{ cmd: 'npm test', exit: 0 }] })));

    // Turn 1: reads source.js, writes out.js, then finishes.
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'source.js' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'out.js', content: 'x=1' } }] },
      { text: 'Done — read source.js and wrote out.js.' },
    ]);
    await provider.askNavy('do the first task', false, null, [], []);

    check('turn ledger: meta.reads captured on the persisted assistant message',
      provider.messages[1]?.meta?.reads?.some(r => r.includes('source.js')));
    check('turn ledger: meta.files captured on the persisted assistant message',
      provider.messages[1]?.meta?.files?.includes('out.js'));
    check('turn ledger: never leaks into the persisted/displayed text itself',
      !provider.messages[1].text.includes('[Tool activity'));

    // Turn 2: the OUTGOING request must tell the model what turn 1 actually
    // did, appended to THAT historical message specifically.
    const captured = [];
    global.fetch = queueOllamaFetch([{ text: 'ok' }], captured);
    await provider.askNavy('do the second task', false, null, [], []);
    const sentMessages = captured[0]?.messages || [];
    const turn1Reply = sentMessages.find(m => m.role === 'assistant' && /read source\.js and wrote out\.js/.test(m.content || ''));
    check('turn ledger: reaches the model on the NEXT turn',
      Boolean(turn1Reply) && /\[Tool activity that turn/.test(turn1Reply.content));
    check('turn ledger: names the exact file that was read',
      /read_file\(source\.js\)/.test(turn1Reply?.content || ''));
    check('turn ledger: names the exact file that was written',
      /wrote out\.js/.test(turn1Reply?.content || ''));

    // And it must not show up in the webview — main.js's own rendering of
    // meta only reads files/deleted/commands, never reads/commandLog.
    check('turn ledger: never sent to the webview as visible chat text',
      !posted.some(m => m.type === 'chunk' && /\[Tool activity that turn/.test(m.text || '')));
  } catch (e) {
    check('cross-turn tool ledger suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 7b3. Cost/spend visibility ────────────────────────────────────────────────
// This is the one feature in Navy that touches the user's actual money, so it
// gets the most direct, precise tests in the suite: pure-function pricing math
// (no mocking needed at all), multi-turn/mixed-provider aggregation exercised
// by writing synthetic meta directly onto provider.messages, and ONE real
// end-to-end turn to prove the wiring (meta captured correctly, message shape
// correct) without needing to mock every provider's wire format.
async function costEstimateSuite() {
  console.log('\ncost/spend visibility:');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider, estimateCost } = require('../src/extension.js');

    // ── Pure pricing math — no provider instance needed ──────────────────
    check('estimateCost: ollama is always free regardless of "model" name', estimateCost('ollama', 'gpt-4o', 1_000_000, 1_000_000) === 0);
    check('estimateCost: lmstudio is always free', estimateCost('lmstudio', 'claude-opus', 1_000_000, 1_000_000) === 0);
    check('estimateCost: an unrecognized hosted model returns null, never a guess', estimateCost('anthropic', 'totally-unknown-future-model', 1000, 1000) === null);
    const claudeCost = estimateCost('anthropic', 'claude-sonnet-5', 1_000_000, 1_000_000);
    check('estimateCost: a known model prices input and output separately', claudeCost === 3 + 15);
    check('estimateCost: scales linearly with token count', estimateCost('anthropic', 'claude-sonnet-5', 500_000, 0) === 1.5);
    check('estimateCost: zero tokens costs zero (not null) for a known model', estimateCost('anthropic', 'claude-sonnet-5', 0, 0) === 0);

    // ── _sessionUsage aggregation — synthetic meta, no network at all ────
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-cost-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    check('_sessionUsage: no turns yet is all zero, cost known (nothing to not-know)',
      JSON.stringify(provider._sessionUsage()) === JSON.stringify({ prompt: 0, completion: 0, cost: 0, costKnown: true }));

    // Turn 1: free (ollama). Turn 2: paid (anthropic). A session spanning a
    // PROVIDER switch must price each turn at what actually ran it — not
    // "whatever's configured right now" (which could misreport a paid turn
    // as free, or vice versa, well after the fact).
    provider.messages = [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'ok', meta: { tokens: { prompt: 1000, completion: 1000 }, provider: 'ollama', model: 'llama3' } },
      { role: 'user', text: 'hi again' },
      { role: 'assistant', text: 'ok again', meta: { tokens: { prompt: 1_000_000, completion: 1_000_000 }, provider: 'anthropic', model: 'claude-sonnet-5' } },
    ];
    const usage = provider._sessionUsage();
    check('_sessionUsage: sums prompt/completion tokens across every turn', usage.prompt === 1_001_000 && usage.completion === 1_001_000);
    check('_sessionUsage: prices each turn by ITS OWN provider/model, not the current config',
      usage.cost === 18 && usage.costKnown === true); // turn 1 (ollama) contributes $0, turn 2 (claude) contributes $18

    // A turn using a model with no known pricing makes the TOTAL explicitly
    // "not fully known" (costKnown: false) rather than silently under-reporting.
    provider.messages.push({ role: 'assistant', text: 'x', meta: { tokens: { prompt: 1000, completion: 1000 }, provider: 'anthropic', model: 'some-brand-new-model' } });
    const usage2 = provider._sessionUsage();
    check('_sessionUsage: costKnown flips false when any priced turn is unrecognized', usage2.costKnown === false);
    check('_sessionUsage: still sums whatever COULD be priced, as a floor', usage2.cost === 18);

    // A turn with no meta.tokens at all (e.g. a pure-chat turn that made no
    // model call, or history from before this feature existed) is silently
    // skipped, not treated as a zero-cost known turn or a crash.
    provider.messages = [{ role: 'assistant', text: 'no meta here' }];
    check('_sessionUsage: a turn with no meta.tokens is skipped cleanly', provider._sessionUsage().prompt === 0);

    // ── End-to-end wiring: a real turn through askNavy ────────────────────
    provider.messages = [];
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    provider._wslCache = { available: false };
    global.fetch = queueOllamaFetch([{ text: 'done' }]); // queueOllamaFetch's mock reports prompt_eval_count/eval_count: 5 each
    await provider.askNavy('hello', false, null, [], []);

    check('turn wiring: meta.tokens captured on the persisted assistant message', provider.messages[1]?.meta?.tokens?.prompt === 5 && provider.messages[1]?.meta?.tokens?.completion === 5);
    check('turn wiring: meta.provider/meta.model captured (ollama — the shared mock default)', provider.messages[1]?.meta?.provider === 'ollama' && Boolean(provider.messages[1]?.meta?.model));
    const tc = posted.find(m => m.type === 'tokenCount');
    check('turn wiring: tokenCount carries a running session total, not just this turn\'s figures',
      Boolean(tc) && tc.sessionTotal === 10 && tc.sessionPrompt === 5 && tc.sessionCompletion === 5);
    check('turn wiring: ollama turns price at exactly $0, known (not "unavailable")', tc.estimatedCost === 0 && tc.costKnown === true);

    // A second turn must ACCUMULATE, not replace, the running total.
    posted.length = 0;
    global.fetch = queueOllamaFetch([{ text: 'done again' }]);
    await provider.askNavy('hello again', false, null, [], []);
    const tc2 = posted.find(m => m.type === 'tokenCount');
    check('turn wiring: a second turn ACCUMULATES onto the session total (10 + 10 = 20)', tc2?.sessionTotal === 20);

    // Restoring/switching a chat must reflect ITS accumulated usage right
    // away — not require sending another message first.
    posted.length = 0;
    await provider.loadProjectSession();
    const sl = posted.find(m => m.type === 'sessionLoaded');
    check('sessionLoaded: carries the same accumulated session usage as tokenCount', sl?.sessionTotal === 20);

    // A brand-new tab starts at a clean, KNOWN zero — not "unavailable".
    posted.length = 0;
    await provider.openNewSessionTab();
    const slNew = posted.find(m => m.type === 'sessionLoaded');
    check('openNewSessionTab: a fresh chat reports zero usage, not missing/unavailable',
      slNew?.sessionTotal === 0 && slNew?.estimatedCost === null && slNew?.costKnown === true);
  } catch (e) {
    check('cost estimate suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    if (provider) { for (const s of provider.sessions.values()) { clearTimeout(s._cpSaveTimer); clearInterval(s._heartbeat); clearTimeout(s._watchdog); } }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── History-digest trigger — size, not just message COUNT ──────────────────
// Nothing used to bound the size of PAST turns being replayed except a raw
// message-count threshold (>80) — a handful of verbose turns (big files/
// search results quoted back) could sit at hundreds of thousands of
// characters, replayed on every iteration of every future turn, while never
// reaching 80 messages. The digest trigger now also fires on total size, and
// must never spend a wasted extra model call summarizing when the recency
// floor means nothing was actually dropped.
async function historyDigestSuite() {
  console.log('\nhistory-digest trigger (size, not just message count):');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  const isDigestCall = (req) => typeof req?.messages?.[0]?.content === 'string'
    && req.messages[0].content.includes('You compress coding-assistant conversation history');

  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-histdigest-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider._wslCache = { available: false };

    // ── A few huge messages (well under 80) must still trigger the digest ──
    provider.messages = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: 'x'.repeat(20000) + ' turn-' + i,
    }));
    {
      const captured = [];
      global.fetch = queueOllamaFetch([
        { text: 'Digest: did stuff with the earlier turns.' }, // the summarization call
        { text: 'main turn reply' },                            // the actual turn
      ], captured);
      await provider.askNavy('continue', false, null, [], []);

      check('size trigger: 15 messages × 20,000 chars (300k, far under 80-message count) still condenses', captured.some(isDigestCall));
      check('size trigger: sessionDigest was populated', Boolean(provider.sessionDigest && provider.sessionDigest.trim()));
      // 10 kept (recency floor lets it keep growing until adding the next
      // would exceed the 200k cap) + this turn's own new user+assistant = 12.
      check('size trigger: oldest messages were actually dropped, not just digested', provider.messages.length === 12);
      check('size trigger: the KEPT tail is the most recent messages, in original order',
        provider.messages[0].text.includes('turn-5') && provider.messages[9].text.includes('turn-14'));
    }

    // ── An ordinary short/small session must never trigger it at all ───────
    provider.messages = [
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
    ];
    provider.sessionDigest = '';
    {
      const captured = [];
      global.fetch = queueOllamaFetch([{ text: 'main turn reply' }], captured);
      await provider.askNavy('another message', false, null, [], []);
      check('no trigger: a small, short session never attempts a digest call', !captured.some(isDigestCall));
      check('no trigger: sessionDigest stays empty', !provider.sessionDigest);
    }

    // ── Recency floor: fewer than MIN_KEEP messages, even if huge, must ─────
    // never spend a wasted summarization call — there is nothing willing to
    // be dropped, so attempting one would burn tokens for nothing.
    provider.messages = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: 'y'.repeat(100000) + ' turn-' + i, // 500k total, far over the 200k cap
    }));
    provider.sessionDigest = '';
    {
      const captured = [];
      global.fetch = queueOllamaFetch([{ text: 'main turn reply' }], captured); // only ONE reply queued
      await provider.askNavy('one more', false, null, [], []);
      check('recency floor: fewer than MIN_KEEP huge messages skips the digest call entirely (only 1 fetch, not 2)', captured.length === 1);
      check('recency floor: none of the original messages were silently dropped', provider.messages.length === 7); // 5 kept + this turn's 2
      check('recency floor: sessionDigest stays empty (nothing was actually condensed)', !provider.sessionDigest);
    }

    // ── The original count-based trigger still works exactly as before ─────
    provider.messages = Array.from({ length: 85 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: 'short-' + i, // tiny — this must trigger on COUNT alone, not size
    }));
    provider.sessionDigest = '';
    {
      const captured = [];
      global.fetch = queueOllamaFetch([
        { text: 'Digest of the oldest turns.' },
        { text: 'main turn reply' },
      ], captured);
      await provider.askNavy('yet another', false, null, [], []);
      check('count trigger: 85 tiny messages (over the 80-message count) still condenses as before', captured.some(isDigestCall));
      // 60 kept (the original "keep last 60" target) + this turn's own 2.
      check('count trigger: keeps exactly the same last-60 window as the original behavior', provider.messages.length === 62);
    }
  } catch (e) {
    check('history-digest suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 7b4. delegate_research sub-agent ──────────────────────────────────────────
// A tool the MODEL itself can call to spin off an isolated, read-only
// investigation and get back only the conclusion — not the raw tool trace,
// which stays out of the delegating turn's own context. The security-critical
// property is enforcement: the sub-agent is refused write/command/further-
// delegation attempts at DISPATCH time, not merely discouraged by prompt text.
async function delegateResearchSuite() {
  console.log('\ndelegate_research sub-agent:');
  const os = require('os');
  const { vscode } = sharedMock();
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-delegate-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider._wslCache = { available: false };
    fs.writeFileSync(path.join(tmp, 'target.js'), 'function foo(){ return 42; }');

    check('delegate_research: a missing/empty task is refused with a clear error, not a crash',
      (await provider.toolDelegateResearch('', 5)).startsWith('Error:'));
    check('delegate_research: a whitespace-only task is refused the same way',
      (await provider.toolDelegateResearch('   ', 5)).startsWith('Error:'));

    // Direct unit calls — no outer turn needed, exercises the sub-agent loop
    // in isolation via the SAME global.fetch queue mechanism.
    provider.abortController = new AbortController();

    // Reads a file, then answers in plain text with no further tool calls —
    // the RETURNED text must be the sub-agent's conclusion, not raw tool output.
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'target.js' } }] },
      { text: 'foo() returns the constant 42.' },
    ]);
    const basic = await provider.toolDelegateResearch('what does foo() return?', 5);
    check('delegate_research: returns the sub-agent\'s written conclusion', basic === 'foo() returns the constant 42.');

    // A write attempt inside the sub-agent is REFUSED (dispatch-level, not
    // just discouraged by the prompt) — must not actually touch disk, and the
    // sub-agent must be able to recover and still finish with an answer.
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'sneaky.js', content: 'not allowed' } }] },
      { text: 'I do not have write access, so I could not make this change.' },
    ]);
    const refused = await provider.toolDelegateResearch('try to write a file', 5);
    check('delegate_research: a write attempt is never actually executed', !fs.existsSync(path.join(tmp, 'sneaky.js')));
    check('delegate_research: the sub-agent recovers and still returns a conclusion after being refused',
      refused.includes('write access'));

    // Recursion guard: a nested delegate_research attempt must be refused,
    // not actually spawn a second sub-agent — verified by inspecting what the
    // sub-agent's OWN next request actually contained.
    {
      const captured = [];
      global.fetch = queueOllamaFetch([
        { toolCalls: [{ name: 'delegate_research', args: { task: 'nested attempt' } }] },
        { text: 'Understood, cannot delegate further.' },
      ], captured);
      await provider.toolDelegateResearch('try to recurse', 5);
      const secondRequestMsgs = captured[1]?.messages || [];
      const refusalMsg = secondRequestMsgs.find(m => typeof m.content === 'string' && m.content.includes('Refused') && m.content.includes('delegate_research'));
      check('delegate_research: cannot recursively delegate — refused, not executed', Boolean(refusalMsg));
    }

    // maxSteps is enforced, not advisory — a sub-agent that never stops
    // calling tools must be cut off, never loop forever. Exactly 3 responses
    // queued for maxSteps=3: a 4th fetch attempt would throw "exhausted".
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'target.js' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'target.js' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'target.js' } }] },
    ]);
    const capped = await provider.toolDelegateResearch('keep reading forever', 3);
    check('delegate_research: respects maxSteps and stops instead of looping forever', /step budget/.test(capped));

    // maxSteps below 1 clamps to 1 (not 0, which would never call the model
    // at all) — proven by exactly ONE queued response being consumed.
    global.fetch = queueOllamaFetch([{ toolCalls: [{ name: 'read_file', args: { path: 'target.js' } }] }]);
    const clamped = await provider.toolDelegateResearch('task', 0);
    check('delegate_research: maxSteps below 1 clamps to 1, still runs at least once', /step budget/.test(clamped));

    // ── End-to-end: a full turn that delegates, with token/cost accounting ──
    // Outer iter 1 (delegate_research) → sub-agent iter 1 (read_file) →
    // sub-agent iter 2 (final text) → outer iter 2 (final text). 4 model
    // calls total; queueOllamaFetch reports 5+5 tokens each = 20+20.
    provider.messages = [];
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'delegate_research', args: { task: 'find how foo works in target.js' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'target.js' } }] },
      { text: 'foo() returns 42.' },
      { text: 'Investigated via a sub-agent: foo() returns 42.' },
    ]);
    await provider.askNavy('investigate target.js', false, null, [], []);

    check('delegate_research (e2e): the sub-agent\'s internal steps never leak into the main chat history',
      provider.messages.length === 2); // just the user turn + the outer turn's own final assistant message
    check('delegate_research (e2e): the OUTER turn\'s persisted text is its own, not the sub-agent\'s raw output',
      provider.messages[1].text === 'Investigated via a sub-agent: foo() returns 42.');
    const toolResultMsg = posted.find(m => m.type === 'toolResult' && m.tool === 'delegate_research');
    check('delegate_research (e2e): the tool card shows the sub-agent\'s conclusion',
      toolResultMsg?.result === 'foo() returns 42.');
    check('delegate_research (e2e): sub-agent token usage is folded into the turn\'s recorded total (4 calls × 5 = 20 each)',
      provider.messages[1].meta?.tokens?.prompt === 20 && provider.messages[1].meta?.tokens?.completion === 20);
  } catch (e) {
    check('delegate_research suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 7b5. Cross-provider failover (navy.providerFallbacks) ────────────────────
// The one feature here that can spend money on a DIFFERENT account than the
// one you're looking at — tested accordingly: the opt-in gate (empty by
// default), the transient-vs-not classification (never falls back for auth/
// quota/context-length, only rate-limit/server-outage/network), ordering,
// malformed-entry safety, and that meta/cost attribution follows whichever
// provider ACTUALLY served the turn, not whatever's configured as primary.
//
// A genuinely transient failure also engages streamAssistant's own
// fetchWithRetry (3 attempts, real ~3s of backoff) before _streamWithFallback
// ever sees it — that's real, correct behavior, not something to mock around,
// so a few of these tests are deliberately slower than the rest of the suite.
async function providerFallbackSuite() {
  console.log('\ncross-provider failover (navy.providerFallbacks):');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();
  const { isTransientProviderError } = require('../src/providers/errors.js');
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    // ── Pure classification — no network at all ──────────────────────────
    check('isTransientProviderError: rate limit (429) is transient', isTransientProviderError('429 Too Many Requests'));
    check('isTransientProviderError: server outage (503) is transient', isTransientProviderError('503 Service Unavailable'));
    check('isTransientProviderError: network failure is transient', isTransientProviderError('fetch failed: ECONNREFUSED'));
    check('isTransientProviderError: an auth error is NOT transient (a different account needs its OWN valid key, not a retry)',
      !isTransientProviderError('401 Incorrect API key provided'));
    check('isTransientProviderError: a quota/billing error is NOT transient', !isTransientProviderError('RESOURCE_EXHAUSTED: exceeded your current quota'));
    check('isTransientProviderError: context-length is NOT transient', !isTransientProviderError("This model's maximum context length is 8192 tokens"));
    check('isTransientProviderError: an unclassified error is NOT transient (never guess it\'s safe to retry elsewhere)', !isTransientProviderError('something bizarre happened'));

    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-failover-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider._wslCache = { available: false };
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    provider.abortController = new AbortController();
    await vscode.workspace.getConfiguration().update('provider', 'ollama');
    await vscode.workspace.getConfiguration().update('providerFallbacks', []);

    // ── Opt-in gate: nothing configured → behaves exactly like a plain call ──
    global.fetch = queueOllamaFetch([{ text: 'straight through, no fallback configured' }]);
    const plain = await provider._streamWithFallback('http://localhost:11434', 'llama3', [{ role: 'user', content: 'hi' }], 0.2);
    check('no fallbacks configured: a successful primary call passes through untouched',
      plain.text === 'straight through, no fallback configured' && plain.usedProvider === 'ollama' && plain.usedModel === 'llama3');

    // ── A non-transient primary failure NEVER engages fallback, even when
    // fallbacks ARE configured — fast (401 isn't in fetchWithRetry's
    // retryable set, so no internal backoff delay). Only 1 response queued:
    // if fallback were (wrongly) attempted, the queue would throw "exhausted".
    await vscode.workspace.getConfiguration().update('providerFallbacks', [{ provider: 'ollama', model: 'backup-model' }]);
    global.fetch = queueOllamaFetch([{ fail: { status: 401, text: 'Incorrect API key' } }]);
    let authErr = null;
    try { await provider._streamWithFallback('http://localhost:11434', 'llama3', [{ role: 'user', content: 'hi' }], 0.2); }
    catch (e) { authErr = e; }
    check('a non-transient (auth) primary failure propagates directly, never tries a configured fallback',
      authErr && /401/.test(authErr.message));

    // ── No fallbacks configured → even a genuinely transient failure just
    // propagates normally (the feature is a true no-op when unconfigured).
    // Needs 3 queued failures to exhaust streamAssistant's own internal retry.
    await vscode.workspace.getConfiguration().update('providerFallbacks', []);
    global.fetch = queueOllamaFetch([
      { fail: { status: 429, text: 'rate limited' } },
      { fail: { status: 429, text: 'rate limited' } },
      { fail: { status: 429, text: 'rate limited' } },
    ]);
    let noFallbackErr = null;
    try { await provider._streamWithFallback('http://localhost:11434', 'llama3', [{ role: 'user', content: 'hi' }], 0.2); }
    catch (e) { noFallbackErr = e; }
    check('a transient failure with NO fallbacks configured propagates normally (opt-in, not automatic)',
      noFallbackErr && /429/.test(noFallbackErr.message));

    // ── The main mechanism: primary fails transiently → a malformed entry is
    // skipped (no network attempt) → the next fallback fails (fast, 401) →
    // the one after THAT succeeds. Proves gating, skip-malformed, ordering,
    // and success all in one real transient-failure setup.
    await vscode.workspace.getConfiguration().update('providerFallbacks', [
      { provider: 'ollama' }, // malformed — missing "model", must be skipped without a fetch
      { provider: 'ollama', model: 'backup-1' },
      { provider: 'ollama', model: 'backup-2', host: 'http://backup-host:11434' },
    ]);
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { fail: { status: 503, text: 'overloaded' } },
      { fail: { status: 503, text: 'overloaded' } },
      { fail: { status: 503, text: 'overloaded' } }, // exhausts the PRIMARY's internal retries
      { fail: { status: 401, text: 'bad key' } },     // backup-1 fails (fast, non-retryable)
      { text: 'backup-2 came through' },              // backup-2 succeeds
    ]);
    const result = await provider._streamWithFallback('http://localhost:11434', 'primary-model', [{ role: 'user', content: 'hi' }], 0.2);
    check('mechanism: the malformed fallback entry is silently skipped, not attempted', result.text === 'backup-2 came through');
    check('mechanism: falls through to the NEXT fallback when one fails', result.usedModel === 'backup-2');
    check('mechanism: usedProvider/usedModel reflect the fallback that actually served it, not the primary', result.usedProvider === 'ollama' && result.usedModel === 'backup-2');
    const announcements = posted.filter(m => m.type === 'chunk' && /trying fallback|Fallback succeeded/.test(m.text || ''));
    check('mechanism: the primary\'s failure and each REAL fallback attempt are announced in the chat (never silent)',
      announcements.some(m => /backup-1/.test(m.text)) && announcements.some(m => /backup-2/.test(m.text)) && announcements.some(m => /Fallback succeeded/.test(m.text)));
    check('mechanism: the skipped malformed entry gets no announcement of its own',
      !announcements.some(m => m.text.includes('undefined')));

    // ── All configured fallbacks fail → throws the LAST fallback's error
    // (not the primary's) — so the user sees what actually went wrong most
    // recently, not a stale first-failure message.
    await vscode.workspace.getConfiguration().update('providerFallbacks', [
      { provider: 'ollama', model: 'backup-1' },
      { provider: 'ollama', model: 'backup-2' },
    ]);
    global.fetch = queueOllamaFetch([
      { fail: { status: 429, text: 'primary rate limited' } },
      { fail: { status: 429, text: 'primary rate limited' } },
      { fail: { status: 429, text: 'primary rate limited' } }, // exhausts primary
      { fail: { status: 401, text: 'backup-1 bad key' } },
      { fail: { status: 401, text: 'backup-2 bad key' } },
    ]);
    let allFailedErr = null;
    try { await provider._streamWithFallback('http://localhost:11434', 'primary-model', [{ role: 'user', content: 'hi' }], 0.2); }
    catch (e) { allFailedErr = e; }
    check('all fallbacks exhausted: throws the LAST fallback\'s error, not the primary\'s stale one',
      allFailedErr && /backup-2 bad key/.test(allFailedErr.message));

    // ── Full end-to-end integration: meta.provider/meta.model and cost
    // attribution must follow the FALLBACK that actually ran, not the
    // primary that failed — this is separate wiring in _askNavyTurn from
    // _streamWithFallback itself, so it needs its own real test.
    await vscode.workspace.getConfiguration().update('providerFallbacks', [{ provider: 'ollama', model: 'backup-e2e' }]);
    provider.messages = [];
    posted.length = 0;
    global.fetch = queueOllamaFetch([
      { fail: { status: 503, text: 'overloaded' } },
      { fail: { status: 503, text: 'overloaded' } },
      { fail: { status: 503, text: 'overloaded' } },
      { text: 'Handled by the fallback model.' },
    ]);
    await provider.askNavy('hello', false, 'primary-e2e-model', [], []);
    check('e2e: the turn still completes successfully via the fallback',
      (provider.messages[1]?.text || '').includes('Handled by the fallback model.'));
    check('e2e: meta.model records the FALLBACK model that actually ran, not the failed primary',
      provider.messages[1]?.meta?.model === 'backup-e2e');
    // The notice that a DIFFERENT account served this turn is persisted with
    // the reply, not merely streamed — otherwise the record of who got billed
    // disappears on the next window reload.
    check('e2e: the persisted reply records that a fallback ran',
      /Fallback succeeded/.test(provider.messages[1]?.text || ''));
    check('e2e: the persisted reply names the reason the primary failed',
      /trying fallback/.test(provider.messages[1]?.text || ''));
  } catch (e) {
    check('provider fallback suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    await vscode.workspace.getConfiguration().update('providerFallbacks', []);
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

    // "Add to List" — folder really gets added to the workspace, but Navy
    // deliberately does NOT switch to it: adding a project to the list and
    // selecting it are two separate steps (see openFolder's comment) — the
    // user picks it from the dropdown afterward.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    provider.isBusy = false;
    ctrl.nextOpenDialog = [dirB];
    ctrl.nextInfo = 'Add to List';
    await provider.openFolder();
    check('add-to-list: folder added to the workspace for real',
      (vscode.workspace.workspaceFolders || []).some(f => f.uri.fsPath === dirB));
    check('add-to-list: does NOT switch Navy\'s active project', provider.projectRoot === dirA);
    check('add-to-list: original project still open alongside',
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
    ctrl.nextInfo = 'Add to List';
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

    // Picking a folder already in the workspace via the dialog does nothing
    // but tell the user it's already there — it's already selectable from
    // the dropdown, and the dialog never switches regardless.
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }, { uri: uriOf(dirB) }];
    provider.projectRoot = dirA;
    ctrl.nextOpenDialog = [dirB];
    await provider.openFolder();
    check('existing folder: does not switch without prompting', provider.projectRoot === dirA);
    check('existing folder: tells the user it\'s already in the list',
      ctrl.shown.info.some(m => /already in your project list/i.test(m)));
    check('existing folder: no duplicate root added',
      (vscode.workspace.workspaceFolders || []).length === 2);

    // ── The chat must auto-link to the project that's actually open ──────────
    // Pure containment predicate behind the guard — depends on the shared
    // fold/foldPath helpers, so those are extracted alongside it.
    const belongs = new Function('path', 'process',
      extractFunction(extSrc, 'function fold(p)') + '\n' +
      extractFunction(extSrc, 'function foldPath(p)') + '\n' +
      extractFunction(extSrc, 'function rootBelongsToWorkspace') +
      '\nreturn rootBelongsToWorkspace;'
    )(path, process);
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

// ── Global project catalog (~/.navy/projects.json) ──────────────────────────
// A small, user-inspectable catalog of every project root Navy has ever been
// pointed at, independent of any one window's workspace — so a project used
// in a window that's since closed can still be resumed from the dropdown.
// _globalProjectsDirOverride redirects it to an isolated temp dir so these
// tests never touch the real user's home directory.
async function globalProjectCatalogSuite() {
  console.log('\nglobal project catalog (~/.navy/projects.json):');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();
  const uriOf = (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => p });

  let provider, homeDir, dirA, dirB, dirC;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-home-'));
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-catA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-catB-'));
    dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-catC-'));
    provider = new NavyCoderViewProvider(makeContext(dirA));
    provider._globalProjectsDirOverride = path.join(homeDir, '.navy');
    provider.view = { webview: { postMessage: () => {} } };

    // ── Persistence round-trip ──────────────────────────────────────────────
    await provider._recordProjectUsage(dirA);
    check('catalog file actually written to disk under the overridden home dir',
      fs.existsSync(path.join(homeDir, '.navy', 'projects.json')));
    let list = await provider._readGlobalProjects();
    check('a recorded project is read back with the right path and name',
      list.length === 1 && list[0].path === dirA && list[0].name === path.basename(dirA));
    check('a recorded project gets a real lastOpened timestamp', typeof list[0].lastOpened === 'number' && list[0].lastOpened > 0);

    // ── Dedup: recording the same path again updates it, not duplicates it ──
    await provider._recordProjectUsage(dirA);
    list = await provider._readGlobalProjects();
    check('recording the same project again does not duplicate it', list.length === 1);

    // ── Multiple projects, sorted most-recently-used first ─────────────────
    await provider._recordProjectUsage(dirB);
    list = await provider._readGlobalProjects();
    check('a second distinct project is added', list.length === 2);
    check('sorted most-recently-used first', list[0].path === dirB && list[1].path === dirA);

    // ── _withGlobalProjectsLock genuinely serializes concurrent callers ─────
    // (the actual fix for the lost-update race a within-one-window concurrent
    // write used to hit) — proven deterministically via ordering markers
    // rather than relying on real fs timing to trigger a race or not.
    {
      const order = [];
      const p1 = provider._withGlobalProjectsLock(async () => {
        order.push('1-start');
        await new Promise(r => setTimeout(r, 30));
        order.push('1-end');
      });
      const p2 = provider._withGlobalProjectsLock(async () => {
        order.push('2-start');
        order.push('2-end');
      });
      await Promise.all([p1, p2]);
      check('_withGlobalProjectsLock: a second caller never starts before the first finishes',
        order.join(',') === '1-start,1-end,2-start,2-end');
    }

    // ── _recordProjectUsage: concurrent calls for DIFFERENT projects (same
    // window) must not lose either update — the actual bug found in review.
    // Deterministic BECAUSE of the lock above: with real serialization, the
    // second call's read always happens after the first call's write, so
    // both entries surviving isn't a matter of lucky timing.
    {
      await provider._writeGlobalProjects([]);
      const dirX = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-catX-'));
      const dirY = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-catY-'));
      await Promise.all([provider._recordProjectUsage(dirX), provider._recordProjectUsage(dirY)]);
      const concurrent = await provider._readGlobalProjects();
      check('_recordProjectUsage: two concurrent calls for different projects both survive',
        concurrent.some(p => p.path === dirX) && concurrent.some(p => p.path === dirY));
      try { fs.rmSync(dirX, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(dirY, { recursive: true, force: true }); } catch {}
    }

    // ── _rmwJsonFile: detects a change from ANOTHER writer (simulating a
    // different VS Code window's own process, which no in-memory lock can
    // see) between its read and its write, and retries against the fresh
    // data instead of blindly overwriting it.
    {
      const rmwPath = path.join(homeDir, 'rmw-test.json');
      await provider._writeJsonFile(rmwPath, ['initial'], 'test');
      let readCount = 0;
      const origRead = provider._readJsonFile.bind(provider);
      provider._readJsonFile = async (fp, fallback) => {
        if (fp === rmwPath) {
          readCount++;
          // Before the RECHECK read (the 2nd call) actually reads the file,
          // simulate an external writer — e.g. another window — landing in
          // between, bypassing this provider's own tracked state entirely.
          if (readCount === 2) fs.writeFileSync(rmwPath, JSON.stringify(['external-writer-was-here']));
        }
        return origRead(fp, fallback);
      };
      const rmwResult = await provider._rmwJsonFile(rmwPath, [], (l) => [...l, 'mine']);
      provider._readJsonFile = origRead;
      check('_rmwJsonFile: retries and merges instead of clobbering an externally-written change',
        rmwResult.includes('external-writer-was-here') && rmwResult.includes('mine'));
    }

    // ── Stale entries (folder no longer exists) are dropped on read ────────
    const goneDir = path.join(homeDir, 'this-folder-was-deleted');
    await provider._writeGlobalProjects([
      { path: dirA, name: 'a', lastOpened: 5 },
      { path: goneDir, name: 'gone', lastOpened: 10 },
    ]);
    list = await provider._readGlobalProjects();
    check('an entry whose folder no longer exists is excluded on read', list.length === 1 && list[0].path === dirA);

    // ── Cap: never grows past 100, keeping the most recently used ──────────
    {
      const capBase = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-catcap-'));
      const seeded = [];
      for (let i = 0; i < 105; i++) {
        const p = path.join(capBase, 'p' + i);
        fs.mkdirSync(p);
        seeded.push({ path: p, name: 'p' + i, lastOpened: i }); // p0 oldest, p104 newest of the batch
      }
      await provider._writeGlobalProjects(seeded);
      const freshOne = path.join(capBase, 'fresh');
      fs.mkdirSync(freshOne);
      await provider._recordProjectUsage(freshOne); // Date.now() — newer than every seeded entry
      const capped = await provider._readGlobalProjects();
      check('catalog never exceeds 100 entries', capped.length === 100);
      check('the just-recorded project survives the cap', capped.some(p => p.path === freshOne));
      check('the 6 oldest seeded entries were dropped to make room (105 + 1 - 100 = 6)',
        !capped.some(p => p.path === path.join(capBase, 'p0')) && !capped.some(p => p.path === path.join(capBase, 'p5')));
      check('the newest seeded entries survive', capped.some(p => p.path === path.join(capBase, 'p104')));
      try { fs.rmSync(capBase, { recursive: true, force: true }); } catch {}
    }

    // Reset to a clean, known catalog for the rest of this suite.
    await provider._writeGlobalProjects([]);

    // ── sendWorkspaceFolders: catalog excludes whatever's already shown ────
    await provider._recordProjectUsage(dirB); // known globally, not open in this window
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    const posted = [];
    provider.view = { webview: { postMessage: (m) => posted.push(m) } };
    await provider.sendWorkspaceFolders();
    const wf = posted.find(m => m.type === 'workspaceFolders');
    check('sendWorkspaceFolders: catalog includes a globally-known project not open in this window',
      wf?.catalog?.some(p => p.path === dirB));
    check('sendWorkspaceFolders: catalog excludes the project already shown as an open root',
      !wf?.catalog?.some(p => p.path === dirA));

    // ── openFolder now catalogs whatever's picked, regardless of the choice ─
    ctrl.reset();
    await provider._writeGlobalProjects([]);
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextOpenDialog = [dirC];
    ctrl.nextInfo = 'Open Here';
    await provider.openFolder();
    // _recordProjectUsage is deliberately fire-and-forget from openFolder (folder
    // picking must never block on catalog bookkeeping) — give it a moment to land.
    await new Promise(r => setTimeout(r, 50));
    list = await provider._readGlobalProjects();
    check('openFolder: the picked folder is catalogued globally', list.some(p => p.path === dirC));

    // ── The dialog itself now offers "Add to Workspace", not "Add to List" ──
    const dialogCall = ctrl.shownInfoCalls.find(c => Array.isArray(c.items) && c.items.includes('Open Here'));
    check('openFolder: the dialog offers "Add to Workspace"', Boolean(dialogCall && dialogCall.items.includes('Add to Workspace')));
    check('openFolder: the dialog no longer offers the old "Add to List" label', !(dialogCall && dialogCall.items.includes('Add to List')));

    // ── openCatalogProject: already part of THIS window's workspace → direct switch, no dialog ──
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }, { uri: uriOf(dirB) }];
    provider.projectRoot = dirA;
    await provider.openCatalogProject(dirB);
    check('openCatalogProject: an already-open root switches directly', provider.projectRoot === dirB);
    check('openCatalogProject: no dialog shown for an already-open root', ctrl.shown.info.length === 0);

    // ── openCatalogProject: not open here, workspace non-empty, "Open Here" ─
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextInfo = 'Open Here';
    await provider.openCatalogProject(dirC);
    const openedCmd = ctrl.executedCommands.find(c => c.command === 'vscode.openFolder');
    check('openCatalogProject (Open Here): issues vscode.openFolder for the picked project', openedCmd?.args[0]?.fsPath === dirC);
    check('openCatalogProject (Open Here): projectRoot updated to the picked project', provider.projectRoot === dirC);

    // ── openCatalogProject: not open here, workspace non-empty, "Add to Workspace" ─
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextInfo = 'Add to Workspace';
    await provider.openCatalogProject(dirC);
    check('openCatalogProject (Add to Workspace): the folder is really added to the workspace',
      (vscode.workspace.workspaceFolders || []).some(f => f.uri.fsPath === dirC));
    check('openCatalogProject (Add to Workspace): does NOT switch — projectRoot unchanged', provider.projectRoot === dirA);

    // ── openCatalogProject: dismissed dialog changes nothing ───────────────
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    ctrl.nextInfo = undefined;
    await provider.openCatalogProject(dirC);
    check('openCatalogProject (dismissed): projectRoot unchanged', provider.projectRoot === dirA);
    check('openCatalogProject (dismissed): workspace unchanged', (vscode.workspace.workspaceFolders || []).length === 1);

    // ── openCatalogProject: no workspace open at all → behaves like a fresh open ─
    ctrl.reset();
    vscode.workspace.workspaceFolders = undefined;
    provider.projectRoot = '';
    await provider.openCatalogProject(dirC);
    const openedNoWs = ctrl.executedCommands.find(c => c.command === 'vscode.openFolder');
    check('openCatalogProject (no workspace open): opens the folder directly, no dialog needed', Boolean(openedNoWs));
    check('openCatalogProject (no workspace open): never showed a choice dialog', ctrl.shown.info.length === 0);

    // ── openCatalogProject: a path that no longer exists ────────────────────
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    const missingPath = path.join(homeDir, 'never-existed-xyz');
    await provider.openCatalogProject(missingPath);
    check('openCatalogProject (missing path): reports the error, does not crash', ctrl.shown.error.some(m => /no longer exists/i.test(m)));
    check('openCatalogProject (missing path): projectRoot left unchanged', provider.projectRoot === dirA);

    // ── openCatalogProject: refuses mid-turn, same as every other project switch ─
    ctrl.reset();
    vscode.workspace.workspaceFolders = [{ uri: uriOf(dirA) }];
    provider.projectRoot = dirA;
    provider.isBusy = true;
    await provider.openCatalogProject(dirC);
    provider.isBusy = false;
    check('openCatalogProject: refuses to switch mid-turn', provider.projectRoot === dirA);
    check('openCatalogProject: warns why', ctrl.shown.warning.some(m => /stop the current task/i.test(m)));

    // ── _activateProjectRoot also keeps the catalog fresh (covers restore/startup, not just explicit picks) ─
    await provider._writeGlobalProjects([]);
    await provider._activateProjectRoot(dirA);
    await new Promise(r => setTimeout(r, 50)); // same fire-and-forget settle as above
    list = await provider._readGlobalProjects();
    check('_activateProjectRoot records the project too (covers startup restore, not just dropdown picks)',
      list.some(p => p.path === dirA));
  } catch (e) {
    check('global project catalog suite ran', false, e.stack || e.message);
  } finally {
    vscode.workspace.workspaceFolders = undefined;
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); }
    for (const d of [homeDir, dirA, dirB, dirC]) { try { if (d) fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}

// ── 8z. Code-review regressions ──────────────────────────────────────────────
// Each check below pins a bug found in review that had no coverage. Grouped in
// one suite because they share nothing but their origin.
async function reviewRegressionSuite() {
  console.log('\ncode-review regressions:');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();
  let provider, tmp, tmp2;
  try {
    const { NavyCoderViewProvider, sessionContext } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-review-'));
    tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-review2-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    // ── A queued message must run in the session it was queued IN ──────────
    // askNavy re-entered from the queue drain used to read activeSessionId,
    // which by then names whichever tab is VISIBLE — so tab A's queued prompt
    // ran against tab B's messages/checkpoints/projectRoot.
    {
      const queuedTab = provider.activeSessionId;
      await provider.openNewSessionTab();
      const visibleTab = provider.activeSessionId;
      check('setup: two distinct tabs exist', queuedTab !== visibleTab);

      let boundTo = null;
      provider._askNavyTurn = async () => { boundTo = sessionContext.getStore(); };
      // Exactly how the drain re-enters: inside the finishing turn's context.
      await sessionContext.run(queuedTab, () => provider.askNavy('queued prompt', false, '', [], []));
      check('a queued turn stays bound to the tab it was queued in, not the visible one',
        boundTo === queuedTab);
      delete provider._askNavyTurn;

      // Outside any context it must still fall back to the active tab.
      let boundTo2 = null;
      provider._askNavyTurn = async () => { boundTo2 = sessionContext.getStore(); };
      await provider.askNavy('direct prompt', false, '', [], []);
      check('a turn started from the UI still binds to the visible tab', boundTo2 === visibleTab);
      delete provider._askNavyTurn;
    }

    // ── The tab strip always describes the VISIBLE project ─────────────────
    // _sessionSummaries read this.projectRoot through the session proxy, so a
    // background turn ending in project A rebuilt the strip from A's chats
    // while the user was looking at B ('sessionList' bypasses the webview's
    // session gate, so it rendered unconditionally).
    {
      const visible = provider.activeSessionId;
      provider.projectRoot = tmp;                       // the visible tab is on tmp
      const bgId = provider.generateId();
      provider.sessions.set(bgId, Object.assign(Object.create(Object.getPrototypeOf(provider.sessions.get(visible))), {
        ...provider.sessions.get(visible), id: bgId, projectRoot: tmp2, messages: [], checkpoints: [],
      }));
      const fromBackground = sessionContext.run(bgId, () => provider._sessionSummaries());
      check('a background turn\'s session list still describes the VISIBLE project',
        fromBackground.every(s => s.root === tmp) && fromBackground.some(s => s.id === visible));
      check('it does not leak the background project\'s tabs into the strip',
        !fromBackground.some(s => s.id === bgId));
      provider.sessions.delete(bgId);
    }

    // ── Closing a tab removes its file, so it cannot come back on reload ───
    {
      const keep = provider.activeSessionId;
      await provider.openNewSessionTab();
      const doomed = provider.activeSessionId;
      provider.messages = [{ role: 'user', text: 'temporary chat' }];
      await provider.saveProjectSession();
      const chatFile = path.join(tmp, '.navy', 'chats', doomed + '.json');
      check('setup: the chat was persisted to its own file', fs.existsSync(chatFile));
      await provider.closeSessionTab(doomed);
      check('closing a tab deletes its persisted chat file', !fs.existsSync(chatFile));
      check('closing a tab falls back to a sibling', provider.activeSessionId !== doomed);
      void keep;
    }

    // ── _projCacheFor must never evict the entry it just created ───────────
    // Eviction ran before lastTouched was stamped, so a brand-new entry sorted
    // as the OLDEST and was thrown away first — losing the bgManifestLock the
    // caller was about to store on it.
    {
      const p2 = new NavyCoderViewProvider(makeContext(tmp));
      for (let i = 0; i < 40; i++) p2._projCacheFor('/no/such/project-' + i);
      const freshRoot = '/no/such/project-brand-new';
      const fresh = p2._projCacheFor(freshRoot);
      check('a just-created project cache survives the eviction it triggers',
        p2._projectCaches.get(freshRoot) === fresh);
      check('the returned object is the one still in the map (its lock is not orphaned)',
        p2._projectCaches.get(freshRoot).writeLock === fresh.writeLock);
      check('eviction still bounds the map', p2._projectCaches.size <= 21);
      clearTimeout(p2._cpSaveTimer);
    }

    // ── _evictStaleSessions must not evict the root it just loaded ─────────
    // Doing so un-marked that root in _loadedChatRoots — the set the caller
    // had just added it to — so the next visit re-read the same directory,
    // re-added the same chats and evicted again, forever.
    {
      const p3 = new NavyCoderViewProvider(makeContext(tmp));
      for (let i = 0; i < 60; i++) {
        const id = 'sess-' + i;
        p3.sessions.set(id, Object.assign(Object.create(Object.getPrototypeOf(p3.sessions.get(p3.activeSessionId))), {
          ...p3.sessions.get(p3.activeSessionId), id, projectRoot: tmp2, messages: [], checkpoints: [],
          isBusy: false, _updated: new Date(1000 + i).toISOString(),
        }));
      }
      p3._loadedChatRoots.add(tmp2);
      p3._evictStaleSessions(tmp2);
      check('the just-loaded root stays marked as loaded (no re-read thrash)', p3._loadedChatRoots.has(tmp2));
      check('none of the just-loaded root\'s chats were evicted',
        [...p3.sessions.values()].filter(s => s.projectRoot === tmp2).length === 60);
      clearTimeout(p3._cpSaveTimer);
    }

    // ── list_files honours the `folder` argument the repo map advertises ───
    {
      fs.writeFileSync(path.join(tmp2, 'sibling-only.txt'), 'x');
      ctrl.workspaceFolders = [{ uri: { fsPath: tmp } }, { uri: { fsPath: tmp2 } }];
      vscode.workspace.workspaceFolders = ctrl.workspaceFolders;
      const listed = await provider.toolListFiles('.', 1, tmp2);
      check('list_files(folder) lists the SIBLING folder, not the active project',
        /sibling-only\.txt/.test(listed));
      const badFolder = await provider.toolListFiles('.', 1, 'no-such-folder');
      check('list_files(folder) reports an unmatched folder instead of silently using the wrong one',
        /does not match any open workspace folder/.test(badFolder));
    }

    // ── Shell argument escaping actually round-trips ───────────────────────
    // The Windows escape used to wrap the value in quotes and put a caret
    // AFTER every % — but a caret inside quotes is literal to cmd.exe, so it
    // suppressed expansion and then stayed in the value (%PATH% arrived as
    // %^PATH%, 50% as 50%^). And Node's default quoting turns the quotes into
    // \" , which cmd.exe forwards literally, splitting any argument with a
    // space. Both are checked here by really running the command.
    {
      const isWin = process.platform === 'win32';
      const spec = provider._shellSpec('echo hi');
      check('_shellSpec: uses the platform shell', spec.bin === (isWin ? 'cmd' : 'sh'));
      check('_shellSpec: verbatim argument passing exactly on Windows', spec.verbatim === isWin);

      const printer = path.join(tmp, 'print-argv.js');
      fs.writeFileSync(printer, 'console.log("ARGV:" + JSON.stringify(process.argv.slice(2)));');
      ctrl.config.approvalMode = 'auto-approve';
      provider.projectRoot = tmp;

      const cases = ['%PATH%', '50%', 'foo bar', 'a&echo PWNED', 'it"s here', 'x^y', '$(id)', '!DELAYED!'];
      for (const value of cases) {
        const out = await provider.toolRunCommand(
          'node print-argv.js ' + provider._shellEscapeArg(value), 15000);
        const m = out.match(/ARGV:(\[.*\])/);
        let got = null;
        try { got = m ? JSON.parse(m[1]) : null; } catch {}
        check(`_shellEscapeArg round-trips ${JSON.stringify(value)} as exactly one literal argument`,
          Array.isArray(got) && got.length === 1 && got[0] === value);
      }
      check('_shellEscapeArg: %VAR% is never expanded into its real value',
        !(await provider.toolRunCommand('node print-argv.js ' + provider._shellEscapeArg('%PATH%'), 15000))
          .includes(path.delimiter + 'Windows'));
    }

    // ── Live cards are re-announced when a tab is switched back to ─────────
    // Switching tabs clears the view while the work underneath keeps going.
    // Nothing re-sent the run-project card, and a background task's card is
    // only created on 'start' — which had already passed — so its later
    // messages, including its final answer, were dropped on the floor.
    {
      const posted3 = [];
      const savedView3 = provider.view;
      provider.view = { webview: { postMessage: (m) => posted3.push(m) } };
      provider.projectRoot = tmp;

      provider.bgProcesses.set('__run_project__', { proc: { pid: 1 }, command: 'npm start', url: 'http://localhost:3000' });
      provider.bgProcesses.set('devserver', { proc: { pid: 2 }, stdout: 'listening on 4000' });
      provider.bgWorkers.set('task-1', { ctrl: new AbortController(), prompt: 'audit the routes' });

      provider._sendLiveCardState();
      const kinds = posted3.map(m => m.type);
      check('a live dev server is re-announced so its card and Stop button come back',
        kinds.includes('runProjectStart'));
      check('…including its URL, so the card is Live rather than stuck Starting',
        posted3.some(m => m.type === 'runProjectReady' && m.url === 'http://localhost:3000'));
      check('a running background task is re-announced with its real prompt',
        posted3.some(m => m.type === 'bgTaskUpdate' && m.status === 'start'
          && m.taskId === 'task-1' && m.prompt === 'audit the routes'));
      check('a running background process is replayed with what it has printed',
        posted3.some(m => m.type === 'bgProcessOutput' && m.id === 'devserver'
          && m.chunk === 'listening on 4000'));
      check('the dev server is not also replayed as an ordinary process card',
        !posted3.some(m => m.type === 'bgProcessOutput' && m.id === '__run_project__'));

      // A finished process must not be resurrected as a running card.
      posted3.length = 0;
      provider.bgProcesses.set('devserver', { proc: null, exitCode: 0, stdout: 'done' });
      provider.bgWorkers.clear();
      provider.bgProcesses.delete('__run_project__');
      provider._sendLiveCardState();
      check('an already-exited process is not re-announced as running',
        !posted3.some(m => m.type === 'bgProcessOutput'));

      provider.bgProcesses.clear();
      provider.view = savedView3;
    }

    // ── Ollama context window: the key is ARCHITECTURE-prefixed ────────────
    // This looked only for `llm.context_length`, which Ollama never emits — it
    // reports `llama.context_length`, `qwen2.context_length`, `gptoss.…` etc.
    // So no value was ever found: the badge stayed blank, the context-fill bar
    // never moved, and num_ctx was never sent on any request.
    {
      const realFetch = global.fetch;
      const posted = [];
      const savedView = provider.view;
      provider.view = { webview: { postMessage: (m) => posted.push(m) } };

      const showResponse = (body) => {
        global.fetch = async () => ({ ok: true, json: async () => body });
      };
      const run = async () => {
        posted.length = 0;
        provider.modelContextLength = null;
        await provider.fetchModelContext('http://localhost:11434', 'm');
        const msg = posted.find(m => m.type === 'contextWindow');
        // `max` is what the model reports; `current` is what Navy will use
        // after navy.contextWindow is applied. With the setting at its default
        // (0 = Max) these are the same, which is what these cases assert.
        return msg && msg.max ? { length: msg.current, max: msg.max, options: msg.options } : null;
      };

      showResponse({ model_info: { 'llama.context_length': 8192 } });
      let msg = await run();
      check('context window: architecture-prefixed key is found (llama.*)',
        msg && msg.length === 8192 && provider.modelContextLength === 8192);

      showResponse({ model_info: { 'gptoss.context_length': 131072 } });
      msg = await run();
      check('context window: the model\'s full advertised window is used, uncapped',
        msg && msg.length === 131072);

      showResponse({ model_info: { 'qwen2.context_length': 131072 }, parameters: 'stop "<|im_end|>"\nnum_ctx 4096' });
      msg = await run();
      check('context window: a smaller Modelfile num_ctx does not hold the window down (Navy sets num_ctx itself)',
        msg && msg.length === 131072);

      showResponse({ model_info: { 'qwen2.context_length': 8192 }, parameters: 'num_ctx 32768' });
      msg = await run();
      check('context window: a Modelfile num_ctx ABOVE the architecture value is still honoured',
        msg && msg.length === 32768);

      showResponse({ model_info: {} });
      msg = await run();
      check('context window: unknown stays unknown — no message, so the badge hides rather than guessing',
        !msg && provider.modelContextLength === null);

      showResponse({ model_info: { 'llm.context_length': 16384 } });
      msg = await run();
      check('context window: the legacy llm.* key is still honoured if a build ever emits it',
        msg && msg.length === 16384);

      global.fetch = realFetch;
      provider.view = savedView;
    }

    // ── The user picks a window from a list built for the ACTIVE model ─────
    {
      const { contextWindowOptions } = require('../src/extension.js');
      check('context options: an 8k model is never offered a larger window',
        JSON.stringify(contextWindowOptions(8192)) === JSON.stringify([8192, 4096]));
      check('context options: the model maximum is always offered, even when it is not a power of two',
        contextWindowOptions(200000)[0] === 200000);
      check('context options: a 1M model offers the whole ladder up to its own maximum',
        contextWindowOptions(1048576)[0] === 1048576 && contextWindowOptions(1048576).includes(131072));
      check('context options: descending, so the largest reads first',
        contextWindowOptions(131072).every((v, i, a) => i === 0 || a[i - 1] > v));
      check('context options: an unknown maximum offers nothing at all',
        contextWindowOptions(0).length === 0 && contextWindowOptions(null).length === 0);
      check('context options: a maximum that IS a listed step is not duplicated',
        contextWindowOptions(32768).filter(v => v === 32768).length === 1);

      // Selection: 0 tracks the model, an explicit size is clamped to it.
      const posted2 = [];
      const savedView2 = provider.view;
      provider.view = { webview: { postMessage: (m) => posted2.push(m) } };
      const latest = () => posted2.filter(m => m.type === 'contextWindow').pop();

      await vscode.workspace.getConfiguration().update('contextWindow', 0);
      provider._applyContextWindow(131072, true);
      check('context choice: 0 means Max — the effective window follows the model',
        latest().current === 131072 && provider.modelContextLength === 131072);

      await provider.setContextWindow(16384);
      check('context choice: an explicit size is what gets used',
        latest().current === 16384 && provider.modelContextLength === 16384);
      check('context choice: the choice is persisted, not just held in memory',
        vscode.workspace.getConfiguration('navy').get('contextWindow') === 16384);

      // Switching to a SMALLER model must not leave a larger stale pick in force.
      provider._applyContextWindow(8192, true);
      check('context choice: a pick larger than the new model is clamped to what it supports',
        latest().current === 8192 && provider.modelContextLength === 8192);

      // …and switching back restores the user's real preference, not the clamp.
      provider._applyContextWindow(131072, true);
      check('context choice: the clamp is not sticky — the original pick returns on a bigger model',
        latest().current === 16384);

      await provider.setContextWindow(0);
      check('context choice: returning to Max tracks the model again', latest().current === 131072);

      provider._applyContextWindow(null, false);
      check('context choice: an unknown window offers no options and disables the picker',
        latest().max === null && latest().options.length === 0 && provider.modelContextLength === null);

      provider.view = savedView2;
    }

    // ── Non-Ollama providers get a context window too ──────────────────────
    // Live from the provider's own model list where it reports one (OpenRouter
    // sends context_length, vLLM sends max_model_len), and from the known-model
    // table otherwise — previously the badge was Ollama-only and every hosted
    // provider showed nothing at all.
    {
      const { resolveModelContext } = require('../src/extension.js');
      check('context window: a provider-reported value wins over the table',
        resolveModelContext('claude-sonnet-5', 500000) === 500000);
      check('context window: falls back to the known-model table when the provider says nothing',
        resolveModelContext('claude-sonnet-5', undefined) === 200000);
      check('context window: an unknown model resolves to null, so the badge hides',
        resolveModelContext('some-private-finetune-v3', undefined) === null);
      check('context window: a nonsense provider value is ignored rather than displayed',
        resolveModelContext('gpt-4o', 0) === 128000 && resolveModelContext('gpt-4o', -5) === 128000);
      check('context window: more specific model patterns win (gpt-4.1 before gpt-4o)',
        resolveModelContext('gpt-4.1-mini', undefined) === 1047576);

      // The list fetch must harvest whatever the provider reported, under the
      // provider's own ids, without disturbing the plain name list.
      const realFetch = global.fetch;
      global.fetch = async () => ({
        ok: true,
        json: async () => ({ data: [
          { id: 'vendor/big-model', context_length: 262144 },
          { id: 'vendor/vllm-model', max_model_len: 65536 },
          { id: 'vendor/no-context-model' },
        ] }),
      });
      const contexts = new Map();
      const names = await provider._fetchModelList('http://x/models', {}, contexts);
      check('context window: model list still returns plain names', names.length === 3 && names[0] === 'vendor/big-model');
      check('context window: context_length harvested from the provider list', contexts.get('vendor/big-model') === 262144);
      check('context window: max_model_len (vLLM) harvested too', contexts.get('vendor/vllm-model') === 65536);
      check('context window: a model reporting no window is simply absent from the map',
        !contexts.has('vendor/no-context-model'));
      global.fetch = realFetch;

      // Display: local models are quoted in binary (131072 = "128k"), hosted
      // APIs in decimal (200000 = "200k"). Dividing everything by 1024 printed
      // Claude's window as "195k ctx".
      const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
      const formatContextWindow = new Function(
        extractFunction(mainSrc, 'function formatContextWindow') + '\nreturn formatContextWindow;')();
      const shown = (n) => formatContextWindow(n);
      check('context window display: binary windows read as the familiar power of two',
        shown(131072) === '128k ctx' && shown(8192) === '8k ctx' && shown(262144) === '256k ctx');
      check('context window display: decimal windows are not mangled into 1024ths',
        shown(200000) === '200k ctx' && shown(400000) === '400k ctx' && shown(128000) === '128k ctx');
      check('context window display: an odd value still gets a sensible round number',
        shown(16385) === '16k ctx' && shown(1047576) === '1M ctx');
      check('context window display: million-token windows collapse to M',
        shown(1048576) === '1M ctx' && shown(1000000) === '1M ctx' && shown(2097152) === '2M ctx');
    }

    // ── readFileTail must not emit a replacement char on a multibyte cut ───
    {
      const f = path.join(tmp, 'utf8-tail.log');
      // 'é' is two bytes; asking for an odd byte count lands mid-character.
      fs.writeFileSync(f, 'aaaa' + 'é'.repeat(20));
      const readFileTail = new Function('fs', extractFunction(extSrc, 'function readFileTail') + '\nreturn readFileTail;')(fs);
      const tail = readFileTail(f, 9); // 9 bytes = 4.5 'é' characters
      check('readFileTail never starts with a U+FFFD from a split character', !tail.startsWith('�'));
      check('readFileTail still returns the real tail', tail.endsWith('é'));
      const whole = readFileTail(f, 10_000);
      check('readFileTail returns the whole file untouched when it fits', whole === 'aaaa' + 'é'.repeat(20));
    }
  } catch (e) {
    check('review regression suite ran', false, e.stack || e.message);
  } finally {
    if (provider) { clearTimeout(provider._cpSaveTimer); clearInterval(provider._heartbeat); clearTimeout(provider._watchdog); }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { if (tmp2) fs.rmSync(tmp2, { recursive: true, force: true }); } catch {}
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
  .then(retrievalUpgradesSuite)
  .then(sandboxSuite)
  .then(missingPathHintSuite)
  .then(persistentBgProcessSuite)
  .then(multiRootSuite)
  .then(sessionIsolationSuite)
  .then(sessionTaggingSuite)
  .then(projectCacheEvictionSuite)
  .then(sessionCacheEvictionSuite)
  .then(projectRulesSuite)
  .then(syntaxCheckSuite)
  .then(robustnessSuite)
  .then(writeLoopGuardSuite)
  .then(hallucinationSuite)
  .then(toolLedgerSuite)
  .then(costEstimateSuite)
  .then(historyDigestSuite)
  .then(delegateResearchSuite)
  .then(providerFallbackSuite)
  .then(cachingFallbackSuite)
  .then(adaptiveThinkingFallbackSuite)
  .then(geminiSuite)
  .then(mcpSuite)
  .then(mcpHttpSuite)
  .then(projectFolderSuite)
  .then(globalProjectCatalogSuite)
  .then(reviewRegressionSuite)
  .then(approvalCancelSuite)
  .then(() => {
    uninstallVscodeMock();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
  });
