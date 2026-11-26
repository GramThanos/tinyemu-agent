# AGENTS.md — tinyemu-agent

Guidance for AI agents and people changing the agent. Every user-visible behaviour is
in [README.md](README.md); keep it in step with the code. **Don't commit or push
unless asked.**

GPL-3.0-or-later. It builds on git submodules under `deps/` (`git submodule update
--init`): `jsLab` (the VM runtime, GPL), `bash.js` (MIT), `TinyEMU` (the emulator and
its WebAssembly engine, MIT) and `TinyEMU-distros` (the guest images, MIT). Change
those in their own repositories, then move the submodule; never edit `deps/` here.

## What it is

A static page, a React app built with Vite: a sidebar of **projects** and their chats,
the open chat, and a panel for its environment. Each chat runs an agent loop against
the model it picked, with tools that act in its **environment**: bash.js in the page,
or a TinyEMU VM (x86 or RISC-V) in a Web Worker through `deps/jsLab/lib/vm/`. Each
project has its own workspace volume. `npm run dev` serves it, `npm run build` makes
the site in `dist/`, `npm test` runs the Node tests.

Three layers:
- `js/`: the agent, with no DOM and no React, so Node can test it;
- `src/app/`: what the page does (state and actions, no JSX);
- `src/components/`: React components that draw it.

## Map

| Piece | Owns |
|-------|------|
| `src/main.jsx`, `index.html`, `src/styles.css` | The entry: `boot()`, one `createRoot` in `StrictMode`, the one stylesheet |
| `src/app/store.js` | Topics (`emit`, `useTopics`): how state reaches React |
| `src/app/state.js` | Shared state (`S`, `UI`), storage and formatting helpers; imports no other `src/app` module |
| `src/app/sessions.js` | Each chat's session and log items, the agent hooks (`uiHooks`), recording and saving chats |
| `src/app/agents.js` | Each chat's agent, turns, queued messages, ask_user, sub-agents' chats, to-do lists, resuming after a reload |
| `src/app/chatOps.js` | Opening, making and deleting chats; saving and deleting projects |
| `src/app/world.js` | Skills library, projects and their runtimes (`rt`), the environment pool, `chatTools`, the system prompt per chat |
| `src/app/models.js`, `modes.js`, `mcpServers.js`, `settings.js` | Providers and picks; modes; MCP servers; settings |
| `src/app/files.js`, `machines.js`, `stats.js`, `data.js`, `dialogs.js`, `layout.js`, `boot.js` | Files tab; distros and VM options; per-chat figures; Settings → Data; dialogs; layout; start and `window.agentDemo` |
| `js/Agent.js` | The provider-independent loop, the provider interface, `createDelegate`, compaction |
| `js/tools.js` | Tool definitions and `createTools`: validation, shells, page-served files, per-file order, policies, ask_user, to-dos |
| `js/environments.js` | `EnvironmentPool`, `ProjectEnvs`, `Environment` (bash.js or a VM), `createJsBridge` |
| `js/providerStore.js`, `js/providers/*.js` | Providers, presets, per-model settings, `Connections`; one file per wire format |
| `js/modes.js`, `js/mcp.js`, `js/skills.js`, `js/projects.js`, `js/volumes.js` | Modes; MCP client and hub; skills; project records and storage keys; `VolumeHost` |
| `js/GuestBridge.js`, `js/bashjs.js`, `js/LinkedFolders.js` | The guest channel; Bash in bash.js; linked folders |
| `js/figures.js`, `js/compaction.js`, `js/chats.js`, `js/pause.js`, `js/keepAwake.js`, `js/distros.js`, `js/zip.js` | Figures; compaction helpers; chat store; the pause-aware clock; keeping the page awake; where machines come from; zips |
| `vite.config.js` | The build, the dev server (no-store; local distros from `TINYEMU_DISTROS`), the release's extra files |
| `tests/*.test.mjs` | Node tests: tools and loop, projects, providers, modes and to-dos, MCP (against `tests/fixtures/mcpServer.mjs`) |

