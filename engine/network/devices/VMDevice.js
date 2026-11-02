import { NetworkDevice, DeviceType, DeviceCapability } from './NetworkDevice.js';
import { MACUtils } from '../utils/MACUtils.js';
import { IPUtils } from '../utils/IPUtils.js';
import { EthernetFrame, ETH_P_ARP, ETH_P_IP } from '../packets/EthernetFrame.js';
import { ARPPacket } from '../packets/ARPPacket.js';
import { DHCPPacket, DHCP_MSG_DISCOVER, DHCP_MSG_OFFER, DHCP_MSG_REQUEST, DHCP_MSG_ACK, DHCP_MSG_NAK, DHCP_MSG_RELEASE, DHCP_OPT_MSG_TYPE, DHCP_OPT_CLIENT_ID, DHCP_OPT_PARAM_REQUEST, DHCP_OPT_SUBNET_MASK, DHCP_OPT_ROUTER, DHCP_OPT_DNS, DHCP_OPT_DOMAIN, DHCP_OPT_BROADCAST, DHCP_OPT_LEASE_TIME, DHCP_OPT_RENEWAL_TIME, DHCP_OPT_REBIND_TIME, DHCP_OPT_REQ_ADDR, DHCP_OPT_SERVER_ID, DHCP_OP_BOOTREQUEST, DHCP_FLAG_BROADCAST } from '../packets/DHCPPacket.js';
import { IPPacket, IP_PROTO_UDP, IP_PROTO_ICMP, IP_PROTO_TCP } from '../packets/IPPacket.js';
import { UDPPacket } from '../packets/UDPPacket.js';
import { ICMPPacket } from '../packets/ICMPPacket.js';

export class VMDevice extends NetworkDevice {
    constructor(id, options = {}) {
        const mac = options.macAddress || MACUtils.generate(id);
        
        super(id, DeviceType.VM, {
            name: options.name || `VM-${id}`,
            macAddress: mac,
            capabilities: [
                DeviceCapability.PACKET_RX,
                DeviceCapability.PACKET_TX,
                DeviceCapability.DHCP_CLIENT,
                DeviceCapability.ARP,
                DeviceCapability.ICMP
            ],
            ...options
        });

        this.dhcpState = 'INIT';
        this.dhcpXid = Math.floor(Math.random() * 0x100000000);
        this.dhcpLease = null;
        this.dhcpServerID = null;
        this.dhcpRetryCount = 0;
        this.dhcpMaxRetries = 5;
        this.dhcpRetryInterval = 1000;
        this.dhcpTimer = null;
        
        this.arpCache = new Map();
        this.pendingARP = new Map();
        
        this.icmpIdCounter = 0;
        this.pendingICMP = new Map();
        
        this.onPacketHandler = null;
        
        this.gatewayIP = options.gatewayIP || null;
        this.dnsServers = options.dnsServers || [];
        
        this.autoDHCP = options.autoDHCP !== false;
        this.autoARP = options.autoARP !== false;
        this.autoICMP = options.autoICMP !== false;
    }

    setPacketHandler(handler) {
        this.onPacketHandler = handler;
        return this;
    }

    handlePacket(frameBuffer, fromDevice) {
        try {
            const frame = new EthernetFrame(frameBuffer);
            
            if (!this.isPacketForMe(frame)) {
                return false;
            }
            
            if (frame.isARP()) {
                return this.handleARP(frame);
            }
            
            if (frame.isIPv4()) {
                return this.handleIPv4(frame);
            }
            
            return false;
        } catch (e) {
            this.stats.rxErrors++;
            console.error(`VMDevice ${this.id} packet handling error:`, e);
            return false;
        }
    }

    isPacketForMe(frame) {
        if (frame.isBroadcast() || frame.isMulticast()) {
            return true;
        }
        return MACUtils.equals(frame.dstMAC, this.macAddress);
    }

    handleARP(frame) {
        const arp = new ARPPacket(frame.payload);
        
        if (arp.isRequest()) {
            const targetIP = IPUtils.toString(arp.targetIP);
            if (this.hasIP(targetIP) || targetIP === '0.0.0.0') {
                this.sendARPReply(arp.senderMAC, arp.targetIP);
            }
        } else if (arp.isReply()) {
            const senderIP = IPUtils.toString(arp.senderIP);
            this.arpCache.set(senderIP, {
                mac: new Uint8Array(arp.senderMAC),
                expiry: Date.now() + 300000
            });
            
            const pending = this.pendingARP.get(senderIP);
            if (pending) {
                for (const cb of pending.callbacks) {
                    cb(new Uint8Array(arp.senderMAC));
                }
                this.pendingARP.delete(senderIP);
            }
        }
        return true;
    }

