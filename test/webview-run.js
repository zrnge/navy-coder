// Chat-rendering tests: bubbles, edit cards, task cards, running cards.
//
// These drive the REAL media/main.js inside jsdom via the REAL webview HTML,
// using the same message protocol the extension host uses — so a pass here is
// a statement about the shipped file, not about a reimplementation.

const { createWebview } = require('./webview-harness.js');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function run(steps) {
  const w = createWebview();
  for (const s of steps) w.post(s);
  return w;
}

// ── Card ordering ───────────────────────────────────────────────────────────
// Every card used to be appended to #messages as a SIBLING after the assistant
// message, while text and activity logs were appended INSIDE it — so anything
// written after a card rendered above it.
function orderingSuite() {
  console.log('\nchat: cards render where they happened:');

  let w = run([
    { type: 'start' },
    { type: 'toolCall', tool: 'read_file', args: { path: 'a.js' }, callId: 'c1' },
    { type: 'toolResult', tool: 'read_file', result: 'ok', callId: 'c1' },
    { type: 'chunk', text: 'I read the file.' },
    { type: 'done' },
  ]);
  check('a turn that starts with a tool puts its explanation BELOW the activity',
    JSON.stringify(w.flow()) === JSON.stringify(['activity-log', 'text:I read the file.']),
    JSON.stringify(w.flow()));
  w.close();

  w = run([
    { type: 'start' },
    { type: 'toolCall', tool: 'run_command', args: { command: 'npm test' }, callId: 'c1' },
    { type: 'toolResult', tool: 'run_command', result: 'Exit code: 0', callId: 'c1' },
    { type: 'chunk', text: 'Tests pass.' },
    { type: 'done' },
  ]);
  check('a command card comes before the text explaining it',
    JSON.stringify(w.flow()) === JSON.stringify(['term-card', 'text:Tests pass.']),
    JSON.stringify(w.flow()));
  w.close();

  w = run([
    { type: 'start' },
    { type: 'chunk', text: 'Editing.' },
    { type: 'pendingDiff', id: 'd1', path: '/p/a.js', oldText: 'a\n', newText: 'b\n' },
    { type: 'chunk', text: 'Edited it.' },
    { type: 'done' },
  ]);
  check('a diff card sits between the text before and after it',
    JSON.stringify(w.flow()) === JSON.stringify(['text:Editing.', 'diff-card', 'text:Edited it.']),
    JSON.stringify(w.flow()));
  w.close();

  w = run([
    { type: 'start' },
    { type: 'chunk', text: 'Step one.' },
    { type: 'toolCall', tool: 'run_command', args: { command: 'ls' }, callId: 'c1' },
    { type: 'toolResult', tool: 'run_command', result: 'Exit code: 0', callId: 'c1' },
    { type: 'chunk', text: 'Step two.' },
    { type: 'toolCall', tool: 'read_file', args: { path: 'a.js' }, callId: 'c2' },
    { type: 'toolResult', tool: 'read_file', result: 'ok', callId: 'c2' },
    { type: 'chunk', text: 'Step three.' },
    { type: 'done' },
  ]);
  check('a multi-phase turn reads in the order things actually happened',
    JSON.stringify(w.flow()) === JSON.stringify(
      ['text:Step one.', 'term-card', 'text:Step two.', 'activity-log', 'text:Step three.']),
    JSON.stringify(w.flow()));
  w.close();

  w = run([
    { type: 'start' },
    { type: 'chunk', text: 'Running it.' },
    { type: 'runProjectStart', projectName: 'demo', command: 'npm start' },
    { type: 'chunk', text: 'Server is up.' },
    { type: 'done' },
  ]);
  check('the run-project card lands inline, not after everything else',
    JSON.stringify(w.flow()) === JSON.stringify(['text:Running it.', 'run-project-card', 'text:Server is up.']),
    JSON.stringify(w.flow()));
  w.close();
}

// ── Terminal cards ──────────────────────────────────────────────────────────
function terminalSuite() {
  console.log('\nrunning cards: terminal output routing:');

  let w = run([
    { type: 'start' },
    { type: 'toolCall', tool: 'run_command', args: { command: 'a' }, callId: 'c1' },
    { type: 'toolCall', tool: 'run_command', args: { command: 'b' }, callId: 'c2' },
    { type: 'shellChunk', chunk: 'output-for-A', streamId: 'c1' },
    { type: 'shellChunk', chunk: 'output-for-B', streamId: 'c2' },
  ]);
  const cards = [...w.document.querySelectorAll('.term-card')];
  check('two concurrent commands get their own cards', cards.length === 2);
  check('each command\'s output goes to its OWN card',
    cards[0].querySelector('.term-out').textContent === 'output-for-A'
    && cards[1].querySelector('.term-out').textContent === 'output-for-B',
    cards.map(c => c.querySelector('.term-out').textContent).join(' | '));

  w.post({ type: 'toolResult', tool: 'run_command', result: 'Exit code: 0', callId: 'c1' });
  check('finishing one command does not finalize the other',
    cards[0].querySelector('.term-status').textContent === 'exit 0'
    && cards[1].querySelector('.term-status').textContent === 'running…');
  w.close();

  // Output whose stream belongs to nothing on screen (a background task's
  // command) must not be dumped into an unrelated card.
  w = run([
    { type: 'start' },
    { type: 'toolCall', tool: 'run_command', args: { command: 'a' }, callId: 'c1' },
    { type: 'shellChunk', chunk: 'from-a-background-task', streamId: 'other-stream' },
  ]);
  check('output from an unknown stream never contaminates a visible card',
    !w.document.querySelector('.term-out').textContent.includes('from-a-background-task'));
  check('…it falls through to the shell panel instead',
    (w.document.querySelector('#shellOutput')?.textContent || '').includes('from-a-background-task'));
  w.close();

  // Stop must finalize every open card, not just the most recent.
  w = run([
    { type: 'start' },
    { type: 'toolCall', tool: 'run_command', args: { command: 'a' }, callId: 'c1' },
    { type: 'toolCall', tool: 'run_command', args: { command: 'b' }, callId: 'c2' },
    { type: 'aborted' },
  ]);
  check('Stop leaves no terminal card spinning at "running…"',
    [...w.document.querySelectorAll('.term-status')].every(s => s.textContent !== 'running…'),
    [...w.document.querySelectorAll('.term-status')].map(s => s.textContent).join(','));
  w.close();

  // stderr styling must survive the output cap.
  w = run([
    { type: 'start' },
    { type: 'toolCall', tool: 'run_command', args: { command: 'a' }, callId: 'c1' },
    { type: 'shellChunk', chunk: 'E'.repeat(200), isStderr: true, streamId: 'c1' },
    { type: 'shellChunk', chunk: 'o'.repeat(31000), streamId: 'c1' },
    { type: 'shellChunk', chunk: 'LATE-ERROR', isStderr: true, streamId: 'c1' },
  ]);
  check('stderr stays styled after the output cap trims the card',
    w.document.querySelector('.term-out .term-stderr') !== null);
  check('the cap actually bounds the retained output',
    w.document.querySelector('.term-out').textContent.length <= 31500);
  w.close();

  w = run([
    { type: 'start' },
    { type: 'toolCall', tool: 'run_command', args: { command: 'npm test' }, callId: 'c1' },
    { type: 'shellChunk', chunk: 'all good', streamId: 'c1' },
  ]);
  w.document.querySelector('.term-copy-btn').dispatchEvent(new w.window.Event('click'));
  const copied = w.sent.find(m => m.type === 'copy');
  check('a terminal card can be copied, command and output together',
    copied && copied.text.includes('npm test') && copied.text.includes('all good'),
    JSON.stringify(copied));
  w.close();
}

// ── Task cards (activity rows + background tasks) ───────────────────────────
function taskSuite() {
  console.log('\ntask cards: rows, results and background tasks:');

  // Parallel read-only tools with NO callId (the XML fallback path) must not
  // all resolve onto whichever row was created last.
  let w = run([
    { type: 'start' },
    { type: 'toolCall', tool: 'read_file', args: { path: 'a.js' } },
    { type: 'toolCall', tool: 'search_files', args: { query: 'x' } },
    { type: 'toolResult', tool: 'search_files', result: 'found' },
  ]);
  let rows = [...w.document.querySelectorAll('.activity-row')];
  check('a result with no id resolves the row for ITS OWN tool',
    rows[1].classList.contains('is-done') && rows[0].classList.contains('running'),
    rows.map(r => r.className).join(' | '));
  w.close();

  // A background task that finishes while you are on another tab must still
  // show its answer when you come back.
  w = run([
    { type: 'bgTaskUpdate', taskId: 't1', status: 'start', prompt: 'do a thing' },
    { type: 'cleared' },
    { type: 'bgTaskUpdate', taskId: 't1', status: 'chunk', text: 'the answer' },
    { type: 'bgTaskUpdate', taskId: 't1', status: 'done' },
  ]);
  const bg = w.document.querySelector('.message-bg-task');
  check('a background task card is rebuilt after its view was cleared', bg !== null);
  check('…and its final answer is not lost',
    bg && bg.querySelector('.bg-task-text').textContent.includes('the answer'),
    bg && bg.querySelector('.bg-task-text').textContent);
  w.close();
}

// ── Running cards: background processes and run-project ─────────────────────
function runningSuite() {
  console.log('\nrunning cards: processes and the dev server:');

  let w = run([
    { type: 'bgProcessOutput', id: 'server', chunk: 'listening' },
  ]);
  const stop = w.document.querySelector('.bg-proc-stop');
  check('a background process panel has a stop control', stop !== null);
  stop?.dispatchEvent(new w.window.Event('click'));
  check('…that asks the extension to kill that process',
    w.sent.some(m => m.type === 'killBgProcess' && m.id === 'server'));
  w.close();

  // Exit status must appear even if the panel was cleared by a tab switch.
  w = run([
    { type: 'bgProcessOutput', id: 'server', chunk: 'listening' },
    { type: 'cleared' },
    { type: 'bgProcessDone', id: 'server', exitCode: 3 },
  ]);
  check('a process exiting while the view was cleared still reports its status',
    (w.document.querySelector('.message-bg-process .bg-task-status')?.textContent || '').includes('3'),
    w.document.querySelector('.message-bg-process .bg-task-status')?.textContent);
  w.close();

  // Restarting supersedes the old card rather than stacking up.
  w = run([
    { type: 'runProjectStart', projectName: 'demo', command: 'npm start' },
    { type: 'runProjectStopped', exitCode: 0 },
    { type: 'runProjectStart', projectName: 'demo', command: 'npm start' },
    { type: 'runProjectStopped', exitCode: 1 },
    { type: 'runProjectStart', projectName: 'demo', command: 'npm start' },
  ]);
  check('restarting the dev server does not pile up stopped cards',
    w.document.querySelectorAll('.run-project-card').length === 1,
    String(w.document.querySelectorAll('.run-project-card').length));
  w.close();

  // Output arriving after the process is reported dead is the output that
  // explains WHY it died — it must not be dropped.
  w = run([
    { type: 'runProjectStart', projectName: 'demo', command: 'npm start' },
    { type: 'runProjectStopped', exitCode: 1 },
    { type: 'runProjectOutput', chunk: 'FATAL: port in use' },
  ]);
  check('output after a crash is still shown on the card',
    (w.document.querySelector('.rp-log')?.textContent || '').includes('FATAL: port in use'),
    w.document.querySelector('.rp-log')?.textContent);
  check('a second stop message does not overwrite the crash status',
    (w.document.querySelector('.rp-status')?.textContent || '').includes('Crashed'));
  w.close();
}

