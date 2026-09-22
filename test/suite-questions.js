const {
  fs, path, check, makeContext, sharedMock, queueOllamaFetch,
} = require('./harness.js');
const {
  normalizeQuestion, answerText, MAX_OPTIONS, LABEL_MAX, QUESTION_MAX,
  NO_PANEL, ALREADY_ASKING,
} = require('../src/questions.js');
const { recordTranscriptCard, beginTurnCards } = require('../src/transcript-cards.js');
const { TOOLS, TOOLS_API, TOOL_PROMPT } = require('../src/providers/tools.js');

// Asking, when the request could mean more than one thing. Navy used to pick a
// reading silently and spend the turn on it; now it can put the readings in the
// chat, recommend one, and carry on with the answer.
async function askUserSuite() {
  console.log('\nasking the user when the request is ambiguous:');

  // ── What counts as a question ──────────────────────────────────────────────
  check('a question with no options is not a question',
    /2 to 4 distinct options/.test(normalizeQuestion({ question: 'which?', options: [{ label: 'a' }] }).error || ''));
  check('...and neither is one with no text',
    /needs a question/.test(normalizeQuestion({ question: '  ', options: [{ label: 'a' }, { label: 'b' }] }).error || ''));
  check('the same option twice is one option, so two of them is not a choice',
    Boolean(normalizeQuestion({ question: 'q', options: [{ label: 'Same' }, { label: 'same' }] }).error));

  const many = normalizeQuestion({
    question: 'Which one?',
    options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' }],
  });
  check('a card holds at most four options', many.options.length === MAX_OPTIONS);

  const plain = normalizeQuestion({ question: 'Which one?', options: ['First', 'Second'] });
  check('a model that sends plain strings means the same thing',
    plain.options.length === 2 && plain.options[0].label === 'First');

  const long = normalizeQuestion({
    question: 'q'.repeat(QUESTION_MAX + 50),
    options: [{ label: 'l'.repeat(LABEL_MAX + 50), detail: 'd'.repeat(400) }, { label: 'b' }],
  });
  check('a question and its labels are bounded - they are a card, not a paragraph',
    long.question.length === QUESTION_MAX && long.options[0].label.length === LABEL_MAX && long.options[0].detail.length <= 200);

  const two = normalizeQuestion({
    question: 'Which?',
    options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }],
  });
  check('only one option can be the recommendation, or the badge says nothing',
    two.options.filter(o => o.recommended).length === 1);

  // ── What the model reads back ──────────────────────────────────────────────
  check('a chosen option comes back as the choice, with its reason',
    answerText({ label: 'Rewrite it', detail: 'slower but cleaner' }) === 'The person chose: "Rewrite it" (slower but cleaner). Carry on with that.');
  check('a typed answer comes back as their own words',
    /answered: "the second one"/.test(answerText({ text: 'the second one' })));
  check('no answer tells the model to decide for itself rather than ask again',
    /choose the most reasonable option/.test(answerText(null)) && /Do not ask again/.test(answerText(null)));

  // ── The tool, through a real provider ──────────────────────────────────────
  const os = require('os');
  const { ctrl } = sharedMock();
  const realFetch = global.fetch;
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-ask-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider._wslCache = { available: false };

    // With no panel there is nobody to ask, and the turn must not park on it.
    const noPanel = await provider.toolAskUser({ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] });
    check('with no chat panel open, the tool says so instead of waiting forever', noPanel === NO_PANEL);

    const posted = [];
    let onMessage = null;
    const fakeWebview = {
      postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
      asWebviewUri: (u) => u,
      cspSource: 'test-csp',
      onDidReceiveMessage: (fn) => { onMessage = fn; return { dispose() {} }; },
    };
    await provider.resolveWebviewView({ webview: fakeWebview, onDidDispose: () => {}, onDidChangeVisibility: () => {} });

    // The question reaches the panel, and the turn waits for the answer.
    let answered = null;
    const asking = provider.toolAskUser({
      question: 'Which login should I fix?',
      options: [{ label: 'The web one', detail: 'src/web/login.js', recommended: true }, { label: 'The CLI one' }],
    }).then(r => { answered = r; });
    await new Promise(r => setImmediate(r));
    const ask = posted.find(m => m.type === 'pendingQuestion');
    check('the question is posted to the chat as a card', Boolean(ask) && ask.question === 'Which login should I fix?', JSON.stringify(posted.map(m => m.type)));
    check('...with the options and the recommendation', ask.options.length === 2 && ask.options[0].recommended === true);
    check('...and the turn waits rather than guessing', answered === null);

    const second = await provider.toolAskUser({ question: 'And this?', options: [{ label: 'A' }, { label: 'B' }] });
    check('one question at a time - a second is refused while one is waiting', second === ALREADY_ASKING);

    // The panel answers.
    onMessage({ type: 'answerQuestion', id: ask.id, answer: { label: 'The CLI one', detail: '' } });
    await asking;
    check('the answer comes back to the same turn as the tool result',
      /The person chose: "The CLI one"/.test(answered), String(answered));
    check('...and the card is told it is settled',
      posted.some(m => m.type === 'questionResolved' && m.answer?.label === 'The CLI one'));

    // Typing instead of clicking: the composer is right there, and a typed
    // answer must not queue behind the turn that is waiting for it.
    posted.length = 0;
    let typedResult = null;
    const asking2 = provider.toolAskUser({ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }).then(r => { typedResult = r; });
    await new Promise(r => setImmediate(r));
    const before = provider.messages.length;
    onMessage({ type: 'ask', prompt: 'neither — do the admin one', queueId: 'q7' });
    await asking2;
    check('a typed message answers the waiting question instead of queueing behind it',
      /answered: "neither — do the admin one"/.test(typedResult), String(typedResult));
    check('...and does not start a turn of its own', provider.messages.length === before);
    check('...with the panel told to drop the bubble it drew, since the card holds the answer',
      posted.some(m => m.type === 'answeredByTyping' && m.id === 'q7'));

    // Stop, and a closing panel, must not leave a turn parked on an answer.
    let stoppedResult = null;
    const asking3 = provider.toolAskUser({ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }).then(r => { stoppedResult = r; });
    await new Promise(r => setImmediate(r));
    provider.cancelPendingApprovals();
    await asking3;
    check('Stop cancels a waiting question, and the model is told to decide itself',
      /No answer/.test(stoppedResult) && /choose the most reasonable option/.test(stoppedResult), String(stoppedResult));

    let closedResult = null;
    const asking4 = provider.toolAskUser({ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }).then(r => { closedResult = r; });
    await new Promise(r => setImmediate(r));
    provider.cancelAllPendingApprovals();
    await asking4;
    check('a closing panel cancels it too', /No answer/.test(closedResult));

    // ── Through a real turn: the model asks, the person answers, it carries on
    ctrl.config.approvalMode = 'auto-approve';
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'ask_user', args: { question: 'Which one?', options: [{ label: 'The web one' }, { label: 'The CLI one' }] } }] },
      { text: 'Fixed the CLI one.' },
    ]);
    posted.length = 0;
    const turn = provider.askNavy('fix the login', false, null, [], []);
    // Answer as soon as the card appears.
    for (let i = 0; i < 200 && !posted.some(m => m.type === 'pendingQuestion'); i++) await new Promise(r => setTimeout(r, 10));
    const live = posted.find(m => m.type === 'pendingQuestion');
    check('a turn can ask mid-flight', Boolean(live), JSON.stringify(posted.map(m => m.type)));
    onMessage({ type: 'answerQuestion', id: live.id, answer: { label: 'The CLI one' } });
    await turn;
    const saved = provider.messages[provider.messages.length - 1] || {};
    const kinds = (saved.cards || []).map(c => c.kind || c.tool);
    check('the question is kept with the turn that asked it',
      kinds.includes('question'), JSON.stringify(kinds));
    const card = (saved.cards || []).find(c => c.kind === 'question');
    check('...settled, with what was chosen, so a reopened chat still shows it',
      card.status === 'answered' && card.answer.label === 'The CLI one' && card.options.length === 2, JSON.stringify(card));
  } finally {
    global.fetch = realFetch;
    ctrl.config.approvalMode = 'ask-always';
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // ── The card record, on its own ────────────────────────────────────────────
  {
    const session = {};
    const log = [];
    beginTurnCards(session, log);
    recordTranscriptCard(session, { type: 'pendingQuestion', id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] });
    recordTranscriptCard(session, { type: 'questionResolved', id: 'q1', answer: null });
    check('a question nobody answered is saved as cancelled, not as still waiting',
      log[0].kind === 'question' && log[0].status === 'cancelled' && !log[0].answer, JSON.stringify(log[0]));
  }

  // ── The tool is declared, and the rules say when to reach for it ───────────
  {
    const tool = TOOLS.find(t => t.name === 'ask_user');
    check('ask_user is declared in TOOLS', Boolean(tool));
    check('...requiring a question and its options',
      tool.parameters.required.includes('question') && tool.parameters.required.includes('options'));
    check('...and rides the wire schema', TOOLS_API.some(t => t.function.name === 'ask_user'));
    check('the prompt lists it among the tools', /ask_user/.test(TOOL_PROMPT));
    check('...and says to ask only when the readings really differ',
      /ASK WHEN IT REALLY IS AMBIGUOUS/.test(TOOL_PROMPT) && /not "shall I proceed\?"/.test(TOOL_PROMPT));
    check('a headless run has nobody to ask, and says so',
      /nobody to ask/.test(require('../src/headless.js').NO_ONE_TO_ASK));
  }
}

module.exports = { askUserSuite };
