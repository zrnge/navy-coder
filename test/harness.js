// Shared test harness: the assertion counter, the source-extraction helper,
// the vscode mock lifecycle, and the fetch fakes that stand in for a model.
//
// Split out of test/run.js, which had grown to 495KB and 54 suites in one
// file — the same problem as src/extension.js, one layer down. Everything
// here moved verbatim; the counter lives in this module now, so `check` and
// `report` are the only things that may touch it.

// Navy Coder test suite — run with `npm test`.
// No framework: each section asserts and pushes failures; exit 1 if any fail.
//
// Pure functions (literalReplace, _compactMessages, renderInline) are extracted
// from the real source files by pattern so tests can never drift from shipped code.
// The webview suite drives media/main.js inside jsdom with real extension messages.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Redirect the global project catalog into a throwaway directory for the whole
// run. Several suites reach _recordProjectUsage indirectly through
// _activateProjectRoot, on providers that never set the per-instance override —
// so the test temp paths were being written into the developer's real
// ~/.navy/projects.json. Tests must not mutate the user's own data.
process.env.NAVY_HOME = fs.mkdtempSync(path.join(require('os').tmpdir(), 'navy-testhome-'));
process.on('exit', () => { try { fs.rmSync(process.env.NAVY_HOME, { recursive: true, force: true }); } catch {} });

const failures = [];
let passed = 0;

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failures.push(name); console.error('  FAIL', name, detail !== undefined ? '— ' + detail : ''); }
}

function extractFunction(source, header) {
  // Matches `header` up to the function's closing brace at the same indent level.
  // Naive brace counting — fine for functions whose brace-char-literals balance;
  // functions that don't (e.g. stripToolCallJson) are tested via the jsdom window.
  const start = source.indexOf(header);
  if (start === -1) throw new Error('cannot find: ' + header);
  let depth = 0, i = source.indexOf('{', start);
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') {
      depth--;
      if (depth === 0) {
        const body = source.slice(start, j + 1);
        // A brace inside a string OR a comment counts here just as much as a
        // real one, so an unbalanced one ends the function early and the caller
        // gets "Unexpected end of input" from eval — an error that says nothing
        // about where it came from. Check it here and name the actual cause.
        // Callers extract both plain functions and class methods, and a method
        // is not a valid expression on its own — it has to be read back inside
        // an object literal. Only when NEITHER shape parses is the extraction
        // genuinely broken.
        let parseError = null;
        try {
          new Function('return ' + body);
        } catch (e1) {
          try {
            new Function('return ({ ' + body + ' })');
          } catch { parseError = e1; }
        }
        try {
          if (parseError) throw parseError;
        } catch (e) {
          throw new Error(
            `extractFunction stopped early on "${header}" — a lone { or } inside a `
            + `string or comment throws off the brace count. Write it as an escape `
            + `(\\u007B / \\u007D) or keep the braces balanced. Parser said: ${e.message}`);
        }
        return body;
      }
    }
  }
  throw new Error('unbalanced braces for: ' + header);
}

const extSrc  = fs.readFileSync(path.join(ROOT, 'src', 'extension.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'media', 'main.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'webview-html.js'), 'utf8');

const { createVscodeMock, installVscodeMock, uninstallVscodeMock, makeContext } = require('./vscode-mock.js');
let _shared = null;

function sharedMock() {
  if (!_shared) { _shared = createVscodeMock(); installVscodeMock(_shared.vscode); }
  _shared.ctrl.reset();
  return _shared;
}

// ── 7b. Hallucination guard — full askNavy loop against a fake Ollama stream ─
// Proves the real regression end-to-end: a model that narrates a completed file
// action WITHOUT calling a tool must not have that claim trusted silently.
function encodeOllamaEvent(evt) {
  return new TextEncoder().encode(JSON.stringify(evt) + '\n');
}

function makeOneShotBody(evt) {
  let served = false;
  return {
    getReader() {
      return {
        async read() {
          if (served) return { done: true, value: undefined };
          served = true;
          return { done: false, value: encodeOllamaEvent(evt) };
        },
      };
    },
  };
}

// replies: array of { text } | { toolCalls: [{name, args}] } | { fail: { status, text } }
// consumed in order. `fail` simulates a non-ok HTTP response (rate limit,
// server outage, etc.) — streamAssistant's Ollama branch throws
// 'Ollama returned <status>: <text>' for it, same as a real failure would.
// `captured`, if given, collects each parsed request body for inspection.
function queueOllamaFetch(replies, captured) {
  const queue = replies.slice();
  return async (url, init) => {
    if (captured && init?.body) { try { captured.push(JSON.parse(init.body)); } catch {} }
    const next = queue.shift();
    if (!next) throw new Error('queueOllamaFetch: exhausted — loop ran more iterations than the test expected');
    if (next.fail) {
      return { ok: false, status: next.fail.status, body: true, text: async () => next.fail.text || '', headers: { get: () => null } };
    }
    const evt = next.toolCalls
      ? { message: { role: 'assistant', content: '', tool_calls: next.toolCalls.map(tc => ({ function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } })) }, done: true, prompt_eval_count: 5, eval_count: 5 }
      : { message: { role: 'assistant', content: next.text }, done: true, prompt_eval_count: 5, eval_count: 5 };
    return { ok: true, status: 200, body: makeOneShotBody(evt), text: async () => '' };
  };
}

// ── 7c. Anthropic caching safety fallback — proves it actually engages ──────
// Live Anthropic API access isn't available in this environment, so this test
// simulates the one failure mode that matters: a 400 that specifically blames
// cache_control. Navy must retry once WITHOUT caching rather than fail the turn.
function encodeAnthropicSSE(lines) {
  return new TextEncoder().encode(lines.map(l => 'data: ' + JSON.stringify(l) + '\n').join('') + '\n');
}

function makeAnthropicSuccessBody() {
  const evt = encodeAnthropicSSE([
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', usage: { output_tokens: 2 } },
  ]);
  let served = false;
  return { getReader: () => ({ async read() { if (served) return { done: true }; served = true; return { done: false, value: evt }; } }) };
}

// ── 7d. Native Gemini provider — routing, round-trip, cross-provider safety ──
function encodeGeminiSSE(events) {
  return new TextEncoder().encode(events.map(e => 'data: ' + JSON.stringify(e) + '\n').join(''));
}

function makeGeminiBody(events) {
  const buf = encodeGeminiSSE(events);
  let served = false;
  return { getReader: () => ({ async read() { if (served) return { done: true }; served = true; return { done: false, value: buf }; } }) };
}

// The tally, and the exit code that goes with it. Owned here because the
// counters are: a suite file that kept its own would report a subset.
function report() {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

module.exports = {
  fs, path, ROOT, check, report, extractFunction,
  extSrc, mainSrc, htmlSrc,
  createVscodeMock, installVscodeMock, uninstallVscodeMock, makeContext, sharedMock,
  encodeOllamaEvent, makeOneShotBody, queueOllamaFetch,
  encodeAnthropicSSE, makeAnthropicSuccessBody, encodeGeminiSSE, makeGeminiBody,
};
