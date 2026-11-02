import { NetworkDevice, DeviceManager, DeviceType, DeviceCapability } from './NetworkDevice.js';
import { MACUtils } from '../utils/MACUtils.js';
import { IPUtils } from '../utils/IPUtils.js';
import { ARPPacket } from '../packets/ARPPacket.js';
import { IPPacket } from '../packets/IPPacket.js';
import { VMDevice } from './VMDevice.js';
import { RouterDevice } from './RouterDevice.js';
import { DummyClientDevice } from './DummyClientDevice.js';
import { DHCPServer } from './RouterDevice.js';

export class VirtualNetwork extends DeviceManager {
    constructor(options = {}) {
        super();
        
        const subnetCIDR = options.subnet || '10.0.2.0/24';
        const { ip: subnetIP, mask: subnetMask } = typeof subnetCIDR === 'string' ? IPUtils.parseCIDR(subnetCIDR) : { ip: subnetCIDR, mask: options.netmask };
        this.subnet = subnetIP;
        this.netmask = options.netmask ? (typeof options.netmask === 'string' ? IPUtils.parse(options.netmask) : options.netmask) : subnetMask;
        this.gatewayIP = options.gatewayIP ? (typeof options.gatewayIP === 'string' ? IPUtils.parse(options.gatewayIP) : options.gatewayIP) : IPUtils.parse('10.0.2.2');
        this.dnsServer = options.dnsServer ? (typeof options.dnsServer === 'string' ? IPUtils.parse(options.dnsServer) : options.dnsServer) : IPUtils.parse('10.0.2.3');
        this.dhcpStart = options.dhcpStart ? (typeof options.dhcpStart === 'string' ? IPUtils.parse(options.dhcpStart) : options.dhcpStart) : IPUtils.parse('10.0.2.15');
        this.dhcpEnd = options.dhcpEnd ? (typeof options.dhcpEnd === 'string' ? IPUtils.parse(options.dhcpEnd) : options.dhcpEnd) : IPUtils.parse('10.0.2.100');
        this.leaseTime = options.leaseTime || 86400;
        this.staticBindings = options.staticBindings || {};
        
        this.broadcastMAC = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        
        this.macTable = new Map();
        this.ipToDevice = new Map();

        this.router = null;
        this.dhcpServer = null;

        // Attached transports that extend this L2 segment beyond the local
        // realm — cross-tab (BroadcastChannel), internet (WebSocket relay),
        // peer-to-peer (WebRTC), etc. See network/transports/*. Empty by
        // default: a plain VirtualNetwork is a self-contained in-tab LAN.
        // Frames that can't be delivered locally (and all broadcasts) are
        // mirrored to every transport; frames arriving from a transport are
        // injected via injectFromTransport() and never echoed back.
        this.transports = new Set();
        
        // Packet log is a fixed-capacity ring buffer (O(1) append, no shift) and
        // is only populated while logging is enabled — a VM nobody is inspecting
        // pays nothing per packet. Enable with setPacketLogging(true).
        this.maxPacketLog = options.maxPacketLog || 1000;
        this.packetLogging = options.packetLogging || false;
        this._log = new Array(this.maxPacketLog);
        this._logHead = 0;   // next write slot
        this._logCount = 0;  // entries currently stored (<= maxPacketLog)
        
        this.stats = {
            totalPackets: 0,
            forwarded: 0,
            dropped: 0,
            broadcast: 0,
            unicast: 0,
            errors: 0
        };
        
        this.setNetwork(this);
        
        if (options.createRouter !== false) {
            this.createRouter(options);
        }
    }

    createRouter(options = {}) {
        this.router = new RouterDevice('router', {
            name: 'Main Router',
            subnet: this.subnet,
            netmask: this.netmask,
            gatewayIP: this.gatewayIP,
            dnsServer: this.dnsServer,
            dhcpStartIP: this.dhcpStart,
            dhcpEndIP: this.dhcpEnd,
            leaseTime: this.leaseTime,
            staticBindings: this.staticBindings
        });
        
        this.register(this.router);
        this.dhcpServer = this.router.dhcpServer;
        
        return this.router;
    }

    getRouter() {
        return this.router;
    }

    getDHCPServer() {
        return this.dhcpServer;
    }

