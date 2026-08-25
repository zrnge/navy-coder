// ── Diagnostics bundle ───────────────────────────────────────────────────────
// Navy sends nothing anywhere, which is a deliberate product stance and stays
// that way. The cost of it is real though: when something breaks there is no
// crash report, no way to know which of eleven providers is currently broken
// for users, and a bug report reduces to "it didn't work".
//
// This closes that without retracting the promise. `Navy Coder: Export
// Diagnostics` assembles what a maintainer would otherwise have to ask for,
// one question at a time, and puts it in an UNSAVED editor tab. Nothing is
// written to disk, nothing is transmitted, and no key is ever read — the user
// looks at it, and decides whether to paste it into an issue.
//
// Everything here is redacted on the way in, not on the way out: the ring
// buffer stores already-scrubbed lines, so a report cannot leak something the
// scrubber missed at render time.
//
// Extracted from extension.js as its own module. These are methods on
// NavyCoderViewProvider — mixed into its prototype at the bottom of
// extension.js — so `this` means what it always did. Written as a class so the
// block moves verbatim; see mixinPrototype in extension.js.

const vscode = require('vscode');
const os = require('os');
const { PRICING_AS_OF, estimateCost, LOCAL_PROVIDERS } = require('./providers/pricing.js');

// How many log lines the bundle can report. Enough to cover a failing turn and
// what led up to it; small enough that a chatty session cannot grow the buffer
// without bound over a day of use.
const LOG_RING_MAX = 200;

// Things that must never reach a report the user might paste in public.
// Applied when a line ENTERS the ring, so a later change to the renderer
// cannot accidentally bypass it.
const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-<redacted>'],                 // OpenAI-style
  [/\bgsk_[A-Za-z0-9_-]{16,}/g, 'gsk_<redacted>'],               // Groq
  [/\bxai-[A-Za-z0-9_-]{16,}/g, 'xai-<redacted>'],               // xAI
  [/\bAIza[A-Za-z0-9_-]{20,}/g, 'AIza<redacted>'],               // Google
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, 'sk-ant-<redacted>'],         // Anthropic
  // Authorization first, and it has to swallow the scheme AND the token. An
  // alternation of (Bearer|Authorization:) matches only the word "Bearer" in
  // "Authorization: Bearer <token>" and leaves the token itself in the clear.
  [/\bAuthorization\s*:\s*(?:bearer\s+)?\S+/gi, 'Authorization: <redacted>'],
  [/\bBearer\s+\S+/gi, 'Bearer <redacted>'],
  // Anything that merely LOOKS like a credential. Deliberately broad: a false
  // positive costs a maintainer one unreadable token in a log line, a false
  // negative costs a user their key.
  [/\b[A-Za-z0-9_-]{40,}\b/g, '<redacted-long-token>'],
];

class DiagnosticsMethods {
  // Scrubs a single line: secrets first, then the two paths that identify a
  // person — their home directory and whatever they happen to be working on.
  _redactForReport(line) {
    let out = String(line == null ? '' : line);
    for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
    const root = this.projectRoot;
    if (root) {
      // Both separators: a path can reach a log line in either form on Windows.
      for (const variant of [root, root.replace(/\\/g, '/')]) {
        if (variant) out = out.split(variant).join('<project>');
      }
    }
    const home = os.homedir();
    if (home) {
      for (const variant of [home, home.replace(/\\/g, '/')]) {
        if (variant) out = out.split(variant).join('~');
      }
    }
    return out;
  }

  // Called for every line that goes to the output channel. Bounded, scrubbed,
  // and never persisted — the buffer dies with the window.
  _recordLogLine(line) {
    if (!this._logRing) this._logRing = [];
    this._logRing.push(this._redactForReport(line));
    if (this._logRing.length > LOG_RING_MAX) this._logRing.splice(0, this._logRing.length - LOG_RING_MAX);
  }

