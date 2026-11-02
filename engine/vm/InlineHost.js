/*
 * InlineHost.js — run a VM on the CURRENT thread using EmulatorFactory's closure
 * wrapping. Multiple InlineHosts coexist in one realm because each gets its own
 * isolated Module (no rebuild, no worker). Best for light/console VMs, for pages
 * that can't spawn workers, or when you want everything in one thread.
 *
 * Trade-off: a busy guest runs its CPU loop on this thread. For heavy VMs prefer
 * WorkerHost. Also, like pause, a clean inline `stop` needs a C-side `vm_stop`
 * export (see plan-c-changes.md §2); until then stop() best-effort halts I/O and
 * the run loop keeps ticking in the background.
 */

'use strict';

import { EmulatorFactory } from './EmulatorFactory.js';
import { EmulatorEngine } from './EmulatorEngine.js';

export class InlineHost {
    constructor(urls, sink) {
        this.urls = urls;
        this.sink = sink;
        this.engine = null;
    }

    async start(config) {
        const factory = await EmulatorFactory.fromUrl(this.urls.wasmJsUrl);
        return new Promise((resolve, reject) => {
            let settled = false;
            const engineSink = {
                console: (b) => this.sink.console(b),
                netTx: (f) => this.sink.netTx(f),
                state: (s) => this.sink.state(s),
                log: (l, t) => {
                    this.sink.log(l, t);
                    if (l === 'err' && !settled && /vm_start failed/.test(t)) {
                        settled = true; reject(new Error(t));
                    }
                },
                booted: () => { if (!settled) { settled = true; resolve(); } },
                exit: () => this.sink.state('stopped'),
                downloading: (f) => this.sink.downloading && this.sink.downloading(f),
                exportFile: (n, file, url) => this.sink.exportFile && this.sink.exportFile(n, file, url),
            };
            this.engine = new EmulatorEngine(factory, engineSink);
            this.engine.boot({
                ...config,
                locateFile: (p) => (p.endsWith('.wasm') ? this.urls.wasmBinUrl : p),
            });
        });
    }

    sendInput(data) { this.engine?.sendInput(data); }
    deliverFrame(frame) { this.engine?.deliverFrame(frame); }
    resize(cols, rows) { this.engine?.resize(cols, rows); }
    pause() { return Promise.resolve(this.engine ? this.engine.pause() : false); }
    resume() { return Promise.resolve(this.engine ? this.engine.resume() : false); }
    flush() { return this.engine ? this.engine.flush() : Promise.resolve(); }
    volOp(op, volName, args) {
        return this.engine ? this.engine.volOp(op, volName, args)
                           : Promise.reject(new Error('VM not running'));
    }
    snapshot(options) {
        return this.engine ? this.engine.snapshot(options) : Promise.reject(new Error('VM not running'));
    }
    stop() { this.engine?.stop(); }
}
