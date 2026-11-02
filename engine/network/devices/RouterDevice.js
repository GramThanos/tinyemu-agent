import { NetworkDevice, DeviceType, DeviceCapability } from './NetworkDevice.js';
import { MACUtils } from '../utils/MACUtils.js';
import { IPUtils } from '../utils/IPUtils.js';
import { EthernetFrame, ETH_P_ARP, ETH_P_IP } from '../packets/EthernetFrame.js';
import { ARPPacket } from '../packets/ARPPacket.js';
import { DHCPPacket, DHCP_MSG_DISCOVER, DHCP_MSG_REQUEST, DHCP_MSG_RELEASE, DHCP_MSG_DECLINE, DHCP_MSG_INFORM, DHCP_MSG_OFFER, DHCP_MSG_ACK, DHCP_MSG_NAK, DHCP_OPT_MSG_TYPE, DHCP_OPT_SERVER_ID, DHCP_OPT_SUBNET_MASK, DHCP_OPT_ROUTER, DHCP_OPT_DNS, DHCP_OPT_LEASE_TIME, DHCP_OPT_RENEWAL_TIME, DHCP_OPT_REBIND_TIME, DHCP_OPT_BROADCAST, DHCP_OPT_REQ_ADDR, DHCP_OP_BOOTREQUEST, DHCP_OP_BOOTREPLY, DHCP_FLAG_BROADCAST } from '../packets/DHCPPacket.js';
import { IPPacket, IP_PROTO_UDP, IP_PROTO_ICMP, IP_PROTO_TCP } from '../packets/IPPacket.js';
import { UDPPacket } from '../packets/UDPPacket.js';
import { ICMPPacket } from '../packets/ICMPPacket.js';
import { internetChecksum, udpChecksum } from '../utils/Checksum.js';

export class DHCPServer {
    constructor(router, options = {}) {
        this.router = router;
        this.subnet = options.subnet || IPUtils.parse('10.0.2.0');
        this.netmask = options.netmask || IPUtils.parse('255.255.255.0');
        this.gatewayIP = options.gatewayIP || IPUtils.parse('10.0.2.2');
        this.dnsServer = options.dnsServer || IPUtils.parse('10.0.2.3');
        this.leaseTime = options.leaseTime || 86400;
        this.renewalTime = options.renewalTime || 43200;
        this.rebindTime = options.rebindTime || 75600;
        this.broadcastIP = options.broadcastIP || IPUtils.broadcast(this.subnet, this.netmask);
        
        this.leases = new Map();
        this.allocatedIPs = new Map();
        this.macToIP = new Map();
        this.staticBindings = new Map(); // MAC -> IP for static reservations
        this.availableIPs = []; // Initialize early for static bindings
        
        this.startIP = options.startIP || IPUtils.parse('10.0.2.15');
        this.endIP = options.endIP || IPUtils.parse('10.0.2.100');
        
        // Add static bindings if provided
        if (options.staticBindings) {
            for (const [mac, ip] of Object.entries(options.staticBindings)) {
                this.addStaticBinding(mac, ip);
            }
        }
        
        this.initializePool();
    }

    addStaticBinding(mac, ip) {
        // Handle MAC address - can be string or Uint8Array
        const macBuf = typeof mac === 'string' ? MACUtils.parse(mac) : mac;
        const macStr = MACUtils.toString(macBuf);
        const ipObj = typeof ip === 'string' ? IPUtils.parse(ip) : ip;
        const ipStr = IPUtils.toString(ipObj);
        
        // Remove from pool if present
        this.availableIPs = this.availableIPs.filter(
            poolIP => IPUtils.toString(poolIP) !== ipStr
        );
        
        this.staticBindings.set(macStr, ipObj);
        this.macToIP.set(macStr, ipObj);
        this.allocatedIPs.set(ipStr, macStr);
        
        return this;
    }

    removeStaticBinding(mac) {
        // Handle MAC address - can be string or Uint8Array
        const macBuf = typeof mac === 'string' ? MACUtils.parse(mac) : mac;
        const macStr = MACUtils.toString(macBuf);
        const ipObj = this.staticBindings.get(macStr);
        
        if (ipObj) {
            const ipStr = IPUtils.toString(ipObj);
            this.staticBindings.delete(macStr);
            this.macToIP.delete(macStr);
            this.allocatedIPs.delete(ipStr);
            
            // Add back to pool if in range
            const ipNum = IPUtils.toNumber(ipObj);
            const startNum = IPUtils.toNumber(this.startIP);
            const endNum = IPUtils.toNumber(this.endIP);
            if (ipNum >= startNum && ipNum <= endNum) {
                this.availableIPs.push(ipObj);
                this.availableIPs.sort((a, b) => IPUtils.toNumber(a) - IPUtils.toNumber(b));
            }
        }
        
        return this;
    }

