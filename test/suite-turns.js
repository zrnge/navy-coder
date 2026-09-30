const {
  fs, path, check, makeContext, sharedMock, queueOllamaFetch, makeOneShotBody,
} = require('./harness.js');
const { historyForModel, shownText, seededInstruction, unfinishedReply, endedNote } = require('../src/turn-history.js');
const { beginTurnCards, recordTranscriptCard } = require('../src/transcript-cards.js');
const { buildExportMarkdown } = require('../src/export.js');

// "hi" became a second /playthrough. The playthrough before it ran out of
// steps without writing a reply; the replay dropped that empty turn, so its
// 7,000-character brief and "hi" reached the model as one message. These are
// the pieces that stop it: the turn boundary survives, a seeded brief is not
// replayed as the person's words, a long run is told to wrap up before it is
// cut off, and a turn with no reply says how it ended.
const BRIEF = '[SYSTEM — PLAYTHROUGH MODE]\nYou are Navy running an automated, human-style visual QA playthrough. You have FULL AUTONOMY ... Begin now with the web-project check.';

async function turnHistorySuite() {
  console.log('\nturn history: unfinished turns and seeded commands:');

  // ── The exact shape of the chat that went wrong ────────────────────────────
  const legacyChat = [
    { role: 'user', text: BRIEF },
    { role: 'assistant', text: '', meta: { plan: [] }, cards: [{ tool: 'browser_navigate' }] },
  ];
  const replay = historyForModel(legacyChat);
  check('an unfinished turn keeps its place in the replay, so the turns still alternate',
    replay.length === 2 && replay[0].role === 'user' && replay[1].role === 'assistant', JSON.stringify(replay.map(m => m.role)));
  check('...saying plainly that it did not finish',
    /did not finish that/.test(replay[1].content), replay[1].content);
  check('a playthrough brief saved as the person\'s words is replayed as what they typed',
    replay[0].content === '/playthrough', replay[0].content.slice(0, 60));
  check('...so "full autonomy, begin now" does not ride into later turns',
    !JSON.stringify(replay).includes('FULL AUTONOMY'));

  // Whatever the mix, no two user messages ever arrive back to back.
  const mixed = [
    { role: 'user', text: 'a' }, { role: 'assistant', text: '' },
    { role: 'user', text: 'b' }, { role: 'assistant', text: '', error: 'boom' },
    { role: 'user', text: 'c' }, { role: 'assistant', text: 'fine' },
  ];
  const roles = historyForModel(mixed).map(m => m.role);
  check('no two user messages ever reach the model back to back',
    roles.every((r, i) => i === 0 || !(r === 'user' && roles[i - 1] === 'user')), roles.join(','));
  check('...and an unfinished reply is never an empty one, which some providers refuse',
    historyForModel(mixed).every(m => String(m.content).trim()));

  // How it ended, as the model reads it.
  check('out of steps says so, with how far it got',
    unfinishedReply({ meta: { ended: 'cap', steps: 100 } }) === 'I did not finish that: I ran out of steps after 100 tool calls, before writing a reply.');
  check('stopped says so', /it was stopped/.test(unfinishedReply({ meta: { ended: 'stopped' } })));
  check('failed says so, with the reason',
    /failed before I wrote a reply \(model not found\)/.test(unfinishedReply({ error: 'model not found', meta: { ended: 'error' } })));

  // A seeded turn saved the new way, and continuing it.
  const seeded = [
    { role: 'user', text: '/playthrough localhost:3000', instruction: BRIEF },
    { role: 'assistant', text: '', meta: { ended: 'cap', steps: 100 } },
  ];
  check('a seeded turn is replayed as what was typed', historyForModel(seeded)[0].content === '/playthrough localhost:3000');
  check('...but a request that continues it gets the brief back, because it cannot finish without it',
    historyForModel(seeded, { continues: true })[0].content === BRIEF);
  const older = [...seeded, { role: 'user', text: 'thanks' }, { role: 'assistant', text: 'ok' }];
  check('...and only the turn being continued, never an older one',
    !JSON.stringify(historyForModel(older, { continues: true })).includes('FULL AUTONOMY'));
  check('the brief is found for a legacy turn too', seededInstruction(legacyChat[0]) === BRIEF);
  check('an ordinary message is shown as it is', shownText({ role: 'user', text: 'fix the login' }) === 'fix the login');

  // ── Through real turns ─────────────────────────────────────────────────────
  const os = require('os');
  const { ctrl } = sharedMock();
  const realFetch = global.fetch;
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-turns-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider._wslCache = { available: false };
    const posted = [];
    provider.view = { webview: { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } } };

    // The reported bug, replayed: a chat holding an unfinished playthrough,
    // then "hi".
    provider.messages = JSON.parse(JSON.stringify(legacyChat));
    const cap = [];
    global.fetch = queueOllamaFetch([{ text: 'Hi! What can I do for you?' }], cap);
    await provider.askNavy('hi', false, null, [], []);
    const sent = (cap[0] && cap[0].messages) || [];
    // The current message is sent wrapped ("USER REQUEST:\nhi"); what matters
    // is that it arrives on its own, after an assistant turn.
    const hiAt = sent.findIndex(m => m.role === 'user' && /(^|\n)hi$/.test(String(m.content)));
    check('"hi" after an unfinished playthrough reaches the model on its own',
      hiAt > 0 && sent[hiAt - 1].role === 'assistant', JSON.stringify(sent.map(m => [m.role, String(m.content).slice(0, 30)])));
    check('...with the playthrough brief nowhere in the request',
      !JSON.stringify(sent).includes('FULL AUTONOMY'));

    // /playthrough saves what was typed, and runs with the brief.
    provider.messages = [];
    const pcap = [];
    global.fetch = queueOllamaFetch([{ text: 'This is not a web project.' }], pcap);
    await provider.runPlaythrough('');
    const saved = provider.messages.find(m => m.role === 'user');
    check('/playthrough is saved as what was typed', saved && saved.text === '/playthrough', saved && saved.text.slice(0, 40));
    check('...with the brief kept apart as the turn\'s instruction', saved && /PLAYTHROUGH MODE/.test(saved.instruction || ''));
    check('...and the turn itself still runs with the brief',
      JSON.stringify(pcap[0]?.messages || []).includes('PLAYTHROUGH MODE'));

    // A long run is told to wrap up while it still has room to reply.
    provider.messages = [];
    ctrl.config.maxToolIterations = 20;
    ctrl.config.approvalMode = 'auto-approve';
    const lcap = [];
    global.fetch = queueOllamaFetch(Array.from({ length: 20 }, (_, i) => ({
      toolCalls: [{ name: 'search_files', args: { query: 'needle' + i } }],
    })), lcap);
    await provider.askNavy('look around', false, null, [], []);
    const warned = lcap.map((req, i) => JSON.stringify(req.messages || []).includes('This turn will be cut off in 6 more steps') ? i : -1).filter(i => i >= 0);
    check('a turn nearing the step cap is told to stop and write its reply',
      warned.length > 0 && warned[0] === 14, JSON.stringify(warned));
    const capped = provider.messages[provider.messages.length - 1] || {};
    check('a turn that runs out of steps anyway is saved saying so',
      capped.role === 'assistant' && capped.meta?.ended === 'cap' && capped.meta?.steps === 20, JSON.stringify(capped.meta || {}).slice(0, 200));
    check('...and the panel is offered the Continue button as before',
      posted.some(m => m.type === 'capReached'));

    // Continuing it gets the brief back only when the turn was seeded; here it
    // was not, so the continue carries what was typed.
    const ccap = [];
    global.fetch = queueOllamaFetch([{ text: 'Done.' }], ccap);
    await provider.askNavy('Continue the task — you were cut off at the step limit.', false, null, [], [], '', { continues: true });
    const cmsgs = ccap[0]?.messages || [];
    check('continuing sees the unfinished turn and why it stopped',
      cmsgs.some(m => m.role === 'assistant' && /ran out of steps after 20 tool calls/.test(m.content)),
      JSON.stringify(cmsgs.map(m => [m.role, String(m.content).slice(0, 50)])));
    delete ctrl.config.maxToolIterations;   // back to the default, not to "undefined steps"

    // A stopped turn with no reply is saved as stopped.
    provider.messages = [];
    const one = queueOllamaFetch([{ toolCalls: [{ name: 'search_files', args: { query: 'x' } }] }]);
    let calls = 0;
    global.fetch = async (url, init) => {
      calls++;
      if (calls === 1) return one(url, init);
      return new Promise((_, reject) => {
        const fail = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        if (init?.signal?.aborted) fail();
        init?.signal?.addEventListener('abort', fail);
      });
    };
    const running = provider.askNavy('search for x', false, null, [], []);
    for (let i = 0; i < 200 && calls < 2; i++) await new Promise(r => setTimeout(r, 10));
    provider.abortController?.abort();
    await running;
    const stopped = provider.messages[provider.messages.length - 1] || {};
    check('a turn stopped before it replied is saved as stopped',
      stopped.role === 'assistant' && stopped.meta?.ended === 'stopped', JSON.stringify(stopped.meta || {}).slice(0, 200));

    // The chat's tab name, for a chat that opened with a legacy brief.
    provider.messages = JSON.parse(JSON.stringify(legacyChat));
    const panel = provider._messagesForPanel();
    check('a reopened chat shows /playthrough as the message, not the brief', panel[0].text === '/playthrough');
    check('...without changing what is saved', provider.messages[0].text === BRIEF);
  } finally {
    global.fetch = realFetch;
    ctrl.config.approvalMode = 'ask-always';
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // ── A thumbnail stays with its tool card ───────────────────────────────────
  {
    const session = {};
    const log = [];
    beginTurnCards(session, log);
    session.turnCardCalls.add('kept');
    recordTranscriptCard(session, { type: 'toolImage', tool: 'browser_screenshot', callId: 'kept', file: 'a.png' });
    recordTranscriptCard(session, { type: 'toolImage', tool: 'browser_screenshot', callId: 'past-the-cap', file: 'b.png' });
    check('a screenshot whose tool card was kept is kept under it', log.some(c => c.file === 'a.png'));
    check('...and one whose tool card was past the turn\'s cap is not left orphaned',
      !log.some(c => c.file === 'b.png'), JSON.stringify(log));
  }

  // ── The export ─────────────────────────────────────────────────────────────
  {
    const md = await buildExportMarkdown({
      messages: [
        { role: 'user', text: BRIEF },
        { role: 'assistant', text: '', meta: { ended: 'cap', steps: 100 }, cards: [{ tool: 'browser_navigate', args: {}, result: 'ok' }] },
      ],
    });
    check('an export quotes what was typed, not the brief', /\*\*You:\*\* \/playthrough/.test(md) && !/FULL AUTONOMY/.test(md), md.slice(0, 300));
    check('...and says the turn ran out of steps', /ran out of steps after 100 tool calls/.test(md));
  }
}


