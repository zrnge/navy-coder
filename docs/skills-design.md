# Agent Skills in Navy — design

**Status:** implemented in 0.2.7 — `src/skills.js`, wired in `src/extension.js`.
**Sequencing:** taken via the §9 fallback (standalone module, wiring only in
`extension.js`) rather than waiting on the tool extraction.

Two things below were changed during implementation, both recorded here rather
than quietly diverged from:

- **§4, angle brackets.** The rule is applied to the *parsed* frontmatter keys
  and values, not to the raw frontmatter text. `>` is YAML's own folded-scalar
  indicator, so a raw-text rule would have rejected `description: >-` — the
  normal way to write a long description — while covering nothing extra: the
  parsed strings are the entire surface that reaches the system prompt.
- **§7, the tool.** One `activate_skill(name, file?)` rather than a separate
  reader for bundled documents. A second tool means a second schema in every
  request, which is the exact budget §5 exists to protect.

One thing §3 asked for that is done differently: discovery is invalidated when a
`SKILL.md` is **saved**, not by the general file watcher, which deliberately
ignores everything under `.navy/` (see `_invalidatePathCaches`). Same effect,
and precise rather than repo-wide.

Navy has rules and slash commands. It has no skills. This is what adding them
should look like, written down before any code because two of the decisions
below are hard to reverse once people have authored skills against them.

---

## 1. What a skill is, and what it isn't

Navy already has three layers that get confused with each other:

| Layer | Who invokes it | When it's in context | Navy today |
| --- | --- | --- | --- |
| **Rules** (`AGENTS.md`, `.cursorrules`, `.navyrules`) | nobody — always on | every turn, in full | ✅ `loadProjectRules()` |
| **Slash commands** | the user, explicitly | only the turn they're used | ✅ but hardcoded in `media/main.js` |
| **MCP servers** | the model, as tools | tool schemas, every turn | ✅ `src/providers/mcp.js` |
| **Skills** | the model, by matching a description | name+description always; body on activation; files on demand | ❌ |

A skill is not a user-defined slash command. The defining property is
**progressive disclosure**: a skill can carry a 400-line reference document and
three executable scripts, and none of that touches the context window until the
model decides the task calls for it.

## 2. Format — adopt the standard verbatim

