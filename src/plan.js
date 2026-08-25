// ── Task plans ───────────────────────────────────────────────────────────────
// Navy has always asked the model to write a plan — workflow rule 13 wants a
// numbered list under a "**Plan:**" heading before any task needing three or
// more tool calls. That plan was prose. It scrolled away with the rest of the
// reply, nothing tracked whether a step was ever reached, and the only progress
// a user could see was "step 7/100", which counts model calls and says nothing
// about the work.
//
// A plan is state, so it is stored as state. Three things follow from that and
// none of them are possible with prose:
//
//   * the user can see which step is running, and which ones are left;
//   * the model is handed its own plan back on every iteration, so a long turn
//     cannot quietly drift off the thing it said it would do;
//   * a turn that ends with steps still open is a fact Navy can state, rather
//     than something the user works out later.
//
// Deliberately a FULL REPLACEMENT on every call rather than per-step mutation.
// A weak local model that has to name a step id to patch it will get the id
// wrong; re-sending the whole list is one shape, has no failure mode, and the
// diffing is Navy's problem rather than the model's.
//
// Extracted as its own module. These are methods on NavyCoderViewProvider —
// mixed into its prototype at the bottom of extension.js — so `this` means what
// it always did. Written as a class so the block moves verbatim; see
// mixinPrototype in extension.js.

// Bounds. A plan is a summary of the work, not the work: past roughly this many
// steps it stops being readable at a glance, which is the only thing it is for.
const MAX_PLAN_STEPS = 20;
const MAX_STEP_CHARS = 120;

const STATUSES = new Set(['pending', 'in_progress', 'done']);

// Normalises whatever the model sent into a plan, or explains what was wrong.
// Pure, so it is directly testable and cannot depend on turn state.
function normalizePlan(rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { error: 'steps must be a non-empty array of { step, status } objects.' };
  }
  if (rawSteps.length > MAX_PLAN_STEPS) {
    return { error: `A plan may have at most ${MAX_PLAN_STEPS} steps — this one has ${rawSteps.length}. Group the small ones together; a plan is a summary of the work, not the work itself.` };
  }

  const steps = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const raw = rawSteps[i];
    // A bare string is accepted as a pending step. Models emit that constantly
    // whatever the schema says, and rejecting it would spend a whole round-trip
    // teaching a lesson with no benefit to anyone.
    const text = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? raw.step : '');
    if (typeof text !== 'string' || !text.trim()) {
      return { error: `Step ${i + 1} has no text. Each step needs a short description of what it does.` };
    }
    const status = typeof raw === 'object' && raw && STATUSES.has(raw.status) ? raw.status : 'pending';
    steps.push({ step: text.trim().slice(0, MAX_STEP_CHARS), status });
  }

  // At most one step may be running. Two "in_progress" steps is not a plan, it
  // is two plans, and the progress display would have to pick one arbitrarily.
  const running = steps.filter(s => s.status === 'in_progress');
  if (running.length > 1) {
    return { error: `Only one step may be "in_progress" at a time — ${running.length} were marked. Mark the finished ones "done" and the rest "pending".` };
  }
  return { steps };
}

// One line per step, in the shape the model reads back on later iterations.
function renderPlan(steps) {
  const mark = { done: '[x]', in_progress: '[>]', pending: '[ ]' };
  return steps.map((s, i) => `${mark[s.status] || '[ ]'} ${i + 1}. ${s.step}`).join('\n');
}

function planProgress(steps) {
  const done = steps.filter(s => s.status === 'done').length;
  const open = steps.filter(s => s.status !== 'done');
  return { done, total: steps.length, open };
}

class PlanMethods {
  // The tool. Replaces the whole plan, tells the webview, and hands the model
  // back what it now has — a model that can see the plan it just set is far
  // less likely to re-send it unchanged on the next iteration.
  async toolUpdatePlan(steps) {
    const result = normalizePlan(steps);
    if (result.error) return 'Error: ' + result.error;

    const previous = this._session.plan || [];
    this._session.plan = result.steps;
    // Which turn the plan belongs to, so the webview updates ONE card per turn
    // instead of appending a new one on every revision.
    this._session.planTurnId = this.currentTurnId || null;
    this.view?.webview.postMessage({
      type: 'planUpdate',
      turnId: this._session.planTurnId,
      steps: result.steps,
    });

    const { done, total } = planProgress(result.steps);
    const changed = previous.length !== result.steps.length
      || previous.some((p, i) => p.step !== result.steps[i].step || p.status !== result.steps[i].status);
    return (changed ? 'Plan updated' : 'Plan unchanged')
      + ` (${done}/${total} done):\n${renderPlan(result.steps)}`;
  }

  // What the model is shown at the top of every iteration. Without this the
  // plan is something it wrote once and then has to remember — which is the
  // failure the prose version had.
  _planForPrompt() {
    const steps = this._session.plan || [];
    if (!steps.length) return '';
    const { done, total } = planProgress(steps);
    return `\n\n## YOUR CURRENT PLAN (${done}/${total} done)\n${renderPlan(steps)}\n`
      + 'Keep this current with update_plan as you go: mark a step "in_progress" when you start it and "done" the moment it is finished. If the plan turns out to be wrong, replace it — a stale plan is worse than none.';
  }

  // Called once when a turn ends. A plan left with open steps is not an error —
  // the user may have stopped it, or the task may genuinely be partial — but it
  // is a fact worth stating rather than leaving someone to notice.
  _planCompletionNote() {
    const steps = this._session.plan || [];
    if (!steps.length) return '';
    const { done, total, open } = planProgress(steps);
    if (!open.length) return '';
    const names = open.slice(0, 3).map(s => s.step);
    const more = open.length > 3 ? `, and ${open.length - 3} more` : '';
    return `\n\n_Plan incomplete — ${done}/${total} steps done. Still open: ${names.join('; ')}${more}._`;
  }

  // Plans do not survive into an unrelated task. Cleared when a turn begins so
  // the previous turn's finished plan cannot be mistaken for this one's.
  _resetPlan() {
    this._session.plan = [];
    this._session.planTurnId = null;
  }
}

module.exports = {
  PLAN_METHODS: PlanMethods.prototype,
  normalizePlan, renderPlan, planProgress,
  MAX_PLAN_STEPS, MAX_STEP_CHARS,
};