The engine (`x86emu-wasm.{js,wasm}`) isn't in `deps/` or the site: it loads from
TinyEMU's Pages, the guests from TinyEMU-distros' Pages. The engine has both machines
(PC and RISC-V); kernel arguments (`vmOptions`) are per arch.

## How a tool call travels

1. The provider's `step()` returns tool calls. `Agent` resolves each name, runs them
   all at once, each with its own AbortController, and returns one result per call,
   in order, each cut to the output cap.
2. `tools.run()` validates the input, waits for a booting VM (60 s), runs the
   handler, and **never throws**: a failure is `{ content, isError: true }`.
3. Read, Edit and Write under `/workspace` or `/agent/skills` (no `..`) are served
   by the page from the volume store, without the VM.
4. Other handlers build a shell script and call `bridge.exec()`, which writes
   `/req/<id>/{inputs, script, cwd, go}` into the `agent` volume and polls for `rc`.
   The page's clock enforces timeouts by writing `kill`.
5. In the guest, `agentd` starts the job: it sources the shell's `env`, runs the
   script in a new session (`setsid`), sourced so `exit` and `cd` work, and writes
   `out`, `cwd.after`, `env.after` and, last, `rc`.

## Rules that keep it working

### The guest channel
- **Never send data over the console.** Its input FIFO is 1 KB and drops overflow;
  it carries only `BOOTSTRAP`.
- **Mount 9p with `msize=32768`.** TinyEMU's virtqueues have 16 descriptors and no
  indirect ones; the default msize hangs the mount.
- **`rc` is written last**, by rename: its existence means the job finished. Read
  `rc` before the final `out`.
- **A long output stays in the guest:** the page re-reads `out` whole to stream it,
  so it stops streaming past `STREAM_MAX`, and a Bash call asks for its last
  `keepLines` lines, which the job writes to `out.tail` (with `out.lines`) before
  `rc`. jsLab's volumes have no partial reads. The test bridge doesn't cut, so
  `tools.js` cuts what a bridge returns uncut (`lastLines`).
- **Time on the page's clock, `pauses.now()`** (`js/pause.js`), never the guest's or
  `Date.now()`: a frozen tab, sleep or the debugger stops the VM too, and that time
  mustn't time a job out. `Agent._run` asks a step again once if it failed after a
  pause.
- **The guest's clock skips pauses** (`skip_pause_gap` in TinyEMU's run loop), so
  Linux doesn't report RCU stalls; the page then resets the guest's date
  (`GuestBridge.syncClock()`).
- **Keeping the page awake** (`js/keepAwake.js`) runs only during turns. The wake lock
  is asked for again on `visibilitychange`. The tone must stay above Chrome's -72 dBFS
  silence threshold, and plays on the audio clock (a hidden tab's timers are
  throttled). The in-app browser refuses wake locks: test them in Chrome.

### Tools
- **Names match loosely** (no case, `-`, `_` or spaces). The Agent resolves them
  before `toolStart`, so cards and stats show the real tool.
- **One cap for every result** (`Agent._runCall`): the `toolOutputMax` setting, and
  never more than a quarter of the window. Don't add per-tool caps.
- **A stopped call answers at once**, even if the tool ignores the signal; for Bash
  the bridge also kills the job.
- **Per-file ordering:** Read, Edit and Write of one path run in order (`inOrder`),
  so an Edit can't lose a concurrent change. Bash isn't ordered.
- **Shells:** a name with a cwd and exported variables. Only a real change updates
  either, so a parallel call that didn't move can't undo one that did. A Bash call
  that moves its shell says so in its result (`movedNote`): models otherwise lose
  track of the directory. The test bridge mirrors the guest's job script; keep the
  two in step.
- **Page-served files** only for paths the guest really has on that volume: `..`
  always goes to the guest, and a VM whose `/proc/mounts` lacks a 9p mount gets none.
- **Bash in bash.js:** bash.js 1.0.0 drops the backslash of `\(` and `\)`, so
  `createJsBridge` quotes them; drop that once bash.js is fixed. It has no abort
  signal or per-call cwd: `run()` races a timer and `cd`s first. A pure-CPU loop runs
  on microtasks, so only `maxLoopIterations` bounds it. Calls in one session run one
  at a time.
