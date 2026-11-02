import { NetworkDevice, DeviceType, DeviceCapability } from './NetworkDevice.js';
import { MACUtils } from '../utils/MACUtils.js';
import { IPUtils } from '../utils/IPUtils.js';
import { EthernetFrame, ETH_P_ARP, ETH_P_IP } from '../packets/EthernetFrame.js';
import { ARPPacket } from '../packets/ARPPacket.js';
import { IPPacket, IP_PROTO_UDP, IP_PROTO_ICMP, IP_PROTO_TCP } from '../packets/IPPacket.js';
import { ICMPPacket } from '../packets/ICMPPacket.js';
import { UDPPacket } from '../packets/UDPPacket.js';

export class DummyClientDevice extends NetworkDevice {
    constructor(id, options = {}) {
        const mac = options.macAddress || MACUtils.generate(`client-${id}`);
        
        super(id, DeviceType.CLIENT, {
            name: options.name || `Client-${id}`,
            macAddress: mac,
            capabilities: [
                DeviceCapability.PACKET_RX,
                DeviceCapability.PACKET_TX,
                DeviceCapability.ARP,
                DeviceCapability.ICMP
            ],
            ...options
        });

        this.ipAddress = options.ipAddress || null;
        if (this.ipAddress) {
            this.addIP(this.ipAddress);
        }
        
        this.gatewayIP = options.gatewayIP || null;
        this.arpCache = new Map();
        this.pendingARP = new Map();
        
        this.icmpIdCounter = 0;
        this.pendingICMP = new Map();
        
        this.autoReplyPing = options.autoReplyPing !== false;
        this.autoReplyARP = options.autoReplyARP !== false;
        
        this.receivedPackets = [];
        this.maxReceivedPackets = options.maxReceivedPackets || 100;
        
        this.onPacketReceived = null;
    }

    setPacketHandler(handler) {
        this.onPacketReceived = handler;
        return this;
    }

    handlePacket(frameBuffer, fromDevice) {
        try {
            const frame = new EthernetFrame(frameBuffer);
            
            if (!this.isPacketForMe(frame)) {
                return false;
            }
            
            this.recordPacket(frame, fromDevice);
            
            if (frame.isARP()) {
                return this.handleARP(frame, fromDevice);
            }
            
            if (frame.isIPv4()) {
                return this.handleIPv4(frame, fromDevice);
            }
            
            return false;
        } catch (e) {
            this.stats.rxErrors++;
            console.error(`DummyClient ${this.id} packet handling error:`, e);
            return false;
        }
    }

    isPacketForMe(frame) {
        if (frame.isBroadcast() || frame.isMulticast()) {
            return true;
        }
        return MACUtils.equals(frame.dstMAC, this.macAddress);
    }

    recordPacket(frame, fromDevice) {
        this.receivedPackets.push({
            timestamp: Date.now(),
            fromDevice: fromDevice?.id || 'unknown',
            frameType: frame.isARP() ? 'ARP' : frame.isIPv4() ? 'IPv4' : `0x${frame.ethertype.toString(16)}`,
            srcMAC: MACUtils.toString(frame.srcMAC),
            dstMAC: MACUtils.toString(frame.dstMAC),
            length: frame.payload?.length || 0
        });
        
        if (this.receivedPackets.length > this.maxReceivedPackets) {
            this.receivedPackets.shift();
        }
        
        if (this.onPacketReceived) {
            this.onPacketReceived(frame, fromDevice);
        }
    }

    handleARP(frame, fromDevice) {
        const arp = new ARPPacket(frame.payload);
        
        if (arp.isRequest()) {
            const targetIPStr = IPUtils.toString(arp.targetIP);
            if (this.ipAddress && targetIPStr === this.ipAddress) {
                if (this.autoReplyARP) {
                    this.sendARPReply(arp.senderMAC, arp.targetIP, fromDevice);
                }
            }
        } else if (arp.isReply()) {
            const senderIPStr = IPUtils.toString(arp.senderIP);
            this.arpCache.set(senderIPStr, {
                mac: new Uint8Array(arp.senderMAC),
                expiry: Date.now() + 300000
            });
            
            const pending = this.pendingARP.get(senderIPStr);
            if (pending) {
                for (const cb of pending.callbacks) {
                    cb(new Uint8Array(arp.senderMAC));
                }
                this.pendingARP.delete(senderIPStr);
            }
        }
        return true;
    }