    getStaticBinding(mac) {
        const macStr = MACUtils.toString(mac);
        return this.staticBindings.get(macStr) || null;
    }

    getAllStaticBindings() {
        const bindings = {};
        for (const [mac, ip] of this.staticBindings) {
            bindings[mac] = IPUtils.toString(ip);
        }
        return bindings;
    }

    initializePool() {
        this.availableIPs = [];
        const startNum = IPUtils.toNumber(this.startIP);
        const endNum = IPUtils.toNumber(this.endIP);
        
        for (let num = startNum; num <= endNum; num++) {
            const ip = IPUtils.numberToIP(num);
            const ipStr = IPUtils.toString(ip);
            
            // Skip if statically assigned
            if (!this.allocatedIPs.has(ipStr)) {
                this.availableIPs.push(ip);
            }
        }
    }

    allocateIP(mac) {
        const macStr = MACUtils.toString(mac);
        
        if (this.macToIP.has(macStr)) {
            const existingIP = this.macToIP.get(macStr);
            const ipStr = IPUtils.toString(existingIP);
            
            // If static binding, always return it
            if (this.staticBindings.has(macStr)) {
                return existingIP;
            }
            
            // For dynamic leases, only return if IP is still allocated to this MAC
            if (this.allocatedIPs.get(ipStr) === macStr) {
                return existingIP;
            }
        }
        
        for (let i = 0; i < this.availableIPs.length; i++) {
            const ip = this.availableIPs[i];
            const ipStr = IPUtils.toString(ip);
            
            if (!this.allocatedIPs.has(ipStr)) {
                this.allocatedIPs.set(ipStr, macStr);
                this.macToIP.set(macStr, ip);
                this.availableIPs.splice(i, 1);
                return ip;
            }
        }
        
        return null;
    }

    releaseIP(mac) {
        const macStr = MACUtils.toString(mac);
        const ip = this.macToIP.get(macStr);
        
        if (ip) {
            const ipStr = IPUtils.toString(ip);
            this.allocatedIPs.delete(ipStr);
            this.macToIP.delete(macStr);
            this.availableIPs.push(ip);
            this.availableIPs.sort((a, b) => IPUtils.toNumber(a) - IPUtils.toNumber(b));
        }
    }

    getLease(mac) {
        const macStr = MACUtils.toString(mac);
        return this.leases.get(macStr) || null;
    }

    createLease(mac, ip) {
        const macStr = MACUtils.toString(mac);
        const lease = {
            mac: new Uint8Array(mac),
            ip: new Uint8Array(ip),
            subnetMask: new Uint8Array(this.netmask),
            router: new Uint8Array(this.gatewayIP),
            dns: new Uint8Array(this.dnsServer),
            leaseTime: this.leaseTime,
            renewalTime: this.renewalTime,
            rebindTime: this.rebindTime,
            serverID: new Uint8Array(this.gatewayIP),
            obtainedAt: Date.now(),
            expiresAt: Date.now() + this.leaseTime * 1000
        };
        
        this.leases.set(macStr, lease);
        return lease;
    }

    handleDHCP(dhcp, fromMAC) {
        const msgType = dhcp.getMessageType();
        
        switch (msgType) {
            case DHCP_MSG_DISCOVER:
                return this.handleDiscover(dhcp, fromMAC);
            case DHCP_MSG_REQUEST:
                return this.handleRequest(dhcp, fromMAC);
            case DHCP_MSG_RELEASE:
                return this.handleRelease(dhcp, fromMAC);
            case DHCP_MSG_DECLINE:
                return this.handleDecline(dhcp, fromMAC);
            case DHCP_MSG_INFORM:
                return this.handleInform(dhcp, fromMAC);
            default:
                return null;
        }
    }

