'use strict';

// What earlier turns look like when they are replayed to the model.
//
// Two things went wrong here, and together they turned "hi" into a second
// /playthrough:
//
// A turn that ended without a reply - out of steps, stopped, failed - was left
// out of the replay altogether, because an empty assistant message is refused
// outright by some providers. Leaving it out removed the turn boundary with it:
// the request before it and the next thing the person typed arrived as two
// user messages in a row, which reads as one. "Run a playthrough ... begin
// now" followed by "hi" is an instruction to run a playthrough. So an
// unfinished turn is replayed as one plain sentence saying it did not finish,
// and why - the turns alternate again, and the old request reads as over. The
// same holds for a turn that was never saved at all (it failed or was stopped
// before doing anything): two user messages never reach the model back to
// back, whatever is or is not in the chat file.
//
// And a seeded command - /playthrough expands into a 7,000-character brief
// that tells the model it has full autonomy - was saved as the person's own
// words. That brief then rode along in every later turn of the chat, and was
// what the person saw as their message when the chat was reopened. It is now
// kept as the turn's `instruction`, with `text` holding what was typed. The
// brief is replayed only to a request that continues that same unfinished
// work - through any number of Continues in a row - which is the one case that
// needs it.

// Chats saved before `instruction` existed hold the brief in `text`. Each entry
// says how to recognise one and what the person had typed.
const LEGACY_SEEDED = [
  { prefix: '[SYSTEM — PLAYTHROUGH MODE]', shown: '/playthrough' },
];

function legacySeeded(item) {
  const text = String((item && item.text) || '');
  return LEGACY_SEEDED.find(s => text.startsWith(s.prefix)) || null;
}

// The brief a user turn actually ran with, when it was a seeded command.
function seededInstruction(item) {
  if (!item || item.role !== 'user') return '';
  if (item.instruction) return String(item.instruction);
  return legacySeeded(item) ? String(item.text) : '';
}

// What the person typed. This is what the chat shows, what names the tab, what
// an export quotes, what Rewind lists and what a compacted summary is made of.
function shownText(item) {
  if (!item) return '';
  if (item.role === 'user' && !item.instruction) {
    const legacy = legacySeeded(item);
    if (legacy) return legacy.shown;
  }
  return String(item.text || '');
}

// How a turn ended short of finishing, in the two voices it is told in: the
// assistant's own (replayed to the model) and the chat's (shown to a person,
// and written into an export). One table, so a new way of ending is one entry.
function ending(item) {
  const meta = (item && item.meta) || {};
  const ended = meta.ended || (item && item.error ? 'error' : '');
  const steps = Number(meta.steps) || 0;
  const after = steps ? ` after ${steps} tool calls` : '';
  switch (ended) {
    case 'cap': return { ended, mine: `I ran out of steps${after}`, turn: `ran out of steps${after}` };
    case 'stopped': return { ended, mine: 'it was stopped', turn: 'was stopped' };
    case 'timeout': return { ended, mine: 'it timed out waiting for the model', turn: 'timed out waiting for the model' };
    case 'error': return { ended, mine: 'it failed', turn: 'failed' };
    default: return null;
  }
}

// An unfinished turn, as one sentence in the assistant's own voice. Plain first
// person on purpose: a bracketed system note in an assistant turn is a format a
// model starts copying into replies of its own. `afterText` is for a turn that
// did write something before it stopped - its narration is replayed, and this
// follows it, so the model does not read "Let me click Login" as a finished
// answer.
function unfinishedReply(item, { afterText = false } = {}) {
  const e = ending(item);
  const why = String((item && item.error) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const reason = e && e.ended === 'error' && why ? ` (${why})` : '';
  if (afterText) return e ? `I did not finish that: ${e.mine}${reason}.` : '';
  if (!e) return 'I did not finish that, and wrote no reply.';
  if (e.ended === 'cap') return `I did not finish that: ${e.mine}, before writing a reply.`;
  return `I did not finish that: ${e.mine} before I wrote a reply${reason}.`;
}

// The same, for a person: under the turn's cards in a reopened chat, and in an
// export. Empty for a turn that finished, and for one that failed - a failure
// is shown as its error, which says more.
function endedNote(item) {
  const e = ending(item);
  if (!e || e.ended === 'error') return '';
  return `This turn ${e.turn} before it finished.`;
}

// The conversation so far, as the model gets it. `continues` is set when the
// new request carries on unfinished work ("Continue where it stopped"): the
// seeded brief that work started from goes back in, found by walking back
// through the Continues that came before this one.
function historyForModel(messages, { continues = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let briefAt = -1;
  if (continues) {
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i];
      if (!item || item.role !== 'user') continue;
      if (seededInstruction(item)) { briefAt = i; break; }
      if (!item.continues) break;   // an ordinary message: the seeded work is behind it, and over
    }
  }
  const out = [];
  const bridge = () => out.push({ role: 'assistant', content: unfinishedReply(null) });
  list.forEach((item, i) => {
    if (!item) return;
    if (item.role === 'user') {
      // A turn that was never saved leaves its request with nothing after it.
      if (out.length && out[out.length - 1].role === 'user') bridge();
      out.push({ role: 'user', content: i === briefAt ? seededInstruction(item) : shownText(item) });
    } else if (item.role === 'assistant') {
      const text = String(item.text || '');
      const tail = ending(item) ? unfinishedReply(item, { afterText: true }) : '';
      out.push({ role: 'assistant', content: text.trim() ? (tail ? text + '\n\n' + tail : text) : unfinishedReply(item) });
    }
  });
  // The new request is appended after this; it must not land on a user turn.
  if (out.length && out[out.length - 1].role === 'user') bridge();
  return out;
}

module.exports = { historyForModel, shownText, seededInstruction, unfinishedReply, endedNote, LEGACY_SEEDED };
