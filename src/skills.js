// ── Agent Skills ────────────────────────────────────────────────────────────
// Implements docs/skills-design.md. Read that first — it argues the decisions;
// this file only carries them out, and the comments here point back at the
// sections rather than restating them.
//
// A skill is a folder with a SKILL.md. What separates it from a slash command
// (src/slash-commands.js) is PROGRESSIVE DISCLOSURE: only the name and
// description are in the model's context, on every turn, forever. The body is
// read when the model decides the task calls for it, and the bundled reference
// documents and scripts are read after that, one at a time. A skill can
// therefore carry a 400-line reference and cost ~30 tokens until it is needed.
//
// Format is the published Agent Skills spec (https://agentskills.io/specification)
// verbatim — no Navy dialect, no extra fields. The whole argument for Navy's
// rules loader (read what other tools already write) applies with more force to
// a format that has a spec and an existing ecosystem.
//
// Two things this deliberately does NOT do, both from §4 of the design:
//
//   * `allowed-tools` is parsed and shown, never honoured as pre-approval. The
//     field is experimental in the spec, so ignoring its approval semantics is
//     compliant. Honouring it would let any repository switch off Navy's
//     approval gate by shipping a file, which is worse than having no skills.
//   * Bundled scripts have no execution path of their own. They are run by
//     `run_command`, through the same approval dialog and the same
//     `_maybeWrapForSandbox`, because a separate path is a path around the gate.

const path = require('path');
const os = require('os');
const vscode = require('vscode');
const { workspaceIsTrusted } = require('./workspace.js');

// The spec's constraints, not Navy's. Individually named because each one is
// asserted on its own in the tests.
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const COMPATIBILITY_MAX = 500;
// Lowercase alphanumerics joined by single hyphens: no leading or trailing
// hyphen and no `--`, expressed as one pattern rather than three checks.
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// A SKILL.md larger than this is not a skill, it's a document that lost its
// way. The cap is on what is read, so an oversized file still loads — truncated
// — rather than vanishing with no explanation.
const SKILL_MD_MAX = 64 * 1024;
const SKILL_FILE_MAX = 128 * 1024;   // a references/ document, on activation
const MAX_SKILLS = 200;

function unquote(value) {
  const v = String(value).trim();
  const m = v.match(/^(["'])([\s\S]*)\1$/);
  return m ? m[2] : v;
}

// Enough YAML for frontmatter and no more: scalars, quoted scalars, flow and
// block sequences, one level of nested map (for `metadata`), and block scalars
// (`|`, `>`, and their `-` chomping variants) because a 1024-character
// description written on one physical line is not something anyone does.
//
// Hand-rolled because the zero-runtime-dependency rule leaves no alternative.
// Anything it doesn't recognise is skipped rather than fatal — a skill carrying
// richer frontmatter for some other tool still loads here.
function parseYamlish(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const out = {};
  let i = 0;
  const indentOf = (line) => line.match(/^[ \t]*/)[0].length;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) { i++; continue; }
    const m = line.match(/^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    i++;

    // Block scalar: `|` keeps the line breaks, `>` folds them into spaces.
    if (/^[|>][-+]?$/.test(value)) {
      const block = [];
      while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > 0)) { block.push(lines[i]); i++; }
      // Dedent by the least-indented real line, the way YAML does, so the text
      // doesn't arrive carrying the file's own layout.
      const indents = block.filter(l => l.trim()).map(indentOf);
      const strip = indents.length ? Math.min(...indents) : 0;
      const text = block.map(l => l.slice(strip));
      out[key] = value[0] === '>'
        ? text.join(' ').replace(/\s+/g, ' ').trim()
        : text.join('\n').replace(/\s+$/, '');
      continue;
    }

    // `key:` with nothing after it — the next indented block is a list or a map.
    if (value === '') {
      const list = [];
      const nested = {};
      while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > 0)) {
        const item = lines[i].match(/^[ \t]+-[ \t]+(.*)$/);
        const kv = lines[i].match(/^[ \t]+([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/);
        if (item) list.push(unquote(item[1]));
        else if (kv) nested[kv[1]] = unquote(kv[2]);
        i++;
      }
      out[key] = list.length ? list : nested;
      continue;
    }

    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value.slice(1, -1).split(',').map(s => unquote(s)).filter(Boolean);
      continue;
    }
    out[key] = unquote(value);
  }
  return out;
}

function splitFrontmatter(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return null;
  return { raw: m[1], body: src.slice(m[0].length) };
}

