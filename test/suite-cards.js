const {
  fs, path, check, makeContext, sharedMock, queueOllamaFetch,
} = require('./harness.js');
const {
  beginTurnCards, endTurnCards, recordTranscriptCard, diffCardRecord, auditCardRecord,
  DIFF_CARD_MAX_CHARS, DIFF_CARD_TURN_BUDGET, THINKING_CARD_MAX,
} = require('../src/transcript-cards.js');

// The cards the transcript draws from their own messages - diffs, approvals,
// reasoning, the audit card - saved with the turn that drew them, so a chat
// reopened after a reload shows them again. They used to be drawn live and
// never saved, and so was every card of a turn that was stopped or failed.
async function transcriptCardsSuite() {
  console.log('\nsession restore — diff, approval, reasoning and audit cards:');

  // ── The recorder ───────────────────────────────────────────────────────────
  const s = {};
  const log = [];
  recordTranscriptCard(s, { type: 'pendingDiff', id: 'd0', path: 'a.js', oldText: 'a\n', newText: 'b\n' });
  check('cards: nothing is recorded outside a turn', !s.turnCards && log.length === 0);
  beginTurnCards(s, log);
  recordTranscriptCard(s, { type: 'pendingDiff', id: 'd1', path: 'src/a.js', oldText: 'one\ntwo\nthree\n', newText: 'one\nTWO\nthree\n' });
  const d1 = log[0];
  check('cards: a diff is saved as its hunks, not as the two files',
    Boolean(d1) && d1.kind === 'diff' && d1.hunks === '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three'
    && d1.oldText === undefined && d1.newText === undefined, JSON.stringify(d1));
  check('cards: ...with its counts, and the old file\'s length for the unchanged lines after the last hunk',
    d1.added === 1 && d1.removed === 1 && d1.lines === 3 && d1.path === 'src/a.js');
  check('cards: ...pending until it is decided', d1.status === 'pending');
  recordTranscriptCard(s, { type: 'diffResolved', id: 'd1', approved: true });
  check('cards: ...and applied once it is', d1.status === 'applied');
  recordTranscriptCard(s, { type: 'pendingDiff', id: 'd2', path: 'b.js', oldText: '', newText: 'x\n' });
  recordTranscriptCard(s, { type: 'diffResolved', id: 'd2', approved: false });
  check('cards: a rejected diff is saved as rejected', log[1].status === 'rejected');
  recordTranscriptCard(s, { type: 'pendingCommand', id: 'c1', command: 'npm test' });
  recordTranscriptCard(s, { type: 'commandResolved', id: 'c1', approved: true });
  check('cards: an approval keeps what was asked and the answer',
    log[2].kind === 'approval' && log[2].command === 'npm test' && log[2].status === 'approved');
  recordTranscriptCard(s, { type: 'pendingCommand', id: 'c2', command: 'rm -rf build' });
  recordTranscriptCard(s, { type: 'commandResolved', id: 'c2', approved: false });
  check('cards: ...and so does a refused one', log[3].status === 'rejected');
  recordTranscriptCard(s, { type: 'thinkingChunk', text: 'weigh ' });
  recordTranscriptCard(s, { type: 'toolCall', tool: 'read_file', args: {} });
  recordTranscriptCard(s, { type: 'thinkingChunk', text: 'options' });
  const thinking = log.filter(c => c.kind === 'thinking');
  check('cards: a turn\'s reasoning is one card, where it began, as the transcript draws it',
    thinking.length === 1 && thinking[0].text === 'weigh options' && log[4] === thinking[0]);
  check('cards: tool messages are left to the turn loop, which logs those', log.length === 5);
  recordTranscriptCard(s, { type: 'thinkingChunk', text: 'z'.repeat(THINKING_CARD_MAX) });
  check('cards: reasoning is bounded, and says when it was cut',
    thinking[0].text.length === THINKING_CARD_MAX && thinking[0].truncated === true);

  // The diffs of one turn share a budget; past it, a diff keeps its counts only.
  const base = Array.from({ length: 400 }, (_, i) => 'line ' + i + ' ' + 'y'.repeat(70));
  const changed = base.map((l, i) => (i % 2 ? l + ' changed' : l));
  for (let i = 0; i < 16; i++) {
    recordTranscriptCard(s, { type: 'pendingDiff', id: 'big' + i, path: 'big' + i + '.js', oldText: base.join('\n'), newText: changed.join('\n') });
  }
  const bigs = log.filter(c => c.kind === 'diff' && c.path.startsWith('big'));
  check('cards: one saved diff is bounded, and says so',
    bigs[0].hunks.length > 0 && bigs[0].hunks.length <= DIFF_CARD_MAX_CHARS && bigs[0].truncated === true, String(bigs[0].hunks.length));
  const kept = bigs.reduce((n, c) => n + c.hunks.length, 0);
  check('cards: a turn\'s diffs together stay within their budget', kept <= DIFF_CARD_TURN_BUDGET, String(kept));
  check('cards: ...and one past it keeps its counts and says it was not kept',
    bigs.some(c => c.dropped && !c.hunks && c.added === 200 && c.removed === 200),
    JSON.stringify(bigs.map(c => [c.hunks.length, Boolean(c.dropped)])));
  endTurnCards(s);
  const count = log.length;
  recordTranscriptCard(s, { type: 'pendingDiff', id: 'late', path: 'late.js', oldText: 'a', newText: 'b' });
  check('cards: nothing is recorded once the turn is over', log.length === count);

  const p = Array.from({ length: 5000 }, (_, i) => 'p' + i).join('\n');
  const q = Array.from({ length: 5000 }, (_, i) => 'q' + i).join('\n');
  const rewritten = diffCardRecord('r.js', p, q);
  check('cards: a file rewritten past line-by-line diffing is saved as that, with its sizes',
    rewritten.rewritten === true && rewritten.hunks === '' && rewritten.added === 5000 && rewritten.removed === 5000);
  const audit = auditCardRecord({
    type: 'auditResult', headline: '2 findings', counts: { high: 1 }, deep: true,
    findings: Array.from({ length: 60 }, (_, i) => ({ file: 'f' + i, severity: 'low', id: 'x' })),
  });
  check('cards: the audit card keeps what it showed, bounded as the live card is',
    audit.kind === 'audit' && audit.headline === '2 findings' && audit.deep && audit.findings.length === 40);

  // ── Through real turns and the real postMessage wrapper ───────────────────
  const os = require('os');
  const { ctrl } = sharedMock();
  const realFetch = global.fetch;
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-cards-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    provider._wslCache = { available: false };
    const posted = [];
    const fakeWebview = {
      postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
      asWebviewUri: (u) => u,
      cspSource: 'test-csp',
      onDidReceiveMessage: () => ({ dispose() {} }),
    };
    await provider.resolveWebviewView({ webview: fakeWebview, onDidDispose: () => {}, onDidChangeVisibility: () => {} });
    ctrl.config.approvalMode = 'auto-approve';

    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'write_file', args: { path: 'hello.txt', content: 'hi\nthere\n' } }] },
      { text: 'Wrote hello.txt.' },
    ]);
    await provider.askNavy('create hello.txt', false, null, [], []);
    const turn = provider.messages[provider.messages.length - 1] || {};
    const kinds = (turn.cards || []).map(c => c.kind || c.tool);
    check('turn: the diff card is saved with the turn, after the tool that made it, as it was drawn',
      JSON.stringify(kinds) === '["write_file","diff"]', JSON.stringify(kinds));
    const diff = (turn.cards || []).find(c => c.kind === 'diff');
    check('turn: ...applied, with the change in it',
      Boolean(diff) && diff.status === 'applied' && diff.hunks === '@@ -0,0 +1,2 @@\n+hi\n+there', JSON.stringify(diff));
    check('turn: the tool\'s own card is still filled in with its result, once it returned',
      /hello\.txt/.test((turn.cards || [])[0]?.result || ''), JSON.stringify((turn.cards || [])[0]));

    // A turn that fails after doing work used to vanish from the saved chat.
    global.fetch = queueOllamaFetch([
      { toolCalls: [{ name: 'read_file', args: { path: 'hello.txt' } }] },
      { fail: { status: 401, text: 'unauthorized' } },
    ]);
    const before = provider.messages.length;
    await provider.askNavy('read hello.txt', false, null, [], []);
    const failed = provider.messages[provider.messages.length - 1] || {};
    check('turn: a turn that failed after doing work is saved, cards and all',
      provider.messages.length === before + 2 && failed.role === 'assistant' && (failed.cards || []).some(c => c.tool === 'read_file'),
      JSON.stringify(provider.messages.slice(before)));
    check('turn: ...with the error it ended on, and no reply text',
      typeof failed.error === 'string' && failed.error.length > 0 && failed.text === '', JSON.stringify(failed));

    const cap = [];
    global.fetch = queueOllamaFetch([{ text: 'Fine.' }], cap);
    await provider.askNavy('and now?', false, null, [], []);
    const sent = (cap[0] && cap[0].messages) || [];
    check('turn: a turn saved with no reply text is not sent to the model as an empty reply',
      sent.length > 0 && !sent.some(m => m.role === 'assistant' && !String(m.content || '').trim()),
      JSON.stringify(sent.map(m => [m.role, String(m.content || '').slice(0, 24)])));

    // The /audit card is drawn before its turn, and handed to the turn that answers it.
    provider._session.leadCards = { prompt: 'triage these', cards: [auditCardRecord({ headline: '1 finding', counts: {}, findings: [] })] };
    global.fetch = queueOllamaFetch([{ text: 'Unrelated.' }]);
    await provider.askNavy('something else', false, null, [], []);
    check('audit: a turn for another prompt does not take the scan\'s card',
      !(provider.messages[provider.messages.length - 1].cards || []).length && Boolean(provider._session.leadCards));
    global.fetch = queueOllamaFetch([{ text: 'One finding, low risk.' }]);
    await provider.askNavy('triage these', false, null, [], []);
    const auditTurn = provider.messages[provider.messages.length - 1] || {};
    check('audit: the turn that answers the scan carries its card',
      (auditTurn.cards || [])[0]?.kind === 'audit' && !provider._session.leadCards, JSON.stringify(auditTurn.cards));

    provider.sessionDigest = '- earlier: decided X';
    posted.length = 0;
    provider.restoreMessages();
    const restore = posted.find(m => m.type === 'restore');
    check('restore: the digest travels with the messages, for the condensed-history notice',
      Boolean(restore) && restore.digest === '- earlier: decided X');
  } finally {
    global.fetch = realFetch;
    ctrl.config.approvalMode = 'ask-always';
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { transcriptCardsSuite };
