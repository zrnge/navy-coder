# Changelog

## [0.3.2] - 2026-09-03

Navy can open a real browser now.

`/playthrough` launches Chrome — a visible window you can watch — and drives it the
way a human tester would: it looks at the page, clicks through it, fills in and
submits forms, reads the console, and reports what is broken, confusing, or risky,
each finding tied to the screen or the console line it came from. With no argument
it works on **the project you're in** — it detects whether the project is a web app,
serves it, and plays through it, or tells you it isn't a web project and stops. Pass
a URL to test that page instead. The whole
thing runs on the Chrome DevTools Protocol spoken over Chrome's
`--remote-debugging-pipe` — the one way to drive a browser that needs no WebSocket,
no open port, and, the part that matters here, no npm package. Navy still ships
with zero runtime dependencies; a browser-automation library would have been the
first one, and this is how the feature exists without it.

### Added

- **`/playthrough` — an automated, human-style visual QA pass, defaulting to your
  own project.** Run it bare and Navy works out whether the open project is a web
  app, serves it (via `run_project`), and plays through it in a real Chrome window
  — or tells you it isn't a web project and stops rather than inventing a site to
  test. Pass a URL (a bare `localhost:3000` is fine; it fills in the scheme) to
  test that page instead. Either way it navigates, reads the page's interactive
  structure, takes screenshots it actually looks at, clicks, types, submits forms,
  scrolls, and checks the console and network for errors a user can't see, then
  finishes with a severity-ranked report, each finding cited to the screen or
  console output that produced it. Needs a vision-capable model for the visual
  half; on a text-only model it still catches functional, console, and security
  issues from the DOM and accessibility tree.

- **A zero-dependency browser engine (`src/browser.js`).** CDP over the debugging
  pipe (NUL-delimited JSON on inherited fds 3 and 4), Chrome/Edge/Chromium
  auto-discovery with a `navy.chromePath` override, and an isolated throwaway
  profile per run so the test never touches your real cookies or sessions. Chrome's
  own OS sandbox stays on — Navy never passes `--no-sandbox` — and only `http(s)`
  URLs are navigable, so a page can't steer the browser onto `file://` or a
  privileged surface.

- **Ten browser tools** — `browser_navigate`, `browser_snapshot`,
  `browser_screenshot`, `browser_click`, `browser_type`, `browser_scroll`,
  `browser_evaluate`, `browser_console`, `browser_back`, `browser_close` — and the
  multimodal plumbing behind the screenshot: a tool result can now carry an image,
  fed to the model as a vision message on every provider that supports one (native
  on Claude and Gemini, the OpenAI content-array shape elsewhere). Only the two
  most recent screenshots stay in context — a playthrough runs dozens of
  iterations, and re-uploading every earlier PNG on each one would cost megabytes
  per request.

- **`navy.chromePath` and `navy.browserHeadless` settings.** Auto-detection covers
  the standard Chrome/Edge/Chromium install locations; set `chromePath` only for an
  unusual install. `browserHeadless` is off by default, so you watch the
  playthrough happen in a real window.

## [0.3.1] - 2026-08-29

This one started as an audit rather than a bug report, and the first thing it
found was a setting that did considerably more than its own description said.

`navy.approvalMode` was documented as *"How Navy Coder should handle file
edits"*. The dropdown in the topbar was labelled **Edit approval mode**. It also
governed every shell command, every test run, every dev server, every background
process and every third-party MCP tool call — stored globally, so it followed you
into every workspace including a repository cloned five minutes ago. Turning off
diff prompts because you were tired of clicking them also granted unattended
arbitrary command execution, and nothing anywhere said so.

The rest is smaller and shares a shape: things that were quietly costing
something and had stopped being questioned. A prompt rule forbidding what the
tool loop could already do. A shell nobody could choose, and a whole system-prompt
rule spent arguing the model out of assuming otherwise. A chars-per-token constant
that is right for English prose and wrong for everything else. A fuzzy edit that
matched correctly and then destroyed the file's indentation. And a no-telemetry
promise — which stays — with no way for anyone to report what went wrong.

### Security

- **The approval gate is two gates, and only one of them is about files.**
  `navy.approvalMode` now covers changes to files and nothing else: writes,
  edits, deletes, renames. The new `navy.commandApproval` covers execution —
  shell commands, test runs, dev servers, background processes, and MCP tool
  calls — and defaults to `ask-always`.

  They were never the same decision. A file change is contained to the workspace,
  shown to you as a diff, checkpointed for undo, and visible in `git diff`
  afterwards. Navy cannot know what a command will do before it runs and cannot
  take it back afterwards. One switch for both meant the safer, more reversible
  action was the one people turned off, and the irreversible one came along
  silently.

  **If you had `auto-approve` set before upgrading**, file edits stay automatic
  and commands go back to asking. Nothing to do; the new setting simply is not
  set for you, and that is the safe direction. Turn it off separately if you
  want it, and read what the confirmation says — it now describes the gate you
  are actually flipping instead of listing both.

  Internally there is now exactly one way to ask each question, and the test
  suite fails the build if any code reads either setting directly. Wiring a new
  tool to the wrong gate is a safety bug, not something to catch in review.

### Added

- **`navy.shell` — commands run in the shell you actually use.** Windows meant
  `cmd.exe`, with no way out, while VS Code's own default terminal on Windows is
  PowerShell. The cost of that was visible in Navy's own system prompt, which
  spent an entire rule plus an environment block arguing the model out of the
  PowerShell syntax it had every reason to assume. That is prompt text paying for
  a missing setting.

  Choose `auto` (the default, and exactly the old behaviour), `cmd`,
  `powershell`, `pwsh`, `sh` or `bash`. The choice reaches all three things
  that have to agree — what gets spawned, how Navy quotes arguments it builds
  itself, and which dialect the model is told to write — so picking PowerShell
  stops Navy insisting on `dir` and `%VAR%`. Docker sandboxing still overrides
  it entirely: a sandboxed command runs inside Linux whatever the host is.

  PowerShell runs with `-NoProfile -NonInteractive` and an explicit exit, because
  `powershell.exe` otherwise reports success after a native program that failed —
  and Navy reads the exit code to decide whether to tell the model its command
  worked.

- **Independent read-only tool calls now run together.** Navy's tool loop has
  always been able to execute reads concurrently, and every provider can return
  several tool calls at once. Two things stopped that being worth anything: the
  system prompt told the model to emit one call at a time, and the concurrency
  required *every* call in a batch to be read-only, so a single write forced the
  reads onto the serial path too — giving it up in exactly the read-then-act
  shape a model actually produces.

  Both are fixed. Reads that lead a batch are provably independent of any write
  in it, because no write has happened yet, so they run concurrently; a read that
  comes *after* a write stays where the model put it, because it usually exists
  to check that write. Small local models keep the strict one-at-a-time contract:
  emitting several well-formed calls at once is what they are worst at, and a
  malformed batch costs a whole round-trip to recover.

- **`Navy Coder: Export Diagnostics`.** Navy still transmits nothing, and that
  is not changing. What it could not do was help you report a problem: no crash
  reports, no way to know which of eleven providers is currently broken for
  people, and a bug report that came down to "it didn't work".

  The command assembles what a maintainer would otherwise ask for one question at
  a time — versions, provider, whether a key *exists*, the resolved shell, both
  approval gates, context window, whether your model can even be costed, and the
  recent error log — and opens it in an **unsaved editor tab**. Nothing is
  written to disk and nothing is sent. Keys are never read into it; paths, home
  directory and anything credential-shaped are redacted before they are even
  stored. You read it, then decide whether to share it.

- **`navy.modelPricing` — price a model Navy has never heard of.** The cost
  estimate has always returned nothing rather than a guess for an unrecognised
  model, which is the right failure but meant every new model shipped uncosted
  until someone edited the table and cut a release. Map a substring of the model
  id to its input/output prices and the running estimate covers it today.
  Malformed entries are ignored rather than half-applied — a confident wrong
  number is worse than none in the one place that touches real money.

- **A weekly regression gate on real coding ability.** The test suite mocks the
  model everywhere, which is the right call for something that runs on every push
  with no keys and no cost — and it means the whole suite can stay green while
  Navy gets steadily worse at the only thing it is for. The eval harness now runs
  weekly against one cheap model and fails only on a *regression*: a task that
  passed in the committed baseline and now does not. Deliberately not a
  pull-request gate — it spends real money per push, fork PRs cannot read
  secrets, and a nondeterministic model would go red on unrelated changes until
  everyone ignored it.

- **`/audit` — a supply-chain scan of your own project.** No AI coding assistant
  ships this. Type `/audit` and Navy checks the repository for what a supply-chain
  attack actually looks like: a `postinstall` hook that pipes `curl | sh`, a
  dependency resolved from a git URL instead of the registry, code that reads
  `~/.ssh` or `~/.aws/credentials`, an `eval(atob(...))` payload, a `fetch` to a
  hardcoded host. It reads **every** text file, whatever the language — there is no
  allowlist to leave your stack out — and it reads the **build files** where the
  C/C++ attacks really hide (`Makefile`, `CMakeLists.txt`, `configure`,
  `Dockerfile`), which is the shape of the xz/liblzma backdoor. Navy's own code
  does the scan deterministically — same files, same findings, every run — and only
  then hands the *hits* to the model to judge, so you get real signals rather than a
  wall of pattern noise. `/audit deep` goes further: the model reads the project
  with its own tools and reasons about supply-chain risk in whatever ecosystem it
  finds, grounded so it quotes the real line rather than inventing one.

- **Repository slash commands are reviewed before they run.** A `.md` command file
  cloned with a project could put arbitrary instructions into the model the first
  time you pressed `/`. An unreviewed repository command is now marked in the menu
  and, the first time you run it, its prompt is shown for you to read first —
  trust-on-first-use, fingerprinted so an edited command asks again. A personal
  command you wrote yourself is never gated.

- **The model's reasoning, in a collapsible Thinking card.** Extended thinking
  (Claude, Gemini, Ollama) was captured and thrown away — you saw only a
  "Reasoning…" flicker. It now streams into a card, collapsed by default, marked
  with the same spinning wheel the activity log uses rather than a second glyph
  beside it. Click anywhere in the reasoning to fold it back up; a text selection is
  preserved so you can still copy it out. Copying the reply never drags the
  reasoning in with it.

