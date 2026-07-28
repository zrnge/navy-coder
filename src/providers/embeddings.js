// Embeddings for semantic codebase search — entirely opt-in via navy.embeddingModel.
// Ollama gets its own native endpoint (embedding models aren't served through
// /api/chat); everything else routes through the same OpenAI-compatible
// /embeddings endpoint openAiCompatBase already resolves for chat, including
// Gemini (whose OpenAI-compat facade covers embeddings too, not just chat).
// A provider that doesn't actually support embeddings under that facade
// (Groq, xAI, …) just fails the fetch — callers must treat that as "semantic
// search unavailable" and fall back to keyword search, never as a hard error.

const { openAiCompatBase } = require('./endpoints.js');

// texts → vectors, same order as input. Throws on any failure; callers decide
// the fallback (this module never silently returns wrong/partial data).
async function getEmbeddings(provider, model, texts, { apiBase, host, apiKey, signal } = {}) {
  if (!texts.length) return [];

  if (provider === 'ollama') {
    const base = (host || 'http://localhost:11434').replace(/\/$/, '');
    const res = await fetch(base + '/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal,
    });
    if (!res.ok) throw new Error('Ollama embeddings ' + res.status + ': ' + (await res.text()).slice(0, 300));
    const data = await res.json();
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length
        || !data.embeddings.every(v => Array.isArray(v) && v.length)) {
      throw new Error('Ollama embeddings: unexpected response shape');
    }
    return data.embeddings;
  }

  const base = openAiCompatBase(provider, apiBase, host);
  if (!base) throw new Error(`Provider "${provider}" has no known embeddings endpoint.`);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  const res = await fetch(base + '/embeddings', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, input: texts }),
    signal,
  });
  if (!res.ok) throw new Error(provider + ' embeddings ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  if (!Array.isArray(data.data) || data.data.length !== texts.length) {
    throw new Error(provider + ' embeddings: unexpected response shape');
  }
  // OpenAI-shaped responses are ordered by `index`, but sort defensively —
  // relying on implicit array order alone has bitten other providers before.
  const vectors = data.data.slice().sort((a, b) => (a.index || 0) - (b.index || 0)).map(it => it && it.embedding);
  // Count matching isn't enough: an item can arrive without `.embedding`. Let
  // that through and the caller caches `undefined` as a file's vector, which
  // then throws on every later similarity comparison.
  if (!vectors.every(v => Array.isArray(v) && v.length)) {
    throw new Error(provider + ' embeddings: response contained an item with no usable embedding');
  }
  return vectors;
}

function cosineSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = { getEmbeddings, cosineSimilarity };