    handleDiscover(dhcp, fromMAC) {
        const requestedIP = dhcp.getOptionIP(DHCP_OPT_REQ_ADDR);
        let allocatedIP = null;
        
        if (requestedIP) {
            const reqIPStr = IPUtils.toString(requestedIP);
            if (!this.allocatedIPs.has(reqIPStr) || this.allocatedIPs.get(reqIPStr) === MACUtils.toString(fromMAC)) {
                allocatedIP = requestedIP;
            }
        }
        
        if (!allocatedIP) {
            allocatedIP = this.allocateIP(fromMAC);
        }
        
        if (!allocatedIP) {
            return null;
        }
        
        const lease = this.createLease(fromMAC, allocatedIP);
        
        return DHCPPacket.buildReply(dhcp, DHCP_MSG_OFFER,
            this.gatewayIP, allocatedIP, {
                subnetMask: this.netmask,
                router: this.gatewayIP,
                dns: this.dnsServer,
                leaseTime: this.leaseTime,
                renewalTime: this.renewalTime,
                rebindTime: this.rebindTime,
                broadcast: this.broadcastIP
            });
    }

    handleRequest(dhcp, fromMAC) {
        const requestedIP = dhcp.getOptionIP(DHCP_OPT_REQ_ADDR);
        const serverID = dhcp.getOptionIP(DHCP_OPT_SERVER_ID);
        
        if (!requestedIP) {
            return DHCPPacket.buildReply(dhcp, DHCP_MSG_NAK,
                this.gatewayIP, IPUtils.parse('0.0.0.0'), {
                    subnetMask: this.netmask,
                    router: this.gatewayIP
                });
        }
        
        const reqIPStr = IPUtils.toString(requestedIP);
        const macStr = MACUtils.toString(fromMAC);
        
        if (serverID && !IPUtils.equals(serverID, this.gatewayIP)) {
            return null;
        }
        
        if (!this.allocatedIPs.has(reqIPStr)) {
            this.allocatedIPs.set(reqIPStr, macStr);
            this.macToIP.set(macStr, requestedIP);
            this.availableIPs = this.availableIPs.filter(ip => !IPUtils.equals(ip, requestedIP));
        } else if (this.allocatedIPs.get(reqIPStr) !== macStr) {
            return DHCPPacket.buildReply(dhcp, DHCP_MSG_NAK,
                this.gatewayIP, IPUtils.parse('0.0.0.0'), {
                    subnetMask: this.netmask,
                    router: this.gatewayIP
                });
        }
        
        const lease = this.createLease(fromMAC, requestedIP);
        
        return DHCPPacket.buildReply(dhcp, DHCP_MSG_ACK,
            this.gatewayIP, requestedIP, {
                subnetMask: this.netmask,
                router: this.gatewayIP,
                dns: this.dnsServer,
                leaseTime: this.leaseTime,
                renewalTime: this.renewalTime,
                rebindTime: this.rebindTime,
                broadcast: this.broadcastIP
            });
    }

    handleRelease(dhcp, fromMAC) {
        this.releaseIP(fromMAC);
        return null;
    }

    handleDecline(dhcp, fromMAC) {
        const requestedIP = dhcp.getOptionIP(DHCP_OPT_REQ_ADDR);
        if (requestedIP) {
            this.releaseIP(fromMAC);
        }
        return null;
    }

    handleInform(dhcp, fromMAC) {
        return DHCPPacket.buildReply(dhcp, DHCP_MSG_ACK,
            this.gatewayIP, dhcp.ciaddr, {
                subnetMask: this.netmask,
                router: this.gatewayIP,
                dns: this.dnsServer,
                leaseTime: this.leaseTime,
                renewalTime: this.renewalTime,
                rebindTime: this.rebindTime,
                broadcast: this.broadcastIP
            });
    }

    getStats() {
        return {
            totalPool: this.availableIPs.length + this.allocatedIPs.size,
            available: this.availableIPs.length,
            allocated: this.allocatedIPs.size,
            leases: this.leases.size
        };
    }
}

export class RouterDevice extends NetworkDevice {
    constructor(id, options = {}) {
        const mac = options.macAddress || MACUtils.generate(`router-${id}`);
        
        super(id, DeviceType.ROUTER, {
            name: options.name || `Router-${id}`,
            macAddress: mac,
            capabilities: [
                DeviceCapability.PACKET_RX,
                DeviceCapability.PACKET_TX,
                DeviceCapability.ROUTING,
                DeviceCapability.DHCP_SERVER,
                DeviceCapability.ARP,
                DeviceCapability.ICMP
            ],
            ...options
        });

        this.subnet = options.subnet || IPUtils.parse('10.0.2.0');
        this.netmask = options.netmask || IPUtils.parse('255.255.255.0');
        this.gatewayIP = options.gatewayIP || IPUtils.parse('10.0.2.2');
        this.dnsServer = options.dnsServer || IPUtils.parse('10.0.2.3');
        this.broadcastIP = IPUtils.broadcast(this.subnet, this.netmask);
        
        this.addIP(IPUtils.toString(this.gatewayIP));
        
        this.dhcpServer = new DHCPServer(this, {
            subnet: this.subnet,
            netmask: this.netmask,
            gatewayIP: this.gatewayIP,
            dnsServer: this.dnsServer,
            leaseTime: options.leaseTime,
            startIP: options.dhcpStartIP,
            endIP: options.dhcpEndIP,
            staticBindings: options.staticBindings
        });
        
        this.arpTable = new Map();
        this.routingTable = [];
        this.connectedDevices = new Map();
        
        this.icmpIdCounter = 0;
        this.pendingICMP = new Map();
    }

