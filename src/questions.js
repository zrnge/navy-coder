'use strict';

// Asking the person, when the request could mean more than one thing.
//
// A model that misreads a request does not stop - it spends the whole turn
// building the wrong thing, confidently, and the person finds out at the end.
// The cost of asking is one exchange; the cost of guessing wrong is the turn.
//
// So ask_user puts the question in the chat as a card with the two to four
// readings the model actually sees, the one it would pick marked as the
// recommendation, and a box for an answer none of them covers. It is a
// question, not a permission gate: nothing is waiting on a decision about
// safety, so it never goes through the approval machinery, and the tool
// returns the answer as the tool result for the same turn to carry on with.
//
// The waiting is the same shape as an approval (a promise parked in a map on
// the session, resolved by a message from the panel), which is what makes Stop,
// closing the panel and switching chats already work: those paths cancel a
// pending question the same way they cancel a pending approval, and a cancelled
// question tells the model to decide for itself rather than leaving the turn
// hanging on an answer that is never coming.

const QUESTION_MAX = 300;   // a question that needs more than this is not a question
const LABEL_MAX = 80;       // labels are buttons, and a button is not a paragraph
const DETAIL_MAX = 200;
const MIN_OPTIONS = 2;      // one option is a statement, not a choice
const MAX_OPTIONS = 4;

const NO_PANEL = 'Error: there is no chat panel to ask in. Choose the most reasonable option yourself, say which you chose and why, and carry on.';
const ALREADY_ASKING = 'Error: a question is already waiting for an answer. Wait for it rather than asking another.';

const CANCELLED = 'No answer: the question was cancelled (the turn was stopped, or the chat was closed). '
  + 'Do not ask again - choose the most reasonable option, say plainly which you chose and why, and carry on.';

// What the model sent, as a question the panel can draw: trimmed, bounded,
// de-duplicated, and rejected with a reason when it is not a real choice.
function normalizeQuestion(args = {}) {
  const question = String(args.question || '').trim().slice(0, QUESTION_MAX);
  if (!question) return { error: 'ask_user needs a question.' };

  const raw = Array.isArray(args.options) ? args.options : [];
  const seen = new Set();
  const options = [];
  for (const o of raw) {
    // A model that sends plain strings means the same thing as {label}.
    const label = String((o && typeof o === 'object' ? o.label : o) || '').trim().slice(0, LABEL_MAX);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const detail = String((o && typeof o === 'object' ? o.detail : '') || '').trim().slice(0, DETAIL_MAX);
    const option = { label };
    if (detail) option.detail = detail;
    if (o && typeof o === 'object' && o.recommended) option.recommended = true;
    options.push(option);
    if (options.length === MAX_OPTIONS) break;
  }
  if (options.length < MIN_OPTIONS) {
    return { error: `ask_user needs ${MIN_OPTIONS} to ${MAX_OPTIONS} distinct options — if there is only one way to read the request, there is nothing to ask about.` };
  }
  // At most one recommendation, or the badge says nothing.
  let marked = false;
  for (const o of options) {
    if (!o.recommended) continue;
    if (marked) delete o.recommended;
    marked = true;
  }
  return { question, options };
}

// The answer as the model reads it. A typed answer is quoted as the person's
// own words; a chosen option carries the detail it was chosen with.
function answerText(answer) {
  if (!answer) return CANCELLED;
  if (answer.text) return `The person answered: "${String(answer.text).trim()}". Carry on with that.`;
  const label = String(answer.label || '').trim();
  if (!label) return CANCELLED;
  const detail = String(answer.detail || '').trim();
  return `The person chose: "${label}"${detail ? ` (${detail})` : ''}. Carry on with that.`;
}

class QuestionMethods {
  // Ask, and wait. The turn is paused here on purpose: the point is to not
  // spend it on the wrong reading.
  async toolAskUser(args = {}) {
    const norm = normalizeQuestion(args);
    if (norm.error) return 'Error: ' + norm.error;
    const webview = this.view?.webview;
    if (!webview) return NO_PANEL;
    if (this.pendingQuestions.size) return ALREADY_ASKING;

    const id = this.generateId();
    webview.postMessage({ type: 'pendingQuestion', id, question: norm.question, options: norm.options });
    const answer = await new Promise((resolve) => {
      this.pendingQuestions.set(id, { resolve });
    });
    return answerText(answer);
  }

  // The one place an answer lands, whoever sent it: the panel, a typed reply,
  // or a cancellation. Telling the panel is part of it, so the card settles
  // even when the answer came from somewhere else.
  resolveQuestion(id, answer) {
    const pending = this.pendingQuestions.get(id);
    if (!pending) return false;
    this.pendingQuestions.delete(id);
    pending.resolve(answer || null);
    this.view?.webview.postMessage({ type: 'questionResolved', id, answer: answer || null });
    return true;
  }

  // Typing an answer instead of clicking one. People do this - the composer is
  // right there and the question is in the chat - and without this the typed
  // message would queue behind a turn that is itself waiting for the answer,
  // which is a deadlock the person cannot see.
  answerPendingQuestion(text) {
    const answer = String(text || '').trim();
    if (!answer || !this.pendingQuestions.size) return false;
    const [id] = this.pendingQuestions.keys();
    return this.resolveQuestion(id, { text: answer });
  }

  // Stop, a closed panel, a cleared chat: the turn is going away, so the
  // question goes with it rather than parking the turn forever.
  cancelPendingQuestions() {
    for (const id of [...this.pendingQuestions.keys()]) this.resolveQuestion(id, null);
  }
}

module.exports = {
  QuestionMethods, normalizeQuestion, answerText,
  QUESTION_MAX, LABEL_MAX, DETAIL_MAX, MIN_OPTIONS, MAX_OPTIONS,
  NO_PANEL, ALREADY_ASKING, CANCELLED,
};