    register(device) {
        super.register(device);
        
        if (device.macAddress) {
            this.macTable.set(MACUtils.keyNum(device.macAddress), device.id);
        }

        for (const ip of device.ipAddresses) {
            this.ipToDevice.set(ip, device.id);
        }

        if (this.router && device !== this.router) {
            this.router.addConnectedDevice(device);
        }
        
        return device;
    }

    unregister(deviceId) {
        const device = this.get(deviceId);
        if (device) {
            if (device.macAddress) {
                this.macTable.delete(MACUtils.keyNum(device.macAddress));
            }
            for (const ip of device.ipAddresses) {
                this.ipToDevice.delete(ip);
            }
            if (this.router) {
                this.router.removeConnectedDevice(deviceId);
            }
        }
        return super.unregister(deviceId);
    }

    /* MAC table mutators. The table is keyed by a packed-integer form of the MAC
     * (MACUtils.keyNum) so the switch never formats a hex string on the unicast
     * hot path. Callers that learn/forget a device's MAC at runtime (e.g. a
     * bridge that adopts the guest kernel's chosen MAC) MUST go through these
     * instead of touching macTable directly, so the key representation stays in
     * one place. `mac` is a 6-byte Uint8Array. */
    learnMAC(mac, deviceId) { this.macTable.set(MACUtils.keyNum(mac), deviceId); }
    forgetMAC(mac) { this.macTable.delete(MACUtils.keyNum(mac)); }

    createVM(id, options = {}) {
        const vm = new VMDevice(id, {
            gatewayIP: IPUtils.toString(this.gatewayIP),
            dnsServers: [IPUtils.toString(this.dnsServer)],
            autoDHCP: options.autoDHCP !== false,
            ...options
        });
        
        return this.register(vm);
    }

    createDummyClient(id, options = {}) {
        const client = new DummyClientDevice(id, {
            gatewayIP: IPUtils.toString(this.gatewayIP),
            ...options
        });
        
        return this.register(client);
    }

    /**
     * @param {NetworkDevice|null} fromDevice  local originator, or null when the
     *        frame arrived from a transport (see injectFromTransport)
     * @param {Uint8Array} frameBuffer
     * @param {object|null} [origin]  the transport a frame came in on, or null
     *        for a locally originated frame. Used to avoid echoing a frame back
     *        out the transport it arrived on.
     */
    deliverPacket(fromDevice, frameBuffer, origin = null) {
        this.stats.totalPackets++;

        const fromTransport = origin !== null;
        if (this.packetLogging) {
            this.logPacket({
                timestamp: Date.now(),
                from: fromDevice ? fromDevice.id : (origin?.name || 'transport'),
                length: frameBuffer.length,
                direction: fromTransport ? 'rx' : 'tx'
            });
        }

        try {
            if (frameBuffer.length < 6) { this.stats.errors++; return false; }

            // The multicast bit (LSB of the first octet) is also set for the
            // broadcast address (ff:ff:...), so this one test covers both — no
            // need to allocate/parse an EthernetFrame just to route the frame.
            if ((frameBuffer[0] & 0x01) !== 0) {
                const delivered = this.broadcast(frameBuffer, fromDevice);
                // A broadcast/multicast is flooded to every segment: mirror it to
                // every attached transport so VMs on other segments see it too.
                this._mirrorToTransports(frameBuffer, origin);
                return delivered;
            }

            // Unicast: read the dst MAC straight from the buffer (bytes 0..5) and
            // pass the original frameBuffer through unchanged.
            const delivered = this.unicast(frameBuffer, fromDevice);
            // Unicast no local device claimed may belong to a device reachable
            // through a transport — offer it to the transports.
            if (!delivered) this._mirrorToTransports(frameBuffer, origin);
            return delivered;
        } catch (e) {
            this.stats.errors++;
            console.error('VirtualNetwork deliverPacket error:', e);
            return false;
        }
    }

    /**
     * Attach a transport (a cross-segment link). Any object with the shape
     * { send(frame), onFrame(cb), start?(), stop?() } works — e.g.
     * BroadcastChannelTransport (cross-tab), WebSocketRelayTransport (internet
     * via a server), or a future WebRTCTransport (peer-to-peer). Multiple
     * transports can be attached at once; each extends the L2 segment.
     * @returns {object} the transport (so callers can keep a handle)
     */
    attachTransport(transport) {
        if (this.transports.has(transport)) return transport;
        this.transports.add(transport);
        transport.onFrame((frameBuffer) => this.injectFromTransport(transport, frameBuffer));
        transport.start?.();
        return transport;
    }