    addConnectedDevice(device) {
        this.connectedDevices.set(device.id, device);
        return this;
    }

    removeConnectedDevice(deviceId) {
        this.connectedDevices.delete(deviceId);
        return this;
    }

    getConnectedDevices() {
        return Array.from(this.connectedDevices.values());
    }

    handlePacket(frameBuffer, fromDevice) {
        try {
            const frame = new EthernetFrame(frameBuffer);
            
            if (!this.isPacketForMe(frame)) {
                return this.forwardPacket(frame, fromDevice);
            }
            
            if (frame.isARP()) {
                return this.handleARP(frame, fromDevice);
            }
            
            if (frame.isIPv4()) {
                return this.handleIPv4(frame, fromDevice);
            }
            
            return false;
        } catch (e) {
            this.stats.rxErrors++;
            console.error(`RouterDevice ${this.id} packet handling error:`, e);
            return false;
        }
    }

    isPacketForMe(frame) {
        if (frame.isBroadcast() || frame.isMulticast()) {
            return true;
        }
        return MACUtils.equals(frame.dstMAC, this.macAddress);
    }

    forwardPacket(frame, fromDevice) {
        if (frame.isIPv4()) {
            const ip = new IPPacket(frame.payload);
            const dstIPStr = IPUtils.toString(ip.dstIP);
            
            if (this.isLocalIP(ip.dstIP)) {
                const targetDevice = this.findDeviceByIP(dstIPStr);
                if (targetDevice && targetDevice !== fromDevice) {
                    return targetDevice.receivePacket(frame.serialize(), this);
                }
            }
        }
        
        return false;
    }

    isLocalIP(ip) {
        return IPUtils.inSubnet(ip, this.subnet, this.netmask);
    }

    findDeviceByIP(ipStr) {
        for (const device of this.connectedDevices.values()) {
            if (device.hasIP(ipStr)) {
                return device;
            }
        }
        return null;
    }

    handleARP(frame, fromDevice) {
        const arp = new ARPPacket(frame.payload);
        
        if (arp.isRequest()) {
            const targetIPStr = IPUtils.toString(arp.targetIP);
            
            if (this.hasIP(targetIPStr) || targetIPStr === '0.0.0.0') {
                this.sendARPReply(arp.senderMAC, arp.targetIP, fromDevice);
            } else {
                const targetDevice = this.findDeviceByIP(targetIPStr);
                if (targetDevice) {
                    targetDevice.receivePacket(frame.serialize(), this);
                }
            }
        } else if (arp.isReply()) {
            const senderIPStr = IPUtils.toString(arp.senderIP);
            this.arpTable.set(senderIPStr, {
                mac: new Uint8Array(arp.senderMAC),
                expiry: Date.now() + 300000,
                deviceId: fromDevice?.id || null
            });
        }
        return true;
    }

    handleIPv4(frame, fromDevice) {
        const ip = new IPPacket(frame.payload);
        
        if (ip.protocol === IP_PROTO_UDP) {
            return this.handleUDP(frame, ip, fromDevice);
        } else if (ip.protocol === IP_PROTO_ICMP) {
            return this.handleICMP(frame, ip, fromDevice);
        }
        
        return false;
    }

    handleUDP(frame, ip, fromDevice) {
        const udp = new UDPPacket(ip.payload);
        
        if (udp.dstPort === 67 || udp.dstPort === 68) {
            return this.handleDHCP(frame, ip, udp, fromDevice);
        }
        
        return false;
    }

    handleDHCP(frame, ip, udp, fromDevice) {
        const dhcp = new DHCPPacket(udp.payload);
        const fromMAC = fromDevice?.macAddress || dhcp.getClientMAC();
        
        const reply = this.dhcpServer.handleDHCP(dhcp, fromMAC);
        
        if (reply) {
            this.sendDHCPReply(reply, fromDevice, dhcp);
        }
        
        return true;
    }

