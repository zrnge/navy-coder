'use strict';

// A lexical index of the whole project, for find_relevant_files on large
// codebases.
//
// The walk it replaces read files in directory order until it had seen 1,500
// of them, and read them all again for every query. On a big repository most
// files were never considered at all - the answer depended on which folders
// happened to be listed first - and the ranking could not tell a rare
// identifier from a word every file uses. This index covers every source file
// (up to limits generous enough for a large monorepo), is built once in the
// background and updated as files change, and ranks with BM25: a term's weight
// comes from how rare it is in this project, a file's length is taken into
// account, and a match in the file's path or on a line that defines the term
// counts for more. A hit reports the line where the symbol is defined, so the
// model can read that part of the file instead of all of it.
//
// It is lexical, not semantic: it finds the words you use, not their synonyms.
// Semantic search (navy.embeddingModel) still blends in on top when it is set
// up. Everything stays on this machine - the index is built from local files
// and lives only in memory.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const INDEX_MAX_FILES = 40000;
const INDEX_MAX_FILE_BYTES = 512 * 1024;
// The index costs about 2 bytes of memory per byte of source it holds
// (measured: 64 MB for 34 MB of source), so this caps it near 130 MB even
// for a very large monorepo; a search then says the index stopped short.
const INDEX_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const GENERATED_AVG_LINE = 300;    // an average line this long means minified or generated code
const NUL = String.fromCharCode(0);   // binary files have one near the start
const RESYNC_AFTER_MS = 5 * 60 * 1000;
const READ_CONCURRENCY = 24;
const K1 = 1.2;
const B = 0.75;
const PATH_WEIGHT = 2.5;           // a query term in the file's path...
const DEF_WEIGHT = 2.0;            // ...or on a line that defines it

// Identifier-aware tokens: each identifier whole, and its camelCase and
// snake_case parts, lowercased - "parseUserToken" is parseusertoken, parse,
// user and token. Matches how find_relevant_files splits a query.
function tokenizeCode(text, onToken) {
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m;
  while ((m = re.exec(text))) {
    const word = m[0];
    if (word.length < 3 || word.length > 80) continue;
    const lower = word.toLowerCase();
    onToken(lower);
    if (!/[a-z0-9][A-Z]|_/.test(word)) continue;
    for (const part of word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[_\s]+/)) {
      const p = part.toLowerCase();
      if (p.length >= 3 && p !== lower) onToken(p);
    }
  }
}

// The names a file DEFINES, with the line of the first definition: functions,
// classes, methods, types and top-level bindings, across the common languages.
// Only the name being defined counts - `const a = parseToken(x)` defines `a`,
// not parseToken.
const DEF_PATTERNS = [
  /\b(?:function\*?|class|def|interface|type|struct|enum|fn|trait|impl|module|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g,
  /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
  /^\s*(?:(?:async|static|get|set|public|private|protected|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,
  /\b(?:public|private|protected|internal|static|virtual|override)\b[^=;(\n]*?\b([A-Za-z_]\w*)\s*\(/g,
];
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'new', 'await', 'typeof', 'with']);

function findDefinitions(text) {
  const defs = new Map(); // lowercased token -> [line, name as written]
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 1000) continue;
    for (const re of DEF_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        const name = m[1];
        if (!name || NOT_A_NAME.has(name)) continue;
        tokenizeCode(name, (t) => { if (!defs.has(t)) defs.set(t, [i + 1, name]); });
      }
    }
  }
  return defs;
}

// Minified bundles and generated files would flood the index with noise and
// win every query by sheer size.
function looksGenerated(text) {
  const newlines = (text.match(/\n/g) || []).length + 1;
  return text.length / newlines > GENERATED_AVG_LINE;
}

// A posting - one term in one file - is a single small integer: the file's id
// times TF_SPAN plus how often the term occurs there. A term found in one file
// only, which is most of them, is stored as that bare number rather than an
// array. Measured on a 7,400-file corpus, the object-of-two-arrays shape this
// replaced held about twice the memory for the same index.
const TF_SPAN = 1024;
const encode = (id, tf) => id * TF_SPAN + Math.min(tf, TF_SPAN - 1);

class LexicalIndex {
  constructor() {
    this.docs = [];            // id -> { rel, len, defLines, defNames, pathTerms, alive }
    this.byRel = new Map();    // rel -> id
    this.terms = new Map();    // term -> posting, or array of postings
    this.alive = 0;
    this.dead = 0;
    this.totalLen = 0;
  }

  get size() { return this.alive; }

