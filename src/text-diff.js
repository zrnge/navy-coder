'use strict';

// Line diffs on the extension side, for the conversation export. The webview
// draws its diff cards with its own copy of this algorithm (computeMyersDiff in
// media/main.js): the webview is plain browser script with no module loader,
// so the two cannot share a file. Same algorithm and the same bound, so an
// export and the card the user saw at the time agree about what changed.

// Myers' O(ND) diff over two arrays of lines. Returns the edit script as
// { t: '=' | '-' | '+', line } ops in order, or null when the two are so
// different that the search passed its bound - the caller says so rather than
// printing a diff that is really two whole files.
function computeMyersDiff(a, b) {
  const n = a.length, m = b.length;
  if (n === 0 && m === 0) return [];
  const total = n + m;
  const D_LIMIT = Math.min(total, Math.max(200, Math.floor(2000000 / Math.max(total, 1))));

  const OFF = D_LIMIT + 2;
  const v = new Int32Array(2 * D_LIMIT + 5);
  v[OFF + 1] = 0;
  const trace = [];
  const bandAt = (d, k) => trace[d][k + d + 1];

  let foundD = -1;
  for (let d = 0; d <= D_LIMIT; d++) {
    trace.push(v.slice(OFF - d - 1, OFF + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[OFF + k - 1] < v[OFF + k + 1])) {
        x = v[OFF + k + 1];
      } else {
        x = v[OFF + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[OFF + k] = x;
      if (x >= n && y >= m) { foundD = d; break; }
    }
    if (foundD !== -1) break;
  }
  if (foundD === -1) return null;

  const ops = [];
  let x = n, y = m;
  for (let d = foundD; d > 0; d--) {
    const k = x - y;
    const prevK = (k === -d || (k !== d && bandAt(d, k - 1) < bandAt(d, k + 1))) ? k + 1 : k - 1;
    const prevX = bandAt(d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: '=', line: a[x - 1] });
      x--; y--;
    }
    if (x === prevX) {
      ops.push({ t: '+', line: b[y - 1] });
    } else {
      ops.push({ t: '-', line: a[x - 1] });
    }
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ t: '=', line: a[x - 1] });
    x--; y--;
  }
  return ops.reverse();
}

// Lines for diffing. A trailing newline is not a phantom empty last line, and
// CRLF and LF are the same line break, so a file whose line endings were
// converted does not diff as every line changed.
function splitLines(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// A unified diff (the `diff -u` / git format): @@ hunk headers, context lines
// with a leading space, removals with '-', additions with '+'. Returns
// { text, added, removed, truncated }, or null when the two texts are too
// different to diff line by line. `text` is cut at maxLines, and `truncated`
// says when it was; `added` and `removed` always count the whole change.
function unifiedDiff(oldText, newText, { context = 3, maxLines = 400 } = {}) {
  const ops = computeMyersDiff(splitLines(oldText), splitLines(newText));
  if (ops === null) return null;
  const rows = [];
  let o = 0, n = 0;
  for (const op of ops) {
    rows.push({ t: op.t, line: op.line, o, n });   // o, n: lines of each side before this row
    if (op.t !== '+') o++;
    if (op.t !== '-') n++;
  }
  const changes = [];
  let added = 0, removed = 0;
  rows.forEach((r, i) => {
    if (r.t === '+') added++;
    if (r.t === '-') removed++;
    if (r.t !== '=') changes.push(i);
  });
  const out = [];
  for (let k = 0; k < changes.length; k++) {
    const start = Math.max(0, changes[k] - context);
    let end = Math.min(rows.length - 1, changes[k] + context);
    // Changes close enough that their context would touch share one hunk.
    while (k + 1 < changes.length && changes[k + 1] - context <= end + 1) {
      k++;
      end = Math.min(rows.length - 1, changes[k] + context);
    }
    const slice = rows.slice(start, end + 1);
    const oldCount = slice.filter(r => r.t !== '+').length;
    const newCount = slice.filter(r => r.t !== '-').length;
    // An empty side is numbered by the line it comes after, as diff -u does.
    const oldStart = oldCount ? slice[0].o + 1 : slice[0].o;
    const newStart = newCount ? slice[0].n + 1 : slice[0].n;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const r of slice) out.push((r.t === '=' ? ' ' : r.t) + r.line);
  }
  const truncated = out.length > maxLines;
  if (truncated) out.length = maxLines;
  return { text: out.join('\n'), added, removed, truncated };
}

module.exports = { computeMyersDiff, splitLines, unifiedDiff };