  // The report itself. Pure string assembly from state Navy already has, so it
  // works when the thing being diagnosed is badly broken.
  buildDiagnosticsReport() {
    const c = vscode.workspace.getConfiguration('navy');
    const provider = c.get('provider', 'ollama');
    const model = c.get('model', '') || '(auto)';
    const shell = this._resolveShell();
    const mcpServers = Object.keys(c.get('mcpServers', {}) || {});
    // Whether a key EXISTS, never what it is. "no key configured" against a
    // hosted provider is the single most common cause of a broken install.
    const keyState = this._diagnosticsKeyState === undefined ? 'not checked' : (this._diagnosticsKeyState ? 'present' : 'MISSING');
    const isLocal = LOCAL_PROVIDERS.has(provider);
    const priced = estimateCost(provider, c.get('model', ''), 1e6, 1e6, c.get('modelPricing', {}));

    const rows = [
      ['Navy', this._diagnosticsVersion || '(unknown)'],
      ['VS Code', vscode.version || '(unknown)'],
      ['Node', process.version],
      ['Platform', `${process.platform} ${process.arch}`],
      ['', ''],
      ['Provider', provider],
      ['Model', model],
      ['API key', keyState],
      ['Custom apiBase', c.get('apiBase', '') ? 'set' : 'default'],
      ['Ollama mode', c.get('ollamaMode', 'local')],
      ['Fallback providers', (c.get('providerFallbacks', []) || []).join(', ') || 'none'],
      ['', ''],
      ['Shell', `${shell.id} (${shell.bin})`],
      ['Sandbox', c.get('sandboxMode', 'off')],
      // Through the helpers, not the raw settings, for two reasons. The static
      // guard in approvalScopeSuite forbids any other site reading those keys —
      // wiring something to the wrong gate is a safety bug — and the EFFECTIVE
      // behaviour is what a diagnostic wants anyway: a hand-edited nonsense
      // value reads as "ask-always" here because that is what it will do.
      ['File approval', this._editsAutoApproved() ? 'auto-approve' : 'ask-always'],
      ['Command approval', this._commandsAutoApproved() ? 'auto-approve' : 'ask-always'],
      ['', ''],
      ['Context window', this.modelContextLength ? `${this.modelContextLength} tokens` : 'unknown'],
      ['Chars/token (learned)', this.charsPerToken ? this.charsPerToken.toFixed(2) : 'default (4)'],
      ['Reduced toolset', String(this._shouldReduceTools(c.get('model', '')))],
      ['Cost estimate', isLocal ? 'n/a — local models are free'
        : priced === null ? `UNAVAILABLE — ${model} is not in the pricing table (see navy.modelPricing)` : 'available'],
      ['Pricing checked', PRICING_AS_OF],
      ['', ''],
      ['Workspace trusted', String(vscode.workspace.isTrusted !== false)],
      ['Project open', this.projectRoot ? 'yes' : 'NO — no folder open'],
      ['MCP servers', mcpServers.length ? mcpServers.join(', ') : 'none configured'],
      ['Chats in session', String(this.sessions?.size ?? 1)],
      ['Messages in this chat', String(this.messages?.length ?? 0)],
    ];

    const width = Math.max(...rows.map(([k]) => k.length));
    const table = rows.map(([k, v]) => (k ? `${k.padEnd(width)}  ${v}` : '')).join('\n');
    const log = (this._logRing || []);

    return [
      '# Navy Coder diagnostics',
      '',
      `Generated ${new Date().toISOString()}.`,
      '',
      'This report was assembled locally and has not been sent anywhere. API keys are',
      'never read into it; file paths, home directory and anything resembling a',
      'credential are redacted. Read it before sharing it.',
      '',
      '## Environment',
      '',
      '```',
      table,
      '```',
      '',
      '## Recent log',
      '',
      log.length
        ? '```\n' + log.join('\n') + '\n```'
        : '_Nothing logged yet this session._',
      '',
      '## What to include with this',
      '',
      '- what you asked Navy to do',
      '- what it did instead',
      '- whether it is reproducible',
      '',
    ].join('\n');
  }

  // Opens the report in an UNSAVED editor tab. Deliberately not written to
  // disk: the point is that the user reads it and chooses, and a file in the
  // project is one `git add -A` away from being committed by accident.
  async exportDiagnostics() {
    try {
      // Resolved here rather than in the builder so the builder stays
      // synchronous and cannot fail on a broken secrets store.
      try {
        const key = await this.context.secrets.get('navy.apiKey.' + vscode.workspace.getConfiguration('navy').get('provider', 'ollama'))
                 || await this.context.secrets.get('navy.apiKey') || '';
        this._diagnosticsKeyState = Boolean(key);
      } catch { this._diagnosticsKeyState = undefined; }

      const report = this.buildDiagnosticsReport();
      const doc = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: false });
      return report;
    } catch (e) {
      this.log?.('diagnostics export failed: ' + e.message);
      vscode.window.showErrorMessage('Navy: could not build the diagnostics report — ' + e.message);
      return null;
    }
  }
}

module.exports = { DIAGNOSTICS_METHODS: DiagnosticsMethods.prototype, LOG_RING_MAX, SECRET_PATTERNS };
