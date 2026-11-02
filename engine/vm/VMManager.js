/*
 * VMManager.js — owns multiple VMs, one shared VirtualNetwork, and volumes.
 *
 * Each VM runs in its own Web Worker (see VM.js / vm-worker.js). The manager
 * bridges every VM's virtio-net traffic onto the shared JS VirtualNetwork
 * (DHCP/ARP/routing all handled in JS — see js/network), and attaches volumes
 * via the VolumeManager.
 */

'use strict';

import { VM, VMState } from './VM.js';
import {
    VirtualNetwork, NetworkDevice, DeviceType, DeviceCapability,
    EthernetFrame, MACUtils,
} from '../network/index.js';
import { VolumeManager } from '../volumes/index.js';

/**
 * A network device that represents a real (WASM) guest. It forwards frames
 * between the VirtualNetwork and the VM worker, and learns the guest's MAC from
 * outbound traffic (the guest kernel chooses its own MAC, unknown to JS up
 * front), so unicast delivery from other VMs can find it.
 */
class VMBridgeDevice extends NetworkDevice {
    constructor(id, mac, vm) {
        super(id, DeviceType.VM, {
            name: `VM-${id}`,
            macAddress: mac,
            capabilities: [DeviceCapability.PACKET_RX, DeviceCapability.PACKET_TX],
        });
        this.vm = vm;
        this._learnedMac = null;   // bytes of the last-learned MAC
        this._learnedKey = null;   // packed-int key of the last-learned MAC
    }

    // Network → guest.
    handlePacket(frameBuffer /*, fromDevice */) {
        this.vm.deliverFrame(frameBuffer);
        return true;
    }

    // Called for each guest → network frame, before it is switched.
    learnFromGuest(frame) {
        try {
            const eth = new EthernetFrame(frame);
            const key = MACUtils.keyNum(eth.srcMAC);   // 0 == all-zero MAC
            if (key !== 0 && key !== this._learnedKey) {
                if (this.network) {
                    // Drop the previously mapped MAC for this bridge. On the FIRST
                    // learn that is the JS-generated placeholder MAC that register()
                    // inserted (the guest kernel picks its own MAC, usually
                    // different); on later learns it is the prior guest MAC. Either
                    // way, only one MAC should map to this bridge at a time.
                    this.network.forgetMAC(this._learnedMac || this.macAddress);
                }
                this._learnedKey = key;
                this.macAddress = new Uint8Array(eth.srcMAC);
                this._learnedMac = this.macAddress;
                if (this.network) this.network.learnMAC(this.macAddress, this.id);
            }
        } catch { /* not a parseable frame; ignore */ }
    }
}

export class VMManager {
    constructor(options = {}) {
        this.network = new VirtualNetwork(options.network || {});
        this.volumes = new VolumeManager(options.volumes || {});
        this.vms = new Map();

        // Optional transport(s) that extend the LAN beyond this tab: cross-tab
        // (BroadcastChannel), internet via a server (WebSocket relay), P2P
        // (WebRTC), etc. Pass one transport or an array as options.transport(s),
        // or attach later via mgr.network.attachTransport(). Omit for a
        // self-contained in-tab LAN (the common case).
        const transports = options.transports
            || (options.transport ? [options.transport] : []);
        for (const t of transports) this.network.attachTransport(t);

        // Resolve worker / WASM URLs relative to this module so they work no
        // matter where the app is served from.
        this._urls = {
            workerUrl:  new URL('./vm-worker.js',    import.meta.url).href,
            wasmJsUrl:  new URL('../x86emu-wasm.js',  import.meta.url).href,
            wasmBinUrl: new URL('../x86emu-wasm.wasm', import.meta.url).href,
            ...(options.urls || {}),
        };
    }

    /**
     * Create (but do not start) a VM. Await it so volumes can be provisioned;
     * subscribe to events, then call vm.start().
     *
     * @param {string} id
     * @param {object} config  see VM.js; plus `volumes: [{name, backend, mountpoint, size}]`
     */
    async create(id, config = {}) {
        if (this.vms.has(id)) throw new Error(`VM ${id} already exists`);

        const mac = config.mac
            ? (typeof config.mac === 'string' ? MACUtils.parse(config.mac) : config.mac)
            : MACUtils.generate(id);

        const vm = new VM(id, config, this._urls);
        vm.mac = MACUtils.toString(mac);

        // --- network bridge ---
        const bridge = new VMBridgeDevice(id, mac, vm);
        this.network.register(bridge);
        vm.netDevice = bridge;

        vm.onNetTx((frame) => {
            bridge.learnFromGuest(frame);
            bridge.sendPacket(frame);          // → VirtualNetwork.deliverPacket
        });

        // --- volumes ---
        // Volumes (`files` 9p and `block` disks) are owned by the emulator
        // engine: it creates the backend inside the VM's realm (the worker, in
        // worker mode) so guest I/O is served there — a main-thread backend
        // can't serve a worker's synchronous C calls. We only pass the specs
        // through (already on vm.config.volumes) and record them for status.
        if (Array.isArray(config.volumes) && config.volumes.length) {
            vm.volumeSpecs = config.volumes;
        }

        this.vms.set(id, vm);
        this.network.emit?.('vmCreated', vm);
        return vm;
    }

    get(id) { return this.vms.get(id); }
    getAll() { return Array.from(this.vms.values()); }

    async start(id) {
        const vm = this.vms.get(id);
        if (!vm) throw new Error(`no VM ${id}`);
        return vm.start();
    }

    async stop(id) { this.vms.get(id)?.stop(); }

    async destroy(id) {
        const vm = this.vms.get(id);
        if (!vm) return;
        vm.stop();
        if (vm.netDevice) this.network.unregister(vm.netDevice.id);
        await this.volumes.detach(id);
        this.vms.delete(id);
    }

    async destroyAll() {
        for (const id of [...this.vms.keys()]) await this.destroy(id);
    }

    /** Snapshot for a status/dashboard UI. */
    getStatus() {
        return {
            vms: this.getAll().map(v => v.toJSON()),
            network: this.network.getStats(),
            macTable: this.network.getMACTable(),
        };
    }
}

export { VMState };
