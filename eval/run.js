// Navy eval runner — measures whether Navy actually completes coding tasks.
//
// This is NOT the unit-test suite (`npm test`). That suite mocks the model and
// checks mechanism. This one drives the REAL askNavy() loop against a REAL model
// over the network, in a real temp repo, and scores by inspecting the files that
// ended up on disk.
//
//   npm run eval                                  # all tasks, configured provider/model
//   npm run eval -- --provider ollama --model qwen2.5-coder:7b
//   npm run eval -- --task edit-scope-single-constant
//   npm run eval -- --category edit-precision
//   npm run eval -- --compare eval/results/<file>.json
//
// API keys come from the environment so nothing secret lands in the repo:
//   NAVY_EVAL_API_KEY, or a provider-specific ANTHROPIC_API_KEY / OPENAI_API_KEY / …
//
// A run reports three outcomes, and the distinction matters:
//   PASS  — the repo ended up correct
//   FAIL  — the model did the task wrong (this is the signal)
//   ERROR — the harness or provider broke (auth, network, timeout). NOT counted
//           as a model failure; a run with errors is reported as incomplete.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { createVscodeMock, installVscodeMock, uninstallVscodeMock } = require(path.join(ROOT, 'test', 'vscode-mock.js'));
const { TASKS } = require('./tasks.js');

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { concurrency: 1, timeout: 180000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider')      out.provider = argv[++i];
    else if (a === '--model')    out.model = argv[++i];
    else if (a === '--task')     out.task = argv[++i];
    else if (a === '--category') out.category = argv[++i];
    else if (a === '--compare')  out.compare = argv[++i];
    else if (a === '--timeout')  out.timeout = parseInt(argv[++i], 10) * 1000;
    else if (a === '--host')     out.host = argv[++i];
    else if (a === '--keep')     out.keep = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const HELP = `
Navy eval runner

  npm run eval                                   run every task
  npm run eval -- --provider ollama --model qwen2.5-coder:7b
  npm run eval -- --task <id>                    run one task
  npm run eval -- --category edit-precision      run one category
  npm run eval -- --compare <results.json>       diff against a previous run
  npm run eval -- --timeout 240                  per-task timeout in seconds
  npm run eval -- --keep                         keep temp repos for inspection

API key: set NAVY_EVAL_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY / …).
Local Ollama needs no key.
`;

// ── Per-task sandbox helpers ─────────────────────────────────────────────────
function listFilesRec(dir, base = dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRec(full, base));
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

function runNodeIn(dir, file, source, timeout = 10000) {
  return new Promise((resolve) => {
    // A probe file lets a checker exercise the module the model produced without
    // requiring the model to have written an entry point of its own.
    if (source != null) {
      try { fs.writeFileSync(path.join(dir, file), source); }
      catch (e) { return resolve({ ok: false, stdout: '', stderr: 'probe write failed: ' + e.message }); }
    }
    let stdout = '', stderr = '', done = false, timer = null;
    // Clear the timer on completion — leaving it armed meant every finished
    // probe still tried to kill a PID later, which the OS may have reused.
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) { clearTimeout(timer); timer = null; }
      resolve(r);
    };
    try {
      const child = spawn(process.execPath, [path.join(dir, file)], { cwd: dir, windowsHide: true });
      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('close', code => finish({ ok: code === 0, stdout, stderr }));
      child.on('error', e => finish({ ok: false, stdout, stderr: e.message }));
      timer = setTimeout(() => {
        if (done) return;
        try { child.kill(); } catch {}
        finish({ ok: false, stdout, stderr: 'probe timed out' });
      }, timeout);
    } catch (e) {
      finish({ ok: false, stdout: '', stderr: e.message });
    }
  });
}

function makeCheckContext(dir, task, reply) {
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
  return {
    dir,
    reply: reply || '',
    seed: task.files,
    read,
    exists: (f) => fs.existsSync(path.join(dir, f)),
    json: (f) => { const t = read(f); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } },
    list: () => listFilesRec(dir),
    unchanged: (f) => read(f) === task.files[f],
    runNode: (file, source) => runNodeIn(dir, file, source),
  };
}