// ── Bubbles, history and copy ───────────────────────────────────────────────
function bubbleSuite() {
  console.log('\nchat bubbles, history and copy:');

  const w = run([
    { type: 'start' },
    { type: 'chunk', text: '<think>secret reasoning</think>The answer is 42.' },
    { type: 'done' },
  ]);
  const copyBtn = w.document.querySelector('.msg-copy-btn');
  copyBtn.dispatchEvent(new w.window.Event('click'));
  const copied = w.sent.find(m => m.type === 'copy');
  check('copying a reply does not leak the model\'s hidden reasoning',
    copied && !copied.text.includes('secret reasoning'), JSON.stringify(copied));
  check('…while still copying the reply itself',
    copied && copied.text.includes('The answer is 42.'));
  w.close();

  // 0.2.7: your own messages are copyable too. A long prompt is collapsed
  // behind a "Show N more lines" toggle, so copying must use the original
  // text rather than whatever happens to be visible.
  const wu = run([{
    type: 'restore',
    messages: [{ role: 'user', text: 'line one\n' + Array.from({ length: 30 }, (_, i) => 'line ' + (i + 2)).join('\n') }],
  }]);
  const userMsg = wu.document.querySelector('#messages .message.user');
  const userCopy = userMsg?.querySelector('.msg-copy-btn');
  check('a user message has a copy button', userCopy !== null);
  check('the long prompt really is collapsed (so visible text is not the whole thing)',
    userMsg?.querySelector('.msg-overflow')?.hidden === true);
  userCopy?.dispatchEvent(new wu.window.Event('click'));
  const userCopied = wu.sent.find(m => m.type === 'copy');
  check('copying a user message yields the WHOLE prompt, not just the visible part',
    userCopied && userCopied.text.includes('line one') && userCopied.text.includes('line 31'),
    JSON.stringify(userCopied && userCopied.text.slice(-30)));
  check('…and exactly what was typed, with no UI text mixed in',
    userCopied && !/Show \d+ more lines/.test(userCopied.text));
  wu.close();

  // Attachment badges are part of what the question was.
  const w2 = run([{
    type: 'restore',
    messages: [{ role: 'user', text: 'what does this do?', attachments: ['server.js'], images: 2 }],
  }]);
  const badges = [...w2.document.querySelectorAll('.msg-attach-badge')].map(b => b.textContent);
  check('a restored question keeps its attachment badge', badges.some(b => b.includes('server.js')), badges.join(','));
  check('a restored question keeps its image count', badges.some(b => b.includes('2 images')), badges.join(','));
  w2.close();

  // Long history is bounded, with the rest one click away.
  const long = [];
  for (let i = 0; i < 150; i++) long.push({ role: i % 2 ? 'assistant' : 'user', text: 'msg ' + i });
  const w3 = run([{ type: 'restore', messages: long }]);
  const shown = w3.document.querySelectorAll('#messages .message').length;
  check('a long history does not render every message up front', shown <= 60, String(shown));
  const moreBtn = w3.document.querySelector('.history-more-btn');
  check('…and offers the earlier ones explicitly', moreBtn !== null);
  moreBtn?.dispatchEvent(new w3.window.Event('click'));
  check('clicking it reveals the whole history',
    w3.document.querySelectorAll('#messages .message').length === 150,
    String(w3.document.querySelectorAll('#messages .message').length));
  const texts = [...w3.document.querySelectorAll('#messages .message')].map(m => m.textContent.trim());
  check('…in the original order, oldest first',
    texts[0].includes('msg 0') && texts[149].includes('msg 149'),
    texts[0] + ' … ' + texts[149]);
  w3.close();

  // 0.2.7: a reopened chat shows the work, not just the summary of it. Every
  // turn used to come back as bare prose — the activity rows and terminal
  // cards were webview-only and simply disappeared.
  const w4 = run([{
    type: 'restore',
    messages: [
      { role: 'user', text: 'add the retry' },
      {
        role: 'assistant',
        text: 'Added a retry with backoff.',
        cards: [
          { tool: 'read_file', args: { path: 'src/client.js' }, result: 'a\nb', full: { chars: 40000, lines: 912, filled: 800 } },
          { tool: 'apply_edit', args: { path: 'src/client.js' }, result: 'Applied to src/client.js' },
          { tool: 'run_command', args: { command: 'npm test' }, result: 'Exit code: 0\n42 passing' },
        ],
      },
    ],
  }]);
  const rows = [...w4.document.querySelectorAll('.activity-row')];
  check('a restored turn replays its tool activity', rows.length === 2, String(rows.length));
  check('…naming what was touched',
    rows.map(r => r.textContent).join(' ').includes('client.js'),
    rows.map(r => r.textContent).join(' '));
  check('…and reports the size of the real result, not of the excerpt kept',
    rows[0].textContent.includes('912'), rows[0].textContent);
  const term = w4.document.querySelector('.term-card');
  check('a restored turn replays its terminal card', term !== null);
  check('…with the command that was run', term?.querySelector('.term-in')?.textContent === 'npm test');
  check('…and how it ended', /exit 0/.test(term?.querySelector('.term-status')?.textContent || ''),
    term?.querySelector('.term-status')?.textContent);
  const article = w4.document.querySelector('#messages .message.assistant');
  check('the cards and the reply are one turn, not two',
    article?.querySelector('.activity-log, .activity-log-collapsed') !== null
    && (article?.textContent || '').includes('Added a retry with backoff.'));
  check('the reply reads BELOW the work it describes',
    (article?.textContent || '').indexOf('client.js') < (article?.textContent || '').indexOf('Added a retry'),
    article?.textContent);
  check('…and the whole reply is still copyable',
    (article?.dataset.rawMd || '').includes('Added a retry with backoff.'));
  check('a chat that replays its cards is not told they are missing',
    w4.document.querySelector('.restore-note') === null);
  w4.close();

  // Chats saved before card records existed must still say what is not there.
  const w5 = run([{ type: 'restore', messages: [{ role: 'assistant', text: 'done' }] }]);
  check('an older chat still explains the gap', w5.document.querySelector('.restore-note') !== null);
  w5.close();
}

// ── Syntax highlighting in code cards ───────────────────────────────────────
function highlightSuite() {
  console.log('\ncode cards: syntax highlighting:');

  const block = (lang, code) => {
    const w = createWebview();
    w.post({ type: 'restore', messages: [{ role: 'assistant', text: '```' + lang + '\n' + code + '\n```' }] });
    const el = w.document.querySelector('.code-block pre code');
    const out = { html: el ? el.innerHTML : '', text: el ? el.textContent : '', w };
    return out;
  };
  const kinds = (html) => new Set([...html.matchAll(/class="tok-(\w+)"/g)].map(m => m[1]));

  for (const [lang, code, expected] of [
    ['js', 'const x = 1; // note\nfunction hi(n) { return `hey ${n}`; }', ['keyword', 'comment', 'string', 'number', 'fn']],
    ['python', 'def add(a, b):  # sum\n    return a + b', ['keyword', 'comment', 'fn']],
    ['json', '{"name": "navy", "count": 3, "ok": true}', ['property', 'string', 'number', 'keyword']],
    ['css', '.btn { color: #fff; padding: 4px; }', ['keyword', 'property', 'number']],
    ['sql', "SELECT id FROM users WHERE n = 'bob' -- c", ['keyword', 'string', 'comment']],
    ['html', '<div class="a">hi</div>', ['keyword', 'property', 'string']],
  ]) {
    const b = block(lang, code);
    const got = kinds(b.html);
    check(`${lang}: highlighted (${expected.join(', ')})`,
      expected.every(k => got.has(k)), [...got].join(','));
    // The single most important property: Copy and Apply read textContent, so
    // adding spans must not alter the code by even one character.
    check(`${lang}: the code itself is byte-for-byte unchanged`, b.text === code,
      JSON.stringify(b.text));
    b.w.close();
  }

  // Highlighting inserts HTML, so it is a potential injection sink. Every
  // token and every gap between tokens must be escaped.
  const evil = block('js', 'const a = "<img src=x onerror=alert(1)>"; // </script><b>bold');
  check('highlighting never emits raw HTML from the code', !/<img|<b>|<\/script>/.test(evil.html));
  check('the only elements produced are token spans',
    [...evil.html.matchAll(/<\/?(\w+)/g)].every(m => m[1] === 'span'));
  check('the dangerous text still displays verbatim',
    evil.text.includes('<img src=x onerror=alert(1)>'));
  evil.w.close();

  // An unknown language must render exactly as before — a wrong guess would
  // mis-colour real code.
  const unknown = block('brainfuck', '+++[->+<]');
  check('an unrecognised language is left unhighlighted', !/tok-/.test(unknown.html));
  check('…and its text is intact', unknown.text === '+++[->+<]');
  unknown.w.close();

  // Perf guard: a very large paste is exactly when the panel can least afford
  // extra per-tick work.
  const big = block('js', 'const a = 1;\n'.repeat(2000));
  check('an oversized block skips highlighting rather than slowing the render',
    !/tok-/.test(big.html) && big.text.length > 20000);
  big.w.close();

  // A fenced block must NOT pick up the inline-code pill styling. `.message-bubble
  // code` matched both, and since `.code-block code` only reset padding and
  // background, the pill's border and radius survived — every code card rendered
  // as a bordered box inside a bordered box.
  {
    const w2 = createWebview();
    w2.post({ type: 'restore', messages: [{ role: 'assistant', text: 'Use `inline` here.\n\n```\nregex_extract.exe <in> <out>\n```' }] });
    const blockCode = w2.document.querySelector('.code-block pre code');
    const inlineCode = w2.document.querySelector('.message-bubble p code, .message-bubble > code');
    const PILL = '.message-bubble :not(pre) > code';
    check('a fenced block does not take the inline-code pill styling',
      blockCode !== null && !blockCode.matches(PILL));
    check('inline code still gets the pill', inlineCode !== null && inlineCode.matches(PILL));
    check('the card itself is the only bordered container',
      w2.document.querySelectorAll('.code-block').length === 1);
    w2.close();
  }

  // A tool call arriving mid-block used to split the bubble through the middle
  // of the fence: the sealed half held an opening ``` with no close and the
  // next half a closing ``` with no open, so NEITHER parsed and both rendered
  // as paragraphs — fences shown literally, indentation gone, and inline
  // markdown eating the code (re_match_alternation → re<em>match</em>alternation).
  {
    const w3 = createWebview();
    w3.post({ type: 'start' });
    w3.post({ type: 'chunk', text: '```c\nint depth = 0;\n' });
    w3.post({ type: 'toolCall', tool: 'read_file', args: { path: 'a.c' }, callId: 'c1' });
    w3.post({ type: 'toolResult', tool: 'read_file', result: 'ok', callId: 'c1' });
    w3.post({ type: 'chunk', text: 'return re_match_alternation(ctx);\n```' });
    w3.post({ type: 'done' });

    const card = w3.document.querySelector('.code-block');
    check('a tool call inside a code block does not split the fence', card !== null);
    const codeText = card?.querySelector('pre code')?.textContent || '';
    check('…the whole block survives, both halves together',
      codeText.includes('int depth = 0;') && codeText.includes('re_match_alternation'), codeText);
    const bubbleText = [...w3.document.querySelectorAll('.message-bubble')].map(b => b.textContent).join('');
    check('…no literal ``` fence is left in the prose', !bubbleText.includes('```'), bubbleText.slice(0, 80));
    check('…and underscores in identifiers are not italicised',
      !(card?.innerHTML || '').includes('<em>'), card?.innerHTML?.slice(0, 120));
    w3.close();
  }

  // End-to-end: the Copy button must still yield the original source.
  const w = createWebview();
  w.post({ type: 'restore', messages: [{ role: 'assistant', text: '```js\nconst k = "v"; // hi\n```' }] });
  w.document.querySelector('.copy-button')?.dispatchEvent(new w.window.Event('click'));
  const copied = w.sent.find(m => m.type === 'copy');
  check('Copy on a highlighted block still yields the original code',
    copied && copied.text === 'const k = "v"; // hi', JSON.stringify(copied && copied.text));
  w.close();
}

