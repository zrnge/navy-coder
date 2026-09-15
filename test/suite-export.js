const { check } = require('./harness.js');
const path = require('path');
const crypto = require('crypto');
const { unifiedDiff, splitLines } = require('../src/text-diff.js');
const { buildExportMarkdown, fence } = require('../src/export.js');

// The conversation export: its line diffs, and the Markdown that puts each
// turn's tool calls and file diffs under the reply, rebuilt from the saved
// cards and the undo checkpoints. Pure, so no mock and no filesystem.

async function exportSuite() {
  // ── unifiedDiff ──────────────────────────────────────────────────────────
  const one = unifiedDiff('a\nb\nc\n', 'a\nx\nc\n');
  check('diff: a changed line is one hunk, in diff -u format', one.text === '@@ -1,3 +1,3 @@\n a\n-b\n+x\n c', JSON.stringify(one.text));
  check('diff: ...counting one line added and one removed', one.added === 1 && one.removed === 1 && !one.truncated);
  check('diff: a new file numbers its empty side from 0', unifiedDiff('', 'x\ny\n').text === '@@ -0,0 +1,2 @@\n+x\n+y');
  check('diff: ...and so does an emptied one', unifiedDiff('x\ny\n', '').text === '@@ -1,2 +0,0 @@\n-x\n-y');
  const same = unifiedDiff('a\nb\n', 'a\nb\n');
  check('diff: identical text has no hunks', same.text === '' && same.added === 0 && same.removed === 0);
  const crlf = unifiedDiff('a\r\nb\r\n', 'a\nb\n');
  check('diff: converting line endings is not every line changed', crlf.added === 0 && crlf.removed === 0);
  check('diff: a trailing newline is not a phantom last line', splitLines('a\nb\n').length === 2 && splitLines('').length === 0);

  const L = Array.from({ length: 20 }, (_, i) => 'L' + (i + 1));
  const far = L.slice(); far[1] = 'X2'; far[17] = 'X18';
  const heads = unifiedDiff(L.join('\n'), far.join('\n')).text.split('\n').filter(l => l.startsWith('@@'));
  check('diff: changes far apart get a hunk each, numbered where they are',
    JSON.stringify(heads) === JSON.stringify(['@@ -1,5 +1,5 @@', '@@ -15,6 +15,6 @@']), JSON.stringify(heads));
  const near = L.slice(); near[1] = 'X2'; near[5] = 'X6';
  check('diff: changes whose context would touch share one hunk',
    unifiedDiff(L.join('\n'), near.join('\n')).text.split('\n').filter(l => l.startsWith('@@')).length === 1);
  const ins = L.slice(); ins.splice(10, 0, 'NEW');
  check('diff: an insertion counts one more line on the new side',
    unifiedDiff(L.join('\n'), ins.join('\n')).text.startsWith('@@ -8,6 +8,7 @@\n L8\n L9\n L10\n+NEW\n L11'));

  const base = Array.from({ length: 600 }, (_, i) => 'line ' + i);
  const every = base.map((l, i) => (i % 2 ? l + ' changed' : l));
  const cut = unifiedDiff(base.join('\n'), every.join('\n'), { maxLines: 50 });
  check('diff: a long diff is cut at maxLines and says so, with the counts still whole',
    Boolean(cut) && cut.text.split('\n').length === 50 && cut.truncated && cut.added === 300 && cut.removed === 300,
    cut && JSON.stringify({ lines: cut.text.split('\n').length, truncated: cut.truncated, added: cut.added, removed: cut.removed }));
  const p = Array.from({ length: 5000 }, (_, i) => 'p' + i).join('\n');
  const q = Array.from({ length: 5000 }, (_, i) => 'q' + i).join('\n');
  check('diff: two texts with nothing in common are refused, not printed as two whole files', unifiedDiff(p, q) === null);

  check('fence: output that contains ``` gets a longer fence, so it cannot close the block early',
    fence('a\n```\nb') === '````\na\n```\nb\n````');
  check('fence: ...and plain text gets three, with its info string', fence('plain', 'diff') === '```diff\nplain\n```');

  // ── buildExportMarkdown ──────────────────────────────────────────────────
  const root = path.resolve('/proj');
  const A = path.join(root, 'src', 'a.js');
  const B = path.join(root, 'b.js');
  const C = path.join(root, 'new.js');
  const D = path.join(root, 'gone.js');
  const E = path.join(root, 'vanished.js');
  const R = path.join(root, 'r.js');
  const R2 = path.join(root, 'r2.js');
  const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex');
  const disk = { [A]: 'one\nTWO\nthree\n', [B]: 'B1\nedited by hand\n', [C]: 'fresh\n', [R2]: 'r1\n' };
  const checkpoints = [
    { kind: 'edit', filePath: A, originalText: 'one\ntwo\n', newHash: md5('one\nTWO\n'), turnId: 't1' },
    { kind: 'edit', filePath: A, originalText: 'one\nTWO\n', newHash: md5('one\nTWO\nthree\n'), turnId: 't2' },
    { kind: 'edit', filePath: B, originalText: 'B0\n', newHash: md5('B1\n'), turnId: 't2' },
    { kind: 'edit', filePath: C, originalText: '', newHash: md5('fresh\n'), turnId: 't3' },
    { kind: 'delete', filePath: D, originalText: 'bye\n', turnId: 't3' },
    { kind: 'rename', from: path.join(root, 'old-name.js'), to: path.join(root, 'new-name.js'), turnId: 't3' },
    { kind: 'edit', filePath: E, originalText: 'v\n', turnId: 't4' },
    { kind: 'edit', filePath: R, originalText: 'r0\n', newHash: md5('r1\n'), turnId: 't5' },
    { kind: 'rename', from: R, to: R2, turnId: 't6' },
  ];
  const messages = [
    { role: 'user', text: 'capitalise two' },
    { role: 'assistant', text: 'Capitalised.', meta: { turnId: 't1', files: ['a.js'] },
      cards: [
        { tool: 'read_file', args: { path: 'src/a.js' }, result: 'one\ntwo' },
        { tool: 'run_command', args: { command: 'npm test' }, result: 'ok\n```\nfenced', full: { chars: 9000, lines: 300, filled: 290 } },
      ] },
    { role: 'user', text: 'add three' },
    { role: 'assistant', text: 'Added.', meta: { turnId: 't2', files: ['a.js', 'b.js'] } },
    { role: 'user', text: 'tidy up' },
    { role: 'assistant', text: 'Tidied.', meta: { turnId: 't3', files: ['new.js'], deleted: ['gone.js'] } },
    { role: 'assistant', text: 'Vanished.', meta: { turnId: 't4', files: ['vanished.js'] } },
    { role: 'assistant', text: 'Edited r.', meta: { turnId: 't5', files: ['r.js'] } },
    { role: 'user', text: 'long ago' },
    { role: 'assistant', text: 'Old work.', meta: { turnId: 'evicted', files: ['ancient.js'] } },
    { role: 'assistant', text: 'Just talk.' },
    { role: 'assistant', text: '', error: 'The provider refused the key.',
      cards: [{ kind: 'thinking', text: 'hmm' }, { kind: 'diff', path: 'x.js', hunks: '' }, { tool: 'read_file', args: { path: 'x.js' }, result: 'x' }] },
  ];
  const md = await buildExportMarkdown({
    messages, digest: '- decided on X', checkpoints, projectRoot: root,
    readText: async (f) => (f in disk ? disk[f] : null),
  });
  const between = (from, to) => {
    const i = md.indexOf(from);
    const j = to ? md.indexOf(to, i + 1) : md.length;
    return i === -1 ? '' : md.slice(i, j === -1 ? md.length : j);
  };
  const t1 = between('**Navy:** Capitalised.', '**You:** add three');
  const t2 = between('**Navy:** Added.', '**You:** tidy up');
  const t3 = between('**Navy:** Tidied.', '**Navy:** Vanished.');

  check('export: every message, with who said it', /\*\*You:\*\* capitalise two/.test(md) && /\*\*Navy:\*\* Just talk\./.test(md));
  check('export: what earlier compactions condensed leads the file',
    md.indexOf('## Condensed earlier in this conversation') < md.indexOf('**You:**') && md.includes('- decided on X'));
  check('export: a turn\'s tool calls are listed under its reply, folded away',
    t1.includes('<summary>2 tool calls</summary>') && t1.includes('**`read_file`** path: `src/a.js`')
    && t1.includes('**`run_command`** command: `npm test`'), t1);
  check('export: ...with the output the transcript showed, fenced so a ``` inside cannot break out',
    t1.includes('````\nok\n```\nfenced\n````'), t1);
  check('export: ...and an excerpt says it is one, and of how much',
    /first 13 of 9,000 characters/.test(t1), t1);
  check('export: a turn\'s diff runs to the file\'s next change, not to today\'s file',
    t1.includes('`src/a.js` modified, +1 -1') && t1.includes('-two') && t1.includes('+TWO') && !t1.includes('+three'), t1);
  check('export: ...and the latest turn\'s diff runs to the file on disk',
    t2.includes('+three') && !t2.includes('-two'), t2);
  check('export: a file changed afterwards outside Navy is flagged, and only that one',
    /`b\.js` modified[\s\S]*\+edited by hand[\s\S]*also changed after this turn, outside Navy/.test(t2)
    && md.split('outside Navy').length === 2, t2);
  check('export: a created file, a deleted one and a rename each read as what they were',
    t3.includes('`new.js` created, +1 -0') && t3.includes('`gone.js` deleted, +0 -1') && t3.includes('-bye')
    && t3.includes('`old-name.js` renamed to `new-name.js`'), t3);
  check('export: a file no longer on disk says so instead of diffing against nothing',
    /`vanished\.js`: changed in this turn, but it is no longer on disk/.test(md));
  check('export: a file renamed later is diffed against its text under the new name',
    /`r\.js` modified, \+1 -1[\s\S]*-r0[\s\S]*\+r1/.test(between('**Navy:** Edited r.', '**You:** long ago')));
  check('export: a turn whose diffs undo history no longer holds names its files and says why',
    /\*\*Changed:\*\* `ancient\.js`\. The diffs are no longer kept/.test(md));
  check('export: a reply that changed nothing gets no changes section',
    !between('**Navy:** Just talk.').includes('**Changes**'));
  check('export: only tool calls are listed as tool calls, not the diff or reasoning cards a turn also keeps',
    /\*\*Navy:\*\* \n\n<details>\n<summary>1 tool call<\/summary>/.test(md) && !md.includes('undefined'), md.slice(-600));
  check('export: a turn that ended on an error says so',
    /_The turn ended on an error: The provider refused the key\._/.test(md));
  check('export: diffs are fenced as diff, so they render as one',
    (md.match(/```diff/g) || []).length === 6, String((md.match(/```diff/g) || []).length));
}

module.exports = { exportSuite };
