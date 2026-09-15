'use strict';

// The conversation as Markdown: what was said, and what each turn did.
//
// Built from the saved chat rather than scraped from the panel, which only
// ever holds part of a long chat (see _exportMarkdown in extension.js). Under
// each of Navy's replies it adds the tool calls that turn made, with the output
// the transcript showed, and a diff of every file the turn changed.
//
// None of it is new record-keeping. The tool calls are the cards each reply
// already keeps so a reopened chat can redraw them (makeCardRecord in
// extension.js), and the diffs come from the undo checkpoints, which hold every
// file as it was before each change. A turn's diff is that text against the
// file as it stood just before its next change, or against the file on disk
// for the most recent one. Where undo history no longer reaches back that far,
// the export says so rather than quietly leaving the diff out.

const path = require('path');
const crypto = require('crypto');
const { unifiedDiff, splitLines } = require('./text-diff.js');

const EXPORT_DIFF_MAX_LINES = 400;          // per file; the +/- counts always cover the whole change
const EXPORT_DIFF_MAX_FILE_LINES = 20000;   // on either side; a bigger file is named, not diffed
const NUL = String.fromCharCode(0);

// A code fence longer than any run of backticks in the text, so tool output
// that itself contains ``` cannot close the block early.
function fence(text, info = '') {
  const longest = (String(text).match(/`+/g) || []).reduce((n, run) => Math.max(n, run.length), 0);
  const f = '`'.repeat(Math.max(3, longest + 1));
  return f + info + '\n' + text + '\n' + f;
}

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

// Relative to the project, with forward slashes, the way a reader expects.
function relPath(p, root) {
  if (!p) return '?';
  if (root) {
    const r = path.relative(root, p);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/');
  }
  return p;
}

const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';

// The turn's tool calls, folded away so the conversation stays readable.
function toolsSection(cards) {
  // Tool calls only. The diff, approval and reasoning cards a turn also keeps
  // (src/transcript-cards.js) are covered by the diffs below, or are the
  // model's working rather than something it did.
  const calls = Array.isArray(cards) ? cards.filter(c => c && c.tool) : [];
  if (!calls.length) return [];
  const out = ['<details>', `<summary>${calls.length} tool call${calls.length === 1 ? '' : 's'}</summary>`, ''];
  for (const c of calls) {
    const args = Object.entries(c.args || {}).map(([k, v]) => `${k}: ${code(v)}`).join(' · ');
    out.push(`**${code(c.tool)}**${args ? ' ' + args : ''}`, '');
    const result = typeof c.result === 'string' ? c.result.replace(/\s+$/, '') : '';
    if (result) {
      out.push(fence(result), '');
      if (c.full && c.full.chars) {
        out.push(`_Output cut to its first ${c.result.length.toLocaleString('en-US')} of ${c.full.chars.toLocaleString('en-US')} characters: the saved chat keeps an excerpt of each tool's output, not all of it._`, '');
      }
    }
  }
  out.push('</details>', '');
  return out;
}

// One file's change within one turn. `mine` holds the turn's checkpoints for
// the file, oldest first; the first has the file as it was before the turn.
async function fileDiff(file, mine, checkpoints, root, read) {
  const name = code(relPath(file, root));
  const first = checkpoints[mine[0]];
  const last = checkpoints[mine[mine.length - 1]];
  const lastIdx = mine[mine.length - 1];
  const before = typeof first.originalText === 'string' ? first.originalText : '';
  let after;
  if (last.kind === 'delete') {
    after = '';
  } else {
    const next = checkpoints.find((c, j) => j > lastIdx && c && c.kind !== 'rename' && c.filePath === file);
    if (next) {
      after = typeof next.originalText === 'string' ? next.originalText : '';
    } else {
      // Renamed since? Then its current text lives under the new name.
      const moved = checkpoints.find((c, j) => j > lastIdx && c && c.kind === 'rename' && c.from === file);
      after = await read(moved ? moved.to : file);
      if (typeof after !== 'string') {
        return [`${name}: changed in this turn, but it is no longer on disk, so there is nothing to diff it against.`];
      }
    }
  }
  const label = last.kind === 'delete' ? 'deleted' : (before === '' ? 'created' : 'modified');
  if (before.includes(NUL) || after.includes(NUL)) return [`${name} ${label} (binary, not shown)`];
  const a = splitLines(before).length;
  const b = splitLines(after).length;
  if (a > EXPORT_DIFF_MAX_FILE_LINES || b > EXPORT_DIFF_MAX_FILE_LINES) {
    return [`${name} ${label} (${a.toLocaleString('en-US')} to ${b.toLocaleString('en-US')} lines, too large to diff here)`];
  }
  const d = unifiedDiff(before, after, { maxLines: EXPORT_DIFF_MAX_LINES });
  if (!d) return [`${name} ${label}, rewritten too thoroughly to show line by line (${a} to ${b} lines)`];
  if (!d.added && !d.removed) return [`${name} ${label}, no line changed${before !== after ? ' (only line endings)' : ''}`];
  const out = [`${name} ${label}, +${d.added} -${d.removed}`, '', fence(d.text, 'diff')];
  if (d.truncated) out.push('', `_Diff cut at ${EXPORT_DIFF_MAX_LINES} lines; the counts above cover the whole change._`);
  // The turn's last checkpoint hashes what Navy wrote. If the text diffed
  // against is anything else, the file changed after this turn by some other
  // hand, and that is in the diff too - so say so rather than pass it off as
  // Navy's work.
  if (last.kind === 'edit' && last.newHash && md5(after) !== last.newHash) {
    out.push('', '_This file also changed after this turn, outside Navy, and the diff includes those changes._');
  }
  return out;
}

async function changesSection(meta, checkpoints, root, read) {
  const turnId = meta && meta.turnId;
  const own = [];
  if (turnId) checkpoints.forEach((cp, i) => { if (cp && cp.turnId === turnId) own.push(i); });
  if (!own.length) {
    const named = [...((meta && meta.files) || []), ...((meta && meta.deleted) || [])];
    if (!named.length) return [];
    return [`**Changed:** ${named.map(code).join(', ')}. The diffs are no longer kept: undo history holds only the most recent changes, and a change that was undone is gone from it.`, ''];
  }
  const out = ['**Changes**', ''];
  const done = new Set();
  for (const i of own) {
    const cp = checkpoints[i];
    if (cp.kind === 'rename') {
      out.push(`${code(relPath(cp.from, root))} renamed to ${code(relPath(cp.to, root))}`, '');
      continue;
    }
    const file = cp.filePath;
    if (!file || done.has(file)) continue;
    done.add(file);
    const mine = own.filter(j => checkpoints[j].kind !== 'rename' && checkpoints[j].filePath === file);
    out.push(...await fileDiff(file, mine, checkpoints, root, read), '');
  }
  return out;
}

// readText(path) returns the file's text, or null when it does not exist.
async function buildExportMarkdown({ messages = [], digest = '', checkpoints = [], projectRoot = '', readText = async () => null, now = new Date() } = {}) {
  const cache = new Map();
  const read = async (p) => {
    if (!cache.has(p)) cache.set(p, await readText(p));
    return cache.get(p);
  };
  const cps = Array.isArray(checkpoints) ? checkpoints : [];
  const lines = ['# Navy Chat Export', `> ${now.toLocaleString()}`, ''];
  if (digest && digest.trim()) {
    lines.push('## Condensed earlier in this conversation', '', digest.trim(), '', '---', '');
  }
  for (const m of messages) {
    if (!m) continue;
    const isUser = m.role === 'user';
    const text = String(m.text || '').trim();
    const tools = isUser ? [] : toolsSection(m.cards);
    const changes = isUser ? [] : await changesSection(m.meta, cps, projectRoot, read);
    const error = m.error ? [`_The turn ended on an error: ${String(m.error).trim()}_`, ''] : [];
    if (!text && !tools.length && !changes.length && !error.length) continue;
    lines.push((isUser ? '**You:** ' : '**Navy:** ') + text, '', ...tools, ...changes, ...error);
  }
  return lines.join('\n');
}

module.exports = { buildExportMarkdown, fence, EXPORT_DIFF_MAX_LINES };
