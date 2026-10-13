'use strict';

// A model whose reasoning has gone in circles.
//
// Reasoning models sometimes fall into a loop inside their own thinking: the
// same few sentences, over and over - "Let me call. OK. I'll call it. Go." -
// announcing an action and never taking it. Nothing ended that but the
// three-minute watchdog, which then ended the whole turn, after the provider
// had billed every repeated token. This spots the loop while it streams, so the
// one model call can be stopped and retried with a nudge to act.
//
// Two shapes, both checked against the recent tail only, so a long stretch of
// genuine reasoning earlier in the call never counts against it:
//   - a handful of short sentences repeating: few distinct sentences among many
//   - a longer passage repeated word for word several times over

const MIN_CHARS = 1500;        // too little reasoning to judge
const CHECK_EVERY = 300;       // characters between checks while streaming
const KEEP_CHARS = 6000;       // all the tail the checks ever look at
const SENTENCE_WINDOW = 2400;
const MIN_SENTENCES = 24;
const MAX_DISTINCT_RATIO = 0.3;
const PASSAGE_PROBE = 200;
const PASSAGE_WINDOW = 4000;
const PASSAGE_REPEATS = 4;

function sentences(text) {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map(s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim())
    .filter(Boolean);
}

// Pure: does the end of this reasoning look like a loop?
function looksLikeReasoningLoop(text) {
  const s = String(text || '');
  if (s.length < MIN_CHARS) return false;

  const recent = sentences(s.slice(-SENTENCE_WINDOW));
  if (recent.length >= MIN_SENTENCES && new Set(recent).size / recent.length <= MAX_DISTINCT_RATIO) return true;

  const probe = s.slice(-PASSAGE_PROBE);
  if (probe.trim().length >= PASSAGE_PROBE * 0.3) {
    const window = s.slice(-PASSAGE_WINDOW);
    let count = 0;
    for (let i = window.indexOf(probe); i !== -1; i = window.indexOf(probe, i + 1)) {
      if (++count >= PASSAGE_REPEATS) return true;
    }
  }
  return false;
}

// One per model call. feed() every streamed piece of reasoning; onLoop runs
// once, the first time the reasoning looks like a loop.
class ReasoningLoopGuard {
  constructor(onLoop) {
    this.onLoop = onLoop;
    this.text = '';
    this.sinceCheck = 0;
    this.tripped = false;
  }

  feed(piece) {
    if (this.tripped || !piece) return;
    this.text = (this.text + piece).slice(-KEEP_CHARS);
    this.sinceCheck += piece.length;
    if (this.sinceCheck < CHECK_EVERY) return;
    this.sinceCheck = 0;
    if (looksLikeReasoningLoop(this.text)) {
      this.tripped = true;
      try { this.onLoop?.(); } catch { /* stopping the call is best effort */ }
    }
  }
}

class ReasoningLoopError extends Error {
  constructor(model) {
    super(`${model || 'The model'}'s reasoning went in circles - the same few sentences over and over - so Navy stopped that step.`);
    this.name = 'ReasoningLoopError';
  }
}

module.exports = { looksLikeReasoningLoop, ReasoningLoopGuard, ReasoningLoopError };
