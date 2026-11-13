/*
 * GuestBridge.js — runs scripts inside a booted guest, out of band from the console.
 *
 * The console is a poor data channel: its input FIFO is 1 KB and drops overflow,
 * the tty limits line length, and output arrives with CRLF translation. So the
 * console is used once, to mount a JS-backed 9p volume and start a small daemon
 * (agentd). After that every request is a directory on the volume:
 *
 *   /req/<id>/script   the shell script to source        (host → guest)
 *   /req/<id>/cwd      directory to start in             (host → guest)
 *   /req/<id>/<input>  extra input files, e.g. `data`    (host → guest)
 *   /req/<id>/go       written LAST; agentd starts on it (host → guest)
 *   /req/<id>/kill     ask the watchdog to kill the job  (host → guest)
 *   /req/<id>/out      merged stdout + stderr            (guest → host)
 *   /req/<id>/cwd.after, rc                              (guest → host)
 *
 * Timeouts are timed here, by the page's clock, and enforced through `kill`: the
 * guest's clock can run several times faster than real time. The page clock is
 * pauses.now(), which leaves out time the browser had the page stopped (a frozen
 * tab, a sleeping computer): the VM's worker stopped too, so nothing ran then.
 *
 * `rc` is renamed into place last, so its existence means the job finished. The
 * console stays free for the person typing into the guest's shell.
 */

'use strict';

import { pauses } from './pause.js';
import { SKILLS_DIR, SKILLS_VOLUME } from './skills.js';

export const VOLUME = 'agent';
export const MOUNT = '/mnt/agent';
/* The agent's working folder: a second JS volume, kept in IndexedDB by the page,
 * so its files outlive the VM. */
export const WORKSPACE_VOLUME = 'workspace';
export const WORKSPACE = '/workspace';

/* The daemon. Plain POSIX sh + busybox applets. */
const AGENTD = `#!/bin/sh
export HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TERM=dumb
cd /
: >${MOUNT}/ready
while :; do
    for g in ${MOUNT}/req/*/go; do
        [ -e "$g" ] || continue
        rm -f "$g"
        sh ${MOUNT}/bin/job "\${g%/go}" &
    done
    sleep 0.25 2>/dev/null || sleep 1
done
`;

/* One job: a new session (so the whole tree can be killed) that SOURCES the
 * script, which lets `exit N` work and lets `cd` be observed for the next call.
 * A Bash shell's exported variables come in as `env` (sourced first) and go
 * out as `env.after`, so they carry over to the shell's next call.
 *
 * The job waits and kills by itself, with no watchdog in the background: the
 * guest's PID 1 is the console's shell (init=/bin/sh), so a process this script
 * leaves behind is re-parented to it, and its exit makes that shell redraw its
 * prompt on the console. `kill -0` still succeeds on an unreaped child, so the
 * session's trap writes `exited` to end the loop. On `kill` (a timeout or Stop)
 * the session is killed at once: its process group, and with /proc every other
 * process in it too. */
const JOB = `#!/bin/sh
D=$1
export AGENT_DIR="$D"
setsid sh -c '
    cd "$(cat "$AGENT_DIR/cwd" 2>/dev/null)" 2>/dev/null || cd /
    trap "__rc=\\$?; pwd >\\"\\$AGENT_DIR/cwd.after\\" 2>/dev/null; export -p >\\"\\$AGENT_DIR/env.after\\" 2>/dev/null; : >\\"\\$AGENT_DIR/exited\\"; exit \\$__rc" EXIT
    [ -f "$AGENT_DIR/env" ] && . "$AGENT_DIR/env" >/dev/null 2>&1
    . "$AGENT_DIR/script"
' >"$D/out" 2>&1 </dev/null &
pid=$!
while [ ! -e "$D/exited" ] && kill -0 $pid 2>/dev/null; do
    if [ -e "$D/kill" ]; then
        kill -KILL -$pid 2>/dev/null
        pkill -KILL -s $pid 2>/dev/null
        break
    fi
    sleep 0.1 2>/dev/null || sleep 1
done
wait $pid
rc=$?
echo $rc >"$D/rc.tmp"
mv "$D/rc.tmp" "$D/rc"
`;

