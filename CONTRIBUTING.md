# Contributing to Navy Coder

Everything here is what someone actually needs to make a change land — the
layout, the rules that aren't negotiable, and the exact set of places you have
to touch for the two most common changes.

## Getting set up

```bash
npm install          # devDependencies only — see the invariant below
npm run check        # parses every JS file under src/ media/ test/ eval/
npm test             # 2,033 tests, no network, no API keys
npm run build        # esbuild bundle into dist/
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with
Navy loaded. Changes to `media/` and `src/webview-html.js` need only a webview
reload; changes to `src/extension.js` need the host restarting.

## Three rules that aren't negotiable

**Zero runtime dependencies.** `package.json` has no `dependencies` key at all,
only `devDependencies`. This is the project's main security claim: the shipped
extension contains no third-party code. If a change seems to need a runtime
dependency, solve it with the Node standard library or stop and say it can't be
done without one.

**Cross-platform, genuinely.** CI runs the full suite on `ubuntu-latest` *and*
`windows-latest` because the codebase has real platform-conditional logic —
`cmd.exe` vs `sh` command construction, `taskkill` vs process groups, Windows
CRT quoting rules, WSL detection. A Linux-only runner would give zero coverage
of any of it. Never write a path that only works on one.

**Comment the *why*, never the *what*.** The most valuable thing in this
codebase is the reasoning recorded next to non-obvious decisions — why a
constant is that number, why a branch exists, what broke that made it
necessary. Match that. Don't reformat code you aren't otherwise changing; the
diff has to stay reviewable.

## Layout

| Path | Lines | What lives there |
| --- | ---: | --- |
| `src/extension.js` | ~7,010 | The agent loop, the remaining tool implementations, session persistence, and the webview host |
| `src/commands.js` | ~560 | Command and process execution: WSL detection, the approval prompt, spawn-and-collect, `run_command`, `run_project`, and the background-process tools |
| `src/trust.js` | ~20 | The one sentence an untrusted workspace refuses with, shared by the two files that need it |
| `src/retrieval.js` | ~860 | Lexical + semantic retrieval, the sharded embedding index, the repo map |
| `src/background.js` | ~300 | Persistent background processes: manifest, logs, pid verification |
| `src/net-safety.js` | ~240 | SSRF defence (address pinning against DNS rebinding) and `fetch_url` |
| `src/sandbox.js` | ~330 | Sandboxing (`navy.sandboxMode`): Docker, and native seatbelt/bubblewrap |
| `src/undo.js` | ~370 | Transactional undo/redo, checkpoints, and conversation rewind |
| `src/projects.js` | ~180 | The global project catalog (`projects.json`) |
| `src/web-search.js` | ~115 | Tavily / Brave / DuckDuckGo backends |
| `src/slash-commands.js` | ~290 | Custom slash commands: the markdown format, where they load from, precedence and the trust gate |
| `src/skills.js` | ~420 | Agent Skills: frontmatter parsing and validation, discovery, the context-budget cap, `activate_skill` |
| `src/paths.js`, `src/workspace.js`, `src/exec.js`, `src/session-context.js` | ~20 each | Small shared pieces several of the above need, extracted so no module has to import its own importer |

Everything from `retrieval.js` down is **mixed into `NavyCoderViewProvider.prototype`** — the methods still use `this`, so the extraction changed no call site and no signature.
| `media/main.js` | ~5,840 | The entire webview: rendering, streaming, cards, markdown, syntax highlighting, dictation |
| `media/styles.css` | ~4,060 | Webview styling, themed off VS Code's own CSS variables |
| `src/providers/tools.js` | ~450 | Tool schemas (`TOOLS`), the API-shaped copy (`TOOLS_API`), and the system prompt (`TOOL_PROMPT`) |
| `src/providers/llm.js` | ~780 | Streaming, tool-call parsing, edit extraction, per-provider request shapes |
| `src/providers/endpoints.js` | ~90 | **Single source of truth** for every provider base URL |
| `src/providers/pricing.js` | ~105 | The cost table, its ordering invariant, and `navy.modelPricing` overrides |
| `src/diagnostics.js` | ~180 | The exportable bug-report bundle, and the redaction that makes it safe to paste |
| `src/plan.js` | ~130 | Task plans: validation, the block the model reads back, the incomplete-plan note |
| `src/providers/errors.js` | ~160 | Error classification — decides both the user-facing advice and whether a failure is fallback-worthy |
| `src/providers/mcp.js` | ~420 | MCP client, stdio and streamable HTTP: tools, resources and prompts |
| `src/providers/embeddings.js` | ~75 | Embedding calls and cosine similarity |
| `src/dictation-bridge.js` | ~400 | Loopback server + browser page for voice input. No pause control — see the file header for why |
| `src/webview-html.js` | ~380 | Builds the webview markup |

`src/extension.js` is still the largest file by a distance, and that is a known
problem rather than a style. It is being broken up one seam at a time; if you
are adding something that could reasonably live in its own module, put it there.

**The extraction pattern.** Move a **contiguous, self-contained** run of methods
into a module verbatim, wrapped in a `class` — a class body and an object
literal differ by a comma after every member, and a move that has to retype
hundreds of lines is not a move. Export `TheClass.prototype`, and mix it back on
with `mixinPrototype` at the bottom of `extension.js` (class methods are
non-enumerable, so `Object.assign` silently copies nothing — the descriptors
have to be copied). The methods keep using `this`, so no call site and no
signature changes.

No dependency injection, no class hierarchy — the codebase uses neither, and a
refactor is the wrong moment to introduce one.

Two things that make a seam fail, both worth checking before you start:

- **Shared module-level helpers.** If the block needs something `extension.js`
  also needs, that thing goes into its own small module (`paths.js`,
  `workspace.js`, `exec.js`, `session-context.js` all exist for exactly this) —
  importing it back out of `extension.js` would be circular.
- **Adjacency that isn't cohesion.** `literalReplace` sat between the relevance
  constants and the embedding chunker and got swept into `retrieval.js` on the
  first attempt; it belongs to `apply_edit`. Check what you actually caught.

One seam that is **not** clean and shouldn't be forced: the tool
implementations as a whole. They are interleaved with their own private
helpers, so lifting them wholesale would separate each tool from the code it
calls. Do it by domain, moving each tool's helpers with it.

The **process tools** were the first domain taken this way, and they are the
model for the rest: `_detectWsl` through `toolKillProcess` turned out to be a
genuinely contiguous run of eleven methods with nothing unrelated between them,
so the whole block moved verbatim into `src/commands.js` along with the two
module-level helpers only it used (`looksLikeMissingPathError`,
`readFileTail`). `UNTRUSTED_REFUSAL` did **not** move with it — `run_tests`
stayed behind and still needs it — so it became `src/trust.js`, which is the
"shared module-level helpers" trap above, met in the wild.

Two things that change when a helper stops being module-level in
`extension.js`: a test that reached it with `extractFunction(extSrc, …)` now
has to require the real module (better anyway), and any structural test that
counted occurrences in `extension.js` has to count across `src/` instead —
`approvalScopeSuite` read three gates moving to `commands.js` as three gates
disappearing until it was widened.

**Verifying a move.** The whole suite passing is necessary but not sufficient —
also confirm nothing was lost or altered:

```js
// every method still on the prototype, and byte-identical to before the move
d.value.toString()  // must appear verbatim in the pre-extraction file
```

## Tests

Two suites, both run by `npm test`:

- **`test/run.js`** — the extension host. Drives the real `NavyCoderViewProvider`
  against a mock `vscode` API (`test/vscode-mock.js`) and a real temp
  filesystem. Some tests extract a single function out of the source and eval it
  in isolation; if you turn a standalone function into one that reads `this`,
  those need a host object (see the `compactMessages` suite). A function that
  starts calling a new module-level helper trips the same wire — the extracted
  copy cannot see it, so pull the real helper into the eval scope rather than
  writing a second one (see `literalReplace` and `_compactMessages`).

  `run.js` is now the running **order** and nothing else. The assertions live in
  `test/suite-*.js`, one file per domain, and the shared machinery — the
  assertion counter, `extractFunction`, the vscode-mock lifecycle, and the fetch
  fakes that stand in for a model — is in `test/harness.js`. It was one 495KB
  file with 54 suites in it, which is the same problem `src/extension.js` has and
  just as unreviewable.

  | File | Covers |
  | --- | --- |
  | `suite-pure.js` | Pure functions and the jsdom DOM checks — no mock, no temp fs |
  | `suite-files.js` | Undo/redo, checkpoints, rewind, syntax checking, path hints |
  | `suite-retrieval.js` | Lexical + semantic retrieval, the embedding index, context budget |
  | `suite-process.js` | Sandboxing, persistent background processes, shell selection |
  | `suite-session.js` | Projects, chats, caches, the global catalog, file watching |
  | `suite-turn.js` | The agent loop: tool batching, plans, ledgers, loop guards, delegation |
  | `suite-providers.js` | Streaming shapes, fallbacks, pricing, endpoint defaults |
  | `suite-mcp.js` | MCP over stdio and HTTP, and its resources and prompts |
  | `suite-approval.js` | Both approval gates, settings defaults, the diagnostics bundle |
  | `suite-ui.js` | Dictation, slash commands, skills, the review regressions |

  The files sit flat in `test/` rather than in a subdirectory on purpose: every
  suite uses `require('../src/...')` and `path.join(__dirname, '..')`, and a
  subdirectory would have meant rewriting all of them — dozens of edits, each a
  chance to break something, in a change whose whole value is that it changes
  nothing.

  **Adding a suite.** Put it in the file for its domain, export it, and add it to
  the chain in `run.js`. Order is load-bearing in one respect: `sharedMock` hands
  every suite the same mock and resets it between them, so a suite that leaves
  state behind is felt by whichever runs next — keep new ones at the end unless
  there is a reason not to.
- **`test/webview-run.js`** — the webview. Loads the **real** `media/main.js`
  into jsdom against the **real** webview HTML, and drives it by posting the same
  messages the extension sends. Nothing is reimplemented, so a passing test means
  the shipped file behaves that way. jsdom has no layout engine, so this catches
  logic and DOM structure, never anything purely visual.

Two more run on demand, deliberately outside `npm test`:

- **`npm run test:vscode`** — launches a **real VS Code** with Navy loaded.
  Downloads ~325 MB of editor on a cold cache and needs a display, which is why
  it isn't in `npm test`. It covers the one thing the mocked suites structurally
  cannot: whether the extension activates at all, whether every command in
  `package.json` has a handler behind it, and whether every declared setting
  resolves with the default the manifest claims — read from the manifest, so a
  new setting is covered the moment it is declared. Both mocked suites can pass
  while the extension fails to load.
- **`npm run test:endpoints`** — real network calls confirming every shipped
  provider base URL is still live, using a deliberately invalid key so no
  secrets are needed. Run it before cutting a release; CI runs it weekly.
- **`npm run eval`** — the real-model harness (`eval/README.md`). CI runs it
  weekly too, against one cheap model, gating on `--fail-on-regression`: a task
  that passed in `eval/results/baseline.json` and now fails. Deliberately not a
  PR gate — it spends money per push, fork PRs cannot read the secret, and a
  nondeterministic model would go red at random until everyone ignored it. It
  skips itself with a notice when `NAVY_EVAL_API_KEY` is unset, because a
  permanently red scheduled job is the same as no job.


**`npm run check`** (`test/check-syntax.js`) parses every JS file under `src/`,
`media/`, `test/` and `eval/`. It used to be `node --check src/extension.js` —
one file of thirty-seven — and `node --check` does not follow `require`, so no
module that file imports was covered, nor `media/main.js`, which ships raw
instead of being bundled. A syntax error there ships a webview that does nothing
at all and the old check passed on it.

It also carries two guards for mistakes that parse cleanly or fail confusingly:

- **A backtick inside `src/webview-html.js`.** That file is one enormous template
  literal, so a stray backtick — most easily inside an HTML comment, where it
  looks like ordinary prose — closes the template and turns the rest of the
  document into broken JavaScript. It has happened three times. The parse catches
  it, but the error points at the word *after* the backtick, so the guard names
  the line and says what actually went wrong.
- **U+FFFD anywhere under `src/` or `media/`.** The replacement character is what
  is left when bytes fail to decode as UTF-8, so nobody types one deliberately —
  finding one means a file went through a lossy encoding round-trip and a real
  character was destroyed. One reached the shipped webview and drew as a
  missing-glyph box on a button. Prose may mention it; code may not.

Running `test:vscode` from VS Code's own integrated terminal works — the runner
clears the inherited `ELECTRON_RUN_AS_NODE`, which would otherwise make the
downloaded editor start as plain Node and reject every flag it is given.

The model is mocked everywhere, so the suite needs no API keys and costs
nothing to run.

## Adding a provider

Six places, and missing any one of them ships something broken. Three providers
have shipped with base URLs that never worked, so the last step is not optional.

1. **`src/providers/endpoints.js`** — add the base URL to `DEFAULTS` in
   `openAiCompatBase`, and a display name to `PROVIDER_NAMES`. If the vendor runs
   separate mainland-China and international endpoints, default to international
   and say so in a comment: a key from the wrong region is rejected exactly like
   an invalid key, which is the single most confusing failure in this product.
2. **`package.json`** — add the id to the `navy.provider` enum and a matching
   entry to `enumDescriptions`. Name the alternate regional URL there if there is
   one.
3. **`media/main.js`** — add an entry to `PROVIDER_DEFAULTS` (base URL, whether
   it needs a key, and the hint shown under the URL box in Settings).
4. **`src/webview-html.js`** — add the `<option>` to the provider dropdown.
5. **`src/extension.js`** — add `MODEL_FALLBACKS` (shown only when the live
   `/models` fetch fails, so the dropdown is never empty) and, if the models have
   a distinctive context window, a `MODEL_CONTEXT` entry. Be conservative with
   context windows: under-stating one costs a little context, over-stating one
   makes requests fail outright.
6. **Verify it.** `node test/check-provider-endpoints.js` must report the new
   endpoint healthy, and `Navy Coder: Test Provider Connection` should give a
   sensible verdict with a real key. A URL that merely *responds* is not
   necessarily correct — MiniMax's old host answers `/v1/models` perfectly and
   rejects every current key.

7. **`src/providers/pricing.js`** — add a `MODEL_PRICING` entry for each model
   family, most-specific-first, each with the `example` model id it exists for.
   `pricingSuite` fails if a broader rule above it swallows that example, which
   is the failure mode that once billed gemini-2.5-flash at 1.5-flash rates
   with nothing to show for it. A hosted provider with no entry is not broken —
   `estimateCost` returns null and the UI says the cost is unknown — but it is
   a worse first impression than a number.

Add a case to `providerEndpointSuite` in `test/run.js` pinning the new default.

## Adding a tool

1. **`src/providers/tools.js`** — add the schema to `TOOLS`. The description is
   read by the model on every turn: say when to use it and when not to, because
   that is what stops it being called wrongly.
2. **`src/extension.js`** — add the `case` to the tool dispatch switch and write
   the `toolX` implementation.
3. **`READ_ONLY`** in `src/extension.js` — add the name if the tool cannot
   change anything. It decides whether the tool can be run concurrently with
   others in the same batch, so getting it wrong is a safety bug, not a
   performance one. Only the *leading* run of read-only calls in a batch is
   hoisted into a concurrent group; a read after a write stays where the model
   put it, because it usually exists to observe that write.
4. **Pick the right approval gate.** A tool that changes files is gated by
   `_editsAutoApproved()` (`navy.approvalMode`); a tool that *executes*
   anything — a command, a process, an MCP call — is gated by
   `_commandsAutoApproved()` (`navy.commandApproval`). Never read either
   setting directly: `approvalScopeSuite` fails the build if any site outside
   the two helpers does, because wiring a new tool to the wrong one is exactly
   how execution came to be governed by a setting labelled "file edits".
5. If the tool touches the filesystem, resolve paths through the existing
   containment helper rather than using the argument directly, and if it spawns
   a process, route it through `_maybeWrapForSandbox` so `navy.sandboxMode`
   covers it too — and build its command through `_shellSpec`/`_shellEscapeArg`
   rather than assuming a dialect, since `navy.shell` decides which one.
6. Add a test to `test/run.js` that exercises it against the temp filesystem.

## Adding a built-in slash command

`SLASH_COMMANDS` in `media/main.js`, and nothing else — the composer owns the
built-in list so the `/` menu works before the extension has answered anything.
Custom commands (`src/slash-commands.js`) are merged in on top and may shadow a
built-in, so check the name isn't one somebody would reasonably want for their
own; if it is, the shadowing is fine and intended, but say so in the
description.

A command whose prompt takes an argument should use `$ARGUMENTS`. Without it,
typed arguments are appended to the end of the template instead, which is a
sensible fallback and a poor design — put the placeholder where the words
belong.

## Adding an icon

Icons are Font Awesome Free paths bundled as an inline SVG sprite — never a
webfont, never a CDN, never an emoji. Three reasons, in order: an emoji is a
fixed-colour glyph the OS chooses, so it cannot follow a VS Code theme and looks
different on every platform; a webfont would need a `font-src` CSP entry and
~400KB for two dozen glyphs, and renders as a missing-glyph box when it fails;
and both leave the panel dependent on something outside the repository.

To add one:

1. Add `navyName: 'fa-icon-name'` to `ICON_MAP` in `tools/build-icons.js`. The
   left side is what Navy calls it — pick the meaning (`refactor`), not the
   picture (`arrows-rotate`), so re-drawing it later is a one-line change here.
2. Regenerate: `node tools/build-icons.js --fa <path to an extracted
   @fortawesome/fontawesome-free package>`. `src/icons.js` is generated and
   committed, so no build and no user ever needs the network or the package.
3. Use it: `icon('refactor')` returns markup, in `media/main.js` and in
   `src/webview-html.js` alike. It is `innerHTML`, so anything you interpolate
   beside it needs `escapeHtml` — several of these call sites used to be
   `textContent`, where that was free.
4. If it sits next to a text label, add its container to the spacing rules in
   `media/styles.css` — the leading list or the trailing one, depending on which
   side the glyph is on. `iconSuite` fails on a rule naming a class nothing
   renders, so a renamed container cannot leave a dead rule behind.

`iconSuite` in `test/webview-run.js` also fails the build if any name does not
resolve to a symbol in the sprite (a typo renders *nothing*, silently), or if an
emoji reappears in rendered markup. Font Awesome Free is CC BY 4.0: attribution
is a licence condition, so the notices in `src/icons.js` and the README stay.

## Touching skills

`src/skills.js`, and read `docs/skills-design.md` first — it argues the
decisions, the module only carries them out. Three of them are not open for
re-litigation in a patch:

- **`allowed-tools` never pre-approves anything.** Parsed, displayed, ignored
  for permission. Honouring it lets a repository switch off the approval gate by
  shipping a file.
- **Bundled scripts have no execution path of their own.** They go through
  `run_command`. A second path is a path around the gate.
- **The frontmatter format is the published spec, unmodified.** No Navy field,
  not even a useful one — the whole value is that skills move between tools.

`parseSkill` and `manifestFor` are pure and stay that way; that is what makes
every frontmatter constraint testable as its own case. Anything needing the
filesystem belongs in `SkillRegistry`.

## The browser target

`package.json` declares `"browserslist": ["chrome >= 122"]`. Nothing in the
build reads it — esbuild bundles only `src/extension.js` for Node, and `media/`
ships raw — so it exists for one reason: CSS compat linters (VS Code's Edge
Tools among them) otherwise assume the whole history of Chrome and flag every
modern feature as unsupported.

The number is **derived from `engines.vscode`**, currently `^1.90.0`, which
ships Electron 29 and therefore Chromium 122. **Move it whenever `engines.vscode`
moves**, and never upward past what that minimum actually provides — the point
is to describe the oldest engine Navy runs on, not the newest one available.

`media/styles.css` builds every tint with `color-mix()`, which needs Chromium
111. That is not enforceable from CSS and fails silently — on an older engine
every tinted background resolves to nothing and the panel renders flat — so
`themeTokenSuite` in `test/webview-run.js` asserts the declared target stays at
or above 111 for as long as the stylesheet uses `color-mix`.

## Adding a setting

Declare it in `contributes.configuration` in `package.json`, read it at the
call site, and add a row to the settings table in `README.md`. Write the
description the way the existing ones do: say what raising or enabling it
**costs**, not only what it does.

Clamp anything that guards against runaway behaviour, so a nonsensical value
leaves something coherent standing rather than disabling the guard.

## Before opening a pull request

- `npm run check`, `npm test`, and `npm run build` all pass
- No new entry under `dependencies`
- New settings appear in the README settings table
- New behaviour has a test; a fixed bug has a test that fails without the fix
- The CHANGELOG entry explains *why*, and what the symptom was
- No unrelated reformatting
