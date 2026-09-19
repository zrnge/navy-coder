'use strict';

// How hard the model thinks: Navy's five levels, and what each provider is sent
// for them.
//
//   fast, medium, high  - the levels Navy always had.
//   xhigh ("Extra high") and max - for models that reason deeper than "high":
//   Claude's effort goes to xhigh and max on Opus 4.7 and later, OpenAI's
//   reasoning_effort to xhigh (and max on some models).
//
// A model that has no such level is not an error. Each provider gets the
// nearest level it has; one that turns a level down at request time is asked
// again one step lower (max, then xhigh, then high), and the level that worked
// is remembered for that model for the rest of the session, so later requests
// don't fail first. Either way the person is told once, in the chat, which
// level was actually used.

const THINKING_LEVELS = ['fast', 'medium', 'high', 'xhigh', 'max'];
const LABEL = { fast: 'Fast', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const DEEP = new Set(['xhigh', 'max']);

function normalizeThinkingLevel(level) {
  return THINKING_LEVELS.includes(level) ? level : 'medium';
}

function rank(level) {
  return THINKING_LEVELS.indexOf(normalizeThinkingLevel(level));
}

// One level down from the deep end - max, xhigh, then high - or null once
// there is nowhere lower worth trying.
function stepDown(level) {
  if (level === 'max') return 'xhigh';
  if (level === 'xhigh') return 'high';
  return null;
}

function isDeep(level) {
  return DEEP.has(level);
}

// Claude's output_config.effort, and OpenAI's reasoning_effort: the same five
// words, with Navy's "fast" as their "low".
function effortFor(level) {
  const l = normalizeThinkingLevel(level);
  return l === 'fast' ? 'low' : l;
}

// o-series and GPT-5 reasoning models take reasoning_effort and refuse a
// non-default temperature. A GPT-5 chat model is not a reasoning model.
function isOpenAiReasoningModel(model) {
  const m = String(model || '').toLowerCase();
  return /^(o[0-9]|gpt-5)/.test(m) && !/-chat\b/.test(m);
}

// Ollama's `think`: gpt-oss wants a level and ignores true/false; the other
// thinking models take on or off. Undefined means "leave the model's default".
const OLLAMA_THINKERS = /(qwen3|deepseek-r1|gpt-oss|magistral|smallthinker|exaone-deep|phi4-reasoning)/i;
function ollamaThink(model, level) {
  if (!OLLAMA_THINKERS.test(String(model || ''))) return { think: undefined, used: level };
  const l = normalizeThinkingLevel(level);
  if (/gpt-oss/i.test(model)) {
    const think = l === 'fast' ? 'low' : l === 'medium' ? 'medium' : 'high';
    return { think, used: isDeep(l) ? 'high' : l };
  }
  if (l === 'fast') return { think: false, used: l };
  if (l === 'medium') return { think: undefined, used: l };
  return { think: true, used: isDeep(l) ? 'high' : l };
}

// Gemini: version 3 takes a thinkingLevel whose deepest is "high"; 2.5 takes a
// token budget. The output cap grows with the thinking, which counts against
// it - a large budget under a small cap leaves no room for the answer.
const GEMINI_BUDGET = { high: 8000, xhigh: 16384, max: 24576 };
function geminiThinking(model, level) {
  const l = normalizeThinkingLevel(level);
  if (/gemini-3/i.test(String(model || ''))) {
    if (l === 'fast') return { thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' }, maxOutputTokens: 8192, used: l };
    if (l === 'medium') return { thinkingConfig: null, maxOutputTokens: 8192, used: l };
    return { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' }, maxOutputTokens: 32768, used: isDeep(l) ? 'high' : l };
  }
  const budget = GEMINI_BUDGET[l];
  if (!budget) return { thinkingConfig: null, maxOutputTokens: 8192, used: l };
  return { thinkingConfig: { includeThoughts: true, thinkingBudget: budget }, maxOutputTokens: 8192 + budget, used: l };
}

// The deepest level a model has been found to take this session, per provider.
function ceilingKey(providerId, model) {
  return String(providerId || '') + '|' + String(model || '');
}

// `level`, lowered to what this model is already known to take.
function effectiveLevel(provider, providerId, model, level) {
  const l = normalizeThinkingLevel(level);
  const ceiling = provider && provider._thinkingCeilings && provider._thinkingCeilings.get(ceilingKey(providerId, model));
  return ceiling && rank(ceiling) < rank(l) ? ceiling : l;
}

function rememberCeiling(provider, providerId, model, level) {
  if (!provider) return;
  if (!provider._thinkingCeilings) provider._thinkingCeilings = new Map();
  provider._thinkingCeilings.set(ceilingKey(providerId, model), level);
}

// Said once per model and level, in the chat and the log, when the level used
// is not the one chosen.
function noteThinkingLimit(provider, model, asked, used) {
  if (!provider || !asked || !used || asked === used) return;
  if (!provider._thinkingLimitNoted) provider._thinkingLimitNoted = new Set();
  const key = String(model) + '|' + asked;
  if (provider._thinkingLimitNoted.has(key)) return;
  provider._thinkingLimitNoted.add(key);
  const text = `${model} doesn't offer ${LABEL[asked]} thinking, so Navy used ${LABEL[used]} - the deepest it has.`;
  try { provider.log?.(text); } catch { /* logging is best effort */ }
  try { provider.view?.webview.postMessage({ type: 'systemNotice', text }); } catch { /* no panel */ }
}

module.exports = {
  THINKING_LEVELS, LABEL, normalizeThinkingLevel, stepDown, isDeep, effortFor,
  isOpenAiReasoningModel, ollamaThink, geminiThinking, effectiveLevel, rememberCeiling, noteThinkingLimit,
};
