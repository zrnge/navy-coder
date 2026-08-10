// Provider-error classification: turn raw API error payloads into a plain-language
// explanation with concrete next steps, and redact account identifiers so users
// don't paste org/user ids into public bug reports or screenshots. Pure module.

// Strip identifiers and secrets from an error string before it's shown anywhere.
function redactError(text) {
  return String(text || '')
    .replace(/\b(org|user|proj|sess|req|acct)_[A-Za-z0-9]{6,}\b/g, '$1_…')
    .replace(/\buser-[A-Za-z0-9]{6,}\b/g, 'user-…')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-…')
    .replace(/"user_id"\s*:\s*"[^"]*"/g, '"user_id":"…"')
    .replace(/"organization"\s*:\s*"[^"]*"/g, '"organization":"…"');
}

// Classify a provider error message. Returns { kind, title, tips: [..] } — or
// null when nothing matched (caller shows the generic form). `kind` is a
// stable machine-readable tag — also used by isTransientProviderError below
// to decide fallback-worthiness — so that decision and the human-facing
// title/tips can never drift out of sync with each other.
function classifyProviderError(providerLabel, rawMessage) {
  const m = String(rawMessage || '');
  const has = (re) => re.test(m);

  if (has(/\b(401|invalid[_ ]api[_ ]key|incorrect api key|authentication|unauthorized)\b/i)) {
    return {
      kind: 'auth',
      title: `${providerLabel}: API key rejected`,
      tips: ['Open Settings (gear icon) and re-paste your API key for this provider.',
             'Make sure the key belongs to this provider and has not been revoked.'],
    };
  }
  if (has(/RESOURCE_EXHAUSTED|exceeded your current quota|limit:\s*0|billing/i)) {
    return {
      kind: 'quota',
      title: `${providerLabel}: your account has no quota for this model`,
      tips: ['This is a billing/quota limit on your account, not a Navy problem.',
             'Enable billing for the provider, or switch to a model/tier your plan includes.',
             'Local Ollama has no quotas if you want to keep working now.'],
    };
  }
  if (has(/tokens per minute|TPM|request too large|rate[_ ]?limit|429|too many requests|temporarily rate-limited/i)) {
    const nums = m.match(/Limit\s*:?\s*(\d+).*?Requested\s*:?\s*(\d+)/is);
    const detail = nums ? ` (limit ${nums[1]}, this request needed ${nums[2]})` : '';
    return {
      kind: 'rate_limit',
      title: `${providerLabel}: rate limit hit${detail}`,
      tips: ['Wait ~60 seconds and try again — per-minute budgets reset.',
             'Click "New chat" to shrink the conversation history Navy sends.',
             'Free tiers are small for agentic tools; a paid tier or local Ollama avoids this.'],
    };
  }
  if (has(/maximum context length|context[_ ]length[_ ]exceeded|too many tokens|context window|input is too long|prompt is too long/i)) {
    return {
      kind: 'context_length',
      title: `${providerLabel}: the conversation no longer fits this model's context window`,
      tips: ['Click "New chat" to start fresh — Navy keeps a summary of your project in memory.',
             'Attach fewer/smaller files, or switch to a model with a larger context window.'],
    };
  }
  if (has(/model[_ ]not[_ ]found|does not exist|unknown model|invalid model|no such model|not found.*model/i)) {
    return {
      kind: 'model_not_found',
      title: `${providerLabel}: the selected model isn't available on your account`,
      tips: ['Open the model dropdown and pick a model from the live list.',
             'If you typed a custom model name, check its exact spelling.'],
    };
  }
  if (has(/thinking\.type\.enabled|thinking\.type\.adaptive|output_config\.effort|`?temperature`?\s+is deprecated/i)) {
    return {
      kind: 'thinking_shape',
      title: `${providerLabel}: this model uses a newer thinking/temperature API shape`,
      tips: ['Navy already retries automatically with the newer request shape — try sending again.',
             'If this keeps happening, the model may need a newer Navy version.'],
    };
  }
  if (has(/thought_signature/i)) {
    return {
      kind: 'thought_signature',
      title: `${providerLabel}: this Gemini thinking model needs Google's native API for tools`,
      tips: ['Pick a non-thinking Gemini model (e.g. gemini-2.0-flash) from the dropdown.',
             'Or use Anthropic/OpenAI/Ollama for multi-step tool tasks.'],
    };
  }
  if (has(/\b(500|502|503|529|overloaded|internal server error|bad gateway|service unavailable)\b/i)) {
    return {
      kind: 'server_error',
      title: `${providerLabel}: the provider is having a temporary problem`,
      tips: ['Navy already retried automatically. Wait a moment and send again.',
             'Check the provider\'s status page if it persists.'],
    };
  }
  if (has(/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|socket hang up/i)) {
    return {
      kind: 'network',
      title: `${providerLabel}: can't reach the server`,
      tips: [providerLabel === 'Ollama'
               ? 'Is Ollama running? Start it with "ollama serve".'
               : 'Check your internet connection and the API Base URL in Settings.'],
    };
  }
  return null;
}

// Whether a failure is worth retrying on a DIFFERENT configured provider
// (see navy.providerFallbacks) — deliberately a narrow allow-list, not
// "everything except a denylist": rate limits, server outages, and network
// errors are unambiguously "this provider, right now" problems a different
// account is likely unaffected by. Auth/quota/context-length/model-not-found
// are excluded on purpose — those often reflect something the USER should
// fix (a bad key, a plan limit, a conversation that's grown too large)
// rather than a transient fault worth silently paying a different account to
// route around. An unclassified error (kind === null) is also NOT
// fallback-worthy — better to surface an unfamiliar failure plainly than to
// guess it's safe to retry elsewhere.
function isTransientProviderError(rawMessage) {
  const cls = classifyProviderError('', rawMessage);
  return Boolean(cls && (cls.kind === 'rate_limit' || cls.kind === 'server_error' || cls.kind === 'network'));
}

// One-call formatter used by the chat: friendly explanation + redacted raw tail.
function formatProviderError(providerLabel, rawMessage) {
  const cls = classifyProviderError(providerLabel, rawMessage);
  const raw = redactError(rawMessage).slice(0, 400);
  if (!cls) return `${providerLabel} error — ${raw}`;
  return `${cls.title}\n\nWhat you can do:\n${cls.tips.map(t => '• ' + t).join('\n')}\n\nDetails: ${raw}`;
}

module.exports = { classifyProviderError, redactError, formatProviderError, isTransientProviderError };