// ── Running one task ─────────────────────────────────────────────────────────
async function runTask(task, cfg, vscodeMock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-eval-'));
  const started = Date.now();
  let provider;
  try {
    for (const [rel, content] of Object.entries(task.files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }

    const { NavyCoderViewProvider } = require(path.join(ROOT, 'src', 'extension.js'));
    provider = new NavyCoderViewProvider({
      secrets: { get: async () => cfg.apiKey, store: async () => {} },
      subscriptions: [],
      globalState: { get: () => undefined, update: async () => {} },
      extensionUri: { fsPath: dir, path: dir, scheme: 'file' },
      extension: { packageJSON: { version: 'eval' } },
    });
    provider.projectRoot = dir;
    // Skip the real wsl.exe probe — irrelevant to scoring, costs time per task.
    provider._wslCache = { available: false };

    const chunks = [];
    provider.view = { webview: { postMessage: (m) => { if (m.type === 'chunk' && m.text) chunks.push(m.text); } } };

    // The turn must be able to finish on its own: auto-approve, or every write
    // blocks forever waiting for a click that will never come.
    Object.assign(vscodeMock.ctrl.config, {
      approvalMode: 'auto-approve',
      provider: cfg.provider,
      model: cfg.model,
      host: cfg.host,
      maxToolIterations: 30,
      inlineCompletions: false,
      embeddingModel: cfg.embeddingModel || '',
      apiBase: '',
      systemPrompt: '',
    });

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; provider.abortController?.abort(); }, cfg.timeout);
    let turnError = null;
    try {
      await provider.askNavy(task.prompt, false, null, [], []);
    } catch (e) {
      turnError = e;
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) return { id: task.id, category: task.category, status: 'ERROR', reason: `timed out after ${cfg.timeout / 1000}s`, ms: Date.now() - started };
    if (turnError) return { id: task.id, category: task.category, status: 'ERROR', reason: 'turn threw: ' + turnError.message, ms: Date.now() - started };

    const reply = chunks.join('');
    // A provider-level failure surfaces as an error message in the transcript
    // rather than a throw — classify it as ERROR so a bad API key or a rate
    // limit is never scored as "the model failed the task".
    if (/API key rejected|rate limit hit|no quota for this model|can't reach the server|is having a temporary problem/i.test(reply)) {
      const line = reply.split('\n').find(l => l.trim()) || 'provider error';
      return { id: task.id, category: task.category, status: 'ERROR', reason: 'provider: ' + line.slice(0, 120), ms: Date.now() - started };
    }

    const ctx = makeCheckContext(dir, task, reply);
    let verdict;
    try { verdict = await task.check(ctx); }
    catch (e) { return { id: task.id, category: task.category, status: 'ERROR', reason: 'checker threw: ' + e.message, ms: Date.now() - started }; }

    return {
      id: task.id, category: task.category,
      status: verdict.pass ? 'PASS' : 'FAIL',
      reason: verdict.reason,
      ms: Date.now() - started,
    };
  } catch (e) {
    return { id: task.id, category: task.category, status: 'ERROR', reason: 'harness: ' + e.message, ms: Date.now() - started };
  } finally {
    if (provider) {
      clearTimeout(provider._cpSaveTimer);
      clearTimeout(provider._watchdog);
      clearTimeout(provider._embedSaveTimer);
      clearInterval(provider._heartbeat);
      try { provider.mcp?.stop(); } catch {}
    }
    if (!cfg.keep) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    else console.log(`      kept: ${dir}`);
  }
}

// ── Reporting ────────────────────────────────────────────────────────────────
function report(results, cfg) {
  const pass = results.filter(r => r.status === 'PASS');
  const fail = results.filter(r => r.status === 'FAIL');
  const err  = results.filter(r => r.status === 'ERROR');
  const scored = pass.length + fail.length;

  console.log('\n' + '─'.repeat(66));
  console.log(`  ${cfg.provider} / ${cfg.model}`);
  console.log('─'.repeat(66));

  const cats = [...new Set(results.map(r => r.category))];
  for (const cat of cats) {
    const inCat = results.filter(r => r.category === cat);
    const p = inCat.filter(r => r.status === 'PASS').length;
    const s = inCat.filter(r => r.status !== 'ERROR').length;
    console.log(`  ${String(p + '/' + s).padStart(5)}  ${cat}`);
  }

  console.log('─'.repeat(66));
  const pct = scored ? Math.round((pass.length / scored) * 100) : 0;
  console.log(`  SCORE: ${pass.length}/${scored} (${pct}%)` + (err.length ? `  —  ${err.length} errored, run is INCOMPLETE` : ''));
  console.log('─'.repeat(66));

  if (fail.length) {
    console.log('\n  Failures:');
    for (const f of fail) console.log(`    ✕ ${f.id}\n      ${f.reason}`);
  }
  if (err.length) {
    console.log('\n  Errors (not scored — harness/provider problems):');
    for (const e of err) console.log(`    ! ${e.id}\n      ${e.reason}`);
  }
  return { pass: pass.length, fail: fail.length, error: err.length, scored, pct };
}