    sendARPReply(targetMAC, senderIP) {
        const arp = ARPPacket.buildReply(this.macAddress, senderIP, targetMAC, senderIP);
        const arpBuf = arp.serialize();
        
        const eth = EthernetFrame.build(
            targetMAC,
            this.macAddress,
            ETH_P_ARP,
            arpBuf
        );
        
        this.sendPacket(eth.serialize());
    }

    handleIPv4(frame) {
        const ip = new IPPacket(frame.payload);
        
        if (ip.protocol === IP_PROTO_UDP) {
            return this.handleUDP(frame, ip);
        } else if (ip.protocol === IP_PROTO_ICMP) {
            return this.handleICMP(frame, ip);
        }
        return false;
    }

    handleUDP(frame, ip) {
        const udp = new UDPPacket(ip.payload);
        
        if (udp.dstPort === 67 || udp.dstPort === 68) {
            return this.handleDHCP(frame, ip, udp);
        }
        
        return false;
    }

    handleDHCP(frame, ip, udp) {
        const dhcp = new DHCPPacket(udp.payload);
        
        if (dhcp.getMessageType() === DHCP_MSG_OFFER) {
            this.handleDHCPOffer(dhcp);
        } else if (dhcp.getMessageType() === DHCP_MSG_ACK) {
            this.handleDHCPAck(dhcp);
        } else if (dhcp.getMessageType() === DHCP_MSG_NAK) {
            this.handleDHCPNak(dhcp);
        }
        return true;
    }

    handleDHCPOffer(dhcp) {
        if (this.dhcpState !== 'SELECTING') return;
        
        const offeredIP = IPUtils.toString(dhcp.yiaddr);
        const serverID = dhcp.getOptionIP(DHCP_OPT_SERVER_ID);
        
        this.dhcpLease = {
            ip: offeredIP,
            subnetMask: IPUtils.toString(dhcp.getOptionIP(DHCP_OPT_SUBNET_MASK) || IPUtils.parse('255.255.255.0')),
            router: IPUtils.toString(dhcp.getOptionIP(DHCP_OPT_ROUTER) || IPUtils.parse('0.0.0.0')),
            dns: dhcp.getOptionIP(DHCP_OPT_DNS) ? IPUtils.toString(dhcp.getOptionIP(DHCP_OPT_DNS)) : null,
            leaseTime: dhcp.getOptionUInt32(DHCP_OPT_LEASE_TIME) || 86400,
            serverID: serverID ? IPUtils.toString(serverID) : null
        };
        
        this.dhcpServerID = this.dhcpLease.serverID;
        this.sendDHCPRequest();
    }

    handleDHCPAck(dhcp) {
        if (this.dhcpState !== 'REQUESTING' && this.dhcpState !== 'RENEWING' && this.dhcpState !== 'REBINDING') return;
        
        const serverID = dhcp.getOptionIP(DHCP_OPT_SERVER_ID);
        if (this.dhcpServerID && serverID && !IPUtils.equals(serverID, IPUtils.parse(this.dhcpServerID))) {
            return;
        }
        
        const assignedIP = IPUtils.toString(dhcp.yiaddr);
        this.addIP(assignedIP);
        if (this.gatewayIP === null) {
            this.gatewayIP = IPUtils.toString(dhcp.getOptionIP(DHCP_OPT_ROUTER) || IPUtils.parse('0.0.0.0'));
        }
        const dns = dhcp.getOptionIP(DHCP_OPT_DNS);
        if (dns) {
            this.dnsServers.push(IPUtils.toString(dns));
        }
        
        this.dhcpLease = {
            ip: assignedIP,
            subnetMask: IPUtils.toString(dhcp.getOptionIP(DHCP_OPT_SUBNET_MASK) || IPUtils.parse('255.255.255.0')),
            router: this.gatewayIP,
            dns: this.dnsServers[0] || null,
            leaseTime: dhcp.getOptionUInt32(DHCP_OPT_LEASE_TIME) || 86400,
            serverID: serverID ? IPUtils.toString(serverID) : this.dhcpServerID,
            obtainedAt: Date.now()
        };
        
        this.dhcpState = 'BOUND';
        this.dhcpRetryCount = 0;
        this.scheduleLeaseRenewal();
        
        this.emit('dhcpBound', this.dhcpLease);
    }

    handleDHCPNak(dhcp) {
        this.dhcpState = 'INIT';
        this.dhcpLease = null;
        this.dhcpServerID = null;
        this.removeIP(this.ipAddresses.values().next().value);
        this.startDHCP();
    }

