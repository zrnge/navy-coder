// Runs the markdown renderer against inputs that once hung it forever.
//
// This lives in its own process on purpose. The bug it guards against is an
// infinite loop, not a slow path — asserting on it in-process would hang the
// whole test run instead of failing it, which is exactly how it survived so
// long. The parent spawns this with a timeout and treats a timeout as failure.
//
// Prints one JSON object on stdout.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'webview-html.js'), 'utf8');
const body = htmlSrc.match(/<body>([\s\S]*?)<\/body>/)[1]
  .replace(/\$\{[^}]*\}/g, '').replace(/<script[\s\S]*?<\/script>/g, '');

const dom = new JSDOM(`<!DOCTYPE html><html><body>${body}</body></html>`,
  { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => ({}), setState: () => {} });
window.HTMLElement.prototype.scrollIntoView = function () {};
const realLog = console.log;
console.log = () => {};                 // main.js announces itself on load
window.eval(fs.readFileSync(path.join(ROOT, 'media', 'main.js'), 'utf8'));
console.log = realLog;

const result = {};

// A streaming render can fire at ANY prefix of the reply, so every prefix of a
// realistic review answer — tables, code, nested lists, blockquotes, stray
// pipes — has to terminate.
const DOC = [
  '## Code review', '',
  'Summary first:', '',
  '| File | Line | Severity | Issue |',
  '|------|-----:|:--------:|-------|',
  '| `src/a.js` | 42 | high | unbounded loop |',
  '| `src/b.js` | 118 | low | dead code |', '',
  '### 1. Unbounded loop', '',
  'The `while` never advances:', '',
  '```js', 'while (i < n) {', '  if (c) { i++; continue; }', '}', '```', '',
  '- **Impact:** renderer stops',
  '  - nested detail',
  '- **Fix:** always consume a line', '',
  '> A blockquote note.', '',
  'Ratios like a | b and lone pipes | happen too.',
].join('\n');

const t0 = Date.now();
for (let n = 1; n <= DOC.length; n++) window.renderMarkdown(DOC.slice(0, n));
result.prefixes = DOC.length;
result.prefixMs = Date.now() - t0;

// The specific shapes that hung, each isolated.
const CASES = {
  // The one that actually bit: a table header is the last line for as long as
  // it takes the separator row to stream in.
  tableHeaderLast: 'Findings:\n\n| File | Issue |',
  // Text line whose successor looks like a separator row — the table branch
  // needs a pipe in the FIRST line, so neither branch claimed it.
  separatorAfterText: 'Summary:\n|---|---|\n| a | b |',
  // A pipe-prefixed line that is not a table at all.
  pipeLineThenProse: '| not really a table\njust some prose',
  // At the size reported in the field.
  bigTableHeaderLast: 'Findings:\n\n' + 'x'.repeat(14000) + '\n\n| File | Issue |',
};
result.cases = {};
for (const [name, input] of Object.entries(CASES)) {
  const s = Date.now();
  window.renderMarkdown(input);
  result.cases[name] = Date.now() - s;
}

// Fixing the hang must not have broken real rendering.
const html = window.renderMarkdown(DOC);
result.render = {
  table: html.includes('<table>') && html.includes('<th>File</th>'),
  rows: (html.match(/<tr>/g) || []).length >= 3,
  code: html.includes('<pre') || html.includes('<code'),
  headings: html.includes('<h2>') && html.includes('<h3>'),
  nestedList: (html.match(/<ul>/g) || []).length >= 2,
  blockquote: html.includes('<blockquote>'),
  // The un-tabled pipe line must still appear rather than being swallowed.
  strayPipes: html.includes('lone pipes'),
};
// A lone table header renders as text, not as nothing — it comes back as a
// real table on the next tick once its separator row arrives.
result.render.headerAsText = window.renderMarkdown('| File | Issue |').includes('File');

realLog(JSON.stringify(result));
dom.window.close();
process.exit(0);