    /** Detach one transport (default: all). */
    detachTransport(transport = null) {
        if (transport === null) {
            for (const t of [...this.transports]) this.detachTransport(t);
            return;
        }
        if (!this.transports.delete(transport)) return;
        try { transport.stop?.(); } catch { /* ignore */ }
    }

    getTransports() { return [...this.transports]; }

    // Send a frame out every transport EXCEPT the one it arrived on (`origin`),
    // so a frame is never echoed straight back to its source segment. Frames
    // that arrived from a transport are delivered locally only and are NOT
    // re-forwarded to the other transports (no transit bridging by default —
    // that would risk broadcast storms and loops between segments).
    _mirrorToTransports(frameBuffer, origin) {
        if (origin !== null || this.transports.size === 0) return;
        for (const t of this.transports) {
            if (t === origin) continue;
            try { t.send(frameBuffer); }
            catch (e) { console.error('VirtualNetwork transport send error:', e); }
        }
    }

    /**
     * Inject a frame that arrived from a transport into this local segment.
     * Delivered like any other frame but tagged with its origin so it is not
     * mirrored back out (which would loop).
     */
    injectFromTransport(transport, frameBuffer) {
        const buf = frameBuffer instanceof Uint8Array ? frameBuffer : new Uint8Array(frameBuffer);
        return this.deliverPacket(null, buf, transport);
    }

    broadcast(frameBuffer, fromDevice) {
        this.stats.broadcast++;
        let delivered = 0;

        // The router is a registered device, so it is already included in
        // getAll() and receives the frame here — do NOT deliver to it a second
        // time explicitly, or every broadcast (DHCP DISCOVER/REQUEST, ARP) gets
        // processed twice (duplicate OFFER/ACK, duplicate ARP replies).
        for (const device of this.getAll()) {
            if (device !== fromDevice && device.hasCapability(DeviceCapability.PACKET_RX)) {
                device.receivePacket(frameBuffer, fromDevice);
                delivered++;
            }
        }

        return delivered > 0;
    }

    unicast(frameBuffer, fromDevice) {
        const targetDeviceId = this.macTable.get(MACUtils.keyNum(frameBuffer, 0));

        if (targetDeviceId) {
            const targetDevice = this.get(targetDeviceId);
            if (targetDevice && targetDevice.hasCapability(DeviceCapability.PACKET_RX)) {
                this.stats.unicast++;
                return targetDevice.receivePacket(frameBuffer, fromDevice);
            }
        }

        if (this.router && MACUtils.equals(frameBuffer, this.router.macAddress, 0, 0)) {
            this.stats.unicast++;
            return this.router.receivePacket(frameBuffer, fromDevice);
        }

        this.stats.dropped++;
        return false;
    }

    /** Enable/disable per-packet logging (off by default; see maxPacketLog). */
    setPacketLogging(on) {
        this.packetLogging = !!on;
        if (!on) this.clearPacketLog();
    }

    logPacket(entry) {
        this._log[this._logHead] = entry;
        this._logHead = (this._logHead + 1) % this.maxPacketLog;
        if (this._logCount < this.maxPacketLog) this._logCount++;
    }

    /** Oldest-to-newest snapshot of the ring buffer. */
    getPacketLog() {
        const out = new Array(this._logCount);
        // When full, the oldest entry sits at _logHead; otherwise entries start at 0.
        const start = this._logCount === this.maxPacketLog ? this._logHead : 0;
        for (let i = 0; i < this._logCount; i++) {
            out[i] = this._log[(start + i) % this.maxPacketLog];
        }
        return out;
    }

    clearPacketLog() {
        this._log = new Array(this.maxPacketLog);
        this._logHead = 0;
        this._logCount = 0;
    }

    getMACTable() {
        // macTable is keyed by packed integer for fast per-packet lookup; rebuild
        // the human-readable "aa:bb:.." form from each device for introspection.
        const out = {};
        for (const device of this.getAll()) {
            if (device.macAddress) out[MACUtils.toString(device.macAddress)] = device.id;
        }
        return out;
    }

    getIPTable() {
        return Object.fromEntries(this.ipToDevice);
    }

    getStats() {
        return {
            ...this.stats,
            devices: this.getAll().length,
            macTableSize: this.macTable.size,
            ipTableSize: this.ipToDevice.size
        };
    }