- **Escaping:** paths go into scripts through `shQuote`; large or binary input goes
  in as a file. Never interpolate model input unquoted.
- **The tool list is dynamic:** `tools.defs` is read at each send (skills, MCP
  servers, settings, modes change it), and `Agent.send` hands a changed list to the
  provider through `setTools`.
- **A view's policy chooses tools** (`withPolicy(fn)`: true, false, or undefined for
  the `isEnabled` default), and `run` refuses what the view doesn't offer.
  `without()` always wins: sub-agents never get Delegate or ask_user.
- **ask_user and the to-do tools are the page's.** ask_user never reaches a
  sub-agent and doesn't wait for the VM; `validateInput` checks top-level types only,
  `askQuestions` the items. To-do lists are per agent, on its chat record
  (`ctx.meta.chatId`), and never touch the guest.
- Grow `tests/tools.test.mjs` with every tool change.

### Projects and environments
- **A volume has one writer: the page or one VM.** `VolumeHost` hands the workspace
  to a VM (`handTo`: flush and close first) and takes it back after the VM flushed and
  stopped. Everything that touches a project's files goes through its host
  (`rt(p).volumes`); never open a workspace's IndexedDB store elsewhere.
- **So a project runs one VM at a time.** `ProjectEnvs.slot` serializes starts,
  pauses and discards; starting another machine waits for the running one's chats to
  be idle and pauses it. Different projects' VMs run side by side.
