export const DeviceType = {
    VM: 'vm',
    ROUTER: 'router',
    CLIENT: 'client',
    SWITCH: 'switch',
    GENERIC: 'generic'
};

export const DeviceCapability = {
    PACKET_RX: 'packet_rx',
    PACKET_TX: 'packet_tx',
    DHCP_CLIENT: 'dhcp_client',
    DHCP_SERVER: 'dhcp_server',
    ROUTING: 'routing',
    ARP: 'arp',
    ICMP: 'icmp',
    DNS_PROXY: 'dns_proxy',
    NAT: 'nat'
};

export class NetworkDevice {
    constructor(id, type = DeviceType.GENERIC, options = {}) {
        this.id = id;
        this.type = type;
        this.name = options.name || id;
        this.capabilities = new Set(options.capabilities || []);
        this.macAddress = options.macAddress || null;
        this.ipAddresses = new Set(options.ipAddresses || []);
        this.connectedTo = null;
        this.network = null;
        
        this.stats = {
            rxPackets: 0,
            txPackets: 0,
            rxBytes: 0,
            txBytes: 0,
            rxErrors: 0,
            txErrors: 0,
            dropped: 0
        };
        
        this.eventHandlers = new Map();
    }

    addCapability(capability) {
        this.capabilities.add(capability);
        return this;
    }

    hasCapability(capability) {
        return this.capabilities.has(capability);
    }

    removeCapability(capability) {
        this.capabilities.delete(capability);
        return this;
    }

    setMAC(mac) {
        this.macAddress = mac;
        return this;
    }

    addIP(ip) {
        this.ipAddresses.add(ip);
        return this;
    }

    removeIP(ip) {
        this.ipAddresses.delete(ip);
        return this;
    }

    hasIP(ip) {
        return this.ipAddresses.has(ip);
    }

    connectTo(network) {
        this.network = network;
        return this;
    }

    disconnect() {
        this.network = null;
        return this;
    }

    isConnected() {
        return this.network !== null;
    }

    on(event, handler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event).push(handler);
        return this;
    }

    off(event, handler) {
        if (this.eventHandlers.has(event)) {
            const handlers = this.eventHandlers.get(event);
            const idx = handlers.indexOf(handler);
            if (idx >= 0) handlers.splice(idx, 1);
        }
        return this;
    }

    emit(event, ...args) {
        if (this.eventHandlers.has(event)) {
            for (const handler of this.eventHandlers.get(event)) {
                try {
                    handler(...args);
                } catch (e) {
                    console.error(`Device ${this.id} event handler error:`, e);
                }
            }
        }
    }

    receivePacket(frameBuffer, fromDevice = null) {
        this.stats.rxPackets++;
        this.stats.rxBytes += frameBuffer.length;
        this.emit('packet', frameBuffer, fromDevice);
        return this.handlePacket(frameBuffer, fromDevice);
    }

    handlePacket(frameBuffer, fromDevice) {
        return false;
    }

    sendPacket(frameBuffer) {
        if (!this.network) {
            this.stats.txErrors++;
            this.emit('error', new Error('Not connected to network'));
            return false;
        }
        this.stats.txPackets++;
        this.stats.txBytes += frameBuffer.length;
        return this.network.deliverPacket(this, frameBuffer);
    }

    getStats() {
        return { ...this.stats };
    }

    resetStats() {
        this.stats = {
            rxPackets: 0,
            txPackets: 0,
            rxBytes: 0,
            txBytes: 0,
            rxErrors: 0,
            txErrors: 0,
            dropped: 0
        };
    }

    toString() {
        return `${this.type}:${this.id} (${this.name})`;
    }

    toJSON() {
        return {
            id: this.id,
            type: this.type,
            name: this.name,
            macAddress: this.macAddress ? Array.from(this.macAddress) : null,
            ipAddresses: Array.from(this.ipAddresses),
            capabilities: Array.from(this.capabilities),
            connected: this.isConnected(),
            stats: this.getStats()
        };
    }
}

export class DeviceManager {
    constructor() {
        this.devices = new Map();
        this.network = null;
    }

    setNetwork(network) {
        this.network = network;
        return this;
    }

    register(device) {
        if (this.devices.has(device.id)) {
            throw new Error(`Device with id ${device.id} already registered`);
        }
        this.devices.set(device.id, device);
        if (this.network) {
            device.connectTo(this.network);
        }
        this.emit('deviceRegistered', device);
        return device;
    }

    unregister(deviceId) {
        const device = this.devices.get(deviceId);
        if (device) {
            device.disconnect();
            this.devices.delete(deviceId);
            this.emit('deviceUnregistered', device);
            return true;
        }
        return false;
    }

    get(deviceId) {
        return this.devices.get(deviceId);
    }

    getAll() {
        return Array.from(this.devices.values());
    }

    getByType(type) {
        return this.getAll().filter(d => d.type === type);
    }

    getByCapability(capability) {
        return this.getAll().filter(d => d.hasCapability(capability));
    }

    on(event, handler) {
        if (!this.eventHandlers) this.eventHandlers = new Map();
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event).push(handler);
        return this;
    }

    off(event, handler) {
        if (this.eventHandlers && this.eventHandlers.has(event)) {
            const handlers = this.eventHandlers.get(event);
            const idx = handlers.indexOf(handler);
            if (idx >= 0) handlers.splice(idx, 1);
        }
        return this;
    }

    emit(event, ...args) {
        if (this.eventHandlers && this.eventHandlers.has(event)) {
            for (const handler of this.eventHandlers.get(event)) {
                try {
                    handler(...args);
                } catch (e) {
                    console.error(`DeviceManager event handler error:`, e);
                }
            }
        }
    }

    toJSON() {
        return {
            devices: this.getAll().map(d => d.toJSON())
        };
    }
}