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

orderingSuite();
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
