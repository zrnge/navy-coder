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
    zai:        'https://api.z.ai/v1',
    groq:       'https://api.groq.com/openai/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    custom:     host,
  };
  if (!(provider in DEFAULTS)) return null;
  return apiBase || DEFAULTS[provider];
}

module.exports = { openAiCompatBase };