    getDeviceStats() {
        const stats = {};
        for (const device of this.getAll()) {
            stats[device.id] = device.getStats();
        }
        return stats;
    }

    async runDemo() {
        console.log('=== VirtualNetwork Demo ===\n');
        
        console.log('Creating VM1...');
        const vm1 = this.createVM('vm1', { name: 'Alpine-VM1' });
        console.log(`VM1 MAC: ${MACUtils.toString(vm1.macAddress)}`);
        
        console.log('\nCreating VM2...');
        const vm2 = this.createVM('vm2', { name: 'Alpine-VM2' });
        console.log(`VM2 MAC: ${MACUtils.toString(vm2.macAddress)}`);
        
        console.log('\nCreating Dummy Client...');
        const client = this.createDummyClient('client1', { 
            name: 'Test-Client',
            ipAddress: '10.0.2.100',
            gatewayIP: '10.0.2.2'
        });
        console.log(`Client MAC: ${MACUtils.toString(client.macAddress)}`);
        console.log(`Client IP: ${client.ipAddress}`);
        
        console.log('\n=== Starting DHCP for VM1 ===');
        await this.waitForDHCP(vm1);
        console.log(`VM1 got IP: ${vm1.getDHCPLease()?.ip}`);
        
        console.log('\n=== Starting DHCP for VM2 ===');
        await this.waitForDHCP(vm2);
        console.log(`VM2 got IP: ${vm2.getDHCPLease()?.ip}`);
        
        console.log('\n=== Testing Ping VM1 -> VM2 ===');
        const vm1IP = vm1.getDHCPLease()?.ip;
        const vm2IP = vm2.getDHCPLease()?.ip;
        
        if (vm1IP && vm2IP) {
            const result = await vm1.ping(vm2IP, 3, 500);
            console.log(`Ping result: ${result.received}/${result.sent} received, loss: ${(result.loss * 100).toFixed(1)}%`);
        }
        
        console.log('\n=== Testing Ping Client -> VM1 ===');
        if (vm1IP) {
            const result = await client.ping(vm1IP, 3, 500);
            console.log(`Ping result: ${result.received}/${result.sent} received, loss: ${(result.loss * 100).toFixed(1)}%`);
        }
        
        console.log('\n=== Network Stats ===');
        console.log(JSON.stringify(this.getStats(), null, 2));
        
        console.log('\n=== Device Stats ===');
        for (const device of this.getAll()) {
            console.log(`${device}:`, device.getStats());
        }
        
        console.log('\n=== Router ARP Table ===');
        console.log(JSON.stringify(this.router.getARPTable(), null, 2));
        
        console.log('\n=== Router DHCP Stats ===');
        console.log(JSON.stringify(this.router.getDHCPStats(), null, 2));
        
        console.log('\n=== Client Received Packets ===');
        console.log(JSON.stringify(client.getReceivedPackets().slice(-5), null, 2));
        
        console.log('\n=== Demo Complete ===');
    }

    waitForDHCP(vm, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const checkInterval = setInterval(() => {
                const lease = vm.getDHCPLease();
                if (lease && lease.ip) {
                    clearInterval(checkInterval);
                    clearTimeout(timeoutTimer);
                    resolve(lease);
                }
            }, 100);
            
            const timeoutTimer = setTimeout(() => {
                clearInterval(checkInterval);
                reject(new Error(`DHCP timeout for ${vm.id}`));
            }, timeout);
            
            vm.on('dhcpBound', (lease) => {
                clearInterval(checkInterval);
                clearTimeout(timeoutTimer);
                resolve(lease);
            });
            
            if (vm.dhcpState === 'INIT') {
                vm.startDHCP();
            }
        });
    }

    toJSON() {
        return {
            subnet: IPUtils.toString(this.subnet),
            netmask: IPUtils.toString(this.netmask),
            gatewayIP: IPUtils.toString(this.gatewayIP),
            dnsServer: IPUtils.toString(this.dnsServer),
            dhcpRange: {
                start: IPUtils.toString(this.dhcpStart),
                end: IPUtils.toString(this.dhcpEnd)
            },
            stats: this.getStats(),
            devices: this.getAll().map(d => d.toJSON()),
            macTable: this.getMACTable(),
            ipTable: this.getIPTable()
        };
    }
}