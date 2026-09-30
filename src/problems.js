'use strict';

// VS Code's Problems panel, as something the model can read.
//
// get_diagnostics read one file - the one named, or the active editor. The
// Problems panel is the whole workspace, and it is where a person looks first
// for what is broken, so the model can now read all of it: every error and
// warning, grouped by file, worst first.
//
// The panel has a blind spot, and the output says so every time: it lists only
// what a language extension has analysed. For JavaScript and TypeScript, ESLint
// and Python that is normally the files open in an editor, so a project with
// nothing open shows "No problems have been detected in the workspace" whatever
// is in it. A short list is not a clean bill of health.
//
// Opening the files in the background does not fill it in: tried against a
// real VS Code, TypeScript reported nothing for documents that were opened but
// not shown - not a type error, not a syntax error - after 20 seconds. What
// covers a whole project is the project's own checker (tsc --noEmit, npm run
// lint, ruff ...), and that runs through run_command on purpose: a lint script
// is the project's code executing, so it stays behind the command-approval
// gate instead of hiding inside a read-only tool.

const path = require('path');

const SEVERITY = ['Error', 'Warning', 'Info', 'Hint'];

const MAX_PER_FILE = 25;
const MAX_LINES = 300;

const COVERAGE_NOTE = 'The Problems panel lists only what a language extension has analysed - for JavaScript/TypeScript, ESLint and Python that is normally the files open in an editor. '
  + 'Few or no problems here is not proof the rest is clean: for the whole project, run its own checker with run_command '
  + '(see package.json scripts, tsconfig.json, pyproject.toml - e.g. npx tsc --noEmit, npm run lint, ruff check, cargo check).';

// "(ts 2304)", "(eslint no-unused-vars)". A code can be a string, a number, or
// { value, target } when the rule links to its documentation.
function sourceTag(d) {
  const code = d && d.code != null ? (typeof d.code === 'object' ? d.code.value : d.code) : '';
  const bits = [d && d.source, code].filter(v => v !== undefined && v !== null && String(v) !== '');
  return bits.length ? ` (${bits.join(' ')})` : '';
}

function describe(d) {
  const sev = SEVERITY[d.severity] || '?';
  const line = (d.range && d.range.start ? d.range.start.line : 0) + 1;
  const col = (d.range && d.range.start ? d.range.start.character : 0) + 1;
  // One line per problem: a multi-line message (a type mismatch spelled out)
  // keeps its first line, which is the part that says what is wrong.
  const message = String(d.message || '').split(/\r?\n/)[0].trim().slice(0, 300);
  return `[${sev}] ${line}:${col} ${message}${sourceTag(d)}`;
}

// severity: 'error' = errors only, 'warning' = errors and warnings, 'all' = everything.
function wanted(severity, filter) {
  if (filter === 'error') return severity === 0;
  if (filter === 'all') return true;
  return severity <= 1;
}

function relPath(file, root) {
  if (!root) return file;
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// entries: what vscode.languages.getDiagnostics() returns with no argument -
// [uri, diagnostics[]] pairs. Only files inside `root` (and under `folder`,
// when given) are reported; the rest - user settings, other projects - are
// counted and left out.
function formatProblems(entries, { root = '', folder = '', severity = 'warning', lead = '' } = {}) {
  const filter = ['error', 'warning', 'all'].includes(severity) ? severity : 'warning';
  const prefix = folder ? String(folder).split(/[\\/]+/).filter(Boolean).join('/') + '/' : '';
  const files = [];
  let outside = 0;
  let filteredOut = 0;
  for (const [uri, diags] of entries || []) {
    if (!uri || (uri.scheme && uri.scheme !== 'file') || !Array.isArray(diags) || !diags.length) continue;
    const rel = relPath(uri.fsPath, root);
    if (rel === null) { outside += diags.length; continue; }
    if (prefix && !(rel + '/').startsWith(prefix) && !rel.startsWith(prefix)) continue;
    const keep = diags.filter(d => wanted(d.severity, filter));
    filteredOut += diags.length - keep.length;
    if (!keep.length) continue;
    keep.sort((a, b) => (a.severity - b.severity)
      || ((a.range && a.range.start ? a.range.start.line : 0) - (b.range && b.range.start ? b.range.start.line : 0)));
    const errors = keep.filter(d => d.severity === 0).length;
    const warnings = keep.filter(d => d.severity === 1).length;
    files.push({ rel, keep, errors, warnings });
  }
  // Worst file first: the most errors, then the most warnings.
  files.sort((a, b) => (b.errors - a.errors) || (b.warnings - a.warnings) || a.rel.localeCompare(b.rel));

  const errors = files.reduce((n, f) => n + f.errors, 0);
  const warnings = files.reduce((n, f) => n + f.warnings, 0);
  const other = files.reduce((n, f) => n + f.keep.length - f.errors - f.warnings, 0);
  const where = prefix ? ` under ${prefix}` : '';
  const kinds = filter === 'error' ? 'errors' : filter === 'all' ? 'problems' : 'errors or warnings';
  const out = [];
  if (lead) out.push(lead);

  if (!files.length) {
    out.push(`The Problems panel has no ${kinds}${where}.`);
  } else {
    const counts = [plural(errors, 'error'), plural(warnings, 'warning')];
    if (other) counts.push(`${other} info/hint`);
    out.push(`Problems panel: ${counts.join(', ')} in ${plural(files.length, 'file')}${where}.`);
  }
  const left = [];
  if (filteredOut) left.push(`${filteredOut} of lower severity (pass severity: "all" to see them)`);
  if (outside) left.push(`${outside} in files outside this project`);
  if (left.length) out.push(`Left out: ${left.join('; ')}.`);
  out.push(COVERAGE_NOTE);

  let lines = 0;
  let shownFiles = 0;
  for (const f of files) {
    if (lines >= MAX_LINES) break;
    shownFiles++;
    const head = [f.errors ? plural(f.errors, 'error') : '', f.warnings ? plural(f.warnings, 'warning') : '']
      .filter(Boolean).join(', ') || plural(f.keep.length, 'note');
    out.push('', `${f.rel} — ${head}`);
    const shown = f.keep.slice(0, Math.min(MAX_PER_FILE, MAX_LINES - lines));
    for (const d of shown) out.push('  ' + describe(d));
    lines += shown.length;
    if (f.keep.length > shown.length) out.push(`  … ${f.keep.length - shown.length} more in this file`);
  }
  if (shownFiles < files.length) out.push('', `… and ${plural(files.length - shownFiles, 'more file')} - narrow it with path (a folder) or severity: "error".`);
  return out.join('\n');
}

module.exports = { formatProblems, describe, sourceTag, MAX_PER_FILE, MAX_LINES, COVERAGE_NOTE };
