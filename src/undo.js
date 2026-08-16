// ── Transactional undo / redo ─────────────────────────────────────────────────
// Checkpoints cover edits, renames and deletions, so undo restores a file the
// agent removed as readily as one it changed. Bounded by count and by bytes,
// and persisted, so a window reload does not lose the ability to undo.
//
// Extracted from extension.js unchanged. These are still methods on
// NavyCoderViewProvider — mixed into its prototype at the bottom of
// extension.js — so `this` means what it always did and no call site, no
// signature and no behaviour changed. Written as a class so the block could
// move verbatim; see mixinPrototype in extension.js for how it is applied.

const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const { sessionContext } = require('./session-context.js');

class UndoMethods {
  // Central checkpoint push: clears redo (a fresh operation invalidates redo
  // history — standard editor semantics), caps entries and bytes, persists.
  _pushCheckpoint(entry) {
    if (this.redoStack.length) {
      this.redoStack = [];
      this.view?.webview.postMessage({ type: 'redoState', count: 0 });
    }
    this.checkpoints.push({ time: Date.now(), turnId: this._checkpointTurnId || this.currentTurnId, ...entry });
    if (this.checkpoints.length > 200) this.checkpoints.splice(0, this.checkpoints.length - 200);
    // Entry cap alone isn't enough — 200 snapshots of multi-MB files would pin
    // hundreds of MB. Cap total retained bytes too, evicting oldest first.
    let bytes = 0;
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      bytes += (this.checkpoints[i].originalText || '').length;
      if (bytes > 30_000_000 && i > 0) { this.checkpoints.splice(0, i); break; }
    }
    this.view?.webview.postMessage({ type: 'checkpoints', count: this.checkpoints.length });
    this._persistCheckpoints();
  }

  createCheckpoint(filePath, originalText, newText) {
    // newHash lets undo detect "the user hand-edited this file AFTER Navy's
    // write" and ask before discarding those edits.
    const newHash = typeof newText === 'string'
      ? crypto.createHash('md5').update(newText, 'utf8').digest('hex')
      : undefined;
    this._pushCheckpoint({ kind: 'edit', filePath, originalText, ...(newHash ? { newHash } : {}) });
  }

  // Persist checkpoints into the active chat's own file (debounced) so Undo
  // survives a window reload. Only the newest ~8 MB is written — undo
  // history, not a backup.
  _persistCheckpoints() {
    clearTimeout(this._cpSaveTimer);
    const ctxId = sessionContext.getStore() ?? this.activeSessionId;
    this._cpSaveTimer = setTimeout(() => {
      // Re-bind to the session this checkpoint belonged to when scheduled —
      // the debounce timer fires later, possibly after the user has
      // switched tabs, and _writeChatFile must write THAT chat's file.
      sessionContext.run(ctxId, () => this._writeChatFile());
    }, 500);
  }

  // Undo a single checkpoint entry (kind-aware). Returns the redo operation.
  async _undoOne(cp) {
    if (cp.kind === 'rename') {
      await vscode.workspace.fs.rename(vscode.Uri.file(cp.to), vscode.Uri.file(cp.from), { overwrite: false });
      return { kind: 'rename', from: cp.from, to: cp.to };
    }
    // 'edit' and 'delete' both restore content ('delete' recreates the file).
    const current = await this.readFileText(cp.filePath); // null → file doesn't exist (deleted)
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(cp.filePath)));
    await vscode.workspace.fs.writeFile(vscode.Uri.file(cp.filePath), Buffer.from(cp.originalText, 'utf8'));
    return { kind: 'edit', filePath: cp.filePath, text: current };
  }

  // If the user hand-edited any of these files AFTER Navy's write, undo would
  // silently discard their work — ask first.
  // cps must be newest-first: only the NEWEST checkpoint per file carries the hash
  // of Navy's last write, i.e. what the disk should still equal. Older checkpoints
  // for the same file hash intermediate states and would false-positive.
  async _confirmUndoSafe(cps) {
    const touched = [];
    const seen = new Set();
    for (const cp of cps) {
      if (cp.kind !== 'edit' || !cp.newHash) continue;
      if (seen.has(cp.filePath)) continue;
      seen.add(cp.filePath);
      const current = await this.readFileText(cp.filePath);
      if (current === null) continue;
      const hash = crypto.createHash('md5').update(current, 'utf8').digest('hex');
      if (hash !== cp.newHash) touched.push(path.basename(cp.filePath));
    }
    if (!touched.length) return true;
    const pick = await vscode.window.showWarningMessage(
      `${touched.join(', ')} ${touched.length === 1 ? 'was' : 'were'} modified after Navy's edit — undoing will discard those changes.`,
      { modal: true },
      'Undo Anyway'
    );
    return pick === 'Undo Anyway';
  }

  _afterUndoRedo() {
    if (this.redoStack.length > 50) this.redoStack.splice(0, this.redoStack.length - 50);
    this.view?.webview.postMessage({ type: 'checkpoints', count: this.checkpoints.length });
    this.view?.webview.postMessage({ type: 'redoState', count: this.redoStack.length });
    this._persistCheckpoints();
  }

  async undoLastCheckpoint() {
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (!last) {
      vscode.window.showInformationMessage('No Navy Coder edits to undo');
      return;
    }
    if (!(await this._confirmUndoSafe([last]))) return;
    this.checkpoints.pop();
    // Through the write mutex so an in-flight background-task write to the same
    // file can't interleave with the restore.
    await this._withWriteLock(async () => {
      try {
        const redoOp = await this._undoOne(last);
        this.redoStack.push({ ops: [redoOp] });
        const what = last.kind === 'rename' ? 'rename' : last.kind === 'delete' ? 'deletion' : 'edit';
        vscode.window.showInformationMessage(`Undid last Navy Coder ${what} (Redo is available)`);
      } catch (error) {
        this.checkpoints.push(last); // restore the checkpoint — the undo didn't happen
        vscode.window.showErrorMessage('Undo failed: ' + error.message);
      }
    });
    this._afterUndoRedo();
  }

  async undoLastTurn() {
    if (this.checkpoints.length === 0) {
      vscode.window.showInformationMessage('No Navy Coder edits to undo');
      return;
    }
    const lastTurnId = this.checkpoints[this.checkpoints.length - 1].turnId;
    const toUndo = this.checkpoints.filter(c => c.turnId === lastTurnId).reverse(); // newest → oldest
    if (!(await this._confirmUndoSafe(toUndo))) return;
    this.checkpoints = this.checkpoints.filter(c => c.turnId !== lastTurnId);

    // Restore must apply EVERY checkpoint in reverse order — a file edited N times
    // in the turn has N checkpoints, and only replaying them all (newest→oldest)
    // lands it on the turn-start content. (Deduping to the newest only reverts the
    // last edit.) Redo, by contrast, needs one op per target: the FIRST _undoOne
    // for a file reads the turn-END state off disk, which is the correct redo goal.
    const redoOps = [];
    const redoSeen = new Set();
    const errors = [];
    await this._withWriteLock(async () => {
      for (const cp of toUndo) {
        const key = cp.kind === 'rename' ? 'r:' + cp.from + '→' + cp.to : 'f:' + cp.filePath;
        try {
          const redoOp = await this._undoOne(cp);
          if (!redoSeen.has(key)) { redoSeen.add(key); redoOps.push(redoOp); }
        } catch (e) {
          errors.push(path.basename(cp.filePath || cp.from || '?') + ': ' + e.message);
        }
      }
    });
    if (redoOps.length) this.redoStack.push({ ops: redoOps });
    if (errors.length > 0) {
      vscode.window.showErrorMessage('Some undos failed: ' + errors.join(', '));
    } else {
      vscode.window.showInformationMessage(`Undid ${redoOps.length} file${redoOps.length !== 1 ? 's' : ''} from last turn (Redo is available)`);
    }
    this._afterUndoRedo();
  }

  // Redo: reverse the most recent undo. Re-checkpoints the pre-redo state so
  // undo→redo→undo round-trips cleanly. Pushes checkpoints directly (NOT via
  // _pushCheckpoint) — a redo must not wipe the remaining redo history.
  async redoLast() {
    const entry = this.redoStack.pop();
    if (!entry) {
      vscode.window.showInformationMessage('Nothing to redo.');
      return;
    }
    const turnId = this.generateId();
    const errors = [];
    let done = 0;
    // Through the write mutex — same reason as undo.
    await this._withWriteLock(async () => {
      for (const op of entry.ops) {
        try {
          if (op.kind === 'rename') {
            await vscode.workspace.fs.rename(vscode.Uri.file(op.from), vscode.Uri.file(op.to), { overwrite: false });
            this.checkpoints.push({ kind: 'rename', from: op.from, to: op.to, time: Date.now(), turnId });
          } else if (op.text === null) {
            // The undo recreated a deleted file — redo deletes it again.
            const current = await this.readFileText(op.filePath) ?? '';
            await vscode.workspace.fs.delete(vscode.Uri.file(op.filePath), { recursive: false, useTrash: true });
            this.checkpoints.push({ kind: 'delete', filePath: op.filePath, originalText: current, time: Date.now(), turnId });
          } else {
            const current = await this.readFileText(op.filePath) ?? '';
            const newHash = crypto.createHash('md5').update(op.text, 'utf8').digest('hex');
            this.checkpoints.push({ kind: 'edit', filePath: op.filePath, originalText: current, newHash, time: Date.now(), turnId });
            await vscode.workspace.fs.writeFile(vscode.Uri.file(op.filePath), Buffer.from(op.text, 'utf8'));
          }
          done++;
        } catch (e) {
          errors.push(path.basename(op.filePath || op.to || '?') + ': ' + e.message);
        }
      }
    });
    if (errors.length > 0) {
      vscode.window.showErrorMessage('Redo failed for: ' + errors.join(', '));
    } else {
      vscode.window.showInformationMessage(`Redid ${done} operation${done !== 1 ? 's' : ''}.`);
    }
    this._afterUndoRedo();
  }
}

module.exports = {
  UNDO_METHODS: UndoMethods.prototype,
};
