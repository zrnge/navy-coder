// Liveness check for every shipped provider default. NOT part of `npm test` —
// it makes real network calls, so it runs on a schedule (see
// .github/workflows/provider-endpoints.yml) rather than on every push.
//
// Why it exists: three providers shipped with base URLs that had never worked
// for anyone. z.ai's pointed at a path that returns a bare nginx 404; MiniMax's
// pointed at a live host of the right vendor that rejects current keys. The
// unit suite pins those URLs as strings, which catches an accidental edit but
// can say nothing about whether the URL still serves an API. Only a request
// can, and no key is needed to ask: a healthy endpoint answers an
// unauthenticated /models with 401/403, i.e. "who are you", which proves both
// that the host is right and that the path is the API root.
//
// A 404, a DNS failure or an HTML body means the default is broken and every
// user of that provider is dead in the water.
//
// The probe sends a deliberately invalid key rather than no key at all. Two
// reasons, both found the first time this ran: Google answers an
// UNauthenticated request to its OpenAI-compatible path with 404 and an
// authenticated one with 400 "Please pass a valid API key", so a keyless probe
// reported a healthy endpoint as dead; and asking with a key exercises the
// same auth path a real request takes instead of a route that only exists for
// anonymous callers. The key is obviously fake, so nothing is at risk.

const { openAiCompatBase, providerDisplayName, OLLAMA_CLOUD_HOST } = require('../src/providers/endpoints.js');

// Local/user-supplied endpoints are deliberately absent: lmstudio and ollama
// point at localhost, and custom is whatever the user typed.
const PROVIDERS = ['openai', 'deepseek', 'gemini', 'xai', 'zai', 'groq', 'openrouter',
                   'moonshot', 'qwen', 'minimax', 'mimo'];

// Not OpenAI-compatible, so they don't come from openAiCompatBase — checked
// here anyway because they are just as capable of moving.
const EXTRA = [
  ['anthropic', 'https://api.anthropic.com/v1/models'],
  ['ollama-cloud', (OLLAMA_CLOUD_HOST || 'https://ollama.com') + '/api/tags'],
];

// api.openai.com answered in 21.3s from a European connection on the first run.
// A timeout has to be long enough that slow-but-alive never reads as dead —
// a false DEAD here sends someone hunting a bug that isn't there.
const TIMEOUT_MS = 45000;
const FAKE_KEY = 'navy-endpoint-liveness-probe-not-a-real-key';

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + FAKE_KEY,
        // Anthropic reads its key from x-api-key and 400s without a version.
        'x-api-key': FAKE_KEY,
        'anthropic-version': '2023-06-01',
      },
    });
    const body = (await res.text()).slice(0, 400);
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Healthy means "this is an API root that wants credentials". Anything that
// looks like a web page or a missing route is a broken default.
function verdict({ status, body }) {
  if (status === 401 || status === 403) return { ok: true, why: 'rejected the key — API root is live' };
  // Google returns 400 with this wording rather than 401. Matched on the body
  // so a genuine malformed-request 400 is not waved through as healthy.
  if (status === 400 && /api[ _-]?key|credential|authoriz/i.test(body)) {
    return { ok: true, why: 'rejected the key (400 shape) — API root is live' };
  }
  // A few gateways serve /models to anyone. Fine — as long as it is JSON.
  if (status === 200 && !/^\s*</.test(body)) return { ok: true, why: 'served the list without auth' };
  if (status === 200) return { ok: false, why: 'returned a web page, not an API' };
  if (status === 404) return { ok: false, why: 'no such route — base URL is wrong' };
  if (status === 0) return { ok: false, why: 'unreachable: ' + body };
  if (status === 429 || status >= 500) return { ok: true, why: `transient ${status}, host is alive` };
  return { ok: false, why: `unexpected HTTP ${status}` };
}

(async () => {
  const targets = [
    ...PROVIDERS.map(p => [p, openAiCompatBase(p, '', '').replace(/\/$/, '') + '/models']),
    ...EXTRA,
  ];

  const results = await Promise.all(targets.map(async ([id, url]) => {
    const v = verdict(await probe(url));
    return { id, url, ...v };
  }));

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    const name = (providerDisplayName(r.id) || r.id).padEnd(18);
    console.log(`${r.ok ? 'OK  ' : 'DEAD'}  ${name} ${r.url}\n        ${r.why}`);
  }

  console.log(`\n${results.length - failed}/${results.length} provider endpoints healthy`);
  if (failed) {
    console.log('\nA DEAD endpoint means users of that provider cannot connect at all.');
    console.log('Fix the default in src/providers/endpoints.js, and check whether the');
    console.log('vendor has moved to a new host or split it by region.');
  }
  process.exit(failed ? 1 : 0);
})();