// ── Speech: read aloud and dictation ────────────────────────────────────────
function speechSuite() {
  console.log('\nspeech: read aloud and dictation:');

  // Read-aloud runs in here and has no fallback, so with no speech synthesis it
  // must not appear at all. Dictation runs in the user's BROWSER, so it is
  // offered regardless of what this renderer can do.
  {
    const w = createWebview();
    w.post({ type: 'restore', messages: [{ role: 'assistant', text: 'hello' }] });
    check('no speech support: no read-aloud button is offered',
      w.document.querySelector('.msg-speak-btn') === null);
    const mic = w.document.querySelector('#micButton');
    check('no speech support: the mic is still offered — it does not run in here',
      mic?.hidden === false);
    check('no speech support: …and says where it will happen before you click it',
      /browser/i.test(mic?.title || ''), mic?.title);
    w.close();
  }

  // Read aloud.
  {
    const w = createWebview({ speech: true });
    w.post({ type: 'restore', messages: [{ role: 'assistant', text: 'Use `npm test`.\n\n```js\nconst a = 1;\n```\n\nThen ship.' }] });
    const btn = w.document.querySelector('.msg-speak-btn');
    check('read aloud: the button appears when speech synthesis exists', btn !== null);

    btn.dispatchEvent(new w.window.Event('click'));
    const said = w.speech.spoken[0] || '';
    check('read aloud: the reply is spoken', w.speech.spoken.length === 1);
    check('read aloud: code blocks are summarised, not read character by character',
      said.includes('code block') && !said.includes('const a = 1'), said);
    check('read aloud: markdown punctuation is not pronounced',
      !said.includes('```') && !said.includes('`'), said);
    check('read aloud: the button becomes a stop control while speaking',
      btn.dataset.speaking === 'true');

    btn.dispatchEvent(new w.window.Event('click'));
    check('read aloud: pressing it again stops the reading', w.speech.cancelled > 0);
    check('read aloud: …and the button returns to its idle state',
      btn.dataset.speaking === 'false');

    // Finishing naturally must also reset it, or it sticks on ⏹ forever.
    btn.dispatchEvent(new w.window.Event('click'));
    w.speech.lastUtterance.onend?.();
    check('read aloud: finishing on its own resets the button', btn.dataset.speaking === 'false');
    w.close();
  }

  // 0.2.7: which voice. Nothing chose one before, so the platform's first —
  // Microsoft David, 1990s SAPI5 — read every reply. That is the "robotic".
  {
    const w = createWebview({ speech: true });
    w.post({ type: 'restore', messages: [{ role: 'assistant', text: 'Ready.' }] });
    w.document.querySelector('.msg-speak-btn').dispatchEvent(new w.window.Event('click'));
    const used = w.speech.lastUtterance?.voice;
    check('read aloud: a voice is chosen at all', Boolean(used), String(used));
    check('read aloud: …the natural one, not the platform default',
      /Natural/.test(used?.name || ''), used?.name);
    check('read aloud: …and the utterance follows it into that language',
      w.speech.lastUtterance?.lang === 'en-US', w.speech.lastUtterance?.lang);
    w.close();
  }

  // The right language beats the better voice: an excellent voice reading the
  // wrong language is unusable.
  {
    const w = createWebview({
      speech: true,
      voices: [
        { name: 'Microsoft Ava Online (Natural) - Japanese', lang: 'ja-JP', localService: false },
        { name: 'Microsoft Zira Desktop - English (United States)', lang: 'en-US', localService: true },
      ],
    });
    w.post({ type: 'restore', messages: [{ role: 'assistant', text: 'Ready.' }] });
    w.document.querySelector('.msg-speak-btn').dispatchEvent(new w.window.Event('click'));
    check('read aloud: language wins over voice quality',
      /Zira/.test(w.speech.lastUtterance?.voice?.name || ''), w.speech.lastUtterance?.voice?.name);
    w.close();
  }

  // A renderer with no voices at all must still speak, just without a choice.
  {
    const w = createWebview({ speech: true, voices: [] });
    w.post({ type: 'restore', messages: [{ role: 'assistant', text: 'Ready.' }] });
    w.document.querySelector('.msg-speak-btn').dispatchEvent(new w.window.Event('click'));
    check('read aloud: an empty voice list is not an error', w.speech.spoken[0] === 'Ready.');
    w.close();
  }

  // An explicit choice is never second-guessed, and the reading speed applies.
  {
    const w = createWebview({ speech: true });
    w.post({ type: 'settings', settings: { speechVoice: 'Microsoft Hazel - English (United Kingdom)', speechRate: 1.15 } });
    w.post({ type: 'restore', messages: [{ role: 'assistant', text: 'Ready.' }] });
    w.document.querySelector('.msg-speak-btn').dispatchEvent(new w.window.Event('click'));
    check('read aloud: a pinned voice is used even though it ranks lower',
      /Hazel/.test(w.speech.lastUtterance?.voice?.name || ''), w.speech.lastUtterance?.voice?.name);
    check('read aloud: the reading speed is applied', w.speech.lastUtterance?.rate === 1.15);
    const opts = [...w.document.querySelectorAll('#settingSpeechVoice option')].map(o => o.value);
    check('read aloud: the settings dropdown lists the voices this machine has',
      opts.includes('Microsoft Hazel - English (United Kingdom)') && opts[0] === '', opts.join('|'));
    check('read aloud: …with the automatic choice named, not just labelled',
      /Natural/.test(w.document.querySelector('#settingSpeechVoice option')?.textContent || ''),
      w.document.querySelector('#settingSpeechVoice option')?.textContent);
    w.close();
  }

  // A hand-edited settings.json must not be able to produce silence or noise.
  {
    const w = createWebview({ speech: true });
    w.post({ type: 'settings', settings: { speechRate: 9 } });
    w.post({ type: 'restore', messages: [{ role: 'assistant', text: 'Ready.' }] });
    w.document.querySelector('.msg-speak-btn').dispatchEvent(new w.window.Event('click'));
    check('read aloud: an absurd reading speed is clamped', w.speech.lastUtterance?.rate === 2);
    w.close();
  }

  // Long replies are read a sentence at a time: Chromium stops speaking after
  // about fifteen seconds of one utterance, so a whole essay used to be cut off
  // mid-word.
  {
    const w = createWebview({ speech: true });
    const long = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i} of a fairly long reply.`).join(' ');
    w.post({ type: 'restore', messages: [{ role: 'assistant', text: long }] });
    const btn = w.document.querySelector('.msg-speak-btn');
    btn.dispatchEvent(new w.window.Event('click'));
    check('read aloud: a long reply is not handed over as one utterance',
      w.speech.spoken.length === 1 && w.speech.spoken[0].length <= 160,
      String(w.speech.spoken[0]?.length));
    // Drive it to the end the way the engine would.
    for (let i = 0; i < 40 && btn.dataset.speaking === 'true'; i++) w.speech.lastUtterance.onend?.();
    check('read aloud: …and every word of it is still read',
      w.speech.spoken.join(' ').includes('sentence number 11'), w.speech.spoken.join(' ').slice(-60));
    check('read aloud: …and the button returns to idle at the end',
      btn.dataset.speaking === 'false');
    w.close();
  }

  // A user message is readable too, and a cleared thread stops the audio.
  {
    const w = createWebview({ speech: true });
    w.post({ type: 'restore', messages: [{ role: 'user', text: 'read me back' }] });
    w.document.querySelector('.message.user .msg-speak-btn')?.dispatchEvent(new w.window.Event('click'));
    check('read aloud: your own message can be read back', w.speech.spoken[0] === 'read me back');
    w.post({ type: 'cleared' });
    check('read aloud: clearing the chat stops the reading', w.speech.cancelled > 0);
    w.close();
  }

  // ── Dictation ─────────────────────────────────────────────────────────────
  // Recognition happens in the user's BROWSER, so this file only drives the
  // button and renders what comes back. There is deliberately no
  // SpeechRecognition in here at all: in a VS Code webview it can only fail.
  {
    const w = createWebview();
    const mic = w.document.querySelector('#micButton');
    const input = w.document.querySelector('#prompt');
    input.value = 'Look at';

    mic.dispatchEvent(new w.window.Event('click'));
    check('dictation: the mic asks the extension to open the browser',
      w.sent.some(m => m.type === 'dictate'));
    check('dictation: …and never reaches for a recogniser in here',
      w.window.eval('typeof SpeechRecognitionCtor') === 'undefined');
    check('dictation: the mic shows as live while the session runs',
      mic.classList.contains('recording'));
    check('dictation: …and says the browser is opening',
      /browser/i.test(w.document.querySelector('#micStatus').textContent));

    // The pause control is gone for good: the browser's recogniser has no pause
    // of its own, and faking it by restarting the engine lost whatever was said
    // across the gap.
    check('dictation: there is no pause button at all',
      w.document.querySelector('#micPauseButton') === null);

    w.post({ type: 'dictationState', state: 'listening' });
    check('dictation: a connected page says where the listening is happening',
      /listening/i.test(w.document.querySelector('#micStatus').textContent));

    // Each post carries the whole transcript, so a later one supersedes the
    // earlier rather than appending to it.
    w.post({ type: 'dictationText', text: 'the retry', done: false });
    w.post({ type: 'dictationText', text: 'the retry helper', done: false });
    check('dictation: speech lands in the box after what was already typed',
      input.value === 'Look at the retry helper', input.value);
    check('dictation: nothing is sent to the model on its own', !w.sent.some(m => m.type === 'ask'));

    w.post({ type: 'dictationText', text: 'the retry helper', done: true });
    w.post({ type: 'dictationState', state: 'ended', reason: 'finished' });
    check('dictation: finishing leaves the transcript in the box',
      input.value === 'Look at the retry helper', input.value);
    check('dictation: …and returns the mic to idle', !mic.classList.contains('recording'));
    check('dictation: a clean finish says nothing',
      w.document.querySelector('#micStatus').textContent === '');
    w.close();
  }

  // Clicking the live mic cancels the browser session from this side.
  {
    const w = createWebview();
    const mic = w.document.querySelector('#micButton');
    mic.dispatchEvent(new w.window.Event('click'));
    mic.dispatchEvent(new w.window.Event('click'));
    check('dictation: clicking again cancels the session',
      w.sent.some(m => m.type === 'dictateStop'));
    check('dictation: …and the mic goes idle without waiting for the extension',
      !mic.classList.contains('recording'));
    w.close();
  }

  // A session that ends for a reason worth knowing about must say so.
  {
    const w = createWebview();
    w.document.querySelector('#micButton').dispatchEvent(new w.window.Event('click'));
    w.post({ type: 'dictationState', state: 'ended', reason: 'timeout' });
    check('dictation: a timed-out session is reported',
      /timed out/i.test(w.document.querySelector('#micStatus').textContent));
    w.close();
  }

  // A page that cannot reach the microphone has to say that, rather than
  // leaving the panel looking like it is still waiting for words.
  {
    const w = createWebview();
    w.document.querySelector('#micButton').dispatchEvent(new w.window.Event('click'));
    w.post({ type: 'dictationState', state: 'error' });
    check('dictation: a page denied the microphone says so',
      /microphone/i.test(w.document.querySelector('#micStatus').textContent),
      w.document.querySelector('#micStatus').textContent);
    w.close();
  }

  // VS Code destroys a hidden panel and rebuilds it, so this file can lose
  // every trace of a session the extension is still running.
  {
    const w = createWebview();
    const mic = w.document.querySelector('#micButton');
    w.post({ type: 'dictationText', text: 'pick up where it left off', done: false });
    check('dictation: a rebuilt panel adopts the session already running',
      w.document.querySelector('#prompt').value === 'pick up where it left off',
      w.document.querySelector('#prompt').value);
    check('dictation: …and the mic stops looking idle while the browser listens',
      mic.classList.contains('recording'));
    w.close();
  }

  // Sending ends dictation: leaving the microphone live would append the next
  // thing said to a box the user has just emptied.
  {
    const w = createWebview();
    w.document.querySelector('#micButton').dispatchEvent(new w.window.Event('click'));
    w.post({ type: 'dictationState', state: 'listening' });
    w.post({ type: 'dictationText', text: 'add the retry', done: false });
    w.document.querySelector('#chatForm').dispatchEvent(new w.window.Event('submit', { bubbles: true, cancelable: true }));
    check('dictation: sending stops the session', w.sent.some(m => m.type === 'dictateStop'));
    check('dictation: …and sends what was dictated',
      w.sent.find(m => m.type === 'ask')?.prompt === 'add the retry');
    w.close();
  }
}



// ── Diff cards ──────────────────────────────────────────────────────────────
function diffSuite() {
  console.log('\nedit cards:');

  let w = run([
    { type: 'start' },
    { type: 'pendingDiff', id: 'd1', path: '/proj/src/server.js', oldText: 'a\n', newText: 'b\n' },
  ]);
  w.document.querySelector('.diff-open-btn').dispatchEvent(new w.window.Event('click'));
  check('a diff card can open its file in the editor',
    w.sent.some(m => m.type === 'openDiffFile' && m.path === '/proj/src/server.js'));
  w.close();

  // Adding a card must not yank a reader who has deliberately scrolled up.
  w = createWebview();
  w.post({ type: 'start' });
  w.post({ type: 'chunk', text: 'some context' });
  w.window.eval('userScrolledUp = true;');
  w.post({ type: 'pendingDiff', id: 'd1', path: '/p/a.js', oldText: 'a\n', newText: 'b\n' });
  check('an incoming edit card respects a deliberate scroll position',
    w.window.eval('userScrolledUp') === true);
  w.close();

  // The approval queue is how a scrolled-past card is reached.
  w = run([
    { type: 'start' },
    { type: 'pendingDiff', id: 'd1', path: '/p/a.js', oldText: 'a\n', newText: 'b\n' },
    { type: 'pendingApprovals', approvals: [{ id: 'd1', path: '/p/a.js' }] },
  ]);
  const item = w.document.querySelector('.approval-item');
  check('the approval queue lists the pending edit', item !== null);
  let scrolled = false;
  const card = w.document.querySelector('.diff-card');
  card.scrollIntoView = () => { scrolled = true; };
  item?.dispatchEvent(new w.window.Event('click'));
  check('…and clicking it jumps to that card', scrolled);
  w.close();
}

// ── Custom slash commands ───────────────────────────────────────────────────
// The composer half: merging the files the extension found with the built-ins,
// and expanding a command that was typed out rather than picked from the menu.
function slashCommandSuite() {
  console.log('\ncustom slash commands (composer):');

  const CUSTOM = [
    { cmd: '/triage', label: 'Triage', icon: '🧪', desc: 'Triage the suite', hint: '[suite]',
      prompt: 'Run the integration suite for $ARGUMENTS and fix what fails.',
      origin: 'project', custom: true, removable: true, file: '/p/.navy/commands/triage.md' },
    { cmd: '/fix', label: 'Fix', icon: '🔧', desc: 'Our fix', prompt: 'Fix it OUR way.',
      origin: 'project', custom: true, removable: true, file: '/p/.navy/commands/fix.md' },
  ];
  // What a skill contributes to the same menu — a file to open, but no × (see
  // skillSlashCommands: a skill is a directory, and deleting only its SKILL.md
  // would orphan the rest).
  const SKILL_CMD = { cmd: '/pdf-tools', label: 'pdf-tools', icon: '📘', desc: 'Work with PDFs',
    prompt: 'Use the "pdf-tools" skill for this task. Call activate_skill with name "pdf-tools" '
      + 'to read its instructions, then follow them.\n\n$ARGUMENTS',
    origin: 'skill', custom: true,
    removable: false, file: '/p/.navy/skills/pdf-tools/SKILL.md' };

  const type = (w, text) => {
    const input = w.document.querySelector('#prompt');
    input.value = text;
    input.selectionStart = text.length;
    input.dispatchEvent(new w.window.Event('input'));
    return input;
  };

  // Menu.
  {
    const w = createWebview();
    w.post({ type: 'slashCommands', commands: CUSTOM });
    type(w, '/tri');
    const items = [...w.document.querySelectorAll('#slashDropdown .slash-item')];
    check('slash: a custom command appears in the "/" menu',
      items.some(i => i.dataset.cmd === '/triage'), items.map(i => i.dataset.cmd).join(','));
    check('slash: …labelled with where it came from',
      /project/.test(items.find(i => i.dataset.cmd === '/triage')?.textContent || ''));

    type(w, '/fix');
    const fix = [...w.document.querySelectorAll('#slashDropdown .slash-item')].filter(i => i.dataset.cmd === '/fix');
    check('slash: a custom command shadows the built-in of the same name, once', fix.length === 1);
    fix[0].dispatchEvent(new w.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    check('slash: picking it puts ITS prompt in the box',
      w.document.querySelector('#prompt').value === 'Fix it OUR way.',
      w.document.querySelector('#prompt').value);

    // The built-in list must survive a reload of the custom one.
    w.post({ type: 'slashCommands', commands: [] });
    type(w, '/fix');
    check('slash: removing the custom command restores the built-in',
      /Find and fix all bugs/.test((() => {
        const el = w.document.querySelector('#slashDropdown .slash-item');
        el.dispatchEvent(new w.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        return w.document.querySelector('#prompt').value;
      })()), w.document.querySelector('#prompt').value);
    w.close();
  }

  // Discovery, and editing.
  {
    const w = createWebview();
    w.post({ type: 'slashCommands', commands: CUSTOM });
    type(w, '/');
    const rows = [...w.document.querySelectorAll('#slashDropdown .slash-item')];
    const add = rows[rows.length - 1];
    check('slash: the menu offers a way to write a new one', add.classList.contains('slash-item-new'));
    add.dispatchEvent(new w.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    check('slash: …which asks the extension to create it',
      w.sent.some(m => m.type === 'newSlashCommand'));

    type(w, '/tri');
    const triage = w.document.querySelector('#slashDropdown .slash-item');
    triage.dispatchEvent(new w.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, altKey: true }));
    check('slash: alt-click opens the command\'s own file for editing',
      w.sent.some(m => m.type === 'openSlashCommand' && m.file === '/p/.navy/commands/triage.md'));
    check('slash: …and does not also run it',
      w.document.querySelector('#prompt').value.includes('/tri'),
      w.document.querySelector('#prompt').value);
    w.close();
  }

  // Removing one.
  {
    const w = createWebview();
    w.post({ type: 'slashCommands', commands: CUSTOM });
    type(w, '/');
    const rows = [...w.document.querySelectorAll('#slashDropdown .slash-item')];
    const custom = rows.find(r => r.dataset.cmd === '/triage');
    const builtIn = rows.find(r => r.dataset.cmd === '/review');
    check('slash: a custom command has a remove button',
      custom.querySelector('.slash-remove') !== null);
    check('slash: a built-in does not — there is no file to remove',
      builtIn.querySelector('.slash-remove') === null);
    check('slash: the remove button says which command it removes',
      /triage/.test(custom.querySelector('.slash-remove').getAttribute('aria-label') || ''),
      custom.querySelector('.slash-remove').getAttribute('aria-label'));

    const before = w.document.querySelector('#prompt').value;
    custom.querySelector('.slash-remove').dispatchEvent(
      new w.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    check('slash: clicking it asks the extension to remove that file',
      w.sent.some(m => m.type === 'deleteSlashCommand' && m.file === '/p/.navy/commands/triage.md'),
      JSON.stringify(w.sent.filter(m => m.type === 'deleteSlashCommand')));
    check('slash: …and does NOT also run the command it was removing',
      w.document.querySelector('#prompt').value === before,
      w.document.querySelector('#prompt').value);
    check('slash: …and closes the menu rather than leaving a dead row in it',
      w.document.querySelector('#slashDropdown').style.display === 'none');

    // The extension is the one that decides it happened; the menu follows.
    w.post({ type: 'slashCommands', commands: CUSTOM.filter(c => c.cmd !== '/triage') });
    type(w, '/tri');
    check('slash: once removed it is gone from the menu',
      w.document.querySelector('#slashDropdown').style.display === 'none'
      || ![...w.document.querySelectorAll('#slashDropdown .slash-item')].some(i => i.dataset.cmd === '/triage'));
    w.close();
  }

  // Skills share this menu but are directories, not single files.
  {
    const w = createWebview();
    w.post({ type: 'slashCommands', commands: [...CUSTOM, SKILL_CMD] });
    type(w, '/pdf');
    const row = w.document.querySelector('#slashDropdown .slash-item');
    check('skill: an installed skill appears in the "/" menu', row?.dataset.cmd === '/pdf-tools', row?.dataset.cmd);
    check('skill: …tagged as a skill, not as a command', /skill/.test(row.textContent), row.textContent);
    check('skill: …with no × — an × would delete SKILL.md and orphan the rest',
      row.querySelector('.slash-remove') === null);
    row.dispatchEvent(new w.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, altKey: true }));
    check('skill: …but alt-click still opens its SKILL.md',
      w.sent.some(m => m.type === 'openSlashCommand' && m.file === '/p/.navy/skills/pdf-tools/SKILL.md'));
    w.close();
  }

  // Invoking a skill by name is the escape hatch for models that cannot pick
  // one from a description — the user picks instead.
  {
    const w = createWebview();
    w.post({ type: 'slashCommands', commands: [SKILL_CMD] });
    type(w, '/pdf-tools invoice.pdf');
    w.document.querySelector('#chatForm').dispatchEvent(new w.window.Event('submit', { bubbles: true, cancelable: true }));
    const asked = w.sent.find(m => m.type === 'ask');
    check('skill: invoking one by name tells the model to load it',
      /activate_skill/.test(asked?.prompt || '') && /pdf-tools/.test(asked?.prompt || ''), asked?.prompt);
    check('skill: …carrying whatever was typed after it',
      /invoice\.pdf/.test(asked?.prompt || ''), asked?.prompt);
    w.close();
  }

  // A hyphenated or namespaced name has to survive being typed. `\w*` stopped
  // at the hyphen, so the menu closed halfway through `/pr-review`.
  {
    const w = createWebview();
    w.post({ type: 'slashCommands', commands: [{ cmd: '/db:migrate', label: 'Migrate', icon: '🗄', desc: 'Run migrations', prompt: 'Run the migrations.', custom: true }] });
    type(w, '/pr-');
    check('slash: a hyphenated name keeps the menu open',
      w.document.querySelector('#slashDropdown')?.style.display === 'block');
    type(w, '/db:');
    check('slash: a namespaced one does too',
      [...w.document.querySelectorAll('#slashDropdown .slash-item')].some(i => i.dataset.cmd === '/db:migrate'));
    w.close();
  }

  // Typing the command out in full, with arguments.
  {
    const w = createWebview();
    w.post({ type: 'slashCommands', commands: CUSTOM });
    type(w, '/triage auth');
    w.document.querySelector('#chatForm').dispatchEvent(new w.window.Event('submit', { bubbles: true, cancelable: true }));
    const asked = w.sent.find(m => m.type === 'ask');
    check('slash: a typed command is expanded, not sent literally',
      asked?.prompt === 'Run the integration suite for auth and fix what fails.', asked?.prompt);
    check('slash: …and the transcript shows the same text that was sent',
      (w.document.querySelector('.message.user')?.textContent || '').includes('Run the integration suite for auth'));
    w.close();
  }

  // A template with no $ARGUMENTS must not swallow them.
  {
    const w = createWebview();
    type(w, '/search node 24 release notes');
    w.document.querySelector('#chatForm').dispatchEvent(new w.window.Event('submit', { bubbles: true, cancelable: true }));
    check('slash: arguments a template has nowhere to put are appended, not dropped',
      w.sent.find(m => m.type === 'ask')?.prompt === 'Search the web for: node 24 release notes',
      w.sent.find(m => m.type === 'ask')?.prompt);
    w.close();
  }

  // Everything that must NOT be expanded.
  {
    const w = createWebview();
    type(w, '/not-a-command do the thing');
    w.document.querySelector('#chatForm').dispatchEvent(new w.window.Event('submit', { bubbles: true, cancelable: true }));
    check('slash: an unknown command is left exactly as typed',
      w.sent.find(m => m.type === 'ask')?.prompt === '/not-a-command do the thing');
    w.close();

    const w2 = createWebview();
    type(w2, '/bg refactor the parser');
    w2.document.querySelector('#chatForm').dispatchEvent(new w2.window.Event('submit', { bubbles: true, cancelable: true }));
    check('slash: /bg still starts a background task rather than a turn',
      w2.sent.some(m => m.type === 'startBackgroundTask' && m.prompt === 'refactor the parser')
      && !w2.sent.some(m => m.type === 'ask'));
    w2.close();
  }

  // A command name comes from a file on disk, so its text reaches the menu's
  // innerHTML from outside this file for the first time.
  {
    const w = createWebview();
    w.post({ type: 'slashCommands', commands: [
      { cmd: '/evil', label: '<img src=x onerror=alert(1)>', icon: '💀', desc: '<script>bad()</script>', prompt: 'p', custom: true },
    ] });
    type(w, '/ev');
    const row = w.document.querySelector('#slashDropdown .slash-item');
    check('slash: a command\'s text is escaped, never parsed as markup',
      row.querySelector('img') === null && row.querySelector('script') === null
      && row.textContent.includes('<img src=x'), row.innerHTML.slice(0, 120));
    w.close();
  }

  // Junk from the extension must not take the menu down with it.
  {
    const w = createWebview();
    w.post({ type: 'slashCommands', commands: [null, { cmd: 'nope' }, { cmd: '/ok', prompt: 'fine' }, 'string'] });
    type(w, '/ok');
    check('slash: malformed entries are ignored, the good one still works',
      [...w.document.querySelectorAll('#slashDropdown .slash-item')].some(i => i.dataset.cmd === '/ok'));
    w.close();
  }
}

// ── Theme tokens ────────────────────────────────────────────────────────────
// The stylesheet used to write accent tints as literal `rgba(88, 166, 255, α)`
// — the *fallback* value of --gold — at eighteen different alphas. That froze
// the dark-theme blue into every wash, so on a light theme the fills disagreed
// with the accent they were tinting. They are now mixed from the token.
//
// This suite exists because that decays silently: nothing breaks, no test
// fails, the panel just looks wrong on a theme the author wasn't using.
function themeTokenSuite() {
  console.log('\ncss: tints follow the theme instead of freezing one:');

  const css = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'media', 'styles.css'), 'utf8');

  // The :root block declares the palette; everything after it must consume it.
  const rootEnd = css.indexOf('\n}\n');
  const root = css.slice(0, rootEnd);
  const rules = css.slice(rootEnd);

  // Matches a CSS comment. Built with RegExp rather than a literal so the
  // escaping survives being written by tooling.
  const commentPattern = new RegExp('\\/\\*[\\s\\S]*?\\*\\/', 'g');
  // Literal colours that are tints of a token we already have. Neutral overlays
  // (black/white scrims) are exempt — they sit over user images or over the
  // lightbox scrim, where no theme token can predict the ground.
  const themed = [
    [/rgba\(\s*88,\s*166,\s*255/g, 'accent #58a6ff'],
    [/rgba\(\s*56,\s*139,\s*253/g, 'blue #388bfd'],
    [/rgba\(\s*248,\s*81,\s*73/g, 'red #f85149'],
    [/rgba\(\s*244,\s*112,\s*103/g, 'red #f47067'],
    [/rgba\(\s*210,\s*153,\s*34/g, 'amber #d29922'],
    [/rgba\(\s*63,\s*185,\s*80/g, 'green #3fb950'],
  ];
  for (const [re, label] of themed) {
    const hits = rules.match(re) || [];
    check(`no literal ${label} outside :root`, hits.length === 0,
      hits.length ? `${hits.length} occurrence(s) — use the matching token` : '');
  }

  // Every token the rules reference must actually be declared, or it silently
  // resolves to nothing and the property is dropped.
  const declared = new Set([...root.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map(m => m[1]));
  const used = new Set([...rules.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]));
  const undeclared = [...used].filter(v => !declared.has(v) && !v.startsWith('--vscode-'));
  check('every var() used in a rule is declared in :root',
    undeclared.length === 0, undeclared.join(', '));

  // The reverse: a token nothing uses is dead weight in every parse.
  const unused = [...declared].filter(v => !used.has(v) && !root.includes(`var(${v})`));
  check('no orphaned tokens in :root', unused.length === 0, unused.join(', '));

  // The tints are built with color-mix(), which needs Chromium 111. Nothing in
  // the stylesheet can enforce that, and the failure mode is silent: on an
  // engine without it every tinted background resolves to nothing and the panel
  // renders flat. `browserslist` is what the CSS compat linter reads, so tying
  // the two together here means lowering the target trips a test rather than
  // shipping a panel that looks broken on the oldest supported VS Code.
  const pkg = require('../package.json');
  const usesColorMix = /color-mix\(/.test(css);
  const floor = (pkg.browserslist || []).map(q => /chrome\s*>=\s*(\d+)/i.exec(q)).find(Boolean);
  check('a browser target is declared for the CSS compat linter',
    !usesColorMix || !!floor, 'add "browserslist": ["chrome >= N"] to package.json');
  check('the declared target supports color-mix (Chromium 111+)',
    !usesColorMix || (floor && Number(floor[1]) >= 111),
    floor ? `declared chrome >= ${floor[1]}` : '');

  // --muted on --bg is 5.05:1, which clears WCAG AA for body text. Dimming it
  // further with opacity does not: nine rules did, and the worst of them
  // (.diff-ln, at 0.45) landed on 2.01:1 — under half the 4.5:1 requirement,
  // on 10px text, where the large-text allowance does not apply either.
  // De-emphasis below --muted has to come from size or weight, not from
  // transparency, because transparency spends contrast that is not there.
  const dimmed = [];
  for (const m of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().split('\n').pop().trim();
    // :disabled is exempt: WCAG 1.4.3 excludes inactive user interface
    // components from the contrast requirement, and dimming is how a disabled
    // control says it is unavailable. This rule is about text meant to be read.
    if (sel.includes(':disabled')) continue;
    if (/(?<!-)color:\s*var\(--muted\)/.test(m[2]) && /opacity:\s*0\.\d+/.test(m[2])) dimmed.push(sel);
  }
  check('no --muted text is further dimmed by opacity', dimmed.length === 0, dimmed.join(', '));


  // Twelve font sizes, four of them fractional (10.5 / 11.5 / 12.5 / 13.5px),
  // which renders blurry at 100% zoom on a non-HiDPI display because half a
  // device pixel cannot be drawn. Rounded to whole pixels on a scale of eight.
  const sizes = [...new Set([...rules.matchAll(/font-size:\s*([\..]+)px/g)].map(m => m[1]))];
  const fractional = sizes.filter(v => v.includes('.'));
  check('no fractional font sizes', fractional.length === 0, fractional.join(', ') + 'px');
  const SCALE = ['9', '10', '11', '12', '13', '14', '16', '22'];
  const offScale = sizes.filter(v => !SCALE.includes(v));
  check('every font size is on the scale', offScale.length === 0, offScale.join(', ') + 'px');

  // The brand mark is also the busy indicator. There used to be a second,
  // near-identical wheel beside it that appeared only during a turn — two logos
  // costing width in the row that runs out of it first on a narrow sidebar.
  check('only one brand wheel exists', !rules.includes('brand-thinking'));
  check('the surviving one spins while a turn runs',
    (() => {
      const at = rules.indexOf('.app.is-thinking .brand-icon');
      if (at === -1) return false;
      return rules.slice(at, rules.indexOf('}', at)).includes('spin-wheel');
    })());

  // Windows and VS Code both offer high-contrast modes, which put the renderer
  // into forced-colors: the OS overrides colours, drops box-shadows and removes
  // gradients. Card type is carried by a coloured left rail and nothing else,
  // so without a block here every card type looks identical there.
  check('forced-colors is handled at all', /@media \(forced-colors: active\)/.test(rules));
  check('…and never opts an element out of the user\'s contrast choice',
    !rules.replace(commentPattern, '').includes('forced-color-adjust: none'));


  // The scroll arrows park beside the scrollbar, never over it. Both the
  // scrollbar and the arrows read one declared width, so the gap cannot drift
  // if either changes; a box-shadow would spread back across it and put the
  // arrow on the track again, so there is deliberately none.
  const arrowRule = (() => {
    const at = rules.indexOf('.scroll-arrow {');
    if (at === -1) return '';
    // Comments stripped: the rule's own comment explains why there is no
    // box-shadow, and a plain substring search would match the explanation.
    return rules.slice(at, rules.indexOf('}', at)).replace(commentPattern, '');
  })();
  check('the scroll arrows exist as a rule', arrowRule.length > 0);
  check('they are positioned from a measured inset, not a hardcoded number',
    arrowRule.includes('var(--scroll-arrow-inset)'));
  check('the scrollbar width is declared once, as the fallback for that inset',
    rules.includes('width: var(--scrollbar-w)')
    && root.includes('--scroll-arrow-inset'));
  check('they are square', arrowRule.includes('border-radius: 0'));
  // The vertical gap is a fixed 1px, deliberately not the measured inset: that
  // one exists to clear the scrollbar, and there is nothing to clear above or
  // below. Tying them together would drag the arrows off the ends of the track
  // whenever the host drew a wider bar.
  check('the vertical gap is a fixed value, not the scrollbar clearance',
    rules.includes('.scroll-arrow.up   { top: 5px; }')
    && rules.includes('.scroll-arrow.down { bottom: 5px; }'));
  check('…while the right inset stays measured',
    arrowRule.includes('var(--scroll-arrow-inset)'));
  check('no shadow to bleed back over the scrollbar', !arrowRule.includes('box-shadow'));

  // The card family shares one geometry. Four card types had drifted to four
  // header paddings, so a turn with several kinds read as several designs.
  for (const tok of ['--card-bg', '--card-pad-x', '--card-pad-y', '--card-margin', '--card-rail']) {
    check(`${tok} is declared`, declared.has(tok));
  }
  const cardRules = ['.diff-card,', '.term-card {', '.run-project-card {'];
  for (const sel of cardRules) {
    const at = rules.indexOf(sel);
    const block = rules.slice(at, rules.indexOf('}', at));
    check(`${sel.replace(/[,{ ]/g, '')} uses the shared card background`,
      at !== -1 && block.includes('var(--card-bg)'));
  }
}

// ── Settings panel ──────────────────────────────────────────────────────────
// The panel's controls used to run together in one undifferentiated column.
// They are now three <fieldset>s. The risk in that change is silent: a mistyped
// closing tag moves a control into the wrong section, or drops it entirely, and
// nothing throws — the field simply stops being saved.
function settingsPanelSuite() {
  console.log('\nsettings: controls are grouped and none were lost:');

  const w = createWebview();
  const d = w.document;

  const sections = [...d.querySelectorAll('#settingsForm .setting-section')];
  check('three sections', sections.length === 3, `got ${sections.length}`);

  const layout = sections.map(s => [
    s.querySelector('legend')?.textContent.trim(),
    [...s.querySelectorAll('input,select,textarea')].map(e => e.id),
  ]);
  check('connection section holds the endpoint fields',
    layout[0]?.[0] === 'Connection'
    && layout[0][1].join() === 'settingProvider,settingOllamaMode,settingHost,settingApiBase,settingApiKey');
  check('search & speech section holds the search key and voice',
    layout[1]?.[0] === 'Search & speech'
    && layout[1][1].join() === 'settingSearchApiKey,settingSpeechVoice,settingSpeechRate');
  check('behaviour section holds the model controls',
    layout[2]?.[0] === 'Behaviour'
    && layout[2][1].join() === 'settingTemperature,settingMaxIter,settingEditFormat,settingSystemPrompt');

  // Every control the save handler reads must still exist somewhere in the form
  // — this is the check that a lost field would fail.
  for (const id of ['settingProvider', 'settingOllamaMode', 'settingHost', 'settingApiBase',
    'settingApiKey', 'settingSearchApiKey', 'settingTemperature', 'settingMaxIter',
    'settingEditFormat', 'settingSpeechVoice', 'settingSpeechRate', 'settingSystemPrompt']) {
    check(`#${id} survives the regrouping`, !!d.querySelector('#' + id));
  }

  // A <legend> inside a <fieldset> is what makes a screen reader announce the
  // section on entering it; styled divs would look identical and say nothing.
  check('sections use real fieldset/legend semantics',
    sections.every(s => s.tagName === 'FIELDSET' && s.querySelector(':scope > legend')));

  d.querySelector('#openVsSettingsLink')?.click();
  check('the VS Code Settings link posts openVsSettings',
    w.sent.some(m => m.type === 'openVsSettings'));

  w.close();
}