- **Environments are shared, shells aren't.** One `Environment` per (project, key);
  each chat gets its own shell. `users` is every chat assigned to it (for "no other
  chat uses it"), `working` the chats with a turn running.
- **A VM starts on demand:** its bridge awaits `env.ready()` (start or resume), so
  sending never waits for the VM. A VM that failed after it started still holds its id
  and the volumes: `_start` stops it first (not waiting long for its flush). Idle VMs are paused by `pool.sweep()`; bash.js never
  is. Fresh boot (`discard()`) makes new tools, which the page hands to the chats.
- **The default project keeps the storage keys from before projects**, so old
  workspaces, chats and saved states still load.

### Skills
- **Three JS volumes of at most four** (`agent`, `workspace`, `skills`): the engine
  has 4 9p slots, one left for the distro's config.
- **The library is the page's**, never handed to a VM: each VM mounts a copy, rewritten
  when it starts and when `skillsHost.version` moved. Never write the library's
  IndexedDB directly. The copy deletes before it writes, so parallel calls share the
  one in flight for that VM (`_syncSkills`).
- **Use `skills.enabled()` for anything the model sees** (the tool, `@id` expansion,
  the `@` list); `list()` is for Settings.
- **List skills in the tool's description:** the APIs reject extra top-level fields on
  a tool definition, and the tool must not exist while no skill is on (an empty `enum`
  is invalid).
- **Settings is a modal dialog:** report imports there (`skillsNote`), never in the
  chat behind it.

### MCP servers
- **Streamable HTTP only.** Keep `Accept` with both types, `MCP-Protocol-Version` after
  initialize, `Mcp-Session-Id` once given; a 404 with a session means it expired:
  initialize again and retry once. Server requests are answered (ping) or refused.
- **Their tools join as `extraTools`**, checked by `checkMcpInput` (not
  `validateInput`, which assumes flat schemas). Names are `mcp__<server>__<tool>`, at
  most 64 characters (hashed when longer), made unique across servers (`_2`, ...) in
  `McpHub.tools()`.
- **One connection attempt at a time:** a call to a server that is connecting waits for
  that attempt (or Stop); only a failed one is replaced. An attempt that was replaced
  closes its own session. Connecting has a timeout (`CONNECT_MS`).
- **Headers are secrets,** kept like provider keys and sent only to their server.

### Linked folders
- **They are copies, synced:** the File System Access API is async and 9p is served
  synchronously, so a picked folder can't back a volume.
- **Firefox and Safari can't link:** there the button copies a folder in once; don't
  call that a link.
- **The root's inode is the link.** A missing root, or one with a new inode, unlinks
  without touching the disk; otherwise a recreated empty folder would read as "every
  file deleted" and empty the user's folder.
- **Unlink before removing,** on the sync chain, and re-check the root's inode before
  every deletion on disk (`stillLinked()`): a delete racing a sync once deleted the
  files on disk. Keep both.
- **A deletion on disk is never recursive,** and a file goes only if its signature is
  still the scan's (`_deleteDisk`): the user may save into the folder while a pass
  runs. What was spared keeps its baseline, so the next pass copies it in.
- **Read-only links never write to the disk;** their baseline is saved even when
  nothing was copied, so a later disk change still conflicts.
- **Sync at actions, not on a timer** (tool calls, sending, refresh, window focus);
  `sync()` coalesces a burst into one running and one queued pass.
- **Change detection:** disk `size:lastModified`, workspace `size:mtime:gen` (`gen`
  catches a same-second edit); a changed signature is confirmed by hashing.
- **Testing:** an OPFS handle (`navigator.storage.getDirectory()`) with
  `agentDemo.linkFolder(handle, dir)` exercises the same code; Reconnect can't be
  tested that way.

### Context and compaction
- **Client-side, one way for every provider:** `compact()` has a tool-less `fork()`
  summarize `provider.transcript()`, then `resetHistory()`. The history is replaced
  only once a summary exists, and a failed automatic compaction doesn't stop the turn.
- **The context size is the last response's** input + cache + output, so it lags one
  request; after a compaction it is an estimate until the next response.
- **When:** before a message and between steps, at `threshold × (window −
  min(maxOutput, window/2))`, and once per turn on an overflow error. Never during a
  step.
- **`resetHistory` starts a new conversation**, so no thinking block is edited (Claude
  checks).
- **A request with no tools omits `tools`:** some servers reject `[]`.
- **The Context panel measures only the total**; its parts are estimates from text
  (`js/figures.js`, tested) and always add up to the window.

### The loop
- **An empty reply is `stop: 'empty'`** and stays out of the history (Claude rejects
  an empty assistant turn); `retry()` re-sends the same request, so it is only offered
  when the history ends with a user message or tool results.
- **Network failures wait** (5, 5, 10, 10, then 20 s, woken by `online`) up to
  `networkRetries` times in a row (15; 0: no limit). An error with an HTTP status is
  never retried that way, so a provider's HTTP errors must carry `status`
  (`apiError` in openai.js). A provider must leave a failed request out of its
  history.
- **Messages sent during a turn** are added after the step's tool results, never
  mid-step: a provider needs all of a step's results together. On Stop they go back
  in the box.
- **Settings that are functions are read when used,** so a change applies to a
  running turn.
- **Log entries are plain JSON** (`{ agent, type, ... }`); a failing log callback
  never stops the agent.

### Delegate
- **Sub-agents get the caller's tools less Delegate and ask_user, in their own
  shell,** then the sub-agent mode's policy (`toolsFor`). Only the final message goes
  back; a turn without one is asked for a report (`WRAP_UP_TRIES`).
- **`fork()` shares the client or engine, not the history.** WebLLM forks share one
  engine, so generations queue on it (`_exclusive`).
- **`maxConcurrent` caps sub-agents at once;** the rest queue, and Stop can leave the
  queue.

### Providers
- **Implement the interface** at the top of `Agent.js`: `step()` returns `{ stop,
  toolCalls?, detail? }`; `fork`, `setTools`, `setSystem`, `setEffort`, `setTuning`,
  `transcript`, `resetHistory`, `exportHistory`/`importHistory`, `pendingCalls`.
- **Report usage once per response, after the text,** in the page's shape (`input`
  uncached, `output` with thinking). The page times speed from the first token.
