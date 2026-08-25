// ── Model pricing ────────────────────────────────────────────────────────────
// Approximate USD list price per 1M tokens, input/output separate — for spend
// visibility (the running cost estimate next to the token counter), NOT live
// pricing. Providers change prices without notice, so this is a best-effort
// snapshot only: `estimateCost` returns null for anything it can't confidently
// match rather than guessing, and the UI labels every figure it does show as an
// estimate.
//
// Extracted from extension.js so the table is a thing that can be reviewed,
// dated and tested on its own, rather than thirty regexes buried at line 140 of
// the largest file in the project. Two problems came with it:
//
//   * a model Navy has never heard of ships uncosted until someone edits this
//     file and cuts a release. `navy.modelPricing` closes that — a user can
//     price anything, today, without waiting for us.
//   * the ordering is load-bearing and silent when wrong. A single
//     `gemini-.*flash` rule once billed 2.5-flash turns at 1.5-flash rates,
//     and nothing failed. Every entry now carries the model id it exists FOR,
//     and a test asserts that id still resolves to that entry — so shadowing a
//     rule by adding a broader one above it breaks the build instead of the
//     user's cost estimate.

// When these figures were last checked against published price lists. Shown in
// the diagnostics bundle so a stale estimate is visible as stale rather than
// being quietly believed.
const PRICING_AS_OF = '2026-08-25';

// Providers that run on the user's own machine. Free is decided on the
// PROVIDER, never on a model-name guess: a locally-run model can share a name
// with a hosted one ("llama3") without sharing its price.
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio']);

// First matching pattern wins, ordered most-specific-first so e.g.
// "gpt-4o-mini" is checked before "gpt-4o". `example` is the model id the entry
// exists for — see pricingSuite, which fails if it stops resolving here.
const MODEL_PRICING = [
  { re: /claude-opus/i, in: 15, out: 75, example: 'claude-opus-4-1' },
  { re: /claude-(?:\d[\w.-]*-)?sonnet|claude-3-[57]-sonnet/i, in: 3, out: 15, example: 'claude-sonnet-5' },
  { re: /claude-haiku/i, in: 0.8, out: 4, example: 'claude-haiku-4-5-20251001' },
  { re: /gpt-4o-mini/i, in: 0.15, out: 0.6, example: 'gpt-4o-mini' },
  { re: /gpt-4o/i, in: 2.5, out: 10, example: 'gpt-4o' },
  { re: /gpt-4\.1-mini/i, in: 0.4, out: 1.6, example: 'gpt-4.1-mini' },
  { re: /gpt-4\.1-nano/i, in: 0.1, out: 0.4, example: 'gpt-4.1-nano' },
  { re: /gpt-4\.1/i, in: 2, out: 8, example: 'gpt-4.1' },
  { re: /gpt-5-nano/i, in: 0.05, out: 0.4, example: 'gpt-5-nano' },
  { re: /gpt-5-mini/i, in: 0.25, out: 2, example: 'gpt-5-mini' },
  { re: /gpt-5/i, in: 1.25, out: 10, example: 'gpt-5' },
  { re: /^o1-mini|o1-preview/i, in: 3, out: 12, example: 'o1-mini' },
  { re: /^o1\b/i, in: 15, out: 60, example: 'o1' },
  { re: /^o4-mini/i, in: 1.1, out: 4.4, example: 'o4-mini' },
  { re: /^o3-mini/i, in: 1.1, out: 4.4, example: 'o3-mini' },
  { re: /^o3\b/i, in: 2, out: 8, example: 'o3' },
  { re: /gpt-3\.5/i, in: 0.5, out: 1.5, example: 'gpt-3.5-turbo' },
  // Gemini is split by generation on purpose: 2.x is priced very differently
  // from 1.5, and a single `gemini-.*flash` rule quietly billed a 2.5-flash
  // turn at 1.5-flash rates. Unversioned/unknown generations fall through to
  // the last, oldest rule rather than being assumed to be the newest.
  { re: /gemini-2\.[05].*flash-lite/i, in: 0.1, out: 0.4, example: 'gemini-2.5-flash-lite' },
  { re: /gemini-2\.[05].*flash/i, in: 0.3, out: 2.5, example: 'gemini-2.5-flash' },
  { re: /gemini-2\.[05].*pro/i, in: 1.25, out: 10, example: 'gemini-2.5-pro' },
  { re: /gemini-.*flash/i, in: 0.075, out: 0.3, example: 'gemini-1.5-flash' },
  { re: /gemini-.*pro/i, in: 1.25, out: 5, example: 'gemini-1.5-pro' },
  { re: /deepseek-reasoner|deepseek-r1/i, in: 0.55, out: 2.19, example: 'deepseek-reasoner' },
  { re: /deepseek-chat|deepseek-v3/i, in: 0.27, out: 1.1, example: 'deepseek-chat' },
  { re: /grok/i, in: 3, out: 15, example: 'grok-4' },
  { re: /glm-4/i, in: 0.5, out: 1.5, example: 'glm-4.6' },
];

// Turns the raw navy.modelPricing object into entries estimateCost can use.
// Deliberately substring matching and not regex: this arrives from a settings
// file a person hand-edits, where a malformed regex would either throw or —
// worse — match far more than intended and misprice every turn silently.
//
// Anything malformed is dropped rather than defaulted. A half-parsed override
// would produce a confident wrong number, and this is the one place in Navy
// that touches the user's actual money — no estimate beats a wrong estimate.
function parsePricingOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out = [];
  for (const [match, value] of Object.entries(raw)) {
    if (!match || typeof value !== 'object' || value === null) continue;
    const inPrice = Number(value.in);
    const outPrice = Number(value.out);
    if (!Number.isFinite(inPrice) || !Number.isFinite(outPrice)) continue;
    if (inPrice < 0 || outPrice < 0) continue;
    out.push({ match: String(match).toLowerCase(), in: inPrice, out: outPrice });
  }
  // Longest match first, so a specific override ("gpt-5-mini") is not shadowed
  // by a broader one ("gpt-5") the user also wrote.
  return out.sort((a, b) => b.match.length - a.match.length);
}

// Pure (no `this`, no config reads) so it stays directly testable and the
// caller owns where overrides come from. Returns null when the cost genuinely
// can't be estimated — the caller must never substitute a guess for that.
function estimateCost(provider, model, promptTokens, completionTokens, overrides) {
  if (LOCAL_PROVIDERS.has(provider)) return 0;
  const name = model || '';
  // A user override wins over the built-in table, always: they can see their
  // own invoice and we cannot.
  const custom = parsePricingOverrides(overrides).find(o => name.toLowerCase().includes(o.match));
  const entry = custom || MODEL_PRICING.find(p => p.re.test(name));
  if (!entry) return null;
  return (promptTokens / 1_000_000) * entry.in + (completionTokens / 1_000_000) * entry.out;
}

module.exports = { MODEL_PRICING, PRICING_AS_OF, LOCAL_PROVIDERS, estimateCost, parsePricingOverrides };