// ── No-models state ─────────────────────────────────────────────────────────
// The most common first-run state used to report itself as the word "No models"
// in a dropdown, with the provider's actual error hidden in a title tooltip and
// no route to a fix — while the welcome chips still invited you to start work
// that could not succeed.
function noModelsSuite() {
  console.log('\nstate: an empty model list explains itself and offers a way out:');

  // A provider that answered with an error.
  let w = createWebview();
  w.post({ type: 'models', models: [], currentModel: '', error: 'invalid api key' });
  let box = w.document.querySelector('#welcomeProblem');
  check('the notice appears when the model list fails', box && !box.hidden);
  check("it shows the provider's own words, not a paraphrase",
    w.document.querySelector('#welcomeProblemDetail').textContent === 'invalid api key');

  w.document.querySelector('#welcomeTestBtn').click();
  check('Test connection runs the same self-test as the Command Palette',
    w.sent.some(m => m.type === 'testProvider'));

  w.document.querySelector('#welcomeSettingsBtn').click();
  check('Open settings shows the panel',
    w.document.querySelector('#settingsPanel').style.display === 'block');
  check('…and asks for the current values, so the form is not blank',
    w.sent.some(m => m.type === 'getSettings'));
  w.close();

  // A provider that answered fine but has nothing pulled — no error string, so
  // the notice has to supply its own explanation rather than render empty.
  w = createWebview();
  w.post({ type: 'models', models: [], currentModel: '' });
  const detail = w.document.querySelector('#welcomeProblemDetail').textContent;
  check('an empty list with no error still explains itself', detail.length > 20, detail);
  check('…and names the fix for both local and hosted providers',
    /pull one first/.test(detail) && /key and base URL/.test(detail));
  w.close();

  // The half that rots: clearing. A notice that never goes away is worse than
  // one that never appears.
  w = createWebview();
  w.post({ type: 'models', models: [], currentModel: '', error: 'nope' });
  w.post({ type: 'models', models: ['llama3', 'qwen'], currentModel: 'llama3' });
  box = w.document.querySelector('#welcomeProblem');
  check('the notice clears once models arrive', box.hidden);
  w.close();
}