  add(rel, text) {
    this.remove(rel);
    const counts = new Map();
    let len = 0;
    tokenizeCode(text, (t) => { counts.set(t, (counts.get(t) || 0) + 1); len++; });
    const pathTerms = [];
    tokenizeCode(rel, (t) => { if (!pathTerms.includes(t)) pathTerms.push(t); });
    // Definitions, compactly: token -> line, and each defined name as written
    // once, as flat [line, name, line, name, ...].
    let defLines = null;
    let defNames = null;
    for (const [t, [line, name]] of findDefinitions(text)) {
      if (!defLines) { defLines = new Map(); defNames = []; }
      defLines.set(t, line);
      if (defNames[defNames.length - 1] !== name || defNames[defNames.length - 2] !== line) defNames.push(line, name);
    }
    const id = this.docs.length;
    this.docs.push({ rel, len, defLines, defNames, pathTerms, alive: true });
    // A term only in the path still has to lead here, with no body frequency.
    for (const t of pathTerms) if (!counts.has(t)) counts.set(t, 0);
    for (const [t, tf] of counts) {
      const code = encode(id, tf);
      const p = this.terms.get(t);
      if (p === undefined) this.terms.set(t, code);
      else if (typeof p === 'number') this.terms.set(t, [p, code]);
      else p.push(code);
    }
    this.byRel.set(rel, id);
    this.alive++;
    this.totalLen += len;
  }

  remove(rel) {
    const id = this.byRel.get(rel);
    if (id === undefined) return;
    const doc = this.docs[id];
    doc.alive = false;
    this.byRel.delete(rel);
    this.alive--;
    this.dead++;
    this.totalLen -= doc.len;
    // Removal only marks the document; the postings are swept once enough of
    // them are dead to be worth the pass.
    if (this.dead > 2000 && this.dead > this.alive) this._compact();
  }

  _compact() {
    const remap = new Map();
    const docs = [];
    this.docs.forEach((d, old) => { if (d.alive) { remap.set(old, docs.length); docs.push(d); } });
    for (const [t, p] of this.terms) {
      const kept = [];
      for (const code of (typeof p === 'number' ? [p] : p)) {
        const nid = remap.get(Math.floor(code / TF_SPAN));
        if (nid !== undefined) kept.push(encode(nid, code % TF_SPAN));
      }
      if (!kept.length) this.terms.delete(t);
      else this.terms.set(t, kept.length === 1 ? kept[0] : kept);
    }
    this.docs = docs;
    this.byRel = new Map(docs.map((d, i) => [d.rel, i]));
    this.dead = 0;
  }

  // The name as written that a file defines at `line`.
  _nameAt(doc, line) {
    for (let i = 0; i < doc.defNames.length; i += 2) if (doc.defNames[i] === line) return doc.defNames[i + 1];
    return '';
  }

  // queryTerms: [{ term, weight }], lowercased, as _tokenizeQuery makes them.
  // Returns hits best first: { rel, score, matched, count, inName, defs,
  // defLine, defName }.
  search(queryTerms, { limit = 50 } = {}) {
    const n = this.alive || 1;
    const avgLen = this.totalLen / n || 1;
    const hits = new Map();
    for (const { term, weight } of queryTerms) {
      const p = this.terms.get(term);
      if (p === undefined) continue;
      const postings = typeof p === 'number' ? [p] : p;
      let df = 0;
      for (const code of postings) if (this.docs[Math.floor(code / TF_SPAN)].alive) df++;
      if (!df) continue;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (const code of postings) {
        const id = Math.floor(code / TF_SPAN);
        const doc = this.docs[id];
        if (!doc.alive) continue;
        const tf = code % TF_SPAN;
        let s = tf ? (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * doc.len / avgLen)) : 0;
        const inPath = doc.pathTerms.includes(term);
        const defLine = doc.defLines ? doc.defLines.get(term) : undefined;
        if (inPath) s += PATH_WEIGHT;
        if (defLine) s += DEF_WEIGHT;
        s *= idf * weight;
        let h = hits.get(id);
        if (!h) hits.set(id, (h = { score: 0, matched: [], count: 0, inName: false, defs: false, defLine: 0, defWeight: 0 }));
        h.score += s;
        h.matched.push(term);
        h.count += tf;
        if (inPath) h.inName = true;
        if (defLine && weight > h.defWeight) {
          h.defs = true;
          h.defLine = defLine;
          h.defWeight = weight;
        }
      }
    }
    // BM25 already sums over terms; this makes covering more of the query
    // count for a little more than repeating one part of it.
    const distinct = queryTerms.length || 1;
    return [...hits]
      .map(([id, h]) => ({ id, h, score: h.score * (1 + 0.5 * (h.matched.length / distinct)) }))
      .sort((a, b) => b.score - a.score || this.docs[a.id].rel.localeCompare(this.docs[b.id].rel))
      .slice(0, limit)
      .map(({ id, h, score }) => {
        const doc = this.docs[id];
        return {
          rel: doc.rel, score, matched: h.matched, count: h.count, inName: h.inName,
          defs: h.defs, defLine: h.defLine, defName: h.defs ? this._nameAt(doc, h.defLine) : '',
        };
      });
  }
}

// Every source file in the project, relative, forward slashes. git decides
// what is ignored when it can - real .gitignore semantics, and fast on a huge
// tree - but only in a trusted workspace, and with core.fsmonitor off: a
// repository's own git config can name a program for git to run, and listing
// files must not be a way to run it. Otherwise, or outside a repo, a walk.
// Whether a project-relative path belongs in the index: a source extension,
// and no skipped or hidden folder anywhere on the way to it.
function wantedFile(rel, { skipDirs = new Set(), exts = new Set() } = {}) {
  if (!exts.has(path.extname(rel).toLowerCase())) return false;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (skipDirs.has(parts[i]) || parts[i].startsWith('.')) return false;
  }
  return true;
}

