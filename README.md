# TinyEMU Agent

A chat page that turns a Linux VM running in your browser tab into an AI agent's
computer. The VM is TinyEMU's x86 or RISC-V emulator compiled to WebAssembly. The model gets
six tools (Read, Edit, Write, Glob, Grep and Bash), and they all act inside the VM,
plus a `skill` tool for any [skills](#skills) you import, a `Delegate` tool that
hands a task to a sub-agent, and `ask_user`, with which it asks you questions. You
can turn any of them off in [Settings](#settings).
Nothing runs on a server except a static file server. The site, built from these
sources by this repository's `deploy` workflow, is published at
<https://gramthanos.github.io/tinyemu-agent/> (see [Publishing](#publishing)).

It builds on other projects, checked out as git submodules under `deps/`:
[jsLab](https://github.com/gramthanos/jsLab) (the VM runtime: `VMManager`,
snapshots, volumes), [bash.js](https://github.com/gramthanos/bash.js),
[TinyEMU](https://github.com/gramthanos/TinyEMU) (the emulator, whose WebAssembly
engine the page runs) and [TinyEMU-distros](https://github.com/gramthanos/TinyEMU-distros)
(the guest images). Clone with `git clone --recursive`, or run
`git submodule update --init` in an existing checkout.

- [Quick start](#quick-start)
- [Using the page](#using-the-page)
- [Models](#models)
- [The VM](#the-vm)
- [Tools](#tools)
- [The server](#the-server)
- [Publishing](#publishing)
- [What the browser keeps](#what-the-browser-keeps)
- [Security](#security)
- [How it works](#how-it-works)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [Files](#files)

## Quick start

You need:
- Node.js 22 or later;
- the submodules (`git submodule update --init`);
- a [TinyEMU-distros](https://github.com/gramthanos/TinyEMU-distros) image: a local
  `build/<name>/` directory, a `<name>.tar` from its Releases unpacked into one, or
  the URL of a published copy (its Pages, `https://gramthanos.github.io/TinyEMU-distros/<name>`).
  Take a `-lite` image: it boots straight to a root shell (`init=/bin/sh`), quickly.
  The full ones (OpenRC, a login on the console) work too, but take longer to start;
- a current browser: Chrome 95+, Safari 15.4+ or Firefox 131+, for WebAssembly
  exception handling;
- the engine in `deps/jsLab/engine/` (see [The engine](#the-engine)):

```bash
node deps/jsLab/scripts/fetch-engine.mjs        # the latest release from TinyEMU's Pages
node scripts/serve.mjs --distro https://gramthanos.github.io/TinyEMU-distros/debian-13-riscv64-lite
```

Then open <http://localhost:8000/>. The VM starts booting at once. Give
`--distro` more than once to offer several systems in the [VM tab](#machines); the
first is listed first. The page boots `debian-13-riscv64-lite` when it is offered,
and the first otherwise.

1. Pick a **provider** and paste its API key, or choose **In this browser** for a
   local model that needs no key.
2. Press **Connect**. The model list fills in from the provider.
3. Pick a model. That starts the conversation.
4. Ask for something, for example "write a C program in /workspace that prints the
   primes below 100, compile it and run it".

## Using the page

The left half is the chat, with **Settings** (see [Settings](#settings)) and **Log**
(see [Log](#log)) tabs beside it. At the top right are the conversation's token use,
its context meter and **Compact** (see [Context and compaction](#context-and-compaction)).
The right half is the VM, with four tabs:
- **Console**: the VM's terminal. You can type into its shell while the agent works.
- **Files**: the agent's `/workspace` folder (see [Workspace](#workspace)).
- **Skills**: the skills you have imported (see [Skills](#skills)).
- **VM**: which system the VM runs, its memory, its saved state, and the data the
  page keeps (see [Machines](#machines), [Saved state](#saved-state) and
  [Data](#data)).

The badge at the top right shows what the VM is doing (the boot stage and the
seconds elapsed, and "downloading" while it fetches disk blocks), then **VM ready**.

**Chats** are kept in this browser, so a reload brings them back, and each has a tab
above the messages:
- **+** starts a new chat; click a tab to open that chat; double-click its name to
  rename it (a new chat is named after its first message); **×** deletes it, after
  asking (an empty one goes at once), with its sub-agents' chats. Deleting the open
  chat opens the latest other one, or a new one.
- **Several chats work at once.** Open another tab, or start one with **+**, while the
  agent works: it carries on in its chat, whose tab shows a spinner (and a **?** when
  it is asking you something). Each chat's Bash commands run in a shell of its own, so
  one chat's `cd` doesn't move another's; the files in the VM are shared.
- **Sub-agents' chats:** each sub-agent (see [Tools](#tools), Delegate) gets a tab of
  its own, **↳ its task**, after its main chat's, shown while that chat (or one of its
  sub-agents') is open. It shows the sub-agent's conversation as it happens: the task
  it was given, its replies, thinking and tool cards. It is read-only: the message box
  is off, and **Stop** stops that sub-agent alone (the main agent is told). The
  Delegate card's **open ↗** opens it; ✓ or ✗ on the tab says how it ended.
- **ⓘ**, at the end of the tab bar, shows the open chat's usage, then its figures:
  - **Usage:** the tokens and requests so far (sub-agents and compaction summaries
    included), the time spent waiting on the model (API time) and working, the
    cache hit rate (cached input over all input), and the turns;
  - **Breakdown:** input, output, cache reads and writes, and thinking where the
    API counts it apart;
  - **Where the tokens went:** the main agent's, the sub-agents' and the
    compaction summaries' share, as bars;
  - a link to the Context panel;
  - folds, each kept open across refreshes once you open it:
    - **Model:** how replies ended (finished, called tools, hit the output limit,
      came back empty, refused, stopped, failed), the streaming speed in tokens/s,
      the wait for the first token (average and longest), how many requests read
      nothing from the cache, tool calls per step, and a chart of the context size
      at each request, with compactions as dashed lines;
    - **Tools:** for each tool, its calls, failures, median and slowest run time,
      average output size and how many results were cut to the output limit, plus
      calls you stopped and the Bash commands run most (`cd /x && make` counts as
      make);
    - **Time:** waiting on the model, tools in the VM, tools the page served, and
      waiting for your answers. Calls that ran side by side each count their own
      time;
    - **Sub-agents:** how many finished, failed, were stopped or were interrupted by a
      reload, and how often one was asked again for its report;
    - **Interruptions:** lost connections and the time spent waiting them out, the
      browser pausing the page, and resumes after a reload;
    - **Rate limits:** how much of each limit is used, as the provider last reported
      it, with what is left and when it resets on hover. A provider sends these
      only if it lets the browser read the headers; until then the fold says so;
  - **Chat:** when it started and was last active, messages and replies, tool calls
    by tool, sub-agents, compactions and log size.

  These figures are running totals kept with the chat, so they cover the whole chat
  even after the Log tab drops its oldest exchanges.
- **What a chat keeps:** its messages, thinking, tool cards and compactions as the
  chat showed them, the model's own conversation, so the model carries on where it
  left off, and its token use, tool-call figures and Log tab exchanges (the latest
  2000).
- **Carrying on:** connecting a model, or opening another tab, gives the model that
  chat's conversation, if it was written by the same kind of provider (Claude,
  OpenAI-style, or in this browser): each keeps it in its own format. Otherwise the
  chat says so and the model starts without the earlier messages, though they stay
  on screen.
- A tool call that was running when the page closed shows as **interrupted**.
- **After a reload in the middle of a turn,** once a model is connected the page asks
  whether to carry on. **Resume** carries on each interrupted sub-agent from its saved
  conversation; when it reports, the main agent gets the report as its Delegate
  result and goes on. Commands that were running are not run again: the agent is told
  they were cut off. **Leave it stopped** marks them interrupted, and the chat waits
  for your next message. Only a model of the same kind as the chat's can resume it.

In the chat:
- **Enter** sends and **Shift+Enter** starts a new line. While the agent works, the
  Send button becomes **Stop** (or **Escape** in the message box).
- **Messages while it works:** type while the agent is busy and the button becomes
  **Append**. The message waits at the bottom of the chat, dashed, until the agent's
  current step or tool calls finish, and then goes to the model, which is told you
  sent it while it worked. If the model had just finished, it starts another round.
  **Cancel** on a waiting message puts it back in the box; after **Stop**, waiting
  messages go back in the box too.
- Each tool call appears as a card with the tool's name and main argument (and the
  shell, for a Bash call in another one). It shows a spinner and the seconds so far
  while it runs, then how long it took and the lines and size of its result. Expand
  it to see the input and output; a failed call's name turns red.
- **■ stop** on a running card stops that call alone: the agent gets "stopped by the
  user" as its result and carries on with the rest. (A Bash command is killed, with
  everything it started; a sub-agent stops.) Stop under the box still stops the turn.
- **Questions from the agent** (`ask_user`) take the message box's place: each
  question with its suggested answers as buttons (several may be picked when it
  allows), and a field to type your own. **Answer** sends them, **Dismiss** tells the
  agent you'd rather not say, and Stop stops the turn. Your answer stays in the chat as
  your message.
- **An empty response** from the model is asked for again, twice by default, and
  then the chat says so with **Try again** (the same request) and **Send "continue"**.
  A turn stopped by an error or the step limit offers the same (**Keep going** after
  the step limit).
- Cards start collapsed. If you open or close one by hand, new cards start that way,
  and the page remembers your choice.
- Thinking, from models that share it, appears as a collapsed "Thinking" block.
- **Waiting for the model:** from when a request goes out until the reply starts, a
  line with a spinner says "Waiting for <model>…" and counts the seconds. With
  thinking hidden (Settings), it says the model is thinking until text or a tool call
  comes.
- **Message stats:** under each message you send, the time you sent it. Under each
  reply of the model (or on its Thinking line, if it only thought), the time it
  finished, its output tokens and its speed in tokens per second, counted from its
  first streamed token. Hover for the details: the wait for that first token, the
  thinking tokens where the API counts them apart, and the input and cache tokens.
  A reply that was only tool calls has the same on its first card's tooltip. Dates
  are shown for messages from another day; output tokens include thinking.
- `@id` includes a skill's instructions in the message (see [Skills](#skills)).

You can connect a model and send a message before the VM has finished booting. A
tool call made then waits up to 60 s for the VM, and otherwise tells the model
nothing ran, so it can try again.

## Models

| Provider | Needs | How it is called |
|----------|-------|------------------|
| Claude (Anthropic) | An Anthropic API key | Anthropic SDK, native tool use, streamed |
| Gemini (Google AI Studio) | A key from [Google AI Studio](https://aistudio.google.com/apikey); there's a free tier | Gemini's OpenAI-compatible endpoint |
| OpenAI | An OpenAI API key | OpenAI-compatible API |
| OpenRouter | An OpenRouter key | OpenAI-compatible API |
| Other OpenAI-compatible API | Its base URL (such as `http://localhost:8080/v1`), and a key if it needs one | OpenAI-compatible API |
| In this browser (WebLLM) | WebGPU, and 2-5 GB of VRAM depending on the model | Runs on your GPU; tools are described in the prompt and calls parsed from the text |

- **Connect** (or Enter in the key or URL field) lists the models your key can use,
  from the provider's own API. Models that can't chat, such as embedding, speech and
  image models, are left out.
- **Picking a model** starts a conversation; picking another starts a new one. The
  list is locked while the agent is working.
- **Changing the key or URL** clears the list until you press Connect again.
  **Changing the provider** also clears the key, so one provider's key is never sent
  to another.
- **Saved connection:** once a model connects, the page remembers the provider, URL,
  key and model in this browser and reconnects to them on your next visit.
  **Clear saved** forgets them; the current conversation carries on until you reload
  or pick another model.
- **Rate limits:** OpenAI-compatible providers answering 429 or 502-504 are retried
  four times, after the delay they ask for or a growing one. Free tiers are easy to
  hit with an agent loop.
- **A custom server** must allow cross-origin requests from this page. llama.cpp's
  server and Ollama do by default, or with one flag.
- **Local models** (WebLLM) are far weaker at multi-step tool use than the API
  models, and their 8192-token context fills up quickly. Expect short tasks to work.
  The model downloads once and is then cached by the browser.

**Thinking**, next to the model, sets how much the model thinks:
- Claude: low, medium, high, xhigh or max (its `effort`), or the model's default.
  It starts at high. Not every model takes every level; the API says so if not.
- OpenAI-compatible APIs: low, medium or high (`reasoning_effort`), or the
  model's default, which sends nothing, for servers that don't know the field.
- In-browser models have no such setting, so the menu is hidden for them.

A change applies from your next request, in the same conversation, and sub-agents
started after it use it too. With Claude, changing it mid-conversation re-reads the
history once without the cache. The choice is remembered per provider in this browser.

Claude is called with adaptive thinking and with server-side refusal fallbacks for
Opus and Sonnet.

## The VM

The guest is a Linux from TinyEMU-distros, 32-bit x86 or 64-bit RISC-V, with no
network device. You are root. Booting the Alpine 3.20 x86 image takes about a
minute, or 2-3 s from saved state; the RISC-V images are much quicker, about 5 s
(Alpine) and 15 s (Debian) from cold. For x86, the engine unpacks a gzip kernel
itself instead of running the kernel's decompressor on the emulated CPU, which
saves about 30 s of the boot. The RISC-V machine has no clock chip, so the page
sets the guest's date once it is up.

### Workspace

The agent works in `/workspace`. Its tools start there, and its instructions ask it
to keep anything worth keeping there. The folder is stored in this browser
(IndexedDB), so its files survive reloads, saved states and fresh boots. It is saved
every 3 s and when the page closes; a save writes only the files changed since the
last one.

The **Files** tab shows that folder, read directly from the browser's copy, so it
works even while the VM boots. In it you can:
- open folders, and go back with the path at the top or the `..` row;
- click a file to preview it, if it is text and under 2 MB;
- download or delete the previewed file;
- download any row with its **↓** button: a file as itself, a folder as
  `<name>.zip` with everything in it;
- tick the box at the start of rows (or the one in the bar, for everything in the
  folder), then press **Download (n)** for one .zip of them all (or the one file),
  or **Delete (n)** to delete them. A folder goes with everything in it; the page
  asks first, listing what it will delete. A linked folder is only unlinked (see
  below);
- upload with **Upload** (files) or **Upload folder** (a whole folder), or drag
  files or whole folders onto the list, into the open folder, or onto a folder's
  row, into that folder. Dragging over the Files tab opens it.

While something runs (uploading, zipping, deleting, linking, unlinking, copying a
folder in) the bar shows what, with a spinner, and the rows it affects show a
spinner too.

The list refreshes after every tool call. **Refresh** picks up changes made from
the console.

### Linked folders

**Link folder**, in the Files tab, links a folder on your computer into the open
folder, as `<open folder>/<its name>` (with `-2` and so on if that name is taken). The
page first asks how to link it:
- **Read-only:** changes on your computer come into the workspace, and nothing is
  ever written back. The browser asks only to view the folder.
- **Read-write:** changes go both ways, as below. The browser asks to edit it.

Then you pick the folder. It shows in the list at once, with a spinner, while its
files are copied in; the list marks it `linked` or `linked read-only`.

Linking needs the File System Access API, which Chrome and Edge have. In Firefox and
Safari the button is **Copy folder in** instead: a page there can read a folder you
pick but can't write to it or see it change, so the folder is copied into the
workspace once (its files; empty folders inside it don't come along) and not kept
in sync. Download files from the Files tab to take them back.

The VM can't use the folder in place: its filesystem has to answer the guest at once,
and the browser only reads and writes your files asynchronously. So the folder is
copied into the workspace and kept in sync:
- **When:** before and after every tool call, before each message you send, on every
  Files tab refresh, upload and delete, and when the page regains focus. Nothing runs
  on a timer, so an edit typed in the VM console reaches your computer at the next
  of these.
- **Both ways** (read-write): new and changed files go across, in either direction.
  A file deleted in the workspace (by the agent or by you) is deleted on your
  computer too, and the chat says which. One deleted on your computer is deleted in
  the workspace.
- **One way** (read-only): changes on your computer come in. Changes in the
  workspace, the agent's included, stay there: an edited, new or deleted file there
  leaves your computer's folder as it is. A file deleted on your computer goes from
  the workspace too, unless the workspace changed it.
- **Conflicts:** a file changed on both sides since the last sync keeps your
  computer's version, and the workspace's is saved beside it, on both sides (only
  in the workspace for a read-only link), as `<name>.workspace-conflict`. The chat says so. A change made against a deletion on
  the other side wins over the deletion.
- **Size:** a linked folder can hold up to 200 MB, since the workspace keeps it in
  browser memory. Nothing in it is skipped. A folder that grows past that stops
  syncing, with a message.
- **Unlinking:** delete the linked folder (🔗 in the list) in the Files tab. That only
  unlinks it: its files stay in the workspace as a plain folder, no longer synced,
  and nothing changes on your computer. Delete it again to remove that copy. The
  agent removing the folder, or replacing it with a new one of the same name, also
  unlinks it, and deletes nothing on your computer, even if a sync was running.
- **After a reload** the browser forgets the permission. The page says so, and
  **Reconnect** in the Files tab asks for it again. Until then the folder isn't synced,
  and the workspace keeps the copy it had.

### Skills

A skill is a folder of instructions for a kind of task: a `SKILL.md`, with the
skill's `name` and `description` in its frontmatter, and any scripts or reference
files it uses.

```markdown
---
name: git-release
description: Prepare release notes, version bumps, and GitHub releases.
---

# Steps
...
```

In the **Skills** tab, **Import folder** (or dropping folders onto the tab) imports
one skill's folder, or a folder of them: every folder with a `SKILL.md` becomes a
skill, and the folder's name is its id. Importing a skill with an id you already
have replaces it. **Delete** removes one. **Open** shows the skill: its files on the
left, `SKILL.md` first, and the chosen file's text on the right (binary files and
files over 2 MB are not shown). **← Skills** goes back to the list.

The checkbox before each skill turns it on or off for the agent. An off skill is
dimmed and marked "(off)": the `skill` tool doesn't offer it and won't load it, and
its `@id` is left as you typed it. Its files stay in `/agent/skills`, where the
agent's other tools can still see them. The choice is kept in this browser with the
settings; a deleted skill's is forgotten, so importing it again turns it on.

Skills are kept in this browser (IndexedDB) and mounted in the VM at
`/agent/skills/<id>`, so the agent's tools can read and run a skill's files. The
page lists them as soon as it loads, before the VM has booted, and looks again
before each message, so a skill made or edited from inside the VM counts too.

There are two ways to use one:
- **`@id` in your message.** Before the message is sent, each `@id` of a skill you
  have on is replaced by that skill's `SKILL.md`, without its frontmatter and on lines
  of its own. A note in the chat says which skills were included. The chat shows
  your message as you typed it.
- **The `skill` tool.** While you have skills on, the model gets a `skill` tool whose
  description lists each one's id and description. When a task matches one, the
  model calls it and gets back:

  ```
  [Loaded skill: <id>]
  Base directory: /agent/skills/<id>

  ---

  <the SKILL.md, without its frontmatter>
  ```

A change to the skills applies from your next message, in the same conversation.

### Machines

The **VM** tab picks the system the VM runs: **System** lists the distros the server
offers (`distro/index.json`, which `scripts/serve.mjs` and `scripts/build.mjs` write), with
their processor, **Memory** 128, 256 (the default) or 512 MB, and **x86 JIT** (on
by default; x86 systems only), which compiles hot guest code to WebAssembly. Turning
it off runs the interpreter alone, a way to rule the JIT out of a problem. A system for a
processor this page's engine can't run is listed but can't be picked (the engine
runs x86, riscv32 and riscv64). **Restart with these** keeps the choice in this browser and reloads the page
to boot it; the chats stay (see [Using the page](#using-the-page)). `?distro=`, `?mem=`, `?cfg=` and `?jit=` in the link override
the choice for that load. The tab also shows what is running, how it started and its
saved state, and, while the tab is open (sampled every 2 s):
- **Speed:** instructions per second the emulated CPU runs now, and on average while
  tool calls ran in the VM;
- **Instructions:** run since the machine booted. Like the disk figures, this
  counter lives in the machine's memory, so a resumed VM carries it on from the
  session that was saved;
- **Disk:** disk chunks downloaded, and their size as fetched;
- **Volume** `agent`, `workspace`, `skills`: the guest's reads and writes on each
  shared folder, and their bytes (`agent` carries the tool calls themselves);
- **Guest:** free memory, load averages and process count, as they were after the
  agent's latest Bash command;
- **Starts:** the average cold boot and resume time over the last 20 starts in this
  browser.

### Environment

The **Environment** section of the VM tab holds variables to set in the VM's shells:
**Add variable**, a name (letters, digits and `_`, not starting with a digit) and a
value, then **Save**. They are kept in this browser and apply:
- to every command the agent runs with Bash, in every shell (sub-agents' included),
  from the next command. They are set at the start of each command, after what the
  shell exported before: a command can change one for itself, and the next starts
  from the list again. A variable removed from the list goes from the shells too;
- to new login shells in the VM, through `/etc/profile.d/tinyemu-agent.sh`, which
  the page writes when the VM is ready and at each Save (the console's shell, already
  running, doesn't see them until `sh -l` or similar).

Values are stored as they are, like the API key: don't put secrets there on a shared
computer.

### Saved state

Reloading the page resumes the VM from a saved snapshot instead of booting it again.
Each system keeps its own saved state. The buttons are in the **VM** tab.
- **After a cold boot,** the page saves the VM as soon as it is ready. The snapshot is
  about 32 MB, and the VM pauses for about 0.1 s while it is taken.
- **Save state** saves the VM as it is now, including changes to its disk.
- **Fresh boot** forgets this system's saved state and reloads the page, after asking.
- **On resume,** the page reconnects to the guest and sets the guest's date, which
  stood still while the state was saved.
- **Automatic reboot:** the page boots from scratch, and saves a new state, if the
  saved one no longer matches the engine build, the VM config or the kernel and disk
  image, or if it fails to resume.

Changes outside `/workspace` made after the last save are lost on reload. Snapshots
only exist in the browser; the native `temu` can't save state.

### Data

The **Data** section of the VM tab lists what the page keeps in this browser: the
workspace's files and size and its linked folders, the skills, the saved states (of
every system), whether a connection is saved, and the site's total browser storage.
Its buttons each ask first, and are refused while the agent works:
- **Empty workspace** deletes everything in `/workspace`. Linked folders are only
  unlinked: the folders on your computer stay as they are.
- **Delete skills** deletes every imported skill.
- **Delete chats** deletes every chat and opens a new one.
- **Delete saved states** deletes the saved state of every system. The running VM
  carries on; the next reload boots from scratch.
- **Reset settings** puts the Settings tab, the VM tab's machine choice and its
  environment variables back to their defaults and reloads. The connection,
  workspace, skills, chats and saved states stay.
- **Delete everything** does all of the above, chats included, also deletes the
  saved connection with its API key, and reloads, so the VM boots from scratch.

### Kernel arguments

The page appends these to an x86 distro's own (a RISC-V distro gets only
`loglevel=7`: it keeps time with the CLINT timer, which follows host time):
- `earlyprintk=ttyS0 loglevel=7` puts the boot log on the console from the start.
- `tsc_early_khz=100000 tsc=reliable` lets the guest keep time with the TSC, which the
  emulator runs at 100 MHz of host time. Linux can't calibrate the TSC against the
  emulated PIT, so without these it counts 1000 Hz timer ticks, which the emulator
  can't deliver, and the guest clock ran 15-45% slow.
- `highres=off nohz=off` keep the timer tick periodic, which is much cheaper to
  emulate than reprogramming the PIT for every timer.

### URL parameters

| Parameter | Effect |
|-----------|--------|
| `?nosnapshot=1` | Don't resume or save the VM state |
| `?mem=<MB>` | Guest memory, instead of the VM tab's choice (default 256) |
| `?distro=<name>` | Boot `distro/<name>/guest.cfg` instead of the VM tab's choice (default `debian-13-riscv64-lite`) |
| `?cfg=<url>` | Boot any TinyEMU config instead of the distro's `guest.cfg` |
| `?jittail=1` | x86 guests: chain the JIT's compiled pages with WebAssembly tail calls instead of through C. Slower in tests (Chrome 156), so off; for comparing as browsers change. Part of the saved state's fingerprint |
| `?jit=0` / `?jit=1` | x86 guests: turn the engine's x86-to-WebAssembly JIT off or on, instead of the VM tab's choice (default on). Against the interpreter alone it boots Alpine x86 in ~10 s instead of ~16, and, once warm, runs a shell loop and Python about twice as fast. It is part of the saved state's fingerprint, so switching it cold-boots |
| `?baseURL=<url>` | Send Claude requests to a local proxy or test server (localhost only) |

## Tools

All the tool calls in one model message run at the same time.

- **Bash** runs a command in a new session, so a timeout or Stop kills the whole
  process tree. It runs in a **shell**: a name that keeps a working directory (it
  starts in `/workspace`) and the exported variables (`export NAME=value`) from one
  call to the next; other variables and functions don't carry over. The main agent's
  shell is `main`, and each sub-agent has its own, so a sub-agent's `cd` doesn't move
  the main agent. The model can name another shell (Bash's `shell` input) to keep
  parallel work apart, such as a server in one and tests in another; a new one starts
  as a copy of the caller's. When a call moves its shell (a `cd`, even one inside
  `cd dir && cmd` whose command then fails), its result ends with a note naming the
  new directory, since later commands and relative paths in the file tools start
  there. Without it, a model can lose track and spread its files over two folders.
  Calls run in parallel whatever their shells. The default
  timeout is 30 minutes (set in Settings, next to Bash) and the maximum 2 hours; when
  it runs out, or on Stop, the command and everything it started are killed at once.
  A command is killed after 2 MB of output; the model sees at most the tool output
  limit of it (below).
- **Bash with `run_in_background`** returns at once with the job's output file, exit
  code file and kill command, so the model can keep working and check later. These
  jobs have no timeout or output cap, and Stop doesn't end them.
- **Read** returns numbered lines, 2000 by default, and refuses binary files and
  anything over 20 MB.
- **Edit** replaces text that must match exactly once, and refuses files that aren't
  valid UTF-8.
- **Write** creates or overwrites a file, making its folders.
- **Read, Edit and Write of `/workspace` and `/agent/skills`** are done by the page
  itself, on the browser's copy the guest mounts, without a trip through the VM: they
  take milliseconds instead of seconds, and work while the VM still boots. Other
  paths, and paths with `..`, go through the VM. If the guest turns out not to have
  those folders mounted, or Settings turns this off, every path goes through the VM.
- **Glob** and **Grep** skip `.git`, `node_modules`, `/proc`, `/sys`, `/dev` and the
  tools' bridge folder. Grep uses POSIX extended regular expressions, and its
  `include` filter matches file names only. Results stop at 1000 files and 500 lines.
- **skill**, only while you have skills, loads one skill's instructions (see
  [Skills](#skills)). It reads them in the page, so it works while the VM boots.
- **Delegate** hands a task to a sub-agent: a new conversation with the same model
  and the same tools, except Delegate and ask_user, so sub-agents can't start their
  own or ask you anything. It sees only the prompt the model writes for it, and only
  its final message comes back as the result. Its card shows its progress (each tool
  call, and any that failed) and then its report; its whole conversation is in its own
  chat tab. It works in its own shell, which starts where the caller's is. It
  compacts its context like the main agent, keeping its task word for word. If its
  turn ends without a report (cut off at the output limit, out of steps, an empty
  reply), it is asked for one, without tools, up to twice; an error is asked again
  once. It stops after 50 steps, and Stop ends it too. Several Delegate calls in one message
  run at the same time, up to 4 at once (both numbers are set in Settings, next to
  Delegate); the rest wait their turn, and their cards say so. With an in-browser model
  they take turns anyway, since it answers one at a time.
- **ask_user** asks you one or more questions with suggested answers and waits for
  yours (see [Using the page](#using-the-page)). Only the main agent has it.
- **Tool names** are matched without case or separators: a model that calls `bash`
  or `AskUser` gets Bash or ask_user.
- **The tool output limit:** a result longer than the limit (30,000 characters by
  default, set in Settings → Agent), or than a quarter of the context window, reaches
  the model cut: its start and its end, with a note of what was left out and how to
  read the rest. The card shows the same.
- **Timeouts and a paused page:** when the browser stops the page (a frozen background
  tab, a sleeping computer, the debugger), the VM stops with it. That time doesn't
  count toward tool timeouts, a request to the model that failed during it is sent
  again once, and the chat notes the pause. The VM's timers leave the pause out too,
  so the guest doesn't see minutes pass in one tick (which Linux reports as an RCU
  stall); the page then sets the guest's date again. Settings → Keep running has
  ways to avoid the pause.
- **No connection:** when the model can't be reached (no internet, a dropped
  connection: "Failed to fetch"), the agent waits and asks again, 5 s twice, then 10 s
  twice, then every 20 s, for as long as it takes. It tries at once when the browser
  says it is back online. The chat notes the outage once and counts down to the next
  try; Stop ends the wait. Sub-agents wait the same way instead of failing. Errors the
  server answered (a bad key, a rejected request) are not retried this way.

### Settings

The **Settings** tab, next to Chat, has:
- **Tools:** a checkbox per tool. A tool you turn off is taken away from the model
  from your next message on, in the same conversation, and sub-agents don't get it
  either. Under Bash, its default timeout; under Delegate, how many sub-agents run at
  once (0 for no limit) and how many steps each may take.
- **Features:** whether `@id` mentions are replaced by the skill's instructions,
  whether the model's thinking shows in the chat (turning it off hides blocks
  already there too), and whether Read, Edit and Write of `/workspace` and
  `/agent/skills` are served by the page (on by default; off sends them through the
  VM like other paths, which is slower), and whether Bash runs in
  [bash.js](https://github.com/GramThanos/bash.js) instead of the VM (off by default).
  bash.js is a bash interpreter written in JavaScript, running in the page. It is
  fast, and it doesn't wait for the VM's console or CPU. But only bash itself and its
  own commands exist (cat, ls, grep, rg, find, sed, awk, sort, diff, patch and a few
  more): no program from the VM, so no python, make or apk. Its files are
  `/workspace` and `/agent/skills` (the same files the VM sees) and an in-memory
  `/tmp`; nothing else. Files are treated as UTF-8 text. `run_in_background` isn't
  offered. The Bash tool's description changes to say all this, so the model knows.
  A command can't be interrupted inside bash.js: Stop and the timeout answer at once,
  and the command finishes on its own (its loops are bounded). Glob, Grep and the
  file tools are unchanged.
- **Keep running:** what keeps the browser from stopping the page while the agent
  works (only while a turn runs):
  - a Screen Wake Lock, on by default, so the screen stays on and the computer
    doesn't sleep. Browsers drop it while the tab is hidden; the page asks again when
    it's back. Some embedded browsers refuse it, and the line under the options says so;
  - a very quiet low tone every 15 s, off by default. Chrome and Edge don't freeze or
    throttle a tab that plays sound. The tab shows a speaker icon, and the tone waits
    for your next click if the browser didn't allow sound yet;
  - **Browser settings that help:** where to exempt the site in Chrome (Memory
    Saver's "Always keep these sites active", Energy Saver) and Edge (sleeping
    tabs), Firefox's `browser.tabs.unloadOnLowMemory`, and keeping the window in view.
- **Agent:** the most steps (model replies) per message, 100 by default, how many
  times an empty response is asked for again, and the tool output limit. A change
  applies at once, even to a turn in progress.
- **System prompt:** the instructions the model gets, editable. **Save** applies it from
  your next message, in the same conversation, and sub-agents get it too, with their own
  instructions added; **Reset to default** goes back to the built-in one. With Claude, a
  change makes the next request miss the prompt cache once. `{{VAR_ARCH}}` and
  `{{VAR_OS_NAME}}` in it are replaced, in what the model gets, with the running
  machine's processor and system as the VM tab names them (`riscv64`, `Debian 13`); the
  built-in prompt uses both. A `?cfg=` machine isn't in the VM tab's list, so it gets
  `see uname -m` and `Linux`. `{{VAR_MODEL_NAME}}` is the connected model's name as
  its provider lists it (`Claude Opus 5.5`), and `{{VAR_MODEL_ID}}` its id
  (`claude-opus-5-5`). The name falls back to the id when the listing has none (WebLLM).
  Before a model is connected, both stay as written. Under the editor, a list shows each variable with what it
  stands for and its current value; clicking one inserts it at the cursor.
- **Context:** automatic compaction on or off and its threshold, the context window
  if the model doesn't report it, and the conversation's context figures (see
  [Context and compaction](#context-and-compaction)).
- **Token usage** for the open chat: requests, input, cache write, cache read,
  output and thinking tokens, for the main agent, its sub-agents, compaction and in
  total (in a sub-agent's chat, its own). A new
  conversation starts from zero, and **Reset** sets it back to zero. Input counts
  uncached tokens only. Output includes thinking: Claude doesn't report thinking
  tokens apart, so that column shows —; OpenAI-style APIs that report reasoning
  tokens fill it in. The chat's tab bar shows the totals in short.
- **Tool calls** in this conversation, sub-agents' included: per tool, calls,
  failures, total and average time, and the longest. **Reset** starts it again.

The settings are kept in this browser.

### Log

The **Log** tab, next to Settings, lists every exchange of the conversation as JSON,
sub-agents' included: each message you sent (and when one arrived during a turn),
each model reply with its text, thinking, tool calls, stop reason, token usage and
time, each tool call with its input, result and time, each sub-agent's start (its
task, prompt and shell) and each compaction. A row shows the time, the agent and a
preview; open it for the JSON. The menu shows one agent's rows.
- **Export** saves the log as a JSON file, with the conversation as the provider holds
  it (no API key is in either).
- **Import** opens an exported log in the tab. If a model of the same kind is
  connected (Claude, OpenAI-compatible or in-browser), the page offers to restore that
  conversation into it: your next message carries on from it, though the chat doesn't
  show the earlier messages.
- **Clear** empties the log; the conversation goes on.

Each chat keeps its own log (the latest 2000 exchanges are saved with it); a
sub-agent's exchanges are in its chat's log and its main chat's.

### Context and compaction

A model reads its whole conversation with every request, and that has to fit its
context window. A long task (big files, long command output, many steps) fills it,
so the page compacts the conversation: the same model writes a summary of everything
so far, and the summary replaces the history. The agent carries on from the summary.
Its files and changes in the VM are untouched, and it can read them again.

**The meter** in the chat's tab bar shows how much of the window the conversation
fills (`45.2k / 200k`), as of the last response; `~` marks an estimate, right after
a compaction. The bar turns amber near the threshold and red past it, and the tick
marks where automatic compaction starts. `⟲2` counts compactions. **Click it** for
the Context panel: how full the window is, as one bar split into parts, and a row for
each part with its tokens and share of the window: Messages, Tool definitions (and,
folded, each tool's), Skills (the `skill` tool's list), System prompt, the Compaction
buffer (the part past where automatic compaction starts, which stays free) and Free
space. Only the total is measured; the system prompt and tool definitions are
estimated from their text, at about 4 characters a token, and Messages is the rest.
Its tooltip, and
Settings → Context, give the details: the window and where it comes from, the tokens
in use, where compaction starts, compactions (the conversation's and its
sub-agents'), and the last one's size before and after.

**When it compacts:**
- **Automatically**, when the context passes the threshold (80% by default): before
  your next message, or between the steps of a long task, which then goes on. The
  threshold leaves room for a reply as well: for Claude, 80% of the window less the
  64k a reply may use (at most half the window).
- **When the model says the conversation is too long**: the page compacts and sends
  the request again, once.
- **By hand**, with **Compact** (not while the agent is working).

Each compaction appears in the chat as a line with the sizes before and after;
expand it to read the summary the agent now works from. A sub-agent compacts its own
conversation the same way, and its card says so. Compaction costs a request, counted
under Compaction in the token table. If writing a summary fails, the page says so and
carries on without compacting.

**The context window** comes from the model listing where the provider reports it:
Claude's models do (`max_input_tokens`), as do OpenRouter, LM Studio, vLLM and
llama.cpp servers; in-browser models have 8192. When it is unknown (Gemini and OpenAI
among them), the page assumes 128,000 tokens and says so; set the right number in
Settings → Context. A value there overrides the model's for every conversation.

Calls that read or change the same file through Read, Edit and Write apply in the
order the model made them. Nothing orders Bash against other calls; if parallel Bash
calls change directory, the last to finish wins.

## The server

`scripts/serve.mjs` is a small static server with no dependencies:

```
node scripts/serve.mjs --distro <build dir or URL> [--distro ...] [--name <name>] [--host <addr>] [port]
```

| Option | Default | Meaning |
|--------|---------|---------|
| `--distro` | `AGENT_DISTRO` | A TinyEMU-distros `build/<name>/` directory, or the URL of a published copy |
| `--name` | the directory's name | The name the page asks for (`?distro=`; the page's default is `debian-13-riscv64-lite`) |
| `--host` | `HOST`, else `127.0.0.1` | Address to listen on; `0.0.0.0` opens it to your network |
| port | `PORT`, else `8000` | Port to listen on |

It serves:
- this repository, so the page is at `/` and loads jsLab, bash.js and the engine
  from `deps/`;
- the distro at `/distro/<name>/`, where the built site has it too. A URL distro is
  downloaded once into `.cache/`, kernel and disk included, so its host needs no
  CORS headers;
- `/distro/<name>/guest.cfg`, the config the page boots: the distro's
  `config.cfg` with three changes. The kernel and disk are named relative to it (so
  the same page works from any host and path; a published copy names them by its
  own URL, which is taken off too), network devices are removed, and
  three JS volumes are added: `agent` (the tools' bridge), `workspace` and `skills`.
  The engine takes at most four, so the distro's config can use one more.

Files are sent with `Cache-Control: no-store`, so a rebuilt engine or edited page is
never served stale, and with `Last-Modified`, which tells a saved VM state that the
kernel or disk changed.

**Using it from another computer:** start it with `--host 0.0.0.0` and it prints the
addresses to open. Over plain HTTP to anything but localhost the page isn't a
secure context. The browser then hides WebGPU, so only the API providers work. API
keys still go from the browser straight to the provider over HTTPS, but anyone who
can tamper with your network traffic could alter the page itself.

**A distro needs** 9p support in its kernel (TinyEMU-distros kernels have it),
`/bin/sh`, and `mount`, `setsid`, `mktemp` and `date`, all of which busybox
provides. It must boot to a shell prompt on the console.

## Publishing

`scripts/build.mjs` assembles the site, a static site with the engine and the
distros, into a directory (`_site/`, git-ignored):

```bash
node scripts/build.mjs --distro <TinyEMU-distros build/<name> directory> [--distro ...] --out _site
```

**The `deploy` workflow** does this on GitHub and publishes the result to Pages. Run
it by hand (Actions → deploy → Run workflow); its inputs are the engine (`source`
builds `deps/TinyEMU` with Emscripten, or a version from TinyEMU's Pages such as
`latest`), the distros (by default the four `-lite` ones, `debian-13-riscv64-lite` first), and
the TinyEMU-distros release to take them from (made by that repository's `release`
workflow, one release with every distro; empty means the latest). Pages must be
set to deploy from GitHub Actions (Settings → Pages → Source).

It writes:
- `index.html` and `js/`, from here;
- `engine/`, the files of jsLab (`deps/jsLab/lib/`) that the page loads (followed
  from its imports, so nothing is listed by hand), and the engine from
  `deps/jsLab/engine/`;
- `vendor/bash.js`, from `deps/bash.js`. These two keep the layout the site had
  before the submodules, so saved VM states stay valid;
- `distro/<name>/`: `config.cfg`, `kernel.bin` (and `bios.bin` for RISC-V), `blk.txt`
  and the chunks (raw `blk*.bin` or gzipped `blk*.bin.gz`, as `blk.txt` says), plus the
  generated `guest.cfg`. `rootfs.ext2` is left out, since the chunks are the same disk;
- `README.md` (from `scripts/release-README.md`), `LICENSE`, `LICENSES/` (jsLab's,
  bash.js's and TinyEMU's), `.nojekyll` (no Jekyll on Pages), and `build-info.json`:
  the commit it came from (and whether it had uncommitted changes), the submodules'
  commits, the engine's version and hash, and the distros.

Relative paths in the code are rewritten for the release's layout, and the output's
imports are checked again. The output directory is emptied first, except `.git` and
`CNAME`; to guard against a typo it must be empty, a git checkout or an earlier build.

**On GitHub Pages**, the four default distros come to about 180 MB of images
(TinyEMU-distros' `distros-20261122-5` release), within Pages' limits (1 GB site,
100 MB per file). Pages lets browsers cache files for 10 minutes and its headers
can't be changed: right after a release, a browser can mix old and new files and fail
with `vm_start failed: Aborted()`, which a hard reload fixes. Saved VM states are
matched by each file's ETag there, so a release that changes the engine, kernel or
disk makes the next load boot from scratch, and one that doesn't keeps them.

**Licences:** the agent is GPL-3.0-or-later, as is jsLab; the engine (TinyEMU) and
bash.js are MIT. A distro is none of these: the Linux kernel and
BusyBox are GPL-2.0 and Alpine's packages carry their own licences, so publishing one
comes with their terms. The release README says so and points at the
TinyEMU-distros recipe.

### The engine

The page uses `deps/jsLab/engine/x86emu-wasm.js` and `.wasm`, TinyEMU's WebAssembly
build. `deps/jsLab/scripts/fetch-engine.mjs [version]` downloads a release from
TinyEMU's GitHub Pages (checked against its `SHA256SUMS`). To build it from the
`deps/TinyEMU` submodule instead, with Docker:

```bash
docker run --rm -v "$PWD/deps/TinyEMU":/src -w /src emscripten/emsdk:3.1.74 make -f Makefile.js
node deps/jsLab/scripts/fetch-engine.mjs --from deps/TinyEMU/dist/wasm
```

On Windows Git Bash, use `MSYS_NO_PATHCONV=1` and `"$(pwd -W)"` in place of `"$PWD"`.
A new engine invalidates saved VM states, so the next load boots from scratch.

The page needs an engine that resolves a drive's path relative to its config file,
as it does the kernel's (`init_vm_drive_next` in `jsemu.c`): `guest.cfg` names the
disk relatively. An older build fetches it relative to the worker script, and the
boot aborts.

## What the browser keeps

| Where | Name | What |
|-------|------|------|
| IndexedDB | `tinyemu-agent-workspace` | The `/workspace` folder |
| IndexedDB | `tinyemu-agent-skills` | The imported skills (`/agent/skills`) |
| IndexedDB | `tinyemu-agent-links` | Linked folders: where each is, the browser's handle to it, and its sync state |
| IndexedDB | `tinyemu-snapshots` | The saved VM state |
| IndexedDB | `tinyemu-agent-bridge` | The tools' bridge folder (scripts, nothing of yours) |
| IndexedDB | `tinyemu-agent-chats` | The chats: messages, the model's conversation, figures and log |
| localStorage | `tinyemu-agent-active-chat` | Which chat is open |
| localStorage | `tinyemu-agent-env` | The VM tab's environment variables |
| localStorage | `tinyemu-agent-vm-settings` | The VM tab's system and memory |
| localStorage | `tinyemu-agent-connection` | The saved provider, URL, API key and model |
| localStorage | `tinyemu-agent-tool-cards-open` | Whether tool cards start open |
| localStorage | `tinyemu-agent-settings` | Turned-off tools, features (Settings) and the thinking level |

The VM tab's **Data** section deletes any of these (see [Data](#data)). **Clear saved**
removes the connection, **Fresh boot** the VM state, **×** on a chat's tab that chat,
and deleting
files in the Files tab removes them from the workspace, and **Delete** in the Skills
tab a skill. Clearing this site's data in
the browser removes all of it.

## Security

- **The VM is the sandbox.** The tools aren't confined to a folder, because the whole
  guest is the agent's to use. The guest has no network device.
- **Nothing from the guest or the model runs in the page.** Their text, file names and
  file previews included, only ever goes into the page as text, never as HTML. A
  file reaches your computer only when you press Download.
- **API keys** go only to the provider you chose, never to the guest. They are saved
  in this browser's localStorage once a model connects, until you press
  **Clear saved**. Anyone who can run script in this page or read this browser's
  storage could read them, so use keys you can revoke.
- **Text the model reads in the VM** can steer what it does next, but only within the
  VM and the workspace. That includes skills: import only ones you trust, since
  their instructions go to the model as yours.
- **A linked folder is the one way out of the VM:** the agent can change and delete
  files in it, and those changes reach your computer. Link only folders you're
  willing to have it edit, and keep them under version control or backed up.

## How it works

**The tools' bridge.** The VM's console can't carry data reliably: its input buffer
is 1 KB and drops what overflows, and the terminal limits line length. So the page uses
the console once, to mount a shared folder (a 9p volume backed by JavaScript) and start
a small guest daemon, `agentd`. After that each tool call is a folder on that volume.
The page writes a script and any input files, `agentd` runs it, and the page polls for
the output and exit code. Polling adds about 0.5 s to each call. Timeouts are measured
by the page's clock, not the guest's.

**The workspace** is a second shared folder of the same kind, mounted at `/workspace`
and saved to IndexedDB. **Skills** are a third, mounted at `/agent/skills`. The page
reads that one straight from IndexedDB at load, and through the running VM after.

**Saved state.** In the browser, the whole emulated machine (guest RAM, CPU and
devices) lives in the engine's single WebAssembly memory. A snapshot is that memory,
minus empty pages, plus the disk blocks the engine keeps outside it. Restoring copies
it into a fresh engine. The full design is in `deps/jsLab/docs/runtime.md` under
Snapshots.

The details are in the code: [js/GuestBridge.js](js/GuestBridge.js) for the bridge's
layout, [js/tools.js](js/tools.js) for the tools, and [js/Agent.js](js/Agent.js) for
the agent loop and provider interface.

## Tests

```bash
node tests/tools.test.mjs
```

The 114 tests cover:
- the tools' real shell scripts, run with a local `sh` (Git Bash works on Windows)
  against a temp folder;
- the agent loop: parallel calls, call order, Stop, and waiting for a booting VM;
- the in-browser models' text tool protocol;
- the OpenAI-compatible provider and model listing, against a fake `fetch`;
- skills: `SKILL.md` parsing, `@id` expansion, grouping imported folders, the
  `skill` tool, turning a skill off, and handing a changed tool list to the provider;
- Delegate's sub-agents (no ask_user for them, only their final report, asking again
  for a report cut off at the output limit, the view the page draws them with),
  turning tools off, token usage reporting, and the thinking level sent to
  OpenAI-compatible APIs;
- loose tool names, ask_user's questions and answers, the tool output limit, stopping
  one call, resuming a turn a reload cut off, asking again after a paused page, and
  waiting out a lost connection (its 5/10/20 s schedule, Stop, sub-agents);
- linked folders, against an in-memory stand-in for the browser's folder handles:
  linking, syncing both ways, conflicts, deletions, unlinking, reloads and the size cap;
- the `guest.cfg` made from a distro's `config.cfg`;
- context compaction: the transcript, overflow errors, automatic compaction before a
  message and between steps, the retry after a too-long error, failures and the off
  switch, the threshold, manual compaction, each provider's transcript and reset, and
  context windows from model listings.

They don't boot a VM or call a real model.

## Troubleshooting

- **"boot failed: vm_start failed: Aborted()" on the published site, right after a
  release.** The browser mixed cached and new files; do a hard reload (Ctrl+Shift+R).
- **The boot takes much longer than a minute.** Browsers slow down background tabs.
  Keep the tab visible while it boots.
- **"Could not list the models: Failed to fetch".** For a custom server, it isn't
  running, or doesn't allow requests from this page (CORS). For other providers,
  check your connection.
- **"API error 400/401" when listing models.** The key is wrong or doesn't belong to
  the selected provider.
- **"API error 503", "429".** The provider is overloaded or you hit a rate limit;
  the page already retried. Wait, or pick another model.
- **WebGPU models are missing.** The browser has no WebGPU, or the page isn't a secure
  context (opened over plain HTTP from another computer).
- **Tool calls say the VM is still booting.** They wait 60 s; the model can retry
  once the badge says VM ready.
- **The VM always boots from scratch.** Saving needs IndexedDB, which a private window
  or blocked site data can prevent. `?nosnapshot=1` also turns it off.
- **Something looks stuck after resuming.** Press **Fresh boot**.

## Files

| File | Purpose |
|------|---------|
| [index.html](index.html) | The page: layout, chat, model picker, VM startup and saved state |
| [scripts/serve.mjs](scripts/serve.mjs) | The dev server: this repository, the distro and its `guest.cfg` |
| [scripts/build.mjs](scripts/build.mjs) | Builds the site: the page, the engine, jsLab, bash.js and the distros |
| [scripts/add-submodules.sh](scripts/add-submodules.sh) | Registers the `deps/` submodules (once) |
| [.github/workflows/deploy.yml](.github/workflows/deploy.yml) | Builds the site and deploys it to GitHub Pages (run by hand) |
| [scripts/guest-config.mjs](scripts/guest-config.mjs) | How `guest.cfg` is made from a distro's `config.cfg` |
| [scripts/release-README.md](scripts/release-README.md) | The README a release gets |
| [js/Agent.js](js/Agent.js) | The agent loop, the system prompts, the provider interface, Delegate's sub-agents and when to compact |
| [js/compaction.js](js/compaction.js) | Compaction: the summary prompt, the transcript, overflow errors |
| [js/pause.js](js/pause.js) | Noticing when the browser paused the page, for timeouts |
| [js/keepAwake.js](js/keepAwake.js) | The wake lock and the quiet tone that keep the page running during a turn |
| [js/bashjs.js](js/bashjs.js) | Bash in bash.js, on the page's volumes, when Settings turns it on |
| [js/figures.js](js/figures.js) | What the Context and usage panels show, worked out from the agent and the chat |
| [js/tools.js](js/tools.js) | The tools, run as shell scripts in the guest (and `skill`, `ask_user`) |
| [js/skills.js](js/skills.js) | Skills: the library, `SKILL.md` parsing, `@id` expansion, the `skill` tool |
| [js/GuestBridge.js](js/GuestBridge.js) | The bridge to the guest: bootstrap, `agentd`, jobs |
| [js/FileBrowser.js](js/FileBrowser.js) | The Files tab |
| [js/chats.js](js/chats.js) | The chats' store and record shape |
| [js/zip.js](js/zip.js) | Folder downloads as .zip |
| [js/LinkedFolders.js](js/LinkedFolders.js) | Linked folders: linking, the sync (both ways, or read-only) and unlinking |
| [js/providers/claude.js](js/providers/claude.js) | Claude, through the Anthropic SDK |
| [js/providers/openai.js](js/providers/openai.js) | Any OpenAI-compatible API, including Gemini |
| [js/providers/webllm.js](js/providers/webllm.js) | Local models through WebLLM |
| [js/providers/toolProtocol.js](js/providers/toolProtocol.js) | The text tool-call format for local models |
| [tests/tools.test.mjs](tests/tools.test.mjs) | The tests |

The VM runtime it builds on (`VMManager`, snapshots, volumes) is jsLab, in
`deps/jsLab/lib/` and described in `deps/jsLab/docs/`. bash.js is `deps/bash.js`.