- **Send history back verbatim,** under the names it came in: Claude's thinking and
  fallback blocks, `reasoning_content` / `reasoning` / `reasoning_details`, and
  `extra_content` (Gemini's thought signatures, which Gemini 3 requires back).
- **One OpenAI-style client for every preset:** handle a quirk in it for all, never
  with a branch on the preset. A tool-call delta without `index` starts a call only if
  it names a function or brings a new id (`callIndex`).
- **A reply cut off inside a tool call is dropped,** not run.
- **Send nothing that isn't set** (response size, temperature): servers differ in what
  they accept (`max_completion_tokens` for OpenAI; Claude refuses `temperature` with
  thinking). A model's own settings come through `setTuning` and win over Settings →
  Context's window.
- **A preset must allow the page (CORS):** check its preflight and that its error
  answers carry `Access-Control-Allow-Origin`.
- **API keys go only to their provider,** in a header, never a URL. `?baseURL=` is
  loopback-only.
- **One loaded provider per (provider, model);** every chat gets a `fork()`, so no two
  share a history. Don't hard-code model ids: lists come from the APIs.

### Prompts and modes
- **A chat's prompt is its mode's template** rendered by `renderPrompt()` with
  `promptVars(c)` (`MODE`, `ARCH`, `OS_NAME`, `MODEL_NAME`, `MODEL_ID`), read at every
  send. Sub-agents get the sub-agent mode's template with the delegating chat's
  variables. A new variable goes in `promptVars()`, `PROMPT_VAR_HELP` and README.
- **Modes choose tools through a policy, never by rebuilding tools** (`chatTools(c)`
  reads the chat's mode at each use). Built-in modes can be reset, not deleted; only
  the built-in sub-agent mode is `sub`.

### The page
- **State lives in `src/app` as plain objects changed in place; React subscribes to
  topics** (`emit(topic)` after a mutation). Chat records and sessions are saved and
  changed by `js/`, so never copy them into React state.
- **No React Compiler:** it memoizes on object identity, and these objects change in
  place. Memoize by hand where a stream redraws too much (`ChatLog` draws only a
  window of the last items, more as the reader scrolls up; its items redraw by
  their `v`).
- **`StrictMode` runs effects twice in development:** every effect cleans up, and
  `boot()` runs once.
- **Guest, model and file-name text go in as text only:** never
  `dangerouslySetInnerHTML` or `innerHTML`. That keeps keys out of the guest's reach.
- **Wrap every `localStorage` access in try/catch;** the page must work without
  storage. Reading `globalThis.localStorage` itself throws when storage is blocked,
  so the stores' defaults go through `pageStorage()`.
- **Chats are events:** `uiHooks` records what it adds (`recordChat`), and a saved
  chat is drawn back from its events. A new kind of entry needs both, or it vanishes
  on reload.
- **Every hook, and every line after an `await` that adds to a chat, runs inside
  `inSession(s, …)`,** or it lands in whatever chat is open. Several turns run at
  once.
- **A turn records itself** (`c.turn`) so a reload can offer to resume it. Calls that
  were running come back "interrupted" (they may have half-run), except Delegate,
  whose sub-agent resumes from its chat. Declining closes the open calls, since
  Claude rejects a `tool_use` without its result.
- **Figures live on the chat record** and stay plain JSON and bounded; a new figure
  usually means a new field on a log entry.
- **Batch console writes on a timer,** never `requestAnimationFrame` (it never fires
  in a hidden tab); per-chunk writes froze the page during boot.
- **The guest's tty size is set with `stty` through the bridge:** TinyEMU sends a
  size only at boot. Fix live resizing in TinyEMU/jsLab, not here.
- **Dialogs and menus are the page's own** (`Modal` over `<dialog>`, `openMenu`,
  `choose`); no library.

### Saved state (snapshots)
- **A snapshot is the WASM memory plus TinyEMU's file-buffer table;** machine state
  kept elsewhere in JS isn't saved (jsLab's `docs/runtime.md`).
- **Restore only into the same wasm, config and disks:** `snapshotFingerprint` hashes
  them and the VM options. Anything new a resumed VM depends on goes into it, and
  changing `agentConfig` intentionally invalidates saved states.
- **Don't snapshot with I/O in flight:** a pending download never completes in the
  restored instance.
- **After a resume, `agentd` is still running:** use `GuestBridge.attach()`, not
  `start()`. Both set the guest's date.
- **Volumes aren't in the snapshot;** they persist on their own, and 9p has no client
  cache.
