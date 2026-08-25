// ── Custom slash commands ───────────────────────────────────────────────────
// Navy shipped sixteen slash commands and no way to add a seventeenth. Every
// team has prompts it types constantly — "run our integration suite and triage
// what fails", "check this against our API conventions" — and retyping one from
// memory each time is how it ends up abbreviated into something that no longer
// says what it meant.
//
// A command is a markdown file. The filename is the command, the body is the
// prompt. That format is deliberate rather than novel: it is what the wider
// ecosystem already uses, so a repository that already has `.claude/commands/`
// works here with nothing moved, and a command written for Navy is not trapped
// in Navy. It is also reviewable — a prompt your colleagues will run is a thing
// that belongs in code review, and a JSON blob inside a settings file is not.
//
//   <project>/.navy/commands/*.md     the project's own, committed with it
//   <project>/.claude/commands/*.md   read as-is, for repos that already have them
//   <globalStorage>/commands/*.md     yours, in every project
//
// Two rules that are hard to change later, so they are settled here:
//
//   * A custom command MAY shadow a built-in. A team whose `/test` means
//     something specific should get that, and pretending otherwise just means
//     they name it `/test2`. Which definition won is shown in the dropdown.
//   * A command is prompt text and nothing more. It cannot pre-approve a tool,
//     skip the diff, or run anything by existing — every tool call it leads to
//     goes through exactly the same approval gate as one you typed yourself.
//     The same reasoning as `allowed-tools` in docs/skills-design.md: a file in
//     a repository must never be able to widen what Navy is permitted to do.
//
// Project commands are gated on workspace trust for that second reason read the
// other way round: cloning a repository must not silently redefine `/fix`.

const path = require('path');
const vscode = require('vscode');
const { workspaceIsTrusted } = require('./workspace.js');

// Caps. A commands directory is meant to hold a handful of prompts; these exist
// so a directory that has become something else can't stall the panel or push a
// megabyte of text into a dropdown.
const MAX_COMMANDS = 100;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_DESC = 120;

// Filenames become the thing the user types after `/`, so they are restricted
// to what the composer's own slash matcher will accept. Anything else is
// skipped rather than mangled into a command nobody can invoke.
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

const DEFAULT_ICON = '✦';

// Minimal front-matter: `key: value` lines between `---` fences. Deliberately
// not a YAML parser — this reads three optional keys, and the zero-runtime-
// dependency rule means a real parser would have to be written and maintained
// here. Anything it doesn't understand is ignored rather than rejected, so a
// file carrying richer front-matter for some other tool still works.
function parseFrontmatter(source) {
  const text = String(source || '');
  const m = text.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: text.replace(/^﻿/, '') };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/);
    if (!kv) continue;
    // Quotes are stripped because people write them, not because the format
    // needs them — nothing here is nested, so there is nothing to escape.
    meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * One command file → the record the composer renders and expands.
 * Pure: no filesystem, no vscode. Returns null for anything unusable, so a
 * malformed file costs itself and not the rest of the directory.
 *
 * @param {string} name    command name (filename without .md, or "dir:name")
 * @param {string} source  the file's text
 * @param {string} origin  'project' | 'shared' | 'personal'
 */
function parseCommandFile(name, source, origin) {
  const bare = String(name || '').trim();
  // A namespaced name is "<dir>:<name>" — both halves have to be typeable, and
  // there is only ever one level, matching what the loader can actually produce
  // (see _readCommandDir). Enforced here too so the two can't disagree.
  const parts = bare ? bare.split(':') : [];
  if (parts.length < 1 || parts.length > 2 || !parts.every(part => NAME_RE.test(part))) return null;
  const { meta, body } = parseFrontmatter(source);
  const prompt = body.trim();
  if (!prompt) return null;   // an empty file is a draft, not a command
  const label = (meta.label || parts[parts.length - 1]).slice(0, 40);
  // Falls back to the prompt's own first line: a command with no description is
  // far more useful listed with its opening words than with a blank column.
  const firstLine = prompt.split('\n').find(l => l.trim()) || '';
  return {
    cmd: '/' + bare,
    label,
    icon: (meta.icon || DEFAULT_ICON).slice(0, 4),
    desc: (meta.description || meta.desc || firstLine).replace(/\s+/g, ' ').trim().slice(0, MAX_DESC),
    hint: (meta.hint || meta['argument-hint'] || '').slice(0, 40),
    prompt,
    origin,
    custom: true,
  };
}

