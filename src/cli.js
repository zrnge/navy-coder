#!/usr/bin/env node
'use strict';

// `navy` - Navy's /audit and /playthrough on the command line, so they can run
// in CI and fail a build. See src/headless.js for how the extension runs with
// no editor; this file is the command line itself: arguments, output, and an
// exit code a pipeline can act on.

const fs = require('fs');
const path = require('path');
const PACKAGE = require('../package.json');

const USAGE = `navy ${PACKAGE.version} — Navy AI Coder on the command line, for CI.

Usage:
  navy audit [options]              Scan the project for what a supply-chain attack looks like
  navy playthrough [url] [options]  Test the web app in a headless Chrome, like a human tester

Common options:
  --path DIR          The project folder (default: the current directory)
  --report FILE       Also write the report to FILE, as Markdown
  --verbose           Show Navy's own log lines
  --help, --version

audit:
  --fail-on LEVEL     Exit 1 if anything at LEVEL or above is found:
                      high (default), medium, low, none
  --json              Print the findings as JSON
  --exclude GLOBS     Ignore findings in these paths, comma-separated or repeated,
                      e.g. --exclude "test/**,fixtures/" for deliberate attack samples
  --triage            Have the model judge the findings (needs a model)
  --deep              A full model-driven audit of the project (needs a model)

playthrough:
  url                 The page to test. Without one, Navy works out how to serve the
                      project itself, which needs --allow-commands.
  --fail-on LEVEL     Exit 1 if the report lists a problem at LEVEL or above:
                      critical (default), major, minor, polish, none
  --allow-commands    Let Navy run commands, such as starting the dev server
  --baselines DIR     Where visual baselines are kept
                      (default: the project's folder in ~/.navy-coder)
  --hint TEXT         Guidance, e.g. "test the checkout flow"
  --headed            Show the browser window instead of running headless
  --chrome PATH       The Chrome or Edge to drive (default: found automatically)
  --timeout MINUTES   Stop a run that takes longer than this (default: 20)

Model options (playthrough, --triage, --deep):
  --provider NAME     ollama (default), anthropic, openai, gemini, deepseek, openrouter, ...
  --model NAME        The model to use
  --host URL          An Ollama or LM Studio server (default: http://localhost:11434)
  --api-base URL      Override the provider's API URL
  --ollama-mode MODE  local (default) or cloud
  --thinking LEVEL    fast, medium (default), high, xhigh or max
  Each also reads NAVY_PROVIDER, NAVY_MODEL, NAVY_HOST or NAVY_API_BASE. API keys come
  from the environment: the provider's usual variable (ANTHROPIC_API_KEY, OPENAI_API_KEY,
  GEMINI_API_KEY, DEEPSEEK_API_KEY, ...) or NAVY_API_KEY.

Exit codes: 0 passed, 1 found something at or above --fail-on, 2 the run could not finish.
A headless run is read-only: Navy never changes a file.`;

const BOOL = 'bool';
const VALUE = 'value';
const FLAGS = {
  common: { path: VALUE, report: VALUE, verbose: BOOL, help: BOOL, version: BOOL },
  model: { provider: VALUE, model: VALUE, host: VALUE, 'api-base': VALUE, 'ollama-mode': VALUE, thinking: VALUE },
  audit: { 'fail-on': VALUE, json: BOOL, triage: BOOL, deep: BOOL, exclude: VALUE },
  playthrough: {
    'fail-on': VALUE, 'allow-commands': BOOL, baselines: VALUE, hint: VALUE,
    headed: BOOL, chrome: VALUE, timeout: VALUE,
  },
};
const AUDIT_LEVELS = ['high', 'medium', 'low', 'none'];
const PLAYTHROUGH_LEVELS = ['critical', 'major', 'minor', 'polish', 'none'];