// Every string a skill contributes to the system prompt, flattened, so the
// angle-bracket rule below can be applied to all of them at once.
function frontmatterStrings(meta) {
  const out = [];
  for (const [key, value] of Object.entries(meta)) {
    out.push(key);
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) out.push(...value.map(String));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) out.push(k, String(v));
    }
  }
  return out;
}

/**
 * One SKILL.md → a validated skill, or the reasons it was rejected.
 * Pure: no filesystem, no vscode, so every constraint is directly testable.
 *
 * @param {string} text     the file's contents
 * @param {string} dirName  the containing directory, which `name` must equal
 * @returns {{ skill: object|null, errors: string[] }}
 */
function parseSkill(text, dirName) {
  const fm = splitFrontmatter(text);
  if (!fm) return { skill: null, errors: ['no YAML frontmatter — SKILL.md must open with a --- fenced block'] };
  const meta = parseYamlish(fm.raw);
  const errors = [];

  // The spec's prompt-injection guard, and a real one: `description` goes
  // verbatim into Navy's system prompt on every turn.
  //
  // Applied to the PARSED keys and values rather than to the raw frontmatter
  // text, which is where the design doc put it. `>` is YAML's own folded-scalar
  // indicator, so a raw-text rule would reject `description: >-` — a normal way
  // to write a long description — while covering nothing extra: the parsed
  // strings are the entire surface that reaches the prompt.
  if (frontmatterStrings(meta).some(s => /[<>]/.test(s))) {
    errors.push('angle brackets are not allowed in frontmatter');
  }

  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (!name) errors.push('missing required field: name');
  else if (name.length > NAME_MAX) errors.push(`name is ${name.length} characters, the limit is ${NAME_MAX}`);
  else if (!SKILL_NAME_RE.test(name)) errors.push(`name "${name}" must be lowercase letters, digits and single hyphens, with no leading, trailing or repeated "-"`);
  else if (dirName && name !== dirName) errors.push(`name "${name}" does not match its directory "${dirName}" — they have to be the same`);

  const description = typeof meta.description === 'string' ? meta.description.trim() : '';
  if (!description) errors.push('missing required field: description');
  else if (description.length > DESCRIPTION_MAX) errors.push(`description is ${description.length} characters, the limit is ${DESCRIPTION_MAX}`);

  const compatibility = typeof meta.compatibility === 'string' ? meta.compatibility.trim() : '';
  if (compatibility.length > COMPATIBILITY_MAX) errors.push(`compatibility is ${compatibility.length} characters, the limit is ${COMPATIBILITY_MAX}`);

  if (errors.length) return { skill: null, errors };

  // Accepts both shapes the spec's own examples use: a comma-separated string
  // and a list. Normalised to an array here so nothing downstream has to care.
  const rawTools = meta['allowed-tools'];
  const allowedTools = Array.isArray(rawTools)
    ? rawTools.map(t => String(t).trim()).filter(Boolean)
    : typeof rawTools === 'string' ? rawTools.split(',').map(t => t.trim()).filter(Boolean) : [];

  const metadata = {};
  if (meta.metadata && typeof meta.metadata === 'object' && !Array.isArray(meta.metadata)) {
    for (const [k, v] of Object.entries(meta.metadata)) if (typeof v === 'string') metadata[k] = v;
  }

  return {
    skill: {
      name,
      description,
      license: typeof meta.license === 'string' ? meta.license.trim() : '',
      compatibility,
      metadata,
      allowedTools,   // recorded and displayed; never consulted for permission
      body: fm.body.trim(),
    },
    errors: [],
  };
}

const MANIFEST_HEADER = 'Skills available (expertise you can load; not loaded yet):';
const MANIFEST_FOOTER = 'Call activate_skill with a skill\'s name to read its full instructions BEFORE '
  + 'starting work that matches it. The one-line summaries above are all you know about them — do not '
  + 'guess at the contents. Loading a skill grants no extra permission: everything it tells you to do '
  + 'still goes through the same approval gate.';

/**
 * The block that goes in the system prompt, bounded by `budgetChars`.
 * Pure. `skills` must already be ordered most-important-first, since that is
 * the order inclusion stops at when the budget runs out.
 *
 * @returns {{ text: string, included: string[], dropped: string[] }}
 */