- **Settings → Data never deletes an IndexedDB database:** a worker holds them open
  and would write them back. It uses the volume hosts' operations and unlinks first.
- **Deleting a project is the one exception:** its VMs are discarded (the workers
  gone), its links unlinked, its host closed for good (`VolumeHost.close()`), and only
  then `deleteVolumeDatabases(projectStorageKeys(id))`. Its saved states go by key
  (`isProjectSnapshot`), machines this page never started included.

### Machines, the engine and the site
- **The distro list is TinyEMU-distros' `manifest.json`,** read at each load; without
  it only `DEFAULT_DISTRO` is offered. The `-lite` images (`init=/bin/sh`) are what
  the agent expects.
- **Every boot goes through `agentConfig`:** no network, the JS volumes in the next
  free `fsN`, `${ASSET_BASE}` resolved. It boots a `data:` config, which needs engine
  v2026-11-23 or later.
- **The engine is pinned (`ENGINE`):** a saved state resumes only on its own wasm.
  `?engine=` takes a release name or a folder on the page's own origin, never another
  host.
- **Everything the page loads must be reachable from its imports,** as Vite bundles
  them. jsLab's VM worker is found next to its module, which a bundle breaks, so
  `world.js` imports it with `?worker&url`. CDN imports that stay (Anthropic SDK,
  WebLLM) carry `/* @vite-ignore */`.
- **No absolute paths for the page's own files** (`base: './'`): Pages serves it under
  `/tinyemu-agent/`.
- **A new bundled dependency needs its licence** in `LICENSES/` (`vite.config.js`).
- **Pages caches for 10 minutes:** right after a release, old and new files can mix;
  a hard reload fixes it. Test releases with `npm run preview` too.

## Verifying a change

1. **Unit tests:** `npm test`. On Windows they use Git Bash's `sh`.
2. **In a browser:** `npm run dev` (`.claude/launch.json` has it as `agent`, the built
   site as `dist`), and keep the page visible: hidden tabs are throttled.
3. **Without a model key:** `window.agentDemo`, in the dev server only (a build has it
   with `VITE_AGENT_DEMO=1 npm run build`): (`useProvider(scripted, label)`,
   `send(text)`, `tools.run('Bash', …)`, `setChatEnv`, `pool`, `pauses._add(ms)`, …).
   Use it rather than importing `/src/app/…` from the console, which loads a second
   copy of the modules. Each chat gets a `fork()` of a scripted provider, so its first
   fork answers as the main agent and later ones as sub-agents. For MCP, run
   `tests/fixtures/mcpServer.mjs`.
4. **Saved state:** `?nosnapshot=1` cold-boots; Save state, reload and check, to test
   a resume.
5. **Clean up** the files, projects, chats, providers and modes you made.
6. **Say what wasn't tested:** real API keys and real drag and drop have only been
   exercised with fakes.

**A change to the engine** (TinyEMU's C sources or `wasm/lib.js`) is made in TinyEMU:
move `deps/TinyEMU`, build the wasm, and open the page with
`?engine=deps/TinyEMU/dist/wasm/`:

```bash
docker run --rm -v "$PWD/deps/TinyEMU":/src -w /src emscripten/emsdk:3.1.74 make -f Makefile.js
```

On Windows Git Bash, add `MSYS_NO_PATHCONV=1` and use `"$(pwd -W)"`. Once TinyEMU
publishes the release, move `ENGINE` in `js/distros.js` to it.

## Conventions

- **LF line endings** (`.gitattributes`); check with `tr -cd '\r' < f | wc -c`.
- **Few dependencies, pinned exactly,** GPL-3.0-compatible, with `package-lock.json`
  committed. Provider SDKs load from a pinned CDN URL only when chosen; anything
  loaded only sometimes goes through `import()`.
- **Every source file** starts with `SPDX-License-Identifier: GPL-3.0-or-later` and a
  header comment on its job.
- **Match the surrounding code:** ES modules, `'use strict'` (not in `.jsx`), function
  components and hooks, four-space indents, comments that say why, not what.
- **Update README.md** for any change a user would notice, and this file for any new
  rule or trap.
