# tinyemu-agent

A light AI client agent with a TinyEMU-based sandbox system running in the browser.

**Open it: <https://gramthanos.github.io/tinyemu-agent/>**

A chat page that turns a Linux VM running in your browser tab into an AI agent's computer. The VM is TinyEMU's x86 emulator compiled to WebAssembly; the model works in it through file and shell tools, with skills, sub-agents and folders linked from your computer. Nothing runs on a server: the whole site is static files. It needs Chrome 95+, Safari 15.4+ or Firefox 131+.

This repository is a concept build based on a modified version of Bellard's [TinyEMU](https://bellard.org/tinyemu/) and was developed using Claude.

| Path | What |
|------|------|
| `index.html`, `js/` | The page |
| `engine/` | TinyEMU's browser runtime and the emulator, built to WebAssembly |
| `distro/alpine-3.20-x86/` | The guest: kernel, disk (as 256 KB chunks) and the VM config |