function manifestFor(skills, budgetChars) {
  const included = [];
  const dropped = [];
  const budget = Math.max(0, Number(budgetChars) || 0);
  let size = MANIFEST_HEADER.length + MANIFEST_FOOTER.length + 2;
  for (const skill of skills || []) {
    const line = `\n- ${skill.name}: ${skill.description}`;
    // No "always include at least one": the budget scales with the model's own
    // window (see _skillBudgetChars), so on a small model an over-budget
    // manifest is exactly the cost §5 of the design exists to prevent.
    if (size + line.length > budget) { dropped.push(skill.name); continue; }
    size += line.length;
    included.push(skill);
  }
  if (!included.length) return { text: '', included: [], dropped };
  const text = MANIFEST_HEADER
    + included.map(s => `\n- ${s.name}: ${s.description}`).join('')
    + '\n\n' + MANIFEST_FOOTER;
  return { text, included: included.map(s => s.name), dropped };
}

/**
 * Discovery and on-demand reading. Thin over the filesystem on purpose — the
 * decisions live in parseSkill and manifestFor, which are pure.
 */
class SkillRegistry {
  constructor({ log } = {}) {
    this.log = log || (() => {});
    this.skills = new Map();   // name → record, highest precedence wins
    this.problems = [];        // [{ dir, reason }] — surfaced in the output channel
    this._blocked = [];        // every skill an untrusted workspace offered
  }

  /**
   * @param {{dir: string, origin: string, trusted?: boolean}[]} dirs
   *        in PRECEDENCE ORDER, lowest first — a later directory's skill of the
   *        same name replaces an earlier one.
   */
  async discover(dirs) {
    this.skills.clear();
    this.problems = [];
    this._blocked = [];
    let rank = 0;
    for (const entry of dirs || []) {
      await this._readDir(entry, rank++);
    }
    // Returned most-important-first, which is the order manifestFor stops at
    // when the budget runs out: a project's own skills are the ones you least
    // want silently dropped.
    return [...this.skills.values()].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  }

  async _readDir({ dir, origin, trusted = true }, rank) {
    let entries = [];
    try { entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir)); }
    catch { return; }   // absent is the normal case
    for (const [entryName, type] of entries) {
      if (type !== vscode.FileType.Directory) continue;
      if (this.skills.size >= MAX_SKILLS) { this.problems.push({ dir, reason: `more than ${MAX_SKILLS} skills — the rest were ignored` }); return; }
      const skillDir = path.join(dir, entryName);
      const file = path.join(skillDir, 'SKILL.md');
      let text;
      try { text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(file))).toString('utf8').slice(0, SKILL_MD_MAX); }
      catch { continue; }   // a directory with no SKILL.md is not a skill, and not an error
      const { skill, errors } = parseSkill(text, entryName);
      if (!skill) {
        // Skipped, never fatal — one malformed skill must not take discovery
        // down with it, the same way one corrupt embedding shard doesn't.
        this.problems.push({ dir: skillDir, reason: errors.join('; ') });
        this.log(`skill skipped (${skillDir}): ${errors.join('; ')}`);
        continue;
      }
      const record = {
        name: skill.name,
        description: skill.description,
        license: skill.license,
        compatibility: skill.compatibility,
        metadata: skill.metadata,
        allowedTools: skill.allowedTools,
        dir: skillDir,
        file,
        origin,
        rank,
        // Untrusted workspace: listed, so the user can see what the repository
        // is offering, but never loaded or activatable — the same line Navy
        // already draws for running commands and launching MCP servers.
        blocked: !trusted,
      };
      if (record.blocked) this._blocked.push(record);
      const existing = this.skills.get(skill.name);
      // Precedence is what a project's skill wins on, but a skill that CANNOT
      // BE LOADED must never displace one that can. Otherwise an untrusted
      // repository shipping `pdf-tools/` would silently remove the working
      // pdf-tools the user already had, and hand back one they can't use —
      // taking a capability away rather than being ignored.
      if (existing && !existing.blocked && record.blocked) continue;
      this.skills.set(skill.name, record);
    }
  }

  /** Every skill that may actually be used. */
  available() {
    return [...this.skills.values()]
      .filter(s => !s.blocked)
      .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  }

  // Everything an untrusted workspace offered — including any that lost to a
  // usable skill of the same name, since "this repo has one too" is still worth
  // saying. Deduped, because two untrusted directories can offer the same name.
  blocked() {
    const seen = new Set();
    return this._blocked.filter(s => !seen.has(s.name) && seen.add(s.name));
  }

  /**
   * Activation. Re-reads SKILL.md rather than serving a copy kept since
   * discovery: the body is the large part, holding every one of them in memory
   * for a window's lifetime is the cost this design exists to avoid, and an
   * edited skill takes effect on its next use instead of on the next reload.
   */
  async body(name) {
    const skill = this.skills.get(name);
    if (!skill || skill.blocked) return null;
    try {
      const text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(skill.file))).toString('utf8').slice(0, SKILL_MD_MAX);
      return parseSkill(text, skill.name).skill?.body ?? null;
    } catch { return null; }
  }

  /**
   * An absolute path inside `name`'s own directory, or null.
   * The same containment check every file tool runs: a skill's reference
   * document must not be a way to read `../../../.ssh/id_rsa`.
   */
  resolveFile(name, relPath) {
    const skill = this.skills.get(name);
    if (!skill || skill.blocked) return null;
    const rel = String(relPath || '').trim();
    if (!rel) return null;
    const base = path.resolve(skill.dir);
    const target = path.resolve(base, rel);
    if (target !== base && !target.startsWith(base + path.sep)) return null;
    return target;
  }

  /** Files a skill ships, so activation can say what else is available. */
  async listFiles(name) {
    const skill = this.skills.get(name);
    if (!skill || skill.blocked) return [];
    const out = [];
    for (const sub of ['references', 'scripts', 'assets']) {
      let entries = [];
      try { entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path.join(skill.dir, sub))); }
      catch { continue; }
      for (const [entryName, type] of entries) {
        if (type === vscode.FileType.File) out.push(`${sub}/${entryName}`);
      }
    }
    return out;
  }

  get(name) { return this.skills.get(name) || null; }
}

