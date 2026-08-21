# Navy eval harness

Measures whether Navy **actually completes coding tasks**, as opposed to
`npm test`, which measures whether Navy's *mechanisms* work.

The difference matters. The unit suite mocks the model and asserts things like
"the retry fired" or "the card updated". Those can all pass while Navy is
getting worse at coding. This harness drives the real `askNavy()` loop against a
real model over the network, in a real temp repo, and scores by **inspecting the
files that ended up on disk** — several tasks go further and actually execute the
resulting code.

## Running

```bash
npm run eval -- --provider ollama --model qwen2.5-coder:7b
npm run eval -- --provider anthropic --model claude-sonnet-5
npm run eval -- --task edit-scope-single-constant     # one task
npm run eval -- --category edit-precision             # one category
npm run eval -- --compare eval/results/baseline.json  # diff vs a saved run
npm run eval -- --keep                                # keep temp repos to inspect
npm run eval -- --config reducedToolset=off           # pin any navy.* setting (repeatable)
npm run eval -- --label full-tools                    # tag the saved results file
npm run eval -- --help
```

`--config`/`--label` exist for A/B runs: pin the setting under test in each arm
and label the arms so the saved files say what they measured. Every run also
reports a `TOKENS` line (prompt + completion summed across all tasks, and
average prompt tokens per model call) — for a config change like the reduced
tool set, that is the measurement pass/fail alone can't make: "same score,
cheaper" and "no effect" look identical without it.

API keys come from the environment, never the repo:

```bash
# PowerShell
$env:NAVY_EVAL_API_KEY = "sk-..."
# bash
export NAVY_EVAL_API_KEY=sk-...
```

Local Ollama and LM Studio need no key.

## Reading the output

Three outcomes, and the distinction is the whole point:

| Status | Meaning |
|---|---|
| `PASS` | The repo ended up correct. |
| `FAIL` | The model did the task wrong. **This is the signal.** |
| `ERROR` | The harness or provider broke — bad key, rate limit, network, timeout. **Not** counted as a model failure. |

A run with any `ERROR` is reported as **INCOMPLETE** and exits with code `2`,
because a run that couldn't measure something must never be mistaken for a run
that measured it and found nothing wrong.

Exit codes: `0` all passed · `1` some failed · `2` incomplete (errors).

## Tracking changes over time

Every run is written to `eval/results/`. To check whether a prompt or harness
change helped:

```bash
npm run eval -- --model X                                  # before your change
# ...make the change...
npm run eval -- --model X --compare eval/results/<earlier>.json
```

The comparison prints only status *changes* — `FIXED` and `REGRESSED` — which is
what you actually need to know. `eval/results/` is gitignored except for files
named `baseline*.json`, so rename a run you want to keep as a reference point:

```bash
mv eval/results/ollama_..._2026-01-01.json eval/results/baseline-ollama-7b.json
```

## Task categories

| Category | What it catches |
|---|---|
| `does-it-actually-write` | Prose describing an edit while the file on disk never changes — the failure mode small models hit most. |
| `edit-precision` | Rewriting a whole function/file for a one-line change; damaging sibling files. |
| `correctness` | Changes that parse but don't work. Checkers **run** the code. |
| `structured-files` | Corrupting JSON, dropping unrelated config keys. |
| `retrieval` | Editing the wrong file when several plausible ones exist, including a case with no shared keywords (semantic-only). |
| `instruction-following` | Creating files it was told not to; editing during a question-only turn. |
| `safety` | Deleting or clobbering things nobody asked it to touch. |
| `syntax-integrity` | Breaking nesting when editing inside a class or nested object. |
| `grounding` | Answering from imagination instead of reading; claiming an export that isn't exported. |

## Validating the checkers themselves

```bash
npm run eval:selftest      # no model calls, runs in ~2s
```

A buggy checker silently corrupts every score it touches: one that can never pass
makes a good model look broken; one that can never fail makes a bad model look
fine. The self-test simulates the ideal outcome for every task (checker must
PASS) *and* a plausible wrong outcome (checker must FAIL), so a checker that
can't actually detect failure is caught immediately. Run this after adding or
editing any task.

## Adding a task

Add to `eval/tasks.js`:

```js
{
  id: 'stable-id',            // used to diff runs — don't rename casually
  category: 'edit-precision',
  prompt: 'exactly what a user would type',
  files: { 'seed.js': '...' },
  async check(c) {
    if (!c.exists('seed.js')) return { pass: false, reason: 'file gone' };
    return { pass: true, reason: 'why it passed' };
  },
}
```

Checker context: `c.read(f)`, `c.exists(f)`, `c.json(f)`, `c.list()`,
`c.unchanged(f)`, `c.runNode(file, source)`, `c.reply` (assistant text),
`c.seed` (original files).

Two rules for a good task:

1. **Score the outcome, never the method.** Check the file contents, not which
   tools were called — otherwise you lock in today's approach and the eval stops
   measuring capability.
2. **Give a specific `reason` on failure.** `"expected 15, got 10"` tells you
   something; `"failed"` doesn't.

## Known limits

- **Sequential.** ~1 task at a time; a full run against a slow local model takes
  a while. Parallelism would distort latency and hit rate limits.
- **Small sample.** ~24 tasks is enough to catch regressions and compare models;
  it is not a statistically robust benchmark. Treat a 4% move as noise.
- **Non-deterministic.** Models vary run to run. A single flipped task is not a
  regression — re-run before believing it.
- **JS-centric.** Checkers that execute code use Node, so `correctness` coverage
  is JavaScript. Other languages are covered only by file-content assertions.
- **Little headroom at the top.** These tasks encode failure modes seen in the
  wild, so a strong model scores 100% (measured: `deepseek-v4-pro` 22/22). That
  makes the suite good at catching **regressions** and at **separating weak
  models from strong ones**, but it cannot currently measure improvement in an
  already-strong model. Harder tasks are the natural next addition.