    startDHCP() {
        if (!this.autoDHCP) return;
        
        this.dhcpState = 'INIT';
        this.dhcpXid = Math.floor(Math.random() * 0x100000000);
        this.dhcpRetryCount = 0;
        this.sendDHCPDiscover();
    }

    sendDHCPDiscover() {
        this.dhcpState = 'SELECTING';
        
        const dhcp = new DHCPPacket();
        dhcp.op = DHCP_OP_BOOTREQUEST;
        dhcp.xid = this.dhcpXid;
        dhcp.flags = DHCP_FLAG_BROADCAST;
        dhcp.chaddr.set(this.macAddress);
        dhcp.setOption(DHCP_OPT_MSG_TYPE, new Uint8Array([DHCP_MSG_DISCOVER]));
        dhcp.setOption(DHCP_OPT_CLIENT_ID, new Uint8Array([1, ...this.macAddress]));
        dhcp.setOption(DHCP_OPT_PARAM_REQUEST, new Uint8Array([
            DHCP_OPT_SUBNET_MASK,
            DHCP_OPT_ROUTER,
            DHCP_OPT_DNS,
            DHCP_OPT_DOMAIN,
            DHCP_OPT_BROADCAST,
            DHCP_OPT_LEASE_TIME,
            DHCP_OPT_RENEWAL_TIME,
            DHCP_OPT_REBIND_TIME
        ]));
        
        if (this.dhcpLease) {
            dhcp.setOption(DHCP_OPT_REQ_ADDR, IPUtils.parse(this.dhcpLease.ip));
        }
        
        this.sendDHCPPacket(dhcp, IPUtils.parse('255.255.255.255'));
        
        this.scheduleDHCPRetry();
    }

    sendDHCPRequest() {
        this.dhcpState = 'REQUESTING';
        
        const dhcp = new DHCPPacket();
        dhcp.op = DHCP_OP_BOOTREQUEST;
        dhcp.xid = this.dhcpXid;
        dhcp.flags = DHCP_FLAG_BROADCAST;
        dhcp.chaddr.set(this.macAddress);
        dhcp.setOption(DHCP_OPT_MSG_TYPE, new Uint8Array([DHCP_MSG_REQUEST]));
        dhcp.setOption(DHCP_OPT_CLIENT_ID, new Uint8Array([1, ...this.macAddress]));
        dhcp.setOption(DHCP_OPT_REQ_ADDR, IPUtils.parse(this.dhcpLease.ip));
        dhcp.setOption(DHCP_OPT_SERVER_ID, IPUtils.parse(this.dhcpServerID));
        dhcp.setOption(DHCP_OPT_PARAM_REQUEST, new Uint8Array([
            DHCP_OPT_SUBNET_MASK,
            DHCP_OPT_ROUTER,
            DHCP_OPT_DNS,
            DHCP_OPT_DOMAIN,
            DHCP_OPT_BROADCAST,
            DHCP_OPT_LEASE_TIME,
            DHCP_OPT_RENEWAL_TIME,
            DHCP_OPT_REBIND_TIME
        ]));
        
        this.sendDHCPPacket(dhcp, IPUtils.parse('255.255.255.255'));
        this.scheduleDHCPRetry();
    }

    sendDHCPRelease() {
        if (!this.dhcpLease) return;
        
        const dhcp = new DHCPPacket();
        dhcp.op = DHCP_OP_BOOTREQUEST;
        dhcp.xid = this.dhcpXid;
        dhcp.chaddr.set(this.macAddress);
        dhcp.ciaddr.set(IPUtils.parse(this.dhcpLease.ip));
        dhcp.setOption(DHCP_OPT_MSG_TYPE, new Uint8Array([DHCP_MSG_RELEASE]));
        dhcp.setOption(DHCP_OPT_CLIENT_ID, new Uint8Array([1, ...this.macAddress]));
        dhcp.setOption(DHCP_OPT_SERVER_ID, IPUtils.parse(this.dhcpServerID));
        
        this.sendDHCPPacket(dhcp, IPUtils.parse(this.dhcpServerID));
        
        this.removeIP(this.dhcpLease.ip);
        this.dhcpLease = null;
        this.dhcpState = 'INIT';
    }

    sendDHCPPacket(dhcp, dstIP) {
        const dhcpBuf = dhcp.serialize();
        const udp = UDPPacket.build(68, 67, dhcpBuf);
        const udpBuf = udp.serialize(IPUtils.parse('0.0.0.0'), dstIP);
        
        const ip = IPPacket.build(
            IPUtils.parse('0.0.0.0'),
            dstIP,
            IP_PROTO_UDP,
            udpBuf
        );
        ip.ttl = 64;
        const ipBuf = ip.serialize();
        
        const eth = EthernetFrame.build(
            new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
            this.macAddress,
            ETH_P_IP,
            ipBuf
        );
        
        this.sendPacket(eth.serialize());
    }

