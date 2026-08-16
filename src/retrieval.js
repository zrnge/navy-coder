// ── Retrieval ───────────────────────────────────────────────────────────────
// Everything Navy uses to decide WHICH files matter: the lexical ranker, the
// semantic (embedding) index and its sharded storage, LSP symbol candidates,
// and the repo map.
//
// Extracted from extension.js unchanged. The methods below are still methods
// on NavyCoderViewProvider — mixed into its prototype at the bottom of
// extension.js — so `this` means what it always did and no call site, no
// signature and no behaviour changed. Written as a class purely so the block
// could move verbatim: a class body and an object literal differ by a comma
// after every member, and a move that has to retype 700 lines is not a move.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getEmbeddings, cosineSimilarity } = require('./providers/embeddings.js');
const { fold, foldPath } = require('./paths.js');
const { workspaceIsTrusted } = require('./workspace.js');

// ── Semantic index storage ──────────────────────────────────────────────────
// The index used to be one flat `.navy/embeddings.json` with a 24 MB ceiling,
// past which it was silently not persisted at all — so a large repository
// re-embedded itself from scratch every time the window opened, and one byte
// over the cap discarded a completely valid index. It is now sharded, and
// vectors are stored as base64 Float32Array rather than lists of JSON numbers.
//
// Sharding is what removes the cliff: stringify and parse run synchronously on
// the extension host's main thread, so the ceiling was really a UI-freeze
// guard, and bounding each write bounds that cost directly.
//
// The encoding is a smaller, separate win, and worth stating accurately: the
// old format already rounded to 5 decimals, so against THAT — not against raw
// float64 — base64 float32 is about 1.6x smaller (measured: 12,915 bytes vs
// 8,194 for a 1536-dimension vector). The larger gain is in parsing, which
// stops being 1,536 numeric literals per chunk and becomes one base64 decode.
// Float32 also loses nothing: it carries ~7 significant digits, more than the
// 5-decimal rounding it replaces.
const EMBED_INDEX_VERSION = 2;
const EMBED_SHARD_COUNT = 32;
// Per SHARD, not per index. Sized so a shard stays comfortably small even for a
// repository at the 1,500-file walk limit; a shard that somehow exceeds it is
// skipped and its files re-embed next session, which costs those files rather
// than the whole index.
const EMBED_SHARD_MAX_BYTES = 8 * 1024 * 1024;

// Vectors on disk.
function encodeVector(vec) {
  const f = Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}

// Returns a Float32Array, or null for anything that isn't a whole number of
// floats — a truncated shard must lose its file, never hand back a vector of
// the wrong dimensionality for cosineSimilarity to compare against.
function decodeVector(b64) {
  const bytes = Buffer.from(String(b64 || ''), 'base64');
  if (!bytes.byteLength || bytes.byteLength % 4 !== 0) return null;
  // Buffer views a pooled ArrayBuffer shared with unrelated allocations, so the
  // bytes are copied into their own buffer before being reinterpreted as
  // floats — reading the pool directly would return whatever else is in it.
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  return new Float32Array(owned);
}

// Which shard a file belongs in. Deterministic and content-independent, so a
// re-indexed file always rewrites the same shard and the rest stay untouched.
function shardOf(rel, count = EMBED_SHARD_COUNT) {
  let h = 0;
  for (let i = 0; i < rel.length; i++) h = (Math.imul(h, 31) + rel.charCodeAt(i)) >>> 0;
  return (h % count).toString(16).padStart(2, '0');
}


const RELEVANCE_SKIP_DIRS = new Set(['node_modules','.git','dist','build','out','.next','.nuxt','__pycache__','.venv','venv','coverage','.cache','.navy','vendor','target']);
const RELEVANCE_CODE_EXTS = new Set(['.js','.jsx','.ts','.tsx','.mjs','.cjs','.py','.go','.rs','.java','.rb','.php','.c','.h','.cpp','.hpp','.cc','.cs','.swift','.kt','.scala','.vue','.svelte','.sql','.sh','.md','.json','.yml','.yaml','.toml']);

// Files whose CONTENTS must never be uploaded to an embeddings API. Keyword
// search reads these locally, which is fine; the embedding index sends bytes to
// a third party, so it needs a much stricter filter. Deliberately matches on
// the filename rather than the extension, because the risky ones share
// extensions with ordinary source (docker-compose.yml, serviceAccount.json).
const EMBED_SENSITIVE_RE = new RegExp([
  '(^|[.\\-_])secrets?([.\\-_]|$)',
  '(^|[.\\-_])credentials?([.\\-_]|$)',
  '(^|[.\\-_])passwords?([.\\-_]|$)',
  // Needs a trailing boundary or it swallows ordinary source like tokenizer.js.
  '(^|[.\\-_])tokens?([.\\-_]|$)',
  '(^|[.\\-_])apikey',
  '(^|[.\\-_])api[.\\-_]?keys?([.\\-_]|$)',
  '^\\.env',
  '(^|[.\\-_])env\\.',
  'serviceaccount',
  'service[-_]account',
  '[-_]adminsdk',
  '(^|[.\\-_])private[.\\-_]?key',
  '(^|[.\\-_])id_(rsa|dsa|ecdsa|ed25519)',
  '\\.(pem|key|pfx|p12|keystore|jks|ppk|asc|gpg)$',
  '(^|[.\\-_])htpasswd',
  '(^|[.\\-_])npmrc',
  '(^|[.\\-_])pypirc',
  '(^|[.\\-_])netrc',
  '^docker-compose',
  '(^|[.\\-_])local\\.(json|ya?ml|toml)$',
].join('|'), 'i');

