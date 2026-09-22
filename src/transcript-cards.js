'use strict';

// Cards that are not tool results: the diff card for every file change, the
// approval card for every command, browser launch or MCP call that asked
// first, and the reasoning block. The transcript draws each from its own
// message - pendingDiff/diffResolved, pendingCommand/commandResolved,
// thinkingChunk - so the card log a turn saves (the tool-result cards, see
// makeCardRecord in extension.js) never saw them, and a chat reopened after a
// reload came back without a single diff in it.
//
// They are recorded where every message to the webview already passes - the
// postMessage wrapper in resolveWebviewView - into the running turn's card
// log, in the order they were drawn, so they replay in place among the tool
// cards. A new place that posts one of these messages is recorded without
// anyone having to remember to. The /audit card is drawn before its turn
// starts, so runProjectAudit hands it to that turn itself (auditCardRecord).
//
// All of it is saved into .navy/chats/<id>.json, so it is bounded: a diff
// keeps its hunks rather than both whole files, the diffs of one turn share
// one budget, and reasoning is capped.

const { unifiedDiff, splitLines } = require('./text-diff.js');

const DIFF_CARD_MAX_LINES = 200;       // a live card draws up to 400 rows; a saved one keeps 200
const DIFF_CARD_MAX_CHARS = 12000;
const DIFF_CARD_TURN_BUDGET = 150000;  // every diff of one turn together; past it, counts only
const THINKING_CARD_MAX = 8000;
const APPROVAL_TEXT_MAX = 2000;
const AUDIT_FINDINGS_MAX = 40;         // as many as the live card draws

// A turn's start and end: the log the recorder appends to, and what ties a
// decision back to the card it decides.
function beginTurnCards(session, cardLog) {
  if (!session) return;
  session.turnCards = cardLog;
  session.turnCardIds = new Map();
  session.turnThinking = null;
  session.turnDiffChars = 0;
}

function endTurnCards(session) {
  if (!session) return;
  session.turnCards = null;
  session.turnCardIds = null;
  session.turnThinking = null;
  session.turnDiffChars = 0;
}

// A diff card as it is saved: counts, the old file's length (for the
// "N unchanged lines" after the last hunk) and the hunks in diff -u form.
// `budget` is what is left of the turn's allowance; a diff that does not fit
// keeps its counts and says it was not kept.
function diffCardRecord(filePath, oldText, newText, budget = DIFF_CARD_TURN_BUDGET) {
  const record = {
    kind: 'diff', path: String(filePath || ''), status: 'pending',
    added: 0, removed: 0, lines: splitLines(oldText).length, hunks: '',
  };
  const d = unifiedDiff(oldText || '', newText || '', { maxLines: DIFF_CARD_MAX_LINES });
  if (!d) {
    record.rewritten = true;
    record.added = splitLines(newText).length;
    record.removed = record.lines;
    return record;
  }
  record.added = d.added;
  record.removed = d.removed;
  let hunks = d.text;
  let truncated = d.truncated;
  if (hunks.length > DIFF_CARD_MAX_CHARS) {
    const cut = hunks.lastIndexOf('\n', DIFF_CARD_MAX_CHARS);
    hunks = cut > 0 ? hunks.slice(0, cut) : '';
    truncated = true;
  }
  if (hunks.length > budget) {
    record.dropped = true;
    return record;
  }
  record.hunks = hunks;
  if (truncated) record.truncated = true;
  return record;
}

// The /audit card, from the auditResult message that drew it.
function auditCardRecord(message) {
  return {
    kind: 'audit',
    headline: String((message && message.headline) || ''),
    counts: (message && message.counts) || {},
    deep: Boolean(message && message.deep),
    findings: ((message && message.findings) || []).slice(0, AUDIT_FINDINGS_MAX),
  };
}

// Called with every message on its way to the webview. Only the kinds above
// are recorded, and only while a turn is running in the chat the message
// belongs to: outside a turn there is no reply for a card to belong to.
function recordTranscriptCard(session, message) {
  const log = session && session.turnCards;
  if (!log || !message || typeof message !== 'object') return;
  const ids = session.turnCardIds;
  switch (message.type) {
    case 'pendingDiff': {
      const left = DIFF_CARD_TURN_BUDGET - (session.turnDiffChars || 0);
      const record = diffCardRecord(message.path, message.oldText, message.newText, left);
      session.turnDiffChars = (session.turnDiffChars || 0) + record.hunks.length;
      log.push(record);
      if (message.id && ids) ids.set(message.id, record);
      return;
    }
    case 'pendingCommand': {
      const record = { kind: 'approval', command: String(message.command || '').slice(0, APPROVAL_TEXT_MAX), status: 'pending' };
      log.push(record);
      if (message.id && ids) ids.set(message.id, record);
      return;
    }
    case 'diffResolved':
    case 'commandResolved': {
      const record = ids && ids.get(message.id);
      if (!record) return;
      record.status = message.approved
        ? (record.kind === 'diff' ? 'applied' : 'approved')
        : 'rejected';
      ids.delete(message.id);
      return;
    }
    case 'pendingQuestion': {
      const record = {
        kind: 'question', status: 'pending',
        question: String(message.question || '').slice(0, APPROVAL_TEXT_MAX),
        options: (message.options || []).slice(0, 4),
      };
      log.push(record);
      if (message.id && ids) ids.set(message.id, record);
      return;
    }
    case 'questionResolved': {
      const record = ids && ids.get(message.id);
      if (!record) return;
      record.status = message.answer ? 'answered' : 'cancelled';
      if (message.answer) record.answer = message.answer;
      ids.delete(message.id);
      return;
    }
    case 'toolImage': {
      // A screenshot or visual diff shown in the chat: the card keeps the
      // file's path, and the extension turns it into a URI the panel may load
      // each time the chat is redrawn (_messagesForPanel in extension.js).
      log.push({ kind: 'image', tool: message.tool, file: message.file, caption: String(message.caption || '') });
      return;
    }
    case 'thinkingChunk': {
      // One block per turn, placed where the reasoning started - which is how
      // the transcript draws it: every later chunk goes into the same block.
      const text = String(message.text || '');
      if (!text) return;
      let record = session.turnThinking;
      if (!record) {
        record = { kind: 'thinking', text: '' };
        session.turnThinking = record;
        log.push(record);
      }
      const room = THINKING_CARD_MAX - record.text.length;
      if (text.length > room) record.truncated = true;
      if (room > 0) record.text += text.slice(0, room);
      return;
    }
    default:
  }
}

module.exports = {
  beginTurnCards, endTurnCards, recordTranscriptCard, diffCardRecord, auditCardRecord,
  DIFF_CARD_MAX_LINES, DIFF_CARD_MAX_CHARS, DIFF_CARD_TURN_BUDGET, THINKING_CARD_MAX,
};