// ── Keyboard access ─────────────────────────────────────────────────────────
// Two things here were not "polish" but flatly broken for anyone not using a
// mouse, and neither showed up as an error anywhere.
function keyboardSuite() {
  console.log('\nkeyboard: the panel is operable without a mouse:');

  // Session tabs were <div role="tab"> with no tabindex, so the strip could not
  // be reached at all — while the ✕ inside each tab could, being a real button.
  // You could close a chat by keyboard but never switch to one.
  let w = createWebview();
  w.post({ type: 'sessionList', sessions: [
    { id: 'a', name: 'One', active: true }, { id: 'b', name: 'Two' }, { id: 'c', name: 'Three' }] });
  const tabs = [...w.document.querySelectorAll('#sessionTabs [role="tab"]')];
  check('session tabs exist', tabs.length === 3, String(tabs.length));
  check('exactly one tab is in the tab sequence (roving tabindex)',
    tabs.filter(t => t.tabIndex === 0).length === 1,
    tabs.map(t => t.tabIndex).join(','));
  check('the tab in the sequence is the active one',
    tabs[0].tabIndex === 0 && tabs[0].getAttribute('aria-selected') === 'true');
  check('inactive tabs are reachable by arrow key, not by Tab',
    tabs.slice(1).every(t => t.tabIndex === -1 && t.getAttribute('aria-selected') === 'false'));

  const key = (el, k) => el.dispatchEvent(
    new w.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  key(tabs[0], 'ArrowRight');
  check('ArrowRight switches to the next chat',
    w.sent.some(m => m.type === 'switchSession' && m.sessionId === 'b')
    || w.sent.some(m => m.sessionId === 'b'), JSON.stringify(w.sent.slice(-1)));

  key(tabs[0], 'ArrowLeft');
  check('ArrowLeft wraps to the last chat rather than dead-ending',
    w.sent.some(m => m.sessionId === 'c'));

  key(tabs[1], 'Delete');
  check('Delete closes the focused chat',
    w.sent.some(m => m.type === 'closeSessionTab' && m.sessionId === 'b'));

  check('the close button names which chat it closes',
    w.document.querySelector('.session-tab-close').getAttribute('aria-label') === 'Close chat One');
  check('the new-chat button has a name, not just a "+"',
    (w.document.querySelector('.session-tab-add').getAttribute('aria-label') || '').length > 5);
  w.close();

  // A single chat has no ✕ — Delete must not offer to close what cannot close.
  w = createWebview();
  w.post({ type: 'sessionList', sessions: [{ id: 'solo', name: 'Only', active: true }] });
  key(w.document.querySelector('#sessionTabs [role="tab"]'), 'Delete');
  check('Delete does nothing when only one chat is open',
    !w.sent.some(m => m.type === 'closeSessionTab'));
  w.close();

  // The composer drives two listboxes and was wired to neither, so a menu
  // opening — and the arrow-key highlight moving through it — was silent.
  w = createWebview();
  const p = w.document.querySelector('#prompt');
  check('the composer declares itself a combobox', p.getAttribute('role') === 'combobox');
  check('…with a name of its own, since a placeholder is not a label',
    (p.getAttribute('aria-label') || '').length > 5);
  check('it reports closed while no menu is showing',
    p.getAttribute('aria-expanded') === 'false' && !p.hasAttribute('aria-activedescendant'));

  w.post({ type: 'slashCommands', commands: [{ cmd: '/test', prompt: 'x' }, { cmd: '/tell', prompt: 'y' }] });
  p.value = '/t'; p.dispatchEvent(new w.window.Event('input'));
  check('opening the command menu sets aria-expanded',
    p.getAttribute('aria-expanded') === 'true');
  check('…and points aria-controls at the listbox',
    p.getAttribute('aria-controls') === 'slashDropdown');

  key(p, 'ArrowDown');
  const first = p.getAttribute('aria-activedescendant');
  check('arrowing sets aria-activedescendant — the only way a highlight that '
    + 'never moves focus can be announced', !!first, String(first));
  check('…and it names a real option',
    !!first && !!w.document.getElementById(first)
    && w.document.getElementById(first).getAttribute('role') === 'option');
  key(p, 'ArrowDown');
  check('it follows the highlight rather than sticking to the first item',
    p.getAttribute('aria-activedescendant') !== first);

  key(p, 'Escape');
  check('closing the menu clears every combobox attribute',
    p.getAttribute('aria-expanded') === 'false'
    && !p.hasAttribute('aria-controls') && !p.hasAttribute('aria-activedescendant'));
  w.close();

  // Escape: settings was the only dismissible surface ignoring it.
  w = createWebview();
  const panel = w.document.querySelector('#settingsPanel');
  w.document.querySelector('#settingsButton').click();
  check('settings opens', panel.style.display === 'block');
  key(w.document.body, 'Escape');
  check('Escape closes the settings panel', panel.style.display === 'none');
  w.close();
}

// ── Names and announcements ─────────────────────────────────────────────────
// What assistive technology is told about the panel. None of this is visible,
// which is exactly why it rots without a test.
function labellingSuite() {
  console.log('\nnames: every control says what it is:');

  const w = createWebview();
  const d = w.document;

  // Twelve <label class="setting-label"> elements carried the right text and
  // none had a `for`, so the association was purely visual — a screen reader
  // announced "combo box" and nothing else. Placeholders do not substitute:
  // they are not labels, and they vanish as soon as anything is typed.
  const nameless = [];
  const weak = [];
  for (const c of d.querySelectorAll('input,select,textarea')) {
    if (c.hidden || c.type === 'hidden') continue;         // not in the a11y tree
    const byFor = c.id && d.querySelector(`label[for="${c.id}"]`);
    if (byFor || c.closest('label') || c.getAttribute('aria-label')
      || c.getAttribute('aria-labelledby')) continue;
    (c.getAttribute('title') ? weak : nameless).push(c.id || c.type);
  }
  check('every form control has a real accessible name',
    nameless.length === 0, nameless.join(', '));
  check('none rely on title alone, which needs a pointer to reveal',
    weak.length === 0, weak.join(', '));

  const labels = [...d.querySelectorAll('label.setting-label')];
  check('every settings label points at its control',
    labels.length > 0 && labels.every(l => l.getAttribute('for')),
    labels.filter(l => !l.getAttribute('for')).map(l => l.textContent.trim()).join(', '));
  check('…and every one of them resolves to something real',
    labels.every(l => d.getElementById(l.getAttribute('for'))));

  // The context bar was two bare divs whose only readable form was a title on
  // the inner one — a tooltip on a node that cannot take focus.
  const bar = d.querySelector('#contextBar');
  check('the context bar is a progressbar', bar?.getAttribute('role') === 'progressbar');
  w.post({ type: 'contextUsage', used: 64000, max: 128000 });
  check('…that reports how full it is', bar.getAttribute('aria-valuenow') === '50');
  check('…in words, not only as a bar length',
    /64,000/.test(bar.getAttribute('aria-valuetext') || ''),
    bar.getAttribute('aria-valuetext'));
  w.close();
}

function liveRegionSuite() {
  console.log('\nannouncements: the reply is live, the machinery is not:');

  const w = createWebview();
  [{ type: 'start' },
    { type: 'toolCall', tool: 'run_command', args: { command: 'npm run build' }, callId: 'c1' },
    { type: 'shellChunk', chunk: 'a lot of build output\n', streamId: 'c1' }].forEach(m => w.post(m));

  // #messages is aria-live="polite" and every descendant inherits it, so a turn
  // that runs a build used to read thousands of lines of output aloud.
  const nearestLive = (el) => {
    for (let n = el; n && n.getAttribute; n = n.parentElement) {
      const v = n.getAttribute('aria-live');
      if (v) return v;
    }
    return null;
  };
  check('the message area is still a live region',
    w.document.querySelector('#messages').getAttribute('aria-live') === 'polite');
  check('terminal output is excluded from it',
    nearestLive(w.document.querySelector('.term-out')) === 'off');
  const log = w.document.querySelector('.activity-log');
  check('so is the tool activity log', !log || nearestLive(log) === 'off');
  w.close();
}


// ── Chat search ─────────────────────────────────────────────────────────────
// _searchIdx was declared when this feature landed and never read: matches were
// collected and then there was no way to visit them.
function searchSuite() {
  console.log('\nsearch: matches are countable, reachable, and explain themselves:');

  const w = createWebview();
  w.post({ type: 'restore', messages: [
    { role: 'user', text: 'alpha one' }, { role: 'user', text: 'beta two' },
    { role: 'user', text: 'alpha three' }] });
  const si = w.document.querySelector('#searchInput');
  const count = () => w.document.querySelector('#searchCount').textContent;
  const type = (q) => { si.value = q; si.dispatchEvent(new w.window.Event('input')); };
  const enter = (shift) => si.dispatchEvent(new w.window.KeyboardEvent(
    'keydown', { key: 'Enter', shiftKey: !!shift, bubbles: true, cancelable: true }));

  type('alpha');
  check('several matches are counted', count() === '2 results', count());
  type('beta');
  check('one match is not "1 results"', count() === '1 result', count());

  type('zzz');
  const empty = w.document.querySelector('#searchEmpty');
  check('no match says so rather than counting to zero', count() === 'no matches', count());
  check('…and the blanked panel explains itself', empty && !empty.hidden);
  check('…quoting the term back, since it is usually a typo',
    /zzz/.test(empty.textContent), empty.textContent);

  type('alpha');
  check('the explanation clears once something matches', empty.hidden);

  enter();
  check('Enter steps to the first match', count() === '1 of 2', count());
  check('…and marks which one', w.document.querySelectorAll('.message.search-current').length === 1);
  enter();
  check('Enter advances', count() === '2 of 2', count());
  enter();
  check('…and wraps rather than dead-ending', count() === '1 of 2', count());
  enter(true);
  check('Shift+Enter goes back', count() === '2 of 2', count());
  w.close();
}

// ── Jump to latest ──────────────────────────────────────────────────────────
// Autoscroll correctly stops when the reader scrolls up, but there was no way
// back and no sign anything was still arriving.
function jumpLatestSuite() {
  console.log('\nscroll: leaving the bottom is recoverable:');

  const w = createWebview();
  const btn = w.document.querySelector('#jumpLatest');
  check('the control exists', !!btn);
  check('it is hidden while at the bottom', btn.hidden);

  // jsdom reports every dimension as 0, so scrollTop/scrollHeight cannot drive
  // this. Drive the scroll handler the way a real scroll would leave it.
  const messages = w.document.querySelector('#messages');
  Object.defineProperty(messages, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(messages, 'clientHeight', { value: 200, configurable: true });
  messages.scrollTop = 0;
  messages.dispatchEvent(new w.window.Event('scroll'));
  check('scrolling away reveals it', !btn.hidden);

  // 'assistant' is not a message type the panel has — replies stream as 'chunk'.
  w.post({ type: 'start' });
  w.post({ type: 'chunk', text: 'a reply that arrived while you were away' });
  check('it reports what arrived, not merely that something did',
    w.document.querySelector('#jumpLatestText').textContent === '1 new message',
    w.document.querySelector('#jumpLatestText').textContent);
  // Counting scrollToBottom() calls reported "3 new messages" for one reply;
  // a reply that streams for a minute is still one message.
  w.post({ type: 'chunk', text: ' and it kept going' });
  check('a long streamed reply stays one message',
    w.document.querySelector('#jumpLatestText').textContent === '1 new message',
    w.document.querySelector('#jumpLatestText').textContent);
  w.post({ type: 'done' });
  w.post({ type: 'start' });
  w.post({ type: 'chunk', text: 'a second reply' });
  check('a second reply counts as two',
    w.document.querySelector('#jumpLatestText').textContent === '2 new messages',
    w.document.querySelector('#jumpLatestText').textContent);

  btn.dispatchEvent(new w.window.Event('click'));
  check('pressing it returns to the bottom and hides again', btn.hidden);
  w.close();
}


// ── Chat outline ────────────────────────────────────────────────────────────
// Navigation for a long conversation: scrolling was the only way back to
// something asked twenty turns ago, and search only helps if you remember the
// words. The outline is rebuilt from the DOM on every open, so these also check
// it tracks the transcript rather than drifting from it.
function outlineSuite() {
  console.log('\noutline: a long chat can be navigated, not just scrolled:');

  let w = createWebview();
  let d = w.document;
  const btn = d.querySelector('#outlineButton');
  const panel = d.querySelector('#outlinePanel');

  btn.click();
  check('it opens', panel.style.display === 'block');
  check('an empty chat says what will appear here rather than showing a blank list',
    !d.querySelector('#outlineEmpty').hidden);
  check('…and lists nothing', d.querySelectorAll('.outline-row').length === 0);
  btn.click();
  check('the button toggles it shut', panel.style.display === 'none');
  w.close();

  w = createWebview();
  d = w.document;
  w.post({ type: 'restore', messages: [
    { role: 'user', text: 'Fix the retry loop' },
    { role: 'assistant', text: 'done' },
    { role: 'user', text: 'Now add a test\nand cover timeouts' },
    { role: 'assistant', text: 'done' },
    { role: 'user', text: 'z'.repeat(300) }] });
  d.querySelector('#outlineButton').click();

  const rows = [...d.querySelectorAll('.outline-row')];
  check('one entry per turn, assistant replies excluded', rows.length === 3, String(rows.length));
  check('entries are numbered from one',
    rows.map(r => r.querySelector('.outline-num').textContent).join() === '1,2,3');
  check('the count is worded, not just a number',
    d.querySelector('#outlineCount').textContent === '3 turns',
    d.querySelector('#outlineCount').textContent);

  const label = (i) => rows[i].querySelector('.outline-label').textContent;
  check('a multi-line prompt shows only its first line — a wrapped entry would '
    + 'make the list taller than the scrolling it replaces',
    label(1) === 'Now add a test', JSON.stringify(label(1)));
  check('a very long prompt is truncated', label(2).length < 80 && label(2).endsWith('…'),
    String(label(2).length));
  check('…with the whole thing on the tooltip, since two prompts often differ '
    + 'past the cut', rows[2].title.length === 300);

  // The label must come from the stored text, not the rendered bubble: a long
  // prompt renders as a visible preview plus a hidden overflow span.
  check('the label ignores the hidden overflow half of a collapsed prompt',
    !label(2).includes('undefined'));

  // Jumping.
  rows[1].click();
  check('choosing an entry closes the panel', panel.style.display === 'none');
  check('…and marks where you landed, so a wall of text is not disorienting',
    d.querySelectorAll('.message.outline-target').length === 1);
  check('…the right one', d.querySelector('.message.outline-target').dataset.outlineText
    === 'Now add a test\nand cover timeouts');

  // Only one mark at a time, or every jump would leave another behind.
  d.querySelector('#outlineButton').click();
  [...d.querySelectorAll('.outline-row')][0].click();
  check('an earlier mark is cleared on the next jump',
    d.querySelectorAll('.message.outline-target').length === 1);
  w.close();


  // The outline and the arrows must offer the same turns. They were two
  // separate queries and only the arrows filtered out messages hidden by an
  // active search, so the outline still listed what the search had hidden and
  // choosing one scrolled to an element with no box — landing nowhere.
  {
    const ws = createWebview();
    ws.post({ type: 'restore', messages: [
      { role: 'user', text: 'alpha first' },
      { role: 'user', text: 'beta second' },
      { role: 'user', text: 'alpha third' }] });
    const si = ws.document.querySelector('#searchInput');
    si.value = 'alpha';
    si.dispatchEvent(new ws.window.Event('input'));
    ws.document.querySelector('#outlineButton').click();
    const rows = [...ws.document.querySelectorAll('.outline-row')];
    check('the outline skips turns an active search has hidden',
      rows.length === 2, String(rows.length));
    check('…and counts only what it offers',
      ws.document.querySelector('#outlineCount').textContent === '2 turns',
      ws.document.querySelector('#outlineCount').textContent);
    ws.close();
  }

  // Settings and the outline are both full-width sheets under the topbar; open
  // together they leave almost none of the conversation showing.
  {
    const wp = createWebview();
    wp.document.querySelector('#settingsButton').click();
    wp.document.querySelector('#outlineButton').click();
    check('opening the outline closes settings',
      wp.document.querySelector('#settingsPanel').style.display === 'none');
    wp.document.querySelector('#settingsButton').click();
    check('…and opening settings closes the outline',
      wp.document.querySelector('#outlinePanel').style.display === 'none');
    wp.close();
  }

  // Keyboard.
  w = createWebview();
  d = w.document;
  w.post({ type: 'restore', messages: [
    { role: 'user', text: 'one' }, { role: 'user', text: 'two' }, { role: 'user', text: 'three' }] });
  const key = (el, k, mods) => el.dispatchEvent(new w.window.KeyboardEvent(
    'keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {})));

  d.querySelector('#outlineButton').click();
  check('opening focuses the first entry, so it is usable without a Tab first',
    d.activeElement?.classList.contains('outline-row'));
  const lab = () => d.activeElement.querySelector('.outline-label').textContent;
  key(d.activeElement, 'ArrowDown');
  check('ArrowDown walks the list', lab() === 'two', lab());
  key(d.activeElement, 'End');
  check('End reaches the last turn without a dozen keypresses', lab() === 'three', lab());
  key(d.activeElement, 'Home');
  check('Home returns to the first', lab() === 'one', lab());
  key(d.activeElement, 'ArrowUp');
  check('it wraps rather than dead-ending', lab() === 'three', lab());

  key(d.body, 'Escape');
  check('Escape closes it', d.querySelector('#outlinePanel').style.display === 'none');
  check('…and reports closed to assistive tech',
    d.querySelector('#outlineButton').getAttribute('aria-expanded') === 'false');

  d.dispatchEvent(new w.window.KeyboardEvent(
    'keydown', { key: 'o', ctrlKey: true, bubbles: true, cancelable: true }));
  check('Ctrl+O opens it', d.querySelector('#outlinePanel').style.display === 'block');
  check('…and reports open', d.querySelector('#outlineButton').getAttribute('aria-expanded') === 'true');
  w.close();
}


// ── Step one message ────────────────────────────────────────────────────────
// Reading back through a long conversation meant scrolling and guessing where
// one message ended. jsdom has no layout, so every offsetTop is 0 — the geometry
// is stubbed here, which is also what makes the assertions exact rather than
// approximate.
function msgStepSuite() {
  console.log('\nstep: the conversation moves one turn at a time:');

  let w = createWebview();
  // Visibility now lives on each arrow: they sit at opposite ends of the
  // scrollbar, so there is no shared container to toggle.
  const step = () => ({ hidden: w.document.querySelector('#msgPrev').hidden
    && w.document.querySelector('#msgNext').hidden });
  // jsdom reports every dimension as 0, which reads as "nothing to scroll" — so
  // a transcript taller than its viewport has to be declared before visibility
  // means anything here.
  const scrollable = (ww) => {
    const m = ww.document.querySelector('#messages');
    Object.defineProperty(m, 'scrollHeight', { value: 1500, configurable: true });
    Object.defineProperty(m, 'clientHeight', { value: 300, configurable: true });
  };
  scrollable(w);
  check('nothing to step through in an empty chat', step().hidden);
  w.post({ type: 'restore', messages: [{ role: 'user', text: 'only one' }] });
  check('…nor with a single turn', step().hidden);
  w.post({ type: 'restore', messages: [
    { role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }] });
  check('…nor when the only extra message is a reply', step().hidden);
  w.post({ type: 'restore', messages: [
    { role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'c' }] });
  check('the arrows appear once there are two turns', !step().hidden);
  w.close();

  // A conversation that fits on screen has nothing to navigate, and two dead
  // arrows read as broken rather than as "nothing to do here".
  w = createWebview();
  const shortM = w.document.querySelector('#messages');
  Object.defineProperty(shortM, 'scrollHeight', { value: 200, configurable: true });
  Object.defineProperty(shortM, 'clientHeight', { value: 300, configurable: true });
  w.post({ type: 'restore', messages: [
    { role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'c' }] });
  check('a chat short enough to fit hides them entirely',
    w.document.querySelector('#msgPrev').hidden && w.document.querySelector('#msgNext').hidden);
  w.close();

  w = createWebview();
  const d = w.document;
  w.post({ type: 'restore', messages: [
    { role: 'user', text: 'one' }, { role: 'assistant', text: 'r1' },
    { role: 'user', text: 'two' }, { role: 'assistant', text: 'r2' },
    { role: 'user', text: 'three' }] });

  const messages = d.querySelector('#messages');

  // jsdom has no layout, so geometry is simulated — and simulated the way a real
  // browser reports it: a rect top is relative to the VIEWPORT and therefore
  // moves as the container scrolls. Using a fixed number here instead would let
  // an implementation that never scrolls still pass.
  //
  // This is also what the bug was. The code used offsetTop, which is relative to
  // the nearest positioned ancestor — and .messages is not positioned, so the
  // measurement silently included the topbar. The container is given a non-zero
  // viewport top here to represent exactly that, so a regression to offsetTop
  // arithmetic cannot pass.
  const CONTAINER_TOP = 90;   // the topbar sits above the transcript
  messages.getBoundingClientRect = () => ({ top: CONTAINER_TOP, bottom: CONTAINER_TOP + 300 });
  const turns = [...d.querySelectorAll('#messages .message.user')];
  const layout = new Map();
  [...d.querySelectorAll('#messages .message')].forEach((el, i) => {
    layout.set(el, i * 300);   // position within the scroll content
    el.getBoundingClientRect = () => ({ top: CONTAINER_TOP + layout.get(el) - messages.scrollTop });
  });
  Object.defineProperty(messages, 'scrollHeight', { value: 1500, configurable: true });
  Object.defineProperty(messages, 'clientHeight', { value: 300, configurable: true });

  check('three user turns among five messages', turns.length === 3, String(turns.length));

  const prev = d.querySelector('#msgPrev');
  const next = d.querySelector('#msgNext');
  // They must live OUTSIDE the scroll container: an absolutely positioned child
  // of .messages scrolls away with the content, which is the whole reason the
  // transcript is wrapped.
  check('the arrows are anchored outside the scrolling transcript',
    !d.querySelector('#messages #msgPrev') && !d.querySelector('#messages #msgNext'));
  check('…in the wrapper that holds it', !!d.querySelector('.messages-wrap > #msgPrev')
    && !!d.querySelector('.messages-wrap > #msgNext'));
  messages.scrollTop = 0;
  messages.dispatchEvent(new w.window.Event('scroll'));

  // Both arrows stay present at every scroll position and go disabled at their
  // ends. Hiding them individually was tidier and unusable: Next hides at the
  // bottom, Prev at the top, and the bottom is where every reply leaves you — so
  // each blinked in and out during ordinary scrolling and could not be aimed at.
  check('at the first turn, Previous is present but disabled',
    !prev.hidden && prev.disabled);
  check('…and Next is present and live', !next.hidden && !next.disabled);

  next.click();
  check('Next lands exactly on the next USER message, not the reply between them',
    messages.scrollTop === 600, String(messages.scrollTop));
  check('…with no slack — a few pixels short would leave the previous message '
    + 'on screen and read as landing in the wrong place',
    messages.scrollTop === layout.get(turns[1]), String(messages.scrollTop));
  check('…and Previous becomes live without having moved',
    !prev.hidden && !prev.disabled);

  next.click();
  check('Next reaches the third turn', messages.scrollTop === 1200, String(messages.scrollTop));
  check('…and Next disables at the end rather than vanishing',
    !next.hidden && next.disabled);
  const atEnd = messages.scrollTop;
  next.click();
  check('pressing past the end does nothing rather than wrapping',
    messages.scrollTop === atEnd, String(messages.scrollTop));

  prev.click();
  check('Previous steps back one turn', messages.scrollTop === 600, String(messages.scrollTop));
  prev.click();
  check('…and back to the first', messages.scrollTop === 0, String(messages.scrollTop));
  check('…where Previous disables again, still in place', !prev.hidden && prev.disabled);

  const alt = (k) => d.dispatchEvent(new w.window.KeyboardEvent(
    'keydown', { key: k, altKey: true, bubbles: true, cancelable: true }));
  alt('ArrowDown');
  check('Alt+Down steps forward', messages.scrollTop === 600, String(messages.scrollTop));
  alt('ArrowUp');
  check('Alt+Up steps back', messages.scrollTop === 0, String(messages.scrollTop));

  const before = messages.scrollTop;
  d.dispatchEvent(new w.window.KeyboardEvent(
    'keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  check('a bare arrow key is left to whatever has focus',
    messages.scrollTop === before, String(messages.scrollTop));


  // The instability report: an arrow that is sometimes absent cannot be aimed
  // at. Walk the whole scroll range and require both to be present throughout.
  const absent = [];
  for (const pos of [0, 150, 300, 600, 900, 1200]) {
    messages.scrollTop = pos;
    messages.dispatchEvent(new w.window.Event('scroll'));
    if (prev.hidden || next.hidden) absent.push(pos);
  }
  check('both arrows are present at every scroll position, never blinking out',
    absent.length === 0, 'missing at scrollTop ' + absent.join(', '));

  // The outline must land a message in the same place the arrows do, or the two
  // navigation paths disagree about where a message begins.
  messages.scrollTop = 0;
  d.querySelector('#outlineButton').click();
  [...d.querySelectorAll('.outline-row')][1].click();
  check('the outline lands a turn exactly where the arrows would',
    messages.scrollTop === 600, String(messages.scrollTop));
  w.close();
}


// ── Scrollbar clearance ─────────────────────────────────────────────────────
// The arrows park beside the scrollbar. Asking the stylesheet for 5px and
// adding a pixel was not enough: VS Code's webview applies its own scrollbar
// styling, so the drawn width is not the requested one and the arrows sat on
// the track. The inset is measured off the element instead.
function scrollArrowInsetSuite() {
  console.log('\narrows: clearance is measured, not assumed:');

  const w = createWebview();
  const root = w.document.documentElement;
  const messages = w.document.querySelector('#messages');
  const inset = () => root.style.getPropertyValue('--scroll-arrow-inset');

  check('an inset is set as soon as the panel loads', inset().endsWith('px'), inset());

  // A classic scrollbar takes its width out of the box, so offsetWidth exceeds
  // clientWidth by exactly that much.
  Object.defineProperty(messages, 'offsetWidth', { value: 400, configurable: true });
  Object.defineProperty(messages, 'clientWidth', { value: 385, configurable: true });
  w.post({ type: 'restore', messages: [{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }] });
  check('a wide scrollbar pushes the arrows further in', inset() === '19px', inset());

  // An overlay scrollbar reserves no room at all, so the measurement is 0 and
  // the requested width has to act as a floor — otherwise the arrows would sit
  // flush against the edge, under the overlay.
  Object.defineProperty(messages, 'clientWidth', { value: 400, configurable: true });
  w.post({ type: 'restore', messages: [{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }] });
  check('an overlay scrollbar falls back to the declared width', inset() === '9px', inset());
  w.close();
}


// ── Command approval ────────────────────────────────────────────────────────
// The one card whose whole job is letting you read something before it runs.
function commandApprovalSuite() {
  console.log('\napproval: the command being approved is readable:');

  const w = createWebview();
  const long = 'npm run build -- --flag=' + 'y'.repeat(200);
  w.post({ type: 'pendingCommand', id: 'x', command: long });
  const pre = w.document.querySelector('.tool-details');
  check('the approval card shows the command', !!pre && pre.textContent === long);

  // .tool-details was set in JS with no CSS rule behind it. A bare <pre> does
  // not wrap, and .command-card sets overflow: hidden, so a command wider than
  // the sidebar was clipped with no way to scroll to the rest — approving
  // something you could not finish reading.
  const css = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'media', 'styles.css'), 'utf8');
  const at = css.indexOf('.tool-details {');
  const rule = at === -1 ? '' : css.slice(at, css.indexOf('}', at));
  check('.tool-details has a rule at all', at !== -1);
  check('…that wraps instead of clipping', rule.includes('white-space: pre-wrap'));
  check('…and breaks an unbroken command rather than overflowing',
    rule.includes('overflow-wrap: anywhere'));
  w.close();
}


// ── File chips ──────────────────────────────────────────────────────────────
function fileChipSuite() {
  console.log('\nchips: attached files read correctly, glyphs included:');

  const w = createWebview();
  const d = w.document;
  w.post({ type: 'workspaceFiles', files: [
    'src/main.cpp', 'deep/héllo—ünicode.tsx', 'a/テスト.py'] });
  const p = d.querySelector('#prompt');
  p.value = '@';
  p.dispatchEvent(new w.window.Event('input'));
  const items = [...d.querySelectorAll('#atDropdown .at-dropdown-item')];
  check('the file menu offers all three', items.length === 3, String(items.length));
  for (const i of items) {
    i.dispatchEvent(new w.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  }

  const chips = [...d.querySelectorAll('.chip-file')];
  check('each attached file gets a chip', chips.length === 3, String(chips.length));

  // The remove button carried a literal U+FFFD — the replacement character left
  // behind when bytes fail to decode as UTF-8 — so it drew as a missing-glyph
  // box beside three sibling buttons that rendered fine. It reads as "this app
  // cannot do Unicode"; it was one corrupted character in the source.
  for (const c of chips) {
    check('the remove button is U+2715, not a corrupted glyph',
      c.querySelector('.chip-remove').textContent === '✕',
      'U+' + c.querySelector('.chip-remove').textContent.codePointAt(0).toString(16));
  }

  // And the labels themselves: non-ASCII filenames survive intact.
  const labels = chips.map(c => c.querySelector('.chip-label').textContent);
  check('an accented, em-dashed filename survives',
    labels.includes('héllo—ünicode.tsx'), labels.join(', '));
  check('a CJK filename survives', labels.includes('テスト.py'), labels.join(', '));
  w.close();
}

// ── Indented code fences ────────────────────────────────────────────────────
// A fenced block had to begin hard against the left margin. One leading space
// stopped it being a code block at all — and a block written inside a list item
// is always indented, to the list's content column, so the commonest shape in an
// instruction list rendered as a paragraph with its fences shown literally. It
// looked flush-left in the panel only because HTML collapses leading whitespace,
// which is what made it read as "code fences are broken" rather than "indented
// ones are".
function indentedFenceSuite() {
  console.log('\nmarkdown: a fence works wherever it is indented to:');

  const F = '`'.repeat(3);
  const render = (md) => {
    const w = createWebview();
    w.post({ type: 'start' });
    w.post({ type: 'chunk', text: md });
    w.post({ type: 'done' });
    const card = w.document.querySelector('.code-block');
    const out = {
      cards: w.document.querySelectorAll('.code-block').length,
      literal: [...w.document.querySelectorAll('.message-bubble')]
        .some((b) => b.textContent.includes(F)),
      code: card ? card.querySelector('code').textContent : null,
    };
    w.close();
    return out;
  };

  const body = 'call build.bat';
  const cases = [['flush left', ''], ['one space', ' '], ['three spaces', '   '],
    ['four spaces', '    '], ['a tab', '\t']];
  for (const [name, pad] of cases) {
    const md = 'Run:\n\n' + pad + F + 'cmd\n' + pad + body + '\n' + pad + F + '\n';
    const r = render(md);
    check('a fence indented by ' + name + ' still makes a card', r.cards === 1, JSON.stringify(r));
    check(' …with the list indentation stripped off the code', r.code === body, JSON.stringify(r.code));
  }

  // The shape from the report: a block inside a numbered instruction list.
  const listed = render('1. **Build it:**\n   1. Open a terminal.\n   2. Run:\n\n'
    + '   ' + F + 'cmd\n   cd /d c:\\tmp\n   call build.bat\n   ' + F + '\n');
  check('a block inside a list item is a card, not a paragraph', listed.cards === 1,
    JSON.stringify(listed));
  check(' …and no fence is left showing as text', !listed.literal);
  check(' …and the command keeps its backslashes', listed.code.includes('c:\\tmp'),
    JSON.stringify(listed.code));

  // Indentation INSIDE the block belongs to the code and must survive.
  const nested = render('1. Run:\n\n   ' + F + 'js\n   function f() {\n'
    + '     return 1;\n   }\n   ' + F + '\n');
  check('indentation within the block is preserved',
    nested.code === 'function f() {\n  return 1;\n}', JSON.stringify(nested.code));

  // The closing fence need not sit at the opening indent.
  const ragged = render('Run:\n\n   ' + F + 'cmd\n   ' + body + '\n' + F + '\n');
  check('a closing fence at a different indent still closes the block',
    ragged.cards === 1 && !ragged.literal, JSON.stringify(ragged));

  // The fence length is capped so this stays linear — a long backtick run once
  // froze the renderer for 14.5 seconds. Relaxing the indent must not undo that.
  const t0 = Date.now();
  render('`'.repeat(160000));
  const ms = Date.now() - t0;
  check('a 160k-backtick run still renders in well under a second', ms < 1000, ms + 'ms');
}

orderingSuite();
themeTokenSuite();
settingsPanelSuite();
noModelsSuite();
keyboardSuite();
labellingSuite();
liveRegionSuite();
searchSuite();
jumpLatestSuite();
outlineSuite();
msgStepSuite();
scrollArrowInsetSuite();
commandApprovalSuite();
fileChipSuite();
indentedFenceSuite();
slashCommandSuite();
terminalSuite();
taskSuite();
runningSuite();
bubbleSuite();
highlightSuite();
speechSuite();
diffSuite();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