// ── The review's findings, each pinned ───────────────────────────────────────
async function turnReviewSuite() {
  console.log('\nturn history: what the review found:');

  // A turn that was never saved (failed or stopped before doing anything)
  // still leaves a boundary - between two user turns, and before the new one.
  const unsaved = historyForModel([{ role: 'user', text: '/playthrough', instruction: BRIEF }]);
  check('a request whose turn was never saved is still followed by an assistant turn',
    unsaved.length === 2 && unsaved[1].role === 'assistant' && /did not finish/.test(unsaved[1].content), JSON.stringify(unsaved));
  const twoUsers = historyForModel([{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }, { role: 'assistant', text: 'ok' }]);
  check('...and two saved user turns in a row get one between them',
    twoUsers.map(m => m.role).join(',') === 'user,assistant,user,assistant', twoUsers.map(m => m.role).join(','));

  // A turn cut off after writing narration is still an unfinished turn.
  const narrated = historyForModel([
    { role: 'user', text: 'test the site' },
    { role: 'assistant', text: 'Let me click the login button.', meta: { ended: 'cap', steps: 100 } },
  ]);
  check('a capped turn that wrote some narration still says it did not finish',
    narrated[1].content === 'Let me click the login button.\n\nI did not finish that: I ran out of steps after 100 tool calls.', narrated[1].content);
  check('a turn that finished is replayed exactly as written',
    historyForModel([{ role: 'user', text: 'q' }, { role: 'assistant', text: 'Done.' }])[1].content === 'Done.');

  // The brief survives any number of Continues in a row, and no further.
  const chain = [
    { role: 'user', text: '/playthrough', instruction: BRIEF },
    { role: 'assistant', text: '', meta: { ended: 'cap', steps: 100 } },
    { role: 'user', text: 'Continue the task', continues: true },
    { role: 'assistant', text: 'Checked two more pages.', meta: { ended: 'cap', steps: 100 } },
  ];
  const second = historyForModel(chain, { continues: true });
  check('a second Continue still gets the playthrough brief back',
    second[0].content === BRIEF && second[2].content === 'Continue the task', JSON.stringify(second.map(m => String(m.content).slice(0, 30))));
  const broken = [...chain, { role: 'user', text: 'thanks' }, { role: 'assistant', text: 'ok' }];
  check('...but not once an ordinary message has come in between',
    !JSON.stringify(historyForModel(broken, { continues: true })).includes('FULL AUTONOMY'));

  // A timeout is not a Stop, and the wording lives in one place.
  check('a timeout is told as a timeout', /timed out waiting for the model/.test(unfinishedReply({ meta: { ended: 'timeout' } })));
  check('the chat\'s note for each way of not finishing',
    endedNote({ meta: { ended: 'cap', steps: 7 } }) === 'This turn ran out of steps after 7 tool calls before it finished.'
    && endedNote({ meta: { ended: 'stopped' } }) === 'This turn was stopped before it finished.'
    && endedNote({ meta: { ended: 'timeout' } }) === 'This turn timed out waiting for the model before it finished.');
  check('...and none for a turn that finished, or one that failed (its error says more)',
    endedNote({ meta: {} }) === '' && endedNote({ error: 'boom', meta: { ended: 'error' } }) === '');

  const os = require('os');
  const { ctrl } = sharedMock();
  const realFetch = global.fetch;
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-turn-review-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider._wslCache = { available: false };
    const posted = [];
    provider.view = { webview: { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } } };
    ctrl.config.approvalMode = 'auto-approve';

    // #3 through a real turn: /playthrough fails on its very first model call,
    // so nothing but the request is saved - then "hi".
    global.fetch = queueOllamaFetch([{ fail: { status: 401, text: 'unauthorized' } }]);
    await provider.runPlaythrough('');
    check('a /playthrough that failed before doing anything saves only the request',
      provider.messages.length === 1 && provider.messages[0].text === '/playthrough', JSON.stringify(provider.messages.map(m => m.role)));
    const cap = [];
    global.fetch = queueOllamaFetch([{ text: 'Hi!' }], cap);
    await provider.askNavy('hi', false, null, [], []);
    const sent = (cap[0] && cap[0].messages) || [];
    const hiAt = sent.findIndex(m => m.role === 'user' && /(^|\n)hi$/.test(String(m.content)));
    check('"hi" after it still reaches the model on its own, behind an assistant turn',
      hiAt > 0 && sent[hiAt - 1].role === 'assistant' && !JSON.stringify(sent).includes('FULL AUTONOMY'),
      JSON.stringify(sent.map(m => [m.role, String(m.content).slice(0, 30)])));

    // #8: a refused /playthrough draws no message; an accepted one draws what is saved.
    posted.length = 0;
    await provider.runPlaythrough('file:///etc/passwd');
    check('a refused /playthrough draws no message in the chat', !posted.some(m => m.type === 'seededPrompt'));
    posted.length = 0;
    global.fetch = queueOllamaFetch([{ text: 'Not a web project.' }]);
    await provider.runPlaythrough('', 'q42');
    const seededMsg = posted.find(m => m.type === 'seededPrompt');
    check('an accepted one draws the message the chat saves, with its queue id',
      seededMsg && seededMsg.text === '/playthrough' && seededMsg.queueId === 'q42', JSON.stringify(seededMsg));

    // #1 through a real turn: every step narrates beside its tool call, and it
    // still runs out of steps.
    provider.messages = [];
    ctrl.config.maxToolIterations = 20;
    let n = 0;
    global.fetch = async () => {
      n++;
      const evt = { message: { role: 'assistant', content: 'Looking at part ' + n + '.', tool_calls: [{ function: { name: 'search_files', arguments: JSON.stringify({ query: 'q' + n }) } }] }, done: true, prompt_eval_count: 5, eval_count: 5 };
      return { ok: true, status: 200, body: makeOneShotBody(evt), text: async () => '' };
    };
    await provider.askNavy('look around', false, null, [], []);
    const narratedTurn = provider.messages[provider.messages.length - 1] || {};
    check('a turn that narrated right up to the step cap is saved as unfinished',
      narratedTurn.meta?.ended === 'cap' && narratedTurn.meta?.steps === 20 && String(narratedTurn.text || '').trim().length > 0,
      JSON.stringify({ meta: narratedTurn.meta && { ended: narratedTurn.meta.ended, steps: narratedTurn.meta.steps }, text: String(narratedTurn.text || '').slice(0, 40) }));
    const forPanel = provider._messagesForPanel().pop();
    check('...and the reopened chat is told so, in the shared wording',
      forPanel.endedNote === 'This turn ran out of steps after 20 tool calls before it finished.', String(forPanel.endedNote));

    // #4: the warning still arrives when the step it was due on left early.
    provider.messages = [];
    provider._session.plan = null;
    const pcap = [];
    const script = [{ toolCalls: [{ name: 'update_plan', args: { steps: [{ step: 'look', status: 'in_progress' }, { step: 'fix', status: 'pending' }] } }] }];
    for (let i = 1; i <= 12; i++) script.push({ toolCalls: [{ name: 'search_files', args: { query: 'p' + i } }] });
    script.push({ text: 'I have looked around enough.' });   // step 14 of 20: quits mid-plan - nudged, and `continue`s
    for (let i = 14; i < 20; i++) script.push({ toolCalls: [{ name: 'search_files', args: { query: 'r' + i } }] });
    global.fetch = queueOllamaFetch(script, pcap);
    await provider.askNavy('look around and fix', false, null, [], []);
    const warnedAt = pcap.map((req, i) => JSON.stringify(req.messages || []).includes('This turn will be cut off in') ? i : -1).filter(i => i >= 0);
    check('the wrap-up warning is not lost when the step it was due on left early',
      warnedAt.length > 0 && warnedAt[0] > 13, JSON.stringify(warnedAt));
    const firstWarned = warnedAt.length ? JSON.stringify(pcap[warnedAt[warnedAt.length - 1]].messages) : '';
    check('...and it is sent once, not on every remaining step',
      (firstWarned.match(/This turn will be cut off in/g) || []).length === 1, String((firstWarned.match(/This turn will be cut off in/g) || []).length));
    delete ctrl.config.maxToolIterations;

    // #5: the watchdog's abort is a timeout, not a Stop.
    provider.messages = [];
    const one = queueOllamaFetch([{ toolCalls: [{ name: 'search_files', args: { query: 'x' } }] }]);
    let calls = 0;
    global.fetch = async (url, init) => {
      calls++;
      if (calls === 1) return one(url, init);
      return new Promise((_, reject) => {
        const fail = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        if (init?.signal?.aborted) fail();
        init?.signal?.addEventListener('abort', fail);
      });
    };
    const running = provider.askNavy('search for x', false, null, [], []);
    for (let i = 0; i < 200 && calls < 2; i++) await new Promise(r => setTimeout(r, 10));
    provider._session.abortReason = 'timeout';   // as the watchdog does, just before it aborts
    provider.abortController?.abort();
    await running;
    const timedOut = provider.messages[provider.messages.length - 1] || {};
    check('a turn the watchdog cut off is saved as timed out, not as stopped by the person',
      timedOut.meta?.ended === 'timeout', JSON.stringify(timedOut.meta || {}).slice(0, 120));

    // #7: a legacy brief does not reach a compacted summary, or the Rewind list.
    const dcap = [];
    global.fetch = queueOllamaFetch([{ text: 'The user ran a playthrough; it did not finish.' }], dcap);
    const digest = await provider._digestFor('http://127.0.0.1:11434', 'test-model', [
      { role: 'user', text: BRIEF }, { role: 'assistant', text: '', meta: { ended: 'cap' } },
    ]);
    check('compacting a legacy chat never feeds the brief to the summariser',
      dcap.length && !JSON.stringify(dcap).includes('FULL AUTONOMY') && JSON.stringify(dcap).includes('/playthrough'), JSON.stringify(dcap).slice(0, 200));
    check('...or writes it into the digest', !String(digest).includes('FULL AUTONOMY'), String(digest).slice(0, 120));
    provider.messages = [{ role: 'user', text: BRIEF }, { role: 'assistant', text: 'ok' }];
    ctrl.quickPickCalls.length = 0;
    ctrl.nextQuickPick = undefined;
    await provider.rewindConversation();
    const labels = (ctrl.quickPickCalls[0]?.items || []).map(i => i.label);
    check('Rewind lists a legacy playthrough as what was typed', labels.includes('/playthrough') && !labels.some(l => /PLAYTHROUGH MODE/.test(l)), JSON.stringify(labels));
  } finally {
    global.fetch = realFetch;
    ctrl.config.approvalMode = 'ask-always';
    delete ctrl.config.maxToolIterations;
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { turnHistorySuite, turnReviewSuite };