function isSensitiveForEmbedding(relPath) {
  const name = String(relPath || '').split(/[\\/]/).pop() || '';
  return EMBED_SENSITIVE_RE.test(name);
}

// Literal string replacement — avoids String.replace's $ meta-char interpolation.
// Returns the edited string, null if not found, or an Error if ambiguous (>1 match).
// Falls through: exact → CRLF-normalised → line-level fuzzy (≥85 % match).
function chunkFileForEmbedding(rel, content, { windowLines = 120, overlapLines = 20, maxChunks = 8, maxCharsPerChunk = 6000 } = {}) {
  const lines = content.split('\n');
  if (lines.length <= windowLines) {
    return [{ startLine: 1, endLine: Math.max(lines.length, 1), text: rel + '\n\n' + content.slice(0, 1500) }];
  }
  const step = windowLines - overlapLines;
  const chunks = [];
  for (let start = 0; start < lines.length && chunks.length < maxChunks; start += step) {
    const end = Math.min(start + windowLines, lines.length);
    const slice = lines.slice(start, end).join('\n');
    chunks.push({ startLine: start + 1, endLine: end, text: `${rel}:${start + 1}-${end}\n\n${slice.slice(0, maxCharsPerChunk)}` });
    if (end >= lines.length) break;
  }
  return chunks;
}

class RetrievalMethods {
  // ── Lexical retrieval ────────────────────────────────────────────────────
  // Navy has no embeddings; this gives the agent a purpose-built ranked file
  // finder so it stops blindly guessing which files to read on a large repo.