class UsageError extends Error {}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const command = argv.find(a => !a.startsWith('-'));
  const allowed = { ...FLAGS.common, ...FLAGS.model, ...(FLAGS[command] || {}) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (a === '-V' || a === '-v') { flags.version = true; continue; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const kind = allowed[name];
    if (!kind) throw new UsageError(`unknown option --${name}${command ? ` for "${command}"` : ''}`);
    if (kind === BOOL) { flags[name] = true; continue; }
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`);
    // --exclude can be given more than once; the others take the last value.
    flags[name] = name === 'exclude' && flags[name] ? flags[name] + ',' + value : value;
  }
  return { command: positional[0], positional: positional.slice(1), flags };
}

function oneOf(value, allowed, flag) {
  const v = String(value).toLowerCase();
  if (!allowed.includes(v)) throw new UsageError(`${flag} must be one of: ${allowed.join(', ')}`);
  return v;
}

// navy.* settings from the command line and the environment. Only what was
// actually given is set; everything else keeps the extension's own default.
function modelSettings(flags, env) {
  const s = {};
  const pick = (flag, name) => (flags[flag] !== undefined ? flags[flag] : env[name]);
  const provider = pick('provider', 'NAVY_PROVIDER');
  if (provider) {
    const known = PACKAGE.contributes.configuration.properties['navy.provider'].enum;
    if (!known.includes(provider)) throw new UsageError(`unknown provider "${provider}" — one of: ${known.join(', ')}`);
    s.provider = provider;
  }
  const model = pick('model', 'NAVY_MODEL');
  if (model) s.model = model;
  const host = pick('host', 'NAVY_HOST');
  if (host) s.host = host;
  const apiBase = pick('api-base', 'NAVY_API_BASE');
  if (apiBase) s.apiBase = apiBase;
  const mode = pick('ollama-mode', 'NAVY_OLLAMA_MODE');
  if (mode) s.ollamaMode = oneOf(mode, ['local', 'cloud'], '--ollama-mode');
  if (flags.thinking) s.thinkingLevel = oneOf(flags.thinking, ['fast', 'medium', 'high', 'xhigh', 'max'], '--thinking');
  return s;
}

// A path pattern from --exclude: `*` stays within a folder, `**` crosses
// folders, and a plain path matches that file or everything under it.
function excludeMatcher(pattern) {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p.includes('*')) {
    const dir = p.replace(/\/+$/, '');
    return (file) => file === dir || file.startsWith(dir + '/');
  }
  const re = new RegExp('^' + p.split(/(\*\*\/?|\*)/).map((part) => {
    if (part === '**/') return '(?:.*/)?';
    if (part === '**') return '.*';
    if (part === '*') return '[^/]*';
    return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }).join('') + '$');
  return (file) => re.test(file);
}

// GitHub Actions workflow commands: a finding becomes an annotation on the
// file it is about. Values are escaped the way the runner requires.
const ghData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const ghProp = (s) => ghData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

// The counts a playthrough report ends with, or - when the model left that
// line out - the severities its Findings section names.
function parsePlaythroughResult(text) {
  const s = String(text || '');
  const all = [...s.matchAll(/NAVY-RESULT:\s*critical\s*=\s*(\d+)[\s,;]*major\s*=\s*(\d+)[\s,;]*minor\s*=\s*(\d+)[\s,;]*polish\s*=\s*(\d+)/gi)];
  if (all.length) {
    const m = all[all.length - 1];
    return { critical: +m[1], major: +m[2], minor: +m[3], polish: +m[4], stated: true };
  }
  const findings = /\*\*Findings:?\*\*:?([\s\S]*?)(?=\n\s*\*\*[A-Z][^*\n]*:?\*\*|$)/i.exec(s);
  const body = findings ? findings[1] : '';
  const count = (w) => (body.match(new RegExp('\\b' + w + '\\b', 'gi')) || []).length;
  return { critical: count('critical'), major: count('major'), minor: count('minor'), polish: count('polish'), stated: false };
}

function playthroughFailures(result, failOn) {
  if (failOn === 'none') return 0;
  const order = ['critical', 'major', 'minor', 'polish'];
  return order.slice(0, order.indexOf(failOn) + 1).reduce((n, level) => n + result[level], 0);
}

function headlessPlaythroughNote(allowCommands) {
  return '\n\n[HEADLESS RUN — CI]\n'
    + 'This playthrough runs headless, in CI. The browser has no visible window, and nobody can answer a question or approve anything mid-run, so do not ask one. '
    + 'Files cannot be changed in this run. '
    + (allowCommands
      ? 'You may run commands, for example to start the dev server.\n'
      : 'Commands other than launching the browser are refused. If something needed one, say so under "Not covered" and carry on with what you can test.\n')
    + 'End your report with exactly one line in this form, counting the problems in your Findings list by severity:\n'
    + 'NAVY-RESULT: critical=<n> major=<n> minor=<n> polish=<n>';
}

async function runAudit(session, args, io, settings) {
  const supply = require('./supply-chain.js');
  const failOn = oneOf(args.flags['fail-on'] || 'high', AUDIT_LEVELS, '--fail-on');
  const withModel = args.flags.deep || args.flags.triage;
  if (args.flags.deep && args.flags.triage) throw new UsageError('--deep and --triage do not go together');
  if (withModel && !settings.model) throw new UsageError('--triage and --deep need a model: pass --model NAME (or set NAVY_MODEL)');

  const walk = await session.provider._walkForAudit(session.root);
  const excluded = String(args.flags.exclude || '').split(',').map(s => s.trim()).filter(Boolean).map(excludeMatcher);
  const findings = excluded.length ? walk.findings.filter(f => !excluded.some(match => match(f.file))) : walk.findings;
  const summary = supply.summarizeScan(findings, { scanned: walk.scanned, root: session.root });
  let review = '';
  if (args.flags.deep) review = await session.ask(supply.deepAuditPrompt(summary, walk));
  else if (args.flags.triage && summary.total) review = await session.ask(supply.scanTriagePrompt(summary));

  const c = summary.counts;
  const failing = failOn === 'none' ? 0 : failOn === 'high' ? c.high : failOn === 'medium' ? c.high + c.medium : c.high + c.medium + c.low;
  const verdict = failing
    ? `failed — ${failing} finding${failing === 1 ? '' : 's'} at ${failOn} or above`
    : 'passed' + (summary.total ? ` — nothing at ${failOn} or above` : '');

  if (args.flags.json) {
    io.out(JSON.stringify({
      command: 'audit', version: PACKAGE.version, root: session.root, passed: !failing, failOn,
      scanned: walk.scanned, capped: walk.capped, total: summary.total, counts: c,
      findings: summary.findings, review: review || undefined,
    }, null, 2));
  } else {
    io.out(`Navy audit: ${summary.headline}`);
    for (const f of summary.findings) {
      io.out(`  ${f.severity.toUpperCase().padEnd(6)}  ${f.file}${f.line ? ':' + f.line : ''}  ${f.id}${f.changed ? '  (recently changed)' : ''}`);
      io.out(`          ${f.why}`);
      if (f.match) io.out(`          ${f.match}`);
    }
    if (summary.total > summary.findings.length) io.out(`  …and ${summary.total - summary.findings.length} more.`);
    if (walk.capped) io.out('  (The scan stopped at its file limit; the rest of the project was not read.)');
    if (review) io.out('\nNavy\'s review:\n' + review);
    io.out(`\nResult: ${verdict}.`);
    if (io.env.GITHUB_ACTIONS === 'true') {
      const level = { high: 'error', medium: 'warning', low: 'notice' };
      for (const f of summary.findings.slice(0, 50)) {
        io.out(`::${level[f.severity] || 'notice'} file=${ghProp(f.file)},line=${f.line || 1},title=${ghProp('Navy audit: ' + f.id)}::${ghData(f.why + (f.match ? ' — ' + f.match : ''))}`);
      }
    }
  }

  if (args.flags.report) {
    const rows = summary.findings.map(f => `| ${f.severity} | \`${f.file}${f.line ? ':' + f.line : ''}\` | ${f.id} | ${String(f.why).replace(/\|/g, '\\|')} |`);
    const md = [
      '# Navy audit', '', `**Result:** ${verdict}.`, '', summary.headline, '',
      ...(rows.length ? ['| Severity | File | Finding | Why |', '|---|---|---|---|', ...rows, ''] : []),
      ...(review ? ['## Navy\'s review', '', review, ''] : []),
    ].join('\n');
    fs.writeFileSync(path.resolve(args.flags.report), md);
  }
  return failing ? 1 : 0;
}