/* Run once agentd answers, after a boot and after a resume. /proc isn't mounted
 * when the distro boots straight into a shell; the agent's ps and top need it, and
 * so does killing a whole session (pkill -s). */
const PREPARE = '[ -e /proc/self ] || mount -t proc proc /proc 2>/dev/null; true';

/* Single line, well under the tty's limit. The subshell keeps the prompt free.
 * msize: TinyEMU's virtqueues have 16 descriptors and no indirect ones, and newer
 * kernels default to a 512 KB msize whose buffers need more; the mount then hangs.
 * The workspace and skills mounts may fail (a config without them); the tools
 * still work. */
const P9 = '-t 9p -o trans=virtio,version=9p2000.L,msize=32768';
const BOOTSTRAP = `(mkdir -p ${MOUNT} ${WORKSPACE} ${SKILLS_DIR}; mount ${P9} ${WORKSPACE_VOLUME} ${WORKSPACE}; mount ${P9} ${SKILLS_VOLUME} ${SKILLS_DIR}; mount ${P9} ${VOLUME} ${MOUNT} && exec setsid sh ${MOUNT}/bin/agentd) </dev/null >/dev/null 2>&1 &\n`;

const POLL_MS = 150;
const MAX_OUTPUT = 2 * 1024 * 1024;   // kill a job that writes more than this
const GRACE_MS = 15000;               // on top of the timeout, for a wedged guest

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* A shell prompt at the end of the console, or starting a recent line: kernel
 * messages can still arrive after it, like "~ # [    4.75] mkdir (67) used ...". */
