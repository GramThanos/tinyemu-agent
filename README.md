# tinyemu-agent

A light AI client agent with a TinyEMU-based sandbox system running in the browser.

**Open it: <https://gramthanos.github.io/tinyemu-agent/>**

A chat page that turns a Linux VM running in your browser tab into an AI agent's
computer. The VM is TinyEMU's x86 and RISC-V emulator compiled to WebAssembly; the
VM tab picks the system (`alpine-3.20-riscv64`, `alpine-3.20-x86`, `debian-12-x86`, `debian-13-riscv64`), and the model works
in it through file and shell tools, with skills, sub-agents and folders linked from
your computer. Nothing runs on a server: the whole site is static files. It needs
Chrome 95+, Safari 15.4+ or Firefox 131+.

## This repository is a build

These files are generated; don't edit them here. The sources, and the full
documentation, are in [TinyEMU's `web/agent/`](https://github.com/GramThanos/TinyEMU/tree/main/web/agent).
This build is from TinyEMU commit db67d37317c7 (with uncommitted changes); `build-info.json` has the details.
To make a new one, in a TinyEMU checkout:

```bash
node web/agent/scripts/build.mjs --distro <TinyEMU-distros build/alpine-3.20-riscv64 directory> --distro <TinyEMU-distros build/alpine-3.20-x86 directory> --distro <TinyEMU-distros build/debian-12-x86 directory> --distro <TinyEMU-distros build/debian-13-riscv64 directory> --out <this repository>
```

| Path | What |
|------|------|
| `index.html`, `js/` | The page |
| `engine/` | TinyEMU's browser runtime and the emulator, built to WebAssembly |
| `distro/alpine-3.20-riscv64/` | Alpine 3.20 (riscv64): kernel, OpenSBI firmware, disk (as gzipped chunks) and the VM config |
| `distro/alpine-3.20-x86/` | Alpine 3.20 (x86): kernel, disk (as gzipped chunks) and the VM config |
| `distro/debian-12-x86/` | Debian 12 (x86): kernel, disk (as gzipped chunks) and the VM config |
| `distro/debian-13-riscv64/` | Debian 13 (riscv64): kernel, OpenSBI firmware, disk (as gzipped chunks) and the VM config |
| `distro/index.json` | The systems the VM tab offers; the first is the default |

GitHub Pages serves it from the `main` branch, folder `/`. Pages lets browsers
cache files for 10 minutes, so right after an update a page that fails to boot
needs a hard reload (Ctrl+Shift+R).

## Licences

The page and the engine are MIT ([LICENSE](LICENSE)). The guest in `distro/` is
not: each system there is a [TinyEMU-distros](https://github.com/gramthanos/TinyEMU-distros)
build whose Linux kernel is GPL-2.0 (as are Alpine's BusyBox and much of Debian's
userland), and whose other packages carry their own licences; the RISC-V
systems' firmware, `bios.bin`, is OpenSBI (BSD-2-Clause). The TinyEMU-distros recipe of each (`alpine-3.20-riscv64`, `alpine-3.20-x86`, `debian-12-x86`, `debian-13-riscv64`) records what went into it
and where each part's source comes from.
