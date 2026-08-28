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

module.exports = { fingerprintPrompt, auditPrompt, riskSummary, reviewReport, RISK_RULES };
