/*
 * vm-worker.js — module worker that hosts one TinyEMU instance for WorkerHost.
 *
 * It uses the SAME EmulatorFactory (closure wrapping) and EmulatorEngine as the
 * main-thread InlineHost, so worker and inline modes behave identically. The
 * closure wrapping means the worker isn't limited to one instance either — it
 * could drive several isolated Modules — though WorkerHost uses one per worker.
 *
 * Protocol
 *   main → worker : start{config} | stdin{data} | net-rx{frame}
 *                   resize{cols,rows} | pause | resume | flush | stop
 *                   vol-op{id,op,volName,args} | snapshot{id,options}
 *   worker → main : booted | stdout{data} | net-tx{frame} | state{state}
 *                   log{level,text} | flushed | stopped | exit
 *                   vol-reply{id,ok,result|error}
 *                   snapshot-reply{id,ok,blob,info|error}
 * start{config} may carry config.snapshot (a Blob) to resume instead of boot.
 */

'use strict';

import { EmulatorFactory } from './EmulatorFactory.js';
import { EmulatorEngine } from './EmulatorEngine.js';

let engine = null;

function post(msg, transfer) {
    try { self.postMessage(msg, transfer || []); } catch { /* worker gone */ }
}

const sink = {
    console: (b) => post({ type: 'stdout', data: b }, [b.buffer]),
    netTx: (f) => post({ type: 'net-tx', frame: f }, [f.buffer]),
    state: (s) => post({ type: 'state', state: s }),
    log: (level, text) => post({ type: 'log', level, text }),
    booted: () => post({ type: 'booted' }),
    exit: () => post({ type: 'exit' }),
    downloading: (flag) => post({ type: 'downloading', flag }),
    // The Blob is structured-cloneable; the object URL is worker-local, so drop
    // it and let the main thread mint its own from the Blob.
    exportFile: (name, file /*, url */) => post({ type: 'export-file', name, blob: file }),
};

self.onmessage = async (ev) => {
    const msg = ev.data || {};
    switch (msg.type) {
        case 'start':  return onStart(msg.config || {});
        case 'stdin':  return engine?.sendInput(msg.data);
        case 'net-rx': return engine?.deliverFrame(msg.frame);
        case 'resize': return engine?.resize(msg.cols, msg.rows);
        case 'pause':  return void (engine && engine.pause());
        case 'resume': return void (engine && engine.resume());
        case 'flush':
            if (engine) await engine.flush();
            return void post({ type: 'flushed' });
        case 'vol-op': {
            if (!engine) return void post({ type: 'vol-reply', id: msg.id, ok: false, error: 'no engine' });
            try {
                const result = await engine.volOp(msg.op, msg.volName, msg.args || {});
                const transfer = (result && result.buffer) ? [result.buffer] : [];
                post({ type: 'vol-reply', id: msg.id, ok: true, result }, transfer);
            } catch (e) {
                post({ type: 'vol-reply', id: msg.id, ok: false, error: String(e && e.message || e) });
            }
            return;
        }
        case 'snapshot': {
            try {
                if (!engine) throw new Error('no engine');
                const { blob, info } = await engine.snapshot(msg.options || {});
                post({ type: 'snapshot-reply', id: msg.id, ok: true, blob, info });
            } catch (e) {
                post({ type: 'snapshot-reply', id: msg.id, ok: false, error: String(e && e.message || e) });
            }
            return;
        }
        case 'stop':
            if (engine) await engine.stopAndFlush();  // persist volumes before ack
            return void post({ type: 'stopped' });
        default:       return;
    }
};

async function onStart(config) {
    if (engine) return;
    try {
        const factory = await EmulatorFactory.fromUrl(config.wasmJsUrl);
        engine = new EmulatorEngine(factory, sink);
        engine.boot({
            ...config,
            locateFile: (p) => (p.endsWith('.wasm') ? config.wasmBinUrl : p),
        });
    } catch (e) {
        post({ type: 'error', message: 'worker start failed: ' + (e && e.message || e) });
    }
}