function listProjectFiles(root, {
  trusted = false, skipDirs = new Set(), exts = new Set(), maxFiles = INDEX_MAX_FILES, execFileImpl = execFile,
} = {}) {
  const keep = (rel) => wantedFile(rel, { skipDirs, exts });
  const walk = async () => {
    const out = [];
    const stack = [''];
    while (stack.length && out.length < maxFiles) {
      const dir = stack.pop();
      let entries;
      try { entries = await fs.promises.readdir(path.join(root, dir), { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const rel = dir ? dir + '/' + e.name : e.name;
        if (e.isDirectory()) {
          if (!skipDirs.has(e.name) && !e.name.startsWith('.')) stack.push(rel);
        } else if (keep(rel)) {
          out.push(rel);
          if (out.length >= maxFiles) break;
        }
      }
    }
    return { files: out, viaGit: false };
  };
  if (!trusted) return walk();
  return new Promise((resolve) => {
    execFileImpl('git', ['-c', 'core.fsmonitor=false', 'ls-files', '-co', '--exclude-standard', '-z'],
      { cwd: root, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(walk()); return; }
        const files = String(stdout).split('\0').filter(f => f && keep(f)).slice(0, maxFiles);
        resolve({ files, viaGit: true });
      });
  });
}

// One project's index and what keeps it current.
function createIndexEntry(root) {
  return {
    root, index: new LexicalIndex(), meta: new Map(), dirty: new Set(),
    ready: false, building: null, capped: false, failed: false, syncedAt: 0, viaGit: false,
  };
}

async function indexFiles(entry, rels, budget) {
  for (let i = 0; i < rels.length; i += READ_CONCURRENCY) {
    await Promise.all(rels.slice(i, i + READ_CONCURRENCY).map(async (rel) => {
      const full = path.join(entry.root, rel);
      let st;
      try { st = await fs.promises.stat(full); } catch { entry.index.remove(rel); entry.meta.delete(rel); return; }
      if (!st.isFile() || st.size > INDEX_MAX_FILE_BYTES) { entry.index.remove(rel); entry.meta.delete(rel); return; }
      if (budget && budget.bytes + st.size > INDEX_MAX_TOTAL_BYTES) { entry.capped = true; return; }
      let text;
      try { text = await fs.promises.readFile(full, 'utf8'); } catch { return; }
      if (text.slice(0, 2048).includes(NUL) || looksGenerated(text)) { entry.index.remove(rel); entry.meta.delete(rel); return; }
      entry.index.add(rel, text);
      entry.meta.set(rel, { mtimeMs: st.mtimeMs, size: st.size });
      if (budget) budget.bytes += st.size;
    }));
    // Let everything else in the extension host run between batches.
    await new Promise(r => setImmediate(r));
  }
}

async function buildLexicalIndex(entry, opts) {
  const { files, viaGit } = await listProjectFiles(entry.root, opts);
  entry.viaGit = viaGit;
  entry.capped = files.length >= (opts.maxFiles || INDEX_MAX_FILES);
  await indexFiles(entry, files, { bytes: 0 });
  entry.syncedAt = Date.now();
  entry.ready = true;
  return entry;
}

// Brings a built index up to date: the files the watcher reported changed,
// and - past RESYNC_AFTER_MS, for changes no watcher saw - a fresh listing
// compared by modification time.
async function refreshLexicalIndex(entry, opts, now = Date.now()) {
  if (!entry.ready) return entry;
  if (now - entry.syncedAt > RESYNC_AFTER_MS) {
    const { files } = await listProjectFiles(entry.root, opts);
    const current = new Set(files);
    for (const rel of [...entry.meta.keys()]) {
      if (!current.has(rel)) { entry.index.remove(rel); entry.meta.delete(rel); }
    }
    const stale = [];
    await Promise.all(files.map(async (rel) => {
      const known = entry.meta.get(rel);
      if (!known) { stale.push(rel); return; }
      try {
        const st = await fs.promises.stat(path.join(entry.root, rel));
        if (st.mtimeMs !== known.mtimeMs || st.size !== known.size) stale.push(rel);
      } catch { stale.push(rel); }
    }));
    for (const rel of stale) entry.dirty.add(rel);
    entry.syncedAt = now;
  }
  if (entry.dirty.size) {
    const rels = [...entry.dirty];
    entry.dirty.clear();
    // A file that stopped qualifying (moved under a skipped folder, say) leaves
    // the index rather than lingering in it.
    for (const rel of rels) if (!wantedFile(rel, opts)) { entry.index.remove(rel); entry.meta.delete(rel); }
    await indexFiles(entry, rels.filter(rel => wantedFile(rel, opts)), null);
  }
  return entry;
}

module.exports = {
  LexicalIndex, tokenizeCode, findDefinitions, looksGenerated, listProjectFiles, wantedFile,
  createIndexEntry, buildLexicalIndex, refreshLexicalIndex,
  INDEX_MAX_FILES, RESYNC_AFTER_MS,
};