const PROMPT = /[#$]\s*$|(^|\n)\S{0,40} ?[#$] /;

export class GuestBridge {
    /** @param {import('../../js/vm/VM.js').VM} vm  started VM with the `agent` volume */
    constructor(vm) {
        this.vm = vm;
        this.ready = false;
        this._seq = 0;
    }

    /**
     * Wait for a shell on the console, then mount the volume, start agentd and
     * set the guest clock.
     * @param {() => string} recentConsole  the latest console text, ANSI stripped
     */
    async start(recentConsole, { timeoutMs = 300000, onStatus = () => {} } = {}) {
        const { vm } = this;
        await vm.volumeDelete(VOLUME, '/req').catch(() => {});
        await vm.volumeDelete(VOLUME, '/ready').catch(() => {});
        await vm.volumeMkdir(VOLUME, '/req');
        await vm.volumePutFile(VOLUME, '/bin/agentd', AGENTD);
        await vm.volumePutFile(VOLUME, '/bin/job', JOB);

        const deadline = Date.now() + timeoutMs;
        onStatus('waiting for a shell prompt');
        while (!PROMPT.test(recentConsole())) {
            if (Date.now() > deadline) throw new Error('no shell prompt on the console');
            await sleep(250);
        }

        onStatus('starting the guest agent');
        while (Date.now() < deadline) {
            vm.sendInput(BOOTSTRAP);
            for (let i = 0; i < 40; i++) {
                await sleep(250);
                if (await vm.volumeGetFile(VOLUME, '/ready')) {
                    this.ready = true;
                    // Set the clock: TinyEMU's RISC-V machine has no RTC, so its
                    // guests boot in 1970 (the PC's CMOS clock already agrees).
                    const now = Math.floor(Date.now() / 1000);
                    await this.exec({ script: `date -s @${now} >/dev/null; ${PREPARE}`, timeoutMs: 20000 }).catch(() => {});
                    return;
                }
            }
        }
        throw new Error('guest agent did not start (is 9p mountable in this guest?)');
    }

    /**
     * Reconnect to the agentd of a VM resumed from a snapshot: it is still
     * running, polling the volume. Then set the guest's clock, which stopped
     * when the snapshot was taken.
     * @returns {Promise<boolean>} false if no agentd answered
     */
    async attach({ timeoutMs = 8000 } = {}) {
        const { vm } = this;
        await vm.volumeDelete(VOLUME, '/req').catch(() => {});
        await vm.volumeMkdir(VOLUME, '/req');
        await vm.volumePutFile(VOLUME, '/bin/job', JOB);   // read afresh for every job
        this.ready = true;
        try {
            const now = Math.floor(Date.now() / 1000);
            const r = await this.exec({ script: `date -s @${now} >/dev/null; ${PREPARE}`, timeoutMs, graceMs: 2000 });
            if (r.rc === 0 && !r.timedOut) return true;
        } catch { /* nothing answered */ }
        this.ready = false;
        return false;
    }

    /**
     * Set the guest's date to the page's. After the browser paused the page, the
     * engine leaves the pause out of the guest's timers (jsemu.c, skip_pause_gap),
     * so its clock is behind by that much.
     */
    async syncClock() {
        if (!this.ready) return false;
        const now = Math.floor(Date.now() / 1000);
        const r = await this.exec({ script: `date -s @${now} >/dev/null`, timeoutMs: 20000 }).catch(() => null);
        return !!r && r.rc === 0 && !r.timedOut;
    }

    /**
     * Run a script in the guest.
     * @param {object} job
     * @param {string} job.script       sourced by sh; `$AGENT_DIR` is the request directory
     * @param {string} [job.cwd]        starting directory
     * @param {number} [job.timeoutMs]
     * @param {Object<string,Uint8Array|string>} [job.inputs]   files placed in $AGENT_DIR
     * @param {string[]} [job.outputs]  files to read back from $AGENT_DIR
     * @param {(chunk:Uint8Array)=>void} [job.onOutput]  called as output grows
     * @param {AbortSignal} [job.signal]
     * @param {number} [job.graceMs]    how long past the timeout to wait for the kill
     * @returns {Promise<{rc:number, out:Uint8Array, cwd:string|null, timedOut:boolean,
     *                    aborted:boolean, overflow:boolean, files:Object<string,Uint8Array|null>}>}
     */
    async exec({ script, cwd = '/', timeoutMs = 120000, inputs = {}, outputs = [], onOutput, signal, graceMs = GRACE_MS }) {
        if (!this.ready) throw new Error('the guest is not ready yet');
        const { vm } = this;
        const dir = `/req/${++this._seq}`;

        for (const [name, data] of Object.entries(inputs)) await vm.volumePutFile(VOLUME, `${dir}/${name}`, data);
        await vm.volumePutFile(VOLUME, `${dir}/script`, script);
        await vm.volumePutFile(VOLUME, `${dir}/cwd`, cwd);
        await vm.volumePutFile(VOLUME, `${dir}/go`, '');

        const timeoutAt = pauses.now() + timeoutMs;
        const deadline = timeoutAt + graceMs;
        let seen = 0;
        let out = new Uint8Array(0);
        let killed = false;
        let overflow = false;
        let timedOut = false;
        const kill = () => {
            if (!killed) { killed = true; vm.volumePutFile(VOLUME, `${dir}/kill`, ''); }
        };

        try {
            for (;;) {
                const entries = (await vm.volumeList(VOLUME, dir)) || [];
                const done = entries.some((e) => e.name === 'rc');
                const size = entries.find((e) => e.name === 'out')?.size || 0;

                // Read `rc` before the final `out`, so no output is missed: the
                // job has already exited by the time rc exists.
                if (size !== seen || done) {
                    out = (await vm.volumeGetFile(VOLUME, `${dir}/out`)) || out;
                    if (out.length > seen) onOutput?.(out.subarray(seen));
                    seen = out.length;
                }
                if (done) break;

                if (signal?.aborted) kill();
                if (seen > MAX_OUTPUT) { overflow = true; kill(); }
                if (!killed && pauses.now() > timeoutAt) { timedOut = true; kill(); }
                if (pauses.now() > deadline) throw new Error('the guest stopped responding');
                await sleep(POLL_MS);
            }

            const text = async (name) => {
                const b = await vm.volumeGetFile(VOLUME, `${dir}/${name}`);
                return b ? new TextDecoder().decode(b).trim() : null;
            };
            const files = {};
            for (const name of outputs) files[name] = await vm.volumeGetFile(VOLUME, `${dir}/${name}`);
            return {
                rc: parseInt(await text('rc'), 10),
                out,
                cwd: await text('cwd.after'),
                timedOut,
                aborted: !!signal?.aborted,
                overflow,
                files,
            };
        } finally {
            await vm.volumeDelete(VOLUME, dir).catch(() => {});
        }
    }
}