    handleIPv4(frame, fromDevice) {
        const ip = new IPPacket(frame.payload);
        
        if (ip.protocol === IP_PROTO_ICMP) {
            return this.handleICMP(frame, ip, fromDevice);
        } else if (ip.protocol === IP_PROTO_UDP) {
            return this.handleUDP(frame, ip, fromDevice);
        }
        
        return false;
    }

    handleICMP(frame, ip, fromDevice) {
        const icmp = new ICMPPacket(ip.payload);
        
        if (icmp.isEchoRequest()) {
            if (this.autoReplyPing) {
                this.sendICMPEchoReply(frame, ip, icmp, fromDevice);
            }
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

    handleUDP(frame, ip, fromDevice) {
        const udp = new UDPPacket(ip.payload);
        
        return true;
    }

    sendARPReply(targetMAC, senderIP, targetDevice) {
        if (!this.ipAddress) return;
        
        const arp = ARPPacket.buildReply(this.macAddress, IPUtils.parse(this.ipAddress), targetMAC, senderIP);
        const arpBuf = arp.serialize();
        
        const eth = EthernetFrame.build(
            targetMAC,
            this.macAddress,
            ETH_P_ARP,
            arpBuf
        );
        
        if (targetDevice) {
            targetDevice.receivePacket(eth.serialize(), this);
        } else {
            this.sendPacket(eth.serialize());
        }
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
        } else {
            this.sendPacket(replyEth.serialize());
        }
    }

    ping(targetIP, count = 4, interval = 1000) {
        if (!this.ipAddress) {
            return Promise.reject(new Error('No IP address configured'));
        }
        
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
                    IPUtils.parse(this.ipAddress),
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
            
            if (this.arpCache.has(ipStr)) {
                const entry = this.arpCache.get(ipStr);
                if (entry.expiry > Date.now()) {
                    resolve(entry.mac);
                    return;
                }
            }
            
            if (!this.gatewayIP && !this.ipAddress) {
                reject(new Error('No gateway or IP configured'));
                return;
            }
            
            if (this.pendingARP.has(ipStr)) {
                this.pendingARP.get(ipStr).callbacks.push(resolve);
                return;
            }
            
            this.pendingARP.set(ipStr, { callbacks: [resolve] });
            
            const senderIP = this.ipAddress ? IPUtils.parse(this.ipAddress) : IPUtils.parse('0.0.0.0');
            
            const arp = ARPPacket.buildRequest(this.macAddress, senderIP, IPUtils.parse(ipStr));
            const arpBuf = arp.serialize();
            
            const eth = EthernetFrame.build(
                new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
                this.macAddress,
                ETH_P_ARP,
                arpBuf
            );
            
            this.sendPacket(eth.serialize());
            
            setTimeout(() => {
                if (this.pendingARP.has(ipStr)) {
                    this.pendingARP.delete(ipStr);
                    reject(new Error(`ARP timeout for ${ipStr}`));
                }
            }, 3000);
        });
    }

    setIPAddress(ip, gatewayIP = null) {
        if (this.ipAddress) {
            this.removeIP(this.ipAddress);
        }
        this.ipAddress = ip;
        this.addIP(ip);
        if (gatewayIP) {
            this.gatewayIP = gatewayIP;
        }
    }

    getReceivedPackets() {
        return [...this.receivedPackets];
    }

    clearReceivedPackets() {
        this.receivedPackets = [];
    }

    getARPCache() {
        const cache = {};
        for (const [ip, entry] of this.arpCache) {
            cache[ip] = {
                mac: MACUtils.toString(entry.mac),
                expiresIn: entry.expiry - Date.now()
            };
        }
        return cache;
    }

    toJSON() {
        return {
            ...super.toJSON(),
            ipAddress: this.ipAddress,
            gatewayIP: this.gatewayIP,
            autoReplyPing: this.autoReplyPing,
            autoReplyARP: this.autoReplyARP,
            receivedCount: this.receivedPackets.length,
            arpCache: this.getARPCache()
        };
    }
}