    sendDHCPReply(dhcpReply, targetDevice, originalDHCP) {
        // On a committed lease (ACK) record the assigned IP onto the target
        // device and the network's IP→device table, so router L3 forwarding
        // (findDeviceByIP) and getIPTable() know a bridged guest's address.
        // Guests get their IP from the JS DHCP server but never told JS about it
        // otherwise, leaving VMBridgeDevice.ipAddresses empty.
        if (targetDevice && dhcpReply.getMessageType &&
            dhcpReply.getMessageType() === DHCP_MSG_ACK) {
            const ipNum = IPUtils.toNumber(dhcpReply.yiaddr);
            if (ipNum !== 0 && ipNum !== 0xffffffff) {
                const ipStr = IPUtils.toString(dhcpReply.yiaddr);
                targetDevice.addIP(ipStr);
                if (this.network) this.network.ipToDevice.set(ipStr, targetDevice.id);
            }
        }

        const dhcpBuf = dhcpReply.serialize();
        const udp = UDPPacket.build(67, 68, dhcpBuf);
        
        const srcIP = this.gatewayIP;
        let dstIP = dhcpReply.yiaddr;
        
        if (IPUtils.toNumber(dstIP) === 0) {
            dstIP = originalDHCP.ciaddr;
            if (IPUtils.toNumber(dstIP) === 0) {
                dstIP = IPUtils.parse('255.255.255.255');
            }
        }
        
        const udpBuf = udp.serialize(srcIP, dstIP);
        
        const replyIP = IPPacket.build(
            srcIP,
            dstIP,
            IP_PROTO_UDP,
            udpBuf
        );
        replyIP.ttl = 64;
        const ipBuf = replyIP.serialize();
        
        let dstMAC;
        if (targetDevice && targetDevice.macAddress) {
            dstMAC = targetDevice.macAddress;
        } else {
            dstMAC = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        }
        
        const eth = EthernetFrame.build(
            dstMAC,
            this.macAddress,
            ETH_P_IP,
            ipBuf
        );
        
        if (targetDevice) {
            targetDevice.receivePacket(eth.serialize(), this);
        } else {
            this.broadcast(eth.serialize());
        }
    }

    handleICMP(frame, ip, fromDevice) {
        const icmp = new ICMPPacket(ip.payload);
        
        if (icmp.isEchoRequest()) {
            this.sendICMPEchoReply(frame, ip, icmp, fromDevice);
        } else if (icmp.isEchoReply()) {
            const key = `${icmp.getIdentifier()}:${icmp.getSequenceNumber()}`;
            const pending = this.pendingICMP.get(key);
            if (pending) {
                pending.resolve({ time: Date.now() - pending.sentAt, ttl: ip.ttl });
                this.pendingICMP.delete(key);
            }
        }
        return true;
    }

    sendICMPEchoReply(originalFrame, originalIP, originalICMP, fromDevice) {
        const replyICMP = originalICMP.createEchoReply();
        const replyICMPBuf = replyICMP.serialize();
        
        const replyIP = IPPacket.build(
            originalIP.dstIP,
            originalIP.srcIP,
            IP_PROTO_ICMP,
            replyICMPBuf
        );
        replyIP.ttl = 64;
        const replyIPBuf = replyIP.serialize();
        
        const replyEth = EthernetFrame.build(
            originalFrame.srcMAC,
            this.macAddress,
            ETH_P_IP,
            replyIPBuf
        );
        
        if (fromDevice) {
            fromDevice.receivePacket(replyEth.serialize(), this);
        }
    }

    sendARPReply(targetMAC, senderIP, targetDevice) {
        const arp = ARPPacket.buildReply(this.macAddress, senderIP, targetMAC, senderIP);
        const arpBuf = arp.serialize();
        
        const eth = EthernetFrame.build(
            targetMAC,
            this.macAddress,
            ETH_P_ARP,
            arpBuf
        );
        
        if (targetDevice) {
            targetDevice.receivePacket(eth.serialize(), this);
        }
    }

