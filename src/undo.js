// ── Transactional undo / redo, and conversation rewind ───────────────────────
// Checkpoints cover edits, renames and deletions, so undo restores a file the
// agent removed as readily as one it changed. Bounded by count and by bytes,
// and persisted, so a window reload does not lose the ability to undo.
//
// Rewind lives here because it is the same operation one level up. Undoing a
// bad turn's FILES was always possible; the conversation it happened in was
// not. That left the worst state of the three: the files are back to where they
// were, and the model still has every wrong assumption that produced them —
// including its own confident description of edits that no longer exist. The
// next turn reads that as history and builds on it.
//
// So rewind truncates the transcript to a chosen point and puts the session
// digest back to what it was there, optionally undoing the file changes those
// turns made through exactly the machinery above.
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

  // Undo every checkpoint belonging to the given turn ids, newest first.
  // Extracted from undoLastTurn, which is this with a set of exactly one — the
  // ordering rule it documents is the whole reason this cannot be a filter and
  // a map: a file edited N times in a turn has N checkpoints, and only
  // replaying all of them newest-to-oldest lands it on the turn-start content.
  // Restore must apply EVERY checkpoint in reverse order — a file edited N times
  // in a turn has N checkpoints, and only replaying them all (newest→oldest)
  // lands it on the turn-start content. (Deduping to the newest only reverts the
  // last edit.) Redo, by contrast, needs one op per target: the FIRST _undoOne
  // for a file reads the turn-END state off disk, which is the correct redo goal.
  async _undoTurns(turnIds) {
    const wanted = new Set(turnIds);
    const toUndo = this.checkpoints.filter(c => wanted.has(c.turnId)).reverse();
    if (!toUndo.length) return { files: 0, errors: [] };
    this.checkpoints = this.checkpoints.filter(c => !wanted.has(c.turnId));

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
    return { files: redoOps.length, errors };
  }

  // How many files the turns from `index` onward touched — asked before the
  // confirmation, so the prompt can say what is actually at stake rather than
  // offering an abstract choice.
  _rewindImpact(index) {
    const turnIds = this._turnIdsFrom(index);
    const wanted = new Set(turnIds);
    const files = new Set();
    for (const cp of this.checkpoints) {
      if (!wanted.has(cp.turnId)) continue;
      files.add(cp.kind === 'rename' ? cp.to : cp.filePath);
    }
    return { turnIds, files: [...files], turns: this.messages.slice(index).filter(m => m.role === 'user').length };
  }

  // The turn ids recorded on every assistant message from `index` onward.
  // Messages saved before 0.3.1 carry no turnId, so their file changes simply
  // cannot be matched to them — the transcript still rewinds, and the
  // confirmation says the files cannot be restored rather than pretending.
  _turnIdsFrom(index) {
    return this.messages.slice(index)
      .map(m => m.meta?.turnId)
      .filter(Boolean);
  }

  // Truncate the conversation to `index` (that message and everything after it
  // are discarded) and restore the digest as it stood there.
  //
  // `undoFiles` is the caller's decision, not this function's, because the two
  // are genuinely separable: rewinding to re-ask a question with the files kept
  // is a normal thing to want, and so is throwing the whole attempt away.
  async rewindToMessage(index, undoFiles) {
    if (!Number.isInteger(index) || index < 0 || index >= this.messages.length) {
      vscode.window.showWarningMessage('Navy: nothing to rewind to.');
      return null;
    }
    const target = this.messages[index];
    if (target.role !== 'user') {
      vscode.window.showWarningMessage('Navy: rewind targets one of your own messages.');
      return null;
    }
    if (this.isBusy) {
      vscode.window.showWarningMessage('Navy is working — stop the current turn before rewinding.');
      return null;
    }

    const { turnIds } = this._rewindImpact(index);
    let undone = { files: 0, errors: [] };
    if (undoFiles && turnIds.length) undone = await this._undoTurns(turnIds);

    // The digest recorded when this turn began. Restoring the digest WITHOUT
    // restoring what it condensed is deliberate: condensation is lossy and
    // already happened by the time the turn ran, so the digest as of that
    // moment is exactly the context the turn actually had.
    this.messages = this.messages.slice(0, index);
    if (typeof target.rewind?.digest === 'string') this.sessionDigest = target.rewind.digest;
    this._resetPlan();
    this.lastReply = '';

    await this.saveProjectSession();
    this.view?.webview.postMessage({ type: 'restore', messages: this.messages });
    this.view?.webview.postMessage({
      type: 'rewound',
      index,
      files: undone.files,
      prompt: target.text || '',
    });
    this._sendSessionList();
    this._afterUndoRedo();

    if (undone.errors.length) {
      vscode.window.showErrorMessage('Some file restores failed: ' + undone.errors.join(', '));
    }
    return { index, files: undone.files };
  }

  // Command-palette entry point: pick a turn, then decide about its files.
  async rewindConversation() {
    const points = this.messages
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.role === 'user');
    if (!points.length) {
      vscode.window.showInformationMessage('Navy: this chat has nothing to rewind.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      points.slice().reverse().map(({ m, i }) => {
        const impact = this._rewindImpact(i);
        return {
          label: (m.text || '').replace(/\s+/g, ' ').slice(0, 70) || '(empty message)',
          description: `discards ${impact.turns} turn${impact.turns === 1 ? '' : 's'}`
            + (impact.files.length ? `, ${impact.files.length} file${impact.files.length === 1 ? '' : 's'} changed` : ''),
          index: i,
        };
      }),
      { placeHolder: 'Rewind to just before which of your messages?' }
    );
    if (!picked) return;
    await this.confirmAndRewind(picked.index);
  }

  // Shared by the palette and the panel's own control, so both ask the same
  // question and neither can quietly skip it.
  async confirmAndRewind(index) {
    const impact = this._rewindImpact(index);
    const untracked = this.messages.slice(index).some(m => m.role === 'assistant' && m.meta?.files?.length && !m.meta?.turnId);

    const detail = `This discards ${impact.turns} of your message${impact.turns === 1 ? '' : 's'} and everything Navy replied. The conversation cannot be brought back.`
      + (impact.files.length
          ? `\n\n${impact.files.length} file${impact.files.length === 1 ? ' was' : 's were'} changed by those turns: ${impact.files.map(f => path.basename(f)).slice(0, 6).join(', ')}${impact.files.length > 6 ? '…' : ''}. Restoring them is undoable with Redo.`
          : '\n\nNo file changes are recorded for those turns.')
      + (untracked ? '\n\nNote: some of those turns predate rewind and their file changes cannot be matched to them — those files will be left as they are.' : '');

    const choices = impact.files.length
      ? ['Rewind and restore files', 'Rewind, keep files']
      : ['Rewind'];
    const choice = await vscode.window.showWarningMessage(
      'Rewind the conversation?', { modal: true, detail }, ...choices);
    if (!choice) return null;
    return await this.rewindToMessage(index, choice === 'Rewind and restore files');
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

    const { files, errors } = await this._undoTurns([lastTurnId]);
    if (errors.length > 0) {
      vscode.window.showErrorMessage('Some undos failed: ' + errors.join(', '));
    } else {
      vscode.window.showInformationMessage(`Undid ${files} file${files !== 1 ? 's' : ''} from last turn (Redo is available)`);
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
