# AGENTS.md — tinyemu-agent

Guidance for AI agents and people changing the agent. What it does for a user, and
every user-visible behaviour, is in [README.md](README.md); keep it in step with the
code. **Don't commit or push unless asked.**

This repository is GPL-3.0-or-later. It builds on projects checked out as git
submodules under `deps/` (`git submodule update --init`; `scripts/add-submodules.sh`
registers them once): `deps/jsLab` (the VM runtime, GPL-3.0-or-later),
`deps/bash.js` (MIT), `deps/TinyEMU` (the emulator and its WebAssembly engine, MIT)
and `deps/TinyEMU-distros` (the guest image recipes, MIT). Change those in their
own repositories, then move the submodule; never edit files under `deps/` here.

## What it is

A static page (`index.html`) that boots a TinyEMU VM (x86 or RISC-V) in a Web Worker, through the
runtime in `deps/jsLab/lib/vm/`, and runs an agent loop against a chat model whose six tools
act inside that VM, plus a `skill` tool when the user has imported skills, a
`Delegate` tool that runs a sub-agent, and `ask_user` (questions for the user). `scripts/serve.mjs` is a dev server with no dependencies. There is no
build step for this folder: plain ES modules, loaded by the browser as they are.

## Map

| Piece | Owns |
|-------|------|
| `index.html` | All UI: chats as sessions (one log element, agent and turn per chat; several run at once), sub-agents' read-only chats (`subView`), the ask_user form (`askUser`, `renderAsk`), resuming after a reload (`offerResume`), the chat figures popover (ⓘ: usage first, `renderChatInfo`), the Context panel (the meter, `renderContextPanel`), tool cards (with their stats and stop buttons), messages queued during a turn, provider/model picker, saved connection, Settings and Log tabs, VM startup (cold boot or resume), the VM tab (machine choice, Save state / Fresh boot), Console/Files/Skills tabs, `pageFiles` (Read/Edit/Write of the volumes from the page), `@id` expansion on send |
| `js/Agent.js` | Provider-independent loop; `SYSTEM_PROMPT`/`SUBAGENT_PROMPT`; the provider interface (`addUser`, `step`, `addToolResults`, `setTools`, `fork`, `transcript`, `resetHistory`, `pendingCalls`); empty-reply retries and `retry()`; `queue()` for messages sent during a turn; per-call stop (`cancelTool`) and the tool output cap; `resumePending`/`closePending` for a turn a reload cut off; the exchange log (`log`); `createDelegate` (Delegate's sub-agents, their shells, concurrency limit, report wrap-up, `view` and `resume`); context tracking and `compact()` |
| `js/pause.js` | `pauses`: a clock that leaves out time the browser had the page stopped (frozen tab, sleep, debugger) |
| `js/bashjs.js` | `createJsBash`: Bash in bash.js (`deps/bash.js`) on the page's volumes, one bash.js session per tools shell; `loadBashJS` |
| `js/figures.js` | `contextBreakdown` (the Context panel's parts), `usageSummary` (the ⓘ panel's usage), the running figures (`emptyFigures`, `figuresShape`, `recordExchange`, `recordSubAgent`, `figuresSummary`, `commandWord`) and `parseRateLimits`, with no DOM |
| `js/keepAwake.js` | `createKeepAwake`: the Screen Wake Lock and the quiet tone that keep the page running during turns |
| `js/compaction.js` | `COMPACT_PROMPT`, `renderTranscript`, `compactedMessage`, `isContextOverflow`, `estimateTokens`, `DEFAULT_CONTEXT_WINDOW` |
| `js/tools.js` | `TOOL_DEFS` (shared by every provider) and `createTools(bridgeOrPromise)`: loose name matching (`resolveToolName`), input validation, per-file ordering, shells (cwd and exported variables per name; `forShell`), page-served files (`files`), waiting for a booting VM, `ask_user` (`ASK_DEF`, `askQuestions`, `formatAnswers`), `limitToolOutput` |
| `js/GuestBridge.js` | Talking to the guest: `BOOTSTRAP` (typed once on the console), `agentd`, the per-job script, `exec()`, and `attach()` after a resume |
| `js/FileBrowser.js` | The Files tab; reads the `workspace` volume store directly; uploads, downloads (folders through `zip.js`), deletes, and `task()`, the bar's running-operation status |
| `js/chats.js` | The chats' IndexedDB store (`ChatStore`, `MemoryChatStore`), the chat record and its events, `titleFrom`, `pickChat` |
| `js/zip.js` | `makeZip()`: an in-memory .zip, deflated with `CompressionStream('deflate-raw')` where there is one |
| `js/LinkedFolders.js` | Folders on the user's computer linked into the workspace: `link()` (and `linking`, the paths still copying), `sync()`, the IndexedDB link store |
| `js/skills.js` | `SkillLibrary` (the `skills` volume: scan, import, remove), `SKILL.md` parsing, `@id` expansion, `skillToolDef` |
| `js/providers/*.js` | One file per wire format: `claude.js` (Anthropic SDK from esm.sh), `openai.js` (raw fetch + SSE; Gemini, OpenAI, OpenRouter, custom), `webllm.js` + `toolProtocol.js` (local models, text tool calls) |
| `js/distros.js` | Where the machines come from: `DISTROS_PAGES` (TinyEMU-distros' Pages), `ENGINE` (the TinyEMU release), `parseManifest` (its `manifest.json`), `distroLabel`, and `agentConfig`, the `configOverride` every boot goes through |
| `scripts/serve.mjs` | This repository statically, and each `--distro` build directory at `/distro/<name>/` (for `?cfg=`) |
| `scripts/build.mjs` | Release builder: the page's import closure, rewritten for the release layout; `release-README.md` is the release's README |
| `tests/tools.test.mjs` | Node tests, no VM, no real model |

From `deps/`, the agent depends on:
- `deps/jsLab/lib/vm/`: `VMManager`, `VM` (`saveSnapshot`, volume ops), `EmulatorEngine`,
  `snapshot.js` and `SnapshotStore.js`;
- `deps/jsLab/lib/volumes/Fs9pStore.js`: the in-memory 9p store behind the JS volumes
  (its `listDir` gives each entry's `ino` and change counter `gen`, which linked
  folders rely on);
- `deps/jsLab/lib/vm/TinyemuConfig.js`: `parseConfig` and friends, which apply the
  page's `configOverride` (and the tests use);
- `deps/bash.js/bash.js`.

Not from `deps/`: the engine, `x86emu-wasm.{js,wasm}`, is loaded from TinyEMU's
Pages (`engine/<ENGINE>/`, through jsLab's `engineUrls`), and the guests from
TinyEMU-distros' Pages. `deps/TinyEMU` and `deps/TinyEMU-distros` are there for
their sources and for building them. Despite its name the engine has both machines, the PC and RISC-V (riscv32/riscv64); the
  config's `machine:` picks one. `ENGINE_ARCHES` in `index.html` lists what it runs,
  and the kernel arguments the page adds (`vmOptions`) are per arch: the x86 timing
  ones are meaningless to a RISC-V kernel.

## How a tool call travels

1. The provider's `step()` returns tool calls. `Agent` resolves each name
   (`tools.resolve`: `bash` is Bash), runs them all with `Promise.all`, each with
   its own AbortController (the turn's signal aborts it too; `cancelTool(id)` aborts
   one), and hands back one result per call, in call order, each cut to the output
   cap (`limitToolOutput`).
2. `tools.run()` validates the input against `TOOL_DEFS`, waits for the VM if it is
   still booting (60 s, then an error result), and runs the handler. It **never
   throws**: a failure is `{ content, isError: true }` that the model sees.
3. Read, Edit and Write of a path under `/workspace` or `/agent/skills` (no `..`)
   are served by the page through `files` (the VM's volume operations) and stop
   here; they don't wait for the VM either.
4. Other handlers build a shell script and call `bridge.exec()`. That writes
   `/req/<id>/{inputs, script, cwd, go}` into the `agent` volume and polls it until
   `rc` appears. The page clock enforces timeouts, by writing `kill`.
5. In the guest, `agentd` (mounted at `/mnt/agent`) sees `go` and starts `bin/job`.
   The job sources `env` if there is one (a Bash shell's exported variables), runs
   the script in a new session (`setsid`), sourced so `exit N` and `cd` work, and
   writes `out`, `cwd.after`, `env.after` and, last, `rc`.

## Rules that keep it working

### The guest channel
- **Never send data over the console.** Its input FIFO (`jsemu.c`) is 1 KB and drops
  overflow. The console carries only `BOOTSTRAP`, one short line.
- **Mount 9p with `msize=32768`.** TinyEMU's virtqueues have 16 descriptors and no
  indirect descriptors. A kernel's default 512 KB msize needs more, and the mount
  hangs in D state.
- **Time on the page clock.** Timeouts and polling deadlines use the page's clock,
  never the guest's, and the page's clock is `pauses.now()` (`js/pause.js`), not
  `Date.now()`: a frozen tab, a sleeping computer or a debugger stops the VM's worker
  too, and that time mustn't time a job out. Gaps in a hidden tab count only if it
  froze: Chrome throttles a hidden tab's timers to once a minute while its worker
  runs on. `Agent._run` asks a step again once when it failed after a pause.
- **The guest's clock skips pauses.** `jsemu.c`'s run loop (`skip_pause_gap`, browser
  builds only) takes a gap of more than 5 s between two ticks out of
  `host_clock_ns()`, as a snapshot restore does. Without it, Linux saw minutes pass in
  one tick after a freeze or sleep and reported an RCU stall ("timer wakeup didn't
  happen for N jiffies"). The guest's wall clock then lags, so `pauses.on` in the
  page calls `GuestBridge.syncClock()` (`date -s`). Native builds don't need it.
- **Keeping the page running** (`js/keepAwake.js`, Settings → Keep running) is
  active only while a turn runs (`updateControls` → `keepAwake.set(anyRunning())`).
  The Screen Wake Lock is released by the browser when the tab is hidden and asked
  for again on `visibilitychange`. The tone is a looping AudioBuffer (one quiet
  tone, then silence, `PERIOD_S` long) on the audio clock, because a hidden tab's
  timers are throttled. Keep it above Chrome's -72 dBFS silence threshold, or Chrome
  counts the tab as silent and the tone does nothing. An AudioContext may only start
  after a user gesture, so it may wait for the next click. The in-app browser
  refuses wake locks (`NotAllowedError`); test them in Chrome.
- **`rc` is written last**, by rename; its existence means the job finished. Read
  `rc` before the final `out`.

### Tools
- **Names are matched loosely** (`resolveToolName`: no case, no `-`/`_`/spaces). The
  Agent resolves before `toolStart`, so cards, stats and the log show the real tool;
  the provider's history keeps what the model wrote, matched by call id.
- **One cap for every result**, in `Agent._runCall`: `toolOutputMax` (a setting) and
  never more than a quarter of the window (about 4 characters a token). Bash doesn't
  truncate on its own any more; don't add per-tool caps that stack notes.
- **A stopped call answers at once** (`_runCall` races the work against its signal),
  even when the tool ignores the signal (`ask_user`, page-served files). The work
  may still finish in the background; for Bash the bridge kills the job.
- **ask_user is the page's** (`createTools({ ask })`), never a sub-agent's
  (`without(DELEGATE_TOOL, ASK_TOOL)`), and it doesn't wait for the VM. Its schema is
  the batch form; `runTool` also accepts one top-level question, which models write.
  `validateInput` checks top-level types only: `askQuestions` checks the items.
- **Per-file ordering:** Read, Edit and Write of one path go through `inOrder`, so an
  Edit's read-modify-write can't lose a concurrent change. Bash isn't ordered.
- **A Bash call that moves its shell says so** (`movedNote`, both the VM and bash.js
  paths): the result ends with `[The working directory is now …]`, or `[The shell X
  is now in …]` for a named shell, whose directory the file tools don't follow. A
  user's log showed why: `cd CTFd-master && pytest` moved the shell, the model kept
  assuming `/workspace`, and the review's files ended up split over two folders.
- **Shells:** a shell is a name with a cwd and an `env` (`export -p` output, less
  `PWD`, `OLDPWD`, `SHLVL`, `AGENT_DIR`: `shellEnv`). Only a real change updates
  either (`r.cwd !== startedIn`, env likewise), so a parallel call that didn't move
  can't undo one that did. The default cwd is `/workspace` (`DEFAULT_CWD`). Each
  tools view has a default shell (`main`; `forShell(name)` for a sub-agent's), and
  Read/Glob/Grep resolve relative paths against it. Shells are not serialized: two
  calls in one shell run at once, as before. The test bridge's wrapper mirrors the
  guest's `JOB` (env in, env out); keep the two in step.
- **Page-served files:** the page may only serve a path the guest really has on that
  volume. `..` always goes to the guest (it depends on what the parents are), and
  `checkMounts` (index.html) turns `pageFiles` off if `/proc/mounts` lacks either
  9p mount. The volume store has no symlinks, so a routed path means what it says.
  Per-file ordering (`inOrder`) covers both routes.
- **Bash in bash.js** (`settings.bashJs`, off by default): `createTools({ jsBash })`
  returns the runner while the setting is on. Then `defs` gives `bashJsDef` (no
  `run_in_background`, and a description of what exists) and the handler calls
  `js.run()` instead of `bridge.exec()`; `via` is `page`. The page still waits for
  the VM, whose volume ops hold the files. `js/bashjs.js` maps bash.js's
  `read/write/delete/move/stat` onto `vm.volume*` (`volumeRename` within a volume,
  copy and delete across), adds `/` and `/agent` as fixed folders and `/tmp` as
  bash.js's `memfs`; every other path is missing or read-only. Despite its README,
  bash.js 1.0.0 has no abort signal and no per-call cwd: `run()` races a timer and
  the turn's signal (the command finishes in the background), and `cd`s into the
  tools shell's cwd when the session is elsewhere. A pure-CPU bash.js loop runs on
  microtasks, so no timer fires until it ends; its `maxLoopIterations` bounds it.
  Calls in one bash.js session run one at a time (they share its streams). The
  library loads on first use (`import('../deps/bash.js/bash.js')`, a UMD file that
  sets `globalThis.BashJS` in a module); update it by moving the submodule.
- **Bash's default timeout** is a setting: `bashTimeoutMs()` is read at each call,
  and `defs` rebuilds the Bash definition (`bashDef`) so its description names it.
- **Escaping:** paths go into scripts through `shQuote`. Never interpolate model input
  into a script unquoted; large or binary input goes in as a file (`inputs`).
- Grow `tests/tools.test.mjs` with every tool change.

### Skills
- **Three JS volumes, of at most four.** `agent`, `workspace` and `skills` take three
  of the engine's `MAX_FS_DEVICE` (4) 9p slots, leaving one for the distro's config.
- **One writer per volume.** Once the VM runs, its worker owns the `skills` volume's
  in-memory tree and flushes it over IndexedDB. The page reads IndexedDB itself only
  at load, read-only, so the list is there before boot; after `setVM` every read and
  write goes through `vm.volume*`. Writing IndexedDB directly would be overwritten.
- **Per-skill switches:** `SkillLibrary({ isEnabled })`, read at each use, from
  `settings.disabledSkills`. `list()` is every skill (the Skills tab); `enabled()` is
  what the agent gets: the `skill` tool's list and enum, `load()` (which refuses an
  off one) and `@id` expansion. Use `enabled()` for anything the model sees.
- **The tool list is dynamic.** `tools.defs` is a getter: the `skill` tool exists only
  while some skill is on (an empty `enum` isn't a valid schema). `Agent.send`
  compares it with what the provider last got and calls `provider.setTools()` when
  it changed, so every provider must implement `setTools`.
- **Skills are listed in the tool's description.** Extra top-level fields on a tool
  definition (like an `available_skills` list) are rejected by the APIs.
- **The `skill` tool doesn't need the guest.** It reads `SKILL.md` from the volume in
  the page, afresh on each call, so it works during boot and sees guest edits.

### Linked folders
- **Firefox and Safari have no File System Access API.** There the button copies a
  picked folder in once (`copyFolderIn`, an `<input webkitdirectory>`); nothing is
  linked or synced, and the chat says so. Don't call that a link.
- **A folder being linked shows a spinner:** `link()` makes the folder first, adds
  it to `linking` and emits `change`, and removes the half-copied folder if the
  first copy fails. `FileBrowser` also has `busy` (path → text) for the same.
- **They are copies, synced.** The guest's 9p is served synchronously from the
  in-memory store; the File System Access API is async (only OPFS has sync access
  handles), so a picked folder can't back a volume directly. Don't try to make
  `FileSystemAccessBackend` a 9p backend: `Fs9pStore` keeps a volume in memory and
  saves it as a tree record plus one record per file.
- **Unlink before removing.** A linked folder deleted from the Files tab is
  unlinked (`LinkedFolders.unlink()`), not deleted: the workspace copy stays. Unlink
  runs on the sync chain, after any pass in progress, so no pass sees the folder half
  gone. The window `focus` that follows a `confirm()` starts a sync, and before this
  a delete racing it read as "every file deleted" and deleted them on disk. Inside a
  pass, `stillLinked()` re-checks the root's inode before every deletion on disk, for
  the guest removing the folder mid-pass; keep both.
- **Read-only links** (`mode: 'read'`) never write to the disk: `_syncOne`'s `ro`
  branches only change the workspace. Their baseline marks workspace-only state
  (`local`, `gone`, `d: null`) and is saved even when nothing was copied, so a later
  disk change still conflicts instead of overwriting the workspace's version. Links
  saved before modes existed load as read-write.
- **Sync at actions, not on a timer** (the user's choice): `tools.run` around VM
  calls (`sync` option), `sendPrompt`, `FileBrowser.refresh` (and so uploads and
  deletes), and window focus. `LinkedFolders.sync()` coalesces a burst into at most
  one running and one queued pass.
- **Change detection:** disk `size:lastModified`; workspace `size:mtime:gen`. mtime
  has 1 s resolution, so `gen` (bumped on every write) is what catches a quick
  same-size edit. A moved signature is confirmed by hashing against the baseline,
  so a reload (gens restart) rewrites nothing.
- **The root's inode is the link.** A missing root, or one with a new inode (rm -rf
  then mkdir), unlinks without touching the disk. Without that check a recreated
  empty folder would read as "every file deleted" and empty the user's folder.
- **Deletes propagate to disk** inside a linked folder (the user's choice), and every
  such deletion is reported in the chat.
- **Testing:** the picker can't be automated; a real `FileSystemDirectoryHandle` from
  `navigator.storage.getDirectory()` (OPFS) plus `agentDemo.linkFolder(handle, dir)`
  exercises the same code. OPFS handles need no permission, so Reconnect is untested
  that way.

### Context and compaction
- **The Context panel measures only the total.** `contextBreakdown` estimates the
  system prompt and each tool definition from their text (`estimateTokens`) and
  calls the rest Messages; before any response it estimates the transcript too.
  Its parts always add up to the window. Keep the calculations in `js/figures.js`
  (tested) and the drawing in the page. `apiMs` is added up in `logExchange` from
  `response` entries, because the log itself is capped (`MAX_EXCHANGES`).
- **Client-side, one way for every provider.** `compact()` renders
  `provider.transcript()`, has a `fork()` with no tools write a summary, and puts it
  in place with `resetHistory()`. Claude's server-side compaction beta isn't used: it
  covers one provider, and the counters would differ between them.
- **The context size is the last response's** `input + cacheRead + cacheWrite +
  output`, so it lags one request. After a compaction it is an estimate (summary +
  system prompt + tool definitions) until the next response; `lastCompaction.measured`
  then records the real size.
- **When:** before a message and between steps (`_autoCompact`), at
  `threshold × (window − min(maxOutput, window/2))`; and once per turn on an error
  `isContextOverflow` recognises, which compacts and retries the step. Never during a
  running step, and the page's Compact button is disabled while a turn runs.
- **A failed automatic compaction doesn't stop the turn** (`compactFailed`), and the
  history is only replaced once a summary exists: nothing is lost on failure.
- **`resetHistory` starts a new conversation** (one user message), so no earlier
  thinking block is edited, which Claude checks. Consecutive user messages (the
  summary, then the next message) are fine: the APIs merge them.
- **A request with no tools omits `tools`** (some OpenAI-compatible servers reject
  `[]`), and `toolPrompt` with no tools is the plain system prompt.
- **Sub-agents compact too**: `createDelegate` passes the page's `context` options
  and reports `compacted`. Their summary requests count under `usage(u, 'compaction')`.

### The loop
- **An empty reply is `stop: 'empty'`**, and the provider must not add it to its
  history (Claude rejects an assistant turn with no content). `Agent._step` asks
  again `emptyRetries` times, then returns it; `retry()` re-sends the same request.
  `retry()` is only valid when the history ends with a user message or tool
  results: the page doesn't offer it after `max_tokens` or `refusal`, whose replies
  were kept.
- **Network failures wait, without limit.** `_run` asks a step again when
  `isNetworkError(e)` (the request never got an HTTP answer: "Failed to fetch",
  the SDK's `APIConnectionError`, `navigator.onLine === false`), after
  `networkRetryDelay(n)`: `NETWORK_RETRY_MS` = 5, 5, 10, 10, then 20 s repeating,
  woken early by the `online` event. The count starts over once a step gets
  through. An error with a `status` is the server's answer and is never retried
  this way. The pause retry is checked first (it asks again at once). A provider
  must leave a failed request out of its history, so the same request goes out
  again. `on.retrying(why, { network, attempt, delayMs, message })` lets the page
  count down (`showWaiting(text, { until })`).
- **Messages sent during a turn** go through `queue()` and are added as one user
  message after the step's tool results (marked as sent while working), or, if the
  model just ended, as the next message of the same turn. Nothing is injected
  mid-step: a provider needs every tool result of a step together. Claude's
  `addUser` appends to a trailing user turn (tool results) as a text block, rather
  than relying on the API to merge two user turns. On Stop, the page takes what is
  left (`takePending`) back into the box; on any other end it starts a new turn.
- **`maxSteps` and `emptyRetries` may be functions**, read when used, so a settings
  change applies to a running turn.
- **The log** (`log` option) gets plain JSON entries: `{ agent, type, ... }` with
  types `start` (from the page and `createDelegate`), `user`, `response`, `tool`,
  `compaction`, `error`. Keep entries serializable; Export writes them as they are.
  A failing log callback never stops the agent.
- **Providers export and import their history** (`exportHistory`/`importHistory`)
  for the log; the format is tagged per wire format, and the page only restores into
  the same `kind`. OpenAI-style and WebLLM keep the current system prompt.

### Delegate and settings
- **Sub-agents get the caller's tools (`ctx.tools`)`.without(Delegate, ask_user).forShell('sub-agent-N')`**,
  which shares the per-file ordering but can't delegate again (no recursion, and no
  unbounded fan-out) or ask the user, and has its own shell, copied from the
  caller's when it starts.
- **Only the final message goes back.** A turn that ends without one (`max_tokens`,
  `max_steps`, `empty`, or `end` with no text) gets a wrap-up message asking for the
  report, with `maxSteps` 2, up to `WRAP_UP_TRIES`; an error is retried once from
  the history (`retry()`). If all that fails, the last non-empty step text is used.
  The sub-agent's `task` option repeats its task in every compaction summary.
- **`view(info)`** is how the page shows a sub-agent: its hooks are chained after
  the progress hooks, `meta` goes to the sub-agent's tool calls, `attach(agent)`
  lets the page stop its calls, `done(status, text)` ends it. `on.*` and `log`
  get the Delegate call's ctx as their last argument, so the page counts usage in
  the right chat.
- **`maxConcurrent`** caps sub-agents running at once (0: no limit); the rest wait
  in a queue that Stop can leave. It is a function, read as slots free up.
- **`fork()` shares the client or engine, not the history.** WebLLM forks share one
  loaded engine, so `step()` queues generations on it (`_exclusive`); parallel
  Delegate calls would otherwise interleave two generations on one engine.
- **The Delegate card keeps the progress** and appends the report (`toolEnd` in
  `index.html`); every other card's output is replaced by the result.
- **Tool settings filter `tools.defs`** through `isEnabled`, and a turned-off tool
  also refuses to run, in case a model calls it anyway.

### Providers
- **Implement the interface** at the top of `Agent.js`. `step()` returns
  `{ stop, toolCalls?, detail? }`, where `stop` is `end`, `tool_use`, `refusal`,
  `max_tokens` or `aborted`. A call with `error` is not run; its error is the result.
- **Report usage** through `onUsage` once per API response, in the page's shape:
  `input` uncached, `output` including thinking, `thinking` null when the API
  doesn't count it apart (Claude doesn't). OpenAI-style requests ask for it with
  `stream_options.include_usage`.
- **Implement `fork({ system, tools })`**: a new empty conversation with the same
  model, for Delegate and for compaction summaries; it copies `contextWindow`. A
  provider without it can't delegate or compact (the call errors).
- **Implement `setSystem(text)`**: the page passes the system prompt as a function
  (`Agent` option `system`), and `send()` hands a changed one to the provider. WebLLM
  rebuilds its prompt with the tools (`toolDefs`). Sub-agents use
  `subagentPrompt(currentSystem())`, read when each one starts.
- **The prompt is a template.** `systemTemplate()` (index.html) is what Settings
  edits and saves; `currentSystem()` is that through `renderPrompt()` (Agent.js),
  which fills `{{VAR_ARCH}}` / `{{VAR_OS_NAME}}` from `promptVars()` (the VM tab's
  machine) and `{{VAR_MODEL_NAME}}` / `{{VAR_MODEL_ID}}` from `modelVars()` (the
  connection; `useProvider` keeps `connection.modelName` from the model listing). Compare and save the template, send the rendered text. A new variable
  goes in `promptVars()`, `PROMPT_VAR_HELP` (the list under the Settings editor,
  `renderPromptVars()`) and README's Settings section.
- **Report usage after the reply's text.** The page's message stats (`uiHooks`:
  time, output tokens, tokens/s) are written when `onUsage` fires, timed from the
  step's first `onText`/`onThinking`. A provider that reports usage before it
  finishes streaming would show a wrong speed.
- **Implement `transcript()` and `resetHistory(text)`**, and set `contextWindow`
  (from the model listing, or null) and, if replies take a fixed budget,
  `maxOutput`. The listings return `contextWindow` per model; keep that working
  when a provider's `/models` shape changes.
- **Thinking level:** `setEffort(level)` applies from the next request and `fork()`
  copies it. `''` means send nothing (the model's default). Each provider exports
  its scale (`CLAUDE_EFFORTS`, `OPENAI_EFFORTS`); WebLLM has none. The page tags
  the provider with `kind` to know which scale a live change belongs to.
- **Send history back verbatim.** Claude's thinking and fallback blocks, and any
  extra fields on OpenAI-style tool calls (Gemini's thought signatures ride in
  `extra_content`), must go back unchanged.
- **A reply cut off in a tool call** (`max_tokens`/`length`) is dropped, not
  executed: its arguments may be incomplete.
- **API keys** go only to their provider: in a header, never in a URL. Switching
  provider clears the key field. `?baseURL=` is loopback-only, so a crafted link
  can't redirect a key.
- **Model lists** come from the provider (`listClaudeModels`, `listOpenAIModels`).
  Don't hard-code model IDs for API providers; they go stale.

### The page
- **Insert guest and model text as text only:** `textContent`, `append(string)`,
  `new Option()`. Never `innerHTML` with anything that came from the guest, a model
  or a file name. That is what keeps the key out of the guest's reach.
- **Wrap every `localStorage` access in try/catch;** the page must work without
  storage. Keys: `tinyemu-agent-connection`, `tinyemu-agent-tool-cards-open`,
  `tinyemu-agent-settings` (including `pageFiles`, `toolOutputMax`, `wakeLock` and `keepAudio`), `tinyemu-agent-vm-settings` (the VM tab's machine),
  `tinyemu-agent-env` (its environment variables), `tinyemu-agent-active-chat`,
  `tinyemu-agent-boot-history` (the VM tab's Starts).
- **Chats are events, drawn as text.** `uiHooks` records each thing it draws into
  the open chat (`recordChat`; shapes in `js/chats.js`), and `drawChatEvent` draws
  a saved one with the same builders (`addMessage`, `addThinkingBox`,
  `addToolCard` + `finishToolCard`, `addCompactionCard`). A new kind of chat
  entry needs both, or it vanishes on reload. Never persist the log's DOM.
  Conversation notes go through `addChatNote`/`addChatProblem`; page notes (VM
  boot, links, connecting) stay `addMessage` and aren't kept.
- **Each chat is a session** (`sessionOf(chat)`): its own `.log` element (only the
  open one is shown), agent, `running`, queued messages, cards and waiting
  questions. Several turns run at once. Drawing helpers (`addMessage`,
  `addToolCard`, `recordChat`, ...) write to `here()`: the open session, or the
  one `inSession(s, fn)` names. **Every hook and every line after an `await` that
  draws must be inside `inSession`**, or it lands in whatever chat is open.
  `uiHooks(s)` wraps all of its hooks that way.
- **Running figures** (`c.figs`, `js/figures.js`): `logExchange` passes every log
  entry to `recordExchange(c.figs, e, own)`, so the ⓘ folds cover the whole chat
  though `c.exchanges` is capped. `own` (`main`, or the sub-agent's name) picks
  whose requests draw the context curve; sub-agents' entries count everywhere else
  in the parent. Keep `c.figs` plain JSON (it is saved) and bounded: the context
  curve thins itself past 300 points, durations keep 50 per tool, Bash words 100.
  What the folds show comes from log fields, so a new figure usually means a new
  field on a log entry: `response` has `firstMs` (time to the first token, null
  when nothing streamed); `tool` has `chars` (before the cap), `capped`,
  `stopped` (by the user, not the turn), `via` and `health`.
- **`via` and `health` come back through `ctx.out`**, an object `Agent._runCall`
  hands the tools: `runTool` sets `out.via` (vm, page, user, model) and Bash sets
  `out.health`. Results stay `{ content, isError }`; tests compare them whole.
- **Guest health** is written by `JOB` (`GuestBridge.js`) from `/proc/loadavg` and
  `/proc/meminfo` into `health` before `rc`, and parsed by `parseHealth`. The test
  bridge's wrapper doesn't write it; null is fine.
- **Rate limits** come from response headers (`parseRateLimits`): Claude through a
  `fetch` wrapper given to the Anthropic client (forks share it and its
  `limits` holder), OpenAI-style from the `fetch` response. They ride on the usage
  object as `limits`, only when there are any. A browser can read them only if the
  provider exposes them over CORS; untested against real APIs.
- **Engine counters** (VM tab): `VM.engineStats()` → host `stats()` → worker
  `stats`/`stats-reply` → `EmulatorEngine.stats()`: `vm_cycles` (the machine
  class's `vm_get_cycles`), `vm_disk_chunks`/`vm_disk_bytes` (`block_net.c`), and
  9p traffic counted by wrapping each volume store's `read`/`write`. The page
  samples only while the VM tab shows (`watchEngine`), and around tool calls that
  need the guest (`vmCallEdge`, from the first one open to the last one closed).
- **Figures live on the chat record** (`usage`, `toolStats`, `compactions`,
  `exchanges`, `stats` with `turns`, `workMs` and `apiMs`; `ensureChatShape`), not in page globals; the Settings and
  Log tabs render the open chat's. `addUsage(c, ...)`, `countTool(c, ...)`,
  `logExchange(c, ...)` take the chat.
- **Agents and the connection:** `connection` is the model picked last. The open
  chat's agent gets that provider; another chat gets a `fork()` when it is opened
  (`ensureAgent`), unless it is running. A chat's `history` goes back in only for
  the same `format`; a mismatch is said, not fixed. Each chat's Bash runs in shell
  `chat-<id>` (`chatTools`). `saveChat(c)` exports that chat's own agent's
  history; saves are batched (`saveChatSoon(c)`, every 2 s while text streams,
  immediate at a turn's end).
- **Sub-agents' chats** are records with `kind: 'sub'`, `parent`, `callId`,
  `subName`, `shell`, `task` and `status` (running, done, failed, stopped,
  interrupted). They are read-only: no agent of the page's own, the box disabled;
  their `running` is a stand-in whose `abort()` cancels the parent's Delegate
  call. Deleting a chat deletes its sub-agents' chats.
- **A turn records itself** (`c.turn` while it runs, saved at once) so a reload can
  resume it. After the first connection, `offerResume` asks; until then
  `buildAgent` keeps open calls (`keepPending`). Resume: `Agent.resumePending`
  with `resumeCall`, which resumes a Delegate call's sub-agent from its chat's
  history (`delegate.resume`) and leaves every other call "interrupted" (never run
  again: it may have half-run). A sub-agent's own open calls are interrupted the same
  way. Declining, or a chat opened later, `closePending()`s, so the history is
  valid for the next message (Claude rejects a `tool_use` without its result).
  `pendingCalls()` is part of the provider interface for this.
- **ask_user waits in its chat's session** (`s.asks`): the form replaces the box
  only while that chat is open; its tab shows a `?`. The answer is recorded as a
  user event with `answer: true`.
- **The waiting line** (`showWaiting`) goes from `stepStart` to the first visible
  output: text, a tool call, usage, or thinking when thinking is shown. `runTurn`
  always clears it.
- **Environment variables** (VM tab) reach Bash through `createTools`' `env()`,
  read per call; `withUserEnv` drops every managed name from the shell's own
  exports and appends the current values, so a removed or changed variable doesn't
  linger in a shell's `env`. `/etc/profile.d/tinyemu-agent.sh` goes in as a job
  input, never a here-document, so no value can end it.
- **Number settings live in `LIMITS`** (default, min, max); `numberSetting()` binds
  an input to one. Add a new one there, so saved values out of range fall back.
- **Each chat log's last child is its `.queue-box`**, where waiting messages sit.
  Add anything else to a chat with `logAppend`, never `el.append`, or it lands
  below them. The box is `display: contents`; don't give it a class a message
  also has (`.queued` is the message's: sharing it once hid the messages' dashed
  outline).
- **Restarting the VM reloads the page** (VM tab, Fresh boot): the tools hold one
  bridge for the page's life. Say so wherever the page asks first.
- **Batch console writes** (`termPending`, flushed by a timer). Per-chunk DOM
  appends froze the page during kernel boot. Use timers, not
  `requestAnimationFrame`, which never fires in a hidden tab.
- **Tool calls can start before the VM is ready:** `tools` is created at page load
  with a promise of the bridge (`vmReady`). Don't make connecting wait for the VM.

### Saved state (snapshots)
- **A snapshot is the whole WASM memory** plus TinyEMU's `wasm/lib.js` file-buffer
  table (where `block_net.c` keeps disk blocks and writes). Machine state kept
  anywhere else in JS is not saved. jsLab's `docs/runtime.md`, under Snapshots, has
  the design.
- **Restore only into the same wasm build, config and disk images.**
  `snapshotFingerprint` hashes the wasm bytes, the config text, the
  `Last-Modified`/`ETag` of the files it names, and the VM options. Anything new that
  a resumed VM depends on must go into that fingerprint.
- **Don't take one with I/O in flight.** `EmulatorEngine.snapshot()` waits for
  none, because a pending download would never complete in the restored instance.
- **After a resume,** the guest's `agentd` is still running: use
  `GuestBridge.attach()`, not `start()`, which needs a console prompt that isn't
  there. `attach()` also sets the guest's date, which stood still while saved;
  `start()` sets it too, since the RISC-V machine has no RTC.
- **Volumes aren't in the snapshot.** They persist in IndexedDB on their own (every
  3 s and on `pagehide`), and 9p has no client cache, so the guest sees their
  current contents after a resume.
- **The VM tab's Data buttons** only use the live volume ops (`volumeDelete`,
  `volumeFlush`), `links.unlink()`, `SnapshotStore.clear()` and localStorage, never
  deleting an IndexedDB database: the worker holds the volumes' databases open and
  would write them back on the next flush. Unlink before emptying the workspace, as
  the Files tab does.
- **One saved state per machine:** `snapshotKey()`. `alpine-3.20-x86`, the first default
  (then `alpine-3.20-riscv64`, now `debian-13-riscv64-lite`), keeps the old key
  `tinyemu-agent-vm`, so existing saved states still resume.
- **Changing what `agentConfig` does** (`js/distros.js`) changes the
  fingerprint, so existing snapshots are discarded and the next load cold-boots.
  That is intended.

### The server
- **Serve with `no-store`.** The in-app browser kept stale modules with `no-cache`.
- **Send `Last-Modified`.** Snapshot fingerprints follow a local distro's files by it.
- **Stay read-only,** and inside this repository plus the `--distro` directories:
  distro and file names must match `/^[\w-][\w.-]*$/` (one flat directory), and
  paths are checked to stay under `ROOT`.
- **The page doesn't depend on it:** no route the built site lacks. A local distro
  is only reached through `?cfg=`.

### Where the machines come from (js/distros.js)
- **Nothing is copied into the site.** The VM tab's list is TinyEMU-distros' Pages
  `manifest.json` (`parseManifest`), read at each load; each distro boots from its
  own `config.cfg` there (absolute URLs, CORS `*`). Without the manifest the page
  offers just `DEFAULT_DISTRO` and says why in the VM tab.
- **Every boot goes through `agentConfig`** (jsLab's `configOverride`): `ethN` is
  dropped, the three JS volumes take the next free `fsN`, and an unfilled
  `${ASSET_BASE}` (a local build) is taken out of the absolute paths. jsLab applies
  it on the page and boots a `data:` URL, which needs engine v2026-11-23 or later
  (older ones abort on a non-http(s) config). `?cfg=` goes through it too.
- **The engine is pinned** (`ENGINE`), not `latest`: a saved state only resumes on
  the wasm it was saved with, and a new release should be tried before the page
  moves to it. `?engine=` takes a release name or a folder on the page's own origin,
  never another host: the engine runs as code in the page's worker.
- **The fingerprint** gets the engine's wasm URL (`engineUrls(...).wasmBinUrl`), the
  config URL and the same `configOverride` the VM gets, and the options without it
  (a function doesn't stringify).

### TinyEMU-distros
- **One release holds every distro** (tag `distros-<date>-<run>`), each as
  `<name>.tar` (kernel, chunks, `config.cfg` with a literal `${ASSET_BASE}`,
  `bios.bin` for RISC-V). Its Pages hold the latest release only, unpacked, plus
  `manifest.json`: a new release reaches the page with no deploy here.
- **`<name>-lite` is what the agent expects:** `init=/bin/sh`, a root shell on the
  console. A plain `<name>` is the full image (OpenRC, console autologin): it works,
  slower, and its networking service fails at boot since `agentConfig` drops `eth0`.
  `DEFAULT_DISTRO` is `debian-13-riscv64-lite`.

### The site (scripts/build.mjs, the deploy workflow, GitHub Pages)
- **Only sources are committed.** The site is built by `.github/workflows/deploy.yml`
  (run by hand) into a Pages artifact; nothing built goes into git (`_site/` is
  ignored). The site is the page, jsLab's `lib/` and bash.js: no engine, no distros.
- **Everything the page loads must be reachable from its imports** (`from`,
  `import()`, `new URL('…', …)` with a relative string): that is how the build
  finds what to copy. A path built at runtime from pieces is missed. This
  repository's files go to the site root, `deps/jsLab/lib/` to `engine/`,
  `deps/bash.js/` to `vendor/` (the layout the site had before the submodules);
  anything else fails the build. Specifiers on comment lines are neither followed nor rewritten.
- **No absolute or server paths in the page** for its own files. Pages serves it
  under `/tinyemu-agent/` with no server logic, so they are relative to the page.
  The only absolute URLs are the two Pages sites in `js/distros.js`.
- **Pages caches for 10 minutes** (`max-age=600`, not configurable): right after a
  release a browser can mix old and new modules (an early `vm_start failed:
  Aborted()` or `Uncaught [object Object]`); a hard reload fixes it. Test releases
  with a cacheable server under a subpath, not only with `scripts/serve.mjs`.

## Verifying a change

1. **Unit tests:** `node tests/tools.test.mjs` (115 tests; jsLab's `npm test` covers the volume store). On Windows they
   use Git Bash's `sh`, and the test bridge stubs `setsid` when it is missing.
2. **In a browser:** start the server (`node scripts/serve.mjs`), open
   `/`, and keep the page **visible**. A hidden or
   background tab is throttled, and boot timings from it are meaningless.
3. **Drive it without a model key:**
   - `window.agentDemo` exposes `{ vm, bridge, tools, useProvider, Agent, saveState,
     pageFiles, copyFolderIn, exchanges(), toolStats(), machine, ... }` once the VM
     is ready;
   - `useProvider(scripted, 'label')` with an object implementing the provider
     interface exercises the loop and tool cards; give it `fork`, `exportHistory`/
     `importHistory` and `pendingCalls` to exercise sub-agent chats, other chats and
     resuming after a reload (connect it again after the reload: the page then asks);
   - `pauses._add(ms)` pretends the page was paused;
   - `tools.run('Bash', { command })` runs a real call;
   - for the OpenAI-compatible path, a tiny local server answering `/v1/models` and
     streaming `/v1/chat/completions`, with CORS headers, is enough.
4. **Saved state:**
   - `?nosnapshot=1` gives a clean cold boot;
   - Fresh boot, or deleting `tinyemu-snapshots`, forces one;
   - to test resume, change something in the guest, press Save state, reload, and
     check it is still there.
5. **Clean up** test files you put in the workspace (`vm.volumeDelete('workspace', path)`)
   and saved connections you created.
6. **Real keys and real drags:** API providers have only been run against fake
   servers and real invalid-key errors, and drag and drop only with synthetic events.
   Say so when you report, rather than implying they were tested.

**When the change needs a new engine** (TinyEMU's C sources, `wasm/lib.js`, or
exported functions), make it in TinyEMU, move `deps/TinyEMU`, build the wasm, and open the page with
`?engine=deps/TinyEMU/dist/wasm/`:

```bash
docker run --rm -v "$PWD/deps/TinyEMU":/src -w /src emscripten/emsdk:3.1.74 make -f Makefile.js
```

On Windows Git Bash, add `MSYS_NO_PATHCONV=1` and use `"$(pwd -W)"`. Once TinyEMU
publishes it as a release, move `ENGINE` in `js/distros.js` to it. TinyEMU's own
`AGENTS.md` lists the engine's checks (the x86 selftest, the JIT tests).

## Conventions

- **Files here use LF line endings** (`.gitattributes`); preserve each file's
  existing endings, and check with `tr -cd '\r' < f | wc -c`.
- **No dependencies or build tools.** SDKs load from a pinned CDN URL at the point of
  use (`esm.sh`, `esm.run`), and only when that provider is chosen.
- **Keep dependencies GPL-3.0-compatible** (MIT, BSD, ISC, Apache-2.0, LGPL, GPL),
  and give each new source file an `SPDX-License-Identifier: GPL-3.0-or-later` line.
- **Match the surrounding code:** ES modules, `'use strict'`, four-space indents, a
  header comment explaining each file's job, and comments that say why, not what.
- **Update README.md** for any change a user would notice, and this file for any new
  rule or trap.