    ping(targetIP, count = 4, interval = 1000) {
        return new Promise((resolve) => {
            const results = [];
            let sent = 0;
            let received = 0;
            
            const sendPing = () => {
                if (sent >= count) {
                    if (this.pingInterval) clearInterval(this.pingInterval);
                    resolve({ sent, received, results, loss: (sent - received) / sent });
                    return;
                }
                
                const identifier = ++this.icmpIdCounter & 0xffff;
                const sequence = sent + 1;
                const key = `${identifier}:${sequence}`;
                
                const icmp = ICMPPacket.buildEchoRequest(identifier, sequence, new Uint8Array(32));
                const icmpBuf = icmp.serialize();
                
                const ip = IPPacket.build(
                    this.gatewayIP,
                    IPUtils.parse(targetIP),
                    IP_PROTO_ICMP,
                    icmpBuf
                );
                ip.ttl = 64;
                const ipBuf = ip.serialize();
                
                this.resolveMAC(targetIP).then(dstMAC => {
                    const eth = EthernetFrame.build(
                        dstMAC,
                        this.macAddress,
                        ETH_P_IP,
                        ipBuf
                    );
                    
                    this.pendingICMP.set(key, {
                        sentAt: Date.now(),
                        resolve: null
                    });
                    
                    const promise = new Promise((res) => {
                        this.pendingICMP.get(key).resolve = res;
                    });
                    
                    this.sendPacket(eth.serialize());
                    sent++;
                    
                    promise.then(result => {
                        received++;
                        results.push({ seq: sequence, ...result, success: true });
                    }).catch(() => {
                        results.push({ seq: sequence, success: false });
                    });
                }).catch(() => {
                    results.push({ seq: sequence, success: false });
                });
            };
            
            this.pingInterval = setInterval(sendPing, interval);
            sendPing();
            
            setTimeout(() => {
                if (this.pingInterval) clearInterval(this.pingInterval);
                for (const [, pending] of this.pendingICMP) {
                    if (pending.resolve) pending.resolve({ success: false, timeout: true });
                }
                this.pendingICMP.clear();
                resolve({ sent, received, results, loss: sent > 0 ? (sent - received) / sent : 0 });
            }, count * interval + 5000);
        });
    }

    resolveMAC(targetIP) {
        return new Promise((resolve, reject) => {
            const ipStr = typeof targetIP === 'string' ? targetIP : IPUtils.toString(targetIP);
            
            if (this.arpTable.has(ipStr)) {
                const entry = this.arpTable.get(ipStr);
                if (entry.expiry > Date.now()) {
                    resolve(entry.mac);
                    return;
                }
            }
            
            const arp = ARPPacket.buildRequest(this.macAddress, this.gatewayIP, IPUtils.parse(ipStr));
            const arpBuf = arp.serialize();
            
            const eth = EthernetFrame.build(
                new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
                this.macAddress,
                ETH_P_ARP,
                arpBuf
            );
            
            this.broadcast(eth.serialize());
            
            const checkInterval = setInterval(() => {
                if (this.arpTable.has(ipStr)) {
                    const entry = this.arpTable.get(ipStr);
                    if (entry.expiry > Date.now()) {
                        clearInterval(checkInterval);
                        resolve(entry.mac);
                    }
                }
            }, 100);
            
            setTimeout(() => {
                clearInterval(checkInterval);
                if (!this.arpTable.has(ipStr) || this.arpTable.get(ipStr).expiry <= Date.now()) {
                    reject(new Error(`ARP timeout for ${ipStr}`));
                }
            }, 3000);
        });
    }

    broadcast(frameBuffer) {
        for (const device of this.connectedDevices.values()) {
            if (device !== this) {
                device.receivePacket(frameBuffer, this);
            }
        }
    }

    getDHCPStats() {
        return this.dhcpServer.getStats();
    }

    getARPTable() {
        const table = {};
        for (const [ip, entry] of this.arpTable) {
            table[ip] = {
                mac: MACUtils.toString(entry.mac),
                expiresIn: entry.expiry - Date.now(),
                deviceId: entry.deviceId
            };
        }
        return table;
    }

    getRoutingTable() {
        return this.routingTable.map(r => ({
            destination: IPUtils.toString(r.destination),
            netmask: IPUtils.toString(r.netmask),
            gateway: IPUtils.toString(r.gateway),
            interface: r.interface
        }));
    }

    toJSON() {
        return {
            ...super.toJSON(),
            subnet: IPUtils.toString(this.subnet),
            netmask: IPUtils.toString(this.netmask),
            gatewayIP: IPUtils.toString(this.gatewayIP),
            dnsServer: IPUtils.toString(this.dnsServer),
            dhcpStats: this.getDHCPStats(),
            connectedDevices: this.getConnectedDevices().map(d => d.id),
            arpTable: this.getARPTable()
        };
    }
}