- **A native sandbox that needs nothing installed.** `navy.sandboxMode` gains a
  `native` backend: `sandbox-exec` (Seatbelt) on macOS, bubblewrap on Linux.
  Writes are confined to the project and temp, a short list of credential stores
  (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.netrc`, gcloud/docker creds)
  cannot be read, and — stated plainly rather than glossed — the network is *not*
  restricted, because blocking it breaks the `npm install`/`pip`/`cargo` runs
  people most want sandboxed. Weaker than a container, and honest about exactly how.

- **WSL Containers (`wslc`) — container sandboxing on Windows without Docker
  Desktop.** `navy.sandboxMode` gains a `wsl` backend built on Microsoft's
  first-party Linux-container runtime (Build 2026 public preview; needs WSL 2.9.3+).
  It runs commands in a container with only the project mounted, the same image
  contract as `docker` (the project's own devcontainer/Dockerfile, or
  `navy.sandboxImage` — never a guess), built and run through wslc's own image
  store. On a Windows machine that has it, it is offered ahead of Docker. Windows
  finally gets real container isolation with nothing extra to install.

- **Message timestamps, and rewinding the conversation, not only its files.** Each
  of your messages and each reply now carries the time it happened, in the actions
  row. And "Edit" on one of your messages discards it and everything after it, hands
  the prompt back to the composer to reword, and restores the files to that point —
  the conversation rewinds, not just the diffs.

- **MCP resources and prompts.** A connected MCP server's resources and prompts are
  now surfaced as what they are — resources the model can read, prompts you can run
  by name from the `/` menu — instead of being flattened into the tool list.

### Changed

- **Navy learns how many characters a token is worth, per conversation.** The
  budget was derived from a fixed 4 characters per token — the English-prose
  figure. Code runs nearer 3–3.5 and CJK far lower, so the headroom factor had
  been quietly absorbing the error for every language that is not English prose.

  The provider already reports the true token count on every call; the difficulty
  is that it counts the tool schemas too, which the conversation does not contain.
  Taking the difference between two consecutive calls in a turn cancels that
  overhead exactly, because the schemas are identical between them. The result is
  smoothed, clamped to a sane range, and reset when you clear the chat. A first
  turn behaves exactly as it always did.

- **The pricing table now fails the build instead of the estimate.** Its ordering
  is load-bearing and silent when wrong — a single `gemini-.*flash` rule once
  billed 2.5-flash turns at 1.5-flash rates and nothing anywhere noticed. Every
  entry now names the model it exists for, and adding a broader rule above it
  breaks the build rather than someone's cost estimate.

- **`navy.sandboxImage` is one image for every project, set once.** The image used
  when a project has no devcontainer/Dockerfile of its own was stored per-workspace,
  so a sandbox had to be set up repo by repo — the friction that made Windows
  sandboxing feel like more work than it was worth. It now defaults to your **User**
  settings: one image for every project that has no config of its own, for `docker`
  and `wsl` alike. A project's own devcontainer/Dockerfile still wins, and a
  workspace override still scopes it to a single repo.

- **The plan card tells the truth, and the model is nudged to finish it.** On a
  successful turn Navy used to strike through every plan step regardless of its real
  state — a card reading "0/6 done" with all six crossed out, a plan completed on
  screen without the work being done. A model-declared plan now keeps its real
  statuses; only the *inferred* (prose-scraped) plan is presumed done on a finish.
  And a model that quits mid-plan — narrating a plan, reading files, then stopping
  or calling `finish()` with nothing written — is nudged, a bounded number of times,
  to actually do the work rather than ending at 0/N. A `finish()` that followed real
  work, or a stop that asks you a question, is left alone. Plans are also treated as
  declared state now, not prose the panel guesses at: the card is driven by
  `update_plan`, updated in place, and no longer overwritten by a scraper or an
  iteration counter.

- **The per-turn controls moved out of the title bar and down to the composer** —
  thinking depth, edit approval, command approval — sitting beside the box you type
  in, in the order you would decide them. And they stopped disagreeing about their
  own appearance: all three now render as one control with one look, instead of two
  accented and one muted.

### Fixed

- **A fuzzy edit no longer destroys the file's indentation.** `apply_edit` has
  always tolerated indentation drift when matching — a model reconstructing a
  search block from memory gets the code right and the leading whitespace wrong
  constantly, and refusing over that wastes a round-trip. But the *replacement*
  was then inserted at whatever indentation the model happened to write, so a
  match found four levels deep came back at column zero. Valid JavaScript, broken
  Python or YAML, and an unreadable diff either way.

  The replacement is now re-anchored to the region it replaces, keeping its own
  internal nesting. Where the two indentations cannot be reconciled — spaces on
  one side, tabs on the other — nothing is guessed.

- **Long single turns can no longer run out of things to compact.** Mid-turn
  compaction pruned old tool output and then stopped, but a turn is allowed up to
  a hundred model calls and each can leave a paragraph of reasoning behind.
  Nothing bounded that, so one long task could reach the context ceiling with
  nothing left to drop. Older reasoning is now trimmable too, keeping the most
  recent intact — and never the tool calls themselves, which pair with the
  results that follow them.

- **The model is told which shell it is really writing for.** The command-accuracy
  rule hardcoded "cmd.exe on Windows, sh on macOS/Linux", and the "that program
  isn't installed" hint always suggested `where` or `command -v`. Both now follow
  the shell that will actually run the command, so a PowerShell session is told
  about `Get-Command` rather than being sent to check the wrong thing.

- **A table no longer shatters on a pipe inside a cell.** The cell splitter split
  on every `|`, so a version range like `>=22 | ^2` — or an escaped `\|`, or a pipe
  inside inline code — spawned phantom narrow columns that crushed the whole table
  to slivers. Pipes in code and escaped pipes are now literal, an over-long row
  folds its overflow back into its last cell, and a wide table scrolls instead of
  cramming every column down to a few characters each.

- **A sandbox that cannot pull its image says so, instead of looking like your code
  broke.** A container run that fails to reach the registry (usually a DNS problem
  in the sandbox network) returned a bare `E_FAIL` that read like the command itself
  failed — sending the model off to edit code that was fine. Under a container
  sandbox, Navy now recognises a pull/network failure and says plainly that it is
  the sandbox's network, not the project: pre-pull the image, or fix the WSL/Docker
  resolver.

- **A blocked file path now says how to recover.** "Path is outside the project
  folder" was a dead end; it now adds that file tools cannot reach outside the
  project and to use a path relative to its root — so the model corrects itself
  instead of retrying the same out-of-project read.

- **One source of truth for every provider base URL, again.** The Anthropic base
  URL had drifted back into three hardcoded copies and the Gemini one into two;
  `endpoints.js` exists precisely so a change to one URL is not made three times and
  free to diverge. Both are constants there now.

- **`update_plan` rejected every plan a model actually sent.** It accepted only a
  step keyed as `step`, while models routinely send `description`, `title`, `task`
  or `content`; the tool errored, and the model — told its plan was malformed —
  either gave up on planning or looped resending it. It now accepts any of the usual
  keys.

## [0.3.0] - 2026-08-22

It started with two bugs reported from real use, both in what Navy *says* rather
than what it does — `read_file` printed as *readfile* with half the paragraph
italicised, and a turn that changed nothing announcing files it had written.
They turned out to be the same bug twice: something appended to a message the
model reads as its own, and a markdown rule that consumed characters it had no
business touching.

Hunting for the rest of that family is most of this release. Four more renderer
bugs were sitting in plain sight — shell globs, numbered steps, links with
parentheses in them, `__init__` — and the answer to "how do we stop finding
these one at a time" is a property rather than another list of cases: text whose
`_` and `*` are all identifiers and globs must come through with nothing missing
and no emphasis invented. Run against the renderer as it shipped in 0.2.9, it
fails on 17 of its 19 lines.

The other half is about knowing what is running. A dev server used to announce
itself as a card and then scroll away, taking its Stop button with it, and a
process that outlived its window left nothing behind but a notification you
could miss. Both now sit above the chat input for as long as they are running.

### Added

- **Anything still running stays above the composer.** A dev server, a
  background process and a `/bg` task each announce themselves as a card where
  they were started — and then the conversation moves on. Twenty replies later
  the server is still up, but its status and its Stop button have scrolled out
  of reach, so the only ways to stop one you had forgotten were to hunt for the
  card or to ask the model to do it.

  A dock now sits directly above the input listing what is running right now,
  each row with the stop action that belongs to it: Stop server, Stop process,
  Abort task. A dev server shows the command while it is starting and its URL
  once it is up, with a status light that stops pulsing when it is live.

  It mirrors rather than moves. The card stays exactly where it happened,
  because that is what records WHEN it started, and a card that relocated itself
  would leave a hole in the conversation — clicking a dock row scrolls to that
  card and marks it. Rows leave as their processes end, and the dock takes real
  height rather than floating, so it can never cover the last line of a reply.
  It is capped at a quarter of the panel and scrolls beyond that, so three
  servers cannot push the composer off a short window.

- **Every background task now has a path, and survives a restart with it.**
  Navy records what it launches under `navy/<project>/<task>` — a dev server is
  `navy/my-app/dev-server`, a watcher is `navy/my-app/tsc-watch`. A pid was never an
  identity: it is recycled, it means nothing once the window is gone, and nobody
  recognises one. A task path names the project and the job, reads the same in
  every window, and is what a stop request refers to.

  It is what makes reopening useful. A process started with
  `navy.persistBackgroundProcesses` on outlives the window that launched it, and
  the only sign of that used to be a notification at startup — dismiss it, or
  miss it while the window was still loading, and nothing anywhere said your dev
  server was still up. Recovered processes now appear in the task dock above the
  composer, marked as predating this window, each with **Stop**, its **Log**,
  and — because the detected URL is recorded too, not just the pid — **Open**
  for a dev server that is still serving on the address it had before.

  They belong to the project rather than to a conversation, so switching chats
  does not retire them. Stopping one names its task path and never a pid: the
  record is looked up and re-verified as Navy's own immediately before anything
  is signalled, because minutes can pass between the check that put a row on
  screen and the click, and a recycled pid must never be killed on Navy's word.

- **A property test instead of another list of cases.** Every renderer bug found
  so far was one failure wearing different clothes: characters that were not
  markup vanished, and emphasis appeared where none was asked for. That is
  checkable without predicting the next variant — take lines whose `_` and `*`
  are all identifiers, globs and argument lists, and assert that nothing goes
  missing and no emphasis is invented. Run against the renderer as it shipped in
  0.2.9, it fails on 17 of its 19 lines, including the exact text from the bug
  report. The enumerated cases each had to be thought of first; this one only
  had to be written once.

- **`npm run preview` opens the panel in a browser.** The one thing no suite
  here can check is what the panel looks like: jsdom never paints, and the VS
  Code integration suite is deliberately not a rendering test — so the icons in
  0.2.9 shipped verified in structure and never once looked at. This builds a
  standalone page from the real markup, the real stylesheet and the real
  webview script, drives it with a scripted conversation that exercises every
  slash-menu icon, both message roles, the cards, a queued prompt and the
  markdown shapes that have been buggy, and opens it. It supplies both a light
  and a dark palette so a colour that only works on one theme has somewhere to
  show itself.

- **`npm run lint` — ESLint has never actually run on this repo.** It was in
  devDependencies with no configuration at all, so it only ever printed a
  migration notice. The config is deliberately narrow: every rule catches a real
  defect, none of them are style, and there are no plugin dependencies. It found
  one thing immediately — a test asserting `shardOf(x) === shardOf(x)`, which
  holds just as well if the function returns undefined for everything.

- **`npm run eval -- --repeat N`.** A single pass of the eval suite cannot
  tell a
  real change from a model having a good afternoon: the same 22 tasks scored 74%
  and then 28% across two runs of an A/B whose arms differed in one setting.
  Repeat runs each task N times, reports the majority outcome, and marks any
  task that disagrees with itself as FLAKY — which is the most useful thing the
  harness can say, because it means every single-run comparison including that
  task was measuring noise.

### Fixed

- **A new chat tab lost the dev server's Stop button.** Opening a tab replaces
  the transcript, which takes the run-project card and its dock row with it —
  and unlike switching chats, opening one never re-announced what was still
  running. A new tab is not a new machine.


- **`read_file` rendered as *readfile*, and took the rest of the paragraph
  into italics with it.** Emphasis with `_` was firing inside words. Every reply
  a coding assistant writes is full of snake_case — `read_file`, `apply_edit`,
  `MAX_RETRIES` — so the underscore in one identifier opened emphasis and the
  underscore in the next closed it: both disappeared, and everything between
  them rendered italic. Two identifiers in a sentence was enough, which made
  this one of the most-hit bugs in the panel while looking like a rare one.

  `_` can no longer open or close emphasis against a letter or digit, which is
  what CommonMark specifies and why it specifies it. `*` stays intraword-capable
  — also per the spec — and `_emphasis_`, `__bold__` and `__init__` are
  unaffected. Eight cases are pinned, one of them the exact line from the
  report.

- **Navy claimed it had changed files it never touched, and printed its own
  internal notes into the chat.** One cause. After each turn Navy appends a
  compact record of what that turn actually did — files read, files written,
  commands run — for the model to consult on the next turn, so it does not redo
  work it has already done. That record was appended to the **assistant**
  message, and a model reads its own prior turns as examples of how it writes.
  So it started ending replies with a bracketed activity list of its own; and
  because it was writing prose rather than reading a tool result, it invented
  the contents. A turn that changed nothing still announced files it had
  "written", with Navy's own internal note visible underneath.

  The record now goes in the system prompt, where a model reads it as context
  rather than as its own output, so there is no format there to imitate.
  Assistant messages carry only what the model actually said.

- **Shell globs were eaten the same way.** `*` had no guard either, so "delete
  *.log and *.tmp" lost both asterisks and italicised the middle, and
  `**/*.spec.js` came out worse. A `*` sitting
  against whitespace cannot close emphasis — that is CommonMark's own flanking
  rule — and Navy adds one of its own: a `*` against a slash is a path, not
  emphasis. `def f(*args, **kwargs)` survives now too. Intraword `2*3*4` still
  works, as the spec allows.

- **Numbered steps restarted at 1 after every code block.** Anything that is not
  a list line ends a list, and a fenced block between two steps is the commonest
  shape this panel produces — so "1. do this / ```code``` / 2. then that" was
  rendered as two lists and the second began again at 1. The continuation now
  carries the number the model actually wrote, so a list that starts at 5 does
  too.

- **A link whose URL contained parentheses was truncated.** Wikipedia, MSDN and
  Rust doc URLs all have them; the URL was cut at the first `)`, giving a 404
  and a stray `)` printed after the link.

- **`__init__` rendered as bold *init*, and `items[*]` italicised itself.** Two
  more of the same, found by the property test rather than by report. Both are
  deliberate departures from CommonMark now: a bare identifier between double
  underscores is a Python dunder far more often than it is bold (and models
  write bold as `**` anyway), and `*` no longer fires intraword, because in this
  panel `2*3*4` is multiplication. The spec is written for prose; this is a
  panel full of Python and shell. Anything genuinely ambiguous can still be
  written in backticks, which are lifted out before any emphasis rule runs.

- **`tools/` was not syntax-checked.** `npm run check` scans `src`, `media`,
  `test` and `eval` — the directory added in 0.2.9 was never on that list, so
  the icon generator and the preview builder could have shipped unparseable.

- **A truncated test extraction reported itself as "Unexpected end of input".**
  `test/run.js` lifts pure functions out of the shipped source by counting
  braces, and a lone brace inside a string or a comment ends the function early.
  The extracted copy then fails to parse with an error naming neither the
  function nor the cause. It now says which function stopped early and why.

- **A false "Changed:" claim could pass unchallenged.** The hallucination guard
  only fires when a turn calls no tools at all, so a model that ran commands and
  then reported files it never wrote slipped past it. Navy now checks the
  reply's own `Changed:` line against its record of the turn, and says plainly
  when they disagree. The documented "No files changed" form, and prose that
  names no file, are correctly left alone.

## [0.2.9] - 2026-08-21

Three changes you can see and one you can't. The agent asks small models to
carry less; a prompt you queued can be taken back; every emoji in the panel is
now a real icon that follows your theme. The one you can't see is the eval
harness, which turned out to have been measuring the wrong thing entirely — and
saying so is more useful than quietly fixing it, because it means every number
it produced before this release was wrong.

Suite: 1,482 to 1,579.

### Added

- **A reduced tool set for small models** (`navy.reducedToolset`). All 37 tool
  schemas used to ride along on every single request. On a hosted frontier model
  that is noise; on a 7B model with an 8-16k window it is a real fraction of the
  whole context, spent before the task is even described — and a longer menu
  makes a small model's tool *choice* worse, not better.

  A turn Navy judges small is offered a core of seventeen instead: read, edit,
  verify, search, run, test, git status and diff, skills. The other twenty are
  named in the prompt but withheld, and one `request_more_tools` call unlocks
  all of them for the rest of the turn — so the model is never left concluding a
  capability does not exist, which is the failure mode of simply removing tools.
  Measured on the wire, the core schemas cost 52% of the full set.

  `auto` applies this only to **local** providers (local Ollama, LM Studio) and
  only when the model's name suggests ≤9B parameters or its effective window is
  ≤16k. A hosted model named "mini" has a large window and handles a wide tool
  list fine, and Ollama Cloud runs models too big to fit on your machine — both
  keep everything. `on` and `off` override in either direction, and the Output
  channel says when a turn ran reduced.

  This is a context optimisation and **never a permission boundary**: nothing
  checks the tier before running a tool, and an unlocked tool goes through
  exactly the same approval gate as always.

  Honest about the evidence: the token saving is measured and certain, the
  quality effect is not. An A/B over the 22-task eval on `qwen2.5-coder:7b`
  scored 74% then 28% for the reduced arm against 65% then 56% for the full one
  — run-to-run variance on a 7B model swamping whatever the tier does. A claim
  either way needs repeated runs per arm, which is why there is no claim here.

- **Cancel a queued prompt.** Anything sent while Navy is working waits its
  turn, and that wait can be minutes — but the transcript showed it as though it
  had been sent, and the only way out was Stop, which killed the running turn
  too. Each waiting prompt now carries a Cancel button under its own bubble.

  It is deliberately not a hover-only control like copy and read-aloud: those
  act on something already finished, while this is the one chance to stop
  something that has not happened yet, and a control you must discover by
  hovering is one most people never find. It retires itself the moment the
  prompt actually starts.

  Cancelling keeps your words. The bubble stays, dimmed and labelled "Cancelled
  — not sent", rather than vanishing — deleting what someone typed to undo a
  mis-click is its own small disaster, and the copy button still works on it. It
  stops being a target in the outline and the turn arrows, though: those list
  the questions a conversation is built from, and this one never became one.

  Clicking asks the extension rather than resolving locally, because only that
  side knows whether the turn just picked the prompt up. Lose that race and the
  button quietly goes away instead of lying about what it can still do.

- **The eval harness can A/B a setting.** `--config <key>=<value>` pins any
  `navy.*` setting for a run and `--label <name>` tags the saved results, so two
  arms differing in one setting can be compared later by their files rather than
  by memory. Every run now also reports a `TOKENS` line — prompt and completion
  summed across all tasks, and the average prompt tokens per model call. Pass
  and fail alone cannot tell "same score, cheaper" from "no effect"; that line
  can, and it is what caught the truncation bug below.

### Changed

- **Every emoji in the panel is now a Font Awesome icon.** An emoji is a
  fixed-colour glyph the operating system chooses and draws at its own metrics:
  it cannot follow a VS Code theme, it renders differently on every platform,
  and on some it does not render at all. The slash-command menu, the welcome
  chips, close and copy and read-aloud, approve and reject, the activity log's
  ticks and crosses, background-task and process badges, the reasoning marker,
  attachment badges and the diff bands are all drawn from real icons now, sized
  in `em` and filled with `currentColor` — so each one takes the size and colour
  of the text it sits in, including every theme token.

  They are bundled, not linked. Only the 38 icons Navy actually draws ship, as
  raw SVG paths in `src/icons.js`, emitted once per document as an inline sprite
  that every use site references — no webfont, no icon CSS, no CDN, nothing
  fetched at runtime, and no `font-src` entry added to the panel's CSP. A
  webfont would have meant ~400KB for two dozen glyphs and a missing-glyph box
  whenever it failed to load.

  Custom slash commands keep whatever glyph their own markdown file gives them.
  Built-ins name an icon instead, and that name is sanitised before it reaches
  the markup, since a repository can write one.

  `tools/build-icons.js` regenerates the set from a local Font Awesome package
  and is the only thing that ever needs one; the generated file is committed.
  Font Awesome Free icons are CC BY 4.0, which requires attribution — the notice
  is in `src/icons.js` and in the README, and both stay.

### Fixed

- **The eval harness was measuring truncation, not the model.** It never set a
  context window, so every request went to Ollama at its own ~2048-token default
  and was silently cut down — the model could not see most of its system prompt,
  let alone the files. The new token accounting is what exposed it: all 570
  model calls across two full runs reported *exactly* ~2,050 prompt tokens,
  which is not a number a real workload produces twice.

  This invalidates every result the harness saved before this release, including
  the ones in `eval/results/` from July. It now fetches the model's real window
  per task, the same way the panel does when you pick a model. The difference is
  not subtle: `fix-off-by-one` failed in both truncated arms and passes in three
  model calls at a 16k window.

- **A tool call with no arguments never ran.** `finish` takes no arguments, so
  models write `<tool name="finish"></tool>` — and the empty body went to
  `JSON.parse('')`, threw, and came back as a parse error instead of a call, so
  the tool never ran. An empty body now means what it looks like. Affected every
  zero-argument tool: `finish`, `git_status`, and the new `request_more_tools`.

- **Stop dropped queued prompts without saying so.** Pressing Stop has always
  cleared the queue — otherwise the next prompt fires the instant the abort
  lands — but the bubbles for those prompts stayed in the transcript looking
  exactly like messages that had been sent. Stop now names what it dropped and
  each one is marked, as is anything still waiting when the extension host dies,
  where nothing is coming to run it.

## [0.2.8] - 2026-08-19

A UI/UX release. No new tools, no new providers, nothing new the agent can do —
the two additions are both ways of moving around a conversation you already
have. Everything else is the panel itself: how it reads on a theme that is not
the author's, whether it can be operated without a mouse, and a set of things
that were quietly wrong for anyone who looked closely.

Much of this was found by measuring rather than by looking — contrast ratios
computed rather than eyeballed, scrollbar clearance read off the element rather
than assumed, spacing changes verified by expanding tokens back and diffing
against the previous file. Where a fix could rot silently, it is pinned by a
test: the suite grew from 1,293 to 1,482.

### Added

- **Step through the conversation one turn at a time.** Two arrows sit at the
  ends of the scrollbar — up at the top, down at the bottom — or Alt+Up and
  Alt+Down. Where the outline is for going somewhere you already have in mind,
  these are for reading back through a conversation, which is hard to do by
  scrolling once a reply is full of cards and code blocks, because nothing marks
  where one message ends and the next begins.

  They sit at the scrollbar rather than in a cluster above the composer: that is
  where the eye already is when moving through a long transcript, and it costs no
  width at all in a sidebar that runs out of it first. Square, a hairline off the
  top and bottom edges, and cleared from the scrollbar on the right by a measured
  amount rather than a guessed one.

  That clearance is measured off the element at runtime rather than assumed:
  this stylesheet asks for a 5px scrollbar, but VS Code's webview applies its own
  styling on top, so the drawn width is not the requested one and positioning
  against the requested value left the arrows sitting on the track. The gap is
  re-measured on resize and whenever the transcript changes, since a scrollbar
  appears the moment content first overflows, and it falls back to the requested
  width for overlay scrollbars, which reserve no room to measure. They carry no
  shadow for the same reason the gap exists: a shadow spreads in every direction
  and would bleed straight back over the track. The jump-to-latest pill keeps the
  centre above the composer to itself. Both arrows stay in place at every scroll
  position and go disabled at their ends. Hiding each at its own end was tidier
  and unusable: Next hides at the bottom and Previous at the top, and the bottom
  is where every reply leaves you — so in ordinary scrolling each blinked in and
  out independently, which reads as broken and cannot be aimed at. They go away
  only when there is nothing to navigate at all, which is a state a conversation
  sits in rather than passes through.

  Anchoring them needed the transcript wrapped in a positioned container: an
  absolutely positioned child of a scroll container scrolls away with the
  content. The wrapper takes the exact grid slot the transcript held, so nothing
  else moved.

  They step between **your** messages, landing each exactly at the top of the
  view. Each one starts a turn, so this walks the conversation question by
  question, in the same units the outline lists; stepping over replies too would
  mean two presses per exchange and landing halfway through a long answer.

  Positions are measured as a rect delta against the scroll container, never with
  `offsetTop`. `offsetTop` is relative to the nearest *positioned* ancestor, and
  `.messages` is not positioned — so the first version measured from the page and
  silently included everything above the transcript, landing short by exactly the
  topbar's height. That is why it only went wrong sometimes: the topbar's height
  changes when it wraps to two rows on a narrow sidebar and when a panel opens
  above it. The outline uses the same measurement, so a jump and a step land a
  message in the same place rather than being free to disagree.

  Which turn you are on is derived from scroll position on every press rather
  than remembered, so scrolling by hand, jumping from the outline and stepping
  all agree with nothing to keep in sync. The arrows disable at the ends instead
  of wrapping — wrapping from the first turn to the last would feel like losing
  your place — and also once the transcript cannot scroll further, since a short
  last turn can never reach the top of the view and Next would otherwise stay lit
  and do nothing. They hide entirely in a chat short enough to fit on screen,
  where two permanently dead arrows would read as broken. Stepping away from the
  end parks autoscroll, so a streaming reply does not haul you back down.

  Only plain Alt+arrow is claimed — a bare arrow key still belongs to whatever
  has focus.

- **A chat outline, to move around a long conversation.** Getting back to
  something you asked twenty turns ago meant scrolling and reading, and search
  only helps when you remember the words you used. The outline button in the
  topbar — or Ctrl+O — lists the turns in the current chat and jumps to any of
  them. It lists your prompts rather than every message, because those are what
  a conversation is actually structured around; each is one truncated line, with
  the whole prompt on the tooltip since two similar prompts often differ past
  the cut, and a multi-line prompt shows only its first line so the list never
  grows taller than the scrolling it replaces.

  Landing somewhere in a wall of text is disorienting without being told which
  one you landed on, so the target is briefly outlined. Jumping also counts as
  leaving the bottom, so autoscroll does not drag you back down on the next
  chunk of the reply.

  It is rebuilt from the transcript every time it opens rather than kept as a
  list alongside it. A parallel list would have to stay in step with restore,
  tab switching, clearing and every path that appends a turn, and the failure
  mode of getting that wrong is an outline that navigates to the wrong place —
  worse than not having one. It is reachable entirely from the keyboard: the
  first entry takes focus on open, arrows walk the list, Home and End reach the
  ends, and Escape closes it. It is the one topbar control kept at the narrowest
  width, where search and export are dropped: both of those have another way in,
  and Ctrl+O is not discoverable the way a Command Palette entry is.

### Fixed

- **The panel was built for a dark theme and only looked right in one.** Every
  wash, hover fill and tinted border was written as a literal
  `rgba(88, 166, 255, α)` — that is the *fallback* value of the accent token, not
  the token — at eighteen different alphas, plus the same pattern for red, amber
  and green. So the accent itself followed the theme while everything meant to
  tint it stayed frozen at the dark-theme blue, and on a light theme, or any
  theme whose link colour is not blue, the two disagreed. All 49 are now mixed
  from the token they belong to with `color-mix()`, in four steps rather than
  eighteen; the spread between 0.06 and 0.09 was accretion, not intent.

  The worse cases were the ones that vanished outright: table zebra striping and
  the diff "skipped lines" band were white at 2% opacity, invisible on a light
  background, and the diff action bar was black at 15%, a heavy grey slab. All
  three now mix from the foreground colour, so they invert with the theme. The
  error banner's text was a fixed pale red that disappeared into a light
  background. The shell panel was pinned to near-black with pale green text
  regardless of theme, and now follows VS Code's own terminal colours.

  Three places keep fixed colours deliberately, and now say so in a comment: the
  Stop button (solid red, so it can never be mistaken for the theme's salmon
  charts-red), the image remove button, and the lightbox controls — the last two
  sit over a user's own image or over a near-opaque scrim, where no theme token
  can predict the ground behind them.

- **Cards of different kinds did not line up with each other.** Tool, diff,
  terminal, command and run-project cards are one family that had drifted into
  four different header paddings (8/12, 10/14, 5/10 and 12/14), two different
  card backgrounds and three different margins, so a turn containing several
  kinds read as several designs stacked together. They now share one set of
  measurements. Terminal rows stay tighter than a card header on purpose — a
  card holds many of them — but share the horizontal padding, which is what
  makes the text line up down the column.

  Behind that, spacing is now a 2px scale rather than nineteen ad-hoc pixel
  values with 7px, 9px and 22px among them. The 161 substitutions were verified
  by expanding the tokens back and diffing against the previous file: every one
  resolves to the value it replaced, so the only spacing that moved is the card
  geometry above.

- **Two logos sat side by side in the topbar.** The brand wheel had a second,
  near-identical wheel next to it that appeared only while a turn was running —
  two marks saying one thing, in the row that runs out of width first on a
  narrow sidebar. The second is gone and the brand mark itself now spins while
  Navy is working, which is both smaller and easier to notice: the thing you are
  already looking at starts moving.

- **High contrast modes are handled.** VS Code ships high-contrast themes and
  Windows has its own, both of which put the renderer into `forced-colors`,
  where the OS overrides every colour, drops box-shadows and removes gradients.
  Most of the panel survives that untouched, but three things lost real
  information rather than decoration: cards are typed entirely by a coloured
  left rail, which flattened to one system colour and made every card look
  alike; the context bar is a gradient fill, which was removed outright, leaving
  an empty track; and diff added/removed lines are distinguished by background
  tint. Card type is now restated as a border *style*, which forced-colors
  preserves, the bar gets a real border and a system fill, and the +/- markers
  carry the diff. `forced-color-adjust: none` is deliberately used nowhere — it
  opts an element out of the user's contrast choice, which is the opposite of
  the point.

- **Scrolling up during a long turn stranded you.** Autoscroll stops the moment
  you scroll away, which is correct — it must not drag you off something you are
  reading — but there was no way back and no sign anything was still arriving. A
  "jump to latest" button now appears while you are away and counts what landed
  meanwhile. It counts messages, not scroll events: the first version tallied
  calls to `scrollToBottom()`, which fires several times per reply and announced
  "3 new messages" for one answer. A reply that streams for a minute is one
  message, because it is one bubble.

- **Chat search could count matches but not visit them.** `_searchIdx` had been
  declared since the feature landed and never read, so a search on a long chat
  left you scrolling by hand. Enter now steps through matches and Shift+Enter
  steps back, wrapping at both ends, with the current one outlined. A search
  matching nothing hid every message and left the panel blank with only "0
  results" in the bar, which reads as "the chat is gone" — it now says so where
  the messages were, quoting the term back because it is usually a typo. And it
  no longer says "1 results".

- **Fifteen font sizes were fractional** — 10.5, 11.5, 12.5 and 13.5px, which
  cannot land on a whole device pixel at 100% zoom on a non-HiDPI display and
  render blurry. Rounded to whole pixels: up for the smallest secondary text and
  for code bodies, where half a pixel of legibility is worth more than half a
  pixel of room, down where the row is already tight. Twelve sizes became eight,
  and every size relationship is preserved.

- **`.composer-wrap` declared `position` twice** — `sticky` in its own rule and
  `relative` in another far below, same specificity, so the later silently won
  and the sticky had been dead for as long as both existed. Nothing was broken
  by it: the composer is the last row of a three-row grid, which pins it without
  sticky doing anything. Merged into one declaration so the next person to
  change it can see what it actually is.

- **An indented code fence was not a code block.** The fence had to begin hard
  against the left margin: one leading space and it stopped being code entirely,
  rendering as a paragraph with the backticks and language tag shown as text and
  inline markdown chewing through the command. A block written inside a list item
  is *always* indented, to the list's content column — so the commonest shape in
  any set of build instructions,

      2. Run:

         ```cmd
         call build.bat
         ```

  never became a card. It looked flush-left in the panel only because HTML
  collapses leading whitespace, which is what made it read as "code fences are
  broken" rather than "indented ones are".

  The opening fence's indentation is now matched and stripped back off each line
  of the content, so the list's indentation does not end up baked into the code
  while any deeper indentation the code has of its own survives. The closing
  fence no longer has to sit at the same indent as the opening one. The fence
  length stays capped: a 160,000-backtick run once froze the renderer for 14.5
  seconds, and it still renders in about 20ms.

- **The remove button on an attached file drew as a missing-glyph box.** It was
  assigned a literal U+FFFD — the replacement character, which is what is left
  behind when bytes fail to decode as UTF-8 — where its three sibling remove
  buttons all use U+2715. So one control in a row of identical controls rendered
  as a question mark in a diamond, which reads as "this app cannot display
  Unicode" rather than "one character in the source was corrupted". Nothing was
  wrong with Unicode handling: filenames with accents, em dashes and CJK
  characters render correctly, and there are tests for that now.

  `npm run check` now fails on a U+FFFD anywhere under `src/` or `media/`. Nobody
  types one deliberately, so finding one means a file has been through a lossy
  encoding round-trip and a real character was destroyed — silently, since the
  code still parses and runs.

- **You could be asked to approve a command you could not finish reading.** The
  approval card renders the command in a `<pre class="tool-details">`, and that
  class had no CSS rule behind it at all — so it fell back to a bare `<pre>`,
  which does not wrap, inside a card that sets `overflow: hidden`. A command
  wider than the sidebar was clipped, with no way to scroll to the rest of it.
  Reading the command before it runs is the entire purpose of that card. It now
  wraps, and breaks mid-token, because a command is one unbroken string more
  often than not — a long URL, a path, a base64 argument.

- **The outline offered turns an active search had hidden.** It and the step
  arrows were two separate queries for "the turns you can navigate to", and only
  the arrows filtered out messages the search had hidden — so the outline still
  listed them, and choosing one scrolled to an element with no box, landing at a
  nonsense position with nothing highlighted. They share one definition now.

- **Settings and the outline could be open at the same time.** Both are
  full-width sheets under the topbar, each up to 60–75vh, so together they left
  almost none of the conversation visible. Opening either now closes the other.

- **Four controls removed from the webview left their wiring behind** — a stop
  button, and the commit, PR and run-tests buttons. Twenty-eight lines of
  listeners and a `setBusy` branch for elements that no longer exist anywhere in
  the markup and are never created. Harmless, since every call was optional-chained,
  but it read as though those controls were still there. The commands themselves
  are untouched and still run from the Command Palette.

- **Buttons defined only by a coloured fill vanished under forced-colors.** Send,
  Save Settings and the jump-to-latest pill each set a background and no border,
  and forced-colors flattens the fill onto the system palette — leaving what
  looked like a run of plain text. They get a border there now.

- **The chat tab strip could not be reached by keyboard.** Tabs were
  `<div role="tab">` with no `tabindex`, so nothing in the strip was focusable —
  while the ✕ inside each tab was, being a real `<button>`. You could close a
  chat without keyboard but never switch to one. Tabs now use a roving tabindex
  (one Tab stop for the whole strip, arrow keys between them, wrapping at both
  ends, Home/End), answer Enter and Space, and carry `aria-selected` so a screen
  reader can tell which chat is open. Delete closes the focused chat, and the ✕
  deliberately stays in the tab order rather than being replaced by that
  shortcut — a keyboard path nobody can discover is not a keyboard path. The ✕
  and the + also have names now instead of reading as a bare glyph.

- **The composer drove two menus and was wired to neither.** Typing `/` or `@`
  opens a `role="listbox"`, but the textarea had no combobox semantics, so
  nothing announced that a menu had appeared, and arrowing through it announced
  nothing either — the highlight never moves DOM focus, and `aria-activedescendant`
  is the only thing that can report it. The options had no `id`s to point at in
  any case. The composer now declares `role="combobox"` with `aria-expanded`,
  `aria-controls` and `aria-activedescendant` kept in sync from every site that
  opens, closes or moves a highlight, and it has a name of its own rather than
  relying on the placeholder.

- **Eight looping animations ignored `prefers-reduced-motion`.** The block had it
  backwards: it switched off the ten one-shot entrance fades, which last 0.18s,
  and left every infinite spinner and pulse running — the ones that run for the
  whole length of a turn, which is the longest anyone looks at the panel. The
  original one-line `.spin-wheel { animation: none }` also silently missed two
  spinners whose rules out-specify it (`.rp-wheel-wrap .spin-wheel` and
  `.activity-row.running .act-icon .spin-wheel`), so those are now spelled out at
  full depth.

- **Nine pieces of muted text failed WCAG AA on contrast.** `--muted` on the
  panel background is 5.05:1, which passes — but each of these dimmed it further
  with `opacity`, and the worst (`.diff-ln`, the line numbers in a diff, at 0.45)
  landed on **2.01:1**, under half the 4.5:1 requirement, on 10px text where the
  large-text allowance does not apply either. The opacity is gone; `--muted` was
  always the de-emphasis and did not need help. De-emphasis below it has to come
  from size or weight, since transparency spends contrast that is not there.

- **The project selector's focus state was invisible.** `#projectSelect:focus`
  set `border-color` to `--border-hover` — the same value that select already
  uses for `:hover` — so focusing it while the pointer was over it changed
  nothing at all, and away from the pointer it was far weaker than the gold every
  other select in the topbar focuses to. Being an id selector it also outranked
  `.select-project:focus`, which had the right colour all along; deleting the
  rule is the whole fix.

- **Twelve settings labels were labels in appearance only.** Every field in the
  panel had a visible caption above it with exactly the right words, and not one
  carried a `for` — so the association existed for sighted users and for nobody
  else, and a screen reader announced "combo box" with no indication of what it
  set. Eight fields were leaning on their placeholder, which is not a label and
  disappears the moment anything is typed. All twelve are now associated, and the
  six controls whose only name came from a `title` — which needs a pointer to
  hover, so keyboard and touch users never saw it — carry an `aria-label` too.

- **The context bar told assistive technology nothing.** How full the context
  window is was two bare `<div>`s, with the actual numbers in a `title` on the
  inner one — a tooltip on an element that cannot take focus, so it was
  unreachable by keyboard, unavailable on touch, and invisible to a screen
  reader, which left colour as the only signal that a chat was nearly full. It is
  a `role="progressbar"` now, with the count in `aria-valuetext`.

- **A running build read its entire output aloud.** `#messages` is
  `aria-live="polite"` and every descendant inherits that, so streaming terminal
  output and every tool activity row were announced as they arrived — thousands
  of lines, with no way past them. The reply stays live, because hearing the
  answer arrive is the point; the transcript of what the agent did to produce it
  no longer interrupts. It is still fully readable, on request rather than
  shouted.

- **Four destructive buttons were smaller than a reliable target.** Close chat,
  remove attachment, remove image and delete command are drawn at 14–18px,
  under the 24×24 WCAG 2.2 asks for, and two sit directly beside another control
  where a near miss does something rather than nothing. The drawn size is
  unchanged — the rows are deliberately tight — but each now centres a
  transparent 24×24 hit area on itself, so only the pointer's reach grows.

- **Escape now closes the settings panel.** The dropdowns, the lightbox and the
  search bar all closed on Escape and the panel did not, which was an oversight
  rather than a decision. Focus returns to the button that opened it instead of
  being stranded on a hidden node, and an open lightbox still takes Escape first.

### Changed

- **The settings panel is grouped.** Its controls answer three unrelated
  questions — what Navy talks to, how it behaves, and what it does with search
  and speech — and used to run together in one undifferentiated column where
  finding a field meant reading all of them. They are now three sections, built
  as real `<fieldset>`/`<legend>` pairs rather than styled headings, so a screen
  reader announces the section when focus enters it.

  The panel carries the eleven settings you change while working; the other
  seventeen are edited in VS Code's own settings UI, which already has search
  and sync. It now says so, with a link that opens that UI already filtered to
  `navy.` — previously nothing in the panel indicated the other seventeen
  existed.

- **An empty model list explains itself and offers a way out.** This is the most
  common first-run state and it was the least informative screen in the panel:
  the dropdown read "No models", the provider's actual error was hidden in a
  `title` tooltip, and the welcome screen went on offering six chips that could
  not succeed. There is now a notice on the welcome screen carrying the
  provider's own words — "insufficient balance" and "invalid api key" need
  different fixes and only the provider knows which — with buttons for the two
  things that actually resolve it: the connection self-test, and Settings. An
  empty list with no error at all (a reachable Ollama with nothing pulled)
  explains that case separately instead of rendering blank.

  It is amber rather than red: nothing has failed yet, the panel simply cannot
  do anything useful until it is resolved. Red stays for a request that errored,
  so the two remain distinguishable at a glance.

- **`npm run check` checked one file out of thirty-seven.** It was
  `node --check src/extension.js`, and `node --check` does not follow `require`,
  so no module that file imports was ever parsed — nor was `media/main.js`, which
  ships raw instead of being bundled, meaning a syntax error there ships a
  webview that does nothing and the check still passes. It now parses every JS
  file under `src/`, `media/`, `test/` and `eval/`. It found a real one on the
  first run: a backtick inside an HTML comment in `src/webview-html.js`, closing
  the template literal the entire document is built from.

- **`package.json` declares a browser target.** Nothing in the build reads it —
  esbuild bundles only `src/extension.js` for Node, and `media/` ships raw — but
  without one, CSS compat linters assume the whole history of Chrome and flag
  every modern feature as unsupported. `chrome >= 122` is what `engines.vscode`
  (`^1.90.0`, Electron 29) actually provides, and it moves when that moves. A
  test now ties the two together: the tints need Chromium 111 for `color-mix`,
  which fails silently on an older engine — every tinted background resolves to
  nothing and the panel renders flat — so lowering the target trips a test
  instead of shipping that.

## [0.2.7] - 2026-08-16

### Added
- **Agent Skills.** Navy had rules (always on, always in context) and slash commands (you invoke them). It had nothing the *model* reaches for on its own, and nothing that could carry more material than fits in a prompt. A skill is a folder with a `SKILL.md`; what separates it from a command is **progressive disclosure** — only the name and description are in context, the body is read when the model decides the task calls for it, and `references/` one file at a time after that. A skill can carry a 400-line reference document and three scripts for about thirty tokens a turn.

  The format is the [Agent Skills spec](https://agentskills.io/specification) verbatim — no Navy dialect, no extra fields — so skills written for other tools work here unchanged, and one written here isn't trapped in Navy. Read in precedence order from Navy's global storage, `~/.claude/skills/`, `.claude/skills/` and `.navy/skills/`; every frontmatter constraint is validated and a skill that fails one is skipped with the reason in the output channel, rather than taking discovery down with it.

  **A skill grants nothing.** `allowed-tools` is parsed and shown on activation so you can see what a skill *wants*, and is never honoured as pre-approval: the field is experimental in the spec, so ignoring its approval semantics is compliant, and honouring it would let any repository switch off Navy's approval gate by shipping a file — a worse outcome than not supporting skills at all. Bundled scripts have no execution path of their own; they run through `run_command`, the same dialog and the same `_maybeWrapForSandbox` as any other command, because a separate path is a path around the gate. `activate_skill` refuses `../` escapes out of a skill's own directory, and project skills are listed but not loaded in an untrusted workspace — with the specific rule that a blocked skill never *shadows* a working one of the same name, since that would take a capability away rather than being ignored.

  The cost people underestimate is that every installed skill's description sits in **every request, forever** — at ~100 tokens each, fifty skills is most of the budget on an 8k local model, which is a real part of Navy's audience. So the manifest is capped as a fraction of the model's own compaction budget (~12 skills on a 200k model, ~4 on an 8k one — the limit tightens exactly where context is scarce), and anything dropped is named in the output channel rather than vanishing. `navy.skills` is `auto`, `off`, or an explicit list.

  Finally, every skill is **also a slash command**. Picking the right skill from a one-line description is exactly what small local models are worst at, and a skill that is never selected is pure context cost with no upside — so `/pdf-tools` loads it directly, with no matching involved. This is `docs/skills-design.md` implemented; that document now records the three places the implementation deviated from it and why.
- **Your own slash commands.** Navy shipped sixteen and no way to add a seventeenth. Every team has prompts it types constantly — "run the integration suite and triage what fails", "check this against our API conventions" — and retyping one from memory each time is how it ends up abbreviated into something that no longer says what it meant.

  A command is a markdown file: the filename is what you type, the body is the prompt. `.navy/commands/*.md` for a project's own (committed, so the team gets them), the extension's global storage for personal ones that follow you between projects, and `.claude/commands/*.md` is read as-is — the same citizenship argument that already makes Navy read `.cursorrules`, so a repo that has them works with nothing moved and a command written for Navy isn't trapped in it. A subdirectory groups related commands (`.navy/commands/db/migrate.md` → `/db:migrate`). Markdown rather than a JSON blob in settings because a prompt your colleagues will run is a thing that belongs in code review.

  Anything typed after the command replaces `$ARGUMENTS`; a template without one gets those words appended rather than dropped, so `/search cats` can't become "Search the web for: " with the cats gone. That expansion happens in the composer, so what is sent, what the transcript shows and what is persisted are one and the same text. It also made typing a command out in full work at all — `/deploy staging` was previously sent to the model as those literal characters, since only picking from the menu ever expanded anything.

  Two decisions that are hard to reverse once people have written commands, settled deliberately. A custom command **may shadow a built-in** — a team whose `/test` means something specific should get that, and the alternative is that they call it `/test2` and nobody remembers which is which — so the menu labels each entry with where it came from. And a command is prompt text and nothing more: it cannot pre-approve a tool, skip the diff, or run anything by existing, exactly as `allowed-tools` is treated in `docs/skills-design.md`. Read the other way round, that is also why a project's commands only load in a trusted workspace: cloning a repository must not silently redefine `/fix`.

  Managed from the menu itself, since a command you can add but not find again is barely added: a *New command* row at the bottom of `/`, **Navy Coder: New Slash Command** in the palette (which asks project-or-personal, scaffolds the file with its front-matter, and opens it), alt-click any custom entry to edit the file behind it, and an **×** on hover to remove one. Removing deletes a prompt somebody spent time writing and the panel has no undo of its own, so it confirms first — naming the full path, because a command may live in the repository, in `.claude/`, or in your personal storage and which one you are about to remove matters — and aims for the trash rather than unlinking, falling back to a real delete only where the filesystem has no trash. Built-ins have no × because there is no file behind them. Both the open and the remove routes validate the path they are given rather than acting on it: the only files they will ever touch are ones inside a commands directory, named the way a command has to be named. Also fixes the `/` menu closing halfway through a hyphenated name — the matcher was `\w*`, which stops at the hyphen, so it had never worked for the shipped `/pr-review` either.

  One consequence worth stating plainly: `.navy/.gitignore` now reads `*` plus an exemption for `commands/` rather than a blanket `*`. Chat history, background logs and the embedding index stay ignored exactly as before; a project's commands are the one thing in there meant to be committed, and a blanket ignore made "committed with the project" impossible — the files existed and git refused to see them. Both negations are needed, because git does not descend into an excluded directory. Existing projects are upgraded on the next write, but only when the file is still byte-for-byte what Navy wrote itself; anything you have edited is left alone.
- **A provider connection self-test** — Command Palette → *Navy Coder: Test Provider Connection*. Providers fail in ways that all look identical from the chat: a base URL that isn't an API root, a key valid in the other region, an empty balance, a genuinely bad key, or nothing listening at all. Three shipped base URLs turned out never to have worked, and each was found only because someone tried that provider by hand. The self-test asks for the model list **through the same request builder a real turn uses** — a diagnostic that constructs its own URL can report success against an endpoint the product never touches — and names which of those six it is, including the alternate regional URL when the provider has one.
- **`src/extension.js` broken up: 8,410 lines → 6,639.** Seven contiguous, self-contained groups of methods moved into modules of their own — retrieval and the embedding index (`retrieval.js`), persistent background processes (`background.js`), SSRF defence and `fetch_url` (`net-safety.js`), Docker sandboxing (`sandbox.js`), undo/redo (`undo.js`), the project catalog (`projects.js`) and web search (`web-search.js`) — plus four small shared modules (`paths.js`, `workspace.js`, `exec.js`, `session-context.js`) holding the pieces several of them need, so no module has to import its own importer.

  Every move is **pure**: each block was lifted verbatim, wrapped in a class so it needed no retyping, and mixed back onto `NavyCoderViewProvider.prototype`, where the methods still use `this`. No call site, signature or behaviour changed. Verified three ways rather than one — the full suite passes; all 205 provider methods are still on the prototype; and every method moved after a checkpoint was confirmed byte-for-byte identical to its pre-extraction source via `Function.prototype.toString()`.

  Two findings are recorded in CONTRIBUTING.md rather than discovered again: the tool implementations, which the plan named as the *first* seam to take, are **not** a clean one — all 35 are interleaved with their own private helpers, so lifting them wholesale would separate each tool from the code it calls. And adjacency is not cohesion: `literalReplace` sat between the relevance constants and the embedding chunker and was swept into `retrieval.js` on the first attempt, when it belongs to `apply_edit`.
- **An in-editor test suite that runs inside a real VS Code** (`npm run test:vscode`, and on both Linux and Windows in CI). Everything Navy had until now either drove the extension against a mock `vscode` API or drove the webview through jsdom — both of which pass happily while the extension fails to load at all. This launches a real editor with Navy installed and checks the contract between `package.json` and the code: that activation completes without throwing, that all 17 declared commands actually have handlers behind them, that all 28 declared settings resolve with the defaults the manifest claims, that the panel view can be focused, and that a real command executes end-to-end. Kept out of `npm test` because it downloads ~325 MB of editor and needs a display; the fast suites stay fast.
- **A weekly CI check that every shipped provider endpoint is still live** (`test/check-provider-endpoints.js`). Deliberately outside `npm test`: it is the only thing in the repo that makes real network calls, and a vendor being briefly down must never fail a pull request — but a vendor *moving* must not go unnoticed either. It needs no secrets, because it probes with a deliberately invalid key and treats "rejected the key" as proof the API root is alive.
- **CONTRIBUTING.md and TROUBLESHOOTING.md.** The first documents the repo layout, the invariants that aren't negotiable (zero runtime dependencies, real cross-platform support, comment the *why*), and the exact set of places to touch when adding a provider, a tool or a setting — adding a provider means six files, and missing any one ships something broken. The second covers the failures users actually hit, starting with the regional-endpoint table that turns an unexplainable `invalid api key` into a one-line fix.
- **Four more providers: Moonshot (Kimi), Qwen, MiniMax and Xiaomi MiMo.** Each endpoint was verified live before being added — all four answer an OpenAI-shaped `401` on `/v1/models`, which is what makes it safe to route them through the existing OpenAI-compatible path rather than writing new transports. Moonshot and Qwen ship separate mainland-China and international endpoints; the international one is the default (it is what a key bought outside China works against) and `navy.apiBase` switches to the other. All four are also selectable as `navy.providerFallbacks` entries.
- **Read a reply aloud.** A speaker button on every message (yours as well as Navy's) reads it out, and the same button stops it — so there is never a reading you can't halt. Markdown is spoken as prose rather than punctuation: fences, backticks, bullets and link syntax are stripped, and a code block is announced as "code block" instead of being read character by character. Clearing the chat or switching tabs stops the audio with it. The button is feature-detected and simply absent where the renderer has no speech synthesis, rather than offering something that can only fail.

  **The voice is chosen, not inherited.** A bare utterance takes whichever voice the platform lists first — on Windows that is Microsoft David, SAPI5 formant synthesis from the 1990s, which is where "robotic" comes from. Navy now ranks the installed voices and picks the best one *for your language*, preferring natural/neural and Premium/Enhanced families and actively demoting the old Desktop-suffixed set and Linux's eSpeak. Ranked rather than named, because the list differs on every machine and pinning a name that isn't installed lands you straight back on the default; language beats quality, because an excellent voice reading the wrong language is unusable. `navy.speechVoice` pins one explicitly, from a dropdown in the Settings panel listing what this machine actually has (the extension host cannot see the voices, so there is nothing to enumerate in `package.json`), and `navy.speechRate` sets the speed, clamped at both ends so a hand-edited `settings.json` cannot produce silence or noise.

  Two things beyond the voice itself made it sound mechanical. Stripping a bullet or a heading marker left the line with no sentence-ending punctuation, so a list was read as one breathless run — synthesisers phrase and pause on punctuation, and there was none. And the whole reply was handed over as a single utterance, which Chromium stops speaking after roughly fifteen seconds and never resumes, cutting long replies off mid-word. Reading is now queued a sentence at a time, which fixes the cut-off and is most of what makes it sound like reading rather than recitation. A chunk that never reports back is timed out rather than leaving the button stuck on ⏹.
- **Dictate a prompt.** A microphone button in the composer transcribes speech into the prompt box. Recognised text is **never sent automatically** — it lands in the box for you to read, edit and send yourself, because recognition mishears and a mistaken instruction to a coding agent can start real work. Text already typed is kept and dictation appends to it.

  A VS Code webview **cannot reach the microphone**: its iframe is built with `allow="cross-origin-isolated; autoplay; local-network-access; clipboard-read; clipboard-write;"` — no `microphone` — so Permissions Policy bars recording at the document level, and only VS Code can change that ([microsoft/vscode#250568](https://github.com/microsoft/vscode/issues/250568), still open). Electron compounds it: Chromium's recognition backend is keyed to Chrome itself, so even a permitted microphone fails with a `network` error. VS Code's own speech extension would be the obvious way out and is not one — the speech API is a *proposed* API, and an extension using one cannot be published to the Marketplace.

  So dictation uses the microphone where it actually exists — **your browser**. The mic button opens a small page on loopback, you speak there, and the transcript streams back into Navy's prompt box as you talk. Requires Chrome or Edge; the page says so in any other browser. Browser speech recognition uploads audio to the browser vendor's own service. This also happens to be the only design that survives a remote session: over SSH, Dev Containers and Codespaces, `asExternalUri` forwards the port to the machine the microphone is actually on.

  Recognising in the extension host instead was built and reverted. The only engine that needs no install and no API key is Windows' own `System.Speech`, and the desktop recogniser behind it predates neural speech models by a decade — it was not good enough to dictate a sentence with. Uploading recorded audio to a transcription API would have worked, but it needs a key, a recorder on the machine, and it breaks in remote sessions. Neither was an improvement on a browser tab.

  **There is no pause control.** The browser's recogniser has no pause of its own, so it was implemented by tearing the engine down and building a new one — and the gap swallowed whatever was said across it. A button that loses your words is worse than no button. Stop, and press the mic again.

  Three things made the first version feel unreliable, all fixed. Every interim guess was its own request, so dozens raced each other and the network delivered them out of order: an older, shorter transcript arriving late overwrote a newer one and the prompt box visibly lost words. Interim text is now coalesced onto one trailing post, a finalised phrase still goes immediately, and every post carries a sequence number so a late arrival is dropped rather than applied. The panel said "opening your browser…" indefinitely whether the page had loaded, been denied the microphone, or never opened at all — it now reports what the page is actually doing, because the page connecting back over a Server-Sent Events channel is the only real proof the browser opened. That channel is also what makes the panel's Stop actually stop the page, rather than closing the port and leaving it listening. And VS Code destroys a hidden panel and rebuilds it, which used to leave the rebuilt panel with no record of the session the extension was still running, silently discarding every word that arrived; it now adopts the live session instead.

  The socket this needs is treated as the security surface it is: bound to `127.0.0.1` on an ephemeral port, every route gated on a 256-bit token compared in constant time, `Host` and `Origin` pinned to its own origin so no page can reach it by DNS rebinding, request bodies capped, no CORS headers, a strict nonce CSP on the page, and the whole server torn down the moment dictation ends, the panel closes, the tab closes or five idle minutes pass.

### Changed
- **The default tool-iteration limit is now 100, up from 50.** Long refactors were hitting the cap mid-task and stopping with work half-done.
- **Docker sandboxing now works on Windows** — it was documented as macOS/Linux-only in 0.2.6 because every sandboxed command failed instantly there. The cause was one decision made against the wrong variable: the shell was chosen from `process.platform`, so a Windows host built `cmd /c <command>` and the wrapper spliced that straight into `docker run … <image> cmd /c <command>`. No Linux image has a `cmd`. The shell now follows the **execution target** rather than the host — with sandboxing on, Navy builds `sh -c`, escapes arguments with POSIX quoting instead of cmd.exe's caret rules, and tells the model it is writing for a Linux container rather than for Windows, since a model told "cmd.exe syntax" would otherwise author commands that cannot run where they are sent. Windows mount paths are converted to Docker's documented forward-slash form. Safe as a single decision because a `docker` mode either wraps the command or refuses it — it never hands an unwrapped one back, so `sh -c` cannot escape onto a Windows host. Asserted on every platform, so the two can't diverge again.
- **The semantic index no longer falls off a 24 MB cliff.** It was persisted as one flat `.navy/embeddings.json`, and past 24 MB it was **silently not saved at all** — so a large repository re-embedded itself from scratch every time the window opened, and one byte over the cap discarded a completely valid index. The ceiling existed for a real reason (stringify and parse run synchronously on the extension host's main thread, so an unbounded file is a UI freeze), which is why raising it was never the answer. Storage is now sharded across `.navy/embeddings/`, keyed by a stable hash of each file's path, so no single write is unbounded, re-indexing one file rewrites only the shard it lives in, and a shard that is corrupt or oversized costs its own files rather than the whole index. Every shard carries its own embedding-model stamp, not just a shared manifest: a crash or a rollback can leave shards from two different models side by side, and vectors from different embedding spaces produce a plausible-looking, meaningless score if compared, so any shard disagreeing with the first one read is discarded. An existing `embeddings.json` is migrated on first run and then removed — unlike the project catalog, the index is a pure cache, so keeping a second multi-megabyte copy for rollback would cost more than it saves.
- **Vectors are stored as base64 `Float32Array` instead of JSON number lists.** Against the format it replaces — which already rounded to 5 decimals — that is about **1.6× smaller** (12,915 bytes → 8,194 for a 1536-dimension vector), and the larger gain is that parsing stops being 1,536 numeric literals per chunk and becomes one base64 decode. No precision is lost: float32 carries ~7 significant digits, more than the rounding it replaces. A payload that isn't a whole number of floats decodes to nothing rather than to a short vector, because a wrong-length vector compared against a right-length one is the worst way this could fail.
- **Caches now expire when files actually change, not on a timer.** The repo map, relevance and gitignore caches expired purely on elapsed time — 30, 30 and 60 seconds. That is a correctness problem dressed as a performance setting: inside that window Navy answered from a snapshot of a file that had since changed, including files it had just edited itself and files the user changed in the editor while a turn was running. Time never said anything about whether the answer was still true. A single workspace watcher now invalidates by path, so an event is matched back to whichever cached project contains it and multi-root workspaces need nothing extra. Navy's own writes under `.navy/`, plus `node_modules`, `.git` and build output, are ignored — a watcher that reacts to its own writes is a permanent cache-off switch. Editing a file no longer discards the gitignore set either, since only a rule change or a file appearing or disappearing can affect it, and recomputing that one shells out to git.
- **The conversation budget now tracks the model's real context window.** Both size caps were fixed literals — 240,000 chars (~60k tokens) for mid-turn compaction, 200,000 (~50k) for the pre-turn history trim — regardless of which model was configured, even though Navy already tracks the live window. That was wrong in both directions: on a 200k- or 1M-token model it compacted away history there was ample room to keep, and paid for a summarization call to do it; on an 8k model it cheerfully assembled 60k tokens' worth for a window that could never hold a quarter of it. Both now derive from the active model's window, and an explicit `navy.contextWindow` still wins — that setting is documented as controlling when Navy treats the chat as full, which is exactly what these caps are. The two stay in a fixed ratio rather than drifting as independent numbers, and the derived value is capped: the conversation is measured and stringified synchronously on the extension host's main thread on every iteration, so a 1M-token model would otherwise hand it ~2.4 MB of string per pass and the UI freeze that comes with it. An unrecognised model falls back to exactly the old floor, and the compaction strategy itself is untouched.
- **The per-file edit caps are configurable** — `navy.fileEditSoftCap` (default 5) and `navy.fileEditHardCap` (default 10), both unchanged from the previous hardcoded values. A genuine single-file refactor can legitimately exceed ten writes and there was no way to opt into more rope. Both are clamped so the edit-loop guard cannot be configured out of existence, and an inverted pair raises the hard cap to meet the soft one rather than lowering the soft cap — someone who set them apart wanted more room, not less.

- **Syntax highlighting in code cards.** Code blocks in the chat rendered as flat monochrome text, which made anything longer than a few lines hard to scan next to a syntax-highlighted editor. Keywords, strings, comments, numbers, function names and object keys are now coloured for JavaScript/TypeScript, Python, Ruby, shell, Go, Rust, Java, C/C++/C#, PHP, Swift, Kotlin, JSON, YAML/TOML, HTML/XML, CSS/SCSS and SQL. Colours are taken from the active VS Code theme's own token colours, so a block in the chat matches the editor a few pixels away instead of imposing a competing palette. Written as a small self-contained tokenizer rather than a library — the webview's CSP forbids loading anything external, and `media/main.js` ships unbundled — and it is a single linear pass (≈1 ms for a 11,000-character block), with blocks over 20,000 characters left plain, since a very large paste is exactly when the panel can least afford extra per-render work. An unrecognised language is left unhighlighted rather than guessed at. Copy and Apply are unaffected: they read the code's text, which is preserved byte-for-byte.
- **Copy button on your own messages.** Assistant replies had one; your prompts didn't, so re-sending a long instruction with a small change meant retyping it. Copying takes the original text rather than what's on screen — a long prompt is collapsed behind a "Show N more lines" toggle, so reading it off the rendered message would have silently truncated it and swept the toggle's own label in with it.
- **Ollama Cloud, so Ollama no longer has to be installed.** `navy.ollamaMode` picks between `local` (the server at `navy.host`, unchanged and still the default) and `cloud`, which talks to **ollama.com** with an API key saved in the OS keychain. Cloud runs models far larger than most machines can host. Ollama Cloud serves the same native API as a local install, so this is a host swap plus a bearer token rather than a separate provider — chat, the model list, context-window detection, embeddings, and inline completions all route through one resolver, so enabling it can't reach some endpoints and miss others. The settings panel swaps the Host field for the API Key field when you choose Cloud, since `navy.host` describes a machine-local server and is deliberately ignored in cloud mode — an API key must never be sent somewhere you didn't intend.

- **Navy no longer writes into your repository to remember which project you're in.** The chosen project root was saved as a workspace-scoped setting, which makes VS Code create or edit `.vscode/settings.json` inside the project itself — a file many teams commit, so simply picking a project in Navy could turn up in someone's `git diff`. It now lives in the extension's `workspaceState`: scoped to that window automatically, invisible to the repository, and removed along with the extension. `navy.projectRoot` remains a setting, but purely as an override you may set deliberately — editing it now switches Navy immediately, which is what a setting called "Active project directory" ought to do.
- **The remembered project list moved from `~/.navy/` into VS Code's own per-extension storage.** A folder in your home directory is shared between VS Code profiles and between Stable and Insiders, so two profiles fought over one file (the contention the catalog's read-retry logic exists to survive); it survives uninstalling the extension; it isn't covered by Settings Sync; and over SSH or WSL `~` resolves on the remote machine rather than where you would expect. `context.globalStorageUri` has none of those problems. An existing `~/.navy/projects.json` is migrated automatically on first run and left in place, so rolling back to 0.2.6 still works.

### Fixed
- **Reopening a chat threw away everything the turn actually did.** A session persisted only each message's role and text, so a restored transcript replaced every activity row, terminal card and edit card with bare prose — a turn that read four files, edited two and ran the tests came back looking as though Navy had simply answered, and the banner at the top said so in as many words. What the webview draws live is a pure function of (tool, arguments, result), so each turn now records those three per card and a restore redraws through the same builders the live turn used: the same rows, the same collapsed "✓ N steps" summary, the same terminal card with its exit status, in one message with the reply reading below the work it describes. The banner is now shown only for chats saved before this existed, rather than standing permanently over a transcript that plainly does show them.

  Bounded deliberately, because this file lives in your repository: 60 cards per turn, results capped (4,000 characters for a command, which prints real output; 400 for everything else, which shows a one-line preview), and only the argument keys a card actually displays. A `write_file`'s content and an `apply_edit`'s replacement text are **dropped, not truncated** — they are never shown, and they would otherwise put whole file bodies into the chat file several times over. Where a result is truncated, its true size travels with the excerpt, so a 900-line read still reports 900 lines instead of the eight that were kept; counts that can only be derived by scanning are shown as "N+" rather than as a number that would be quietly wrong.
- **A tool call in the middle of a code block destroyed the block's formatting.** A reply is split into separate bubbles so tool cards can sit between them, at the point the tool ran — but the split was taken wherever the tool happened to land, including partway through a ``` block. That cut the fence in half: the sealed bubble held an opening fence with no close, the next held a closing fence with no open, and since neither is a valid block, both fell through to ordinary paragraph rendering. The result was the fences shown literally as text, indentation collapsed, and inline markdown chewing through the code — `re_match_alternation` rendering as *re*match*alternation* because the underscores were read as emphasis. Navy now waits for the block to close before splitting the bubble.
- **Code cards rendered as a box inside a box.** The rule styling inline code — the small bordered pill around `` `something` `` in a sentence — was written as `.message-bubble code`, which matches *every* `<code>` in a message, including the one inside a fenced block's `<pre>`. The block rule overrode its padding and background but never its border or radius, so the pill's outline survived and each code card drew a second bordered container around the code, inset from the card that already had one. Inline code is now targeted specifically, and the block rule clears the border explicitly so a future tweak to the pill cannot bring it back.
- **Navy could not work on a single file — only on a project folder.** With no folder open, Navy derives the project root from the file you have open, but that derivation was skipped unless exactly one chat tab existed. That guard was meant to stop a deliberately-blank "New Chat" tab being auto-filled with a project you meant to pick yourself; there is nothing to pick when no folder is open, so opening a second tab left the root empty and *every* file tool failed with "No project root — open a folder before using file tools" for the rest of the session. Single-file mode now works regardless of how many tabs are open, path containment still applies (the file's folder, not the whole disk), and the guard is kept for the case it was actually written for.
- **Navy kept forgetting which project you were in.** The global catalog at `~/.navy/projects.json` was being written faithfully on every project switch — but only ever *read* to populate the "Other projects" group in the dropdown. Nothing consulted it when deciding which project to open with. Restoring relied solely on `navy.projectRoot`, which is stored workspace-scoped whenever a folder is open, so a project added to the untitled multi-root workspace VS Code creates for "Add to Workspace", or opened in a window that later starts with no folder, had nothing to restore from and Navy came up blank. Three changes: the catalog is now consulted as the fallback (a folderless window reopens your last project; with a workspace open, only a project inside it is eligible, so Navy still never silently operates on a project that isn't open), the root is additionally persisted globally so a folderless window can restore from settings alone, and dead entries are pruned when the catalog is rewritten.
- **The project catalog filled up with folders that no longer exist.** `_readGlobalProjects` filtered missing folders out for display and its comment claimed they were "dropped for real the next time the file is rewritten" — but nothing ever did that, so they accumulated permanently. With a 100-entry cap that is not merely untidy: dead entries push real projects out of the catalog, which is the same "Navy forgot my project" symptom from the other direction. Found in the wild at 97 dead entries out of 100. Existing catalogs clean themselves up the next time you open any project.
- **z.ai (GLM) could never list a model.** The default base URL was `https://api.z.ai/v1`, which z.ai does not serve at all — `api.z.ai/v1/models` is a bare nginx 404. Every request failed, and the only symptom was "Couldn't fetch models — check your API key or base URL", so the natural response was to re-paste a key that was never the problem. The OpenAI-compatible surface lives under `https://api.z.ai/api/paas/v4`, which is now the default; `api.z.ai/api/coding/paas/v4` (GLM Coding Plan) and `open.bigmodel.cn/api/paas/v4` (mainland China) are documented in the setting. Compounding it, z.ai was the one keyed provider with **no fallback model list at all**, so when the fetch failed there was nothing in the dropdown to pick — it now carries the live GLM line-up (`glm-5.2` … `glm-4.5-air`), and a test asserts every keyed provider has one.
- **GLM and Kimi context windows were stale or missing.** `glm-4.6` raised its window from 128K to 200K and the whole `glm-5.x` line matched no entry at all; `kimi-k3`'s 1M window was likewise absent. A context window is a send budget, so a missing entry means Navy under-fills a model that could take far more, and the corrections are deliberately conservative for the opposite reason — over-stating one makes requests fail outright. Kimi's fallback model ids were also still the K2-preview era (`kimi-k2-turbo-preview`, `moonshot-v1-128k`) and are now `kimi-k3`/`kimi-k2.7-code-highspeed`/`kimi-k2.6`.
- **MiniMax rejected every valid key.** The default endpoint was `api.minimaxi.com`, which is a real, live MiniMax host that answers `/v1/models` — but current international keys authenticate only against `api.minimax.io`, and the older host rejects them with a bare `invalid api key (2049)`. Every check that would normally catch a wrong base URL passed: the host resolves, serves the right API shape, and returns a plausible auth error. Confirmed by testing one key against all three MiniMax hosts — `.io` returned the model list, `minimaxi.com` and `minimax.chat` both returned 2049. The default is now `https://api.minimax.io/v1`, with `api.minimax.chat` documented for mainland-China accounts. The fallback model list was stale too (`MiniMax-M1`, `MiniMax-Text-01` are no longer served) and is now taken from a live `/v1/models`.
- **A key aimed at the wrong regional endpoint was reported as a bad key.** Moonshot, Qwen and MiniMax each run separate mainland-China and international endpoints, and using a key against the wrong one fails as an ordinary `401 invalid api key` — so Navy told the user to re-paste a key that was perfectly good, with no hint that the endpoint was the problem. The auth error now names the regional-endpoint possibility and points at the API Base URL setting; every affected provider's setting description now spells out both URLs rather than only mentioning that another exists.
- **A Groq rate limit was reported as a billing problem — and silently disabled failover.** The quota classifier matched the bare word `billing`, which Groq appends to ordinary per-minute rate limits as an upsell link (`Upgrade to Dev Tier today at …/settings/billing`). So a plain TPM limit was titled "your account has no quota for this model" and advised enabling billing that was already fine. The worse half was invisible: `quota` is deliberately classified non-transient, so misreading a rate limit as one also suppressed the cross-provider failover (`navy.providerFallbacks`) that exists for precisely this case — the fallback never fired, and nothing said why. Every term in the quota pattern now has to mean "out of quota" on its own; OpenAI's `insufficient_quota` (which arrives as a 429) and Anthropic's "credit balance is too low" are matched explicitly so tightening the pattern didn't cost the cases it was for.
- **A request bigger than the whole per-minute budget was told to wait and retry.** When a provider reports `Limit 8000, Requested 12717`, the single request exceeds the entire budget — it cannot succeed at any time, so "wait ~60 seconds and try again" is advice that can only fail. That shape is now detected and the advice changes to what actually works: send less (new chat, fewer files, Context off) or raise the ceiling. Ordinary burst rate limits still say to wait.
- **A drained prepaid balance produced a generic, unactionable error.** MiniMax reports an empty account as `402 insufficient balance`, which matched none of the classifier's quota patterns, so it fell through to "X error —" with no explanation. It is now classified as a quota/billing problem like every other provider's version of the same thing.
- **The test suite wrote into the developer's real `~/.navy/projects.json`.** Several suites reach the catalog indirectly through project activation, on providers that never set the test-only path override, so temp directories from test runs were being recorded as real projects — the direct cause of the 97 dead entries above. The whole run is now redirected to a throwaway directory.

## [0.2.6] - 2026-08-10

### Added
- **Multiple concurrent chat tabs, scoped per project.** Navy was one conversation per project root — switching projects meant losing track of whatever else you were working on, and there was no way to run two lines of work on the same project side by side. The tab strip now shows the CURRENTLY SELECTED project's own chats as children of it (not a flat list spanning every project you've ever opened): picking a project from the dropdown switches to its own set of tabs and resumes whichever chat you were last on, and "+" starts a new chat under whichever project is currently active. Each chat is persisted to its own file (`.navy/chats/<id>.json`) so two chats on the same project never overwrite each other's history — projects that predate this still using the old single `.navy/session.json` are migrated automatically the first time they're opened, no action needed. A running turn keeps streaming into its own (now background) tab while you work in another.
- **Opening a project from the folder picker no longer switches to it.** "Add Navy project" now only adds the folder to the list (or, for an already-open folder, just says so) — picking it from the project dropdown afterward is the one action that actually makes it active, persists the choice, and reveals it in VS Code's own Explorer. Adding a folder and selecting it were previously the same action, which meant you couldn't queue up a project to look at later without immediately being switched into it.
- **Deeper code retrieval for `find_relevant_files`.** Semantic search embedded one vector per file, truncated to the first 1500 characters — a symbol defined further into a large file was invisible to it. Files are now split into overlapping ~120-line chunks before embedding, each chunk scored independently, and the winning chunk's line range is reported so the model can jump straight to it with `read_lines` instead of re-reading the whole file. Keyword ranking is also now blended with real LSP symbol matches (via the same `vscode.executeWorkspaceSymbolProvider` call `find_symbol` already used) rather than a regex guess at "this file defines a symbol" — falls through to keyword-only ranking with no cost when no language server is active. Existing caches auto-rebuild once in the new chunked format.
- **Multi-root workspace awareness.** `search_files`, `search_codebase`, `list_files`, and `find_relevant_files` accept an optional `folder` argument to target a sibling folder in a multi-root workspace explicitly, and path resolution now accepts any path inside any open workspace folder, not just the active project root — a frontend+backend workspace open together no longer requires switching Navy's active root back and forth to touch both.
- **Opt-in Docker sandboxing for command execution** (`navy.sandboxMode`). `run_command`/`run_tests`/`run_project`/background processes can now run inside a Docker container built from the project's own `.devcontainer/devcontainer.json` or `Dockerfile`, instead of directly on your machine — a second, independent layer of isolation on top of the approval dialog and workspace-trust check, not a replacement for either. Off by default; refuses to guess at a generic container image when the project has no devcontainer/Dockerfile of its own, since a container that doesn't match the project's real toolchain would be a false sense of safety.
- **Navy now remembers what it actually DID in earlier turns, not just what it said it did.** Replaying conversation history for a new turn only ever carried each past turn's final reply text — the real tool trace (which files were read, which commands were run and their exit code, which files were written) was discarded the moment a turn ended, so a long chat could re-read a file or re-run a command it had already run several turns earlier, with no way to know that. Each turn now attaches a compact, verifiable record of its own tool activity that's replayed to the model on later turns (never shown in the chat UI itself — it rides alongside the reply text model-side only), so the model can point back at exactly what it already checked instead of re-deriving it from memory of its own prose.
- **Running token count + estimated cost for the current chat.** The token counter only ever showed the LAST model call's usage, resetting every turn with no sense of what a conversation had cost in total. It now shows a cumulative session total — accumulating live during a turn, correct after Clear, and correct immediately when you restore or switch to a chat, since it's derived from each turn's own recorded usage rather than a separately-maintained counter that could drift. Local models (Ollama, LM Studio) always show as exactly $0 — no guessing needed. For hosted providers, an approximate $ estimate is shown for well-known models (Claude, GPT, Gemini, DeepSeek, Grok, GLM), computed using each turn's OWN provider and model — a session that spans a model or provider switch prices every turn correctly instead of applying today's rate to yesterday's usage. An unrecognized model shows token counts with no dollar figure rather than a guessed one, and a session with a mix of priced and unpriced turns is marked with a "+" as a floor, not a false total. Pricing is a snapshot, not a live rate — the tooltip says so explicitly, and this is not intended as a substitute for checking your provider's actual bill.
- **The repository map now shows what's actually inside a file, not just its name.** The map the model sees on every turn was a bare file tree — no function or class names, so understanding an unfamiliar codebase meant reading files one at a time to discover what they even contain. Code files are now enriched with a one-line function/class/method outline, using VS Code's own `executeDocumentSymbolProvider` (the same real language-server infrastructure `find_symbol`/the LSP-blended ranking already use) — no new dependency, no cost when no language server is active for a file (it just shows the plain filename, exactly as before). Bounded to keep this fast: at most 30 files per map are queried, all in parallel with a 400ms-per-call timeout, so a slow or hung language server adds about one timeout window to the (already 30-second-cached) map build, never a multiple of it.
- **`delegate_research` — a tool the model itself can use to spin off an isolated, read-only sub-agent.** Navy was strictly single-threaded: a broad investigation ("how does auth work in this codebase", "find every place X is used") had to be done inline, filling up the main conversation's own context with every file it looked at along the way even though only the CONCLUSION was actually needed going forward. The model can now delegate that kind of task to a sub-agent with its own isolated context and get back only the written summary. The sub-agent can read, search, and browse — it is refused (at dispatch time, not just discouraged by the prompt) if it tries to write, delete, run a command, or delegate further, so it can investigate but never act; a refused attempt gets a clear explanation and the sub-agent can still recover and report its findings. Bounded to at most 20 tool-use steps. Token usage from sub-agent calls is real spend against the same provider/model that ran them, and is folded into the delegating turn's own cost accounting, not left untracked.
- **Opt-in cross-provider failover** (`navy.providerFallbacks`). A rate limit or outage on the configured provider used to just fail the turn outright. Empty by default — with nothing configured this changes nothing. Configured, Navy tries an ordered list of backup providers (each using its own already-saved API key) but ONLY for a genuinely transient failure — a rate limit, a server outage, or a network error — never for an API-key/auth problem, a quota/billing limit, or a conversation too large for the model, since those need something fixed rather than a different account to silently pay for instead. Every fallback attempt, and whether it succeeded, is announced directly in the chat before it runs — this can spend money on a different account than the one you're looking at, so that must never happen invisibly. Cost/token accounting and conversation-replay safety (the `_rawBlocks` tagging that keeps Anthropic/Gemini extended-thinking state from being replayed into the wrong provider) both follow whichever provider actually served each call, not whatever's configured as primary.
- **Opt-in persistent background processes** (`navy.persistBackgroundProcesses`). `run_project`/`start_process` children were always killed outright on a window reload or Navy deactivating, so a dev server had to be restarted after every single reload. Off by default. Turned on, those processes are simply never told to stop — their output goes to a real log file under `.navy/bg-logs/` instead of live-streamed to the chat, since there's nothing on this end left reading it once the window that started them is gone (`read_process_output` reads the log file's current contents either way; `run_project`'s server-URL detection polls it too, briefly, instead of watching a live stream). Reopening a project that still has one of these running prompts to stop it, so a forgotten background process doesn't run forever unnoticed. On Windows this required *not* using Node's usual `detached: true` — verified directly that it silently breaks a cmd.exe-launched grandchild's output ever reaching a redirected file, through several different mechanisms, with no error anywhere; the process was simply never told to stop, which is what this setting actually needs.
- **A global project catalog, so a project doesn't disappear when its window closes.** The project picker only ever showed folders that were part of THIS window's workspace right now — a project used last week in a window that's since closed had no way to be picked again except re-browsing for its folder from scratch. Navy now keeps a small, user-inspectable catalog of every project root it's ever been pointed at, in `~/.navy/projects.json` (independent of any one window), and the dropdown shows those too, under "Other projects" — picking one offers the same **Open Here** (replace what's in this window) or **Add to Workspace** (keep what's open and add this one alongside it) choice a brand-new folder pick already got, previously only reachable through "+ Open project…". Picking a project already open in this exact window still switches to it directly, same as before — the choice only appears for something that isn't already both open and part of this workspace. Capped to the 100 most recently used projects; an entry whose folder has since been moved or deleted is dropped automatically instead of offering a dead path.

### Fixed
- **The project catalog and the background-process manifest could silently lose an entry under concurrent writes.** Both `~/.navy/projects.json` (written from any window) and a project's `.navy/bg-processes.json` (written by sibling chat tabs on the same project, which can genuinely run at once) did an unguarded read-modify-write — whichever write landed last would overwrite the other, silently dropping a project from the catalog or a still-running process from the manifest. Both now serialize writers within one window (a project's manifest gets its own lock, independent of the file-edit write lock, so one never delays the other) and additionally re-check the file right before writing, retrying against the fresh data if a genuinely different process changed it in between — the same class of protection the file-edit write lock already gave ordinary edits, extended to these two newer shared files.
- **Chat tabs, unlike the caches next to them, never freed memory for a chat you'd stopped using.** Every chat ever loaded from disk or created in this window stayed in memory (full message history and undo checkpoints) for the life of the window. Capped at the 40 most recently saved chats; never evicts the active tab, a busy tab, a chat that hasn't been saved yet, or a project's only remaining chat, so nothing that could still be unsaved or in use is ever at risk — an evicted chat's project is simply marked for a fresh read next time it's opened, and its content, already safely on disk, comes back exactly as it was.
- **The per-project embedding/repo-map/relevance cache grew forever, for every distinct project ever opened in a window.** Nothing evicted an entry once created, so a long-lived VS Code session touching many different repos over hours or days accumulated all of their embedding vectors and caches in memory at once, with no upper bound. Capped at the 20 most recently used projects (generous — ordinary usage never gets close); only ever evicts a project with no currently-open chat tab, which is the one condition that guarantees nothing could still be using its write lock, so this can never race an in-progress write.
- **A second round of reasoning midway through a turn rendered as if it happened at the very start.** A multi-step turn's activity log (tool calls) was only ever split from the surrounding reply text ONCE per turn — the first time tool activity began. Every batch of tool calls after that kept appending to that same, already-positioned log, so everything the model wrote from the second batch onward (more reasoning, more text) piled into a single trailing bubble — and since `<think>` extraction hoists reasoning to the top of whatever text it's found in, a round of reasoning that actually happened deep into the turn rendered at the top of that bubble, ahead of tool activity that came AFTER it chronologically. Each batch of tool activity now gets its own log positioned right where it happened, so a turn with reasoning → tools → reasoning → tools → summary renders in that real order, with each round of reasoning collapsed in its own correct place instead of merged forward into one.
- **Docker-sandboxed commands re-resolved (and could re-build) the sandbox image before every single command.** `navy.sandboxMode: docker` re-parsed the devcontainer/Dockerfile and re-ran `docker build` on every `run_command`/`run_tests`/`run_project`/background-process call, even though the resolved image never changes within a session — a multi-command turn paid that round-trip repeatedly for nothing. Now cached per project, invalidated by the devcontainer/Dockerfile's own mtime so an edited config still takes effect on the very next command.
- **Reading a persisted background process's log could briefly freeze the panel.** Both `read_process_output` and `run_project`'s own server-URL detection (polled up to 20 times) read the ENTIRE log file into memory just to keep the last few KB — for a dev server that logs heavily during startup, a synchronous full-file read on the extension host's single thread scaled with how much it had ever logged, not with what was actually needed. Both now read only the tail directly.
- **A handful of huge turns could bloat every later turn's prompt indefinitely, well before history-condensation ever kicked in.** Old conversation history is condensed into a digest once a chat passes 80 messages — but that threshold is a raw message COUNT, so a chat with only a dozen turns that happened to quote back large files or search results (real example: one session's token counter read 7.7M cumulative tokens) could sit at hundreds of thousands of characters, replayed in full on every iteration of every future turn, without ever tripping it. The trigger now also fires on total history size (≈50k tokens), independent of message count, using the same drop-the-oldest/keep-a-recent-floor logic either way — so a few oversized turns get condensed even when there aren't 80 of them. Guarded against a session with FEWER messages than the recency floor (nothing willing to be dropped): that case now skips the summarization call entirely instead of spending a whole extra model call condensing zero messages.
- **A wrong path in a `run_command` never got corrected, only re-guessed.** Nothing distinguished "the command failed for a logic/build reason" from "the command failed because a path in it doesn't exist" — so a model that guessed a filename wrong just retried with a different guessed spelling, repeatedly, since a wrong path never becomes right by chance (seen live: five straight failed attempts at a path containing a space, each guessing a different quoting/spelling). `run_command`/`run_tests` now recognize the common OS and toolchain phrasings for "this path/command doesn't exist" (cmd.exe, POSIX shells, and compiler frontends all phrase it differently) and append a direct instruction to list the real parent directory first instead of guessing again — never fires for an ordinary build/logic error or a bare non-zero exit, only a genuine not-found signature.
- **Sibling chats on the same project could interleave writes to the same file.** The write-lock that serializes file-mutating tools between a turn and its background tasks was scoped per chat, not per project — harmless when a project could only ever have one live chat, but with multiple chats now possible on one project, two of them writing at once had nothing serializing them against each other. The lock, the embeddings-index cache (plus its in-flight/rate-limit guards), and gutter edit-markers are now all shared per project root instead of duplicated per chat: two sibling chats no longer race to save the same `embeddings.json` (previously whichever chat's debounced save landed last silently discarded the other's contribution), and one chat's file edit no longer erases another's gutter markers for the same file. `Clear Chat` no longer wipes gutter markers either, since they reflect real edits still on disk and clearing one conversation shouldn't hide another's.
- **A background chat's pending tool approval could hang forever.** Closing the whole Navy panel only ever resolved the currently active chat's pending approvals, leaving a background chat's turn permanently stuck waiting on an approval nobody could still click. Panel disposal now resolves every open chat's pending approvals; Stop and Clear remain scoped to the active chat only, so they still can't reach into an unrelated background conversation.
- **Switching tabs could show a blank chat instead of real history.** Closing the active tab falls back to a sibling chat the frontend has no advance notice of (unlike a direct tab click, which updates its local state immediately) — the message that would tell the frontend which chat is now active was being sent after, not before, that chat's history, so the history arrived tagged for a session the frontend didn't yet recognize as active and was silently dropped.
- Picking a project already open in another tab from the dropdown used to jump to that other tab and abandon the one you'd just picked it for; picking a project for a tab now always binds it to the tab you're on.
- **The tab strip's active-tab highlight could get stuck on the old tab.** Opening a new tab (or any other backend-initiated switch not preceded by a direct click) updated the visible chat correctly but left the blue "active" highlight on the previous tab until you clicked away and back. The tab-list renderer determined which tab was active by matching the CURRENT tab's own id against the list — and since the old tab is still present as a sibling (just no longer active), that match kept succeeding and the frontend never noticed the switch. It now trusts the backend's own "this one is active" flag first.
- **The diff card fell back to a cruder view for any file over ~633 lines, even for a one-line change.** The diff renderer used an O(n×m) DP table capped at a fixed cell-count product, so file SIZE alone forced the fallback — a 700-line file with a single changed line got the same degraded "changed lines ± 3 context" view as a genuinely huge rewrite, and that fallback's naive same-index comparison also misaligned everything after an insertion or deletion (an inserted line made every line after it look changed, not just the one that actually changed). Replaced with Myers' O(ND) shortest-edit-script algorithm, whose cost scales with how much actually changed, not file size — a 5000-line file with a handful of scattered edits now gets an exact, correctly-aligned diff. Still falls back, unchanged, for the rare case of two huge and almost entirely different files, where line alignment stops being useful anyway.
- **Project rules only ever read the FIRST well-known file found, silently discarding the rest.** A repo with both an `AGENTS.md` (shared, tool-agnostic team conventions) and a `.navyrules`/`.cursorrules` (a small tool-specific tweak) had every convention in whichever file lost the race thrown away entirely the moment Navy loaded rules at all. All non-empty well-known rule files are now merged, broadest first (`AGENTS.md`, `.github/copilot-instructions.md`, `.cursorrules`, `.navyrules`) so a more Navy-specific file reads as a refinement of — and, on conflict, an override for — the general ones before it, each clearly labeled with its source file. The `.navy/rules.md` fallback is unchanged, and still only applies when none of those files exist at all.
- **A queued message could run against a different chat than the one you queued it in.** Sending while a turn is in progress queues the message; the queue is drained when that turn ends. The drain re-entered the turn loop reading whichever tab was *visible* at that moment rather than the tab the message actually belonged to — so queueing a prompt in one tab and switching away before the turn finished ran it against the other tab's conversation, checkpoints, and project root, meaning its file edits could land in the wrong project entirely. A turn now stays bound to the session it was queued in, regardless of what you switch to while waiting.
- **A background tab finishing its turn could replace the visible tab strip with a different project's tabs.** The tab list was built from the project of whichever turn happened to be reporting, not the project on screen — and that message is deliberately exempt from the per-tab filtering that protects everything else — so a turn completing in a background project rewrote the strip with that project's chats and left no tab highlighted. The strip is now always built from the project actually being displayed.
- **Closing a chat tab didn't really close it.** The tab was dropped from memory but its file was left behind in `.navy/chats/`, so it reappeared on the next window reload. Closing now deletes the chat's own file, and cancels its pending debounced save first so a save already in flight can't immediately write it back.
- **Windows: an argument containing a space, a quote, or a `%` was corrupted before the command ever ran.** Two independent faults compounded here. First, Node's default argument quoting escapes an embedded quote as `\"`, which cmd.exe does not understand and forwards literally — so `--testNamePattern="my test"` reached the test runner split in two, as `"my` and `test"`. Second, the escape meant to stop `%VAR%` expanding placed its caret *inside* the quoted region, where cmd.exe treats a caret as an ordinary character: expansion was suppressed, but the caret stayed in the value, so a filter of `%PATH%` arrived as the literal `%^PATH%` and `50%` as `50%^`. Shell commands are now handed to cmd.exe verbatim, and escaping happens in two ordered stages — argument-level quoting for the program being run, then caret-escaping every cmd.exe metacharacter including the quotes themselves, since a caret only does anything outside them. Verified by actually running the commands: values containing spaces, quotes, backslashes, `%`, `&`, `|`, `^`, `!`, and `$(…)` now arrive byte-for-byte, unexpanded and unsplit, as exactly one argument.
- **`run_command`/`run_tests` didn't recognise cmd.exe's own "File Not Found".** The not-found detection covered several OS and toolchain phrasings but missed the plain wording `dir`/`type` actually use — previously unreachable, because the quoting fault above meant a missing path reached cmd.exe mangled and came back as a *syntax* error instead. With quoting fixed, the real message surfaces, and it now correctly triggers the "list the parent directory instead of guessing another spelling" hint (which also covers clang's `'foo.h' file not found`).
- **Stopping leftover background processes could kill an unrelated program.** `navy.persistBackgroundProcesses` records a process id so a later window can offer to stop what was left running, but process ids are recycled — often within hours on a busy machine, and these records routinely outlive a reboot — so "still running?" answered yes for whatever *now* holds that number, and "Stop All" would have terminated it and its entire process tree. Navy now verifies the process's real start time against what it recorded before offering to stop anything: a recycled id is recognised as stale and simply pruned, and a record that can't be positively identified is reported and left strictly alone rather than either killed or silently dropped (dropping it would leak a genuinely orphaned process with nothing left pointing at it).
- **Project caches could discard the entry they had just created.** The per-project cache evicts least-recently-used entries once it passes its cap, but the eviction ran before the new entry was stamped with a use time — so a brand-new entry sorted as the *oldest* and was the first thing thrown away. Where that mattered: a caller would then write a lock onto an object no longer in the map, and the serialisation that lock provides was quietly lost.
- **Reopening a project could re-read its chats from disk over and over.** Evicting a chat un-marked its project as loaded — including the project that had just been loaded, whose chats were what pushed the cache over its limit in the first place — so the next visit re-read the same directory, restored the same chats, exceeded the limit again and evicted again, indefinitely. The project being loaded is now held back from eviction, so the cap bounds growth without ever costing a repeat read.
- **The project picker could block the editor, and could list projects in the wrong order.** Refreshing the picker checked whether each of up to 100 remembered project folders still existed using blocking calls on the extension host's single thread — one folder on a disconnected network share was enough to freeze the window for seconds. Those checks now run concurrently and without blocking. Separately, two projects opened within the same millisecond tied on their "last opened" timestamp and were ordered arbitrarily, so "most recently used" could name the wrong one; the newly-used project is now always ordered strictly ahead of everything already recorded.
- **Reading a truncated log could start with a garbled character.** Tailing a background process's log cuts at a byte offset, which lands mid-character whenever that offset falls inside a multi-byte UTF-8 sequence, putting a replacement character (`�`) at the top of the output. The partial character is now skipped.
- **A `delegate_research` sub-agent could run on a different model than the turn that delegated to it.** The model picker sends its choice with the request itself, so the sub-agent — which read the saved setting instead — could run on the previous selection, while its tokens were still billed into the delegating turn's total. It now always runs on the model that turn is actually using.
- **Fallback notices vanished from a restored chat.** When `navy.providerFallbacks` engaged, the notice naming which provider took over was streamed into the reply but never saved with it — so the record of which account was billed for that turn disappeared on the next window reload. It is now persisted alongside the reply.
- **Cost estimates now cover current models and price Gemini by generation.** GPT-5, o3, and o4-mini had no entry at all and showed no dollar figure; a single Gemini Flash rule meant a Gemini 2.x turn was priced at 1.5-era rates. Unversioned or unrecognised Gemini names still fall through to the older rule rather than being assumed to be the newest. As before, an unrecognised model shows token counts with no dollar figure rather than a guess.
- **The diff renderer's shortest-edit-script search was slower and heavier than it needed to be.** It kept its per-step state in plain objects keyed by frequently-negative integers — which drop straight into dictionary mode, so the innermost loop was doing hash lookups — and copied that object once per step, making the whole search grow quadratically in allocations. It now uses a flat typed array updated in place, with only the live band retained for backtracking. Output is unchanged: verified identical to the previous implementation across 3,000 randomised comparisons, with the resulting edit script checked to actually reconstruct both versions.

- **Cards rendered above the work they described.** Tool cards — a terminal card, a diff awaiting approval, a command approval, the run-project card — were attached to the transcript as siblings *after* the assistant's message, while the model's text and its activity log were attached *inside* it. Because the message element already existed, everything written afterwards rendered ABOVE the card: run a command and explain the result, and the explanation appeared over the terminal card; a turn whose first action was a tool call showed its summary above the work it was summarising. All of these now sit at the point in the transcript where they actually happened, and a turn reading text → command → text → tools → summary renders in exactly that order.
- **A second command in flight broke the first one's card.** Terminal cards were tracked in a single "current card" slot, and live output carried no indication of which command produced it. A background task — which runs its own agent loop alongside the main chat — sending a command's output therefore wrote it into the main chat's card, and starting a second command left the first stuck at `running…` with nothing able to finish it. Output now carries the id of the call that produced it, each command owns its own card, and output belonging to something not on screen goes to the shell panel instead of contaminating an unrelated card. Pressing Stop closes every card still open, not just the most recent.
- **Long command output silently lost its error highlighting.** Trimming a terminal card to its size cap replaced the whole block with plain text, which discarded the markup distinguishing stderr — so once a command printed enough, every previously-red line became indistinguishable from ordinary output. Trimming now drops whole leading lines and leaves the rest untouched. Command output also gained a copy button; it was the one block in the transcript with no way to copy it.
- **Switching tabs abandoned work that was still running.** Tabs clear the view, but the work underneath continues — and nothing re-announced it, so returning to a tab showed a running dev server with no card and no Stop button. Worse, a background task's card is only created when the task starts, so after a switch every later message from it was discarded: including its final answer, which was simply never displayed. Navy now re-announces everything still running in a chat when you return to it — the dev server (with its URL), background tasks (with their original prompt), and background processes (with what they have printed so far) — and the cards additionally rebuild themselves if an update arrives before that.
- **A background process that finished out of view reported nothing.** If the panel had been cleared, the exit status was dropped, and any later output brought the panel back marked `running` for a process that had already exited. Background process panels also had no stop control at all, unlike background tasks, so a stray server started by `start_process` could only be stopped by asking the model to do it.
- **A tool result could be attached to the wrong row.** When a model reports tool calls as text rather than through the provider's tool-calling API, results arrive without an id, and the result was applied to whichever row was created last — wrong whenever several read-only tools were running in parallel, since they finish out of order. Results without an id are now matched to the oldest still-running row for the same tool.
- **The diff card told you to use the editor and gave you no way to get there.** A large change is truncated in the card with a note pointing at the editor's diff view, but nothing in the card opened anything. The filename is now a button that opens the file. Separately, an arriving edit card no longer overrides your scroll position — it was the only thing that did, and it yanked you to the bottom precisely while you were reading back through the context needed to judge the edit. The pending-approval list is now clickable, so a card you have scrolled past is one click away.
- **Copying a reply also copied the model's hidden reasoning.** The chat keeps `<think>` reasoning behind a collapsed dropdown, but the copy button handed over the raw text including those blocks and everything inside them.
- **Restoring a chat dropped the attachments from your own questions.** Attachment names and image counts were rendered when you sent the message and then discarded, so reopening a chat showed a question that hinged on an attached file as though it had been asked with no context. Both are now saved with the message and shown again on restore.
- **Reopening a long chat rendered every message at once.** The transcript has no virtualisation, so a project with hundreds of turns paid the full parse and layout cost before the panel became usable. A restore now renders the most recent stretch, with a "Show N earlier messages" control for the rest.
- **Restarting the dev server piled up dead cards.** Only a *live* run-project card was replaced when a new server started, and stopping one had already discarded that reference — so every stopped server left its card behind, one per run, for the life of the conversation. A new server now supersedes the old card. Output arriving after a crash is also kept rather than dropped, since those are the lines that explain why it died.

### Security
- **`fetch_url` validated a hostname and then let the connection resolve it again independently.** The address check and the connection performed two separate DNS lookups, so a hostname backed by a short-TTL record could answer with a public address for the check and a private one for the connection that followed — the classic DNS-rebinding pattern, and precisely the case a name-based blocklist cannot see. `fetch_url` now resolves the hostname once, validates *every* address it returns (a name answering with a mix of public and private addresses is refused outright), and pins the connection to the address it validated, so what was checked is provably what gets dialled. This required moving off `fetch()`, which offers no way to control address resolution; the request's `Host` header and TLS certificate/SNI validation are unchanged, so pinning changes only which address is contacted, never who the server must prove itself to be. Redirects are still followed manually and re-validated at every hop.

### Known limitations
- **Docker sandboxing (`navy.sandboxMode`) works on macOS and Linux hosts only in this release.** On a Windows host, Navy writes commands in cmd.exe dialect and runs them through `cmd /c`, which does not exist inside a Linux container, so every sandboxed command fails. Leave the setting `off` on Windows; it is off by default. Making it work there needs the in-container invocation and the shell dialect Navy instructs the model to use to switch together, which is deferred rather than rushed.

## [0.2.5] - 2026-07-28

### Added
- **Semantic codebase search** — `find_relevant_files` was pure keyword/ripgrep matching, so a query sharing no literal words with the target file (e.g. "how do we track a logged-in user" for a file called `session-store.js` that never says "logged in") could only be found by luck. Opt in with `navy.embeddingModel` (empty by default — zero behavior change unless set): Navy builds a per-file embedding index, persisted and updated incrementally in `.navy/embeddings.json` (only new/changed files are re-embedded, not the whole repo each time), and blends cosine-similarity results into the existing keyword ranking — a file matching on both gets a bonus, a semantic-only match is added as a new candidate above a similarity floor, keyword-only search is completely unaffected when unset. Works with any embeddings-capable model for the active provider (Ollama's native `/api/embed`, or the OpenAI-compatible `/embeddings` endpoint for OpenAI/Gemini/others) — a provider that doesn't actually support it just fails the request and semantic search silently disables itself for the session.
- **Inline completions: separate fast model + real fill-in-middle context** — `navy.inlineCompletions` reused whichever model `navy.model` was set to, so a large chat-quality model made every keystroke wait on chat-turn latency, and completions only ever saw code *before* the cursor, not after — routinely producing edits that duplicated or contradicted the next line. New `navy.completionModel` setting points completions at a separate, faster model (e.g. a small local Ollama model) without touching the main chat model. Completions now also send up to 20 lines of code *after* the cursor as fill-in-middle context (native `suffix` support for Ollama; explicit BEFORE/AFTER framing for Anthropic and OpenAI-compatible providers), with automatic trimming if the model echoes part of that trailing context back into its completion.
- **Eval harness (`npm run eval`) — capability measurement, not just mechanism tests.** The 300+ unit tests all mock the model and assert that Navy's *machinery* works; every one can stay green while Navy gets worse at actually coding, and until now the only signal that something had regressed was a user hitting it. The new harness drives the real agent loop against a real model in a real temp repo and scores by inspecting the files that ended up on disk — several tasks execute the resulting code, because "it parses" and "it works" are different claims. ~24 tasks across nine categories drawn from failure modes actually observed in the wild: describing an edit that never lands, rewriting a whole file for a one-line change, corrupting JSON, editing the wrong file, creating files it was told not to, deleting things nobody asked it to. Crucially it separates **FAIL** (the model got it wrong — the real signal) from **ERROR** (bad key, rate limit, network), so a provider outage is never scored as a capability failure, and a run containing errors is reported as INCOMPLETE with a distinct exit code. Results are saved per run and `--compare` diffs two runs down to just `FIXED` / `REGRESSED`, which is what makes it possible to tell whether a prompt change actually helped. `npm run eval:selftest` validates the checkers themselves without any model calls — each one is proven to both pass a correct outcome and fail a wrong one, so a checker that can't actually detect failure can't silently inflate a score. Not shipped in the extension package. See `eval/README.md`.
- **`check_syntax` tool — verification that doesn't depend on the user's installed extensions.** Navy's "never finish with unresolved errors" rule was only actually enforceable for TypeScript/JavaScript: it read `vscode.languages.getDiagnostics()`, which returns an empty list both when a file is genuinely clean *and* when no language extension is installed for that file type — so editing a `.py`/`.go`/`.rs`/`.c` file with no extension installed reported "no errors" and the agent finished happily on a possibly-broken file. The new tool runs a real parser instead: JSON parsed in-process (with the failing line located even when V8's message carries no position at all), JavaScript via `node --check` (with an ES-module retry so `import`/`export` in a `.js` file isn't a false failure), and Python/TypeScript/Ruby/PHP/Bash/Go/Rust via their own toolchain when installed. It reports three clearly distinct outcomes — **VALID**, **SYNTAX ERROR** (with line numbers), or **COULD NOT VERIFY** — and never reports a file as clean merely because no checker was available.

### Changed
- **Post-write verification no longer mistakes silence for success.** After every edit, if no language extension reported diagnostics, Navy now runs the cheap always-available checks itself (JSON parse, `node --check`) and surfaces a hard failure if the edit broke the file; for file types it can't check, it explicitly reports `[SYNTAX UNVERIFIED]` rather than saying nothing, so the model can't read an empty result as confirmation. `get_diagnostics` returning nothing now says so plainly instead of "No diagnostics (no errors or warnings)". Expensive external toolchain checks stay opt-in via the tool, so this adds no per-edit latency.
- `check_syntax` and `get_diagnostics` are excluded from tool-call deduplication — verify, fix, re-verify is the correct workflow, and deduplicating the second check returned a stale "content unchanged" answer that told the model its fix hadn't landed (or that a broken file was still fine).

### Security
- **`check_syntax` could execute code from the repository it was inspecting.** The Python checker ran `python -m py_compile` with the working directory set to the project root, and `-m` places the working directory first on `sys.path` — so a repository containing a top-level `py_compile.py` had that file executed instead of the standard-library module. The TypeScript entry had the same shape: `npx tsc` resolves and runs `<repo>/node_modules/.bin/tsc`, a binary shipped by the repository. Because `check_syntax` has no approval prompt and the tool rules encourage calling it after edits, simply opening an untrusted project and asking about a `.py` file was enough. Fixed with three independent guards: Python now runs in isolated mode (`-I`, which ignores the working directory, `PYTHON*` environment variables, and user site-packages), every checker now runs with its working directory *outside* the project, and the entries that could not be made parse-only were removed — `npx tsc` (executes repo binaries; also never actually spawned on Windows) and `rustc --emit=metadata` (macro-expands, so `include!()` could read files outside the workspace and echo them into the model's context).
- **Declared workspace-trust and virtual-workspace support.** The extension shipped with neither, so VS Code kept Navy fully enabled in a window the user had explicitly marked untrusted — which is what made the issue above reachable. Untrusted workspaces are now declared **limited**: Navy still opens and can read files and answer questions, but every path that executes code or sends code off the machine — shell commands, tests, run-project, background processes, language toolchains, MCP servers, and embedding upload — refuses at runtime, and the panel says so plainly instead of leaving the user to discover it one refused tool at a time. (Declaring these unsupported outright was tried first and is wrong: VS Code then never activates the extension while still contributing the view container, so the Navy panel renders as an empty box with no explanation — indistinguishable from a crash.)
- **The semantic index uploaded whatever it found, including secrets.** With `navy.embeddingModel` set, the indexer sent the head of every matching file to the configured embeddings provider — and the extension list includes `.json`, `.yml`, `.toml`, and `.sh`, so `docker-compose.yml`, `serviceAccount.json`, and gitignored local config were all in scope. Files whose names look credential-bearing are now excluded outright, anything the repository gitignores is skipped (using `git` itself, so real `.gitignore` semantics apply), and the setting's description now states plainly that enabling it sends file contents off the machine, with a pointer to local Ollama embeddings for an on-device alternative.
- **Inline completions could stream any open file to a provider.** The completion provider was registered on `{ pattern: '**' }` with no scheme or containment check, so opening `~/.aws/credentials` or a `.env` file and typing a single character sent its surrounding text to the configured provider — and this release had roughly doubled that payload by adding post-cursor context. Completions are now restricted to real on-disk files inside the workspace, with the same credential-name filter applied.

### Fixed
- **The panel could freeze permanently while rendering a reply — the long-standing "Navy randomly freezes" bug.** `renderBlockMarkdown` walks a reply line by line, and each branch is responsible for advancing the line index. The paragraph branch — the fallthrough that catches everything the other branches decline — refused any line starting with `|`, on the assumption the table branch would take it. But the table branch only claims a line whose *next* line is a separator row (`|---|---|`). A line beginning with `|` with no separator after it therefore belonged to no branch at all: the index never advanced, and the `while` loop spun on the same line forever. Not slow — non-terminating. The renderer thread was gone, taking the entire panel with it, with no error, no log, and nothing to do but kill the window. The trigger is unavoidable rather than exotic: replies are rendered live as they stream, and **every** markdown table passes through a state where its header row is the last line received, for as long as it takes the separator row to arrive. Whether a render tick happened to land inside that gap decided whether Navy froze — which is exactly why it appeared random and was never reproducible on demand. Tables are common in the kind of long, structured answer `/review` produces, which matches where it was hit most. Fixed at two levels: the paragraph branch now consumes its first line unconditionally (that line has already been declined by every branch above, so nothing else can claim it), and the loop now carries an unconditional progress guard, so any future branch that fails to consume a line costs one mis-rendered line instead of the whole panel. Regression tests render every prefix of a table-bearing review answer — the tick can land on any of them — and run in a separate process with a timeout, because a returning infinite loop would otherwise hang the test suite instead of failing it.
- **Hallucinated file edits could slip past the anti-hallucination guard entirely** — the guard was double-gated: the user's prompt had to name a specific noun ("file", "script", a filename, …) AND the model's reply had to put a completion verb next to that same noun on one line. Real phrasing like "edit the hello world to hello job!" names *what* to change, not the word "file", so the prompt gate silently never opened; a small model (seen live: `deepseek-r1:7b`) then fabricated a full markdown "File Edit Summary" (heading, file path, before/after content, "Result: ... has been successfully updated") without ever calling a tool, and the editor never changed. The prompt gate now triggers on any action verb (not a closed noun list), and the completion-claim detector recognizes narrative "has been successfully updated" phrasing even when it's on a different line from the file reference — the exact shape a fabricated summary block takes.
- **Edits could rewrite far more of a file than actually changed** — nothing in the system prompt told the model to keep an `apply_edit` search block scoped to just the changed lines, so a 3-line fix could come back as a full-function or full-file rewrite. `apply_edit`'s description and the workflow rules now explicitly require the smallest tool for the job (`edit_line` for one line, a tightly-scoped `apply_edit` search for a few contiguous lines, `write_file` only when most of the file is genuinely changing) with a concrete tripwire against padding the search block with unchanged context "just to be safe."
- **Raw markdown was visible for the entire duration of every streaming reply** — `**bold**`, `# headings`, and code fences showed as literal characters while streaming and only snapped into formatted HTML once the response finished. Formatted markdown now renders live, throttled to at most once per 150ms regardless of how fast the provider streams — looks live to a human reader without re-parsing the whole growing response on every token (the throttle also fixes the per-chunk `parsePlanSteps`/`<think>`-tag regex scans re-running on the entire accumulated text on every single chunk, which got slower as a reply grew longer).
- **Tool-call cards could get silently corrupted** — when a call was deduplicated, blocked after repeated failures, or hard-capped, its result had no matching `toolCall` message and got written into whatever OTHER tool's card happened to be on screen last; concurrent (parallel read-only) calls could also finish out of order and overwrite the wrong row. Every tool call/result pair is now tagged with a shared id so a result always updates its own card, never a neighbor's.
- **Apply button marked every code block in a reply "Applied," not just the one clicked** — a reply with two files, approving one, showed both as applied even though only one was written. The confirmation now only flips the button that's actually mid-apply and matches the reported file path.
- **Clear Chat left run-project/background-task references dangling** — a `/run` dev server or `/bg` task kept running and posting updates after Clear, but the webview's references to their cards were never reset, so updates either wrote into detached DOM nodes or (for the run-project card, which has no lazy-recreate path) vanished from the UI entirely even though the process was still alive. Clear now resets those references, and the run-project card is recreated immediately after a clear if the server is still running.
- **Stop left Approve/Reject buttons stuck and dead** — cancelling pending approvals (Stop or Clear) resolved the promises directly without ever telling the webview, so a "Run this command?" or legacy apply card stayed visibly clickable but functionally inert. Cancellation is now routed through the same resolution path a real rejection uses, so the card always gets notified.
- **`--accent`, `--fg`, and `--mono` CSS variables were used but never defined** — the attach button's hover color silently never changed, and background-task/process log output rendered in the proportional UI font instead of monospace. Added as aliases of the existing `--gold`/`--text`/editor-font variables.
- Commit/PR/Run Tests buttons had no protection against rapid double-clicks (they launch a native VS Code dialog with no webview-visible busy state to key off), firing duplicate requests with no feedback — now briefly disabled after a click.
- Approve/Reject buttons on diff and command-approval cards could be pushed off-screen (with a horizontal scrollbar on the whole chat pane) at narrow sidebar widths — they now wrap onto their own line instead of overflowing.
- Token count and context-usage bar kept showing numbers from the deleted conversation after Clear Chat instead of resetting.
- **WSL detection reported success when there were no distributions installed.** `_detectWsl` ignored `wsl.exe`'s exit code, so on a machine with WSL present but unprovisioned, the "no installed distributions" message printed to stdout was parsed *as the distribution list*. Navy then told the model WSL was available, and the fallback rule sent it retrying every missing Unix tool through a `wsl` prefix that could never work. The exit code is now checked, and output that doesn't look like a distribution name is discarded.
- **Concurrent `find_relevant_files` calls re-embedded the entire repository twice.** The tool is read-only, so two calls in one iteration run in parallel; both computed the same "needs embedding" set because neither had written results yet. Beyond the doubled cost, a rate-limit triggered by the doubled burst would latch the "embeddings unavailable" flag and silently disable semantic search for the rest of the session. Concurrent callers now share one in-flight indexing run.
- **A malformed embedding response could disable semantic search permanently.** The response check counted items but never verified each carried an actual embedding, so `undefined` could be cached as a file's vector — after which every similarity comparison threw, and the unchanged mtime meant that entry was never re-embedded. Both the provider module and the index writer now reject unusable vectors.
- **The embedding cache could freeze the UI.** It was serialised at full float precision with no size ceiling; `JSON.stringify` and the matching parse both run synchronously on the extension host thread, so a large repository produced a multi-tens-of-megabyte write after every index update and again on the next session's first search. Vectors are now stored rounded (no measurable effect on ranking) and the cache is skipped past a size ceiling rather than written.
- **`check_syntax` read files with no size limit**, so a large data file in the repository could exhaust the extension host's memory before any parser saw it. Now capped, with an explicit "could not verify" result past the limit.
- **Every write to a file type Navy cannot check emitted a "syntax unverified" warning** telling the model to call `check_syntax` — which then answered "could not verify", because no checker exists for that type. Writing several `.md` or `.css` files burned iterations on an errand that could not succeed. The nudge is now sent only for types that actually have a checker; types with none stay silent.
- Streaming replies rendered Copy and Apply buttons on completed code blocks before any click handlers were attached, so clicking Apply mid-stream did nothing. Introduced by this release's live-markdown rendering.
- Opening a project folder compared paths case-sensitively on Windows, so a folder already in the workspace could be offered as a new one.
- **A turn's closing summary rendered above the work it described.** Every piece of assistant text in a turn — the opening line and the final report — accumulated in a single bubble that sits above the activity log, while all tool cards appended below it. So a turn that said "I'll read the file", ran a dozen tools, then wrote its summary displayed as: intro, summary, then the work that happened between them. Read top to bottom nothing followed the tool activity, which made a completed turn look like it had stopped without reporting anything. Text written after tool activity now opens its own bubble below that activity, so the transcript reads in the order things actually happened. Related: a reply that rendered to nothing used to delete the entire message — taking every tool card with it, despite a comment claiming the cards survived; now only empty bubbles are dropped and the message is discarded only when genuinely nothing remains.
- **Reading one ordinary file took a handful of turns.** `read_file` cut off at 500 lines, so any real source file came back truncated and the model had to finish the job with `read_lines` — and with no guidance on range size it picked cautious ~200-line windows, spending a full round-trip on each. A 1526-line file cost roughly seven tool calls before any work began, eating into the per-turn iteration budget and making Navy look like it was stalling. The line cap is now 1500 (the character cap, which is what actually bounds context cost, is unchanged and still does the real limiting), the truncation notice reports the exact range that was shown, and it hands back the precise `read_lines` call to make next so continuing costs one call instead of several. Same file now: two calls.
- **A failed background turn could take down the extension host.** Three turns are started fire-and-forget — draining the queued-message backlog, PR Review, and Explain Terminal Error — and none carried a `.catch()`. Nothing upstream can catch a rejection from a call that was never awaited, so any failure inside those turns became an unhandled promise rejection at the process level: Navy dying mid-task with no message, no error card, and the composer left permanently disabled because the busy lock was never released. All three now report through a single handler that logs the cause, surfaces it in the chat, and always clears the busy state.
- **Fenced-code matching could hang on pathological model output.** The code-fence regexes in the renderer and the edit extractor both combined an unbounded `` `{3,} `` with a backreference to it, which backtracks quadratically over a long run of backticks — measured at 227ms for 20 000 backticks, 3.6s for 80 000 and 14.5s for 160 000, on a regex that runs for every render of every reply. Fence length is now capped at 8 (real fences are three or four), which makes the pathological case constant-time while every legitimate fence form — plain, language-tagged, `language:path`, and four-backtick fences wrapping three — parses byte-for-byte identically.
- **Long replies could freeze the Navy panel.** This release's live-markdown streaming re-parsed the *entire* accumulated reply and replaced the whole message bubble's HTML on every 150ms tick — work that grows with the reply. Measured: a 62 KB reply produces 131 KB of HTML, re-parsed, re-styled, re-laid-out and repainted several times a second, and the per-render cost rose linearly (roughly 14ms → 75ms of parse alone, before any layout). Once a single render exceeded the interval, renders queued back-to-back and the panel stopped responding to clicks and scrolling while the editor itself stayed fine. Two fixes: the throttle now adapts to what rendering actually costs, so the render loop can never occupy more than about a quarter of the time; and past ~20 000 characters, streaming switches to plain text (one text write, no HTML parse or layout) with the full markdown render still happening once when the turn ends. A stalled webview writes nothing to the extension host log, which made this class of problem nearly undiagnosable from the outside, so the panel now watches its own event loop: any stall over a second is reported to the "Navy Coder" output channel with how long it lasted, what the panel was doing immediately beforehand, and how large the DOM had grown — and the channel reveals itself the first time it happens, so an intermittent freeze leaves evidence instead of vanishing.
- **A single broad search could freeze the entire editor.** When `search_files`/`search_codebase` produced more output than the 60 KB cap, the overflow handler truncated the buffer back to exactly the cap and killed ripgrep — but nothing recorded that the kill had already been issued, so every subsequent chunk still in flight re-tripped the same branch and killed again. Measured on a real run: **over 30,000 kill attempts from one search**. Each was a *synchronous* `taskkill` on the extension host thread, so the editor stopped responding entirely — this is the "VS Code froze, I can't interact with anything" failure, and it has been present since the search tooling was introduced (it is not new in 0.2.5). Fixed on both sides: the overflow branch now fires exactly once, and process termination no longer blocks at all — `execSync` has been removed from the extension entirely, since every child process here is launched from the thread that draws the UI.
- **Multi-step turns could freeze or crash the extension host.** The syntax checker's timeout timer was never cleared, so every check left an armed timer that fired later and killed a process that had already exited long ago. On Windows that kill is a *blocking* `taskkill` on the extension host's main thread, and since the post-write check runs after every edit, a turn with a dozen-plus steps queued up dozens of them — firing in bursts and stalling the UI until VS Code gave up on the extension. A stale kill was also targeting a PID that the OS may already have reused, so it could have terminated an unrelated process. The timer is now cleared as soon as the checker finishes, and the timeout path additionally refuses to kill anything that has already completed. The same never-cleared-timer pattern in the PATH-availability probe and the WSL detection was fixed alongside it.
- **Edited files sometimes showed a diff card with no diff in it.** Two compounding causes, both in the large-file path. The LCS differ bails out above roughly 633 lines, and the sequential fallback it falls back to emitted *every* unchanged line into the renderer's 400-row budget with no context filtering — so on a big file, a change past the first 400 lines produced a diff body containing no changed rows at all. Then, on resolution, the card decided whether to keep its body by counting `.diff-added`/`.diff-removed` elements *in the DOM*, saw zero, and deleted the body outright — turning a real edit into a card with nothing in it. The fallback now shows only changed lines ± 3 lines of context (matching the main differ), so the row budget is spent on the actual change instead of leading context, and resolution uses the real change counts recorded at render time rather than re-deriving them from however many rows survived truncation. A genuinely empty diff still collapses as before.
- **The chat didn't link to the project you just opened — you had to fix it by hand.** Two causes, both fixed. Choosing "open here" persisted the *new* project's path into the *old* project's `.vscode/settings.json` (settings are written at workspace scope, and the write happened before leaving that workspace), so reopening the old project later pointed Navy at a folder that wasn't even open. And a saved root was trusted purely because the path still existed on disk, with no check that it had anything to do with the folders open in this window. Navy now skips that write when it's about to replace the window, and ignores any saved root that isn't one of the current workspace folders (or inside one) — so a freshly opened project links up on its own, while a deliberately chosen sub-folder root inside the open project is still honoured. This also self-heals settings already poisoned by the previous behaviour.
- **Opening another project from Navy silently did nothing to the editor.** With a folder already open, picking a new project passed a bare `Uri` to `updateWorkspaceFolders`, which requires `{ uri }` objects — VS Code rejected the call and returned `false`, so the folder was never actually added. The return value was never checked, so Navy set its own project root and reported success while the editor stayed on the old project: the picker claimed a project that was never opened. The call now uses the correct shape, a rejected add is surfaced as an error instead of a false success (and no longer moves Navy's root to a folder that isn't open), and — because "open another project" reasonably means either thing — Navy now asks whether to **Open Here** (replace the current project, like File → Open Folder) or **Add to Workspace** (keep both and switch between them from the picker) rather than silently converting the window into an untitled multi-root workspace. The picker entry is now labelled "+ Open project…". Opening a project is also refused while a turn is in flight, matching the existing guard on the project dropdown — tools resolve paths against the active root as they run, so switching mid-turn could land edits in the wrong repository.
- **Commands could be run blind to the actual OS/shell** — the system prompt only told the model the OS family ("Windows"), never which shell `run_command` actually executes through (always `cmd.exe`, never PowerShell) — a model reasonably assuming PowerShell would write `Get-ChildItem`/`$env:VAR`-style commands that fail under cmd.exe in a way that looks like "doesn't know its own OS." It also only got OS info at all when a project folder was open. The environment block is now always included (project or not) and states the exact shell and its dialect explicitly. Added a workflow rule to check third-party CLI tools (`git`, `rg`, `docker`, …) are actually on PATH before depending on them — with `where <tool>`/`command -v <tool>` — while shell builtins never need checking; a command that still fails "not recognized"/"command not found" now gets a targeted "this is a PATH problem, not a code bug" hint instead of the generic "diagnose and fix the code" one.
- **No WSL fallback on Windows for Unix-only tools** — a tool like `gcc` with no native Windows build (common for compiler/build toolchains) would just fail with no path forward, even when it's available inside WSL. Navy now detects installed WSL distros once per session (cached, ~a few hundred ms, never repeated) and states their availability in the environment block; the model is instructed to fall back to `wsl <command>` for a missing Unix-only tool, with the Windows→WSL path conversion (`C:\foo\bar` → `/mnt/c/foo/bar`) called out explicitly.

## [0.2.4] - 2026-07-19

### Added
- **Native Gemini provider path** — Gemini 2.5/3.x models always attach a `thoughtSignature` to tool calls and Google requires it echoed back, a field the OpenAI-compatibility shim has no way to carry (this was the "Function call is missing a thought_signature" error). Those specific models now route through Gemini's native streaming API with full thought-signature round-tripping; older/non-thinking Gemini models (1.5, 2.0-flash) are untouched and keep using the proven shim.
- **MCP streamable-HTTP/SSE transport** — `navy.mcpServers` entries can now be `{ "name": { "url": "https://..." } }` for a remote MCP server, in addition to the existing local `{ "command": ... }` form. Handles both JSON and SSE response modes and session-id propagation per the MCP spec.
- **`search_docs` tool** — searches the project's own README/CHANGELOG/CONTRIBUTING/`docs/**` for a term, so the agent checks existing documentation before guessing at conventions or setup steps.
- **Interactive plan checklist** — when the model states a `**Plan:**` for a multi-step task, it now renders as a live checklist card (pending → active → done) instead of plain text, with steps ticking off as the agent works through them.
- **Weak-model prompt reinforcement** — models whose name suggests a small/local model (parameter-count tags like `:7b`, or `mini`/`nano`/`tiny` branding) get an extra, maximally explicit restatement of the anti-hallucination rule appended to their system prompt.
- **OpenRouter model dropdown grouped by vendor** — "vendor/model"-style lists now render as `<optgroup>`s (openai, anthropic, google, …) instead of one long flat list; ordinary provider lists are unaffected.

### Fixed
- **Hallucinated file actions** — small/local models that can't reliably emit tool calls would fall back to plain chat behavior: print code, then say "done, file created" without ever calling a tool, and Navy trusted that claim. Navy now detects a false completion claim (a description of a file being created/saved/updated with no tool call this turn AND only when the user's request actually asked for a file action, to avoid false positives on Q&A), gives the model one correction chance to actually call the tool, and — if it still can't — shows the user a clear warning instead of silently displaying a lie. The system prompt also now explicitly forbids claiming a file action without calling the corresponding tool.
- **`navy.systemPrompt` was a dead setting** — visible in Settings, saved, but never actually sent to the model. Now wired in as a genuine "user preferences" section appended after the mandatory tool-use rules (so it can't override them). The legacy default value (pre-agentic-loop SEARCH/REPLACE instructions, which directly contradicted the fix above) is no longer shipped or sent.
- **Removed a fictitious default model** (`kimi-k2.7-code:cloud`) that most users don't have pulled — `navy.model` now defaults to empty and auto-selects the first real model for whichever provider is active, the same self-healing path already used when switching providers.
- **Infinite edit loop on the same file** — a model could get stuck re-editing one file dozens of times in a single turn (seen live as 16+ consecutive "✓ Applied" cards for the same file with no end in sight). Root cause: fresh LSP diagnostics were unconditionally re-injected after *every* write with no cap, so if a fix never fully resolved the diagnostic it was chasing, the model just kept "fixing" it forever. Navy now tracks edits-per-file within a turn: a stern one-time nudge to stop and finish() fires at the 5th edit, diagnostics stop being fed back after that (removing the likely driver of the loop), and any further write to that file past the 10th is hard-blocked for the rest of the turn with a clear explanation. Verified end-to-end: nudge fires exactly once, diagnostics go silent, the 11th attempt is blocked and never touches the file, and the turn still reaches a normal finish instead of running to the iteration cap.
- **MCP tool calls no longer silently dropped** for models using the JSON-fallback parsing path (small/local models) — the fallback only recognized Navy's built-in tools by name, so a valid `mcp__server__tool` call was discarded.
- **Anthropic prompt caching has a safety fallback** — if a proxy or API version rejects the `cache_control` field, Navy now retries once without caching instead of failing the turn; an unrelated 400 is never masked by this retry.
- **Newest Claude models (e.g. claude-opus-4-7) rejected every request** — those generations dropped the legacy `thinking: {type:'enabled', budget_tokens}` shape and `temperature` entirely, wanting `thinking: {type:'adaptive'}` + `output_config.effort` instead, so every message 400'd. Rather than hardcode which model generation needs which shape (guaranteed to go stale the moment Anthropic ships another one), Navy now detects these two error signatures at runtime and retries once with the adaptive shape — same pattern as the existing cache_control fallback. An unrelated 400 is never masked by this retry.
- Background-task (`/bg`) error messages now show the provider's proper name ("OpenAI") instead of the raw setting value ("openai") — the display-name map existed in only one of the two error paths.

### Changed
- `_rawBlocks` (thinking/tool-use replay state) is now tagged with its producing provider — prevents a latent bug where switching providers mid-conversation (e.g. Gemini-thinking → Anthropic) could replay one provider's raw blocks into another's request.

## [0.2.3] - 2026-07-18

### Added
- **MCP client** — Navy can now use external MCP (Model Context Protocol) tool servers, the same ecosystem Claude Desktop/Cursor/Roo use. Configure `navy.mcpServers` (Claude Desktop format: `{ "name": { "command": …, "args": […] } }`); each server's tools appear to the agent as `mcp__<server>__<tool>`, approval-gated in ask mode, hot-reloaded when the setting changes. Stdio transport, tools-only, failures never break Navy.
- **Anthropic prompt caching** — the static prefix (system prompt + tool schemas) and the newest message are marked as cache breakpoints, so multi-step turns on Claude are billed at ~10% for the repeated prefix and stream noticeably faster from the second step on.
- **Real history compaction** — when a long session trims old turns, the model now writes an actual summary of what's being forgotten (decisions, files changed, open problems) instead of a mechanical text clip; falls back to the clip if the summarization call fails.
- **Human-readable errors** — provider failures are classified (rate limit, quota/billing, bad key, context overflow, invalid model, outage, unreachable) and shown as a plain-language explanation with concrete next steps; account identifiers (org/user ids, keys) are redacted before display. A turn that errors after making progress gets a one-click "Continue where it stopped" button.
- **"Navy Coder" Output channel** — best-effort failures (checkpoint persistence, MCP servers, history summarization) are now visible in View → Output instead of vanishing.
- Resize-proof UI: the toolbar wraps instead of clipping on narrow sidebars, the chat stays pinned to the latest message while you drag the splitter, and huge model lists (OpenRouter) get a type-to-filter box; Anthropic model listing follows pagination; saving a default API URL no longer pins it as an override
- Tool arguments are validated against each tool's schema, so a model passing bad parameters gets a clear correction message instead of a cryptic internal error; rejected structural renames no longer leave stray undo entries.

### Changed
- **Dynamic model lists for every provider** — OpenAI, Anthropic, DeepSeek, Gemini, xAI, z.ai, Groq, OpenRouter, LM Studio, and custom endpoints now fetch their available models live from the provider's `/models` API instead of a hardcoded list. New models appear automatically and retired ones disappear, so a provider changing its lineup no longer breaks Navy or hides a model. The curated lists remain only as an offline fallback (no key / unreachable). Fetches are cached 5 minutes; saving settings forces a refresh.
- **Provider API URL auto-fills** — selecting a provider in Settings drops its endpoint straight into the API Base URL box (still editable for a proxy/gateway), so you never have to look up or type the full URL. A saved custom override is preserved on reload.

### Fixed
- **Switching provider no longer 400s on an invalid model** — after changing provider, if the previously-selected model isn't in the new provider's live list (e.g. the old provider's model or the Ollama default), Navy now auto-selects a valid model for that provider instead of sending a model it doesn't have.
- **Tool calls work on more models** — providers that return empty or duplicate tool-call ids (Cohere and others via OpenRouter) were causing `tool call id ... not found in previous tool calls` 400s. Navy now assigns a unique id to every tool call and uses it consistently for the call and its result, fixing the pairing.
- **DeepSeek (and other strict providers) tool calls fixed** — the replayed `tool_calls` were missing the OpenAI-required `type: "function"` field, which DeepSeek rejects with `missing field type`. Navy now emits the complete tool-call shape. Background (`/bg`) tasks get the same normalization.
- **Cleaner model dropdowns** — Gemini ids lose their `models/` prefix, and OpenAI's list is filtered to chat-capable models (no more whisper/dall-e/embeddings in the picker).

## [0.2.2] - 2026-07-17

### Added
- **Codebase retrieval** — a new `find_relevant_files` tool ranks source files by symbol definitions, filename matches, and term frequency (BM25-style saturation) so the agent targets the right files instead of blindly guessing on large repos. On a code-oriented request Navy also auto-injects a ranked shortlist of likely-relevant files up front. Works fully offline, no embeddings.
- **`rename_symbol`** — structural, workspace-wide rename via the language server (updates every reference, leaves matching-but-unrelated text alone), fully undoable. Prefer it over text-replace for renames.
- **Smarter failed-edit recovery** — when an `apply_edit` search string isn't found, Navy now shows the closest-matching region of the real file so the model (especially weaker/local ones) can correct in one round-trip instead of guessing.

### Fixed
- **Small-model support** — models that can't use the native tool-calling API (e.g. qwen-coder-7b) emit tool calls as raw JSON text; Navy now parses those bare-JSON calls so tools actually run, and never renders tool-call JSON as a chat message. Greeting/small-talk prompting tightened so small models stop firing spurious searches.

### Changed
- Webview HTML shell extracted from `extension.js` into its own module; test suite now 81 checks (added retrieval, rename_symbol, edit-recovery, and end-to-end undo coverage through a mock-vscode + real temp filesystem).
- Terminal IN/OUT cards: every `run_command` / `run_tests` gets its own card in the chat — command in, live output out (stderr tinted), status chip (exit 0 / failed / timeout / rejected), long output collapses behind "Click to expand"
- Applied edits keep an expandable diff preview (changed lines in red/green) instead of collapsing to a bare "Applied" line
- `rename_file` tool — moves/renames within the workspace with approval gating
- Ripgrep-backed `search_codebase` / `search_files`: full-tree, `.gitignore`-aware, much faster (JS walk remains as fallback)
- Undo survives window reloads — checkpoints persist per project
- Mid-turn context compaction: long agent tasks prune old tool output instead of overflowing the model's context window
- Automatic retry with backoff on rate limits (429) and transient 5xx errors for all providers
- Restored sessions show a per-turn summary of changed files and commands
- **Redo** — reverse an accidental undo (button next to Undo, `Ctrl+Alt+Shift+Z`); redo history is cleared when new edits land so it can never clobber newer work
- **Transactional undo**: renames and single-file deletions are now undoable too, and undo asks before discarding edits you made by hand after Navy's write
- **Session digest**: long conversations condense their oldest turns into a summary instead of forgetting them
- File writes from the main chat and `/bg` background tasks are serialized — no more interleaved edits to the same file
- Real test suite (`npm test`): 51 checks covering the edit engine, context compaction, markdown rendering, a full simulated webview conversation, and end-to-end undo/redo (rename, delete, multi-edit turns, hand-edit detection) driven through the real provider against a mock-vscode + temp filesystem
- Undo fixes: "Undo Last Turn" now returns files edited multiple times in a turn to their true turn-start content (previously only the last edit was reverted); no more spurious "file was modified" warning on multi-edit undos; undo/redo now go through the write mutex; background-task edits form their own undo group; system-prompt sections are capped so a huge repo/memory can't overflow the context window
- Version number shown on the welcome screen

### Fixed
- "Generate Commit Message" and "Generate PR Description" now work with every provider (previously Ollama-only)
- Stop button shows a proper stop icon and turns red while Navy is working (send/stop icons were rendering stacked)
- Smooth chat motion: entrance transitions for messages and cards, frame-synced scrolling, no more bouncing during streaming
- Stop now also halts tools already queued in the current step (a write could previously still land after Stop)
- Inline code like `snake_case_names` is no longer mangled by italic formatting
- `fetch_url` re-validates every redirect hop (SSRF hardening)
- Token counter works for OpenAI-compatible providers; mid-stream provider errors are reported instead of "No response received"
- Diff and terminal cards no longer collapse into thin lines in long chats (flexbox was crushing overflow-hidden cards)
- False "Navy stopped responding" during long tasks eliminated — the extension heartbeats every 30s and the UI only alarms after 4 minutes of true silence
- Model reasoning (`<think>` blocks) is hidden behind a "💭 Reasoning…" indicator while streaming instead of flooding the chat; finished reasoning stays in a collapsed dropdown
- Model dropdown keeps manually configured model names for cloud providers
- `.navy/` session data is excluded from git automatically

## [0.2.0] - 2026-07-05

### Fixed — data safety
- **Critical:** editing a file larger than 12 KB no longer truncates it — edit paths and undo checkpoints now always operate on the full file contents
- In-chat Approve/Reject buttons on edit diff cards now work (previously only the native toast applied the edit); dismissing the toast no longer stalls the agent
- API keys are stored per provider and are no longer overwritten with a masked value when saving settings without retyping the key
- Fuzzy edits preserve the file's original line endings (CRLF files stay CRLF)
- Deleting folders works (recursive delete, to Recycle Bin) and respects auto-approve mode

### Added
- LSP-backed `find_symbol` and `find_references` tools
- Automatic post-edit verification: fresh diagnostics for every edited file are fed back to the model
- Plan-first prompting: multi-step tasks start with a visible numbered plan
- Real thinking control: Anthropic extended thinking, OpenAI o-series `reasoning_effort`, Ollama `think` for reasoning models
- Web search providers: Tavily and Brave Search (auto-detected by key), DuckDuckGo fallback
- Task report after every run: files changed, deletions, commands with exit status
- Keyboard navigation (arrows / Enter / Tab) in slash-command and @-mention dropdowns
- Whole-message copy button on assistant replies
- Clickable welcome-screen quick-start chips
- First-run welcome notification pointing to the sidebar
- Project folder choice persists across window reloads

### Fixed — reliability & UX
- Clicking the Navy icon now opens the sidebar even before its first use
- Long multi-step tasks no longer abort at exactly 3 minutes
- Same failing command is blocked after repeated failures; duplicate file reads are short-circuited
- Dev servers are no longer duplicated or orphaned; full process-tree kill on stop and on window close
- Welcome screen reappears after "New chat"
- Light-theme support: accents follow the active VS Code theme
- Switching to auto-approve asks for confirmation once
- o-series OpenAI models no longer fail (temperature parameter removed for them)
- Fuzzy matching for `apply_edit` tolerates line-ending and indentation drift

## [0.1.0] - 2026-07-01

### Added
- Activity-bar sidebar with chat UI and streaming markdown rendering
- Multi-provider support: Ollama, LM Studio, Anthropic, OpenAI, DeepSeek, Gemini, xAI, Groq, OpenRouter, custom endpoints
- Agentic tool-use loop: read files, list directories, search workspace, run shell commands
- SEARCH/REPLACE and whole-file edit modes with diff-card approval gate
- Auto-approve mode for unattended file edits
- Inline code completions powered by the configured model
- Background task runner for long-running commands
- Project session persistence and memory panel
- Code lens "Ask Navy" buttons above functions
- Undo last edit / undo last turn commands
- Generate commit message and PR description commands
- Wheel icon with light-blue branding (#58a6ff)
