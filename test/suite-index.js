const { fs, path, check, makeContext, sharedMock } = require('./harness.js');
const {
  LexicalIndex, tokenizeCode, findDefinitions, looksGenerated, listProjectFiles, wantedFile, RESYNC_AFTER_MS,
} = require('../src/lexical-index.js');

// The project index behind find_relevant_files: every source file, ranked by
// BM25, kept current as files change. It replaced a walk that stopped after
// 1,500 files in directory order and re-read them all for every query.

const SKIP = new Set(['node_modules', '.git', 'dist', 'build']);
const EXTS = new Set(['.js', '.ts', '.py']);

async function lexicalIndexSuite() {
  console.log('\nproject index (find_relevant_files on large repos):');
  const os = require('os');

  // ── Tokens and definitions ─────────────────────────────────────────────────
  const toks = (s) => { const out = []; tokenizeCode(s, t => out.push(t)); return out; };
  check('tokens: an identifier whole and in its camelCase parts',
    JSON.stringify(toks('parseUserToken')) === JSON.stringify(['parseusertoken', 'parse', 'user', 'token']));
  check('tokens: snake_case too, and words under three letters are dropped',
    JSON.stringify(toks('max_retry_count = id')) === JSON.stringify(['max_retry_count', 'max', 'retry', 'count']));

  const js = findDefinitions([
    'import { parseToken } from "./t";',
    'const client = parseToken(raw);',
    'export async function fetchUserProfile(id) {',
    'class SessionStore {',
    '  async restoreSession(id) {',
    'const retryWithBackoff = async (fn) => {',
  ].join('\n'));
  check('definitions: functions, classes, methods and arrow bindings, each at its line',
    js.get('fetchuserprofile')?.[0] === 3 && js.get('sessionstore')?.[0] === 4
    && js.get('restoresession')?.[0] === 5 && js.get('retrywithbackoff')?.[0] === 6, JSON.stringify([...js]));
  check('definitions: calling a function is not defining it', !js.has('parsetoken') && js.get('client')?.[0] === 2);
  check('definitions: the name keeps its own spelling, for the report', js.get('fetchuserprofile')[1] === 'fetchUserProfile');
  const other = findDefinitions([
    'def load_config(path):', 'class Loader:', 'func (s *Server) HandleLogin(w http.ResponseWriter) {',
    'public void refreshCache(String key) {', 'fn parse_header(input: &str) {',
  ].join('\n'));
  check('definitions: Python, Go with a receiver, Java and Rust',
    ['load_config', 'loader', 'handlelogin', 'refreshcache', 'parse_header'].every(t => other.has(t)), JSON.stringify([...other.keys()]));
  check('generated: a minified file is recognised, ordinary code is not',
    looksGenerated('var a=1;'.repeat(100)) && !looksGenerated('const a = 1;\nconst b = 2;\n'));

  // ── Ranking ────────────────────────────────────────────────────────────────
  const idx = new LexicalIndex();
  idx.add('src/util/common.js', 'export function helper() { return config.value + config.other; }\n'.repeat(5));
  idx.add('src/auth/tokens.js', 'export function parseUserToken(raw) {\n  return decode(raw);\n}\n');
  idx.add('src/config.js', 'const config = { value: 1, other: 2 };\nmodule.exports = config;\n');
  for (let i = 0; i < 30; i++) idx.add(`src/features/f${i}.js`, `import config from "../config";\nexport const feature${i} = config.value;\n`);
  const hits = idx.search([
    { term: 'parseusertoken', weight: 2 }, { term: 'parse', weight: 1 }, { term: 'user', weight: 1 },
    { term: 'token', weight: 1 }, { term: 'config', weight: 2 },
  ]);
  check('ranking: a rare identifier outweighs a word every file uses',
    hits[0]?.rel === 'src/auth/tokens.js', JSON.stringify(hits.slice(0, 3).map(h => h.rel)));
  check('ranking: ...and the hit says where it is defined',
    hits[0]?.defs && hits[0].defLine === 1 && hits[0].defName === 'parseUserToken');
  check('ranking: the file named for a term, which also defines it, comes first for that term',
    idx.search([{ term: 'config', weight: 2 }])[0]?.rel === 'src/config.js');
  idx.remove('src/auth/tokens.js');
  check('removal: a removed file is no longer found', !idx.search([{ term: 'parseusertoken', weight: 2 }]).length && idx.size === 32);
  for (let i = 0; i < 2100; i++) idx.add('tmp/t' + i + '.js', 'const tempValue' + i + ' = 1;');
  for (let i = 0; i < 2100; i++) idx.remove('tmp/t' + i + '.js');
  check('compaction: sweeping removed files leaves every live one findable',
    idx.dead < 2000 && idx.docs.length < 200 && idx.size === 32 && idx.search([{ term: 'config', weight: 2 }])[0]?.rel === 'src/config.js',
    JSON.stringify({ dead: idx.dead, docs: idx.docs.length, size: idx.size }));

  // ── Which files ────────────────────────────────────────────────────────────
  check('files: sources in, dependencies, build output, hidden folders and other files out',
    wantedFile('src/a.js', { skipDirs: SKIP, exts: EXTS }) && !wantedFile('node_modules/x/a.js', { skipDirs: SKIP, exts: EXTS })
    && !wantedFile('.github/a.js', { skipDirs: SKIP, exts: EXTS }) && !wantedFile('docs/readme.txt', { skipDirs: SKIP, exts: EXTS }));
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-index-tree-'));
  try {
    for (const rel of ['src/a.js', 'src/b.py', 'node_modules/x/index.js', '.hidden/c.js', 'docs/readme.txt', 'lib/deep/d.ts']) {
      fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
      fs.writeFileSync(path.join(tree, rel), 'x');
    }
    const walked = await listProjectFiles(tree, { trusted: false, skipDirs: SKIP, exts: EXTS });
    check('files: the walk finds exactly the sources', !walked.viaGit
      && JSON.stringify(walked.files.slice().sort()) === '["lib/deep/d.ts","src/a.js","src/b.py"]', JSON.stringify(walked.files));
    let gitArgs = null;
    const fakeGit = (cmd, args, opts, cb) => { gitArgs = args; cb(null, 'src/a.js\0src/b.py\0node_modules/x/index.js\0'); };
    const listed = await listProjectFiles(tree, { trusted: true, skipDirs: SKIP, exts: EXTS, execFileImpl: fakeGit });
    check('files: git lists them when the workspace is trusted, with core.fsmonitor turned off',
      listed.viaGit && gitArgs.slice(0, 3).join(' ') === '-c core.fsmonitor=false ls-files'
      && JSON.stringify(listed.files) === '["src/a.js","src/b.py"]', JSON.stringify({ gitArgs, files: listed.files }));
    gitArgs = null;
    await listProjectFiles(tree, { trusted: false, skipDirs: SKIP, exts: EXTS, execFileImpl: fakeGit });
    check('files: git is never run in an untrusted workspace - its config could name a program to run', gitArgs === null);
    const noRepo = await listProjectFiles(tree, { trusted: true, skipDirs: SKIP, exts: EXTS, execFileImpl: (c, a, o, cb) => cb(new Error('not a git repository')) });
    check('files: outside a repository, the walk', !noRepo.viaGit && noRepo.files.length === 3);
    // The real thing, where git is installed: .gitignore is honoured.
    let haveGit = true;
    try { require('child_process').execFileSync('git', ['init', '-q'], { cwd: tree, stdio: 'ignore' }); } catch { haveGit = false; }
    if (haveGit) {
      fs.writeFileSync(path.join(tree, '.gitignore'), 'src/b.py\n');
      const real = await listProjectFiles(tree, { trusted: true, skipDirs: SKIP, exts: EXTS });
      check('files: with real git, what .gitignore excludes stays out',
        real.viaGit && real.files.includes('src/a.js') && !real.files.includes('src/b.py'), JSON.stringify(real));
    }
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }

  // ── Through find_relevant_files ────────────────────────────────────────────
  sharedMock();
  let provider, big, fresh;
  try {
    const { NavyCoderViewProvider } = require('../src/extension.js');
    big = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-index-big-'));
    provider = new NavyCoderViewProvider(makeContext(big));
    provider.projectRoot = big;
    // 1,600 unrelated files listed ahead of the one that matters - past the
    // 1,500 files the old walk read before it stopped.
    for (let d = 0; d < 16; d++) {
      const dir = path.join(big, 'aaa' + String(d).padStart(2, '0'));
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(dir, `mod${i}.js`), `export const value${d}_${i} = compute(${i});\n`);
    }
    const target = path.join(big, 'zzz', 'auth', 'tokenParser.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '// Session tokens\nexport function parseUserToken(raw) {\n  return raw.split(".");\n}\n');

    const out = await provider.toolFindRelevantFiles('where do we parse the user token');
    check('provider: a file past where the old walk stopped is found, and first',
      (out.split('\n')[1] || '').startsWith('zzz/auth/tokenParser.js'), out.slice(0, 300));
    check('provider: ...with the line that defines what was asked about', /defines parseUserToken at line 2/.test(out), out.slice(0, 300));
    check('provider: ...and the answer says the whole project was searched', /searched all 1,601 source files/.test(out), out.split('\n')[0]);

    fs.writeFileSync(target, '// Session tokens\nexport function decodeSessionCookie(raw) {\n  return raw;\n}\n');
    provider._noteLexicalChange(target);
    const changed = await provider.toolFindRelevantFiles('decode the session cookie');
    check('watcher: a changed file is read again on the next query',
      /zzz\/auth\/tokenParser\.js[^\n]*defines decodeSessionCookie/.test(changed), changed.slice(0, 300));
    check('watcher: ...and what it no longer defines is gone', !/defines parseUserToken/.test(await provider.toolFindRelevantFiles('parseUserToken')));

    fs.mkdirSync(path.join(big, 'zzz', 'billing'));
    fs.writeFileSync(path.join(big, 'zzz', 'billing', 'invoiceTotals.js'), 'export function computeInvoiceTotals(lines) {}\n');
    provider._lexicalIndexes.get(big).syncedAt = Date.now() - RESYNC_AFTER_MS - 1;
    check('resync: a file no watcher reported is picked up by the periodic re-check',
      /zzz\/billing\/invoiceTotals\.js/.test(await provider.toolFindRelevantFiles('computeInvoiceTotals')));

    fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-index-fresh-'));
    fs.writeFileSync(path.join(fresh, 'one.js'), 'export function onlyFile() {}\n');
    const early = await provider._lexicalIndexFor(fresh, { waitMs: 0 });
    check('building: a query during the first build gets the bounded walk instead of waiting', early === null);
    const entry = provider._lexicalIndexes.get(fresh);
    await entry.building;
    check('building: ...and the index is ready once it finishes', entry.ready && entry.index.size === 1);
  } finally {
    try { provider?.dispose?.(); } catch {}
    for (const dir of [big, fresh]) { try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
}

module.exports = { lexicalIndexSuite };