function compare(current, baselinePath) {
  let baseline;
  try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); }
  catch (e) { console.log(`\n  (could not read baseline ${baselinePath}: ${e.message})`); return; }

  const prev = new Map((baseline.results || []).map(r => [r.id, r.status]));
  const regressed = [], fixed = [];
  for (const r of current) {
    const before = prev.get(r.id);
    if (!before || before === r.status) continue;
    if (before === 'PASS' && r.status === 'FAIL') regressed.push(r);
    if (before === 'FAIL' && r.status === 'PASS') fixed.push(r);
  }

  console.log('\n  vs ' + path.basename(baselinePath) + `  (${baseline.provider}/${baseline.model}, ${baseline.summary?.pct ?? '?'}%)`);
  if (!regressed.length && !fixed.length) {
    console.log('    no status changes');
  } else {
    for (const r of fixed)     console.log(`    ✓ FIXED      ${r.id}`);
    for (const r of regressed) console.log(`    ✗ REGRESSED  ${r.id}\n                 ${r.reason}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  const { vscode, ctrl } = createVscodeMock();
  installVscodeMock(vscode);

  const cfg = {
    provider: args.provider || 'ollama',
    model: args.model || '',
    host: args.host || 'http://localhost:11434',
    timeout: args.timeout,
    keep: args.keep,
    apiKey: process.env.NAVY_EVAL_API_KEY
      || process.env[(args.provider || '').toUpperCase() + '_API_KEY']
      || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '',
  };

  if (!cfg.model) {
    console.error('\n  No model specified. Pass --model <name> (see: npm run eval -- --help)\n');
    process.exitCode = 1;
    uninstallVscodeMock();
    return;
  }
  if (cfg.provider !== 'ollama' && cfg.provider !== 'lmstudio' && !cfg.apiKey) {
    console.error(`\n  Provider "${cfg.provider}" needs an API key. Set NAVY_EVAL_API_KEY in your environment.\n`);
    process.exitCode = 1;
    uninstallVscodeMock();
    return;
  }

  let tasks = TASKS;
  if (args.task)     tasks = tasks.filter(t => t.id === args.task);
  if (args.category) tasks = tasks.filter(t => t.category === args.category);
  if (!tasks.length) {
    console.error(`\n  No tasks matched. Known ids:\n${TASKS.map(t => '    ' + t.id).join('\n')}\n`);
    process.exitCode = 1;
    uninstallVscodeMock();
    return;
  }

  console.log(`\nRunning ${tasks.length} task(s) against ${cfg.provider}/${cfg.model}\n`);
  const results = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    process.stdout.write(`  [${String(i + 1).padStart(2)}/${tasks.length}] ${t.id.padEnd(34)}`);
    const r = await runTask(t, cfg, { vscode, ctrl });
    results.push(r);
    const mark = r.status === 'PASS' ? 'PASS' : r.status === 'FAIL' ? 'FAIL' : ' ERR';
    console.log(`${mark}  ${(r.ms / 1000).toFixed(1)}s`);
    if (r.status !== 'PASS') console.log(`         ${r.reason}`);
  }

  const summary = report(results, cfg);
  if (args.compare) compare(results, args.compare);

  // Persist so the next run can diff against this one.
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(outDir, `${cfg.provider}_${cfg.model.replace(/[^\w.-]/g, '-')}_${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    provider: cfg.provider, model: cfg.model, ranAt: new Date().toISOString(),
    summary, results,
  }, null, 2));
  console.log(`\n  saved: ${path.relative(ROOT, outFile)}\n`);

  uninstallVscodeMock();
  // Errors mean the run didn't actually measure anything reliable — surface that
  // in the exit code so CI can't treat an all-errored run as a green result.
  if (summary.error) process.exitCode = 2;
  else if (summary.fail) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 2; });