const SLASH_COMMAND_METHODS = {
  // Where personal commands live: the same managed per-extension storage the
  // project catalog uses, for the same reasons (profile-scoped, covered by
  // Settings Sync, removed with the extension, resolves locally over SSH).
  _personalCommandsDir() {
    return path.join(this._globalProjectsDir(), 'commands');
  },

  // Highest precedence LAST — the loader lets a later directory shadow an
  // earlier one, so a project's own definition wins over your personal one,
  // which wins over the built-in of the same name.
  _slashCommandDirs() {
    const dirs = [{ dir: this._personalCommandsDir(), origin: 'personal' }];
    const root = this.projectRoot;
    // Untrusted workspace: personal commands still load (you wrote them), the
    // repository's do not. See the header — a clone must not be able to
    // redefine what `/fix` means before you have said you trust it.
    if (root && workspaceIsTrusted()) {
      dirs.push({ dir: path.join(root, '.claude', 'commands'), origin: 'shared' });
      dirs.push({ dir: path.join(root, '.navy', 'commands'), origin: 'project' });
    }
    return dirs;
  },

  // Reads one directory, plus one level of subdirectories as `dir:name`
  // namespaces. Not fully recursive: a namespace is for grouping a handful of
  // related prompts, and unbounded depth only produces names too long to type.
  async _readCommandDir(dir, origin, out, seen) {
    let entries = [];
    try { entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir)); }
    catch { return; }   // absent is the normal case, not an error
    for (const [entryName, type] of entries) {
      if (out.length >= MAX_COMMANDS) return;
      if (type === vscode.FileType.Directory) {
        if (!NAME_RE.test(entryName)) continue;
        let nested = [];
        try { nested = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path.join(dir, entryName))); }
        catch { continue; }
        for (const [child, childType] of nested) {
          if (childType !== vscode.FileType.File || !child.endsWith('.md')) continue;
          await this._addCommandFile(path.join(dir, entryName, child), `${entryName}:${child.slice(0, -3)}`, origin, out, seen);
        }
        continue;
      }
      if (type !== vscode.FileType.File || !entryName.endsWith('.md')) continue;
      await this._addCommandFile(path.join(dir, entryName), entryName.slice(0, -3), origin, out, seen);
    }
  },

  async _addCommandFile(file, name, origin, out, seen) {
    let text;
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
      // Truncated rather than skipped: an over-long prompt is still a prompt,
      // and silently dropping the command would be the more confusing failure.
      text = Buffer.from(data).toString('utf8').slice(0, MAX_COMMAND_BYTES);
    } catch { return; }
    const command = parseCommandFile(name, text, origin);
    if (!command) return;
    command.file = file;
    // A command IS one file, so the menu's × can delete it outright. Skills,
    // which also appear here, are directories and are deliberately not.
    command.removable = true;
    // Later directory wins — see _slashCommandDirs for the precedence order.
    const existing = seen.get(command.cmd);
    if (existing !== undefined) { out[existing] = command; return; }
    seen.set(command.cmd, out.length);
    out.push(command);
  },

  // Cached per project root, because the composer asks for this on every `/`
  // keystroke. Invalidated by _invalidateSlashCommands when a command file is
  // saved, and dropped outright on a project switch.
  async loadSlashCommands() {
    const key = this.projectRoot || '';
    if (this._slashCommandCache && this._slashCommandCacheKey === key) return this._slashCommandCache;
    const out = [];
    const seen = new Map();
    for (const { dir, origin } of this._slashCommandDirs()) {
      await this._readCommandDir(dir, origin, out, seen);
    }
    this._slashCommandCacheKey = key;
    this._slashCommandCache = out;
    return out;
  },

  // A saved file under any commands directory drops the cache. Cheaper and more
  // precise than a filesystem watcher: command files are written in the editor,
  // so a save is the event, and the general watcher deliberately ignores
  // everything under .navy/ (see _invalidatePathCaches).
  _invalidateSlashCommands(fsPath) {
    if (!fsPath) return false;
    const p = String(fsPath).replace(/\\/g, '/').toLowerCase();
    if (!/(^|\/)(\.navy|\.claude)\/commands\//.test(p) && !p.startsWith(this._personalCommandsDir().replace(/\\/g, '/').toLowerCase())) return false;
    this._slashCommandCache = null;
    this._slashCommandCacheKey = null;
    return true;
  },

  async sendSlashCommands() {
    let commands = [];
    try { commands = await this.loadSlashCommands(); }
    catch (e) { this.log?.('slash commands: ' + e.message); }
    // Every installed skill is also a command (docs/skills-design.md §6):
    // description-driven selection is what small local models are worst at, and
    // a skill that never gets picked is pure context cost. Appended AFTER, so a
    // command file of the same name — which the user wrote deliberately for
    // this menu — is the one that wins.
    try {
      const taken = new Set(commands.map(c => c.cmd));
      for (const skill of await this.skillSlashCommands()) {
        if (!taken.has(skill.cmd)) commands.push(skill);
      }
    } catch (e) { this.log?.('skill commands: ' + e.message); }
    // MCP prompts are templates a PERSON invokes, which is what a slash command
    // is — so that is where they go, rather than being handed to the model as
    // tools. Unlike every other entry here they carry no `prompt` text: the
    // template lives on the server and takes arguments, so the text only exists
    // once it has been asked for. They travel with an `mcp` descriptor instead,
    // and the composer routes them back here to be expanded (see runMcpPrompt).
    try {
      const taken = new Set(commands.map(c => c.cmd));
      for (const p of this.mcp?.listPrompts?.() || []) {
        const cmd = '/' + p.command;
        if (taken.has(cmd)) continue;
        commands.push({
          cmd,
          description: `[MCP:${p.server}] ${p.description}`,
          prompt: '',
          mcp: { server: p.server, name: p.name, arguments: p.arguments },
        });
      }
    } catch (e) { this.log?.('mcp prompts: ' + e.message); }

    // `file` and `prompt` both travel: the composer expands the prompt itself
    // (so what is sent, shown and persisted are the same text), and the file
    // path is what makes an entry in the dropdown openable for editing.
    this.view?.webview.postMessage({ type: 'slashCommands', commands, sessionId: this.activeSessionId });
  },

  // Where a new command should go. Asked rather than assumed: "everyone on this
  // repo gets this" and "I get this everywhere" are different intentions and
  // the file lands somewhere different for each.
  async createSlashCommand() {
    const root = this.projectRoot;
    const choices = [];
    if (root && workspaceIsTrusted()) {
      choices.push({ label: 'This project', description: `.navy/commands/ — committed with ${path.basename(root)}`, dir: path.join(root, '.navy', 'commands') });
    }
    choices.push({ label: 'Personal', description: 'Available in every project, on this machine', dir: this._personalCommandsDir() });
    const where = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, {
      title: 'New slash command', placeHolder: 'Where should this command live?', ignoreFocusOut: true,
    });
    if (!where) return;

    const name = await vscode.window.showInputBox({
      title: 'New slash command',
      prompt: 'Name — this is what you type after "/"',
      placeHolder: 'e.g. triage, api-review, db:migrate',
      ignoreFocusOut: true,
      validateInput: (v) => {
        const bare = String(v || '').trim().replace(/^\//, '');
        if (!bare) return 'A name is required.';
        const parts = bare.split(':');
        if (parts.length > 2 || !parts.every(part => NAME_RE.test(part)))
          return 'Use letters, digits, - and _ only. A single ":" groups commands (db:migrate).';
        return null;
      },
    });
    if (!name) return;

    const bare = name.trim().replace(/^\//, '');
    const parts = bare.split(':');
    const file = path.join(where.dir, ...parts) + '.md';
    // Through ensureNavyDir for a project command, so .navy/.gitignore exists
    // and carries its `!commands/` exemption — otherwise the file is written
    // into a directory git has been told to ignore wholesale, and the command
    // the user just wrote for their team is invisible to `git status`.
    if (where.dir.startsWith(path.join(this.projectRoot || '\0', '.navy'))) await this.ensureNavyDir();
    try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file))); } catch {}

    // Never overwrite: the whole point of the feature is a prompt somebody
    // spent time on. An existing command of that name is opened instead.
    let exists = true;
    try { await vscode.workspace.fs.stat(vscode.Uri.file(file)); } catch { exists = false; }
    if (!exists) {
      const template = `---\ndescription: What this command does, shown in the "/" menu\nicon: ${DEFAULT_ICON}\nhint: [arguments]\n---\n\nWrite the prompt Navy should run when you type /${bare}.\n\nAnything you type after the command name replaces $ARGUMENTS. If you leave\n$ARGUMENTS out, those words are appended to the end instead — so a command\nstill does something sensible either way.\n`;
      await vscode.workspace.fs.writeFile(vscode.Uri.file(file), Buffer.from(template, 'utf8'));
    }
    this._slashCommandCache = null;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview: false });
    await this.sendSlashCommands();
    vscode.window.showInformationMessage(
      exists ? `Navy: /${bare} already exists — opened it.` : `Navy: /${bare} created. Save the file and it appears in the "/" menu.`);
  },

  // The command a file defines, or null if that path is not a command file at
  // all. Both the open and the delete routes take a path from the webview, and
  // a path arriving over a message channel is not trusted just because the
  // webview is ours — the only paths those routes may act on are files inside a
  // commands directory, named the way a command has to be named.
  _commandNameForFile(file) {
    if (!file || !/\.md$/i.test(String(file))) return null;
    for (const { dir } of this._slashCommandDirs()) {
      const rel = path.relative(dir, String(file));
      // Empty, "../…" or still absolute all mean the path is outside this dir.
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const parts = rel.replace(/\.md$/i, '').split(/[\\/]+/);
      if (parts.length > 2 || !parts.every(p => NAME_RE.test(p))) return null;
      return parts.join(':');
    }
    return null;
  },

  // Removing a command from the menu means deleting the file behind it, so this
  // asks first and then aims for the trash rather than unlinking: it is a prompt
  // somebody spent time writing, and the panel has no undo of its own. The
  // modal names the full path, since a command may live in the repository, in
  // .claude/, or in your personal storage, and which one you are about to
  // remove matters.
  async deleteSlashCommand(file) {
    const name = this._commandNameForFile(file);
    if (!name) return;
    const choice = await vscode.window.showWarningMessage(
      `Remove the /${name} command?`,
      { modal: true, detail: `${file}\n\nThe file is moved to the trash where the OS supports it.` },
      'Remove');
    if (choice !== 'Remove') return;
    try {
      try { await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true }); }
      // Not every filesystem has a trash — a remote workspace, a container, some
      // network mounts. The user has already confirmed, so falling back to a
      // real delete is what they asked for rather than a second question.
      catch { await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: false }); }
    } catch (e) {
      vscode.window.showErrorMessage(`Navy: could not remove /${name} — ${e.message}`);
      return;
    }
    this._slashCommandCache = null;
    await this.sendSlashCommands();
    vscode.window.showInformationMessage(`Navy: /${name} removed.`);
  },

  async openSlashCommandsFolder() {
    const root = this.projectRoot;
    const dir = root && workspaceIsTrusted() ? path.join(root, '.navy', 'commands') : this._personalCommandsDir();
    try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir)); } catch {}
    await vscode.env.openExternal(vscode.Uri.file(dir));
  },
};

module.exports = { SLASH_COMMAND_METHODS, parseCommandFile, parseFrontmatter, NAME_RE, MAX_COMMANDS, MAX_COMMAND_BYTES };