async function runPlaythrough(session, args, io, settings) {
  const provider = session.provider;
  const failOn = oneOf(args.flags['fail-on'] || 'critical', PLAYTHROUGH_LEVELS, '--fail-on');
  if (!settings.model) throw new UsageError('playthrough needs a model: pass --model NAME (or set NAVY_MODEL)');
  const minutes = args.flags.timeout === undefined ? 20 : Number(args.flags.timeout);
  if (!(minutes > 0)) throw new UsageError('--timeout must be a number of minutes');
  const allowCommands = Boolean(args.flags['allow-commands']);

  const raw = args.positional[0];
  let url = '';
  if (raw) {
    // An explicit other scheme is refused before normalising, as /playthrough
    // does: normalising first would read file:///etc/passwd as a host named
    // "file" and happily prefix https:// to it.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) throw new UsageError(`"${raw}" is not an http(s) URL`);
    url = provider._normalizePlaythroughUrl(raw);
    if (!provider._argIsExplicitUrl(raw) || !provider._browserUrlOk(url)) throw new UsageError(`"${raw}" is not an http(s) URL`);
  } else if (!allowCommands) {
    io.note('navy: no URL given, and without --allow-commands Navy cannot start the project\'s server itself.'
      + ' Start it in an earlier step and pass its URL, or add --allow-commands.');
  }
  if (args.flags.baselines) {
    const dir = path.resolve(args.flags.baselines);
    provider._baselineDir = async () => ({ dir, inProject: true });
  }
  const hint = args.flags.hint || '';
  const prompt = (url ? provider._playthroughPrompt(url, hint) : provider._playthroughDiscoverPrompt(hint))
    + headlessPlaythroughNote(allowCommands);

  io.note(`navy: playing through ${url || 'the project'} with ${settings.provider || 'ollama'} ${settings.model}…`);
  const report = await session.ask(prompt, { timeoutMs: minutes * 60 * 1000 });
  if (!report.trim()) throw new Error('the model finished without writing a report');
  const result = parsePlaythroughResult(report);
  const failing = playthroughFailures(result, failOn);
  const counts = `${result.critical} critical, ${result.major} major, ${result.minor} minor, ${result.polish} polish`;
  const verdict = failing ? `failed — ${counts} (--fail-on ${failOn})` : `passed — ${counts}`;

  io.out(report.trim());
  io.out(`\nResult: ${verdict}.`);
  if (!result.stated) io.note('navy: the report did not end with a NAVY-RESULT line, so its counts were read from the Findings section.');
  if (session.view.state.refusedCommands.length) {
    io.note(`navy: refused ${session.view.state.refusedCommands.length} command(s); pass --allow-commands to allow them.`);
  }
  if (args.flags.report) {
    fs.writeFileSync(path.resolve(args.flags.report), `# Navy playthrough\n\n**Result:** ${verdict}.\n\n${report.trim()}\n`);
  }
  return failing ? 1 : 0;
}