  // Extract salient search terms from a prompt: identifiers/words ≥3 chars, minus
  // common English + coding filler. Also splits camelCase / snake_case so
  // "parseUserToken" contributes parse/user/token as well as the whole word. Pure.
  _tokenizeQuery(q) {
    const STOP = new Set(['the','and','for','with','this','that','from','into','have','has','are','was','were','file','files','code','line','lines','function','please','make','fix','fixes','fixed','add','added','update','updated','change','changes','create','created','remove','removed','delete','implement','refactor','review','explain','check','using','use','used','need','needs','want','should','would','could','how','what','why','where','when','which','all','any','get','set','new','old','error','errors','bug','bugs','issue','issues','test','tests','navy','let','you','your','can','not','then','than','also','here','there','they','them','its','our']);
    const words = (q || '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    const terms = new Map(); // term → weight (whole identifiers weigh more than split parts)
    const add = (t, w) => { const k = t.toLowerCase(); if (k.length >= 3 && !STOP.has(k)) terms.set(k, Math.max(terms.get(k) || 0, w)); };
    for (const w of words) {
      add(w, 2);
      // split identifier into parts
      for (const part of w.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[_\s]+/)) add(part, 1);
    }
    return [...terms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, w]) => ({ term: t, weight: w }));
  }

  // Pure ranker: hits = [{ rel, count, matched:[terms], inName:bool, defs:bool }].
  _rankRelevance(hits, terms) {
    const distinct = terms.length || 1;
    return hits
      .map(h => {
        // Sublinear frequency (TF saturation, à la BM25): the 40th mention of a term
        // barely helps, so a file that merely name-drops a term can't outrank the one
        // that DEFINES it or is named after it.
        let score = Math.min(Math.log2(1 + h.count) * 4, 20);
        score += (h.matched.length / distinct) * 25;  // coverage of distinct query terms matters most
        if (h.inName) score += 12;                    // a query term in the filename is a strong signal
        if (h.defs)   score += 10;                    // the file DEFINES a query term
        return { ...h, score: Math.round(score) };
      })
      .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  }

  // Walk the repo, read each source file once, score against terms. Bounded so a
  // huge tree can't hang: skip dirs, size cap, file-count cap. Results are cached
  // per (root, maxFiles, terms) for 30s so repeated identical prompts (e.g. the
  // same request re-sent) don't re-read the whole tree each time.
  async _collectRelevance(root, terms, { maxFiles = 1500, maxBytes = 300 * 1024 } = {}) {
    const cacheKey = root + '|' + maxFiles + '|' + terms.map(t => t.term).sort().join(',');
    if (this._relCache && this._relCache.key === cacheKey && Date.now() - this._relCache.time < 30_000) {
      return this._relCache.hits;
    }
    const DEF_KW = 'function|class|def|const|let|var|interface|type|struct|enum|fn|func|trait|impl|module|component';
    // Compile the term + definition regexes ONCE (not per file) — a repo scan is
    // up to maxFiles × terms iterations, so per-file compilation is pure waste.
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = terms.map(t => ({
      term: t.term,
      re: new RegExp('\\b' + esc(t.term) + '\\b', 'gi'),
      defRe: new RegExp('\\b(?:' + DEF_KW + ')\\b[^\\n]*\\b' + esc(t.term) + '\\b', 'i'),
    }));
    const hits = [];
    let scanned = 0;
    const walk = async (dir) => {
      if (scanned >= maxFiles) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (scanned >= maxFiles) return;
        if (e.isDirectory()) {
          if (!RELEVANCE_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name));
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (!RELEVANCE_CODE_EXTS.has(ext)) continue;
        const full = path.join(dir, e.name);
        let text;
        try {
          const st = await fs.promises.stat(full);
          if (st.size > maxBytes) continue;
          text = await fs.promises.readFile(full, 'utf8');
        } catch { continue; }
        scanned++;
        const rel = path.relative(root, full).replace(/\\/g, '/');
        // Word-boundary name match (a query term as its own path segment / camel part),
        // so "app" no longer credits "mapper.js".
        const nameTokens = new Set(rel.toLowerCase().replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^a-z0-9]+/i).filter(Boolean));
        let count = 0, inName = false, defs = false;
        const matched = [];
        for (const p of patterns) {
          const m = text.match(p.re);
          const n = m ? m.length : 0;
          if (n > 0) { count += n; matched.push(p.term); }
          if (nameTokens.has(p.term)) inName = true;
          if (!defs && p.defRe.test(text)) defs = true;
        }
        if (count > 0 || inName) hits.push({ rel, count, matched, inName, defs });
      }
    };
    await walk(root);
    this._relCache = { key: cacheKey, time: Date.now(), hits };
    return hits;
  }

  // ── Semantic search (opt-in via navy.embeddingModel) ────────────────────────
  // File-level embeddings, persisted to .navy/embeddings.json, incrementally
  // updated (only new/changed files are re-embedded). Purely additive to the
  // keyword ranker above — with no embeddingModel configured, or a provider
  // that can't actually produce embeddings, toolFindRelevantFiles behaves
  // exactly as it always has.

  async _loadEmbeddingIndex(root) {
    if (this._embedIndexCache?.root === root) return this._embedIndexCache;
    const dir = this.getNavyDir();
    let stored = { model: '', provider: '', files: {} };
    if (dir) {
      stored = await this._readShardedIndex(dir);
      // Only when sharded storage produced nothing — otherwise a leftover
      // legacy file from a rollback-and-forward would overwrite newer shards.
      if (!Object.keys(stored.files).length) {
        stored = (await this._migrateLegacyEmbeddingIndex(dir)) || stored;
      }
    }
    // `dirty` records which shards changed since the last write, so an
    // incremental re-index rewrites only the shards it touched.
    this._embedIndexCache = { root, dirty: new Set(), ...stored };
    return this._embedIndexCache;
  }

  async _readShardedIndex(dir) {
    const shardDir = path.join(dir, 'embeddings');
    let names;
    try { names = await fs.promises.readdir(shardDir); } catch { return { model: '', provider: '', files: {} }; }

    let model = null, provider = null;
    const files = {};
    let skipped = 0;
    for (const name of names.filter(n => n.endsWith('.json')).sort()) {
      let shard;
      try { shard = JSON.parse(await fs.promises.readFile(path.join(shardDir, name), 'utf8')); }
      catch { skipped++; continue; } // a corrupt shard costs its own files, not the index
      if (!shard || shard.v !== EMBED_INDEX_VERSION || !shard.files) { skipped++; continue; }
      // Every shard carries its own embedding-space stamp, not just a shared
      // manifest. A crash or a rollback can leave shards from two different
      // models side by side, and vectors from different spaces produce a
      // plausible-looking, meaningless score if compared — so the first shard
      // read defines the space and any shard disagreeing with it is dropped.
      if (model === null) { model = shard.model || ''; provider = shard.provider || ''; }
      else if ((shard.model || '') !== model || (shard.provider || '') !== provider) { skipped++; continue; }

      for (const [rel, entry] of Object.entries(shard.files)) {
        const chunks = [];
        for (const c of entry.chunks || []) {
          const vector = decodeVector(c.v);
          if (vector && vector.length) chunks.push({ startLine: c.s, endLine: c.e, vector });
        }
        if (chunks.length) files[rel] = { mtimeMs: entry.mtimeMs, size: entry.size, chunks };
      }
    }
    if (skipped) {
      this.log?.(`semantic index: ${skipped} shard(s) skipped as unreadable or from a different embedding model — those files re-embed on the next search`);
    }
    return { model: model || '', provider: provider || '', files };
  }

  // One-time move from the flat `.navy/embeddings.json`. The index is a pure
  // cache — every byte is rebuildable from the project — so the legacy file is
  // removed once its contents are safely sharded rather than left as a second
  // copy of a multi-megabyte artefact. (The project catalog is user data and is
  // migrated non-destructively; this is not.)
  async _migrateLegacyEmbeddingIndex(dir) {
    const legacy = path.join(dir, 'embeddings.json');
    let parsed;
    try { parsed = JSON.parse(await fs.promises.readFile(legacy, 'utf8')); }
    catch { return null; }

    const drop = async () => { try { await fs.promises.unlink(legacy); } catch { /* best effort */ } };
    // Pre-chunking caches stored one `vector` per file rather than a `chunks`
    // array; reading one as the new shape throws on the first similarity call.
    if (!parsed || typeof parsed !== 'object' || parsed.chunked !== true || !parsed.files) {
      await drop();
      return null;
    }

    const files = {};
    for (const [rel, f] of Object.entries(parsed.files)) {
      const chunks = (f.chunks || [])
        .filter(c => Array.isArray(c.vector) && c.vector.length)
        .map(c => ({ startLine: c.startLine, endLine: c.endLine, vector: Float32Array.from(c.vector) }));
      if (chunks.length) files[rel] = { mtimeMs: f.mtimeMs, size: f.size, chunks };
    }
    const migrated = { model: parsed.model || '', provider: parsed.provider || '', files };
    try {
      await this._writeShards(dir, migrated, null);
      await drop();
      this.log?.(`semantic index: migrated ${Object.keys(files).length} file(s) from embeddings.json into sharded storage`);
    } catch (e) {
      // Migration failed — leave the legacy file alone so the next attempt can
      // try again rather than losing an index that is still perfectly readable.
      this.log?.('semantic index: migration failed, keeping embeddings.json — ' + e.message);
      return null;
    }
    return migrated;
  }

  // `only` is a Set of shard ids to rewrite, or null for all of them.
  async _writeShards(dir, index, only) {
    const shardDir = path.join(dir, 'embeddings');
    await fs.promises.mkdir(shardDir, { recursive: true });

    const buckets = new Map();
    for (const [rel, f] of Object.entries(index.files)) {
      const id = shardOf(rel);
      if (only && !only.has(id)) continue;
      let bucket = buckets.get(id);
      if (!bucket) buckets.set(id, bucket = {});
      bucket[rel] = {
        mtimeMs: f.mtimeMs, size: f.size,
        chunks: f.chunks.map(c => ({ s: c.startLine, e: c.endLine, v: encodeVector(c.vector) })),
      };
    }

    // Iterate the DIRTY set, not the buckets: a shard whose last file was just
    // deleted produces no bucket, and skipping it would leave the old file on
    // disk for the next read to resurrect.
    const ids = only ? [...only] : [...buckets.keys()];
    let oversized = 0;
    for (const id of ids) {
      const files = buckets.get(id) || {};
      const target = path.join(shardDir, `shard-${id}.json`);
      if (!Object.keys(files).length) {
        try { await fs.promises.unlink(target); } catch { /* already absent */ }
        continue;
      }
      const json = JSON.stringify({ v: EMBED_INDEX_VERSION, model: index.model, provider: index.provider, files });
      if (json.length > EMBED_SHARD_MAX_BYTES) { oversized++; continue; }
      await fs.promises.writeFile(target, json, 'utf8');
    }
    if (oversized) {
      this.log?.(`semantic index: ${oversized} shard(s) exceeded ${EMBED_SHARD_MAX_BYTES / 1048576} MB and were not written — those files re-embed next session, the rest of the index is unaffected`);
    }
  }

  // Called whenever a file's entry is written or removed, so the debounced save
  // knows which shards to rewrite instead of rewriting all of them.
  _markEmbedShardDirty(rel) {
    this._embedIndexCache?.dirty?.add(shardOf(rel));
  }

  _markAllEmbedShardsDirty() {
    const dirty = this._embedIndexCache?.dirty;
    if (!dirty) return;
    for (let i = 0; i < EMBED_SHARD_COUNT; i++) dirty.add(i.toString(16).padStart(2, '0'));
  }

  _saveEmbeddingIndex() {
    clearTimeout(this._embedSaveTimer);
    this._embedSaveTimer = setTimeout(async () => {
      const dir = await this.ensureNavyDir();
      const cache = this._embedIndexCache;
      if (!dir || !cache) return;
      const dirty = cache.dirty && cache.dirty.size ? new Set(cache.dirty) : null;
      if (!dirty) return; // nothing changed since the last write
      cache.dirty.clear();
      try {
        await this._writeShards(dir, cache, dirty);
      } catch (e) {
        // Put the shards back on the dirty list so the next save retries them
        // rather than silently leaving them stale on disk forever.
        for (const id of dirty) cache.dirty.add(id);
        this.log?.('embedding index persist failed: ' + e.message);
      }
    }, 500);
  }

  // Stat-only walk (no content read) — used to detect which files need
  // (re-)embedding without paying the cost of reading files that haven't changed.
  // The contents of everything returned here get POSTed to a third-party
  // embeddings API, so this list is filtered far more conservatively than the
  // keyword walker: credential-shaped filenames are dropped outright, and
  // anything the repo gitignores is skipped (gitignored files are exactly the
  // ones most likely to hold local secrets).
  async _listCodeFiles(root, { maxFiles = 1500, maxBytes = 300 * 1024 } = {}) {
    const ignored = await this._gitIgnoredSet(root);
    const out = [];
    const skipped = { sensitive: 0, gitignored: 0 };
    let scanned = 0;
    const walk = async (dir) => {
      if (scanned >= maxFiles) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (scanned >= maxFiles) return;
        if (e.isDirectory()) {
          if (!RELEVANCE_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name));
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (!RELEVANCE_CODE_EXTS.has(ext)) continue;
        if (isSensitiveForEmbedding(e.name)) { skipped.sensitive++; continue; }
        const full = path.join(dir, e.name);
        const rel = path.relative(root, full).replace(/\\/g, '/');
        if (ignored.has(rel)) { skipped.gitignored++; continue; }
        let st;
        try { st = await fs.promises.stat(full); } catch { continue; }
        if (st.size > maxBytes) continue;
        scanned++;
        out.push({ rel, full, mtimeMs: st.mtimeMs, size: st.size });
      }
    };
    await walk(root);
    if (skipped.sensitive || skipped.gitignored) {
      this.log?.(`semantic index: skipped ${skipped.sensitive} credential-shaped and ${skipped.gitignored} gitignored file(s) — their contents were not uploaded`);
    }
    return out;
  }

  // Repo-relative paths git considers ignored. Uses git itself so real
  // .gitignore semantics (negations, nested files, globs) are respected rather
  // than reimplemented. Returns an empty set when git isn't available or this
  // isn't a repo — the credential-name filter still applies in that case.
  async _gitIgnoredSet(root) {
    if (this._gitIgnoredCache?.root === root && Date.now() - this._gitIgnoredCache.time < 60_000) {
      return this._gitIgnoredCache.set;
    }
    const set = new Set();
    try {
      // runGit already runs in the project root.
      const out = await this.runGit(['ls-files', '--others', '--ignored', '--exclude-standard']);
      for (const line of String(out || '').split(/\r?\n/)) {
        const t = line.trim();
        if (t) set.add(t.replace(/\\/g, '/'));
      }
    } catch { /* not a repo / git missing — name filter still applies */ }
    this._gitIgnoredCache = { root, time: Date.now(), set };
    return set;
  }

  // Incrementally (re-)embeds only new/changed files, drops entries for
  // deleted files, and persists. Returns the up-to-date file→{vector} map, or
  // null when semantic search isn't usable this session (not configured, or
  // the provider/model rejected the request) — callers treat null as
  // "unavailable" and silently fall back, never as an error.
  async _updateEmbeddingIndex(root) {
    const config = vscode.workspace.getConfiguration('navy');
    const model = config.get('embeddingModel', '').trim();
    if (!model) return null;
    // Uploading repo contents from a folder the user explicitly declined to
    // trust would be the worst possible time to do it.
    if (!workspaceIsTrusted()) return null;
    const provider = config.get('provider', 'ollama');
    // Already failed once this session for this exact provider+model — don't
    // hammer a broken endpoint on every single find_relevant_files call.
    if (this._embedUnavailable === provider + ':' + model) return null;

    // find_relevant_files is READ_ONLY, so two calls in one iteration run
    // concurrently. Without this, both would compute the same "needs embedding"
    // list (neither has written results yet) and upload the entire repo twice —
    // double cost, and a resulting 429 would latch _embedUnavailable and kill
    // semantic search for the rest of the session. Concurrent callers share the
    // in-flight run instead.
    if (this._embedInFlight) return this._embedInFlight;
    this._embedInFlight = this._updateEmbeddingIndexInner(root, config, model, provider)
      .finally(() => { this._embedInFlight = null; });
    return this._embedInFlight;
  }

  async _updateEmbeddingIndexInner(root, config, model, provider) {
    const index = await this._loadEmbeddingIndex(root);
    // A model or provider change invalidates the whole index — vectors from
    // different embedding spaces aren't comparable to each other.
    if (index.model !== model || index.provider !== provider) {
      index.model = model; index.provider = provider; index.files = {};
      // Every shard now holds vectors from the old space — all of them have to
      // be rewritten (which, with no files left, means deleted).
      this._markAllEmbedShardsDirty();
    }

    const current = await this._listCodeFiles(root);
    const currentRels = new Set(current.map(f => f.rel));
    for (const rel of Object.keys(index.files)) {
      if (!currentRels.has(rel)) { delete index.files[rel]; this._markEmbedShardDirty(rel); }
    }

    const toEmbed = current.filter(f => {
      const cached = index.files[f.rel];
      return !cached || cached.mtimeMs !== f.mtimeMs || cached.size !== f.size;
    });
    if (toEmbed.length === 0) return Object.keys(index.files).length ? index.files : null;

    const apiBase = config.get('apiBase', '');
    // Ollama-aware: cloud mode sends embeddings to ollama.com, not navy.host.
    const host = this._hostForProvider(provider);
    const apiKey = await this.context.secrets.get('navy.apiKey.' + provider) || await this.context.secrets.get('navy.apiKey') || '';

    // Chunk every file needing (re-)embedding, then flatten into one text
    // list — a large file contributes several chunks, an ordinary small one
    // contributes exactly one (see chunkFileForEmbedding). Batching by
    // flattened TEXT count (not file count) keeps each embeddings API call
    // bounded the same way it always was, even though one file can now
    // expand into several inputs.
    const fileChunks = new Map(); // rel -> chunk[] (vector filled in below)
    const flatTexts = [];
    const flatOwners = []; // parallel: which (rel, chunk index) each flatText belongs to
    for (const f of toEmbed) {
      let content = '';
      try { content = await fs.promises.readFile(f.full, 'utf8'); } catch {}
      const chunks = chunkFileForEmbedding(f.rel, content);
      fileChunks.set(f.rel, chunks);
      chunks.forEach((c, idx) => { flatTexts.push(c.text); flatOwners.push({ rel: f.rel, idx }); });
    }

    const BATCH = 32;
    for (let i = 0; i < flatTexts.length; i += BATCH) {
      const textBatch = flatTexts.slice(i, i + BATCH);
      const ownerBatch = flatOwners.slice(i, i + BATCH);
      let vectors;
      try {
        vectors = await getEmbeddings(provider, model, textBatch, { apiBase, host, apiKey });
      } catch (e) {
        this.log?.('semantic search disabled — embeddings request failed: ' + e.message);
        this._embedUnavailable = provider + ':' + model;
        return Object.keys(index.files).length ? index.files : null; // keep whatever was already indexed
      }
      // Only cache a vector that is actually usable. Caching a malformed one
      // alongside a valid mtime/size would poison the index permanently: the
      // change check would never re-embed it, and every later similarity call
      // would throw on it. A partial failure (some chunks of a file got a
      // vector, others didn't) still keeps the chunks that succeeded — no
      // reason to discard a whole large file's good data over one bad chunk.
      ownerBatch.forEach((owner, j) => {
        const v = vectors[j];
        if (Array.isArray(v) && v.length) fileChunks.get(owner.rel)[owner.idx].vector = v;
      });
    }

    for (const f of toEmbed) {
      const chunks = fileChunks.get(f.rel);
      const usable = chunks.filter(c => Array.isArray(c.vector) && c.vector.length);
      if (usable.length === 0) {
        delete index.files[f.rel];
        this._markEmbedShardDirty(f.rel);
        this.log?.(`semantic index: provider returned no usable vector for ${f.rel} — skipped`);
        continue;
      }
      index.files[f.rel] = {
        mtimeMs: f.mtimeMs, size: f.size,
        chunks: usable.map(c => ({ startLine: c.startLine, endLine: c.endLine, vector: c.vector })),
      };
      this._markEmbedShardDirty(f.rel);
    }
    this._saveEmbeddingIndex();
    return index.files;
  }

  // Embeds the query and scores every indexed file by cosine similarity.
  // Returns null when semantic search isn't usable at all this session
  // (not configured, index empty, or the query embedding call failed).
  async _semanticCandidates(root, query) {
    const files = await this._updateEmbeddingIndex(root);
    if (!files || !Object.keys(files).length) return null;
    const config = vscode.workspace.getConfiguration('navy');
    const model = config.get('embeddingModel', '').trim();
    const provider = config.get('provider', 'ollama');
    const apiBase = config.get('apiBase', '');
    // Ollama-aware: cloud mode sends embeddings to ollama.com, not navy.host.
    const host = this._hostForProvider(provider);
    const apiKey = await this.context.secrets.get('navy.apiKey.' + provider) || await this.context.secrets.get('navy.apiKey') || '';
    let queryVec;
    try {
      [queryVec] = await getEmbeddings(provider, model, [query], { apiBase, host, apiKey });
    } catch { return null; }
    if (!queryVec) return null;
    // cosineSimilarity throws on a dimension mismatch rather than silently
    // comparing a truncated prefix — filter those out here so one stale/
    // corrupted cache entry (e.g. left over from a since-changed embedding
    // model) can't take down semantic ranking for every OTHER file too.
    let mismatched = 0;
    const scored = [];
    for (const [rel, f] of Object.entries(files)) {
      // Score every chunk, keep the file's BEST-matching one — a hit reports
      // that chunk's line range so the model can jump straight to it with
      // read_lines instead of re-reading (or guessing at) the whole file.
      let best = null;
      for (const chunk of f.chunks) {
        if (chunk.vector.length !== queryVec.length) { mismatched++; continue; }
        const similarity = cosineSimilarity(queryVec, chunk.vector);
        if (!best || similarity > best.similarity) best = { similarity, startLine: chunk.startLine, endLine: chunk.endLine };
      }
      if (best) scored.push({ rel, similarity: best.similarity, startLine: best.startLine, endLine: best.endLine });
    }
    if (mismatched) this.log?.(`semantic search: skipped ${mismatched} chunk(s) with a mismatched vector dimension`);
    return scored.sort((a, b) => b.similarity - a.similarity).slice(0, 15);
  }

  // Pure merge: keyword-ranked hits + semantic candidates → one combined,
  // re-sorted list. A file present in both gets a semantic bonus added to its
  // keyword score; a semantic-only file (no keyword overlap at all — the
  // whole point of semantic search) is added as a new entry, above a
  // similarity floor so weakly-related files don't pollute the results just
  // because they ranked highest among a bad match set.
  _blendSemanticRanking(ranked, semantic, threshold = 0.45) {
    const bySemantic = new Map(semantic.map(s => [s.rel, s]));
    const seen = new Set(ranked.map(h => h.rel));
    const merged = ranked.map(h => {
      const s = bySemantic.get(h.rel);
      if (!s) return h;
      return { ...h, score: h.score + Math.round(s.similarity * 20), semantic: true, semanticRange: { startLine: s.startLine, endLine: s.endLine } };
    });
    for (const s of semantic) {
      if (seen.has(s.rel) || s.similarity < threshold) continue;
      merged.push({
        rel: s.rel, count: 0, matched: [], inName: false, defs: false, semantic: true,
        semanticRange: { startLine: s.startLine, endLine: s.endLine }, score: Math.round(s.similarity * 20),
      });
    }
    return merged.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  }

  // Blends real language-server symbol matches into the ranking — an actual
  // LSP definition is a much stronger "this file defines what you asked
  // about" signal than _collectRelevance's DEF_KW regex guess, and it's
  // available for free wherever the user already has a language extension
  // installed (the common case). Only queries the single highest-weighted
  // term — one workspace-symbol call per request keeps this cheap; the model
  // can always call find_symbol itself for a specific name. Returns []
  // (never throws) when no language server answers, so keyword-only ranking
  // is completely unaffected when this has nothing to add.
  async _lspSymbolCandidates(root, terms) {
    if (!terms.length) return [];
    const query = terms[0].term;
    try {
      const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query);
      if (!symbols || !symbols.length) return [];
      const best = new Map(); // rel -> best score seen
      for (const sym of symbols.slice(0, 20)) {
        const fp = sym.location?.uri?.fsPath;
        if (!fp) continue;
        const rel = path.relative(root, fp).replace(/\\/g, '/');
        if (rel.startsWith('..')) continue; // symbol lives outside this project root
        // An exact name match to the query term is a much stronger signal
        // than a fuzzy/substring match the symbol provider may also return.
        const score = sym.name.toLowerCase() === query.toLowerCase() ? 15 : 8;
        if (!best.has(rel) || best.get(rel) < score) best.set(rel, score);
      }
      return [...best.entries()].map(([rel, score]) => ({ rel, score }));
    } catch { return []; }
  }

  // Per-file symbol outline (top-level function/class/method names) for
  // buildRepoMap — the SAME real language-server infrastructure
  // _lspSymbolCandidates/find_symbol already use, not a new parser. A bare
  // file tree tells the model NOTHING about what's inside a file; this gives
  // it real signatures to reason about before deciding what to read, at zero
  // cost when no language server is active for that file type (returns ''
  // and buildRepoMap shows the plain filename, exactly as before). Bounded
  // to a short timeout so one slow/hung provider can't stall building the
  // map for the whole turn — buildRepoMap calls this across many files in
  // parallel, so the bound is per-call, not cumulative.
  async _fileSymbolOutline(uri) {
    const INTERESTING = new Set([
      vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Function,
      vscode.SymbolKind.Method, vscode.SymbolKind.Constructor, vscode.SymbolKind.Enum,
      vscode.SymbolKind.Struct,
    ]);
    try {
      const symbols = await Promise.race([
        vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri),
        new Promise(resolve => setTimeout(() => resolve(undefined), 400)),
      ]);
      if (!symbols || !symbols.length) return '';
      const names = [];
      for (const s of symbols) {
        if (names.length >= 8) break;
        if (!INTERESTING.has(s.kind)) continue;
        if (s.name) names.push(s.name);
      }
      return names.length ? ' — ' + names.join(', ') : '';
    } catch { return ''; }
  }

  async toolFindRelevantFiles(query, maxResults = 8, folder) {
    const resolved = this._resolveTargetFolder(folder);
    if (resolved.error) return resolved.error;
    const root = resolved.root;
    if (!root) return 'No workspace open.';
    const terms = this._tokenizeQuery(query);
    if (!terms.length) return 'Give a more specific query — identifiers, symbol names, or distinctive keywords.';
    const hits = await this._collectRelevance(root, terms);
    let ranked = this._rankRelevance(hits, terms);

    // Real LSP symbol matches are a stronger "this file defines something
    // you asked about" signal than the regex-based `defs` guess above —
    // blend them in before semantic search, so a file can earn both bonuses.
    try {
      const lspHits = await this._lspSymbolCandidates(root, terms);
      for (const lsp of lspHits) {
        const existing = ranked.find(h => h.rel === lsp.rel);
        if (existing) { existing.score += lsp.score; existing.lspMatch = true; }
        else ranked.push({ rel: lsp.rel, count: 0, matched: [], inName: false, defs: false, lspMatch: true, score: lsp.score });
      }
      ranked.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
    } catch (e) { this.log?.('LSP symbol blend failed, using keyword results only: ' + e.message); }

    // Semantic search is scoped to the ACTIVE project only, even when `folder`
    // targets a sibling: the embeddings cache (.navy/embeddings.json) is
    // persisted via getNavyDir(), which is anchored to this.projectRoot, not
    // to whichever root is being searched — running it against a sibling
    // folder would read/write the wrong project's cache file. Keyword and LSP
    // search above have no such per-root persistence and work across any
    // open folder already.
    let usedSemantic = false;
    if (root === (this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)) {
      try {
        const semantic = await this._semanticCandidates(root, query);
        if (semantic && semantic.length) { ranked = this._blendSemanticRanking(ranked, semantic); usedSemantic = true; }
      } catch (e) { this.log?.('semantic search failed, using keyword results only: ' + e.message); }
    }

    ranked = ranked.slice(0, Math.max(1, Math.min(maxResults || 8, 25)));
    if (!ranked.length) return `No files matched: ${terms.map(t => t.term).join(', ')}`;
    const header = `Ranked by relevance to: ${terms.map(t => t.term).join(', ')}${usedSemantic ? ' (keyword + semantic)' : ''}\n`;
    return header + ranked.map(h => {
      const semanticNote = h.semantic ? ', semantic-match' + (h.semanticRange ? ` at lines ${h.semanticRange.startLine}-${h.semanticRange.endLine}` : '') : '';
      return `${h.rel}  [score ${h.score}${h.defs ? ', defines' : ''}${h.inName ? ', name-match' : ''}${h.lspMatch ? ', LSP-defines' : ''}${semanticNote}; matched: ${h.matched.join(', ') || '—'}]`;
    }).join('\n');
  }

  async buildRepoMap() {
    const root = this.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'PROJECT ROOT UNKNOWN — do NOT invent file names or project names. Tell the user to open a folder in VS Code first.';

    // The map is rebuilt on every message but the tree rarely changes that fast —
    // cache per root for 30 s to keep prompt latency off the filesystem.
    if (this._repoMapCache?.root === root && Date.now() - this._repoMapCache.time < 30_000) {
      return this._repoMapCache.map;
    }

    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'coverage', '.cache']);
    const lines = [];
    // Symbol outlines (see _fileSymbolOutline) are fetched for at most this
    // many files per build, across the whole tree — bounds total LSP calls
    // regardless of repo size. { idx: position in `lines` to enrich, uri }.
    const SYMBOL_CALL_CAP = 30;
    const symbolTargets = [];

    const walk = async (dir, prefix, depth) => {
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch { return; }
      const dirs = entries.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'));
      const files = entries.filter(e => e.isFile());
      for (const f of files.slice(0, 40)) {
        const idx = lines.length;
        lines.push(prefix + f.name); // enriched with a symbol outline below, if this file gets a slot
        if (symbolTargets.length < SYMBOL_CALL_CAP && RELEVANCE_CODE_EXTS.has(path.extname(f.name).toLowerCase())) {
          symbolTargets.push({ idx, uri: vscode.Uri.file(path.join(dir, f.name)) });
        }
      }
      if (files.length > 40) lines.push(prefix + `… (${files.length - 40} more files)`);
      if (depth < 2) {
        for (const d of dirs.slice(0, 15)) {
          lines.push(prefix + d.name + '/');
          await walk(path.join(dir, d.name), prefix + '  ', depth + 1);
        }
      } else {
        for (const d of dirs.slice(0, 10)) lines.push(prefix + d.name + '/');
      }
    };

    try {
      await walk(root, '', 0);

      // Fetch every file's symbol outline IN PARALLEL — each call is
      // individually time-boxed (_fileSymbolOutline), so running them
      // concurrently bounds the total wall-clock cost to about one timeout
      // window, not a multiple of the file count. Must happen before any
      // further pushes/unshifts below, since symbolTargets recorded exact
      // `lines` indices during the walk.
      if (symbolTargets.length) {
        await Promise.all(symbolTargets.map(async (t) => {
          const outline = await this._fileSymbolOutline(t.uri);
          if (outline) lines[t.idx] += outline;
        }));
      }

      // Try common project manifest files to get real project name.
      let projectMeta = '';
      for (const [file, parse] of [
        ['package.json', t => { const p = JSON.parse(t); return p.name + (p.description ? ' — ' + p.description : ''); }],
        ['Cargo.toml',   t => { const m = t.match(/name\s*=\s*"([^"]+)"/); return m ? m[1] : ''; }],
        ['pyproject.toml', t => { const m = t.match(/name\s*=\s*"([^"]+)"/); return m ? m[1] : ''; }],
        ['go.mod',       t => { const m = t.match(/^module\s+(\S+)/m); return m ? m[1] : ''; }],
      ]) {
        try {
          const txt = await fs.promises.readFile(path.join(root, file), 'utf8');
          projectMeta = parse(txt);
          if (projectMeta) break;
        } catch { /* not this type */ }
      }
      if (projectMeta) lines.unshift('Project: ' + projectMeta);

      // Multi-root hint: note sibling open folders exist without walking or
      // fully mapping them (that would double prompt size on every message
      // by default) — the model can target one explicitly via the `folder`
      // argument on search_codebase/search_files/list_files/find_relevant_files,
      // or resolveWorkspacePath already accepts an absolute path inside any
      // of them regardless.
      const siblings = (vscode.workspace.workspaceFolders || [])
        .map(f => f.uri.fsPath)
        .filter(fp => foldPath(fp) !== foldPath(root));
      if (siblings.length) {
        lines.push(`\nOther open folders (pass folder: "<path>" to search_codebase/search_files/list_files/find_relevant_files to target one): ${siblings.join(', ')}`);
      }

      const map = lines.join('\n') || 'Empty project directory';
      this._repoMapCache = { root, time: Date.now(), map };
      return map;
    } catch (error) {
      return 'Could not build repo map: ' + error.message;
    }
  }
}

module.exports = {
  RETRIEVAL_METHODS: RetrievalMethods.prototype,
  // Re-exported because extension.js still needs them: RELEVANCE_SKIP_DIRS for
  // the file watcher's ignore list, isSensitiveForEmbedding for the inline-
  // completion eligibility check, and the vector helpers for the tests.
  RELEVANCE_SKIP_DIRS, RELEVANCE_CODE_EXTS, isSensitiveForEmbedding,
  encodeVector, decodeVector, shardOf,
};
