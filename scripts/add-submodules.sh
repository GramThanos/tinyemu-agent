#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Register the projects the agent builds on as git submodules under deps/.
# Run once, from the repository root, after each of them has a commit on GitHub;
# then commit .gitmodules and deps/. Skips any that are already there.
#
#   sh scripts/add-submodules.sh
#
# Afterwards a fresh clone needs: git clone --recursive <this repo>
# (or git submodule update --init in an existing one).
set -e
add() {
    if git config -f .gitmodules --get "submodule.deps/$2.path" >/dev/null 2>&1; then
        echo "deps/$2: already a submodule"
    else
        git submodule add "$1" "deps/$2"
    fi
}
add https://github.com/GramThanos/jsLab.git jsLab
add https://github.com/GramThanos/bash.js.git bash.js
add https://github.com/GramThanos/TinyEMU.git TinyEMU
add https://github.com/GramThanos/TinyEMU-distros.git TinyEMU-distros
git submodule status
