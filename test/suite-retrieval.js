const {
  fs, path, check, makeContext, sharedMock,
} = require('./harness.js');

// ── 6. Retrieval (find_relevant_files) — pure ranking + real temp-repo ───────
async function retrievalSuite() {
  console.log('\nretrieval:');
  const os = require('os');
  const { vscode } = sharedMock();

  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-retr-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    // Pure: tokenizer drops filler, splits camelCase, keeps identifiers.
    const terms = provider._tokenizeQuery('please fix the parseUserToken auth bug').map(t => t.term);
    check('tokenize keeps salient identifier', terms.includes('parseusertoken'));
    check('tokenize splits camelCase', terms.includes('parse') && terms.includes('token'));
    check('tokenize drops filler words', !terms.includes('please') && !terms.includes('the') && !terms.includes('bug'));

    // Pure: ranker prefers definer + filename match over raw frequency.
    const ranked = provider._rankRelevance([
      { rel: 'a.js', count: 40, matched: ['auth'], inName: false, defs: false },
      { rel: 'auth.js', count: 3, matched: ['auth'], inName: true, defs: true },
    ], [{ term: 'auth', weight: 2 }]);
    check('ranker: definer+name-match beats raw frequency', ranked[0].rel === 'auth.js');

    // Pure: semantic blend — a file present in both keyword and semantic
    // results gets a bonus (not a replacement); a semantic-ONLY file (no
    // keyword overlap at all — the entire point of semantic search) is added
    // as a new entry; a weak semantic match below the threshold is dropped.
    const keywordOnly = [{ rel: 'a.js', count: 5, matched: ['x'], inName: false, defs: false, score: 10 }];
    const blended = provider._blendSemanticRanking(keywordOnly, [
      { rel: 'a.js', similarity: 0.9 },     // overlaps a keyword hit → bonus, not duplicate
      { rel: 'session-store.js', similarity: 0.8 }, // semantic-only, above threshold → new entry
      { rel: 'unrelated.js', similarity: 0.1 },     // below threshold → dropped
    ]);
    check('semantic blend: overlapping file gets a score bonus, not a duplicate row',
      blended.filter(h => h.rel === 'a.js').length === 1 && blended.find(h => h.rel === 'a.js').score > 10);
    check('semantic blend: semantic-only match (no keyword overlap) is included',
      blended.some(h => h.rel === 'session-store.js' && h.semantic));
    check('semantic blend: weak match below threshold is excluded',
      !blended.some(h => h.rel === 'unrelated.js'));

    // Pure: cosine similarity (embeddings.js).
    const { cosineSimilarity } = require('../src/providers/embeddings.js');
    check('cosineSimilarity: identical vectors → 1', Math.abs(cosineSimilarity([1, 0, 1], [1, 0, 1]) - 1) < 1e-9);
    check('cosineSimilarity: orthogonal vectors → 0', Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
    check('cosineSimilarity: opposite vectors → -1', Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
    check('cosineSimilarity: zero vector handled without NaN/throw', cosineSimilarity([0, 0], [1, 1]) === 0);

    // Integration: real files, real walk, real scoring through the tool.
    fs.writeFileSync(path.join(tmp, 'auth.js'), 'function parseUserToken(t){ return verify(t); }\nclass AuthService {}');
    fs.writeFileSync(path.join(tmp, 'ui.js'), 'export function renderButton(){ return "<button>"; }');
    fs.writeFileSync(path.join(tmp, 'notes.md'), 'nothing relevant here about widgets');
    const out = await provider.toolFindRelevantFiles('where is parseUserToken defined for auth', 5);
    const lines = out.split('\n').filter(l => l.includes('.js') || l.includes('.md'));
    check('retrieval ranks the defining file first', lines[0] && lines[0].includes('auth.js'));
    check('retrieval marks the definer', /auth\.js.*defines/.test(out));
    check('retrieval excludes irrelevant files', !out.includes('notes.md'));
    const empty = await provider.toolFindRelevantFiles('zzz', 5);
    check('retrieval handles no-match gracefully', /No files matched|more specific/.test(empty));
  } catch (e) {
    check('retrieval suite ran', false, e.stack || e.message);
  } finally {
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 6b. Semantic search (navy.embeddingModel) — provider routing + incremental index ──
async function semanticSearchSuite() {
  console.log('\nsemantic search (embeddings):');
  const os = require('os');
  const { vscode } = sharedMock();

  // Provider routing: Ollama gets its native /api/embed; everything else
  // (including Gemini, which exposes an OpenAI-compat facade) goes through
  // the shared OpenAI-compatible /embeddings endpoint.
  {
    const { getEmbeddings } = require('../src/providers/embeddings.js');
    const realFetch = global.fetch;
    try {
      let capturedUrl = '', capturedBody = null;
      global.fetch = async (url, init) => {
        capturedUrl = url; capturedBody = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ embeddings: [[1, 0], [0, 1]] }) };
      };
      const ollamaVecs = await getEmbeddings('ollama', 'nomic-embed-text', ['a', 'b'], { host: 'http://localhost:11434' });
      check('embeddings: ollama routes to /api/embed', capturedUrl === 'http://localhost:11434/api/embed');
      check('embeddings: ollama sends batched input array', Array.isArray(capturedBody.input) && capturedBody.input.length === 2);
      check('embeddings: ollama returns vectors in order', ollamaVecs.length === 2 && ollamaVecs[0][0] === 1);

      global.fetch = async (url, init) => {
        capturedUrl = url; capturedBody = JSON.parse(init.body);
        // Deliberately out of index order — caller must sort by `index`, not trust array order.
        return { ok: true, status: 200, json: async () => ({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }) };
      };
      const openaiVecs = await getEmbeddings('openai', 'text-embedding-3-small', ['a', 'b'], { apiKey: 'sk-x' });
      check('embeddings: openai routes to /embeddings', capturedUrl === 'https://api.openai.com/v1/embeddings');
      check('embeddings: openai response re-sorted by index, not array order', openaiVecs[0][0] === 1 && openaiVecs[1][1] === 1);

      const geminiVecs = await getEmbeddings('gemini', 'text-embedding-004', ['a', 'b'], { apiKey: 'k' });
      check('embeddings: gemini routes through the OpenAI-compat facade too', capturedUrl.includes('generativelanguage.googleapis.com') && capturedUrl.endsWith('/embeddings'));

      global.fetch = async () => ({ ok: false, status: 404, text: async () => 'no such route' });
      let threw = false;
      try { await getEmbeddings('groq', 'whatever', ['a']); } catch { threw = true; }
      check('embeddings: unsupported provider failure throws (caller falls back), never returns wrong data', threw);
    } catch (e) {
      check('embeddings provider-routing suite ran', false, e.stack || e.message);
    } finally {
      global.fetch = realFetch;
    }
  }

  // Incremental index + hybrid ranking, through the real provider + real temp files.
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-semantic-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    await vscode.workspace.getConfiguration().update('embeddingModel', 'fake-embed');
    await vscode.workspace.getConfiguration().update('provider', 'ollama');

    // "session-store.js" deliberately shares NO keyword with the query — only
    // a real semantic search (not the keyword ranker) can surface it.
    fs.writeFileSync(path.join(tmp, 'auth.js'), 'function login(u,p){ return checkCreds(u,p); }');
    fs.writeFileSync(path.join(tmp, 'session-store.js'), 'function persistUserSession(id){ cache.set(id, Date.now()); }');
    fs.writeFileSync(path.join(tmp, 'unrelated.js'), 'function renderChart(data){ return draw(data); }');

    // Deterministic fake embedder: each file/query gets a fixed vector based on
    // content, so we can assert exact similarity relationships without needing
    // a real model. session-store.js is engineered to be closest to the query.
    const VECS = {
      'auth.js\n\nfunction login(u,p){ return checkCreds(u,p); }': [1, 0, 0],
      'session-store.js\n\nfunction persistUserSession(id){ cache.set(id, Date.now()); }': [0.9, 0.1, 0],
      'unrelated.js\n\nfunction renderChart(data){ return draw(data); }': [0, 0, 1],
      'how do we keep track of a logged-in user between requests': [0.85, 0.15, 0],
    };
    let embedCallCount = 0;
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      embedCallCount++;
      const vectors = body.input.map(t => VECS[t] || [0, 0, 0]);
      return { ok: true, status: 200, json: async () => ({ embeddings: vectors }) };
    };

    const out1 = await provider.toolFindRelevantFiles('how do we keep track of a logged-in user between requests', 5);
    check('semantic: header notes hybrid keyword+semantic ranking was used', out1.includes('keyword + semantic'));
    check('semantic: semantic-only file (no shared keywords) surfaces via meaning', out1.includes('session-store.js'));
    check('semantic: semantic-match annotation shown', /session-store\.js.*semantic-match/.test(out1));
    const firstCallCount = embedCallCount;
    await new Promise(r => setTimeout(r, 600)); // index persistence is debounced 500ms
    // Sharded since 0.2.7 — one flat embeddings.json was capped at 24 MB and
    // silently not persisted past it. See embedIndexSuite for the storage
    // itself; this only asserts the end-to-end path really wrote something.
    const shardDir = path.join(tmp, '.navy', 'embeddings');
    check('semantic: index actually persisted to .navy/embeddings/',
      fs.existsSync(shardDir) && fs.readdirSync(shardDir).some(n => n.endsWith('.json')),
      fs.existsSync(shardDir) ? fs.readdirSync(shardDir).join(',') : 'no shard dir');

    // Second call, nothing changed on disk — must NOT re-embed anything (only
    // the query itself needs a fresh embedding call).
    await provider.toolFindRelevantFiles('how do we keep track of a logged-in user between requests', 5);
    check('semantic: unchanged files are not re-embedded on a second call', embedCallCount === firstCallCount + 1);

    // Modify one file — only THAT file's batch call should contain 1 input,
    // not all 3 (fetch-CALL count alone can't tell this apart from a full
    // re-embed, since 3 files still fit in one batch — inspect the actual
    // batch payload sizes instead).
    await new Promise(r => setTimeout(r, 10)); // ensure a distinct mtime
    fs.writeFileSync(path.join(tmp, 'unrelated.js'), 'function renderChart(data){ return draw(data); } // changed');
    VECS['unrelated.js\n\nfunction renderChart(data){ return draw(data); } // changed'] = [0, 0, 1];
    const batchSizes = [];
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      embedCallCount++;
      batchSizes.push(body.input.length);
      const vectors = body.input.map(t => VECS[t] || [0, 0, 0]);
      return { ok: true, status: 200, json: async () => ({ embeddings: vectors }) };
    };
    await provider.toolFindRelevantFiles('how do we keep track of a logged-in user between requests', 5);
    // Two fetch calls: the index-update batch (1 changed file) and the query
    // embedding (1 query string) — neither batch is the full 3-file repo.
    check('semantic: only the changed file is re-embedded, not the whole repo',
      batchSizes.length === 2 && batchSizes.includes(1) && !batchSizes.includes(3));

    // navy.embeddingModel unset (default) → zero behavior change, zero embedding calls.
    await vscode.workspace.getConfiguration().update('embeddingModel', '');
    embedCallCount = 0;
    const outDisabled = await provider.toolFindRelevantFiles('how do we keep track of a logged-in user', 5);
    check('semantic: disabled by default — no embedding calls attempted', embedCallCount === 0);
    check('semantic: disabled — header has no "semantic" mention', !outDisabled.includes('semantic'));
  } catch (e) {
    check('semantic search integration suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    await vscode.workspace.getConfiguration().update('embeddingModel', '');
    await vscode.workspace.getConfiguration().update('provider', 'ollama');
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 6c. Retrieval upgrades — chunked embeddings + real LSP symbol blending ───
async function retrievalUpgradesSuite() {
  console.log('\nretrieval upgrades (chunked embeddings + LSP blend):');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();

  // Chunking: a symbol buried well past the OLD single-file 1,500-char /
  // one-window cutoff must now be findable by semantic search.
  let provider, tmp;
  const realFetch = global.fetch;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-chunking-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    await vscode.workspace.getConfiguration().update('embeddingModel', 'fake-embed');
    await vscode.workspace.getConfiguration().update('provider', 'ollama');

    // 200 lines: filler lines are long enough (~50 chars each) that the
    // marker function, placed at line 150, sits well past 1,500 chars into
    // the file — unreachable by the pre-chunking single-slice embed. With
    // 120-line windows / 20-line overlap it lands in the SECOND chunk
    // (lines 101-200), never the first (1-120), so finding it proves multi-
    // chunk indexing actually happened rather than being a lucky truncation.
    const lines = [];
    for (let i = 1; i <= 200; i++) {
      lines.push(i === 150
        ? 'function trackActiveUserSession(id){ registry.set(id, Date.now()); }'
        : `// filler filler filler filler filler filler line ${i}`);
    }
    fs.writeFileSync(path.join(tmp, 'bigfile.js'), lines.join('\n'));

    // Content-based fake embedder (not an exact-string lookup) so the test
    // doesn't have to reproduce chunkFileForEmbedding's exact slicing math.
    const vectorFor = (text) => {
      if (text.includes('trackActiveUserSession')) return [0.9, 0.1, 0];
      if (text.includes('logged-in user')) return [0.85, 0.15, 0]; // the query text
      return [0, 0, 1]; // filler / unrelated chunks
    };
    const capturedTexts = [];
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      capturedTexts.push(...body.input);
      return { ok: true, status: 200, json: async () => ({ embeddings: body.input.map(vectorFor) }) };
    };

    const out = await provider.toolFindRelevantFiles('how do we keep track of a logged-in user between requests', 5);
    check('chunking: the marker line actually reached the embedder (proves the 1,500-char cutoff was bypassed)',
      capturedTexts.some(t => t.includes('trackActiveUserSession')));
    check('chunking: file containing a symbol past the old cutoff is now found via semantic search', out.includes('bigfile.js'));
    check('chunking: reported hit points at the chunk that actually matched (lines 101-200), not the whole file',
      /bigfile\.js.*semantic-match at lines 101-200/.test(out));
  } catch (e) {
    check('chunking suite ran', false, e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    await vscode.workspace.getConfiguration().update('embeddingModel', '');
    await vscode.workspace.getConfiguration().update('provider', 'ollama');
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    provider = null; tmp = null;
  }

  // LSP symbol blend: a real language-server definition surfaces a file with
  // ZERO keyword overlap with the query, same as semantic search does — but
  // needs no embeddingModel configured at all.
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-lspblend-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    await vscode.workspace.getConfiguration().update('embeddingModel', ''); // semantic search off — isolates the LSP path

    fs.writeFileSync(path.join(tmp, 'helper-utils.js'), 'function unrelatedHelper(x){ return x*2; }');

    // Query is a single distinctive identifier so _tokenizeQuery's top term
    // is exactly this name (whole-identifier weight 2 beats any split part).
    ctrl.nextWorkspaceSymbols = [{
      name: 'AuthTokenValidator',
      location: { uri: { fsPath: path.join(tmp, 'helper-utils.js') }, range: { start: { line: 0, character: 0 } } },
    }];
    const withLsp = await provider.toolFindRelevantFiles('AuthTokenValidator', 5);
    check('LSP blend: a real language-server definition surfaces a file with no keyword overlap',
      withLsp.includes('helper-utils.js'));
    check('LSP blend: annotated as an LSP match, not a keyword/semantic guess', /helper-utils\.js.*LSP-defines/.test(withLsp));

    // Negative control: same query, no language server answers this time —
    // the file must NOT surface, proving the LSP data was what found it above.
    ctrl.nextWorkspaceSymbols = null;
    const withoutLsp = await provider.toolFindRelevantFiles('AuthTokenValidator', 5);
    check('LSP blend: without a language-server answer, the same query does NOT surface the file',
      !withoutLsp.includes('helper-utils.js'));
  } catch (e) {
    check('LSP symbol blend suite ran', false, e.stack || e.message);
  } finally {
    await vscode.workspace.getConfiguration().update('embeddingModel', '');
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // Repo-map symbol outline: buildRepoMap enriches code files with a
  // function/class/method outline via the SAME real language-server
  // infrastructure (executeDocumentSymbolProvider) the LSP blend above uses
  // — not a new parser. Previously the map was pure filenames with zero
  // symbol information, regardless of what language servers were active.
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-repomap-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    fs.writeFileSync(path.join(tmp, 'auth.js'), 'function login(){}\nfunction logout(){}\nconst x = 1;\n');
    fs.writeFileSync(path.join(tmp, 'plain.txt'), 'not code');

    const authPath = path.join(tmp, 'auth.js');
    ctrl.nextDocumentSymbols = new Map([
      [authPath, [
        { name: 'login', kind: vscode.SymbolKind.Function },
        { name: 'logout', kind: vscode.SymbolKind.Function },
        { name: 'x', kind: vscode.SymbolKind.Variable }, // NOT "interesting" — must be filtered out
      ]],
    ]);
    const map = await provider.buildRepoMap();
    check('repo map: a code file is enriched with its function outline', /auth\.js.*— login, logout/.test(map));
    check('repo map: uninteresting symbol kinds (variables/constants) are filtered out', !map.includes(', x'));
    check('repo map: a file with no code extension is never queried and shows as a plain filename',
      map.includes('plain.txt') && !/plain\.txt.*—/.test(map));

    // Negative control: no language server answers at all — the map must be
    // IDENTICAL in shape to the old plain-filename behavior, not broken.
    provider._repoMapCache = null;
    ctrl.nextDocumentSymbols = null;
    const mapNoLsp = await provider.buildRepoMap();
    check('repo map: with no language server, files show as plain filenames (unchanged behavior)',
      mapNoLsp.includes('auth.js') && !mapNoLsp.includes(' — login'));

    // A hung/slow provider must not stall the whole map build — and running
    // the (capped, per-call time-boxed) fetches in parallel means the total
    // cost stays close to ONE timeout window, not one per file.
    provider._repoMapCache = null;
    const realExecuteCommand = vscode.commands.executeCommand;
    vscode.commands.executeCommand = async (cmd, ...args) => {
      if (cmd === 'vscode.executeDocumentSymbolProvider') return new Promise(() => {}); // never resolves
      return realExecuteCommand(cmd, ...args);
    };
    const t0 = Date.now();
    const mapHung = await provider.buildRepoMap();
    const elapsed = Date.now() - t0;
    vscode.commands.executeCommand = realExecuteCommand;
    check('repo map: a hung language server does not stall the map build past its timeout', elapsed < 2000, elapsed + 'ms');
    check('repo map: still returns a usable map despite the hang', mapHung.includes('auth.js'));
  } catch (e) {
    check('repo map symbol outline suite ran', false, e.stack || e.message);
  } finally {
    ctrl.nextDocumentSymbols = null;
    if (provider) clearTimeout(provider._cpSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 8b14. Sharded semantic index ────────────────────────────────────────────
// The index used to be one flat file with a 24 MB ceiling, past which it was
// silently not persisted at all — a large repo re-embedded itself from scratch
// on every window open, and one byte over the cap discarded a fully valid
// index. Sharded now, with vectors stored as base64 Float32Array.
async function embedIndexSuite() {
  console.log('\nsharded semantic index:');
  const os = require('os');
  const { NavyCoderViewProvider, encodeVector, decodeVector, shardOf } = require('../src/extension.js');

  // ── Vector encoding ──
  const vec = [0.5, -0.25, 0.125, 0, 1];
  const round = decodeVector(encodeVector(vec));
  check('vectors: a round trip preserves the values',
    round.length === vec.length && vec.every((n, i) => Math.abs(round[i] - n) < 1e-6),
    Array.from(round).join(','));
  check('vectors: decoding yields a Float32Array, which cosineSimilarity indexes the same way',
    round instanceof Float32Array);
  // Measured against the format this actually replaced — 5-decimal-rounded
  // JSON numbers, not raw float64. ~1.6x, so the assertion is set at 1.3x:
  // enough to catch the encoding silently regressing to something larger,
  // without pretending to a ratio the change does not deliver.
  {
    const realistic = Array.from({ length: 1536 }, (_, i) => Math.round(Math.sin(i) * 1e5) / 1e5);
    const asJson = JSON.stringify(realistic).length;
    const asB64 = encodeVector(realistic).length;
    check('vectors: the encoding is smaller than the rounded JSON it replaces',
      asB64 < asJson / 1.3, `${asJson} -> ${asB64}`);
  }
  // A wrong-length vector compared against a right-length one is the worst
  // possible corruption — cosineSimilarity throws on it, but only if the
  // decoder refuses to invent one.
  check('vectors: a truncated payload decodes to null, never a short vector',
    decodeVector('AAAB') === null);
  check('vectors: empty input decodes to null', decodeVector('') === null && decodeVector(null) === null);
  // Asserted against a real value, not just against itself: `a === a` holds
  // just as well when the function returns undefined for everything, so the
  // shape of what comes back is half the check.
  const shardA = shardOf('src/app.js');
  const shardB = shardOf('src/app.js');
  check('vectors: sharding is deterministic',
    shardA === shardB && /^[0-9a-f]{2}$/.test(shardA), JSON.stringify(shardA));
  check('vectors: …and spreads across shards',
    new Set(Array.from({ length: 200 }, (_, i) => shardOf('src/file' + i + '.js'))).size > 8);

  let provider, tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-embed-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;
    const navyDir = path.join(tmp, '.navy');
    fs.mkdirSync(navyDir, { recursive: true });
    provider.getNavyDir = () => navyDir;
    provider.ensureNavyDir = async () => navyDir;

    const mkIndex = (files, model = 'embed-1', prov = 'ollama') => ({ model, provider: prov, files });
    const file = (n) => ({ mtimeMs: 1, size: 10, chunks: [{ startLine: 1, endLine: 5, vector: [n, n + 0.5, n - 0.5] }] });

    // ── Write and read back ──
    const written = mkIndex({ 'a.js': file(0.1), 'b.js': file(0.2), 'c.js': file(0.3) });
    await provider._writeShards(navyDir, written, null);
    const shardFiles = fs.readdirSync(path.join(navyDir, 'embeddings'));
    check('index: shards are written under .navy/embeddings/', shardFiles.length > 0, shardFiles.join(','));
    check('index: one flat file is no longer created',
      !fs.existsSync(path.join(navyDir, 'embeddings.json')));

    let read = await provider._readShardedIndex(navyDir);
    check('index: every file comes back', Object.keys(read.files).sort().join(',') === 'a.js,b.js,c.js');
    check('index: the embedding space comes back with it',
      read.model === 'embed-1' && read.provider === 'ollama');
    check('index: vectors survive the round trip',
      Math.abs(read.files['b.js'].chunks[0].vector[0] - 0.2) < 1e-6);
    check('index: chunk line ranges survive too',
      read.files['b.js'].chunks[0].startLine === 1 && read.files['b.js'].chunks[0].endLine === 5);

    // ── A corrupt shard costs its own files, not the index ──
    const victim = shardOf('b.js');
    fs.writeFileSync(path.join(navyDir, 'embeddings', `shard-${victim}.json`), '{ this is not json');
    read = await provider._readShardedIndex(navyDir);
    check('index: a corrupt shard does not take down the whole index',
      Object.keys(read.files).length > 0 && !read.files['b.js'],
      Object.keys(read.files).join(','));
    check('index: …and the surviving files are intact',
      Boolean(read.files['a.js'] || read.files['c.js']));

    // ── A shard from a different embedding model must be discarded ──
    fs.rmSync(path.join(navyDir, 'embeddings'), { recursive: true, force: true });
    await provider._writeShards(navyDir, mkIndex({ 'a.js': file(0.1) }), null);
    const otherShard = shardOf('zzz.js');
    fs.writeFileSync(path.join(navyDir, 'embeddings', `shard-${otherShard}.json`),
      JSON.stringify({ v: 2, model: 'a-different-model', provider: 'openai',
        files: { 'zzz.js': { mtimeMs: 1, size: 1, chunks: [{ s: 1, e: 2, v: encodeVector([9, 9, 9]) }] } } }));
    read = await provider._readShardedIndex(navyDir);
    check('index: a shard from another embedding model is dropped, not mixed in',
      Boolean(read.files['a.js']) && !read.files['zzz.js'], Object.keys(read.files).join(','));

    // ── Incremental: only the touched shard is rewritten ──
    fs.rmSync(path.join(navyDir, 'embeddings'), { recursive: true, force: true });
    const live = mkIndex({ 'a.js': file(0.1), 'b.js': file(0.2) });
    await provider._writeShards(navyDir, live, null);
    const untouched = path.join(navyDir, 'embeddings', `shard-${shardOf('a.js')}.json`);
    const beforeMtime = fs.statSync(untouched).mtimeMs;
    await new Promise(r => setTimeout(r, 20));
    live.files['b.js'] = file(0.9);
    await provider._writeShards(navyDir, live, new Set([shardOf('b.js')]));
    const changed = shardOf('a.js') !== shardOf('b.js');
    check('index: re-indexing one file leaves other shards untouched',
      !changed || fs.statSync(untouched).mtimeMs === beforeMtime);
    read = await provider._readShardedIndex(navyDir);
    check('index: …and the updated file has its new vector',
      Math.abs(read.files['b.js'].chunks[0].vector[0] - 0.9) < 1e-6);

    // A shard emptied by deletion must be removed, or the next read brings the
    // deleted file back from the old file on disk.
    delete live.files['b.js'];
    await provider._writeShards(navyDir, live, new Set([shardOf('b.js')]));
    read = await provider._readShardedIndex(navyDir);
    check('index: a deleted file does not come back from a stale shard',
      !read.files['b.js'] && Boolean(read.files['a.js']));

    // ── Migration from the legacy flat file ──
    fs.rmSync(path.join(navyDir, 'embeddings'), { recursive: true, force: true });
    fs.writeFileSync(path.join(navyDir, 'embeddings.json'), JSON.stringify({
      model: 'legacy-model', provider: 'ollama', chunked: true,
      files: { 'old.js': { mtimeMs: 7, size: 70, chunks: [{ startLine: 1, endLine: 9, vector: [0.4, 0.5, 0.6] }] } },
    }));
    provider._embedIndexCache = null;
    const migrated = await provider._loadEmbeddingIndex(tmp);
    check('migration: the legacy index is read rather than thrown away',
      Boolean(migrated.files['old.js']), Object.keys(migrated.files).join(','));
    check('migration: its embedding space is carried over', migrated.model === 'legacy-model');
    check('migration: its vectors survive', Math.abs(migrated.files['old.js'].chunks[0].vector[1] - 0.5) < 1e-6);
    check('migration: the flat file is removed once its contents are sharded',
      !fs.existsSync(path.join(navyDir, 'embeddings.json')));
    check('migration: …and the shards it produced are readable on their own',
      Boolean((await provider._readShardedIndex(navyDir)).files['old.js']));

    // A pre-chunking cache (one `vector` per file, no `chunks`) would throw on
    // the first similarity call — it is discarded, not migrated.
    fs.rmSync(path.join(navyDir, 'embeddings'), { recursive: true, force: true });
    fs.writeFileSync(path.join(navyDir, 'embeddings.json'),
      JSON.stringify({ model: 'x', provider: 'y', files: { 'a.js': { vector: [1, 2, 3] } } }));
    provider._embedIndexCache = null;
    const preChunk = await provider._loadEmbeddingIndex(tmp);
    check('migration: a pre-chunking cache is discarded, not half-read',
      Object.keys(preChunk.files).length === 0);
    check('migration: …and its file is cleared away',
      !fs.existsSync(path.join(navyDir, 'embeddings.json')));
  } catch (e) {
    check('sharded semantic index suite ran', false, e.stack || e.message);
  } finally {
    if (provider) clearTimeout(provider._embedSaveTimer);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── 8b1. Context budget + per-file edit caps ────────────────────────────────
// Both used to be fixed literals. The budget one mattered in both directions:
// a 200k model had history thrown away (and paid for a summarization call to do
// it) that it had room to keep, and an 8k model was handed 60k tokens' worth it
// could never hold.
async function contextBudgetSuite() {
  console.log('\ncontext budget + edit caps:');
  const os = require('os');
  const { vscode, ctrl } = sharedMock();
  const { NavyCoderViewProvider } = require('../src/extension.js');
  const provider = new NavyCoderViewProvider(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'navy-ctx-'))));

  // Straight from the live window, with no user override in play.
  ctrl.config.contextWindow = 0;
  provider._applyContextWindow(200000, true);
  let caps = provider._contextCharCaps();
  check('budget: a 200k model raises the cap above the old fixed floor',
    caps.compact === Math.floor(200000 * 4 * 0.6), String(caps.compact));
  check('budget: the history cap stays strictly under the compaction ceiling',
    caps.history < caps.compact, `${caps.history} vs ${caps.compact}`);

  // The half of this that was silently WRONG before: a small model was handed a
  // 240k-char budget for a window that cannot hold a quarter of it.
  provider._applyContextWindow(8192, true);
  caps = provider._contextCharCaps();
  check('budget: a small model is budgeted below the old fixed floor, not above it',
    caps.compact === Math.floor(8192 * 4 * 0.6) && caps.compact < 240000, String(caps.compact));

  // Unknown model → exactly the old behaviour, unchanged.
  provider._applyContextWindow(null, false);
  caps = provider._contextCharCaps();
  check('budget: an unknown window falls back to the original 240000 floor', caps.compact === 240000);
  check('budget: …and the original 200000 history cap with it', caps.history === 200000);

  // A 1M-token model must not hand us a 2.4 MB per-iteration string.
  provider._applyContextWindow(1000000, true);
  caps = provider._contextCharCaps();
  check('budget: a 1M-token window is capped, not taken literally', caps.compact === 1000000, String(caps.compact));

  // An explicit navy.contextWindow is the user saying "treat the chat as full
  // sooner than the model requires" — it has to win.
  ctrl.config.contextWindow = 32000;
  provider._applyContextWindow(200000, true);
  caps = provider._contextCharCaps();
  check('budget: an explicit contextWindow overrides the live maximum',
    caps.compact === Math.floor(32000 * 4 * 0.6), String(caps.compact));
  check('budget: …and a choice larger than the model is still clamped to the model',
    (ctrl.config.contextWindow = 500000, provider._applyContextWindow(200000, true),
     provider._contextCharCaps().compact === Math.floor(200000 * 4 * 0.6)));
  ctrl.config.contextWindow = 0;

  // The strategy itself must be untouched: in-place edits, recent tool results
  // kept, small messages left alone.
  provider._applyContextWindow(null, false);
  const mkTool = (n) => ({ role: 'tool', tool_call_id: 't' + n, content: 'x'.repeat(20000) });
  const messages = [];
  for (let i = 0; i < 20; i++) messages.push(mkTool(i));
  const before = messages.length;
  provider._compactMessages(messages);
  check('compaction: messages are edited in place, never removed', messages.length === before);
  check('compaction: the most recent tool results are untouched',
    messages.slice(-6).every(m => m.content.length === 20000));
  check('compaction: the oldest were stubbed', messages[0].content.length < 20000, String(messages[0].content.length));

  // Same conversation, a window big enough to hold it → nothing is touched.
  const roomy = [];
  for (let i = 0; i < 20; i++) roomy.push(mkTool(i));
  provider._applyContextWindow(500000, true);
  provider._compactMessages(roomy);
  check('compaction: a model with room to spare keeps everything',
    roomy.every(m => m.content.length === 20000));

  // ── Per-file edit caps ──
  delete ctrl.config.fileEditSoftCap;
  delete ctrl.config.fileEditHardCap;
  check('edit caps: defaults are unchanged from the old literals',
    JSON.stringify(provider._fileEditCaps()) === JSON.stringify({ soft: 5, hard: 10 }),
    JSON.stringify(provider._fileEditCaps()));

  ctrl.config.fileEditSoftCap = 20;
  ctrl.config.fileEditHardCap = 40;
  check('edit caps: a raised pair is honoured',
    JSON.stringify(provider._fileEditCaps()) === JSON.stringify({ soft: 20, hard: 40 }));

  // Inverted: the hard cap comes UP to the soft one. Lowering the soft cap
  // instead would tighten a guard the user was trying to loosen.
  ctrl.config.fileEditSoftCap = 8;
  ctrl.config.fileEditHardCap = 3;
  check('edit caps: an inverted pair raises the hard cap rather than lowering the soft one',
    JSON.stringify(provider._fileEditCaps()) === JSON.stringify({ soft: 8, hard: 8 }),
    JSON.stringify(provider._fileEditCaps()));

  // A guard cannot be configured out of existence.
  ctrl.config.fileEditSoftCap = 0;
  ctrl.config.fileEditHardCap = -5;
  const zeroed = provider._fileEditCaps();
  check('edit caps: zero/negative values still leave a working guard',
    zeroed.soft >= 1 && zeroed.hard >= zeroed.soft, JSON.stringify(zeroed));
  delete ctrl.config.fileEditSoftCap;
  delete ctrl.config.fileEditHardCap;
  void vscode;
}

// The context budget's two soft spots, both of which used to be absorbed by
// CONTEXT_FILL rather than measured.
async function contextBudgetLearningSuite() {
  console.log('\ncontext budget (learned token ratio, assistant trimming):');
  const os = require('os');
  const { ctrl } = sharedMock();
  let provider, tmp;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-budget-'));
    provider = new NavyCoderViewProvider(makeContext(tmp));
    provider.projectRoot = tmp;

    // ── The learned chars-per-token ratio. ─────────────────────────────────
    check('token ratio: starts at the English-prose default', provider._charsPerToken() === 4);

    // One sample on its own proves nothing — it is the DELTA between two calls
    // that cancels the fixed overhead (tool schemas, system prompt).
    provider._observeTokenRatio(100000, 25000);
    check('token ratio: a single sample does not move the estimate', provider._charsPerToken() === 4);

    // +30,000 chars for +10,000 tokens ⇒ 3.0 chars/token, smoothed 25% from 4.
    provider._observeTokenRatio(130000, 35000);
    const afterOne = provider._charsPerToken();
    check('token ratio: moves toward the observed delta, smoothed', Math.abs(afterOne - 3.75) < 0.001, afterOne);

    // Repeated consistent samples converge on the real figure.
    let chars = 130000, tokens = 35000;
    for (let i = 0; i < 20; i++) { chars += 30000; tokens += 10000; provider._observeTokenRatio(chars, tokens); }
    check('token ratio: converges on the observed value', Math.abs(provider._charsPerToken() - 3) < 0.05, provider._charsPerToken());

    // A shrinking prompt means compaction just ran — the delta is meaningless.
    const before = provider._charsPerToken();
    provider._observeTokenRatio(10000, 5000);          // seeds
    provider._observeTokenRatio(5000, 4000);           // shrank
    check('token ratio: a shrinking prompt is not sampled', provider._charsPerToken() === before);

    // Too small a delta is integer-rounding noise, not signal. Clear the stored
    // sample first — seeding a new scenario is itself a valid delta against
    // whatever the previous one left behind.
    provider._cptSample = null;
    const beforeTiny = provider._charsPerToken();
    provider._observeTokenRatio(200000, 50000);
    provider._observeTokenRatio(200500, 50100);
    check('token ratio: a sub-threshold delta is not sampled', provider._charsPerToken() === beforeTiny);

    // Nonsense cannot escape the clamp — a token delta of 1 for 30k chars
    // would otherwise claim 30,000 chars per token.
    provider._cptSample = null;
    provider._observeTokenRatio(300000, 60000);
    provider._observeTokenRatio(330000, 60001);
    check('token ratio: clamped to a physically sensible range',
      provider._charsPerToken() > 1.4 && provider._charsPerToken() <= 8, provider._charsPerToken());

    // …and the budget actually derives from it.
    provider.modelContextLength = 100000;
    provider.charsPerToken = 0;
    const defaultCap = provider._contextCharCaps().compact;
    provider.charsPerToken = 2;                     // e.g. a CJK-heavy conversation
    const learnedCap = provider._contextCharCaps().compact;
    check('token ratio: a denser conversation gets a SMALLER char budget',
      learnedCap < defaultCap && learnedCap === Math.floor(100000 * 2 * 0.6), `${learnedCap} vs ${defaultCap}`);

    // Clearing the chat must not carry a ratio into a conversation whose
    // content mix has nothing to do with it.
    provider.view = { webview: { postMessage: () => {} } };
    provider.clearChat();
    check('token ratio: cleared with the chat', provider._charsPerToken() === 4);

    // ── Assistant text is now prunable when tool output runs out. ──────────
    // Budget small enough that pruning every tool result cannot get under it,
    // so the assistant pass is the only thing left.
    provider.modelContextLength = 0;
    provider._contextCharCaps = () => ({ compact: 50000, history: 40000 });

    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
    for (let i = 0; i < 12; i++) {
      msgs.push({ role: 'assistant', content: 'REASONING '.repeat(600), tool_calls: [{ id: 't' + i }] });
      msgs.push({ role: 'tool', tool_call_id: 't' + i, content: 'X'.repeat(4000) });
    }
    const sizeBefore = msgs.reduce((a, m) => a + m.content.length, 0);
    provider._compactMessages(msgs);
    const sizeAfter = msgs.reduce((a, m) => a + m.content.length, 0);

    check('assistant trim: the array is brought under budget', sizeAfter <= 50000, sizeAfter);
    check('assistant trim: it actually shrank', sizeAfter < sizeBefore);
    const assistants = msgs.filter(m => m.role === 'assistant');
    check('assistant trim: every assistant message kept its tool_calls',
      assistants.every(m => Array.isArray(m.tool_calls) && m.tool_calls.length === 1));
    const trimmed = assistants.filter(m => /earlier reasoning trimmed/.test(m.content));
    check('assistant trim: older reasoning was trimmed', trimmed.length > 0, trimmed.length);
    check('assistant trim: the 3 most recent are left intact',
      assistants.slice(-3).every(m => !/earlier reasoning trimmed/.test(m.content)));

    // A provider replaying verbatim blocks must not be touched: trimming
    // .content would not shrink what is sent, and dropping _rawBlocks to make
    // it shrink risks the signature errors the field exists to prevent.
    const raw = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 12; i++) {
      raw.push({ role: 'assistant', content: 'THINKING '.repeat(600), tool_calls: [{ id: 'r' + i }],
                 _rawBlocks: [{ type: 'thinking' }], _rawBlocksProvider: 'anthropic' });
      raw.push({ role: 'tool', tool_call_id: 'r' + i, content: 'Y'.repeat(4000) });
    }
    provider._compactMessages(raw);
    check('assistant trim: messages carrying _rawBlocks are never trimmed',
      raw.filter(m => m.role === 'assistant').every(m => !/earlier reasoning trimmed/.test(m.content)));
    check('assistant trim: …and they keep their raw blocks',
      raw.filter(m => m.role === 'assistant').every(m => Array.isArray(m._rawBlocks)));
  } finally {
    ctrl.reset?.();
    try { provider?.dispose?.(); } catch {}
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { retrievalSuite, semanticSearchSuite, retrievalUpgradesSuite, embedIndexSuite, contextBudgetSuite, contextBudgetLearningSuite };