    scheduleDHCPRetry() {
        if (this.dhcpTimer) {
            clearTimeout(this.dhcpTimer);
        }
        
        this.dhcpTimer = setTimeout(() => {
            this.dhcpRetryCount++;
            if (this.dhcpRetryCount >= this.dhcpMaxRetries) {
                this.emit('dhcpFailed', new Error('DHCP max retries exceeded'));
                this.dhcpState = 'INIT';
                return;
            }
            
            if (this.dhcpState === 'SELECTING') {
                this.sendDHCPDiscover();
            } else if (this.dhcpState === 'REQUESTING') {
                this.sendDHCPRequest();
            }
        }, this.dhcpRetryInterval * Math.pow(2, this.dhcpRetryCount - 1));
    }

    scheduleLeaseRenewal() {
        if (!this.dhcpLease) return;
        
        const leaseTime = this.dhcpLease.leaseTime * 1000;
        const renewalTime = Math.min(leaseTime * 0.5, 3600000);
        
        if (this.dhcpTimer) {
            clearTimeout(this.dhcpTimer);
        }
        
        this.dhcpTimer = setTimeout(() => {
            this.renewLease();
        }, renewalTime);
    }

    renewLease() {
        if (!this.dhcpLease) return;
        
        this.dhcpState = 'RENEWING';
        this.dhcpRetryCount = 0;
        
        const dhcp = new DHCPPacket();
        dhcp.op = DHCP_OP_BOOTREQUEST;
        dhcp.xid = this.dhcpXid;
        dhcp.chaddr.set(this.macAddress);
        dhcp.ciaddr.set(IPUtils.parse(this.dhcpLease.ip));
        dhcp.setOption(DHCP_OPT_MSG_TYPE, new Uint8Array([DHCP_MSG_REQUEST]));
        dhcp.setOption(DHCP_OPT_CLIENT_ID, new Uint8Array([1, ...this.macAddress]));
        dhcp.setOption(DHCP_OPT_REQ_ADDR, IPUtils.parse(this.dhcpLease.ip));
        dhcp.setOption(DHCP_OPT_SERVER_ID, IPUtils.parse(this.dhcpServerID));
        
        this.sendDHCPPacket(dhcp, IPUtils.parse(this.dhcpServerID));
        this.scheduleDHCPRetry();
    }

    handleICMP(frame, ip) {
        const icmp = new ICMPPacket(ip.payload);
        
        if (icmp.isEchoRequest()) {
            this.sendICMPEchoReply(frame, ip, icmp);
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

    sendICMPEchoReply(originalFrame, originalIP, originalICMP) {
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
        
        this.sendPacket(replyEth.serialize());
    }

    ping(targetIP, count = 4, interval = 1000) {
        return new Promise((resolve, reject) => {
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
                    this.getFirstIP(),
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
                        resolve: null,
                        reject: null
                    });
                    
                    const promise = new Promise((res, rej) => {
                        this.pendingICMP.get(key).resolve = res;
                        this.pendingICMP.get(key).reject = rej;
                    });
                    
                    this.sendPacket(eth.serialize());
                    sent++;
                    
                    promise.then(result => {
                        received++;
                        results.push({ seq: sequence, ...result, success: true });
                    }).catch(err => {
                        results.push({ seq: sequence, success: false, error: err.message });
                    });
                }).catch(err => {
                    results.push({ seq: sequence, success: false, error: err.message });
                });
            };
            
            this.pingInterval = setInterval(sendPing, interval);
            sendPing();
            
            setTimeout(() => {
                if (this.pingInterval) clearInterval(this.pingInterval);
                for (const [, pending] of this.pendingICMP) {
                    if (pending.reject) pending.reject(new Error('Timeout'));
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
            
            if (this.pendingARP.has(ipStr)) {
                this.pendingARP.get(ipStr).callbacks.push(resolve);
                return;
            }
            
            this.pendingARP.set(ipStr, { callbacks: [resolve] });
            
            const arp = ARPPacket.buildRequest(this.macAddress, this.getFirstIP(), IPUtils.parse(ipStr));
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

    getFirstIP() {
        for (const ip of this.ipAddresses) {
            return IPUtils.parse(ip);
        }
        return IPUtils.parse('0.0.0.0');
    }

    getDHCPLease() {
        return this.dhcpLease ? { ...this.dhcpLease } : null;
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

    destroy() {
        if (this.dhcpTimer) {
            clearTimeout(this.dhcpTimer);
        }
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
    }
}