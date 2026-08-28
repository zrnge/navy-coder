// ── Supply-chain review for repository-supplied prompts ──────────────────────
// A slash command that arrives with a repository is executable content. Not in
// the sense that it runs code — it cannot, and src/slash-commands.js is explicit
// that a command is prompt text and nothing more — but in the sense that it
// instructs an autonomous agent that CAN run code, read files and reach the
// network, and it does so under a name you typed on purpose.
//
// Workspace trust already gates these, and that gate is real. It is also
// binary, reflexive, and answered once for the lifetime of a folder. What it
// cannot see:
//
//   * The menu shows a `description` the same author wrote. `/fix — Fix the
//     failing test` can carry any prompt at all, and the prompt is the part
//     nobody reads. The description is not evidence.
//   * Trust is granted to a FOLDER, once. A repository that was benign when you
//     trusted it and ships a rewritten `/deploy` three commits later is the
//     ordinary shape of a supply-chain attack, and nothing re-asks.
//
// So this is trust-on-first-USE, fingerprinted by content — the same model as
// an SSH host key. Each repository-supplied command is hashed; a hash you have
// not approved means either "new" or "changed since you approved it", and both
// deserve the same answer: show the human what it actually says, before it runs.
//
// Two things this deliberately is NOT:
//
//   * Not a filter. The patterns below inform a review; they never silently
//     block or silently allow. A scanner that claimed to decide would be
//     theatre — prompts are natural language, and anything expressible in a
//     pattern is expressible around one.
//   * Not applied to YOUR commands. A personal command in your own global
//     storage is something you wrote. Fingerprinting it would train you to
//     click through the dialog, which is how a review gets defeated.

const crypto = require('crypto');

// Content fingerprint. The PROMPT only — not the filename, not the description,
// not the frontmatter. Renaming a command or editing its label is not a change
// in what it will do, and re-asking for those would be noise that erodes the
// one prompt that matters.
function fingerprintPrompt(prompt) {
  return crypto.createHash('sha256').update(String(prompt || ''), 'utf8').digest('hex').slice(0, 16);
}

