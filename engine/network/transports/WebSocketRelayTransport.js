/*
 * WebSocketRelayTransport.js — external-internet L2 trunk for VirtualNetwork.
 *
 * Bridges guest Ethernet frames to a WebSocket relay that NATs them onto the
 * real internet (e.g. Benjamin Burns' `wss://relay.widgetry.org/`, the relay
 * JSLinux uses). Implements the same transport interface as
 * BroadcastChannelTransport (onFrame/send/start/stop), so it plugs into
 * VirtualNetwork.attachTransport() the same way:
 *
 *     mgr.network.attachTransport(new WebSocketRelayTransport());
 *
 * This is the wired, de-bugged successor to reference-websocket-relay.js
 * (roadmap #8): it talks to VirtualNetwork rather than a single VM, adds
 * auto-reconnect, and handles the relay's `ping:`/`pong:` text keepalive.
 *
 * Relay protocol: binary messages are raw Ethernet frames; a `ping:<token>`
 * text message must be answered with `pong:<token>`.
 *
 * NOTE: with a real relay the guest is on a REAL external network, so let the
 * relay's DHCP assign the guest's address — do not also run the local JS DHCP
 * server on that segment (`network: { createRouter: false }`).
 */

'use strict';

import { NetworkTransport } from './NetworkTransport.js';

export const RELAY_DEFAULT_URI = 'wss://relay.widgetry.org/';

export class WebSocketRelayTransport extends NetworkTransport {
    /**
     * @param {string} [uri]
     * @param {object} [options]
     * @param {boolean} [options.reconnect=true]
     * @param {number}  [options.reconnectDelayMs=2000]
     * @param {(up:boolean)=>void} [options.onStatus]  link up/down notifications
     */
    constructor(uri = RELAY_DEFAULT_URI, options = {}) {
        super();
        this.uri = uri;
        this.reconnect = options.reconnect !== false;
        this.reconnectDelayMs = options.reconnectDelayMs || 2000;
        this.onStatus = options.onStatus || null;

        this.socket = null;
        this._closed = false;
        this._reconnectTimer = null;
        this.stats = { sent: 0, received: 0, pings: 0, reconnects: 0, up: false };
    }

    start() {
        this._closed = false;
        this._connect();
    }

    stop() {
        this._closed = true;
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this.socket) {
            try { this.socket.onclose = null; this.socket.close(); } catch { /* ignore */ }
            this.socket = null;
        }
        this._setUp(false);
        super.stop();
    }

    _connect() {
        if (typeof WebSocket === 'undefined') {
            throw new Error('WebSocket is not available in this environment');
        }
        let sock;
        try {
            sock = new WebSocket(this.uri);
        } catch (e) {
            console.error('WebSocketRelayTransport: open failed', this.uri, e);
            this._scheduleReconnect();
            return;
        }
        sock.binaryType = 'arraybuffer';
        this.socket = sock;

        sock.onopen = () => this._setUp(true);
        sock.onclose = () => {
            this._setUp(false);
            if (!this._closed) this._scheduleReconnect();
        };
        sock.onerror = (err) => console.error('WebSocketRelayTransport: socket error', err);
        sock.onmessage = (ev) => this._onMessage(ev);
    }

    _scheduleReconnect() {
        if (!this.reconnect || this._closed || this._reconnectTimer) return;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.stats.reconnects++;
            this._connect();
        }, this.reconnectDelayMs);
    }

    _setUp(up) {
        if (this.stats.up === up) return;
        this.stats.up = up;
        try { this.onStatus?.(up); } catch { /* ignore */ }
    }

    _onMessage(ev) {
        const data = ev.data;
        if (data instanceof ArrayBuffer) {
            const frame = new Uint8Array(data);
            if (frame.length) { this.stats.received++; this._emitFrame(frame); }
            return;
        }
        const str = String(data);
        if (str.startsWith('ping:')) {
            this.stats.pings++;
            try { this.socket?.send('pong:' + str.substring(5)); } catch { /* ignore */ }
        }
    }

    /** VirtualNetwork → relay. */
    send(frame) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        this.stats.sent++;
        try {
            // Send a standalone copy; don't hand the network's buffer to the socket.
            this.socket.send(new Uint8Array(frame));
        } catch (e) {
            console.error('WebSocketRelayTransport: send failed', e);
        }
    }

    getStats() { return { ...this.stats, uri: this.uri }; }
}
