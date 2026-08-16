# Troubleshooting

## Start here: run the self-test

Command Palette → **Navy Coder: Test Provider Connection**.

It asks your configured provider for its model list using the same code a real
request uses, and tells you which of these it is: the URL is wrong, the key is
wrong, the key is right but for the other region, the account has no balance,
the account is rate limited, or nothing is listening at all. Almost everything
below is faster to diagnose that way than by reading.

---

## "No models — couldn't fetch models, check your API key or base URL"

This message covers two very different problems, and re-pasting the key only
fixes one of them.

**The base URL doesn't serve an API.** If the self-test says *no such route*,
the URL is wrong, not the key. Clear `navy.apiBase` to return to the built-in
default. Note that a URL can respond perfectly and still be wrong — a vendor's
marketing site, an old API host, or a different region's host will all answer.

**The key belongs to another region.** Moonshot (Kimi), Qwen, MiniMax and z.ai
each run separate mainland-China and international endpoints, and a key issued
for one is rejected by the other as a plain `invalid api key`. There is no way
to tell that apart from a bad key by looking at it. Set `navy.apiBase`:

| Provider | International (default) | Mainland China |
| --- | --- | --- |
| Moonshot (Kimi) | `https://api.moonshot.ai/v1` | `https://api.moonshot.cn/v1` |
| Qwen | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| MiniMax | `https://api.minimax.io/v1` | `https://api.minimax.chat/v1` |
| z.ai (GLM) | `https://api.z.ai/api/paas/v4` | `https://open.bigmodel.cn/api/paas/v4` |

z.ai also serves `https://api.z.ai/api/coding/paas/v4` for GLM Coding Plan
subscriptions.

## "Your account has no quota" / "insufficient balance"

Nothing in Navy needs changing — the endpoint and key are both fine and the
account needs topping up. Prepaid providers (MiniMax, z.ai) report this as
`insufficient balance`; others call it a quota or billing limit.

## "Rate limit hit (limit N, this request needed M)"

If **M is larger than N**, the single request exceeds your entire per-minute
budget and waiting cannot help — it will fail identically at any time. Send
less: start a new chat, attach fewer or smaller files, or turn off **Context**.
Or raise the ceiling with a paid tier, a model with a higher limit, or local
Ollama.

If M is smaller than N you were simply going too fast; wait a minute.

## Ollama

**Nothing is listening.** Local Ollama needs `ollama serve` running. The
self-test reports a refused connection rather than an auth problem, which is
the distinguishing symptom.

**Ollama Cloud** needs no local install, but does need an API key — set
`navy.ollamaMode` to `cloud` and save the key in Settings.

**The context badge is blank.** Navy asks Ollama for the model's window via
`/api/show`. A model that doesn't report one falls back to the built-in table,
and `navy.contextWindow` overrides both.

---

## Navy forgets which project I'm in

Fixed in 0.2.7. The chosen root is remembered in the extension's own storage
and, failing that, restored from the project catalog. If a project still won't
stick, check that `navy.projectRoot` isn't pinned to a stale path — Navy no
longer writes that setting, so a value in it is one you (or an older version)
set deliberately, and it wins.

## Navy says "No project root — open a folder before using file tools"

With no folder open, Navy derives the root from the file you have open, and
confines itself to that file's directory. If no file is open either, there is
genuinely nothing to work on: open a file or a folder.

## Sandboxed commands

`navy.sandboxMode: docker` works on Windows, macOS and Linux. With it on, Navy
targets the container rather than the host — commands are written for and run
through POSIX `sh` even from a Windows host, because that is what the container
provides. (Before 0.2.7 it built `cmd /c` on Windows and spliced that into a
Linux image, so every sandboxed command failed instantly.)

Sandboxing never silently falls back to running unsandboxed. If Docker isn't
running, or the project has no `.devcontainer/devcontainer.json` or
`Dockerfile`, the command is **refused** and says so — Navy will not guess at a
generic image, since a container that doesn't match the project's real
toolchain is a false sense of safety rather than a real one.

## Dictation opens a browser tab, and there is no pause button

Both are deliberate.

A VS Code webview cannot reach the microphone — its iframe is built without
`microphone` in its permissions policy
([microsoft/vscode#250568](https://github.com/microsoft/vscode/issues/250568)),
and Electron's speech backend is keyed to Chrome besides. VS Code's own speech
extension can't be used either: that API is a *proposed* API, and an extension
using one cannot be published to the Marketplace. So dictation runs in your
browser, where a real recogniser exists, and posts the transcript back. It
needs Chrome or Edge; the page says so in anything else.

Recognising in the extension host was built and reverted. Windows' `System.Speech`
needs no install and no key, and its desktop recogniser is a decade older than
neural speech models — not good enough to dictate a sentence with.

**There is no pause control** because the browser's recogniser has none. Faking
it meant tearing the engine down and building a new one, and whatever you said
across the gap was lost. Press Stop, then the mic again.

**If the page never opens**, check that the loopback port isn't blocked by a
local firewall; Navy binds `127.0.0.1` on an ephemeral port and opens it through
`asExternalUri`, which is also what makes this work over SSH and in Dev
Containers.

Read-aloud is different: it runs in the panel, needs no permission, and its
button is simply absent where the renderer has no speech synthesis.

## The panel is stuck "thinking"

Press **Stop**. If the panel is unresponsive rather than busy, reload the window
(Command Palette → *Developer: Reload Window*) — chats are saved continuously,
so nothing is lost. If it happens repeatedly, please open an issue with the
contents of **View → Output → Navy Coder**, which logs failures without sending
anything anywhere.

## Where the logs are

**View → Output → Navy Coder.** Provider errors, failed background saves and
self-test results go there. Navy has no telemetry, so this channel is the only
place anything is recorded, and it never leaves your machine.