// What a review should draw a human's eye to. Ordered by how much a hit should
// worry someone, and every entry says WHY rather than just naming a pattern —
// "matched rule 7" tells a reviewer nothing they can act on.
const RISK_RULES = [
  {
    id: 'credentials',
    severity: 'high',
    why: 'Mentions a place credentials are kept. A prompt that needs your SSH or cloud keys to do its job is rare; one that reads them and sends them somewhere is the whole attack.',
    re: /\.ssh\b|id_rsa|id_ed25519|\.aws\b|\.gnupg|\.kube\b|\.netrc|credentials\.json|\.git-credentials|\.npmrc|keychain|secrets?\.(env|json|ya?ml)|\.env\b/i,
  },
  {
    id: 'exfiltration',
    severity: 'high',
    why: 'Sends data to somewhere outside the project. Combined with anything above, this is exfiltration; on its own it may still be a webhook you did not expect.',
    re: /\b(curl|wget|Invoke-WebRequest|iwr)\b[^\n]*https?:\/\/|fetch_url[^\n]*https?:\/\/|\b(POST|PUT)\b[^\n]*https?:\/\/|\bnc\b\s+-|\bbase64\b[^\n]*\|/i,
  },
  {
    id: 'remote-execution',
    severity: 'high',
    why: 'Pipes downloaded content straight into a shell. Whatever that URL serves today, it runs on your machine with your permissions.',
    re: /\|\s*(ba)?sh\b|\|\s*iex\b|Invoke-Expression|\beval\s*\(|curl[^\n]*\|\s*\w+/i,
  },
  {
    id: 'guardrail-evasion',
    severity: 'high',
    why: 'Tries to talk Navy out of its own safety rules. A legitimate prompt has no reason to discuss approval, or to ask that something be hidden from you.',
    re: /without (asking|confirmation|approval)|do ?n[o']?t ask|skip (the )?(confirmation|approval|diff)|auto[- ]approve|ignore (all )?(previous|prior|above) instructions|do ?n[o']?t (tell|mention|inform|show) the user|without (telling|informing) (the )?user|silently|do not log/i,
  },
  {
    id: 'destructive',
    severity: 'medium',
    why: 'Names an operation that destroys work irreversibly. It may be exactly what the command is for — but it should be a deliberate choice, not a surprise.',
    re: /rm\s+-[rf]{1,2}\b|Remove-Item[^\n]*-Recurse|git\s+push[^\n]*--force|git\s+reset\s+--hard|DROP\s+(TABLE|DATABASE)|mkfs\b|format\s+[a-z]:/i,
  },
  {
    id: 'obfuscation',
    severity: 'medium',
    why: 'Contains a long encoded or escaped run. Prompts are written to be read; something hidden in one was hidden deliberately.',
    re: /[A-Za-z0-9+/]{120,}={0,2}|(?:\\u00[0-9a-f]{2}){8,}|(?:\\x[0-9a-f]{2}){8,}/i,
  },
  {
    id: 'external-package',
    severity: 'low',
    why: 'Installs software. Worth knowing about, and worth checking the name against the one you expect — a typosquatted package is installed exactly like a real one.',
    re: /\b(npm|pnpm|yarn)\s+(i|add|install)\b|\bpip3?\s+install\b|\bcargo\s+install\b|\bgo\s+install\b|\bgem\s+install\b/i,
  },
];

// Pure, so the rules can be tested directly against real prompt text without a
// workspace, a model or a filesystem.
function auditPrompt(prompt) {
  const text = String(prompt || '');
  const findings = [];
  for (const rule of RISK_RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;
    findings.push({
      id: rule.id,
      severity: rule.severity,
      why: rule.why,
      // The matched text, so a reviewer can see the actual line rather than
      // being told a category and left to search for it themselves.
      match: m[0].replace(/\s+/g, ' ').trim().slice(0, 120),
    });
  }
  return findings;
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

// One line for the menu, so an unreviewed command reads as unreviewed before it
// is ever opened.
function riskSummary(findings) {
  if (!findings.length) return 'nothing flagged';
  const high = findings.filter(f => f.severity === 'high').length;
  const rest = findings.length - high;
  return high
    ? `${high} high-risk${rest ? ` and ${rest} other` : ''} finding${findings.length === 1 ? '' : 's'}`
    : `${rest} finding${rest === 1 ? '' : 's'}`;
}

// The body of the review, as markdown. Everything a person needs to answer
// "should this run", in the order they need it: what it will actually say to
// the model, then what stood out, then where it came from.
function reviewReport({ cmd, origin, file, prompt, findings, previouslyApproved }) {
  const sorted = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const lines = [
    `# Review ${cmd}`,
    '',
    previouslyApproved
      ? '**This command has CHANGED since you approved it.** The version below is not the one you reviewed. A repository that was safe when you trusted it and is not any more is the ordinary shape of a supply-chain attack, so this is worth reading closely rather than waving through.'
      : 'This command came with the repository rather than from you, and has not been reviewed. Navy will not run it until you have seen what it actually says.',
    '',
    `Source: \`${file}\`  (${origin})`,
    '',
    '## What it will tell the model to do',
    '',
    'This is the whole prompt. The description shown in the `/` menu was written by',
    'the same author and does not have to match it.',
    '',
    '```',
    String(prompt || '').slice(0, 8000),
    '```',
    '',
    '## What stood out',
    '',
  ];
  if (!sorted.length) {
    lines.push('Nothing matched the patterns Navy looks for. That is not a clean bill of'
      + ' health — these patterns catch the obvious, and a prompt is natural language.'
      + ' Read the text above; it is the only real check.');
  } else {
    for (const f of sorted) {
      lines.push(`- **${f.severity.toUpperCase()} · ${f.id}** — ${f.why}`);
      lines.push(`  Matched: \`${f.match}\``);
    }
    lines.push('');
    lines.push('These are a reading aid, not a verdict. Navy flags what it can pattern-match;'
      + ' anything expressible in a pattern is expressible around one.');
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('Approving records a fingerprint of the prompt above. You will not be asked'
    + ' again unless the file changes — and if it does, you will be told that it changed.');
  return lines.join('\n');
}

// ── Project scan: the deterministic pass behind /audit ───────────────────────
// The review above defends Navy FROM a repository. This turns the same eye ON
// the repository: a developer running /audit is asking "is there a supply-chain
// attack or a backdoor sitting in this project right now" — a malicious install
// hook, an obfuscated payload, code that reads credentials and phones home, a
// dependency pulled from somewhere other than the registry it claims.
//
// Navy's own code finds the signals; the model only triages what was found.
// That split is the whole design. A pure-AI review reads what fits in its
// context and misses the rest, and gives a different answer every run. A
// deterministic scan reads everything, every time, and produces the same
// findings — which is what "continuously check" needs to mean something. The
// model is then handed only the hits, to explain and rank, which is the one
// part it is actually better at than a regex.
//
// Everything here is pure: it is handed file contents and returns findings, so
// it is tested directly and the walking/filesystem lives in the caller.

// Where an attack hides in a MANIFEST rather than in code. package.json install
// hooks are the classic npm supply-chain vector — a postinstall that runs on
// every `npm install`, before you have run a line of the package yourself.
function scanPackageJson(raw, rel) {
  const findings = [];
  let pkg;
  try { pkg = JSON.parse(raw); } catch { return findings; }
  const scripts = pkg && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  // Lifecycle hooks that run automatically on install. Their mere presence is
  // not an attack — plenty of legitimate packages build native code in one —
  // but a developer should see exactly what theirs run.
  const AUTO_HOOKS = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare'];
  for (const hook of AUTO_HOOKS) {
    const cmd = scripts[hook];
    if (typeof cmd !== 'string' || !cmd.trim()) continue;
    const hookFindings = auditPrompt(cmd);
    const worst = hookFindings.find(f => f.severity === 'high');
    findings.push({
      file: rel,
      severity: worst ? 'high' : 'medium',
      id: 'install-hook',
      why: `Runs automatically on install (\`${hook}\`), before you run the package yourself.`
        + (worst ? ` And it ${worst.id === 'remote-execution' ? 'pipes remote content into a shell' : worst.id === 'exfiltration' ? 'reaches a URL' : 'matched a high-risk pattern'}.` : ''),
      match: cmd.replace(/\s+/g, ' ').trim().slice(0, 140),
    });
  }
  return findings;
}

// Off-registry dependency sources in a lockfile or manifest. A dependency
// resolved from a git URL or a bare http(s) tarball did not come from the
// public registry its name implies, which is how a name you trust gets pointed
// at code you have never seen.
function scanLockfile(raw, rel) {
  const findings = [];
  // Only the fields that name where a package's CODE came from: `resolved` and
  // `tarball`. Deliberately NOT `url` — in an npm lockfile the funding block is
  // full of `"url": "https://github.com/sponsors/..."`, which is a donation
  // link, not a download source, and flagging every sponsor URL is precisely
  // the noise that makes a scanner useless. A git dependency still shows up,
  // because it appears under `resolved`.
  const re = /"?(resolved|tarball)"?\s*[:=]\s*"?(git\+[^"\s]+|https?:\/\/(?!registry\.npmjs\.org|registry\.yarnpkg\.com|files\.pythonhosted\.org|pypi\.org|crates\.io|static\.crates\.io|proxy\.golang\.org)[^"\s]+)/gi;
  const seen = new Set();
  let m;
  while ((m = re.exec(raw)) !== null) {
    const url = m[2].slice(0, 120);
    if (seen.has(url)) continue;
    seen.add(url);
    findings.push({
      file: rel,
      severity: 'medium',
      id: 'off-registry-dependency',
      why: 'A dependency resolved from somewhere other than the public registry — a git URL or a direct download. Verify it is one you added on purpose.',
      match: url,
    });
    if (seen.size >= 20) break; // a lockfile full of them is one finding's worth of signal
  }
  return findings;
}

// One source file.
//
// NOT auditPrompt. That set was tuned to review a short prompt, where any hit
// deserves a glance — and run against thousands of lines of real source it
// drowns in false positives: it flags the word "silently" in a comment, ".env"
// in a string, and its own rule definitions. A security tool that cries wolf 58
// times on a clean repo is a tool people learn to ignore, which is worse than
// none.
//
// Source scanning needs code-shaped signals, and precision over recall: a
// missed backdoor is bad, but a scanner nobody reads catches nothing at all.
// So these fire on executable CONSTRUCTS, not vocabulary — and on the
// combination that is actually the attack (read a credential AND reach the
// network) rather than either half, which alone is ordinary.
const SOURCE_RULES = [
  {
    id: 'remote-execution',
    severity: 'high',
    why: 'Downloads content and runs it — the fetched code executes with your permissions, whatever it is today.',
    re: /\b(curl|wget)\b[^\n;|]*\|\s*(ba)?sh\b|Invoke-Expression\s*\(|\biex\b\s*\(|\beval\s*\(\s*(atob|Buffer\.from|require\s*\(\s*['"]https?)|new\s+Function\s*\(\s*(atob|Buffer\.from)/i,
  },
  {
    id: 'obfuscated-execution',
    severity: 'high',
    why: 'Decodes an encoded blob and executes it. Legitimate code has no reason to hide what it runs.',
    re: /(eval|exec|Function|child_process[^\n]{0,40}exec)[^\n]{0,60}(atob|Buffer\.from\s*\([^)]*['"]base64|fromCharCode|unescape)|(atob|Buffer\.from\s*\([^)]*base64)[^\n]{0,40}(eval|exec|Function)/i,
  },
  {
    id: 'credential-access',
    severity: 'high',
    why: 'Reads a credential store in code — an SSH key, cloud credentials, a keychain. Rare in application code, and the first half of an exfiltration.',
    re: /(readFileSync|readFile|open|read_file|File\.read|os\.Open|ioutil\.ReadFile)\s*\([^)]*(\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.gnupg|\.netrc|\.git-credentials|\.npmrc|\.kube\/config)/i,
  },
  {
    id: 'suspicious-network',
    severity: 'medium',
    why: 'Sends data to a hardcoded external host. Usually benign telemetry or an API call — worth a glance to confirm the destination is one you expect.',
    re: /(fetch|axios|https?\.request|urllib|requests\.(post|get)|net\.connect|new\s+WebSocket)\s*\(\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/i,
  },
  {
    id: 'process-spawn-shell',
    severity: 'medium',
    why: 'Runs a shell command built at runtime. Fine in tooling, a foothold in application code — check what goes into it.',
    re: /(child_process[^\n]{0,20}\.(exec|spawn)|os\.system|subprocess\.(call|run|Popen)|Runtime\.getRuntime\(\)\.exec)\s*\([^)]*(\+|\$\{|`|%s|format)/i,
  },
  {
    id: 'obfuscation',
    severity: 'medium',
    why: 'A long encoded or hex-escaped run. Source is written to be read; something hidden in it was hidden on purpose.',
    re: /['"`][A-Za-z0-9+/]{200,}={0,2}['"`]|(?:\\x[0-9a-f]{2}){16,}|(?:\\u[0-9a-f]{4}){16,}/i,
  },
];

// Strips line and block comments so a word in prose ("silently retries") cannot
// be mistaken for a construct. Deliberately crude — it does not need to parse,
// only to stop the commonest false positive. String contents are LEFT in,
// because an encoded payload or a credential path lives inside a string and is
// exactly what should be caught.
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')      // // ... but not http://
    .replace(/(^|\s)#[^\n]*/g, '$1');              // python/ruby/shell #
}

function scanSourceFile(text, rel) {
  const code = stripComments(text);
  const findings = [];
  for (const rule of SOURCE_RULES) {
    const m = rule.re.exec(code);
    if (!m) continue;
    findings.push({
      file: rel,
      id: rule.id,
      severity: rule.severity,
      why: rule.why,
      match: m[0].replace(/\s+/g, ' ').trim().slice(0, 120),
    });
  }
  return findings;
}

// Which files are worth reading. Manifests always; source by extension; and
// nothing enormous, since a multi-megabyte file is generated or vendored and a
// hit in it is noise.
const MANIFEST_NAMES = new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'Gemfile', 'go.mod']);
const LOCKFILE_NAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'go.sum']);
const SCANNABLE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.sh', '.bash', '.ps1', '.php']);
const SCAN_MAX_BYTES = 512 * 1024;

function classifyForScan(name) {
  if (MANIFEST_NAMES.has(name)) return name === 'package.json' ? 'package' : 'manifest';
  if (LOCKFILE_NAMES.has(name)) return 'lockfile';
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot).toLowerCase();
  return SCANNABLE_EXTS.has(ext) ? 'source' : null;
}

// Dispatches one file to the right scanner. `changed` marks a file the caller
// found newer than the last audit or dirty in git — not a finding itself, but a
// reason to read closely, since an attack that just landed is the one that
// matters most.
function scanFile({ name, rel, content, changed }) {
  const kind = classifyForScan(name);
  if (!kind) return [];
  let findings;
  if (kind === 'package') findings = scanPackageJson(content, rel);
  else if (kind === 'lockfile') findings = scanLockfile(content, rel);
  else findings = scanSourceFile(content, rel);
  return changed ? findings.map(f => ({ ...f, changed: true })) : findings;
}

const SCAN_SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

// Turns raw findings into what the model is asked to triage, and what the
// report shows. Sorted worst-first, changed-first within a severity, and capped
// so a pathological repo cannot produce a report nobody reads.
function summarizeScan(findings, { scanned = 0, root = '' } = {}) {
  const sorted = [...findings].sort((a, b) => {
    const s = SCAN_SEVERITY_RANK[a.severity] - SCAN_SEVERITY_RANK[b.severity];
    if (s) return s;
    return (b.changed ? 1 : 0) - (a.changed ? 1 : 0);
  });
  const high = sorted.filter(f => f.severity === 'high').length;
  const medium = sorted.filter(f => f.severity === 'medium').length;
  const low = sorted.filter(f => f.severity === 'low').length;
  return {
    scanned, root,
    total: sorted.length,
    counts: { high, medium, low },
    findings: sorted.slice(0, 100),
    headline: sorted.length
      ? `${sorted.length} thing${sorted.length === 1 ? '' : 's'} to look at`
        + ` (${high} high, ${medium} medium, ${low} low) across ${scanned} file${scanned === 1 ? '' : 's'}`
      : `Nothing flagged across ${scanned} file${scanned === 1 ? '' : 's'}.`,
  };
}

// The block handed to the model for triage. It gets the FINDINGS, not the whole
// repo — the deterministic pass already decided where to look, and the model's
// job is to say which of these actually matter and why, in the project's own
// terms. Explicitly told not to invent findings beyond the list, because a
// model asked to "find security issues" will always find something.
function scanTriagePrompt(summary) {
  const lines = [
    'You are triaging the result of a supply-chain security scan of the current project.',
    'Navy scanned the files below and flagged these by pattern. Your job is to judge which',
    'are real and which are benign, in THIS project\'s terms, and to say plainly what a',
    'developer should do about each — not to invent new findings beyond this list.',
    '',
    `Scan: ${summary.headline}`,
    '',
  ];
  for (const f of summary.findings) {
    lines.push(`- [${f.severity.toUpperCase()}${f.changed ? ' · recently changed' : ''}] ${f.file} — ${f.id}`);
    lines.push(`    why flagged: ${f.why}`);
    lines.push(`    matched: ${f.match}`);
  }
  if (!summary.findings.length) {
    lines.push('- (nothing matched — say so briefly; do not manufacture concerns)');
  }
  lines.push('');
  lines.push('For each finding worth attention: name the file, say whether it looks like a real');
  lines.push('risk or an expected pattern, and give the one concrete next step. Group the rest as');
  lines.push('"looks benign" rather than walking through every line. Be concise; a developer runs');
  lines.push('this repeatedly and does not want a wall of text each time.');
  return lines.join('\n');
}

module.exports = {
  fingerprintPrompt, auditPrompt, riskSummary, reviewReport, RISK_RULES,
  scanFile, scanSourceFile, classifyForScan, summarizeScan, scanTriagePrompt,
  scanPackageJson, scanLockfile, SOURCE_RULES, SCAN_MAX_BYTES, SCANNABLE_EXTS,
};
