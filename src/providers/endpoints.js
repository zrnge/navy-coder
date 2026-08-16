// Single source of truth for OpenAI-compatible provider endpoints.
// Previously duplicated in llm.js and the inline-completion provider — a change
// to one URL had to be made twice (and could silently diverge).
//
// apiBase (user override) always wins. `host` is the fallback for 'custom'
// (self-hosted servers configured via navy.host). Returns null for providers
// that are not OpenAI-compatible (ollama native, anthropic).
function openAiCompatBase(provider, apiBase, host) {
  const DEFAULTS = {
    openai:     'https://api.openai.com/v1',
    lmstudio:   'http://localhost:1234/v1',
    deepseek:   'https://api.deepseek.com/v1',
    gemini:     'https://generativelanguage.googleapis.com/v1beta/openai',
    xai:        'https://api.x.ai/v1',
    // z.ai does NOT serve /v1 — api.z.ai/v1/models is a bare nginx 404, which is
    // why the model list came back empty and no amount of re-pasting the key
    // helped. The OpenAI-compatible surface lives under the PaaS v4 path.
    // (api.z.ai/api/coding/paas/v4 is the same API for GLM Coding Plan
    // subscriptions, and api.z.ai/api/anthropic is its Anthropic-shaped one.)
    zai:        'https://api.z.ai/api/paas/v4',
    groq:       'https://api.groq.com/openai/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    // Each verified live against /v1/models: all four answer with an
    // OpenAI-shaped 401 when no key is supplied, which is what makes them safe
    // to route through the shared OpenAI-compatible path rather than needing
    // their own transport.
    //
    // Moonshot (Kimi), Alibaba (Qwen) and MiniMax each run separate
    // mainland-China and international endpoints, and a key issued for one
    // region is rejected by the other with a plain "invalid api key" — which
    // reads exactly like a bad key rather than a wrong host. The international
    // endpoint is the default; navy.apiBase switches regions, and the setting
    // descriptions name both URLs so the failure is diagnosable.
    //
    // MiniMax specifically: api.minimaxi.com and api.minimax.io are BOTH live
    // and both answer /v1/models, but current international keys authenticate
    // only against api.minimax.io. minimaxi.com was the earlier international
    // domain and now rejects them, so it is not a safe default.
    moonshot:   'https://api.moonshot.ai/v1',
    qwen:       'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    minimax:    'https://api.minimax.io/v1',
    mimo:       'https://api.xiaomimimo.com/v1',
    custom:     host,
  };
  if (!(provider in DEFAULTS)) return null;
  return apiBase || DEFAULTS[provider];
}

// Ollama Cloud speaks the SAME native API as a local install — /api/tags,
// /api/chat, /api/show, /api/embed, /api/generate all exist at this host — so
// cloud support is a host swap plus a bearer token, not a separate provider.
// Verified directly: GET /api/tags returns the usual model list, and POST
// /api/chat without a key returns 401 {"error":"Unauthorized"}.
const OLLAMA_CLOUD_HOST = 'https://ollama.com';

// The Ollama base URL to use. `mode` is navy.ollamaMode ('local' | 'cloud').
// Cloud ignores navy.host entirely — that setting describes a machine-local
// server, and silently honouring it would send an API key somewhere the user
// did not intend.
function ollamaHost(mode, host) {
  if (mode === 'cloud') return OLLAMA_CLOUD_HOST;
  return String(host || 'http://localhost:11434').replace(/\/$/, '');
}

// Auth headers for an Ollama request. Sent whenever a key exists, regardless of
// mode: a local server ignores an Authorization header, so there is no branch
// to get wrong, and a user pointing navy.host at their own authenticated proxy
// gets it for free.
function ollamaAuthHeaders(apiKey) {
  return apiKey ? { Authorization: 'Bearer ' + apiKey } : {};
}

// Human-readable name for a provider id — single source of truth so error
// messages read the same everywhere ("OpenAI", not the raw setting value
// "openai"). Falls back to the id itself for anything unrecognized (a custom
// or future provider), so this never needs updating just to avoid a blank.
const PROVIDER_NAMES = {
  ollama: 'Ollama', lmstudio: 'LM Studio', anthropic: 'Anthropic', openai: 'OpenAI',
  deepseek: 'DeepSeek', gemini: 'Gemini', xai: 'xAI', zai: 'z.ai', groq: 'Groq',
  openrouter: 'OpenRouter', moonshot: 'Moonshot (Kimi)', qwen: 'Qwen',
  minimax: 'MiniMax', mimo: 'Xiaomi MiMo', custom: 'Custom endpoint',
};
function providerDisplayName(id) {
  return PROVIDER_NAMES[id] || id;
}

module.exports = { openAiCompatBase, providerDisplayName, ollamaHost, ollamaAuthHeaders, OLLAMA_CLOUD_HOST };
