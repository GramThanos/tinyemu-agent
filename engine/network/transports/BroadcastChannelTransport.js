/*
 * BroadcastChannelTransport.js — a cross-tab L2 trunk for VirtualNetwork.
 *
 * Bridges raw Ethernet frames between VirtualNetwork instances living in
 * DIFFERENT browsing contexts of the SAME origin (other tabs/windows, or a
 * SharedWorker) via a BroadcastChannel. Attach it with:
 *
 *     import { VMManager } from './js/vm/index.js';
 *     import { BroadcastChannelTransport } from './js/network/transports/BroadcastChannelTransport.js';
 *     const mgr = new VMManager({ network: { subnet: '10.0.2.0/24' } });
 *     mgr.network.attachTransport(new BroadcastChannelTransport('tinyemu-lan'));
 *
 * From the guests' point of view every tab is one shared LAN: broadcasts (ARP,
 * DHCP DISCOVER) reach every tab, and unicast a local switch can't place is
 * offered to the trunk, where the owning tab delivers it.
 *
 * DHCP topology: each VirtualNetwork has its OWN RouterDevice/DHCP server by
 * default, and two servers on one shared segment will both answer (and can hand
 * out colliding IPs). For a shared LAN, run the DHCP server in exactly ONE tab
 * and create the others with `network: { createRouter: false }` so DHCP/ARP for
 * the gateway is served over the trunk by the single router.
 *
 * BroadcastChannel does not echo a sender its own messages, but we still tag
 * each frame with a per-instance source id so multiple networks sharing one
 * channel within a single context don't feed themselves.
 */

'use strict';

import { NetworkTransport } from './NetworkTransport.js';

let _seq = 0;

export class BroadcastChannelTransport extends NetworkTransport {
    /**
     * @param {string} channelName  all peers on the same LAN use the same name
     * @param {object} [options]
     * @param {(frame:Uint8Array)=>boolean} [options.filter]  return false to drop
     *        an outbound frame instead of mirroring it (e.g. keep DHCP tab-local)
     */
    constructor(channelName = 'tinyemu-lan', options = {}) {
        super();
        this.channelName = channelName;
        this.filter = options.filter || null;
        this.sourceId = `bc-${Date.now().toString(36)}-${(++_seq)}-${Math.random().toString(36).slice(2, 8)}`;
        this.channel = null;
        this.stats = { sent: 0, received: 0, droppedSelf: 0, filtered: 0 };
    }

    start() {
        if (this.channel) return;
        if (typeof BroadcastChannel === 'undefined') {
            throw new Error('BroadcastChannel is not available in this environment');
        }
        this.channel = new BroadcastChannel(this.channelName);
        this.channel.onmessage = (ev) => this._onMessage(ev.data);
    }

    stop() {
        if (this.channel) {
            try { this.channel.close(); } catch { /* ignore */ }
            this.channel = null;
        }
        super.stop();
    }

    /** VirtualNetwork → trunk. `frame` is a Uint8Array owned by the network. */
    send(frame) {
        if (!this.channel) return;
        if (this.filter && this.filter(frame) === false) { this.stats.filtered++; return; }
        // Copy into a standalone ArrayBuffer we can transfer without detaching
        // the network's buffer (it may still be delivering the frame locally).
        const copy = new Uint8Array(frame);
        this.stats.sent++;
        try {
            this.channel.postMessage({ src: this.sourceId, frame: copy.buffer }, [copy.buffer]);
        } catch {
            // Some engines reject transferables on BroadcastChannel; clone instead.
            this.channel.postMessage({ src: this.sourceId, frame: new Uint8Array(frame).buffer });
        }
    }

    _onMessage(msg) {
        if (!msg || msg.src === this.sourceId) { this.stats.droppedSelf++; return; }
        const frame = msg.frame instanceof ArrayBuffer ? new Uint8Array(msg.frame)
                    : (msg.frame ? new Uint8Array(msg.frame) : null);
        if (!frame || !frame.length) return;
        this.stats.received++;
        this._emitFrame(frame);
    }

    getStats() { return { ...this.stats, channel: this.channelName, sourceId: this.sourceId }; }
}
