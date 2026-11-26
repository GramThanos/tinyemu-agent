# TinyEMU Agent

A chat page that turns your browser into an AI agent's computer. Each chat's tools run
in an **environment**: [bash.js](https://github.com/gramthanos/bash.js) in the page,
or a Linux VM, TinyEMU's x86 or RISC-V emulator compiled to WebAssembly. Chats are
grouped into **projects**, each with its own files. The model gets six tools (Read,
Edit, Write, Glob, Grep and Bash), and they all act in the chat's environment, plus a
`skill` tool for any [skills](#skills) you import, a `Delegate` tool that hands a task
to a sub-agent, and `ask_user`, with which it asks you questions. You can turn any of
them off in [Settings](#settings).
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
- [Projects and environments](#projects-and-environments)
- [Models](#models)
- [Integrations (MCP servers)](#integrations-mcp-servers)
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
- Node.js 20.19 or 22.12 or later, with npm;
- the submodules (`git submodule update --init`) and the build tools (`npm install`);
- a current browser: Chrome 95+, Safari 15.4+ or Firefox 131+, for WebAssembly
  exception handling;
- a connection to GitHub Pages: the page loads the emulator from
  [TinyEMU's Pages](https://gramthanos.github.io/TinyEMU/) and the systems from
  [TinyEMU-distros' Pages](https://gramthanos.github.io/TinyEMU-distros/). Nothing
  needs downloading first.

```bash
npm install
npm run dev
```

Then open <http://localhost:8000/>. (`npm run dev` is Vite's dev server: a change to
the page's code shows at once. To use a built copy instead, see
[Publishing](#publishing).)

1. Open **⚙ Settings** (bottom left) → **Models**, pick a kind of provider and press
   **Add provider**. Paste its API key (or a URL, for an OpenAI-compatible server),
   press **List models** and tick the models chats should offer. **In this browser**
   needs no key.
2. Close Settings. The open chat, in the project **My project**, picks the first model
   you ticked; the **model** chip in the message box changes it.
3. The **environment** chip beside it says where the tools run. The first project
   starts in Debian 13 RISC-V lite (`debian-13-riscv64-lite`), which boots in the
   background; pick **bash.js** to start at once, or any system TinyEMU-distros
   publishes (see [Machines](#machines)).
4. Ask for something, for example "write a C program in /workspace that prints the
   primes below 100, compile it and run it" (in a VM: bash.js has no compiler).

## Using the page

The page has three columns:
- **The sidebar**, on the left: **+ New chat**, then the **projects**, each with its
  chats, the latest first. Click a project's name to show or hide its chats; **+** on
  its row starts a chat in it, **⋯** (or double-clicking the name) opens its settings
  (see [Projects and environments](#projects-and-environments)). **+** beside
  "Projects" makes a new one. At the bottom, **⚙ Settings** and a badge saying what
  the open chat's environment is doing (a VM's boot stage and seconds, and
  "downloading" while it fetches disk blocks, then **VM ready**). **«** hides the
  sidebar, **☰** shows it again; on a narrow screen it slides in.
- **Resizing:** drag the sidebar's right edge or the panel's left edge (they light up
  under the pointer). The chat always keeps at least 360 px. With a handle focused, ←/→
  move it by 16 px (64 with Shift); double-click it, or press Home, for the default
  width. The widths are kept in this browser; on a narrow screen there are no handles.
- **The chat**, in the middle: the project and the chat's name at the top (double-click
  the name to rename it), the conversation's token use, its context meter and
  **Compact** (see [Context and compaction](#context-and-compaction)), **ⓘ** for the
  chat's figures and **▣ Panel**. At the bottom, the message box, with the chat's
  **environment** and **model** chips and its **thinking** level under it.
- **The panel**, on the right, for the open chat's project and environment (**×** or
  **▣ Panel** hides it), with four tabs:
  - **Files**: the project's `/workspace` (see [Workspace](#workspace));
  - **Console**: the VM's terminal, when the chat works in a VM: a real terminal
    ([xterm.js](https://xtermjs.org/), part of the build, loaded the first time the tab shows),
    with colours, cursor keys and full-screen programs. Click it and type: keys go
    straight to the guest's shell, also while the agent works. It fits the panel as
    you resize it, and the guest's tty gets the same size (`stty size` agrees, a
    second or two later), so `vi`, `less` and `top` lay out right. Switching chats
    shows the other VM's recent output. If xterm.js can't load, it is plain text with
    a line to type in. bash.js has no console;
  - **Environment**: the chat's environment and the project's others (see
    [Machines](#machines) and [Saved state](#saved-state));
  - **Log**: every exchange of the chat (see [Log](#log)), and its token usage and
    tool calls.

**Chats** are kept in this browser, so a reload brings them back:
- **+ New chat** starts one in the open chat's project, with the project's
  environment and model (or the model the open chat uses). A chat is named after its
  first message; **×** on its row deletes it, after asking (an empty one goes at once),
  with its sub-agents' chats. If no other chat uses its VM, the page asks whether to
  delete that too (see [Projects and environments](#projects-and-environments)).
- **Several chats work at once.** Open another while the agent works: it carries on,
  and its row shows a spinner (and a **?** when it is asking you something). Each
  chat's Bash commands run in a shell of its own, so one chat's `cd` doesn't move
  another's; a project's files are shared by its chats.
- **Sub-agents' chats:** each sub-agent (see [Tools](#tools), Delegate) gets a chat of
  its own, **↳ its task**, under its main chat's row while that chat (or one of its
  sub-agents') is open. It shows the sub-agent's conversation as it happens: the task
  it was given, its replies, thinking and tool cards. It is read-only: the message box
  is off, and **Stop** stops that sub-agent alone (the main agent is told). The
  Delegate card's **open ↗** opens it; ✓ or ✗ on its row says how it ended.
- **ⓘ**, at the top, shows the open chat's usage, then its figures:
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
    - **Time:** waiting on the model, tools in the VM, tools the page served (bash.js
      included), tools on MCP servers, and waiting for your answers. Calls that ran side by side each count
      their own time;
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
  even after the Log drops its oldest exchanges.
- **What a chat keeps:** its project, environment and model, its messages, thinking,
  tool cards and compactions as the chat showed them, the model's own conversation,
  so the model carries on where it left off, and its token use, tool-call figures and
  Log exchanges (the latest 2000).
- **Changing the model** of a chat with history gives the new model that
  conversation, if it is written by the same kind of provider (Claude, OpenAI-style,
  or in this browser): each keeps it in its own format. Otherwise the chat says so and
  the model starts without the earlier messages, though they stay on screen.
- A tool call that was running when the page closed shows as **interrupted**.
- **After a reload in the middle of a turn,** the page asks whether to carry on.
  **Resume** carries each chat on with its own model and environment, and each
  interrupted sub-agent from its saved conversation; when it reports, the main agent
  gets the report as its Delegate result and goes on. Commands that were running are
  not run again: the agent is told they were cut off. **Leave it stopped** marks them
  interrupted, and the chat waits for your next message.

In the chat:
- **Enter** sends and **Shift+Enter** starts a new line. While the agent works, the
  send button becomes **■** (Stop), as does **Escape** in the message box.
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
- **Long chats:** the chat follows new output while you're at its end; scroll up to
  read and it stays where you are until you scroll back down (sending a message goes
  to the end). Only the last 150 entries are drawn: scroll to the top, or press
  **Show earlier**, for 150 more.
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
- **`@` picks a skill:** typing `@` at the start of a word lists the skills that are on,
  narrowed as you type (by id first, then by name). **↑**/**↓** choose, **Enter** or
  **Tab** writes `@id`, **Escape** closes the list; a click works too. `@id` includes the
  skill's instructions in the message (see [Skills](#skills)). An `@` inside a word, as
  in an email address, opens nothing.

You can send a message before a chat's VM has finished booting: its first tool call
waits for it (and shows "[starting …]" in its card).

## Projects and environments

A **project** is a workspace, the files of its chats, and what its new chats start
with. **⋯** on a project's row (or **+** beside "Projects", for a new one) opens its
settings:
- **Name.**
- **New chats start with** an **environment** (bash.js, or a system, with its memory
  and, for x86, the JIT) and a **model** ("the last one picked" uses the open chat's).
  A chat changes either for itself with the chips in its message box.
- **Files and folders:** the project's linked folders, and buttons to link a folder,
  upload files, or open the Files panel on its workspace. The workspace is the
  project's own: each project has its own `/workspace`, in every environment its
  chats use.
- **Environment variables**, set in every shell of the project's chats (see
  [Environment variables](#environment-variables)).
- **Delete project** asks first, listing what goes: its chats, its workspace (how
  many files, how much), its machines' saved states and running VMs. Then it deletes
  all of it from this browser, the databases its volumes were kept in included.
  Linked folders are only unlinked. Download any files you want to keep first. The
  last project can't be deleted.

The first project, **My project**, is what the page had before projects: its
workspace, linked folders, chats, saved VM states and environment variables carry on
in it.

**Environments.** A chat's tools run in one of its project's environments:
- **bash.js**, in the page: bash and its own utilities (cat, ls, grep, rg, find, sed,
  awk, sort, diff, patch and a few more) on `/workspace`, `/agent/skills` and an
  in-memory `/tmp`; nothing else, so no python, make or compiler. It starts at once,
  works while a VM is busy, and costs nothing idle. Files are treated as UTF-8 text,
  and `run_in_background` isn't offered. The Bash tool's description says all this,
  so the model knows. A command can't be interrupted inside bash.js: Stop and the
  timeout answer at once, and the command finishes on its own (its loops are
  bounded).
- **A TinyEMU machine** (see [Machines](#machines)): a real Linux, root, with its own
  programs.

Chats of a project that pick the same environment **share** it, each in its own
shell: a first chat on bash.js, a second one joins it; the second switches to a RISC-V
machine, which starts; a third picks the same machine and shares that VM; switching it
back to bash.js joins the project's bash.js again. Switching starts the new
environment at once, in the background, and the chat says so; its shells start again
in `/workspace`.

**One VM per project at a time.** A project's VMs all work on its workspace, which
only one of them can hold. So starting another machine in the project first pauses
the one running, once no chat is working in it (its chats wait until then), and a
chat that uses the paused one later gets it back the same way, resumed in seconds.
VMs of different projects run side by side; each takes its memory (128 to 512 MB).

**Pausing.** A paused VM's state is saved and the VM stops, freeing its memory; the
next tool call that needs it resumes it. A VM nobody works in, none of whose chats is
open, is paused by itself after 10 minutes (Settings → Agent; 0 turns it off). The
**Environment** tab's **Pause** does it at once.

**Deleting a chat** whose VM no other chat of the project uses asks whether to delete
the VM too: **Delete the environment** stops it and deletes its saved state (the next
chat that picks that machine boots it afresh); **Keep it** leaves it, to be paused
when idle. The workspace stays either way. The **Environment** tab lists the project's
environments, who uses each, and **Pause** and **Delete** buttons.

## Models

Models come from **providers** you set up in **Settings → Models**:

| Provider | Needs | How it is called |
|----------|-------|------------------|
| Claude (Anthropic) | An Anthropic API key | Anthropic SDK, native tool use, streamed |
| OpenAI | An OpenAI API key | OpenAI-compatible API (`api.openai.com/v1`) |
| Gemini (Google AI Studio) | A key from [Google AI Studio](https://aistudio.google.com/apikey); there's a free tier | Gemini's OpenAI-compatible endpoint (`generativelanguage.googleapis.com/v1beta/openai`) |
| OpenRouter | An OpenRouter key | OpenAI-compatible API; the page names itself to it (`X-Title`, `HTTP-Referer`) |
| Mistral, Groq, DeepSeek, xAI (Grok), Moonshot (Kimi), Together AI, Fireworks, Cerebras, DeepInfra, Hugging Face (Inference Providers) | That provider's API key | Each one's OpenAI-compatible API |
| On this computer: Ollama, LM Studio, Open WebUI, llama.cpp server, vLLM, LocalAI, Jan, KoboldCpp, text-generation-webui, GPT4All | The server running, and allowing this page (see below); a key only if it asks for one (Open WebUI does) | Its OpenAI-compatible API, at its usual address, which you can change |
| OpenAI-compatible API | Its base URL (such as `http://localhost:8080/v1`), and a key if it needs one | OpenAI-compatible API |
| In this browser (WebLLM) | WebGPU, and 2-5 GB of VRAM depending on the model | Runs on your GPU; tools are described in the prompt and calls parsed from the text |

- **Add provider** adds one of a kind; you can add several of a kind (two
  OpenAI-compatible servers, say) and name each.
- **List models** lists the models its key can use, from the provider's own API.
  Models that can't chat, such as embedding, speech and image models, are left out.
  Tick the ones the chats should offer; a long list has a filter. In-browser models
  are all offered when you add that provider.
- **A model's own settings:** the **⚙** after a model opens its settings, over what the
  provider says. Each one empty leaves it to the provider:
  - **Name**, shown in the model menu and the chip;
  - **Context window**, in tokens, which the context meter and compaction count
    against (more specific than the one in Settings → Context). For an in-browser
    model it is the window the model is loaded with, so it applies when it next loads;
  - **Max response**, the tokens a reply may take, thinking included: Claude's
    `max_tokens` (64,000 when empty), OpenAI's `max_completion_tokens`, other APIs'
    `max_tokens` (nothing sent when empty: the server decides), 2048 for in-browser
    models. A smaller one leaves more of the window for the conversation;
  - **Temperature**, 0 to 2, sent only when set (not for Claude, which refuses it with
    thinking on; some reasoning models refuse it too, and the API says so).

  **Save** applies them from the next message of every chat on that model, and new
  chats start with them; **Reset** goes back to the provider's. The model's row lists
  what you set. They are kept with the provider, also when you list its models again.
- **The model chip** in a chat's message box lists the ticked models, by provider, and
  picks one for that chat. It is locked while the agent works. **Set up providers and
  models…** opens Settings.
- **Changing a key or URL** loads that provider afresh for the next message. Keys are
  saved with the provider in this browser until you **Remove** it, and each only ever
  goes to its own provider.
- **The connection saved before providers** (provider, URL, key and model) becomes a
  provider on the first load, with its model ticked.
- **Rate limits:** OpenAI-compatible providers answering 429 or 502-504 are retried
  four times, after the delay they ask for or a growing one. Free tiers are easy to
  hit with an agent loop.
- **A server on this computer** (or a custom one) must allow requests from this
  page's address (CORS), or its listing fails with "Failed to fetch" and a hint for
  that server:
  - Ollama: start it with `OLLAMA_ORIGINS` set to the page's address, or `*`;
  - LM Studio, Jan: turn on CORS in the local server's settings;
  - Open WebUI: set `CORS_ALLOW_ORIGIN`, and paste an API key from Settings → Account;
    its API is at `http://localhost:3000/api`;
  - vLLM: `--allowed-origins '["*"]'`, on a port other than the page's (both default to 8000);
  - LocalAI: `CORS=true`; text-generation-webui: `--api`; GPT4All: its "Enable Local
    API Server" setting; llama.cpp's server and KoboldCpp allow it by default.
- **Every cloud preset allows this page** (checked November 2026); a provider not in
  the list works as an OpenAI-compatible API if it allows browser requests.
- **How the providers differ**, which the page copes with: reasoning comes back as
  `reasoning_content` (DeepSeek, Moonshot, vLLM, llama.cpp), `reasoning` (Groq,
  OpenRouter, Together, Ollama) or as thinking parts of the reply (Mistral), and it
  goes back with the message under the same name, which Moonshot's and DeepSeek's
  thinking models need during tool calls; Gemini's thought signatures on tool calls
  go back on their call, which Gemini 3 and later require; OpenRouter's
  `reasoning_details` go back too.
- **Local models** (WebLLM) are far weaker at multi-step tool use than the API
  models, and their 8192-token context fills up quickly. Expect short tasks to work.
  The model downloads once and is then cached by the browser.

**Thinking**, in the message box, sets how much the model thinks:
- Claude: low, medium, high, xhigh or max (its `effort`), or the model's default.
  It starts at high. Not every model takes every level; the API says so if not.
- OpenAI-compatible APIs: none, minimal, low, medium, high or xhigh
  (`reasoning_effort`), or the model's default, which sends nothing, for servers
  that don't know the field. Which levels a model takes is its own (Gemini 2.5 Pro
  and later can't think "none", OpenAI's newer models refuse it, few have xhigh);
  the API says so if not.
- In-browser models have no such setting, so the menu is hidden for them.

A change applies from the next request of every chat on that kind of provider, in the
same conversation, and sub-agents started after it use it too. With Claude, changing
it mid-conversation re-reads the history once without the cache. The choice is
remembered per kind of provider in this browser.

Claude is called with adaptive thinking and with server-side refusal fallbacks for
Opus and Sonnet.

## Integrations (MCP servers)

**Settings → Integrations** adds [MCP](https://modelcontextprotocol.io/) servers, whose
tools every chat's agent then gets next to the built-in ones (sub-agents too), in any
environment. A server's tools are named `mcp__<server>__<tool>`; their cards show the
call's arguments in short. If two servers' tools would get the same name (two servers
of one name, say), the later one's gets `_2` added.

- **Add server**, then its **Name** (part of its tools' names), its **URL** (its MCP
  endpoint, often ending in `/mcp`) and any **Headers** it needs, such as
  `Authorization` with `Bearer <token>`; header values are hidden as you type them.
  **Connect** turns it on, connects and lists its tools.
- The card shows whether it is connected and how many tools it has, or why it
  failed. Untick a tool to keep it from the agent; untick the box before the name to
  turn the whole server off. **Reconnect** lists its tools again; the server's own
  instructions, if it sends any, are under the list. **Remove** deletes it from this
  browser.
- Servers that are on connect when the page loads, in the background. A change of URL
  or headers reconnects. A call to a server that dropped the connection connects
  again first; calls made while it connects wait for that one connection. A server
  that doesn't answer within 30 s of connecting counts as failed. A session the server
  forgot is set up again.
- **Stop** on a call's card stops it and tells the server (`notifications/cancelled`).
- Results: text as it is; resources as their text, or their URI; images and audio
  are described, not shown to the model.

**What works:** MCP's Streamable HTTP transport, from the browser. So:
- the server must allow this page's origin (CORS: `Access-Control-Allow-Origin`, the
  headers the page sends, and `Access-Control-Expose-Headers: Mcp-Session-Id` if it
  keeps sessions). A server that doesn't shows "isn't reachable, or doesn't allow
  this page (CORS)";
- a server that runs over stdio (most local ones) needs an HTTP bridge in front of
  it, one that also sends those headers;
- OAuth sign-in isn't done: give a token as a header instead;
- tools only: no resources, prompts, sampling or elicitation (a server asking for
  those is told they aren't supported).

## The VM

The guest is a Linux from TinyEMU-distros, 32-bit x86 or 64-bit RISC-V, with no
network device. You are root. Booting the Alpine 3.20 x86 image takes about a
minute, or 2-3 s from saved state; the RISC-V images are much quicker, about 5 s
(Alpine) and 15 s (Debian) from cold. For x86, the engine unpacks a gzip kernel
itself instead of running the kernel's decompressor on the emulated CPU, which
saves about 30 s of the boot. The RISC-V machine has no clock chip, so the page
sets the guest's date once it is up.

### Workspace

The agent works in `/workspace`, its project's own. Its tools start there, and its
instructions ask it to keep anything worth keeping there. The folder is stored in this
browser (IndexedDB), so its files survive reloads, saved states and fresh boots, and
every environment of the project sees the same files. It is saved every 3 s and when
the page closes; a save writes only the files changed since the last one. While a VM
of the project runs, the VM holds the folder and the page reads and writes it through
the VM; otherwise the page holds it itself.

The panel's **Files** tab shows the open chat's project's folder, so it works even
while a VM boots, or with none. In it you can:
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

The list refreshes after every tool call of a chat in that project. **Refresh** picks
up changes made from the console.

### Linked folders

**Link folder**, in the Files tab (or in a project's settings), links a folder on your
computer into the project's workspace, in the open folder, as `<open folder>/<its name>` (with `-2` and so on if that name is taken). The
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
  the workspace. A file you changed on your computer while a sync ran isn't deleted,
  nor a folder you saved something into: the next sync brings them back into the
  workspace.
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

Skills are managed in **Settings → Skills**: **Import folder** (or dropping folders onto
that section, or onto its name in the list of sections) imports one skill's folder, or
a folder of them: every folder with a `SKILL.md` becomes a
skill, and the folder's name is its id. Importing a skill with an id you already
have replaces it. **Delete** removes one. **Open** shows the skill: its files on the
left, `SKILL.md` first, and the chosen file's text on the right (binary files and
files over 2 MB are not shown). **← Skills** goes back to the list.

The checkbox before each skill turns it on or off for the agent. An off skill is
dimmed and marked "(off)": the `skill` tool doesn't offer it and won't load it, and
its `@id` is left as you typed it. Its files stay in `/agent/skills`, where the
agent's other tools can still see them. The choice is kept in this browser with the
settings; a deleted skill's is forgotten, so importing it again turns it on.

Skills are one library for every project, kept in this browser (IndexedDB), and are
at `/agent/skills/<id>` in every environment, so the agent's tools can read and run a
skill's files. bash.js and the page work on the library itself. A VM gets a copy,
brought up to date when it starts and before a call whenever the library changed:
a change the agent makes to `/agent/skills` from a VM's Bash isn't kept in the library
(use Write, which the page serves, or import the skill).

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

The **environment** chip in a chat's message box lists the systems
[TinyEMU-distros](https://gramthanos.github.io/TinyEMU-distros/) publishes (its
`manifest.json`, read at each load; when it can't be read, only the default is
offered), with their processor and, for the project, whether each is running, paused
or shared. Systems for a processor this page's engine can't run (it runs x86, riscv32
and riscv64) aren't offered. A project's settings pick its default system, its
**Memory**, 128, 256 (the default) or 512 MB, and **x86 JIT** (on by default; x86
systems only), which compiles hot guest code to WebAssembly; turning it off runs the
interpreter alone, a way to rule the JIT out of a problem.

The panel's **Environment** tab shows the open chat's environment: the system, the
engine release, its processor and memory, its state and how it started, its saved
state, and, while the tab is open (sampled every 2 s):
- **Speed:** instructions per second the emulated CPU runs now;
- **Instructions:** run since the machine booted. Like the disk figures, this
  counter lives in the machine's memory, so a resumed VM carries it on from the
  session that was saved;
- **Disk:** disk chunks downloaded, and their size as fetched;
- **Volume** `agent`, `workspace`, `skills`: the guest's reads and writes on each
  shared folder, and their bytes (`agent` carries the tool calls themselves);
- **Guest:** free memory, load averages and process count, as they were after the
  agent's latest Bash command;
- **Starts:** the average cold boot and resume time of that system over the last 20
  starts in this browser.

Under it, the project's environments, with the chats using each, and **Pause** and
**Delete** (see [Projects and environments](#projects-and-environments)).

### Environment variables

A project's settings hold variables to set in its shells: **Add variable**, a name
(letters, digits and `_`, not starting with a digit) and a value, then **Save**. They
are kept in this browser and apply:
- to every command the project's agents run with Bash, in every shell (sub-agents'
  included) and environment, bash.js too, from the next command. They are set at the
  start of each command, after what the shell exported before: a command can change
  one for itself, and the next starts from the list again. A variable removed from
  the list goes from the shells too;
- to new login shells in the project's VMs, through `/etc/profile.d/tinyemu-agent.sh`,
  which the page writes when a VM is ready and at each Save (the console's shell,
  already running, doesn't see them until `sh -l` or similar).

Values are stored as they are, like the API keys: don't put secrets there on a shared
computer.

### Saved state

Using a VM again, after a pause or a reload, resumes it from a saved snapshot instead
of booting it again. Each project keeps one saved state per system. The buttons are
in the panel's **Environment** tab.
- **After a cold boot,** the page saves the VM as soon as it is ready. The snapshot is
  about 32 MB, and the VM pauses for about 0.1 s while it is taken.
- **Pausing** (by hand, when idle, or to start another system in the project) saves it
  first.
- **Save state** saves the VM as it is now, including changes to its disk.
- **Fresh boot** stops the VM and forgets its saved state, after asking; it boots from
  scratch at once, in place, and the chats on it get new shells. For bash.js, the
  same button is **Reset shells**.
- **On resume,** the page reconnects to the guest and sets the guest's date, which
  stood still while the state was saved.
- **Automatic reboot:** the page boots from scratch, and saves a new state, if the
  saved one no longer matches the engine build, the VM config or the kernel and disk
  image, or if it fails to resume.

Changes outside `/workspace` made after the last save are lost on reload. Snapshots
only exist in the browser; the native `temu` can't save state.

### Data

**Settings → Data** lists what the page keeps in this browser: the projects, the open
chat's project's workspace (files, size and linked folders), the chats, the skills,
the saved states (of every project and system), the providers, and the site's total
browser storage. Its buttons each ask first, and are refused while an agent works:
- **Empty <project>'s workspace** deletes everything in the open chat's project's
  `/workspace`. Linked folders are only unlinked: the folders on your computer stay
  as they are.
- **Delete skills** deletes every imported skill.
- **Delete saved states** deletes the saved state of every system of every project.
  Running VMs carry on; a paused one boots from scratch when used again.
- **Reset settings** puts the settings (tools, features, system prompt, context) and
  the layout back to their defaults and reloads. The providers, projects, workspaces,
  skills, chats and saved states stay.
- **Delete chats** deletes every chat and opens a new one.
- **Delete everything** does all of the above, for every project, also deletes the
  projects and the providers with their API keys, and reloads.

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
| `?nosnapshot=1` | Don't resume or save VM states |
| `?mem=<MB>` | Guest memory for every VM, instead of the projects' choice (default 256) |
| `?cfg=<url>` | Offer any TinyEMU config as a machine, "the config in the link", in the environment menu (relative URLs are to the page). The page changes it the way it changes a distro's: no network devices, and the three JS volumes added |
| `?engine=<release or folder>` | Use another TinyEMU engine release from its Pages (`v2026-11-22`, `latest`), or a folder on the page's own server holding `x86emu-wasm.js` and `.wasm` (a local build). Part of the saved state's fingerprint |
| `?jittail=1` | x86 guests: chain the JIT's compiled pages with WebAssembly tail calls instead of through C. Slower in tests (Chrome 156), so off; for comparing as browsers change. Part of the saved state's fingerprint |
| `?jit=0` | x86 guests: turn the engine's x86-to-WebAssembly JIT off, whatever the projects say. Against the interpreter alone it boots Alpine x86 in ~10 s instead of ~16, and, once warm, runs a shell loop and Python about twice as fast. It is part of the saved state's fingerprint, so switching it cold-boots |
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
  A command is killed after 2 MB of output. The model gets the last 2000 lines of a
  longer output (Settings, next to Bash; 0 for all), with a note of how many there
  were, and at most the tool output limit of that (below). In a VM only those last
  lines leave the guest; while a command runs, the card streams its output until it
  passes 256 KB.
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
- **TodoWrite** and **TodoRead** keep the agent's to-do list for its task: TodoWrite
  sets the whole list (each step pending, in progress or completed), TodoRead reads it
  back. The list belongs to that agent (each sub-agent has its own) and is kept with
  its chat; nothing is written in the workspace. Above the message box, the open chat
  shows its list: how many steps are done and the one in progress, and every step
  when you click it, plus a line for each working sub-agent's list.
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
  twice, then every 20 s: 15 times in a row by default, then the turn stops with the
  error (Settings → Agent; 0 keeps trying for as long as it takes). It tries at once
  when the browser says it is back online. The chat notes the outage once and counts
  down to the next try; Stop ends the wait. Sub-agents wait the same way instead of
  failing. Errors the server answered (a bad key, a rejected request, a gateway
  timeout) are not retried this way.

### Modes

A **mode** is how the agent works in a chat: its system prompt and its tools. The
**mode** chip in the message box picks one for the chat (it starts in the mode of the
chat you were in); a change applies from your next message, in the same conversation,
and the chat notes it. Three are built in:

| Mode | What it does | Its tools |
|------|--------------|-----------|
| Build | Does the work: reads, changes and runs things. The default | As in Settings → Tools |
| Plan | Looks around and writes a plan; changes nothing | No Edit, Write or Delegate |
| Sub-agent | What Delegate's sub-agents work in; never in the mode menu | No Delegate or ask_user |

**Settings → Modes** edits them and adds your own (**+ New mode**, which starts from
Build's prompt). For each mode:
- its **name** and a **description** (shown in the mode menu);
- whether the **mode menu offers it**: untick to hide a mode you don't want next to
  the message box (the Sub-agent mode never is);
- its **system prompt**, with variables (below) and a preview of the prompt as the
  open chat would get it;
- its **tools**: each one "as in Tools" (Settings → Tools decides), on, or off,
  whatever Settings → Tools says. Sub-agents never get Delegate or ask_user, whatever
  their mode says.

**Save** keeps the changes, **Revert** drops them, **Reset to default** puts a built-in
mode back as it ships, and **Delete mode** removes one of yours (its chats go back to
Build). With Claude, a changed prompt makes the next request miss the prompt cache
once. If you had edited the system prompt before modes, that edit became Build's.

**Variables** in a prompt are filled in for each chat, at every message, and the
built-in prompts use them: `{{VAR_MODEL_NAME}}` with the chat's model's name as its
provider lists it (`Claude Opus 5.5`) and `{{VAR_MODEL_ID}}` with its id
(`claude-opus-5-5`); `{{VAR_MODE}}` with the mode's name; `{{VAR_ARCH}}` and
`{{VAR_OS_NAME}}` with the chat's environment's processor and system (`riscv64`,
`Debian 13`; for bash.js, a line saying so; for a `?cfg=` machine, `see uname -m` and
`Linux`). Under the editor, a list shows each variable with its value for the open
chat; clicking one inserts it at the cursor.

### Settings

**⚙ Settings**, at the bottom of the sidebar, has eight sections:
- **Models:** the providers and the models each offers (see [Models](#models)).
- **Modes:** the modes, their prompts and their tools (see [Modes](#modes)).
- **Tools:** a checkbox per tool: what the model gets in every mode that doesn't say
  otherwise. A tool you turn off is taken away from the model from your next message
  on, in the same conversation, and sub-agents don't get it either; a tool a mode
  turns on or off says so. Under Bash, its default timeout and how many of a command's
  last output lines the model gets; under Delegate, how many
  sub-agents run at once (0 for no limit) and how many steps each may take.
- **Skills:** the skill library, for every project (see [Skills](#skills)). What an
  import or a deletion did shows under its bar.
- **Integrations:** MCP servers (see [Integrations](#integrations-mcp-servers)).
- **Agent:**
  - **Features:** whether `@id` mentions are replaced by the skill's instructions,
    whether the model's thinking shows in the chat (turning it off hides blocks
    already there too), and whether, in a VM, Read, Edit and Write of `/workspace`
    and `/agent/skills` are served by the page (on by default; off sends them
    through the VM like other paths, which is slower). bash.js always serves them.
  - **Agent:** the most steps (model replies) per message, 100 by default, how many
    times an empty response is asked for again, how many times in a row the model is
    tried again while it can't be reached (15; 0: no limit), the tool output limit, and after how
    many idle minutes a VM is paused (10; 0: never). A change applies at once, even to
    a turn in progress.
  - **Keep running:** what keeps the browser from stopping the page while an agent
    works (only while a turn runs):
    - a Screen Wake Lock, on by default, so the screen stays on and the computer
      doesn't sleep. Browsers drop it while the tab is hidden; the page asks again
      when it's back. Some embedded browsers refuse it, and the line under the
      options says so;
    - a very quiet low tone every 15 s, off by default. Chrome and Edge don't freeze
      or throttle a tab that plays sound. The tab shows a speaker icon, and the tone
      waits for your next click if the browser didn't allow sound yet;
    - **Browser settings that help:** where to exempt the site in Chrome (Memory
      Saver's "Always keep these sites active", Energy Saver) and Edge (sleeping
      tabs), Firefox's `browser.tabs.unloadOnLowMemory`, and keeping the window in
      view.
- **Context:** automatic compaction on or off and its threshold, the context window
  if the model doesn't report it, and the open chat's context figures (see
  [Context and compaction](#context-and-compaction)).
- **Data:** what the page keeps, and deleting it (see [Data](#data)).

The settings are kept in this browser.

### Log

The panel's **Log** tab lists every exchange of the open chat as JSON,
sub-agents' included: each message you sent (and when one arrived during a turn),
each model reply with its text, thinking, tool calls, stop reason, token usage and
time, each tool call with its input, result and time, each sub-agent's start (its
task, prompt and shell) and each compaction. A row shows the time, the agent and a
preview; open it for the JSON. The menu shows one agent's rows.
- **Export** saves the log as a JSON file, with the conversation as the provider holds
  it (no API key is in either).
- **Import** opens an exported log in the tab. If the open chat's model is of the same
  kind (Claude, OpenAI-compatible or in-browser), the page offers to restore that
  conversation into it: your next message carries on from it, though the chat doesn't
  show the earlier messages.
- **Clear** empties the log; the conversation goes on.
- **Token usage and tool calls of this chat**, folded above the list: requests, input,
  cache write, cache read, output and thinking tokens, for the main agent, its
  sub-agents, compaction and in total (in a sub-agent's chat, its own), and per tool its
  calls, failures, total and average time, and the longest. Input counts uncached
  tokens only. Output includes thinking: Claude doesn't report thinking tokens apart,
  so that column shows —. Each has a **Reset**. The chat's header shows the token
  totals in short.

Each chat keeps its own log (the latest 2000 exchanges are saved with it); a
sub-agent's exchanges are in its chat's log and its main chat's.

### Context and compaction

A model reads its whole conversation with every request, and that has to fit its
context window. A long task (big files, long command output, many steps) fills it,
so the page compacts the conversation: the same model writes a summary of everything
so far, and the summary replaces the history. The agent carries on from the summary.
Its files and changes in the VM are untouched, and it can read them again.

**The meter** in the chat's header shows how much of the window the conversation
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
Settings → Context. A value there overrides the model's for every conversation,
except a model whose own setting gives one (Settings → Models, its ⚙).

Calls that read or change the same file through Read, Edit and Write apply in the
order the model made them. Nothing orders Bash against other calls; if parallel Bash
calls change directory, the last to finish wins.

## Developing

The page is a React app built with [Vite](https://vite.dev/) (`vite.config.js`):

| Command | What it does |
|---------|--------------|
| `npm run dev` | The dev server, at <http://localhost:8000/>: changes show at once |
| `npm run build` | Builds the site into `dist/` (see [Publishing](#publishing)) |
| `npm run preview` | Serves `dist/`, to try a build |
| `npm test` | The unit tests (Node only, no browser) |

The code is in three places:
- `src/components/`: the React components, one per part of the page;
- `src/app/`: what the page does, apart from drawing it: the chats and their
  sessions, each chat's agent and turns, projects, environments, providers,
  settings, the Files tab, Settings → Data. Components call into it, and it tells
  them to draw again (`src/app/store.js`);
- `js/`: the agent itself, with no page in it: the loop, the tools, the providers,
  the environments, MCP. The unit tests cover it.

The engine and the systems don't come from the dev server: the page loads them from
TinyEMU's and TinyEMU-distros' Pages. To try a local TinyEMU-distros build (a
`build/<name>/` directory, or a `<name>.tar` from its Releases, unpacked), name it in
`TINYEMU_DISTROS` (several separated by `:`, or `;` on Windows):

```bash
TINYEMU_DISTROS=../TinyEMU-distros/build/alpine-3.20-x86-lite npm run dev
```

It is served at `/distro/<name>/`; boot it with `?cfg=distro/<name>/config.cfg`. Its
`config.cfg` still says `${ASSET_BASE}` where the published copy has its URL; the
page reads that as the config's own folder. The dev server sends every file with
`Cache-Control: no-store`, and a distro's files with `Last-Modified`, which tells a
saved VM state that a local distro's kernel or disk changed.

**Using it from another computer:** `npm run dev -- --host 0.0.0.0` prints the
addresses to open. Over plain HTTP to anything but localhost the page isn't a
secure context. The browser then hides WebGPU, so only the API providers work. API
keys still go from the browser straight to the provider over HTTPS, but anyone who
can tamper with your network traffic could alter the page itself.

**A distro needs** 9p support in its kernel (TinyEMU-distros kernels have it),
`/bin/sh`, and `mount`, `setsid`, `mktemp` and `date`, all of which busybox
provides. It must boot to a shell prompt on the console.

## Publishing

`npm run build` builds the site into `dist/` (git-ignored, emptied first):

- `index.html` and `assets/`: the page, bundled (React, the agent's code, jsLab's
  runtime from `deps/jsLab/lib/`, bash.js from `deps/bash.js`), with jsLab's VM
  worker, bash.js and xterm.js as chunks of their own, loaded when first needed;
- `README.md` (from `scripts/release-README.md`), `LICENSE`, `LICENSES/` (jsLab's
  and bash.js's), `.nojekyll` (no Jekyll on Pages), and `build-info.json`: the commit
  it came from (and whether it had uncommitted changes), the submodules' commits, the
  engine release and where the systems come from.

Every path in it is relative, so it works wherever it is served, at a site's root or
under a path such as `/tinyemu-agent/`.

**The `deploy` workflow** builds it on GitHub, after the tests, and publishes it to
Pages. Run it by hand (Actions → deploy → Run workflow); it has no inputs. Pages must
be set to deploy from GitHub Actions (Settings → Pages → Source).

**Nothing big is published:** the site is about 1.3 MB (400 KB compressed). A new TinyEMU-distros release
reaches the page with no deploy here; so does a new system in it. A new engine
release needs `ENGINE` in `js/distros.js` changed, since saved VM states only resume
on the engine they were saved with. Pages lets browsers cache files for 10 minutes
and its headers can't be changed: right after a release, a browser can mix old and
new files and fail with `vm_start failed: Aborted()`, which a hard reload fixes.
Saved VM states are matched by each file's ETag there, so a release that changes the
kernel or disk makes the next load boot from scratch, and one that doesn't keeps them.

**Licences:** the agent is GPL-3.0-or-later, as is jsLab; the engine (TinyEMU) and
bash.js are MIT. The systems are none of these: the Linux kernel and BusyBox are
GPL-2.0 and the distributions' packages carry their own licences. They are
published by TinyEMU-distros, whose recipes record what went into each.

### The engine

The page uses TinyEMU's WebAssembly build, `x86emu-wasm.js` and `.wasm`, from
`https://gramthanos.github.io/TinyEMU/engine/<release>/`: the release `ENGINE` in
`js/distros.js` names (v2026-11-23 or later: it boots a `data:` config, which is
how the page's changes to a distro's config reach it). To try a build of the
`deps/TinyEMU` submodule instead, with Docker:

```bash
docker run --rm -v "$PWD/deps/TinyEMU":/src -w /src emscripten/emsdk:3.1.74 make -f Makefile.js
```

then open the page with `?engine=deps/TinyEMU/dist/wasm/`. On Windows Git Bash, use
`MSYS_NO_PATHCONV=1` and `"$(pwd -W)"` in place of `"$PWD"`. A new engine
invalidates saved VM states, so the next load boots from scratch.

## What the browser keeps

| Where | Name | What |
|-------|------|------|
| IndexedDB | `tinyemu-agent-workspace` | The first project's `/workspace` |
| IndexedDB | `tinyemu-agent-workspace:<project>` | Every other project's `/workspace` |
| IndexedDB | `tinyemu-agent-skills` | The imported skills (`/agent/skills`) |
| IndexedDB | `tinyemu-agent-skills-mirror:<project>` | A project's VMs' copy of the skills |
| IndexedDB | `tinyemu-agent-links` | Linked folders: their project, where each is, the browser's handle to it, and its sync state |
| IndexedDB | `tinyemu-snapshots` | The saved VM states, one per project and system |
| IndexedDB | `tinyemu-agent-bridge`, `tinyemu-agent-bridge:<project>` | A project's VMs' tool bridge folder (scripts, nothing of yours) |
| IndexedDB | `tinyemu-agent-chats` | The chats: project, environment, model, messages, the model's conversation, figures and log |
| localStorage | `tinyemu-agent-projects` | The projects: names, defaults, environment variables |
| localStorage | `tinyemu-agent-mcp` | The MCP servers: name, URL, headers (tokens included), on or off, tools turned off |
| localStorage | `tinyemu-agent-providers` | The providers: kind, name, URL, API key, their models, which are offered, and each model's own settings |
| localStorage | `tinyemu-agent-active-chat` | Which chat is open |
| localStorage | `tinyemu-agent-layout` | Whether the sidebar and panel show, their widths, and the panel's tab |
| localStorage | `tinyemu-agent-tool-cards-open` | Whether tool cards start open |
| localStorage | `tinyemu-agent-settings` | Turned-off tools, features (Settings) and the thinking levels |
| localStorage | `tinyemu-agent-modes` | The modes: their names, prompts, whether the mode menu offers them, and their tools |
| localStorage | `tinyemu-agent-boot-history` | The last 20 VM starts' times |
| localStorage | `tinyemu-agent-connection`, `tinyemu-agent-vm-settings`, `tinyemu-agent-env` | From before projects: read once, into the first provider and project |

**Settings → Data** deletes any of these (see [Data](#data)). **Remove** on a provider
removes it with its key, **Delete** in the Environment tab a VM's saved state, **×** on
a chat's row that chat, and **Delete project** a project with its chats and workspace.
Deleting files in the Files panel removes them from the workspace, and **Delete** in the
Settings → Skills a skill. Clearing this site's data in the browser removes all of it.

## Security

- **The environment is the sandbox.** The tools aren't confined to a folder, because
  the whole guest is the agent's to use. The guest has no network device. bash.js sees
  only the project's workspace, the skills and its own `/tmp`, and runs no programs.
- **Projects are separate workspaces, not separate trust zones:** every chat's agent
  reads the same skills, and the page holds every project's files.
- **Nothing from the guest or the model runs in the page.** Their text, file names and
  file previews included, only ever goes into the page as text, never as HTML. A
  file reaches your computer only when you press Download.
- **API keys** go only to their own provider, never to the guest. They are saved
  with the provider in this browser's localStorage, until you **Remove** it in
  Settings → Models. Anyone who can run script in this page or read this browser's
  storage could read them, so use keys you can revoke. The built site has a Content
  Security Policy: scripts come only from the site and the two CDNs the Claude SDK
  and WebLLM load from. Requests may go to any http(s) address, since models, MCP
  servers and local servers are yours to choose. `window.agentDemo`, which hands
  out the tools and the chats, exists only in the dev server.
- **Text the model reads in the VM** can steer what it does next, but only within the
  VM and the workspace. That includes skills: import only ones you trust, since
  their instructions go to the model as yours.
- **An MCP server is outside the sandbox:** its tools do whatever the server does,
  with whatever access its token gives. The model decides when to call them, and text
  it read in the VM or a file can steer that. Add only servers you trust, with tokens
  you can revoke; untick tools that change things you care about. Header values go
  only to their own server.
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

**Environments** ([js/environments.js](js/environments.js)). Each project has one
bash.js environment and one per system, shared by the chats that pick it; each has its
own tools, with a shell per chat. A VM's tools reach the guest through a bridge that
starts (or resumes) the VM at its first call. bash.js's tools run the same shell
scripts in bash.js, through a stand-in for that bridge.

**Volumes** ([js/volumes.js](js/volumes.js)). A project's workspace is a 9p volume
backed by JavaScript, saved to IndexedDB, which has one writer at a time: the page,
or one VM, whose worker loads it when it starts. The page hands it to a VM before it
boots and takes it back once the VM has stopped and saved it, which is why a project
runs one VM at a time. Everything the page does with files (the Files panel, linked
folders, bash.js, Read/Edit/Write served from the page) goes through whoever holds it.

**The workspace** is a second shared folder of the same kind as the bridge's, mounted
at `/workspace`. **Skills** are a third, mounted at `/agent/skills`: the page's own
library, of which each VM gets a copy.

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
node tests/projects.test.mjs
node tests/providers.test.mjs
node tests/modes.test.mjs
node tests/mcp.test.mjs
```

`tests/modes.test.mjs` (5 tests) covers the modes (the built-in ones, yours, the prompt
from before modes), each mode's choice of tools through the tools layer, and the
TodoWrite / TodoRead tools with a list per agent.

`tests/providers.test.mjs` (14 tests) covers each model's own settings (kept in range,
over the listing, in the requests under each API's name, applied to running chats) and the presets (cloud ones with fixed
URLs and keys, local ones with a default URL and none), OpenRouter's headers, error
bodies of every provider's shape, cached-token fields, and streamed replies against a
fake `fetch`: reasoning under each provider's name and sent back, Mistral's content
parts, Gemini's tool calls without `index` keeping their thought signatures, and
OpenRouter's `reasoning_details`.

`tests/mcp.test.mjs` (7 tests) runs the MCP client and hub against a small
Streamable HTTP server on this machine (`tests/fixtures/mcpServer.mjs`): sessions and
paging, answers as JSON and as an event stream (with a server request answered),
a wrong token, a lost session, stopping a call, tool names and schemas, and MCP
tools through the tools layer.

`tests/projects.test.mjs` (11 tests) covers projects (the first load from what the
page kept before, saving, storage keys, environment keys, each project's linked
folders), providers (the old saved connection, the offered models), handing a volume
to a VM and back, a bash.js environment running every tool on a project's workspace
(Glob and Grep included) with a shell per chat, and pausing an idle VM.
`tests/tools.test.mjs`'s 115 tests cover:
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
- the list of systems read from TinyEMU-distros' manifest, and the changes the page
  makes to a system's config (no network, the JS volumes);
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
- **A chat's environment says "waiting for … to be idle".** Its project runs another
  machine, which a chat is working in; the new one starts when that turn ends. Stop
  that chat, or pick the same machine.
- **WebGPU models are missing.** The browser has no WebGPU, or the page isn't a secure
  context.
- **The VM always boots from scratch.** Saving needs IndexedDB, which a private window
  or blocked site data can prevent. `?nosnapshot=1` also turns it off.
- **Something looks stuck after resuming.** Press **Fresh boot** in the Environment tab.
- **The environment menu offers only the default system,** or a boot fails at
  once. The page couldn't reach GitHub Pages (`gramthanos.github.io`), where the
  engine and the systems are; check your connection, or what blocks that site.

## Files

| File | Purpose |
|------|---------|
| [index.html](index.html), [src/main.jsx](src/main.jsx) | The page's entry: its root element, its stylesheet ([src/styles.css](src/styles.css)), its start |
| [src/components/](src/components/) | The page in React: the sidebar of projects and chats, the chat and its message box, the panel's tabs, Settings and the project dialog |
| [src/app/](src/app/) | What the page does: chats and their sessions, agents and turns, projects and environments, providers, settings, the Files tab, Settings → Data, the start |
| [vite.config.js](vite.config.js), [package.json](package.json) | The build and the dev server |
| [js/projects.js](js/projects.js) | Projects: their records, defaults and storage keys, and each one's linked folders |
| [js/providerStore.js](js/providerStore.js) | The providers set up in Settings → Models, their models, and loading one per chat |
| [js/environments.js](js/environments.js) | Each project's environments (bash.js and VMs): sharing, starting, pausing, one VM at a time |
| [js/mcp.js](js/mcp.js) | MCP servers: the Streamable HTTP client, and their tools as the agent's |
| [js/volumes.js](js/volumes.js) | A project's volumes, held by the page or handed to a VM |
| [scripts/add-submodules.sh](scripts/add-submodules.sh) | Registers the `deps/` submodules (once) |
| [.github/workflows/deploy.yml](.github/workflows/deploy.yml) | Builds the site and deploys it to GitHub Pages (run by hand) |
| [scripts/release-README.md](scripts/release-README.md) | The README a release gets |
| [js/Agent.js](js/Agent.js) | The agent loop, the system prompts, the provider interface, Delegate's sub-agents and when to compact |
| [js/distros.js](js/distros.js) | Where the systems and the engine come from, and the config the page boots a system with |
| [js/compaction.js](js/compaction.js) | Compaction: the summary prompt, the transcript, overflow errors |
| [js/pause.js](js/pause.js) | Noticing when the browser paused the page, for timeouts |
| [js/keepAwake.js](js/keepAwake.js) | The wake lock and the quiet tone that keep the page running during a turn |
| [js/bashjs.js](js/bashjs.js) | Bash in bash.js, on a project's volumes: the bash.js environment |
| [js/figures.js](js/figures.js) | What the Context and usage panels show, worked out from the agent and the chat |
| [js/tools.js](js/tools.js) | The tools, run as shell scripts in the guest (and `skill`, `ask_user`, the to-do tools), and each view's choice of tools |
| [js/modes.js](js/modes.js) | The modes: the built-in ones and their prompts, the store, each mode's choice of tools |
| [js/skills.js](js/skills.js) | Skills: the library, `SKILL.md` parsing, `@id` expansion, the `skill` tool |
| [js/GuestBridge.js](js/GuestBridge.js) | The bridge to the guest: bootstrap, `agentd`, jobs |
| [js/chats.js](js/chats.js) | The chats' store and record shape |
| [js/zip.js](js/zip.js) | Folder downloads as .zip |
| [js/LinkedFolders.js](js/LinkedFolders.js) | Linked folders: linking, the sync (both ways, or read-only) and unlinking |
| [js/providers/claude.js](js/providers/claude.js) | Claude, through the Anthropic SDK |
| [js/providers/openai.js](js/providers/openai.js) | Any OpenAI-compatible API, and the presets: OpenAI, Gemini, OpenRouter, Mistral, Groq, ..., and local servers |
| [js/providers/webllm.js](js/providers/webllm.js) | Local models through WebLLM |
| [js/providers/toolProtocol.js](js/providers/toolProtocol.js) | The text tool-call format for local models |
| [tests/tools.test.mjs](tests/tools.test.mjs) | The tests of the tools, the loop and the providers |
| [tests/projects.test.mjs](tests/projects.test.mjs) | The tests of projects, providers, volumes and environments |
| [tests/modes.test.mjs](tests/modes.test.mjs) | The tests of the modes and the to-do tools |
| [tests/providers.test.mjs](tests/providers.test.mjs) | The tests of the provider presets and of each API's differences |
| [tests/mcp.test.mjs](tests/mcp.test.mjs), [tests/fixtures/mcpServer.mjs](tests/fixtures/mcpServer.mjs) | The MCP tests, and the small server they (and you) can run |

The VM runtime it builds on (`VMManager`, snapshots, volumes) is jsLab, in
`deps/jsLab/lib/` and described in `deps/jsLab/docs/`. bash.js is `deps/bash.js`.