async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const io = {
    env,
    out: (s) => stdout.write(s + '\n'),
    note: (s) => stderr.write(s + '\n'),
  };
  let session = null;
  try {
    const args = parseArgs(argv);
    if (args.flags.version) { io.out(PACKAGE.version); return 0; }
    if (args.flags.help || args.command === 'help') { io.out(USAGE); return 0; }
    if (!args.command) { io.note(USAGE); return 2; }
    if (args.command !== 'audit' && args.command !== 'playthrough') throw new UsageError(`unknown command "${args.command}"`);
    if (args.command === 'audit' && args.positional.length) throw new UsageError(`audit takes no arguments besides options (got "${args.positional[0]}")`);

    const root = path.resolve(args.flags.path || '.');
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new UsageError(`${root} is not a folder`);
    const settings = modelSettings(args.flags, env);
    // Every edit becomes a request that is then refused, and a command is
    // refused unless --allow-commands says otherwise (see src/headless.js).
    Object.assign(settings, {
      approvalMode: 'ask-always',
      commandApproval: args.flags['allow-commands'] ? 'auto-approve' : 'ask-always',
      browserHeadless: !args.flags.headed,
      inlineCompletions: false,
    });
    if (args.flags.chrome) settings.chromePath = path.resolve(args.flags.chrome);

    const { startHeadless } = require('./headless.js');
    session = startHeadless({ root, settings, env, note: io.note, verbose: Boolean(args.flags.verbose), allowCommands: Boolean(args.flags['allow-commands']) });
    return args.command === 'audit'
      ? await runAudit(session, args, io, settings)
      : await runPlaythrough(session, args, io, settings);
  } catch (e) {
    io.note('navy: ' + (e && e.message ? e.message : String(e)));
    if (e instanceof UsageError) io.note('Run "navy --help" for usage.');
    return 2;
  } finally {
    if (session) await session.close();
  }
}

// The exit code is set rather than exited with. Calling process.exit() while a
// handle is still closing (a model connection, a stopped browser's pipes) can
// trip a libuv assertion on Windows that kills the process with a code of its
// own - replacing the one the run decided on. So the process ends by itself;
// the unref'd timer only forces the issue if something is still holding it.
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1500).unref();
}

if (require.main === module) {
  main(process.argv.slice(2)).then(finish, (e) => {
    process.stderr.write('navy: ' + (e && e.stack ? e.stack : e) + '\n');
    finish(2);
  });
}

module.exports = { main, parseArgs, parsePlaythroughResult, playthroughFailures, headlessPlaythroughNote, excludeMatcher, USAGE };