// ── Wiring, as methods on NavyCoderViewProvider ─────────────────────────────

// Share of the model's own compaction budget that the skill manifest may take.
// Every name and description is in EVERY request, forever, which is the cost
// people underestimate — at ~100 tokens each, fifty skills is ~5,000 tokens per
// turn, most of the budget on the 8k local models that are a real part of
// Navy's audience. 2.5% of the compact budget is ~12 skills on a 200k model and
// ~4 on an 8k one, which is the right shape: the limit tightens exactly where
// the context is scarce.
const SKILL_BUDGET_FRACTION = 0.025;
const SKILL_BUDGET_FLOOR = 600;

const SKILL_METHODS = {
  _skillsRegistry() {
    if (!this._skills) this._skills = new SkillRegistry({ log: (line) => this.log?.(line) });
    return this._skills;
  },

  // Precedence order, LOWEST first — see §3 of the design for why
  // `.claude/skills` is read at all, and why the personal ones live in VS
  // Code's managed storage rather than in ~/.navy.
  _skillDirs() {
    const trusted = workspaceIsTrusted();
    const dirs = [
      { dir: path.join(this._globalProjectsDir(), 'skills'), origin: 'personal', trusted: true },
      { dir: path.join(os.homedir(), '.claude', 'skills'), origin: 'personal-shared', trusted: true },
    ];
    const root = this.projectRoot;
    if (root) {
      dirs.push({ dir: path.join(root, '.claude', 'skills'), origin: 'project-shared', trusted });
      dirs.push({ dir: path.join(root, '.navy', 'skills'), origin: 'project', trusted });
    }
    return dirs;
  },

  _skillBudgetChars() {
    const { compact } = this._contextCharCaps();
    return Math.max(SKILL_BUDGET_FLOOR, Math.floor(compact * SKILL_BUDGET_FRACTION));
  },

  // `navy.skills`: "auto" (default), "off", or an explicit list of names. The
  // explicit form is the escape hatch for someone who has collected more skills
  // than they want in every request.
  _skillSelection() {
    const raw = vscode.workspace.getConfiguration('navy').get('skills', 'auto');
    if (Array.isArray(raw)) return raw.map(String);
    return String(raw || 'auto').toLowerCase() === 'off' ? 'off' : 'auto';
  },

  async loadSkills() {
    if (this._skillSelection() === 'off') return [];
    const key = this.projectRoot || '';
    if (this._skillCache && this._skillCacheKey === key) return this._skillCache;
    let list = [];
    try { list = await this._skillsRegistry().discover(this._skillDirs()); }
    catch (e) { this.log?.('skill discovery failed: ' + e.message); }
    const blocked = this._skillsRegistry().blocked();
    if (blocked.length) {
      this.log?.(`skills not loaded (workspace not trusted): ${blocked.map(s => s.name).join(', ')}`);
    }
    this._skillCacheKey = key;
    this._skillCache = list.filter(s => !s.blocked);
    return this._skillCache;
  },

  // The block appended to the system prompt, or '' when there is nothing to
  // say. Anything dropped for budget is named in the output channel — §5 of the
  // design is explicit that this must never be silent.
  async skillManifest() {
    const selection = this._skillSelection();
    if (selection === 'off') return '';
    let skills = await this.loadSkills();
    if (Array.isArray(selection)) {
      const wanted = new Set(selection);
      skills = skills.filter(s => wanted.has(s.name));
    }
    if (!skills.length) return '';
    const { text, dropped } = manifestFor(skills, this._skillBudgetChars());
    if (dropped.length) {
      this.log?.(`skills omitted from this turn (manifest budget ${this._skillBudgetChars()} chars): ${dropped.join(', ')}`);
    }
    return text;
  },

  // Every skill is also a slash command (§6). Description-driven selection is
  // precisely what small local models are worst at, and a skill that never gets
  // selected is pure context cost — so the user can always invoke one directly.
  // The command inserts a short directive rather than the whole skill body: the
  // composer stays readable, and loading it is still one deterministic step
  // with no matching involved.
  async skillSlashCommands() {
    const skills = await this.loadSkills();
    return skills.map(s => ({
      cmd: '/' + s.name,
      label: s.name,
      icon: '📘',
      desc: s.description.length > 120 ? s.description.slice(0, 117) + '…' : s.description,
      hint: '',
      prompt: `Use the "${s.name}" skill for this task. Call activate_skill with name "${s.name}" `
        + `to read its instructions, then follow them.\n\n$ARGUMENTS`,
      origin: 'skill',
      custom: true,
      file: s.file,
      // Not removable from the menu: a skill is a directory, and an × that
      // deleted only SKILL.md would leave the rest of it orphaned on disk.
      removable: false,
    }));
  },

  _invalidateSkills(fsPath) {
    if (!fsPath) return false;
    if (!/(^|[\\/])SKILL\.md$/i.test(String(fsPath))) return false;
    this._skillCache = null;
    this._skillCacheKey = null;
    return true;
  },

  // ── activate_skill ────────────────────────────────────────────────────────
  // One tool, two jobs: with no `file` it returns the skill's instructions and
  // an index of what else it ships; with one, that bundled file. A second tool
  // would be a second schema in every request, which is the budget this whole
  // design is careful about.
  async toolActivateSkill(args) {
    const name = String(args?.name || '').trim();
    if (!name) return 'Error: activate_skill requires a skill name.';
    await this.loadSkills();
    const registry = this._skillsRegistry();
    const skill = registry.get(name);
    if (!skill) {
      const known = registry.available().map(s => s.name);
      return `Error: no skill named "${name}".` + (known.length ? ` Available: ${known.join(', ')}.` : ' No skills are installed.');
    }
    if (skill.blocked) {
      return `Error: the "${name}" skill comes from this workspace, which is not trusted, so it is not loaded. `
        + 'Trust the workspace (Workspaces: Manage Workspace Trust) if you want its skills available.';
    }

    const relPath = String(args?.file || '').trim();
    if (relPath) {
      const target = registry.resolveFile(name, relPath);
      if (!target) return `Error: "${relPath}" is not inside the ${name} skill.`;
      try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(target));
        const text = Buffer.from(data).toString('utf8');
        const clipped = text.length > SKILL_FILE_MAX;
        return `${name}/${relPath}:\n\n` + (clipped ? text.slice(0, SKILL_FILE_MAX) + `\n…[truncated ${text.length - SKILL_FILE_MAX} chars]` : text);
      } catch (e) {
        return `Error: could not read ${relPath} from the ${name} skill — ${e.message}`;
      }
    }

    const body = await registry.body(name);
    if (body === null) return `Error: could not read SKILL.md for "${name}".`;
    const files = await registry.listFiles(name);
    const parts = [`Skill "${name}" loaded.\n`, body];
    if (files.length) {
      parts.push(
        `\n---\nThis skill's own files, in ${skill.dir}:\n`
        + files.map(f => `- ${f}`).join('\n')
        + `\n\nRead one with activate_skill(name: "${name}", file: "references/whatever.md"). `
        + 'Run a script with run_command, using its full path above — like any other command, it goes to the user for approval first.');
    }
    if (skill.allowedTools.length) {
      // Shown so the user and the model can both see what a skill WANTS. It is
      // not permission and never becomes permission — see the file header.
      parts.push(`\n---\nThis skill declares allowed-tools: ${skill.allowedTools.join(', ')}. `
        + 'That is a declaration, not a grant: every call is approved exactly as it would be otherwise.');
    }
    return parts.join('\n');
  },
};

module.exports = {
  SKILL_METHODS, SkillRegistry, parseSkill, parseYamlish, manifestFor,
  SKILL_NAME_RE, NAME_MAX, DESCRIPTION_MAX, COMPATIBILITY_MAX, MAX_SKILLS,
};
