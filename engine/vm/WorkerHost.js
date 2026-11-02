/*
 * WorkerHost.js — run a VM in its own Web Worker (module worker). Keeps a busy
 * guest's CPU loop off the UI thread and makes `stop` clean (terminate the
 * worker). The worker (vm-worker.js) uses the SAME EmulatorFactory/Engine, so
 * behaviour matches InlineHost exactly.
 */

'use strict';

export class WorkerHost {
    constructor(urls, sink) {
        this.urls = urls;
        this.sink = sink;
        this.worker = null;
        this._startResolve = null;
        this._startReject = null;
        this._pauseWaiter = null;
        this._flushWaiter = null;
        this._stoppedWaiter = null;
        this._volSeq = 0;
        this._volWaiters = new Map();
    }

    start(config) {
        this.worker = new Worker(this.urls.workerUrl, { type: 'module' });
        this.worker.onmessage = (ev) => this._onMessage(ev.data || {});
        this.worker.onerror = (e) => {
            const err = new Error(e.message || 'worker error');
            this.sink.error(err);
            this._startReject?.(err);
            this._startResolve = this._startReject = null;
        };

        this.worker.postMessage({
            type: 'start',
            config: {
                ...config,
                wasmJsUrl: this.urls.wasmJsUrl,
                wasmBinUrl: this.urls.wasmBinUrl,
            },
        });

        return new Promise((resolve, reject) => {
            this._startResolve = resolve;
            this._startReject = reject;
        });
    }

    _onMessage(msg) {
        switch (msg.type) {
            case 'booted':
                this._startResolve?.(); this._startResolve = this._startReject = null; break;
            case 'stdout': this.sink.console(msg.data); break;
            case 'net-tx': this.sink.netTx(msg.frame); break;
            case 'state':
                this.sink.state(msg.state);
                if (msg.state === 'paused' && this._pauseWaiter) this._pauseWaiter(true);
                break;
            case 'log': this.sink.log(msg.level, msg.text); break;
            case 'flushed': if (this._flushWaiter) this._flushWaiter(); break;
            case 'vol-reply': {
                const w = this._volWaiters.get(msg.id);
                if (w) {
                    this._volWaiters.delete(msg.id);
                    if (msg.ok) w.resolve(msg.result);
                    else w.reject(new Error(msg.error || 'volume op failed'));
                }
                break;
            }
            case 'snapshot-reply': {
                const w = this._volWaiters.get(msg.id);
                if (w) {
                    this._volWaiters.delete(msg.id);
                    if (msg.ok) w.resolve({ blob: msg.blob, info: msg.info });
                    else w.reject(new Error(msg.error || 'snapshot failed'));
                }
                break;
            }
            case 'stopped':
                if (this._stoppedWaiter) this._stoppedWaiter();
                this.sink.state('stopped');
                break;
            case 'downloading': this.sink.downloading && this.sink.downloading(msg.flag); break;
            case 'export-file': {
                if (this.sink.exportFile) {
                    const url = URL.createObjectURL(msg.blob);
                    this.sink.exportFile(msg.name, msg.blob, url);
                }
                break;
            }
            case 'error': {
                const err = new Error(msg.message);
                this.sink.error(err);
                this._startReject?.(err); this._startResolve = this._startReject = null;
                break;
            }
            case 'exit': this.sink.state('stopped'); break;
        }
    }

    sendInput(data) { this.worker?.postMessage({ type: 'stdin', data }); }

    deliverFrame(frame) {
        if (!this.worker) return;
        const copy = new Uint8Array(frame);
        this.worker.postMessage({ type: 'net-rx', frame: copy }, [copy.buffer]);
    }

    resize(cols, rows) { this.worker?.postMessage({ type: 'resize', cols, rows }); }

    pause() {
        if (!this.worker) return Promise.resolve(false);
        this.worker.postMessage({ type: 'pause' });
        return new Promise((resolve) => {
            const to = setTimeout(() => { this._pauseWaiter = null; resolve(false); }, 1000);
            this._pauseWaiter = (ok) => { clearTimeout(to); this._pauseWaiter = null; resolve(ok); };
        });
    }

    resume() { this.worker?.postMessage({ type: 'resume' }); return Promise.resolve(true); }

    flush() {
        if (!this.worker) return Promise.resolve();
        this.worker.postMessage({ type: 'flush' });
        return new Promise((resolve) => {
            const to = setTimeout(() => { this._flushWaiter = null; resolve(); }, 5000);
            this._flushWaiter = () => { clearTimeout(to); this._flushWaiter = null; resolve(); };
        });
    }

    volOp(op, volName, args, transfer) {
        if (!this.worker) return Promise.reject(new Error('VM not running'));
        const id = ++this._volSeq;
        return new Promise((resolve, reject) => {
            this._volWaiters.set(id, { resolve, reject });
            this.worker.postMessage({ type: 'vol-op', id, op, volName, args }, transfer || []);
        });
    }

    /* Shares the vol-op reply table: both are request/response by id. */
    snapshot(options) {
        if (!this.worker) return Promise.reject(new Error('VM not running'));
        const id = ++this._volSeq;
        return new Promise((resolve, reject) => {
            this._volWaiters.set(id, { resolve, reject });
            this.worker.postMessage({ type: 'snapshot', id, options });
        });
    }

    stop() {
        const worker = this.worker;
        if (!worker) { this.sink.state('stopped'); return; }
        this.worker = null;   // stop routing new work; keep `worker` for teardown
        // Ask the worker to flush volumes, then terminate. Bounded so a wedged
        // worker can't hang teardown. Volume writes also autosave every ~3 s.
        let done = false;
        const finish = () => {
            if (done) return; done = true;
            try { worker.terminate(); } catch {}
            this._stoppedWaiter = null;
            this.sink.state('stopped');
        };
        this._stoppedWaiter = finish;
        try { worker.postMessage({ type: 'stop' }); } catch { finish(); return; }
        setTimeout(finish, 5000);
    }
}
