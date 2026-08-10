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

orderingSuite();
terminalSuite();
taskSuite();
runningSuite();
bubbleSuite();
diffSuite();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