[Agent Skills](https://agentskills.io/specification). No Navy dialect, no
extensions, no "mostly compatible".

```
skill-name/
├── SKILL.md          # required
├── scripts/          # optional: executable code
├── references/       # optional: docs loaded on demand
└── assets/           # optional: templates, schemas
```

`SKILL.md` frontmatter — Navy validates all of it and **skips** a skill that
fails, with the reason in the output channel:

| Field | Required | Constraint |
| --- | --- | --- |
| `name` | yes | 1–64 chars, `[a-z0-9-]`, no leading/trailing `-`, no `--`, must equal the directory name |
| `description` | yes | 1–1024 chars |
| `license` | no | free text |
| `compatibility` | no | ≤500 chars |
| `metadata` | no | string→string map |
| `allowed-tools` | no | parsed, **not honoured as pre-approval** — see §4 |

Angle brackets are rejected anywhere in frontmatter. The spec calls this out as
a prompt-injection guard and it is a real one: the description goes verbatim
into Navy's system prompt.

Writing a bespoke format would be the single worst decision available here.
There is an existing ecosystem of skills, and the whole argument for Navy's
rules loader — read what other tools already write — applies with more force to
a format that has a published spec and a reference validator.

## 3. Discovery

Read, in precedence order (later overrides earlier on a name collision):

1. `<globalStorage>/skills/` — user's own, all projects
2. `~/.claude/skills/` — **other tools' skills, read as-is**
3. `.claude/skills/` — project-scoped, other tools'
4. `.navy/skills/` — project-scoped, Navy's own

Reading `.claude/skills/` is the same citizenship argument as reading
`.cursorrules`: same format, zero cost, immediate access to every skill anyone
has already written. A project skill overriding a personal one matches how
`loadProjectRules()` already layers.

Global skills live under `context.globalStorageUri`, not `~/.navy/` — the
reasoning is identical to the 0.2.7 project-catalog move: `~` is shared between
VS Code profiles and Stable/Insiders, isn't covered by Settings Sync, and
resolves on the wrong machine over SSH.

Discovery is watched by the existing file watcher, so adding a skill takes
effect without a reload.

## 4. Security — the part that actually matters

Navy's highest-scoring property is that it asks before it acts. A skill is a
folder of instructions and executable code that arrives from a repository,
possibly written by someone else. Three rules, none negotiable:

**`allowed-tools` is advisory. It never pre-approves anything.** The field is
marked experimental in the spec, so ignoring its pre-approval semantics is
standard-compliant. Honouring it would let any repository turn off the approval
gate by shipping a file, which is a worse outcome than not supporting skills at
all. Navy parses it, shows it in the skill's detail view so a user can see what
a skill *wants*, and gates every call exactly as it does today.

**Bundled scripts are commands.** `scripts/build.py` runs through
`toolRunCommand` → the approval dialog → `_maybeWrapForSandbox`. There is no
separate execution path, because a separate path is a path that bypasses the
gate.

**Untrusted-workspace behaviour follows the existing rule.** In a workspace the
user hasn't trusted, project skills (`.claude/skills/`, `.navy/skills/`) are
listed but not loaded, matching the existing refusal to run commands or launch
MCP servers there. Personal skills from global storage are unaffected — the user
wrote those.

A fourth, softer risk: a skill's `description` is attacker-controlled text
injected into the system prompt. Beyond the angle-bracket rule, descriptions are
length-capped and rendered into a fixed template rather than concatenated raw.

## 5. Context budget

Every installed skill's name and description sits in **every request, forever**.
That is the cost people underestimate. At ~100 tokens each, fifty skills is
~5,000 tokens per turn — most of the budget on an 8k local model, which is a
large part of Navy's audience.

- `navy.skills` — `"auto"` (default), `"off"`, or an explicit array of names
- A hard cap on the total skill manifest, derived from `_contextCharCaps()` so
  it scales with the model like everything else does
- Over the cap: load in discovery-precedence order until it's reached, and say
  in the output channel which ones were dropped. Never silently.

## 6. Small models — the reason this could be worthless

Skills only pay for themselves if the model reliably picks the right one from a
one-line description. Frontier models do. `qwen2.5-coder:1.5b` does not, and a
skill that never gets selected is pure context cost with no upside.

**Every skill is also a slash command.** `/pdf-processing` loads that skill's
body and proceeds — no model selection involved. This costs almost nothing to
build (the mechanism is the same as activation), makes skills useful on models
that can't select them, and incidentally fixes the existing limitation that
`SLASH_COMMANDS` is a hardcoded array a user cannot extend.

The built-in sixteen commands stay as they are; user skills append.

## 7. Module layout

`src/skills.js`. Not `extension.js`.

```js
// Pure, unit-testable — no vscode, no fs.
parseSkill(text, dirName) -> { skill, errors }
manifestFor(skills, budgetChars) -> { text, included, dropped }

// I/O, thin.
class SkillRegistry {
  async discover(paths)      // read dirs, parse, validate, dedupe by precedence
  get(name)                  // activation: read SKILL.md body on demand
  resolveFile(name, relPath) // references/ + scripts/, containment-checked
}
```

`resolveFile` runs the same path-containment check as every file tool: a skill
must not be able to read outside its own directory via `../`.

`extension.js` gains only the wiring — a registry instance, the manifest in the
system prompt, an `activate_skill` tool, and the slash-command list.

## 8. Out of scope for v1

Deliberately, so the first version ships:

- Installing skills from a URL or registry. Copying a folder is enough.
- `metadata`-driven versioning or update checks.
- Skill-authored *tools* (as distinct from scripts). That's what MCP is for.
- Any Navy-specific frontmatter field.

## 9. Sequencing

Skills should not be built into today's `extension.js`. It is 7,600 lines and
~55% of the codebase; adding a subsystem to it is how it got that way. The
tool-implementation extraction (Task 4, seam 1) comes first, and skills go into
the module structure that leaves behind.

If that ordering has to break, the fallback is that `src/skills.js` is written
standalone with only its wiring in `extension.js` — which is the plan above
anyway.

## 10. Tests

- **Parsing**: every frontmatter constraint, each as its own case — the
  consecutive-hyphen rule, name/directory mismatch, over-length description,
  angle brackets rejected, unknown fields ignored rather than fatal.
- **Precedence**: a project skill shadows a personal one of the same name;
  `.claude/skills/` is read; a malformed skill is skipped without taking down
  discovery, exactly as a corrupt embedding shard does.
- **Budget**: the manifest is capped; what got dropped is reported.
- **Security**: `allowed-tools` does not pre-approve; a bundled script runs
  through the approval gate; `resolveFile` refuses `../` escapes; project skills
  are not loaded in an untrusted workspace.
- **Slash commands**: a discovered skill appears; the built-in sixteen still
  work.
