// The pure-function and DOM checks that used to run at the top level of
// test/run.js, on require. Wrapped in a function so the runner decides when
// they happen, like every other suite — the bodies are untouched.

const { fs, path, ROOT, check, extractFunction, extSrc, mainSrc, htmlSrc } = require('./harness.js');

function pureSuites() {

// ── 1. literalReplace ────────────────────────────────────────────────────────
console.log('\nliteralReplace:');
{
  // literalReplace's fuzzy branch calls reindentReplacement, which an
  // extracted-and-eval'd function cannot see. Pull the REAL one into scope —
  // a direct eval captures the enclosing bindings — rather than duplicating it
  // here, so the two can never drift.
  // eslint-disable-next-line no-unused-vars
  const reindentReplacement = eval('(' + extractFunction(extSrc, 'function reindentReplacement') + ')');
  const literalReplace = eval('(' + extractFunction(extSrc, 'function literalReplace') + ')');
  check('exact match', literalReplace('abc def', 'def', 'xyz') === 'abc xyz');

  // Indentation drift is the commonest local-model failure: right code, wrong
  // leading whitespace. The fuzzy branch has always MATCHED through it — what
  // it used to do was splice the replacement in at whatever indentation the
  // model wrote, so a match four levels deep came back at column zero. Valid
  // JavaScript, broken Python, and a mangled diff either way.
  const cls = ['class A {', '    method() {', '        const x = 1;', '        return x;', '    }', '}'].join('\n');
  check('fuzzy match re-anchors an under-indented replacement to the file',
    literalReplace(cls, 'const x = 1;\nreturn x;', 'const x = 2;\nreturn x * 2;')
      === ['class A {', '    method() {', '        const x = 2;', '        return x * 2;', '    }', '}'].join('\n'));

  const py = ['def f():', '    if x:', '        do_a()', '        do_b()'].join('\n');
  check('fuzzy match pulls an over-indented replacement back',
    literalReplace(py, '            do_a()\n            do_b()', '            do_c()')
      === ['def f():', '    if x:', '        do_c()'].join('\n'));

  check('fuzzy match keeps the replacement\'s own internal nesting',
    literalReplace(cls, 'const x = 1;\nreturn x;', 'if (y) {\n    return 1;\n}')
      === ['class A {', '    method() {', '        if (y) {', '            return 1;', '        }', '    }', '}'].join('\n'));

  // Never invent an indent when the two sides do not share a prefix — a tab
  // file and a space search cannot be reconciled by arithmetic.
  const tabbed = ['def f():', '\tif x:', '\t\tdo_a()'].join('\n');
  check('fuzzy match leaves mixed tabs/spaces alone rather than guessing',
    literalReplace(tabbed, '        do_a()', '        do_b()') === ['def f():', '\tif x:', '        do_b()'].join('\n'));

  // An exact match must not be touched by any of this.
  check('exact match is never re-indented',
    literalReplace(cls, '        const x = 1;', '        const x = 3;')
      === ['class A {', '    method() {', '        const x = 3;', '        return x;', '    }', '}'].join('\n'));
  check('CRLF file + LF search preserves CRLF',
    literalReplace('a\r\nb\r\nc', 'a\nb', 'A\nB') === 'A\r\nB\r\nc');
  check('LF file + CRLF search stays LF',
    literalReplace('a\nb\nc', 'a\r\nb', 'A\r\nB') === 'A\nB\nc');
  check('fuzzy indentation match keeps the FILE\'s indentation, not the search block\'s',
    literalReplace('  foo();\n  bar();', 'foo();\nbar();', 'baz();') === '  baz();');
  check('ambiguous returns Error', literalReplace('x x', 'x', 'y') instanceof Error);
  check('not found returns null', literalReplace('abc', 'zzz', 'y') === null);
  check('fuzzy on CRLF preserves CRLF and the file\'s indentation',
    literalReplace('  a();\r\n  b();', 'a();\nb();', 'c();') === '  c();');
}

// ── 1a1. Reduced tool tier (tools.js) ────────────────────────────────────────
// The core/withheld split and the derived core prompt are pure data — pin the
// invariants a typo or a template drift would silently break: a core name that
// no longer exists just vanishes from the offer, and a regex miss in the
// Available-tools swap would quietly ship the full list to reduced turns.
console.log('\nreduced tool tier:');
{
  const { TOOLS, TOOLS_API, TOOL_PROMPT, TOOLS_API_CORE, TOOL_PROMPT_CORE, CORE_TOOL_NAMES, WITHHELD_TOOLS } =
    require('../src/providers/tools.js');
  const allNames = new Set(TOOLS.map(t => t.name));
  check('every core name is a real tool (no typo drift)',
    [...CORE_TOOL_NAMES].every(n => allNames.has(n)),
    [...CORE_TOOL_NAMES].filter(n => !allNames.has(n)).join(', '));
  check('core + withheld partition the full set',
    CORE_TOOL_NAMES.size + WITHHELD_TOOLS.length === TOOLS.length &&
    WITHHELD_TOOLS.every(t => !CORE_TOOL_NAMES.has(t.name)));
  const apiNames = (api) => api.map(t => t.function.name);
  check('request_more_tools offered only in the core API',
    apiNames(TOOLS_API_CORE).includes('request_more_tools') &&
    !apiNames(TOOLS_API).includes('request_more_tools'));
  check('finish never appears in a wire schema',
    !apiNames(TOOLS_API).includes('finish') && !apiNames(TOOLS_API_CORE).includes('finish'));
  const coreLine = TOOL_PROMPT_CORE.match(/^Available tools: .*$/m)?.[0] || '';
  const fullLine = TOOL_PROMPT.match(/^Available tools: .*$/m)?.[0] || '';
  check('core prompt swaps the Available-tools line (regex actually matched)',
    coreLine !== fullLine && coreLine.includes('request_more_tools') && !coreLine.includes('rename_symbol'));
  check('full prompt line untouched', fullLine.includes('rename_symbol') && !fullLine.includes('request_more_tools'));
  check('core prompt names the withheld tools',
    TOOL_PROMPT_CORE.includes('withheld: ') &&
    WITHHELD_TOOLS.every(t => TOOL_PROMPT_CORE.includes(t.name)));
  check('core schemas cost well under half the full set',
    JSON.stringify(TOOLS_API_CORE).length < JSON.stringify(TOOLS_API).length * 0.6,
    `${JSON.stringify(TOOLS_API_CORE).length} vs ${JSON.stringify(TOOLS_API).length}`);

  // parseToolCalls accepts a JSON-formatted call only for a name it finds in
  // TOOLS, so being listed there is what makes the unlock reachable from the
  // JSON fallback path (exercised in reducedToolsetSuite, which has the vscode
  // mock llm.js needs at load). Being a known NAME must not make it an offered
  // SCHEMA on the full tier, where nothing is withheld and the call is waste.
  check('request_more_tools is a known tool name (the JSON fallback gate)',
    TOOLS.some(t => t.name === 'request_more_tools'));
  check('…while the full tier still never offers it as a schema',
    !apiNames(TOOLS_API).includes('request_more_tools'));
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
  // _compactMessages calls the module-level assembledCharSize, which an
  // extracted-and-eval'd function cannot see. Pull the REAL one out of the
  // source into this scope rather than reimplementing it here: a direct eval
  // captures the enclosing bindings, so the extracted method resolves it, and
  // the two can never drift the way a hand-copied duplicate would.
  // eslint-disable-next-line no-unused-vars
  const assembledCharSize = eval('(' + extractFunction(extSrc, 'function assembledCharSize(messages) {') + ')');
  const extracted = eval('(function ' + body + ')');
  // The budget now comes from the model's real window via _contextCharCaps, so
  // the extracted method needs a host to read it from. Pinned to the old fixed
  // numbers here on purpose: these cases test the compaction STRATEGY, and they
  // should keep asserting exactly what they always did. The derivation itself is
  // covered separately in contextBudgetSuite.
  const host = { _contextCharCaps: () => ({ compact: 240000, history: 200000 }) };
  const compact = (messages) => extracted.call(host, messages);
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
}

module.exports = { pureSuites };
