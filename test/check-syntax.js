// Parses every JavaScript file the extension ships or tests with.
//
// `npm run check` used to be `node --check src/extension.js` — one file out of
// roughly twenty-five. That is thinner cover than it looks: `node --check` only
// parses, it does not follow `require`, so none of the modules extension.js
// pulls in were ever checked, and neither was media/main.js, which is shipped
// raw rather than bundled. A syntax error there ships a webview that does
// nothing at all, and the old check passed on it.
//
// It found one immediately: a backtick inside an HTML comment in
// src/webview-html.js, which closed the template literal the whole document is
// built from. The file is one big template, so any stray backtick does this.
//
// No globbing in package.json on purpose — shell glob behaviour differs between
// the Windows and Linux CI runners, and this has to hold on both.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src', 'media', 'test', 'eval', 'tools'];
const SKIP = new Set(['node_modules', 'dist', '.git', '.vscode-test', 'fixture']);

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = DIRS.flatMap(d => walk(path.join(ROOT, d)));
const failures = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  try {
    // `new vm.Script` parses without running, which is what `node --check` does
    // — and unlike require(), it cannot execute a side effect by accident.
    new vm.Script(source, { filename: file });
  } catch (err) {
    failures.push({ file: path.relative(ROOT, file), message: err.message });
  }
}


// U+FFFD, the Unicode replacement character, is what is left behind when bytes
// fail to decode as UTF-8. It is never something anyone types on purpose in
// source: finding one means a file has been through a lossy encoding round-trip
// and a real character was destroyed.
//
// One reached the shipped webview. The file chip's remove button was assigned a
// literal U+FFFD instead of the U+2715 its three sibling buttons use, so it drew
// as a missing-glyph box next to controls that rendered correctly — which reads
// as "this app cannot do Unicode" rather than "one character was corrupted".
//
// Prose is allowed to mention it (the CHANGELOG describes a fix for exactly this
// class of bug, and a test is named after it), so only code files are checked.
{
  const CODE = ['src', 'media'];
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (!CODE.includes(rel.split('/')[0])) continue;
    const src = fs.readFileSync(file, 'utf8');
    const at = src.indexOf('\ufffd');
    if (at !== -1) {
      const line = src.slice(0, at).split('\n').length;
      failures.push({
        file: rel,
        message: `line ${line}: U+FFFD replacement character in source — a real `
          + `character was lost to a bad encoding round-trip here.`,
      });
    }
  }
}

// src/webview-html.js is one enormous template literal, so a backtick typed
// inside it — most easily inside an HTML comment, where it looks like ordinary
// prose markup — closes the template and turns the rest of the document into
// broken JavaScript. It has happened three times. The parse above catches it,
// but the message ("Unexpected identifier") points at the word after the
// backtick rather than at the backtick, so this says what actually went wrong.
{
  const file = path.join(ROOT, 'src', 'webview-html.js');
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  // The template opens on the `return \`` line and closes on the final one; any
  // backtick between those is a terminator unless it is escaped.
  const open = lines.findIndex(l => l.includes('return `'));
  const close = lines.length - 1 - [...lines].reverse().findIndex(l => l.trim().endsWith('`;'));
  for (let i = open + 1; i < close; i++) {
    const stray = lines[i].replace(/\\`/g, '').includes('`');
    if (stray) {
      failures.push({
        file: 'src/webview-html.js',
        message: `line ${i + 1}: backtick inside the HTML template literal — it closes the `
          + `template. Use straight quotes in comments.\n        ${lines[i].trim().slice(0, 80)}`,
      });
    }
  }
}

for (const f of failures) console.error(`  FAIL ${f.file}\n        ${f.message}`);
console.log(`${files.length - failures.length} of ${files.length} files parse`);
if (failures.length) process.exit(1);
