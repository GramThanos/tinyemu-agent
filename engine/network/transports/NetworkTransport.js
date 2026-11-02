/*
 * NetworkTransport.js — the extension point for VirtualNetwork.
 *
 * A transport is a link that carries raw Ethernet frames between this tab's
 * VirtualNetwork and *something else*: another browser tab, a server that NATs
 * to the internet, a peer browser over WebRTC, a physical TAP device behind a
 * relay, ... VirtualNetwork stays a pure in-tab L2 switch; transports are how it
 * reaches other segments.
 *
 * To add a new kind of connection, subclass this (or just duck-type the same
 * four methods) and hand an instance to `virtualNetwork.attachTransport(t)`.
 * Multiple transports can be attached at once.
 *
 * Contract
 * --------
 *   send(frame: Uint8Array)   VirtualNetwork → link. Called for every broadcast
 *                             and for any unicast no local device claimed. Do
 *                             NOT retain `frame`; copy if you send asynchronously.
 *   onFrame(cb)               Register the sink for link → VirtualNetwork frames.
 *                             Call `this._emitFrame(frame)` (or the stored cb)
 *                             with a Uint8Array for each frame you receive.
 *   start()                   Open the underlying connection (called on attach).
 *   stop()                    Close it and release resources (called on detach).
 *   getStats()                Optional; a plain object for dashboards.
 *
 * Delivery model (handled by VirtualNetwork, not here):
 *   - Frames you emit are switched locally; if the destination isn't local they
 *     are offered to the OTHER transports (never echoed back to you).
 *   - Frames arriving from a transport are delivered locally only — they are not
 *     forwarded between transports, so attaching several transports does not by
 *     itself bridge them together (that would risk loops/broadcast storms).
 *
 * Frames are complete Ethernet frames (dst MAC | src MAC | ethertype | payload),
 * no preamble and no FCS — the same bytes the guest's virtio-net NIC produces.
 */

'use strict';

export class NetworkTransport {
    constructor() {
        this._onFrame = null;
    }

    /** VirtualNetwork calls this to register its inbound-frame sink. */
    onFrame(cb) { this._onFrame = cb; }

    /** Subclasses call this to hand a received frame to VirtualNetwork. */
    _emitFrame(frame) {
        if (!this._onFrame || !frame || !frame.length) return;
        this._onFrame(frame instanceof Uint8Array ? frame : new Uint8Array(frame));
    }

    /* eslint-disable no-unused-vars */
    /** Open the connection. Override in subclasses. */
    start() {}

    /** Close the connection and release resources. Override in subclasses. */
    stop() { this._onFrame = null; }

    /** VirtualNetwork → link. MUST be implemented by subclasses. */
    send(frame) { throw new Error('NetworkTransport.send() not implemented'); }
    /* eslint-enable no-unused-vars */

    getStats() { return {}; }
}
